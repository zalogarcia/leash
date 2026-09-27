// BACKGROUND WORKER ADMISSION: the pure half of the concurrency cap.
//
// WHY THERE IS A CAP AT ALL. On 2026-09-21, between roughly 13:37 and 13:41Z,
// four background workers plus the chat lane exhausted EVERY Claude account at
// once. Three jobs died mid flight and their work was lost; one of them had
// actually FINISHED and its result had to be recovered from the database by
// hand. Two accounts stayed on weekly walls for three more days. No token
// saving prevents that shape. Only pacing does.
//
// WHY IT QUEUES INSTEAD OF REFUSING, which matters more than the number. The
// documented promise a user relies on is that a busy worker never blocks a
// job: if one is busy, another spawns, so any number of independent long jobs
// can be handed off.
//
// A cap that REJECTS the fourth job breaks that promise, and breaks it silently
// in the middle of a busy day, which is worse than not having a cap. A cap that
// ADMITS every job and starts the fourth when a slot frees keeps the promise
// and changes only the pacing. Nothing is ever dropped; the user-visible
// contract stays "hand off as many as you like".
//
// WHAT IS NOT CAPPED, and why:
//   - the CHAT lane. The owner must always be able to talk to the assistant. A
//     cap that can make them wait for a reply is a cap on the product, not on
//     spend.
//   - CODEX jobs. Codex is billed separately and is the engine every walled
//     Claude job falls back TO, so capping it would remove the escape hatch the
//     cap exists to make unnecessary.
//   - subagent dispatches INSIDE one worker session (the other half of the same
//     incident: one session made 43 dispatches and 1,265 API calls in 24
//     minutes). That lives in the agent harness, not in this daemon.
//
// Everything here is pure: no fs, no clock, no daemon state. The wiring that
// makes bridge.mjs actually use it is proven separately by
// bg-concurrency-wiring.test.mjs, because existence is not implementation.

// Four workers plus the chat lane is the configuration that actually walled
// every account on 2026-09-21, so the default is one below it. Override with
// `maxConcurrentWorkers` in config.json or BRIDGE_MAX_CONCURRENT_WORKERS.
export const DEFAULT_MAX_CONCURRENT_WORKERS = 3;

/**
 * Normalize the configured cap.
 *
 * A cap of 0 would be a daemon that accepts jobs and never runs one, which is
 * indistinguishable from a hang, so the floor is 1: "serialize everything" is a
 * setting, "never start anything" is a bug. Anything unparseable falls back to
 * the default rather than to Infinity, because a typo must not silently remove
 * the guard the typist was trying to tune.
 */
export function maxConcurrentWorkers(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_MAX_CONCURRENT_WORKERS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT_WORKERS;
  return Math.max(1, Math.floor(n));
}

/**
 * Does this job get a slot right now?
 *
 * `bypass` is the explicit-at-dispatch override (`bg.mjs --now`). It is never
 * automatic: a cap that lifts itself under pressure is not a cap, and the
 * pressure is exactly when it has to hold.
 */
export function hasSlot({ running = 0, max = DEFAULT_MAX_CONCURRENT_WORKERS, engine = 'claude', bypass = false } = {}) {
  if (engine === 'codex') return true; // not capped, see the header
  if (bypass) return true;
  return Number(running) < Number(max);
}

/**
 * The deferred jobs go back to the FRONT of the drop box.
 *
 * FIFO is the whole point of an admission queue: a job that has already waited
 * a cycle must not be overtaken by one that arrived while it waited. Same merge
 * the walled-job flush does, same reason.
 */
export function mergeRequeue(deferred, queued) {
  const a = Array.isArray(deferred) ? deferred : [];
  const b = Array.isArray(queued) ? queued : [];
  return [...a, ...b];
}

/**
 * Positions and wait flags for the drop box, as `bg.mjs ps` and the dispatch
 * acknowledgement report them.
 *
 * `position` is the FIFO index in the drop box. `waitPosition` counts only the
 * jobs that will actually have to wait, because "queued, position 2" means the
 * second job waiting for a slot, not the second line in a file.
 *
 * Items are `{ engine, title, queuedAt, bypass }`; the caller resolves the
 * engine, since only the daemon knows the config default and the chat setting.
 */
export function queueRows(items, { running = 0, max = DEFAULT_MAX_CONCURRENT_WORKERS } = {}) {
  const list = Array.isArray(items) ? items : [];
  let free = Math.max(0, Number(max) - Number(running));
  let waitSeq = 0;
  return list.map((it, i) => {
    const engine = it?.engine === 'codex' ? 'codex' : 'claude';
    const bypass = Boolean(it?.bypass);
    const waiting = engine === 'claude' && !bypass && free <= 0;
    // A bypass job takes a REAL worker, so it pushes `free` negative and the
    // jobs behind it wait longer. Anything else would report a queue that is
    // shorter than the one the daemon will actually run.
    if (engine === 'claude' && !waiting) free--;
    if (waiting) waitSeq++;
    return {
      position: i + 1,
      waitPosition: waiting ? waitSeq : 0,
      waiting,
      engine,
      bypass,
      title: String(it?.title ?? ''),
      queuedAt: it?.queuedAt ?? null,
    };
  });
}

const clip = (s, n) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length <= n ? v : `${v.slice(0, Math.max(0, n - 1))}…`;
};

/**
 * The QUEUED block under the `bg.mjs ps` table.
 *
 * A job sitting in a queue with no way to see it is worse than a rejection: the
 * rejection at least tells the caller. This block is the whole reason the cap is
 * allowed to be silent about admission.
 */
export function queuedBlock(rows, { running = 0, max = DEFAULT_MAX_CONCURRENT_WORKERS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '';
  const waiting = list.filter((r) => r.waiting).length;
  const head = ['#', 'WAIT', 'ENGINE', 'TITLE'];
  const body = list.map((r) => [
    String(r.position),
    r.waiting ? `yes (${r.waitPosition})` : 'no',
    r.engine,
    clip(r.title, 70),
  ]);
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const table = all
    .map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd())
    .join('\n  ');
  const summary = `QUEUED (${list.length} in the drop box · ${waiting} waiting for a slot · ${running} of ${max} workers busy)`;
  return `${summary}\n  ${table}`;
}
