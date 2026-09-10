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

/** The label both the daemon and the CLI print for an item. */
export function describeWhen(item) {
  if (!item) return '';
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
