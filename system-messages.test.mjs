#!/usr/bin/env node
// Tests for the daemon's own message shapes.
//
// These are house-style assertions, not string comparisons for their own sake.
// The 2026-09-04 audit found the same four defects across 88 messages, so each
// one gets a mechanical check that runs over every shape this module builds:
//
//   • no em or en dash in a source string (the normalizer turns them into
//     commas, and a public install starts with the normalizer off);
//   • no line over 44 characters, which is where Telegram's bubble font wraps
//     on his phone, unless the line is a path or a quoted brief title;
//   • no token count and no model name in a footer (they moved to /usage and
//     /account deliberately, commit 336f9f7);
//   • every ⏳ line has a defined terminal state that some other builder here
//     produces.
//
//   node system-messages.test.mjs

import {
  visibleOnly,
  workerCount,
  stepCount,
  restartingLine,
  restartResolvedLine,
  bootAnnouncePlan,
  bootAnnounceLine,
  fetchingLine,
  fetchFailedLine,
  deadWorkerLine,
  chainPausedLine,
  codexCatchUpLine,
  codexResumedLine,
  codexSteerLostLine,
  errorMessage,
  classifyClaudeFailure,
  claudeFailureRemedy,
  firstMeaningfulLine,
  helpMessage,
  HELP_GROUPS,
  HELP_BODY_MAX,
  HELP_COMPOSED_MAX,
  workerStatusBlock,
  steerUsage,
  btwUsage,
  btwPendingLine,
  btwAnsweredLine,
  btwEndedLine,
  btwStoppedLine,
  btwLostLine,
  btwRefusedLine,
  btwWaitingLine,
  queueAck,
  queueStarted,
  queueDropped,
  queueRunningNow,
  queueFull,
  statusHeader,
  idleLaneLine,
  newSessionLine,
  attachmentNoun,
  attachmentAck,
  steeredInAck,
  replyQuoteFrameNote,
  attachmentFrameNote,
  codexSubView,
  tightenAccountView,
  compactingLine,
  compactQueuedLine,
  compactDoneLine,
  compactDiscardedLine,
  WALL_TICK_MS,
  limitWallLine,
  limitWallResolved,
  swapFailedLine,
  chatRotatedLine,
  chatWalledRetryLine,
  bothWalledLine,
  enginesBackLine,
} from './system-messages.mjs';
import { readFileSync } from 'node:fs';
import { escHtml } from './md-format.mjs';

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

// ---------------------------------------------------------------------------
// The mechanical house-style gates, exported so every later block reuses them.
// ---------------------------------------------------------------------------

export const LINE_MAX = 44; // where his phone wraps; the spec targets 40

/** No em dash, no en dash, anywhere. */
export const noDashes = (s, where) => {
  const hits = String(s).match(/[–—]/g);
  if (hits) throw new Error(`${where}: ${hits.length} em/en dash(es) in\n${s}`);
};

/**
 * Every line fits the bubble. A path and a quoted brief title are exempt: both
 * are the owner's own strings, they are already clipped at their source, and
 * shortening them further would lose the identifying tail.
 */
export const linesFit = (s, where, { exempt = () => false } = {}) => {
  for (const line of String(s).split('\n')) {
    if (line.length <= LINE_MAX) continue;
    if (exempt(line)) continue;
    if (/[~/]/.test(line) || /^["“]/.test(line.trim())) continue; // a path or a quoted title
    throw new Error(`${where}: line of ${line.length} chars (max ${LINE_MAX})\n  ${line}`);
  }
};

/** Footers carry state, elapsed and work done. Never tokens, never a model. */
export const noTokensOrModels = (s, where) => {
  if (/\b\d[\d,.]*\s*(?:tokens?|tok|k tokens)\b/i.test(s)) throw new Error(`${where}: token count in\n${s}`);
  if (/\b(?:opus|sonnet|haiku|fable|gpt-[\d.]+|claude-(?:opus|sonnet|haiku|fable|\d)[a-z\d-]*)\b/i.test(s)) {
    throw new Error(`${where}: model name in\n${s}`);
  }
};

/** Run all three over one built message. */
export const houseStyle = (s, where, opts) => {
  noDashes(s, where);
  linesFit(s, where, opts);
  noTokensOrModels(s, where);
};

// ---------------------------------------------------------------------------
// visibleOnly, the plain-text fallback rule
// ---------------------------------------------------------------------------

t('visibleOnly: drops the blockquote BODY, not just its tags', () => {
  const html = '<b>📖 Help</b>\nthe index<blockquote expandable>the whole 4,700-char reference</blockquote>';
  const plain = visibleOnly(html);
  ok(!plain.includes('4,700'), 'the reference body must never reach the plain fallback');
  ok(plain.includes('📖 Help'), 'the visible part survives');
  ok(plain.includes('the index'), 'the visible part survives');
  eq(plain, '📖 Help\nthe index', 'exactly the visible part, tags and body both gone');
});

t('visibleOnly: two blockquotes do not swallow the text between them', () => {
  const html = 'one<blockquote expandable>A</blockquote>two<blockquote expandable>B</blockquote>three';
  eq(visibleOnly(html), 'onetwothree', 'non-greedy match, both bodies gone');
});

t('visibleOnly: un-escapes what escHtml escaped, ampersand last', () => {
  eq(visibleOnly('a &lt;b&gt; &amp; c'), 'a <b> & c');
  eq(visibleOnly('&amp;lt;'), '&lt;', 'a literal &lt; in the source stays literal');
});

t('visibleOnly: a message with no blockquote is just de-tagged', () => {
  eq(visibleOnly('<b>✅ Done</b> · 8s'), '✅ Done · 8s');
});

t('visibleOnly: tolerates null and undefined', () => {
  eq(visibleOnly(null), '');
  eq(visibleOnly(undefined), '');
});

// ---------------------------------------------------------------------------
// The small shared pieces
// ---------------------------------------------------------------------------

t('workerCount / stepCount: singular, plural, and nothing at zero', () => {
  eq(workerCount(1), '1 worker');
  eq(workerCount(2), '2 workers');
  eq(workerCount(0), null, 'zero is omitted rather than printed');
  eq(workerCount(undefined), null);
  eq(stepCount(1), '1 step');
  eq(stepCount(214), '214 steps');
  eq(stepCount(0), '', 'no steps yet is empty, not "0 steps"');
});

// ---------------------------------------------------------------------------
// /restart
// ---------------------------------------------------------------------------

t('restart: one line out, and it says nothing it cannot keep', () => {
  eq(restartingLine(), '🔄 Restarting…');
  houseStyle(restartingLine(), 'restartingLine');
});

t('restart: the terminal state the new process edits it into', () => {
  eq(restartResolvedLine({ elapsedSec: 4, workers: 2 }), '✅ Back online · 4s\n🌙 2 workers re-attached');
  eq(restartResolvedLine({ elapsedSec: 4, workers: 0 }), '✅ Back online · 4s', 'no survivors, no second line');
  eq(restartResolvedLine({}), '✅ Back online', 'an unknown elapsed is omitted, never guessed');
  houseStyle(restartResolvedLine({ elapsedSec: 4, workers: 2 }), 'restartResolvedLine');
});

t('restart: the ⏳ line and its terminal state are different messages of one', () => {
  ok(restartingLine().startsWith('🔄'), 'in progress');
  ok(restartResolvedLine({ elapsedSec: 1 }).startsWith('✅'), 'terminal');
});

t('boot: a fresh /restart request is edited, cooldown or not', () => {
  const now = 1_000_000;
  const plan = bootAnnouncePlan({ restartMsg: { id: 42, at: now - 4000 }, lastAnnounce: now - 1000, now });
  eq(plan.kind, 'edit', 'an explicitly requested restart must never be suppressed by the cooldown');
  eq(plan.id, 42);
  eq(plan.elapsedSec, 4);
  eq(plan.dropRestart, true, 'a resolved request must not resolve twice on the next boot');
});

t('boot: a stale /restart request falls back, and is cleared either way', () => {
  const now = 1_000_000;
  const stale = { id: 42, at: now - 6 * 60 * 1000 };
  const cold = bootAnnouncePlan({ restartMsg: stale, lastAnnounce: 0, now });
  eq(cold.kind, 'announce', 'past the window, this boot is not the one he asked for');
  eq(cold.dropRestart, true, 'the stale request is cleared so it cannot fire on a later boot');
  const warm = bootAnnouncePlan({ restartMsg: stale, lastAnnounce: now - 1000, now });
  eq(warm.kind, 'silent', 'inside the cooldown, an unrequested boot still says nothing');
  eq(warm.dropRestart, true);
});

t('boot: no request at all behaves exactly as it did before', () => {
  const now = 1_000_000;
  eq(bootAnnouncePlan({ lastAnnounce: 0, now }).kind, 'announce');
  eq(bootAnnouncePlan({ lastAnnounce: now - 1000, now }).kind, 'silent');
  eq(bootAnnouncePlan({ lastAnnounce: 0, now }).dropRestart, false, 'nothing to clear');
});

t('boot: a request with a clock from the future is not trusted', () => {
  const now = 1_000_000;
  const plan = bootAnnouncePlan({ restartMsg: { id: 7, at: now + 60_000 }, lastAnnounce: 0, now });
  eq(plan.kind, 'announce', 'a negative age is a clock jump, not a 60s-old restart');
});

// ---------------------------------------------------------------------------
// A command's own fetch
// ---------------------------------------------------------------------------

t('fetch: the instant line, and the clock that only appears once it matters', () => {
  eq(fetchingLine('Reading plan usage'), '📊 Reading plan usage…', '"0s" reads like a bug');
  eq(fetchingLine('Reading plan usage', 3), '📊 Reading plan usage… · 3s');
  eq(fetchingLine('Reading plan usage', 75), '📊 Reading plan usage… · 1m 15s');
  houseStyle(fetchingLine('Reading plan usage', 3), 'fetchingLine');
});

t('fetch: the failure is the other terminal state of the same message', () => {
  eq(fetchFailedLine('plan usage', 'socket hang up'), '❌ Could not read plan usage\nsocket hang up');
  eq(fetchFailedLine('plan usage', ''), '❌ Could not read plan usage', 'no detail, no empty second line');
  const long = fetchFailedLine('plan usage', 'x'.repeat(400));
  ok(long.split('\n')[1].length <= 80, 'a stack trace must not become the message');
  ok(long.endsWith('…'), 'and the cut is marked');
});

// ---------------------------------------------------------------------------
// The daemon dispatching into the chat lane on its own
// ---------------------------------------------------------------------------

t('dead worker: what he sees, and the one edit it becomes', () => {
  const args = { lane: 'bg2', elapsedSec: 2460, title: 'Fix the engine-switch message' };
  eq(deadWorkerLine(args), '⚠️ bg2 died after 41m\nFix the engine-switch message\nChecking what survived…');
  eq(
    deadWorkerLine({ ...args, phase: 'salvaging' }),
    '⚠️ bg2 died after 41m\nFix the engine-switch message\nLeash is going through the salvage now.',
  );
  houseStyle(deadWorkerLine(args), 'deadWorkerLine');
});

t('dead worker: the OUTCOME is never in the system message', () => {
  const s = deadWorkerLine({ lane: 'bg2', elapsedSec: 60, title: 'x' });
  ok(!/salvag(ed|e found)|recovered|nothing survived/i.test(s), 'that is M\'s to say in her own words');
});

t('dead worker: an unknown age is omitted rather than guessed', () => {
  eq(deadWorkerLine({ lane: 'bg2', title: 'x' }).split('\n')[0], '⚠️ bg2 died');
  eq(deadWorkerLine({ lane: 'bg2', elapsedSec: 0, title: 'x' }).split('\n')[0], '⚠️ bg2 died');
});

t('dead worker: a title long enough to be a brief is clipped and marked', () => {
  const s = deadWorkerLine({ lane: 'bg2', elapsedSec: 60, title: 'y'.repeat(300) });
  const title = s.split('\n')[1];
  ok(title.length <= 90, `${title.length} chars`);
  ok(title.endsWith('…'), 'the cut is always marked');
});

t('chain paused: two lines, and the second one is the reassurance', () => {
  eq(chainPausedLine(6), '⏸ Worker chain paused · 6 reports in a row\nNothing is lost. Send anything to resume.');
  houseStyle(chainPausedLine(6), 'chainPausedLine');
});

t('codex catch-up: the cause of a bubble he did not ask for', () => {
  eq(codexCatchUpLine(3), '▶️ Claude is back\n🧠 Catching Leash up on 3 Codex answers');
  eq(codexCatchUpLine(1), '▶️ Claude is back\n🧠 Catching Leash up on 1 Codex answer');
  houseStyle(codexCatchUpLine(3), 'codexCatchUpLine');
});

t('★ a steer that was acked and then refused is corrected, naming the run', () => {
  // The ack has already said "steered into codex". A background job has one
  // turn, so unlike the chat lane there is nothing to queue it onto: this line
  // is the whole correction, and re-sending is done by run id.
  const line = codexSteerLostLine({ lane: 'codex', runId: 'codex-1788453512237', why: 'the Codex turn had already finished' });
  ok(line.startsWith('❌ Not steered · codex'), line);
  ok(line.includes('the Codex turn had already finished.'), line);
  ok(line.includes('/steer codex-1788453512237 <instruction>'), line);
  houseStyle(line, 'codexSteerLostLine');
  houseStyle(codexSteerLostLine({}), 'codexSteerLostLine bare');
  ok(!codexSteerLostLine({ lane: 'codex' }).includes('/steer'), 'no run id, no command: a placeholder is worse than nothing');
});

t('a resumed background Codex job says so in one line, in the house style', () => {
  const line = codexResumedLine({ lane: 'codex', title: 'finish the migration' });
  ok(line.startsWith('🧠 Resumed · codex'), line);
  ok(line.includes('the thread survived'), line);
  houseStyle(line, 'codexResumedLine');
  houseStyle(codexResumedLine({}), 'codexResumedLine bare');
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

t('errors: the four classes that have different answers', () => {
  eq(classifyClaudeFailure('API Error: 400 credit balance is too low'), 'credit');
  eq(classifyClaudeFailure('401 Unauthorized'), 'auth');
  eq(classifyClaudeFailure('429 rate_limit_error'), 'rate_limit');
  eq(classifyClaudeFailure("You've hit your session limit"), 'rate_limit');
  eq(classifyClaudeFailure('spawn claude ENOENT'), 'missing');
  eq(classifyClaudeFailure('exit code 1'), 'other');
});

t('errors: the "out of usage credits" wall is a limit, not a billing state', () => {
  // A Max account whose window is spent says this. Classed as credit it would
  // send them to a payment screen; classed as other it renders as a bare
  // error, which is what it did on 2026-09-10 while two accounts sat free.
  eq(
    classifyClaudeFailure(
      "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
    ),
    'rate_limit',
  );
  eq(classifyClaudeFailure('claude.ai/settings/usage?from=cc_cli_limit_message'), 'rate_limit', 'the parameter alone');
  eq(classifyClaudeFailure('API Error: 400 credit balance is too low'), 'credit', 'a real billing state is untouched');
});

t('errors: credit beats auth, or he is sent to the wrong screen', () => {
  // "credit balance is too low" arrives as an authentication-shaped API error.
  eq(classifyClaudeFailure('Authentication error: your credit balance is too low'), 'credit');
});

t('errors: every class has a remedy, and "other" honestly has none', () => {
  ok(claudeFailureRemedy('credit').includes('/account'));
  ok(claudeFailureRemedy('rate_limit').includes('/usage'));
  eq(claudeFailureRemedy('other'), null, 'a made-up remedy is worse than no line');
});

t('errors: ★ the shape is a cause, a remedy, and one tap', () => {
  const e = errorMessage({
    title: 'Claude run failed',
    detail: 'credit balance is too low',
    remedy: claudeFailureRemedy('credit'),
    full: 'x'.repeat(4000),
  });
  eq(
    e.visible,
    '❌ Claude run failed\ncredit balance is too low\n👤 /account to swap · /usage for limits\n▸ tap for the full error',
  );
  ok(!e.visible.includes('xxxx'), '★ the raw tail must never be in the visible part');
  ok(e.body.length <= 3300, 'and the body itself is bounded so the message still fits');
  houseStyle(e.visible, 'errorMessage');
});

t('errors: the tail is kept from the END, where the failure actually is', () => {
  const e = errorMessage({ title: 'x', full: 'BANNER' + 'y'.repeat(4000) + 'THE REAL ERROR' });
  ok(e.body.endsWith('THE REAL ERROR'), 'the last lines are the ones that say what happened');
  ok(!e.body.includes('BANNER'), 'a 4,000-char banner is not worth the room');
  ok(e.body.startsWith('…'), 'and the cut is marked');
});

t('errors: no body means no "tap" line promising one', () => {
  const e = errorMessage({ title: 'Could not fetch the photo', detail: 'socket hang up' });
  eq(e.visible, '❌ Could not fetch the photo\nsocket hang up');
  eq(e.body, '');
});

t('errors: a body that only repeats the detail is not offered as a tap', () => {
  const e = errorMessage({ title: 'x', detail: 'socket hang up', full: 'socket hang up' });
  eq(e.body, '', 'one tap that reveals the line above it is a broken promise');
  ok(!e.visible.includes('▸'));
});

t('errors: ⚠️ for a degradation the daemon recovered from', () => {
  const e = errorMessage({ glyph: '⚠️', title: 'schedules.json was unreadable', detail: 'Schedules are empty until re-added.', full: 'EJSONPARSE' });
  ok(e.visible.startsWith('⚠️ '), 'a red cross would read as "the bridge is down"');
  houseStyle(e.visible, 'errorMessage warning');
});

t('errors: the detail line skips banner noise and stack frames', () => {
  eq(firstMeaningfulLine('\n\nError:\n  at Module._compile\nAPI Error: 400 bad request'), 'API Error: 400 bad request');
  eq(firstMeaningfulLine('Error: socket hang up'), 'socket hang up', 'the word "Error" is not the detail');
  eq(firstMeaningfulLine(''), '');
  eq(firstMeaningfulLine(null), '');
});

t('errors: a one-line detail is clipped, never a wrapped paragraph', () => {
  const e = errorMessage({ title: 'x', detail: 'z'.repeat(400) });
  const line = e.visible.split('\n')[1];
  ok(line.length <= 120, `${line.length} chars`);
  ok(line.endsWith('…'), 'the cut is marked');
});

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

// Read from bridge.mjs rather than hardcoded, so a command added to the daemon
// and forgotten in the index fails HERE instead of quietly becoming
// undiscoverable. An index has that failure mode; a 120-line wall does not, and
// that is the one thing the wall was better at.
const BRIDGE_SRC = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');
const RESERVED = (/const RESERVED_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(BRIDGE_SRC)?.[1] ?? '')
  .split('\n')
  .map((l) => /'(\/[a-z]+)'/.exec(l)?.[1])
  .filter(Boolean);

// /start is an alias of /help and /accounts an alias of /account: both are
// reserved so the passthrough does not eat them, and neither is a command he
// needs listed twice.
const HELP_ALIASES = new Set(['/start', '/accounts']);

t('help: ★ every command the daemon reserves is in the index', () => {
  ok(RESERVED.length >= 20, `only found ${RESERVED.length} reserved commands, did the parse break?`);
  const listed = new Set(HELP_GROUPS.flatMap((g) => g.commands));
  const missing = RESERVED.filter((c) => !listed.has(c) && !HELP_ALIASES.has(c));
  eq(missing.join(' '), '', 'a command missing from the index is one he can no longer discover');
});

t('help: and the index invents nothing the daemon does not answer', () => {
  const reserved = new Set(RESERVED);
  const invented = HELP_GROUPS.flatMap((g) => g.commands).filter((c) => !reserved.has(c));
  eq(invented.join(' '), '', 'a listed command the switch does not handle would fall through to Claude');
});

t('help: no command is listed in two groups', () => {
  const all = HELP_GROUPS.flatMap((g) => g.commands);
  eq(all.length, new Set(all).size, 'one home per command, or the index stops being scannable');
});

t('help: the index is what the phone shows, and the reference is behind it', () => {
  const h = helpMessage({ name: 'Leash', host: 'dev-box', reference: 'THE WHOLE REFERENCE' });
  eq(h.visible.split('\n')[0], '📖 Leash on dev-box');
  eq(h.visible.split('\n')[1], 'Send any text · it runs and replies.');
  ok(!h.visible.includes('THE WHOLE REFERENCE'), '★ the reference must not be in the visible part');
  eq(h.body, 'THE WHOLE REFERENCE');
  ok(h.visible.endsWith('▸ tap for the full reference'));
  ok(h.visible.split('\n').length <= 12, `${h.visible.split('\n').length} lines, it was 120`);
  houseStyle(h.visible, 'helpMessage');
});

t('help: no reference, no tap line promising one', () => {
  const h = helpMessage({ name: 'Leash', host: 'somewhere' });
  ok(!h.visible.includes('▸'));
  eq(h.body, '');
});

t('help: an oversized reference loses its tail VISIBLY, not the whole message', () => {
  const h = helpMessage({ name: 'Leash', reference: 'z'.repeat(HELP_BODY_MAX + 500) });
  ok(h.body.length <= HELP_BODY_MAX + 40, `${h.body.length} chars`);
  ok(h.body.endsWith('… the rest is in README.md'), 'a silent truncation reads as "that was all of it"');
});

// How much room the composed /help must have left over. Not a style rule: the
// message is composed from a reference that grows every time a command lands,
// and a budget met EXACTLY is one line away from silently amputating its own
// tail. 40 characters is about one short sentence of warning.
const HELP_HEADROOM_MIN = 40;

const composedHelp = (raw) => {
  // escape: escHtml, because the budget is on what actually GOES OUT. Measuring
  // the raw literal understates it (every < > & expands), which is how a /help
  // that "fit" arrived with its last paragraph missing.
  const h = helpMessage({ name: 'Leash', host: 'dev-box', reference: raw, escape: escHtml });
  return { h, composed: escHtml(h.visible).length + escHtml(h.body).length + 37 };
};

t('help: ★ the real HELP reference reaches the phone WHOLE, not just legally', () => {
  const raw = /^const HELP = `([\s\S]*?)`;$/m.exec(BRIDGE_SRC)?.[1] ?? '';
  ok(raw.length > 2000, 'the reference itself went missing');
  // The interpolations resolve to values SHORTER than their source, so the
  // literal is the worst case.
  const { h, composed } = composedHelp(raw);
  ok(composed <= HELP_COMPOSED_MAX, `${composed} chars, over the ${HELP_COMPOSED_MAX} budget`);
  // AND it arrives whole. The composed check above passes just as happily when
  // the body has been CUT, because cutting it is what brings the length down:
  // the reference was silently over HELP_BODY_MAX and the tail (the attachments
  // paragraph and the notes line) never reached the phone at all, while every
  // gate stayed green.
  ok(!h.body.includes('… the rest is in README.md'), `the reference is ${raw.length} chars and is being truncated`);
  ok(h.body.includes('Notes: one chat-lane task at a time'), '★ the LAST line of the reference survived');
});

t('help: ★ /btw is discoverable in BOTH halves, and the message still has room', () => {
  // The index is what gets scanned; the reference is what gets read once. A
  // command in neither is a command that does not exist, and the composed
  // budget is the reason a new line has to be PAID FOR rather than appended.
  const raw = /^const HELP = `([\s\S]*?)`;$/m.exec(BRIDGE_SRC)?.[1] ?? '';
  ok(HELP_GROUPS.some((g) => g.commands.includes('/btw')), 'the index');
  ok(/\/btw \[target\] <question>/.test(raw), 'the reference');
  const { composed } = composedHelp(raw);
  const headroom = HELP_COMPOSED_MAX - composed;
  ok(headroom >= HELP_HEADROOM_MIN, `${headroom} chars of headroom, under the ${HELP_HEADROOM_MIN} this needs`);
});

// ---------------------------------------------------------------------------
// The worker block: one renderer for /status and /steer
// ---------------------------------------------------------------------------

const W = { lane: 'bg2', elapsedSec: 1080, steps: 214, title: 'Fix the engine-switch message', lastAct: '💻 Bash npm test', steerable: true };

t('worker block: exactly the shape the mock sheet shows', () => {
  eq(
    workerStatusBlock(W, { steerHint: true }),
    '🌙 bg2 · 🟢 running 18m · 214 steps\n   "Fix the engine-switch message"\n   ↳ 💻 Bash npm test\n   steerable · /steer bg2 <text>',
  );
});

t('worker block: the emoji is the marker, never bold on top of it', () => {
  const s = workerStatusBlock(W, { steerHint: true });
  ok(!s.includes('**'), 'bold on an emoji is two markers for one job');
  ok(!s.includes('<b>'));
  noDashes(s, 'workerStatusBlock');
});

t('worker block: continuation rows share the one indent the bars use', () => {
  for (const line of workerStatusBlock(W).split('\n').slice(1)) {
    eq(line.slice(0, 3), '   ', `a ragged edge in a proportional font: ${JSON.stringify(line)}`);
  }
});

t('worker block: a survivor is running AND unreachable, and says both', () => {
  const s = workerStatusBlock({ ...W, steerable: false, note: 'survived a restart' });
  ok(s.includes('not steerable · survived a restart'), s);
  ok(!s.includes('/steer bg2'), 'never offer a command that would be acked as delivered and do nothing');
});

t('worker block: no steer hint unless asked, since /steer already taught it', () => {
  ok(!workerStatusBlock(W).includes('/steer bg2 <text>'));
  ok(workerStatusBlock(W).includes('steerable'));
});

t('worker block: omits what it does not know rather than printing zeroes', () => {
  const s = workerStatusBlock({ lane: 'bg', state: 'running' });
  eq(s, '🌙 bg · 🟢 running\n   not steerable', 'no "0 steps", no empty quotes, no bare arrow');
});

t('worker block: a Codex run gets its own glyph and its own state', () => {
  const s = workerStatusBlock({ icon: '🧠', lane: 'codex', elapsedSec: 120, title: 'review the diff', steerable: false });
  ok(s.startsWith('🧠 codex · 🟢 running 2m'), s);
});

t('worker block: steers and a queue ride along when there are any', () => {
  const s = workerStatusBlock({ ...W, steers: 2, queued: 1 }, { steerHint: true });
  ok(s.includes('2 steered in'), s);
  ok(s.includes('📥 1 queued'), s);
});

t('steer usage: two lines, then the same blocks /status shows', () => {
  eq(
    steerUsage([W]),
    'Usage: /steer <lane|latest> <instruction>\nIt keeps the context it has already built.\n\n🌙 bg2 · 🟢 running 18m · 214 steps\n   "Fix the engine-switch message"\n   ↳ 💻 Bash npm test\n   steerable',
  );
});

t('steer usage: no workers is a sentence, not an empty table', () => {
  ok(steerUsage([]).includes('⚪ No background workers running.'));
  ok(steerUsage().includes('⚪ No background workers running.'), 'and undefined does not throw');
});

t('steer usage: nothing in it is a fixed-width column', () => {
  const s = steerUsage([W, { ...W, lane: 'bg3' }]);
  ok(!/ {4,}/.test(s.replace(/^ {3}/gm, '')), 'padEnd alignment does not survive a proportional font');
});

// ---------------------------------------------------------------------------
// /btw: one message, five states, and every pending line has an ending some
// builder here produces. This is rule 8 applied to a side question, and the
// reason it gets its own block is that a btw has MORE endings than anything
// else in this file: the worker can answer, the run can end, it can be
// stopped, the daemon can restart under it, and it can simply take a very
// long time.
// ---------------------------------------------------------------------------

t('btw usage: what it is, and what it explicitly is not', () => {
  eq(
    btwUsage([W]),
    'Usage: /btw <lane|latest> <question>\nA side question · it changes nothing.\nThe answer comes back here.\n\n🌙 bg2 · 🟢 running 18m · 214 steps\n   "Fix the engine-switch message"\n   ↳ 💻 Bash npm test\n   steerable',
  );
  ok(btwUsage([]).includes('⚪ No background workers running.'));
  ok(btwUsage().includes('⚪ No background workers running.'), 'and undefined does not throw');
});

t('btw: the pending line says asked, not started', () => {
  eq(btwPendingLine({ lane: 'bg2' }), '⏳ btw · bg2\nAsked · waiting for the answer');
  eq(btwPendingLine({ lane: 'bg2', elapsedSec: 252 }), '⏳ btw · bg2 · 4m 12s\nAsked · waiting for the answer');
});

t('btw: the answer arrives under a receipt naming the worker and the wait', () => {
  eq(btwAnsweredLine({ lane: 'bg2', elapsedSec: 41, answer: 'delta-agents, on main' }), '✅ btw · bg2 · 41s\ndelta-agents, on main');
});

t('btw: a multi-line answer is passed through whole, never clipped', () => {
  const answer = 'three things\nthe migration applied\nthe worker is on step 41\nand the suite is green';
  ok(btwAnsweredLine({ lane: 'bg', elapsedSec: 1, answer }).endsWith(answer), 'the one thing the message exists to deliver');
});

t('btw: an answer too big for one message says where it went', () => {
  const s = btwAnsweredLine({ lane: 'bg', elapsedSec: 5, answer: 'QQQQ'.repeat(2250), spilled: true });
  eq(s, '✅ btw · bg · 5s\nThe answer is in the next message.');
  ok(!s.includes('QQQQ'), '★ a ✅ with a truncated fragment under it reads as the whole answer');
});

t('btw: an empty answer says so rather than showing a bare tick', () => {
  eq(btwAnsweredLine({ lane: 'bg', elapsedSec: 2, answer: '   ' }), '✅ btw · bg · 2s\n(the worker answered with nothing)');
});

t('btw: ★ the run ending is not silence, and it points at the report', () => {
  eq(btwEndedLine({ lane: 'bg2' }), '❌ btw · bg2 · no answer\nThe worker ended without answering.\nIts report may still carry it.');
});

t('btw: ★ a deliberate /stop is a stop glyph, not a failure', () => {
  const s = btwStoppedLine({ lane: 'bg2' });
  ok(s.startsWith('🛑'), `reading your own stop as "something went wrong" is the one outcome that must not surprise: ${s}`);
  eq(s, '🛑 btw · bg2 · stopped\nThe worker was stopped before it answered.');
});

t('btw: ★ a daemon restart resolves what it can no longer hear', () => {
  eq(
    btwLostLine({ lane: 'bg2' }),
    '❌ btw · bg2 · answer lost\nThe daemon restarted while it waited.\nThat worker cannot be asked again;\nits report may still carry it.',
  );
  // ★ NOT "ask again once it is back". A worker that survived the restart is
  // re-attached by its log with no pipe to its stdin, so /btw at it is refused
  // for the rest of its life: telling him to retry would be a line that lies.
  ok(!/[Aa]sk again once/.test(btwLostLine({ lane: 'bg2' })), 'never name a retry the next command refuses');
});

t('btw: ★ and the opposite line for the one worker a restart brings BACK', () => {
  // A background Codex job on the app-server is resumed on the next boot, so
  // "that worker cannot be asked again" is exactly wrong for it: it is alive and
  // steerable seconds later, and the Resumed message lands right under this one.
  // The question is still lost either way, because the turn carrying it died.
  const s = btwLostLine({ lane: 'codex', resumable: true });
  ok(s.includes('The daemon restarted while it waited.'), s);
  ok(s.includes('The job was resumed. Ask again.'), s);
  ok(!/cannot be asked again/.test(s), '★ the survivor wording must not reach a job that is coming back');
  ok(!/cannot be asked again/.test(s) && /cannot be asked again/.test(btwLostLine({ lane: 'bg2' })), 'and the default is unchanged');
});

t('btw: ★ a question the server never took is not the same as one the worker ignored', () => {
  // The sixth ending, and the only one where the worker did nothing. `ended`
  // would say "Its report may still carry it" over a job that never saw the
  // question, and `lost` would blame a restart that did not happen. What the
  // owner needs to know is that the job is still there and asking again works.
  const s = btwRefusedLine({ lane: 'bg2', why: 'the Codex turn had already finished' });
  eq(s, '❌ btw · bg2 · not delivered\nthe Codex turn had already finished.\nThe job is still running. Ask again.');
  ok(!btwRefusedLine({ lane: 'bg2' }).includes('undefined'), 'it renders with no reason at all');
});

t('btw: ★ fifteen minutes is a sentence, not an ending', () => {
  const s = btwWaitingLine({ lane: 'bg2', elapsedSec: 900 });
  ok(s.includes('15m, no answer yet'), s);
  ok(/may still answer/.test(s), 'the listener stays on, so the text must not read as a giving up');
  ok(/report will carry it/.test(s), 'and the fallback is named');
  ok(btwWaitingLine({ lane: 'bg' }).includes('no answer yet'), 'and it renders with no clock at all');
});

t('btw: a long lane name is bounded rather than allowed to wrap the head', () => {
  const s = btwPendingLine({ lane: 'x'.repeat(60) });
  for (const line of s.split('\n')) ok(line.length <= LINE_MAX, `line of ${line.length}: ${line}`);
});

t('btw: every state renders with no arguments at all', () => {
  for (const [name, fn] of [
    ['btwPendingLine', btwPendingLine],
    ['btwAnsweredLine', btwAnsweredLine],
    ['btwEndedLine', btwEndedLine],
    ['btwStoppedLine', btwStoppedLine],
    ['btwLostLine', btwLostLine],
    ['btwRefusedLine', btwRefusedLine],
    ['btwWaitingLine', btwWaitingLine],
  ]) {
    ok(fn().includes('btw'), `${name} must degrade rather than throw`);
    ok(fn().includes('the worker'), `${name}: an unnamed lane still needs a subject`);
  }
});

t('btw: ★ the state list at the head of the section names every builder that exists', () => {
  // That comment is the checklist a NEW ending gets held against ("does this ⏳
  // have a terminal builder?"), so a builder missing from it is a builder the
  // next reader will not know to look for. btwRefusedLine was added as the
  // sixth ending, and its twin list in bridge.mjs had fallen behind the same way.
  const src = readFileSync(new URL('./system-messages.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('//   btwPendingLine');
  ok(at > 0, 'the state list was not found, did the header get rewritten?');
  const list = src.slice(at, src.indexOf('// ------', at));
  for (const name of ['btwPendingLine', 'btwAnsweredLine', 'btwEndedLine', 'btwStoppedLine', 'btwLostLine', 'btwRefusedLine', 'btwWaitingLine']) {
    ok(list.includes(name), `★ ${name} exists but the state list does not mention it`);
  }
});

t('btw: ★ every pending state here has a terminal glyph another builder produces', () => {
  // Rule 8, mechanically. The pending line is the only ⏳, and each of the four
  // endings is a different builder, so a state that lost its path would show up
  // here as a glyph nothing produces.
  ok(btwPendingLine({ lane: 'bg' }).startsWith('⏳'), 'the wait glyph');
  const endings = [btwAnsweredLine({ lane: 'bg', answer: 'y' }), btwEndedLine({ lane: 'bg' }), btwStoppedLine({ lane: 'bg' }), btwLostLine({ lane: 'bg' }), btwRefusedLine({ lane: 'bg' })];
  eq(new Set(endings.map((s) => s.slice(0, 2).trim())).size, 3, 'answered ✅, stopped 🛑, and ❌ for the three losses');
  for (const s of endings) ok(!s.startsWith('⏳'), `an ending that is still a wait is not an ending: ${s}`);
});

t('btw: ★ every shape passes the house-style gates', () => {
  // The ANSWER is the worker's own string and is exempt for the same reason a
  // path and a quoted brief title are: it is not the daemon's prose, and the
  // send path already splits it at Telegram's limit. Everything this file
  // AUTHORS is gated, which is what the frame-only pass below proves.
  const answer = 'delta-agents, on main, and the migration applied at 17:04 with 41 rows written';
  const exempt = (line) => answer.includes(line);
  for (const [where, s] of [
    ['btwUsage', btwUsage([W])],
    ['btwUsage/empty', btwUsage([])],
    ['btwPendingLine', btwPendingLine({ lane: 'bg2', elapsedSec: 252 })],
    ['btwPendingLine/fresh', btwPendingLine({ lane: 'bg2' })],
    ['btwAnsweredLine', btwAnsweredLine({ lane: 'bg2', elapsedSec: 41, answer: 'yes' })],
    ['btwAnsweredLine/long', btwAnsweredLine({ lane: 'bg2', elapsedSec: 41, answer })],
    ['btwAnsweredLine/spilled', btwAnsweredLine({ lane: 'bg2', elapsedSec: 41, answer, spilled: true })],
    ['btwAnsweredLine/empty', btwAnsweredLine({ lane: 'bg2', elapsedSec: 41 })],
    ['btwEndedLine', btwEndedLine({ lane: 'bg2' })],
    ['btwStoppedLine', btwStoppedLine({ lane: 'bg2' })],
    ['btwLostLine', btwLostLine({ lane: 'bg2' })],
    ['btwRefusedLine', btwRefusedLine({ lane: 'bg2', why: 'the ChatGPT window is used up' })],
    ['btwRefusedLine/noreason', btwRefusedLine({ lane: 'bg2' })],
    ['btwWaitingLine', btwWaitingLine({ lane: 'bg2', elapsedSec: 900 })],
    ['btwWaitingLine/noclock', btwWaitingLine({ lane: 'bg2' })],
  ]) {
    houseStyle(s, where, { exempt });
  }
});

t('btw: ★ the FRAME alone, with no worker text in it, passes unexempted', () => {
  // The gate above waives the answer line. This one proves the waiver is not
  // load bearing: with a one-word answer, every line of every state is the
  // daemon's own prose and all three gates apply with no exemption at all.
  for (const [where, s] of [
    ['btwPendingLine', btwPendingLine({ lane: 'bg2', elapsedSec: 252 })],
    ['btwAnsweredLine', btwAnsweredLine({ lane: 'bg2', elapsedSec: 41, answer: 'ok' })],
    ['btwAnsweredLine/spilled', btwAnsweredLine({ lane: 'bg2', elapsedSec: 41, answer: 'ok', spilled: true })],
    ['btwEndedLine', btwEndedLine({ lane: 'bg2' })],
    ['btwStoppedLine', btwStoppedLine({ lane: 'bg2' })],
    ['btwLostLine', btwLostLine({ lane: 'bg2' })],
    ['btwRefusedLine', btwRefusedLine({ lane: 'bg2', why: 'the ChatGPT window is used up' })],
    ['btwWaitingLine', btwWaitingLine({ lane: 'bg2', elapsedSec: 900 })],
  ]) {
    houseStyle(s, where);
  }
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

t('queue: position, engine, and what it is actually waiting on', () => {
  eq(
    queueAck({ position: 2, engine: 'claude', waitingOn: 'audit the system messages' }),
    '📥 Queued · #2 in line · 🤖 Claude\nWaiting on: "audit the system messages"',
  );
  eq(queueAck({ position: 1, engine: 'codex' }), '📥 Queued · #1 · 🧠 Codex', '"#1 in line" reads wrong at the front');
  houseStyle(queueAck({ position: 2, engine: 'claude', waitingOn: 'audit the system messages' }), 'queueAck');
});

t('queue: the reason line only appears when there IS one', () => {
  const s = queueAck({ position: 1, engine: 'codex', reason: 'Codex could not take it mid-turn: turn settled' });
  eq(s.split('\n').length, 2);
  ok(s.includes('turn settled'));
});

t('queue: a long refusal reason is clipped, and the cut is marked', () => {
  const s = queueAck({ position: 1, engine: 'codex', reason: 'q'.repeat(400) });
  const line = s.split('\n')[1];
  ok(line.length <= 120, `${line.length} chars`);
  ok(line.endsWith('…'));
});

t('queue: the two terminal states, and neither is a second message', () => {
  eq(queueStarted({ waitedSec: 220 }), '▶️ Started · waited 3m 40s');
  eq(queueStarted({}), '▶️ Started', 'an unknown wait is omitted rather than guessed');
  eq(queueDropped(), '🛑 Dropped from the queue');
  houseStyle(queueStarted({ waitedSec: 220 }), 'queueStarted');
});

t('queue: the refusal that arrived after the turn had already ended', () => {
  eq(queueRunningNow({ engine: 'codex' }), '▶️ Running it now · 🧠 Codex\nThe turn had already finished.');
});

t('queue: full says the number and both ways out', () => {
  eq(queueFull({ lane: 'main', max: 5 }), '⏳ main queue is full (5)\nWait, or /stop main to clear it.');
  houseStyle(queueFull({ lane: 'main', max: 5 }), 'queueFull');
});

t('queue: the glyph alone says which state it is', () => {
  const first = (s) => [...s][0];
  eq(first(queueAck({})), '📥', 'waiting');
  eq(first(queueStarted({})), '▶️'[0], 'running');
  eq(first(queueRunningNow({})), '▶️'[0], 'also running: the same fact, so the same glyph');
  eq(first(queueDropped()), '🛑', 'stopped');
  eq(first(queueFull({})), '⏳', 'blocked on the queue itself');
});

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

const HEADER_ARGS = {
  name: 'Leash',
  host: 'dev-box',
  cwd: '~/dev/claude-telegram-bridge',
  model: 'opus',
  permissions: 'YOLO',
  fallbackOn: true,
  engineLine: '⚙️ engine: chat claude · bg claude',
  session: '7f4e3041',
  ctxPct: 34,
};

t('status: exactly the header the mock sheet shows', () => {
  eq(
    statusHeader(HEADER_ARGS),
    '📍 Leash on dev-box\n📁 ~/dev/claude-telegram-bridge\n🤖 opus · YOLO · fallback on\n⚙️ engine: chat claude · bg claude\n💬 chat 7f4e3041 · ctx 34%',
  );
});

t('status: ★ no bold, no dash, and the middle dot is the only separator', () => {
  const s = statusHeader(HEADER_ARGS);
  ok(!s.includes('**'), 'bold on top of an emoji is two markers for one job');
  noDashes(s, 'statusHeader');
  ok(!/\s[-;]\s/.test(s), 'no dash and no semicolon used structurally');
});

t('status: the model glyph is Claude\'s, not Codex\'s', () => {
  const line = statusHeader(HEADER_ARGS).split('\n')[2];
  ok(line.startsWith('🤖 '), `🧠 is Codex everywhere else in this surface: ${line}`);
});

t('status: everything unknown is omitted, never guessed', () => {
  eq(statusHeader({ name: 'Leash' }), '📍 Leash\n💬 chat fresh', 'no host, no cwd, no model, no ctx, no usage');
  ok(!statusHeader({ name: 'Leash', ctxPct: null }).includes('ctx'), 'an unknown context window prints no percentage');
  ok(!statusHeader({ name: 'Leash', fallbackOn: null }).includes('fallback'));
});

t('status: the engine line only appears when there is one to show', () => {
  ok(!statusHeader({ ...HEADER_ARGS, engineLine: null }).includes('⚙️'), 'a Claude-on-both install gets nothing new');
});

t('status: the usage block arrives whole, with its own indent preserved', () => {
  const usage = '👤 owner@example.com\n   5h ██████░░░░  58% · resets 13:45';
  const s = statusHeader({ ...HEADER_ARGS, usageBlock: usage });
  ok(s.endsWith(usage), 'the bars are the best thing here and must not be re-rendered');
});

t('status: the idle lane keeps its one-liner, in three states', () => {
  eq(idleLaneLine({ lane: 'Background', note: 'spawn on demand' }), '🌙 Background · ⚪ idle · spawn on demand');
  eq(idleLaneLine({ icon: '🤖', lane: 'Chat' }), '🤖 Chat · ⚪ idle');
  eq(idleLaneLine({ icon: '🤖', lane: 'Chat', queued: 2 }), '🤖 Chat · 📥 2 queued');
  eq(idleLaneLine({ icon: '🤖', lane: 'Chat', finishing: true, queued: 1 }), '🤖 Chat · 🟡 wrapping up · 1 queued');
  for (const s of [
    idleLaneLine({}),
    idleLaneLine({ queued: 3 }),
    idleLaneLine({ finishing: true }),
    idleLaneLine({ lane: 'Background', note: 'spawn on demand' }),
  ]) {
    noDashes(s, 'idleLaneLine');
    linesFit(s, 'idleLaneLine');
  }
});

t('status: the chat lane has no steer line, because everything he types goes there', () => {
  const s = workerStatusBlock({ icon: '🤖', lane: 'Chat', elapsedSec: 45, steps: 6, title: 'x' }, { showSteer: false });
  ok(!s.includes('steerable'), s);
  eq(s.split('\n').length, 2, 'header and title only');
});

t('status: a Codex chat turn still says which transport it is on', () => {
  const s = workerStatusBlock(
    { icon: '🧠', lane: 'Chat', elapsedSec: 12, title: 'x', steerable: true, note: 'codex app-server' },
    { showSteer: true },
  );
  ok(s.includes('steerable · codex app-server'), s);
});

// ---------------------------------------------------------------------------
// Limit walls: the clock that cannot rot
// ---------------------------------------------------------------------------

t('wall: the absolute clock leads, the relative one follows', () => {
  eq(
    limitWallLine({ resetClock: '13:45', leftText: '3h 12m', codexTaking: true }),
    '⛔ Every Claude account is limited\n⏳ Resets 13:45 · in 3h 12m\n🧠 Codex is taking chat messages',
  );
});

t('wall: ★ the reset TIME is present whenever it is known', () => {
  // The whole defect: "Earliest reset: 3h 12m from now" read forty minutes
  // later is wrong by forty minutes, and nothing says when it was sent.
  const s = limitWallLine({ resetClock: '13:45', leftText: '3h 12m' });
  ok(s.includes('13:45'), `an absolute clock survives being read late:\n${s}`);
  ok(s.indexOf('13:45') < s.indexOf('3h 12m'), 'the one that cannot rot goes first');
});

t('wall: an unknown reset says so rather than inventing one', () => {
  const s = limitWallLine({});
  ok(s.includes('No reset time is known'), s);
  ok(!s.includes('undefined') && !s.includes('null'), s);
});

t('wall: the third line answers "am I blocked, or is background blocked"', () => {
  ok(limitWallLine({ codexTaking: true }).includes('🧠 Codex is taking chat messages'));
  ok(limitWallLine({ codexTaking: false }).includes('Background work is paused'));
});

t('wall: ★ every ⏳ line here has a ✅ some other builder produces', () => {
  ok(limitWallLine({ resetClock: '13:45' }).includes('⏳'), 'the wait glyph');
  ok(limitWallResolved({ clock: '14:01' }).startsWith('✅'), 'and the state it becomes');
  eq(limitWallResolved({ clock: '14:01', codexAnswered: 4 }), '✅ Claude is back · 14:01\n🧠 Codex answered 4 messages');
  ok(!limitWallResolved({ clock: '14:01', codexAnswered: 0 }).includes('Codex'), 'nothing to report, no line');
  eq(limitWallResolved({ clock: '14:01', codexAnswered: 1 }).split('\n')[1], '🧠 Codex answered 1 message');
});

t('wall: the swap failure says which account he is still on', () => {
  eq(
    swapFailedLine({ error: 'no captured credentials', account: 'owner@example.com' }),
    '⚠️ Session limit hit, swap failed\nno captured credentials\n👤 Still on owner@example.com',
  );
  ok(!swapFailedLine({ error: 'x' }).includes('Still on'), 'an unknown account costs the line, not a guess');
  ok(swapFailedLine({ error: 'y'.repeat(400) }).split('\n')[1].length <= 81, 'a stack trace cannot become the message');
});

t('wall: ★ the CHAT lane says which account went out and which one is live', () => {
  // The bubble they are watching, edited. Before this existed a chat-lane limit
  // came back "❌ Error · 5s" with two free accounts in the store and the
  // account was rotated by hand.
  eq(
    chatRotatedLine({ from: 'first@example.com', to: 'second@example.com' }),
    '🔄 Session limit on first@example.com\n👤 Swapped to second@example.com\n⏳ Retrying your message',
  );
  // A name long enough to wrap is clipped rather than wrapped: a wrapped
  // account name reads as two accounts.
  ok(chatRotatedLine({ from: 'x'.repeat(90), to: 'y'.repeat(90) }).split('\n').every((l) => l.length <= 44));
  ok(chatRotatedLine({ from: 'a' }).split('\n').length === 2, 'no destination, no destination line');
  eq(
    chatRotatedLine({}),
    '🔄 Session limit hit\n⏳ Retrying on the live account',
    'the cooldown case cannot name either half, so it claims neither',
  );
  ok(!/[Ss]wapped/.test(chatRotatedLine({})), 'and it must not claim a swap it cannot see: the account it died on may BE the live one');
  ok(!chatRotatedLine({}).includes('undefined'), 'it never says so by printing undefined');
});

t('wall: ★ the chat rotation line resolves the ⏳ it puts up', () => {
  // Rule 8: a wait is one message edited to a terminal state. This ⏳ is
  // resolved by the retry's OWN run bubble replacing it, and by the ⛔ variant
  // when there is nothing to retry on.
  ok(chatRotatedLine({ from: 'a', to: 'b' }).includes('⏳'), 'the wait glyph');
  ok(chatWalledRetryLine({ codexTaking: true }).startsWith('⛔'), 'the other ending');
});

t('wall: the walled chat line says who is taking the message, or that it is parked', () => {
  eq(
    chatWalledRetryLine({ codexTaking: true }),
    '⛔ Session limit, no account free\n🧠 Codex is taking this message',
  );
  eq(chatWalledRetryLine({}), '⛔ Session limit, no account free\n⏳ Your message is parked');
});

t('wall: both engines out names BOTH clocks, glyph-labelled', () => {
  eq(
    bothWalledLine({ claudeAt: '13:45', codexAt: '14:20' }),
    '⏸ Both engines are out\n🤖 Claude resets 13:45 · 🧠 Codex 14:20\nYour message is parked, it runs by itself.',
  );
  ok(bothWalledLine({ claudeAvailable: false, codexAt: '14:20' }).includes('No claude on this machine'));
  ok(bothWalledLine({}).includes('🤖 Claude is limited · 🧠 Codex is limited'), 'no clock, still both subjects');
});

t('wall: the back line names WHICH engine is about to run the parked work', () => {
  eq(enginesBackLine({ engine: 'codex', count: 3 }), '▶️ Codex is back · running 3 parked');
  eq(enginesBackLine({ engine: 'claude', count: 1 }), '▶️ Claude is back · running 1 parked');
  eq(enginesBackLine({ count: 2 }), '▶️ An engine is back · running 2 parked');
});

t('wall: five minutes, because it needs a clock that is not wrong, not a live one', () => {
  eq(WALL_TICK_MS, 5 * 60 * 1000);
});

t('wall: ★ every wall shape passes the house-style gates', () => {
  for (const [s, where] of [
    [limitWallLine({ resetClock: '13:45', leftText: '3h 12m', codexTaking: true }), 'limitWallLine'],
    [limitWallLine({}), 'limitWallLine/unknown'],
    [limitWallResolved({ clock: '14:01', codexAnswered: 4 }), 'limitWallResolved'],
    [swapFailedLine({ error: 'no captured credentials', account: 'owner@example.com' }), 'swapFailedLine'],
    [chatRotatedLine({ from: 'first@example.com', to: 'second@example.com' }), 'chatRotatedLine'],
    [chatRotatedLine({ from: 'x'.repeat(90), to: 'y'.repeat(90) }), 'chatRotatedLine/long names'],
    [chatRotatedLine({}), 'chatRotatedLine/nameless'],
    [chatWalledRetryLine({ codexTaking: true }), 'chatWalledRetryLine'],
    [chatWalledRetryLine({}), 'chatWalledRetryLine/parked'],
    [bothWalledLine({ claudeAt: '13:45', codexAt: '14:20' }), 'bothWalledLine'],
    [enginesBackLine({ engine: 'codex', count: 3 }), 'enginesBackLine'],
  ]) {
    houseStyle(s, where);
  }
});

// ---------------------------------------------------------------------------
// /help: the budget is on what is SENT, not on the raw reference
// ---------------------------------------------------------------------------

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const composed = (r) => esc(r.visible).length + 37 + esc(r.body).length;

t('help: ★ the composed HTML fits even when escaping triples the reference', () => {
  // HELP_BODY_MAX bounds the RAW body, and escaping expands every & < > in it.
  // A raw length that fits could compose to a message Telegram rejects, and a
  // rejected /help falls back to the index with the whole reference gone: the
  // wall removed AND the document with it.
  const r = helpMessage({ name: 'Leash', host: 'h', reference: '&<>'.repeat(3000), escape: esc });
  ok(composed(r) <= 4096, `${composed(r)} chars would be rejected by Telegram`);
  ok(r.body.endsWith('… the rest is in README.md'), 'the cut has to be visible');
});

t('help: a reference that fits is not cut to buy a margin it does not need', () => {
  const ref = 'x'.repeat(3400);
  const r = helpMessage({ name: 'Leash', host: 'h', reference: ref, escape: esc });
  eq(r.body, ref, 'a document that fits was truncated anyway');
});

t('help: the raw cap still applies before the composed one', () => {
  const r = helpMessage({ name: 'Leash', host: 'h', reference: 'y'.repeat(9000), escape: esc });
  ok(r.body.length <= HELP_BODY_MAX + 40, r.body.length);
});

t('help: it is still callable with no escaper, for the pure form', () => {
  const r = helpMessage({ name: 'Leash', host: 'h', reference: 'short' });
  eq(r.body, 'short');
  ok(r.visible.includes('▸ tap for the full reference'));
});

// ---------------------------------------------------------------------------
// /new
// ---------------------------------------------------------------------------

t('new: ★ ONE message, where there used to be two opening with the same glyph', () => {
  eq(
    newSessionLine({ which: 'chat', archived: '7f4e3041', codexThread: true }),
    '🆕 Chat cleared\n💬 Old chat archived (7f4e3041) · /resume it\n🧵 Codex thread cleared too',
  );
});

t('new: the Codex fact stays a LINE, not a clause', () => {
  // On a Codex-first install this IS the thing that was cleared; as a trailing
  // clause it reads as a footnote to a Claude session that may not exist here.
  const s = newSessionLine({ codexThread: true });
  eq(s.split('\n').length, 2);
  eq(s.split('\n')[1], '🧵 Codex thread cleared too');
});

t('new: each lane says which one it cleared', () => {
  ok(newSessionLine({ which: 'bg' }).startsWith('🆕 Background cleared'));
  ok(newSessionLine({ which: 'all' }).startsWith('🆕 Both sessions cleared'));
  ok(newSessionLine({}).startsWith('🆕 Chat cleared'));
});

t('new: nothing to archive prints no archive line', () => {
  eq(newSessionLine({ which: 'chat' }), '🆕 Chat cleared');
});

t('new: ★ house style', () => {
  for (const a of [{ archived: 'abcd1234', codexThread: true }, { which: 'bg' }, {}]) houseStyle(newSessionLine(a), 'newSessionLine');
});

// ---------------------------------------------------------------------------
// /compact
// ---------------------------------------------------------------------------

t('compact: ★ the ⏳ has all three of its endings, and they are the same message', () => {
  ok(compactingLine().startsWith('📦 Compacting…'), 'the wait');
  ok(compactQueuedLine().startsWith('⏳ Compaction queued'), 'the other wait');
  ok(compactDoneLine({}).startsWith('✅ Compacted'), 'it worked');
  ok(compactDiscardedLine().startsWith('⚠️ Compaction discarded'), 'it was raced');
});

t('compact: the done line, exactly as the spec writes it', () => {
  eq(
    compactDoneLine({ elapsedSec: 42, archived: '7f4e3041' }),
    '✅ Compacted · 42s\n💬 Old chat archived (7f4e3041) · /resume it\n🆕 Fresh chat primed with the summary',
  );
});

t('compact: an unknown archive id costs the line rather than printing a ?', () => {
  const s = compactDoneLine({ elapsedSec: 1 });
  eq(s.split('\n').length, 2);
  ok(!s.includes('?'), s);
});

t('compact: the wait carries a clock once there is one worth showing', () => {
  ok(!compactingLine(0).includes('·  ·'), compactingLine(0));
  ok(compactingLine(42).includes('42s'), compactingLine(42));
});

t('compact: ★ house style on every one of the four states', () => {
  for (const [s2, where] of [
    [compactingLine(42), 'compactingLine'],
    [compactQueuedLine(), 'compactQueuedLine'],
    [compactDoneLine({ elapsedSec: 42, archived: '7f4e3041' }), 'compactDoneLine'],
    [compactDiscardedLine(), 'compactDiscardedLine'],
  ]) {
    houseStyle(s2, where);
  }
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

t('attachments: ★ a single file gets NO ack, because the bubble carries it', () => {
  eq(attachmentAck(['photo']), null, 'one photo needs no receipt, the run says what it holds');
  eq(attachmentAck([]), null);
  eq(attachmentFrameNote(['photo']), '📎 1 photo', 'and this is what the bubble says');
});

t('attachments: an album gets one, because the settle timer makes the gap visible', () => {
  eq(attachmentAck(['photo', 'photo', 'photo']), '📎 3 photos saved · running them');
  eq(attachmentFrameNote(['photo', 'photo', 'photo']), '📎 3 photos');
});

t('attachments: ★ a mixed album says "files" rather than a small lie', () => {
  // "3 photos" over two photos and a video is wrong in the one message whose
  // whole job is saying what arrived.
  eq(attachmentNoun(['photo', 'photo', 'video']), '3 files');
  eq(attachmentNoun(['video', 'video']), '2 videos');
  eq(attachmentNoun(['file']), '1 file');
  eq(attachmentNoun(['voice message']), '1 voice note');
});

t('attachments: nothing to say prints nothing', () => {
  eq(attachmentFrameNote([]), null);
  eq(attachmentFrameNote(undefined), null);
  eq(attachmentAck(undefined), null);
});

t('attachments: ★ house style', () => {
  for (const k of [['photo', 'photo'], ['photo', 'video', 'file'], ['video', 'video', 'video', 'video', 'video', 'video']]) {
    houseStyle(attachmentAck(k), 'attachmentAck');
    houseStyle(attachmentFrameNote(k), 'attachmentFrameNote');
  }
});

// ---------------------------------------------------------------------------
// A reply to a bubble
// ---------------------------------------------------------------------------

t('reply: the ack is byte for byte the old line when nothing was quoted', () => {
  eq(steeredInAck({}), '➡️ Sent into the running task.');
  eq(replyQuoteFrameNote({}), null, 'the bubble stays as it was on a message that is not a reply');
});

t('reply: the quote is named on its own line, and its text on another', () => {
  eq(
    steeredInAck({ who: 'Leash', excerpt: 'Draft ready, not sent' }),
    '➡️ Sent into the running task.\n↩ Quoting Leash\n"Draft ready, not sent"',
  );
  eq(steeredInAck({ who: 'you' }), '➡️ Sent into the running task.\n↩ Quoting you', 'a quote with no words still says whose');
  eq(replyQuoteFrameNote({ who: 'Leash' }), '↩ quoting Leash');
});

t('reply: the ack never becomes the quote', () => {
  const s = steeredInAck({ who: 'Leash', excerpt: 'x'.repeat(4000) });
  const line = s.split('\n')[2];
  ok(line.length <= 64, `${line.length} chars`);
  ok(line.includes('…'), 'the cut is marked');
});

t('reply: a long name cannot push the line past the bubble', () => {
  // 64 characters is a legal Telegram first_name, and a forwarded channel title
  // is longer still. Both land in `who`.
  const long = 'Bartholomew Fitzgerald-Montgomery the Third of Cambridgeshire';
  const line = steeredInAck({ who: long }).split('\n')[1];
  ok(line.length <= 44, `${line.length} chars: ${line}`);
  ok(line.includes('…'), 'the cut is marked');
  ok(replyQuoteFrameNote({ who: long }).length <= 44, replyQuoteFrameNote({ who: long }));
  eq(steeredInAck({ who: 'Leash\nfake line' }).split('\n').length, 2, 'a newline in a name cannot forge a line');
});

t('reply: ★ house style', () => {
  for (const a of [
    {},
    { who: 'Leash' },
    { who: 'you', excerpt: 'Draft ready, not sent, from hello@example.com' },
    { who: 'Bartholomew Fitzgerald-Montgomery the Third of Cambridgeshire', excerpt: 'x · y "z"' },
    { who: 'a forward', excerpt: '' },
  ]) {
    houseStyle(steeredInAck(a), 'steeredInAck');
    if (replyQuoteFrameNote(a)) houseStyle(replyQuoteFrameNote(a), 'replyQuoteFrameNote');
  }
});

// ---------------------------------------------------------------------------
// The /codex sub-views
// ---------------------------------------------------------------------------

t('codex view: ★ the value first, the reasoning behind one tap', () => {
  const v = codexSubView({
    icon: '🌐',
    label: 'Codex network',
    value: 'on',
    now: 'off',
    set: 'Set: /codex network on|off',
    detail: 'Separate from /yolo on purpose.',
  });
  eq(v.visible, '🌐 Codex network: on\n🔒 In force now: off\nSet: /codex network on|off\n▸ tap for why');
  eq(v.body, 'Separate from /yolo on purpose.', 'the 150-character explanation belongs here, not on the line');
});

t('codex view: "in force now" only appears when it can disagree with the setting', () => {
  const same = codexSubView({ label: 'Codex network', value: 'on', now: 'on', set: 'x' });
  ok(!same.visible.includes('In force now'), 'a line that only ever repeats the line above it');
  const diff = codexSubView({ label: 'Codex network', value: 'on', now: 'off', set: 'x' });
  ok(diff.visible.includes('🔒 In force now: off'), diff.visible);
});

t('codex view: no detail, no tap hint', () => {
  const v = codexSubView({ label: 'Codex model', value: 'default', set: 'Set: /codex model <name>' });
  ok(!v.visible.includes('tap'), v.visible);
  eq(v.body, '');
});

t('codex view: ★ the plain fallback would send the visible part only', () => {
  const v = codexSubView({ label: 'Codex network', value: 'on', set: 's', detail: 'THE LONG EXPLANATION' });
  const html = `${escHtml(v.visible)}<blockquote expandable>${escHtml(v.body)}</blockquote>`;
  ok(!visibleOnly(html).includes('THE LONG EXPLANATION'), 'the wall came back on the fallback');
  ok(visibleOnly(html).includes('Codex network: on'), 'the answer survives');
});

t('codex view: ★ house style on the visible part', () => {
  for (const a of [
    { icon: '🌐', label: 'Codex network', value: 'on', now: 'off', set: 'Set: /codex network on|off', detail: 'x' },
    { icon: '🧠', label: 'Codex effort', value: 'xhigh', set: 'Set: /codex effort <level>', detail: 'x' },
  ]) {
    houseStyle(codexSubView(a).visible, 'codexSubView');
  }
});

// ---------------------------------------------------------------------------
// The boot announce
// ---------------------------------------------------------------------------

t('boot: ★ it says the daemon\'s own name, not a product name about to be wrong', () => {
  eq(bootAnnounceLine({ name: 'Leash', host: 'dev-box', workers: 2 }), '🟢 Leash online · dev-box\n🌙 2 workers re-attached');
  eq(bootAnnounceLine({ name: 'Leash', host: 'h' }), '🟢 Leash online · h', 'the public build says Leash, from config, with no code change');
});

t('boot: the /help hint is gone, because the command menu is one tap away', () => {
  ok(!bootAnnounceLine({ host: 'h' }).includes('/help'));
  ok(!bootAnnounceLine({ host: 'h' }).includes('send a message'));
});

t('boot: ★ the survivor line is news, and only appears when there are survivors', () => {
  // A restart over two multi-hour jobs used to report nothing at all, which is
  // what made /status say "idle" on 2026-09-03.
  ok(bootAnnounceLine({ host: 'h', workers: 2 }).includes('🌙 2 workers re-attached'));
  eq(bootAnnounceLine({ host: 'h', workers: 1 }).split('\n')[1], '🌙 1 worker re-attached');
  eq(bootAnnounceLine({ host: 'h', workers: 0 }).split('\n').length, 1, 'a clean boot says one line');
});

t('boot: ★ house style, including the dash the old line carried', () => {
  for (const a of [{ workers: 2, host: 'dev-box' }, { host: 'h' }, {}]) houseStyle(bootAnnounceLine(a), 'bootAnnounceLine');
});

// ---------------------------------------------------------------------------
// The account and usage views, tightened from outside the shared boundary
// ---------------------------------------------------------------------------

const ACCOUNT_VIEW = [
  '👤 **Claude Code accounts**',
  '',
  '▶︎ `work` · Max 20x',
  '   `5h ███░░░░░░░  31%` resets 11:09pm',
  '',
  'Tap to swap · /usage for detail',
].join('\n');

const USAGE_VIEW = [
  '📊 **Claude plan usage** — 5h block + weekly window',
  'Active: `work`',
  '',
  '▶︎ `work`',
  '   `5h ███░░░░░░░  31%` resets 11:09pm',
  '',
  'Times are Europe/Berlin. /account <name> to swap.',
].join('\n');

t('accounts: ★ the bold comes off the header, and nothing else moves', () => {
  const out = tightenAccountView(ACCOUNT_VIEW);
  eq(out.split('\n')[0], '👤 Claude Code accounts', 'bold on top of an emoji is two markers for one job');
  ok(out.includes('   `5h ███░░░░░░░  31%` resets 11:09pm'), 'THE BARS MUST NOT BE TOUCHED');
  ok(out.includes('Tap to swap · /usage for detail'), 'one useful line stays');
  ok(out.includes('▶︎ `work` · Max 20x'), 'the rows are untouched');
});

t('accounts: ★ /usage loses its footer and its em dash subtitle', () => {
  const out = tightenAccountView(USAGE_VIEW);
  eq(out.split('\n')[0], '📊 Claude plan usage');
  noDashes(out, 'tightenAccountView');
  ok(!out.includes('Times are'), 'the timezone is his own and the swap hint is on the other view');
  ok(!out.endsWith('\n'), 'the blank line that only separated the dropped footer goes with it');
  eq(out.split('\n').pop(), '   `5h ███░░░░░░░  31%` resets 11:09pm', 'and the bars are the last thing left');
});

t('accounts: ★ a rewording on the shared side makes this a no-op, never a corruption', () => {
  // account-usage.mjs is byte-locked to the public repo, so this pass has to
  // degrade rather than mangle when the other side changes.
  const reworded = '👤 Claude accounts, rewritten upstream\n\n▶︎ `work`';
  eq(tightenAccountView(reworded), reworded);
  eq(tightenAccountView(''), '');
  eq(tightenAccountView(null), '');
});

t('accounts: a bold header elsewhere in the body is left alone', () => {
  const body = '👤 **Claude Code accounts**\n\n**not a header**';
  ok(tightenAccountView(body).includes('**not a header**'), 'only the anchored first-line pattern is touched');
});

// ---------------------------------------------------------------------------
// The dash sweep, as a standing guard rather than a one-off pass
// ---------------------------------------------------------------------------
//
// dash-normalize.mjs catches em dashes on the way OUT when style.noDashes is
// set, which it is on this install. But it turns every one into a comma, and a
// comma is not always the punctuation the sentence wanted; and a public install
// starts with the normalizer OFF, so the source strings have to be right.
//
// Three kinds of dash are legitimate and stay:
//   • a trailing `// comment`, which no reader ever sees;
//   • console.log / console.error, which go to the daemon log;
//   • the prompts written FOR M (the handback header, the watchdog block, the
//     compaction instruction), where prose punctuation is correct and the
//     framing is load bearing.
// Everything else is a string the owner reads on a phone.

const M_FACING = [
  'not an instruction',
  '[Session handoff',
  'Produce a compaction summary',
  'BEFORE ANY RE-RUN',
  'untrusted worker output',
  'before dying',
  'a dead worker is NOT an empty worker',
];

t('sweep: ★ no em or en dash in any owner-facing string in bridge.mjs', () => {
  const src = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8').split('\n');
  const offenders = [];
  src.forEach((line, i) => {
    if (!/[–—]/.test(line)) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    // A trailing comment on a line of code: strip it and look again.
    const code = line.replace(/\/\/.*$/, '');
    if (!/[–—]/.test(code)) return;
    if (/console\.(log|error|warn)/.test(code)) return;
    if (M_FACING.some((m) => line.includes(m))) return;
    // The dash CHARACTER CLASS in a matcher is not a dash in a message.
    if (/\[[–—-]*[–—][–—-]*\]/.test(code)) return;
    offenders.push(`${i + 1}: ${trimmed.slice(0, 110)}`);
  });
  eq(offenders.length, 0, `dashes reaching the phone:\n  ${offenders.join('\n  ')}`);
});

t('sweep: ★ and none in the message modules either', () => {
  for (const f of ['system-messages.mjs', 'bg-notify.mjs', 'engine-state.mjs', 'bg-steer.mjs', 'codex-account.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').split('\n');
    const offenders = [];
    src.forEach((line, i) => {
      if (!/[–—]/.test(line)) return;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const code = line.replace(/\/\/.*$/, '');
      if (!/[–—]/.test(code)) return;
      // The tightener's own dash class, and any other matcher like it.
      if (/\[[–—-]*[–—][–—-]*\]/.test(code)) return;
      offenders.push(`${f}:${i + 1}: ${trimmed.slice(0, 110)}`);
    });
    eq(offenders.length, 0, `dashes in a builder:\n  ${offenders.join('\n  ')}`);
  }
});

t('sweep: the guard actually catches one, so a green run means something', () => {
  const line = `  await send('this — is wrong', { markdown: false });`;
  ok(/[–—]/.test(line.replace(/\/\/.*$/, '')), 'the detector reads the code half of the line');
  ok(!/[–—]/.test(`  const x = 1; // a — comment`.replace(/\/\/.*$/, '')), 'and ignores the comment half');
});

t('attachments: ★ the single-file path actually PASSES kinds, or the frame carries nothing', () => {
  // The builder returning null for [] is correct, and it is also how item 14
  // silently did nothing for the daily case: the single-file dispatch omitted
  // `kinds`, so the frame it was written for stayed a bare "🤖 Thinking…".
  const src = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');
  const single = src.match(/dispatchPrompt\(buildMediaPrompt\(\[mediaEntry\(saved, media\)\][\s\S]{0,800}?\n {4}\}\);/);
  ok(single, 'the single-file dispatch moved; this guard needs re-pointing');
  ok(/kinds:\s*\[media\.kind\]/.test(single[0]), `one photo still lands in silence:\n${single[0]}`);
  ok(/kinds:\s*grp\.kinds/.test(src), 'and the album path still passes its own');
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all system-message tests pass');
