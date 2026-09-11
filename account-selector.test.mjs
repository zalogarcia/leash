#!/usr/bin/env node
// THE SELECTION RULE, on its own: which account a run starts on, and which ones
// are skipped without being tried.
//
// Pure by construction, so every case here runs with no network, no credential
// store, no daemon and no clock of its own. The probe is a function this file
// supplies, which is what lets "the API says this account is spent" be a value
// rather than a live subscription.
//
// SHARED SUITE, byte-identical in both bridge repos (scripts/check-shared.sh).
//
//   node account-selector.test.mjs

import { probeVerdict, selectAccount, EXHAUSTED_PERCENT, FALLBACK_WALL_SECONDS, PROBE_TIMEOUT_MS } from './account-selector.mjs';

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
const deepEq = (got, want, msg = '') => eq(JSON.stringify(got), JSON.stringify(want), msg);

const NOW = Date.UTC(2026, 8, 11, 16, 46, 0); // 2026-09-11 12:46 ET, the incident
const HOUR = 3600_000;
const iso = (ms) => new Date(NOW + ms).toISOString();
const secs = (ms) => Math.floor((NOW + ms) / 1000);

const win = (percent, resetsAt, extra = {}) => ({ percent, resetsAt, severity: null, locked: null, ...extra });
const usageRow = (usage, name = 'a') => ({ name, state: 'ok', usage });
const slot = (name, extra = {}) => ({ name, claudeAiOauth: { accessToken: 'a', refreshToken: 'r' }, ...extra });

// ---------------------------------------------------------------------------
console.log('\n1. probeVerdict: is this account spent, and until when');
// ---------------------------------------------------------------------------

await t('an account with headroom is healthy, and says which window is fullest', () => {
  const v = probeVerdict(usageRow({ fiveHour: win(13, iso(4 * HOUR)), sevenDay: win(18, iso(100 * HOUR)), scoped: [] }), { now: NOW });
  eq(v.state, 'healthy');
  eq(v.resetsAt, null);
  ok(/18% used on the weekly window/.test(v.reason), v.reason);
});

await t('★ THE INCIDENT: the wall is the per-model SCOPED window, not 5h and not weekly', () => {
  // The live reading of the account that was out of usage credits, taken the
  // same afternoon. Five hour window EMPTY, weekly window at 97%: a rule that
  // checks only those two calls this account healthy and hops onto it, which
  // is exactly what happened at 12:46.
  const v = probeVerdict(
    usageRow({
      fiveHour: { percent: 0, resetsAt: null, severity: 'normal', locked: null },
      sevenDay: win(97, iso(12 * HOUR)),
      scoped: [{ label: 'Fable', percent: 100, resetsAt: iso(12 * HOUR) }],
      extraUsage: { enabled: false, percent: 0, usedCredits: 0, monthlyLimit: 50000 },
    }),
    { now: NOW },
  );
  eq(v.state, 'exhausted');
  eq(v.resetsAt, secs(12 * HOUR));
  eq(v.reason, 'the weekly Fable window is spent');
});

await t('a five hour window at 100 is spent', () => {
  const v = probeVerdict(usageRow({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: win(54, iso(100 * HOUR)), scoped: [] }), { now: NOW });
  eq(v.state, 'exhausted');
  eq(v.resetsAt, secs(2 * HOUR));
});

await t('the LATEST spent window wins, not the soonest', () => {
  // A five hour window back in two hours is worth nothing under a full week,
  // and freeing the account at the earlier clock buys another death.
  const v = probeVerdict(usageRow({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: win(100, iso(50 * HOUR)), scoped: [] }), { now: NOW });
  eq(v.resetsAt, secs(50 * HOUR));
});

await t('a window with headroom is ignored however late it resets', () => {
  const v = probeVerdict(usageRow({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: win(40, iso(200 * HOUR)), scoped: [] }), { now: NOW });
  eq(v.resetsAt, secs(2 * HOUR), 'only a spent window is a wall');
});

await t("★ the server's own `locked` reason counts even with an unreadable percent", () => {
  const v = probeVerdict(
    usageRow({ fiveHour: { percent: null, resetsAt: iso(3 * HOUR), severity: null, locked: 'weekly_limit_reached' }, sevenDay: win(20, iso(80 * HOUR)), scoped: [] }),
    { now: NOW },
  );
  eq(v.state, 'exhausted');
  eq(v.resetsAt, secs(3 * HOUR));
});

await t('locked with no reset clock at all is still spent', () => {
  const v = probeVerdict(usageRow({ fiveHour: { percent: null, resetsAt: null, severity: null, locked: 'usage_credits' }, sevenDay: null, scoped: [] }), { now: NOW });
  eq(v.state, 'exhausted');
  eq(v.resetsAt, null, 'the caller applies its own fallback wall');
});

await t('★ 96% is NOT spent: a rounding allowance must not wall a working account', () => {
  // usageResetFor has a 95 tier, and it exists because the CLI and the API
  // round differently AFTER a wall has already happened. Here nothing has
  // happened yet, so skipping at 96 would take a healthy subscription out of
  // rotation on arithmetic.
  const v = probeVerdict(usageRow({ fiveHour: win(99, iso(3 * HOUR)), sevenDay: win(96, iso(20 * HOUR)), scoped: [] }), { now: NOW });
  eq(v.state, 'healthy');
  eq(EXHAUSTED_PERCENT, 100);
});

await t('a spent window whose reset has already passed is a stale reading, not a wall', () => {
  const v = probeVerdict(usageRow({ fiveHour: win(100, iso(-2 * HOUR)), sevenDay: win(10, iso(80 * HOUR)), scoped: [] }), { now: NOW });
  eq(v.state, 'healthy');
  eq(v.reason, 'every spent window has already reset');
});

await t('★ exhausted CREDITS alone are not a wall, because a full window already is', () => {
  // Credits are the overflow past a spent window: with a window still open
  // they change nothing, and with one spent the window above has already
  // walled the account. On the real out-of-credits account extra usage was
  // disabled entirely, so it was never the signal.
  const v = probeVerdict(
    usageRow({
      fiveHour: win(12, iso(4 * HOUR)),
      sevenDay: win(30, iso(90 * HOUR)),
      scoped: [],
      extraUsage: { enabled: true, percent: 100, usedCredits: 50000, monthlyLimit: 50000 },
    }),
    { now: NOW },
  );
  eq(v.state, 'healthy');
});

for (const [what, row] of [
  ['null', null],
  ['an error row', { name: 'a', state: 'refresh-failed', error: 'token expired', usage: null }],
  ['an ok row with no usage', { name: 'a', state: 'ok', usage: null }],
  ['an unavailable row', { name: 'a', state: 'unavailable', error: 'usage unavailable', usage: null }],
]) {
  await t(`★ ${what} reads as UNREADABLE, never as spent`, () => {
    const v = probeVerdict(row, { now: NOW });
    eq(v.state, 'unreadable', 'walling every account on a network blip is worse than the old behaviour');
  });
}

// ---------------------------------------------------------------------------
console.log('\n2. selectAccount: cycle until one has headroom');
// ---------------------------------------------------------------------------

const HEALTHY = (name) => usageRow({ fiveHour: win(13, iso(4 * HOUR)), sevenDay: win(18, iso(100 * HOUR)), scoped: [] }, name);
const SPENT = (name, at = 12 * HOUR) => usageRow({ fiveHour: win(100, iso(at)), sevenDay: win(50, iso(200 * HOUR)), scoped: [] }, name);

function harness(probes) {
  const asked = [];
  return {
    asked,
    probe: async (name) => {
      asked.push(name);
      if (probes[name] === 'throw') throw new Error('unreachable');
      return probes[name] ?? null;
    },
  };
}

await t('the first healthy candidate is taken, and nothing else is asked', async () => {
  const h = harness({ b: HEALTHY('b'), c: HEALTHY('c') });
  const r = await selectAccount({ accounts: [slot('a'), slot('b'), slot('c')], activeName: 'a', now: NOW, probe: h.probe });
  eq(r.outcome, 'selected');
  eq(r.name, 'b');
  deepEq(h.asked, ['b'], 'one round trip, not three');
});

await t('★ a spent candidate is skipped and the NEXT one is taken', async () => {
  const h = harness({ b: SPENT('b'), c: HEALTHY('c') });
  const r = await selectAccount({ accounts: [slot('a'), slot('b'), slot('c')], activeName: 'a', now: NOW, probe: h.probe });
  eq(r.name, 'c');
  deepEq(h.asked, ['b', 'c']);
  deepEq(r.walls, [{ name: 'b', until: secs(12 * HOUR), reason: 'the 5h window is spent', guessed: false }]);
});

await t('★ it keeps going through every account before giving up', async () => {
  const h = harness({ b: SPENT('b', 3 * HOUR), c: SPENT('c', 9 * HOUR), d: HEALTHY('d') });
  const r = await selectAccount({ accounts: [slot('a'), slot('b'), slot('c'), slot('d')], activeName: 'a', now: NOW, probe: h.probe });
  eq(r.name, 'd', 'two bad hops used to cost two failed runs; now they cost two GETs');
  deepEq(h.asked, ['b', 'c', 'd']);
});

await t('★ every account spent: it walls, and never asks one twice', async () => {
  const h = harness({ b: SPENT('b', 3 * HOUR), c: SPENT('c', 9 * HOUR) });
  const r = await selectAccount({ accounts: [slot('a', { limitedUntil: secs(2 * HOUR) }), slot('b'), slot('c')], activeName: 'a', now: NOW, probe: h.probe });
  eq(r.outcome, 'all_walled');
  eq(r.name, null);
  deepEq(h.asked, ['b', 'c'], 'the loop terminates on the account count');
  eq(r.earliest, secs(2 * HOUR), 'the earliest reset of anything in the ledger, including the one that just died');
});

await t('★ an account the ledger already walled is never probed', async () => {
  const h = harness({ c: HEALTHY('c') });
  const decisions = [];
  const r = await selectAccount({
    accounts: [slot('a'), slot('b', { limitedUntil: secs(9 * HOUR) }), slot('c')],
    activeName: 'a',
    now: NOW,
    probe: h.probe,
    onDecision: (d) => decisions.push(d),
  });
  eq(r.name, 'c');
  deepEq(h.asked, ['c'], 'a known wall costs nothing');
  const skip = decisions.find((d) => d.decision === 'account_skipped_known_walled');
  ok(skip, JSON.stringify(decisions));
  eq(skip.account, 'b');
  eq(skip.until, secs(9 * HOUR));
});

await t('a ledger wall whose reset has PASSED is treated as free again', async () => {
  const h = harness({ b: HEALTHY('b') });
  const r = await selectAccount({ accounts: [slot('a'), slot('b', { limitedUntil: secs(-2 * HOUR) })], activeName: 'a', now: NOW, probe: h.probe });
  eq(r.name, 'b');
  deepEq(h.asked, ['b'], 'and it is verified before it is used, because the ledger only says the wall lifted');
});

await t('★ the active account is never selected, however healthy it looks', async () => {
  const h = harness({ a: HEALTHY('a') });
  const r = await selectAccount({ accounts: [slot('a')], activeName: 'a', now: NOW, probe: h.probe });
  eq(r.outcome, 'all_walled');
  eq(r.name, null, 'it is the one that just died');
  deepEq(h.asked, []);
});

await t('★ a probe that throws takes the candidate anyway, and reports the failure', async () => {
  const h = harness({ b: 'throw' });
  const decisions = [];
  const r = await selectAccount({ accounts: [slot('a'), slot('b')], activeName: 'a', now: NOW, probe: h.probe, onDecision: (d) => decisions.push(d) });
  eq(r.name, 'b');
  deepEq(r.walls, [], 'an unreachable API is not evidence of a wall');
  ok(decisions.some((d) => d.decision === 'account_probe_failed'), JSON.stringify(decisions));
  const sel = decisions.find((d) => d.decision === 'account_selected');
  eq(sel.verified, false, 'and the selection says out loud that it is unverified');
});

await t('with no probe wired at all it is the old behaviour, said out loud', async () => {
  const decisions = [];
  const r = await selectAccount({ accounts: [slot('a'), slot('b')], activeName: 'a', now: NOW, onDecision: (d) => decisions.push(d) });
  eq(r.name, 'b');
  eq(decisions.find((d) => d.decision === 'account_selected').reason, 'no probe wired');
});

await t('a candidate spent with no reset clock gets the one hour fallback wall', async () => {
  const h = harness({
    b: usageRow({ fiveHour: { percent: null, resetsAt: null, severity: null, locked: 'usage_credits' }, sevenDay: null, scoped: [] }, 'b'),
    c: HEALTHY('c'),
  });
  const r = await selectAccount({ accounts: [slot('a'), slot('b'), slot('c')], activeName: 'a', now: NOW, probe: h.probe });
  eq(r.name, 'c');
  eq(r.walls[0].until, Math.floor(NOW / 1000) + FALLBACK_WALL_SECONDS);
  eq(r.walls[0].guessed, true, 'so the ledger can record that this one is a guess');
  eq(FALLBACK_WALL_SECONDS, 3600);
});

await t('no accounts enrolled at all is `none`, not a wall', async () => {
  const r = await selectAccount({ accounts: [], now: NOW, probe: async () => null });
  eq(r.outcome, 'none');
  eq(r.earliest, null);
});

await t('a slot with no credentials captured is not a candidate', async () => {
  const h = harness({ c: HEALTHY('c') });
  const r = await selectAccount({ accounts: [slot('a'), { name: 'b' }, slot('c')], activeName: 'a', now: NOW, probe: h.probe });
  eq(r.name, 'c');
  deepEq(h.asked, ['c']);
});

await t('rotation order is least-recently-active, so three accounts rotate', async () => {
  const h = harness({ b: HEALTHY('b'), c: HEALTHY('c') });
  const r = await selectAccount({
    accounts: [slot('a'), slot('b', { lastActiveAt: new Date(NOW - 60_000).toISOString() }), slot('c', { lastActiveAt: new Date(NOW - 10 * HOUR).toISOString() })],
    activeName: 'a',
    now: NOW,
    probe: h.probe,
  });
  eq(r.name, 'c', 'the one idle longest has the freshest window');
});

await t('the probe deadline is five seconds', () => {
  eq(PROBE_TIMEOUT_MS, 5_000);
});

// ---------------------------------------------------------------------------
console.log('\n3. termination, which used to rest on the overlay being read back');
// ---------------------------------------------------------------------------

await t('★ a spent window resetting INSIDE the current second terminates', async () => {
  // THE WEDGE: `limitedUntil` is whole seconds and isLimited() compares
  // `until * 1000 > now` against a millisecond clock, so flooring a reset
  // 400ms out recorded a wall that had already expired. nextAvailable then
  // handed the same candidate back, and with `now` frozen for the call the
  // loop never returned: the daemon needed a restart, on any rotation or any
  // sweep that probed in the last second before a reset.
  const oddNow = NOW + 123; // not on a second boundary
  const h = harness({
    b: usageRow({ fiveHour: win(100, new Date(oddNow + 400).toISOString()), sevenDay: win(10, iso(90 * HOUR)), scoped: [] }, 'b'),
    c: HEALTHY('c'),
  });
  const r = await selectAccount({ accounts: [slot('a'), slot('b'), slot('c')], activeName: 'a', now: oddNow, probe: h.probe });
  eq(r.name, 'c');
  deepEq(h.asked, ['b', 'c'], 'asked once each, then done');
  ok(r.walls[0].until * 1000 > oddNow, `the recorded wall must still be in the future: ${r.walls[0].until * 1000 - oddNow}ms`);
});

await t('★ a candidate is never asked twice, whatever the overlay says', async () => {
  // The guarantee that does not depend on the rounding above. A probe whose
  // verdict somehow fails to keep the candidate out of the next pass ends the
  // cycle rather than spinning on it.
  let calls = 0;
  const r = await selectAccount({
    accounts: [slot('a'), slot('b')],
    activeName: 'a',
    now: NOW,
    // A wall dated in the PAST, which is what the floor bug produced.
    probe: async () => {
      calls++;
      if (calls > 5) throw new Error('the loop did not terminate');
      return usageRow({ fiveHour: win(100, iso(-5 * HOUR)), sevenDay: null, scoped: [] }, 'b');
    },
  });
  eq(calls, 1, 'one question per account, ever');
  // A spent window whose reset has passed reads as a stale reading, so this
  // candidate is taken rather than walled. Either answer is fine here; not
  // returning at all is not.
  ok(r.outcome === 'selected' || r.outcome === 'all_walled', r.outcome);
});

// ---------------------------------------------------------------------------
if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log(`\n${pass} passed, 0 failed\n`);
console.log('✅ all account-selector tests pass');
