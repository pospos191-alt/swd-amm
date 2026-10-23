#!/bin/bash
# Join the ZETAPHY testnet as a validator in one command, on any Linux machine with systemd and sudo
# (x86_64 or arm64): any cloud, free or paid (Oracle, Google, AWS, Azure, Hetzner, DigitalOcean, Vultr, ...),
# a home PC or mini PC, a Raspberry Pi 4/5 (64-bit OS), Windows through WSL 2, or a Mac through an Ubuntu VM.
# Ubuntu, Debian, Fedora, RHEL/Rocky/Alma, Amazon Linux, openSUSE and Arch install what they need themselves.
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
#   sudo zetaphy-validator status     height, sync, address, balance, validator state
#   sudo zetaphy-validator address    the address (send ZETAPHY here to stake more later)
#   sudo zetaphy-validator logs       setup and become-validator log lines
#   sudo zetaphy-validator unjail     back to work after being jailed for downtime
#   sudo zetaphy-validator backup     which files to copy somewhere safe (offline)
#   sudo zetaphy-validator import-key use your own 12/24-word recovery phrase (MetaMask, Trust, Keplr, ...)
#                                     for the staking account instead of the one this node made; only
#                                     before it has staked. ACCOUNT_INDEX=n picks the wallet's account n+1.
#   sudo zetaphy-validator preflight  can this machine run a validator? (changes nothing, except on WSL
#                                     without systemd: it switches systemd on in /etc/wsl.conf)
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
# where this runs (tests point these at stand-ins)
UNAME_S="${UNAME_S:-$(uname -s)}"
PROC_VERSION="${PROC_VERSION:-/proc/version}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/run/systemd/system}"
WSL_CONF="${WSL_CONF:-/etc/wsl.conf}"
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
# (padded as text: printf %d overflows above 9.22 ZETAPHY, i.e. 2^63 azetaphy)
zeta() {
  local a="${1:-0}"; a="${a//[^0-9]/}"; a="${a#"${a%%[!0]*}"}"
  while [ ${#a} -lt 19 ]; do a="0$a"; done
  local w="${a:0:${#a}-18}"; w="${w#"${w%%[!0]*}"}"
  echo "${w:-0}.${a:${#a}-18:2}"
}

is_wsl() { grep -qi microsoft "$PROC_VERSION" 2>/dev/null; }

# Can this machine run a validator? Stops with what to do when it cannot; prints hints otherwise.
platform() {
  case "$UNAME_S" in
    Linux) ;;
    Darwin) die "this is macOS: the node needs Linux. Make a free Ubuntu VM with Multipass (https://canonical.com/multipass):
  multipass launch 24.04 -n zetaphy -c 2 -m 4G -d 40G && multipass shell zetaphy
then paste the same command inside it." ;;
    MINGW*|MSYS*|CYGWIN*) die "this is Windows: install Ubuntu in WSL (PowerShell as admin: wsl --install -d Ubuntu-24.04),
open Ubuntu and paste the same command there." ;;
    *) die "$UNAME_S is not supported: use Linux (x86_64 or arm64)" ;;
  esac
  if ldd --version 2>&1 | grep -qi musl; then die "musl Linux (e.g. Alpine): the prebuilt node needs glibc. Use Ubuntu, Debian or Fedora."; fi
  if ! [ -d "$SYSTEMD_DIR" ]; then
    if is_wsl; then
      if ! grep -qs '^systemd *= *true' "$WSL_CONF"; then
        { echo; echo '[boot]'; echo 'systemd=true'; } >> "$WSL_CONF" || die "could not write $WSL_CONF (run with sudo)"
      fi
      die "WSL: systemd was off; it is now switched on in $WSL_CONF.
In Windows PowerShell run:  wsl --shutdown
then open Ubuntu again and paste the same command."
    fi
    die "systemd is not running here (a container?). Use a VM or a whole machine: the node runs as a systemd service."
  fi
  local mem disk
  mem=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  [ "${mem:-0}" -ge 900000 ] || echo "note: under 1 GB of RAM; 2 GB or more is better (a swap file is added)"
  disk=$(df -Pk /home 2>/dev/null | awk 'NR==2 {print $4}')
  [ -z "$disk" ] || [ "$disk" -ge 20000000 ] || echo "note: under 20 GB of free disk; the chain grows over time"
  if is_wsl; then
    echo "WSL: works. Keep the PC on, stop Windows from sleeping, and keep one Ubuntu window open"
    echo "  (WSL may stop the node when its last window closes). Offline time lowers your BZTPHY and can get you jailed."
  fi
  return 0
}

# curl, jq, python3 and flock with whatever package manager this Linux has (only the missing ones)
packages() {
  local miss=() c
  for c in curl jq python3 flock; do command -v "$c" >/dev/null || miss+=("$c"); done
  if command -v dpkg >/dev/null; then dpkg -s ca-certificates >/dev/null 2>&1 || miss+=(ca-certificates); fi
  [ ${#miss[@]} -eq 0 ] && return 0
  local pk=() m
  for m in "${miss[@]}"; do
    case "$m" in
      flock) pk+=(util-linux) ;;
      python3) if command -v pacman >/dev/null; then pk+=(python); else pk+=(python3); fi ;;
      *) pk+=("$m") ;;
    esac
  done
  echo "installing: ${pk[*]}"
  if command -v apt-get >/dev/null; then
    apt-get -o DPkg::Lock::Timeout=900 update -qq && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=900 install -y -qq "${pk[@]}"
  elif command -v dnf >/dev/null; then dnf install -y -q "${pk[@]}"
  elif command -v yum >/dev/null; then yum install -y -q "${pk[@]}"
  elif command -v zypper >/dev/null; then zypper -n -q install "${pk[@]}"
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm --needed "${pk[@]}"
  else die "install ${pk[*]} with this system's package manager, then run this again"
  fi
}

# P2P port 26656 in this machine's own firewall, if one is on (a cloud's firewall is separate)
open_p2p() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow 26656/tcp >/dev/null && echo "ufw: 26656/tcp opened"
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd -q --permanent --add-port=26656/tcp && firewall-cmd -q --reload && echo "firewalld: 26656/tcp opened"
  fi
  return 0
}

install_all() {
  [ "$(id -u)" = 0 ] || die "run with sudo"
  [ -n "${DOWNLOAD_ONLY:-}" ] || platform
  packages
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

  open_p2p
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
Ports: in a cloud, open TCP 26656 (P2P) in its firewall (and 80/443 if this node serves a public RPC).
At home it works without opening any port; forwarding TCP 26656 on the router helps other nodes reach you.
EOF
  if is_wsl; then echo "WSL: keep the PC awake and one Ubuntu window open, or the node stops."; fi
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

# Replaces the staking account (key "validator") with one from the user's own recovery phrase.
# The phrase is read from the terminal without echo and handed over on stdin (never as an argument,
# so it is not in ps or a log). The node's key is kept as "validator-made-by-node", not deleted.
import_key() {
  [ "$(id -u)" = 0 ] || [ -n "${IMPORT_TEST:-}" ] || die "run with sudo"
  if zq q staking validator "$(valoper)" >/dev/null 2>&1; then
    die "this node already staked with its current account: keep it (moving a validator to another account is not supported)"
  fi
  local words n idx="${ACCOUNT_INDEX:-0}"
  [[ "$idx" =~ ^[0-9]+$ ]] || die "ACCOUNT_INDEX must be a number (0 = the wallet's first account)"
  echo "Testnet only: use a NEW phrase, never one that holds real money. The phrase is stored on this machine."
  printf 'Paste the 12 or 24 recovery words, then press Enter (nothing is shown): '
  IFS= read -rs words || true; echo
  words=$(echo "$words" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//' | tr '[:upper:]' '[:lower:]')
  n=$(wc -w <<<"$words")
  [ "$n" = 12 ] || [ "$n" = 24 ] || die "expected 12 or 24 words, got $n"
  asn "$ZETAPHYD keys delete imported -y $K --home $NODE_HOME" >/dev/null 2>&1 || true
  printf '%s\n' "$words" | asn "$ZETAPHYD keys add imported --recover --algo eth_secp256k1 --coin-type 60 --index $idx $K --home $NODE_HOME" >/dev/null \
    || die "the phrase was not accepted (check the words); nothing changed"
  unset words
  local old; old=$(acc)
  asn "$ZETAPHYD keys delete validator-made-by-node -y $K --home $NODE_HOME" >/dev/null 2>&1 || true
  asn "$ZETAPHYD keys rename validator validator-made-by-node -y $K --home $NODE_HOME" >/dev/null
  asn "$ZETAPHYD keys rename imported validator -y $K --home $NODE_HOME" >/dev/null
  rm -f "$STATE/faucet"   # the new account asks the faucet on the next check
  echo "staking account is now: $(acc)  ($(hexaddr))"
  echo "the node's own account $old is kept as validator-made-by-node (its words: $KEYS_DIR/MNEMONICS-KEEP-SECRET.txt)"
  echo "the timer asks the faucet for the new account and stakes once it is funded"
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
  import-key) import_key ;;
  preflight) platform && echo "this machine can run a ZETAPHY validator" ;;
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
  *) sed -n '2,27p' "$0"; exit 1 ;;
esac
