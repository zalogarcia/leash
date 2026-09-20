---
paths: scripts/probes/**/*.mjs
---

# Probes: the source slice, and how it breaks

A probe here does not import `bridge.mjs`. Importing it would boot a second
daemon against the live bot token. Instead each probe reads `bridge.mjs` as
text and a local `grab(name, kind)` helper cuts out one top level `function` or
`const` by matching the declaration line and taking every line up to the next
line that starts in column zero. The probe then joins the slices onto a harness
string that declares everything the sliced code expects to find around it, and
imports the result as a `data:text/javascript` module.

That gives real bridge.mjs code running against a real binary. It also means
the slice is a hand maintained list that nothing checks.

## The failure mode

When a helper moves out of a sliced function, or a sliced function starts
calling a new one, the assembled module still PARSES. Nothing fails at import.
It fails at call time with `ReferenceError: <name> is not defined`, and how
that presents depends on who catches it:

- caught nowhere: the probe dies on its first turn with a clear error.
- caught by a lane's own error handler: one log line, then the probe's
  `settled()` waits out its entire deadline and reports something unrelated,
  like "the turn never settled", four minutes later.

Both happened at once on 2026-09-20: `codex-chat-probe.mjs` died on
`codexAppServerUsable`, and `codex-appserver-probe.mjs` hung 240 seconds on a
swallowed `startAppServerChild`. A third, `settleReadingNotices`, was silently
ending EVERY turn with "[bridge] codex chat finish failed", so all five of that
probe's proofs were being read off half finished turns while it still exited 0.

## Rules

1. **Fix the probe, not `bridge.mjs`.** The slice is the thing that went stale.
   Changing the daemon to suit a probe is backwards, and in this repo it also
   risks diverging from the private sibling.
2. **Check the slice statically before running.** For each sliced function,
   list the identifiers it references and confirm each one is either declared
   in the harness, imported by the harness, or itself sliced. Cheaper than a
   four minute hang, and it finds the gaps a single run cannot: a
   `ReferenceError` only fires on the path that executes.
3. **Slice real code where it is cheap.** A helper with no dependencies belongs
   in the slice, not in the harness. Reserve harness definitions for the seams
   that would drag an unrelated subsystem in, and say in a comment what the
   seam is and why.
4. **Never stub what the probe exists to prove.** The binary, the login, the
   network and the protocol are the subject. A probe that stubs one of those is
   not evidence. A probe that cannot reach them reports that and exits non
   zero; it does not go green.
5. **Exit codes are the verdict.** `0` proven, `1` a proof that did not hold,
   `2` blocked before the subject could answer (usage limit, no login, no
   network). A probe that prints FAILED and exits 0 is worse than no probe,
   because a caller reading the code is told the opposite of the truth.
6. **Bound every run.** macOS ships no `timeout`. Use
   `perl -e 'alarm shift; exec @ARGV' 300 node <probe>`; a pending alarm
   survives `exec`.
7. **`grab()` closers.** It appends the terminating line only when that line
   starts with a closing bracket, so an array const ends `];` and an object or
   function ends `};`. A shape it does not recognise is sliced one line short
   and the assembled module dies on a syntax error.

## Which probes cost money

`steer-probe.mjs` is offline and free. `codex-chat-probe.mjs`,
`codex-appserver-probe.mjs` and `codex-bg-appserver-probe.mjs` all spawn the
REAL `codex` binary and spend tokens on the configured ChatGPT account. They
are not part of any gate and must never be put in a loop.
