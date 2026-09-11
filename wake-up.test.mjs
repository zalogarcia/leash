#!/usr/bin/env node
// Unit tests for the wake-up decisions.
//
// The failure that matters is the one measured on 2026-09-11: a chat turn cut
// by a daemon restart, and a session that then sat on five written briefs for
// fifty minutes because nothing asked it to look. So the cut case is proven
// from the real marker shape, the commitment detector is proven against the
// real ring rows of that morning (both the ones that should wake and the ones
// that should not), every guard gets its own case in both directions, and the
// once-only key is proven across a second boot.
//
//   node wake-up.test.mjs

import {
  WAKE_UP_DEFAULTS,
  wakeUpConfig,
  forwardCommitment,
  lastAssistantTurn,
  ANSWER_TAIL_MAX,
  answerTail,
  lastAnswerRecord,
  decideRestartWakeUp,
  UNFINISHED_HEADING,
  unfinishedWorkClause,
  parseUnfinishedWork,
  compactPrimeMode,
  restartWakeUpLogLine,
  compactWakeUpLogLine,
} from './wake-up.mjs';

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

// The real rows from chat-ring.jsonl on the morning this was built, clipped
// exactly as the ring clips them.
const RING = [
  { ts: 1789133232570, chat: '1', engine: 'claude', role: 'user', text: '[Session handoff, the summary below is the compacted context…' },
  {
    ts: 1789133239572,
    chat: '1',
    engine: 'claude',
    role: 'assistant',
    text: 'Picking back up mid-build: the wave 3 QA gate, the codex-bare refresh and the auto-compact workers are all in flight, and once the gate lands I dispatch wave 4 and run SP1 per "Merge when green". Wait',
  },
  { ts: 1789133299785, chat: '1', engine: 'claude', role: 'user', text: '[Report from your own background worker, it finished…' },
  {
    ts: 1789133689209,
    chat: '1',
    engine: 'claude',
    role: 'assistant',
    text: 'Done for now. Short update: The Astra session refresh is built and proven. The worker shipped a script that only you (or M, for codex-bare alone) can point at t',
  },
  { ts: 1789136125595, chat: '1', engine: 'claude', role: 'user', text: '[Report from your own background worker, it finished…' },
];
const IDLE_ANSWER = {
  ts: 1789135524567,
  chat: '1',
  engine: 'claude',
  role: 'assistant',
  text: "Today's recon is delivered: the summary, the 10 exact notes and the batch file are in your Telegram (messages 13094 to 13097). Astra drafted 10 LinkedIn invitation notes, all tier C, sent nothing. No",
};
// The marker the daemon persisted for the turn that was cut at 10:23 ET.
const CUT = { runId: 'main-1789136127000', at: 1789136127000, prompt: '[Report from your own background worker, it finished…', kind: 'internal' };

const ON = { afterRestart: true, afterCompact: true };
const ready = (extra = {}) => ({
  config: ON,
  inFlight: CUT,
  ring: RING,
  lastAnswer: null,
  engine: 'claude',
  claudeAvailable: true,
  hasSession: true,
  sessionChanged: false,
  walled: false,
  ownerMessage: false,
  laneBusy: false,
  queued: 0,
  lastWakeUp: null,
  ...extra,
});

// ---------------------------------------------------------------------------
console.log('\n1. the config block');

t('defaults: both halves on', () => {
  eq(WAKE_UP_DEFAULTS.afterRestart, true);
  eq(WAKE_UP_DEFAULTS.afterCompact, true);
  eq(wakeUpConfig(undefined).afterRestart, true);
  eq(wakeUpConfig(null).afterCompact, true);
  eq(wakeUpConfig({}).afterRestart, true);
});

t('the block as written in config.json', () => {
  const c = wakeUpConfig({ afterRestart: false, afterCompact: true });
  eq(c.afterRestart, false);
  eq(c.afterCompact, true);
});

t('★ a real boolean: the string "false" turns a half off, garbage leaves the default', () => {
  eq(wakeUpConfig({ afterRestart: 'false' }).afterRestart, false);
  eq(wakeUpConfig({ afterCompact: 'no' }).afterCompact, false);
  eq(wakeUpConfig({ afterRestart: 'maybe' }).afterRestart, true, 'unreadable keeps the default');
});

t('the env layer arrives as JSON text, or as a bare boolean covering both', () => {
  eq(wakeUpConfig('{"afterRestart":false}').afterRestart, false);
  eq(wakeUpConfig('{"afterRestart":false}').afterCompact, true);
  eq(wakeUpConfig('false').afterRestart, false);
  eq(wakeUpConfig('false').afterCompact, false);
  eq(wakeUpConfig(false).afterCompact, false);
  eq(wakeUpConfig('{not json').afterRestart, true, 'garbage degrades to the defaults, never throws');
});

// ---------------------------------------------------------------------------
console.log('\n2. forward looking commitments, against the real rows');

t('★ "once the gate lands I dispatch wave 4" is a commitment', () => {
  const p = forwardCommitment(RING[1].text);
  ok(p, 'the handoff acknowledgement promised a dispatch');
  ok(/once the gate lands I dispatch/i.test(p), p);
});

t('★ a delivered result with nothing promised is not', () => {
  eq(forwardCommitment(IDLE_ANSWER.text), null, IDLE_ANSWER.text);
  eq(forwardCommitment(RING[3].text), null, RING[3].text);
});

t('the shapes the assistant actually uses', () => {
  for (const s of [
    'Telling Zalo, then reading the full report before dispatching wave 4 and starting ship point 1.',
    "Reading the full report, verifying the commit and suites, then running the refresh and firing today's outreach.",
    'Worker report landed. I will read it and report back.',
    "I'll dispatch the remaining three once this one lands.",
    'Astra is on it now, stand by.',
    'Wave 3 gate report landed: VERIFICATION PASSED. Next: I dispatch wave 4.',
  ]) {
    ok(forwardCommitment(s), `should read as a commitment: ${s}`);
  }
});

t('plain statements of fact do not wake anything', () => {
  for (const s of [
    'Both repos are green and committed. Nothing else is running.',
    'The file is in your Downloads. Let me know if you want changes.',
    'No, that number was from yesterday.',
    '',
    null,
  ]) {
    eq(forwardCommitment(s), null, `should not read as a commitment: ${s}`);
  }
});

t('★ the persisted record is made from the WHOLE answer, so a last-sentence promise is seen', () => {
  const long = `Both repos are green. ${'x'.repeat(420)} Then I dispatch wave 4 and run SP1.`;
  eq(forwardCommitment(long.slice(0, 400)), null, 'the ring head alone misses it (the measured gap)');
  const rec = lastAnswerRecord(long, { ts: 7 });
  eq(rec.ts, 7);
  eq(rec.phrase, 'Then I dispatch');
  ok(rec.tail.startsWith('…') && rec.tail.endsWith('Then I dispatch wave 4 and run SP1.'), rec.tail);
  ok(rec.tail.length <= ANSWER_TAIL_MAX + 1, `${rec.tail.length}`);
  eq(lastAnswerRecord('short answer.', { ts: 1 }).tail, 'short answer.');
  eq(lastAnswerRecord('short answer.', { ts: 1 }).phrase, null);
  eq(lastAnswerRecord('SECRET-ish-value then I run it', { ts: 1, redact: (t) => t.replace(/SECRET-\S+/g, '[redacted]') }).tail, '[redacted] then I run it', 'the caller redacts');
});

t('answerTail: the end of the text, one line, marked when cut', () => {
  eq(answerTail('a\nb  c'), 'a b c');
  eq(answerTail('x'.repeat(10), 5), '…xxxxx');
  eq(answerTail(null), '');
});

t('lastAssistantTurn: the last assistant row, even under a later user row', () => {
  eq(lastAssistantTurn(RING).ts, RING[3].ts);
  eq(lastAssistantTurn([]), null);
  eq(lastAssistantTurn([{ role: 'user', text: 'hi' }]), null);
  eq(lastAssistantTurn([{ role: 'assistant', text: '   ' }]), null, 'an empty answer is no answer');
});

// ---------------------------------------------------------------------------
console.log('\n3. the restart decision');

t('★ the measured case: a cut internal turn wakes the session', () => {
  const d = decideRestartWakeUp(ready());
  eq(d.wake, true);
  eq(d.kind, 'cut');
  eq(d.key, 'cut:main-1789136127000');
  eq(d.cut.prompt, CUT.prompt, 'the cut turn travels with the decision, for the prompt');
  eq(d.last.ts, RING[3].ts, 'so do the last words');
});

t('★ a restart between turns still wakes on a forward commitment', () => {
  const d = decideRestartWakeUp(ready({ inFlight: null, ring: RING.slice(0, 2) }));
  eq(d.wake, true);
  eq(d.kind, 'commitment');
  eq(d.key, `commitment:${RING[1].ts}`);
  ok(/dispatch/.test(d.phrase), d.phrase);
});

t('★ nothing cut and nothing promised: no wake-up', () => {
  const d = decideRestartWakeUp(ready({ inFlight: null, ring: [RING[2], IDLE_ANSWER] }));
  eq(d.wake, false);
  eq(d.reason, 'nothing_pending');
  eq(d.defer, false);
});

t('★ a cut COMPACTION is not a cut turn: the ring decides', () => {
  const compact = { ...CUT, kind: 'compact', prompt: '[[BRIDGE-COMPACT]] Produce a compaction summary…' };
  const d1 = decideRestartWakeUp(ready({ inFlight: compact, ring: [RING[2], IDLE_ANSWER] }));
  eq(d1.wake, false, 'the chat is unchanged and its last answer promised nothing');
  eq(d1.reason, 'nothing_pending');
  const d2 = decideRestartWakeUp(ready({ inFlight: compact, ring: RING.slice(0, 2) }));
  eq(d2.wake, true);
  eq(d2.kind, 'commitment', 'the answer before the compaction still counts');
});

t('★ the persisted record wins over the ring, and its tail is what the prompt gets', () => {
  const rec = lastAnswerRecord(`Delivered. ${'y'.repeat(500)} Next I collect bg3 and report back.`, { ts: 99 });
  const d = decideRestartWakeUp(ready({ inFlight: null, ring: [RING[2], IDLE_ANSWER], lastAnswer: rec }));
  eq(d.wake, true, 'the ring row promised nothing; the full answer did');
  eq(d.kind, 'commitment');
  eq(d.key, 'commitment:99');
  eq(d.last.ts, 99);
  ok(d.last.text.endsWith('Next I collect bg3 and report back.'), d.last.text);
  const none = decideRestartWakeUp(ready({ inFlight: null, ring: RING.slice(0, 2), lastAnswer: lastAnswerRecord('All done, nothing else running.', { ts: 100 }) }));
  eq(none.reason, 'nothing_pending', 'a record with no phrase is not overridden by an older ring row');
  const older = decideRestartWakeUp(ready({ inFlight: null, ring: RING.slice(0, 2), lastAnswer: { ts: 1 } }));
  eq(older.kind, 'commitment', 'an empty record (no tail, no phrase) falls back to the ring');
});

t('★ a switched chat skips: the cut turn belongs to another session', () => {
  const d = decideRestartWakeUp(ready({ sessionChanged: true }));
  eq(d.wake, false);
  eq(d.reason, 'chat_switched');
  eq(d.defer, false);
});

t('a cut turn the owner typed is a cut turn too', () => {
  const d = decideRestartWakeUp(ready({ inFlight: { ...CUT, kind: 'owner' } }));
  eq(d.wake, true);
  eq(d.kind, 'cut');
});

t('★ the owner\'s message wins, over a cut turn and over a commitment', () => {
  eq(decideRestartWakeUp(ready({ ownerMessage: true })).reason, 'owner_message');
  eq(decideRestartWakeUp(ready({ ownerMessage: true, inFlight: null })).reason, 'owner_message');
  eq(decideRestartWakeUp(ready({ ownerMessage: true })).defer, false, 'final, not deferred');
});

t('★ never on a walled engine', () => {
  const d = decideRestartWakeUp(ready({ walled: true }));
  eq(d.wake, false);
  eq(d.reason, 'walled');
  eq(d.defer, false);
});

t('★ never on a Codex lane, and never without claude', () => {
  eq(decideRestartWakeUp(ready({ engine: 'codex' })).reason, 'codex_lane');
  eq(decideRestartWakeUp(ready({ claudeAvailable: false })).reason, 'claude_missing');
});

t('a fresh chat has nothing to wake', () => {
  eq(decideRestartWakeUp(ready({ hasSession: false })).reason, 'no_session');
});

t('off in config: skipped, and the reason says so', () => {
  eq(decideRestartWakeUp(ready({ config: { afterRestart: false, afterCompact: true } })).reason, 'disabled');
});

t('★ a busy lane DEFERS rather than skips: a worker report landing first must not lose the wake-up', () => {
  const d = decideRestartWakeUp(ready({ laneBusy: true }));
  eq(d.wake, false);
  eq(d.defer, true);
  eq(d.reason, 'lane_busy');
  eq(d.kind, 'cut', 'the deferral still says what it would have sent');
  const q = decideRestartWakeUp(ready({ queued: 1 }));
  eq(q.defer, true);
  eq(q.reason, 'queued');
});

t('★ but a busy lane does not defer a decision that was never going to wake', () => {
  const d = decideRestartWakeUp(ready({ laneBusy: true, inFlight: null, ring: [IDLE_ANSWER] }));
  eq(d.defer, false);
  eq(d.reason, 'nothing_pending');
});

t('★ once per restart: the key of the sent wake-up blocks a second boot on the same facts', () => {
  const first = decideRestartWakeUp(ready());
  eq(first.wake, true);
  const again = decideRestartWakeUp(ready({ lastWakeUp: { key: first.key } }));
  eq(again.wake, false);
  eq(again.reason, 'already_sent');
  const other = decideRestartWakeUp(ready({ lastWakeUp: { key: 'cut:main-1' } }));
  eq(other.wake, true, 'a different turn is a different wake-up');
});

t('the commitment key is the answer, so a boot loop that never reaches the dispatch wakes once for it', () => {
  const d = decideRestartWakeUp(ready({ inFlight: null, ring: RING.slice(0, 2) }));
  const again = decideRestartWakeUp(ready({ inFlight: null, ring: RING.slice(0, 2), lastWakeUp: { key: d.key } }));
  eq(again.reason, 'already_sent');
});

t('the guards win over the facts: a walled engine with a cut turn is still walled', () => {
  eq(decideRestartWakeUp(ready({ walled: true, inFlight: CUT })).reason, 'walled');
});

// ---------------------------------------------------------------------------
console.log('\n4. the compaction summary: the "Unfinished work" section');

t('the clause names the heading the parser looks for, and the word none', () => {
  const c = unfinishedWorkClause();
  ok(c.includes(UNFINISHED_HEADING), c);
  ok(/\bnone\b/.test(c), c);
  ok(!/[–—]/.test(c), 'no dashes in a prompt string either');
});

t('★ pending work, in the shape the prompt asks for', () => {
  const summary = `Zalo is the owner. Active projects: voice-live wave 4.\n\nUnfinished work\n\`\`\`\n- dispatch the five wave 4 briefs in /tmp/brief-voice-*.md\n- run SP1 once wave 4 is green\n\`\`\`\n`;
  const p = parseUnfinishedWork(summary);
  eq(p.status, 'pending');
  eq(p.items.length, 2);
  eq(p.items[0], 'dispatch the five wave 4 briefs in /tmp/brief-voice-*.md');
});

t('★ the single word none', () => {
  eq(parseUnfinishedWork('Context.\n\nUnfinished work\n```\nnone\n```').status, 'none');
  eq(parseUnfinishedWork('Context.\n\n## Unfinished work\n```text\nNone.\n```').status, 'none');
  eq(parseUnfinishedWork('Context.\n\nUnfinished work:\n```\n\n```').status, 'none', 'an empty block is none');
});

t('the shapes a model produces: hashes, bold, a colon, an info string that is the title, ~~~ fences', () => {
  eq(parseUnfinishedWork('x\n### Unfinished work:\n```\n1. collect bg3\n```').items[0], 'collect bg3');
  // The three shapes QA found read as missing on the first cut.
  eq(parseUnfinishedWork('x\n**Unfinished work:**\n```\n- dispatch wave 4\n```').items[0], 'dispatch wave 4', 'the colon inside the bold');
  eq(parseUnfinishedWork('x\n## 7. Unfinished work\n```\n- x\n```').status, 'pending', 'a numbered heading');
  eq(parseUnfinishedWork('x\n## 🔧 Unfinished work\n```\n- x\n```').status, 'pending', 'an emoji before the title');
  eq(parseUnfinishedWork('x\n**7) Unfinished work**:\n```\nnone\n```').status, 'none');
  eq(parseUnfinishedWork('x\n**Unfinished work**\n```\n* ship it\n```').items[0], 'ship it');
  eq(parseUnfinishedWork('x\n```unfinished work\ndeliver the PDF\n```').items[0], 'deliver the PDF');
  eq(parseUnfinishedWork('x\n```unfinished_work\ndeliver the PDF\n```').items[0], 'deliver the PDF');
  eq(parseUnfinishedWork('x\nUnfinished work\n~~~\ndeliver the PDF\n~~~').items[0], 'deliver the PDF');
});

t('a section with no fence at all is still read, up to the next heading', () => {
  const p = parseUnfinishedWork('x\n## Unfinished work\n- fire wave 4\n- collect bg2\n## Something else\n- not this');
  eq(p.status, 'pending');
  eq(p.items.length, 2);
});

t('★ missing is missing, not none: a summary that ignored the ask says so', () => {
  eq(parseUnfinishedWork('A summary with no such section.').status, 'missing');
  eq(parseUnfinishedWork('').status, 'missing');
  eq(parseUnfinishedWork(null).status, 'missing');
});

t('the LAST section wins, and a mention in prose is not a section', () => {
  const s = 'Earlier I said the unfinished work was large.\n\nUnfinished work\n```\nnone\n```';
  eq(parseUnfinishedWork(s).status, 'none');
});

// ---------------------------------------------------------------------------
console.log('\n5. the prime mode');

const PENDING = 'Summary.\n\nUnfinished work\n```\n- dispatch wave 4\n```';
const NONE = 'Summary.\n\nUnfinished work\n```\nnone\n```';

t('★ pending work primes CONTINUE', () => {
  const m = compactPrimeMode({ config: ON, summary: PENDING });
  eq(m.mode, 'continue');
  eq(m.unfinished, 'pending');
  eq(m.items.length, 1);
});

t('★ none primes WAIT, exactly as before', () => {
  const m = compactPrimeMode({ config: ON, summary: NONE });
  eq(m.mode, 'wait');
  eq(m.reason, 'compact_none');
});

t('a missing section primes WAIT, and the log will say missing', () => {
  const m = compactPrimeMode({ config: ON, summary: 'no section' });
  eq(m.mode, 'wait');
  eq(m.reason, 'compact_missing');
  eq(m.unfinished, 'missing');
});

t('off in config: WAIT even with pending work', () => {
  const m = compactPrimeMode({ config: { afterRestart: true, afterCompact: false }, summary: PENDING });
  eq(m.mode, 'wait');
  eq(m.reason, 'disabled');
});

// ---------------------------------------------------------------------------
console.log('\n6. one log line per decision');

t('the restart lines', () => {
  eq(restartWakeUpLogLine(decideRestartWakeUp(ready())), '[bridge] wake_up_sent reason=restart kind=cut cut=main-1789136127000');
  const c = restartWakeUpLogLine(decideRestartWakeUp(ready({ inFlight: null, ring: RING.slice(0, 2) })));
  ok(c.startsWith('[bridge] wake_up_sent reason=restart kind=commitment phrase="'), c);
  eq(restartWakeUpLogLine(decideRestartWakeUp(ready({ ownerMessage: true }))), '[bridge] wake_up_skipped reason=owner_message');
  eq(restartWakeUpLogLine(decideRestartWakeUp(ready({ laneBusy: true }))), '[bridge] wake_up_deferred reason=lane_busy kind=cut');
  eq(restartWakeUpLogLine(null), '[bridge] wake_up_skipped reason=no_decision');
});

t('the compact lines', () => {
  eq(compactWakeUpLogLine(compactPrimeMode({ config: ON, summary: PENDING })), '[bridge] wake_up_sent reason=compact unfinished=pending items=1');
  eq(compactWakeUpLogLine(compactPrimeMode({ config: ON, summary: NONE })), '[bridge] wake_up_skipped reason=compact_none unfinished=none');
  eq(compactWakeUpLogLine(compactPrimeMode({ config: ON, summary: 'x' })), '[bridge] wake_up_skipped reason=compact_missing unfinished=missing');
});

t('no dashes in any log line', () => {
  for (const s of [
    restartWakeUpLogLine(decideRestartWakeUp(ready())),
    compactWakeUpLogLine(compactPrimeMode({ config: ON, summary: PENDING })),
  ]) {
    ok(!/[–—]/.test(s), s);
  }
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`\n  ✗ ${f}`);
  process.exit(1);
}
console.log('\n✅ all wake-up tests pass');
