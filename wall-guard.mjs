// THE USAGE WALL GUARD, part 1: SAVE THE WORK BEFORE THE WALL.
//
// SHARED MODULE, byte-identical in the public and private bridge repos and
// listed in scripts/check-shared.sh. No owner name, no path, no script name:
// anything specific to one machine is passed in by the caller.
//
// ---------------------------------------------------------------------------
// THE INCIDENT THIS EXISTS FOR (2026-10-06, morning)
//
// Eight background workers ran at once and used a whole five hour window in
// about ninety minutes. Every other Claude account was already at its limit,
// so when the window ran out there was nothing to rotate to: several workers
// died in the middle of their work, with uncommitted changes, and the chat
// lane had to write a resume brief for each one by hand and schedule each for
// the next account's reset.
//
// Two things were missing, and this file is the first:
//
//   1. BEFORE the wall (here). When the live account's window reaches a
//      threshold (95 by default) and no other account can take a run, every
//      running Claude background worker that can be steered gets ONE steer
//      telling it to save a checkpoint (a WIP commit on its own branch, or a
//      patch, plus a resume note in its draft report) and then carry on.
//   2. AFTER the wall (wall-resume.mjs). The workers that died on the wall are
//      queued again by the bridge at the lift, their original brief behind a
//      bridge-written RESUME NOTE.
//
// ---------------------------------------------------------------------------
// THE DECISIONS, and why each is the shape it is
//
// "NO OTHER ACCOUNT IS FREE" IS THE SELECTOR'S VERDICT, PASSED IN. There is
// already one rule for "which account can take a run" (account-selector.mjs
// selectAccount: the ledger, a probe per candidate, the re-check of a known
// wall). A second definition here would drift from it on the first day the
// selector learned something new, so the caller asks the selector and hands
// this module a boolean. Anything but a definite `false` does not fire: a
// selector that answered nothing is not evidence that nothing is free.
//
// A READING IS FRESH WHEN ITS WINDOW HAS NOT RESET. Usage inside one window
// only goes up, so an older reading of a window that is still open is a LOWER
// bound on where it stands now, and 96% read ten minutes ago is at least 96%
// now. A reading whose reset is already past describes a window that no
// longer exists and never fires.
//
// THE WEEKLY WINDOWS COUNT TOO, as one more condition and nothing more. A
// weekly wall ("You've hit your weekly limit") kills a worker through the
// same limit death path a five hour wall does (accounts.mjs isLimitSignal,
// then the rotation), so the same guard covers it: any fresh window at or past
// the threshold arms it, the five hour one, the weekly one, or a per model
// weekly (scoped) one.
//
// ONCE PER WORKER PER WINDOW. A worker that was told to save is not told again
// in the same window, across daemon restarts too (the state record below), so
// the steer is an event and not a drumbeat. A worker that starts later in the
// same window has not been told, so it is.
//
// CODEX WORKERS GET NOTHING. Codex is billed separately and a Claude window
// has no bearing on it.
//
// A WORKER THAT CANNOT BE STEERED is named, not skipped silently: one that
// survived a daemon restart is tailed by log and has no stdin to write to.
//
// THE STEER NEVER SAYS STOP. It says finish the step in hand, save, write the
// note, and continue. If the window resets or a swap becomes possible the work
// simply goes on; a guard that stopped workers at 95% would spend the last
// five percent of every window doing nothing.
//
// ---------------------------------------------------------------------------
// THE STATE RECORD (createWallGuardStore) is one JSON file beside the daemon,
// rewritten whole through a temp file and a rename, and read once. It holds
// both halves' memory, so a daemon restart can undo neither: which workers
// were steered in which window and whether the owner was told, and, for the
// resume half, each worker's dispatch facts (directory pin, scheduled run
// mark, resume chain), the deaths waiting for the lift, and the deaths
// already resumed. Its decisions live in wall-resume.mjs.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resetsAtToMs } from './account-usage.mjs';
import { RESET_UNKNOWN_SOURCES } from './wall-wake.mjs';
import { clip, oneLine } from './progress-render.mjs';

/**
 * The defaults, which are also what a missing `wallGuard` block in config.json
 * means: the guard is ON with these values unless it is switched off.
 */
export const WALL_GUARD_DEFAULTS = Object.freeze({
  enabled: true,
  thresholdPercent: 95,
  resume: true,
  resumeWithinMinutes: 5,
  resumeChainMax: 2,
  resumeMaxConcurrent: 4,
});

// A threshold under this is a typo, not a setting: 9.5 for 95 would steer
// every worker at a tenth of a window. One hundred is allowed and means "only
// at the wall itself", which is legal and nearly useless.
export const THRESHOLD_MIN = 50;
export const THRESHOLD_MAX = 100;
export const RESUME_WITHIN_MAX_MINUTES = 60;
export const RESUME_CHAIN_LIMIT = 10;
// THE RESUME PACE (resumeMaxConcurrent). A resumed job starts only while fewer
// than this many Claude workers are running; the rest wait in the ordinary
// queue and start as workers finish. Nine workers restarted at once after a
// wall used the next five hour window in about ninety minutes and walled it
// too (2026-10-06, afternoon), which is the loop the chain cap exists to stop
// and this keeps from starting. It only ever LOWERS the ordinary cap
// (bg-admission.mjs hasSlot), never raises it; 0 or false means "no pace of
// its own, the ordinary cap alone".
export const RESUME_PACE_LIMIT = 50;

const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));
const bool = (v, fallback) => (v === true || v === false ? v : fallback);

/**
 * The settings, normalized. `raw` is config.json's `wallGuard` value: an
 * object, `false` (the one off switch, shorthand for { enabled: false }; the
 * strings "false", "off", "0" and "no" mean the same, for an environment
 * override), or absent. Anything unparseable falls back to the default rather than to a
 * value that silently removes the guard.
 */
export function wallGuardSettings(raw) {
  const d = WALL_GUARD_DEFAULTS;
  // The environment override arrives as a string, so "false" is the switch too.
  if (raw === false || (typeof raw === 'string' && /^(false|off|0|no)$/i.test(raw.trim()))) return { ...d, enabled: false };
  const r = raw && typeof raw === 'object' ? raw : {};
  const thr = num(r.thresholdPercent);
  const within = num(r.resumeWithinMinutes);
  const chain = num(r.resumeChainMax);
  const pace = r.resumeMaxConcurrent === false ? 0 : num(r.resumeMaxConcurrent);
  return {
    enabled: bool(r.enabled, d.enabled),
    thresholdPercent: Number.isFinite(thr) ? Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, thr)) : d.thresholdPercent,
    resume: bool(r.resume, d.resume),
    resumeWithinMinutes: Number.isFinite(within) ? Math.min(RESUME_WITHIN_MAX_MINUTES, Math.max(1, within)) : d.resumeWithinMinutes,
    resumeChainMax: Number.isFinite(chain) ? Math.min(RESUME_CHAIN_LIMIT, Math.max(0, Math.floor(chain))) : d.resumeChainMax,
    resumeMaxConcurrent: Number.isFinite(pace) ? Math.min(RESUME_PACE_LIMIT, Math.max(0, Math.floor(pace))) : d.resumeMaxConcurrent,
  };
}

/** One line for /status. */
export function wallGuardStatusLine(settings) {
  const s = settings || WALL_GUARD_DEFAULTS;
  if (!s.enabled) return '🛡 Wall guard: off';
  const pace = Number(s.resumeMaxConcurrent) > 0 ? `, ${s.resumeMaxConcurrent} at a time` : '';
  const resume = s.resume ? `resume on, within ${s.resumeWithinMinutes} min, at most ${s.resumeChainMax} per job${pace}` : 'resume off';
  return `🛡 Wall guard: save at ${s.thresholdPercent}% · ${resume}`;
}

/**
 * Every window of one usage reading that is still open at `now`, with a
 * readable percent: { kind, label, percent, resetsAtMs }. `usage` is the
 * account-usage.mjs shape { fiveHour, sevenDay, scoped[] }.
 */
export function openWindows(usage, now = Date.now()) {
  if (!usage || typeof usage !== 'object') return [];
  const all = [
    usage.fiveHour ? { kind: 'fiveHour', label: 'the 5 hour window', w: usage.fiveHour } : null,
    usage.sevenDay ? { kind: 'sevenDay', label: 'the weekly window', w: usage.sevenDay } : null,
    ...(Array.isArray(usage.scoped) ? usage.scoped : []).map((w) => (w ? { kind: `scoped:${w.label || 'scoped'}`, label: `the weekly ${w.label || 'scoped'} window`, w } : null)),
  ].filter(Boolean);
  const out = [];
  for (const { kind, label, w } of all) {
    const percent = num(w.percent);
    const resetsAtMs = resetsAtToMs(w.resetsAt);
    if (!Number.isFinite(percent) || !Number.isFinite(resetsAtMs)) continue;
    if (!(resetsAtMs > Number(now))) continue;
    out.push({ kind, label, percent, resetsAtMs });
  }
  return out;
}

/**
 * IS THE GUARD ARMED by this reading? { armed, reason, window, key }.
 *
 * `reason` when not armed: 'off', 'no reading', 'stale' (every window has
 * already reset), 'below threshold'. `window` is the window the steer names:
 * the five hour one whenever it is at or past the threshold (it walls first),
 * otherwise the fullest open window that is.
 *
 * `key` is the once-per-window bookkeeping, and it is the account plus its
 * open FIVE HOUR window whichever window armed the guard, so the same five
 * hour window is one episode however the weekly and five hour readings move
 * against each other. Keyed by the arming window instead, a weekly window at
 * 97 armed it, the five hour window then passed it, the key changed, and
 * every worker was told twice and the owner twice (QA, 2026-10-06). With no
 * open five hour window the arming window keys it.
 */
export function checkpointTrigger({ settings = WALL_GUARD_DEFAULTS, usage = null, account = null, now = Date.now() } = {}) {
  const s = settings || WALL_GUARD_DEFAULTS;
  if (!s.enabled) return { armed: false, reason: 'off', window: null, key: null };
  const hasAny = usage && (usage.fiveHour || usage.sevenDay || (Array.isArray(usage.scoped) && usage.scoped.length));
  if (!account || !hasAny) return { armed: false, reason: 'no reading', window: null, key: null };
  const open = openWindows(usage, now);
  if (!open.length) return { armed: false, reason: 'stale', window: null, key: null };
  const over = open.filter((w) => w.percent >= s.thresholdPercent);
  if (!over.length) {
    const top = open.reduce((a, b) => (b.percent > a.percent ? b : a));
    return { armed: false, reason: 'below threshold', window: top, key: null };
  }
  let win = over.find((w) => w.kind === 'fiveHour') || null;
  if (!win) {
    win = over[0];
    for (const w of over) if (w.percent > win.percent) win = w;
  }
  const five = open.find((w) => w.kind === 'fiveHour');
  const key = five ? `${account}|fiveHour|${five.resetsAtMs}` : `${account}|${win.kind}|${win.resetsAtMs}`;
  return { armed: true, reason: null, window: win, key };
}

/**
 * THE WHOLE TRIGGER, one call: does the guard fire now, and at whom?
 *
 * `workers` are the daemon's worker descriptors: { runId, lane, engine,
 * steerable, title }. `steered` is the run ids this window's record already
 * holds (told, or found unreachable). `othersFree` is the selector's verdict
 * (true: another account can take a run; false: none can; anything else:
 * unknown, which does not fire).
 *
 * Returns { fire, reason, key, window, targets, unreachable }. `reason` when
 * it does not fire is the trigger's, or 'another account is free', 'account
 * availability unknown', 'no Claude worker running', 'already steered'.
 */
export function checkpointDecision({ settings = WALL_GUARD_DEFAULTS, usage = null, account = null, now = Date.now(), othersFree = null, workers = [], steered = [] } = {}) {
  const trig = checkpointTrigger({ settings, usage, account, now });
  const none = (reason) => ({ fire: false, reason, key: trig.key, window: trig.window, targets: [], unreachable: [] });
  if (!trig.armed) return none(trig.reason);
  if (othersFree === true) return none('another account is free');
  if (othersFree !== false) return none('account availability unknown');
  const claude = (workers || []).filter((w) => w && w.runId && (w.engine || 'claude') === 'claude');
  if (!claude.length) return none('no Claude worker running');
  // By base id: a worker re-attached after a restart is listed under its
  // registry key, <lane>-<startedAt>-<pid>, and recorded under <lane>-<startedAt>.
  const done = new Set((steered || []).map((id) => baseRunId(id)));
  const fresh = claude.filter((w) => !done.has(baseRunId(w.runId)));
  if (!fresh.length) return none('already steered');
  return {
    fire: true,
    reason: null,
    key: trig.key,
    window: trig.window,
    targets: fresh.filter((w) => w.steerable),
    unreachable: fresh.filter((w) => !w.steerable),
  };
}

/**
 * The cheap half of the trigger, for the caller to run BEFORE it asks the
 * selector (which can cost a probe per candidate): is there anything the
 * steer could reach in an armed window? Same inputs as checkpointDecision
 * minus `othersFree`.
 */
export function checkpointCandidates({ settings = WALL_GUARD_DEFAULTS, usage = null, account = null, now = Date.now(), workers = [], steered = [] } = {}) {
  const d = checkpointDecision({ settings, usage, account, now, othersFree: false, workers, steered });
  return { ready: d.fire, reason: d.reason, key: d.key, window: d.window };
}

/**
 * THE STEER, one bridge-owned text built here and nowhere else. Delivered
 * through the ordinary steer path, so it arrives inside the same frame a hand
 * steer does. `resume` says whether the bridge will restart a run the wall
 * ends (the resume half is on), so the worker is never promised a restart
 * that is switched off.
 */
export function checkpointSteerText({ percent = null, windowLabel = 'the 5 hour window', resume = true } = {}) {
  const pct = Number.isFinite(num(percent)) ? `${Math.round(num(percent))}%` : 'nearly all';
  return [
    `CHECKPOINT NOW (sent by the bridge automatically). The Claude account this run is on has used ${pct} of ${windowLabel}, and no other account can take over. This run can end at ANY step, without warning.`,
    '1. FINISH THE STEP IN HAND. Do not start a new long step (no new deploy, migration, send or full test run) until the checkpoint below is saved. A production step already in flight is finished and verified first, never left half done.',
    '2. SAVE THE WORK. Commit your work in progress on your OWN branch or worktree, staging files by name (never `git add .` or `git add -A`), with a commit message that starts with "WIP checkpoint". For this checkpoint: no push, no deploy, no merge, no migration. If you are on a shared checkout, or on a default branch where your brief did not allow commits, do not commit: write a patch file instead (`git diff > <name>.patch`, plus `git diff --staged` if anything is staged) and note its path.',
    '3. WRITE A RESUME NOTE at the TOP of your draft report, the file named in $BG_REPORT_DRAFT, under the heading "RESUME NOTE": what is done; what is left; the branch and the commit sha (or the patch path); what is not committed and why; every production write you made (sends, deploys, migrations, payments, publishes) and its state, done or in flight, verified or not; and the exact next step.',
    resume
      ? '4. Then CONTINUE the job exactly where you were. This is not a stop: if the window resets or another account frees up, the work simply goes on. If the run is cut off, the bridge restarts it after the limit lifts, from your brief plus that resume note.'
      : '4. Then CONTINUE the job exactly where you were. This is not a stop: if the window resets or another account frees up, the work simply goes on. If the run is cut off, the resume note is what the next run starts from.',
  ].join('\n');
}

/**
 * THE NEXT ACCOUNT, for the owner's line: the earliest reset among the other
 * walled accounts and the live account's own window. `rows` is accounts.mjs
 * describe(): { name, captured, limited, limitedUntil (epoch seconds),
 * limitedSource, needsLogin }. A guessed clock never sorts ahead of a known
 * one (wall-wake.mjs pickNextAccount, same reason). Returns { name, atMs,
 * guessed } or null.
 */
export function nextAccountAfter({ rows = [], active = null, activeResetMs = null, now = Date.now() } = {}) {
  const cand = [];
  for (const r of rows || []) {
    if (!r || !r.name || r.name === active || r.captured === false || r.needsLogin) continue;
    const ms = Number(r.limitedUntil) * 1000;
    if (!(ms > Number(now))) continue;
    cand.push({ name: r.name, atMs: ms, guessed: RESET_UNKNOWN_SOURCES.has(r.limitedSource) });
  }
  if (active && Number(activeResetMs) > Number(now)) cand.push({ name: active, atMs: Number(activeResetMs), guessed: false });
  if (!cand.length) return null;
  const known = cand.filter((c) => !c.guessed);
  const pool = known.length ? known : cand;
  let best = pool[0];
  for (const c of pool) if (c.atMs < best.atMs) best = c;
  return { ...best, guessed: !known.length };
}

const workerTag = (w) => `${w.lane || 'a worker'} · ${clip(oneLine(w.title || '(no title)'), 60)}`;

/**
 * THE OWNER'S LINE, once per window, written by the bridge (no model call).
 * `next` is { name, clock } with the clock already formatted in the owner's
 * zone, or null. `unreachable` rows may carry `why`.
 */
export function checkpointNotice({ account = '', percent = null, windowLabel = 'the 5 hour window', thresholdPercent = WALL_GUARD_DEFAULTS.thresholdPercent, steered = [], unreachable = [], next = null } = {}) {
  const pct = Number.isFinite(num(percent)) ? `${Math.round(num(percent))}%` : `${thresholdPercent}% or more`;
  const n = (steered || []).length;
  const lines = [
    `⚠️ Claude usage at ${pct} of ${windowLabel} · threshold ${thresholdPercent}%`,
    `👤 Account: ${account || 'not identified'} · no other account is free`,
    n ? `💾 Told ${n} worker${n === 1 ? '' : 's'} to save a checkpoint and keep going` : '💾 No worker could be told to save',
  ];
  const un = (unreachable || []).filter(Boolean);
  if (un.length) {
    lines.push(`🔌 Could not reach ${un.length}:`);
    for (const w of un) lines.push(`↳ ${workerTag(w)}${w.why ? ` (${w.why})` : ''}`);
  }
  lines.push(next && next.name ? `⏭ Next account: ${next.name} · resets ${next.clock || 'at an unknown time'}${next.guessed ? ' (a guess)' : ''}` : '⏭ Next account: no reset time known yet');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// THE STATE RECORD
// ---------------------------------------------------------------------------

/** How many windows the record remembers. Old windows can never fire again. */
export const EPISODES_KEPT = 6;
/** A dispatch record older than this belongs to a run long over. */
export const JOB_KEEP_MS = 3 * 24 * 3600_000;
/** A death the lift never claimed (no episode, a rehearsal wall) is dropped after this. */
export const DEATH_KEEP_MS = 3 * 24 * 3600_000;
/** How long "this death was already resumed" is remembered. */
export const RESUMED_KEEP_MS = 14 * 24 * 3600_000;
/** Bound on each map, so a runaway cannot grow the file without limit. */
export const RECORD_MAX = 200;

/**
 * The run id a record is filed under: <lane>-<startedAt>. A worker that
 * outlived a restart reports under <lane>-<startedAt>-<pid>, so the tail comes
 * off (the same rule bg-draft.mjs draftRunId applies to the draft path).
 */
export function baseRunId(runId) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-(\d{10,})(?:-\d+)?$/.exec(String(runId ?? ''));
  return m ? `${m[1]}-${m[2]}` : String(runId ?? '');
}

const blank = () => ({ v: 1, episodes: [], jobs: {}, deaths: {}, resumed: {} });

function bounded(map, max, stamp) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const keep = keys.sort((a, b) => Number(stamp(map[b])) - Number(stamp(map[a]))).slice(0, max);
  return Object.fromEntries(keep.map((k) => [k, map[k]]));
}

/**
 * The store. `file` is where it lives; tests pass a temp path. A write that
 * fails is logged and the in-memory record still moves on, so one process
 * never steers a worker twice; the cost is only that a restart could repeat
 * a step, and every step here is safe to repeat except a resume, which is
 * why claimResume writes BEFORE the caller queues anything and refuses when
 * the write fails.
 */
export function createWallGuardStore({ file, log = () => {}, now = () => Date.now() } = {}) {
  if (!file) throw new Error('createWallGuardStore: `file` is required');
  let rec = null;

  function load() {
    if (rec) return rec;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...blank(), ...raw } : blank();
      for (const k of ['jobs', 'deaths', 'resumed']) if (!rec[k] || typeof rec[k] !== 'object' || Array.isArray(rec[k])) rec[k] = {};
      if (!Array.isArray(rec.episodes)) rec.episodes = [];
    } catch {
      rec = blank(); // no file, or a half-written one
    }
    prune();
    return rec;
  }

  function prune() {
    const t = now();
    for (const [id, j] of Object.entries(rec.jobs)) if (!(t - Number(j?.at) < JOB_KEEP_MS)) delete rec.jobs[id];
    for (const [id, d] of Object.entries(rec.deaths)) if (!(t - Number(d?.at) < DEATH_KEEP_MS)) delete rec.deaths[id];
    for (const [id, r] of Object.entries(rec.resumed)) if (!(t - Number(r?.at) < RESUMED_KEEP_MS)) delete rec.resumed[id];
    rec.jobs = bounded(rec.jobs, RECORD_MAX, (j) => j?.at);
    rec.deaths = bounded(rec.deaths, RECORD_MAX, (d) => d?.at);
    rec.resumed = bounded(rec.resumed, RECORD_MAX, (r) => r?.at);
    rec.episodes = rec.episodes.slice(-EPISODES_KEPT);
  }

  function save() {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec, null, 2));
      renameSync(tmp, file);
      return true;
    } catch (e) {
      log(`could not write ${file}: ${e.message}`);
      return false;
    }
  }

  const episodeOf = (key) => load().episodes.find((e) => e.key === key) || null;
  function ensureEpisode(key, init = {}) {
    let e = episodeOf(key);
    if (!e) {
      e = { key, at: now(), steered: {}, unreachable: {}, notifiedAt: null, ...init };
      rec.episodes.push(e);
      prune();
    }
    return e;
  }
  const copy = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

  return {
    file,
    /** The window record for `key`, or null. A copy. */
    episode: (key) => copy(episodeOf(key)),
    /** Every run id this window already handled (told, or found unreachable). */
    handled(key) {
      const e = episodeOf(key);
      return e ? [...Object.keys(e.steered), ...Object.keys(e.unreachable)] : [];
    },
    /** A worker was told to save in this window. */
    steered(key, runId, info = {}, init = {}) {
      const e = ensureEpisode(key, init);
      e.steered[baseRunId(runId)] = { at: now(), ...info };
      return save();
    },
    /** A worker could not be told (no pipe, or the write failed). */
    unreachable(key, runId, info = {}, init = {}) {
      const e = ensureEpisode(key, init);
      e.unreachable[baseRunId(runId)] = { at: now(), ...info };
      return save();
    },
    /**
     * CLAIM the owner's line for this window. True exactly once per window,
     * across restarts: persisted before the caller sends.
     */
    claimNotice(key, init = {}) {
      const e = ensureEpisode(key, init);
      if (e.notifiedAt) return false;
      e.notifiedAt = now();
      save();
      return true;
    },

    /** A Claude worker's dispatch facts, merged in (several call sites add to one run). */
    job(runId, patch = {}) {
      const id = baseRunId(runId);
      if (!id) return false;
      const r = load();
      r.jobs[id] = { ...(r.jobs[id] || {}), ...patch, at: r.jobs[id]?.at || now() };
      prune();
      return save();
    },
    jobOf: (runId) => copy(load().jobs[baseRunId(runId)] || null),

    /** A Claude worker died on the wall. Its brief and facts wait for the lift. */
    death(runId, info = {}) {
      const id = baseRunId(runId);
      if (!id) return false;
      const r = load();
      r.deaths[id] = { ...(r.jobs[id] || {}), ...(r.deaths[id] || {}), ...info, runId: id, at: now() };
      prune();
      return save();
    },
    deathOf: (runId) => copy(load().deaths[baseRunId(runId)] || null),
    deaths: () => Object.values(copy(load().deaths) || {}),
    /** The lift is done with this death: resumed, or handed to the chat lane. */
    settleDeath(runId) {
      const id = baseRunId(runId);
      const r = load();
      if (!(id in r.deaths)) return false;
      delete r.deaths[id];
      return save();
    },

    /** Was this death resumed already? */
    wasResumed: (runId) => Boolean(load().resumed[baseRunId(runId)]),
    resumedOf: (runId) => copy(load().resumed[baseRunId(runId)] || null),
    /**
     * CLAIM THE RESUME of one death, before anything is queued. False when it
     * was claimed before (never resume the same death twice) or when the
     * claim could not be written: a claim that does not survive a restart is
     * a resume that could happen twice, so the caller queues nothing.
     */
    claimResume(runId, info = {}) {
      const id = baseRunId(runId);
      if (!id) return false;
      const r = load();
      if (r.resumed[id]) return false;
      r.resumed[id] = { ...info, at: now() };
      if (!save()) {
        delete r.resumed[id];
        return false;
      }
      return true;
    },
    /** The raw record, a copy, for a log line or a test. */
    snapshot: () => copy(load()),
  };
}
