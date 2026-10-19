#!/usr/bin/env node
// Unit tests for the rich message flattener: a Telegram `rich_message` tree
// read back as the words they typed.
//
// The starred ones are the incident and its two neighbours. THE INCIDENT: a
// long numbered answer from the phone arrived as paragraph, list, paragraph
// with no `text` field, and the bridge answered "Send text, photos, videos,
// voice notes or files." four times (2026-10-12). NEVER THROW and NEVER DROP
// IN SILENCE are the neighbours: Telegram adds block types, and the day it adds
// one this module must still hand over the words around it and name the block
// it could not read.
//
// Every fixture here is synthetic. Field names are the Bot API's own.
//
//   node rich-message.test.mjs

import { flattenRichMessage, flattenRichText, readRichMessage, richMediaNote, richPromptText, RICH_MAX_DEPTH } from './rich-message.mjs';

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const p = (text) => ({ type: 'paragraph', text });
const rm = (...blocks) => ({ blocks });
const flat = (...blocks) => flattenRichMessage(rm(...blocks));
/** A list item the way Telegram sends an ordered one. */
const li = (n, ...blocks) => ({ label: `${n}.`, type: '1', value: n, blocks });

// ---------------------------------------------------------------------------
console.log('\n1. the incident: paragraph, numbered list, paragraph');
// ---------------------------------------------------------------------------

const INCIDENT = rm(
  p('Answers for the bot, in order'),
  p(''),
  {
    type: 'list',
    items: [
      li(1, p(['The site is ', { type: 'url', text: 'example.com/start', url: 'example.com/start' }, ' .'])),
      li(2, p('Yes, weekdays only')),
      li(3, p('Call first.'), p('Then text if nobody answers.')),
    ],
  },
  p(['{ "site": "', { type: 'url', text: 'example.com', url: 'http://example.com/' }, '", "hours": "9 to 5" }']),
);

t('★ it reads as the text they typed: labels kept, one item a line, blank line kept', () => {
  eq(
    flattenRichMessage(INCIDENT),
    [
      'Answers for the bot, in order',
      '',
      '1. The site is example.com/start .',
      '2. Yes, weekdays only',
      '3. Call first.',
      '   Then text if nobody answers.',
      '{ "site": "example.com", "hours": "9 to 5" }',
    ].join('\n'),
  );
});

t('a second paragraph inside an item is indented under its label, not promoted to an item', () => {
  const lines = flattenRichMessage(INCIDENT).split('\n');
  eq(lines[5], '   Then text if nobody answers.');
});

t('readRichMessage counts the blocks, nested ones included, and finds no media', () => {
  const r = readRichMessage(INCIDENT);
  eq(r.blocks, 8, 'three top level paragraphs, the list, four paragraphs inside items');
  eq(r.media.length, 0);
  eq(r.text, flattenRichMessage(INCIDENT));
});

t('a very long message is not cut', () => {
  const items = Array.from({ length: 200 }, (_, i) => li(i + 1, p(`answer ${i + 1} ${'word '.repeat(20)}`.trim())));
  const out = flat(p('Start'), { type: 'list', items }, p('End'));
  ok(out.length > 20000, `only ${out.length} characters survived`);
  ok(out.startsWith('Start\n1. answer 1 word'), out.slice(0, 40));
  ok(out.endsWith('\nEnd'), out.slice(-40));
  eq(out.split('\n').length, 202);
  ok(out.includes('\n200. answer 200 word'), 'the last item lost its label');
});

// ---------------------------------------------------------------------------
console.log('\n2. RichText: a string, an array, a typed object');
// ---------------------------------------------------------------------------

t('a string is itself', () => {
  eq(flattenRichText('plain words'), 'plain words');
});

t('an array is its parts, joined with nothing added', () => {
  eq(flattenRichText(['one ', 'two', ' three']), 'one two three');
});

t('a typed object is its words, with no markdown markers', () => {
  eq(flattenRichText({ type: 'bold', text: 'loud' }), 'loud');
  eq(flattenRichText({ type: 'italic', text: 'soft' }), 'soft');
  const out = flattenRichText(['a ', { type: 'bold', text: ['b ', { type: 'italic', text: 'c' }] }, ' d']);
  eq(out, 'a b c d');
  ok(!/[*_~`]/.test(out), out);
});

t('every plain styled kind keeps its words', () => {
  for (const type of ['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'subscript', 'superscript', 'marked', 'code', 'date_time', 'text_mention', 'bank_card_number', 'mention', 'hashtag', 'cashtag', 'bot_command', 'anchor_link', 'reference', 'reference_link']) {
    eq(flattenRichText({ type, text: `the ${type} words`, unix_time: 1, user: { id: 5 }, name: 'n' }), `the ${type} words`, type);
  }
});

t('★ a link whose target is not in its words keeps the target in round brackets', () => {
  eq(flattenRichText({ type: 'url', text: 'the pricing page', url: 'https://example.com/pricing' }), 'the pricing page (https://example.com/pricing)');
  eq(flattenRichText({ type: 'email_address', text: 'write to us', email_address: 'hi@example.com' }), 'write to us (hi@example.com)');
  eq(flattenRichText({ type: 'phone_number', text: 'the front desk', phone_number: '+15550100' }), 'the front desk (+15550100)');
});

t('a link whose target is already its words is not written twice', () => {
  eq(flattenRichText({ type: 'url', text: 'https://example.com/a', url: 'https://example.com/a' }), 'https://example.com/a');
  eq(flattenRichText({ type: 'url', text: 'example.com/a', url: 'https://example.com/a/' }), 'example.com/a', 'scheme and trailing slash are what Telegram adds');
  eq(flattenRichText({ type: 'url', text: 'WWW.Example.com', url: 'http://example.com' }), 'WWW.Example.com');
  eq(flattenRichText({ type: 'email_address', text: 'hi@example.com', email_address: 'hi@example.com' }), 'hi@example.com');
  eq(flattenRichText({ type: 'url', text: 'see https://example.com/a.', url: 'https://example.com/a' }), 'see https://example.com/a.', 'a whole word of the text');
});

t('a target is "already shown" only as a whole word, never as a substring', () => {
  eq(flattenRichText({ type: 'url', text: 'data', url: 'https://a' }), 'data (https://a)');
});

t('a link with no words is its target, and a link with no target is its words', () => {
  eq(flattenRichText({ type: 'url', text: '', url: 'https://example.com' }), 'https://example.com');
  eq(flattenRichText({ type: 'url', text: 'words' }), 'words');
});

t('a custom emoji is its alternative text, a formula is its source', () => {
  eq(flattenRichText(['ok ', { type: 'custom_emoji', custom_emoji_id: '5368324170671202286', alternative_text: '👍' }]), 'ok 👍');
  eq(flattenRichText({ type: 'mathematical_expression', expression: 'x^2 + y^2' }), 'x^2 + y^2');
});

t('an inline button is named with its text and its link, an inline anchor is skipped', () => {
  eq(flattenRichText({ type: 'button', button: { text: 'Open', url: 'https://example.com' } }), '[button: Open (https://example.com)]');
  eq(flattenRichText({ type: 'button', button: { text: ['Pay ', { type: 'custom_emoji', alternative_text: '💳' }], callback_data: 'pay' } }), '[button: Pay 💳]');
  eq(flattenRichText({ type: 'button' }), '[button]');
  eq(flattenRichText(['before', { type: 'anchor', name: 'top' }, 'after']), 'beforeafter');
});

t('★ an unknown inline type keeps the text it carries, and is named when it carries none', () => {
  eq(flattenRichText({ type: 'sparkle_text', text: ['still ', { type: 'bold', text: 'here' }] }), 'still here');
  eq(flattenRichText(['a ', { type: 'hologram' }, ' b']), 'a [hologram] b');
  eq(flattenRichText({ type: 'voice_chip' }), '[voice chip]');
});

t('garbage in a RichText position never throws', () => {
  for (const bad of [null, undefined, 0, 7, true, false, {}, [], [null, undefined, {}], { type: 7 }, { text: null }, { type: 'bold' }, { type: 'url', url: 9 }, Symbol.iterator.toString]) {
    eq(typeof flattenRichText(bad), 'string', String(JSON.stringify(bad)));
  }
  eq(flattenRichText(7), '7');
  eq(flattenRichText({ text: 'typeless' }), 'typeless');
  eq(flattenRichText({}), '');
});

// ---------------------------------------------------------------------------
console.log('\n3. every block kind');
// ---------------------------------------------------------------------------

t('paragraph', () => {
  eq(flat(p('one'), p('two')), 'one\ntwo');
});

t('section heading: its words on a line of their own, set off by a blank line', () => {
  eq(flat(p('intro'), { type: 'heading', size: 2, text: 'The plan' }, p('body')), 'intro\n\nThe plan\nbody');
  eq(flat({ type: 'heading', size: 1, text: 'First thing' }, p('body')), 'First thing\nbody', 'no blank line above the very first line');
  ok(!flat({ type: 'heading', size: 1, text: 'x' }).includes('#'), 'no markdown marker');
});

t('preformatted: fenced, with its language, and its spacing intact', () => {
  eq(flat({ type: 'pre', language: 'json', text: '{\n  "a": 1,\n\n\n  "b": 2\n}' }), '```json\n{\n  "a": 1,\n\n\n  "b": 2\n}\n```');
  eq(flat({ type: 'pre', text: 'plain' }), '```\nplain\n```');
  ok(flat({ type: 'pre', text: 'has ``` inside' }).startsWith('````\n'), 'a fence inside the code needs a longer fence around it');
});

t('footer', () => {
  eq(flat(p('body'), { type: 'footer', text: 'sent from the road' }), 'body\nsent from the road');
});

t('divider', () => {
  eq(flat(p('above'), { type: 'divider' }, p('below')), 'above\n---\nbelow');
});

t('mathematical expression block', () => {
  eq(flat({ type: 'mathematical_expression', expression: 'E = mc^2' }), 'E = mc^2');
});

t('anchor block is skipped, and takes no line', () => {
  eq(flat(p('above'), { type: 'anchor', name: 'section-2' }, p('below')), 'above\nbelow');
});

t('list: every item keeps its label', () => {
  const out = flat({ type: 'list', items: [{ label: '•', blocks: [p('milk')] }, { label: '•', blocks: [p('eggs')] }] });
  eq(out, '• milk\n• eggs');
});

t('list: a missing label falls back to the value, then to a plain mark', () => {
  eq(flat({ type: 'list', items: [{ value: 4, type: '1', blocks: [p('four')] }] }), '4. four');
  eq(flat({ type: 'list', items: [{ blocks: [p('bare')] }] }), '- bare');
  eq(flat({ type: 'list', items: [{ label: '7.', blocks: [] }] }), '7.', 'an item with no content still shows its label');
});

t('list: checkboxes say whether they are ticked', () => {
  const out = flat({
    type: 'list',
    items: [
      { label: '', has_checkbox: true, is_checked: true, blocks: [p('done')] },
      { label: '', has_checkbox: true, blocks: [p('not yet')] },
    ],
  });
  eq(out, '[x] done\n[ ] not yet');
});

t('★ nested lists: each level is indented under its parent label', () => {
  const out = flat({
    type: 'list',
    items: [
      li(1, p('Parent one'), {
        type: 'list',
        items: [
          { label: 'a.', type: 'a', value: 1, blocks: [p('child a'), { type: 'list', items: [{ label: 'i.', type: 'i', value: 1, blocks: [p('grandchild')] }] }] },
          { label: 'b.', type: 'a', value: 2, blocks: [p('child b')] },
        ],
      }),
      li(2, p('Parent two')),
      li(10, p('Parent ten'), p('second line of ten')),
    ],
  });
  eq(
    out,
    ['1. Parent one', '   a. child a', '      i. grandchild', '   b. child b', '2. Parent two', '10. Parent ten', '    second line of ten'].join('\n'),
  );
});

t('block quotation: its blocks, each line marked, with the credit', () => {
  const out = flat(p('They said'), { type: 'blockquote', blocks: [p('first line'), p('second line')], credit: 'the client' }, p('and I agree'));
  eq(out, 'They said\n> first line\n> second line\n> (the client)\nand I agree');
});

t('expandable block quotation: text, not blocks', () => {
  eq(flat({ type: 'expandable_blockquote', text: ['a long ', { type: 'bold', text: 'quote' }, '\nover two lines'] }), '> a long quote\n> over two lines');
});

t('pull quotation: text and credit', () => {
  eq(flat({ type: 'pullquote', text: 'Ship it.', credit: ['Zed', ' K'] }), '> Ship it.\n> (Zed K)');
});

t('details: the summary, then its blocks indented', () => {
  const out = flat({ type: 'details', summary: 'The fine print', is_open: true, blocks: [p('clause one'), { type: 'list', items: [li(1, p('sub clause'))] }] });
  eq(out, 'The fine print\n  clause one\n  1. sub clause');
});

t('table: one line per row, cells joined with a visible separator', () => {
  const cell = (text, extra = {}) => ({ text, align: 'left', valign: 'top', ...extra });
  const out = flat({
    type: 'table',
    is_bordered: true,
    caption: 'Plans',
    cells: [
      [cell('Plan', { is_header: true }), cell('Price', { is_header: true }), cell('Seats', { is_header: true })],
      [cell('Basic'), cell(['$', { type: 'bold', text: '10' }]), cell('1')],
      [cell('Team'), { align: 'left', valign: 'top' }, cell('5')],
    ],
  });
  eq(out, 'Plans\nPlan | Price | Seats\nBasic | $10 | 1\nTeam |  | 5', 'an invisible cell keeps its column');
});

t('a cell that spans lines stays on its row', () => {
  eq(flat({ type: 'table', cells: [[{ text: 'two\nlines' }, { text: 'b' }]] }), 'two lines | b');
});

// ---------------------------------------------------------------------------
console.log('\n4. media inside a rich message: a placeholder, never a silent gap');
// ---------------------------------------------------------------------------

const cap = (text, credit) => ({ text, ...(credit ? { credit } : {}) });

t('photo, with and without a caption', () => {
  eq(flat({ type: 'photo', photo: [{ file_id: 'A', width: 90, height: 90 }] }), '[photo]');
  eq(flat({ type: 'photo', photo: [{ file_id: 'A' }], caption: cap('the leak under the sink') }), '[photo] the leak under the sink');
  eq(flat({ type: 'photo', photo: [], caption: cap(['the ', { type: 'bold', text: 'roof' }], 'by Sam') }), '[photo] the roof (by Sam)');
});

t('video, animation, audio, document and voice note', () => {
  eq(flat({ type: 'video', video: { file_id: 'V', file_name: 'walkthrough.mp4' }, caption: cap('the walkthrough') }), '[video: walkthrough.mp4] the walkthrough');
  eq(flat({ type: 'video', video: { file_id: 'V' } }), '[video]');
  eq(flat({ type: 'animation', animation: { file_id: 'G' } }), '[animation]');
  eq(flat({ type: 'audio', audio: { file_id: 'the assistant', file_name: 'call.mp3' } }), '[audio: call.mp3]');
  eq(flat({ type: 'document', document: { file_id: 'D', file_name: 'quote v2.pdf' }, caption: cap('the quote') }), '[file: quote v2.pdf] the quote');
  eq(flat({ type: 'voice_note', voice_note: { file_id: 'N', duration: 4 } }), '[voice note]');
});

t('collage and slideshow: named, with what they hold indented under them', () => {
  const out = flat({ type: 'collage', caption: cap('before and after'), blocks: [{ type: 'photo', photo: [] }, { type: 'photo', photo: [], caption: cap('after') }] });
  eq(out, '[collage] before and after\n  [photo]\n  [photo] after');
  eq(flat({ type: 'slideshow', blocks: [{ type: 'video', video: {} }] }), '[slideshow]\n  [video]');
});

t('map: where it points, and its caption', () => {
  eq(flat({ type: 'map', location: { latitude: 25.76, longitude: -80.19 }, zoom: 12, width: 600, height: 300, caption: cap('the job site') }), '[map: 25.76, -80.19] the job site');
  eq(flat({ type: 'map' }), '[map]');
});

t('buttons: one line, each button by its text and its link', () => {
  eq(flat({ type: 'buttons', buttons: [{ text: 'Open', url: 'https://example.com' }, { text: 'Cancel', callback_data: 'x' }] }), '[buttons: Open (https://example.com) | Cancel]');
  eq(flat({ type: 'buttons', buttons: [] }), '[buttons]');
});

t('thinking', () => {
  eq(flat({ type: 'thinking', text: 'Working on it' }), '[thinking] Working on it');
  eq(flat({ type: 'thinking' }), '[thinking]');
});

t('★ the media that was left behind is listed, in order, and words around it survive', () => {
  const r = readRichMessage(
    rm(p('Here is the damage'), { type: 'photo', photo: [] }, { type: 'photo', photo: [] }, { type: 'document', document: { file_name: 'claim.pdf' } }, { type: 'voice_note', voice_note: {} }, p('Call me')),
  );
  eq(r.text, 'Here is the damage\n[photo]\n[photo]\n[file: claim.pdf]\n[voice note]\nCall me');
  eq(r.media.join(','), 'photo,photo,file,voice note');
});

t('the media note says what was not downloaded, and is empty when there was none', () => {
  eq(richMediaNote([]), '');
  eq(richMediaNote(undefined), '');
  const one = richMediaNote(['photo']);
  ok(/held 1 photo, shown above as a placeholder/.test(one), one);
  ok(/did not download/.test(one), one);
  const many = richMediaNote(['photo', 'photo', 'file', 'voice note']);
  ok(/held 2 photos, 1 file and 1 voice note,/.test(many), many);
  ok(!new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`).test(one + many), 'no em or en dash');
});

t('richPromptText: the words, plus the note only when media was left behind', () => {
  eq(richPromptText(rm(p('just words'))), 'just words');
  const withPhoto = richPromptText(rm(p('look'), { type: 'photo', photo: [] }));
  ok(withPhoto.startsWith('look\n[photo]\n\n[This formatted Telegram message also held 1 photo'), withPhoto);
  eq(richPromptText(rm()), '');
  eq(richPromptText(undefined), '');
});

// ---------------------------------------------------------------------------
console.log('\n5. unknown blocks, empty messages, hostile shapes');
// ---------------------------------------------------------------------------

t('★ an unknown block type is named, never dropped, and the words around it survive', () => {
  eq(flat(p('before'), { type: 'hologram' }, p('after')), 'before\n[hologram block]\nafter');
  eq(flat({ type: 'live_poll_card' }), '[live poll card block]');
  eq(flat({ no: 'type at all' }), '[unknown block]');
});

t('★ an unknown block that carries text or blocks keeps them instead', () => {
  eq(flat({ type: 'callout', text: ['Heads up: ', { type: 'bold', text: 'read this' }] }), 'Heads up: read this');
  eq(flat({ type: 'columns', blocks: [p('left'), p('right')] }), 'left\nright');
  eq(flat({ type: 'callout', text: 'title', blocks: [p('body')] }), 'title\nbody');
});

t('★ an empty message flattens to an empty string', () => {
  for (const empty of [undefined, null, {}, { blocks: [] }, { blocks: null }, { blocks: 'nope' }, rm(p('')), rm(p('   '), p('\n')), rm({ type: 'anchor', name: 'a' }), rm({ type: 'list', items: [] }), rm({ type: 'table', cells: [] }), 'a string', 7, []]) {
    eq(flattenRichMessage(empty), '', JSON.stringify(empty));
  }
});

t('blank lines they typed stay one blank line, and the ends are trimmed', () => {
  eq(flat(p(''), p(''), p('first'), p(''), p(''), p(''), p('second'), p(''), p('')), 'first\n\nsecond');
});

t('blocks that are not objects never throw: a string is kept, the rest is skipped', () => {
  eq(flat('a bare string', null, undefined, 5, true, [], p('real')), 'a bare string\nreal');
});

t('fields of the wrong type never throw', () => {
  const hostile = rm(
    { type: 'list', items: 'not an array' },
    { type: 'list', items: [null, 4, 'a string item', { label: 9, blocks: 'no' }] },
    { type: 'table', cells: 'no' },
    { type: 'table', cells: [null, 'row', [null, 3, { text: { type: 'bold' } }]] },
    { type: 'blockquote', blocks: {} },
    { type: 'details', summary: null, blocks: 3 },
    { type: 'pre', text: null, language: {} },
    { type: 'buttons', buttons: [null, 3, {}] },
    { type: 'map', location: 'here' },
    { type: 'photo', caption: 'a bare caption' },
    { type: 'collage', blocks: [null], caption: [] },
    { type: 7 },
    { type: 'constructor' },
    { type: '__proto__' },
    { type: 'toString', text: 'kept' },
  );
  const out = flattenRichMessage(hostile);
  eq(typeof out, 'string');
  ok(out.includes('- a string item'), out);
  ok(out.includes('[photo] a bare caption'), out);
  ok(out.includes('[constructor block]') && out.includes('[proto block]'), out);
  ok(out.includes('kept'), out);
  eq(readRichMessage(hostile).media.join(','), 'map,photo,collage', 'a type that happens to be an Object method name is not media');
});

t('nesting past the limit is named, and a tree far deeper than Telegram allows does not overflow the stack', () => {
  let deepText = 'core';
  for (let i = 0; i < 5000; i++) deepText = { type: 'bold', text: deepText };
  const a = flattenRichMessage(rm(p(deepText)));
  eq(a, '[nested content]');
  let deepBlock = p('core');
  for (let i = 0; i < 5000; i++) deepBlock = { type: 'blockquote', blocks: [deepBlock] };
  const b = flattenRichMessage(rm(deepBlock));
  ok(b.includes('[nested content]'), b.slice(0, 80));
  // Telegram's own limit (16) is well inside it.
  let legal = 'core';
  for (let i = 0; i < 16; i++) legal = { type: 'bold', text: [legal] };
  eq(flattenRichMessage(rm(p(legal))), 'core');
  ok(RICH_MAX_DEPTH >= 32, 'the guard must sit above 16 levels of blocks holding 16 levels of text');
});

t('a throwing getter in the tree gives an empty reading, not an exception', () => {
  const trap = { blocks: [p('words'), { get type() { throw new Error('boom'); } }] };
  const r = readRichMessage(trap);
  eq(r.text, '');
  eq(r.media.length, 0);
});

t('no markdown emphasis markers are ever added', () => {
  const out = flat(p([{ type: 'bold', text: 'b' }, { type: 'italic', text: 'i' }, { type: 'strikethrough', text: 's' }, { type: 'code', text: 'c' }, { type: 'spoiler', text: 'x' }, { type: 'marked', text: 'm' }]));
  eq(out, 'biscxm');
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all rich-message tests pass');
