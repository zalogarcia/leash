#!/usr/bin/env node
import { createWriteGrantStore } from './write-grant.mjs';
// Tests for `--repo` / `--cwd` on bg.mjs: the DECLARED working directory.
//
// A Codex job's sandbox write root is its cwd. Before this flag the daemon
// inferred it from the brief's prose, and on 2026-09-16 two jobs resolved to the
// wrong directory: one refused outright after 49k tokens of billed reading
// because it was told to create a worktree that did not exist yet, the other
// created it and had to be steered off. Pinning each parallel Codex job to its
// own existing worktree is what makes N of them on one repo safe.
//
// The validation lives at ENQUEUE so a bad directory costs one line of stderr
// instead of a dispatched job. That is the behaviour these tests hold down.
//
//   node bg-repo-flag.test.mjs
//
// bg.mjs resolves its queue file from its OWN directory, so it is copied into a
// temp dir and run there. HOME is faked too, so a bare repo name resolves under
// a temp `dev/` and the test never depends on this machine's layout. The live
// bg-queue.json is never touched.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), 'bg-repo-flag-'));
const BG = path.join(TMP, 'bg.mjs');
copyFileSync(path.join(DIR, 'bg.mjs'), BG);
const QUEUE = path.join(TMP, 'bg-queue.json');

// A fake HOME with a dev/ tree, so `--repo thing` resolves hermetically. The
// daemon's own workspace settings are cleared so the default (~/dev when it
// exists) is the one under test; a case below sets config.json's defaultCwd.
const HOME = path.join(TMP, 'home');
const REPO_NAME = 'my-repo-worktree-a';
const REPO_DIR = path.join(HOME, 'dev', REPO_NAME);
mkdirSync(REPO_DIR, { recursive: true });

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

/** Run bg.mjs. Returns { code, stderr, items }. Never throws on a nonzero exit. */
function run(args, extraEnv = {}) {
  if (existsSync(QUEUE)) rmSync(QUEUE);
  let code = 0;
  let stderr = '';
  // Hermetic: the scheduled run mark (below) must come from the test, never
  // from whatever run happens to be executing the suite.
  const env = { ...process.env, HOME, BRIDGE_DEFAULT_CWD: '', BRIDGE_CONFIG: path.join(TMP, 'config.json'), ...extraEnv };
  for (const k of ['LEASH_TRIGGER', 'LEASH_SCHEDULE_ID', 'LEASH_ALLOW_WRITE', 'LEASH_WRITE_GRANT', 'TMUX']) if (!(k in extraEnv)) delete env[k];
  try {
    execFileSync(process.execPath, [BG, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status ?? 1;
    stderr = String(e.stderr || '');
  }
  const items = existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, 'utf8')) : null;
  return { code, stderr, items };
}

t('a bare repo name resolves under the workspace (~/dev by default) and lands on the queue item', () => {
  const r = run(['--engine', 'codex', '--repo', REPO_NAME, 'do the thing']);
  eq(r.code, 0, 'exit code');
  eq(r.items.length, 1, 'queued items');
  eq(r.items[0].cwd, REPO_DIR, 'cwd');
});

t('an absolute path is taken as given', () => {
  const r = run(['--engine', 'codex', '--repo', REPO_DIR, 'do the thing']);
  eq(r.code, 0, 'exit code');
  eq(r.items[0].cwd, REPO_DIR, 'cwd');
});

t('a ~/ path is expanded against HOME', () => {
  const r = run(['--engine', 'codex', '--repo', `~/dev/${REPO_NAME}`, 'do the thing']);
  eq(r.code, 0, 'exit code');
  eq(r.items[0].cwd, REPO_DIR, 'cwd');
});

t('--cwd is accepted as the same flag', () => {
  const r = run(['--engine', 'codex', '--cwd', REPO_DIR, 'do the thing']);
  eq(r.code, 0, 'exit code');
  eq(r.items[0].cwd, REPO_DIR, 'cwd');
});

// THE POINT OF THE WHOLE CHANGE: a directory that does not exist is refused
// before anything is dispatched, and the brief is NOT left on the queue.
t('a directory that does not exist is refused and nothing is queued', () => {
  const r = run(['--engine', 'codex', '--repo', 'repo-does-not-exist-yet', 'do the thing']);
  if (r.code === 0) throw new Error('expected a nonzero exit');
  eq(r.items, null, 'queue file');
  if (!r.stderr.includes('not an existing directory')) throw new Error(`stderr did not explain: ${r.stderr}`);
  if (!r.stderr.includes('worktree add')) throw new Error('stderr did not show the worktree recipe');
  if (!r.stderr.includes('Nothing was queued')) throw new Error('stderr did not say nothing was queued');
});

t('a file is not a directory', () => {
  const r = run(['--engine', 'codex', '--repo', BG, 'do the thing']);
  if (r.code === 0) throw new Error('expected a nonzero exit');
  eq(r.items, null, 'queue file');
});

t('a missing value is refused rather than eaten as the brief', () => {
  const r = run(['--engine', 'codex', '--repo']);
  if (r.code === 0) throw new Error('expected a nonzero exit');
  eq(r.items, null, 'queue file');
});

t('the next flag is not swallowed as the value', () => {
  const r = run(['--repo', '--engine', 'codex', 'do the thing']);
  if (r.code === 0) throw new Error('expected a nonzero exit');
  eq(r.items, null, 'queue file');
});

// The flag must not survive into the text the model reads.
t('the flag and its value are stripped from the brief', () => {
  const r = run(['--engine', 'codex', '--repo', REPO_NAME, 'do the thing']);
  eq(r.code, 0, 'exit code');
  const text = r.items[0].text;
  if (text.includes('--repo')) throw new Error(`brief still carries the flag: ${text}`);
  if (text.includes(REPO_NAME)) throw new Error(`brief still carries the value: ${text}`);
  eq(text.trim(), 'do the thing', 'brief');
});

// Back-compat: every existing caller passes no flag and must be unchanged.
t('without the flag there is no cwd field at all', () => {
  const r = run(['--engine', 'codex', 'do the thing']);
  eq(r.code, 0, 'exit code');
  eq('cwd' in r.items[0], false, 'cwd present');
});

t('the flag works on a Claude job too, and the lane rules still prepend', () => {
  const r = run(['--repo', REPO_NAME, 'do the thing']);
  eq(r.code, 0, 'exit code');
  eq(r.items[0].cwd, REPO_DIR, 'cwd');
  if (!r.items[0].text.startsWith('LANE RULES')) throw new Error('lane rules were lost');
});

// QA 2026-09-27 round 1: a SCHEDULED worker that hands work off through bg.mjs
// used to drop the scheduled run mark, so the child ran as an attended worker
// and a hook holding unattended writes let its migration through.
// bg.mjs now copies the mark from its own env onto the item; the drain turns
// scheduleId / allowWrite back into LEASH_TRIGGER / LEASH_ALLOW_WRITE.
t('a handoff from inside a scheduled run carries the schedule mark', () => {
  const r = run(['do the thing'], { LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '42' });
  eq(r.code, 0, 'exit code');
  eq(r.items[0].scheduleId, '42', 'scheduleId');
  eq(r.items[0].allowWrite, undefined, 'allowWrite');
});
t('the write approval NEVER rides along: the run could set its own env (QA 2026-09-27)', () => {
  const r = run(['do the thing'], { LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '42', LEASH_ALLOW_WRITE: '1' });
  eq(r.items[0].scheduleId, '42', 'scheduleId');
  eq(r.items[0].allowWrite, undefined, 'allowWrite');
});
// THE GRANT (write-grant.mjs, self audit 2026-10-13 P8): an approved scheduled
// run is given a token minted for it, and bg.mjs carries THAT, with the flag,
// onto the child. The drain honours it only for the same entry, still approved.
t('★ an approved run with its grant: the child carries allowWrite AND the grant', () => {
  const capability = createWriteGrantStore({ file: path.join(TMP, 'write-grants.json') }).issue(233, 'bg-parent');
  const r = run(['ship it'], { LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '233', LEASH_ALLOW_WRITE: '1', LEASH_WRITE_GRANT: capability });
  eq(r.items[0].scheduleId, '233', 'scheduleId');
  eq(r.items[0].allowWrite, true, 'allowWrite');
  eq(typeof r.items[0].writeGrant.signature, 'string', 'signed child proof');
  eq(JSON.stringify(r.items).includes('PRIVATE KEY'), false, 'private capability never queued');
});
t('a grant without the approval flag, or outside a scheduled run, carries nothing', () => {
  const r = run(['ship it'], { LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '233', LEASH_WRITE_GRANT: 'abc123' });
  eq(r.items[0].allowWrite, undefined, 'allowWrite without the flag');
  eq(r.items[0].writeGrant, undefined, 'writeGrant without the flag');
  const r2 = run(['ship it'], { LEASH_ALLOW_WRITE: '1', LEASH_WRITE_GRANT: 'abc123' });
  eq(r2.items[0].writeGrant, undefined, 'no schedule mark, no grant');
  const r3 = run(['ship it'], { TMUX: '/tmp/tmux-501/default,1,0', LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '233', LEASH_ALLOW_WRITE: '1', LEASH_WRITE_GRANT: 'abc123' });
  eq(r3.items[0].writeGrant, undefined, 'typed in a tmux pane');
});
t('★ a handoff typed in a tmux pane carries no mark, even with a leaked LEASH_TRIGGER (QA round 3)', () => {
  const r = run(['owner handoff'], { TMUX: '/tmp/tmux-501/default,1,0', LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '120' });
  eq(r.items[0].scheduleId, undefined, 'scheduleId');
});
t('a scheduled run with no id still marks the child (unknown id)', () => {
  const r = run(['do the thing'], { LEASH_TRIGGER: 'schedule' });
  eq(r.items[0].scheduleId, 'unknown', 'scheduleId');
});
t('a handoff from the chat or an ordinary worker carries no mark', () => {
  const r = run(['do the thing']);
  eq(r.items[0].scheduleId, undefined, 'scheduleId');
  eq(r.items[0].allowWrite, undefined, 'allowWrite');
  const r2 = run(['do the thing'], { LEASH_ALLOW_WRITE: '1' });
  eq(r2.items[0].allowWrite, undefined, 'allowWrite without a schedule');
});

// THE WORKSPACE IS THE DAEMON'S: config.json's defaultCwd is where a bare name
// resolves, so a user whose repos live elsewhere gets the same resolution the
// daemon uses for the brief's own inference.
t('a bare repo name resolves under config.json defaultCwd when it is set', () => {
  const ws = path.join(TMP, 'workspace');
  mkdirSync(path.join(ws, REPO_NAME), { recursive: true });
  writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ defaultCwd: ws }));
  try {
    const r = run(['--engine', 'codex', '--repo', REPO_NAME, 'do the thing']);
    eq(r.code, 0, 'exit code');
    eq(r.items[0].cwd, path.join(ws, REPO_NAME), 'cwd');
  } finally {
    rmSync(path.join(TMP, 'config.json'), { force: true });
  }
});

rmSync(TMP, { recursive: true, force: true });
console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
