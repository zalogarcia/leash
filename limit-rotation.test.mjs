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

import { readFileSync } from 'node:fs';
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

const NOW = Date.UTC(2026, 8, 10, 23, 12, 0); // 2026-09-10 19:12 ET, the incident
const HOUR = 3600_000;
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

// The exact sentence off the screenshots.
const WALL =
  "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";

const HARNESS = `
import { parseResetTime, isLimited, earliestReset as earliestResetReal } from ${url('accounts.mjs')};
// THE REAL SELECTION RULE. The whole point of this block is that a candidate is
// verified before it is swapped onto, so a stub of it here would prove nothing.
import { selectAccount, PROBE_TIMEOUT_MS } from ${url('account-selector.mjs')};
import { resetsAtToMs, invalidateUsageCache } from ${url('account-usage.mjs')};
import { fmtLeft } from ${url('usage-limits.mjs')};

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
  CALLS.length = 0; LOGS.length = 0; marked.length = 0; probeCalls.length = 0;
  rotationPausedUntil = 0; rotationCooldownUntil = 0;
  USAGE_ROW = null; usageThrows = false; usageHangs = false; NEXT = { name: 'free-slot' }; swapOk = true;
  LIST = []; PROBES = {}; ACTIVE = 'gjgkabche@gmail.com'; probeThrows = false; probeHangs = false;
  if (wallResumeTimer) clearTimeout(wallResumeTimer);
  wallResumeTimer = null;
};
export let NEXT = { name: 'free-slot' };
export const setNext = (v) => { NEXT = v; };
export let swapOk = true;
export const setSwapOk = (v) => { swapOk = v; };
export const pausedUntil = () => rotationPausedUntil;

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
    })),
  markLimited: (name, resetsAt, opts) => {
    marked.push({ name, resetsAt, source: opts?.source || null });
    // Written through, so the selector's next pass and earliestReset see it,
    // exactly as the real store does.
    const i = LIST.findIndex((a) => a.name === name);
    if (i >= 0) LIST[i] = { ...LIST[i], limitedUntil: Number(resetsAt) || null };
    return { ok: true };
  },
  nextAvailable: () => NEXT,
  swapTo: async (name) => { CALLS.push({ swapTo: name }); return swapOk ? { ok: true } : { ok: false, error: 'keychain said no' }; },
  earliestReset: () => earliestResetReal(LIST, Date.now()),
};
const accountUsage = {
  activeOnly: async () => {
    CALLS.push({ activeOnly: true });
    if (usageThrows) throw new Error('usage API unreachable');
    if (usageHangs) return new Promise(() => {});
    return { active: {}, row: USAGE_ROW };
  },
  one: async (name) => {
    probeCalls.push(name);
    if (probeThrows) throw new Error('usage API unreachable');
    if (probeHangs) return new Promise(() => {});
    return PROBES[name] ?? null;
  },
};
export let ACTIVE = 'gjgkabche@gmail.com';
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
const flushParkedWalledChats = () => {};
const flushParkedWalledJobs = () => {};
let wallResumeTimer = null;
// The REAL body (the .catch matters: it is what makes a rejecting API resolve
// to the fallback rather than throw), with a short fuse so the hang case does
// not hold the suite up for six seconds.
const withDeadline = (p, ms, fallback = null) =>
  Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), 20))]);

const raiseWall = async (kind) => { CALLS.push({ raiseWall: kind }); };
const limitWallLine = () => 'wall';
const limitWallResolved = () => 'resolved';
const fmtUntil = () => 'a clock';
const OWNER_TZ = 'America/New_York';
const codexTakingChat = () => false;
const parkedCodexChats = [];
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        grab('usageResetFor'),
        grab('logAccountDecision'),
        grab('pickHealthyAccount'),
        grab('claudeWallFacts'),
        grab('raiseClaudeWall'),
        grab('armWallResume'),
        grab('rotateOffLimitedAccount'),
        'export { usageResetFor, pickHealthyAccount, rotateOffLimitedAccount, claudeWallFacts };',
      ].join('\n'),
    )
);

const win = (percent, resetsAt) => ({ percent, resetsAt, severity: null, locked: null });
const row = (usage, name = 'gjgkabche@gmail.com') => ({ name, state: 'ok', usage });
// A slot as accounts.json holds one. `limitedUntil` is epoch SECONDS.
const slot = (name, extra = {}) => ({ name, claudeAiOauth: { accessToken: 'a', refreshToken: 'r' }, ...extra });
// The real store on 2026-09-11 12:46 ET: the account that walled, the one that
// had been out of usage credits since the night before with NOTHING in the
// ledger saying so, and a healthy one.
const THREE = () => [
  slot('gjgkabche@gmail.com'),
  slot('zalo@blackumbrella.app'),
  slot('hello@blackumbrella.app'),
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
  const r = await B.usageResetFor('gjgkabche@gmail.com');
  eq(r.resetsAt, Math.floor((NOW + 50 * HOUR) / 1000), 'a 5h window back in 2h is worth nothing under a full week');
  eq(r.guessed, false, 'a reading is not a guess');
});

B.reset();
B.setUsageRow(
  row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: win(40, iso(90 * HOUR)), scoped: [], extraUsage: null }),
);
await t('a window with headroom is ignored however late it resets', async () => {
  const r = await B.usageResetFor('gjgkabche@gmail.com');
  eq(r.resetsAt, Math.floor((NOW + 2 * HOUR) / 1000), 'only the exhausted window is the wall');
});

B.reset();
B.setUsageRow(
  row({ fiveHour: win(99, iso(3 * HOUR)), sevenDay: win(96, iso(20 * HOUR)), scoped: [], extraUsage: null }),
);
await t('★ the 95 tier takes the SOONEST reset, not the latest', async () => {
  const r = await B.usageResetFor('gjgkabche@gmail.com');
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
  const r = await B.usageResetFor('gjgkabche@gmail.com');
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
  const r = await B.usageResetFor('gjgkabche@gmail.com');
  eq(r.resetsAt, Math.floor((NOW + 4 * HOUR) / 1000), "the server's own reason string beats a rounded percent");
});

B.reset();
B.setUsageRow(
  row({ fiveHour: win(30, iso(2 * HOUR)), sevenDay: win(41, iso(90 * HOUR)), scoped: [], extraUsage: null }),
);
await t('no window near its ceiling yields null, and the guess stands', async () => {
  eq(await B.usageResetFor('gjgkabche@gmail.com'), null);
});

B.reset();
B.setUsageRow(row({ fiveHour: win(100, iso(-HOUR)), sevenDay: null, scoped: [], extraUsage: null }));
await t('★ a reset already in the past is refused', async () => {
  eq(
    await B.usageResetFor('gjgkabche@gmail.com'),
    null,
    'limitedUntil in the past is not a limit: it would hand the dead account straight back',
  );
});

B.reset();
B.setUsageRow(row({ fiveHour: win(100, iso(9 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'someone-else'));
await t("★ a row for another slot is refused: another account's numbers are not this window", async () => {
  eq(await B.usageResetFor('gjgkabche@gmail.com'), null);
});

B.reset();
B.setUsageThrows(true);
await t('an unreachable usage API degrades to null rather than throwing inside a death handler', async () => {
  // withDeadline swallows the rejection into its fallback, so this lands on the
  // !row guard and not in the catch. Asserted as the null it really returns:
  // the earlier version of this test stubbed withDeadline WITHOUT the .catch
  // and then asserted an error log that production never writes.
  eq(await B.usageResetFor('gjgkabche@gmail.com'), null);
});

B.reset();
B.setUsageHangs(true);
await t('a hanging usage API is bounded by the deadline, not waited on forever', async () => {
  eq(await B.usageResetFor('gjgkabche@gmail.com'), null);
});

B.reset();
B.setUsageRow(row({ fiveHour: win(100, iso(5 * HOUR)), sevenDay: null, scoped: [win(100, iso(30 * HOUR))], extraUsage: null }));
await t('scoped per-model windows count too', async () => {
  const r = await B.usageResetFor('gjgkabche@gmail.com');
  eq(r.resetsAt, Math.floor((NOW + 30 * HOUR) / 1000));
});

// ---------------------------------------------------------------------------
console.log('\n2. rotateOffLimitedAccount: the clockless wall end to end');
// ---------------------------------------------------------------------------

B.reset();
B.setList(THREE());
B.setProbes({ 'zalo@blackumbrella.app': HEALTHY('zalo@blackumbrella.app'), 'hello@blackumbrella.app': HEALTHY('hello@blackumbrella.app') });
B.setUsageRow(row({ fiveHour: win(100, iso(6 * HOUR)), sevenDay: win(100, iso(40 * HOUR)), scoped: [], extraUsage: null }));
let rot = await B.rotateOffLimitedAccount(WALL);
await t('★ the wall with no clock marks the account until the API window, not one hour out', () => {
  eq(rot.outcome, 'swapped');
  eq(B.marked.length, 1, 'exactly one account marked');
  eq(B.marked[0].name, 'gjgkabche@gmail.com');
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
B.setProbes({ 'zalo@blackumbrella.app': HEALTHY('zalo@blackumbrella.app'), 'hello@blackumbrella.app': HEALTHY('hello@blackumbrella.app') });
B.setUsageRow(row({ fiveHour: win(20, iso(HOUR)), sevenDay: win(30, iso(HOUR)), scoped: [], extraUsage: null }));
rot = await B.rotateOffLimitedAccount(WALL);
await t('when the API cannot better it, the guess still marks and still swaps', () => {
  eq(rot.outcome, 'swapped', 'a rotation is never abandoned over a missing clock');
  eq(B.marked[0].resetsAt, Math.floor(NOW / 1000) + 3600, 'the one-hour fallback');
  ok(rot.lines.join('\n').includes('GUESSED'), 'and says out loud that it guessed');
});

B.reset();
B.setList(THREE());
B.setProbes({ 'zalo@blackumbrella.app': HEALTHY('zalo@blackumbrella.app'), 'hello@blackumbrella.app': HEALTHY('hello@blackumbrella.app') });
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
  slot('gjgkabche@gmail.com'),
  slot('zalo@blackumbrella.app', { limitedUntil: Math.floor((NOW + 3 * HOUR) / 1000) }),
  slot('hello@blackumbrella.app', { limitedUntil: Math.floor((NOW + 9 * HOUR) / 1000) }),
]);
B.setUsageRow(row({ fiveHour: win(100, iso(6 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }));
rot = await B.rotateOffLimitedAccount(WALL);
await t('the enrichment still runs when nothing is free to swap to', () => {
  eq(rot.outcome, 'exhausted');
  eq(B.marked[0].resetsAt, Math.floor((NOW + 6 * HOUR) / 1000), 'the wall clock has to be right precisely then');
  ok(B.CALLS.some((c) => c.raiseWall === 'claude'), 'and the wall notice goes up');
  eq(B.probeCalls.length, 0, 'an account the ledger already walled is never probed and never hopped onto');
  // The wall waits for the EARLIEST reset in the ledger, not for the account
  // that just died: it is the first moment anything can run again.
  eq(B.pausedUntil(), NOW + 3 * HOUR, 'three hours out is the first account back');
});

// ---------------------------------------------------------------------------
console.log('\n3. THE 12:46 INCIDENT: the rotation asks before it hops');
// ---------------------------------------------------------------------------
// hello@ hit its session limit, the rotation swapped onto gjgkabche@ (out of
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
B.setActive('hello@blackumbrella.app');
B.setList(THREE());
B.setProbes({
  // rotation order is least-recently-active, and nothing here has ever run, so
  // gjgkabche@ is asked first: exactly the account the old code hopped onto.
  'gjgkabche@gmail.com': OUT_OF_CREDITS('gjgkabche@gmail.com'),
  'zalo@blackumbrella.app': HEALTHY('zalo@blackumbrella.app'),
});
B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: win(54, iso(100 * HOUR)), scoped: [], extraUsage: null }, 'hello@blackumbrella.app'));
rot = await B.rotateOffLimitedAccount(WALL);

await t('★ the out-of-credits account is SKIPPED, not swapped onto', () => {
  eq(rot.outcome, 'swapped');
  eq(rot.nextName, 'zalo@blackumbrella.app', 'it kept going until it found one with headroom');
  eq(B.CALLS.filter((c) => c.swapTo).length, 1, 'and only swapped once');
  eq(B.CALLS.find((c) => c.swapTo).swapTo, 'zalo@blackumbrella.app');
});

await t('★ the skip is because of the SCOPED window, which the obvious rule misses', () => {
  // fiveHour 0% and sevenDay 97%: a check of "5h or weekly at 100" calls this
  // account healthy and reproduces the incident exactly.
  ok(B.probeCalls.includes('gjgkabche@gmail.com'), `it asked: ${B.probeCalls.join(', ')}`);
  const m = B.marked.find((x) => x.name === 'gjgkabche@gmail.com');
  ok(m, `the skipped account is walled in the ledger: ${JSON.stringify(B.marked)}`);
  eq(m.resetsAt, Math.floor((NOW + 12 * HOUR) / 1000), 'until the window the API named');
  eq(m.source, 'probe', 'and the ledger records that this wall was learned by asking, not by dying');
});

await t('the decision log names every step', () => {
  const log = B.LOGS.join('\n');
  ok(log.includes('account_walled'), log);
  ok(log.includes('account_selected'), log);
  ok(log.includes('account=zalo@blackumbrella.app'), log);
});

await t('the handback note tells M which account was skipped and why', () => {
  const note = rot.lines.join('\n');
  ok(note.includes('Skipped "gjgkabche@gmail.com"'), note);
  ok(note.includes('weekly Fable window is spent'), note);
});

// An account the ledger ALREADY knows is walled costs no round trip at all.
B.reset();
B.setActive('hello@blackumbrella.app');
B.setList([
  slot('gjgkabche@gmail.com', { limitedUntil: Math.floor((NOW + 12 * HOUR) / 1000) }),
  slot('zalo@blackumbrella.app'),
  slot('hello@blackumbrella.app'),
]);
B.setProbes({ 'zalo@blackumbrella.app': HEALTHY('zalo@blackumbrella.app') });
B.setUsageRow(null);
rot = await B.rotateOffLimitedAccount(WALL);

await t('★ a known-walled account is never probed and never hopped onto', () => {
  eq(rot.nextName, 'zalo@blackumbrella.app');
  ok(!B.probeCalls.includes('gjgkabche@gmail.com'), `no round trip for a known wall: ${B.probeCalls.join(', ')}`);
  ok(B.LOGS.join('\n').includes('account_skipped_known_walled'), B.LOGS.join('\n'));
});

// EVERY ACCOUNT SPENT: the cycle ends, it does not loop, and the wall clock is
// the earliest of the three.
B.reset();
B.setActive('hello@blackumbrella.app');
B.setList(THREE());
B.setProbes({
  'gjgkabche@gmail.com': OUT_OF_CREDITS('gjgkabche@gmail.com'),
  'zalo@blackumbrella.app': row({ fiveHour: win(100, iso(3 * HOUR)), sevenDay: win(40, iso(90 * HOUR)), scoped: [], extraUsage: null }, 'zalo@blackumbrella.app'),
});
B.setUsageRow(row({ fiveHour: win(100, iso(2 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }, 'hello@blackumbrella.app'));
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
B.setActive('hello@blackumbrella.app');
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
B.setActive('hello@blackumbrella.app');
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
  slot('gjgkabche@gmail.com', { limitedUntil: Math.floor((NOW + 12 * HOUR) / 1000) }),
  slot('zalo@blackumbrella.app', { limitedUntil: Math.floor((NOW + 2 * HOUR) / 1000) }),
  slot('hello@blackumbrella.app'),
]);
await t('claudeWallFacts reads the earliest reset and one row per account', () => {
  const f = B.claudeWallFacts(NOW);
  eq(f.rows.length, 3);
  eq(f.earliest, Math.floor((NOW + 2 * HOUR) / 1000), 'the soonest wall, so the clock is the one he waits on');
  eq(f.rows.filter((r) => r.walled).length, 2);
});

// ---------------------------------------------------------------------------
if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log(`\n${pass} passed, 0 failed\n`);
console.log('✅ all limit-rotation tests pass');
