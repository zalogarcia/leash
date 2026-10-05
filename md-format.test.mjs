#!/usr/bin/env node
// Tests for md-format.mjs — the markdown -> Telegram-HTML layer.
//
// SHARED TEST — byte-identical in the public and private bridge repos, like the
// module it covers. Anything repo-specific (a path in a fixture, a divergent
// regression case) belongs in that repo's own test.mjs, not here.
//
// These used to live in test.mjs, where they were run against functions sliced
// out of bridge.mjs by source text. They now import the module directly, so a
// rename or a missing binding is a load error instead of a silently-skipped
// assertion.
//
//   node md-format.test.mjs

import {
  chunks,
  escHtml,
  stripHtml,
  isTableRow,
  isTableSep,
  splitCells,
  renderMdTables,
  mdToTelegramHtml,
  codeHtml,
  copyButtonFor,
  copyButtons,
  codeBlocks,
  isCommand,
  COPY_TEXT_LIMIT,
  ENTITY_BUDGET,
  PLAIN_LANG,
  TAB_NOTE,
} from './md-format.mjs';

const M = { chunks, escHtml, stripHtml, isTableRow, isTableSep, splitCells, renderMdTables, mdToTelegramHtml };

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};

// ---------- mdToTelegramHtml: only Telegram-supported tags ----------
const TG_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'span', 'tg-emoji',
]);

t('emits only tags Telegram supports', () => {
  const html = M.mdToTelegramHtml('# H\n**b** *i* `c`\n- x\n> q\n```js\nlet a = 1 < 2;\n```\n[l](https://e.com)');
  for (const tag of html.matchAll(/<\/?([a-z-]+)[\s>]/g)) {
    ok(TG_TAGS.has(tag[1]), `unsupported tag <${tag[1]}> would be rejected by Telegram`);
  }
});

t('fenced code is a pre block, and its language is never one an app highlights', () => {
  ok(M.mdToTelegramHtml('```python\nx=1\n```').includes('<pre><code class="language-text">x=1</code></pre>'), 'not a plain block');
});

t('code contents are escaped, not interpreted', () => {
  const html = M.mdToTelegramHtml('```\nif (a < b && c > d) {}\n```');
  ok(html.includes('&lt;') && html.includes('&amp;&amp;') && html.includes('&gt;'), 'raw < > & would break the parse');
});

t('snake_case is NOT italicised', () => {
  const html = M.mdToTelegramHtml('some_var_name here');
  ok(!html.includes('<i>'), 'underscores in identifiers must not become italics');
});

t('single asterisks do become italics', () => {
  ok(M.mdToTelegramHtml('an *emphatic* word').includes('<i>emphatic</i>'));
});

t('bold survives alongside italics', () => {
  const html = M.mdToTelegramHtml('**bold** and *it*');
  ok(html.includes('<b>bold</b>') && html.includes('<i>it</i>'));
});

t('spaced asterisks in prose are not paired into italics', () => {
  const html = M.mdToTelegramHtml('costs 3 * 4 hours and 2 * 5 dollars');
  ok(!html.includes('<i>'), `unrelated asterisks were paired: ${html}`);
});

t('a bullet whose text ends in an asterisk stays a bullet', () => {
  const html = M.mdToTelegramHtml('* buy milk*');
  ok(!html.includes('<i>'), `bullet became emphasis: ${html}`);
  ok(html.includes('•'), `bullet marker lost: ${html}`);
});

t('consecutive quote lines collapse into ONE blockquote', () => {
  const html = M.mdToTelegramHtml('> a\n> b\n> c');
  eq((html.match(/<blockquote>/g) || []).length, 1, 'blockquotes cannot nest or repeat per line');
});

t('ampersands in link URLs are escaped', () => {
  ok(M.mdToTelegramHtml('[l](https://e.com/?a=1&b=2)').includes('a=1&amp;b=2'));
});

// ---------- escHtml / stripHtml ----------
t('escHtml neutralises the three characters that break an entity parse', () => {
  eq(M.escHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

t('escHtml escapes & FIRST, so an escape is never double-escaped', () => {
  // '&' last would turn the '&' of '&lt;' into '&amp;lt;' and print the entity.
  eq(M.escHtml('<'), '&lt;');
});

t('stripHtml is the inverse used for the plain-text fallback', () => {
  eq(M.stripHtml('<b>hi</b> &amp; <i>bye</i>'), 'hi & bye');
});

t('stripHtml unwraps a full rendered message without leaving markup', () => {
  const plain = M.stripHtml(M.mdToTelegramHtml('# H\n**b** and `c`\n- x'));
  ok(!/[<>]/.test(plain.replace(/&[a-z]+;/g, '')), `markup survived: ${plain}`);
});

// ---------- tables ----------
t('isTableRow needs a LEADING pipe, so prose with a pipe is not a table', () => {
  ok(M.isTableRow('| a | b |'));
  ok(M.isTableRow('  | a |'));
  ok(!M.isTableRow('costs a | b in prose'));
  ok(!M.isTableRow('no pipes at all'));
});

t('splitCells trims the outer pipes and every cell', () => {
  eq(M.splitCells('| a | b |'), ['a', 'b']);
});

t('splitCells keeps an escaped pipe inside a cell', () => {
  eq(M.splitCells('| a \\| b | c |'), ['a | b', 'c']);
});

t('a table becomes one titled block per row', () => {
  const out = M.renderMdTables('| Name | Role |\n|---|---|\n| Ada | eng |');
  ok(out.includes('<b>Ada</b>'), `first cell should be the bold title: ${out}`);
  ok(out.includes('· <i>Role</i>: eng'), `remaining cells become header: value: ${out}`);
  ok(!out.includes('|---|'), `separator row leaked: ${out}`);
});

t('an empty cell is omitted rather than printed as a blank row', () => {
  const out = M.renderMdTables('| Name | Role |\n|---|---|\n| Ada | |');
  ok(!out.includes('Role'), `empty cell should drop its column: ${out}`);
});

t('a bold first cell is not double-wrapped in <b>', () => {
  const out = M.renderMdTables('| Name | Role |\n|---|---|\n| <b>Ada</b> | eng |');
  ok(!out.includes('<b><b>'), `nested bold would be rejected: ${out}`);
});

t('a pipe line with no separator row is left as prose', () => {
  const src = '| not | a table |\nplain line';
  eq(M.renderMdTables(src), src);
});

t('table rendering survives the full markdown pipeline', () => {
  const html = M.mdToTelegramHtml('| Name | Role |\n|---|---|\n| Ada | eng |');
  ok(!html.includes('---'), `separator reached the phone: ${html}`);
  for (const tag of html.matchAll(/<\/?([a-z-]+)[\s>]/g)) {
    ok(TG_TAGS.has(tag[1]), `unsupported tag <${tag[1]}>`);
  }
});

// ---------- chunks: never split through a tag ----------
const tagBalanced = (s) => !/<[a-z-]*$/i.test(s); // no dangling '<...' at the end

t('chunks never end mid-tag', () => {
  const body = Array.from({ length: 400 }, (_, i) => `<b>line ${i}</b> some filler text here`).join('\n');
  for (const c of M.chunks(body, 4000)) ok(tagBalanced(c), `chunk ends mid-tag: ${JSON.stringify(c.slice(-40))}`);
});

t('chunks respect the size limit', () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  for (const c of M.chunks(body, 4000)) ok(c.length <= 4000, `chunk of ${c.length} exceeds limit`);
});

t('chunks lose no content', () => {
  const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const rejoined = M.chunks(body, 500).join('\n');
  eq(rejoined.replace(/\s+/g, ' ').trim(), body.replace(/\s+/g, ' ').trim());
});

t('an unbroken run longer than the limit still hard-cuts', () => {
  const parts = M.chunks('z'.repeat(9000), 4000);
  ok(parts.length >= 3, `expected >=3 chunks, got ${parts.length}`);
  for (const c of parts) ok(c.length <= 4000);
});

t('short text stays a single chunk', () => {
  eq(M.chunks('hello', 4000).length, 1);
});

t('empty text yields one empty chunk (never zero)', () => {
  eq(M.chunks('', 4000).length, 1);
});

t('the size limit is the callers, not a module constant', () => {
  // The daemon owns Telegram's ceiling; passing a different one must be honoured,
  // or a caller with a smaller budget (rich blocks, a caption) silently overflows.
  for (const c of M.chunks('word '.repeat(500), 120)) ok(c.length <= 120, `chunk of ${c.length} ignored the limit`);
  eq(M.chunks('a'.repeat(10), 5).every((c) => c.length <= 5), true);
});

// ---------- isTableSep: the one definition both renderers share ----------
// Regression: every pipe in TABLE_SEP is optional, so the regex alone matches a
// bare `---`. rich-format.mjs used to test the raw regex and therefore routed
// "| a | b |" + "---" to the rich path, while renderMdTables (which also required
// a literal pipe) declined to draw it — a rich failure then dropped the table AND
// the inline bold/code the rich path had already traded away.
t('isTableSep accepts a piped separator', () => ok(isTableSep('|---|---|'), 'piped separator'));
t('isTableSep accepts alignment colons', () => ok(isTableSep('|:--|--:|'), 'aligned separator'));
t('isTableSep rejects a bare thematic break', () => ok(!isTableSep('---'), 'bare --- is not a separator'));
t('isTableSep rejects prose containing a pipe', () => ok(!isTableSep('pick a | b'), 'prose'));
t('isTableSep is safe on undefined (end of input)', () => ok(!isTableSep(undefined), 'undefined'));

t('a bare --- after a table row is not a table', () => {
  const src = '| a | b |\n---\n| 1 | 2 |';
  eq(renderMdTables(src), src, 'left untouched');
});

// ---------- code blocks: <pre> is the copy affordance ----------
// The clients make a <pre> block copyable at ANY length, which is why the block
// matters more than the 256-char button below.
t('codeHtml sends every block with the plain language', () => {
  eq(codeHtml('npm ci', 'bash'), '<pre><code class="language-text">npm ci</code></pre>');
  eq(codeHtml('npm ci', ''), '<pre><code class="language-text">npm ci</code></pre>');
});

t('codeHtml escapes the body, and an author language cannot reach the tag', () => {
  eq(codeHtml('a && b < c', ''), '<pre><code class="language-text">a &amp;&amp; b &lt; c</code></pre>');
  eq(codeHtml('x', 'a<b"'), '<pre><code class="language-text">x</code></pre>');
});

t('mdToTelegramHtml still renders a fence as pre', () => {
  eq(mdToTelegramHtml('```bash\nnpm ci\n```'), '<pre><code class="language-text">npm ci</code></pre>');
});

// A fence longer than one message used to be hard-cut, leaving chunk N with an
// unclosed <pre> and chunk N+1 with a stray closer — Telegram rejects both and
// sendResult degrades them to plain text, so the LONGEST snippets were exactly
// the ones that arrived with no code block at all.
t('a fence bigger than a message splits into whole, closed pre blocks', () => {
  const code = Array.from({ length: 400 }, (_, i) => `line ${i}: const x${i} = ${i};`).join('\n');
  const html = mdToTelegramHtml(`Before.\n\n\`\`\`js\n${code}\n\`\`\`\n\nAfter.`);
  const parts = chunks(html, 4096, { closePre: true });
  ok(parts.length > 1, 'fixture must actually split');
  for (const p of parts) {
    ok(p.length <= 4096, `chunk over the limit: ${p.length}`);
    eq((p.match(/<pre>/g) || []).length, (p.match(/<\/pre>/g) || []).length, 'unbalanced <pre>');
    eq((p.match(/<code[^>]*>/g) || []).length, (p.match(/<\/code>/g) || []).length, 'unbalanced <code>');
  }
  // Every source line still arrives, and each reopened block is a plain block.
  const body = parts.join('').replace(/<\/?(?:pre|code)[^>]*>/g, '');
  ok(body.includes('line 0:') && body.includes('line 399:'), 'code content survived');
  eq(parts.filter((p) => p.includes('class="language-text"')).length, parts.filter((p) => p.includes('<pre>')).length);
});

// The size limit is Telegram's, so it outranks keeping the block open: when the
// tags cannot fit the budget, chunks() degrades instead of overshooting.
t('closePre never emits a chunk over the limit, even at absurd sizes', () => {
  const html = codeHtml('a\n'.repeat(200), 'typescript');
  for (const size of [20, 40, 64, 100, 500]) {
    for (const p of chunks(html, size, { closePre: true })) {
      ok(p.length <= size, `size ${size}: emitted a ${p.length}-char chunk`);
    }
  }
});

t('closePre is off by default — raw-markdown callers are untouched', () => {
  const html = `<pre>${'x'.repeat(200)}</pre>`;
  eq(chunks(html, 100).join('').length, html.length, 'default path adds nothing');
});

// ---------- copy button (Bot API 8.0 copy_text, 1-256 chars) ----------
t('one short fence gets a copy button carrying the exact code', () => {
  const got = copyButtonFor('Run this:\n\n```bash\nnpm ci && npm test\n```\n');
  eq(got.code, 'npm ci && npm test');
  eq(got.markup, { inline_keyboard: [[{ text: 'Copy', copy_text: { text: 'npm ci && npm test' } }]] });
});

t('a fence over 256 chars gets no button — never truncated to fit', () => {
  eq(copyButtonFor('```\n' + 'x'.repeat(COPY_TEXT_LIMIT + 1) + '\n```'), null);
  ok(copyButtonFor('```\n' + 'x'.repeat(COPY_TEXT_LIMIT) + '\n```') !== null, 'exactly at the limit still qualifies');
});

t('two fences get no button — one button cannot say which it copies', () => {
  eq(copyButtonFor('```\na\n```\n\ntext\n\n```\nb\n```'), null);
});

t('no fence, or an empty one, gets no button', () => {
  eq(copyButtonFor('just prose'), null);
  eq(copyButtonFor('```\n\n```'), null);
});

// ---------- copyable code: one unit per span, byte for byte ----------
// The owner copies commands out of these messages with a tap, so what matters
// is the text Telegram holds in each <pre> and <code>, not how the HTML reads.
// Every test below compares that text with the source, whitespace included.
const unesc = (s) => s.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[e]);
const pres = (html) => [...html.matchAll(/<pre><code class="language-[^"]*">([\s\S]*?)<\/code><\/pre>/g)].map((m) => unesc(m[1]));
const codes = (html) => [...html.replace(/<pre>[\s\S]*?<\/pre>/g, '').matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => unesc(m[1]));
// Does every tag close, in order? What Telegram requires of each message.
const parses = (html) => {
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^<>]*>/g)) {
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
};
const tagCount = (html) => (html.match(/<[a-zA-Z][^<>]*>/g) || []).length;
// The command that reached the owner's terminal in pieces on 2026-09-26.
const LONG_CMD =
  'cd ~/dev/my-mobile/apps/dashboard && npm install --save-exact @capacitor/core@8.3.0 @capacitor/ios@8.3.0 @capacitor/android@8.3.0 @capacitor/app@8.1.0 @capacitor/splash-screen@8.0.1 @capacitor/status-bar@8.0.2 @capacitor/keyboard@8.0.3 @capacitor/haptics@8.0.2 @capacitor/push-notifications@8.0.3 @capgo/capacitor-updater@8.45.9 && npm install --save-exact -D @capacitor/cli@8.3.0';

t('every block goes out with the plain language, whatever the author wrote', () => {
  // Telegram stores an unlabelled shell block as language "shell" and the apps
  // highlight a labelled block; on the iPhone a tap on a highlighted block
  // copies one coloured run of it. No block may carry a language that is drawn.
  for (const md of ['```\nnpm ci\n```', '```bash\nnpm ci\n```', '```python\nx = 1\n```', `Run \`${LONG_CMD}\` now`]) {
    const html = mdToTelegramHtml(md);
    eq((html.match(/class="language-[^"]*"/g) || []).join(), `class="language-${PLAIN_LANG}"`, md.slice(0, 20));
    ok(!/<pre>(?!<code class="language-)/.test(html), 'a bare <pre> lets Telegram pick the language itself');
  }
});

t('a long single line command is one block, one line, every character', () => {
  const html = mdToTelegramHtml(`**1. One command at your Mac.** Same versions as before:\n\`\`\`\n${LONG_CMD}\n\`\`\`\n\n**2. Next.**`);
  eq(pres(html), [LONG_CMD]);
  ok(!pres(html)[0].includes('\n'), 'a line break was added to a single line command');
});

t('a multi line command keeps every space, tab, indent and blank line', () => {
  const code = "cd ~/dev/app\ncat <<'EOF' > notes.txt\n  two spaces\n\tone tab\n\ntrailing spaces  \nEOF\nnpm test \\\n  --reporter dot";
  eq(pres(mdToTelegramHtml(`Run:\n\n\`\`\`\n${code}\n\`\`\`\n`)), [code]);
});

t('a tab cannot cross Telegram, so the block says so instead of losing it silently', () => {
  const html = mdToTelegramHtml('```\nbuild:\n\techo hi\n```\n\nNext.');
  eq(pres(html), ['build:\n\techo hi'], 'the bridge itself must not change the tab');
  ok(html.includes(`</pre>\n<i>${TAB_NOTE}</i>`), 'no note under a block that has a tab');
  ok(!mdToTelegramHtml('```\nno tab here\n```').includes('<i>'), 'a note on a block with no tab');
});

t('nothing invisible or typographic is ever added to code', () => {
  const cmd = `git commit -m "it's --done" -- 'a b' && echo "x - y"`;
  for (const got of [...pres(mdToTelegramHtml(`\`\`\`\n${cmd}\n\`\`\``)), ...codes(mdToTelegramHtml(`(\`${cmd}\`)`))]) {
    eq(got, cmd);
    ok(!/[\u200B\u200C\u200D\u2060\u00A0\uFEFF\u00AD\u2018\u2019\u201C\u201D\u2013\u2014]/.test(got), 'an invisible or typographic character');
  }
});

t('a fence nested in a list item loses the list indent, and only that', () => {
  // The old regex kept the three spaces in front of every line, EOF included,
  // and a heredoc whose terminator is indented never ends.
  const md = "1. Write the file:\n   ```bash\n   cat <<'EOF' > f.txt\n     two spaces kept\n   EOF\n   ```\n2. Done.";
  eq(pres(mdToTelegramHtml(md)), ["cat <<'EOF' > f.txt\n  two spaces kept\nEOF"]);
});

t('three backticks inside a sentence are a span, not a fence that eats the first word', () => {
  const html = mdToTelegramHtml('Then ```git status``` and wait.');
  eq(pres(html), []);
  eq(codes(html), ['git status']);
});

t('a four backtick fence can hold a three backtick fence', () => {
  eq(pres(mdToTelegramHtml('````\n```\nnpm ci\n```\n````')), ['```\nnpm ci\n```']);
});

t('a span delimited by two backticks keeps the backtick inside it', () => {
  // Real reply, 2026-09-21: arrived as the fragment " resets 6:50pm ".
  eq(codes(mdToTelegramHtml('The line is `` `5h 32%` resets 6:50pm `` today.')), ['`5h 32%` resets 6:50pm']);
});

t('blank lines after the last line of code are not copied, blank lines inside are', () => {
  eq(pres(mdToTelegramHtml('```\na\n\nb\n\n\n```')), ['a\n\nb']);
  eq(copyButtonFor('```\na\n\nb\n\n```').code, 'a\n\nb');
});

t('a long command in inline backticks becomes its own block', () => {
  const cmd = 'nohup ./safe-restart.sh >/dev/null 2>&1 &';
  const html = mdToTelegramHtml(`Restart it with \`${cmd}\`.\n\nThen wait.`);
  eq(pres(html), [cmd]);
  eq(codes(html), []);
  eq(html, `Restart it with\n<pre><code class="language-${PLAIN_LANG}">${escHtml(cmd)}</code></pre>\n\nThen wait.`);
});

t('a command in a list item becomes its own block; a name, a flag and a path stay inline', () => {
  const html = mdToTelegramHtml('- Start: `npm run dev`\n- File: `bridge.mjs`, flag `--allow-bg`, path `~/dev/my-repo`');
  eq(pres(html), ['npm run dev']);
  eq(codes(html), ['bridge.mjs', '--allow-bg', '~/dev/my-repo']);
  ok(!/^\s+<pre>/m.test(html), 'the block is indented');
});

t('a short command in a sentence, and one inside bold, a heading, a quote or a table, stays inline', () => {
  for (const md of ['Run `npm test` first.', '- **Use `npm run dev` here**', '## Then `git push origin main`', '> quote `cd ~/dev && ls`', '| a | b |\n|---|---|\n| x | `cd ~/dev && ls -la` |']) {
    eq(pres(mdToTelegramHtml(md)), [], md);
    eq(codes(mdToTelegramHtml(md)).length, 1, md);
  }
});

t('isCommand: what gets pasted into a terminal, and what is only named', () => {
  for (const c of ['npm test', 'cd ~/dev && ls', './safe-restart.sh --allow-bg', 'FOO=1 node x.mjs', 'ps aux | grep node']) ok(isCommand(c), c);
  for (const c of ['bridge.mjs', '--allow-bg', 'sendResult', '/steer latest stop', 'For HVAC shops running 3 to 8 trucks.']) ok(!isCommand(c), c);
});

t('a span never runs from one list item into the next', () => {
  eq(codes(mdToTelegramHtml('- a stray ` here\n- then `real` code')), ['real']);
});

t('copyButtons: one button per block that fits, each carrying the exact code', () => {
  const md = `First:\n\n\`\`\`\ncd ~/dev/app\n\`\`\`\n\nThen:\n\n\`\`\`\n${LONG_CMD}\n\`\`\`\n\nLast: \`npm run build -- --mode production --watch\``;
  const got = copyButtons(md);
  eq(got.map((b) => b.code), ['cd ~/dev/app', 'npm run build -- --mode production --watch']);
  eq(got.map((b) => b.button.copy_text.text), got.map((b) => b.code));
  eq(got[0].button.text, 'Copy: cd ~/dev/app');
  ok(got.every((b) => b.button.text.length <= 32), 'a label too long for a button');
  eq(codeBlocks(md), ['cd ~/dev/app', LONG_CMD, 'npm run build -- --mode production --watch']);
  // One block alone keeps the plain label.
  eq(copyButtons('```\nnpm ci\n```')[0].button.text, 'Copy');
});

// ---------- chunks(html): what a split may never do ----------
t('a block that would straddle the limit moves whole into the next message', () => {
  const code = Array.from({ length: 12 }, (_, i) => `step ${i}: do the thing --flag ${i}`).join('\n');
  const html = mdToTelegramHtml(`${'word '.repeat(760)}\n\n\`\`\`\n${code}\n\`\`\`\n\nAfter.`);
  const parts = chunks(html, 4000, { closePre: true });
  eq(parts.length, 2);
  eq(parts.flatMap(pres), [code], 'the block was cut in two');
  ok(parts.every((p) => p.length <= 4000 && parses(p)), 'a part is over the limit or does not parse');
});

t('a block longer than a message is cut at line breaks only, and each piece says which part it is', () => {
  const code = Array.from({ length: 400 }, (_, i) => `line ${i}: const x${i} = ${i};`).join('\n');
  const parts = chunks(mdToTelegramHtml(`Before.\n\n\`\`\`js\n${code}\n\`\`\`\n\nAfter.`), 4000, { closePre: true });
  const pieces = parts.flatMap(pres);
  ok(pieces.length > 1, 'fixture must actually split');
  eq(pieces.join('\n'), code, 'the pieces do not add up to the code');
  ok(parts.every((p) => p.length <= 4000 && parses(p)), 'a part is over the limit or does not parse');
  const withCode = parts.filter((p) => p.includes('<pre>'));
  withCode.forEach((p, i) => ok(p.includes(`part ${i + 1} of ${withCode.length}\n<pre>`), `piece ${i + 1} is not labelled`));
  ok(parts[0].startsWith('Before.'), 'the lead-in stays in front of part 1');
});

t('a quote cut by the limit is closed and reopened, so every message parses', () => {
  // Real reply, 2026-09-14: the cut left <blockquote> open in one message and
  // </blockquote> alone in the next, Telegram refused both, and 13 code spans
  // arrived as plain text.
  const quote = Array.from({ length: 90 }, (_, i) => `> line ${i} of a long quoted block with \`code${i}\` in it`).join('\n');
  const parts = chunks(mdToTelegramHtml(`Intro.\n\n${quote}\n\nOutro \`after\`.`), 4000, { closePre: true });
  ok(parts.length > 1, 'fixture must actually split');
  ok(parts.every((p) => p.length <= 4000 && parses(p)), 'a part does not parse');
  eq(parts.flatMap(codes).length, 91);
});

t('no message carries more entities than Telegram keeps', () => {
  // Measured live: 126 entities sent, 100 stored, the last 22 code spans plain.
  const md = Array.from({ length: 130 }, (_, i) => `\`c${i}\``).join(' ');
  const parts = chunks(mdToTelegramHtml(md), 4000, { closePre: true });
  ok(parts.length === 2, `expected 2 messages, got ${parts.length}`);
  ok(parts.every((p) => tagCount(p) <= ENTITY_BUDGET && parses(p)), 'a message is over the entity cap');
  eq(parts.flatMap(codes).length, 130);
  // A code span inside bold counts twice: Telegram cuts the bold run around it.
  const nested = chunks(mdToTelegramHtml(Array.from({ length: 60 }, (_, i) => `**b \`c${i}\` b**`).join('\n')), 4000, { closePre: true });
  ok(nested.length >= 2 && nested.flatMap(codes).length === 60, 'bold-wrapped code was not budgeted');
});

t('an inline code span is never cut, even when nothing else can be', () => {
  const md = `${'x'.repeat(3990)} \`npm run the-long-one --now\` tail`;
  const parts = chunks(mdToTelegramHtml(md), 4000, { closePre: true });
  eq(parts.flatMap(codes), ['npm run the-long-one --now']);
  ok(parts.every((p) => p.length <= 4000 && parses(p)), 'a part does not parse');
});

t('a reply that fits is one message, untouched', () => {
  const html = mdToTelegramHtml('**Hi** `a`\n\n```\nb\n```\n\n> q');
  eq(chunks(html, 4000, { closePre: true }), [html]);
});

t('the plain text fallback gives the code back unchanged', () => {
  for (const cmd of ['echo "&lt;" > a.html', 'a && b < c > d', 'printf "&amp;amp;"']) eq(stripHtml(mdToTelegramHtml(`(\`${cmd}\`)`)), `(${cmd})`);
});

// ---------- report ----------
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log('✅ md-format render tests pass');
