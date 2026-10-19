import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import * as models from './model-limits.mjs';
import { createAccountStore } from './accounts.mjs';
import { selectAccount, createRecheckLimiter, PROBE_TIMEOUT_MS } from './account-selector.mjs';
import { normalizeUsage, fmtResetClock } from './account-usage.mjs';
import { modelFallbackNotice, chatModelFallbackLine } from './system-messages.mjs';
import { runPrefix } from './fixtures/model-owner-rig.mjs';

const source = fs.readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');
function grab(name) {
  const lines = source.split('\n');
  const start = lines.findIndex(l => new RegExp(`^(?:async )?function ${name}\\(`).test(l));
  assert.ok(start >= 0, name);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end + 1).join('\n');
}
const dir = fs.mkdtempSync(path.join(process.cwd(), '.model-wiring-'));
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`ok ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); } }
try {
  const file = path.join(dir, 'accounts.json');
  const reset = new Date(Date.now() + 2 * 86400_000).toISOString();
  const rows = ['a','b','c'].map(name => ({ name, claudeAiOauth: { accessToken: 'fixture' }, limitedUntil: Math.ceil(Date.parse(reset) / 1000), limitedSource: 'probe' }));
  fs.writeFileSync(file, JSON.stringify(rows));
  const accounts = createAccountStore({ file });
  let active = 'a';
  let configured = 'fable';
  accounts.activeAccount = async () => ({ account: accounts.listAccounts().find(a => a.name === active) });
  const readings = new Map(rows.map((a, i) => [a.name, normalizeUsage({ five_hour: { utilization: 0 }, seven_day: { utilization: i ? 96 : 90, resets_at: reset }, seven_day_fable: { utilization: 100, resets_at: reset } })]));
  const notices = [], logs = [];
  const lane = { name: 'main' };
  const deps = {
    ...models, path, HOME: dir, accounts, modelFallbackNotice, chatModelFallbackLine, fmtResetClock, OWNER_TZ: 'America/Toronto',
    LANES: { main: lane }, BG_MODEL: 'fable', chatState: () => ({ model: configured }), DEFAULT_MODEL: 'opus',
    liveAccount: { current: () => active, peek: () => active }, PROBE_TIMEOUT_MS, selectAccount, limitRecheck: createRecheckLimiter(),
    withDeadline: promise => promise,
    send: async line => { notices.push(line); },
    logAccountDecision: d => logs.push(d),
    flagLoginsFromRows: () => {}, flagNeedsLogin: () => {}, fmtLeft: () => 'later',
    swapOnSwitchChain: async name => { active = name; return { ok: true }; },
    accountUsage: { one: async name => {
      const usage = readings.get(name);
      if (!usage) return null;
      api.reconcileModelUsage(name, usage);
      return { name, state: 'ok', readAt: Date.now(), usage };
    } },
  };
  const api = new Function(...Object.keys(deps), `const modelFallbacks = new Map();\nlet lastAccountSwap = null;\n${['publishModelLimits','reconcileModelUsage','laneModel','pickHealthyAccount','startModel'].map(grab).join('\n')}\nreturn { startModel, reconcileModelUsage, publishModelLimits };`)(...Object.values(deps));
  await test('ten Fable starts use held model limits with no account work', async () => {
    for (const a of rows) api.reconcileModelUsage(a.name, readings.get(a.name));
    let reads = 0, swaps = 0, keychain = 0;
    deps.accountUsage.one = async () => { reads++; throw Error('unexpected usage read'); };
    accounts.activeAccount = async () => { keychain++; throw Error('unexpected keychain read'); };
    for (let n = 0; n < 10; n++) assert.equal(api.startModel(lane), 'opus');
    await Promise.resolve();
    assert.equal(reads, 0); assert.equal(keychain, 0); assert.equal(active, 'a');
    assert.equal(notices.length, 1); assert.match(notices[0], /Model: Opus/);
    for (const a of accounts.listAccounts()) {
      assert.equal(a.limitedUntil, null);
      assert.ok(a.modelLimits.fable.until > Date.now() / 1000);
    }
    assert.ok(logs.some(d => d.decision === 'model_fallback'));
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.claude/state/model-limits.json')));
    assert.equal(state.active, active); assert.equal(state.models.fable.blocked, true);
  });
  await test('the start decision returns to Fable once after its fresh reading opens', async () => {
    readings.get(active).scoped[0].percent = 20;
    api.reconcileModelUsage(active, readings.get(active));
    assert.equal(api.startModel(lane), 'fable');
    assert.equal(api.startModel(lane), 'fable');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(notices.length, 2); assert.match(notices[1], /Fable: available/);
    assert.ok(logs.some(d => d.decision === 'model_restored'));
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.claude/state/model-limits.json')));
    assert.deepEqual(state.models, {});
  });
  await test('an owner change to Opus does not announce that Fable recovered', async () => {
    readings.get(active).scoped[0].percent = 100;
    api.reconcileModelUsage(active, readings.get(active));
    assert.equal(api.startModel(lane), 'opus');
    const count = notices.length;
    configured = 'opus';
    assert.equal(api.startModel(lane), 'opus');
    assert.equal(notices.length, count);
  });
  await test('a wall recheck tries configured Fable before Opus', async () => {
    const tried = [];
    const d = { modelFamily: models.modelFamily, laneModel: () => 'fable', CONFIG_WALL_UNTIL: 0, rotationPausedUntil: 0,
      accounts: { describe: () => [{ name: 'free', captured: true, limited: false }] },
      limitRecheck: { due: () => true }, claudeRunInFlight: () => false,
      pickHealthyAccount: async opts => { tried.push(opts.model); return { name: 'free' }; },
    };
    const run = new Function(...Object.keys(d), `${grab('recheckDuringWall')} return recheckDuringWall;`)(...Object.values(d));
    await run();
    assert.deepEqual(tried, ['fable']);
  });
  await test('a worker refused Fable only resumes through the existing flow, carrying Opus unannounced', async () => {
    let recorded = 0, drains = 0;
    const resumes = [];
    const d = {
      wallGuard: { jobOf: () => ({ model: 'fable' }) },
      rotateOffLimitedAccount: async (detail, opts) => { assert.equal(opts.model, 'fable'); return { outcome: 'model_limit', activeName: 'a', nextName: 'a', lines: ['x'] }; },
      noteWallDeath: () => { recorded++; },
      resumeWallDeaths: (episode, opts) => { resumes.push(opts); assert.equal(episode.workers[0].runId, 'job'); return { resumed: [{ runId: 'job' }] }; },
      drainBgHandoff: () => { drains++; },
    };
    const run = new Function(...Object.keys(d), `${grab('handleLimitDeath')} return handleLimitDeath;`)(...Object.values(d));
    await run('task', { answer: 'limit', model: 'fable' }, 'job');
    assert.equal(recorded, 1);
    assert.equal(resumes.length, 1);
    assert.deepEqual(resumes[0].only, { runId: 'job', carriedModel: { model: 'opus', told: false } });
    assert.equal(drains, 1, 'the resume starts now, not at the next long poll');
  });
  await test('a refused chat turn continues on Opus on the same account, the line being its notice', () => {
    const retry = new Function('chatModelFallbackLine', `${grab('chatLimitRetryPlan')} return chatLimitRetryPlan;`)(chatModelFallbackLine);
    const rot = { outcome: 'model_limit', activeName: 'a', nextName: 'a' };
    const first = retry(rot);
    assert.deepEqual(first.retry, { priority: true, carriedModel: { model: 'opus', told: true } });
    assert.equal(first.line, chatModelFallbackLine());
    // Their retry refused Fable only still continues on Opus: no account is burnt.
    assert.deepEqual(retry(rot, { retried: true, priority: true }), first);
    // Other internal traffic keeps its own failure.
    assert.equal(retry(rot, { priority: true }), null);
  });
  await test('launch uses the start decision and carries refusal evidence to both handlers', () => {
    assert.match(source, /args\.push\('--model', selectedModel\)/);
    assert.match(source, /model: run\.requestedModel,\s+rejectedLimit: run\.rejectedLimit/);
    assert.match(source, /bgOutcome\(bgTexts, resultEvent, code, stderrTail\), model: run\.requestedModel, rejectedLimit: run\.rejectedLimit/);
  });
  await test('the real runClaude start hands the carried decision to the start decision', async () => {
    const decide = (_lane, carried) => carried?.model || 'fable';
    const plain = runPrefix(decide);
    await plain.run('message', plain.lane);
    assert.equal(plain.counts().model, 'fable');
    const carried = runPrefix(decide);
    await carried.run('continuation', carried.lane, { carriedModel: { model: 'opus', told: true } });
    assert.equal(carried.counts().model, 'opus');
  });
  await test('chat refusal continuation: the bubble line is the one notice, and the next start keeps Opus silently', async () => {
    const sent = [], spawned = [];
    const d = { ...deps, isLimitSignal: () => true, WALL_WAKE_TAG: 'wake:', codexTakingChat: () => false, codexCanTakeChat: () => false,
      withoutWallWakeNote: value => value, send: async line => sent.push(line),
      rotateOffLimitedAccount: async () => ({ outcome: 'model_limit', activeName: active, nextName: active, lines: ['x'] }),
      dispatchPrompt: (text, lane, opts) => { spawned.push({ text, model: integrated.startModel(lane, opts.carriedModel), opts }); },
    };
    configured = 'fable';
    api.reconcileModelUsage(active, readings.get(active));
    const integrated = new Function(...Object.keys(d), `const modelFallbacks = new Map();\nlet lastAccountSwap = null;\n${['laneModel','startModel','chatLimitRetryPlan','handleChatLimitFailure'].map(grab).join('\n')}\nreturn { startModel, handleChatLimitFailure };`)(...Object.values(d));
    const result = await integrated.handleChatLimitFailure('limit', { text: 'continue me', lane, model: 'fable' });
    assert.equal(result.line, chatModelFallbackLine());
    result.dispatch();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(spawned.length, 1); assert.equal(spawned[0].model, 'opus');
    assert.equal(spawned[0].opts.retried, true); assert.equal(active, 'a');
    assert.equal(integrated.startModel(lane), 'opus');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(sent.length, 0, 'the existing progress bubble is the one notice');
    const internal = await integrated.handleChatLimitFailure('limit', { text: 'compaction', lane, model: 'fable', priority: true });
    assert.equal(internal.dispatch, null);
  });
  await test('one owner: one function decides the start model, every start reaches it, nothing else writes the lane decision', () => {
    const calls = (re) => (source.match(re) || []).length;
    assert.equal(calls(/decideRunModel\(/g), 1, 'decideRunModel is called once');
    assert.match(grab('startModel'), /decideRunModel\(/);
    assert.equal(calls(/\bstartModel\(/g), 2, 'declared once, called once');
    assert.match(grab('runClaude'), /startModel\(lane, carriedModel\)/);
    assert.equal(calls(/modelFallbacks\.set\(/g), 1, 'only startModel writes the lane decision');
    assert.match(grab('startModel'), /modelFallbacks\.set\(/);
    assert.equal(calls(/'--model'/g), 2, 'the run spawn plus the read-only handoff capture');
    assert.equal(calls(/runClaude\(/g), 3, 'declared once, called by dispatchPrompt and drainQueue');
    for (const gone of ['prepareRunModel', 'chooseRunModel', 'modelTransition', 'retryModel']) assert.equal(source.includes(gone), false, gone);
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
