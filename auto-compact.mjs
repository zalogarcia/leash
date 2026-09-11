// Automatic compaction of the chat session: the config and the decision.
//
// SHARED MODULE: byte-identical in the public and private bridge repos.
// scripts/check-shared.sh fails on drift. It owns no path, no transport and no
// owner-specific prose: the daemon measures the facts (the percentage, the
// queue, the clock) and this module only says whether they add up to a
// compaction. That is what keeps the rule testable without a Telegram token.
//
// THE RULE, as the owner stated it on 2026-09-11: "when you reach 60 percent
// plus of your context window you can auto compact if you are done with
// working." Every clause of `decideAutoCompact` is one reading of "done with
// working": nothing queued, nothing steered in, nothing asked and unanswered,
// the lane idle, and the run that just ended not itself a compaction. The
// cooldown is the one clause he did not ask for: a compaction whose summary
// is itself heavy, or one that fails, must not re-fire on the very next turn.

export const AUTO_COMPACT_DEFAULTS = Object.freeze({
  enabled: false,
  thresholdPercent: 60,
  cooldownMinutes: 30,
});

/**
 * The config block, made safe. `raw` is whatever config.json (or the
 * BRIDGE_AUTO_COMPACT env var, as JSON text) carried: an object, a JSON string,
 * a bare boolean, or nothing. Anything unreadable degrades to the defaults
 * rather than throwing at boot, and a threshold outside 1..100 or a negative
 * cooldown is replaced rather than honoured, because "compact at 0%" would
 * compact every turn and "compact at 250%" would never fire.
 */
export function autoCompactConfig(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('{')) {
      try {
        v = JSON.parse(s);
      } catch {
        v = null;
      }
    } else {
      v = s.toLowerCase() === 'true' || s === '1' ? { enabled: true } : null;
    }
  }
  if (typeof v === 'boolean') v = { enabled: v };
  if (!v || typeof v !== 'object') return { ...AUTO_COMPACT_DEFAULTS };
  const enabled = v.enabled === true || v.enabled === 'true' || v.enabled === 1;
  const threshold = Number(v.thresholdPercent);
  const cooldown = Number(v.cooldownMinutes);
  return {
    enabled,
    thresholdPercent:
      Number.isFinite(threshold) && threshold >= 1 && threshold <= 100 ? threshold : AUTO_COMPACT_DEFAULTS.thresholdPercent,
    cooldownMinutes: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : AUTO_COMPACT_DEFAULTS.cooldownMinutes,
  };
}

/**
 * The context percentage, from the same two numbers /status and /context use:
 * the token depth of the last main-thread assistant message and the model's
 * window. Null when either is missing: a fresh chat has no depth yet, and a
 * null must read as "cannot measure", never as 0%.
 */
export function contextPercent(tokens, window) {
  const t = Number(tokens);
  const w = Number(window);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(w) || w <= 0) return null;
  return Math.min(100, Math.round((t / w) * 100));
}

/**
 * The decision. Pure: every input is a fact the daemon already holds at the
 * close of a chat-lane run, and the output names either the compaction or the
 * one reason it is not happening. Reasons are stable tokens for the log line.
 *
 *   config         from autoCompactConfig
 *   lane           'main' for the chat lane; anything else never compacts
 *   wasCompaction  the run that just ended was itself the summary turn
 *   stopped        the run that just ended was cut short by /stop: the owner is
 *                  about to redirect, which is the opposite of "done working"
 *   engine         the chat lane's engine; only 'claude' has a session to compact
 *   hasSession     a session id exists (a fresh chat has nothing to compact)
 *   walled         the Claude engine is behind a limit wall right now
 *   pct            the measured context percentage, or null when unmeasurable
 *   laneBusy       a run already occupies the chat lane
 *   queued         messages waiting on the chat lane (the queue plus a gathering album)
 *   steerPending   mid-run instructions accepted but not yet acted on
 *   btwPending     side questions asked of the run and not yet answered
 *   lastCompactAt  epoch ms of the last compaction (manual or automatic), or null
 *   now            epoch ms
 *
 * Clause order is cheapest first and structural before measured, so the log
 * names the most fundamental reason when several apply: "disabled" beats
 * "below threshold", and "was a compaction" beats "lane busy".
 */
export function decideAutoCompact({
  config,
  lane = 'main',
  wasCompaction = false,
  stopped = false,
  engine = 'claude',
  hasSession = false,
  walled = false,
  pct = null,
  laneBusy = false,
  queued = 0,
  steerPending = 0,
  btwPending = 0,
  lastCompactAt = null,
  now = Date.now(),
} = {}) {
  const cfg = config || AUTO_COMPACT_DEFAULTS;
  const skip = (reason) => ({ compact: false, reason, pct });
  if (!cfg.enabled) return skip('disabled');
  if (lane !== 'main') return skip('bg_lane');
  if (wasCompaction) return skip('was_compaction');
  if (stopped) return skip('stopped');
  if (engine !== 'claude') return skip('codex_engine');
  if (!hasSession) return skip('no_session');
  if (walled) return skip('walled');
  if (!Number.isFinite(pct)) return skip('unmeasurable');
  if (pct < cfg.thresholdPercent) return skip('below_threshold');
  if (laneBusy) return skip('lane_busy');
  if (queued > 0) return skip('queued');
  if (steerPending > 0) return skip('steer_pending');
  if (btwPending > 0) return skip('btw_pending');
  if (lastCompactAt != null) {
    const cooldownMs = cfg.cooldownMinutes * 60_000;
    // "more than cooldownMinutes ago": at exactly the boundary it is still
    // inside the cooldown, so one whole window has to have passed.
    if (now - lastCompactAt <= cooldownMs) return skip('cooldown');
  }
  return { compact: true, reason: null, pct };
}

/** One line for the daemon log, the same shape for every outcome. */
export function autoCompactLogLine(decision) {
  if (!decision) return '[bridge] auto_compact_skipped reason=no_decision';
  const pct = Number.isFinite(decision.pct) ? ` pct=${decision.pct}` : '';
  return decision.compact
    ? `[bridge] auto_compact_started${pct}`
    : `[bridge] auto_compact_skipped reason=${decision.reason}${pct}`;
}
