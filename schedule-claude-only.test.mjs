#!/usr/bin/env node
// A schedule entry that needs Claude waits for Claude.
//
// While every Claude account is limited, a `--run` entry goes to Codex. A job
// that needs Claude tools fails there, and a nightly job can lose its night that
// way. `schedule.mjs update <id> --claude-only true` makes an entry wait instead.
//
// The REAL functions out of bridge.mjs, through one poll cycle in the order the
// poll loop runs them, over a real drop box, a real hold file and a real write
// grant store on temp files. The engine is the REAL resolveEngine, and dispatch
// is the REAL dispatchPrompt, because that is where a due entry met the wall.
// Stubbed: what starts a process (it records the engine it was given),
// startResolvedRun, Telegram, the schedule store (in memory) and the admission
// load and usage inputs. Scripts run for real. The wall notice machinery is
// stubbed in sections 1 to 7, which read what raiseHoldNotice hands it, and REAL
// in section 8, which is about the words on screen.
//
// CLAUDE_ONLY_DIR=<an export of the commit before> runs these same tests against
// that code. The helpers it lacks become no-ops, so what fails there is an
// assertion about where the job went, not a missing name:
//
//   git archive 5486703 | tar -x -C /tmp/base
//   cp schedule-due.mjs schedule-script.mjs /tmp/base
//   CLAUDE_ONLY_DIR=/tmp/base node schedule-claude-only.test.mjs   # red
//
// Never `import('./bridge.mjs')`: that boots a second daemon (2026-09-05).
//
//   node schedule-claude-only.test.mjs

import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.CLAUDE_ONLY_DIR ? path.resolve(process.env.CLAUDE_ONLY_DIR) : HERE;
const TMP = mkdtempSync(path.join(tmpdir(), 'claude-only-'));
const QUEUE = path.join(TMP, 'bg-queue.json');
const HELD = path.join(TMP, 'bg-held.json');

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
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg}\n    got:  ${g}\n    want: ${w}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^(?:const|let) ${name}\\b`);
  const start = SRC.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  if (kind !== 'function' && /;\s*$/.test(SRC[start])) return SRC[start];
  const out = [SRC[start]];
  for (let i = start + 1; i < SRC.length; i++) {
    const l = SRC[i];
    if (/^\S/.test(l)) {
      if (l.startsWith('}') || l.startsWith('};')) out.push(l);
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}
// The names this feature adds, as no-ops on code that does not have them.
const grabOr = (name, fallback, kind = 'function') => {
  try {
    return grab(name, kind);
  } catch {
    return fallback;
  }
};

const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);
const engineUrl = url('engine-state.mjs');

// The wall notice machinery, both ways. The stubs record what raiseHoldNotice
// hands them. The real pieces need only what the notice reads around them.
const WALL_STUBS = `
export const WALLS = [];
export const wallOpts = {};
const raiseWall = (kind, opts) => { WALLS.push(kind); wallOpts[kind] = opts; return Promise.resolve(); };
export const WALL_NOTICES = [];
const raiseClaudeWall = () => { WALL_NOTICES.push(Date.now()); return Promise.resolve(); };
export const SETTLED = [];
const pendWallResolution = (kind) => kind in wallOpts;
const settleWall = (kind, extra = {}) => { SETTLED.push({ kind, ...extra }); };
const bothEnginesWalledLine = () => '';
`;
const WALL_REAL = `
const { WALL_TICK_MS, limitWallLine, limitWallResolved, bothWalledLine } = SYSTEM_MESSAGES;
const editCooldownUntil = 0;
const accounts = { describe: () => (rotationPausedUntil > Date.now() ? [{ name: 'one', limited: true, limitedUntil: Math.floor(rotationPausedUntil / 1000), captured: true }] : []) };
const wallWake = { pending: () => false, current: () => null };
const pickNextAccount = () => null;
const parkedCodexChats = [];
`;

// `boot` makes every evaluation a fresh module: a daemon restart is a new one
// over the same files.
const HARNESS = (boot, realWall) => `
// boot ${boot}
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mergeRequeue, admissionVerdict, loadGate, queueRows, queuedBlock, admissionRows, admissionLine, usageHold } from ${url('bg-admission.mjs')};
import { parseEnginePrefix, fmtUntil } from ${url('bg-codex.mjs')};
import { fmtLeft } from ${url('usage-limits.mjs')};
import { briefTitle, stripLaneRules, waitingLine } from ${url('bg-notify.mjs')};
import { createBgWaitStore, waitKey } from ${url('bg-wait.mjs')};
import { createWriteGrantStore } from ${url('write-grant.mjs')};
import { describeWhen, isDailyDue, isHoursDue, latestHoursSlot } from ${url('schedule-due.mjs')};
import { scheduledScriptPrompt, scriptCommand, SCRIPT_TIMEOUT_MS } from ${url('schedule-script.mjs')};
import { resolveEngine } from ${engineUrl};
import { clip, oneLine } from ${url('progress-render.mjs')};
import * as SYSTEM_MESSAGES from ${url('system-messages.mjs')};
const claudeOnlyHeldLine = SYSTEM_MESSAGES.claudeOnlyHeldLine || (() => '');
const scheduledScriptFailedLine = SYSTEM_MESSAGES.scheduledScriptFailedLine || (() => '');
const { readFileSync, renameSync, existsSync, statSync } = fs;
export let FAIL_HOLD_WRITE = false;
export const setFailHoldWrite = (v) => { FAIL_HOLD_WRITE = v; };
const writeFileSync = (p, text) => {
  if (FAIL_HOLD_WRITE && String(p).includes('bg-held')) throw new Error('disk full');
  return fs.writeFileSync(p, text);
};

const BG_QUEUE_FILE = ${JSON.stringify(QUEUE)};
const BG_HELD_FILE = ${JSON.stringify(HELD)};
const SCHEDULES_FILE = ${JSON.stringify(path.join(TMP, 'schedules.json'))};
export let MAX_CONCURRENT_WORKERS = 3;
export const setCap = (n) => { MAX_CONCURRENT_WORKERS = n; };

// THE WALL, set by the test and read by the real resolveEngine through the real
// shape of engineFor. rotationPausedUntil is the daemon's own name for it.
let rotationPausedUntil = 0;
let codexPausedUntil = 0;
let CLAUDE_AVAILABLE = true;
let CODEX_AVAILABLE = true;
export const setWall = (until) => { rotationPausedUntil = until; };
export const setClaudeInstalled = (v) => { CLAUDE_AVAILABLE = v; };
export const setCodexInstalled = (v) => { CODEX_AVAILABLE = v; };
export const setCodexWall = (until) => { codexPausedUntil = until; };
let CHAT = { cwd: ${JSON.stringify(TMP)} };
export const setBgEngine = (v) => { CHAT = { ...CHAT, engineBg: v }; };
const chatState = () => CHAT;
const fileConfig = {};
const ENGINE_CONFIG = fileConfig;
let FALLBACK = true;
export const setFallback = (v) => { FALLBACK = v; };
const codexFallbackOn = () => FALLBACK;
const codexWalled = (now = Date.now()) => codexPausedUntil > now;
const claudeWalled = (now = Date.now()) => !CLAUDE_AVAILABLE || rotationPausedUntil > now;
const claudeRateWalled = (now = Date.now()) => CLAUDE_AVAILABLE && rotationPausedUntil > now;
const codexTakingChat = () => CODEX_AVAILABLE && !codexWalled();

// WHAT STARTED, and on which engine. The two ends of the path are the only stubs.
export const STARTS = [];
export const SENT = [];
export const RESULTS = [];
export const bgLanes = [];
let laneSeq = 0;
const newLane = () => { laneSeq++; const lane = { name: 'bg' + laneSeq, isBg: true, n: laneSeq, current: null, queue: [], finishing: 0, priorityCount: 0 }; bgLanes.push(lane); return lane; };
const getBgLane = () => bgLanes.find((l) => !l.current && !l.queue.length) || newLane();
export const finishWorkers = () => { for (const l of bgLanes) l.current = null; };
export const occupy = (n) => { for (let i = 0; i < n; i++) newLane().current = { startedAt: Date.now() + i, steps: 0 }; };
function bgWorkerDescriptors() {
  return bgLanes.filter((l) => l.isBg && l.current).map((l) => ({ runId: l.name + '-' + l.current.startedAt, lane: l.name, engine: 'claude' }));
}
const startResolvedRun = (decision, lane, item) => {
  if (decision.engine !== 'codex') return 'fallthrough';
  STARTS.push({ engine: 'codex', text: item.text, schedule: item.schedule, reason: decision.reason });
  return 'started';
};
const runClaude = (text, lane, opts = {}) => {
  STARTS.push({ engine: 'claude', text, schedule: opts.schedule });
  lane.current = { startedAt: Date.now(), steps: 0 };
  return Promise.resolve();
};
const deliverWithoutClaude = () => {};
const takeHandoffPrefix = () => '';
const startCodexJob = (text, opts) => { STARTS.push({ engine: 'codex', text, schedule: opts.schedule, reason: opts.reason }); return { runId: 'codex-' + STARTS.length, transport: 'exec', startedAt: Date.now() }; };

export const LANES = { main: { name: 'main', queue: [], current: null } };
const pickLane = () => LANES.main;
const send = (text) => { SENT.push(text); return Promise.resolve({ message_id: SENT.length }); };
export const EDITS = [];
const editProgress = (id, html, plain) => { EDITS.push({ id, text: typeof plain === 'function' ? plain() : html }); return Promise.resolve(); };
const escHtml = (s) => String(s);
const keepHandback = () => {};
${realWall ? WALL_REAL : WALL_STUBS}
const armWallResume = () => {};
const logAccountDecision = () => {};
const holdFullLine = () => 'hold full';
const enginesBackLine = SYSTEM_MESSAGES.enginesBackLine;
const QUEUE_MAX = 5;
const PARKED_WALLED_MAX = 5;
export const parkedWalledChats = [];
const netOutage = () => ({ noteChild: () => {} });
const admissionNow = () => ({ load: null, usage: null, fanout: null, now: Date.now(), fmtClock: (ms) => new Date(ms).toISOString().slice(11, 16) });
const bgWait = createBgWaitStore({ file: ${JSON.stringify(path.join(TMP, 'bg-wait.json'))} });
export const writeGrants = createWriteGrantStore({ file: ${JSON.stringify(path.join(TMP, 'write-grants.json'))} });
const recordBgResult = (task, outcome) => { RESULTS.push({ task, outcome }); };
const wallGuard = { jobOf: () => null };
const noteWallGuardJob = () => {};
const claudeMissingLine = () => 'no claude on this machine';
const CODEX_MISSING_LINE = 'no codex';
export const codexRuns = new Map();
const briefRepo = () => 'repo';
const codexCwdForBrief = () => ${JSON.stringify(TMP)};
const lintCodexBrief = () => [];
const startWorkerNotice = () => Promise.resolve();
const codexReasonText = () => '';
const codexCardSettings = () => ({});
const CODEX_LANE = 'codex';
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const OWNER_TZ = 'America/Toronto';
const OWNER_NAME = 'the owner';
const BG_MODEL = 'opus';
const DEFAULT_EFFORT = 'high';

export let SCHEDULES = { nextId: 1, items: [] };
export const setSchedules = (items) => { SCHEDULES = { nextId: 400, items }; };
export const schedules = () => SCHEDULES;
const loadSchedules = () => JSON.parse(JSON.stringify(SCHEDULES));
const saveSchedules = (v) => { SCHEDULES = v; };
export let TODAY = '2026-11-06';
export let HHMM = '03:00';
export const setClock = (day, hhmm = '03:00') => { TODAY = day; HHMM = hhmm; };
const localToday = () => TODAY;
const localHHMM = () => HHMM;
`;

const FUNCTIONS = [
  grab('bgStrandedJobs', 'let'),
  grab('PARKED_WALLED_JOBS_MAX', 'const'),
  grab('BG_WAIT_EDIT_MS', 'const'),
  grab('BG_COMMAND_RE', 'const'),
  grab('runningBgWorkers'),
  grab('runningResumedWorkers'),
  grab('requeueDeferredBgJobs'),
  grab('bridgeJobsRunning'),
  grab('noteBgWaiting'),
  grab('takeBgWaiting'),
  grab('readHeldBgJobs'),
  grab('writeHeldBgJobs'),
  grab('holdBgJob'),
  grab('canRunHeldItem'),
  grabOr('heldItem', 'function heldItem(it) { return it; }'),
  grabOr('heldWaitsOn', "function heldWaitsOn() { return 'claude'; }"),
  grab('flushParkedWalledJobs'),
  grab('engineFor'),
  grab('unchosenCodex', 'const'),
  grab('engineForItem'),
  grab('queueItem'),
  grab('dispatchPrompt'),
  grab('drainBgHandoff'),
  grab('scheduleApprovesWrites'),
  grab('queueScheduledRun'),
  grab('checkSchedules'),
  grab('fmtSchedule'),
  grabOr('CLAUDE_ONLY_HOLD_NOTICE_MS', 'const CLAUDE_ONLY_HOLD_NOTICE_MS = 0;', 'const'),
  grabOr('tellLongClaudeOnlyHolds', 'function tellLongClaudeOnlyHolds() {}'),
  grabOr('raiseHoldNotice', 'function raiseHoldNotice() { return raiseClaudeWall(); }'),
  grabOr('scheduleJobWaiting', 'function scheduleJobWaiting() { return false; }'),
  grabOr('runScheduledScript', 'function runScheduledScript() {}'),
  grabOr('scriptFailureTold', 'const scriptFailureTold = new Set();', 'const'),
  grabOr('tellScriptFailed', 'function tellScriptFailed() {}'),
];
const EXPORTS = 'export { drainBgHandoff, checkSchedules, flushParkedWalledJobs, tellLongClaudeOnlyHolds, readHeldBgJobs, fmtSchedule, resolveEngine, fmtUntil, dispatchPrompt };';
// Section 8's real notice functions, and the sweep that ticks them.
const WALL_FUNCTIONS = [
  grab('liveMessages', 'const'),
  grab('wallNotices', 'const'),
  grab('registerLive'),
  grab('tickLiveMessages'),
  grab('raiseWall'),
  grab('pendWallResolution'),
  grab('settleWall'),
  grab('claudeWallFacts'),
  grab('raiseClaudeWall'),
  grab('bothEnginesWalledLine'),
  grab('flushParkedWalledChats'),
];
const WALL_EXPORTS = 'export { liveMessages, tickLiveMessages, raiseClaudeWall, flushParkedWalledChats };';

let bootCount = 0;
const load = ({ realWall = false } = {}) =>
  import('data:text/javascript,' + encodeURIComponent([HARNESS(++bootCount, realWall), ...FUNCTIONS, ...(realWall ? [...WALL_FUNCTIONS, WALL_EXPORTS] : []), EXPORTS].join('\n')));
let B = await load();

// One poll cycle, in the poll loop's order. Section 7 reads that order off the
// real pollLoop, so this cannot quietly drift from it.
const poll = (now = Date.now()) => {
  B.checkSchedules();
  B.flushParkedWalledJobs();
  B.tellLongClaudeOnlyHolds(now);
  B.drainBgHandoff();
};
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []);
const queue = () => readJson(QUEUE);
const held = () => readJson(HELD);
const codexStarts = () => B.STARTS.filter((s) => s.engine === 'codex');
const claudeStarts = () => B.STARTS.filter((s) => s.engine === 'claude');
const FUTURE = () => Date.now() + 5 * 3600_000;
const SIX_HOURS = 6 * 3600_000;

const entry = (extra = {}) => ({ id: 8, kind: 'daily', at: '03:00', run: true, text: 'Nightly repo review.', lastFired: '2026-11-05', ...extra });

const fresh = async ({ wall = 0, entries = [entry({ claudeOnly: true })], cap = 3, realWall = false } = {}) => {
  rmSync(QUEUE, { force: true });
  rmSync(HELD, { force: true });
  B = await load({ realWall });
  B.setCap(cap);
  B.setWall(wall);
  B.setClock('2026-11-06');
  B.setSchedules(entries);
};

// ---------------------------------------------------------------------------
console.log('\n1. a due claudeOnly entry is held, and no Codex job starts');
// ---------------------------------------------------------------------------

await fresh({ wall: FUTURE() });
poll();
t('every Claude account walled: no Codex job started', () => eq(codexStarts().length, 0, JSON.stringify(B.STARTS.map((s) => s.engine))));
t('and no Claude job either: there is no account to run it on', () => eq(claudeStarts().length, 0));
t('the job is in the hold file, pinned to Claude', () => {
  eq(held().length, 1);
  eq(held()[0].scheduleId, 8);
  eq(held()[0].engine, 'claude');
});
t('the drop box is empty: the hold is the one place it waits', () => eq(queue().length, 0));
t('the wall notice was raised, so the hold is counted on screen', () => ok(B.WALL_NOTICES.length >= 1, 'no wall notice'));
t('the entry is stamped: it does not re-fire on the next poll', () => {
  eq(B.schedules().items[0].lastFired, '2026-11-06');
  poll();
  eq(held().length, 1);
});

await fresh({ wall: FUTURE() });
B.setBgEngine('codex');
poll();
t('a bg lane set to Codex does not take it either', () => {
  eq(codexStarts().length, 0);
  eq(held().length, 1);
});

await fresh({ wall: 0, cap: 2 });
B.occupy(2);
poll();
t('queued behind the cap with no wall: waiting in the drop box, pinned', () => {
  eq(queue().length, 1);
  eq(queue()[0].engine, 'claude');
  eq(B.STARTS.length, 0);
});
B.setWall(FUTURE());
B.finishWorkers();
poll();
t('the wall comes up before it starts: held, not sent to Codex', () => {
  eq(codexStarts().length, 0);
  eq(held().length, 1);
});

await fresh({ wall: 0 });
B.setBgEngine('codex');
poll();
t('no wall and a bg lane set to Codex: it still runs on Claude', () => {
  eq(codexStarts().length, 0);
  eq(claudeStarts().length, 1);
  eq(claudeStarts()[0].text, 'Nightly repo review.', 'the routing prefix must not reach the prompt');
  eq(claudeStarts()[0].schedule?.id, 8, 'the scheduled run mark survives');
});

// ---------------------------------------------------------------------------
console.log('\n2. it runs exactly once when a Claude account is free');
// ---------------------------------------------------------------------------

await fresh({ wall: FUTURE() });
poll();
B.setWall(0);
poll();
t('the wall lifts: one Claude run, none on Codex', () => {
  eq(claudeStarts().length, 1);
  eq(codexStarts().length, 0);
});
t('the run keeps its scheduled run mark', () => eq(claudeStarts()[0].schedule?.id, 8));
t('nothing is left waiting', () => {
  eq(held().length, 0);
  eq(queue().length, 0);
});
poll();
poll();
t('later polls start nothing more', () => eq(B.STARTS.length, 1));

await fresh({ wall: FUTURE() });
poll();
for (const day of ['2026-11-07', '2026-11-08', '2026-11-09']) {
  B.setClock(day);
  poll();
}
t('three more days behind the wall: still one job waiting', () => {
  eq(held().length, 1);
  eq(queue().length, 0);
  eq(B.STARTS.length, 0);
});
t('each missed day is stamped, so nothing is owed when the wall lifts', () => eq(B.schedules().items[0].lastFired, '2026-11-09'));
B.setWall(0);
poll();
poll();
t('the lift after three missed days: exactly one run', () => {
  eq(claudeStarts().length, 1);
  eq(codexStarts().length, 0);
});
B.finishWorkers();
B.setClock('2026-11-10');
poll();
t('the next day after the lift fires as normal', () => eq(claudeStarts().length, 2));

await fresh({ wall: FUTURE() });
poll();
B = await load(); // a fresh daemon over the same files; the hold is a file
B.setCap(3);
B.setWall(FUTURE()); // by hand: a restart forgets the wall, the next test shows that
B.setClock('2026-11-07');
B.setSchedules([entry({ claudeOnly: true, lastFired: '2026-11-06' })]);
poll();
t('a fresh daemon with the wall up again: the once-only check reads the hold off disk', () => eq(held().length, 1));
B.setWall(0);
poll();
t('and the lift runs it once', () => eq(claudeStarts().length, 1));

// A REAL RESTART: nothing sets the wall, because nothing does. The wall is in
// memory, so the first poll releases the job. The brief survives; the wait does
// not. Pinned so the README's sentence about it stays true.
await fresh({ wall: FUTURE() });
poll();
t('before the restart the job is held', () => eq(held().length, 1));
B = await load();
B.setCap(3);
B.setClock('2026-11-06');
B.setSchedules([entry({ claudeOnly: true, lastFired: '2026-11-06' })]);
poll();
t('a restart forgets the wall: the first poll starts the job, on Claude, not Codex', () => {
  eq(held().length, 0);
  eq(claudeStarts().length, 1);
  eq(codexStarts().length, 0);
});

await fresh({ wall: 0, cap: 1 });
B.occupy(1);
poll();
B.setClock('2026-11-07');
poll();
t('still queued behind the cap the next day: one job, not two', () => eq(queue().length, 1));

await fresh({ wall: FUTURE(), entries: [entry({ claudeOnly: true, kind: 'once', at: Date.now() - 1000 })] });
poll();
t('a once entry: held, and off the store as it always is at its fire', () => {
  eq(held().length, 1);
  eq(B.schedules().items.length, 0);
});
B.setWall(0);
poll();
t('a once entry runs once at the lift', () => eq(claudeStarts().length, 1));

await fresh({ wall: FUTURE() });
writeFileSync(QUEUE, JSON.stringify([{ text: 'child job', queuedAt: '2026-11-06T07:00:00.000Z', scheduleId: 8 }]));
poll();
t('a handoff from inside the run shares its id, and does not count as the job waiting', () => {
  ok(held().some((it) => it.claudeOnly === true && it.scheduleId === 8), 'the entry fired no job of its own');
});

// ---------------------------------------------------------------------------
console.log('\n3. an entry without the flag still goes to Codex in the same wall');
// ---------------------------------------------------------------------------

await fresh({ wall: FUTURE(), entries: [entry()] });
poll();
t('no flag, same wall: a Codex job started', () => {
  eq(codexStarts().length, 1);
  eq(codexStarts()[0].reason, 'claude_limited');
  eq(claudeStarts().length, 0);
});
t('no flag: nothing held, nothing queued', () => {
  eq(held().length, 0);
  eq(queue().length, 0);
});
t('no flag: the prompt is the text as it always was', () => eq(codexStarts()[0].text, 'Nightly repo review.'));
t('no flag: the scheduled run mark rides along', () => eq(codexStarts()[0].schedule?.id, 8));
B.setClock('2026-11-07');
poll();
t('no flag: the next day fires again, as it does today', () => eq(codexStarts().length, 2));

await fresh({ wall: 0, cap: 1, entries: [entry()] });
B.occupy(1);
B.checkSchedules();
t('no flag, full pool: the queue item carries no pin and no new field', () => {
  eq(Object.keys(queue()[0]).sort(), ['queuedAt', 'scheduleId', 'text']);
});
B.setWall(FUTURE());
B.finishWorkers();
poll();
t('no flag, queued then walled: it goes to Codex as it does today', () => {
  eq(codexStarts().length, 1);
  eq(held().length, 0);
});

await fresh({ wall: 0, entries: [entry()] });
poll();
t('no flag, no wall: a plain Claude run', () => {
  eq(claudeStarts().length, 1);
  eq(claudeStarts()[0].text, 'Nightly repo review.');
});

await fresh({ wall: FUTURE(), entries: [entry(), entry({ id: 9, claudeOnly: true })] });
poll();
t('one flagged and one not, same poll: each takes its own road', () => {
  eq(codexStarts().length, 1);
  eq(codexStarts()[0].schedule?.id, 8);
  eq(held().map((it) => it.scheduleId), [9]);
});

// ---------------------------------------------------------------------------
console.log('\n4. the 6 hour line fires once');
// ---------------------------------------------------------------------------

await fresh({ wall: FUTURE() });
const firedAt = Date.now();
poll(firedAt);
const lines = () => B.SENT.filter((l) => /held/i.test(l) && /#8/.test(l));
B.tellLongClaudeOnlyHolds(firedAt + SIX_HOURS - 60_000);
t('a minute short of 6 hours: nothing said', () => eq(lines().length, 0));
B.tellLongClaudeOnlyHolds(firedAt + SIX_HOURS + 1000);
t('at 6 hours: one line', () => eq(lines().length, 1));
t('it is one line, and names the entry and the hold', () => {
  const line = lines()[0] || '';
  ok(!line.includes('\n'), `more than one line: ${line}`);
  ok(/#8/.test(line), `no entry id: ${line}`);
  ok(/Nightly repo review/.test(line), `no entry name: ${line}`);
  ok(/held 6h/.test(line), `no hold: ${line}`);
  ok(/Claude/.test(line), `does not say what it waits for: ${line}`);
});
t('the house style: no em or en dash, no ⏳ nothing would ever resolve', () => {
  ok(!/[–—]/.test(lines()[0] || ''), 'a dash');
  ok(!(lines()[0] || '').includes('⏳'), 'an hourglass');
});
for (let i = 2; i <= 40; i++) B.tellLongClaudeOnlyHolds(firedAt + SIX_HOURS + i * 60_000);
t('forty more polls: still one line', () => eq(lines().length, 1));
B.setClock('2026-11-07');
poll(firedAt + 24 * 3600_000);
t('a new day behind the same wall: still one line', () => eq(lines().length, 1));
const sentBefore = lines().length;
B = await load();
B.setCap(3);
B.setWall(FUTURE()); // by hand, as above: this one is about the mark on disk
B.setSchedules([]);
B.tellLongClaudeOnlyHolds(firedAt + 30 * 3600_000);
t('a fresh daemon does not say it again: the mark is on the held item', () => {
  eq(sentBefore, 1);
  eq(B.SENT.filter((l) => /#8/.test(l)).length, 0);
});

await fresh({ wall: FUTURE() });
const heldAt = Date.now();
poll(heldAt);
B.setWall(0);
poll(heldAt + 60_000);
B.tellLongClaudeOnlyHolds(heldAt + SIX_HOURS + 1000);
t('released before 6 hours: no line', () => eq(B.SENT.filter((l) => /held/i.test(l)).length, 0));

await fresh({ wall: FUTURE(), entries: [entry()] });
writeFileSync(HELD, JSON.stringify([{ text: 'an ordinary held job', queuedAt: new Date(Date.now() - 2 * SIX_HOURS).toISOString(), engine: 'claude' }]));
B.tellLongClaudeOnlyHolds();
t('an ordinary held job gets no such line', () => eq(B.SENT.length, 0));

await fresh({ wall: FUTURE() });
poll();
B.setFailHoldWrite(true);
for (let i = 0; i < 5; i++) B.tellLongClaudeOnlyHolds(Date.now() + SIX_HOURS + i * 60_000);
t('a mark that will not write says nothing: never once a poll', () => eq(B.SENT.filter((l) => /held/i.test(l)).length, 0));
B.setFailHoldWrite(false);
B.tellLongClaudeOnlyHolds(Date.now() + SIX_HOURS + 600_000);
t('and it is said once the mark writes', () => eq(B.SENT.filter((l) => /held/i.test(l)).length, 1));

// ---------------------------------------------------------------------------
console.log('\n5. the write approval survives the hold and its line');
// ---------------------------------------------------------------------------

// A grant signs the whole item, so anything the hold writes on it must be gone
// by the drain, or an approved entry would run without its approval.
await fresh({ wall: FUTURE(), entries: [entry({ claudeOnly: true, allowWrite: true })] });
const approvedAt = Date.now();
poll(approvedAt);
B.tellLongClaudeOnlyHolds(approvedAt + SIX_HOURS + 1000);
t('the long hold marks the held item', () => ok(held()[0]?.holdToldAt, 'no mark on the held item'));
B.setWall(0);
poll(approvedAt + SIX_HOURS + 60_000);
t('an approved entry told about at 6 hours still runs approved', () => {
  eq(claudeStarts().length, 1);
  eq(claudeStarts()[0].schedule?.allowWrite, true);
});

// ---------------------------------------------------------------------------
console.log('\n6. the ends of the road');
// ---------------------------------------------------------------------------

await fresh({ wall: 0 });
B.setClaudeInstalled(false);
poll();
t('no `claude` on the machine: refused out loud, not sent to Codex', () => {
  eq(codexStarts().length, 0);
  eq(B.SENT.filter((l) => l.includes('Job not run')).length, 1);
  eq(B.RESULTS.length, 1);
});
t('and not held for a reset that will never come', () => eq(held().length, 0));

// The hold's fence is 20. A Claude-only job is past it: one per entry, so it
// cannot grow with the wall, and only the hold file gets the 6 hour line.
const fullHold = () => Array.from({ length: 20 }, (_, i) => ({ text: `held ${i}`, queuedAt: new Date().toISOString(), engine: 'claude' }));
await fresh({ wall: FUTURE() });
writeFileSync(HELD, JSON.stringify(fullHold()));
const fullAt = Date.now();
poll(fullAt);
t('the hold is full: a Claude-only job still gets in, and not on Codex', () => {
  eq(codexStarts().length, 0);
  eq(queue().length, 0);
  eq(held().filter((it) => it.scheduleId === 8).length, 1);
  eq(B.parkedWalledChats.length, 0, 'parked in memory, where a restart loses it');
});
B.setClock('2026-11-07');
poll(fullAt);
t('and it still fires once', () => eq(held().filter((it) => it.scheduleId === 8).length, 1));
B.tellLongClaudeOnlyHolds(fullAt + SIX_HOURS + 1000);
t('and it gets its 6 hour line', () => eq(B.SENT.filter((l) => /#8 held/.test(l)).length, 1));

await fresh({ wall: FUTURE(), entries: [] });
writeFileSync(HELD, JSON.stringify(fullHold()));
writeFileSync(QUEUE, JSON.stringify([{ text: 'a pinned job', queuedAt: new Date().toISOString(), engine: 'claude' }]));
poll();
t('the fence still holds for any other job: it drops open, as it did', () => {
  eq(held().length, 20);
  eq(queue().length, 0);
  eq(B.parkedWalledChats.length, 1);
});

await fresh({ wall: FUTURE() });
B.setFailHoldWrite(true);
poll();
t('the hold will not write: same, on disk in the drop box', () => {
  eq(codexStarts().length, 0);
  eq(queue().length, 1);
});
B.setFailHoldWrite(false);

t('/schedules shows the flag', () => ok(/claude only/.test(B.fmtSchedule(entry({ claudeOnly: true }))), B.fmtSchedule(entry({ claudeOnly: true }))));
t('/schedules says nothing new for an entry without it', () => ok(!/claude only/.test(B.fmtSchedule(entry())), 'the flagless line changed'));

// ---------------------------------------------------------------------------
console.log('\n6b. a Claude slash command, which an unchosen Codex never gets');
// ---------------------------------------------------------------------------

await fresh({ wall: FUTURE(), entries: [entry({ claudeOnly: true, text: '/autopilot nightly sweep' })] });
poll();
t('flagged: held on disk behind the wall, not on Codex', () => {
  eq(codexStarts().length, 0);
  eq(held().length, 1);
  eq(held()[0].claudeOnly, true);
});
poll();
t('a second poll behind the wall: the flush does not release it', () => {
  eq(B.STARTS.length, 0);
  eq(held().length, 1);
});
B.setWall(0);
poll();
t('and it runs on Claude at the lift, as the command it is', () => {
  eq(claudeStarts().length, 1);
  eq(claudeStarts()[0].text, '/autopilot nightly sweep');
});

await fresh({ wall: FUTURE(), entries: [entry({ text: '/autopilot nightly sweep' })] });
poll();
t('no flag: the slash command hold still takes it, the same as before', () => {
  eq(codexStarts().length, 0);
  eq(held().length, 1);
  ok(!held()[0].claudeOnly, 'the hold marked an entry that never asked');
});
poll();
t('and a second poll behind the wall keeps it there', () => {
  eq(B.STARTS.length, 0);
  eq(held().length, 1);
});

// ---------------------------------------------------------------------------
console.log('\n6c. every N hours and a script, through the real checkSchedules');
// ---------------------------------------------------------------------------

const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};
const scriptFile = (name, body) => {
  const f = path.join(TMP, name);
  writeFileSync(f, body);
  return f;
};
const hoursEntry = (extra = {}) => ({ id: 9, kind: 'hours', every: 2, at: '00:05', text: 'Sweep: act on each line.', ...extra });

await fresh({ wall: 0, entries: [hoursEntry({ script: scriptFile('says.mjs', "console.log('two items open');\n") })] });
B.checkSchedules();
const stamped = B.schedules().items[0].lastFiredAt;
await until(() => B.STARTS.length > 0);
t('a due hours entry stamps its slot, and its output is a daemon authored turn', () => {
  ok(Number.isFinite(stamped) && stamped <= Date.now(), `lastFiredAt ${stamped}`);
  eq(B.STARTS.length, 1);
  const turn = B.STARTS[0].text;
  ok(turn.startsWith('[Scheduled script, daemon authored, not the owner.]'), turn);
  ok(turn.includes('Sweep: act on each line.') && turn.endsWith('two items open'), turn);
});
B.checkSchedules();
await new Promise((r) => setTimeout(r, 200));
t('and it fires once per slot, not once per poll', () => eq(B.STARTS.length, 1));

await fresh({ wall: 0, entries: [hoursEntry({ script: scriptFile('quiet.mjs', '// nothing to say\n') })] });
const quietLog = [];
const realLog = console.log;
console.log = (...a) => quietLog.push(a.join(' '));
B.checkSchedules();
await until(() => quietLog.some((l) => l.includes('no output, no turn')));
console.log = realLog;
t('a script with no output starts no turn', () => {
  eq(B.STARTS.length, 0);
  ok(Number.isFinite(B.schedules().items[0].lastFiredAt), 'the slot is still stamped');
});

await fresh({ wall: 0, entries: [hoursEntry({ run: true, text: 'Hourly repo review.' })] });
B.checkSchedules();
t('an hours --run entry is a scheduled run like any other', () => {
  eq(claudeStarts().length, 1);
  eq(claudeStarts()[0].text, 'Hourly repo review.');
  eq(claudeStarts()[0].schedule?.id, 9);
});

await fresh({ wall: 0, entries: [hoursEntry({ script: scriptFile('fails.mjs', "console.error('no such table');\nprocess.exit(3);\n") })] });
const nextSlot = () => {
  B.schedules().items[0].lastFiredAt = 0; // the next slot, without waiting two hours
};
const failLines = () => B.SENT.filter((l) => l.includes('script failed'));
const quietly = async (fn) => {
  const real = console.error;
  console.error = () => {};
  await fn();
  console.error = real;
};
await quietly(async () => {
  B.checkSchedules();
  await until(() => failLines().length > 0);
  for (let i = 0; i < 3; i++) {
    nextSlot();
    B.checkSchedules();
    await new Promise((r) => setTimeout(r, 150));
  }
});
t('a failing script with no output: one line, not one per slot, and no turn', () => {
  eq(failLines().length, 1);
  ok(failLines()[0].includes('fails.mjs') && failLines()[0].includes('no such table'), failLines()[0]);
  eq(B.STARTS.length, 0);
});
writeFileSync(B.schedules().items[0].script, '// fixed\n');
nextSlot();
const fixedLog = [];
console.log = (...a) => fixedLog.push(a.join(' '));
B.checkSchedules();
await until(() => fixedLog.some((l) => l.includes('no output, no turn')));
console.log = realLog;
writeFileSync(B.schedules().items[0].script, 'process.exit(3);\n');
nextSlot();
await quietly(async () => {
  B.checkSchedules();
  await until(() => failLines().length > 1);
});
t('a clean run ends the streak, so the next failure is said again', () => eq(failLines().length, 2));

writeFileSync(B.schedules().items[0].script, "console.log('half done');\nprocess.exit(4);\n");
await quietly(async () => {
  nextSlot();
  B.checkSchedules();
  await until(() => B.STARTS.length > 0);
});
writeFileSync(B.schedules().items[0].script, 'process.exit(3);\n');
await quietly(async () => {
  nextSlot();
  B.checkSchedules();
  await new Promise((r) => setTimeout(r, 200));
});
t('a failed run with output is not a clean run: the streak stays, so the next failure is not said twice', () => eq(failLines().length, 2));

// A SLOT MUST NOT STACK A JOB. Three slots come up behind each wall; each row is
// a road a due job can take, and each ends in one job, not three.
const slots = (n = 3) => {
  for (let i = 0; i < n; i++) {
    nextSlot();
    poll();
  }
};
await fresh({ wall: FUTURE(), entries: [hoursEntry({ run: true, text: '/qa-loop the sweep' })] });
slots();
t('a slash command behind a wall: one held job, not one per slot', () => {
  eq(held().length, 1);
  eq(held()[0].hoursRun, true);
  eq(B.STARTS.length, 0);
});
B.setWall(0);
poll();
t('and one run at the lift', () => eq(claudeStarts().length, 1));

await fresh({ wall: FUTURE(), entries: [hoursEntry({ run: true, text: 'Hourly repo review.' })] });
B.setCodexInstalled(false);
slots();
t('no Codex on the machine: one job in the hold, not one per slot, and none parked in memory', () => {
  eq(held().length, 1);
  eq(held()[0].scheduleId, 9);
  eq(B.parkedWalledChats.length, 0);
  eq(B.STARTS.length, 0);
});
B.setCodexInstalled(true);

await fresh({ wall: FUTURE(), cap: 1, entries: [hoursEntry({ run: true, text: 'First review.' }), hoursEntry({ id: 10, run: true, text: 'Second review.' })] });
B.setCodexInstalled(false);
poll();
t('two entries behind the wall: both held', () => eq(held().length, 2));
B.setWall(0);
poll();
t('the lift goes through the cap: one starts, the other waits in the drop box', () => {
  eq(claudeStarts().length, 1);
  eq(queue().length, 1);
});
B.setCodexInstalled(true);

await fresh({ wall: FUTURE(), entries: [hoursEntry({ run: true, text: 'Hourly repo review.' })] });
writeFileSync(HELD, JSON.stringify(fullHold()));
B.setCodexInstalled(false);
slots();
t('the hold full: it parks in memory, and the next slots fold into that one', () => {
  eq(B.parkedWalledChats.filter((it) => it.schedule?.id === 9).length, 1);
  eq(held().length, 20);
});
B.setCodexInstalled(true);

await fresh({ wall: 0, cap: 1, entries: [hoursEntry({ run: true, text: 'Hourly repo review.' })] });
B.occupy(1);
slots();
t('the cap full and no wall: one job in the drop box, not one per slot', () => {
  eq(queue().length, 1);
  eq(queue()[0].hoursRun, true);
});

await fresh({ wall: 0, cap: 1, entries: [hoursEntry({ run: true, text: 'Hourly repo review.' })] });
B.occupy(1);
writeFileSync(QUEUE, JSON.stringify([{ text: 'a child of the last run', queuedAt: new Date().toISOString(), scheduleId: 9 }]));
B.checkSchedules();
t('a bg.mjs child carries the id, not the mark, so it does not count as the job waiting', () => {
  eq(queue().length, 2);
  eq(queue().filter((it) => it.hoursRun === true).length, 1);
});

await fresh({ wall: FUTURE(), entries: [entry({ text: 'Hourly repo review.' })] });
B.setCodexInstalled(false);
poll();
B.setClock('2026-11-07');
poll();
t('a daily entry without the flag does not fold: one fire a day still adds a job', () => eq(held().length, 2));
B.setCodexInstalled(true);

const counter = path.join(TMP, 'count.txt');
writeFileSync(counter, '0');
const countScript = scriptFile('count.mjs', `import fs from 'node:fs';\nconst n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1;\nfs.writeFileSync(${JSON.stringify(counter)}, String(n));\nconsole.log('run ' + n);\n`);
await fresh({ wall: FUTURE(), entries: [hoursEntry({ script: countScript })] });
B.setCodexInstalled(false);
for (let i = 1; i <= 3; i++) {
  nextSlot();
  B.checkSchedules();
  await until(() => B.parkedWalledChats[0]?.text?.endsWith(`run ${i}`));
}
t('a script turn behind a wall: one parked turn, holding the newest output', () => {
  eq(B.parkedWalledChats.length, 1);
  ok(B.parkedWalledChats[0].text.endsWith('run 3'), B.parkedWalledChats[0].text);
});
B.setCodexInstalled(true);

// THE NOTICE names the walls that are real. The Claude notice lifts when the
// Claude clock runs out, which on a machine with no claude is at once.
await fresh({ wall: 0, entries: [entry({ text: 'Hourly repo review.' })] });
B.setClaudeInstalled(false);
B.setCodexWall(FUTURE());
poll();
t('no claude and a Codex wall: held, under the two-engine notice, not the Claude one', () => {
  eq(held().length, 1);
  eq(B.STARTS.length, 0);
  ok(B.WALLS.includes('both'), `notices: ${B.WALLS}`);
  eq(B.WALL_NOTICES.length, 0, 'the Claude notice would say Claude is back at its first tick');
});
t('that notice stays up while Codex is walled', () => ok(!B.wallOpts.both.lifted(), 'it says an engine is back with none back'));
t('and the ending it writes for itself claims no job: only the flush knows what started', () =>
  eq(B.wallOpts.both.resolved({}), '▶️ An engine is back · running 0 parked'));
B.setCodexWall(0);
t('a lift with the job still in the hold does not end it: the flush has not started the job', () =>
  ok(!B.wallOpts.both.lifted(), 'the sweep would write the ending before the job runs'));
poll();
t('the Codex lift runs it, and the ending names Codex and the count', () => {
  eq(codexStarts().length, 1);
  eq(B.SETTLED.filter((x) => x.kind === 'both'), [{ kind: 'both', engine: 'codex', count: 1 }]);
});
t('with the hold empty, lifted() is true after that lift', () => ok(B.wallOpts.both.lifted(), 'a notice with nothing behind it never ends'));

await fresh({ wall: FUTURE(), entries: [entry({ text: 'Hourly repo review.' })] });
B.setCodexWall(FUTURE());
poll();
t('both engines walled, a job either can run: the two-engine notice', () => {
  eq(held().length, 1);
  ok(B.WALLS.includes('both'), `notices: ${B.WALLS}`);
  eq(B.WALL_NOTICES.length, 0);
});
t('lifted() is false while both are out', () => ok(!B.wallOpts.both.lifted(), 'it ends with no engine back'));
B.setCodexWall(0);
poll();
t('Codex lifts first, Claude still walled: lifted() is true once the job has gone', () => {
  eq(codexStarts().length, 1);
  ok(B.wallOpts.both.lifted(), 'only a Claude lift ends this notice');
});

await fresh({ wall: FUTURE(), entries: [entry({ text: 'Hourly repo review.' })] });
B.setCodexWall(FUTURE());
poll();
writeFileSync(HELD, '[]');
t('an empty hold with both still out: lifted() is false, no engine is back', () => ok(!B.wallOpts.both.lifted(), 'it ends with no engine back'));

await fresh({ wall: FUTURE(), entries: [entry({ text: 'Hourly repo review.' })] });
B.setCodexWall(FUTURE());
poll();
B.setWall(0);
poll();
t('Claude lifts first, Codex still walled: lifted() is true once the job has gone', () => {
  eq(claudeStarts().length, 1);
  ok(B.wallOpts.both.lifted(), 'only a Codex lift ends this notice');
});

await fresh({ wall: FUTURE(), entries: [entry({ text: 'Hourly repo review.' })] });
B.setCodexInstalled(false);
poll();
t('a Claude wall alone keeps the Claude notice: no wall on an engine that is not there', () => {
  eq(B.WALLS.length, 0);
  ok(B.WALL_NOTICES.length >= 1, 'no Claude notice');
});
B.setCodexInstalled(true);

t('/schedules calls a script entry a script, not a reminder', () => {
  const line = B.fmtSchedule(hoursEntry({ script: '/a/sweep.mjs' }));
  ok(line.includes('script sweep.mjs') && !line.includes('remind'), line);
});

// ---------------------------------------------------------------------------
console.log('\n7. the wiring');
// ---------------------------------------------------------------------------

const pollLoop = (() => {
  const start = SRC.findIndex((l) => /^async function pollLoop\b/.test(l));
  return SRC.slice(start, start + 60).join('\n');
})();
t('the poll loop runs this order: schedules, flushes, the long hold line, the drain', () => {
  const at = (s) => pollLoop.indexOf(s);
  const order = [at('checkSchedules();'), at('flushParkedWalledJobs();'), at('tellLongClaudeOnlyHolds();'), at('drainBgHandoff();')];
  ok(order.every((n) => n >= 0), `a call is missing from pollLoop: ${order}`);
  eq(order, [...order].sort((a, b) => a - b));
});

// ---------------------------------------------------------------------------
console.log('\n8. the wall notice says what the job waits on (the REAL notice functions)');
// ---------------------------------------------------------------------------
//
// The real raiseWall, settleWall, tickLiveMessages, raiseClaudeWall, line
// builders and both flushes, so these read the words on screen. Two rules: no
// line says a job is running unless it started, and no line says an engine is
// back for a job that still waits on the other engine.

const breath = () => new Promise((r) => setTimeout(r, 0));
const fullPoll = async () => {
  B.checkSchedules();
  B.flushParkedWalledChats();
  B.flushParkedWalledJobs();
  B.tellLongClaudeOnlyHolds(Date.now());
  B.drainBgHandoff();
  await breath();
};
const sweep = async () => {
  B.tickLiveMessages();
  await breath();
};
const rerender = async () => {
  for (const e of B.liveMessages) e.nextAt = 0;
  await sweep();
};
const said = () => [...B.SENT, ...B.EDITS.map((e) => e.text)];
const saying = (re) => said().filter((l) => re.test(l));
const backLines = () => saying(/is back/);
const runningLines = () => saying(/running \d+ parked|Started \d+ held/);
const liveNotices = () => [...B.liveMessages].filter((e) => !e.done).map((e) => e.last);
const bothNotices = () => liveNotices().filter((l) => /Both engines are out/.test(l));
const heldOnClaudeNotice = () => liveNotices().some((l) => /1 held · it runs at the reset/.test(l));
const drop = (jobs) => writeFileSync(QUEUE, JSON.stringify(jobs.map((j) => ({ queuedAt: new Date().toISOString(), ...j }))));

// A real wall raises its own notice the moment rotation runs out of accounts, so
// a job that comes due later finds it up.
const walled = async ({ entries = [], jobs = [], fallback = true } = {}) => {
  await fresh({ wall: FUTURE() + 3600_000, entries, realWall: true });
  B.setFallback(fallback);
  B.setCodexWall(FUTURE());
  if (jobs.length) drop(jobs);
  await B.raiseClaudeWall();
  await breath();
};

// A JOB ONLY CLAUDE CAN RUN, both engines walled, Codex resetting first.
for (const [name, setup] of [
  ['a --claude-only entry', { entries: [entry({ claudeOnly: true })] }],
  ['an --engine claude handoff', { jobs: [{ text: 'Pinned work', engine: 'claude' }] }],
  ['a claude: brief', { jobs: [{ text: 'claude: Pinned work' }] }],
  ['a slash command handoff', { jobs: [{ text: '/qa-loop the repo' }] }],
  ['a plain job with the fallback off', { entries: [entry()], fallback: false }],
]) {
  await walled(setup);
  await fullPoll();
  await sweep();
  t(`${name}: held under the Claude notice alone, a Codex reset frees nothing for it`, () => {
    eq(held().length, 1);
    eq(bothNotices(), []);
  });
  B.setCodexWall(0);
  await sweep();
  await fullPoll();
  await sweep();
  await rerender();
  t(`${name}: the Codex reset says nothing about it`, () => {
    eq(B.STARTS.length, 0);
    eq(held().length, 1);
    eq(backLines(), []);
    eq(runningLines(), []);
  });
  t(`${name}: the Claude notice still counts it`, () => ok(heldOnClaudeNotice(), `live: ${liveNotices()}`));
  B.setWall(0);
  await fullPoll();
  await sweep();
  t(`${name}: the Claude lift runs it, and one ending says so`, () => {
    eq(claudeStarts().length, 1);
    eq(held().length, 0);
    eq(saying(/Started 1 held job/).length, 1);
    eq(saying(/running \d+ parked/), []);
  });
}

// A TYPED SLASH COMMAND takes the chat road to the same notice.
await walled();
B.dispatchPrompt('/qa-loop the repo', B.LANES.main, { allowCodexFallback: true });
await breath();
await sweep();
t('a typed slash command: parked under the Claude notice alone', () => {
  eq(B.parkedWalledChats.length, 1);
  eq(bothNotices(), []);
});
B.setCodexWall(0);
await sweep();
await fullPoll();
await sweep();
t('a typed slash command: the Codex reset says nothing about it', () => {
  eq(B.STARTS.length, 0);
  eq(B.parkedWalledChats.length, 1);
  eq(backLines(), []);
  eq(runningLines(), []);
});

// NO `claude` ON THE MACHINE, Codex walled: what it waits on is Codex, and the
// Claude notice would say "Claude is back" at its first tick.
await fresh({ wall: 0, entries: [entry()], realWall: true });
B.setClaudeInstalled(false);
B.setCodexWall(FUTURE());
await fullPoll();
await sweep();
await sweep();
await fullPoll();
await sweep();
t('no claude, Codex walled: it waits and no line says Claude is back', () => {
  eq(held().length, 1);
  eq(saying(/Claude is back/), []);
  eq(backLines(), []);
  ok(bothNotices().some((l) => l.includes('No claude on this machine')), `live: ${liveNotices()}`);
});
B.setCodexWall(0);
await sweep();
t('no claude, the sweep sees the lift first: no job started, so no line says running', () => {
  eq(B.STARTS.length, 0);
  eq(runningLines(), []);
});
await fullPoll();
await sweep();
t('no claude: the poll starts it, and the ending names Codex and what started', () => {
  eq(codexStarts().length, 1);
  eq(backLines(), ['▶️ Codex is back · running 1 parked']);
});

// A JOB EITHER ENGINE CAN RUN, both walled: both clocks, because whichever comes
// back first is the one that matters.
for (const [lift, engine] of [['Codex', 'codex'], ['Claude', 'claude']]) {
  const claudeAt = FUTURE();
  const codexAt = FUTURE() + 3600_000;
  await fresh({ wall: claudeAt, entries: [entry()], realWall: true });
  B.setCodexWall(codexAt);
  await fullPoll();
  await sweep();
  t(`both walled, ${lift} back first: the notice names both clocks`, () => {
    const [line] = bothNotices();
    ok(line, `live: ${liveNotices()}`);
    ok(line.includes(`Claude resets ${B.fmtUntil(claudeAt, { timeZone: 'America/Toronto' })}`), line);
    ok(line.includes(`Codex ${B.fmtUntil(codexAt, { timeZone: 'America/Toronto' })}`), line);
  });
  if (engine === 'codex') B.setCodexWall(0);
  else B.setWall(0);
  await sweep();
  t(`both walled, ${lift} back first: the sweep says nothing before a job starts`, () => {
    eq(B.STARTS.length, 0);
    eq(runningLines(), []);
  });
  await fullPoll();
  await sweep();
  t(`both walled, ${lift} back first: the ending names ${lift} and what started`, () => {
    eq(B.STARTS.map((s) => s.engine), [engine]);
    eq(saying(/running \d+ parked/), [`▶️ ${lift} is back · running 1 parked`]);
  });
}

// A reset that does not last: the sweep saw the lift, then Codex walled again
// before any poll. Nothing started, so nothing may say so.
await fresh({ wall: FUTURE() + 3600_000, entries: [entry()], realWall: true });
B.setCodexWall(FUTURE());
await fullPoll();
await sweep();
B.setCodexWall(0);
await sweep();
B.setCodexWall(FUTURE());
await fullPoll();
await sweep();
t('Codex lifts and walls again before the poll: no line claims a start, and the notice stays', () => {
  eq(B.STARTS.length, 0);
  eq(held().length, 1);
  eq(backLines(), []);
  eq(runningLines(), []);
  eq(bothNotices().length, 1);
});

// A MIX: the plain job goes when Codex does, the Claude job stays, and the
// ending counts what started, whichever of the sweep and the poll sees it first.
for (const first of ['sweep', 'poll']) {
  await walled({ entries: [entry({ claudeOnly: true })], jobs: [{ text: 'Plain work' }] });
  await fullPoll();
  await sweep();
  B.setCodexWall(0);
  if (first === 'sweep') await sweep();
  await fullPoll();
  await sweep();
  await rerender();
  t(`a mix, the ${first} sees the Codex lift first: the ending counts the one job that started`, () => {
    eq(codexStarts().length, 1);
    eq(saying(/running \d+ parked/), ['▶️ Codex is back · running 1 parked']);
  });
  t(`a mix, the ${first} first: the Claude job stays held and the Claude notice counts it`, () => {
    eq(held().map((j) => j.scheduleId), [8]);
    ok(heldOnClaudeNotice(), `live: ${liveNotices()}`);
  });
}

// A TYPED MESSAGE either engine can answer, the same ending through the chat flush.
await fresh({ wall: FUTURE() + 3600_000, entries: [], realWall: true });
B.setCodexWall(FUTURE());
B.dispatchPrompt('is the deploy green', B.LANES.main, { allowCodexFallback: true });
await breath();
await sweep();
B.setCodexWall(0);
await sweep();
t('a typed message: the sweep says nothing before it runs', () => eq(runningLines(), []));
await fullPoll();
await sweep();
t('a typed message: the ending names Codex and what started', () => {
  eq(codexStarts().length, 1);
  eq(saying(/running \d+ parked/), ['▶️ Codex is back · running 1 parked']);
});

// THE WAITING LINE on a job that already has one up: the same reading.
const realNow = Date.now;
const waitingAtTheWall = async (setup) => {
  B.occupy(3);
  await fullPoll();
  B.finishWorkers();
  setup();
  Date.now = () => realNow() + 120_000;
  try {
    await fullPoll();
  } finally {
    Date.now = realNow;
  }
  return B.EDITS.map((e) => e.text).join('\n');
};
await fresh({ wall: 0, entries: [entry({ claudeOnly: true })], realWall: true });
{
  const lines = await waitingAtTheWall(() => {
    B.setWall(FUTURE() + 3600_000);
    B.setCodexWall(FUTURE());
  });
  t('a job only Claude can run: its waiting line names Claude, not any engine', () => {
    ok(lines.includes('every Claude account is at its limit, it starts after the reset'), lines);
    ok(!lines.includes('no engine is free'), lines);
  });
}
await fresh({ wall: 0, entries: [entry()], realWall: true });
{
  const lines = await waitingAtTheWall(() => {
    B.setClaudeInstalled(false);
    B.setCodexWall(FUTURE());
  });
  t('no claude, Codex walled: its waiting line says any engine, not Claude', () => {
    ok(lines.includes('no engine is free, it starts when one is back'), lines);
    ok(!lines.includes('every Claude account'), lines);
  });
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
