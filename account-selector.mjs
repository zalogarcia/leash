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
// One account hit its session limit. The rotation marked it, asked
// accounts.mjs for the next account that was not limited IN THE LEDGER, and
// swapped straight onto a second one, which had been out of usage
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
//
// ---------------------------------------------------------------------------
// A WALL THE LEDGER HOLDS CAN BE LIFTED EARLY, on strong evidence only
// (2026-09-30)
//
// The owner bought a usage reset for one account. /account showed it at 5h 0%
// and weekly 0% and still "limited · 1d 0h", because the ledger held a weekly
// wall until the next day and nothing cleared a `limitedUntil` early: the
// selector skipped the account as known walled without asking, and with every
// account walled nothing asked at all. The slot was cleared by hand.
//
// So a walled account is re-checked, and cleared (the store's clearLimit) when
// its OWN fresh reading shows room on every window. The asymmetry with the
// section above is deliberate. A probe that fails does not wall an account,
// and it does not free one either: an unreadable probe is not proof of health.
// limitClearVerdict below lists what counts; everything else keeps the wall.
// The re-checks are rate limited (createRecheckLimiter), and setting the wall
// counts as its first check, so an account that just died is never freed a
// minute later by a reading that cannot see why it died.
//
// ---------------------------------------------------------------------------
// A PROBE THAT FAILS ON THE LOGIN IS NOT "UNREADABLE" (2026-09-30 18:22 ET)
//
// "A probe that fails is not a wall" was written for the network. It also let
// through a probe whose refresh the server REFUSED (invalid_grant): the account
// was selected with verified=false and swapped onto. A refused refresh, a
// refused token, a login past its own expiry: each says the account cannot take
// a run until the owner signs into it again, which is stronger evidence than a
// timeout and points the other way. So a candidate whose probe row carries a
// login problem (account-usage.mjs rowLoginProblem) is never selected, in the
// probe loop or the re-check loop; it is returned in `needsLogin` for the host
// to persist (accounts.mjs markNeedsLogin) and say once, and the loop moves on.
// A slot already flagged is skipped without a probe, like a known wall.
// ---------------------------------------------------------------------------

import { isLimited, nextAvailable, earliestReset, loginFlag } from './accounts.mjs';
import { resetsAtToMs, rowLoginProblem } from './account-usage.mjs';

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
 * A walled account is cleared only when EVERY window reads below this. Derived
 * from the two tiers the code already has: 100 is the wall (EXHAUSTED_PERCENT
 * above), and 95 is where the rotation treats a window as possibly the wall
 * because the CLI and the API round differently (bridge.mjs usageResetFor).
 * Ninety keeps the same five point step again below that tier, so a window the
 * rotation could still read as the wall is never the one that frees it. A paid
 * reset reads 0%, so the margin costs the case this exists for nothing.
 */
export const CLEAR_BELOW_PERCENT = 90;

/**
 * The oldest reading that may clear a wall. A lookup row is served from the
 * usage module's cache for at most its TTL (a minute), so a genuine read is
 * always well inside this; anything older is a belief, not a reading.
 */
export const CLEAR_EVIDENCE_MAX_AGE_MS = 3 * 60_000;

/**
 * How often a walled account may be re-checked, and how old a wall must be
 * before any reading may clear it. One number for both, because setting the
 * wall IS the first check: a death one minute ago is fresher evidence than a
 * window that cannot show why the account died, and an account freed that
 * soon is handed the next message to die on.
 */
export const RECHECK_INTERVAL_MS = 5 * 60_000;

// Epoch ms from what the ledger and the rows carry: ms numbers, or ISO strings
// (accounts.json `limitedVerifiedAt`). Anything else is NaN.
function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v) return Date.parse(v);
  return NaN;
}

/**
 * MAY THIS READING CLEAR THIS ACCOUNT'S WALL? Pure: a usage row in, a verdict
 * out. Returns { clear, reason }; when `clear` is true the reason carries the
 * numbers that justified it, for the decision line.
 *
 * Every rule here keeps the wall unless the evidence is strong:
 *   - no row, a failed lookup, or an ok row with no usage: a probe that fails
 *     is not proof of health
 *   - a row filed under another slot: another account's numbers are never
 *     this account's window (the same guard usageResetFor applies)
 *   - a live session reading (`source.kind` 'stream') rather than a lookup made
 *     with this slot's own token: whose it is was inferred, not proven, and it
 *     is at best as old as the last request made on the account
 *   - a reading with no `readAt`, older than CLEAR_EVIDENCE_MAX_AGE_MS, or
 *     from the future
 *   - a wall set less than RECHECK_INTERVAL_MS ago (`wallSetAt`)
 *   - a missing five hour or weekly window, any window locked, unreadable, or
 *     at or above CLEAR_BELOW_PERCENT, scoped per-model windows included
 */
export function limitClearVerdict(row, { name = null, now = Date.now(), wallSetAt = null, maxAgeMs = CLEAR_EVIDENCE_MAX_AGE_MS } = {}) {
  const keep = (reason) => ({ clear: false, reason });
  if (!row) return keep('no usage reading');
  if (!name || row.name !== name) return keep(`the reading belongs to "${row.name}", not this slot`);
  if (row.state !== 'ok' || !row.usage) return keep(String(row.error || 'the usage lookup failed'));
  if (row.source?.kind === 'stream') return keep("a live session reading, not a lookup made with this slot's own token");

  const t = Number(now);
  const set = toMs(wallSetAt);
  if (Number.isFinite(set) && t - set < RECHECK_INTERVAL_MS) {
    return keep(`the wall was set ${Math.max(0, Math.round((t - set) / 1000))}s ago`);
  }
  const at = toMs(row.readAt);
  if (!Number.isFinite(at)) return keep('the reading carries no time, so its age is unknown');
  if (at - t > 60_000) return keep('the reading is dated in the future');
  if (t - at > maxAgeMs) return keep(`the reading is ${Math.round((t - at) / 1000)}s old`);

  const u = row.usage;
  if (!u.fiveHour) return keep('the reading has no 5h window');
  if (!u.sevenDay) return keep('the reading has no weekly window');
  const windows = [
    { ...u.fiveHour, label: '5h' },
    { ...u.sevenDay, label: 'weekly' },
    ...(Array.isArray(u.scoped) ? u.scoped : []).map((w) => ({ ...w, label: `weekly ${w?.label || 'scoped'}` })),
  ];
  for (const w of windows) {
    if (w.locked) return keep(`the ${w.label} window is locked`);
    const p = w.percent === null || w.percent === undefined || w.percent === '' ? NaN : Number(w.percent);
    if (!Number.isFinite(p)) return keep(`the ${w.label} window is unreadable`);
    if (p >= CLEAR_BELOW_PERCENT) return keep(`the ${w.label} window is at ${Math.round(p)}%`);
  }
  return { clear: true, reason: windows.map((w) => `${w.label} ${Math.round(Number(w.percent))}%`).join(', ') };
}

/**
 * THE RE-CHECK RATE LIMIT: at most one extra probe per walled account per
 * RECHECK_INTERVAL_MS, counted from the later of its last re-check and the
 * moment its wall was set (`since`). In memory only: a daemon restart costs
 * one early re-check per account, never a storm.
 *
 * `take` records the attempt BEFORE the probe runs, so a probe that fails
 * spends its slot too: an unreachable API is re-asked on the same cadence as a
 * reachable one, not on every sweep.
 */
export function createRecheckLimiter({ intervalMs = RECHECK_INTERVAL_MS } = {}) {
  const last = new Map();
  const due = (name, now, { since = null } = {}) => {
    const prev = Math.max(last.get(name) ?? -Infinity, Number.isFinite(toMs(since)) ? toMs(since) : -Infinity);
    return Number(now) - prev >= intervalMs;
  };
  return {
    due,
    take(name, now, opts = {}) {
      if (!name || !due(name, now, opts)) return false;
      last.set(name, Number(now));
      return true;
    },
  };
}

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
 * `recheck` is a createRecheckLimiter(). With it, when no ledger-free
 * candidate has headroom, each account the ledger holds walled is re-checked
 * (at most once per RECHECK_INTERVAL_MS) and taken if limitClearVerdict clears
 * it. Omit it and a known wall is never asked about, as before.
 *
 * Returns { outcome, name, account, walls, cleared, needsLogin, earliest, probed }.
 * `needsLogin` is [{ name, reason }], the candidates whose probe showed a dead
 * login this pass; the CALLER persists them (markNeedsLogin) and tells the
 * owner, exactly as it persists `walls`. The outcomes:
 *   'selected'   `name` is safe to swap to, verified unless `probed` says the
 *                probe could not be read. When `cleared` names it, its ledger
 *                wall was lifted by a re-check and the CALLER persists that
 *                (clearLimit), exactly as it persists `walls` (markLimited)
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
  recheck = null,
} = {}) {
  const list = (accounts || []).filter((a) => a && a.name);
  // Walls this pass DISCOVERED, held locally so the very next turn of the loop
  // honours them without a disk write in the middle of it. The caller persists
  // them through markLimited; this overlay only keeps the loop honest.
  const found = new Map();
  // Logins this pass found dead, held the same way: overlaid so the loop never
  // hands the same candidate back, returned for the caller to persist.
  const deadLogins = new Map();
  const guessUntil = Math.floor(Number(now) / 1000) + FALLBACK_WALL_SECONDS;
  const view = () =>
    list.map((a) => {
      let v = found.has(a.name) ? { ...a, limitedUntil: found.get(a.name).until } : a;
      if (deadLogins.has(a.name) && !loginFlag(v)) v = { ...v, needsLogin: { reason: deadLogins.get(a.name) } };
      return v;
    });
  const walls = () => [...found].map(([name, w]) => ({ name, ...w }));
  const needsLogin = () => [...deadLogins].map(([name, reason]) => ({ name, reason }));
  const loginDead = (name, reason) => {
    deadLogins.set(name, reason);
    onDecision({ decision: 'account_needs_login', account: name, reason });
  };

  // SAID OUT LOUD ONCE, before any probe: an account the ledger already knows
  // is walled is never hopped onto and never costs a round trip. This is the
  // line that was missing from the 12:46 incident's log. The same for a slot
  // already flagged as needing a login.
  for (const a of list) {
    if (a.name === activeName) continue;
    if (loginFlag(a)) {
      onDecision({ decision: 'account_skipped_needs_login', account: a.name, reason: loginFlag(a).reason || null });
    } else if (isLimited(a, now)) {
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
      return { outcome: 'selected', name: cand.name, account: cand, walls: walls(), cleared: [], needsLogin: needsLogin(), earliest: null, probed };
    }

    let row = null;
    try {
      row = await probe(cand.name);
    } catch (e) {
      // A probe that THREW is a probe that could not be read, not a wall. The
      // verdict below reaches 'unreadable' from the null and says so.
      row = null;
    }
    // A LOGIN THE SERVER REFUSED is not an unreadable probe (see the header).
    // Checked before the verdict, which would call it 'unreadable' and take it.
    const dead = row && row.name === cand.name ? rowLoginProblem(row) : null;
    if (dead) {
      probed.push({ name: cand.name, state: 'needs-login', reason: dead });
      loginDead(cand.name, dead);
      continue;
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
    return { outcome: 'selected', name: cand.name, account: cand, walls: walls(), cleared: [], needsLogin: needsLogin(), earliest: null, probed };
  }

  // RE-CHECK THE KNOWN WALLS, only now that nothing ledger-free can take the
  // run: a paid reset, or a wall marked on the wrong account, is otherwise
  // invisible until the ledger's own clock runs out. The ORIGINAL ledger, in
  // file order: a wall this pass just discovered was asked seconds ago, and
  // `asked` keeps it out. The active account is never re-checked here, for the
  // same reason it is never selected: it is the one that just died.
  if (recheck && typeof recheck.take === 'function' && typeof probe === 'function') {
    for (const a of list) {
      if (a.name === activeName || !a.claudeAiOauth || asked.has(a.name) || !isLimited(a, now) || loginFlag(a)) continue;
      if (!recheck.take(a.name, now, { since: a.limitedVerifiedAt })) continue;
      asked.add(a.name);
      let row = null;
      try {
        row = await probe(a.name);
      } catch {
        row = null; // a probe that threw keeps the wall, see limitClearVerdict
      }
      // A refused login keeps the wall AND is said, so the owner learns the
      // account needs them before its wall even ends.
      const dead = row && row.name === a.name ? rowLoginProblem(row) : null;
      if (dead) {
        probed.push({ name: a.name, state: 'needs-login', reason: dead });
        loginDead(a.name, dead);
        continue;
      }
      const v = limitClearVerdict(row, { name: a.name, now, wallSetAt: a.limitedVerifiedAt });
      const wasUntil = Number(a.limitedUntil) || null;
      probed.push({ name: a.name, state: v.clear ? 'cleared' : 'kept', reason: v.reason });
      if (!v.clear) {
        onDecision({ decision: 'account_limit_kept', account: a.name, until: wasUntil, reason: v.reason });
        continue;
      }
      onDecision({ decision: 'account_limit_cleared_by_probe', account: a.name, wasUntil, reason: v.reason });
      return {
        outcome: 'selected',
        name: a.name,
        account: { ...a, limitedUntil: null },
        walls: walls(),
        cleared: [{ name: a.name, reason: v.reason }],
        needsLogin: needsLogin(),
        earliest: null,
        probed,
      };
    }
  }

  // Nothing left. `earliest` reads the OVERLAID list, so a wall this pass just
  // discovered counts toward the clock the owner is told to wait for.
  const earliest = earliestReset(view(), now);
  if (!list.length) {
    onDecision({ decision: 'all_accounts_walled_until', until: null, count: 0, reason: 'no accounts enrolled' });
    return { outcome: 'none', name: null, account: null, walls: walls(), cleared: [], needsLogin: needsLogin(), earliest: null, probed };
  }
  onDecision({ decision: 'all_accounts_walled_until', until: earliest, count: list.length });
  return { outcome: 'all_walled', name: null, account: null, walls: walls(), cleared: [], needsLogin: needsLogin(), earliest, probed };
}
