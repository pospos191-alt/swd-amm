#!/usr/bin/env bash
# Go part of the audit: the ZETAPHY chain patches (zetaphy-chain/setup-node.sh)
# applied to the pinned Cosmos EVM source, exactly as CI and the servers do,
# then staticcheck + gosec + govulncheck (+ `go test -race` on the small
# packages ZETAPHY wrote). Raw outputs land in $OUT/raw/go/; report.js keeps
# only findings on lines the ZETAPHY patches added (audit/tools/zetaphy-lines.js).
#
#   audit/tools/go-scan.sh <repo root> <out dir> [fast|deep]
# Env: SRC=<existing patched cosmos/evm checkout> skips the clone + patch.
#
# Already elsewhere (not repeated here): security.yml runs the fork tests,
# fuzzing and a pass/fail gosec on every chain change; zetaphy-chain-upstream.yml
# runs govulncheck weekly. This script adds staticcheck, machine-readable
# gosec/govulncheck output for the audit report, and the race detector.
set -uo pipefail
ROOT=$(cd "$1" && pwd); OUT=$2; TIER=${3:-fast}
mkdir -p "$OUT/raw/go"; OUT=$(cd "$OUT" && pwd)
STATICCHECK_VERSION=v0.7.0 # = 2026.1 (2026.2 needs Go 1.26; the chain pins Go 1.25.9)
GOSEC_VERSION=v2.22.8
GOVULNCHECK_VERSION=v1.1.4
status() { echo "$1" >> "$OUT/raw/go/status.txt"; echo "go-scan: $1"; }
: > "$OUT/raw/go/status.txt"

if [ -z "${SRC:-}" ]; then
  SRC="$OUT/work/cosmos-evm"
  tag=$(sed -n 's/^COSMOS_EVM_TAG="\(.*\)"/\1/p' "$ROOT/zetaphy-chain/setup-node.sh")
  commit=$(sed -n 's/^COSMOS_EVM_COMMIT="\(.*\)"/\1/p' "$ROOT/zetaphy-chain/setup-node.sh")
  rm -rf "$SRC"; mkdir -p "$(dirname "$SRC")"
  git clone -q --depth 1 --branch "$tag" https://github.com/cosmos/evm.git "$SRC" || { status "clone failed"; exit 0; }
  [ "$(git -C "$SRC" rev-parse HEAD)" = "$commit" ] || { status "cosmos/evm $tag is not the pinned commit $commit"; exit 1; }
  (cd "$ROOT" && bash zetaphy-chain/setup-node.sh --patch-source "$SRC") || { status "patching failed"; exit 1; }
fi
echo "$SRC" > "$OUT/raw/go/src.txt"
node "$ROOT/audit/tools/zetaphy-lines.js" "$ROOT/zetaphy-chain/setup-node.sh" > "$OUT/raw/go/zetaphy-lines.json"

GOBIN="$OUT/work/gobin"; mkdir -p "$GOBIN"; export PATH="$GOBIN:$PATH"
# `go install pkg@version` checks every module against Go's checksum database.
[ "$TIER" = deep ] && { GOBIN="$GOBIN" go install "honnef.co/go/tools/cmd/staticcheck@$STATICCHECK_VERSION" || status "staticcheck install failed"; }
GOBIN="$GOBIN" go install "github.com/securego/gosec/v2/cmd/gosec@$GOSEC_VERSION" || status "gosec install failed"
GOBIN="$GOBIN" go install "golang.org/x/vuln/cmd/govulncheck@$GOVULNCHECK_VERSION" || status "govulncheck install failed"
go version > "$OUT/raw/go/go-version.txt"

# The packages ZETAPHY code lives in (root module + evmd module).
ROOT_PKGS="./crypto/mldsa44/... ./precompiles/mldsa/... ./precompiles/types/... ./x/ratelimit/... ./x/vm/keeper/... ./x/vm/types/... ./ante/... ./mempool/... ./crypto/codec/..."
# evmd: the app package (the zetaphy_*.go files), its command and config, not the
# whole module (gosec on evmd/... needs >15 GB of memory).
EVMD_PKGS=". ./cmd/evmd/cmd ./config"
t0=$(date +%s)
# staticcheck: deep tier (its first run type-checks all of Cosmos SDK: ~7 min).
if [ "$TIER" = deep ] && command -v staticcheck >/dev/null; then
  (cd "$SRC" && staticcheck -f json $ROOT_PKGS > "$OUT/raw/go/staticcheck-root.json" 2> "$OUT/raw/go/staticcheck-root.err")
  (cd "$SRC/evmd" && staticcheck -f json $EVMD_PKGS > "$OUT/raw/go/staticcheck-evmd.json" 2> "$OUT/raw/go/staticcheck-evmd.err")
  status "staticcheck $STATICCHECK_VERSION ran ($(( $(date +%s) - t0 ))s)"
fi
t0=$(date +%s)
if command -v gosec >/dev/null; then
  (cd "$SRC" && gosec -quiet -no-fail -exclude-generated -fmt json -out "$OUT/raw/go/gosec-root.json" $ROOT_PKGS)
  (cd "$SRC/evmd" && gosec -quiet -no-fail -exclude-generated -fmt json -out "$OUT/raw/go/gosec-evmd.json" $EVMD_PKGS)
  status "gosec $GOSEC_VERSION ran ($(( $(date +%s) - t0 ))s)"
fi
t0=$(date +%s)
# govulncheck: deep tier (it also runs weekly in zetaphy-chain-upstream.yml).
if [ "$TIER" = deep ] && command -v govulncheck >/dev/null; then
  (cd "$SRC/evmd" && govulncheck -format json ./... > "$OUT/raw/go/govulncheck.json" 2> "$OUT/raw/go/govulncheck.err")
  if grep -q 'fetching vulnerabilities' "$OUT/raw/go/govulncheck.err"; then
    status "govulncheck FAILED: vulnerability database unreachable ($(head -c 200 "$OUT/raw/go/govulncheck.err"))"; rm -f "$OUT/raw/go/govulncheck.json"
  else status "govulncheck $GOVULNCHECK_VERSION ran ($(( $(date +%s) - t0 ))s)"; fi
fi
# The race detector on ZETAPHY's own small packages (cheap: no app wiring).
t0=$(date +%s)
race_pkgs="./crypto/mldsa44/ ./precompiles/mldsa/"
cp -r "$ROOT/zetaphy-chain/fork-tests/crypto" "$ROOT/zetaphy-chain/fork-tests/precompiles" "$SRC/" 2>/dev/null
if (cd "$SRC" && go test -race -count=1 $race_pkgs > "$OUT/raw/go/race.txt" 2>&1); then
  status "go test -race passed ($(( $(date +%s) - t0 ))s)"; echo pass > "$OUT/raw/go/race.result"
else
  status "go test -race FAILED ($(( $(date +%s) - t0 ))s)"; echo fail > "$OUT/raw/go/race.result"
fi
exit 0
