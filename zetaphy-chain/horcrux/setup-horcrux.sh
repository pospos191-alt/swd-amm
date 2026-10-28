#!/bin/bash
# OPTIONAL, testnet: the validator's ed25519 signing key split 2-of-3 with Horcrux
# (github.com/strangelove-ventures/horcrux, threshold remote signer), so no single machine holds it.
# Read README.md first: what it protects, what it does not (the ML-DSA-44 vote key stays on the node),
# and the order of the steps. Every step runs on the machine it names, never on your own computer.
#
#   on the validator node (it holds priv_validator_key.json):
#     sudo COSIGNERS="10.0.0.11 10.0.0.12 10.0.0.13" NODE_ADDR=10.0.0.10 bash setup-horcrux.sh shard
#     sudo bash setup-horcrux.sh bundle 1      (then 2, 3: copy each into its cosigner's terminal)
#   on cosigner N (N = 1, 2, 3; a small free machine each):
#     sudo bash setup-horcrux.sh cosigner N    (paste bundle N when asked)
#   on the validator node, when all three cosigners are ready:
#     sudo bash setup-horcrux.sh switch        (stops the node, says which height to start from)
#   on each cosigner, with the height switch printed:
#     sudo bash setup-horcrux.sh start HEIGHT
#   back to a single key file on the node (cosigners stopped first):
#     sudo bash setup-horcrux.sh rollback
#
# Horcrux is pinned (release and SHA-256 below). Nothing here touches the ML-DSA vote key.
set -euo pipefail

HORCRUX_VERSION=v3.3.2   # 7 Mar 2025, CometBFT v0.38 privval with vote extensions
HORCRUX_SHA256_amd64=0cd5d654441b971bb194367ff58e823b6ef499b851c06ae2c10aa406fa7e95b6
HORCRUX_SHA256_arm64=618690bd5e810e41a4294554fb02ac84bac67a3e980c37afb0da7aee1f6aabc8
CHAIN_ID=zetaphy_77390-1
THRESHOLD=2
SHARDS=3
PRIVVAL_PORT=1234        # the node listens here; only the cosigners may reach it
P2P_PORT=2222            # cosigner to cosigner

HORCRUX="${HORCRUX:-/usr/local/bin/horcrux}"
NODE_USER="${NODE_USER:-zetaphy}"
NODE_HOME="${NODE_HOME:-/home/$NODE_USER/.zetaphy}"
KEYS_DIR="${KEYS_DIR:-/home/$NODE_USER/.zetaphy-genesis-keys}"
ZETAPHYD="${ZETAPHYD:-/usr/local/bin/zetaphyd}"
WORK="${WORK:-/root/zetaphy-horcrux}"            # on the node: shards and bundles until the switch
HX_USER="${HX_USER:-horcrux}"
HX_HOME="${HX_HOME:-/home/$HX_USER/.horcrux}"    # on a cosigner
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
TTY="${TTY:-/dev/tty}"
MARKER="$NODE_HOME/config/HORCRUX-REMOTE-SIGNER.txt"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
root() { [ "$(id -u)" = 0 ] || [ -n "${HX_TEST:-}" ] || die "run with sudo"; }
# reads the terminal, also when this script came in through a pipe
input() { if { : < "$TTY"; } 2>/dev/null; then IFS= read -r "$1" < "$TTY"; else IFS= read -r "$1"; fi; }
ask() { local a=''; printf '%s [y/N] ' "$1"; input a || true; [[ "$a" =~ ^[Yy]([Ee][Ss])?$ ]]; }
asn() { if [ "$(id -u)" = 0 ] && id "$NODE_USER" >/dev/null 2>&1; then su -s /bin/bash "$NODE_USER" -c "cd ~; $*"; else bash -c "$*"; fi; }
ipv4() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }
host_ok() { ipv4 "$1" || [[ "$1" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; }

install_horcrux() {
  local arch want tmp
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  if [ "$arch" = amd64 ]; then want=$HORCRUX_SHA256_amd64; else want=$HORCRUX_SHA256_arm64; fi
  if [ -x "$HORCRUX" ] && echo "$want  $HORCRUX" | sha256sum -c --quiet - 2>/dev/null; then echo "horcrux $HORCRUX_VERSION already installed"; return 0; fi
  [ -n "${HX_TEST:-}" ] && [ -x "$HORCRUX" ] && return 0   # tests: a stand-in horcrux
  tmp=$(mktemp)
  curl -fsSL "https://github.com/strangelove-ventures/horcrux/releases/download/$HORCRUX_VERSION/horcrux_linux-$arch" -o "$tmp"
  echo "$want  $tmp" | sha256sum -c --quiet - || { rm -f "$tmp"; die "horcrux download does not match its pinned SHA-256: refused"; }
  install -m 755 "$tmp" "$HORCRUX" && rm -f "$tmp"
  echo "horcrux $HORCRUX_VERSION ($arch): SHA-256 ok"
}

# Opens a TCP port on this machine's own firewall for the given addresses only (a cloud firewall is separate).
allow_from() {
  local port=$1 ip; shift
  [ -n "${HX_TEST:-}" ] && { echo "allow $port/tcp from $*"; return 0; }
  for ip in "$@"; do
    if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
      ufw allow from "$ip" to any port "$port" proto tcp >/dev/null && echo "ufw: $port/tcp from $ip"
    elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
      firewall-cmd -q --permanent --add-rich-rule="rule family=ipv4 source address=$ip port port=$port protocol=tcp accept" && firewall-cmd -q --reload && echo "firewalld: $port/tcp from $ip"
    elif command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
      iptables -C INPUT -s "$ip" -p tcp --dport "$port" -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -s "$ip" -p tcp --dport "$port" -j ACCEPT
      echo "iptables: $port/tcp from $ip"
    fi
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi
  echo "in your cloud's firewall allow TCP $port from $* only (Oracle: security list; Google: VPC firewall rule)"
}

valoper() { asn "$ZETAPHYD keys show validator --bech val -a --keyring-backend test --keyring-dir $KEYS_DIR --home $NODE_HOME"; }

# ---- on the node -------------------------------------------------------------------------------
shard() {
  root
  local c n=0 cos=() f
  read -r -a cos <<<"${COSIGNERS:-}"
  [ "${#cos[@]}" = "$SHARDS" ] || die "COSIGNERS: the $SHARDS cosigner addresses, e.g. COSIGNERS=\"10.0.0.11 10.0.0.12 10.0.0.13\""
  for c in "${cos[@]}" "${NODE_ADDR:-}"; do host_ok "$c" || die "not an address: '$c' (NODE_ADDR: this node's address as the cosigners reach it)"; done
  [ -f "$MARKER" ] && die "this node already signs through Horcrux ($MARKER)"
  f="$NODE_HOME/config/priv_validator_key.json"
  [ -f "$f" ] || die "no $f here: run this on the validator node"
  grep -qsE '^priv_validator_laddr = ""' "$NODE_HOME/config/config.toml" || die "priv_validator_laddr is already set in config.toml"
  if [ -z "${HX_TEST:-}" ]; then
    asn "$ZETAPHYD q staking validator $(valoper) --home $NODE_HOME -o json" >/dev/null 2>&1 \
      || die "this node is not a validator yet: switch only after it has staked (zetaphy-validator status)"
  fi
  [ -f "$NODE_HOME/config/pq_vote_key.seed" ] || echo "note: no pq_vote_key.seed; the ML-DSA vote key is not touched by Horcrux either way"
  [ -e "$WORK" ] && die "$WORK exists from an earlier run: look at it, then remove it (shred) to start again"
  install_horcrux
  install -d -m 700 "$WORK"
  say "the ed25519 key, split $THRESHOLD of $SHARDS, and the cosigners' own encryption keys"
  "$HORCRUX" create-ecies-shards --shards "$SHARDS" --out "$WORK" >/dev/null
  "$HORCRUX" create-ed25519-shards --chain-id "$CHAIN_ID" --key-file "$f" --threshold "$THRESHOLD" --shards "$SHARDS" --out "$WORK" >/dev/null
  local args=(--node "tcp://$NODE_ADDR:$PRIVVAL_PORT" --threshold "$THRESHOLD" --grpc-timeout 1500ms --raft-timeout 1500ms)
  for c in "${cos[@]}"; do args+=(--cosigner "tcp://$c:$P2P_PORT"); done
  "$HORCRUX" config init --home "$WORK/cfg" "${args[@]}" >/dev/null
  for n in $(seq 1 "$SHARDS"); do
    local d="$WORK/cosigner_$n"
    cp "$WORK/cfg/config.yaml" "$d/config.yaml"
    for f in config.yaml ecies_keys.json "${CHAIN_ID}_shard.json"; do [ -s "$d/$f" ] || die "missing $d/$f"; done
    tar -C "$d" -czf - config.yaml ecies_keys.json "${CHAIN_ID}_shard.json" | base64 -w0 > "$WORK/cosigner_$n.b64"
    chmod 600 "$WORK/cosigner_$n.b64"
  done
  say "ready"
  cat <<EOF
Bundles for the $SHARDS cosigners are in $WORK (root only). Each holds one key shard: one shard alone
cannot sign, but keep them out of chats and e-mail like any key.
Next, for N = 1, 2, 3:
  1. here:            sudo bash $0 bundle N        (prints bundle N)
  2. on cosigner N:   sudo bash setup-horcrux.sh cosigner N   and paste it
     (copy it between two browser SSH windows / Cloud Shell tabs; never into a chat or a file on your computer)
Then here:            sudo bash $0 switch
EOF
}

bundle() {
  root
  local n=${1:-}
  if ! [[ "$n" =~ ^[1-9]$ ]] || [ "$n" -gt "$SHARDS" ]; then die "bundle N, N = 1..$SHARDS"; fi
  [ -f "$WORK/cosigner_$n.b64" ] || die "no bundle $n: run shard first"
  echo "Copy everything from BEGIN to END into cosigner $n (sudo bash setup-horcrux.sh cosigner $n)."
  echo "-----BEGIN ZETAPHY HORCRUX $n-----"
  fold -w 76 "$WORK/cosigner_$n.b64"; echo
  echo "-----END ZETAPHY HORCRUX $n-----"
  echo "check on the cosigner: $(base64 -d "$WORK/cosigner_$n.b64" | sha256sum | cut -c1-16)"
}

# The node signs through Horcrux from here on. priv_validator_key.json is replaced by a stand-in
# that carries the validator's address (read by the ML-DSA vote code and "zetaphyd tx pq-vote-key")
# with a fresh, unused private key; CometBFT signs nothing with it while priv_validator_laddr is set.
switch() {
  root
  local f="$NODE_HOME/config/priv_validator_key.json" addr h next tmp
  [ -f "$MARKER" ] && die "already switched ($MARKER)"
  [ -d "$WORK" ] || die "run shard first"
  addr=$(jq -r .address "$f")
  [[ "$addr" =~ ^[0-9A-F]{40}$ ]] || die "cannot read the validator address from $f"
  cat <<EOF
This moves block signing to the Horcrux cosigners. Before going on:
  - all $SHARDS cosigners ran "cosigner N" and show their bundle check matching "bundle N" here
  - $f is backed up OFFLINE (zetaphy-validator backup): it is shredded from this machine;
    the only way back to a single key file is that copy (rollback)
  - its cloud firewall lets the cosigners reach this machine on TCP $PRIVVAL_PORT (and only them)
EOF
  ask "Go on (the node stops for a few minutes)?" || { echo "nothing changed"; return 0; }
  $SYSTEMCTL stop zetaphyd
  h=$(jq -r '.height // "0"' "$NODE_HOME/data/priv_validator_state.json")
  [[ "$h" =~ ^[0-9]+$ ]] || die "cannot read the last signed height"
  next=$((h + 1))
  cat <<EOF

The node stopped after signing height $h. On EACH cosigner now run:
    sudo bash setup-horcrux.sh start $next
(the cosigners never sign below $next, so nothing this key already signed is signed again)
EOF
  local ok=''
  until [ "$ok" = started ]; do
    printf 'Type "started" once at least %s cosigners say "horcrux started": ' "$THRESHOLD"
    input ok || die "no answer: the node stays stopped; run switch again (it starts over safely)"
  done
  # the stand-in key file: a fresh key from "zetaphyd init" with the validator's address
  tmp=$(asn mktemp -d)
  asn "$ZETAPHYD init stand-in --chain-id $CHAIN_ID --home $tmp" >/dev/null 2>&1 || die "zetaphyd init failed"
  jq --arg a "$addr" '.address = $a' "$tmp/config/priv_validator_key.json" > "$f.stand-in"
  rm -rf "$tmp"
  shred -u "$f" 2>/dev/null || rm -f "$f"
  mv "$f.stand-in" "$f"; chmod 600 "$f"
  id "$NODE_USER" >/dev/null 2>&1 && chown "$NODE_USER:" "$f"
  cat > "$MARKER" <<EOF
This node signs blocks through Horcrux cosigners ($THRESHOLD of $SHARDS), switched $(date -u +%FT%TZ).
priv_validator_key.json here is a stand-in: validator address $addr, private key unused.
"zetaphyd comet show-validator" therefore shows the wrong public key; "horcrux address $CHAIN_ID zetaphy" on a cosigner shows the right one.
Back to a single key: sudo bash setup-horcrux.sh rollback (cosigners stopped first).
EOF
  asn "sed -i -E 's#^priv_validator_laddr = .*#priv_validator_laddr = \"tcp://0.0.0.0:$PRIVVAL_PORT\"#' '$NODE_HOME/config/config.toml'"
  local cos=()
  mapfile -t cos < <(grep -oE 'tcp://[^:"]+:'"$P2P_PORT" "$WORK/cfg/config.yaml" | sed -E 's#tcp://##; s#:[0-9]+$##')
  allow_from "$PRIVVAL_PORT" "${cos[@]}"
  $SYSTEMCTL start zetaphyd
  say "the node is starting with the remote signer"
  echo "watch it: journalctl -u zetaphyd -f   (and on a cosigner: journalctl -u horcrux -f)"
  echo "check:    sudo zetaphy-validator status   (the block height keeps going up, the validator stays BONDED)"
  if ask "Shred $WORK here now (the cosigners have their shards)?"; then
    find "$WORK" -type f -exec shred -u {} + 2>/dev/null; rm -rf "$WORK"; echo "shredded"
  else
    echo "kept: shred it once the cosigners sign (find $WORK -type f -exec shred -u {} +; rm -rf $WORK)"
  fi
}

rollback() {
  root
  local f="$NODE_HOME/config/priv_validator_key.json" back="${KEY_FILE:-/root/priv_validator_key.json}" addr h
  [ -f "$MARKER" ] || die "this node does not sign through Horcrux"
  addr=$(jq -r .address "$f")
  [ -f "$back" ] || die "put the offline backup of priv_validator_key.json at $back first (or KEY_FILE=path)"
  [ "$(jq -r .address "$back")" = "$addr" ] || die "$back is not this validator's key (address is not $addr)"
  echo "Stop horcrux on ALL cosigners first (sudo systemctl disable --now horcrux): a key file and a running"
  echo "cosigner cluster signing at the same time is double signing (slashed, jailed for good)."
  ask "Are all cosigners stopped?" || { echo "nothing changed"; return 0; }
  h=$(asn "$ZETAPHYD status --home $NODE_HOME" 2>/dev/null | jq -r '.sync_info.latest_block_height // "0"' || echo 0)
  if ! [[ "$h" =~ ^[0-9]+$ ]] || [ "$h" -eq 0 ]; then die "the node does not answer; start it, then run rollback again"; fi
  $SYSTEMCTL stop zetaphyd
  # never sign a height the cosigners may have signed: start two above the last block
  printf '{\n  "height": "%s",\n  "round": 0,\n  "step": 0\n}\n' "$((h + 2))" > "$NODE_HOME/data/priv_validator_state.json"
  install -m 600 "$back" "$f"
  id "$NODE_USER" >/dev/null 2>&1 && chown "$NODE_USER:" "$f" "$NODE_HOME/data/priv_validator_state.json"
  asn "sed -i -E 's#^priv_validator_laddr = .*#priv_validator_laddr = \"\"#' '$NODE_HOME/config/config.toml'"
  rm -f "$MARKER"
  $SYSTEMCTL start zetaphyd
  shred -u "$back" 2>/dev/null || rm -f "$back"
  echo "back to the key file; the node signs from height $((h + 2)). Remove the shards from the cosigners (shred)."
}

# ---- on a cosigner -----------------------------------------------------------------------------
cosigner() {
  root
  local n=${1:-} line b64='' tmp sum peers=()
  if ! [[ "$n" =~ ^[1-9]$ ]] || [ "$n" -gt "$SHARDS" ]; then die "cosigner N, N = 1..$SHARDS"; fi
  [ -s "$HX_HOME/${CHAIN_ID}_shard.json" ] && die "this machine already holds a shard ($HX_HOME)"
  install_horcrux
  id "$HX_USER" >/dev/null 2>&1 || [ -n "${HX_TEST:-}" ] || useradd -m -s /usr/sbin/nologin "$HX_USER"
  echo "Paste bundle $n (from BEGIN to END, as printed by 'bundle $n' on the node), then press Enter:"
  while input line; do
    case "$line" in
      "-----BEGIN ZETAPHY HORCRUX $n-----") b64='' ;;
      "-----END ZETAPHY HORCRUX $n-----") break ;;
      -----*) die "that is not bundle $n" ;;
      *) b64+=$(tr -cd 'A-Za-z0-9+/=' <<<"$line") ;;
    esac
  done
  [ -n "$b64" ] || die "nothing pasted"
  tmp=$(mktemp -d); chmod 700 "$tmp"
  base64 -d <<<"$b64" > "$tmp/b.tgz" 2>/dev/null || { rm -rf "$tmp"; die "the paste is not a complete bundle"; }
  sum=$(sha256sum "$tmp/b.tgz" | cut -c1-16)
  tar -xzf "$tmp/b.tgz" -C "$tmp" config.yaml ecies_keys.json "${CHAIN_ID}_shard.json" 2>/dev/null || { rm -rf "$tmp"; die "the paste is not a complete bundle"; }
  grep -qE '"id": ?'"$n"'[,}]' "$tmp/${CHAIN_ID}_shard.json" || { rm -rf "$tmp"; die "that bundle is for another cosigner"; }
  install -d -m 700 "$HX_HOME" "$HX_HOME/state"
  install -m 600 "$tmp/config.yaml" "$tmp/ecies_keys.json" "$tmp/${CHAIN_ID}_shard.json" "$HX_HOME/"
  find "$tmp" -type f -exec shred -u {} + 2>/dev/null; rm -rf "$tmp"
  id "$HX_USER" >/dev/null 2>&1 && chown -R "$HX_USER:" "$HX_HOME"
  if [ -z "${HX_TEST:-}" ]; then
    cat > /etc/systemd/system/horcrux.service <<EOF
[Unit]
Description=Horcrux cosigner $n for ZETAPHY ($THRESHOLD of $SHARDS)
After=network-online.target
Wants=network-online.target

[Service]
User=$HX_USER
ExecStart=$HORCRUX start --home $HX_HOME
Restart=on-failure
RestartSec=3
LimitNOFILE=4096
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
    $SYSTEMCTL daemon-reload
  fi
  mapfile -t peers < <(grep -oE 'tcp://[^:"]+:'"$P2P_PORT" "$HX_HOME/config.yaml" | sed -E 's#tcp://##; s#:[0-9]+$##')
  allow_from "$P2P_PORT" "${peers[@]}"
  say "cosigner $n ready (bundle check $sum: compare with the node)"
  echo "It starts when the node switches: wait for 'sudo bash setup-horcrux.sh start HEIGHT' from the node's switch step."
}

start() {
  root
  local h=${1:-}
  [[ "$h" =~ ^[0-9]+$ ]] || die "start HEIGHT (switch on the node prints it)"
  [ -s "$HX_HOME/${CHAIN_ID}_shard.json" ] || die "no shard here: run cosigner N first"
  $SYSTEMCTL stop horcrux >/dev/null 2>&1 || true
  if id "$HX_USER" >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
    su -s /bin/bash "$HX_USER" -c "$HORCRUX state set $CHAIN_ID $h --home $HX_HOME"
  else
    "$HORCRUX" state set "$CHAIN_ID" "$h" --home "$HX_HOME"
  fi
  $SYSTEMCTL enable --now horcrux >/dev/null 2>&1 || $SYSTEMCTL start horcrux
  say "horcrux started (signs from height $h on)"
  echo "logs: journalctl -u horcrux -f"
}

case "${1:-}" in
  install) root; install_horcrux ;;
  shard) shard ;;
  bundle) bundle "${2:-}" ;;
  switch) switch ;;
  rollback) rollback ;;
  cosigner) cosigner "${2:-}" ;;
  start) start "${2:-}" ;;
  *) sed -n '2,19p' "$0"; exit 1 ;;
esac
