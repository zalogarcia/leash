// Markdown -> Telegram rich blocks (Bot API 10.2 `sendRichMessage`).
//
// Telegram has no table tag in HTML mode, so `renderMdTables` in md-format.mjs
// flattens every markdown table into "bold title + · header: value" bullets.
// That reads fine for a 2-column table and badly for a 4-column comparison.
// Bot API 10.2 added real block formatting, so tables can be tables again.
//
// SCHEMA — probed against the live API 2026-08-06, because the published docs
// truncate before the InputRichBlock field definitions. Every shape below was
// confirmed by a successful send; the rejected guesses are recorded so nobody
// re-derives them:
//
//   sendRichMessage { chat_id, rich_message: { blocks: [...] } }
//     blocks at the top level          -> "rich message must be non-empty"
//     {type:"section_heading"}         -> type "section_heading" is unsupported
//     {type:"heading"} without size    -> Can't find field "size"
//     {type:"heading", size:"h2"}      -> Field "size" must be a valid Number
//     {type:"table", rows:[...]}       -> Can't find field "cells"
//     {type:"table", cells:[["a"]]}    -> RichBlockTableCell must be an object
//     {type:"list", items:["a"]}       -> Object expected as InputRichBlockListItem
//     {type:"list", items:[{text:"a"}]}-> RICH_MESSAGE_EMPTY (needs .blocks)
//
//   WORKING (verified by reading back the STORED message, not by a 200 OK):
//     {type:"paragraph", text}                         plain text only
//     {type:"heading",   text, size:<Number>}
//     {type:"table",     cells:[[{text, is_header}]]}
//     {type:"list",      items:[{blocks:[...]}], ordered?}
//     {type:"details",   summary, blocks:[...]}        <- collapsible
//     {type:"blockquote", blocks:[...]}                <- quote (nested blocks)
//     {type:"pullquote",  text}                        <- quote (plain text)
//
//   SILENTLY DROPPED (accepted with 200 OK, then discarded — see toPlain):
//     paragraph.parse_mode, paragraph.entities, details.title
//
// TRADE-OFF: rich buys real tables and headings, at the cost of inline bold and
// code. Collapsible is NOT part of that trade any more — `detailsToHtml` below
// gives the HTML path expandable blockquotes, so only a genuine TABLE is worth
// leaving HTML for. Kill switch: TG_RICH=0.

// Table parsing is shared with the HTML path rather than reimplemented here.
// Both renderers must agree on what a table IS: `shouldUseRich` below decides a
// message goes rich BECAUSE it found a table, and the HTML fallback has to find
// the same one. Two copies of this predicate could disagree and route a message
// to a renderer that then declines to draw the table that caused the routing.
import { isTableSep, isTableRow, splitCells, fencedLines, mdToTelegramHtml, chunks, copyButtons, escHtml } from './md-format.mjs';

// Telegram accepted size:1 in probing. Deeper levels are clamped rather than
// guessed at — an unsupported size rejects the WHOLE message, and a heading
// that renders one level too large is a cosmetic loss, not a lost answer.
const MAX_HEADING_SIZE = 3;

// Conservative: the per-message limit for rich messages is undocumented, so
// split well under the 4096 that plain messages allow.
export const RICH_TEXT_BUDGET = 3200;

const blockTextLength = (b) => JSON.stringify(b).length;

// Which sender to use. Rich blocks buy real tables, at the cost of inline
// bold/code (Telegram drops parse_mode and entities inside blocks). Since the
// HTML path now handles collapsibles AND quotes AND keeps emphasis, a genuine
// TABLE is the only thing left that it cannot express — so that is the only
// automatic trigger. Headings don't qualify: HTML renders them bold, and that
// is a far smaller loss than every bold run in the body.
//
// Explicit override wins over the heuristic — the author sometimes knows the
// message needs a grid even when the markdown doesn't happen to contain one:
//   <!--rich-->   force rich blocks
//   <!--plain-->  force the HTML path
const RICH_MARKER = /<!--\s*rich\s*-->/i;
const PLAIN_MARKER = /<!--\s*plain\s*-->/i;

export function stripModeMarkers(md) {
  return String(md).replace(RICH_MARKER, '').replace(PLAIN_MARKER, '').replace(/^\n+/, '');
}

/**
 * Cut a reply into the tables that can go out as real grids and the markdown
 * around them, in order. A table is found the same way the HTML path finds it
 * (header row, separator row, body rows), and never inside a fenced block: a
 * fence that merely SHOWS a table used to send the whole reply down the rich
 * rail.
 *
 * A table with code in a cell is NOT handed to the rich rail (unless the author
 * asked for the grid with <!--rich-->): a rich cell is plain text, so a command
 * in it could not be copied with a tap, and one holding a pipe was cut in two
 * by the cell splitter. It stays in the markdown and the HTML path draws it as
 * stacked rows, where the code is a real code entity.
 * @returns {Array<{md: string}|{table: string}>}
 */
export function tableSegments(md, { codeCells = false } = {}) {
  const lines = String(md).split('\n');
  const fenced = fencedLines(md);
  const segs = [];
  let buf = [];
  let inDetails = false;
  const flush = () => {
    // The blank lines around a table belong to neither side of the cut.
    while (buf.length && !buf[0].trim()) buf.shift();
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
    if (buf.length) segs.push({ md: buf.join('\n') });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (!fenced[i]) {
      // A table inside ::: details stays with its section, on the HTML path.
      if (/^:::\s*details\b/.test(lines[i])) inDetails = true;
      else if (inDetails && /^:::\s*$/.test(lines[i])) inDetails = false;
    }
    if (!fenced[i] && !inDetails && !fenced[i + 1] && isTableRow(lines[i]) && isTableSep(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && !fenced[j] && isTableRow(lines[j])) j++;
      const rows = lines.slice(i, j);
      if (j > i + 2 && (codeCells || !rows.some((l) => l.includes('`')))) {
        flush();
        segs.push({ table: rows.join('\n') });
        i = j - 1;
        continue;
      }
    }
    buf.push(lines[i]);
  }
  flush();
  return segs;
}

export function shouldUseRich(md) {
  const t = String(md);
  if (PLAIN_MARKER.test(t)) return false;
  if (RICH_MARKER.test(t)) return true;
  // NOTE: `::: details` deliberately does NOT force rich any more. The HTML
  // path renders it as <blockquote expandable>, which collapses just as well
  // AND keeps inline bold/code. A real table is now the only thing HTML
  // genuinely cannot express, so it is the only automatic trigger: a header
  // row followed by a separator row, outside any fenced block.
  return tableSegments(t, { codeCells: true }).some((s) => s.table);
}

/**
 * THE PLAN FOR ONE REPLY: every message to send, in order.
 *
 * Only a table goes out as rich blocks. Everything else, the prose around a
 * table included, goes out as HTML, because a rich paragraph is plain text:
 * the old rich path sent the WHOLE reply as blocks, so every inline command in
 * a reply that happened to contain a table reached the phone with nothing to
 * tap (184 of 188 code spans across the 23 such replies of one month).
 *
 *   { kind: 'html', html, markup }           one sendMessage, parse_mode HTML
 *   { kind: 'rich', blocks, fallback: [...] } one sendRichMessage; `fallback`
 *       is the same table as HTML parts, for when the rich rail is off or
 *       Telegram refuses it, so a refusal costs one grid and not the reply
 *
 * `markup` carries the Copy buttons of the blocks in THAT message.
 * @param {string} md
 * @param {{limit: number, rich?: boolean}} opts  `limit` is the caller's
 *        message size; `rich: false` keeps every table on the HTML path
 */
export function planReply(md, { limit, rich = true } = {}) {
  const src = String(md);
  const clean = stripModeMarkers(src);
  const plain = PLAIN_MARKER.test(src);
  const segs = rich && !plain ? tableSegments(clean, { codeCells: RICH_MARKER.test(src) }) : [{ md: clean }];
  const buttons = copyButtons(clean).map((b) => ({ ...b, used: false }));
  const htmlParts = (text) =>
    chunks(detailsToHtml(text, mdToTelegramHtml), limit, { closePre: true })
      .filter((h) => h.trim())
      .map((html) => {
        const mine = buttons.filter((b) => !b.used && html.includes(`>${escHtml(b.code)}</code></pre>`));
        for (const b of mine) b.used = true;
        return { kind: 'html', html, markup: mine.length ? { inline_keyboard: mine.map((b) => [b.button]) } : null };
      });
  const out = [];
  for (const s of segs) {
    if (s.table) out.push({ kind: 'rich', blocks: mdToRichBlocks(s.table), fallback: htmlParts(s.table) });
    else out.push(...htmlParts(s.md));
  }
  return out;
}

/**
 * Render `::: details Title ... :::` as Telegram's expandable blockquote on the
 * HTML path, so a message can collapse detail WITHOUT surrendering inline bold
 * and code to the rich-block path.
 *
 * The conversion runs per-segment rather than on the whole string because
 * mdToTelegramHtml escapes HTML: injecting the tags first would render them as
 * visible text. Nested blockquotes are flattened — Telegram cannot nest them,
 * and a nested pair rejects the whole message.
 *
 * @param {string} md
 * @param {(s: string) => string} toHtml  bridge's mdToTelegramHtml
 */
export function detailsToHtml(md, toHtml) {
  const lines = String(md).split('\n');
  const out = [];
  let plain = [];
  const flushPlain = () => {
    const t = plain.join('\n');
    plain = [];
    if (t.trim()) out.push(toHtml(t));
  };
  for (let i = 0; i < lines.length; i++) {
    const det = /^:::\s*details\b\s*(.*)$/.exec(lines[i]);
    if (!det) {
      plain.push(lines[i]);
      continue;
    }
    flushPlain();
    const inner = [];
    let j = i + 1;
    while (j < lines.length && !/^:::\s*$/.test(lines[j])) inner.push(lines[j++]);
    const bodyHtml = toHtml(inner.join('\n'))
      .replace(/<\/?blockquote[^>]*>/g, '')  // cannot nest
      .trim();
    if (bodyHtml) {
      const title = det[1].trim();
      const head = title ? `<b>${title}</b>\n` : '';
      out.push(`<blockquote expandable>${head}${bodyHtml}</blockquote>`);
    }
    i = j;
  }
  flushPlain();
  return out.join('\n\n');
}

/**
 * Parse markdown into Telegram rich blocks.
 * @param {string} md
 * @param {(s: string) => string} [inlineHtml]  unused — see toPlain; kept so the
 *        call site does not change if inline formatting becomes available
 * @param {{nested?: boolean}} [opts]  set by the recursive calls: blocks nested
 *        inside details/blockquote must use only probed rich types
 * @returns {Array<object>} blocks
 */
export function mdToRichBlocks(md, inlineHtml, { nested = false } = {}) {
  const lines = String(md).split('\n');
  const blocks = [];
  let para = [];

  const flushPara = () => {
    const text = para.join('\n').trim();
    para = [];
    if (!text) return;
    blocks.push({ type: 'paragraph', text: toPlain(text) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ::: details Title  ... :::   — an explicit collapsible section.
    // Deliberately explicit: auto-collapsing by length would hide a conclusion
    // as readily as an appendix, and only the author knows which is which.
    const det = /^:::\s*details\b\s*(.*)$/.exec(line);
    if (det) {
      flushPara();
      const inner = [];
      let j = i + 1;
      while (j < lines.length && !/^:::\s*$/.test(lines[j])) inner.push(lines[j++]);
      const body = mdToRichBlocks(inner.join('\n'), inlineHtml, { nested: true });
      if (body.length) blocks.push({ type: 'details', summary: det[1].trim() || 'Details', blocks: body });
      i = j;
      continue;
    }

    // Fenced code — its OWN block type, hoisted out of the rich message.
    //
    // This used to claim it emitted "a paragraph carrying <pre>". It did not:
    // paragraphs are plain text (see toPlain), so the backticks were stripped
    // and nothing marked the text as code. Since any message with a table takes
    // this path, the owner had never actually received a code block — which is
    // also why no copy affordance ever appeared, there being nothing to copy
    // from. There is still no probed rich code type, and guessing one would get
    // the WHOLE message rejected, so the sender ships this block on the HTML
    // rail instead, as <pre><code class="language-x"> — the same tag md-format
    // has always produced, and what the clients make copyable at ANY length.
    const fm = /^([ \t]*)(`{3,})([^`]*)$/.exec(line);
    if (fm) {
      flushPara();
      // Same fence rules as md-format's splitFences: any indentation (a fence
      // nested in a list item), closed by at least as many backticks, the
      // opener's indentation removed from every line of the body.
      const lang = (/^[\w+#.-]+/.exec(fm[3].trim()) || [''])[0];
      const closeRe = new RegExp('^[ \\t]*`{' + fm[2].length + ',}[ \\t]*$');
      const dedent = (l) => {
        let k = 0;
        while (k < fm[1].length && (l[k] === ' ' || l[k] === '\t')) k++;
        return l.slice(k);
      };
      const body = [];
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) body.push(dedent(lines[j++]));
      const text = body.join('\n').replace(/\n+$/, '');
      // NESTED code (inside ::: details / a blockquote) stays a paragraph. A
      // nested block is sent INSIDE the rich message, where an unsupported type
      // rejects the whole thing — and hoisting it out would move the code away
      // from the section that explains it. Same loss as before, now bounded to
      // the rare case instead of every message.
      if (text.trim()) blocks.push(nested ? { type: 'paragraph', text } : { type: 'code', lang, text });
      i = j;
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      flushPara();
      blocks.push({
        type: 'heading',
        text: toPlain(h[2]),
        size: Math.min(h[1].length, MAX_HEADING_SIZE),
      });
      continue;
    }

    // Table: header row, separator, then body rows
    if (isTableRow(line) && isTableSep(lines[i + 1])) {
      const header = splitCells(line);
      let j = i + 2;
      const body = [];
      while (j < lines.length && isTableRow(lines[j])) body.push(splitCells(lines[j++]));
      if (body.length) {
        flushPara();
        const width = Math.max(header.length, ...body.map((r) => r.length));
        const pad = (row) => Array.from({ length: width }, (_, k) => row[k] ?? '');
        blocks.push({
          type: 'table',
          cells: [
            pad(header).map((c) => ({ text: toPlain(c), is_header: true })),
            ...body.map((r) => pad(r).map((c) => ({ text: toPlain(c) }))),
          ],
        });
        i = j - 1;
        continue;
      }
    }

    // Blockquote — a run of consecutive "> " lines becomes ONE quote block.
    // Telegram takes nested blocks here, so the quote keeps its own structure.
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quoted = [];
      let j = i;
      while (j < lines.length && /^\s*>\s?/.test(lines[j])) {
        quoted.push(lines[j].replace(/^\s*>\s?/, ''));
        j++;
      }
      const body = mdToRichBlocks(quoted.join('\n'), inlineHtml, { nested: true });
      if (body.length) blocks.push({ type: 'blockquote', blocks: body });
      i = j - 1;
      continue;
    }

    // Lists — a run of consecutive bullets or numbers becomes ONE list block
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      const items = [];
      let j = i;
      for (;;) {
        const m = ordered
          ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[j])
          : /^\s*[-*]\s+(.+)$/.exec(lines[j]);
        if (!m) break;
        items.push({ blocks: [{ type: 'paragraph', text: toPlain(m[1]) }] });
        j++;
      }
      const block = { type: 'list', items };
      if (ordered) block.ordered = true;
      blocks.push(block);
      i = j - 1;
      continue;
    }

    if (!line.trim()) flushPara();
    else para.push(line);
  }
  flushPara();
  return blocks;
}

// EVERY text field in a rich block is plain text.
//
// Measured 2026-08-06 by reading back what Telegram STORED (the send response
// echoes the parsed message, which is the only honest check — a 200 OK proves
// the JSON parsed, NOT that anything rendered):
//   {"type":"paragraph","text":"<b>x</b>","parse_mode":"HTML"}
//     -> stored verbatim as the literal string "<b>x</b>". parse_mode DROPPED.
//   {"type":"paragraph","text":"x","entities":[{...bold...}]}
//     -> stored with no entities at all. entities DROPPED, silently.
//   {"type":"details","title":"T"}  -> stored as {"summary":""}. title DROPPED.
// A rich-text object IS accepted in `text` ("Unsupported rich text type" rather
// than a field error), but none of bold / plain / fixed / concat / text_plain /
// rich_text_bold / RichTextBold / plain_text are the right discriminator, and
// the published docs truncate before the list. Until that name is known, inline
// emphasis inside a rich message is NOT available — so markers are stripped
// rather than passed through, because a literal "<b>" in the owner's reply is
// worse than plain prose.
function toPlain(s) {
  return String(s)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s.,;:!?)])/g, '$1$2')
    .trim();
}

/**
 * Split a block list into the runs the sender ships on each rail, in order:
 * `{rich: [...]}` goes to sendRichMessage, `{code: block}` goes out as its own
 * HTML message so it arrives as a real <pre> block. Order is preserved, so the
 * code still lands between the sections that explain it.
 *
 * Keeping this separate from chunkBlocks is what guarantees a code block never
 * reaches sendRichMessage as an unprobed type — which would reject the whole
 * message and latch the rich path off for the run.
 */
export function splitCodeRuns(blocks) {
  const runs = [];
  let cur = [];
  for (const b of blocks) {
    if (b.type === 'code') {
      if (cur.length) runs.push({ rich: cur });
      cur = [];
      runs.push({ code: b });
    } else {
      cur.push(b);
    }
  }
  if (cur.length) runs.push({ rich: cur });
  return runs;
}

/** Split blocks into message-sized groups without splitting a block. */
export function chunkBlocks(blocks, budget = RICH_TEXT_BUDGET) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const b of blocks) {
    const n = blockTextLength(b);
    // An oversized single block still ships alone — better one fat message
    // than a dropped section.
    if (cur.length && size + n > budget) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(b);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
