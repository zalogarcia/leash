// wall-guard.mjs: the usage wall guard, part 1 (save the work before the
// wall). The trigger table, the steer text, the owner's line, and the state
// record that keeps each of them once only across daemon restarts.
// Run: node wall-guard.test.mjs

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WALL_GUARD_DEFAULTS,
  wallGuardSettings,
  wallGuardStatusLine,
  openWindows,
  checkpointTrigger,
  checkpointDecision,
  checkpointCandidates,
  checkpointSteerText,
  checkpointNotice,
  nextAccountAfter,
  createWallGuardStore,
  baseRunId,
  JOB_KEEP_MS,
} from './wall-guard.mjs';

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
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || 'expected truthy');
};
// The dash rule, checked by code point so this file carries no dash itself.
const DASHES = /[\u2013\u2014]/;

const NOW = Date.UTC(2026, 9, 6, 15, 30, 0);
const MIN = 60_000;
const iso = (mins) => new Date(NOW + mins * MIN).toISOString();
const usage = (five, weekly = 40, { fiveReset = iso(50), weeklyReset = iso(3 * 24 * 60), scoped = [] } = {}) => ({
  fiveHour: { percent: five, resetsAt: fiveReset },
  sevenDay: { percent: weekly, resetsAt: weeklyReset },
  scoped,
});
const W = (runId, extra = {}) => ({ runId, lane: runId.split('-')[0], engine: 'claude', steerable: true, title: `job ${runId}`, ...extra });
const S = wallGuardSettings(undefined);

// ---------------------------------------------------------------------------
console.log('\n1. settings: a missing block means ON with the defaults');
// ---------------------------------------------------------------------------

t('★ no wallGuard block in config.json: on, 95, resume on, 5 minutes, chain 2, 4 at a time', () => {
  eq(wallGuardSettings(undefined), { enabled: true, thresholdPercent: 95, resume: true, resumeWithinMinutes: 5, resumeChainMax: 2, resumeMaxConcurrent: 4 });
  eq(wallGuardSettings(null), wallGuardSettings({}));
  eq(WALL_GUARD_DEFAULTS.thresholdPercent, 95);
});

t('★ the one off switch: false, or enabled false', () => {
  eq(wallGuardSettings(false).enabled, false);
  eq(wallGuardSettings({ enabled: false }).enabled, false);
});

t('each value is read, and a typo falls back or is clamped, never removes the guard', () => {
  const s = wallGuardSettings({ thresholdPercent: 90, resume: false, resumeWithinMinutes: 3, resumeChainMax: 1 });
  eq([s.thresholdPercent, s.resume, s.resumeWithinMinutes, s.resumeChainMax], [90, false, 3, 1]);
  eq(wallGuardSettings({ thresholdPercent: 9.5 }).thresholdPercent, 50, 'a typo for 95 must not steer at a tenth of a window');
  eq(wallGuardSettings({ thresholdPercent: 'abc' }).thresholdPercent, 95);
  eq(wallGuardSettings({ thresholdPercent: 120 }).thresholdPercent, 100);
  eq(wallGuardSettings({ resumeChainMax: -3 }).resumeChainMax, 0);
  eq(wallGuardSettings({ enabled: 'yes' }).enabled, true, 'only a real boolean switches it');
});

t('★ the resume pace: a number is read, 0 or false means no pace of its own, a typo keeps the default', () => {
  eq(wallGuardSettings({ resumeMaxConcurrent: 2 }).resumeMaxConcurrent, 2);
  eq(wallGuardSettings({ resumeMaxConcurrent: '6' }).resumeMaxConcurrent, 6, 'a string from an environment override');
  eq(wallGuardSettings({ resumeMaxConcurrent: 0 }).resumeMaxConcurrent, 0);
  eq(wallGuardSettings({ resumeMaxConcurrent: false }).resumeMaxConcurrent, 0);
  eq(wallGuardSettings({ resumeMaxConcurrent: 2.9 }).resumeMaxConcurrent, 2, 'never half a worker');
  eq(wallGuardSettings({ resumeMaxConcurrent: -1 }).resumeMaxConcurrent, 0);
  eq(wallGuardSettings({ resumeMaxConcurrent: 'four' }).resumeMaxConcurrent, 4, 'a typo must not remove the pace');
  eq(wallGuardSettings({ resumeMaxConcurrent: true }).resumeMaxConcurrent, 4);
  eq(wallGuardSettings({ resumeMaxConcurrent: 9999 }).resumeMaxConcurrent, 50);
});

t('/status line, on and off, no dashes', () => {
  const on = wallGuardStatusLine(S);
  ok(/save at 95%/.test(on) && /within 5 min/.test(on) && /at most 2 per job/.test(on), on);
  ok(/, 4 at a time$/.test(on), on);
  ok(!/at a time/.test(wallGuardStatusLine(wallGuardSettings({ resumeMaxConcurrent: 0 }))), 'no pace, no words about one');
  eq(wallGuardStatusLine(wallGuardSettings({ resume: false })), '🛡 Wall guard: save at 95% · resume off');
  eq(wallGuardStatusLine(wallGuardSettings(false)), '🛡 Wall guard: off');
  ok(!DASHES.test(on));
});

// ---------------------------------------------------------------------------
console.log('\n2. ★ the trigger table (acceptance criterion 1)');
// ---------------------------------------------------------------------------

const decide = (o = {}) =>
  checkpointDecision({ settings: S, usage: usage(96), account: 'acct-a', now: NOW, othersFree: false, workers: [W('bg-1791290000001'), W('bg2-1791290000002')], steered: [], ...o });

t('★ FIRES at the threshold, with a fresh reading and no free account', () => {
  const d = decide({ usage: usage(95) });
  eq(d.fire, true, d.reason);
  eq(d.targets.map((w) => w.runId), ['bg-1791290000001', 'bg2-1791290000002']);
  eq(d.window.kind, 'fiveHour');
  ok(d.key.startsWith('acct-a|fiveHour|'), d.key);
});

t('★ does NOT fire on a stale reading (its window already reset)', () => {
  const d = decide({ usage: usage(99, 99, { fiveReset: iso(-1), weeklyReset: iso(-1) }) });
  eq([d.fire, d.reason], [false, 'stale']);
});

t('★ does NOT fire with another account free', () => {
  eq([decide({ othersFree: true }).fire, decide({ othersFree: true }).reason], [false, 'another account is free']);
});

t('and does not fire when availability is unknown (the selector answered nothing)', () => {
  eq(decide({ othersFree: null }).fire, false);
  eq(decide({ othersFree: undefined }).reason, 'account availability unknown');
});

t('★ does NOT fire with no Claude worker running (a Codex worker does not count)', () => {
  eq(decide({ workers: [] }).reason, 'no Claude worker running');
  eq(decide({ workers: [W('codex-1791290000003', { engine: 'codex' })] }).reason, 'no Claude worker running');
});

t('★ does NOT fire below the threshold', () => {
  const d = decide({ usage: usage(94.9) });
  eq([d.fire, d.reason], [false, 'below threshold']);
});

t('★ does NOT fire a second time for the same worker in the same window', () => {
  const first = decide();
  const again = decide({ steered: first.targets.map((w) => w.runId) });
  eq([again.fire, again.reason], [false, 'already steered']);
});

t('★ a re-attached worker (registry key with a pid tail) is matched to its record by base id', () => {
  const d = decide({ workers: [W('bg-1791290000001'), W('bg3-1791290000004-83808', { steerable: false })], steered: ['bg-1791290000001', 'bg3-1791290000004'] });
  eq([d.fire, d.reason], [false, 'already steered']);
});

t('the environment override string "false" is the off switch too', () => {
  eq(wallGuardSettings('false').enabled, false);
  eq(wallGuardSettings('off').enabled, false);
  eq(wallGuardSettings('true').enabled, true);
});

t('a worker that starts later in the same window is told; the others are not told again', () => {
  const d = decide({ steered: ['bg-1791290000001'] });
  eq(d.targets.map((w) => w.runId), ['bg2-1791290000002']);
});

t('the next window is a new key, so the same worker can be told again then', () => {
  const a = decide().key;
  const b = decide({ usage: usage(97, 40, { fiveReset: iso(5 * 60 + 50) }) }).key;
  ok(a !== b, `${a} vs ${b}`);
});

t('the guard switched off never fires', () => {
  eq(checkpointDecision({ settings: wallGuardSettings(false), usage: usage(99), account: 'a', now: NOW, othersFree: false, workers: [W('bg-1791290000001')] }).reason, 'off');
});

t('★ the weekly window arms it too (the weekly wall kills through the same path)', () => {
  const d = decide({ usage: usage(30, 96) });
  eq([d.fire, d.window.kind, d.window.label], [true, 'sevenDay', 'the weekly window']);
});

t('and a per model weekly window does as well', () => {
  const d = decide({ usage: usage(30, 40, { scoped: [{ label: 'Fable', percent: 97, resetsAt: iso(600) }] }) });
  eq([d.fire, d.window.label], [true, 'the weekly Fable window']);
});

t('the five hour window is named whenever it is over the threshold (it walls first); else the fullest', () => {
  eq(decide({ usage: usage(96, 98) }).window.kind, 'fiveHour');
  eq(decide({ usage: usage(97, 97) }).window.kind, 'fiveHour');
  eq(decide({ usage: usage(30, 98, { scoped: [{ label: 'Fable', percent: 99, resetsAt: iso(600) }] }) }).window.label, 'the weekly Fable window');
});

t('★ QA 2026-10-06: the weekly and five hour windows both over, their order flipping, is ONE episode', () => {
  const first = decide({ usage: usage(30, 97) }); // the weekly window arms it
  eq(first.fire, true);
  const flipped = decide({ usage: usage(98, 97), steered: first.targets.map((w) => w.runId) });
  eq(flipped.key, first.key, 'the same five hour window is the same key, whatever window armed it');
  eq([flipped.fire, flipped.reason], [false, 'already steered']);
});

t('with no five hour window in the reading at all, the arming window keys it', () => {
  const d = decide({ usage: { sevenDay: { percent: 97, resetsAt: iso(3 * 24 * 60) }, scoped: [] } });
  eq(d.fire, true);
  ok(d.key.includes('|sevenDay|'), d.key);
});

t('★ QA round 2: a reading taken before the five hour reset is stale as a whole, so a boundary is TWO episodes, not three', () => {
  const weekly = 97; // over the threshold the whole time
  const before = decide({ usage: usage(40, weekly, { fiveReset: iso(1) }) });
  // 30 seconds past the reset, still holding the reading from before it.
  const gap = decide({ usage: usage(40, weekly, { fiveReset: iso(1) }), now: NOW + 1.5 * MIN });
  const after = decide({ usage: usage(1, weekly, { fiveReset: iso(301) }), now: NOW + 2 * MIN });
  eq([before.fire, after.fire], [true, true]);
  eq([gap.fire, gap.reason, gap.key], [false, 'stale', null], 'armed by its weekly figure it opened a third episode under the weekly key');
  eq(new Set([before.key, gap.key, after.key].filter(Boolean)).size, 2);
  ok(before.key.includes('|fiveHour|') && after.key.includes('|fiveHour|') && before.key !== after.key);
});

t('a five hour window with no readable reset does not make the reading stale; the weekly window still arms it', () => {
  const d = decide({ usage: { fiveHour: { percent: 10, resetsAt: null }, sevenDay: { percent: 97, resetsAt: iso(3 * 24 * 60) }, scoped: [] } });
  eq([d.fire, d.window.kind], [true, 'sevenDay']);
});

t('★ a worker that cannot be steered is UNREACHABLE, named, and still makes the guard fire', () => {
  const d = decide({ workers: [W('bg-1791290000001'), W('bg3-1791290000004', { steerable: false })] });
  eq(d.fire, true);
  eq(d.targets.map((w) => w.runId), ['bg-1791290000001']);
  eq(d.unreachable.map((w) => w.runId), ['bg3-1791290000004']);
});

t('no reading at all, or no account name, does not fire', () => {
  eq(decide({ usage: null }).reason, 'no reading');
  eq(decide({ account: null }).reason, 'no reading');
});

t('the cheap precheck agrees with the decision and never asks for the selector', () => {
  eq(checkpointCandidates({ settings: S, usage: usage(96), account: 'a', now: NOW, workers: [W('bg-1791290000001')] }).ready, true);
  eq(checkpointCandidates({ settings: S, usage: usage(50), account: 'a', now: NOW, workers: [W('bg-1791290000001')] }).ready, false);
  eq(checkpointCandidates({ settings: S, usage: usage(96), account: 'a', now: NOW, workers: [] }).ready, false);
});

t('openWindows: only open windows with a readable percent', () => {
  const w = openWindows({ fiveHour: { percent: null, resetsAt: iso(10) }, sevenDay: { percent: 50, resetsAt: iso(-5) }, scoped: [{ label: 'X', percent: 10, resetsAt: Date.parse(iso(30)) }] }, NOW);
  eq(w.map((x) => x.kind), ['scoped:X'], 'epoch ms resets are read too');
});

// ---------------------------------------------------------------------------
console.log('\n3. ★ the steer text (acceptance criterion 3)');
// ---------------------------------------------------------------------------

const STEER = checkpointSteerText({ percent: 96.4, windowLabel: 'the 5 hour window', resume: true });

t('★ says the account is about to reach its limit and the run can end at any step', () => {
  ok(/96% of the 5 hour window/.test(STEER), STEER);
  ok(/no other account can take over/.test(STEER));
  ok(/can end at ANY step/.test(STEER));
});

t('★ finish the step in hand; no new long step (deploy, migration, send, full test run); in flight production finished and verified', () => {
  ok(/FINISH THE STEP IN HAND/.test(STEER));
  ok(/no new deploy, migration, send or full test run/.test(STEER));
  ok(/already in flight is finished and verified first, never left half done/.test(STEER));
});

t('★ commit WIP on its OWN branch or worktree, files staged by name, a WIP checkpoint message', () => {
  ok(/on your OWN branch or worktree/.test(STEER));
  ok(/staging files by name/.test(STEER));
  ok(/starts with "WIP checkpoint"/.test(STEER));
});

t('★ no push, no deploy, no merge, no migration for the checkpoint', () => {
  ok(/no push, no deploy, no merge, no migration/.test(STEER));
});

t('★ the patch fallback for a shared checkout or a default branch the brief did not allow commits on', () => {
  ok(/shared checkout/.test(STEER) && /default branch where your brief did not allow commits/.test(STEER));
  ok(/write a patch file instead/.test(STEER));
});

t('★ the resume note fields, in the draft report file', () => {
  for (const want of [/\$BG_REPORT_DRAFT/, /RESUME NOTE/, /what is done/, /what is left/, /branch and the commit sha/, /patch path/, /not committed and why/, /every production write/, /verified or not/, /exact next step/]) {
    ok(want.test(STEER), `missing ${want}`);
  }
});

t('★ then CONTINUE: never a stop', () => {
  ok(/CONTINUE the job/.test(STEER));
  ok(/This is not a stop/.test(STEER));
  ok(!/\bstop (the|your) (job|work|run)\b/i.test(STEER), 'it must never tell a worker to stop');
});

t('★ no private marker and no dash: it ships in the public repo', () => {
  // No address, no home path, no name for the chat lane: generic markers, so
  // this shared file carries no private name of its own either.
  for (const bad of [/@/, /\/Users\//, /\/home\//, /\bM\b/]) ok(!bad.test(STEER), `found ${bad}`);
  ok(!DASHES.test(STEER), 'an em or en dash');
});

t('the restart promise is made only when the resume half is on', () => {
  ok(/bridge restarts it after the limit lifts/.test(STEER));
  const off = checkpointSteerText({ percent: 96, resume: false });
  ok(!/bridge restarts it/.test(off), off);
  ok(/CONTINUE the job/.test(off));
});

t('an unreadable percent still produces a sentence', () => {
  ok(/nearly all of/.test(checkpointSteerText({ percent: null })));
});

// ---------------------------------------------------------------------------
console.log("\n4. ★ the owner's line at the threshold (acceptance criterion 4)");
// ---------------------------------------------------------------------------

const NOTICE = checkpointNotice({
  account: 'acct-a',
  percent: 96,
  windowLabel: 'the 5 hour window',
  thresholdPercent: 95,
  steered: [W('bg-1791290000001'), W('bg2-1791290000002')],
  unreachable: [{ lane: 'bg3', title: 'Render the reels', why: 'survived a restart' }],
  next: { name: 'acct-b', clock: '1:20pm' },
});

t('★ usage at the threshold, no free account, how many were told, who could not be reached, the next account and its reset', () => {
  ok(/96% of the 5 hour window · threshold 95%/.test(NOTICE), NOTICE);
  ok(/acct-a · no other account is free/.test(NOTICE));
  ok(/Told 2 workers to save a checkpoint/.test(NOTICE));
  ok(/Could not reach 1/.test(NOTICE) && /bg3 · Render the reels \(survived a restart\)/.test(NOTICE));
  ok(/Next account: acct-b · resets 1:20pm/.test(NOTICE));
});

t('house style: one fact per line, middle dot separators, no dashes', () => {
  ok(!DASHES.test(NOTICE));
  ok(NOTICE.split('\n').every((l) => l.length < 160));
});

t('no reachable worker and no known next account still say so', () => {
  const n = checkpointNotice({ account: 'a', percent: 99, steered: [], unreachable: [{ lane: 'bg', title: 'x' }], next: null });
  ok(/No worker could be told to save/.test(n) && /no reset time known yet/.test(n), n);
});

t('nextAccountAfter: the earliest KNOWN reset among the others and the live window', () => {
  const rows = [
    { name: 'acct-a', captured: true, limited: false },
    { name: 'acct-b', captured: true, limited: true, limitedUntil: Math.floor((NOW + 120 * MIN) / 1000), limitedSource: 'probe' },
    { name: 'acct-c', captured: true, limited: true, limitedUntil: Math.floor((NOW + 30 * MIN) / 1000), limitedSource: 'guessed' },
    { name: 'acct-d', captured: true, limited: true, limitedUntil: Math.floor((NOW + 10 * MIN) / 1000), needsLogin: { reason: 'x' } },
  ];
  eq(nextAccountAfter({ rows, active: 'acct-a', activeResetMs: NOW + 200 * MIN, now: NOW }).name, 'acct-b', 'a guess and a dead login never win');
  eq(nextAccountAfter({ rows, active: 'acct-a', activeResetMs: NOW + 50 * MIN, now: NOW }).name, 'acct-a', 'the live window frees first');
  eq(nextAccountAfter({ rows: [], active: null, now: NOW }), null);
});

// ---------------------------------------------------------------------------
console.log('\n5. ★ the state record: once per window, across a daemon restart');
// ---------------------------------------------------------------------------

const TMP = mkdtempSync(path.join(tmpdir(), 'wall-guard-test-'));
const FILE = path.join(TMP, 'wall-guard.json');
let clock = NOW;
const make = () => createWallGuardStore({ file: FILE, now: () => clock });

t('★ a steered worker is remembered after a restart, so the decision does not fire for it again', () => {
  const key = decide().key;
  const a = make();
  a.steered(key, 'bg-1791290000001', { lane: 'bg' });
  a.unreachable(key, 'bg3-1791290000004', { why: 'survived a restart' });
  const b = make(); // the daemon restarted: a new object on the same file
  eq(b.handled(key).sort(), ['bg-1791290000001', 'bg3-1791290000004']);
  const d = decide({ steered: b.handled(key), workers: [W('bg-1791290000001'), W('bg3-1791290000004', { steerable: false })] });
  eq([d.fire, d.reason], [false, 'already steered']);
});

t('★ the owner line is claimed ONCE per window, across a restart', () => {
  const key = 'acct-a|fiveHour|123';
  eq(make().claimNotice(key), true);
  eq(make().claimNotice(key), false, 'a restart must not send it again');
  eq(make().claimNotice('acct-a|fiveHour|456'), true, 'the next window is a new episode');
});

t('a re-attached worker id (with its pid tail) is the same run', () => {
  eq(baseRunId('bg4-1791290000005-83808'), 'bg4-1791290000005');
  const key = 'k-tail';
  const s = make();
  s.steered(key, 'bg4-1791290000005-83808');
  eq(make().handled(key), ['bg4-1791290000005']);
});

t('the dispatch record merges, and a death carries it', () => {
  const s = make();
  s.job('bg5-1791290000006', { scheduleId: 7 });
  s.job('bg5-1791290000006', { cwd: '/tmp/repo-x' });
  eq(make().jobOf('bg5-1791290000006').scheduleId, 7);
  s.death('bg5-1791290000006', { text: 'brief', title: 'x' });
  const d = make().deathOf('bg5-1791290000006');
  eq([d.cwd, d.scheduleId, d.text, d.runId], ['/tmp/repo-x', 7, 'brief', 'bg5-1791290000006']);
});

t('★ claimResume: once per death, across a restart', () => {
  eq(make().claimResume('bg6-1791290000007', { count: 1 }), true);
  eq(make().claimResume('bg6-1791290000007', { count: 1 }), false);
  eq(make().wasResumed('bg6-1791290000007-999'), true, 'by base id');
});

t('★ a claim that cannot be written is refused (a claim that does not survive a restart could resume twice)', () => {
  const dir = path.join(TMP, 'no-such-dir');
  const s = createWallGuardStore({ file: path.join(dir, 'x.json'), now: () => clock });
  eq(s.claimResume('bg7-1791290000008'), false);
  eq(s.wasResumed('bg7-1791290000008'), false);
});

t('old records are pruned by age', () => {
  const s = make();
  s.job('bg8-1791290000009', { cwd: '/x' });
  clock = NOW + JOB_KEEP_MS + MIN;
  eq(make().jobOf('bg8-1791290000009'), null);
  clock = NOW;
});

t('the store writes nowhere but its own file', () => {
  ok(existsSync(FILE));
  ok(JSON.parse(readFileSync(FILE, 'utf8')).v === 1);
});

t('a half written file reads as empty rather than throwing', () => {
  writeFileSync(FILE, '{"v":1,"jobs":');
  eq(make().deaths(), []);
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all wall-guard tests pass');
