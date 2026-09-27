#!/usr/bin/env node
// Hand a long job to a Leash BACKGROUND worker and return instantly.
//
//   node bg.mjs "run the full test suite and report what fails"
//   node bg.mjs --file ./brief.md                   (preferred for real briefs)
//   node bg.mjs --engine codex --file ./brief.md    (run it on OpenAI Codex, not Claude)
//   node bg.mjs --now --file ./brief.md             (start it past the concurrency cap)
//   node bg.mjs "codex: review the last commit"     (same thing, inline prefix)
//   node bg.mjs --engine claude --file /tmp/b.md    (pin to Claude on a Codex-first install)
//   node bg.mjs steer <lane|runId|pid|latest> "one more instruction"
//   node bg.mjs steer <lane|runId|pid|latest> --file ./steer.md
//   node bg.mjs btw <lane|runId|pid|latest> "a side question"
//   node bg.mjs btw <lane|runId|pid|latest> --file ./btw.md
//   node bg.mjs ps                                  (what is running, right now)
//
// The Leash daemon drains this drop-box each poll cycle (<=~1 min) and runs the
// text in its own background Claude session, streaming progress to Telegram.
// The calling session is free immediately.
//
// Workers are never refused: if one is busy, the daemon spawns another, so
// several handoffs run in PARALLEL. How many Claude workers run AT ONCE is
// capped (`maxConcurrentWorkers` in config.json, default 3); a job past the cap
// waits in this same drop box and starts as a slot frees, and `bg.mjs ps`
// lists it while it waits.
//
// When the job finishes, its output is delivered to the CHAT lane as a worker
// report — the assistant decides what to do and gives you a short update.
// Raw output never goes straight to your chat. History: bg-results.jsonl.
//
// A background worker is a SEPARATE session: it does not see your conversation,
// so write each task self-contained. Its result does NOT come back into your
// current turn — use it for "go do this and report", not for work whose result
// you need in order to answer right now.
//
// `steer` is the alternative to killing a worker: it writes one more instruction
// into a RUNNING worker's stdin, keeping the context it has already built. Kill
// and re-dispatch only when the brief itself was wrong.
//
// `btw` is the same pipe with the OPPOSITE framing: a side question that is
// explicitly not an instruction, answered in one message and then dropped, with
// the worker carrying on exactly where it was. Use it for "which repo are you
// in" and "did the migration apply"; use `steer` when the job has to change.
// The answer goes to the Telegram chat, not to this terminal: the daemon is the
// only thing watching the worker's stream. Availability is IDENTICAL to steer,
// so the STEER column of `bg.mjs ps` answers both questions.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(SCRIPT_DIR, 'bg-queue.json');
const SOCK = path.join(SCRIPT_DIR, 'steer.sock');

// --file <path> reads the brief from disk instead of argv. Use it for anything
// longer than a line.
//
// Passing a brief as a shell argument means backticks inside it become COMMAND
// SUBSTITUTION: a brief mentioning `SomeName` or `npm run build` reaches the
// worker with those terms silently REPLACED BY EMPTY STRINGS — the shell prints
// "command not found" and hands over a brief missing the exact facts it was
// written to convey. `[a, b]` trips glob expansion the same way. Single-quoting
// is a workaround that breaks on the first apostrophe, which prose always has.
// Reading from a file removes the shell from the path entirely.
const argv = process.argv.slice(2);

// Read the payload from --file if present, else from the remaining argv.
function payload(args, usage) {
  const fileFlag = args.indexOf('--file');
  if (fileFlag !== -1) {
    const p = args[fileFlag + 1];
    if (!p) {
      console.error(usage);
      process.exit(1);
    }
    try {
      return readFileSync(p, 'utf8').trim();
    } catch (e) {
      console.error(`bg.mjs: cannot read ${p}: ${e.message}`);
      process.exit(1);
    }
  }
  return args.join(' ').trim();
}

// ---------------------------------------------------------------------------
// SUBCOMMANDS: and why they cannot simply be `argv[0] === 'steer'`.
//
// This CLI's first form is `node bg.mjs "<brief>"`, and a brief is prose: "steer
// the release notes away from the old template" is a perfectly good job. Read
// naively, that would dispatch a steer at a worker called "the". So `steer` only
// engages when the NEXT argument actually looks like a target, and `ps` only
// when it is the whole command line. Anything else is a brief, exactly as before.
//
// KEEP IN SYNC with TARGET_SHAPE in bg-steer.mjs (bg-steer.test.mjs asserts the
// two copies match). This file imports node built-ins only, on purpose: it is
// copied around and run from anywhere, and its own test copies it alone into a
// temp dir.
// ---------------------------------------------------------------------------
const TARGET_SHAPE = /^(?:latest|\d+|bg\d*|[A-Za-z][A-Za-z0-9_]*-\d{10,}(?:-\d+)?)$/;
const UNREACHABLE = `bridge daemon not reachable at ${SOCK}; it must be running the version with steering (restart with safe-restart.sh after upgrading)`;

// One request, one response, one connection. Newline-delimited JSON.
function ask(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      fn(v);
    };
    const sock = net.createConnection(SOCK);
    let buf = '';
    sock.setTimeout(15_000);
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i === -1) return;
      sock.end();
      try {
        done(resolve, JSON.parse(buf.slice(0, i)));
      } catch (e) {
        done(reject, new Error(`bad response from the daemon: ${e.message}`));
      }
    });
    sock.on('timeout', () => {
      sock.destroy();
      done(reject, Object.assign(new Error('the daemon accepted the connection but never answered'), { unreachable: true }));
    });
    sock.on('error', (e) => done(reject, Object.assign(e, { unreachable: true })));
    // A close with no line at all is the daemon dying mid-request, not an answer.
    sock.on('close', () => done(reject, Object.assign(new Error('connection closed with no response'), { unreachable: true })));
  });
}

if (argv[0] === 'ps' && argv.length === 1) {
  let res;
  try {
    res = await ask({ op: 'ps' });
  } catch (e) {
    console.error(e.unreachable ? UNREACHABLE : `bg.mjs ps: ${e.message}`);
    process.exit(2);
  }
  console.log(res.table || (res.workers || []).map((w) => `${w.runId} ${w.lane} ${w.pid}`).join('\n') || 'no background workers running');
  process.exit(0);
}

// `steer` and `btw` are the same subcommand shape over the same socket and
// differ only in the op and the framing the daemon applies, so they are one
// arm rather than two that drift. NOTE the deliberate asymmetry with the
// Telegram side: there, a first token that is not target-shaped is read as the
// start of the question and the target falls back to `latest`, because you are
// typing on a phone. HERE it is not, and must not be: `bg.mjs btw "did it
// apply"` would then silently pick a worker for a scripted caller that named
// none, and a side question sent to the wrong job reads as an answer about the
// right one. The CLI prints the usage line instead.
if ((argv[0] === 'steer' || argv[0] === 'btw') && TARGET_SHAPE.test(String(argv[1] ?? '').trim())) {
  const op = argv[0];
  const target = argv[1].trim();
  const what = op === 'btw' ? '<question>' : '<text>';
  const usage = `usage: node bg.mjs ${op} <lane|runId|pid|latest> "${what}"   |   node bg.mjs ${op} <target> --file <path>`;
  const body = payload(argv.slice(2), usage);
  if (!body) {
    console.error(usage);
    process.exit(1);
  }
  let res;
  try {
    res = await ask({ op, target, text: body });
  } catch (e) {
    console.error(e.unreachable ? UNREACHABLE : `bg.mjs ${op}: ${e.message}`);
    process.exit(2);
  }
  const verb = op === 'btw' ? 'asked' : 'steered into';
  const line = res.ack || (res.ok ? `${verb} ${res.lane} (${res.runId}, pid ${res.pid})` : `NOT delivered: ${res.reason}`);
  if (res.ok) console.log(line);
  else console.error(line);
  process.exit(res.ok ? 0 : 1);
}

// AND THE HALF THAT MAKES THAT ASYMMETRY REAL. Without this, `bg.mjs btw "did
// the migration apply?"` falls straight through to the dispatch path below and
// SPAWNS A WHOLE BACKGROUND WORKER whose brief is the question, printing
// "handed to background lane" and exiting 0, so the caller believes it asked
// something while a worker burns tokens on a report nobody wanted (QA,
// 2026-09-09).
//
// It applies to `btw` ONLY, and the difference from `steer` is a fact about the
// two words rather than a preference: "steer the release notes away from the
// old template" is a real brief and the ambiguity there is a deliberate,
// documented trade. "btw" opening a brief is not a use anyone has, and the
// quoted form (`bg.mjs "btw also update the README"`) is one argv element, so
// it never reaches this test at all. What is refused is the UNQUOTED form,
// loudly and for free, instead of silently spending a worker on it.
if (argv[0] === 'btw') {
  console.error(
    [
      'usage: node bg.mjs btw <lane|runId|pid|latest> "<question>"',
      '       node bg.mjs btw <target> --file <path>',
      '',
      'btw needs a target: unlike /btw in Telegram it will not fall back to `latest`,',
      'because a side question answered by the wrong worker reads exactly like an',
      'answer from the right one. `node bg.mjs ps` lists what is running.',
    ].join('\n'),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ENGINE SELECTION. Leash can run a job on a second coding agent (OpenAI Codex,
// `codex exec`) instead of Claude, on separate billing, either because it was
// asked for (a cross-family second opinion, or an OpenAI-specific task) or
// because every Claude account is rate limited and the work still has to move.
//
// The flag travels on the queue ITEM rather than inside the text: the daemon
// has to know the engine before it composes the handoff notice, and a marker
// buried in prose would be one more thing to parse out of a brief.
//
// A `claude:` prefix (and `--engine claude`) is the mirror image, and it earns
// its keep on a Codex-first install: with `engine.bg: "codex"` in config.json
// EVERY handed-off job runs on Codex, and pinning one back to Claude has to be
// as cheap as the other direction.
//
// KEEP IN SYNC with ENGINE_PREFIX_RE in engine-state.mjs (bg-codex.test.mjs
// asserts the two copies match). This file imports node built-ins only, on
// purpose.
// ---------------------------------------------------------------------------
const ENGINE_PREFIX_RE = /^\s*(codex|claude):\s*/i;
let engine = null;
const dispatchArgs = argv.slice();

// --now: START THIS ONE PAST THE CONCURRENCY CAP.
//
// The daemon runs at most `maxConcurrentWorkers` Claude workers at a time
// (config.json, default 3) because four of them plus the chat lane exhausted
// every Claude account at once on 2026-09-21 and three jobs died mid flight.
// Everything past the cap QUEUES and starts as slots free, so this flag is not
// about getting work accepted: it is accepted either way. It is about jumping a
// queue, and it exists because "the build is broken and three renders are
// running" is a real situation.
//
// Explicit at dispatch, never automatic, and deliberately not a config value: a
// cap that lifts itself under pressure is not a cap, and pressure is exactly
// when it has to hold.
let now = false;
const nowFlag = dispatchArgs.indexOf('--now');
if (nowFlag !== -1) {
  now = true;
  dispatchArgs.splice(nowFlag, 1);
}
const engineFlag = dispatchArgs.indexOf('--engine');
if (engineFlag !== -1) {
  const v = String(dispatchArgs[engineFlag + 1] ?? '').toLowerCase();
  if (v !== 'codex' && v !== 'claude') {
    console.error(`bg.mjs: --engine takes "codex" or "claude" (got ${JSON.stringify(dispatchArgs[engineFlag + 1] ?? '')})`);
    process.exit(1);
  }
  engine = v;
  dispatchArgs.splice(engineFlag, 2);
}

let text = payload(dispatchArgs, 'usage: node bg.mjs [--engine codex] [--now] --file <path-to-brief>');

// `codex: do the thing` / `claude: do the thing` are the engine siblings of the
// `bg:` prefix, for when typing a flag is more friction than the job is worth.
// An explicit --engine still wins: the flag is the more deliberate of the two.
const enginePrefix = text.match(ENGINE_PREFIX_RE);
if (enginePrefix) {
  engine = engine || enginePrefix[1].toLowerCase();
  text = text.replace(ENGINE_PREFIX_RE, '');
}

if (!text) {
  console.error(
    [
      'usage: node bg.mjs "<task>"   |   node bg.mjs --file <path-to-brief>',
      '       node bg.mjs --engine codex|claude --file <path>   (pick the engine for this job)',
      '       node bg.mjs --now --file <path>                   (start it past the concurrency cap)',
      '       node bg.mjs "codex: <task>" | "claude: <task>"    (same, inline prefix)',
      '       node bg.mjs steer <lane|runId|pid|latest> "<text>" | --file <path>',
      '       node bg.mjs btw <lane|runId|pid|latest> "<question>" | --file <path>',
      '       node bg.mjs ps',
    ].join('\n'),
  );
  process.exit(1);
}

// LANE RULES. A background worker is headless: no tmux, no terminal, no turn to
// come back to. Facts follow from that, and a worker that has not been told them
// learns them the expensive way, by being BLOCKED on its first action: a
// baseline check dispatched with run_in_background comes back empty, and an
// Agent call dispatched that way dies at turn end with no verdict at all.
//
// The brief is the only place these can arrive in time, so they are prepended
// here, mechanically, to every brief the lane carries, rather than depending on
// each brief's author remembering.
//
// The trailing `--- TASK ---` line is LOAD-BEARING, not decoration: it is the
// anchor bridge.mjs splits on (stripLaneRules in bg-lane-rules.mjs) so the
// Telegram handoff notice and /status show the JOB rather than these rules.
// Removing or renaming it puts every notification back to a kilobyte of
// identical boilerplate. bg-lane-rules.test.mjs round-trips a brief through
// THIS file to catch that.
//
// No imports on purpose: bg.mjs is a fast standalone CLI, copied around and run
// from anywhere (its own test copies it into a temp dir).
const LANE_RULES = [
  'LANE RULES (you are a background worker: headless, no tmux, no terminal). These are runtime facts, not preferences:',
  `1. NEVER use run_in_background: not on Bash, not on an Agent/Task dispatch. In this lane a backgrounded process is KILLED when your turn ends, the output file stays empty, and no completion notification is ever delivered. Run it in the FOREGROUND and read the exit code in-turn, or hand a genuinely long job to its own worker with \`node ${SCRIPT_DIR}/bg.mjs --file <brief>\`.`,
  '2. Bash caps at 600s. Anything longer must be CHUNKED into bounded foreground runs that each report and can be resumed. Never one long watch or poll loop: it gets killed at the ceiling with its outcome uncaptured.',
  '3. Your final message IS your report, and it is handed to the chat session as it stands. Do not compress, truncate or summarise it to fit a message limit; the bridge excerpts it if it has to.',
  '4. A message that starts with [STEER from the orchestrator] can arrive mid-run. It is an instruction for your CURRENT task from the session that dispatched you: fold it in at your next step, and quote it under a "Steered in" heading in your final report.',
  '5. A message that starts with [BTW #N from the orchestrator] is the OPPOSITE of a steer: a side question, not an instruction, not approval, and not a new task. Answer it immediately in ONE message whose first line is exactly `BTW-ANSWER #N:`, in ONE paragraph (plain text, under 1500 characters, no em or en dashes), then continue exactly where you were with your plan unchanged. If your task is already finished when the question arrives, put the answer first, leave one blank line, and write your report below it. Add one line per side question under a "Side questions" heading in your final report.',
  '',
  '--- TASK ---',
  '',
].join('\n');

// Idempotent: a brief that already carries the header (a re-queued job, a worker
// handing its own brief on) must not accumulate copies of it.
//
// A Codex job gets NO lane rules: every one of them is a fact about a headless
// CLAUDE worker (the Agent tool, the 600s Bash ceiling, steering), none of which
// Codex has. Prepending them would be a page of wrong instructions, paid for by
// the token. The daemon strips them anyway when it routes a Claude-shaped brief
// to Codex on the limit fallback.
if (engine !== 'codex' && !text.startsWith('LANE RULES')) text = `${LANE_RULES}${text}`;

// The daemon drains this file concurrently. A pid-unique temp keeps our write
// from clobbering (or being clobbered by) its claim, and re-reading inside the
// retry loop means an item can't be lost to a drain that landed mid-flight.
const TMP = `${FILE}.${process.pid}.tmp`;
// Stamped ONCE, before the retry loop, rather than per attempt. A retry happens
// because the daemon's claim landed between our read and our rename, which is a
// property of the disk, not of when the job was handed over: restamping would
// make a contended dispatch look later than an uncontended one and reorder the
// FIFO the admission queue depends on. It is also this item's identity in
// `bg.mjs ps`, which is how a queued job is told apart from its neighbours.
const queuedAt = new Date().toISOString();
let pending = 0;
let lastErr;

for (let attempt = 0; attempt < 5; attempt++) {
  let items = [];
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    /* missing or mid-rename — treat as empty and retry on failure */
  }
  items.push({ text, queuedAt, ...(engine ? { engine } : {}), ...(now ? { now: true } : {}) });
  try {
    writeFileSync(TMP, JSON.stringify(items, null, 2));
    renameSync(TMP, FILE);
    pending = items.length;
    lastErr = null;
    break;
  } catch (e) {
    lastErr = e;
  }
}

if (lastErr) {
  console.error(`could not hand off after 5 attempts: ${lastErr.message}`);
  process.exit(1);
}

const where =
  engine === 'codex'
    ? 'the CODEX lane'
    : engine === 'claude'
      ? 'the background lane (pinned to Claude)'
      : 'background lane';

// "HANDED OFF" NO LONGER IMPLIES "RUNNING", so the acknowledgement says so.
// The daemon runs a bounded number of Claude workers (see --now above) and
// everything past the cap waits in this same drop box, so an ack that read
// only "3 pending" would let a job sit in a queue with nothing on screen
// saying it was waiting.
//
// SAID, NOT ASKED, and that is deliberate. An earlier version of this line put
// the question to the daemon over the steer socket. Three things were wrong
// with it, and only the last one is about tests:
//
//   1. It blocked. ask() sets a 15 second socket timeout, so a daemon that was
//      busy or mid restart turned "returns instantly" (the entire reason this
//      CLI exists, and the reason the chat stays reachable) into a stall on a
//      path whose work had ALREADY SUCCEEDED.
//   2. It raced. The daemon drains on its own cycle, so the answer was a
//      snapshot that could be stale before it finished printing, and
//      "QUEUED, position 2" that is wrong is worse than no position at all.
//   3. It touched the steer socket on the DISPATCH path. `bg.mjs steer the
//      reels pipeline away from the old template` is a brief, not a steer, and
//      the guard that proves it stayed a brief is "the socket was not touched".
//      Making every dispatch touch the socket retires that discriminator for
//      good, so a future misroute would sail straight through it.
//
// The live view belongs to `bg.mjs ps`, which is a QUERY: it may ask the
// daemon, it is not on the hot path, and it is the one authoritative answer.
// This line's job is to point at it and to never imply a start it cannot know.
//
// The cap is read best effort for the number only, in the daemon's own order
// (BRIDGE_MAX_CONCURRENT_WORKERS, then config.json at BRIDGE_CONFIG or beside
// this file), and the number is simply omitted when it cannot be read. There is
// deliberately no fallback default here: bg.mjs is run from sessions whose
// environment is not the daemon's, and a second hardcoded copy of the default
// would be a second thing to get wrong the day it changes. bg-admission.mjs
// owns it.
let cap = null;
try {
  let raw = process.env.BRIDGE_MAX_CONCURRENT_WORKERS;
  if (raw === undefined) {
    const c = JSON.parse(readFileSync(process.env.BRIDGE_CONFIG || path.join(SCRIPT_DIR, 'config.json'), 'utf8'));
    raw = c?.maxConcurrentWorkers;
  }
  const n = Number(raw);
  if (raw !== '' && raw !== null && Number.isFinite(n) && n >= 1) cap = Math.floor(n);
} catch {
  /* no config.json, or an unreadable one: say it without the number */
}
const pacing =
  engine === 'codex'
    ? 'not capped' // Codex is billed separately, see bg-admission.mjs
    : now
      ? 'starts past the cap (--now)'
      : cap
        ? `up to ${cap} run at once, the rest start as slots free · bg.mjs ps`
        : 'past the cap jobs queue and start as slots free · bg.mjs ps';

console.log(`handed to ${where} (${pending} pending · ${pacing}): ${text.slice(0, 80)}`);
