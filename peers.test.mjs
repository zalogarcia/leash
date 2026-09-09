#!/usr/bin/env node
// Tests for the Peers block: the terminal sessions on this machine that the
// daemon did not spawn.
//
//   node peers.test.mjs
//
// Two things are being protected here, and only one of them is the rendering.
//
// The rendering half is ordinary: a pane tail in, four facts out, a block in
// the house style. The fixtures are real. Every pane below was captured off a
// live session on 2026-09-08 with `capture-pane -p`: the three idle ones and
// the working Codex status row verbatim, and the working Claude spinner row
// built from the literal ` esc to interrupt` that ships inside claude 2.1.259.
// Nothing here was invented from memory, because a marker that does not match
// the real TUI produces a block that says "idle" over a session that is not,
// and the first draft's guessed Codex row (`· Esc to interrupt)`) was exactly
// that: a fixture the parser accepted and the real TUI never writes.
//
// The other half is the SAFETY property, and it is the one worth a suite of its
// own: this feature reads other people's sessions. Peer sessions belong to
// whoever is typing in them, so the module may only ever read, and pane text is
// untrusted input that ends up in a Telegram message. The tests below hold
// three lines: no tmux verb that writes, no unbounded pane text, and no secret
// in a detail row.

import {
  parsePaneTail,
  parseDuration,
  parseSessionList,
  sortPeers,
  looksSecret,
  tmux,
  readPeers,
  resolveTmux,
  LIST_FORMAT,
  LIST_SEP,
  READ_ONLY_TMUX,
  HIDDEN_DETAIL,
  DETAIL_MAX,
  PEER_MAX,
  PEER_CAPTURE_MAX,
  TMUX_TIMEOUT_MS,
  PANE_TAIL_LINES,
  SCAN_LINES,
} from './peers.mjs';
import { peersBlock, PEER_HEAD_MAX, PEERS_BLOCK_MAX, STATUS_INDENT } from './system-messages.mjs';
import { readFileSync, existsSync } from 'node:fs';

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
const at = (name, fn) => {
  // An async test still has to be awaited, so these are collected and run at the
  // end rather than fired and forgotten: a rejected promise nobody waited on is
  // a test that passes by not existing.
  asyncTests.push([name, fn]);
};
const asyncTests = [];
const eq = (got, want, msg = '') => {
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------------------
// The house-style gates. Local copies rather than an import, because importing
// system-messages.test.mjs would RUN that suite and double-count it here; this
// is the idiom bg-notify.test.mjs already uses for the same reason.
// ---------------------------------------------------------------------------

const LINE_MAX = 44;

const noDashes = (str, where) => {
  const hits = String(str).match(/[\u2013\u2014]/g);
  if (hits) throw new Error(`${where}: ${hits.length} em/en dash(es) in\n${str}`);
};

// The head row is the one bounded exemption, for the reason PEER_HEAD_MAX
// documents. Every continuation row still has to fit the bubble, except a
// detail row, which is a clipped quote of a peer's own text and is exempt on the
// same grounds the worker card's quoted title is.
const linesFit = (str, where) => {
  for (const line of String(str).split('\n')) {
    const isDetail = line.startsWith(`${STATUS_INDENT}↳ `);
    const max = isDetail ? STATUS_INDENT.length + 2 + DETAIL_MAX : line.startsWith('🖥') ? PEER_HEAD_MAX : LINE_MAX;
    if (line.length <= max) continue;
    throw new Error(`${where}: line of ${line.length} chars (max ${max})\n  ${line}`);
  }
};

// One fact per line: a row answers "which session" and "what is it doing", and
// the middle dot is the only thing allowed to join them. A comma or a semicolon
// joining two facts is the shape this house style exists to stop.
const oneFactPerLine = (str, where) => {
  for (const line of String(str).split('\n')) {
    if (!line.startsWith('🖥')) continue;
    ok(!/[;]/.test(line), `${where}: a semicolon joins two facts in\n  ${line}`);
    const parts = line.split(' · ');
    ok(parts.length <= 3, `${where}: ${parts.length} facts on one row in\n  ${line}`);
  }
};

// The daemon's own footers never carry a token count or a model name. Applied
// to blocks built from clean rows only: a peer's prose is data, and banning the
// word "opus" inside a quote of what someone else typed would be a gate on the
// wrong thing.
const noTokensOrModels = (str, where) => {
  if (/\b\d[\d,.]*\s*(?:tokens?|tok|k tokens)\b/i.test(str)) throw new Error(`${where}: token count in\n${str}`);
  if (/\b(?:opus|sonnet|haiku|fable|gpt-[\d.]+)\b/i.test(str)) throw new Error(`${where}: model name in\n${str}`);
};

const houseStyle = (str, where) => {
  noDashes(str, where);
  linesFit(str, where);
  oneFactPerLine(str, where);
};

// ---------------------------------------------------------------------------
// THE FIXTURES
// ---------------------------------------------------------------------------

// Verbatim tail of a live Codex session, 2026-09-08 17:30, idle.
const CODEX_IDLE = [
  '  Batch (docs/outreach/batch-2026-09-08.md)',
  '',
  '─ Worked for 46m 12s ────────────────────────',
  '',
  '',
  '› Ask Codex to do anything',
  '',
  '  gpt-6-astra default · ~ · Main [default]',
].join('\n');

// The same session with a turn in flight, captured mid turn at 18:02 ET the
// same day. The status row is verbatim, bullet separator and lowercase esc and
// all: the first version of this fixture GUESSED `· Esc to interrupt)` from the
// binary's strings, which the parser accepts and the real TUI does not write.
const CODEX_WORKING = [
  '• Reading the pricing page to confirm the plan names.',
  '',
  '  the pricing page, footer navigation',
  '• Working (40m 07s • esc to interrupt)',
  '',
  '› Ask Codex to do anything',
  '',
  '  gpt-6-astra default · ~ · Main [default]',
].join('\n');

// Verbatim tail of a live Claude Code session, 2026-09-08 17:30, idle.
const CLAUDE_IDLE = [
  '  The guarantee line in the PDF still says "N per month" on purpose.',
  '',
  '✻ Cooked for 2m 47s · done 8:35 PM',
  '',
  '                          new task? /clear to save 356.4k tokens',
  '─────────────────── checkout-redesign ─',
  '❯ ',
  '────────────────────────────────────',
  '  Fable 5.1 (xhigh) · 35% ctx',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 agent',
].join('\n');

// The same session mid-turn. Footer verbatim; the spinner row carries claude
// 2.1.259's literal ` esc to interrupt`.
const CLAUDE_WORKING = [
  '⏺ Read(src/status.ts)',
  '  └ Read 214 lines',
  '',
  '  Wiring the peers block into the status renderer',
  '✻ Cooking… (1m 12s · ↑ 1.4k tokens · esc to interrupt)',
  '────────────────────────────────────',
  '  Fable 5.1 (xhigh) · 35% ctx',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

// A plain login shell. Neither engine, nothing running.
const PLAIN_SHELL = ['user@this-mac ~ % ls', 'Documents  Downloads  dev', 'user@this-mac ~ % '].join('\n');

// ---------------------------------------------------------------------------
// parsePaneTail: the five pane shapes
// ---------------------------------------------------------------------------

t('pane: a working Codex session reports the engine, the state and the elapsed', () => {
  const p = parsePaneTail(CODEX_WORKING);
  eq(p.engine, 'codex', 'the model footer and the composer both name Codex');
  eq(p.working, true, 'a run-state row with an elapsed is a turn in flight');
  eq(p.elapsed, 40 * 60 + 7, '40m 07s');
  eq(p.detail, 'the pricing page, footer navigation', 'the last real line above the status row');
});

t('pane: an idle Codex session is idle, with no detail row at all', () => {
  const p = parsePaneTail(CODEX_IDLE);
  eq(p.engine, 'codex');
  eq(p.working, false, '"Worked for" is what a FINISHED turn leaves behind');
  eq(p.elapsed, null, 'a finished turn has no elapsed to report');
  eq(p.detail, null, 'on an idle pane the line above the prompt is history, not state');
});

t('pane: a working Claude Code session, off the real footer plus the real spinner', () => {
  const p = parsePaneTail(CLAUDE_WORKING);
  eq(p.engine, 'claude');
  eq(p.working, true);
  eq(p.elapsed, 72, '1m 12s, and the 1.4k token count is not a duration');
  eq(p.detail, 'Wiring the peers block into the status renderer');
});

t('pane: an idle Claude Code session', () => {
  const p = parsePaneTail(CLAUDE_IDLE);
  eq(p.engine, 'claude');
  eq(p.working, false, 'the permissions footer is on the pane always; it says engine, never state');
  eq(p.detail, null);
});

t('pane: a plain shell is a terminal, not a guess at an engine', () => {
  const p = parsePaneTail(PLAIN_SHELL);
  eq(p.engine, 'terminal');
  eq(p.working, false);
});

t('pane: an empty capture is idle and unknown rather than a crash', () => {
  for (const input of ['', null, undefined]) {
    const p = parsePaneTail(input);
    eq(p.engine, 'terminal', String(input));
    eq(p.working, false, String(input));
  }
});

t('pane: chrome is never the detail row', () => {
  // The line directly above a Claude spinner is frequently a border rule or the
  // permissions footer. A block whose detail row reads as a row of box-drawing
  // characters costs a line and answers nothing.
  const tail = [
    '  the real last thing it said',
    '────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    '✻ Cooking… (8s · esc to interrupt)',
  ].join('\n');
  eq(parsePaneTail(tail).detail, 'the real last thing it said');
});

// ---------------------------------------------------------------------------
// What a pane SHOWS versus what a pane IS. Three reproductions from the audit
// of the first draft, all of the same shape: a transcript quoting a marker was
// read as the marker.
// ---------------------------------------------------------------------------

t('pane: a Claude session reading THIS FILE is not a working Codex session', () => {
  // Verbatim reproduction. The first draft scanned the whole capture top down,
  // so the fixture strings a peer had opened in an editor won on both counts:
  // engine "codex", working true, elapsed 72, all of it out of a quoted line.
  const tail = [
    '⏺ Read(peers.test.mjs)',
    "  '› Ask Codex to do anything',",
    "  '✻ Cooking… (1m 12s · ↑ 1.4k tokens · esc to interrupt)',",
    '────────────────────────────────────',
    '  Fable 5.1 (xhigh) · 35% ctx',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
  const p = parsePaneTail(tail);
  eq(p.engine, 'claude', 'the footer at the bottom of the pane is what the session IS');
  eq(p.working, false, 'a quoted spinner is not a spinner');
});

t('pane: a Codex session that edited a Claude Code hook is still Codex', () => {
  const tail = [
    '• Updated the Claude Code hook in ~/.claude/hooks/session-guard.py',
    '',
    '› Ask Codex to do anything',
    '',
    '  gpt-6-astra default · ~ · Main [default]',
  ].join('\n');
  eq(parsePaneTail(tail).engine, 'codex');
});

t('pane: a spinner far up the scrollback is history, not state', () => {
  // capture-pane -S -80 returns 80 history lines PLUS the visible screen; the
  // live Codex pane came back 130 lines. Only the last SCAN_LINES count.
  const tail = [
    '✻ Cooking… (9m 30s · esc to interrupt)',
    ...Array.from({ length: SCAN_LINES + 5 }, (_, i) => `  scrolled past line ${i}`),
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
  eq(parsePaneTail(tail).working, false, `a marker more than ${SCAN_LINES} lines up is scrollback`);
});

t('pane: the real markers still win from where they really sit', () => {
  // The measured offsets from the bottom of a live pane: Codex's status row at
  // -5, Claude's spinner position at -7 to -10, every footer at 0 to -3. If
  // SCAN_LINES were ever tightened past those, this fails.
  eq(parsePaneTail(CODEX_WORKING).working, true);
  eq(parsePaneTail(CLAUDE_WORKING).working, true);
  ok(SCAN_LINES >= 12, `${SCAN_LINES} is under the measured spinner depth`);
});

t('pane: a TITLED rule is chrome too, which a both-ends pattern got wrong', () => {
  // Verbatim off a live Claude Code pane: its composer border
  // carries the session title on the right and closes with ONE box character,
  // so a pattern anchored on both ends let the whole rule through as a detail
  // row (measured 2026-09-08, before this test existed).
  const tail = [
    '  the real last thing it said',
    '',
    `${'─'.repeat(60)} checkout-redesign ─`,
    '❯ ',
    '─'.repeat(62),
    '  Fable 5.1 (xhigh) · 35% ctx',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    '✻ Cooking… (8s · esc to interrupt)',
  ].join('\n');
  eq(parsePaneTail(tail).detail, 'the real last thing it said');
});

t('pane: the detail row never carries an em or en dash out of a peer', () => {
  // Claude writes em dashes and Codex writes them constantly. The block is the
  // daemon's own message, so the dash is normalized at the boundary rather than
  // left to an outbound normalizer a public install starts with turned OFF.
  const tail = [
    `  the link ${'\u2014'} the published one ${'\u2013'} is gone`,
    '✻ Cooking… (8s · esc to interrupt)',
  ].join('\n');
  const p = parsePaneTail(tail);
  noDashes(p.detail, 'parsePaneTail detail');
  ok(p.detail.includes('the link'), p.detail);
});

t('pane: a rule drawn out of em dashes is chrome, not a detail of ", , , ."', () => {
  // normalizeDashes turns each dash into a comma, so a 40-dash rule survived as
  // a truthy string of punctuation and rendered as its own row.
  const tail = [
    '  the real last thing it said',
    `  ${'\u2014'.repeat(40)}`,
    '✻ Cooking… (8s · esc to interrupt)',
  ].join('\n');
  eq(parsePaneTail(tail).detail, 'the real last thing it said');
});

t('pane: a detail row is clipped, so a 4,000-character pane line cannot be the message', () => {
  const tail = [`  ${'x'.repeat(4000)}`, '✻ Cooking… (8s · esc to interrupt)'].join('\n');
  const p = parsePaneTail(tail);
  ok(p.detail.length <= DETAIL_MAX, `${p.detail.length} chars, cap ${DETAIL_MAX}`);
});

// ---------------------------------------------------------------------------
// Secrets: the one way pane text turns into an incident
// ---------------------------------------------------------------------------

// Every credential below is INVENTED, and each line carries `gitleaks:allow`
// because the repo's pre-commit guard is right to flag credential-shaped text
// and this is the one file whose job is to contain some. A redaction test with
// no credential in it tests nothing.
t('secret: the shapes that must never reach a chat log', () => {
  const leaks = [
    '  export OPENAI_API_KEY=sk-proj-9f2ab7d41c8e5006bb', // gitleaks:allow
    '  SUPABASE_SECRET=' + ['sbp_', '1f9c77aa41b3d8e0cc51'].join(''), // gitleaks:allow
    '  curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9"', // gitleaks:allow
    '  https://api.example.com/v1/thing?token=abcd1234efgh', // gitleaks:allow
    `  digest ${'a'.repeat(40)}`,
    `  blob ${'QWxhZGRpbjpvcGVuIHNlc2FtZQ'.repeat(2)}`,
    // Added after an audit found the first six caught only the OpenAI and
    // Supabase shapes. The first line is the one that mattered: the daemon's
    // OWN bot token, and a session grepping settings.local.json for it is a
    // documented routine step, so this was a live path from a peer's pane to a
    // chat log that syncs to a phone.
    '  "TELEGRAM_BOT_TOKEN": "8261234567:AAHk3xL9vQ2mN8pR4sT6uW1yZ3bC5dE7fG9hJ"', // gitleaks:allow
    '  export TELEGRAM_BOT_TOKEN=8261234567:AAHk3xL9vQ2mN8pR4sT6uW1yZ3bC5dE7fG9hJ', // gitleaks:allow
    '  export API_TOKEN=abc123def456', // gitleaks:allow
    '  GITHUB_TOKEN=' + ['ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join(''), // gitleaks:allow
    '  SLACK=' + ['xoxb-', '1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'].join(''), // gitleaks:allow
    '  AWS_ACCESS_KEY_ID=' + ['AKIA', 'IOSFODNN7EXAMPLE'].join(''), // gitleaks:allow
    '  PASSWORD=hunter2-really-long-password', // gitleaks:allow
    '  { "apiKey": "9f2ab7d41c8e" }', // gitleaks:allow
  ];
  for (const l of leaks) ok(looksSecret(l), `not caught: ${l}`);
});

t('secret: the whole pane path, not just the predicate', () => {
  // The predicate is only half of it: the detail hunt has to STOP on the secret
  // line rather than skipping past it to a clean one, or the row is clean and
  // the reader has no idea a key was there.
  const tail = [
    '  the previous, harmless line',
    '  "TELEGRAM_BOT_TOKEN": "8261234567:AAHk3xL9vQ2mN8pR4sT6uW1yZ3bC5dE7fG9hJ"', // gitleaks:allow
    '✻ Cooking… (8s · esc to interrupt)',
  ].join('\n');
  const p = parsePaneTail(tail);
  eq(p.detail, HIDDEN_DETAIL);
  const block = peersBlock([{ name: 'bare', engine: 'claude', working: true, elapsed: 8, detail: p.detail }]);
  ok(!/8261234567|AAHk/.test(block), block);
});

t('secret: ordinary prose is not a secret', () => {
  for (const l of ['  the pricing page, footer navigation', '  running npm test in the api repo', '  8 of 12 done']) {
    ok(!looksSecret(l), `false positive: ${l}`);
  }
});

t('secret: a key on the line above the spinner is replaced, not clipped', () => {
  const tail = [
    '  export OPENAI_API_KEY=sk-proj-9f2ab7d41c8e5006bb', // gitleaks:allow
    '• Working (12s · Esc to interrupt)',
  ].join('\n');
  const p = parsePaneTail(tail);
  eq(p.detail, HIDDEN_DETAIL, 'a clipped secret is still a secret');
  ok(!p.detail.includes('sk-'), 'and none of it survives into the block');
  const block = peersBlock([{ name: 'x', engine: 'codex', working: true, elapsed: 12, detail: p.detail }]);
  ok(!/sk-/.test(block), block);
});

t('secret: the shapes an audit found missing, each one live on this class of machine', () => {
  // Every one of these reached a rendered detail row before the patterns below
  // existed: the current Supabase key format (only the older personal-token
  // prefix was listed), a Google key, and any ALL-CAPS name ending KEY/TOKEN/
  // SECRET/AUTH whose word was not on the name list.
  const missed = [
    '  SUPABASE_KEY -> ' + ['sb_secret_', '9fK2mQx7Lz'].join(''), // gitleaks:allow
    '  anon: sb_publishable_1a2b3c4d5e6f', // gitleaks:allow
    '  ' + ['AIza', 'SyD-1234567890abcdefghijklmnopqrstu'].join(''), // gitleaks:allow
    '  export SEGMIND_KEY=SG_1a2b3c4d5e6f7g8h', // gitleaks:allow
    '  SERVICE_AUTH=a1b2c3d4e5f6g7h8i9j0', // gitleaks:allow
  ];
  for (const l of missed) ok(looksSecret(l), `not caught: ${l}`);
  for (const l of missed) {
    const tail = [l, '• Working (5m 12s · esc to interrupt)'].join('\n');
    eq(parsePaneTail(tail).detail, HIDDEN_DETAIL, `it reached the detail row: ${l}`);
  }
});

t('secret: a line that is ALSO chrome is still replaced, not skipped past', () => {
  // The chrome skip used to run first, so a secret printed on a row the chrome
  // class recognises was walked past to a clean line above it: the row came out
  // safe by luck of pattern order rather than by rule.
  const tail = [
    '  the clean line above it',
    '  export OPENAI_API_KEY=sk-proj-9f2ab7d41c8e5006bb · Main [default]', // gitleaks:allow
    '✻ Cooking… (8s · esc to interrupt)',
  ].join('\n');
  const p = parsePaneTail(tail);
  eq(p.detail, HIDDEN_DETAIL, 'the hunt skipped the secret and reported the line above it');
  ok(!peersBlock([{ name: 'x', engine: 'claude', working: true, elapsed: 8, detail: p.detail }]).includes('sk-'));
});

t('block: a session whose pane was never read says so, rather than claiming idle', () => {
  // Past PEER_CAPTURE_MAX the pane is not captured at all, and the fallback row
  // used to be indistinguishable from a genuinely idle shell. "idle" over a
  // session that may be mid-turn is the bug this block exists to fix, smaller.
  const s = peersBlock([
    { name: 'read-one', engine: 'codex', working: true, elapsed: 30, detail: 'a real line', read: true },
    { name: 'never-read', engine: 'terminal', working: false, elapsed: null, detail: null, read: false },
  ]);
  ok(s.includes('🖥 never-read · not read'), s);
  ok(!s.includes('never-read · idle'), s);
  ok(s.includes('🖥 read-one · working 30s · Codex'), 'a captured row is unchanged');
  houseStyle(s, 'peersBlock unread');
  // A row with no `read` field at all keeps the old shape, so nothing that
  // builds rows by hand changes meaning.
  eq(peersBlock([{ name: 'y', engine: 'claude', working: false }]), '🖥 y · idle · Claude');
});

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

t('duration: the first run on the line, in seconds', () => {
  eq(parseDuration('✻ Cooking… (23s · ↑ 1.4k tokens · esc to interrupt)'), 23);
  eq(parseDuration('• Working (1m 05s · Esc to interrupt)'), 65);
  eq(parseDuration('─ Worked for 1h 48m 18s ─'), 6498);
  eq(parseDuration('esc to interrupt'), null, 'no duration is null, never zero');
});

t('duration: a second run on the same line does not glue itself to the first', () => {
  // The Claude footer carries `5h 8% 4h48m` on an account with two windows. If
  // a status row ever picked that up, a 12-second turn would render as hours.
  eq(parseDuration('• Working (12s) · wk 25% 2h10m'), 12);
});

// ---------------------------------------------------------------------------
// The session list
// ---------------------------------------------------------------------------

t('list: the format uses a separator tmux does not eat', () => {
  ok(!LIST_FORMAT.includes('\t'), 'tmux 3.7b renders a tab in a format string as an underscore');
  eq(LIST_SEP, '::', 'a colon cannot appear in a tmux session name, so :: is unambiguous');
  eq(LIST_FORMAT.split(LIST_SEP).length, 4);
});

t('list: rows in, sessions out', () => {
  const rows = parseSessionList(['bare::1788361509::0::1788822788', 'codex-shell::1788562288::1::1788565519'].join('\n'));
  eq(rows.length, 2);
  eq(rows[0].name, 'bare');
  eq(rows[1].attached, true);
});

t('list: no tmux server, no tmux installed, junk output, all give nothing', () => {
  for (const input of [null, undefined, '', '   \n  \n', 'no server running on /tmp/tmux-501/default']) {
    const rows = parseSessionList(input);
    ok(Array.isArray(rows), String(input));
    // The one junk line has no separator, so it parses as a single name; what
    // matters is that nothing throws and the caller can render nothing.
    ok(rows.length <= 1, JSON.stringify(rows));
  }
  eq(parseSessionList('').length, 0);
});

// ---------------------------------------------------------------------------
// READ ONLY, mechanically
// ---------------------------------------------------------------------------

t('tmux guard: only list-sessions and capture-pane are allowed through', () => {
  eq([...READ_ONLY_TMUX].sort().join(','), 'capture-pane,list-sessions');
});

t('tmux guard: every write verb is refused rather than run', () => {
  const writes = [
    'send-keys',
    'kill-session',
    'kill-server',
    'kill-pane',
    'new-session',
    'new-window',
    'split-window',
    'paste-buffer',
    'pipe-pane',
    'set-option',
    'rename-session',
    'respawn-pane',
  ];
  for (const verb of writes) {
    let threw = false;
    try {
      tmux([verb, '-t', 'some-session'], { run: () => Promise.resolve('') });
    } catch (e) {
      threw = /read only/.test(e.message);
    }
    ok(threw, `${verb} was not refused`);
  }
});

t('tmux guard: the source contains no write verb at all', () => {
  // Belt and braces. The guard covers what goes THROUGH tmux(); this covers a
  // future edit that shells out around it.
  const src = readFileSync(new URL('./peers.mjs', import.meta.url), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
    .join('\n');
  for (const verb of ['send-keys', 'kill-session', 'kill-server', 'new-session', 'paste-buffer', 'pipe-pane', 'set-option', 'rename-session', 'split-window', 'new-window']) {
    ok(!code.includes(verb), `peers.mjs contains the write verb ${verb}`);
  }
});

at('read: the exact-match target, the tail bound and the per-call timeout', async () => {
  const calls = [];
  const run = (bin, args, timeoutMs) => {
    calls.push({ bin, args, timeoutMs });
    if (args[0] === 'list-sessions') return Promise.resolve('dashboard::1::0::2\ncodex-shell::1::0::2\n');
    return Promise.resolve(args[2] === '=codex-shell:' ? CODEX_WORKING : CLAUDE_IDLE);
  };
  const rows = await readPeers({ bin: 'tmux', run });
  eq(calls.length, 3, 'one list plus one capture per session');
  for (const c of calls) eq(c.timeoutMs, TMUX_TIMEOUT_MS, 'every call is deadlined');
  const captures = calls.filter((c) => c.args[0] === 'capture-pane');
  for (const c of captures) {
    ok(c.args[2].startsWith('='), `prefix matching would read the wrong session: ${c.args[2]}`);
    ok(c.args[2].endsWith(':'), `the target is the session's current window: ${c.args[2]}`);
    eq(c.args[4], '-S', 'the capture asks for a history window');
    eq(c.args[5], `-${PANE_TAIL_LINES}`, 'and the window is bounded');
  }
  eq(rows.length, 2);
  eq(rows.find((r) => r.name === 'codex-shell').working, true);
  eq(rows.find((r) => r.name === 'dashboard').working, false);
});

at('read: no tmux server, and tmux not installed, both give no peers', async () => {
  eq((await readPeers({ bin: 'tmux', run: () => Promise.resolve('') })).length, 0, 'no server');
  eq((await readPeers({ bin: 'tmux', run: () => Promise.resolve(null) })).length, 0, 'execFile errored');
});

at('read: a pane that never answers costs its own row, not the block', async () => {
  const run = (bin, args) =>
    args[0] === 'list-sessions' ? Promise.resolve('a::1::0::2\nb::1::0::2\n') : Promise.resolve(args[2] === '=a:' ? null : CODEX_IDLE);
  const rows = await readPeers({ bin: 'tmux', run });
  eq(rows.length, 2);
  eq(rows.find((r) => r.name === 'a').engine, 'terminal', 'a dead capture is unknown, not missing');
  eq(rows.find((r) => r.name === 'b').engine, 'codex');
});

at('read: past PEER_CAPTURE_MAX a session is listed unread rather than read', async () => {
  const names = Array.from({ length: PEER_CAPTURE_MAX + 4 }, (_, i) => `s${String(i).padStart(2, '0')}`);
  let captures = 0;
  const run = (bin, args) => {
    if (args[0] === 'list-sessions') return Promise.resolve(names.map((n) => `${n}::1::0::2`).join('\n'));
    captures++;
    return Promise.resolve(CODEX_IDLE);
  };
  const rows = await readPeers({ bin: 'tmux', run });
  eq(rows.length, names.length, 'every session is still listed');
  eq(captures, PEER_CAPTURE_MAX, 'the work is bounded, not the list');
  // And the ones that were not read SAY they were not read. Without the flag
  // the fallback row is the idle shape, which is a positive claim about a
  // session nothing looked at.
  eq(rows.filter((r) => r.read === false).length, 4, JSON.stringify(rows.map((r) => [r.name, r.read])));
  eq(rows.filter((r) => r.read === true).length, PEER_CAPTURE_MAX);
  ok(peersBlock(rows, { max: names.length }).includes(`🖥 ${names[names.length - 1]} · not read`));
});

t('read: the binary is resolved by path, since launchd hands over a short PATH', () => {
  // `/tmux$/` alone would also pass on the bare-name fallback, which is the one
  // case the resolver exists to avoid, so this asserts an ABSOLUTE path on a
  // machine that has it and the documented fallback on one that does not.
  const bin = resolveTmux();
  const installed = ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/bin/tmux'].some((p) => existsSync(p));
  if (installed) ok(bin.startsWith('/'), `launchd's PATH will not find ${bin}`);
  else eq(bin, 'tmux', 'with no candidate on disk the bare name is the documented fallback');
});

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

const ROWS = [
  { name: 'codex-shell', engine: 'codex', working: true, elapsed: 2400, detail: 'the pricing page, footer navigation' },
  { name: 'dashboard', engine: 'claude', working: false, elapsed: null, detail: null },
  { name: 'notes-2', engine: 'claude', working: false, elapsed: null, detail: null },
];

t('block: exactly the shape the brief specifies', () => {
  eq(
    peersBlock(ROWS),
    [
      '🖥 codex-shell · working 40m · Codex',
      '   ↳ the pricing page, footer navigation',
      '🖥 dashboard · idle · Claude',
      '🖥 notes-2 · idle · Claude',
    ].join('\n'),
  );
});

t('block: no tmux, no peers, no block', () => {
  eq(peersBlock([]), '', 'a "no peers" line would be noise on every /status forever');
  eq(peersBlock(null), '');
  eq(peersBlock([{ name: '' }]), '', 'a nameless row is not a session');
});

t('block: the house style gates', () => {
  houseStyle(peersBlock(ROWS), 'peersBlock');
  noTokensOrModels(peersBlock(ROWS), 'peersBlock');
  ok(!peersBlock(ROWS).includes('**'), 'the emoji is the marker; bold on top of it is two markers for one job');
  ok(!peersBlock(ROWS).includes('<b>'));
});

t('block: the middle dot is the only separator, on every row shape there is', () => {
  const every = peersBlock([
    ...ROWS,
    { name: 'a-shell', engine: 'terminal', working: false },
    { name: 'busy-no-detail', engine: 'claude', working: true, elapsed: 8, detail: null },
    { name: 'busy-no-elapsed', engine: 'codex', working: true, elapsed: null, detail: 'reading the pane' },
  ]);
  houseStyle(every, 'peersBlock every shape');
  ok(every.includes('🖥 busy-no-elapsed · working · Codex'), 'a missing elapsed costs the number, not the row');
  ok(every.includes('🖥 a-shell · idle · terminal'), 'an unknown engine still gets a label');
  ok(!/↳\s*$/m.test(every), 'a detail arrow with nothing after it costs a line and answers nothing');
});

t('block: an idle row never carries a detail, even when one is passed', () => {
  const s = peersBlock([{ name: 'x', engine: 'claude', working: false, detail: 'stale history' }]);
  ok(!s.includes('stale history'), s);
  eq(s, '🖥 x · idle · Claude');
});

t('block: working first, then by name', () => {
  const rows = [
    { name: 'zeta', engine: 'claude', working: false },
    { name: 'alpha', engine: 'claude', working: false },
    { name: 'yankee', engine: 'codex', working: true, elapsed: 60 },
    { name: 'bravo', engine: 'codex', working: true, elapsed: 30 },
  ];
  const names = peersBlock(sortPeers(rows))
    .split('\n')
    .map((l) => l.split(' · ')[0].replace('🖥 ', ''));
  eq(names.join(','), 'bravo,yankee,alpha,zeta');
});

t('block: thirteen sessions render twelve and COUNT the rest', () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({
    name: `sess-${String(i).padStart(2, '0')}`,
    engine: 'claude',
    working: false,
  }));
  const s = peersBlock(rows);
  const listed = s.split('\n').filter((l) => /^🖥 sess-/.test(l));
  eq(listed.length, PEER_MAX, 'twelve rows');
  ok(s.endsWith('🖥 1 more session'), `a silent drop is the bug that started this:\n${s}`);
  houseStyle(s, 'peersBlock overflow');
});

t('block: the overflow line agrees with itself on plurals', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ name: `s${i}`, engine: 'claude', working: false }));
  ok(peersBlock(rows).endsWith('🖥 3 more sessions'), peersBlock(rows));
});

t('block: the worst case a caller can build still fits its budget', () => {
  // Twelve sessions, every name at the clip, every one working with a long
  // elapsed and a full-width detail. /status's header and lanes run to roughly
  // 700 characters, and Telegram's cap is 4,096.
  const rows = Array.from({ length: 13 }, (_, i) => ({
    name: `${'n'.repeat(30)}${i}`,
    engine: 'codex',
    working: true,
    elapsed: 400 * 3600 + 59 * 60,
    detail: 'd'.repeat(400),
  }));
  const s = peersBlock(rows);
  ok(s.length <= PEERS_BLOCK_MAX, `${s.length} chars, budget ${PEERS_BLOCK_MAX}`);
  ok(s.length + 900 < 4000, `${s.length} chars leaves no room for the lanes above it`);
  linesFit(s, 'peersBlock worst case');
});

t('block: a session named after a lane is still a peer, never merged into one', () => {
  // You might run an interactive session called `bg2` in the same week the
  // daemon spawns a lane called `bg2`. They are two different things and the
  // block that hides one of them is the block that started this.
  const s = peersBlock([{ name: 'bg2', engine: 'claude', working: true, elapsed: 30, detail: 'a real terminal' }]);
  ok(s.includes('🖥 bg2 · working 30s · Claude'), s);
});

// ---------------------------------------------------------------------------
// The wiring. Existence is not implementation: the block above is worth nothing
// if /status never calls it, and the cost rule is worth nothing if a poll does.
// ---------------------------------------------------------------------------

const BRIDGE = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');

t('wiring: /status renders the block, and it is the last thing in the message', () => {
  const arm = BRIDGE.match(/case '\/status': \{[\s\S]*?\n    \}/);
  ok(arm, 'the /status arm moved; this guard needs re-pointing');
  ok(/readPeers\(\)/.test(arm[0]), '/status never reads the peers');
  ok(/peersBlock\(sortPeers\(/.test(arm[0]), '/status never renders them');
  const body = arm[0];
  const peersAt = body.indexOf('...(peers ?');
  const lanesAt = body.lastIndexOf('idleLaneLine({ lane: ');
  ok(peersAt > lanesAt && lanesAt > 0, 'the peers block belongs after the lanes, not among them');
});

t('wiring: the read is deadlined, so a wedged tmux server cannot hang /status', () => {
  ok(/withDeadline\(readPeers\(\)/.test(BRIDGE), 'readPeers is called without a deadline');
});

t('wiring: tmux is read exactly once per /status and never on a poll', () => {
  eq((BRIDGE.match(/readPeers\(/g) || []).length, 1, 'more than one call site means one of them is on a timer');
  ok(!/setInterval\([^)]*readPeers/.test(BRIDGE), 'a tmux read on a timer is five subprocesses a second');
});

// ---------------------------------------------------------------------------

const run = async () => {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      pass++;
    } catch (e) {
      failures.push(`${name}\n    ${e.message}`);
    }
  }
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  ✗ ${f}\n`);
    process.exit(1);
  }
  console.log('✅ all peers tests pass');
};

run();
