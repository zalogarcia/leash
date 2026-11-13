#!/usr/bin/env node
// scripts/work.mjs: the optional Linear work tracker (CLI and library).
//
// Every background job becomes a Linear issue, and every leftover line of its
// report becomes an issue too, so work a worker did not finish is never left
// as one sentence in a chat. Off unless config.json names a team and a Linear
// key exists (work-track.mjs, workTrackerSettings). How to turn it on: README,
// "Track jobs in Linear".
//
//   node scripts/work.mjs setup [--check]          find the team, create the missing states, save the ids
//   node scripts/work.mjs open [--json]            open issues: id, state, age, title
//   node scripts/work.mjs status <ID> <state> [--comment "why"]
//   node scripts/work.mjs comment <ID> "text"
//   node scripts/work.mjs lint [--json]            every open card's title against the plain card check
//   node scripts/work.mjs sweep                    what needs the chat session; prints nothing when nothing does
//   node scripts/work.mjs comments [--again]       the owner's comments on cards not yet acted on, as one batch
//   node scripts/work.mjs comments --done <time>   the chat session acted on every comment up to that time
//   node scripts/work.mjs retry                    put the set aside ops back and send them
//   node scripts/work.mjs plan <PLAN.md> [--section <heading>]   one Queued issue per row of a step table
//   node scripts/work.mjs drain [--budget-ms N]    send the outbox now
//   node scripts/work.mjs outbox                   what waits in it
// Called by bg.mjs and the daemon (through the outbox):
//   job --key K --title T [--card "Area: title | sentence"] [--link ID]
//   link-run --key K --run R
//   report --key K --run R --status finished|failed|... --stdin
//
// THE KEY. A personal Linear API key, from LINEAR_API_KEY or the key file
// (`workTracker.keyFile`, default ~/.config/leash/linear-api-key, mode 600).
// It is sent only as the Authorization header to Linear and never printed,
// logged or written anywhere by this file.
//
// THE OUTBOX. job, link-run and report write their op to a local file first
// and send within a budget, so a slow or dead Linear never blocks a dispatch
// and never loses a report. Ops are sent in order. Linear being unreachable
// costs an op nothing (it waits); one Linear refuses 3 times is set aside in
// outbox/failed/ until `retry` puts it back. Every op is idempotent by its work key, stored
// in the issue's tracker data block, so a re-send never duplicates.
//
// WHAT REACHES LINEAR: a job's title (or its --card text), its engine and repo
// folder name, run ids, and the `## Remaining` lines of its report. Never the
// brief and never the rest of the report.

import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRunId, readBridgeConfig, workTrackerSettings } from '../work-track.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LINEAR_URL = 'https://api.linear.app/graphql';
export const MARK = '🤖';
const MAX_ATTEMPTS = 3;
const LOCK_STALE_MS = 10 * 60_000;

// ── states ──────────────────────────────────────────────────────────────────

/** The roles the tracker moves cards between, and the state each maps to by
 *  default. `workTracker.states` renames any of them, for example
 *  { "queued": "Todo", "running": "In Progress" } to reuse a team's own. */
export const STATE_ROLES = {
  queued: { name: 'Queued', type: 'unstarted', color: '#95a2b3' },
  running: { name: 'Running', type: 'started', color: '#f2c94c' },
  waiting: { name: 'Waiting on you', type: 'started', color: '#eb5757' },
  answered: { name: 'Answered', type: 'started', color: '#5e6ad2' },
  blocked: { name: 'Blocked', type: 'started', color: '#bb87fc' },
  done: { name: 'Done', type: 'completed', color: '#5e6ad2' },
  canceled: { name: 'Canceled', type: 'canceled', color: '#95a2b3' },
};

export function stateNames(overrides = {}) {
  const out = {};
  for (const [role, def] of Object.entries(STATE_ROLES)) {
    const v = overrides?.[role];
    out[role] = typeof v === 'string' && v.trim() ? v.trim() : def.name;
  }
  return out;
}

// ── the ## Remaining block ─────────────────────────────────────────────────

const ITEM_RE = /^\s*[-*]\s*(owed|waiting-owner|follow-up)\s*:\s*(\S.*?)\s*$/i;
const NONE_RE = /^\s*[-*]\s*none\.?\s*$/i;
const HEAD_RE = /^##\s+Remaining\s*:?\s*$/i;
const NEXT_HEAD_RE = /^#{1,2}\s+\S/;
// A list line that is not an item or none makes the block invalid rather than
// being dropped: "- waiting owner: approve" would otherwise lose the approval
// while the block still passed.
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * parseRemaining(text) -> { found, valid, none, items: [{ kind, text }], error }
 * The LAST "## Remaining" heading outside a code fence counts; its section runs
 * to the next # or ## heading. Valid: one or more item lines and no "- none",
 * or exactly one "- none".
 */
export function parseRemaining(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let start = -1;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    else if (!fence && HEAD_RE.test(lines[i])) start = i;
  }
  if (start < 0) return { found: false, valid: false, none: false, items: [], error: 'no ## Remaining heading' };
  const items = [];
  const bad = [];
  let none = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (NEXT_HEAD_RE.test(line)) break;
    if (!line.trim()) continue;
    const m = ITEM_RE.exec(line);
    if (m) items.push({ kind: m[1].toLowerCase(), text: m[2] });
    else if (NONE_RE.test(line)) none++;
    else if (BULLET_RE.test(line)) bad.push(line.trim());
  }
  let error = null;
  if (bad.length) error = `a list line that is not owed, waiting-owner, follow-up or none: "${bad[0].slice(0, 80)}"`;
  else if (none && items.length) error = '- none together with item lines';
  else if (none > 1) error = '- none more than once';
  else if (!none && !items.length) error = 'no item lines under ## Remaining';
  return { found: true, valid: !error, none: !error && none === 1, items: error ? [] : items, error };
}

// ── the plain card ─────────────────────────────────────────────────────────

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// A phone list shows about 45 characters of a title before it cuts it.
export const TITLE_MAX = 45;
const AREA_RE = /^[A-Z0-9][A-Za-z0-9'’ .&]{0,24}: \S/;
const DASH_RE = /[\u2013\u2014]/;

/** What makes text not plain for a reader on a phone: code, paths, ids, flags. */
export function plainProblems(text) {
  const t = String(text ?? '');
  const out = [];
  if (/`/.test(t)) out.push('code (a backtick)');
  if (/(^|[\s("])(~|\.{1,2})?\/[\w.~-]/.test(t) || /\b[\w.-]+\/[\w.-]+\/[\w.-]+/.test(t)) out.push('a path');
  if (/\b[\w-]+\.(md|sql|ts|tsx|js|mjs|cjs|py|json|sh|html?|csv|txt|ya?ml|toml|env|png|pdf)\b/i.test(t)) out.push('a file name');
  if (/\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b/.test(t)) out.push('an issue id');
  if (/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/.test(t) || /\b\d{8,}\b/.test(t)) out.push('an id or a hash');
  if (/(^|[\s(])#\d+\b/.test(t) || /\bPRs?\s*#?\d+\b/.test(t)) out.push('a PR number');
  if (/\b(?:feat|feature|fix|bug|chore|docs|refactor|hotfix|test|wip|release)\/[\w.-]+/.test(t)) out.push('a branch name');
  if (/(^|\s)--[a-z]/.test(t)) out.push('a command flag');
  if (/\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/.test(t)) out.push('a code name');
  if (DASH_RE.test(t)) out.push('an em or en dash');
  return out;
}

/** Why a card title is not plain ([] = fine): the length, a short "Area: " in
 *  front, and no ids, paths or code. */
export function cardTitleProblems(title, { max = TITLE_MAX } = {}) {
  const t = oneLine(title);
  if (!t) return ['no title'];
  const out = [];
  if (t.length > max) out.push(`${t.length} characters, over ${max}`);
  if (!AREA_RE.test(t)) out.push('no short "Area: " in front');
  if (t.endsWith('…')) out.push('cut off');
  return [...out, ...plainProblems(t)];
}

/** "Area: plain title | one plain sentence" -> { title, sentence, area }. */
export function parseCardLine(text) {
  const t = oneLine(text);
  const bar = t.indexOf(' | ');
  const title = (bar === -1 ? t : t.slice(0, bar)).trim();
  const sentence = bar === -1 ? '' : t.slice(bar + 3).trim();
  const area = /^([^:]{1,25}):\s/.exec(title)?.[1]?.trim() || null;
  return { title, sentence, area };
}

/** A title Linear will take: the plain one when it passes, else clipped. */
function issueTitle(text, max = 120) {
  const t = oneLine(text);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// ── the issue description and its tracker data ────────────────────────────

export const META_HEAD = 'Tracker data (do not edit):';
const META_RE = /```work-meta\n([\s\S]*?)\n```/;
const META_TAIL_RE = /(?:\n*[ \t]*Tracker data \(do not edit\):[ \t]*)+\n+```work-meta\n[\s\S]*?\n```\s*$/;

export function readMeta(description) {
  const m = META_RE.exec(String(description ?? ''));
  if (!m) return {};
  try {
    const v = JSON.parse(m[1]);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** The description with its tracker data block replaced. The key is written
 *  first, so a search for `"key":"<key>"` finds it. */
export function withMeta(description, meta) {
  const body = String(description ?? '').replace(META_TAIL_RE, '').trimEnd();
  const { key, ...rest } = meta || {};
  const json = JSON.stringify(key ? { key, ...rest } : rest);
  return `${body}${body ? '\n\n' : ''}${META_HEAD}\n\n\`\`\`work-meta\n${json}\n\`\`\``;
}

export function renderCard({ what = '', stands = '', details = '' } = {}) {
  const parts = [];
  if (what) parts.push(`**What this is:** ${oneLine(what)}`);
  if (stands) parts.push(`**Where it stands:** ${oneLine(stands)}`);
  if (details) parts.push(`**Details:** ${String(details).trim()}`);
  return parts.join('\n\n');
}

const STANDS_RE = /^\*\*Where it stands:\*\*[^\n]*$/m;
export function withStands(description, text) {
  const d = String(description ?? '');
  const line = `**Where it stands:** ${oneLine(text)}`;
  if (STANDS_RE.test(d)) return d.replace(STANDS_RE, line);
  const meta = META_TAIL_RE.exec(d);
  const body = meta ? d.slice(0, meta.index).trimEnd() : d.trimEnd();
  return `${body}${body ? '\n\n' : ''}${line}${meta ? d.slice(meta.index) : ''}`;
}

export const shortHash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,120}$/;
export const isKey = (s) => KEY_RE.test(String(s ?? ''));
export const isIdentifier = (s) => /^[A-Z][A-Z0-9]{0,6}-\d+$/.test(String(s ?? ''));
export const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

// ── Linear ─────────────────────────────────────────────────────────────────

const FIELDS = 'id identifier title description url createdAt updatedAt archivedAt assignee { id } team { id key } state { id name type } parent { id identifier }';
export const Q = {
  viewer: 'query WorkViewer { viewer { id name } }',
  // Two queries, not one nested: teams x states in one request is over Linear's
  // complexity limit ("Query too complex", measured against the live API).
  teams: 'query WorkTeams { teams(first: 100) { nodes { id key name } } }',
  teamStates: 'query WorkTeamStates($id: String!) { team(id: $id) { id key name states(first: 100) { nodes { id name type } } } }',
  stateCreate: 'mutation WorkStateCreate($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success workflowState { id name type } } }',
  byNeedle: `query WorkByKey($team: ID!, $needle: String!) { issues(first: 10, includeArchived: true, filter: { team: { id: { eq: $team } }, description: { contains: $needle } }) { nodes { ${FIELDS} } } }`,
  issue: `query WorkIssue($id: String!) { issue(id: $id) { ${FIELDS} } }`,
  create: `mutation WorkIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${FIELDS} } } }`,
  update: `mutation WorkIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${FIELDS} } } }`,
  comment: 'mutation WorkComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
  open: `query WorkOpen($team: ID!, $after: String) { issues(first: 100, after: $after, filter: { team: { id: { eq: $team } }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } } }`,
  comments: 'query WorkComments($team: ID!, $since: DateTimeOrDuration!, $after: String) { comments(first: 50, after: $after, filter: { createdAt: { gt: $since }, issue: { team: { id: { eq: $team } } } }) { nodes { id body createdAt user { id name } issue { id identifier title description state { id name type } } } pageInfo { hasNextPage endCursor } } }',
};

/** A refusal is not retried: the op goes to failed/ at once. */
export class Refusal extends Error {}

/** Linear could not be asked (no network, a timeout, 5xx, 429, a key it
 *  refused): the op is not at fault, so it keeps its place and its tries. */
export class Transient extends Error {}

/** gql(query, variables) -> data, over fetch. The key goes in the header only.
 *  An error names the HTTP status and Linear's first message; a failure before
 *  any answer (fetch's own error text can quote the header value) is replaced
 *  by a fixed text, so the key can never travel in an error. */
export function linearTransport({ key, url = LINEAR_URL, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  return async (query, variables = {}) => {
    if (!key) throw new Transient('no usable Linear API key (set LINEAR_API_KEY, or the key alone on one line in the key file)');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: ctl.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw new Transient(`Linear did not answer in ${Math.round(timeoutMs / 1000)} s`);
      const code = String(e?.cause?.code || e?.code || e?.name || 'error').replace(/[^\w.-]/g, '').slice(0, 40);
      throw new Transient(`Linear could not be reached (${code})`);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || body?.errors?.length) {
      const why = oneLine(body?.errors?.[0]?.message || res.statusText || 'error').slice(0, 200);
      const E = res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403 ? Transient : Error;
      throw new E(`Linear ${res.status}: ${why}`);
    }
    return body?.data ?? {};
  };
}

// ── local state ─────────────────────────────────────────────────────────────

export function statePaths(stateDir) {
  return {
    dir: stateDir,
    ids: path.join(stateDir, 'ids.json'),
    keys: path.join(stateDir, 'keys.json'),
    outbox: path.join(stateDir, 'outbox'),
    failed: path.join(stateDir, 'outbox', 'failed'),
    lock: path.join(stateDir, 'drain.lock'),
    cursor: path.join(stateDir, 'comments-cursor.json'),
    ledger: path.join(stateDir, 'comment-ledger.json'),
    pending: path.join(stateDir, 'comments-pending.json'),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

let seq = 0;
/** One op, one file, named so a plain sort is the send order. */
export function enqueue(p, op, now = Date.now()) {
  mkdirSync(p.outbox, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replace(/\D/g, '').slice(0, 14);
  seq = (seq + 1) % 1000;
  const name = `${stamp}-${String(now % 1000).padStart(3, '0')}${String(seq).padStart(3, '0')}-${process.pid}-${op.op}.json`;
  writeJson(path.join(p.outbox, name), { ...op, attempts: 0, queuedAt: new Date(now).toISOString() });
  return name;
}

export function outboxFiles(p) {
  try {
    return readdirSync(p.outbox).filter((f) => /^\d{14}-.*\.json$/.test(f)).sort();
  } catch {
    return [];
  }
}

export function outboxStatus(p) {
  const files = outboxFiles(p);
  let failed = 0;
  try {
    failed = readdirSync(p.failed).filter((f) => f.endsWith('.json')).length;
  } catch {
    failed = 0;
  }
  return { waiting: files.length, failed, files };
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** One holder at a time. The lock file is created whole and atomically (a
 *  hard link of a finished temp file), so nobody ever reads it half written. A
 *  lock older than 10 minutes, or whose pid is gone, is broken, and only after
 *  a second read shows the same holder. Release removes only our own lock. */
export function takeLock(p, lockFile = p.lock) {
  mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const mine = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: crypto.randomBytes(6).toString('hex') });
  const tmp = `${lockFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, mine, { mode: 0o600 });
  try {
    for (let i = 0; i < 2; i++) {
      try {
        linkSync(tmp, lockFile);
        return () => {
          try {
            if (readFileSync(lockFile, 'utf8') === mine) unlinkSync(lockFile);
          } catch {
            /* already gone */
          }
        };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let raw = '';
        try {
          raw = readFileSync(lockFile, 'utf8');
        } catch {
          continue; // released between the two calls: try again
        }
        let held = {};
        try {
          held = JSON.parse(raw);
        } catch {
          held = {};
        }
        const stale = !held.pid || !pidAlive(held.pid) || Date.now() - (held.at || 0) > LOCK_STALE_MS;
        if (!stale) return null;
        try {
          if (readFileSync(lockFile, 'utf8') === raw) unlinkSync(lockFile);
        } catch {
          /* a racing holder took it */
        }
      }
    }
    return null;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
  }
}

// ── the tracker ─────────────────────────────────────────────────────────────

export function createTracker({ gql, paths: p, states = {}, team = '', now = () => Date.now(), log = () => {} }) {
  const names = stateNames(states);
  const ids = () => readJson(p.ids, null);
  const need = () => {
    const v = ids();
    if (!v?.teamId) throw new Transient('not set up yet: run node scripts/work.mjs setup');
    return v;
  };
  const keys = () => readJson(p.keys, {});
  const remember = (key, issue) => {
    const all = keys();
    all[key] = { id: issue.id, identifier: issue.identifier };
    writeJson(p.keys, all);
  };
  const stateId = (role) => {
    const s = need().states?.[role];
    if (!s?.id) throw new Transient(`no "${names[role]}" state saved: run node scripts/work.mjs setup`);
    return s.id;
  };
  const roleOf = (stateName) => {
    const n = String(stateName ?? '').trim().toLowerCase();
    for (const [role, name] of Object.entries(names)) if (name.toLowerCase() === n || role === n) return role;
    return null;
  };

  async function getIssue(ref) {
    const d = await gql(Q.issue, { id: String(ref) });
    return d?.issue || null;
  }

  async function findByKey(key) {
    const known = keys()[key];
    if (known?.id) {
      const hit = await getIssue(known.id).catch(() => null);
      if (hit) return hit;
    }
    const d = await gql(Q.byNeedle, { team: need().teamId, needle: `"${key}"` });
    const hit = (d?.issues?.nodes || []).find((i) => {
      const m = readMeta(i.description);
      return m.key === key || (Array.isArray(m.links) && m.links.includes(key));
    });
    if (hit) remember(key, hit);
    return hit || null;
  }

  async function create({ key, title, description, role, parentId = null, meta = {}, assignToViewer = false }) {
    const v = need();
    const input = { teamId: v.teamId, title: issueTitle(title), description: withMeta(description, { key, ...meta }), stateId: stateId(role) };
    if (parentId) input.parentId = parentId;
    if (assignToViewer && v.viewerId) input.assigneeId = v.viewerId;
    const d = await gql(Q.create, { input });
    const issue = d?.issueCreate?.issue;
    if (!issue) throw new Error('Linear created no issue');
    remember(key, issue);
    return issue;
  }

  async function update(issue, input) {
    const d = await gql(Q.update, { id: issue.id, input });
    return d?.issueUpdate?.issue || issue;
  }

  async function comment(issue, body) {
    const d = await gql(Q.comment, { input: { issueId: issue.id, body: `${MARK} ${String(body).trim()}` } });
    const id = d?.commentCreate?.comment?.id;
    if (id) {
      const ledger = readJson(p.ledger, []);
      writeJson(p.ledger, [...ledger, id].slice(-2000));
    }
    return id;
  }

  async function ensure(spec) {
    return (await findByKey(spec.key)) || create(spec);
  }

  /** The job's card. When its own job op never reached Linear (set aside, or
   *  lost), the start or the report opens it, so neither is ever stranded
   *  behind a missing card. */
  async function jobCard(op, role) {
    return (
      (await findByKey(op.key)) ||
      create({
        key: op.key,
        title: op.title || `Job: ${op.key}`,
        description: renderCard({ what: 'A background job dispatched through the bridge.', stands: `${names[role]}: opened by its ${op.op === 'report' ? 'report' : 'worker start'}.` }),
        role,
        meta: { kind: 'job' },
      })
    );
  }

  // The ops the outbox carries.
  const ops = {
    async job(op) {
      if (op.link) {
        const issue = await getIssue(op.link);
        if (!issue) throw new Refusal(`${op.link} not found`);
        if (issue.team?.id !== need().teamId) throw new Refusal(`${op.link} is not in the tracker's team`);
        const meta = readMeta(issue.description);
        const links = Array.isArray(meta.links) ? meta.links : [];
        if (meta.key !== op.key && !links.includes(op.key)) {
          await update(issue, { description: withMeta(issue.description, { ...meta, links: [...links, op.key].slice(-20) }) });
        }
        remember(op.key, issue);
        return `linked ${issue.identifier}`;
      }
      const have = await findByKey(op.key);
      if (have) return `already ${have.identifier}`;
      const card = op.card ? parseCardLine(op.card) : null;
      const plain = card && card.title && cardTitleProblems(card.title).length === 0;
      const details = [op.title && plain ? `Job: ${oneLine(op.title)}` : '', op.engine ? `Engine: ${op.engine}` : '', op.repo ? `Folder: ${path.basename(String(op.repo))}` : ''].filter(Boolean).join('. ');
      const issue = await create({
        key: op.key,
        title: plain ? card.title : op.title || op.key,
        description: renderCard({ what: card?.sentence || 'A background job dispatched through the bridge.', stands: 'Queued: it starts when a worker slot is free.', details }),
        role: 'queued',
        meta: { kind: 'job' },
      });
      return `created ${issue.identifier}`;
    },
    async 'link-run'(op) {
      const issue = await jobCard(op, 'running');
      const meta = readMeta(issue.description);
      const runs = Array.isArray(meta.runs) ? meta.runs : [];
      const description = withStands(withMeta(issue.description, { ...meta, runs: [...runs.filter((r) => r !== op.run), op.run].slice(-10) }), `Running: worker ${op.run} started ${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
      await update(issue, { stateId: stateId('running'), description });
      return `${issue.identifier} running`;
    },
    async report(op) {
      const job = await jobCard(op, 'queued');
      const finished = op.status === 'finished';
      const parsed = op.remaining || { valid: false, error: 'no report text' };
      // ONE REPORT IS APPLIED ONCE. Its identity (run, status, block) is kept in
      // the card's tracker data, so a replay (a re-sent op, a re-run of the
      // command) neither comments again nor closes a card that was reopened.
      const rid = shortHash(JSON.stringify([op.run || '', op.status || '', parsed]));
      const jmeta = readMeta(job.description);
      const applied = Array.isArray(jmeta.reports) ? jmeta.reports : [];
      if (applied.includes(rid)) return `${job.identifier}: this report was already applied`;
      const markApplied = (description) => withMeta(description, { ...readMeta(description), reports: [...applied, rid].slice(-20) });
      if (!parsed.valid) {
        await update(job, { description: markApplied(job.description) });
        await comment(job, `The report landed (${op.status}) with no valid ## Remaining block: ${parsed.error}. This card stays open for a look.`);
        return `${job.identifier}: no valid block, commented`;
      }
      const made = [];
      const parentId = job.id;
      for (const item of parsed.items.filter((i) => i.kind === 'owed' || i.kind === 'follow-up')) {
        const card = parseCardLine(item.text);
        const kind = item.kind === 'owed' ? 'owed' : 'follow-up';
        const issue = await ensure({
          key: `${op.key}-r-${kind === 'owed' ? '' : 'fu-'}${shortHash(item.text)}`,
          title: card.title,
          description: renderCard({ what: card.sentence || card.title, stands: kind === 'owed' ? 'Queued: owed by a job that did not finish it.' : 'Queued: new work a job found; the chat session decides at the next sweep.' }),
          role: 'queued',
          parentId,
          meta: { kind, from: op.key },
        });
        made.push(issue.identifier);
      }
      const asks = parsed.items.filter((i) => i.kind === 'waiting-owner');
      if (asks.length) {
        const cards = asks.map((a) => parseCardLine(a.text));
        const title = cards.length === 1 ? cards[0].title : `${cards[0].area || 'Job'}: ${cards.length} questions for you`;
        const list = cards.map((c, i) => `${i + 1}. ${c.title}${c.sentence ? ` ${c.sentence}` : ''}`).join('\n');
        const issue = await ensure({
          key: `${op.key}-r-w-${shortHash(asks.map((a) => a.text).join('\n'))}`,
          title,
          description: `${renderCard({ what: cards.length === 1 ? cards[0].sentence || cards[0].title : 'A job needs these answered.', stands: 'Waiting on you: answer with a comment on this card.' })}\n\n${list}`,
          role: 'waiting',
          parentId,
          meta: { kind: 'waiting' },
          assignToViewer: true,
        });
        made.push(issue.identifier);
      }
      if (finished) {
        await update(job, { stateId: stateId('done'), description: markApplied(withStands(job.description, parsed.none ? 'Done: finished with nothing left.' : `Done: finished; its leftovers are ${made.join(', ')}.`)) });
        await comment(job, parsed.none ? `Finished (run ${op.run || 'unknown'}), nothing left.` : `Finished (run ${op.run || 'unknown'}). Leftovers filed: ${made.join(', ')}.`);
        return `${job.identifier} done${made.length ? `, ${made.length} filed` : ''}`;
      }
      await update(job, { description: markApplied(job.description) });
      await comment(job, `The run ended as ${op.status}${made.length ? `; leftovers filed: ${made.join(', ')}` : ''}. This card stays open.`);
      return `${job.identifier} ${op.status}${made.length ? `, ${made.length} filed` : ''}`;
    },
  };

  async function apply(op) {
    const fn = ops[op.op];
    if (!fn) throw new Refusal(`unknown op ${op.op}`);
    return fn(op);
  }

  /** Send the outbox in order within a budget. The list is read again before
   *  every op and once more after the lock is let go, so an op queued while
   *  this drain ran is sent by it, not left for the next one. A Transient
   *  failure (Linear unreachable, a key it refused, not set up yet) stops the
   *  drain and costs the op nothing; any other failure counts one of its 3
   *  tries, and a Refusal sets it aside at once. */
  async function drain({ budgetMs = 20_000 } = {}) {
    const started = now();
    const lines = [];
    let sent = 0;
    let busy = false;
    let stopped = false;
    for (let pass = 0; pass < 3 && !stopped; pass++) {
      const release = takeLock(p);
      if (!release) {
        busy = pass === 0;
        break;
      }
      try {
        for (;;) {
          if (now() - started > budgetMs) {
            stopped = true;
            break;
          }
          const name = outboxFiles(p)[0];
          if (!name) break;
          const file = path.join(p.outbox, name);
          const op = readJson(file, null);
          if (!op) {
            try {
              unlinkSync(file);
            } catch {
              /* gone */
            }
            continue;
          }
          try {
            const said = await apply(op);
            unlinkSync(file);
            sent++;
            lines.push(`${op.op} ${op.key || ''}: ${said}`);
            log(`[work] ${op.op} ${op.key || ''}: ${said}`);
          } catch (e) {
            const why = oneLine(e.message).slice(0, 200);
            if (e instanceof Transient) {
              writeJson(file, { ...op, lastError: why });
              lines.push(`${op.op} ${op.key || ''}: waiting for Linear (${why})`);
              stopped = true;
              break;
            }
            const attempts = (op.attempts || 0) + 1;
            if (e instanceof Refusal || attempts >= MAX_ATTEMPTS) {
              mkdirSync(p.failed, { recursive: true, mode: 0o700 });
              writeJson(path.join(p.failed, name), { ...op, attempts, lastError: why });
              unlinkSync(file);
              lines.push(`${op.op} ${op.key || ''}: set aside after ${attempts} tries (${why}); node scripts/work.mjs retry puts it back`);
              continue;
            }
            writeJson(file, { ...op, attempts, lastError: why });
            lines.push(`${op.op} ${op.key || ''}: not sent yet (${why})`);
            stopped = true; // order matters: a later op may need this one
            break;
          }
        }
      } finally {
        release();
      }
      if (!outboxFiles(p).length) break;
    }
    return { busy, sent, left: outboxFiles(p).length, lines };
  }

  /** Put every set aside op back in the outbox, in its old order, with fresh tries. */
  function retryFailed() {
    let names = [];
    try {
      names = readdirSync(p.failed).filter((f) => f.endsWith('.json')).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const op = readJson(path.join(p.failed, name), null);
      if (op) writeJson(path.join(p.outbox, name), { ...op, attempts: 0 });
      unlinkSync(path.join(p.failed, name));
    }
    return names.length;
  }

  async function openIssues() {
    const v = need();
    const out = [];
    let after = null;
    for (let page = 0; page < 10; page++) {
      const d = await gql(Q.open, { team: v.teamId, after });
      out.push(...(d?.issues?.nodes || []));
      if (!d?.issues?.pageInfo?.hasNextPage) break;
      after = d.issues.pageInfo.endCursor;
    }
    return out;
  }

  /** setup: the team, its states (created when missing unless check), the viewer. */
  async function setup({ check = false } = {}) {
    const viewer = (await gql(Q.viewer))?.viewer;
    if (!viewer?.id) throw new Error('the key did not resolve to a Linear user');
    const all = (await gql(Q.teams))?.teams?.nodes || [];
    const want = String(team).trim().toLowerCase();
    const found = all.find((x) => x.key.toLowerCase() === want) || all.find((x) => x.name.toLowerCase() === want);
    if (!found) throw new Refusal(`no team "${team}" for this key (teams: ${all.map((x) => x.key).join(', ') || 'none'})`);
    const t = (await gql(Q.teamStates, { id: found.id }))?.team || found;
    const have = t.states?.nodes || [];
    const saved = {};
    const missing = [];
    const created = [];
    for (const [role, def] of Object.entries(STATE_ROLES)) {
      const name = names[role];
      const hit = have.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (hit) saved[role] = { id: hit.id, name: hit.name, type: hit.type };
      else if (check) missing.push(name);
      else {
        const d = await gql(Q.stateCreate, { input: { teamId: t.id, name, type: def.type, color: def.color } });
        const s = d?.workflowStateCreate?.workflowState;
        if (!s?.id) throw new Error(`Linear did not create the state "${name}"`);
        saved[role] = { id: s.id, name: s.name, type: s.type };
        created.push(name);
      }
    }
    if (check) return { ok: missing.length === 0, team: t, missing, viewer };
    writeJson(p.ids, { teamId: t.id, teamKey: t.key, teamName: t.name, viewerId: viewer.id, states: saved, setupAt: new Date(now()).toISOString() });
    if (!existsSync(p.cursor)) writeJson(p.cursor, { since: new Date(now()).toISOString() });
    return { ok: true, team: t, created, viewer };
  }

  /** New comments on the tracker's cards since the cursor, by the key's own
   *  user, that the tracker did not post. Each is added to the pending list on
   *  disk BEFORE the cursor moves, and stays there until `comments --done`
   *  says the chat session has acted on it, so a batch that never reached a
   *  turn (a wall, a restart, a second batch behind it) is printed again by the
   *  next run, never lost. A card in "Waiting on you" that got one moves to
   *  "Answered". Returns { added, pending }. */
  async function readComments() {
    const v = need();
    const since = readJson(p.cursor, null)?.since || new Date(now()).toISOString();
    const ledger = new Set(readJson(p.ledger, []));
    const got = [];
    let after = null;
    for (let page = 0; page < 4; page++) {
      const d = await gql(Q.comments, { team: v.teamId, since, after });
      got.push(...(d?.comments?.nodes || []));
      if (!d?.comments?.pageInfo?.hasNextPage) break;
      after = d.comments.pageInfo.endCursor;
    }
    const cursor = got.reduce((m, c) => (c.createdAt > m ? c.createdAt : m), since);
    const pending = readJson(p.pending, []);
    const seen = new Set(pending.map((c) => c.id));
    const fresh = got.filter((c) => c.user?.id && c.user.id === v.viewerId && !ledger.has(c.id) && !seen.has(c.id) && !String(c.body || '').trimStart().startsWith(MARK) && c.issue && isTracked(c.issue));
    const waitingId = v.states?.waiting?.id;
    const moved = new Set();
    for (const c of fresh) {
      if (moved.has(c.issue.id) || !waitingId || c.issue.state?.id !== waitingId || !v.states?.answered?.id) continue;
      try {
        await gql(Q.update, { id: c.issue.id, input: { stateId: v.states.answered.id } });
        moved.add(c.issue.id);
      } catch (e) {
        log(`[work] ${c.issue.identifier} not moved to ${names.answered}: ${oneLine(e.message).slice(0, 120)}`);
      }
    }
    const records = fresh.map((c) => ({ id: c.id, body: String(c.body || ''), createdAt: c.createdAt, card: c.issue.identifier, title: c.issue.title, state: moved.has(c.issue.id) ? names.answered : c.issue.state?.name || '' }));
    const all = [...pending, ...records].sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1)).slice(-200);
    writeJson(p.pending, all);
    writeJson(p.cursor, { since: cursor });
    return { added: records.length, pending: all };
  }

  /** Drop the pending comments the chat session has acted on: every one made at or before `upTo`. */
  function doneComments(upTo) {
    const all = readJson(p.pending, []);
    const left = all.filter((c) => !(c.createdAt <= upTo));
    writeJson(p.pending, left);
    return all.length - left.length;
  }

  return { names, roleOf, getIssue, findByKey, create, update, comment, ensure, apply, drain, retryFailed, openIssues, setup, readComments, doneComments, ids, need, stateId };
}

/** The pending comments as ONE batch for the chat session, or '' when none. */
export function commentsBatch(pending, { ownerName = 'the owner' } = {}) {
  if (!pending?.length) return '';
  const byCard = new Map();
  for (const c of pending) {
    if (!byCard.has(c.card)) byCard.set(c.card, { title: c.title, state: c.state, comments: [] });
    const e = byCard.get(c.card);
    e.state = c.state || e.state;
    e.comments.push(c);
  }
  const upTo = pending.reduce((m, c) => (c.createdAt > m ? c.createdAt : m), '');
  const out = [`[Linear comments by ${ownerName}, ${pending.length} on ${byCard.size} card${byCard.size === 1 ? '' : 's'}]`];
  out.push(`Each is their answer on that card. Act on it, move or comment on the card (node scripts/work.mjs status|comment), then run: node scripts/work.mjs comments --done ${upTo}`);
  out.push('Until then they are shown again on every read, so none is lost.');
  for (const [card, e] of byCard) {
    out.push('', `${card} · ${e.title} (${e.state || 'unknown state'})`);
    for (const c of e.comments) out.push(...c.body.trim().split('\n').map((l) => `> ${l}`));
  }
  return out.join('\n');
}

/** A card the tracker made: its description carries tracker data with a key.
 *  Everything else in the team (a teammate's issue) is not the tracker's. */
export const isTracked = (issue) => Boolean(readMeta(issue?.description).key);

// ── sweep ───────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
export const QUEUED_STALE_HOURS = 2;

/**
 * What needs the chat session, from the open issues and the live worker list
 * (`bg.mjs ps` output, or null when it could not be read). Empty string when
 * nothing does, so a schedule script entry starts no turn.
 */
export function sweepText(allIssues, { names, psText = null, now = Date.now(), lintMax = 10 } = {}) {
  // Only the tracker's own cards: a team can hold a teammate's issues too.
  const issues = allIssues.filter(isTracked);
  const roleName = (i) => String(i.state?.name || '').toLowerCase();
  const is = (i, role) => roleName(i) === String(names[role]).toLowerCase();
  const age = (i) => (now - Date.parse(i.updatedAt || i.createdAt || now)) / HOUR;
  const fmtAge = (h) => (h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
  const row = (i, extra = '') => `- ${i.identifier} · ${i.title}${extra}`;
  const sections = [];

  const answered = issues.filter((i) => is(i, 'answered'));
  if (answered.length) sections.push([`Answered by the owner, your move (${answered.length}):`, ...answered.map((i) => row(i))]);

  const stale = issues.filter((i) => is(i, 'queued') && ['owed', 'follow-up'].includes(readMeta(i.description).kind) && age(i) >= QUEUED_STALE_HOURS);
  if (stale.length) sections.push([`Queued leftovers nobody is on (${stale.length}): dispatch, or move them with a reason:`, ...stale.map((i) => row(i, ` (${readMeta(i.description).kind}, ${fmtAge(age(i))})`))]);

  if (psText != null) {
    const gone = issues.filter((i) => {
      if (!is(i, 'running')) return false;
      const runs = readMeta(i.description).runs || [];
      if (!runs.length) return false;
      return !runs.some((r) => psText.includes(baseRunId(r)));
    });
    if (gone.length) sections.push([`Running with no live worker (${gone.length}): read its report, then close or re-dispatch:`, ...gone.map((i) => row(i))]);
  }

  const parked = issues.filter((i) => readMeta(i.description).kind === 'owed' && String(i.state?.type) === 'backlog');
  if (parked.length) sections.push([`Owed work parked in a backlog state (${parked.length}): owed work is never parked:`, ...parked.map((i) => row(i))]);

  const unplain = issues.filter((i) => cardTitleProblems(i.title).length).slice(0, lintMax);
  if (unplain.length) sections.push([`Titles that do not read plainly on a phone (${unplain.length} shown): rewrite as "Area: plain title":`, ...unplain.map((i) => row(i, ` (${cardTitleProblems(i.title).join(', ')})`))]);

  if (!sections.length) return '';
  return ['Work sweep: what needs you on the Linear board.', ...sections.flatMap((s) => ['', ...s])].join('\n');
}

// ── plan tables ─────────────────────────────────────────────────────────────

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** The rows of the first step table (a column named Step, Slice, # or Id, and
 *  one named Title, What or Task) in the section whose heading contains
 *  `section`, or in the whole file. */
export function parsePlan(markdown, { section = null } = {}) {
  let lines = String(markdown ?? '').split(/\r?\n/);
  if (section) {
    const want = String(section).toLowerCase();
    const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.toLowerCase().includes(want));
    if (start === -1) return { rows: [], error: `no heading containing "${section}"` };
    const level = /^(#+)/.exec(lines[start])[1].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (new RegExp(`^#{1,${level}}\\s`).test(lines[i])) {
      end = i;
      break;
    }
    lines = lines.slice(start + 1, end);
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const head = splitRow(lines[i]).map((h) => h.toLowerCase());
    const idCol = head.findIndex((h) => ['step', 'slice', '#', 'id'].includes(h));
    const titleCol = head.findIndex((h) => ['title', 'what', 'task'].includes(h));
    if (idCol === -1 || titleCol === -1) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) {
      const cells = splitRow(lines[j]);
      if (cells[idCol] && cells[titleCol]) rows.push({ step: cells[idCol], title: cells[titleCol] });
    }
    return { rows, error: rows.length ? null : 'the step table has no rows' };
  }
  return { rows: [], error: 'no table with a Step (or Slice, #, Id) column and a Title (or What, Task) column' };
}

// ── the CLI ─────────────────────────────────────────────────────────────────

const BOOL = new Set(['--check', '--json', '--stdin', '--again', '--dry-run']);
export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL.has(a)) flags[a.slice(2)] = true;
    else if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

const USAGE = 'usage: node scripts/work.mjs setup [--check] | open | status <ID> <state> [--comment why] | comment <ID> text | lint | sweep | comments [--again | --done <time>] | plan <file> [--section heading] | drain | retry | outbox';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** The key, or '' when there is none usable. Only one line of printable
 *  characters with no space is a key: anything else (a comment line above it,
 *  two keys) would reach fetch as a header value fetch refuses, and its error
 *  text quotes the value. */
function readKey(settings, env) {
  let raw = String(env.LINEAR_API_KEY || '').trim();
  if (!raw) {
    try {
      raw = readFileSync(settings.keyFile, 'utf8').trim();
    } catch {
      raw = '';
    }
  }
  return /^[\x21-\x7e]{8,256}$/.test(raw) ? raw : '';
}

function psOutput(root, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    try {
      execFile(process.execPath, [path.join(root, 'bg.mjs'), 'ps'], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch {
      resolve(null);
    }
  });
}

/**
 * main(argv, deps) -> exit code. deps lets a test hand in the settings, the
 * transport, the clock and the ps text, so no test reaches the network.
 */
export async function main(argv, { env = process.env, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), settings = undefined, gql = undefined, now = () => Date.now(), stdin = readStdin, ps = undefined, root = ROOT } = {}) {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos[0];
  if (!cmd || cmd === 'help' || flags.help !== undefined) {
    (cmd ? out : err)(USAGE);
    return cmd ? 0 : 2;
  }
  const s = settings === undefined ? workTrackerSettings({ config: readBridgeConfig(env, root), env, root }) : settings;
  if (!s) {
    err('work tracker is off: set workTracker.team in config.json and a Linear key (LINEAR_API_KEY or the key file). See README, "Track jobs in Linear".');
    return cmd === 'outbox' || cmd === 'drain' ? 0 : 1;
  }
  const p = statePaths(s.stateDir);
  const transport = gql || linearTransport({ key: readKey(s, env) });
  const t = createTracker({ gql: transport, paths: p, states: s.states, team: s.team, now, log: (m) => err(m) });
  const drainMs = flags['drain-ms'] !== undefined ? Number(flags['drain-ms']) : 20_000;
  const queueAndSend = async (op) => {
    enqueue(p, op, now());
    if (!(drainMs > 0)) {
      out(`queued for Linear, not sent yet (${outboxFiles(p).length} waiting)`);
      return 0;
    }
    const r = await t.drain({ budgetMs: drainMs });
    if (r.busy) out(`queued; another drain is sending (${r.left} waiting)`);
    else out(r.lines.length ? r.lines[r.lines.length - 1] : `nothing sent (${r.left} waiting)`);
    return 0;
  };

  try {
    switch (cmd) {
      case 'setup': {
        const r = await t.setup({ check: Boolean(flags.check) });
        if (flags.check) {
          out(r.ok ? `team ${r.team.key} (${r.team.name}): every state is there` : `team ${r.team.key}: missing states ${r.missing.join(', ')} (run setup without --check to create them)`);
          return r.ok ? 0 : 1;
        }
        out(`team ${r.team.key} (${r.team.name}) ready${r.created.length ? `; created ${r.created.join(', ')}` : ''}; ids saved to ${p.ids}`);
        return 0;
      }
      case 'job': {
        if (!isKey(flags.key)) return (err('job needs --key <work key>'), 2);
        return queueAndSend({ op: 'job', key: flags.key, title: oneLine(flags.title || '').slice(0, 200), card: flags.card ? oneLine(flags.card).slice(0, 400) : null, link: isIdentifier(flags.link) ? flags.link : null, engine: flags.engine || null, repo: flags.repo || null });
      }
      case 'link-run': {
        if (!isKey(flags.key) || !flags.run) return (err('link-run needs --key and --run'), 2);
        return queueAndSend({ op: 'link-run', key: flags.key, run: String(flags.run).slice(0, 120), title: flags.title ? oneLine(flags.title).slice(0, 200) : null });
      }
      case 'report': {
        if (!isKey(flags.key)) return (err('report needs --key'), 2);
        const text = flags.stdin ? stdin() : flags.file && existsSync(flags.file) ? readFileSync(flags.file, 'utf8') : '';
        // Only the parsed block is kept and sent; the report text stays here.
        return queueAndSend({ op: 'report', key: flags.key, run: String(flags.run || '').slice(0, 120), status: String(flags.status || 'finished'), title: flags.title ? oneLine(flags.title).slice(0, 200) : null, remaining: parseRemaining(text) });
      }
      case 'unqueue': {
        // bg.mjs, when the drop box write failed: the job op it queued (and has
        // not sent) is removed, so no issue is opened for a job that never ran.
        if (!isKey(flags.key)) return (err('unqueue needs --key'), 2);
        let removed = 0;
        for (const name of outboxFiles(p)) {
          const op = readJson(path.join(p.outbox, name), null);
          if (op?.op === 'job' && op.key === flags.key) {
            unlinkSync(path.join(p.outbox, name));
            removed++;
          }
        }
        out(`removed ${removed} queued op${removed === 1 ? '' : 's'} for ${flags.key}`);
        return 0;
      }
      case 'drain': {
        const r = await t.drain({ budgetMs: flags['budget-ms'] !== undefined ? Number(flags['budget-ms']) : 30_000 });
        for (const l of r.lines) out(l);
        out(r.busy ? `another drain is running (${r.left} waiting)` : `sent ${r.sent}, ${r.left} waiting`);
        return 0;
      }
      case 'outbox': {
        const st = outboxStatus(p);
        for (const f of st.files) out(f);
        out(`${st.waiting} waiting, ${st.failed} set aside${st.waiting ? ' (node scripts/work.mjs drain sends them)' : ''}${st.failed ? ' (node scripts/work.mjs retry puts the set aside ones back)' : ''}`);
        return 0;
      }
      case 'open': {
        const issues = await t.openIssues();
        if (flags.json) out(JSON.stringify(issues.map((i) => ({ id: i.identifier, state: i.state?.name, title: i.title, updatedAt: i.updatedAt, url: i.url }))));
        else {
          for (const i of issues) out(`${i.identifier}\t${i.state?.name}\t${Math.round((now() - Date.parse(i.updatedAt || i.createdAt)) / HOUR)}h\t${i.title}`);
          out(`${issues.length} open`);
        }
        return 0;
      }
      case 'status': {
        const [, ref, ...rest] = pos;
        const stateName = rest.join(' ');
        if (!ref || !stateName) return (err('usage: status <ID> <state> [--comment "why"]'), 2);
        const issue = await t.getIssue(ref);
        if (!issue) return (err(`${ref} not found`), 1);
        if (issue.team?.id !== t.need().teamId) return (err(`${ref} is not in the tracker's team`), 2);
        const meta = readMeta(issue.description);
        if (/^backlog$/i.test(stateName) && meta.kind === 'owed') {
          err(`${issue.identifier} is owed work, and owed work is never parked in Backlog. Move it to ${t.names.queued}, ${t.names.waiting} (a question for the owner), ${t.names.blocked} (with --comment naming the blocker), ${t.names.done} or ${t.names.canceled} (with the reason).`);
          return 2;
        }
        const role = t.roleOf(stateName);
        if (role === 'blocked' && !flags.comment) return (err(`${t.names.blocked} needs --comment naming what blocks it`), 2);
        let stateId;
        if (role) stateId = t.stateId(role);
        else {
          const d = await transport(Q.teamStates, { id: t.need().teamId });
          const hit = (d?.team?.states?.nodes || []).find((x) => x.name.toLowerCase() === stateName.toLowerCase());
          if (!hit) return (err(`no state "${stateName}" in the team`), 2);
          stateId = hit.id;
        }
        const input = { stateId };
        const leaving = issue.assignee?.id && [t.names.waiting, t.names.answered].map((x) => x.toLowerCase()).includes(String(issue.state?.name).toLowerCase()) && !['waiting', 'answered'].includes(role);
        if (leaving) input.assigneeId = null;
        if (flags.comment) input.description = withStands(issue.description, `${role ? t.names[role] : stateName}: ${flags.comment}`);
        const after = await t.update(issue, input);
        if (flags.comment) await t.comment(issue, flags.comment);
        out(`${issue.identifier} → ${after.state?.name || stateName}`);
        return 0;
      }
      case 'comment': {
        const [, ref, ...words] = pos;
        const body = words.join(' ').trim();
        if (!ref || !body) return (err('usage: comment <ID> "text"'), 2);
        const issue = await t.getIssue(ref);
        if (!issue) return (err(`${ref} not found`), 1);
        await t.comment(issue, body);
        out(`commented on ${issue.identifier}`);
        return 0;
      }
      case 'lint': {
        const issues = (await t.openIssues()).filter(isTracked);
        const bad = issues.map((i) => ({ id: i.identifier, title: i.title, problems: cardTitleProblems(i.title) })).filter((x) => x.problems.length);
        if (flags.json) out(JSON.stringify({ open: issues.length, readable: issues.length - bad.length, bad }));
        else {
          for (const b of bad) out(`${b.id}\t${b.title}\t(${b.problems.join(', ')})`);
          out(`${issues.length - bad.length} of ${issues.length} readable`);
        }
        return 0;
      }
      case 'sweep': {
        await t.drain({ budgetMs: 15_000 });
        const issues = await t.openIssues();
        const psText = ps === undefined ? await psOutput(root) : ps;
        const text = sweepText(issues, { names: t.names, psText, now: now() });
        if (text) out(text);
        return 0;
      }
      case 'comments': {
        const ownerName = String(readBridgeConfig(env, root).ownerName || 'the owner');
        if (flags.done !== undefined) {
          if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(flags.done))) return (err('usage: comments --done <the time the batch names>'), 2);
          out(`${t.doneComments(String(flags.done))} comment(s) marked read`);
          return 0;
        }
        if (flags.again) {
          const text = commentsBatch(readJson(p.pending, []), { ownerName });
          if (text) out(text);
          return 0;
        }
        const release = takeLock(p, path.join(p.dir, 'comments.lock'));
        if (!release) return (err('another comments run holds the lock'), 3);
        try {
          // Read first; when Linear cannot be asked, the comments already
          // pending are still printed, so a slow Linear never hides an answer.
          let pending;
          try {
            pending = (await t.readComments()).pending;
          } catch (e) {
            pending = readJson(p.pending, []);
            if (!pending.length) throw e;
            err(`work: new comments not read (${oneLine(e.message).slice(0, 160)}); the pending ones follow`);
          }
          const text = commentsBatch(pending, { ownerName });
          if (text) out(text);
          return 0;
        } finally {
          release();
        }
      }
      case 'retry': {
        out(`${t.retryFailed()} set aside op(s) back in the outbox`);
        const r = await t.drain({ budgetMs: 30_000 });
        out(`sent ${r.sent}, ${r.left} waiting`);
        return 0;
      }
      case 'plan': {
        const file = pos[1];
        if (!file || !existsSync(file)) return (err('usage: plan <PLAN.md> [--section heading]'), 2);
        const { rows, error } = parsePlan(readFileSync(file, 'utf8'), { section: flags.section || null });
        if (error) return (err(`plan: ${error}`), 2);
        const planName = path.basename(file).replace(/\.[^.]+$/, '');
        const area = flags.area || planName.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()).slice(0, 24);
        let made = 0;
        for (const r of rows) {
          const key = `plan-${slug(planName)}-${slug(r.step)}`;
          if (flags['dry-run']) {
            out(`${key}\t${area}: ${r.title}`);
            continue;
          }
          const issue = await t.ensure({ key, title: `${area}: ${r.title}`, description: renderCard({ what: r.title, stands: 'Queued: a step of an approved plan.', details: `Step ${r.step} of ${path.basename(file)}` }), role: 'queued', meta: { kind: 'owed', plan: planName, step: r.step } });
          out(`${r.step}\t${issue.identifier}\t${issue.title}`);
          made++;
        }
        if (!flags['dry-run']) out(`${made} plan step${made === 1 ? '' : 's'} tracked`);
        return 0;
      }
      default:
        err(USAGE);
        return 2;
    }
  } catch (e) {
    err(`work: ${oneLine(e.message).slice(0, 300)}`);
    return e instanceof Refusal ? 2 : 1;
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`work: ${e?.message || e}\n`);
      process.exit(1);
    },
  );
}
