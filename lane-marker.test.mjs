#!/usr/bin/env node
// Tripwire: every Claude child the daemon spawns carries LEASH_LANE in its env,
// `chat` for the one lane the user talks to and `bg` for detached workers, and
// a background worker also carries its draft report path and, when a schedule
// started it, the scheduled run mark.
//
// Claude Code hooks inherit the child's env, so these keys are a contract with
// whatever hooks the operator installs: a hook can add up the chat lane's
// foreground Bash time, refuse a verifier dispatch until the draft exists, or
// hold database writes in an unattended run. If a key is lost, dropped from the
// env spread, or set on the wrong lane, the hook that reads it goes silent with
// no other symptom.
//
// The env is built by ONE function, workerEnv in worker-env.mjs. What each lane
// gets from it is pinned by worker-env.test.mjs; this file pins that the ONE
// spawn site hands it the right inputs, and that nothing else in bridge.mjs
// sets any of those keys. It reads the source as text, because importing
// bridge.mjs boots the daemon.
//
//   node lane-marker.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('./bridge.mjs', import.meta.url)), 'utf8');
// Comments stripped, so a key named in prose is not mistaken for a setter.
const CODE = SRC.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

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
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const claudeSpawns = SRC.split('spawnWorker(CLAUDE_BIN').length - 1;
const at = SRC.indexOf('spawnWorker(CLAUDE_BIN');
// The lines that build the env sit just above the spawn.
const before = SRC.slice(Math.max(0, at - 2500), at + 200);

t('there is exactly one Claude spawn site (one place to carry the marker)', () => {
  ok(claudeSpawns === 1, `expected 1 spawnWorker(CLAUDE_BIN ...) site, found ${claudeSpawns}`);
});

t('the Claude spawn env is workerEnv over process.env, with the lane by isBgLane', () => {
  ok(/spawnWorker\(CLAUDE_BIN, args, \{ cwd, env: childEnv, logPath \}\)/.test(before), `spawn env is not the expected shape:\n${before.slice(-600)}`);
  ok(/const childEnv = workerEnv\(process\.env, \{/.test(before), 'the env is not built by workerEnv over process.env');
  ok(/lane: isBgLane \? 'bg' : 'chat'/.test(before), 'the lane is not derived from isBgLane');
});

t('isBgLane is derived from the main lane, not from a name string', () => {
  ok(/const isBgLane = lane !== LANES\.main;/.test(SRC), 'isBgLane definition changed');
});

t('★ the draft path and start time are handed over for a background lane only', () => {
  ok(/const draftPath = isBgLane \? bgDraftPath\(path\.basename\(logPath, '\.jsonl'\)\) : null;/.test(before), 'the draft path is not the run id the report uses');
  ok(/startedAt: isBgLane \? startedAt : null/.test(before), 'the start time is not gated on the lane');
  ok(/mkdirSync\(BG_REPORTS_DIR, \{ recursive: true \}\)/.test(before), 'the reports dir must exist before the worker writes into it');
  ok(/args\.push\('--add-dir', BG_REPORTS_DIR\)/.test(before), 'the worker must be allowed to write its draft under acceptEdits');
});

t('★ the schedule mark is handed over for a background lane only', () => {
  ok(/schedule: isBgLane \? schedule : null/.test(before), 'the schedule mark is not gated on the lane');
});

t('no Claude spawn path in bridge.mjs sets a contract key of its own', () => {
  for (const key of ['LEASH_LANE', 'BG_REPORT_DRAFT', 'BG_RUN_STARTED_AT', 'LEASH_TRIGGER', 'LEASH_SCHEDULE_ID', 'LEASH_ALLOW_WRITE']) {
    ok(!new RegExp(`\\b${key}\\s*[:=]`).test(CODE), `${key} is set in bridge.mjs outside workerEnv; a second setter lets lanes disagree`);
  }
});

t('★ the daemon scrubs the contract keys from its own env before main() runs', () => {
  // So a Codex child, an execFile and every other child that spreads
  // process.env can never inherit a worker's draft or a schedule mark from a
  // daemon started inside a worker shell.
  const start = SRC.lastIndexOf('\nif (IS_ENTRYPOINT) {');
  ok(start > 0, 'the IS_ENTRYPOINT boot block was not found');
  const boot = SRC.slice(start);
  const scrub = boot.indexOf('scrubWorkerEnv(process.env)');
  ok(scrub > 0, 'no boot-time scrub');
  ok(scrub < boot.indexOf('main().catch'), 'the scrub must run before main()');
});

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n` + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`✅ ${pass}/${pass} lane-marker tests pass`);
