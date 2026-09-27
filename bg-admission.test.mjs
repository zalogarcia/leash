#!/usr/bin/env node
// Unit tests for the background concurrency cap's pure half.
//
// The two failure shapes this module exists to prevent are opposites, so both
// get cases: a cap that lets the fourth worker start anyway (the 2026-09-21
// wall), and a cap that DROPS the fourth job instead of queueing it (which
// would break the documented "hand off as many as you like" promise silently,
// mid day). FIFO gets its own cases because an admission queue that reorders
// is just a random scheduler with extra steps.
//
//   node bg-admission.test.mjs

import {
  DEFAULT_MAX_CONCURRENT_WORKERS,
  hasSlot,
  maxConcurrentWorkers,
  mergeRequeue,
  queueRows,
  queuedBlock,
} from './bg-admission.mjs';

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

// ---------------------------------------------------------------------------
console.log('\n1. the configured cap');
// ---------------------------------------------------------------------------

t('the default is 3, one below the four-worker configuration that walled every account', () => {
  eq(DEFAULT_MAX_CONCURRENT_WORKERS, 3);
  eq(maxConcurrentWorkers(undefined), 3);
  eq(maxConcurrentWorkers(null), 3);
  eq(maxConcurrentWorkers(''), 3);
});

t('a configured number wins, including a string from an env var', () => {
  eq(maxConcurrentWorkers(5), 5);
  eq(maxConcurrentWorkers('2'), 2);
  eq(maxConcurrentWorkers(1), 1);
});

t('★ a typo falls back to the default, never to Infinity', () => {
  // The guard must not be removable by accident: "maxConcurrentWorkers": "three"
  // has to keep capping, or the one person trying to tune it is the one who
  // turns it off.
  eq(maxConcurrentWorkers('three'), 3);
  eq(maxConcurrentWorkers(NaN), 3);
  eq(maxConcurrentWorkers({}), 3);
});

t('★ the floor is 1: "serialize everything" is a setting, "start nothing" is a hang', () => {
  eq(maxConcurrentWorkers(0), 1);
  eq(maxConcurrentWorkers(-4), 1);
});

t('a fractional cap floors rather than admitting half a worker', () => {
  eq(maxConcurrentWorkers(3.9), 3);
});

// ---------------------------------------------------------------------------
console.log('\n2. the admission decision');
// ---------------------------------------------------------------------------

t('under the cap a job starts', () => {
  eq(hasSlot({ running: 0, max: 3 }), true);
  eq(hasSlot({ running: 2, max: 3 }), true);
});

t('★ AT the cap a job does not start (this is the whole incident)', () => {
  eq(hasSlot({ running: 3, max: 3 }), false);
  eq(hasSlot({ running: 4, max: 3 }), false, 'over the cap, e.g. after a bypass, still refuses');
});

t('★ a Codex job is never capped: it is billed separately and it is the fallback', () => {
  eq(hasSlot({ running: 9, max: 3, engine: 'codex' }), true);
});

t('★ the bypass is explicit only, and it is the only thing that lifts the cap', () => {
  eq(hasSlot({ running: 3, max: 3, bypass: true }), true);
  eq(hasSlot({ running: 3, max: 3, bypass: false }), false);
  eq(hasSlot({ running: 3, max: 3 }), false, 'absent must mean off, never on');
});

t('the defaults alone still cap', () => {
  eq(hasSlot({ running: 3 }), false);
  eq(hasSlot(), true);
});

// ---------------------------------------------------------------------------
console.log('\n3. FIFO on the way back into the drop box');
// ---------------------------------------------------------------------------

t('★ deferred jobs go in FRONT of anything that arrived while they waited', () => {
  const merged = mergeRequeue([{ text: 'A' }, { text: 'B' }], [{ text: 'C' }]);
  eq(merged.map((m) => m.text).join(''), 'ABC');
});

t('the relative order of the deferred jobs is preserved', () => {
  const merged = mergeRequeue([{ text: '1' }, { text: '2' }, { text: '3' }], []);
  eq(merged.map((m) => m.text).join(''), '123');
});

t('a missing or corrupt drop box is treated as empty, never as a reason to drop a brief', () => {
  eq(mergeRequeue([{ text: 'A' }], null).length, 1);
  eq(mergeRequeue([{ text: 'A' }], undefined).length, 1);
  eq(mergeRequeue(null, [{ text: 'C' }]).length, 1);
  eq(mergeRequeue(null, null).length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n4. positions, as ps and the dispatch ack report them');
// ---------------------------------------------------------------------------

const four = [
  { title: 'job one', engine: 'claude', queuedAt: '1' },
  { title: 'job two', engine: 'claude', queuedAt: '2' },
  { title: 'job three', engine: 'claude', queuedAt: '3' },
  { title: 'job four', engine: 'claude', queuedAt: '4' },
];

t('★ with nothing running, the first three start and only the fourth waits', () => {
  const rows = queueRows(four, { running: 0, max: 3 });
  eq(rows.map((r) => r.waiting).join(','), 'false,false,false,true');
  eq(rows[3].position, 4);
  eq(rows[3].waitPosition, 1, 'it is the FIRST job waiting, even though it is the fourth line');
});

t('★ with the cap already full, every one of them waits, in order', () => {
  const rows = queueRows(four, { running: 3, max: 3 });
  eq(rows.every((r) => r.waiting), true);
  eq(rows.map((r) => r.waitPosition).join(','), '1,2,3,4');
});

t('waitPosition is 0 for a job that is not waiting, so it cannot be printed as a position', () => {
  const rows = queueRows(four, { running: 0, max: 3 });
  eq(rows[0].waitPosition, 0);
});

t('★ a Codex job never waits and never consumes a Claude slot', () => {
  const rows = queueRows(
    [
      { title: 'codex one', engine: 'codex' },
      { title: 'claude one', engine: 'claude' },
      { title: 'claude two', engine: 'claude' },
    ],
    { running: 2, max: 3 },
  );
  eq(rows[0].waiting, false, 'Codex is not capped');
  eq(rows[1].waiting, false, 'one slot was free and Codex did not take it');
  eq(rows[2].waiting, true);
});

t('★ a bypass job runs now AND pushes the jobs behind it back', () => {
  // It takes a real worker. Reporting otherwise would advertise a queue shorter
  // than the one the daemon is about to run.
  const rows = queueRows(
    [
      { title: 'urgent', engine: 'claude', bypass: true },
      { title: 'normal', engine: 'claude' },
    ],
    { running: 3, max: 3 },
  );
  eq(rows[0].waiting, false);
  eq(rows[1].waiting, true);
});

t('an unknown engine is treated as claude, which is the capped side', () => {
  const rows = queueRows([{ title: 'x', engine: undefined }], { running: 3, max: 3 });
  eq(rows[0].engine, 'claude');
  eq(rows[0].waiting, true);
});

t('an empty drop box produces no rows', () => {
  eq(queueRows([], { running: 0, max: 3 }).length, 0);
  eq(queueRows(null).length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n5. the QUEUED block, which is what makes the queue visible');
// ---------------------------------------------------------------------------

t('an empty queue renders nothing at all, so ps is unchanged when nothing waits', () => {
  eq(queuedBlock([], { running: 1, max: 3 }), '');
  eq(queuedBlock(null), '');
});

t('★ the block names the count, the wait and the cap', () => {
  const rows = queueRows(four, { running: 3, max: 3 });
  const block = queuedBlock(rows, { running: 3, max: 3 });
  ok(block.includes('QUEUED (4 in the drop box'), block);
  ok(block.includes('4 waiting for a slot'), block);
  ok(block.includes('3 of 3 workers busy'), block);
});

t('★ every queued job is listed with its position and its title', () => {
  const rows = queueRows(four, { running: 3, max: 3 });
  const block = queuedBlock(rows, { running: 3, max: 3 });
  for (const j of ['job one', 'job two', 'job three', 'job four']) ok(block.includes(j), `${j} missing:\n${block}`);
  ok(/^\s+1\s+yes \(1\)\s+claude\s+job one$/m.test(block), block);
});

t('a long title is clipped rather than wrapping the table', () => {
  const rows = queueRows([{ title: 'x'.repeat(200), engine: 'claude' }], { running: 3, max: 3 });
  const block = queuedBlock(rows, { running: 3, max: 3 });
  ok(!block.split('\n').some((l) => l.length > 120), block.split('\n').map((l) => l.length).join(','));
});

t('★ no dashes in anything this module renders', () => {
  const rows = queueRows(four, { running: 3, max: 3 });
  const block = queuedBlock(rows, { running: 3, max: 3 });
  // Escapes, not the literal characters: this assertion is the repo's own dash
  // ban, and written literally the test file itself trips `dash-check.sh`.
  ok(!/[\u2013\u2014]/.test(block), block);
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
