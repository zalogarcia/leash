#!/usr/bin/env node
// PROGRESS PRIORITY — which progress writes may be shed, and which may not.
//
// The Telegram write governor protects real answers during a rate limit by
// SHEDDING disposable writes. Correct, and not weakened here. What it also did,
// unintentionally, is shed the reader's live view at random. From a live
// tg-ledger.jsonl on 2026-09-19: seven `sendMessage` drops at retryAfter 1
// (token-bucket starvation with four or five lanes pulsing at once) and one more
// at retryAfter 405 (a real cooldown). Those are the progress PLACEHOLDERS: the
// bubble never appeared at all.
//
// Not every progress write costs the same when it is dropped:
//
//   the opening placeholder   -> no bubble at all for the whole turn   NOT disposable
//   the terminal state edit   -> a bubble stuck on a hourglass forever NOT disposable
//   an intermediate step edit -> one stale frame, corrected next tick   disposable
//   a typing pulse            -> nothing                               disposable
//
// And the second decision taken the same day: stop streaming the edits from the
// background lanes into their bubbles, so the progress edits on the chat lane
// are prioritised and the reader can see what the daemon is doing.
//
// These tests run the REAL functions out of bridge.mjs against the REAL governor
// out of tg-governor.mjs, and assert on the outcome the governor WRITES TO ITS
// LEDGER — not on the source saying the right words. bridge.mjs runs main() only
// as an entry point, but extracting by source is still how every wiring test in
// this repo does it (see system-wiring.test.mjs), and it keeps the daemon out of
// the process entirely.
//
//   node progress-priority.test.mjs

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WORKER_TICK_MS } from './bg-notify.mjs';
import { fetchingLine } from './system-messages.mjs';

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
  // Structural, not ===: half the assertions below compare ledger outcome
  // ARRAYS, and `["dropped"] !== ["dropped"]` is a test that can only fail.
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${msg}\n    got:  ${a}\n    want: ${b}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------------------
// Extraction. `grab` is the top-level form used across this repo's wiring
// tests; `grabNested` reaches a closure-scoped arrow (the chat lane's own
// bubble renderer lives inside runClaude and is reachable no other way).
// ---------------------------------------------------------------------------
const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
  const start = SRC.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  const out = [SRC[start]];
  for (let i = start + 1; i < SRC.length; i++) {
    const l = SRC[i];
    if (/^\S/.test(l)) {
      if (l.startsWith('}') || l.startsWith('};')) out.push(l);
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}
function grabNested(name, indent = 4) {
  const pad = ' '.repeat(indent);
  const head = new RegExp(`^${pad}const ${name} = async \\(\\) => \\{`);
  const start = SRC.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract nested ${name} from bridge.mjs, did it get renamed?`);
  const out = [SRC[start].slice(indent)];
  for (let i = start + 1; i < SRC.length; i++) {
    out.push(SRC[i].slice(indent));
    if (SRC[i] === `${pad}};`) break;
  }
  return out.join('\n');
}
const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);

const LEDGER_DIR = mkdtempSync(path.join(tmpdir(), 'progress-priority-'));

// ---------------------------------------------------------------------------
// THE HARNESS. A real governor with an injected clock, an injected transport,
// and its three files in a temp dir. `tg` and `editProgress` are the real ones.
// ---------------------------------------------------------------------------
const HARNESS = `
import { createGovernor } from ${url('tg-governor.mjs')};
import { escHtml, mdToTelegramHtml } from ${url('md-format.mjs')};
import { fetchingLine, fetchFailedLine } from ${url('system-messages.mjs')};
import { workerLine } from ${url('bg-notify.mjs')};
import { WORKER_TICK_MS, WORKER_IDLE_MS } from ${url('bg-notify.mjs')};
import { quoteBlock, renderTail, fmtElapsed, thinkingWord } from ${url('progress-render.mjs')};
import path from 'node:path';

const CHAT_ID = '1';
const TG_MSG_LIMIT = 4000;
const PROGRESS_TAIL = 3400;
const IDLE_EDIT_MS = 20000;
const WORD_HOLD_SEC = 12;
const THINKING_WORDS = ['Thinking', 'Working'];
const WORKER_ORPHAN_MS = 120000;
const WORKER_KEEPALIVE_MAX_MS = 1800000;
const BG_PROGRESS_ON = true;
const LEDGER_DIR = ${JSON.stringify(LEDGER_DIR)};

export let editCooldownUntil = 0;
export const setEditCooldown = (v) => { editCooldownUntil = v; };

// ONE CLOCK FOR EVERYTHING IN THIS MODULE. The governor takes an injected
// \`now\`, but the extracted bridge functions call Date.now() directly — and a
// live-message tick is entirely a comparison of Date.now() against a cadence.
// Without this shadow, advancing the governor's clock moved nothing the sweep
// could see, every tick was early, and "a background lane issues zero edits"
// passed for the wrong reason: it would have read zero before the change too.
// Subclassing keeps \`new Date(x)\` intact for anything that wants it.
const RealDate = globalThis.Date;
let CLOCK = 1_000_000;
class Date extends RealDate {
  static now() {
    return CLOCK;
  }
}
export const setClock = (v) => { CLOCK = v; };
export const advance = (ms) => { CLOCK += ms; };
export const clock = () => CLOCK;

export const RAW = [];        // every call that reached the "network"
export let rawFails = null;   // {code, retryAfter, description} to throw instead
export const setRawFails = (v) => { rawFails = v; };
// A wait MOVES THE CLOCK. It used to be a no-op, which is fine while nothing
// under test waits on purpose, and a lie the moment something does: the short
// cooldown tg() waits out (inlineWaitMaxMs) would still be running when the
// wait returned, so "it waits and then sends" read as "it skipped". Everything
// else in this file drives the clock with advance() and never sleeps.
let sleepHook = null;
export const setSleepHook = (fn) => { const prev = sleepHook; sleepHook = fn; return prev; };
const sleep = async (ms) => { CLOCK += Number(ms) || 0; if (sleepHook) sleepHook(ms); };

const tgRaw = async (method, payload) => {
  RAW.push({ method, payload });
  if (rawFails) {
    const e = new Error(\`\${method}: \${rawFails.code}\`);
    Object.assign(e, rawFails);
    throw e;
  }
  return { message_id: 500 + RAW.length };
};

let governorInstance = null;
export let LEDGER_FILE = '';
export function newGovernor(suffix) {
  LEDGER_FILE = path.join(LEDGER_DIR, 'ledger-' + suffix + '.jsonl');
  governorInstance = createGovernor({
    chatId: CHAT_ID,
    name: () => 'Leash',
    deliver: tgRaw,
    now: () => CLOCK,
    sleep,
    log: () => {},
    outboxFile: path.join(LEDGER_DIR, 'outbox-' + suffix + '.json'),
    throttleFile: path.join(LEDGER_DIR, 'throttle-' + suffix + '.json'),
    ledgerFile: LEDGER_FILE,
  });
  RAW.length = 0;
  rawFails = null;
  editCooldownUntil = 0;
  return governorInstance;
}
const gov = () => governorInstance;
export { gov };

// send(), reduced to what the notices under test use: a real (non-disposable)
// chat write, so a held one returns the governor's receipt and no message_id —
// exactly as the daemon's own send() does. The opening flag is threaded for the
// same reason: it is what the real send() passes through to tg(), and a harness
// that swallowed it would prove the sites right while the daemon held them.
const send = async (text, { markdown = true, disposable = false, opening = false } = {}) =>
  tg('sendMessage', { chat_id: CHAT_ID, text }, 0, { disposable, opening });

const visibleOnly = (s) => String(s).replace(/<[^>]+>/g, '');
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        grab('tg'),
        grab('editProgress'),
        grab('pendingMessage'),
        grab('LANE_KIND', 'const'),
        grab('streamsStepEdits', 'const'),
        grab('liveMessages', 'const'),
        grab('registerLive'),
        grab('tickLiveMessages'),
        grab('workerNotices', 'const'),
        grab('startWorkerNotice'),
        grab('editWorkerNotice'),
        'export { tg, editProgress, pendingMessage, LANE_KIND, streamsStepEdits, registerLive, tickLiveMessages, liveMessages, workerNotices, startWorkerNotice, editWorkerNotice, send };',
        // The chat lane's OWN bubble renderer, lifted out of runClaude with its
        // closure supplied. Criterion 5 is about this function and nothing else.
        `export function makeChatRenderer({ progressMsgId, lane, toolLines, progress, startedAt }) {
           let lastRenderedBody = '';
           let lastEditAt = 0;
           let lastRendered = '';
           const wordSeed = 0;
           ${grabNested('renderProgressInner')}
           return renderProgressInner;
         }`,
      ].join('\n'),
    )
);

/** Every row the governor wrote to its ledger for the current scenario. */
const ledger = () =>
  existsSync(B.LEDGER_FILE)
    ? readFileSync(B.LEDGER_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const outcomes = (method) => ledger().filter((r) => r.method === method).map((r) => r.outcome);

// ===========================================================================
console.log('\n1. Criterion 1 — an opening progress placeholder is never dropped');
// ===========================================================================

// ---- during a real cooldown -----------------------------------------------
{
  const g = B.newGovernor('c1-cooldown');
  g.throttle(400, 'sendMessage'); // a 400s wall, the shape the live ledger caught
  B.RAW.length = 0;
  // No `opening` flag: this is the classification the fix rests ON, asserted
  // before section 6 changes what the SITES ask for. A chat write that is not
  // chrome is held by the governor, never shed. That is the contract the
  // opening skip is allowed to opt out of, and nothing else may.
  const res = await B.tg('sendMessage', { chat_id: '1', text: '🤖 Thinking…' }, 0, {});

  await t('★ cooling down: an unflagged non-disposable send is HELD, never dropped', () => {
    const got = outcomes('sendMessage');
    ok(got.includes('held'), `expected a held row, ledger says ${JSON.stringify(got)}`);
    ok(!got.includes('dropped'), `a placeholder was dropped: ${JSON.stringify(got)}`);
  });
  await t('a held placeholder returns the governor receipt, not a message_id', () => {
    eq(res.queued, true, 'the caller must be able to see it was held');
    eq(res.message_id, undefined, 'no id, so every edit downstream short-circuits');
  });
  await t('it did not spend into the penalty', () => eq(B.RAW.length, 0, 'nothing reached Telegram'));
}

// ---- under token-bucket starvation (the 7-of-8 case) -----------------------
{
  const g = B.newGovernor('c1-bucket');
  // Drain the bucket with real writes on a frozen clock: no refill, so the next
  // disposable cannot reach `1 + reserve` and would be shed.
  for (let i = 0; i < 3; i++) await B.tg('sendMessage', { chat_id: '1', text: 'answer' }, 0, {});
  const before = outcomes('sendMessage').length;

  const disposable = await B.tg('sendMessage', { chat_id: '1', text: 'chrome' }, 0, { disposable: true }).catch(
    (e) => e,
  );
  await t('control: a still-disposable send IS dropped on a starved bucket', () => {
    eq(disposable.code, 429, 'the old classification still sheds');
    eq(outcomes('sendMessage')[before], 'dropped');
  });

  const m = await B.tg('sendMessage', { chat_id: '1', text: '🤖 Thinking…' }, 0, {});
  await t('★ starved bucket: the opening placeholder is SENT', () => {
    eq(outcomes('sendMessage').at(-1), 'sent');
    ok(m.message_id, 'it came back with an id, so the bubble exists');
  });
}

// ---- a REAL opening site, not tg() driven by hand ---------------------------
// The defect was never in tg(): a non-disposable sendMessage was always held.
// It was in the call sites, each of which marked its own placeholder
// `disposable: true`. So drive one of them.
{
  const g = B.newGovernor('c1-site-cooldown');
  g.throttle(400, 'sendMessage');
  const p = await B.pendingMessage('the daemon log');
  // CHANGED 2026-09-19 (the deferred MEDIUM, called the same evening). This
  // used to assert `['held']`, which is what put a "⏳ fetching…" above an
  // answer that had already landed. Section 6 is the whole case; the two
  // assertions here are the site-level half of it and are kept in place so a
  // reader of criterion 1 sees the current rule, not the one it replaced.
  await t('★ pendingMessage: its opening ⏳ is NOT SENT under a cooldown', () => {
    const got = outcomes('sendMessage');
    eq(got, ['skipped'], 'a placeholder that could only arrive late is not sent at all');
  });
  await t('a skipped opening leaves msgId null, so the timer is never armed', () => {
    eq(p.msgId, null);
  });
  await p.settle('the answer');
  await t('and settle() still delivers the answer, as its own send, with nothing stale above it', () => {
    const items = g.items();
    eq(items.length, 1, `outbox holds ${items.length}: ${JSON.stringify(items.map((i) => i.payload.text))}`);
    ok(items[0].payload.text.includes('the answer'), 'the answer is the one thing held');
    ok(
      !items.some((i) => i.payload.text === fetchingLine('the daemon log')),
      'the placeholder must not be waiting to flush behind the answer',
    );
  });
}

{
  B.newGovernor('c1-site-bucket');
  for (let i = 0; i < 3; i++) await B.tg('sendMessage', { chat_id: '1', text: 'answer' }, 0, {});
  const p = await B.pendingMessage('the daemon log');
  await t('★ pendingMessage: its opening ⏳ is SENT on a starved bucket', () => {
    eq(outcomes('sendMessage').at(-1), 'sent');
    ok(p.msgId, 'the bubble exists');
  });
  p.settle('done');
}

await t('★ every opening progress send has stopped being disposable, except the one judged', () => {
  const src = SRC.join('\n');
  const sites = [];
  const re = /disposable: true/g;
  let m;
  while ((m = re.exec(src))) sites.push(src.slice(0, m.index).split('\n').length);
  // Exactly one remains: /restart. Its process exits four lines later, so THIS
  // daemon can never flush what it holds, and a null restartMsg already resolves
  // through a fresh announce. Every other placeholder is a bubble the turn
  // needs. If this count moves, a site was added without being judged.
  eq(sites.length, 1, `disposable: true at lines ${sites.join(', ')}`);
  const window = SRC.slice(sites[0] - 30, sites[0]).join('\n');
  ok(/JUDGED AND KEPT DISPOSABLE/.test(window), 'the surviving site must say why, in place');
  ok(/restartingLine\(\)/.test(SRC[sites[0] - 1]), `the surviving site is not /restart: ${SRC[sites[0] - 1]}`);
});

// ===========================================================================
console.log('\n2. Criterion 2 — a terminal progress state is never dropped');
// ===========================================================================

{
  const g = B.newGovernor('c2-cooldown');
  g.throttle(400, 'sendMessage');

  await B.editProgress(77, '<b>🤖 Thinking…</b>'); // an intermediate frame
  await t('control: an intermediate step edit is still shed while cooling down', () => {
    eq(outcomes('editMessageText'), ['dropped'], 'intermediate frames must stay disposable');
  });

  await B.editProgress(77, '<b>✅ Done</b> · 4m', () => '✅ Done · 4m', { final: true });
  await t('★ cooling down: the terminal edit is HELD, never dropped', () => {
    const got = outcomes('editMessageText');
    eq(got.at(-1), 'held', `ledger says ${JSON.stringify(got)}`);
  });
  await t('the held terminal edit carries the real payload, to be applied on flush', () => {
    const item = g.items().at(-1);
    eq(item.method, 'editMessageText');
    eq(item.payload.message_id, 77);
    ok(item.payload.text.includes('✅ Done'), 'the ending itself is what was held');
  });
}

{
  const g = B.newGovernor('c2-flush');
  g.throttle(400, 'sendMessage');
  await B.editProgress(77, '<b>✅ Done</b> · 4m', () => '✅ Done · 4m', { final: true });
  B.advance(402_000); // the wall passes
  B.RAW.length = 0;
  await g.flush();
  await t('★ the held terminal edit is actually applied when the wall clears', () => {
    const edit = B.RAW.find((c) => c.method === 'editMessageText');
    ok(edit, `no edit reached Telegram; got ${JSON.stringify(B.RAW.map((c) => c.method))}`);
    eq(edit.payload.message_id, 77);
    ok(edit.payload.text.includes('✅ Done'), 'the bubble reaches its terminal state');
  });
  await t('and the governor records it as sent, so the bubble is not left lying', () => {
    ok(outcomes('editMessageText').includes('sent'));
  });
}

{
  const g = B.newGovernor('c2-bucket');
  for (let i = 0; i < 3; i++) await B.tg('sendMessage', { chat_id: '1', text: 'answer' }, 0, {});
  await B.editProgress(77, '<b>🤖 Thinking…</b>');
  await t('control: a starved bucket sheds the intermediate frame', () => {
    eq(outcomes('editMessageText'), ['dropped']);
  });
  await B.editProgress(77, '<b>🛑 Stopped</b>', () => '🛑 Stopped', { final: true });
  await t('★ starved bucket: the terminal edit is HELD, never dropped', () => {
    // The governor classifies EVERY editMessageText as disposable by method, so
    // a starved bucket refuses it a token; the bridge's answer is to hold it.
    eq(outcomes('editMessageText').at(-1), 'held');
  });
  B.RAW.length = 0;
  await g.flush();
  await t('★ and it is delivered on the very next flush, no wall needed', () => {
    const edit = B.RAW.find((c) => c.method === 'editMessageText');
    ok(edit, `nothing flushed: ${JSON.stringify(B.RAW.map((c) => c.method))}`);
    ok(edit.payload.text.includes('🛑 Stopped'), 'the ending landed');
  });
  await t('with no "Telegram throttled" header, because no 429 ever happened', () => {
    eq(
      B.RAW.filter((c) => c.method === 'sendMessage').length,
      0,
      'a bucket hold must not announce a throttle that did not occur',
    );
  });
}

{
  // Telegram itself answering 429 on the terminal edit, rather than the gate.
  const g = B.newGovernor('c2-network429');
  B.setRawFails({ code: 429, retryAfter: 400, description: 'Too Many Requests' });
  await B.editProgress(77, '<b>✅ Done</b>', () => '✅ Done', { final: true });
  await t('★ a 429 FROM Telegram on the terminal edit holds it too', () => {
    const got = outcomes('editMessageText');
    ok(got.includes('held'), `ledger says ${JSON.stringify(got)}`);
    ok(!got.includes('dropped'), 'the ending must never be dropped');
  });
  B.setRawFails(null);
}

// ===========================================================================
console.log('\n3. Criteria 3 & 4 — a background lane opens, resolves, and streams nothing');
// ===========================================================================

/**
 * One background job end to end: dispatch, a long run with steps arriving, then
 * a terminal state. Returns the governed calls in order.
 */
async function runBgJob({ laneKind, status = 'finished', sweeps = 40 }) {
  B.newGovernor(`bg-${laneKind}-${status}`);
  B.workerNotices.clear();
  B.liveMessages.clear();
  let steps = 0;
  const read = () => ({ elapsedSec: steps * 20, steps, lastAct: `step ${steps}` });
  const runId = 'bg-1';
  const entry = await B.startWorkerNotice(runId, { lane: 'bg', repo: 'demo', brief: 'a long job' }, read, '', {
    laneKind,
  });
  ok(entry, 'the notice registered');
  const opened = B.RAW.length;
  // A real run: the step list changes and the sweep fires far more often than
  // the tick cadence, which is exactly when the old code spent its edits.
  for (let i = 0; i < sweeps; i++) {
    steps++;
    B.advance(WORKER_TICK_MS + 1000);
    B.tickLiveMessages();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget edits land
  }
  const duringSweeps = B.RAW.length - opened;
  B.editWorkerNotice(runId, { phase: 'done', status, elapsedSec: steps * 20 });
  await new Promise((r) => setImmediate(r));
  return { opened, duringSweeps, calls: B.RAW.slice() };
}

{
  const r = await runBgJob({ laneKind: B.LANE_KIND.background });
  await t('★ a background lane issues ZERO intermediate step edits', () => {
    eq(r.duringSweeps, 0, `40 sweeps produced ${r.duringSweeps} edits:\n${JSON.stringify(r.calls, null, 2)}`);
  });
  await t('★ the opening bubble is still sent, naming the task', () => {
    eq(r.calls[0].method, 'sendMessage');
    ok(r.calls[0].payload.text.includes('a long job'), `the brief is not in the bubble: ${r.calls[0].payload.text}`);
  });
  await t('★ the bubble still reaches its terminal state on success', () => {
    const last = r.calls.at(-1);
    eq(last.method, 'editMessageText', 'the ending is an edit to the same bubble');
    ok(/✅/.test(last.payload.text), `no ✅ in the ending: ${last.payload.text}`);
  });
  await t('the whole job costs exactly two chat writes', () => {
    eq(r.calls.length, 2, `${r.calls.length} writes: ${JSON.stringify(r.calls.map((c) => c.method))}`);
  });
  await t('the ending still carries the step count, read while it was silent', () => {
    ok(/40 steps/.test(r.calls.at(-1).payload.text), `lastLive was lost: ${r.calls.at(-1).payload.text}`);
  });
}

for (const [status, glyph] of [
  ['failed', '❌'],
  ['stopped', '🛑'],
]) {
  const r = await runBgJob({ laneKind: B.LANE_KIND.background, status });
  await t(`★ the bubble reaches its terminal state on ${status}`, () => {
    const last = r.calls.at(-1);
    eq(last.method, 'editMessageText');
    ok(new RegExp(glyph).test(last.payload.text), `no ${glyph} in the ending: ${last.payload.text}`);
  });
  await t(`no run ends on a non terminal bubble (${status})`, () => {
    ok(!/⏳/.test(r.calls.at(-1).payload.text), `the last frame still shows a hourglass: ${r.calls.at(-1).payload.text}`);
  });
}

{
  // The ending must survive a wall, or "it always resolves" is only true when
  // nothing is wrong — which is when it matters least.
  B.newGovernor('bg-terminal-wall');
  B.workerNotices.clear();
  B.liveMessages.clear();
  const runId = 'bg-2';
  await B.startWorkerNotice(runId, { lane: 'bg', brief: 'job' }, () => ({ elapsedSec: 10, steps: 1 }), '', {
    laneKind: B.LANE_KIND.background,
  });
  B.gov().throttle(400, 'sendMessage');
  B.editWorkerNotice(runId, { phase: 'done', status: 'finished', elapsedSec: 10 });
  await new Promise((r) => setImmediate(r));
  await t('★ a background ending met by a cooldown is HELD, never dropped', () => {
    const got = outcomes('editMessageText');
    ok(got.includes('held'), `ledger says ${JSON.stringify(got)}`);
    ok(!got.includes('dropped'), 'the one edit a bg job spends must not be sheddable');
  });
}

{
  // A worker whose run vanishes must still retire its entry — the silent tick
  // is still the thing that expires the line.
  B.newGovernor('bg-orphan');
  B.workerNotices.clear();
  B.liveMessages.clear();
  let alive = true;
  const entry = await B.startWorkerNotice('bg-3', { lane: 'bg', brief: 'job' }, () => (alive ? { steps: 1 } : null), '', {
    laneKind: B.LANE_KIND.background,
  });
  alive = false;
  B.tickLiveMessages(); // marks goneSince
  B.advance(200_000);
  B.tickLiveMessages();
  await t('a silent background line still expires when its run vanishes', () => {
    eq(entry.done, true, 'the entry would tick for the life of the daemon');
    eq(B.workerNotices.has('bg-3'), false, 'and it would leak in the map');
  });
}

// ===========================================================================
console.log('\n4. Criterion 5 — the chat lane still streams its steps');
// ===========================================================================

{
  // The predicate is not a blanket off: a chat-kind line on the very same
  // renderer still edits. This is what makes the change a lane split rather
  // than a removal.
  const r = await runBgJob({ laneKind: B.LANE_KIND.chat, sweeps: 5 });
  await t('★ a chat-kind lane on the same renderer DOES stream its steps', () => {
    ok(r.duringSweeps > 0, 'the chat lane lost its stream too — that is the regression this guards');
    eq(r.duringSweeps, 5, `expected one edit per changed sweep, got ${r.duringSweeps}`);
  });
}

{
  // And the chat lane's OWN bubble renderer, lifted out of runClaude: untouched
  // by this change, and proven to still spend an edit per step.
  B.newGovernor('chat-bubble');
  const toolLines = [];
  const progress = [];
  const render = B.makeChatRenderer({
    progressMsgId: 900,
    lane: { icon: '🤖' },
    toolLines,
    progress,
    startedAt: Date.now() - 30_000,
  });
  for (let i = 0; i < 6; i++) {
    const e = { kind: 'tool', emoji: '💻', name: 'Bash', arg: `step ${i}` };
    toolLines.push(e);
    progress.push(e);
    B.advance(6_000); // the real EDIT_INTERVAL_MS: the bucket refills between ticks
    await render();
  }
  const edits = B.RAW.filter((c) => c.method === 'editMessageText');
  await t('★ the chat lane bubble still edits once per new step', () => {
    eq(edits.length, 6, `expected 6 step edits, got ${edits.length}`);
    eq(outcomes('editMessageText'), ['sent', 'sent', 'sent', 'sent', 'sent', 'sent']);
  });
  B.gov().throttle(400, 'editMessageText');
  await B.editProgress(900, '<b>🤖 Thinking…</b>');
  await t('those chat-lane frames are still disposable (the governor may shed them)', () => {
    eq(outcomes('editMessageText').at(-1), 'dropped', 'an intermediate chat frame must stay sheddable');
  });
}

// ===========================================================================
console.log('\n5. The classification itself');
// ===========================================================================

await t('streamsStepEdits is a predicate over a lane KIND, not an icon compare', () => {
  eq(B.streamsStepEdits(B.LANE_KIND.chat), true);
  eq(B.streamsStepEdits(B.LANE_KIND.background), false);
  eq(B.streamsStepEdits('🌙'), false, 'an icon must never read as the chat lane');
  eq(B.streamsStepEdits(undefined), false, 'and neither must a missing kind');
});

await t('startWorkerNotice defaults to the background rule', async () => {
  const src = grab('startWorkerNotice');
  ok(/laneKind = LANE_KIND\.background/.test(src), 'the default must be stated, not inherited by accident');
});

await t('no progress site decides a lane by comparing its icon', () => {
  const src = SRC.join('\n');
  ok(!/icon === ['"`]/.test(src), 'an icon string compare crept back in');
});

await t('the governor module itself was not touched by this change', () => {
  const gsrc = readFileSync(path.join(DIR, 'tg-governor.mjs'), 'utf8');
  ok(!/durable/.test(gsrc), 'the fix must live in the bridge, not in the shared governor');
  ok(!/opening/.test(gsrc), 'and neither classification belongs in the shared governor');
  ok(/DISPOSABLE_METHODS = new Set/.test(gsrc), 'the shedding policy is still the governor’s');
});

// ===========================================================================
console.log('\n6. A placeholder whose moment has passed is not sent at all');
// ===========================================================================
// THE DEFERRED COST, now fixed. Making the opening placeholder non-disposable
// (537a728) stopped it being SHED and started it being HELD, so a real wall
// flushed it afterwards, as a fresh message the run can never edit, and the
// chat read: throttle header, "🤖 Thinking…", the answer. A line announcing
// work that had already finished, sitting above its own result. Flagged by an
// independent verifier, deferred as MEDIUM, and fixed the same evening.
//
// The rule: an opening placeholder claims "something is happening NOW", which
// is worth nothing once it can only arrive later. So during a WALL it is not
// sent. Not during bucket pressure, which is measured in a second, and the
// bubble still lands while the work is running. And the terminal edit is
// untouched: still durable, still never dropped, on every path below.

// ---- the gate, before the send --------------------------------------------
{
  const g = B.newGovernor('c6-gate');
  g.throttle(400, 'sendMessage');
  B.RAW.length = 0;
  const res = await B.tg('sendMessage', { chat_id: '1', text: '🤖 Thinking…' }, 0, { opening: true });

  await t('★ cooling down: an opening placeholder is SKIPPED, not held', () => {
    eq(outcomes('sendMessage'), ['skipped'], 'it must be neither sent, nor held, nor dropped');
    eq(B.RAW.length, 0, 'nothing reached Telegram');
  });
  await t('it returns null, which every site reads as "no bubble"', () => eq(res, null));
  await t('and it holds NOTHING, so nothing can flush above the answer later', () =>
    eq(g.items().length, 0, `outbox: ${JSON.stringify(g.items().map((i) => i.payload.text))}`));

  // The constraint: the skip may only ever apply to a placeholder.
  await B.editProgress(77, '<b>✅ Done</b> · 4m', () => '✅ Done · 4m', { final: true });
  await t('★ the terminal edit in the same cooldown is still HELD', () => {
    eq(outcomes('editMessageText'), ['held'], 'a terminal state may never be made sheddable');
  });
  const answer = await B.tg('sendMessage', { chat_id: '1', text: 'the answer' }, 0, {});
  await t('★ and a real answer in the same cooldown is still HELD', () => {
    eq(answer.queued, true, 'the governor’s contract for a message they must read is untouched');
    eq(outcomes('sendMessage').at(-1), 'held');
  });
}

// ---- no wall: nothing changes ----------------------------------------------
{
  B.newGovernor('c6-nowall');
  const m = await B.tg('sendMessage', { chat_id: '1', text: '🤖 Thinking…' }, 0, { opening: true });
  await t('★ not cooling down: the opening placeholder is SENT, exactly as before', () => {
    eq(outcomes('sendMessage'), ['sent']);
    ok(m?.message_id, 'it came back with an id, so the bubble exists and can be edited');
  });
}

{
  // The 7-of-8 case from the live ledger. A starved bucket is a second or two,
  // not a wall: the placeholder still lands while the work is running, so this
  // must stay exactly as 537a728 left it.
  B.newGovernor('c6-bucket');
  for (let i = 0; i < 3; i++) await B.tg('sendMessage', { chat_id: '1', text: 'answer' }, 0, {});
  const m = await B.tg('sendMessage', { chat_id: '1', text: '🤖 Thinking…' }, 0, { opening: true });
  await t('★ a starved bucket still SENDS the opening placeholder (only a wall skips it)', () => {
    eq(outcomes('sendMessage').at(-1), 'sent');
    ok(m?.message_id, 'the bubble exists');
  });
}

// ---- a SHORT cooldown is waited out, not skipped ---------------------------
{
  // The two doors have to agree about the same wall. The one below waits out
  // anything inside inlineWaitMaxMs rather than giving up, because three
  // seconds is not a lost moment: the bubble still lands while the work runs.
  const g = B.newGovernor('c6-short');
  g.throttle(2, 'sendMessage'); // 3s with the governor's slack: inside the bound
  const before = B.clock();
  const m = await B.tg('sendMessage', { chat_id: '1', text: '🤖 Thinking…' }, 0, { opening: true });
  await t('★ a SHORT cooldown waits and then SENDS the placeholder', () => {
    eq(outcomes('sendMessage'), ['sent'], `ledger says ${JSON.stringify(outcomes('sendMessage'))}`);
    ok(m?.message_id, 'the bubble exists and can be edited by the run that opened it');
  });
  await t('it waited the cooldown out rather than spending into it', () => {
    ok(B.clock() - before >= 3000, `only ${B.clock() - before}ms passed, so it did not wait`);
  });
  await t('and nothing was held, so nothing can flush late', () => eq(g.items().length, 0));
}

{
  // The wall EXTENDED while the short wait ran: another lane's 429, or another
  // process writing tg-throttle.json. Waiting again in a loop would walk this
  // placeholder to wherever the wall ends, so it is skipped on the re-check.
  const g = B.newGovernor('c6-short-extended');
  g.throttle(2, 'sendMessage');
  const realSleep = B.setSleepHook((ms) => {
    B.setSleepHook(null); // once: the extension happens during the FIRST wait
    g.throttle(400, 'sendMessage'); // a long wall opens under us
  });
  const res = await B.tg('sendMessage', { chat_id: '1', text: '🤖 Thinking…' }, 0, { opening: true });
  await t('★ a wall that grows during the wait skips the placeholder on re-check', () => {
    eq(outcomes('sendMessage'), ['skipped'], `ledger says ${JSON.stringify(outcomes('sendMessage'))}`);
    eq(res, null);
    eq(g.items().length, 0, 'and it is not walked into the outbox');
  });
  void realSleep;
}

// ---- the second door: Telegram answering 429 to the placeholder itself ------
{
  // The FIRST write of a wall finds no cooldown to check. The gate passes,
  // Telegram refuses it, and the deadline opens in the response, which is
  // where the old code enqueued it and re-created the same stale line one
  // branch later.
  const g = B.newGovernor('c6-second-door');
  B.setRawFails({ code: 429, retryAfter: 400, description: 'Too Many Requests' });
  const res = await B.tg('sendMessage', { chat_id: '1', text: '🤖 Thinking…' }, 0, { opening: true }).catch((e) => e);
  await t('★ a 429 FROM Telegram on the opening placeholder skips it too, never holds it', () => {
    const got = outcomes('sendMessage');
    eq(got.at(-1), 'skipped', `ledger says ${JSON.stringify(got)}`);
    ok(got.includes('throttled'), 'the 429 is still recorded, and still opened the cooldown');
    eq(g.items().length, 0, `outbox: ${JSON.stringify(g.items().map((i) => i.payload.text))}`);
  });
  await t('and the site sees null rather than a throw', () => eq(res, null));

  // Control, same 429, same governor: a message they must read is still held.
  const answer = await B.tg('sendMessage', { chat_id: '1', text: 'the answer' }, 0, {});
  await t('★ control: the same 429 on a real answer still HOLDS it', () => {
    eq(answer.queued, true);
    eq(g.items().length, 1, 'the answer is in the outbox');
  });
  B.setRawFails(null);
}

// ---- end to end: a wall, a skipped bubble, and what the reader actually sees -
{
  const g = B.newGovernor('c6-endtoend');
  g.throttle(400, 'sendMessage');
  const p = await B.pendingMessage('the daemon log');
  await p.settle('the answer they were waiting for');
  B.advance(402_000); // the wall passes
  B.RAW.length = 0;
  await g.flush();

  const texts = B.RAW.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  await t('★ the answer reaches Telegram once the wall clears', () =>
    ok(
      texts.some((x) => x.includes('the answer they were waiting for')),
      `nothing carrying the answer was flushed: ${JSON.stringify(texts)}`,
    ));
  await t('★ and no "⏳ fetching…" lands above it', () =>
    ok(
      !texts.some((x) => x === fetchingLine('the daemon log')),
      `the stale placeholder was flushed after all: ${JSON.stringify(texts)}`,
    ));
  await t('what they read is the throttle header and the answer, in that order', () => {
    eq(texts.length, 2, `flushed ${texts.length} messages: ${JSON.stringify(texts)}`);
    ok(/Telegram throttled/.test(texts[0]), `the header is not first: ${texts[0]}`);
  });
}

// ---- the sites -------------------------------------------------------------
await t('★ exactly four opening placeholders ask for the skip, and each is null-safe', () => {
  const lines = [];
  SRC.forEach((l, i) => {
    if (/opening: true/.test(l)) lines.push(i + 1);
  });
  // pendingMessage, the Claude chat bubble, the Codex exec bubble, the Codex
  // app-server bubble. The background worker line is deliberately NOT here: it
  // is the reader's only handle on a job measured in tens of minutes, it stays
  // true for the whole of a wall, and it was chosen over silence on 2026-09-19.
  // If this count moves, a site was added or removed without being judged.
  eq(lines.length, 4, `opening: true at lines ${lines.join(', ')}`);
  for (const n of lines) {
    const window = SRC.slice(n - 1, n + 2).join('\n');
    ok(
      /\?\.message_id|\.catch\(\(\) => null\)/.test(window),
      `line ${n} takes the id off a possibly-null return without optional chaining:\n${window}`,
    );
  }
});

await t('★ the limit line degrades to a send when the bubble was skipped', () => {
  const src = SRC.join('\n');
  // The one terminal path that ASSUMED a bubble: `limitPlan.line` is the only
  // report of a walled account on the rotate-and-retry route, and the dispatch
  // arm below it sends nothing on purpose. Guarded by `progressMsgId != null`
  // it vanished entirely whenever the bubble did.
  ok(
    /if \(limitPlan\?\.line\) \{/.test(src),
    'the limit arm is guarded by the bubble again, so a skipped opening loses the whole report',
  );
  ok(/await send\(limitPlan\.line, \{ markdown: false \}\)/.test(src), 'it must degrade to a plain send');
});

await t('the skip is decided by the WALL, not by the bucket', () => {
  const tgSrc = grab('tg');
  ok(/if \(opening && g\.coolingDown\(\)\)/.test(tgSrc), 'the pre-gate check must read the cooldown, not the tokens');
  ok(!/opening && .*acquire/.test(tgSrc), 'bucket pressure must never skip a placeholder');
});

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n` + failures.map((f) => `  - ${f}`).join('\n'));
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\n${pass} passed, 0 failed`);
console.log('✅ all progress-priority tests pass');
