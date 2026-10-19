import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { modelFamily, scopedLimits, modelBlocked, refusalScope, decideRunModel, writeModelLimits } from './model-limits.mjs';
import { normalizeUsage, renderAccountList } from './account-usage.mjs';
import { switchTargetVerdict } from './account-autoswitch.mjs';
import { createAccountStore } from './accounts.mjs';
import { selectAccount, createRecheckLimiter } from './account-selector.mjs';
const now = Date.parse('2026-10-12T19:10:00Z');
const until = Date.parse('2026-10-15T14:00:00Z') / 1000;
const usage = normalizeUsage({ five_hour: { utilization: 0 }, seven_day: { utilization: 90, resets_at: new Date(until * 1000).toISOString() }, seven_day_fable: { utilization: 100, resets_at: new Date(until * 1000).toISOString() } });
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`ok ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); } }
await test('family aliases and unknowns', () => {
  for (const name of ['fable','opus','sonnet','haiku']) assert.equal(modelFamily(name), name);
  assert.equal(modelFamily('claude-opus-5-5'), 'opus');
  assert.equal(modelFamily('mystery'), null);
  assert.equal(modelBlocked({ modelLimits: scopedLimits(usage, now) }, 'mystery', now), true);
});
await test('scoped ledger does not become a global wall', () => {
  const limits = scopedLimits(usage, now);
  assert.equal(limits.fable.until, until);
  assert.equal(modelBlocked({ modelLimits: limits }, 'opus', now), false);
});
await test('legacy selection converts a 96 percent account on fresh evidence', async () => {
  const u = structuredClone(usage); u.sevenDay.percent = 96;
  const a = { name: 'legacy', claudeAiOauth: {}, limitedUntil: until, limitedSource: 'probe' };
  const options = { accounts: [a], now, model: 'opus', recheck: createRecheckLimiter(), probe: async () => ({ name: a.name, state: 'ok', readAt: now, usage: u }) };
  const result = await selectAccount(options);
  assert.equal(result.name, 'legacy');
  assert.equal(result.cleared[0].modelLimits.fable.until, until);
  const kept = await selectAccount({ ...options, recheck: createRecheckLimiter(), probe: async () => null });
  assert.equal(kept.name, null);
  assert.deepEqual(a.modelLimits, undefined);
});
await test('a newly rejected model wall cannot be lifted by a cached open row', async () => {
  const a = { name: 'recent', claudeAiOauth: {}, modelLimits: { fable: { until, verifiedAt: new Date(now).toISOString() } } };
  const open = structuredClone(usage); open.scoped[0].percent = 0; open.sevenDay.percent = 50;
  const result = await selectAccount({ model: 'fable', accounts: [a], now, recheck: createRecheckLimiter(), probe: async () => ({ name: a.name, state: 'ok', readAt: now - 1000, usage: open }) });
  assert.equal(result.name, null);
});
await test('one decision: Fable falls back to Opus once, restores once, and says nothing it cannot tell', () => {
  const out = { name: 'a', modelLimits: scopedLimits(usage, now) };
  const open = { name: 'a', modelLimits: {} };
  const decide = (o) => decideRunModel({ configured: 'fable', now, ...o });
  assert.deepEqual(decide({ account: out }), { model: 'opus', fallback: true, notice: 'fallback', until });
  assert.equal(decide({ account: out, previous: { fallback: true } }).notice, null);
  assert.deepEqual(decide({ account: open, previous: { fallback: true } }), { model: 'fable', fallback: false, notice: 'restored', until: null });
  assert.equal(decide({ account: open }).notice, null);
  // Unknown, walled for every model, or both models out: the last decision, silent.
  const both = { name: 'a', modelLimits: { ...scopedLimits(usage, now), opus: { until } } };
  for (const account of [null, { ...open, limitedUntil: until }, both]) {
    for (const fallback of [false, true]) {
      assert.deepEqual(decide({ account, previous: { fallback } }), { model: fallback ? 'opus' : 'fable', fallback, notice: null, until: null });
    }
  }
  // Opus out and Fable free on a known account: Fable, with one true notice.
  assert.deepEqual(decide({ account: { name: 'a', modelLimits: { opus: { until } } }, previous: { fallback: true } }).model, 'fable');
  // A carried decision wins, announced only when nothing has said it yet.
  assert.equal(decide({ account: null, carried: { model: 'opus', told: true } }).model, 'opus');
  assert.equal(decide({ account: null, carried: { model: 'opus', told: true } }).notice, null);
  assert.equal(decide({ account: null, carried: { model: 'opus', told: false } }).notice, 'fallback');
  assert.equal(decide({ account: null, previous: { fallback: true }, carried: { model: 'opus' } }).notice, null);
  // ...unless the named account shows Fable open: a resume held past the reset runs Fable, unannounced.
  assert.deepEqual(decide({ account: open, carried: { model: 'opus', told: false } }), { model: 'fable', fallback: false, notice: null, until: null });
  assert.equal(decide({ account: out, carried: { model: 'opus', told: false } }).model, 'opus');
  // A lane not configured for Fable is never touched and never announced.
  assert.deepEqual(decideRunModel({ configured: 'opus', account: out, previous: { fallback: true }, now }), { model: 'opus', fallback: false, notice: null, until: null });
  assert.equal(decideRunModel({ configured: 'claude-fable-5-1', account: out, now }).model, 'opus');
  assert.equal(decideRunModel({ configured: 'claude-fable-5-1', account: open, now }).model, 'claude-fable-5-1');
});
await test('rejected scoped window is classified, uncertain evidence stays global', () => {
  const event = { rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: until, unifiedWindows: { five_hour: { utilization: 0.57 }, seven_day: { utilization: 0.95 }, seven_day_overage_included: { utilization: 1 } } } };
  assert.equal(refusalScope({ model: 'fable', usage, event, now }).family, 'fable');
  assert.equal(refusalScope({ model: 'fable', usage: null, event, now }).family, 'fable');
  const missing = structuredClone(event); delete missing.rate_limit_info.unifiedWindows.five_hour;
  assert.equal(refusalScope({ model: 'fable', usage, event: missing, now }), null);
  const u = structuredClone(usage); u.sevenDay.percent = 100;
  const full = structuredClone(event); full.rate_limit_info.unifiedWindows.seven_day.utilization = 1;
  assert.equal(refusalScope({ model: 'fable', usage, event: full, now }), null);
  assert.equal(refusalScope({ model: 'fable', usage: u, now }), null);
  assert.equal(refusalScope({ model: 'opus', usage, event, now }).family, 'opus');
});
await test('named account switches respect model walls without a lookup', () => {
  const rows = [{ name: 'a', captured: true, modelLimits: scopedLimits(usage, now) }];
  assert.equal(switchTargetVerdict({ target: 'a', rows, model: 'fable', now }).ok, false);
  assert.equal(switchTargetVerdict({ target: 'a', rows, model: 'opus', now }).ok, true);
});
await test('account label and scoped bar', () => {
  const out = renderAccountList({ rows: [{ name: 'a', captured: true, modelLimits: scopedLimits(usage, now) }], live: { name: 'a' }, usageRows: [{ name: 'a', state: 'ok', usage }] }, { now });
  assert.match(out, /Fable out.*Opus ok/); assert.match(out, /Fable.*100%/);
  assert.doesNotMatch(out, /limited|[\u2013\u2014]/);
});
await test('state first write, update and clear are atomic and private', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.model-limits-test-'));
  try {
    const file = path.join(dir, 'state', 'model-limits.json');
    let renames = 0;
    const io = { ...fs, renameSync: (from, to) => {
      assert.notEqual(from, to); assert.equal(to, file);
      assert.equal(fs.statSync(from).mode & 0o777, 0o600);
      JSON.parse(fs.readFileSync(from, 'utf8'));
      if (renames) assert.equal(JSON.parse(fs.readFileSync(to, 'utf8')).active, 'a');
      renames++; fs.renameSync(from, to);
    } };
    const limits = scopedLimits(usage, now);
    writeModelLimits(file, 'a', limits, { now, fs: io });
    limits.fable.percent = 101;
    writeModelLimits(file, 'a', limits, { now, fs: io });
    writeModelLimits(file, 'a', {}, { now, fs: io });
    assert.equal(renames, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).models, {});
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['model-limits.json']);
    const store = createAccountStore({ file: path.join(dir, 'accounts.json') });
    fs.writeFileSync(store.file, JSON.stringify([{ name: 'a', limitedUntil: until }]));
    assert.equal(store.setModelLimits('a', limits).ok, true);
    store.clearLimit('a');
    assert.equal(store.describe(now)[0].limited, false);
    assert.equal(store.describe(now)[0].modelLimits.fable.until, until);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
