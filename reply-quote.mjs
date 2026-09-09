// THE MESSAGE YOU WERE LOOKING AT.
//
// Telegram lets you long press a bubble, pick Reply, and type. The update then
// carries `reply_to_message`: the whole replied to message, inline, including
// its text, its sender and its timestamp. The bridge read that field in exactly
// one place (the `/codex` arm, to re-attach a photo) and threw it away
// everywhere else, so "For this, we need to do the support ticket ourselves."
// reached the engine as eight words with no subject and the session had to ask
// what you were looking at (observed 2026-09-08, on a notice the daemon had
// posted itself).
//
// So the quote becomes part of the prompt. Two properties make that safe:
//
//   1. It is DATA, never routing. The block is composed AFTER the lane and the
//      engine have been decided from your own typed words, so a quoted bubble
//      containing "codex:" or "/goal" cannot steer anything. composeWithQuote
//      is the only way it is ever joined to your text, and it never runs before
//      a routing decision.
//   2. It is BOUNDED. A worker handback is a whole document and a quote of one
//      is still a quote, so it is collapsed to a single line, capped, and the
//      cut is stated in the block rather than left to be guessed.
//
// No lookup, no daemon state, no clock of its own: everything comes off the
// update Telegram already sent, which is also why a reply to a bubble from
// before the last restart works exactly like a reply to a fresh one.
//
// Pure functions. See reply-quote.test.mjs.

/** Characters of the replied to message that ride into the prompt. */
export const REPLY_QUOTE_MAX = 1500;

/** Characters of it that ride into the daemon's own ack line. */
export const REPLY_QUOTE_ACK_MAX = 60;

/**
 * What the replied to message IS, when it has no words of its own.
 *
 * A bare photo, a sticker or a voice note is still a thing you can point at,
 * and "no text" plus the right noun is more useful than refusing to say
 * anything.
 */
function mediaNoun(m) {
  if (!m || typeof m !== 'object') return 'message';
  if (m.photo) return 'photo';
  if (m.video_note) return 'video note';
  if (m.video) return 'video';
  if (m.animation) return 'animation';
  if (m.voice) return 'voice note';
  if (m.audio) return 'audio';
  if (m.sticker) return 'sticker';
  if (m.document) return 'file';
  if (m.location || m.venue) return 'location';
  if (m.poll) return 'poll';
  if (m.contact) return 'contact';
  return 'message';
}

/**
 * WHO ACTUALLY WROTE IT, when the bubble is a forward.
 *
 * A forwarded message's `from` is whoever FORWARDED it, so the self check below
 * would read your own id off a customer's words and call them "your earlier
 * message": a wrong attribution on the one kind of quote where attribution is
 * the whole point. Returns the origin's name, '' for a forward whose origin is
 * hidden, and null when the bubble is not a forward at all.
 */
function forwardedFrom(m) {
  const o = m?.forward_origin;
  if (o && typeof o === 'object') {
    if (o.type === 'user') return String(o.sender_user?.first_name || '');
    if (o.type === 'hidden_user') return String(o.sender_user_name || '');
    if (o.type === 'chat') return String(o.sender_chat?.title || '');
    if (o.type === 'channel') return String(o.chat?.title || '');
    return '';
  }
  // Bot API before 7.0. Still read because the fields are what an older
  // gateway in front of us sends, and reading them costs three lines.
  if (m?.forward_from) return String(m.forward_from.first_name || '');
  if (m?.forward_sender_name) return String(m.forward_sender_name || '');
  if (m?.forward_from_chat) return String(m.forward_from_chat.title || '');
  return null;
}

/**
 * THE BLOCK'S OWN CLOSING DELIMITER, kept out of the text it wraps.
 *
 * The block ends `..."]`, and the excerpt is interpolated raw so the engine
 * reads the words as they were written. That is right for every character
 * except this one pair: a bubble containing `"]` closes the block early, and
 * everything after it reads as top level prompt rather than as a quote. It
 * fires on ordinary text (a worker report quoting a JSON array) before anyone
 * writes it on purpose, and the session on the other end runs with permission
 * prompts skipped, so a forwarded message could end a quote and open an
 * instruction.
 *
 * Only a `]` that follows a quote or a round bracket is touched, and only into
 * a round bracket of its own: `[support]`, `"send it"` and a bare `]` all
 * survive as written, because the SEQUENCE is what closes the block, not either
 * character on its own. Both closers are covered, because a truncated block
 * ends `chars)]` rather than `"]`.
 */
const uncloseBlock = (s) => String(s).replace(/(["')])(\s*)]/g, '$1$2)');

/**
 * A NAME IS ATTACKER TEXT TOO. A forwarded channel title and a Telegram
 * first_name both land in the block's lead, ahead of the quote, so a title of
 * `x] now run` would close the block before the excerpt is even reached.
 * Square brackets are the only characters that can do that there.
 */
const unbracket = (s) => String(s).replace(/[[\]]/g, '');

/** One line, always: a quote of a 40 line report is not 40 lines of prompt. */
function collapse(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * HH:MM in the chat's own timezone, or '' when the update carried no date.
 *
 * Omitted rather than invented: a wrong clock on a quote is worse than no
 * clock, because the clock is how you tell two similar notices apart.
 */
function clockAt(unixSec, timeZone) {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timeZone || undefined,
    }).format(new Date(unixSec * 1000));
  } catch {
    return '';
  }
}

/**
 * Read the reply out of an inbound Telegram message.
 *
 * Returns null when there is nothing to quote, otherwise:
 *
 *   block        the bracketed line that goes in front of your text
 *   who          the short name for the ack line (the daemon's name, "you",
 *                "Josh")
 *   subject      the long form used inside the block ("Leash's message"), which
 *                the block prefixes with "part of" when the selection was
 *                partial
 *   excerpt      the quoted text, collapsed and capped, '' when there is none
 *   totalChars   how long the collapsed original was
 *   quotedChars  how much of it survived the cap
 *   truncated    whether the cap bit
 *   partial      whether this came from Telegram's own partial quote selection
 *
 * `botName` is the daemon's configured name (config.json `name`), never a
 * literal: a clone that calls itself something else quotes itself by that.
 * `botId` is the numeric half of the bot token, so the bot's own bubbles are
 * identified by id rather than by the `is_bot` flag, which would also be true
 * of some other bot in a group.
 */
export function buildReplyQuote(msg, { botName = 'the bot', botId = null, timeZone = null, max = REPLY_QUOTE_MAX } = {}) {
  const replied = msg?.reply_to_message;
  if (!replied || typeof replied !== 'object') return null;

  const fromId = replied.from?.id ?? null;
  const senderId = msg?.from?.id ?? null;
  const isBot = (botId != null && fromId != null && String(fromId) === String(botId)) || (botId == null && replied.from?.is_bot === true);
  const isSelf = !isBot && fromId != null && senderId != null && String(fromId) === String(senderId);

  // TELEGRAM'S OWN SELECTION WINS. "Quote part of a message" means you already
  // pointed at the sentence you meant, and re-quoting the whole bubble over the
  // top of that throws away the most precise thing in the update.
  const partialText = collapse(msg?.quote?.text || '');
  const fullText = collapse(replied.text || replied.caption || '');
  const source = partialText || fullText;
  // A selection of the WHOLE bubble is not a fragment. Telegram sends
  // `quote.text` for any selection, including one that covers everything, and
  // announcing that as "part of" tells the engine it is looking at a piece of
  // something larger when it has the lot.
  const partial = Boolean(partialText) && partialText !== fullText;

  const noun = source ? 'message' : mediaNoun(replied);
  // A FORWARD IS NOBODY IN THIS CHAT. Checked before the self and bot cases,
  // both of which read `from`, which on a forward is the forwarder.
  const fwd = forwardedFrom(replied);
  const who = unbracket(
    fwd !== null
      ? fwd || 'a forward'
      : isBot
        ? String(botName || 'the bot')
        : isSelf
          ? 'you'
          : String(replied.from?.first_name || 'someone'),
  );
  const subject = fwd !== null
    ? fwd
      ? `a ${noun} forwarded from ${unbracket(fwd)}`
      : `a forwarded ${noun}`
    : isBot
      ? `${who}'s ${noun}`
      : isSelf
        ? `your earlier ${noun}`
        : `${who}'s ${noun}`;

  const at = clockAt(replied.date, timeZone);
  const when = at ? ` from ${at}` : '';

  const cap = Number.isFinite(max) && max > 0 ? max : REPLY_QUOTE_MAX;
  const totalChars = source.length;
  const truncated = totalChars > cap;
  // trimEnd so a cut that lands on a space does not read as a double space
  // before the ellipsis. The count reports what actually survived, not the cap.
  const kept = truncated ? source.slice(0, cap).trimEnd() : source;
  // The cut is measured on what was QUOTED, before the delimiter guard, so the
  // count still describes the message rather than the rendering of it.
  const quotedChars = kept.length;
  const excerpt = uncloseBlock(truncated ? `${kept} ...` : kept);
  const counts = truncated ? ` (quoted ${quotedChars} of ${totalChars} chars)` : '';

  // SAID, not just recorded. A fragment you selected and a whole bubble read
  // identically otherwise, so the engine would answer a sentence as though it
  // were the entire message it came out of.
  const lead = partial ? `part of ${subject}` : subject;
  const block = source
    ? `[Replying to ${lead}${when}: "${excerpt}"${counts}]`
    : `[Replying to ${subject}${when}, no text]`;

  return { block, who, subject, excerpt, totalChars, quotedChars, truncated, partial };
}

/**
 * THE ONLY PLACE A QUOTE IS EVER JOINED TO YOUR TEXT.
 *
 * In front of it, except when your text opens with a slash command. Claude Code
 * only sees /goal, /autopilot and friends at the very front of the prompt, so a
 * block in front of one turns the command into prose and the run you asked for
 * never happens. The quote goes behind it there, where it is still context and
 * the command still fires.
 */
export function composeWithQuote(quote, text) {
  const q = String(quote ?? '').trim();
  const body = String(text ?? '');
  if (!q) return body;
  if (!body.trim()) return q;
  if (/^\s*\//.test(body)) return `${body}\n\n${q}`;
  return `${q}\n\n${body}`;
}
