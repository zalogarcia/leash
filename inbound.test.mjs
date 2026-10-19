#!/usr/bin/env node
// Unit tests for inbound.mjs: the kind of an inbound message, the one log line
// per message, and the bookkeeping for a kind the bridge cannot read.
//
// The starred ones are the two promises this module makes. NO CONTENT IN THE
// LOG: the line exists so "did it arrive" is one grep, and a line that also
// carried what they wrote would put client text in a log file. ONLY ITS OWN
// FILES: the prune deletes from the same folder their attachments are saved in,
// so it must never name a file it did not write.
//
//   node inbound.test.mjs

import { inboundKind, inboundLogLine, messageKeys, unknownLogLine, unknownKindLabel, unknownFileName, unknownFilesToPrune, isSavedUnknown, UNKNOWN_KEEP } from './inbound.mjs';

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

const AT = Date.parse('2026-10-12T14:22:05.123Z');

// ---------------------------------------------------------------------------
console.log('\n1. the kind');
// ---------------------------------------------------------------------------

t('plain text is text, whatever else the message carries', () => {
  eq(inboundKind({ text: 'hello' }), 'text');
  eq(inboundKind({ text: 'hello', media: { kind: 'photo' }, richText: 'words' }), 'text');
});

t('every kind pickMedia names maps to the name the log uses', () => {
  for (const [from, to] of [['photo', 'photo'], ['file', 'file'], ['video', 'video'], ['video note', 'video note'], ['voice message', 'voice'], ['audio', 'audio']]) {
    eq(inboundKind({ media: { kind: from } }), to, from);
  }
});

t('a media kind this module has not heard of is still a file, never unknown', () => {
  eq(inboundKind({ media: { kind: 'hologram' } }), 'file');
  eq(inboundKind({ media: { kind: 'constructor' } }), 'file');
  eq(inboundKind({ media: {} }), 'file');
});

t('a rich message with words is rich, and a file beats it', () => {
  eq(inboundKind({ richText: 'the flattened words' }), 'rich');
  eq(inboundKind({ media: { kind: 'photo' }, richText: 'a formatted caption' }), 'photo');
});

t('nothing readable is unknown', () => {
  eq(inboundKind({}), 'unknown');
  eq(inboundKind(), 'unknown');
  eq(inboundKind({ text: '', media: null, richText: '' }), 'unknown');
  eq(inboundKind({ text: undefined, richText: undefined }), 'unknown');
  eq(inboundKind({ text: 5, richText: {} }), 'unknown');
});

// ---------------------------------------------------------------------------
console.log('\n2. the one line per message');
// ---------------------------------------------------------------------------

t('★ ISO time, message id, kind, and the character count for the kinds that are words', () => {
  eq(inboundLogLine({ at: AT, messageId: 25294, kind: 'rich', chars: 6057 }), '[2026-10-12T14:22:05.123Z] [bridge] inbound message_id=25294 kind=rich chars=6057');
  eq(inboundLogLine({ at: AT, messageId: 25295, kind: 'text', chars: 12 }), '[2026-10-12T14:22:05.123Z] [bridge] inbound message_id=25295 kind=text chars=12');
});

t('a file kind carries no character count, even when handed one', () => {
  for (const kind of ['photo', 'file', 'video', 'video note', 'voice', 'audio', 'unknown']) {
    eq(inboundLogLine({ at: AT, messageId: 7, kind, chars: 900 }), `[2026-10-12T14:22:05.123Z] [bridge] inbound message_id=7 kind=${kind}`, kind);
  }
});

t('one grep answers "did it arrive"', () => {
  const lines = [
    inboundLogLine({ at: AT, messageId: 25294, kind: 'rich', chars: 6057 }),
    inboundLogLine({ at: AT, messageId: 252940, kind: 'text', chars: 3 }),
    inboundLogLine({ at: AT, messageId: 2529, kind: 'photo' }),
  ];
  eq(lines.filter((l) => /inbound message_id=25294 /.test(l)).length, 1, 'the id is followed by a space, so 25294 does not match 252940');
});

t('★ nothing but the four facts can reach the line, whatever is passed', () => {
  const secret = 'the client said the policy number is 4417';
  const line = inboundLogLine({ at: AT, messageId: 9, kind: secret, chars: secret, text: secret, content: secret, caption: secret });
  eq(line, '[2026-10-12T14:22:05.123Z] [bridge] inbound message_id=9 kind=unknown');
  const idLine = inboundLogLine({ at: AT, messageId: secret, kind: 'text', chars: 5 });
  eq(idLine, '[2026-10-12T14:22:05.123Z] [bridge] inbound message_id=? kind=text chars=5');
  ok(!line.includes('policy') && !idLine.includes('policy'), 'content reached the log');
  eq(line.split('\n').length, 1);
});

t('bad numbers never throw and never print NaN', () => {
  const line = inboundLogLine({ at: NaN, messageId: undefined, kind: 'text', chars: NaN });
  eq(line, '[unknown-time] [bridge] inbound message_id=? kind=text');
  ok(!/NaN|undefined|null/.test(inboundLogLine({})), inboundLogLine({}));
  eq(inboundLogLine({ at: AT, messageId: 3, kind: 'text', chars: -4 }), '[2026-10-12T14:22:05.123Z] [bridge] inbound message_id=3 kind=text');
  eq(inboundLogLine({ at: AT, messageId: 3, kind: 'text', chars: 0 }), '[2026-10-12T14:22:05.123Z] [bridge] inbound message_id=3 kind=text chars=0');
});

// ---------------------------------------------------------------------------
console.log('\n3. a kind the bridge cannot read');
// ---------------------------------------------------------------------------

const STICKER = { message_id: 31, from: { id: 1 }, chat: { id: 1 }, date: 1, sticker: { emoji: '👍', file_id: 'S' } };

t('the log line names the id, the field names and the file, never a value', () => {
  const line = unknownLogLine({ at: AT, messageId: 31, keys: messageKeys(STICKER), savedAs: '1791800000000_unknown_31.json' });
  eq(line, '[2026-10-12T14:22:05.123Z] [bridge] unreadable message_id=31 keys=message_id,from,chat,date,sticker saved=1791800000000_unknown_31.json');
  ok(!line.includes('👍') && !line.includes('file_id'), line);
});

t('a failed save is said in the line', () => {
  ok(unknownLogLine({ at: AT, messageId: 31, keys: ['sticker'], savedAs: null }).endsWith(' keys=sticker saved=no'));
  ok(unknownLogLine({ at: AT, messageId: 31 }).endsWith(' keys=none saved=no'));
});

t('★ field names are made safe: no spaces, no newlines, bounded', () => {
  const hostile = { 'a key with spaces': 1, 'line\nbreak': 2, ['k'.repeat(300)]: 3 };
  const keys = messageKeys(hostile);
  eq(keys[0], 'a?key?with?spaces');
  eq(keys[1], 'line?break');
  eq(keys[2].length, 40);
  const many = messageKeys(Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`k${i}`, i])));
  eq(many.length, 40);
  eq(unknownLogLine({ at: AT, messageId: 1, keys }).split('\n').length, 1);
  eq(messageKeys(null).length, 0);
  eq(messageKeys('a string').length, 0);
  eq(messageKeys([1, 2]).length, 0);
  ok(!unknownLogLine({ at: AT, messageId: 1, keys: ['ok', 'two words', 'x\ny'], savedAs: 'a b/../c.json' }).includes(' words'), 'a key handed straight to the line is cleaned too');
});

t('the kind label is the first field that is not envelope', () => {
  eq(unknownKindLabel(STICKER), 'sticker');
  eq(unknownKindLabel({ message_id: 1, chat: {}, date: 1, poll: {} }), 'poll');
  eq(unknownKindLabel({ message_id: 1, reply_to_message: {}, location: {}, venue: {} }), 'location');
  eq(unknownKindLabel({ message_id: 1, new_chat_members: [] }), 'new chat members');
});

t('a rich message with no words is named as that', () => {
  eq(unknownKindLabel({ message_id: 1, date: 1, rich_message: { blocks: [] } }), 'formatted message with no words');
});

t('nothing to name gives an empty label, and bad input never throws', () => {
  eq(unknownKindLabel({ message_id: 1, from: {}, chat: {}, date: 1 }), '');
  eq(unknownKindLabel(null), '');
  eq(unknownKindLabel('x'), '');
  ok(unknownKindLabel({ ['z'.repeat(90)]: 1 }).length <= 28);
});

// ---------------------------------------------------------------------------
console.log('\n4. the saved files');
// ---------------------------------------------------------------------------

t('the name is <ts>_unknown_<message_id>.json', () => {
  eq(unknownFileName(1791800000000, 25294), '1791800000000_unknown_25294.json');
  eq(unknownFileName(1791800000000.9, '25294'), '1791800000000_unknown_25294.json');
  eq(unknownFileName(NaN, undefined), '0_unknown_0.json');
  ok(/^\d+_unknown_\d+\.json$/.test(unknownFileName(5, -3)), unknownFileName(5, -3));
  ok(/^\d+_unknown_\d+\.json$/.test(unknownFileName(5, '../../etc/passwd')), 'a hostile id cannot leave the folder');
});

const names = (n, from = 1000) => Array.from({ length: n }, (_, i) => unknownFileName(from + i, 500 + i));

t('at or under the limit nothing is deleted', () => {
  eq(unknownFilesToPrune(names(UNKNOWN_KEEP)).length, 0);
  eq(unknownFilesToPrune(names(3)).length, 0);
  eq(unknownFilesToPrune([]).length, 0);
  eq(unknownFilesToPrune(undefined).length, 0);
});

t('★ past the limit the OLDEST go, and exactly the newest 20 stay', () => {
  const all = names(27);
  const gone = unknownFilesToPrune([...all].reverse());
  eq(gone.length, 7);
  eq([...gone].sort().join(','), all.slice(0, 7).sort().join(','), 'the seven oldest');
  eq(UNKNOWN_KEEP, 20);
});

t('the order is by the timestamp as a NUMBER, not as a string', () => {
  const gone = unknownFilesToPrune(['999_unknown_1.json', '1000_unknown_2.json', '1001_unknown_3.json'], 2);
  eq(gone.join(','), '999_unknown_1.json', '"999" sorts after "1000" as a string, and is the oldest as a number');
});

t('★ only its own files are ever named: attachments in the same folder are untouched', () => {
  const others = ['1791800000000_photo_25.jpg', '1791800000001_voice_26.ogg', 'test-attachment.txt', '1791800000002_notes_unknown_3.json', 'unknown_4.json', '5_unknown_x.json', '6_unknown_7.json.bak', '.DS_Store'];
  const gone = unknownFilesToPrune([...others, ...names(25)], 20);
  eq(gone.length, 5);
  ok(gone.every((n) => /^\d+_unknown_\d+\.json$/.test(n)), gone.join(','));
  ok(!gone.some((n) => others.includes(n)), 'an attachment was named for deletion');
  eq(unknownFilesToPrune(others, 0).length, 0, 'with keep 0, still none of the others');
});

t('★ a file is only "a saved unknown message" when its CONTENT is one too', () => {
  const saved = JSON.stringify({ message_id: 25294, chat: { id: 1 }, sticker: {} }, null, 2);
  eq(isSavedUnknown('1791800000000_unknown_25294.json', saved), true);
  // An attachment they sent, called unknown_5.json, is saved as <ts>_unknown_5.json.
  eq(isSavedUnknown('1791800000000_unknown_5.json', '{"rows":[1,2,3]}'), false, 'their own JSON file');
  eq(isSavedUnknown('1791800000000_unknown_5.json', 'not json at all'), false);
  eq(isSavedUnknown('1791800000000_unknown_5.json', '[1,2]'), false);
  eq(isSavedUnknown('1791800000000_unknown_5.json', 'null'), false);
  eq(isSavedUnknown('1791800000000_unknown_5.json', JSON.stringify({ message_id: 6 })), false, 'another message id');
  eq(isSavedUnknown('1791800000000_photo_5.jpg', saved), false, 'the wrong name, whatever is in it');
  eq(isSavedUnknown('0_unknown_0.json', JSON.stringify({ chat: { id: 1 } })), true, 'a message that had no id was saved under 0');
  eq(isSavedUnknown(undefined, undefined), false);
});

t('a bad keep falls back to the default rather than deleting everything', () => {
  eq(unknownFilesToPrune(names(25), NaN).length, 5);
  eq(unknownFilesToPrune(names(25), -1).length, 5);
  eq(unknownFilesToPrune(names(25), 0).length, 25, 'an explicit zero is honoured');
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all inbound tests pass');
