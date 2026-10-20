#!/usr/bin/env node
// THE SCHEDULER'S TWO GAPS (self audit 2026-10-13, P8, approved by the owner):
//
//   A. A schedule entry the owner approved for writes (`schedule.mjs ... --run
//      --allow-write`, from their own chat) used to lose that approval the
//      moment its run handed the ship to a worker through bg.mjs, so a hook
//      holding unattended writes held the worker's first migration. Proved here
//      end to end with the real pieces: the spawn site's env (sliced out of
//      runClaude), the real bg.mjs run as a process, the real drain and the
//      real worker env contract, the keys such a hook reads (this repo ships
//      no hook of its own).
//
//   B. A scheduled run that died on a usage limit was retried only when the
//      death raised an all-accounts wall; one that died while the rotation
//      swapped, or could not swap, went to the chat lane and nothing ran it
//      again (#234, 2026-10-08). Now: exactly ONE retry, at the right time,
//      with a log line, never twice.
//
// ADMISSION_DIR=<an older export> runs the same tests against the code they
// replaced (names the older code lacks are stubbed, the rest are real).
//
//   node schedule-approval-retry.test.mjs

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.ADMISSION_DIR ? path.resolve(process.env.ADMISSION_DIR) : HERE;
const TMP = mkdtempSync(path.join(tmpdir(), 'schedule-approval-retry-'));
const QUEUE = path.join(TMP, 'bg-queue.json');
const BG = path.join(TMP, 'bg.mjs');
copyFileSync(path.join(DIR, 'bg.mjs'), BG);

let pass = 0;
let skipped = 0;
const failures = [];
const t = async (name, fn) => {
  try {
    const r = await fn();
    if (r === 'skip') skipped++;
    else pass++;
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

// THE SPAWN SITE'S ENV, sliced out of runClaude: from `const childEnv =
// workerEnv(` to the line before the spawn account. What a Claude worker of a
// scheduled run is actually given, by the code that gives it.
const pieceStart = SRC.findIndex((l) => /^\s+const childEnv = workerEnv\(process\.env, \{/.test(l));
const pieceEnd = SRC.findIndex((l, i) => i > pieceStart && /^\s+\/\/ Which account this process starts on/.test(l));
if (pieceStart === -1 || pieceEnd === -1) throw new Error('could not slice the spawn site env out of runClaude');
const SPAWN_PIECE = SRC.slice(pieceStart, pieceEnd).join('\n');

const HARNESS = `
import fs from 'node:fs';
import * as ADM from ${url('bg-admission.mjs')};
import * as NOTE from ${url('bg-notify.mjs')};
import * as CODEX from ${url('bg-codex.mjs')};
import * as WG from ${url('wall-guard.mjs')};
import * as WR from ${url('wall-resume.mjs')};
import * as ENV from ${url('worker-env.mjs')};
import { clip, oneLine } from ${url('progress-render.mjs')};
const GRANT = await import(${url('write-grant.mjs')}).catch(() => null);
const WAIT = await import(${url('bg-wait.mjs')}).catch(() => null);
const { readFileSync, renameSync, existsSync, writeFileSync } = fs;
const { maxConcurrentWorkers, mergeRequeue, queuedBlock, hasSlot, queueRows } = ADM;
export const admissionVerdict = ADM.admissionVerdict || null;
const admissionRows = ADM.admissionRows || ADM.queueRows;
const loadGate = ADM.loadGate || ((x) => ({ high: false, ...x }));
const { briefTitle, stripLaneRules } = NOTE;
const waitingLine = NOTE.waitingLine || (() => '');
const { parseEnginePrefix, fmtUntil } = CODEX;
const { createWallGuardStore, wallGuardSettings, baseRunId } = WG;
const { resumeCandidates, resumePlan, resumeTiming, resumeNote, resumeBrief, resumeQueueItem, sameJobTitle, SKIP } = WR;
export const workerEnv = ENV.workerEnv;
export const WRITE_GRANT_ENV = GRANT ? GRANT.WRITE_GRANT_ENV : 'LEASH_WRITE_GRANT';
export const writeGrants = GRANT ? GRANT.createWriteGrantStore({ file: ${JSON.stringify(path.join(TMP, 'write-grants.json'))} }) : { issue: () => null, verify: () => false };
const waitKey = WAIT ? WAIT.waitKey : () => null;
let bgWait = WAIT ? WAIT.createBgWaitStore({ file: ${JSON.stringify(path.join(TMP, 'bg-wait.json'))} }) : null;
export const LOGS = [];
const console = { log: (...a) => LOGS.push(a.join(' ')), error: (...a) => LOGS.push(a.join(' ')) };
const BG_QUEUE_FILE = ${JSON.stringify(QUEUE)};
const OWNER_TZ = 'America/Toronto';
const BRIDGE_NAME = 'Leash';
const MAX_CONCURRENT_WORKERS = 6;

// ---- the drain's world ----
export const DISPATCH_OPTS = [];
export const bgLanes = [];
let laneSeq = 0;
const getBgLane = () => { laneSeq++; const lane = { name: 'bg' + laneSeq, isBg: true, current: { startedAt: 5000 + laneSeq }, queue: [] }; bgLanes.push(lane); return lane; };
function bgWorkerDescriptors() { return []; }
const dispatchPrompt = (text, lane, opts = {}) => { DISPATCH_OPTS.push({ text, ...opts }); };
const engineFor = (lane, forced) => ({ engine: forced || 'claude', reason: 'default' });
const codexWalled = () => false;
const holdBgJob = () => true;
const logAccountDecision = (d) => LOGS.push('decision ' + JSON.stringify(d));
const raiseClaudeWall = () => Promise.resolve();
const armWallResume = () => {};
export const SENT = [];
const send = (text) => { SENT.push(text); return Promise.resolve({ message_id: SENT.length }); };
const editProgress = () => Promise.resolve();
const escHtml = (s) => String(s);
const recordBgResult = () => {};
const noteWallGuardJob = () => {};
const claudeMissingLine = () => 'no claude';
const CODEX_MISSING_LINE = 'no codex';
const startCodexJob = () => ({ runId: 'codex-1', transport: 'exec' });
const codexRuns = new Map();
const briefRepo = () => 'repo';
const codexCwdForBrief = () => ${JSON.stringify(TMP)};
const lintCodexBrief = () => [];
const startWorkerNotice = () => Promise.resolve();
const codexReasonText = () => '';
const codexCardSettings = () => ({});
const chatState = () => ({ cwd: ${JSON.stringify(TMP)} });
const CODEX_LANE = 'codex';
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const BG_MODEL = 'opus';
const DEFAULT_EFFORT = 'high';
const admissionNow = () => ({ load: null, usage: null, now: Date.now(), fmtClock: (ms) => new Date(ms).toISOString().slice(11, 16) });
export let SCHEDULES = { nextId: 1, items: [] };
export const setSchedules = (items) => { SCHEDULES = { nextId: 1, items }; };
const loadSchedules = () => JSON.parse(JSON.stringify(SCHEDULES));

// ---- the limit death's world ----
export const wallGuard = createWallGuardStore({ file: ${JSON.stringify(path.join(TMP, 'wall-guard.json'))} });
const wallGuardNow = () => wallGuardSettings(undefined);
const bgDraftPath = (id) => ${JSON.stringify(TMP)} + '/' + id + '.draft.md';
const bgReportPath = (id) => ${JSON.stringify(TMP)} + '/' + id + '.md';
const bgRunLogPath = (id) => ${JSON.stringify(TMP)} + '/' + id + '.jsonl';
const inflight = { read: () => ({}) };
const pidAlive = () => false;
const readHeldBgJobs = () => [];
const queuedBgJobRows = () => [];
export let ROT = { outcome: 'swapped', lines: ['Swapped to the next account. The account is live.'], activeName: 'a', nextName: 'b', reset: null };
export const setRot = (v) => { ROT = { lines: ['rotation line'], activeName: 'a', nextName: 'b', reset: null, ...v }; };
const rotateOffLimitedAccount = async () => ({ ...ROT, lines: [...ROT.lines] });
const rotationBehindCooldown = async () => null;
const swapFailedLine = () => 'swap failed';
const runSalvage = async () => 'SALVAGE';
export const HANDBACKS = [];
const handBackToChat = (task, text, status, runId) => { HANDBACKS.push({ task, text, status, runId }); };
export let DRAINS = 0;
const drainBgHandoff = () => { DRAINS++; };
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        // the drain, under its own name, so the limit death's stub keeps its name
        must('bgStrandedJobs', 'let'),
        must('runningBgWorkers'),
        must('runningResumedWorkers'),
        must('requeueDeferredBgJobs'),
        real('BG_WAIT_EDIT_MS', 'const BG_WAIT_EDIT_MS = 600000;', 'const'),
        real('bridgeJobsRunning', 'function bridgeJobsRunning(n = 0) { return Number(n) || 0; }'),
        real('noteBgWaiting', 'function noteBgWaiting() {}'),
        real('takeBgWaiting', 'function takeBgWaiting() { return null; }'),
        // This build keeps a Claude slash command off an unchosen Codex in
        // the drain: the two names it reads for that, as real code.
        must('BG_COMMAND_RE', 'const'),
        must('unchosenCodex', 'const'),
        must('drainBgHandoff').replace(/^function drainBgHandoff\(/, 'function realDrain('),
        must('scheduleApprovesWrites'),
        must('noteWallDeath'),
        must('readCheckpointCommit'),
        must('runIsAlive'),
        must('activeJobTitles'),
        must('queueResumeJobs'),
        must('resumeWallDeaths'),
        real('SCHEDULED_RETRY_MAX', 'const SCHEDULED_RETRY_MAX = 99;', 'const'),
        real('scheduledRetryFor', 'function scheduledRetryFor() { return null; }'),
        must('handleLimitDeath'),
        // The spawn site's env, as a function of what runClaude knows at that line.
        `export function spawnEnv({ baseEnv = {}, schedule = null, isBgLane = true, startedAt = 1, laneName = 'bg' } = {}) {
           const process = { env: baseEnv };
           const lane = { name: laneName };
           const draftPath = isBgLane ? '/tmp/draft.md' : null;
           ${SPAWN_PIECE}
           return childEnv;
         }`,
        'export { realDrain, handleLimitDeath, resumeWallDeaths, noteWallDeath, scheduleApprovesWrites };',
      ].join('\n'),
    )
);

const readQueue = () => (existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, 'utf8')) : []);
const clearQueue = () => writeFileSync(QUEUE, '[]');

/** Run the real bg.mjs (copied from DIR) the way a worker does, with this env. */
function runBg(text, env) {
  clearQueue();
  const clean = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(TMP, 'home') };
  execFileSync(process.execPath, [BG, text], { env: { ...clean, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return readQueue();
}
// The contract keys only: what a hook sees of a worker's env.
const contract = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('LEASH_') || k === 'TMUX'));


console.log(`scheduler approval and retry against ${DIR === HERE ? 'this tree' : DIR}${MISSING.length ? ` (stubbed, absent there: ${MISSING.join(', ')})` : ''}`);

// ===========================================================================
console.log('\nA. the write approval through a bg.mjs handoff');
// ===========================================================================

const APPROVED = { id: 233, kind: 'once', run: true, allowWrite: true, text: 'wait out the window, then dispatch the #377 ship' };
const NOT_APPROVED = { id: 300, kind: 'once', run: true, text: 'a scheduled check' };
const SHIP = 'LANE RULES\n\n--- TASK ---\n\n# Ship #377: apply migrations 00198 to 00200';

let child = null;
await t('★ an approved scheduled run hands its ship to a worker, and the WORKER keeps the approval', () => {
  B.setSchedules([APPROVED, NOT_APPROVED]);
  // 1. the scheduled run itself, as the spawn site starts it
  const parentEnv = B.spawnEnv({ schedule: { id: 233, allowWrite: true }, startedAt: 101 });
  eq(parentEnv.LEASH_ALLOW_WRITE, '1', 'the scheduled run itself is approved (unchanged)');
  // 2. it runs bg.mjs (the real one) to hand the ship over
  const q = runBg(SHIP, contract(parentEnv));
  eq(q.length, 1);
  eq(String(q[0].scheduleId), '233');
  // 3. the real drain starts the worker
  B.DISPATCH_OPTS.length = 0;
  B.realDrain();
  eq(B.DISPATCH_OPTS.length, 1, 'the ship was dispatched');
  // 4. the worker's env, from the spawn site, with what the drain passed
  child = B.spawnEnv({ schedule: B.DISPATCH_OPTS[0].schedule, startedAt: 202 });
  eq(child.LEASH_TRIGGER, 'schedule', 'still an unattended run');
  eq(child.LEASH_SCHEDULE_ID, '233');
  eq(child.LEASH_ALLOW_WRITE, '1', 'the approval reached the worker that does the writes');
});

await t('and the worker it hands to in turn keeps it too (a fresh grant per run)', () => {
  ok(child, 'needs the test above');
  const q = runBg(SHIP.replace('Ship', 'Verify'), contract(child));
  B.DISPATCH_OPTS.length = 0;
  B.realDrain();
  eq(B.spawnEnv({ schedule: B.DISPATCH_OPTS[0].schedule }).LEASH_ALLOW_WRITE, '1', JSON.stringify(q));
});

await t('★ an UNAPPROVED scheduled run that sets the flag and another entry\'s id by hand gets nothing', () => {
  const parentEnv = B.spawnEnv({ schedule: { id: 300, allowWrite: false }, startedAt: 103 });
  ok(!parentEnv.LEASH_ALLOW_WRITE, 'not approved');
  runBg(SHIP, { ...contract(parentEnv), LEASH_ALLOW_WRITE: '1', LEASH_SCHEDULE_ID: '233' });
  B.DISPATCH_OPTS.length = 0;
  B.realDrain();
  eq(B.DISPATCH_OPTS[0].schedule.allowWrite, false, 'a forged id must not launder #233 approval');
});

await t('★ a grant minted for ANOTHER approved entry does not carry to this one', () => {
  const other = B.writeGrants.issue(235, 'bg-other');
  writeFileSync(QUEUE, JSON.stringify([{ text: SHIP, queuedAt: 'x', scheduleId: '233', allowWrite: true, writeGrant: other || 'none' }]));
  B.DISPATCH_OPTS.length = 0;
  B.realDrain();
  eq(B.DISPATCH_OPTS[0].schedule.allowWrite, false);
});

await t('★ a revocation after the run started wins over the grant it holds', () => {
  const parentEnv = B.spawnEnv({ schedule: { id: 233, allowWrite: true }, startedAt: 104 });
  runBg(SHIP, contract(parentEnv));
  B.setSchedules([{ ...APPROVED, allowWrite: undefined }, NOT_APPROVED]); // update 233 --allow-write false
  B.DISPATCH_OPTS.length = 0;
  B.realDrain();
  eq(B.DISPATCH_OPTS[0].schedule.allowWrite, false);
  B.setSchedules([APPROVED, NOT_APPROVED]);
});

await t('a garbage grant, or none, carries nothing', () => {
  writeFileSync(QUEUE, JSON.stringify([
    { text: SHIP, queuedAt: 'a', scheduleId: '233', allowWrite: true, writeGrant: 'deadbeef' },
    { text: SHIP + ' 2', queuedAt: 'b', scheduleId: '233', allowWrite: true },
  ]));
  B.DISPATCH_OPTS.length = 0;
  B.realDrain();
  eq(B.DISPATCH_OPTS.map((o) => o.schedule.allowWrite).join(','), 'false,false');
});

await t('a grant never reaches a run that is not approved, nor the chat lane', () => {
  ok(!B.spawnEnv({ schedule: { id: 300, allowWrite: false } })[B.WRITE_GRANT_ENV], 'unapproved');
  ok(!B.spawnEnv({ schedule: null })[B.WRITE_GRANT_ENV], 'an ordinary worker');
  ok(!B.spawnEnv({ schedule: { id: 233, allowWrite: true }, isBgLane: false })[B.WRITE_GRANT_ENV], 'the chat lane');
  ok(!B.spawnEnv({ baseEnv: { [B.WRITE_GRANT_ENV]: 'leaked' }, schedule: null })[B.WRITE_GRANT_ENV], 'a leaked one is scrubbed');
});

// ===========================================================================
console.log('\nB. a scheduled run that dies on a usage limit: one retry, never two');
// ===========================================================================

const LIMIT = { answer: "You've hit your session limit · resets 3pm (America/Toronto)" };
const DISPATCHER = 'LANE RULES\n\n--- TASK ---\n\n# Directory Part 2 dispatcher\n\nCheck usage, then queue the collect brief through bg.mjs.';

await t('★ died while the rotation SWAPPED: its one retry is queued now, logged, and the assistant is told not to relaunch', async () => {
  clearQueue();
  B.setRot({ outcome: 'swapped' });
  B.wallGuard.job('bg5-1000', { scheduleId: 234, allowWrite: false });
  const drainsBefore = B.DRAINS;
  await B.handleLimitDeath(DISPATCHER, LIMIT, 'bg5-1000');
  const q = readQueue();
  eq(q.length, 1, 'nothing ran it again before (#234, 2026-10-08)');
  eq(String(q[0].scheduleId), '234', 'the retry keeps its scheduled run mark');
  eq(q[0].resumeOf, 'bg5-1000');
  ok(/\(auto resume 1 of 1\)/.test(q[0].text), 'its brief says it is the one and only retry');
  eq(B.DRAINS, drainsBefore + 1, 'started now, through the drain and its gates');
  ok(B.LOGS.some((l) => l.includes('scheduled run bg5-1000 (#234)') && l.includes('one retry is queued now')), B.LOGS.join('\n'));
  ok(B.HANDBACKS.at(-1).text.includes('Do NOT relaunch this scheduled run'), B.HANDBACKS.at(-1).text);
});

await t('★ no double run: the same death reported again queues nothing more', async () => {
  await B.handleLimitDeath(DISPATCHER, LIMIT, 'bg5-1000');
  eq(readQueue().length, 1);
});

await t('★ never twice: the retry dies on a limit too, and goes to the assistant instead of a third window', async () => {
  const retryText = readQueue()[0].text;
  clearQueue();
  B.wallGuard.job('bg6-2000', { scheduleId: 234, resumeOf: 'bg5-1000', resumeCount: 1, resumeRoot: 'bg5-1000' });
  await B.handleLimitDeath(retryText, LIMIT, 'bg6-2000');
  eq(readQueue().length, 0, 'not queued again');
  ok(B.HANDBACKS.at(-1).text.includes('NOT retried automatically') && B.HANDBACKS.at(-1).text.includes('retried once'), B.HANDBACKS.at(-1).text);
});

await t('★ the swap FAILED: the retry waits for the reset, and says so as its reason', async () => {
  clearQueue();
  const resetSec = Math.floor(Date.now() / 1000) + 3600;
  B.setRot({ outcome: 'swap_failed', reset: { resetsAt: resetSec, guessed: false } });
  B.wallGuard.job('bg7-3000', { scheduleId: 235 });
  const drainsBefore = B.DRAINS;
  await B.handleLimitDeath(DISPATCHER.replace('Part 2', 'Part 3'), LIMIT, 'bg7-3000');
  const q = readQueue();
  eq(q.length, 1);
  eq(q[0].notBefore, resetSec * 1000, 'not before the account it died on resets');
  eq(B.DRAINS, drainsBefore, 'not started now: the same account is still spent');
  ok(B.admissionVerdict, 'admissionVerdict');
  const early = B.admissionVerdict({ notBefore: q[0].notBefore, now: Date.now(), running: 0, max: 6 });
  eq(early.kind, 'retry');
  ok(early.text.startsWith('waiting: its one retry starts at'), early.text);
  eq(B.admissionVerdict({ notBefore: q[0].notBefore, now: q[0].notBefore + 1, running: 0, max: 6 }).admit, true, 'and starts by itself after it');
});

await t('★ died ON THE WALL: the lift retries it once ("1 of 1"), and a second wall death is not retried', async () => {
  clearQueue();
  B.setRot({ outcome: 'exhausted' });
  B.wallGuard.job('bg8-4000', { scheduleId: 236 });
  await B.handleLimitDeath(DISPATCHER.replace('Part 2', 'Part 4'), LIMIT, 'bg8-4000');
  eq(readQueue().length, 0, 'nothing now: the lift does it');
  let at = Date.now();
  const lift = B.resumeWallDeaths({ raisedAt: at - 1000, workers: [] }, { readyAt: at, now: at });
  eq(lift.resumed.length, 1);
  const q = readQueue();
  ok(/\(auto resume 1 of 1\)/.test(q[0].text), q[0]?.text?.split('\n').find((l) => l.startsWith('#')));
  clearQueue();
  B.wallGuard.job('bg9-5000', { scheduleId: 236, resumeOf: 'bg8-4000', resumeCount: 1, resumeRoot: 'bg8-4000' });
  await B.handleLimitDeath(q[0].text, LIMIT, 'bg9-5000');
  ok(B.HANDBACKS.at(-1).text.includes('is NOT retried automatically (this run was its one retry)'), 'the assistant is told it is not retried, not promised a retry');
  at = Date.now();
  const again = B.resumeWallDeaths({ raisedAt: at - 1000, workers: [] }, { readyAt: at, now: at });
  eq(again.resumed.length, 0, 'a scheduled run is retried once');
  eq(readQueue().length, 0);
});

await t('a scheduled run that wrote its final report is not retried (its report is the outcome)', async () => {
  clearQueue();
  B.setRot({ outcome: 'swapped' });
  B.wallGuard.job('bg10-6000', { scheduleId: 238 });
  await B.handleLimitDeath(DISPATCHER.replace('Part 2', 'Part 6'), LIMIT, 'bg10-6000', [], null, { finalReportSeen: true });
  eq(readQueue().length, 0);
});

await t('an ordinary (unscheduled) worker that dies while the rotation swaps is unchanged: back to the assistant', async () => {
  clearQueue();
  B.setRot({ outcome: 'swapped' });
  B.wallGuard.job('bg11-7000', { account: 'a' });
  await B.handleLimitDeath('LANE RULES\n\n--- TASK ---\n\n# ordinary job', LIMIT, 'bg11-7000');
  eq(readQueue().length, 0);
  ok(!B.HANDBACKS.at(-1).text.includes('Do NOT relaunch'), 'an ordinary worker is not told a retry is queued for it');
  ok(B.HANDBACKS.at(-1).text.includes('ACCOUNT ROTATION'), 'the rotation block, as before');
});

await t('★ an APPROVED scheduled run keeps its approval through its retry (a fresh grant)', async () => {
  clearQueue();
  B.setSchedules([{ id: 237, kind: 'once', run: true, allowWrite: true, text: 'x' }]);
  B.setRot({ outcome: 'swapped' });
  B.writeGrants.issue(237, 'bg12-8000');
  B.wallGuard.job('bg12-8000', { scheduleId: 237, allowWrite: true });
  await B.handleLimitDeath(DISPATCHER.replace('Part 2', 'Part 7'), LIMIT, 'bg12-8000');
  const q = readQueue();
  eq(q.length, 1);
  eq(q[0].allowWrite, true);
  ok(q[0].writeGrant?.signature, 'the retry carries a signed child proof');
  B.DISPATCH_OPTS.length = 0;
  B.realDrain();
  eq(B.DISPATCH_OPTS[0].schedule.allowWrite, true);
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
