// WHICH ACCOUNT A RUN SHOULD START ON, and why the others cannot take it.
//
// SHARED MODULE, byte-identical in the public and private bridge repos and
// listed in scripts/check-shared.sh. Pure by construction: the account list,
// the clock and the usage PROBE are all arguments, so the whole selection rule
// is unit testable with no network, no credential store and no daemon.
//
// ---------------------------------------------------------------------------
// THE INCIDENT THIS EXISTS FOR (2026-09-11 12:46 ET)
//
// hello@blackumbrella.app hit its session limit. The rotation marked it, asked
// accounts.mjs for the next account that was not limited IN THE LEDGER, and
// swapped straight onto gjgkabche@gmail.com, which had been out of usage
// credits since the night before. The retry died on it, the chat lane showed
// the raw "You're out of usage credits" card, two background workers died the
// same way, and only the death of that run taught the ledger anything.
//
// The gap was never the ledger. It was that a candidate was accepted on the
// ABSENCE of evidence: an account nothing had walled yet looked healthy, so
// each bad account cost one failed run to discover. The usage API already knew.
//
// So selection now asks before it moves. One GET per candidate, five seconds,
// and a candidate the API says is spent is walled in the ledger and skipped
// rather than tried. The loop then takes the next one, and the next, until one
// answers healthy or every account has been asked exactly once.
//
// ---------------------------------------------------------------------------
// WHAT "SPENT" MEANS, measured rather than assumed (live probe, same incident)
//
// The account that was out of usage credits reported this:
//
//   fiveHour  0%   no reset          (no five hour block was even open)
//   sevenDay  97%  severity critical resets 2026-09-12T04:59:59Z
//   scoped    Fable 100%             resets 2026-09-12T04:59:59Z
//   extraUsage disabled
//
// Read that carefully, because it kills the obvious rule. The five hour window
// was EMPTY and the weekly window had headroom. A check of `fiveHour >= 100 ||
// sevenDay >= 100` calls this account healthy and hops onto it, which is
// exactly the bug. The wall was the per-model WEEKLY SCOPED window at 100%.
//
// So every window the API reports counts, scoped ones included: five hour,
// weekly, and each weekly_scoped row. That matches what the rotation's own
// reset lookup already does with the same rows (bridge.mjs usageResetFor).
//
// Two deliberate judgements:
//
//   • 100 (or the server's own `locked` reason string) and nothing softer. The
//     95 tier that usageResetFor uses exists because the CLI and the API round
//     differently when a wall has ALREADY happened; here nothing has happened
//     yet, and skipping an account at 96% would wall a working subscription on
//     a rounding allowance.
//   • extraUsage being spent is NOT a wall on its own. Credits are the overflow
//     past a full window, so with a window still open they change nothing, and
//     with a window full the window above has already walled the account. On
//     the account that produced the "out of usage credits" wall, extra usage
//     was disabled entirely: it was never the signal.
//
// ---------------------------------------------------------------------------
// A PROBE THAT FAILS IS NOT A WALL
//
// An unreachable API, a timeout, an expired refresh token: none of those are
// evidence that an account is spent, and treating them as evidence would wall
// every account on this machine the moment the network blinked. An unreadable
// probe takes the candidate anyway and says so (`account_probe_failed`). The
// worst case is the behaviour that shipped before this file existed.
// ---------------------------------------------------------------------------

import { isLimited, nextAvailable, earliestReset } from './accounts.mjs';
import { resetsAtToMs } from './account-usage.mjs';

/** One candidate, one GET. The API aborts itself at 5s (account-usage.mjs). */
export const PROBE_TIMEOUT_MS = 5_000;

/** A window at or past this is spent. See the header for why not 95. */
export const EXHAUSTED_PERCENT = 100;

/**
 * How long an account is walled when the API says it is spent but gives no
 * usable reset clock. An hour, the same fallback parseResetTime uses for a wall
 * message with no time on it: long enough to stop a hop onto it now, short
 * enough that being wrong costs one more rotation rather than an afternoon.
 */
export const FALLBACK_WALL_SECONDS = 3600;

/**
 * Is this account spent, and until when? Pure: a usage row in, a verdict out.
 *
 * `row` is what account-usage.mjs produces for one slot:
 * { name, state, usage: { fiveHour, sevenDay, scoped[] }, error }.
 *
 * Returns { state: 'healthy' | 'exhausted' | 'unreadable', resetsAt, reason }
 * where resetsAt is epoch SECONDS (accounts.mjs's ledger unit) or null.
 */
export function probeVerdict(row, { now = Date.now() } = {}) {
  if (!row || row.state !== 'ok' || !row.usage) {
    return { state: 'unreadable', resetsAt: null, reason: String(row?.error || 'no usage reading') };
  }
  const u = row.usage;
  const windows = [
    u.fiveHour ? { ...u.fiveHour, label: 'the 5h window' } : null,
    u.sevenDay ? { ...u.sevenDay, label: 'the weekly window' } : null,
    // THE ONES THAT MATTER MOST, and the ones the obvious rule forgets. A
    // per-model weekly cap at 100% is what the "out of usage credits" wall
    // actually was.
    ...(Array.isArray(u.scoped) ? u.scoped : []).map((w) => ({
      ...w,
      label: `the weekly ${w?.label || 'scoped'} window`,
    })),
  ].filter(Boolean);

  const spent = windows.filter((w) => w.locked || Number(w.percent) >= EXHAUSTED_PERCENT);
  if (!spent.length) {
    return { state: 'healthy', resetsAt: null, reason: headroom(windows) };
  }

  // resetsAtToMs, not a second reader: this API has sent both ISO strings and
  // epoch numbers for the same field, and a parser that knows one of those
  // reads the other as far future or as NaN.
  const clocks = spent.map((w) => ({ w, ms: resetsAtToMs(w.resetsAt) })).filter((x) => Number.isFinite(x.ms));
  const future = clocks.filter((x) => x.ms > Number(now));

  if (future.length) {
    // The LATEST spent window, for the same reason usageResetFor takes the
    // latest: a five hour window back in two hours is worth nothing while the
    // weekly window is still full, and freeing the account at the earlier clock
    // just buys another death.
    const latest = future.reduce((a, b) => (b.ms > a.ms ? b : a));
    // CEIL, NOT FLOOR. The ledger is in whole seconds and isLimited() compares
    // `limitedUntil * 1000 > now` against a millisecond clock, so flooring a
    // reset 400ms from now records a wall that has ALREADY expired: the loop
    // below then hands the same candidate back, probes it again, and with `now`
    // frozen for the call it never terminates. Rounding up can only ever hold
    // an account back by under a second.
    return { state: 'exhausted', resetsAt: Math.ceil(latest.ms / 1000), reason: `${latest.w.label} is spent` };
  }

  if (clocks.length) {
    // Every spent window's reset is already in the past, so the reading is
    // stale rather than a wall. Healthy is the smallest claim the evidence
    // supports, and the same guard usageResetFor applies to a past reset: a
    // wall in the past is not a wall.
    return { state: 'healthy', resetsAt: null, reason: 'every spent window has already reset' };
  }

  // Spent with no readable clock at all (a `locked` reason and no resets_at).
  // Still spent: the server's own reason string outranks our missing clock.
  return { state: 'exhausted', resetsAt: null, reason: `${spent[0].label} is spent, with no reset time` };
}

/** The fullest window, named, so a healthy verdict says why it is healthy. */
function headroom(windows) {
  const readable = windows.filter((w) => Number.isFinite(Number(w.percent)));
  if (!readable.length) return 'no window is spent';
  const worst = readable.reduce((a, b) => (Number(b.percent) > Number(a.percent) ? b : a));
  return `${Math.round(Number(worst.percent))}% used on ${worst.label}`;
}

/**
 * PICK AN ACCOUNT TO RUN ON, probing each candidate before committing to it.
 *
 * `accounts` is the raw accounts.json list (read it AFTER marking the account
 * that just walled, so the wall is in the ledger this reads).
 * `activeName` is the account being rotated off; it is never returned.
 * `probe` is async (name) => usage row. Omit it and the old behaviour returns:
 * the first ledger-free candidate, unverified.
 * `onDecision` receives one record per decision, for the daemon log.
 *
 * Returns { outcome, name, account, walls, earliest, probed }:
 *   'selected'   `name` is safe to swap to, verified unless `probed` says the
 *                probe could not be read
 *   'all_walled' every account is walled; `earliest` is when the first frees
 *                up and `walls` is what this pass discovered
 *   'none'       there are no accounts enrolled at all
 */
export async function selectAccount({
  accounts = [],
  activeName = null,
  now = Date.now(),
  probe = null,
  onDecision = () => {},
} = {}) {
  const list = (accounts || []).filter((a) => a && a.name);
  // Walls this pass DISCOVERED, held locally so the very next turn of the loop
  // honours them without a disk write in the middle of it. The caller persists
  // them through markLimited; this overlay only keeps the loop honest.
  const found = new Map();
  const guessUntil = Math.floor(Number(now) / 1000) + FALLBACK_WALL_SECONDS;
  const view = () =>
    list.map((a) => (found.has(a.name) ? { ...a, limitedUntil: found.get(a.name).until } : a));
  const walls = () => [...found].map(([name, w]) => ({ name, ...w }));

  // SAID OUT LOUD ONCE, before any probe: an account the ledger already knows
  // is walled is never hopped onto and never costs a round trip. This is the
  // line that was missing from the 12:46 incident's log.
  for (const a of list) {
    if (a.name !== activeName && isLimited(a, now)) {
      onDecision({ decision: 'account_skipped_known_walled', account: a.name, until: Number(a.limitedUntil) || null });
    }
  }

  const probed = [];
  // TERMINATION, and it does NOT rest on the overlay being read back correctly.
  // The first version relied on "a name in `found` is filtered out by view()",
  // which was true for every wall except one whose reset lands inside the
  // current second: `limitedUntil` is whole seconds, isLimited() compares
  // milliseconds, and a wall rounded down below `now` reads as no wall at all,
  // so the same candidate came back forever with the clock frozen. The rounding
  // is fixed above; this is the guarantee that does not care. Asked once, ever.
  const asked = new Set();
  for (;;) {
    const cand = nextAvailable(view(), { activeName, now });
    if (!cand) break;
    if (asked.has(cand.name)) break;
    asked.add(cand.name);

    if (typeof probe !== 'function') {
      onDecision({ decision: 'account_selected', account: cand.name, reason: 'no probe wired' });
      return { outcome: 'selected', name: cand.name, account: cand, walls: walls(), earliest: null, probed };
    }

    let row = null;
    try {
      row = await probe(cand.name);
    } catch (e) {
      // A probe that THREW is a probe that could not be read, not a wall. The
      // verdict below reaches 'unreadable' from the null and says so.
      row = null;
    }
    const v = probeVerdict(row, { now });
    probed.push({ name: cand.name, state: v.state, reason: v.reason });

    if (v.state === 'exhausted') {
      // A wall the ledger would read as already expired is not a wall. Clamped
      // one second into the future, so the overlay, the persisted row and the
      // earliest-reset clock all agree that this account is out.
      const until = Math.max(v.resetsAt || guessUntil, Math.floor(Number(now) / 1000) + 1);
      found.set(cand.name, { until, reason: v.reason, guessed: !v.resetsAt });
      onDecision({
        decision: 'account_walled',
        account: cand.name,
        until,
        guessed: !v.resetsAt,
        reason: v.reason,
        source: 'probe',
      });
      continue;
    }

    if (v.state === 'unreadable') {
      onDecision({ decision: 'account_probe_failed', account: cand.name, reason: v.reason });
    }
    onDecision({ decision: 'account_selected', account: cand.name, reason: v.reason, verified: v.state === 'healthy' });
    return { outcome: 'selected', name: cand.name, account: cand, walls: walls(), earliest: null, probed };
  }

  // Nothing left. `earliest` reads the OVERLAID list, so a wall this pass just
  // discovered counts toward the clock the owner is told to wait for.
  const earliest = earliestReset(view(), now);
  if (!list.length) {
    onDecision({ decision: 'all_accounts_walled_until', until: null, count: 0, reason: 'no accounts enrolled' });
    return { outcome: 'none', name: null, account: null, walls: walls(), earliest: null, probed };
  }
  onDecision({ decision: 'all_accounts_walled_until', until: earliest, count: list.length });
  return { outcome: 'all_walled', name: null, account: null, walls: walls(), earliest, probed };
}
