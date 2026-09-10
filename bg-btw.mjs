// ---------------------------------------------------------------------------
// /btw: A SIDE QUESTION TO A RUNNING WORKER, ANSWERED IN THE CHAT.
//
// Steering already writes text into a running worker's stdin, and it works, but
// it only does one thing: it CHANGES THE JOB. Every steer is framed as "a
// mid-run instruction for your CURRENT task", and that framing is load bearing
// (without it the observed failure mode is a worker that abandons the brief it
// is halfway through). So there was no way to ask a running worker a question
// without also, unavoidably, telling it something.
//
// The questions are real and constant: "which repo are you in", "did the
// migration apply", "how far through the file list are you". Answering them
// used to mean either waiting for the report, or steering, which costs the
// worker a plan change it did not need.
//
// A btw is therefore the OPPOSITE framing on the same pipe: not an instruction,
// not approval, not a new task. Answer the one question in one message with a
// machine-detectable first line, then carry on exactly where you were. The
// daemon watches the worker's own stream for that first line, lifts the block
// out of the progress bubble and out of the report capture, and edits it into
// the pending message the asker already has on screen.
//
// Everything here is PURE for the same reason bg-steer.mjs is: bridge.mjs boots
// a daemon on import and cannot be tested, so the parts that can be wrong in
// ways a smoke test would not reveal (the framing, the marker detection, the id
// matching, the duplicate suppression) live here. See bg-btw.test.mjs.
//
// AVAILABILITY IS EXACTLY STEER AVAILABILITY. A btw travels the same stdin pipe
// and is resolved by the same resolver (resolveSteerTarget), so the STEER
// column of `bg.mjs ps` answers "can I btw this worker" with no second column
// and no second question: a worker that survived a daemon restart holds no
// pipe, a finished one has closed it, and a background Codex job is file-backed
// with no stdin at all. All three refuse a btw for the same reason and with the
// same words they refuse a steer.
// ---------------------------------------------------------------------------

// The one line the daemon looks for at the head of a worker's message. Written
// as a constant rather than inlined in the regex because THREE places have to
// agree on it: the framing that instructs the worker, the parser that detects
// it, and the test that proves the two match.
export const BTW_ANSWER_PREFIX = 'BTW-ANSWER';

// What the worker is asked to keep the answer under. Not enforced by clipping
// on arrival (a truncated answer is worse than a long one, and the send path
// already splits at Telegram's limit); it is a budget stated to the worker so
// it answers in a sentence rather than writing a second report.
export const BTW_ANSWER_MAX = 1500;

// How long a pending line waits before it SAYS something rather than just
// sitting there. Deliberately long: a worker mid tool call can genuinely be
// quiet for ten minutes, and a wait that gave up at two would be wrong far more
// often than it was right. The listener is NOT dropped at this point, so an
// answer that arrives at minute 40 still lands on the same message.
export const BTW_TIMEOUT_MS = 15 * 60_000;

// Cadence for the pending line. The same 15s a worker card uses: a btw is the
// same kind of object (a wait on one worker) and there is no reason for the two
// to tick at different rates.
export const BTW_TICK_MS = 15_000;

// How many delivered answers are remembered per worker for duplicate
// suppression. See `delivered` below: the SAME text arrives twice on a lane
// whose btw became its own turn (once as the assistant block, once as that
// turn's result event), and the second copy must not reach the report.
const BTW_SEEN_MAX = 20;

// How much of one question is kept on the run record and mirrored into the
// inflight registry. Same reason STEER_RECORD_MAX exists: that file is
// rewritten on every later ask and is read back by tooling outside this
// process.
export const BTW_RECORD_MAX = 500;

// The daemon's own name, used only as a fallback. Every real caller passes the
// `name` from config.json, because a worker being told who is asking should be
// told the name this install actually answers to.
const DEFAULT_NAME = 'Leash';

/**
 * What a worker is told a side question is.
 *
 * Read this against STEER_HEADER in bg-steer.mjs: every clause is the negation
 * of one the steer header asserts. A steer says "fold it into your current
 * task"; this says do not. A steer says "say what you did with it"; this says
 * answer it and change nothing. The two arrive down the same pipe in the same
 * shape, so the framing is the ONLY thing that tells them apart, and a btw read
 * as a steer is precisely the failure this wording exists to prevent: a worker
 * that re-plans because somebody asked it what time it was.
 *
 * The marker line is quoted back to the worker verbatim, including the id, so
 * the instruction and the parser cannot disagree about what to look for.
 *
 * THE BLANK LINE IS PART OF THE CONTRACT, not politeness. A question that lands
 * as a worker's task finishes is answered in the SAME message as its report (a
 * worker obeying "answer in ONE message" has nowhere else to put it), so the
 * framing tells it where the answer ends and parseBtwAnswer ends the answer at
 * exactly that boundary. Without the sentence, the first live round trip put a
 * whole report under an answer with no separator and the daemon handed the run
 * back as "ended with no output" (2026-09-10).
 */
export function btwFraming(id, text, { name = DEFAULT_NAME } = {}) {
  const marker = `${BTW_ANSWER_PREFIX} #${id}:`;
  const who = String(name ?? '').trim() || DEFAULT_NAME;
  const header =
    `[BTW #${id} from the orchestrator (${who}). A side question, NOT an instruction for your task. ` +
    `Answer it right now in ONE message whose first line is exactly ${marker}, in ONE paragraph ` +
    `(plain text under ${BTW_ANSWER_MAX} characters, no em or en dashes), then continue your task exactly where you were. ` +
    `If your task is already finished when the question arrives, put the answer first, leave one blank line, and write your report below it. ` +
    `Do not change your plan, do not start new work because of it, and do not treat it as approval of anything. ` +
    `In your final report add one line per side question under a heading Side questions.]`;
  return `${header}\n\n${String(text ?? '').trim()}`;
}

/**
 * Does this text already carry the btw framing?
 *
 * The guard on the one invariant the framing rests on: a question reaches the
 * worker FRAMED, or it reaches it looking exactly like a steer, and a steer is
 * an instruction. Today `btwAsk` is the only caller and it always frames, so
 * this is never false there; it exists so that stays true mechanically rather
 * than by everyone remembering, because `run.steer`'s `frame` option defaults
 * to false and a caller that passed `{ kind: 'btw' }` with a raw question would
 * make a worker re-plan because somebody asked it what repo it was in.
 *
 * Matched on the SHAPE, never on the name: the name comes from config.json and
 * a rename must not turn every future question into an unframed one.
 */
export function isBtwFramed(text) {
  return /^\[BTW #\d+ from the orchestrator/.test(String(text ?? ''));
}

/**
 * Is this block of assistant text a btw answer, and to which question?
 *
 * THE MARKER MUST BE THE FIRST LINE AND THE HEAD OF IT. A worker that mentions
 * BTW-ANSWER inside a sentence ("I will emit BTW-ANSWER #3 once the build is
 * done") is reporting on its work, and swallowing that block would delete real
 * output from both the bubble and the report while sending a fragment of a
 * progress note as an answer.
 *
 * The id is OPTIONAL in the parse even though the framing always asks for one:
 * a model that drops the `#3` is a likelier failure than one that invents a
 * wrong id, and the caller's FIFO fallback answers it correctly whenever only
 * one question is outstanding, which is nearly always. Returns null for
 * anything that is not an answer.
 *
 * THE BLOCK IS SPLIT, NEVER TAKEN WHOLE. A question that arrives as the task
 * finishes is answered in the same message as the report, so this returns both
 * halves and the callers keep them apart:
 *
 *   answer      what goes to the asker: the marker line's own text plus the
 *               lines under it, up to the FIRST BLANK LINE, and never more than
 *               BTW_ANSWER_MAX characters of them
 *   answerRaw   those same lines as a verbatim leading slice of the input, so a
 *               second copy of the block can have them stripped off the front
 *   remainder   everything below that blank line: ordinary worker output, which
 *               stays in the bubble and reaches the report
 *
 * Taking the block whole is what happened live on 2026-09-10: the asker got the
 * answer with a report folded into it and the orchestrator got "the worker
 * ended with no output" over a finished job.
 */
const ANSWER_RE = new RegExp(`^${BTW_ANSWER_PREFIX}(?:\\s*#\\s*(\\d+))?\\s*:[ \\t]*(.*)$`);

export function parseBtwAnswer(text) {
  const s = String(text ?? '');
  const lines = s.split('\n');
  const m = ANSWER_RE.exec(lines[0].trim());
  if (!m) return null;
  // Two boundaries, whichever comes first: the blank line the framing asks for,
  // and the budget it states. The budget is a fallback for the worker that runs
  // on without one, and it breaks at a LINE, never mid sentence: a truncated
  // answer reads like a whole one, while a long one is only long.
  let end = 1; // lines the answer occupies, from the marker line down
  let size = (m[2] || '').length;
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim()) break;
    if (size + 1 + line.length > BTW_ANSWER_MAX) break;
    size += 1 + line.length;
    end += 1;
  }
  return {
    id: m[1] === undefined ? null : Number(m[1]),
    answer: [m[2], ...lines.slice(1, end)].join('\n').trim(),
    answerRaw: lines.slice(0, end).join('\n'),
    remainder: lines.slice(end).join('\n').trim(),
  };
}

/**
 * Per-worker bookkeeping for side questions.
 *
 * Held per RUN rather than globally, which is what makes cross-worker
 * misrouting structurally impossible rather than merely unlikely: an answer is
 * only ever matched against the questions asked of the worker that emitted it,
 * so a `#1` from bg2 can never resolve bg3's `#1`. Ids are per worker and
 * monotonic for the same reason: they only have to be unique within the one
 * conversation they identify.
 *
 * The entries are opaque to this module. bridge.mjs hangs the live Telegram
 * message on them; the tests hang plain objects.
 */
export function createBtwTracker() {
  let seq = 0;
  const pending = [];
  const seen = [];
  const answered = [];

  // Named rather than inline so `route` below can iterate it without depending
  // on how the returned object is called.
  const takeOne = (text) => {
    const parsed = parseBtwAnswer(text);
    if (!parsed) return { status: 'none' };
    if (seq === 0) return { status: 'none' };
    // Matched on the ANSWER, not on the whole block: the same answer can
    // arrive twice with different text under it (the assistant block and its
    // result event, one of them re-wrapped), and only the answer is the copy.
    if (seen.includes(parsed.answerRaw)) return { status: 'duplicate', remainder: parsed.remainder };
    // THE FIFO FALLBACK IS ONLY FOR AN ANSWER THAT CARRIES NO ID. An answer
    // that names a question nobody is waiting for is a second copy of one
    // already delivered (the assistant/result pair whose two texts were not
    // byte-identical, so the `seen` check missed), or an id the model
    // invented. Both are strictly better stripped than handed to whichever
    // question happens to be oldest: that would answer a live question with
    // text written about a different one.
    const entry = parsed.id == null ? pending[0] || null : pending.find((p) => p.id === parsed.id) || null;
    if (!entry) return { status: 'duplicate', remainder: parsed.remainder };
    pending.splice(pending.indexOf(entry), 1);
    seen.push(parsed.answerRaw);
    if (seen.length > BTW_SEEN_MAX) seen.shift();
    answered.push(entry.id);
    return { status: 'routed', entry, answer: parsed.answer, id: parsed.id, remainder: parsed.remainder };
  };

  return {
    /** Mint the next id and queue the question. FIFO order is arrival order. */
    add(entry = {}) {
      seq += 1;
      const record = { ...entry, id: seq };
      pending.push(record);
      return record;
    },
    get seq() {
      return seq;
    },
    get size() {
      return pending.length;
    },
    /** A snapshot, so a caller iterating it cannot be surprised by a resolve. */
    list() {
      return pending.slice();
    },
    /**
     * Un-queue one record without consuming an answer. The delivery-failed
     * path: the id is minted before the stdin write (the framing has to quote
     * it back to the worker), so a write that bounces has to take the question
     * back out or it waits forever on an answer nobody was asked for. The id
     * itself is NOT recycled: `seq` only ever climbs, so a late answer to a
     * question that never landed cannot collide with a later one.
     */
    remove(record) {
      const i = pending.indexOf(record);
      if (i === -1) return false;
      pending.splice(i, 1);
      return true;
    },
    /**
     * Route the FIRST answer in a block of worker text, or say why there is
     * none. `route` below is what callers use: it drains the block by calling
     * this until nothing at the front of what is left is an answer.
     *
     *   { status: 'none'      }  ordinary output: leave it in the bubble and
     *                            the report, untouched
     *   { status: 'duplicate' }  it IS an answer, but a second copy of one
     *                            already routed (or one nobody is waiting for):
     *                            strip it, route nothing
     *   { status: 'routed', entry, answer, id }
     *
     * EVERY ANSWERING STATUS CARRIES A `remainder`: the part of the block that
     * was not the answer. It is ordinary worker output and the caller keeps it,
     * which is what stops a report written under an answer from vanishing with
     * it. Empty for the usual mid task answer, which is why that case behaves
     * exactly as it did before.
     *
     * The duplicate case is not defensive programming, it is reachable: a
     * worker can restate an answer, and a model can name an id nobody is
     * waiting for. Both are stripped rather than routed. (The one duplicate
     * that happens on EVERY btw answered in its own turn, the identical text
     * appearing again as that turn's result event, never reaches here at all:
     * the daemon asks `strip` at that site instead. See below for why.)
     *
     * A worker that was never asked anything is left completely alone: with no
     * question outstanding and none ever asked, a line beginning BTW-ANSWER is
     * the worker's own prose and stripping it would delete real output.
     */
    take: takeOne,
    /**
     * Route EVERY answer in one block, and return what is left of it.
     *
     * The framing tells a worker to answer in ONE message, so a worker holding
     * two outstanding questions answers BOTH in one message and `takeOne` would
     * route the first and hand the second back as "ordinary worker output":
     * into the bubble, the handback, bg-results.jsonl, with its own asker still
     * being told the run ended without answering (QA, 2026-09-10). Draining is
     * the whole answer to that: keep taking while the front of what is left is
     * still an answer, and stop at the first thing that is not one.
     *
     * Terminates because every take consumes at least the marker line, so the
     * remainder is strictly shorter each time round.
     */
    route(text) {
      const routed = [];
      let rest = String(text ?? '');
      for (;;) {
        const res = takeOne(rest);
        if (res.status === 'none') return { routed, remainder: rest };
        if (res.status === 'routed') routed.push({ entry: res.entry, answer: res.answer, id: res.id });
        rest = res.remainder || '';
        if (!rest) return { routed, remainder: '' };
      }
    },
    /**
     * The ids whose answers reached an asker, in the order they were answered.
     *
     * The one thing an end-of-run report needs to know: a worker whose LAST
     * message was an answer produced no result text of its own, and "ended with
     * no output" over that is false in the one way that costs work. See
     * btwOnlyOutputNote.
     */
    get answered() {
      return answered.slice();
    },
    /**
     * This text with an ALREADY DELIVERED answer taken off the front.
     *
     * The result-event half of duplicate suppression, and deliberately a
     * different question from `take`: it routes nothing, so it can never
     * resolve a second pending question with the same text (QA, 2026-09-09).
     *
     * Returns '' when the text was only the answer, which is the usual case (60
     * real run logs, 2026-09-09: of 55 result events carrying text, 55 were
     * byte-identical to the last main-thread assistant text block of that turn)
     * and the case that behaves exactly as it always has. It returns the rest
     * when there IS a rest, because that rest is the worker's report: dropping
     * the whole event instead handed a finished job back as "ended with no
     * output" while its report sat inside the answer (live, 2026-09-10).
     */
    strip(text) {
      let rest = String(text ?? '');
      for (;;) {
        // The LONGEST match rather than the first: two answers on one worker can
        // share a leading line, and stripping the shorter would leave the tail of
        // a private answer sitting in the report.
        let hit = '';
        for (const a of seen) if (a && rest.startsWith(a) && a.length > hit.length) hit = a;
        // Repeated for the same reason `route` drains: two questions answered in
        // one message put TWO answers at the front of the same result event, and
        // subtracting one of them would hand the other to the report.
        if (!hit) return rest;
        rest = rest.slice(hit.length).trim();
        if (!rest) return '';
      }
    },
    /** Everything still outstanding, emptied. The end-of-run path. */
    drain() {
      return pending.splice(0, pending.length);
    },
  };
}

/**
 * What a run reports when its only final message was a side answer.
 *
 * The last hole the 2026-09-10 round trip left open. A worker asked a question
 * at the very end of its task answers it, that answer is routed to the asker,
 * and the run then ends with nothing else to hand back: the report capture is
 * legitimately empty, and the outcome line for that is "the worker ended with
 * no output", which reads as a dead worker and gets the job re-fired.
 *
 * So the empty capture is given its reason instead. Returns null when no answer
 * was delivered on the run, which is every other run and leaves them untouched.
 */
export function btwOnlyOutputNote(ids = []) {
  const list = (Array.isArray(ids) ? ids : []).filter((n) => Number.isFinite(n));
  if (!list.length) return null;
  const which = list.map((n) => `#${n}`).join(', ');
  return `The worker's only final message was its answer to side question ${which}, routed to the asker.`;
}
