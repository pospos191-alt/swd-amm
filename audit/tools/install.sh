#!/usr/bin/env bash
# Installs the audit tools, each at a pinned version and checked against a
# pinned SHA-256 (binaries) or pip's --require-hashes lock (Python tools).
# Free and open source, from the projects' own releases. Nothing else.
#
#   audit/tools/install.sh <dir> [fast|deep]
# Puts binaries in <dir>/bin, a Python venv in <dir>/venv and the Semgrep
# rules in <dir>/semgrep-rules; prints the PATH / LD_LIBRARY_PATH lines to add
# (CI appends them to $GITHUB_ENV / $GITHUB_PATH).
#
# Updating a tool: change its version AND its sha256 here in the same commit,
# taking the hash from the project's release page / SHA256SUMS file.
set -euo pipefail
DIR=$(mkdir -p "$1" && cd "$1" && pwd); TIER=${2:-fast}
HERE=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$DIR/bin"

SOLC_VERSION=0.8.26
SOLC_SHA256=d5f23436f443edb85d8e76906d12f0a86ce0490e7663a9e608efeb7a93f149ef      # = solc-bin list.json
ADERYN_VERSION=0.6.8
ADERYN_SHA256=ffd6ca658962e211a3ac821c646f69c8e14bf1b1001cbfe091bcd4535a691e46    # = the release's .sha256
OSV_VERSION=2.7.0
OSV_SHA256=160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b       # = the release's SHA256SUMS
FOUNDRY_VERSION=1.2.3   # the same anvil/forge as the other workflows
FOUNDRY_SHA256=8202f38f1635c2793b2d1a4fe443ae6f7315190dc6eed219d7969a40ab78a286
MEDUSA_VERSION=1.5.1
MEDUSA_SHA256=ddfe1517ae9028ef9fc331b00f5a6a9d5406f3fcd11a715d60c6b6fb3e4546d3
ECHIDNA_VERSION=2.3.3
ECHIDNA_SHA256=436d26cb5af34c6c525812b857ac53f218c7f6ad07d69495ef88bc4cdc85c764
# Decurity's open-source Semgrep rules for Solidity, at a fixed commit.
SEMGREP_RULES_COMMIT=2e878a89ac7bba1f8435e8a68e3ecb7700096cd5

fetch() { # url sha256 dest
  local tmp; tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/f" "$1"
  echo "$2  $tmp/f" | sha256sum -c --quiet - || { echo "SHA-256 mismatch for $1"; exit 1; }
  mv "$tmp/f" "$3"; rmdir "$tmp"
}
untar() { # url sha256 [tar flags]
  local tmp; tmp=$(mktemp -d)
  fetch "$1" "$2" "$tmp/a"
  tar "${3:-xzf}" "$tmp/a" -C "$tmp"; rm "$tmp/a"
  find "$tmp" -type f -perm -u+x -exec mv {} "$DIR/bin/" \;
  rm -rf "$tmp"
}

[ -x "$DIR/bin/solc" ] || { fetch "https://github.com/ethereum/solidity/releases/download/v$SOLC_VERSION/solc-static-linux" "$SOLC_SHA256" "$DIR/bin/solc"; chmod +x "$DIR/bin/solc"; }
# forge reads solc from ~/.svm/<v>/solc-<v>, and the suites' foundry.toml set `offline = true` (no
# download at test time): put the SAME verified binary there (replacing anything that does not match).
SVM_DIR="${SVM_HOME:-$HOME/.svm}/$SOLC_VERSION"
if ! echo "$SOLC_SHA256  $SVM_DIR/solc-$SOLC_VERSION" | sha256sum -c --quiet - 2>/dev/null; then
  mkdir -p "$SVM_DIR"; cp "$DIR/bin/solc" "$SVM_DIR/solc-$SOLC_VERSION"; chmod +x "$SVM_DIR/solc-$SOLC_VERSION"
fi
[ -x "$DIR/bin/aderyn" ] || untar "https://github.com/cyfrin/aderyn/releases/download/aderyn-v$ADERYN_VERSION/aderyn-x86_64-unknown-linux-gnu.tar.xz" "$ADERYN_SHA256" xJf
[ -x "$DIR/bin/osv-scanner" ] || { fetch "https://github.com/google/osv-scanner/releases/download/v$OSV_VERSION/osv-scanner_linux_amd64" "$OSV_SHA256" "$DIR/bin/osv-scanner"; chmod +x "$DIR/bin/osv-scanner"; }
# forge: the invariant suites (a smoke run in the fast tier, the full run in deep)
[ -x "$DIR/bin/forge" ] || untar "https://github.com/foundry-rs/foundry/releases/download/v$FOUNDRY_VERSION/foundry_v${FOUNDRY_VERSION}_linux_amd64.tar.gz" "$FOUNDRY_SHA256"
if [ "$TIER" = deep ] || [ -n "${WITH_FUZZERS:-}" ]; then
  [ -x "$DIR/bin/medusa" ] || untar "https://github.com/crytic/medusa/releases/download/v$MEDUSA_VERSION/medusa-linux-x64.tar.gz" "$MEDUSA_SHA256"
  [ -x "$DIR/bin/echidna" ] || untar "https://github.com/crytic/echidna/releases/download/v$ECHIDNA_VERSION/echidna-$ECHIDNA_VERSION-x86_64-linux.tar.gz" "$ECHIDNA_SHA256"
fi

if [ ! -x "$DIR/venv/bin/slither" ]; then
  python3 -m venv "$DIR/venv"
  "$DIR/venv/bin/pip" install -q --disable-pip-version-check --require-hashes -r "$HERE/requirements.lock"
fi
if [ ! -d "$DIR/semgrep-rules/solidity" ]; then
  mkdir -p "$DIR/semgrep-rules"
  git -C "$DIR/semgrep-rules" init -q
  git -C "$DIR/semgrep-rules" fetch -q --depth 1 https://github.com/Decurity/semgrep-smart-contracts "$SEMGREP_RULES_COMMIT"
  git -C "$DIR/semgrep-rules" checkout -q FETCH_HEAD
fi

Z3LIB=$(echo "$DIR"/venv/lib/python3*/site-packages/z3/lib)
echo "PATH=$DIR/bin:$DIR/venv/bin:\$PATH"
echo "LD_LIBRARY_PATH=$Z3LIB"
echo "SEMGREP_RULES=$DIR/semgrep-rules"
