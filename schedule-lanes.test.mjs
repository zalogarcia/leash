#!/usr/bin/env node
// schedule.mjs and the lane it runs in: a lane that is not the chat lane may
// not grant a write approval, and a job sent from another machine
// (LEASH_LANE=link) adds, changes and removes no schedule here.
//
// Same trick as schedule-cli.test.mjs: the CLI runs as a real process on a
// copy in a temp dir, so the live store is never opened. The child gets a
// clean env (PATH and HOME only), so a lane the suite itself runs in never
// leaks into the case.
//
// The guard also reads the env of every Claude session ABOVE the process, and
// a Claude session in a tmux pane exempts everything under it (the user's own
// pane). So a child spawned straight from this suite would pass or fail by
// whoever started the suite: run from a Claude session inside tmux, the link
// cases would not be refused. Each child is therefore started DETACHED: a
// first helper starts a second one and exits, the second waits until it has
// been adopted by the init process, then runs schedule.mjs. Nothing of the
// suite's own ancestry is above the CLI any more.
//
//   node schedule-lanes.test.mjs

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(path.join(tmpdir(), 'schedule-lanes-'));
for (const f of ['schedule.mjs', 'schedule-due.mjs']) copyFileSync(path.join(DIR, f), path.join(WORK, f));
const STORE = path.join(WORK, 'schedules.json');

// The detach helper. Stage 1 starts stage 2 detached and exits at once; stage
// 2 waits until its parent is no longer stage 1 (it was adopted), then runs
// the CLI and writes { code, out } to the result file, by rename so a reader
// never sees half of it.
const HELPER = path.join(WORK, 'detach-run.mjs');
writeFileSync(
  HELPER,
  `import { spawn, spawnSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
const [result, cli, ...args] = process.argv.slice(2);
if (process.env.DETACH_STAGE !== '2') {
  const c = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', env: { ...process.env, DETACH_STAGE: '2', DETACH_FROM: String(process.pid) } });
  c.unref();
  process.exit(0);
}
const from = Number(process.env.DETACH_FROM);
const until = Date.now() + 10000;
const nap = new Int32Array(new SharedArrayBuffer(4));
while (process.ppid === from && Date.now() < until) Atomics.wait(nap, 0, 0, 10);
const env = { ...process.env };
delete env.DETACH_STAGE;
delete env.DETACH_FROM;
const r = spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
writeFileSync(result + '.part', JSON.stringify({ code: r.status, out: (r.stdout || '') + (r.stderr || ''), adopted: process.ppid !== from }));
renameSync(result + '.part', result);
`,
);

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
let runs = 0;
const nap = new Int32Array(new SharedArrayBuffer(4));
const run = (env, ...args) => {
  const result = path.join(WORK, `result-${++runs}.json`);
  const s = spawnSync(process.execPath, [HELPER, result, path.join(WORK, 'schedule.mjs'), ...args], { cwd: WORK, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  if (s.status !== 0) throw new Error(`the detach helper failed: ${s.status} ${s.stderr}`);
  const until = Date.now() + 20000;
  while (!existsSync(result) && Date.now() < until) Atomics.wait(nap, 0, 0, 20);
  if (!existsSync(result)) throw new Error('the detached CLI run wrote no result in 20 s');
  const r = JSON.parse(readFileSync(result, 'utf8'));
  if (!r.adopted) throw new Error('the CLI ran before its helper was adopted, so the suite was still above it');
  return r;
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
