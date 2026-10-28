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
#   sudo zetaphy-validator backup     which files to copy somewhere safe (offline), and how
#   sudo zetaphy-validator backup words   shows the 24 words once (for paper), then clears the screen
#   sudo zetaphy-validator secure     after the backup: deletes the plaintext 24-word file, SSH with keys only
#                                     and no root login, automatic security updates, fail2ban, key file
#                                     permissions, a report of open ports. Asks before each change
#                                     (--yes: no questions; the words are deleted only with --words-saved too;
#                                     --only words,perms,ssh,updates,fail2ban,ports: just those steps)
#   sudo zetaphy-validator import-key use your own 12/24-word recovery phrase (MetaMask, Trust, Keplr, ...)
#                                     for the staking account instead of the one this node made; only
#                                     before it has staked. ACCOUNT_INDEX=n picks the wallet's account n+1.
#   sudo zetaphy-validator update     move this node to the current release (keys and chain data kept);
#                                     also for the chain's first node:  curl -fsSL …/join-validator.sh | sudo bash -s -- update
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
# what "secure" looks at and changes (tests point these at stand-ins)
SSHD="${SSHD:-sshd}"
SSHD_DIR="${SSHD_DIR:-/etc/ssh}"
RUN_SSHD="${RUN_SSHD:-/run/sshd}"
NSSWITCH="${NSSWITCH:-/etc/nsswitch.conf}"
SUDOERS_DIR="${SUDOERS_DIR:-/etc/sudoers.d}"
PASSWD_FILE="${PASSWD_FILE:-}"                       # empty: getent passwd
HOME_BASE="${HOME_BASE:-/home}"
ROOT_HOME="${ROOT_HOME:-/root}"
APT_CONF_DIR="${APT_CONF_DIR:-/etc/apt/apt.conf.d}"
DNF_AUTO_CONF="${DNF_AUTO_CONF:-/etc/dnf/automatic.conf}"
F2B_DIR="${F2B_DIR:-/etc/fail2ban/jail.d}"
SECURE_TTY="${SECURE_TTY:-/dev/tty}"
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

# A joined validator serves nobody's wallets: its EVM JSON-RPC answers only this machine
# (setup-node.sh opens 8545 and an https proxy for the chain's public nodes). Anyone could
# otherwise load a validator with eth_call until it misses blocks. PUBLIC_RPC=1 keeps them public.
private_rpc() {
  [ "${PUBLIC_RPC:-}" = 1 ] && { echo "PUBLIC_RPC=1: this node keeps a public RPC"; return 0; }
  local app="$NODE_HOME/config/app.toml" changed=
  if [ -f "$app" ] && grep -q '^address = "0.0.0.0:8545"' "$app"; then
    asn "sed -i 's/0\\.0\\.0\\.0:8545/127.0.0.1:8545/' '$app'" && changed=1
  fi
  if $SYSTEMCTL is-enabled caddy >/dev/null 2>&1; then
    $SYSTEMCTL disable --now caddy >/dev/null 2>&1 && echo "https proxy (caddy) off: not needed on a validator"
  fi
  [ -n "$changed" ] && { $SYSTEMCTL restart zetaphyd >/dev/null 2>&1 || true; echo "EVM JSON-RPC 8545: this machine only"; }
  return 0
}

# A node name: letters, digits, . _ - (it goes into commands and a systemd unit).
check_moniker() {
  [ -z "${MONIKER:-}" ] || [[ "$MONIKER" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "MONIKER: use only letters, digits, . _ - (at most 40), e.g. MONIKER=my-node"
}

# setup-node.sh from $REPO@$REF and the zetaphyd GitHub Actions built from it
# (release named after its SHA-256; the binary's SHA-256 checked). Sets binenv.
fetch_release() {
  local arch=$1
  say "setup-node.sh and the prebuilt zetaphyd ($REPO@$REF)"
  install -d -m 755 "$LIB"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/zetaphy-chain/setup-node.sh" -o "$LIB/setup-node.sh"
  local s tag rel; s=$(sha256sum "$LIB/setup-node.sh" | cut -d' ' -f1); tag="zetaphyd-${s:0:12}"
  rel="https://github.com/$REPO/releases/download/$tag"
  rm -f "$LIB/SHA256SUMS" "$LIB/zetaphyd-linux-$arch"
  binenv=()
  if curl -fsSL "$rel/SHA256SUMS" -o "$LIB/SHA256SUMS" && curl -fsSL "$rel/zetaphyd-linux-$arch" -o "$LIB/zetaphyd-linux-$arch"; then
    (cd "$LIB" && sha256sum -c --ignore-missing --quiet SHA256SUMS) || die "zetaphyd does not match the SHA-256 of release $tag: refused"
    chmod 755 "$LIB/zetaphyd-linux-$arch"
    binenv=(ZETAPHYD_BIN="$LIB/zetaphyd-linux-$arch")
    echo "release $tag, zetaphyd-linux-$arch: SHA-256 ok"
  else
    echo "no prebuilt zetaphyd for setup-node.sh ${s:0:12} yet: building from source (15-60 minutes, needs 2 GB RAM or swap)"
  fi
}

install_all() {
  [ "$(id -u)" = 0 ] || die "run with sudo"
  check_moniker
  [ -n "${DOWNLOAD_ONLY:-}" ] || platform
  packages
  local arch; case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac

  binenv=()
  fetch_release "$arch"
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
  private_rpc
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
  sudo zetaphy-validator backup    the files to keep safe, and how to copy them off this machine
  sudo zetaphy-validator secure    AFTER the backup: deletes the plaintext 24-word file, SSH with keys only,
                                   automatic security updates (asks before each change)
Ports: in a cloud, open TCP 26656 (P2P) in its firewall; nothing else is needed (the RPC answers this machine only).
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
  if [ -f "$WORDS" ]; then
    echo "note:      the 24 words are still in a plain file on this machine; once they are backed up offline,"
    echo "           run: sudo zetaphy-validator secure"
  fi
  return 0
}

# A node set up earlier (this script, or setup-node.sh on the chain's first
# node) moves to the current setup-node.sh and its prebuilt zetaphyd: settings,
# rpc-guard and Caddy are redone, keys and chain data are kept, the node restarts.
update_node() {
  [ "$(id -u)" = 0 ] || die "run with sudo"
  [ -f "$NODE_HOME/config/genesis.json" ] || die "no ZETAPHY node here: install first"
  packages
  local arch; case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  fetch_release "$arch"
  [ ${#binenv[@]} -gt 0 ] || die "no prebuilt zetaphyd for this setup-node.sh yet: try again later"
  # keep the public https name the node already has (rpc.example.com in its Caddyfile)
  local host; host=${PUBLIC_HOST:-$(sed -n '1s/^[^,{]*, *\([a-z0-9.-]*\) *{$/\1/p' /etc/caddy/Caddyfile 2>/dev/null || true)}
  say "update (log: /var/log/zetaphy-setup.log)"
  env JOIN= "${binenv[@]}" ${host:+PUBLIC_HOST="$host"} bash "$LIB/setup-node.sh" > /dev/null \
    || die "setup-node.sh failed: sudo tail -50 /var/log/zetaphy-setup.log"
  # a validator that joined keeps its RPC to itself
  [ -f "$NODE_HOME/config/seed-peer" ] && private_rpc
  install -m 755 "${BASH_SOURCE[0]}" "$SELF_BIN" 2>/dev/null || true
  say "updated: $("$ZETAPHYD" version 2>/dev/null)"
}

# ---- backup and secure ------------------------------------------------------------------------
WORDS="$KEYS_DIR/MNEMONICS-KEEP-SECRET.txt"

backup() {
  local in_secure=${1:-}
  cat <<EOF
Copy these somewhere safe and offline (USB stick / paper), never into a chat, e-mail or website:
  $NODE_HOME/config/priv_validator_key.json   the validator's signing key
  $NODE_HOME/config/pq_vote_key.seed          its ML-DSA vote key
  $WORDS         the 24 words of the staking account
EOF
  [ -f "$WORDS" ] || echo "  (the words file is gone: secure deleted it after the backup, or import-key was used, which keeps no copy)"
  cat <<EOF

How to get them off this machine (nothing to install on your own computer):
  1. on this machine:  mkdir -p ~/zbackup && sudo cp $NODE_HOME/config/priv_validator_key.json \\
       $NODE_HOME/config/pq_vote_key.seed $WORDS ~/zbackup/ && sudo chown -R \$USER ~/zbackup
  2. Google Cloud (SSH in the browser): gear menu -> Download file, once per file in ~/zbackup.
     Oracle Cloud Shell: scp -r ubuntu@SERVER_IP:zbackup ~/ then the Cloud Shell menu -> Download,
     then rm -rf ~/zbackup in Cloud Shell too.
     Home machine or Raspberry Pi: copy ~/zbackup to a USB stick.
  3. put the files on a USB stick kept offline, then on this machine:  rm -rf ~/zbackup
     (secure also shreds a zbackup folder it finds).
  Paper, the 24 words only:  sudo zetaphy-validator backup words
EOF
  [ -n "$in_secure" ] || cat <<EOF
Then:  sudo zetaphy-validator secure   deletes the words file from this machine once you confirm
       they are saved, and locks the machine down (it asks before each change).
EOF
  cat <<EOF
Never run two machines with the same priv_validator_key.json: that is double signing (slashed, jailed for good).
EOF
}

# y/N question (--yes answers yes). Reads the terminal, also when this script came in through a pipe.
ask() {
  [ -n "${YES:-}" ] && { echo "$1 [y/N] y (--yes)"; return 0; }
  local a=
  printf '%s [y/N] ' "$1"
  if { : < "$SECURE_TTY"; } 2>/dev/null; then read -r a < "$SECURE_TTY" || true; else read -r a || true; fi
  [[ "$a" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# The 24 words once, for paper; the screen is cleared when Enter is pressed.
backup_words() {
  [ "$(id -u)" = 0 ] || [ -n "${SECURE_TEST:-}" ] || die "run with sudo"
  [ -f "$WORDS" ] || die "no recovery words on this machine ($WORDS is gone: secure deleted it, or import-key was used, which keeps no copy)"
  echo "Write these on paper, keep it offline. Never type them into a chat, e-mail or website."
  echo
  cat "$WORDS"
  echo
  printf 'Press Enter to clear the screen. '
  if { : < "$SECURE_TTY"; } 2>/dev/null; then read -r _ < "$SECURE_TTY" || true; else read -r _ || true; fi
  printf '\033[3J\033[H\033[2J'
  echo "cleared. Once the words are safe: sudo zetaphy-validator secure"
}

shred_file() {
  shred -u -z "$1" 2>/dev/null && return 0
  local n; n=$(( ($(stat -c %s "$1" 2>/dev/null || echo 0) + 1023) / 1024 ))
  dd if=/dev/urandom of="$1" bs=1024 count="$n" conv=notrunc,fsync 2>/dev/null || true
  rm -f "$1"
}

# Plaintext recovery words the setup leaves, and copies made while backing up (zbackup folders).
plain_words() {
  local f
  for f in "$WORDS" "$KEYS_DIR".unfinished-*/MNEMONICS-KEEP-SECRET.txt "$HOME_BASE"/*/zbackup/* "$ROOT_HOME"/zbackup/*; do
    [ -f "$f" ] && echo "$f"
  done
  return 0
}

secure_words() {
  say "1. the 24 words: back up, then delete the plaintext file from this machine"
  local files f
  files=$(plain_words)
  if [ -z "$files" ]; then
    echo "no plaintext recovery words left on this machine: nothing to do"
  else
    echo "plaintext secrets found (anyone who gets root on this machine can read them):"
    while IFS= read -r f; do echo "  $f"; done <<<"$files"
    if grep -qxF "$WORDS" <<<"$files" && ! asn "$ZETAPHYD keys show validator -a $K --home $NODE_HOME" >/dev/null 2>&1; then
      echo "kept: the staking key is not in this node's keyring, so these words are its only copy here"
      return 0
    fi
    echo
    backup in-secure
    echo
    if [ -n "${YES:-}" ] && [ -z "${WORDS_SAVED:-}" ]; then
      echo "kept: with --yes the words are deleted only when --words-saved is given too"
    elif [ -z "${YES:-}" ] && ! ask "Have you saved the 24 words and the two key files offline, and should the files above be shredded?"; then
      echo "kept. Run secure again once the backup is done."
    else
      while IFS= read -r f; do shred_file "$f" && echo "shredded: $f"; done <<<"$files"
      for f in "$HOME_BASE"/*/zbackup "$ROOT_HOME"/zbackup; do if [ -d "$f" ]; then rmdir "$f" 2>/dev/null || true; fi; done
      echo "(on SSDs and copy-on-write disks shred cannot promise the old blocks are gone; the files are, and"
      echo " with them the easy way to read the words)"
    fi
  fi
  cat <<EOF
What stays on this machine, because the node needs it to run (back these up, never delete them):
  $NODE_HOME/config/priv_validator_key.json   signs blocks (ed25519)
  $NODE_HOME/config/pq_vote_key.seed          signs votes post-quantum (ML-DSA-44)
  $NODE_HOME/config/node_key.json             this node's P2P identity (not a money key)
  $NODE_HOME/data/priv_validator_state.json   the last height signed: protects against double signing
  $KEYS_DIR/                    the keyring with the staking account's key (unjail, staking).
      It is a test keyring (not encrypted), so root on this machine can still use that account;
      what is gone is the plain file with the words, which also open every other account of the phrase.
EOF
  [ -f "$NODE_HOME/config/faucet.key" ] && echo "  $NODE_HOME/config/faucet.key                  the faucet's key (the chain's first node only)"
  return 0
}

secure_perms() {
  say "2. key files: folders 700, files 600, owner $NODE_USER"
  local p n=0 own=
  id "$NODE_USER" >/dev/null 2>&1 && own=1
  for p in "$KEYS_DIR" "$NODE_HOME/config"; do
    [ -d "$p" ] || continue
    n=$((n + $(find "$p" -type d ! -perm 700 | wc -l)))
    find "$p" -type d -exec chmod 700 {} +
    [ -n "$own" ] && chown -R "$NODE_USER:" "$p"
  done
  [ -d "$KEYS_DIR" ] && { n=$((n + $(find "$KEYS_DIR" -type f ! -perm 600 | wc -l))); find "$KEYS_DIR" -type f -exec chmod 600 {} +; }
  for p in "$NODE_HOME/config/priv_validator_key.json" "$NODE_HOME/config/node_key.json" "$NODE_HOME/config/pq_vote_key.seed" \
           "$NODE_HOME/config/pq_vote_key.seed.old" "$NODE_HOME/config/faucet.key" "$NODE_HOME/data/priv_validator_state.json"; do
    [ -f "$p" ] || continue
    [ "$(stat -c %a "$p")" = 600 ] || { chmod 600 "$p"; n=$((n + 1)); }
    [ -n "$own" ] && chown "$NODE_USER:" "$p"
  done
  echo "done ($n changed)"
}

passwd_db() { if [ -n "$PASSWD_FILE" ]; then cat "$PASSWD_FILE"; else getent passwd; fi; }

# Accounts other than root that can log in with an SSH key and use sudo.
ssh_key_users() {
  local name uid home
  passwd_db | while IFS=: read -r name _ uid _ _ home _; do
    if ! [ "$uid" -ge 1000 ] 2>/dev/null || [ "$name" = nobody ]; then continue; fi
    grep -qsE '^[[:space:]]*([^#[:space:]].*[[:space:]])?(ssh-(ed25519|rsa|dss)|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)' "$home/.ssh/authorized_keys" || continue
    id -nG "$name" 2>/dev/null | grep -qwE 'sudo|wheel|admin|google-sudoers' || grep -rqsE "^${name}[[:space:]]" "$SUDOERS_DIR" || continue
    echo "$name"
  done
}

# Google Cloud OS Login: keys come from the Google account (no authorized_keys file).
os_login() { grep -qs oslogin "$NSSWITCH" || grep -rqs google_authorized_keys "$SSHD_DIR/sshd_config" "$SSHD_DIR/sshd_config.d"; }

secure_ssh() {
  say "3. SSH: keys only, no root login"
  local sshd conf="$SSHD_DIR/sshd_config.d/60-zetaphy.conf" want users old='' eff f
  sshd=$(command -v "$SSHD" || command -v /usr/sbin/sshd || true)
  if [ -z "$sshd" ] || [ ! -f "$SSHD_DIR/sshd_config" ]; then echo "no SSH server on this machine: nothing to do"; return 0; fi
  want='# ZETAPHY (zetaphy-validator secure): SSH logins with a key only, and never as root.
# Undo: sudo rm this file, then sudo systemctl reload ssh (or sshd).
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no'
  if [ -f "$conf" ] && [ "$(cat "$conf")" = "$want" ]; then echo "already set ($conf)"; return 0; fi
  if ! grep -qsiE '^[[:space:]]*Include[[:space:]].*sshd_config\.d' "$SSHD_DIR/sshd_config"; then
    echo "skipped: $SSHD_DIR/sshd_config does not read sshd_config.d/ (an older system); the main file is left alone"
    return 0
  fi
  users=$(ssh_key_users | tr '\n' ' ')
  if [ -n "$users" ]; then
    echo "these accounts log in with an SSH key and can use sudo: $users"
  elif os_login; then
    echo "Google OS Login is on: logins use the keys of your Google account (and the browser SSH button)"
  else
    echo "WARNING: skipped. No account other than root has an SSH key (~/.ssh/authorized_keys) and sudo,"
    echo "so turning passwords or root login off could lock you out. Add your key to a sudo account, then run secure again."
    return 0
  fi
  echo "after this, SSH asks for a key: password logins and root logins stop (your cloud's web console still works)."
  ask "Turn off SSH passwords and root login?" || { echo "skipped"; return 0; }
  [ -f "$conf" ] && old=$(cat "$conf")
  mkdir -p "$SSHD_DIR/sshd_config.d"
  printf '%s\n' "$want" > "$conf" && chmod 644 "$conf"
  [ -d "$RUN_SSHD" ] || install -d -m 755 "$RUN_SSHD" 2>/dev/null || true   # sshd -t needs it (socket-activated ssh)
  if ! "$sshd" -t; then
    if [ -n "$old" ]; then printf '%s\n' "$old" > "$conf"; else rm -f "$conf"; fi
    echo "sshd -t refused the new setting: rolled back, SSH is as it was"
    return 0
  fi
  # sshd keeps the first value it reads: a file read earlier can still win
  eff=$("$sshd" -T 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  if [ -n "$eff" ] && ! grep -qx 'passwordauthentication no' <<<"$eff"; then
    echo "note: sshd still allows passwords because a file read earlier says so:"
    for f in "$SSHD_DIR"/sshd_config.d/*.conf "$SSHD_DIR/sshd_config"; do
      grep -qsiE '^[[:space:]]*PasswordAuthentication[[:space:]]+yes' "$f" && echo "  $f"
    done
    echo "change PasswordAuthentication to no there (sudo nano FILE), then: sudo sshd -t && sudo systemctl reload ssh"
  fi
  $SYSTEMCTL reload ssh >/dev/null 2>&1 || $SYSTEMCTL reload sshd >/dev/null 2>&1 || true
  echo "on: $conf (sshd -t ok). Keep this session open and try a new SSH login before closing it."
}

secure_updates() {
  say "4. automatic security updates"
  if command -v apt-get >/dev/null; then
    local f="$APT_CONF_DIR/20auto-upgrades"
    if dpkg -s unattended-upgrades >/dev/null 2>&1 && grep -qs 'Unattended-Upgrade "1"' "$f"; then echo "already on (unattended-upgrades)"; return 0; fi
    echo "unattended-upgrades installs security updates every day. It never reboots by itself (a reboot is"
    echo "downtime): when a kernel update needs one, it says so at login; reboot at a quiet time."
    ask "Turn on automatic security updates?" || { echo "skipped"; return 0; }
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o DPkg::Lock::Timeout=900 install -y -qq unattended-upgrades >/dev/null 2>&1 \
      || { apt-get -o DPkg::Lock::Timeout=900 update -qq >/dev/null 2>&1 && apt-get -o DPkg::Lock::Timeout=900 install -y -qq unattended-upgrades >/dev/null 2>&1; } \
      || { echo "could not install unattended-upgrades: skipped"; return 0; }
    mkdir -p "$APT_CONF_DIR"
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > "$f"
    echo "on: $f (security updates only, no automatic reboot)"
  elif command -v dnf >/dev/null; then
    local t
    if grep -qs '^upgrade_type *= *security' "$DNF_AUTO_CONF" && grep -qs '^apply_updates *= *yes' "$DNF_AUTO_CONF"; then echo "already on (dnf-automatic)"; return 0; fi
    echo "dnf-automatic installs security updates every day (no automatic reboot)."
    ask "Turn on automatic security updates?" || { echo "skipped"; return 0; }
    dnf install -y -q dnf-automatic >/dev/null 2>&1 || dnf install -y -q dnf5-plugin-automatic >/dev/null 2>&1 \
      || { echo "could not install dnf-automatic: skipped"; return 0; }
    [ -f "$DNF_AUTO_CONF" ] || { mkdir -p "$(dirname "$DNF_AUTO_CONF")"; printf '[commands]\n' > "$DNF_AUTO_CONF"; }
    grep -q '^\[commands\]' "$DNF_AUTO_CONF" || printf '\n[commands]\n' >> "$DNF_AUTO_CONF"
    local kv
    for kv in 'upgrade_type = security' 'apply_updates = yes'; do
      local k=${kv%% *}
      if grep -qE "^#? *$k *=" "$DNF_AUTO_CONF"; then sed -i -E "s/^#? *$k *=.*/$kv/" "$DNF_AUTO_CONF"
      else sed -i "/^\[commands\]/a $kv" "$DNF_AUTO_CONF"; fi
    done
    for t in dnf-automatic.timer dnf5-automatic.timer; do $SYSTEMCTL enable --now "$t" >/dev/null 2>&1 && { echo "on: $t ($DNF_AUTO_CONF)"; return 0; }; done
    echo "installed, but no dnf-automatic timer could be started: systemctl list-timers | grep dnf"
  else
    echo "no apt or dnf here: turn on this system's automatic security updates yourself"
    echo "  (openSUSE: zypper install yast2-online-update-configuration; Arch: no automatic updates, run pacman -Syu weekly)"
  fi
}

secure_fail2ban() {
  say "5. fail2ban: blocks an address for an hour after 5 failed SSH logins (optional)"
  command -v "$SSHD" >/dev/null || [ -x /usr/sbin/sshd ] || { echo "no SSH server: not needed"; return 0; }
  local f="$F2B_DIR/zetaphy-sshd.local" ignore="127.0.0.1/8 ::1"
  if [ -f "$f" ] && command -v fail2ban-client >/dev/null; then echo "already on ($f)"; return 0; fi
  if ! command -v fail2ban-client >/dev/null; then
    if command -v apt-get >/dev/null && apt-cache show fail2ban >/dev/null 2>&1; then
      ask "Install fail2ban?" || { echo "skipped"; return 0; }
      DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=900 install -y -qq fail2ban >/dev/null 2>&1 || { echo "fail2ban could not be installed: skipped"; return 0; }
    elif command -v dnf >/dev/null && dnf -q list fail2ban >/dev/null 2>&1; then
      ask "Install fail2ban?" || { echo "skipped"; return 0; }
      dnf install -y -q fail2ban >/dev/null 2>&1 || { echo "fail2ban could not be installed: skipped"; return 0; }
    else
      echo "fail2ban is not in this system's package sources: skipped"; return 0
    fi
  fi
  # Google's browser SSH comes through IAP from 35.235.240.0/20: never ban it
  { os_login || grep -qs 'Google' /sys/class/dmi/id/product_name; } && ignore="$ignore 35.235.240.0/20"
  mkdir -p "$F2B_DIR"
  printf '# ZETAPHY (zetaphy-validator secure)\n[sshd]\nenabled = true\nbackend = systemd\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\nignoreip = %s\n' "$ignore" > "$f"
  $SYSTEMCTL enable fail2ban >/dev/null 2>&1 || true
  if $SYSTEMCTL restart fail2ban >/dev/null 2>&1; then echo "on: $f"; else echo "fail2ban did not start (journalctl -u fail2ban -n 20); SSH is unaffected"; fi
}

# What answers from outside: listening sockets not bound to loopback. Reports only, changes nothing.
secure_ports() {
  say "6. open ports (what this machine answers from outside)"
  command -v ss >/dev/null || { echo "ss not found: skipped"; return 0; }
  local ok="tcp:22 tcp:26656 udp:68 udp:546" others="" proto addr port prog
  $SYSTEMCTL is-active caddy >/dev/null 2>&1 && ok="$ok tcp:80 tcp:443 udp:443"
  grep -qsE '^priv_validator_laddr = "tcp://' "$NODE_HOME/config/config.toml" && ok="$ok tcp:1234"
  while read -r proto _ _ _ addr _ prog; do
    port=${addr##*:}; addr=${addr%:*}
    case "$addr" in 127.*|\[::1\]|::1|\[::ffff:127.*|*%lo) continue ;; esac
    case " $ok " in *" $proto:$port "*) continue ;; esac
    prog=$(grep -o '"[^"]*"' <<<"$prog" | head -1 | tr -d '"')
    others="$others  $proto $addr:$port ${prog:+($prog)}"$'\n'
  done < <(ss -Hlntup 2>/dev/null | sort -u)
  echo "needed: 26656/tcp (P2P), 22/tcp (SSH)$($SYSTEMCTL is-active caddy >/dev/null 2>&1 && echo ', 80 and 443 (Caddy, https RPC)')"
  case " $ok " in *" tcp:1234 "*) echo "  and 1234/tcp for the Horcrux cosigners only: allow just their addresses" ;; esac
  if [ -n "$others" ]; then
    echo "also listening on a public address (reachable unless a firewall blocks it):"
    printf '%s' "$others"
    echo "if one of these is not meant for the internet, close it in your cloud's firewall (Oracle: security list;"
    echo "Google: VPC firewall rules) or on this machine, or stop the program."
  else
    echo "nothing else listens on a public address"
  fi
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then echo "this machine's firewall: ufw (active)"
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then echo "this machine's firewall: firewalld (active)"
  elif command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT\|-P INPUT DROP'; then echo "this machine's firewall: iptables (rejects what is not allowed)"
  else echo "this machine has no firewall of its own: your cloud's firewall is the one that counts"; fi
}

secure() {
  local only="words perms ssh updates fail2ban ports" a s
  YES=''; WORDS_SAVED=''
  while [ $# -gt 0 ]; do
    a=$1; shift
    case "$a" in
      --yes|-y) YES=1 ;;
      --words-saved) WORDS_SAVED=1 ;;
      --only) only=${1:-}; only=${only//,/ }; shift || true ;;
      --only=*) only=${a#--only=}; only=${only//,/ } ;;
      *) die "secure: unknown option $a (--yes, --words-saved, --only words,perms,ssh,updates,fail2ban,ports)" ;;
    esac
  done
  [ "$(id -u)" = 0 ] || [ -n "${SECURE_TEST:-}" ] || die "run with sudo"
  echo "zetaphy-validator secure: each step says what it does and asks first. Safe to run again."
  for s in $only; do
    case "$s" in
      words) secure_words ;; perms) secure_perms ;; ssh) secure_ssh ;;
      updates) secure_updates ;; fail2ban) secure_fail2ban ;; ports) secure_ports ;;
      *) die "secure --only: unknown step $s" ;;
    esac
  done
  say "secure: done"
}

case "${1:-install}" in
  install|validator) install_all ;;
  check) check ;;
  update) update_node ;;
  import-key) import_key ;;
  preflight) platform && echo "this machine can run a ZETAPHY validator" ;;
  status) status ;;
  address) echo "$(acc)  $(hexaddr)" ;;
  logs) journalctl -u zetaphy-become-validator -n "${2:-30}" --no-pager; tail -n 5 /var/log/zetaphy-setup.log 2>/dev/null || true ;;
  unjail) asn "$ZETAPHYD tx slashing unjail --from validator $K --home $NODE_HOME --node $NODE --chain-id zetaphy_77390-1 --gas auto --gas-adjustment 1.5 --gas-prices 1000000000$DENOM -y -o json" | jq -c '{code, txhash, raw_log}' ;;
  backup) if [ "${2:-}" = words ]; then backup_words; else backup; fi ;;
  secure) shift; secure "$@" ;;
  *) sed -n '2,35p' "$0"; exit 1 ;;
esac
