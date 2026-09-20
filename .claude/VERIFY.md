# VERIFY.md, the verification manifest for this repo

<!-- Machine readable source of truth. Anything about to claim a change is
     tested, working or live reads this FIRST and runs the proof signal named
     for that surface. `.claude/verify.sh` is the runnable projection of this
     file: change one, regenerate the other. -->

Leash is a local daemon, not a hosted service. It is installed on the operator's
own machine and it talks to Telegram, to the Claude CLI and to the Codex CLI.
Almost everything provable about it is provable OFFLINE, and the section
"What this repo cannot prove offline" is the one that matters most: it names
the surfaces where a green gate is not evidence.

## Commands (each actually run on 2026-09-20, exit codes captured)

There is no package.json, no build step and no bundler. Node is the only
runtime requirement (verified against node v22.16.0).

- syntax gate (entry point): `node --check bridge.mjs` (exit 0)
- syntax gate (everything): `for f in *.mjs scripts/probes/*.mjs; do node --check "$f" || echo "FAIL $f"; done` (71 files, 0 failures)
- shell syntax gate: `for f in *.sh scripts/*.sh; do bash -n "$f" || echo "FAIL $f"; done` (5 files, 0 failures)
- offline suites: `for f in test.mjs *.test.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`
  (36 suites: `test.mjs` plus 35 `*.test.mjs`. 2095 assertions passed, 0 failed.
  34 of the 36 print an `N passed, M failed` line; `detached-workers.test.mjs`
  and `watchdog.test.mjs` report by exit code only.)
- shared module gate: `./scripts/check-shared.sh` (33 of 33 identical, exit 0)
- installer rehearsal: `./install.sh --dry-run` (exit 0, changes nothing)
- typecheck / lint: none exist. There is no tsconfig, no eslint and no
  prettier config in this repo. Do not invent one in a manifest row.

`VERIFY_QUICK=1 ./.claude/verify.sh` skips the suites and keeps the fast gates.

## Formatter / hooks

- No formatter, no linter, no husky, no `.githooks`, no active hook in
  `.git/hooks`. Nothing rewrites a file at commit time, so stage order does not
  matter here.
- Prose style: this project writes no em dashes and no en dashes in its own
  output, and `dash-normalize.mjs` strips them from outbound messages when
  `style.noDashes` is set. Keep added prose free of both.

## Deploy surfaces and THE proof signal for each

| Surface | Pipeline | Proof a change is LIVE |
| --- | --- | --- |
| the daemon | `./install.sh` writes `config.json` and bootstraps a LaunchAgent; `./safe-restart.sh` restarts a running one | the service is loaded AND the running process is the new code: `launchctl print gui/$(id -u)/com.claude-telegram-bridge` shows it running, and the daemon answers a real message. A restart alone is not proof, because `safe-restart.sh` waits for idle and can still be waiting. |
| the docs site | `docs/` is a static site with its own `vercel.json`; the Vercel project link lives in the gitignored `.vercel/` | fetch the deployed page and grep the served HTML for a string unique to the change. A green Vercel build is a precondition, not proof. |

## Surfaces inside the daemon, and what proves a claim about each

These do not deploy independently. They are listed because each one is a place
where "it works" has been claimed before, and each has exactly one thing that
would actually show it.

| Surface | Where it lives | THE proof signal |
| --- | --- | --- |
| the Telegram write path: `tg()`, `send()`, `editProgress()` | `bridge.mjs`, on top of `tg-governor.mjs` | `node tg-governor.test.mjs` for the governor's own rules (bucket, cooldown, outbox, ledger), and `node progress-priority.test.mjs` for which writes are durable, disposable or skipped. Both drive the REAL governor and assert on the ledger it writes, not on the source reading correctly. Neither reaches Telegram. |
| the chat lane progress bubble | `bridge.mjs`, the Claude lane | `node progress-priority.test.mjs`, which runs the real renderer against the real governor. A screenshot of a bubble is not a substitute: it shows one path. |
| the Codex exec progress bubble | `runCodexChatExec` in `bridge.mjs` | offline: `node bg-codex-wiring.test.mjs` (the real function against a fake `codex` binary). Live: `node scripts/probes/codex-chat-probe.mjs`, which spawns the REAL binary. See the probe table below for what its exit codes mean. |
| the Codex app-server progress bubble | `runCodexChatTurn` in `bridge.mjs`, on `codex-appserver.mjs` | offline: `node codex-appserver.test.mjs` (protocol, against a captured transcript) and `node bg-codex-wiring.test.mjs` (against a fake server). Live: `node scripts/probes/codex-appserver-probe.mjs`. |
| the background worker notice line | `bg-notify.mjs`, driven from `bridge.mjs` | `node bg-notify.test.mjs` for the line itself, `node bg-reports.test.mjs` for the report on disk and the handback that names it, and `node progress-priority.test.mjs` for the rule that this line opens and resolves and spends nothing in between. |
| the usage limit rotation report path | `accounts.mjs`, `account-selector.mjs`, `account-buttons.mjs`, wired in `bridge.mjs` | `node limit-rotation.test.mjs` is the one that covers the report, including the arm that sends its own message when there is no bubble to edit. `node accounts.test.mjs` and `node account-usage.test.mjs` cover the store and the plan readings underneath it. Every wall in all three is a FABRICATED response; see below. |
| the offline test suites | `test.mjs` and `*.test.mjs` in the repo root | the command in the Commands section. Run them individually and read each exit code; a wrapper that stops at the first failure hides the rest. Under heavy machine load `bg-codex-wiring.test.mjs` can time out on one interrupt case and pass on a re-run, so a single failure there is re-run before it is believed. |
| the public and private split | `scripts/check-shared.sh` | `./scripts/check-shared.sh`, which exits 0 only when all 33 shared modules are byte identical. It finds the sibling repo from this repo's own directory name, or from `BRIDGE_SIBLING_REPO`. Exit 2 means the sibling was not found, which is NOT a pass. `bridge.mjs` is deliberately excluded and must never be added: the two copies diverge by design. |
| the probes | `scripts/probes/` | see the probe table below. |
| the install path | `install.sh`, `config.json`, `uninstall.sh` | `./install.sh --dry-run` (exit 0) proves it gets as far as deciding what it would write. It does NOT prove the install: only a real run creates the LaunchAgent, and only the daemon answering proves that worked. |

## The probes, and what each exit code means

The probes are in `scripts/probes/`. Two of them are LIVE and cost money.

| Probe | Offline? | Meaning |
| --- | --- | --- |
| `steer-probe.mjs` | yes | a steer end to end into a fake worker. Exit 0 is a pass. |
| `codex-chat-probe.mjs` | NO, spawns the real `codex` and spends tokens | 0 thread continuity proven, 1 the thread did not carry over (a real defect), 2 blocked before any answer came back (usage limit, no login, no network). |
| `codex-appserver-probe.mjs` | NO, spawns the real `codex app-server` and spends tokens | 0 every structural proof held AND answers came back, 1 a structural proof failed, 2 the protocol held but no answer came back. |
| `codex-bg-appserver-probe.mjs` | NO, spawns the real `codex app-server` and spends tokens | non zero on any failed case; it prints one line per case. |

Two standing facts about the live probes:

- **Bound every run.** `codex-bg-appserver-probe.mjs` took 263 seconds on its
  own deadline on 2026-09-20 and the app-server probe used to hang for a full
  240 seconds when its source slice was incomplete. macOS has no `timeout`
  binary by default; `perl -e 'alarm shift; exec @ARGV' 300 node <probe>` is a
  portable stand in, because a pending alarm survives `exec`.
- **They slice `bridge.mjs` by source text and the slices go stale.** Each
  probe extracts named top level functions and consts and evaluates them in
  isolation, so a helper that moves out of a sliced function becomes a
  `ReferenceError` at call time, or worse a swallowed one that turns into a
  four minute hang. After any `bridge.mjs` change that touches the Codex lanes,
  run both live probes and read the ERROR, not just the exit code. See
  `.claude/rules/probes.md`.

## Traffic harness

none, and the gap is narrow. This repo has no inbound HTTP surface: it POLLS
Telegram with `getUpdates` and it spawns local CLIs. There is no webhook, no
callback URL and no third party posting at it, so the class of defect a
simulated traffic harness exists to catch does not have a boundary to enter
through here. The equivalent gap is named in the next section instead.

## What this repo cannot prove offline

**Read this before writing the words tested, working, proven or live.**

Every gate in this repo is offline, on purpose, and that purpose is real: the
suites must never boot a second daemon against a live bot token, because two
consumers of `getUpdates` fight over the offset. The cost of that choice is
that some claims cannot be made from a green suite, and the following are the
ones that have been made anyway.

- **Nothing here has ever run against real Telegram.** No suite imports
  `bridge.mjs` (verified 2026-09-20: zero `import` or `import()` of it across
  all 36 suites; the ten that need it read it as TEXT and slice it). Only
  `bridge.mjs` itself reaches `api.telegram.org`. So no gate in this repo
  exercises the real API: not its rate limiter, not its entity parsing, not its
  message length limits, not its file size limits, not `editMessageText` on a
  message that has since been deleted. A suite passing says the code agrees
  with the fake, and says nothing about whether the fake agrees with Telegram.
- **The 429 and rate limit wall paths have only ever run against a simulated
  429.** Verified 2026-09-20: every 429 in the suites is thrown by a test
  double, for example `throw r.err(429, 60, 'Too Many Requests')` in
  `tg-governor.test.mjs`. The cooldown, the outbox hold, the chrome shedding,
  the skipped opening placeholder, the throttle notice and the wall countdown
  are all exercised against numbers this repo chose. A future run must NOT read
  a green `tg-governor.test.mjs` or `progress-priority.test.mjs` as proof that
  the wall behaves correctly against Telegram's real 429, including whether
  `retry_after` arrives where and as this code expects.
- **The only path that touches real Telegram is `node bridge.mjs --selftest`,**
  and it needs a live bot token and chat id. It is one message through the real
  handler. It is the smallest honest live proof available here and it is not
  part of any gate.
- **The two live Codex probes need a working ChatGPT login with credit.** On
  2026-09-20 both ran end to end and exited 2: the account was out of credits,
  so no answer came back. Exit 2 means the mechanics were proven and the model
  was not reached. It is not a pass.
- **The Claude CLI path is not exercised at all.** The lanes that spawn
  `claude` are covered only by fakes.
- **The LaunchAgent, the watchdog and `safe-restart.sh` are covered by
  `watchdog.test.mjs` and by `--dry-run`, not by an install.** Nothing in the
  gates loads a real LaunchAgent or kills a real daemon.

The honest ceiling when only the offline gates have run is
`OFFLINE GATES GREEN, NOT LIVE VERIFIED`, naming which of the above applies.

## Live test safety

- This daemon talks to a REAL Telegram chat. A live test sends a real message
  to whatever chat id is configured. Use the operator's own chat, never a chat
  belonging to anyone else, and never a group.
- Credentials are read from `config.json`, which is gitignored, and from the
  `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` environment variables. Names
  only: never write a value into a file, a commit or a log.
- The live Codex probes SPEND MONEY on the configured ChatGPT account. Do not
  put them in a loop and do not add them to a gate.
- State neutralization: a live run writes to `state.json`, `bg-inflight.json`,
  `tg-outbox.json`, `tg-ledger.jsonl` and `runs/`, all gitignored. The probes
  work in their own temp directory and delete it; they do not touch repo state.

## Data layer

none. There is no database, no migration directory and no ORM. State is a set
of gitignored JSON files in the repo root, listed in `.gitignore`.
