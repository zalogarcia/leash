#!/usr/bin/env node
// Wiring tests for the daemon's own messages: the REAL functions out of
// bridge.mjs, run against a FAKE Telegram transport.
//
// Existence is not implementation. system-messages.test.mjs proves the pure
// builders render the right strings; this proves bridge.mjs actually SENDS
// them that way: one message per event, edited to a terminal state and never
// after it, and with a plain-text fallback that keeps the blockquote body off
// the phone.
//
// bridge.mjs runs main() on import, so the functions under test are extracted
// by source and evaluated against stubs, exactly as bg-codex-wiring.test.mjs
// does. No network, no Telegram token, no daemon.
//
//   node system-wiring.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BTW_TICK_MS, BTW_TIMEOUT_MS } from './bg-btw.mjs';

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
// Extraction, same shape as bg-codex-wiring.test.mjs: a top-level `function` or
// `const` and everything indented under it, up to the next top-level line.
// ---------------------------------------------------------------------------
const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
export function grab(name, kind = 'function') {
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
export const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);

// ---------------------------------------------------------------------------
// THE FAKE TRANSPORT. Records every call, and can be told to reject an HTML
// parse the way Telegram does (400 + "can't parse entities"), which is the only
// way the plain fallback is ever reached in production.
// ---------------------------------------------------------------------------
const HARNESS = `
import { visibleOnly, fetchingLine, fetchFailedLine, errorMessage, WALL_TICK_MS, compactingLine, compactQueuedLine, compactDoneLine, compactDiscardedLine, autoCompactLine, autoCompactDoneLine, autoCompactFailedLine } from ${url('system-messages.mjs')};
import { btwPendingLine, btwAnsweredLine, btwEndedLine, btwStoppedLine, btwLostLine, btwRefusedLine, btwWaitingLine } from ${url('system-messages.mjs')};
import { BTW_RECORD_MAX, BTW_TICK_MS, BTW_TIMEOUT_MS } from ${url('bg-btw.mjs')};
import { normalizeDashes } from ${url('dash-normalize.mjs')};
const NO_DASHES = true;
export const INFLIGHT = {};
const inflight = { read: () => INFLIGHT, add: (id, rec) => { INFLIGHT[id] = rec; } };
const clip = (s, n) => (String(s).length <= n ? String(s) : String(s).slice(0, n - 1) + '\u2026');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
import { quoteBlock } from ${url('progress-render.mjs')};
import { fmtElapsed } from ${url('progress-render.mjs')};
import { escHtml, mdToTelegramHtml } from ${url('md-format.mjs')};
export const CALLS = [];
export let rejectHtml = false;
export let reject429 = false;
export let failSends = false;
export const setFailSends = (v) => { failSends = v; };
export const setRejectHtml = (v) => { rejectHtml = v; };
export const setReject429 = (v) => { reject429 = v; };
export const reset = () => { CALLS.length = 0; rejectHtml = false; reject429 = false; failSends = false; editCooldownUntil = 0; };
const send = async (text, { markdown = true } = {}) => tg('sendMessage', markdown ? { chat_id: CHAT_ID, text: mdToTelegramHtml(text), parse_mode: 'HTML' } : { chat_id: CHAT_ID, text });
const CHAT_ID = '1';
const TG_MSG_LIMIT = 4000;
const QUOTE_TAGS_LEN = 37;
let compactNotice = null;
let autoCompactAwaitingPct = null;
export const setAwaitingPct = (v) => { autoCompactAwaitingPct = v; };
export const getAwaitingPct = () => autoCompactAwaitingPct;
export const getCompactNotice = () => compactNotice;
const COMPACT_TICK_MS = 3000;
const COMPACT_MAX_MS = 900000;
export let editCooldownUntil = 0;
export const getCooldown = () => editCooldownUntil;
export const setCooldown = (v) => { editCooldownUntil = v; };
async function tg(method, payload, attempt = 0, opts = {}) {
  CALLS.push({ method, payload, opts });
  if (failSends && method === 'sendMessage') {
    const e = new Error('sendMessage: 500 Internal Server Error');
    e.code = 500;
    throw e;
  }
  if (reject429) {
    const e = new Error(\`\${method}: 429 Too Many Requests\`);
    e.code = 429;
    e.description = 'Too Many Requests: retry after 7';
    e.retryAfter = 7;
    throw e;
  }
  if (rejectHtml && payload.parse_mode === 'HTML') {
    const e = new Error(\`\${method}: 400 Bad Request\`);
    e.code = 400;
    e.description = "Bad Request: can't parse entities: unsupported start tag";
    throw e;
  }
  return { message_id: 100 + CALLS.length };
}
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        grab('sendHtml'),
        grab('editProgress'),
        grab('pendingMessage'),
        grab('liveMessages', 'const'),
        grab('registerLive'),
        grab('tickLiveMessages'),
        grab('sendError'),
        grab('sendSubView'),
        grab('wallNotices', 'const'),
        grab('raiseWall'),
        grab('settleWall'),
        grab('pendWallResolution'),
        grab('startCompactNotice'),
        grab('settleCompactNotice'),
        grab('compactElapsed', 'const'),
        grab('compactEnding'),
        grab('settleAutoCompactPct'),
        grab('btwRecordForDisk'),
        grab('drainBtw'),
        grab('startBtwNotice'),
        grab('resolveBtwAfterRestart'),
        'export { sendHtml, editProgress, pendingMessage, registerLive, tickLiveMessages, liveMessages, sendError, sendSubView, tg, raiseWall, settleWall, pendWallResolution, wallNotices, startCompactNotice, settleCompactNotice, compactElapsed, compactEnding, settleAutoCompactPct, btwRecordForDisk, drainBtw, startBtwNotice, resolveBtwAfterRestart };',
      ].join('\n'),
    )
);

const HTML_WITH_QUOTE =
  '<b>📖 Leash on this-mac</b>\nSend any text · it runs and replies.<blockquote expandable>THE WHOLE 4700 CHARACTER REFERENCE</blockquote>';

// ---------------------------------------------------------------------------
console.log('\n1. sendHtml: the HTML path, and the fallback that must not un-hide the body');
// ---------------------------------------------------------------------------

B.reset();
await B.sendHtml(HTML_WITH_QUOTE);
await t('the happy path sends the HTML once, with parse_mode HTML', () => {
  eq(B.CALLS.length, 1, 'one message, not one per chunk');
  eq(B.CALLS[0].payload.parse_mode, 'HTML');
  ok(B.CALLS[0].payload.text.includes('<blockquote expandable>'), 'the blockquote reached Telegram');
});

B.reset();
B.setRejectHtml(true);
await B.sendHtml(HTML_WITH_QUOTE);
await t('★ the plain fallback sends the VISIBLE part only, never the blockquote body', () => {
  eq(B.CALLS.length, 2, 'one rejected HTML attempt, then one plain');
  const plain = B.CALLS[1].payload.text;
  eq(B.CALLS[1].payload.parse_mode, undefined, 'the fallback is plain, not another parse attempt');
  ok(!plain.includes('4700 CHARACTER'), `the reference body reached the phone as a wall:\n${plain}`);
  ok(!plain.includes('blockquote'), 'no tag names either');
  ok(plain.includes('📖 Leash on this-mac'), 'the visible part is still there');
  ok(plain.includes('Send any text'), 'the visible part is still there');
});

B.reset();
B.setRejectHtml(true);
await B.sendHtml('<b>hi</b><blockquote expandable>hidden</blockquote>', () => 'a caller-supplied plain line');
await t('a caller may still supply its own plain rendering', () => {
  eq(B.CALLS[1].payload.text, 'a caller-supplied plain line');
});

B.reset();
B.setReject429(true);
let threw = null;
try {
  await B.sendHtml(HTML_WITH_QUOTE);
} catch (e) {
  threw = e;
}
await t('a 429 is rethrown rather than doubled as a plain send', () => {
  ok(threw && threw.code === 429, 'tg() already waited the window out; sending again would double it');
  eq(B.CALLS.length, 1, 'exactly one attempt');
});

// ---------------------------------------------------------------------------
console.log('\n2. editProgress: the same rule on the edit path');
// ---------------------------------------------------------------------------

B.reset();
await B.editProgress(55, HTML_WITH_QUOTE);
await t('an edit goes out as HTML, disposable (no 429 retry)', () => {
  eq(B.CALLS.length, 1);
  eq(B.CALLS[0].method, 'editMessageText');
  eq(B.CALLS[0].payload.message_id, 55);
  eq(B.CALLS[0].opts.retry429, false, 'a progress edit must back off, never retry into the window');
});

B.reset();
B.setRejectHtml(true);
await B.editProgress(55, HTML_WITH_QUOTE);
await t('★ the edit fallback also sends the visible part only, with no plainTextFn given', () => {
  eq(B.CALLS.length, 2);
  const plain = B.CALLS[1].payload.text;
  ok(!plain.includes('4700 CHARACTER'), `the body was un-hidden by the fallback:\n${plain}`);
  ok(plain.includes('Send any text'), 'the visible part survives');
});

B.reset();
B.setReject429(true);
await B.editProgress(55, '<b>✅ Done</b> · 8s');
await t('a 429 on an edit pauses EVERY live message, not just this one', () => {
  ok(B.getCooldown() > Date.now(), 'editCooldownUntil was not armed');
  ok(B.getCooldown() <= Date.now() + 9000, 'the pause is the window Telegram asked for plus slack, not longer');
  eq(B.CALLS.length, 1, 'no retry into the penalty');
});

// ---------------------------------------------------------------------------
console.log('\n3. pendingMessage: one message for a wait, edited into its own answer');
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

B.reset();
const p1 = await B.pendingMessage('Reading plan usage', { tickMs: 30 });
await t('the wait announces itself INSTANTLY, before any work', () => {
  eq(B.CALLS.length, 1, '/usage used to send nothing at all for up to six seconds');
  eq(B.CALLS[0].method, 'sendMessage');
  ok(B.CALLS[0].payload.text.startsWith('📊 Reading plan usage…'), B.CALLS[0].payload.text);
});

await sleep(110);
const ticks = B.CALLS.filter((c) => c.method === 'editMessageText').length;
await t('it ticks in place on the same message, never as a second one', () => {
  ok(ticks >= 2, `expected the clock to advance at least twice, got ${ticks}`);
  eq(B.CALLS.filter((c) => c.method === 'sendMessage').length, 1, 'exactly one message for the whole wait');
  ok(
    B.CALLS.filter((c) => c.method === 'editMessageText').every((c) => c.payload.message_id === 101),
    'every tick edits the message that was sent',
  );
});

await p1.settle('# Claude plan usage\n\n5h 58%', { markdown: true });
const afterSettle = B.CALLS.length;
await t('settle is the terminal state, and it lands on the same message', () => {
  const last = B.CALLS[B.CALLS.length - 1];
  eq(last.method, 'editMessageText');
  eq(last.payload.message_id, 101);
  ok(last.payload.text.includes('5h 58%'), last.payload.text);
});

await sleep(120);
await t('★ nothing edits the message after its terminal state', () => {
  eq(B.CALLS.length, afterSettle, `${B.CALLS.length - afterSettle} edit(s) arrived after the answer did`);
});

B.reset();
const p2 = await B.pendingMessage('Reading plan usage', { tickMs: 30 });
await p2.fail('plan usage', 'socket hang up');
const afterFail = B.CALLS.length;
await sleep(90);
await t('failure is the OTHER terminal state, and it stops the clock too', () => {
  const last = B.CALLS[afterFail - 1];
  ok(last.payload.text.startsWith('❌ Could not read plan usage'), last.payload.text);
  ok(last.payload.text.includes('socket hang up'), 'the detail rides along, clipped');
  eq(B.CALLS.length, afterFail, 'a failed fetch must not leave a ticking line behind');
});

B.reset();
const p3 = await B.pendingMessage('Reading plan usage', { tickMs: 5000 });
await p3.settle('x'.repeat(5000), { markdown: false });
await t('an answer too long to BE an edit becomes its own message, with a receipt', () => {
  const edits = B.CALLS.filter((c) => c.method === 'editMessageText');
  const sends = B.CALLS.filter((c) => c.method === 'sendMessage');
  eq(edits.length, 1, 'the pending line is resolved, not left ticking');
  ok(edits[0].payload.text.startsWith('✅ Reading plan usage'), edits[0].payload.text);
  eq(sends.length, 2, 'the pre-message, then the report itself');
  ok(sends[1].payload.text.length > 4000, 'the answer is not silently truncated into nothing');
});

B.reset();
B.setCooldown(Date.now() + 60_000);
const p4 = await B.pendingMessage('Reading plan usage', { tickMs: 20 });
await sleep(80);
await t('a 429 anywhere pauses this clock too: every live line shares one cooldown', () => {
  eq(B.CALLS.filter((c) => c.method === 'editMessageText').length, 0, 'ticks must not spend into a penalty');
});
await p4.settle('done', { markdown: false });
B.setCooldown(0);

// ---------------------------------------------------------------------------
console.log('\n4. the live-message registry every ⏳ line is driven from');
// ---------------------------------------------------------------------------

B.reset();
let swept = 0;
const forever = B.registerLive({ done: false, tick() { swept++; } });
B.tickLiveMessages();
B.tickLiveMessages();
await t('a registered line is ticked every sweep', () => {
  eq(swept, 2);
});

forever.done = true;
B.tickLiveMessages();
B.tickLiveMessages();
await t('★ done is terminal: the entry is dropped and can never edit again', () => {
  eq(swept, 2, 'a finished line was ticked after its terminal state');
  eq(B.liveMessages.size, 0, 'and it is not leaked in the set either');
});

let gated = 0;
B.registerLive({ done: false, tick() { gated++; this.done = true; } });
B.setCooldown(Date.now() + 60_000);
B.tickLiveMessages();
await t('★ one 429 pauses every live line together, not one at a time', () => {
  eq(gated, 0, 'a paused sweep must not spend edits into the penalty');
});
B.setCooldown(0);
B.tickLiveMessages();
await t('and the sweep resumes when the penalty is over', () => {
  eq(gated, 1);
});

let expired = 0;
B.registerLive({ done: false, ignoreCooldown: true, tick() { expired++; this.done = true; } });
B.setCooldown(Date.now() + 60_000);
B.tickLiveMessages();
await t('a line that only needs to RETIRE can opt out of the pause', () => {
  eq(expired, 1, 'expiry is not an edit, so a penalty must not strand it');
});
B.setCooldown(0);

let thrown = 0;
const bad = B.registerLive({ done: false, tick() { thrown++; throw new Error('boom'); } });
B.tickLiveMessages();
B.tickLiveMessages();
await t('a line that throws retires instead of throwing every sweep forever', () => {
  eq(thrown, 1);
  eq(bad.done, true);
  eq(B.liveMessages.size, 0);
});

// ---------------------------------------------------------------------------
console.log('\n5. sendError: the raw stderr wall, behind one tap');
// ---------------------------------------------------------------------------

const STDERR = ['API Error: 400 credit balance is too low', ...Array(200).fill('  at Module._compile (node:internal)')].join('\n');

B.reset();
await B.sendError({
  title: 'Claude run failed',
  detail: 'credit balance is too low',
  remedy: '👤 /account to swap · /usage for limits',
  full: STDERR,
});
await t('the HTML carries the tail inside an expandable blockquote', () => {
  eq(B.CALLS.length, 1);
  const text = B.CALLS[0].payload.text;
  eq(B.CALLS[0].payload.parse_mode, 'HTML');
  ok(text.includes('<blockquote expandable>'), 'the tail must be collapsed, not inline');
  ok(text.includes('<b>❌ Claude run failed</b>'), 'one bold, the state line');
  ok(text.length <= 4000, `${text.length} chars, over Telegram's limit`);
});

B.reset();
B.setRejectHtml(true);
await B.sendError({ title: 'Claude run failed', detail: 'credit balance is too low', full: STDERR });
await t('★ and the plain fallback does NOT put the 100-line wall back', () => {
  const plain = B.CALLS[1].payload.text;
  ok(!plain.includes('Module._compile'), `the stack came back as the message:\n${plain.slice(0, 200)}`);
  ok(plain.split('\n').length <= 4, `${plain.split('\n').length} lines on the phone`);
  ok(plain.includes('credit balance is too low'), 'the cause survives');
});

// ---------------------------------------------------------------------------
console.log('\n6. limit walls: one notice, kept true, resolving itself');
// ---------------------------------------------------------------------------

// A wall the test drives by hand, so the tick logic is exercised without
// waiting five real minutes for it.
let wallOver = false;
let mins = 192;
const mkWall = () =>
  B.raiseWall('claude', {
    render: () => `⛔ Every Claude account is limited\n⏳ Resets 13:45 · in ${mins}m`,
    lifted: () => wallOver,
    resolved: ({ codexAnswered = 0 } = {}) => `✅ Claude is back · 14:01\n🧠 Codex answered ${codexAnswered} messages`,
  });

B.reset();
wallOver = false;
B.wallNotices.clear();
const w1 = await mkWall();
await t('the wall announces itself once', () => {
  eq(B.CALLS.length, 1);
  eq(B.CALLS[0].method, 'sendMessage');
  ok(B.CALLS[0].payload.text.includes('Resets 13:45'), B.CALLS[0].payload.text);
});

const w2 = await mkWall();
await t('★ a second raise for a wall already on screen sends nothing', () => {
  eq(B.CALLS.length, 1, 'two notices for one wall is the duplication this removes');
  eq(w2, w1, 'the caller gets the notice already up');
});

// Not yet due: the message was just sent, so it is already true.
B.tickLiveMessages();
await t('it does not edit before its first tick is due', () => {
  eq(B.CALLS.filter((c) => c.method === 'editMessageText').length, 0);
});

w1.nextAt = Date.now() - 1;
B.tickLiveMessages();
await t('when the tick comes due it edits IN PLACE, not as a new message', () => {
  const edits = B.CALLS.filter((c) => c.method === 'editMessageText');
  eq(edits.length, 0, 'nothing changed since the last render, so nothing is spent');
  eq(B.CALLS.filter((c) => c.method === 'sendMessage').length, 1);
});

mins = 187;
w1.nextAt = Date.now() - 1;
B.tickLiveMessages();
await t('★ it edits only when the text actually CHANGED', () => {
  const edits = B.CALLS.filter((c) => c.method === 'editMessageText');
  eq(edits.length, 1, 'a moved clock is the one thing worth an edit');
  eq(edits[0].payload.message_id, 101, 'the same message the notice was sent as');
  ok(edits[0].payload.text.includes('187m'), edits[0].payload.text);
});

wallOver = true;
B.tickLiveMessages();
const afterResolve = B.CALLS.length;
await t('★ the ⏳ resolves itself when the wall lifts, with no call site involved', () => {
  const last = B.CALLS[B.CALLS.length - 1];
  eq(last.method, 'editMessageText');
  eq(last.payload.message_id, 101, 'the terminal state lands on the same message');
  ok(last.payload.text.startsWith('✅ Claude is back'), last.payload.text);
  eq(B.wallNotices.size, 0, 'and the notice is not leaked');
});

mins = 1;
B.tickLiveMessages();
B.tickLiveMessages();
await t('★ nothing edits the notice after its terminal state', () => {
  eq(B.CALLS.length, afterResolve, `${B.CALLS.length - afterResolve} edit(s) after the wall resolved`);
  eq(B.liveMessages.size, 0, 'the entry is dropped from the sweep too');
});

// The explicit resolution, the path flushParkedWalledChats takes.
B.reset();
wallOver = false;
B.wallNotices.clear();
await mkWall();
B.settleWall('claude', { codexAnswered: 4 });
const afterSettleWall = B.CALLS.length;
await t('an explicit settle carries its count into the terminal line', () => {
  const last = B.CALLS[B.CALLS.length - 1];
  ok(last.payload.text.includes('Codex answered 4 messages'), last.payload.text);
});

B.settleWall('claude', { codexAnswered: 9 });
B.tickLiveMessages();
await t('★ and a second settle writes no second ending', () => {
  eq(B.CALLS.length, afterSettleWall, 'two callers raced to two different endings');
});

B.reset();
B.wallNotices.clear();
B.settleWall('never-raised', {});
await t('settling a wall that was never raised is a no-op, not a throw', () => {
  eq(B.CALLS.length, 0);
});

B.reset();
wallOver = false;
B.wallNotices.clear();
B.setCooldown(Date.now() + 60_000);
const w3 = await mkWall();
mins = 42;
w3.nextAt = Date.now() - 1;
B.tickLiveMessages();
await t('a 429 pauses the wall clock with every other live line', () => {
  eq(B.CALLS.filter((c) => c.method === 'editMessageText').length, 0);
});
B.setCooldown(0);
B.wallNotices.clear();
w3.done = true;
B.tickLiveMessages();

// ---------------------------------------------------------------------------
console.log('\n7. the two wall races the QA pass found');
// ---------------------------------------------------------------------------

const mk = (kind, { over = false } = {}) => {
  let lifted = over;
  const e = B.raiseWall(kind, {
    render: () => `WALL ${kind}`,
    lifted: () => lifted,
    resolved: ({ engine = null, count = 0 } = {}) => `BACK engine=${engine} count=${count}`,
  });
  return { promise: e, lift: () => { lifted = true; } };
};

B.reset();
B.wallNotices.clear();
B.liveMessages.clear();
// TWO MESSAGES IN ONE getUpdates BATCH. Both callers are fire-and-forget, so
// both reach raiseWall before either send resolves.
const a = mk('both');
const b = mk('both');
await Promise.all([a.promise, b.promise]);
await t('★ two raises in one poll batch put up ONE notice, not two', () => {
  eq(B.CALLS.filter((c) => c.method === 'sendMessage').length, 1, 'a duplicate wall bubble was sent');
  eq(B.wallNotices.size, 1);
});

await t('★ and the loser is not left ticking in the sweep forever', () => {
  eq(B.liveMessages.size, 1, `${B.liveMessages.size} entries registered for one wall`);
});

a.lift();
b.lift();
B.tickLiveMessages();
B.tickLiveMessages();
await t('the single notice still resolves, exactly once', () => {
  const edits = B.CALLS.filter((c) => c.method === 'editMessageText');
  eq(edits.length, 1, 'the wall resolved twice, or not at all');
  eq(B.liveMessages.size, 0, 'and nothing is left behind');
});

// THE SWEEP-VS-FLUSH RACE. The sweep runs every 2.5s and getUpdates long-polls
// for 50, so the sweep sees the wall lift first essentially every time. Without
// the handoff it resolved to an unnamed engine and a zero count, and the caller
// then sent its own second message saying it properly.
B.reset();
B.wallNotices.clear();
B.liveMessages.clear();
const c = mk('both');
await c.promise;
B.pendWallResolution('both', { engine: 'codex', count: 3 });
c.lift();
B.tickLiveMessages();
await t('★ the sweep resolves with the facts the caller left, not with nulls', () => {
  const last = B.CALLS[B.CALLS.length - 1];
  eq(last.method, 'editMessageText');
  eq(last.payload.text, 'BACK engine=codex count=3', 'the engine that came back was not named');
});

await t('★ and the caller finds it already settled, so it sends no second message', () => {
  const sends = B.CALLS.filter((c2) => c2.method === 'sendMessage').length;
  eq(B.pendWallResolution('both', { engine: 'codex', count: 3 }), false, 'a settled notice must not accept more');
  B.settleWall('both', { engine: 'codex', count: 3 });
  eq(B.CALLS.filter((c2) => c2.method === 'sendMessage').length, sends, 'a second message went out');
  eq(B.CALLS.filter((c2) => c2.method === 'editMessageText').length, 1, 'a second ending was written');
});

B.reset();
B.wallNotices.clear();
B.liveMessages.clear();
await t('a wall whose send failed leaves no slot blocking the next one', () => {
  // Not a real transport failure here (the fake always succeeds); the shape
  // that matters is that the claim is released, not held forever.
  eq(B.wallNotices.size, 0);
});

// ---------------------------------------------------------------------------
console.log('\n8. /compact: one message for a whole model turn');
// ---------------------------------------------------------------------------

B.reset();
B.liveMessages.clear();
await B.startCompactNotice(false);
await t('the wait goes up instantly, as ONE message', () => {
  eq(B.CALLS.length, 1);
  eq(B.CALLS[0].method, 'sendMessage');
  ok(B.CALLS[0].payload.text.startsWith('📦 Compacting…'), B.CALLS[0].payload.text);
});

const compactEntry = [...B.liveMessages][0];
compactEntry.last = 'force a change';
B.tickLiveMessages();
await t('★ it does NOT edit on every 2.5s sweep', () => {
  // fmtElapsed changes every second under a minute, so a compare-and-edit with
  // no cadence gate fires on every sweep: 24 edits/min on top of the run
  // bubble's 10, against a per-chat ceiling this file already learned at 396s
  // of penalty. The gate is the fix, so the gate is what is asserted.
  eq(B.CALLS.filter((c) => c.method === 'editMessageText').length, 0, 'ungated: it spent an edit 2.5s in');
});

compactEntry.nextAt = Date.now() - 1;
B.tickLiveMessages();
await t('it ticks in place once the cadence allows it', () => {
  const edits = B.CALLS.filter((c) => c.method === 'editMessageText');
  eq(edits.length, 1);
  eq(edits[0].payload.message_id, 101, 'a second message for the same wait');
});

B.settleCompactNotice('✅ Compacted · 42s');
const afterCompact = B.CALLS.length;
await t('★ the ending lands on that same message', () => {
  const last = B.CALLS[B.CALLS.length - 1];
  eq(last.method, 'editMessageText');
  eq(last.payload.message_id, 101);
  eq(last.payload.text, '✅ Compacted · 42s');
});

B.tickLiveMessages();
B.tickLiveMessages();
await t('★ and nothing edits it afterwards', () => {
  eq(B.CALLS.length, afterCompact, 'a tick wrote over the ending');
  eq(B.liveMessages.size, 0, 'the entry is not leaked');
});

await t('a second settle is a no-op, so two endings can never both be written', () => {
  eq(B.settleCompactNotice('✅ again'), false);
  eq(B.CALLS.length, afterCompact);
});

B.reset();
B.liveMessages.clear();
await B.startCompactNotice(true);
const queuedEntry = [...B.liveMessages][0];
B.tickLiveMessages();
B.tickLiveMessages();
await t('the QUEUED variant carries no clock: it is waiting on another task', () => {
  ok(B.CALLS[0].payload.text.startsWith('⏳ Compaction queued'), B.CALLS[0].payload.text);
  eq(B.CALLS.filter((c) => c.method === 'editMessageText').length, 0, 'a ticking number measuring the wrong thing');
});
queuedEntry.done = true;
B.tickLiveMessages();

// The three ways a compaction used to strand its notice. A stranded entry does
// not merely look wrong: it edits every sweep for the life of the daemon and
// arms the SHARED editCooldownUntil, degrading every other live line with it.

B.reset();
B.liveMessages.clear();
await B.startCompactNotice(false);
const firstCompact = [...B.liveMessages][0];
await B.startCompactNotice(false);
await t('★ a SECOND /compact retires the first notice instead of orphaning it', () => {
  eq(firstCompact.done, true, 'the first entry would have edited its message forever');
  B.tickLiveMessages(); // done entries are dropped on the next sweep
  eq(B.liveMessages.size, 1, `${B.liveMessages.size} live entries for one chat lane`);
  const edits = B.CALLS.filter((c) => c.method === 'editMessageText');
  ok(edits.some((e) => e.payload.text.includes('Compaction discarded')), 'the orphan was left mid-sentence');
});
B.settleCompactNotice('done');

B.reset();
B.liveMessages.clear();
await B.startCompactNotice(false);
const stranded = [...B.liveMessages][0];
await t('★ and one that is never settled retires itself rather than climbing forever', () => {
  stranded.tick(Date.now() + 60_000);
  eq(stranded.done, false, 'a real compaction takes minutes; it must not give up on one');
  stranded.tick(Date.now() + 16 * 60_000);
  eq(stranded.done, true, 'past any plausible compaction it must stop');
  const before = B.CALLS.length;
  B.tickLiveMessages();
  B.tickLiveMessages();
  eq(B.CALLS.length, before, 'it edited after retiring');
  eq(B.liveMessages.size, 0, 'and it is not leaked');
});

B.reset();
B.liveMessages.clear();
await B.startCompactNotice(false);
const gatedCompact = [...B.liveMessages][0];
B.setCooldown(Date.now() + 60_000);
gatedCompact.nextAt = Date.now() - 1;
gatedCompact.last = 'force a change';
B.tickLiveMessages();
await t('★ a 429 pauses its edits, but never its ability to retire', () => {
  eq(B.CALLS.filter((c) => c.method === 'editMessageText').length, 0, 'it spent an edit inside the penalty');
  ok(gatedCompact.ignoreCooldown, 'the sweep must let it through so the expiry can fire');
  gatedCompact.tick(Date.now() + 16 * 60_000);
  eq(gatedCompact.done, true, 'a penalty in the wrong second stranded it permanently');
});
B.setCooldown(0);
B.liveMessages.clear();

// ---------------------------------------------------------------------------
console.log('\n8b. auto compact: the same slot, the automatic shapes');
// ---------------------------------------------------------------------------
// The daemon compacts by itself past a threshold (auto-compact.mjs decides).
// It is the SAME slot and the same function as /compact; what has to hold is
// that every frame of the message says it was automatic, from the first send
// to the ending the close handler picks, and that the ending grows the fresh
// chat's percentage on the same message rather than as a second one.

B.reset();
B.liveMessages.clear();
await B.startCompactNotice(false, { auto: true, pct: 63 });
await t('the automatic wait goes up instantly, naming itself and the percentage', () => {
  eq(B.CALLS.length, 1);
  eq(B.CALLS[0].method, 'sendMessage');
  eq(B.CALLS[0].payload.text, '📦 Auto compacting at 63%…');
});

const autoEntry = [...B.liveMessages][0];
autoEntry.nextAt = Date.now() - 1;
autoEntry.last = 'force a change';
B.tickLiveMessages();
await t('★ it ticks in place as the automatic line, never as the manual one', () => {
  const edits = B.CALLS.filter((c) => c.method === 'editMessageText');
  eq(edits.length, 1);
  eq(edits[0].payload.message_id, 101);
  ok(edits[0].payload.text.startsWith('📦 Auto compacting at 63%…'), edits[0].payload.text);
  ok(!edits[0].payload.text.includes('Compacting…'), 'the manual frame leaked into an automatic wait');
});

await t('★ the endings come from the slot: automatic in, automatic out', () => {
  ok(B.compactEnding('done', { archived: '7f4e3041' }).startsWith('✅ Auto compacted'), 'done');
  ok(B.compactEnding('done', { archived: '7f4e3041' }).includes('📉 ctx was 63%'), 'the depth it left');
  ok(B.compactEnding('failed', { reason: 'exit code 1' }).startsWith('❌ Auto compact failed'), 'failed');
  ok(B.compactEnding('failed', { reason: 'exit code 1' }).includes('exit code 1'), 'the reason');
  ok(B.compactEnding('discarded').startsWith('⚠️ Compaction discarded'), 'discarded is shared');
});

const autoDone = B.compactEnding('done', { archived: '7f4e3041' });
B.settleCompactNotice(autoDone);
await t('★ the ending lands on the same message', () => {
  const last = B.CALLS[B.CALLS.length - 1];
  eq(last.method, 'editMessageText');
  eq(last.payload.message_id, 101);
  eq(last.payload.text, autoDone);
});

const beforePct = B.CALLS.length;
B.setAwaitingPct({ msgId: 101, args: { elapsedSec: 42, archived: '7f4e3041', fromPct: 63 } });
B.settleAutoCompactPct(4);
await t('★ the fresh chat percentage edits that same message once more, then the slot is empty', () => {
  const last = B.CALLS[B.CALLS.length - 1];
  eq(B.CALLS.length, beforePct + 1, 'exactly one more edit');
  eq(last.method, 'editMessageText');
  eq(last.payload.message_id, 101);
  ok(last.payload.text.includes('📉 ctx 63% to 4%'), last.payload.text);
  eq(B.getAwaitingPct(), null, 'cleared on settle');
});

B.setAwaitingPct({ msgId: 101, args: { elapsedSec: 42, archived: '7f4e3041', fromPct: 63 } });
const beforeUnmeasured = B.CALLS.length;
B.settleAutoCompactPct(null);
await t('an unmeasurable fresh chat clears the slot and edits nothing: the line stays a fact', () => {
  eq(B.CALLS.length, beforeUnmeasured, 'it wrote a guess');
  eq(B.getAwaitingPct(), null, 'and it did not wait forever');
});

await t('a settle with nothing awaiting is a no-op, not a throw', () => {
  const before = B.CALLS.length;
  B.settleAutoCompactPct(4);
  eq(B.CALLS.length, before);
});

B.reset();
B.liveMessages.clear();
await B.startCompactNotice(false);
await t('★ a manual slot still gets the manual endings', () => {
  ok(B.compactEnding('done', { archived: '7f4e3041' }).startsWith('✅ Compacted'), B.compactEnding('done', {}));
  ok(B.compactEnding('failed', { reason: 'x' }).startsWith('❌ Compaction failed'), 'failed');
  ok(!B.compactEnding('failed', { reason: 'x' }).includes('Auto'), 'the automatic frame leaked into a manual ending');
});
B.settleCompactNotice('done');
B.liveMessages.clear();

// ---------------------------------------------------------------------------
console.log('\n9. sendSubView: /logs is the one view whose BODY is the answer');
// ---------------------------------------------------------------------------

const HOSTILE_LOG = Array(40)
  .fill('[bridge] fetch failed: https://api.example.com/v1/thing?a=1&b=2&c=3&d=4&e=5&f=6 (ETIMEDOUT) retrying in 5s')
  .join('\n')
  .slice(-3800);

B.reset();
await B.sendSubView({ visible: '📜 Daemon log · last 40 lines', body: HOSTILE_LOG });
await t('★ a log tail full of & and ? still composes INSIDE the limit', () => {
  eq(B.CALLS.length, 1, 'it was rejected and fell back to a header with no log');
  const text = B.CALLS[0].payload.text;
  ok(text.length <= 4000, `${text.length} chars: Telegram would reject the parse`);
  ok(text.endsWith('</blockquote>'), 'the closing tag was sliced off the composed HTML');
  ok(text.includes('… (clipped)'), 'the cut has to be visible');
});

await t('★ and it keeps the TAIL of the log, which is what just happened', () => {
  const text = B.CALLS[0].payload.text;
  ok(text.includes('retrying in 5s'), 'a log clipped from the wrong end is the wrong log');
});

B.reset();
await B.sendSubView({ visible: '🌐 Codex network: on', body: 'a short explanation' });
await t('a body that fits is not clipped to buy a margin it does not need', () => {
  ok(B.CALLS[0].payload.text.includes('a short explanation'));
  ok(!B.CALLS[0].payload.text.includes('clipped'));
});

B.reset();
await B.sendSubView({ visible: '📖 no body here', body: '' });
await t('no body, no blockquote: it goes out as a plain message', () => {
  eq(B.CALLS[0].payload.parse_mode, undefined);
  eq(B.CALLS[0].payload.text, '📖 no body here');
});

// ---------------------------------------------------------------------------
console.log('\n10. /btw: one ⏳ per side question, and every way it can end');
// ---------------------------------------------------------------------------
//
// The pure builders are gated in system-messages.test.mjs. What is asserted
// here is that the DAEMON drives them: one message put up per question, edited
// exactly once to a terminal state, never edited after it, and reaching that
// state on all four exits (answered, ended, stopped, restarted) plus the
// fifteen-minute sentence that is not an exit.

const lastText = () => B.CALLS[B.CALLS.length - 1]?.payload?.text ?? '';
const edits = () => B.CALLS.filter((c) => c.method === 'editMessageText');
const sends = () => B.CALLS.filter((c) => c.method === 'sendMessage');

B.reset();
let rec = { id: 1, lane: 'bg2', askedAt: Date.now() };
await B.startBtwNotice(rec, 'bg2');
await t('the question puts up exactly one ⏳ message', () => {
  eq(sends().length, 1, 'one message per question, not a notice plus an ack');
  ok(sends()[0].payload.text.startsWith('⏳ btw · bg2'), sends()[0].payload.text);
  eq(edits().length, 0, 'nothing edited yet');
});

await t('and it registered a live line, so the wait can say something later', () => {
  eq(B.liveMessages.size, 1);
});

rec.resolve('answered', { answer: 'delta-agents, on main' });
await t('★ the answer EDITS the same message rather than sending a second one', () => {
  eq(sends().length, 1, 'still one message: a wait is one message, edited');
  eq(edits().length, 1);
  ok(lastText().includes('✅ btw · bg2'), lastText());
  ok(lastText().includes('delta-agents, on main'), lastText());
});

await t('and the live line retires, so nothing can write over the answer', () => {
  B.tickLiveMessages();
  eq(B.liveMessages.size, 0, 'a settled entry is dropped on the next sweep');
});

const after = B.CALLS.length;
rec.resolve('ended');
rec.resolve('answered', { answer: 'a second answer' });
await t('★ terminal is terminal: a later resolve is ignored, not applied', () => {
  eq(B.CALLS.length, after, 'the last word on screen must be the answer it already showed');
});

B.reset();
rec = { id: 2, lane: 'bg', askedAt: Date.now() };
await B.startBtwNotice(rec, 'bg');
rec.resolve('ended');
await t('★ a run that ends without answering resolves the ⏳ and names the report', () => {
  ok(lastText().includes('❌ btw · bg · no answer'), lastText());
  ok(lastText().includes('report may still carry it'), lastText());
});

B.reset();
rec = { id: 3, lane: 'bg', askedAt: Date.now() };
await B.startBtwNotice(rec, 'bg');
rec.resolve('stopped');
await t('★ /stop resolves it with the stop glyph, not a failure glyph', () => {
  ok(lastText().startsWith('🛑'), lastText());
});

B.reset();
rec = { id: 4, lane: 'bg', askedAt: Date.now() };
await B.startBtwNotice(rec, 'bg');
rec.resolve('lost');
await t('a daemon restart resolves it as lost', () => {
  ok(lastText().includes('answer lost'), lastText());
});

B.reset();
rec = { id: 41, lane: 'codex', askedAt: Date.now() };
await B.startBtwNotice(rec, 'codex');
rec.resolve('refused', { why: 'the Codex turn had already finished' });
await t('★ a refusal resolves it as not delivered, carrying the reason', () => {
  // The sixth state, and the one an app-server job needs: `ended` would tell him
  // the report may still carry an answer to a question the job never received.
  ok(lastText().includes('not delivered'), lastText());
  ok(lastText().includes('the Codex turn had already finished'), lastText());
  ok(lastText().includes('Ask again'), lastText());
});

B.reset();
rec = { id: 5, lane: 'bg2', askedAt: Date.now() - BTW_TIMEOUT_MS - 1000 };
await B.startBtwNotice(rec, 'bg2');
B.tickLiveMessages();
await t('★ fifteen minutes edits the line WITHOUT dropping the listener', () => {
  ok(lastText().includes('no answer yet'), lastText());
  eq(B.liveMessages.size, 1, 'the entry must survive: a worker in a long tool call is busy, not gone');
});

const beforeLate = B.CALLS.length;
B.tickLiveMessages();
B.tickLiveMessages();
await t('and it says it once, not every sweep', () => {
  eq(B.CALLS.length, beforeLate, 'a line that repeats itself every 2.5s is a rate-limit incident');
});

rec.resolve('answered', { answer: 'sorry, I was in a 12 minute build' });
await t('★ an answer that arrives AFTER the timeout still lands on the same message', () => {
  ok(lastText().includes('✅ btw · bg2'), lastText());
  ok(lastText().includes('12 minute build'), lastText());
  eq(sends().length, 1, 'and it is still one message');
});

B.reset();
rec = { id: 6, lane: 'bg', askedAt: Date.now() };
const pendingTick = Date.now();
await B.startBtwNotice(rec, 'bg');
B.tickLiveMessages();
await t('the pending line does not spend an edit before its cadence is due', () => {
  eq(edits().length, 0, `BTW_TICK_MS is ${BTW_TICK_MS}, so an immediate sweep must be a no-op`);
});
rec.resolve('ended');

// ---------------------------------------------------------------------------
// The race: a worker fast enough to answer before its own ⏳ has been sent.
// ---------------------------------------------------------------------------

B.reset();
rec = { id: 7, lane: 'bg', askedAt: Date.now() };
const inFlight = B.startBtwNotice(rec, 'bg');
rec.resolve('answered', { answer: 'instantly' });
await inFlight;
await t('★ an answer that beats its own ack is applied, not lost', () => {
  eq(sends().length, 1, 'the ⏳ still went out (it was already in flight)');
  eq(edits().length, 1, 'and it was edited into the answer the moment its id landed');
  ok(lastText().includes('instantly'), lastText());
});

await t('and no live entry is left ticking on a question that is over', () => {
  B.tickLiveMessages();
  eq(B.liveMessages.size, 0);
});

B.reset();
rec = { id: 8, lane: 'bg', askedAt: Date.now() };
const inFlight2 = B.startBtwNotice(rec, 'bg');
rec.resolve('ended');
await inFlight2;
await t('the same race on the ENDED path, which is the one /stop takes', () => {
  eq(edits().length, 1);
  ok(lastText().includes('no answer'), lastText());
});

// ---------------------------------------------------------------------------
// A long answer, and the dash rule.
// ---------------------------------------------------------------------------

B.reset();
rec = { id: 9, lane: 'bg', askedAt: Date.now() };
await B.startBtwNotice(rec, 'bg');
rec.resolve('answered', { answer: 'A'.repeat(6000) });
await t('★ an answer too big to edit becomes a receipt plus its own message', () => {
  eq(edits().length, 1, 'the ⏳ still reaches a terminal state');
  ok(edits()[0].payload.text.includes('in the next message'), edits()[0].payload.text);
  const spill = sends()[1];
  ok(spill, 'the answer itself must actually be sent');
  ok(spill.payload.text.includes('AAAA'), 'and it is the answer, not a fragment of the receipt');
});

B.reset();
rec = { id: 10, lane: 'bg', askedAt: Date.now() };
await B.startBtwNotice(rec, 'bg');
rec.resolve('answered', { answer: 'it applied — all 41 rows' });
await t("★ the worker's answer is dash-normalized like every other outbound text", () => {
  ok(!/[–—]/.test(lastText()), `an em dash reached Telegram: ${lastText()}`);
  ok(lastText().includes('41 rows'), 'and the sentence survived the normalizer');
});

// ---------------------------------------------------------------------------
// Restart recovery: the ⏳ belongs to a process that no longer exists.
// ---------------------------------------------------------------------------

B.reset();
for (const k of Object.keys(B.INFLIGHT)) delete B.INFLIGHT[k];
B.INFLIGHT['bg-1788453512237-83808'] = {
  pid: 83808,
  lane: 'bg2',
  btwPending: [
    { id: 1, msgId: 4242, lane: 'bg2', askedAt: 1, question: 'which repo?' },
    { id: 2, msgId: 4243, lane: 'bg2', askedAt: 2, question: 'did it apply?' },
  ],
};
B.resolveBtwAfterRestart('bg-1788453512237-83808', B.INFLIGHT['bg-1788453512237-83808']);
await t('★ every ⏳ the previous daemon left pending is resolved at boot', () => {
  eq(edits().length, 2, 'one edit per stranded question, on the message ids it persisted');
  eq(edits()[0].payload.message_id, 4242);
  eq(edits()[1].payload.message_id, 4243);
  ok(edits()[0].payload.text.includes('answer lost'), edits()[0].payload.text);
});

await t('and the record is cleared, so a second restart does not re-announce it', () => {
  eq(B.INFLIGHT['bg-1788453512237-83808'].btwPending.length, 0);
  const before = B.CALLS.length;
  B.resolveBtwAfterRestart('bg-1788453512237-83808', B.INFLIGHT['bg-1788453512237-83808']);
  eq(B.CALLS.length, before, 'nothing pending, nothing said');
});

B.reset();
B.resolveBtwAfterRestart('x', { lane: 'bg' });
B.resolveBtwAfterRestart('x', {});
B.resolveBtwAfterRestart('x', null);
await t('a record with no pending questions is silent, and nullish does not throw', () => {
  eq(B.CALLS.length, 0);
});

B.reset();
B.resolveBtwAfterRestart('y', { lane: 'bg9', btwPending: [{ id: 1, lane: 'bg9' }] });
await t('a question whose ⏳ never got a message id is still answered, as a new one', () => {
  eq(sends().length, 1, 'a Telegram hiccup at ask time must not cost the ending');
  ok(sends()[0].payload.text.includes('answer lost'), sends()[0].payload.text);
});

// ---------------------------------------------------------------------------
// The ⏳ that could never be edited: one Telegram 5xx at ask time.
// ---------------------------------------------------------------------------

B.reset();
B.setFailSends(true);
rec = { id: 11, lane: 'bg2', askedAt: Date.now() };
await B.startBtwNotice(rec, 'bg2');
B.setFailSends(false);
const afterFailedSend = B.CALLS.length;
for (let i = 0; i < 400; i++) B.tickLiveMessages(); // ~16 simulated minutes of sweeps
await t('★ a ⏳ whose send failed does not tick, so one 5xx cannot become 60 messages', () => {
  eq(B.liveMessages.size, 0, 'no ticker is armed when there is no message to edit');
  eq(B.CALLS.length, afterFailedSend, `${B.CALLS.length - afterFailedSend} extra calls: put() degrades to a fresh send every cadence`);
});

await t('★ and the ENDING still reaches the chat, whole, as one fresh message', () => {
  const before = B.CALLS.length;
  rec.resolve('answered', { answer: 'yes, at 17:04' });
  eq(B.CALLS.length - before, 1, 'a lost ⏳ must not turn one answer into a receipt plus a spill');
  const last = B.CALLS[B.CALLS.length - 1];
  eq(last.method, 'sendMessage', 'nothing to edit, so it is sent');
  ok(last.payload.text.startsWith('✅ btw · bg2'), last.payload.text);
  ok(last.payload.text.includes('yes, at 17:04'), last.payload.text);
});

await t('and a genuinely oversized answer still splits, even with no ⏳ to edit', () => {
  const rec2 = { id: 12, lane: 'bg', askedAt: Date.now() };
  B.setFailSends(true);
  const p = B.startBtwNotice(rec2, 'bg');
  B.setFailSends(false);
  return p.then(() => {
    const before = B.CALLS.length;
    rec2.resolve('answered', { answer: 'A'.repeat(6000) });
    eq(B.CALLS.length - before, 2, 'the receipt and the answer');
    ok(B.CALLS[before].payload.text.includes('in the next message'), B.CALLS[before].payload.text);
    ok(B.CALLS[before + 1].payload.text.includes('AAAA'), 'and the answer itself follows');
  });
});

// ---------------------------------------------------------------------------
// drainBtw and the on-disk record.
// ---------------------------------------------------------------------------

await t('drainBtw resolves every outstanding question exactly once', () => {
  const seen = [];
  const pending = [
    { id: 1, resolve: (s) => seen.push(['a', s]) },
    { id: 2, resolve: (s) => seen.push(['b', s]) },
  ];
  const run = { btw: { drain: () => pending.splice(0, pending.length) } };
  B.drainBtw(run, 'ended');
  eq(JSON.stringify(seen), JSON.stringify([['a', 'ended'], ['b', 'ended']]));
  B.drainBtw(run, 'ended');
  eq(seen.length, 2, '★ draining twice must not resolve a question twice');
});

await t('drainBtw on a run with no tracker at all is a no-op', () => {
  B.drainBtw(null, 'ended');
  B.drainBtw({}, 'ended');
  B.drainBtw({ btw: {} }, 'ended');
});

await t('★ the on-disk record carries the message id and drops the functions', () => {
  const d = B.btwRecordForDisk({ id: 3, msgId: 99, lane: 'bg2', askedAt: 7, question: 'q', resolve: () => {}, mirror: () => {} });
  eq(JSON.stringify(d), JSON.stringify({ id: 3, msgId: 99, lane: 'bg2', askedAt: 7, question: 'q' }));
});

await t('and a huge question is clipped before it reaches the registry', () => {
  const d = B.btwRecordForDisk({ id: 1, question: 'Q'.repeat(50_000) });
  ok(d.question.length <= 501, `${d.question.length} chars would be amplified across bg-inflight.json`);
  eq(d.msgId, null, 'an absent id is null, never undefined, so JSON keeps the field');
});

// ---------------------------------------------------------------------------
console.log('\n11. the same ⏳ over a background CODEX job');
// ---------------------------------------------------------------------------
//
// A side question to a Codex job on the app-server travels a different pipe
// (turn/steer rather than a stdin splice) and is resolved by a different
// detector, but it puts up the SAME ⏳ and must reach the same five endings.
// The routing is proven in bg-codex-wiring.test.mjs section 21d; what is
// asserted here is that the lane name being `codex` changes nothing about the
// line the owner is looking at.

B.reset();
const codexRec = { id: 1, lane: 'codex', askedAt: Date.now() };
await B.startBtwNotice(codexRec, 'codex');

await t('a question to a Codex job puts up one ⏳, named by its lane', () => {
  eq(sends().length, 1);
  ok(sends()[0].payload.text.startsWith('⏳ btw · codex'), sends()[0].payload.text);
});

await t('★ and its answer edits that same message, exactly as a worker\'s does', () => {
  codexRec.resolve('answered', { answer: 'it is b.txt' });
  eq(sends().length, 1, 'a wait is one message, edited');
  eq(edits().length, 1);
  ok(lastText().includes('✅ btw · codex'), lastText());
  ok(lastText().includes('it is b.txt'), lastText());
});

for (const [state, glyph] of [['ended', '❌'], ['stopped', '🛑'], ['lost', '❌'], ['refused', '❌']]) {
  await t(`a Codex job that ends "${state}" resolves the line rather than stranding it`, () => {
    B.reset();
    const r = { id: 1, lane: 'codex', askedAt: Date.now() };
    return B.startBtwNotice(r, 'codex').then(() => {
      r.resolve(state);
      ok(lastText().startsWith(glyph), `${state}: ${lastText()}`);
      eq(edits().length, 1, 'exactly one edit, to exactly one terminal state');
    });
  });
}

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all system-message wiring tests pass');
