#!/usr/bin/env node
// THE ROTATION OFF A LIMIT WALL: the real bridge.mjs functions, run against
// stubs. Existence is not implementation, so this does not assert that
// usageResetFor is defined; it asserts that a wall carrying NO reset clock
// still marks the account until the window the usage API reports, and that a
// wall carrying one never touches the network to find that out.
//
// Why it exists: on 2026-09-10 19:12 and 19:21 ET the chat lane died twice in
// five seconds on "You're out of usage credits ..." with two free accounts in
// the store. accounts.test.mjs now covers the phrase; this covers the half
// that follows it, because the new wall carries no clock and the one-hour
// guess would have freed the dead account at 20:12 to die again.
//
// bridge.mjs runs main() only as an entry point, but the functions under test
// are extracted by source and evaluated against stubs anyway, exactly as
// system-wiring.test.mjs and bg-codex-wiring.test.mjs do. No network, no
// Telegram token, no daemon, no credential store.
//
//   node limit-rotation.test.mjs

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The probe deadline is a CONTRACT the rotation depends on (a slow API must
// cost the verification, not the rotation), so it is asserted here against the
// module that owns it rather than restated.
import { PROBE_TIMEOUT_MS } from './account-selector.mjs';

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
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// Same extractor as system-wiring.test.mjs: a top-level `function` or `const`
// and everything indented under it, up to the next top-level line.
const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
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
const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);
// The wall episode's file (wall-wake.mjs): real, on a scratch path.
const TMP = mkdtempSync(path.join(tmpdir(), 'limit-rotation-test-'));
const WALL_WAKE_FILE = path.join(TMP, 'wall-wake.json');

const NOW = Date.UTC(2026, 8, 10, 23, 12, 0); // 2026-09-10 19:12 ET, the incident
const HOUR = 3600_000;
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

// The exact sentence off the screenshots.
const WALL =
  "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";

const HARNESS = `
import { parseResetTime, isLimited, earliestReset as earliestResetReal, loginFlag } from ${url('accounts.mjs')};
// THE REAL SELECTION RULE. The whole point of this block is that a candidate is
// verified before it is swapped onto, so a stub of it here would prove nothing.
import { selectAccount, PROBE_TIMEOUT_MS, createRecheckLimiter, limitClearVerdict } from ${url('account-selector.mjs')};
import { resetsAtToMs, invalidateUsageCache, rowLoginProblem } from ${url('account-usage.mjs')};
import { fmtLeft } from ${url('usage-limits.mjs')};
// THE WALL WAKE-UP (2026-09-30): the real episode store, the real next-account
// rule and the real prompt and notice builders, so what the tests read is what
// the chat session and its user would.
import { createWallWake, pickNextAccount } from ${url('wall-wake.mjs')};
import { wallWakePrompt, limitWallLine, needsLoginNotice } from ${url('system-messages.mjs')};
import { unlinkSync } from 'node:fs';

// The clock is frozen at the incident, so a "one hour out" guess is a value a
// test can name rather than a moving target.
const NOW = ${NOW};
Date.now = () => NOW;

export const CALLS = [];
export const LOGS = [];
const console = { log: (m) => LOGS.push(String(m)), error: (m) => LOGS.push('ERR ' + String(m)) };

const CLAUDE_AVAILABLE = true;
const ROTATION_COOLDOWN_MS = 30000;
let rotationPausedUntil = 0;
let rotationCooldownUntil = 0;
export const marked = [];
export let USAGE_ROW = null;
export const setUsageRow = (r) => { USAGE_ROW = r; };
export let usageThrows = false;
export const setUsageThrows = (v) => { usageThrows = v; };
export let usageHangs = false;
export const setUsageHangs = (v) => { usageHangs = v; };
export const reset = () => {
  CALLS.length = 0; LOGS.length = 0; marked.length = 0; probeCalls.length = 0; clearedNames.length = 0; FLUSHES.length = 0;
  rotationPausedUntil = 0; rotationCooldownUntil = 0;
  limitRecheck = createRecheckLimiter(); CONFIG_WALL_UNTIL = 0; LANES.main.current = null; bgLanes.length = 0;
  walledSweepInflight = null; lastWalledActiveSweep = 0; pendingOps.clear(); ALL_SNAPSHOT = null; probeGate = null;
  USAGE_ROW = null; usageThrows = false; usageHangs = false; NEXT = { name: 'free-slot' }; swapOk = true; swapWait = null;
  LIST = []; PROBES = {}; ACTIVE = 'a@example.com'; probeThrows = false; probeHangs = false;
  if (wallResumeTimer) clearTimeout(wallResumeTimer);
  wallResumeTimer = null;
  try { unlinkSync(WALL_WAKE_FILE); } catch {}
  wallWake = createWallWake({ file: WALL_WAKE_FILE });
  DISPATCHED.length = 0; PARKED_CHATS.length = 0; CODEX_PARKED = 0; RENDERS.length = 0;
  parkedHandbacks.length = 0; handbackStreak = 0; handbackCapNotified = false; lastParkedAt = 0;
  CHAT_ENGINE = 'claude'; wallLiftInflight = null; wallNotices.clear();
  NOTICES.length = 0; flagged.length = 0;
};
// THE NEEDS-LOGIN NOTICE (2026-09-30): what send() was asked to deliver, and
// every flag the store was asked to raise (raised or not).
export const NOTICES = [];
export const flagged = [];
const send = async (text, opts) => { NOTICES.push(text); return { ok: true }; };
const WALL_WAKE_FILE = ${JSON.stringify(WALL_WAKE_FILE)};
export let wallWake = createWallWake({ file: WALL_WAKE_FILE });
// A daemon restart: a fresh store over the same file, as main() would build.
export const restartWallWake = () => { wallWake = createWallWake({ file: WALL_WAKE_FILE }); wallLiftInflight = null; };
let wallLiftInflight = null;
const wallNotices = new Map();
export const DISPATCHED = [];
const dispatchPrompt = (text, lane, opts = {}) => { DISPATCHED.push({ text, lane: lane === LANES.main ? 'main' : lane ? 'bg' : 'auto', ...opts }); };
const BRIDGE_NAME = 'Leash';
const OWNER_NAME = 'the owner';
const BG_CLI = '/bridge/bg.mjs';
export let CHAT_ENGINE = 'claude';
export const setChatEngine = (v) => { CHAT_ENGINE = v; };
const chatLaneEngine = () => CHAT_ENGINE;
const claudeRateWalled = (now = Date.now()) => CLAUDE_AVAILABLE && rotationPausedUntil > now;
// The capped handback chain (bridge.mjs): the lift folds what it holds.
export const parkedHandbacks = [];
let handbackStreak = 0;
let handbackCapNotified = false;
let lastParkedAt = 0;
export const chainState = () => ({ handbackStreak, handbackCapNotified, lastParkedAt });
export const setChain = (v) => { handbackStreak = v.handbackStreak ?? handbackStreak; handbackCapNotified = v.handbackCapNotified ?? handbackCapNotified; lastParkedAt = v.lastParkedAt ?? lastParkedAt; };
export let NEXT = { name: 'free-slot' };
export const setNext = (v) => { NEXT = v; };
export let swapOk = true;
export let swapWait = null;
export const setSwapWait = (p) => { swapWait = p; };
export const setSwapOk = (v) => { swapOk = v; };
export const pausedUntil = () => rotationPausedUntil;
export const setCooldownUntil = (v) => { rotationCooldownUntil = v; };
export const setPausedUntil = (v) => { rotationPausedUntil = v; };
// THE RE-CHECK OF A HELD WALL (2026-09-30). The REAL limiter, one per test, as
// the daemon holds one for its whole life.
export let limitRecheck = createRecheckLimiter();
export const clearedNames = [];
// The seeded rehearsal wall (bridge.mjs CONFIG_WALL_UNTIL).
export let CONFIG_WALL_UNTIL = 0;
export const setConfigWall = (v) => { CONFIG_WALL_UNTIL = v; };
export const LANES = { main: { current: null } };
export const bgLanes = [];
const pendingOps = new Set();
export const settle = () => Promise.all([...pendingOps]);
let lastWalledActiveSweep = 0;
const WALLED_ACTIVE_SWEEP_MS = 60000;
let walledSweepInflight = null;

// THE STORE, as a list this test can shape. The selection rule under test is
// the REAL one (account-selector.mjs, imported below), so the ledger it filters
// and the probes it makes have to be real data rather than a mirror of the
// answer.
export let LIST = [];
export const setList = (v) => { LIST = v; };
// What the usage API says about each slot, by name. Absent = the probe comes
// back unreadable, which is NOT a wall.
export let PROBES = {};
export const setProbes = (v) => { PROBES = v; };
export const probeCalls = [];
const accounts = {
  activeAccount: async () => ({ account: { name: ACTIVE } }),
  listAccounts: () => LIST,
  describe: (now = Date.now()) =>
    LIST.map((a) => ({
      name: a.name,
      captured: !!a.claudeAiOauth?.accessToken,
      limitedUntil: a.limitedUntil || null,
      limited: isLimited(a, now),
      limitedVerifiedAt: a.limitedVerifiedAt || null,
      limitedSource: a.limitedSource || null,
      needsLogin: loginFlag(a) ? { reason: a.needsLogin.reason || null, at: a.needsLogin.at || null } : null,
    })),
  // The real store's contract (accounts.mjs markNeedsLogin): written through,
  // and \`changed\` only when the slot did not already carry a flag, which is
  // what the host keys its one notice on. accounts.test.mjs holds the real
  // store to the same contract.
  markNeedsLogin: (name, reason) => {
    flagged.push({ name, reason });
    const i = LIST.findIndex((a) => a.name === name);
    if (i === -1) return { ok: false, changed: false, error: 'no slot' };
    if (loginFlag(LIST[i])) return { ok: true, changed: false };
    LIST[i] = { ...LIST[i], needsLogin: { reason, at: new Date(Date.now()).toISOString(), fingerprint: 'fp' } };
    return { ok: true, changed: true };
  },
  markLimited: (name, resetsAt, opts) => {
    marked.push({ name, resetsAt, source: opts?.source || null });
    // Written through, so the selector's next pass and earliestReset see it,
    // exactly as the real store does.
    const i = LIST.findIndex((a) => a.name === name);
    if (i >= 0) LIST[i] = { ...LIST[i], limitedUntil: Number(resetsAt) || null, limitedSource: opts?.source || LIST[i].limitedSource || null, limitedVerifiedAt: new Date(Date.now()).toISOString() };
    return { ok: true };
  },
  // The same three fields the real clearLimit nulls, written through.
  clearLimit: (name) => {
    clearedNames.push(name);
    const i = LIST.findIndex((a) => a.name === name);
    if (i === -1) return { ok: false, error: 'no slot' };
    LIST[i] = { ...LIST[i], limitedUntil: null, limitedSource: null, limitedVerifiedAt: null };
    return { ok: true };
  },
  nextAvailable: () => NEXT,
  // Written through on success, so a later resolveActive names the new login.
  // The real store's two refusals: a keychain that says no, and (with
  // refuseFlagged) a target flagged as needing a login, after waiting for the
  // target's refresh flight (\`swapWait\` stands in for it).
  swapTo: async (name, opts = {}) => {
    CALLS.push({ swapTo: name, refuseFlagged: !!opts.refuseFlagged });
    if (swapWait) await swapWait;
    if (opts.refuseFlagged && loginFlag(LIST.find((a) => a.name === name))) {
      return { ok: false, needsLogin: true, error: \`slot "\${name}" needs a fresh login\` };
    }
    if (swapOk) ACTIVE = name;
    return swapOk ? { ok: true } : { ok: false, error: 'keychain said no' };
  },
  describeUnclaimed: () => null,
  earliestReset: () => earliestResetReal(LIST, Date.now()),
};
export let ALL_SNAPSHOT = null;
// A probe that waits on a promise the test releases, so a sweep can be caught
// mid-flight deterministically (microtasks drain before the test's next
// macrotask; no wall-clock race).
export let probeGate = null;
export const setProbeGate = (p) => { probeGate = p; };
export const setAll = (v) => { ALL_SNAPSHOT = v; };
// The /account view's renderers, reduced to what the test reads: which account
// the view names as live, the ledger it shows, and the keyboard's live name.
const renderAccountList = ({ rows, live }) => JSON.stringify({ live: live?.name || null, rows: rows.map((r) => [r.name, r.limited]) });
const tightenAccountView = (t) => t;
const buildAccountKeyboard = (rows, { activeName }) => ({ activeName, needsLogin: rows.filter((r) => r.needsLogin).map((r) => r.name) });
const codexAccount = { snapshot: async () => null };
const codexAccountBlock = () => '';
const codexFallbackOn = () => false;
const codexSettingsNow = () => ({});
const unclaimedLine = () => null;
const NO_ACCOUNTS_VIEW = 'no accounts';
const accountUsage = {
  activeOnly: async () => {
    CALLS.push({ activeOnly: true });
    if (usageThrows) throw new Error('usage API unreachable');
    if (usageHangs) return new Promise(() => {});
    return { active: {}, row: USAGE_ROW };
  },
  // The /account view's reads (renderAccountView).
  all: async () => ALL_SNAPSHOT,
  resolveActive: async () => ({ name: ACTIVE }),
  one: async (name) => {
    probeCalls.push(name);
    if (probeGate) await probeGate;
    if (probeThrows) throw new Error('usage API unreachable');
    if (probeHangs) return new Promise(() => {});
    return PROBES[name] ?? null;
  },
};
export let ACTIVE = 'a@example.com';
export const setActive = (v) => { ACTIVE = v; };
export let probeThrows = false;
export const setProbeThrows = (v) => { probeThrows = v; };
export let probeHangs = false;
export const setProbeHangs = (v) => { probeHangs = v; };
// What armWallResume would wake, stubbed: the hold and the release belong to
// bg-notify.test.mjs and bg-codex-wiring.test.mjs, which own the drain and the
// chat lane. Here they only have to exist.
const parkedWalledChats = [];
const parkedWalledJobs = [];
export const FLUSHES = [];
// The chat flush's CONTRACT with the lift (bridge.mjs flushParkedWalledChats:
// the note folds in front of the first chat-lane message and it returns
// { count, folded }); the real function's fold is asserted against the real
// dispatch in bg-codex-wiring.test.mjs.
export const PARKED_CHATS = [];
const flushParkedWalledChats = ({ fold = null } = {}) => {
  FLUSHES.push('chats');
  const items = PARKED_CHATS.splice(0);
  let folded = false;
  for (const it of items) {
    const note = fold && !folded && !it.heldOnBg && !LANES.main.current ? fold(items.length) : null;
    if (note) folded = true;
    dispatchPrompt(it.text, it.heldOnBg ? { isBg: true } : LANES.main, { allowCodexFallback: true, prepend: note });
  }
  return { count: items.length, folded };
};
const flushParkedWalledJobs = () => { FLUSHES.push('jobs'); };
export let CODEX_PARKED = 0;
export const setCodexParked = (n) => { CODEX_PARKED = n; };
const flushParkedCodexChats = ({ fold = null } = {}) => {
  if (!CODEX_PARKED) return false;
  CODEX_PARKED = 0;
  dispatchPrompt((fold ? fold + '\\n\\n' : '') + 'CODEX-CATCH-UP', LANES.main, { priority: true });
  return true;
};
const readHeldBgJobs = () => [];
export const RENDERS = [];
let wallResumeTimer = null;
// The REAL body (the .catch matters: it is what makes a rejecting API resolve
// to the fallback rather than throw), with a short fuse so the hang case does
// not hold the suite up for six seconds.
const withDeadline = (p, ms, fallback = null) =>
  Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), 20))]);

// Rendered once at raise, so a test can read the notice's text.
const raiseWall = async (kind, cfg) => { CALLS.push({ raiseWall: kind }); RENDERS.push(cfg?.render ? cfg.render() : null); };
const limitWallResolved = () => 'resolved';
const fmtUntil = () => 'a clock';
const OWNER_TZ = 'America/Toronto';
const codexTakingChat = () => false;
const parkedCodexChats = [];
// /usage (gatherUsage), reduced to the one fact the test reads: which account
// the report names as active.
export const USAGE_REPLIES = [];
const pendingMessage = async () => ({ settle: async (t) => { USAGE_REPLIES.push(t); }, fail: async (w, m) => { USAGE_REPLIES.push('FAIL ' + m); } });
const renderUsageReport = (snap) => 'Active: ' + (snap.active?.name || 'none');
const CODEX_AVAILABLE = false;
const bgLaneEngine = () => 'claude';
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        grab('usageResetFor'),
        grab('logAccountDecision'),
        grab('flagNeedsLogin'),
        grab('flagLoginsFromRows'),
        grab('pickHealthyAccount'),
        grab('claudeWallFacts'),
        grab('raiseClaudeWall'),
        grab('armWallResume'),
        grab('rotateOffLimitedAccount'),
        grab('sweepWalledActiveAccount'),
        grab('recheckDuringWall'),
        grab('kickWalledSweep'),
        grab('clearLimitsFromRows'),
        grab('renderAccountView'),
        grab('claudeRunInFlight'),
        grab('gatherUsage'),
        grab('moveLoginToNextAtWall'),
        grab('wallWakeDue'),
        grab('wallVouched'),
        grab('ledgerAllWalled'),
        grab('WALL_LIFT_SWEEP_WAIT_MS', 'const'),
        grab('liftClaudeWall'),
        grab('ownerLiftedWall'),
        'export { flagNeedsLogin, flagLoginsFromRows, ledgerAllWalled, usageResetFor, pickHealthyAccount, rotateOffLimitedAccount, claudeWallFacts, sweepWalledActiveAccount, recheckDuringWall, kickWalledSweep, clearLimitsFromRows, renderAccountView, gatherUsage, moveLoginToNextAtWall, wallWakeDue, liftClaudeWall, ownerLiftedWall, armWallResume };',
      ].join('\n'),
    )
);

const win = (percent, resetsAt) => ({ percent, resetsAt, severity: null, locked: null });
const row = (usage, name = 'a@example.com') => ({ name, state: 'ok', usage });
// A slot as accounts.json holds one. `limitedUntil` is epoch SECONDS.
const slot = (name, extra = {}) => ({ name, claudeAiOauth: { accessToken: 'a', refreshToken: 'r' }, ...extra });
// The real store on 2026-09-11 12:46 ET: the account that walled, the one that
// had been out of usage credits since the night before with NOTHING in the
// ledger saying so, and a healthy one.
const THREE = () => [
  slot('a@example.com'),
  slot('c@example.com'),
  slot('b@example.com'),
];
// The probe reading of an account with headroom.
const HEALTHY = (name) => row({ fiveHour: win(13, iso(4 * HOUR)), sevenDay: win(18, iso(100 * HOUR)), scoped: [], extraUsage: null }, name);

// ---------------------------------------------------------------------------
console.log('\n1. usageResetFor: which window is the wall');
// ---------------------------------------------------------------------------

B.reset();
B.setUsageRow(
  row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: win(100, iso(50 * HOUR)), scoped: [], extraUsage: null }),
);
await t('the LATEST exhausted window wins, not the soonest', async () => {
  const r = await B.usageResetFor('a@example.com');
  eq(r.resetsAt, Math.floor((NOW + 50 * HOUR) / 1000), 'a 5h window back in 2h is worth nothing under a full week');
  eq(r.guessed, false, 'a reading is not a guess');
});

B.reset();
B.setUsageRow(
  row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: win(40, iso(90 * HOUR)), scoped: [], extraUsage: null }),
);
await t('a window with headroom is ignored however late it resets', async () => {
  const r = await B.usageResetFor('a@example.com');
  eq(r.resetsAt, Math.floor((NOW + 2 * HOUR) / 1000), 'only the exhausted window is the wall');
});

B.reset();
B.setUsageRow(
  row({ fiveHour: win(99, iso(3 * HOUR)), sevenDay: win(96, iso(20 * HOUR)), scoped: [], extraUsage: null }),
);
await t('★ the 95 tier takes the SOONEST reset, not the latest', async () => {
  const r = await B.usageResetFor('a@example.com');
  eq(
    r.resetsAt,
    Math.floor((NOW + 3 * HOUR) / 1000),
    'a 96% weekly window is not known to be the wall: marking the account down for 20h over it is worse than the guess',
  );
});

B.reset();
B.setUsageRow(
  row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: win(96, iso(80 * HOUR)), scoped: [], extraUsage: null }),
);
await t('100 beats 95: a merely-nearly-full window must not extend a real one', async () => {
  const r = await B.usageResetFor('a@example.com');
  eq(r.resetsAt, Math.floor((NOW + 2 * HOUR) / 1000), 'the 96% weekly window is not what walled the account');
});

B.reset();
B.setUsageRow(
  row({
    fiveHour: { percent: 82, resetsAt: iso(4 * HOUR), severity: null, locked: 'weekly_limit_reached' },
    sevenDay: win(70, iso(60 * HOUR)),
    scoped: [],
    extraUsage: null,
  }),
);
await t('★ a locked window is exhausted whatever percent it reports', async () => {
  const r = await B.usageResetFor('a@example.com');
  eq(r.resetsAt, Math.floor((NOW + 4 * HOUR) / 1000), "the server's own reason string beats a rounded percent");
});

B.reset();
B.setUsageRow(
  row({ fiveHour: win(30, iso(2 * HOUR)), sevenDay: win(41, iso(90 * HOUR)), scoped: [], extraUsage: null }),
);
await t('no window near its ceiling yields null, and the guess stands', async () => {
  eq(await B.usageResetFor('a@example.com'), null);
});

B.reset();
B.setUsageRow(row({ fiveHour: win(100, iso(-HOUR)), sevenDay: null, scoped: [], extraUsage: null }));
await t('★ a reset already in the past is refused', async () => {
  eq(
    await B.usageResetFor('a@example.com'),
    null,
    'limitedUntil in the past is not a limit: it would hand the dead account straight back',
  );
});

B.reset();
B.setUsageRow(row({ fiveHour: win(100, iso(9 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'someone-else'));
await t("★ a row for another slot is refused: another account's numbers are not this window", async () => {
  eq(await B.usageResetFor('a@example.com'), null);
});

B.reset();
B.setUsageThrows(true);
await t('an unreachable usage API degrades to null rather than throwing inside a death handler', async () => {
  // withDeadline swallows the rejection into its fallback, so this lands on the
  // !row guard and not in the catch. Asserted as the null it really returns:
  // the earlier version of this test stubbed withDeadline WITHOUT the .catch
  // and then asserted an error log that production never writes.
  eq(await B.usageResetFor('a@example.com'), null);
});

B.reset();
B.setUsageHangs(true);
await t('a hanging usage API is bounded by the deadline, not waited on forever', async () => {
  eq(await B.usageResetFor('a@example.com'), null);
});

B.reset();
B.setUsageRow(row({ fiveHour: win(100, iso(5 * HOUR)), sevenDay: null, scoped: [win(100, iso(30 * HOUR))], extraUsage: null }));
await t('scoped per-model windows count too', async () => {
  const r = await B.usageResetFor('a@example.com');
  eq(r.resetsAt, Math.floor((NOW + 30 * HOUR) / 1000));
});

// ---------------------------------------------------------------------------
console.log('\n2. rotateOffLimitedAccount: the clockless wall end to end');
// ---------------------------------------------------------------------------

B.reset();
B.setList(THREE());
B.setProbes({ 'c@example.com': HEALTHY('c@example.com'), 'b@example.com': HEALTHY('b@example.com') });
B.setUsageRow(row({ fiveHour: win(100, iso(6 * HOUR)), sevenDay: win(100, iso(40 * HOUR)), scoped: [], extraUsage: null }));
let rot = await B.rotateOffLimitedAccount(WALL);
await t('★ the wall with no clock marks the account until the API window, not one hour out', () => {
  eq(rot.outcome, 'swapped');
  eq(B.marked.length, 1, 'exactly one account marked');
  eq(B.marked[0].name, 'a@example.com');
  eq(
    B.marked[0].resetsAt,
    Math.floor((NOW + 40 * HOUR) / 1000),
    'the one-hour guess would have freed it at 20:12 to die on the next message',
  );
  ok(rot.lines.join('\n').includes('read from the usage API'), `the note must name the source:\n${rot.lines.join('\n')}`);
  ok(!rot.lines.join('\n').includes('GUESSED'), 'it is not a guess any more');
  ok(
    B.LOGS.some((l) => l.includes('reset time from the usage API')),
    `the daemon log names the source:\n${B.LOGS.join('\n')}`,
  );
});

B.reset();
B.setList(THREE());
B.setProbes({ 'c@example.com': HEALTHY('c@example.com'), 'b@example.com': HEALTHY('b@example.com') });
B.setUsageRow(row({ fiveHour: win(20, iso(HOUR)), sevenDay: win(30, iso(HOUR)), scoped: [], extraUsage: null }));
rot = await B.rotateOffLimitedAccount(WALL);
await t('when the API cannot better it, the guess still marks and still swaps', () => {
  eq(rot.outcome, 'swapped', 'a rotation is never abandoned over a missing clock');
  eq(B.marked[0].resetsAt, Math.floor(NOW / 1000) + 3600, 'the one-hour fallback');
  ok(rot.lines.join('\n').includes('GUESSED'), 'and says out loud that it guessed');
});

B.reset();
B.setList(THREE());
B.setProbes({ 'c@example.com': HEALTHY('c@example.com'), 'b@example.com': HEALTHY('b@example.com') });
B.setUsageRow(row({ fiveHour: win(100, iso(6 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }));
rot = await B.rotateOffLimitedAccount("You've hit your session limit · resets 6:30pm (America/Caracas)");
await t('★ a wall that DOES carry a clock never asks the usage API', () => {
  ok(!B.CALLS.some((c) => c.activeOnly), 'no network on the common path: the message already said when');
  ok(B.marked[0].resetsAt !== Math.floor((NOW + 6 * HOUR) / 1000), 'the message wins over the API');
  ok(B.LOGS.some((l) => l.includes('reset time from the wall message')), 'and the log says where it came from');
});

B.reset();
// Every other slot already known limited in the ledger: nothing to move to,
// and nothing to probe either.
B.setList([
  slot('a@example.com'),
  slot('c@example.com', { limitedUntil: Math.floor((NOW + 3 * HOUR) / 1000) }),
  slot('b@example.com', { limitedUntil: Math.floor((NOW + 9 * HOUR) / 1000) }),
]);
B.setUsageRow(row({ fiveHour: win(100, iso(6 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }));
rot = await B.rotateOffLimitedAccount(WALL);
await t('the enrichment still runs when nothing is free to swap to', () => {
  eq(rot.outcome, 'exhausted');
  eq(B.marked[0].resetsAt, Math.floor((NOW + 6 * HOUR) / 1000), 'the wall clock has to be right precisely then');
  ok(B.CALLS.some((c) => c.raiseWall === 'claude'), 'and the wall notice goes up');
  // Since 2026-09-30 a held wall is RE-CHECKED when nothing else is free (a
  // paid reset is otherwise invisible until the ledger's clock). Asked once
  // each, rate limited, and with no reading here, never hopped onto.
  eq(B.probeCalls.join(','), B.LIST.slice(1).map((a) => a.name).join(','), 'each held wall is re-checked exactly once');
  // An unreadable re-check is not proof of health, so nothing is hopped onto AS
  // A HEALTHY ACCOUNT. The one move is the wall-time one (2026-09-30): onto
  // the second slot, the walled account that frees first, where the lift will
  // find it.
  eq(B.CALLS.filter((c) => c.swapTo).map((c) => c.swapTo).join(','), B.LIST[1].name, 'only the wall-time move onto the account that frees first (three hours out)');
  // The wall waits for the EARLIEST reset in the ledger, not for the account
  // that just died: it is the first moment anything can run again.
  eq(B.pausedUntil(), NOW + 3 * HOUR, 'three hours out is the first account back');
});

// ---------------------------------------------------------------------------
console.log('\n3. THE 12:46 INCIDENT: the rotation asks before it hops');
// ---------------------------------------------------------------------------
// b@ hit its session limit, the rotation swapped onto a@ (out of
// usage credits since the night before, and NOT walled in the ledger, because
// nothing had died on it yet), the retry died, the chat lane showed the raw
// "You're out of usage credits" card and two workers died the same way.
//
// The live probe of that account, taken the same afternoon, is the fixture
// below: the five hour window EMPTY, the weekly window at 97%, and the wall
// hiding in the per-model weekly scoped row at 100%.

const OUT_OF_CREDITS = (name) =>
  row(
    {
      fiveHour: { percent: 0, resetsAt: null, severity: 'normal', locked: null },
      sevenDay: win(97, iso(12 * HOUR)),
      scoped: [{ label: 'Fable', percent: 100, resetsAt: iso(12 * HOUR) }],
      extraUsage: { enabled: false, percent: 0, usedCredits: 0, monthlyLimit: 50000 },
    },
    name,
  );

B.reset();
B.setActive('b@example.com');
B.setList(THREE());
B.setProbes({
  // rotation order is least-recently-active, and nothing here has ever run, so
  // a@ is asked first: exactly the account the old code hopped onto.
  'a@example.com': OUT_OF_CREDITS('a@example.com'),
  'c@example.com': HEALTHY('c@example.com'),
});
B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: win(54, iso(100 * HOUR)), scoped: [], extraUsage: null }, 'b@example.com'));
rot = await B.rotateOffLimitedAccount(WALL);

await t('★ the out-of-credits account is SKIPPED, not swapped onto', () => {
  eq(rot.outcome, 'swapped');
  eq(rot.nextName, 'c@example.com', 'it kept going until it found one with headroom');
  eq(B.CALLS.filter((c) => c.swapTo).length, 1, 'and only swapped once');
  eq(B.CALLS.find((c) => c.swapTo).swapTo, 'c@example.com');
});

await t('★ the skip is because of the SCOPED window, which the obvious rule misses', () => {
  // fiveHour 0% and sevenDay 97%: a check of "5h or weekly at 100" calls this
  // account healthy and reproduces the incident exactly.
  ok(B.probeCalls.includes('a@example.com'), `it asked: ${B.probeCalls.join(', ')}`);
  const m = B.marked.find((x) => x.name === 'a@example.com');
  ok(m, `the skipped account is walled in the ledger: ${JSON.stringify(B.marked)}`);
  eq(m.resetsAt, Math.floor((NOW + 12 * HOUR) / 1000), 'until the window the API named');
  eq(m.source, 'probe', 'and the ledger records that this wall was learned by asking, not by dying');
});

await t('the decision log names every step', () => {
  const log = B.LOGS.join('\n');
  ok(log.includes('account_walled'), log);
  ok(log.includes('account_selected'), log);
  ok(log.includes('account=c@example.com'), log);
});

await t('the handback note tells M which account was skipped and why', () => {
  const note = rot.lines.join('\n');
  ok(note.includes('Skipped "a@example.com"'), note);
  ok(note.includes('weekly Fable window is spent'), note);
});

// An account the ledger ALREADY knows is walled costs no round trip at all.
B.reset();
B.setActive('b@example.com');
B.setList([
  slot('a@example.com', { limitedUntil: Math.floor((NOW + 12 * HOUR) / 1000) }),
  slot('c@example.com'),
  slot('b@example.com'),
]);
B.setProbes({ 'c@example.com': HEALTHY('c@example.com') });
B.setUsageRow(null);
rot = await B.rotateOffLimitedAccount(WALL);

await t('★ a known-walled account is never probed and never hopped onto', () => {
  eq(rot.nextName, 'c@example.com');
  ok(!B.probeCalls.includes('a@example.com'), `no round trip for a known wall: ${B.probeCalls.join(', ')}`);
  ok(B.LOGS.join('\n').includes('account_skipped_known_walled'), B.LOGS.join('\n'));
});

// EVERY ACCOUNT SPENT: the cycle ends, it does not loop, and the wall clock is
// the earliest of the three.
B.reset();
B.setActive('b@example.com');
B.setList(THREE());
B.setProbes({
  'a@example.com': OUT_OF_CREDITS('a@example.com'),
  'c@example.com': row({ fiveHour: win(100, iso(3 * HOUR)), sevenDay: win(40, iso(90 * HOUR)), scoped: [], extraUsage: null }, 'c@example.com'),
});
B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'b@example.com'));
rot = await B.rotateOffLimitedAccount(WALL);

await t('★ with every account spent it cycles through all of them exactly once, then walls', () => {
  eq(rot.outcome, 'exhausted');
  eq(B.probeCalls.length, 2, `each candidate asked once, never twice: ${B.probeCalls.join(', ')}`);
  eq(new Set(B.probeCalls).size, 2, 'and never the same one twice');
  eq(B.CALLS.filter((c) => c.swapTo).length, 0, 'nothing was swapped onto');
  eq(B.marked.length, 3, 'all three are in the ledger: the one that died and the two that were asked');
  ok(B.LOGS.join('\n').includes('all_accounts_walled_until'), B.LOGS.join('\n'));
  // The wall waits for the soonest of the three, which is the account that
  // just died (two hours), not the twelve-hour weekly window.
  eq(B.pausedUntil(), NOW + 2 * HOUR, 'the first moment anything can run again');
});

// A PROBE THAT CANNOT BE READ IS NOT A WALL. Walling every account on a network
// blip would be worse than the behaviour this replaced.
B.reset();
B.setActive('b@example.com');
B.setList(THREE());
B.setProbeThrows(true);
B.setUsageRow(null);
rot = await B.rotateOffLimitedAccount(WALL);

await t('★ an unreachable usage API takes the candidate anyway, and says so', () => {
  eq(rot.outcome, 'swapped', 'a network blip must not wall a working subscription');
  eq(B.marked.length, 1, 'only the account that actually died is marked');
  ok(B.LOGS.join('\n').includes('account_probe_failed'), B.LOGS.join('\n'));
  ok(rot.lines.join('\n').includes('trying it anyway'), rot.lines.join('\n'));
});

B.reset();
B.setActive('b@example.com');
B.setList(THREE());
B.setProbeHangs(true);
B.setUsageRow(null);
rot = await B.rotateOffLimitedAccount(WALL);

await t('a probe that never answers is deadlined, not waited on', () => {
  eq(rot.outcome, 'swapped');
  ok(PROBE_TIMEOUT_MS <= 5000, `the probe deadline stays at five seconds, not ${PROBE_TIMEOUT_MS}`);
});

// The wall notice's rows come off the ledger.
B.reset();
B.setList([
  slot('a@example.com', { limitedUntil: Math.floor((NOW + 12 * HOUR) / 1000) }),
  slot('c@example.com', { limitedUntil: Math.floor((NOW + 2 * HOUR) / 1000) }),
  slot('b@example.com'),
]);
await t('claudeWallFacts reads the earliest reset and one row per account', () => {
  const f = B.claudeWallFacts(NOW);
  eq(f.rows.length, 3);
  eq(f.earliest, Math.floor((NOW + 2 * HOUR) / 1000), 'the soonest wall, so the clock is the one they wait on');
  eq(f.rows.filter((r) => r.walled).length, 2);
});

// ---------------------------------------------------------------------------
console.log('\n4. A HELD WALL IS RE-CHECKED: the paid reset of 2026-09-30');
// ---------------------------------------------------------------------------
// The user bought a usage reset for two@. /account showed it at 5h 0% and weekly
// 0% and still "limited · 1d 0h": the ledger held its weekly wall, the
// selector skipped it as known walled, and with every account walled nothing
// asked again. Here the rotation, the wall sweep and the display path each
// find the reset on their own, and nothing weaker than the account's own fresh
// reading frees a wall.

const MIN = 60_000;
const OLD_WALL = new Date(NOW - 20 * HOUR).toISOString();
const WEEKLY_WALL = Math.floor((NOW + 22 * HOUR) / 1000);
const walledSlot = (name, extra = {}) => slot(name, { limitedUntil: WEEKLY_WALL, limitedSource: 'probe', limitedVerifiedAt: OLD_WALL, ...extra });
// A lookup row, stamped when it was read, as account-usage.mjs builds one.
const fresh = (usage, name, readAt = NOW - 10_000) => ({ name, state: 'ok', usage, readAt });
const PAID_RESET = (name, readAt) => fresh({ fiveHour: win(0, null), sevenDay: win(0, iso(160 * HOUR)), scoped: [], extraUsage: null }, name, readAt);
const STILL_FULL = (name) => fresh({ fiveHour: win(4, iso(4 * HOUR)), sevenDay: win(99, iso(22 * HOUR)), scoped: [], extraUsage: null }, name);
// Every account walled: the live one (hello@) just died, the other two carry
// the weekly walls the real ledger held that morning.
const ALL_WALLED = () => [
  walledSlot('one@example.com'),
  walledSlot('two@example.com'),
  slot('three@example.com'),
];

B.reset();
B.setActive('three@example.com');
B.setList(ALL_WALLED());
B.setProbes({ 'one@example.com': STILL_FULL('one@example.com'), 'two@example.com': PAID_RESET('two@example.com') });
B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'three@example.com'));
rot = await B.rotateOffLimitedAccount(WALL);
await t('★ ROTATION, every candidate walled: the reset account is re-checked, cleared and swapped onto', () => {
  eq(rot.outcome, 'swapped', 'the wall did not go up over an account with room');
  eq(rot.nextName, 'two@example.com');
  eq(B.clearedNames.join(','), 'two@example.com', 'the ledger wall is lifted through clearLimit');
  ok(!B.CALLS.some((c) => c.raiseWall), 'no wall notice');
  const log = B.LOGS.join('\n');
  ok(
    log.includes('account_limit_cleared_by_probe · account=two@example.com · was_until=') && log.includes('reason=5h 0%, weekly 0%'),
    `the decision line names the account, the wall it lifted and the numbers:\n${log}`,
  );
  ok(log.includes('account_limit_kept · account=one@example.com · until=') && log.includes('weekly window is at 99%'), `a kept wall prints the clock it still holds:\n${log}`);
  ok(rot.lines.join('\n').includes('Re-checked "two@example.com"'), rot.lines.join('\n'));
});

B.reset();
B.setActive('three@example.com');
B.setList(ALL_WALLED());
B.setProbes({ 'one@example.com': STILL_FULL('one@example.com'), 'two@example.com': STILL_FULL('two@example.com') });
B.setUsageRow(null);
rot = await B.rotateOffLimitedAccount(WALL);
await t('★ ROTATION: walled accounts still near their ceiling stay walled and the wall goes up', () => {
  eq(rot.outcome, 'exhausted');
  eq(B.clearedNames.length, 0);
  ok(B.CALLS.some((c) => c.raiseWall === 'claude'));
  eq(B.pausedUntil(), NOW + HOUR, 'the earliest wall: the guessed hour on the account that just died');
});

// THE WALL SWEEP. The wall is up; the sweep runs every minute.
const wallUp = () => {
  B.reset();
  B.setActive('three@example.com');
  B.setList([walledSlot('one@example.com'), walledSlot('two@example.com'), walledSlot('three@example.com')]);
  B.setPausedUntil(NOW + 20 * HOUR);
};

wallUp();
B.setProbes({ 'one@example.com': STILL_FULL('one@example.com'), 'two@example.com': PAID_RESET('two@example.com'), 'three@example.com': STILL_FULL('three@example.com') });
let sw = await B.sweepWalledActiveAccount();
await t('★ WALL UP: the sweep re-checks, clears the reset account, moves the login, lifts the wall, flushes', () => {
  eq(sw.lifted, true, JSON.stringify(sw));
  eq(sw.to, 'two@example.com');
  eq(B.clearedNames.join(','), 'two@example.com');
  eq(B.CALLS.filter((c) => c.swapTo).map((c) => c.swapTo).join(','), 'two@example.com', 'the login moves BEFORE the wall comes down');
  eq(B.pausedUntil(), 0, 'the wall is down');
  eq(B.FLUSHES.join(','), 'chats,jobs', 'and what was parked behind it resumes');
  const log = B.LOGS.join('\n');
  ok(log.includes('account_limit_cleared_by_probe · account=two@example.com'), log);
  ok(log.includes('resume_after_reset · account=two@example.com'), log);
  ok(!log.includes('account_skipped_known_walled'), `the minute sweep does not log a skip line per wall:\n${log}`);
});

wallUp();
B.setProbes({ 'three@example.com': PAID_RESET('three@example.com') });
sw = await B.sweepWalledActiveAccount();
await t('WALL UP: a reset of the LIVE account lifts the wall without a swap', () => {
  eq(sw.lifted, true, JSON.stringify(sw));
  eq(sw.moved, false);
  eq(B.CALLS.filter((c) => c.swapTo).length, 0);
  eq(B.clearedNames.join(','), 'three@example.com');
  eq(B.pausedUntil(), 0);
});

for (const [what, probes, throwsIt] of [
  ['★ WALL UP: a failed probe keeps every wall', {}, true],
  ['★ WALL UP: an unreadable probe keeps every wall', {}, false],
  ["★ WALL UP: another slot's clean row keeps the wall", { 'two@example.com': PAID_RESET('one@example.com') }, false],
  ['★ WALL UP: a stale clean row keeps the wall', { 'two@example.com': PAID_RESET('two@example.com', NOW - 10 * MIN) }, false],
  ['★ WALL UP: 99% keeps the wall', { 'two@example.com': STILL_FULL('two@example.com') }, false],
]) {
  wallUp();
  B.setProbes(probes);
  B.setProbeThrows(throwsIt);
  sw = await B.sweepWalledActiveAccount();
  await t(what, () => {
    eq(B.clearedNames.length, 0, 'nothing cleared');
    eq(B.CALLS.filter((c) => c.swapTo).length, 0, 'nothing swapped');
    eq(B.pausedUntil(), NOW + 20 * HOUR, 'the wall stays up');
    eq(B.FLUSHES.length, 0, 'nothing parked resumes');
    eq(B.probeCalls.length, 3, `each walled account was asked once: ${B.probeCalls.join(', ')}`);
  });
}

wallUp();
B.setProbes({ 'two@example.com': STILL_FULL('two@example.com') });
await B.sweepWalledActiveAccount();
const firstPass = B.probeCalls.length;
await B.sweepWalledActiveAccount(); // the next minute
await B.sweepWalledActiveAccount();
const heldPasses = B.probeCalls.length;
// Date is one global across modules, so this moves the harness clock too.
Date.now = () => NOW + 5 * MIN;
await B.sweepWalledActiveAccount();
const afterInterval = B.probeCalls.length;
Date.now = () => NOW;
await t('★ WALL UP: the rate limit holds, a sweep a minute is not a probe a minute', () => {
  eq(firstPass, 3, 'the first sweep asks each walled account once');
  eq(heldPasses, 3, `two more sweeps inside five minutes asked again: ${B.probeCalls.join(', ')}`);
  eq(afterInterval, 6, 'five minutes on, each walled account is asked again');
});

wallUp();
B.setConfigWall(NOW + 20 * HOUR);
B.setProbes({ 'two@example.com': PAID_RESET('two@example.com') });
sw = await B.sweepWalledActiveAccount();
await t('a REHEARSAL wall seeded from config is never re-checked away', () => {
  eq(B.probeCalls.length, 0, 'no probe');
  eq(B.pausedUntil(), NOW + 20 * HOUR);
});

wallUp();
B.LANES.main.current = { run: 'in flight' };
B.setProbes({ 'two@example.com': PAID_RESET('two@example.com') });
sw = await B.sweepWalledActiveAccount();
await t('WALL UP with a run in flight: the clear lands, the swap and the lift wait for the next sweep', () => {
  eq(B.clearedNames.join(','), 'two@example.com', 'the evidence is not thrown away');
  eq(B.CALLS.filter((c) => c.swapTo).length, 0, 'no swap under a live run');
  eq(B.pausedUntil(), NOW + 20 * HOUR, 'and no parked message resumes on a walled login');
});
B.LANES.main.current = null;
B.probeCalls.length = 0;
sw = await B.sweepWalledActiveAccount();
await t('...and the next sweep finishes it from the ledger, with no re-check needed', () => {
  eq(sw.lifted, true, JSON.stringify(sw));
  eq(sw.to, 'two@example.com');
  eq(B.pausedUntil(), 0);
  eq(B.probeCalls.join(','), 'two@example.com', 'the now-free account is verified once before it is used');
});

// THE DISPLAY PATH: /account and /usage already read every slot.
B.reset();
B.setList([walledSlot('two@example.com'), walledSlot('one@example.com'), slot('three@example.com')]);
let cleared = B.clearLimitsFromRows(
  [PAID_RESET('two@example.com'), STILL_FULL('one@example.com'), PAID_RESET('three@example.com')],
  { via: '/account' },
);
await t('★ /account: a walled slot whose own fresh row reads 0% is cleared, with a decision line', () => {
  eq(cleared.join(','), 'two@example.com', 'the 99% one stays walled, and the free one needs nothing');
  eq(B.clearedNames.join(','), 'two@example.com');
  const line = B.LOGS.find((l) => l.includes('account_limit_cleared_by_probe'));
  ok(line, B.LOGS.join('\n'));
  ok(line.includes('account=two@example.com') && line.includes('via=/account') && line.includes('reason=5h 0%, weekly 0%'), line);
  ok(line.includes(`was_until=${new Date(WEEKLY_WALL * 1000).toISOString()}`), line);
  eq(B.probeCalls.length, 0, 'the display path spends no extra probe');
});

for (const [what, rows] of [
  ['★ /account: a failed lookup row keeps the wall', [{ name: 'two@example.com', state: 'unavailable', error: 'usage unavailable (HTTP 429)', usage: null }]],
  ['★ /account: a live session (stream) reading keeps the wall', [{ name: 'two@example.com', state: 'ok', usage: PAID_RESET('x').usage, source: { kind: 'stream', at: NOW - 5_000 } }]],
  ['★ /account: a stale row keeps the wall', [PAID_RESET('two@example.com', NOW - 10 * MIN)]],
  ['★ /account: a window near its ceiling keeps the wall', [STILL_FULL('two@example.com')]],
  ['/account: no rows at all (the API timed out)', null],
]) {
  B.reset();
  B.setList([walledSlot('two@example.com')]);
  cleared = B.clearLimitsFromRows(rows, { via: '/account' });
  await t(what, () => {
    eq(cleared.length, 0);
    eq(B.clearedNames.length, 0);
  });
}

B.reset();
B.setList([walledSlot('two@example.com', { limitedVerifiedAt: new Date(NOW - 2 * MIN).toISOString() })]);
cleared = B.clearLimitsFromRows([PAID_RESET('two@example.com')], { via: '/account' });
await t('/account: a wall set two minutes ago is not cleared by any reading', () => {
  eq(cleared.length, 0, 'the death is fresher evidence than a window that cannot see why it died');
});

wallUp();
B.setProbes({ 'two@example.com': PAID_RESET('two@example.com') });
cleared = B.clearLimitsFromRows([PAID_RESET('two@example.com')], { via: '/account' });
await B.settle();
await t('★ /account DURING A WALL: the clear kicks the sweep, which moves the login and lifts the wall', () => {
  eq(cleared.join(','), 'two@example.com');
  eq(B.CALLS.filter((c) => c.swapTo).map((c) => c.swapTo).join(','), 'two@example.com');
  eq(B.pausedUntil(), 0, 'not a minute later: now');
  eq(B.FLUSHES.join(','), 'chats,jobs');
});

wallUp();
B.setProbes({ 'two@example.com': PAID_RESET('two@example.com') });
B.setAll({
  active: { name: 'three@example.com' },
  rows: [PAID_RESET('two@example.com'), STILL_FULL('one@example.com'), STILL_FULL('three@example.com')],
});
const view = await B.renderAccountView();
await t('★ the /account VIEW during a wall names the account the login moved to, not the walled one it left', () => {
  const body = JSON.parse(view.text);
  eq(body.live, 'two@example.com', `the view named the old login: ${view.text}`);
  eq(view.markup.activeName, 'two@example.com', 'and the keyboard would offer a swap to where the login already is');
  ok(body.rows.some(([n, limited]) => n === 'two@example.com' && limited === false), `the ledger shown still walls it: ${view.text}`);
  eq(B.pausedUntil(), 0, 'the wall came down before the reply rendered');
});

wallUp();
B.USAGE_REPLIES.length = 0;
B.setProbes({ 'two@example.com': PAID_RESET('two@example.com') });
B.setAll({
  active: { name: 'three@example.com' },
  rows: [PAID_RESET('two@example.com'), STILL_FULL('one@example.com'), STILL_FULL('three@example.com')],
});
await B.gatherUsage();
await t('★ /usage during a wall names the account the login moved to, not the walled one it left', () => {
  eq(B.USAGE_REPLIES.join(' | '), 'Active: two@example.com');
  eq(B.pausedUntil(), 0, 'the wall came down before the reply rendered');
});

wallUp();
// two@ was re-checked a moment ago (slot spent), so the minute sweep that is
// already running skips it and finds nothing; the /account clear lands while
// that sweep is mid-probe.
B.limitRecheck.take('two@example.com', NOW);
B.setProbes({
  'one@example.com': STILL_FULL('one@example.com'),
  'three@example.com': STILL_FULL('three@example.com'),
  'two@example.com': PAID_RESET('two@example.com'),
});
let openGate;
B.setProbeGate(new Promise((r) => { openGate = r; }));
const inFlight = B.kickWalledSweep();
await new Promise((r) => setImmediate(r)); // the sweep has read the ledger and is parked on its first probe
cleared = B.clearLimitsFromRows([PAID_RESET('two@example.com')], { via: '/account' });
B.setProbeGate(null);
openGate();
const firstResult = await inFlight;
await B.settle();
await t('★ a clear during an in-flight sweep QUEUES a fresh sweep instead of riding the stale one', () => {
  eq(cleared.join(','), 'two@example.com');
  eq(firstResult.lifted, undefined, `the in-flight sweep chose before the clear: ${JSON.stringify(firstResult)}`);
  eq(B.pausedUntil(), 0, 'the queued sweep saw the clear and lifted the wall');
  eq(B.CALLS.filter((c) => c.swapTo).map((c) => c.swapTo).join(','), 'two@example.com');
});

wallUp();
B.LANES.main.current = { engine: 'codex' }; // the Codex fallback answering chat during the wall
B.setProbes({ 'two@example.com': PAID_RESET('two@example.com') });
sw = await B.sweepWalledActiveAccount();
await t('★ WALL UP: a Codex turn in flight does not hold the lift (it never touches a Claude login)', () => {
  eq(sw.lifted, true, JSON.stringify(sw));
  eq(B.CALLS.filter((c) => c.swapTo).map((c) => c.swapTo).join(','), 'two@example.com');
  eq(B.pausedUntil(), 0);
});

wallUp();
// two@ is already free in the ledger (a clear landed), nothing walled is due
// for its re-check, and a CLAUDE run is in flight: nothing to do but wait.
B.setList([walledSlot('one@example.com'), slot('two@example.com'), walledSlot('three@example.com')]);
B.limitRecheck.take('one@example.com', NOW);
B.limitRecheck.take('three@example.com', NOW);
B.LANES.main.current = { run: 'claude' };
B.setProbes({ 'two@example.com': PAID_RESET('two@example.com') });
sw = await B.sweepWalledActiveAccount();
await t('WALL UP, a free account waiting on a Claude run: no probe every minute while it waits', () => {
  eq(B.probeCalls.length, 0, `probed while nothing could move: ${B.probeCalls.join(', ')}`);
  eq(B.pausedUntil(), NOW + 20 * HOUR);
});
B.LANES.main.current = null;

// ---------------------------------------------------------------------------
console.log('\n5. AN ALL-ACCOUNTS WALL: switch to the next account, wake the chat at the lift');
// ---------------------------------------------------------------------------
// 2026-09-30 10:54 ET every account walled. The login stayed on the walled
// two@; at 16:30Z the timer swapped and flushed, and the chat woke only because a
// capped handback chain happened to be waiting. The ask: "find out which one is
// the next account ... switch to it, and ... trigger at the time that it's
// available, a message to you that the usage is back so you can pick up".

// three@ (live) dies with a clock the usage API supplies (two hours). one@
// is walled for ONE hour with a known clock; two@ is walled for THIRTY MINUTES
// on a guess. The next account is one@: never a guess over a known clock.
const ONE_H = Math.floor((NOW + HOUR) / 1000);
const HALF_H = Math.floor((NOW + 30 * MIN) / 1000);
const nextSetup = () => {
  B.reset();
  B.setActive('three@example.com');
  B.setList([
    walledSlot('one@example.com', { limitedUntil: ONE_H, limitedSource: 'probe' }),
    walledSlot('two@example.com', { limitedUntil: HALF_H, limitedSource: 'probe (no reset clock)' }),
    slot('three@example.com'),
  ]);
  B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'three@example.com'));
};
const swaps = () => B.CALLS.filter((c) => c.swapTo).map((c) => c.swapTo).join(',');
const mainTurns = () => B.DISPATCHED.filter((d) => d.lane === 'main');

nextSetup();
rot = await B.rotateOffLimitedAccount(WALL);
await t('★ WALL TIME, nothing in flight: the login moves to the EARLIEST KNOWN reset, logged', () => {
  eq(rot.outcome, 'exhausted');
  eq(swaps(), 'one@example.com', 'not two@, whose thirty minutes is a guess');
  const log = B.LOGS.join('\n');
  ok(
    log.includes(`wall_next_account_selected · account=one@example.com · until=${new Date(ONE_H * 1000).toISOString()}`),
    `the decision line names the account and its reset:\n${log}`,
  );
  eq(B.wallWake.current().movedTo, 'one@example.com', 'the episode remembers where the login went');
  ok(rot.lines.join('\n').includes('Moved the login to "one@example.com"'), rot.lines.join('\n'));
});
await t('★ the wall notice names the next account, its reset, and that the login is already there', () => {
  const text = B.RENDERS.filter(Boolean).pop() || '';
  ok(text.includes('🔜 Next · one@example.com'), text);
  ok(text.includes('Resets a clock'), text);
  ok(text.includes('Login already on it · I pick up then'), text);
});

nextSetup();
B.LANES.main.current = { run: 'claude' }; // another Claude turn is still on the walled login
rot = await B.rotateOffLimitedAccount(WALL);
await t('★ WALL TIME, a Claude run in flight: no swap under it', () => {
  eq(rot.outcome, 'exhausted');
  eq(swaps(), '', 'swapping under a live run is the residual race');
  ok(!B.LOGS.join('\n').includes('wall_next_account_selected'), 'and no selection is claimed');
  const text = B.RENDERS.filter(Boolean).pop() || '';
  ok(text.includes('I switch to it and pick up then'), text);
});
B.LANES.main.current = null;
let wsw = await B.sweepWalledActiveAccount();
await t('★ ...and the first idle sweep of the wall makes the move', () => {
  eq(wsw.movedToNext, 'one@example.com', JSON.stringify(wsw));
  eq(swaps(), 'one@example.com');
  eq(B.pausedUntil() > NOW, true, 'the wall itself stays up');
});
wsw = await B.sweepWalledActiveAccount();
await t('the move is made once per wall, not every minute', () => {
  eq(swaps(), 'one@example.com', 'no second swap');
});

nextSetup();
// one@ is live and dies with a two hour clock; two@ is on a guess and
// three@ is five hours out, so the next account is the one already live.
B.setList([
  slot('one@example.com'),
  walledSlot('two@example.com', { limitedUntil: HALF_H, limitedSource: 'probe (no reset clock)' }),
  walledSlot('three@example.com', { limitedUntil: Math.floor((NOW + 5 * HOUR) / 1000), limitedSource: 'probe' }),
]);
B.setActive('one@example.com');
B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'one@example.com'));
rot = await B.rotateOffLimitedAccount(WALL);
await t('the next account already live: no swap, and the notice still says so', () => {
  eq(rot.outcome, 'exhausted');
  eq(swaps(), '');
  ok(B.LOGS.join('\n').includes('wall_next_account_selected · account=one@example.com'), B.LOGS.join('\n'));
  ok((B.RENDERS.filter(Boolean).pop() || '').includes('Login already on it'), B.RENDERS.join('\n'));
});

// THE LIFT. The wall from the first setup, at its reset: one@'s clock
// has passed (the ledger shows it free) and so has the wall's.
const toTheReset = () => {
  B.setPausedUntil(NOW - 1000);
  B.setList([
    slot('one@example.com'),
    walledSlot('two@example.com', { limitedUntil: Math.floor((NOW + 5 * HOUR) / 1000) }),
    walledSlot('three@example.com', { limitedUntil: Math.floor((NOW + 2 * HOUR) / 1000) }),
  ]);
};
nextSetup();
await B.rotateOffLimitedAccount(WALL);
B.wallWake.worker({ runId: 'bg39-1790775701643', title: 'Re-check walled accounts', status: 'died on a session limit', report: '/bridge/bg-reports/bg39-1790775701643.md', draft: '/bridge/bg-reports/bg39-1790775701643.draft.md', died: true, handback: 'held' });
toTheReset();
B.DISPATCHED.length = 0;
let lift = await B.liftClaudeWall('reset', { sweep: true });
await t('★ THE LIFT, nothing parked: exactly ONE daemon-authored wake-up turn in the chat lane', () => {
  eq(mainTurns().length, 1, JSON.stringify(B.DISPATCHED.map((d) => d.text.slice(0, 60))));
  const w = mainTurns()[0];
  eq(w.priority, true, 'priority: queued behind a running turn, never dropped');
  ok(w.text.startsWith('[Bridge wake-up, daemon authored, not the owner.'), w.text.slice(0, 120));
  ok(w.text.includes('Live account: one@example.com'), w.text);
  ok(w.text.includes('node /bridge/bg.mjs ps'), 'the pick-up starts with the worker list');
  eq(lift.carrier, 'its own turn');
  eq(B.FLUSHES.join(','), 'chats,jobs', 'after the parked chats and jobs flushed');
  ok(B.LOGS.join('\n').includes('wall_wake_up · account=one@example.com'), B.LOGS.join('\n'));
});
await t('★ the wake-up lists the worker that died on the wall, its report, its draft and its undelivered handback', () => {
  const text = mainTurns()[0].text;
  ok(text.includes('bg39-1790775701643 · Re-check walled accounts'), text);
  ok(text.includes('report: /bridge/bg-reports/bg39-1790775701643.md'), text);
  ok(text.includes('draft: /bridge/bg-reports/bg39-1790775701643.draft.md'), text);
  ok(text.includes('handback: NOT delivered before now'), text);
});
lift = await B.liftClaudeWall('poll', { sweep: true });
await t('★ a second lift of the same wall does not wake the chat twice', () => {
  eq(mainTurns().length, 1);
  eq(lift, null);
});

// A parked chat in the same lift: the note rides in front of it. One turn.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
toTheReset();
B.DISPATCHED.length = 0;
B.PARKED_CHATS.push({ text: 'is claude back?' });
lift = await B.liftClaudeWall('reset', { sweep: true });
await t('★ a parked chat in the lift: NO second turn, the wake-up rides in front of the parked message', () => {
  eq(mainTurns().length, 1, JSON.stringify(B.DISPATCHED.map((d) => d.text)));
  eq(mainTurns()[0].text, 'is claude back?');
  ok(String(mainTurns()[0].prepend).startsWith('[Bridge wake-up'), String(mainTurns()[0].prepend).slice(0, 80));
  ok(String(mainTurns()[0].prepend).includes("Then answer the owner's message below."), 'and it says the message follows');
  eq(lift.carrier, 'a parked chat message');
});

// The capped handback chain's reports in the same lift: folded, one turn.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
toTheReset();
B.DISPATCHED.length = 0;
B.parkedHandbacks.push({ task: 'the reels batch', status: 'finished', report: '/bridge/bg-reports/bg12.md', flag: null });
B.setChain({ handbackStreak: 7, handbackCapNotified: true, lastParkedAt: NOW - MIN });
lift = await B.liftClaudeWall('reset', { sweep: true });
await t('★ a handback held by the cap in the lift: folded into the ONE wake-up turn, not delivered again later', () => {
  eq(mainTurns().length, 1);
  ok(mainTurns()[0].text.includes('full report: /bridge/bg-reports/bg12.md'), mainTurns()[0].text);
  eq(B.parkedHandbacks.length, 0, 'the auto-resume has nothing left to deliver a second time');
  eq(B.chainState().handbackStreak, 0, 'the chain resumed, as flushParkedHandbacks would');
});

// The Codex catch-up in the same lift: the note rides in front of it.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
toTheReset();
B.DISPATCHED.length = 0;
B.setCodexParked(2);
lift = await B.liftClaudeWall('reset', { sweep: true });
await t('a Codex catch-up in the lift carries the wake-up: one turn', () => {
  eq(mainTurns().length, 1);
  ok(mainTurns()[0].text.startsWith('[Bridge wake-up') && mainTurns()[0].text.endsWith('CODEX-CATCH-UP'), mainTurns()[0].text.slice(-80));
  eq(lift.carrier, 'the Codex catch-up');
});

// THE EARLY RE-CHECK LIFT (Part 1's path) wakes the chat too.
wallUp();
B.wallWake.raised({ until: NOW + 20 * HOUR, now: NOW });
B.setProbes({ 'one@example.com': STILL_FULL('one@example.com'), 'two@example.com': PAID_RESET('two@example.com'), 'three@example.com': STILL_FULL('three@example.com') });
wsw = await B.sweepWalledActiveAccount();
await B.settle();
await t('★ an EARLY re-check lift wakes the chat, naming the account it moved to', () => {
  eq(wsw.lifted, true, JSON.stringify(wsw));
  eq(mainTurns().length, 1, JSON.stringify(B.DISPATCHED.map((d) => d.text.slice(0, 60))));
  ok(mainTurns()[0].text.includes('Live account: two@example.com, live since'), mainTurns()[0].text);
});
lift = await B.liftClaudeWall('poll', { sweep: true });
await t('...and the poll backstop after it does not wake the chat again', () => {
  eq(mainTurns().length, 1);
});

// A /account clear during the wall lifts through the same re-check.
wallUp();
B.wallWake.raised({ until: NOW + 20 * HOUR, now: NOW });
B.setProbes({ 'two@example.com': PAID_RESET('two@example.com') });
B.clearLimitsFromRows([PAID_RESET('two@example.com')], { via: '/account' });
await B.settle();
await t('★ a /account clear during the wall lifts it and wakes the chat once', () => {
  eq(B.pausedUntil(), 0);
  eq(mainTurns().length, 1, JSON.stringify(B.DISPATCHED.map((d) => d.text.slice(0, 60))));
});

// With NO wall episode (a rehearsal wall, or a test seeding the wall by hand)
// a lift is the two flushes it always was.
wallUp();
B.setProbes({ 'two@example.com': PAID_RESET('two@example.com') });
wsw = await B.sweepWalledActiveAccount();
await t('no wall episode: the lift flushes and wakes nobody', () => {
  eq(wsw.lifted, true);
  eq(B.DISPATCHED.length, 0);
  eq(B.FLUSHES.join(','), 'chats,jobs');
});

// A DAEMON RESTART MID WALL. The wall was in memory and is gone; the episode is
// on disk. No wake-up while the ledger still walls everything, one at the
// reset, and none again after a second restart.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
B.restartWallWake();
B.setPausedUntil(0); // the restart forgot the wall
B.DISPATCHED.length = 0;
await t('★ RESTART mid wall: nothing wakes the chat while every account is still walled', () => {
  eq(B.wallWake.pending(), true, 'the episode survived the restart');
  eq(B.wallWakeDue(), false, 'the ledger still walls every account');
});
toTheReset();
B.setPausedUntil(0);
lift = await B.liftClaudeWall('poll', { sweep: true });
await t('★ ...and the chat is woken ONCE when an account frees', () => {
  eq(mainTurns().length, 1);
  ok(mainTurns()[0].text.startsWith('[Bridge wake-up'));
});
B.restartWallWake();
lift = await B.liftClaudeWall('poll', { sweep: true });
await t('★ a restart after the wake-up does not wake the chat again', () => {
  eq(mainTurns().length, 1);
  eq(B.wallWake.pending(), false);
});

// The lift only wakes the chat onto an account the ledger shows free: a wall whose
// clock passed while every account is walled again (a reset that was wrong)
// is not a lift.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
B.setPausedUntil(NOW - 1000);
B.DISPATCHED.length = 0;
lift = await B.liftClaudeWall('reset', { sweep: true });
await t('a passed wall clock with every account still walled flushes but does not wake', () => {
  eq(mainTurns().length, 0);
  eq(B.wallWake.pending(), true, 'the wake-up is still owed, for the real lift');
});

// QA 2026-09-30 round 1. The wall's clock is the earliest reset INCLUDING a
// guess, while the login moved to the earliest KNOWN one. At the guessed clock
// the login is on an account still walled, and the Codex fallback is what is
// running: the lift must still move the login (a Codex run never touches a
// Claude login), and must never wake the chat onto a walled login.
const toTheGuess = () => {
  B.setPausedUntil(NOW - 1000);
  B.setCooldownUntil(0);
  B.setList([
    walledSlot('one@example.com', { limitedUntil: ONE_H, limitedSource: 'probe' }),
    slot('two@example.com'), // its guessed thirty minutes have passed
    walledSlot('three@example.com', { limitedUntil: Math.floor((NOW + 2 * HOUR) / 1000) }),
  ]);
};
nextSetup();
await B.rotateOffLimitedAccount(WALL); // the login moves to one@ (known, one hour)
toTheGuess();
B.LANES.main.current = { engine: 'codex' };
B.setProbes({ 'two@example.com': HEALTHY('two@example.com') });
B.DISPATCHED.length = 0;
lift = await B.liftClaudeWall('reset', { sweep: true });
await t('★ LIFT AT A GUESSED CLOCK with a Codex run in flight: the login moves to the freed account, then the chat wakes on it', () => {
  eq(swaps(), 'one@example.com,two@example.com', 'the wall-time move, then the lift move');
  eq(mainTurns().length, 1);
  ok(mainTurns()[0].text.includes('Live account: two@example.com'), mainTurns()[0].text);
});
B.LANES.main.current = null;

nextSetup();
await B.rotateOffLimitedAccount(WALL);
toTheGuess();
B.setProbes({ 'two@example.com': row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'two@example.com') }); // the guess was wrong
B.DISPATCHED.length = 0;
lift = await B.liftClaudeWall('reset', { sweep: true });
await t('★ ...and when the freed account turns out still walled, NO wake-up onto the walled login', () => {
  eq(mainTurns().length, 0, 'a priority wake turn on a walled login dies unretried');
  eq(B.wallWake.pending(), true, 'still owed, for the real lift');
  eq(B.FLUSHES.join(','), 'chats,jobs', 'the flushes run as always');
});

// The sweep cannot move the login this minute (a rotation's cooldown, or a
// Claude run in flight) while another account is free: still no wake-up onto
// the walled login; the poll loop tries again next cycle.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
toTheGuess();
B.setCooldownUntil(NOW + MIN);
B.setProbes({ 'two@example.com': HEALTHY('two@example.com') });
B.DISPATCHED.length = 0;
lift = await B.liftClaudeWall('reset', { sweep: true });
await t('★ the live login still walled while another account is free: no wake-up yet', () => {
  eq(swaps(), 'one@example.com', 'the cooldown held the lift move');
  eq(mainTurns().length, 0);
  eq(B.wallWake.pending(), true);
});
B.setCooldownUntil(0);
lift = await B.liftClaudeWall('poll', { sweep: true });
await t('...and the next poll moves the login and wakes the chat once', () => {
  eq(swaps(), 'one@example.com,two@example.com');
  eq(mainTurns().length, 1);
});

// A wake-up that dies: the wall goes up again within minutes, and the next
// wake-up still names what the dead one carried.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
B.wallWake.worker({ runId: 'bg39-1790775701643', title: 'Re-check walled accounts', report: '/bridge/bg-reports/bg39.md', died: true, handback: 'held' });
B.parkedHandbacks.push({ task: 'the reels batch', status: 'finished', report: '/bridge/bg-reports/bg12.md', flag: null });
toTheReset();
B.DISPATCHED.length = 0;
await B.liftClaudeWall('reset', { sweep: true });
// The wake turn died on a limit: the next rotation walls everything again.
B.setPausedUntil(0);
B.setCooldownUntil(0);
B.setList(ALL_WALLED().map((a) => ({ ...a, limitedUntil: a.limitedUntil || Math.floor((NOW + 3 * HOUR) / 1000) })));
await B.rotateOffLimitedAccount(WALL);
await t('★ a wall raised right after a wake-up carries its workers and parked reports forward', () => {
  const ep = B.wallWake.current();
  eq(ep.wokeAt, null, 'a new episode, owed a wake-up');
  eq(ep.workers.map((w) => w.runId).join(','), 'bg39-1790775701643');
  eq(ep.carried?.parked?.map((p) => p.report).join(','), '/bridge/bg-reports/bg12.md');
});
B.setList([slot('one@example.com'), walledSlot('two@example.com'), walledSlot('three@example.com')]);
B.setPausedUntil(NOW - 1000);
B.setCooldownUntil(0);
B.setActive('one@example.com');
B.DISPATCHED.length = 0;
await B.liftClaudeWall('reset', { sweep: true });
await t('★ ...and the next wake-up names them again', () => {
  eq(mainTurns().length, 1);
  ok(mainTurns()[0].text.includes('bg39-1790775701643'), mainTurns()[0].text);
  ok(mainTurns()[0].text.includes('full report: /bridge/bg-reports/bg12.md'), mainTurns()[0].text);
});

// QA round 2: a parked chat released into a BUSY chat lane is steered into the
// running turn, which carries no prepend. The lift must then send the wake-up
// as its own priority turn rather than trust a fold that went nowhere.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
B.PARKED_CHATS.push({ text: 'is it back yet' });
toTheReset();
B.LANES.main.current = { engine: 'claude' };
B.DISPATCHED.length = 0;
lift = await B.liftClaudeWall('reset', { sweep: true });
await t('★ a lift into a BUSY chat lane sends the wake-up as its own priority turn, not folded', () => {
  eq(lift?.carrier, 'its own turn', JSON.stringify(lift));
  const wake = mainTurns().filter((d) => d.text.startsWith('[Bridge wake-up'));
  eq(wake.length, 1);
  eq(wake[0].priority, true, 'queued behind the running turn, never dropped');
  eq(mainTurns().find((d) => d.text === 'is it back yet')?.prepend ?? null, null, 'the message carries no note');
});
B.LANES.main.current = null;

// QA round 2: THE USER CHOSE A LOGIN BY HAND during the wall. /account <name>, the
// button and a capture zero the stand-down and touch no ledger row, so the
// ledger still walls everything and nothing would ever claim the wake-up.
nextSetup();
await B.rotateOffLimitedAccount(WALL); // the login moves to one@
B.setPausedUntil(0);
B.setCooldownUntil(0);
B.setActive('two@example.com'); // the user's pick, still walled in the ledger
B.DISPATCHED.length = 0;
await t('before a manual pick counts, the wake-up is not due: the ledger walls every account', () => {
  eq(B.wallWakeDue(), false);
});
await B.ownerLiftedWall('two@example.com');
await B.settle();
await t('★ a MANUAL /account swap during the wall wakes the chat once, on the account picked', () => {
  eq(mainTurns().length, 1, JSON.stringify(B.DISPATCHED.map((d) => d.text.slice(0, 60))));
  ok(mainTurns()[0].text.includes('Live account: two@example.com'), mainTurns()[0].text);
  eq(swaps(), 'one@example.com', 'the lift did not move the login off the manual pick');
  eq(B.wallWake.pending(), false);
  eq(B.wallWake.current().via, 'manual');
});
await B.liftClaudeWall('poll', { sweep: true });
await t('...and the poll after it does not wake the chat again', () => {
  eq(mainTurns().length, 1);
});
B.DISPATCHED.length = 0;
await t('with no wall episode pending a manual swap wakes nobody', async () => {
  eq(await B.ownerLiftedWall('two@example.com'), null);
  eq(B.DISPATCHED.length, 0);
});

// QA round 3: the capped chain is read at the claim, not before the sweep. A
// message typed while the lift awaits flushes the chain itself
// (flushParkedHandbacks('message')); a snapshot taken before that delivered the
// same reports a second time inside the wake-up.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
B.parkedHandbacks.push({ task: 'the reels batch', status: 'finished', report: '/bridge/bg-reports/bg77.md', flag: null });
toTheReset();
B.DISPATCHED.length = 0;
const liftDuringMessage = B.liftClaudeWall('reset', { sweep: true });
// The lift is suspended at its first await; a message is typed now.
const takenByHim = B.parkedHandbacks.splice(0);
B.DISPATCHED.push({ text: 'CHAIN: ' + takenByHim.map((p) => p.report).join(','), lane: 'main', priority: true });
await liftDuringMessage;
await t('★ a message typed during the lift\'s sweep: the capped chain reaches the chat once, not twice', () => {
  eq(takenByHim.length, 1);
  eq(mainTurns().filter((d) => d.text.startsWith('[Bridge wake-up')).length, 1, 'the wake-up still runs');
  eq(mainTurns().filter((d) => d.text.includes('/bridge/bg-reports/bg77.md')).length, 1, JSON.stringify(mainTurns().map((d) => d.text.slice(0, 50))));
});

// QA round 3: an EMPTY ledger (nothing captured, a fresh install) is not an
// all-accounts wall. Reading it as one held every handback forever.
nextSetup();
await B.rotateOffLimitedAccount(WALL);
B.setList([]);
B.setPausedUntil(0);
await t('★ with nothing captured the ledger walls nothing, so the wake-up is due when the wall ends', () => {
  eq(B.wallWake.pending(), true);
  eq(B.wallWakeDue(), true);
});

// ---------------------------------------------------------------------------
console.log('\n6. A DEAD LOGIN: never selected, never moved onto, said once (2026-09-30)');
// ---------------------------------------------------------------------------
// The user captured a fresh login into three@, whose weekly wall the capture kept,
// so the sweep moved off it. Its probe of four@example.com came back "token
// refresh rejected: HTTP 400 (invalid_grant)" (the refresh token a concurrent
// /account read had just spent), and the selector swapped onto it with
// verified=false. The real bridge functions, the real selector and the real
// wall-move rule; the store is the harness's, whose markNeedsLogin keeps the
// real store's contract (accounts.test.mjs holds the real one to it).

const ME = 'four@example.com';
const REFUSED_ROW = (name = ME) => ({
  name,
  state: 'refresh-failed',
  error: 'token refresh rejected: HTTP 400 (invalid_grant)',
  usage: null,
  loginProblem: 'login refused (invalid_grant)',
});
const incidentSetup = () => {
  B.reset();
  B.setActive('three@example.com');
  B.setList([
    walledSlot('one@example.com', { limitedUntil: Math.floor((NOW + 60 * HOUR) / 1000) }),
    slot('two@example.com', { lastActiveAt: new Date(NOW - HOUR).toISOString() }),
    walledSlot('three@example.com', { limitedUntil: Math.floor((NOW + 16 * HOUR) / 1000) }),
    // Least recently active, so the selector asks it FIRST, exactly as at 18:22.
    slot(ME, { lastActiveAt: new Date(NOW - 5 * HOUR).toISOString() }),
  ]);
  B.setProbes({ [ME]: REFUSED_ROW(), 'two@example.com': HEALTHY('two@example.com') });
};
const meRow = () => B.LIST.find((a) => a.name === ME);

incidentSetup();
let swept = await B.sweepWalledActiveAccount();
await t('★ THE 18:22 SWEEP: the refused login is skipped and the login moves to the healthy account', () => {
  eq(swept.moved, true, JSON.stringify(swept));
  eq(swaps(), 'two@example.com', 'the sweep swapped onto the account whose refresh was refused');
  ok(!B.LOGS.some((l) => l.includes(`account_selected · account=${ME}`)), `a dead login was selected:\n${B.LOGS.join('\n')}`);
  ok(B.LOGS.some((l) => l.includes(`account_needs_login · account=${ME}`)), B.LOGS.join('\n'));
});
await t('★ ...the slot is flagged, and the user is told ONCE, naming the account and the fix', () => {
  ok(meRow().needsLogin, 'the flag must be persisted in the slot');
  eq(B.NOTICES.length, 1, `notices: ${JSON.stringify(B.NOTICES)}`);
  ok(B.NOTICES[0].includes(`🔑 Login needed · ${ME}`), B.NOTICES[0]);
  ok(B.NOTICES[0].includes(`/account capture ${ME}`), B.NOTICES[0]);
  ok(B.LOGS.some((l) => l.includes(`account_flagged_needs_login · account=${ME}`)), B.LOGS.join('\n'));
});
// The next minute: three@ is live and walled again, the flag is on disk.
B.setCooldownUntil(0);
B.setActive('three@example.com');
B.probeCalls.length = 0;
swept = await B.sweepWalledActiveAccount();
await t('★ the next sweep skips the flagged slot WITHOUT a probe, and sends no second notice', () => {
  ok(!B.probeCalls.includes(ME), `the flagged slot was probed again: ${B.probeCalls.join(',')}`);
  eq(B.NOTICES.length, 1, 'the notice was repeated on the next probe');
  eq(swaps(), 'two@example.com,two@example.com');
});
await t('the same dead login found twice in one pass, or by a later probe, still says it once', () => {
  B.flagNeedsLogin(ME, 'login refused (HTTP 401)');
  eq(B.NOTICES.length, 1);
});

incidentSetup();
// Only the dead login is free: the old selector took it with verified=false.
B.setList(B.LIST.map((a) => (a.name === 'two@example.com' ? { ...a, limitedUntil: Math.floor((NOW + 3 * HOUR) / 1000), limitedSource: 'probe', limitedVerifiedAt: new Date(NOW).toISOString() } : a)));
swept = await B.sweepWalledActiveAccount();
await t('★ with the dead login the only free account, the sweep does NOT move onto it', () => {
  eq(swaps(), '', `swapped onto ${swaps()}`);
  eq(swept.moved, false);
  ok(meRow().needsLogin, 'but it is flagged');
  eq(B.NOTICES.length, 1);
});

incidentSetup();
B.setList(B.LIST.map((a) => {
  if (a.name === 'two@example.com') return { ...a, limitedUntil: Math.floor((NOW + 3 * HOUR) / 1000), limitedSource: 'probe', limitedVerifiedAt: new Date(NOW).toISOString() };
  if (a.name === ME) return { ...a, needsLogin: { reason: 'login refused (invalid_grant)', at: 'then' } };
  return a;
}));
swept = await B.sweepWalledActiveAccount();
await t('★ with an ALREADY flagged slot the only unwalled one, the sweep has nowhere to go and does not go selecting', () => {
  eq(JSON.stringify(swept), JSON.stringify({ checked: true, moved: false }), 'a dead login counted as somewhere to move to');
  ok(!B.LOGS.some((l) => l.includes('account_skipped_needs_login')), `the sweep ran a selection over a dead login:\n${B.LOGS.join('\n')}`);
  eq(swaps(), '');
});

incidentSetup();
B.setActive('two@example.com');
B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'two@example.com'));
rot = await B.rotateOffLimitedAccount(WALL);
await t('★ THE ALL-WALLED FALLBACK: a rotation whose only free candidate is a dead login walls, it does not swap', () => {
  eq(rot.outcome, 'exhausted', `outcome ${rot.outcome} next ${rot.nextName}`);
  ok(!swaps().split(',').includes(ME), `the rotation swapped onto the dead login: ${swaps()}`);
  ok(B.pausedUntil() > NOW, 'the wall must go up');
  eq(B.NOTICES.length, 1);
  ok(rot.lines.join('\n').includes(`Skipped "${ME}": its login needs renewing`), rot.lines.join('\n'));
});
await t('★ THE WALL-TIME MOVE never lands on the dead login', () => {
  ok(!swaps().split(',').includes(ME), swaps());
  eq(B.wallWake.current()?.movedTo === ME, false);
});

B.reset();
B.setActive('two@example.com');
B.setList([
  slot('two@example.com'),
  // The dead login frees FIRST: the wall-time move and the resume clock would
  // both have picked it.
  walledSlot(ME, { limitedUntil: Math.floor((NOW + 10 * MIN) / 1000), needsLogin: { reason: 'login refused (invalid_grant)', at: 'then' } }),
  walledSlot('three@example.com', { limitedUntil: Math.floor((NOW + 90 * MIN) / 1000) }),
]);
B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'two@example.com'));
rot = await B.rotateOffLimitedAccount(WALL);
await t('★ a flagged account with the EARLIEST reset is neither the next account nor the resume clock', () => {
  eq(rot.outcome, 'exhausted');
  eq(swaps(), 'three@example.com', 'the wall-time move went to the dead login');
  eq(B.pausedUntil(), Math.floor((NOW + 90 * MIN) / 1000) * 1000, 'the wall would lift at the dead login\'s clock and free nothing');
  eq(B.NOTICES.length, 0, 'an already flagged slot is not announced again');
});
await t('★ the ledger counts a dead login with the walls, so the lift does not wake the chat onto it', () => {
  B.setList(B.LIST.map((a) => (a.name === 'three@example.com' ? a : { ...a, limitedUntil: null })));
  // two@ and the dead login are "free" in the ledger; only two@ really is.
  eq(B.ledgerAllWalled(), false);
  B.setList(B.LIST.map((a) => (a.name === 'two@example.com' ? { ...a, limitedUntil: Math.floor((NOW + HOUR) / 1000) } : a)));
  eq(B.ledgerAllWalled(), true, 'a free dead login made the ledger read as free');
});

B.reset();
B.setActive('two@example.com');
B.setList([
  walledSlot('two@example.com', { limitedUntil: Math.floor((NOW + 2 * HOUR) / 1000), limitedVerifiedAt: new Date(NOW).toISOString() }),
  slot(ME, { needsLogin: { reason: 'login refused (invalid_grant)', at: 'then' } }),
]);
B.setPausedUntil(NOW + 2 * HOUR);
const during = await B.recheckDuringWall();
await t('★ DURING A WALL a free-looking dead login is not free: no move, no lift, no selection run over it', () => {
  eq(swaps(), '', swaps());
  ok(B.pausedUntil() > NOW, `the wall was lifted onto a dead login: ${JSON.stringify(during)}`);
  eq(during.checked, false, `the sweep treated the dead login as a free account: ${JSON.stringify(during)}`);
  ok(!B.LOGS.some((l) => l.includes('account_skipped_needs_login')), B.LOGS.join('\n'));
});

B.reset();
B.setActive('two@example.com');
B.setList([slot('two@example.com'), slot(ME), slot('three@example.com')]);
B.setAll({
  active: { name: 'two@example.com' },
  rows: [
    { name: 'two@example.com', live: true, state: 'unavailable', failure: { kind: 'refused', status: 401 }, usage: null, loginProblem: 'login refused (HTTP 401)' },
    { ...REFUSED_ROW(), live: false },
    HEALTHY('three@example.com'),
  ],
});
const flagView = await B.renderAccountView();
await t('★ the /account view flags a dead login from its own rows, and never the live one', () => {
  ok(meRow().needsLogin, 'the view read a refused refresh and did not flag it');
  eq(JSON.stringify(flagView.markup.needsLogin), JSON.stringify([ME]), 'the keyboard was built from rows read before the flag, so it offered the dead login as a plain swap (QA)');
  ok(!B.LIST.find((a) => a.name === 'two@example.com').needsLogin, 'the LIVE row was flagged: its session refreshes its own token');
  eq(B.NOTICES.length, 1, `notices: ${JSON.stringify(B.NOTICES)}`);
});
await B.renderAccountView();
await B.gatherUsage();
await t('★ a second view and a /usage read of the same dead login say nothing more', () => {
  eq(B.NOTICES.length, 1, `notices: ${JSON.stringify(B.NOTICES)}`);
});
B.setList(B.LIST.map((a) => (a.name === ME ? slot(ME) : a)));
B.NOTICES.length = 0;
await B.gatherUsage();
await t('★ /usage flags a dead login from its own rows too', () => {
  ok(meRow().needsLogin, '/usage read a refused refresh and did not flag it');
  eq(B.NOTICES.length, 1);
});

// The user did what the notice said: a fresh login landed and cleared the flag. The
// next view inside the usage cache's minute is served the OLD row (cached, and
// `live: false` from before the login moved). It must not raise the flag again.
B.setList(B.LIST.map((a) => (a.name === ME ? slot(ME) : a)));
B.NOTICES.length = 0;
B.setAll({ active: { name: ME }, rows: [{ ...REFUSED_ROW(), live: false, cached: true }, HEALTHY('three@example.com')] });
await B.renderAccountView();
await t('★ a CACHED dead-login row after a fresh login neither re-flags the account nor sends a second notice (QA)', () => {
  ok(!meRow().needsLogin, 'a cached row re-flagged the login that just landed');
  eq(B.NOTICES.length, 0, `notices: ${JSON.stringify(B.NOTICES)}`);
});

// A refusal that answers AFTER the probe's deadline (the harness fuse is 20ms).
incidentSetup();
B.setList(B.LIST.filter((a) => a.name !== 'two@example.com'));
let releaseLate;
B.setProbeGate(new Promise((r) => (releaseLate = r)));
const lateSweep = await B.sweepWalledActiveAccount();
await t('★ a LATE refusal: the selector read it as unreadable, so the rotation swap is told to refuse a flagged slot (QA)', () => {
  const sw = B.CALLS.filter((c) => c.swapTo);
  eq(sw.length, 1, JSON.stringify(lateSweep));
  eq(sw[0].swapTo, ME);
  eq(sw[0].refuseFlagged, true, 'the rotation swap did not ask the store to refuse a slot flagged while it waited');
});
releaseLate();
await new Promise((r) => setTimeout(r, 30));
await t('★ ...and the late refusal is still flagged and said, once (QA)', () => {
  ok(meRow().needsLogin, 'a refusal that answered after the deadline was never flagged');
  eq(B.NOTICES.length, 1, `notices: ${JSON.stringify(B.NOTICES)}`);
  ok(B.LOGS.some((l) => l.includes('via=late probe')), B.LOGS.join('\n'));
});
B.setProbeGate(null);

// THE SAME LATE REFUSAL inside a ROTATION, with a healthy account there: the
// store refuses the dead login once its flight has answered, and the rotation
// must select again rather than end as a failed swap (QA round 3).
incidentSetup();
B.setActive('two@example.com');
B.setList(B.LIST.map((a) => (a.name === 'three@example.com' ? slot('three@example.com', { lastActiveAt: new Date(NOW - 2 * HOUR).toISOString() }) : a)));
B.setProbes({ [ME]: REFUSED_ROW(), 'three@example.com': HEALTHY('three@example.com') });
B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'two@example.com'));
let releaseRot;
const rotGate = new Promise((r) => (releaseRot = r));
B.setProbeGate(rotGate);
B.setSwapWait(rotGate.then(() => new Promise((r) => setTimeout(r, 5))));
// Released once the swap onto the dead login is WAITING, not on a clock: on a
// loaded machine the rotation reached its probe after a fixed 40ms, the probe
// answered inside its deadline, and the late refusal under test never formed.
const releaseOnSwap = setInterval(() => {
  if (B.CALLS.some((c) => c.swapTo === ME)) {
    clearInterval(releaseOnSwap);
    releaseRot();
  }
}, 2);
setTimeout(() => {
  clearInterval(releaseOnSwap);
  releaseRot();
}, 5_000).unref();
rot = await B.rotateOffLimitedAccount(WALL);
B.setProbeGate(null);
B.setSwapWait(null);
await t('★ a rotation whose pick is refused as a dead login selects again and swaps to the healthy account (QA)', () => {
  eq(rot.outcome, 'swapped', `outcome ${rot.outcome}: ${rot.error || ''}`);
  eq(rot.nextName, 'three@example.com');
  eq(swaps(), `${ME},three@example.com`, 'the dead login was tried, refused, and the healthy one taken');
  ok(rot.lines.join('\n').includes(`"${ME}" turned out to need a fresh login`), rot.lines.join('\n'));
  eq(B.NOTICES.length, 1, 'the late refusal is said once');
});

rmSync(TMP, { recursive: true, force: true });

// ---------------------------------------------------------------------------
if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log(`\n${pass} passed, 0 failed\n`);
console.log('✅ all limit-rotation tests pass');
