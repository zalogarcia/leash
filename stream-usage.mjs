// PLAN USAGE FROM THE LIVE SESSIONS: the newest rate_limit_event reading per
// Claude account, and the rule that decides whose reading it is.
//
// PRIVATE MODULE (not in scripts/check-shared.sh). The shared half is
// account-usage.mjs: normalizeRateLimitEvent turns an event into the usage
// shape, and createAccountUsage takes `streamReading` / `onUsage` hooks, which
// this module is the host side of.
//
// ---------------------------------------------------------------------------
// WHY
//
// /account reads each account's 5h and weekly windows from Anthropic's OAuth
// usage endpoint. From Claude Code 2.1.280 every Claude Code process on this
// Mac (the chat lane, each background worker, their subagents) polls that same
// endpoint on the live account's token, so on a busy day the endpoint answers
// the bridge 429 for up to an hour, and /account printed a warning where the
// bars should be (2026-09-27). Meanwhile every stream the bridge spawns carries
// the same numbers after each API response. This keeps the newest one per
// account, on disk, so /account can draw the bars from it.
//
// ---------------------------------------------------------------------------
// THE ATTRIBUTION RULE (whose reading is it)
//
// A reading does not say which account it belongs to. Two facts decide it:
//
//   1. A RUNNING CLAUDE CODE PROCESS FOLLOWS THE CREDENTIAL STORE. In 42 of 494
//      run logs (2026-09-27) the weekly reset changes mid run, and one run
//      flips between two accounts three times: a process picks up a swap (or a
//      drift revert) while it runs. So "the account live when the process was
//      spawned" is wrong for those runs, and the rule is EVENT TIME: the account
//      live in the credential store when the daemon parses the event
//      (createLiveAccountTracker, re-read every 15 s, identified per token
//      fingerprint through the same ladder /account uses, so a token the live
//      session refreshed keeps its account's name).
//
//   2. THE WEEKLY RESET IS AN IDENTITY MARK. Every account's seven_day window
//      resets at its own hour (every value in those 494 logs is on the hour,
//      and no two accounts share one), and a lookup that succeeds says which
//      reset belongs to which account for certain, because it was asked with
//      that account's token. learn() records it (the ANCHOR).
//
//   3. WITH NO ANCHOR TO PROVE IT, THE SPAWN ACCOUNT MUST AGREE. On a first
//      boot (no usage-stream.json) and for as long as every lookup is held on
//      a 429, there may be no anchors at all. A process then gets the live
//      account only if it was SPAWNED on the live account too (the tracker's
//      answer at spawn; unknown for a worker re-attached after a restart). A
//      process spawned on another account may still be on it (91% of runs
//      never change account), so its reading is doubtful and dropped.
//
// So, for a reading with weekly reset W, with only anchors whose week has not
// passed:
//   - exactly one account's anchor is W (within ANCHOR_TOLERANCE_MS): that
//     account, live or not. This is the process that has not picked up a swap
//     yet: its numbers go to the account it is really on, not the live one.
//   - several: the live account if it is one of them, else nobody.
//   - none: nobody if the live account has an anchor (W is not its week, so the
//     reading is some other login's); else the live account IF the process was
//     spawned on it, else nobody.
//   - no weekly window in the reading: the live account if the process was
//     spawned on it, else nobody.
//
// TWO ACCOUNTS ON ONE WEEKLY RESET (2026-10-08 20:52Z). Two accounts that
// renewed in the same hour carry the same weekly reset (c@ and b@ both
// reset at 2026-10-15T14:00Z), so for them the identity mark above says
// nothing, and "the live account if it is one of them" filed a session STILL
// on the outgoing account's credentials under the incoming one right after a
// swap: c@'s 5 hour wall (100 percent, reset 00:00Z) landed under b@
// (4 percent, reset 01:50Z), the usage wall guard read b@ at 100 percent
// and told six workers to save a checkpoint while b@ had 96 percent left.
// Two more facts settle the shared case:
//
//   4. THE OPEN FIVE HOUR WINDOW IS A SECOND MARK. A five hour window keeps
//      the reset it opened with until that reset passes, and a lookup made
//      with an account's own token says which one is its (learn() records it
//      beside the weekly anchor). Among the accounts sharing W, one whose open
//      five hour reset differs from the reading's is ruled out, and one whose
//      matches is the owner.
//   5. RIGHT AFTER A SWAP THE OUTGOING ACCOUNT IS STILL TALKING. Sessions pick
//      a swap up while they run, not at the instant it lands, so for
//      SWAP_GRACE_MS after a swap a shared reading the five hour mark cannot
//      settle, with the outgoing account among its owners, is dropped rather
//      than given to the live account (noteSwap). And past the grace, for as
//      long as the outgoing account's own five hour window stays open: at the
//      swap noteSwap keeps that window's reset (from its lookup anchor, else
//      from the reading held for it while it was live), and a shared reading
//      in exactly that window is the outgoing account's sessions, never the
//      live account's, however late it arrives. The swap record is persisted,
//      so a daemon restart inside the window keeps the rule.
//
// And a successful lookup repairs what event time got wrong: learn() moves a
// reading whose weekly reset is the new anchor out from under any other name
// (unless that name's own anchor vouches for it), and get() says whether a
// reading's identity is VERIFIED by its account's anchor, which is what the
// reader requires before it lets a reading replace a lookup outright.
// Dropping is always safe: the cost is a /account that shows the warning it
// showed before. Recording under the wrong name is the one failure that shows
// the owner another account's numbers, so every doubtful case drops.
//
// ---------------------------------------------------------------------------
// ON DISK: usage-stream.json beside the daemon, 0600, written through a temp
// file and a rename, coalesced (one write per PERSIST_DELAY_MS at most, not one
// per API call on every session) and flushed at shutdown, so a restart keeps
// both the readings and the anchors. No token is ever in it.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { normalizeRateLimitEvent, resetsAtToMs } from './account-usage.mjs';

// Two accounts' weekly resets are at least an hour apart (they are on the hour),
// and the endpoint's ISO carries a fraction of a second the event does not.
export const ANCHOR_TOLERANCE_MS = 5 * 60_000;
// Only a reading under half an hour old is ever drawn (account-usage.mjs,
// STREAM_FALLBACK_MAX_AGE_MS). A day is kept so a restart after a quiet
// evening still has the last one to show its age in a log line, and no more.
export const READING_KEEP_MS = 24 * 3600_000;
export const PERSIST_DELAY_MS = 5_000;
const FILE_VERSION = 1;

// Two five hour resets of ONE window differ only by the endpoint's fraction of
// a second; two accounts' windows open at their own minute. A minute apart is
// "the same window"; closer than that the mark cannot tell them apart and the
// other rules decide.
export const FIVE_HOUR_TOLERANCE_MS = 60_000;
// How long after a swap the outgoing account's sessions are assumed to still
// be on its credentials, for a reading only a shared weekly reset identifies.
export const SWAP_GRACE_MS = 10 * 60_000;

// The weekly reset of a normalized usage (event or endpoint), in ms, or null.
export function weeklyResetMs(usage) {
  const ms = resetsAtToMs(usage?.sevenDay?.resetsAt);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// The five hour reset of a normalized usage, in ms, or null (no window open).
export function fiveHourResetMs(usage) {
  const ms = resetsAtToMs(usage?.fiveHour?.resetsAt);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// THE RULE, pure. `anchors` is { name: { weeklyMs, fiveHourMs? } }; a
// `fiveHourMs` is the open five hour window's reset a lookup with that
// account's own token named. `recentSwap` is { from, to, at } for the last
// swap. Returns { name, why }, name null when the reading is nobody's we can
// prove.
export function attributeReading({ weeklyMs, fiveHourMs = null, liveName = null, spawnName = null, anchors = {}, now = Date.now(), recentSwap = null }) {
  const live = Object.entries(anchors || {}).filter(([, a]) => Number(a?.weeklyMs) > Number(now));
  // The live account, when nothing but the clock says so: only for a process
  // that was spawned on it.
  const byEventTime = (why) => {
    if (!liveName) return { name: null, why: 'no live account known' };
    if (spawnName !== liveName) return { name: null, why: 'spawned on another or an unknown account, no anchor to prove it' };
    return { name: liveName, why };
  };
  if (weeklyMs === null || weeklyMs === undefined) return byEventTime('live account, no weekly window to check');
  const owners = live.filter(([, a]) => Math.abs(Number(a.weeklyMs) - weeklyMs) <= ANCHOR_TOLERANCE_MS).map(([n]) => n);
  if (owners.length === 1) return { name: owners[0], why: 'weekly reset matches' };
  if (owners.length > 1) {
    // THE FIVE HOUR MARK (rule 4). An owner's open window, known from its own
    // lookup and not yet reset, either is the reading's window or rules the
    // owner out. Unknown on either side, it says nothing.
    const fh = Number(fiveHourMs) > Number(now) ? Number(fiveHourMs) : null;
    const openOf = (n) => {
      const v = Number(anchors[n]?.fiveHourMs);
      return Number.isFinite(v) && v > Number(now) ? v : null;
    };
    const same = (n) => fh !== null && openOf(n) !== null && Math.abs(openOf(n) - fh) <= FIVE_HOUR_TOLERANCE_MS;
    const ruledOut = (n) => fh !== null && openOf(n) !== null && Math.abs(openOf(n) - fh) > FIVE_HOUR_TOLERANCE_MS;
    const confirmed = owners.filter(same);
    if (confirmed.length === 1) return { name: confirmed[0], why: 'weekly reset shared, five hour reset matches' };
    const left = owners.filter((n) => !ruledOut(n));
    if (!left.length) return { name: null, why: 'weekly reset shared, every owner\'s five hour window rules it out' };
    if (left.length === 1) return { name: left[0], why: 'weekly reset shared, the other owners\' five hour windows rule them out' };
    if (!left.includes(liveName)) return { name: null, why: 'weekly reset shared by accounts that are not live' };
    // RULE 5. The outgoing account's sessions are still finishing their turns.
    const sw = recentSwap && typeof recentSwap === 'object' ? recentSwap : null;
    const fromOpen = sw && Number(sw.fromFiveHourMs) > Number(now) ? Number(sw.fromFiveHourMs) : null;
    if (sw && sw.from && sw.from !== liveName && left.includes(sw.from) && fh !== null && fromOpen !== null && Math.abs(fromOpen - fh) <= FIVE_HOUR_TOLERANCE_MS) {
      return { name: null, why: 'weekly reset shared, five hour window is the one the account swapped away from has open' };
    }
    if (sw && sw.from && sw.from !== liveName && left.includes(sw.from) && Number(now) - Number(sw.at) < SWAP_GRACE_MS) {
      return { name: null, why: 'weekly reset shared with the account swapped away from moments ago' };
    }
    return { name: liveName, why: 'weekly reset shared, live account among them' };
  }
  if (liveName && live.some(([n]) => n === liveName)) return { name: null, why: 'weekly reset is not the live account\'s' };
  return byEventTime('live account');
}

const matches = (a, b) => a !== null && b !== null && Math.abs(a - b) <= ANCHOR_TOLERANCE_MS;

export function createStreamUsage({
  file,
  now = () => Date.now(),
  log = (m) => console.log(`[stream-usage] ${m}`),
  persistDelayMs = PERSIST_DELAY_MS,
} = {}) {
  if (!file) throw new Error('createStreamUsage: a `file` is required');
  // name -> { usage, at }, and name -> { weeklyMs, fiveHourMs, at }.
  const readings = new Map();
  const anchors = new Map();
  let dirty = false;
  let timer = null;
  // The last swap the daemon made, { from, to, at }: rule 5 in the header. In
  // memory only; a restart inside the grace costs at most one reading filed by
  // the shared-reset rule alone, which the five hour mark still checks.
  let recentSwap = null;

  // Load, pruning what can no longer be used. Anything unexpected starts empty:
  // a missing number here costs a warning line on /account, never the daemon.
  (function load() {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return; // first run
    }
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      log(`${file} is not JSON, starting empty`);
      return;
    }
    if (!j || typeof j !== 'object' || j.version !== FILE_VERSION) return;
    const t = now();
    // The last swap (rule 5), while either half of it can still act: the grace,
    // or the outgoing account's open five hour window.
    const sw = j.swap && typeof j.swap === 'object' ? j.swap : null;
    if (sw && (sw.from || sw.to) && Number.isFinite(Number(sw.at))) {
      const fromFh = Number(sw.fromFiveHourMs);
      const open = Number.isFinite(fromFh) && fromFh > t ? fromFh : null;
      if (t - Number(sw.at) < SWAP_GRACE_MS || open !== null) {
        recentSwap = { from: sw.from ? String(sw.from) : null, to: sw.to ? String(sw.to) : null, at: Number(sw.at), fromFiveHourMs: open };
      }
    }
    for (const [name, r] of Object.entries(j.readings || {})) {
      if (r && r.usage && Number.isFinite(Number(r.at)) && t - Number(r.at) <= READING_KEEP_MS) {
        readings.set(name, { usage: r.usage, at: Number(r.at) });
      } else dirty = true;
    }
    for (const [name, a] of Object.entries(j.anchors || {})) {
      if (a && Number(a.weeklyMs) > t) {
        const fh = Number(a.fiveHourMs);
        anchors.set(name, { weeklyMs: Number(a.weeklyMs), fiveHourMs: Number.isFinite(fh) && fh > t ? fh : null, at: Number(a.at) || null });
      }
      else dirty = true;
    }
  })();

  function write() {
    const body = {
      version: FILE_VERSION,
      readings: Object.fromEntries(readings),
      anchors: Object.fromEntries(anchors),
      ...(recentSwap ? { swap: recentSwap } : {}),
    };
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return false;
    try {
      write();
      dirty = false;
      return true;
    } catch (e) {
      log(`could not write ${file}: ${e.message}`);
      return false;
    }
  }

  function persistSoon() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, persistDelayMs);
    timer.unref?.();
  }

  function anchorView() {
    return Object.fromEntries([...anchors].map(([n, a]) => [n, { weeklyMs: a.weeklyMs, fiveHourMs: a.fiveHourMs ?? null }]));
  }

  // Does this reading's open five hour window contradict the one `name`'s own
  // lookup named? Only an open window on both sides can contradict.
  function fiveHourContradicts(name, usage, t) {
    const a = anchors.get(name);
    const mine = Number(a?.fiveHourMs);
    const theirs = fiveHourResetMs(usage);
    if (!(Number.isFinite(mine) && mine > t) || !(theirs !== null && theirs > t)) return false;
    return Math.abs(mine - theirs) > FIVE_HOUR_TOLERANCE_MS;
  }

  return {
    // One parsed stream event. Returns { name, why }: who it was recorded
    // under, or name null and why not. Never throws.
    note(ev, { liveName = null, spawnName = null } = {}) {
      let usage = null;
      try {
        usage = normalizeRateLimitEvent(ev);
      } catch {
        usage = null;
      }
      if (!usage) return { name: null, why: 'not a usable rate_limit_event' };
      const t = now();
      const who = attributeReading({
        weeklyMs: weeklyResetMs(usage),
        fiveHourMs: fiveHourResetMs(usage),
        liveName: liveName || null,
        spawnName: spawnName || null,
        anchors: anchorView(),
        now: t,
        recentSwap,
      });
      if (!who.name) return who;
      const prev = readings.get(who.name);
      if (prev && prev.at > t) return { name: null, why: 'a newer reading is already held' };
      readings.set(who.name, { usage, at: t });
      persistSoon();
      return who;
    },

    // A successful lookup's numbers for `name`: the weekly reset they carry is
    // that account's for certain. A held reading that contradicts it was never
    // this account's, so it goes.
    learn(name, usage) {
      if (!name) return;
      const w = weeklyResetMs(usage);
      const t = now();
      if (w === null || w <= t) return;
      // The open five hour window rides along (rule 4): null when none is
      // open, which is also what a window that has since reset reads as.
      const f = fiveHourResetMs(usage);
      const fh = f !== null && f > t ? f : null;
      const prev = anchors.get(name);
      if (!prev || prev.weeklyMs !== w || (prev.fiveHourMs ?? null) !== fh) {
        anchors.set(name, { weeklyMs: w, fiveHourMs: fh, at: t });
        persistSoon();
      }
      const held = readings.get(name);
      const hw = held ? weeklyResetMs(held.usage) : null;
      if (hw !== null && !matches(hw, w)) {
        readings.delete(name);
        log(`dropped the live session reading held for "${name}": its weekly reset is another account's`);
        persistSoon();
      } else if (held && fiveHourContradicts(name, held.usage, t)) {
        // The same weekly reset, another account's open five hour window: the
        // reading came from a session on the account this one shares its week
        // with (the 2026-10-08 swap), so it was never this account's.
        readings.delete(name);
        log(`dropped the live session reading held for "${name}": its five hour window is another account's`);
        persistSoon();
      }
      // The other direction: a reading filed under ANOTHER name whose weekly
      // reset is this anchor is provably this account's. It moves here (with
      // its own receive time) unless something newer is already here, and is
      // left alone where that name's own anchor vouches for it (two accounts
      // on one weekly reset).
      for (const [other, r] of [...readings]) {
        if (other === name || !matches(weeklyResetMs(r.usage), w)) continue;
        const theirs = anchors.get(other);
        if (theirs && theirs.weeklyMs > t && matches(theirs.weeklyMs, w)) continue;
        readings.delete(other);
        const mine = readings.get(name);
        if (!mine || mine.at < r.at) readings.set(name, r);
        log(`moved a live session reading from "${other}" to "${name}": its weekly reset is "${name}"'s`);
        persistSoon();
      }
    },

    // The newest reading for `name`, { usage, at, verified, consistent }, or
    // null.
    // `verified`: the account's own anchor (a lookup made with its token)
    // agrees with the reading's weekly reset, so its identity is proven rather
    // than inferred from the clock.
    // `consistent`: false when the reading's open five hour window is not the
    // one the account's own lookup named. Anything that ACTS on a reading (the
    // usage wall guard, the automatic account switch) skips an inconsistent
    // one: it is another account's numbers whatever its weekly reset says.
    get(name) {
      if (!name) return null;
      const r = readings.get(name);
      if (!r) return null;
      const t = now();
      const a = anchors.get(name);
      const verified = !!a && a.weeklyMs > t && matches(weeklyResetMs(r.usage), a.weeklyMs);
      return { usage: r.usage, at: r.at, verified, consistent: !fiveHourContradicts(name, r.usage, t) };
    },

    // The daemon swapped the live login (rule 5 in the header). Readings only a
    // shared weekly reset identifies are not given to `to` for SWAP_GRACE_MS
    // while `from` shares that reset.
    //
    // The outgoing account's open five hour window rides along: its own lookup
    // anchor when it has one, else the reading held for it while it was live.
    noteSwap({ from = null, to = null, at = now() } = {}) {
      const t = now();
      let fromFiveHourMs = null;
      if (from) {
        const own = Number(anchors.get(from)?.fiveHourMs);
        const held = fiveHourResetMs(readings.get(from)?.usage);
        if (Number.isFinite(own) && own > t) fromFiveHourMs = own;
        else if (held !== null && held > t) fromFiveHourMs = held;
      }
      recentSwap = from || to ? { from: from || null, to: to || null, at: Number(at), fromFiveHourMs } : null;
      persistSoon();
    },

    // The last swap noted, or null. For a log line and the tests.
    lastSwap() {
      return recentSwap ? { ...recentSwap } : null;
    },

    // Everything held, for a live probe or a log line. Numbers only.
    snapshot() {
      return {
        readings: Object.fromEntries([...readings].map(([n, r]) => [n, { at: r.at, fiveHour: r.usage.fiveHour?.percent ?? null, sevenDay: r.usage.sevenDay?.percent ?? null }])),
        anchors: Object.fromEntries([...anchors].map(([n, a]) => [n, a.weeklyMs])),
        fiveHour: Object.fromEntries([...anchors].filter(([, a]) => a.fiveHourMs).map(([n, a]) => [n, a.fiveHourMs])),
      };
    },

    flush,
  };
}

// ---------------------------------------------------------------------------
// WHICH ACCOUNT IS LIVE, cheaply enough to ask per event.
//
// current() is synchronous: it returns the last resolved name and, once that
// is older than ttlMs, starts ONE refresh in the background. A refresh reads
// the credential store (which is what sees a swap) and names the token's
// account through resolveActive, the ladder /account uses (fingerprint, then
// the profile email). A token's account never changes, so the answer is
// memoized per fingerprint and the ladder, which can cost a profile call, runs
// once per token rather than once per refresh.
//
// Anything it cannot establish is null, never the previous name: a stale name
// is how a reading would be recorded under the wrong account.
// ---------------------------------------------------------------------------
export function createLiveAccountTracker({
  readCredentials,
  resolveActive,
  fingerprint,
  now = () => Date.now(),
  ttlMs = 15_000,
  maxMemo = 32,
} = {}) {
  const byFp = new Map();
  let cur = { name: null, at: -Infinity };
  let pending = null;
  // Bumped by invalidate(), so a refresh that began before a swap and lands
  // after it cannot write the outgoing account's name back.
  let gen = 0;

  async function resolve() {
    const live = await readCredentials();
    const oauth = live?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    const fp = fingerprint(oauth);
    if (byFp.has(fp)) return byFp.get(fp);
    const a = await resolveActive();
    const name = a?.name || null;
    if (name && a.liveFingerprint === fp) {
      byFp.set(fp, name);
      if (byFp.size > maxMemo) byFp.delete(byFp.keys().next().value);
    }
    return name;
  }

  function refresh() {
    if (pending) return pending;
    const mine = gen;
    const p = resolve()
      .catch(() => null)
      .then((name) => {
        if (mine !== gen) return cur.name; // superseded by a swap
        cur = { name: name || null, at: now() };
        pending = null;
        return cur.name;
      });
    pending = p;
    return p;
  }

  return {
    current() {
      if (now() - cur.at >= ttlMs) refresh();
      return cur.name;
    },
    refresh,
    // The live account just changed (a swap, a drift re-assert). Forget the
    // name now and resolve again: readings in the few ms before that lands are
    // dropped, which is the safe side, rather than filed under the old name.
    invalidate() {
      gen++;
      pending = null;
      cur = { name: null, at: -Infinity };
      refresh();
    },
  };
}
