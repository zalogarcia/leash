#!/usr/bin/env node
// LIVE PROOF that a BACKGROUND job can be reached mid-run on `codex app-server`.
//
// bg-codex-wiring.test.mjs proves runCodexAppServerJob against a FAKE server,
// which is the right place for branch coverage and costs nothing. This proves
// the two mechanisms the whole feature rests on against the REAL binary, the
// real ChatGPT login on this Mac, and a real running turn:
//
//   1. a /btw delivered as turn/steer is answered WHILE THE TURN IS STILL
//      RUNNING, in one agent message whose first line is BTW-ANSWER #1:
//   2. a real STEER delivered the same way changes what the turn does, proven
//      by a file on disk that the original brief never asked for
//   3. turn/interrupt ends a fresh turn with status `interrupted`
//
// It spawns `codex app-server` DIRECTLY. No daemon, no bridge.mjs, no Telegram:
// what is being proven here is the protocol, and anything else in the path is
// something else that could be blamed when it works.
//
//   node scripts/probes/codex-bg-appserver-probe.mjs
//
// Bounded: PROBE_DEADLINE_MS ends it rather than letting it hang a caller.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = (f) => import(pathToFileURL(path.join(DIR, f)).href);

const {
  createJsonLineReader,
  frameMessage,
  initializeRequest,
  initializedNotification,
  threadStartRequest,
  turnStartRequest,
  turnSteerRequest,
  turnInterruptRequest,
} = await mod('codex-appserver.mjs');
const { btwFraming, parseBtwAnswer, BTW_ANSWER_PREFIX } = await mod('bg-btw.mjs');
const { steerFraming } = await mod('bg-steer.mjs');

const PROBE_DEADLINE_MS = 8 * 60_000;
const BTW_AT_MS = 15_000; // the brief's number: 15s into a turn that takes a minute
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'codex-bg-probe-'));

const started = Date.now();
const at = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(3, ' ')}s`;
const say = (...a) => console.log(at(), ...a);
const failures = [];
const check = (cond, msg) => {
  console.log(`${at()} ${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failures.push(msg);
};

say(`scratch dir: ${SCRATCH}`);

// ---------------------------------------------------------------------------
// The client: the same framing and the same request builders the daemon uses.
// ---------------------------------------------------------------------------
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
const pending = new Map();
const listeners = new Set();
let nextId = 1;

const reader = createJsonLineReader(
  (msg) => {
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(String(msg.error.message || 'refused')));
      else p.res(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    for (const cb of listeners) cb(msg);
  },
  (line) => say('non-JSON on stdout:', line.slice(0, 120)),
);
child.stdout.on('data', (d) => reader.push(d));
child.stderr.on('data', (d) => process.stderr.write(`[app-server] ${d}`));
child.on('close', (code) => say(`app-server exited (${code})`));

const call = (build, timeoutMs = 60_000) => {
  const id = nextId++;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`no answer to request ${id} in ${timeoutMs}ms`));
    }, timeoutMs);
    const done = (fn) => (v) => {
      clearTimeout(timer);
      fn(v);
    };
    pending.set(id, { res: done(res), rej: done(rej) });
    child.stdin.write(frameMessage(build(id)));
  });
};
const notify = (msg) => child.stdin.write(frameMessage(msg));

const deadline = setTimeout(() => {
  console.error('PROBE DEADLINE HIT');
  try {
    child.kill('SIGKILL');
  } catch {
    /* gone */
  }
  process.exit(2);
}, PROBE_DEADLINE_MS);
deadline.unref?.();

// Everything the turn emits, so a failure can be read rather than guessed at.
const agentMessages = []; // { text, atMs, turnId }
const steps = [];
let turnDone = null;
let liveTurnId = null;

listeners.add((msg) => {
  const p = msg.params || {};
  if (msg.method === 'turn/started') liveTurnId = p.turn?.id || liveTurnId;
  if (msg.method === 'item/started' && p.item?.type === 'commandExecution') {
    steps.push(String(p.item.command || '').slice(0, 100));
    say('step:', String(p.item.command || '').replace(/\s+/g, ' ').slice(0, 100));
  }
  if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') {
    const text = String(p.item.text || '');
    agentMessages.push({ text, atMs: Date.now() - started, turnId: p.turnId || null });
    say(`agentMessage (turn still running: ${turnDone === null}):`, text.replace(/\s+/g, ' ').slice(0, 160));
  }
  if (msg.method === 'turn/completed') {
    turnDone = { status: p.turn?.status || 'completed', turnId: p.turn?.id || null };
    say('turn/completed:', turnDone.status);
  }
});

const waitFor = (cond, ms, what) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return res(true);
      if (Date.now() - t0 > ms) return rej(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 200);
    };
    tick();
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
say('initialize');
const info = await call((id) => initializeRequest(id), 20_000);
say('initialize ok:', JSON.stringify(info).slice(0, 160));
notify(initializedNotification());

// ---------------------------------------------------------------------------
say('thread/start in the scratch dir, workspace-write');
const thread = await call((id) => threadStartRequest(id, { cwd: SCRATCH, sandbox: 'workspace-write' }), 30_000);
const threadId = thread?.thread?.id;
say('thread:', threadId ? 'started' : 'NONE');
check(Boolean(threadId), 'thread/start returned a thread id');

// ---------------------------------------------------------------------------
// TURN 1: long enough to be steered twice while it runs.
// ---------------------------------------------------------------------------
const BRIEF = [
  'Create ten files in the current directory, named a.txt through j.txt.',
  'Create them ONE AT A TIME, in alphabetical order, and run `sleep 5` between each one.',
  'Each file should contain its own name.',
  'When all ten exist, reply with the list of files you created.',
].join(' ');

turnDone = null;
const t1 = await call(
  (id) =>
    turnStartRequest(id, {
      threadId,
      text: BRIEF,
      sandbox: 'workspace-write',
      network: false,
      cwd: SCRATCH,
    }),
  30_000,
);
const turn1 = t1?.turn?.id;
say('turn/start returned immediately, turn id:', turn1 ? 'yes' : 'NO');
check(Boolean(turn1), 'turn/start returns the turn id before the first token');
check(t1?.turn?.status === 'inProgress', `turn starts inProgress (got ${t1?.turn?.status})`);

// ---------------------------------------------------------------------------
// PROOF 1: a /btw, framed exactly as the daemon frames it, mid-turn.
// ---------------------------------------------------------------------------
await sleep(BTW_AT_MS);
const btwBefore = agentMessages.length;
say(`sending a BTW as turn/steer (${Math.round(BTW_AT_MS / 1000)}s in, turn running: ${turnDone === null})`);
const btwText = btwFraming(1, 'which file did you just write?');
let btwAccepted = true;
try {
  const res = await call((id) => turnSteerRequest(id, { threadId, turnId: turn1, text: btwText }), 30_000);
  say('turn/steer accepted:', JSON.stringify(res).slice(0, 120));
} catch (e) {
  btwAccepted = false;
  say('turn/steer REFUSED:', e.message);
}
check(btwAccepted, 'turn/steer with expectedTurnId is accepted mid-turn');

// WAIT FOR THE ONE THAT PARSES, not for the next message. Codex narrates before
// it acts ("I'll create the files in alphabetical order..."), so the first agent
// message after a btw is routinely not the answer. The daemon's detector has the
// same shape for the same reason: it offers EVERY agent message to the tracker
// and only the one whose first line is the marker is routed and swallowed.
// (Measured on the first run of this probe: narration at 40s, the real
// BTW-ANSWER #1 at 67s, both inside a turn that completed at 120s.)
const btwAnswered = () => agentMessages.slice(btwBefore).some((m) => parseBtwAnswer(m.text));
await waitFor(btwAnswered, 240_000, 'an agent message answering the btw').catch((e) => say('WARNING:', e.message));
const answerMsg = agentMessages.slice(btwBefore).find((m) => parseBtwAnswer(m.text));
const stillRunning = turnDone === null;
say('turn still running when the answer arrived:', stillRunning);
check(Boolean(answerMsg), `an agent message begins with ${BTW_ANSWER_PREFIX} #1:`);
if (answerMsg) {
  const parsed = parseBtwAnswer(answerMsg.text);
  say('BTW answer parsed → id', parsed.id, '·', parsed.answer.replace(/\s+/g, ' ').slice(0, 160));
  check(parsed.id === 1, `the answer carries the id it was asked with (got ${parsed.id})`);
  check(stillRunning, 'the answer arrived while the turn was still running');
}

// ---------------------------------------------------------------------------
// PROOF 2: a real STEER changes what the turn does.
// ---------------------------------------------------------------------------
say('sending a real STEER: also create z.txt');
let steerAccepted = true;
try {
  await call((id) => turnSteerRequest(id, { threadId, turnId: turn1, text: steerFraming('also create z.txt') }), 30_000);
} catch (e) {
  steerAccepted = false;
  say('steer REFUSED:', e.message);
}
check(steerAccepted, 'a second turn/steer into the same turn is accepted');

await waitFor(() => turnDone !== null, 300_000, 'turn 1 to finish').catch((e) => say('WARNING:', e.message));
const files = existsSync(SCRATCH) ? readdirSync(SCRATCH).sort() : [];
say('files in the scratch dir:', files.join(' ') || '(none)');
check(files.includes('z.txt'), 'z.txt exists: the steer reached the running turn and changed its work');
check(files.includes('a.txt') && files.includes('j.txt'), 'the ORIGINAL brief still completed (a.txt and j.txt exist)');
check(turnDone?.status === 'completed', `turn 1 completed normally (got ${turnDone?.status})`);

// ---------------------------------------------------------------------------
// PROOF 3: turn/interrupt on a fresh turn.
// ---------------------------------------------------------------------------
say('starting a second turn, to interrupt it');
turnDone = null;
const t2 = await call(
  (id) =>
    turnStartRequest(id, {
      threadId,
      text: 'Run `sleep 20`, then run `sleep 20` again, then tell me the time. Do not stop early.',
      sandbox: 'workspace-write',
      network: false,
      cwd: SCRATCH,
    }),
  30_000,
);
const turn2 = t2?.turn?.id;
await sleep(8_000);
say('sending turn/interrupt');
let interruptAccepted = true;
try {
  await call((id) => turnInterruptRequest(id, { threadId, turnId: turn2 }), 30_000);
} catch (e) {
  interruptAccepted = false;
  say('interrupt REFUSED:', e.message);
}
check(interruptAccepted, 'turn/interrupt is accepted');
await waitFor(() => turnDone !== null, 120_000, 'turn 2 to report').catch((e) => say('WARNING:', e.message));
check(turnDone?.status === 'interrupted', `the interrupted turn reports status interrupted (got ${turnDone?.status})`);

// ---------------------------------------------------------------------------
clearTimeout(deadline);
try {
  child.kill('SIGTERM');
} catch {
  /* gone */
}
console.log(`\n${at()} ${failures.length ? `${failures.length} FAILED` : 'ALL CHECKS PASSED'}`);
for (const f of failures) console.error(`  x ${f}`);
process.exit(failures.length ? 1 : 0);
