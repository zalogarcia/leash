# Changelog

All notable changes to Leash. Dates are release dates.

## 1.8.0 (2026-09-09)

**A background Codex job you can reach while it is running, and that survives the restart that kills
its process.**

### Background Codex jobs run on `codex app-server`

- A handed-over Codex job (`bg.mjs --engine codex`, a `codex:` prefix, or the rate-limit fallback)
  now runs as a thread on its own `codex app-server` child instead of one-shot on `codex exec`. The
  reason the background lane was left on exec was that a job "must outlive this daemon, which a child
  on our stdio pipes cannot". That is paid for differently now: the THREAD outlives the daemon, on
  OpenAI's side, and `thread/resume` picks it up in a fresh child. A job survives a restart by being
  resumed rather than by its process surviving, and in exchange it gets the three things a one-shot
  run structurally cannot have.
- **`/steer` lands in the running turn**, as `turn/steer` carrying the turn id it was aimed at,
  framed exactly as it is for a Claude worker, and recorded in the report under the same
  `STEERED IN` block. A steer that arrives between turns is queued and delivered by the next
  `turn/start` rather than refused. `bg.mjs ps` says `STEER yes`; a review and any run that fell back
  to exec still say `no`, and the card offers the run id rather than the lane, because lane names are
  recycled.
- **`/btw` is answered mid-run.** The daemon watches the thread's agent messages for the
  `BTW-ANSWER #N:` marker, routes it by id to the chat that asked, and lifts the block out of both
  the progress bubble and the report capture. The hourglass gained a sixth ending for the one case
  only this lane can produce: the server refusing the mid-turn write, where the job is still running
  and asking again works, which is neither "the run ended" nor "the daemon restarted".
- **`/stop` is a `turn/interrupt`** the model acknowledges, not a SIGTERM at a child that may be
  mid-write in `workspace-write`. The turn ends `interrupted`, the handback says stopped, and what it
  produced still reaches `bg-reports/`.
- **The bubble streams the tool steps** and ends `✅ Done · Ns · N steps`, through the same renderer
  the Claude bubble uses. `/status` reads the step count and the last action off the live run instead
  of walking the log tail.
- **A restart resumes the job.** On boot, every app-server job the last daemon left running gets a
  fresh child, a `thread/resume` and one continuation turn ("your thread and any files you wrote are
  intact, continue from your last step, do not start over"), announced with one `🧠 Resumed` line.
  Never the brief again, which is how a resumed job starts over. The job keeps its own run id, report
  path and original deadline, so a restart cannot quietly buy a billed run another full timeout. A
  job whose thread was never created is handed back as a dead worker with the salvage note rather
  than dropped, and pending questions resolve rather than ticking forever. A record still in the
  registry is by definition a job that never reported, which is what stops a finished job being
  re-run or handed back twice.
- **One child per job**, not the chat lane's shared server: a job runs for an hour in
  `workspace-write`, and sharing would mean one death takes the other's turn with it. Death mid-turn
  retries inside the existing window and then hands back a dead-worker report with the salvage
  instruction; a failed spawn counts as one death rather than two, and the permanent "this build has
  no app-server" latch stays the chat lane's alone, so a slow spawn under load can no longer drop
  every later job to one-shot for the daemon's life.
- **Nothing downstream changed.** The handback object is key-set-identical to the exec path's,
  asserted by test, and the run log is written in `codex exec --json` shape, so `/status`, the
  salvage script and the outcome reader read it unchanged. The lifecycle is logged one line per step
  with the run and thread ids and never the brief text, a question or a token.
- **`codex exec` is the fallback, not the past.** `/codex review` stays one-shot (it reads the diff
  itself and there is nothing to steer into), and so does every job dispatched while the app-server
  has failed its death window. `safe-restart.sh` now asks the run registry which `codex app-server`
  children are jobs and holds for those, while still excluding the chat lane's workless server: the
  two are identical in `ps`, and restarting over a job mid-write was the one thing that exclusion had
  quietly started to allow.

### Fixes found reviewing the above

- **A child that died while `thread/resume` or `turn/start` was in flight was reported dead after
  ONE death, under its own log line saying it was being retried.** The death rejects the awaiting
  call AND starts the retry, and the retry runs first, so the stale await then finished the very run
  the retry had just claimed and the fresh child was killed on its way up. The retry owns the run
  now; two deaths in the window is still the give-up signal, and still the only one.
- **`/status` told you a steerable job could not be steered.** The card, `bg.mjs ps` and `/steer`
  read steerability off the run; `/status` hardcoded "not steerable · 0 steps" beside them, on the
  same job at the same second. It reads the run like the other three.
- **A steer queued between turns could be acked and then silently dropped.** A steer with no live
  turn is queued rather than refused, which is right while the job is alive, but a job that ended
  before its next turn left that ack standing over a message nobody ever sent. It is now corrected
  on the surface the ack went to, like any other refusal.
- **`/stop` had no escalation if the interrupt was accepted and the turn never completed.** The exec
  path escalates a SIGTERM to a SIGKILL; the app-server path now ends the run itself after a grace
  window rather than leaving it in flight under a message saying it was stopped.
- **A question pending across a restart told you the worker could not be asked again, on a job that
  was about to be resumed.** True for a re-attached Claude survivor, which has no stdin left; false
  for the one worker the restart brings back, and contradicted by the `Resumed` line under it.
- **`safe-restart.sh` looked for the run registry where the daemon does not always keep it.** It read
  only `BRIDGE_INFLIGHT_FILE`, while the daemon also honours `inflightFile` in `config.json`, so an
  install that moved the registry through the file layer left the restart finding no registered pids
  at all: every `codex app-server` child read as the chat lane's, and the restart went over a job
  mid-write. Both halves resolve it through the same three layers now. In the same pass, a background
  Codex job's `/btw` introduces the daemon by its configured `name`, as the Claude worker's already
  did, so a renamed install no longer answers to two names inside one feature.
- **A question answered at the very END of a task swallowed the worker's report.** A worker whose
  task had already finished answered in ONE message carrying the answer AND its report, and the whole
  block was taken as the answer: the asker got the report folded into a private answer, and the
  handback said "the worker ended with no output" over a finished job. The answer now ends at the
  first blank line (or the stated character budget, broken at a line rather than mid sentence) and
  everything under it stays in the bubble and in the report, on both transports. Every answer in the
  block is routed, not just the first, because the framing asks for ONE message and a worker holding
  two questions answers both in it. The framing, lane rule 5 and the README now tell a worker exactly
  that shape: one paragraph, and if the task is already done, the answer first, one blank line, then
  the report. And a clean run whose capture is empty because its only final message WAS an answer
  reports that reason instead of "ended with no output", which reads as a dead worker and gets the
  job re-fired.
- **The dispatch notice still told you a background Codex job could not be steered.** It printed
  `engine: codex · not steerable · <runId>` for every Codex job and offered no command, which stopped
  being true the moment those jobs moved onto `codex app-server`: an edit or ask job takes a steer and
  a side question mid turn. It now takes the run's steerability from the caller that started it, the
  same way the live card does, and offers an edit or ask job the same `bg.mjs steer` command a Claude
  worker's notice offers. A review keeps `not steerable` and now says why (one-shot exec run), and a
  job with no run id says nothing about reach rather than guessing either way.

## 1.7.0 (2026-09-09)

**A question you can put to a running worker without changing its job, and a `/help` that reaches the
phone whole.**

### `/btw`: a side question, answered in the chat

- Steering does one thing, and it is not a small one: it changes the job. Every steer is framed as "a
  mid-run instruction for your CURRENT task", and that framing is load bearing, so there was no way to
  ask a running worker "which repo are you in" without also telling it something. `/btw did the
  migration apply?` from Telegram, or `node bg.mjs btw bg2 "<question>"` from a terminal, is the
  opposite framing on the same pipe.
- The worker is told this is a side question, NOT an instruction, not a new task and not approval of
  anything; it answers in one message whose first line is `BTW-ANSWER #N:` and then continues exactly
  where it was, plan unchanged. Lane rule 5 rides in on every brief, so a worker knows the shape
  before its first question arrives, and the daemon introduces itself by the `name` in `config.json`.
- The daemon watches that worker's own stream for the marker, lifts the block out of the progress
  bubble AND out of the report capture, and edits it into the ⏳ message already on screen. One
  message per question, from waiting to one of four endings, all of them wired: answered, the run
  ended without answering, you stopped it, or the daemon restarted under it (pending ids are
  persisted with the worker, so the next daemon resolves the line rather than leaving it ticking). At
  15 minutes it says so and keeps listening, because a worker inside a long tool call is busy rather
  than gone.
- Ids are per worker and monotonic, so an answer can only ever resolve a question asked of the worker
  that emitted it, and an answer naming an id nobody is waiting for is dropped rather than handed to
  the oldest. The result event does not route, it only suppresses a byte-identical duplicate, which
  is what keeps a private answer out of the handback.
- Availability is exactly steer availability, which is why `ps` grew no new column: same resolver,
  same stdin pipe, so a restart survivor, a finished run and a background Codex job refuse it for the
  same reasons. A Codex refusal names the escape hatch for a QUESTION (`/codex <question>`) rather
  than the re-fire a steer would suggest.
- `bg.mjs btw` requires a target and refuses loudly without one, unlike Telegram, which falls back to
  `latest`: a scripted caller that named no worker has not decided which one it meant. The refusal is
  its own arm, so a targetless `btw` can never fall through and spawn a background worker whose brief
  is the question.

### Fixes

- **`/help` arrived with its tail missing.** The composed message was 4,077 characters against a
  4,080 budget, so the reference was being cut at `HELP_BODY_MAX` and the last two paragraphs (the
  attachments block and the notes line) never reached the phone, while every gate stayed green. The
  reference is now tightened line by line, with no command and no fact dropped, and the duplicated
  title line removed (the index above the blockquote already carries it): 3,575 characters, nothing
  truncated, and 50 characters of headroom. The suite now measures the composed message the way it is
  actually sent (escaped), asserts nothing was cut, and requires at least 40 characters left over, so
  the next line added to `/help` has to be paid for rather than appended.

## 1.6.0 (2026-09-09)

**Two things the daemon could not see: the message you were pointing at, and the sessions it did
not spawn.**

### Replying to a message quotes it into the prompt

- Long press any bubble, pick Reply, and a bounded one-line quote of it rides in front of what you
  typed: the engine reads `[Replying to Leash's message from 16:11: "..."]` above your own words,
  so "for this, we need to do the support ticket ourselves" arrives with its subject attached
  instead of as eight words with none. The name in the block is `name` from `config.json`.
- It works on every inbound path: a new turn, a message steered into a running turn, a `codex:` or
  `claude:` one shot, a `bg:` job, and a photo or file with a caption. No lookup is involved, so a
  reply to a bubble from before the last restart behaves like a reply to a fresh one, and
  Telegram's "quote part of a message" selection wins over the whole bubble when you make one.
- The quote is DATA, never routing: it is composed after the lane and the engine have been chosen
  from your own typed words, so a quoted bubble containing `codex:` or `/autopilot` cannot steer
  anything. It is collapsed to one line, capped at 1,500 characters, and a cut is stated in the
  block rather than left to be guessed. A forwarded bubble is attributed to whoever wrote it, not
  to whoever forwarded it.
- Everything that DESCRIBES a run stays on what you typed: the start notice, the `/status` line and
  the `bg-results` row keep using your own words, while only the model sees the quote. The ack names
  the quote, so a message that silently carries a page of someone else's words is impossible.

### `/status` ends with a Peers block

- Every other block in `/status` renders something the daemon spawned, so an interactive Claude Code
  or Codex session someone opened in a terminal did not appear at all: from the phone, a session
  working forty minutes on a job the daemon had handed it did not exist. `/status` now closes with
  one line per terminal-multiplexer session on the machine, saying working or idle, how long, and
  which engine, with the last thing a working one said underneath.
- Read only, mechanically: every call goes through a guard that refuses any subcommand outside
  `list-sessions` and `capture-pane`, and the suite greps the module for the write verbs. Peer
  sessions belong to whoever is typing in them.
- Bounded, mechanically: the multiplexer is read only when `/status` renders and never on a poll,
  each call carries a 3s timeout, the captures run in parallel, and the whole read sits behind a 4s
  deadline that falls back to no peers. At most 12 sessions are listed and the rest are counted,
  because a silent drop was the reported bug. The block is omitted entirely when there is no
  multiplexer server, so a machine without one pays nothing.
- Pane text is untrusted input on its way into a chat log, so a detail row carrying anything
  credential-shaped is replaced rather than clipped: the name half (token, secret, key, password
  before a colon or an equals) and the value half (OpenAI, Supabase, Telegram, GitHub, Slack, AWS
  and JWT shapes). Engine detection reads the last 24 lines bottom up, so a transcript that merely
  quotes a spinner or a footer cannot lie about its own session.

### Fixes

- Importing `bridge.mjs` no longer boots a daemon, and only the process that created the steer
  socket unlinks it, so a second import cannot take the running daemon's socket away.
- The background worker card shows the engine's model and effort, so a job running on the other
  engine no longer reads as though it were on the default one.

## 1.5.0 (2026-09-04)

**Codex stops being a rescue path and becomes a peer engine, and every message the daemon writes
about itself gets one voice.**

### An engine per lane

- `/engine claude|codex` moves the chat lane; `/engine bg claude|codex` moves handed-off jobs. Bare
  `/engine` prints both lanes, where each value came from, the Codex model and effort in force, and
  the sandbox. `engine` in `config.json` sets the install default (`{"chat":..,"bg":..}`, or a bare
  `"codex"` for both), so a Codex-first user never types the command.
- A `codex:` or `claude:` prefix on any single message pins that one message, and
  `bg.mjs --engine <name>` does the same for one background job. Precedence is resolved in one
  place, so the notice, the handback and the run itself cannot disagree about why a job is where it
  is.
- **The daemon boots and serves with no `claude` binary on the machine.** `/status` says
  `claude NOT INSTALLED`, account rotation never runs, and the handful of commands whose subject IS
  a Claude session answer with one line instead of starting a session that cannot start.
- `/model` on a Codex chat lane sets the CODEX model and says so. `/codex model`, `/codex effort`,
  `/codex network on|off` and `/codex doctor` steer and check that engine directly.
- The chat lane keeps ONE Codex thread per chat, so a follow-up continues the conversation instead
  of paying to re-read the repo. `/new` starts a fresh one.

### Switching engines without losing the conversation

- Switching lanes used to drop the conversation: the incoming engine opened on "hello" while the
  outgoing one held every decision that had been made. A bounded, redacted handoff (goal, decisions,
  files touched, the open question) is now prepended to the incoming engine's first message as
  untrusted DATA, inside explicit markers.
- Five rungs, tried in order, so a switch never waits on an engine that may be walled: the engine
  being left writes it in one short capture turn; failing that the on-disk chat ring (the last ten
  turns of this chat, both engines, written by the daemon with no model call); then the ring without
  tool detail; then the bare goal line; then a labelled "nothing recorded yet".
- Everything stored and everything rendered goes through the same redaction pass `codex doctor`
  output does, twice: once before it is written, once before it is injected.
- The first Codex turn carrying a handoff runs with network access **off** by default
  (`codexHandoffNetwork`). `/engine codex fresh` skips the handoff; `/new` clears it and the ring.

### The Codex chat lane runs on `codex app-server`

- A message typed mid-turn is **steered into the running turn**, with the same ack the Claude lane
  sends. The bubble streams the tool steps, and the footer is `✅ Done · 12s · 3 steps`.
- `/stop` is a `turn/interrupt` the model acknowledges, not a SIGTERM. One child serves the whole
  daemon, so stopping one turn does not kill it.
- Thread ids are unchanged: `thread/resume` takes ids created by `codex exec`, so nothing in
  `state.json` needed migrating.
- The fallback is intact: an older CLI, `codexAppServer: false`, or two child deaths in a minute,
  and the lane runs one-shot on `codex exec` exactly as before, saying so once. Background jobs
  always use `codex exec`, because a background worker must outlive this daemon.

### One voice, and messages that finish what they start

- Every message the daemon writes about itself now comes from one family with one house style:
  icon, then label, then value; one fact per line; reference material behind an expandable
  blockquote. `/help` is an index rather than a wall, and `/status`, `/usage`, `/context`, `/new`,
  `/compact` and `/restart` all follow it.
- **A wait is ONE message that edits itself to a terminal state.** A background job is one message
  from dispatch, through a live line while it runs, to Done. `/restart` resolves the message it put
  up. A limit wall counts itself down every five minutes and resolves the moment it lifts.
  `progress: { background: false }` turns the live worker line off.
- `style: { noDashes: true }` rewrites em and en dashes out of every outbound reply on both engines,
  leaving code spans, fenced blocks and URLs alone. Off by default: the model keeps its own voice.
- A worker's full report is written to disk before anything is capped, and the handback carries an
  excerpt plus a pointer to the file, outside the untrusted-output markers.
- The daemon's own name comes from `name` in `config.json` (default `Leash`).

### Fixes

- A fenced code block longer than one Telegram message no longer loses its formatting: the chunker
  closes and reopens `<pre>` across the split.
- `/account` and `/usage` render the Codex block again (an aliased import had left one call site on
  the old name, which failed at call time and cached the account as unreadable).
- `BRIDGE_<UPPER_SNAKE>` environment overrides now work for the object- and boolean-valued keys,
  not just the scalar ones.

## 1.4.0 (2026-09-03)

**A running background worker can be corrected, and there is a second engine behind it.**

### Steering a running worker

Background workers used to close stdin at spawn, which made a dispatched job unreachable: the only
way to change its instructions was to kill it and re-dispatch, throwing away a context that had
already read the repo. Workers now hold stdin open for their whole run.

- `/steer <lane|runId|pid|latest> <text>` from Telegram, and `node bg.mjs steer <target> "<text>"`
  (or `--file <path>`) from a terminal, write one more instruction into a running worker.
- `node bg.mjs ps` prints what is running: run id, lane, pid, elapsed, steps, whether it can still
  be steered, how many steers it has taken, which engine, and the job title.
- The text arrives framed as a mid-run instruction, so a worker folds it into the job it is doing
  instead of treating it as a replacement brief. Whatever was steered in comes back in the report
  under a `STEERED IN` block, outside the untrusted-output markers, because it is the bridge's own
  record rather than the worker's claim about itself.
- `/status` now names each worker's run id and says whether it is steerable. A worker that survived
  a daemon restart is running but unreachable (the new daemon tails its log and holds no pipe), and
  those now appear in `/status` instead of the lane list reading "idle" over a multi-hour job.
- Briefs handed over through `bg.mjs` now carry a short LANE RULES preamble stating the facts a
  headless worker otherwise learns by being blocked, including that a steer may arrive mid-run. The
  daemon strips it back off before showing a brief in a notice, `ps` or `/status`.
- `safe-restart.sh --allow-bg` restarts as soon as the chat lane is idle rather than waiting hours
  for background work. The workers survive; they lose steerability until they finish.
- The socket is a local, unauthenticated filesystem socket (`steer.sock`) next to `bridge.mjs`,
  carrying two operations, `steer` and `ps`. It cannot start, stop or kill anything.

### Codex: a second engine, and a fallback for a walled account

Optional, and off the shelf: if OpenAI's Codex CLI is installed, Leash can run work on it. Without
the binary every path below answers with one line saying so, and nothing else changes.

- `/codex <question>` asks it read-only in the current directory; `/codex review [<repo>] [vs
  <branch>]` runs its own review harness over a diff; `/codex on|off` toggles the fallback.
- `node bg.mjs --engine codex --file <brief>`, or a `codex:` prefix, sends a whole job to it.
- While **every** enrolled Claude account is rate limited, a background job with no engine
  preference runs on Codex rather than waiting for the reset, and a chat message gets a Codex answer
  prefixed `[Codex fallback, Claude limited until HH:MM]` instead of silence. Claude slash commands
  still wait, because Codex cannot run one. Once the wall lifts those pairs are handed to the
  assistant as context, with an instruction not to answer them again.
- A Codex failure can never mark a Claude account limited, swap one, or re-fire anything on Claude,
  and Claude's limit handling never spawns Codex. The fallback cannot loop.
- Codex runs are registered, detached and file-backed exactly like a worker: they appear in
  `/status` and `bg.mjs ps` with `ENGINE: codex`, survive a daemon restart with their deadline
  re-armed, and `/stop codex` kills one. They are never steerable, because Codex reads its prompt
  once from stdin and never again.
- `/account` (and the new `/accounts` alias) shows the Codex account below the Claude ones: which
  login, the plan, both rate-limit windows with reset clocks, the credit balance, and what Codex has
  cost today and over the last seven days. Nothing in that path reads, prints or forwards a
  credential; `codex` finds its own auth in `~/.codex/auth.json`.
- Billing is your own OpenAI login, a ChatGPT subscription or an API key, and is entirely separate
  from your Anthropic plan.
- New optional config keys: `codexBin`, `codexTimeoutMs` (default 30 minutes, `0` disarms the
  deadline), `codexModel`. `install.sh` checks for the binary and only warns when it is absent.

### Under the hood

- Every run, background included, now gives its stdin pipe back on both terminal handlers, so a
  long-lived daemon cannot leak one file descriptor per run it has ever started.
- New modules, each with its own suite: `bg-steer.mjs`, `bg-lane-rules.mjs`, `bg-codex.mjs`,
  `codex-account.mjs`. Suite total is 484 assertions across 11 files to 763 across 16, plus a probe
  (`scripts/probes/steer-probe.mjs`) that drives a steer end to end into a fake worker with no model
  spend.
- A handed-over job now runs in the repo its BRIEF names rather than wherever the chat happens to be
  pointed. `--sandbox workspace-write` is rooted at one directory, so a job about repo X that ran in
  repo Y either could not do its work or would edit same-named files in the wrong tree.
  `bg-lane-rules.mjs` gained `briefRepo`, which reads the workspace root from config instead of
  assuming one.
- The rate-limit fallback refuses a Claude slash command on the `bg.mjs` path too, not only on the
  `bg:` one. `/autopilot` reached Codex as a literal prompt with write access; it now waits for the
  reset, and the handoff notice says that is why it is sitting still.
- A Codex run adopted from a previous daemon is only ever signalled while it is still alive, checked
  again when its re-armed deadline fires and released when it reports. A pid is a reusable number,
  and a stale registry entry could otherwise SIGTERM whatever inherited it.
- `codexParkedNote` clips both halves of a parked pair. A wall parks up to ten of them, and a
  `--file` brief and a Codex report are each large enough that ten of both went into one prompt the
  moment the wall lifted.

## 1.3.0 (2026-09-03)

**Renamed to Leash.** The project keeps every behaviour it had; only the name changes. "Claude
telegram bridge" described the plumbing rather than the thing you actually use, and it could not be
said out loud without sounding like an internal tool. Leash names what the product does: the agents
run as far as you send them, you keep hold of the end of the line, and off-leash is the autonomous
background mode where a worker goes and finishes a whole job on its own.

- The README, the docs and the bot's own help, status and startup text now say Leash.
- New brand artwork lives in `docs/assets/`, and the README leads with it.
- **Nothing on disk was renamed.** The service label `com.claude-telegram-bridge`, the default
  clone directory `~/leash`, the log file, `config.json`, `accounts.json`, the
  `BRIDGE_*` environment variables and `bridge.mjs` itself all keep their existing names. Upgrading
  changes no paths and no configuration: pull, and carry on.
- Those internal names are expected to migrate in a later release, with an upgrade path. Renaming
  them now would break every install that exists.
- Once the GitHub repository is renamed, old clone URLs keep working through GitHub's own redirect,
  so existing checkouts and any script that clones the old path are unaffected.

## 1.2.1 (2026-09-01)

**Account swaps work again once you have a few MCP servers connected.** The credential blob in the
macOS Keychain holds your per-machine MCP server tokens alongside your login, and `security` refuses
to accept more than about 4096 characters through the path the bridge was using. Adding a couple of
MCP servers pushed the blob past that, and from then on every swap was refused with "credential
write failed; the previous account is still active and nothing changed" (correctly: nothing was
damaged, but nothing could be switched either).

- Large credential blobs are now written through a second `security` path that has no such limit,
  so a swap succeeds whatever your MCP servers add up to. Blobs that fit the old path still use it.
- Your MCP server tokens still survive every swap untouched, which is the whole reason the blob is
  that big.
- The refusal that protects you from a truncated write is still there, now at a ceiling about 17x
  larger than the blob that broke it, and it still refuses before touching anything.

## 1.2.0 (2026-09-01)

**Multi-account switcher.** For people who hold more than one Claude subscription (a personal one
and a work one, say), the bridge can now switch which login background workers run as. Credentials
never leave your machine.

- `/account`: every enrolled account with live usage bars, reset clocks and time left, plus
  one-tap inline buttons to swap accounts or capture the current login. The no-argument form is
  strictly read-only.
- `/usage`: the full picture per account: 5-hour and weekly windows, percent used, a usage bar,
  reset time in your local timezone and time remaining, per-model scoped windows where present.
- `/status` now names the active account with its usage on one line.
- Automatic rotation: when a background worker dies on a session limit, the bridge switches new
  workers to the enrolled account with headroom and tells you it did.
- Cross-platform credential store: the macOS Keychain backend is battle-tested; the
  `~/.claude/.credentials.json` backend for Linux and Windows is new and less proven. Treat your
  first swap on a non-Mac as a test.
- Safety was most of the engineering, and every rule below exists because its absence caused a
  real incident during development:
  - a credential write that fails or reads back wrong is rolled back to the previous login, never
    left half-written
  - oversized keychain payloads are refused before anything is touched (macOS `security` silently
    truncates past ~4096 characters)
  - credentials are only ever saved into an account slot whose identity is proven (token
    fingerprint or profile email); anything unidentifiable is parked, shown in `/account`, and
    claimable, never written over another account
  - before the first swap ever writes, your live login is backed up once to
    `accounts.backup.json` (0600, never overwritten)
  - your per-machine MCP server tokens survive every swap untouched
- Setup: log into an account, send `/account capture <name>`, repeat per account. See
  `docs/multi-account.md`.

## 1.1.1 (2026-08-31)

- Long code blocks now split cleanly across Telegram messages. Previously a fence longer than one
  message left unbalanced tags and Telegram degraded exactly the replies most worth reading to
  plain text.
- A background worker that dies on a fatal error (expired login, bad API key) now reports
  ❌ failed with the reason instead of a green check.

## 1.1.0 (2026-08-07)

- Tables, collapsible sections and quotes render properly in Telegram instead of as raw markdown.
- Background workers survive the daemon dying: a restart re-attaches running jobs, and jobs that
  died while the daemon was down are reported instead of vanishing.
- `/context` shows your Claude plan limits (5-hour and weekly windows).
- `bg.mjs --file <brief>`: hand a long task to a background worker from a file, so shell quoting
  cannot mangle it.

## 1.0.0 (2026-07-28)

- Baseline public release: Telegram bridge to Claude Code with background worker lanes, schedules,
  markdown rendering (tables as titled blocks), and clipped messages marked with an ellipsis
  instead of looking broken.
