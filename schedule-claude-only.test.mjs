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
// load and usage inputs. Scripts run for real.
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

// `boot` makes every evaluation a fresh module: a daemon restart is a new one
// over the same files.
const HARNESS = (boot) => `
// boot ${boot}
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mergeRequeue, admissionVerdict, loadGate, queueRows, queuedBlock, admissionRows, admissionLine, usageHold } from ${url('bg-admission.mjs')};
import { parseEnginePrefix } from ${url('bg-codex.mjs')};
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
let CHAT = { cwd: ${JSON.stringify(TMP)} };
export const setBgEngine = (v) => { CHAT = { ...CHAT, engineBg: v }; };
const chatState = () => CHAT;
const fileConfig = {};
const ENGINE_CONFIG = fileConfig;
const codexFallbackOn = () => true;
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

const LANES = { main: { name: 'main', queue: [], current: null } };
const pickLane = () => LANES.main;
const send = (text) => { SENT.push(text); return Promise.resolve({ message_id: SENT.length }); };
const editProgress = () => Promise.resolve();
const escHtml = (s) => String(s);
const keepHandback = () => {};
const raiseWall = () => Promise.resolve();
export const WALL_NOTICES = [];
const raiseClaudeWall = () => { WALL_NOTICES.push(Date.now()); return Promise.resolve(); };
const armWallResume = () => {};
const logAccountDecision = () => {};
const pendWallResolution = () => {};
const settleWall = () => {};
const holdFullLine = () => 'hold full';
const bothEnginesWalledLine = () => '';
const enginesBackLine = () => '';
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
  grabOr('scheduleJobWaiting', 'function scheduleJobWaiting() { return false; }'),
  grabOr('runScheduledScript', 'function runScheduledScript() {}'),
  grabOr('scriptFailureTold', 'const scriptFailureTold = new Set();', 'const'),
  grabOr('tellScriptFailed', 'function tellScriptFailed() {}'),
];
const EXPORTS = 'export { drainBgHandoff, checkSchedules, flushParkedWalledJobs, tellLongClaudeOnlyHolds, readHeldBgJobs, fmtSchedule, resolveEngine };';

let bootCount = 0;
const load = () => import('data:text/javascript,' + encodeURIComponent([HARNESS(++bootCount), ...FUNCTIONS, EXPORTS].join('\n')));
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

const fresh = async ({ wall = 0, entries = [entry({ claudeOnly: true })], cap = 3 } = {}) => {
  rmSync(QUEUE, { force: true });
  rmSync(HELD, { force: true });
  B = await load();
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

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
