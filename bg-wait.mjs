// THE WAITING LINE'S MESSAGE, by queued job (self audit 2026-10-13, P2).
//
// A job the admission gates hold (the count, the machine load, the usage
// window) waits in the drop box. It gets ONE Telegram message saying why
// (bg-notify.mjs waitingLine), and that message becomes its worker card when
// it starts, so a queued job is one message from queued to done, like every
// other job. This store is how the drain finds that message again:
//
//   • by queued job, keyed on the item's `queuedAt` stamp plus a hash of its
//     text (`waitKey`). bg.mjs stamps `queuedAt` once, before its retry loop,
//     and every daemon path that queues a job stamps it too, so the key is the
//     same every time the drain defers the job and on the drain that starts it;
//   • on disk, so a daemon restart edits the same message instead of sending a
//     second one and leaving the first one waiting forever (the house rule: a
//     ⏳ needs a path to its ending on a restart too);
//   • kept OUT of bg-queue.json on purpose. The drop box is written by bg.mjs
//     from other processes, and every extra writer of it widens the window in
//     which a concurrent append is lost. Only the daemon writes this file.
//
// A send still in flight is held in memory (`pending`), so the next drain
// neither sends a second line nor loses the one coming. `claim` hands the
// message over to the job's start exactly once; the record goes when the card's
// takeover edit is confirmed (`resolveMessage`) or the card reaches its ending
// (`release`).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const WAIT_KEEP_MS = 3 * 24 * 3600_000;
export const WAIT_MAX = 300;

/** The queued job's key, or null for an item with no text. */
export function waitKey(item) {
  const text = typeof item === 'string' ? item : item?.text;
  if (!text) return null;
  const h = createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
  const at = typeof item === 'object' && item?.queuedAt ? String(item.queuedAt) : '';
  return `${at}|${h}`;
}

export function createBgWaitStore({ file, now = () => Date.now(), log = () => {} } = {}) {
  if (!file) throw new Error('createBgWaitStore: `file` is required');
  let rec = null;
  const pending = new Map(); // key -> Promise<message_id | null>
  const claimed = new Set();
  const resolving = new Set();

  function load() {
    if (rec) return rec;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      rec = {}; // no file yet, or a half-written one
    }
    return rec;
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

  const copy = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

  return {
    file,
    /** The message on screen for this job, or null. A copy. */
    get: (key) => (key ? copy(load()[key] || null) : null),
    /** A send for this job still in flight, or null. */
    pending: (key) => (key ? pending.get(key) || null : null),
    /**
     * Track a send in flight. When it lands it is recorded, unless the job was
     * taken (started) meanwhile: then the start already holds the promise.
     */
    track(key, promise, info = {}) {
      if (!key) return promise;
      pending.set(key, promise);
      Promise.resolve(promise)
        .then((msgId) => {
          if (pending.get(key) !== promise) return;
          pending.delete(key);
          if (!msgId) return;
          load()[key] = { ...info, msgId, at: now() };
          save();
        })
        .catch(() => {
          if (pending.get(key) === promise) pending.delete(key);
        });
      return promise;
    },
    /** Record a change (the reason the line now shows). */
    update(key, patch = {}) {
      const r = load();
      if (!key || !r[key]) return false;
      r[key] = { ...r[key], ...patch };
      return save();
    },
    /** Transfer to a worker card without forgetting an unacknowledged message. */
    claim(key) {
      if (!key || claimed.has(key)) return null;
      claimed.add(key);
      return pending.get(key) || load()[key]?.msgId || null;
    },
    /** Confirm a worker card took over. Failed edits remain durable for a retry. */
    async resolveMessage(msgId, text, resolve) {
      const r = load();
      const key = Object.keys(r).find((k) => r[k]?.msgId === msgId);
      if (!key) return resolve();
      r[key] = { ...r[key], resolutionText: text };
      save();
      resolving.add(key);
      try {
        if ((await resolve()) === true) {
          delete r[key];
          claimed.delete(key);
          save();
          return true;
        }
        return false;
      } finally {
        resolving.delete(key);
      }
    },
    /**
     * The worker card that took this message over has reached its ending and
     * edits it itself: forget the record WITHOUT an edit. A failed takeover is
     * retried with the card's opening text, which must never land after Done
     * (independent review, 2026-10-13).
     */
    release(msgId) {
      if (!msgId) return false;
      const r = load();
      const key = Object.keys(r).find((k) => r[k]?.msgId === msgId);
      if (!key) return false;
      delete r[key];
      claimed.delete(key);
      return save();
    },
    /** Unresolved messages never expire. Resolve absent jobs before forgetting them. */
    async reconcile(activeKeys, resolve) {
      const active = new Set(activeKeys);
      const r = load();
      for (const [key, value] of Object.entries(r)) {
        if (active.has(key) || resolving.has(key)) continue;
        // Claimed and not yet tried: its job is starting and its card resolves
        // it. Once a takeover edit failed (resolutionText set), retry it here.
        if (claimed.has(key) && !value?.resolutionText) continue;
        // Released or replaced since this pass began (a card reached its
        // ending during an earlier await): its retry must not land after that.
        if (r[key] !== value) continue;
        try {
          if ((await resolve(copy(value), key)) !== true) continue;
          // A start or another reconciliation may have taken ownership meanwhile.
          if (r[key] !== value) continue;
          delete r[key];
          save();
        } catch (e) {
          log(`could not resolve waiting message ${value?.msgId}: ${e.message}`);
        }
      }
    },
    /**
     * The job is starting: hand over its message (an id, or the promise of
     * one), exactly once. Null when it never had one.
     */
    take(key) {
      if (!key) return null;
      const p = pending.get(key);
      if (p) {
        pending.delete(key);
        return p;
      }
      const r = load();
      const have = r[key];
      if (!have) return null;
      delete r[key];
      save();
      return have.msgId || null;
    },
    snapshot: () => copy(load()),
  };
}
