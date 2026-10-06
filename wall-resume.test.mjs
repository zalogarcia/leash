// wall-resume.mjs: the usage wall guard, part 2 (restart the work after the
// wall). The plan and its safety rules, each across a simulated daemon
// restart through the real state record, the resume brief, the queue item,
// the wake-up lines and the owner's line.
// Run: node wall-resume.test.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RESUME_HEADING_RE,
  ORIGINAL_BRIEF_RULE,
  optedOut,
  splitResumeHeader,
  resumeCountOf,
  checkpointCommitFrom,
  sameJobTitle,
  resumeCandidates,
  PROVISIONAL_WINDOW_MS,
  resumePlan,
  resumeTiming,
  resumeNote,
  resumeBrief,
  resumeQueueItem,
  resumeWakeLines,
  resumeLiftNotice,
  paceWords,
  liftNoticeDue,
  SKIP,
} from './wall-resume.mjs';
import { createWallGuardStore, wallGuardSettings } from './wall-guard.mjs';
import { resolveEngine } from './engine-state.mjs';

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || 'expected truthy');
};
const DASHES = /[\u2013\u2014]/;

const NOW = Date.UTC(2026, 9, 6, 17, 20, 0);
const MIN = 60_000;
const S = wallGuardSettings(undefined);
const RULES = 'LANE RULES (you are a background worker).\n1. a rule\n\n--- TASK ---\n\n';
const TASK = '# BUILD-THE-THING-1006\n\nDo the thing.\n\nRepo: ~/dev/some-repo\n';
const BRIEF = `${RULES}${TASK}`;

// ---------------------------------------------------------------------------
console.log('\n1. the resume brief: the ORIGINAL brief whole, the note first, the title kept');
// ---------------------------------------------------------------------------

const NOTE = resumeNote({ runId: 'bg3-1791290000003', endedClock: '11:52am', account: 'acct-a', count: 1, max: 2, draft: '/tmp/r/bg3-1791290000003.draft.md', report: '/tmp/r/bg3-1791290000003.md', checkpoint: { branch: 'feat/x', sha: 'abc1234' }, writesCommand: 'list-writes bg3-1791290000003' });
const R1 = resumeBrief({ text: BRIEF, task: TASK, title: 'BUILD-THE-THING-1006', count: 1, max: 2, note: NOTE });

t('★ the original brief is whole and unchanged, at the end', () => {
  ok(R1.text.endsWith(TASK), 'the original task must be the tail, byte for byte');
});

t('★ the lane rules stay first, untouched; then the heading; then the RESUME NOTE before the original', () => {
  ok(R1.text.startsWith(RULES));
  const task = R1.text.slice(RULES.length);
  ok(task.startsWith('# BUILD-THE-THING-1006 (auto resume 1 of 2)\n\n## RESUME NOTE'), task.slice(0, 120));
  ok(task.indexOf('## RESUME NOTE') < task.indexOf(ORIGINAL_BRIEF_RULE));
  ok(task.indexOf(ORIGINAL_BRIEF_RULE) < task.indexOf('# BUILD-THE-THING-1006\n'));
});

t('★ the title keeps the original as its prefix, with a resume suffix', () => {
  eq(R1.title, 'BUILD-THE-THING-1006 (auto resume 1 of 2)');
  ok(R1.title.startsWith('BUILD-THE-THING-1006'));
});

t('★ the note carries why it ended, the draft, the report, the checkpoint commit, the writes command and the three rules', () => {
  for (const want of [/ran before as bg3-1791290000003/, /ended at 11:52am/, /every Claude account had reached its usage limit/, /it was on acct-a/, /bg3-1791290000003\.draft\.md/, /full report: \/tmp\/r\/bg3-1791290000003\.md/, /abc1234 on branch feat\/x/, /run `list-writes bg3-1791290000003`/, /Do not redo finished work/, /verify the live state/, /Never repeat a send, a deploy, a migration, a payment or a publish/, /If no checkpoint note exists, say so first/]) {
    ok(want.test(NOTE), `missing ${want}`);
  }
  ok(!DASHES.test(NOTE));
});

t('with nothing known, the note says none rather than guessing, and names the run log', () => {
  const n = resumeNote({ runId: 'bg-1791290000001', runLog: '/tmp/runs/bg-1791290000001.jsonl' });
  ok(/draft report: none was written/.test(n) && /none found in its log/.test(n) && /read its run log/.test(n), n);
});

t('★ a resume of a resume rebuilds from the ORIGINAL, never stacking notes', () => {
  const r1task = R1.text.slice(RULES.length);
  const R2 = resumeBrief({ text: R1.text, task: r1task, title: 'ignored', count: 2, max: 2, note: '## RESUME NOTE (written by the bridge; read it before anything else)\nsecond' });
  ok(R2.text.endsWith(TASK));
  eq((R2.text.match(/## RESUME NOTE/g) || []).length, 1, 'one note');
  eq(R2.title, 'BUILD-THE-THING-1006 (auto resume 2 of 2)');
});

t('splitResumeHeader and the chain count read the bridge header back', () => {
  const r1task = R1.text.slice(RULES.length);
  const s = splitResumeHeader(r1task);
  eq([s.title, s.count, s.max, s.original === TASK], ['BUILD-THE-THING-1006', 1, 2, true]);
  eq(splitResumeHeader(TASK).count, 0);
  ok(RESUME_HEADING_RE.test('# x (auto resume 1 of 2)'));
});

t('a brief with no heading takes its first line as the title', () => {
  const r = resumeBrief({ text: 'fix the flaky test in foo\nmore', task: 'fix the flaky test in foo\nmore', title: '', count: 1, max: 2, note: 'n' });
  eq(r.title, 'fix the flaky test in foo (auto resume 1 of 2)');
});

// ---------------------------------------------------------------------------
console.log('\n2. the queue item: same engine, same directory pin, the scheduled mark');
// ---------------------------------------------------------------------------

t('★ pinned to Claude, the cwd and the schedule mark carried, the chain recorded', () => {
  const item = resumeQueueItem({ death: { runId: 'bg3-1791290000003', cwd: '/tmp/wt-a', scheduleId: 8, allowWrite: true }, text: R1.text, count: 1, now: NOW });
  eq(item.engine, 'claude');
  eq(item.cwd, '/tmp/wt-a');
  eq([item.scheduleId, item.allowWrite], [8, true]);
  eq([item.resumeOf, item.resumeCount, item.resumeRoot], ['bg3-1791290000003', 1, 'bg3-1791290000003']);
  eq(item.queuedAt, new Date(NOW).toISOString());
  ok(!('now' in item), 'a resume never skips the concurrency cap');
});

t('no cwd and no schedule: neither field is invented', () => {
  const item = resumeQueueItem({ death: { runId: 'bg-1791290000001' }, text: 'x', count: 1, now: NOW });
  ok(!('cwd' in item) && !('scheduleId' in item) && !('allowWrite' in item), JSON.stringify(item));
});

t('★ the pace rides on the item as maxRunning, and only when there is one', () => {
  const d = { runId: 'bg-1791290000001' };
  eq(resumeQueueItem({ death: d, text: 'x', maxRunning: 4 }).maxRunning, 4);
  eq(resumeQueueItem({ death: d, text: 'x', maxRunning: '3' }).maxRunning, 3);
  eq(resumeQueueItem({ death: d, text: 'x', maxRunning: 2.7 }).maxRunning, 2);
  for (const none of [0, null, undefined, false, -2, 'x']) ok(!('maxRunning' in resumeQueueItem({ death: d, text: 'x', maxRunning: none })), String(none));
  ok(!('now' in resumeQueueItem({ death: d, text: 'x', maxRunning: 4 })), 'a pace is never a way past the cap');
});

t('allowWrite never travels without the schedule it belongs to', () => {
  ok(!('allowWrite' in resumeQueueItem({ death: { runId: 'bg-1', allowWrite: true }, text: 'x' })));
});

t('★ while the wall is up the pinned resume WAITS on Claude; a new unpinned job still falls through to Codex', () => {
  const wall = { lane: 'bg', chat: {}, config: {}, claudeAvailable: true, codexAvailable: true, rotationPausedUntil: NOW + 30 * MIN, now: NOW, codexFallback: true };
  const resumeItem = resumeQueueItem({ death: { runId: 'bg-1791290000001' }, text: 'x', count: 1, now: NOW });
  const r = resolveEngine({ ...wall, forcedEngine: resumeItem.engine });
  eq([r.engine, Boolean(r.pausedUntil)], ['claude', true], 'held for the lift, never Codex');
  const fresh = resolveEngine({ ...wall, forcedEngine: null });
  eq([fresh.engine, fresh.reason], ['codex', 'claude_limited'], 'the fallback for new jobs is unchanged');
});

// ---------------------------------------------------------------------------
console.log('\n3. ★ the plan and its safety rules, across a simulated daemon restart (criterion 6)');
// ---------------------------------------------------------------------------

const TMP = mkdtempSync(path.join(tmpdir(), 'wall-resume-test-'));
const FILE = path.join(TMP, 'wall-guard.json');
let clock = NOW;
const store = () => createWallGuardStore({ file: FILE, now: () => clock });
const death = (runId, extra = {}) => ({ text: BRIEF, task: TASK, title: 'BUILD-THE-THING-1006', ...extra });
const planFor = (s, { alive = new Set(), busy = () => false, settings = S, episodeWorkers = [] } = {}) => {
  const { candidates } = resumeCandidates({ episodeWorkers, deaths: s.deaths().map((d) => ({ ...d, task: d.task })), since: NOW - 60 * MIN });
  return resumePlan({ candidates, settings, isAlive: (id) => alive.has(id), isBusy: busy, wasResumed: (id) => s.wasResumed(id) });
};

t('★ a dead unfinished worker is resumed, as resume 1', () => {
  const s = store();
  s.death('bg3-1791290000003', death('bg3-1791290000003'));
  const p = planFor(store()); // restart between the death and the lift
  eq(p.resume.map((r) => [r.runId, r.count]), [['bg3-1791290000003', 1]]);
});

t('★ NEVER a run that is still alive, after a restart too', () => {
  const p = planFor(store(), { alive: new Set(['bg3-1791290000003']) });
  eq(p.resume.length, 0);
  eq(p.skip[0].reason, SKIP.alive);
});

t('★ NEVER the same death twice: the claim is persisted before the queue, and a restart honours it', () => {
  const s = store();
  eq(s.claimResume('bg3-1791290000003', { count: 1 }), true);
  const again = planFor(store()); // the daemon restarted after queueing
  eq(again.resume.length, 0);
  eq(again.skip[0].reason, SKIP.resumedBefore);
  eq(store().claimResume('bg3-1791290000003'), false, 'and the claim itself refuses');
});

t('★ the chain cap stops at 2 and hands the job to the chat lane with the reason', () => {
  // ONE store object per step, as one daemon holds one: two objects writing
  // the same file would overwrite each other's claims.
  // the original died → resume 1 (allowed)
  store().death('bg10-1791290000010', death('bg10-1791290000010'));
  let p = planFor(store());
  eq(p.resume.find((r) => r.runId === 'bg10-1791290000010').count, 1);
  store().claimResume('bg10-1791290000010');
  // resume 1 died → resume 2 (allowed)
  const r1 = resumeBrief({ text: BRIEF, task: TASK, title: 'BUILD-THE-THING-1006', count: 1, max: 2, note: 'n' });
  store().job('bg11-1791290000011', { resumeCount: 1, resumeRoot: 'bg10-1791290000010' });
  store().death('bg11-1791290000011', { text: r1.text, task: r1.text.slice(RULES.length), title: r1.title });
  p = planFor(store());
  eq(p.resume.map((r) => r.runId).join(','), 'bg11-1791290000011', 'the claimed resume 1 is not resumed again');
  eq(p.resume.find((r) => r.runId === 'bg11-1791290000011').count, 2);
  store().claimResume('bg11-1791290000011');
  // resume 2 died → NOT resumed: the chain cap, with its reason
  const r2 = resumeBrief({ text: r1.text, task: r1.text.slice(RULES.length), title: '', count: 2, max: 2, note: 'n' });
  store().job('bg12-1791290000012', { resumeCount: 2, resumeRoot: 'bg10-1791290000010' });
  store().death('bg12-1791290000012', { text: r2.text, task: r2.text.slice(RULES.length), title: r2.title });
  p = planFor(store());
  ok(!p.resume.some((r) => r.runId === 'bg12-1791290000012'), 'a third resume would loop');
  eq(p.skip.find((r) => r.runId === 'bg12-1791290000012').reason, 'chain cap: resumed 2 times automatically already');
});

t('★ the chain count survives a lost dispatch record: the brief itself carries it', () => {
  const r2 = resumeBrief({ text: BRIEF, task: TASK, title: 'X', count: 2, max: 2, note: 'n' });
  eq(resumeCountOf({ task: r2.text.slice(RULES.length), meta: null }), 2);
  eq(resumeCountOf({ task: TASK, meta: { resumeCount: 1 } }), 1);
});

t('★ Auto-resume: no is honoured, across a restart', () => {
  store().death('bg20-1791290000020', death('bg20-1791290000020', { text: `${BRIEF}\nAuto-resume: no\n` }));
  const p = planFor(store());
  eq(p.skip.find((r) => r.runId === 'bg20-1791290000020').reason, SKIP.optOut);
});

t('the opt out is a line of its own; a sentence that mentions it is not one', () => {
  ok(optedOut('brief\n\nAuto-resume: no'));
  ok(optedOut('brief\n- **Auto-resume:** no\n'));
  ok(optedOut('brief\nauto-resume: NO.\n'));
  ok(!optedOut('a brief whose trailer has the line `Auto-resume: no` is never resumed'));
  ok(!optedOut('Auto-resume: yes'));
});

t('a finished worker (report only held) is not resumed, and says why', () => {
  const p = resumePlan({ candidates: [{ runId: 'bg30-1791290000030', title: 't', died: false }], settings: S });
  eq(p.skip[0].reason, SKIP.finished);
});

t('a worker whose final report was written before the limit is not resumed', () => {
  const p = resumePlan({ candidates: [{ runId: 'bg31-1791290000031', title: 't', died: true, finalReportSeen: true, text: 'x' }], settings: S });
  eq(p.skip[0].reason, SKIP.finalReport);
});

t('no brief on disk: listed with that reason', () => {
  const p = resumePlan({ candidates: [{ runId: 'bg32-1791290000032', title: 't', died: true }], settings: S });
  eq(p.skip[0].reason, SKIP.noBrief);
});

t('a job already running or queued under the same title is not queued again', () => {
  const p = resumePlan({ candidates: [{ runId: 'bg33-1791290000033', title: 'BUILD-THE-THING-1006', died: true, text: BRIEF, task: TASK }], settings: S, isBusy: (t) => sameJobTitle(t, 'BUILD-THE-THING-1006 (auto resume 1 of 2)') });
  eq(p.skip[0].reason, SKIP.busy);
});

t('resume switched off: nothing is resumed, each is listed for the chat lane', () => {
  const p = resumePlan({ candidates: [{ runId: 'bg34-1791290000034', title: 't', died: true, text: 'x' }], settings: wallGuardSettings({ resume: false }) });
  eq([p.resume.length, p.skip[0].reason], [0, SKIP.off]);
});

t('a chain max of 0 resumes nothing and says so', () => {
  const p = resumePlan({ candidates: [{ runId: 'bg35-1791290000035', title: 't', died: true, text: 'x', task: 'x' }], settings: wallGuardSettings({ resumeChainMax: 0 }) });
  eq(p.skip[0].reason, 'chain cap: resumed 0 times automatically already');
});

t('candidates: the episode rows and the stored deaths joined by base id; a death from an older wall is stale', () => {
  const { candidates, stale } = resumeCandidates({
    episodeWorkers: [{ runId: 'bg40-1791290000040-555', title: 'from the episode', died: true }, { runId: 'bg41-1791290000041', title: 'finished one', died: false }],
    deaths: [{ runId: 'bg40-1791290000040', text: 'brief', at: NOW }, { runId: 'bg42-1791290000042', text: 'old', at: NOW - 600 * MIN }],
    since: NOW - 60 * MIN,
  });
  eq(candidates.map((c) => [c.runId, c.died, Boolean(c.text)]), [['bg40-1791290000040', true, true], ['bg41-1791290000041', false, false]]);
  eq(stale, ['bg42-1791290000042']);
});

t('sameJobTitle: suffix and clip tolerant, never on a short title', () => {
  ok(sameJobTitle('BUILD-THE-THING-1006', 'BUILD-THE-THING-1006 (auto resume 1 of 2)'));
  ok(sameJobTitle('A long title that was clipped for disp…', 'A long title that was clipped for display in the card'));
  ok(!sameJobTitle('Fix', 'Fix the encoder'));
  ok(!sameJobTitle('', ''));
});

t('checkpointCommitFrom: the LAST "WIP checkpoint" commit in the log', () => {
  const log = '{"content":"[feat/a 1a2b3c4] WIP checkpoint: one"}\n{"content":"[feat/a 9f8e7d6] WIP checkpoint: two\\n 3 files changed"}';
  eq(checkpointCommitFrom(log), { branch: 'feat/a', sha: '9f8e7d6' });
  eq(checkpointCommitFrom('[main abc1234] fix: unrelated'), null);
});

// ---------------------------------------------------------------------------
console.log('\n4. ★ timing, the wake-up lines and the owner line (criteria 5, 7, 4)');
// ---------------------------------------------------------------------------

t('★ resumes queued at the lift are inside the window; a lift after it is flagged late', () => {
  const on = resumeTiming({ readyAt: NOW, now: NOW + 40_000, withinMinutes: 5 });
  eq([on.late, on.dueBy], [false, NOW + 5 * MIN]);
  const late = resumeTiming({ readyAt: NOW, now: NOW + 12 * MIN, withinMinutes: 5 });
  eq([late.late, late.lateMin], [true, 12]);
});

const RESUMED = [{ runId: 'bg3-1791290000003', title: 'BUILD-THE-THING-1006', count: 1, max: 2 }];
const SKIPPED = [
  { runId: 'bg4-1791290000004', title: 'Render the reels', reason: SKIP.optOut, died: true },
  { runId: 'bg5-1791290000005', title: 'Ship the fix', reason: 'chain cap: resumed 2 times automatically already', died: true },
  { runId: 'bg6-1791290000006', title: 'Write the doc', reason: SKIP.finished, died: false },
];

t('★ the wake-up names what was resumed with "Do NOT dispatch these again", and every job not resumed with its reason', () => {
  const lines = resumeWakeLines({ resumed: RESUMED, skipped: SKIPPED });
  const s = lines.join('\n');
  ok(/RESUMED 1 job/.test(s) && /Do NOT dispatch these again/.test(s), s);
  ok(/bg3-1791290000003 · BUILD-THE-THING-1006 · queued as resume 1 of 2/.test(s), s);
  ok(/did NOT resume 3 jobs/.test(s), s);
  ok(/bg4-1791290000004 · Render the reels · its brief says Auto-resume: no/.test(s));
  ok(/chain cap: resumed 2 times/.test(s) && /it finished/.test(s));
  ok(!lines.some((l) => l === ''), 'no blank line: the fold cuts the note at its first one');
  ok(!DASHES.test(s));
});

t('nothing to say: no lines', () => {
  eq(resumeWakeLines({}), []);
});

t('★ the pace is said where a waiting job could be mistaken for a lost one', () => {
  const wake = resumeWakeLines({ resumed: RESUMED, skipped: [], maxRunning: 4 }).join('\n');
  ok(/at most 4 resumed jobs run at once, the rest start as they finish, so a job still waiting in the queue is not lost/.test(wake), wake);
  ok(/Do NOT dispatch these again/.test(wake));
  ok(!/run at once/.test(resumeWakeLines({ resumed: RESUMED, skipped: [] }).join('\n')), 'no pace, no words about one');
  const many = Array.from({ length: 6 }, (_, i) => ({ runId: `bg${i}-179129000000${i}`, title: `JOB-${i}-1006`, count: 1, max: 2 }));
  const n = resumeLiftNotice({ resumed: many, skipped: [], maxRunning: 4 });
  ok(/^🔁 Resumed 6 jobs after the usage wall$/m.test(n), n);
  ok(/^🚦 Paced: at most 4 resumed jobs run at once, the rest start as they finish$/m.test(n), n);
  ok(!/Paced/.test(resumeLiftNotice({ resumed: RESUMED, skipped: [], maxRunning: 4 })), 'one job under a pace of four waits for nothing, so the line says nothing');
  ok(/^at most 1 resumed job runs at once/.test(paceWords(1)) && paceWords(0) === '' && paceWords(null) === '');
  ok(!DASHES.test(wake + n));
});

t("★ the owner's line at the lift: how many, their titles, how many not and why", () => {
  const n = resumeLiftNotice({ resumed: RESUMED, skipped: SKIPPED });
  ok(/Resumed 1 job after the usage wall/.test(n), n);
  ok(/↳ BUILD-THE-THING-1006/.test(n));
  ok(/Not resumed: 2 · 1 its brief says Auto-resume: no · 1 chain cap$/.test(n), n);
  ok(!/finished/.test(n), 'a worker that only finished is not a job that was not resumed');
  ok(!DASHES.test(n));
});

t('★ QA 2026-10-06: no line is owed when nothing died (a finished worker is already in the wake-up)', () => {
  eq(liftNoticeDue({ resumed: [], skipped: [SKIPPED[2]] }), false);
  eq(liftNoticeDue({ resumed: [], skipped: [SKIPPED[0]] }), true);
  eq(liftNoticeDue({ resumed: RESUMED, skipped: [] }), true);
});

t('★ QA round 2: a PROVISIONAL death counts only when the wall went up around it', () => {
  const RAISED = NOW;
  const death = (runId, at, extra = {}) => ({ runId, at, text: BRIEF, title: 'BUILD-THE-THING-1006', ...extra });
  const near = death('bg7-1791290000007', RAISED - 20_000, { provisional: true }); // 20 s before the wall went up
  const after = death('bg8-1791290000008', RAISED + 60_000, { provisional: true });
  const swap = death('bg9-1791290000009', RAISED - 15 * MIN, { provisional: true }); // died on a swap, a wall came later
  const sure = death('bg10-1791290000010', RAISED - 15 * MIN); // a recorded wall death is never second guessed
  const since = RAISED - 30 * MIN; // an episode carried forward reaches back this far
  const r = resumeCandidates({ episodeWorkers: [{ runId: near.runId, title: near.title, died: false }], deaths: [near, after, swap, sure], since, raisedAt: RAISED });
  eq(r.candidates.map((c) => c.runId).sort(), [after.runId, sure.runId, near.runId].sort());
  eq(r.stale, [swap.runId], 'dropped: no wall went up around it');
  eq(r.candidates.find((c) => c.runId === near.runId).died, true, 'the store says it died, whatever the episode row says');
  eq(resumeCandidates({ deaths: [near], since }).stale, [near.runId], 'no raise time known: a provisional death is not trusted');
  // A wall raised again before its wake-up ran: the same episode, a later raise.
  const again = resumeCandidates({ deaths: [swap, near], since, raisedAt: [RAISED - 16 * MIN, RAISED] });
  eq(again.candidates.map((c) => c.runId).sort(), [swap.runId, near.runId].sort(), 'each is near one of the raises');
  eq(resumeCandidates({ deaths: [near], since, raisedAt: [null, 0, undefined] }).stale, [near.runId]);
  ok(PROVISIONAL_WINDOW_MS >= 90_000, 'wider than the rotation cooldown a provisional death can arrive in');
});

t('★ QA round 2: a death the drop box would not take is still a death, so the owner still gets a line', () => {
  const lost = [{ runId: 'bg3-1791290000003', title: 'BUILD-THE-THING-1006', died: true, reason: 'the drop box would not take it; dispatch it by hand' }];
  eq(liftNoticeDue({ resumed: [], skipped: lost }), true);
  const n = resumeLiftNotice({ resumed: [], skipped: lost });
  ok(/Resumed no jobs/.test(n) && /Not resumed: 1 · 1 the drop box would not take it$/.test(n), n);
});

t('★ QA 2026-10-06: two dead runs with the same title come back as ONE resume', () => {
  const c = (runId) => ({ runId, title: 'BUILD-THE-THING-1006', died: true, text: BRIEF, task: TASK });
  const p = resumePlan({ candidates: [c('bg50-1791290000050'), c('bg51-1791290000051')], settings: S });
  eq(p.resume.map((r) => r.runId), ['bg50-1791290000050']);
  eq(p.skip.map((r) => [r.runId, r.reason]), [['bg51-1791290000051', SKIP.duplicate]]);
});

t('a late lift says so; none resumed reads as such', () => {
  ok(/late, 12 min after the account was ready/.test(resumeLiftNotice({ resumed: RESUMED, late: true, lateMin: 12 })));
  ok(/Resumed no jobs/.test(resumeLiftNotice({ resumed: [], skipped: SKIPPED })));
});

t('no private marker in any text this module writes (the writes command is the caller\'s)', () => {
  const all = [NOTE, R1.text, resumeWakeLines({ resumed: RESUMED, skipped: SKIPPED }).join('\n'), resumeLiftNotice({ resumed: RESUMED, skipped: SKIPPED })].join('\n');
  // Built from parts, so this shared file itself names no machine's tool.
  for (const bad of [/@/, /\/Users\//, /\/home\//, new RegExp(['bg', 'sal' + 'vage'].join('-'))]) ok(!bad.test(all), `found ${bad}`);
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all wall-resume tests pass');
