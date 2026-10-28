#!/bin/bash
# ZETAPHY EVOLVE — a NEW chain, option 2 (Rollup) from the shared-security
# document: Evolve (ev-node) with Celestia as the data-availability layer.
# Zero baht: one free Oracle/Google VM as the sequencer, Celestia Mocha
# testnet for DA (TIA from free faucets), its own gas coin from genesis.
# This is a separate new chain; the ZETAPHY Cosmos chain (77390) is not
# moved or touched.
#
# Run on a fresh Ubuntu 24.04 machine as root:
#   - paste this whole file as the cloud-init script when creating the VM, or
#   - sudo bash setup-evolve.sh    (browser SSH / Cloud Shell)
# Progress log: /var/log/zevolve-setup.log
#
# Sequencer mode (default): installs a Celestia light node (Mocha), waits
# until you send it a little faucet TIA, builds the Evolve EVM sequencer
# from the pinned source, starts ev-reth (pinned docker image) with a fresh
# genesis, and runs the chain behind https.
#
# Replica mode: JOIN=<host of a running sequencer> (e.g. 1-2-3-4.sslip.io)
# runs a read-only node that reconstructs the chain from Celestia alone
# (reading DA needs no TIA).
JOIN="${JOIN:-}"
# OPTIONAL: your MetaMask address, to receive 1,000,000 test coins at genesis
# (public address only, never a private key).
OWNER_EVM_ADDRESS="${OWNER_EVM_ADDRESS:-}"

set -euo pipefail

# ---- Parameters -------------------------------------------------------------
EVM_CHAIN_ID="${EVM_CHAIN_ID:-77392}"   # new chain (ZETAPHY=77390, OP-Stack trial=77391)
CHAIN_NAME="ZETAPHY EVOLVE Testnet"
COIN_SYMBOL="ZEVO"                      # native gas coin, minted in genesis
BLOCK_TIME="${BLOCK_TIME:-1s}"
# Lazy mode: blocks only when there are transactions, else one per interval.
# Longer interval = fewer Celestia blobs = the faucet TIA lasts longer.
LAZY_BLOCK_INTERVAL="${LAZY_BLOCK_INTERVAL:-60s}"
# Celestia Mocha consensus endpoint for the light node's state access
# (community list: docs.celestia.org, Mocha page).
CORE_IP="${CORE_IP:-rpc-mocha.pops.one}"
FUND_MIN_TIA="${FUND_MIN_TIA:-100000}"  # in utia; 100000 = 0.1 TIA (one web-faucet drip)
PUBLIC_HOST="${PUBLIC_HOST:-}"
[ -z "$PUBLIC_HOST" ] || [[ "$PUBLIC_HOST" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || { echo "PUBLIC_HOST: a DNS name like rpc.example.com"; exit 1; }
NO_SYSTEMD="${NO_SYSTEMD:-}"            # test hook

# ---- Pinned sources and binaries --------------------------------------------
EV_NODE_REPO="https://github.com/evstack/ev-node.git"
EV_NODE_TAG="v1.3.0"
EV_NODE_COMMIT="69edce1af8e3e1c111ef5787aed7cf40e757d671"
EV_RETH_IMAGE="ghcr.io/evstack/ev-reth:v0.7.0"          # published for amd64 and arm64
CELESTIA_VERSION="v0.34.4"                               # "mocha" = mocha-5 in this version
CELESTIA_SHA256_x86_64="0b883c381c3012ad4ed120f4258dba568ebba7c3c51fb932318d934d8821257c"
CELESTIA_SHA256_aarch64="78f3c7b8b14e7d66a257220ccbbb779e3f9cb7baafb0265dbd0c5c38c6fa0860"
GETH_LIB_VERSION="v1.16.5"              # go-ethereum, for the tiny key tool only
# Go: Ubuntu's golang-go (>=1.21) fetches the exact toolchain each pinned
# go.mod names (GOTOOLCHAIN), verified against Go's public checksum database.

NODE_USER="zevolve"
HOME_DIR="/home/${NODE_USER}"
DATA="$HOME_DIR/.zevolve"               # genesis, jwt, env files
SEQ_HOME="$DATA/seq"                    # ev-node home (config + data + signer)
KEYS_DIR="$HOME_DIR/.zevolve-keys"      # owner key; never leaves the machine
NS_BASE="zevolve${EVM_CHAIN_ID}"        # Celestia namespaces: ${NS_BASE}h / ${NS_BASE}d
PUB=/var/lib/zevolve-public             # served at https://<host>/zevolve/
LOG=/var/log/zevolve-setup.log
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")

exec 9>/run/zevolve-setup.lock
flock -n 9 || { echo "setup-evolve.sh is already running (tail -f $LOG)"; exit 1; }
touch "$LOG" && chmod 640 "$LOG"
exec > >(tee -a "$LOG") 2>&1
step() { echo; echo "== $(date -u +%FT%TZ) $*"; }

step "1/9 packages"
apt_get() { apt-get -o DPkg::Lock::Timeout=900 "$@"; }
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  need=""
  for p in git jq curl gcc openssl docker; do command -v "$p" >/dev/null || need=1; done
  if [ -n "$need" ]; then
    apt_get update -y && apt_get install -y git jq curl build-essential ca-certificates openssl docker.io
  fi
fi

step "2/9 swap (small machines need it to compile)"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 6000000 ] && ! swapon --show | grep -q . && [ -z "$NO_SYSTEMD" ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "3/9 user"
id "$NODE_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$NODE_USER"
as_node() { su -s /bin/bash "$NODE_USER" -c "$*"; }
as_node "mkdir -p '$DATA' '$KEYS_DIR' && chmod 700 '$KEYS_DIR'"

step "4/9 Celestia light node (Mocha; DA layer, free)"
arch=$(uname -m)
case "$arch" in
  x86_64)  cel_asset=x86_64;  cel_sha=$CELESTIA_SHA256_x86_64 ;;
  aarch64) cel_asset=arm64;   cel_sha=$CELESTIA_SHA256_aarch64 ;;
  *) echo "unsupported CPU: $arch"; exit 1 ;;
esac
if [ ! -x /usr/local/bin/celestia ]; then
  curl -fsSL -o /tmp/celestia.tgz \
    "https://github.com/celestiaorg/celestia-node/releases/download/${CELESTIA_VERSION}/celestia-node_Linux_${cel_asset}.tar.gz"
  echo "$cel_sha  /tmp/celestia.tgz" | sha256sum -c --quiet -
  tar -xzf /tmp/celestia.tgz -C /tmp celestia
  install -m 755 /tmp/celestia /usr/local/bin/celestia && rm -f /tmp/celestia /tmp/celestia.tgz
fi
cel() { su -s /bin/bash "$NODE_USER" -c "celestia $*"; }
as_node "ls -d \"\$HOME\"/.celestia-light-* >/dev/null 2>&1" || cel "light init --p2p.network mocha"
CEL_STORE=$(as_node "ls -d \"\$HOME\"/.celestia-light-* | head -1")
cels() { su -s /bin/bash "$NODE_USER" -c "celestia $1 --node.store '$CEL_STORE' ${*:2}"; }
if [ -z "$NO_SYSTEMD" ] && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/zevolve-celestia.service <<EOF
[Unit]
Description=$CHAIN_NAME DA: Celestia light node (Mocha)
After=network-online.target
Wants=network-online.target

[Service]
User=$NODE_USER
ExecStart=/usr/local/bin/celestia light start --p2p.network mocha --core.ip $CORE_IP --core.port 9090
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable zevolve-celestia >/dev/null 2>&1 && systemctl restart zevolve-celestia
fi
# Wait for the node RPC, then read our Celestia account address.
for i in $(seq 1 60); do
  CEL_ADDR=$(cels "state account-address" 2>/dev/null | jq -r '.result // empty' 2>/dev/null) && [ -n "$CEL_ADDR" ] && break
  sleep 5
done
[ -n "${CEL_ADDR:-}" ] || { echo "celestia light node did not come up (journalctl -u zevolve-celestia)"; exit 1; }
echo "Celestia (Mocha) account: $CEL_ADDR"

if [ -z "$JOIN" ]; then
  step "5/9 waiting for free TIA on the Celestia account (pays for DA blobs)"
  cat <<MSG
+----------------------------------------------------------------------+
 Send some Mocha TIA (testnet, free) to:

   $CEL_ADDR

 Free faucets (0 baht):
   - https://mocha.celenium.io/faucet
   - https://faucet.noders.services/celestia   (0.1 TIA per 12 hours)
   - Celestia Discord #mocha-faucet:  \$request $CEL_ADDR   (10 TIA/week)

 Waiting for at least $FUND_MIN_TIA utia; checked every 30 s.
+----------------------------------------------------------------------+
MSG
  while :; do
    bal=$(cels "state balance" 2>/dev/null | jq -r '.result.amount // "0"' 2>/dev/null || echo 0)
    echo "$(date -u +%FT%TZ)  balance: ${bal:-0} utia (need $FUND_MIN_TIA)"
    [ "${bal:-0}" -ge "$FUND_MIN_TIA" ] 2>/dev/null && break
    sleep 30
  done
fi

step "6/9 build the Evolve EVM sequencer binary (pinned source)"
GO=$(command -v go || true)
[ -z "$GO" ] && [ -x /usr/local/go/bin/go ] && GO=/usr/local/go/bin/go
if [ -z "$GO" ]; then apt_get install -y golang-go && GO=$(command -v go); fi
minor=$("$GO" env GOVERSION | sed -E 's/^go1\.([0-9]+).*/\1/')
[ "$minor" -ge 21 ] || { echo "Go $("$GO" env GOVERSION) is too old; use Ubuntu 24.04"; exit 1; }
goenv="PATH=$(dirname "$GO"):\$PATH GOTOOLCHAIN=auto"
[ "$mem_kb" -lt 6000000 ] && goenv="$goenv GOFLAGS=-p=1 GOGC=50"
SRC="$HOME_DIR/src/ev-node"
if [ ! -x /usr/local/bin/evolve-evm ] || [ -n "${FORCE_BUILD:-}" ]; then
  if [ ! -d "$SRC/.git" ]; then
    as_node "mkdir -p '$HOME_DIR/src' && git clone -q --depth 1 --branch '$EV_NODE_TAG' '$EV_NODE_REPO' '$SRC'"
  fi
  got=$(as_node "git -C '$SRC' rev-parse HEAD")
  [ "$got" = "$EV_NODE_COMMIT" ] || { echo "ev-node commit $got != pinned $EV_NODE_COMMIT"; exit 1; }
  as_node "cd '$SRC/apps/evm' && $goenv go build -o '$SRC/build-out/evolve-evm' ."
  install -m 755 "$SRC/build-out/evolve-evm" /usr/local/bin/evolve-evm
fi
# zevo-keytool: generates the owner key and prints addresses. Built from a
# two-file module that pins go-ethereum; go.sum pins every dependency.
if [ -z "$JOIN" ] && { [ ! -x /usr/local/bin/zevo-keytool ] || [ -n "${FORCE_BUILD:-}" ]; }; then
  KT="$HOME_DIR/src/zevo-keytool"
  as_node "mkdir -p '$KT'"
  as_node "cat > '$KT/main.go'" <<'GOEOF'
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: zevo-keytool new|addr <keyfile>")
		os.Exit(1)
	}
	path := os.Args[2]
	if os.Args[1] == "new" {
		if _, err := os.Stat(path); err != nil {
			k, err := crypto.GenerateKey()
			if err != nil {
				panic(err)
			}
			if err := os.WriteFile(path, []byte(fmt.Sprintf("%x\n", crypto.FromECDSA(k))), 0o600); err != nil {
				panic(err)
			}
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	k, err := crypto.HexToECDSA(strings.TrimSpace(string(b)))
	if err != nil {
		panic(err)
	}
	fmt.Println(crypto.PubkeyToAddress(k.PublicKey).Hex())
}
GOEOF
  as_node "cd '$KT' && $goenv go mod init zevo-keytool >/dev/null 2>&1 || true"
  as_node "cd '$KT' && $goenv GOFLAGS=-mod=mod go get github.com/ethereum/go-ethereum@$GETH_LIB_VERSION >/dev/null && $goenv GOFLAGS=-mod=mod go build -o zevo-keytool ."
  install -m 755 "$KT/zevo-keytool" /usr/local/bin/zevo-keytool
fi

step "7/9 EVM genesis + ev-reth (pinned docker image)"
GEN="$DATA/genesis.json"
if [ -z "$JOIN" ]; then
  OWNER=$(su -s /bin/bash "$NODE_USER" -c "zevo-keytool new '$KEYS_DIR/owner.key'")
  echo "owner (holds the genesis coins, pays nothing — it IS the coin source): $OWNER"
  if [ ! -s "$GEN" ]; then
    # 1,000,000,000 ZEVO to the owner; 1,000,000 to OWNER_EVM_ADDRESS if set.
    extra=""
    [ -n "$OWNER_EVM_ADDRESS" ] && extra=", \"$OWNER_EVM_ADDRESS\": {\"balance\": \"0xd3c21bcecceda1000000\"}"
    as_node "cat > '$GEN'" <<EOF
{
  "config": {
    "chainId": $EVM_CHAIN_ID,
    "homesteadBlock": 0, "eip150Block": 0, "eip155Block": 0, "eip158Block": 0,
    "byzantiumBlock": 0, "constantinopleBlock": 0, "petersburgBlock": 0,
    "istanbulBlock": 0, "berlinBlock": 0, "londonBlock": 0,
    "mergeNetsplitBlock": 0, "terminalTotalDifficulty": 0,
    "terminalTotalDifficultyPassed": true,
    "shanghaiTime": 0, "cancunTime": 0, "pragueTime": 0
  },
  "nonce": "0x0", "timestamp": "0x0", "extraData": "0x",
  "gasLimit": "0x1c9c380", "difficulty": "0x0",
  "mixHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "coinbase": "0x0000000000000000000000000000000000000000",
  "alloc": { "$OWNER": {"balance": "0x33b2e3c9fd0803ce8000000"}$extra },
  "number": "0x0", "gasUsed": "0x0",
  "parentHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "baseFeePerGas": "0x3b9aca00"
}
EOF
    as_node "jq . '$GEN' >/dev/null"   # fail early on malformed JSON
  fi
else
  as_node "curl -fsS 'https://$JOIN/zevolve/genesis.json' -o '$GEN'"
  as_node "curl -fsS 'https://$JOIN/zevolve/zevolve.json' -o '$DATA/zevolve.json'"
fi
as_node "test -s '$DATA/jwt.hex' || (openssl rand -hex 32 > '$DATA/jwt.hex' && chmod 600 '$DATA/jwt.hex')"
mkdir -p "$DATA/reth-mount"
install -m 644 "$GEN" "$DATA/reth-mount/genesis.json"
install -m 644 "$DATA/jwt.hex" "$DATA/reth-mount/jwt.hex"
systemctl enable --now docker >/dev/null 2>&1 || true
docker rm -f zevolve-reth >/dev/null 2>&1 || true
docker run -d --name zevolve-reth --restart always \
  -p 127.0.0.1:8545:8545 -p 127.0.0.1:8546:8546 -p 127.0.0.1:8551:8551 \
  -v "$DATA/reth-mount:/root/chain:ro" -v zevolve-reth-data:/home/reth/eth-home \
  "$EV_RETH_IMAGE" \
  ev-reth node --chain /root/chain/genesis.json --datadir /home/reth/eth-home \
    --authrpc.addr 0.0.0.0 --authrpc.port 8551 --authrpc.jwtsecret /root/chain/jwt.hex \
    --http --http.addr 0.0.0.0 --http.port 8545 --http.api eth,net,web3,txpool \
    --ws --ws.addr 0.0.0.0 --ws.port 8546 --ws.api eth,net,web3 \
    --engine.persistence-threshold 0 --engine.memory-block-buffer-target 0 \
    --disable-discovery
for i in $(seq 1 60); do
  GENESIS_HASH=$(curl -s -X POST http://127.0.0.1:8545 -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x0",false]}' | jq -r '.result.hash // empty')
  [ -n "$GENESIS_HASH" ] && break
  sleep 5
done
[ -n "${GENESIS_HASH:-}" ] || { echo "ev-reth did not come up (docker logs zevolve-reth)"; exit 1; }
echo "EVM genesis hash: $GENESIS_HASH"

step "8/9 Evolve sequencer node"
PASS="$DATA/signer-pass"
as_node "test -s '$PASS' || (openssl rand -hex 16 > '$PASS' && chmod 600 '$PASS')"
AUTH_TOKEN=$(cel "light auth write --p2p.network mocha" | tail -1)
if [ ! -d "$SEQ_HOME/config" ]; then
  if [ -z "$JOIN" ]; then
    as_node "evolve-evm init --home '$SEQ_HOME' --evnode.node.aggregator=true --evnode.signer.passphrase_file '$PASS'"
    # Pin where on Celestia this chain starts, and share it with replicas.
    DA_HEIGHT=$(cels "header network-head" 2>/dev/null | jq -r '.result.header.height // empty')
    [ -n "$DA_HEIGHT" ] || { echo "could not read the Celestia head height"; exit 1; }
    as_node "jq --argjson h $DA_HEIGHT '.da_start_height = \$h' '$SEQ_HOME/config/genesis.json' > '$SEQ_HOME/config/genesis.json.new' \
      && mv '$SEQ_HOME/config/genesis.json.new' '$SEQ_HOME/config/genesis.json'"
  else
    as_node "evolve-evm init --home '$SEQ_HOME' --evnode.signer.passphrase_file '$PASS'"
    as_node "curl -fsS 'https://$JOIN/zevolve/evnode-genesis.json' -o '$SEQ_HOME/config/genesis.json'"
  fi
fi
ENVF="$DATA/seq.env"
as_node "cat > '$ENVF'" <<EOF
DA_AUTH_TOKEN=$AUTH_TOKEN
EVM_GENESIS_HASH=$GENESIS_HASH
EOF
as_node "chmod 600 '$ENVF'"
AGG_FLAGS="--evnode.node.aggregator=true --evnode.node.lazy_mode --evnode.node.lazy_block_interval $LAZY_BLOCK_INTERVAL"
[ -n "$JOIN" ] && AGG_FLAGS="--evnode.node.aggregator=false"
FEE_RECIPIENT="${OWNER:-0x0000000000000000000000000000000000000000}"
if [ -z "$NO_SYSTEMD" ] && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/zevolve-seq.service <<EOF
[Unit]
Description=$CHAIN_NAME Evolve node (ev-node EVM)
After=network-online.target zevolve-celestia.service docker.service
Wants=network-online.target

[Service]
User=$NODE_USER
EnvironmentFile=$ENVF
ExecStart=/usr/local/bin/evolve-evm start --home $SEQ_HOME \
  --evm.eth-url http://127.0.0.1:8545 --evm.engine-url http://127.0.0.1:8551 \
  --evm.jwt-secret-file $DATA/jwt.hex --evm.genesis-hash \${EVM_GENESIS_HASH} \
  --evm.fee-recipient $FEE_RECIPIENT \
  $AGG_FLAGS --evnode.node.block_time $BLOCK_TIME \
  --evnode.signer.passphrase_file $PASS \
  --evnode.da.address ws://127.0.0.1:26658 --evnode.da.auth_token \${DA_AUTH_TOKEN} \
  --evnode.da.namespace ${NS_BASE}h --evnode.da.data_namespace ${NS_BASE}d
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable zevolve-seq >/dev/null 2>&1 && systemctl restart zevolve-seq
fi

step "9/9 https (Caddy + free sslip.io name) and public chain files"
ip=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null || hostname -I | awk '{print $1}')
host="${ip//./-}.sslip.io"
pubhost="${PUBLIC_HOST:-$host}"
mkdir -p $PUB
install -m 644 "$GEN" $PUB/genesis.json
[ -s "$SEQ_HOME/config/genesis.json" ] && install -m 644 "$SEQ_HOME/config/genesis.json" $PUB/evnode-genesis.json
install -m 644 "$SELF" $PUB/setup-evolve.sh 2>/dev/null || true
jq -n --arg h "https://$pubhost" --arg id "$(printf '0x%x' "$EVM_CHAIN_ID")" --arg n "$CHAIN_NAME" --arg s "$COIN_SYMBOL" \
  --arg nsh "${NS_BASE}h" --arg nsd "${NS_BASE}d" \
  '{chain: {chainId: $id, chainName: $n, nativeCurrency: {name: $s, symbol: $s, decimals: 18}, rpcUrls: [$h]},
    da: {network: "mocha", header_namespace: $nsh, data_namespace: $nsd}}' > $PUB/zevolve.json
jq '.chain' $PUB/zevolve.json > $PUB/evm-chain.json
chmod 644 $PUB/zevolve.json $PUB/evm-chain.json
if [ -z "$NO_SYSTEMD" ] && [ -d /run/systemd/system ] && [[ "$ip" =~ ^[0-9.]+$ ]]; then
  { apt_get install -y caddy >/dev/null && cat > /etc/caddy/Caddyfile <<CADDY
$host${PUBLIC_HOST:+, $PUBLIC_HOST} {
	header ?Access-Control-Allow-Origin *
	header ?Access-Control-Allow-Headers "Content-Type"
	header ?Access-Control-Allow-Methods "GET, POST, OPTIONS"
	encode zstd gzip
	route {
		@preflight method OPTIONS
		respond @preflight 204
		handle_path /zevolve/* {
			root * $PUB
			file_server
		}
		handle /ws {
			rewrite * /
			reverse_proxy 127.0.0.1:8546
		}
		reverse_proxy 127.0.0.1:8545
	}
}
CADDY
    systemctl restart caddy; } || echo "https setup failed; the RPC still works on 127.0.0.1:8545"
fi

step "done"
cat <<MSG

$CHAIN_NAME is starting — a brand-new chain (option 2, Evolve on
Celestia, per the shared-security document). ZETAPHY (77390) is untouched.

  RPC (MetaMask):  https://$pubhost
  Chain ID:        $EVM_CHAIN_ID    Coin: $COIN_SYMBOL (testnet, no value)
  DA:              Celestia Mocha, namespaces ${NS_BASE}h / ${NS_BASE}d
  Chain files:     https://$pubhost/zevolve/
  Services:        systemctl status zevolve-celestia zevolve-seq; docker logs zevolve-reth
  Logs:            journalctl -u zevolve-seq -f
MSG
if [ -z "$JOIN" ]; then
  cat <<MSG
  Genesis coins:   1,000,000,000 $COIN_SYMBOL at the owner key in $KEYS_DIR
                   ${OWNER_EVM_ADDRESS:+(+1,000,000 to $OWNER_EVM_ADDRESS)}
  TIA balance:     celestia state balance --node.store $CEL_STORE
                   (top up from the faucets when it runs low)
MSG
fi
