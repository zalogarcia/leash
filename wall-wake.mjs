// THE WAKE-UP AT THE LIFT OF AN ALL-ACCOUNTS WALL, as state.
//
// When every Claude account is limited the daemon raises one wall and waits for
// the earliest reset. On 2026-09-30 the reset came at 16:30Z, the login was
// swapped and the parked chats and jobs flushed, and the chat session woke a
// minute later only because a capped handback chain happened to be waiting:
// with nothing parked, the workers that died on the wall stayed dead until the
// user typed.
//
// One EPISODE per wall, persisted in `wall-wake.json` next to `bg-held.json`, so
// a daemon restart during the wall still wakes the chat session once at the
// lift, and a lift that already woke it does not wake it again after a
// restart. It records:
//
//   • which account the login moved to at wall time (the one with the earliest
//     KNOWN reset, pickNextAccount below), so the move is tried once per wall;
//   • every background worker that ended while the wall was up, with its report
//     and draft paths and whether its handback was held for the wake-up or
//     already delivered;
//   • when the wake-up was claimed, which is what makes it once only.
//
// Pure except for the one JSON file, whose path the daemon passes in. The
// decisions about WHEN to wake live in bridge.mjs (liftClaudeWall); this module
// only keeps the record they read and write.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

/**
 * Ledger provenance that means "the reset clock is a guess". A wall learned by
 * a probe with no reset clock, or by a death whose message carried none and
 * whose usage lookup could not supply one.
 */
export const RESET_UNKNOWN_SOURCES = new Set(['guessed', 'probe (no reset clock)']);

/** How many ended workers one episode remembers. A wall that kills more is a runaway. */
export const WALL_WAKE_WORKERS_MAX = 20;

/**
 * A wall raised this soon after the last wake-up was claimed is the same outage
 * continuing: the wake-up most likely landed in it (a reset that was a guess,
 * an account that walled again under the wake turn, which as a priority turn is
 * never retried). Its workers and the capped chain's reports carry into the
 * new episode, so the next wake-up still names them.
 */
export const WALL_WAKE_CARRY_MS = 15 * 60_000;

/**
 * THE NEXT ACCOUNT, when every captured account is walled: the one whose reset
 * is earliest. Returns { name, until (epoch seconds), guessed } or null.
 *
 * Never an account whose reset is a guess while another has a known clock: a
 * guessed hour out can sort ahead of a real reset twenty minutes later, and
 * moving the login onto it would make the next run spend its first minutes
 * finding that out. When EVERY clock is a guess the earliest guess is still the
 * best bet, and `guessed` says so. Null when any captured account is free (that
 * is not an all-accounts wall) or when nothing walled carries a clock at all.
 *
 * `rows` is accounts.mjs describe(): { name, captured, limited, limitedUntil,
 * limitedSource, needsLogin }. Ties keep ledger order, so the pick is
 * deterministic. A slot that needs a login is never the next account: its wall
 * ending frees nothing, and moving the login onto it hands the next run a dead
 * login (2026-09-30).
 */
export function pickNextAccount(rows = [], now = Date.now()) {
  const captured = (rows || []).filter((r) => r && r.name && r.captured !== false && !r.needsLogin);
  if (!captured.length) return null;
  if (captured.some((r) => !r.limited)) return null;
  const walled = captured.filter((r) => Number(r.limitedUntil) > 0 && Number(r.limitedUntil) * 1000 > now);
  if (!walled.length) return null;
  const known = walled.filter((r) => !RESET_UNKNOWN_SOURCES.has(r.limitedSource));
  const pool = known.length ? known : walled;
  let best = pool[0];
  for (const r of pool) if (Number(r.limitedUntil) < Number(best.limitedUntil)) best = r;
  return { name: best.name, until: Number(best.limitedUntil), guessed: !known.length };
}

const isEpisode = (e) => Boolean(e) && typeof e === 'object' && Number(e.raisedAt) > 0 && Array.isArray(e.workers);

/**
 * The episode store. One file, rewritten whole (tmp then rename) on every
 * change, read once and then held in memory: the daemon is its only writer.
 *
 * A write that fails is logged and the in-memory record still moves on, so one
 * process never wakes the chat twice; the cost of the failure is only that a restart
 * could repeat a wake-up, which is recoverable where a missed one is the bug.
 */
export function createWallWake({ file, log = () => {} } = {}) {
  let ep = null;
  let loaded = false;

  function load() {
    if (loaded) return ep;
    loaded = true;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      ep = isEpisode(raw) ? raw : null;
    } catch {
      ep = null; // no file, or a half-written one: no episode
    }
    return ep;
  }

  function save() {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(ep, null, 2));
      renameSync(tmp, file);
      return true;
    } catch (e) {
      log(`could not write ${file}: ${e.message}`);
      return false;
    }
  }

  const snapshot = (e) => (e ? { ...e, workers: e.workers.map((w) => ({ ...w })) } : null);

  return {
    file,
    /** The episode as it stands, or null. A copy: edits go through the methods. */
    current: () => snapshot(load()),
    /** A wall episode whose wake-up has not run yet. */
    pending: () => {
      const e = load();
      return Boolean(e && !e.wokeAt);
    },
    /**
     * THE WALL WENT UP. A new episode, unless one is still waiting for its
     * wake-up: a wall raised again before the last one's wake ran (a reset that
     * turned out to be wrong, a restart mid wall) is the same outage, and the
     * workers it already lost must still be in the note when it finally lifts.
     */
    raised({ until = null, now = Date.now() } = {}) {
      const e = load();
      if (e && !e.wokeAt) {
        e.until = Number(until) || e.until || null;
        e.updatedAt = now;
        // A wall raised again after the user vouched for a login is that login
        // walling too: the vouch no longer stands in for a free account.
        e.vouchedAt = null;
        e.vouchedFor = null;
      } else {
        const carry = e && now - Number(e.wokeAt) < WALL_WAKE_CARRY_MS;
        ep = {
          v: 1,
          raisedAt: now,
          updatedAt: now,
          until: Number(until) || null,
          next: null,
          moveTried: null,
          movedTo: null,
          movedAt: null,
          // CARRIED ROWS ARE MARKED: nothing records whether that wake-up
          // reached the chat, so the next one must not claim they never did.
          // The chat may already have relaunched them (QA round 3).
          workers: carry ? e.workers.map((w) => ({ ...w, listedAt: w.listedAt || e.wokeAt })) : [],
          carried: carry ? { from: e.raisedAt, wokeAt: e.wokeAt, parked: [...(e.carried?.parked || []), ...(e.parked || [])].map((p) => ({ ...p, listedAt: p.listedAt || e.wokeAt })) } : null,
          wokeAt: null,
          via: null,
          vouchedAt: null,
          vouchedFor: null,
        };
      }
      save();
      return snapshot(ep);
    },
    /**
     * The wall-time move was TRIED for this account (once per account per
     * wall, so a failing keychain is not asked every minute).
     */
    moveTried(name, next = null) {
      const e = load();
      if (!e || e.wokeAt) return false;
      e.moveTried = name;
      if (next) e.next = next;
      save();
      return true;
    },
    /**
     * THE USER CHOSE A LOGIN BY HAND during the wall (/account <name>, the
     * button, a capture). The ledger still walls every account, since no row
     * was touched, but the user can see something the bridge cannot: the lift
     * treats that choice as free, so the wake-up runs and the held handbacks
     * reach the chat instead of waiting hours for a ledger clock. Cleared if
     * the wall goes up again.
     */
    vouched({ name = null, now = Date.now() } = {}) {
      const e = load();
      if (!e || e.wokeAt) return false;
      e.vouchedAt = now;
      e.vouchedFor = name || null;
      save();
      return true;
    },
    /** The login is on `name` now. `at` is null when it already was. */
    moved(name, at = null) {
      const e = load();
      if (!e || e.wokeAt) return false;
      e.movedTo = name;
      e.movedAt = at;
      save();
      return true;
    },
    /**
     * A background worker ended during the wall. Keyed by runId, so the same
     * worker recorded twice (a death and then its held handback) is one row.
     */
    worker(rec = {}) {
      const e = load();
      if (!e || e.wokeAt || !rec.runId) return false;
      const i = e.workers.findIndex((w) => w.runId === rec.runId);
      if (i >= 0) e.workers[i] = { ...e.workers[i], ...rec };
      else if (e.workers.length < WALL_WAKE_WORKERS_MAX) e.workers.push({ ...rec });
      else return false;
      save();
      return true;
    },
    /**
     * CLAIM THE WAKE-UP. Once per episode: returns the episode and marks it
     * woke (persisted BEFORE the caller dispatches anything, the order
     * maybeRestartWakeUp uses), or null when there is nothing to claim.
     */
    claim({ via = null, now = Date.now(), parked = [] } = {}) {
      const e = load();
      if (!e || e.wokeAt) return null;
      e.wokeAt = now;
      e.via = via;
      // What the capped chain handed this wake-up, kept so a wake-up that dies
      // can carry it forward (WALL_WAKE_CARRY_MS).
      e.parked = (parked || []).map((p) => ({ ...p }));
      save();
      return snapshot(e);
    },
  };
}
