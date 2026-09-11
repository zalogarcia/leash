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
import { parseResetTime } from ${url('accounts.mjs')};
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
  CALLS.length = 0; LOGS.length = 0; marked.length = 0;
  rotationPausedUntil = 0; rotationCooldownUntil = 0;
  USAGE_ROW = null; usageThrows = false; usageHangs = false; NEXT = { name: 'free-slot' }; swapOk = true;
};
export let NEXT = { name: 'free-slot' };
export const setNext = (v) => { NEXT = v; };
export let swapOk = true;
export const setSwapOk = (v) => { swapOk = v; };

const accounts = {
  activeAccount: async () => ({ account: { name: 'gjgkabche@gmail.com' } }),
  markLimited: (name, resetsAt) => { marked.push({ name, resetsAt }); return { ok: true }; },
  nextAvailable: () => NEXT,
  swapTo: async (name) => { CALLS.push({ swapTo: name }); return swapOk ? { ok: true } : { ok: false, error: 'keychain said no' }; },
  earliestReset: () => Math.floor((NOW + 2 * ${HOUR}) / 1000),
};
const accountUsage = {
  activeOnly: async () => {
    CALLS.push({ activeOnly: true });
    if (usageThrows) throw new Error('usage API unreachable');
    if (usageHangs) return new Promise(() => {});
    return { active: {}, row: USAGE_ROW };
  },
};
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
        grab('rotateOffLimitedAccount'),
        'export { usageResetFor, rotateOffLimitedAccount };',
      ].join('\n'),
    )
);

const win = (percent, resetsAt) => ({ percent, resetsAt, severity: null, locked: null });
const row = (usage, name = 'gjgkabche@gmail.com') => ({ name, state: 'ok', usage });

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
B.setUsageRow(row({ fiveHour: win(20, iso(HOUR)), sevenDay: win(30, iso(HOUR)), scoped: [], extraUsage: null }));
rot = await B.rotateOffLimitedAccount(WALL);
await t('when the API cannot better it, the guess still marks and still swaps', () => {
  eq(rot.outcome, 'swapped', 'a rotation is never abandoned over a missing clock');
  eq(B.marked[0].resetsAt, Math.floor(NOW / 1000) + 3600, 'the one-hour fallback');
  ok(rot.lines.join('\n').includes('GUESSED'), 'and says out loud that it guessed');
});

B.reset();
B.setUsageRow(row({ fiveHour: win(100, iso(6 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }));
rot = await B.rotateOffLimitedAccount("You've hit your session limit · resets 6:30pm (America/Caracas)");
await t('★ a wall that DOES carry a clock never asks the usage API', () => {
  ok(!B.CALLS.some((c) => c.activeOnly), 'no network on the common path: the message already said when');
  ok(B.marked[0].resetsAt !== Math.floor((NOW + 6 * HOUR) / 1000), 'the message wins over the API');
  ok(B.LOGS.some((l) => l.includes('reset time from the wall message')), 'and the log says where it came from');
});

B.reset();
B.setNext(null);
B.setUsageRow(row({ fiveHour: win(100, iso(6 * HOUR)), sevenDay: null, scoped: [], extraUsage: null }));
rot = await B.rotateOffLimitedAccount(WALL);
await t('the enrichment still runs when nothing is free to swap to', () => {
  eq(rot.outcome, 'exhausted');
  eq(B.marked[0].resetsAt, Math.floor((NOW + 6 * HOUR) / 1000), 'the wall clock has to be right precisely then');
  ok(B.CALLS.some((c) => c.raiseWall === 'claude'), 'and the wall notice goes up');
});

// ---------------------------------------------------------------------------
if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log(`\n${pass} passed, 0 failed\n`);
console.log('✅ all limit-rotation tests pass');
