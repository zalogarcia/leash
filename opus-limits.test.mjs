import assert from 'node:assert/strict';
import { normalizeUsage, accountUsageBlock } from './account-usage.mjs';
import { probeVerdict, selectAccount, limitClearVerdict, createRecheckLimiter } from './account-selector.mjs';
import { autoSwitchDecision } from './account-autoswitch.mjs';

const now = Date.parse('2026-10-12T19:10:00Z');
const reset = '2026-10-15T14:00:00Z';
export const fixtures = [
  ['c@example.com', 90, 100, reset],
  ['b@example.com', 87, 100, '2026-10-15T13:59:59Z'],
  ['ab@example.com', 96, 100, '2026-10-13T06:00:00Z'],
  ['a@example.com', 94, 98, reset],
].map(([name, week, fable, resets_at]) => ({ name, state: 'ok', readAt: now,
  usage: normalizeUsage({ limits: [
    { kind: 'session', percent: 0, resets_at: null },
    { kind: 'weekly_all', percent: week, resets_at },
    { kind: 'weekly_scoped', percent: fable, resets_at, scope: { model: { display_name: 'Fable' } } },
  ], extra_usage: { is_enabled: false } }),
}));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
await test('1 and 2: measured Fable walls leave Opus open', () => {
  for (const row of fixtures.slice(0, 3)) {
    assert.equal(probeVerdict(row, { now, model: 'opus' }).state, 'healthy');
    assert.equal(probeVerdict(row, { now, model: 'fable' }).state, 'exhausted');
  }
});
await test('3: global walls block every model', () => {
  for (const key of ['fiveHour', 'sevenDay']) for (const model of ['opus', 'fable', 'sonnet', 'haiku']) {
    const row = structuredClone(fixtures[0]); row.usage[key].percent = 100; row.usage[key].resetsAt = reset;
    assert.equal(probeVerdict(row, { now, model }).state, 'exhausted');
  }
});
await test('4: scoped Opus wall leaves Fable open', () => {
  const row = structuredClone(fixtures[0]); row.usage.sevenDay.percent = 80; row.usage.scoped[0].label = 'Opus';
  assert.equal(probeVerdict(row, { now, model: 'fable' }).state, 'healthy');
  assert.equal(probeVerdict(row, { now, model: 'opus' }).state, 'exhausted');
});
await test('5: legacy conversion at 90 percent needs a fresh reading', () => {
  const opts = { name: fixtures[0].name, now, model: 'opus', legacy: true };
  assert.equal(limitClearVerdict(fixtures[0], opts).clear, true);
  assert.equal(limitClearVerdict(null, opts).clear, false);
});
await test('6: Opus selects a measured account', async () => {
  const rows = fixtures.slice(0, 2);
  const result = await selectAccount({ model: 'opus', now, activeName: 'spent',
    accounts: rows.map(r => ({ name: r.name, claudeAiOauth: {} })),
    probe: async name => rows.find(r => r.name === name), recheck: createRecheckLimiter(),
  });
  assert.equal(result.name, rows[0].name);
  assert.match(result.probed[0].reason, /90%/);
});
await test('fallback chooses the most weekly headroom', async () => {
  const rows = fixtures.slice(0, 2);
  const result = await selectAccount({ model: 'opus', preferHeadroom: true, now,
    accounts: rows.map(r => ({ name: r.name, claudeAiOauth: {} })),
    probe: async name => rows.find(r => r.name === name),
  });
  assert.equal(result.name, rows[1].name);
});
await test('9: Fable 98 percent cannot move an Opus lane', () => {
  const usage = structuredClone(fixtures[3].usage); usage.sevenDay.percent = 60;
  const decision = autoSwitchDecision({ model: 'opus', now, active: { name: 'active', usage } });
  assert.equal(decision.reason, 'below the thresholds');
});
await test('10: account draws scoped row', () => {
  assert.match(accountUsageBlock(fixtures[0], { now }).join('\n'), /Fable.*100%/);
});
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
