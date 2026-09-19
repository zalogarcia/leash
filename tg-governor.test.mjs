#!/usr/bin/env node
// Tests for the Telegram write governor: the bucket, the shared cooldown, the
// outbox and its flush, the ledger, and the /status line.
//
// Everything runs against a fake clock, a fake sleep and a fake `deliver`, on
// files in a temp dir, so a full pass takes milliseconds and never touches
// Telegram. The stars are the two failure modes that motivated the module:
// a long 429 must HOLD a message instead of dropping it, and disposable
// chrome (typing, edits) must never be held or allowed to starve a message.
//
//   node tg-governor.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGovernor, fmtDuration, stripTags, CHAT_WRITE_METHODS, QUEUEABLE_METHODS } from './tg-governor.mjs';

let pass = 0;
const failures = [];
const tests = [];
const t = (name, fn) => tests.push({ name, fn });

const CHAT = '404408023';

/** A governor on fresh files with a fake clock and a scripted transport. */
function rig(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-gov-'));
  let clock = 1_000_000_000_000;
  const sleeps = [];
  const logs = [];
  const calls = [];
  // Scripted responses: a queue of functions (method, payload) => result | throw.
  const script = [];
  const deliver = async (method, payload) => {
    calls.push({ method, payload });
    const next = script.shift();
    if (next) return next(method, payload);
    return { message_id: calls.length };
  };
  const files = {
    outboxFile: path.join(dir, 'tg-outbox.json'),
    throttleFile: path.join(dir, 'tg-throttle.json'),
    ledgerFile: path.join(dir, 'tg-ledger.jsonl'),
  };
  const make = (extra = {}) =>
    createGovernor({
      chatId: CHAT,
      name: 'M',
      deliver,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      log: (s) => logs.push(s),
      fmtTime: (ts) => `T+${Math.round((ts - 1_000_000_000_000) / 1000)}s`,
      ...files,
      ...overrides,
      ...extra,
    });
  const gov = make();
  return {
    gov,
    make,
    dir,
    files,
    calls,
    script,
    sleeps,
    logs,
    tick: (ms) => {
      clock += ms;
    },
    now: () => clock,
    err: (code, retryAfter, description = '') =>
      Object.assign(new Error(`${code} ${description}`), { code, retryAfter, description }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const msg = (text, extra = {}) => ({ chat_id: CHAT, text, ...extra });

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

t('reads and non-chat writes pass untouched', () => {
  const r = rig();
  for (const m of ['getUpdates', 'getMe', 'setMyCommands', 'deleteMyCommands', 'getFile']) {
    const g = r.gov.gate(m, {});
    assert.equal(g.action, 'pass', m);
    assert.equal(g.governed, false, m);
  }
  // A write to some OTHER chat is not our budget.
  assert.equal(r.gov.gate('sendMessage', { chat_id: '1', text: 'x' }).governed, false);
  r.cleanup();
});

t('★ the bucket: disposables leave one token for a real message, and drop instead of waiting', () => {
  const r = rig(); // burst 3, reserve 1
  const typing = { chat_id: CHAT, action: 'typing' };
  assert.equal(r.gov.gate('sendChatAction', typing).action, 'pass'); // 3 -> 2
  assert.equal(r.gov.gate('sendChatAction', typing).action, 'pass'); // 2 -> 1
  const third = r.gov.gate('sendChatAction', typing);
  assert.equal(third.action, 'drop'); // 1 left: reserved
  assert.equal(third.disposable, true);
  // The reserved token goes to a message, at once.
  const m = r.gov.gate('sendMessage', msg('answer'));
  assert.equal(m.action, 'pass');
  assert.equal(m.waitMs, 0);
  // A second message right behind it goes into debt: it is sent, after a wait.
  const m2 = r.gov.gate('sendMessage', msg('answer 2'));
  assert.equal(m2.action, 'pass');
  assert.ok(m2.waitMs > 0 && m2.waitMs <= 1000, `waitMs ${m2.waitMs}`);
  // Time refills it.
  r.tick(3000);
  assert.equal(r.gov.gate('sendChatAction', typing).action, 'pass');
  r.cleanup();
});

t('an edit marked disposable by the caller is disposable even when the method is queueable', () => {
  const r = rig();
  const g = r.gov.gate('sendMessage', msg('🧠 Chewing…'), { disposable: true });
  assert.equal(g.disposable, true);
  assert.equal(g.queueable, false);
  r.cleanup();
});

// ---------------------------------------------------------------------------
// Throttle and outbox
// ---------------------------------------------------------------------------

t('★ a long 429 opens a cooldown: messages queue, chrome drops, and both files land on disk', () => {
  const r = rig();
  r.gov.throttle(2000, 'sendMessage');
  assert.equal(r.gov.coolingDown(), true);
  const q = r.gov.gate('sendMessage', msg('the answer'));
  assert.equal(q.action, 'queue');
  assert.ok(q.retryAfter >= 2000 && q.retryAfter <= 2001, `retryAfter ${q.retryAfter}`);
  assert.equal(r.gov.gate('editMessageText', { chat_id: CHAT, message_id: 1, text: 'x' }).action, 'drop');
  assert.equal(r.gov.gate('sendChatAction', { chat_id: CHAT, action: 'typing' }).action, 'drop');
  assert.equal(r.gov.gate('sendMessage', msg('placeholder'), { disposable: true }).action, 'drop');

  const res = r.gov.enqueue('sendMessage', msg('the answer'));
  assert.equal(res.queued, true);
  assert.equal(res.held, 1);
  const outbox = JSON.parse(readFileSync(r.files.outboxFile, 'utf8'));
  assert.equal(outbox.items.length, 1);
  assert.equal(outbox.items[0].payload.text, 'the answer');
  const throttle = JSON.parse(readFileSync(r.files.throttleFile, 'utf8'));
  assert.equal(throttle.until, r.now() + 2001 * 1000);
  assert.equal(throttle.source, 'bridge');
  assert.ok(r.logs.some((l) => /holding sendMessage \(1 held/.test(l)), r.logs.join('\n'));
  r.cleanup();
});

t('a 429 without retry_after still cools down, for the fallback seconds', () => {
  const r = rig();
  const until = r.gov.throttle(undefined, 'sendMessage');
  assert.equal(until, r.now() + (5 + 1) * 1000);
  r.cleanup();
});

t('★ flush waits for the deadline, then delivers oldest first behind one header, spaced out', async () => {
  const r = rig();
  r.gov.throttle(100, 'sendMessage');
  r.gov.enqueue('sendMessage', msg('first'));
  r.tick(10);
  r.gov.enqueue('sendMessage', msg('<b>second</b>', { parse_mode: 'HTML' }));
  r.tick(10);
  r.gov.enqueue('sendRichMessage', { chat_id: CHAT, rich_message: { blocks: [{ type: 'heading', text: 'third' }] } });

  const early = await r.gov.flush();
  assert.equal(early.stopped, 'cooldown');
  assert.equal(r.calls.length, 0);

  r.tick(101 * 1000);
  const done = await r.gov.flush();
  assert.equal(done.delivered, 3);
  assert.equal(done.remaining, 0);
  assert.equal(r.calls.length, 4);
  assert.match(r.calls[0].payload.text, /^🕓 Telegram throttled M for 1m \(T\+0s to T\+/);
  assert.match(r.calls[0].payload.text, /3 held messages follow, oldest first\./);
  assert.equal(r.calls[1].payload.text, 'first');
  assert.equal(r.calls[2].payload.text, '<b>second</b>');
  assert.equal(r.calls[2].payload.parse_mode, 'HTML');
  assert.equal(r.calls[3].method, 'sendRichMessage');
  // Three gaps: after the header, after first, after second. None after the last.
  assert.deepEqual(r.sleeps, [1100, 1100, 1100]);
  const outbox = JSON.parse(readFileSync(r.files.outboxFile, 'utf8'));
  assert.equal(outbox.items.length, 0);
  assert.equal(outbox.throttledSince, 0);
  assert.equal(r.gov.coolingDown(), false);
  r.cleanup();
});

t('★ a 429 during the flush stops it, keeps the item at the head, and the header is not repeated', async () => {
  const r = rig();
  r.gov.throttle(10, 'sendMessage');
  r.gov.enqueue('sendMessage', msg('a'));
  r.gov.enqueue('sendMessage', msg('b'));
  r.gov.enqueue('sendMessage', msg('c'));
  r.tick(11 * 1000);
  // header ok, a ok, b -> 429 for 60s
  r.script.push(() => ({ message_id: 1 }), () => ({ message_id: 2 }), () => {
    throw r.err(429, 60, 'Too Many Requests');
  });
  const first = await r.gov.flush();
  assert.equal(first.delivered, 1);
  assert.equal(first.remaining, 2);
  assert.equal(first.stopped, 'throttled');
  assert.equal(r.gov.coolingDown(), true);
  assert.equal(r.gov.items()[0].payload.text, 'b');

  const stalled = await r.gov.flush();
  assert.equal(stalled.stopped, 'cooldown');

  r.tick(61 * 1000);
  const second = await r.gov.flush();
  assert.equal(second.delivered, 2);
  const texts = r.calls.map((c) => c.payload.text);
  assert.equal(texts.filter((x) => /^🕓/.test(x)).length, 1, 'one header across both flushes');
  assert.deepEqual(texts.filter((x) => !/^🕓/.test(x)), ['a', 'b', 'b', 'c']);
  r.cleanup();
});

t('an HTML item Telegram cannot parse is re-sent plain; a plain 400 is dropped and logged', async () => {
  const r = rig();
  r.gov.throttle(1, 'sendMessage');
  r.gov.enqueue('sendMessage', msg('<b>bad <i>nest', { parse_mode: 'HTML' }));
  r.gov.enqueue('sendMessage', msg('no such chat'));
  r.gov.enqueue('sendMessage', msg('fine'));
  r.tick(3000);
  r.script.push(
    () => ({ message_id: 1 }), // header
    () => {
      throw r.err(400, 0, "Bad Request: can't parse entities");
    },
    () => ({ message_id: 2 }), // the plain retry
    () => {
      throw r.err(400, 0, 'Bad Request: chat not found');
    },
    () => ({ message_id: 3 }),
  );
  const done = await r.gov.flush();
  assert.equal(done.delivered, 2);
  assert.equal(done.remaining, 0);
  const plain = r.calls.find((c) => c.payload.text === 'bad nest');
  assert.ok(plain, 'plain fallback sent');
  assert.equal(plain.payload.parse_mode, undefined);
  assert.ok(r.logs.some((l) => /dropped, Telegram refused it: 400 Bad Request: chat not found/.test(l)), r.logs.join('\n'));
  r.cleanup();
});

t('a network error keeps the item and retries on later flushes, up to maxAttempts', async () => {
  const r = rig();
  r.gov.throttle(1, 'sendMessage');
  r.gov.enqueue('sendMessage', msg('flaky'));
  r.tick(3000);
  // header ok, then the item fails with no HTTP code five times.
  r.script.push(() => ({ message_id: 1 }));
  for (let i = 0; i < 5; i++) r.script.push(() => {
    throw new Error('fetch failed');
  });
  for (let i = 0; i < 4; i++) {
    const res = await r.gov.flush();
    assert.equal(res.stopped, 'error', `attempt ${i + 1}`);
    assert.equal(res.remaining, 1);
  }
  const last = await r.gov.flush();
  assert.equal(last.remaining, 0);
  assert.ok(r.logs.some((l) => /dropped after 5 attempts: fetch failed/.test(l)), r.logs.join('\n'));
  r.cleanup();
});

t('★ a restart keeps the held messages and the deadline', () => {
  const r = rig();
  r.gov.throttle(500, 'sendMessage');
  r.gov.enqueue('sendMessage', msg('survives'));
  const again = r.make();
  assert.equal(again.held(), 1);
  assert.equal(again.coolingDown(), true);
  assert.equal(again.items()[0].payload.text, 'survives');
  assert.ok(r.logs.some((l) => /outbox loaded: 1 held message$/.test(l)), r.logs.join('\n'));
  assert.ok(r.logs.some((l) => /cooldown still running from a previous life/.test(l)), r.logs.join('\n'));
  r.cleanup();
});

t('★ a later deadline written by another process is adopted', () => {
  const r = rig();
  assert.equal(r.gov.coolingDown(), false);
  writeFileSync(
    r.files.throttleFile,
    JSON.stringify({ until: r.now() + 900_000, retryAfter: 899, method: 'sendMessage', at: r.now(), source: 'mail-watch' }),
  );
  r.tick(1500); // past the 1s stat cache
  assert.equal(r.gov.coolingDown(), true);
  assert.equal(r.gov.status().throttleInfo.source, 'mail-watch');
  assert.ok(r.logs.some((l) => /cooldown adopted from mail-watch/.test(l)), r.logs.join('\n'));
  // Our own later write is not "another process" and does not re-log an adoption.
  const before = r.logs.length;
  r.gov.throttle(2000, 'sendMessage');
  r.tick(1500);
  r.gov.coolingDown();
  assert.equal(r.logs.slice(before).filter((l) => /adopted/.test(l)).length, 0);
  r.cleanup();
});

t('the outbox is capped by count and by age', () => {
  const r = rig({ config: { maxItems: 3, maxAgeMs: 60_000 } });
  r.gov.throttle(5000, 'sendMessage');
  for (let i = 0; i < 5; i++) r.gov.enqueue('sendMessage', msg(`m${i}`));
  assert.deepEqual(
    r.gov.items().map((i) => i.payload.text),
    ['m2', 'm3', 'm4'],
  );
  r.tick(61_000);
  r.gov.enqueue('sendMessage', msg('fresh'));
  assert.deepEqual(
    r.gov.items().map((i) => i.payload.text),
    ['fresh'],
  );
  assert.ok(r.logs.some((l) => /pruned 3 stale messages/.test(l)), r.logs.join('\n'));
  r.cleanup();
});

// ---------------------------------------------------------------------------
// Ledger and status
// ---------------------------------------------------------------------------

t('every write is recorded and the ledger is trimmed to its cap', () => {
  const r = rig({ config: { ledgerMax: 10, ledgerTrimEvery: 5 } });
  for (let i = 0; i < 25; i++) r.gov.record({ method: 'sendChatAction', outcome: 'sent' });
  const lines = readFileSync(r.files.ledgerFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 10);
  const row = JSON.parse(lines[0]);
  assert.equal(row.method, 'sendChatAction');
  assert.equal(row.outcome, 'sent');
  assert.equal(typeof row.ts, 'number');
  r.cleanup();
});

t('the status line: quiet, throttled, and held', () => {
  const r = rig();
  assert.equal(r.gov.statusLine(), '📡 Telegram · 10m: 0 writes');
  r.gov.record({ method: 'sendChatAction', outcome: 'sent' });
  r.gov.record({ method: 'sendChatAction', outcome: 'sent' });
  r.gov.record({ method: 'editMessageText', outcome: 'sent' });
  r.gov.record({ method: 'sendMessage', outcome: 'sent' });
  r.gov.record({ method: 'sendChatAction', outcome: 'dropped' });
  assert.equal(r.gov.statusLine(), '📡 Telegram · 10m: 4 writes (2 typing · 1 edit · 1 msg) · 1 dropped');
  // Old rows fall out of the window.
  r.tick(11 * 60_000);
  assert.equal(r.gov.statusLine(), '📡 Telegram · 10m: 0 writes');

  r.gov.throttle(3600, 'sendMessage');
  r.gov.enqueue('sendMessage', msg('x'));
  assert.equal(r.gov.statusLine(), `📮 Telegram · throttled until T+${(r.now() - 1_000_000_000_000) / 1000 + 3601}s (1h left) · 1 held`);
  r.tick(3602 * 1000);
  assert.equal(r.gov.statusLine(), '📮 Telegram · 1 held, delivering');
  r.cleanup();
});

t('★ the owner notice: once per window, only while throttled, and a 429 on it refreshes the deadline', async () => {
  const r = rig({ config: { noticeEveryMs: 60_000 } });
  assert.deepEqual(await r.gov.noticeOwner(), { sent: false, reason: 'not throttled' });
  r.gov.throttle(600, 'sendMessage');
  r.gov.enqueue('sendMessage', msg('held one'));
  const first = await r.gov.noticeOwner();
  assert.equal(first.sent, true);
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0].payload.text, /^🕓 Telegram is throttling M until T\+601s \(10m left\)\. Your messages are being read\. The answers are held and will arrive then \(1 held so far\)\.$/);
  assert.equal(r.calls[0].payload.parse_mode, undefined, 'plain text: the cheapest thing that can land');
  assert.deepEqual(await r.gov.noticeOwner(), { sent: false, reason: 'recent' });
  assert.equal(r.calls.length, 1);
  r.tick(61_000);
  r.script.push(() => {
    throw r.err(429, 3000, 'Too Many Requests');
  });
  const refused = await r.gov.noticeOwner();
  assert.equal(refused.sent, false);
  assert.equal(r.gov.remainingMs(), 3001 * 1000, 'the refused notice refreshed the deadline');
  r.cleanup();
});

t('★ a short wall that held nothing closes itself, so the next header measures only its own wall', async () => {
  const r = rig();
  r.gov.throttle(3, 'sendMessage'); // waited out inline by tg(); nothing enqueued
  r.tick(5000);
  assert.equal((await r.gov.flush()).stopped, 'empty');
  assert.equal(r.gov.status().throttledSince, 0, 'episode closed');
  r.tick(2 * 24 * 3600_000);
  r.gov.throttle(600, 'sendMessage');
  r.gov.enqueue('sendMessage', msg('later'));
  r.tick(601_000);
  await r.gov.flush();
  assert.match(r.calls[0].payload.text, /^🕓 Telegram throttled M for 10m /, r.calls[0].payload.text);
  r.cleanup();
});

t('a wall that opens after the previous one expired is a new episode even with no flush in between', () => {
  const r = rig();
  r.gov.throttle(3, 'sendMessage');
  r.tick(2 * 24 * 3600_000);
  r.gov.throttle(600, 'sendMessage');
  assert.equal(r.gov.status().throttledSince, r.now());
  r.cleanup();
});

t('★ a stale throttle file (deadline already past) is ignored at boot and on sync', () => {
  const r = rig();
  writeFileSync(
    r.files.throttleFile,
    JSON.stringify({ until: r.now() - 1000, retryAfter: 90, method: 'sendMessage', at: r.now() - 91_000, source: 'bridge' }),
  );
  const again = r.make();
  assert.equal(again.coolingDown(), false);
  assert.equal(again.status().throttledSince, 0);
  assert.equal(r.logs.filter((l) => /adopted|previous life/.test(l)).length, 0, r.logs.join('\n'));
  // And a live one written later by another process still starts a clean episode.
  r.tick(1500);
  writeFileSync(
    r.files.throttleFile,
    JSON.stringify({ until: r.now() + 300_000, retryAfter: 299, method: 'sendMessage', at: r.now(), source: 'mail-watch' }),
  );
  assert.equal(again.coolingDown(), true);
  assert.equal(again.status().throttledSince, r.now());
  r.cleanup();
});

t('★ a reboot mid-wall with nothing held keeps the episode start, even after the throttle file was refreshed', async () => {
  const r = rig();
  const t0 = r.now();
  r.gov.throttle(8687, 'sendMessage'); // the wall opens; every answer so far was chrome or waited inline
  r.tick(2 * 3600_000);
  r.script.push(() => {
    throw r.err(429, 1400, 'Too Many Requests');
  });
  await r.gov.noticeOwner(); // refused: the file's `at` is now two hours after the wall opened
  r.tick(5 * 60_000);
  const again = r.make(); // /restart
  assert.equal(again.coolingDown(), true);
  assert.equal(again.status().throttledSince, t0, 'the episode still starts at the first 429');
  again.enqueue('sendMessage', msg('after the reboot'));
  r.tick(1500 * 1000);
  await again.flush();
  const header = r.calls.find((c) => /^🕓 Telegram throttled/.test(c.payload.text || ''));
  assert.match(header.payload.text, /throttled M for 2h 30m /, header.payload.text);
  r.cleanup();
});

t('a held message Telegram refused during a flush is always written to the ledger, coalescing or not', async () => {
  const r = rig();
  r.gov.throttle(20, 'sendMessage');
  r.gov.enqueue('sendMessage', msg('x'.repeat(10)));
  r.tick(15_000);
  r.gov.record({ method: 'sendMessage', outcome: 'dropped', retryAfter: 5 }); // a placeholder the gate dropped
  r.tick(6_000);
  r.script.push(() => ({ message_id: 1 }), () => {
    throw r.err(400, 0, 'Bad Request: message is too long');
  });
  await r.gov.flush();
  const rows = readFileSync(r.files.ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const flushDrops = rows.filter((x) => x.outcome === 'dropped' && x.via === 'flush');
  assert.equal(flushDrops.length, 1, JSON.stringify(rows));
  assert.equal(flushDrops[0].code, 400);
  r.cleanup();
});

t('repeated drops of one method write one ledger line per half minute but every one counts in the window', () => {
  const r = rig();
  for (let i = 0; i < 10; i++) {
    r.gov.record({ method: 'sendChatAction', outcome: 'dropped', retryAfter: 100 - i });
    r.tick(3000);
  }
  const lines = readFileSync(r.files.ledgerFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(r.gov.status().counts.dropped, 10);
  r.tick(30_000);
  r.gov.record({ method: 'sendChatAction', outcome: 'dropped' });
  assert.equal(readFileSync(r.files.ledgerFile, 'utf8').split('\n').filter(Boolean).length, 2);
  r.cleanup();
});

t('helpers: fmtDuration and stripTags', () => {
  assert.equal(fmtDuration(45_000), '45s');
  assert.equal(fmtDuration(12 * 60_000), '12m');
  assert.equal(fmtDuration(2 * 3600_000 + 24 * 60_000), '2h 24m');
  assert.equal(fmtDuration(3 * 3600_000), '3h');
  assert.equal(stripTags('<b>a</b> &lt;c&gt; &amp; d'), 'a <c> & d');
  assert.ok(CHAT_WRITE_METHODS.has('sendChatAction'));
  assert.ok(QUEUEABLE_METHODS.has('sendRichMessage') && !QUEUEABLE_METHODS.has('sendDocument'));
});

t('start() arms an unref timer that flushes; stop() disarms it', async () => {
  const r = rig({ config: { flushEveryMs: 5 } });
  r.gov.throttle(0.001, 'sendMessage'); // effectively over at once (fallback? no: >0 so 0.001s)
  r.gov.enqueue('sendMessage', msg('timed'));
  r.tick(2000);
  r.gov.start();
  await new Promise((res) => setTimeout(res, 40));
  r.gov.stop();
  assert.equal(r.gov.held(), 0, 'the timer flushed it');
  assert.ok(r.calls.some((c) => c.payload.text === 'timed'));
  r.cleanup();
});

// ---------------------------------------------------------------------------

for (const { name, fn } of tests) {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
}
console.log(`tg-governor: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
if (failures.length) process.exit(1);
