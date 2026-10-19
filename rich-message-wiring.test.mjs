#!/usr/bin/env node
// Wiring tests for inbound messages: the REAL handleUpdate, handleMedia,
// dispatchPrompt, pickLane, queueItem and the unknown kind path, sliced out of
// bridge.mjs by source and run against a fake Telegram and a temp inbox.
//
// rich-message.test.mjs proves the flattener reads a rich message. That is not
// the same as the daemon USING it: on 2026-10-12 a long text from the phone
// arrived as `rich_message` with no `text`, and handleUpdate, which read only
// `msg.text`, answered "Send text, photos, videos, voice notes or files." four
// times. So this suite sends updates through handleUpdate itself and asserts on
// what reaches the lane.
//
// The main instrument is a DIFFERENTIAL: the same words sent once as plain
// `text` and once as a `rich_message` must leave identical records (the lane,
// the prompt, the reply quote, the steer, the queue). "A rich message runs
// exactly like a text message" is then a comparison, not a list of cases
// someone remembered to write.
//
// bridge.mjs boots a daemon when it is the entry point, so nothing here imports
// it. No network, no Telegram token, no daemon. Every fixture is synthetic.
//
//   node rich-message-wiring.test.mjs

import { readFileSync, mkdtempSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flattenRichMessage, richPromptText } from './rich-message.mjs';
import { UNKNOWN_KEEP } from './inbound.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];
const t = async (name, fn) => {
  try {
    await fn();
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

// ---------------------------------------------------------------------------
// Extraction: a top level `function` or `const` and everything indented under
// it, up to the next line that starts in column 0. A closing `}` or `]` on that
// line belongs to the declaration.
// ---------------------------------------------------------------------------
const BRIDGE_SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8');
const SRC = BRIDGE_SRC.split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
  const start = SRC.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  const out = [SRC[start]];
  for (let i = start + 1; i < SRC.length; i++) {
    const l = SRC[i];
    if (/^\S/.test(l)) {
      if (l.startsWith('}') || l.startsWith(']')) out.push(l);
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}
const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);

const INBOX = mkdtempSync(path.join(os.tmpdir(), 'rich-wiring-inbox-'));
process.on('exit', () => rmSync(INBOX, { recursive: true, force: true }));

const HARNESS = `
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnginePrefix } from ${url('bg-codex.mjs')};
import { briefTitle, stripLaneRules } from ${url('bg-notify.mjs')};
import { queueAck, queueFull, steeredInAck, attachmentAck, unreadableMessageNotice, holdFullLine } from ${url('system-messages.mjs')};
import { clip, oneLine } from ${url('progress-render.mjs')};
import { buildReplyQuote, composeWithQuote } from ${url('reply-quote.mjs')};
import { flattenRichMessage, richPromptText } from ${url('rich-message.mjs')};
import { inboundKind, inboundLogLine, messageKeys, unknownLogLine, unknownKindLabel, unknownFileName, unknownFilesToPrune, isSavedUnknown, UNKNOWN_KEEP } from ${url('inbound.mjs')};
const CHAT_ID = '111';
const BRIDGE_NAME = 'the assistant';
const BOT_ID = '777';
const OWNER_TZ = 'America/Toronto';
const STALE_SEC = 3600;
const BG_TASK_TIMEOUT_MS = 0;
const CLAUDE_AVAILABLE = true;
export let INBOX_DIR = ${JSON.stringify(INBOX)};
export const setInbox = (p) => { INBOX_DIR = p; };
const gov = () => ({ coolingDown: () => false, noticeOwner: async () => {} });
export const SENT = [];
export let failSend = false;
export const setFailSend = (v) => { failSend = v; };
const send = (text, opts = {}) => {
  if (failSend) return Promise.reject(new Error('sendMessage: 500'));
  SENT.push({ text, opts });
  return Promise.resolve({ message_id: 900 + SENT.length });
};
export const ERRORS = [];
const sendError = async (e) => { ERRORS.push(e); };
export const CALLBACKS = [];
const handleAccountCallback = async (q) => { CALLBACKS.push(q); };
export const COMMANDS = [];
const handleCommand = async (text, msg) => { COMMANDS.push({ text, id: msg?.message_id }); };
let ownerMessageSinceBoot = false;
export const ownerSeen = () => ownerMessageSinceBoot;
let autoResumesSinceMessage = 7;
export const autoResumes = () => autoResumesSinceMessage;
export const FLUSHES = [];
const flushParkedHandbacks = (why) => { FLUSHES.push(why); };
let mediaGroup = null;
export const setGroup = (g) => { mediaGroup = g; };
export const getGroup = () => mediaGroup;
export const DOWNLOADS = [];
const downloadMedia = async (media) => { DOWNLOADS.push(media); return '/inbox/' + media.name; };
export let HEARD = 'the words they said out loud';
const transcribeVoice = async () => HEARD;
const rememberInbox = () => {};
const voiceUntranscribedLine = () => 'not transcribed';
const chatLaneEngine = () => 'claude';
export const LANES = { main: { name: 'main', current: null, queue: [] } };
export const bgLanes = [];
let bgSeq = 0;
// THE ENGINE DECISION IS NOT THIS SUITE'S SUBJECT (bg-codex-wiring.test.mjs
// owns it against the real functions). It is recorded, so "the same item
// reached the decision" is still asserted, and it always falls through to the
// lane logic below it, which IS the subject: steer, queue, run.
export const DECIDED = [];
const engineForItem = (lane, item) => { DECIDED.push({ lane: lane.name, item: { ...item } }); return { engine: 'claude', pausedUntil: 0 }; };
const startResolvedRun = () => 'fallthrough';
const codexWalled = () => false;
const takeHandoffPrefix = () => '';
const trackQueueAck = () => {};
const deliverWithoutClaude = () => {};
export const CLAUDE = [];
const runClaude = (text, lane, opts = {}) => { CLAUDE.push({ text, lane: lane.name, opts }); return Promise.resolve(); };
export const reset = () => {
  SENT.length = 0; ERRORS.length = 0; CALLBACKS.length = 0; COMMANDS.length = 0; FLUSHES.length = 0; DOWNLOADS.length = 0; DECIDED.length = 0; CLAUDE.length = 0;
  ownerMessageSinceBoot = false; autoResumesSinceMessage = 7; mediaGroup = null; failSend = false;
  LANES.main.current = null; LANES.main.queue.length = 0; LANES.main.priorityCount = 0; bgLanes.length = 0; bgSeq = 0;
  INBOX_DIR = ${JSON.stringify(INBOX)};
};
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        grab('RESERVED_COMMANDS', 'const'),
        grab('BG_COMMAND_RE', 'const'),
        // This build keeps a Claude slash command off an unchosen Codex, and
        // dispatchPrompt's hold reads it: sliced as real code.
        grab('unchosenCodex', 'const'),
        grab('QUEUE_MAX', 'const'),
        grab('makeBgLane'),
        grab('getBgLane'),
        grab('pickMedia'),
        grab('buildMediaPrompt'),
        grab('pickLane'),
        grab('queueItem'),
        grab('dispatchPrompt'),
        grab('mediaEntry'),
        grab('flushGroup'),
        grab('handleMedia'),
        grab('saveUnknownMessage'),
        grab('handleUnknownMessage'),
        grab('handleUpdate'),
        'export { handleUpdate, RESERVED_COMMANDS, QUEUE_MAX };',
      ].join('\n'),
    )
);

// ---------------------------------------------------------------------------
// Fixtures. Synthetic, in the shape Telegram sends.
// ---------------------------------------------------------------------------
const OWNER = 111;
const NOW = () => Math.floor(Date.now() / 1000);
let seq = 5000;
const base = (extra = {}) => ({ message_id: ++seq, from: { id: OWNER, first_name: 'the owner' }, chat: { id: OWNER, type: 'private' }, date: NOW(), ...extra });
const para = (text) => ({ type: 'paragraph', text });
/** The same words as a plain text update and as a rich message update. */
const asText = (words, extra = {}) => ({ update_id: 1, message: base({ text: words, ...extra }) });
const asRich = (words, extra = {}) => ({ update_id: 1, message: base({ rich_message: { blocks: words.split('\n').map(para) }, ...extra }) });

/** Run handleUpdate with the console captured, so the log lines can be read. */
async function run(update) {
  const logs = [];
  const errs = [];
  const { log, error } = console;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await B.handleUpdate(update);
    await new Promise((r) => setTimeout(r, 0)); // let fire and forget sends land
  } finally {
    console.log = log;
    console.error = error;
  }
  return { logs, errs };
}
const inboundLines = (logs) => logs.filter((l) => /\[bridge\] inbound message_id=/.test(l));

/** What a dispatch left behind, with the ids and clocks that differ per update removed. */
function record() {
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'queuedAt' ? undefined : v)));
  return JSON.stringify({
    claude: strip(B.CLAUDE),
    decided: strip(B.DECIDED),
    queue: strip(B.LANES.main.queue),
    bg: B.bgLanes.map((l) => l.name),
    sent: B.SENT.map((s) => s.text),
    commands: B.COMMANDS.map((c) => c.text),
    owner: B.ownerSeen(),
    autoResumes: B.autoResumes(),
    flushes: B.FLUSHES,
  });
}

/** Run the same words both ways from the same starting state and return both records. */
async function both(words, { setup = () => {}, extra = {} } = {}) {
  B.reset();
  const sa = setup();
  await run(asText(words, extra));
  const text = { record: record(), state: sa };
  B.reset();
  const sb = setup();
  await run(asRich(words, extra));
  const rich = { record: record(), state: sb };
  return { text, rich };
}

// ---------------------------------------------------------------------------
console.log('\n1. the incident: a rich message with no `text` reaches dispatchPrompt');
// ---------------------------------------------------------------------------

const INCIDENT = {
  update_id: 77,
  message: base({
    rich_message: {
      blocks: [
        para('Answers for the bot, in order'),
        para(''),
        {
          type: 'list',
          items: [
            { label: '1.', type: '1', value: 1, blocks: [para(['The site is ', { type: 'url', text: 'example.com/start', url: 'example.com/start' }, ' .'])] },
            { label: '2.', type: '1', value: 2, blocks: [para('Yes, weekdays only')] },
            { label: '3.', type: '1', value: 3, blocks: [para('Call first.'), para('Then text if nobody answers.')] },
            { label: '4.', type: '1', value: 4, blocks: [para(['Read ', { type: 'url', text: 'the intake sheet', url: 'https://example.com/intake' }])] },
          ],
        },
        para(['{ "site": "', { type: 'url', text: 'example.com', url: 'http://example.com/' }, '" }']),
      ],
    },
  }),
};
const INCIDENT_TEXT = [
  'Answers for the bot, in order',
  '',
  '1. The site is example.com/start .',
  '2. Yes, weekdays only',
  '3. Call first.',
  '   Then text if nobody answers.',
  '4. Read the intake sheet (https://example.com/intake)',
  '{ "site": "example.com" }',
].join('\n');

B.reset();
const incidentRun = await run(INCIDENT);

await t('★ the flattened text is the prompt, on the chat lane, and a turn starts', () => {
  eq(B.CLAUDE.length, 1, 'no turn was started for a rich message');
  eq(B.CLAUDE[0].text, INCIDENT_TEXT);
  eq(B.CLAUDE[0].lane, 'main');
  eq(B.CLAUDE[0].text, flattenRichMessage(INCIDENT.message.rich_message), 'the daemon and the pure function disagree');
});

await t('★ the refusal line is gone: nothing was sent to them at all', () => {
  eq(B.SENT.length, 0, JSON.stringify(B.SENT));
  ok(!/const HELP|Send text, photos, videos, voice notes or files\./.test(grab('handleUpdate')), 'the old refusal is still in handleUpdate');
});

await t('it counts as a message from them: the wake-up yields, parked reports are handed over', () => {
  eq(B.ownerSeen(), true);
  eq(B.autoResumes(), 0);
  eq(B.FLUSHES.join(','), 'message');
});

await t('it is dispatched with the same options a text gets', () => {
  // dispatchPrompt asks for the engine decision twice (the wall check, then the
  // run), so the item is recorded twice: the same item both times.
  ok(B.DECIDED.length >= 1, 'the item never reached the engine decision');
  ok(B.DECIDED.every((d) => d.item.text === INCIDENT_TEXT && d.lane === 'main'), JSON.stringify(B.DECIDED.map((d) => d.lane)));
  eq(B.DECIDED[0].item.allowCodexFallback, true);
  eq(B.DECIDED[0].item.text, INCIDENT_TEXT);
  eq(B.DECIDED[0].item.replyQuote, null);
  eq(incidentRun.errs.length, 0, incidentRun.errs.join('\n'));
});

// ---------------------------------------------------------------------------
console.log('\n2. ★ the differential: the same words as text and as a rich message');
// ---------------------------------------------------------------------------

const BOT_BUBBLE = { message_id: 400, from: { id: 777, is_bot: true, first_name: 'the assistant' }, date: 1757362260, text: 'Draft ready: reply to the client about the invoice' };

await t('★ an idle chat lane: the same run', async () => {
  const r = await both('what is the status of the deploy');
  eq(r.rich.record, r.text.record);
  ok(JSON.parse(r.rich.record).claude.length === 1, 'neither started a turn');
});

await t('★ a reply: the same quote block rides beside the same words', async () => {
  const r = await both('send this one', { extra: { reply_to_message: BOT_BUBBLE } });
  eq(r.rich.record, r.text.record);
  const quote = JSON.parse(r.rich.record).claude[0].opts.replyQuote;
  ok(quote && quote.block.includes('Draft ready: reply to the client'), JSON.stringify(quote));
});

await t('★ a running turn: both are STEERED into it, with the same composed text and the same ack', async () => {
  const setup = () => {
    const steers = [];
    B.LANES.main.current = { engine: 'claude', prompt: 'the running task', steer: (text, opts) => { steers.push({ text, note: opts.note, frame: opts.frame, quote: opts.quote?.block || null }); return true; } };
    return steers;
  };
  const r = await both('also check the logs', { setup, extra: { reply_to_message: BOT_BUBBLE } });
  eq(r.rich.record, r.text.record);
  eq(JSON.stringify(r.rich.state), JSON.stringify(r.text.state));
  eq(r.rich.state.length, 1, 'the rich message was not steered');
  ok(r.rich.state[0].text.endsWith('\n\nalso check the logs') && r.rich.state[0].text.startsWith("[Replying to the assistant's message"), r.rich.state[0].text);
  ok(JSON.parse(r.rich.record).sent[0].startsWith('➡️ Sent into the running task.'), r.rich.record);
  eq(JSON.parse(r.rich.record).claude.length, 0, 'a steered message must not also start a turn');
});

await t('★ a running turn that cannot be steered: both are QUEUED, with the same ack', async () => {
  const setup = () => {
    B.LANES.main.current = { engine: 'claude', prompt: 'the running task', steer: () => false };
  };
  const r = await both('after that, write the summary', { setup });
  eq(r.rich.record, r.text.record);
  const rec = JSON.parse(r.rich.record);
  eq(rec.queue.length, 1);
  eq(rec.queue[0].text, 'after that, write the summary');
  ok(/Queued/.test(rec.sent[0]), rec.sent[0]);
});

await t('a full queue refuses both the same way', async () => {
  const setup = () => {
    B.LANES.main.current = { engine: 'claude', prompt: 'the running task', steer: () => false };
    for (let i = 0; i < B.QUEUE_MAX; i++) B.LANES.main.queue.push({ text: `q${i}` });
  };
  const r = await both('one more', { setup });
  eq(r.rich.record, r.text.record);
  eq(JSON.parse(r.rich.record).queue.length, B.QUEUE_MAX);
});

await t('★ the lane choice: a "bg:" prefix sends both to a background worker', async () => {
  const r = await both('bg: run the whole suite');
  eq(r.rich.record, r.text.record);
  const rec = JSON.parse(r.rich.record);
  eq(rec.claude[0].lane, 'bg');
  eq(rec.claude[0].text, 'run the whole suite');
});

await t('★ the lane choice: a Claude Code command such as /goal sends both to a background worker', async () => {
  const r = await both('/goal ship the importer until the tests pass');
  eq(r.rich.record, r.text.record);
  eq(JSON.parse(r.rich.record).claude[0].lane, 'bg');
});

await t('an engine prefix pins both the same way, and is stripped from both', async () => {
  const r = await both('codex: review the last diff');
  eq(r.rich.record, r.text.record);
  const rec = JSON.parse(r.rich.record);
  eq(rec.decided[0].item.forcedEngine, 'codex');
  eq(rec.decided[0].item.text, 'review the last diff');
});

await t('a menu command with underscores is translated for both', async () => {
  const r = await both('/qa_loop the importer');
  eq(r.rich.record, r.text.record);
  eq(JSON.parse(r.rich.record).claude[0].text, '/qa-loop the importer');
});

await t('text right after an album is folded in as its caption for both', async () => {
  const mk = () => {
    const grp = { id: 'album-1', files: ['/inbox/a.jpg (photo)'], paths: ['/inbox/a.jpg'], kinds: ['photo', 'photo'], caption: '', pending: 0, done: false, timer: null, replyQuote: null };
    B.setGroup(grp);
    return grp;
  };
  const r = await both('compare these two', { setup: mk });
  eq(r.rich.record, r.text.record);
  const rec = JSON.parse(r.rich.record);
  ok(rec.claude[0].text.startsWith('compare these two\n\n[1 attachment sent over Telegram'), rec.claude[0].text);
  eq(B.getGroup(), null, 'the album was not flushed');
});

await t('a multi line message: every line arrives, in order', async () => {
  const words = 'first line\nsecond line\nthird line';
  const r = await both(words);
  eq(r.rich.record, r.text.record);
  eq(JSON.parse(r.rich.record).claude[0].text, words);
});

// ---------------------------------------------------------------------------
console.log('\n3. a rich message is never a daemon command');
// ---------------------------------------------------------------------------

await t('control: plain "/status" is the daemon\'s own command and starts no turn', async () => {
  B.reset();
  await run(asText('/status'));
  eq(B.COMMANDS.length, 1);
  eq(B.COMMANDS[0].text, '/status');
  eq(B.CLAUDE.length, 0);
});

await t('★ a rich message whose words are "/status" is NOT a daemon command: it goes to the chat', async () => {
  B.reset();
  await run(asRich('/status'));
  eq(B.COMMANDS.length, 0, 'a formatted note ran a daemon command');
  eq(B.CLAUDE.length, 1);
  eq(B.CLAUDE[0].text, '/status');
});

await t('★ and that holds for every reserved command, including the destructive ones', async () => {
  ok(B.RESERVED_COMMANDS.size >= 20, `only ${B.RESERVED_COMMANDS.size} reserved commands were extracted`);
  for (const cmd of B.RESERVED_COMMANDS) {
    B.reset();
    await run(asRich(`${cmd} now`));
    eq(B.COMMANDS.length, 0, `${cmd} ran as a daemon command from a rich message`);
    eq(B.CLAUDE.length, 1, `${cmd}: the note was not delivered to the chat`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n4. long messages, and media inside a rich message');
// ---------------------------------------------------------------------------

await t('★ a 20,000 character rich message reaches the lane whole', async () => {
  const items = Array.from({ length: 220 }, (_, i) => ({ label: `${i + 1}.`, type: '1', value: i + 1, blocks: [para(`answer ${i + 1} ${'word '.repeat(18)}`.trim())] }));
  const update = { update_id: 2, message: base({ rich_message: { blocks: [para('Start'), { type: 'list', items }, para('End of the long message')] } }) };
  B.reset();
  const { logs } = await run(update);
  const want = flattenRichMessage(update.message.rich_message);
  ok(want.length > 20000, `the fixture is only ${want.length} characters`);
  eq(B.CLAUDE.length, 1);
  eq(B.CLAUDE[0].text.length, want.length, 'the prompt was cut');
  eq(B.CLAUDE[0].text, want);
  ok(B.CLAUDE[0].text.endsWith('End of the long message'), 'the tail is missing');
  eq(inboundLines(logs)[0].endsWith(`kind=rich chars=${want.length}`), true, inboundLines(logs)[0]);
});

await t('★ the prompt travels on stdin, never in argv: a 20,000 character line survives a real pipe', async () => {
  // Where the prompt goes is read off runClaude itself: the argument list is
  // fixed flags, and the text is written to the child's stdin as one
  // stream-json line. So its size is bounded by a pipe (which Node buffers),
  // not by ARG_MAX.
  const start = BRIDGE_SRC.indexOf('\nasync function runClaude(');
  const fn = BRIDGE_SRC.slice(start, BRIDGE_SRC.indexOf('\n}\n', start));
  ok(start > 0 && fn.length > 5000, 'runClaude was not found');
  ok(/const args = \['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'\];/.test(fn), 'the argument list changed shape');
  ok(/child\.stdin\.write\(userMsg\(text\)\);/.test(fn), 'the prompt is no longer written to stdin');
  ok(!/args\.push\([^)]*\b(text|rawText|quoted|prompt)\b/.test(fn), 'something pushes the prompt into argv');
  const userMsgSrc = /const userMsg = (\(t\) => JSON\.stringify\(\{[^\n]+\) \+ '\\n';)/.exec(fn);
  ok(userMsgSrc, 'the stdin framing moved');
  const userMsg = new Function(`return ${userMsgSrc[1].replace(/;$/, '')}`)();
  const prompt = `${'a formatted answer with "quotes", a\ttab and a line\nbreak. '.repeat(400)}THE END`;
  ok(prompt.length > 20000, `${prompt.length}`);
  // A real child with a real stdin pipe, reading exactly the way a CLI does.
  const child = spawn(process.execPath, ['-e', "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d.trim());process.stdout.write(m.message.content[0].text)})"], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stdin.write(userMsg(prompt));
  child.stdin.end();
  const code = await new Promise((r) => child.on('close', r));
  eq(code, 0);
  eq(out.length, prompt.length, 'the child read a different number of characters than were written');
  eq(out, prompt);
});

await t('media inside a rich message: a placeholder in place, and one line saying it was not downloaded', async () => {
  const update = { update_id: 3, message: base({ rich_message: { blocks: [para('Here is the damage'), { type: 'photo', photo: [{ file_id: 'P1' }], caption: { text: 'under the sink' } }, para('Call me')] } }) };
  B.reset();
  await run(update);
  eq(B.CLAUDE.length, 1);
  const text = B.CLAUDE[0].text;
  ok(text.startsWith('Here is the damage\n[photo] under the sink\nCall me\n\n[This formatted Telegram message also held 1 photo'), text);
  ok(/did not download/.test(text), text);
  eq(text, richPromptText(update.message.rich_message));
  eq(B.DOWNLOADS.length, 0, 'nothing is fetched for a media block');
});

await t('a file whose words came as a rich message keeps them as its caption', async () => {
  const update = { update_id: 4, message: base({ photo: [{ file_id: 'S', file_size: 10 }, { file_id: 'L', file_size: 900 }], rich_message: { blocks: [para('what is wrong with this wiring'), para('second line')] } }) };
  B.reset();
  const { logs } = await run(update);
  eq(B.DOWNLOADS.length, 1);
  eq(B.DOWNLOADS[0].file_id, 'L');
  eq(B.CLAUDE.length, 1);
  ok(B.CLAUDE[0].text.startsWith('what is wrong with this wiring\nsecond line\n\n[1 attachment sent over Telegram'), B.CLAUDE[0].text);
  ok(inboundLines(logs)[0].endsWith('kind=photo'), inboundLines(logs)[0]);
});

await t('a plain caption still wins over a rich message on the same file', async () => {
  B.reset();
  await run({ update_id: 5, message: base({ photo: [{ file_id: 'L' }], caption: 'the plain caption', rich_message: { blocks: [para('the formatted words')] } }) });
  ok(B.CLAUDE[0].text.startsWith('the plain caption\n\n['), B.CLAUDE[0].text);
});

// ---------------------------------------------------------------------------
console.log('\n5. a kind nothing reads: saved, logged by its field names, said once, no turn');
// ---------------------------------------------------------------------------

const unknownFiles = () => readdirSync(INBOX).filter((n) => /^\d+_unknown_\d+\.json$/.test(n));
const clearInbox = () => {
  for (const n of readdirSync(INBOX)) rmSync(path.join(INBOX, n), { force: true });
};

const STICKER = { update_id: 9, message: base({ sticker: { file_id: 'STK', emoji: '🔥', set_name: 'PrivateSetNameXYZZY' } }) };
clearInbox();
B.reset();
const stickerRun = await run(STICKER);

await t('★ no turn is started, by any route', () => {
  eq(B.CLAUDE.length, 0, 'a turn was started for a message nobody could read');
  eq(B.DECIDED.length, 0, 'it reached the dispatch');
  eq(B.COMMANDS.length, 0);
  eq(B.DOWNLOADS.length, 0);
  eq(B.LANES.main.queue.length, 0);
  eq(B.ownerSeen(), false, 'an unreadable message must not cancel the restart wake-up');
});

await t('★ the raw message is saved in the inbox as <ts>_unknown_<message_id>.json', () => {
  const files = unknownFiles();
  eq(files.length, 1, JSON.stringify(readdirSync(INBOX)));
  ok(new RegExp(`^\\d{13}_unknown_${STICKER.message.message_id}\\.json$`).test(files[0]), files[0]);
  const saved = JSON.parse(readFileSync(path.join(INBOX, files[0]), 'utf8'));
  eq(JSON.stringify(saved), JSON.stringify(STICKER.message), 'the saved JSON is not the message that arrived');
});

await t('★ ONE notice, and it says what happened: not read, the kind, saved for the assistant', () => {
  eq(B.SENT.length, 1, JSON.stringify(B.SENT));
  eq(B.SENT[0].text, ['📭 Message not read', 'Kind · sticker', 'The bridge cannot read this kind yet', 'Saved for the assistant to look at', 'Text, photos, videos, voice and files work'].join('\n'));
  eq(B.SENT[0].opts.markdown, false);
  ok(!/[\u2013\u2014]/.test(B.SENT[0].text), 'a dash in a daemon message');
});

await t('★ one log line with the id and the top level keys, and no content', () => {
  const lines = stickerRun.logs.filter((l) => /\[bridge\] unreadable message_id=/.test(l));
  eq(lines.length, 1, stickerRun.logs.join('\n'));
  ok(new RegExp(`^\\[\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\\] \\[bridge\\] unreadable message_id=${STICKER.message.message_id} keys=message_id,from,chat,date,sticker saved=\\d{13}_unknown_${STICKER.message.message_id}\\.json$`).test(lines[0]), lines[0]);
  const all = stickerRun.logs.concat(stickerRun.errs).join('\n');
  ok(!all.includes('XYZZY') && !all.includes('🔥') && !all.includes('STK'), `content reached the log:\n${all}`);
});

await t('a rich message with no words takes the same path, and is named as that', async () => {
  clearInbox();
  B.reset();
  const update = { update_id: 10, message: base({ rich_message: { blocks: [para(''), para('   '), { type: 'anchor', name: 'top' }] } }) };
  const { logs } = await run(update);
  eq(B.CLAUDE.length, 0);
  eq(unknownFiles().length, 1);
  eq(B.SENT.length, 1);
  ok(B.SENT[0].text.includes('Kind · formatted message with no words'), B.SENT[0].text);
  ok(inboundLines(logs)[0].endsWith('kind=unknown'), inboundLines(logs)[0]);
});

await t('a rich message that is not an object at all does not throw, and is saved', async () => {
  for (const bad of ['a string', 7, null, [], { blocks: 'nope' }]) {
    clearInbox();
    B.reset();
    const { errs } = await run({ update_id: 11, message: base({ rich_message: bad }) });
    eq(B.CLAUDE.length, 0, JSON.stringify(bad));
    eq(B.SENT.length, 1, JSON.stringify(bad));
    eq(unknownFiles().length, 1, JSON.stringify(bad));
    eq(errs.length, 0, errs.join('\n'));
  }
});

await t(`★ only the newest ${UNKNOWN_KEEP} saved messages are kept, and attachments beside them are untouched`, async () => {
  clearInbox();
  const mine = ['1791800000000_photo_25.jpg', 'test-attachment.txt', '1791800000002_notes_unknown_3.json'];
  for (const n of mine) writeFileSync(path.join(INBOX, n), 'an attachment');
  // Five older saves already on disk, with timestamps well in the past.
  for (let i = 0; i < 5; i++) writeFileSync(path.join(INBOX, `${1000 + i}_unknown_${i + 1}.json`), JSON.stringify({ message_id: i + 1, sticker: {} }));
  // And one ATTACHMENT they sent that was called unknown_9.json: the oldest file
  // with a matching name, and not ours. It must outlive the prune.
  const their = '999_unknown_9.json';
  writeFileSync(path.join(INBOX, their), '{"rows":[1,2,3]}');
  const ids = [];
  for (let i = 0; i < 22; i++) {
    B.reset();
    const u = { update_id: 20 + i, message: base({ poll: { id: String(i), question: 'XYZZY?' } }) };
    ids.push(u.message.message_id);
    await run(u);
    await new Promise((r) => setTimeout(r, 2)); // distinct millisecond timestamps
  }
  const kept = unknownFiles().filter((n) => n !== their);
  eq(kept.length, UNKNOWN_KEEP, `${kept.length} files kept`);
  const keptIds = kept.map((n) => Number(/_unknown_(\d+)\.json$/.exec(n)[1])).sort((a, b) => a - b);
  eq(JSON.stringify(keptIds), JSON.stringify(ids.slice(-UNKNOWN_KEEP)), 'the newest were not the ones kept');
  for (const n of mine) ok(existsSync(path.join(INBOX, n)), `${n} was deleted by the prune`);
  ok(existsSync(path.join(INBOX, their)), 'an attachment named like a saved message was deleted on its name alone');
  eq(readFileSync(path.join(INBOX, their), 'utf8'), '{"rows":[1,2,3]}');
  eq(readdirSync(INBOX).length, UNKNOWN_KEEP + mine.length + 1);
});

await t('★ a save that fails is said in the notice and in the log, and nothing throws', async () => {
  clearInbox();
  B.reset();
  // A FILE where the inbox directory should be: mkdir and the write both fail.
  const blocker = path.join(INBOX, 'not-a-directory');
  writeFileSync(blocker, 'x');
  B.setInbox(path.join(blocker, 'inbox'));
  const { logs, errs } = await run({ update_id: 60, message: base({ dice: { emoji: '🎲', value: 4 } }) });
  eq(B.SENT.length, 1);
  ok(B.SENT[0].text.includes('It could not be saved') && !B.SENT[0].text.includes('Saved for'), B.SENT[0].text);
  ok(B.SENT[0].text.includes('Kind · dice'), B.SENT[0].text);
  ok(logs.some((l) => /unreadable message_id=\d+ keys=message_id,from,chat,date,dice saved=no$/.test(l)), logs.join('\n'));
  ok(errs.some((l) => l.includes('could not save an unreadable message')), errs.join('\n'));
  eq(B.CLAUDE.length, 0);
  B.setInbox(INBOX);
  rmSync(blocker, { force: true });
});

// ---------------------------------------------------------------------------
console.log('\n6. one inbound log line per message, and never the content');
// ---------------------------------------------------------------------------

const SECRET = 'XYZZY-the-client-policy-4417';
const LINE = (id, kind, chars = null) => new RegExp(`^\\[\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z\\] \\[bridge\\] inbound message_id=${id} kind=${kind}${chars == null ? '' : ` chars=${chars}`}$`);

const KIND_CASES = [
  ['text', { text: `plain ${SECRET}` }, `plain ${SECRET}`.length],
  ['rich', { rich_message: { blocks: [para(`formatted ${SECRET}`), para('line two')] } }, `formatted ${SECRET}\nline two`.length],
  ['photo', { photo: [{ file_id: 'A' }], caption: SECRET }, null],
  ['file', { document: { file_id: 'D', file_name: `${SECRET}.pdf` }, caption: SECRET }, null],
  ['video', { video: { file_id: 'V', file_name: `${SECRET}.mp4` } }, null],
  ['voice', { voice: { file_id: 'N' }, caption: SECRET }, null],
  ['audio', { audio: { file_id: 'U', file_name: `${SECRET}.mp3` } }, null],
  ['video note', { video_note: { file_id: 'R' } }, null],
  ['unknown', { contact: { phone_number: '5550100', first_name: SECRET } }, null],
];

for (const [kind, fields, chars] of KIND_CASES) {
  await t(`★ ${kind}: exactly one line, with the id${chars == null ? '' : ' and the character count'}, and no content`, async () => {
    clearInbox();
    B.reset();
    const update = { update_id: 100, message: base(fields) };
    const { logs, errs } = await run(update);
    const lines = inboundLines(logs);
    eq(lines.length, 1, logs.join('\n'));
    ok(LINE(update.message.message_id, kind, chars).test(lines[0]), lines[0]);
    const all = logs.concat(errs).join('\n');
    ok(!all.includes('XYZZY'), `content reached the log for ${kind}:\n${all}`);
  });
}

await t('a daemon command is a text message too, and is logged as one', async () => {
  B.reset();
  const update = asText('/status');
  const { logs } = await run(update);
  ok(LINE(update.message.message_id, 'text', 7).test(inboundLines(logs)[0]), inboundLines(logs)[0]);
});

await t('a message from another chat leaves no inbound line, and neither does a button tap', async () => {
  B.reset();
  const stranger = await run({ update_id: 101, message: { message_id: 1, from: { id: 999 }, chat: { id: 999 }, date: NOW(), text: SECRET } });
  eq(inboundLines(stranger.logs).length, 0);
  eq(B.CLAUDE.length, 0);
  const tap = await run({ update_id: 102, callback_query: { id: 'cb', data: 'x' } });
  eq(inboundLines(tap.logs).length, 0);
  eq(B.CALLBACKS.length, 1);
});

await t('★ a stale rich message is still recorded as arrived, is skipped, and its words stay out of the log', async () => {
  B.reset();
  const update = { update_id: 103, message: base({ date: NOW() - 7200, rich_message: { blocks: [para(`late ${SECRET}`)] } }) };
  const { logs } = await run(update);
  eq(inboundLines(logs).length, 1);
  ok(LINE(update.message.message_id, 'rich', `late ${SECRET}`.length).test(inboundLines(logs)[0]), inboundLines(logs)[0]);
  eq(B.CLAUDE.length, 0, 'a stale message was run');
  ok(logs.some((l) => /skipping stale message \(120 min old\): <rich message>$/.test(l)), logs.join('\n'));
  ok(!logs.join('\n').includes('XYZZY'), logs.join('\n'));
  eq(B.SENT.length, 1);
  ok(B.SENT[0].text.startsWith('⏭️ Skipped a stale message (120m old)\n"late XYZZY'), 'the notice to them shows which message it was');
});

await t('the inbound line is written by the pure builder, and nothing else in handleUpdate logs a message body', () => {
  const src = grab('handleUpdate');
  eq((src.match(/inboundLogLine\(/g) || []).length, 1);
  ok(/console\.log\(inboundLogLine\(\{ at: Date\.now\(\), messageId: msg\.message_id, kind, chars: /.test(src), 'the call changed shape');
  // The one place a body is still logged is the stale skip of a PLAIN text,
  // which predates this suite and is bounded to 60 characters.
  const logCalls = src.match(/console\.(log|error)\([^\n]*/g) || [];
  eq(logCalls.length, 3, logCalls.join('\n'));
  ok(/ignoring message from unauthorized chat \$\{msg\.chat\?\.id\}/.test(logCalls[0]), logCalls[0]);
  ok(/^console\.log\(inboundLogLine\(/.test(logCalls[1]), logCalls[1]);
  ok(/skipping stale message \(\$\{Math\.round\(ageSec \/ 60\)\} min old\): \$\{logWhat\.slice\(0, 60\)\}/.test(logCalls[2]), logCalls[2]);
  // And what the stale line prints is the plain text or a KIND, never the
  // words of a rich message.
  ok(/const logWhat = msg\.text \|\| `<\$\{media\?\.kind \|\| \(isRich \? 'rich message' : 'media'\)\}>`;/.test(src), 'logWhat changed: check it cannot carry a rich message body');
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all rich-message wiring tests pass');
