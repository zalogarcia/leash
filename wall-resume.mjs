// THE USAGE WALL GUARD, part 2: RESTART THE WORK AFTER THE WALL.
//
// SHARED MODULE, byte-identical in the public and private bridge repos and
// listed in scripts/check-shared.sh. Pure: no file access, no clock, no daemon
// state.
// Anything specific to one machine (the command that lists a dead run's
// production writes, the time zone) is passed in by the caller.
//
// ---------------------------------------------------------------------------
// WHY (2026-10-06, morning)
//
// When every Claude account reached its limit, the background workers that
// were mid job died there, and the chat lane wrote a resume brief for each by
// hand and scheduled each for the next account's reset. wall-guard.mjs is the
// half before the wall (save a checkpoint, keep going). This is the half after
// it: at the lift, every Claude worker that DIED on the wall with its job
// unfinished is queued again by the bridge, through the ordinary queue, as its
// ORIGINAL brief, whole and unchanged, behind a bridge-written RESUME NOTE.
//
// ---------------------------------------------------------------------------
// THE SAFETY RULES, each one a decision below, each one persisted by the
// caller (wall-guard.mjs createWallGuardStore) so a restart cannot undo it:
//
//   • never a run that is still alive. The caller checks the live worker
//     registry and the process itself, never a log line: on 2026-09-25 a
//     "died on a limit" line was wrong and a second worker was sent onto a
//     live one;
//   • never the same death twice (the store's claim, written before anything
//     is queued);
//   • a chain cap: at most `resumeChainMax` automatic resumes per job (2 by
//     default). A job that eats a window every time it runs cannot loop; the
//     next death goes to the chat lane with the reason;
//   • an opt out: a brief with the line `Auto-resume: no` is never resumed
//     automatically;
//   • a job already running or queued under the same title is not queued a
//     second time (the chat lane may have relaunched it by hand on another
//     engine during the wall).
//
// A worker that FINISHED (its report is only being held for the wake-up, or
// it wrote its final report before a later turn died) is not resumed: there
// is nothing left to do. Everything not resumed is listed, with its reason,
// in the wake-up the chat lane gets at the lift, next to the list of what WAS
// resumed and the words "do not dispatch these again", so nothing is queued
// twice through the chat lane either.
//
// THE RESUME IS PINNED TO CLAUDE ON THE QUEUE ITEM. The dead run was Claude,
// and a Claude-pinned job is HELD by the drain while a wall is up instead of
// falling through to Codex (engine-state.mjs resolveEngine). So a resume
// waits for the lift even if the wall comes back between the queueing and the
// drain, and the Codex fallback for NEW jobs is untouched.
//
// THE TITLE IS KEPT AS A PREFIX. Scheduled checks match a running worker by
// the start of its title, so the resume's first heading is the original title
// plus " (auto resume N of M)": the title a worker card and `bg.mjs ps` show
// starts the same way, and says what it is.

import { baseRunId } from './wall-guard.mjs';

/** The suffix on a resume's heading. Parsed back to count the chain. */
export const RESUME_HEADING_RE = /^# (.+?) \(auto resume (\d+) of (\d+)\)[ \t]*$/;
/** The line between the bridge's note and the original brief. */
export const ORIGINAL_BRIEF_RULE = '--- ORIGINAL BRIEF, whole and unchanged, below this line ---';
/**
 * The opt out: a line of its own, `Auto-resume: no` (a list marker or bold
 * markers around it are tolerated). A sentence that merely mentions it does
 * not count, so a brief ABOUT this feature is not opted out by accident.
 */
export const OPT_OUT_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?Auto-resume:(?:\*\*|__)?[ \t]*(?:\*\*|__)?no(?:\*\*|__)?[ \t]*\.?[ \t]*$/im;

/** Does this brief opt out of the automatic resume? */
export function optedOut(text) {
  return OPT_OUT_RE.test(String(text ?? ''));
}

/**
 * Take the bridge's own resume header off a task, when it has one.
 * Returns { original, title, count, max }: `original` is the brief the very
 * first run was given, `title` the title written into the header (null when
 * there was no header) and `count` the resume number that header carried
 * (0 for an original brief).
 */
export function splitResumeHeader(task) {
  const s = String(task ?? '');
  const first = s.split('\n', 1)[0];
  const m = RESUME_HEADING_RE.exec(first);
  if (!m) return { original: s, title: null, count: 0, max: null };
  const cut = s.indexOf(`\n${ORIGINAL_BRIEF_RULE}\n`);
  if (cut === -1) return { original: s, title: m[1], count: Number(m[2]) || 0, max: Number(m[3]) || null };
  const original = s.slice(cut + ORIGINAL_BRIEF_RULE.length + 2).replace(/^\n/, '');
  return { original, title: m[1], count: Number(m[2]) || 0, max: Number(m[3]) || null };
}

/**
 * How many automatic resumes this job has had, from the dispatch record and
 * from the brief itself, whichever says more. The brief is the fallback that
 * cannot be lost: a dispatch record that failed to write must not reset the
 * chain to zero and let a job loop.
 */
export function resumeCountOf({ task = '', meta = null } = {}) {
  const fromMeta = Number(meta?.resumeCount) || 0;
  return Math.max(fromMeta, splitResumeHeader(task).count);
}

/**
 * The last checkpoint commit in a run's log: `git commit` prints
 * "[<branch> <sha>] WIP checkpoint ...". Returns { branch, sha } or null.
 * `text` is whatever the caller read of the log (only lines mentioning the
 * checkpoint need to be passed).
 */
export function checkpointCommitFrom(text) {
  const re = /\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] WIP checkpoint/g;
  let last = null;
  let m;
  const s = String(text ?? '');
  while ((m = re.exec(s))) last = { branch: m[1], sha: m[2] };
  return last;
}

const titleKey = (t) =>
  String(t ?? '')
    .replace(/\s*\(auto resume \d+ of \d+\)\s*$/, '')
    .replace(/…$/, '')
    .trim();

/**
 * Is `a` the same job as `b`, by title? Titles are clipped for display, and a
 * resume adds a suffix, so one may be a prefix of the other. Very short titles
 * never match: "Fix" must not hold back every job whose title starts with it.
 */
export function sameJobTitle(a, b, { minChars = 12 } = {}) {
  const x = titleKey(a);
  const y = titleKey(b);
  if (x.length < minChars || y.length < minChars) return x.length > 0 && x === y;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/**
 * THE CANDIDATES at a lift: every background worker the wall episode recorded
 * (wall-wake.mjs rows: { runId, title, died, ... }) joined with the deaths the
 * guard's store holds (with their brief and dispatch facts). A death in the
 * store that the episode missed (its list is bounded) still counts when it
 * happened during this episode (`since`, the episode's start); an older one
 * belongs to a wall long gone and is returned in `stale` for the caller to
 * drop. Returns { candidates, stale }.
 */
export function resumeCandidates({ episodeWorkers = [], deaths = [], since = 0 } = {}) {
  const byId = new Map();
  const stale = [];
  for (const d of deaths || []) {
    if (!d || !d.runId) continue;
    if (Number(d.at) < Number(since)) {
      stale.push(d.runId);
      continue;
    }
    byId.set(d.runId, { ...d, died: true, inEpisode: false });
  }
  for (const w of episodeWorkers || []) {
    if (!w || !w.runId) continue;
    const id = baseRunId(w.runId);
    const have = byId.get(id);
    byId.set(id, { ...(have || {}), runId: id, title: have?.title || w.title || '', died: Boolean(w.died) || Boolean(have), report: have?.report || w.report || null, draft: have?.draft || w.draft || null, inEpisode: true, listedAt: w.listedAt || null });
  }
  return { candidates: [...byId.values()], stale };
}

/** The reasons a death is not resumed, worded for the chat lane and the owner. */
export const SKIP = Object.freeze({
  off: 'automatic resume is switched off',
  finished: 'it finished; its report is held for you',
  finalReport: 'it wrote its final report before the limit',
  resumedBefore: 'the bridge resumed it at an earlier lift; do not dispatch it again',
  noBrief: 'no brief on disk',
  optOut: 'its brief says Auto-resume: no',
  alive: 'it is still running',
  busy: 'a job with the same title is already running or queued',
  duplicate: 'another dead run with the same title is resumed instead',
  chainCap: (n) => `chain cap: resumed ${n} time${n === 1 ? '' : 's'} automatically already`,
});

/**
 * THE PLAN at a lift, pure. Returns { resume: [{ ...candidate, count }], skip:
 * [{ ...candidate, reason }] }. `count` is the resume number the new run gets
 * (1 for the first resume of a job). The predicates are the caller's:
 * `isAlive(runId)` reads the live registry and the process, `isBusy(title)`
 * the running, queued and held jobs, `wasResumed(runId)` the store.
 */
export function resumePlan({ candidates = [], settings = {}, isAlive = () => false, isBusy = () => false, wasResumed = () => false } = {}) {
  const on = settings.enabled !== false && settings.resume !== false;
  const max = Number.isFinite(Number(settings.resumeChainMax)) ? Number(settings.resumeChainMax) : 2;
  const resume = [];
  const skip = [];
  // Titles chosen in THIS plan: two dead runs of one job (a duplicate that
  // existed before the wall) must not come back as two (QA, 2026-10-06).
  const chosen = [];
  for (const c of candidates || []) {
    if (!c || !c.runId) continue;
    const no = (reason) => skip.push({ ...c, reason });
    if (!c.died) {
      no(SKIP.finished);
      continue;
    }
    if (wasResumed(c.runId)) {
      no(SKIP.resumedBefore);
      continue;
    }
    if (!on) {
      no(SKIP.off);
      continue;
    }
    if (c.finalReportSeen) {
      no(SKIP.finalReport);
      continue;
    }
    if (!String(c.text ?? '').trim()) {
      no(SKIP.noBrief);
      continue;
    }
    if (optedOut(c.text)) {
      no(SKIP.optOut);
      continue;
    }
    if (isAlive(c.runId)) {
      no(SKIP.alive);
      continue;
    }
    // `task` is the brief with the lane rules off (the caller's
    // stripLaneRules), where the bridge's own header sits first.
    const done = resumeCountOf({ task: c.task ?? c.text, meta: c });
    if (done + 1 > max) {
      no(SKIP.chainCap(done));
      continue;
    }
    if (isBusy(c.title)) {
      no(SKIP.busy);
      continue;
    }
    if (chosen.some((t) => sameJobTitle(t, c.title))) {
      no(SKIP.duplicate);
      continue;
    }
    chosen.push(c.title);
    resume.push({ ...c, count: done + 1, max });
  }
  return { resume, skip };
}

/**
 * When the resumes are due: `readyAt` is the moment the next account became
 * ready (the lift), `withinMinutes` the setting. The bridge queues them at the
 * lift itself; `late` says a lift that came after the window (the daemon was
 * down at the reset), which the owner's line then names.
 */
export function resumeTiming({ readyAt = null, now = Date.now(), withinMinutes = 5 } = {}) {
  const ready = Number(readyAt) > 0 ? Number(readyAt) : Number(now);
  const dueBy = ready + Math.max(1, Number(withinMinutes) || 5) * 60_000;
  return { readyAt: ready, dueBy, late: Number(now) > dueBy, lateMin: Number(now) > dueBy ? Math.round((Number(now) - ready) / 60_000) : 0 };
}

/**
 * THE RESUME NOTE, the bridge's words in front of the original brief. Every
 * field is the caller's fact or null; the note says "none" rather than guess.
 * `writesCommand` is the command that lists the dead run's production writes
 * on this machine, or null, in which case the run log is named instead.
 */
export function resumeNote({ runId = '', endedClock = null, account = null, count = 1, max = 2, draft = null, report = null, checkpoint = null, writesCommand = null, runLog = null } = {}) {
  const lines = [
    '## RESUME NOTE (written by the bridge; read it before anything else)',
    '',
    `This job ran before as ${runId || 'an earlier run'}. That run ended${endedClock ? ` at ${endedClock}` : ''} because every Claude account had reached its usage limit${account ? ` (it was on ${account})` : ''}. The bridge queued it again automatically once an account was free. This is automatic resume ${count} of at most ${max} for this job. Below the rule at the end of this note is the ORIGINAL brief, whole and unchanged.`,
    '',
    'What the last run left:',
    `- Its checkpoint note and draft report: ${draft ? `${draft} (read its RESUME NOTE section first)` : 'none was written'}`,
    `- Its full report: ${report || 'none was written'}`,
    `- Its checkpoint commit: ${checkpoint?.sha ? `${checkpoint.sha} on branch ${checkpoint.branch}` : 'none found in its log (still look for a "WIP checkpoint" commit or a .patch file the note names)'}`,
    `- Its production writes: ${writesCommand ? `run \`${writesCommand}\`` : runLog ? `read its run log for every write it made: ${runLog}` : 'no run log is on disk, so verify the live state of anything it may have written'}`,
    '',
    'Rules for this run:',
    '1. Read the checkpoint note and the git state FIRST (git status, git log, the branch named above, any patch file the note names) and continue from there. Do not redo finished work.',
    '2. Before any production write, verify the live state. Never repeat a send, a deploy, a migration, a payment or a publish that already happened.',
    '3. If no checkpoint note exists, say so first in your report, then rebuild the state from disk and git before acting.',
  ];
  return lines.join('\n');
}

/**
 * THE RESUME BRIEF. `text` is the dead run's whole brief as it was queued
 * (lane rules included, when the lane adds them), `task` the same brief with
 * the lane rules taken off (the caller's stripLaneRules), `title` its title.
 * The lane rules stay in front, untouched, because they are the lane's frame
 * and not the brief; then the heading and the note; then the rule; then the
 * ORIGINAL brief. For a resume of a resume the previous header comes off
 * first, so notes never pile up and the original stays the original.
 * Returns { text, title, count }.
 */
export function resumeBrief({ text = '', task = null, title = '', count = 1, max = 2, note = '' } = {}) {
  const whole = String(text ?? '');
  const t = task == null ? whole : String(task);
  const rules = whole.endsWith(t) ? whole.slice(0, whole.length - t.length) : '';
  const prev = splitResumeHeader(t);
  const baseTitle = oneLineTitle(prev.title || title || firstLine(prev.original) || 'Background job');
  const heading = `# ${baseTitle} (auto resume ${count} of ${max})`;
  return {
    text: `${rules}${heading}\n\n${String(note).trim()}\n\n${ORIGINAL_BRIEF_RULE}\n\n${prev.original}`,
    title: `${baseTitle} (auto resume ${count} of ${max})`,
    count,
  };
}

const oneLineTitle = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const firstLine = (s) =>
  String(s ?? '')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean) || '';

/**
 * The queue item for one resume: the drop box shape bg.mjs writes, with the
 * dead run's directory pin and scheduled run mark carried over and the engine
 * PINNED to Claude (see the header). `resumeOf`, `resumeCount` and
 * `resumeRoot` ride along for the next dispatch record.
 *
 * `maxRunning` is THE PACE (the `resumeMaxConcurrent` setting): the item
 * carries it, and the drain starts the job only while fewer Claude workers
 * than that are running (bg-admission.mjs hasSlot `itemMax`). On the item, so
 * a resume held through a second wall keeps its pace, and so the drain needs
 * no setting of its own. It can only lower the ordinary cap. Absent or 0: the
 * ordinary cap alone.
 */
export function resumeQueueItem({ death = {}, text = '', count = 1, now = Date.now(), maxRunning = 0 } = {}) {
  const d = death || {};
  const pace = Math.floor(Number(maxRunning));
  return {
    text,
    queuedAt: new Date(Number(now)).toISOString(),
    engine: 'claude',
    ...(d.cwd ? { cwd: d.cwd } : {}),
    ...(d.scheduleId != null ? { scheduleId: d.scheduleId } : {}),
    ...(d.scheduleId != null && d.allowWrite === true ? { allowWrite: true } : {}),
    resumeOf: d.runId || null,
    resumeCount: count,
    resumeRoot: d.resumeRoot || d.runId || null,
    ...(pace > 0 ? { maxRunning: pace } : {}),
  };
}

/** The pace, in words, for the wake-up and the owner's line. Empty when there is none. */
export function paceWords(maxRunning) {
  const n = Math.floor(Number(maxRunning));
  return n > 0 ? `at most ${n} worker${n === 1 ? '' : 's'} run at once, the rest start as workers finish` : '';
}

const short = (s, n) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/**
 * THE WAKE-UP LINES, for the chat lane's wake-up at the lift: what the bridge
 * already resumed ("do not dispatch these again") and what it did not, with
 * the reason. No blank line inside: the wake-up is folded in front of a
 * message by its first blank line.
 */
export function resumeWakeLines({ resumed = [], skipped = [], maxRunning = 0 } = {}) {
  const lines = [];
  if (resumed.length) {
    const pace = paceWords(maxRunning);
    lines.push(`🔁 The bridge already RESUMED ${resumed.length} job${resumed.length === 1 ? '' : 's'} (original brief plus a resume note, queued now${pace ? `; ${pace}, so a job still waiting in the queue is not lost` : ''}). Do NOT dispatch these again:`);
    resumed.forEach((r, i) => lines.push(`  ${i + 1}. ${r.runId} · ${short(r.title, 100)} · queued as resume ${r.count} of ${r.max}`));
  }
  if (skipped.length) {
    lines.push(`⏸ The bridge did NOT resume ${skipped.length} job${skipped.length === 1 ? '' : 's'}; each is yours to decide:`);
    skipped.forEach((s, i) => lines.push(`  ${i + 1}. ${s.runId} · ${short(s.title, 100)} · ${s.reason}`));
  }
  return lines;
}

/**
 * Does the lift owe the owner a line? Only when something was resumed, or a
 * worker that DIED was not: a worker that merely finished during the wall is
 * already in the wake-up, and a line saying "resumed no jobs" over it says
 * nothing (QA, 2026-10-06).
 */
export function liftNoticeDue({ resumed = [], skipped = [] } = {}) {
  return resumed.length > 0 || skipped.some((s) => s && s.died);
}

/**
 * THE OWNER'S LINE at the lift, written by the bridge (no model call): how
 * many jobs were resumed and their titles, how many that died were not and
 * why. A worker that finished during the wall is not counted here.
 */
export function resumeLiftNotice({ resumed = [], skipped: all = [], late = false, lateMin = 0, maxRunning = 0 } = {}) {
  const skipped = (all || []).filter((s) => s && s.died);
  const n = resumed.length;
  const lines = [`🔁 Resumed ${n ? n : 'no'} job${n === 1 ? '' : 's'} after the usage wall${late ? ` · late, ${lateMin} min after the account was ready` : ''}`];
  for (const r of resumed) lines.push(`↳ ${short(r.title, 80)}`);
  const pace = Math.floor(Number(maxRunning));
  if (pace > 0 && n > pace) lines.push(`🚦 Paced: ${paceWords(pace)}`);
  if (skipped.length) {
    const why = new Map();
    for (const s of skipped) {
      const k = String(s.reason).startsWith('chain cap') ? 'chain cap' : String(s.reason).split(';')[0];
      why.set(k, (why.get(k) || 0) + 1);
    }
    lines.push(`⏸ Not resumed: ${skipped.length} · ${[...why].map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  }
  return lines.join('\n');
}
