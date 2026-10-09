#!/usr/bin/env node
// Tests for account-autoswitch.mjs: when the login moves to another Claude
// account before a limit, which account it moves to, when a candidate is asked
// again, what a scheduled switch may target, and the notices.
//
// SHARED with the public clone (scripts/check-shared.sh). Pure: no network, no
// credential store, no daemon; the clock is an argument.
//
//   node account-autoswitch.test.mjs

import {
  AUTO_SWITCH_DEFAULTS,
  SETTLE_MS,
  PROBE_EVERY_MS,
  EVIDENCE_MAX_AGE_MS,
  autoSwitchSettings,
  autoSwitchStatusLine,
  usageWindows,
  overThreshold,
  weekPercent,
  fiveHourPercent,
  readingLine,
  candidateVerdict,
  pickTarget,
  probeDue,
  autoSwitchDecision,
  switchTargetVerdict,
  autoSwitchNotice,
  switchRefusedNotice,
  alreadyOnNotice,
} from './account-autoswitch.mjs';

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${msg} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};

// The morning of 2026-10-08: alpha@example.test live at 95 percent of its week,
// charlie and delta both resetting their week at 14:00Z.
const RESET = Date.parse('2026-10-08T14:00:00Z');
const BEFORE = RESET - 10 * 60_000;
const AFTER = RESET + 30_000;
const ALPHA = 'alpha@example.test';
const BRAVO = 'bravo@example.test';
const CHARLIE = 'charlie@example.test';
const DELTA = 'delta@example.test';
const TZ = 'America/New_York';
const usage = (five, fiveReset, week, weekReset, scoped = []) => ({
  fiveHour: five === null ? null : { percent: five, resetsAt: fiveReset ? new Date(fiveReset).toISOString() : null, severity: null, locked: null },
  sevenDay: { percent: week, resetsAt: new Date(weekReset).toISOString(), severity: null, locked: null },
  scoped,
  extraUsage: null,
});
const lookupRow = (name, u, readAt) => ({ name, state: 'ok', usage: u, readAt, live: false });
const ALPHA_95 = usage(12, BEFORE + 70 * 60_000, 95, Date.parse('2026-10-13T06:00:00Z'));
const S = AUTO_SWITCH_DEFAULTS;

// ---------------------------------------------------------------------------
// SETTINGS AND THE /status LINE
// ---------------------------------------------------------------------------
t('absent config means ON with 90 and 90', () => {
  eq(autoSwitchSettings(undefined), { enabled: true, weekThreshold: 90, fiveHourThreshold: 90 });
  eq(autoSwitchSettings(null), { enabled: true, weekThreshold: 90, fiveHourThreshold: 90 });
  eq(autoSwitchSettings({}), { enabled: true, weekThreshold: 90, fiveHourThreshold: 90 });
});
t('false and the off strings turn it off; nothing else does', () => {
  for (const v of [false, 'false', 'OFF', ' no ', '0']) eq(autoSwitchSettings(v).enabled, false, String(v));
  eq(autoSwitchSettings({ enabled: false }).enabled, false);
  eq(autoSwitchSettings('yes').enabled, true);
  eq(autoSwitchSettings({ enabled: 'false' }).enabled, true, 'a string in the object is not the switch');
});
t('thresholds are clamped to 50..100 and garbage falls back to the default', () => {
  eq(autoSwitchSettings({ weekThreshold: 9, fiveHourThreshold: 120 }), { enabled: true, weekThreshold: 50, fiveHourThreshold: 100 });
  eq(autoSwitchSettings({ weekThreshold: 'x', fiveHourThreshold: true }), { enabled: true, weekThreshold: 90, fiveHourThreshold: 90 });
  eq(autoSwitchSettings({ weekThreshold: '85' }).weekThreshold, 85);
});
t('the /status line names both thresholds, the last switch, or off', () => {
  eq(autoSwitchStatusLine(S), '🔀 Account auto switch: at 90% of 5h · 90% of the week');
  eq(autoSwitchStatusLine(autoSwitchSettings(false)), '🔀 Account auto switch: off');
  const line = autoSwitchStatusLine(S, { last: { to: CHARLIE, at: AFTER, via: 'auto' }, timeZone: TZ, now: AFTER });
  eq(line, '🔀 Account auto switch: at 90% of 5h · 90% of the week · last 10:00am to charlie@example.test');
  ok(autoSwitchStatusLine(S, { last: { to: CHARLIE, at: AFTER, via: 'schedule' }, timeZone: TZ, now: AFTER }).endsWith('(schedule)'));
});

// ---------------------------------------------------------------------------
// READING THE WINDOWS
// ---------------------------------------------------------------------------
t('the five hour window has its own threshold, the weekly and per model ones share the other', () => {
  const s = autoSwitchSettings({ fiveHourThreshold: 80, weekThreshold: 95 });
  const u = usage(85, AFTER + 3600_000, 93, AFTER + 86400_000, [{ label: 'Fable', percent: 96, resetsAt: new Date(AFTER + 86400_000).toISOString() }]);
  eq(overThreshold(u, s, AFTER).map((w) => [w.kind, w.percent, w.threshold]), [
    ['fiveHour', 85, 80],
    ['scoped:Fable', 96, 95],
  ]);
});
t('a window past its reset reads as empty; a locked one as 100', () => {
  const u = usage(100, BEFORE, 40, AFTER + 86400_000);
  eq(overThreshold(u, S, AFTER), [], 'a 5h window that reset at 13:50 is no longer full');
  eq(fiveHourPercent(u, AFTER), 0);
  const locked = { fiveHour: { percent: 3, resetsAt: null, locked: 'limit reached' }, sevenDay: { percent: 10, resetsAt: new Date(AFTER + 1e8).toISOString() } };
  eq(overThreshold(locked, S, AFTER).map((w) => w.percent), [100]);
});
t('weekPercent is the fullest weekly window; readingLine prints the two numbers', () => {
  const u = usage(34, AFTER + 3600_000, 18, AFTER + 86400_000, [{ label: 'Opus', percent: 41, resetsAt: new Date(AFTER + 86400_000).toISOString() }]);
  eq(weekPercent(u, AFTER), 41);
  eq(readingLine(u, AFTER), '5h 34% · week 41%');
  eq(readingLine(null, AFTER), 'no reading');
  eq(usageWindows({ fiveHour: { percent: null } }, S, AFTER), [], 'an unreadable window is left out');
});

// ---------------------------------------------------------------------------
// IS A CANDIDATE FREE?
// ---------------------------------------------------------------------------
t('free only on a fresh lookup with its own token, every window under its threshold', () => {
  const v = candidateVerdict(lookupRow(CHARLIE, usage(0, null, 0, RESET + 7 * 86400_000), AFTER), { name: CHARLIE, now: AFTER });
  eq([v.free, v.reason], [true, '5h 0% · week 0%']);
});
t('not free: another slot\'s row, a stream reading, a stale or undated lookup, an unreadable one', () => {
  const u = usage(0, null, 0, RESET + 7 * 86400_000);
  eq(candidateVerdict(lookupRow(DELTA, u, AFTER), { name: CHARLIE, now: AFTER }).free, false);
  eq(candidateVerdict({ ...lookupRow(CHARLIE, u, AFTER), source: { kind: 'stream' } }, { name: CHARLIE, now: AFTER }).free, false);
  eq(candidateVerdict(lookupRow(CHARLIE, u, AFTER - EVIDENCE_MAX_AGE_MS - 1000), { name: CHARLIE, now: AFTER }).reason, 'the lookup is 181s old');
  eq(candidateVerdict(lookupRow(CHARLIE, u, null), { name: CHARLIE, now: AFTER }).free, false);
  eq(candidateVerdict(lookupRow(CHARLIE, u, AFTER + 5 * 60_000), { name: CHARLIE, now: AFTER }).reason, 'the lookup is dated in the future');
  const bad = { name: CHARLIE, state: 'unavailable', usage: null, error: 'usage lookup failed (HTTP 429)' };
  eq(candidateVerdict(bad, { name: CHARLIE, now: AFTER }).reason, 'its usage could not be read (usage lookup failed (HTTP 429))');
  eq(candidateVerdict(null, { name: CHARLIE, now: AFTER }).free, false);
});
t('a dead login is not free and says so', () => {
  const v = candidateVerdict({ name: CHARLIE, state: 'unavailable', loginProblem: 'token refresh rejected (invalid_grant)' }, { name: CHARLIE, now: AFTER });
  eq([v.free, v.needsLogin], [false, 'token refresh rejected (invalid_grant)']);
});
t('over a threshold is not free, and says when it frees up', () => {
  const v = candidateVerdict(lookupRow(CHARLIE, usage(5, null, 100, RESET), BEFORE), { name: CHARLIE, now: BEFORE });
  eq([v.free, v.reason, v.blockedUntilMs], [false, 'the weekly window is at 100%', RESET]);
  const both = candidateVerdict(lookupRow(CHARLIE, usage(95, BEFORE + 3600_000, 92, RESET), BEFORE), { name: CHARLIE, now: BEFORE });
  eq(both.blockedUntilMs, BEFORE + 3600_000, 'the LATEST of the windows that keep it out (the 5h one, 14:50Z)');
});

// ---------------------------------------------------------------------------
// WHICH ONE, AND WHEN TO ASK AGAIN
// ---------------------------------------------------------------------------
t('the target is the free account with the most weekly headroom', () => {
  const c = (name, five, week, order) => ({ name, order, verdict: { free: true, usage: usage(five, AFTER + 3600_000, week, AFTER + 5 * 86400_000) } });
  eq(pickTarget([c(CHARLIE, 0, 20, 0), c(DELTA, 0, 5, 1), c(BRAVO, 50, 5, 2)], AFTER).name, DELTA, 'week first, then the 5h window');
  eq(pickTarget([c(CHARLIE, 0, 5, 1), c(DELTA, 0, 5, 0)], AFTER).name, DELTA, 'then list order');
  eq(pickTarget([], AFTER), null);
});
t('a candidate is asked when never asked, ONCE right after its known reset, then on the interval', () => {
  eq(probeDue({ lastProbeAt: null, now: BEFORE }), true);
  eq(probeDue({ lastProbeAt: BEFORE, blockedUntilMs: RESET, now: BEFORE + 60_000 }), false, 'before the reset');
  eq(probeDue({ lastProbeAt: BEFORE, blockedUntilMs: RESET, now: AFTER }), true, 'right after 14:00, not five minutes later');
  eq(probeDue({ lastProbeAt: AFTER, blockedUntilMs: RESET, now: AFTER + 60_000 }), false, 'once');
  eq(probeDue({ lastProbeAt: AFTER, now: AFTER + PROBE_EVERY_MS - 1 }), false);
  eq(probeDue({ lastProbeAt: AFTER, now: AFTER + PROBE_EVERY_MS }), true);
});

// ---------------------------------------------------------------------------
// THE DECISION
// ---------------------------------------------------------------------------
const freeCharlie = (at = AFTER) => ({ name: CHARLIE, order: 2, verdict: candidateVerdict(lookupRow(CHARLIE, usage(0, null, 0, RESET + 7 * 86400_000), at), { name: CHARLIE, now: at }) });
const freeDelta = (at = AFTER) => ({ name: DELTA, order: 3, verdict: candidateVerdict(lookupRow(DELTA, usage(0, null, 3, RESET + 7 * 86400_000), at), { name: DELTA, now: at }) });
const walledBravo = (at = AFTER) => ({ name: BRAVO, order: 0, verdict: candidateVerdict(lookupRow(BRAVO, usage(0, null, 100, Date.parse('2026-10-10T05:00:00Z')), at), { name: BRAVO, now: at }) });

t('10-07/08: alpha at 95 percent of its week, charlie free after its 14:00Z reset: switch to charlie (most headroom)', () => {
  const d = autoSwitchDecision({ active: { name: ALPHA, usage: ALPHA_95 }, candidates: [walledBravo(), freeCharlie(), freeDelta()], now: AFTER });
  eq([d.switch, d.from, d.to, d.why], [true, ALPHA, CHARLIE, 'threshold']);
  eq(d.over.map((w) => [w.kind, w.percent]), [['sevenDay', 95]]);
});
t('the same morning BEFORE 14:00Z: every other account full, so no switch, and the reason lists each', () => {
  const full = (name, order) => ({ name, order, verdict: candidateVerdict(lookupRow(name, usage(0, null, 100, RESET), BEFORE), { name, now: BEFORE }) });
  const d = autoSwitchDecision({ active: { name: ALPHA, usage: ALPHA_95 }, candidates: [walledBravo(BEFORE), full(CHARLIE, 2), full(DELTA, 3)], now: BEFORE });
  eq(d.switch, false);
  ok(d.reason.startsWith('no other account is free (bravo@example.test: the weekly window is at 100%'), d.reason);
});
t('a reset that freed the target is the reason the notice gives', () => {
  const z = { ...freeCharlie(), resetPassed: true };
  eq(autoSwitchDecision({ active: { name: ALPHA, usage: ALPHA_95 }, candidates: [z], now: AFTER }).why, 'reset');
});
t('below the thresholds nothing moves, however free the others are', () => {
  const d = autoSwitchDecision({ active: { name: ALPHA, usage: usage(40, AFTER + 3600_000, 89, AFTER + 86400_000) }, candidates: [freeCharlie()], now: AFTER });
  eq([d.switch, d.reason], [false, 'below the thresholds']);
});
t('the five hour threshold alone triggers it too', () => {
  const d = autoSwitchDecision({ active: { name: CHARLIE, usage: usage(91, AFTER + 3600_000, 30, AFTER + 86400_000) }, candidates: [freeDelta()], now: AFTER });
  eq([d.switch, d.to, d.over[0].kind], [true, DELTA, 'fiveHour']);
});
t('off, an unidentified live account, or no usable reading: no switch', () => {
  eq(autoSwitchDecision({ settings: autoSwitchSettings(false), active: { name: ALPHA, usage: ALPHA_95 }, candidates: [freeCharlie()], now: AFTER }).reason, 'off');
  eq(autoSwitchDecision({ active: { name: null, usage: ALPHA_95 }, candidates: [freeCharlie()], now: AFTER }).reason, 'the live account is not identified');
  eq(autoSwitchDecision({ active: { name: ALPHA, usage: null }, candidates: [freeCharlie()], now: AFTER }).reason, 'no usable reading for the live account');
});
t('never onto the live account itself, never onto a candidate whose verdict is missing', () => {
  const d = autoSwitchDecision({ active: { name: ALPHA, usage: ALPHA_95 }, candidates: [{ name: ALPHA, verdict: { free: true, usage: usage(0, null, 0, AFTER + 1e8) } }, { name: CHARLIE }], now: AFTER });
  eq(d.switch, false);
});

// ---------------------------------------------------------------------------
// NO FLAPPING (acceptance criterion 3)
// ---------------------------------------------------------------------------
t('NO FLAPPING: after alpha -> charlie, the next ticks stay on charlie and never swap back', () => {
  // Tick 1: the switch.
  const d1 = autoSwitchDecision({ active: { name: ALPHA, usage: ALPHA_95 }, candidates: [freeCharlie()], now: AFTER });
  eq([d1.switch, d1.to], [true, CHARLIE]);
  const swappedAt = AFTER;
  // alpha is still at 95 percent of its week: as a candidate it is never free.
  const alphaAgain = (at) => ({ name: ALPHA, order: 1, verdict: candidateVerdict(lookupRow(ALPHA, ALPHA_95, at), { name: ALPHA, now: at }) });
  // Tick 2, one minute on: charlie is fresh. Nothing moves (below the thresholds).
  const z = usage(2, AFTER + 5 * 3600_000, 1, RESET + 7 * 86400_000);
  const d2 = autoSwitchDecision({ active: { name: CHARLIE, usage: z }, candidates: [alphaAgain(AFTER + 60_000)], now: AFTER + 60_000, lastSwitchAt: swappedAt });
  eq([d2.switch, d2.reason], [false, 'below the thresholds']);
  // Tick 3, inside the settle window: a session STILL on alpha reports 95
  // percent and it lands under charlie (the 10-08 shape). Settling, no move.
  const d3 = autoSwitchDecision({ active: { name: CHARLIE, usage: ALPHA_95 }, candidates: [alphaAgain(AFTER + 2 * 60_000)], now: AFTER + 2 * 60_000, lastSwitchAt: swappedAt });
  eq(d3.switch, false);
  ok(d3.reason.endsWith('settling'), d3.reason);
  // Tick 4, past the settle window, the same bad reading: alpha is still not
  // free, so there is nowhere to go and the login stays on charlie.
  const at4 = AFTER + SETTLE_MS + 60_000;
  const d4 = autoSwitchDecision({ active: { name: CHARLIE, usage: ALPHA_95 }, candidates: [alphaAgain(at4)], now: at4, lastSwitchAt: swappedAt });
  eq([d4.switch, d4.to], [false, null]);
  // Tick 5: charlie itself really crosses 90 later in the week and alpha has
  // reset: only THEN does it move, and onward, not back to a full account.
  const at5 = Date.parse('2026-10-13T07:00:00Z');
  const alphaReset = { name: ALPHA, order: 1, verdict: candidateVerdict(lookupRow(ALPHA, usage(0, null, 0, Date.parse('2026-10-20T06:00:00Z')), at5), { name: ALPHA, now: at5 }) };
  const d5 = autoSwitchDecision({ active: { name: CHARLIE, usage: usage(10, at5 + 3600_000, 91, RESET + 7 * 86400_000) }, candidates: [alphaReset], now: at5, lastSwitchAt: swappedAt });
  eq([d5.switch, d5.to], [true, ALPHA]);
});
t('every kind of swap starts the settle window (the owner\'s, the rotation\'s, this one\'s)', () => {
  const d = autoSwitchDecision({ active: { name: ALPHA, usage: ALPHA_95 }, candidates: [freeCharlie()], now: AFTER, lastSwitchAt: AFTER - SETTLE_MS + 1000 });
  eq(d.switch, false);
  eq(autoSwitchDecision({ active: { name: ALPHA, usage: ALPHA_95 }, candidates: [freeCharlie()], now: AFTER, lastSwitchAt: AFTER - SETTLE_MS }).switch, true);
});

// ---------------------------------------------------------------------------
// A SCHEDULED OR ASKED-FOR SWITCH: what it may target
// ---------------------------------------------------------------------------
const rows = [
  { name: BRAVO, email: BRAVO, captured: true, limited: true, limitedUntil: Math.floor(Date.parse('2026-10-10T05:00:00Z') / 1000), needsLogin: null },
  { name: ALPHA, email: ALPHA, captured: true, limited: false, needsLogin: null },
  { name: CHARLIE, email: CHARLIE, captured: true, limited: false, needsLogin: null },
  { name: DELTA, email: DELTA, captured: true, limited: false, needsLogin: { reason: 'invalid_grant' } },
  { name: 'spare', email: 'spare@example.test', captured: false, limited: false, needsLogin: null },
];
t('refused: an unknown name lists the stored ones', () => {
  const v = switchTargetVerdict({ target: 'nobody@example.test', rows, activeName: ALPHA, now: AFTER });
  eq([v.ok, v.refusal], [false, 'unknown']);
  ok(v.reason.includes('stored: bravo@example.test, alpha@example.test'), v.reason);
  eq(switchTargetVerdict({ target: '', rows, now: AFTER }).refusal, 'unknown');
});
t('refused: walled in the ledger, flagged for a login, never captured', () => {
  const w = switchTargetVerdict({ target: BRAVO, rows, activeName: ALPHA, now: AFTER, timeZone: TZ });
  eq([w.ok, w.refusal, w.reason], [false, 'walled', 'bravo@example.test is at its limit until Sat 10 Oct 1:00am']);
  eq(switchTargetVerdict({ target: DELTA, rows, activeName: ALPHA, now: AFTER }).refusal, 'needs-login');
  eq(switchTargetVerdict({ target: 'spare', rows, activeName: ALPHA, now: AFTER }).refusal, 'no-login');
});
t('refused: a fresh lookup showing a spent window, or a dead login', () => {
  const spent = lookupRow(CHARLIE, usage(100, AFTER + 3600_000, 30, AFTER + 86400_000), AFTER);
  const v = switchTargetVerdict({ target: CHARLIE, rows, activeName: ALPHA, row: spent, now: AFTER, timeZone: TZ });
  eq([v.ok, v.refusal], [false, 'walled']);
  ok(v.reason.startsWith('charlie@example.test has spent the 5 hour window until'), v.reason);
  const dead = { name: CHARLIE, state: 'unavailable', loginProblem: 'login refused (HTTP 401)' };
  eq(switchTargetVerdict({ target: CHARLIE, rows, activeName: ALPHA, row: dead, now: AFTER }).refusal, 'needs-login');
});
t('allowed: matched by email in any case, with the reading or a note when it could not be read', () => {
  const v = switchTargetVerdict({ target: 'CHARLIE@Example.test', rows, activeName: ALPHA, row: lookupRow(CHARLIE, usage(0, null, 0, AFTER + 1e8), AFTER), now: AFTER });
  eq([v.ok, v.name, v.note], [true, CHARLIE, '5h 0% · week 0%']);
  eq(switchTargetVerdict({ target: CHARLIE, rows, activeName: ALPHA, row: null, now: AFTER }).note, 'its usage could not be read just now');
  const high = switchTargetVerdict({ target: CHARLIE, rows, activeName: ALPHA, row: lookupRow(CHARLIE, usage(0, null, 93, AFTER + 1e8), AFTER), now: AFTER });
  eq([high.ok, high.note], [true, '5h 0% · week 93%, already past the automatic switch threshold']);
});
t('the live account itself is a no-op, not a refusal', () => {
  eq(switchTargetVerdict({ target: ALPHA, rows, activeName: ALPHA, now: AFTER }), { ok: true, name: ALPHA, noop: true, note: 'already the live account' });
});

// ---------------------------------------------------------------------------
// THE NOTICES: the house style (icon, label, value; one fact per line; the
// middle dot the only separator; no em or en dash)
// ---------------------------------------------------------------------------
const houseStyle = (text, label) => {
  ok(!/[–—]/.test(text), `${label}: an em or en dash`);
  for (const line of text.split('\n')) {
    ok(/^\p{Extended_Pictographic}/u.test(line), `${label}: line does not open with an icon: ${line}`);
    ok(!/ - |; | \| /.test(line), `${label}: a separator other than the middle dot: ${line}`);
  }
};
t('the automatic switch notice: from, to, both readings, why', () => {
  const text = autoSwitchNotice({
    from: ALPHA,
    to: CHARLIE,
    via: 'auto',
    why: 'threshold',
    over: [{ percent: 95, label: 'the weekly window', threshold: 90 }],
    fromUsage: ALPHA_95,
    toUsage: usage(0, null, 0, RESET + 7 * 86400_000),
    now: AFTER,
  });
  eq(text.split('\n'), [
    '🔀 Claude account switched · automatic',
    '⬅️ From: alpha@example.test · 5h 12% · week 95%',
    '➡️ To: charlie@example.test · 5h 0% · week 0%',
    '❓ Why: 95% of the weekly window (threshold 90%)',
    '🔁 Running jobs follow the new login',
  ]);
  houseStyle(text, 'auto');
});
t('the reset, scheduled and command notices', () => {
  const r = autoSwitchNotice({ from: ALPHA, to: CHARLIE, why: 'reset', over: [{ percent: 95, label: 'the weekly window', threshold: 90 }], now: AFTER });
  ok(r.includes('❓ Why: a reset freed charlie@example.test · 95% of the weekly window (threshold 90%)'), r);
  const s = autoSwitchNotice({ from: DELTA, to: CHARLIE, via: 'schedule', why: 'schedule', scheduleId: 214, note: '5h 0% · week 0%', now: AFTER });
  ok(s.startsWith('🔀 Claude account switched · scheduled #214\n'), s);
  ok(s.includes('❓ Why: you scheduled it') && s.includes('📝 Note: 5h 0% · week 0%'), s);
  const c = autoSwitchNotice({ from: null, to: CHARLIE, via: 'command', why: 'command', now: AFTER });
  ok(c.includes('⬅️ From: an unidentified login') && c.includes('· by command'), c);
  for (const [x, l] of [[r, 'reset'], [s, 'schedule'], [c, 'command']]) houseStyle(x, l);
});
t('the already-on notice', () => {
  const text = alreadyOnNotice({ name: CHARLIE, via: 'schedule', scheduleId: 7 });
  eq(text.split('\n'), ['🔀 Claude account switch · scheduled #7', '✅ Already on: charlie@example.test', '💤 Nothing changed']);
  houseStyle(text, 'already on');
});
t('the refusal notice', () => {
  const text = switchRefusedNotice({ target: BRAVO, via: 'schedule', scheduleId: 214, reason: 'bravo@example.test is at its limit until Sat 10 Oct 1:00am', stillOn: DELTA });
  eq(text.split('\n'), [
    '🚫 Claude account switch refused · scheduled #214',
    '👤 Target: bravo@example.test',
    '❓ Why: bravo@example.test is at its limit until Sat 10 Oct 1:00am',
    '↩️ Still on: delta@example.test',
  ]);
  houseStyle(text, 'refused');
});

// ---------- report ----------
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all account-autoswitch tests pass');
