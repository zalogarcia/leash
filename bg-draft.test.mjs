#!/usr/bin/env node
// Tests for bg-draft.mjs: the draft report a background worker keeps while it
// runs, and what the bridge delivers when the worker ends without a final one.
//
// The property: a worker that dies inside its verifier dispatch (the most token
// heavy step, and so the one a usage limit most often lands in) still hands its
// work back. The reading side never throws, because losing the draft must never
// also lose the handback it rides on.
//
//   node bg-draft.test.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DRAFT_ENDING_RULE,
  DRAFT_MAX_BYTES,
  DRAFT_STATUS_MARK,
  DRAFT_SUFFIX,
  draftHandbackOutput,
  draftHeadline,
  draftPointerLine,
  draftRunId,
  draftStatus,
  draftTextOf,
  endedWithoutFinalReport,
  isFinalReportEvent,
  logHadFinalReport,
  readDraftReport,
} from './bg-draft.mjs';

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

const TMP = mkdtempSync(path.join(tmpdir(), 'bg-draft-test-'));

// ---------------------------------------------------------------------------
console.log('\n1. which run a draft belongs to');

t('the suffix is the one the env contract names', () => {
  eq(DRAFT_SUFFIX, '.draft.md');
});

t('a live run id is its own draft id', () => {
  eq(draftRunId('bg2-1790000000000'), 'bg2-1790000000000');
  eq(draftRunId('bg-1790000000000'), 'bg-1790000000000');
});

t('★ a RE-ATTACHED worker id drops its pid tail, so it finds the draft its spawn named', () => {
  // The re-attach path reports under the registry key <lane>-<startedAt>-<pid>,
  // while the env the worker was spawned with named <lane>-<startedAt>.
  eq(draftRunId('bg2-1790000000000-48213'), 'bg2-1790000000000');
});

t('an id of no known shape passes through for the caller to sanitise', () => {
  eq(draftRunId('../../etc/passwd'), '../../etc/passwd');
  eq(draftRunId(null), null);
});

// ---------------------------------------------------------------------------
console.log('\n2. did the worker end without a final report?');

t('a clean finish with an answer HAS a final report: the draft is ignored', () => {
  eq(endedWithoutFinalReport({ status: 'finished', answer: 'the report', record: 'the report' }), false);
});

t('★ a failure has none: limit death, crash, kill', () => {
  eq(endedWithoutFinalReport({ status: 'failed', answer: "The worker FAILED: You've hit your session limit", record: 'FAILED: x' }), true);
  eq(endedWithoutFinalReport({ status: 'failed', answer: 'The worker FAILED: exit code null', record: 'FAILED: exit code null' }), true);
});

t('★ an empty ending has none: "ended with no output" carries no record', () => {
  eq(endedWithoutFinalReport({ status: 'finished', answer: 'The worker ended with no output.', record: null }), true);
});

t('no outcome at all is treated as no report', () => {
  eq(endedWithoutFinalReport(null), true);
});

// QA 2026-09-27 round 1: bgOutcome says "failed" for a worker that DID write
// its final report when the report quotes a fatal phrase ("401 invalid api
// key", the bug it fixed) or when a later steered turn errors. A final report
// always wins, so a clean text result seen anywhere in the run beats the draft.
t('★ a final report seen in the run wins over a failed status', () => {
  eq(endedWithoutFinalReport({ status: 'failed', answer: 'The worker FAILED: ...', record: 'FAILED: ...' }, { finalReportSeen: true }), false);
  eq(endedWithoutFinalReport({ status: 'failed', answer: 'x', record: 'x' }, { finalReportSeen: false }), true);
});

const death = (t) => /invalid api key|failed to authenticate|session limit/i.test(t);
const REPORT = '## VERIFICATION PASSED\n' + 'The 401 invalid api key bug is fixed. '.repeat(20);
t('★ a clean result event with report text is a final report, even quoting a fatal phrase', () => {
  eq(isFinalReportEvent({ type: 'result', subtype: 'success', is_error: false, result: REPORT }, death), true);
  eq(isFinalReportEvent({ type: 'result', result: 'the report' }, death), true);
});
t('★ a SHORT report that quotes a fatal phrase mid-text is still a report (QA round 2)', () => {
  const short = "Fixed the auth probe: every probe got 'invalid api key' before, all 12 pass now. Verifier (qa-agent) PASS.";
  eq(short.length < 400, true);
  eq(isFinalReportEvent({ type: 'result', is_error: false, result: short }, death), true);
});
t('★ the CLI reporting its own death is not a final report', () => {
  eq(isFinalReportEvent({ type: 'result', is_error: false, result: 'Invalid API key · Please run /login' }, death), false);
  eq(isFinalReportEvent({ type: 'result', is_error: true, result: REPORT }, death), false);
  eq(isFinalReportEvent({ type: 'result', subtype: 'error_during_execution', result: REPORT }, death), false);
  eq(isFinalReportEvent({ type: 'result', result: '   ' }, death), false);
  eq(isFinalReportEvent({ type: 'assistant', result: REPORT }, death), false);
  eq(isFinalReportEvent(null, death), false);
});
t('★ a run log is scanned for a final report, and a bad file is simply "no"', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bgdraft-log-'));
  const good = path.join(dir, 'bg-1.jsonl');
  writeFileSync(good, [
    JSON.stringify({ type: 'assistant', message: {} }),
    'not json, stderr',
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: REPORT }),
    JSON.stringify({ type: 'result', is_error: true, result: "You've hit your session limit" }),
  ].join('\n'));
  const bad = path.join(dir, 'bg-2.jsonl');
  writeFileSync(bad, [
    JSON.stringify({ type: 'result', is_error: true, result: "You've hit your session limit" }),
  ].join('\n'));
  eq(logHadFinalReport(good, { isDeathText: death }), true);
  eq(logHadFinalReport(bad, { isDeathText: death }), false);
  eq(logHadFinalReport(path.join(dir, 'missing.jsonl'), { isDeathText: death }), false);
  eq(logHadFinalReport(null), false);
  eq(logHadFinalReport(good, { readFile: () => { throw new Error('EIO'); } }), false);
  // chunked read: a report split across chunk boundaries is still found
  eq(logHadFinalReport(good, { isDeathText: death, chunkBytes: 7 }), true);
  eq(logHadFinalReport(bad, { isDeathText: death, chunkBytes: 7 }), false);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
console.log('\n3. reading the draft: never throws');

const draftAt = (name, text, mtime = null) => {
  const p = path.join(TMP, name);
  writeFileSync(p, text);
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
};

t('a draft on disk comes back with its text and its mtime as ISO', () => {
  const when = new Date('2026-09-27T14:03:22.000Z');
  const p = draftAt('bg-1.draft.md', '# Report so far\n\nBuilt the thing.\n', when);
  const d = readDraftReport(p);
  ok(d, 'the draft was not read');
  eq(d.text, '# Report so far\n\nBuilt the thing.\n');
  eq(d.mtime, '2026-09-27T14:03:22.000Z');
  eq(d.file, p);
});

t('a missing file is null, not a throw', () => {
  eq(readDraftReport(path.join(TMP, 'nope.draft.md')), null);
  eq(readDraftReport(null), null);
  eq(readDraftReport(''), null);
});

t('an empty or whitespace-only draft is null: there is nothing to deliver', () => {
  eq(readDraftReport(draftAt('empty.draft.md', '')), null);
  eq(readDraftReport(draftAt('blank.draft.md', '  \n\t\n')), null);
});

t('a directory where the draft should be is null', () => {
  const d = path.join(TMP, 'dir.draft.md');
  mkdirSync(d, { recursive: true });
  eq(readDraftReport(d), null);
});

t('★ a reader that throws is contained', () => {
  const boom = () => {
    throw new Error('EIO');
  };
  eq(readDraftReport('/x.draft.md', { stat: boom }), null);
  eq(readDraftReport('/x.draft.md', { stat: () => ({ isFile: () => true, size: 10, mtimeMs: 0 }), readFile: boom }), null);
});

t('a draft too large to inline is delivered as a pointer, not read into memory', () => {
  let read = false;
  const d = readDraftReport('/big.draft.md', {
    stat: () => ({ isFile: () => true, size: DRAFT_MAX_BYTES + 1, mtimeMs: Date.parse('2026-09-27T00:00:00Z') }),
    readFile: () => {
      read = true;
      return 'x';
    },
  });
  ok(d, 'a large draft must still be delivered');
  ok(!read, 'the whole file was read');
  ok(d.text.includes('/big.draft.md'), d.text);
  ok(d.text.includes(String(DRAFT_MAX_BYTES + 1)), d.text);
});

// ---------------------------------------------------------------------------
console.log('\n4. what the handback carries');

const DRAFT = { file: '/r/bg-1.draft.md', text: '# Report so far\n\nBuilt it. Verifier not run yet.\n', mtime: '2026-09-27T14:03:22.000Z' };

t('★ the first line says exactly what it is, with the draft mtime', () => {
  const out = draftHandbackOutput(DRAFT, "The worker FAILED: You've hit your session limit");
  eq(
    out.split('\n')[0],
    'DRAFT REPORT: this worker ended without a final report; below is the last draft it wrote (2026-09-27T14:03:22.000Z).',
  );
  eq(out.split('\n')[0], draftHeadline(DRAFT.mtime));
});

t('★ the draft follows whole, and how the worker ended follows it, under its own rule', () => {
  const ending = "The worker FAILED: You've hit your session limit";
  const out = draftHandbackOutput(DRAFT, ending);
  ok(out.includes('Built it. Verifier not run yet.'), out);
  ok(out.indexOf('Built it.') < out.indexOf(DRAFT_ENDING_RULE), 'the draft comes before the ending');
  ok(out.indexOf(DRAFT_ENDING_RULE) < out.indexOf(ending), 'the ending is labelled as the bridge record');
});

t('an empty ending leaves no dangling rule', () => {
  ok(!draftHandbackOutput(DRAFT, '').includes(DRAFT_ENDING_RULE));
  ok(!draftHandbackOutput(DRAFT, null).includes(DRAFT_ENDING_RULE));
});

t('the status keeps the original and makes the draft origin visible', () => {
  const s = draftStatus('failed');
  ok(s.startsWith('failed'), s);
  ok(s.includes('DRAFT'), s);
  ok(s.includes('no final report'), s);
});

t('the status mark is what draftStatus appends, so a file reader can find it', () => {
  ok(draftStatus('died on a session limit').endsWith(DRAFT_STATUS_MARK));
});

t('★ draftTextOf recovers exactly the draft from a delivered report, for the calibration', () => {
  const out = draftHandbackOutput(DRAFT, 'The worker FAILED: boom');
  eq(draftTextOf(out), DRAFT.text.replace(/\s+$/, ''));
  eq(draftTextOf(draftHandbackOutput(DRAFT, '')), DRAFT.text.replace(/\s+$/, ''), 'with no ending block too');
  eq(draftTextOf('just one line'), '');
});

t('the dead-worker pointer names the file and the draft time', () => {
  const line = draftPointerLine(DRAFT, '/r/bg-1.md');
  ok(line.startsWith('DRAFT REPORT: this worker ended without a final report'), line);
  ok(line.includes('/r/bg-1.md'), line);
  ok(line.includes(DRAFT.mtime), line);
});

t('no em or en dash in anything this module writes', () => {
  const all = [
    draftHandbackOutput(DRAFT, 'ending'),
    draftStatus('finished'),
    draftPointerLine(DRAFT, '/r/x.md'),
    readDraftReport('/big.draft.md', {
      stat: () => ({ isFile: () => true, size: DRAFT_MAX_BYTES + 1, mtimeMs: 0 }),
    })?.text || '',
  ].join('\n');
  ok(!/[\u2013\u2014]/.test(all), all);
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
