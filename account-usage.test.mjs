#!/usr/bin/env node
// Tests for account-usage.mjs — live 5h + weekly plan usage per Claude account.
//
// SHARED TEST, byte-identical in both bridge repos (scripts/check-shared.sh).
//
// Nothing here touches the network, the real keychain or the real accounts.json.
// `fetchImpl`, the clock and the account store are all injected, so the fixture
// below is the ONLY thing standing in for the API — and it is the body a live
// probe of api.anthropic.com returned on 2026-08-31 (identifying values
// anonymized, structure untouched), so a change in the wire format shows up
// here as a failing normalization rather than as a blank line in Telegram.
//
//   node account-usage.test.mjs

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccountStore } from './accounts.mjs';
import {
  fmtPercent,
  usageBar,
  fmtResetLeft,
  fmtResetClock,
  normalizeUsage,
  fetchUsage,
  fetchUsageResult,
  usageFailureText,
  parseRetryAfter,
  throttleHoldMs,
  THROTTLE_DEFAULT_MS,
  THROTTLE_MAX_MS,
  fetchProfile,
  refreshAccessToken,
  createAccountUsage,
  invalidateUsageCache,
  usageLine,
  activeLine,
  accountUsageBlock,
  renderAccountList,
  unclaimedLine,
  renderUsageReport,
  usageBrief,
  swapConfirmation,
  swapFailure,
  captureConfirmation,
  captureFailure,
  CLAUDE_CODE_CLIENT_ID,
  OAUTH_BETA,
  normalizeRateLimitEvent,
  liveSourceLine,
  STREAM_FALLBACK_MAX_AGE_MS,
  rowLoginProblem,
} from './account-usage.mjs';
import { createKeychainStore, createFileStore } from './credential-store.mjs';

// Every zone-dependent assertion pins this zone explicitly, so the suite is
// deterministic on any machine. (The module's own default is the local zone;
// the bridges inject the owner's zone at the call sites.)
const OWNER_TZ = 'America/Toronto';

let pass = 0;
const failures = [];
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};
const throws = async (fn, re, msg) => {
  try {
    await fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${msg || ''} wrong error: ${e.message}`);
    return e;
  }
  throw new Error(msg || 'expected a throw, got none');
};

const TMP = mkdtempSync(path.join(tmpdir(), 'account-usage-test-'));

// ---------------------------------------------------------------------------
// THE REAL RESPONSE SHAPE, from a live probe of
// GET /api/oauth/usage with a real account's token, 2026-08-31T21:53Z, CC 2.1.252.
// The unused windows (nimbus_quill, tangelo, …) are kept precisely because they
// are unused: a normalizer that trips over an unfamiliar sibling key would fail
// here rather than in production.
// ---------------------------------------------------------------------------
const REAL_USAGE = {
  five_hour: {
    utilization: 32.0,
    resets_at: '2026-08-31T22:10:00.241439+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day: {
    utilization: 24.0,
    resets_at: '2026-09-05T05:00:00.241459+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  iguana_necktie: null,
  omelette_promotional: null,
  nimbus_quill: { utilization: 0.0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  cinder_cove: null,
  amber_ladder: null,
  juniper_tide: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: 50000,
    used_credits: 0.0,
    utilization: 0.0,
    currency: 'USD',
    decimal_places: 2,
    disabled_reason: 'out_of_credits',
    user_disabled: false,
    spend_limit_reached: false,
    credits_ever_enabled: true,
    daily: null,
    weekly: null,
  },
  limits: [
    { kind: 'session', group: 'session', percent: 32, severity: 'normal', resets_at: '2026-08-31T22:10:00.241439+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 24, severity: 'normal', resets_at: '2026-09-05T05:00:00.241459+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 4, severity: 'normal', resets_at: '2026-09-05T05:00:00.241715+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
  member_dashboard_available: false,
};

// The live /api/oauth/profile body, same probe.
const REAL_PROFILE = {
  account: {
    uuid: '00000000-1111-2222-3333-444444444444',
    full_name: 'Sam Owner',
    display_name: 'Sam',
    email: 'second@example.com',
    has_claude_max: true,
    has_claude_pro: false,
  },
  organization: { uuid: 'a1b2c3d4', name: "second@example.com's Organization", rate_limit_tier: 'default_claude_max_20x' },
  application: { uuid: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', name: 'Claude Code', slug: 'claude-code' },
};

const NOW = Date.parse('2026-08-31T21:53:00Z'); // pinned: every clock below is a parameter

// ---------------------------------------------------------------------------
// FORMATTERS — pure, no network, no clock of their own
// ---------------------------------------------------------------------------

await t('fmtPercent rounds and clamps, and says n/a rather than NaN', () => {
  eq(fmtPercent(31), '31%');
  eq(fmtPercent(31.4), '31%');
  eq(fmtPercent(31.6), '32%');
  eq(fmtPercent(0), '0%');
  eq(fmtPercent(100), '100%');
  eq(fmtPercent(140), '100%', 'a percent over 100 must clamp, not print 140%');
  eq(fmtPercent(-3), '0%');
  eq(fmtPercent(null), 'n/a');
  eq(fmtPercent(undefined), 'n/a');
  eq(fmtPercent('nonsense'), 'n/a');
});

await t('usageBar fills CONSUMED cells, ten of them, at both edges', () => {
  eq(usageBar(0), '░░░░░░░░░░');
  eq(usageBar(100), '██████████');
  eq(usageBar(31), '███░░░░░░░');
  eq(usageBar(24), '██░░░░░░░░');
  eq(usageBar(95), '██████████', '95% rounds to a full bar');
  eq(usageBar(4), '░░░░░░░░░░', '4% honestly rounds to empty rather than faking a cell');
  eq(usageBar(null).length, 10);
  eq(usageBar('x'), '░░░░░░░░░░');
  for (const p of [0, 1, 7, 33, 50, 99, 100]) eq([...usageBar(p)].length, 10, `bar width drifted at ${p}%`);
});

await t('fmtResetLeft gives h+m under a day', () => {
  eq(fmtResetLeft('2026-08-31T22:10:00Z', Date.parse('2026-08-31T21:53:00Z')), '17m left');
  eq(fmtResetLeft('2026-09-01T00:14:00Z', Date.parse('2026-08-31T21:53:00Z')), '2h 21m left');
  eq(fmtResetLeft('2026-08-31T22:53:00Z', Date.parse('2026-08-31T21:53:00Z')), '1h 0m left');
});

await t('fmtResetLeft names the DAY once the reset is more than a day out', () => {
  // 2026-09-05T05:00Z is 1:00am Saturday in OWNER_TZ; the label must be the owner's day,
  // not UTC's, which is the whole reason the zone is a parameter.
  const s = fmtResetLeft('2026-09-05T05:00:00Z', Date.parse('2026-09-01T00:00:00Z'), { timeZone: OWNER_TZ });
  eq(s, 'Sat 5 Sep, 4d 5h left');
  // In UTC the same instant is still the 5th, but at 5am, and still Saturday.
  eq(fmtResetLeft('2026-09-05T05:00:00Z', Date.parse('2026-09-01T00:00:00Z'), { timeZone: 'UTC' }), 'Sat 5 Sep, 4d 5h left');
  // A reset just past midnight UTC on the 5th is the 4th in OWNER_TZ.
  eq(
    fmtResetLeft('2026-09-05T01:00:00Z', Date.parse('2026-09-01T00:00:00Z'), { timeZone: OWNER_TZ }),
    'Fri 4 Sep, 4d 1h left',
    'the day label must be rendered in THEIR zone',
  );
});

await t('fmtResetLeft never prints a negative clock and never throws on junk', () => {
  eq(fmtResetLeft('2026-08-31T20:00:00Z', NOW), 'due now');
  eq(fmtResetLeft(NOW, NOW), 'due now');
  eq(fmtResetLeft(null, NOW), 'unknown');
  eq(fmtResetLeft('not a date', NOW), 'unknown');
  eq(fmtResetLeft(undefined, NOW), 'unknown');
});

await t('fmtResetLeft takes ISO strings, epoch MILLISECONDS and Dates — never seconds', () => {
  eq(fmtResetLeft(NOW + 90 * 60_000, NOW), '1h 30m left');
  eq(fmtResetLeft(new Date(NOW + 90 * 60_000), NOW), '1h 30m left');
  // usage-limits.mjs's fmtLeft takes epoch SECONDS. Feeding those here must read
  // as long-past, i.e. "due now", not as a plausible number — the two unit
  // contracts must not silently blend.
  eq(fmtResetLeft(Math.floor((NOW + 90 * 60_000) / 1000), NOW), 'due now');
});

await t('fmtResetClock prints their local clock, and adds the day only when it is not today', () => {
  // 22:10Z on 2026-08-31 is 6:10pm the same day in OWNER_TZ.
  eq(fmtResetClock('2026-08-31T22:10:00Z', { timeZone: OWNER_TZ, now: NOW }), '6:10pm');
  // 05:00Z on 2026-09-05 is 1:00am Saturday the 5th in OWNER_TZ, a different day.
  eq(fmtResetClock('2026-09-05T05:00:00Z', { timeZone: OWNER_TZ, now: NOW }), 'Sat 5 Sep 1:00am');
  // Same instant read in UTC is 5:00am, still the 5th.
  eq(fmtResetClock('2026-09-05T05:00:00Z', { timeZone: 'UTC', now: NOW }), 'Sat 5 Sep 5:00am');
  eq(fmtResetClock(null, { timeZone: OWNER_TZ, now: NOW }), 'unknown');
});

// ---------------------------------------------------------------------------
// NORMALIZATION
// ---------------------------------------------------------------------------

await t('the real response body normalizes to the numbers /usage prints', () => {
  const u = normalizeUsage(REAL_USAGE);
  eq(u.fiveHour.percent, 32);
  eq(u.fiveHour.resetsAt, '2026-08-31T22:10:00.241439+00:00');
  eq(u.fiveHour.severity, 'normal');
  eq(u.fiveHour.locked, null);
  eq(u.sevenDay.percent, 24);
  eq(u.sevenDay.severity, 'normal');
  eq(u.scoped, [{ label: 'Fable', percent: 4, resetsAt: '2026-09-05T05:00:00.241715+00:00' }]);
  eq(u.extraUsage, { enabled: false, percent: 0, usedCredits: 0, monthlyLimit: 50000 });
});

await t('limits[] wins over the flat five_hour/seven_day pair when both are present', () => {
  // Same body, but the two views disagree. limits[] is the richer, newer one, so
  // it must be the one that shows — otherwise a server-side migration would
  // quietly freeze the display on stale numbers.
  const body = JSON.parse(JSON.stringify(REAL_USAGE));
  body.five_hour.utilization = 99;
  body.seven_day.utilization = 88;
  const u = normalizeUsage(body);
  eq(u.fiveHour.percent, 32, 'the flat five_hour overrode limits[]');
  eq(u.sevenDay.percent, 24, 'the flat seven_day overrode limits[]');
});

await t('a body with no limits[] falls back to the flat pair rather than blanking', () => {
  const body = JSON.parse(JSON.stringify(REAL_USAGE));
  delete body.limits;
  body.seven_day_opus = { utilization: 12.0, resets_at: '2026-09-05T05:00:00Z', locked_reason: null };
  const u = normalizeUsage(body);
  eq(u.fiveHour.percent, 32);
  eq(u.fiveHour.severity, null, 'severity is a limits[]-only field; inventing one would be a made-up threshold');
  eq(u.sevenDay.percent, 24);
  eq(u.scoped, [{ label: 'Opus', percent: 12, resetsAt: '2026-09-05T05:00:00Z' }]);
});

await t('locked_reason is carried through, because an exhausted window must say so', () => {
  const body = JSON.parse(JSON.stringify(REAL_USAGE));
  body.five_hour.locked_reason = 'usage_limit_reached';
  body.limits[0].percent = 100;
  const u = normalizeUsage(body);
  eq(u.fiveHour.locked, 'usage_limit_reached');
  eq(u.fiveHour.percent, 100);
});

await t('an unrecognisable body normalizes to null instead of throwing into a reply', () => {
  eq(normalizeUsage(null), null);
  eq(normalizeUsage(undefined), null);
  eq(normalizeUsage('a string'), null);
  eq(normalizeUsage({}), null);
  eq(normalizeUsage({ limits: 'not an array' }), null);
  eq(normalizeUsage({ limits: [null, { kind: 'session' }] }).fiveHour.percent, null, 'a percent-less window is n/a, not a crash');
});

// ---------------------------------------------------------------------------
// NETWORK — every failure degrades to null, none of them throws
// ---------------------------------------------------------------------------

const res = (status, body, { json = true } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (!json) throw new SyntaxError('Unexpected token < in JSON');
    return body;
  },
});

await t('fetchUsage sends the three headers Claude Code sends, and no others that matter', async () => {
  let seen = null;
  const u = await fetchUsage('tok-abc', {
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return res(200, REAL_USAGE);
    },
  });
  eq(seen.url, 'https://api.anthropic.com/api/oauth/usage');
  eq(seen.opts.headers.Authorization, 'Bearer tok-abc');
  eq(seen.opts.headers['anthropic-beta'], OAUTH_BETA);
  ok(/^claude-cli\//.test(seen.opts.headers['User-Agent']), 'the CLI User-Agent is part of the contract');
  ok(seen.opts.signal, 'no AbortController signal, so a hung request would hang a reply');
  eq(u.fiveHour.percent, 32);
});

await t('fetchUsage can ask for the wall-clock-only variant', async () => {
  let seen = null;
  await fetchUsage('tok', { wallClockOnly: true, fetchImpl: async (url) => ((seen = url), res(200, REAL_USAGE)) });
  eq(seen, 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1');
});

await t('401, 500, a timeout and malformed JSON all yield null and never throw', async () => {
  eq(await fetchUsage('tok', { fetchImpl: async () => res(401, { error: 'unauthorized' }) }), null, '401');
  eq(await fetchUsage('tok', { fetchImpl: async () => res(500, {}) }), null, '500');
  eq(await fetchUsage('tok', { fetchImpl: async () => res(200, null, { json: false }) }), null, 'malformed JSON');
  eq(
    await fetchUsage('tok', {
      fetchImpl: async () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        throw e;
      },
    }),
    null,
    'abort',
  );
  eq(
    await fetchUsage('tok', {
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    }),
    null,
    'DNS failure',
  );
  eq(await fetchUsage('tok', { fetchImpl: async () => undefined }), null, 'a fetch that resolves to nothing');
  eq(await fetchUsage(null, { fetchImpl: async () => res(200, REAL_USAGE) }), null, 'no token means no request');
});

await t('fetchUsage really does abort on a slow server rather than waiting forever', async () => {
  const started = Date.now();
  const out = await fetchUsage('tok', {
    timeoutMs: 40,
    fetchImpl: (url, opts) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(res(200, REAL_USAGE)), 5_000);
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  });
  eq(out, null);
  ok(Date.now() - started < 2_000, 'the abort did not fire; a hung usage call would hang the reply carrying it');
});

await t('fetchProfile returns the identity that survives a token rotation', async () => {
  const p = await fetchProfile('tok', { fetchImpl: async () => res(200, REAL_PROFILE) });
  eq(p, { email: 'second@example.com', fullName: 'Sam Owner', tier: 'default_claude_max_20x' });
  eq(await fetchProfile('tok', { fetchImpl: async () => res(200, { nope: 1 }) }), null);
  eq(await fetchProfile('tok', { fetchImpl: async () => res(403, {}) }), null);
});

// ---------------------------------------------------------------------------
// REFRESH — the only call in the module that is allowed to throw
// ---------------------------------------------------------------------------

const PREV = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: NOW - 1000,
  refreshTokenExpiresAt: NOW + 30 * 86400_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
};

await t('refresh posts the documented body and maps the response into a claudeAiOauth blob', async () => {
  let seen = null;
  const blob = await refreshAccessToken({
    refreshToken: 'old-refresh',
    previous: PREV,
    now: NOW,
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return res(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800, scope: 'user:inference user:profile' });
    },
  });
  eq(seen.url, 'https://api.anthropic.com/v1/oauth/token');
  eq(seen.opts.method, 'POST');
  eq(JSON.parse(seen.opts.body), { grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: CLAUDE_CODE_CLIENT_ID });
  eq(blob.accessToken, 'new-access');
  eq(blob.refreshToken, 'new-refresh');
  eq(blob.expiresAt, NOW + 28800_000);
  eq(blob.scopes, ['user:inference', 'user:profile']);
  eq(blob.subscriptionType, 'max', 'the carried-through fields must survive a refresh');
  eq(blob.rateLimitTier, 'default_claude_max_20x');
  eq(blob.refreshTokenExpiresAt, PREV.refreshTokenExpiresAt);
});

await t('a response that does not rotate the refresh token keeps the old one rather than writing undefined', async () => {
  const blob = await refreshAccessToken({
    refreshToken: 'old-refresh',
    previous: PREV,
    now: NOW,
    fetchImpl: async () => res(200, { access_token: 'new-access', expires_in: 3600 }),
  });
  eq(blob.refreshToken, 'old-refresh');
  eq(blob.expiresAt, NOW + 3600_000);
});

await t('refresh THROWS on every failure, and the message never carries the body', async () => {
  const e401 = await throws(
    () => refreshAccessToken({ refreshToken: 'r', fetchImpl: async () => res(400, { error: 'invalid_grant', secret_echo: 'sk-ant-oat01-LEAK' }) }),
    /HTTP 400 \(invalid_grant\)/,
  );
  ok(!e401.message.includes('LEAK'), 'the error message echoed the response body');
  await throws(() => refreshAccessToken({ refreshToken: 'r', fetchImpl: async () => res(500, null, { json: false }) }), /HTTP 500/);
  await throws(() => refreshAccessToken({ refreshToken: 'r', fetchImpl: async () => res(200, null, { json: false }) }), /not JSON/);
  await throws(() => refreshAccessToken({ refreshToken: 'r', fetchImpl: async () => res(200, { nope: 1 }) }), /no access token/);
  await throws(
    () =>
      refreshAccessToken({
        refreshToken: 'r',
        fetchImpl: async () => {
          throw new Error('socket hang up');
        },
      }),
    /could not be sent \(network error\)/,
  );
  await throws(() => refreshAccessToken({ refreshToken: null }), /refresh token is required/);
});

// ---------------------------------------------------------------------------
// THE READER — a real account store on a mkdtemp file, a fake keychain, a fake
// fetch, a pinned clock. Nothing real is touched.
// ---------------------------------------------------------------------------

// Same wire-format-decoding fake as accounts.test.mjs: it parses the exact
// `security -i` + hex payload the daemon sends, so the write path is real.
function fakeKeychain(blob) {
  const box = { blob: blob ? JSON.parse(JSON.stringify(blob)) : null };
  box.run = async (args, stdin = null) => {
    if (args[0] === 'find-generic-password') {
      return box.blob ? { code: 0, stdout: JSON.stringify(box.blob) } : { code: 44, stdout: '' };
    }
    if (args[0] === '-i' && stdin) {
      const m = stdin.match(/^add-generic-password -U -a "([^"]+)" -s "([^"]+)" -X "([0-9a-f]+)"\n$/);
      if (!m) return { code: 1, stdout: '' };
      box.blob = JSON.parse(Buffer.from(m[3], 'hex').toString('utf8'));
      return { code: 0, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };
  return box;
}

const oauthFor = (seed, over = {}) => ({
  accessToken: `acc-${seed}`,
  refreshToken: `ref-${seed}`,
  expiresAt: NOW + 4 * 3600_000,
  refreshTokenExpiresAt: NOW + 25 * 86400_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  ...over,
});

let n = 0;
function rig({ seed, liveOauth, fetchImpl, logs = [] } = {}) {
  const file = path.join(TMP, `accounts-${n++}.json`);
  writeFileSync(file, JSON.stringify(seed, null, 2), { mode: 0o600 });
  const kc = fakeKeychain({ claudeAiOauth: liveOauth, mcpOAuth: { heygen: { token: 'machine-scoped' } } });
  const store = createAccountStore({
    file,
    credentials: createKeychainStore({ account: 'owner', runSecurity: (...a) => kc.run(...a) }),
    log: (m) => logs.push(`[accounts] ${m}`),
  });
  const usage = createAccountUsage({
    store,
    fetchImpl,
    now: () => NOW,
    log: (m) => logs.push(`[usage] ${m}`),
  });
  invalidateUsageCache();
  return { file, store, usage, kc, logs, onDisk: () => JSON.parse(readFileSync(file, 'utf8')) };
}

const SEED = [
  { name: 'second@example.com', email: 'second@example.com', claudeAiOauth: oauthFor('a'), limitedUntil: null, lastActiveAt: null },
  { name: 'first@example.com', email: null, claudeAiOauth: oauthFor('b'), limitedUntil: null, lastActiveAt: null },
  { name: 'third@example.com', email: null, claudeAiOauth: oauthFor('c'), limitedUntil: null, lastActiveAt: null },
];

// A fetch that answers usage for every token and records which tokens asked.
function usageFetch(perToken = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    const tok = String(opts.headers.Authorization).replace('Bearer ', '');
    calls.push({ url, tok });
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    if (url.includes('/oauth/usage')) {
      const pct = perToken[tok];
      if (pct === 'fail') return res(500, {});
      const body = JSON.parse(JSON.stringify(REAL_USAGE));
      if (typeof pct === 'number') {
        body.limits[0].percent = pct;
        body.five_hour.utilization = pct;
      }
      return res(200, body);
    }
    return res(404, {});
  };
  return { impl, calls };
}

await t('all() reads every account and marks the live one, matching by fingerprint', async () => {
  const f = usageFetch({ 'acc-a': 32, 'acc-b': 0, 'acc-c': 71 });
  const r = rig({ seed: SEED, liveOauth: oauthFor('b'), fetchImpl: f.impl });
  const { active, rows } = await r.usage.all();
  eq(active.name, 'first@example.com');
  eq(active.matchedBy, 'refreshToken');
  eq(rows.map((x) => x.name), SEED.map((s) => s.name));
  eq(rows.map((x) => x.state), ['ok', 'ok', 'ok']);
  eq(rows.map((x) => x.live), [false, true, false]);
  eq(rows.map((x) => x.usage.fiveHour.percent), [32, 0, 71]);
  eq(f.calls.filter((c) => c.url.includes('/profile')).length, 0, 'a fingerprint match must not cost a profile call');
});

await t('a live account whose tokens have rotated is identified by its profile email, not printed as unknown', async () => {
  // This is the "Active: unknown a…8dkwAA/r…U7DQAA" bug: after the running
  // session refreshes, the keychain blob matches no stored token.
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: oauthFor('rotated-beyond-recognition'), fetchImpl: f.impl });
  const active = await r.usage.resolveActive();
  eq(active.matchedBy, 'profileEmail');
  eq(active.name, 'second@example.com', 'the profile email must resolve the slot');
  eq(active.fullName, 'Sam Owner');
  ok(!active.liveFingerprint.includes('rotated-beyond-recognition'), 'the fingerprint leaked the token');
});

await t('an unreadable keychain leaves the active account unknown without throwing', async () => {
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: null, fetchImpl: f.impl });
  const active = await r.usage.resolveActive();
  eq(active.name, null);
  eq(active.liveFingerprint, 'none');
});

await t('the live account is read from the KEYCHAIN, never from the stale copy on disk', async () => {
  // Disk holds an EXPIRED token for the live slot; the keychain holds a fresh
  // one. Reading disk would trigger a refresh of the account a live session owns.
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[0].claudeAiOauth = oauthFor('a', { expiresAt: NOW - 3600_000 });
  const live = oauthFor('a', { accessToken: 'acc-a-fresh-from-keychain' });
  const f = usageFetch({ 'acc-a-fresh-from-keychain': 32 });
  const r = rig({ seed, liveOauth: live, fetchImpl: f.impl });
  const { rows } = await r.usage.all();
  eq(rows[0].state, 'ok');
  ok(
    f.calls.some((c) => c.tok === 'acc-a-fresh-from-keychain'),
    'the keychain token was not used for the live account',
  );
  eq(f.calls.filter((c) => c.url.includes('/oauth/token')).length, 0, 'THE LIVE ACCOUNT WAS REFRESHED — that races the running session');
  eq(r.onDisk()[0].claudeAiOauth.accessToken, 'acc-a', 'the live slot on disk must not be rewritten by a usage read');
});

await t('an idle account with a past expiresAt IS refreshed, once, and persisted BEFORE the token is used', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  let diskAtUsageTime = null;
  let refreshes = 0;
  const impl = async (url, opts) => {
    if (url.includes('/oauth/token')) {
      refreshes++;
      return res(200, { access_token: 'acc-c-refreshed', refresh_token: 'ref-c-rotated', expires_in: 28800 });
    }
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    const tok = String(opts.headers.Authorization).replace('Bearer ', '');
    if (tok === 'acc-c-refreshed') {
      // Ordering proof: read the file at the exact moment the new token is used.
      diskAtUsageTime = JSON.parse(readFileSync(r.file, 'utf8'));
    }
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  const { rows } = await r.usage.all();

  eq(refreshes, 1, 'exactly one refresh attempt, no retry loop');
  eq(rows[2].state, 'ok');
  eq(rows[2].refreshed, true);
  ok(diskAtUsageTime, 'the refreshed token was never used, so the ordering could not be proven');
  eq(diskAtUsageTime[2].claudeAiOauth.accessToken, 'acc-c-refreshed', 'the rotated blob was used BEFORE it was persisted');
  eq(diskAtUsageTime[2].claudeAiOauth.refreshToken, 'ref-c-rotated');
  // ...and it stuck, with everything else in the slot intact.
  const after = r.onDisk();
  eq(after[2].claudeAiOauth.expiresAt, NOW + 28800_000);
  eq(after[2].claudeAiOauth.subscriptionType, 'max', 'the refresh dropped a carried-through field');
  eq(after[2].name, 'third@example.com');
  eq(after[0].claudeAiOauth.accessToken, 'acc-a', 'the refresh rewrote a sibling slot');
  ok(
    r.logs.some((l) => l.includes('refreshed the expired token')),
    'a refresh must be logged',
  );
  ok(!r.logs.some((l) => l.includes('acc-c-refreshed') || l.includes('ref-c-rotated')), 'a log line leaked a token');
});

await t('a still-valid idle token is used as-is, with no refresh at all', async () => {
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  await r.usage.all();
  eq(f.calls.filter((c) => c.url.includes('/oauth/token')).length, 0);
});

await t('a token inside the five-minute expiry skew is refreshed rather than sent to die in flight', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[1].claudeAiOauth = oauthFor('b', { expiresAt: NOW + 60_000 }); // valid, but not for long
  let refreshes = 0;
  const impl = async (url) => {
    if (url.includes('/oauth/token')) {
      refreshes++;
      return res(200, { access_token: 'acc-b-refreshed', refresh_token: 'ref-b2', expires_in: 28800 });
    }
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  await r.usage.all();
  eq(refreshes, 1);
});

await t('a PERSIST FAILURE surfaces as an error, never as a usage number', async () => {
  // The worst outcome in the module: the token in hand works, the one on disk is
  // dead. It must not be papered over with a percentage.
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const impl = async (url) => {
    if (url.includes('/oauth/token')) return res(200, { access_token: 'sk-ant-oat01-refreshed-c-AAAAAA', refresh_token: 'sk-ant-ort01-rotated-c-BBBBBB', expires_in: 28800 });
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  r.store.bankOauth = () => {
    throw new Error('EROFS: read-only file system');
  };
  const { rows } = await r.usage.all();
  eq(rows[2].state, 'persist-failed');
  eq(rows[2].usage, null, 'a persist failure was dressed up as a working account');
  ok(/REFRESHED BUT NOT SAVED/.test(rows[2].error), rows[2].error);
  ok(/re-capture this account/.test(rows[2].error), 'the error must say what to do about it');
  ok(!rows[2].error.includes('sk-ant-oat01-refreshed-c-AAAAAA'), 'the error message leaked a token');
  ok(!rows[2].error.includes('sk-ant-ort01-rotated-c-BBBBBB'), 'the error message leaked a refresh token');
  ok(r.logs.some((l) => l.includes('REFRESHED BUT NOT SAVED')), 'this failure must be loud in the log too');
  // ...and the renderer says so rather than showing a bar.
  ok(/⚠️/.test(renderUsageReport({ active: { name: 'second@example.com' }, rows }, { now: NOW })));
});

await t('a store that REFUSES the write (unknown slot) is treated exactly like a throw', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const impl = async (url) => {
    if (url.includes('/oauth/token')) return res(200, { access_token: 'x', refresh_token: 'y', expires_in: 100 });
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  r.store.bankOauth = () => ({ ok: false, error: 'no account slot named "third@example.com"' });
  const { rows } = await r.usage.all();
  eq(rows[2].state, 'persist-failed');
  eq(rows[2].usage, null);
});

await t('a failed refresh degrades that ONE account and leaves the others intact', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const impl = async (url) => {
    if (url.includes('/oauth/token')) return res(400, { error: 'invalid_grant' });
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  const { rows } = await r.usage.all();
  eq(rows[2].state, 'refresh-failed');
  ok(/invalid_grant/.test(rows[2].error));
  eq(rows[0].state, 'ok', 'one broken account took the whole reply down');
  eq(rows[1].state, 'ok');
  eq(r.onDisk()[2].claudeAiOauth.accessToken, 'acc-c', 'a failed refresh must not touch disk');
});

await t('a dead refreshTokenExpiresAt short-circuits with the capture-again instruction', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[1].claudeAiOauth = oauthFor('b', { expiresAt: NOW - 60_000, refreshTokenExpiresAt: NOW - 86400_000 });
  const f = usageFetch({});
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  const { rows } = await r.usage.all();
  eq(rows[1].state, 'credentials-expired');
  eq(rows[1].usage, null);
  ok(/\/account capture first@example\.com/.test(rows[1].error), rows[1].error);
  eq(f.calls.filter((c) => c.url.includes('/oauth/token')).length, 0, 'a dead refresh token must not be spent on an attempt');
  eq(f.calls.filter((c) => c.tok === 'acc-b').length, 0, 'an expired account must not be asked for usage either');
});

// ---------------------------------------------------------------------------
// ONE REFRESH PER SLOT (2026-09-30 18:22 ET). The /account view's read and the
// rotation's probe refreshed an idle account at the same moment: the first
// won and was banked, the second presented the refresh token the first had
// just spent and got invalid_grant, and the rotation took the account anyway.
// ---------------------------------------------------------------------------

// A token endpoint that holds its answer until the test releases it, so two
// readers can be caught with one refresh in flight, deterministically.
function gatedRefreshFetch({ answer = () => res(200, { access_token: 'acc-c-new', refresh_token: 'ref-c-new', expires_in: 28800 }) } = {}) {
  const calls = { token: [], usage: [] };
  let release;
  const gate = new Promise((r) => (release = r));
  const impl = async (url, opts) => {
    if (url.includes('/oauth/token')) {
      calls.token.push(JSON.parse(opts.body).refresh_token);
      await gate;
      return answer(calls.token.length);
    }
    const tok = String(opts.headers.Authorization).replace('Bearer ', '');
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    calls.usage.push(tok);
    return res(200, REAL_USAGE);
  };
  return { impl, calls, release: () => release() };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

await t('★ two readers of one expired idle slot at once cause ONE refresh, and both get the new token', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const f = gatedRefreshFetch();
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  // The /account view's read and the rotation's probe, exactly the two of 18:22.
  const view = r.usage.all();
  await tick();
  const probe = r.usage.one('third@example.com');
  await tick();
  f.release();
  const [{ rows }, probed] = await Promise.all([view, probe]);
  eq(f.calls.token.length, 1, 'a second refresh presented the refresh token the first one was spending');
  eq(f.calls.token[0], 'ref-c', 'the refresh presented the wrong token');
  eq(rows[2].state, 'ok', rows[2].error);
  eq(probed.state, 'ok', `the probe must get the refreshed token, not a failure: ${probed.error}`);
  eq(rowLoginProblem(probed), null, 'the probe was told the login is dead');
  ok(f.calls.usage.includes('acc-c-new'), 'nobody used the refreshed token');
  ok(!f.calls.usage.includes('acc-c'), 'the expired token was sent anyway');
  eq(r.onDisk()[2].claudeAiOauth.refreshToken, 'ref-c-new', 'the rotation must be banked');
});

await t('★ a reader that arrives right AFTER a refresh landed uses the banked token and presents nothing', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const f = gatedRefreshFetch();
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  f.release();
  await r.usage.all();
  const again = await r.usage.one('third@example.com');
  eq(f.calls.token.length, 1, 'the spent refresh token was presented again');
  eq(again.state, 'ok');
});

await t('★ a refresh token whose replacement never reached the disk is NEVER presented again', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const f = gatedRefreshFetch();
  f.release();
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  r.store.bankOauth = () => {
    throw new Error('EROFS: read-only file system');
  };
  const first = await r.usage.one('third@example.com');
  eq(first.state, 'persist-failed');
  const second = await r.usage.one('third@example.com');
  eq(f.calls.token.length, 1, 'the spent refresh token went out a second time');
  eq(second.state, 'persist-failed');
  eq(rowLoginProblem(second), 'a refreshed login could not be saved');
});

await t('★ a REFUSED refresh (invalid_grant) marks the row as a login problem; a 500 does not', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const refused = gatedRefreshFetch({ answer: () => res(400, { error: 'invalid_grant' }) });
  refused.release();
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: refused.impl });
  const row = await r.usage.one('third@example.com');
  eq(row.state, 'refresh-failed');
  eq(rowLoginProblem(row), 'login refused (invalid_grant)');
  // Refused once, never presented again (the second read is a dead login, not a retry).
  const again = await r.usage.one('third@example.com');
  eq(refused.calls.token.length, 1, 'a refused refresh token was presented again');
  eq(again.state, 'refresh-failed', 'a refused token is not a persist failure');
  eq(rowLoginProblem(again), 'login refused (invalid_grant)');
  ok(/refused earlier \(login refused \(invalid_grant\)\)/.test(again.error), again.error);

  const flaky = gatedRefreshFetch({ answer: () => res(503, {}) });
  flaky.release();
  const r2 = rig({ seed: JSON.parse(JSON.stringify(seed)), liveOauth: oauthFor('a'), fetchImpl: flaky.impl });
  const row2 = await r2.usage.one('third@example.com');
  eq(row2.state, 'refresh-failed');
  eq(rowLoginProblem(row2), null, 'a server having a bad minute says nothing about the login');
});

await t('★ only invalid_grant retires a login: a bare 401, a 403 page or invalid_client does not (QA)', async () => {
  for (const [status, body] of [[401, {}], [403, { error: 'forbidden' }], [401, { error: 'invalid_client' }], [403, null]]) {
    const seed = JSON.parse(JSON.stringify(SEED));
    seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
    const f = gatedRefreshFetch({ answer: () => (body ? res(status, body) : res(status, null, { json: false })) });
    f.release();
    const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
    const row = await r.usage.one('third@example.com');
    eq(row.state, 'refresh-failed', `${status} ${JSON.stringify(body)}`);
    eq(rowLoginProblem(row), null, `HTTP ${status} ${JSON.stringify(body)} retired a login`);
  }
});

await t('a 403 on an idle slot\'s usage lookup is not a dead login; a 401 is (QA)', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  const impl = async (url) => {
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(403, { error: { type: 'permission_error' } });
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  const { rows } = await r.usage.all();
  eq(rows[1].failure?.kind, 'refused');
  eq(rowLoginProblem(rows[1]), null, 'a 403 retired a login');
});

await t('with the live login UNIDENTIFIED, an expired-looking slot is not called dead (it may be the live one) (QA)', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[1].claudeAiOauth = oauthFor('b', { expiresAt: NOW - 60_000, refreshTokenExpiresAt: NOW - 86400_000 });
  // A live blob that matches no slot, and a profile lookup that fails.
  const impl = async () => res(500, {});
  const r = rig({ seed, liveOauth: oauthFor('zzz-unknown'), fetchImpl: impl });
  const { active, rows } = await r.usage.all();
  eq(active.name, null);
  eq(rows[1].state, 'credentials-expired');
  eq(rowLoginProblem(rows[1]), null, 'a slot that may be the live login was declared dead');
});

await t('a refused token on an IDLE slot is a login problem; on the LIVE slot it is not', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  const impl = async (url, opts) => {
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(401, { error: { type: 'authentication_error' } });
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  const { rows } = await r.usage.all();
  eq(rows[0].live, true);
  eq(rowLoginProblem(rows[0]), null, 'the live session refreshes its own token; a 401 there proves nothing');
  eq(rowLoginProblem(rows[1]), 'login refused (HTTP 401)');
  eq(rowLoginProblem(null), null);
  eq(rowLoginProblem({ state: 'unavailable', failure: { kind: 'timeout' } }), null);
});

await t('★ a slot already flagged as needing a login is not asked at all, and says what to do', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  seed[2].needsLogin = { reason: 'login refused (invalid_grant)', at: 'then', fingerprint: 'x' };
  const f = gatedRefreshFetch();
  f.release();
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  const row = await r.usage.one('third@example.com');
  eq(row.state, 'needs-login');
  eq(f.calls.token.length, 0, 'a flagged slot spent a refresh');
  ok(!f.calls.usage.includes('acc-c'), 'a flagged slot was asked for usage');
  eq(rowLoginProblem(row), 'login refused (invalid_grant)');
  ok(/\/account capture third@example\.com/.test(row.error), row.error);
});

await t('an expired login past its own refresh expiry is a login problem too', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[1].claudeAiOauth = oauthFor('b', { expiresAt: NOW - 60_000, refreshTokenExpiresAt: NOW - 86400_000 });
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: usageFetch({}).impl });
  const { rows } = await r.usage.all();
  eq(rows[1].state, 'credentials-expired');
  eq(rowLoginProblem(rows[1]), 'its login expired');
});

await t('a slot that became the LIVE login while its refresh was queued is never refreshed by the reader', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const f = gatedRefreshFetch();
  f.release();
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  // The reader resolves "a is live", then a swap lands the expired slot c in the
  // keychain before the refresh would go out.
  const readCreds = r.store.readCredentials;
  let calls = 0;
  r.store.readCredentials = async () => {
    calls++;
    return calls === 1 ? readCreds() : { claudeAiOauth: seed[2].claudeAiOauth };
  };
  const row = await r.usage.one('third@example.com');
  eq(f.calls.token.length, 0, 'the reader refreshed the live login out from under its session');
  eq(row.state, 'ok');
});

await t('★ a probe that arrives DURING a swap onto its slot does not refresh the login the swap just made live (QA)', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const f = gatedRefreshFetch();
  f.release();
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  const real = r.kc.run;
  let release;
  const gate = new Promise((res2) => (release = res2));
  let gated = true;
  r.kc.run = async (args, stdin) => {
    if (gated && args[0] === 'find-generic-password') await gate;
    return real(args, stdin);
  };
  const swap = r.store.swapTo('third@example.com');
  await tick();
  const probe = r.usage.one('third@example.com');
  await tick();
  gated = false;
  release();
  const [sw, row] = await Promise.all([swap, probe]);
  ok(sw.ok, sw.error);
  eq(f.calls.token.length, 0, 'the probe refreshed the slot the swap was installing: the live login now holds a spent refresh token');
  eq(r.kc.blob.claudeAiOauth.refreshToken, 'ref-c', 'the live login must be the slot as it was swapped in');
  eq(r.onDisk()[2].claudeAiOauth.refreshToken, 'ref-c', 'and the slot must agree with it');
  eq(rowLoginProblem(row), null, 'a live login was reported dead');
});

await t('★ a rotation swap that waited on a refresh sees the flag its LATE refusal raises, on a credential store that answers at once (QA)', async () => {
  // The macOS keychain read is a child process, and only that let the late
  // flag land before the swap re-read its target. A file store (the Linux
  // backend) answers in the same tick, and the swap installed the dead login
  // live unless it first let the flight's own readers finish (QA, 2026-09-30).
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const f = gatedRefreshFetch({ answer: () => res(400, { error: 'invalid_grant' }) });
  const credFile = path.join(TMP, `credentials-${n}.json`);
  writeFileSync(credFile, JSON.stringify({ claudeAiOauth: oauthFor('a'), mcpOAuth: { heygen: { token: 'machine-scoped' } } }), { mode: 0o600 });
  const file = path.join(TMP, `accounts-${n++}.json`);
  writeFileSync(file, JSON.stringify(seed, null, 2), { mode: 0o600 });
  const store = createAccountStore({ file, credentials: createFileStore({ path: credFile }), log: () => {} });
  const usage = createAccountUsage({ store, fetchImpl: f.impl, now: () => NOW, log: () => {} });
  invalidateUsageCache();
  // The bridge's probe after its deadline: the selector has already taken the
  // candidate as unreadable, so only this late reader can flag the refusal.
  const probe = usage.one('third@example.com');
  probe
    .then((row) => {
      const why = rowLoginProblem(row);
      if (why) store.markNeedsLogin('third@example.com', why);
    })
    .catch(() => {});
  await tick();
  eq(f.calls.token.length, 1, 'the probe should have its refresh in the air');
  const swap = store.swapTo('third@example.com', { refuseFlagged: true });
  f.release();
  const sw = await swap;
  eq(sw.ok, false, 'the rotation installed a login the server had just refused');
  eq(sw.needsLogin, true, 'the refusal must read as a dead target so the rotation selects again');
  eq(JSON.parse(readFileSync(credFile, 'utf8')).claudeAiOauth.refreshToken, 'ref-a', 'the live login must be untouched');
  ok(JSON.parse(readFileSync(file, 'utf8'))[2].needsLogin, 'the late refusal was not flagged');
});

await t('a refresh answered WITHOUT a new refresh token leaves that token usable (QA)', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const f = gatedRefreshFetch({ answer: () => res(200, { access_token: 'acc-c-new', expires_in: 1 }) });
  f.release();
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  const first = await r.usage.one('third@example.com');
  eq(first.state, 'ok');
  const second = await r.usage.one('third@example.com');
  eq(second.state, 'ok', `a refresh token the server kept was treated as spent: ${second.error}`);
  eq(rowLoginProblem(second), null);
  eq(f.calls.token.length, 2);
});

await t('a refused refresh keeps only a snake_case error code: nothing else from the body reaches the flag or the notice (QA)', async () => {
  const err = await refreshAccessToken({
    refreshToken: 'r',
    fetchImpl: async () => res(400, { error: 'sk-ant-oat01-LEAKED-TOKEN-VALUE' }),
  }).catch((e) => e);
  eq(err.code, null);
  ok(!err.message.includes('sk-ant'), err.message);
  eq(err.message, 'token refresh rejected: HTTP 400');
});

await t('refresh_token_expires_in dates the NEW refresh token, as Claude Code reads it', async () => {
  const blob = await refreshAccessToken({
    refreshToken: 'r',
    now: NOW,
    previous: { refreshTokenExpiresAt: NOW - 1000 },
    fetchImpl: async () => res(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 28800, refresh_token_expires_in: 2592000 }),
  });
  eq(blob.refreshTokenExpiresAt, NOW + 2592000 * 1000, 'the old token expiry was carried over the new one');
  const err = await refreshAccessToken({ refreshToken: 'r', fetchImpl: async () => res(400, { error: 'invalid_grant' }) }).catch((e) => e);
  eq([err.rejected, err.status, err.code], [true, 400, 'invalid_grant']);
});

await t('a slot with no credentials is reported, not skipped', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  delete seed[1].claudeAiOauth;
  const f = usageFetch({});
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  const { rows } = await r.usage.all();
  eq(rows[1].state, 'no-credentials');
});

await t('when the live account cannot be identified, NOTHING is refreshed', async () => {
  // Rule 2: an unidentifiable keychain means any refresh might be racing the
  // live session, so an expired idle token degrades instead of rotating.
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.includes('/oauth/profile')) return res(403, {}); // profile fallback fails too
    if (url.includes('/oauth/token')) return res(200, { access_token: 'nope', expires_in: 1 });
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('stranger'), fetchImpl: impl });
  const { active, rows } = await r.usage.all();
  eq(active.name, null);
  eq(calls.filter((u) => u.includes('/oauth/token')).length, 0, 'a refresh ran with the live account unknown');
  eq(rows[2].state, 'unavailable');
  ok(/could not be identified/.test(rows[2].error));
  eq(rows[0].state, 'ok', 'the accounts with valid tokens still report');
});

await t('a usage call that fails degrades to "usage unavailable" and never breaks the reply', async () => {
  const f = usageFetch({ 'acc-b': 'fail' });
  const r = rig({ seed: SEED, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  const { rows } = await r.usage.all();
  eq(rows[1].state, 'unavailable');
  eq(rows[1].usage, null);
  eq(rows[0].state, 'ok');
  eq(usageLine(rows[1]), null, '/status must omit the line, not print an error into a liveness view');
  // Same property as before the /account rewrite: a dead usage call becomes a
  // visible reason on that account's row, never a blank and never an exception.
  // A plain server error keeps the words and gains its status code.
  eq(accountUsageBlock(rows[1]), ['   ⚠️ usage unavailable (HTTP 500)']);
});

await t('every account is fetched CONCURRENTLY, so one slow account does not serialise the rest', async () => {
  let inFlight = 0;
  let peak = 0;
  const impl = async (url) => {
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r2) => setTimeout(r2, 20));
    inFlight--;
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed: SEED, liveOauth: oauthFor('a'), fetchImpl: impl });
  await r.usage.all();
  eq(peak, 3, 'the three usage reads ran in series');
});

// ---------------------------------------------------------------------------
// TTL CACHE
// ---------------------------------------------------------------------------

await t('a second read inside the TTL serves the cache and makes no second request', async () => {
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  await r.usage.all();
  const first = f.calls.length;
  const again = await r.usage.all();
  eq(f.calls.length, first, 'the cache was bypassed; /status would hit the API on every call');
  eq(again.rows[0].cached, true);
  eq(again.rows[0].usage.fiveHour.percent, 32, 'a cached row must still carry its numbers');
});

await t('the cache expires, and invalidateUsageCache() drops it immediately', async () => {
  const f = usageFetch({});
  let clock = NOW;
  const file = path.join(TMP, `accounts-ttl.json`);
  writeFileSync(file, JSON.stringify(SEED, null, 2), { mode: 0o600 });
  const kc = fakeKeychain({ claudeAiOauth: oauthFor('a') });
  const store = createAccountStore({ file, credentials: createKeychainStore({ account: 'owner', runSecurity: (...a) => kc.run(...a) }), log: () => {} });
  const usage = createAccountUsage({ store, fetchImpl: f.impl, now: () => clock, ttlMs: 60_000, log: () => {} });
  invalidateUsageCache();

  await usage.all();
  const first = f.calls.length;
  clock = NOW + 59_000;
  await usage.all();
  eq(f.calls.length, first, 'the cache expired early');
  clock = NOW + 61_000;
  await usage.all();
  ok(f.calls.length > first, 'the cache never expired, so /usage would show a stale window forever');

  const second = f.calls.length;
  invalidateUsageCache();
  await usage.all();
  ok(f.calls.length > second, 'invalidateUsageCache() did not force a re-read (post-swap /account would lie)');
});

await t('activeOnly() reads just the live account, for /status', async () => {
  const f = usageFetch({ 'acc-b': 44 });
  const r = rig({ seed: SEED, liveOauth: oauthFor('b'), fetchImpl: f.impl });
  const { active, row } = await r.usage.activeOnly();
  eq(active.name, 'first@example.com');
  eq(row.state, 'ok');
  eq(row.usage.fiveHour.percent, 44);
  eq(f.calls.filter((c) => c.url.includes('/oauth/usage')).length, 1, '/status must not fetch all three accounts');
});

await t('activeOnly() still reports usage for a live login that is not enrolled as a slot', async () => {
  // A login nobody ran /account capture on still has a working keychain token.
  // Reporting "no credentials captured" for the account that is ACTUALLY
  // running would be the most misleading line /status could print.
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, tok: String(opts.headers.Authorization).replace('Bearer ', '') });
    if (url.includes('/oauth/profile')) {
      return res(200, { ...REAL_PROFILE, account: { ...REAL_PROFILE.account, email: 'fourth@example.com' } });
    }
    const body = JSON.parse(JSON.stringify(REAL_USAGE));
    body.limits[0].percent = 61;
    return res(200, body);
  };
  const f = { calls };
  const r = rig({ seed: SEED, liveOauth: oauthFor('stranger'), fetchImpl: impl });
  const { active, row } = await r.usage.activeOnly();
  eq(active.matchedBy, 'profileEmailUnenrolled', 'the profile email matches no enrolled slot');
  eq(active.email, 'fourth@example.com');
  eq(row.state, 'ok');
  eq(row.live, true);
  eq(row.usage.fiveHour.percent, 61);
  eq(f.calls.filter((c) => c.url.includes('/oauth/token')).length, 0, 'the LIVE account must never be refreshed');
  ok(usageLine(row, { now: NOW }).includes('5h 61%'), usageLine(row, { now: NOW }));
});

await t('activeOnly() with an unreadable keychain returns no row rather than throwing', async () => {
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: null, fetchImpl: f.impl });
  const { row } = await r.usage.activeOnly();
  eq(row, null);
});

// ---------------------------------------------------------------------------
// RENDERERS — the exact strings the owner reads on their phone
// ---------------------------------------------------------------------------

const OK_ROW = {
  name: 'second@example.com',
  email: 'second@example.com',
  live: true,
  state: 'ok',
  usage: normalizeUsage(REAL_USAGE),
};

await t('activeLine names the live account — the "Active: unknown" bug, in one string', () => {
  // The name is in a CODE span, not bold. Telegram auto-linkifies a bare email
  // in message text into a blue mailto link; a code entity claims the range so
  // no email entity is emitted over it. Asserted as an exact string here (and
  // by the no-bare-email test below across every renderer) so a future refactor
  // back to **bold** fails loudly instead of quietly restoring the blue links.
  eq(
    activeLine({ name: 'second@example.com', matchedBy: 'refreshToken', liveFingerprint: 'a…8dkwAA/r…U7DQAA' }),
    'Active: `second@example.com` `a…8dkwAA/r…U7DQAA`',
  );
  // The real case on this machine: the running session refreshed its own token,
  // so nothing fingerprint-matches and the profile email is what identifies it.
  eq(
    activeLine({ name: 'second@example.com', matchedBy: 'profileEmail', liveFingerprint: 'a…8dkwAA/r…U7DQAA' }),
    'Active: `second@example.com` `a…8dkwAA/r…U7DQAA` (identified by profile — its tokens have rotated since capture)',
  );
  eq(
    activeLine({ name: null, email: 'fourth@example.com', matchedBy: 'profileEmailUnenrolled', liveFingerprint: 'a…X/r…Y' }),
    'Active: `fourth@example.com` `a…X/r…Y` — signed in but not enrolled, run /account capture <name> to bank it',
  );
  // Only when BOTH the fingerprint and the profile fail is it genuinely unknown.
  eq(activeLine({ name: null, email: null, liveFingerprint: 'a…X/r…Y' }), 'Active: unknown `a…X/r…Y`, run /account capture <name> to bank it');
  eq(activeLine(null), 'Active: unknown `none`, run /account capture <name> to bank it');
  eq(activeLine({}), 'Active: unknown `none`, run /account capture <name> to bank it');
});

await t('usageLine is the one compact /status line, and nothing more', () => {
  const line = usageLine(OK_ROW, { now: NOW });
  ok(line.startsWith('👤 second@example.com'), line);
  ok(/5h 32% · resets .+ · .+ left/.test(line), `5h must carry BOTH the clock and the countdown: ${line}`);
  ok(/wk 24% · resets .+ · .+ left/.test(line), `wk must carry BOTH the clock and the countdown: ${line}`);
  eq(line.split('\n').length, 3, 'one header + one row per window');
  eq(usageLine(null), null);
  eq(usageLine({ state: 'unavailable' }), null);
  eq(usageLine({ name: 'x', state: 'ok', usage: { fiveHour: null, sevenDay: null, scoped: [] } }), null);
});

// REPLACES the old accountUsageSuffix test. That test protected four
// properties of the per-account usage lines on /account: one line per window,
// the reset CLOCK present, the time LEFT present, a locked window flagged, and
// an error row passed through verbatim rather than swallowed. The suffix is now
// a bar block (accountUsageBlock) instead of a bare inline; every one of those
// properties is asserted below on the new shape, plus the bar itself.
await t('accountUsageBlock carries the bar, the reset clock AND the time left, and flags a locked window', () => {
  const b = accountUsageBlock(OK_ROW, { now: NOW });
  eq(b.length, 2, 'one row per window');
  ok(/^   `5h ███░░░░░░░  32%` resets /.test(b[0]), b[0]);
  ok(/^   `wk ██░░░░░░░░  24%` resets /.test(b[1]), b[1]);
  // Both halves, still: the clock says WHEN, the span says HOW LONG. Only the
  // trailing word "left" was dropped, so the span must still be there.
  ok(/resets 6:10pm · 17m$/.test(b[0]), `the 5h row lost its clock or its countdown: ${b[0]}`);
  ok(/resets Sat 1:00am · 4d 7h$/.test(b[1]), `the wk row lost its clock or its countdown: ${b[1]}`);
  // The bar must be usageBar()'s output, not a second renderer's: same account,
  // same percent, the /usage view and this one have to agree cell for cell.
  ok(b[0].includes(usageBar(32)) && b[1].includes(usageBar(24)), 'the bars drifted from usageBar()');

  const locked = JSON.parse(JSON.stringify(OK_ROW));
  locked.usage.fiveHour.percent = 100;
  locked.usage.fiveHour.locked = 'usage_limit_reached';
  ok(accountUsageBlock(locked, { now: NOW })[0].includes('100%` ⛔'), 'a locked window must still be flagged');
  // An error row is passed through verbatim — never swallowed into a blank.
  eq(
    accountUsageBlock({ state: 'refresh-failed', error: 'token refresh rejected: HTTP 400 (invalid_grant)' })[0],
    '   ⚠️ token refresh rejected: HTTP 400 (invalid_grant)',
  );
  eq(accountUsageBlock(null), [], 'no usage row means no lines, not a fabricated one');
});

const ACCT_ROWS = [
  { name: 'second@example.com', fingerprint: 'a…f-rwAA/r…qGHAAA', captured: true, limited: false, limitedUntil: null, lastActiveAt: new Date(NOW - 6 * 60_000).toISOString() },
  { name: 'first@example.com', fingerprint: 'a…QVmgAA/r…f0NAAA', captured: true, limited: false, limitedUntil: null, lastActiveAt: new Date(NOW - 3 * 86_400_000).toISOString() },
  { name: 'third@example.com', fingerprint: 'a…AAAAAA/r…BBBBBB', captured: true, limited: true, limitedUntil: Math.round((NOW + 130 * 60_000) / 1000), lastActiveAt: null },
];
const ACCT_USAGE = [
  { name: 'second@example.com', state: 'ok', usage: normalizeUsage(REAL_USAGE) },
  { name: 'first@example.com', state: 'ok', usage: normalizeUsage(REAL_USAGE) },
];

await t('renderAccountList puts the LIVE account first and marks it', () => {
  // The live one is second in the file. They open /account to see where they are,
  // so it has to be the first thing on the screen, not found by hunting ▶︎.
  const out = renderAccountList(
    { rows: ACCT_ROWS, live: { name: 'first@example.com', matchedBy: 'refreshToken', liveFingerprint: 'a…X/r…Y' }, usageRows: ACCT_USAGE },
    { now: NOW, timeZone: OWNER_TZ },
  );
  const names = [...out.matchAll(/^(▶︎|• ) `(.+?)`/gm)].map((m) => [m[1], m[2]]);
  eq(names[0], ['▶︎', 'first@example.com'], `the live account was not first:\n${out}`);
  eq(names.length, 3, 'an account went missing from the list');
  eq(names.filter(([m]) => m === '▶︎').length, 1, 'exactly one row is the live one');
  // ▶︎ already says which one is live, so the Active: header is redundant here.
  ok(!out.includes('Active:'), `the redundant Active: header survived:\n${out}`);
});

await t('renderAccountList keeps the Active: header ONLY when ▶︎ can say nothing', () => {
  // Signed in but not enrolled: no row can carry ▶︎, so the header is the only
  // thing naming the live login — and its fingerprint is the only handle on it.
  const unenrolled = renderAccountList(
    { rows: ACCT_ROWS, live: { name: null, email: 'fourth@example.com', matchedBy: 'profileEmailUnenrolled', liveFingerprint: 'a…X/r…Y' }, usageRows: ACCT_USAGE },
    { now: NOW },
  );
  ok(unenrolled.includes('Active: `fourth@example.com` `a…X/r…Y`'), unenrolled);
  ok(unenrolled.includes('signed in but not enrolled'), unenrolled);
  // Unidentifiable entirely.
  const unknown = renderAccountList({ rows: ACCT_ROWS, live: { liveFingerprint: 'a…X/r…Y' }, usageRows: [] }, { now: NOW });
  ok(unknown.includes('Active: unknown `a…X/r…Y`'), unknown);
  // A live name that DOES match a slot gets no header.
  const matched = renderAccountList({ rows: ACCT_ROWS, live: { name: 'second@example.com' }, usageRows: ACCT_USAGE }, { now: NOW });
  ok(!matched.includes('Active:'), matched);
});

await t('renderAccountList drops the daily noise and keeps the states that are not the default', () => {
  const out = renderAccountList(
    { rows: ACCT_ROWS, live: { name: 'second@example.com' }, usageRows: ACCT_USAGE },
    { now: NOW, timeZone: OWNER_TZ },
  );
  // Fingerprints moved to /usage: three token digests on the daily view were
  // clutter once "Active: unknown" was fixed.
  ok(!out.includes('a…f-rwAA'), `a fingerprint is still on the /account rows:\n${out}`);
  ok(!out.includes('a…QVmgAA') && !out.includes('a…AAAAAA'), 'a fingerprint is still on the /account rows');
  // "✅ available" is the default state; the absence of ⛔ already says it.
  ok(!out.includes('✅'), `the redundant availability tick survived:\n${out}`);
  // ⛔ limited keeps its remaining time.
  ok(/⛔ limited · 2h 10m/.test(out), `the limited row lost its countdown:\n${out}`);
  // "last used 6m ago" on the row you are looking at is noise; three days idle
  // is not, and is the only version of that fact that survives.
  ok(!out.includes('last used'), 'the noisy last-used line survived');
  ok(!/idle 6m/.test(out), 'a six-minute-old account was reported as idle');
  ok(/idle 3d/.test(out), `a three-day-idle account lost its idle marker:\n${out}`);
  // An account with no usage row still appears, with a reason.
  ok(out.includes('third@example.com'), 'an account without usage vanished from the list');
  ok(out.includes('⚠️ usage unavailable'), out);
  // One footer line, and it no longer documents /account capture (that is /help).
  const tail = out.trim().split('\n').slice(-1)[0];
  eq(tail, 'Tap to swap · /usage for detail');
  ok(!out.includes('/account capture'), 'the footer still carries the capture form');
});

await t('renderAccountList still marks an uncaptured slot, and survives an empty list', () => {
  const rows = [{ name: 'empty@slot.app', fingerprint: 'none', captured: false, limited: false }];
  const out = renderAccountList({ rows, live: { name: 'empty@slot.app' }, usageRows: [] }, { now: NOW });
  ok(out.includes('⚠️ no credentials captured'), out);
  const none = renderAccountList({ rows: [], live: null, usageRows: [] }, { now: NOW });
  ok(none.includes('Active: unknown'), 'an empty list must still say what the live login is');
  ok(none.includes('👤'), none);
});

await t('usageBrief is the one-line headroom summary, and never invents one', () => {
  eq(usageBrief({ state: 'ok', usage: normalizeUsage(REAL_USAGE) }), '5h 32% · wk 24%');
  eq(usageBrief(null), null);
  eq(usageBrief({ state: 'unavailable', usage: null }), null, 'a broken row must not render as 0%');
  eq(usageBrief({ state: 'ok', usage: { fiveHour: null, sevenDay: null, scoped: [] } }), null);
  const locked = normalizeUsage(REAL_USAGE);
  locked.fiveHour = { percent: 100, resetsAt: null, severity: null, locked: 'usage_limit_reached' };
  ok(usageBrief({ state: 'ok', usage: locked }).startsWith('5h 100% ⛔'), 'a locked window must be flagged here too');
});

await t('swapConfirmation stands on its own in three lines or fewer', () => {
  const full = swapConfirmation({ to: 'first@example.com', from: 'second@example.com', usage: { state: 'ok', usage: normalizeUsage(REAL_USAGE) } });
  eq(full, ['🔄 Now on `first@example.com`', 'was `second@example.com` · MCP tokens kept', '5h 32% · wk 24%'].join('\n'));
  ok(full.split('\n').length <= 3, 'the confirmation grew past three lines');
  // No cached usage: the third line is OMITTED rather than the confirmation
  // being delayed by a network read for it.
  eq(swapConfirmation({ to: 'a@b.c', from: 'd@e.f', usage: null }).split('\n').length, 2);
  // No previous account (nothing matched a slot) — the line still reads.
  eq(swapConfirmation({ to: 'a@b.c' }), '🔄 Now on `a@b.c`\nMCP tokens kept');
});

await t('swapFailure keeps the routine/urgent distinction accounts.mjs draws', () => {
  // Routine: the keychain write failed but rolled back, so nothing moved.
  const routine = swapFailure({ to: 'first@example.com', error: 'keychain write failed; the previous account is still active and nothing changed' });
  ok(routine.startsWith('❌ Swap to `first@example.com` failed'), routine);
  ok(routine.includes('the previous account is still active'), routine);
  ok(routine.endsWith('The live account is unchanged.'), routine);
  // Urgent: the rollback did NOT take, so no worker can start until they log in.
  const urgent = swapFailure({ to: 'first@example.com', error: 'keychain write failed AND the rollback did not take. Run: claude /login' });
  ok(urgent.startsWith('🚨'), `the urgent failure reads like the routine one:\n${urgent}`);
  ok(urgent.includes('claude /login'), 'the urgent failure lost the instruction that fixes it');
  ok(urgent.includes('No worker can start'), urgent);
  ok(!routine.startsWith('🚨'), 'the routine failure was escalated to urgent');
  // A missing error string still produces a message rather than "undefined".
  ok(swapFailure({ to: 'a@b.c' }).includes('the swap returned no result'));
  // The names WE write are code-wrapped at the point we write them; the ones
  // inside an error string arrive as prose from accounts.mjs and Telegram
  // linkifies them just the same. `/account bogus@x.com` produces exactly that.
  const typo = swapFailure({ to: 'bogus@x.com', error: 'no account slot named "bogus@x.com". Run /account capture bogus@x.com first' });
  eq(typo.replace(/`[^`\n]*`/g, '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g), null, typo);
  const conflict = captureFailure('Slot "shared" belongs to someone@else.com, not new@example.com. Use /account capture <name>.');
  eq(conflict.replace(/`[^`\n]*`/g, '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g), null, conflict);
  // ...and wrapping must not double-wrap or mangle the surrounding prose.
  ok(conflict.includes('belongs to `someone@else.com`, not `new@example.com`.'), conflict);
  ok(!conflict.includes('``'), `an address was double-wrapped:\n${conflict}`);
});

await t('the 🚨 failure names the one-time backup as the recovery path — and ONLY the 🚨 one', () => {
  const urgentMsg = 'keychain write failed AND the rollback did not take. Run: claude /login';
  const routineMsg = 'keychain write failed; the previous account is still active and nothing changed';
  const backupPath = '/some/dir/accounts.backup.json';
  const urgent = swapFailure({ to: 'first@example.com', error: urgentMsg, backupPath });
  ok(urgent.includes('accounts.backup.json'), `the 🚨 case must point at the backup:\n${urgent}`);
  ok(urgent.includes('`blob`'), 'the message must say WHICH key is the keychain payload');
  // Routine failures damaged nothing; naming a recovery file would imply they had.
  const routine = swapFailure({ to: 'first@example.com', error: routineMsg, backupPath });
  ok(!routine.includes('backup'), `a routine failure must not read like a disaster:\n${routine}`);
  // No backup on disk yet → no line, even on the 🚨 case.
  ok(!swapFailure({ to: 'a@b.c', error: urgentMsg }).includes('backup'), 'a backup that does not exist was advertised');
});

await t('a parked blob puts one warning line on /account, and none rides when nothing is parked', () => {
  const unclaimed = { fingerprint: 'a…AAAAAA/r…BBBBBB', email: 'fourth@somewhere.app', seenAt: new Date(NOW).toISOString(), note: '' };
  const out = renderAccountList(
    { rows: ACCT_ROWS, live: { name: 'first@example.com' }, usageRows: ACCT_USAGE, unclaimed },
    { now: NOW, timeZone: OWNER_TZ },
  );
  ok(out.includes('⚠️ unclaimed credentials parked'), `the parked warning is invisible:\n${out}`);
  ok(out.includes('/account capture <name> to claim'), 'the warning must say how to claim it');
  ok(out.includes('`fourth@somewhere.app`'), 'a known identity should be named (code-wrapped, like every email here)');
  ok(!out.includes(unclaimed.email + ' '), 'the email must be code-wrapped, not bare');
  const clean = renderAccountList(
    { rows: ACCT_ROWS, live: { name: 'first@example.com' }, usageRows: ACCT_USAGE },
    { now: NOW, timeZone: OWNER_TZ },
  );
  ok(!clean.includes('unclaimed'), 'the warning must not ride when nothing is parked');
  // An unidentified parked blob still warns, with the fingerprint as its only handle.
  const anon = unclaimedLine({ fingerprint: 'a…XXXXXX/r…YYYYYY', email: null });
  ok(anon.includes('a…XXXXXX/r…YYYYYY') && !anon.includes('from'), anon);
});

await t('captureConfirmation names the slot and the blob it banked', () => {
  eq(
    captureConfirmation({ slot: 'first@example.com', fingerprint: 'a…QVmgAA/r…f0NAAA', replaced: true }),
    '📸 Captured the current login into `first@example.com`\nReplaced what was there · `a…QVmgAA/r…f0NAAA`',
  );
  ok(captureConfirmation({ slot: 'new@slot.app', fingerprint: 'a…X/r…Y' }).includes('New slot'), 'a fresh slot claimed to replace something');
  eq(captureFailure('no readable claudeAiOauth in the keychain'), '❌ Capture failed\nno readable claudeAiOauth in the keychain');
  ok(captureFailure().includes('the capture returned no result'));
});

await t('NO renderer leaves a bare email for Telegram to turn into a mailto link', () => {
  // The defect: every account name on /account rendered as a blue tappable
  // link, and a mis-tap opened a mail composer. The fix is a code span, whose
  // range Telegram will not emit an overlapping email entity over. This asserts
  // the property across every surface at once, so a new renderer cannot
  // reintroduce it by writing the name a fourth way.
  const surfaces = [
    renderAccountList({ rows: ACCT_ROWS, live: { name: 'first@example.com' }, usageRows: ACCT_USAGE }, { now: NOW }),
    renderAccountList({ rows: ACCT_ROWS, live: { name: null, email: 'fourth@example.com' }, usageRows: [] }, { now: NOW }),
    renderUsageReport(
      { active: { name: 'second@example.com', liveFingerprint: 'a…X/r…Y' }, rows: [{ ...OK_ROW, fingerprint: 'a…X/r…Y' }] },
      { now: NOW },
    ),
    activeLine({ name: 'second@example.com', liveFingerprint: 'a…X/r…Y' }),
    swapConfirmation({ to: 'first@example.com', from: 'second@example.com' }),
    swapFailure({ to: 'first@example.com', error: 'keychain write failed; the previous account is still active and nothing changed' }),
    captureConfirmation({ slot: 'first@example.com', fingerprint: 'a…X/r…Y', replaced: true }),
  ];
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  for (const s of surfaces) {
    // Strip every code span, then look for a surviving email address.
    const outside = s.replace(/`[^`\n]*`/g, '');
    const leaked = outside.match(EMAIL);
    eq(leaked, null, `an email address rendered outside a code span (Telegram will linkify it):\n${outside}`);
  }
});

await t('renderUsageReport prints bars, percents, THEIR clock and time left for every account', () => {
  const rows = [
    { ...OK_ROW, live: true, fingerprint: 'a…f-rwAA/r…qGHAAA' },
    { name: 'first@example.com', live: false, state: 'ok', fingerprint: 'a…QVmgAA/r…f0NAAA', usage: normalizeUsage(REAL_USAGE) },
    { name: 'third@example.com', live: false, state: 'unavailable', error: 'usage unavailable', usage: null },
  ];
  const out = renderUsageReport({ active: { name: 'second@example.com', matchedBy: 'refreshToken', liveFingerprint: 'a…X/r…Y' }, rows }, { now: NOW, timeZone: OWNER_TZ });
  // Names are code spans, not bold, on this view too: /usage renders the same
  // email addresses and Telegram linkifies them the same way. The property the
  // old **bold** assertions protected — the report names the live account and
  // marks exactly which row it is — is asserted unchanged, on the new markup.
  ok(out.includes('Active: `second@example.com`'), 'the report must name the live account');
  ok(out.includes('▶︎ `second@example.com`'), 'the active account must be marked');
  ok(out.includes('• `first@example.com`'));
  // The fingerprints that left /account landed HERE — this is the diagnostic
  // view, and telling three accounts apart is exactly what it is for.
  ok(out.includes('▶︎ `second@example.com` `a…f-rwAA/r…qGHAAA`'), `the per-row fingerprint is missing from /usage:\n${out}`);
  ok(out.includes('• `first@example.com` `a…QVmgAA/r…f0NAAA`'), 'the idle rows lost their fingerprint too');
  ok(out.includes('5h `███░░░░░░░` 32%'), `missing the 5h bar:\n${out}`);
  ok(out.includes('wk `██░░░░░░░░` 24%'), 'missing the weekly bar');
  ok(out.includes('resets 6:10pm · 17m left'), `missing their local 5h reset clock:\n${out}`);
  ok(out.includes('Sat 5 Sep 1:00am'), 'missing the weekly reset in their zone');
  ok(out.includes('Fable'), 'the per-model weekly_scoped row was dropped');
  ok(out.includes('⚠️ usage unavailable'), 'a broken account must still appear');
  ok(out.includes(OWNER_TZ), 'the reply must say which clock it is quoting');
  ok(!out.includes('extra usage'), 'extra_usage is disabled on this account and must not be shown');
});

await t('a 0% window with no resets_at reads as full headroom, not as missing data', () => {
  // Observed live on first@example.com: the API sends resets_at:null for
  // five_hour when no 5-hour block is open. That account is the BEST one to
  // start the next job on, so it must not render as a hole in the report.
  const u = normalizeUsage(REAL_USAGE);
  u.fiveHour = { percent: 0, resetsAt: null, severity: 'normal', locked: null };
  const out = renderUsageReport({ active: { name: 'a' }, rows: [{ name: 'a', live: true, state: 'ok', usage: u }] }, { now: NOW });
  ok(out.includes('no active block — full headroom'), out);
  // ...but a window that HAS been used and lacks a reset time must not claim that.
  u.fiveHour = { percent: 44, resetsAt: null, severity: 'normal', locked: null };
  const used = renderUsageReport({ active: { name: 'a' }, rows: [{ name: 'a', live: true, state: 'ok', usage: u }] }, { now: NOW });
  ok(used.includes('no reset time'), used);
  ok(!used.includes('full headroom'), 'a 44%-consumed window was reported as full headroom');
});

await t('renderUsageReport shows extra usage only when it is enabled', () => {
  const u = normalizeUsage(REAL_USAGE);
  u.extraUsage = { enabled: true, percent: 12, usedCredits: 6000, monthlyLimit: 50000 };
  const out = renderUsageReport({ active: { name: 'a' }, rows: [{ name: 'a', live: true, state: 'ok', usage: u }] }, { now: NOW });
  ok(out.includes('extra usage 12%'), out);
  ok(out.includes('6000 credits used'));
});

await t('renderUsageReport degrades cleanly with no accounts and with an unknown active login', () => {
  const empty = renderUsageReport({ active: { name: null, liveFingerprint: 'a…8dkwAA/r…U7DQAA' }, rows: [] }, { now: NOW });
  ok(empty.includes('Active: unknown'));
  ok(empty.includes('No accounts captured yet'));
  const unenrolled = renderUsageReport(
    { active: { name: null, email: 'someone@else.com', matchedBy: 'profileEmailUnenrolled' }, rows: [] },
    { now: NOW },
  );
  ok(unenrolled.includes('someone@else.com'), 'a real identity beats printing "unknown"');
  ok(unenrolled.includes('/account capture'));
});

await t('no renderer can emit a token, even when handed one', () => {
  // Belt and braces: the shapes the renderers consume carry no token field, so
  // the only way one could appear is a future refactor passing the raw slot.
  const poisoned = {
    name: 'second@example.com',
    live: true,
    state: 'ok',
    usage: normalizeUsage(REAL_USAGE),
    claudeAiOauth: { accessToken: 'sk-ant-oat01-SHOULD-NEVER-RENDER', refreshToken: 'sk-ant-ort01-ALSO-NEVER' },
  };
  const all = [
    usageLine(poisoned),
    accountUsageBlock(poisoned).join('\n'),
    renderAccountList({ rows: [{ ...poisoned, captured: true }], live: { name: poisoned.name }, usageRows: [poisoned] }, { now: NOW }),
    swapConfirmation({ to: poisoned.name, from: 'x@y.z', usage: poisoned }),
    renderUsageReport({ active: { name: 'second@example.com' }, rows: [poisoned] }, { now: NOW }),
  ].join('\n');
  ok(!all.includes('SHOULD-NEVER-RENDER'), 'a renderer printed an access token');
  ok(!all.includes('ALSO-NEVER'), 'a renderer printed a refresh token');
});

// ---------------------------------------------------------------------------
// WHY A READ FAILED, and the 429 hold
//
// Probed live 2026-09-22: /api/oauth/usage answered 429 rate_limit_error while
// /api/oauth/profile answered 200 on the same token with hours left on it. The
// account was fine, the screen said "usage unavailable", and every /account tap
// asked the throttled endpoint again. These pin the reason on the row, the
// specific line on both views, and the hold.
// ---------------------------------------------------------------------------

const resH = (status, body, headers = {}) => ({
  ...res(status, body),
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
});

const RATE_LIMITED_LINE = 'usage lookup rate limited by Anthropic, try again in a few minutes (the account itself is fine)';
const DASHES = /[\u2013\u2014]/;

// Usage for every token except `failTok`, which gets whatever answer() returns
// (or throws). Counts usage calls per token, which is what the hold is about.
function failingFetch(failTok, answer) {
  const calls = [];
  const impl = async (url, opts) => {
    const tok = String(opts.headers.Authorization).replace('Bearer ', '');
    calls.push({ url, tok });
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    if (url.includes('/oauth/usage')) return tok === failTok ? answer(opts) : res(200, REAL_USAGE);
    return res(404, {});
  };
  return { impl, calls, usageCalls: (tok) => calls.filter((c) => c.url.includes('/oauth/usage') && c.tok === tok).length };
}

// A reader whose clock the test moves.
function clockRig(fetchImpl, { liveOauth = oauthFor('a'), timeoutMs } = {}) {
  const clock = { t: NOW };
  const logs = [];
  const file = path.join(TMP, `accounts-${n++}.json`);
  writeFileSync(file, JSON.stringify(SEED, null, 2), { mode: 0o600 });
  const kc = fakeKeychain({ claudeAiOauth: liveOauth });
  const store = createAccountStore({ file, credentials: createKeychainStore({ account: 'owner', runSecurity: (...a) => kc.run(...a) }), log: () => {} });
  const usage = createAccountUsage({
    store,
    fetchImpl,
    now: () => clock.t,
    ttlMs: 60_000,
    log: (m) => logs.push(m),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  invalidateUsageCache();
  return { clock, store, usage, logs };
}

// Both views, rendered exactly the way the bridge renders them.
async function bothViews(r) {
  const snap = await r.usage.all();
  const account = renderAccountList({ rows: r.store.describe(), live: snap.active, usageRows: snap.rows }, { now: r.clock.t, timeZone: OWNER_TZ });
  const usage = renderUsageReport(snap, { now: r.clock.t, timeZone: OWNER_TZ });
  return { snap, account, usage };
}

await t('fetchUsageResult says WHY there are no numbers, and fetchUsage still says only null', async () => {
  const cases = [
    ['429', () => resH(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, { 'retry-after': '30' }), { kind: 'rate-limited', status: 429, code: 'rate_limit_error', retryAfterMs: 30_000 }],
    ['429, no header', () => res(429, {}), { kind: 'rate-limited', status: 429, code: null, retryAfterMs: null }],
    ['401', () => res(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }), { kind: 'refused', status: 401, code: 'authentication_error' }],
    ['403', () => res(403, { type: 'error', error: { type: 'permission_error' } }), { kind: 'refused', status: 403, code: 'permission_error' }],
    ['500', () => res(500, {}), { kind: 'http', status: 500, code: null }],
    ['529 non JSON', () => res(529, null, { json: false }), { kind: 'http', status: 529, code: null }],
    ['200 non JSON', () => res(200, null, { json: false }), { kind: 'unreadable', status: 200, code: null }],
    ['200 unrecognised', () => res(200, { nothing: 'here' }), { kind: 'unreadable', status: 200, code: null }],
    ['nothing', () => undefined, { kind: 'unreadable', status: null, code: null }],
    [
      'abort',
      () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        throw e;
      },
      { kind: 'timeout', status: null, code: null },
    ],
    [
      'DNS',
      () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
      },
      { kind: 'network', status: null, code: null },
    ],
  ];
  for (const [label, answer, want] of cases) {
    const r = await fetchUsageResult('tok', { fetchImpl: async () => answer(), now: NOW });
    eq(r.usage, null, label);
    eq(r.failure, want, label);
    eq(await fetchUsage('tok', { fetchImpl: async () => answer() }), null, `${label}: fetchUsage must stay null-or-numbers`);
  }
  const good = await fetchUsageResult('tok', { fetchImpl: async () => res(200, REAL_USAGE) });
  eq(good.failure, null);
  eq(good.usage.fiveHour.percent, 32);
});

await t('usageFailureText: one line per reason, none with an em or en dash', () => {
  eq(usageFailureText({ kind: 'rate-limited', status: 429 }), RATE_LIMITED_LINE);
  eq(usageFailureText({ kind: 'refused', status: 401 }, { name: 'a@b.co' }), 'login refused (HTTP 401), run /account capture `a@b.co` after logging in');
  eq(usageFailureText({ kind: 'refused', status: 403 }), 'login refused (HTTP 403), run /account capture `<name>` after logging in');
  eq(usageFailureText({ kind: 'timeout' }), 'usage lookup timed out');
  eq(usageFailureText({ kind: 'network' }), 'usage lookup failed (network error)');
  eq(usageFailureText({ kind: 'http', status: 502 }), 'usage unavailable (HTTP 502)');
  eq(usageFailureText({ kind: 'unreadable', status: 200 }), 'usage unavailable');
  eq(usageFailureText(null), 'usage unavailable');
  for (const kind of ['rate-limited', 'refused', 'timeout', 'network', 'http', 'unreadable']) {
    ok(!DASHES.test(usageFailureText({ kind, status: 500 }, { name: 'x@y.z' })), `${kind} carries a dash`);
  }
});

await t('a 429 renders the rate limited line on /account AND /usage, not "usage unavailable"', async () => {
  // The live account, as on 2026-09-22.
  const f = failingFetch('acc-a', () => resH(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited.' } }));
  const r = clockRig(f.impl);
  const { snap, account, usage } = await bothViews(r);
  const row = snap.rows.find((x) => x.name === 'second@example.com');
  eq(row.state, 'unavailable', 'every consumer that branches on state must be untouched');
  eq(row.failure, { kind: 'rate-limited', status: 429, code: 'rate_limit_error' });
  ok(account.includes(`   ⚠️ ${RATE_LIMITED_LINE}`), `/account lacks the rate limited line:\n${account}`);
  ok(usage.includes(`   ⚠️ ${RATE_LIMITED_LINE}`), `/usage lacks the rate limited line:\n${usage}`);
  ok(!account.includes('usage unavailable'), `/account still says usage unavailable:\n${account}`);
  ok(!usage.includes('usage unavailable'), `/usage still says usage unavailable:\n${usage}`);
  ok(account.includes('`5h '), `the healthy accounts must still show their bars:\n${account}`);
  // /status omits the line rather than printing a reason into a liveness view.
  eq(usageLine((await r.usage.activeOnly()).row), null);
});

await t('a 429 that names its retry time says WHEN, as a clock in the owner zone, on both views', async () => {
  // The live answer on 2026-09-22 was Retry-After 2714 (45 minutes). "Try again
  // in a few minutes" over a row held for 45 would read as broken.
  const f = failingFetch('acc-a', () => resH(429, { type: 'error', error: { type: 'rate_limit_error' } }, { 'retry-after': '2714' }));
  const r = clockRig(f.impl);
  const { snap, account, usage } = await bothViews(r);
  const row = snap.rows.find((x) => x.name === 'second@example.com');
  eq(row.failure, { kind: 'rate-limited', status: 429, code: 'rate_limit_error', retryAt: NOW + 2_714_000 });
  // NOW is 5:53pm in OWNER_TZ; 45m14s later is 6:38pm.
  const want = '   ⚠️ usage lookup rate limited by Anthropic until 6:38pm (the account itself is fine)';
  ok(account.includes(want), `/account:\n${account}`);
  ok(usage.includes(want), `/usage:\n${usage}`);
  ok(!account.includes('usage unavailable') && !usage.includes('usage unavailable'), 'fell back to usage unavailable');
  ok(!DASHES.test(want), 'the line carries a dash');
  // The clock is the RENDERER's zone, not the daemon's.
  ok(accountUsageBlock(row, { now: NOW, timeZone: 'UTC' })[0].includes('until 10:38pm'), accountUsageBlock(row, { now: NOW, timeZone: 'UTC' })[0]);
  // Twenty minutes on, the held row still names the same clock, not a stale countdown.
  r.clock.t = NOW + 20 * 60_000;
  const later = await bothViews(r);
  ok(later.account.includes(want), `the held row changed its answer:\n${later.account}`);
  eq(f.usageCalls('acc-a'), 1, 'asked the throttled endpoint again inside its Retry-After');
  // A retry time already past falls back to the plain wording, never "until" a past clock.
  eq(usageFailureText({ kind: 'rate-limited', status: 429, retryAt: NOW - 1 }, { now: NOW }), RATE_LIMITED_LINE);
  eq(usageFailureText({ kind: 'rate-limited', status: 429, retryAt: NOW + 3_600_000 }, { now: NOW, timeZone: OWNER_TZ }), 'usage lookup rate limited by Anthropic until 6:53pm (the account itself is fine)');
});

await t('401 and 403 render a login refused line naming the slot to re-capture', async () => {
  for (const status of [401, 403]) {
    const f = failingFetch('acc-b', () => res(status, { type: 'error', error: { type: status === 401 ? 'authentication_error' : 'permission_error' } }));
    const r = clockRig(f.impl);
    const { account, usage } = await bothViews(r);
    const want = `   ⚠️ login refused (HTTP ${status}), run /account capture \`first@example.com\` after logging in`;
    ok(account.includes(want), `/account, ${status}:\n${account}`);
    ok(usage.includes(want), `/usage, ${status}:\n${usage}`);
    ok(!account.includes('usage unavailable') && !usage.includes('usage unavailable'), `${status} fell back to usage unavailable`);
  }
});

await t('a refused login that is in no slot says /account capture <name>, not a made up slot name', async () => {
  const impl = async (url) =>
    url.includes('/oauth/profile')
      ? res(200, { ...REAL_PROFILE, account: { ...REAL_PROFILE.account, email: 'fourth@example.com' } })
      : res(401, {});
  const r = clockRig(impl, { liveOauth: oauthFor('stranger') });
  const { active, row } = await r.usage.activeOnly();
  eq(active.matchedBy, 'profileEmailUnenrolled', 'the rig must really be a login in no slot');
  eq(row.error, 'login refused (HTTP 401), run /account capture `<name>` after logging in');
});

await t('a timeout renders a timed out line, on both views, through the REAL abort', async () => {
  const f = failingFetch('acc-c', (opts) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(res(200, REAL_USAGE)), 5_000);
      opts.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }),
  );
  const r = clockRig(f.impl, { timeoutMs: 40 });
  const { account, usage } = await bothViews(r);
  ok(account.includes('   ⚠️ usage lookup timed out'), `/account:\n${account}`);
  ok(usage.includes('   ⚠️ usage lookup timed out'), `/usage:\n${usage}`);
});

await t('a network error, a 500 and an unreadable body keep "usage unavailable" or say what they are', async () => {
  const cases = [
    [() => { throw new TypeError('fetch failed'); }, '   ⚠️ usage lookup failed (network error)'],
    [() => res(500, {}), '   ⚠️ usage unavailable (HTTP 500)'],
    [() => res(200, null, { json: false }), '   ⚠️ usage unavailable'],
  ];
  for (const [answer, want] of cases) {
    const r = clockRig(failingFetch('acc-c', answer).impl);
    const { account, usage } = await bothViews(r);
    ok(account.split('\n').includes(want), `/account lacks ${want}:\n${account}`);
    ok(usage.split('\n').includes(want), `/usage lacks ${want}:\n${usage}`);
    ok(!account.includes('rate limited') && !account.includes('login refused'), 'a plain failure borrowed another reason');
  }
});

await t('after a 429 with no Retry-After, nothing asks that account again for five minutes', async () => {
  let throttled = true;
  const f = failingFetch('acc-b', () => (throttled ? res(429, { type: 'error', error: { type: 'rate_limit_error' } }) : res(200, REAL_USAGE)));
  const r = clockRig(f.impl);
  await r.usage.all();
  eq(f.usageCalls('acc-b'), 1);
  eq(THROTTLE_DEFAULT_MS, 5 * 60_000);

  r.clock.t = NOW + 61_000; // past the ordinary TTL
  const again = await r.usage.all();
  eq(f.usageCalls('acc-b'), 1, 'a second /account tap re-polled the throttled endpoint');
  ok(f.usageCalls('acc-a') > 1, 'the healthy accounts must still refresh on the ordinary TTL');
  eq(again.rows.find((x) => x.name === 'first@example.com').error, RATE_LIMITED_LINE, 'the held row lost its reason');

  // Every path that invalidates on purpose (a swap, a capture, the rotation
  // probe) must still respect the server's hold.
  invalidateUsageCache();
  await r.usage.all();
  await r.usage.one('first@example.com');
  invalidateUsageCache('first@example.com');
  await r.usage.all();
  eq(f.usageCalls('acc-b'), 1, 'an invalidation bypassed the 429 hold');

  r.clock.t = NOW + THROTTLE_DEFAULT_MS - 1_000;
  await r.usage.all();
  eq(f.usageCalls('acc-b'), 1, 'the hold ended early');

  throttled = false;
  r.clock.t = NOW + THROTTLE_DEFAULT_MS + 1_000;
  const after = await r.usage.all();
  eq(f.usageCalls('acc-b'), 2, 'the hold never ended');
  eq(after.rows.find((x) => x.name === 'first@example.com').state, 'ok', 'the account did not recover once the hold passed');
  ok(r.logs.some((l) => /throttled \(rate-limited, HTTP 429, rate_limit_error\), holding 300s/.test(l)), `no hold log line: ${r.logs.join(' | ')}`);
});

await t('Retry-After is honoured: delta seconds, an HTTP date, a floor at the TTL, a ceiling at an hour', async () => {
  const cases = [
    ['120', 100_000, 121_000],
    [new Date(NOW + 600_000).toUTCString(), 599_000, 601_000],
    ['1', 59_000, 61_000], // floored at the ordinary 60s TTL
    ['999999', THROTTLE_MAX_MS - 1_000, THROTTLE_MAX_MS + 1_000], // capped at an hour
  ];
  for (const [header, inside, outside] of cases) {
    const f = failingFetch('acc-c', () => resH(429, {}, { 'retry-after': header }));
    const r = clockRig(f.impl);
    await r.usage.all();
    r.clock.t = NOW + inside;
    await r.usage.all();
    eq(f.usageCalls('acc-c'), 1, `Retry-After ${header}: asked again inside the window`);
    r.clock.t = NOW + outside;
    await r.usage.all();
    eq(f.usageCalls('acc-c'), 2, `Retry-After ${header}: never asked again after the window`);
  }
  eq(parseRetryAfter('120'), 120_000);
  eq(parseRetryAfter(' 2.5 '), 2_500);
  eq(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW), 90_000);
  eq(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW), 0);
  eq(parseRetryAfter('soon'), null);
  eq(parseRetryAfter(null), null);
  eq(throttleHoldMs(null, 60_000), THROTTLE_DEFAULT_MS);
  eq(throttleHoldMs(0, 60_000), 60_000);
  eq(throttleHoldMs(10 * 3600_000, 60_000), THROTTLE_MAX_MS);
});

await t('no response body text other than error.type reaches a rendered line, a row or a log line', async () => {
  const PLANT = 'sk-ant-oat01-PLANTED-TOKEN-SHAPED-STRING-AAAA';
  const bodies = {
    'acc-a': () =>
      resH(
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: `retry with ${PLANT}` }, request_id: PLANT, echo: { token: PLANT } },
        { 'retry-after': '60' },
      ),
    // A token planted in error.type ITSELF must not pass as a code either.
    'acc-b': () => res(401, { type: 'error', error: { type: PLANT, message: PLANT } }),
    'acc-c': () => res(500, PLANT),
  };
  const calls = [];
  const impl = async (url, opts) => {
    const tok = String(opts.headers.Authorization).replace('Bearer ', '');
    calls.push(url);
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return bodies[tok]();
  };
  const r = clockRig(impl);
  const { snap, account, usage } = await bothViews(r);
  const everything = [
    account,
    usage,
    ...snap.rows.map((row) => accountUsageBlock(row).join('\n')),
    ...snap.rows.map((row) => String(usageLine(row))),
    JSON.stringify(snap.rows),
    r.logs.join('\n'),
  ].join('\n');
  ok(!everything.includes('PLANTED'), `planted body text leaked:\n${everything}`);
  ok(r.logs.some((l) => l.includes('rate_limit_error')), `error.type is the one code allowed through, and it did not reach the log: ${r.logs.join(' | ')}`);
  eq(snap.rows.find((x) => x.name === 'first@example.com').failure, { kind: 'refused', status: 401, code: null }, 'a token-shaped error.type passed as a code');
  ok(account.includes('usage lookup rate limited by Anthropic until '), `the reason itself must still render:\n${account}`);
});

// ---------------------------------------------------------------------------
// NUMBERS FROM THE LIVE SESSIONS
//
// Every Claude Code stream the bridge spawns carries a rate_limit_event after
// each API response, with the same two windows the usage endpoint serves. On
// 2026-09-27 the endpoint answered 429 for an hour on the active account
// (Claude Code 2.1.280+ polls it from every process on that token), and
// /account showed a warning where the bars should be. These pin the event's
// normalization, the fallback, the skipped call and the provenance line.
// ---------------------------------------------------------------------------

// The live shape, seen 24 times in one run log on 2026-09-27 (ids anonymized).
// utilization is a FRACTION here and resetsAt is epoch SECONDS; the usage API
// sends a percent and an ISO string. Both conversions are what this pins.
const S5 = Math.floor((NOW + 2 * 3600_000) / 1000); // 7:53pm ET
const S7 = Math.floor(Date.parse('2026-09-05T05:00:00Z') / 1000); // Fri 1:00am ET
const liveEvent = (over = {}, windows = null) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: S5,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
    unifiedWindows: windows || { five_hour: { utilization: 0.66, resetsAt: S5 }, seven_day: { utilization: 0.63, resetsAt: S7 } },
    ...over,
  },
  uuid: 'event-uuid',
  session_id: 'session-uuid',
});

await t('normalizeRateLimitEvent: the live event becomes the usage API shape, fraction to percent, seconds to ISO', () => {
  const u = normalizeRateLimitEvent(liveEvent());
  eq(u.fiveHour, { percent: 66, resetsAt: new Date(S5 * 1000).toISOString(), severity: null, locked: null });
  eq(u.sevenDay, { percent: 63, resetsAt: new Date(S7 * 1000).toISOString(), severity: null, locked: null });
  eq(u.scoped, []);
  eq(u.extraUsage, null);
  eq(normalizeRateLimitEvent(liveEvent({}, { five_hour: { utilization: 0.41, resetsAt: S5 }, seven_day: { utilization: 0.59, resetsAt: S7 } })).fiveHour.percent, 41, 'float noise from 0.41 * 100 leaked');
});

await t('normalizeRateLimitEvent: a rejected window is locked, the other is not', () => {
  const u = normalizeRateLimitEvent(
    liveEvent({ status: 'rejected' }, { five_hour: { utilization: 1, resetsAt: S5 }, seven_day: { utilization: 0.18, resetsAt: S7 } }),
  );
  ok(u.fiveHour.locked, 'the rejected five_hour window must read as exhausted');
  eq(u.sevenDay.locked, null, 'the weekly window was not the one rejected');
  const w = normalizeRateLimitEvent(
    liveEvent({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: S7 }, { five_hour: { utilization: 0.35, resetsAt: S5 }, seven_day: { utilization: 1, resetsAt: S7 } }),
  );
  ok(w.sevenDay.locked && !w.fiveHour.locked, 'a weekly rejection locks the weekly window only');
  const warn = normalizeRateLimitEvent(liveEvent({ status: 'allowed_warning', utilization: 0.9, surpassedThreshold: 0.75 }));
  eq(warn.fiveHour.locked, null, 'a warning is not a wall');
});

await t('normalizeRateLimitEvent: per model weeklies map like /usage does, anything else is ignored', () => {
  const u = normalizeRateLimitEvent(
    liveEvent({}, {
      five_hour: { utilization: 0.2, resetsAt: S5 },
      seven_day: { utilization: 0.5, resetsAt: S7 },
      seven_day_opus: { utilization: 0.12, resetsAt: S7 },
      seven_day_sonnet: { utilization: 0.3, resetsAt: S7 },
      seven_day_overage_included: { utilization: 0.4, resetsAt: S7 },
    }),
  );
  eq(u.scoped, [
    { label: 'Opus', percent: 12, resetsAt: new Date(S7 * 1000).toISOString() },
    { label: 'Sonnet', percent: 30, resetsAt: new Date(S7 * 1000).toISOString() },
  ]);
});

await t('normalizeRateLimitEvent: a partial or foreign event never throws and never invents a window', () => {
  const weekOnly = normalizeRateLimitEvent(liveEvent({}, { seven_day: { utilization: 0.57, resetsAt: S7 } }));
  eq(weekOnly.fiveHour, null, 'a window the event did not carry is null, not 0%');
  eq(weekOnly.sevenDay.percent, 57);
  eq(normalizeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: false } }), null, 'no windows at all is no reading');
  eq(normalizeRateLimitEvent({ type: 'assistant', message: {} }), null);
  eq(normalizeRateLimitEvent(null), null);
  eq(normalizeRateLimitEvent('rate_limit_event'), null);
  eq(normalizeRateLimitEvent(liveEvent({}, { five_hour: { utilization: 'lots', resetsAt: 'soon' }, seven_day: { utilization: null } })), null);
});

// A reader with a stream provider the test controls, on a moving clock.
function streamRig(fetchImpl, readings = {}, { liveOauth = oauthFor('a'), seed = SEED } = {}) {
  const clock = { t: NOW };
  const learned = [];
  const file = path.join(TMP, `accounts-${n++}.json`);
  writeFileSync(file, JSON.stringify(seed, null, 2), { mode: 0o600 });
  const kc = fakeKeychain({ claudeAiOauth: liveOauth });
  const store = createAccountStore({ file, credentials: createKeychainStore({ account: 'owner', runSecurity: (...a) => kc.run(...a) }), log: () => {} });
  const usage = createAccountUsage({
    store,
    fetchImpl,
    now: () => clock.t,
    ttlMs: 60_000,
    log: () => {},
    streamReading: (name) => readings[name] || null,
    onUsage: (name, u) => learned.push({ name, sevenDay: u.sevenDay?.resetsAt || null }),
  });
  invalidateUsageCache();
  return { clock, store, usage, readings, learned };
}
// `verified`: the host's own account anchor agrees with the reading (see
// stream-usage.mjs). Only a verified reading may replace a lookup outright.
const reading = (ageMs, ev = liveEvent(), verified = true) => ({ usage: normalizeRateLimitEvent(ev), at: NOW - ageMs, verified });
const RL429 = () => resH(429, { type: 'error', error: { type: 'rate_limit_error' } }, { 'retry-after': '2714' });
const renderAccount = (r, snap) =>
  renderAccountList({ rows: r.store.describe(), live: snap.active, usageRows: snap.rows }, { now: r.clock.t, timeZone: OWNER_TZ });

await t('★ a rate limited lookup with a fresh live session reading shows the bars with a provenance line, not the warning', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, { 'second@example.com': reading(10 * 60_000) });
  const snap = await r.usage.all({ stream: true });
  const row = snap.rows.find((x) => x.name === 'second@example.com');
  eq(row.state, 'ok', 'a row with numbers is ok, whichever source they came from');
  eq(row.source, { kind: 'stream', at: NOW - 10 * 60_000 });
  eq(row.lookupFailure?.kind, 'rate-limited', 'why the lookup failed stays on the row for diagnostics');
  eq(row.usage.fiveHour.percent, 66);
  const account = renderAccount(r, snap);
  ok(account.includes('   📡 from live sessions · 5:43pm'), `/account lacks the provenance line:\n${account}`);
  ok(!account.includes('⚠️'), `/account still carries a warning:\n${account}`);
  const block = accountUsageBlock(row, { now: NOW, timeZone: OWNER_TZ });
  ok(block[0].startsWith('   `5h ') && block[0].includes('66%'), `the 5h bar: ${block[0]}`);
  ok(block[1].startsWith('   `wk ') && block[1].includes('63%'), `the weekly bar: ${block[1]}`);
  eq(block[2], '   📡 from live sessions · 5:43pm', 'the provenance line is the last line of the block');
});

await t('the fallback is opt in: all() without {stream: true} is exactly what it was', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, { 'second@example.com': reading(10 * 60_000) });
  const snap = await r.usage.all();
  const row = snap.rows.find((x) => x.name === 'second@example.com');
  eq(row.state, 'unavailable');
  eq(row.source, undefined);
  ok(renderAccount(r, snap).includes('⚠️ usage lookup rate limited by Anthropic until 6:38pm'), 'the warning must stay');
});

await t('a reading older than the bound keeps the warning and draws no bars', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, { 'second@example.com': reading(STREAM_FALLBACK_MAX_AGE_MS + 60_000) });
  const snap = await r.usage.all({ stream: true });
  const row = snap.rows.find((x) => x.name === 'second@example.com');
  eq(row.state, 'unavailable');
  const account = renderAccount(r, snap);
  ok(account.includes('   ⚠️ usage lookup rate limited by Anthropic until 6:38pm (the account itself is fine)'), `the warning must stay:\n${account}`);
  ok(!account.includes('📡'), `a stale reading must not be presented as current:\n${account}`);
  eq(STREAM_FALLBACK_MAX_AGE_MS, 30 * 60_000, 'the bound is half an hour');
});

await t('a reading from the future (clock moved back) is not trusted', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, { 'second@example.com': { usage: normalizeRateLimitEvent(liveEvent()), at: NOW + 10 * 60_000 } });
  const row = (await r.usage.all({ stream: true })).rows.find((x) => x.name === 'second@example.com');
  eq(row.state, 'unavailable');
  eq(f.usageCalls('acc-a'), 1, 'and it must not suppress the lookup either');
});

await t('★ a reading younger than the TTL skips the API call for that account and only that one', async () => {
  const f = failingFetch('nobody', () => res(500, {}));
  const r = streamRig(f.impl, { 'second@example.com': reading(20_000) });
  const snap = await r.usage.all({ stream: true });
  eq(f.usageCalls('acc-a'), 0, 'the bridge asked the endpoint anyway, competing with every session for the same allowance');
  eq(f.usageCalls('acc-b'), 1);
  eq(f.usageCalls('acc-c'), 1);
  const row = snap.rows.find((x) => x.name === 'second@example.com');
  eq(row.source, { kind: 'stream', at: NOW - 20_000 });
  eq(row.lookupFailure, undefined, 'nothing failed: the lookup was never made');
  // Forty seconds on, the same reading is a minute old: the TTL is spent, so ask.
  r.clock.t = NOW + 40_000;
  await r.usage.all({ stream: true });
  eq(f.usageCalls('acc-a'), 1, 'a reading as old as the TTL no longer stands in for the lookup');
  // Without the opt in, the call is made as it always was.
  const f2 = failingFetch('nobody', () => res(500, {}));
  const r2 = streamRig(f2.impl, { 'second@example.com': reading(20_000) });
  await r2.usage.all();
  eq(f2.usageCalls('acc-a'), 1);
});

await t('★ an unverified reading never replaces the lookup, but still stands in when the lookup fails', async () => {
  // First boot, no anchor yet: the reading's identity is inferred, not proven.
  // The lookup is what proves it, so it must be made.
  const f = usageFetch({ 'acc-a': 12 });
  const r = streamRig(f.impl, { 'second@example.com': reading(20_000, liveEvent(), false) });
  const row = (await r.usage.all({ stream: true })).rows.find((x) => x.name === 'second@example.com');
  eq(f.calls.filter((c) => c.url.includes('/oauth/usage') && c.tok === 'acc-a').length, 1, 'an unverified reading suppressed the lookup that would verify it');
  eq(row.usage.fiveHour.percent, 12, 'the lookup answered, so its numbers are shown');
  eq(row.source, undefined);
  const f2 = failingFetch('acc-a', RL429);
  const r2 = streamRig(f2.impl, { 'second@example.com': reading(20_000, liveEvent(), false) });
  const row2 = (await r2.usage.all({ stream: true })).rows.find((x) => x.name === 'second@example.com');
  eq(row2.source?.kind, 'stream', 'the lookup failed, and the reading is the best there is');
  // A host that says nothing about verification gets no skip either.
  const f3 = usageFetch({});
  const r3 = streamRig(f3.impl, { 'second@example.com': { usage: normalizeRateLimitEvent(liveEvent()), at: NOW - 20_000 } });
  await r3.usage.all({ stream: true });
  eq(f3.calls.filter((c) => c.url.includes('/oauth/usage') && c.tok === 'acc-a').length, 1);
});

await t('★ a reading moved away mid render (a concurrent lookup proved it another account\'s) is not drawn', async () => {
  // all() reads the slots concurrently. first@ answers at once and its lookup
  // teaches the host that the reading held under second@ is really first@'s;
  // second@'s own lookup then fails. The reading second@ saw BEFORE its await
  // must not be the one it draws after it.
  const readings = { 'second@example.com': reading(10 * 60_000) };
  const impl = async (url, opts) => {
    const tok = String(opts.headers.Authorization).replace('Bearer ', '');
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    if (tok === 'acc-a') {
      await new Promise((r) => setTimeout(r, 30));
      return RL429();
    }
    return res(200, REAL_USAGE);
  };
  const file = path.join(TMP, `accounts-${n++}.json`);
  writeFileSync(file, JSON.stringify(SEED, null, 2), { mode: 0o600 });
  const kc = fakeKeychain({ claudeAiOauth: oauthFor('a') });
  const store = createAccountStore({ file, credentials: createKeychainStore({ account: 'owner', runSecurity: (...a) => kc.run(...a) }), log: () => {} });
  const u = createAccountUsage({
    store,
    fetchImpl: impl,
    now: () => NOW,
    log: () => {},
    streamReading: (name) => readings[name] || null,
    onUsage: (name) => {
      if (name === 'first@example.com') delete readings['second@example.com']; // the host's learn() re-homing it
    },
  });
  invalidateUsageCache();
  const row = (await u.all({ stream: true })).rows.find((x) => x.name === 'second@example.com');
  eq(row.state, 'unavailable', 'drew a reading the host had already moved to another account');
  eq(row.source, undefined);
});

await t('the newest reading wins each time: a stream row is never cached over a newer one', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, { 'second@example.com': reading(5 * 60_000) });
  await r.usage.all({ stream: true });
  r.clock.t = NOW + 30_000;
  r.readings['second@example.com'] = { usage: normalizeRateLimitEvent(liveEvent({}, { five_hour: { utilization: 0.7, resetsAt: S5 }, seven_day: { utilization: 0.64, resetsAt: S7 } })), at: NOW + 20_000 };
  const row = (await r.usage.all({ stream: true })).rows.find((x) => x.name === 'second@example.com');
  eq(row.usage.fiveHour.percent, 70);
  eq(f.usageCalls('acc-a'), 1, 'the 429 hold still holds while the stream carries the numbers');
});

await t('the fallback covers timeout, network, unreadable and HTTP errors, and never a refused login', async () => {
  const cases = [
    ['timeout', () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 'ok'],
    ['network', () => { throw new TypeError('fetch failed'); }, 'ok'],
    ['unreadable', () => res(200, { nothing: 'here' }), 'ok'],
    ['http', () => res(503, {}), 'ok'],
    ['refused', () => res(401, { type: 'error', error: { type: 'authentication_error' } }), 'unavailable'],
  ];
  for (const [kind, answer, want] of cases) {
    const f = failingFetch('acc-a', answer);
    const r = streamRig(f.impl, { 'second@example.com': reading(5 * 60_000) });
    const row = (await r.usage.all({ stream: true })).rows.find((x) => x.name === 'second@example.com');
    eq(row.state, want, kind);
    if (want === 'ok') eq(row.lookupFailure?.kind, kind, kind);
    else ok(accountUsageBlock(row, { now: NOW, timeZone: OWNER_TZ })[0].includes('login refused'), `${kind}: the re-capture instruction must not be papered over`);
  }
});

await t('★ an idle slot is always looked up: a fresh reading never skips its credential check', async () => {
  // A worker still on the outgoing account after a swap keeps feeding readings
  // for it, so a reading under the TTL for an IDLE slot is real. Its login can
  // still be dead, and that instruction must reach the owner.
  const seed = [
    SEED[0],
    { ...SEED[1], claudeAiOauth: oauthFor('b', { refreshTokenExpiresAt: NOW - 1000 }) },
    SEED[2],
  ];
  const f = failingFetch('acc-c', () => res(401, { type: 'error', error: { type: 'authentication_error' } }));
  const r = streamRig(f.impl, { 'first@example.com': reading(20_000), 'third@example.com': reading(20_000) }, { seed });
  const snap = await r.usage.all({ stream: true });
  const expired = snap.rows.find((x) => x.name === 'first@example.com');
  eq(expired.state, 'credentials-expired', 'bars drawn over a dead login');
  const refused = snap.rows.find((x) => x.name === 'third@example.com');
  eq(refused.failure?.kind, 'refused', 'bars drawn over a refused login');
  eq(f.usageCalls('acc-c'), 1, 'an idle slot must be looked up even with a fresh reading');
  // A healthy idle slot with a fresh reading is looked up too, and shows the lookup.
  const f2 = usageFetch({ 'acc-b': 12 });
  const r2 = streamRig(f2.impl, { 'first@example.com': reading(20_000) });
  const row2 = (await r2.usage.all({ stream: true })).rows.find((x) => x.name === 'first@example.com');
  eq(row2.usage.fiveHour.percent, 12);
  eq(row2.source, undefined);
});

await t('a slot with a credential problem keeps its instruction even with a reading', async () => {
  const seed = [...SEED.slice(0, 2), { name: 'third@example.com', email: null, claudeAiOauth: null, limitedUntil: null, lastActiveAt: null }];
  const f = usageFetch({});
  const r = streamRig(f.impl, { 'third@example.com': reading(60 * 1000 * 5) }, { seed });
  const row = (await r.usage.all({ stream: true })).rows.find((x) => x.name === 'third@example.com');
  eq(row.state, 'no-credentials');
});

await t('a fresh reading never skips past a cached refused login', async () => {
  const f = failingFetch('acc-a', () => res(401, { type: 'error', error: { type: 'authentication_error' } }));
  const r = streamRig(f.impl, {});
  await r.usage.all({ stream: true }); // caches the refused row
  r.readings['second@example.com'] = reading(-5_000); // arrives after, 5s ago on the moved clock
  r.clock.t = NOW + 10_000;
  const row = (await r.usage.all({ stream: true })).rows.find((x) => x.name === 'second@example.com');
  eq(row.state, 'unavailable');
  eq(row.failure?.kind, 'refused');
});

await t('★ the rotation probe one() never takes a stream reading, fresh or not', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, { 'second@example.com': reading(20_000) });
  const row = await r.usage.one('second@example.com');
  eq(f.usageCalls('acc-a'), 1, 'the probe must ask the API: that is the whole point of fresh:true');
  eq(row.state, 'unavailable');
  eq(row.source, undefined);
});

await t('activeOnly() takes the stream only when asked, so usageResetFor is untouched and /status gets bars', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, { 'second@example.com': reading(10 * 60_000) });
  const plain = await r.usage.activeOnly();
  eq(plain.row.state, 'unavailable', 'the default is the old behaviour');
  eq(usageLine(plain.row), null);
  const live = await r.usage.activeOnly({ stream: true });
  eq(live.row.state, 'ok');
  const line = usageLine(live.row, { now: NOW, timeZone: OWNER_TZ });
  ok(line.includes('5h 66%') && line.includes('wk 63%'), line);
  ok(line.endsWith('\n   📡 from live sessions · 5:43pm'), `/status lacks the provenance line:\n${line}`);
});

await t('/usage renders the stream row with its provenance line, the way it renders any row', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, {
    'second@example.com': reading(
      10 * 60_000,
      liveEvent({}, { five_hour: { utilization: 0.66, resetsAt: S5 }, seven_day: { utilization: 0.63, resetsAt: S7 }, seven_day_sonnet: { utilization: 0.3, resetsAt: S7 } }),
    ),
  });
  const report = renderUsageReport(await r.usage.all({ stream: true }), { now: NOW, timeZone: OWNER_TZ });
  ok(report.includes('   📡 from live sessions · 5:43pm'), report);
  ok(report.includes('   Sonnet `███░░░░░░░` 30%'), `the sub window rides the existing scoped slot:\n${report}`);
  ok(!report.includes('⚠️'), report);
});

await t('onUsage hears every successful API reading and nothing else', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, { 'second@example.com': reading(5 * 60_000) });
  await r.usage.all({ stream: true });
  eq(r.learned.map((x) => x.name).sort(), ['first@example.com', 'third@example.com'], 'a failed lookup or a stream row taught it something');
  eq(r.learned[0].sevenDay, '2026-09-05T05:00:00.241459+00:00');
  // A throwing listener costs nothing.
  const store = r.store;
  const u = createAccountUsage({ store, fetchImpl: usageFetch({}).impl, now: () => NOW, log: () => {}, onUsage: () => { throw new Error('boom'); } });
  invalidateUsageCache();
  const snap = await u.all();
  eq(snap.rows.map((x) => x.state), ['ok', 'ok', 'ok']);
});

await t('liveSourceLine: one fact, the middle dot, no dash, fits a phone line', () => {
  const row = { state: 'ok', usage: normalizeRateLimitEvent(liveEvent()), source: { kind: 'stream', at: NOW - 60_000 } };
  eq(liveSourceLine(row, { now: NOW, timeZone: OWNER_TZ }), '   📡 from live sessions · 5:52pm');
  const yesterday = liveSourceLine({ ...row, source: { kind: 'stream', at: NOW - 20 * 3600_000 } }, { now: NOW, timeZone: OWNER_TZ });
  eq(yesterday, '   📡 from live sessions · Sun 9:53pm', 'a reading from another day names the day');
  for (const s of [liveSourceLine(row, { now: NOW, timeZone: OWNER_TZ }), yesterday]) {
    ok(!DASHES.test(s), s);
    ok(s.length <= 44, `${s.length} chars: ${s}`);
  }
  eq(liveSourceLine({ state: 'ok', usage: row.usage }, { now: NOW }), null, 'an API row carries no provenance line');
  eq(liveSourceLine(null), null);
});

await t('★ a lookup row carries readAt, and its cached copy keeps the ORIGINAL time', async () => {
  // The rotation's re-check (account-selector.mjs limitClearVerdict) lifts a
  // ledger wall on a young reading only, so a cached row must not look fresh.
  const r = clockRig(usageFetch({}).impl);
  const first = await r.usage.all();
  eq(first.rows.map((x) => x.readAt), [NOW, NOW, NOW], 'every lookup row is stamped with the clock it was read at');
  r.clock.t = NOW + 30_000; // inside the TTL: served from the cache
  const cached = await r.usage.all();
  ok(cached.rows.every((x) => x.cached === true), 'the second read was not served from the cache');
  eq(cached.rows.map((x) => x.readAt), [NOW, NOW, NOW], 'a cached copy was re-stamped as if it were fresh');
  const probe = await r.usage.one('second@example.com');
  eq(probe.readAt, NOW + 30_000, 'the rotation probe reads fresh, so it is stamped now');
});

await t('a failed lookup and a stream row carry no readAt', async () => {
  const f = failingFetch('acc-a', RL429);
  const r = streamRig(f.impl, { 'second@example.com': reading(20_000) });
  const snap = await r.usage.all({ stream: true });
  const streamed = snap.rows.find((x) => x.name === 'second@example.com');
  eq(streamed.source?.kind, 'stream');
  eq(streamed.readAt, undefined, 'a stream row dates itself in source.at, never as a lookup');
  const failed = await r.usage.one('second@example.com');
  eq(failed.state, 'unavailable');
  eq(failed.readAt, undefined);
});

// ---------- report ----------
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all account-usage tests pass');
