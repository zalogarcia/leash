// THE DRAFT REPORT: what a background worker has written so far, delivered when
// the run ends without a final one.
//
// A worker's final message is its only report. When a usage limit kills it
// during its verifier dispatch (qa-agent, live-test, outcomes-grader: the most
// token heavy step, so the one a limit most often lands in), that message is
// never written and the whole deliverable used to be lost, even though every
// piece of work in it had already been done.
//
// So every Claude background worker is spawned with BG_REPORT_DRAFT naming
// <bg-reports>/<runId>.draft.md (worker-env.mjs), LANE RULE 6 in bg.mjs tells
// it to write its report as it stands there before any verifier dispatch, and a
// hook in ~/.claude blocks the dispatch until the file exists. When the run then
// ends WITHOUT a final report, bridge.mjs reads the draft through this module
// and delivers it in the handback, first line saying exactly what it is. A final
// report always wins: the draft is only ever read for a run that has none.
//
// Pure apart from the one read, and that read is injectable and NEVER throws:
// losing the draft must never also lose the handback it rides on.

import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { parseRunId } from './bg-notify.mjs';

export const DRAFT_SUFFIX = '.draft.md';
// Above this the draft is delivered as a pointer rather than read into the
// daemon's memory and copied into a handback. A report is kilobytes; a file
// this size is a worker that wrote something else to the path.
export const DRAFT_MAX_BYTES = 2 * 1024 * 1024;
export const DRAFT_ENDING_RULE = "--- HOW THE WORKER ENDED (the bridge's record, not part of the draft) ---";

/**
 * The run id a draft is filed under.
 *
 * A worker is spawned with its draft path named after <lane>-<startedAt>, the
 * same string its run log and its report use. The RE-ATTACH path (a worker that
 * outlived a daemon restart) reports under the registry key instead, which
 * carries a -<pid> tail, so the tail comes off here or that worker's draft
 * would never be found. An id of no known shape passes through unchanged for
 * the caller to sanitise.
 */
export function draftRunId(runId) {
  const { lane, startedAt } = parseRunId(runId);
  return lane && startedAt ? `${lane}-${startedAt}` : runId;
}

/**
 * Did this worker end WITHOUT a final report?
 *
 * `outcome` is detached-workers.mjs bgOutcome's shape. Two ways to have none:
 * it FAILED (a limit death, a crash, a kill, an errored result), or it ended
 * cleanly with nothing to say, which bgOutcome marks with a null record ("The
 * worker ended with no output."). A clean finish with text IS a final report,
 * and then the draft is ignored however recent it is.
 */
export function endedWithoutFinalReport(outcome, { finalReportSeen = false } = {}) {
  // A final report seen anywhere in the run wins over the outcome's status.
  // bgOutcome marks a worker "failed" when its report QUOTES a fatal phrase
  // (a report on the "401 invalid api key" bug it fixed) or when a later,
  // steered turn errors after the report was written; neither lost the report,
  // so neither may swap it for an older draft (QA 2026-09-27).
  if (finalReportSeen) return false;
  if (!outcome) return true;
  return outcome.status === 'failed' || outcome.record == null;
}

// The CLI's own death messages are one line; a report that merely quotes one
// is far longer than this.
export const DEATH_TEXT_MAX = 400;
// ...and it OPENS with its phrase: "You've hit your session limit" is complete
// by character 29, "Failed to authenticate" by 22. A phrase that completes
// only after this many characters is a quotation inside a report.
export const DEATH_PHRASE_WITHIN = 40;

/**
 * Is this stream event a turn that ended with a real final report: a result
 * event, not an error (is_error, or a subtype other than success), carrying
 * text that is not the CLI announcing its own death? `isDeathText` is the
 * caller's test for those (the fatal phrases and the limit signal); a text
 * that matches it still counts when it is report sized.
 */
export function isFinalReportEvent(ev, isDeathText = () => false) {
  if (!ev || ev.type !== 'result') return false;
  if (ev.is_error === true || (ev.subtype != null && ev.subtype !== 'success')) return false;
  const text = typeof ev.result === 'string' ? ev.result.trim() : '';
  if (!text) return false;
  // The CLI's death message LEADS with its phrase ("Invalid API key · Please
  // run /login", "You've hit your session limit · resets 3pm"). A report that
  // quotes one further in ("every probe got 'invalid api key'") is a report,
  // however short (QA 2026-09-27).
  let dies = false;
  try {
    if (text.length < DEATH_TEXT_MAX) {
      // Where does the first death phrase END? The CLI's own message ends its
      // phrase within the first few words; a quote inside a report ends later.
      for (let end = 1; end <= Math.min(text.length, DEATH_PHRASE_WITHIN); end += 1) {
        if (isDeathText(text.slice(0, end))) {
          dies = true;
          break;
        }
      }
    }
  } catch {
    dies = false;
  }
  return !dies;
}

/**
 * Did the run log at `file` record a final report (isFinalReportEvent) in any
 * turn? For the paths that only have the log: a worker re-attached after a
 * restart, and one the watchdog reaps. Never throws; any error is "no".
 */
export function logHadFinalReport(file, { readFile = null, isDeathText = () => false, chunkBytes = 1 << 20 } = {}) {
  if (!file) return false;
  const lineIsReport = (line) => {
    if (!line.includes('"result"')) return false;
    try {
      return isFinalReportEvent(JSON.parse(line), isDeathText);
    } catch {
      return false;
    }
  };
  try {
    if (readFile) return String(readFile(file, 'utf8')).split('\n').some(lineIsReport);
    // Read in chunks FROM THE END and stop at the first report: a report is
    // normally the log's last result event, and a multi-hour run's log is
    // hundreds of MB (reading it whole cost 0.7 s and 1.4 GB, QA 2026-09-27).
    // Chunks are split on raw newline bytes, so a multi-byte character is
    // never cut in half.
    const fd = openSync(file, 'r');
    try {
      let end = fstatSync(fd).size;
      let tail = Buffer.alloc(0); // bytes after the last newline seen so far
      while (end > 0) {
        const start = Math.max(0, end - chunkBytes);
        const chunk = Buffer.alloc(end - start);
        readSync(fd, chunk, 0, chunk.length, start);
        end = start;
        const joined = Buffer.concat([chunk, tail]);
        const first = start > 0 ? joined.indexOf(10) : -1;
        const body = first === -1 ? (start > 0 ? null : joined) : joined.subarray(first + 1);
        tail = first === -1 ? (start > 0 ? joined : Buffer.alloc(0)) : joined.subarray(0, first);
        if (body && body.toString('utf8').split('\n').some(lineIsReport)) return true;
      }
      return tail.length ? lineIsReport(tail.toString('utf8')) : false;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** The first line of a delivered draft. Exactly this wording: it is the whole explanation. */
export function draftHeadline(mtime) {
  return `DRAFT REPORT: this worker ended without a final report; below is the last draft it wrote (${mtime}).`;
}

/**
 * Read the draft at `file`. Returns { file, text, mtime } with `mtime` as an
 * ISO string, or null when there is nothing to deliver: no file, an empty or
 * whitespace-only one, something that is not a file, or ANY error at all.
 */
export function readDraftReport(file, { stat = statSync, readFile = readFileSync, maxBytes = DRAFT_MAX_BYTES } = {}) {
  if (!file) return null;
  try {
    const st = stat(file);
    if (!st || !st.isFile()) return null;
    const mtime = new Date(st.mtimeMs).toISOString();
    if (st.size > maxBytes) {
      return {
        file,
        mtime,
        text: `(The draft is ${st.size} bytes, too large to carry inline. Read it at ${file})`,
      };
    }
    const text = String(readFile(file, 'utf8'));
    if (!text.trim()) return null;
    return { file, text, mtime };
  } catch {
    return null;
  }
}

/**
 * The report text a delivered draft becomes: the headline, the draft whole,
 * then how the worker ended (the failure detail, or the limit rotation and
 * salvage block) under a rule that says whose words those are. Nothing the
 * bridge had before the draft existed is dropped; it moves below it.
 */
export function draftHandbackOutput(draft, ending) {
  const how = String(ending ?? '').trim();
  return [
    draftHeadline(draft?.mtime ?? 'unknown time'),
    '',
    String(draft?.text ?? '').replace(/\s+$/, ''),
    ...(how ? ['', DRAFT_ENDING_RULE, how] : []),
  ].join('\n');
}

// What a delivered draft's status ends with. Exported so a reader of the report
// files (scripts/verifier-guard-calibrate.mjs) can tell one without guessing.
export const DRAFT_STATUS_MARK = 'no final report, so its DRAFT report is delivered instead';

/** The status a delivered draft carries into the header and the report file. */
export function draftStatus(status) {
  return `${status} · ${DRAFT_STATUS_MARK}`;
}

/**
 * The worker's own words out of a delivered draft's report text: the draft,
 * without the headline above it and the bridge's ending record below it. What
 * handBackToChat audited, recovered from the file, so a re-measurement of the
 * verifier guard reads the same text the daemon did.
 */
export function draftTextOf(output) {
  const text = String(output ?? '');
  const nl = text.indexOf('\n');
  const body = nl === -1 ? '' : text.slice(nl + 1).replace(/^\n/, '');
  const cut = body.indexOf(`\n\n${DRAFT_ENDING_RULE}\n`);
  return cut === -1 ? body : body.slice(0, cut);
}

/**
 * One line for the watchdog note about a worker that died while the daemon was
 * not watching (a reboot, a crash). That note is the bridge's own, so the
 * worker's words go in the report file and the note points at it.
 */
export function draftPointerLine(draft, file) {
  return `DRAFT REPORT: this worker ended without a final report; the last draft it wrote (${draft?.mtime ?? 'unknown time'}) is filed at ${file}. Read it before relaunching anything: it is the worker's own account of what it had done.`;
}
