#!/usr/bin/env node
// Tests for worker-env.mjs: the environment a spawned Claude child is given.
//
// Hooks in ~/.claude read these names and nothing else, so the property held
// here is exact: which lane gets which key, and that no key leaks onto a lane
// that must not carry it. A key that silently goes missing turns the hook off
// with no other symptom; a key that leaks onto the chat lane makes a hook treat
// the owner's own conversation as an unattended run.
//
//   node worker-env.test.mjs

import { WORKER_ENV_KEYS, scrubWorkerEnv, workerEnv } from './worker-env.mjs';

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

const BASE = { PATH: '/usr/bin', HOME: '/Users/x' };
const DRAFT = '/abs/bg-reports/bg2-1790000000000.draft.md';
const STARTED = 1790000000000;
const SCHED = ['LEASH_TRIGGER', 'LEASH_SCHEDULE_ID', 'LEASH_ALLOW_WRITE'];

// ---------------------------------------------------------------------------
console.log('\n1. the contract names, exactly');

t('the key list is the contract the ~/.claude hooks read, name for name', () => {
  eq(
    [...WORKER_ENV_KEYS].sort().join(','),
    ['BG_REPORT_DRAFT', 'BG_RUN_STARTED_AT', 'LEASH_ALLOW_WRITE', 'LEASH_LANE', 'LEASH_SCHEDULE_ID', 'LEASH_TRIGGER'].join(','),
    'a renamed key disables the hook that reads it, silently',
  );
});

// ---------------------------------------------------------------------------
console.log('\n2. a bg.mjs handoff: a background worker the owner asked for');

t('a background worker gets the lane, the draft path and its start time', () => {
  const env = workerEnv(BASE, { lane: 'bg', draftPath: DRAFT, startedAt: STARTED });
  eq(env.LEASH_LANE, 'bg');
  eq(env.BG_REPORT_DRAFT, DRAFT);
  eq(env.BG_RUN_STARTED_AT, '1790000000000', 'epoch milliseconds as a decimal string');
  eq(env.PATH, '/usr/bin', 'the rest of the env is inherited');
});

t('★ a handoff is NOT marked as a scheduled run', () => {
  const env = workerEnv(BASE, { lane: 'bg', draftPath: DRAFT, startedAt: STARTED });
  for (const k of SCHED) ok(!(k in env), `${k} on a worker the owner asked for`);
});

t('the base env is never mutated', () => {
  const base = { ...BASE, LEASH_TRIGGER: 'schedule' };
  workerEnv(base, { lane: 'bg', draftPath: DRAFT, startedAt: STARTED });
  eq(base.LEASH_TRIGGER, 'schedule');
  ok(!('BG_REPORT_DRAFT' in base), 'the daemon env grew a worker key');
});

// ---------------------------------------------------------------------------
console.log('\n3. a scheduled run: a schedules.json entry with run: true');

t('★ a scheduled run carries the trigger and the entry id', () => {
  const env = workerEnv(BASE, { lane: 'bg', draftPath: DRAFT, startedAt: STARTED, schedule: { id: 23, allowWrite: false } });
  eq(env.LEASH_TRIGGER, 'schedule');
  eq(env.LEASH_SCHEDULE_ID, '23');
  ok(!('LEASH_ALLOW_WRITE' in env), 'no owner approval on the entry, so none in the env');
  eq(env.BG_REPORT_DRAFT, DRAFT, 'a scheduled worker keeps a draft like any other');
});

t('★ allowWrite true on the entry is the ONLY way to LEASH_ALLOW_WRITE=1', () => {
  eq(workerEnv(BASE, { lane: 'bg', schedule: { id: 8, allowWrite: true } }).LEASH_ALLOW_WRITE, '1');
  for (const v of ['true', 1, 'yes', {}, null, undefined]) {
    ok(!('LEASH_ALLOW_WRITE' in workerEnv(BASE, { lane: 'bg', schedule: { id: 8, allowWrite: v } })), `allowWrite ${JSON.stringify(v)} was read as approval`);
  }
});

t('a schedule with no id marks nothing', () => {
  for (const schedule of [{}, { id: null }, { id: '' }, { allowWrite: true }]) {
    const env = workerEnv(BASE, { lane: 'bg', schedule });
    for (const k of SCHED) ok(!(k in env), `${k} set from ${JSON.stringify(schedule)}`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n4. the chat lane gets none of it');

t('★ the chat lane gets its lane and nothing else, even when handed a draft or a schedule', () => {
  const env = workerEnv(BASE, { lane: 'chat', draftPath: DRAFT, startedAt: STARTED, schedule: { id: 3, allowWrite: true } });
  eq(env.LEASH_LANE, 'chat');
  for (const k of ['BG_REPORT_DRAFT', 'BG_RUN_STARTED_AT', ...SCHED]) ok(!(k in env), `${k} leaked onto the chat lane`);
});

t('★ an inherited value is scrubbed, not passed through', () => {
  // The daemon launched from inside a worker shell (a --selftest, a manual
  // start) would otherwise hand that worker's draft and trigger to every chat
  // turn it ran.
  const dirty = { ...BASE, BG_REPORT_DRAFT: '/old.draft.md', BG_RUN_STARTED_AT: '1', LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '9', LEASH_ALLOW_WRITE: '1', LEASH_LANE: 'bg' };
  const chat = workerEnv(dirty, { lane: 'chat' });
  eq(chat.LEASH_LANE, 'chat');
  for (const k of ['BG_REPORT_DRAFT', 'BG_RUN_STARTED_AT', ...SCHED]) ok(!(k in chat), `${k} inherited onto the chat lane`);
  const bg = workerEnv(dirty, { lane: 'bg', draftPath: DRAFT, startedAt: STARTED });
  eq(bg.BG_REPORT_DRAFT, DRAFT, 'the worker gets ITS OWN draft, not the inherited one');
  for (const k of SCHED) ok(!(k in bg), `${k} inherited onto a handoff`);
});

t('no lane (a Codex child) gets every contract key scrubbed', () => {
  const dirty = { ...BASE, BG_REPORT_DRAFT: '/old.draft.md', LEASH_TRIGGER: 'schedule', LEASH_LANE: 'bg' };
  const env = workerEnv(dirty);
  for (const k of WORKER_ENV_KEYS) ok(!(k in env), `${k} survived on a lane-less child`);
  eq(env.HOME, '/Users/x');
});

t('a missing start time is left unset rather than written as NaN', () => {
  const env = workerEnv(BASE, { lane: 'bg', draftPath: DRAFT, startedAt: null });
  ok(!('BG_RUN_STARTED_AT' in env), JSON.stringify(env));
  ok(!('BG_RUN_STARTED_AT' in workerEnv(BASE, { lane: 'bg', startedAt: 'soon' })), 'a non number was written');
});

// ---------------------------------------------------------------------------
console.log('\n5. scrubWorkerEnv, the boot-time half');

t('scrubWorkerEnv deletes every contract key in place and leaves the rest', () => {
  const env = { ...BASE, BG_REPORT_DRAFT: 'x', BG_RUN_STARTED_AT: '1', LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '2', LEASH_ALLOW_WRITE: '1', LEASH_LANE: 'chat' };
  const back = scrubWorkerEnv(env);
  eq(back, env, 'it scrubs the object it was given (process.env at boot)');
  for (const k of WORKER_ENV_KEYS) ok(!(k in env), `${k} survived the scrub`);
  eq(env.PATH, '/usr/bin');
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
