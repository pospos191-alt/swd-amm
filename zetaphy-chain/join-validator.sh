#!/bin/bash
# Join the ZETAPHY testnet as a validator in one command (Ubuntu 24.04 server, x86_64 or arm64, with sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/install.sh | sudo bash -s -- validator
#
# Your own name:  ... | sudo MONIKER=my-name bash -s -- validator
#
#  1. downloads setup-node.sh and the zetaphyd that GitHub Actions built from it (SHA-256 checked)
#  2. sets up a node of the running chain (JOIN=rpc.sawasdeecoin.com); its faucet sends this node 10 ZETAPHY
#  3. a timer checks every 10 minutes: once the node has caught up and holds the coins, it stakes
#     9 ZETAPHY and becomes a validator by itself; then the timer stops
#
#   sudo zetaphy-validator status    height, sync, address, balance, validator state
#   sudo zetaphy-validator address   the address (send ZETAPHY here to stake more later)
#   sudo zetaphy-validator logs      setup and become-validator log lines
#   sudo zetaphy-validator unjail    back to work after being jailed for downtime
#   sudo zetaphy-validator backup    which files to copy somewhere safe (offline)
#
# Testnet only. Keys are made on this machine and never printed or sent anywhere.
set -euo pipefail

REPO="pospos191-alt/swd-amm"
REF="${REF:-main}"
JOIN="${JOIN:-rpc.sawasdeecoin.com}"
STAKE="${STAKE:-9}"                                   # ZETAPHY staked; the faucet gives 10, the rest pays fees
LIB="${LIB:-/usr/local/lib/zetaphy-validator}"        # setup-node.sh and the binary it was built from
SELF_BIN=/usr/local/bin/zetaphy-validator
NODE_USER="${NODE_USER:-zetaphy}"
NODE_HOME="${NODE_HOME:-/home/$NODE_USER/.zetaphy}"
KEYS_DIR="${KEYS_DIR:-/home/$NODE_USER/.zetaphy-genesis-keys}"
ZETAPHYD="${ZETAPHYD:-/usr/local/bin/zetaphyd}"
NODE="${NODE:-tcp://127.0.0.1:26657}"
STATE="${STATE:-/var/lib/zetaphy-validator}"          # done marker, faucet time
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
DENOM=azetaphy

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# Commands as the node user (the keyring and node home are theirs); as is when not root (tests).
asn() { if [ "$(id -u)" = 0 ] && id "$NODE_USER" >/dev/null 2>&1; then su -s /bin/bash "$NODE_USER" -c "cd ~ 2>/dev/null || cd /tmp; $*"; else bash -c "$*"; fi; }
K="--keyring-backend test --keyring-dir $KEYS_DIR"
zq() { asn "$ZETAPHYD $* --home $NODE_HOME --node $NODE -o json"; }
acc() { asn "$ZETAPHYD keys show validator -a $K --home $NODE_HOME"; }
valoper() { asn "$ZETAPHYD keys show validator --bech val -a $K --home $NODE_HOME"; }
hexaddr() { asn "$ZETAPHYD debug addr $(acc) --home $NODE_HOME" | awk '/Address hex/ {print $3}'; }
balance() { zq q bank balance "$(acc)" $DENOM | jq -r '.balance.amount // "0"'; }
# whole and 2-decimal ZETAPHY from azetaphy (no float rounding on 18-digit numbers)
zeta() { local a; a=$(printf '%019d' "${1:-0}"); echo "$((10#${a:0:${#a}-18})).${a:${#a}-18:2}"; }

install_all() {
  [ "$(id -u)" = 0 ] || die "run with sudo"
  command -v apt-get >/dev/null || die "this installer needs Ubuntu or Debian (apt-get)"
  need=(); for p in curl ca-certificates jq; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
  [ ${#need[@]} -eq 0 ] || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"; }
  local arch; case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac

  say "setup-node.sh and the prebuilt zetaphyd ($REPO@$REF)"
  install -d -m 755 "$LIB"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/zetaphy-chain/setup-node.sh" -o "$LIB/setup-node.sh"
  local s tag rel; s=$(sha256sum "$LIB/setup-node.sh" | cut -d' ' -f1); tag="zetaphyd-${s:0:12}"
  rel="https://github.com/$REPO/releases/download/$tag"
  rm -f "$LIB/SHA256SUMS" "$LIB/zetaphyd-linux-$arch"
  local binenv=()
  if curl -fsSL "$rel/SHA256SUMS" -o "$LIB/SHA256SUMS" && curl -fsSL "$rel/zetaphyd-linux-$arch" -o "$LIB/zetaphyd-linux-$arch"; then
    (cd "$LIB" && sha256sum -c --ignore-missing --quiet SHA256SUMS) || die "zetaphyd does not match the SHA-256 of release $tag: refused"
    chmod 755 "$LIB/zetaphyd-linux-$arch"
    binenv=(ZETAPHYD_BIN="$LIB/zetaphyd-linux-$arch")
    echo "release $tag, zetaphyd-linux-$arch: SHA-256 ok"
  else
    echo "no prebuilt zetaphyd for setup-node.sh ${s:0:12} yet: building from source (15-60 minutes, needs 2 GB RAM or swap)"
  fi
  [ -n "${DOWNLOAD_ONLY:-}" ] && { echo "DOWNLOAD_ONLY: stopping before the node setup"; return 0; }

  if [ -f "$NODE_HOME/config/genesis.json" ]; then
    say "a ZETAPHY node is already set up here: keeping it"
  else
    say "node of the running chain via $JOIN (log: /var/log/zetaphy-setup.log)"
    local menv=(); [ -n "${MONIKER:-}" ] && menv=(MONIKER="$MONIKER")
    env JOIN="$JOIN" "${binenv[@]}" "${menv[@]}" bash "$LIB/setup-node.sh" > /dev/null \
      || die "setup-node.sh failed: sudo tail -50 /var/log/zetaphy-setup.log"
  fi

  say "becomes a validator by itself once synced and funded"
  install -m 755 "${BASH_SOURCE[0]}" "$SELF_BIN" 2>/dev/null \
    || curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/zetaphy-chain/join-validator.sh" -o "$SELF_BIN"
  chmod 755 "$SELF_BIN"; install -d -m 700 "$STATE"
  cat > /etc/systemd/system/zetaphy-become-validator.service <<EOF
[Unit]
Description=ZETAPHY: stake and become a validator once synced and funded
After=zetaphyd.service

[Service]
Type=oneshot
Environment=JOIN=$JOIN STAKE=$STAKE${MONIKER:+ MONIKER=$MONIKER}
ExecStart=$SELF_BIN check
EOF
  cat > /etc/systemd/system/zetaphy-become-validator.timer <<EOF
[Unit]
Description=ZETAPHY: check every 10 minutes until this node is a validator

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
EOF
  $SYSTEMCTL daemon-reload
  $SYSTEMCTL enable --now zetaphy-become-validator.timer >/dev/null 2>&1
  rm -f "$STATE/done"
  say "done"
  cat <<EOF
Validator account: $(acc)   ($(hexaddr))
The node is syncing now. When it has caught up and holds $STAKE ZETAPHY or more (the faucet sent 10),
it stakes $STAKE ZETAPHY and becomes a validator by itself; nothing else to do.
  sudo zetaphy-validator status    progress
  sudo zetaphy-validator backup    the files to keep safe
Ports to open in the cloud firewall: 26656 (P2P), and 80/443 if this node serves a public RPC.
EOF
}

check() { # run by the timer: one step towards "validator", then the timer stops
  [ -f "$STATE/done" ] && { $SYSTEMCTL disable --now zetaphy-become-validator.timer >/dev/null 2>&1 || true; echo "already a validator"; return 0; }
  local v st need bal
  v=$(valoper)
  if zq q staking validator "$v" >/dev/null 2>&1; then
    mkdir -p "$STATE"; touch "$STATE/done"
    $SYSTEMCTL disable --now zetaphy-become-validator.timer >/dev/null 2>&1 || true
    echo "this node is a validator: $v"; return 0
  fi
  st=$(asn "$ZETAPHYD status --home $NODE_HOME --node $NODE" 2>/dev/null) || { echo "node not answering yet"; return 0; }
  if [ "$(echo "$st" | jq -r .sync_info.catching_up)" != false ]; then
    echo "syncing: block $(echo "$st" | jq -r .sync_info.latest_block_height)"; return 0
  fi
  bal=$(balance); need="${STAKE}100000000000000000"   # STAKE + 0.1 ZETAPHY for fees
  if [ "${#bal}" -lt "${#need}" ] || { [ "${#bal}" = "${#need}" ] && [[ "$bal" < "$need" ]]; }; then
    echo "waiting for funds: $(zeta "$bal") ZETAPHY, needs $(zeta "$need")"
    # Ask the faucet again at most once a day (it gives each address 10 ZETAPHY a day).
    mkdir -p "$STATE"
    if [ -z "$(find "$STATE/faucet" -mmin -1440 2>/dev/null)" ]; then
      touch "$STATE/faucet"
      curl -fsS "https://$JOIN" -H 'content-type: application/json' \
        --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"zetaphy_faucet\",\"params\":[\"$(hexaddr)\"]}" | jq -c '.error.message // "faucet: asked"' || true
    fi
    return 0
  fi
  echo "synced and funded: staking $STAKE ZETAPHY"
  bash "$LIB/setup-node.sh" --become-validator "$STAKE"
}

status() {
  local st v
  st=$(asn "$ZETAPHYD status --home $NODE_HOME --node $NODE" 2>/dev/null) || { echo "node: not answering (journalctl -u zetaphyd -n 30)"; return 1; }
  echo "block:     $(echo "$st" | jq -r .sync_info.latest_block_height)  (catching up: $(echo "$st" | jq -r .sync_info.catching_up))"
  echo "account:   $(acc)  ($(hexaddr))"
  echo "balance:   $(zeta "$(balance)") ZETAPHY"
  v=$(valoper)
  if vj=$(zq q staking validator "$v" 2>/dev/null); then
    echo "validator: $v  $(echo "$vj" | jq -r '.validator | "\(.status | sub("BOND_STATUS_"; "")), jailed: \(.jailed // false), stake: \(.tokens)"')"
  else
    echo "validator: not yet (the timer stakes $STAKE ZETAPHY once synced and funded)"
  fi
}

case "${1:-install}" in
  install|validator) install_all ;;
  check) check ;;
  status) status ;;
  address) echo "$(acc)  $(hexaddr)" ;;
  logs) journalctl -u zetaphy-become-validator -n "${2:-30}" --no-pager; tail -n 5 /var/log/zetaphy-setup.log 2>/dev/null || true ;;
  unjail) asn "$ZETAPHYD tx slashing unjail --from validator $K --home $NODE_HOME --node $NODE --chain-id zetaphy_77390-1 --gas auto --gas-adjustment 1.5 --gas-prices 1000000000$DENOM -y -o json" | jq -c '{code, txhash, raw_log}' ;;
  backup) cat <<EOF
Copy these somewhere safe and offline (USB / paper), never into a chat or e-mail:
  $NODE_HOME/config/priv_validator_key.json   the validator's signing key
  $NODE_HOME/config/pq_vote_key.seed          its ML-DSA vote key
  $KEYS_DIR/MNEMONICS-KEEP-SECRET.txt         the 24 words of the staking account
Never run two machines with the same priv_validator_key.json: that is double signing (slashed, jailed for good).
EOF
  ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
