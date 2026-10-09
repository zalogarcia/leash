// SWITCH CLAUDE ACCOUNTS BEFORE THE LIMIT, AND ON A SCHEDULE.
//
// SHARED MODULE, byte-identical in the public and private bridge repos and
// listed in scripts/check-shared.sh. Pure by construction: the readings, the
// account list and the clock are all arguments, so every rule here is unit
// tested with no network, no credential store and no daemon. The daemon half
// (where the readings come from, the probe, the swap, the notice) is in
// bridge.mjs (`autoSwitchTick`, `switchAccountNow`).
//
// ---------------------------------------------------------------------------
// THE GAP THIS CLOSES (2026-10-07 to 10-08)
//
// The rotation moves the login only when a run DIES on a limit. The live
// account sat at 94 to 95 percent of its week for a day and never reached 100,
// so nothing moved it. Two other accounts reset at 14:00Z with whole weeks
// free, and the login stayed where it was until the owner typed `/account` by
// hand, while six scheduled jobs that wait for "the live account under 85
// percent" kept rescheduling themselves. The owner's words: "you should be
// able to schedule an account switch ... so I don't have to be doing that".
//
// ---------------------------------------------------------------------------
// THE RULES, and why each is the shape it is
//
// SWITCH BEFORE THE LIMIT (autoSwitchDecision). The live account at or past a
// threshold on its five hour window (fiveHourThreshold, 90) or on any weekly
// window (weekThreshold, 90, the per model weekly windows included), and
// another account FREE: the login moves to the free account with the most
// weekly headroom. The rotation's 100 percent rule stays the wall; this is the
// step before it, so the wall is the exception and not the schedule.
//
// "FREE" IS PROVEN, NEVER ASSUMED (candidateVerdict). A candidate counts only
// on a lookup made with its OWN token in the last few minutes (the same
// evidence the rotation's re-check demands before it lifts a wall), every
// window under the thresholds. A live session reading never counts (whose it
// is was inferred), an unreadable lookup never counts (a dead API is not
// health), and a slot flagged as needing a login is never even asked. A window
// whose reset has already passed reads as empty: that is the "reset time
// already in the past" case, and the fresh lookup is what proves it.
//
// NO FLAPPING. Three things together:
//   1. a switch happens only while the LIVE account is over a threshold, and
//      only onto an account under every threshold, so the account just left
//      (still over) is never a candidate for the way back;
//   2. once switched, it stays until the new account itself crosses a
//      threshold, which is rule 1 read from the other side;
//   3. for SETTLE_MS after any swap (this one, the owner's, the rotation's)
//      nothing switches automatically: the sessions still on the outgoing
//      account report its numbers for a while after a swap (2026-10-08
//      20:52Z, where exactly such a reading was filed under the new account),
//      and a decision made on them would hop straight back.
//
// RE-CHECK RIGHT AFTER A KNOWN RESET (probeDue). A candidate is asked at most
// every PROBE_EVERY_MS while the live account is over a threshold, and once
// more the moment a reset that blocked it passes, so an account whose week
// resets at 14:00 is taken within one poll cycle of 14:00, not up to five
// minutes later.
//
// A SCHEDULED OR ASKED-FOR SWITCH (switchTargetVerdict) names its account.
// Refused, with the reason, when the name is not a stored account, the slot
// has no captured login or needs a fresh one, or the account is walled (the
// ledger, or a fresh lookup showing a spent window). An account merely over
// the automatic thresholds is allowed with a note: the owner chose it.
//
// ---------------------------------------------------------------------------

import { resetsAtToMs, rowLoginProblem, fmtResetClock } from './account-usage.mjs';
import { clip, oneLine } from './progress-render.mjs';

/**
 * The defaults, which are also what a missing `accountAutoSwitch` block in
 * config.json means: the switch is ON with these values unless it is turned off.
 */
export const AUTO_SWITCH_DEFAULTS = Object.freeze({
  enabled: true,
  weekThreshold: 90,
  fiveHourThreshold: 90,
});

// A threshold under this is a typo (9 for 90 would switch on a tenth of a
// window). One hundred is legal and means "only at the wall itself", which the
// rotation already covers.
export const THRESHOLD_MIN = 50;
export const THRESHOLD_MAX = 100;

/** No automatic switch for this long after any swap. See NO FLAPPING. */
export const SETTLE_MS = 5 * 60_000;
/** How often one candidate is asked while the live account is over a threshold. */
export const PROBE_EVERY_MS = 5 * 60_000;
/**
 * The oldest lookup that may count as proof a candidate is free. A lookup row
 * is cached for a minute, so a genuine read is well inside this.
 */
export const EVIDENCE_MAX_AGE_MS = 3 * 60_000;

const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));
const bool = (v, fallback) => (v === true || v === false ? v : fallback);
const clampThreshold = (v, fallback) => {
  const n = num(v);
  return Number.isFinite(n) ? Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, n)) : fallback;
};

/**
 * The settings, normalized. `raw` is config.json's `accountAutoSwitch`: an
 * object, `false` (the off switch; the strings "false", "off", "0" and "no"
 * mean the same, for an environment override), or absent (the defaults).
 * Anything unparseable falls back to the default, never to "off".
 */
export function autoSwitchSettings(raw) {
  const d = AUTO_SWITCH_DEFAULTS;
  if (raw === false || (typeof raw === 'string' && /^(false|off|0|no)$/i.test(raw.trim()))) return { ...d, enabled: false };
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: bool(r.enabled, d.enabled),
    weekThreshold: clampThreshold(r.weekThreshold, d.weekThreshold),
    fiveHourThreshold: clampThreshold(r.fiveHourThreshold, d.fiveHourThreshold),
  };
}

/**
 * One line for /status. `last` is the last switch this daemon made by itself
 * or on a schedule, { to, at, via } with `at` in ms, or null.
 */
export function autoSwitchStatusLine(settings, { last = null, timeZone, now = Date.now() } = {}) {
  const s = settings || AUTO_SWITCH_DEFAULTS;
  if (!s.enabled) return '🔀 Account auto switch: off';
  const head = `🔀 Account auto switch: at ${s.fiveHourThreshold}% of 5h · ${s.weekThreshold}% of the week`;
  if (!last || !last.to || !Number.isFinite(num(last.at))) return head;
  const via = last.via === 'schedule' ? ' (schedule)' : last.via === 'command' ? ' (command)' : '';
  return `${head} · last ${fmtResetClock(num(last.at), { timeZone, now })} to ${clip(oneLine(last.to), 28)}${via}`;
}

/**
 * Every window of one usage reading, with the threshold that applies to it:
 * { kind, label, percent, resetsAtMs, stale, threshold }. `stale` means its
 * reset has already passed, so it reads as empty. A `locked` window reads as
 * 100. A window with no readable percent is left out.
 */
export function usageWindows(usage, settings = AUTO_SWITCH_DEFAULTS, now = Date.now()) {
  if (!usage || typeof usage !== 'object') return [];
  const s = settings || AUTO_SWITCH_DEFAULTS;
  const all = [
    usage.fiveHour ? { kind: 'fiveHour', label: 'the 5 hour window', short: '5h', w: usage.fiveHour, threshold: s.fiveHourThreshold } : null,
    usage.sevenDay ? { kind: 'sevenDay', label: 'the weekly window', short: 'week', w: usage.sevenDay, threshold: s.weekThreshold } : null,
    ...(Array.isArray(usage.scoped) ? usage.scoped : []).map((w) =>
      w ? { kind: `scoped:${w.label || 'scoped'}`, label: `the weekly ${w.label || 'scoped'} window`, short: `week ${w.label || 'scoped'}`, w, threshold: s.weekThreshold } : null,
    ),
  ].filter(Boolean);
  const out = [];
  for (const { kind, label, short, w, threshold } of all) {
    let percent = w.locked ? 100 : num(w.percent);
    if (!Number.isFinite(percent)) continue;
    const ms = resetsAtToMs(w.resetsAt);
    const resetsAtMs = Number.isFinite(ms) && ms > 0 ? ms : null;
    const stale = resetsAtMs !== null && resetsAtMs <= Number(now);
    if (stale) percent = 0;
    out.push({ kind, label, short, percent, resetsAtMs, stale, threshold });
  }
  return out;
}

/** The windows at or past their threshold. Empty when the reading is under every one. */
export function overThreshold(usage, settings = AUTO_SWITCH_DEFAULTS, now = Date.now()) {
  return usageWindows(usage, settings, now).filter((w) => w.percent >= w.threshold);
}

/** The fullest weekly window (the flat one and the per model ones), or null. */
export function weekPercent(usage, now = Date.now()) {
  const w = usageWindows(usage, AUTO_SWITCH_DEFAULTS, now).filter((x) => x.kind !== 'fiveHour');
  return w.length ? Math.max(...w.map((x) => x.percent)) : null;
}

/** The five hour window, or null. */
export function fiveHourPercent(usage, now = Date.now()) {
  const w = usageWindows(usage, AUTO_SWITCH_DEFAULTS, now).find((x) => x.kind === 'fiveHour');
  return w ? w.percent : null;
}

/** "5h 34% · week 18%", the two numbers a switch notice carries per account. */
export function readingLine(usage, now = Date.now()) {
  const f = fiveHourPercent(usage, now);
  const wk = weekPercent(usage, now);
  const bits = [];
  if (f !== null) bits.push(`5h ${Math.round(f)}%`);
  if (wk !== null) bits.push(`week ${Math.round(wk)}%`);
  return bits.length ? bits.join(' · ') : 'no reading';
}

/**
 * IS THIS CANDIDATE FREE? A usage row from account-usage.mjs in, a verdict
 * out: { free, reason, needsLogin?, blockedUntilMs?, usage? }.
 *
 * Free only on strong evidence (see the header): a lookup made with this
 * slot's own token (`row.name === name`, not a stream reading), readable,
 * no more than `maxAgeMs` old, every window under its threshold.
 * `blockedUntilMs` is when the windows that keep it out reset (the latest of
 * them), for the re-check right after.
 */
export function candidateVerdict(row, { name = null, settings = AUTO_SWITCH_DEFAULTS, now = Date.now(), maxAgeMs = EVIDENCE_MAX_AGE_MS } = {}) {
  const keep = (reason, extra = {}) => ({ free: false, reason, ...extra });
  if (!row) return keep('no usage lookup');
  if (!name || row.name !== name) return keep(`the reading belongs to "${row.name}", not this slot`);
  const dead = rowLoginProblem(row);
  if (dead) return keep(`its login needs renewing (${dead})`, { needsLogin: dead });
  if (row.state !== 'ok' || !row.usage) return keep(`its usage could not be read (${oneLine(String(row.error || 'the lookup failed'))})`);
  if (row.source?.kind === 'stream') return keep("a live session reading, not a lookup made with this slot's own token");
  const at = num(row.readAt);
  if (!Number.isFinite(at)) return keep('the lookup carries no time, so its age is unknown');
  if (at - Number(now) > 60_000) return keep('the lookup is dated in the future');
  if (Number(now) - at > maxAgeMs) return keep(`the lookup is ${Math.round((Number(now) - at) / 1000)}s old`);
  const over = overThreshold(row.usage, settings, now);
  if (over.length) {
    const worst = over.reduce((a, b) => (b.percent > a.percent ? b : a));
    const clocks = over.map((w) => w.resetsAtMs).filter((v) => v !== null);
    return keep(`${worst.label} is at ${Math.round(worst.percent)}%`, {
      blockedUntilMs: clocks.length === over.length ? Math.max(...clocks) : null,
      usage: row.usage,
    });
  }
  return { free: true, reason: readingLine(row.usage, now), usage: row.usage };
}

/**
 * The free candidate with the most weekly headroom: the lowest weekly figure,
 * then the lowest five hour figure, then list order. `free` is
 * [{ name, verdict, order }] with every verdict free.
 */
export function pickTarget(free, now = Date.now()) {
  const list = (free || []).filter((c) => c && c.name && c.verdict?.free);
  if (!list.length) return null;
  const key = (c) => [weekPercent(c.verdict.usage, now) ?? 0, fiveHourPercent(c.verdict.usage, now) ?? 0, Number(c.order) || 0];
  return list.slice().sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  })[0];
}

/**
 * IS A CANDIDATE DUE FOR A LOOKUP? `lastProbeAt` is when it was last asked
 * (ms, or null for never), `blockedUntilMs` when the windows that kept it out
 * reset (or the ledger's wall ends). Due when never asked, right after its
 * known reset passes (once), or after the interval.
 */
export function probeDue({ lastProbeAt = null, blockedUntilMs = null, now = Date.now(), everyMs = PROBE_EVERY_MS } = {}) {
  const last = num(lastProbeAt);
  if (!Number.isFinite(last)) return true;
  const until = num(blockedUntilMs);
  if (Number.isFinite(until) && until <= Number(now) && last < until) return true;
  return Number(now) - last >= everyMs;
}

/**
 * THE DECISION, pure. Returns { switch, reason, from, to, over, target, why }.
 *
 * `active` is { name, usage } for the live account, `usage` from evidence the
 * caller has already checked is this account's (see bridge.mjs). `candidates`
 * is [{ name, verdict, order, resetPassed }], one per other stored account the
 * caller looked at; `resetPassed` says a reset that had kept it out has just
 * passed, which is the notice's reason. `lastSwitchAt` is the last swap of any
 * kind (ms). When `switch` is false, `reason` says why, for the log.
 */
export function autoSwitchDecision({ settings = AUTO_SWITCH_DEFAULTS, active = null, candidates = [], now = Date.now(), lastSwitchAt = null, settleMs = SETTLE_MS } = {}) {
  const s = settings || AUTO_SWITCH_DEFAULTS;
  const no = (reason, extra = {}) => ({ switch: false, reason, from: active?.name || null, to: null, over: [], target: null, why: null, ...extra });
  if (!s.enabled) return no('off');
  if (!active?.name) return no('the live account is not identified');
  if (!active.usage) return no('no usable reading for the live account');
  const over = overThreshold(active.usage, s, now);
  if (!over.length) return no('below the thresholds');
  const since = num(lastSwitchAt);
  if (Number.isFinite(since) && Number(now) - since < settleMs) {
    return no(`a swap landed ${Math.max(0, Math.round((Number(now) - since) / 1000))}s ago, settling`, { over });
  }
  const others = (candidates || []).filter((c) => c && c.name && c.name !== active.name);
  const free = others.filter((c) => c.verdict?.free);
  if (!free.length) {
    const why = others.map((c) => `${c.name}: ${c.verdict?.reason || 'not asked'}`).join('; ');
    return no(`no other account is free${why ? ` (${why})` : ''}`, { over });
  }
  const target = pickTarget(free, now);
  return {
    switch: true,
    reason: `${active.name} at ${over.map((w) => `${Math.round(w.percent)}% of ${w.label}`).join(', ')}; ${target.name} free (${target.verdict.reason})`,
    from: active.name,
    to: target.name,
    over,
    target,
    why: target.resetPassed ? 'reset' : 'threshold',
  };
}

/**
 * MAY THE LOGIN MOVE TO THIS NAMED ACCOUNT? For a scheduled switch and for the
 * local command. `rows` is the store's describe() list, `row` a fresh lookup
 * for the target (or null when none could be made). Returns
 * { ok, name, noop?, note?, reason?, refusal? } where `refusal` is one of
 * 'unknown', 'no-login', 'needs-login', 'walled' when `ok` is false.
 */
export function switchTargetVerdict({ target = '', rows = [], activeName = null, row = null, settings = AUTO_SWITCH_DEFAULTS, now = Date.now(), timeZone } = {}) {
  const want = String(target || '').trim().toLowerCase();
  const refuse = (refusal, reason, name = null) => ({ ok: false, name, refusal, reason });
  if (!want) return refuse('unknown', 'no account was named');
  const list = (rows || []).filter((r) => r && r.name);
  const slot = list.find((r) => r.name.toLowerCase() === want || String(r.email || '').toLowerCase() === want);
  if (!slot) {
    const names = list.map((r) => r.name).join(', ');
    return refuse('unknown', `"${clip(oneLine(target), 40)}" is not a stored account${names ? ` (stored: ${names})` : ''}`);
  }
  if (!slot.captured) return refuse('no-login', `${slot.name} has no captured login`, slot.name);
  if (slot.needsLogin) return refuse('needs-login', `${slot.name} needs a fresh login (${slot.needsLogin.reason || 'refused'})`, slot.name);
  if (slot.limited) {
    const until = num(slot.limitedUntil);
    const clock = Number.isFinite(until) && until > 0 ? fmtResetClock(until * 1000, { timeZone, now }) : 'an unknown time';
    return refuse('walled', `${slot.name} is at its limit until ${clock}`, slot.name);
  }
  if (slot.name === activeName) return { ok: true, name: slot.name, noop: true, note: 'already the live account' };
  if (row && row.name === slot.name) {
    const dead = rowLoginProblem(row);
    if (dead) return refuse('needs-login', `${slot.name} needs a fresh login (${dead})`, slot.name);
    if (row.state === 'ok' && row.usage && row.source?.kind !== 'stream') {
      const spent = usageWindows(row.usage, settings, now).filter((w) => !w.stale && w.percent >= 100);
      if (spent.length) {
        const latest = spent.reduce((a, b) => ((b.resetsAtMs || 0) > (a.resetsAtMs || 0) ? b : a));
        const clock = latest.resetsAtMs ? fmtResetClock(latest.resetsAtMs, { timeZone, now }) : 'an unknown time';
        return refuse('walled', `${slot.name} has spent ${latest.label} until ${clock}`, slot.name);
      }
      const over = overThreshold(row.usage, settings, now);
      const line = readingLine(row.usage, now);
      return {
        ok: true,
        name: slot.name,
        usage: row.usage,
        note: over.length ? `${line}, already past the automatic switch threshold` : line,
      };
    }
  }
  return { ok: true, name: slot.name, note: 'its usage could not be read just now' };
}

const VIA_LABEL = { auto: 'automatic', schedule: 'scheduled', command: 'by command' };

/**
 * ONE MESSAGE PER SWITCH, in the daemon's house style: icon, label, value; one
 * fact per line; the middle dot as the only separator.
 *
 * `via` is 'auto', 'schedule' or 'command'. `why` is 'threshold' (the live
 * account crossed a threshold), 'reset' (a reset made another account free) or
 * 'schedule' / 'command'. `over` is the windows that crossed, `fromUsage` and
 * `toUsage` the readings the decision used. `scheduleId` names the entry.
 */
export function autoSwitchNotice({ from = null, to = '', via = 'auto', why = 'threshold', over = [], fromUsage = null, toUsage = null, scheduleId = null, note = null, now = Date.now() } = {}) {
  const head = via === 'schedule' && scheduleId != null ? `scheduled #${scheduleId}` : VIA_LABEL[via] || 'automatic';
  const lines = [`🔀 Claude account switched · ${head}`];
  lines.push(`⬅️ From: ${from ? clip(oneLine(from), 40) : 'an unidentified login'}${fromUsage ? ` · ${readingLine(fromUsage, now)}` : ''}`);
  lines.push(`➡️ To: ${clip(oneLine(to), 40)}${toUsage ? ` · ${readingLine(toUsage, now)}` : ''}`);
  const crossed = (over || []).map((w) => `${Math.round(w.percent)}% of ${w.label} (threshold ${w.threshold}%)`).join(' · ');
  if (why === 'reset') lines.push(`❓ Why: a reset freed ${clip(oneLine(to), 40)}${crossed ? ` · ${crossed}` : ''}`);
  else if (why === 'schedule') lines.push('❓ Why: you scheduled it');
  else if (why === 'command') lines.push('❓ Why: asked for by command');
  else lines.push(`❓ Why: ${crossed || 'past the threshold'}`);
  if (note) lines.push(`📝 Note: ${clip(oneLine(note), 80)}`);
  lines.push('🔁 Running jobs follow the new login');
  return lines.join('\n');
}

/** ONE MESSAGE for a scheduled or asked-for switch onto the account already live. */
export function alreadyOnNotice({ name = '', via = 'schedule', scheduleId = null } = {}) {
  const head = via === 'schedule' && scheduleId != null ? `scheduled #${scheduleId}` : VIA_LABEL[via] || 'automatic';
  return [`🔀 Claude account switch · ${head}`, `✅ Already on: ${clip(oneLine(name), 40)}`, '💤 Nothing changed'].join('\n');
}

/** ONE MESSAGE for a switch that was refused or failed, same style. */
export function switchRefusedNotice({ target = '', via = 'schedule', scheduleId = null, reason = '', stillOn = null } = {}) {
  const head = via === 'schedule' && scheduleId != null ? `scheduled #${scheduleId}` : VIA_LABEL[via] || 'automatic';
  const lines = [`🚫 Claude account switch refused · ${head}`];
  lines.push(`👤 Target: ${clip(oneLine(target), 40) || 'none named'}`);
  lines.push(`❓ Why: ${clip(oneLine(reason), 120) || 'refused'}`);
  lines.push(`↩️ Still on: ${stillOn ? clip(oneLine(stillOn), 40) : 'the same login'}`);
  return lines.join('\n');
}
