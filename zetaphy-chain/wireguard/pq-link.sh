#!/bin/bash
# ZETAPHY: validator <-> sentry links over WireGuard with a post-quantum pre-shared key (optional).
#
# CometBFT's own peer connection (SecretConnection: X25519 + Ed25519 node keys) is kept as it is and runs
# inside the tunnel. WireGuard mixes a 32-byte pre-shared key (PSK) into its handshake, so recorded tunnel
# traffic stays secret, and a peer cannot be impersonated, even by someone who can later break X25519,
# as long as the PSK stays secret. The PSK is random (wg genpsk) and travels only over SSH restricted to a
# post-quantum hybrid key exchange (mlkem768x25519-sha256 or sntrup761x25519-sha512); nothing is sent if the
# two machines cannot agree on one. What it does not give: forward secrecy against a quantum attacker who
# later steals the PSK (rotate it: run `psk` / `send-psk` / `peer` / `up` again, or use Rosenpass, which
# replaces the PSK every two minutes); and public peers of the sentry still use SecretConnection only.
# Guide: zetaphy-chain/wireguard/README.md
#
# As root on each machine (validator: tunnel 10.77.0.1, sentry: 10.77.0.2, for example):
#   pq-link.sh init <tunnel-ip>/<prefix> [listen-port]   this machine's WireGuard key; prints its public key
#   pq-link.sh psk <peer-name>                            a new random PSK for the link to <peer-name> (on ONE side)
#   pq-link.sh send-psk <peer-name> <user@host> [<name-there>]   copy it to the other side, post-quantum SSH only
#   pq-link.sh peer <peer-name> <public-key> <peer-tunnel-ip> [<host:port>]   add (or replace) the peer, with its PSK
#   pq-link.sh up                                         start or reload the tunnel (wg-quick@zetaphy-pq), at boot too
#   pq-link.sh comet-validator <sentry-node-id>@<sentry-tunnel-ip>   validator: peer only with the sentry, through the tunnel
#   pq-link.sh comet-sentry <validator-node-id>           sentry: keep the validator private and always connected
#   pq-link.sh status                                     wg show (latest handshake; "preshared key: (hidden)" = PSK in use)
set -euo pipefail

WG_DIR="${WG_DIR:-/etc/wireguard}"
IFACE="${IFACE:-zetaphy-pq}"
NODE_HOME="${NODE_HOME:-/home/zetaphy/.zetaphy}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
WG="${WG:-wg}"
SSH="${SSH:-ssh}"
CONF="$WG_DIR/$IFACE.conf"
# OpenSSH's post-quantum hybrid key exchanges (ML-KEM-768 from OpenSSH 9.9, Streamlined NTRU Prime from 8.5)
PQ_KEX=(mlkem768x25519-sha256 sntrup761x25519-sha512 sntrup761x25519-sha512@openssh.com)

die() { echo "pq-link: $*" >&2; exit 1; }
name_ok() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "peer name: lowercase letters, digits and -, e.g. sentry-1"; }
ip_ok() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "not an IPv4 address: $1"; }
key_ok() { [[ "$1" =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]] || die "not a WireGuard key: $1"; }
psk_file() { echo "$WG_DIR/$IFACE-$1.psk"; }
need_wg() { command -v "$WG" >/dev/null || die "wg not found: apt-get install -y wireguard-tools"; }

cmd_init() {
  local addr="${1:-}" port="${2:-51820}"
  [[ "$addr" =~ ^([0-9.]+)/([0-9]{1,2})$ ]] || die "usage: init <tunnel-ip>/<prefix> [listen-port], e.g. init 10.77.0.1/24"
  ip_ok "${BASH_REMATCH[1]}"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || die "listen port: a number"
  need_wg
  [ -f "$CONF" ] && die "$CONF exists already (peers are added with: peer)"
  install -d -m 700 "$WG_DIR"
  local key; key=$( umask 077; "$WG" genkey )
  ( umask 077; printf '[Interface]\nAddress = %s\nListenPort = %s\nPrivateKey = %s\n' "$addr" "$port" "$key" > "$CONF" )
  echo "public key of this machine (give it to the other side): $(printf '%s' "$key" | "$WG" pubkey)"
  echo "open UDP $port between the two machines only"
}

cmd_psk() {
  local peer="${1:-}"; name_ok "$peer"; need_wg
  install -d -m 700 "$WG_DIR"
  ( umask 077; "$WG" genpsk > "$(psk_file "$peer")" )
  echo "new pre-shared key: $(psk_file "$peer") (copy it with: send-psk $peer <user@host>)"
}

cmd_send_psk() {
  local peer="${1:-}" target="${2:-}" there="${3:-}"; name_ok "$peer"
  [ -n "$target" ] || die "usage: send-psk <peer-name> <user@host> [<name of this machine there>]"
  [[ "$target" =~ ^[A-Za-z0-9._@:-]+$ ]] || die "user@host: letters, digits and ._@:- only"
  there="${there:-$(hostname -s | tr 'A-Z_' 'a-z-')}"; name_ok "$there"
  local f; f=$(psk_file "$peer"); [ -s "$f" ] || die "no PSK for $peer yet: run psk $peer first"
  local have kex=() k
  have=$("$SSH" -Q kex 2>/dev/null || true)
  for k in "${PQ_KEX[@]}"; do grep -qx "$k" <<<"$have" && kex+=("$k"); done
  [ ${#kex[@]} -gt 0 ] || die "this OpenSSH has no post-quantum key exchange (needs OpenSSH >= 8.5): copy the PSK another way, or upgrade"
  local list; list=$(IFS=,; echo "${kex[*]}")
  # KexAlgorithms without +: only these may be used, so SSH refuses rather than falling back to classical X25519
  "$SSH" -o KexAlgorithms="$list" "$target" \
    "umask 077; sudo install -d -m 700 '$WG_DIR' && sudo sh -c 'umask 077; cat > \"$WG_DIR/$IFACE-$there.psk\"'" < "$f" \
    || die "not sent (the other side may not support $list)"
  echo "sent over SSH ($list) to $target:$WG_DIR/$IFACE-$there.psk; there, add this machine with: peer $there <this public key> <this tunnel ip> ..."
}

cmd_peer() {
  local peer="${1:-}" pub="${2:-}" ip="${3:-}" endpoint="${4:-}"; name_ok "$peer"; key_ok "$pub"; ip_ok "$ip"
  [ -z "$endpoint" ] || [[ "$endpoint" =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ ]] || die "endpoint: host:port"
  [ -f "$CONF" ] || die "run init first"
  local f; f=$(psk_file "$peer"); [ -s "$f" ] || die "no PSK for $peer: make it on one side (psk) and copy it here (send-psk)"
  local psk; psk=$(tr -d ' \n' < "$f"); key_ok "$psk"
  # drop this peer's earlier block (rotation, new endpoint), keep everything else
  local tmp; tmp=$(umask 077; mktemp "$WG_DIR/.conf.XXXXXX")
  awk -v tag="# zetaphy-pq peer $peer" '
    /^# zetaphy-pq peer / { skip = ($0 == tag) }
    /^\[Interface\]/ { skip = 0 }
    !skip' "$CONF" > "$tmp"
  {
    printf '\n# zetaphy-pq peer %s\n[Peer]\nPublicKey = %s\nPresharedKey = %s\nAllowedIPs = %s/32\n' "$peer" "$pub" "$psk" "$ip"
    [ -z "$endpoint" ] || printf 'Endpoint = %s\n' "$endpoint"
    printf 'PersistentKeepalive = 25\n'
  } >> "$tmp"
  mv "$tmp" "$CONF"; chmod 600 "$CONF"
  echo "peer $peer ($ip) set with its pre-shared key; apply with: up"
}

cmd_up() {
  [ -f "$CONF" ] || die "run init first"
  grep -q '^PresharedKey = ' "$CONF" || die "no peer with a pre-shared key in $CONF"
  if "$SYSTEMCTL" is-active --quiet "wg-quick@$IFACE"; then
    "$SYSTEMCTL" reload "wg-quick@$IFACE"   # wg syncconf: keeps the tunnel up while keys change
  else
    "$SYSTEMCTL" enable --now "wg-quick@$IFACE"
  fi
  echo "tunnel $IFACE up; check: pq-link.sh status"
}

comet_set() { # key value (the [p2p] keys used here are unique in config.toml)
  local cfg="$NODE_HOME/config/config.toml"
  grep -q "^$1 = " "$cfg" || die "$1 not found in $cfg"
  sed -i -E "s|^$1 = .*|$1 = $2|" "$cfg"
}
comet_backup() {
  local cfg="$NODE_HOME/config/config.toml"
  [ -f "$cfg" ] || die "no CometBFT config at $cfg (NODE_HOME?)"
  cp -p "$cfg" "$cfg.before-pq-link"
}

cmd_comet_validator() {
  local p="${1:-}"
  [[ "$p" =~ ^([0-9a-f]{40})@([0-9.]+)$ ]] || die "usage: comet-validator <sentry-node-id>@<sentry-tunnel-ip> (node id: zetaphyd comet show-node-id on the sentry)"
  ip_ok "${BASH_REMATCH[2]}"
  comet_backup
  comet_set persistent_peers "\"$p:26656\""
  comet_set seeds '""'
  comet_set pex false
  comet_set addr_book_strict false   # the sentry's address is a private tunnel address
  echo "validator now peers only with the sentry through the tunnel (backup: config.toml.before-pq-link)"
  echo "restart the node (systemctl restart zetaphyd), then close 26656 to everyone but the tunnel"
}

cmd_comet_sentry() {
  local id="${1:-}"
  [[ "$id" =~ ^[0-9a-f]{40}$ ]] || die "usage: comet-sentry <validator-node-id>"
  comet_backup
  local cfg="$NODE_HOME/config/config.toml" k cur
  for k in private_peer_ids unconditional_peer_ids; do
    cur=$(sed -n -E "s/^$k = \"(.*)\"$/\1/p" "$cfg")
    [[ ",$cur," == *",$id,"* ]] || cur="${cur:+$cur,}$id"
    comet_set "$k" "\"$cur\""
  done
  echo "sentry keeps the validator private and always connected (backup: config.toml.before-pq-link); restart the node"
}

case "${1:-}" in
  init) shift; cmd_init "$@" ;;
  psk) shift; cmd_psk "$@" ;;
  send-psk) shift; cmd_send_psk "$@" ;;
  peer) shift; cmd_peer "$@" ;;
  up) cmd_up ;;
  comet-validator) shift; cmd_comet_validator "$@" ;;
  comet-sentry) shift; cmd_comet_sentry "$@" ;;
  status) need_wg; "$WG" show "$IFACE" ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
