#!/bin/bash
# ZETAPHY: one command to set up a server (Ubuntu/Debian, with sudo). Pick what to run:
#
#   curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/install.sh | sudo bash -s -- runner
#
#   runner   a Neuro runner: takes Neuro jobs and earns ZETAPHY (needs a 100 ZETAPHY testnet bond)
#   agents   the Hyperlane validator for ZETAPHY Saphan (EVM route); the relayer starts later
#
# Several at once: ... | sudo bash -s -- runner agents
# Safe to run again (it updates and keeps the keys). Testnet only.
set -euo pipefail
REPO="pospos191-alt/swd-amm"
REF="${REF:-main}"
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo (… | sudo bash -s -- runner)" >&2; exit 1; }
[ $# -gt 0 ] || { sed -n '2,11p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null || echo "usage: install.sh runner|agents"; exit 1; }

run() { # run <path in the repo> [args…]: download that script (pinned to $REF) and run it
  local f; f=$(mktemp); curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/$1" -o "$f"; shift
  REF="$REF" bash "$f" "$@"; local code=$?; rm -f "$f"; return $code
}

for role in "$@"; do
  case "$role" in
    runner) run zetaphy-network/setup-runner.sh install ;;
    agents) run zetaphy-chain/hyperlane/setup-agents.sh ;;
    *) echo "unknown role '$role': runner or agents" >&2; exit 1 ;;
  esac
done
