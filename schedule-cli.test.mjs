#!/usr/bin/env node
// Tests for the schedule CLI, run as a REAL process against a REAL store.
//
// schedule.mjs writes schedules.json next to itself, so the whole suite runs on
// a copy in a temp dir (the same trick bg-notify.test.mjs uses for bg.mjs) and
// the live store is never opened. That is the only honest way to test this
// file: its risky half is not a pure function but what it PERSISTS, and the
// four bugs this suite locks down were all "exit 0, wrote the wrong thing".
//
//   node schedule-cli.test.mjs

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(path.join(tmpdir(), 'schedule-cli-'));
for (const f of ['schedule.mjs', 'schedule-due.mjs']) copyFileSync(path.join(DIR, f), path.join(WORK, f));
const STORE = path.join(WORK, 'schedules.json');

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

const seed = (items) => writeFileSync(STORE, JSON.stringify({ nextId: items.length, items }, null, 2));
const read = () => JSON.parse(readFileSync(STORE, 'utf8'));
const run = (...args) => {
  const r = spawnSync(process.execPath, [path.join(WORK, 'schedule.mjs'), ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
console.log('\n1. add');

t('add every writes a daily carrying the cadence, not a new kind', () => {
  seed([]);
  const r = run('add', 'every', '3d', '12:00', '--run', 'BU ads check');
  eq(r.code, 0, r.err);
  const item = read().items[0];
  eq(item.kind, 'daily', 'the kind must stay daily so every existing reader keeps working');
  eq(item.every, 3);
  eq(item.at, '12:00');
  eq(item.text, 'BU ads check');
  eq(item.run, true);
  ok(r.out.includes('every 3d 12:00'), r.out);
  ok(/\(next \d{4}-\d{2}-\d{2}\)/.test(r.out) || !item.lastFired, r.out);
});

t('★ text after a bare --run survives (it used to be swallowed)', () => {
  // Every flag used to own the token after it, so this exact form died with
  // "missing text" while looking like a perfectly good command.
  seed([]);
  const r = run('add', 'daily', '08:00', '--run', 'morning check');
  eq(r.code, 0, r.err);
  eq(read().items[0].text, 'morning check');
  eq(read().items[0].run, true);
});

t('a new item never fires at creation: past time means lastFired is today', () => {
  seed([]);
  run('add', 'daily', '00:00', 'x');
  eq(read().items[0].lastFired, today(), 'a time already past today must not fire immediately');
});

t('add every rejects a cadence outside 2 to 365, and writes nothing', () => {
  for (const n of ['1d', '0d', '366d', 'xd']) {
    seed([]);
    const r = run('add', 'every', n, '12:00', 'x');
    ok(r.code !== 0, `every ${n} was accepted`);
    eq(read().items.length, 0, `every ${n} wrote to the store anyway`);
  }
});

t('add every still needs a time and a text', () => {
  seed([]);
  ok(run('add', 'every', '3d', 'nope', 'x').code !== 0);
  ok(run('add', 'every', '3d', '12:00').code !== 0);
  eq(read().items.length, 0);
});

t('the other three forms still work', () => {
  seed([]);
  eq(run('add', 'daily', '08:00', 'a').code, 0);
  eq(run('add', 'once', '2099-01-01', '09:30', 'b').code, 0);
  eq(run('add', 'in', '90m', 'c').code, 0);
  eq(read().items.length, 3);
  eq(read().items[1].kind, 'once');
});

// ---------------------------------------------------------------------------
console.log('\n2. update: the cadence and its anchor');

const CADENCE = { id: 1, kind: 'daily', every: 3, at: '12:00', lastFired: '2026-09-10', text: 'ads', run: true };
const PLAIN = { id: 1, kind: 'daily', at: '12:00', lastFired: '2026-09-01', text: 'ads' };

t('--every N turns a daily into a cadence item, --every 1 turns it back', () => {
  seed([{ ...PLAIN }]);
  eq(run('update', '1', '--every', '3').code, 0);
  eq(read().items[0].every, 3);
  eq(run('update', '1', '--every', '1').code, 0);
  ok(!('every' in read().items[0]), 'every 1 must remove the field, not store a 1');
});

t('--anchor sets the last fire, so the next one is anchor plus N', () => {
  seed([{ ...CADENCE, lastFired: undefined }]);
  const r = run('update', '1', '--anchor', '2026-09-10');
  eq(r.code, 0, r.err);
  eq(read().items[0].lastFired, '2026-09-10');
  ok(r.out.includes('(next 2026-09-13)'), r.out);
});

t('--every and --anchor in one call is the conversion, and it works', () => {
  seed([{ ...PLAIN }]);
  const r = run('update', '1', '--every', '3', '--anchor', '2026-09-10');
  eq(r.code, 0, r.err);
  eq(read().items[0].every, 3);
  eq(read().items[0].lastFired, '2026-09-10');
  ok(r.out.includes('every 3d 12:00 (next 2026-09-13)'), r.out);
});

t('★ --at keeps a cadence item\'s anchor', () => {
  // lastFired on a cadence item is the PHASE, not a "fired today" latch.
  // Clearing it on a time change fired the schedule up to N-1 days early.
  seed([{ ...CADENCE }]);
  eq(run('update', '1', '--at', '23:59').code, 0);
  eq(read().items[0].at, '23:59');
  eq(read().items[0].lastFired, '2026-09-10', 'the anchor was destroyed by a time change');
});

t('--at on a plain daily still re-latches exactly as it did before', () => {
  seed([{ ...PLAIN }]);
  eq(run('update', '1', '--at', '00:00').code, 0);
  eq(read().items[0].lastFired, today());
});

t('★ --anchor on a plain daily is refused rather than silently ignored', () => {
  // A daily fires every day whatever lastFired says, so accepting an anchor
  // there reported success for something that could never take effect.
  seed([{ ...PLAIN }]);
  const r = run('update', '1', '--anchor', '2026-12-25');
  ok(r.code !== 0, 'accepted an anchor that can never take effect');
  eq(read().items[0].lastFired, '2026-09-01', 'and it wrote it anyway');
});

t('★ a date that only looks real is refused', () => {
  // new Date("2026-02-30") does not throw, it quietly becomes March 2nd.
  seed([{ ...CADENCE }]);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-9-10', '20260910', 'tomorrow']) {
    const r = run('update', '1', '--anchor', bad);
    ok(r.code !== 0, `${bad} was accepted`);
  }
  eq(read().items[0].lastFired, '2026-09-10', 'the anchor moved anyway');
});

t('★ a flag with no value is a usage error, not a silent no-op', () => {
  seed([{ ...CADENCE }]);
  ok(run('update', '1', '--every').code !== 0, '--every with nothing after it reported success');
  ok(run('update', '1', '--anchor').code !== 0, '--anchor with nothing after it reported success');
  eq(read().items[0].every, 3);
  eq(read().items[0].lastFired, '2026-09-10');
});

t('--every and --anchor are refused on a one-off, and the store is untouched', () => {
  const once = { id: 1, kind: 'once', at: 4102444800000, text: 'x' };
  seed([{ ...once }]);
  ok(run('update', '1', '--every', '3').code !== 0);
  ok(run('update', '1', '--anchor', '2026-09-10').code !== 0);
  eq(JSON.stringify(read().items[0]), JSON.stringify(once));
});

t('--text and --run still work alongside the new flags', () => {
  seed([{ ...CADENCE }]);
  eq(run('update', '1', '--text', 'new words', '--run', 'false').code, 0);
  eq(read().items[0].text, 'new words');
  ok(!('run' in read().items[0]));
  eq(read().items[0].every, 3, 'an unrelated update must not drop the cadence');
});

// ---------------------------------------------------------------------------
console.log('\n3. list and remove');

t('list labels each shape, and only a cadence item carries a next date', () => {
  seed([
    { id: 1, kind: 'daily', at: '08:00', text: 'a' },
    { id: 2, kind: 'daily', every: 3, at: '12:00', lastFired: '2026-09-10', text: 'b' },
  ]);
  const lines = run('list').out.split('\n');
  ok(lines[0].includes('daily 08:00') && !lines[0].includes('next'), lines[0]);
  ok(lines[1].includes('every 3d 12:00 (next 2026-09-13)'), lines[1]);
});

t('remove takes the item out, and an unknown id is an error', () => {
  seed([{ id: 1, kind: 'daily', at: '08:00', text: 'a' }]);
  eq(run('remove', '1').code, 0);
  eq(read().items.length, 0);
  ok(run('remove', '99').code !== 0);
});

t('the usage text names the new forms', () => {
  const out = run('help').out;
  for (const form of ['add every 3d', '--every N', '--anchor YYYY-MM-DD']) ok(out.includes(form), `usage is missing ${form}`);
});

// ---------------------------------------------------------------------------
rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
