#!/usr/bin/env node
// Tests for bg-btw.mjs: side questions to a running background worker.
//
// A btw rides the same stdin pipe as a steer and is the OPPOSITE thing, so
// everything worth testing here is a way the two could be confused or the
// answer could go to the wrong place:
//
//   • framing that reads as an instruction would make a worker re-plan because
//     somebody asked it what repo it was in;
//   • a marker matched anywhere but the head of the first line would swallow a
//     worker's real output out of both the bubble and the report;
//   • an id matched loosely would answer a live question with text written
//     about a different one;
//   • the assistant/result duplicate (the SAME answer arrives twice when a btw
//     becomes its own turn) would resolve the next pending question with the
//     previous one's answer.
//
// bridge.mjs cannot be imported (it boots the daemon), so the routing lives in
// this module and is asserted here; the CLI half is exercised by running the
// real bg.mjs against a stub socket, exactly as bg-steer.test.mjs does.
//
//   node bg-btw.test.mjs

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BTW_ANSWER_MAX,
  BTW_ANSWER_PREFIX,
  BTW_RECORD_MAX,
  BTW_TICK_MS,
  BTW_TIMEOUT_MS,
  btwFraming,
  createBtwTracker,
  isBtwFramed,
  parseBtwAnswer,
} from './bg-btw.mjs';
import { mapNotification } from './codex-appserver.mjs';
import {
  REASONS,
  STEER_HEADER,
  STEER_SOCK_NAME,
  decodeLine,
  encodeLine,
  looksLikeTarget,
  psTable,
  resolveSteerTarget,
  steerAckLine,
  steerFailure,
  steerResponse,
  validateRequest,
} from './bg-steer.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

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
  if (!cond) throw new Error(msg || 'expected truthy');
};

// ---------------------------------------------------------------------------
// 1. The framing. Every clause exists to stop the worker acting on it.
// ---------------------------------------------------------------------------

t('framing: the id is in the header AND in the marker the worker must echo', () => {
  const f = btwFraming(3, 'which repo are you in?');
  ok(f.startsWith('[BTW #3 from the orchestrator (Leash).'), f.slice(0, 60));
  ok(f.includes('BTW-ANSWER #3:'), 'the marker the parser looks for must be quoted back verbatim');
  ok(f.endsWith('which repo are you in?'), 'the question is the last thing the worker reads');
});

t('framing: it says what it is NOT, in every direction a worker could take it', () => {
  const f = btwFraming(1, 'q');
  ok(/NOT an instruction/.test(f), 'a btw read as a steer makes the worker re-plan');
  ok(/[Dd]o not change your plan/.test(f), 'the plan clause');
  ok(/do not start new work/.test(f), 'the new-work clause');
  ok(/do not treat it as approval/.test(f), '★ approval laundering: a question is not a yes');
  ok(/continue your task exactly where you were/.test(f), 'the resume clause');
});

t('framing: it is the mirror of the steer header, not a copy of it', () => {
  const f = btwFraming(1, 'q');
  ok(!f.includes(STEER_HEADER), 'a btw must never carry the steer framing');
  ok(/mid-run instruction for your CURRENT task/.test(STEER_HEADER), 'the steer header says the opposite');
  ok(!/mid-run instruction for your CURRENT task/.test(f), '★ that clause is exactly what a btw must not say');
});

t('framing: the report gets one line per question, under its own heading', () => {
  ok(btwFraming(2, 'q').includes('Side questions'), 'the report heading the orchestrator reads');
});

t('framing: it states the answer budget and the dash ban', () => {
  const f = btwFraming(1, 'q');
  ok(f.includes(String(BTW_ANSWER_MAX)), 'the character budget');
  ok(/no em or en dashes/.test(f), 'the no-dash rule, stated where the text is written');
});

t('framing: no em or en dash in the framing itself', () => {
  ok(!/[–—]/.test(btwFraming(7, 'q')), 'the daemon must not write the punctuation it bans');
});

t('framing: a blank question still frames rather than throwing', () => {
  const f = btwFraming(1, null);
  ok(f.includes('BTW-ANSWER #1:'), f);
});

t('★ framing: the daemon names ITSELF from config, never a hard-coded name', () => {
  // This install calls itself whatever `name` in config.json says, and the
  // worker is being told who is asking. A hard-coded name here would introduce
  // somebody else to every worker on every machine that renamed the daemon.
  ok(btwFraming(1, 'q', { name: 'Rex' }).startsWith('[BTW #1 from the orchestrator (Rex).'), 'the configured name');
  ok(btwFraming(1, 'q').startsWith('[BTW #1 from the orchestrator (Leash).'), 'and the default is the project name');
  for (const bad of [undefined, null, '', '   ']) {
    ok(btwFraming(1, 'q', { name: bad }).includes('(Leash).'), `an unset name must not produce "()" : ${JSON.stringify(bad)}`);
  }
  ok(isBtwFramed(btwFraming(1, 'q', { name: 'Rex' })), '★ and a rename must not make the framing unrecognisable to the guard');
});

t('★ isBtwFramed recognises what btwFraming writes, and nothing else', () => {
  // The guard on the one invariant everything else rests on: a question that
  // reaches a worker UNFRAMED is indistinguishable from a steer, and a steer is
  // an instruction. run.steer refuses on this predicate before the write.
  ok(isBtwFramed(btwFraming(1, 'q')), 'its own output must pass');
  ok(isBtwFramed(btwFraming(4217, 'q')), 'any id');
  ok(!isBtwFramed('which repo are you in?'), '★ a raw question must be refused, not delivered');
  ok(!isBtwFramed(''), 'empty');
  ok(!isBtwFramed(null), 'nullish');
  ok(!isBtwFramed('[STEER from the orchestrator, a mid-run instruction'), 'a steer is not a btw');
  ok(!isBtwFramed('BTW #1 from the orchestrator'), 'the bracket is part of the marker');
  ok(!isBtwFramed('here is what I did: [BTW #1 from the orchestrator ...]'), 'the head of the text, not anywhere in it');
});

t('lane rule 5 teaches the shape, in bg.mjs, before any worker meets it', () => {
  const bg = readFileSync(path.join(DIR, 'bg.mjs'), 'utf8');
  const rule = /'5\. A message that starts with \[BTW #N from the orchestrator\][^']*'/.exec(bg)?.[0] ?? '';
  ok(rule, 'rule 5 is missing: a worker would meet its first btw with no idea what it is');
  ok(rule.includes('BTW-ANSWER #N:'), 'the rule must name the exact marker line');
  ok(/NOT an instruction|not an instruction/.test(rule), 'the rule must say what it is not');
  ok(rule.includes('Side questions'), 'the report heading');
  ok(/OPPOSITE of a steer/.test(rule), 'rule 4 is right above it; the contrast is the teaching');
});

// ---------------------------------------------------------------------------
// 2. Detection. The marker is the FIRST thing on the FIRST line, or it is prose.
// ---------------------------------------------------------------------------

t('parse: a one-line answer', () => {
  eq(parseBtwAnswer('BTW-ANSWER #3: delta-agents, on main').id, 3);
  eq(parseBtwAnswer('BTW-ANSWER #3: delta-agents, on main').answer, 'delta-agents, on main');
});

t('parse: a multi-line answer keeps every line after the marker', () => {
  const r = parseBtwAnswer('BTW-ANSWER #1: two things\nfirst this\nthen that');
  eq(r.id, 1);
  eq(r.answer, 'two things\nfirst this\nthen that');
});

t('parse: the whole answer may live below the marker line', () => {
  const r = parseBtwAnswer('BTW-ANSWER #2:\nthe migration applied at 17:04');
  eq(r.id, 2);
  eq(r.answer, 'the migration applied at 17:04');
});

t('★ parse: BTW-ANSWER mid-sentence is the worker talking, not an answer', () => {
  eq(parseBtwAnswer('I will emit BTW-ANSWER #3: once the build finishes'), null);
  eq(parseBtwAnswer('Done. BTW-ANSWER #3: is what you asked for'), null);
});

t('★ parse: the marker on a LATER line is not an answer either', () => {
  eq(parseBtwAnswer('Running the suite now.\nBTW-ANSWER #3: green'), null, 'a report that quotes the marker is still a report');
});

t('parse: leading whitespace on the first line is tolerated', () => {
  eq(parseBtwAnswer('   BTW-ANSWER #4: yes').id, 4, 'a stray indent is not a reason to lose the answer');
});

t('parse: an answer with no id parses with id null', () => {
  const r = parseBtwAnswer('BTW-ANSWER: yes, it applied');
  eq(r.id, null);
  eq(r.answer, 'yes, it applied');
});

t('parse: spacing around the marker is tolerated, deliberately', () => {
  // Leniency costs nothing here and buys a lot: the marker still has to be the
  // HEAD of the first line, so a false positive is essentially unreachable,
  // while a model that adds one space would otherwise leave its answer sitting
  // in the report with the pending line still ticking on the phone.
  eq(parseBtwAnswer('BTW-ANSWER # 5: ok').id, 5);
  eq(parseBtwAnswer('BTW-ANSWER  #5 : ok').id, 5);
  eq(parseBtwAnswer('BTW-ANSWER-ish #5: ok'), null, 'but it is still the marker, not a word that starts like it');
});

t('parse: ordinary output, empty strings and nullish all parse to null', () => {
  eq(parseBtwAnswer('Ran npm test: 214 passed'), null);
  eq(parseBtwAnswer(''), null);
  eq(parseBtwAnswer(null), null);
  eq(parseBtwAnswer(undefined), null);
});

t('parse: the prefix constant is what the regex looks for', () => {
  eq(BTW_ANSWER_PREFIX, 'BTW-ANSWER');
  eq(parseBtwAnswer(`${BTW_ANSWER_PREFIX} #9: fine`).id, 9);
});

// ---------------------------------------------------------------------------
// 3. The tracker: ids, routing, and the two ways an answer could be misrouted.
// ---------------------------------------------------------------------------

t('tracker: ids are per worker and monotonic from 1', () => {
  const a = createBtwTracker();
  eq(a.add({}).id, 1);
  eq(a.add({}).id, 2);
  eq(a.add({}).id, 3);
  const b = createBtwTracker();
  eq(b.add({}).id, 1, '★ a second worker starts at 1: ids only have to be unique within one worker');
});

t('tracker: a routed answer resolves the matching question and nothing else', () => {
  const tr = createBtwTracker();
  const one = tr.add({ tag: 'one' });
  const two = tr.add({ tag: 'two' });
  const r = tr.take('BTW-ANSWER #2: the second');
  eq(r.status, 'routed');
  eq(r.entry, two, 'the id decides, not the order');
  eq(r.answer, 'the second');
  eq(tr.size, 1);
  eq(tr.list()[0], one, 'the unanswered question is still outstanding');
});

t('tracker: an id-less answer takes the OLDEST outstanding question', () => {
  const tr = createBtwTracker();
  const one = tr.add({ tag: 'one' });
  tr.add({ tag: 'two' });
  const r = tr.take('BTW-ANSWER: whatever you asked first');
  eq(r.status, 'routed');
  eq(r.entry, one, 'FIFO, because arrival order is the only ordering there is');
});

t('★ tracker: the SAME answer arriving twice is one answer', () => {
  // The normal path, not an edge case: a btw that lands during a no-tool
  // stretch becomes its own turn, so the identical text arrives as the
  // assistant block AND as that turn's result event.
  const tr = createBtwTracker();
  const one = tr.add({ tag: 'one' });
  const two = tr.add({ tag: 'two' });
  const first = tr.take('BTW-ANSWER #1: yes');
  const second = tr.take('BTW-ANSWER #1: yes');
  eq(first.status, 'routed');
  eq(first.entry, one);
  eq(second.status, 'duplicate', 'the second copy must not be routed');
  eq(tr.size, 1);
  eq(tr.list()[0], two, '★ question two must still be waiting for its OWN answer');
});

t('★ tracker: an id nobody is waiting for is stripped, never handed to the oldest', () => {
  const tr = createBtwTracker();
  const one = tr.add({ tag: 'one' });
  const r = tr.take('BTW-ANSWER #7: text about a different question');
  eq(r.status, 'duplicate', 'answering #1 with text written about #7 is the misroute this prevents');
  eq(tr.size, 1);
  eq(tr.list()[0], one);
});

t('★ tracker: an id-less duplicate cannot jump to the next question', () => {
  const tr = createBtwTracker();
  tr.add({ tag: 'one' });
  const two = tr.add({ tag: 'two' });
  eq(tr.take('BTW-ANSWER: same text').status, 'routed');
  eq(tr.take('BTW-ANSWER: same text').status, 'duplicate');
  eq(tr.list()[0], two, 'question two is untouched');
});

t('★ tracker: a worker nobody asked anything keeps its own output', () => {
  const tr = createBtwTracker();
  eq(tr.take('BTW-ANSWER #1: I am just writing about the protocol').status, 'none', 'nothing to strip, so strip nothing');
});

t('tracker: ordinary output is never touched', () => {
  const tr = createBtwTracker();
  tr.add({});
  eq(tr.take('Ran the suite, 214 passed').status, 'none');
  eq(tr.size, 1, 'and the question is still outstanding');
});

t('tracker: an answer that arrives with nothing outstanding is stripped, not routed', () => {
  const tr = createBtwTracker();
  tr.add({});
  eq(tr.take('BTW-ANSWER #1: done').status, 'routed');
  eq(tr.take('BTW-ANSWER #1: done again, reworded').status, 'duplicate');
});

t('tracker: remove un-queues a question without recycling its id', () => {
  // The delivery-failed path: the id is minted before the stdin write, so a
  // bounced write has to take the question back out.
  const tr = createBtwTracker();
  const one = tr.add({});
  eq(tr.remove(one), true);
  eq(tr.size, 0);
  eq(tr.remove(one), false, 'removing twice is a no-op, not a corruption');
  eq(tr.add({}).id, 2, '★ ids climb even across a failure, so a late answer cannot collide');
});

t('tracker: drain empties it and hands back everything outstanding', () => {
  const tr = createBtwTracker();
  const a = tr.add({ tag: 'a' });
  const b = tr.add({ tag: 'b' });
  const drained = tr.drain();
  eq(drained.length, 2);
  eq(drained[0], a);
  eq(drained[1], b);
  eq(tr.size, 0);
  eq(tr.drain().length, 0, 'draining twice must not resolve a question twice');
});

t('tracker: seq survives a drain, so a post-drain answer matches nothing', () => {
  const tr = createBtwTracker();
  tr.add({});
  tr.drain();
  eq(tr.take('BTW-ANSWER #1: late').status, 'duplicate', 'the run is over; the answer is stripped, not routed');
});

t('★ tracker: delivered() is exact identity, which is what the result event needs', () => {
  // The result-event half of duplicate suppression. It cannot be `take`: a btw
  // injected at a tool-step boundary joins the SAME turn, so the result can be
  // the answer followed by the worker's real report, and matching on the first
  // line would swallow the report with it.
  const tr = createBtwTracker();
  tr.add({});
  const answer = 'BTW-ANSWER #1: yes, at 17:04';
  eq(tr.delivered(answer), false, 'nothing has been delivered yet');
  tr.take(answer);
  eq(tr.delivered(answer), true, 'the byte-identical copy is the duplicate to drop');
  eq(tr.delivered(`${answer}\n\nAnd here is the report the run actually produced.`), false, '★ a result that CONTAINS the answer is not the answer');
  eq(tr.delivered('BTW-ANSWER #1: yes, at 17:05'), false, 'a different text is different');
  eq(tr.delivered(''), false);
  eq(tr.delivered(null), false);
});

t('★ tracker: an id-less answer cannot be routed twice under any text', () => {
  // The remaining shape of the misroute, closed at the bridge by never routing
  // from the result event at all: here the tracker's own guard is asserted.
  const tr = createBtwTracker();
  tr.add({ tag: 'one' });
  const two = tr.add({ tag: 'two' });
  eq(tr.take('BTW-ANSWER: yes').status, 'routed');
  eq(tr.take('BTW-ANSWER: yes').status, 'duplicate');
  eq(tr.list()[0], two, 'question two is still its own question');
});

t('tracker: the entry is opaque, so the daemon can hang a live message on it', () => {
  const tr = createBtwTracker();
  let resolved = null;
  const rec = tr.add({ msgId: 42, resolve: (s) => (resolved = s) });
  eq(rec.msgId, 42);
  tr.take('BTW-ANSWER #1: yes').entry.resolve('answered');
  eq(resolved, 'answered');
});

t('timings: fifteen minutes to speak up, and a worker-paced tick', () => {
  eq(BTW_TIMEOUT_MS, 15 * 60_000);
  eq(BTW_TICK_MS, 15_000);
  ok(BTW_TIMEOUT_MS > BTW_TICK_MS * 10, 'the timeout must be a wait, not a cadence');
  ok(BTW_RECORD_MAX > 0 && BTW_RECORD_MAX <= 2000, 'the on-disk copy of a question stays bounded');
});

// ---------------------------------------------------------------------------
// 4. Wire validation: btw is steer's twin on the socket, and only there.
// ---------------------------------------------------------------------------

t('wire: a btw request validates like a steer', () => {
  const r = validateRequest({ op: 'btw', target: 'bg2', text: 'which repo?' });
  eq(r.ok, true);
  eq(r.op, 'btw', '★ the op must survive validation or the daemon would steer the question in');
  eq(r.target, 'bg2');
  eq(r.text, 'which repo?');
});

t('wire: a steer still validates as a steer', () => {
  eq(validateRequest({ op: 'steer', target: 'bg', text: 'x' }).op, 'steer');
});

t('wire: a btw with no target or no text is refused before it reaches a worker', () => {
  eq(validateRequest({ op: 'btw', text: 'q' }).reason, REASONS.INVALID);
  eq(validateRequest({ op: 'btw', target: 'bg' }).reason, REASONS.INVALID);
  eq(validateRequest({ op: 'btw', target: 'bg', text: '   ' }).reason, REASONS.INVALID);
});

t('wire: an op that is neither is still unknown', () => {
  eq(validateRequest({ op: 'kill', target: 'bg', text: 'x' }).reason, REASONS.UNKNOWN_OP);
  eq(validateRequest({ op: 'btws', target: 'bg', text: 'x' }).reason, REASONS.UNKNOWN_OP);
});

// ---------------------------------------------------------------------------
// 5. Refusals. A btw is refused for exactly the three reasons a steer is, and
//    the wording says WHICH, because "not delivered" alone reads as "retry".
// ---------------------------------------------------------------------------

const W = {
  runId: 'bg-1788453512237',
  lane: 'bg',
  pid: 83808,
  startedAt: 1788453512237,
  steerable: true,
  isBg: true,
  running: true,
};
// Started BEFORE W on purpose, so `latest` resolves to the steerable one: a
// pool where the newest worker is unreachable would make every `latest` test
// assert the refusal path by accident.
const REATTACHED = { ...W, runId: 'bg2-1788453000000', lane: 'bg2', pid: 90210, startedAt: 1788453000000, steerable: false };
const FINISHED = { ...W, runId: 'bg3-1788454000000', lane: 'bg3', pid: 90211, startedAt: 1788454000000, steerable: false };
const CODEX = { ...FINISHED, runId: 'codex-1788454111111', lane: 'codex', pid: 90212, engine: 'codex' };

t('refusal: a worker that survived a restart cannot take a btw, and says so', () => {
  const found = resolveSteerTarget('bg2', [REATTACHED]);
  eq(found.ok, false);
  eq(found.reason, REASONS.NOT_STEERABLE);
  const phone = steerAckLine(steerFailure(found.reason, { lane: found.lane, op: 'btw' }), { verbose: false });
  ok(/restart|finished/.test(phone), `a bare refusal reads as "try again in a second": ${phone}`);
});

t('refusal: a finished worker is the same refusal (its stdin is closed)', () => {
  eq(resolveSteerTarget('bg3', [FINISHED]).reason, REASONS.NOT_STEERABLE);
});

t('★ refusal: a Codex one-shot names the escape hatch for a QUESTION, not for a job', () => {
  const found = resolveSteerTarget('codex', [CODEX]);
  eq(found.reason, REASONS.NOT_STEERABLE);
  const asBtw = steerAckLine(steerFailure(found.reason, { lane: 'codex', engine: 'codex', op: 'btw' }));
  const asSteer = steerAckLine(steerFailure(found.reason, { lane: 'codex', engine: 'codex' }));
  ok(asBtw.includes('/codex <question>'), `a question goes to /codex, not to a re-fire: ${asBtw}`);
  ok(asSteer.includes('bg.mjs --engine codex'), 'a steer still names the re-fire');
  ok(!asBtw.includes('Re-fire it instead'), 'the two escape hatches must not be swapped');
});

t('refusal: the phone form of a Codex btw is short and says where to ask', () => {
  const phone = steerAckLine(steerFailure(REASONS.NOT_STEERABLE, { lane: 'codex', engine: 'codex', op: 'btw' }), { verbose: false });
  ok(phone.includes('/codex <question>'), phone);
  ok(!/[–—]/.test(phone), 'no em or en dash on a phone line');
  // The head is the pre-existing shared refusal row and is exempted the way
  // bg-notify exempts its own: what this asserts is that the two lines the btw
  // branch ADDS fit a phone.
  for (const line of phone.split('\n').slice(1)) ok(line.length <= 44, `line of ${line.length}: ${line}`);
});

t('refusal: nothing matching, and an ambiguous target, still answer', () => {
  eq(resolveSteerTarget('bg9', [W]).reason, REASONS.NO_MATCH);
  eq(resolveSteerTarget('latest', []).reason, REASONS.NO_MATCH);
});

t('ack: a delivered btw says asked, and says where the answer goes', () => {
  const line = steerAckLine(steerResponse(W, '2026-09-09T21:02:11.000Z', { op: 'btw' }));
  ok(line.startsWith('asked bg '), line);
  ok(line.includes('Telegram'), '★ the CLI is not where the answer lands, so it must not look like it is');
  ok(!/[–—]/.test(line), 'no em or en dash');
});

t('ack: a delivered steer is byte-identical to what it always printed', () => {
  eq(
    steerAckLine(steerResponse(W, '2026-09-09T21:02:11.000Z')),
    'steered into bg (bg-1788453512237, pid 83808) at 21:02:11Z',
  );
});

// ---------------------------------------------------------------------------
// 5b. Wiring inside bridge.mjs, by source.
//
// bridge.mjs boots the daemon on import, and the pieces below live inside
// runClaude's closure where nothing can extract them. They are asserted against
// the source instead, because each one is a silent failure: a stream detector
// wired into only ONE of the two places an answer appears would leak it into
// the report; an exit path with no drain would leave a ⏳ ticking forever.
// system-wiring.test.mjs section 10 runs the parts that CAN be extracted.
// ---------------------------------------------------------------------------

const BRIDGE = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8');
// TWO TRANSPORTS NOW, and each has to satisfy these guards on its own. Counting
// over the whole file would let one of them lose its detector while the other's
// kept the total right, which is exactly the silent failure this section exists
// to catch. Sliced by the function that owns each.
const region = (from, to) => {
  const a = BRIDGE.indexOf(from);
  const b = BRIDGE.indexOf(to, a + 1);
  if (a === -1 || b === -1) throw new Error(`could not slice bridge.mjs between ${from} and ${to}`);
  return BRIDGE.slice(a, b);
};
const CLAUDE_WORKER = region('function runClaude(', '\nfunction ');
const CODEX_JOB = region('function runCodexAppServerJob(', '\nfunction startCodexJob(');

t('★ the detector is wired into both places an answer can appear, each its own way', () => {
  ok(
    /if \(!isSubagent && !run\.btwTake\(block\.text\.trim\(\)\)\) \{/.test(BRIDGE),
    'the assistant text block ROUTES: without this the answer stays in the progress bubble',
  );
  ok(
    /ev\.result\.trim\(\) && !run\.btwDelivered\(ev\.result\.trim\(\)\)/.test(BRIDGE),
    '★ the result event only SUPPRESSES an exact duplicate: without this the answer is captured into the report and bg-results.jsonl',
  );
  eq((CLAUDE_WORKER.match(/run\.btwTake\(/g) || []).length, 1, 'exactly one router, on the assistant block');
  ok(
    !/run\.btwTake\(ev\.result/.test(BRIDGE),
    '★ routing from the result event would swallow a report that FOLLOWS an answer in the same turn, and could resolve a second pending question',
  );
});

t('★ the CODEX job has its own detector, on the agent message item and nowhere else', () => {
  // Same rule, other transport. A Codex answer arrives as an app-server
  // agentMessage item; routing from turn/completed's item list instead would
  // resolve the question twice, and routing from neither would put a private
  // answer in the handback.
  eq((CODEX_JOB.match(/run\.btwTake\(/g) || []).length, 1, 'exactly one router on the Codex job');
  ok(/case 'message': \{[\s\S]{0,400}?if \(run\.btwTake\(text\)\) break;/.test(CODEX_JOB), 'it is on the streamed agent message');
  ok(
    /isBtwAnswer\(it\.text\)/.test(CODEX_JOB),
    "★ and turn/completed's final items are FILTERED rather than routed: without this the last thing said becomes the report even when it was a private answer",
  );
});

t('★ a btw cannot be written into a worker unframed, on either transport', () => {
  const codexSteer = CODEX_JOB.slice(CODEX_JOB.indexOf('run.steer = ('), CODEX_JOB.indexOf('run.btwAsk = ('));
  ok(/if \(kind === 'btw' && !isBtwFramed\(text\)\) \{/.test(codexSteer), 'the Codex guard');
  ok(codexSteer.indexOf('isBtwFramed(text)') < codexSteer.indexOf('client'), '★ and it is before anything reaches the server');
});

t('★ a btw cannot be written into a worker unframed', () => {
  const steer = BRIDGE.slice(BRIDGE.indexOf('run.steer = (t, {'), BRIDGE.indexOf('function mirrorToRegistry'));
  ok(/if \(kind === 'btw' && !isBtwFramed\(t\)\) \{/.test(steer), 'the guard');
  ok(steer.indexOf('isBtwFramed(t)') < steer.indexOf('child.stdin.write('), '★ and it is BEFORE the write, because after it there is nothing to take back');
});

t('★ the pending line does not tick when there is no message to edit', () => {
  const notice = BRIDGE.slice(BRIDGE.indexOf('async function startBtwNotice'), BRIDGE.indexOf('function btwInto'));
  ok(/if \(msgId == null\) return;/.test(notice), 'a failed send must not arm the ticker');
  ok(
    notice.indexOf('if (msgId == null) return;') < notice.indexOf('live = registerLive('),
    '★ put() degrades to a fresh send, so a ticking entry with no message id sends one message every cadence for the whole wait',
  );
});

t('★ both exit handlers drain, and /stop keeps its own glyph', () => {
  ok(/drainBtw\(run, 'ended'\);/.test(BRIDGE), "the spawn-failure path, where 'close' never fires");
  ok(/drainBtw\(run, wasStopped \? 'stopped' : 'ended'\);/.test(BRIDGE), 'the close handler, split by whether the run was stopped');
  eq((CLAUDE_WORKER.match(/drainBtw\(run,/g) || []).length, 2, 'exactly two call sites on a Claude worker: the two ways a run ends');
  // A Codex job has ONE terminal path (finish), which is the whole reason it can
  // be one line: every ending, including the interrupt and the dead app-server,
  // goes through it.
  eq((CODEX_JOB.match(/drainBtw\(run,/g) || []).length, 1, 'the Codex job drains on its one terminal path');
  ok(/drainBtw\(run, outcome\.status === 'stopped' \? 'stopped' : 'ended'\);/.test(CODEX_JOB), 'and /stop keeps its own glyph there too');
});

t('★ the drain happens AFTER the final log pump, not before it', () => {
  // A worker writes its answer microseconds before exiting, so on a background
  // lane that line is usually still unread when 'close' fires. Draining first
  // would report "no answer" over an answer already on disk.
  const close = BRIDGE.slice(BRIDGE.indexOf("child.on('close'"));
  const pump = close.indexOf('tail?.stop();');
  const drain = close.indexOf("drainBtw(run, wasStopped");
  ok(pump !== -1 && drain !== -1, 'both anchors must exist');
  ok(pump < drain, 'the drain must not beat the final pump');
});

t('★ a btw is NOT recorded as a steer', () => {
  // Two consequences if it were: the SENT column of `bg.mjs ps` would count
  // questions as course corrections, and the "STEERED IN" block of the handback
  // would present a question to the orchestrator as an instruction it gave.
  ok(/if \(kind === 'steer'\) \{/.test(BRIDGE), 'the record is gated on the kind');
  ok(/kind === 'btw' \? '❓ btw' : '📨 steered in'/.test(BRIDGE), 'and the bubble note says which it was');
});

t('★ the daemon hands its CONFIGURED name to the framing', () => {
  // The half of the previous test that lives in bridge.mjs: btwFraming defaults
  // to the project name, and only this call site knows what this install is
  // actually called. Passing nothing would introduce a worker to a daemon that
  // does not answer to that name here.
  // BOTH ask sites: the Claude worker's and the background Codex job's. One of
  // them left unnamed is a daemon that introduces itself under two names inside
  // one feature, which is the thing this change exists to stop.
  eq((BRIDGE.match(/btwFraming\(record\.id, question, \{ name: BRIDGE_NAME \}\)/g) || []).length, 2, 'both ask sites pass config.name');
  eq((BRIDGE.match(/btwFraming\(record\.id, question\)/g) || []).length, 0, '★ an unnamed ask site would fall back to the built-in name');
  ok(/const BRIDGE_NAME = conf\('name'/.test(BRIDGE), 'and BRIDGE_NAME is the config value, not a literal');
});

t('★ the /btw state list in bridge.mjs names every ending, like the one in system-messages', () => {
  // Two enumerations of the same six states, in the two files that own the
  // halves. They are the checklist a new pending line is held against, so one
  // that has fallen behind sends the next reader looking for five endings when
  // there are six. btwRefusedLine was added without either being updated.
  const at = BRIDGE.indexOf('//   answered  the stream detector routes the block');
  ok(at > 0, 'the state list was not found, did the header get rewritten?');
  const list = BRIDGE.slice(at, BRIDGE.indexOf('// ------', at));
  for (const name of ['btwAnsweredLine', 'btwEndedLine', 'btwStoppedLine', 'btwLostLine', 'btwRefusedLine', 'btwWaitingLine']) {
    ok(list.includes(name), `★ ${name} is wired but the state list does not mention it`);
  }
});

t('the socket routes op btw to its own resolver, not to steerInto', () => {
  ok(/if \(req\.op === 'btw'\) return btwInto\(req\.target, req\.text\);/.test(BRIDGE), 'the socket arm');
  ok(/^function btwInto\(target, question\) \{/m.test(BRIDGE), 'and it exists');
  ok(/resolveSteerTarget\(target, bgWorkerDescriptors\(\)\)/.test(BRIDGE.slice(BRIDGE.indexOf('function btwInto'))), '★ the SAME resolver, never a second copy');
});

t('/btw is a real command, not a passthrough to Claude Code', () => {
  ok(/case '\/btw': \{/.test(BRIDGE), 'the switch arm');
  ok(/'\/btw',/.test(BRIDGE), 'RESERVED_COMMANDS, or it would be forwarded as a prompt');
  ok(/\{ command: 'btw', description:/.test(BRIDGE), 'setMyCommands, or it never appears in the Telegram menu');
});

t('★ the Telegram arm splits target from question correctly, on its real source lines', () => {
  // handleCommand is a 3,000-line switch that cannot be extracted, so the four
  // parsing lines are lifted out of the arm VERBATIM and run. That is the one
  // piece of /btw with no other executable coverage, and getting it wrong is
  // silent: "which repo are you in?" would resolve a worker called "which".
  const arm = BRIDGE.slice(BRIDGE.indexOf("case '/btw': {"), BRIDGE.indexOf("case '/codex': {"));
  const lines = arm.split('\n').filter((l) => /const (first|targeted|target|question) =/.test(l)).map((l) => l.trim());
  eq(lines.length, 4, 'the arm changed shape; this test is reading the wrong lines');
  const parse = new Function('a', 'looksLikeTarget', `${lines.join('\n')}\nreturn { target, question };`);
  for (const [input, wantTarget, wantQuestion] of [
    ['bg2 how far through the list?', 'bg2', 'how far through the list?'],
    ['latest did the migration apply?', 'latest', 'did the migration apply?'],
    ['bg-1788453512237 which repo?', 'bg-1788453512237', 'which repo?'],
    ['83808 which repo?', '83808', 'which repo?'],
    ['did the migration apply?', 'latest', 'did the migration apply?'],
    ['which repo are you in?', 'latest', 'which repo are you in?'],
    ['bg2   spaced   out   question', 'bg2', 'spaced   out   question'],
    ['bgel is a word not a lane', 'latest', 'bgel is a word not a lane'],
    ['bg2', 'bg2', ''],
    ['latest', 'latest', ''],
  ]) {
    const got = parse(input.trim(), looksLikeTarget);
    eq(got.target, wantTarget, `target for ${JSON.stringify(input)}`);
    eq(got.question, wantQuestion, `question for ${JSON.stringify(input)}`);
  }
});

t('★ the Telegram arm falls back to latest only when the first token is not a target', () => {
  const arm = BRIDGE.slice(BRIDGE.indexOf("case '/btw': {"), BRIDGE.indexOf("case '/codex': {"));
  ok(/looksLikeTarget\(first\)/.test(arm), 'the same shape test the CLI uses');
  ok(/targeted \? first : 'latest'/.test(arm), 'a question that starts with a word goes to the newest worker');
  ok(/btwUsage\(/.test(arm), 'and a bare /btw teaches the shape rather than guessing');
});

t('the boot path resolves what the previous daemon left pending', () => {
  ok(/resolveBtwAfterRestart\(id, rec\);/.test(BRIDGE), 'called from the pre-reattach registry sweep');
  const sweep = BRIDGE.slice(BRIDGE.indexOf('for (const [id, rec] of Object.entries(inflight.read()))'));
  ok(sweep.indexOf('resolveBtwAfterRestart') < sweep.indexOf('const survivors = reattachLiveWorkers()'), 'before re-attach clears anything');
});

t('the pending questions are mirrored to disk, which is what makes that possible', () => {
  ok(/btwPending: run\.btw\.list\(\)\.map\(btwRecordForDisk\)/.test(BRIDGE), 'one writer for the mirror');
  eq((CLAUDE_WORKER.match(/run\.btwMirror\(\);/g) || []).length, 2, 'written on ask and re-written on answer');
  // THREE on the Codex job, not two: written on ask, re-written on answer, and
  // re-written again when the server REFUSES the question. That third one is
  // load bearing for the same reason the first two are. A refused question is
  // resolved in this daemon, so leaving it on disk would have the next daemon
  // resolve the same ⏳ a second time, as "lost", after the owner already read
  // why it was not delivered.
  eq((CODEX_JOB.match(/run\.btwMirror\(\);/g) || []).length, 3, 'ask, answer, and the refusal that resolves the line early');
  ok(/record\.mirror = \(\) => w\.run\?\.btwMirror\?\.\(\);/.test(BRIDGE), '★ and again once the message id lands, which is the field a restart needs');
  ok(/record\.mirror\?\.\(\);/.test(BRIDGE), 'called from the notice, after the send returns');
});

// ---------------------------------------------------------------------------
// 6. The CLI, against a stub socket. What argv parsing can break in silence.
// ---------------------------------------------------------------------------

const TMP = mkdtempSync(path.join(tmpdir(), 'bg-btw-cli-'));
const BG = path.join(TMP, 'bg.mjs');
copyFileSync(path.join(DIR, 'bg.mjs'), BG);
const SOCK = path.join(TMP, STEER_SOCK_NAME);
const QUEUE = path.join(TMP, 'bg-queue.json');

const received = [];
const stub = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    const i = buf.indexOf('\n');
    if (i === -1) return;
    const decoded = decodeLine(buf.slice(0, i));
    received.push(decoded.ok ? decoded.value : { bad: buf.slice(0, i) });
    if (!decoded.ok) return sock.end(encodeLine(steerFailure(decoded.reason, { detail: decoded.detail })));
    const req = validateRequest(decoded.value);
    if (!req.ok) return sock.end(encodeLine(steerFailure(req.reason, { detail: req.detail })));
    if (req.op === 'ps') return sock.end(encodeLine({ ok: true, workers: [W], table: psTable([W]) }));
    const found = resolveSteerTarget(req.target, [W, REATTACHED]);
    if (!found.ok) {
      const { ok: _ok, worker, ...rest } = found;
      return sock.end(encodeLine(steerFailure(found.reason, { ...rest, op: req.op })));
    }
    return sock.end(encodeLine(steerResponse(found.worker, '2026-09-09T21:02:11.000Z', { op: req.op })));
  });
});
await new Promise((r) => stub.listen(SOCK, r));

const run = (args, cwd = TMP) =>
  new Promise((resolve) => {
    execFile(process.execPath, [BG, ...args], { cwd }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

const at = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
};

await at('a delivered btw prints the ack and exits 0', async () => {
  received.length = 0;
  const r = await run(['btw', 'bg', 'which', 'repo', 'are', 'you', 'in?']);
  eq(r.code, 0, r.stderr);
  eq(received[0].op, 'btw', 'the op on the wire decides the framing the daemon applies');
  eq(received[0].target, 'bg');
  eq(received[0].text, 'which repo are you in?');
  ok(r.stdout.includes('asked bg'), r.stdout);
});

await at('★ --file carries backticks and apostrophes into the question unchanged', async () => {
  received.length = 0;
  const q = "did `npm run build` finish, and what's the exit code for [a, b]?";
  const f = path.join(TMP, 'btw-q.md');
  writeFileSync(f, q);
  const r = await run(['btw', 'latest', '--file', f]);
  eq(r.code, 0, r.stderr);
  eq(received[0].text, q, 'the shell must not be in the path of a question either');
});

await at('a btw with no question is refused before it reaches the socket', async () => {
  received.length = 0;
  const r = await run(['btw', 'bg']);
  eq(r.code, 1);
  eq(received.length, 0, 'an empty question would cost the worker a whole turn on nothing');
  ok(r.stderr.includes('<question>'), `the usage must name what is missing: ${r.stderr}`);
});

await at('--file with no path is refused, and names the usage', async () => {
  received.length = 0;
  const r = await run(['btw', 'bg', '--file']);
  eq(r.code, 1);
  eq(received.length, 0);
  ok(r.stderr.includes('btw'), r.stderr);
});

await at('a refused btw prints the reason and exits 1', async () => {
  const r = await run(['btw', 'bg2', 'are you there?']);
  eq(r.code, 1);
  ok(r.stderr.includes('NOT delivered'), r.stderr);
  ok(r.stderr.includes(REASONS.NOT_STEERABLE), r.stderr);
});

await at('an unknown target is refused, not silently dispatched as a job', async () => {
  received.length = 0;
  rmSync(QUEUE, { force: true });
  const r = await run(['btw', '99999', 'hello']);
  eq(r.code, 1);
  eq(received[0].op, 'btw', 'it reached the socket and was refused there, which is where the workers are');
  let queued = [];
  try {
    queued = JSON.parse(readFileSync(QUEUE, 'utf8'));
  } catch {
    /* no queue file at all is the same answer */
  }
  eq(queued.length, 0, '★ a mistyped target must never become a background job');
});

await at('★ a targetless CLI btw is REFUSED, never dispatched as a background job', async () => {
  // The deliberate asymmetry with Telegram, and the reason it needs its own
  // arm: without one this fell through to the dispatch path and SPAWNED A
  // WORKER whose brief was the question, printing "handed to background lane"
  // and exiting 0, so the caller believed it had asked something (QA,
  // 2026-09-09). A scripted caller that named no worker has not decided which
  // one it meant, and a side question answered by the wrong job reads exactly
  // like an answer from the right one.
  received.length = 0;
  rmSync(QUEUE, { force: true });
  const r = await run(['btw', 'did the migration apply?']);
  eq(r.code, 1, 'refused, loudly');
  eq(received.length, 0, 'it must not silently pick a worker');
  ok(r.stderr.includes('btw needs a target'), r.stderr);
  ok(r.stderr.includes('bg.mjs ps'), 'and it names how to find one');
  let queued = [];
  try {
    queued = JSON.parse(readFileSync(QUEUE, 'utf8'));
  } catch {
    /* no queue file at all is the same answer */
  }
  eq(queued.length, 0, '★ a whole worker must not be spent on a mistyped question');
});

await at('the same refusal for a bare btw and for --file with no target', async () => {
  received.length = 0;
  rmSync(QUEUE, { force: true });
  for (const args of [['btw'], ['btw', '--file', '/tmp/nope.md'], ['btw', 'the', 'release', 'thing']]) {
    const r = await run(args);
    eq(r.code, 1, args.join(' '));
    ok(r.stderr.includes('btw needs a target'), `${args.join(' ')}: ${r.stderr}`);
  }
  eq(received.length, 0);
  let queued = [];
  try {
    queued = JSON.parse(readFileSync(QUEUE, 'utf8'));
  } catch {
    /* nothing queued */
  }
  eq(queued.length, 0);
});

await at('★ and the steer guard is NOT widened by it', async () => {
  // `steer the release notes away from the old template` is a real brief and
  // has dispatched since the subcommand landed. The btw refusal is about the
  // word "btw", not about subcommands in general.
  received.length = 0;
  rmSync(QUEUE, { force: true });
  const r = await run(['steer', 'the', 'release', 'notes', 'away', 'from', 'the', 'old', 'template']);
  eq(r.code, 0, r.stderr);
  eq(received.length, 0, 'the socket must not have been touched');
  eq(JSON.parse(readFileSync(QUEUE, 'utf8')).length, 1, 'it is still a job');
});

await at('★ a brief that BEGINS with the word btw still dispatches a job', async () => {
  // The same guard the steer subcommand has: "btw the release notes need the
  // old template" is a brief, not a question aimed at a worker called "the".
  received.length = 0;
  rmSync(QUEUE, { force: true });
  const r = await run(['btw the release notes still need the old template']);
  eq(r.code, 0, r.stderr);
  eq(received.length, 0, 'the socket must not have been touched');
  const queued = JSON.parse(readFileSync(QUEUE, 'utf8'));
  eq(queued.length, 1);
  ok(queued[0].text.endsWith('btw the release notes still need the old template'), queued[0].text.slice(-80));
});

await at('the plain dispatch form is untouched, lane rules and all', async () => {
  rmSync(QUEUE, { force: true });
  const r = await run(['run the full suite and report what fails']);
  eq(r.code, 0, r.stderr);
  const queued = JSON.parse(readFileSync(QUEUE, 'utf8'));
  eq(queued.length, 1);
  ok(queued[0].text.startsWith('LANE RULES'), 'the guard must not have widened into the dispatch path');
  ok(queued[0].text.includes('[BTW #N from the orchestrator]'), 'and rule 5 rides along');
});

await at('★ the usage line lists btw, so a bare invocation teaches it', async () => {
  rmSync(QUEUE, { force: true });
  const r = await run([]);
  eq(r.code, 1);
  ok(r.stderr.includes('node bg.mjs btw <lane|runId|pid|latest>'), r.stderr);
  let queued = [];
  try {
    queued = JSON.parse(readFileSync(QUEUE, 'utf8'));
  } catch {
    /* no file is the same answer */
  }
  eq(queued.length, 0, 'a usage print must never queue a job');
});

await at('with no daemon listening the CLI says so and exits 2', async () => {
  const cold = mkdtempSync(path.join(tmpdir(), 'bg-btw-cold-'));
  copyFileSync(path.join(DIR, 'bg.mjs'), path.join(cold, 'bg.mjs'));
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(cold, 'bg.mjs'), 'btw', 'latest', 'anything'], { cwd: cold }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
  eq(r.code, 2, 'exit 2 is "the daemon is not reachable", distinct from a refusal');
  ok(/not reachable/.test(r.stderr), r.stderr);
  rmSync(cold, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
console.log('\n8. the detector over a CODEX agent message item');
// ---------------------------------------------------------------------------
//
// A Claude worker's answer arrives as a stream-json assistant text block; a
// Codex job's arrives as an app-server `item/completed` carrying an agentMessage.
// Different transports, ONE detector, and these are the exact shapes the live
// binary produced against this framing (probe, 2026-09-09).

const codexMsg = (text) => mapNotification({ method: 'item/completed', params: { threadId: 't1', turnId: 'turn-1', item: { id: 'm1', type: 'agentMessage', text } } });

t('★ an agentMessage item carrying the marker is routed, and its text lifted out', () => {
  const tracker = createBtwTracker();
  const rec = tracker.add({ lane: 'codex' });
  const ev = codexMsg(`${BTW_ANSWER_PREFIX} #${rec.id}: it is b.txt`);
  eq(ev.kind, 'message', 'the app-server item did not map to a message at all');
  const res = tracker.take(ev.text);
  eq(res.status, 'routed');
  eq(res.entry, rec, 'a Codex answer must resolve the question it was asked');
  eq(res.answer, 'it is b.txt');
});

t('★ the model\'s NARRATION before the answer is left completely alone', () => {
  // Measured on the live binary: the first agent message after a btw was
  // "I will create the files in alphabetical order...", and the real
  // BTW-ANSWER arrived 27 seconds later. Swallowing the narration would have
  // deleted the job\'s own output and sent a progress note as the answer.
  const tracker = createBtwTracker();
  tracker.add({ lane: 'codex' });
  const ev = codexMsg('I will create the files in alphabetical order, with a pause between each.');
  eq(tracker.take(ev.text).status, 'none');
  eq(tracker.size, 1, 'the question is still outstanding');
});

t('a job that mentions the marker mid-sentence is not mistaken for an answer', () => {
  const tracker = createBtwTracker();
  tracker.add({ lane: 'codex' });
  const ev = codexMsg(`I will emit ${BTW_ANSWER_PREFIX} #1 once the build finishes.`);
  eq(tracker.take(ev.text).status, 'none', 'the marker must be the HEAD of the first line');
});

t('the final report the model writes under a Side questions heading is not an answer either', () => {
  // The live probe\'s last message ended "### Side questions #1: ...", which is
  // the framing working as intended. It is the report, and it must reach the
  // handback intact.
  const tracker = createBtwTracker();
  tracker.add({ lane: 'codex' });
  const ev = codexMsg('Created a.txt through j.txt and z.txt.\n\n### Side questions\n#1: b.txt at the time.');
  eq(tracker.take(ev.text).status, 'none');
});

stub.close();
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bg-btw tests pass');
