#!/usr/bin/env bash
# The runnable projection of .claude/VERIFY.md.
#
# VERIFY.md is prose that has to be read and voluntarily obeyed. This is the
# same signals with exit codes. Change one, regenerate the other.
#
#   ./.claude/verify.sh                 the local gate (syntax, suites, shared modules, installer rehearsal)
#   ./.claude/verify.sh deploy <name>   the proof signal for one deploy surface (daemon | docs | all)
#   ./.claude/verify.sh harness         the traffic harness, if this repo had one
#   ./.claude/verify.sh probes-live     the two probes that spawn the real codex and SPEND MONEY
#   ./.claude/verify.sh --list          what is available
#
#   VERIFY_QUICK=1   skip the 36 offline suites, keep the fast gates
#
# One PASS / FAIL / SKIP line per check. Exit 0 only when nothing FAILed.
# A check that cannot run where it is run SKIPs and names the real command; it
# never silently passes.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

PASS=0
FAIL=0
SKIP=0
pass() { PASS=$((PASS + 1)); echo "PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
skip() { SKIP=$((SKIP + 1)); echo "SKIP $1 ($2)"; }

# macOS ships no `timeout`. A pending alarm survives exec, so perl is the
# portable stand in, and an unbounded live probe is how a caller ends up
# waiting four minutes for a swallowed error.
bounded() { perl -e 'alarm shift; exec @ARGV' "$@"; }

SERVICE_LABEL="${BRIDGE_SERVICE_LABEL:-com.claude-telegram-bridge}"

# ---------------------------------------------------------------------------
# local gate
# ---------------------------------------------------------------------------
local_gate() {
  if node --check bridge.mjs >/dev/null 2>&1; then
    pass "syntax bridge.mjs"
  else
    fail "syntax bridge.mjs"
  fi

  local bad=0 n=0 f
  for f in ./*.mjs scripts/probes/*.mjs; do
    n=$((n + 1))
    node --check "$f" >/dev/null 2>&1 || { bad=$((bad + 1)); echo "     bad syntax: $f"; }
  done
  if [ "$bad" -eq 0 ]; then pass "syntax all .mjs ($n files)"; else fail "syntax all .mjs ($bad of $n failed)"; fi

  bad=0
  n=0
  for f in ./*.sh scripts/*.sh; do
    n=$((n + 1))
    bash -n "$f" 2>/dev/null || { bad=$((bad + 1)); echo "     bad syntax: $f"; }
  done
  if [ "$bad" -eq 0 ]; then pass "syntax all .sh ($n files)"; else fail "syntax all .sh ($bad of $n failed)"; fi

  if [ "${VERIFY_QUICK:-0}" = "1" ]; then
    skip "offline suites" "VERIFY_QUICK=1; run: for f in test.mjs *.test.mjs; do node \"\$f\" || echo FAIL \$f; done"
  else
    local failed="" rc
    n=0
    for f in test.mjs ./*.test.mjs; do
      n=$((n + 1))
      bounded 300 node "$f" >/dev/null 2>&1
      rc=$?
      [ "$rc" -eq 0 ] || failed="$failed $(basename "$f")(exit=$rc)"
    done
    if [ -z "$failed" ]; then
      pass "offline suites ($n of $n)"
    else
      fail "offline suites:$failed"
      echo "     re-run a single failure before believing it: bg-codex-wiring.test.mjs can time out under load"
    fi
  fi

  # Offline, one second, no spend. The two LIVE probes are deliberately not here.
  if bounded 120 node scripts/probes/steer-probe.mjs >/dev/null 2>&1; then
    pass "probe steer-probe (offline)"
  else
    fail "probe steer-probe (offline)"
  fi
  skip "probes-live" "they spawn the real codex and spend money; run: ./.claude/verify.sh probes-live"

  # check-shared exits 2 when the sibling repo is simply not on this machine,
  # which is not a failure of this repo. Only exit 1 is drift.
  ./scripts/check-shared.sh >/tmp/verify-shared.$$ 2>&1
  case $? in
    0) pass "shared modules identical to the sibling repo (33)" ;;
    2) skip "shared modules" "sibling repo not found; run: BRIDGE_SIBLING_REPO=/path/to/sibling ./scripts/check-shared.sh" ;;
    *) fail "shared modules drifted"; grep '^DRIFT' /tmp/verify-shared.$$ | sed 's/^/     /' ;;
  esac
  rm -f /tmp/verify-shared.$$

  if ./install.sh --dry-run >/dev/null 2>&1; then
    pass "installer rehearsal (install.sh --dry-run)"
  else
    fail "installer rehearsal (install.sh --dry-run)"
  fi
}

# ---------------------------------------------------------------------------
# deploy surfaces
# ---------------------------------------------------------------------------
deploy_daemon() {
  if ! command -v launchctl >/dev/null 2>&1; then
    skip "deploy daemon: service loaded" "no launchctl on this platform"
  elif launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
    pass "deploy daemon: service $SERVICE_LABEL is loaded"
  else
    skip "deploy daemon: service loaded" "$SERVICE_LABEL is not installed here; run: ./install.sh"
  fi
  # The half that actually proves the RUNNING process is the new code cannot be
  # automated without a live bot token, and a loaded service is not that proof:
  # safe-restart.sh waits for idle and can still be waiting.
  skip "deploy daemon: the daemon answers" "needs a live bot token; run: node bridge.mjs --selftest 'Reply with exactly: OK'"
}

deploy_docs() {
  if [ ! -f docs/CNAME ]; then
    skip "deploy docs" "no docs/CNAME to derive the URL from"
    return
  fi
  local host code
  host="$(tr -d '[:space:]' < docs/CNAME)"
  if [ -z "$host" ]; then
    skip "deploy docs" "docs/CNAME is empty"
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    skip "deploy docs" "no curl; fetch https://$host and grep the served HTML"
    return
  fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "https://$host" 2>/dev/null)"
  case $? in
    0) : ;;
    6 | 7 | 28) skip "deploy docs: reachable" "network unreachable; run: curl -I https://$host"; return ;;
    *) skip "deploy docs: reachable" "curl could not run; run: curl -I https://$host"; return ;;
  esac
  if [ "$code" = "200" ]; then
    pass "deploy docs: https://$host serves 200"
  else
    fail "deploy docs: https://$host returned $code"
  fi
  # Reachability is not proof THIS change is live. That needs a string only the
  # change introduces, which only the person who made it can name.
  skip "deploy docs: this change is live" "grep the served HTML for a string unique to the change: curl -s https://$host | grep -F '<your string>'"
}

# ---------------------------------------------------------------------------
# the rest
# ---------------------------------------------------------------------------
harness() {
  skip "harness" "none. This daemon polls getUpdates and spawns local CLIs; it has no inbound HTTP boundary, so there is no vendor payload to fabricate. See VERIFY.md 'What this repo cannot prove offline' for the gap that IS real."
}

probes_live() {
  echo "these spawn the real codex and spend tokens on the configured ChatGPT account"
  local rc
  bounded 300 node scripts/probes/codex-chat-probe.mjs; rc=$?
  case $rc in
    0) pass "probe codex-chat: thread continuity proven" ;;
    2) skip "probe codex-chat" "exit 2: the probe ran and no answer came back (usage limit, no login, or no network). Mechanics proven, model not reached." ;;
    *) fail "probe codex-chat (exit $rc)" ;;
  esac
  bounded 300 node scripts/probes/codex-appserver-probe.mjs; rc=$?
  case $rc in
    0) pass "probe codex-appserver: proven end to end" ;;
    2) skip "probe codex-appserver" "exit 2: every structural proof held and no answer came back (usage limit, no login, or no network)." ;;
    *) fail "probe codex-appserver (exit $rc)" ;;
  esac
}

usage() {
  cat <<'USAGE'
local checks (default):
  syntax bridge.mjs · syntax all .mjs · syntax all .sh · offline suites (36)
  probe steer-probe · shared modules · installer rehearsal
deploy surfaces:
  daemon · docs · all
other modes:
  harness · probes-live
env:
  VERIFY_QUICK=1        skip the offline suites
  BRIDGE_SIBLING_REPO   where the private sibling repo is, for the shared module gate
  BRIDGE_SERVICE_LABEL  the LaunchAgent label, default com.claude-telegram-bridge
USAGE
}

case "${1:-}" in
  --list | -l) usage; exit 0 ;;
  deploy)
    case "${2:-all}" in
      daemon) deploy_daemon ;;
      docs) deploy_docs ;;
      all) deploy_daemon; deploy_docs ;;
      *) echo "unknown surface: ${2:-}" >&2; usage; exit 1 ;;
    esac
    ;;
  harness) harness ;;
  probes-live) probes_live ;;
  '') local_gate ;;
  *) echo "unknown mode: $1" >&2; usage; exit 1 ;;
esac

echo "VERIFY: $PASS/$((PASS + FAIL)) passed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
