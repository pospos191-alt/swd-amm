#!/bin/bash
# ZETAPHY Saphan, EVM route: the Hyperlane validator and relayer (ZETAPHY <-> Sepolia).
#
# Run it on the Oracle VM (Ubuntu 22.04/24.04, x86_64 or arm64), with sudo:
#
#   sudo bash setup-agents.sh                install Docker, the pinned agent image, the config,
#                                            two keys made on this machine; start the validator;
#                                            print the two addresses (never a key)
#   sudo RELAYER_SENDERS=0xA,0xB bash setup-agents.sh start-relayer
#                                            start the relayer; it relays only messages sent by
#                                            these contracts (our bridge lanes), so nobody can
#                                            spend its Sepolia ETH
#   sudo bash setup-agents.sh status         services, announce, latest checkpoint, balances
#   sudo bash setup-agents.sh addresses      the two addresses again
#   sudo bash setup-agents.sh logs [validator|relayer]
#   sudo bash setup-agents.sh stop           stop both
#
# The validator signs ZETAPHY -> Sepolia checkpoints into /var/lib/hyperlane/checkpoints
# (local storage: the relayer on this same VM reads them). It needs no gas on Sepolia.
# The relayer delivers Sepolia -> ZETAPHY (gas 0) and ZETAPHY -> Sepolia (needs Sepolia ETH).
#
# Safe to re-run. Keys are 32 bytes from /dev/urandom, written once to /etc/hyperlane
# (root only, mode 600) and handed to the containers in a root-only env file. Nothing
# secret is printed, logged or sent anywhere. Docs (Thai): zetaphy-chain/hyperlane/README.th.md
set -euo pipefail

# ---- pinned ------------------------------------------------------------------
# ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.3.0 (multi-arch index digest, 23 Oct 2026)
IMAGE="${IMAGE:-ghcr.io/hyperlane-xyz/hyperlane-agent@sha256:6414aecfdc1b6ea2e364019f672004c113c2a347dd4d1343aa856921d1e0a685}"
# agent-config.json from swd-amm main at 710e5f9 (PR #51), refused if the hash differs
CONFIG_URL="https://raw.githubusercontent.com/pospos191-alt/swd-amm/710e5f91020998cbf9858754693e2e10265626fa/zetaphy-chain/hyperlane/agent-config.json"
CONFIG_SHA256="858b7f0fbcf0e9fb594e14be58c7910050c7d538c72eba31baa47da7a07d1691"

ETC=/etc/hyperlane
DATA=/var/lib/hyperlane
SETTINGS=$ETC/settings.env
AGENT_UID=10391   # the containers run as this uid, never root

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run with sudo"

# settings given once as env vars are kept; env wins
[ -f "$SETTINGS" ] && { while IFS='=' read -r k v; do [ -n "$k" ] && [ -z "${!k:-}" ] && export "$k=$v"; done < "$SETTINGS"; }
save() { mkdir -p "$ETC"; touch "$SETTINGS"; chmod 600 "$SETTINGS"; grep -v "^$1=" "$SETTINGS" > "$SETTINGS.new" || true; echo "$1=$2" >> "$SETTINGS.new"; mv "$SETTINGS.new" "$SETTINGS"; }

# ---- key + address (pure Python: keccak-256 and secp256k1, checked against ethers) ----
keytool() {
python3 -I - "$@" <<'PY'
import os, sys
RC=[0x1,0x8082,0x800000000000808A,0x8000000080008000,0x808B,0x80000001,0x8000000080008081,0x8000000000008009,0x8A,0x88,0x80008009,0x8000000A,0x8000808B,0x800000000000008B,0x8000000000008089,0x8000000000008003,0x8000000000008002,0x8000000000000080,0x800A,0x800000008000000A,0x8000000080008081,0x8000000000008080,0x80000001,0x8000000080008008]
ROT=[[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]]
M=(1<<64)-1
def rol(x,n): return ((x<<n)|(x>>(64-n)))&M if n else x
def f(A):
    for rc in RC:
        C=[A[x][0]^A[x][1]^A[x][2]^A[x][3]^A[x][4] for x in range(5)]
        D=[C[(x-1)%5]^rol(C[(x+1)%5],1) for x in range(5)]
        A=[[A[x][y]^D[x] for y in range(5)] for x in range(5)]
        B=[[0]*5 for _ in range(5)]
        for x in range(5):
            for y in range(5): B[y][(2*x+3*y)%5]=rol(A[x][y],ROT[x][y])
        A=[[B[x][y]^((~B[(x+1)%5][y])&B[(x+2)%5][y]) for y in range(5)] for x in range(5)]
        A[0][0]^=rc
    return A
def keccak(data):
    r=136; p=bytearray(data)+b'\x01'
    while len(p)%r: p+=b'\x00'
    p[-1]|=0x80
    A=[[0]*5 for _ in range(5)]
    for i in range(0,len(p),r):
        for j in range(r//8): A[j%5][j//5]^=int.from_bytes(p[i+8*j:i+8*j+8],'little')
        A=f(A)
    return b''.join(A[j%5][j//5].to_bytes(8,'little') for j in range(4))
P=2**256-2**32-977; N=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G=(0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
def add(a,b):
    if a is None: return b
    if b is None: return a
    if a[0]==b[0] and (a[1]+b[1])%P==0: return None
    l=(3*a[0]*a[0]*pow(2*a[1],-1,P) if a==b else (b[1]-a[1])*pow(b[0]-a[0],-1,P))%P
    x=(l*l-a[0]-b[0])%P; return (x,(l*(a[0]-x)-a[1])%P)
def mul(k,pt=G):
    r=None
    while k:
        if k&1: r=add(r,pt)
        pt=add(pt,pt); k>>=1
    return r
def address(key):
    k=int.from_bytes(key,'big'); assert 0<k<N
    x,y=mul(k); h=keccak(x.to_bytes(32,'big')+y.to_bytes(32,'big'))[-20:].hex()
    c=keccak(h.encode()).hex()  # EIP-55 checksum
    return '0x'+''.join(ch.upper() if int(c[i],16)>=8 else ch for i,ch in enumerate(h))
cmd, path = sys.argv[1], sys.argv[2]
if cmd == 'new' and not os.path.exists(path):
    while True:
        key=os.urandom(32)
        if 0<int.from_bytes(key,'big')<N: break
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    os.write(fd,('0x'+key.hex()).encode()); os.close(fd)
print(address(bytes.fromhex(open(path).read().strip()[2:])))
PY
}
addr_of() { keytool addr "$ETC/$1.key"; }

rpc() { # rpc <url> <method> <params-json>
  curl -fsS --max-time 20 -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$1" | jq -r '.result // empty'
}
cfg() { jq -r "$1" "$ETC/agent-config.json"; }
eth() { local w; w=$(rpc "$1" eth_getBalance "[\"$2\",\"latest\"]" 2>/dev/null) || { echo '?'; return; }
  [ -n "$w" ] && python3 -c "print(f'{int(\"$w\",16)/1e18:.6f}')" || echo '?'; }

# ---- install -----------------------------------------------------------------
install_all() {
  say "packages (Docker, jq, curl, python3)"
  command -v apt-get >/dev/null || die "this script needs Ubuntu (apt-get)"
  need=(); for p in docker.io jq curl python3 ca-certificates; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
  if command -v docker >/dev/null; then need=("${need[@]/docker.io}"); fi
  if [ -n "${need[*]// /}" ]; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${need[*]}; fi
  systemctl enable --now docker >/dev/null 2>&1 || true

  say "agent image (pinned by digest)"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE"

  say "folders and config"
  install -d -m 700 "$ETC"
  install -d -m 755 "$DATA"
  for d in validator relayer checkpoints; do install -d -m 750 -o "$AGENT_UID" -g "$AGENT_UID" "$DATA/$d"; done
  if [ -n "${AGENT_CONFIG:-}" ]; then
    install -m 644 "$AGENT_CONFIG" "$ETC/agent-config.json"   # tests only
  else
    curl -fsSL --max-time 60 "$CONFIG_URL" -o "$ETC/agent-config.json.new"
    echo "$CONFIG_SHA256  $ETC/agent-config.json.new" | sha256sum -c --quiet - || { rm -f "$ETC/agent-config.json.new"; die "agent-config.json hash mismatch: refused"; }
    mv "$ETC/agent-config.json.new" "$ETC/agent-config.json"; chmod 644 "$ETC/agent-config.json"
  fi
  [ "$(cfg .chains.zetaphy.domainId)" = 77390 ] || die "agent-config.json has no ZETAPHY (domain 77390)"

  say "keys (made here, never printed)"
  keytool new "$ETC/validator.key" >/dev/null
  keytool new "$ETC/relayer.key" >/dev/null
  chmod 600 "$ETC"/*.key

  if [ -z "${SEPOLIA_FROM:-}" ]; then
    # the relayer reads Sepolia from now on (the bridge is not deployed yet), not from 2023
    for u in $(cfg '.chains.sepolia.rpcUrls[].http'); do
      h=$(rpc "$u" eth_blockNumber '[]' 2>/dev/null || true); [ -n "$h" ] && { SEPOLIA_FROM=$((h)); break; }
    done
    [ -n "${SEPOLIA_FROM:-}" ] || die "no Sepolia RPC answered: try again later"
  fi
  save SEPOLIA_FROM "$SEPOLIA_FROM"

  write_units
  say "start the validator"
  systemctl enable --now hyperlane-validator >/dev/null
  sleep 3; systemctl is-active --quiet hyperlane-validator || { journalctl -u hyperlane-validator -n 30 --no-pager; die "validator did not start"; }
  show_addresses
  cat <<EOF

Next:
  1. send 1 ZETAPHY to the validator address (pays its one-time announce on ZETAPHY)
  2. send the validator address to Najaso: the Sepolia side must trust it
  3. later, after the bridge is deployed:
       sudo RELAYER_SENDERS=0x…,0x… bash setup-agents.sh start-relayer
EOF
}

env_file() { # env_file <name> <lines…>: root-only, read by docker, not by the container user
  local f="$ETC/$1.env"; shift
  umask 077; printf '%s\n' "$@" > "$f.new"; mv "$f.new" "$f"; chmod 600 "$f"
}

write_units() {
  local vk
  vk=$(tr -d '[:space:]' < "$ETC/validator.key")
  # the chain signer sends the validator's one-time announce on ZETAPHY: the validator key itself
  env_file validator CONFIG_FILES=/config/agent-config.json HYP_ORIGINCHAINNAME=zetaphy HYP_DB=/data \
    HYP_VALIDATOR_TYPE=hexKey "HYP_VALIDATOR_KEY=$vk" HYP_CHAINS_ZETAPHY_SIGNER_TYPE=hexKey "HYP_CHAINS_ZETAPHY_SIGNER_KEY=$vk" \
    HYP_CHECKPOINTSYNCER_TYPE=localStorage HYP_CHECKPOINTSYNCER_PATH=/checkpoints \
    HYP_CHAINS_ZETAPHY_INDEX_CHUNK=499 HYP_METRICSPORT=9090 HYP_LOG_FORMAT=pretty HYP_LOG_LEVEL=info
  unit validator 9090 "-v $DATA/checkpoints:/checkpoints" 700m
  unset vk
}

write_relayer() {
  local rk senders
  rk=$(tr -d '[:space:]' < "$ETC/relayer.key")
  senders=$(printf '%s' "$RELAYER_SENDERS" | tr ',' '\n' | sed 's/ //g' | grep -E '^0x[0-9a-fA-F]{40}$' | sed 's/^0x/0x000000000000000000000000/' | tr 'A-F' 'a-f' | jq -R . | jq -sc .)
  [ "$(echo "$senders" | jq length)" -gt 0 ] || die "RELAYER_SENDERS: give the bridge contracts as 0x…,0x…"
  env_file relayer CONFIG_FILES=/config/agent-config.json HYP_RELAYCHAINS="${RELAY_CHAINS:-zetaphy,sepolia}" HYP_DB=/data \
    HYP_DEFAULTSIGNER_TYPE=hexKey "HYP_DEFAULTSIGNER_KEY=$rk" HYP_ALLOWLOCALCHECKPOINTSYNCERS=true \
    'HYP_GASPAYMENTENFORCEMENT=[{"type":"none"}]' "HYP_WHITELIST=[{\"senderAddress\":$senders}]" \
    HYP_CHAINS_ZETAPHY_INDEX_CHUNK=499 "HYP_CHAINS_SEPOLIA_INDEX_FROM=$SEPOLIA_FROM" \
    HYP_METRICSPORT=9091 HYP_LOG_FORMAT=pretty HYP_LOG_LEVEL=info
  unit relayer 9091 "-v $DATA/checkpoints:/checkpoints:ro" 1200m
  unset rk
}

unit() { # unit <agent> <metrics port> <extra mounts> <memory>
  cat > "/etc/systemd/system/hyperlane-$1.service" <<EOF
[Unit]
Description=Hyperlane $1 (ZETAPHY Saphan)
After=docker.service network-online.target
Requires=docker.service

[Service]
ExecStartPre=-/usr/bin/docker rm -f hyp-$1
ExecStart=/usr/bin/docker run --rm --name hyp-$1 --user $AGENT_UID:$AGENT_UID --memory $4 \\
  --cap-drop ALL --security-opt no-new-privileges --env-file $ETC/$1.env \\
  -v $ETC/agent-config.json:/config/agent-config.json:ro -v $DATA/$1:/data $3 \\
  -p 127.0.0.1:$2:$2 $IMAGE ./$1
ExecStop=/usr/bin/docker stop -t 30 hyp-$1
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

show_addresses() {
  say "addresses (fund these; the keys stay in $ETC)"
  echo "validator  $(addr_of validator)   ZETAPHY: 1 ZETAPHY once (announce)"
  echo "relayer    $(addr_of relayer)   Sepolia: ETH for ZETAPHY -> Sepolia deliveries"
}

status() {
  for a in validator relayer; do printf '%-10s %s\n' "$a" "$(systemctl is-active hyperlane-$a 2>/dev/null || true)"; done
  [ -f "$ETC/validator.key" ] || { echo "not installed: sudo bash setup-agents.sh"; return; }
  local zr sr cp
  zr=$(cfg '.chains.zetaphy.rpcUrls[0].http'); sr=$(cfg '.chains.sepolia.rpcUrls[0].http')
  cp=$(ls "$DATA/checkpoints" 2>/dev/null | grep -E '^[0-9]+_with_id\.json$' | sort -n | tail -1 || true)
  local va me; va=$(cfg .chains.zetaphy.validatorAnnounce); me=$(addr_of validator | tr 'A-F' 'a-f')
  if rpc "$zr" eth_call "[{\"to\":\"$va\",\"data\":\"0x690cb786\"},\"latest\"]" 2>/dev/null | grep -q "${me#0x}"; then
    echo "announced  yes"; else echo "announced  not yet (needs 1 ZETAPHY on the validator address)"; fi
  echo "checkpoint ${cp:-none yet (no ZETAPHY -> Sepolia message sent yet)}"
  echo "validator  $(addr_of validator)  ZETAPHY $(eth "$zr" "$(addr_of validator)")"
  echo "relayer    $(addr_of relayer)  ZETAPHY $(eth "$zr" "$(addr_of relayer)")  Sepolia $(eth "$sr" "$(addr_of relayer)")"
  echo "relaying   ${RELAYER_SENDERS:-(relayer not started)}"
}

case "${1:-install}" in
  install) install_all ;;
  start-relayer)
    [ -f "$ETC/relayer.key" ] || die "run 'sudo bash setup-agents.sh' first"
    [ -n "${RELAYER_SENDERS:-}" ] || die "RELAYER_SENDERS=0x…,0x… (the bridge lanes) is needed"
    save RELAYER_SENDERS "$RELAYER_SENDERS"; [ -n "${RELAY_CHAINS:-}" ] && save RELAY_CHAINS "$RELAY_CHAINS"
    # one (re)start only: enable --now followed by restart races on the container name
    write_relayer; systemctl enable hyperlane-relayer >/dev/null 2>&1; systemctl restart hyperlane-relayer
    up=no; for _ in $(seq 1 15); do
      sleep 2
      systemctl is-active --quiet hyperlane-relayer && [ "$(docker inspect -f '{{.State.Running}}' hyp-relayer 2>/dev/null)" = true ] && { up=yes; break; }
    done
    [ "$up" = yes ] || { journalctl -u hyperlane-relayer -n 30 --no-pager; die "relayer did not start"; }
    echo "relayer started" ;;
  status) status ;;
  addresses) show_addresses ;;
  logs) journalctl -u "hyperlane-${2:-validator}" -n 60 --no-pager ;;
  stop) systemctl stop hyperlane-validator hyperlane-relayer 2>/dev/null || true; echo stopped ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
