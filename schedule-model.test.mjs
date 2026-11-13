#!/usr/bin/env node
// A MODEL PER SCHEDULE ENTRY (schedule.mjs --model). Without it a scheduled
// routine job always ran on the pool model, so a cheap periodic job could not
// be put on a cheaper model.
//
//   1. the CLI (schedule.mjs, a real process on a copy in a temp dir, so the
//      live schedules.json is never opened): add, update, list, the refusals;
//   2. the alias list is the drain's own (the drain reads `model` through an
//      allow list, and a model it does not know runs on the pool model).
//
// The run path (a due entry's job starts on its model, directly or through the
// drop box) is in bg-concurrency-wiring.test.mjs, against the REAL
// checkSchedules, queueScheduledRun and drain. The wall park and resume keep it:
// wall-guard-wiring.test.mjs and codex-held-jobs.test.mjs.
//
//   node schedule-model.test.mjs

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(path.join(tmpdir(), 'schedule-model-'));
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
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const CLEAN_ENV = { ...process.env };
for (const k of ['LEASH_LANE', 'LEASH_TRIGGER', 'LEASH_SCHEDULE_ID', 'LEASH_ALLOW_WRITE', 'TMUX']) delete CLEAN_ENV[k];
const run = (...args) => {
  const r = spawnSync(process.execPath, [path.join(WORK, 'schedule.mjs'), ...args], { encoding: 'utf8', env: CLEAN_ENV });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const seed = (items) => writeFileSync(STORE, JSON.stringify({ nextId: Math.max(0, ...items.map((i) => i.id)), items }, null, 2));
const read = () => JSON.parse(readFileSync(STORE, 'utf8'));
const byId = (id) => read().items.find((s) => s.id === id);
const sum = () => readFileSync(STORE, 'utf8');

// ---------------------------------------------------------------------------
console.log('1. add');
// ---------------------------------------------------------------------------

t('★ add daily ... --run --model sonnet stores the model and says it', () => {
  seed([]);
  const r = run('add', 'daily', '03:00', '--run', '--model', 'sonnet', 'nightly memory sync');
  eq(r.code, 0, r.err);
  const [item] = read().items;
  eq(item.model, 'sonnet');
  eq(item.run, true);
  eq(item.text, 'nightly memory sync', 'the flag value never reaches the text');
  ok(/run \(model sonnet\)/.test(r.out), r.out);
});

t('each alias, in any case, is stored lower case', () => {
  for (const [typed, stored] of [['sonnet', 'sonnet'], ['OPUS', 'opus'], ['Haiku', 'haiku']]) {
    seed([]);
    const r = run('add', 'daily', '03:00', '--run', '--model', typed, 'job');
    eq(r.code, 0, r.err);
    eq(read().items[0].model, stored);
  }
});

t('★ without the flag the entry has no model key at all: exactly as before', () => {
  seed([]);
  eq(run('add', 'daily', '03:00', '--run', 'job').code, 0);
  eq('model' in read().items[0], false);
});

for (const [name, args] of [
  ['an unknown alias', ['--run', '--model', 'nonsense']],
  ['fable (its fallback is the lane decision, as bg.mjs refuses it)', ['--run', '--model', 'fable']],
  ['a full model id', ['--run', '--model', 'claude-sonnet-5-5']],
  ['a missing value', ['--run', '--model']],
  ['the next flag eaten as the value', ['--model', '--run']],
  ['a reminder (no --run): only a run has a model', ['--model', 'sonnet']],
]) {
  t(`refused: ${name}; nonzero, nothing added`, () => {
    seed([{ id: 1, kind: 'daily', at: '08:00', text: 'already there' }]);
    const before = sum();
    const r = run('add', 'daily', '03:00', ...args, 'job');
    ok(r.code !== 0, `it must refuse: ${r.out}`);
    eq(sum(), before, 'the store moved');
  });
}

// ---------------------------------------------------------------------------
console.log('\n2. update');
// ---------------------------------------------------------------------------

const RUN = (id, extra = {}) => ({ id, kind: 'daily', at: '03:00', run: true, text: `job ${id}`, lastFired: '2026-11-12', ...extra });

t('★ update <id> --model sonnet sets it; --model opus changes it', () => {
  seed([RUN(8)]);
  let r = run('update', '8', '--model', 'sonnet');
  eq(r.code, 0, r.err);
  eq(byId(8).model, 'sonnet');
  ok(/model sonnet/.test(r.out), r.out);
  r = run('update', '8', '--model', 'opus');
  eq(r.code, 0, r.err);
  eq(byId(8).model, 'opus');
});

t('★ update <id> --model none (or default) takes it off: the pool model again', () => {
  for (const off of ['none', 'default']) {
    seed([RUN(8, { model: 'sonnet' })]);
    const r = run('update', '8', '--model', off);
    eq(r.code, 0, r.err);
    eq('model' in byId(8), false, off);
  }
});

t('update keeps every other field: the time, the cadence, the write approval, the last fire', () => {
  seed([RUN(23, { every: 2, allowWrite: true, claudeOnly: true })]);
  eq(run('update', '23', '--model', 'sonnet').code, 0);
  const s = byId(23);
  eq([s.at, s.every, s.allowWrite, s.claudeOnly, s.lastFired, s.model], ['03:00', 2, true, true, '2026-11-12', 'sonnet']);
});

t('★ --run false takes the model off with the run (a reminder has no model), as it takes the write approval', () => {
  seed([RUN(8, { model: 'sonnet' })]);
  eq(run('update', '8', '--run', 'false').code, 0);
  eq('model' in byId(8), false);
});

for (const [name, seedItem, args] of [
  ['a reminder', { id: 5, kind: 'daily', at: '08:00', text: 'remind me' }, ['--model', 'sonnet']],
  ['an unknown alias', RUN(5), ['--model', 'gpt-9']],
  ['a missing value', RUN(5), ['--model']],
  ['a script entry', { id: 5, kind: 'hours', every: 2, at: '00:05', text: 'sweep', script: '/bin/true' }, ['--model', 'sonnet']],
]) {
  t(`update refused: ${name}; nonzero, the store unchanged`, () => {
    seed([seedItem]);
    const before = sum();
    const r = run('update', '5', ...args);
    ok(r.code !== 0, `it must refuse: ${r.out}`);
    eq(sum(), before);
  });
}

// ---------------------------------------------------------------------------
console.log('\n3. list');
// ---------------------------------------------------------------------------

t('★ list shows the model beside the other run notes, and nothing for an entry without one', () => {
  seed([RUN(8, { model: 'sonnet' }), RUN(9, { model: 'haiku', allowWrite: true }), RUN(10)]);
  const lines = run('list').out.split('\n');
  ok(/^#8 · .* · run \(model sonnet\) · job 8$/.test(lines[0]), lines[0]);
  ok(/^#9 · .* · run \(writes approved, model haiku\) · job 9$/.test(lines[1]), lines[1]);
  ok(/^#10 · .* · run · job 10$/.test(lines[2]), lines[2]);
});

t('a model the CLI would refuse, written by hand, is not shown as one (the daemon ignores it too)', () => {
  seed([RUN(8, { model: 'gpt-9' })]);
  ok(/ · run · job 8$/.test(run('list').out), run('list').out);
});

// ---------------------------------------------------------------------------
console.log('\n4. one alias list');
// ---------------------------------------------------------------------------

t('★ the CLI accepts exactly the aliases the drain and bg.mjs accept', () => {
  const src = readFileSync(path.join(DIR, 'schedule.mjs'), 'utf8');
  const cli = /const SCHEDULE_MODELS = \[([^\]]+)\]/.exec(src)?.[1]?.match(/[a-z]+/g)?.sort()?.join('|');
  const bg = /const JOB_MODELS = \[([^\]]+)\]/.exec(readFileSync(path.join(DIR, 'bg.mjs'), 'utf8'))[1].match(/[a-z]+/g).sort().join('|');
  const drain = /\/\^\(\?:([a-z|]+)\)\$\/\.test\(String\(it\?\.model/.exec(readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8'))[1].split('|').sort().join('|');
  eq(cli, bg);
  eq(cli, drain);
  // And the daemon's own reads of an entry's model (queueScheduledRun, checkSchedules).
  const sched = [...readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').matchAll(/\/\^\(\?:([a-z|]+)\)\$\/\.test\(String\(s\.model/g)].map((m) => m[1].split('|').sort().join('|'));
  eq(sched.length, 2, 'the two places the daemon reads an entry\'s model');
  for (const l of sched) eq(l, cli);
});

t('the usage header documents --model', () => {
  const r = run('help');
  ok(/--model sonnet\|opus\|haiku/.test(r.out), r.out.slice(0, 400));
});

rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
