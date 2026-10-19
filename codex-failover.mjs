// Never replay a write job after it may have acted. A read-only request or a
// failure proven to precede tool activity can continue on the healthy engine.
export function codexFailoverPlan(outcome, { mode = 'edit', preActivity = false, claudeAvailable = false, claudePausedUntil = 0, now = Date.now(), bootstrap = false, retried = false } = {}) {
  if (retried || !claudeAvailable || Number(claudePausedUntil) > now) return null;
  if (outcome?.status !== 'failed' || !(['rate_limit', 'auth'].includes(outcome.failure) || bootstrap)) return null;
  if (!['ask', 'review'].includes(mode) && !preActivity) return null;
  return { engine: 'claude', reason: 'Codex is unavailable', readOnly: ['ask', 'review'].includes(mode) };
}
