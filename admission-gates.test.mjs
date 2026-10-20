#!/usr/bin/env node
// THE ADMISSION GATES (self audit 2026-10-13, P2, approved by the owner with a
// cap of 6): one behavior test per rule, through the REAL drain, the REAL
// `bg.mjs ps` rows and the REAL waiting line store.
//
//   1. the cap: with 6 Claude workers busy a 7th job waits, and says
//      "waiting: 6 of 6" in `bg.mjs ps` and on its own Telegram line;
//   2. the load gate: over 2 x cores a new job waits; with no bridge job
//      running the gate stands aside (load from elsewhere never freezes it);
//   3. the usage gate: the live account past 90% with no other account free
//      holds a new Claude job, with the window and the reset in the reason;
//   4. a waiting job starts by itself when the reason clears, and its card
//      takes over its waiting line (one message), through a restart too;
//   5. Codex: not held by the count or the usage window, held by the load,
//      and a running Codex job counts toward the load gate's floor.
//
// ADMISSION_DIR=<an older export> runs these same tests against the code they
// replaced (the trick fixtures/model-owner-rig.mjs uses): the harness slices
// only the names present and stubs the rest, so the old code runs and the
// assertions show what it did not do.
//
//   node admission-gates.test.mjs
//   ADMISSION_DIR=/tmp/main-export node admission-gates.test.mjs   # red

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.ADMISSION_DIR ? path.resolve(process.env.ADMISSION_DIR) : HERE;
const TMP = mkdtempSync(path.join(tmpdir(), 'admission-gates-'));
const QUEUE = path.join(TMP, 'bg-queue.json');
const WAIT_FILE = path.join(TMP, 'bg-wait.json');

let pass = 0;
const failures = [];
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const settle = () => new Promise((r) => setTimeout(r, 5));

// ---------------------------------------------------------------------------
// The real functions, sliced out of DIR's bridge.mjs by name.
// ---------------------------------------------------------------------------
const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^(?:const|let) ${name}\\b`);
  const start = SRC.findIndex((l) => head.test(l));
  if (start === -1) return null;
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
// A name the older code does not have gets a stub, so the older drain still
// runs; a name it does have is ALWAYS the real one.
const MISSING = [];
const real = (name, stub, kind = 'function') => {
  const src = grab(name, kind);
  if (src) return src;
  MISSING.push(name);
  return stub;
};
const must = (name, kind = 'function') => {
  const src = grab(name, kind);
  if (!src) throw new Error(`could not extract ${name} from ${DIR}/bridge.mjs`);
  return src;
};
const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);

const HARNESS = `
import fs from 'node:fs';
import * as ADM from ${url('bg-admission.mjs')};
import * as NOTE from ${url('bg-notify.mjs')};
import { parseEnginePrefix } from ${url('bg-codex.mjs')};
import { describeWhen, isDailyDue } from ${url('schedule-due.mjs')};
const { maxConcurrentWorkers, mergeRequeue, queuedBlock } = ADM;
const hasSlot = ADM.hasSlot;
const queueRows = ADM.queueRows;
const admissionVerdict = ADM.admissionVerdict || (() => ({ admit: true }));
const admissionRows = ADM.admissionRows || ADM.queueRows;
const loadGate = ADM.loadGate || ((x) => ({ high: false, ...x }));
const usageHold = ADM.usageHold || (() => null);
const { briefTitle, stripLaneRules } = NOTE;
const waitingLine = NOTE.waitingLine || (() => '');
const WAIT = await import(${url('bg-wait.mjs')}).catch(() => null);
const GRANT = await import(${url('write-grant.mjs')}).catch(() => null);
const waitKey = WAIT ? WAIT.waitKey : () => null;
export let bgWait = WAIT ? WAIT.createBgWaitStore({ file: ${JSON.stringify(WAIT_FILE)} }) : null;
export const restartWaitStore = () => { bgWait = WAIT ? WAIT.createBgWaitStore({ file: ${JSON.stringify(WAIT_FILE)} }) : null; };
const writeGrants = GRANT ? GRANT.createWriteGrantStore({ file: ${JSON.stringify(path.join(TMP, 'write-grants.json'))} }) : { issue: () => null, verify: () => false };
const { readFileSync, renameSync, existsSync, writeFileSync } = fs;
const BG_QUEUE_FILE = ${JSON.stringify(QUEUE)};
export let MAX_CONCURRENT_WORKERS = 6;
export const setCap = (n) => { MAX_CONCURRENT_WORKERS = n; };

export const DISPATCHED = [];
export const CODEX = [];
export const SENT = [];
export const EDITS = [];
export const NOTICES = [];
export const bgLanes = [];
let laneSeq = 0;
export const startFakeWorker = (prompt) => {
  laneSeq++;
  const lane = { name: laneSeq === 1 ? 'bg' : 'bg' + laneSeq, isBg: true, n: laneSeq, current: { startedAt: 1000 + laneSeq, prompt, steps: 0 }, queue: [], finishing: 0 };
  bgLanes.push(lane);
  return lane;
};
export const finishFakeWorker = () => {
  const lane = bgLanes.find((l) => l.current);
  if (lane) lane.current = null;
  return lane;
};
export const codexRuns = new Map();
export let ADMISSION_INPUT = { load: null, usage: null, now: null };
export const setAdmission = (v = {}) => { ADMISSION_INPUT = { load: null, usage: null, now: null, ...v }; };
export const reset = () => {
  bgLanes.length = 0; laneSeq = 0; DISPATCHED.length = 0; CODEX.length = 0; SENT.length = 0; EDITS.length = 0; NOTICES.length = 0;
  codexRuns.clear(); ADMISSION_INPUT = { load: null, usage: null, now: null }; MAX_CONCURRENT_WORKERS = 6;
  try { fs.unlinkSync(${JSON.stringify(WAIT_FILE)}); } catch {}
  restartWaitStore();
};
function bgWorkerDescriptors() {
  return bgLanes.filter((l) => l.isBg && l.current).map((l) => ({ runId: l.name + '-' + l.current.startedAt, lane: l.name, engine: 'claude' }));
}
const getBgLane = () => startFakeWorker('(pending)');
const dispatchPrompt = (text, lane, opts = {}) => { DISPATCHED.push(text); if (lane) lane.current.prompt = text; };
export let ENGINE = (forced) => ({ engine: forced || 'claude', reason: forced ? 'explicit' : 'default' });
export const setEngine = (fn) => { ENGINE = fn; };
const engineFor = (lane, forced) => ENGINE(forced);
const codexWalled = () => false;
const holdBgJob = () => true;
const logAccountDecision = () => {};
const raiseClaudeWall = () => Promise.resolve();
const armWallResume = () => {};
const send = (text) => { SENT.push(text); return Promise.resolve({ message_id: 100 + SENT.length }); };
const editProgress = (id, html) => { EDITS.push({ id, html }); return Promise.resolve(); };
const escHtml = (s) => String(s);
const recordBgResult = () => {};
const wallGuard = { jobOf: () => null };
const noteWallGuardJob = () => {};
const claudeMissingLine = () => 'no claude';
const CODEX_MISSING_LINE = 'no codex';
const startCodexJob = (text, opts) => { CODEX.push({ text, opts }); return { runId: 'codex-' + CODEX.length, transport: 'exec', startedAt: 1 }; };
const briefRepo = () => 'repo';
const codexCwdForBrief = () => ${JSON.stringify(TMP)};
const lintCodexBrief = () => [];
const startWorkerNotice = (runId, head, read, extra, opts = {}) => { NOTICES.push({ runId, head, adopt: opts.adopt ?? null }); return Promise.resolve(); };
const codexReasonText = () => '';
const codexCardSettings = () => ({});
const chatState = () => ({ cwd: ${JSON.stringify(TMP)} });
const CODEX_LANE = 'codex';
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const OWNER_TZ = 'America/Toronto';
const BG_MODEL = 'opus';
const DEFAULT_EFFORT = 'high';
const loadSchedules = () => ({ nextId: 1, items: [] });
const saveSchedules = () => {};
const localToday = () => '2026-10-13';
const localHHMM = () => '03:00';
const admissionNow = () => ({ load: ADMISSION_INPUT.load, usage: ADMISSION_INPUT.usage, now: ADMISSION_INPUT.now ?? Date.now(), fmtClock: (ms) => new Date(ms).toISOString().slice(11, 16) });
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        must('bgStrandedJobs', 'let'),
        must('runningBgWorkers'),
        must('runningResumedWorkers'),
        must('requeueDeferredBgJobs'),
        real('BG_WAIT_EDIT_MS', 'const BG_WAIT_EDIT_MS = 600000;', 'const'),
        real('bridgeJobsRunning', 'function bridgeJobsRunning(n = 0) { return Number(n) || 0; }'),
        real('noteBgWaiting', 'function noteBgWaiting() {}'),
        real('takeBgWaiting', 'function takeBgWaiting() { return null; }'),
        must('queuedBgJobRows'),
        // This build keeps a Claude slash command off an unchosen Codex in
        // the drain: the two names it reads for that, as real code.
        must('BG_COMMAND_RE', 'const'),
        must('unchosenCodex', 'const'),
        must('drainBgHandoff'),
        must('scheduleApprovesWrites'),
        'export { drainBgHandoff, runningBgWorkers, queuedBgJobRows, queuedBlock, admissionVerdict, loadGate, usageHold };',
      ].join('\n'),
    )
);

const writeQueue = (items) => writeFileSync(QUEUE, JSON.stringify(items, null, 2));
const readQueue = () => JSON.parse(readFileSync(QUEUE, 'utf8'));
const job = (name, extra = {}) => ({ text: `LANE RULES\n\n--- TASK ---\n\n# ${name}`, queuedAt: `q-${name}`, ...extra });
const busy = (n) => {
  for (let i = 0; i < n; i++) B.startFakeWorker(`busy ${i}`);
};
// 14 cores and 2 per core, the shape of this Mac: the limit is 28.
const LOAD = (load1) => ({ load1, ncpu: 14, loadPerCore: 2 });
const HOLD = { account: 'b@', percent: 93, label: 'the 5 hour window', resetsAtMs: Date.UTC(2026, 9, 13, 19, 0) };

console.log(`admission gates against ${DIR === HERE ? 'this tree' : DIR}${MISSING.length ? ` (stubbed, absent there: ${MISSING.join(', ')})` : ''}`);

// ---------------------------------------------------------------------------
console.log('\n1. the cap of 6, and its reason where it can be seen');
// ---------------------------------------------------------------------------

await t('★ with 6 Claude workers busy, a 7th job waits and its line says "waiting: 6 of 6"', async () => {
  B.reset();
  busy(6);
  writeQueue([job('seventh job')]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 0, 'the 7th must not start');
  eq(readQueue().length, 1, 'it waits in the drop box');
  await settle();
  eq(B.SENT.length, 1, `one waiting line on Telegram, got: ${B.SENT.join(' | ')}`);
  ok(B.SENT[0].includes('⏳ waiting: 6 of 6 Claude workers busy'), B.SENT[0]);
  ok(B.SENT[0].includes('seventh job'), B.SENT[0]);
});

await t('★ bg.mjs ps shows the same reason: "waiting: 6 of 6"', () => {
  const rows = B.queuedBgJobRows();
  eq(rows.length, 1);
  eq(rows[0].waiting, true);
  eq(rows[0].reason, 'waiting: 6 of 6 Claude workers busy');
  const block = B.queuedBlock(rows, { running: 6, max: 6 });
  ok(block.includes('waiting: 6 of 6 Claude workers busy · #1'), block);
});

await t('a second drain does not put up a second line for the same job', async () => {
  B.drainBgHandoff();
  await settle();
  eq(B.SENT.length, 1, B.SENT.join(' | '));
});

await t('under the cap the job starts and no waiting line is sent', async () => {
  B.reset();
  busy(5);
  writeQueue([job('sixth job')]);
  B.drainBgHandoff();
  await settle();
  eq(B.DISPATCHED.length, 1);
  eq(B.SENT.length, 0, B.SENT.join(' | '));
  eq(B.NOTICES[0].adopt, null, 'nothing to take over');
});

// ---------------------------------------------------------------------------
console.log('\n2. the machine load');
// ---------------------------------------------------------------------------

await t('★ load over 2 x 14 cores: a new Claude job waits with the load as its reason', async () => {
  B.reset();
  busy(2);
  B.setAdmission({ load: LOAD(41) });
  writeQueue([job('heavy gate')]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 0, 'load 41 is over the limit of 28');
  await settle();
  ok(B.SENT[0]?.includes('⏳ waiting: machine load 41 is over 28 (14 cores)'), B.SENT.join(' | '));
  eq(B.queuedBgJobRows()[0].reason, 'waiting: machine load 41 is over 28 (14 cores)');
});

await t('★ the same job starts by itself once the load is back under the limit', async () => {
  B.setAdmission({ load: LOAD(12) });
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 1);
  eq(readQueue().length, 0);
});

await t('★ with NO bridge job running, load from elsewhere does not freeze the queue', () => {
  B.reset();
  B.setAdmission({ load: LOAD(90) });
  writeQueue([job('first of the day'), job('second of the day')]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 1, 'one starts, the floor');
  eq(readQueue().length, 1, 'and the next waits on the load the first now shares');
});

// ---------------------------------------------------------------------------
console.log('\n3. the usage window');
// ---------------------------------------------------------------------------

await t('★ the live account past 90% with no other account free holds a new Claude job', async () => {
  B.reset();
  busy(1);
  B.setAdmission({ usage: HOLD });
  writeQueue([job('ship the importer')]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 0, 'it would die on the limit minutes later');
  await settle();
  ok(B.SENT[0]?.includes('⏳ waiting: b@ is at 93% of the 5 hour window, no other account free · resets 19:00'), B.SENT.join(' | '));
});

await t('★ the hold is a pure decision: no other account free holds, a free one does not', () => {
  const trigger = { armed: true, window: { kind: 'fiveHour', label: 'the 5 hour window', percent: 92.6, resetsAtMs: 5 } };
  const held = B.usageHold({ trigger, othersFree: false, account: 'b@', usagePercent: 90 });
  eq(held?.percent, 93);
  eq(B.usageHold({ trigger, othersFree: null, account: 'b@', usagePercent: 90 })?.percent, 93, 'unknown holds: the reading already says the account is nearly spent');
  eq(B.usageHold({ trigger, othersFree: true, account: 'b@', usagePercent: 90 }), null, 'the switch has somewhere to go');
  eq(B.usageHold({ trigger: { armed: false }, othersFree: false, account: 'b@', usagePercent: 90 }), null, 'below the threshold');
});

await t('★ when the window resets (the hold clears) the held job starts by itself', () => {
  B.setAdmission({ usage: null });
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 1);
});

// ---------------------------------------------------------------------------
console.log('\n4. a waiting job starts by itself, and keeps one message');
// ---------------------------------------------------------------------------

await t('★ a freed slot starts the waiting job and its card TAKES OVER the waiting line', async () => {
  B.reset();
  busy(6);
  writeQueue([job('queued then started')]);
  B.drainBgHandoff();
  await settle(); // the waiting line's send lands (message 101)
  eq(B.SENT.length, 1);
  B.finishFakeWorker();
  B.drainBgHandoff(); // what a worker's close handler does
  eq(B.DISPATCHED.length, 1, 'it started by itself');
  eq(B.NOTICES.length, 1);
  eq(await B.NOTICES[0].adopt, 101, 'the card edits the waiting message, it does not send a second one');
  eq(B.SENT.length, 1, 'still one message for the job');
});

await t('★ ...through a daemon restart too: the waiting message id is on disk', async () => {
  B.reset();
  busy(6);
  writeQueue([job('waited across a restart')]);
  B.drainBgHandoff();
  await settle();
  B.restartWaitStore(); // the next daemon: memory gone, the file kept
  B.finishFakeWorker();
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 1);
  eq(await B.NOTICES[0].adopt, 101, 'the new daemon edits the same message');
});

await t('a job no engine can run ends its waiting line with ❌ instead of a second message', async () => {
  B.reset();
  busy(6);
  writeQueue([job('cannot run')]);
  B.drainBgHandoff();
  await settle();
  B.setEngine(() => ({ error: 'claude_missing' }));
  B.drainBgHandoff();
  B.setEngine((forced) => ({ engine: forced || 'claude', reason: forced ? 'explicit' : 'default' }));
  await settle();
  eq(B.SENT.length, 1, `no second message: ${B.SENT.join(' | ')}`);
  ok(B.EDITS.some((e) => e.id === 101 && e.html.startsWith('❌ Job not run')), JSON.stringify(B.EDITS));
});

// ---------------------------------------------------------------------------
console.log('\n5. Codex: counted for the load only');
// ---------------------------------------------------------------------------

await t('★ with 6 of 6 Claude workers busy and the usage gate up, a Codex job still starts', () => {
  B.reset();
  busy(6);
  B.setAdmission({ usage: HOLD });
  writeQueue([job('codex job', { engine: 'codex' })]);
  B.drainBgHandoff();
  eq(B.CODEX.length, 1, 'Codex spends no Claude slot and no Claude window');
});

await t('★ over the load limit, a Codex job waits like any other, with the load as its reason', async () => {
  B.reset();
  busy(1);
  B.setAdmission({ load: LOAD(41) });
  writeQueue([job('codex gate run', { engine: 'codex' })]);
  B.drainBgHandoff();
  eq(B.CODEX.length, 0, 'its gates load the same cores');
  await settle();
  ok(B.SENT[0]?.includes('📥 Queued · codex') && B.SENT[0].includes('waiting: machine load 41 is over 28'), B.SENT.join(' | '));
});

await t('★ a running Codex job counts toward the load gate: no Claude worker, one Codex run, load high, a Claude job waits', () => {
  B.reset();
  B.codexRuns.set('codex-1', {});
  B.setAdmission({ load: LOAD(41) });
  writeQueue([job('claude after codex')]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 0, 'the floor is any bridge job, Codex included');
});

await t('--now passes every gate: it is typed at dispatch by a person who looked', () => {
  B.reset();
  busy(6);
  B.setAdmission({ load: LOAD(90), usage: HOLD });
  writeQueue([job('urgent', { now: true })]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 1);
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
