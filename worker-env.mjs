// THE WORKER ENV CONTRACT: what a spawned Claude child is told about itself.
//
// Claude Code hooks inherit the child's process env, and hooks in ~/.claude are
// the only readers of these names. The names are therefore a CONTRACT with
// code in another repo: renaming one does not fail anything here, it silently
// turns off the hook that reads it. worker-env.test.mjs pins them name for name.
//
//   LEASH_LANE          'chat' for the one lane the owner talks to, 'bg' for a
//                       detached background worker. Every Claude child.
//                       (bridge-inline-budget.py keys on it.)
//   BG_REPORT_DRAFT     absolute path of the DRAFT report file this worker keeps
//                       while it runs: <bg-reports>/<runId>.draft.md. Background
//                       lane only. The worker rewrites it before any verifier
//                       dispatch (LANE RULE 6 in bg.mjs, enforced by a hook), and
//                       when the run ends without a final report the bridge
//                       delivers the draft instead of nothing (bg-draft.mjs).
//   BG_RUN_STARTED_AT   the worker's startedAt, epoch milliseconds as a decimal
//                       string. Background lane only.
//   LEASH_TRIGGER       'schedule' when a schedules.json entry with run: true
//                       started this run, and absent otherwise. A hook needs it
//                       to tell an unattended 03:00 job from a worker the owner
//                       asked for: both are LEASH_LANE=bg. Background lane only.
//   LEASH_SCHEDULE_ID   that entry's id. Only alongside LEASH_TRIGGER.
//   LEASH_ALLOW_WRITE   '1' only alongside LEASH_TRIGGER, and only when the
//                       entry carries allowWrite: true (`schedule.mjs add ...
//                       --run --allow-write`): the owner's approval for database
//                       writes and migrations in that unattended run.
//
// Pure: no fs, no clock, no daemon state. The base env is copied, never
// mutated, except by scrubWorkerEnv, whose whole job is to mutate the one
// object it is handed (process.env, once, at daemon boot).

export const WORKER_ENV_KEYS = Object.freeze([
  'LEASH_LANE',
  'BG_REPORT_DRAFT',
  'BG_RUN_STARTED_AT',
  'LEASH_TRIGGER',
  'LEASH_SCHEDULE_ID',
  'LEASH_ALLOW_WRITE',
]);

/**
 * Delete every contract key from `env`, in place, and return it.
 *
 * Run once on process.env at daemon boot. Every child the daemon spawns spreads
 * process.env (the Codex runs, the app-server, every execFile), so a daemon
 * started from inside a worker's shell would otherwise hand that worker's draft
 * path and schedule mark to all of them. Scrubbing the source is what makes
 * "unset on the chat lane and on Codex runs" structural rather than a property
 * of how the LaunchAgent happens to start us.
 */
export function scrubWorkerEnv(env) {
  for (const k of WORKER_ENV_KEYS) delete env[k];
  return env;
}

/**
 * The env for ONE spawned child.
 *
 *   lane       'chat' | 'bg' | null. null (a Codex child) gets no key at all.
 *   draftPath  the draft report path, set on a 'bg' lane only.
 *   startedAt  epoch ms, set on a 'bg' lane only, and only when it is a number.
 *   schedule   { id, allowWrite } when a schedules.json entry started the run,
 *              else null. A 'bg' lane only. `allowWrite` must be the literal
 *              true: this is a permission, and a truthy string is not consent.
 *
 * Every contract key is scrubbed from the copy first, so a value inherited from
 * the base can never reach a lane that must not carry it.
 */
export function workerEnv(base = {}, { lane = null, draftPath = null, startedAt = null, schedule = null } = {}) {
  const env = scrubWorkerEnv({ ...base });
  if (lane) env.LEASH_LANE = String(lane);
  if (lane !== 'bg') return env;
  if (draftPath) env.BG_REPORT_DRAFT = String(draftPath);
  const started = startedAt == null || startedAt === '' ? NaN : Number(startedAt);
  if (Number.isFinite(started)) env.BG_RUN_STARTED_AT = String(Math.trunc(started));
  if (schedule && schedule.id != null && schedule.id !== '') {
    env.LEASH_TRIGGER = 'schedule';
    env.LEASH_SCHEDULE_ID = String(schedule.id);
    if (schedule.allowWrite === true) env.LEASH_ALLOW_WRITE = '1';
  }
  return env;
}
