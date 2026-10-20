#!/usr/bin/env node
// Review regressions 3, 4 and 5. Never import the daemon.
// ADMISSION_DIR=<archive of 7c665a2> executes the same assertions on old code.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.resolve(process.env.ADMISSION_DIR || path.dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(path.join(tmpdir(), 'admission-review-'));
const src = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8');
const lines = src.split('\n');
function grab(name) {
  const start = lines.findIndex((line) => new RegExp(`^(?:async )?function ${name}\\b`).test(line));
  if (start < 0) return null;
  const result = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      if (line.startsWith('}')) result.push(line);
      break;
    }
    result.push(line);
  }
  return result.join('\n');
}
const load = async (file) => import(pathToFileURL(path.join(DIR, file)).href);
const { createBgWaitStore, waitKey, WAIT_KEEP_MS, WAIT_MAX } = await load('bg-wait.mjs');
const { admissionVerdict, loadGate } = await load('bg-admission.mjs');
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e.message}`); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function counts(descriptors, live = []) {
  return new Function('bgWorkerDescriptors', 'codexRuns', 'MAX_CONCURRENT_WORKERS', `${grab('runningBgWorkers')}\n${grab('bridgeJobsRunning')}\nreturn { claude: runningBgWorkers(), all: bridgeJobsRunning() };`)(
    () => descriptors, new Map(live.map((w) => [w.runId, w])), 6,
  );
}
await test('4: detached Codex survivor holds load at 90 of 28 with no Claude running', () => {
  const n = counts([{ runId: 'codex-survivor', engine: 'codex', pid: 11, running: true }]);
  assert.equal(n.claude, 0);
  assert.equal(n.all, 1);
  assert.equal(admissionVerdict({ engine: 'codex', load: loadGate({ load1: 90, ncpu: 14, loadPerCore: 2, bridgeRunning: n.all }) }).kind, 'load');
});
await test('4: union counts both engines once by run id and pid', () => {
  const n = counts([
    { runId: 'claude-one', engine: 'claude', pid: 10 },
    { runId: 'codex-one', engine: 'codex', pid: 11 },
    { runId: 'codex-two', engine: 'codex', pid: 12 },
    { runId: 'codex-two-alias', engine: 'codex', pid: 12 },
  ], [{ runId: 'codex-one', child: { pid: 11 } }, { runId: 'codex-three', child: { pid: 13 } }, { runId: 'done', done: true }]);
  assert.deepEqual(n, { claude: 1, all: 4 });
});
await test('4: six Claude workers still cap a seventh independent of Codex count', () => {
  const n = counts([...Array.from({ length: 6 }, (_, i) => ({ runId: `claude-${i}`, engine: 'claude' })), { runId: 'codex', engine: 'codex' }]);
  assert.equal(n.claude, 6);
  assert.equal(admissionVerdict({ running: n.claude, max: 6 }).kind, 'cap');
});

await test('5: queued and held waits survive three days and more than WAIT_MAX records', async () => {
  const file = path.join(TMP, 'long-waits.json');
  const old = {};
  for (let i = 0; i < WAIT_MAX + 2; i++) old[waitKey({ text: `job-${i}`, queuedAt: 'old' })] = { msgId: i + 1, at: 1 };
  writeFileSync(file, JSON.stringify(old));
  const store = createBgWaitStore({ file, now: () => WAIT_KEEP_MS + 100 });
  assert.equal(Object.keys(store.snapshot()).length, WAIT_MAX + 2);
  await store.reconcile(Object.keys(old), () => { throw new Error('active wait must not resolve'); });
  assert.equal(Object.keys(createBgWaitStore({ file }).snapshot()).length, WAIT_MAX + 2);
});

function waitRig(store, tgImpl = null) {
  const queue = path.join(TMP, 'queue.json');
  const held = path.join(TMP, 'held.json');
  writeFileSync(queue, '[]'); writeFileSync(held, '[]');
  const calls = [];
  let fail = false;
  const errors = [];
  const reconcile = new Function('readFileSync', 'BG_QUEUE_FILE', 'BG_HELD_FILE', 'bgStrandedJobs', 'waitKey', 'bgWait', 'tg', 'CHAT_ID', 'console', `${grab('reconcileBgWaiting') || 'async function reconcileBgWaiting() {}'}\nreturn reconcileBgWaiting;`)(
    readFileSync, queue, held, [], waitKey, store,
    async (...args) => { calls.push(args); assert.ok(Object.keys(store.snapshot()).length, 'record exists until edit acknowledgement'); if (tgImpl) return tgImpl(...args); if (fail) throw new Error('offline'); }, 123,
    { error: (...args) => errors.push(args) },
  );
  return { queue, held, calls, reconcile, fail: (v) => { fail = v; }, errors };
}
await test('5: external removal resolves message before record deletion', async () => {
  const store = createBgWaitStore({ file: path.join(TMP, 'external.json') });
  const job = { text: 'removed', queuedAt: '1' };
  store.track(waitKey(job), Promise.resolve(41)); await tick();
  const rig = waitRig(store);
  writeFileSync(rig.queue, JSON.stringify([job])); await rig.reconcile();
  assert.equal(rig.calls.length, 0);
  writeFileSync(rig.queue, '[]'); await rig.reconcile();
  assert.equal(rig.calls.length, 1);
  assert.equal(rig.calls[0][1].message_id, 41);
  assert.equal(store.get(waitKey(job)), null);
});
await test('5: held job remains unresolved; failed terminal edit retains record for retry', async () => {
  const file = path.join(TMP, 'retry-wait.json');
  const store = createBgWaitStore({ file });
  const job = { text: 'held', queuedAt: '2' };
  store.track(waitKey(job), Promise.resolve(42)); await tick();
  const rig = waitRig(store);
  writeFileSync(rig.held, JSON.stringify([job])); await rig.reconcile(); assert.equal(rig.calls.length, 0);
  writeFileSync(rig.held, '[]'); rig.fail(true); await rig.reconcile();
  assert.equal(rig.calls.length, 1);
  assert.equal(createBgWaitStore({ file }).get(waitKey(job)).msgId, 42);
  rig.fail(false); await rig.reconcile(); assert.equal(store.get(waitKey(job)), null);
});
await test('5: unreadable held queue never treated as removed jobs', async () => {
  const store = createBgWaitStore({ file: path.join(TMP, 'unreadable.json') });
  store.track('job', Promise.resolve(43)); await tick();
  const rig = waitRig(store); writeFileSync(rig.held, 'corrupt'); await rig.reconcile();
  assert.equal(rig.calls.length, 0); assert.equal(store.get('job').msgId, 43);
});
await test('5: poll wires reconciliation after the queue drain', () => {
  assert.ok(/drainBgHandoff\(\);\s+await reconcileBgWaiting\(\);/.test(grab('pollLoop')), 'poll must reconcile after draining');
});

await test('5: failed worker-card takeover stays durable until a confirmed retry', async () => {
  const file = path.join(TMP, 'takeover.json');
  const store = createBgWaitStore({ file });
  const job = { text: 'starting', queuedAt: '3' };
  store.track(waitKey(job), Promise.resolve(44)); await tick();
  const take = new Function('bgWait', 'waitKey', `${grab('takeBgWaiting')}\nreturn takeBgWaiting;`)(store, waitKey);
  const adopted = take(job);
  assert.equal(adopted, 44);
  assert.equal(createBgWaitStore({ file }).get(waitKey(job))?.msgId, 44, 'claim must retain unresolved message on disk');
  const deps = {
    bgWait: store, LANE_KIND: { background: 'background' }, BG_PROGRESS_ON: false,
    workerLine: () => 'Worker started', tg: async () => { throw new Error('offline'); }, CHAT_ID: 1,
    editProgress: async () => {}, escHtml: (s) => s, console: { error: () => {} },
  };
  const start = new Function(...Object.keys(deps), `${grab('startWorkerNotice')}\nreturn startWorkerNotice;`)(...Object.values(deps));
  await start('run', {}, () => null, '', { adopt: adopted });
  assert.equal(createBgWaitStore({ file }).get(waitKey(job))?.resolutionText, 'Worker started');
  const rig = waitRig(createBgWaitStore({ file })); await rig.reconcile();
  assert.equal(rig.calls[0][1].text, 'Worker started');
  assert.equal(createBgWaitStore({ file }).get(waitKey(job)), null);
});

await test('5: a pending waiting send claimed at start remains durable on takeover failure', async () => {
  const file = path.join(TMP, 'pending-takeover.json');
  const store = createBgWaitStore({ file });
  const job = { text: 'pending', queuedAt: '4' };
  let land;
  store.track(waitKey(job), new Promise((resolve) => { land = resolve; }));
  const take = new Function('bgWait', 'waitKey', `${grab('takeBgWaiting')}\nreturn takeBgWaiting;`)(store, waitKey);
  const adopted = take(job); land(45); assert.equal(await adopted, 45); await tick();
  assert.equal(createBgWaitStore({ file }).get(waitKey(job))?.msgId, 45);
});

function retryRig(behind, resumeCount = 0, scheduleId = 9) {
  const queued = [], logs = [], back = [];
  let drains = 0;
  const reset = { resetsAt: Math.floor(Date.now() / 1000) + 3600 };
  const deps = {
    wallGuard: { jobOf: () => ({ scheduleId, resumeCount }) }, SCHEDULED_RETRY_MAX: 1,
    wallGuardNow: () => ({ enabled: true, resume: true }), noteWallDeath: () => {},
    baseRunId: (v) => v, fmtUntil: () => 'reset', OWNER_TZ: 'UTC', clip: (v) => v, oneLine: (v) => v,
    resumeWallDeaths: (_wall, opts) => { queued.push(opts); return { resumed: [{ runId: 'run', title: 'task' }], skipped: [] }; },
    drainBgHandoff: () => { drains++; }, rotateOffLimitedAccount: async () => ({ outcome: 'cooldown', reset, lines: [] }),
    rotationBehindCooldown: async () => behind === 'unknown' ? null : ({ outcome: behind, reset, lines: [], activeName: 'old', nextName: 'new' }),
    send: async () => {}, swapFailedLine: () => 'failed', runSalvage: async () => 'salvaged', BRIDGE_NAME: 'Leash',
    handBackToChat: (_task, text) => back.push(text), console: { log: (...v) => logs.push(v.join(' ')) },
  };
  const run = new Function(...Object.keys(deps), `${grab('scheduledRetryFor')}\n${grab('handleLimitDeath')}\nreturn handleLimitDeath;`)(...Object.values(deps));
  return { run: () => run('task', { answer: 'limited' }, 'run'), queued, logs, back, drains: () => drains, reset };
}
await test('3: failed rotation behind cooldown queues retry at reset without claiming moved account', async () => {
  const rig = retryRig('swap_failed'); await rig.run();
  assert.equal(rig.queued[0].only.notBefore, rig.reset.resetsAt * 1000);
  assert.equal(rig.drains(), 0);
  assert.ok(rig.logs.some((l) => l.includes('swap_failed')));
  assert.ok(!rig.logs.some((l) => l.includes('account the rotation moved')));
});
await test('3: unknown cooldown outcome waits for reset', async () => {
  const rig = retryRig('unknown'); await rig.run();
  assert.equal(rig.queued[0].only.notBefore, rig.reset.resetsAt * 1000); assert.equal(rig.drains(), 0);
});
await test('3: an unknown rotation tells only a SCHEDULED run that its retry waits', async () => {
  const scheduled = retryRig('unknown'); await scheduled.run();
  assert.ok(scheduled.back[0].includes('the scheduled retry waits for the reset'));
  const ordinary = retryRig('unknown', 0, null); await ordinary.run();
  assert.equal(ordinary.queued.length, 0);
  assert.ok(!ordinary.back[0].includes('scheduled retry'), ordinary.back[0]);
});
await test('3: successful rotation behind cooldown starts retry now', async () => {
  const rig = retryRig('swapped'); await rig.run();
  assert.equal(rig.queued[0].only.notBefore, null); assert.equal(rig.drains(), 1);
  assert.ok(rig.logs.some((l) => l.includes('(swapped)')));
});
await test('3: exhausted rotation behind cooldown defers retry to wall lift', async () => {
  const rig = retryRig('exhausted'); await rig.run();
  assert.equal(rig.queued.length, 0); assert.equal(rig.drains(), 0);
  assert.ok(rig.back[0].includes('at the lift'));
});
await test('3: exhausted rotation never promises a second retry', async () => {
  const rig = retryRig('exhausted', 1); await rig.run();
  assert.equal(rig.queued.length, 0); assert.ok(rig.back[0].includes('NOT retried automatically'));
});

await test('5: a line claimed by a starting job is left to its card', async () => {
  const store = createBgWaitStore({ file: path.join(TMP, 'claimed.json') });
  const job = { text: 'starting now', queuedAt: '5' };
  store.track(waitKey(job), Promise.resolve(46)); await tick();
  assert.equal(store.claim(waitKey(job)), 46);
  const rig = waitRig(store); await rig.reconcile(); // drained: in neither file
  assert.equal(rig.calls.length, 0, 'reconcile must not call a starting job ended');
  assert.equal(store.get(waitKey(job))?.msgId, 46);
  assert.equal(await store.resolveMessage(46, 'Worker started', async () => true), true);
  assert.equal(store.get(waitKey(job)), null);
});
await test('5: a waiting line that no longer exists counts as resolved', async () => {
  const store = createBgWaitStore({ file: path.join(TMP, 'gone.json') });
  const job = { text: 'deleted line', queuedAt: '6' };
  store.track(waitKey(job), Promise.resolve(47)); await tick();
  const gone = Object.assign(new Error('Bad Request: message to edit not found'), { code: 400, description: 'Bad Request: message to edit not found' });
  const rig = waitRig(store, async () => { throw gone; }); await rig.reconcile();
  assert.equal(rig.calls.length, 1);
  assert.equal(store.get(waitKey(job)), null, 'a deleted line must not be retried every poll tick');
});

// INDEPENDENT REVIEW, 2026-10-13 (after the fix run). A failed takeover is
// retried with the card's OPENING text; the card's ending must release it, and
// a pass already under way must not edit a record released during it.
await test('5: a card that reaches its ending releases a failed takeover; its retry never lands after Done', async () => {
  const file = path.join(TMP, 'ending.json');
  const store = createBgWaitStore({ file });
  const job = { text: 'quick job', queuedAt: '7' };
  store.track(waitKey(job), Promise.resolve(48)); await tick();
  assert.equal(store.claim(waitKey(job)), 48);
  await store.resolveMessage(48, 'Worker started', async () => { throw new Error('ETIMEDOUT'); }).catch(() => {});
  assert.equal(store.get(waitKey(job))?.resolutionText, 'Worker started', 'a failed takeover is kept for its retry');
  const edits = [];
  const workerNotices = new Map([['run', { msgId: 48, base: {}, lastLive: {}, done: false }]]);
  const end = new Function('workerNotices', 'bgWait', 'workerLine', 'editProgress', 'escHtml', 'WORKER_KEEPALIVE_MAX_MS', `${grab('editWorkerNotice')}\nreturn editWorkerNotice;`)(
    workerNotices, store, () => '✅ Done', async (id, html) => { edits.push([id, html]); }, (s) => s, 60_000,
  );
  assert.equal(end('run', { phase: 'done' }), true);
  assert.deepEqual(edits, [[48, '✅ Done']]);
  assert.equal(createBgWaitStore({ file }).get(waitKey(job)), null, 'the ending releases the waiting record');
  const rig = waitRig(store); await rig.reconcile();
  assert.equal(rig.calls.length, 0, 'no retry of the opening text after Done');
});
await test('5: a record released during a reconcile pass is not edited by that pass', async () => {
  const store = createBgWaitStore({ file: path.join(TMP, 'midpass.json') });
  const a = { text: 'gone a', queuedAt: '8' };
  const b = { text: 'gone b', queuedAt: '9' };
  store.track(waitKey(a), Promise.resolve(51)); store.track(waitKey(b), Promise.resolve(52)); await tick();
  const rig = waitRig(store, async (_method, payload) => { if (payload.message_id === 51) store.release(52); });
  await rig.reconcile();
  assert.deepEqual(rig.calls.map((c) => c[1].message_id), [51]);
});

// THE ps TABLE HAS READERS OUTSIDE THIS REPO (independent review, 2026-10-13).
// A script that reads field 3 of every line after the header as a worker PID
// (and puts that PID and every descendant into background priority), and one
// that finds a Codex job by the ENGINE column offset of line 1, are the two
// shapes a user's own tooling takes. Two such awk programs run over the table
// the ps op composes. "ADMISSION · 1 of 6 ..." handed the first one PID 1,
// launchd, whose descendants are every process on the machine.
const PID_READER_AWK = 'NR>1 && $3 ~ /^[0-9]+$/ {print $3}';
const ENGINE_READER_AWK = 'NR == 1 { c = index($0, "ENGINE"); next } c && substr($0, c, 6) ~ /^codex( |$)/ { print $1; exit }';
const PS_COMPOSE = 'table: `${psTable(workers)}\\n\\n${gate}${block ? `\\n\\n${block}` : \'\'}`';
await test('ps: a PID reader gets only worker PIDs and an ENGINE reader only the Codex run, at every count', async () => {
  const { spawnSync } = await import('node:child_process');
  const { psTable } = await load('bg-steer.mjs');
  const { admissionLine, queuedBlock } = await load('bg-admission.mjs');
  assert.ok(src.includes(PS_COMPOSE), 'the ps op composes table, gate and queued block the way this test does');
  const awk = (prog, input) => {
    const r = spawnSync('awk', [prog], { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter(Boolean);
  };
  const pids = [40001, 40002, 40003, 40004, 40005, 40006];
  const codexWorker = { runId: 'codex-1791900000001', lane: 'codex', pid: 50001, elapsedSec: 5, steps: 0, steerable: false, steers: 0, engine: 'codex', title: 'a codex job' };
  for (let running = 0; running <= 6; running++) {
    for (const withCodex of [true, false]) {
      const workers = pids.slice(0, running).map((pid, i) => ({ runId: `bg${i}-1791900000000`, lane: `bg${i}`, pid, elapsedSec: 60, steps: 3, steerable: true, steers: 0, engine: 'claude', title: 'a job' }));
      if (withCodex) workers.push(codexWorker);
      const gate = admissionLine({ running, max: 6, load: { high: false, load1: 3, ncpu: 14, limit: 28 } });
      const block = queuedBlock([{ position: 1, waiting: true, waitPosition: 1, engine: 'claude', title: 'queued job', reason: 'waiting: 6 of 6 Claude workers busy' }], { running, max: 6 });
      const table = `${psTable(workers)}\n\n${gate}${block ? `\n\n${block}` : ''}`;
      assert.deepEqual(awk(PID_READER_AWK, table).map(Number), [...pids.slice(0, running), ...(withCodex ? [50001] : [])], `running ${running}:\n${table}`);
      assert.deepEqual(awk(ENGINE_READER_AWK, table), withCodex ? ['codex-1791900000001'] : [], `running ${running}:\n${table}`);
    }
  }
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(failure);
process.exitCode = failures.length ? 1 : 0;
