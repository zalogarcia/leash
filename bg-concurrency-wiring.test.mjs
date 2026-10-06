#!/usr/bin/env node
// Wiring tests for the background concurrency cap: the REAL drainBgHandoff out
// of bridge.mjs, run against stubs and a real temp drop box.
//
// bg-admission.test.mjs proves the pure decisions are right. Existence is not
// implementation: this proves the daemon actually OBEYS them, on the one path
// that matters, and it is the half that would have caught the 2026-09-21
// incident had the cap existed.
//
//   ★ at the cap, the fourth job is QUEUED rather than run, and rather than
//     refused (a rejection would break the documented "hand off as many as you
//     like" promise silently, mid day)
//   ★ a finishing worker frees a slot and the next drain starts the next job
//   ★ FIFO holds across the deferral: the queued job goes back to the FRONT
//   ★ a daemon RESTART does not lose a queued job, because the queue is the
//     drop box file and a fresh drain reads it
//   ★ Codex jobs are not capped and do not consume a Claude slot
//   ★ --now runs past the cap, and only when it is on the item
//   ★ nothing is EVER dropped: a brief claimed out of the file always ends up
//     dispatched or back on disk
//
// bridge.mjs runs main() only as an entry point, but it is still extracted by
// source and evaluated against stubs, the same trick test.mjs and
// bg-codex-wiring.test.mjs use. Never `import('./bridge.mjs')`: that booted a
// second daemon and stole the live one's steer socket (2026-09-05).
//
//   node bg-concurrency-wiring.test.mjs

import { mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), 'bg-concurrency-'));
const QUEUE = path.join(TMP, 'bg-queue.json');

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
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------------------
// Extract the real functions out of bridge.mjs.
// ---------------------------------------------------------------------------
const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^(?:const|let) ${name}\\b`);
  const start = SRC.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  const out = [SRC[start]];
  // A one-line declaration (`let x = [];`) is the whole thing.
  if (kind !== 'function' && /;\s*$/.test(SRC[start])) return SRC[start];
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

const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);

// Every stub the extracted drain closes over. They record rather than act, so a
// dispatch is observable without spawning anything.
const HARNESS = `
import fs from 'node:fs';
import { hasSlot, maxConcurrentWorkers, mergeRequeue, queueRows, queuedBlock } from ${url('bg-admission.mjs')};
import { parseEnginePrefix } from ${url('bg-codex.mjs')};
import { briefTitle, stripLaneRules } from ${url('bg-lane-rules.mjs')};
// The REAL due-logic, not a mirror: checkSchedules is under test here as the
// SECOND path into the cap, and a stub of "is it due yet" would keep agreeing
// with itself after schedule-due.mjs changed.
import { describeWhen, isDailyDue } from ${url('schedule-due.mjs')};
const { readFileSync, renameSync, existsSync } = fs;
// writeFileSync is wrapped rather than passed through, so the drops-open path
// (a schedule that could not be written to the drop box must START rather than
// vanish) is reachable. Off by default: every other test here writes for real.
export let FAIL_WRITE = false;
export const setFailWrite = (v) => { FAIL_WRITE = v; };
const writeFileSync = (p, text) => {
  if (FAIL_WRITE) throw new Error('disk full');
  return fs.writeFileSync(p, text);
};

const BG_QUEUE_FILE = ${JSON.stringify(QUEUE)};
export let MAX_CONCURRENT_WORKERS = 3;
export const setCap = (n) => { MAX_CONCURRENT_WORKERS = n; };

// The observable results of a drain.
export const DISPATCHED = [];   // Claude workers started
export const CODEX = [];        // Codex runs started
export const HELD = [];         // jobs parked behind a wall
export const SENT = [];         // refusals that reached the chat
export const RESULTS = [];      // bg-results rows

// A fake worker pool. Each "running" worker is a lane holding a current run,
// which is exactly the shape runningBgWorkers counts in the daemon.
export const bgLanes = [];
let laneSeq = 0;
export const startFakeWorker = (prompt) => {
  laneSeq++;
  const lane = { name: laneSeq === 1 ? 'bg' : 'bg' + laneSeq, isBg: true, n: laneSeq, current: { startedAt: Date.now() + laneSeq, prompt, steps: 0 }, queue: [], finishing: 0 };
  bgLanes.push(lane);
  return lane;
};
export const finishFakeWorker = () => {
  const lane = bgLanes.find((l) => l.current);
  if (lane) lane.current = null;
  return lane;
};
export const resetPool = () => { RESUMED_RUNS.clear(); bgLanes.length = 0; laneSeq = 0; DISPATCHED.length = 0; CODEX.length = 0; HELD.length = 0; SENT.length = 0; RESULTS.length = 0; DISPATCH_OPTS.length = 0; NOTICES.length = 0; SAVED.length = 0; SCHEDULES = { nextId: 1, items: [] }; FAIL_WRITE = false; };

// runningBgWorkers reads this, so the real counter is under test too.
function bgWorkerDescriptors() {
  return bgLanes.filter((l) => l.isBg && l.current).map((l) => ({ runId: l.name + '-' + l.current.startedAt, lane: l.name, engine: 'claude' }));
}
const getBgLane = () => startFakeWorker('(pending)');
// The options ride along too: the scheduled run mark is threaded through them.
export const DISPATCH_OPTS = [];
const dispatchPrompt = (text, lane, opts = {}) => { DISPATCHED.push(text); DISPATCH_OPTS.push(opts); if (lane) lane.current.prompt = text; };

// Engine resolution, driven by the test rather than by the daemon's state.
export let ENGINE = (forced) => ({ engine: forced || 'claude', reason: forced ? 'explicit' : 'default' });
export const setEngine = (fn) => { ENGINE = fn; };
const engineFor = (lane, forced) => ENGINE(forced);
const unchosenCodex = (d) => d.reason === 'claude_limited' || d.reason === 'claude_missing';
const BG_COMMAND_RE = /^\\/(goal|autopilot|qa-loop|bug|go-live|autopilot-merge)\\b/i;

const holdBgJob = (item) => { HELD.push(item); return true; };
const logAccountDecision = () => {};
const raiseClaudeWall = () => Promise.resolve();
const armWallResume = () => {};
const send = (text) => { SENT.push(text); return Promise.resolve(); };
const recordBgResult = (task, outcome) => { RESULTS.push({ task, outcome }); };
// THE WALL GUARD'S DISPATCH RECORD: recorded; its use is
// wall-guard-wiring.test.mjs's subject.
export const WALL_JOBS = [];
// The guard's record of which running jobs are RESUMES, as the daemon keeps it
// (wall-guard.mjs jobOf): runningResumedWorkers, the REAL function, reads it.
const RESUMED_RUNS = new Map();
const wallGuard = { jobOf: (runId) => RESUMED_RUNS.get(runId) || null };
export const failResumedCount = (v) => { wallGuard.jobOf = v ? () => { throw new Error('record unreadable'); } : (runId) => RESUMED_RUNS.get(runId) || null; };
const noteWallGuardJob = (runId, it) => { WALL_JOBS.push({ runId, cwd: it?.cwd || null }); if (it?.resumeOf) RESUMED_RUNS.set(runId, { resumeOf: it.resumeOf }); };
const claudeMissingLine = () => 'no claude';
const CODEX_MISSING_LINE = 'no codex';
const startCodexJob = (text, opts) => { CODEX.push({ text, opts }); return { runId: 'codex-' + CODEX.length, transport: 'exec', startedAt: Date.now() }; };
const codexRuns = new Map();
const briefRepo = () => 'repo';
const codexCwdForBrief = () => ${JSON.stringify(TMP)};
const lintCodexBrief = () => [];
export const NOTICES = [];
const startWorkerNotice = (runId, head) => { NOTICES.push({ runId, head }); return Promise.resolve(); };
const codexReasonText = () => '';
const codexCardSettings = () => ({});
const chatState = () => ({ cwd: ${JSON.stringify(TMP)} });
const CODEX_LANE = 'codex';
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const OWNER_TZ = 'UTC';
const claudeCardSettings = () => ({ model: 'opus', effort: 'high' });
export const stranded = () => bgStrandedJobs;
export const setStranded = (v) => { bgStrandedJobs = v; };

// THE SCHEDULE STORE, in memory. checkSchedules is the SECOND path into the
// cap and the only UNATTENDED one, so it runs here against the same real
// drop box, the same real runningBgWorkers and the same real hasSlot the
// drain does. A mirror of any of those would keep agreeing with itself.
export let SCHEDULES = { nextId: 1, items: [] };
export const setSchedules = (items) => { SCHEDULES = { nextId: items.length + 1, items }; };
export const SAVED = [];
const loadSchedules = () => JSON.parse(JSON.stringify(SCHEDULES));
const saveSchedules = (v) => { SAVED.push(v); SCHEDULES = v; };
const localToday = () => '2026-09-21';
const localHHMM = () => '03:00';
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        grab('bgStrandedJobs', 'let'),
        grab('runningBgWorkers'),
        grab('runningResumedWorkers'),
        grab('requeueDeferredBgJobs'),
        grab('queuedBgJobRows'),
        grab('drainBgHandoff'),
        grab('scheduleApprovesWrites'),
        grab('queueScheduledRun'),
        grab('checkSchedules'),
        'export { drainBgHandoff, runningBgWorkers, runningResumedWorkers, requeueDeferredBgJobs, queuedBgJobRows, queueScheduledRun, checkSchedules };',
      ].join('\n'),
    )
);

const writeQueue = (items) => writeFileSync(QUEUE, JSON.stringify(items, null, 2));
const readQueue = () => JSON.parse(readFileSync(QUEUE, 'utf8'));
const job = (name, extra = {}) => ({ text: `LANE RULES\n\n--- TASK ---\n\n${name}`, queuedAt: name, ...extra });
const titleOf = (text) => String(text).split('--- TASK ---')[1]?.trim() || text;

// ---------------------------------------------------------------------------
console.log('\n1. under the cap, everything runs (the behaviour that must not change)');
// ---------------------------------------------------------------------------

B.resetPool();
B.setCap(3);
writeQueue([job('A'), job('B'), job('C')]);
B.drainBgHandoff();

t('three jobs, cap three: all three started', () => {
  eq(B.DISPATCHED.length, 3);
  eq(B.DISPATCHED.map(titleOf).join(','), 'A,B,C');
});

t('nothing was left in the drop box', () => {
  eq(readQueue().length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n2. ★ AT the cap, the fourth job queues rather than runs');
// ---------------------------------------------------------------------------

B.resetPool();
B.setCap(3);
writeQueue([job('A'), job('B'), job('C'), job('D')]);
B.drainBgHandoff();

t('★ exactly three started: this is the 2026-09-21 incident, prevented', () => {
  eq(B.DISPATCHED.length, 3, 'a fourth concurrent worker is what walled every account');
  eq(B.DISPATCHED.map(titleOf).join(','), 'A,B,C');
});

t('★ the fourth was QUEUED, not refused and not dropped', () => {
  const q = readQueue();
  eq(q.length, 1, 'the deferred brief exists nowhere else, so losing it destroys work');
  eq(titleOf(q[0].text), 'D');
});

t('no refusal reached the chat: the promise is "hand off as many as you like"', () => {
  eq(B.SENT.length, 0, B.SENT.join(' | '));
  eq(B.RESULTS.length, 0, 'a deferred job must not be recorded as a failed one');
});

t('the queued item keeps every field it arrived with', () => {
  eq(readQueue()[0].queuedAt, 'D');
});

// ---------------------------------------------------------------------------
console.log('\n3. ★ a finishing worker starts the next queued job');
// ---------------------------------------------------------------------------

B.finishFakeWorker(); // one of the three exits
B.drainBgHandoff();   // which is what the close handler does

t('★ the queued job started as soon as a slot freed', () => {
  eq(B.DISPATCHED.length, 4);
  eq(titleOf(B.DISPATCHED[3]), 'D');
});

t('and the drop box is empty again', () => {
  eq(readQueue().length, 0);
});

t('the pool is back at the cap, not over it', () => {
  eq(B.runningBgWorkers(), 3);
});

// ---------------------------------------------------------------------------
console.log('\n4. ★ FIFO holds across a deferral');
// ---------------------------------------------------------------------------

B.resetPool();
B.setCap(1);
writeQueue([job('first'), job('second')]);
B.drainBgHandoff();

t('one slot, two jobs: the first runs, the second waits', () => {
  eq(B.DISPATCHED.map(titleOf).join(','), 'first');
  eq(readQueue().map((q) => titleOf(q.text)).join(','), 'second');
});

// a third job arrives WHILE the second is waiting
writeQueue([...readQueue(), job('third')]);
B.finishFakeWorker();
B.drainBgHandoff();

t('★ the job that waited goes first, not the one that just arrived', () => {
  eq(titleOf(B.DISPATCHED[1]), 'second', 'an admission queue that reorders is a random scheduler');
  eq(readQueue().map((q) => titleOf(q.text)).join(','), 'third');
});

t('★ and the deferred job is written back to the FRONT of the file', () => {
  // The merge order is what makes the assertion above true on the NEXT drain
  // too, after a restart, when the in-memory order is gone.
  writeQueue([job('waited'), job('arrived')]);
  B.drainBgHandoff(); // 'waited' defers (pool full), 'arrived' defers behind it
  eq(readQueue().map((q) => titleOf(q.text)).join(','), 'waited,arrived');
});

// ---------------------------------------------------------------------------
console.log('\n5. ★ a daemon restart does not lose a queued job');
// ---------------------------------------------------------------------------

B.resetPool();
B.setCap(2);
writeQueue([job('running1'), job('running2'), job('survivor')]);
B.drainBgHandoff();

t('two started, one queued on disk', () => {
  eq(B.DISPATCHED.length, 2);
  eq(readQueue().map((q) => titleOf(q.text)).join(','), 'survivor');
});

t('★ the queue is a FILE, so it is still there with the process state wiped', () => {
  // This is the restart: the daemon dies, every lane and every in-memory list
  // goes with it, and the drop box on disk is all that is left.
  B.resetPool();
  eq(readQueue().map((q) => titleOf(q.text)).join(','), 'survivor', 'the brief did not survive the restart');
});

t('★ and the next daemon drains it', () => {
  B.drainBgHandoff();
  eq(B.DISPATCHED.map(titleOf).join(','), 'survivor');
  eq(readQueue().length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n6. ★ Codex is not capped, and does not consume a Claude slot');
// ---------------------------------------------------------------------------

B.resetPool();
B.setCap(1);
writeQueue([job('claude one'), job('codex one', { engine: 'codex' }), job('claude two')]);
B.drainBgHandoff();

t('★ the Codex job ran even with the Claude pool full', () => {
  eq(B.CODEX.length, 1, 'Codex is billed separately and is the fallback a walled job escapes to');
  eq(B.DISPATCHED.length, 1);
});

t('★ and it did not take the slot the second Claude job was waiting for', () => {
  eq(readQueue().map((q) => titleOf(q.text)).join(','), 'claude two');
});

// ---------------------------------------------------------------------------
console.log('\n7. ★ --now runs past the cap, and only when it is on the item');
// ---------------------------------------------------------------------------

B.resetPool();
B.setCap(1);
writeQueue([job('normal'), job('urgent', { now: true }), job('also normal')]);
B.drainBgHandoff();

t('★ the bypass job started even though the pool was full', () => {
  eq(B.DISPATCHED.map(titleOf).join(','), 'normal,urgent');
});

t('★ but it lifted the cap for itself only', () => {
  eq(readQueue().map((q) => titleOf(q.text)).join(','), 'also normal');
});

t('the bypass is never inferred: an item without the flag is capped', () => {
  B.resetPool();
  B.setCap(1);
  writeQueue([job('one'), job('two')]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 1);
});

// ---------------------------------------------------------------------------
console.log('\n7b. ★ a job resumed after a usage wall starts at its own pace (maxRunning on the item)');
// ---------------------------------------------------------------------------
// The afternoon of 2026-10-06: nine workers restarted at once after a wall,
// used the next five hour window in about ninety minutes and walled it too.
// The wall guard's resumes carry a pace; the REAL drain has to honour it. The
// pace counts the RESUMED jobs running, not the pool: a waiting resume must not
// hold back an ordinary job, and ordinary jobs must not starve a resume.

const resumed = (name) => job(name, { engine: 'claude', resumeOf: `bg-${name}`, resumeCount: 1, maxRunning: 4 });

B.resetPool();
B.setCap(10);
writeQueue([resumed('r1'), resumed('r2'), resumed('r3'), resumed('r4'), resumed('r5'), resumed('r6'), job('new job')]);
B.drainBgHandoff();

t('★ six resumes at a pace of four under a cap of ten: four start, and the ordinary job behind them starts too', () => {
  eq(B.DISPATCHED.map(titleOf).join(','), 'r1,r2,r3,r4,new job');
  eq(B.runningResumedWorkers(), 4, 'the real counter, off the guard record');
});

t('★ the two that wait are back in the drop box, in order, with every field they arrived with', () => {
  const q = readQueue();
  eq(q.map((x) => titleOf(x.text)).join(','), 'r5,r6');
  eq(q[0].maxRunning, 4);
  eq(q[0].resumeOf, 'bg-r5');
  eq(q[0].engine, 'claude');
});

t('★ ps says they are waiting, though the pool has five slots free', () => {
  const rows = B.queuedBgJobRows();
  eq(rows.map((r) => r.waiting).join(','), 'true,true');
  eq(rows.map((r) => r.waitPosition).join(','), '1,2');
});

t('★ a resumed worker finishing starts the next resume; the last one waits, never dropped', () => {
  B.finishFakeWorker(); // r1, the first lane
  B.drainBgHandoff();
  eq(B.DISPATCHED.map(titleOf).join(','), 'r1,r2,r3,r4,new job,r5');
  eq(readQueue().map((x) => titleOf(x.text)).join(','), 'r6');
  eq(B.runningResumedWorkers(), 4);
});

t('★ QA 2026-10-06: six ordinary workers and a steady stream of new handoffs do NOT starve a resume', () => {
  B.resetPool();
  B.setCap(10);
  for (let i = 0; i < 6; i++) B.startFakeWorker(`ordinary ${i}`);
  writeQueue([resumed('starved')]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.map(titleOf).join(','), 'starved', 'counted against the whole pool it waited forever behind six ordinary workers');
  eq(readQueue().length, 0);
});

t('★ and the ordinary cap still holds a resume: the pace is never a way past it', () => {
  B.resetPool();
  B.setCap(2);
  B.startFakeWorker('a');
  B.startFakeWorker('b');
  writeQueue([resumed('held by the cap')]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 0);
  eq(readQueue().map((x) => titleOf(x.text)).join(','), 'held by the cap');
  eq(B.queuedBgJobRows()[0].waiting, true);
});

t('★ a job cannot raise the cap with the same field', () => {
  B.resetPool();
  B.setCap(1);
  writeQueue([job('one'), job('greedy', { maxRunning: 50 })]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.map(titleOf).join(','), 'one');
  eq(readQueue().map((x) => titleOf(x.text)).join(','), 'greedy');
});

t('★ a guard record that cannot be read holds the resumes one cycle (a full pace), and ordinary jobs still start', () => {
  B.resetPool();
  B.setCap(10);
  B.startFakeWorker('already running'); // the count asks the record about each running worker
  B.failResumedCount(true);
  try {
    writeQueue([resumed('r1'), job('ordinary')]);
    B.drainBgHandoff();
    eq(B.DISPATCHED.map(titleOf).join(','), 'ordinary');
    eq(readQueue().map((x) => titleOf(x.text)).join(','), 'r1', 'waiting, not dropped');
  } finally {
    B.failResumedCount(false);
  }
  B.drainBgHandoff();
  eq(B.DISPATCHED.map(titleOf).join(','), 'ordinary,r1', 'and it starts on the next cycle');
});

// ---------------------------------------------------------------------------
console.log('\n8. ★ nothing is ever dropped');
// ---------------------------------------------------------------------------

t('★ every brief claimed out of the file is either dispatched or back on disk', () => {
  B.resetPool();
  B.setCap(2);
  const names = ['n1', 'n2', 'n3', 'n4', 'n5'];
  writeQueue(names.map((n) => job(n)));
  B.drainBgHandoff();
  const accounted = [...B.DISPATCHED.map(titleOf), ...readQueue().map((q) => titleOf(q.text))].sort();
  eq(accounted.join(','), names.join(','), 'a brief exists nowhere else once it is claimed');
});

t('★ a walled job is held, not counted against the cap and not lost', () => {
  B.resetPool();
  B.setCap(1);
  B.setEngine(() => ({ engine: 'claude', reason: 'claude_limited', pausedUntil: Date.now() + 3600_000 }));
  writeQueue([job('walled one'), job('walled two')]);
  B.drainBgHandoff();
  eq(B.HELD.length, 2, 'the wall owns these, not the cap');
  eq(B.DISPATCHED.length, 0);
  eq(readQueue().length, 0);
  B.setEngine((forced) => ({ engine: forced || 'claude', reason: forced ? 'explicit' : 'default' }));
});

t('a string item (the oldest drop-box shape) still works and still caps', () => {
  B.resetPool();
  B.setCap(1);
  writeQueue(['plain one', 'plain two']);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 1);
  eq(readQueue().length, 1);
  eq(readQueue()[0].text, 'plain two', 'a bare string is normalized on the way back, never dropped');
});

t('an empty or missing drop box is a no-op, not a crash', () => {
  B.resetPool();
  writeQueue([]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 0);
  writeFileSync(QUEUE, 'not json at all');
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 0);
  writeQueue([]);
});

// ---------------------------------------------------------------------------
console.log('\n9. the counter, and what ps reports');
// ---------------------------------------------------------------------------

t('runningBgWorkers counts live Claude workers', () => {
  B.resetPool();
  eq(B.runningBgWorkers(), 0);
  B.startFakeWorker('x');
  B.startFakeWorker('y');
  eq(B.runningBgWorkers(), 2);
  B.finishFakeWorker();
  eq(B.runningBgWorkers(), 1);
});

t('★ queuedBgJobRows reports what is waiting, with positions', () => {
  B.resetPool();
  B.setCap(2);
  B.startFakeWorker('x');
  B.startFakeWorker('y');
  writeQueue([job('waiter one'), job('waiter two')]);
  const rows = B.queuedBgJobRows();
  eq(rows.length, 2);
  eq(rows[0].waiting, true);
  eq(rows[0].waitPosition, 1);
  eq(rows[1].waitPosition, 2);
  ok(rows[0].title.includes('waiter one'), rows[0].title);
});

t('a queued Codex job is reported as not waiting', () => {
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('x');
  writeQueue([job('cx', { engine: 'codex' })]);
  const rows = B.queuedBgJobRows();
  eq(rows[0].engine, 'codex');
  eq(rows[0].waiting, false);
  writeQueue([]);
});

// ---------------------------------------------------------------------------
console.log('\n10. the write-back failure path: held, never dropped');
// ---------------------------------------------------------------------------

t('★ a deferred job that cannot be written back is retried on the next drain', () => {
  B.resetPool();
  B.setCap(1);
  // Simulate the failed rename by putting the item straight into the stranded
  // list, which is exactly what requeueDeferredBgJobs does on a write failure.
  B.setStranded([job('stranded one')]);
  writeQueue([]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.map(titleOf).join(','), 'stranded one', 'a stranded brief must reach a worker');
  eq(B.stranded().length, 0);
});

t('★ a stranded job goes in FRONT of whatever is in the drop box', () => {
  B.resetPool();
  B.setCap(1);
  B.setStranded([job('waited longest')]);
  writeQueue([job('just arrived')]);
  B.drainBgHandoff();
  eq(titleOf(B.DISPATCHED[0]), 'waited longest');
  eq(readQueue().map((q) => titleOf(q.text)).join(','), 'just arrived');
});

// ---------------------------------------------------------------------------
console.log('\n11. ★ a scheduled --run job obeys the same cap');
// ---------------------------------------------------------------------------
//
// The SECOND path into the cap, and the only unattended one: nobody types a
// schedule at 03:00. With hasSlot consulted only by the drop box, two `--run`
// schedules on the same `daily 03:00` would spawn two uncapped workers together
// every night on top of whatever the drop box was already running.
//
// The rule proved here is the same one section 2 proves for the drop box, and
// one more that only matters for a schedule: the schedule has ALREADY been
// consumed by the time the cap is consulted (lastFired stamped, or a `once`
// item removed), so a deferral that did not land in the drop box would be work
// that fired and went nowhere, with nothing on screen saying so.

const schedule = (over = {}) => ({ id: 8, kind: 'daily', at: '03:00', run: true, text: 'nightly report', ...over });

t('under the cap, a scheduled run still dispatches immediately', () => {
  B.resetPool();
  B.setCap(3);
  writeQueue([]);
  B.setSchedules([schedule()]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 1, 'the behaviour that must not change');
  eq(B.DISPATCHED[0], 'nightly report');
  eq(readQueue().length, 0, 'nothing should be parked when there was a slot');
  eq(B.NOTICES.length, 1, 'it still gets its worker card');
});

t('★ AT the cap, a scheduled run does not spawn a worker', () => {
  B.resetPool();
  B.setCap(2);
  B.startFakeWorker('a');
  B.startFakeWorker('b');
  writeQueue([]);
  B.setSchedules([schedule()]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 0, 'this is the 03:00 fleet overshoot, prevented');
  eq(B.runningBgWorkers(), 2, 'the pool must not grow past the cap');
});

t('★ and it is NOT lost: it is in the drop box the drain reads', () => {
  const q = readQueue();
  eq(q.length, 1, 'the schedule was already consumed, so losing it here is lost work');
  eq(q[0].text, 'nightly report');
  eq(q[0].scheduleId, 8, 'the queued item names the schedule that produced it');
  ok(q[0].queuedAt, 'it needs a FIFO stamp like any other queued job');
});

t('★ the owner is told it is queued, naming the schedule and the reason', () => {
  eq(B.SENT.length, 1, B.SENT.join(' | '));
  const lines = B.SENT[0].split('\n');
  eq(lines[0], '⏰ #8 · daily 03:00 · 📥 queued');
  eq(lines[2], '2 of 2 workers busy · it starts when a slot frees');
  ok(!B.SENT[0].includes('⏳'), 'a ⏳ with no resolution path here would be a line that lies');
  eq(B.NOTICES.length, 0, 'no worker card: there is no worker yet');
});

t('★ the schedule is still marked fired, so it does not queue twice a minute later', () => {
  eq(B.SAVED.at(-1).items[0].lastFired, '2026-09-21');
  B.checkSchedules(); // the very next poll cycle, same clock
  eq(readQueue().length, 1, 'a second copy of the same nightly job would be a duplicate run');
});

t('★ a freed slot starts it through the normal drain: deferred, never dropped', () => {
  B.finishFakeWorker();
  B.drainBgHandoff(); // what the close handler does
  eq(B.DISPATCHED.length, 1);
  eq(B.DISPATCHED[0], 'nightly report');
  eq(readQueue().length, 0);
});

t('★ it QUEUES behind the handoffs already waiting, it does not jump them', () => {
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('busy');
  writeQueue([job('handed off first'), job('handed off second')]);
  B.setSchedules([schedule()]);
  B.checkSchedules();
  const titles = readQueue().map((q) => (q.scheduleId ? 'SCHEDULE' : titleOf(q.text)));
  eq(titles.join(','), 'handed off first,handed off second,SCHEDULE', 'a cron must not overtake a job the owner is waiting on');
});

t('★ two schedules firing at the same minute take one slot, not two', () => {
  // Two schedules on the same `daily 03:00` minute are an ordinary store,
  // which is what makes this reachable with nobody at the keyboard.
  B.resetPool();
  B.setCap(1);
  writeQueue([]);
  B.setSchedules([schedule({ id: 8 }), schedule({ id: 23, text: 'nightly backup check' })]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 1, 'the second must wait, not double the fleet');
  eq(B.DISPATCHED[0], 'nightly report');
  const q = readQueue();
  eq(q.length, 1);
  eq(q[0].scheduleId, 23);
});

t('a `once` schedule at the cap is removed from the store AND queued', () => {
  // The one that could really vanish: a fired `once` item is gone from
  // schedules.json, so the drop box is the only copy left.
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('busy');
  writeQueue([]);
  B.setSchedules([{ id: 31, kind: 'once', at: Date.now() - 1000, run: true, text: 'one off audit' }]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 0);
  eq(B.SAVED.at(-1).items.length, 0, 'a fired once-item is gone from the store');
  eq(readQueue()[0].text, 'one off audit', 'so the drop box is the only copy left');
});

t('a plain reminder is never capped: it spawns nothing', () => {
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('busy');
  writeQueue([]);
  B.setSchedules([schedule({ id: 4, run: false, text: 'call the accountant' })]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 0);
  eq(readQueue().length, 0, 'a reminder is a message, not a worker');
  eq(B.SENT[0], '⏰ Reminder: call the accountant');
});

t('a scheduled run settled to Codex is not capped, same as the drop box', () => {
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('busy');
  writeQueue([]);
  B.setEngine(() => ({ engine: 'codex', reason: 'explicit' }));
  B.setSchedules([schedule()]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 1, 'Codex is billed separately and is the walled job escape hatch');
  eq(readQueue().length, 0);
  B.setEngine((forced) => ({ engine: forced || 'claude', reason: forced ? 'explicit' : 'default' }));
});

t('★ a drop box that cannot be written STARTS the job rather than losing it', () => {
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('busy');
  writeQueue([]);
  B.setFailWrite(true);
  B.setSchedules([schedule()]);
  B.checkSchedules();
  B.setFailWrite(false);
  eq(B.DISPATCHED.length, 1, 'one worker over the cap is a pacing miss; a lost nightly job is lost work');
  eq(B.DISPATCHED[0], 'nightly report');
  writeQueue([]);
});

// ---------------------------------------------------------------------------
console.log('\n12. ★ a scheduled run is MARKED as one, on both paths it can take');
// ---------------------------------------------------------------------------
// A hook must be able to tell an unattended scheduled run from a worker the
// user asked for. The mark is `schedule: { id, allowWrite }` on the dispatch,
// which runClaude turns into LEASH_TRIGGER / LEASH_SCHEDULE_ID /
// LEASH_ALLOW_WRITE (worker-env.test.mjs pins that half). A scheduled job
// reaches runClaude either DIRECTLY or through the drop box when the pool is
// full, and the mark has to survive both.

t('★ the direct path marks the dispatch with the entry id', () => {
  B.resetPool();
  B.setCap(3);
  writeQueue([]);
  B.setSchedules([schedule({ id: 8 })]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 1);
  eq(JSON.stringify(B.DISPATCH_OPTS[0].schedule), JSON.stringify({ id: 8, allowWrite: false }));
  eq(B.DISPATCH_OPTS[0].priority, true, 'the scheduled run keeps its priority');
});

t('★ the direct path carries the write approval when the entry has it', () => {
  B.resetPool();
  B.setCap(3);
  writeQueue([]);
  B.setSchedules([schedule({ id: 9, allowWrite: true })]);
  B.checkSchedules();
  eq(JSON.stringify(B.DISPATCH_OPTS[0].schedule), JSON.stringify({ id: 9, allowWrite: true }));
});

t('only a literal true is approval: a truthy string is not', () => {
  B.resetPool();
  B.setCap(3);
  writeQueue([]);
  B.setSchedules([schedule({ id: 10, allowWrite: 'yes' })]);
  B.checkSchedules();
  eq(B.DISPATCH_OPTS[0].schedule.allowWrite, false);
});

t('★ the QUEUED path stores the mark on the drop box item', () => {
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('busy');
  writeQueue([]);
  B.setSchedules([schedule({ id: 23, allowWrite: true })]);
  B.checkSchedules();
  const q = readQueue();
  eq(q.length, 1);
  eq(q[0].scheduleId, 23);
  eq(q[0].allowWrite, true, 'the approval has to survive the wait in the drop box');
});

t('★ ...and the drain that starts it later re-applies the mark', () => {
  B.finishFakeWorker();
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 1);
  eq(JSON.stringify(B.DISPATCH_OPTS[0].schedule), JSON.stringify({ id: 23, allowWrite: true }));
});

t('a queued entry WITHOUT approval stores no allowWrite field at all', () => {
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('busy');
  writeQueue([]);
  B.setSchedules([schedule({ id: 24 })]);
  B.checkSchedules();
  ok(!('allowWrite' in readQueue()[0]), JSON.stringify(readQueue()[0]));
  B.finishFakeWorker();
  B.drainBgHandoff();
  eq(JSON.stringify(B.DISPATCH_OPTS[0].schedule), JSON.stringify({ id: 24, allowWrite: false }));
});

// The drop box is a file any worker can write, so the approval on a queued job
// is only honoured when schedules.json still says so.
t('★ a FORGED queued approval (no such schedule) starts without it', () => {
  B.resetPool();
  B.setCap(3);
  B.setSchedules([]);
  writeQueue([{ text: 'apply it', queuedAt: 'x', scheduleId: 'forged', allowWrite: true }]);
  B.drainBgHandoff();
  eq(JSON.stringify(B.DISPATCH_OPTS[0].schedule), JSON.stringify({ id: 'forged', allowWrite: false }));
});
t('★ an approval on the job for an entry that has none starts without it', () => {
  B.resetPool();
  B.setCap(3);
  B.setSchedules([schedule({ id: 8 })]);
  writeQueue([{ text: 'nightly', queuedAt: 'x', scheduleId: 8, allowWrite: true }]);
  B.drainBgHandoff();
  eq(B.DISPATCH_OPTS[0].schedule.allowWrite, false);
});
t('★ a revocation between queueing and starting wins', () => {
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('busy');
  writeQueue([]);
  B.setSchedules([schedule({ id: 31, allowWrite: true })]);
  B.checkSchedules();
  eq(readQueue()[0].allowWrite, true);
  B.setSchedules([schedule({ id: 31 })]); // the user ran: update 31 --allow-write false
  B.finishFakeWorker();
  B.drainBgHandoff();
  eq(B.DISPATCH_OPTS[0].schedule.allowWrite, false);
});
t('a string id from bg.mjs matches the numeric schedule id', () => {
  B.resetPool();
  B.setCap(3);
  B.setSchedules([schedule({ id: 42, allowWrite: true })]);
  writeQueue([{ text: 'child', queuedAt: 'x', scheduleId: '42', allowWrite: true }]);
  B.drainBgHandoff();
  eq(B.DISPATCH_OPTS[0].schedule.allowWrite, true);
});

t('★ a scheduled item deferred AGAIN by a full pool keeps its mark on the way back', () => {
  B.resetPool();
  B.setCap(1);
  B.startFakeWorker('busy');
  writeQueue([{ text: 'nightly', queuedAt: 'x', scheduleId: 8, allowWrite: true }]);
  B.drainBgHandoff(); // pool full: deferred, written back
  const q = readQueue();
  eq(q.length, 1);
  eq(q[0].scheduleId, 8);
  eq(q[0].allowWrite, true);
  writeQueue([]);
});

t('★ a scheduled item held behind a wall keeps its mark in the hold', () => {
  B.resetPool();
  B.setCap(3);
  B.setEngine(() => ({ engine: 'claude', reason: 'default', pausedUntil: Date.now() + 3600_000 }));
  writeQueue([{ text: 'nightly', queuedAt: 'x', scheduleId: 8, allowWrite: true }]);
  B.drainBgHandoff();
  B.setEngine((forced) => ({ engine: forced || 'claude', reason: forced ? 'explicit' : 'default' }));
  eq(B.HELD.length, 1);
  eq(B.HELD[0].scheduleId, 8);
  eq(B.HELD[0].allowWrite, true);
  writeQueue([]);
});

t('★ a bg.mjs handoff is NOT marked, even beside a scheduled one', () => {
  B.resetPool();
  B.setCap(3);
  writeQueue([job('handed off'), { text: 'nightly', queuedAt: 'x', scheduleId: 8 }]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 2);
  eq(B.DISPATCH_OPTS[0].schedule, null, 'a worker the user asked for is not an unattended run');
  eq(B.DISPATCH_OPTS[1].schedule.id, 8);
});

t('a hand-written allowWrite with no scheduleId marks nothing', () => {
  // The approval only means something alongside the trigger.
  B.resetPool();
  B.setCap(3);
  writeQueue([job('handed off', { allowWrite: true })]);
  B.drainBgHandoff();
  eq(B.DISPATCH_OPTS[0].schedule, null);
  writeQueue([]);
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
