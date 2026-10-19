// One behavior test per finding of the three reviews of "Opus when Fable is
// out" (2026-10-12), against the one model decision (startModel and
// decideRunModel) and the rotation's one model rule (classifyModelRefusal).
// Each test id names its finding: R1-n is review 1 finding n, R2-Fn and R2-Nn
// review 2, R3-n review 3, AC-n a criterion of the restructure brief.
//
// Real store, real usage reader, real tracker, real selector, the daemon's own
// functions cut out of bridge.mjs (fixtures/model-owner-rig.mjs). Run against
// another checkout with MODEL_OWNER_DIR=<dir>; one test with
// MODEL_OWNER_ONLY=<regex>.
//
//   node model-owner.test.mjs
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { makeRig, withRig, test, summary, settle, sleep, grab, has, source, models, usageMod, sysmsg, streamHandler, handleEvent, runPrefix, carriedOf,
  realEvent, fiveWallEvent, allowedEvent, apiBody, iso, NOW, HOUR, sec, weekReset, fiveReset, WALL, SESSION } from './fixtures/model-owner-rig.mjs';

const fableOut = (name, extra = {}) => ({ name, modelLimits: { fable: { until: weekReset } }, ...extra });
const legacy = (name) => ({ name, limitedUntil: weekReset, limitedSource: 'probe' });
const restoredNotices = (r) => r.notices.filter((n) => /Fable: available/.test(n)).length;
const fallbackNotices = (r) => r.notices.filter((n) => /Fable: out/.test(n)).length;
const gets = (r, n) => r.counts.usageGets[n] || 0;
const live = (r) => r.accounts.listAccounts();
const rotated = (r) => ({ swaps: r.counts.credWrites });

// ---------------------------------------------------------------------------
// Review 1 (8 findings)
// ---------------------------------------------------------------------------

await test('R1-1 a stream event never writes the ledger or the export', () => withRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() } }, async (r) => {
  await r.accountUsage.one('a');
  const before = [r.raw(), JSON.stringify(r.exported())];
  const h = streamHandler(r, 'opus', 'a');
  const warning = realEvent(); warning.rate_limit_info.status = 'allowed_warning';
  h.feed(warning); h.feed(allowedEvent());
  await settle();
  assert.deepEqual([r.raw(), JSON.stringify(r.exported())], before);
  // A refusal changes them only through the read it schedules, and only once.
  h.feed(realEvent());
  assert.equal(r.raw(), before[0], 'the event itself wrote');
  // A reading with no scoped rows (what a stream event normalizes to) is not a model-limit writer either.
  r.api.reconcileModelUsage('a', usageMod.normalizeRateLimitEvent(realEvent()));
  assert.equal(r.raw(), before[0]);
}));

await test('R1-2 the real Fable refusal is a Fable limit, not an account wall', () => withRig({ rows: [{ name: 'a' }, { name: 'b' }], bodies: { a: apiBody({ week: 90 }), b: apiBody({ five: 0, week: 10, fable: 5 }) } }, async (r) => {
  const ev = realEvent();
  const run = handleEvent(r, ev, 'fable');
  const plan = await r.api.handleChatLimitFailure(WALL, { text: 'm', lane: r.lane, model: 'fable', rejectedLimit: run.rejectedLimit, rejectedAccount: run.rejectedAccount });
  assert.equal(r.row('a').limitedUntil ?? null, null, 'the account was walled');
  assert.equal(r.row('a').modelLimits.fable.until, weekReset);
  assert.equal(r.counts.credWrites, 0, 'the login moved');
  plan.dispatch(); await settle();
  assert.equal(r.dispatched[0].model, 'opus');
}));

await test('R1-3 R1-4 AC-4 ten Fable starts with Fable out: no read, no keychain, no swap, all Opus, one notice', () => withRig({ rows: [fableOut('a'), { name: 'b' }], bodies: {}, trackerTtlMs: 1 }, async (r) => {
  // The tracker's name is stale: a start that asked it to refresh would read the keychain.
  await sleep(5);
  r.counts.credReads = 0;
  const spawned = [];
  for (let i = 0; i < 10; i++) {
    const launch = runPrefix((lane, carried) => r.start(r.lane, carried), r.liveAccount);
    await launch.run(`message ${i}`, launch.lane);
    spawned.push(launch.counts().model);
  }
  await settle();
  assert.deepEqual(spawned, Array(10).fill('opus'));
  assert.deepEqual({ gets: r.counts.usageGets, keychain: r.counts.credReads, swaps: r.counts.credWrites }, { gets: {}, keychain: 0, swaps: 0 });
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /Fable: out\n🕒 Reset: .+\n🧠 Model: Opus/);
}));

await test('R1-3b an Opus lane starts at once, with no account work, and clears a stale fallback without a word', () => withRig({ rows: [fableOut('a')], chatModel: 'opus', bodies: {} }, async (r) => {
  r.api.modelFallbacks.set('chat', true);
  r.counts.credReads = 0;
  assert.equal(r.start(r.lane), 'opus');
  await settle();
  assert.deepEqual({ gets: r.counts.usageGets, keychain: r.counts.credReads, swaps: r.counts.credWrites }, { gets: {}, keychain: 0, swaps: 0 });
  assert.equal(r.api.modelFallbacks.get('chat'), false);
  assert.equal(r.notices.length, 0);
}));

await test('R1-5 a start decision that throws runs the configured model and drains the queue; a /stop in it strands nothing', async () => {
  const thrown = runPrefix(() => { throw new Error('decision failed'); });
  thrown.lane.queue.push('queued owner message');
  await thrown.run('owner message', thrown.lane);
  assert.deepEqual(thrown.counts(), { started: 1, drained: 1, model: 'fable' });
  assert.deepEqual(thrown.lane.queue, []);
  const stopped = runPrefix((lane) => { lane.queue = ['next message']; lane.current.terminate(); return 'opus'; });
  await stopped.run('owner message', stopped.lane);
  assert.deepEqual(stopped.counts(), { started: 0, drained: 1, model: undefined });
  assert.deepEqual(stopped.dispatched, ['next message']);
  assert.equal(stopped.lane.current, null);
});

await test('R1-6 a failed export write never breaks a reading or a rotation', () => withRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() }, overrides: { writeModelLimits: () => { throw new Error('disk full'); } } }, async (r) => {
  assert.doesNotThrow(() => r.api.publishModelLimits('a'));
  const row = await r.accountUsage.one('a');
  assert.equal(row.state, 'ok');
  assert.equal(r.row('a').modelLimits.fable.until, weekReset, 'the ledger write stood');
  const rot = await r.api.rotateOffLimitedAccount(WALL, { model: 'fable', rejectedLimit: realEvent(), rejectedAccount: 'a' });
  assert.ok(rot.outcome, 'the rotation finished');
}));

await test('R1-7 a rotation never swaps onto the account that is already live', () => withRig({ rows: [{ name: 'a', modelLimits: { opus: { until: weekReset } } }], bodies: { a: apiBody({ opus: 100 }) } }, async (r) => {
  // The round 1 shape: one account, a Fable refusal (no stream event, so the
  // reading classifies it) with Opus open on it. The first build's Opus pick
  // ran with no live account to exclude and "swapped" onto the live one.
  await withRig({ rows: [{ name: 'solo' }], bodies: { solo: apiBody({ week: 90 }) } }, async (one) => {
    const rot = await one.api.rotateOffLimitedAccount(WALL, { model: 'fable' });
    assert.notEqual(rot.outcome, 'swapped', JSON.stringify(rot.lines));
    assert.equal(one.counts.credWrites, 0, 'the live account was its own swap target');
  });
  const scoped = await r.api.rotateOffLimitedAccount(WALL, { model: 'fable', rejectedLimit: realEvent(), rejectedAccount: 'a' });
  assert.notEqual(scoped.outcome, 'swapped');
  assert.equal(r.counts.credWrites, 0);
  r.api.setCooldown(0);
  const wall = await r.api.rotateOffLimitedAccount(SESSION, { model: 'fable', rejectedLimit: fiveWallEvent(), rejectedAccount: 'a' });
  assert.notEqual(wall.outcome, 'swapped');
  assert.equal(r.counts.credWrites, 0);
}));

await test('R1-8 a fresh reading clears only a wall the probe wrote, never one from a refusal', () => withRig({
  // `c`: a refusal wall from before the cause was recorded (no cause), so only
  // its source keeps it.
  rows: [{ name: 'a', limitedUntil: weekReset, limitedSource: 'the wall message', limitedCause: 'unknown' }, legacy('b'), { name: 'c', limitedUntil: weekReset, limitedSource: 'the wall message' }],
  bodies: { a: apiBody(), b: apiBody(), c: apiBody() },
}, async (r) => {
  await r.accountUsage.one('a'); await r.accountUsage.one('b'); await r.accountUsage.one('c');
  assert.equal(r.row('a').limitedUntil, weekReset, 'a refusal wall was cleared by a reading');
  assert.equal(r.row('c').limitedUntil, weekReset, 'a refusal wall with no cause was cleared by a reading');
  assert.equal(r.row('b').limitedUntil, null, 'the legacy probe wall stayed');
  assert.equal(r.row('b').modelLimits.fable.until, weekReset);
}));

// ---------------------------------------------------------------------------
// Review 2 (F1 to F4, and the notes that had tests)
// ---------------------------------------------------------------------------

await test('R2-F1a the tracker cannot name the live login: no "Fable is back", every continuation on Opus', () => withRig({
  rows: [{ name: 'a', lastActiveAt: new Date(NOW - 3600e3).toISOString() }, { name: 'b' }], bodies: { a: apiBody({ week: 95 }), b: apiBody({ five: 0, week: 10, fable: 5 }) },
}, async (r) => {
  r.setLiveBlob({ claudeAiOauth: { accessToken: 'access-token-for-a-ROTATED', refreshToken: 'ROTATED-refresh-token-not-in-any-slot-xxxx' } });
  r.liveAccount.invalidate(); await r.liveAccount.refresh();
  assert.equal(r.liveAccount.peek(), null);
  const continuations = [];
  for (let m = 1; m <= 5; m++) {
    const start = r.start(r.lane); await settle();
    if (start !== 'fable') continue;
    const h = streamHandler(r, start, r.liveAccount.peek());
    h.feed(realEvent());
    const plan = await r.api.handleChatLimitFailure(WALL, { text: `m${m}`, lane: r.lane, model: start, rejectedLimit: h.run.rejectedLimit, rejectedAccount: h.run.rejectedAccount });
    plan.dispatch(); await settle();
    continuations.push(r.dispatched.at(-1).model);
  }
  assert.equal(restoredNotices(r), 0);
  assert.ok(continuations.length >= 1 && continuations.every((m) => m === 'opus'), JSON.stringify(continuations));
  assert.equal(r.counts.credWrites, 0);
}));

await test('R2-F1b Fable and Opus both out: the lane stays on its last decision, says nothing, and the rotation decides', () => withRig({
  rows: [{ name: 'a' }], bodies: { a: (n) => (n === 1 ? apiBody({ week: 80 }) : apiBody({ week: 85, opus: 100 })) },
}, async (r) => {
  await r.accountUsage.one('a');
  const first = r.start(r.lane); await settle();
  await r.accountUsage.one('a');
  const second = r.start(r.lane); await settle();
  assert.deepEqual([first, second], ['opus', 'opus']);
  assert.equal(restoredNotices(r), 0);
  assert.equal(fallbackNotices(r), 1);
  const rot = await r.api.rotateOffLimitedAccount(WALL, { model: 'opus' });
  assert.notEqual(rot.outcome, 'model_limit');
  assert.equal(restoredNotices(r), 0);
}));

for (const gap of [0, 400]) await test(`R2-F1c a retry ${gap} ms after a rotation swap, before the tracker re-reads: Opus, no "Fable is back"`, () => withRig({
  rows: [fableOut('a'), fableOut('b')], bodies: { a: apiBody({ five: 100 }), b: apiBody({ five: 0, week: 10 }) },
}, async (r) => {
  const first = r.start(r.lane); await settle();
  const h = streamHandler(r, first, 'a');
  h.feed(fiveWallEvent());
  r.setCredDelay(60);
  const plan = await r.api.handleChatLimitFailure(SESSION, { text: 'retry', lane: r.lane, model: first, rejectedLimit: h.run.rejectedLimit, rejectedAccount: h.run.rejectedAccount });
  if (gap) await sleep(gap);
  else assert.equal(r.liveAccount.peek(), null, 'the tracker had already re-read');
  plan.dispatch(); await settle();
  assert.equal(r.dispatched[0].model, 'opus');
  assert.equal(restoredNotices(r), 0);
}));

await test('R2-F1d the carried decision survives a queue and a lane whose last decision was lost', () => withRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() } }, async (r) => {
  const plan = await r.api.handleChatLimitFailure(WALL, { text: 'retry', lane: r.lane, model: 'fable', rejectedLimit: realEvent(), rejectedAccount: 'a' });
  plan.dispatch();
  const item = r.api.queueItem('retry', r.dispatched[0].opts);
  r.api.modelFallbacks.clear();
  r.setLiveBlob({ claudeAiOauth: { accessToken: 'access-token-for-a-ROTATED', refreshToken: 'ROTATED-refresh-token-not-in-any-slot-xxxx' } });
  r.liveAccount.invalidate(); await r.liveAccount.refresh();
  const launch = runPrefix((lane, carried) => r.start(r.lane, carried ?? carriedOf(item)));
  await launch.run(item.text, launch.lane, item);
  assert.equal(launch.counts().model, 'opus');
}));

await test('R2-D8 the real dispatchPrompt and drainQueue carry the decision into the real runClaude start', async () => {
  for (const busy of [false, true]) {
    const launch = runPrefix((_lane, carried) => carried?.model || 'fable');
    const lane = launch.lane;
    const runs = [];
    lane.current = busy ? {} : null;
    const deps = { LANES: { main: lane }, parseEnginePrefix: (text) => ({ text }),
      engineForItem: () => ({ engine: 'claude' }), startResolvedRun: () => 'fallthrough',
      CLAUDE_AVAILABLE: true, takeHandoffPrefix: () => '', resolveQueueAck: () => {},
      asQueueItem: (item) => item, console,
      // dispatchPrompt's hold keeps a Claude slash command off an unchosen
      // Codex in this build; the decision here is Claude, so they are inert.
      unchosenCodex: () => false, BG_COMMAND_RE: /^\/(goal|autopilot)\b/i,
      runClaude: (text, target, opts) => { const p = launch.run(text, target, opts); runs.push(p); return p; } };
    const api = new Function(...Object.keys(deps), `${['queueItem', 'dispatchPrompt', 'drainQueue'].map(grab).join('\n')}\nreturn {dispatchPrompt, drainQueue};`)(...Object.values(deps));
    api.dispatchPrompt('retry', lane, { priority: true, retried: true, carriedModel: { model: 'opus', told: true }, retryModel: 'opus' });
    if (busy) { assert.equal(lane.queue.length, 1); lane.current = null; api.drainQueue(lane); }
    await Promise.all(runs);
    assert.equal(launch.counts().model, 'opus', busy ? 'through the queue' : 'direct');
  }
});

await test('R2-F2a a fresh every-model wall beats an earlier refused subagent: the account is walled', () => withRig({
  rows: [{ name: 'a' }, { name: 'b' }], chatModel: 'opus', bodies: { a: apiBody({ five: 100 }), b: apiBody({ five: 0, week: 10, fable: 5 }) },
}, async (r) => {
  const run = handleEvent(r, realEvent(), 'opus', 'a');
  await settle();
  await r.api.rotateOffLimitedAccount(SESSION, { model: 'opus', rejectedLimit: run.rejectedLimit, rejectedAccount: run.rejectedAccount });
  assert.ok(r.row('a').limitedUntil > Date.now() / 1000, 'the five hour wall was not recorded');
  assert.equal(r.row('a').modelLimits?.opus, undefined, 'an Opus limit was invented');
  assert.equal(r.counts.credWrites, 1);
}));

await test('R2-F2b an event filed under another account changes nothing on the live one', () => withRig({
  rows: [{ name: 'a' }, { name: 'b' }], live: 'b', bodies: { a: apiBody({ week: 95 }), b: apiBody({ five: 3, week: 10, fable: 5 }) },
}, async (r) => {
  const rot = await r.api.rotateOffLimitedAccount(WALL, { model: 'fable', rejectedLimit: realEvent(), rejectedAccount: 'a' });
  const b = r.row('b');
  assert.equal(b.limitedUntil ?? null, null);
  assert.ok(!models.modelBlocked(b, 'fable'), 'b was marked Fable out from a\'s event');
  assert.equal(r.counts.credWrites, 0);
  assert.ok(!(rot.lines || []).some((l) => /Swapped/.test(l)), JSON.stringify(rot.lines));
}));

await test('R2-F3 the same account continuation line comes from the styled builder', () => withRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() } }, async (r) => {
  const plan = await r.api.handleChatLimitFailure(WALL, { text: 'retry', lane: r.lane, model: 'fable', rejectedLimit: realEvent(), rejectedAccount: 'a' });
  assert.equal(plan.line, sysmsg.chatModelFallbackLine?.());
  for (const line of plan.line.split('\n')) assert.match(line, /^\P{L}+ \p{Lu}/u, `not icon, label: ${line}`);
  assert.doesNotMatch(plan.line, /[–—]/);
}));

await test('R2-F4 one refused Fable run makes exactly one usage request', () => withRig({ rows: [{ name: 'a' }, { name: 'b' }], bodies: { a: apiBody(), b: apiBody({ five: 0, week: 10, fable: 5 }) } }, async (r) => {
  const run = handleEvent(r, realEvent(), 'fable', 'a');
  await settle();
  await r.api.handleChatLimitFailure(WALL, { text: 'm', lane: r.lane, model: 'fable', rejectedLimit: run.rejectedLimit, rejectedAccount: run.rejectedAccount });
  await settle();
  assert.equal(gets(r, 'a'), 1);
}));

await test('R2-N1 a failed refusal read spends its slot: a second refusal within five minutes asks nothing', () => withRig({ rows: [{ name: 'a' }], chatModel: 'opus', bodies: { a: { status: 500 } } }, async (r) => {
  handleEvent(r, realEvent(), 'opus', 'a'); await settle();
  // One minute on: past the ten seconds one read is shared, inside the five
  // minutes the limiter holds the slot.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try { handleEvent(r, realEvent(), 'opus', 'a'); await settle(); }
  finally { Date.now = realNow; }
  assert.equal(gets(r, 'a'), 1);
}));

await test('R2-N2 hung legacy rechecks do not hold up the automatic switch', () => withRig({
  rows: [{ name: 'live' }, legacy('a'), legacy('b')], bodies: { a: () => new Promise(() => {}), b: () => new Promise(() => {}) },
}, async (r) => {
  const op = r.api.kickAutoSwitch();
  const done = await Promise.race([op.then(() => true), sleep(100).then(() => false)]);
  assert.equal(done, true);
  assert.equal(r.counts.autoSwitchTicks, 1);
}));

await test('R2-N3a a refused Fable subagent in a continuing Opus run: one read through the real reader records Fable, the run goes on', () => withRig({ rows: [{ name: 'a' }], chatModel: 'opus', bodies: { a: apiBody() } }, async (r) => {
  const h = streamHandler(r, 'opus', 'a');
  h.feed(realEvent()); h.feed(realEvent());
  await settle();
  assert.equal(h.run.stopped, false);
  assert.equal(gets(r, 'a'), 1);
  assert.equal(r.row('a').modelLimits.fable.until, weekReset);
  assert.equal(r.row('a').limitedUntil ?? null, null);
  assert.equal(r.exported().models.fable.blocked, true);
}));

await test('R2-N3b AC-4 three legacy probe walls convert on one tick, with no human command', () => withRig({
  rows: ['a', 'b', 'c'].map(legacy), bodies: { a: apiBody({ week: 90 }), b: apiBody({ week: 87 }), c: apiBody({ week: 96 }) },
}, async (r) => {
  await r.api.kickAutoSwitch();
  await Promise.all([...r.api.pendingOps]);
  assert.deepEqual(r.counts.usageGets, { a: 1, b: 1, c: 1 });
  for (const a of live(r)) {
    assert.equal(a.limitedUntil, null, a.name);
    assert.equal(a.modelLimits.fable.until, weekReset);
  }
}));

await test('R2-N5 the idle shape converts a legacy wall; a reading with no session row keeps it', async () => {
  const idle = JSON.parse(fs.readFileSync(new URL('./fixtures/usage-idle-fable.json', import.meta.url)));
  assert.equal(models.globalWindowsOpen(usageMod.normalizeUsage(idle)), true);
  for (const kind of ['idle', 'absent', 'null', 'flat-null']) {
    const body = structuredClone(idle);
    for (const row of body.limits) if (row.resets_at) row.resets_at = iso(weekReset);
    if (kind !== 'idle') delete body.five_hour;
    if (kind === 'absent' || kind === 'flat-null') body.limits = body.limits.filter((row) => row.kind !== 'session');
    if (kind === 'null') body.limits[0].percent = null;
    if (kind === 'flat-null') body.five_hour = null;
    await withRig({ rows: [legacy('a')], bodies: { a: body } }, async (r) => {
      await r.accountUsage.one('a');
      assert.equal(r.row('a').limitedUntil, kind === 'idle' ? null : weekReset, kind);
    });
  }
});

// ---------------------------------------------------------------------------
// Review 3 (1 HIGH, 1 MEDIUM, 4 LOW, 1 nit)
// ---------------------------------------------------------------------------

// Trigger A: two accounts share a weekly reset; the live b answers 429, so the
// five hour wall on b is filed under a by the stream attribution.
const W = sec(NOW + 50 * HOUR);
const body = ({ five = 10, fiveAt = sec(NOW + 3 * HOUR), week = 50, weekly = W, fable = 0 } = {}) => ({ limits: [
  { kind: 'session', percent: five, resets_at: iso(fiveAt) },
  { kind: 'weekly_all', percent: week, resets_at: iso(weekly) },
  { kind: 'weekly_scoped', percent: fable, resets_at: iso(weekly), scope: { model: { display_name: 'Fable' } } }] });

await test('R3-1A AC-2 a real five hour wall filed under another account (shared reset) is walled and rotated', () => withRig({
  rows: [{ name: 'a' }, { name: 'b' }], live: 'b', chatModel: 'opus', bodies: { a: body(), b: { status: 429, retryAfter: '3600' } },
}, async (r) => {
  await r.accountUsage.one('a');
  for (const m of ['message 1', 'message 2']) {
    const wasLive = (await r.accounts.activeAccount()).account?.name;
    const swapsBefore = r.counts.credWrites;
    const h = streamHandler(r, 'opus', r.liveAccount.peek());
    h.feed(fiveWallEvent({ weekly: W }));
    const plan = await r.api.handleChatLimitFailure(SESSION, { text: m, lane: r.lane, model: 'opus', rejectedLimit: h.run.rejectedLimit, rejectedAccount: h.run.rejectedAccount });
    const swapped = r.counts.credWrites > swapsBefore;
    if (/Swapped/.test(plan?.line || '')) assert.ok(swapped, `"Swapped" with no swap: ${plan.line}`);
    if (wasLive === 'b') {
      assert.ok(swapped || r.row('b').limitedUntil, `${m}: the real wall on b produced neither a mark nor a swap`);
      assert.ok(swapped, `${m}: the login did not move off the walled b`);
    }
    r.api.setCooldown(0);
  }
  assert.equal((await r.accounts.activeAccount()).account?.name, 'a');
}));

await test('R3-1B AC-2 the store guesses the live slot, the tracker names b: the wall is walled and rotated', () => withRig({
  rows: [{ name: 'a', email: 'a@x', lastActiveAt: new Date(NOW - 600e3).toISOString() }, { name: 'b', email: 'b@x' }, { name: 'c', email: 'c@x' }], live: 'b', chatModel: 'opus', profileEmail: 'b@x',
  bodies: { a: body({ weekly: sec(NOW + 80 * HOUR) }), b: body({ five: 100, fiveAt: sec(NOW + 2 * HOUR) }), 'b-ROTATED': body({ five: 100, fiveAt: sec(NOW + 2 * HOUR) }), c: body({ weekly: sec(NOW + 120 * HOUR) }) },
}, async (r) => {
  r.setLiveBlob({ claudeAiOauth: { accessToken: 'access-token-for-b-ROTATED', refreshToken: 'ROTATED-refresh-token-for-b-xxxxxxxxxxxxxxx' } });
  r.liveAccount.invalidate(); await r.liveAccount.refresh();
  await r.accountUsage.one('b');
  assert.equal(r.liveAccount.peek(), 'b');
  const h = streamHandler(r, 'opus', r.liveAccount.peek());
  h.feed(fiveWallEvent({ reset: sec(NOW + 2 * HOUR) }));
  const plan = await r.api.handleChatLimitFailure(SESSION, { text: 'm', lane: r.lane, model: 'opus', rejectedLimit: h.run.rejectedLimit, rejectedAccount: h.run.rejectedAccount });
  assert.ok(r.counts.credWrites > 0, 'no swap off the walled login');
  if (/Swapped/.test(plan?.line || '')) assert.ok(r.counts.credWrites > 0);
}));

await test('R3-1 a late death skips the wall only with proof, and its handback lines say so with no swap named', () => withRig({
  rows: [{ name: 'a' }, { name: 'b' }], live: 'b', chatModel: 'opus', bodies: { a: apiBody(), b: apiBody({ five: 3, week: 10, fable: 5 }) },
}, async (r) => {
  const rot = await r.api.rotateOffLimitedAccount(SESSION, { model: 'opus', rejectedLimit: fiveWallEvent(), rejectedAccount: 'a' });
  assert.equal(r.counts.credWrites, 0);
  assert.equal(r.row('b').limitedUntil ?? null, null);
  assert.ok(rot.lines.length > 0, 'a worker handback would carry an empty rotation section');
  assert.ok(!rot.lines.some((l) => /Swapped/.test(l)));
  const plan = r.api.chatLimitRetryPlan(rot);
  assert.doesNotMatch(plan.line, /Swapped/);
}));

await test('R3-1 guard: the swap guard is armed while the model rule reads, so no switch lands mid rotation', () => withRig({
  rows: [{ name: 'a' }, { name: 'b' }], chatModel: 'opus', bodies: { a: async () => { await sleep(40); return apiBody({ five: 100 }); }, b: apiBody({ five: 0, week: 10, fable: 5 }) },
}, async (r) => {
  const rotation = r.api.rotateOffLimitedAccount(SESSION, { model: 'opus' });
  await sleep(15);
  assert.ok(r.api.cooldown() > Date.now(), 'the guard was down while the rotation read its account');
  const rot = await rotation;
  assert.equal(rot.outcome, 'swapped');
}));

await test('R3-2 AC-3 Opus out and Fable free on a known account: a lane in fallback starts on Fable with one true notice', () => withRig({
  rows: [{ name: 'a', modelLimits: { fable: { until: sec(NOW - 60_000) }, opus: { until: sec(NOW + 120 * HOUR) } } }], bodies: { a: apiBody({ five: 20, week: 60, fable: 10, opus: 100 }) },
}, async (r) => {
  r.api.modelFallbacks.set('chat', true);
  const starts = [];
  for (let i = 0; i < 3; i++) { starts.push(r.start(r.lane)); await settle(); }
  assert.deepEqual(starts, ['fable', 'fable', 'fable']);
  assert.equal(r.notices.length, 1);
  assert.equal(r.notices[0], sysmsg.modelFallbackNotice({ restored: true }));
}));

await test('R3-3 a refused Fable run inside a rotation cooldown is still read once, and the retry runs on Opus', () => withRig({
  rows: [{ name: 'a' }, { name: 'b' }],
  bodies: { a: body({ five: 100, fiveAt: sec(NOW + HOUR) }), b: (n) => (n === 1 ? body({ five: 0, week: 40, weekly: sec(NOW + 90 * HOUR), fable: 95 }) : body({ five: 5, week: 41, weekly: sec(NOW + 90 * HOUR), fable: 100 })) },
}, async (r) => {
  await r.accountUsage.one('a');
  const worker = await r.api.rotateOffLimitedAccount(SESSION, { model: 'opus', rejectedLimit: fiveWallEvent(), rejectedAccount: 'a' });
  assert.equal(worker.outcome, 'swapped');
  await sleep(50); await settle();
  assert.ok(r.api.cooldown() > Date.now(), 'the cooldown is armed');
  const bBefore = gets(r, 'b');
  const start = r.start(r.lane); await settle();
  assert.equal(start, 'fable');
  // b's own refusal: its weekly window resets on b's clock, not a's.
  const ev = realEvent(); const Wb = sec(NOW + 90 * HOUR);
  ev.rate_limit_info.resetsAt = Wb; ev.rate_limit_info.unifiedWindows.seven_day.resetsAt = Wb; ev.rate_limit_info.unifiedWindows.seven_day_overage_included.resetsAt = Wb;
  const h = streamHandler(r, start, r.liveAccount.peek());
  h.feed(ev);
  // The CLI's exit and the close handler sit between the refusal and the
  // rotation (the review 3 repro waits 30 ms here too).
  await sleep(30); await settle();
  const plan = await r.api.handleChatLimitFailure(WALL, { text: 'm', lane: r.lane, model: start, rejectedLimit: h.run.rejectedLimit, rejectedAccount: h.run.rejectedAccount });
  plan.dispatch(); await settle();
  assert.equal(r.dispatched.at(-1).model, 'opus', 'the retry starts on Fable again and will be refused');
  assert.equal(gets(r, 'b') - bBefore, 1, 'one read for the one refused run');
}));

await test('R3-4 a legacy recheck does not starve the read a later Fable refusal needs', () => withRig({
  rows: [{ name: 'a', limitedUntil: weekReset, limitedSource: 'probe', limitedVerifiedAt: new Date(NOW - 3 * 3600e3).toISOString() }], chatModel: 'opus',
  bodies: { a: (n) => (n === 1 ? apiBody({ five: 20, week: 60, fable: 90 }) : apiBody({ five: 21, week: 61, fable: 100 })) },
}, async (r) => {
  await r.api.kickAutoSwitch();
  await Promise.all([...r.api.pendingOps]); await settle();
  assert.equal(gets(r, 'a'), 1);
  await sleep(10);
  handleEvent(r, realEvent(), 'opus', 'a');
  await sleep(30); await settle();
  assert.ok(r.row('a').modelLimits?.fable, 'the Fable limit was not recorded: the read was refused by a shared slot');
}));

for (const gap of [0, 400]) await test(`R3-5 a retry ${gap} ms after a swap that moved a Fable lane onto Opus: Opus, and exactly one notice`, () => withRig({
  rows: [{ name: 'a' }, { name: 'b' }], bodies: { a: apiBody({ five: 100, week: 60, fable: 10 }), b: apiBody({ five: 0, week: 10, fable: 100 }) },
}, async (r) => {
  const first = r.start(r.lane); await settle();
  assert.equal(first, 'fable');
  const h = streamHandler(r, first, 'a');
  h.feed(fiveWallEvent());
  r.setCredDelay(60);
  const plan = await r.api.handleChatLimitFailure(SESSION, { text: 'm', lane: r.lane, model: first, rejectedLimit: h.run.rejectedLimit, rejectedAccount: h.run.rejectedAccount });
  if (gap) await sleep(gap);
  plan.dispatch(); await sleep(300); await settle();
  const next = r.start(r.lane); await settle();
  assert.deepEqual([r.dispatched[0].model, next], ['opus', 'opus']);
  assert.equal(fallbackNotices(r), 1, `notices: ${JSON.stringify(r.notices)}`);
  assert.equal(restoredNotices(r), 0);
}));

await test('R3-6 a background worker refused Fable resumes on Opus, with one notice, even when the tracker cannot name the account', () => withRig({
  rows: [{ name: 'a' }], bgModel: 'fable', bodies: { a: apiBody() },
}, async (r) => {
  const run = handleEvent(r, realEvent(), 'fable', 'a');
  await settle();
  const resumes = [];
  let drains = 0;
  const deps = {
    rotateOffLimitedAccount: r.api.rotateOffLimitedAccount, wallGuard: { jobOf: () => ({ model: 'fable' }) },
    noteWallDeath: () => {}, resumeWallDeaths: (ep, opts) => { resumes.push(opts); return { resumed: [{ runId: 'job' }] }; },
    rotationBehindCooldown: async () => null, runSalvage: async () => '', handBackToChat: () => { throw new Error('handed back instead of resumed'); },
    send: async () => {}, swapFailedLine: () => '', drainBgHandoff: () => { drains++; },
  };
  const handleLimitDeath = new Function(...Object.keys(deps), `${grab('handleLimitDeath')} return handleLimitDeath;`)(...Object.values(deps));
  await handleLimitDeath('task', { answer: WALL, model: 'fable', rejectedLimit: run.rejectedLimit, rejectedAccount: run.rejectedAccount }, 'job');
  assert.equal(resumes.length, 1);
  assert.equal(drains, 1, 'the resume waits for the next long poll');
  // The resume reaches the drain as a drop box item, and the drain hands its
  // fields to dispatchPrompt, whose queueItem is the real one.
  const item = r.api.queueItem('resumed brief', { carriedModel: resumes[0].only?.carriedModel, retryModel: resumes[0].only?.carriedModel?.model });
  r.setLiveBlob({ claudeAiOauth: { accessToken: 'access-token-for-a-ROTATED', refreshToken: 'ROTATED-refresh-token-not-in-any-slot-xxxx' } });
  r.liveAccount.invalidate(); await r.liveAccount.refresh();
  assert.equal(r.liveAccount.peek(), null);
  assert.equal(r.start(r.bgLane, carriedOf(item)), 'opus');
  await settle();
  assert.equal(fallbackNotices(r), 1);
}));

await test('R3-7 a parked message keeps its carried decision when the wall lifts', () => withRig({ rows: [{ name: 'a' }], bodies: {} }, async (r) => {
  const sent = [];
  const parkedWalledChats = [r.api.queueItem('parked retry', { retried: true, carriedModel: { model: 'opus', told: true }, retryModel: 'opus' })];
  const deps = { parkedWalledChats, canRunHeldItem: () => true, logAccountDecision: () => {}, claudeWalled: () => false, codexWalled: () => false,
    pendWallResolution: () => false, settleWall: () => {}, wallNotices: new Map(), send: async () => {}, enginesBackLine: () => 'back',
    LANES: r.api && { main: r.lane }, getBgLane: () => r.bgLane, dispatchPrompt: (text, lane, opts) => sent.push({ text, opts }) };
  const flush = new Function(...Object.keys(deps), `${grab('flushParkedWalledChats')} return flushParkedWalledChats;`)(...Object.values(deps));
  flush();
  r.setLiveBlob({ claudeAiOauth: { accessToken: 'access-token-for-a-ROTATED', refreshToken: 'ROTATED-refresh-token-not-in-any-slot-xxxx' } });
  r.liveAccount.invalidate(); await r.liveAccount.refresh();
  assert.equal(sent.length, 1);
  assert.equal(r.start(r.lane, carriedOf(sent[0].opts)), 'opus');
}));

// ---------------------------------------------------------------------------
// QA rounds 1 and 3 of this restructure (qa-agent)
// ---------------------------------------------------------------------------

await test('QA1-1 a retry after a swap, refused Fable only on the new account, continues on Opus; other internal traffic keeps its failure', () => withRig({
  rows: [{ name: 'a' }, { name: 'b' }], bodies: { a: apiBody({ five: 100, week: 60, fable: 10 }), b: { status: 429, retryAfter: '600' } },
}, async (r) => {
  const first = r.start(r.lane); await settle();
  const h = streamHandler(r, first, 'a');
  h.feed(fiveWallEvent());
  const plan1 = await r.api.handleChatLimitFailure(SESSION, { text: 'm', lane: r.lane, model: first, rejectedLimit: h.run.rejectedLimit, rejectedAccount: h.run.rejectedAccount });
  plan1.dispatch(); await settle();
  const retry = r.dispatched.at(-1);
  assert.equal(retry.model, 'fable', 'the swap target had no known Fable limit');
  const ev = realEvent(); const Wb = sec(NOW + 90 * HOUR);
  ev.rate_limit_info.resetsAt = Wb; ev.rate_limit_info.unifiedWindows.seven_day.resetsAt = Wb; ev.rate_limit_info.unifiedWindows.seven_day_overage_included.resetsAt = Wb;
  await sleep(20);
  const h2 = streamHandler(r, retry.model, r.liveAccount.peek());
  h2.feed(ev);
  const plan2 = await r.api.handleChatLimitFailure(WALL, { text: 'm', lane: r.lane, model: retry.model, retried: true, priority: true, rejectedLimit: h2.run.rejectedLimit, rejectedAccount: h2.run.rejectedAccount });
  assert.equal(plan2.line, sysmsg.chatModelFallbackLine());
  plan2.dispatch(); await settle();
  assert.equal(r.dispatched.at(-1).model, 'opus');
  assert.equal(r.counts.credWrites, 1, 'no second swap');
  // A compaction or another internal turn (priority, not a retry) keeps its own failure.
  const internal = r.api.chatLimitRetryPlan({ outcome: 'model_limit', activeName: 'b', nextName: 'b' }, { priority: true });
  assert.equal(internal, null);
}));

await test('QA1-3 a refusal no account can be named for keeps the evidence; only an allowed response clears it', () => withRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() } }, async (r) => {
  const h = streamHandler(r, 'fable', 'a');
  const own = realEvent();
  h.feed(own);
  assert.equal(h.run.rejectedAccount, 'a');
  // The same refusal with nothing to file it under: no live name, no spawn name, no anchor.
  const loose = realEvent(); loose.rate_limit_info.unifiedWindows.seven_day.resetsAt = sec(NOW + 300 * HOUR); loose.rate_limit_info.unifiedWindows.five_hour.resetsAt = sec(NOW + 299 * HOUR);
  const orphan = streamHandler(r, 'fable', null);
  orphan.run.rejectedLimit = own; orphan.run.rejectedAccount = 'a';
  r.setLiveBlob(null); r.liveAccount.invalidate(); await r.liveAccount.refresh();
  orphan.feed(loose);
  assert.equal(orphan.run.rejectedAccount, 'a', 'an unplaceable refusal erased the evidence');
  orphan.feed(allowedEvent());
  assert.equal(orphan.run.rejectedLimit, null);
}));

await test('QA3-3 a carried Opus decision gives way when the named account shows Fable open: no Opus run, no past clock', () => withRig({
  rows: [{ name: 'a', modelLimits: { fable: { until: sec(NOW - 2 * HOUR) } } }], bgModel: 'fable', bodies: {},
}, async (r) => {
  assert.equal(r.start(r.bgLane, { model: 'opus', told: false }), 'fable');
  await settle();
  assert.equal(r.notices.length, 0, JSON.stringify(r.notices));
  assert.equal(r.start(r.bgLane), 'fable');
  await settle();
  assert.equal(r.notices.length, 0);
}));

// ---------------------------------------------------------------------------
// The live behaviors the restructure keeps (brief criterion 4)
// ---------------------------------------------------------------------------

await test('AC-4 a usage reading with scoped rows records them and updates the export', () => withRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() } }, async (r) => {
  assert.equal(r.exported(), null);
  await r.accountUsage.one('a');
  assert.equal(r.row('a').modelLimits.fable.until, weekReset);
  const out = r.exported();
  assert.equal(out.active, 'a');
  assert.equal(out.models.fable.blocked, true);
}));

await test('R2-F2c a stale subagent refusal followed by allowed responses is not the run\'s refusal', () => withRig({ rows: [{ name: 'a' }, { name: 'b' }], chatModel: 'opus', bodies: { a: apiBody({ five: 99, week: 60, fable: 100 }), b: apiBody({ five: 0, week: 10, fable: 5 }) } }, async (r) => {
  const h = streamHandler(r, 'opus', 'a');
  h.feed(realEvent()); h.feed(allowedEvent());
  assert.equal(h.run.rejectedLimit ?? null, null, 'the run went on after the refusal, yet it is kept as the run\'s refusal');
}));

summary();
