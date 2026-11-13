#!/usr/bin/env node
// Tests for the optional Linear work tracker: work-track.mjs (the daemon's
// half), scripts/work.mjs (the CLI and its outbox), linear-comments.mjs, and
// the wiring in bg.mjs and bridge.mjs. No network: Linear is an in-memory fake
// that answers the CLI's named operations, and bg.mjs runs from a temp copy.
//
//   node work-tracker.test.mjs

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRunId, createWorkTracker, jobTitleOf, workKeyLine, workKeyOf, workTrackerSettings } from './work-track.mjs';
import { helpMessage } from './system-messages.mjs';
import { commentsBatchPrompt, commentsCommandResult, isCommentsBatch } from './linear-comments.mjs';
import { CLI, MARK, Q, Transient, cardTitleProblems, commentsBatch, createTracker, enqueue, isTracked, linearTransport, main, outboxStatus, parseCardLine, parsePlan, parseRemaining, readMeta, statePaths, sweepText, takeLock, withMeta, withStands } from './scripts/work.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), 'work-tracker-'));
const failures = [];
let pass = 0;
const queue = [];
const t = (name, fn) => queue.push(async () => {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
});
const ok = (v, msg = 'expected truthy') => {
  if (!v) throw new Error(msg);
};
const eq = (a, b, msg = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

// ── a fake Linear ──────────────────────────────────────────────────────────

function fakeLinear({ states = ['Backlog', 'Todo', 'Done', 'Canceled'] } = {}) {
  const db = { teams: [], issues: [], comments: [], calls: [], n: 0 };
  const id = (p) => `${p}-${++db.n}`;
  const team = { id: 'team-1', key: 'ENG', name: 'Engineering', states: states.map((name) => ({ id: id('st'), name, type: name === 'Done' ? 'completed' : name === 'Canceled' ? 'canceled' : name === 'Backlog' ? 'backlog' : 'unstarted' })) };
  db.teams.push(team);
  db.viewer = { id: 'user-me', name: 'Me' };
  const stateOf = (sid) => team.states.find((s) => s.id === sid);
  const view = (i) => ({ ...i, state: stateOf(i.stateId), team: { id: team.id, key: team.key }, assignee: i.assigneeId ? { id: i.assigneeId } : null, parent: i.parentId ? { id: i.parentId, identifier: db.issues.find((x) => x.id === i.parentId)?.identifier } : null });
  const find = (ref) => db.issues.find((i) => i.id === ref || i.identifier === ref);
  // As live Linear pages a list: NEWEST first, `first:` from the query, `after`
  // a cursor. Ties on createdAt fall back to the order things were made.
  let seq = 0;
  const seqOf = new WeakMap();
  const stamp = (o) => (seqOf.has(o) || seqOf.set(o, ++seq), o);
  const newest = (arr) => [...arr].map(stamp).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : seqOf.get(b) - seqOf.get(a)));
  const paged = (all, query, after) => {
    const n = Number(/\(first: (\d+)/.exec(query)?.[1] || 50);
    const start = after ? Number(after) : 0;
    return { nodes: all.slice(start, start + n), pageInfo: { hasNextPage: start + n < all.length, endCursor: String(start + n) } };
  };
  db.pages = {};
  let failNext = 0;
  const gql = async (query, v = {}) => {
    const op = /^(?:query|mutation) (\w+)/.exec(query)[1];
    db.calls.push(op);
    if (/after: \$after/.test(query)) db.pages[op] = (db.pages[op] || 0) + 1;
    if (db.before) db.before(op);
    if (db.failOp?.[op] > 0) {
      db.failOp[op]--;
      throw new Transient('Linear 503: unavailable');
    }
    if (failNext > 0) {
      failNext--;
      throw new Transient('Linear 503: unavailable');
    }
    switch (op) {
      case 'WorkViewer':
        return { viewer: db.viewer };
      case 'WorkTeams':
        return { teams: { nodes: db.teams.map((x) => ({ id: x.id, key: x.key, name: x.name })) } };
      case 'WorkTeamStates': {
        const x = db.teams.find((y) => y.id === v.id);
        return { team: x ? { id: x.id, key: x.key, name: x.name, states: { nodes: x.states } } : null };
      }
      case 'WorkStateCreate': {
        const s = { id: id('st'), name: v.input.name, type: v.input.type };
        team.states.push(s);
        return { workflowStateCreate: { success: true, workflowState: s } };
      }
      case 'WorkByKey': {
        const r = paged(newest(db.issues.filter((i) => String(i.description).includes(v.needle))), query, v.after);
        return { issues: { nodes: r.nodes.map(view), pageInfo: r.pageInfo } };
      }
      case 'WorkIssue':
        // Live Linear raises for a missing id; it does not answer null.
        if (!find(v.id)) throw new Error('Linear 200: Entity not found: Issue');
        return { issue: view(find(v.id)) };
      case 'WorkIssueCreate': {
        const i = { id: id('iss'), identifier: `ENG-${db.issues.length + 1}`, title: v.input.title, description: v.input.description, stateId: v.input.stateId, parentId: v.input.parentId || null, assigneeId: v.input.assigneeId || null, createdAt: new Date(NOW - 5 * 3600_000).toISOString(), updatedAt: new Date(NOW - 5 * 3600_000).toISOString() };
        db.issues.push(i);
        return { issueCreate: { success: true, issue: view(i) } };
      }
      case 'WorkIssueUpdate': {
        const i = find(v.id);
        if (!i) throw new Error('Linear 400: Entity not found');
        for (const [k, val] of Object.entries(v.input)) i[k] = val;
        return { issueUpdate: { success: true, issue: view(i) } };
      }
      case 'WorkComment': {
        const c = { id: id('c'), body: v.input.body, issueId: v.input.issueId, createdAt: new Date(NOW).toISOString(), user: db.viewer };
        db.comments.push(c);
        return { commentCreate: { success: true, comment: { id: c.id } } };
      }
      case 'WorkOpen':
      case 'WorkOpenTracked': {
        const open = db.issues.filter((i) => !['completed', 'canceled'].includes(stateOf(i.stateId)?.type) && (op === 'WorkOpen' || String(i.description).includes('work-meta')));
        const r = paged(newest(open), query, v.after);
        return { issues: { nodes: r.nodes.map(view), pageInfo: r.pageInfo } };
      }
      case 'WorkComments': {
        const r = paged(newest(db.comments.filter((c) => c.createdAt > v.since && (!v.user || c.user?.id === v.user))), query, v.after);
        return { comments: { nodes: r.nodes.map((c) => ({ ...c, issue: view(find(c.issueId)) })), pageInfo: r.pageInfo } };
      }
      default:
        throw new Error(`fake Linear: no ${op}`);
    }
  };
  return { db, gql, team, stateOf, failNext: (n) => (failNext = n), byTitle: (title) => db.issues.find((i) => i.title === title), human: (title) => {
    const i = { id: id('iss'), identifier: `ENG-${db.issues.length + 1}`, title, description: 'a teammate wrote this', stateId: team.states.find((x) => x.name === 'Todo').id, parentId: null, assigneeId: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() };
    db.issues.push(i);
    return i;
  } };
}

const NOW = Date.parse('2026-11-13T15:00:00Z');
let clock = NOW;
function fresh(name, opts) {
  const dir = path.join(TMP, name);
  const L = fakeLinear(opts);
  const p = statePaths(dir);
  const tr = createTracker({ gql: L.gql, paths: p, team: 'ENG', now: () => clock });
  const out = [];
  const err = [];
  const settings = { team: 'ENG', stateDir: dir, states: {}, keyFile: '/nonexistent', cli: '' };
  const run = (argv, extra = {}) => main(argv, { settings, gql: L.gql, now: () => clock, out: (s) => out.push(s), err: (s) => err.push(s), ps: extra.ps ?? '', stdin: () => extra.stdin ?? '', env: {}, root: TMP });
  return { L, p, tr, out, err, run, dir };
}

// ── work-track.mjs ─────────────────────────────────────────────────────────

t('workKeyOf reads the LAST Work item line, and nothing else', () => {
  eq(workKeyOf('x\nWork item: job-a1. tracked\nmore\nWork item: job-b2. tracked'), 'job-b2');
  eq(workKeyOf('no key here'), null);
  eq(workKeyOf('  Work item: job-a1'), null, 'an indented line is not the footer');
});

t('baseRunId strips the pid tail and keeps a bare run id whole', () => {
  eq(baseRunId('bg2-1790000000000-4242'), 'bg2-1790000000000');
  eq(baseRunId('bg2-1790000000000'), 'bg2-1790000000000');
  eq(baseRunId('codex-1790000000000-7'), 'codex-1790000000000');
});

t('settings: OFF without a block, a team or a key; ON with all three', () => {
  const keyFile = path.join(TMP, 'key');
  eq(workTrackerSettings({ config: {}, env: {} }), null);
  eq(workTrackerSettings({ config: { workTracker: { keyFile } }, env: { LINEAR_API_KEY: 'k' } }), null, 'no team');
  eq(workTrackerSettings({ config: { workTracker: { team: 'ENG', keyFile } }, env: {} }), null, 'no key, no key file');
  eq(workTrackerSettings({ config: { workTracker: { team: 'ENG', enabled: false } }, env: { LINEAR_API_KEY: 'k' } }), null, 'disabled');
  ok(workTrackerSettings({ config: { workTracker: { team: 'ENG' } }, env: { LINEAR_API_KEY: 'k' } }), 'env key');
  writeFileSync(keyFile, '');
  eq(workTrackerSettings({ config: { workTracker: { team: 'ENG', keyFile } }, env: {} }), null, 'an empty key file is no key');
  writeFileSync(keyFile, 'lin_api_fake');
  const s = workTrackerSettings({ config: { workTracker: { team: 'ENG', keyFile } }, env: {}, root: '/r' });
  eq([s.team, s.stateDir, s.cli, s.drainMs], ['ENG', '/r/work-tracker', '/r/scripts/work.mjs', 6000]);
  ok(workTrackerSettings({ config: {}, env: { BRIDGE_WORK_TRACKER: JSON.stringify({ team: 'ENG', keyFile }) } }), 'the env layer, as conf() reads it');
  eq(workTrackerSettings({ config: { workTracker: { team: 'ENG', keyFile } }, env: { BRIDGE_WORK_TRACKER: '{not json' } }), null, 'an unreadable env block is off, never the file');
});

t('createWorkTracker: off spawns nothing; on, one link-run per run and the report on stdin', () => {
  const calls = [];
  const spawn = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = '';
    child.stdin = { on() {}, write: (s) => (input += s), end: () => calls.push({ args, input }) };
    return child;
  };
  const off = createWorkTracker({ cli: null, spawn, log: () => {} });
  eq([off.started('Work item: job-a1', 'bg-1790000000000-1'), off.reported('Work item: job-a1', 'x', { output: 'r' })], [null, null]);
  eq(calls.length, 0);
  const on = createWorkTracker({ cli: '/w.mjs', spawn, log: () => {} });
  on.started('brief\nWork item: job-a1. x', 'bg-1790000000000-11');
  on.started('brief\nWork item: job-a1. x', 'bg-1790000000000-12');
  on.started('a chat turn, no key', 'bg-1790000000001-1');
  eq(calls.length, 1, 'one link-run for one run, and none for an untracked brief');
  eq(calls[0].args.slice(0, 6), ['/w.mjs', 'link-run', '--key', 'job-a1', '--run', 'bg-1790000000000-11']);
  on.reported('brief\nWork item: job-a1. x', 'bg-1790000000000', { output: '## Remaining\n- none', status: 'finished' });
  eq(calls[1].args.slice(0, 8), ['/w.mjs', 'report', '--key', 'job-a1', '--run', 'bg-1790000000000', '--status', 'finished']);
  eq(calls[1].input, '## Remaining\n- none');
});

t('bg.mjs writes workKeyLine word for word', () => {
  const bg = readFileSync(path.join(DIR, 'bg.mjs'), 'utf8');
  const m = /text = `\$\{text\}\\n\\n---\\n(Work item: \$\{work\.key\}\.[^`]*)`;/.exec(bg);
  ok(m, 'the footer template is in bg.mjs');
  eq(m[1].replace('${work.key}', 'job-x'), workKeyLine('job-x'));
});

t('bg.mjs and work-track.mjs agree on when the tracker is on', () => {
  const bg = readFileSync(path.join(DIR, 'bg.mjs'), 'utf8');
  for (const needle of ["c.enabled === false", "typeof c.team !== 'string'", "'~/.config/leash/linear-api-key'", 'LINEAR_API_KEY', 'BRIDGE_WORK_TRACKER', "'work-tracker'"]) ok(bg.includes(needle), `bg.mjs is missing ${needle}`);
});

// ── the ## Remaining block ─────────────────────────────────────────────────

t('parseRemaining: items, none, and every invalid shape', () => {
  const r = parseRemaining('report\n## Remaining\n- owed: Billing: finish the export | two slices left\n- waiting-owner: Billing: ship it? | needs a yes\n- follow-up: Docs: tidy | found on the way\n');
  eq(r.valid, true);
  eq(r.items.map((i) => i.kind), ['owed', 'waiting-owner', 'follow-up']);
  eq(parseRemaining('## Remaining\n- none').none, true);
  eq(parseRemaining('no block').error, 'no ## Remaining heading');
  eq(parseRemaining('## Remaining\n- none\n- owed: a').valid, false);
  eq(parseRemaining('## Remaining\n- waiting owner: a').valid, false, 'a misspelled kind is invalid, never dropped');
  eq(parseRemaining('## Remaining\n').valid, false);
  eq(parseRemaining('```\n## Remaining\n- none\n```\n').found, false, 'a heading inside a code fence does not count');
  eq(parseRemaining('## Remaining\n- owed: old\n\n## Remaining\n- none').none, true, 'the last block counts');
});

t('plain card: title checks and the card line', () => {
  eq(cardTitleProblems('Billing: finish the export'), []);
  ok(cardTitleProblems('finish the export').some((x) => x.includes('Area')));
  ok(cardTitleProblems('Billing: fix ENG-12 in src/app/x.ts').length >= 2);
  ok(cardTitleProblems('Billing: this title is far too long to read on a phone screen').some((x) => x.includes('over 45')));
  eq(parseCardLine('Billing: finish it | two slices left'), { title: 'Billing: finish it', sentence: 'two slices left', area: 'Billing' });
});

t('tracker data: written key first, read back, replaced not stacked', () => {
  const d1 = withMeta('**What this is:** x', { runs: ['a'], key: 'job-k' });
  ok(d1.includes('{"key":"job-k","runs":["a"]}'));
  const d2 = withMeta(d1, { key: 'job-k', runs: ['a', 'b'] });
  eq(d2.split('work-meta').length, 2, 'one block');
  eq(readMeta(d2).runs, ['a', 'b']);
  const d3 = withStands(d2, 'Running: now.');
  ok(d3.indexOf('**Where it stands:** Running: now.') < d3.indexOf('Tracker data'), 'the stands line sits above the data block');
  eq(readMeta(withStands(d3, 'Done.')).key, 'job-k');
});

// ── the CLI against the fake ───────────────────────────────────────────────

t('setup creates the missing states once, saves the ids, starts the comment cursor', async () => {
  const f = fresh('setup');
  eq(await f.run(['setup', '--check']), 1, 'states missing');
  eq(await f.run(['setup']), 0);
  const ids = JSON.parse(readFileSync(f.p.ids, 'utf8'));
  eq(Object.keys(ids.states).sort(), ['answered', 'blocked', 'canceled', 'done', 'queued', 'running', 'waiting']);
  eq(f.L.team.states.map((s) => s.name).filter((n) => !['Backlog', 'Todo'].includes(n)).sort(), ['Answered', 'Blocked', 'Canceled', 'Done', 'Queued', 'Running', 'Waiting on you']);
  ok(existsSync(f.p.cursor));
  const before = f.L.team.states.length;
  eq(await f.run(['setup']), 0);
  eq(f.L.team.states.length, before, 'a second setup creates nothing');
  eq(await f.run(['setup', '--check']), 0);
});

t('setup refuses a team the key cannot see', async () => {
  const f = fresh('setup-team');
  const r = await main(['setup'], { settings: { team: 'NOPE', stateDir: f.dir, states: {} }, gql: f.L.gql, out: () => {}, err: (s) => f.err.push(s), env: {}, root: TMP });
  eq(r, 2);
  ok(f.err.join('\n').includes('no team "NOPE"'));
});

t('job, link-run and report: the life of one card', async () => {
  const f = fresh('life');
  await f.run(['setup']);
  eq(await f.run(['job', '--key', 'job-life1', '--title', 'Export rework', '--card', 'Billing: rework the export | the CSV drops rows']), 0);
  const job = f.L.byTitle('Billing: rework the export');
  ok(job, 'the plain card title is used');
  eq(f.L.stateOf(job.stateId).name, 'Queued');
  ok(job.description.includes('the CSV drops rows'));
  eq(await f.run(['job', '--key', 'job-life1', '--title', 'Export rework']), 0);
  eq(f.L.db.issues.length, 1, 'a re-sent job op never duplicates');
  await f.run(['link-run', '--key', 'job-life1', '--run', 'bg2-1790000000000-55']);
  eq(f.L.stateOf(job.stateId).name, 'Running');
  eq(readMeta(job.description).runs, ['bg2-1790000000000-55']);
  const report = 'Did most of it.\n\n## Remaining\n- owed: Billing: finish slice two | the import side is not done\n- follow-up: Docs: explain the export | users ask how\n- waiting-owner: Billing: ship to all users? | it changes the file format\n- waiting-owner: Billing: keep the old export? | a week of overlap\n';
  eq(await f.run(['report', '--key', 'job-life1', '--run', 'bg2-1790000000000', '--status', 'finished', '--stdin'], { stdin: report }), 0);
  const kids = f.L.db.issues.filter((i) => i.parentId === job.id);
  eq(kids.length, 3, 'one owed, one follow-up, one card for both questions');
  const owed = f.L.byTitle('Billing: finish slice two');
  eq([f.L.stateOf(owed.stateId).name, readMeta(owed.description).kind], ['Queued', 'owed']);
  const ask = f.L.byTitle('Billing: 2 questions for you');
  ok(ask, 'two waiting lines are one card');
  eq([f.L.stateOf(ask.stateId).name, ask.assigneeId], ['Waiting on you', 'user-me']);
  ok(ask.description.includes('1. Billing: ship to all users?') && ask.description.includes('2. Billing: keep the old export?'));
  eq(f.L.stateOf(job.stateId).name, 'Done', 'a clean finish closes the job');
  ok(!JSON.stringify(f.L.db).includes('Did most of it'), 'only the Remaining lines reach Linear, never the report');
  const n = f.L.db.issues.length;
  const comments = f.L.db.comments.length;
  job.stateId = f.L.team.states.find((x) => x.name === 'Running').id;
  await f.run(['report', '--key', 'job-life1', '--run', 'bg2-1790000000000', '--status', 'finished', '--stdin'], { stdin: report });
  eq(f.L.db.issues.length, n, 'a replayed report files nothing twice');
  eq(f.L.db.comments.length, comments, 'and comments nothing twice');
  eq(f.L.stateOf(job.stateId).name, 'Running', 'and never closes a card reopened since');
  ok(f.L.db.comments.every((c) => c.body.startsWith(MARK)), 'every tracker comment carries the mark');
});

t('report: none closes; a failed run comments and stays open; no block comments', async () => {
  const f = fresh('report-shapes');
  await f.run(['setup']);
  for (const k of ['job-none1', 'job-fail1', 'job-bad1']) await f.run(['job', '--key', k, '--title', `Area: ${k}`]);
  await f.run(['report', '--key', 'job-none1', '--status', 'finished', '--stdin'], { stdin: '## Remaining\n- none' });
  eq(f.L.stateOf(f.L.byTitle('Area: job-none1').stateId).name, 'Done');
  await f.run(['report', '--key', 'job-fail1', '--status', 'failed', '--stdin'], { stdin: '## Remaining\n- owed: Area: the rest | not done' });
  eq(f.L.stateOf(f.L.byTitle('Area: job-fail1').stateId).name, 'Queued', 'a failed run keeps its state');
  ok(f.L.byTitle('Area: the rest'), 'its leftovers are still filed');
  await f.run(['report', '--key', 'job-bad1', '--status', 'finished', '--stdin'], { stdin: 'no block at all' });
  eq(f.L.stateOf(f.L.byTitle('Area: job-bad1').stateId).name, 'Queued');
  ok(f.L.db.comments.some((c) => c.body.includes('no valid ## Remaining block')));
});

t('a job linked with Linear: ABC-12 takes the run and the report on that card', async () => {
  const f = fresh('link');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-orig1', '--title', 'Area: the original']);
  const card = f.L.byTitle('Area: the original');
  await f.run(['job', '--key', 'job-again2', '--title', 'redo', '--link', card.identifier]);
  eq(f.L.db.issues.length, 1, 'no new issue');
  await f.run(['link-run', '--key', 'job-again2', '--run', 'bg-1790000000000-1']);
  eq(f.L.stateOf(card.stateId).name, 'Running');
  rmSync(f.p.keys);
  await f.run(['report', '--key', 'job-again2', '--status', 'finished', '--stdin'], { stdin: '## Remaining\n- none' });
  eq(f.L.stateOf(card.stateId).name, 'Done', 'found by its link with the local cache gone');
});

t('outbox: queue only with --drain-ms 0, ordered sends, retry then set aside', async () => {
  const f = fresh('outbox');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-ob1', '--title', 'Area: ob', '--drain-ms', '0']);
  await f.run(['link-run', '--key', 'job-ob1', '--run', 'bg-1790000000000-1', '--drain-ms', '0']);
  eq(outboxStatus(f.p).waiting, 2);
  eq(f.L.db.issues.length, 0);
  f.L.failNext(1);
  await f.run(['drain']);
  eq(outboxStatus(f.p).waiting, 2, 'a failed first op stops the drain, so the link-run cannot run ahead of its job');
  const tries = outboxStatus(f.p).files.map((x) => JSON.parse(readFileSync(path.join(f.p.outbox, x), 'utf8'))).map((o) => [o.op, Boolean(o.lastError), o.attempts || 0]);
  eq(tries, [['job', true, 0], ['link-run', false, 0]], 'the job was tried and kept its tries; the link-run was never tried');
  await f.run(['drain']);
  eq(outboxStatus(f.p).waiting, 0);
  eq(f.L.stateOf(f.L.byTitle('Area: ob').stateId).name, 'Running');
  enqueue(f.p, { op: 'job', key: 'job-badlink', title: 'x', link: 'ENG-999' });
  await f.run(['drain']);
  eq([outboxStatus(f.p).waiting, outboxStatus(f.p).failed], [0, 1], 'a refusal is set aside at once');
});

t('a Linear outage across a whole job loses nothing: tries are not spent, and the card opens when Linear is back', async () => {
  const f = fresh('outage');
  await f.run(['setup']);
  f.L.failNext(1000);
  await f.run(['job', '--key', 'job-out1', '--title', 'Area: outage job']);
  await f.run(['link-run', '--key', 'job-out1', '--run', 'bg-1790000000000-1', '--title', 'Area: outage job']);
  await f.run(['report', '--key', 'job-out1', '--status', 'finished', '--title', 'Area: outage job', '--stdin'], { stdin: '## Remaining\n- owed: Area: left over | x' });
  for (let i = 0; i < 4; i++) await f.run(['drain']);
  const st = outboxStatus(f.p);
  eq([st.waiting, st.failed], [3, 0], 'all three wait, none set aside');
  ok(st.files.every((x) => !JSON.parse(readFileSync(path.join(f.p.outbox, x), 'utf8')).attempts), 'an outage spends no tries');
  f.L.failNext(0);
  await f.run(['drain']);
  eq(outboxStatus(f.p).waiting, 0);
  const job = f.L.byTitle('Area: outage job');
  eq(f.L.stateOf(job.stateId).name, 'Done');
  ok(f.L.byTitle('Area: left over'), 'its leftover is filed');
});

t('a job op that was set aside does not strand its start or its report; retry puts it back', async () => {
  const f = fresh('stranded');
  await f.run(['setup']);
  mkdirSync(f.p.failed, { recursive: true });
  writeFileSync(path.join(f.p.failed, '20261113150000-000001-1-job.json'), JSON.stringify({ op: 'job', key: 'job-str1', title: 'Area: stranded', attempts: 3 }));
  await f.run(['link-run', '--key', 'job-str1', '--run', 'bg-1790000000000-2', '--title', 'Area: stranded']);
  const card = f.L.byTitle('Area: stranded');
  ok(card, 'the start opened the card');
  eq(f.L.stateOf(card.stateId).name, 'Running');
  eq(await f.run(['retry']), 0);
  eq([outboxStatus(f.p).waiting, outboxStatus(f.p).failed], [0, 0]);
  eq(f.L.db.issues.length, 1, 'the retried job op found the card, no second one');
});

t('an op queued by another process while a drain runs is sent by that drain', async () => {
  const f = fresh('relist');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-rl1', '--title', 'Area: first', '--drain-ms', '0']);
  let once = true;
  f.L.db.before = (op) => {
    if (once && op === 'WorkIssueCreate') {
      once = false;
      enqueue(f.p, { op: 'job', key: 'job-rl2', title: 'Area: second' });
    }
  };
  await f.run(['drain']);
  f.L.db.before = null;
  eq(outboxStatus(f.p).waiting, 0);
  ok(f.L.byTitle('Area: second'));
});

t('the lock: a live holder keeps it, a dead one loses it, release removes only its own', () => {
  const dir = path.join(TMP, 'lock');
  const p = statePaths(dir);
  mkdirSync(dir, { recursive: true });
  const r1 = takeLock(p);
  ok(r1, 'taken');
  eq(takeLock(p), null, 'a second taker waits');
  ok(JSON.parse(readFileSync(p.lock, 'utf8')).pid === process.pid, 'the file is whole the moment it exists');
  r1();
  writeFileSync(p.lock, JSON.stringify({ pid: 999999, at: Date.now() }));
  const r2 = takeLock(p);
  ok(r2, 'a dead pid loses the lock');
  writeFileSync(p.lock, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'someone-else' }));
  r2();
  ok(existsSync(p.lock), 'release never removes a lock that is not its own');
});

t('unqueue removes an unsent job op (the drop box write failed)', async () => {
  const f = fresh('unqueue');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-uq1', '--title', 'x', '--drain-ms', '0']);
  await f.run(['unqueue', '--key', 'job-uq1']);
  eq(outboxStatus(f.p).waiting, 0);
});

t('status: owed work is never parked in Backlog; Blocked needs a reason; leaving Waiting clears the assignee', async () => {
  const f = fresh('status');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-st1', '--title', 'Area: st']);
  await f.run(['report', '--key', 'job-st1', '--status', 'failed', '--stdin'], { stdin: '## Remaining\n- owed: Area: owed bit | x\n- waiting-owner: Area: yes or no? | y' });
  const owed = f.L.byTitle('Area: owed bit');
  eq(await f.run(['status', owed.identifier, 'Backlog']), 2);
  ok(f.err.join('\n').includes('never parked in Backlog'));
  eq(await f.run(['status', owed.identifier, 'Blocked']), 2, 'no reason');
  eq(await f.run(['status', owed.identifier, 'Blocked', '--comment', 'waits for the vendor']), 0);
  ok(owed.description.includes('**Where it stands:** Blocked: waits for the vendor'));
  const ask = f.L.byTitle('Area: yes or no?');
  eq(ask.assigneeId, 'user-me');
  eq(await f.run(['status', ask.identifier, 'Done']), 0);
  eq(ask.assigneeId, null);
  eq(await f.run(['status', ask.identifier, 'Todo']), 0, "a team's own state by name");
  eq(await f.run(['status', ask.identifier, 'No such state']), 2);
});

t('comments: the owner\'s new ones as one batch, the tracker\'s own skipped, Waiting moves to Answered', async () => {
  const f = fresh('comments');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-cm1', '--title', 'Area: cm']);
  await f.run(['report', '--key', 'job-cm1', '--status', 'finished', '--stdin'], { stdin: '## Remaining\n- waiting-owner: Area: pick one? | A or B' });
  const ask = f.L.byTitle('Area: pick one?');
  clock += 60_000;
  f.L.db.comments.push({ id: 'c-own', body: 'B, and ship it', issueId: ask.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me', name: 'Me' } });
  f.L.db.comments.push({ id: 'c-other', body: 'from a teammate', issueId: ask.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-2', name: 'T' } });
  f.L.db.comments.push({ id: 'c-mark', body: `${MARK} posted by the tracker by hand`, issueId: ask.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me', name: 'Me' } });
  f.out.length = 0;
  eq(await f.run(['comments']), 0);
  const text = f.out.join('\n');
  ok(isCommentsBatch(text), text.slice(0, 80));
  ok(text.includes('> B, and ship it') && !text.includes('teammate') && !text.includes('by hand'));
  ok(text.startsWith('[Linear comments by the owner, 1 on 1 card]'));
  eq(f.L.stateOf(ask.stateId).name, 'Answered');
  const done = /comments --done (\S+)/.exec(text)?.[1];
  ok(done, 'the batch names its --done line');
  f.out.length = 0;
  await f.run(['comments']);
  ok(f.out.join('\n').includes('B, and ship it'), 'not acted on yet: shown again, never lost');
  eq(f.out.join('\n').split('B, and ship it').length, 2, 'once, not twice');
  f.out.length = 0;
  await f.run(['comments', '--again']);
  ok(f.out.join('\n').includes('B, and ship it'), '--again shows what is pending');
  clock += 60_000;
  f.L.db.comments.push({ id: 'c-late', body: 'one more thing', issueId: ask.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me', name: 'Me' } });
  await f.run(['comments', '--done', done]);
  f.out.length = 0;
  await f.run(['comments']);
  const after = f.out.join('\n');
  ok(after.includes('one more thing') && !after.includes('B, and ship it'), '--done clears only what the batch held');
});

t('comments: a batch that never reached a turn is in the next one too (two slots behind a wall)', async () => {
  const f = fresh('comments-wall');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-cw1', '--title', 'Area: one']);
  await f.run(['job', '--key', 'job-cw2', '--title', 'Area: two']);
  const [a, b] = [f.L.byTitle('Area: one'), f.L.byTitle('Area: two')];
  clock += 60_000;
  f.L.db.comments.push({ id: 'w1', body: 'answer one', issueId: a.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me' } });
  await f.run(['comments']);
  clock += 60_000;
  f.L.db.comments.push({ id: 'w2', body: 'answer two', issueId: b.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me' } });
  f.out.length = 0;
  await f.run(['comments']);
  const text = f.out.join('\n');
  ok(text.includes('answer one') && text.includes('answer two'), text);
  ok(text.startsWith('[Linear comments by the owner, 2 on 2 cards]'));
});

t('comments: a comment on an issue the tracker did not make is not an answer', async () => {
  const f = fresh('comments-scope');
  await f.run(['setup']);
  const h = f.L.human('a teammate issue');
  clock += 60_000;
  f.L.db.comments.push({ id: 'h1', body: 'can you take this one?', issueId: h.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me' } });
  f.out.length = 0;
  await f.run(['comments']);
  eq(f.out.join(''), '');
});

t('a job linked to a hand made issue: its comments are answers and the sweep still watches it', async () => {
  const f = fresh('linked-human');
  await f.run(['setup']);
  const h = f.L.human('Area: made by hand');
  await f.run(['job', '--key', 'job-lh1', '--title', 'x', '--link', h.identifier]);
  ok(isTracked(h), 'linked means tracked');
  await f.run(['link-run', '--key', 'job-lh1', '--run', 'bg5-1790000000000-3']);
  clock += 60_000;
  f.L.db.comments.push({ id: 'lh-c', body: 'go ahead', issueId: h.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me' } });
  f.out.length = 0;
  await f.run(['comments']);
  ok(f.out.join('\n').includes('> go ahead'), f.out.join('\n'));
  ok(sweepText(await f.tr.openIssues(), { names: f.tr.names, psText: '', now: NOW }).includes('Area: made by hand'), 'its dead worker is listed');
});

t('comments: the ack names the CLI by its absolute path, waits for the lock, and a re-shown comment says so', async () => {
  const f = fresh('ack');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-ack1', '--title', 'Area: ack']);
  const card = f.L.byTitle('Area: ack');
  clock += 60_000;
  f.L.db.comments.push({ id: 'a1', body: 'yes', issueId: card.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me' } });
  f.out.length = 0;
  await f.run(['comments']);
  const first = f.out.join('\n');
  ok(first.includes(`node ${CLI} comments --done `) && path.isAbsolute(CLI), first);
  f.out.length = 0;
  await f.run(['comments']);
  ok(f.out.join('\n').includes('were shown before') && f.out.join('\n').includes('its state may have changed'));
  const lock = path.join(f.dir, 'comments.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'reader' }));
  eq(await f.run(['comments', '--done', '2099-01-01T00:00:00.000Z']), 3, 'an ack waits for a running read');
  rmSync(lock);
  eq(await f.run(['comments', '--done', '2099-01-01T00:00:00.000Z']), 0);
  f.out.length = 0;
  await f.run(['comments']);
  eq(f.out.join(''), '');
});

t('comments: a batch over the length limit acks only what it shows', () => {
  const pending = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, body: 'x'.repeat(400), createdAt: new Date(NOW + i * 1000).toISOString(), card: 'ENG-1', title: 'Area: long', state: 'Answered', shown: 0 }));
  const text = commentsBatch(pending, { maxChars: 5000 });
  const upTo = /comments --done (\S+)/.exec(text)[1];
  const shown = (text.match(/^> /gm) || []).length;
  ok(shown > 0 && shown < 30, `${shown} shown`);
  eq(upTo, pending[shown - 1].createdAt, 'the ack stops at the last comment shown');
  ok(text.includes(`${30 - shown} more wait for the next read`));
});

t('a late start (a retried op) never reopens a card its run already reported on', async () => {
  const f = fresh('late-start');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-ls1', '--title', 'Area: late']);
  await f.run(['report', '--key', 'job-ls1', '--run', 'bg6-1790000000000', '--status', 'finished', '--stdin'], { stdin: '## Remaining\n- none' });
  await f.run(['link-run', '--key', 'job-ls1', '--run', 'bg6-1790000000000-77']);
  eq(f.L.stateOf(f.L.byTitle('Area: late').stateId).name, 'Done');
});

t('a report whose comment fails once is applied once, with its comment', async () => {
  const f = fresh('comment-blip');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-cb1', '--title', 'Area: blip']);
  f.L.db.failOp = { WorkComment: 1 };
  await f.run(['report', '--key', 'job-cb1', '--run', 'bg7-1790000000000', '--status', 'failed', '--stdin'], { stdin: 'no block' });
  eq(outboxStatus(f.p).waiting, 1, 'it waits');
  await f.run(['drain']);
  const card = f.L.byTitle('Area: blip');
  eq(f.L.db.comments.filter((c) => c.issueId === card.id).length, 1);
  await f.run(['report', '--key', 'job-cb1', '--run', 'bg7-1790000000000', '--status', 'failed', '--stdin'], { stdin: 'no block' });
  eq(f.L.db.comments.filter((c) => c.issueId === card.id).length, 1, 'and only once');
});

t('transport: a body that stalls is cut at the timeout; a rate limit is transient', async () => {
  const stall = linearTransport({ key: 'lin_api_x', timeoutMs: 50, fetchImpl: async (url, init) => ({ ok: true, status: 200, json: () => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }) });
  const t0 = Date.now();
  let e1;
  try {
    await stall(Q.viewer);
  } catch (e) {
    e1 = e;
  }
  ok(e1 instanceof Transient && /did not answer/.test(e1.message) && Date.now() - t0 < 2000, String(e1?.message));
  const limited = linearTransport({ key: 'lin_api_x', fetchImpl: async () => ({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }) }) });
  let e2;
  try {
    await limited(Q.viewer);
  } catch (e) {
    e2 = e;
  }
  ok(e2 instanceof Transient, String(e2?.message));
});

t('sweep: only what needs the chat session, and nothing when nothing does', async () => {
  const f = fresh('sweep');
  await f.run(['setup']);
  f.out.length = 0;
  await f.run(['sweep']);
  eq(f.out.join(''), '', 'an empty board prints nothing, so a schedule script starts no turn');
  await f.run(['job', '--key', 'job-sw1', '--title', 'Area: running one']);
  await f.run(['link-run', '--key', 'job-sw1', '--run', 'bg3-1790000000000-9']);
  await f.run(['job', '--key', 'job-sw2', '--title', 'Area: leftovers']);
  await f.run(['report', '--key', 'job-sw2', '--status', 'finished', '--stdin'], { stdin: '## Remaining\n- owed: Area: owed thing | x' });
  await f.run(['job', '--key', 'job-sw3', '--title', 'a title with no area that is long']);
  eq(isTracked(f.L.byTitle('a title with no area that is long')), true);
  const issues = await f.tr.openIssues();
  const names = f.tr.names;
  const live = sweepText(issues, { names, psText: 'bg3-1790000000000  bg3  9', now: NOW });
  ok(live.includes('Queued leftovers') && live.includes('Area: owed thing'));
  ok(!live.includes('Running with no live worker'), 'its worker is in ps');
  ok(live.includes('do not read plainly') && live.includes('a title with no area'));
  const dead = sweepText(issues, { names, psText: 'no background workers running', now: NOW });
  ok(dead.includes('Running with no live worker') && dead.includes('Area: running one'));
  ok(!sweepText(issues, { names, psText: null, now: NOW }).includes('Running with no live worker'), 'no ps, no guess');
  f.L.human('a teammate title with no area at all');
  ok(!sweepText(await f.tr.openIssues(), { names, psText: 'bg3-1790000000000', now: NOW }).includes('teammate'), "a teammate's issue is not the tracker's");
  f.out.length = 0;
  await f.run(['lint']);
  ok(!f.out.join('\n').includes('teammate'), 'lint reads only the tracker cards');
  const owed = f.L.byTitle('Area: owed thing');
  owed.stateId = f.L.team.states.find((s) => s.name === 'Backlog').id;
  ok(sweepText(await f.tr.openIssues(), { names, psText: '', now: NOW }).includes('never parked'));
});

t('plan: one Queued card per step, idempotent', async () => {
  const f = fresh('plan');
  await f.run(['setup']);
  const file = path.join(f.dir, 'export-plan.md');
  writeFileSync(file, '# Plan\n\n## 7. Steps\n\n| Step | Title | Status |\n| --- | --- | --- |\n| 1 | Read the old format | todo |\n| 2 | Write the new one | todo |\n\n## 8. Other\n');
  eq(parsePlan(readFileSync(file, 'utf8'), { section: '7.' }).rows.length, 2);
  eq(parsePlan('no table').rows.length, 0);
  eq(await f.run(['plan', file, '--section', '7.']), 0);
  eq(await f.run(['plan', file, '--section', '7.']), 0);
  eq(f.L.db.issues.length, 2);
  eq(readMeta(f.L.db.issues[0].description).kind, 'owed');
});

t('off: every command says so, nothing is written', async () => {
  const err = [];
  eq(await main(['open'], { settings: null, out: () => {}, err: (s) => err.push(s) }), 1);
  eq(await main(['drain'], { settings: null, out: () => {}, err: () => {} }), 0, 'a drain with nothing to do is not an error');
  ok(err[0].includes('work tracker is off'));
});

t('a key file with more than one line is no key, and its text never reaches an error', async () => {
  const dir = path.join(TMP, 'twoline');
  mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'key');
  writeFileSync(keyFile, '# my linear key\nlin_api_TWOLINESECRET\n');
  const err = [];
  const code = await main(['setup'], { settings: { team: 'ENG', stateDir: dir, states: {}, keyFile }, env: {}, out: () => {}, err: (s) => err.push(s), root: TMP });
  eq(code, 1);
  ok(err.join('\n').includes('no usable Linear API key') && !err.join('\n').includes('TWOLINESECRET'), err.join(' | '));
  const thrower = linearTransport({ key: 'lin_api_HEADERSECRET', fetchImpl: async () => {
    throw new TypeError('Headers.append: "lin_api_HEADERSECRET" is an invalid header value.');
  } });
  let msg = '';
  try {
    await thrower(Q.viewer);
  } catch (e) {
    msg = e.message;
    ok(e instanceof Transient, 'unreachable is transient');
  }
  ok(msg && !msg.includes('HEADERSECRET'), msg);
});

t('transport: the key goes in the header only and never into an error', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init);
    return { ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ errors: [{ message: 'Authentication required' }] }) };
  };
  const gql = linearTransport({ key: 'lin_api_SECRETVALUE', fetchImpl });
  let msg = '';
  try {
    await gql(Q.viewer);
  } catch (e) {
    msg = e.message;
  }
  eq(seen[0].headers.authorization, 'lin_api_SECRETVALUE');
  ok(!seen[0].body.includes('SECRETVALUE'));
  ok(msg.includes('401') && !msg.includes('SECRETVALUE'), msg);
});

// ── linear-comments.mjs ────────────────────────────────────────────────────

t('/comments results: a batch is a turn; the rest are one line', () => {
  const batch = '[Linear comments by Alex, 1 on 1 card]\nENG-1 · x\n> yes';
  eq(isCommentsBatch(`\n${batch}`), true);
  ok(commentsCommandResult({ stdout: batch, ownerName: 'Alex' }).prompt.startsWith('[Daemon authored, not Alex typing'));
  eq(commentsCommandResult({ enabled: false }).log, 'comments_off');
  eq(commentsCommandResult({ code: 3 }).log, 'comments_busy');
  eq(commentsCommandResult({ code: 1, stderr: 'work: Linear 503' }).log, 'comments_failed exit=1');
  eq(commentsCommandResult({}).log, 'comments_none_new');
  eq(commentsBatchPrompt({ output: '  ' }), null);
});

// ── bg.mjs, from a temp copy ───────────────────────────────────────────────

function bgCopy(name, config) {
  const dir = path.join(TMP, name);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(path.join(DIR, 'bg.mjs'), path.join(dir, 'bg.mjs'));
  copyFileSync(path.join(DIR, 'work-track.mjs'), path.join(dir, 'work-track.mjs'));
  copyFileSync(path.join(DIR, 'scripts', 'work.mjs'), path.join(dir, 'scripts', 'work.mjs'));
  if (config) writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const brief = path.join(dir, 'brief.md');
  writeFileSync(brief, '# Rework the export\n\nDo the thing.\n');
  const env = { ...process.env, LINEAR_API_KEY: 'lin_api_fake_for_tests', BRIDGE_CONFIG: '', BRIDGE_WORK_TRACKER: '' };
  delete env.BRIDGE_CONFIG;
  delete env.BRIDGE_WORK_TRACKER;
  const run = (...args) => execFileSync(process.execPath, [path.join(dir, 'bg.mjs'), ...args, '--file', brief], { cwd: dir, env, encoding: 'utf8' });
  const queued = () => JSON.parse(readFileSync(path.join(dir, 'bg-queue.json'), 'utf8'));
  const ops = () => {
    const ob = path.join(dir, 'work-tracker', 'outbox');
    return existsSync(ob) ? readdirSync(ob).filter((x) => x.endsWith('.json')).map((x) => JSON.parse(readFileSync(path.join(ob, x), 'utf8'))) : [];
  };
  return { dir, run, queued, ops };
}

t('bg.mjs with the tracker OFF: the brief and the output are as before', () => {
  const b = bgCopy('bg-off', null);
  const out = b.run('--card', 'Billing: rework | x');
  const item = b.queued()[0];
  ok(!item.text.includes('Work item:'), 'no footer');
  ok(!out.includes('work:'), 'no work line');
  eq(b.ops().length, 0);
});

t('bg.mjs with the tracker ON: a footer, a queued job op with the card, and --no-track', () => {
  const b = bgCopy('bg-on', { workTracker: { team: 'ENG', dispatchDrainMs: 0 } });
  const out = b.run('--card', 'Billing: rework the export | the CSV drops rows');
  const item = b.queued()[0];
  const key = workKeyOf(item.text);
  ok(key && key.startsWith('job-'), item.text.slice(-200));
  ok(item.text.trimEnd().endsWith(workKeyLine(key)), 'the footer is the last line');
  ok(out.includes(`work: ${key}`), out);
  const [op] = b.ops();
  eq([op.op, op.key, op.title, op.card], ['job', key, 'Rework the export', 'Billing: rework the export | the CSV drops rows']);
  b.run('--no-track');
  ok(!b.queued()[1].text.includes('Work item:'), '--no-track: no footer');
  eq(b.ops().length, 1, '--no-track: no op');
});

t('bg.mjs keeps a key the brief already names, and reads a Linear: line as the link', () => {
  const b = bgCopy('bg-link', { workTracker: { team: 'ENG', dispatchDrainMs: 0 } });
  writeFileSync(path.join(b.dir, 'brief.md'), '# Redo\n\nLinear: ENG-12\n\n---\nWork item: job-keep1. tracked\n');
  b.run();
  eq(workKeyOf(b.queued()[0].text), 'job-keep1');
  eq(b.queued()[0].text.split('Work item:').length, 2, 'not footered twice');
  const [op] = b.ops();
  eq([op.key, op.link], ['job-keep1', 'ENG-12']);
});

t('bg.mjs --no-track on a brief that carries a footer: the daemon finds no key', () => {
  const b = bgCopy('bg-notrack-footer', { workTracker: { team: 'ENG', dispatchDrainMs: 0 } });
  writeFileSync(path.join(b.dir, 'brief.md'), '# Redo\n\nWork item: job-old1. inline mention\n\nbody\n\n---\nWork item: job-old1. The bridge tracks this job in Linear.\n');
  b.run('--no-track');
  const text = b.queued()[0].text;
  eq(workKeyOf(text), null, text.slice(-200));
  eq(b.ops().length, 0);
});

t('bg.mjs refuses --card with no text', () => {
  const b = bgCopy('bg-card', { workTracker: { team: 'ENG', dispatchDrainMs: 0 } });
  let code = 0;
  try {
    b.run('--card', '--no-track');
  } catch (e) {
    code = e.status;
  }
  eq(code, 1);
  ok(!existsSync(path.join(b.dir, 'bg-queue.json')), 'nothing queued');
});

// ── bridge.mjs wiring, read as text (never imported: it boots a daemon) ────

t('/help is unchanged when the tracker is off, and lists /comments only when on', () => {
  const off = helpMessage({ name: 'Leash' }).visible;
  ok(!off.includes('/comments'));
  ok(off.includes('⏰ /remind /schedules /unschedule\n'), off);
  ok(helpMessage({ name: 'Leash', extraCommands: ['/comments'] }).visible.includes('⏰ /remind /schedules /unschedule /comments'));
});

t('jobTitleOf and bg.mjs title a job the same way', () => {
  eq(jobTitleOf('LANE RULES x\n\n--- TASK ---\n\n# Rework the export\n\nbody\n\n---\nWork item: job-a. x'), 'Rework the export');
  eq(jobTitleOf('first line here\nmore'), 'first line here');
});

t('bridge.mjs: started at every worker start, reported in writeFullReport, /comments handled', () => {
  const src = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8');
  eq(src.split('workTracker.started(rawText, run.watchdogId);').length - 1, 3, 'Claude worker, codex exec, codex app-server');
  const wfr = src.slice(src.indexOf('function writeFullReport('), src.indexOf('function writeFullReport(') + 1200);
  ok(wfr.includes('workTracker.reported(task, id, { output: text, status });'));
  const reserved = /const RESERVED_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(src)[1];
  ok(!reserved.includes('/comments'), 'not reserved when off: a user command of that name still reaches Claude Code');
  ok(src.includes("if (WORK_SETTINGS) RESERVED_COMMANDS.add('/comments');"), 'reserved when on');
  ok(src.includes("extraCommands: WORK_SETTINGS ? ['/comments'] : []"), 'in /help only when on');
  ok(src.includes("case '/comments': {"));
  ok(src.includes("...(WORK_SETTINGS ? [{ command: 'comments'"), 'in the menu only when on');
});

// ── the four known defects of the first review (each red on 1b653c8) ──────

// An owner's answer on a Waiting card, then `n` newer comments by `user`.
async function answerThenNoise(name, n, user, opts = {}) {
  const f = fresh(name);
  if (opts.pageLimit) f.tr = createTracker({ gql: f.L.gql, paths: f.p, team: 'ENG', now: () => clock, pageLimit: opts.pageLimit });
  await f.run(['setup']);
  await f.run(['job', '--key', `job-${name}`, '--title', 'Area: asks']);
  await f.run(['report', '--key', `job-${name}`, '--status', 'finished', '--stdin'], { stdin: '## Remaining\n- waiting-owner: Area: which one? | A or B' });
  const ask = f.L.byTitle('Area: which one?');
  clock += 60_000;
  f.L.db.comments.push({ id: `${name}-answer`, body: 'B, the answer', issueId: ask.id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me', name: 'Me' } });
  for (let i = 0; i < n; i++) {
    clock += 1000;
    f.L.db.comments.push({ id: `${name}-n${i}`, body: user === 'user-me' ? `${MARK} a tracker note ${i}` : `noise ${i}`, issueId: ask.id, createdAt: new Date(clock).toISOString(), user: { id: user, name: 'X' } });
  }
  return { f, ask };
}

t('comments: an answer under 205 newer comments by teammates is still read (no page cap skips it)', async () => {
  const { f, ask } = await answerThenNoise('busy-team', 205, 'user-2');
  f.out.length = 0;
  eq(await f.run(['comments']), 0);
  ok(f.out.join('\n').includes('B, the answer'), 'the answer is in the batch');
  eq(f.L.stateOf(ask.stateId).name, 'Answered');
});

t('comments: an answer under 260 newer tracker notes by the same user is still read', async () => {
  const { f } = await answerThenNoise('busy-tracker', 260, 'user-me');
  f.out.length = 0;
  eq(await f.run(['comments']), 0);
  ok(f.out.join('\n').includes('B, the answer'), 'the answer is in the batch');
});

t('comments: a read cut at the page limit keeps its cursor and shows nothing twice', async () => {
  const { f } = await answerThenNoise('cut-read', 0, 'user-me');
  const cursorBefore = JSON.parse(readFileSync(f.p.cursor, 'utf8')).since;
  for (let i = 0; i < 120; i++) {
    clock += 1000;
    f.L.db.comments.push({ id: `cut-own${i}`, body: `own answer ${i}`, issueId: f.L.byTitle('Area: which one?').id, createdAt: new Date(clock).toISOString(), user: { id: 'user-me' } });
  }
  const tr = createTracker({ gql: f.L.gql, paths: f.p, team: 'ENG', now: () => clock, pageLimit: 2 });
  const r = await tr.readComments();
  eq(r.complete, false, 'two pages of 50 do not reach the end');
  eq(JSON.parse(readFileSync(f.p.cursor, 'utf8')).since, cursorBefore, 'the cursor did not move past what was not read');
  const taken = r.pending.length;
  eq(taken, 100);
  tr.doneComments('2099-01-01T00:00:00.000Z');
  // nothing was shown, so nothing was dropped; mark them shown and ack them
  const { markShown: ms } = await import('./scripts/work.mjs');
  writeFileSync(f.p.pending, JSON.stringify(ms(JSON.parse(readFileSync(f.p.pending, 'utf8')), { maxChars: 1e9 })));
  tr.doneComments('2099-01-01T00:00:00.000Z');
  const full = createTracker({ gql: f.L.gql, paths: f.p, team: 'ENG', now: () => clock });
  const r2 = await full.readComments();
  eq(r2.complete, true);
  eq(r2.added, 21, 'the 21 not taken yet (the first answer and 20 more), none of the 100 again');
});

t('findByKey: a job with 12 leftovers quoting its key still finds its own card (no second job card)', async () => {
  const f = fresh('many-leftovers');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-ml1', '--title', 'Area: many']);
  const block = ['## Remaining', ...Array.from({ length: 12 }, (_, i) => `- owed: Area: part ${i} | piece ${i}`)].join('\n');
  await f.run(['report', '--key', 'job-ml1', '--run', 'bg2-1790000000000', '--status', 'failed', '--stdin'], { stdin: block });
  rmSync(f.p.keys, { force: true }); // the key map lost: the search alone must find it
  eq(await f.run(['link-run', '--key', 'job-ml1', '--run', 'bg3-1790000000001']), 0);
  const jobCards = f.L.db.issues.filter((i) => readMeta(i.description).key === 'job-ml1');
  eq(jobCards.length, 1, 'one job card');
  eq(f.L.stateOf(jobCards[0].stateId).name, 'Running');
});

t('sweep: an Answered card under 1050 newer teammate issues is still listed', async () => {
  const f = fresh('busy-sweep');
  await f.run(['setup']);
  await f.run(['job', '--key', 'job-bs1', '--title', 'Area: old card']);
  const card = f.L.byTitle('Area: old card');
  card.stateId = f.L.team.states.find((x) => x.name === 'Answered').id;
  for (let i = 0; i < 1050; i++) f.L.human(`teammate ${i}`);
  f.out.length = 0;
  eq(await f.run(['sweep']), 0);
  ok(f.out.join('\n').includes('Area: old card'), f.out.join('\n').slice(0, 300));
});

t('a comments batch fits the schedule output limit as printed, and a long comment is clipped on its own', async () => {
  const { BATCH_MAX_CHARS: max, BATCH_BODY_MAX: bodyMax } = await import('./scripts/work.mjs');
  const { SCRIPT_OUTPUT_MAX } = await import('./schedule-script.mjs');
  ok(max < SCRIPT_OUTPUT_MAX, 'the batch limit is under the schedule output limit');
  // Many short lines: each costs a quote mark and a newline the old estimate missed.
  const pending = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, body: Array(200).fill('x').join('\n'), createdAt: new Date(NOW + i * 1000).toISOString(), card: `ENG-${i}`, title: `Area: card ${i} with a long enough title`, state: 'Answered', shown: 0 }));
  const text = commentsBatch(pending, { cli: '/opt/leash/scripts/work.mjs' });
  ok(text.length <= max, `printed ${text.length} > ${max}`);
  const upTo = /comments --done (\S+)/.exec(text)[1];
  const covered = pending.filter((c) => c.createdAt <= upTo);
  for (const c of covered) ok(text.includes(`${c.card} · `), `${c.card} is covered by --done and shown`);
  const one = commentsBatch([{ id: 'big', body: 'y'.repeat(9000), createdAt: new Date(NOW).toISOString(), card: 'ENG-1', title: 'Area: big', state: 'Answered', shown: 0 }]);
  ok(one.length <= max && one.includes('read the rest on ENG-1'), `one huge comment: ${one.length}`);
  ok(Number.isFinite(bodyMax) && bodyMax < max);
});

t('a Linear: link to an issue that does not exist is set aside at once, not tried 3 times', async () => {
  const f = fresh('missing-link');
  await f.run(['setup']);
  enqueue(f.p, { op: 'job', key: 'job-nolink', title: 'x', link: 'ENG-404' });
  f.out.length = 0;
  await f.run(['drain']);
  eq([outboxStatus(f.p).waiting, outboxStatus(f.p).failed], [0, 1], 'set aside after one try');
  ok(f.out.join('\n').includes('after 1 try'), f.out.join('\n'));
});

t('getIssue over the real transport: Linear raising "Entity not found" is null, not a failure', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input' } }] }) });
  const dir = path.join(TMP, 'nf-transport');
  const tr = createTracker({ gql: linearTransport({ key: 'k', fetchImpl }), paths: statePaths(dir), team: 'ENG', now: () => clock });
  eq(await tr.getIssue('ENG-404'), null);
});

t('a printed command names a CLI under a folder with a space as one shell word', async () => {
  const { shellArg } = await import('./work-track.mjs');
  eq(typeof shellArg, 'function', 'work-track.mjs exports shellArg');
  const spaced = path.join(TMP, 'my leash', "it's", 'scripts', 'work.mjs');
  eq(shellArg('/opt/leash/scripts/work.mjs'), '/opt/leash/scripts/work.mjs', 'a plain path stays bare');
  eq(execFileSync('/bin/sh', ['-c', `printf %s ${shellArg(spaced)}`], { encoding: 'utf8' }), spaced, 'the shell reads it back whole');
  const pending = [{ id: 'q1', body: 'yes', createdAt: new Date(NOW).toISOString(), card: 'ENG-1', title: 'Area: q', state: 'Answered', shown: 0 }];
  ok(commentsBatch(pending, { cli: spaced }).includes(`node ${shellArg(spaced)} comments --done `), 'the --done line');
  // The tracker's own lines: not set up, and an op set aside.
  const f = fresh('spaced-cli');
  const tr = createTracker({ gql: f.L.gql, paths: f.p, team: 'ENG', now: () => clock, cli: spaced });
  enqueue(f.p, { op: 'job', key: 'job-sp1', title: 'x' });
  const r = await tr.drain();
  ok(r.lines.join('\n').includes(`node ${shellArg(spaced)} setup`), r.lines.join('\n'));
  await f.run(['setup']);
  enqueue(f.p, { op: 'nope', key: 'job-sp2' });
  const r2 = await tr.drain();
  ok(r2.lines.join('\n').includes(`node ${shellArg(spaced)} retry`), r2.lines.join('\n'));
  // bg.mjs carries the same helper (it imports nothing), and uses it on the ps line.
  const bgSrc = readFileSync(path.join(DIR, 'bg.mjs'), 'utf8');
  const wtSrc = readFileSync(path.join(DIR, 'work-track.mjs'), 'utf8');
  const body = (src, head) => (src.split('\n').find((l) => l.startsWith(head)) || '').slice(head.length);
  ok(body(wtSrc, 'export const shellArg = ') && body(bgSrc, 'const shellArg = ') === body(wtSrc, 'export const shellArg = '), 'the two shellArg lines are equal');
  ok(/const cli = shellArg\(work\.cli\);/.test(bgSrc) && !/node \$\{work\.cli\}/.test(bgSrc), 'the ps outbox line quotes the CLI');
});

for (const run of queue) await run();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
