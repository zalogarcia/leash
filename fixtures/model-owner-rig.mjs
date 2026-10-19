// The model owner rig: the daemon's real model, refusal and rotation functions,
// cut out of bridge.mjs by name and run against the real account store, the
// real usage reader, the real live account tracker and the real selector, with
// fake credentials and a fake fetch. bridge.mjs is READ as text, never
// imported (importing it boots a daemon). HOME is a temp folder, so the model
// limits export never touches ~/.claude.
//
// MODEL_OWNER_DIR points the rig at another checkout (an export of an older
// commit, say), so the same behavior test can be run against the code it
// replaced. The `start` adapter is the only place that knows the old names.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const W = process.env.MODEL_OWNER_DIR ? path.resolve(process.env.MODEL_OWNER_DIR) + '/' : new URL('../', import.meta.url).pathname;
const u = (f) => 'file://' + W + f;
export const models = await import(u('model-limits.mjs'));
const accountsMod = await import(u('accounts.mjs'));
const selector = await import(u('account-selector.mjs'));
export const usageMod = await import(u('account-usage.mjs'));
const streamMod = await import(u('stream-usage.mjs'));
export const sysmsg = await import(u('system-messages.mjs'));
export const source = fs.readFileSync(W + 'bridge.mjs', 'utf8');
export function grab(name) {
  const L = source.split('\n');
  const s = L.findIndex((l) => new RegExp(`^(?:async )?function ${name}\\(`).test(l));
  assert.ok(s >= 0, `missing function ${name}`);
  const e = L.findIndex((l, i) => i > s && l === '}');
  return L.slice(s, e + 1).join('\n');
}
export const has = (name) => new RegExp(`^(?:async )?function ${name}\\(`, 'm').test(source);
function between(startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  assert.ok(s >= 0, `missing marker ${startMarker}`);
  const e = source.indexOf(endMarker, s);
  assert.ok(e > s, `missing end marker after ${startMarker}`);
  return source.slice(s, e + endMarker.length);
}
export const NOW = Date.now();
export const sec = (ms) => Math.floor(ms / 1000);
export const HOUR = 3600_000;
export const weekReset = sec(NOW + 50 * HOUR);
export const fiveReset = sec(NOW + 1 * HOUR);
export const iso = (s) => new Date(s * 1000).toISOString();
// The real refusal of a Fable request, 2026-10-12 (ids removed): no model named,
// both every-model windows open.
export const realEvent = () => ({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: weekReset, rateLimitType: 'seven_day_overage_included', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.57, resetsAt: fiveReset }, seven_day: { utilization: 0.95, resetsAt: weekReset }, seven_day_overage_included: { utilization: 1, resetsAt: weekReset } } } });
// A five hour wall: an every-model window at 100.
export const fiveWallEvent = ({ weekly = weekReset, reset = sec(NOW + 2 * HOUR) } = {}) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset,
  unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset }, seven_day: { utilization: 0.4, resetsAt: weekly } } } });
export const allowedEvent = () => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: fiveReset, rateLimitType: 'five_hour',
  unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: fiveReset }, seven_day: { utilization: 0.95, resetsAt: weekReset } } } });
export const apiBody = ({ five = 57, week = 90, fable = 100, opus = null, fiveResets = iso(fiveReset), weekly = weekReset } = {}) => ({ limits: [
  ...(five === undefined ? [] : [{ kind: 'session', percent: five, resets_at: five === 0 ? null : fiveResets }]),
  { kind: 'weekly_all', percent: week, resets_at: iso(weekly) },
  ...(fable === null ? [] : [{ kind: 'weekly_scoped', percent: fable, resets_at: iso(weekly), scope: { model: { display_name: 'Fable' } } }]),
  ...(opus === null ? [] : [{ kind: 'weekly_scoped', percent: opus, resets_at: iso(weekly), scope: { model: { display_name: 'Opus' } } }]),
] });
export const WALL = "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
export const SESSION = "You've hit your session limit · resets 3pm (America/Toronto)";

const FNS = ['publishModelLimits', 'reconcileModelUsage', 'laneModel', 'prepareRunModel', 'startModel', 'noteStreamUsage', 'freshModelRead', 'scheduleModelUsageRead', 'recheckLegacyModelWalls', 'kickAutoSwitch',
  'rotationStarted', 'rotationBehindCooldown', 'classifyModelRefusal', 'rotateOffLimitedAccount', 'chatLimitRetryPlan', 'handbackLimitPlan', 'handleChatLimitFailure', 'pickHealthyAccount', 'usageResetFor', 'logAccountDecision', 'queueItem'];
const PRESENT = FNS.filter(has);
// The carried retry decision as each generation spelled it: none (73ee3a0),
// `retryModel: 'opus'` (bb05c0a), `carriedModel` (this one).
export const carriedOf = (opts = {}) => opts.carriedModel ?? (opts.retryModel === 'opus' ? { model: 'opus', told: true } : null);

export function makeRig({ rows, live = rows[0].name, chatModel = 'fable', bgModel = 'opus', bodies = {}, profileEmail = undefined, overrides = {}, trackerTtlMs = 15_000 } = {}) {
  usageMod.invalidateUsageCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-owner-rig-'));
  const file = path.join(dir, 'accounts.json');
  // Unique tails AND unique prefixes: fingerprint() reads the last 6 chars, matchAccount() the first 24.
  const tok = (n) => `access-token-for-${n}`;
  const full = rows.map((r) => ({ claudeAiOauth: { accessToken: tok(r.name), refreshToken: `${r.name}-refresh-`.padEnd(40, 'x') + `-${r.name}` }, ...r }));
  fs.writeFileSync(file, JSON.stringify(full));
  const counts = { credReads: 0, credWrites: 0, usageGets: {}, profileGets: 0, autoSwitchTicks: 0 };
  const notices = [], dispatched = [], logs = [];
  let liveBlob = live ? { claudeAiOauth: structuredClone(full.find((a) => a.name === live).claudeAiOauth) } : null;
  let credDelay = 0;
  const credentials = { kind: 'fake', describe: () => 'fake store',
    read: async () => { counts.credReads++; if (credDelay) await new Promise((x) => setTimeout(x, credDelay)); return liveBlob ? structuredClone(liveBlob) : null; },
    write: async (blob) => { counts.credWrites++; liveBlob = structuredClone(blob); } };
  const accounts = accountsMod.createAccountStore({ file, credentials, log: () => {} });
  const fetchImpl = async (url, { headers }) => {
    const name = String(headers.Authorization).replace('Bearer ', '').replace('access-token-for-', '');
    if (url.includes('/api/oauth/usage')) {
      counts.usageGets[name] = (counts.usageGets[name] || 0) + 1;
      let b = bodies[name];
      if (typeof b === 'function') b = await b(counts.usageGets[name]);
      if (!b) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
      if (b.status) return { ok: false, status: b.status, headers: { get: (h) => (h === 'retry-after' ? b.retryAfter ?? null : null) }, json: async () => ({ error: { type: 'rate_limit_error' } }) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => structuredClone(b) };
    }
    if (url.includes('/api/oauth/profile')) {
      counts.profileGets++;
      if (!profileEmail) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ account: { email: profileEmail } }) };
    }
    throw new Error('unexpected url ' + url);
  };
  const streamUsage = streamMod.createStreamUsage({ file: path.join(dir, 'usage-stream.json'), log: () => {} });
  const apiRef = {};
  // The daemon's real reader wiring, with fake transport and credentials.
  const accountUsage = new Function('createAccountUsage', 'accounts', 'streamUsage', 'reconcileModelUsage',
    `${between('const accountUsage = createAccountUsage({', '\n});')} return accountUsage;`)(
      (opts) => usageMod.createAccountUsage({ ...opts, fetchImpl, log: () => {} }),
      accounts, streamUsage, (name, usage) => apiRef.api.reconcileModelUsage(name, usage));
  const liveAccount = streamMod.createLiveAccountTracker({ readCredentials: () => accounts.readCredentials(), resolveActive: () => accountUsage.resolveActive(), fingerprint: accountsMod.fingerprint, ttlMs: trackerTtlMs });
  const state = { model: chatModel };
  const lane = { name: 'main', queue: [] };
  const bgLane = { name: 'bg', queue: [], isBg: true };
  const start = (l, carried = null) => {
    if (apiRef.api.startModel) return apiRef.api.startModel(l, carried);
    if (carried && source.includes("retryModel === 'opus' ? retryModel : prepareRunModel(lane)")) return 'opus';
    return apiRef.api.prepareRunModel(l);
  };
  const deps = { ...models, path, HOME: dir, accounts, streamUsage, accountUsage, liveAccount,
    normalizeRateLimitEvent: usageMod.normalizeRateLimitEvent, invalidateUsageCache: usageMod.invalidateUsageCache, resetsAtToMs: usageMod.resetsAtToMs,
    fmtResetClock: usageMod.fmtResetClock, modelFallbackNotice: sysmsg.modelFallbackNotice, chatRotatedLine: sysmsg.chatRotatedLine,
    chatModelFallbackLine: sysmsg.chatModelFallbackLine || (() => 'Continuing with Opus on the same account.'),
    chatWalledRetryLine: sysmsg.chatWalledRetryLine, handbackLimitLine: sysmsg.handbackLimitLine,
    isLimitSignal: accountsMod.isLimitSignal, parseResetTime: accountsMod.parseResetTime,
    selectAccount: selector.selectAccount, PROBE_TIMEOUT_MS: selector.PROBE_TIMEOUT_MS, createRecheckLimiter: selector.createRecheckLimiter, limitClearVerdict: selector.limitClearVerdict,
    LANES: { main: lane }, BG_MODEL: bgModel, DEFAULT_MODEL: 'opus', chatState: () => state, OWNER_TZ: 'America/Toronto', OWNER_NAME: 'Owner',
    CLAUDE_AVAILABLE: true, ROTATION_COOLDOWN_MS: 90_000, ROTATION_LANDING_WAIT_MS: 45_000, WALL_WAKE_TAG: 'wake:',
    fmtLeft: () => 'later', flagLoginsFromRows: () => [], flagNeedsLogin: () => false,
    wallWake: { raised: () => {} }, moveLoginToNextAtWall: async () => ({ moved: false }), raiseClaudeWall: async () => {}, armWallResume: () => {},
    codexTakingChat: () => false, codexCanTakeChat: () => false, keepHandback: () => ({}), withoutWallWakeNote: (v) => v, saveState: () => {},
    autoSwitchTick: async () => { counts.autoSwitchTicks++; return { switched: false }; }, pendingOps: new Set(),
    send: async (line) => { notices.push(line); },
    dispatchPrompt: (text, l, opts = {}) => { dispatched.push({ text, opts, model: start(l, carriedOf(opts)) }); },
    console: { log: (m) => logs.push(String(m)), error: (...a) => logs.push('ERR ' + a.join(' ')) },
  };
  Object.assign(deps, overrides);
  const body = `
let rotationPausedUntil = 0, rotationCooldownUntil = 0, rotationLanding = null, autoSwitchInflight = null, lastAccountSwap = null, autoSwitchOwnerHold = null;
const modelFallbacks = new Map();
const modelUsageRecheck = createRecheckLimiter();
${source.includes('const legacyModelRecheck = modelUsageRecheck;') ? 'const legacyModelRecheck = modelUsageRecheck;' : 'const legacyModelRecheck = createRecheckLimiter();'}
${source.includes('const modelReads = new Map();') ? 'const modelReads = new Map();\nconst MODEL_READ_REUSE_MS = 10_000;' : ''}
const limitRecheck = createRecheckLimiter();
${between('const withDeadline = (p, ms, fallback = null) =>', ']);')}
${PRESENT.map(grab).join('\n')}
${between('const swapToStore = accounts.swapTo;', '\n};\n')}
return { ${PRESENT.join(', ')}, modelFallbacks, pendingOps,
  cooldown: () => rotationCooldownUntil, setCooldown: (v) => { rotationCooldownUntil = v; }, paused: () => rotationPausedUntil, setPaused: (v) => { rotationPausedUntil = v; } };
`;
  const api = new Function(...Object.keys(deps), body)(...Object.values(deps));
  apiRef.api = api;
  const exportFile = path.join(dir, '.claude/state/model-limits.json');
  return { dir, file, accounts, accountUsage, streamUsage, liveAccount, api, lane, bgLane, state, counts, notices, dispatched, logs, start,
    setLive: (n) => { liveBlob = { claudeAiOauth: structuredClone(accounts.listAccounts().find((a) => a.name === n).claudeAiOauth) }; },
    setLiveBlob: (b) => { liveBlob = b; }, setCredDelay: (v) => { credDelay = v; },
    row: (n) => accounts.listAccounts().find((a) => a.name === n),
    ledger: () => accounts.listAccounts().map((a) => ({ name: a.name, limitedUntil: a.limitedUntil ?? null, models: Object.fromEntries(Object.entries(a.modelLimits || {}).map(([k, v]) => [k, v.until])) })),
    exported: () => (fs.existsSync(exportFile) ? JSON.parse(fs.readFileSync(exportFile, 'utf8')) : null),
    raw: () => fs.readFileSync(file, 'utf8'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
export const tick = () => new Promise((r) => setImmediate(r));
export async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The REAL stream handler of runClaude (its onLine), on a fake run object: what
// a Claude run records from each line of its stream.
export function streamHandler(rig, model = 'opus', spawnAccount = 'a') {
  const start = source.indexOf('    const onLine = (line) => {');
  const end = source.indexOf('\n    };', start) + '\n    };'.length;
  const run = { requestedModel: model, stopped: false };
  const deps = { run, spawnAccount, noteStreamUsage: rig.api.noteStreamUsage, isBgLane: false };
  const onLine = new Function(...Object.keys(deps), `${source.slice(start, end)}; return onLine;`)(...Object.values(deps));
  return { run, feed: (ev) => onLine(JSON.stringify(ev)) };
}
export function handleEvent(rig, event, model = 'opus', spawnAccount = 'a') {
  const h = streamHandler(rig, model, spawnAccount);
  h.feed(event);
  return h.run;
}

// The REAL start of runClaude, up to the spawn, plus its error handler and
// drainQueue: which model a run is spawned with, and that a failed decision or
// a /stop still drains the queue. `decide` stands in for the start decision.
export function runPrefix(decide, liveTracker = { peek: () => 'a', current: () => 'a' }) {
  let started = 0, drained = 0, model;
  const dispatched = [];
  const lane = { name: 'main', queue: [] };
  const deps = { LANES: { main: lane }, chatState: () => ({}), composeWithQuote: (_q, t) => t,
    createBtwTracker: () => ({}), prepareRunModel: () => decide(lane, null), startModel: (l, carried) => decide(l, carried), laneModel: () => 'fable',
    console: { error: () => {} },
    path, HOME: '/fixture', INBOX_DIR: '/fixture/inbox', DEFAULT_EFFORT: 'high', existsSync: () => false,
    THINKING_WORDS: ['thinking'], tg: async () => null, CHAT_ID: 1, thinkingWord: () => 'thinking',
    attachmentFrameNote: () => '', replyQuoteFrameNote: () => '',
    redactTokens: (x) => x, clip: (x) => x, oneLine: (x) => x, WAKE_UP_PROMPT_MAX: 1000, COMPACT_MARKER: 'compact:',
    saveState: () => {}, workerEnv: () => ({}), liveAccount: liveTracker, CLAUDE_BIN: 'fixture',
    spawnWorker: (_bin, args) => {
      started++; model = args[args.indexOf('--model') + 1];
      return { child: { on: (_event, handler) => { queueMicrotask(() => handler(new Error('fixture child exit'))); } } };
    },
    clearTimeout: () => {}, clearInterval: () => {}, closeStdin: () => {}, drainBtw: () => {},
    sendError: async () => {}, claudeFailureRemedy: () => '', classifyClaudeFailure: () => '', clearTurnInFlight: () => {},
    asQueueItem: (text) => ({ text }), engineForItem: () => ({ engine: 'claude' }),
    resolveQueueAck: () => {}, startResolvedRun: (_decision, _lane, item) => { drained++; dispatched.push(item.text); return 'started'; },
  };
  const full = grab('runClaude');
  const spawnLine = '    const { child } = spawnWorker(CLAUDE_BIN, args, { cwd, env: childEnv, logPath });';
  const prefix = full.slice(0, full.indexOf(spawnLine) + spawnLine.length);
  const errorStart = full.indexOf("    child.on('error', async (e) => {");
  const errorEnd = full.indexOf('\n    });', errorStart) + '\n    });'.length;
  const run = new Function(...Object.keys(deps), `${grab('drainQueue')}\n${prefix}\nlet killTimer, editTimer, typingTimer, tail;\n${full.slice(errorStart, errorEnd)}\n});\n}\nreturn runClaude;`)(...Object.values(deps));
  return { lane, run, dispatched, counts: () => ({ started, drained, model }) };
}

let pass = 0, fail = 0;
const only = process.env.MODEL_OWNER_ONLY ? new RegExp(process.env.MODEL_OWNER_ONLY) : null;
export async function test(id, fn) {
  if (only && !only.test(id)) return;
  try { await fn(); pass++; console.log(`ok ${id}`); }
  catch (e) { fail++; console.log(`FAIL ${id}: ${String(e.message).split('\n').slice(0, 8).join(' | ')}`); }
}
export function summary() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
export async function withRig(opts, fn) {
  const r = makeRig(opts);
  try { await r.liveAccount.refresh(); await fn(r); }
  finally { await settle(); r.cleanup(); }
}
