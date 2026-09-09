// ---------------------------------------------------------------------------
// PEERS: the terminal sessions on this machine that the daemon did not spawn
//
// WHY THIS FILE EXISTS. On 2026-09-08 the owner ran /status from their phone
// while a Codex session in the tmux session `codex-shell` had been working forty
// minutes on their behalf, on a job the daemon itself had handed it. /status
// listed the chat lane and the two background lanes and stopped, so from the
// phone that session did not exist. They asked why.
//
// The reason was structural rather than a bug: /status renders what the daemon
// SPAWNED (its lanes, the workers it re-attached after a restart, its Codex
// runs). An interactive session someone opened in a terminal is a peer on the
// same machine, spawned by nobody, so nothing in the daemon had a reason to
// look at it. This module is that reason.
//
// READ ONLY, MECHANICALLY. Every tmux invocation in here goes through tmux(),
// which refuses any subcommand outside READ_ONLY_TMUX. Peer sessions belong to
// whoever is typing in them: a keystroke sent into one is a keystroke the owner
// did not type, and killing one is work thrown away. peers.test.mjs greps this
// file for the write verbs, so the guard is not just prose in a comment.
//
// COST. tmux is shelled out to ONLY when /status renders, never on a poll, and
// every call carries its own timeout, so a wedged tmux server costs the block
// and not the reply. The captures run in parallel, so the whole read is one
// timeout wide rather than one per session.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { oneLine, clip } from './progress-render.mjs';
import { normalizeDashes } from './dash-normalize.mjs';

/** At most this many peers reach the block. The rest are counted, not listed. */
export const PEER_MAX = 12;

/** How many panes are worth capturing. Above this a session is listed `not read`. */
export const PEER_CAPTURE_MAX = 16;

/** Per tmux call. A hung tmux server costs the Peers block, never /status. */
export const TMUX_TIMEOUT_MS = 3_000;

/** How much of a pane is read. The live status line is always near the bottom. */
export const PANE_TAIL_LINES = 80;

/** The detail row is a hint, not a transcript. */
export const DETAIL_MAX = 70;

/** A session name past this is clipped: the identifying part is the head. */
export const NAME_MAX = 24;

// The two markers a session line can carry, and nothing else, so a peer's own
// text cannot widen the row.
export const ENGINE_LABELS = { codex: 'Codex', claude: 'Claude', terminal: 'terminal' };

// ---------------------------------------------------------------------------
// READING A PANE
// ---------------------------------------------------------------------------
//
// Every pattern below was taken off a live pane or out of the shipped binary on
// 2026-09-08, never guessed:
//
//   Claude Code   `bypass permissions on (shift+tab to cycle)` and
//                 `new task? /clear to save 118.4k tokens` sit in the footer of
//                 every Claude session on the machine; ` esc to interrupt` is
//                 a literal string in the 2.1.259 binary and appears only while
//                 a turn is in flight.
//   Codex         `Ask Codex to do anything` is the empty composer,
//                 `gpt-6-astra default · ~ · Main [default]` the footer, and
//                 `• Working (5m 12s • esc to interrupt)` the live status row,
//                 captured off a live Codex pane mid turn. The 0.153.2 binary calls
//                 that text "Compact session run-state text (Ready, Working,
//                 Thinking)" and carries the hint suffix ` to interrupt)`.
//
// A working marker is state and a footer marker is identity, and the two need
// opposite treatment. Both TUIs redraw the status row in place, so it is on the
// pane while the turn runs and gone the moment it ends; the footer is on the
// pane always. Neither, though, can be trusted from anywhere on the capture:
// see SCAN_LINES and QUOTED_LINE below for the two ways a transcript that
// merely QUOTES one of these strings was made to lie about its own session.

// FOOTERS ONLY, and every one of them is TUI chrome rather than prose. `Claude
// Code` and `Worked for` were both markers here until an audit pointed out that
// they are ordinary English: a Codex session that had edited a Claude Code hook
// reported as Claude, and a Claude session whose transcript said "the worker
// Worked for 4 hours" reported as Codex (both reproduced 2026-09-08).
const CLAUDE_MARKERS = [/bypass permissions on/, /shift\+tab to cycle/, /new task\? \/clear to save/];

const CODEX_MARKERS = [
  /Ask Codex to do anything/,
  /\bMain \[[^\]]+\]\s*$/,
  /^\s*(?:gpt|o)[\w.]*(?:-[\w.]+)+\s+\w+\s+·/,
];

const WORKING_MARKERS = [
  /esc to interrupt/i, // Claude Code's spinner suffix
  /to interrupt\)/i, // Codex's spinner suffix
  /^\s*[•▪●*]?\s*(?:Working|Thinking)\b[^\n]*\d\s*[hms]\b/i, // Codex's run-state text
];

/**
 * How far up from the bottom a marker is looked for.
 *
 * `capture-pane -S -80` returns eighty lines of HISTORY plus the whole visible
 * screen: a live Codex pane came back 130 lines long. Searching all of
 * it treats a transcript that quotes a spinner exactly like the spinner, and an
 * idle Claude session that had merely READ this repo's test fixtures reported
 * as "working 1m 12s" (reproduced 2026-09-08). Measured offsets from the bottom
 * on five live sessions: the Codex status row sits at -5, Claude's spinner
 * position at -7 to -10, every engine footer at 0 to -3. Twenty four is that
 * window with room for a taller footer, and it excludes the ~110 lines of
 * history where a quote can live.
 */
export const SCAN_LINES = 24;

// A line that is SHOWING a marker rather than being one: a source line in a
// diff, a test fixture, a grep result. Cheap and targeted at the shape that
// actually bit, which is this repo's own fixtures being read in a peer session.
const QUOTED_LINE = /^\s*['"`]|['"`]\s*[,;]\s*$|^\s*[+-]\s*['"`]/;

// Chrome: true of a line that is the TUI drawing itself rather than saying
// anything. Skipped when hunting for the detail row, because a border rule and
// the permissions footer are exactly what sits directly above a status line and
// neither one tells you what the session is doing.
const CHROME_MARKERS = [
  // A rule, a border, or blank. The em/en dash block (U+2012 to U+2015) is in
  // the class because a peer that draws its rules with them produced a detail
  // row of ", , , , ." once normalizeDashes had had its way with it.
  /^[\s\u2012-\u2015\u2500-\u257f\u2580-\u259f_=~+.*|\-]*$/,
  /bypass permissions on/,
  /new task\? \/clear to save/,
  /shift\+tab to cycle/,
  /%\s*ctx\b/,
  /Ask Codex to do anything/,
  /\bMain \[[^\]]+\]\s*$/,
  /^\s*(?:gpt|o)[\w.]*(?:-[\w.]+)+\s+\w+\s+·/,
  /^\s*[>›❯$#%]\s*$/, // an empty composer
  // A rule, titled or not. Anchored on the OPENING run rather than on both
  // ends, because Claude Code's composer border carries its session title on
  // the right and closes with a single box character: a both-ends pattern let
  // `──────── checkout-redesign ─` through as a detail row, which is
  // what a live pane produced the first time this ran (2026-09-08).
  /^\s*[─-╿]{4,}/,
];

// A detail row is pane text, and pane text is the one place a secret can walk
// into a Telegram message. Biased to hide: over-hiding costs one hint, and
// under-hiding puts a live key in a chat log that syncs to a phone.
const SECRET_MARKERS = [
  // The NAME half. No leading \b, because the word boundary is exactly what
  // made `\btoken\s*=` miss `BOT_TOKEN=`: the underscore before TOKEN is a word
  // character, so there is no boundary there. Colon as well as equals, so the
  // JSON form `"TELEGRAM_BOT_TOKEN": "..."` is caught too. This is the one that
  // matters most: the line above a spinner is routinely a grep for the bridge's
  // OWN bot token out of settings.local.json.
  /(?:token|secret|api[_-]?key|password|passwd|pwd|credential)["']?\s*[:=]\s*["']?\S/i,
  // The VALUE half, for lines that carry a credential with no label.
  // The NAME half again, for the keys nobody named `token` or `secret`. An
  // ALL-CAPS name ending KEY, TOKEN, SECRET or AUTH in front of a value is the
  // shape a `.env` grep and a shell export both have, and the list above misses
  // every one of them whose word is not on it (`SEGMIND_KEY=`, `STRIPE_SK=`).
  /[A-Z0-9_]*(?:KEY|TOKEN|SECRET|AUTH)\s*[:=]\s*\S{8,}/,
  /\bsk-[A-Za-z0-9_-]{6,}/, // OpenAI
  /\bsbp_[A-Za-z0-9_-]{6,}/, // Supabase personal token
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{6,}/, // Supabase project keys, the current format
  /\bAIza[0-9A-Za-z_-]{20,}/, // Google
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/, // Telegram bot
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub
  /\bxox[abpres]-[A-Za-z0-9-]{20,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{15,}/, // a JWT header
  /\bBearer\s+\S/i,
  /\b[0-9a-fA-F]{40,}\b/, // a long hex digest
  /[A-Za-z0-9+/]{40,}={0,2}/, // a long base64 run
];

export const HIDDEN_DETAIL = '(detail hidden)';

const anyMatch = (patterns, line) => patterns.some((re) => re.test(line));

/** True when a pane line would leak something that must not reach Telegram. */
export const looksSecret = (line) => anyMatch(SECRET_MARKERS, String(line ?? ''));

/**
 * Seconds out of the FIRST duration run on a line: "23s", "1m 05s",
 * "1h 48m 18s". A run ends at the first gap or at a unit that is not smaller
 * than the last one, so a footer's `wk 25% 2d10h` cannot glue itself onto an
 * elapsed time from earlier in the same line.
 */
export function parseDuration(line) {
  const text = String(line ?? '');
  const re = /(\d+)\s*([hms])\b/gi;
  const seconds = { h: 3600, m: 60, s: 1 };
  let m;
  let total = 0;
  let seen = 0;
  let rank = 4;
  let end = -1;
  while ((m = re.exec(text))) {
    const unit = m[2].toLowerCase();
    const here = unit === 'h' ? 3 : unit === 'm' ? 2 : 1;
    if (seen) {
      const contiguous = text.slice(end, m.index).trim() === '';
      if (!contiguous || here >= rank) break;
    }
    total += Number(m[1]) * seconds[unit];
    rank = here;
    end = m.index + m[0].length;
    seen++;
  }
  return seen ? total : null;
}

/**
 * A captured pane tail to the four facts the block renders.
 *
 * Pure: hand it a string, get `{ engine, working, elapsed, detail }`. No tmux,
 * no clock, no daemon. That is the whole point, because the interesting cases
 * (a working Codex pane, a secret in the detail row) are the ones that cannot
 * be staged on demand against a live session.
 */
export function parsePaneTail(text) {
  const lines = String(text ?? '').split('\n');
  // BOTTOM UP, and only through the last SCAN_LINES. Both properties are load
  // bearing. Bottom up, because every engine footer is the last thing on the
  // pane, so it beats any transcript above it that happens to quote a marker.
  // Bounded, because eighty lines of scrollback is where a quote lives.
  const floor = Math.max(0, lines.length - SCAN_LINES);
  let engine = 'terminal';
  for (let i = lines.length - 1; i >= floor; i--) {
    if (anyMatch(CODEX_MARKERS, lines[i])) {
      engine = 'codex';
      break;
    }
    if (anyMatch(CLAUDE_MARKERS, lines[i])) {
      engine = 'claude';
      break;
    }
  }
  // The LAST working marker, because a long turn can redraw more than one line
  // and the newest is the one carrying the current elapsed. A line that is
  // QUOTING a marker (a fixture, a diff, a grep hit) is skipped: this repo's own
  // test file, opened in a peer session, otherwise reported that session as
  // working for the elapsed written in the fixture.
  let at = -1;
  for (let i = lines.length - 1; i >= floor; i--) {
    if (QUOTED_LINE.test(lines[i])) continue;
    if (anyMatch(WORKING_MARKERS, lines[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return { engine, working: false, elapsed: null, detail: null };
  const elapsed = parseDuration(lines[at]);
  let detail = null;
  // Bounded upward too: past this there is no line recent enough to describe
  // what the session is doing right now, and a stale one reads as a current one.
  for (let i = at - 1; i >= Math.max(0, at - SCAN_LINES); i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    // SECRET FIRST, chrome second. A line can match both (a key printed on a row
    // the chrome class also recognises), and with the chrome skip in front the
    // hunt walked PAST it to a clean line above rather than stopping: the row
    // came out looking safe by luck of pattern order rather than by rule.
    if (looksSecret(line)) {
      detail = HIDDEN_DETAIL;
      break;
    }
    if (anyMatch(CHROME_MARKERS, line)) continue;
    const text = clip(normalizeDashes(oneLine(line)), DETAIL_MAX);
    // Nothing but punctuation left. A rule drawn out of characters the chrome
    // class does not know about survives normalizeDashes as ", , , ." and is
    // still truthy, so it would cost a row and answer nothing.
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    detail = text;
    break;
  }
  return { engine, working: true, elapsed, detail };
}

/** Working first, then by name. Deterministic: no locale, no tie left open. */
export function sortPeers(rows = []) {
  return [...rows].sort((a, b) => {
    if (Boolean(a.working) !== Boolean(b.working)) return a.working ? -1 : 1;
    const an = String(a.name ?? '');
    const bn = String(b.name ?? '');
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// THE TMUX SIDE
// ---------------------------------------------------------------------------

/** The only subcommands this module may run. Both read, neither writes. */
export const READ_ONLY_TMUX = new Set(['list-sessions', 'capture-pane']);

const TMUX_CANDIDATES = ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/bin/tmux'];

/** The daemon runs under launchd with a short PATH, so the binary is resolved here. */
export function resolveTmux() {
  for (const p of TMUX_CANDIDATES) if (existsSync(p)) return p;
  return 'tmux';
}

const runTmux = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 << 20, killSignal: 'SIGKILL' }, (err, stdout) =>
      resolve(err ? null : String(stdout)),
    );
  });

/**
 * The guard. Every tmux call in this module goes through here, and a subcommand
 * that is not on READ_ONLY_TMUX throws rather than running: a typo turning a
 * capture into a write would otherwise reach a session the owner is using.
 */
export function tmux(args, { bin = resolveTmux(), timeoutMs = TMUX_TIMEOUT_MS, run = runTmux } = {}) {
  const sub = String(args?.[0] ?? '');
  if (!READ_ONLY_TMUX.has(sub)) throw new Error(`peers: refusing a tmux subcommand that is not read only: ${sub}`);
  return run(bin, args, timeoutMs);
}

/**
 * One row per session.
 *
 * The separator is a DOUBLE COLON rather than a tab: tmux 3.7b renders a tab
 * inside a format string as an underscore, so a tab-separated format comes back
 * as one unsplittable field and every session reads as an unknown terminal
 * (measured 2026-09-08, before this comment existed). A colon
 * cannot appear in a tmux session name, so `::` can never be ambiguous.
 */
export const LIST_SEP = '::';
export const LIST_FORMAT = ['#{session_name}', '#{session_created}', '#{session_attached}', '#{session_activity}'].join(
  LIST_SEP,
);

/** Parse the session list output. Null, empty or junk all yield []. */
export function parseSessionList(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, created, attached, activity] = line.split(LIST_SEP);
      return {
        name: String(name ?? '').trim(),
        createdAt: Number(created) * 1000 || null,
        attached: attached === '1',
        activityAt: Number(activity) * 1000 || null,
      };
    })
    .filter((s) => s.name);
}

/**
 * The whole read: sessions, then their panes, then the rows the block wants.
 *
 * The capture target is `=name:`, which is the CURRENT WINDOW of an EXACT
 * session. Without the leading `=` tmux prefix matches, and a target of
 * `api` lands in `api-3` when only that one exists, which would report one
 * session's state under another's name.
 *
 * Returns [] for every failure there is, including tmux not being installed:
 * the block is omitted rather than rendering an error into a liveness view.
 */
export async function readPeers({
  bin = resolveTmux(),
  timeoutMs = TMUX_TIMEOUT_MS,
  run = runTmux,
  captureMax = PEER_CAPTURE_MAX,
  tailLines = PANE_TAIL_LINES,
} = {}) {
  const opts = { bin, timeoutMs, run };
  const listed = await tmux(['list-sessions', '-F', LIST_FORMAT], opts);
  const sessions = parseSessionList(listed);
  if (!sessions.length) return [];
  const byName = [...sessions].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const read = byName.slice(0, captureMax);
  // In parallel, so the read is ONE timeout wide. Sequentially, sixteen wedged
  // panes would be forty eight seconds of /status not answering.
  const panes = await Promise.all(
    read.map((s) => tmux(['capture-pane', '-t', `=${s.name}:`, '-p', '-S', `-${tailLines}`], opts)),
  );
  const parsed = new Map(read.map((s, i) => [s.name, { ...parsePaneTail(panes[i] ?? ''), read: true }]));
  return byName.map((s) => ({
    name: s.name,
    attached: s.attached,
    // `read: false` for a session past the capture cap. Its pane was never
    // looked at, so it is UNKNOWN rather than idle: rendering the idle shape
    // over a session that may be mid-turn is a smaller version of the bug this
    // whole block exists to fix.
    ...(parsed.get(s.name) ?? { engine: 'terminal', working: false, elapsed: null, detail: null, read: false }),
  }));
}

/** Clip a session name to one scannable token. Exported for the block's tests. */
export const peerName = (name) => clip(oneLine(name), NAME_MAX);
