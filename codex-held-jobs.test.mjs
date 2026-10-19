import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveEngine } from './engine-state.mjs';
import { parseEnginePrefix } from './bg-codex.mjs';

const source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');
const extract = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
let pass = 0;
const failures = [];
const test = (name, fn) => { try { fn(); pass++; } catch (error) { failures.push(`${name}: ${error.message}`); } };
function harness(settings = {}, items = [], queued = []) {
  const state = { held: items, queued, writes: 0, drains: 0, notices: 0 };
  const now = Date.now();
  const opts = { claudeAvailable: true, codexAvailable: true, rotationPausedUntil: 0, codexPausedUntil: 0, ...settings };
  const bindings = {
    engineFor: (lane, forcedEngine) => resolveEngine({ lane, forcedEngine, now, ...opts }),
    CODEX_AVAILABLE: opts.codexAvailable,
    codexWalled: () => opts.codexPausedUntil > now,
    claudeWalled: () => !opts.claudeAvailable || opts.rotationPausedUntil > now,
    claudeRateWalled: () => opts.claudeAvailable && opts.rotationPausedUntil > now,
    readHeldBgJobs: () => state.held,
    parseEnginePrefix,
    logAccountDecision: () => {},
    readFileSync: () => JSON.stringify(state.queued),
    BG_QUEUE_FILE: '/queue',
    writeFileSync: (file, content) => { if (settings.failWrite) throw new Error('test write failure'); state.pending = JSON.parse(content); state.writes++; },
    renameSync: () => { state.queued = state.pending; },
    writeHeldBgJobs: (items) => { state.held = items; },
    pendWallResolution: () => { state.notices++; },
    settleWall: () => {},
    drainBgHandoff: () => { state.drains++; },
    console: { error: () => {} },
    // This build keeps a Claude slash command off an unchosen Codex, so the
    // gate reads the same two facts the daemon does, sliced from its source.
    unchosenCodex: new Function(`${source.match(/^const unchosenCodex = .*$/m)[0]}\nreturn unchosenCodex;`)(),
    BG_COMMAND_RE: new Function(`${source.match(/^const BG_COMMAND_RE = .*$/m)[0]}\nreturn BG_COMMAND_RE;`)(),
  };
  const fn = new Function(...Object.keys(bindings), `${extract('canRunHeldItem')}\n${extract('flushParkedWalledJobs')}\nreturn {flushParkedWalledJobs,canRunHeldItem};`)(...Object.values(bindings));
  return { state, ...fn };
}
const future = Date.now() + 3_600_000;
test('healthy Codex releases unpinned job during Claude wall', () => {
  const item = { text: 'work', cwd: '/repo', scheduleId: 8 };
  const h = harness({ rotationPausedUntil: future }, [item]);
  h.flushParkedWalledJobs();
  assert.deepEqual(h.state.queued[0], item);
  assert.deepEqual(h.state.held, []);
  assert.equal(h.state.notices, 0, 'Claude wall must not be announced lifted');
});
test('healthy Claude releases Codex-default job during Codex wall', () => {
  const h = harness({ config: { engine: { bg: 'codex' } }, codexPausedUntil: future }, ['work']);
  h.flushParkedWalledJobs();
  assert.deepEqual(h.state.queued, ['work']);
  assert.equal(h.state.drains, 1);
});
test('both walls retain jobs without queue writes or poll-loop churn', () => {
  const h = harness({ rotationPausedUntil: future, codexPausedUntil: future }, ['work']);
  h.flushParkedWalledJobs(); h.flushParkedWalledJobs();
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.drains, 0);
  assert.deepEqual(h.state.held, ['work']);
});
test('mixed explicit pins remain bound to their chosen engines', () => {
  const claude = { text: 'work', engine: 'claude' };
  const codex = { text: 'codex: work', cwd: '/repo', scheduleId: 4 };
  const h = harness({ rotationPausedUntil: future }, [claude, codex], ['newer']);
  h.flushParkedWalledJobs();
  assert.deepEqual(h.state.held, [claude]);
  assert.deepEqual(h.state.queued, [codex, 'newer']);
});
test('Codex-only installation keeps jobs held while Codex is limited', () => {
  const h = harness({ claudeAvailable: false, codexPausedUntil: future }, ['work']);
  h.flushParkedWalledJobs();
  assert.equal(h.state.writes, 0);
});
test('explicit Codex job uses healthy Claude when Codex binary is missing', () => {
  const h = harness({ codexAvailable: false }, [{ text: 'work', engine: 'codex' }]);
  h.flushParkedWalledJobs();
  assert.equal(h.state.writes, 1);
  assert.deepEqual(h.state.held, []);
});
test('queue write failure leaves every original held job intact', () => {
  const items = [{ text: 'work', cwd: '/repo' }];
  const h = harness({ failWrite: true }, items);
  h.flushParkedWalledJobs();
  assert.equal(h.state.held, items);
  assert.equal(h.state.drains, 0);
});
test('held chat resolver uses chat preference and explicit pin', () => {
  const h = harness({ config: { engine: { chat: 'codex', bg: 'claude' } }, codexPausedUntil: future, rotationPausedUntil: future });
  assert.equal(h.canRunHeldItem({ forcedEngine: 'codex' }), false);
});
function drainHarness(settings, item) {
  const lane = { queue: [item], current: null, priorityCount: item.priority ? 1 : 0, isBg: false };
  const state = { held: [], acks: [], timers: [], starts: [], kept: [] };
  const bindings = {
    asQueueItem: (value) => value,
    keepHandback: (mark, where) => state.kept.push({ mark, where }),
    resolveQueueAck: (_item, status) => state.acks.push(status),
    engineForItem: (_lane, queued) => resolveEngine({ ...settings, forcedEngine: queued.forcedEngine }),
    codexWalled: () => settings.codexPausedUntil > Date.now(),
    parkedWalledChats: state.held,
    armWallResume: (at) => state.timers.push(at),
    startResolvedRun: (decision, _lane, queued) => { state.starts.push({ decision, queued }); return 'started'; },
  };
  const drain = new Function(...Object.keys(bindings), `${extract('drainQueue')}\nreturn drainQueue;`)(...Object.values(bindings));
  drain(lane);
  return { state, lane };
}
test('queue draining holds a newly walled turn and preserves its full task', () => {
  const item = { text: 'follow-up', forcedEngine: 'codex', priority: true, schedule: { id: 4, allowWrite: false }, cwd: '/worktree', prepend: 'criteria', replyQuote: { block: 'quote' }, images: ['image.png'], retried: true };
  const { state, lane } = drainHarness({ rotationPausedUntil: future, codexPausedUntil: future }, item);
  assert.deepEqual(state.held, [{ ...item, heldOnBg: false }]);
  assert.deepEqual(state.kept, []);
  assert.deepEqual(state.acks, ['held']);
  assert.deepEqual(state.starts, []);
  assert.deepEqual(state.timers, [future / 1000]);
  assert.equal(lane.priorityCount, 0);
  assert.equal(lane.queue.length, 0);
});
// A WORKER REPORT (the handback mark) behind the wall goes to keepHandback,
// which holds it on disk for the wake-up, not to the in-memory chat park that
// a restart would empty (QA round 2).
test('queue draining keeps a walled worker report through keepHandback, not the in-memory park', () => {
  const mark = { items: [{ runId: 'bg-8', task: 'the job', status: 'finished' }] };
  const { state, lane } = drainHarness({ rotationPausedUntil: future, codexPausedUntil: future }, { text: '[Report] the job', priority: true, handback: mark });
  assert.deepEqual(state.kept, [{ mark, where: 'wall' }]);
  assert.deepEqual(state.held, []);
  assert.deepEqual(state.acks, ['held']);
  assert.deepEqual(state.starts, []);
  assert.equal(lane.queue.length, 0);
});
test('queue draining still starts healthy Codex during a Claude wall', () => {
  const { state } = drainHarness({ rotationPausedUntil: future }, { text: 'follow-up' });
  assert.equal(state.starts[0].decision.engine, 'codex');
  assert.deepEqual(state.acks, ['started']);
  assert.equal(state.held.length, 0);
});
test('queue draining holds a limited Codex-only installation', () => {
  const { state } = drainHarness({ claudeAvailable: false, codexPausedUntil: future }, { text: 'follow-up' });
  assert.equal(state.starts.length, 0);
  assert.equal(state.held.length, 1);
});
test('held queue acknowledgement does not claim the task started', () => {
  let sent;
  const resolve = new Function('editProgress', `
    const queueDropped = () => 'Dropped', queueStarted = () => 'Started', escHtml = (text) => text;
    ${extract('resolveQueueAck')}
    return resolveQueueAck;
  `)((_id, text) => { sent = text; return Promise.resolve(); });
  const item = { ackMsgId: 3, ackLive: { done: false } };
  resolve(item, 'held');
  assert.equal(sent, '⏸ Waiting for an available engine.');
  assert.equal(item.ackLive.done, true);
  assert.equal(item.ackResolved, 'held');
});
test('held chat release preserves task metadata and its background lane', () => {
  const item = { text: 'review the patch', forcedEngine: 'codex', heldOnBg: true, priority: true, schedule: { id: 4, allowWrite: false }, handback: { id: 9 }, cwd: '/worktree', images: ['photo.png'], kinds: ['photo'], retried: true, prepend: 'Original criteria', replyQuote: { block: 'Owner quote' } };
  const bgLane = { name: 'bg2', isBg: true };
  const state = { held: [item], dispatched: [] };
  const bindings = {
    parkedWalledChats: state.held,
    canRunHeldItem: () => true,
    logAccountDecision: () => {},
    claudeWalled: () => false,
    codexWalled: () => false,
    pendWallResolution: () => false,
    wallNotices: new Map(),
    enginesBackLine: () => 'Engine ready',
    send: () => Promise.resolve(),
    LANES: { main: { current: null } },
    getBgLane: () => bgLane,
    dispatchPrompt: (...args) => state.dispatched.push(args),
  };
  const flush = new Function(...Object.keys(bindings), `${extract('flushParkedWalledChats')}\nreturn flushParkedWalledChats;`)(...Object.values(bindings));
  assert.deepEqual(flush(), { count: 1, folded: false });
  assert.deepEqual(state.dispatched, [[`codex: ${item.text}`, bgLane, {
    priority: true, schedule: item.schedule, handback: item.handback, cwd: item.cwd,
    allowCodexFallback: true, images: item.images, kinds: item.kinds, retried: true,
    carriedModel: null, prepend: item.prepend, replyQuote: item.replyQuote,
  }]]);
  assert.equal(state.held.length, 0);
});
// A Claude TAKEOVER of a failed Codex job is a queue item pinned to Claude
// (retryCodexOnClaude). Behind a Claude wall it is held as a whole, and when
// Claude is back it returns to the queue with its pin, note and directory.
test('a queued Claude takeover waits for Claude and keeps its pin, note and cwd', () => {
  const item = { text: 'claude: finish the job', engine: 'claude', prepend: 'Codex could not start this task.', cwd: '/repo', scheduleId: 3 };
  const walled = harness({ rotationPausedUntil: future }, [item]);
  walled.flushParkedWalledJobs();
  assert.equal(walled.state.writes, 0, 'a Claude pin must not run on Codex during a Claude wall');
  assert.deepEqual(walled.state.held, [item]);
  const back = harness({}, [item]);
  back.flushParkedWalledJobs();
  assert.deepEqual(back.state.queued, [item]);
  assert.equal(back.state.drains, 1);
});
for (const failure of failures) process.stderr.write(`${failure}\n`);
process.stdout.write(`${pass} passed, ${failures.length} failed\n`);
process.exitCode = failures.length ? 1 : 0;
