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
 */
export function btwFraming(id, text, { name = DEFAULT_NAME } = {}) {
  const marker = `${BTW_ANSWER_PREFIX} #${id}:`;
  const who = String(name ?? '').trim() || DEFAULT_NAME;
  const header =
    `[BTW #${id} from the orchestrator (${who}). A side question, NOT an instruction for your task. ` +
    `Answer it right now in ONE message whose first line is exactly ${marker} ` +
    `(plain text under ${BTW_ANSWER_MAX} characters, no em or en dashes), then continue your task exactly where you were. ` +
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
 */
const ANSWER_RE = new RegExp(`^${BTW_ANSWER_PREFIX}(?:\\s*#\\s*(\\d+))?\\s*:[ \\t]*(.*)$`);

export function parseBtwAnswer(text) {
  const s = String(text ?? '');
  const nl = s.indexOf('\n');
  const firstLine = (nl === -1 ? s : s.slice(0, nl)).trim();
  const m = ANSWER_RE.exec(firstLine);
  if (!m) return null;
  const rest = nl === -1 ? '' : s.slice(nl + 1);
  const answer = [m[2], rest].join('\n').trim();
  return { id: m[1] === undefined ? null : Number(m[1]), answer };
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
     * Route one block of worker text, or say why it is not an answer.
     *
     *   { status: 'none'      }  ordinary output: leave it in the bubble and
     *                            the report, untouched
     *   { status: 'duplicate' }  it IS an answer, but a second copy of one
     *                            already routed (or one nobody is waiting for):
     *                            strip it, route nothing
     *   { status: 'routed', entry, answer, id }
     *
     * The duplicate case is not defensive programming, it is reachable: a
     * worker can restate an answer, and a model can name an id nobody is
     * waiting for. Both are stripped rather than routed. (The one duplicate
     * that happens on EVERY btw answered in its own turn, the identical text
     * appearing again as that turn's result event, never reaches here at all:
     * the daemon asks `delivered` at that site instead. See below for why.)
     *
     * A worker that was never asked anything is left completely alone: with no
     * question outstanding and none ever asked, a line beginning BTW-ANSWER is
     * the worker's own prose and stripping it would delete real output.
     */
    take(text) {
      const parsed = parseBtwAnswer(text);
      if (!parsed) return { status: 'none' };
      if (seq === 0) return { status: 'none' };
      const raw = String(text ?? '');
      if (seen.includes(raw)) return { status: 'duplicate' };
      // THE FIFO FALLBACK IS ONLY FOR AN ANSWER THAT CARRIES NO ID. An answer
      // that names a question nobody is waiting for is a second copy of one
      // already delivered (the assistant/result pair whose two texts were not
      // byte-identical, so the `seen` check missed), or an id the model
      // invented. Both are strictly better stripped than handed to whichever
      // question happens to be oldest: that would answer a live question with
      // text written about a different one.
      const entry = parsed.id == null ? pending[0] || null : pending.find((p) => p.id === parsed.id) || null;
      if (!entry) return { status: 'duplicate' };
      pending.splice(pending.indexOf(entry), 1);
      seen.push(raw);
      if (seen.length > BTW_SEEN_MAX) seen.shift();
      return { status: 'routed', entry, answer: parsed.answer, id: parsed.id };
    },
    /**
     * Has this EXACT text already been delivered to the chat as an answer?
     *
     * The result-event half of duplicate suppression, and deliberately a
     * different question from `take`.
     *
     * MEASURED, not assumed (60 real run logs, 2026-09-09): of 55 result events
     * carrying text, 55 were byte-identical to the last main-thread assistant
     * text block of that turn and none was a concatenation of several. So the
     * duplicate this has to catch is always an exact copy, and asking about
     * identity is both sufficient and the narrowest thing that works.
     *
     * `take` at that site would be wider than the evidence: it matches on the
     * FIRST LINE, so any result that merely begins with an answer would be
     * swallowed whole, and a second route could resolve a different pending
     * question with this text (QA, 2026-09-09). Both risks cost nothing to
     * remove, and the pending line has already been resolved from the assistant
     * block by the time this is asked.
     */
    delivered(text) {
      return seen.includes(String(text ?? ''));
    },
    /** Everything still outstanding, emptied. The end-of-run path. */
    drain() {
      return pending.splice(0, pending.length);
    },
  };
}
