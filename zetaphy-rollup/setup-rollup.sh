#!/bin/bash
# ZETAPHY Rollup — a NEW L2 testnet chain (OP Stack on Ethereum Sepolia).
# Zero-baht plan: a free Oracle/Google VM, free public Sepolia RPCs, and
# faucet Sepolia ETH. This is a separate chain; the existing ZETAPHY
# Cosmos chain (77390) is not moved or touched in any way.
#
# Run it on a fresh Ubuntu 24.04 machine, as root:
#   - paste this whole file as the cloud-init script when creating the VM, or
#   - sudo bash setup-rollup.sh   (e.g. from the browser SSH / Cloud Shell)
# Progress log: /var/log/zrollup-setup.log
#
# Sequencer mode (default): builds op-geth/op-node/op-batcher/op-proposer and
# op-deployer from pinned sources, makes 4 keys, waits until you fund the
# admin address with Sepolia ETH from a faucet, deploys the L1 contracts with
# op-deployer (standard-overrides: reuses the audited OPCM implementations
# already on Sepolia, so only proxies are deployed), then runs the chain.
#
# Replica mode: JOIN=<host of a running sequencer> (e.g. 1-2-3-4.sslip.io)
# runs a read-only node that derives the same chain from Sepolia alone.
JOIN="${JOIN:-}"

set -euo pipefail

# ---- Parameters -------------------------------------------------------------
L2_CHAIN_ID="${L2_CHAIN_ID:-77391}"   # new chain id (ZETAPHY stays on 77390)
CHAIN_NAME="ZETAPHY Rollup Testnet"
L1_CHAIN_ID=11155111                  # Sepolia
# Free public Sepolia endpoints (no account, no key). Override if rate-limited.
L1_RPC="${L1_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
L1_BEACON="${L1_BEACON:-https://ethereum-sepolia-beacon-api.publicnode.com}"
# How much faucet Sepolia ETH the admin address must hold before deploying.
# Deployment itself usually burns ~0.1-0.3; the rest funds batcher/proposer.
FUND_MIN_ETH="${FUND_MIN_ETH:-1}"
# calldata / blobs / auto (auto picks the cheaper of the two per batch).
DA_TYPE="${DA_TYPE:-auto}"
# Optional: your own DNS name (an A record pointing at this machine).
PUBLIC_HOST="${PUBLIC_HOST:-}"
[ -z "$PUBLIC_HOST" ] || [[ "$PUBLIC_HOST" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || { echo "PUBLIC_HOST: a DNS name like rpc.example.com"; exit 1; }
NO_SYSTEMD="${NO_SYSTEMD:-}"          # test hook

# ---- Pinned sources (checked by commit, built from source) ------------------
OP_GETH_REPO="https://github.com/ethereum-optimism/op-geth.git"
OP_GETH_TAG="v1.101702.3"
OP_GETH_COMMIT="7da4560d1fb3045286b70a8dc23360d2626543f2"
OPTIMISM_REPO="https://github.com/ethereum-optimism/optimism.git"
OP_NODE_TAG="op-node/v1.20.0"         # same commit also carries op-batcher v1.18.0
OP_NODE_COMMIT="d6620202d4e563957830e688007a0cab29bd80f3"
OP_PROPOSER_TAG="op-proposer/v1.16.7"
OP_PROPOSER_COMMIT="595feddae0880a3849850639a69f9ce01ed3dfe8"
OP_DEPLOYER_TAG="op-deployer/v0.8.1"
OP_DEPLOYER_COMMIT="319e3da9a162f362afb97d1e2b472a553c8874ca"
# Go: Ubuntu's golang-go (>=1.21) downloads the exact toolchain each pinned
# go.mod names (GOTOOLCHAIN), verified against Go's public checksum database.

NODE_USER="oprollup"
HOME_DIR="/home/${NODE_USER}"
DATA="$HOME_DIR/.zrollup"             # genesis, rollup.json, geth datadir, env
KEYS_DIR="$HOME_DIR/.zrollup-keys"    # 4 private keys; never leave the machine
WORK="$HOME_DIR/.zrollup-deployer"    # op-deployer workdir (intent + state)
PUB=/var/lib/zrollup-public           # files served at https://<host>/zrollup/
LOG=/var/log/zrollup-setup.log
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")

# One run at a time (a second copy would fight over the same dirs).
exec 9>/run/zrollup-setup.lock
flock -n 9 || { echo "setup-rollup.sh is already running (tail -f $LOG)"; exit 1; }
touch "$LOG" && chmod 640 "$LOG"
exec > >(tee -a "$LOG") 2>&1
step() { echo; echo "== $(date -u +%FT%TZ) $*"; }

step "1/9 packages"
apt_get() { apt-get -o DPkg::Lock::Timeout=900 "$@"; }
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  need=""
  for p in git jq curl make gcc openssl; do command -v "$p" >/dev/null || need=1; done
  if [ -n "$need" ]; then apt_get update -y && apt_get install -y git jq curl build-essential ca-certificates openssl; fi
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

step "4/9 build the OP Stack binaries (pinned commits; ~20-40 min on a free A1)"
GO=$(command -v go || true)
[ -z "$GO" ] && [ -x /usr/local/go/bin/go ] && GO=/usr/local/go/bin/go
if [ -z "$GO" ]; then apt_get install -y golang-go && GO=$(command -v go); fi
minor=$("$GO" env GOVERSION | sed -E 's/^go1\.([0-9]+).*/\1/')
[ "$minor" -ge 21 ] || { echo "Go $("$GO" env GOVERSION) is too old; use Ubuntu 24.04"; exit 1; }
goenv="PATH=$(dirname "$GO"):\$PATH GOTOOLCHAIN=auto"
[ "$mem_kb" -lt 6000000 ] && goenv="$goenv GOFLAGS=-p=1 GOGC=50"

checkout() { # checkout <dir> <repo> <tag> <commit>
  local dir=$1 repo=$2 tag=$3 commit=$4
  if [ ! -d "$dir/.git" ]; then
    as_node "mkdir -p \"\$(dirname '$dir')\" && git clone -q --depth 1 --branch '$tag' '$repo' '$dir'"
  else
    as_node "git -C '$dir' fetch -q --depth 1 origin 'refs/tags/$tag:refs/tags/$tag' || true"
    as_node "git -C '$dir' checkout -q '$tag^{commit}' 2>/dev/null || git -C '$dir' checkout -q '$tag'"
  fi
  local got; got=$(as_node "git -C '$dir' rev-parse HEAD")
  [ "$got" = "$commit" ] || { echo "$dir: commit $got != pinned $commit"; exit 1; }
}

GETH_SRC="$HOME_DIR/src/op-geth"
OPT_SRC="$HOME_DIR/src/optimism"

if [ ! -x /usr/local/bin/op-geth ] || [ -n "${FORCE_BUILD:-}" ]; then
  checkout "$GETH_SRC" "$OP_GETH_REPO" "$OP_GETH_TAG" "$OP_GETH_COMMIT"
  as_node "cd '$GETH_SRC' && $goenv go build -o build/op-geth ./cmd/geth"
  install -m 755 "$GETH_SRC/build/op-geth" /usr/local/bin/op-geth
fi

# zrkeytool: a tiny helper built inside the op-geth module (its go.sum pins
# every dependency). Makes keys, shows balances, waits for the faucet money,
# and sends plain ETH transfers. Keys are hex files readable only by $NODE_USER.
if [ ! -x /usr/local/bin/zrkeytool ] || [ -n "${FORCE_BUILD:-}" ]; then
  [ -d "$GETH_SRC/.git" ] || checkout "$GETH_SRC" "$OP_GETH_REPO" "$OP_GETH_TAG" "$OP_GETH_COMMIT"
  as_node "mkdir -p '$GETH_SRC/cmd/zrkeytool'"
  as_node "cat > '$GETH_SRC/cmd/zrkeytool/main.go'" <<'GOEOF'
package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

func die(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "zrkeytool:", err)
		os.Exit(1)
	}
}

func loadKey(path string) *ecdsa.PrivateKey {
	b, err := os.ReadFile(path)
	die(err)
	k, err := crypto.HexToECDSA(strings.TrimSpace(string(b)))
	die(err)
	return k
}

// ethToWei parses a decimal ETH amount ("0.25") into wei without floats.
func ethToWei(s string) *big.Int {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		die(fmt.Errorf("bad ETH amount %q", s))
	}
	r.Mul(r, new(big.Rat).SetInt(big.NewInt(1e18)))
	if !r.IsInt() {
		die(fmt.Errorf("too many decimals in %q", s))
	}
	return r.Num()
}

func main() {
	if len(os.Args) < 2 {
		die(fmt.Errorf("usage: zrkeytool new|addr|balance|wait|send ..."))
	}
	ctx := context.Background()
	switch os.Args[1] {
	case "new": // new <file>: create if missing; always print the address
		path := os.Args[2]
		if _, err := os.Stat(path); err != nil {
			k, err := crypto.GenerateKey()
			die(err)
			die(os.WriteFile(path, []byte(fmt.Sprintf("%x\n", crypto.FromECDSA(k))), 0o600))
		}
		fmt.Println(crypto.PubkeyToAddress(loadKey(path).PublicKey).Hex())
	case "addr": // addr <file>
		fmt.Println(crypto.PubkeyToAddress(loadKey(os.Args[2]).PublicKey).Hex())
	case "balance": // balance <rpc> <address>: wei on stdout
		c, err := ethclient.Dial(os.Args[2])
		die(err)
		b, err := c.BalanceAt(ctx, common.HexToAddress(os.Args[3]), nil)
		die(err)
		fmt.Println(b.String())
	case "wait": // wait <rpc> <address> <min-eth>: poll until the balance arrives
		c, err := ethclient.Dial(os.Args[2])
		die(err)
		addr, min := common.HexToAddress(os.Args[3]), ethToWei(os.Args[4])
		for {
			b, err := c.BalanceAt(ctx, addr, nil)
			if err != nil {
				fmt.Fprintln(os.Stderr, "wait:", err)
			} else {
				eth := new(big.Rat).SetFrac(b, big.NewInt(1e18))
				fmt.Printf("%s  %s: %s ETH (need %s)\n", time.Now().UTC().Format(time.RFC3339), addr, eth.FloatString(6), os.Args[4])
				if b.Cmp(min) >= 0 {
					return
				}
			}
			time.Sleep(30 * time.Second)
		}
	case "send": // send <rpc> <keyfile> <to> <eth>: EIP-1559 transfer, waits for the receipt
		c, err := ethclient.Dial(os.Args[2])
		die(err)
		key := loadKey(os.Args[3])
		from := crypto.PubkeyToAddress(key.PublicKey)
		to := common.HexToAddress(os.Args[4])
		amount := ethToWei(os.Args[5])
		chainID, err := c.ChainID(ctx)
		die(err)
		nonce, err := c.PendingNonceAt(ctx, from)
		die(err)
		tip, err := c.SuggestGasTipCap(ctx)
		die(err)
		head, err := c.HeaderByNumber(ctx, nil)
		die(err)
		feeCap := new(big.Int).Add(new(big.Int).Mul(head.BaseFee, big.NewInt(2)), tip)
		tx := types.NewTx(&types.DynamicFeeTx{ChainID: chainID, Nonce: nonce,
			GasTipCap: tip, GasFeeCap: feeCap, Gas: 21000, To: &to, Value: amount})
		tx, err = types.SignTx(tx, types.LatestSignerForChainID(chainID), key)
		die(err)
		die(c.SendTransaction(ctx, tx))
		for i := 0; i < 120; i++ {
			if r, err := c.TransactionReceipt(ctx, tx.Hash()); err == nil {
				if r.Status != 1 {
					die(fmt.Errorf("transfer %s reverted", tx.Hash()))
				}
				fmt.Println(tx.Hash().Hex())
				return
			}
			time.Sleep(5 * time.Second)
		}
		die(fmt.Errorf("transfer %s not mined after 10 minutes", tx.Hash()))
	default:
		die(fmt.Errorf("unknown command %q", os.Args[1]))
	}
}
GOEOF
  as_node "cd '$GETH_SRC' && $goenv go build -o build/zrkeytool ./cmd/zrkeytool"
  install -m 755 "$GETH_SRC/build/zrkeytool" /usr/local/bin/zrkeytool
fi
kt() { su -s /bin/bash "$NODE_USER" -c "zrkeytool $*"; }

build_opt() { # build_opt <tag> <commit> <pkg> <out> [pkg2 out2]
  local tag=$1 commit=$2; shift 2
  checkout "$OPT_SRC" "$OPTIMISM_REPO" "$tag" "$commit"
  while [ $# -gt 0 ]; do
    as_node "cd '$OPT_SRC' && mkdir -p build-out && $goenv go build -o 'build-out/$2' $1"
    install -m 755 "$OPT_SRC/build-out/$2" "/usr/local/bin/$2"
    shift 2
  done
}
if [ -z "$JOIN" ] && { [ ! -x /usr/local/bin/op-deployer ] || [ -n "${FORCE_BUILD:-}" ]; }; then
  build_opt "$OP_DEPLOYER_TAG" "$OP_DEPLOYER_COMMIT" ./op-deployer/cmd/op-deployer op-deployer
fi
if [ -z "$JOIN" ] && { [ ! -x /usr/local/bin/op-proposer ] || [ -n "${FORCE_BUILD:-}" ]; }; then
  build_opt "$OP_PROPOSER_TAG" "$OP_PROPOSER_COMMIT" ./op-proposer/cmd op-proposer
fi
if [ ! -x /usr/local/bin/op-node ] || [ -n "${FORCE_BUILD:-}" ]; then
  if [ -z "$JOIN" ]; then
    build_opt "$OP_NODE_TAG" "$OP_NODE_COMMIT" ./op-node/cmd op-node ./op-batcher/cmd op-batcher
  else
    build_opt "$OP_NODE_TAG" "$OP_NODE_COMMIT" ./op-node/cmd op-node
  fi
fi

if [ -z "$JOIN" ]; then
  step "5/9 keys (made here, never leave the machine; testnet only)"
  ADMIN=$(kt new "$KEYS_DIR/admin.key")        # deploys + holds the faucet ETH
  BATCHER=$(kt new "$KEYS_DIR/batcher.key")    # posts batches to Sepolia
  PROPOSER=$(kt new "$KEYS_DIR/proposer.key")  # posts output roots to Sepolia
  SEQUENCER=$(kt new "$KEYS_DIR/sequencer.key") # signs unsafe L2 blocks (no ETH needed)
  echo "admin     $ADMIN"
  echo "batcher   $BATCHER"
  echo "proposer  $PROPOSER"
  echo "sequencer $SEQUENCER"

  step "6/9 waiting for free Sepolia ETH on the admin address"
  cat <<MSG
+----------------------------------------------------------------------+
 Send at least $FUND_MIN_ETH Sepolia ETH (testnet, free) to:

   $ADMIN

 Free faucets (0 baht):
   - https://sepolia-faucet.pk910.de  (PoW mining faucet, no account;
     leave the browser tab mining until it reaches the amount)
   - https://cloud.google.com/application/web3/faucet/ethereum/sepolia
   - https://www.alchemy.com/faucets/ethereum-sepolia

 This script now polls every 30 s and continues by itself.
+----------------------------------------------------------------------+
MSG
  kt wait "'$L1_RPC'" "$ADMIN" "$FUND_MIN_ETH"

  step "7/9 deploying the L1 contracts on Sepolia (op-deployer, standard-overrides)"
  INTENT="$WORK/intent.toml"
  if [ ! -f "$INTENT" ]; then
    as_node "mkdir -p '$WORK' && op-deployer init --intent-type standard-overrides \
      --l1-chain-id $L1_CHAIN_ID --l2-chain-ids $L2_CHAIN_ID --workdir '$WORK'"
    set_role() { # every role and fee vault goes to one of our 4 addresses
      as_node "sed -i -E 's|^([[:space:]]*$1[[:space:]]*=[[:space:]]*).*|\\1\"$2\"|' '$INTENT'"
      as_node "grep -qE '^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"$2\"' '$INTENT'" \
        || { echo "intent.toml: could not set $1"; exit 1; }
    }
    set_role baseFeeVaultRecipient      "$ADMIN"
    set_role l1FeeVaultRecipient        "$ADMIN"
    set_role sequencerFeeVaultRecipient "$ADMIN"
    set_role operatorFeeVaultRecipient  "$ADMIN"
    set_role l1ProxyAdminOwner          "$ADMIN"
    set_role l2ProxyAdminOwner          "$ADMIN"
    set_role systemConfigOwner          "$ADMIN"
    set_role challenger                 "$ADMIN"
    set_role unsafeBlockSigner          "$SEQUENCER"
    set_role batcher                    "$BATCHER"
    set_role proposer                   "$PROPOSER"
  fi
  # Resumable: op-deployer records progress in state.json, so a retry (or a
  # re-run of this script after a top-up) continues where it stopped.
  deploy() { su -s /bin/bash "$NODE_USER" -c \
    "OP_DEPLOYER_PRIVATE_KEY=\$(cat '$KEYS_DIR/admin.key') op-deployer apply --workdir '$WORK' --l1-rpc-url '$L1_RPC'"; }
  if ! as_node "test -s '$DATA/rollup.json'"; then
    deploy || { echo "deploy failed; retrying in 60 s"; sleep 60; deploy; }
    for what in genesis rollup l1; do
      out=$DATA/$what.json; if [ "$what" = l1 ]; then out=$DATA/l1-addresses.json; fi
      as_node "op-deployer inspect $what --workdir '$WORK' --outfile '$out' $L2_CHAIN_ID"
    done
  fi
  addr_of() { # first string value in the chain's deployment whose key matches
    as_node "jq -r --arg re '$1' \
      '[.opChainDeployments[0] | .. | objects | to_entries[] | select((.value|type==\"string\") and (.key|test(\$re;\"i\"))) | .value][0] // empty' \
      '$WORK/state.json'"
  }
  PORTAL=$(addr_of 'optimism.?portal.*prox')
  BRIDGE=$(addr_of 'l1.?standard.?bridge.*prox')
  GAME_FACTORY=$(addr_of 'dispute.?game.?factory.*prox')
  [ -n "$GAME_FACTORY" ] || { echo "disputeGameFactory address not found in state.json"; exit 1; }
  echo "OptimismPortal (deposit ETH here): ${PORTAL:-unknown}"
  echo "L1StandardBridge:                  ${BRIDGE:-unknown}"
  echo "DisputeGameFactory:                $GAME_FACTORY"

  # Fund the two senders from the admin's remaining faucet ETH (skip if funded).
  for pair in "batcher 0.3" "proposer 0.15"; do
    who=${pair% *}; amt=${pair#* }
    bal=$(kt balance "'$L1_RPC'" "$(kt addr "$KEYS_DIR/$who.key")")
    [ "${#bal}" -ge 17 ] || kt send "'$L1_RPC'" "$KEYS_DIR/admin.key" "$(kt addr "$KEYS_DIR/$who.key")" "$amt"
  done
else
  step "5-7/9 replica: fetching chain files from https://$JOIN/zrollup/"
  as_node "curl -fsS 'https://$JOIN/zrollup/genesis.json' -o '$DATA/genesis.json'"
  as_node "curl -fsS 'https://$JOIN/zrollup/rollup.json'  -o '$DATA/rollup.json'"
  as_node "curl -fsS 'https://$JOIN/zrollup/l1-addresses.json' -o '$DATA/l1-addresses.json'" || true
fi

step "8/9 the L2 node itself (op-geth + op-node$( [ -z "$JOIN" ] && echo " + op-batcher + op-proposer"))"
as_node "test -s '$DATA/jwt.hex' || (openssl rand -hex 32 > '$DATA/jwt.hex' && chmod 600 '$DATA/jwt.hex')"
as_node "test -d '$DATA/geth/geth' || op-geth init --datadir '$DATA/geth' '$DATA/genesis.json'"

ENVD="$DATA/env"; as_node "mkdir -p '$ENVD' && chmod 700 '$ENVD'"
as_node "cat > '$ENVD/op-node.env'" <<EOF
OP_NODE_L1_ETH_RPC=$L1_RPC
OP_NODE_L1_BEACON=$L1_BEACON
OP_NODE_L1_RPC_KIND=standard
OP_NODE_L1_TRUST_RPC=true
OP_NODE_L2_ENGINE_RPC=http://127.0.0.1:9551
OP_NODE_L2_ENGINE_AUTH=$DATA/jwt.hex
OP_NODE_ROLLUP_CONFIG=$DATA/rollup.json
OP_NODE_RPC_ADDR=127.0.0.1
OP_NODE_RPC_PORT=9645
OP_NODE_P2P_DISABLE=true
EOF
if [ -z "$JOIN" ]; then
  as_node "cat >> '$ENVD/op-node.env'" <<EOF
OP_NODE_SEQUENCER_ENABLED=true
OP_NODE_SEQUENCER_L1_CONFS=5
OP_NODE_VERIFIER_L1_CONFS=4
OP_NODE_P2P_SEQUENCER_KEY=$(su -s /bin/bash "$NODE_USER" -c "cat '$KEYS_DIR/sequencer.key'")
EOF
  as_node "cat > '$ENVD/op-batcher.env'" <<EOF
OP_BATCHER_L1_ETH_RPC=$L1_RPC
OP_BATCHER_L2_ETH_RPC=http://127.0.0.1:9545
OP_BATCHER_ROLLUP_RPC=http://127.0.0.1:9645
OP_BATCHER_PRIVATE_KEY=$(su -s /bin/bash "$NODE_USER" -c "cat '$KEYS_DIR/batcher.key'")
OP_BATCHER_DATA_AVAILABILITY_TYPE=$DA_TYPE
OP_BATCHER_MAX_CHANNEL_DURATION=1500
OP_BATCHER_POLL_INTERVAL=6s
OP_BATCHER_SUB_SAFETY_MARGIN=10
OP_BATCHER_NUM_CONFIRMATIONS=1
EOF
  as_node "cat > '$ENVD/op-proposer.env'" <<EOF
OP_PROPOSER_L1_ETH_RPC=$L1_RPC
OP_PROPOSER_ROLLUP_RPC=http://127.0.0.1:9645
OP_PROPOSER_PRIVATE_KEY=$(su -s /bin/bash "$NODE_USER" -c "cat '$KEYS_DIR/proposer.key'")
OP_PROPOSER_GAME_FACTORY_ADDRESS=$GAME_FACTORY
OP_PROPOSER_GAME_TYPE=1
OP_PROPOSER_PROPOSAL_INTERVAL=3600s
OP_PROPOSER_POLL_INTERVAL=20s
OP_PROPOSER_NUM_CONFIRMATIONS=1
OP_PROPOSER_WAIT_NODE_SYNC=true
EOF
fi
as_node "chmod 600 '$ENVD'/*.env"

if [ -z "$NO_SYSTEMD" ] && [ -d /run/systemd/system ]; then
  unit() { # unit <name> <description> <execstart> [envfile] [after]
    cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target ${5:-}
Wants=network-online.target

[Service]
User=$NODE_USER
${4:+EnvironmentFile=$4}
ExecStart=$3
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  }
  unit zrollup-geth "$CHAIN_NAME execution client (op-geth)" \
    "/usr/local/bin/op-geth --datadir $DATA/geth --networkid $L2_CHAIN_ID \
--http --http.addr 127.0.0.1 --http.port 9545 --http.vhosts=* --http.corsdomain=* --http.api web3,eth,net \
--ws --ws.addr 127.0.0.1 --ws.port 9546 --ws.origins=* --ws.api web3,eth,net \
--authrpc.addr 127.0.0.1 --authrpc.port 9551 --authrpc.vhosts=* --authrpc.jwtsecret $DATA/jwt.hex \
--rollup.disabletxpoolgossip=true --syncmode=full --gcmode=full --nodiscover --maxpeers 0 --port 30393"
  unit zrollup-node "$CHAIN_NAME consensus client (op-node)" \
    "/usr/local/bin/op-node" "$ENVD/op-node.env" zrollup-geth.service
  services="zrollup-geth zrollup-node"
  if [ -z "$JOIN" ]; then
    unit zrollup-batcher "$CHAIN_NAME batcher (posts batches to Sepolia)" \
      "/usr/local/bin/op-batcher" "$ENVD/op-batcher.env" zrollup-node.service
    unit zrollup-proposer "$CHAIN_NAME proposer (posts output roots to Sepolia)" \
      "/usr/local/bin/op-proposer" "$ENVD/op-proposer.env" zrollup-node.service
    services="$services zrollup-batcher zrollup-proposer"
  fi
  systemctl daemon-reload
  for s in $services; do systemctl enable "$s" >/dev/null 2>&1; systemctl restart "$s"; done
fi

step "9/9 https (Caddy + free sslip.io name) and public chain files"
ip=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null || hostname -I | awk '{print $1}')
host="${ip//./-}.sslip.io"
pubhost="${PUBLIC_HOST:-$host}"
mkdir -p $PUB
for f in genesis.json rollup.json l1-addresses.json; do
  [ -s "$DATA/$f" ] && install -m 644 "$DATA/$f" $PUB/
done
install -m 644 "$SELF" $PUB/setup-rollup.sh 2>/dev/null || true
jq -n --arg h "https://$pubhost" --arg id "$(printf '0x%x' "$L2_CHAIN_ID")" --arg n "$CHAIN_NAME" \
  '{chainId: $id, chainName: $n, nativeCurrency: {name: "Sepolia Ether", symbol: "ETH", decimals: 18}, rpcUrls: [$h]}' > $PUB/evm-chain.json
chmod 644 $PUB/evm-chain.json
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
		handle_path /zrollup/* {
			root * $PUB
			file_server
		}
		handle /ws {
			rewrite * /
			reverse_proxy 127.0.0.1:9546
		}
		reverse_proxy 127.0.0.1:9545
	}
}
CADDY
    systemctl restart caddy; } || echo "https setup failed; the RPC still works on 127.0.0.1:9545"
fi

step "done"
cat <<MSG

$CHAIN_NAME is starting. A brand-new chain: the ZETAPHY Cosmos
chain (77390) is untouched and keeps running wherever it runs.

  RPC (MetaMask):  https://$pubhost
  Chain ID:        $L2_CHAIN_ID
  Currency:        ETH (Sepolia test ETH, bridged; it has no value)
  Chain files:     https://$pubhost/zrollup/   (genesis, rollup config, L1 addresses)
  Services:        systemctl status zrollup-geth zrollup-node$( [ -z "$JOIN" ] && echo " zrollup-batcher zrollup-proposer")
  Logs:            journalctl -u zrollup-node -f
MSG
if [ -z "$JOIN" ]; then
  cat <<MSG
  Deposit (L1 -> L2): send Sepolia ETH from MetaMask straight to the
  OptimismPortal address below; ~3-4 minutes later the same amount appears
  at your own address on chain $L2_CHAIN_ID.
    OptimismPortal:  ${PORTAL:-see $DATA/l1-addresses.json}
  Keys (testnet only, keep this machine to yourself): $KEYS_DIR
  Top up later when the batcher/proposer run dry (free faucet again):
    zrkeytool balance $L1_RPC \$(zrkeytool addr $KEYS_DIR/batcher.key)
MSG
fi
