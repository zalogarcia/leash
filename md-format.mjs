// Markdown -> Telegram HTML, and safe chunking of the result.
//
// SHARED MODULE — byte-identical in the public and private bridge repos.
// scripts/check-shared.sh fails on drift. It owns no paths, no credentials and
// no owner-specific prose: every limit (Telegram's message size) arrives as a
// parameter, so neither repo has to patch a constant to use it.
//
// Telegram's HTML mode is NOT html. Its entire vocabulary is
// b/i/u/s/a/code/pre/blockquote/span/tg-spoiler/tg-emoji — no tables, no
// headings, no nesting of code inside a blockquote. Everything here exists to
// map markdown onto that small set without emitting a tag Telegram will reject,
// because a rejected entity parse costs the WHOLE message its formatting: the
// sender falls back to plain text and the answer arrives as tag soup.

export const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// One pass over the entities, never three: unescaping `&amp;` first and `&lt;`
// second turned a literal "&lt;" in the source (sent as "&amp;lt;") into "<",
// so the plain text fallback changed a character of the code it was carrying.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"' };
export const stripHtml = (s) => s.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot);/g, (_, e) => ENTITIES[e]);

// Telegram's HTML has NO table tag, so a markdown table used to reach the phone
// as raw pipe soup with the |---|---| separator sitting there in plain sight.
//
// Reshaped into a titled block per row instead: first cell becomes the bold
// heading, remaining cells become "column: value" lines. Chosen over rendering
// the grid inside <pre>: a fixed-width grid only holds while every row fits the
// screen, and on a phone a 3-column table almost never does — it wraps and the
// columns scramble, which is worse than no table at all.
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-*:?\s*)*\|?\s*$/;
// The ONE definition of "this line separates a table header from its body",
// shared with rich-format.mjs so both renderers agree. Every pipe in TABLE_SEP
// is optional, so the regex alone also matches a bare `---` — which after a
// table row is a thematic break, not a separator. Requiring a literal pipe is
// what distinguishes them, and it is why this is a function and not the raw
// regex: three call sites previously spelled this rule three different ways,
// and rich-format's looser two routed `| a | b |` + `---` to the rich path
// while the HTML fallback declined to draw it — so a rich failure dropped both
// the table AND the inline bold/code the rich path had already traded away.
export const isTableSep = (l) => typeof l === 'string' && l.includes('|') && TABLE_SEP.test(l);
// Require a LEADING pipe: without it any prose line containing "a | b" would be
// read as a table row.
export const isTableRow = (l) => /^\s*\|/.test(l) && /\|/.test(l);
// Split on unescaped pipes only, so a cell may contain a literal \| .
export const splitCells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());

export function renderMdTables(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const sep = lines[i + 1];
    // header row, separator row, then one or more body rows
    if (isTableRow(lines[i]) && isTableSep(sep)) {
      const headers = splitCells(lines[i]);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && isTableRow(lines[j])) rows.push(splitCells(lines[j++]));
      if (rows.length) {
        for (const cells of rows) {
          const title = cells[0] || '';
          // Bold markdown inside the cell already produced <b>; don't nest it.
          if (title) out.push(title.includes('<b>') ? title : `<b>${title}</b>`);
          for (let k = 1; k < cells.length; k++) {
            const v = cells[k];
            if (!v) continue; // empty cell — the column doesn't apply to this row
            const h = headers[k];
            out.push(h ? `· <i>${h}</i>: ${v}` : `· ${v}`);
          }
          out.push('');
        }
        i = j - 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CODE, FOUND THE WAY THE AUTHOR WROTE IT
//
// The owner copies commands out of these messages by tapping them, so a code
// span has to reach Telegram as ONE unit with every character and every piece
// of whitespace it was written with. This section is the one definition of
// "what is code in this reply", shared by both renderers, the copy buttons and
// the dash normalizer, so none of them can disagree about where code starts.
//
// It reads fences by LINE and inline spans by BACKTICK RUN, as CommonMark does.
// The two regexes this replaces each broke real replies:
//   /```([\w-]*)\n?([\s\S]*?)```/   read "```npm test```" as language "npm" and
//                                   code " test"; kept a list item's indent in
//                                   front of every line of a nested fence (a
//                                   heredoc terminator then never matches); and
//                                   could not see a four backtick fence.
//   /`([^`\n]+)`/                   split "`` a`b ``" into two fragments.
// ---------------------------------------------------------------------------
const FENCE_OPEN = /^([ \t]*)(`{3,})([^`]*)$/;

/**
 * Split markdown into its fenced blocks and the text between them, in order.
 * A fence is a line of three or more backticks, closed by a line of at least as
 * many (or by the end of the reply). Its code is the body with the OPENER'S
 * indentation removed and nothing else touched: every space, tab and blank line
 * inside it is the author's. Blank lines after the last line of code are not
 * code (Telegram trims them off a message anyway, so keeping them would make
 * the same block copy differently depending on where it sits).
 * @returns {Array<{text: string}|{fence: {lang: string, code: string}}>}
 */
export function splitFences(md) {
  const lines = String(md).split('\n');
  const out = [];
  let text = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN.exec(lines[i]);
    if (!m) {
      text.push(lines[i]);
      continue;
    }
    const [, indent, ticks, info] = m;
    const close = new RegExp('^[ \\t]*`{' + ticks.length + ',}[ \\t]*$');
    const body = [];
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) body.push(lines[j++]);
    const dedent = (l) => {
      let k = 0;
      while (k < indent.length && (l[k] === ' ' || l[k] === '\t')) k++;
      return l.slice(k);
    };
    if (text.length) out.push({ text: text.join('\n') });
    text = [];
    out.push({ fence: { lang: (/^[\w+#.-]+/.exec(info.trim()) || [''])[0], code: body.map(dedent).join('\n').replace(/\n+$/, '') } });
    i = j; // the closing line, or past the end for a fence nobody closed
  }
  if (text.length) out.push({ text: text.join('\n') });
  return out;
}

/** For each line of `md`: is it part of a fenced block (its fence lines included)? */
export function fencedLines(md) {
  const lines = String(md).split('\n');
  const mask = lines.map(() => false);
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN.exec(lines[i]);
    if (!m) continue;
    const close = new RegExp('^[ \\t]*`{' + m[2].length + ',}[ \\t]*$');
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    for (let k = i; k <= Math.min(j, lines.length - 1); k++) mask[k] = true;
    i = j;
  }
  return mask;
}

// A line that starts a new block. An inline span may run on to the next line of
// its own paragraph, but a stray backtick must never pair with one in the next
// list item or the next table row.
const BLOCK_START = /^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+|#{1,6}[ \t]|>|\||:::)/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

/**
 * Every inline code span of `text` (fences already lifted out), in order.
 * A span opens with a run of N backticks and closes at the next run of exactly
 * N in the same paragraph, so a span may hold backticks of its own. One space
 * of padding on each side is delimiter, not code (CommonMark); everything else
 * inside is kept exactly, a line break included.
 * @returns {Array<{start: number, end: number, code: string, multiline: boolean}>}
 */
export function inlineCodeSpans(text) {
  const src = String(text);
  const scopes = [];
  let pos = 0;
  let open = -1;
  for (const l of src.split('\n')) {
    const stop = !l.trim() || l.includes('\u0000');
    if (stop) {
      if (open !== -1) scopes.push([open, pos - 1]);
      open = -1;
    } else if (open === -1) open = pos;
    else if (BLOCK_START.test(l)) {
      scopes.push([open, pos - 1]);
      open = pos;
    }
    pos += l.length + 1;
  }
  if (open !== -1) scopes.push([open, src.length]);
  const spans = [];
  for (const [a, b] of scopes) {
    const s = src.slice(a, b);
    const runs = [];
    const re = /`+/g;
    let r;
    while ((r = re.exec(s))) {
      // "\`" in prose is a literal backtick, not a delimiter.
      let bs = 0;
      for (let k = r.index - 1; k >= 0 && s[k] === '\\'; k--) bs++;
      if (bs % 2 === 1 && r[0].length === 1) continue;
      runs.push({ at: r.index, n: r[0].length });
    }
    for (let k = 0; k < runs.length; ) {
      const o = runs[k];
      let c = k + 1;
      while (c < runs.length && runs[c].n !== o.n) c++;
      if (c >= runs.length) {
        k++;
        continue;
      }
      let code = s.slice(o.at + o.n, runs[c].at);
      if (code.length > 1 && /^[ \n]/.test(code) && /[ \n]$/.test(code) && code.trim()) code = code.slice(1, -1);
      if (code.length) spans.push({ start: a + o.at, end: a + runs[c].at + runs[c].n, code, multiline: code.includes('\n') });
      k = c + 1;
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// WHICH INLINE SPANS BECOME THEIR OWN BLOCK
//
// A command the owner will paste into a terminal is promoted from inline code
// to a block on its own line when it is long, when it sits in a list item, or
// when it spans lines. Three reasons, in order of weight: a block can carry the
// Copy button, which hands over the exact text whatever the app does with a
// tap; a long command wrapped inside a sentence is hard to tell apart from the
// sentence; and a block never inherits a list's indent. Names, flags and paths
// (one word) stay inline, and so does a command wrapped in bold or a link, in a
// table row, a heading or a quote, where a block cannot live.
// ---------------------------------------------------------------------------
export const PROMOTE_MIN = 40;
const COMMAND_WORD =
  /^(?:sudo |[A-Z_][A-Z0-9_]*=\S* )*(?:cd|ls|cat|cp|mv|rm|mkdir|echo|export|source|node|npm|npx|pnpm|yarn|bun|deno|git|gh|bash|sh|zsh|python3?|pip3?|uv|curl|wget|nohup|open|brew|launchctl|tmux|supabase|vercel|docker|kubectl|aws|ssh|scp|kill|pkill|killall|ps|grep|sed|awk|find|chmod|chown|tail|head|touch|codex|claude|make|cargo|go|psql|ffmpeg|xcrun|xcodebuild|pod|osascript|defaults|caffeinate)\s/;

/** Is this inline span something that gets pasted into a terminal? */
export function isCommand(code) {
  const c = String(code).trim();
  if (!/\s/.test(c)) return false; // one word: a name, a flag, a path
  return COMMAND_WORD.test(c) || /^(?:(?:\.{1,2}|~)\/\S+|\/\S+\/\S*)\s/.test(c) || /&&|\|\||\$\(|2>&1|\s[|>]\s/.test(c);
}

function promotes(span, line, before, after) {
  if (/^[ \t]*(?:\||#{1,6}[ \t]|>)/.test(line)) return false; // a table row, a heading, a quote
  if (/[*_~[\](]$/.test(before) || /^[*_~[\])]/.test(after)) return false; // wrapped in emphasis or a link
  if ((before.match(/\*\*/g) || []).length % 2) return false; // inside a bold run that is still open
  if (span.multiline) return true;
  if (!isCommand(span.code)) return false;
  return span.code.length >= PROMOTE_MIN || LIST_ITEM.test(line);
}

// ---------------------------------------------------------------------------
// THE LANGUAGE EVERY BLOCK IS SENT WITH, AND WHY IT IS NEVER A REAL ONE
//
// Measured on 2026-10-05 against the live Bot API: a <pre> sent with NO
// language comes back from Telegram as language "shell" when its text looks
// like a shell command (message 22271), and a block that carries a language is
// syntax highlighted by the apps. On the iPhone a tap on a code block copies
// `attribute(_:at:effectiveRange:)` of the block (Telegram-iOS, TextNode
// `attributeSubstring`), which is the run of identically styled text under the
// finger: the whole block when nothing is highlighted, one coloured stretch
// when something is. So a tap on a highlighted shell command copied the part
// between two `&&` and dropped the rest, which is exactly what reached the
// owner's terminal on 2026-09-26 (the `cd` in front and the second `npm
// install` behind were both left out), while a block of prose, which Telegram
// leaves unlabelled, always copied whole.
//
// So every block goes out with an explicit language no app highlights. That
// takes Telegram's own detection out of the loop (an explicit language is
// kept) and leaves the block one run of text. The author's language is dropped
// on purpose: a coloured block that copies in pieces is worse than a plain one
// that copies whole.
// ---------------------------------------------------------------------------
export const PLAIN_LANG = 'text';

// A TAB is the one character Telegram cannot carry. Measured 2026-10-05: a tab
// inside a <pre> came back as one space (message 22289), and so did a tab in a
// Copy button's own text (22296). Nothing here can deliver it, so the loss is
// said out loud under the block instead of happening silently: a Makefile recipe
// or a `<<-` heredoc pasted with spaces fails in a way that is hard to trace.
export const TAB_NOTE = 'Telegram stores each tab above as one space. Put the tabs back after you paste.';

/** Render one code block as Telegram's <pre>. The ONE escaping of a block. */
export function codeHtml(code) {
  const body = String(code).replace(/\n+$/, '');
  return `<pre><code class="language-${PLAIN_LANG}">${escHtml(body)}</code></pre>${body.includes('\t') ? `\n<i>${TAB_NOTE}</i>` : ''}`;
}

// Markdown -> { html, blocks }. `blocks` is the code of every <pre> in the
// order it appears, fenced or promoted: what a Copy button can carry.
function render(md) {
  const pres = [];
  const hold = (code) => `\u0000${pres.push(code) - 1}\u0000`;
  let t = splitFences(md)
    .map((s) => (s.fence ? (s.fence.code.trim() ? hold(s.fence.code) : '') : s.text))
    .join('\n');
  const inline = [];
  let out = '';
  let at = 0;
  for (const s of inlineCodeSpans(t)) {
    const lineStart = t.lastIndexOf('\n', s.start - 1) + 1;
    let lineEnd = t.indexOf('\n', s.end);
    if (lineEnd === -1) lineEnd = t.length;
    const after = t.slice(s.end, lineEnd);
    if (!promotes(s, t.slice(lineStart, lineEnd), t.slice(lineStart, s.start), after)) {
      out += `${t.slice(at, s.start)}\u0001${inline.push(`<code>${escHtml(s.code)}</code>`) - 1}\u0001`;
      at = s.end;
      continue;
    }
    // Its own line, no indent. Punctuation that only closed the sentence is
    // dropped rather than left alone on a line under the block.
    out += t.slice(at, s.start).replace(/[ \t]+$/, '');
    if (out && !out.endsWith('\n')) out += '\n';
    out += hold(s.code);
    if (/^[ \t]*[.,;:!?)]*[ \t]*$/.test(after)) at = lineEnd;
    else {
      out += '\n';
      at = s.end + (after.length - after.trimStart().length);
    }
  }
  t = out + t.slice(at);
  t = escHtml(t);
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  // Italic runs AFTER bold so ** is already consumed. Only *…* — underscores
  // would eat snake_case identifiers in prose. The delimiters must hug
  // non-space, per CommonMark: without that, prose like "3 * 4 and 2 * 5" pairs
  // two unrelated asterisks and italicises everything between them, and a
  // bullet ending in '*' turns into emphasis instead of a list item.
  t = t.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
  // A " inside the URL would break out of the href attribute; &quot; is one of
  // the four named entities Telegram accepts.
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label, href) => `<a href="${href.replace(/"/g, '&quot;')}">${label}</a>`,
  );
  // After bold/italic/links so cell contents keep their inline formatting, and
  // before the bullet rule — table rows start with '|', never '-', so neither
  // transform can eat the other's input.
  t = renderMdTables(t);
  t = t.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  // Markdown "> quote" — escHtml already turned the marker into &gt;.
  // Consecutive quoted lines collapse into ONE blockquote (they can't nest).
  t = t.replace(/(?:^&gt;[ \t]?.*(?:\n|$))+/gm, (blk) => {
    const body = blk
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => l.replace(/^&gt;[ \t]?/, ''))
      .join('\n');
    return `<blockquote>${body}</blockquote>\n`;
  });
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => inline[i]);
  const blocks = [];
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    blocks.push(pres[i]);
    return codeHtml(pres[i]);
  });
  return { html: t, blocks };
}

// Convert Claude's markdown replies to Telegram-HTML (headers→bold, fences→pre,
// inline code, links, bullets, tables). Code spans are extracted first so no
// transform touches their contents. Sender falls back to plain on a parse reject.
export function mdToTelegramHtml(md) {
  return render(md).html;
}

/** The code of every block a reply renders, in order: fenced and promoted. */
export const codeBlocks = (md) => render(md).blocks;

/**
 * Where the code of a markdown text is, as [start, end) ranges over the source:
 * each fence with its fence lines, each inline span with its backticks. For a
 * transform that must leave code alone (the dash normalizer).
 */
export function codeRanges(md) {
  const src = String(md);
  const ranges = [];
  const lines = src.split('\n');
  let pos = 0;
  let masked = '';
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN.exec(lines[i]);
    if (!m) {
      masked += `${lines[i]}\n`;
      pos += lines[i].length + 1;
      continue;
    }
    const close = new RegExp('^[ \\t]*`{' + m[2].length + ',}[ \\t]*$');
    const start = pos;
    let j = i + 1;
    pos += lines[i].length + 1;
    while (j < lines.length && !close.test(lines[j])) pos += lines[j++].length + 1;
    if (j < lines.length) pos += lines[j].length + 1;
    const end = Math.min(pos - 1, src.length);
    ranges.push([start, end]);
    // Same length as the source, so inline offsets below need no translation.
    masked += `${'\u0000'.repeat(end - start)}\n`;
    i = j;
  }
  for (const s of inlineCodeSpans(masked.slice(0, src.length))) ranges.push([s.start, s.end]);
  return ranges.sort((a, b) => a[0] - b[0]);
}

// Bot API 8.0's InlineKeyboardButton.copy_text: "The text to be copied to the
// clipboard; 1-256 characters". The button hands the app the exact string, so
// it is the one copy that cannot depend on how an app treats a tap. Its cap is
// shorter than many snippets worth pasting, so a longer block goes without one
// and is never truncated to fit: a button that copies half a command is worse
// than no button.
export const COPY_TEXT_LIMIT = 256;
export const COPY_BUTTON_MAX = 6;

/**
 * One Copy button per block that fits the cap, in the order the blocks appear.
 * A reply with a single block gets a button that just says Copy; with several,
 * each button names its block by how the code starts, because a row of bare
 * "Copy" buttons cannot say which one copies what.
 * @returns {Array<{code: string, button: object}>}
 */
export function copyButtons(md, { limit = COPY_TEXT_LIMIT, max = COPY_BUTTON_MAX } = {}) {
  const blocks = codeBlocks(md);
  const seen = new Set();
  const fit = blocks.filter((c) => c.trim() && c.length <= limit && !seen.has(c) && seen.add(c)).slice(0, max);
  return fit.map((code) => {
    const first = code.trim().split('\n')[0];
    const label = blocks.length === 1 ? 'Copy' : `Copy: ${first.length > 24 ? `${first.slice(0, 23)}…` : first}`;
    return { code, button: { text: label, copy_text: { text: code } } };
  });
}

/**
 * The copy button for a message with exactly ONE block, or null.
 * @returns {{code: string, markup: object}|null}
 */
export function copyButtonFor(md, limit = COPY_TEXT_LIMIT) {
  if (codeBlocks(md).length !== 1) return null;
  const [one] = copyButtons(md, { limit });
  return one ? { code: one.code, markup: { inline_keyboard: [[one.button]] } } : null;
}

// ---------------------------------------------------------------------------
// SPLITTING A REPLY INTO MESSAGES
// ---------------------------------------------------------------------------

// Telegram keeps at most 100 formatting entities on a message and drops the
// rest WITHOUT an error. Measured 2026-10-05 (message 22261): a message sent
// with 126 came back with exactly 100, and the code spans past that point were
// plain text, so a tap on them copied nothing. A message is therefore cut
// before its entity count can pass the cap. The count is conservative: every
// tag is one, and a code span or link inside bold or italic is two, because
// Telegram cuts the outer run in two around it.
export const ENTITY_BUDGET = 100;
const RUN_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'span', 'tg-spoiler']);
const LABEL_RESERVE = 24; // room for "part 12 of 12\n" in front of a split block

// Rendered HTML -> messages. What it guarantees, in order of rank:
//   1. every message is valid on its own: a tag open at the cut is closed
//      there and reopened in the next message. The old cut left a quote open
//      in one message and closed in the next, Telegram refused both and the
//      whole reply fell back to plain text with no code in it at all.
//   2. a code block is never cut unless it is, alone, longer than a message.
//      A block that would straddle the limit moves whole into the next message;
//      a block longer than a message starts its own message, is cut only at a
//      line break, and each piece is labelled "part 1 of N".
//   3. an inline code span is never cut.
//   4. no message carries more entities than Telegram keeps.
// Then, as before: prefer a line break, fall back to a space, hard cut last.
function chunkHtml(html, size) {
  const tags = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)\b[^<>]*>/g;
  let m;
  const stack = [];
  while ((m = re.exec(html))) {
    const t = { start: m.index, end: re.lastIndex, name: m[2].toLowerCase(), close: m[1] === '/', str: m[0] };
    if (t.close) {
      const open = stack.pop();
      if (open) open.closedAt = t.end;
    } else {
      t.weight = 1 + ((t.name === 'code' || t.name === 'a') && stack.some((s) => RUN_TAGS.has(s.name)) ? 1 : 0);
      stack.push(t);
    }
    t.after = stack.slice();
    tags.push(t);
  }
  // The tags open at position p (p is never inside a tag when this is asked).
  const stackAt = (p) => {
    let st = [];
    for (const t of tags) {
      if (t.end > p) break;
      st = t.after;
    }
    return st;
  };
  const inTag = (p) => tags.find((t) => t.start < p && p < t.end);
  const safe = (p) => !inTag(p) && !stackAt(p).some((t) => t.name === 'pre' || t.name === 'code');
  const closers = (st) => st.slice().reverse().map((t) => `</${t.name}>`).join('');
  const weightIn = (a, b) => tags.reduce((n, t) => n + (!t.close && t.start >= a && t.start < b ? t.weight : 0), 0);
  // A hard cut still must not land inside a tag, an &entity; or a surrogate pair.
  const clean = (p) => {
    const t = inTag(p);
    if (t) p = t.start;
    const amp = html.lastIndexOf('&', p - 1);
    if (amp !== -1 && p - amp < 10) {
      const semi = html.indexOf(';', amp);
      if (semi !== -1 && semi >= p && semi - amp < 10) p = amp;
    }
    if (p > 0 && /[\uD800-\uDBFF]/.test(html[p - 1])) p--;
    return p;
  };
  const pickCut = (pos, lim) => {
    const pre = stackAt(lim).find((t) => t.name === 'pre');
    if (pre) {
      // The block starts in this message and does not end in it: it moves to
      // the next message, where it either fits whole or is split by line.
      if (pre.start > pos) return pre.start;
      const bodyStart = Math.max(pre.end, ...tags.filter((t) => !t.close && t.name === 'code' && t.start === pre.end).map((t) => t.end));
      const nl = html.lastIndexOf('\n', lim - 1);
      return nl > bodyStart ? nl : clean(lim);
    }
    const half = pos + Math.floor((lim - pos) * 0.5);
    for (const floor of [half, pos]) {
      for (const ch of ['\n', ' ']) {
        for (let p = html.lastIndexOf(ch, lim - 1); p > floor; p = html.lastIndexOf(ch, p - 1)) if (safe(p)) return p;
      }
    }
    // One unbroken run. Keep an inline span whole if it is what straddles.
    const code = stackAt(lim).find((t) => t.name === 'code');
    return code && code.start > pos ? code.start : clean(lim);
  };

  const pieces = []; // { pos, cut, carry }
  const split = new Map(); // a <pre> cut across messages -> the pieces holding it
  const note = (pre, i) => {
    if (!split.has(pre)) split.set(pre, []);
    if (!split.get(pre).includes(i)) split.get(pre).push(i);
  };
  let pos = 0;
  let carry = [];
  while (pos < html.length) {
    // The size limit is Telegram's, so it outranks a valid tag: when the tags
    // to reopen cannot fit the budget at all (a tiny `size`), nothing is
    // reopened and the text goes out raw rather than over the limit.
    if (carry.length && carry.map((t) => t.str).join('').length + closers(carry).length + LABEL_RESERVE >= size) carry = [];
    const prefix = carry.map((t) => t.str).join('').length + (carry.some((t) => t.name === 'pre') ? LABEL_RESERVE : 0);
    const carried = carry.reduce((n, t) => n + t.weight, 0);
    let cut = html.length;
    if (prefix + (html.length - pos) > size || carried + weightIn(pos, html.length) > ENTITY_BUDGET) {
      let lim = Math.min(html.length, pos + Math.max(1, size - prefix));
      let w = carried;
      for (const t of tags) {
        if (t.close || t.start < pos) continue;
        if (t.start >= lim) break;
        w += t.weight;
        if (w > ENTITY_BUDGET) {
          lim = t.start;
          break;
        }
      }
      cut = pickCut(pos, lim);
      // The closers (and a part label) must fit in the same message.
      for (let tries = 0; tries < 4; tries++) {
        const st = stackAt(cut);
        const over = prefix + (cut - pos) + closers(st).length + (st.some((t) => t.name === 'pre') ? LABEL_RESERVE : 0) - size;
        if (over <= 0) break;
        cut = pickCut(pos, Math.max(pos + 1, cut - over));
      }
      // Never accept a cut that does not advance: that is an infinite loop on
      // the daemon's event loop. The hard cut is always available.
      if (cut <= pos) cut = Math.max(pos + 1, clean(lim) > pos ? clean(lim) : lim);
    }
    let st = cut < html.length ? stackAt(cut) : [];
    // Same rule at the other end: closers that would push the message over the
    // limit are left off, and then nothing is reopened either.
    if (prefix + (cut - pos) + closers(st).length > size) st = [];
    if (html.slice(pos, cut).trim() || !pieces.length) {
      const i = pieces.length;
      pieces.push({ pos, cut, carry, close: closers(st) });
      for (const t of carry) if (t.name === 'pre') note(t, i);
      for (const t of st) if (t.name === 'pre') note(t, i);
    }
    carry = st;
    pos = cut;
    if (html[pos] === '\n') pos++;
    if (!carry.some((t) => t.name === 'pre')) while (html[pos] === '\n') pos++;
  }
  if (!pieces.length) return [''];
  const label = (pre, i) => {
    const at = split.get(pre);
    return at && at.length > 1 && at.includes(i) ? `part ${at.indexOf(i) + 1} of ${at.length}\n` : '';
  };
  return pieces.map((p, i) => {
    let head = '';
    for (const t of p.carry) head += (t.name === 'pre' ? label(t, i) : '') + t.str;
    let body = html.slice(p.pos, p.cut);
    // A split block that OPENS inside this message gets its label there.
    const opened = [...split.keys()].filter((t) => t.start >= p.pos && t.start < p.cut && label(t, i)).sort((a, b) => b.start - a.start);
    for (const t of opened) {
      const at = t.start - p.pos;
      const lead = body.slice(0, at);
      body = `${lead}${lead && !lead.endsWith('\n') ? '\n' : ''}${label(t, i)}${body.slice(at)}`;
    }
    return head + body + p.close;
  });
}

// Split text into sendable pieces. `size` is the caller's limit: Telegram's own
// ceiling lives in the daemon, not here.
//
// `closePre` is for callers passing RENDERED HTML, and it selects the splitter
// above, which knows what a tag and a code block are. Without it the text is
// raw (plain text, or markdown not yet rendered) and only the boundary rules
// apply: prefer a line break, fall back to a space, and hard cut only when one
// line alone exceeds the limit.
export function chunks(text, size, { closePre = false } = {}) {
  if (closePre) return chunkHtml(String(text), size);
  const out = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    let cut = window.lastIndexOf('\n');
    if (cut < size * 0.5) cut = window.lastIndexOf(' '); // don't strand a tiny chunk
    if (cut < size * 0.5) cut = size; // one unbroken run — hard-cut is the only option
    // Never cut inside a tag: if the boundary sits after an unclosed '<', back
    // up to it so the tag moves whole into the next chunk.
    const open = window.slice(0, cut).lastIndexOf('<');
    if (open > -1 && window.slice(open, cut).indexOf('>') === -1) cut = open;
    // Backing up to `open` can land on 0 (an unclosed '<' at the very start of
    // the window), which would push an empty chunk and leave `rest` untouched —
    // a synchronous infinite loop that freezes the whole daemon, since this
    // while() blocks the event loop. Never accept a non-advancing cut: take the
    // hard cut instead.
    if (cut <= 0) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out.length ? out : [''];
}
