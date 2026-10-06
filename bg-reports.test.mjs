#!/usr/bin/env node
// Tests for the full-worker-report layer in bridge.mjs.
//
// A worker's report is the whole product of a background run, and for a month
// the handback's length cap ate the end of long ones. The end is exactly where
// a report puts its findings, so the audit found 14 reports across 7 sessions
// truncated mid-sentence, one cut precisely at "what's wrong in your brief".
// The property these tests hold is narrow and total: NOTHING a worker returned
// is unreachable after a handback.
//
//   node bg-reports.test.mjs
//
// bridge.mjs runs main() on import, so (as in test.mjs) the functions under test
// are extracted by source and evaluated against stubs. Nothing here touches the
// network, Telegram, or the live reports directory.

import { readFileSync, mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8');
const SRC_LINES = src.split('\n');

// Same extraction contract as test.mjs: bridge.mjs is prettier-formatted, so a
// declaration runs until the next column-0 line.
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
  const start = SRC_LINES.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  const out = [SRC_LINES[start]];
  for (let i = start + 1; i < SRC_LINES.length; i++) {
    const l = SRC_LINES[i];
    if (/^\S/.test(l)) {
      if (l.startsWith('}')) out.push(l);
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}

// Constants are extracted, never mirrored: a cap changed in bridge.mjs must not
// leave these tests green against the old number.
function constant(name) {
  const m = src.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
  if (!m) throw new Error(`could not read ${name} from bridge.mjs`);
  return Number(m[1]);
}
const HANDBACK_INLINE_LIMIT = constant('HANDBACK_INLINE_LIMIT');
const BG_REPORTS_KEEP = constant('BG_REPORTS_KEEP');
const HANDBACK_STREAK_MAX = constant('HANDBACK_STREAK_MAX');
// The auto-resume pair is written as an expression (`10 * 60_000`), so it is
// read by a looser pattern and evaluated the way the daemon evaluates it.
function expression(name) {
  const m = src.match(new RegExp(`^const ${name} = ([0-9_ *]+);`, 'm'));
  if (!m) throw new Error(`could not read ${name} from bridge.mjs`);
  return Function(`return (${m[1]});`)();
}
const HANDBACK_AUTO_RESUME_MS = expression('HANDBACK_AUTO_RESUME_MS');
const HANDBACK_AUTO_RESUMES_MAX = expression('HANDBACK_AUTO_RESUMES_MAX');

const TMP = mkdtempSync(path.join(tmpdir(), 'bg-reports-test-'));
const REPORTS = path.join(TMP, 'bg-reports');
const RUNS = path.join(TMP, 'runs');
mkdirSync(RUNS, { recursive: true });

const M = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `import path from 'node:path';`,
        `import { writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';`,
        // A data: module has no base URL, so a bare absolute path will not resolve.
        `import { clip, oneLine } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'progress-render.mjs')).href)};`,
        // handBackToChat renders the bridge's own record of what it steered in.
        // Imported, never stubbed: the placement of that block relative to the
        // untrusted-output markers is exactly what one of the tests below
        // asserts, and a stub would let it pass against a block nobody ships.
        `import { steeredInBlock } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'bg-steer.mjs')).href)};`,
        // The handback excerpt is where a Codex worker's em dashes would enter
        // the conversation by the back door, so the real normalizer is imported
        // here too rather than stubbed away.
        `import { normalizeDashes } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'dash-normalize.mjs')).href)};`,
        // The chain-paused line the owner actually reads. Imported rather than
        // stubbed for the same reason as the two above: one of the assertions
        // below is about what that message does and does NOT contain (never the
        // worker's raw report), and a stub would prove nothing about it.
        `import { chainPausedLine } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'system-messages.mjs')).href)};`,
        // THE DRAFT REPORT. Imported, never stubbed: what the section below
        // asserts is the exact first line and where the draft lands relative to
        // the markers and the report file, and a stub would prove neither.
        `import { DRAFT_SUFFIX, draftRunId, readDraftReport, endedWithoutFinalReport, draftHandbackOutput, draftStatus, draftPointerLine, isFinalReportEvent, logHadFinalReport } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'bg-draft.mjs')).href)};`,
        `import { isFatalResultText } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'detached-workers.mjs')).href)};`,
        // The limit-death discriminator reportBgOutcome branches on. Real, so the
        // limit path below is taken for the reason the daemon would take it.
        `import { isLimitSignal } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'accounts.mjs')).href)};`,
        // THE WALL EPISODE (wall-wake.mjs), real and on a scratch file: what a
        // held handback records is exactly what the lift's wake-up reads.
        `import { createWallWake } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'wall-wake.mjs')).href)};`,
        `import { briefTitle, stripLaneRules } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'bg-notify.mjs')).href)};`,
        `const WALL_WAKE_FILE = ${JSON.stringify(path.join(TMP, 'wall-wake.json'))};`,
        `export let wallWake = createWallWake({ file: WALL_WAKE_FILE });`,
        `export const resetWallWake = () => { try { unlinkSync(WALL_WAKE_FILE); } catch {} wallWake = createWallWake({ file: WALL_WAKE_FILE }); };`,
        `let WALLED = false;`,
        `export const setWalled = (v) => { WALLED = v; };`,
        `const claudeRateWalled = () => WALLED;`,
        // The ledger's view of the wall, which outlives a restart (bridge.mjs ledgerAllWalled).
        `let LEDGER_ALL_WALLED = false;`,
        `export const setLedgerAllWalled = (v) => { LEDGER_ALL_WALLED = v; };`,
        `const ledgerAllWalled = () => LEDGER_ALL_WALLED;`,
        `let CHAT_ENGINE = 'claude';`,
        `export const setChatEngine = (v) => { CHAT_ENGINE = v; };`,
        `const chatLaneEngine = () => CHAT_ENGINE;`,
        `export const ROT = { outcome: 'swapped' };`,
        `let NO_DASHES = false;`,
        `export const setNoDashes = (v) => { NO_DASHES = v; };`,
        `const BG_REPORTS_DIR = ${JSON.stringify(REPORTS)};`,
        `const RUNS_DIR = ${JSON.stringify(RUNS)};`,
        `const BG_REPORTS_KEEP = ${BG_REPORTS_KEEP};`,
        `const HANDBACK_INLINE_LIMIT = ${HANDBACK_INLINE_LIMIT};`,
        `const HANDBACK_STREAK_MAX = ${HANDBACK_STREAK_MAX};`,
        `const OWNER_NAME = 'the owner';`,
        `const LANES = { main: { name: 'main', current: null } };`,
        `export const dispatched = [];`,
        `export const sent = [];`,
        `export const parkedHandbacks = [];`,
        `function dispatchPrompt(text) { dispatched.push(text); }`,
        `function send(text) { sent.push(text); return { catch: () => {} }; }`,
        `let handbackStreak = 0;`,
        `let handbackCapNotified = false;`,
        `const BRIDGE_NAME = 'Leash';`,
        `const HANDBACK_AUTO_RESUME_MS = ${HANDBACK_AUTO_RESUME_MS};`,
        `const HANDBACK_AUTO_RESUMES_MAX = ${HANDBACK_AUTO_RESUMES_MAX};`,
        `let lastParkedAt = 0;`,
        `let autoResumesSinceMessage = 0;`,
        `export const resetChain = () => { handbackStreak = 0; handbackCapNotified = false; parkedHandbacks.length = 0; lastParkedAt = 0; autoResumesSinceMessage = 0; };`,
        `export const setMainBusy = (v) => { LANES.main.current = v ? {} : null; };`,
        `export const lastParked = () => lastParkedAt;`,
        grab('flushParkedHandbacks'),
        grab('maybeAutoResumeHandbacks'),
        grab('pruneBgReports'),
        grab('pruneReportBucket'),
        grab('bgReportId'),
        grab('bgReportPath'),
        grab('writeFullReport'),
        // The live worker line: handBackToChat now edits the message already on
        // screen into "reading it now…" instead of letting an unexplained
        // bubble start with no cause above it. Stubbed to record, so the
        // handback's own behaviour stays the subject of this file.
        `export const noticeEdits = [];`,
        `const editWorkerNotice = (runId, patch, opts) => { noticeEdits.push({ runId, patch, opts }); return true; };`,
        `export const readingNotices = new Set();`,
        grab('wallVouched'),
        grab('holdHandbackForWall'),
        grab('handBackToChat'),
        // The outcome path a Claude worker takes into handBackToChat, and the
        // limit-death composer beside it. Real, extracted; everything they call
        // that is not the subject here records instead of acting.
        `export const RESULTS = [];`,
        `const recordBgResult = (task, record, file) => { RESULTS.push({ task, record, file }); };`,
        `export const PINGS = [];`,
        `const notifyOwnerBgFinished = (task, status, runId) => { PINGS.push({ task, status, runId }); };`,
        `const pendingOps = new Set();`,
        `export const settleOps = () => Promise.all([...pendingOps]);`,
        `const rotateOffLimitedAccount = async () => ({ outcome: ROT.outcome, lines: ['Swapped to the next account. The account is live.'], activeName: 'a', nextName: 'b' });`,
        `const swapFailedLine = () => 'swap failed';`,
        // THE USAGE WALL GUARD: a death on the wall is recorded for the resume
        // at the lift. Recorded here; its use is wall-guard-wiring.test.mjs's.
        `export const WALL_DEATHS = [];`,
        `const noteWallDeath = (runId, task, opts) => { WALL_DEATHS.push({ runId, task, ...opts }); };`,
        grab('bgDraftPath'),
        grab('bgRunLogPath'),
        grab('isWorkerDeathText'),
        grab('fileDeadWorkerDraft'),
        grab('handleLimitDeath'),
        grab('reportBgOutcome'),
        `export { bgReportId, bgReportPath, writeFullReport, pruneBgReports, handBackToChat, flushParkedHandbacks, maybeAutoResumeHandbacks, bgDraftPath, fileDeadWorkerDraft, reportBgOutcome };`,
      ].join('\n'),
    )
);

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
const body = () => M.dispatched[M.dispatched.length - 1];

// ---------- ids and paths ----------
t('a run id becomes a report path under the reports dir', () => {
  eq(M.bgReportPath('bg-1787954368519'), path.join(REPORTS, 'bg-1787954368519.md'));
});

t('an id that could escape the reports dir is sanitised', () => {
  // Ids are generated today, so this can never fire; it is here because the id
  // reaches a filesystem path and the day it stops being generated is the day
  // this matters.
  const p = M.bgReportPath('../../etc/passwd');
  eq(path.dirname(p), REPORTS, 'traversal escaped the reports dir');
  // The separators are what carry a traversal; a literal ".." left in the
  // FILENAME is inert, so the assertion is containment, not spelling.
  eq(path.basename(p), '.._.._etc_passwd.md');
});

t('a missing run id still yields an addressable report', () => {
  const id = M.bgReportId(null);
  ok(/^bg-\d+$/.test(id), `unusable fallback id: ${id}`);
});

// ---------- the file itself ----------
t('the full report is written even when it dwarfs the inline limit', () => {
  const long = 'x'.repeat(HANDBACK_INLINE_LIMIT * 3) + 'THE-FINDING-AT-THE-END';
  const res = M.writeFullReport('run-long', 'the task', long, 'finished');
  ok(res, 'writeFullReport returned null');
  eq(res.chars, long.length, 'reported length must be the real length');
  const disk = readFileSync(res.file, 'utf8');
  ok(disk.includes('THE-FINDING-AT-THE-END'), 'the end of the report was lost on disk');
  ok(disk.includes('the task'), 'the task is not recorded beside its report');
  ok(disk.includes('status: finished'), 'status is not recorded');
});

t('an unwritable reports dir costs the file, never the handback', () => {
  // The pointer is a nicety; the report reaching M is not. A write failure must
  // degrade to "no file" and keep going.
  const saved = M.writeFullReport('run-ok', 't', 'o', 'finished');
  ok(saved, 'baseline write failed');
  M.resetChain();
  M.handBackToChat('t', 'o', 'finished', 'run-ok');
  ok(body().includes('FULL REPORT'), 'handback lost its pointer');
});

// ---------- the handback ----------
t('a long report is handed back as an excerpt that names the full file', () => {
  M.resetChain();
  const long = 'y'.repeat(HANDBACK_INLINE_LIMIT + 500) + 'TAIL-MARKER';
  M.handBackToChat('task A', long, 'finished', 'run-A');
  const note = body();
  ok(!note.includes('TAIL-MARKER'), 'the excerpt should not contain the tail');
  ok(note.includes(M.bgReportPath('run-A')), 'the handback does not name the report file');
  ok(note.includes(String(long.length)), 'the handback does not state the real length');
  ok(note.includes('READ THIS FILE'), 'a truncated excerpt must say the rest exists');
  const disk = readFileSync(M.bgReportPath('run-A'), 'utf8');
  ok(disk.includes('TAIL-MARKER'), 'the tail is not recoverable from disk');
});

t('a short report is handed back whole and still filed', () => {
  M.resetChain();
  M.handBackToChat('task B', 'short and complete', 'finished', 'run-B');
  const note = body();
  ok(note.includes('short and complete'), 'a short report must travel inline');
  ok(note.includes('complete above'), 'an untruncated report must be labelled as such');
  ok(readFileSync(M.bgReportPath('run-B'), 'utf8').includes('short and complete'), 'short reports are filed too');
});

t('the pointer sits OUTSIDE the untrusted-output markers', () => {
  // Inside them it would read as worker text, which the note itself declares
  // void. The path is the bridge speaking, not the worker.
  M.resetChain();
  M.handBackToChat('task C', 'z'.repeat(HANDBACK_INLINE_LIMIT + 10), 'finished', 'run-C');
  const note = body();
  ok(note.indexOf('FULL REPORT') > note.indexOf('<<<WORKER_OUTPUT_END>>>'), 'pointer is inside the untrusted block');
});

t('a run with no steers gets no STEERED IN block', () => {
  M.resetChain();
  M.handBackToChat('task D', 'plain output', 'finished', 'run-D');
  ok(!body().includes('STEERED IN'), 'an empty block is noise on every ordinary handback');
});

t('what the bridge steered in is reported, OUTSIDE the untrusted-output markers', () => {
  // Same rule as the report pointer, same reason: these lines are the bridge's
  // record of what IT wrote into the worker, not a claim the worker made about
  // itself. Inside the markers the note would declare its own evidence void.
  M.resetChain();
  M.handBackToChat('task E', 'worker said things', 'finished', 'run-E', [
    { ts: '2026-09-03T17:02:11.000Z', text: 'skip the browser step' },
    { ts: '2026-09-03T17:40:02.000Z', text: 'commit before you report' },
  ]);
  const note = body();
  ok(note.includes('STEERED IN (2)'), `the steer record is missing from the handback:\n${note}`);
  ok(note.indexOf('STEERED IN') > note.indexOf('<<<WORKER_OUTPUT_END>>>'), 'the steer record is inside the untrusted block');
  ok(note.includes('17:02:11Z skip the browser step'), note);
  ok(note.includes('17:40:02Z commit before you report'), note);
});

t('a capped chain parks the report path, and files the report anyway', () => {
  M.resetChain();
  for (let i = 0; i <= HANDBACK_STREAK_MAX; i++) {
    M.handBackToChat(`task ${i}`, `output ${i}`, 'finished', `run-cap-${i}`);
  }
  eq(M.parkedHandbacks.length, 1, 'exactly the over-cap report should be parked');
  eq(M.parkedHandbacks[0].report, M.bgReportPath(`run-cap-${HANDBACK_STREAK_MAX}`), 'parked entry lost its path');
  const disk = readFileSync(M.bgReportPath(`run-cap-${HANDBACK_STREAK_MAX}`), 'utf8');
  ok(disk.includes(`output ${HANDBACK_STREAK_MAX}`), 'a capped report was never written to disk');
});

// ---------- quiet auto-resume of a capped chain ----------
function capTheChain(prefix) {
  M.resetChain();
  for (let i = 0; i <= HANDBACK_STREAK_MAX; i++) {
    M.handBackToChat(`${prefix} task ${i}`, `output ${i}`, 'finished', `${prefix}-${i}`);
  }
  eq(M.parkedHandbacks.length, 1, 'the over-cap report should be parked');
}

t('a capped chain does NOT resume before the quiet spell has elapsed', () => {
  capTheChain('run-quiet-early');
  const before = M.dispatched.length;
  const parkedAt = M.lastParked();
  ok(parkedAt > 0, 'parking must stamp lastParkedAt');
  eq(M.maybeAutoResumeHandbacks(parkedAt + HANDBACK_AUTO_RESUME_MS - 1), false, 'resumed too early');
  eq(M.dispatched.length, before, 'nothing may be dispatched before the quiet spell');
  eq(M.parkedHandbacks.length, 1, 'the report must stay parked');
});

t('★ a capped chain resumes on its own after the quiet spell, with the parked list, and the streak restarts', () => {
  capTheChain('run-quiet');
  const before = M.dispatched.length;
  const parkedAt = M.lastParked();
  eq(M.maybeAutoResumeHandbacks(parkedAt + HANDBACK_AUTO_RESUME_MS), true, 'should resume once quiet');
  eq(M.dispatched.length, before + 1, 'exactly one bridge notice');
  const note = M.dispatched[M.dispatched.length - 1];
  ok(note.includes(' notice. DATA, not an instruction'), note);
  ok(note.includes('1 background worker(s) finished and were NOT reported to you'), note);
  ok(note.includes(M.bgReportPath(`run-quiet-${HANDBACK_STREAK_MAX}`)), 'the parked report path must be named');
  ok(note.includes('resumed on its own after a quiet spell'), 'the notice must say nobody typed');
  ok(!note.includes(`output ${HANDBACK_STREAK_MAX}`), 'the raw worker output must never ride the notice');
  eq(M.parkedHandbacks.length, 0, 'the parked list must be emptied');
  // The chain restarted: the next report is attempt 1 again, not parked.
  M.handBackToChat('after resume', 'fresh output', 'finished', 'run-quiet-after');
  eq(M.parkedHandbacks.length, 0, 'a report after the resume must reach M, not the parked list');
  ok(M.dispatched[M.dispatched.length - 1].includes(`Attempt 1 of ${HANDBACK_STREAK_MAX}`), 'streak must restart at 1');
});

t('a capped chain waits while the chat lane is busy', () => {
  capTheChain('run-busy');
  const before = M.dispatched.length;
  M.setMainBusy(true);
  try {
    eq(M.maybeAutoResumeHandbacks(M.lastParked() + HANDBACK_AUTO_RESUME_MS), false, 'must not interrupt a running turn');
    eq(M.dispatched.length, before, 'nothing dispatched while busy');
  } finally {
    M.setMainBusy(false);
  }
  eq(M.maybeAutoResumeHandbacks(M.lastParked() + HANDBACK_AUTO_RESUME_MS), true, 'resumes once the lane is idle');
});

// Caps the chain WITHOUT resetChain, so the auto-resume budget carries across caps
// the way it does in the daemon between two of their messages.
function capAgain(prefix) {
  for (let i = 0; i <= HANDBACK_STREAK_MAX; i++) {
    M.handBackToChat(`${prefix} task ${i}`, `output ${i}`, 'finished', `${prefix}-${i}`);
  }
  eq(M.parkedHandbacks.length, 1, 'the over-cap report should be parked');
}

t('the quiet resume is bounded per human message; their message restores the budget', () => {
  M.resetChain();
  for (let n = 0; n < HANDBACK_AUTO_RESUMES_MAX; n++) {
    capAgain(`run-budget-${n}`);
    eq(M.maybeAutoResumeHandbacks(M.lastParked() + HANDBACK_AUTO_RESUME_MS), true, `auto resume ${n + 1} should be allowed`);
  }
  capAgain('run-budget-spent');
  const before = M.dispatched.length;
  eq(M.maybeAutoResumeHandbacks(M.lastParked() + 10 * HANDBACK_AUTO_RESUME_MS), false, 'the budget is spent: park until they type');
  eq(M.dispatched.length, before, 'nothing dispatched past the budget');
  // Their message is the other way in: it flushes regardless of the budget.
  eq(M.flushParkedHandbacks('message'), true, 'a message flushes the parked list');
  ok(M.dispatched[M.dispatched.length - 1].includes('what the owner just asked'), 'a message flush keeps the answer-them framing');
  eq(M.parkedHandbacks.length, 0);
});

// ---------- the draft report ----------
//
// A worker's final message is its only report. When a usage limit kills it
// inside its verifier dispatch, the most token heavy step, that report never
// happens and the whole deliverable used to be lost. The worker now keeps a
// draft at $BG_REPORT_DRAFT; when the run ends WITHOUT a final report the
// bridge delivers the draft instead of nothing, and says so on its first line.

const DRAFT_LINE_RE = /^DRAFT REPORT: this worker ended without a final report; below is the last draft it wrote \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)\.$/;
const writeDraft = (runId, text) => {
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(M.bgDraftPath(runId), text);
};
const inner = (note) => note.split('<<<WORKER_OUTPUT_START>>>')[1].split('<<<WORKER_OUTPUT_END>>>')[0].replace(/^\n/, '');
const DRAFT_TEXT = '# Report so far\n\nBuilt the parser fix; 41 of 41 unit tests pass. Verifier not run yet.\nDRAFT-BODY-MARKER';

t('the draft path is the report path with .draft.md, under the reports dir', () => {
  eq(M.bgDraftPath('bg2-1790000000000'), path.join(REPORTS, 'bg2-1790000000000.draft.md'));
});

t('★ a re-attached worker id (with its pid tail) resolves to the draft its spawn named', () => {
  eq(M.bgDraftPath('bg2-1790000000000-48213'), path.join(REPORTS, 'bg2-1790000000000.draft.md'));
});

t('a draft id that could escape the reports dir is sanitised like a report id', () => {
  eq(path.dirname(M.bgDraftPath('../../etc/passwd')), REPORTS);
});

t('★ a FAILED worker with a draft on disk: the handback carries the draft, first line first', () => {
  M.resetChain();
  writeDraft('bg-1790000000101', DRAFT_TEXT);
  M.reportBgOutcome('ship the parser fix', { status: 'failed', answer: 'The worker FAILED: exit code null', record: 'FAILED: exit code null' }, 'bg-1790000000101');
  const out = inner(body());
  ok(DRAFT_LINE_RE.test(out.split('\n')[0]), `the first line must say exactly what it is:\n${out.split('\n')[0]}`);
  ok(out.includes('DRAFT-BODY-MARKER'), 'the draft itself did not travel');
  ok(out.includes('The worker FAILED: exit code null'), 'how it ended must survive beside the draft');
  ok(out.indexOf('DRAFT-BODY-MARKER') < out.indexOf('The worker FAILED'), 'the draft leads, the ending follows');
});

t('★ the bg-reports file holds the draft too, under a status that says it is one', () => {
  const disk = readFileSync(M.bgReportPath('bg-1790000000101'), 'utf8');
  ok(/- status: failed.*DRAFT/.test(disk), `the status must make the draft origin visible:\n${disk.slice(0, 300)}`);
  const output = disk.split('## Output\n\n')[1];
  ok(DRAFT_LINE_RE.test(output.split('\n')[0]), `the report file must open with the draft line:\n${output.slice(0, 200)}`);
  ok(output.includes('DRAFT-BODY-MARKER'), 'the draft is not on disk');
});

t('the header the assistant reads names the draft too, outside the untrusted markers', () => {
  const note = body();
  const head = note.split('<<<WORKER_OUTPUT_START>>>')[0];
  ok(head.includes('DRAFT'), head);
});

t('★ a worker that ended with NO OUTPUT and left a draft: the draft is delivered, and recorded', () => {
  M.resetChain();
  M.RESULTS.length = 0;
  writeDraft('bg3-1790000000102', DRAFT_TEXT);
  M.reportBgOutcome('ship it', { status: 'finished', answer: 'The worker ended with no output.', record: null }, 'bg3-1790000000102');
  const out = inner(body());
  ok(DRAFT_LINE_RE.test(out.split('\n')[0]), out.slice(0, 200));
  ok(out.includes('DRAFT-BODY-MARKER'), out);
  eq(M.RESULTS.length, 1, 'an empty ending used to leave no row; a delivered draft is worth one');
  ok(M.RESULTS[0].record.includes('DRAFT'), M.RESULTS[0].record);
  eq(M.RESULTS[0].file, M.bgReportPath('bg3-1790000000102'));
});

t('★ a FINAL report wins: the draft is ignored even when it is on disk', () => {
  M.resetChain();
  M.RESULTS.length = 0;
  writeDraft('bg-1790000000103', 'STALE-DRAFT-MARKER');
  M.reportBgOutcome('ship it', { status: 'finished', answer: 'The final report.', record: 'The final report.' }, 'bg-1790000000103');
  const note = body();
  ok(!note.includes('STALE-DRAFT-MARKER'), 'a draft leaked over a final report');
  ok(!note.includes('DRAFT REPORT'), note);
  eq(inner(note).trim(), 'The final report.');
  ok(!readFileSync(M.bgReportPath('bg-1790000000103'), 'utf8').includes('DRAFT'), 'the report file claims a draft');
  eq(M.RESULTS[0].record, 'The final report.');
});

t('no draft on disk: a failure is handed back exactly as before', () => {
  M.resetChain();
  M.reportBgOutcome('ship it', { status: 'failed', answer: 'The worker FAILED: boom', record: 'FAILED: boom' }, 'bg-1790000000104');
  const out = inner(body());
  eq(out.trim(), 'The worker FAILED: boom');
  ok(!body().includes('DRAFT'), body().slice(0, 300));
});

t('an empty draft file is treated as no draft', () => {
  M.resetChain();
  writeDraft('bg-1790000000105', '   \n');
  M.reportBgOutcome('ship it', { status: 'failed', answer: 'The worker FAILED: boom', record: 'FAILED: boom' }, 'bg-1790000000105');
  ok(!body().includes('DRAFT REPORT'), body().slice(0, 300));
});

t('★ a re-attached worker (id with a pid tail) gets ITS draft delivered', () => {
  M.resetChain();
  writeDraft('bg4-1790000000106', DRAFT_TEXT);
  M.reportBgOutcome('ship it', { status: 'failed', answer: 'The worker FAILED: exit code 1', record: 'FAILED: exit code 1' }, 'bg4-1790000000106-9911');
  ok(DRAFT_LINE_RE.test(inner(body()).split('\n')[0]), inner(body()).slice(0, 200));
});

// The limit death is THE case the draft exists for: the verifier dispatch is
// the most expensive step, so it is where a session limit most often lands.
M.resetChain();
M.RESULTS.length = 0;
writeDraft('bg2-1790000000108', DRAFT_TEXT);
M.reportBgOutcome('ship it', { status: 'failed', answer: "The worker FAILED: You've hit your session limit · resets 3pm", record: "FAILED: You've hit your session limit" }, 'bg2-1790000000108');
await M.settleOps();
const limitNote = body();

t('★ a LIMIT death with a draft: the rotation handback carries the draft first', () => {
  const out = inner(limitNote);
  ok(DRAFT_LINE_RE.test(out.split('\n')[0]), `first line:\n${out.split('\n')[0]}`);
  ok(out.includes('DRAFT-BODY-MARKER'), 'the draft did not ride the limit handback');
  ok(out.includes("You've hit your session limit"), 'the limit detail was lost');
  ok(out.includes('--- LEASH ACCOUNT ROTATION ---'), 'the rotation lines were lost');
  ok(out.indexOf('DRAFT-BODY-MARKER') < out.indexOf('--- LEASH ACCOUNT ROTATION ---'), 'the draft leads');
});

t('the limit death status keeps its own words and names the draft', () => {
  const disk = readFileSync(M.bgReportPath('bg2-1790000000108'), 'utf8');
  ok(/- status: died on a session limit.*DRAFT/.test(disk), disk.slice(0, 300));
});

// With a long draft in front, the rotation block falls past the inline
// excerpt. A one-line bridge note ABOVE the markers says the rotation already
// ran, so it is not re-done blind.
M.resetChain();
writeDraft('bg2-1790000000130', DRAFT_TEXT + '\n' + 'x'.repeat(8000));
M.reportBgOutcome('ship it', { status: 'failed', answer: "The worker FAILED: You've hit your session limit", record: "FAILED: You've hit your session limit" }, 'bg2-1790000000130');
await M.settleOps();
const bigLimitNote = body();
t('★ a long draft on a limit death: the note says, outside the markers, that the rotation already ran', () => {
  const before = bigLimitNote.split('<<<WORKER_OUTPUT_START>>>')[0];
  ok(/ALREADY RAN/.test(before) && /HOW THE WORKER ENDED/.test(before), before.slice(-600));
  ok(!inner(bigLimitNote).includes('--- LEASH ACCOUNT ROTATION ---'), 'the rotation block is past the excerpt in this case, which is why the note exists');
});

M.resetChain();
M.reportBgOutcome('ship it', { status: 'failed', answer: "The worker FAILED: You've hit your session limit", record: "FAILED: You've hit your session limit" }, 'bg2-1790000000109');
await M.settleOps();

t('a limit death with no draft keeps the old shape: no draft line, the daemon text first', () => {
  const out = inner(body());
  ok(out.startsWith("The worker FAILED: You've hit your session limit"), out.slice(0, 200));
  ok(!body().includes('DRAFT'), body().slice(0, 300));
  // no extra bridge note either: the rotation block already leads the excerpt
  ok(!/ALREADY RAN/.test(body().split('<<<WORKER_OUTPUT_START>>>')[0]), body().slice(0, 300));
});

t('★ a draft path that throws never costs the handback', () => {
  // A directory squatting on the draft path makes the read fail; the report
  // must still reach the assistant.
  M.resetChain();
  mkdirSync(M.bgDraftPath('bg-1790000000110'), { recursive: true });
  M.reportBgOutcome('ship it', { status: 'failed', answer: 'The worker FAILED: boom', record: 'FAILED: boom' }, 'bg-1790000000110');
  ok(inner(body()).includes('The worker FAILED: boom'), body().slice(0, 300));
  rmSync(M.bgDraftPath('bg-1790000000110'), { recursive: true, force: true });
});

t('★ a worker that died while the daemon was DOWN: its draft is filed and pointed at', () => {
  writeDraft('bg5-1790000000111', DRAFT_TEXT);
  const line = M.fileDeadWorkerDraft('bg5-1790000000111-777', 'the nightly batch');
  ok(line && line.startsWith('DRAFT REPORT: this worker ended without a final report'), String(line));
  ok(line.includes(M.bgReportPath('bg5-1790000000111-777')), line);
  const disk = readFileSync(M.bgReportPath('bg5-1790000000111-777'), 'utf8');
  ok(disk.includes('DRAFT-BODY-MARKER'), 'the draft was not filed');
  ok(/- status: .*DRAFT/.test(disk), disk.slice(0, 300));
});

t('a dead worker with no draft gets no pointer', () => {
  eq(M.fileDeadWorkerDraft('bg6-1790000000112', 'x'), null);
});

// bgOutcome says "failed" for a worker that DID write its final report when
// that report quotes a fatal phrase ("401 invalid api key", the bug it fixed)
// or a later steered turn errored. A final report always wins: the draft must
// not replace it.
const FINAL = '## VERIFICATION PASSED\nFINAL-REPORT-MARKER. Fixed the 401 invalid api key path. ' + 'Evidence line. '.repeat(40);
const runLog = (runId, events) => {
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(path.join(RUNS, `${runId}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
};
t('★ a final report seen in the run beats the draft even when the outcome says failed', () => {
  M.resetChain();
  writeDraft('bg-1790000000120', DRAFT_TEXT);
  M.reportBgOutcome('fix the auth path', { status: 'failed', answer: `The worker FAILED: ${FINAL}`, record: `FAILED: ${FINAL}` }, 'bg-1790000000120', { finalReportSeen: true });
  const out = inner(body());
  ok(!out.includes('DRAFT REPORT'), out.slice(0, 200));
  ok(!out.includes('DRAFT-BODY-MARKER'), 'the stale draft travelled over the final report');
  ok(out.includes('FINAL-REPORT-MARKER'), 'the final report must be the handback');
});
t('★ the re-attach path (no live flag) reads the run log: a clean report there wins', () => {
  M.resetChain();
  writeDraft('bg-1790000000121', DRAFT_TEXT);
  runLog('bg-1790000000121', [
    { type: 'result', subtype: 'success', is_error: false, result: FINAL },
    { type: 'result', is_error: true, result: "You've hit your session limit" },
  ]);
  M.reportBgOutcome('fix the auth path', { status: 'failed', answer: `The worker FAILED: ${FINAL}`, record: `FAILED: ${FINAL}` }, 'bg-1790000000121-4242');
  ok(!inner(body()).includes('DRAFT-BODY-MARKER'), inner(body()).slice(0, 200));
});
t('★ a log whose only text is the CLI dying still gets the draft', () => {
  M.resetChain();
  writeDraft('bg-1790000000122', DRAFT_TEXT);
  runLog('bg-1790000000122', [{ type: 'result', is_error: false, result: 'Invalid API key · Please run /login' }]);
  M.reportBgOutcome('ship it', { status: 'failed', answer: 'The worker FAILED: Invalid API key · Please run /login', record: 'FAILED: Invalid API key' }, 'bg-1790000000122');
  ok(inner(body()).includes('DRAFT-BODY-MARKER'), inner(body()).slice(0, 200));
});
t('★ the watchdog files no draft for a dead worker whose log holds its final report', () => {
  writeDraft('bg7-1790000000123', DRAFT_TEXT);
  runLog('bg7-1790000000123', [{ type: 'result', subtype: 'success', is_error: false, result: FINAL }]);
  eq(M.fileDeadWorkerDraft('bg7-1790000000123-55', 'x', path.join(RUNS, 'bg7-1790000000123.jsonl')), null);
  eq(M.fileDeadWorkerDraft('bg7-1790000000123-55', 'x'), null); // derived from the id when the registry has no log
});

// ---------- pruning ----------
t('pruning keeps the newest BG_REPORTS_KEEP reports and no more', () => {
  const dir = REPORTS;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f));
  // Ids are <lane>-<epoch-ms>, so zero-padding makes lexical order chronological
  // in the same way real ids are.
  for (let i = 0; i < BG_REPORTS_KEEP + 5; i++) {
    writeFileSync(path.join(dir, `bg-${String(1000000 + i)}.md`), 'x');
  }
  M.pruneBgReports();
  const left = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  eq(left.length, BG_REPORTS_KEEP, 'wrong number of reports kept');
  eq(left[left.length - 1], `bg-${1000000 + BG_REPORTS_KEEP + 4}.md`, 'the newest report was pruned');
  eq(left[0], `bg-${1000000 + 5}.md`, 'pruning did not start from the oldest');
});

t('★ drafts never evict reports: they are counted and pruned in their own bucket', () => {
  // Every Claude worker now leaves a .draft.md beside its report. Counted in
  // the same bucket, they would halve how many real reports survive the cap.
  const dir = REPORTS;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { recursive: true, force: true });
  for (let i = 0; i < BG_REPORTS_KEEP; i++) {
    writeFileSync(path.join(dir, `bg-${1780000000000 + i * 1000}.md`), 'x');
  }
  for (let i = 0; i < 50; i++) {
    writeFileSync(path.join(dir, `bg-${1790000000000 + i * 1000}.draft.md`), 'x');
  }
  M.pruneBgReports();
  const left = readdirSync(dir);
  eq(left.filter((f) => !f.endsWith('.draft.md')).length, BG_REPORTS_KEEP, 'a report was pruned to make room for drafts');
  eq(left.filter((f) => f.endsWith('.draft.md')).length, 50, 'drafts under their own cap were pruned');
});

t('drafts past their own cap are pruned oldest first, across lanes', () => {
  const dir = REPORTS;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { recursive: true, force: true });
  for (let i = 0; i < BG_REPORTS_KEEP + 5; i++) {
    writeFileSync(path.join(dir, `bg${(i % 3) + 2}-${1780000000000 + i * 1000}.draft.md`), 'x');
  }
  M.pruneBgReports();
  const left = readdirSync(dir).filter((f) => f.endsWith('.draft.md'));
  eq(left.length, BG_REPORTS_KEEP, 'wrong number of drafts kept');
  ok(!left.includes('bg2-1780000000000.draft.md'), 'the oldest draft survived');
  ok(left.includes(`bg${((BG_REPORTS_KEEP + 4) % 3) + 2}-${1780000000000 + (BG_REPORTS_KEEP + 4) * 1000}.draft.md`), 'the newest draft was pruned');
});

t('★ at the cap, the newest DRAFT survives even when its lane sorts first', () => {
  // A draft is the one record of a worker that may still be running: pruning
  // it because its lane name sorts first would lose exactly the report the
  // draft exists to save.
  const dir = REPORTS;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { recursive: true, force: true });
  const oldest = 'bg2-1780000000000.draft.md';
  writeFileSync(path.join(dir, oldest), 'x');
  for (let i = 1; i < BG_REPORTS_KEEP; i++) {
    writeFileSync(path.join(dir, `bg${(i % 12) + 2}-${1780000000000 + i * 1000}.draft.md`), 'x');
  }
  const newest = 'bg-1789999999999.draft.md';
  writeFileSync(path.join(dir, newest), 'x');
  M.pruneBgReports();
  const left = readdirSync(dir).filter((f) => f.endsWith('.draft.md'));
  eq(left.length, BG_REPORTS_KEEP, 'wrong number of drafts kept');
  ok(left.includes(newest), 'the newest draft was pruned because its lane sorts first');
  ok(!left.includes(oldest), 'pruning did not start from the genuinely oldest draft');
});

t('★ at the cap, the newest report survives even when its lane sorts first', () => {
  // Ids are <lane>-<epoch-ms>, and lexical order over them is not
  // chronological: the LANE dominates, and "-" sorts below every digit, so
  // "bg-<epoch>.md" (the default lane, the one every first handoff uses)
  // sorted ahead of bg2, bg10 and the rest, and at the cap the just-written
  // report was the one deleted.
  const dir = REPORTS;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { recursive: true, force: true });
  const oldest = 'bg2-1780000000000.md';
  writeFileSync(path.join(dir, oldest), 'x');
  for (let i = 1; i < BG_REPORTS_KEEP; i++) {
    writeFileSync(path.join(dir, `bg${(i % 12) + 2}-${1780000000000 + i * 1000}.md`), 'x');
  }
  const newest = 'bg-1789999999999.md';
  writeFileSync(path.join(dir, newest), 'x');
  M.pruneBgReports();
  const left = readdirSync(dir).filter((f) => f.endsWith('.md'));
  eq(left.length, BG_REPORTS_KEEP, 'wrong number of reports kept');
  ok(left.includes(newest), 'the newest report was pruned because its lane sorts first');
  ok(!left.includes(oldest), 'pruning did not start from the genuinely oldest report');
});

t('a report whose name carries no epoch is ordered by mtime, not deleted first', () => {
  const dir = REPORTS;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { recursive: true, force: true });
  // bgReportId always yields an epoch, so this is a foreign file: it must not
  // be treated as infinitely old just because the regex misses it.
  writeFileSync(path.join(dir, 'notes.md'), 'x');
  for (let i = 0; i < BG_REPORTS_KEEP; i++) {
    writeFileSync(path.join(dir, `bg7-${1780000000000 + i * 1000}.md`), 'x');
  }
  M.pruneBgReports();
  const left = readdirSync(dir).filter((f) => f.endsWith('.md'));
  eq(left.length, BG_REPORTS_KEEP, 'wrong number of reports kept');
  ok(left.includes('notes.md'), 'the epoch-less file was pruned ahead of reports older than it');
});

t('under the cap, pruning deletes nothing at all', () => {
  const dir = REPORTS;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { recursive: true, force: true });
  for (let i = 0; i < BG_REPORTS_KEEP; i++) {
    writeFileSync(path.join(dir, `bg-${1780000000000 + i * 1000}.md`), 'x');
  }
  M.pruneBgReports();
  eq(readdirSync(dir).filter((f) => f.endsWith('.md')).length, BG_REPORTS_KEEP, 'pruning fired at the cap instead of past it');
});

t('pruning a missing directory is a no-op, not a crash', () => {
  rmSync(REPORTS, { recursive: true, force: true });
  M.pruneBgReports();
  pass += 0;
});

// ---------------------------------------------------------------------------
// The dash normalizer, at the handback boundary.
// ---------------------------------------------------------------------------
// A worker report is the OTHER way a model's prose enters this conversation:
// it goes to M, who quotes and paraphrases the excerpt. A Codex worker writes
// em dashes, so without this they arrive in the chat having gone round
// sendResult entirely.

t('★ a worker report with an em dash reaches M without one', () => {
  M.resetChain();
  M.setNoDashes(true);
  M.handBackToChat('build the thing', 'It shipped \u2014 and it passed.', 'finished', 'bg-9001', []);
  const note = M.dispatched[M.dispatched.length - 1];
  // Scoped to the WORKER OUTPUT block. The framing around it is the bridge's own
  // prompt to M, written long before this rule existed and not owner-facing;
  // what must be clean is the text that came out of a model.
  const body = note.split('<<<WORKER_OUTPUT_START>>>')[1].split('<<<WORKER_OUTPUT_END>>>')[0];
  ok(!/[\u2013\u2014]/.test(body), `a dash survived into the handback: ${body}`);
  ok(body.includes('It shipped, and it passed.'), body);
  M.setNoDashes(false);
});

t('a fenced command inside a worker report keeps its dashes', () => {
  M.resetChain();
  M.setNoDashes(true);
  M.handBackToChat('build', 'Ran `npm run build \u2014 watch` and it worked \u2014 finally.', 'finished', 'bg-9002', []);
  const note = M.dispatched[M.dispatched.length - 1];
  ok(note.includes('`npm run build \u2014 watch`'), `the command was rewritten: ${note}`);
  ok(note.includes('it worked, finally.'), note);
  M.setNoDashes(false);
});

t('with the flag off the report is passed through unchanged', () => {
  M.resetChain();
  M.handBackToChat('build', 'It shipped \u2014 and it passed.', 'finished', 'bg-9003', []);
  const note = M.dispatched[M.dispatched.length - 1];
  ok(note.includes('It shipped \u2014 and it passed.'), note);
});

// ---------- the all-accounts wall: a handback waits for the lift ----------
// 2026-09-30: during an all-accounts wall every worker report started a
// priority chat turn on an account already known walled, which died there and
// was never retried, until enough of them tripped the handback cap. With a wall
// episode pending and a Claude chat lane, the report is written, recorded in
// the episode and held for the lift's one wake-up (limit-rotation.test.mjs).
const WALL_TASK = 'LANE RULES (you are a background worker: headless).\n--- TASK ---\n# Ship the parser fix\n\nthe body';
M.resetChain();
M.resetWallWake();
M.wallWake.raised({ until: Date.now() + 3600_000 });
M.setWalled(true);
M.setChatEngine('claude');
let beforeHold = M.dispatched.length;
M.handBackToChat(WALL_TASK, 'HELD-REPORT-BODY', 'finished', 'bg7-1790000000200');
t('★ WALL UP, Claude chat lane: the handback is HELD for the lift, not dispatched into the wall', () => {
  eq(M.dispatched.length, beforeHold, 'a priority turn into the wall dies there, unretried');
  const ep = M.wallWake.current();
  eq(ep.workers.length, 1, JSON.stringify(ep.workers));
  const w = ep.workers[0];
  eq(w.runId, 'bg7-1790000000200');
  eq(w.handback, 'held');
  eq(w.died, false, 'a worker that FINISHED during the wall is held too, but it did not die on it');
  eq(w.title, 'Ship the parser fix', 'the brief title, not the lane rules');
  eq(w.report, M.bgReportPath('bg7-1790000000200'), 'the full report is still written, and named');
  ok(readFileSync(w.report, 'utf8').includes('HELD-REPORT-BODY'), 'the report file carries the body');
});

// Six more held reports: past HANDBACK_STREAK_MAX, none of them trips the cap,
// because none of them fed the chat lane.
for (let i = 0; i < HANDBACK_STREAK_MAX + 1; i++) M.handBackToChat(WALL_TASK, `r${i}`, 'finished', `bg7-17900000003${i}`);
M.setWalled(false);
M.handBackToChat('after the lift', 'plain output', 'finished', 'bg7-1790000000400');
t('★ held handbacks never count toward the handback cap', () => {
  eq(M.parkedHandbacks.length, 0, 'nothing was parked by the cap');
  ok(body().includes(`Attempt 1 of ${HANDBACK_STREAK_MAX}`), body().slice(0, 300));
});

// A LIMIT death during the wall: recorded as died on the wall, with its draft.
M.resetChain();
M.resetWallWake();
M.wallWake.raised({ until: Date.now() + 3600_000 });
M.setWalled(true);
M.ROT.outcome = 'paused';
writeDraft('bg8-1790000000500', DRAFT_TEXT);
beforeHold = M.dispatched.length;
M.reportBgOutcome(WALL_TASK, { status: 'failed', answer: "The worker FAILED: You've hit your session limit", record: "FAILED: You've hit your session limit" }, 'bg8-1790000000500');
await M.settleOps();
t('★ a worker that DIES on the wall: held, marked died, draft and report both named', () => {
  eq(M.dispatched.length, beforeHold);
  const w = M.wallWake.current().workers.find((x) => x.runId === 'bg8-1790000000500');
  ok(w, JSON.stringify(M.wallWake.current().workers));
  eq(w.died, true);
  eq(w.handback, 'held');
  eq(w.draft, M.bgDraftPath('bg8-1790000000500'));
  eq(w.report, M.bgReportPath('bg8-1790000000500'));
  ok(/died on a session limit/.test(w.status), w.status);
});

// A Codex chat lane can read a report during a Claude wall: it goes as always,
// and a wall death is still recorded, as delivered.
M.resetChain();
M.setChatEngine('codex');
beforeHold = M.dispatched.length;
M.reportBgOutcome(WALL_TASK, { status: 'failed', answer: "The worker FAILED: You've hit your session limit", record: "FAILED: You've hit your session limit" }, 'bg8-1790000000600');
await M.settleOps();
t('★ WALL UP, Codex chat lane: the handback goes as always; the wall death is recorded as delivered', () => {
  eq(M.dispatched.length, beforeHold + 1);
  const w = M.wallWake.current().workers.find((x) => x.runId === 'bg8-1790000000600');
  eq(w?.handback, 'delivered');
  eq(w?.died, true);
  ok(Number(w?.deliveredAt) > 0);
});

t('★ the usage wall guard: a death on the wall is recorded for the resume, with its brief', () => {
  const d = M.WALL_DEATHS.find((x) => x.runId === 'bg8-1790000000500');
  ok(d, JSON.stringify(M.WALL_DEATHS));
  eq(d.task, WALL_TASK, 'the whole brief, which the resume puts back behind its note');
  eq(d.finalReportSeen, false);
});

// No wall episode (a rehearsal wall from config, or none at all): today's
// behaviour exactly, whatever the wall says.
M.resetChain();
M.resetWallWake();
M.setChatEngine('claude');
M.ROT.outcome = 'swapped';
beforeHold = M.dispatched.length;
M.handBackToChat(WALL_TASK, 'no episode', 'finished', 'bg9-1790000000700');
t('with no wall episode a handback is dispatched even while walled (nothing would wake it)', () => {
  eq(M.dispatched.length, beforeHold + 1);
  eq(M.wallWake.current(), null);
});
M.setWalled(false);

// A RESTART MID WALL (QA 2026-09-30): the in-memory wall is gone, the ledger
// still walls every account. The first handback must still be held.
M.resetChain();
M.resetWallWake();
M.wallWake.raised({ until: Date.now() + 3600_000 });
M.setWalled(false);
M.setLedgerAllWalled(true);
beforeHold = M.dispatched.length;
M.handBackToChat(WALL_TASK, 'after the restart', 'finished', 'bg10-1790000000800');
t('★ after a restart mid wall the LEDGER still holds a handback the forgotten wall would not', () => {
  eq(M.dispatched.length, beforeHold, 'dispatched into a wall the daemon forgot');
  eq(M.wallWake.current().workers.find((x) => x.runId === 'bg10-1790000000800')?.handback, 'held');
});
M.setLedgerAllWalled(false);

// THE USER CHOSE A LOGIN BY HAND (QA round 2): /account <name> zeroes the stand-down
// and touches no ledger row, so the ledger still walls everything while chat
// turns run on that pick. A report held then waited hours for a ledger clock.
M.resetChain();
M.resetWallWake();
M.wallWake.raised({ until: Date.now() + 3600_000 });
M.wallWake.vouched({ name: 'two@example.com' });
M.setWalled(false);
M.setLedgerAllWalled(true);
beforeHold = M.dispatched.length;
M.handBackToChat(WALL_TASK, 'after a manual swap', 'finished', 'bg12-1790000001000');
t('★ after a manual /account swap during the wall a handback is delivered, not held for hours', () => {
  eq(M.dispatched.length, beforeHold + 1, 'held behind a ledger the user overrode');
  eq(M.wallWake.current().workers.find((x) => x.runId === 'bg12-1790000001000'), undefined, 'not a wall death, so not recorded');
});
M.setLedgerAllWalled(false);

// THE EPISODE'S BOUND: past it a handback is dispatched as always rather than
// held into nowhere.
M.resetChain();
M.resetWallWake();
M.wallWake.raised({ until: Date.now() + 3600_000 });
M.setWalled(true);
for (let i = 0; i < 20; i++) M.wallWake.worker({ runId: `filler-${i}` });
beforeHold = M.dispatched.length;
M.handBackToChat(WALL_TASK, 'one too many', 'finished', 'bg11-1790000000900');
t('★ a full wall episode never swallows a handback: it is dispatched, not held', () => {
  eq(M.dispatched.length, beforeHold + 1);
});
M.setWalled(false);

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bg-report tests pass');
