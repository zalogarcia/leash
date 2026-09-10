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

import { addDays, daysBetween, describeWhen, everyDays, isDailyDue, nextDaily } from './schedule-due.mjs';

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

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
