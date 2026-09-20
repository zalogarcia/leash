# Leash, contributor notes for Claude Code

Leash is a Telegram bridge for Claude Code and the OpenAI Codex CLI. It runs as
a LaunchAgent on the operator's own machine, polls Telegram with `getUpdates`,
and spawns local CLI sessions. There is no server, no database and no hosted
component except the static docs site in `docs/`.

Before claiming anything is tested, working or live, read `.claude/VERIFY.md`.
It names each surface and the one signal that proves a claim about it, and its
section "What this repo cannot prove offline" is the one that stops the
overclaims this repo is actually prone to. `.claude/verify.sh` is the runnable
version of the same signals.

## The shape of the repo

Flat, on purpose. Plain Node ESM, no package.json, no build step, no bundler,
no TypeScript, no linter, no formatter. Node is the only requirement.

- `bridge.mjs` is the daemon and the entry point. It is very large and it
  STARTS POLLING ON IMPORT.
- everything else at the root is an extracted module (`tg-governor.mjs`,
  `bg-codex.mjs`, `accounts.mjs`, `system-messages.mjs`, and so on) with a
  sibling `*.test.mjs`.
- `scripts/probes/` holds probes that exercise real paths outside the suites.
- `docs/` is the static product site. `install.sh`, `uninstall.sh`,
  `watchdog.sh` and `safe-restart.sh` are the install surface.

## Two rules that are not obvious and cost real time when missed

**1. Never import `bridge.mjs` from a test.** Importing it boots a SECOND
daemon against the live bot token, and two consumers of `getUpdates` fight over
the offset. Every suite that needs it reads it as TEXT and slices the functions
it wants, then evaluates them with a harness supplying the surrounding globals.
Verified: zero of the 36 suites import it.

**2. This repo is half of a deliberate pair.** A private sibling holds the
same daemon with owner specific prose in it. 33 modules are expected to be
BYTE IDENTICAL in both copies and `./scripts/check-shared.sh` fails if any of
them drifts; the list, and the reasoned exclusions, live in that script's own
comments. It finds the sibling from this repo's own directory name, or from
`BRIDGE_SIBLING_REPO`. Two consequences:

- Editing a shared module means editing it in both copies, or the gate fails.
- `bridge.mjs` is deliberately NOT shared and must never be added to the list.
  This copy carries a config layer (`conf()`, `config.json`, `install.sh`) that
  the private one does not, so the two files diverge by design. Porting a
  change into it is done hunk by hunk, leaving every `conf()` call alone.

## Commands

Every command in `.claude/VERIFY.md` was actually run and its exit code
captured. The short version:

```bash
node --check bridge.mjs                                   # the entry point parses
for f in test.mjs *.test.mjs; do node "$f" || echo "FAIL $f"; done   # 36 offline suites
./scripts/check-shared.sh                                 # 33 shared modules identical
./install.sh --dry-run                                    # the installer, changing nothing
./.claude/verify.sh                                       # all of the above, with one line per check
```

Run the suites individually and read each exit code. A wrapper that stops at
the first failure hides the rest.

## Style

- **No em dashes and no en dashes** anywhere: not in code, not in comments, not
  in prose, not in a message the daemon sends. `dash-normalize.mjs` strips them
  from outbound text when `style.noDashes` is set, and the source is expected
  to be clean without it. Note that a BSD `grep` with `\|` alternation returns
  a false negative on these bytes; use `grep -E` with `|`, two `-e` patterns,
  or a short Python check, and always with a positive control.
- The daemon names itself from `config.json`. The public default is `Leash`.
  Do not hard code an assistant name anywhere.
- Commit subjects are lowercase, one descriptive sentence, `area: what
  changed`, with no conventional commit prefix. Bodies explain WHY and name the
  gates that were re-run.

## Secrets

`config.json`, `accounts.json`, `state.json` and everything else holding live
state are gitignored. Credentials come from `config.json` or from the
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` environment variables. Reference
names only: never write a value into a file, a commit, a log or a test fixture.
This repo is public. Everything committed here is world readable.

## Learned mistakes and gotchas

- **A probe's source slice goes stale silently.** The probes in
  `scripts/probes/` extract named functions from `bridge.mjs` by source text,
  so refactoring a function out from under one of them produces a
  `ReferenceError` at CALL time, and sometimes a swallowed one that presents as
  a multi minute hang instead of an error. Both Codex probes were broken this
  way at once. See `.claude/rules/probes.md`.
- **`bg-codex-wiring.test.mjs` can time out under load** on the case
  "an interrupt the server accepts and never completes still ends the run",
  and pass on a re-run on an idle machine. Re-run a single failure there before
  believing it; it was seen failing once and passing twice in a row minutes
  later on 2026-09-20.
- **macOS has no `timeout` binary.** Never run a live probe unbounded.
  `perl -e 'alarm shift; exec @ARGV' 300 node <probe>` works because a pending
  alarm survives `exec`.
- **The README's test list drifts.** On 2026-09-20 it named every suite that
  existed when it was written and omitted nine that exist now. Take the suite
  set from the glob, not from the README.
