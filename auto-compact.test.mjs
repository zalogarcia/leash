#!/usr/bin/env node
// Unit tests for the automatic compaction decision.
//
// The decision is one AND over a dozen facts, and the failure that matters is
// a compaction firing while the owner is mid-conversation: a summary turn
// that his next message has to queue behind. So every clause gets its own
// case, in both directions, and the cooldown boundary and the unmeasurable
// percentage get theirs, because those two are where an off-by-one turns
// "compact when idle" into "compact every turn".
//
//   node auto-compact.test.mjs

import {
  AUTO_COMPACT_DEFAULTS,
  autoCompactConfig,
  autoCompactLogLine,
  contextPercent,
  decideAutoCompact,
} from './auto-compact.mjs';

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
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const NOW = Date.parse('2026-09-11T13:05:00Z');
const ON = { enabled: true, thresholdPercent: 60, cooldownMinutes: 30 };

// Every clause satisfied. Each case below flips exactly one of these.
const ready = (extra = {}) => ({
  config: ON,
  lane: 'main',
  wasCompaction: false,
  stopped: false,
  engine: 'claude',
  hasSession: true,
  walled: false,
  pct: 63,
  laneBusy: false,
  queued: 0,
  steerPending: 0,
  btwPending: 0,
  lastCompactAt: null,
  now: NOW,
  ...extra,
});

// ---------------------------------------------------------------------------
console.log('\n1. the config block');

t('defaults: off, 60 percent, 30 minutes', () => {
  eq(AUTO_COMPACT_DEFAULTS.enabled, false);
  eq(AUTO_COMPACT_DEFAULTS.thresholdPercent, 60);
  eq(AUTO_COMPACT_DEFAULTS.cooldownMinutes, 30);
});

t('nothing configured reads as the defaults', () => {
  eq(autoCompactConfig(undefined).enabled, false);
  eq(autoCompactConfig(null).thresholdPercent, 60);
  eq(autoCompactConfig({}).cooldownMinutes, 30);
});

t('the block as written in config.json', () => {
  const c = autoCompactConfig({ enabled: true, thresholdPercent: 70, cooldownMinutes: 10 });
  eq(c.enabled, true);
  eq(c.thresholdPercent, 70);
  eq(c.cooldownMinutes, 10);
});

t('★ enabled is a real boolean: the string "false" does not turn it on', () => {
  eq(autoCompactConfig({ enabled: 'false' }).enabled, false);
  eq(autoCompactConfig({ enabled: 'true' }).enabled, true);
  eq(autoCompactConfig({ enabled: 0 }).enabled, false);
});

t('the env layer arrives as JSON text, or as a bare true', () => {
  eq(autoCompactConfig('{"enabled":true,"thresholdPercent":55}').thresholdPercent, 55);
  eq(autoCompactConfig('{"enabled":true}').enabled, true);
  eq(autoCompactConfig('true').enabled, true);
  eq(autoCompactConfig('false').enabled, false);
  eq(autoCompactConfig('{not json').enabled, false, 'garbage degrades to the defaults, never throws');
});

t('★ a threshold outside 1..100 is replaced, not honoured', () => {
  eq(autoCompactConfig({ enabled: true, thresholdPercent: 0 }).thresholdPercent, 60, '0 would compact every turn');
  eq(autoCompactConfig({ enabled: true, thresholdPercent: 250 }).thresholdPercent, 60, '250 would never fire');
  eq(autoCompactConfig({ enabled: true, thresholdPercent: 'lots' }).thresholdPercent, 60);
  eq(autoCompactConfig({ enabled: true, thresholdPercent: 100 }).thresholdPercent, 100, '100 is a legal ceiling');
});

t('a negative cooldown is replaced; zero is legal and means no cooldown', () => {
  eq(autoCompactConfig({ cooldownMinutes: -5 }).cooldownMinutes, 30);
  eq(autoCompactConfig({ cooldownMinutes: 0 }).cooldownMinutes, 0);
});

// ---------------------------------------------------------------------------
console.log('\n2. the percentage');

t('the same formula /status and /context print', () => {
  eq(contextPercent(630_000, 1_000_000), 63);
  eq(contextPercent(120_000, 200_000), 60);
  eq(contextPercent(1_750_000, 1_000_000), 100, 'capped, never over 100');
});

t('★ unmeasurable is null, never 0', () => {
  eq(contextPercent(0, 1_000_000), null, 'a fresh chat has no depth yet');
  eq(contextPercent(undefined, 1_000_000), null);
  eq(contextPercent(500_000, 0), null);
  eq(contextPercent('abc', 1_000_000), null);
});

// ---------------------------------------------------------------------------
console.log('\n3. the decision: every clause, both ways');

t('★ all clauses satisfied: compact, carrying the percentage', () => {
  const d = decideAutoCompact(ready());
  eq(d.compact, true);
  eq(d.reason, null);
  eq(d.pct, 63);
});

t('disabled', () => {
  eq(decideAutoCompact(ready({ config: { ...ON, enabled: false } })).reason, 'disabled');
  eq(decideAutoCompact(ready({ config: AUTO_COMPACT_DEFAULTS })).reason, 'disabled', 'the defaults are off');
});

t('★ a background lane never triggers it, whatever its numbers', () => {
  eq(decideAutoCompact(ready({ lane: 'bg', pct: 99 })).reason, 'bg_lane');
  eq(decideAutoCompact(ready({ lane: 'bg2' })).reason, 'bg_lane');
});

t('★ the run that just finished was itself the compaction', () => {
  eq(decideAutoCompact(ready({ wasCompaction: true })).reason, 'was_compaction');
});

t('★ a run he cut short with /stop never compacts: he is about to redirect, not done', () => {
  // The QA pass on this change: with the queue emptied by /stop, every other
  // clause passed, so the correction he typed next queued behind a summary
  // of the task he had just aborted.
  eq(decideAutoCompact(ready({ stopped: true })).reason, 'stopped');
  eq(decideAutoCompact(ready({ stopped: true, pct: 99 })).reason, 'stopped');
});

t('a Codex chat lane has no Claude session to compact', () => {
  eq(decideAutoCompact(ready({ engine: 'codex' })).reason, 'codex_engine');
});

t('a fresh chat has nothing to compact', () => {
  eq(decideAutoCompact(ready({ hasSession: false })).reason, 'no_session');
});

t('a walled engine would spend the summary turn on a limit', () => {
  eq(decideAutoCompact(ready({ walled: true })).reason, 'walled');
});

t('★ an unmeasurable percentage does nothing, and says so', () => {
  eq(decideAutoCompact(ready({ pct: null })).reason, 'unmeasurable');
  eq(decideAutoCompact(ready({ pct: undefined })).reason, 'unmeasurable');
  eq(decideAutoCompact(ready({ pct: NaN })).reason, 'unmeasurable');
});

t('★ the threshold: at it fires, one under does not', () => {
  eq(decideAutoCompact(ready({ pct: 60 })).compact, true, '60 is "60 percent plus"');
  eq(decideAutoCompact(ready({ pct: 59 })).reason, 'below_threshold');
  eq(decideAutoCompact(ready({ pct: 100 })).compact, true);
  eq(decideAutoCompact(ready({ pct: 75, config: { ...ON, thresholdPercent: 80 } })).reason, 'below_threshold');
});

t('the lane is busy again (a message landed during the close)', () => {
  eq(decideAutoCompact(ready({ laneBusy: true })).reason, 'lane_busy');
});

t('★ something is queued on the chat lane', () => {
  eq(decideAutoCompact(ready({ queued: 1 })).reason, 'queued');
  eq(decideAutoCompact(ready({ queued: 3 })).reason, 'queued');
});

t('a steer is pending', () => {
  eq(decideAutoCompact(ready({ steerPending: 1 })).reason, 'steer_pending');
});

t('a side question is unanswered', () => {
  eq(decideAutoCompact(ready({ btwPending: 2 })).reason, 'btw_pending');
});

t('★ the cooldown boundary: at exactly 30 minutes it still waits, one ms past it fires', () => {
  const cooldownMs = 30 * 60_000;
  eq(decideAutoCompact(ready({ lastCompactAt: NOW - cooldownMs })).reason, 'cooldown', 'exactly at the boundary');
  eq(decideAutoCompact(ready({ lastCompactAt: NOW - cooldownMs - 1 })).compact, true, 'one ms past it');
  eq(decideAutoCompact(ready({ lastCompactAt: NOW - 60_000 })).reason, 'cooldown', 'a minute ago');
  eq(decideAutoCompact(ready({ lastCompactAt: NOW })).reason, 'cooldown', 'just now');
});

t('a manual /compact counts for the cooldown exactly like an automatic one', () => {
  // The daemon stamps one field for both; the decision has no way to tell
  // them apart and must not need to.
  eq(decideAutoCompact(ready({ lastCompactAt: NOW - 5 * 60_000 })).reason, 'cooldown');
});

t('no compaction ever: no cooldown to wait out', () => {
  eq(decideAutoCompact(ready({ lastCompactAt: null })).compact, true);
  eq(decideAutoCompact(ready({ lastCompactAt: undefined })).compact, true);
});

t('a zero cooldown lets the next idle turn fire', () => {
  eq(decideAutoCompact(ready({ config: { ...ON, cooldownMinutes: 0 }, lastCompactAt: NOW - 1 })).compact, true);
  eq(decideAutoCompact(ready({ config: { ...ON, cooldownMinutes: 0 }, lastCompactAt: NOW })).reason, 'cooldown', 'the same ms is still inside');
});

t('★ structural reasons beat measured ones in the log', () => {
  eq(decideAutoCompact(ready({ config: { ...ON, enabled: false }, pct: 10 })).reason, 'disabled');
  eq(decideAutoCompact(ready({ wasCompaction: true, laneBusy: true })).reason, 'was_compaction');
  eq(decideAutoCompact(ready({ pct: null, queued: 2 })).reason, 'unmeasurable');
});

t('no input at all is a skip, not a throw', () => {
  eq(decideAutoCompact().reason, 'disabled');
  eq(decideAutoCompact({ config: ON }).reason, 'no_session');
});

// ---------------------------------------------------------------------------
console.log('\n4. the log line');

t('one shape for every outcome', () => {
  eq(autoCompactLogLine(decideAutoCompact(ready())), '[bridge] auto_compact_started pct=63');
  eq(autoCompactLogLine(decideAutoCompact(ready({ pct: 12 }))), '[bridge] auto_compact_skipped reason=below_threshold pct=12');
  eq(autoCompactLogLine(decideAutoCompact(ready({ pct: null }))), '[bridge] auto_compact_skipped reason=unmeasurable');
  eq(autoCompactLogLine(null), '[bridge] auto_compact_skipped reason=no_decision');
});

t('★ no dashes in any line this module writes', () => {
  for (const d of [decideAutoCompact(ready()), decideAutoCompact(ready({ pct: 5 })), null]) {
    ok(!/[–—]/.test(autoCompactLogLine(d)), autoCompactLogLine(d));
  }
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
