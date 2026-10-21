#!/bin/bash
# ZETAPHY <-> Noble IBC relayer (Hermes), run on the ZETAPHY node.
#
# Brings real USDC from Noble (Circle's Cosmos chain) to ZETAPHY over IBC.
# Run it on the Oracle node (Cloud Shell -> ssh ubuntu@<IP>), with sudo:
#
#   sudo bash setup-relayer.sh                 install Hermes (pinned, SHA-256 checked), the
#                                              "relayer" user, its config and its two keys;
#                                              prints the two addresses to fund (never a key)
#   sudo bash setup-relayer.sh create-channel  light clients + connection + transfer channel
#   sudo bash setup-relayer.sh start|stop      the relayer as a systemd service (hermes-relayer)
#   sudo bash setup-relayer.sh status          service, channel, health check, balances, last log lines
#   sudo bash setup-relayer.sh balances        gas left on each side (and USDC on Noble)
#   sudo bash setup-relayer.sh addresses       the two relayer addresses again
#   sudo bash setup-relayer.sh send-usdc <0x…|zetaphy1…> <uusdc>
#                                              send USDC from the relayer's Noble address to an
#                                              address on ZETAPHY (1 USDC = 1000000 uusdc)
#   sudo bash setup-relayer.sh config          rewrite the Hermes config (after changing a setting)
#
# Safe to re-run: every step checks what is already there. The keys are made
# on this machine from fresh system entropy, imported into Hermes' key store
# (readable only by the relayer user) and the temporary seed file is shredded:
# nothing secret is printed, logged or sent anywhere.
# Docs (Thai): zetaphy-chain/ibc/README.md
set -euo pipefail

# ---- Hermes (pinned) -------------------------------------------------------
# github.com/informalsystems/hermes release v1.13.3 (tag commit bab3b80, the
# binary reports "1.13.2+bab3b80"). The release publishes no checksum file:
# these SHA-256 sums were taken from the release tarballs on 21 Oct 2026, and a
# download that does not match is refused.
HERMES_VERSION="v1.13.3"
HERMES_REPORTS="1.13.2+bab3b80"   # what "hermes version" prints for this build
declare -A HERMES_SHA256=(
  [x86_64]="3582136824ac1984c8884b310c63940a1489f091fa45faca38ed80e5dfe7d51b"
  [aarch64]="c586ac5e8d6bbeffff271e0f28b356488f5b44c58d5b25386c0051ddcf84af4d"
)

RELAYER_USER="${RELAYER_USER:-relayer}"
HERMES_HOME="${HERMES_HOME:-/home/$RELAYER_USER/.hermes}"
# Settings given once as env vars (e.g. sudo NOBLE_RPC=https://… bash setup-relayer.sh config)
# are kept here, so later runs (create-channel, start) keep them. Env wins.
SETTINGS="$HERMES_HOME/settings.env"
if [ -r "$SETTINGS" ]; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^(ZETAPHY|NOBLE)_[A-Z_]+$ ]] && [ -z "${!k:-}" ] && printf -v "$k" '%s' "$v"
  done < "$SETTINGS"
fi

# ---- This node (defaults match setup-node.sh) ------------------------------
ZETAPHYD="${ZETAPHYD:-/usr/local/bin/zetaphyd}"
ZETAPHY_CHAIN_ID="${ZETAPHY_CHAIN_ID:-zetaphy_77390-1}"
ZETAPHY_RPC="${ZETAPHY_RPC:-http://127.0.0.1:26657}"   # local only (setup-node.sh)
ZETAPHY_GRPC="${ZETAPHY_GRPC:-http://127.0.0.1:9090}"  # local only
ZETAPHY_DENOM="azetaphy"
ZETAPHY_GAS_PRICE="${ZETAPHY_GAS_PRICE:-2000000000}"   # azetaphy/gas: 2 gwei (the node's minimum is 1)
ZETAPHY_TRUSTING="${ZETAPHY_TRUSTING:-14days}"          # 2/3 of the 21-day unbonding period

# ---- Noble testnet ---------------------------------------------------------
# Chain id: noble-assets/noble upgrade/constants.go (TestnetChainID = "grand-1").
# Endpoints, gas price, bech32 prefix, coin type: cosmos/chain-registry
# testnets/nobletestnet/chain.json. Override any of them with an env var.
NOBLE_CHAIN_ID="${NOBLE_CHAIN_ID:-grand-1}"
NOBLE_RPC="${NOBLE_RPC:-https://noble-testnet-rpc.polkachu.com:443}"
NOBLE_WS="${NOBLE_WS:-}"                                # default: <NOBLE_RPC>/websocket (wss)
NOBLE_GRPC="${NOBLE_GRPC:-http://noble-testnet-grpc.polkachu.com:21590}"
NOBLE_PREFIX="${NOBLE_PREFIX:-noble}"
NOBLE_FEE_DENOM="${NOBLE_FEE_DENOM:-uusdc}"             # Noble's gas is paid in USDC
NOBLE_GAS_PRICE="${NOBLE_GAS_PRICE:-0.1}"               # registry: testnet 0.01-0.03, mainnet 0.1 (safe on both)
NOBLE_TRUSTING="${NOBLE_TRUSTING:-14days}"              # registry: 21-day unbonding
NOBLE_EVENTS="${NOBLE_EVENTS:-push}"                    # push (websocket) or pull (polls /block_results)
NOBLE_HD_PATH="${NOBLE_HD_PATH:-}"                       # default: coin type 118 (registry slip44)
[ -n "$NOBLE_HD_PATH" ] || NOBLE_HD_PATH="m/44'/118'/0'/0/0"
# Test hook: a second ZETAPHY devnet stands in for Noble (ethermint keys).
NOBLE_KEY_TYPE="${NOBLE_KEY_TYPE:-cosmos}"
USDC_DENOM="${USDC_DENOM:-uusdc}"

HERMES_BIN="${HERMES_BIN:-/usr/local/bin/hermes}"
MEMO="${MEMO:-ZETAPHY relayer}"
KEY_NAME="relayer"
UNIT="hermes-relayer"

# Test hooks (leave unset on Oracle): AS_SELF=1 runs everything as the calling
# user (no relayer user, no sudo); NO_SYSTEMD=1 runs Hermes in the background
# instead of as a service; HERMES_TARBALL=<release .tar.gz already downloaded>
# skips the download (its SHA-256 is still checked).
AS_SELF="${AS_SELF:-}"
NO_SYSTEMD="${NO_SYSTEMD:-}"
HERMES_TARBALL="${HERMES_TARBALL:-}"

CFG="$HERMES_HOME/config.toml"
CHAN="$HERMES_HOME/channel.env"     # ZETAPHY_CHANNEL=channel-N, NOBLE_CHANNEL=channel-M
LOGF="$HERMES_HOME/hermes.log"      # NO_SYSTEMD only; the service logs to journald

use_systemd() { [ -z "$NO_SYSTEMD" ] && [ -d /run/systemd/system ]; }
as_relayer() {
  if [ -n "$AS_SELF" ]; then bash -c "$*"; else su -s /bin/bash "$RELAYER_USER" -c "$*"; fi
}
hermes() { as_relayer "'$HERMES_BIN' --config '$CFG' $*"; }
need_root() { [ -n "$AS_SELF" ] || [ "$(id -u)" = 0 ] || { echo "run with sudo: sudo bash $0 ${1:-}"; exit 1; }; }

install_hermes() {
  if [ -x "$HERMES_BIN" ] && "$HERMES_BIN" version 2>/dev/null | grep -qF "hermes $HERMES_REPORTS"; then
    echo "hermes $HERMES_VERSION already installed"; return
  fi
  local arch sum tmp tgz
  arch=$(uname -m); sum=${HERMES_SHA256[$arch]:-}
  [ -n "$sum" ] || { echo "no pinned Hermes build for $arch (x86_64 or aarch64)"; exit 1; }
  command -v curl >/dev/null && command -v jq >/dev/null || { apt-get update -y && apt-get install -y curl jq; }
  tmp=$(mktemp -d)
  tgz=$tmp/hermes.tar.gz
  if [ -n "$HERMES_TARBALL" ]; then
    cp "$HERMES_TARBALL" "$tgz"   # check and extract the same private copy
  else
    curl -fsSL --retry 3 -o "$tgz" \
      "https://github.com/informalsystems/hermes/releases/download/$HERMES_VERSION/hermes-$HERMES_VERSION-$arch-unknown-linux-gnu.tar.gz"
  fi
  echo "$sum  $tgz" | sha256sum -c --quiet - || { rm -rf "$tmp"; echo "Hermes download does not match the pinned SHA-256: refused"; exit 1; }
  tar -xzf "$tgz" -C "$tmp" hermes
  install -m 755 "$tmp/hermes" "$HERMES_BIN"
  rm -rf "$tmp"
  "$HERMES_BIN" version 2>/dev/null | tail -1
}

make_user() {
  [ -n "$AS_SELF" ] && { mkdir -p "$HERMES_HOME"; chmod 700 "$HERMES_HOME"; return; }
  id "$RELAYER_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$RELAYER_USER"
  as_relayer "mkdir -p '$HERMES_HOME' && chmod 700 '$HERMES_HOME'"
}

# One [[chains]] entry. $1 id, $2 rpc, $3 ws, $4 grpc, $5 prefix, $6 address type,
# $7 gas price, $8 fee denom, $9 trusting period, $10 channel to relay (or ""), $11 event mode,
# $12 extra lines (or "").
chain_toml() {
  local events="{ mode = 'push', url = '$3', batch_delay = '500ms' }"
  [ "${11}" = pull ] && events="{ mode = 'pull', interval = '1s' }"
  cat <<TOML

[[chains]]
id = '$1'
type = 'CosmosSdk'
rpc_addr = '$2'
grpc_addr = '$4'
event_source = $events
rpc_timeout = '15s'
trusted_node = false
account_prefix = '$5'
key_name = '$KEY_NAME'
key_store_folder = '$HERMES_HOME/keys'
address_type = $6
store_prefix = 'ibc'
default_gas = 300000
max_gas = 3000000
gas_price = { price = $7, denom = '$8' }
gas_multiplier = 1.3
max_msg_num = 30
max_tx_size = 180000
clock_drift = '10s'
max_block_time = '30s'
trusting_period = '$9'
trust_threshold = '2/3'
memo_prefix = '$MEMO'
TOML
  [ -n "${12}" ] && echo "${12}"
  # Once the channel exists, relay that channel only.
  [ -n "${10}" ] && printf "\n[chains.packet_filter]\npolicy = 'allow'\nlist = [['transfer', '%s']]\n" "${10}"
  return 0
}

write_config() {
  local zc="" nc="" ws=$NOBLE_WS noble_type
  [ -f "$CHAN" ] && { zc=$(sed -n 's/^ZETAPHY_CHANNEL=//p' "$CHAN"); nc=$(sed -n 's/^NOBLE_CHANNEL=//p' "$CHAN"); }
  [ -n "$ws" ] || ws="$(echo "$NOBLE_RPC" | sed -E 's#^http#ws#; s#:443$##; s#/$##')/websocket"
  # ZETAPHY keys are eth_secp256k1 (Cosmos EVM): Ethereum address derivation and
  # keccak signing, under the cosmos/evm public key type.
  local eth="{ derivation = 'ethermint', proto_type = { pk_type = '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey' } }"
  noble_type="{ derivation = 'cosmos' }"
  [ "$NOBLE_KEY_TYPE" = ethermint ] && noble_type=$eth
  local tmp; tmp=$(mktemp)
  {
    cat <<TOML
# Written by zetaphy-chain/ibc/setup-relayer.sh; re-run "setup-relayer.sh config" instead of editing.
[global]
log_level = 'info'

[mode.clients]
enabled = true
refresh = true
misbehaviour = true

[mode.connections]
enabled = false

[mode.channels]
enabled = false

[mode.packets]
enabled = true
clear_interval = 100
clear_on_start = true
tx_confirmation = false

[rest]
enabled = false
host = '127.0.0.1'
port = 3000

# Local only: Prometheus metrics (wallet_balance, packets relayed, errors).
[telemetry]
enabled = true
host = '127.0.0.1'
port = 3001
TOML
    chain_toml "$ZETAPHY_CHAIN_ID" "$ZETAPHY_RPC" "$(echo "$ZETAPHY_RPC" | sed -E 's#^http#ws#')/websocket" "$ZETAPHY_GRPC" \
      zetaphy "$eth" "$ZETAPHY_GAS_PRICE" "$ZETAPHY_DENOM" "$ZETAPHY_TRUSTING" "$zc" push \
      "compat_mode = '0.37'"   # CometBFT v0.39: Hermes 1.13 cannot infer it; its 0.37 mode works
    chain_toml "$NOBLE_CHAIN_ID" "$NOBLE_RPC" "$ws" "$NOBLE_GRPC" \
      "$NOBLE_PREFIX" "$noble_type" "$NOBLE_GAS_PRICE" "$NOBLE_FEE_DENOM" "$NOBLE_TRUSTING" "$nc" "$NOBLE_EVENTS" ""
  } > "$tmp"
  as_relayer "cat > '$CFG.tmp'" < "$tmp" && rm -f "$tmp"
  as_relayer "chmod 600 '$CFG.tmp' && mv '$CFG.tmp' '$CFG'"
  for k in ZETAPHY_CHAIN_ID ZETAPHY_RPC ZETAPHY_GRPC ZETAPHY_GAS_PRICE ZETAPHY_TRUSTING NOBLE_CHAIN_ID NOBLE_RPC NOBLE_WS \
           NOBLE_GRPC NOBLE_PREFIX NOBLE_FEE_DENOM NOBLE_GAS_PRICE NOBLE_TRUSTING NOBLE_EVENTS NOBLE_HD_PATH NOBLE_KEY_TYPE; do
    printf '%s=%s\n' "$k" "${!k}"
  done | as_relayer "umask 077 && cat > '$SETTINGS'"
  hermes config validate >/dev/null 2>&1 || { hermes config validate || true; echo "Hermes rejected $CFG"; exit 1; }
}

key_address() { # $1 chain id: the relayer's address on it, or nothing
  hermes --json keys list --chain "$1" 2>/dev/null | jq -r "select(.result != null) | .result.$KEY_NAME.account // empty" 2>/dev/null | tail -1
}

# A fresh key for $1 (chain id) with HD path $2: a 24-word seed from this
# machine's entropy goes into a 0600 temp file only the relayer user reads,
# Hermes imports it, and the file is shredded. Nothing is printed.
make_key() {
  [ -n "$(key_address "$1")" ] && return
  local f
  f=$(as_relayer "umask 077 && mktemp '$HERMES_HOME/.seed.XXXXXX'")
  as_relayer "umask 077 && '$ZETAPHYD' keys mnemonic --home '$HERMES_HOME/.zhome' > '$f' 2>/dev/null"
  [ "$(wc -w < "$f")" = 24 ] || { as_relayer "shred -u '$f'"; echo "could not make a seed"; exit 1; }
  hermes keys add --chain "$1" --key-name "$KEY_NAME" --mnemonic-file "'$f'" --hd-path "\"$2\"" >/dev/null 2>&1 \
    || { as_relayer "shred -u '$f'"; echo "hermes keys add failed for $1"; exit 1; }
  as_relayer "shred -u '$f'; rm -rf '$HERMES_HOME/.zhome'"
}

addresses() {
  local z n hex
  z=$(key_address "$ZETAPHY_CHAIN_ID"); n=$(key_address "$NOBLE_CHAIN_ID")
  hex=$("$ZETAPHYD" debug addr "$z" 2>/dev/null | awk '/Address hex/ {print $3}' || true)
  cat <<INFO
Relayer addresses (public; fund them, never share anything else):
  ZETAPHY ($ZETAPHY_CHAIN_ID):  $z
                                 0x${hex#0x}  (the same account in MetaMask)
  Noble   ($NOBLE_CHAIN_ID):  $n
INFO
}

channel_open() { # is the saved channel open on ZETAPHY?
  [ -f "$CHAN" ] || return 1
  local zc; zc=$(sed -n 's/^ZETAPHY_CHANNEL=//p' "$CHAN")
  hermes --json query channel end --chain "$ZETAPHY_CHAIN_ID" --port transfer --channel "$zc" 2>/dev/null \
    | jq -e 'select(.result != null) | .result.state | ascii_downcase | test("open")' >/dev/null 2>&1
}

running() {
  if use_systemd; then systemctl is-active --quiet "$UNIT"
  else [ -f "$HERMES_HOME/hermes.pid" ] && kill -0 "$(cat "$HERMES_HOME/hermes.pid")" 2>/dev/null; fi
}

start() {
  [ -f "$CHAN" ] || { echo "no channel yet: run create-channel first"; exit 1; }
  if use_systemd; then
    cat > /etc/systemd/system/$UNIT.service <<UNIT
[Unit]
Description=ZETAPHY <-> Noble IBC relayer (Hermes $HERMES_VERSION)
After=network-online.target zetaphyd.service
Wants=network-online.target

[Service]
User=$RELAYER_USER
ExecStart=$HERMES_BIN --config $CFG start
Restart=always
RestartSec=10
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$HERMES_HOME
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable "$UNIT" >/dev/null 2>&1
    systemctl restart "$UNIT"
  else
    running && return 0
    as_relayer "nohup '$HERMES_BIN' --config '$CFG' start >> '$LOGF' 2>&1 & echo \$! > '$HERMES_HOME/hermes.pid'"
  fi
  echo "relayer started"
}

stop() {
  if use_systemd; then systemctl stop "$UNIT" 2>/dev/null || true
  elif [ -f "$HERMES_HOME/hermes.pid" ]; then
    pid=$(cat "$HERMES_HOME/hermes.pid"); rm -f "$HERMES_HOME/hermes.pid"
    # the pid file is writable by the relayer user: only stop a Hermes process
    if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$(readlink "/proc/$pid/exe" 2>/dev/null)" = "$(readlink -f "$HERMES_BIN")" ]; then kill "$pid" 2>/dev/null || true; fi
  fi
  echo "relayer stopped"
}

balances() {
  echo "ZETAPHY gas:  $(hermes keys balance --chain "$ZETAPHY_CHAIN_ID" 2>/dev/null | grep -oE '[0-9]+ ?azetaphy' | head -1 || echo '?')"
  echo "Noble:        $(hermes keys balance --chain "$NOBLE_CHAIN_ID" --all 2>/dev/null | grep -oE "[0-9]+ ?($NOBLE_FEE_DENOM|$USDC_DENOM)\\b" | sort -u | tr '\n' ' ' || echo '?')"
  echo "(1 ZETAPHY = 10^18 azetaphy, 1 USDC = 1000000 uusdc)"
}

case "${1:-setup}" in
  setup)
    need_root
    install_hermes
    make_user
    write_config
    make_key "$ZETAPHY_CHAIN_ID" "m/44'/60'/0'/0/0"   # Ethereum path: the same account as 0x… in MetaMask
    make_key "$NOBLE_CHAIN_ID" "$NOBLE_HD_PATH"
    addresses
    cat <<NEXT

Next: send ~10 ZETAPHY to the ZETAPHY address (MetaMask), and testnet USDC to
the Noble address (faucet in zetaphy-chain/ibc/README.md); then:
  sudo bash $0 balances
  sudo bash $0 create-channel
NEXT
    ;;
  config)
    need_root config; write_config; echo "wrote $CFG"
    if running; then stop >/dev/null; start; fi ;;
  addresses) addresses ;;
  balances) balances ;;
  create-channel)
    need_root create-channel
    if channel_open; then echo "channel already open:"; cat "$CHAN"; exit 0; fi
    echo "creating light clients, connection and transfer channel (a few minutes)..."
    out=$(hermes --json create channel --a-chain "$ZETAPHY_CHAIN_ID" --b-chain "$NOBLE_CHAIN_ID" \
      --a-port transfer --b-port transfer --new-client-connection --yes 2>&1) || { echo "$out" | tail -5; exit 1; }
    res=$(echo "$out" | jq -c 'select(.status == "success") | .result' 2>/dev/null | tail -1)
    zc=$(echo "$res" | jq -r '.a_side.channel_id // empty'); nc=$(echo "$res" | jq -r '.b_side.channel_id // empty')
    [[ "$zc" =~ ^channel-[0-9]+$ && "$nc" =~ ^channel-[0-9]+$ ]] || { echo "$out" | tail -5; echo "channel ids not found in Hermes output"; exit 1; }
    printf 'ZETAPHY_CHANNEL=%s\nNOBLE_CHANNEL=%s\n' "$zc" "$nc" | as_relayer "cat > '$CHAN'"
    write_config   # relay this channel only
    cat "$CHAN"
    echo "USDC from Noble on ZETAPHY: gov.sh ibc-usdc-denom $zc"
    if running; then stop >/dev/null; start; else echo "start relaying: sudo bash $0 start"; fi ;;
  start) need_root start; start ;;
  stop) need_root stop; stop ;;
  status)
    if running; then echo "relayer: running"; else echo "relayer: STOPPED (sudo bash $0 start)"; fi
    [ -f "$CHAN" ] && cat "$CHAN" || echo "no channel yet"
    hermes health-check 2>&1 | grep -E 'SUCCESS|WARN|ERROR' | tail -4 || true
    balances
    if use_systemd; then journalctl -u "$UNIT" -n 8 --no-pager -o cat 2>/dev/null || true; else tail -n 8 "$LOGF" 2>/dev/null || true; fi ;;
  send-usdc)
    to=${2:?receiver on ZETAPHY: 0x… or zetaphy1…}; amt=${3:?amount in uusdc (1 USDC = 1000000)}
    [[ "$amt" =~ ^[1-9][0-9]{0,15}$ ]] || { echo "amount: whole uusdc"; exit 1; }
    if [[ "$to" =~ ^0x[0-9a-fA-F]{40}$ ]]; then to=$("$ZETAPHYD" debug addr "$to" 2>/dev/null | awk '/Bech32 Acc/ {print $3}'); fi
    [[ "$to" =~ ^zetaphy1[02-9ac-hj-np-z]{38}$ ]] || { echo "receiver: 0x… or zetaphy1…"; exit 1; }
    [ -f "$CHAN" ] || { echo "no channel yet: run create-channel first"; exit 1; }
    nc=$(sed -n 's/^NOBLE_CHANNEL=//p' "$CHAN")
    out=$(hermes --json tx ft-transfer --dst-chain "$ZETAPHY_CHAIN_ID" --src-chain "$NOBLE_CHAIN_ID" --src-port transfer \
      --src-channel "$nc" --amount "$amt" --denom "$USDC_DENOM" --receiver "$to" --timeout-seconds 600 2>&1) || { echo "$out" | tail -3; exit 1; }
    echo "$out" | jq -e 'select(.status == "success")' >/dev/null 2>&1 || { echo "$out" | tail -3; exit 1; }
    echo "sent $amt $USDC_DENOM from Noble to $to; the running relayer delivers it in ~a minute" ;;
  *) sed -n '7,18p' "$0" | sed 's/^# //'; exit 2 ;;
esac
