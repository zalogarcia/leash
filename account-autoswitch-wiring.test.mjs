#!/usr/bin/env node
// THE ACCOUNT SWITCH, WIRED: the real bridge.mjs functions against a rig.
//
// account-autoswitch.test.mjs proves the decisions; this proves the daemon
// makes them and acts on them, because existence is not implementation:
//
//   1. the automatic switch: autoSwitchTick, switchAccountNow and the rest
//      sliced out of bridge.mjs, over the REAL account store
//      (accounts.mjs, credential-store.mjs's keychain writer over a fake
//      `security`), the REAL usage reader (account-usage.mjs over a fake
//      usage endpoint that answers per token) and the REAL live session
//      readings (stream-usage.mjs). One tick over the threshold with a free
//      account swaps the keychain blob and sends ONE notice; the next ticks
//      do not swap back.
//   2. the 2026-10-08 morning: two accounts walled until their 14:00Z reset,
//      the live one at 95 percent of its week; the tick after 14:00Z moves.
//   3. a scheduled switch through the real checkSchedules, and its refusals.
//   4. `node bg.mjs account switch|check` as a REAL process against the REAL
//      steer server (startSteerServer + handleSteerRequest sliced out), on a
//      socket in a temp dir.
//   5. the 2026-10-08 20:52Z false wall: charlie's 100 percent reading after
//      the swap to delta, through the real noteStreamUsage and the real
//      wallGuardTick. Neither the checkpoint nor the all-walled line fires,
//      and a control with delta genuinely full shows the rig CAN fire.
//
// bridge.mjs is never imported (that boots a daemon). Every file is under one
// temp directory; nothing is sent anywhere (send records), no real keychain
// is touched, no real worker is steered.
//
//   node account-autoswitch-wiring.test.mjs

import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// The extractors (the same as wall-guard-wiring.test.mjs).
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
// The swapTo wrapper is top level statements, not a function.
function grabSwapWrapper() {
  const start = SRC.findIndex((l) => l === 'const swapToStore = accounts.swapTo;');
  if (start === -1) throw new Error('could not find the swapTo wrapper in bridge.mjs');
  const end = SRC.findIndex((l, i) => i > start + 1 && l === '};');
  return SRC.slice(start, end + 1).join('\n');
}
const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);

const TMP = mkdtempSync(path.join(tmpdir(), 'autoswitch-wiring-'));
const P = (f) => path.join(TMP, f);

const MIN = 60_000;
const HOUR = 60 * MIN;
const RESET = Date.parse('2026-10-08T14:00:00Z');
const NOW0 = RESET - 10 * MIN;
const ME = 'alpha@example.test';
const GMAIL = 'bravo@example.test';
const CHARLIE = 'charlie@example.test';
const DELTA = 'delta@example.test';

const HARNESS = `
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createAccountStore, fingerprint, isLimited, loginFlag } from ${url('accounts.mjs')};
import { createKeychainStore } from ${url('credential-store.mjs')};
import { createAccountUsage, fmtResetClock, invalidateUsageCache, fetchProfile } from ${url('account-usage.mjs')};
import { createStreamUsage, createLiveAccountTracker } from ${url('stream-usage.mjs')};
import { selectAccount, PROBE_TIMEOUT_MS, createRecheckLimiter, limitClearVerdict } from ${url('account-selector.mjs')};
import { autoSwitchSettings, autoSwitchStatusLine, autoSwitchDecision, candidateVerdict, probeDue, overThreshold, readingLine, switchTargetVerdict, autoSwitchNotice, switchRefusedNotice, alreadyOnNotice, EVIDENCE_MAX_AGE_MS as AUTO_SWITCH_EVIDENCE_MS, PROBE_EVERY_MS as AUTO_SWITCH_RETRY_MS } from ${url('account-autoswitch.mjs')};
import { wallGuardSettings, checkpointCandidates, checkpointDecision, checkpointSteerText, checkpointNotice, nextAccountAfter, createWallGuardStore } from ${url('wall-guard.mjs')};
import { decodeLine, encodeLine, validateRequest, steerFailure, REASONS as STEER_REASONS } from ${url('bg-steer.mjs')};
import { fmtUntil } from ${url('bg-codex.mjs')};
import { fmtLeft } from ${url('usage-limits.mjs')};
import { isDailyDue, describeWhen } from ${url('schedule-due.mjs')};
import { clip, oneLine } from ${url('progress-render.mjs')};

let NOW_MS = ${NOW0};
Date.now = () => NOW_MS;
export const setNow = (v) => { NOW_MS = v; };
export const LOGS = [];
const console = { log: (m, ...r) => LOGS.push([m, ...r].join(' ')), error: (m, ...r) => LOGS.push('ERR ' + [m, ...r].join(' ')) };

const CLAUDE_AVAILABLE = true;
export let rotationPausedUntil = 0;
export let rotationCooldownUntil = 0;
export const setPausedUntil = (v) => { rotationPausedUntil = v; };
export const setCooldownUntil = (v) => { rotationCooldownUntil = v; };
let wallLiftInflight = null;
const ROTATION_COOLDOWN_MS = 90_000;
const OWNER_TZ = 'America/Toronto';
const OWNER_NAME = 'Owner';
export let CONF = {};
export const setConf = (v) => { CONF = v; };
const conf = (k, f = undefined) => CONF[k] ?? f;
export const SENT = [];
const send = async (text) => { SENT.push(text); return { message_id: SENT.length }; };
const pendingOps = new Set();
export const settle = async () => { for (let i = 0; i < 5; i++) await Promise.all([...pendingOps]); };

// THE KEYCHAIN: a fake \`security\` under the REAL keychain writer.
export const KC = { blob: null, writes: 0, fail: false };
const runSecurity = async (args, stdin = null) => {
  if (args[0] === 'find-generic-password') return KC.blob ? { code: 0, stdout: JSON.stringify(KC.blob) } : { code: 44, stdout: '' };
  const hexOf = () => {
    if (args[0] === '-i' && stdin) return (stdin.match(/-X "([0-9a-f]+)"/) || [])[1];
    if (args[0] === 'add-generic-password') return args[args.indexOf('-X') + 1];
    return null;
  };
  // A locked keychain: every write refused, reads still answer.
  if (KC.fail) return { code: 1, stdout: 'keychain locked' };
  const hex = hexOf();
  if (!hex) return { code: 1, stdout: '' };
  KC.blob = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
  KC.writes++;
  return { code: 0, stdout: '' };
};
const ACCOUNTS_FILE = ${JSON.stringify(P('accounts.json'))};
export const accounts = createAccountStore({
  file: ACCOUNTS_FILE,
  backupFile: ${JSON.stringify(P('accounts.backup.json'))},
  unclaimedFile: ${JSON.stringify(P('accounts.unclaimed.json'))},
  credentials: createKeychainStore({ service: 'Claude Code-credentials', account: 'owner', runSecurity: (...a) => runSecurity(...a) }),
  identify: null,
  log: (m) => LOGS.push('[accounts] ' + m),
});

// THE USAGE ENDPOINT: answers per token, with whatever BODY holds for that account.
export const TOKENS = {};
export const BODY = {};
export const FETCHED = [];
const fakeFetch = async (u, opts = {}) => {
  const tok = String(opts.headers?.Authorization || '').replace(/^Bearer /, '');
  const who = TOKENS[tok] || null;
  FETCHED.push(who);
  const b = who ? BODY[who] : null;
  if (b === 'throttled') return { ok: false, status: 429, headers: { get: () => '600' }, json: async () => ({ error: { type: 'rate_limit_error' } }) };
  if (!b) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => b };
};
// A FRESH store per test (resetRig): the test clock jumps backwards between
// tests, and a reading held from a later minute would outrank every new one.
let streamN = 0;
const newStream = () => createStreamUsage({ file: ${JSON.stringify(P('usage-stream'))} + '-' + streamN++ + '.json', log: (m) => LOGS.push('[stream-usage] ' + m), persistDelayMs: 3600_000 });
export let streamUsage = newStream();
export const accountUsage = createAccountUsage({
  store: accounts,
  fetchImpl: fakeFetch,
  log: (m) => LOGS.push('[account-usage] ' + m),
  streamReading: (name) => streamUsage.get(name),
  onUsage: (name, usage) => streamUsage.learn(name, usage),
});
export const liveAccount = createLiveAccountTracker({
  readCredentials: () => accounts.readCredentials(),
  resolveActive: () => accountUsage.resolveActive(),
  fingerprint,
});
${grabSwapWrapper()}

const flagLoginsFromRows = () => [];
const flagNeedsLogin = () => false;
let limitRecheck = createRecheckLimiter();
export const OWNER_LIFTS = [];
const ownerLiftedWall = (name) => { OWNER_LIFTS.push(name); return null; };

// THE WORKERS the wall guard would tell to save.
export let WORKERS = [];
export const setWorkers = (v) => { WORKERS = v; };
const bgWorkerDescriptors = () => WORKERS;
export const STEERED = [];
const steerInto = (target, text) => { STEERED.push({ target, text }); return { ok: true }; };
const btwInto = () => ({ ok: false });
const publicWorker = (w) => w;
const runningBgWorkers = () => WORKERS.length;
const queuedBgJobRows = () => [];
const queuedBlock = () => '';
const psTable = () => '';
const MAX_CONCURRENT_WORKERS = 10;
export let wallGuard = createWallGuardStore({ file: ${JSON.stringify(P('wall-guard.json'))} });

// THE SCHEDULES, in memory.
export let SCHED = { nextId: 0, items: [] };
export const setSched = (v) => { SCHED = v; };
const loadSchedules = () => SCHED;
const saveSchedules = (s) => { SCHED = s; };
const localToday = () => new Date(Date.now()).toISOString().slice(0, 10);
const localHHMM = () => new Date(Date.now()).toISOString().slice(11, 16);

${grab('withDeadline', 'const')}
${grab('WALL_LIFT_SWEEP_WAIT_MS', 'const')}
${grab('WALL_GUARD_PROBE_MS', 'const')}
let wallGuardLastProbe = 0;
let wallGuardInflight = null;
let wallGuardLastSkip = null;
let rotationLanding = null;
${grab('ROTATION_LANDING_WAIT_MS', 'const')}
${grab('rotationStarted')}
${grab('rotationBehindCooldown')}
${grab('logAccountDecision')}
${grab('noteStreamUsage')}
${grab('pickHealthyAccount')}
${grab('wallGuardNow')}
${grab('kickWallGuard')}
${grab('wallGuardSkip')}
${grab('wallGuardTick')}
${grab('lastAccountSwap', 'const')}
${grab('lastAutoSwitch', 'const')}
${grab('autoSwitchProbes', 'const')}
${grab('autoSwitchInflight', 'const')}
${grab('autoSwitchLastSkip', 'const')}
${grab('autoSwitchBackoffUntil', 'const')}
${grab('autoSwitchLastRefusal', 'const')}
${grab('autoSwitchLiveLookup', 'const')}
${grab('autoSwitchOwnerHold', 'const')}
${grab('armOwnerHold')}
${grab('accountSwitchChain', 'const')}
${grab('accountSwitchBusy', 'const')}
${grab('autoSwitchNow')}
${grab('lastSwapAt')}
${grab('liveSince')}
${grab('usableLiveReading')}
${grab('autoSwitchSkip')}
${grab('kickAutoSwitch')}
${grab('autoSwitchCandidates')}
${grab('autoSwitchTick')}
${grab('switchAccountNow')}
${grab('doSwitchAccount')}
${grab('runScheduledSwitch')}
${grab('autoSwitchCheckText')}
${grab('handleAccountRequest')}
${grab('handleSteerRequest')}
${grab('fmtSchedule')}
${grab('checkSchedules')}
const STEER_SOCK = ${JSON.stringify(P('steer.sock'))};
${grab('startSteerServer')}

export { kickAutoSwitch, autoSwitchTick, switchAccountNow, checkSchedules, startSteerServer, wallGuardTick, noteStreamUsage, autoSwitchStatusLine, autoSwitchNow, lastAutoSwitch, fmtSchedule };
export const landing = () => rotationLanding;
export { armOwnerHold };
export const ownerHold = () => autoSwitchOwnerHold;
export const setLanding = (v) => { rotationLanding = v; };
export const status = () => autoSwitchStatusLine(autoSwitchNow(), { last: lastAutoSwitch, timeZone: OWNER_TZ });
export const resetRig = () => {
  rotationPausedUntil = 0;
  rotationCooldownUntil = 0;
  lastAccountSwap = null;
  lastAutoSwitch = null;
  autoSwitchProbes.clear();
  streamUsage = newStream();
  invalidateUsageCache();
  autoSwitchLastSkip = null;
  autoSwitchBackoffUntil = 0;
  autoSwitchLastRefusal = null;
  autoSwitchLiveLookup = null;
  autoSwitchOwnerHold = null;
  wallGuardLastProbe = 0;
  wallGuardLastSkip = null;
};
`;
writeFileSync(P('harness.mjs'), HARNESS);
const H = await import(pathToFileURL(P('harness.mjs')).href);

// ---------------------------------------------------------------------------
// THE FOUR ACCOUNTS. Token-shaped fixtures, never real.
// ---------------------------------------------------------------------------
const tok = (seed) => `sk-ant-oat01-${seed}`.padEnd(102, 'x') + seed.slice(-6).padStart(6, 'Z');
// Each account's own six character tail, as real tokens have (a fingerprint is
// the tail, and two fixtures sharing one would be one account to the tracker).
const SEED = { 'bravo@example.test': 'bravo1', 'alpha@example.test': 'alpha2', 'charlie@example.test': 'charl3', 'delta@example.test': 'delta4' };
const oauthFor = (name) => ({
  accessToken: tok(`acc-${SEED[name]}`),
  refreshToken: tok(`ref-${SEED[name]}`),
  expiresAt: NOW0 + 30 * 24 * HOUR,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
});
const NAMES = [GMAIL, ME, CHARLIE, DELTA];
const MCP = { mcpOAuth: { 'leadconnector|abc': { accessToken: 'mcp-token-kept' } } };
function seedAccounts({ live = ME, walled = {}, flagged = {} } = {}) {
  const list = NAMES.map((name, i) => ({
    name,
    email: name,
    claudeAiOauth: oauthFor(name),
    capturedAt: new Date(NOW0 - 86400_000).toISOString(),
    lastActiveAt: new Date(NOW0 - (name === live ? 3 : 10 + i) * HOUR).toISOString(),
    ...(walled[name] ? { limitedUntil: Math.floor(walled[name] / 1000), limitedSource: 'probe', limitedVerifiedAt: new Date(NOW0 - HOUR).toISOString() } : {}),
    ...(flagged[name] ? { needsLogin: { reason: flagged[name], at: new Date(NOW0).toISOString() } } : {}),
  }));
  writeFileSync(P('accounts.json'), JSON.stringify(list, null, 2), { mode: 0o600 });
  H.KC.blob = { claudeAiOauth: oauthFor(live), ...MCP };
  for (const n of NAMES) H.TOKENS[oauthFor(n).accessToken] = n;
}
const body = (five, fiveReset, week, weekReset) => ({
  five_hour: { utilization: five, resets_at: fiveReset ? new Date(fiveReset).toISOString() : null },
  seven_day: { utilization: week, resets_at: new Date(weekReset).toISOString() },
});
const ME_WEEK = Date.parse('2026-10-13T06:00:00Z');
const ZH_WEEK = Date.parse('2026-10-15T14:00:00Z');
const GMAIL_WEEK = Date.parse('2026-10-10T05:00:00Z');
const liveName = () => H.accounts.listAccounts().find((a) => a.claudeAiOauth.refreshToken === H.KC.blob?.claudeAiOauth?.refreshToken)?.name || null;
// A rate_limit_event from a session on `name`'s credentials.
const event = (five, fiveReset, week, weekReset) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: five >= 1 ? 'rejected' : 'allowed',
    rateLimitType: 'five_hour',
    unifiedWindows: {
      five_hour: { utilization: five, resetsAt: Math.floor(fiveReset / 1000) },
      seven_day: { utilization: week, resetsAt: Math.floor(weekReset / 1000) },
    },
  },
});
async function freshTracker() {
  await H.liveAccount.refresh();
}
const reset = () => {
  H.resetRig();
  H.SENT.length = 0;
  H.LOGS.length = 0;
  H.STEERED.length = 0;
  H.FETCHED.length = 0;
  H.setConf({});
  H.setWorkers([]);
  for (const k of Object.keys(H.BODY)) delete H.BODY[k];
};

// ---------------------------------------------------------------------------
// 1. THE AUTOMATIC SWITCH, AND NO SWAP BACK (acceptance criteria 1 and 3)
// ---------------------------------------------------------------------------
await t('★ AC1: alpha at 95% of its week, charlie free: ONE tick swaps the keychain to charlie and sends ONE notice', async () => {
  reset();
  H.setNow(RESET + 30_000);
  seedAccounts({ live: ME, walled: { [GMAIL]: GMAIL_WEEK } });
  H.BODY[ME] = body(12, RESET + HOUR, 95, ME_WEEK);
  H.BODY[CHARLIE] = body(0, null, 0, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[DELTA] = body(0, null, 3, ZH_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  eq(H.liveAccount.current(), ME);
  // The live session reading, as a worker's stream carries it.
  H.noteStreamUsage(event(0.12, RESET + HOUR, 0.95, ME_WEEK), ME);
  const writesBefore = H.KC.writes;
  const r = await H.kickAutoSwitch();
  await H.settle();
  eq(r.ok, true, JSON.stringify(r));
  eq(liveName(), CHARLIE, 'the keychain now holds charlie');
  eq(H.KC.writes, writesBefore + 1, 'exactly one keychain write');
  eq(H.KC.blob.mcpOAuth, MCP.mcpOAuth, 'the MCP logins in the same blob are untouched');
  eq(H.SENT.length, 1, `one notice, got: ${JSON.stringify(H.SENT)}`);
  eq(H.SENT[0].split('\n').slice(0, 4), [
    '🔀 Claude account switched · automatic',
    '⬅️ From: alpha@example.test · 5h 12% · week 95%',
    '➡️ To: charlie@example.test · 5h 0% · week 0%',
    '❓ Why: 95% of the weekly window (threshold 90%)',
  ]);
  ok(H.LOGS.some((l) => l.includes('account_autoswitch · account=alpha@example.test') && l.includes('source=lookup')), 'the decision line, confirmed by a lookup');
  ok(H.LOGS.some((l) => l.includes('account_switched · account=charlie@example.test')), 'the switch line');
  ok(!H.FETCHED.includes(GMAIL), 'the ledger-walled account was never asked');
  ok(H.rotationCooldownUntil > Date.now(), 'the rotation cooldown is armed, so a death on alpha does not rotate again');
  ok(H.status().endsWith('last 10:00am to charlie@example.test'), H.status());
});

await t('★ AC3: the following ticks never swap back to alpha, whatever its sessions still report', async () => {
  const swapsBefore = H.KC.writes;
  H.SENT.length = 0;
  await freshTracker();
  eq(H.liveAccount.current(), CHARLIE);
  // 30 simulated minutes, one tick a minute. alpha's sessions keep reporting
  // 95 percent (filed under alpha by its own weekly reset), charlie climbs slowly.
  for (let m = 1; m <= 30; m++) {
    H.setNow(RESET + 30_000 + m * MIN);
    H.noteStreamUsage(event(0.12, RESET + HOUR, 0.95, ME_WEEK), CHARLIE);
    H.BODY[CHARLIE] = body(m, RESET + 5 * HOUR, Math.min(60, m * 2), ZH_WEEK + 7 * 24 * HOUR);
    H.noteStreamUsage(event(m / 100, RESET + 5 * HOUR, Math.min(60, m * 2) / 100, ZH_WEEK + 7 * 24 * HOUR), CHARLIE);
    await H.kickAutoSwitch();
  }
  await H.settle();
  eq(H.KC.writes, swapsBefore, 'no swap in 30 ticks');
  eq(liveName(), CHARLIE);
  eq(H.SENT.length, 0, 'and no message');
  ok(streamUsageHolds(ME, 95), 'alpha\'s numbers stayed filed under alpha');
});
function streamUsageHolds(name, week) {
  // the store is the harness's live binding, read through the export
  return H.streamUsage.get(name)?.usage?.sevenDay?.percent === week;
}

await t('★ AC3: when charlie itself crosses 90, it moves ONWARD to delta, never back to a full alpha', async () => {
  H.SENT.length = 0;
  const at = RESET + 2 * HOUR;
  H.setNow(at);
  H.BODY[CHARLIE] = body(91, RESET + 5 * HOUR, 40, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[ME] = body(0, null, 95, ME_WEEK);
  H.noteStreamUsage(event(0.91, RESET + 5 * HOUR, 0.4, ZH_WEEK + 7 * 24 * HOUR), CHARLIE);
  await H.kickAutoSwitch();
  await H.settle();
  eq(liveName(), DELTA);
  eq(H.SENT.length, 1);
  ok(H.SENT[0].includes('❓ Why: 91% of the 5 hour window (threshold 90%)'), H.SENT[0]);
});

await t('a settle window after ANY swap: the owner\'s own swap holds the automatic one off for five minutes', async () => {
  reset();
  H.setNow(RESET + 3 * HOUR);
  seedAccounts({ live: ME });
  H.BODY[ME] = body(12, RESET + 4 * HOUR, 95, ME_WEEK);
  H.BODY[CHARLIE] = body(0, null, 0, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[DELTA] = body(0, null, 3, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[GMAIL] = body(0, null, 100, GMAIL_WEEK);
  // The owner swaps to alpha by hand (the /account path is accounts.swapTo too).
  seedAccounts({ live: CHARLIE });
  const r = await H.accounts.swapTo(ME);
  eq(r.ok, true);
  await freshTracker();
  H.noteStreamUsage(event(0.12, RESET + 4 * HOUR, 0.95, ME_WEEK), ME);
  const res = await H.kickAutoSwitch();
  eq(res.switched, false);
  ok(/a swap landed \d+s ago, settling/.test(res.reason), res.reason);
  H.setNow(RESET + 3 * HOUR + 5 * MIN + 1000);
  H.noteStreamUsage(event(0.13, RESET + 4 * HOUR, 0.95, ME_WEEK), ME);
  const res2 = await H.kickAutoSwitch();
  await H.settle();
  eq(res2.ok, true, JSON.stringify(res2));
  eq(liveName(), CHARLIE);
});

await t('off in config.json: nothing is asked, nothing moves', async () => {
  reset();
  H.setNow(RESET + 4 * HOUR);
  seedAccounts({ live: ME });
  H.setConf({ accountAutoSwitch: { enabled: false } });
  H.BODY[ME] = body(12, RESET + 5 * HOUR, 95, ME_WEEK);
  H.BODY[CHARLIE] = body(0, null, 0, ZH_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  H.noteStreamUsage(event(0.12, RESET + 5 * HOUR, 0.95, ME_WEEK), ME);
  const before = H.KC.writes;
  const res = await H.kickAutoSwitch();
  eq([res.switched, res.reason], [false, 'off']);
  eq(H.KC.writes, before);
  eq(H.FETCHED.length, 0, 'not one lookup');
  eq(H.status(), '🔀 Account auto switch: off');
});

await t('below the threshold the tick costs one live lookup per five minutes, and nothing else', async () => {
  reset();
  H.setNow(RESET + 5 * HOUR);
  seedAccounts({ live: ME });
  H.BODY[ME] = body(30, RESET + 6 * HOUR, 50, ME_WEEK);
  await freshTracker();
  H.noteStreamUsage(event(0.3, RESET + 6 * HOUR, 0.5, ME_WEEK), ME);
  for (let i = 0; i < 4; i++) {
    H.setNow(RESET + 5 * HOUR + i * 50_000);
    const res = await H.kickAutoSwitch();
    eq([res.switched, res.reason], [false, 'below the thresholds']);
  }
  eq(H.FETCHED, [ME], 'one lookup on the live token in four ticks, no candidate asked');
});

await t('★ a window spent OUTSIDE the bridge (sessions say 85, the lookup says 93) still switches, within the five minute pace (QA round 7)', async () => {
  reset();
  H.setNow(RESET + 11 * HOUR);
  seedAccounts({ live: ME, walled: { [GMAIL]: GMAIL_WEEK } });
  H.BODY[ME] = body(10, RESET + 14 * HOUR, 93, ME_WEEK); // The owner's own terminals spent it
  H.BODY[CHARLIE] = body(0, null, 5, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[DELTA] = body(0, null, 20, ZH_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  H.noteStreamUsage(event(0.1, RESET + 14 * HOUR, 0.85, ME_WEEK), ME); // the bridge's own sessions last saw 85
  const r = await H.kickAutoSwitch();
  await H.settle();
  eq(liveName(), CHARLIE, JSON.stringify(r));
  eq(H.SENT.length, 1);
  ok(H.SENT[0].includes('⬅️ From: alpha@example.test · 5h 10% · week 93%'), H.SENT[0]);
  ok(H.LOGS.some((l) => l.includes('account_autoswitch · account=alpha@example.test') && l.includes('source=lookup')), 'decided on the lookup');
});

// ---------------------------------------------------------------------------
// 2. THE 2026-10-08 MORNING: the reset at 14:00Z
// ---------------------------------------------------------------------------
await t('★ 10-08: before 14:00Z nothing is free; the first tick after 14:00Z switches, and says a reset freed it', async () => {
  reset();
  H.setNow(NOW0); // 13:50Z
  seedAccounts({ live: ME, walled: { [GMAIL]: GMAIL_WEEK } });
  H.BODY[ME] = body(6, NOW0 + 90 * MIN, 95, ME_WEEK);
  H.BODY[CHARLIE] = body(0, null, 100, RESET);
  H.BODY[DELTA] = body(0, null, 100, RESET);
  await freshTracker();
  H.noteStreamUsage(event(0.06, NOW0 + 90 * MIN, 0.95, ME_WEEK), ME);
  const before = await H.kickAutoSwitch();
  eq(before.switched, false);
  ok(before.reason.startsWith('no other account is free'), before.reason);
  ok(H.LOGS.some((l) => l.includes('account_autoswitch_standing_down · account=alpha@example.test')), 'the stand down is logged once, with the reason');
  // 13:55: not due yet (asked five minutes ago at most once).
  H.setNow(NOW0 + 5 * MIN - 1000);
  H.FETCHED.length = 0;
  await H.kickAutoSwitch();
  ok(!H.FETCHED.includes(CHARLIE), 'charlie is not asked again before its reset');
  // 14:00:30Z: both weeks have reset.
  H.setNow(RESET + 30_000);
  H.BODY[CHARLIE] = body(0, null, 0, ZH_WEEK);
  H.BODY[DELTA] = body(0, null, 0, ZH_WEEK);
  H.noteStreamUsage(event(0.07, NOW0 + 90 * MIN, 0.95, ME_WEEK), ME);
  const after = await H.kickAutoSwitch();
  await H.settle();
  eq(after.ok, true, JSON.stringify(after));
  eq(liveName(), CHARLIE, 'charlie is first in list order on equal headroom');
  ok(H.SENT.at(-1).includes('❓ Why: a reset freed charlie@example.test · 95% of the weekly window (threshold 90%)'), H.SENT.at(-1));
});

// ---------------------------------------------------------------------------
// 3. THE SCHEDULED SWITCH (acceptance criterion 2)
// ---------------------------------------------------------------------------
await t('★ AC2: a scheduled switch fires through checkSchedules and moves the login', async () => {
  reset();
  H.setNow(RESET + 6 * HOUR);
  seedAccounts({ live: DELTA });
  H.BODY[CHARLIE] = body(0, null, 10, ZH_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  H.setSched({ nextId: 1, items: [{ id: 214, kind: 'once', at: Date.now() - 1000, text: 'switch the Claude account to charlie', switchAccount: CHARLIE }] });
  H.checkSchedules();
  await H.settle();
  eq(liveName(), CHARLIE);
  eq(H.SCHED.items.length, 0, 'the once item is consumed');
  eq(H.SENT.length, 1);
  eq(H.SENT[0].split('\n')[0], '🔀 Claude account switched · scheduled #214');
  ok(H.SENT[0].includes('❓ Why: you scheduled it') && H.SENT[0].includes('📝 Note: 5h 0% · week 10%'), H.SENT[0]);
  ok(H.status().endsWith('(schedule)'), H.status());
  eq(H.fmtSchedule({ id: 3, kind: 'daily', at: '09:00', text: 'x', switchAccount: CHARLIE }), '#3 · daily 09:00 · 🔀 switch account · charlie@example.test');
});

await t('★ AC2: a scheduled switch to a walled, flagged or unknown account is refused with ONE message and nothing moves', async () => {
  for (const [target, setup, want] of [
    [GMAIL, { walled: { [GMAIL]: GMAIL_WEEK } }, 'bravo@example.test is at its limit until'],
    [ME, { flagged: { [ME]: 'token refresh rejected (invalid_grant)' } }, 'alpha@example.test needs a fresh login (token refresh rejected (invalid_grant))'],
    ['nobody@example.test', {}, '"nobody@example.test" is not a stored account'],
  ]) {
    reset();
    H.setNow(RESET + 7 * HOUR);
    seedAccounts({ live: DELTA, ...setup });
    await freshTracker();
    const before = H.KC.writes;
    H.setSched({ nextId: 1, items: [{ id: 9, kind: 'once', at: Date.now() - 1000, text: 'x', switchAccount: target }] });
    H.checkSchedules();
    await H.settle();
    eq(H.KC.writes, before, `${target}: no keychain write`);
    eq(liveName(), DELTA);
    eq(H.SENT.length, 1, `${target}: one message`);
    eq(H.SENT[0].split('\n')[0], '🚫 Claude account switch refused · scheduled #9');
    ok(H.SENT[0].includes(want), H.SENT[0]);
    ok(H.SENT[0].includes('↩️ Still on: delta@example.test'), H.SENT[0]);
  }
});

await t('a scheduled switch to an account a fresh lookup shows spent is refused too', async () => {
  reset();
  H.setNow(RESET + 8 * HOUR);
  seedAccounts({ live: DELTA });
  H.BODY[CHARLIE] = body(100, RESET + 9 * HOUR, 40, ZH_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  const r = await H.switchAccountNow(CHARLIE, { via: 'schedule', scheduleId: 11 });
  eq(r.ok, false);
  ok(r.reason.startsWith('charlie@example.test has spent the 5 hour window until'), r.reason);
  eq(liveName(), DELTA);
});

await t('a scheduled switch to the account already live says so once and writes nothing', async () => {
  reset();
  H.setNow(RESET + 9 * HOUR);
  seedAccounts({ live: CHARLIE });
  await freshTracker();
  const before = H.KC.writes;
  const r = await H.switchAccountNow(CHARLIE, { via: 'schedule', scheduleId: 12 });
  eq([r.ok, r.noop], [true, true]);
  eq(H.KC.writes, before);
  eq(H.SENT, ['🔀 Claude account switch · scheduled #12\n✅ Already on: charlie@example.test\n💤 Nothing changed']);
});

// ---------------------------------------------------------------------------
// 4. THE CLI over the REAL steer server (acceptance criterion 2, "switch now")
// ---------------------------------------------------------------------------
copyFileSync(path.join(DIR, 'bg.mjs'), P('bg.mjs'));
const server = H.startSteerServer();
await new Promise((r) => setTimeout(r, 50));
const CLEAN_ENV = { ...process.env };
for (const k of ['LEASH_LANE', 'LEASH_TRIGGER', 'LEASH_SCHEDULE_ID', 'LEASH_ALLOW_WRITE', 'TMUX', 'BG_REPORT_DRAFT']) delete CLEAN_ENV[k];
const cli = (args, env = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [P('bg.mjs'), ...args], { cwd: TMP, env: { ...CLEAN_ENV, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

await t('★ `bg.mjs account switch <name>` from the chat lane moves the login through the daemon, one message', async () => {
  reset();
  H.setNow(RESET + 10 * HOUR);
  seedAccounts({ live: ME });
  H.BODY[DELTA] = body(4, RESET + 12 * HOUR, 18, ZH_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  const r = await cli(['account', 'switch', DELTA], { LEASH_LANE: 'chat' });
  eq(r.code, 0, r.stderr);
  eq(r.stdout.trim(), 'switched to delta@example.test (from alpha@example.test)');
  await H.settle();
  eq(liveName(), DELTA);
  eq(H.SENT.length, 1);
  eq(H.SENT[0].split('\n')[0], '🔀 Claude account switched · by command');
});

await t('★ `bg.mjs account switch` from a background worker or a scheduled run is refused by the daemon, nothing moves', async () => {
  reset();
  H.setNow(RESET + 11 * HOUR);
  seedAccounts({ live: ME });
  await freshTracker();
  const before = H.KC.writes;
  for (const env of [{ LEASH_LANE: 'bg' }, { LEASH_TRIGGER: 'schedule' }]) {
    const r = await cli(['account', 'switch', DELTA], env);
    eq(r.code, 1, JSON.stringify(env));
    ok(r.stderr.includes("only the owner's own lanes can"), r.stderr);
  }
  eq(H.KC.writes, before);
  eq(liveName(), ME);
  eq(H.SENT.length, 0);
});

await t('`bg.mjs account switch` to an unknown or walled name exits 1 with the reason', async () => {
  reset();
  H.setNow(RESET + 12 * HOUR);
  seedAccounts({ live: ME, walled: { [GMAIL]: GMAIL_WEEK } });
  await freshTracker();
  const u = await cli(['account', 'switch', 'nobody@example.test']);
  eq(u.code, 1);
  ok(u.stderr.includes('is not a stored account'), u.stderr);
  const w = await cli(['account', 'switch', GMAIL]);
  eq(w.code, 1);
  ok(w.stderr.includes('is at its limit until'), w.stderr);
  eq(liveName(), ME);
});

await t('★ `bg.mjs account check` prints the decision with the real readings and swaps nothing', async () => {
  reset();
  H.setNow(RESET + 13 * HOUR);
  seedAccounts({ live: ME, walled: { [GMAIL]: GMAIL_WEEK } });
  H.BODY[ME] = body(20, RESET + 14 * HOUR, 95, ME_WEEK);
  H.BODY[CHARLIE] = body(0, null, 5, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[DELTA] = body(97, RESET + 14 * HOUR, 30, ZH_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  const before = H.KC.writes;
  const r = await cli(['account', 'check']);
  eq(r.code, 0, r.stderr);
  const out = r.stdout;
  ok(out.includes('Live: alpha@example.test · 5h 20% · week 95% · source lookup'), out);
  ok(out.includes('Over a threshold: 95% of the weekly window'), out);
  ok(out.includes('Candidate bravo@example.test: not free · walled until'), out);
  ok(out.includes('Candidate charlie@example.test: free · 5h 0% · week 5%'), out);
  ok(out.includes('Candidate delta@example.test: not free · the 5 hour window is at 97%'), out);
  ok(out.includes('Decision: SWITCH to charlie@example.test (threshold)'), out);
  eq(H.KC.writes, before, 'a dry run never writes');
  eq(H.SENT.length, 0, 'and never messages');
});

await t('`bg.mjs account` with a wrong shape is a usage error, and a prose brief starting with "account" is not caught', async () => {
  const r = await cli(['account', 'switch']);
  eq(r.code, 1);
  ok(r.stderr.includes('usage: node bg.mjs account switch'), r.stderr);
  const extra = await cli(['account', 'check', 'now']);
  eq(extra.code, 1);
  // A mistyped action is a usage error too, never a dispatched brief (QA round 7).
  const typo = await cli(['account', 'swtch', 'hello@example.test']);
  eq(typo.code, 1, JSON.stringify(typo));
  ok(typo.stderr.includes('usage: node bg.mjs account switch'), typo.stderr);
  const bare = await cli(['account']);
  eq(bare.code, 1, JSON.stringify(bare));
  ok(bare.stderr.includes('usage: node bg.mjs account switch'), bare.stderr);
  const src = readFileSync(path.join(DIR, 'bg.mjs'), 'utf8');
  ok(src.includes("if (argv[0] === 'account' && (argv[1] === 'check' || argv[1] === 'switch'))"), 'only the two exact shapes engage');
});
server.close();

// ---------------------------------------------------------------------------
// 5. THE 2026-10-08 20:52Z FALSE WALL (acceptance criterion 7)
// ---------------------------------------------------------------------------
const T_SWAP = Date.parse('2026-10-08T20:52:15Z');
const CHARLIE_5H = Date.parse('2026-10-09T00:00:00Z');
const DELTA_5H = Date.parse('2026-10-09T01:50:00Z');
async function oct8Evening() {
  reset();
  H.setNow(T_SWAP - 2 * MIN);
  seedAccounts({
    live: CHARLIE,
    walled: { [GMAIL]: Date.parse('2026-10-10T05:00:00Z'), [ME]: Date.parse('2026-10-13T06:00:01Z') },
  });
  // The lookups of that minute: charlie at its 5 hour wall, delta fresh.
  H.BODY[CHARLIE] = body(99, CHARLIE_5H, 28, Date.parse('2026-10-15T14:00:00.411Z'));
  H.BODY[DELTA] = body(2, DELTA_5H, 15, Date.parse('2026-10-15T14:00:00.040Z'));
  await H.accountUsage.one(CHARLIE);
  await H.accountUsage.one(DELTA);
  await freshTracker();
  // charlie hits the wall; the rotation marks it and swaps to delta.
  H.setNow(T_SWAP);
  H.accounts.markLimited(CHARLIE, Math.floor(CHARLIE_5H / 1000), { source: 'the wall message' });
  const r = await H.accounts.swapTo(DELTA, { refuseFlagged: true });
  eq(r.ok, true);
  await freshTracker();
  eq([liveName(), H.liveAccount.current()], [DELTA, DELTA], H.LOGS.filter((l) => l.startsWith('[accounts]')).join(' | '));
  H.setWorkers([{ runId: 'bg2-1791487899544', lane: 'bg2', title: 'a worker', engine: 'claude', steerable: true }]);
  H.setNow(T_SWAP + 15_000);
}

await t('★ AC7: charlie\'s 100% reading after the swap goes to charlie; the wall guard does not fire and the all-walled line is not logged', async () => {
  await oct8Evening();
  // A session STILL on charlie's credentials reports the wall, spawned on charlie.
  H.noteStreamUsage(event(1.0, CHARLIE_5H, 0.28, Date.parse('2026-10-15T14:00:00Z')), CHARLIE);
  // ...and one spawned after the swap (spawn = live = delta), the case the old rule could not refuse.
  H.noteStreamUsage(event(1.0, CHARLIE_5H, 0.28, Date.parse('2026-10-15T14:00:00Z')), DELTA);
  eq(H.streamUsage.get(CHARLIE)?.usage?.fiveHour?.percent, 100, 'filed under charlie');
  const delta = H.streamUsage.get(DELTA);
  ok(!delta || delta.usage.fiveHour.percent < 90, `nothing over the threshold may be held for delta: ${JSON.stringify(delta)}`);
  const g = await H.wallGuardTick();
  await H.settle();
  eq(g.fired, false, JSON.stringify(g));
  eq(H.STEERED.length, 0, 'no CHECKPOINT NOW to any worker');
  ok(!H.LOGS.some((l) => l.includes('all_accounts_walled_until')), `no all-walled line: ${H.LOGS.filter((l) => l.includes('walled')).join(' | ')}`);
  ok(!H.LOGS.some((l) => l.includes('wall_guard_checkpoint')), 'no checkpoint decision');
  eq(H.SENT.length, 0, 'nothing told to the owner');
  // And the automatic switch reads the same numbers: delta is fine, no move.
  const a = await H.kickAutoSwitch();
  eq(a.switched, false);
  eq(liveName(), DELTA);
});

await t('AC7 control: with delta GENUINELY at 100% of its own window, the same rig does fire (the guard is reachable)', async () => {
  await oct8Evening();
  // delta's own window, full: its own 5 hour reset (01:50Z).
  H.noteStreamUsage(event(1.0, DELTA_5H, 0.2, Date.parse('2026-10-15T14:00:00Z')), DELTA);
  eq(H.streamUsage.get(DELTA)?.usage?.fiveHour?.percent, 100);
  // The selector's probes (others only): bravo and alpha walled, charlie walled in the ledger.
  const g = await H.wallGuardTick();
  await H.settle();
  eq(g.fired, true, JSON.stringify(g));
  eq(H.STEERED.length, 1);
  ok(H.STEERED[0].text.startsWith('CHECKPOINT NOW'), H.STEERED[0].text.slice(0, 40));
  ok(H.LOGS.some((l) => l.includes('wall_guard_checkpoint · account=delta@example.test')), 'the checkpoint line names delta');
  // The selector was asked about the OTHER accounts only, and says so.
  ok(H.LOGS.some((l) => l.includes('no_other_account_free')), `the others-only line: ${H.LOGS.filter((l) => l.includes('free') || l.includes('walled')).join(' | ')}`);
  ok(!H.LOGS.some((l) => l.includes('all_accounts_walled_until')), 'and never the all-walled line while the live account was not asked');
});

// ---------------------------------------------------------------------------
// A FAILED AUTOMATIC SWAP (QA round 1): the keychain refuses the write. The
// automatic switch pauses for PROBE_EVERY_MS and says so ONCE, instead of a
// refusal every poll cycle until morning.
// ---------------------------------------------------------------------------

await t('★ a failed automatic swap is said once and retried only after a pause, then the switch lands when the keychain works', async () => {
  reset();
  H.setNow(RESET + 20 * HOUR);
  seedAccounts({ live: ME });
  H.BODY[ME] = body(20, RESET + 24 * HOUR, 95, ME_WEEK);
  H.BODY[CHARLIE] = body(0, null, 5, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[DELTA] = body(97, RESET + 24 * HOUR, 30, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[GMAIL] = body(0, null, 95, GMAIL_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  H.noteStreamUsage(event(0.2, RESET + 24 * HOUR, 0.95, ME_WEEK), ME);
  H.KC.fail = true;
  const results = [];
  // Four ticks fifty seconds apart, the daemon's idle cadence.
  for (let i = 0; i < 4; i++) {
    H.setNow(RESET + 20 * HOUR + i * 50_000);
    results.push(await H.kickAutoSwitch());
    await H.settle();
  }
  eq(H.SENT.length, 1, 'ONE refusal for four ticks');
  ok(H.SENT[0].startsWith('🚫 Claude account switch refused · automatic'), H.SENT[0]);
  eq(H.LOGS.filter((l) => l.includes('] account_switch_refused · ')).length, 1, 'ONE attempt: the next three ticks wait out the pause');
  ok(results.slice(1).every((r) => r && r.switched === false && /last automatic swap failed/.test(r.reason)), JSON.stringify(results.slice(1)));
  eq(liveName(), ME, 'nothing moved');
  // Past the pause the keychain still refuses: a second attempt, the same reason, no second message.
  H.setNow(RESET + 20 * HOUR + 6 * MIN);
  await H.kickAutoSwitch();
  await H.settle();
  eq(H.LOGS.filter((l) => l.includes('] account_switch_refused · ')).length, 2, 'retried after the pause');
  eq(H.SENT.length, 1, 'the same reason is not said twice');
  // The keychain works again: the next try after the pause lands, with its one notice.
  H.KC.fail = false;
  H.setNow(RESET + 20 * HOUR + 12 * MIN);
  const r = await H.kickAutoSwitch();
  await H.settle();
  eq(liveName(), CHARLIE, JSON.stringify(r));
  eq(H.SENT.length, 2);
  ok(H.SENT[1].startsWith('🔀 Claude account switched · automatic'), H.SENT[1]);
});

await t('the live account parked over a threshold with nowhere to go is looked up once per five minutes, not every tick (QA round 2)', async () => {
  reset();
  H.setNow(RESET + 30 * HOUR);
  seedAccounts({ live: ME, walled: { [CHARLIE]: ZH_WEEK + 7 * 24 * HOUR, [DELTA]: ZH_WEEK + 7 * 24 * HOUR, [GMAIL]: GMAIL_WEEK + 7 * 24 * HOUR } });
  H.BODY[ME] = body(20, RESET + 34 * HOUR, 96, ME_WEEK);
  await freshTracker();
  H.noteStreamUsage(event(0.2, RESET + 34 * HOUR, 0.96, ME_WEEK), ME);
  H.FETCHED.length = 0;
  for (let i = 0; i < 4; i++) {
    H.setNow(RESET + 30 * HOUR + i * 50_000);
    const r = await H.kickAutoSwitch();
    await H.settle();
    eq(r?.switched, false, JSON.stringify(r));
  }
  eq(H.FETCHED.filter((n) => n === ME).length, 1, `one live lookup in four ticks: ${JSON.stringify(H.FETCHED)}`);
  H.setNow(RESET + 30 * HOUR + 6 * MIN);
  await H.kickAutoSwitch();
  await H.settle();
  eq(H.FETCHED.filter((n) => n === ME).length, 2, 'asked again after five minutes');
  eq(liveName(), ME, 'nothing moved: every other account is walled');
});

await t('★ a swap that THROWS (accounts.json not writable) is said once, settles the landing record, and the next switch is not held up (QA round 4)', async () => {
  reset();
  H.setNow(RESET + 9 * HOUR);
  seedAccounts({ live: DELTA });
  H.BODY[CHARLIE] = body(0, null, 10, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[ME] = body(0, null, 10, ME_WEEK);
  await freshTracker();
  // The folder holding accounts.json goes read-only: the store's atomic write throws.
  chmodSync(TMP, 0o500);
  let r;
  try {
    r = await H.switchAccountNow(CHARLIE, { via: 'command' });
    await H.settle();
  } finally {
    chmodSync(TMP, 0o700);
  }
  eq(r.ok, false, JSON.stringify(r));
  ok(/the swap failed/.test(r.reason || ''), JSON.stringify(r));
  eq(H.SENT.length, 1, 'one message for the failed switch');
  ok(H.SENT[0].startsWith('🚫 Claude account switch refused · by command'), H.SENT[0]);
  ok(H.SENT[0].includes(`↩️ Still on: ${liveName()}`), `the notice names where the login really is (${liveName()}): ${H.SENT[0]}`);
  eq(H.landing()?.rot?.outcome, 'swap_failed', 'the landing record settled');
  ok(!(H.rotationCooldownUntil > Date.now()), 'the cooldown came back');
  // The next switch is not made to wait on a record that never lands.
  H.SENT.length = 0;
  const t0 = performance.now();
  const r2 = await H.switchAccountNow(ME, { via: 'command' });
  await H.settle();
  ok(performance.now() - t0 < 5000, `the next switch waited ${Math.round(performance.now() - t0)} ms`);
  eq(r2.ok, true, JSON.stringify(r2));
  eq(liveName(), ME);
});

await t('★ a landing record a rotation never settled (it threw) neither holds an owner switch up nor refuses it (QA round 5)', async () => {
  reset();
  H.setNow(RESET + 10 * HOUR);
  seedAccounts({ live: DELTA });
  H.BODY[CHARLIE] = body(0, null, 10, ZH_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  // A rotation that started a minute ago and threw before landed(): its promise never settles.
  H.setLanding({ startedAt: Date.now() - 60_000, landedAt: 0, rot: null, op: new Promise(() => {}) });
  const t0 = performance.now();
  const r = await H.switchAccountNow(CHARLIE, { via: 'command' });
  await H.settle();
  ok(performance.now() - t0 < 5000, `it waited ${Math.round(performance.now() - t0)} ms on a dead record`);
  eq(r.ok, true, JSON.stringify(r));
  eq(liveName(), CHARLIE);
  eq(H.SENT.length, 1);
  ok(H.SENT[0].startsWith('🔀 Claude account switched · by command'), H.SENT[0]);
});

await t('★ an owner\'s switch onto an account already past the threshold is kept: the automatic switch leaves it alone until that window resets (QA round 8)', async () => {
  reset();
  H.setNow(RESET + 12 * HOUR);
  seedAccounts({ live: DELTA, walled: { [GMAIL]: GMAIL_WEEK } });
  const zalWeek = ZH_WEEK + 7 * 24 * HOUR;
  H.BODY[CHARLIE] = body(10, RESET + 15 * HOUR, 92, zalWeek); // past the 90 week threshold
  H.BODY[DELTA] = body(5, RESET + 15 * HOUR, 10, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[ME] = body(0, null, 10, ME_WEEK);
  await freshTracker();
  const r = await H.switchAccountNow(CHARLIE, { via: 'command' });
  await H.settle();
  eq(r.ok, true, JSON.stringify(r));
  eq(liveName(), CHARLIE);
  ok(H.SENT[0].includes('already past the automatic switch threshold'), H.SENT[0]);
  // Six minutes on (past the settle window), its sessions report the same 92 percent.
  await freshTracker();
  H.setNow(RESET + 12 * HOUR + 6 * MIN);
  H.noteStreamUsage(event(0.1, RESET + 15 * HOUR, 0.92, zalWeek), CHARLIE);
  H.SENT.length = 0;
  const tick = await H.kickAutoSwitch();
  await H.settle();
  eq(liveName(), CHARLIE, 'the owner\'s pick stands');
  eq(H.SENT.length, 0, 'no automatic notice');
  ok(/the owner chose charlie@example\.test past the threshold/.test(tick?.reason || ''), JSON.stringify(tick));
  // Past the window that crossed, the hold is gone and the rule applies again.
  H.setNow(zalWeek + MIN);
  await freshTracker();
  const after = await H.kickAutoSwitch();
  await H.settle();
  ok(!/the owner chose/.test(after?.reason || ''), JSON.stringify(after));
});

await t('★ the owner\'s hold is cleared by ANY later swap, so a return trip by the machinery is not held (QA round 9)', async () => {
  reset();
  H.setNow(RESET + 13 * HOUR);
  seedAccounts({ live: DELTA, walled: { [GMAIL]: GMAIL_WEEK } });
  const zalWeek = ZH_WEEK + 7 * 24 * HOUR;
  H.BODY[CHARLIE] = body(10, RESET + 16 * HOUR, 92, zalWeek);
  H.BODY[DELTA] = body(5, RESET + 16 * HOUR, 10, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[ME] = body(0, null, 10, ME_WEEK);
  await freshTracker();
  await H.switchAccountNow(CHARLIE, { via: 'command' });
  await H.settle();
  ok(H.ownerHold()?.name === CHARLIE, JSON.stringify(H.ownerHold()));
  // +20 min the rotation (or /account) moves the login off, +40 min the machinery brings it back.
  H.setNow(RESET + 13 * HOUR + 20 * MIN);
  eq((await H.accounts.swapTo(DELTA)).ok, true);
  eq(H.ownerHold(), null, 'any landed swap clears the hold');
  H.setNow(RESET + 13 * HOUR + 40 * MIN);
  eq((await H.accounts.swapTo(CHARLIE)).ok, true);
  // +50 min, past the settle window: the rule applies again and the login moves off charlie at 92 percent.
  H.setNow(RESET + 13 * HOUR + 50 * MIN);
  await freshTracker();
  H.SENT.length = 0;
  const r = await H.kickAutoSwitch();
  await H.settle();
  ok(liveName() !== CHARLIE, `the automatic switch is not held: ${JSON.stringify(r)}`);
  ok(H.SENT[0]?.startsWith('🔀 Claude account switched · automatic'), JSON.stringify(H.SENT));
});

await t('★ a typed /account pick past the threshold is kept (armed from the reading peeked before the swap), and a pick with no reading at hand is judged at the next tick (QA round 9)', async () => {
  for (const peeked of [true, false]) {
    reset();
    H.setNow(RESET + 14 * HOUR);
    seedAccounts({ live: DELTA, walled: { [GMAIL]: GMAIL_WEEK } });
    const zalWeek = ZH_WEEK + 7 * 24 * HOUR;
    H.BODY[CHARLIE] = body(10, RESET + 17 * HOUR, 92, zalWeek);
    H.BODY[DELTA] = body(5, RESET + 17 * HOUR, 10, ZH_WEEK + 7 * 24 * HOUR);
    H.BODY[ME] = body(0, null, 10, ME_WEEK);
    await freshTracker();
    // What the /account arm does: the swap, then armOwnerHold with the peeked row (or none).
    eq((await H.accounts.swapTo(CHARLIE)).ok, true);
    H.armOwnerHold(CHARLIE, peeked ? H.BODY[CHARLIE] && { fiveHour: { percent: 10, resetsAt: new Date(RESET + 17 * HOUR).toISOString() }, sevenDay: { percent: 92, resetsAt: new Date(zalWeek).toISOString() }, scoped: [] } : null);
    if (peeked) ok(H.ownerHold()?.until === zalWeek, JSON.stringify(H.ownerHold()));
    else eq(H.ownerHold(), { name: CHARLIE, until: null });
    H.setNow(RESET + 14 * HOUR + 6 * MIN);
    await freshTracker();
    H.SENT.length = 0;
    const r = await H.kickAutoSwitch();
    await H.settle();
    eq(liveName(), CHARLIE, `peeked=${peeked}: the owner\'s pick stands: ${JSON.stringify(r)}`);
    eq(H.SENT.length, 0);
    ok(/the owner chose charlie@example\.test past the threshold/.test(r?.reason || ''), JSON.stringify(r));
  }
});

await t('every owner path arms the hold: the typed /account arm and the account button hook call armOwnerHold, and the swap wrapper clears it', () => {
  const src = SRC.join('\n');
  ok(/const brief = accountUsage\.peek\(parts\[0\]\);\s*const r = await accounts\.swapTo\(parts\[0\]\);[\s\S]{0,400}?armOwnerHold\(r\.to \|\| parts\[0\], brief\?\.state === 'ok' \? brief\.usage : null\);/.test(src), 'the /account arm');
  ok(/onSwapped: \(res\) => \{[\s\S]{0,400}?armOwnerHold\(res\?\.to \|\| null, seen\?\.state === 'ok' \? seen\.usage : null\);[\s\S]{0,80}?invalidateUsageCache\(\);/.test(src), 'the button hook, before the cache goes');
  ok(/if \(res\?\.ok\) \{[\s\S]{0,400}?autoSwitchOwnerHold = null;/.test(src), 'the wrapper clears it on every landed swap');
  ok(src.includes("if (via !== 'auto') armOwnerHold(name, toUsage);"), 'the scheduled and commanded switch');
});

await t('parked over the line with no account free: the standing-down line is said once, not once a minute (QA round 10)', async () => {
  reset();
  H.setNow(RESET + 15 * HOUR);
  seedAccounts({ live: ME, walled: { [GMAIL]: GMAIL_WEEK, [DELTA]: ZH_WEEK + 7 * 24 * HOUR } });
  H.BODY[ME] = body(20, RESET + 18 * HOUR, 96, ME_WEEK);
  H.BODY[CHARLIE] = body(95, RESET + 17 * HOUR, 40, ZH_WEEK + 7 * 24 * HOUR); // probed, not free
  await freshTracker();
  H.noteStreamUsage(event(0.2, RESET + 18 * HOUR, 0.96, ME_WEEK), ME);
  for (const m of [0, 1, 3.5, 4.2, 4.8]) {
    H.setNow(RESET + 15 * HOUR + m * MIN);
    await H.kickAutoSwitch();
    await H.settle();
  }
  const lines = H.LOGS.filter((l) => l.includes('] account_autoswitch_standing_down · '));
  eq(lines.length, 1, lines.join('\n'));
  eq(liveName(), ME);
});

await t('a wall more than a day out names its day in the dry run (live proof 2026-10-09: "walled until 01:00" for a Saturday reset)', async () => {
  reset();
  H.setNow(RESET + 14 * HOUR); // 2026-10-09T04:00Z
  seedAccounts({ live: DELTA, walled: { [GMAIL]: Date.parse('2026-10-10T05:00:00Z'), [ME]: Date.parse('2026-10-13T06:00:01Z') } });
  H.BODY[DELTA] = body(71, RESET + 15 * HOUR, 40, ZH_WEEK + 7 * 24 * HOUR);
  H.BODY[CHARLIE] = body(0, null, 30, ZH_WEEK + 7 * 24 * HOUR);
  await freshTracker();
  const r = await H.autoSwitchTick(Date.now(), { dryRun: true });
  const reasons = Object.fromEntries(r.candidates.map((c) => [c.name, c.verdict?.reason || '']));
  ok(/^walled until Sat 10 Oct /.test(reasons[GMAIL]), reasons[GMAIL]);
  ok(/^walled until Tue 13 Oct /.test(reasons[ME]), reasons[ME]);
});

// ---------- report ----------
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all account auto switch wiring tests pass');
process.exit(0);
