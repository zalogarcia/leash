// Pure due-logic for the bridge's schedule store, shared by the daemon
// (bridge.mjs) and the CLI (schedule.mjs) so both agree on when a schedule
// fires and on how it is labelled. Two copies of "is it due yet?" is exactly
// the kind of drift that makes a reminder fire twice in one place and never in
// the other.
//
// Store shape: a daily item may carry `every`, an integer number of days, 2 or
// more. kind stays "daily" so every existing reader keeps working, and `every`
// absent or 1 means every day. `lastFired` stays the local YYYY-MM-DD date of
// the last fire, so an item that already fired today is skipped whatever its
// cadence.
//
// An `every N hours` item is kind "hours" (a kind of its own, so a daemon older
// than it reads it as a one-off whose `at` is not a number, which never comes
// due: inert, not wrong). `every` is its whole number of hours, 1 to 23, `at`
// its phase (HH:MM): it fires at `at` and every `every` hours after it, the
// count restarting each local day, and `lastFiredAt` is the epoch ms of the
// slot it last fired for.
//
// All date arithmetic runs on local YYYY-MM-DD strings through Date.UTC, never
// by adding milliseconds to a local Date: on a DST boundary a local day is 23
// or 25 hours long, and "3 days apart" must stay 3 calendar days, not 2.96.

const parseYMD = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
};

const toYMD = (utcMs) => {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const DAY_MS = 86_400_000;

/** Whole days from `a` to `b`, both local YYYY-MM-DD strings. Negative if b is
 *  before a. NaN if either string is not a date. */
export function daysBetween(a, b) {
  const from = parseYMD(a);
  const to = parseYMD(b);
  if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
  return Math.round((to - from) / DAY_MS);
}

/** `date` (local YYYY-MM-DD) shifted by n whole days, same format. null on a
 *  malformed date. */
export function addDays(date, n) {
  const base = parseYMD(date);
  if (Number.isNaN(base)) return null;
  return toYMD(base + n * DAY_MS);
}

/** The item's cadence in days: 1 for a plain daily, N for `every N days`.
 *  Anything that is not an integer of 2 or more reads as 1, so a hand-edited
 *  store cannot turn a reminder into a silent no-op. */
export function everyDays(item) {
  const n = Number(item?.every);
  return Number.isInteger(n) && n >= 2 ? n : 1;
}

/** Is this daily item due at local date `today`, local time `hhmm`?
 *  Same three gates as before for a plain daily (not fired today, time
 *  reached), plus the cadence gate for an `every N days` item. */
export function isDailyDue(item, today, hhmm) {
  if (!item || item.kind !== 'daily') return false;
  if (item.lastFired === today) return false;
  if (hhmm < item.at) return false;
  const every = everyDays(item);
  if (every === 1) return true;
  if (!item.lastFired) return true; // never fired: the first fire is today
  const gap = daysBetween(item.lastFired, today);
  // An unparseable lastFired must not freeze a schedule forever, so a broken
  // value fires and gets rewritten with a good one on the way out.
  return Number.isNaN(gap) ? true : gap >= every;
}

/** The cadence of an hours item, 1 to 23; 0 for anything that is not one. */
export function everyHours(item) {
  const n = Number(item?.every);
  return item?.kind === 'hours' && Number.isInteger(n) && n >= 1 && n <= 23 ? n : 0;
}

// Epoch ms of local minute `minute` (0 to 1439) of the local day `day` falls
// on. A minute the clock skips (the spring hour) is no time at all, so it maps
// to the first real minute after it, where the clock lands when it jumps:
// `new Date(y, mo, d, 0, minute)` alone would push it a whole hour further, past
// now. A minute that happens twice (the fall back hour) is its first pass.
const slotMs = (day, minute) => {
  const y = day.getFullYear(), mo = day.getMonth(), d = day.getDate();
  for (let k = minute; k < 1440; k++) {
    const t = new Date(y, mo, d, 0, k);
    if (t.getDate() === d && t.getHours() * 60 + t.getMinutes() === k) return t.getTime();
  }
  return new Date(y, mo, d + 1).getTime(); // the skipped stretch ran to midnight
};

/** Epoch ms of the latest slot of an hours item at or before `nowMs`, or NaN.
 *  The day's first slot is `at` minus whole steps (so 00:05 every 2h and 06:05
 *  every 2h are the same schedule); before it, yesterday's last slot counts. A
 *  slot in the hour the clock skips fires at the first real minute after it,
 *  so the value is never later than `nowMs`. */
export function latestHoursSlot(item, nowMs = Date.now()) {
  const every = everyHours(item);
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(item?.at ?? ''));
  if (!every || !m) return NaN;
  const step = every * 60;
  const first = (Number(m[1]) * 60 + Number(m[2])) % step;
  const now = new Date(nowMs);
  const minute = now.getHours() * 60 + now.getMinutes();
  if (minute >= first) return slotMs(now, first + Math.floor((minute - first) / step) * step);
  const last = first + Math.floor((1439 - first) / step) * step;
  return slotMs(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12), last);
}

/** Is this hours item due at `nowMs`? Its latest slot has come and it has not
 *  fired for that slot. A missing or broken lastFiredAt fires once, then is
 *  rewritten with a good one. */
export function isHoursDue(item, nowMs = Date.now()) {
  const slot = latestHoursSlot(item, nowMs);
  if (Number.isNaN(slot)) return false;
  const last = Number(item.lastFiredAt);
  return !(Number.isFinite(last) && last >= slot);
}

/** The label both the daemon and the CLI print for an item. */
export function describeWhen(item) {
  if (!item) return '';
  if (item.kind === 'hours') return `every ${everyHours(item) || '?'}h from ${item.at}`;
  if (item.kind === 'daily') {
    const every = everyDays(item);
    return every > 1 ? `every ${every}d ${item.at}` : `daily ${item.at}`;
  }
  return new Date(item.at).toLocaleString();
}

/** The next local date an `every N days` item fires, for the "(next …)" hint.
 *  null for anything without a cadence, since a plain daily's next fire is
 *  simply today or tomorrow and saying so adds nothing. A next date already in
 *  the past (the Mac slept through it) reads as today, which is when it will
 *  actually fire. */
export function nextDaily(item, today) {
  if (!item || item.kind !== 'daily' || everyDays(item) === 1) return null;
  if (!item.lastFired) return today;
  const next = addDays(item.lastFired, everyDays(item));
  if (!next) return today;
  return next < today ? today : next;
}
