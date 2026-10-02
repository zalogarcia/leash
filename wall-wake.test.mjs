// wall-wake.mjs: the next account at an all-accounts wall, and the episode
// that makes the lift's wake-up happen exactly once, across daemon restarts.
// Run: node wall-wake.test.mjs

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pickNextAccount, createWallWake, RESET_UNKNOWN_SOURCES, WALL_WAKE_WORKERS_MAX, WALL_WAKE_CARRY_MS } from './wall-wake.mjs';

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
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const NOW = Date.UTC(2026, 8, 30, 14, 54, 0); // 10:54 ET, the wall
const at = (mins) => Math.floor((NOW + mins * 60_000) / 1000);
const row = (name, extra = {}) => ({ name, captured: true, limited: true, limitedUntil: at(60), limitedSource: 'probe', ...extra });

// ---------------------------------------------------------------------------
console.log('\n1. pickNextAccount: the account that frees first');
// ---------------------------------------------------------------------------

t('★ the earliest known reset wins', () => {
  const rows = [row('two@', { limitedUntil: at(1440) }), row('four@', { limitedUntil: at(96) }), row('three@', { limitedUntil: at(300) })];
  eq(pickNextAccount(rows, NOW), { name: 'four@', until: at(96), guessed: false });
});

t('★ never a guessed clock over a known one, however much sooner the guess', () => {
  const rows = [row('guess@', { limitedUntil: at(10), limitedSource: 'guessed' }), row('probe-guess@', { limitedUntil: at(5), limitedSource: 'probe (no reset clock)' }), row('known@', { limitedUntil: at(90) })];
  eq(pickNextAccount(rows, NOW)?.name, 'known@');
  eq(pickNextAccount(rows, NOW)?.guessed, false);
});

t('every clock a guess: the earliest guess, flagged as one', () => {
  const rows = [row('a@', { limitedUntil: at(50), limitedSource: 'guessed' }), row('b@', { limitedUntil: at(20), limitedSource: 'guessed' })];
  eq(pickNextAccount(rows, NOW), { name: 'b@', until: at(20), guessed: true });
});

t('a source the ledger never set counts as known (the death path before provenance)', () => {
  eq(pickNextAccount([row('a@', { limitedSource: null, limitedUntil: at(30) }), row('b@', { limitedUntil: at(40) })], NOW)?.name, 'a@');
});

t('a free captured account means this is not an all-accounts wall: null', () => {
  eq(pickNextAccount([row('a@'), row('b@', { limited: false, limitedUntil: null })], NOW), null);
});

t('an uncaptured slot is never the next account', () => {
  eq(pickNextAccount([row('a@', { captured: false, limitedUntil: at(5) }), row('b@', { limitedUntil: at(40) })], NOW)?.name, 'b@');
});

t('nothing enrolled, or nothing with a clock in the future: null', () => {
  eq(pickNextAccount([], NOW), null);
  eq(pickNextAccount(null, NOW), null);
  eq(pickNextAccount([row('a@', { limitedUntil: at(-5) })], NOW), null);
});

t('ties keep ledger order, so the pick is deterministic', () => {
  eq(pickNextAccount([row('first@', { limitedUntil: at(30) }), row('second@', { limitedUntil: at(30) })], NOW)?.name, 'first@');
});

t('★ a slot that needs a login is never the next account, even with the earliest clock (2026-09-30)', () => {
  const dead = row('four@example.com', { limitedUntil: at(10), needsLogin: { reason: 'login refused (invalid_grant)' } });
  eq(pickNextAccount([dead, row('three@', { limitedUntil: at(90) })], NOW)?.name, 'three@', 'the wall-time move would put the login on a dead account');
  // Unwalled but dead: it is not a free account, so the wall is still an all-accounts wall.
  const deadFree = row('four@example.com', { limited: false, limitedUntil: null, needsLogin: { reason: 'x' } });
  eq(pickNextAccount([deadFree, row('three@', { limitedUntil: at(90) })], NOW)?.name, 'three@');
  eq(pickNextAccount([dead], NOW), null, 'the only walled account is dead: nothing to move to');
});

t('the unknown-clock sources are exactly the two the daemon writes', () => {
  eq([...RESET_UNKNOWN_SOURCES].sort(), ['guessed', 'probe (no reset clock)']);
});

// ---------------------------------------------------------------------------
console.log('\n2. the episode: raised, recorded, claimed once, across restarts');
// ---------------------------------------------------------------------------

const TMP = mkdtempSync(path.join(tmpdir(), 'wall-wake-test-'));
let n = 0;
const fresh = () => path.join(TMP, `wall-wake-${++n}.json`);

t('no file: no episode, nothing pending, nothing to claim', () => {
  const w = createWallWake({ file: fresh() });
  eq(w.current(), null);
  eq(w.pending(), false);
  eq(w.claim({ via: 'reset', now: NOW }), null);
  eq(w.worker({ runId: 'bg1' }), false, 'a worker with no wall is not recorded');
});

t('★ raised: one pending episode; claimed ONCE; the second claim is null', () => {
  const w = createWallWake({ file: fresh() });
  w.raised({ until: NOW + 3600_000, now: NOW });
  eq(w.pending(), true);
  const c = w.claim({ via: 'reset', now: NOW + 3600_000 });
  ok(c && c.wokeAt === NOW + 3600_000 && c.via === 'reset', JSON.stringify(c));
  eq(w.claim({ via: 'poll', now: NOW + 3700_000 }), null, 'a second lift inside the same wall');
  eq(w.pending(), false);
});

t('★ a restart before the lift still owes the wake-up; a restart after it does not', () => {
  const file = fresh();
  const a = createWallWake({ file });
  a.raised({ until: NOW + 3600_000, now: NOW });
  a.worker({ runId: 'bg39-1', title: 'Re-check walls', report: '/r/bg39-1.md', handback: 'held', died: true });
  const b = createWallWake({ file }); // the restart
  eq(b.pending(), true, 'the episode survived');
  eq(b.current().workers.map((x) => x.runId), ['bg39-1'], 'with what it had recorded');
  ok(b.claim({ via: 'poll', now: NOW + 3600_000 }), 'woken once');
  const c = createWallWake({ file }); // a second restart
  eq(c.pending(), false);
  eq(c.claim({ via: 'poll', now: NOW + 3700_000 }), null, 'never twice');
});

t('★ raised again before the wake ran: the SAME episode, its workers kept, its clock moved', () => {
  const w = createWallWake({ file: fresh() });
  const first = w.raised({ until: NOW + 3600_000, now: NOW });
  w.worker({ runId: 'bg1', handback: 'held' });
  const second = w.raised({ until: NOW + 7200_000, now: NOW + 600_000 });
  eq(second.raisedAt, first.raisedAt);
  eq(second.until, NOW + 7200_000);
  eq(second.workers.length, 1);
});

t('★ a carry marks each carried row with the wake-up that already listed it', () => {
  const w = createWallWake({ file: fresh() });
  w.raised({ until: NOW + 60_000, now: NOW });
  w.worker({ runId: 'bg1', handback: 'held' });
  w.claim({ via: 'reset', now: NOW + 60_000, parked: [{ task: 't', report: '/p.md' }] });
  const next = w.raised({ until: NOW + 7200_000, now: NOW + 120_000 });
  eq(next.workers.map((x) => [x.runId, x.listedAt]), [['bg1', NOW + 60_000]]);
  eq(next.carried.parked.map((p) => [p.report, p.listedAt]), [['/p.md', NOW + 60_000]]);
});

t('raised well after a wake-up ran: a NEW episode, empty', () => {
  const w = createWallWake({ file: fresh() });
  w.raised({ until: NOW + 60_000, now: NOW });
  w.worker({ runId: 'bg1' });
  w.claim({ via: 'reset', now: NOW + 60_000, parked: [{ task: 't', report: '/p.md' }] });
  const next = w.raised({ until: NOW + 7200_000, now: NOW + 60_000 + WALL_WAKE_CARRY_MS });
  eq(next.raisedAt, NOW + 60_000 + WALL_WAKE_CARRY_MS);
  eq(next.workers, []);
  eq(next.carried, null);
  eq(w.pending(), true);
});

t('★ raised RIGHT after a wake-up: the wake-up most likely died in it, so its workers and parked reports carry forward', () => {
  const file = fresh();
  const w = createWallWake({ file });
  w.raised({ until: NOW + 60_000, now: NOW });
  w.worker({ runId: 'bg39-1', handback: 'held', report: '/r/bg39-1.md' });
  const claimed = w.claim({ via: 'reset', now: NOW + 60_000, parked: [{ task: 'reels', status: 'finished', report: '/r/bg12.md' }] });
  eq(claimed.parked.map((p) => p.report), ['/r/bg12.md'], 'the claim keeps what the capped chain handed it');
  const next = w.raised({ until: NOW + 7200_000, now: NOW + 120_000 });
  eq(next.wokeAt, null);
  eq(next.workers.map((x) => x.runId), ['bg39-1']);
  eq(next.carried.parked.map((p) => p.report), ['/r/bg12.md']);
  eq(createWallWake({ file }).current().carried.parked.length, 1, 'and it is on disk for a restart');
});

t('a worker recorded twice is one row, updated', () => {
  const w = createWallWake({ file: fresh() });
  w.raised({ until: NOW + 60_000, now: NOW });
  w.worker({ runId: 'bg1', died: true, handback: 'delivered' });
  w.worker({ runId: 'bg1', handback: 'held', report: '/r.md' });
  eq(w.current().workers, [{ runId: 'bg1', died: true, handback: 'held', report: '/r.md' }]);
});

t('the worker list is bounded', () => {
  const w = createWallWake({ file: fresh() });
  w.raised({ until: NOW + 60_000, now: NOW });
  for (let i = 0; i < WALL_WAKE_WORKERS_MAX + 5; i++) w.worker({ runId: `bg${i}` });
  eq(w.current().workers.length, WALL_WAKE_WORKERS_MAX);
});

t('moveTried and moved are recorded, and nothing is recorded after the wake-up', () => {
  const w = createWallWake({ file: fresh() });
  w.raised({ until: NOW + 60_000, now: NOW });
  w.moveTried('gjg@', { name: 'gjg@', until: 1, guessed: false });
  w.moved('gjg@', NOW + 5);
  const e = w.current();
  eq([e.moveTried, e.movedTo, e.movedAt, e.next?.name], ['gjg@', 'gjg@', NOW + 5, 'gjg@']);
  w.claim({ now: NOW + 60_000 });
  eq(w.moved('other@', NOW + 70_000), false);
  eq(w.worker({ runId: 'late' }), false);
});

t('current() is a copy: editing it does not edit the episode', () => {
  const w = createWallWake({ file: fresh() });
  w.raised({ until: NOW + 60_000, now: NOW });
  const c = w.current();
  c.wokeAt = 1;
  c.workers.push({ runId: 'x' });
  eq(w.pending(), true);
  eq(w.current().workers.length, 0);
});

t('a corrupt or foreign file is no episode, and never throws', () => {
  const file = fresh();
  writeFileSync(file, '{ not json');
  eq(createWallWake({ file }).pending(), false);
  writeFileSync(file, JSON.stringify({ something: 'else' }));
  eq(createWallWake({ file }).current(), null);
});

t('a write that fails is logged; the process still wakes only once', () => {
  const logs = [];
  const w = createWallWake({ file: path.join(TMP, 'no-such-dir', 'wall-wake.json'), log: (m) => logs.push(m) });
  w.raised({ until: NOW + 60_000, now: NOW });
  ok(logs.length >= 1 && /could not write/.test(logs[0]), JSON.stringify(logs));
  ok(w.claim({ now: NOW + 60_000 }), 'claimed from memory');
  eq(w.claim({ now: NOW + 61_000 }), null);
});

t('the file on disk is JSON the next daemon can read', () => {
  const file = fresh();
  const w = createWallWake({ file });
  w.raised({ until: NOW + 60_000, now: NOW });
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  eq([disk.v, disk.raisedAt, disk.wokeAt], [1, NOW, null]);
});

t('★ a manual pick is persisted, survives a restart, and a new wall on the same episode clears it', () => {
  const file = fresh();
  const a = createWallWake({ file });
  a.raised({ until: NOW + 60_000, now: NOW });
  eq(a.vouched({ name: 'two@example.com', now: NOW + 1000 }), true);
  const b = createWallWake({ file }); // the restart
  eq([b.current().vouchedAt, b.current().vouchedFor], [NOW + 1000, 'two@example.com']);
  b.raised({ until: NOW + 120_000, now: NOW + 2000 }); // the pick walled too
  eq([b.current().vouchedAt, b.current().vouchedFor], [null, null], 'a wall raised after the pick means the pick is spent');
  eq(b.pending(), true, 'still the same episode, still owed');
});

t('a pick after the wake-up already ran records nothing', () => {
  const w = createWallWake({ file: fresh() });
  eq(w.vouched({ name: 'x' }), false, 'no episode');
  w.raised({ until: NOW + 60_000, now: NOW });
  w.claim({ now: NOW + 60_000 });
  eq(w.vouched({ name: 'x' }), false, 'claimed');
  eq(w.current().vouchedAt, null);
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all wall-wake tests pass');
