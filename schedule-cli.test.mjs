#!/usr/bin/env node
// Tests for the schedule CLI, run as a REAL process against a REAL store.
//
// schedule.mjs writes schedules.json next to itself, so the whole suite runs on
// a copy in a temp dir (the same trick bg-notify.test.mjs uses for bg.mjs) and
// the live store is never opened. That is the only honest way to test this
// file: its risky half is not a pure function but what it PERSISTS, and the
// four bugs this suite locks down were all "exit 0, wrote the wrong thing".
//
//   node schedule-cli.test.mjs

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(path.join(tmpdir(), 'schedule-cli-'));
for (const f of ['schedule.mjs', 'schedule-due.mjs']) copyFileSync(path.join(DIR, f), path.join(WORK, f));
const STORE = path.join(WORK, 'schedules.json');

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
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

const seed = (items) => writeFileSync(STORE, JSON.stringify({ nextId: items.length, items }, null, 2));
const read = () => JSON.parse(readFileSync(STORE, 'utf8'));
// Hermetic: the suite may itself run inside a worker or a tmux pane, and the
// write approval below is refused or allowed by those env names.
const CLEAN_ENV = { ...process.env };
for (const k of ['LEASH_LANE', 'LEASH_TRIGGER', 'LEASH_SCHEDULE_ID', 'LEASH_ALLOW_WRITE', 'TMUX']) delete CLEAN_ENV[k];
const runEnv = (env, ...args) => {
  const r = spawnSync(process.execPath, [path.join(WORK, 'schedule.mjs'), ...args], { encoding: 'utf8', env: { ...CLEAN_ENV, ...env } });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const run = (...args) => runEnv({}, ...args);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// A local date N days from today, as YYYY-MM-DD. Plain calendar arithmetic
// through Date.UTC, deliberately NOT schedule-due.mjs's addDays: these tests
// assert what the CLI prints, and computing the expectation with the same
// function the CLI uses would make an off-by-one agree with itself.
//
// WHY THE FIXTURES ARE RELATIVE AT ALL. They used to hard-code `lastFired:
// '2026-09-10'` and assert `(next 2026-09-13)`, which is only true while today
// is on or before the 13th. On 2026-09-13 the three cadence tests started
// failing on a pristine tree and stayed failing, and the arithmetic they accuse
// is right: with an anchor nine days back and a three day cadence, isDailyDue()
// fires TODAY, and nextDaily() says so. (Property-checked over 468 anchor and
// cadence pairs: the date nextDaily reports is always the first date isDailyDue
// returns true on.) A fixture that expires is a fixture that teaches the next
// reader to distrust a working gate.
const daysFromToday = (n) => {
  const [y, m, d] = today().split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + n));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
};
// The anchor sits one day back, so anchor + 3 is always two days from now: in
// the future on every day of the year, and never rounded up to today.
const ANCHOR = () => daysFromToday(-1);
const NEXT_AFTER_ANCHOR = () => daysFromToday(2);

// ---------------------------------------------------------------------------
console.log('\n1. add');

t('add every writes a daily carrying the cadence, not a new kind', () => {
  seed([]);
  const r = run('add', 'every', '3d', '12:00', '--run', 'BU ads check');
  eq(r.code, 0, r.err);
  const item = read().items[0];
  eq(item.kind, 'daily', 'the kind must stay daily so every existing reader keeps working');
  eq(item.every, 3);
  eq(item.at, '12:00');
  eq(item.text, 'BU ads check');
  eq(item.run, true);
  ok(r.out.includes('every 3d 12:00'), r.out);
  ok(/\(next \d{4}-\d{2}-\d{2}\)/.test(r.out) || !item.lastFired, r.out);
});

t('★ text after a bare --run survives (it used to be swallowed)', () => {
  // Every flag used to own the token after it, so this exact form died with
  // "missing text" while looking like a perfectly good command.
  seed([]);
  const r = run('add', 'daily', '08:00', '--run', 'morning check');
  eq(r.code, 0, r.err);
  eq(read().items[0].text, 'morning check');
  eq(read().items[0].run, true);
});

t('a new item never fires at creation: past time means lastFired is today', () => {
  seed([]);
  run('add', 'daily', '00:00', 'x');
  eq(read().items[0].lastFired, today(), 'a time already past today must not fire immediately');
});

t('add every rejects a cadence outside 2 to 365, and writes nothing', () => {
  for (const n of ['1d', '0d', '366d', 'xd']) {
    seed([]);
    const r = run('add', 'every', n, '12:00', 'x');
    ok(r.code !== 0, `every ${n} was accepted`);
    eq(read().items.length, 0, `every ${n} wrote to the store anyway`);
  }
});

t('add every still needs a time and a text', () => {
  seed([]);
  ok(run('add', 'every', '3d', 'nope', 'x').code !== 0);
  ok(run('add', 'every', '3d', '12:00').code !== 0);
  eq(read().items.length, 0);
});

t('the other three forms still work', () => {
  seed([]);
  eq(run('add', 'daily', '08:00', 'a').code, 0);
  eq(run('add', 'once', '2099-01-01', '09:30', 'b').code, 0);
  eq(run('add', 'in', '90m', 'c').code, 0);
  eq(read().items.length, 3);
  eq(read().items[1].kind, 'once');
});

// ---------------------------------------------------------------------------
console.log('\n2. update: the cadence and its anchor');

const CADENCE = { id: 1, kind: 'daily', every: 3, at: '12:00', lastFired: ANCHOR(), text: 'ads', run: true };
const PLAIN = { id: 1, kind: 'daily', at: '12:00', lastFired: '2026-09-01', text: 'ads' };

t('--every N turns a daily into a cadence item, --every 1 turns it back', () => {
  seed([{ ...PLAIN }]);
  eq(run('update', '1', '--every', '3').code, 0);
  eq(read().items[0].every, 3);
  eq(run('update', '1', '--every', '1').code, 0);
  ok(!('every' in read().items[0]), 'every 1 must remove the field, not store a 1');
});

t('--anchor sets the last fire, so the next one is anchor plus N', () => {
  seed([{ ...CADENCE, lastFired: undefined }]);
  const r = run('update', '1', '--anchor', ANCHOR());
  eq(r.code, 0, r.err);
  eq(read().items[0].lastFired, ANCHOR());
  ok(r.out.includes(`(next ${NEXT_AFTER_ANCHOR()})`), r.out);
});

t('--every and --anchor in one call is the conversion, and it works', () => {
  seed([{ ...PLAIN }]);
  const r = run('update', '1', '--every', '3', '--anchor', ANCHOR());
  eq(r.code, 0, r.err);
  eq(read().items[0].every, 3);
  eq(read().items[0].lastFired, ANCHOR());
  ok(r.out.includes(`every 3d 12:00 (next ${NEXT_AFTER_ANCHOR()})`), r.out);
});

t('★ --at keeps a cadence item\'s anchor', () => {
  // lastFired on a cadence item is the PHASE, not a "fired today" latch.
  // Clearing it on a time change fired the schedule up to N-1 days early.
  seed([{ ...CADENCE }]);
  eq(run('update', '1', '--at', '23:59').code, 0);
  eq(read().items[0].at, '23:59');
  eq(read().items[0].lastFired, ANCHOR(), 'the anchor was destroyed by a time change');
});

t('--at on a plain daily still re-latches exactly as it did before', () => {
  seed([{ ...PLAIN }]);
  eq(run('update', '1', '--at', '00:00').code, 0);
  eq(read().items[0].lastFired, today());
});

t('★ --anchor on a plain daily is refused rather than silently ignored', () => {
  // A daily fires every day whatever lastFired says, so accepting an anchor
  // there reported success for something that could never take effect.
  seed([{ ...PLAIN }]);
  const r = run('update', '1', '--anchor', '2026-12-25');
  ok(r.code !== 0, 'accepted an anchor that can never take effect');
  eq(read().items[0].lastFired, '2026-09-01', 'and it wrote it anyway');
});

t('★ a date that only looks real is refused', () => {
  // new Date("2026-02-30") does not throw, it quietly becomes March 2nd.
  seed([{ ...CADENCE }]);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-9-10', '20260910', 'tomorrow']) {
    const r = run('update', '1', '--anchor', bad);
    ok(r.code !== 0, `${bad} was accepted`);
  }
  eq(read().items[0].lastFired, ANCHOR(), 'the anchor moved anyway');
});

t('★ a flag with no value is a usage error, not a silent no-op', () => {
  seed([{ ...CADENCE }]);
  ok(run('update', '1', '--every').code !== 0, '--every with nothing after it reported success');
  ok(run('update', '1', '--anchor').code !== 0, '--anchor with nothing after it reported success');
  eq(read().items[0].every, 3);
  eq(read().items[0].lastFired, ANCHOR());
});

t('--every and --anchor are refused on a one-off, and the store is untouched', () => {
  const once = { id: 1, kind: 'once', at: 4102444800000, text: 'x' };
  seed([{ ...once }]);
  ok(run('update', '1', '--every', '3').code !== 0);
  ok(run('update', '1', '--anchor', '2026-09-10').code !== 0);
  eq(JSON.stringify(read().items[0]), JSON.stringify(once));
});

t('--text and --run still work alongside the new flags', () => {
  seed([{ ...CADENCE }]);
  eq(run('update', '1', '--text', 'new words', '--run', 'false').code, 0);
  eq(read().items[0].text, 'new words');
  ok(!('run' in read().items[0]));
  eq(read().items[0].every, 3, 'an unrelated update must not drop the cadence');
});

// ---------------------------------------------------------------------------
console.log('\n3. list and remove');

t('list labels each shape, and only a cadence item carries a next date', () => {
  seed([
    { id: 1, kind: 'daily', at: '08:00', text: 'a' },
    { id: 2, kind: 'daily', every: 3, at: '12:00', lastFired: ANCHOR(), text: 'b' },
  ]);
  const lines = run('list').out.split('\n');
  ok(lines[0].includes('daily 08:00') && !lines[0].includes('next'), lines[0]);
  ok(lines[1].includes(`every 3d 12:00 (next ${NEXT_AFTER_ANCHOR()})`), lines[1]);
});

t('remove takes the item out, and an unknown id is an error', () => {
  seed([{ id: 1, kind: 'daily', at: '08:00', text: 'a' }]);
  eq(run('remove', '1').code, 0);
  eq(read().items.length, 0);
  ok(run('remove', '99').code !== 0);
});

t('the usage text names the new forms', () => {
  const out = run('help').out;
  for (const form of ['add every 3d', '--every N', '--anchor YYYY-MM-DD', '--allow-write']) ok(out.includes(form), `usage is missing ${form}`);
});

// ---------------------------------------------------------------------------
console.log('\n4. --allow-write: the owner approving writes in an unattended run');
// A scheduled run is marked unattended (LEASH_TRIGGER=schedule) and hooks may
// refuse database writes and migrations in it. This flag is the owner's
// approval for ONE entry, so it has to be visible every time it is set.

const APPROVED = 'database writes and migrations allowed in this unattended run: owner approved';

t('★ add --run --allow-write stores the approval and says so in words', () => {
  seed([]);
  const r = run('add', 'daily', '03:00', '--run', '--allow-write', 'nightly migration check');
  eq(r.code, 0, r.err);
  const item = read().items[0];
  eq(item.allowWrite, true);
  eq(item.run, true);
  eq(item.text, 'nightly migration check', 'the text after a bare --allow-write must survive');
  ok(r.out.includes(APPROVED), r.out);
  eq(r.out.split('\n').length, 1, 'one confirmation line');
});

t('★ --allow-write without --run is refused in one line, and nothing is written', () => {
  seed([]);
  const r = run('add', 'daily', '03:00', '--allow-write', 'call the accountant');
  ok(r.code !== 0, 'a reminder was given write approval');
  eq(r.err.split('\n').length, 1, `the refusal must be one line:\n${r.err}`);
  ok(r.err.includes('--run'), r.err);
  eq(read().items.length, 0, 'the refused entry was written anyway');
});

t('add --allow-write false stores nothing, and the text still survives', () => {
  seed([]);
  const r = run('add', 'in', '90m', '--run', '--allow-write', 'false', 'audit');
  eq(r.code, 0, r.err);
  ok(!('allowWrite' in read().items[0]), JSON.stringify(read().items[0]));
  eq(read().items[0].text, 'audit');
  ok(!r.out.includes(APPROVED), r.out);
});

// QA 2026-09-27 round 2: the approval is the owner's. A worker or a scheduled
// run (the run the write guard just held) must not be able to grant it to
// itself; a tmux pane is the owner's own session and may.
t('★ --allow-write from a background worker is refused, nothing written', () => {
  seed([]);
  const r = runEnv({ LEASH_LANE: 'bg' }, 'add', 'in', '1m', '--run', '--allow-write', 're-run the held write');
  ok(r.code !== 0, `expected a refusal, got ${r.code} ${r.out}`);
  ok(/owner/i.test(r.err) && /worker|scheduled run/i.test(r.err), r.err);
  eq(read().items.length, 0, 'nothing may be stored');
});
t('★ --allow-write from inside a scheduled run is refused on update too', () => {
  seed([{ id: 23, kind: 'daily', at: '03:00', text: 'nightly', run: true }]);
  const r = runEnv({ LEASH_LANE: 'bg', LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '23' }, 'update', '23', '--allow-write');
  ok(r.code !== 0, `expected a refusal, got ${r.code} ${r.out}`);
  ok(read().items[0].allowWrite !== true, 'the approval must not be stored');
});
t('a worker may still REVOKE an approval', () => {
  seed([{ id: 23, kind: 'daily', at: '03:00', text: 'nightly', run: true, allowWrite: true }]);
  const r = runEnv({ LEASH_LANE: 'bg' }, 'update', '23', '--allow-write', 'false');
  eq(r.code, 0, r.err);
  ok(read().items[0].allowWrite !== true, 'revoked');
});
t('the chat lane and a tmux pane may grant it', () => {
  seed([]);
  eq(runEnv({ LEASH_LANE: 'chat' }, 'add', 'in', '1m', '--run', '--allow-write', 'a').code, 0, 'chat lane');
  eq(runEnv({ LEASH_LANE: 'bg', TMUX: '/tmp/tmux-501/default,1,0' }, 'add', 'in', '1m', '--run', '--allow-write', 'b').code, 0, 'tmux pane with an inherited LEASH_LANE');
});

t('★ update --allow-write true approves a run entry and echoes it', () => {
  seed([{ id: 1, kind: 'daily', at: '03:00', text: 'sync', run: true }]);
  const r = run('update', '1', '--allow-write', 'true');
  eq(r.code, 0, r.err);
  eq(read().items[0].allowWrite, true);
  ok(r.out.includes(APPROVED), r.out);
});

t('★ update --allow-write false takes it back and says so', () => {
  seed([{ id: 1, kind: 'daily', at: '03:00', text: 'sync', run: true, allowWrite: true }]);
  const r = run('update', '1', '--allow-write', 'false');
  eq(r.code, 0, r.err);
  ok(!('allowWrite' in read().items[0]), 'the field must go, not become false');
  ok(!r.out.includes(APPROVED), r.out);
  ok(r.out.includes('no longer allowed'), r.out);
});

t('update --allow-write true on a reminder is refused, and the store is untouched', () => {
  const reminder = { id: 1, kind: 'daily', at: '03:00', text: 'call' };
  seed([{ ...reminder }]);
  const r = run('update', '1', '--allow-write', 'true');
  ok(r.code !== 0, 'a reminder was approved for writes');
  eq(JSON.stringify(read().items[0]), JSON.stringify(reminder));
});

t('update --run true --allow-write true in one call works', () => {
  seed([{ id: 1, kind: 'daily', at: '03:00', text: 'call' }]);
  const r = run('update', '1', '--run', 'true', '--allow-write', 'true');
  eq(r.code, 0, r.err);
  eq(read().items[0].run, true);
  eq(read().items[0].allowWrite, true);
});

t('update --allow-write with a value that is not true or false is a usage error', () => {
  seed([{ id: 1, kind: 'daily', at: '03:00', text: 'sync', run: true }]);
  ok(run('update', '1', '--allow-write', 'yes').code !== 0, 'yes was read as approval');
  ok(!('allowWrite' in read().items[0]));
});

t('★ turning --run off drops the approval with it: a reminder cannot carry it', () => {
  seed([{ id: 1, kind: 'daily', at: '03:00', text: 'sync', run: true, allowWrite: true }]);
  const r = run('update', '1', '--run', 'false');
  eq(r.code, 0, r.err);
  ok(!('allowWrite' in read().items[0]), JSON.stringify(read().items[0]));
  ok(r.out.includes('no longer allowed'), r.out);
});

t('an update that does not name the flag keeps the approval and still echoes it', () => {
  seed([{ id: 1, kind: 'daily', at: '03:00', text: 'sync', run: true, allowWrite: true }]);
  const r = run('update', '1', '--text', 'nightly sync');
  eq(r.code, 0, r.err);
  eq(read().items[0].allowWrite, true);
  ok(r.out.includes(APPROVED), r.out);
});

t('★ an existing entry without the field is untouched by an update and gets no marker', () => {
  const old = { id: 1, kind: 'daily', at: '03:00', text: 'sync', run: true };
  seed([{ ...old }]);
  const r = run('update', '1', '--text', 'sync');
  eq(r.code, 0, r.err);
  eq(JSON.stringify(read().items[0]), JSON.stringify(old));
  ok(!r.out.includes('writes'), r.out);
});

t('list marks an approved entry, and only that one', () => {
  seed([
    { id: 1, kind: 'daily', at: '03:00', text: 'a', run: true },
    { id: 2, kind: 'daily', at: '03:00', text: 'b', run: true, allowWrite: true },
    { id: 3, kind: 'daily', at: '08:00', text: 'c' },
  ]);
  const lines = run('list').out.split('\n');
  ok(!lines[0].includes('writes'), lines[0]);
  ok(lines[1].includes('writes approved'), lines[1]);
  ok(!lines[2].includes('writes'), lines[2]);
  ok(!/[\u2013\u2014]/.test(lines.join('\n')), 'no dash in the marker');
});

console.log('\n5. --switch-account: a scheduled move of the Claude login');
// The daemon does the switch at fire time (bridge.mjs runScheduledSwitch) and
// refuses a walled or flagged account with one message. The CLI refuses what
// it can see now: a name that is not stored, a --run, an unattended caller.

const ACCOUNTS = path.join(WORK, 'accounts.json');
writeFileSync(
  ACCOUNTS,
  JSON.stringify([
    { name: 'zalo@example.test', email: 'zalo@example.test', claudeAiOauth: { accessToken: 'not-a-real-token' } },
    { name: 'hello@example.test', email: 'hello@example.test', claudeAiOauth: { accessToken: 'not-a-real-token' } },
  ]),
);

t('★ add once HH:MM --switch-account stores the target, a default text, and says what it is', () => {
  seed([]);
  const r = run('add', 'once', '23:59', '--switch-account', 'zalo@example.test');
  eq(r.code, 0, r.err);
  const item = read().items[0];
  eq(item.switchAccount, 'zalo@example.test');
  eq(item.kind, 'once');
  eq(item.text, 'switch the Claude account to zalo@example.test');
  eq(item.run, undefined, 'a switch is not a Claude task');
  ok(r.out.includes('switch account to zalo@example.test'), r.out);
});

t('the name matches case-insensitively and is stored as the slot name; a text after it is kept', () => {
  seed([]);
  const r = run('add', 'in', '90m', '--switch-account', 'HELLO@Example.test', 'move before the night batch');
  eq(r.code, 0, r.err);
  eq(read().items[0].switchAccount, 'hello@example.test');
  eq(read().items[0].text, 'move before the night batch');
  const d = run('add', 'daily', '09:00', '--switch-account', 'zalo@example.test');
  eq(d.code, 0, d.err);
  ok(run('list').out.includes('daily 09:00 · switch account to zalo@example.test'), run('list').out);
});

t('refused: a name that is not stored names the stored ones, and nothing is written', () => {
  seed([]);
  const r = run('add', 'once', '23:59', '--switch-account', 'nobody@example.test');
  eq(r.code, 1);
  ok(r.err.includes('"nobody@example.test" is not a stored account (stored: zalo@example.test, hello@example.test)'), r.err);
  eq(read().items.length, 0);
});

t('refused: no name, or --run with it', () => {
  seed([]);
  eq(run('add', 'once', '23:59', '--switch-account').code, 1);
  const r = run('add', 'once', '23:59', '--switch-account', 'zalo@example.test', '--run');
  eq(r.code, 1);
  ok(r.err.includes('do not go together'), r.err);
  eq(read().items.length, 0);
});

t('★ refused from a background worker or a scheduled run; allowed from a tmux pane', () => {
  seed([]);
  const bg = runEnv({ LEASH_LANE: 'bg' }, 'add', 'once', '23:59', '--switch-account', 'zalo@example.test');
  eq(bg.code, 1);
  ok(bg.err.includes("only the owner's own lanes can"), bg.err);
  const sched = runEnv({ LEASH_TRIGGER: 'schedule' }, 'add', 'once', '23:59', '--switch-account', 'zalo@example.test');
  eq(sched.code, 1);
  eq(read().items.length, 0);
  const pane = runEnv({ LEASH_LANE: 'bg', TMUX: '/tmp/tmux-501/default,1,0' }, 'add', 'once', '23:59', '--switch-account', 'zalo@example.test');
  eq(pane.code, 0, pane.err);
  const chat = runEnv({ LEASH_LANE: 'chat' }, 'add', 'once', '23:58', '--switch-account', 'zalo@example.test');
  eq(chat.code, 0, chat.err);
});

t('a switch entry cannot be turned into a --run by update', () => {
  seed([{ id: 1, kind: 'once', at: Date.now() + 3600_000, text: 'switch', switchAccount: 'zalo@example.test' }]);
  const r = run('update', '1', '--run');
  eq(r.code, 1);
  eq(read().items[0].run, undefined);
});

t('no accounts.json means nothing is stored, so the switch is refused', () => {
  rmSync(ACCOUNTS);
  seed([]);
  const r = run('add', 'once', '23:59', '--switch-account', 'zalo@example.test');
  eq(r.code, 1);
  ok(r.err.includes('(accounts.json has none)'), r.err);
});

t('★ update --switch-account is refused, not silently ignored (QA round 1), and the entry keeps its target', () => {
  writeFileSync(ACCOUNTS, JSON.stringify([{ name: 'zalo@example.test', email: 'zalo@example.test' }, { name: 'hello@example.test', email: 'hello@example.test' }]));
  seed([]);
  eq(run('add', 'once', '23:59', '--switch-account', 'zalo@example.test').code, 0);
  const id = read().items[0].id;
  const r = run('update', String(id), '--switch-account', 'hello@example.test');
  eq(r.code, 1);
  ok(r.err.includes('--switch-account is set when an entry is added'), r.err);
  eq(read().items[0].switchAccount, 'zalo@example.test');
});

t('the usage text documents the flag', () => {
  ok(run('help').out.includes('--switch-account'), 'usage is missing --switch-account');
});

// ---------------------------------------------------------------------------
rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
