#!/usr/bin/env node
// Unit tests for the schedule due-logic shared by the daemon and the CLI.
//
// The dangerous half of this module is the calendar, not the cadence: an
// "every 3 days" check that quietly becomes every 2 or every 4 across a DST
// boundary is the kind of bug nobody notices for a month, so the day-counting
// cases carry the stars. The second risk is regression: a plain daily item must
// behave exactly as it did before `every` existed.
//
//   node schedule-due.test.mjs

import { addDays, daysBetween, describeWhen, everyDays, everyHours, isDailyDue, isHoursDue, latestHoursSlot, nextDaily } from './schedule-due.mjs';

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
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const daily = (extra = {}) => ({ kind: 'daily', at: '12:00', text: 'check the ads', ...extra });

// ---------------------------------------------------------------------------
console.log('\n1. plain daily, unchanged behaviour');

t('due when the time is reached and it has not fired today', () => {
  ok(isDailyDue(daily({ lastFired: '2026-09-09' }), '2026-09-10', '12:00'), 'should be due at exactly the time');
  ok(isDailyDue(daily({ lastFired: '2026-09-09' }), '2026-09-10', '23:59'), 'should be due later in the day');
});

t('not due before the time', () => {
  ok(!isDailyDue(daily({ lastFired: '2026-09-09' }), '2026-09-10', '11:59'), 'a minute early is not due');
});

t('not due twice in one day', () => {
  ok(!isDailyDue(daily({ lastFired: '2026-09-10' }), '2026-09-10', '18:00'), 'already fired today');
});

t('a daily that never fired is due as soon as the time is reached', () => {
  ok(isDailyDue(daily(), '2026-09-10', '12:00'));
  ok(!isDailyDue(daily(), '2026-09-10', '09:00'));
});

t('every: 1 is treated as a plain daily', () => {
  ok(isDailyDue(daily({ every: 1, lastFired: '2026-09-09' }), '2026-09-10', '12:00'));
  eq(everyDays(daily({ every: 1 })), 1);
});

t('a once item is never daily-due', () => {
  ok(!isDailyDue({ kind: 'once', at: Date.now(), text: 'x' }, '2026-09-10', '23:59'));
  ok(!isDailyDue(null, '2026-09-10', '23:59'));
});

// ---------------------------------------------------------------------------
console.log('\n2. every N days');

t('every 3, fired 2 days ago: not due', () => {
  ok(!isDailyDue(daily({ every: 3, lastFired: '2026-09-08' }), '2026-09-10', '12:00'), 'gap of 2 is short of 3');
});

t('every 3, fired 3 days ago: due', () => {
  ok(isDailyDue(daily({ every: 3, lastFired: '2026-09-07' }), '2026-09-10', '12:00'));
});

t('every 3, fired 9 days ago: due (a missed window does not skip a cycle)', () => {
  ok(isDailyDue(daily({ every: 3, lastFired: '2026-09-01' }), '2026-09-10', '12:00'));
});

t('every 3, never fired: due', () => {
  ok(isDailyDue(daily({ every: 3 }), '2026-09-10', '12:00'));
});

t('every 3, fired today: not due', () => {
  ok(!isDailyDue(daily({ every: 3, lastFired: '2026-09-10' }), '2026-09-10', '23:00'));
});

t('every 3, due day but the time has not come: not due', () => {
  ok(!isDailyDue(daily({ every: 3, lastFired: '2026-09-07' }), '2026-09-10', '11:59'));
});

t('every 3 anchored ahead of today: not due until the anchor plus 3', () => {
  // `update --anchor` can set lastFired to a date in the future; a negative gap
  // must read as "not yet", never as "overdue".
  ok(!isDailyDue(daily({ every: 3, lastFired: '2026-09-12' }), '2026-09-11', '12:00'));
});

t('a corrupt lastFired fires rather than freezing the schedule', () => {
  ok(isDailyDue(daily({ every: 3, lastFired: 'yesterday' }), '2026-09-10', '12:00'));
});

t('every 365 is honoured, every 0 and every -2 read as daily', () => {
  ok(!isDailyDue(daily({ every: 365, lastFired: '2026-09-09' }), '2026-09-10', '12:00'));
  eq(everyDays(daily({ every: 0 })), 1);
  eq(everyDays(daily({ every: -2 })), 1);
  eq(everyDays(daily({ every: 2.5 })), 1);
  eq(everyDays(daily({ every: '3' })), 3, 'a string from a hand-edited store still counts');
});

// ---------------------------------------------------------------------------
console.log('\n3. daysBetween, the calendar cases');

t('same day is 0, next day is 1', () => {
  eq(daysBetween('2026-09-10', '2026-09-10'), 0);
  eq(daysBetween('2026-09-10', '2026-09-11'), 1);
});

t('backwards is negative', () => {
  eq(daysBetween('2026-09-11', '2026-09-10'), -1);
});

t('across a month boundary', () => {
  eq(daysBetween('2026-08-31', '2026-09-01'), 1);
  eq(daysBetween('2026-08-29', '2026-09-01'), 3);
});

t('across a year boundary', () => {
  eq(daysBetween('2026-12-31', '2027-01-01'), 1);
});

t('across a leap day', () => {
  eq(daysBetween('2028-02-28', '2028-03-01'), 2, '2028 is a leap year');
});

t('across the DST end date, 2026-11-01, a day is still a day', () => {
  // US DST ends on 2026-11-01. Local-clock arithmetic gives 25 hours here and
  // would floor to 0 or round to 2 depending on which way you lean.
  eq(daysBetween('2026-10-31', '2026-11-01'), 1);
  eq(daysBetween('2026-11-01', '2026-11-02'), 1);
  eq(daysBetween('2026-10-31', '2026-11-03'), 3);
});

t('across the DST start date, 2026-03-08, a day is still a day', () => {
  eq(daysBetween('2026-03-07', '2026-03-08'), 1);
  eq(daysBetween('2026-03-08', '2026-03-09'), 1);
});

t('a malformed date is NaN, not a wrong number', () => {
  ok(Number.isNaN(daysBetween('nope', '2026-09-10')));
  ok(Number.isNaN(daysBetween('2026-09-10', undefined)));
});

// ---------------------------------------------------------------------------
console.log('\n4. addDays and nextDaily');

t('addDays walks the calendar, DST included', () => {
  eq(addDays('2026-09-10', 3), '2026-09-13');
  eq(addDays('2026-10-31', 3), '2026-11-03');
  eq(addDays('2026-12-30', 3), '2027-01-02');
  eq(addDays('2026-09-10', -3), '2026-09-07');
  eq(addDays('nope', 3), null);
});

t('nextDaily is the anchor plus the cadence', () => {
  eq(nextDaily(daily({ every: 3, lastFired: '2026-09-10' }), '2026-09-11'), '2026-09-13');
});

t('nextDaily is today when it never fired, or when the window was missed', () => {
  eq(nextDaily(daily({ every: 3 }), '2026-09-11'), '2026-09-11');
  eq(nextDaily(daily({ every: 3, lastFired: '2026-08-01' }), '2026-09-11'), '2026-09-11');
});

t('nextDaily is null without a cadence', () => {
  eq(nextDaily(daily({ lastFired: '2026-09-10' }), '2026-09-11'), null);
  eq(nextDaily({ kind: 'once', at: Date.now() }, '2026-09-11'), null);
});

// ---------------------------------------------------------------------------
console.log('\n5. describeWhen, one label for both callers');

t('plain daily', () => {
  eq(describeWhen(daily()), 'daily 12:00');
  eq(describeWhen(daily({ every: 1 })), 'daily 12:00');
});

t('every N days', () => {
  eq(describeWhen(daily({ every: 3 })), 'every 3d 12:00');
  eq(describeWhen(daily({ every: 14, at: '08:30' })), 'every 14d 08:30');
});

t('once falls back to the locale string', () => {
  const when = new Date('2026-09-13T12:00:00');
  eq(describeWhen({ kind: 'once', at: when.getTime(), text: 'x' }), when.toLocaleString());
});

t('no item, no throw', () => {
  eq(describeWhen(null), '');
});

// ---------------------------------------------------------------------------
console.log('\n6. the conversion M has to make: #68 fires on 2026-09-13');

t('anchored on 2026-09-10, every 3d 12:00, fires on the 13th and not before', () => {
  const item = daily({ every: 3, at: '12:00', lastFired: '2026-09-10' });
  eq(describeWhen(item), 'every 3d 12:00');
  eq(nextDaily(item, '2026-09-11'), '2026-09-13');
  ok(!isDailyDue(item, '2026-09-11', '12:00'), 'not on the 11th');
  ok(!isDailyDue(item, '2026-09-12', '23:59'), 'not on the 12th');
  ok(!isDailyDue(item, '2026-09-13', '11:59'), 'not before noon on the 13th');
  ok(isDailyDue(item, '2026-09-13', '12:00'), 'fires at noon on the 13th');
  // and then the cycle continues from the 13th
  const fired = { ...item, lastFired: '2026-09-13' };
  ok(!isDailyDue(fired, '2026-09-15', '12:00'));
  ok(isDailyDue(fired, '2026-09-16', '12:00'));
});

// ── every N hours (kind "hours") ────────────────────────────────────────
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const hours = (extra = {}) => ({ kind: 'hours', every: 2, at: '00:05', text: 'sweep', ...extra });

t('everyHours reads 1..23 on an hours item and 0 on anything else', () => {
  eq(everyHours(hours()), 2);
  eq(everyHours(hours({ every: 1 })), 1);
  eq(everyHours(hours({ every: 24 })), 0);
  eq(everyHours(hours({ every: '2' })), 2);
  eq(everyHours(daily({ every: 2 })), 0, 'a daily with every is days, not hours');
});

t('the latest slot: the phase is at, then every N hours, restarting each day', () => {
  eq(latestHoursSlot(hours(), at(2026, 11, 4, 9, 30)), at(2026, 11, 4, 8, 5));
  eq(latestHoursSlot(hours(), at(2026, 11, 4, 8, 5)), at(2026, 11, 4, 8, 5), 'the slot minute itself counts');
  eq(latestHoursSlot(hours(), at(2026, 11, 4, 0, 4)), at(2026, 11, 3, 22, 5), 'before the first slot: yesterday\'s last');
  eq(latestHoursSlot(hours({ at: '06:05' }), at(2026, 11, 4, 9, 30)), at(2026, 11, 4, 8, 5), '06:05 every 2h is the same schedule');
  eq(latestHoursSlot(hours({ every: 5, at: '01:00' }), at(2026, 11, 4, 23, 59)), at(2026, 11, 4, 21, 0));
  ok(Number.isNaN(latestHoursSlot(hours({ at: '25:00' }), Date.now())), 'a bad at is NaN');
  ok(Number.isNaN(latestHoursSlot(daily(), Date.now())), 'a daily has no hours slot');
});

t('isHoursDue fires once per slot', () => {
  const now = at(2026, 11, 4, 9, 30);
  ok(isHoursDue(hours(), now), 'never fired: due');
  ok(!isHoursDue(hours({ lastFiredAt: at(2026, 11, 4, 8, 5) }), now), 'fired for this slot: not due');
  ok(isHoursDue(hours({ lastFiredAt: at(2026, 11, 4, 6, 5) }), now), 'fired for the slot before: due');
  ok(isHoursDue(hours({ lastFiredAt: 'garbage' }), now), 'a broken lastFiredAt fires once');
  ok(!isHoursDue(daily(), now), 'a daily is never an hours item');
});

t('describeWhen labels an hours item', () => {
  eq(describeWhen(hours()), 'every 2h from 00:05');
});

t('describeWhen names the FIRST slot of the day, which is where the count restarts', () => {
  // every 5h added at 09:00 fires at 04:00, 09:00, 14:00 and 19:00. "from
  // 09:00" hid the 04:00 fire.
  eq(describeWhen(hours({ every: 5, at: '09:00' })), 'every 5h from 04:00');
  eq(describeWhen(hours({ every: 3, at: '09:00' })), 'every 3h from 00:00');
  eq(describeWhen(hours({ every: 7, at: '23:30' })), 'every 7h from 02:30');
  eq(describeWhen(hours({ every: 23, at: '22:59' })), 'every 23h from 22:59');
  eq(describeWhen(hours({ at: 'garbage' })), 'every 2h from garbage', 'an unreadable phase is printed as it is');
});

t('an hours item is inert for a daemon that predates it (its at is not a number)', () => {
  // The old checkSchedules: not daily, so `Date.now() >= s.at`, which is false
  // for a string, so it never fires and is never removed.
  const s = hours();
  ok(!(s.kind === 'daily') && !(Date.now() >= s.at), 'an old daemon would fire it');
});

// ── every N hours across a clock change ─────────────────────────────────
// A slot is a local wall time. On the spring night one local hour never
// happens, and on the fall back night one happens twice. The rule: a slot in
// the skipped hour fires at the first real minute after it, where the clock
// lands when it jumps (as a daily item at 02:30 fires at 03:00 that night), and
// when that minute is itself a slot the two are one fire. A slot in the
// repeated hour fires once, the first time round. So, polled once a minute as
// the daemon polls, an entry fires exactly where the wall clock first reaches
// one of its slots, and stamps the minute it fired: never a later minute (an
// early fire), never an earlier one (a late fire). The expected fires come from
// the zone's own clock read through Intl, never from a Date built out of a
// local time, which is the step that went wrong.
const CLOCK_CHANGES = [
  // zone, the night an hour is skipped, the night an hour repeats
  ['America/Chicago', [2027, 3, 14], [2026, 11, 1]],
  ['Australia/Sydney', [2026, 10, 4], [2027, 4, 4]],
];

// Minutes since 1970-01-01 on the wall clock of `zone` at epoch ms `ms`.
const wallClock = (zone) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  return (ms) => {
    const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day) / 60_000 + +p.hour * 60 + +p.minute;
  };
};

const minutePolls = (from, to) => {
  const out = [];
  for (let ms = from; ms < to; ms += 60_000) out.push(ms);
  return out;
};

// The polls a correct entry fires on: those where the wall clock first passes
// one of its slots (minute `first` of each day, then every `step` minutes).
const clockFires = (polls, wall, first, step) => {
  const nextSlot = (v) => {
    const day = Math.floor(v / 1440) * 1440;
    const m = v - day;
    const s = m < first ? first : first + (Math.floor((m - first) / step) + 1) * step;
    return s < 1440 ? day + s : day + 1440 + first;
  };
  const out = [];
  let reached = wall(polls[0] - 60_000);
  for (const ms of polls) {
    const w = wall(ms);
    if (w <= reached) continue; // the repeated hour: nothing new on the clock
    if (nextSlot(reached) <= w) out.push(ms);
    reached = w;
  }
  return out;
};

// The daemon's loop (bridge.mjs checkSchedules): poll, fire when due, stamp the
// slot. Counts a slot later than the poll, and a stamp that is not the poll.
const daemonFires = (item, polls, seen) => {
  item.lastFiredAt = latestHoursSlot(item, polls[0] - 60_000);
  const fires = [];
  for (const ms of polls) {
    if (latestHoursSlot(item, ms) > ms) seen.future++;
    if (!isHoursDue(item, ms)) continue;
    item.lastFiredAt = latestHoursSlot(item, ms);
    if (item.lastFiredAt !== ms) seen.offMinute++;
    fires.push(ms);
  }
  return fires;
};

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const utc = (iso) => Date.parse(`${iso}Z`);

console.log('\n7. every N hours across a clock change');
const homeTZ = process.env.TZ;
try {
  for (const [zone, ...nights] of CLOCK_CHANGES) {
    process.env.TZ = zone;
    const wall = wallClock(zone);
    for (const [y, mo, d] of nights) {
      const name = `${zone} ${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      t(`${name}: every 1 to 23 hours, polled once a minute, fires where the clock reaches a slot`, () => {
        const start = new Date(y, mo - 1, d).getTime();
        ok(wall(start) % 1440 === 0 && wall(new Date(y, mo - 1, d, 12).getTime()) % 1440 === 720, `the process clock is not ${zone}`);
        // Every cadence, with `at` on a 15 minute grid over 01:00 to 03:45,
        // where both zones change their clocks, one entry per distinct
        // schedule. Polls run to noon; a cadence of 21 hours or more runs on to
        // 03:00 the next day, because its last slot of the day can be the
        // skipped one, and it comes back the next morning as yesterday's slot.
        const toNoon = minutePolls(start, new Date(y, mo - 1, d, 12).getTime());
        const toNextNight = minutePolls(start, new Date(y, mo - 1, d + 1, 3).getTime());
        const seen = { future: 0, offMinute: 0 };
        const wrong = [];
        let entries = 0;
        let polls = 0;
        let fires = 0;
        for (let every = 1; every <= 23; every++) {
          const firsts = new Set();
          for (let a = 60; a < 240; a += 15) {
            const step = every * 60;
            if (firsts.has(a % step)) continue;
            firsts.add(a % step);
            const run = every >= 21 ? toNextNight : toNoon;
            const item = { kind: 'hours', every, at: hhmm(a), text: 'sweep' };
            const got = daemonFires(item, run, seen);
            const want = clockFires(run, wall, a % step, step);
            if (got.join() !== want.join()) wrong.push(`every ${every}h from ${hhmm(a)}`);
            entries++;
            polls += run.length;
            fires += got.length;
          }
        }
        console.log(`   ${name}: ${entries} entries, ${polls} polls, ${fires} fires`);
        ok(entries > 250 && fires > entries, `the grid ran: ${entries} entries, ${fires} fires`);
        // future: polls where latestHoursSlot is later than now. off minute:
        // fires stamped with another minute than their own, early or late.
        // wrong: entries that fire where the clock reaches no slot, or miss one.
        eq(`future ${seen.future}, off minute ${seen.offMinute}, wrong ${wrong.length}`, 'future 0, off minute 0, wrong 0', wrong.slice(0, 3).join('; '));
      });
    }
  }

  process.env.TZ = 'America/Chicago';
  const fired = (every, at, from, to) => daemonFires({ kind: 'hours', every, at, text: 'sweep' }, minutePolls(utc(from), utc(to)), { future: 0, offMinute: 0 }).map((ms) => new Date(ms).toISOString().slice(0, 16));

  t('spring night: the skipped 02:30 fires at 03:00, and 03:30 still fires', () => {
    // CST is UTC-6 and CDT UTC-5; 02:00 CST jumps to 03:00 CDT, 08:00Z.
    eq(fired(1, '00:30', '2027-03-14T06:00', '2027-03-14T10:00').join(' '), '2027-03-14T06:30 2027-03-14T07:30 2027-03-14T08:00 2027-03-14T08:30 2027-03-14T09:30');
    eq(latestHoursSlot({ kind: 'hours', every: 1, at: '00:30' }, utc('2027-03-14T08:10')), utc('2027-03-14T08:00'), 'at 03:10 CDT the slot is 03:00, not 03:30');
  });

  t('spring night: a skipped 02:00 and the 03:00 it lands on are one fire', () => {
    eq(fired(1, '00:00', '2027-03-14T06:00', '2027-03-14T10:00').join(' '), '2027-03-14T06:00 2027-03-14T07:00 2027-03-14T08:00 2027-03-14T09:00');
  });

  t('spring night: a skipped last slot is not fired again as yesterday\'s the next morning', () => {
    // every 22h from 02:30 has one slot a day. It fires at 03:00 CDT on the
    // 14th, and next at 02:30 CDT on the 15th, 07:30Z, with nothing between.
    eq(fired(22, '02:30', '2027-03-14T06:00', '2027-03-15T09:00').join(' '), '2027-03-14T08:00 2027-03-15T07:30');
  });

  t('fall back night: the repeated 01:30 fires once, the first time round', () => {
    // CDT until 02:00 CDT, 07:00Z, then CST: 01:30 CDT is 06:30Z, 01:30 CST 07:30Z.
    eq(fired(1, '00:30', '2026-11-01T05:00', '2026-11-01T10:00').join(' '), '2026-11-01T05:30 2026-11-01T06:30 2026-11-01T08:30 2026-11-01T09:30');
  });
} finally {
  if (homeTZ === undefined) delete process.env.TZ;
  else process.env.TZ = homeTZ;
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
