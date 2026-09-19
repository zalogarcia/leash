// tg-governor.mjs
//
// EVERY WRITE TO THE OWNER'S CHAT GOES THROUGH ONE GOVERNOR.
//
// On 2026-09-19 Telegram answered every sendMessage to the owner chat with
// `429 retry after 8687` for two and a half hours. The bridge waited out
// penalties only up to five minutes, so four of M's answers were logged as
// "RESULT NOT DELIVERED" and thrown away while the chat kept showing
// "Chewing…". Nothing in the daemon's own log showed a burst before the wall,
// because the daemon never logged a successful write: typing pulses every 3s,
// progress edits every 6s per lane, worker notices every 15s, plus mail-watch,
// devi-watch and ad hoc worker curls, all against the same per-chat bucket and
// none of them aware of the others.
//
// Four things, one module, so they share one clock and one file set:
//
//   1. A TOKEN BUCKET for chat writes. Telegram's own guidance is one message
//      per second per chat with short bursts tolerated. The bucket refills at
//      that rate, holds a small burst, and keeps one token in reserve that only
//      a real message may spend: typing and edits are dropped when the bucket
//      is low, so no combination of lanes can push the chat over the ceiling
//      and the liveness chrome can never starve the answer.
//
//   2. A SHARED COOLDOWN. Any 429 from any method sets a deadline in
//      `tg-throttle.json`. Every writer in this process reads it before every
//      write, and every writer OUTSIDE it (mail-watch, devi-watch, a worker's
//      curl) can read the same file, so one penalty stops the whole fleet from
//      spending into it. A later deadline written by another process is adopted.
//
//   3. A PERSISTENT OUTBOX. A message the owner must read (sendMessage,
//      sendRichMessage) that meets a cooldown is held in `tg-outbox.json`, not
//      dropped, and flushed oldest first at a polite spacing once the deadline
//      passes, behind one header line that says how long the chat was throttled.
//      The file survives a daemon restart; so does the deadline.
//
//   4. A LEDGER. `tg-ledger.jsonl` records every write with its outcome, so the
//      next long ban can be traced back to what was sent in the minutes before
//      it. `/status` shows the last ten minutes.
//
// The module owns no network code: `deliver(method, payload)` is injected and
// so are the clock and the sleep, which is what makes every branch testable
// in milliseconds. See tg-governor.test.mjs.

import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Methods that write into a chat and therefore spend the chat's budget. */
export const CHAT_WRITE_METHODS = new Set([
  'sendMessage',
  'sendRichMessage',
  'sendDocument',
  'sendPhoto',
  'sendVoice',
  'sendAudio',
  'sendVideo',
  'sendAnimation',
  'sendMediaGroup',
  'sendSticker',
  'copyMessage',
  'forwardMessage',
  'editMessageText',
  'editMessageCaption',
  'editMessageReplyMarkup',
  'editMessageMedia',
  'deleteMessage',
  'sendChatAction',
  'pinChatMessage',
  'unpinChatMessage',
]);

/** Text the owner must read. Held when throttled, never dropped. */
export const QUEUEABLE_METHODS = new Set(['sendMessage', 'sendRichMessage']);

/** Liveness chrome. Stale by the time a penalty clears, so never held. */
export const DISPOSABLE_METHODS = new Set([
  'sendChatAction',
  'editMessageText',
  'editMessageCaption',
  'editMessageReplyMarkup',
  'editMessageMedia',
  'deleteMessage',
]);

export const DEFAULTS = Object.freeze({
  ratePerSec: 1, // Telegram: "avoid sending more than one message per second" per chat
  burst: 3, // "short bursts" are tolerated; three is a report's worth of chunks
  reserve: 1, // tokens a disposable write may never spend
  maxItems: 200, // outbox cap; oldest dropped past it, and logged
  maxAgeMs: 24 * 3600_000, // an answer older than a day is not an answer any more
  flushEveryMs: 5_000, // how often the flusher looks at the outbox
  flushGapMs: 1_100, // spacing between flushed messages: just under 1/s
  ledgerMax: 5_000, // lines kept in tg-ledger.jsonl
  ledgerTrimEvery: 500, // appends between trims
  inlineWaitMaxMs: 10_000, // a 429 this short is waited out in place; longer ones queue
  maxAttempts: 5, // flush attempts per item on network/5xx errors before it is dropped
  windowMs: 10 * 60_000, // the /status summary window
  dropLogEveryMs: 30_000, // one ledger line per method per this for repeated drops; the window still counts every one
  fallbackRetryAfterSec: 5, // a 429 with no retry_after
  noticeEveryMs: 15 * 60_000, // at most one "held until" notice per this, and only when he writes
});

const MSG_LIMIT = 4000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plain text for an HTML payload Telegram refused to parse. */
export const stripTags = (s) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file); // never a half-written file for another process to read
}

/**
 * @param {object} o
 * @param {string} o.chatId          the owner chat; only writes to it are governed
 * @param {function} o.deliver       async (method, payload) => result; throws {code, retryAfter, description}
 * @param {string} o.outboxFile      tg-outbox.json
 * @param {string} o.throttleFile    tg-throttle.json (shared with other processes)
 * @param {string} o.ledgerFile      tg-ledger.jsonl
 */
export function createGovernor(o) {
  const cfg = { ...DEFAULTS, ...(o.config || {}) };
  const chatId = String(o.chatId);
  const nameOf = () => (typeof o.name === 'function' ? o.name() : o.name) || 'M';
  const deliver = o.deliver;
  const now = o.now || Date.now;
  const sleep = o.sleep || defaultSleep;
  const log = o.log || ((s) => console.error(s));
  const plainOf = o.plainOf || stripTags;
  const fmtTime =
    o.fmtTime ||
    ((ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: o.timeZone }));
  const { outboxFile, throttleFile, ledgerFile } = o;
  if (!deliver || !outboxFile || !throttleFile || !ledgerFile) {
    throw new Error('createGovernor needs deliver, outboxFile, throttleFile and ledgerFile');
  }

  // ---- token bucket ---------------------------------------------------------
  let tokens = cfg.burst;
  let lastRefill = now();
  function refill() {
    const t = now();
    if (t > lastRefill) tokens = Math.min(cfg.burst, tokens + ((t - lastRefill) / 1000) * cfg.ratePerSec);
    lastRefill = t;
  }
  /** Messages always get a token, going into debt if they must; the debt is the wait. */
  function acquire(disposable) {
    refill();
    if (disposable) {
      if (tokens >= 1 + cfg.reserve) {
        tokens -= 1;
        return { ok: true, waitMs: 0 };
      }
      return { ok: false, waitMs: Math.ceil(((1 + cfg.reserve - tokens) / cfg.ratePerSec) * 1000) };
    }
    tokens -= 1;
    const waitMs = tokens < 0 ? Math.ceil((-tokens / cfg.ratePerSec) * 1000) : 0;
    return { ok: true, waitMs };
  }

  // ---- shared cooldown ------------------------------------------------------
  let cooldownUntil = 0;
  let throttleInfo = null; // { until, retryAfter, method, at, source }
  let throttleMtime = 0;
  let lastThrottleSync = 0;
  function syncThrottleFile(force = false) {
    const t = now();
    if (!force && t - lastThrottleSync < 1000) return;
    lastThrottleSync = t;
    let m = 0;
    try {
      m = statSync(throttleFile).mtimeMs;
    } catch {
      return;
    }
    if (m === throttleMtime) return;
    throttleMtime = m;
    const j = readJson(throttleFile);
    const until = Number(j?.until) || 0;
    // A deadline already in the past is history, not a cooldown: adopting it
    // would start an "episode" days long and put that number in the header.
    if (until > cooldownUntil && until > t) {
      const fresh = t >= cooldownUntil && !items.length; // the previous episode, if any, is over
      cooldownUntil = until;
      throttleInfo = { until, retryAfter: j.retryAfter, method: j.method, at: j.at, source: j.source || 'other' };
      if (!throttledSince || fresh) {
        throttledSince = Number(j.at) || t;
        headerSent = false;
      }
      log(`[bridge] telegram cooldown adopted from ${throttleInfo.source}: until ${fmtTime(until)}`);
    }
  }
  function coolingDown() {
    syncThrottleFile();
    return now() < cooldownUntil;
  }
  function remainingMs() {
    return Math.max(0, cooldownUntil - now());
  }
  /** Record a 429. `retryAfterSec` is Telegram's number; +1s of slack, and never shorter than the current deadline. */
  function throttle(retryAfterSec, method, source = 'bridge') {
    const ra = Number(retryAfterSec) > 0 ? Number(retryAfterSec) : cfg.fallbackRetryAfterSec;
    const t = now();
    const until = t + (ra + 1) * 1000;
    // An episode runs from its first 429 until the outbox drains. A wall that
    // opens after the previous one expired with nothing held is a NEW episode,
    // so the header measures this wall and not the days since the last one.
    if (!throttledSince || (t >= cooldownUntil && !items.length)) {
      throttledSince = t;
      headerSent = false;
    }
    throttledCount++;
    if (until > cooldownUntil + 5000 || !throttleInfo) {
      log(`[bridge] telegram throttled (${method}, retry after ${ra}s): holding chat writes until ${fmtTime(until)}`);
    }
    if (until > cooldownUntil) cooldownUntil = until;
    throttleInfo = { until: cooldownUntil, retryAfter: ra, method, at: t, source };
    try {
      writeJsonAtomic(throttleFile, throttleInfo);
      throttleMtime = statSync(throttleFile).mtimeMs; // our own write is not "another process"
    } catch (e) {
      log(`[bridge] tg-throttle.json not written: ${e.message}`);
    }
    persistOutbox();
    return cooldownUntil;
  }

  // ---- outbox ---------------------------------------------------------------
  let items = [];
  let throttledSince = 0; // first 429 of the current episode; cleared when the outbox drains
  let headerSent = false;
  let throttledCount = 0;
  function loadOutbox() {
    const j = readJson(outboxFile);
    if (!j) return;
    items = Array.isArray(j.items) ? j.items.filter((i) => i && i.method && i.payload) : [];
    throttledSince = Number(j.throttledSince) || 0;
    headerSent = Boolean(j.headerSent);
    // The deadline travels with the episode. Without it a reboot mid-wall saw
    // cooldownUntil 0, judged the episode "over", and restarted its clock from
    // whatever `at` the throttle file carried (the last 429, not the first).
    cooldownUntil = Number(j.cooldownUntil) || 0;
    if (items.length) log(`[bridge] telegram outbox loaded: ${items.length} held message${items.length === 1 ? '' : 's'}`);
  }
  function persistOutbox() {
    try {
      writeJsonAtomic(outboxFile, { version: 1, throttledSince, headerSent, cooldownUntil, items });
    } catch (e) {
      log(`[bridge] tg-outbox.json not written: ${e.message}`);
    }
  }
  function prune() {
    const t = now();
    const before = items.length;
    items = items.filter((i) => t - i.at <= cfg.maxAgeMs);
    if (items.length > cfg.maxItems) items = items.slice(items.length - cfg.maxItems);
    const dropped = before - items.length;
    if (dropped) log(`[bridge] telegram outbox pruned ${dropped} stale message${dropped === 1 ? '' : 's'}`);
    return dropped;
  }
  function enqueue(method, payload, meta = {}) {
    const item = { id: randomUUID().slice(0, 8), method, payload, at: now(), attempts: 0, kind: meta.kind || null };
    items.push(item);
    prune();
    persistOutbox();
    record({ method, outcome: 'held' });
    log(`[bridge] telegram throttled, holding ${method} (${items.length} held, ${fmtDuration(remainingMs())} to go)`);
    return { queued: true, id: item.id, held: items.length, until: cooldownUntil };
  }

  // ---- ledger ---------------------------------------------------------------
  const recent = []; // { ts, method, outcome } within windowMs, for /status
  const lastDropWritten = new Map(); // method -> ts of the last 'dropped' row written to disk
  let appends = 0;
  function record(entry) {
    const ts = now();
    const row = { ts, ...entry };
    recent.push({ ts, method: entry.method, outcome: entry.outcome });
    while (recent.length && ts - recent[0].ts > cfg.windowMs) recent.shift();
    if (entry.outcome === 'dropped' && !entry.via) {
      // Typing is dropped by the GATE every 3s for the whole of a wall. Count
      // each one for /status, but write one line per half minute so the ledger
      // keeps hours of history instead of filling with the same row. A drop
      // with a `via` (a held message Telegram refused during a flush) is the
      // row this file exists for and is always written.
      const last = lastDropWritten.get(entry.method) || 0;
      if (ts - last < cfg.dropLogEveryMs) return;
      lastDropWritten.set(entry.method, ts);
    }
    try {
      appendFileSync(ledgerFile, JSON.stringify(row) + '\n');
      if (++appends % cfg.ledgerTrimEvery === 0) trimLedger();
    } catch (e) {
      log(`[bridge] tg-ledger.jsonl not written: ${e.message}`);
    }
  }
  function trimLedger() {
    try {
      const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= cfg.ledgerMax) return;
      const tmp = `${ledgerFile}.tmp`;
      writeFileSync(tmp, lines.slice(-cfg.ledgerMax).join('\n') + '\n');
      renameSync(tmp, ledgerFile);
    } catch (e) {
      log(`[bridge] tg-ledger.jsonl not trimmed: ${e.message}`);
    }
  }

  // ---- the gate -------------------------------------------------------------
  /**
   * Decide what happens to a write BEFORE it touches the network.
   * pass  -> send it (after `waitMs`, if any)
   * queue -> hold it in the outbox; the caller returns { queued: true }
   * drop  -> do not send; the caller throws the synthetic 429 it would have got
   */
  function gate(method, payload, opts = {}) {
    const governed = CHAT_WRITE_METHODS.has(method) && String(payload?.chat_id ?? '') === chatId;
    if (!governed) return { action: 'pass', waitMs: 0, governed: false, queueable: false, disposable: false };
    const disposable = Boolean(opts.disposable) || DISPOSABLE_METHODS.has(method);
    const queueable = !disposable && QUEUEABLE_METHODS.has(method);
    if (coolingDown()) {
      const retryAfter = Math.ceil(remainingMs() / 1000);
      return queueable
        ? { action: 'queue', waitMs: 0, governed: true, queueable, disposable, retryAfter }
        : { action: 'drop', waitMs: 0, governed: true, queueable, disposable, retryAfter };
    }
    const a = acquire(disposable);
    if (!a.ok) return { action: 'drop', waitMs: a.waitMs, governed: true, queueable, disposable, retryAfter: Math.ceil(a.waitMs / 1000) };
    return { action: 'pass', waitMs: a.waitMs, governed: true, queueable, disposable };
  }

  // ---- flush ----------------------------------------------------------------
  function headerText() {
    const t = now();
    const n = items.length;
    return (
      `🕓 Telegram throttled ${nameOf()} for ${fmtDuration(t - throttledSince)} ` +
      `(${fmtTime(throttledSince)} to ${fmtTime(t)}). ` +
      `${n} held message${n === 1 ? '' : 's'} follow${n === 1 ? 's' : ''}, oldest first.`
    );
  }
  /** One delivery attempt with the module's own failure policy. */
  async function tryDeliver(method, payload) {
    try {
      const res = await deliver(method, payload);
      record({ method, outcome: 'sent', via: 'flush' });
      return { ok: true, res };
    } catch (e) {
      if (e?.code === 429) {
        throttle(e.retryAfter, method);
        record({ method, outcome: 'throttled', code: 429, retryAfter: e.retryAfter, via: 'flush' });
        return { throttled: true };
      }
      const parseError = e?.code === 400 && /parse|entit/i.test(e.description || e.message || '');
      if (parseError && method === 'sendMessage' && payload.parse_mode) {
        try {
          await deliver('sendMessage', { chat_id: payload.chat_id, text: plainOf(payload.text).slice(0, MSG_LIMIT) });
          record({ method, outcome: 'sent', via: 'flush', plain: true });
          return { ok: true };
        } catch (e2) {
          if (e2?.code === 429) {
            throttle(e2.retryAfter, method);
            return { throttled: true };
          }
          log(`[bridge] held message dropped, Telegram refused it twice: ${e2.message}`);
          record({ method, outcome: 'dropped', code: e2.code, via: 'flush' });
          return { dropped: true };
        }
      }
      if (e?.code >= 400 && e.code < 500) {
        log(`[bridge] held message dropped, Telegram refused it: ${e.message}`);
        record({ method, outcome: 'dropped', code: e.code, via: 'flush' });
        return { dropped: true };
      }
      return { retry: true, error: e?.message || String(e) };
    }
  }
  let flushing = false;
  async function flush() {
    if (flushing) return { delivered: 0, remaining: items.length, stopped: 'busy' };
    if (!items.length) {
      if (throttledSince && now() >= cooldownUntil) {
        // A short wall that held nothing (every 429 was waited out inline):
        // close the episode so the next one starts its clock from zero.
        throttledSince = 0;
        headerSent = false;
        persistOutbox();
      }
      return { delivered: 0, remaining: 0, stopped: 'empty' };
    }
    if (coolingDown()) return { delivered: 0, remaining: items.length, stopped: 'cooldown' };
    flushing = true;
    let delivered = 0;
    let stopped = null;
    try {
      if (throttledSince && !headerSent) {
        const r = await tryDeliver('sendMessage', { chat_id: chatId, text: headerText() });
        if (r.throttled) return { delivered, remaining: items.length, stopped: 'throttled' };
        if (r.ok) {
          headerSent = true;
          persistOutbox();
          await sleep(cfg.flushGapMs);
        }
      }
      while (items.length) {
        if (coolingDown()) {
          stopped = 'throttled';
          break;
        }
        const item = items[0];
        const r = await tryDeliver(item.method, item.payload);
        if (r.throttled) {
          stopped = 'throttled';
          break;
        }
        if (r.retry) {
          item.attempts = (item.attempts || 0) + 1;
          if (item.attempts >= cfg.maxAttempts) {
            log(`[bridge] held message dropped after ${item.attempts} attempts: ${r.error}`);
            record({ method: item.method, outcome: 'dropped', via: 'flush', attempts: item.attempts });
            items.shift();
            persistOutbox();
            continue;
          }
          persistOutbox();
          stopped = 'error';
          break;
        }
        items.shift();
        if (r.ok) delivered++;
        persistOutbox();
        if (items.length) await sleep(cfg.flushGapMs);
      }
      if (!items.length) {
        if (delivered) log(`[bridge] telegram outbox flushed: ${delivered} delivered`);
        throttledSince = 0;
        headerSent = false;
        persistOutbox();
      }
    } finally {
      flushing = false;
    }
    return { delivered, remaining: items.length, stopped };
  }

  // ---- the one thing that may spend into a penalty ---------------------------
  // On 2026-09-19 about half of the SHORT sends slipped through the wall while
  // every answer bounced, and the owner saw a silent bot, restarted it twice and
  // stopped it once. When he writes during a cooldown, one plain line saying
  // what is happening and until when is worth one request per quarter hour; if
  // Telegram refuses it the deadline is simply refreshed. The gate is bypassed
  // on purpose, and only here.
  let lastNoticeAt = 0;
  async function noticeOwner() {
    if (!coolingDown()) return { sent: false, reason: 'not throttled' };
    const t = now();
    if (t - lastNoticeAt < cfg.noticeEveryMs) return { sent: false, reason: 'recent' };
    lastNoticeAt = t;
    const held = items.length ? ` (${items.length} held so far)` : '';
    const text =
      `🕓 Telegram is throttling ${nameOf()} until ${fmtTime(cooldownUntil)} (${fmtDuration(remainingMs())} left). ` +
      `Your messages are being read. The answers are held and will arrive then${held}.`;
    try {
      await deliver('sendMessage', { chat_id: chatId, text });
      record({ method: 'sendMessage', outcome: 'sent', via: 'notice' });
      return { sent: true };
    } catch (e) {
      if (e?.code === 429) throttle(e.retryAfter, 'sendMessage');
      record({ method: 'sendMessage', outcome: e?.code === 429 ? 'throttled' : 'error', code: e?.code, via: 'notice' });
      return { sent: false, reason: e?.message || String(e) };
    }
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      flush().catch((e) => log(`[bridge] telegram outbox flush failed: ${e.message}`));
    }, cfg.flushEveryMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ---- status ---------------------------------------------------------------
  function status() {
    syncThrottleFile();
    const t = now();
    while (recent.length && t - recent[0].ts > cfg.windowMs) recent.shift();
    const counts = {};
    for (const r of recent) {
      const k = r.outcome === 'sent' ? (r.method === 'sendChatAction' ? 'typing' : r.method.startsWith('edit') ? 'edits' : 'msgs') : r.outcome;
      counts[k] = (counts[k] || 0) + 1;
    }
    return {
      held: items.length,
      coolingDown: t < cooldownUntil,
      cooldownUntil,
      remainingMs: Math.max(0, cooldownUntil - t),
      throttledSince,
      throttledCount,
      throttleInfo,
      tokens: Math.max(0, tokens),
      windowMs: cfg.windowMs,
      counts,
    };
  }
  /** One line for /status, in the house style: icon, label, values. */
  function statusLine() {
    const s = status();
    const held = s.held ? ` · ${s.held} held` : '';
    if (s.coolingDown) {
      return `📮 Telegram · throttled until ${fmtTime(s.cooldownUntil)} (${fmtDuration(s.remainingMs)} left)${held}`;
    }
    if (s.held) return `📮 Telegram · ${s.held} held, delivering`;
    const c = s.counts;
    const sent = (c.typing || 0) + (c.edits || 0) + (c.msgs || 0);
    const parts = [];
    if (c.typing) parts.push(`${c.typing} typing`);
    if (c.edits) parts.push(`${c.edits} edit${c.edits === 1 ? '' : 's'}`);
    if (c.msgs) parts.push(`${c.msgs} msg${c.msgs === 1 ? '' : 's'}`);
    const extra = [];
    if (c.dropped) extra.push(`${c.dropped} dropped`);
    if (c.throttled) extra.push(`${c.throttled} throttled`);
    const mins = Math.round(cfg.windowMs / 60_000);
    return `📡 Telegram · ${mins}m: ${sent} write${sent === 1 ? '' : 's'}${parts.length ? ` (${parts.join(' · ')})` : ''}${
      extra.length ? ` · ${extra.join(' · ')}` : ''
    }`;
  }

  loadOutbox();
  syncThrottleFile(true);
  if (now() < cooldownUntil) {
    log(`[bridge] telegram cooldown still running from a previous life: until ${fmtTime(cooldownUntil)}`);
  }

  return {
    gate,
    record,
    throttle,
    enqueue,
    flush,
    noticeOwner,
    start,
    stop,
    status,
    statusLine,
    coolingDown,
    remainingMs,
    held: () => items.length,
    items: () => items.map((i) => ({ ...i })),
    inlineWaitMaxMs: cfg.inlineWaitMaxMs,
    config: cfg,
  };
}
