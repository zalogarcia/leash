// Waking the chat session when it may have unfinished work: the config, the
// two decisions and the summary parser.
//
// SHARED MODULE: byte-identical in the public and private bridge repos.
// scripts/check-shared.sh fails on drift. It owns no path, no transport and no
// owner-specific prose: the daemon measures the facts and this module only
// says whether they add up to a wake-up. That is what keeps the rule testable
// without a Telegram token.
//
// WHY THIS EXISTS (2026-09-11). The chat session had written five briefs to
// /tmp and was about to dispatch them when the daemon restarted under it. The
// turn died with its child. The next boot resumed the session and then waited,
// as it always had, for the owner's next message; the CLI's own repair of the
// dangling tool result ("Continue from where you left off." answered by a
// synthetic "No response requested.") only ran when that message arrived,
// fifty minutes later, and did nothing. Nothing in the daemon knew that a turn
// had been cut, and nothing asked the session to look. Two changes:
//
//   1. A restart wake-up. The daemon persists a "turn in flight" marker when a
//      chat run starts and clears it at every terminal state, so the next boot
//      can READ that a turn was cut rather than infer it from timestamps. A
//      restart that lands between turns still wakes the session when its last
//      answer made a forward looking commitment ("then I dispatch wave 4").
//   2. A compact wake-up. The compaction summary ends with an "Unfinished
//      work" section; the fresh chat is primed to CONTINUE it when it is not
//      empty, instead of acknowledging and waiting.
//
// Both respect the same guards as the automatic compaction: never into a run
// in flight, never on a walled engine, never on a Codex lane, at most once per
// restart or per compaction, and the owner's own message always wins.

export const WAKE_UP_DEFAULTS = Object.freeze({
  afterRestart: true,
  afterCompact: true,
});

const readBool = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
};

/**
 * The config block, made safe. `raw` is whatever config.json (or the
 * BRIDGE_WAKE_UP env var, as JSON text) carried: an object, a JSON string, a
 * bare boolean, or nothing. Both halves default ON: the failure this guards
 * against is silent, and a wake-up the owner did not need costs one short
 * line. A bare `false` turns both off; anything unreadable is the defaults.
 */
export function wakeUpConfig(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('{')) {
      try {
        v = JSON.parse(s);
      } catch {
        v = null;
      }
    } else {
      const b = readBool(s, null);
      v = b === null ? null : { afterRestart: b, afterCompact: b };
    }
  }
  if (typeof v === 'boolean') v = { afterRestart: v, afterCompact: v };
  if (!v || typeof v !== 'object') return { ...WAKE_UP_DEFAULTS };
  return {
    afterRestart: readBool(v.afterRestart, WAKE_UP_DEFAULTS.afterRestart),
    afterCompact: readBool(v.afterCompact, WAKE_UP_DEFAULTS.afterCompact),
  };
}

// ---------------------------------------------------------------------------
// FORWARD LOOKING COMMITMENTS
// ---------------------------------------------------------------------------
//
// The last answer the session gave, as the chat ring kept it (four hundred
// characters, redacted). If it promised a next action, the session had a plan
// it did not necessarily finish before the restart. The patterns are the ways
// the assistant actually phrases a plan in this chat, measured against the
// ring on the day this was written; the bias is towards waking, because a
// false positive costs one short reply and a false negative cost fifty minutes.

const COMMITMENT_PATTERNS = [
  // "I'll dispatch", "I will report", "I'm going to read", "I am about to"
  /\bI(?:'ll| will| am going to|'m going to| am about to|'m about to| plan to|'m on it| am on it)\b/i,
  // "then I dispatch", "once the gate lands I run", "next I read", "after that, I"
  /\b(?:then|next|after that|once\b[^.!?\n]{0,80}?)[,:]?\s+I(?:'ll| will)?\s+\w+/i,
  // "then running the refresh", "then dispatching wave 4", "next: reading"
  /\b(?:then|next)[:,]?\s+(?:\w+ing)\b/i,
  // "Reading the full report", "dispatching them", "firing wave 4 now"
  /\b(?:reading|running|dispatching|firing|sending|delivering|starting|collecting|verifying|checking|writing|building|pulling|merging|pushing|shipping|relaunching|re-firing|refiring|drafting|fixing|watching)\s+(?:the|it|them|this|that|wave|now|today|all|his|her|their|your|each|every|both)\b/i,
  // "will report back", "going to deliver", "will follow up"
  /\b(?:will|going to)\s+(?:report|deliver|send|dispatch|run|follow up|update|ping|fire|start|collect|verify|merge|push|ship|read|check)\b/i,
  // the small promises: "stand by", "in a moment", "on it now", "next up"
  /\b(?:report(?:ing)? back|stand by|standby|hang on|hold on|give me (?:a|\d+|one|two|five|ten)\b|in a (?:moment|minute|sec|second|bit|few)|shortly|next up|on it now|starting now|coming up|one moment|be right back|brb|in progress|still (?:running|working|reading|waiting))\b/i,
];

/**
 * The phrase that reads as a commitment, or null. Returned rather than a
 * boolean so the log line can say WHY the session was woken.
 */
export function forwardCommitment(text) {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  for (const re of COMMITMENT_PATTERNS) {
    const m = s.match(re);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

// How much of an answer's END the daemon keeps for the wake-up. The ring keeps
// the HEAD (four hundred characters, engine-handoff.mjs), and the next step is
// usually the last sentence, so the head alone missed it (QA, 2026-09-11).
export const ANSWER_TAIL_MAX = 300;

/** The last `max` characters of a text, one line, marked when it was cut. */
export function answerTail(text, max = ANSWER_TAIL_MAX) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/**
 * What the daemon persists about the chat's last answer, from the FULL text
 * at the close of the turn: when, the commitment phrase if any, and the tail.
 * The caller redacts the tail before writing it (the same matcher the ring
 * uses), so this stays free of that import.
 */
export function lastAnswerRecord(text, { ts = Date.now(), redact = (s) => s } = {}) {
  return { ts: Number(ts) || Date.now(), phrase: forwardCommitment(text), tail: redact(answerTail(text)) };
}

/** The last assistant row of a chat ring (oldest-first rows), or null. */
export function lastAssistantTurn(ring) {
  const rows = Array.isArray(ring) ? ring : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.role === 'assistant' && String(r.text ?? '').trim()) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// THE RESTART DECISION
// ---------------------------------------------------------------------------

/**
 * The decision, at the first idle moment after a boot. Pure: every input is a
 * fact the daemon holds, and the output names either the wake-up (with the
 * key that makes it once-only) or the one reason it is not happening.
 *
 *   config          from wakeUpConfig
 *   inFlight        the persisted "turn in flight" marker the previous daemon
 *                   left behind, or null: { runId, at, prompt, kind } where
 *                   kind is 'owner' | 'internal' | 'compact'
 *   ring            this chat's ring rows, oldest first (engine-handoff.mjs)
 *   lastAnswer      what the daemon persisted about the last answer, from the
 *                   full text (lastAnswerRecord), or null on an older state:
 *                   preferred over the ring, whose row is the head only
 *   engine          the chat lane's engine; only 'claude' resumes a session
 *   sessionChanged  the chat is not the one that was running at boot (/new,
 *                   /resume, a compaction): the cut turn belongs to another chat
 *   claudeAvailable the claude binary exists on this machine
 *   hasSession      a session id exists (a fresh chat has nothing to wake)
 *   walled          the Claude engine is behind a limit wall right now
 *   ownerMessage    the owner sent a chat message since this boot
 *   laneBusy        a run occupies the chat lane right now
 *   queued          messages waiting on the chat lane
 *   lastWakeUp      { key } of the last wake-up sent, or null
 *
 * Two outcomes short of a wake-up: a SKIP is final for this boot, a DEFER
 * (`defer: true`) asks the daemon to decide again at its next idle moment.
 * A busy lane defers: the wake-up must not start under a run in flight, but a
 * worker report that happened to land first is no reason to lose it. The
 * owner's own message skips: their message wins, and it is the one case the
 * design names by hand.
 *
 * Clause order is cheapest first and structural before measured, so the log
 * names the most fundamental reason when several apply.
 */
export function decideRestartWakeUp({
  config,
  inFlight = null,
  ring = [],
  lastAnswer = null,
  engine = 'claude',
  claudeAvailable = true,
  hasSession = false,
  sessionChanged = false,
  walled = false,
  ownerMessage = false,
  laneBusy = false,
  queued = 0,
  lastWakeUp = null,
} = {}) {
  const cfg = config || WAKE_UP_DEFAULTS;
  const skip = (reason) => ({ wake: false, defer: false, reason });
  if (!cfg.afterRestart) return skip('disabled');
  if (!claudeAvailable) return skip('claude_missing');
  if (engine !== 'claude') return skip('codex_lane');
  if (!hasSession) return skip('no_session');
  if (sessionChanged) return skip('chat_switched');
  if (ownerMessage) return skip('owner_message');
  if (walled) return skip('walled');
  // A CUT COMPACTION IS NOT A CUT TURN. The chat is exactly as it was before
  // the summary was asked for, so there is nothing of that turn to resume;
  // whatever the session was doing before it is what the ring answers below.
  const cut = inFlight && inFlight.kind !== 'compact' ? inFlight : null;
  // The persisted record wins: it was made from the whole answer. The ring
  // row is the fallback for a state written before the record existed.
  const fromState = lastAnswer && (lastAnswer.tail || lastAnswer.phrase) ? lastAnswer : null;
  const row = fromState ? null : lastAssistantTurn(ring);
  const last = fromState ? { ts: fromState.ts, text: fromState.tail || '' } : row;
  const phrase = fromState ? fromState.phrase || null : row ? forwardCommitment(row.text) : null;
  let kind = null;
  let key = null;
  if (cut) {
    kind = 'cut';
    key = `cut:${cut.runId || cut.at || 'unknown'}`;
  } else if (phrase) {
    kind = 'commitment';
    key = `commitment:${last.ts || 'unknown'}`;
  } else {
    return skip('nothing_pending');
  }
  if (lastWakeUp && lastWakeUp.key === key) return skip('already_sent');
  // Deferred, not skipped: the facts above are settled, only the lane is not.
  if (laneBusy) return { wake: false, defer: true, reason: 'lane_busy', kind, key };
  if (queued > 0) return { wake: false, defer: true, reason: 'queued', kind, key };
  return { wake: true, defer: false, reason: null, kind, key, cut, last, phrase };
}

// ---------------------------------------------------------------------------
// THE COMPACTION SUMMARY'S "UNFINISHED WORK" SECTION
// ---------------------------------------------------------------------------

export const UNFINISHED_HEADING = 'Unfinished work';

/**
 * The clause appended to the compaction prompt. One string, imported by both
 * daemons, so the summary the parser below reads was asked for in exactly the
 * words the parser expects.
 */
export function unfinishedWorkClause() {
  return (
    `End the summary with a fenced section titled "${UNFINISHED_HEADING}": ` +
    `a line reading ${UNFINISHED_HEADING}, then a fenced block (three backticks) listing every concrete pending action, ` +
    `one per line: dispatches you were about to make, deliveries you promised, workers still to collect, files written but not yet used. ` +
    `If nothing is pending the block contains the single word none.`
  );
}

/**
 * Read the section back. Tolerant of the shapes a model actually produces: a
 * heading with or without hashes or a colon, a fence with or without an info
 * string, an info string that IS the title, list markers of any kind.
 *
 *   { status: 'pending', items: [...] }   something is listed
 *   { status: 'none',    items: [] }      the block says none (or is empty)
 *   { status: 'missing', items: [] }      no such section in the summary
 */
export function parseUnfinishedWork(summary) {
  const s = String(summary ?? '');
  if (!s.trim()) return { status: 'missing', items: [] };
  const lines = s.split('\n');
  // Hashes, a number ("7."), an emoji, bold, a colon inside or outside the
  // bold: every heading shape a model puts on a section, measured (QA,
  // 2026-09-11: `**Unfinished work:**` and `## 7. Unfinished work` were read
  // as missing, which silently reverted the prime to "wait").
  const title = new RegExp(
    `^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?\\s*(?:[\\d.)]+\\s*)?(?:\\*\\*)?[^\\w\\n]*${UNFINISHED_HEADING}\\s*:?\\s*(?:\\*\\*)?\\s*:?\\s*$`,
    'i',
  );
  const fenceWithTitle = new RegExp(`^\\s*(?:\`{3,}|~{3,})\\s*${UNFINISHED_HEADING.replace(/\s+/g, '[ _-]*')}\\b`, 'i');
  const fence = /^\s*(?:`{3,}|~{3,})/;
  // The LAST occurrence wins: the prompt asks for the section at the end, and
  // an earlier mention of the phrase in prose is not the section.
  let start = -1;
  let body = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (fenceWithTitle.test(lines[i]) || title.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return { status: 'missing', items: [] };
  if (fenceWithTitle.test(lines[start])) {
    body = collectFenced(lines, start + 1);
  } else {
    // The heading, then the first fence after it (blank lines allowed). No
    // fence at all: take the lines that follow, up to the next heading, so a
    // model that forgot the backticks still gets its section read.
    let j = start + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && fence.test(lines[j])) body = collectFenced(lines, j + 1);
    else {
      body = [];
      for (let k = start + 1; k < lines.length; k++) {
        if (/^\s*#{1,6}\s/.test(lines[k])) break;
        body.push(lines[k]);
      }
    }
  }
  const items = (body || [])
    .map((l) => l.replace(/^\s*(?:[-*•·↳]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  if (!items.length) return { status: 'none', items: [] };
  if (items.length === 1 && /^(?:none|nothing|n\/a|no pending work)\.?$/i.test(items[0])) return { status: 'none', items: [] };
  return { status: 'pending', items };
}

function collectFenced(lines, from) {
  const out = [];
  for (let i = from; i < lines.length; i++) {
    if (/^\s*(?:`{3,}|~{3,})\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/**
 * Which prime the fresh chat gets. 'continue' when the feature is on and the
 * summary lists pending work; 'wait' otherwise, which is exactly the prime
 * every compaction used before this existed. A missing section reads as
 * nothing pending: the model was asked for the section, and a summary that
 * ignores the ask is not evidence of work either way, so the old behaviour
 * stands and the log says `unfinished=missing`.
 */
export function compactPrimeMode({ config, summary = '' } = {}) {
  const cfg = config || WAKE_UP_DEFAULTS;
  const parsed = parseUnfinishedWork(summary);
  if (!cfg.afterCompact) return { mode: 'wait', reason: 'disabled', unfinished: parsed.status, items: parsed.items };
  if (parsed.status === 'pending') return { mode: 'continue', reason: null, unfinished: 'pending', items: parsed.items };
  return { mode: 'wait', reason: `compact_${parsed.status}`, unfinished: parsed.status, items: [] };
}

// ---------------------------------------------------------------------------
// ONE LOG LINE PER DECISION
// ---------------------------------------------------------------------------

/** The restart decision, in the shape every other decision here logs. */
export function restartWakeUpLogLine(decision) {
  if (!decision) return '[bridge] wake_up_skipped reason=no_decision';
  if (decision.wake) {
    const why = decision.kind === 'cut' ? ` cut=${decision.key.slice(4)}` : decision.phrase ? ` phrase="${decision.phrase}"` : '';
    return `[bridge] wake_up_sent reason=restart kind=${decision.kind}${why}`;
  }
  if (decision.defer) return `[bridge] wake_up_deferred reason=${decision.reason} kind=${decision.kind}`;
  return `[bridge] wake_up_skipped reason=${decision.reason}`;
}

/** The compact prime, same shape. */
export function compactWakeUpLogLine(pick) {
  if (!pick) return '[bridge] wake_up_skipped reason=no_decision';
  if (pick.mode === 'continue') return `[bridge] wake_up_sent reason=compact unfinished=pending items=${pick.items.length}`;
  return `[bridge] wake_up_skipped reason=${pick.reason} unfinished=${pick.unfinished}`;
}
