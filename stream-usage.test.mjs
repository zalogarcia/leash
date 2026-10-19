#!/usr/bin/env node
// Tests for stream-usage.mjs: the newest plan usage reading per Claude account,
// taken off the rate_limit_event every spawned Claude Code stream carries, and
// the rule that decides WHOSE reading it is.
//
// Nothing here touches the real keychain, the network or the live
// usage-stream.json: the file is a mkdtemp path and the clock is injected.
//
//   node stream-usage.test.mjs

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createStreamUsage,
  createLiveAccountTracker,
  attributeReading,
  weeklyResetMs,
  ANCHOR_TOLERANCE_MS,
  SWAP_GRACE_MS,
  READING_KEEP_MS,
} from './stream-usage.mjs';
import { normalizeRateLimitEvent } from './account-usage.mjs';

let pass = 0;
const failures = [];
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};

const TMP = mkdtempSync(path.join(tmpdir(), 'stream-usage-test-'));
let n = 0;
const fileFor = () => path.join(TMP, `usage-stream-${n++}.json`);

const NOW = Date.parse('2026-09-27T13:45:00Z'); // 9:45am ET, the morning of the report
const HOUR = 3600_000;
// Three accounts, three weekly resets on the hour: the live data has exactly
// this shape (every seven_day resetsAt in 494 run logs is on the hour, and each
// account's differs).
const W = {
  me: Math.floor((NOW + 30 * HOUR) / 1000) - (Math.floor((NOW + 30 * HOUR) / 1000) % 3600),
  gmail: Math.floor((NOW + 55 * HOUR) / 1000) - (Math.floor((NOW + 55 * HOUR) / 1000) % 3600),
  work: Math.floor((NOW + 100 * HOUR) / 1000) - (Math.floor((NOW + 100 * HOUR) / 1000) % 3600),
};
const S5 = Math.floor((NOW + 2 * HOUR) / 1000);
const ev = (weeklySecs, five = 0.66, week = 0.63) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: S5,
    rateLimitType: 'five_hour',
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: five, resetsAt: S5 }, seven_day: { utilization: week, resetsAt: weeklySecs } },
  },
});
// An API usage row's weekly reset, the way the endpoint sends it (ISO, with a
// fraction of a second the event's whole seconds do not have).
const apiUsage = (weeklySecs) => ({
  fiveHour: { percent: 10, resetsAt: new Date(S5 * 1000).toISOString(), severity: null, locked: null },
  sevenDay: { percent: 20, resetsAt: new Date(weeklySecs * 1000 + 241).toISOString().replace('Z', '459+00:00'), severity: null, locked: null },
  scoped: [],
  extraUsage: null,
});

function rig({ file = fileFor(), clock = { t: NOW } } = {}) {
  const logs = [];
  const s = createStreamUsage({ file, now: () => clock.t, log: (m) => logs.push(m), persistDelayMs: 60_000 });
  return { s, file, clock, logs };
}

// ---------------------------------------------------------------------------
// THE ATTRIBUTION RULE, pure
// ---------------------------------------------------------------------------

await t('weeklyResetMs reads the weekly reset off a normalized reading, ISO or event', () => {
  eq(weeklyResetMs(normalizeRateLimitEvent(ev(W.me))), W.me * 1000);
  eq(weeklyResetMs(apiUsage(W.me)), Date.parse(apiUsage(W.me).sevenDay.resetsAt));
  eq(weeklyResetMs({ fiveHour: null, sevenDay: null }), null);
  eq(weeklyResetMs(null), null);
});

await t('no anchors at all: the reading is the live account\'s', () => {
  eq(attributeReading({ weeklyMs: W.me * 1000, liveName: 'me', spawnName: 'me', anchors: {}, now: NOW }).name, 'me');
});

await t('★ no anchor to prove it: the live account only when the process was SPAWNED on it, else nobody', () => {
  // The QA round 2 case: first boot after deploy, no anchors yet, a survivor
  // spawned on the walled account A still running while B is live.
  eq(attributeReading({ weeklyMs: W.gmail * 1000, liveName: 'me', spawnName: 'gmail', anchors: {}, now: NOW }).name, null, 'a process spawned on another account is doubtful');
  eq(attributeReading({ weeklyMs: W.gmail * 1000, liveName: 'me', spawnName: null, anchors: {}, now: NOW }).name, null, 'an unknown spawn account (a re-attached survivor) is doubtful');
  eq(attributeReading({ weeklyMs: W.gmail * 1000, liveName: 'me', anchors: {}, now: NOW }).name, null, 'no spawn account given is doubtful too');
  eq(attributeReading({ weeklyMs: null, liveName: 'me', spawnName: 'gmail', anchors: {}, now: NOW }).name, null, 'a reading with no weekly window is no different');
  // Anchors still beat the spawn account: evidence over history.
  eq(attributeReading({ weeklyMs: W.gmail * 1000, liveName: 'me', spawnName: 'me', anchors: { gmail: { weeklyMs: W.gmail * 1000 } }, now: NOW }).name, 'gmail');
});

await t('no live account known and no anchor: the reading is nobody\'s', () => {
  eq(attributeReading({ weeklyMs: W.me * 1000, liveName: null, anchors: {}, now: NOW }).name, null);
});

await t('★ a reading whose weekly reset is ANOTHER account\'s goes to that account, not the live one', () => {
  // A process still on the old account right after a swap: event time says
  // "me", the reading's own weekly reset says "gmail".
  const anchors = { gmail: { weeklyMs: W.gmail * 1000 }, me: { weeklyMs: W.me * 1000 } };
  const r = attributeReading({ weeklyMs: W.gmail * 1000, liveName: 'me', anchors, now: NOW });
  eq(r.name, 'gmail');
});

await t('a reading that matches no anchor while the live account has a different one is dropped', () => {
  const anchors = { me: { weeklyMs: W.me * 1000 } };
  eq(attributeReading({ weeklyMs: W.work * 1000, liveName: 'me', anchors, now: NOW }).name, null);
});

await t('a reading that matches no anchor goes to a live account that has none', () => {
  const anchors = { gmail: { weeklyMs: W.gmail * 1000 } };
  eq(attributeReading({ weeklyMs: W.work * 1000, liveName: 'me', spawnName: 'me', anchors, now: NOW }).name, 'me');
});

await t('the API\'s sub-second fraction still matches, inside the tolerance and not beyond it', () => {
  const anchors = { gmail: { weeklyMs: Date.parse(apiUsage(W.gmail).sevenDay.resetsAt) } };
  eq(attributeReading({ weeklyMs: W.gmail * 1000, liveName: 'me', anchors, now: NOW }).name, 'gmail');
  const off = { gmail: { weeklyMs: W.gmail * 1000 + ANCHOR_TOLERANCE_MS + 1000 } };
  eq(attributeReading({ weeklyMs: W.gmail * 1000, liveName: 'me', spawnName: 'me', anchors: off, now: NOW }).name, 'me');
  ok(ANCHOR_TOLERANCE_MS < HOUR, 'the tolerance must stay under the hour that separates two accounts');
});

await t('two accounts on the same weekly reset: the live one if it is one of them, else nobody', () => {
  const anchors = { me: { weeklyMs: W.me * 1000 }, gmail: { weeklyMs: W.me * 1000 } };
  eq(attributeReading({ weeklyMs: W.me * 1000, liveName: 'gmail', anchors, now: NOW }).name, 'gmail');
  eq(attributeReading({ weeklyMs: W.me * 1000, liveName: 'work', anchors, now: NOW }).name, null);
});

await t('an anchor whose week has passed identifies nothing', () => {
  const anchors = { gmail: { weeklyMs: NOW - HOUR } };
  eq(attributeReading({ weeklyMs: NOW - HOUR, liveName: 'me', spawnName: 'me', anchors, now: NOW }).name, 'me');
});

await t('a reading with no weekly window falls back to the live account', () => {
  eq(attributeReading({ weeklyMs: null, liveName: 'me', spawnName: 'me', anchors: { me: { weeklyMs: W.me * 1000 } }, now: NOW }).name, 'me');
});

// ---------------------------------------------------------------------------
// THE STORE
// ---------------------------------------------------------------------------

await t('note() records the reading under the live account, stamped with the receive time', () => {
  const { s } = rig();
  const r = s.note(ev(W.me), { liveName: 'me', spawnName: 'me' });
  eq(r.name, 'me');
  const got = s.get('me');
  eq(got.at, NOW);
  eq(got.usage.fiveHour.percent, 66);
  eq(s.get('gmail'), null);
});

await t('note() ignores anything that is not a usable rate_limit_event', () => {
  const { s } = rig();
  eq(s.note({ type: 'assistant' }, { liveName: 'me', spawnName: 'me' }).name, null);
  eq(s.note({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, { liveName: 'me', spawnName: 'me' }).name, null);
  eq(s.note(null, { liveName: 'me', spawnName: 'me' }).name, null);
  eq(s.get('me'), null);
});

await t('the newest reading wins', () => {
  const { s, clock } = rig();
  s.note(ev(W.me, 0.5), { liveName: 'me', spawnName: 'me' });
  clock.t = NOW + 30_000;
  s.note(ev(W.me, 0.7), { liveName: 'me', spawnName: 'me' });
  eq(s.get('me').usage.fiveHour.percent, 70);
  eq(s.get('me').at, NOW + 30_000);
});

await t('★ learn() anchors an account from the API, and a later stale-process reading goes to its owner', () => {
  const { s } = rig();
  s.learn('gmail', apiUsage(W.gmail));
  s.learn('me', apiUsage(W.me));
  // Live is "me" now, but this process has not picked the swap up yet.
  const r = s.note(ev(W.gmail, 0.99, 0.9), { liveName: 'me', spawnName: 'me' });
  eq(r.name, 'gmail');
  eq(s.get('me'), null, 'the live account must not show the other account\'s numbers');
  eq(s.get('gmail').usage.fiveHour.percent, 99);
});

await t('learn() drops a stored reading its own anchor proves was never that account\'s', () => {
  const { s } = rig();
  // Recorded under "me" before any anchor existed, but the numbers were gmail's.
  s.note(ev(W.gmail), { liveName: 'me', spawnName: 'me' });
  ok(s.get('me'), 'precondition: recorded by event time');
  s.learn('me', apiUsage(W.me));
  eq(s.get('me'), null);
  // A reading that agrees with the anchor survives it.
  s.note(ev(W.me), { liveName: 'me', spawnName: 'me' });
  s.learn('me', apiUsage(W.me));
  ok(s.get('me'), 'a matching reading was dropped');
});

await t('★ learn() re-homes a reading misfiled under another account, unless that account vouches for it', () => {
  const { s, clock } = rig();
  // Misfiled: gmail's numbers recorded under "me" (spawned and live on me by
  // the tracker's account, but the process was really on gmail).
  s.note(ev(W.gmail, 0.99), { liveName: 'me', spawnName: 'me' });
  clock.t = NOW + 1000;
  s.learn('gmail', apiUsage(W.gmail));
  eq(s.get('me'), null, 'the reading gmail\'s anchor proves is gmail\'s stayed under me');
  eq(s.get('gmail').usage.fiveHour.percent, 99, 'and it belongs under gmail');
  eq(s.get('gmail').at, NOW, 'moved with its own receive time, not restamped');
  // A newer reading already under gmail is not overwritten by an older misfile.
  const b = rig();
  b.s.note(ev(W.gmail, 0.1), { liveName: 'me', spawnName: 'me' });
  b.clock.t = NOW + 5000;
  b.s.note(ev(W.gmail, 0.2), { liveName: 'gmail', spawnName: 'gmail' });
  b.s.learn('gmail', apiUsage(W.gmail));
  eq(b.s.get('gmail').usage.fiveHour.percent, 20);
  eq(b.s.get('me'), null);
  // Two accounts on the same weekly reset: the other one's own anchor vouches for its reading.
  const c = rig();
  c.s.learn('me', apiUsage(W.gmail));
  c.s.note(ev(W.gmail, 0.3), { liveName: 'me', spawnName: 'me' });
  c.s.learn('gmail', apiUsage(W.gmail));
  eq(c.s.get('me').usage.fiveHour.percent, 30, 'a reading its own anchor vouches for was taken');
});

await t('get() says whether an anchor has verified the reading\'s identity', () => {
  const { s } = rig();
  s.note(ev(W.me), { liveName: 'me', spawnName: 'me' });
  eq(s.get('me').verified, false, 'by event time alone');
  s.learn('me', apiUsage(W.me));
  eq(s.get('me').verified, true, 'the anchor matches');
  s.note(ev(W.me, 0.8), { liveName: 'me', spawnName: 'gmail' });
  eq(s.get('me').verified, true, 'recorded by its anchor, so verified');
});

await t('★ it survives a restart: flush, then a new store on the same file reads it back', () => {
  const file = fileFor();
  const a = rig({ file });
  a.s.note(ev(W.me), { liveName: 'me', spawnName: 'me' });
  a.s.learn('gmail', apiUsage(W.gmail));
  a.s.flush();
  ok(existsSync(file), 'nothing was written');
  eq(statSync(file).mode & 0o777, 0o600, 'the file is owner only');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  eq(onDisk.version, 1);
  eq(Object.keys(onDisk.readings), ['me']);
  const b = rig({ file });
  eq(b.s.get('me').usage.fiveHour.percent, 66);
  eq(b.s.get('me').at, NOW);
  // The anchor came back too: a stale-process reading is still routed after the restart.
  eq(b.s.note(ev(W.gmail), { liveName: 'me', spawnName: 'me' }).name, 'gmail');
});

await t('writes are coalesced: many readings, one write, and flush() writes nothing when clean', () => {
  const { s, file } = rig();
  for (let i = 0; i < 50; i++) s.note(ev(W.me, i / 100), { liveName: 'me', spawnName: 'me' });
  ok(!existsSync(file), 'a write per event would be a disk write per API call on every session');
  s.flush();
  const first = readFileSync(file, 'utf8');
  eq(JSON.parse(first).readings.me.usage.fiveHour.percent, 49);
  writeFileSync(file, 'sentinel');
  s.flush();
  eq(readFileSync(file, 'utf8'), 'sentinel', 'a clean store rewrote its file');
});

await t('a corrupt or foreign file starts empty and never throws', () => {
  for (const body of ['{not json', '[]', '{"version":99,"readings":{"me":1}}', 'null']) {
    const file = fileFor();
    writeFileSync(file, body);
    const { s, logs } = rig({ file });
    eq(s.get('me'), null, body);
    s.note(ev(W.me), { liveName: 'me', spawnName: 'me' });
    s.flush();
    eq(JSON.parse(readFileSync(file, 'utf8')).version, 1, body);
    ok(body === '{"version":99,"readings":{"me":1}}' || body === 'null' || body === '[]' || logs.length, `${body}: a corrupt file is worth a log line`);
  }
});

await t('old readings and expired anchors are pruned on load', () => {
  const file = fileFor();
  const a = rig({ file });
  a.s.note(ev(W.me), { liveName: 'me', spawnName: 'me' });
  a.s.learn('gmail', { ...apiUsage(W.gmail), sevenDay: { percent: 1, resetsAt: new Date(NOW + HOUR).toISOString() } });
  a.s.flush();
  const b = rig({ file, clock: { t: NOW + READING_KEEP_MS + 2 * HOUR } });
  eq(b.s.get('me'), null, 'a reading kept past READING_KEEP_MS');
  b.s.flush();
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  eq(Object.keys(onDisk.anchors || {}), [], 'an anchor whose week has passed was kept');
});

await t('a reading is attributed only to a real name: a missing live account records nothing', () => {
  const { s } = rig();
  eq(s.note(ev(W.me), { liveName: null }).name, null);
  eq(s.get('null'), null);
  eq(s.get(undefined), null);
});

// ---------------------------------------------------------------------------
// TWO ACCOUNTS ON ONE WEEKLY RESET: the 2026-10-08 20:52Z false wall, with the
// exact numbers from usage-stream.json and the daemon log. c@ walled its 5
// hour window (100 percent, reset 2026-10-09T00:00Z) and the daemon swapped to
// b@ (4 percent, reset 01:50Z). Both accounts' weeks reset at
// 2026-10-15T14:00Z, so the weekly mark could not tell them apart, and a
// session still on c@'s credentials was filed under b@.
// ---------------------------------------------------------------------------
const OCT8 = Date.parse('2026-10-08T20:52:30Z');
const SWAP_AT = Date.parse('2026-10-08T20:52:15Z');
const ACC_C = 'c@example.com';
const ACC_B = 'b@example.com';
const ACC_C_WEEK = Date.parse('2026-10-15T14:00:00.411Z');
const ACC_B_WEEK = Date.parse('2026-10-15T14:00:00.040Z');
const ACC_C_5H = Date.parse('2026-10-09T00:00:00Z');
const ACC_B_5H = Date.parse('2026-10-09T01:50:00Z');
const oct8Event = ({ five, fiveReset, week = 0.28, weekReset = Date.parse('2026-10-15T14:00:00Z'), rejected = false }) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: rejected ? 'rejected' : 'allowed',
    resetsAt: Math.floor(fiveReset / 1000),
    rateLimitType: 'five_hour',
    unifiedWindows: {
      five_hour: { utilization: five, resetsAt: Math.floor(fiveReset / 1000) },
      seven_day: { utilization: week, resetsAt: Math.floor(weekReset / 1000) },
    },
  },
});
// c@'s wall, as a session still on its credentials reported it.
const ACC_C_WALL = oct8Event({ five: 1.0, fiveReset: ACC_C_5H, week: 0.28, rejected: true });
// b@'s own fresh window, as a session on b@ reported it.
const ACC_B_OWN = oct8Event({ five: 0.04, fiveReset: ACC_B_5H, week: 0.18 });
const lookup = (fivePct, fiveResetMs, weekPct, weekResetMs) => ({
  fiveHour: { percent: fivePct, resetsAt: fiveResetMs ? new Date(fiveResetMs).toISOString() : null, severity: null, locked: null },
  sevenDay: { percent: weekPct, resetsAt: new Date(weekResetMs).toISOString(), severity: null, locked: null },
  scoped: [],
  extraUsage: null,
});

await t('10-08: the shared weekly reset alone gave c@\'s wall to b@ (the old rule, kept as the control)', () => {
  // No five hour mark known, no swap noted: exactly the information the old
  // rule had, and it reproduces the bad attribution.
  const anchors = { [ACC_C]: { weeklyMs: ACC_C_WEEK }, [ACC_B]: { weeklyMs: ACC_B_WEEK } };
  const who = attributeReading({ weeklyMs: Date.parse('2026-10-15T14:00:00Z'), liveName: ACC_B, spawnName: ACC_C, anchors, now: OCT8 });
  eq(who.name, ACC_B, 'without the new marks the reading still goes to the live account');
});

await t('10-08: c@\'s 100 percent reading after the swap is filed under c@, never b@ (five hour mark)', () => {
  const { s, clock } = rig({ clock: { t: OCT8 } });
  clock.t = SWAP_AT - 60_000;
  s.learn(ACC_C, lookup(99, ACC_C_5H, 28, ACC_C_WEEK));
  s.learn(ACC_B, lookup(2, ACC_B_5H, 15, ACC_B_WEEK));
  clock.t = OCT8;
  s.noteSwap({ from: ACC_C, to: ACC_B, at: SWAP_AT });
  const who = s.note(ACC_C_WALL, { liveName: ACC_B, spawnName: ACC_C });
  eq(who, { name: ACC_C, why: 'weekly reset shared, five hour reset matches' });
  eq(s.get(ACC_B), null, 'nothing may be held for b@ from c@\'s session');
  eq(s.get(ACC_C).usage.fiveHour.percent, 100);
  // And a session spawned on b@ (the event time rule's best case) changes nothing.
  eq(s.note(ACC_C_WALL, { liveName: ACC_B, spawnName: ACC_B }).name, ACC_C);
  eq(s.get(ACC_B), null);
});

await t('10-08: b@\'s own reading right after the swap is b@\'s (4 percent, reset 01:50Z)', () => {
  const { s, clock } = rig({ clock: { t: OCT8 } });
  clock.t = SWAP_AT - 60_000;
  s.learn(ACC_C, lookup(99, ACC_C_5H, 28, ACC_C_WEEK));
  s.learn(ACC_B, lookup(2, ACC_B_5H, 15, ACC_B_WEEK));
  clock.t = OCT8;
  s.noteSwap({ from: ACC_C, to: ACC_B, at: SWAP_AT });
  eq(s.note(ACC_B_OWN, { liveName: ACC_B, spawnName: ACC_B }), { name: ACC_B, why: 'weekly reset shared, five hour reset matches' });
  const r = s.get(ACC_B);
  eq([r.usage.fiveHour.percent, r.verified, r.consistent], [4, true, true]);
});

await t('10-08: with only c@\'s five hour mark known, c@ is ruled out of b@\'s reading and in for its own', () => {
  const { s, clock } = rig({ clock: { t: OCT8 } });
  clock.t = SWAP_AT - 60_000;
  s.learn(ACC_C, lookup(99, ACC_C_5H, 28, ACC_C_WEEK));
  s.learn(ACC_B, lookup(0, null, 15, ACC_B_WEEK)); // no window open at its probe
  clock.t = OCT8;
  eq(s.note(ACC_B_OWN, { liveName: ACC_B, spawnName: ACC_B }).name, ACC_B);
  eq(s.note(ACC_C_WALL, { liveName: ACC_B, spawnName: ACC_B }).name, ACC_C);
  eq(s.get(ACC_B).usage.fiveHour.percent, 4, 'b@ keeps its own 4 percent');
});

await t('10-08: with no five hour mark at all, a shared reading inside the swap grace is dropped, not given to b@', () => {
  const { s, clock } = rig({ clock: { t: OCT8 } });
  clock.t = SWAP_AT - 60_000;
  s.learn(ACC_C, lookup(0, null, 28, ACC_C_WEEK));
  s.learn(ACC_B, lookup(0, null, 15, ACC_B_WEEK));
  clock.t = OCT8;
  s.noteSwap({ from: ACC_C, to: ACC_B, at: SWAP_AT });
  eq(s.note(ACC_C_WALL, { liveName: ACC_B, spawnName: ACC_B }), { name: null, why: 'weekly reset shared with the account swapped away from moments ago' });
  eq(s.get(ACC_B), null);
  // Past the grace the shared rule stands again (the outgoing sessions have moved).
  clock.t = SWAP_AT + SWAP_GRACE_MS + 1000;
  eq(s.note(ACC_B_OWN, { liveName: ACC_B, spawnName: ACC_B }).name, ACC_B);
});

await t('10-08: the bad reading already on disk under b@ is flagged inconsistent at load and dropped by b@\'s lookup', () => {
  const file = fileFor();
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      readings: { [ACC_B]: { usage: normalizeRateLimitEvent(ACC_C_WALL), at: OCT8 - 5000 } },
      anchors: {
        [ACC_C]: { weeklyMs: ACC_C_WEEK, fiveHourMs: ACC_C_5H, at: OCT8 - 30_000 },
        [ACC_B]: { weeklyMs: ACC_B_WEEK, fiveHourMs: ACC_B_5H, at: OCT8 - 30_000 },
      },
    }),
  );
  const { s, logs } = rig({ file, clock: { t: OCT8 } });
  const r = s.get(ACC_B);
  eq([r.usage.fiveHour.percent, r.verified, r.consistent], [100, true, false], 'verified by the shared week, inconsistent by the five hour window');
  s.learn(ACC_B, lookup(4, ACC_B_5H, 18, ACC_B_WEEK));
  eq(s.get(ACC_B), null);
  ok(logs.some((l) => l.includes('its five hour window is another account\'s')), 'the drop is logged');
});

await t('★ 10-08: past the grace and across a restart, c@\'s open window is still never given to b@ (rule 5, the swap\'s mark)', () => {
  // QA round 1: with no lookup mark on either account, rule 5's ten minute
  // grace was the only fence, in memory only. The window c@ had open when
  // the login left it (00:00Z, read off the reading held for it while it was
  // live) now goes with the swap record and is persisted.
  const { s, file, clock } = rig({ clock: { t: SWAP_AT - 30_000 } });
  s.learn(ACC_C, lookup(0, null, 28, ACC_C_WEEK));
  s.learn(ACC_B, lookup(0, null, 15, ACC_B_WEEK));
  eq(s.note(ACC_C_WALL, { liveName: ACC_C, spawnName: ACC_C }).name, ACC_C, 'while c@ is live its wall is its own');
  clock.t = SWAP_AT;
  s.noteSwap({ from: ACC_C, to: ACC_B, at: SWAP_AT });
  eq(s.lastSwap().fromFiveHourMs, ACC_C_5H, 'the outgoing window rides with the swap');
  const late = SWAP_AT + SWAP_GRACE_MS + 60_000;
  clock.t = late;
  eq(s.note(ACC_C_WALL, { liveName: ACC_B, spawnName: ACC_B }), { name: null, why: 'weekly reset shared, five hour window is the one the account swapped away from has open' });
  eq(s.get(ACC_B), null, 'nothing held for b@ from c@\'s session, eleven minutes on');
  eq(s.note(ACC_B_OWN, { liveName: ACC_B, spawnName: ACC_B }).name, ACC_B, 'b@\'s own window still goes to b@');
  eq(s.get(ACC_B).usage.fiveHour.percent, 4);
  s.flush();
  ok(JSON.parse(readFileSync(file, 'utf8')).swap?.fromFiveHourMs === ACC_C_5H, 'the swap record is on disk');
  // A daemon restart inside c@'s window keeps the rule.
  const again = createStreamUsage({ file, now: () => late, log: () => {}, persistDelayMs: 60_000 });
  eq(again.lastSwap(), { from: ACC_C, to: ACC_B, at: SWAP_AT, fromFiveHourMs: ACC_C_5H });
  eq(again.note(ACC_C_WALL, { liveName: ACC_B, spawnName: ACC_B }).name, null, 'after the restart too');
  // Once c@'s window has reset the mark is gone, and a restart then drops the record.
  const after = createStreamUsage({ file, now: () => ACC_C_5H + 1, log: () => {}, persistDelayMs: 60_000 });
  eq(after.lastSwap(), null, 'past the grace and past the window, the record is not loaded');
});

await t('five hour anchors survive a restart and a reset window is forgotten', () => {
  const { s, file, clock } = rig({ clock: { t: OCT8 } });
  s.learn(ACC_B, lookup(4, ACC_B_5H, 18, ACC_B_WEEK));
  s.flush();
  eq(JSON.parse(readFileSync(file, 'utf8')).anchors[ACC_B].fiveHourMs, ACC_B_5H);
  const again = createStreamUsage({ file, now: () => OCT8, log: () => {}, persistDelayMs: 60_000 });
  eq(again.snapshot().fiveHour[ACC_B], ACC_B_5H);
  const later = createStreamUsage({ file, now: () => ACC_B_5H + 1, log: () => {}, persistDelayMs: 60_000 });
  eq(later.snapshot().fiveHour[ACC_B], undefined, 'a window past its reset is no mark');
  clock.t = OCT8;
});

await t('a single weekly owner is unchanged by the five hour mark (identity already proven)', () => {
  const anchors = { a: { weeklyMs: NOW + 50 * HOUR, fiveHourMs: NOW + HOUR } };
  eq(attributeReading({ weeklyMs: NOW + 50 * HOUR, fiveHourMs: NOW + 3 * HOUR, liveName: 'b', anchors, now: NOW }).name, 'a');
});

// ---------------------------------------------------------------------------
// THE LIVE ACCOUNT TRACKER
// ---------------------------------------------------------------------------

function trackerRig() {
  const state = { blob: { claudeAiOauth: { accessToken: 'acc-1', refreshToken: 'ref-1' } }, resolves: 0, reads: 0, names: { 'acc-1': 'me' } };
  const clock = { t: NOW };
  const tr = createLiveAccountTracker({
    readCredentials: async () => {
      state.reads++;
      return state.blob;
    },
    resolveActive: async () => {
      state.resolves++;
      const tok = state.blob?.claudeAiOauth?.accessToken;
      return { name: state.names[tok] || null, liveFingerprint: `fp-${tok}` };
    },
    fingerprint: (o) => `fp-${o.accessToken}`,
    now: () => clock.t,
    ttlMs: 15_000,
  });
  return { tr, state, clock };
}

await t('the tracker names the live account and asks the identity ladder once per token', async () => {
  const { tr, state, clock } = trackerRig();
  eq(tr.current(), null, 'before the first refresh lands there is no name, never a guess');
  eq(await tr.refresh(), 'me');
  eq(tr.current(), 'me');
  clock.t += 20_000;
  eq(await tr.refresh(), 'me');
  eq(state.resolves, 1, 'the same token was identified twice: that can cost a profile call per refresh');
  eq(state.reads, 2, 'each refresh reads the credential store, which is what sees a swap');
});

await t('★ a swap is seen at the next refresh, and a refreshed token of the same account keeps its name', async () => {
  const { tr, state, clock } = trackerRig();
  await tr.refresh();
  state.blob = { claudeAiOauth: { accessToken: 'acc-2', refreshToken: 'ref-2' } };
  state.names['acc-2'] = 'gmail';
  clock.t += 16_000;
  eq(await tr.refresh(), 'gmail');
  // The live session refreshes its own token: new fingerprint, same account.
  state.blob = { claudeAiOauth: { accessToken: 'acc-3', refreshToken: 'ref-3' } };
  state.names['acc-3'] = 'gmail';
  clock.t += 16_000;
  eq(await tr.refresh(), 'gmail');
});

await t('current() is synchronous and refreshes in the background once the TTL is spent', async () => {
  const { tr, state, clock } = trackerRig();
  await tr.refresh();
  state.blob = { claudeAiOauth: { accessToken: 'acc-2', refreshToken: 'ref-2' } };
  state.names['acc-2'] = 'gmail';
  clock.t += 5_000;
  eq(tr.current(), 'me', 'inside the TTL');
  eq(state.reads, 1, 'no read inside the TTL');
  clock.t += 11_000;
  eq(tr.current(), 'me', 'the stale name while the refresh runs');
  await new Promise((r) => setTimeout(r, 10));
  eq(tr.current(), 'gmail');
});

await t('★ invalidate() after a swap: no stale name, and a refresh already in flight cannot restore one', async () => {
  // The keychain as a Claude Code swap leaves it, read by a store that is slow
  // enough for a refresh started BEFORE the swap to land AFTER it.
  const clock = { t: NOW };
  const kc = { blob: { claudeAiOauth: { accessToken: 'acc-1', refreshToken: 'ref-1' } } };
  const names = { 'acc-1': 'me', 'acc-2': 'gmail' };
  let release;
  const gate = new Promise((r) => (release = r));
  const tr = createLiveAccountTracker({
    readCredentials: async () => {
      const seen = kc.blob; // what the store held when it was asked
      await gate;
      return seen;
    },
    resolveActive: async () => ({ name: names[kc.blob.claudeAiOauth.accessToken], liveFingerprint: `fp-${kc.blob.claudeAiOauth.accessToken}` }),
    fingerprint: (o) => `fp-${o.accessToken}`,
    now: () => clock.t,
  });
  const stale = tr.refresh(); // asked while acc-1 is live
  kc.blob = { claudeAiOauth: { accessToken: 'acc-2', refreshToken: 'ref-2' } }; // the swap
  tr.invalidate();
  eq(tr.current(), null, 'right after a swap the outgoing name must not answer');
  release();
  await stale;
  await new Promise((r) => setTimeout(r, 10));
  eq(tr.current(), 'gmail', 'the pre-swap refresh landed last and put the outgoing name back');
});

await t('an unreadable store or an unidentifiable login is no name, never the last one', async () => {
  const { tr, state, clock } = trackerRig();
  await tr.refresh();
  state.blob = null;
  clock.t += 16_000;
  eq(await tr.refresh(), null);
  state.blob = { claudeAiOauth: { accessToken: 'acc-9', refreshToken: 'ref-9' } };
  clock.t += 16_000;
  eq(await tr.refresh(), null, 'a login no slot claims');
  const broken = createLiveAccountTracker({
    readCredentials: async () => {
      throw new Error('keychain locked');
    },
    resolveActive: async () => ({ name: 'me' }),
    fingerprint: () => 'x',
  });
  eq(await broken.refresh(), null);
});

// ---------------------------------------------------------------------------
// THE WIRING in bridge.mjs, read as text (importing it would boot a daemon).
// ---------------------------------------------------------------------------
const SRC = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');
const { makeRig, handleEvent, realEvent, apiBody, settle } = await import('./fixtures/model-owner-rig.mjs');
const region = (start, end) => {
  const i = SRC.indexOf(start);
  if (i < 0) return '';
  const j = SRC.indexOf(end, i + start.length);
  return SRC.slice(i, j < 0 ? undefined : j);
};

await t('every Claude stream the daemon parses records its rate_limit_event', () => {
  const runClaude = region('function runClaude(', '\nfunction ');
  ok(/else if \(ev\.type === 'rate_limit_event'\) \{[\s\S]{0,120}?noteStreamUsage\(ev, spawnAccount\);/.test(runClaude), 'runClaude onLine does not record the event with its spawn account');
  const iSpawnAcct = runClaude.indexOf('const spawnAccount = liveAccount.peek();');
  ok(iSpawnAcct > -1 && iSpawnAcct < runClaude.indexOf('spawnWorker(CLAUDE_BIN'), 'the spawn account must be read before the spawn');
  ok(/inflight\.add\(run\.watchdogId, \{[\s\S]{0,2000}?account: spawnAccount,/.test(runClaude), 'the registry record does not carry the spawn account for a re-attach');
  ok(runClaude.includes('const onLine = (line) =>') && runClaude.includes('tailLines(logPath, onLine'), 'the one handler must still feed both the pipe and the bg log tail');
  const wd = region('const watchdog = createWorkerWatchdog({', '\n});');
  ok(/onEvent: \(ev, \{ backlog, rec \}\) => \{\s*if \(!backlog && ev\?\.type === 'rate_limit_event'\) noteStreamUsage\(ev, rec\?\.account \?\? null\);/.test(wd), 're-attached survivors are not recorded, their backlog is, or their spawn account is lost');
});

await t('stream behavior records the refusal as the run\'s evidence and schedules one read, whatever the run\'s model', async () => {
  for (const model of ['opus', 'fable']) {
    const r = makeRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() } });
    try {
      await r.liveAccount.refresh();
      const ev = realEvent();
      const run = handleEvent(r, ev, model);
      await settle(8);
      eq(run.rejectedAccount, 'a');
      eq(run.rejectedLimit, ev);
      eq(run.stopped, false);
      eq(r.counts.usageGets.a || 0, 1);
    } finally { r.cleanup(); }
  }
});

await t('a reattached worker\'s refusal schedules the same one read', async () => {
  const r = makeRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() } });
  try {
    await r.liveAccount.refresh();
    const start = SRC.indexOf('  onEvent: (ev, { backlog, rec }) => {');
    const end = SRC.indexOf('\n  },', start);
    const body = SRC.slice(start + '  onEvent: '.length, end) + '\n  }';
    const handler = new Function('noteStreamUsage', `return ${body};`)(r.api.noteStreamUsage);
    handler(realEvent(), { backlog: false, rec: { account: 'a', model: 'fable' } });
    handler(realEvent(), { backlog: false, rec: { account: 'a', model: 'fable' } });
    await settle(8);
    eq(r.counts.usageGets.a || 0, 1);
  } finally { r.cleanup(); }
});

await t('noteStreamUsage attributes by the live account at event time and never throws', () => {
  const fn = region('function noteStreamUsage(', '\n}\n');
  ok(fn.includes('streamUsage.note(ev, { liveName: liveAccount.current(), spawnName })'), fn);
  ok(/try \{[\s\S]*\} catch \(e\)/.test(fn), 'a throw would cost the run its result line');
});

await t('the reader is fed the readings and learns from every good lookup', () => {
  ok(/createAccountUsage\(\{\s*store: accounts,\s*streamReading: \(name\) => streamUsage\.get\(name\),\s*onUsage: \(name, usage\) => \{\s*streamUsage\.learn\(name, usage\);\s*reconcileModelUsage\(name, usage\);/.test(SRC), 'the reader is not wired');
  ok(SRC.includes("const STREAM_USAGE_FILE = path.join(SCRIPT_DIR, 'usage-stream.json');"));
});

await t('the display paths opt in, the rotation paths do not', () => {
  ok(region('async function renderAccountView(', '\nfunction ').includes('accountUsage.all({ stream: true })') || /accountUsage\.all\(\{ stream: true \}\), 6_000/.test(SRC), '/account');
  ok(region('async function gatherUsage(', '\nasync function ').includes('accountUsage.all({ stream: true })'), '/usage');
  ok(SRC.includes('withDeadline(accountUsage.activeOnly({ stream: true }), 2_500)'), '/status');
  const reset = region('async function usageResetFor(', '\n}\n');
  ok(reset.includes('accountUsage.activeOnly()') && !reset.includes('stream'), 'usageResetFor must read the lookup only');
  const pick = region('async function pickHealthyAccount(', '\n}\n');
  ok(pick.includes('accountUsage.one(name)') && !pick.includes('stream'), 'the probe must read the lookup only');
  eq((SRC.match(/\(\{ stream: true \}\)/g) || []).length, 3, 'a new opt in call site needs a line in this test and a reason');
});

await t('every swap and every drift re-assert invalidates the live account name', () => {
  ok(/accounts\.swapTo = async \(\.\.\.args\) => \{[\s\S]{0,300}?try \{\s*const res = await swapToStore\(\.\.\.args\);[\s\S]{0,800}?return res;\s*\} finally \{[\s\S]{0,300}?liveAccount\.invalidate\(\);/.test(SRC), 'swapTo is not wrapped');
  // And every swap that LANDS tells the readings which account the outgoing
  // sessions are still on (rule 5: the 2026-10-08 false wall).
  ok(/if \(res\?\.ok\) \{\s*const from = res\.from \|\| \(liveBefore && liveBefore !== res\.to \? liveBefore : null\);\s*lastAccountSwap = \{ from, to: res\.to \|\| null, at: Date\.now\(\) \};[\s\S]{0,300}?streamUsage\.noteSwap\(lastAccountSwap\);/.test(SRC), 'a landed swap is not noted');
  // The outgoing name survives a blob the store could not fingerprint: the
  // tracker's name from before the swap stands in for the store's null `from`.
  ok(/const liveBefore = liveAccount\.current\(\);\s*try \{\s*const res = await swapToStore/.test(SRC), 'the outgoing name is not read before the swap');
  // The wrap must be the one every site calls: none may have kept the raw method.
  ok(!/const \{[^}]*\bswapTo\b[^}]*\} = accounts/.test(SRC), 'a destructured swapTo would bypass the wrap');
  ok(/\.checkDrift\(\)\s*(?:\/\/[^\n]*\n\s*)?\.then\(\(r\) => \{\s*if \(r\?\.drifted\) liveAccount\.invalidate\(\);/.test(SRC), 'a drift re-assert does not invalidate');
  const buttons = readFileSync(new URL('./account-buttons.mjs', import.meta.url), 'utf8');
  ok(buttons.includes('store.swapTo('), 'the buttons swap through the store object the wrap sits on');
});

await t('readings survive a restart: flushed on exit, primed at boot, and gitignored', () => {
  ok(/process\.on\('exit', \(\) => \{[\s\S]{0,300}?streamUsage\.flush\(\);/.test(SRC), 'no flush on exit');
  const main = region('async function main() {', '\n}\n');
  ok(main.indexOf('liveAccount.refresh()') > -1 && main.indexOf('liveAccount.refresh()') < main.indexOf('reattachLiveWorkers()'), 'the tracker must be primed before survivors are re-attached');
  const ignore = readFileSync(new URL('./.gitignore', import.meta.url), 'utf8').split('\n');
  ok(ignore.includes('usage-stream.json') && ignore.includes('usage-stream.json.tmp'), 'usage-stream.json is not gitignored');
});

// ---------- report ----------
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all stream-usage tests pass');
