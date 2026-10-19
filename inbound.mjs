// WHAT ARRIVED: the kind of an inbound message, the one log line that records
// it, and the bookkeeping for a kind the bridge cannot read.
//
// Two gaps, both found on 2026-10-12 when a long text from the phone arrived as
// a Telegram rich message and was refused four times:
//
//   1. NOTHING RECORDED AN ARRIVAL. "Did my message reach you?" had no answer in
//      the log: a message the bridge refused left no line at all. Every message
//      from the owner chat now leaves exactly one, with its id, its kind and,
//      for the kinds that are words, how many characters. Never the content.
//   2. A KIND NOBODY READS WAS DROPPED. The owner got a line listing what they
//      could send, and the message itself was gone. It is now saved as raw JSON
//      beside the attachments, bounded to the newest few, so the next kind
//      Telegram invents can be read off the file instead of re-sent.
//
// Pure: no daemon state, no clock, no file system. The daemon passes the time
// and the directory listing in. See inbound.test.mjs.

/** How many saved unknown messages are kept. The newest win. */
export const UNKNOWN_KEEP = 20;

/** `pickMedia`'s kind names, as the log writes them. */
const MEDIA_LOG_KIND = {
  photo: 'photo',
  file: 'file',
  video: 'video',
  'video note': 'video note',
  'voice message': 'voice',
  audio: 'audio',
};

/**
 * One of: text, rich, photo, file, video, video note, voice, audio, unknown.
 *
 * The order is the order the daemon acts in: plain `text` first, then a file
 * (`pickMedia`'s answer), then a rich message that has words, then unknown.
 */
export function inboundKind({ text = '', media = null, richText = '' } = {}) {
  if (typeof text === 'string' && text) return 'text';
  const mediaKind = media && typeof media === 'object' ? MEDIA_LOG_KIND[media.kind] : null;
  if (typeof mediaKind === 'string') return mediaKind;
  if (media && typeof media === 'object') return 'file';
  if (typeof richText === 'string' && richText) return 'rich';
  return 'unknown';
}

const isoAt = (at) => {
  const d = new Date(Number.isFinite(at) ? at : NaN);
  return Number.isNaN(d.getTime()) ? 'unknown-time' : d.toISOString();
};
/** A message id as digits, or `?`: whatever arrives, the log line stays one token. */
const idToken = (id) => (Number.isFinite(Number(id)) && id !== null && id !== '' ? String(Math.trunc(Number(id))) : '?');

/**
 * THE ONE LINE PER MESSAGE. `grep 'inbound message_id=25294'` answers "did it
 * arrive", and `kind=` answers "as what".
 *
 * `chars` is written for the kinds that are words (text, rich) and for nothing
 * else. There is no parameter through which content could reach this line.
 */
export function inboundLogLine({ at = NaN, messageId = null, kind = 'unknown', chars = null } = {}) {
  const known = ['text', 'rich', 'photo', 'file', 'video', 'video note', 'voice', 'audio', 'unknown'];
  const k = known.includes(kind) ? kind : 'unknown';
  const count = (k === 'text' || k === 'rich') && Number.isFinite(chars) && chars >= 0 ? ` chars=${Math.trunc(chars)}` : '';
  return `[${isoAt(at)}] [bridge] inbound message_id=${idToken(messageId)} kind=${k}${count}`;
}

/** Field NAMES only, made safe to print: at most 40 of them, word characters only. */
export function messageKeys(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return [];
  return Object.keys(msg)
    .slice(0, 40)
    .map((k) => String(k).replace(/[^\w]/g, '?').slice(0, 40));
}

/**
 * The line for a kind the bridge cannot read: the id, the top level field
 * names, and the file it was saved to. Names, never values.
 */
export function unknownLogLine({ at = NaN, messageId = null, keys = [], savedAs = null } = {}) {
  const list = (Array.isArray(keys) ? keys : []).map((k) => String(k).replace(/[^\w?]/g, '?')).join(',');
  const file = savedAs ? ` saved=${String(savedAs).replace(/[^\w.\-]/g, '?')}` : ' saved=no';
  return `[${isoAt(at)}] [bridge] unreadable message_id=${idToken(messageId)} keys=${list || 'none'}${file}`;
}

/**
 * Fields that say who, when and where, never WHAT. Whatever is left names the
 * kind: `sticker`, `poll`, `location`.
 */
const ENVELOPE = new Set([
  'message_id',
  'message_thread_id',
  'direct_messages_topic',
  'from',
  'sender_chat',
  'sender_boost_count',
  'sender_business_bot',
  'date',
  'business_connection_id',
  'chat',
  'forward_origin',
  'forward_from',
  'forward_from_chat',
  'forward_from_message_id',
  'forward_signature',
  'forward_sender_name',
  'forward_date',
  'is_topic_message',
  'is_automatic_forward',
  'reply_to_message',
  'external_reply',
  'quote',
  'reply_to_story',
  'reply_to_checklist_task_id',
  'via_bot',
  'edit_date',
  'has_protected_content',
  'is_from_offline',
  'is_paid_post',
  'media_group_id',
  'author_signature',
  'paid_star_count',
  'text',
  'entities',
  'link_preview_options',
  'suggested_post_info',
  'effect_id',
  'caption',
  'caption_entities',
  'show_caption_above_media',
  'has_media_spoiler',
  'reply_markup',
]);

/**
 * A short name for what an unreadable message IS, for the notice: "sticker",
 * "poll", "formatted message with no words". '' when nothing names it.
 */
export function unknownKindLabel(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return '';
  const keys = Object.keys(msg).filter((k) => !ENVELOPE.has(k));
  if (keys.includes('rich_message')) return 'formatted message with no words';
  const first = keys[0];
  if (!first) return '';
  return String(first)
    .replace(/[^\w]/g, '')
    .replace(/_/g, ' ')
    .trim()
    .slice(0, 28);
}

/** `<ts>_unknown_<message_id>.json`, the name a saved unknown message gets. */
export function unknownFileName(at, messageId) {
  const ts = Number.isFinite(at) && at > 0 ? Math.trunc(at) : 0;
  const id = idToken(messageId);
  return `${ts}_unknown_${id === '?' ? '0' : id.replace(/^-/, '')}.json`;
}

const UNKNOWN_FILE_RE = /^(\d+)_unknown_(\d+)\.json$/;

/**
 * Is this file one a save of an unknown message wrote: the right name AND, as
 * its content, a JSON message whose `message_id` is the id in the name?
 *
 * The prune deletes from the folder their attachments land in, and an attachment
 * is saved as `<ts>_<its own name>`. A file they sent that happens to be called
 * `unknown_5.json` therefore gets a name the pattern matches. The content
 * check is what keeps the prune off it: nothing is deleted on its name alone.
 */
export function isSavedUnknown(name, content) {
  const m = UNKNOWN_FILE_RE.exec(String(name));
  if (!m) return false;
  try {
    const msg = JSON.parse(String(content));
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    const id = Number.isFinite(Number(msg.message_id)) && msg.message_id !== null ? String(Math.trunc(Math.abs(Number(msg.message_id)))) : '0';
    return id === String(Number(m[2]));
  } catch {
    return false;
  }
}

/**
 * Which saved unknown messages to delete so that at most `keep` remain: the
 * OLDEST, by the timestamp in the name. Reads names only, and names that are
 * not this module's are never returned. A name is a candidate, not a verdict:
 * the caller confirms each one with isSavedUnknown before deleting it.
 */
export function unknownFilesToPrune(names = [], keep = UNKNOWN_KEEP) {
  const limit = Number.isFinite(keep) && keep >= 0 ? Math.trunc(keep) : UNKNOWN_KEEP;
  const mine = (Array.isArray(names) ? names : [])
    .map((name) => {
      const m = UNKNOWN_FILE_RE.exec(String(name));
      return m ? { name: String(name), ts: Number(m[1]), id: Number(m[2]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts || b.id - a.id || (a.name < b.name ? 1 : -1));
  return mine.slice(limit).map((f) => f.name);
}
