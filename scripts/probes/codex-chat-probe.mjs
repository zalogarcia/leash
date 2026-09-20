#!/usr/bin/env node
// LIVE probe: two turns of the real Codex chat lane, against the real `codex`.
//
// bg-codex-wiring.test.mjs proves runCodexChat against a fake binary, which is
// what makes the suite free and offline. This is the other half: the same
// extracted function, the REAL binary, the real OpenAI account. It is the only
// way to know that `codex exec resume` actually continues the conversation
// rather than merely accepting the flag, and it costs a few thousand tokens.
//
// Turn 1 asks Codex to remember a word. Turn 2, on the resumed thread, asks
// what the word was. If the answer is not the word, the thread is not a thread.
//
//   node scripts/probes/codex-chat-probe.mjs [<image.png>]
//
// With an image path it runs a third turn on a fresh thread, attaching that file
// with `-i`, which is the path a photo sent from Telegram takes.
//
// Not part of the suite: it spends money and needs a login.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'codex-chat-probe-'));
const RUNS = path.join(TMP, 'runs');

const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
  const start = SRC.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs`);
  const out = [SRC[start]];
  for (let i = start + 1; i < SRC.length; i++) {
    const l = SRC[i];
    if (/^\S/.test(l)) {
      // `];` closes an array const the same way `};` closes an object or a
      // function body. Without the bracket here BOT_COMMANDS sliced out one
      // line short and the assembled module died on a syntax error.
      if (/^[}\])]/.test(l)) out.push(l);
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}

const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);
const HARNESS = `
import fs from 'node:fs';
import { spawnWorker } from ${url('detached-workers.mjs')};
import {
  CODEX_LANE, buildCodexArgs, codexChatError, codexOutcome, codexPaths, codexRunId, codexStartNotice,
  codexThinkingLine, freeCodexStart, fmtCodexTokens, isCodexImage,
} from ${url('bg-codex.mjs')};
import { briefTitle, stripLaneRules } from ${url('bg-notify.mjs')};
import { execFallbackLine, shouldFallBackToExec } from ${url('codex-appserver.mjs')};
import { pathsFromCodexLog } from ${url('engine-handoff.mjs')};
import { codexChatSandbox } from ${url('engine-state.mjs')};
const { existsSync, mkdirSync, writeFileSync, readFileSync } = fs;
export const SENT = [];
export const RESULTS = [];
export const HANDBACKS = [];
export const PROGRESS = [];
export const RECORDED = [];
export const STATE = { cwd: ${JSON.stringify(TMP)}, yolo: false }; // read-only: the probe writes nothing
const send = (t) => { SENT.push(t); return Promise.resolve(); };
const sendResult = (t) => { RESULTS.push(t); return Promise.resolve(); };
const recordBgResult = (task, record) => { RECORDED.push({ task, record }); };
const chatState = () => STATE;
const saveState = () => {};
export const LANES = { main: { name: 'main', current: null, queue: [], finishing: 0 } };
const drainQueue = () => {};
const CHAT_ID = '1';
const EDIT_INTERVAL_MS = 100000;   // no bubble churn in a probe
const TYPING_INTERVAL_MS = 100000;
const escHtml = (s) => String(s);
const fmtElapsed = (s) => s + 's';
const tg = (method) => (method === 'sendMessage' ? Promise.resolve({ message_id: 1 }) : Promise.resolve({}));
const editProgress = () => Promise.resolve();
export const codexRuns = new Map();
export const registry = new Map();
const inflight = { add: (id, rec) => registry.set(id, rec), clear: (id) => registry.delete(id), read: () => Object.fromEntries(registry) };
const closeStdin = (c) => { try { c?.stdin?.destroy(); } catch {} };
export const REPORTED = [];
const reportCodexOutcome = (task, outcome, runId, meta) => { REPORTED.push({ task, outcome, runId, meta }); };
export const RUNS_DIR = ${JSON.stringify(RUNS)};
export const CODEX_BIN = 'codex';
export const CODEX_TIMEOUT_MS = 300000;
const CODEX_MODEL = null;
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const OWNER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
export let CODEX_SETTINGS = { model: null, effort: null };
export const setCodexSettings = (v) => { CODEX_SETTINGS = v; };
const codexSettingsNow = () => CODEX_SETTINGS;
const codexChatBox = () => codexChatSandbox({ yolo: STATE.yolo !== false });
const conf = (key, fallback) => fallback;
export const RING = [];
const recordChatTurn = (e) => { RING.push(e); };

// THE EXEC LANE IS WHAT THIS PROBE EXISTS TO PROVE. runCodexChat is now a
// dispatcher, so the app-server is switched OFF here exactly the way
// config.json switches it off, and bridge.mjs's own codexAppServerUsable makes
// the routing decision. Nothing about the exec run itself is faked: the binary,
// the login, the thread and the exec resume are all real.
const CODEX_AVAILABLE = true;
const CODEX_APP_SERVER = false;
const codexAppServerDeaths = [];
let codexAppServerInitFailed = false;
const codexFallbackToldAbout = new Set();
// Unreachable by construction, and loud if that ever stops being true: a
// dispatcher that quietly routed to the other lane would leave this probe
// proving the app-server while its output still said it resumed an exec thread.
const runCodexChatTurn = () => {
  throw new Error('the exec probe reached the app-server lane: codexAppServerUsable() returned true');
};

// The ChatGPT rate-limit wall is daemon bookkeeping, not part of what this
// probe proves, and reading it for real would drag the whole account module in.
// Same two seams scripts/probes/codex-appserver-probe.mjs already stands on.
const noteCodexWall = () => Date.now() + 3600000;
const clearCodexWall = () => {};
let codexPausedUntil = 0;
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        grab('readTextIf', 'const'),
        grab('writeCodexMeta'),
        grab('finalizeCodexMeta'),
        grab('rememberCodexThread'),
        grab('clearCodexThread'),
        grab('codexLaunchError'),
        grab('confBool'),
        // Read by pathsFromCodexLog, so a slash command in the event stream is
        // not reported as a file this turn touched. BOT_COMMANDS first: the
        // const below maps over it at module-eval time.
        grab('BOT_COMMANDS', 'const'),
        grab('COMMAND_NAMES', 'const'),
        grab('runCodex'),
        // runCodexChat is a DISPATCHER now; the exec turn it used to be is
        // runCodexChatExec, and the two consts below are the choice between
        // them. Sliced out, the probe died on its first line with
        // "ReferenceError: codexAppServerUsable is not defined".
        grab('codexAppServerState', 'const'),
        grab('codexAppServerUsable', 'const'),
        grab('runCodexChatExec'),
        grab('runCodexChat'),
        'export { runCodex, runCodexChat, runCodexChatExec, rememberCodexThread, clearCodexThread };',
      ].join('\n'),
    )
);

const settled = (n, ms = 300000) =>
  new Promise((resolve, reject) => {
    const at = Date.now();
    const tick = () => {
      if (B.RESULTS.length >= n || B.SENT.some((x) => String(x).startsWith('❌'))) return resolve();
      if (Date.now() - at > ms) return reject(new Error('the codex chat turn never reported'));
      setTimeout(tick, 250);
    };
    tick();
  });

const argvOf = (runId) => {
  // The argv is not echoed by the real binary, so read what the module built.
  const meta = JSON.parse(readFileSync(path.join(RUNS, `${runId}.meta.json`), 'utf8'));
  return meta;
};

console.log('--- TURN 1 (cold) ---');
const t1 = B.runCodexChat('Remember the word PELICAN and reply OK. Do not read any files.');
await settled(1);
console.log('answer :', JSON.stringify(B.RESULTS[0]));
console.log('thread :', B.STATE.codexThreadId ? 'captured' : 'NOT CAPTURED');
console.log('meta   :', JSON.stringify(argvOf(t1.codexRunId)));
for (const x of B.SENT) console.log('bubble :', x);

console.log('\n--- TURN 2 (resumed) ---');
const before = B.STATE.codexThreadId;
const t2 = B.runCodexChat('What word did I ask you to remember? Reply with just the word.');
await settled(2);
console.log('answer :', JSON.stringify(B.RESULTS[1]));
console.log('meta   :', JSON.stringify(argvOf(t2.codexRunId)));
console.log('same thread:', before === B.STATE.codexThreadId);
for (const x of B.SENT) console.log('bubble :', x);
const proven = /PELICAN/i.test(String(B.RESULTS[1] || ''));
console.log('\nVERDICT:', proven ? 'THREAD CONTINUITY PROVEN' : 'FAILED');
console.log('leak check (thread id in any bubble):', [...B.SENT, ...B.RESULTS, ...B.PROGRESS].join('\n').includes(before));

// --- TURN 3: an image, on a FRESH thread -----------------------------------
// A photo from Telegram lands in the inbox and rides `-i`. On its own thread so
// the answer cannot come from the earlier conversation rather than the pixels.
const IMG = process.argv[2];
if (IMG) {
  console.log('\n--- TURN 3 (image, fresh thread) ---');
  B.clearCodexThread();
  const t3 = B.runCodexChat('What color is this image? Answer with one word.', { images: [IMG] });
  await settled(3);
  console.log('image  :', IMG);
  console.log('answer :', JSON.stringify(B.RESULTS[2]));
  console.log('meta   :', JSON.stringify(argvOf(t3.codexRunId)));
}

rmSync(TMP, { recursive: true, force: true });

// THE EXIT CODE IS THE VERDICT. This printed "VERDICT: FAILED" and still exited
// 0, which is how a probe stops being evidence: a caller that reads the exit
// code (a gate, a wrapper, a person in a hurry) is told the thread continued
// when it did not. Two failing codes rather than one, because "OpenAI is not
// answering this account today" and "resume did not carry the conversation"
// need different responses from whoever reads it.
//   0  thread continuity proven
//   1  the probe ran and the thread did NOT carry over: a real defect
//   2  blocked before any answer came back (usage limit, no login, no network)
const bubbles = [...B.SENT, ...B.RESULTS].join('\n');
const blocked = /usage limit|rate limit|not installed|login|Unauthorized|401|network/i.test(bubbles);
if (proven) process.exit(0);
console.log(blocked ? '\nBLOCKED: no answer came back from OpenAI, see the bubbles above' : '');
process.exit(blocked ? 2 : 1);
