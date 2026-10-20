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
//     cap exists to make unnecessary. (Since 2026-10-13 a Codex job still waits
//     on the MACHINE LOAD, which it shares: see admissionVerdict below.)
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
export function hasSlot({ running = 0, max = DEFAULT_MAX_CONCURRENT_WORKERS, engine = 'claude', bypass = false, itemMax = null, pacedRunning = 0 } = {}) {
  if (engine === 'codex') return true; // not capped, see the header
  if (bypass) return true;
  if (!(Number(running) < Number(max))) return false;
  const pace = paceOf(itemMax);
  return pace === null || Number(pacedRunning) < pace;
}

/**
 * A JOB'S OWN PACE (`maxRunning` on a drop box item).
 *
 * A job the bridge restarted after a usage wall carries the pace it restarts
 * at (wall-resume.mjs resumeQueueItem): it starts only while fewer RESUMED
 * jobs than that are running (`pacedRunning`). Counting the resumed jobs and
 * not the whole pool is deliberate. Counted against the whole pool, a resume
 * never started while five ordinary workers were kept busy, and every later
 * handoff ran past it (QA, 2026-10-06); counted this way the workers a wall
 * killed still do not all come back at once, and new work is never held back
 * by them.
 *
 * It is a SECOND condition on top of the cap, so it can only make a job wait
 * longer and never start one the cap would hold: the drop box is a file any
 * worker can write. Returns a whole number of one or more, or null for no pace
 * (absent, zero, negative, not a number).
 */
export function paceOf(itemMax) {
  if (itemMax == null || itemMax === '' || typeof itemMax === 'boolean' || typeof itemMax === 'object') return null;
  const own = Math.floor(Number(itemMax));
  return Number.isFinite(own) && own >= 1 ? own : null;
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
 * Items are `{ engine, title, queuedAt, bypass, maxRunning, resumed }`; the
 * caller resolves the engine, since only the daemon knows the config default
 * and the chat setting. `maxRunning` is a job's own pace (paceOf) and
 * `pacedRunning` how many resumed jobs run now: a job that waits on its pace is
 * reported as waiting, or `ps` would show it as about to start while the
 * daemon holds it. `resumed` rows count toward the pace of the rows behind them.
 */
export function queueRows(items, { running = 0, max = DEFAULT_MAX_CONCURRENT_WORKERS, pacedRunning = 0 } = {}) {
  const list = Array.isArray(items) ? items : [];
  let free = Math.max(0, Number(max) - Number(running));
  let paced = Number(pacedRunning) || 0;
  let waitSeq = 0;
  return list.map((it, i) => {
    const engine = it?.engine === 'codex' ? 'codex' : 'claude';
    const bypass = Boolean(it?.bypass);
    const pace = paceOf(it?.maxRunning);
    const waiting = engine === 'claude' && !bypass && (free <= 0 || (pace !== null && paced >= pace));
    if (engine === 'claude' && !waiting && it?.resumed) paced++;
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

// ---------------------------------------------------------------------------
// ADMISSION BEYOND THE COUNT: machine load and the usage window (self audit
// 2026-10-13, P2, approved by the owner with a cap of 6).
//
// WHY. The count alone paced nothing that week: 38 friction entries in 29
// sessions named machine load (load averages of 50 to 370 on a 14 core Mac,
// gates that never came back clean), and 14 of 80 sampled runs died on a usage
// limit before finishing, with 11 more existing only to resume one. "About 10
// workers burn a 5 hour window in about 2 hours." The checkpoint steer at 95%
// and the paced resume after the wall both act once the burn has happened;
// these two gates slow the burn itself.
//
//   LOAD: the 1 minute load average against `loadPerCore` times the core count
//   (2 x 14 = 28 here). Over it, a NEW job waits. Claude and Codex alike: a
//   Codex job does not spend a Claude window, but its gates spawn the same
//   processes on the same cores. With no bridge job running at all the gate
//   stands aside, so load from something else on the Mac (a render, a build)
//   can slow the queue but never freeze it.
//
//   USAGE: the live account's newest reading (the same one the wall guard
//   trusts) at or past `usagePercent` of an open window, with no other account
//   free to move to. A new CLAUDE job waits for the reset, or for the switch to
//   another account, instead of starting and dying on the limit minutes later.
//   Codex is not held by it: Codex does not spend a Claude window.
//
// Neither gate refuses anything. A job that waits stays in the drop box, keeps
// its place, shows its reason in `bg.mjs ps` and on its own Telegram line, and
// starts by itself when the reason clears. `--now` still passes all of them: it
// is typed at dispatch by a person who has looked.
// ---------------------------------------------------------------------------

/** The defaults, which are also what a missing `admission` block means. */
export const ADMISSION_DEFAULTS = Object.freeze({
  loadPerCore: 2,
  usagePercent: 90,
});

// Under these a setting is a typo, not a choice: a load limit of 0.2 per core
// would hold every job on an idle Mac, a usage gate at 9 would hold all day.
export const LOAD_PER_CORE_MIN = 0.5;
export const USAGE_PERCENT_MIN = 50;

const numOf = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));

/**
 * The settings, normalized. `raw` is config.json's `admission` value. `false`
 * (or the strings "false", "off", "0", "no") switches BOTH new gates off, which
 * leaves the count alone. A gate set to 0 or false is that gate off. Anything
 * unparseable is the default, never a value that silently removes a gate.
 */
export function admissionSettings(raw) {
  const d = ADMISSION_DEFAULTS;
  if (raw === false || (typeof raw === 'string' && /^(false|off|0|no)$/i.test(raw.trim()))) return { loadPerCore: 0, usagePercent: 0 };
  const r = raw && typeof raw === 'object' ? raw : {};
  const off = (v) => v === false || v === 0 || v === '0';
  const load = numOf(r.loadPerCore);
  const usage = numOf(r.usagePercent);
  return {
    loadPerCore: off(r.loadPerCore) ? 0 : Number.isFinite(load) ? Math.max(LOAD_PER_CORE_MIN, load) : d.loadPerCore,
    usagePercent: off(r.usagePercent) ? 0 : Number.isFinite(usage) ? Math.min(100, Math.max(USAGE_PERCENT_MIN, usage)) : d.usagePercent,
  };
}

/**
 * Is the machine too loaded to start one more job? { high, load1, ncpu, limit }.
 * `bridgeRunning` is every bridge job running now, Claude and Codex: with none,
 * the load is someone else's and the gate stands aside (see the header).
 */
export function loadGate({ load1 = null, ncpu = null, loadPerCore = ADMISSION_DEFAULTS.loadPerCore, bridgeRunning = 0 } = {}) {
  const l = Number(load1);
  const n = Math.floor(Number(ncpu));
  const per = Number(loadPerCore);
  if (!(per > 0) || !Number.isFinite(l) || !(n >= 1)) return { high: false, load1: Number.isFinite(l) ? l : null, ncpu: n >= 1 ? n : null, limit: null };
  const limit = Math.round(per * n * 10) / 10;
  return { high: l > limit && Number(bridgeRunning) > 0, load1: l, ncpu: n, limit };
}

/**
 * THE USAGE HOLD, from one reading: null, or { account, percent, label,
 * resetsAtMs } for the fullest open window at or past the threshold.
 *
 * `trigger` is wall-guard.mjs checkpointTrigger's answer for this reading at
 * the admission threshold, so "open window" and "stale reading" mean exactly
 * what they mean to the wall guard. `othersFree` is the selector's verdict:
 * true means another account can take the job (the automatic switch moves
 * there, so nothing waits); false or unknown holds, because the reading itself
 * already says this account is nearly spent.
 */
export function usageHold({ trigger = null, othersFree = null, account = null, usagePercent = ADMISSION_DEFAULTS.usagePercent } = {}) {
  if (!(Number(usagePercent) > 0)) return null;
  if (!trigger || !trigger.armed || !trigger.window) return null;
  if (othersFree === true) return null;
  const w = trigger.window;
  return { account: account || null, percent: Math.round(Number(w.percent)), label: String(w.label || 'the window'), resetsAtMs: Number(w.resetsAtMs) || null };
}

const defaultClock = (ms) => new Date(Number(ms)).toISOString().slice(11, 16);

/**
 * ONE JOB, ONE VERDICT: does it start now, and if not, why? Pure.
 *
 * Returns { admit: true } or { admit: false, kind, text }. `kind` is one of
 * 'retry' (a job the bridge itself re-queued, not before `notBefore`), 'cap',
 * 'pace', 'load', 'usage'. `text` starts with "waiting:" and is what `bg.mjs ps`
 * and the job's own Telegram line say.
 *
 * The order is the order of the questions a person would ask: is it even due,
 * was it forced past everything, is there a slot, is it a resume over its pace,
 * can the machine take it, can the account. Codex answers only the first, the
 * second and the load question (see the header).
 */
export function admissionVerdict({
  engine = 'claude',
  bypass = false,
  notBefore = null,
  now = 0,
  running = 0,
  max = DEFAULT_MAX_CONCURRENT_WORKERS,
  itemMax = null,
  pacedRunning = 0,
  load = null,
  usage = null,
  fmtClock = defaultClock,
} = {}) {
  const nb = Number(notBefore);
  if (Number.isFinite(nb) && nb > Number(now)) {
    return { admit: false, kind: 'retry', text: `waiting: its one retry starts at ${fmtClock(nb)}, after the limit resets` };
  }
  if (bypass) return { admit: true };
  const loadWait = load?.high
    ? { admit: false, kind: 'load', text: `waiting: machine load ${Math.round(load.load1)} is over ${load.limit} (${load.ncpu} cores)` }
    : null;
  if (engine === 'codex') return loadWait || { admit: true };
  if (!(Number(running) < Number(max))) {
    return { admit: false, kind: 'cap', text: `waiting: ${Number(running)} of ${Number(max)} Claude workers busy` };
  }
  const pace = paceOf(itemMax);
  if (pace !== null && !(Number(pacedRunning) < pace)) {
    return { admit: false, kind: 'pace', text: `waiting: ${Number(pacedRunning)} of ${pace} resumed jobs running, the resume pace` };
  }
  if (loadWait) return loadWait;
  if (usage) {
    const at = usage.resetsAtMs ? ` · resets ${fmtClock(usage.resetsAtMs)}` : '';
    return { admit: false, kind: 'usage', text: `waiting: ${usage.account || 'the account'} is at ${usage.percent}% of ${usage.label}, no other account free${at}` };
  }
  return { admit: true };
}

/**
 * The same rows queueRows makes, judged by admissionVerdict, each with its
 * `reason` (null when it starts). `ctx` is everything the verdict takes that is
 * not on the row: { running, max, pacedRunning, load, usage, now, fmtClock,
 * bridgeRunning }. Every row admitted ahead counts toward the next row's pool
 * and, for the load floor, toward the bridge's running jobs.
 */
export function admissionRows(items, ctx = {}) {
  const list = Array.isArray(items) ? items : [];
  let running = Number(ctx.running) || 0;
  let paced = Number(ctx.pacedRunning) || 0;
  let bridge = Number(ctx.bridgeRunning) || 0;
  let waitSeq = 0;
  const loadOf = () => (ctx.load ? loadGate({ ...ctx.load, bridgeRunning: bridge }) : null);
  return list.map((it, i) => {
    const engine = it?.engine === 'codex' ? 'codex' : 'claude';
    const bypass = Boolean(it?.bypass);
    const v = admissionVerdict({
      engine,
      bypass,
      notBefore: it?.notBefore ?? null,
      now: ctx.now ?? 0,
      running,
      max: ctx.max ?? DEFAULT_MAX_CONCURRENT_WORKERS,
      itemMax: it?.maxRunning ?? null,
      pacedRunning: paced,
      load: loadOf(),
      usage: ctx.usage || null,
      fmtClock: ctx.fmtClock || defaultClock,
    });
    const waiting = !v.admit;
    if (!waiting) {
      bridge++;
      if (engine === 'claude') {
        running++;
        if (it?.resumed) paced++;
      }
    }
    if (waiting) waitSeq++;
    return {
      position: i + 1,
      waitPosition: waiting ? waitSeq : 0,
      waiting,
      engine,
      bypass,
      title: String(it?.title ?? ''),
      queuedAt: it?.queuedAt ?? null,
      reason: waiting ? v.text : null,
      kind: waiting ? v.kind : null,
    };
  });
}

/**
 * ONE LINE for `bg.mjs ps` that says what admission sees right now, whether or
 * not anything waits: the count, the load against its limit, and the usage
 * gate. `load` is loadGate's answer, `usage` usageHold's.
 *
 *   ADMISSION · Claude workers: 6 of 6 busy · load 12 of 28 (14 cores) · usage gate clear
 *
 * Its THIRD whitespace field is never a number, and that is load bearing: the
 * line sits under the worker table, and a script that reads field 3 of every
 * line after the header as a worker PID (to lower its priority, say) is a shape
 * a user's own tooling takes. The first shape ("ADMISSION · 1 of 6 ...") handed
 * such a reader PID 1, launchd, whose descendants are every process on the
 * machine (independent review, 2026-10-13).
 */
export function admissionLine({ running = 0, max = DEFAULT_MAX_CONCURRENT_WORKERS, load = null, usage = null, fmtClock = defaultClock } = {}) {
  const bits = [`ADMISSION · Claude workers: ${Number(running)} of ${Number(max)} busy`];
  if (load && Number.isFinite(Number(load.load1)) && load.limit != null) {
    bits.push(`load ${Math.round(Number(load.load1))} of ${load.limit} (${load.ncpu} cores)${load.high ? ', new jobs wait' : ''}`);
  } else bits.push('load gate off');
  if (usage) {
    const at = usage.resetsAtMs ? `, resets ${fmtClock(usage.resetsAtMs)}` : '';
    bits.push(`usage: ${usage.account || 'the account'} at ${usage.percent}% of ${usage.label}, new Claude jobs wait${at}`);
  } else bits.push('usage gate clear');
  return bits.join(' · ');
}

/**
 * The reason lines under the QUEUED table: one line per distinct reason, with
 * the positions it holds. Under the table rather than in it, so the table's
 * columns (and every reader of them) are unchanged.
 */
export function reasonLines(rows, { width = 110 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const byText = new Map();
  for (const r of list) {
    if (!r?.waiting || !r.reason) continue;
    if (!byText.has(r.reason)) byText.set(r.reason, []);
    byText.get(r.reason).push(`#${r.position}`);
  }
  return [...byText.entries()].map(([text, at]) => clip(`${text} · ${at.join(' ')}`, width));
}

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
  // WHY each waiting job waits, when the rows say (admissionRows). Rows made by
  // queueRows carry no reason and render exactly as before.
  const why = reasonLines(list);
  return `${summary}\n  ${table}${why.length ? `\n  ${why.join('\n  ')}` : ''}`;
}
