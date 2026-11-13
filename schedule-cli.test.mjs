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

import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    { name: 'c@example.test', email: 'c@example.test', claudeAiOauth: { accessToken: 'not-a-real-token' } },
    { name: 'b@example.test', email: 'b@example.test', claudeAiOauth: { accessToken: 'not-a-real-token' } },
  ]),
);

t('★ add once HH:MM --switch-account stores the target, a default text, and says what it is', () => {
  seed([]);
  const r = run('add', 'once', '23:59', '--switch-account', 'c@example.test');
  eq(r.code, 0, r.err);
  const item = read().items[0];
  eq(item.switchAccount, 'c@example.test');
  eq(item.kind, 'once');
  eq(item.text, 'switch the Claude account to c@example.test');
  eq(item.run, undefined, 'a switch is not a Claude task');
  ok(r.out.includes('switch account to c@example.test'), r.out);
});

t('the name matches case-insensitively and is stored as the slot name; a text after it is kept', () => {
  seed([]);
  const r = run('add', 'in', '90m', '--switch-account', 'B@Example.test', 'move before the night batch');
  eq(r.code, 0, r.err);
  eq(read().items[0].switchAccount, 'b@example.test');
  eq(read().items[0].text, 'move before the night batch');
  const d = run('add', 'daily', '09:00', '--switch-account', 'c@example.test');
  eq(d.code, 0, d.err);
  ok(run('list').out.includes('daily 09:00 · switch account to c@example.test'), run('list').out);
});

t('refused: a name that is not stored names the stored ones, and nothing is written', () => {
  seed([]);
  const r = run('add', 'once', '23:59', '--switch-account', 'nobody@example.test');
  eq(r.code, 1);
  ok(r.err.includes('"nobody@example.test" is not a stored account (stored: c@example.test, b@example.test)'), r.err);
  eq(read().items.length, 0);
});

t('refused: no name, or --run with it', () => {
  seed([]);
  eq(run('add', 'once', '23:59', '--switch-account').code, 1);
  const r = run('add', 'once', '23:59', '--switch-account', 'c@example.test', '--run');
  eq(r.code, 1);
  ok(r.err.includes('do not go together'), r.err);
  eq(read().items.length, 0);
});

t('★ refused from a background worker or a scheduled run; allowed from a tmux pane', () => {
  seed([]);
  const bg = runEnv({ LEASH_LANE: 'bg' }, 'add', 'once', '23:59', '--switch-account', 'c@example.test');
  eq(bg.code, 1);
  ok(bg.err.includes("only the owner's own lanes can"), bg.err);
  const sched = runEnv({ LEASH_TRIGGER: 'schedule' }, 'add', 'once', '23:59', '--switch-account', 'c@example.test');
  eq(sched.code, 1);
  eq(read().items.length, 0);
  const pane = runEnv({ LEASH_LANE: 'bg', TMUX: '/tmp/tmux-501/default,1,0' }, 'add', 'once', '23:59', '--switch-account', 'c@example.test');
  eq(pane.code, 0, pane.err);
  const chat = runEnv({ LEASH_LANE: 'chat' }, 'add', 'once', '23:58', '--switch-account', 'c@example.test');
  eq(chat.code, 0, chat.err);
});

t('a switch entry cannot be turned into a --run by update', () => {
  seed([{ id: 1, kind: 'once', at: Date.now() + 3600_000, text: 'switch', switchAccount: 'c@example.test' }]);
  const r = run('update', '1', '--run');
  eq(r.code, 1);
  eq(read().items[0].run, undefined);
});

t('no accounts.json means nothing is stored, so the switch is refused', () => {
  rmSync(ACCOUNTS);
  seed([]);
  const r = run('add', 'once', '23:59', '--switch-account', 'c@example.test');
  eq(r.code, 1);
  ok(r.err.includes('(accounts.json has none)'), r.err);
});

t('★ update --switch-account is refused, not silently ignored (QA round 1), and the entry keeps its target', () => {
  writeFileSync(ACCOUNTS, JSON.stringify([{ name: 'c@example.test', email: 'c@example.test' }, { name: 'b@example.test', email: 'b@example.test' }]));
  seed([]);
  eq(run('add', 'once', '23:59', '--switch-account', 'c@example.test').code, 0);
  const id = read().items[0].id;
  const r = run('update', String(id), '--switch-account', 'b@example.test');
  eq(r.code, 1);
  ok(r.err.includes('--switch-account is set when an entry is added'), r.err);
  eq(read().items[0].switchAccount, 'c@example.test');
});

t('the usage text documents the flag', () => {
  ok(run('help').out.includes('--switch-account'), 'usage is missing --switch-account');
});

// ── every N hours with a script (the work sweep) ─────
const SCRIPT = path.join(WORK, 'sweep.mjs');
writeFileSync(SCRIPT, '// a sweep\n');

t('add every 2h --script stores an hours item that fires at the NEXT slot', () => {
  seed([]);
  const r = run('add', 'every', '2h', '00:05', '--script', SCRIPT, 'Work sweep: dispatch or explain each');
  eq(r.code, 0, r.err);
  const [item] = read().items;
  eq(item.kind, 'hours');
  eq(item.every, 2);
  eq(item.at, '00:05');
  eq(item.script, SCRIPT);
  eq(item.text, 'Work sweep: dispatch or explain each');
  ok(Number.isFinite(item.lastFiredAt) && item.lastFiredAt <= Date.now() && Date.now() - item.lastFiredAt < 2 * 3_600_000, 'lastFiredAt is the slot just gone by');
  ok(!('run' in item), 'a script entry is not a run');
});

t('list shows the cadence and the script', () => {
  const out = run('list').out;
  ok(out.includes('every 2h from 00:05'), out);
  ok(out.includes('script sweep.mjs, its output to the chat lane'), out);
});

t('a script that does not exist is refused, nothing saved', () => {
  seed([]);
  const r = run('add', 'every', '2h', '00:05', '--script', path.join(WORK, 'nope.mjs'), 'x');
  eq(r.code, 1);
  ok(r.err.includes('no such file'), r.err);
  eq(read().items.length, 0);
});

t('--script only goes with an hours schedule (an old daemon would remind the owner with it)', () => {
  seed([]);
  const r = run('add', 'daily', '08:00', '--script', SCRIPT, 'x');
  eq(r.code, 1);
  ok(r.err.includes('every <N>h schedule only'), r.err);
  eq(read().items.length, 0);
});

t('an hours schedule needs --script or --run', () => {
  seed([]);
  const r = run('add', 'every', '3h', '09:00', 'remind me');
  eq(r.code, 1);
  eq(read().items.length, 0);
  eq(run('add', 'every', '3h', '09:00', '--run', 'check the queue').code, 0);
  eq(read().items[0].run, true);
});

t('every 24h and every 0h are refused', () => {
  seed([]);
  eq(run('add', 'every', '24h', '00:05', '--script', SCRIPT, 'x').code, 1);
  eq(run('add', 'every', '0h', '00:05', '--script', SCRIPT, 'x').code, 1);
  eq(read().items.length, 0);
});

t('update --at re-phases an hours item and keeps it an hours item', () => {
  seed([]);
  run('add', 'every', '2h', '00:05', '--script', SCRIPT, 'sweep');
  const id = read().items[0].id;
  eq(run('update', String(id), '--at', '01:30').code, 0);
  const item = read().items[0];
  eq(item.kind, 'hours');
  eq(item.at, '01:30');
  ok(typeof item.lastFiredAt === 'number', 'still a slot stamp');
});

t('a script entry cannot be turned into a --run', () => {
  seed([]);
  run('add', 'every', '2h', '00:05', '--script', SCRIPT, 'sweep');
  const id = read().items[0].id;
  const r = run('update', String(id), '--run', 'true');
  eq(r.code, 1);
  ok(!read().items[0].run, 'unchanged');
});

// A SCRIPT THE DAEMON CAN START. A directory and a file it cannot execute were
// both accepted, then failed on every slot, said once, and went quiet.
t('a directory is refused as a script, nothing saved', () => {
  seed([]);
  const r = run('add', 'every', '2h', '00:05', '--script', WORK, 'x');
  eq(r.code, 1);
  ok(r.err.includes('not a file'), r.err);
  eq(read().items.length, 0);
});

t('a file the daemon executes itself needs its execute bit, a node file does not', () => {
  seed([]);
  const sh = path.join(WORK, 'sweep.sh');
  writeFileSync(sh, '#!/bin/sh\necho hi\n');
  chmodSync(sh, 0o644);
  const r = run('add', 'every', '2h', '00:05', '--script', sh, 'x');
  eq(r.code, 1);
  ok(r.err.includes('not executable'), r.err);
  eq(read().items.length, 0);
  chmodSync(sh, 0o755);
  eq(run('add', 'every', '2h', '00:05', '--script', sh, 'x').code, 0, 'executable now');
  chmodSync(SCRIPT, 0o644);
  eq(run('add', 'every', '2h', '00:05', '--script', SCRIPT, 'y').code, 0, 'a .mjs runs under node');
});

t('update --script takes the same checks', () => {
  seed([]);
  run('add', 'every', '2h', '00:05', '--script', SCRIPT, 'sweep');
  const id = String(read().items[0].id);
  const r = run('update', id, '--script', WORK);
  eq(r.code, 1);
  ok(r.err.includes('not a file'), r.err);
  eq(read().items[0].script, SCRIPT, 'unchanged');
});

// A SCRIPT ENTRY IS THE OWNER'S: the daemon runs it outside any worker's
// guards, so a worker or a scheduled run cannot add one or repoint one.
t('a background worker or a scheduled run cannot add a script entry', () => {
  seed([]);
  for (const env of [{ LEASH_LANE: 'bg' }, { LEASH_TRIGGER: 'schedule' }]) {
    const r = runEnv(env, 'add', 'every', '2h', '00:05', '--script', SCRIPT, 'x');
    eq(r.code, 1, JSON.stringify(env));
    ok(r.err.includes('outside any worker'), r.err);
  }
  eq(read().items.length, 0);
  eq(runEnv({ LEASH_LANE: 'chat' }, 'add', 'every', '2h', '00:05', '--script', SCRIPT, 'a').code, 0, 'the chat lane can');
  eq(runEnv({ LEASH_LANE: 'bg', TMUX: '/tmp/tmux-501/default,1,0' }, 'add', 'every', '2h', '00:05', '--script', SCRIPT, 'b').code, 0, 'a tmux pane can');
});

t('a background worker cannot repoint a script entry', () => {
  const id = String(read().items[0].id);
  const other = path.join(WORK, 'other.mjs');
  writeFileSync(other, '// another\n');
  const r = runEnv({ LEASH_LANE: 'bg' }, 'update', id, '--script', other);
  eq(r.code, 1);
  ok(r.err.includes('outside any worker'), r.err);
  eq(read().items[0].script, SCRIPT, 'unchanged');
});

// THE RULE `add` ENFORCES HOLDS ON `update`: an hours entry runs a script or a
// task, never a reminder every few hours.
t('update --run false or --no-run cannot turn an hours run into a reminder', () => {
  seed([]);
  run('add', 'every', '3h', '09:00', '--run', 'check the queue');
  const id = String(read().items[0].id);
  for (const args of [['--run', 'false'], ['--no-run']]) {
    const r = run('update', id, ...args);
    eq(r.code, 1, args.join(' '));
    ok(r.err.includes('needs --script <path> or --run'), r.err);
    eq(read().items[0].run, true, 'unchanged');
  }
});

t('list names the first slot of the day, not the time it was added at', () => {
  seed([]);
  run('add', 'every', '5h', '09:00', '--run', 'check the queue');
  ok(run('list').out.includes('every 5h from 04:00'), run('list').out);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log('\nclaude only (a run that waits for Claude through a wall)');
// ---------------------------------------------------------------------------

seed([{ id: 8, kind: 'daily', at: '03:00', text: 'memory sync', lastFired: today(), run: true }]);

t('update --claude-only true sets it, and the line says so', () => {
  const r = run('update', '8', '--claude-only', 'true');
  eq(r.code, 0, r.err);
  eq(read().items[0].claudeOnly, true);
  ok(/claude only/.test(r.out), r.out);
});
t('list shows it', () => ok(/#8 .*run \(claude only\) · memory sync/.test(run('list').out), run('list').out));
t('it rides beside a write approval on the same line', () => {
  eq(run('update', '8', '--allow-write', 'true').code, 0);
  ok(/run \(writes approved, claude only\)/.test(run('list').out), run('list').out);
  eq(run('update', '8', '--allow-write', 'false').code, 0);
});
t('the value is not taken for text or for another flag', () => {
  eq(read().items[0].text, 'memory sync');
  eq(run('update', '8', '--claude-only', 'true', '--text', 'memory sync v2').code, 0);
  eq(read().items[0].text, 'memory sync v2');
  eq(read().items[0].claudeOnly, true);
});
t('update --claude-only false takes it off, field and all', () => {
  const r = run('update', '8', '--claude-only', 'false');
  eq(r.code, 0, r.err);
  ok(!('claudeOnly' in read().items[0]), 'the field is still there');
  ok(!/claude only/.test(run('list').out), run('list').out);
});
t('an entry that never had it prints as it always did', () => ok(/· run · memory sync v2/.test(run('list').out), run('list').out));
t('any other value is refused, and nothing changes', () => {
  for (const args of [['--claude-only', 'yes'], ['--claude-only']]) {
    const r = run('update', '8', ...args);
    eq(r.code, 1, args.join(' '));
    ok(/--claude-only true\|false/.test(r.err), r.err);
  }
  ok(!('claudeOnly' in read().items[0]), 'a refused value changed the store');
});
t('turning --run off takes the flag with it', () => {
  eq(run('update', '8', '--claude-only', 'true').code, 0);
  eq(run('update', '8', '--run', 'false').code, 0);
  ok(!('claudeOnly' in read().items[0]), 'a reminder carries an engine flag');
});
t('a reminder cannot take it: nothing there picks an engine', () => {
  const r = run('update', '8', '--claude-only', 'true');
  eq(r.code, 1);
  ok(/needs a --run schedule/.test(r.err), r.err);
  ok(!('claudeOnly' in read().items[0]), 'a refused flag changed the store');
});
t('add refuses it and adds nothing, rather than dropping the flag in silence', () => {
  const before = read().items.length;
  const r = run('add', 'daily', '08:00', '--run', '--claude-only', 'true', 'a job');
  eq(r.code, 1);
  ok(/update <id> --claude-only true/.test(r.err), r.err);
  eq(read().items.length, before);
});
t('a background worker may set it: it picks an engine, it grants nothing', () => {
  seed([{ id: 8, kind: 'daily', at: '03:00', text: 'memory sync', lastFired: today(), run: true }]);
  const r = runEnv({ LEASH_LANE: 'bg' }, 'update', '8', '--claude-only', 'true');
  eq(r.code, 0, r.err);
  eq(read().items[0].claudeOnly, true);
});

// ---- update on an every-N-hours script entry (SWEEP-COST-1108) --------------
const SCRIPT_A = path.join(WORK, 'a.mjs');
const SCRIPT_B = path.join(WORK, 'b.mjs');
writeFileSync(SCRIPT_A, '');
writeFileSync(SCRIPT_B, '');
const HOURS = () => ({ id: 1, kind: 'hours', every: 2, at: '00:05', text: 'the sweep', script: SCRIPT_A, lastFiredAt: Date.now() - 86_400_000 });

t('--every on an hours entry sets the hours, and the next fire is the next slot, not now', () => {
  seed([HOURS()]);
  const before = Date.now();
  const r = run('update', '1', '--every', '1');
  eq(r.code, 0, r.err);
  const item = read().items[0];
  eq(item.every, 1);
  ok(item.lastFiredAt > before - 3_700_000 && item.lastFiredAt <= Date.now(), `lastFiredAt ${item.lastFiredAt} is not the latest slot`);
  ok(r.out.includes('every 1h from 00:05'), r.out);
});
t('--every 1 on an hours entry keeps the 1: it is every hour, not back to daily', () => {
  seed([HOURS()]);
  run('update', '1', '--every', '1');
  eq(read().items[0].every, 1);
  eq(read().items[0].kind, 'hours');
});
t('--every keeps a lastFiredAt in the future: that is a pause set by hand, and a cadence change must not lift it', () => {
  const pausedUntil = Date.now() + 86_400_000;
  seed([{ ...HOURS(), lastFiredAt: pausedUntil }]);
  const r = run('update', '1', '--every', '1', '--script', SCRIPT_B, '--text', 'new words');
  eq(r.code, 0, r.err);
  const item = read().items[0];
  eq(item.lastFiredAt, pausedUntil);
  eq(item.every, 1);
  eq(item.script, SCRIPT_B);
});
t('--at lifts that pause: it is the way to resume an hours entry', () => {
  const pausedUntil = Date.now() + 86_400_000;
  seed([{ ...HOURS(), every: 1, lastFiredAt: pausedUntil }]);
  eq(run('update', '1', '--at', '00:05').code, 0);
  const item = read().items[0];
  ok(item.lastFiredAt <= Date.now() && item.lastFiredAt > Date.now() - 3_700_000, `lastFiredAt ${item.lastFiredAt} is not the latest slot`);
});
t('--every outside 1 to 23 on an hours entry is refused, and the store is untouched', () => {
  for (const n of ['0', '24', '1.5', 'x', '-1']) {
    const item = HOURS();
    seed([item]);
    ok(run('update', '1', '--every', n).code !== 0, `--every ${n} was accepted`);
    eq(JSON.stringify(read().items[0]), JSON.stringify(item), `--every ${n} wrote to the store`);
  }
});
t('--script points a script entry at another script, and keeps its text and id', () => {
  seed([HOURS()]);
  const r = run('update', '1', '--script', SCRIPT_B);
  eq(r.code, 0, r.err);
  const item = read().items[0];
  eq(item.script, SCRIPT_B);
  eq(item.text, 'the sweep');
  eq(item.id, 1);
  ok(r.out.includes('script b.mjs'), r.out);
});
t('--script and --every and --text in one call: the switch a sweep needs', () => {
  seed([HOURS()]);
  const r = run('update', '1', '--script', SCRIPT_B, '--every', '1', '--text', 'new words');
  eq(r.code, 0, r.err);
  const item = read().items[0];
  eq(item.script, SCRIPT_B);
  eq(item.every, 1);
  eq(item.text, 'new words');
});
t('--script to a file that does not exist is refused, and the store is untouched', () => {
  const item = HOURS();
  seed([item]);
  ok(run('update', '1', '--script', path.join(WORK, 'nope.mjs')).code !== 0);
  ok(run('update', '1', '--script').code !== 0, '--script with nothing after it reported success');
  eq(JSON.stringify(read().items[0]), JSON.stringify(item));
});
t('--script is refused on an entry that has no script: an older daemon would read it as a reminder', () => {
  const item = { id: 1, kind: 'daily', at: '08:00', text: 'x' };
  seed([{ ...item }]);
  ok(run('update', '1', '--script', SCRIPT_B).code !== 0);
  eq(JSON.stringify(read().items[0]), JSON.stringify(item));
});

rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
