#!/usr/bin/env node
// schedule.mjs and the lane it runs in: a lane that is not the chat lane may
// not grant a write approval, and a job sent from another machine
// (LEASH_LANE=link) adds, changes and removes no schedule here.
//
// Same trick as schedule-cli.test.mjs: the CLI runs as a real process on a
// copy in a temp dir, so the live store is never opened. The child gets a
// clean env (PATH and HOME only), so a lane the suite itself runs in never
// leaks into the case. One limit, by design of the guard: run from the
// user's own tmux pane, the pane exemption applies and the link cases pass
// the guard, so run this suite outside tmux.
//
//   node schedule-lanes.test.mjs

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(path.join(tmpdir(), 'schedule-lanes-'));
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

const seed = (items) => writeFileSync(STORE, JSON.stringify({ nextId: items.length, items }, null, 2));
const read = () => JSON.parse(readFileSync(STORE, 'utf8'));
const run = (env, ...args) => {
  const r = spawnSync(process.execPath, [path.join(WORK, 'schedule.mjs'), ...args], { cwd: WORK, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const ONE = [{ id: 1, kind: 'daily', at: '03:00', text: 'nightly' }];

t('a link lane add is refused with exit 5 and nothing is written', () => {
  seed([]);
  const r = run({ LEASH_LANE: 'link' }, 'add', 'in', '90m', 'from another machine');
  eq(r.code, 5, r.out);
  eq(read().items.length, 0, 'nothing may be stored');
});
t('a link lane update is refused and the entry is unchanged', () => {
  seed(ONE);
  const r = run({ LEASH_LANE: 'link' }, 'update', '1', '--text', 'changed');
  eq(r.code, 5, r.out);
  eq(read().items[0].text, 'nightly');
});
t('a link lane remove is refused and the entry stays', () => {
  seed(ONE);
  const r = run({ LEASH_LANE: 'link' }, 'remove', '1');
  eq(r.code, 5, r.out);
  eq(read().items.length, 1);
});
t('--allow-write is refused in any lane but chat, nothing written', () => {
  seed([]);
  const r = run({ LEASH_LANE: 'other' }, 'add', 'in', '1m', '--run', '--allow-write', 'held write');
  eq(r.code, 1, r.out);
  eq(read().items.length, 0, 'nothing may be stored');
});
t('outside a link lane add still works (no lane, then the chat lane)', () => {
  seed([]);
  eq(run({}, 'add', 'in', '90m', 'plain').code, 0, 'no lane');
  eq(run({ LEASH_LANE: 'chat' }, 'add', 'in', '90m', '--run', '--allow-write', 'approved').code, 0, 'chat lane');
  eq(read().items.length, 2);
});

rmSync(WORK, { recursive: true, force: true });
console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
