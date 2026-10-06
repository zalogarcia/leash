#!/usr/bin/env node
// THE USAGE WALL GUARD, WIRED: the real bridge.mjs functions, run against a rig.
//
// wall-guard.test.mjs and wall-resume.test.mjs prove the decisions. This proves
// the daemon makes them and acts on them, because existence is not
// implementation:
//
//   1. the checkpoint steer: wallGuardTick, steerInto, handleSteerRequest and
//      bgWorkerDescriptors sliced out of bridge.mjs, the REAL write path of a
//      worker's stdin (run.canSteer, run.steer and userMsg sliced out of
//      runClaude) and a REAL child process holding a REAL stdin pipe. The
//      checkpoint frame has to arrive on that pipe exactly once, in the frame
//      `bg.mjs steer` produces; a Codex worker and a worker that survived a
//      restart get nothing; the owner gets one line per window, naming the
//      one that could not be reached.
//   2. the resume: noteWallGuardJob, noteWallDeath, resumeWallDeaths and
//      liftClaudeWall, against the real wall episode store, the real guard
//      store, a real drop box file and a fake clock, with a daemon restart
//      between the deaths and the lift.
//
// bridge.mjs is never imported (that boots a daemon). Every file this touches
// is under one temp directory, created here and removed at the end; nothing
// is sent anywhere (send records), and no real worker is steered.
//
//   node wall-guard-wiring.test.mjs
//
// The private sibling has its own copy of this suite: the two bridge.mjs files
// differ (this one reads the live usage through the cached lookup, and has no
// salvage tool to name), so the suite is not shared.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STEER_HEADER, encodeLine, steerFraming } from './bg-steer.mjs';
import { liftNoticeDue, resumeLiftNotice } from './wall-resume.mjs';
import { checkpointSteerText } from './wall-guard.mjs';
import { briefTitle, stripLaneRules } from './bg-lane-rules.mjs';

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
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || 'expected truthy');
};

// ---------------------------------------------------------------------------
// The extractors. Top level: the same as limit-rotation.test.mjs. Nested: the
// three pieces of runClaude that ARE a worker's stdin write path.
// ---------------------------------------------------------------------------
const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^(?:const|let) ${name}\\b`);
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
function grabRunPiece(startRe, endTest) {
  const start = SRC.findIndex((l) => startRe.test(l));
  if (start === -1) throw new Error(`could not extract ${startRe} from runClaude, did it change shape?`);
  const out = [SRC[start]];
  if (endTest(SRC[start])) return out.join('\n');
  for (let i = start + 1; i < SRC.length; i++) {
    out.push(SRC[i]);
    if (endTest(SRC[i])) break;
  }
  return out.join('\n');
}
const USER_MSG = grabRunPiece(/^    const userMsg = \(t\) =>/, (l) => l.trimEnd().endsWith(';'));
const CAN_STEER = grabRunPiece(/^    run\.canSteer = \(\) =>/, (l) => l.trimEnd().endsWith(';'));
const STEER = grabRunPiece(/^    run\.steer = \(t, \{ frame = false/, (l) => l === '    };');
const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);

// EVERYTHING under one temp directory.
const TMP = mkdtempSync(path.join(tmpdir(), 'wall-guard-wiring-'));
const P = (f) => path.join(TMP, f);
mkdirSync(P('reports'));
mkdirSync(P('runs'));

const NOW0 = Date.UTC(2026, 9, 6, 15, 40, 0);
const MIN = 60_000;

const HARNESS = `
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { wallGuardSettings, wallGuardStatusLine, checkpointCandidates, checkpointDecision, checkpointSteerText, checkpointNotice, nextAccountAfter, createWallGuardStore, baseRunId } from ${url('wall-guard.mjs')};
import { resumeCandidates, resumePlan, resumeTiming, resumeNote, resumeBrief, resumeQueueItem, resumeWakeLines, resumeLiftNotice, liftNoticeDue, checkpointCommitFrom, sameJobTitle } from ${url('wall-resume.mjs')};
import { createWallWake, pickNextAccount } from ${url('wall-wake.mjs')};
import { wallWakePrompt } from ${url('system-messages.mjs')};
import { decodeLine, validateRequest, resolveSteerTarget, steerFailure, steerResponse, steerFraming, STEER_RECORD_MAX, REASONS as STEER_REASONS, parseRunId } from ${url('bg-steer.mjs')};
import { isBtwFramed } from ${url('bg-btw.mjs')};
import { briefTitle, stripLaneRules } from ${url('bg-lane-rules.mjs')};
import { parseEnginePrefix, fmtUntil } from ${url('bg-codex.mjs')};
import { clip, oneLine } from ${url('progress-render.mjs')};
import { pidAlive, createInflightRegistry } from ${url('detached-workers.mjs')};
import { draftRunId, DRAFT_SUFFIX } from ${url('bg-draft.mjs')};
import { selectAccount, PROBE_TIMEOUT_MS, createRecheckLimiter } from ${url('account-selector.mjs')};
import { isLimited, loginFlag } from ${url('accounts.mjs')};
import { fmtLeft } from ${url('usage-limits.mjs')};

let NOW_MS = ${NOW0};
Date.now = () => NOW_MS;
export const setNow = (v) => { NOW_MS = v; };
export const LOGS = [];
const console = { log: (m, ...r) => LOGS.push([m, ...r].join(' ')), error: (m, ...r) => LOGS.push('ERR ' + [m, ...r].join(' ')) };

const CLAUDE_AVAILABLE = true;
let rotationPausedUntil = 0;
export const setPausedUntil = (v) => { rotationPausedUntil = v; };
const OWNER_TZ = 'America/New_York';
const OWNER_NAME = 'Owner';
const BRIDGE_NAME = 'B';
const BG_CLI = '/bridge/bg.mjs';
const HOME = '/home/owner';
export let CONF = {};
export const setConf = (v) => { CONF = v; };
const conf = (k, f = undefined) => CONF[k] ?? f;
${grab('confObj')}
export const SENT = [];
const send = async (text) => { SENT.push(text); return { message_id: SENT.length }; };
export const DISPATCHED = [];
const LANES = { main: { name: 'main', current: null } };
const dispatchPrompt = (text, lane, opts = {}) => { DISPATCHED.push({ text, lane: lane?.name || null, ...opts }); };
const pendingOps = new Set();
export const settle = () => Promise.all([...pendingOps]);
export let DRAINS = 0;
const drainBgHandoff = () => { DRAINS++; };

// THE LIVE ACCOUNT AND ITS READING, as this daemon reads them: the cached
// usage lookup for the live login (accountUsage.activeOnly, below).
export let LIVE = 'acct-a';
export const setLive = (v) => { LIVE = v; };
export let READINGS = {};
export const setReadings = (v) => { READINGS = v; };
export let ACTIVE_ONLY_CALLS = 0;

// THE LEDGER and the probes: the REAL selector decides "another account free".
export let LIST = [];
export const setList = (v) => { LIST = v; };
export let PROBES = {};
export const setProbes = (v) => { PROBES = v; };
const accounts = {
  listAccounts: () => LIST,
  activeAccount: async () => ({ account: { name: LIVE } }),
  describe: (now = Date.now()) => LIST.map((a) => ({ name: a.name, captured: true, limitedUntil: a.limitedUntil || null, limited: isLimited(a, now), limitedVerifiedAt: a.limitedVerifiedAt || null, limitedSource: a.limitedSource || null, needsLogin: loginFlag(a) ? { reason: 'x' } : null })),
  markLimited: (name, until, opts) => { const i = LIST.findIndex((a) => a.name === name); if (i >= 0) LIST[i] = { ...LIST[i], limitedUntil: until, limitedSource: opts?.source || null, limitedVerifiedAt: new Date(NOW_MS).toISOString() }; return { ok: true }; },
  clearLimit: (name) => { const i = LIST.findIndex((a) => a.name === name); if (i >= 0) LIST[i] = { ...LIST[i], limitedUntil: null }; return { ok: true }; },
};
export const PROBED = [];
const accountUsage = {
  one: async (name) => { PROBED.push(name); return PROBES[name] ?? null; },
  activeOnly: async () => { ACTIVE_ONLY_CALLS++; return { active: { name: LIVE }, row: READINGS[LIVE] ? { name: LIVE, state: 'ok', usage: READINGS[LIVE] } : null }; },
};
let limitRecheck = createRecheckLimiter();
const flagLoginsFromRows = () => [];
const flagNeedsLogin = () => false;

// THE WORKERS: lanes holding real runs, a survivor re-attached by log, a Codex job.
export const bgLanes = [];
export const watchdog = { reattachedIds: new Set() };
const inflight = createInflightRegistry({ file: ${JSON.stringify(P('bg-inflight.json'))} });
export const inflightReg = inflight;
export const codexRuns = new Map();
const CODEX_LANE = 'codex';
const lastActFromExecLog = () => null;
const readTailIf = () => '';
const renderEntry = () => '';
// THE REAL stdin write path of a worker, sliced out of runClaude, around a real child.
const COMPACT_MARKER = '[[BRIDGE-COMPACT]]';
export function makeRun({ child, rawText, startedAt }) {
  let finished = false;
  const resultEvent = null;
  const st = {};
  const genKey = 'gen_bg';
  const startGen = 0;
  const progress = [];
  const toolLines = [];
  const isBgLane = true;
  const mirrorToRegistry = () => {};
  const run = { startedAt, prompt: rawText, steers: [], child, stopped: false, lane: null };
${USER_MSG}
${CAN_STEER}
${STEER}
  run.end = () => { finished = true; };
  return run;
}

// THE FILES, all in the temp dir.
const BG_REPORTS_DIR = ${JSON.stringify(P('reports'))};
const RUNS_DIR = ${JSON.stringify(P('runs'))};
const BG_QUEUE_FILE = ${JSON.stringify(P('bg-queue.json'))};
const BG_HELD_FILE = ${JSON.stringify(P('bg-held.json'))};
let bgStrandedJobs = [];
const queuedBgJobRows = () => {
  try { return JSON.parse(readFileSync(BG_QUEUE_FILE, 'utf8')).map((it) => ({ title: briefTitle(stripLaneRules(parseEnginePrefix(it.text).text)) })); } catch { return []; }
};
const WALL_GUARD_FILE = ${JSON.stringify(P('wall-guard.json'))};
export let wallGuard = createWallGuardStore({ file: WALL_GUARD_FILE });
const WALL_WAKE_FILE = ${JSON.stringify(P('wall-wake.json'))};
export let wallWake = createWallWake({ file: WALL_WAKE_FILE });
// A DAEMON RESTART: fresh objects over the same files, the in-memory state gone.
export const restart = () => {
  wallGuard = createWallGuardStore({ file: WALL_GUARD_FILE });
  wallWake = createWallWake({ file: WALL_WAKE_FILE });
  wallGuardLastProbe = 0;
  wallGuardLastSkip = null;
  wallGuardInflight = null;
  wallLiftInflight = null;
};

// What the lift needs around it, recorded.
let wallLiftInflight = null;
const kickWalledSweep = async () => ({ moved: false });
export const parkedHandbacks = [];
let handbackStreak = 0;
let handbackCapNotified = false;
let lastParkedAt = 0;
const flushParkedWalledChats = () => ({ count: 0, folded: false });
export let JOB_FLUSHES = 0;
const flushParkedWalledJobs = () => { JOB_FLUSHES++; };
const flushParkedCodexChats = () => false;
const chatLaneEngine = () => 'claude';

${grab('withDeadline', 'const')}
${grab('claudeRateWalled', 'const')}
${grab('WALL_LIFT_SWEEP_WAIT_MS', 'const')}
${grab('WALL_GUARD_PROBE_MS', 'const')}
let wallGuardLastProbe = 0;
let wallGuardInflight = null;
let wallGuardLastSkip = null;
${grab('logAccountDecision')}
${grab('pickHealthyAccount')}
${grab('bgWorkerDescriptors')}
${grab('steerInto')}
${grab('handleSteerRequest')}
${grab('wallGuardNow')}
${grab('kickWallGuard')}
${grab('wallGuardSkip')}
${grab('wallGuardTick')}
${grab('noteWallGuardJob')}
${grab('readCheckpointCommit')}
${grab('bgReportId')}
${grab('bgReportPath')}
${grab('bgDraftPath')}
${grab('bgRunLogPath')}
${grab('noteWallDeath')}
${grab('runIsAlive')}
${grab('readHeldBgJobs')}
${grab('activeJobTitles')}
${grab('queueResumeJobs')}
${grab('resumeWallDeaths')}
${grab('wallVouched')}
${grab('ledgerAllWalled')}
${grab('wallWakeDue')}
${grab('liftClaudeWall')}
export { wallGuardTick, kickWallGuard, handleSteerRequest, bgWorkerDescriptors, noteWallGuardJob, noteWallDeath, resumeWallDeaths, liftClaudeWall, runIsAlive, wallWakeDue };
`;

const B = await import('data:text/javascript,' + encodeURIComponent(HARNESS));

// ---------------------------------------------------------------------------
// The fake worker: a real process whose stdin is a real pipe. It writes every
// line it reads to a file, and stays alive until its stdin closes.
// ---------------------------------------------------------------------------
function fakeWorker(outFile) {
  const script = `const fs=require('fs');let b='';process.stdin.on('data',(d)=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){fs.appendFileSync(${JSON.stringify(outFile)},b.slice(0,i)+'\\n');b=b.slice(i+1);}});process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'ignore', 'inherit'] });
  child.stdin.on('error', () => {});
  return child;
}
const exited = (child) => new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
const linesOf = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

const TS_A = 1791295931469;
const TS_B = 1791296125922;
const TS_S = 1791296125986;
const OUT_A = P('worker-a.stdin');
const OUT_B = P('worker-b.stdin');
const BRIEF = (title) => `LANE RULES (you are a background worker).\n1. a rule\n\n--- TASK ---\n\n# ${title}\n\nDo the work.\n`;
const childA = fakeWorker(OUT_A);
const childB = fakeWorker(OUT_B);
const runA = B.makeRun({ child: childA, rawText: BRIEF('REELS-BATCH-1006'), startedAt: TS_A });
const runB = B.makeRun({ child: childB, rawText: BRIEF('AUDIT-THE-QUEUE-1006'), startedAt: TS_B });
B.bgLanes.push({ name: 'bg53', isBg: true, current: runA }, { name: 'bg54', isBg: true, current: runB });
// A worker that survived a daemon restart: re-attached by log, no pipe to it.
const SURVIVOR = `bg55-${TS_S}-${process.pid}`;
B.inflightReg.add(SURVIVOR, { pid: process.pid, task: BRIEF('RENDER-THE-FILM-1006'), lane: 'bg55', startedAt: TS_S });
B.watchdog.reattachedIds.add(SURVIVOR);
// A Codex job on the app-server: steerable, and it must get NOTHING.
export const CODEX_STEERS = [];
B.codexRuns.set('codex-1', { runId: 'codex-1791296857333', startedAt: 1791296857333, transport: 'appserver', done: false, killed: false, prompt: 'codex job', mode: 'edit', cwd: '/tmp', lastAct: 'reading', steps: 3, child: { pid: 999999 }, handle: { steer: (text) => { CODEX_STEERS.push(text); return true; } } });

const reading = (five, { reset = NOW0 + 40 * MIN } = {}) => ({ fiveHour: { percent: five, resetsAt: new Date(reset).toISOString() }, sevenDay: { percent: 70, resetsAt: new Date(NOW0 + 4 * 24 * 60 * MIN).toISOString() }, scoped: [] });
const walledList = () => [
  { name: 'acct-a', claudeAiOauth: { accessToken: 'x' } },
  { name: 'acct-b', claudeAiOauth: { accessToken: 'x' }, limitedUntil: Math.floor((NOW0 + 100 * MIN) / 1000), limitedSource: 'probe', limitedVerifiedAt: new Date(NOW0).toISOString() },
  { name: 'acct-c', claudeAiOauth: { accessToken: 'x' }, limitedUntil: Math.floor((NOW0 + 300 * MIN) / 1000), limitedSource: 'probe', limitedVerifiedAt: new Date(NOW0).toISOString() },
];
const healthyRow = (name) => ({ name, state: 'ok', usage: { fiveHour: { percent: 10, resetsAt: new Date(NOW0 + 200 * MIN).toISOString() }, sevenDay: { percent: 20, resetsAt: new Date(NOW0 + 3 * 24 * 60 * MIN).toISOString() }, scoped: [] } });

// ---------------------------------------------------------------------------
console.log('\n1. the trigger, wired: what holds the steer back');
// ---------------------------------------------------------------------------

B.setList(walledList());
B.setReadings({ 'acct-a': reading(94) });
await t('below the threshold: nothing is steered and the selector is never asked', async () => {
  ok(B.ACTIVE_ONLY_CALLS === 0, 'nothing read before the first tick');
  const r = await B.wallGuardTick();
  eq([r.fired, r.reason], [false, 'below threshold']);
  eq(B.PROBED.length, 0);
  eq(linesOf(OUT_A).length + linesOf(OUT_B).length, 0);
});

await t('★ another account free (the REAL selector says so): nothing is steered', async () => {
  B.setReadings({ 'acct-a': reading(97) });
  B.setList([...walledList().slice(0, 2), { name: 'acct-c', claudeAiOauth: { accessToken: 'x' } }]);
  B.setProbes({ 'acct-c': healthyRow('acct-c') });
  const r = await B.wallGuardTick();
  eq([r.fired, r.reason], [false, 'another account is free']);
  ok(B.PROBED.includes('acct-c'), 'the selector probed the free candidate');
  eq(linesOf(OUT_A).length + linesOf(OUT_B).length, 0);
  eq(B.SENT.length, 0);
});

await t('the guard switched off in config.json does nothing at all', async () => {
  B.setConf({ wallGuard: false });
  eq((await B.wallGuardTick()).reason, 'off');
  B.setConf({});
});

await t('a stale reading (its window already reset) does nothing', async () => {
  B.setReadings({ 'acct-a': { fiveHour: { percent: 99, resetsAt: new Date(NOW0 - MIN).toISOString() }, sevenDay: { percent: 99, resetsAt: new Date(NOW0 - MIN).toISOString() }, scoped: [] } });
  eq((await B.wallGuardTick()).reason, 'stale');
});

// ---------------------------------------------------------------------------
console.log('\n2. ★ the checkpoint steer, delivered on a real stdin pipe (criterion 2)');
// ---------------------------------------------------------------------------

B.setList(walledList());
B.setReadings({ 'acct-a': reading(96) });
B.setNow(NOW0 + 2 * MIN); // past the selector's rate limit from section 1
let fired;
await t('★ at the threshold with no free account, the guard fires', async () => {
  fired = await B.wallGuardTick();
  eq(fired.fired, true, JSON.stringify(fired));
  eq(fired.steered.sort(), [`bg53-${TS_A}`, `bg54-${TS_B}`]);
  eq(fired.unreachable, [SURVIVOR]);
});

const STEER_TEXT = checkpointSteerText({ percent: 96, windowLabel: 'the 5 hour window', resume: true });
await t('★ the Codex worker got NOTHING', async () => {
  eq(CODEX_STEERS.length, 0);
});

await t('★ ONE notice to the owner, bridge authored, naming the one it could not reach and the next account', async () => {
  eq(B.SENT.length, 1);
  const n = B.SENT[0];
  ok(/96% of the 5 hour window · threshold 95%/.test(n), n);
  ok(/Told 2 workers to save a checkpoint/.test(n), n);
  ok(/Could not reach 1/.test(n) && /bg55 · RENDER-THE-FILM-1006 \(survived a restart, no pipe to it\)/.test(n), n);
  ok(/Next account: acct-a · resets/.test(n), `the live window frees before acct-b: ${n}`);
  ok(!/[\u2013\u2014]/.test(n), 'no dash');
});

await t('a second tick in the same window steers nobody and sends nothing', async () => {
  B.setNow(NOW0 + 4 * MIN);
  const r = await B.wallGuardTick();
  eq([r.fired, r.reason], [false, 'already steered']);
  eq(B.SENT.length, 1);
});

await t('★ after a DAEMON RESTART in the same window: still nobody twice, still one notice', async () => {
  B.restart();
  B.setNow(NOW0 + 6 * MIN);
  const r = await B.wallGuardTick();
  eq([r.fired, r.reason], [false, 'already steered']);
  eq(B.SENT.length, 1);
});

await t('the decision line is in the daemon log, greppable', async () => {
  ok(B.LOGS.some((l) => l.includes('wall_guard_checkpoint') && l.includes('2 told to save')), B.LOGS.join('\n'));
});

// The hand steer, the way `bg.mjs steer` sends it: one encoded line over the socket.
const handRes = B.handleSteerRequest(encodeLine({ op: 'steer', target: `bg54-${TS_B}`, text: 'hand steer: also run the lint' }).trim());

childA.stdin.end();
childB.stdin.end();
await Promise.all([exited(childA), exited(childB)]);
const A_LINES = linesOf(OUT_A);
const B_LINES = linesOf(OUT_B);

await t('★ the checkpoint frame arrived on worker A stdin EXACTLY ONCE', async () => {
  eq(A_LINES.length, 1, A_LINES.join('\n'));
  const msg = JSON.parse(A_LINES[0]);
  eq(msg.type, 'user');
  eq(msg.message.role, 'user');
  eq(msg.message.content[0].type, 'text');
  eq(msg.message.content[0].text, steerFraming(STEER_TEXT), 'the frame and the text');
  ok(msg.message.content[0].text.startsWith(`${STEER_HEADER}\n\n`));
});

await t('★ ...and in the SAME frame shape `bg.mjs steer` produces (the hand steer, through the socket handler, on worker B)', async () => {
  eq(handRes.ok, true, JSON.stringify(handRes));
  eq(B_LINES.length, 2, B_LINES.join('\n'));
  const guard = JSON.parse(B_LINES[0]);
  const hand = JSON.parse(B_LINES[1]);
  const shape = (m) => JSON.stringify({ ...m, message: { ...m.message, content: m.message.content.map((c) => ({ ...c, text: c.text.split('\n\n')[0] })) } });
  eq(shape(guard), shape(hand), 'same JSON shape, same header');
  eq(guard.message.content[0].text, steerFraming(STEER_TEXT));
  eq(hand.message.content[0].text, steerFraming('hand steer: also run the lint'));
});

await t('the steer is on the run record, as a hand steer is (the report quotes it under "Steered in")', async () => {
  eq(runA.steers.length, 1);
  ok(runA.steers[0].text.startsWith('CHECKPOINT NOW'));
});

// A LIVE worker that cannot be steered (its process has exited, its result is
// in) is named with THAT reason, not as a restart survivor (QA 2026-10-06).
const endedChild = fakeWorker(P('worker-c.stdin'));
endedChild.stdin.end();
await exited(endedChild);
const runC = B.makeRun({ child: endedChild, rawText: BRIEF('ENDING-NOW-1006'), startedAt: 1791296200000 });
B.bgLanes.length = 0;
B.bgLanes.push({ name: 'bg60', isBg: true, current: runC });
B.watchdog.reattachedIds.clear();
B.codexRuns.clear();
B.setReadings({ 'acct-a': reading(97, { reset: NOW0 + 6 * 60 * MIN }) }); // the next 5 hour window: a new episode
B.setNow(NOW0 + 9 * MIN);
const endedFire = await B.wallGuardTick();
await t('a live worker that is ending is named as ending, not as a restart survivor', async () => {
  eq(endedFire.fired, true, JSON.stringify(endedFire));
  eq(endedFire.unreachable, ['bg60-1791296200000']);
  const n = B.SENT.at(-1);
  ok(/bg60 · ENDING-NOW-1006 \(its run is ending, no longer steerable\)/.test(n), n);
  eq(linesOf(P('worker-c.stdin')).length, 0, 'nothing was written to it');
});
B.bgLanes.length = 0;
const NOTICES_BEFORE_LIFT = B.SENT.length;

// ---------------------------------------------------------------------------
console.log('\n3. ★ the resume at the lift, through a daemon restart (criteria 5, 6, 7)');
// ---------------------------------------------------------------------------
// The wall: every account limited, the episode raised. Five workers ended on
// it. The rig records them the way the daemon does: the dispatch record at
// spawn and at the drop box (noteWallGuardJob), the death (noteWallDeath, from
// handleLimitDeath), and the episode row (holdHandbackForWall).

const WALL_AT = NOW0 + 20 * MIN;
const RESET_AT = NOW0 + 100 * MIN; // acct-b frees first
B.setNow(WALL_AT);
B.setPausedUntil(RESET_AT);
B.wallWake.raised({ until: RESET_AT, now: WALL_AT });
const TS = { d1: 1791297312986, d2: 1791297524422, d3: 1791296857300, d4: 1791294289951, d5: 1791294390734 };
const ORIGINAL = BRIEF('SHIP-THE-WIDGET-1006');
const D1 = `bg56-${TS.d1}`;
writeFileSync(P(`runs/${D1}.jsonl`), ['{"type":"assistant"}', '{"type":"user","content":"[feat/widget 4f3c2a1] WIP checkpoint: widget half done\\n 3 files changed"}', ''].join('\n'));
writeFileSync(P(`reports/${D1}.draft.md`), '# draft\n\n## RESUME NOTE\n- done: half\n');
B.noteWallGuardJob(D1, { text: ORIGINAL, cwd: P('worktree-widget') }); // the drop box half
B.noteWallDeath(D1, ORIGINAL, { finalReportSeen: false, account: 'acct-a' });
B.wallWake.worker({ runId: D1, title: 'SHIP-THE-WIDGET-1006', died: true, handback: 'held' });
// D2 opted out.
const D2 = `bg57-${TS.d2}`;
B.noteWallDeath(D2, `${BRIEF('NIGHTLY-SYNC-1006')}\nAuto-resume: no\n`, {});
B.wallWake.worker({ runId: D2, title: 'NIGHTLY-SYNC-1006', died: true, handback: 'held' });
// D3 was already resume 2 of 2: the chain cap.
const D3 = `bg58-${TS.d3}`;
const r2 = `LANE RULES (you are a background worker).\n1. a rule\n\n--- TASK ---\n\n# LOOPING-JOB-1006 (auto resume 2 of 2)\n\n## RESUME NOTE (written by the bridge; read it before anything else)\n\nnote\n\n--- ORIGINAL BRIEF, whole and unchanged, below this line ---\n\n# LOOPING-JOB-1006\n\nwork\n`;
B.noteWallGuardJob(D3, { text: r2, resumeOf: 'bg50-1791290000000', resumeCount: 2, resumeRoot: 'bg49-1791280000000' });
B.noteWallDeath(D3, r2, {});
B.wallWake.worker({ runId: D3, title: 'LOOPING-JOB-1006 (auto resume 2 of 2)', died: true, handback: 'held' });
// D4 "died" by its log line, but its process is ALIVE in the registry.
const D4 = `bg51-${TS.d4}`;
B.noteWallDeath(D4, BRIEF('STILL-RUNNING-1006'), {});
B.wallWake.worker({ runId: D4, title: 'STILL-RUNNING-1006', died: true, handback: 'held' });
B.inflightReg.add(`${D4}-${process.pid}`, { pid: process.pid, task: BRIEF('STILL-RUNNING-1006'), lane: 'bg51', startedAt: TS.d4 });
// D5 finished: its report is only being held for the wake-up.
const D5 = `bg52-${TS.d5}`;
B.wallWake.worker({ runId: D5, title: 'WRITE-THE-DOC-1006', died: false, handback: 'held' });
// The live workers from section 2 are gone by now.
B.bgLanes.length = 0;
B.watchdog.reattachedIds.clear();
B.inflightReg.clear(SURVIVOR);
B.codexRuns.clear();
void NOTICES_BEFORE_LIFT;

await t('nothing is queued while the wall is up', async () => {
  eq(existsSync(P('bg-queue.json')), false);
  eq(B.wallWakeDue(), false);
});

// ---- THE DAEMON RESTARTS during the wall. ----
B.restart();
// The reset passes, the ledger frees acct-b, the wall timer lifts.
const LIFT_AT = RESET_AT + 30_000;
B.setNow(LIFT_AT);
B.setPausedUntil(0);
B.setList([{ name: 'acct-a', claudeAiOauth: { accessToken: 'x' }, limitedUntil: Math.floor((NOW0 + 300 * MIN) / 1000), limitedSource: 'probe' }, { name: 'acct-b', claudeAiOauth: { accessToken: 'x' } }]);
B.setLive('acct-b');
const LIFT = await B.liftClaudeWall('reset', { live: 'acct-b' });
await B.settle();
const QUEUE = existsSync(P('bg-queue.json')) ? JSON.parse(readFileSync(P('bg-queue.json'), 'utf8')) : [];

await t('★ the lift ran once and woke the chat lane', async () => {
  eq(LIFT?.woke, true, JSON.stringify(LIFT));
  eq(B.DISPATCHED.length, 1);
});

await t('★ exactly the dead unfinished worker was queued again, at or before the lift plus 5 minutes', async () => {
  eq(QUEUE.length, 1, JSON.stringify(QUEUE.map((q) => q.resumeOf)));
  const q = QUEUE[0];
  eq(q.resumeOf, D1);
  ok(Date.parse(q.queuedAt) <= RESET_AT + 5 * MIN, `${q.queuedAt} is later than the reset plus five minutes`);
  ok(Date.parse(q.queuedAt) >= RESET_AT, 'and not before the lift');
});

await t('★ the ORIGINAL brief unchanged, the RESUME NOTE first, the same engine, the same directory pin, the same title prefix', async () => {
  const q = QUEUE[0];
  ok(q.text.endsWith(stripLaneRules(ORIGINAL)), 'the original task is the byte-identical tail');
  ok(q.text.startsWith('LANE RULES'), 'the lane frame stays in front');
  const task = stripLaneRules(q.text);
  ok(task.startsWith('# SHIP-THE-WIDGET-1006 (auto resume 1 of 2)\n\n## RESUME NOTE'), task.slice(0, 120));
  eq(q.engine, 'claude', 'the dead run was Claude, and a pinned job waits for a wall rather than going to Codex');
  eq(q.cwd, P('worktree-widget'));
  ok(briefTitle(task).startsWith(briefTitle(stripLaneRules(ORIGINAL))), `${briefTitle(task)}`);
  eq([q.resumeCount, q.resumeRoot], [1, D1]);
  ok(!('now' in q), 'through the cap like any job');
});

await t('★ the queued row carries the pace (4 at a time by default), and the wake-up says a waiting job is not lost', async () => {
  eq(QUEUE[0].maxRunning, 4, 'the drain reads it off the item (bg-admission.mjs paceOf)');
  const w = B.DISPATCHED[0].text;
  ok(/at most 4 resumed jobs run at once, the rest start as they finish, so a job still waiting in the queue is not lost/.test(w), w);
});

await t('★ the note names the draft, the checkpoint commit read off the log, and where its writes are', async () => {
  const task = stripLaneRules(QUEUE[0].text);
  ok(task.includes(P(`reports/${D1}.draft.md`)), 'the draft path');
  ok(task.includes('4f3c2a1 on branch feat/widget'), 'the checkpoint commit');
  ok(task.includes(`read its run log for every write it made: ${P(`runs/${D1}.jsonl`)}`), 'no salvage tool here: the run log is named');
  ok(task.includes('it was on acct-a'), 'the account it died on');
});

await t('★ the wake-up names the resumed job with "Do NOT dispatch these again" and every other one with its reason', async () => {
  const w = B.DISPATCHED[0].text;
  ok(/Do NOT dispatch these again/.test(w), w);
  ok(w.includes(`${D1} · SHIP-THE-WIDGET-1006 · queued as resume 1 of 2`), w);
  ok(w.includes(`${D2} · NIGHTLY-SYNC-1006 · its brief says Auto-resume: no`), w);
  ok(w.includes(`${D3} · LOOPING-JOB-1006 (auto resume 2 of 2) · chain cap: resumed 2 times automatically already`), w);
  ok(w.includes(`${D4} · STILL-RUNNING-1006 · it is still running`), w);
  ok(w.includes(`${D5} · WRITE-THE-DOC-1006 · it finished; its report is held for you`), w);
  ok(w.includes('never dispatch a resumed job again'), w);
  ok(!w.includes('\n\n'), 'no blank line inside the wake-up');
});

await t("★ ONE line to the owner at the lift: how many resumed, the title, how many not and why", async () => {
  const n = B.SENT.filter((s) => s.startsWith('🔁'));
  eq(n.length, 1, B.SENT.join('\n---\n'));
  ok(/Resumed 1 job after the usage wall/.test(n[0]) && /↳ SHIP-THE-WIDGET-1006/.test(n[0]), n[0]);
  ok(/Not resumed: 3 · 1 its brief says Auto-resume: no · 1 chain cap · 1 it is still running$/.test(n[0]), n[0]);
  ok(!/finished/.test(n[0]), 'the worker that only finished is in the wake-up, not in this line');
});

await t('the queued resumes are drained at once (the cap applies inside the drain)', async () => {
  eq(B.DRAINS, 1);
});

await t('★ a second lift, and a lift after ANOTHER restart: nothing queued twice, no second line', async () => {
  await B.liftClaudeWall('poll');
  B.restart();
  await B.liftClaudeWall('poll');
  await B.settle();
  const q = JSON.parse(readFileSync(P('bg-queue.json'), 'utf8'));
  eq(q.length, 1);
  eq(B.SENT.filter((s) => s.startsWith('🔁')).length, 1);
  eq(B.DISPATCHED.length, 1);
});

await t('★ the same death never resumes twice even if the episode came round again (the claim is on disk)', async () => {
  B.wallWake.raised({ until: LIFT_AT + 60 * MIN, now: LIFT_AT + 30 * MIN });
  B.wallWake.worker({ runId: D1, title: 'SHIP-THE-WIDGET-1006', died: true, handback: 'held' });
  B.setNow(LIFT_AT + 61 * MIN);
  const r = B.resumeWallDeaths(B.wallWake.current(), { readyAt: LIFT_AT + 60 * MIN, now: LIFT_AT + 61 * MIN });
  eq(r.resumed.length, 0);
  eq(r.skipped.find((s) => s.runId === D1)?.reason, 'the bridge resumed it at an earlier lift; do not dispatch it again');
});

await t('★ the pace is a setting: another number rides on the item, and 0 puts none on it', async () => {
  const lift = (n, conf) => {
    const id = `bg7${n}-17912900000${n}0`;
    B.setConf(conf);
    B.wallGuard.death(id, { text: `LANE RULES\n\n--- TASK ---\n\n# PACED-JOB-${n}-1006\n\nDo the thing.`, title: `PACED-JOB-${n}-1006` });
    B.wallWake.raised({ until: LIFT_AT + (200 + n) * MIN, now: LIFT_AT + (190 + n) * MIN });
    B.wallWake.worker({ runId: id, title: `PACED-JOB-${n}-1006`, died: true, handback: 'held' });
    B.setNow(LIFT_AT + (201 + n) * MIN);
    const before = JSON.parse(readFileSync(P('bg-queue.json'), 'utf8')).length;
    const r = B.resumeWallDeaths(B.wallWake.current(), { readyAt: LIFT_AT + (200 + n) * MIN, now: LIFT_AT + (201 + n) * MIN });
    const q = JSON.parse(readFileSync(P('bg-queue.json'), 'utf8'));
    eq(q.length, before + 1, JSON.stringify(r));
    return { r, item: q.at(-1) };
  };
  const two = lift(1, { wallGuard: { resumeMaxConcurrent: 2 } });
  eq([two.item.maxRunning, two.r.maxRunning], [2, 2]);
  const none = lift(2, { wallGuard: { resumeMaxConcurrent: 0 } });
  ok(!('maxRunning' in none.item), JSON.stringify(none.item));
  eq(none.r.maxRunning, 0);
  B.setConf({});
});

await t('★ QA round 2: when the drop box will not take a resume, the death is still counted and the owner still gets a line', async () => {
  const id = 'bg79-1791290000790';
  B.setConf({});
  B.wallGuard.death(id, { text: 'LANE RULES\n\n--- TASK ---\n\n# LOST-TO-THE-QUEUE-1006\n\nDo the thing.', title: 'LOST-TO-THE-QUEUE-1006' });
  B.wallWake.raised({ until: LIFT_AT + 400 * MIN, now: LIFT_AT + 390 * MIN });
  B.wallWake.worker({ runId: id, title: 'LOST-TO-THE-QUEUE-1006', died: true, handback: 'held' });
  B.setNow(LIFT_AT + 401 * MIN);
  // The drain's temp file path is a directory, so the write back fails.
  const blocker = `${P('bg-queue.json')}.${process.pid}.tmp`;
  mkdirSync(blocker);
  let r;
  try {
    r = B.resumeWallDeaths(B.wallWake.current(), { readyAt: LIFT_AT + 400 * MIN, now: LIFT_AT + 401 * MIN });
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
  eq(r.resumed.length, 0);
  const row = r.skipped.find((x) => x.runId === id);
  eq([row?.died, row?.reason], [true, 'the drop box would not take it; dispatch it by hand']);
  eq(liftNoticeDue(r), true, 'the owner is told');
  ok(/Not resumed: \d+ · .*\b1 the drop box would not take it/.test(resumeLiftNotice(r)), resumeLiftNotice(r)); // the episode carries rows of the lifts above

});

await t('★ a worker that died behind a rotation still in progress is resumed when that rotation raised the wall, and dropped when it did not', async () => {
  // One wall kills several workers inside the same seconds. This daemon keeps
  // no record of how the first corpse's rotation ended, so the later deaths are
  // recorded as provisional and the lift decides by when the wall went up.
  const raised = LIFT_AT + 500 * MIN;
  const near = 'bg81-1791290000810';
  const swapDeath = 'bg82-1791290000820';
  const brief = (title) => `LANE RULES\n\n--- TASK ---\n\n# ${title}\n\nDo the thing.`;
  B.setConf({});
  B.setNow(raised - 60 * MIN);
  B.noteWallDeath(swapDeath, brief('DIED-ON-A-SWAP-1006'), { provisional: true }); // an hour before any wall
  B.setNow(raised - 20_000);
  B.noteWallDeath(near, brief('SECOND-CORPSE-1006'), { provisional: true }); // 20 s before the wall went up
  B.wallWake.raised({ until: raised + 10 * MIN, now: raised });
  B.wallWake.worker({ runId: near, title: 'SECOND-CORPSE-1006', died: false, handback: 'held' }); // what the handback recorded
  B.setNow(raised + 11 * MIN);
  const r = B.resumeWallDeaths(B.wallWake.current(), { readyAt: raised + 10 * MIN, now: raised + 11 * MIN });
  ok(r.resumed.some((x) => x.runId === near), JSON.stringify(r));
  ok(!r.resumed.some((x) => x.runId === swapDeath) && !r.skipped.some((x) => x.runId === swapDeath), 'claimed by no lift');
  eq(B.wallGuard.deathOf(swapDeath), null, 'and dropped from the record');
  const q = JSON.parse(readFileSync(P('bg-queue.json'), 'utf8'));
  eq(q.at(-1).resumeOf, near);
});

// THE QUEUED ROW, printed for the report (text clipped; the assertions above read it whole).
const row = { ...QUEUE[0], text: `${QUEUE[0].text.slice(0, 60).replace(/\n/g, '\\n')}... [${QUEUE[0].text.length} chars]` };
console.log(`\n  queued row: ${JSON.stringify(row)}`);
console.log(`  rig dir:    ${TMP}`);

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all wall-guard wiring tests pass');
