// A TELEGRAM RICH MESSAGE, READ AS PLAIN TEXT.
//
// Since Bot API 10.1 a `Message` can carry `rich_message` INSTEAD of `text`: a
// tree of blocks (paragraphs, lists, tables, quotations) whose leaves are
// RichText, which is a String, an Array of RichText, or a typed object such as
// `{ type: "bold", text: ... }`. A long or formatted message typed in a
// Telegram app arrives this way, with no `text` field at all.
//
// The bridge read `msg.text` and nothing else, so on 2026-10-12 the owner sent
// one 6,000 character answer four times and got "Send text, photos, videos,
// voice notes or files." four times. It was not a length limit. It was a
// message kind nobody read.
//
// This module turns that tree back into the words. Three rules:
//
//   1. KEEP THE WORDS, drop the styling. Bold and italic become plain words:
//      the engine needs what they said, not how it looked. Structure that carries
//      meaning is kept as plain text shape: a list item keeps its label, a
//      nested block is indented, a table is one line per row, a quotation gets
//      a "> " prefix, preformatted text gets a fence so its spacing survives.
//   2. A LINK KEEPS ITS TARGET. "see the doc" pointing at a URL becomes
//      "see the doc (https://...)". When the target is already in the words
//      (an auto detected URL), it is not repeated.
//   3. NEVER THROW, NEVER DROP IN SILENCE. An unknown block type becomes
//      "[<type> block]" unless it carries text, which is kept. Media inside a
//      rich message is NOT downloaded: it becomes a one line placeholder such
//      as "[photo]" with its caption, and `media` lists what was left behind so
//      the caller can say so.
//
// Field names are the Bot API's own (RichBlock*, RichText*, RichBlockListItem,
// RichBlockTableCell, RichBlockCaption). Pure: no daemon state, no clock, no
// network. See rich-message.test.mjs.

/** Telegram allows 16 levels of nesting. Past this the input is not Telegram's. */
export const RICH_MAX_DEPTH = 40;

/** What is said in place of a subtree nested deeper than RICH_MAX_DEPTH. */
const TOO_DEEP = '[nested content]';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
/** One line, for a placeholder that must stay one line. */
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** A type name as Telegram wrote it, made safe to print: `voice_note` reads "voice note". */
const typeName = (t) => oneLine(str(t).replace(/_/g, ' ')).slice(0, 40);

/**
 * Is a link's target already visible in its words?
 *
 * An auto detected URL arrives as `{ type: "url", text: "example.com/a",
 * url: "https://example.com/a" }` (or with the same string in both), and
 * writing it twice is noise. Compared without the scheme, a leading "www.", a
 * trailing slash and letter case, which are the differences Telegram adds.
 */
function targetShown(words, target) {
  const norm = (s) =>
    String(s)
      .trim()
      .toLowerCase()
      .replace(/^(https?:\/\/|mailto:|tel:)/, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  const t = norm(target);
  if (!t) return true;
  if (norm(words) === t) return true;
  // Or as one whole word of a longer text ("see https://example.com/a."), with
  // the punctuation around it set aside. A whole word, never a substring: the
  // target "https://a" is not shown by the word "data".
  return String(words)
    .split(/\s+/)
    .some((word) => norm(word.replace(/^[("'<[]+|[)"'>\],.;:!?]+$/g, '')) === t);
}

/** Words, then the target in round brackets when the words do not show it. */
function withTarget(words, target) {
  const t = str(target).trim();
  if (!t) return words;
  if (!words.trim()) return t;
  return targetShown(words, t) ? words : `${words} (${t})`;
}

/** The typed inline objects whose whole content is their `text`. */
const PLAIN_INLINE = new Set([
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
  'date_time',
  'text_mention',
  'subscript',
  'superscript',
  'marked',
  'code',
  'bank_card_number',
  'mention',
  'hashtag',
  'cashtag',
  'bot_command',
  'anchor_link',
  'reference',
  'reference_link',
]);

/** A RichMessageButton as words: its text, and where it goes when it is a link. */
function buttonText(button, depth) {
  if (!isObj(button)) return '';
  return withTarget(oneLine(inline(button.text, depth + 1)), button.url);
}

/**
 * RichText to a string. Recurses through all three shapes: a String, an Array
 * of RichText, a typed object.
 */
function inline(rt, depth = 0) {
  if (rt == null) return '';
  if (typeof rt === 'string') return rt;
  if (typeof rt === 'number') return str(rt);
  if (depth > RICH_MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(rt)) return rt.map((part) => inline(part, depth + 1)).join('');
  if (!isObj(rt)) return '';

  const type = str(rt.type);
  const words = inline(rt.text, depth + 1);
  if (PLAIN_INLINE.has(type)) return words;
  switch (type) {
    case 'url':
      return withTarget(words, rt.url);
    case 'email_address':
      return withTarget(words, rt.email_address);
    case 'phone_number':
      return withTarget(words, rt.phone_number);
    case 'custom_emoji':
      return str(rt.alternative_text);
    case 'mathematical_expression':
      return str(rt.expression);
    case 'button': {
      const label = buttonText(rt.button, depth);
      return label ? `[button: ${label}]` : '[button]';
    }
    case 'anchor':
      return ''; // a jump target inside the message, with no words of its own
    default:
      // UNKNOWN, or no type at all. Whatever words it carries are kept, and a
      // typed object with none is named rather than dropped.
      if (words) return words;
      return type ? `[${typeName(type)}]` : '';
  }
}

/** Put `first` in front of the first line and `rest` in front of every other. */
function prefixLines(chunks, first, rest) {
  const lines = chunks.join('\n').split('\n');
  return lines.map((l, i) => (i === 0 ? first : rest) + l).join('\n');
}

/** A RichBlockCaption (`{ text, credit }`) on one line. Also takes bare RichText. */
function captionText(caption, depth) {
  if (caption == null) return '';
  if (!isObj(caption) || caption.type) return oneLine(inline(caption, depth + 1));
  const words = oneLine(inline(caption.text, depth + 1));
  const credit = oneLine(inline(caption.credit, depth + 1));
  return [words, credit ? `(${credit})` : ''].filter(Boolean).join(' ');
}

/** "[photo]" or "[photo] the caption". `detail` names the file when there is one. */
function placeholder(label, detail, caption) {
  const head = detail ? `[${label}: ${detail}]` : `[${label}]`;
  return caption ? `${head} ${caption}` : head;
}

/** The block types that are media the bridge does not fetch, and the object each carries. */
const MEDIA_BLOCKS = new Map([
  ['photo', { label: 'photo', field: 'photo' }],
  ['video', { label: 'video', field: 'video' }],
  ['animation', { label: 'animation', field: 'animation' }],
  ['audio', { label: 'audio', field: 'audio' }],
  ['document', { label: 'file', field: 'document' }],
  ['voice_note', { label: 'voice note', field: 'voice_note' }],
]);

/** Without the blank chunks at its start: a label or a "> " never sits on an empty line. */
function fromFirstWords(chunks) {
  let i = 0;
  while (i < chunks.length && !String(chunks[i]).trim()) i++;
  return chunks.slice(i);
}

/** One list item: its label in front, everything under it indented to match. */
function listItem(item, ctx, depth) {
  if (!isObj(item)) return typeof item === 'string' && item ? [`- ${item}`] : [];
  let label = oneLine(str(item.label));
  if (!label && Number.isFinite(item.value)) label = `${item.value}.`;
  if (item.has_checkbox) label = [label, item.is_checked ? '[x]' : '[ ]'].filter(Boolean).join(' ');
  if (!label) label = '-';
  const body = fromFirstWords(blocks(item.blocks, ctx, depth + 1));
  if (!body.length) return [label];
  return [prefixLines(body, `${label} `, ' '.repeat(label.length + 1))];
}

/**
 * One RichBlock to chunks. A chunk is a string that may span lines; '' is a
 * blank line. Never throws on a shape it does not know.
 */
function block(b, ctx, depth) {
  if (b == null) return [];
  if (typeof b === 'string') return [b];
  if (!isObj(b)) return [];
  if (depth > RICH_MAX_DEPTH) return [TOO_DEEP];
  ctx.blocks++;

  const type = str(b.type);
  switch (type) {
    case 'paragraph':
    case 'footer':
      return [inline(b.text, depth)];
    case 'heading': {
      const text = inline(b.text, depth);
      return text.trim() ? ['', text] : [];
    }
    case 'pre': {
      const code = inline(b.text, depth);
      const fence = code.includes('```') ? '````' : '```';
      return [`${fence}${oneLine(str(b.language))}\n${code}\n${fence}`];
    }
    case 'divider':
      return ['---'];
    case 'mathematical_expression':
      return [str(b.expression)];
    case 'anchor':
      return []; // a jump target, nothing to read
    case 'list': {
      const items = Array.isArray(b.items) ? b.items : [];
      return items.flatMap((item) => listItem(item, ctx, depth));
    }
    case 'blockquote':
    case 'expandable_blockquote':
    case 'pullquote': {
      // The first kind holds blocks, the other two hold text. Read both fields
      // on all three, so a shape Telegram changes later still gives its words.
      const body = fromFirstWords([...blocks(b.blocks, ctx, depth + 1), ...(b.text != null ? [inline(b.text, depth)] : [])]);
      const credit = oneLine(inline(b.credit, depth));
      if (credit) body.push(`(${credit})`);
      return body.length ? [prefixLines(body, '> ', '> ')] : [];
    }
    case 'details': {
      const summary = inline(b.summary, depth);
      const body = fromFirstWords(blocks(b.blocks, ctx, depth + 1));
      return [...(summary.trim() ? [summary] : []), ...(body.length ? [prefixLines(body, '  ', '  ')] : [])];
    }
    case 'table': {
      const out = [];
      const caption = captionText(b.caption, depth);
      if (caption) out.push(caption);
      for (const row of Array.isArray(b.cells) ? b.cells : []) {
        const cells = Array.isArray(row) ? row : [row];
        // An invisible cell (no `text`) keeps its place, so the columns of one
        // row still line up with the columns of the next.
        out.push(cells.map((c) => oneLine(inline(isObj(c) ? c.text : c, depth))).join(' | '));
      }
      return out;
    }
    case 'collage':
    case 'slideshow': {
      ctx.media.push(type);
      const inner = fromFirstWords(blocks(b.blocks, ctx, depth + 1));
      return [placeholder(type, '', captionText(b.caption, depth)), ...(inner.length ? [prefixLines(inner, '  ', '  ')] : [])];
    }
    case 'map': {
      ctx.media.push('map');
      const loc = isObj(b.location) ? b.location : {};
      const at = Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude) ? `${loc.latitude}, ${loc.longitude}` : '';
      return [placeholder('map', at, captionText(b.caption, depth))];
    }
    case 'buttons': {
      const labels = (Array.isArray(b.buttons) ? b.buttons : []).map((btn) => buttonText(btn, depth)).filter(Boolean);
      return [labels.length ? `[buttons: ${labels.join(' | ')}]` : '[buttons]'];
    }
    case 'thinking': {
      const text = oneLine(inline(b.text, depth));
      return [text ? `[thinking] ${text}` : '[thinking]'];
    }
    default: {
      const media = MEDIA_BLOCKS.get(type);
      if (media) {
        ctx.media.push(media.label);
        const file = isObj(b[media.field]) ? oneLine(str(b[media.field].file_name)) : '';
        return [placeholder(media.label, file, captionText(b.caption, depth))];
      }
      // UNKNOWN. Keep whatever it carries, and name it when it carries nothing.
      const out = [];
      if (b.text != null) {
        const text = inline(b.text, depth);
        if (text.trim()) out.push(text);
      }
      out.push(...blocks(b.blocks, ctx, depth + 1));
      if (!out.length) out.push(`[${type ? typeName(type) : 'unknown'} block]`);
      return out;
    }
  }
}

function blocks(list, ctx, depth) {
  if (!Array.isArray(list)) return [];
  if (depth > RICH_MAX_DEPTH) return list.length ? [TOO_DEEP] : [];
  return list.flatMap((b) => block(b, ctx, depth));
}

/**
 * Read a `rich_message` object.
 *
 *   text    the words, '' when there are none (an absent, empty or blank message)
 *   media   one entry per media block that was left as a placeholder, in order:
 *           'photo', 'video', 'animation', 'audio', 'file', 'voice note',
 *           'collage', 'slideshow', 'map'
 *   blocks  how many blocks were read, nested ones included
 *
 * Never throws: a shape this cannot read at all comes back as empty text, and
 * the caller treats an empty rich message as a kind it could not read.
 */
export function readRichMessage(rich) {
  const ctx = { media: [], blocks: 0 };
  let text = '';
  try {
    if (isObj(rich)) {
      const chunks = blocks(rich.blocks, ctx, 0);
      // A blank line they typed stays ONE blank line. Runs of them collapse, and
      // the ends are trimmed. Done on chunks, so the inside of a preformatted
      // block (one chunk) keeps every line it had.
      const kept = [];
      for (const c of chunks) {
        const blank = !String(c).trim();
        if (blank && (!kept.length || kept[kept.length - 1] === '')) continue;
        kept.push(blank ? '' : c);
      }
      while (kept.length && kept[kept.length - 1] === '') kept.pop();
      text = kept.join('\n').replace(/\r\n?/g, '\n').trim();
    }
  } catch {
    text = '';
    ctx.media.length = 0;
  }
  return { text, media: ctx.media, blocks: ctx.blocks };
}

/** The words of a `rich_message` object, '' when there are none. */
export function flattenRichMessage(rich) {
  return readRichMessage(rich).text;
}

/** RichText (a String, an Array of RichText, or a typed object) as a string. */
export function flattenRichText(richText) {
  try {
    return inline(richText, 0);
  } catch {
    return '';
  }
}

/** "2 photos and 1 file", in the order the kinds first appeared. */
function mediaCounts(media) {
  const counts = new Map();
  for (const m of media) counts.set(m, (counts.get(m) || 0) + 1);
  const parts = [...counts].map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The line that tells the engine what the placeholders mean.
 *
 * "[photo]" in the middle of their message reads as though the engine was handed
 * a photo. It was not: the bridge reads the words of a rich message and leaves
 * its media behind. Said once, at the end, so the engine can ask for the file
 * instead of guessing at it. '' when the message held no media.
 */
export function richMediaNote(media = []) {
  const list = (Array.isArray(media) ? media : []).filter(Boolean);
  if (!list.length) return '';
  return `[This formatted Telegram message also held ${mediaCounts(list)}, shown above as a placeholder. The bridge did not download that media. If it matters, ask for it as a normal attachment.]`;
}

/**
 * What a rich message becomes as a PROMPT: its words, plus the note when media
 * was left behind. '' when there are no words and no media.
 */
export function richPromptText(rich) {
  const read = readRichMessage(rich);
  if (!read.text) return '';
  const note = richMediaNote(read.media);
  return note ? `${read.text}\n\n${note}` : read.text;
}
