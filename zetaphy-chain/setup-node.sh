#!/bin/bash
# ZETAPHY Chain — step 0 testnet node (single validator).
#
# Paste this whole file into Oracle Cloud when creating the instance:
#   Create instance -> Show advanced options -> Management -> Paste cloud-init script
# It runs once, as root, on first boot: installs Go, builds the chain from the
# public Cosmos EVM source (pinned commit), creates the genesis, and starts the
# node as a service. Takes ~15-60 minutes depending on the machine.
# Progress log on the server: /var/log/zetaphy-setup.log
#
# OPTIONAL: put your MetaMask address between the quotes to receive
# 1,000,000 test ZETAPHY at genesis (public address only, never a private key).
OWNER_EVM_ADDRESS="${OWNER_EVM_ADDRESS:-}"

set -euo pipefail

# ---- Fixed parameters (decided 19 Oct 2026) --------------------------------
CHAIN_ID="zetaphy-testnet-1"
EVM_CHAIN_ID=77390                 # free in ethereum-lists/chains as of 19 Oct 2026
DENOM="azetaphy"                   # 1 ZETAPHY = 10^18 azetaphy
MONIKER="${MONIKER:-zetaphy-validator-0}"
COSMOS_EVM_TAG="v0.7.3"
COSMOS_EVM_COMMIT="c3ae9067a7eadcdea55a5192226916deb44c71c4"
GO_VERSION="1.25.9"                # what cosmos/evm v0.7.3 go.mod requires

NODE_USER="zetaphy"
NODE_HOME="/home/${NODE_USER}/.zetaphy"          # chain data + config (no keys)
KEYS_DIR="/home/${NODE_USER}/.zetaphy-genesis-keys" # genesis keys, kept out of the node's home
BIN="/usr/local/bin/zetaphyd"
LOG="/var/log/zetaphy-setup.log"

# Test hooks (leave unset on Oracle): ZETAPHYD_BIN=<prebuilt evmd>, NO_SYSTEMD=1
ZETAPHYD_BIN="${ZETAPHYD_BIN:-}"
NO_SYSTEMD="${NO_SYSTEMD:-}"

touch "$LOG" && chmod 640 "$LOG"
exec > >(tee -a "$LOG") 2>&1
step() { echo; echo "== $(date -u +%FT%TZ) $*"; }

# 1,000,000,000 ZETAPHY total (plan model B). Amounts in azetaphy.
Z=000000000000000000               # 18 zeros
REWARDS=500000000$Z                # 50% node runners + validators (released later)
SWD_AIRDROP=200000000$Z            # 20% SWD holders (snapshot later)
COMMUNITY=150000000$Z              # 15% community fund
LIQUIDITY_TOTAL=100000000$Z        # 10% liquidity & partners (pays the two test grants below)
TEAM=50000000$Z                    # 5% team: locked 1 year, then linear to year 4
VALIDATOR_GRANT=1000000$Z          # from liquidity: validator account
OWNER_GRANT=1000000$Z              # from liquidity: your MetaMask (only if set)
SELF_STAKE=500000$Z

# ---------------------------------------------------------------------------
step "1/8 packages"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  need=""
  for p in git jq curl make gcc; do command -v "$p" >/dev/null || need=1; done
  if [ -n "$need" ]; then apt-get update -y && apt-get install -y git jq curl build-essential ca-certificates; fi
fi

step "2/8 swap (small machines need it to compile)"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 6000000 ] && ! swapon --show | grep -q . && [ -z "$NO_SYSTEMD" ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "3/8 user"
id "$NODE_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$NODE_USER"
as_node() { su -s /bin/bash "$NODE_USER" -c "$*"; }

step "4/8 build zetaphyd"
if [ -n "$ZETAPHYD_BIN" ]; then
  install -m 755 "$ZETAPHYD_BIN" "$BIN"
elif [ ! -x "$BIN" ] || [ -n "${FORCE_BUILD:-}" ]; then
  # Any Go >= 1.21 can fetch the exact toolchain the source asks for (GOTOOLCHAIN),
  # verified against Go's checksum database. Ubuntu 24.04's golang-go is 1.22.
  GO=$(command -v go || true)
  [ -z "$GO" ] && [ -x /usr/local/go/bin/go ] && GO=/usr/local/go/bin/go
  if [ -z "$GO" ]; then apt-get install -y golang-go && GO=$(command -v go); fi
  minor=$("$GO" env GOVERSION | sed -E 's/^go1\.([0-9]+).*/\1/')
  [ "$minor" -ge 21 ] || { echo "Go $("$GO" env GOVERSION) is too old; use Ubuntu 24.04"; exit 1; }
  src="/home/${NODE_USER}/src/evm"
  as_node "rm -rf '$src' && git clone -q --depth 1 --branch '$COSMOS_EVM_TAG' https://github.com/cosmos/evm.git '$src'"
  got=$(as_node "git -C '$src' rev-parse HEAD")
  [ "$got" = "$COSMOS_EVM_COMMIT" ] || { echo "source commit $got != pinned $COSMOS_EVM_COMMIT"; exit 1; }
  # Addresses start with "zetaphy1..." instead of "cosmos1...".
  as_node "sed -i 's/Bech32Prefix = \"cosmos\"/Bech32Prefix = \"zetaphy\"/' '$src/evmd/config/bech32.go'"
  grep -q 'Bech32Prefix = "zetaphy"' "$src/evmd/config/bech32.go" || { echo "address prefix patch did not apply"; exit 1; }
  # Stage 5: post-quantum ML-DSA (FIPS 204) signature check as an EVM precompile
  # at 0x...0900 (Cloudflare CIRCL v1.6.3). The patch is below, in this file.
  # Its own test runs before the build; a failure stops the setup.
  sed -n '/^: <<.ZETAPHY_PQ_PATCH.$/,/^ZETAPHY_PQ_PATCH$/p' "$0" | sed '1d;$d' > /tmp/zetaphy-pq.patch
  chmod 644 /tmp/zetaphy-pq.patch
  as_node "cd '$src' && git apply /tmp/zetaphy-pq.patch"
  as_node "cd '$src' && PATH=$(dirname "$GO"):\$PATH GOTOOLCHAIN=go${GO_VERSION} go test ./precompiles/mldsa/"
  as_node "cd '$src' && PATH=$(dirname "$GO"):\$PATH GOTOOLCHAIN=go${GO_VERSION} make install"
  install -m 755 "/home/${NODE_USER}/go/bin/evmd" "$BIN"
fi
"$BIN" version

# Runs the chain binary as the node user with the right home.
z() { su -s /bin/bash "$NODE_USER" -c "$BIN $*"; }
K="--keyring-backend test --keyring-dir $KEYS_DIR"

if [ ! -f "$NODE_HOME/config/genesis.json" ]; then
  step "5/8 keys and genesis"
  as_node "mkdir -p '$KEYS_DIR' && chmod 700 '$KEYS_DIR'"
  backup="$KEYS_DIR/MNEMONICS-KEEP-SECRET.txt"
  as_node "umask 077 && : > '$backup'"
  for name in validator rewards swd-airdrop community liquidity team; do
    out=$(z keys add "$name" $K --algo eth_secp256k1 --home "$NODE_HOME" --output json)
    echo "$name $(echo "$out" | jq -r .mnemonic)" | as_node "cat >> '$backup'"
  done
  addr() { z keys show "$1" -a $K --home "$NODE_HOME"; }

  z init "$MONIKER" --chain-id "$CHAIN_ID" --home "$NODE_HOME" >/dev/null
  z config set client chain-id "$CHAIN_ID" --home "$NODE_HOME"
  G="$NODE_HOME/config/genesis.json"
  jqg() { as_node "jq '$1' '$G' > '$G.tmp' && mv '$G.tmp' '$G'"; }

  jqg ".app_state.staking.params.bond_denom=\"$DENOM\""
  jqg ".app_state.gov.params.min_deposit[0].denom=\"$DENOM\" | .app_state.gov.params.expedited_min_deposit[0].denom=\"$DENOM\""
  # Deposit to open a proposal: 1,000 ZETAPHY (5,000 expedited). The SDK
  # default is a few atto-units, which would let anyone spam proposals.
  jqg '.app_state.gov.params.min_deposit[0].amount="1000000000000000000000" | .app_state.gov.params.expedited_min_deposit[0].amount="5000000000000000000000"'
  jqg ".app_state.evm.params.evm_denom=\"$DENOM\" | .app_state.mint.params.mint_denom=\"$DENOM\""
  # Fixed supply: no inflation. Rewards come from the rewards pool in a later step.
  jqg '.app_state.mint.minter.inflation="0.000000000000000000" | .app_state.mint.params.inflation_rate_change="0.000000000000000000" | .app_state.mint.params.inflation_max="0.000000000000000000" | .app_state.mint.params.inflation_min="0.000000000000000000"'
  jqg ".app_state.bank.denom_metadata=[{\"description\":\"ZETAPHY Chain native token (testnet)\",\"denom_units\":[{\"denom\":\"$DENOM\",\"exponent\":0,\"aliases\":[\"attozetaphy\"]},{\"denom\":\"zetaphy\",\"exponent\":18,\"aliases\":[]}],\"base\":\"$DENOM\",\"display\":\"zetaphy\",\"name\":\"ZETAPHY\",\"symbol\":\"ZETAPHY\",\"uri\":\"\",\"uri_hash\":\"\"}]"
  # Sorted ascending (genesis validation requires it); 0x...0900 = ML-DSA (stage 5).
  jqg '.app_state.evm.params.active_static_precompiles=["0x0000000000000000000000000000000000000100","0x0000000000000000000000000000000000000400","0x0000000000000000000000000000000000000800","0x0000000000000000000000000000000000000801","0x0000000000000000000000000000000000000802","0x0000000000000000000000000000000000000803","0x0000000000000000000000000000000000000804","0x0000000000000000000000000000000000000805","0x0000000000000000000000000000000000000806","0x0000000000000000000000000000000000000807","0x0000000000000000000000000000000000000900"]'
  jqg ".app_state.erc20.native_precompiles=[\"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE\"] | .app_state.erc20.token_pairs=[{contract_owner:1,erc20_address:\"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE\",denom:\"$DENOM\",enabled:true}]"
  jqg '.consensus.params.block.max_gas="30000000"'
  # Testnet: short votes so upgrade proposals can be tried quickly.
  jqg '.app_state.gov.params.voting_period="600s" | .app_state.gov.params.expedited_voting_period="300s" | .app_state.gov.params.max_deposit_period="600s"'

  # amounts exceed 64-bit integers, so do the arithmetic in python
  liquidity=$(python3 -c "print($LIQUIDITY_TOTAL - $VALIDATOR_GRANT)")
  z genesis add-genesis-account "$(addr validator)" "${VALIDATOR_GRANT}${DENOM}" --home "$NODE_HOME"
  if [ -n "$OWNER_EVM_ADDRESS" ]; then
    owner=$(z debug addr "$OWNER_EVM_ADDRESS" --home "$NODE_HOME" | awk '/Bech32 Acc/ {print $3}')
    [ -n "$owner" ] || { echo "OWNER_EVM_ADDRESS is not a valid 0x address"; exit 1; }
    z genesis add-genesis-account "$owner" "${OWNER_GRANT}${DENOM}" --home "$NODE_HOME"
    liquidity=$(python3 -c "print($liquidity - $OWNER_GRANT)")
  fi
  z genesis add-genesis-account "$(addr rewards)" "${REWARDS}${DENOM}" --home "$NODE_HOME"
  z genesis add-genesis-account "$(addr swd-airdrop)" "${SWD_AIRDROP}${DENOM}" --home "$NODE_HOME"
  z genesis add-genesis-account "$(addr community)" "${COMMUNITY}${DENOM}" --home "$NODE_HOME"
  z genesis add-genesis-account "$(addr liquidity)" "${liquidity}${DENOM}" --home "$NODE_HOME"
  now=$(date +%s)
  z genesis add-genesis-account "$(addr team)" "${TEAM}${DENOM}" --home "$NODE_HOME" \
    --vesting-amount "${TEAM}${DENOM}" --vesting-start-time $((now + 365*86400)) --vesting-end-time $((now + 4*365*86400))

  total=$(as_node "jq -r '[.app_state.bank.balances[].coins[] | select(.denom==\"$DENOM\") | .amount | tonumber] | add' '$G'")
  python3 - "$total" <<'PY'
import sys
t = int(float(sys.argv[1]))
assert abs(t - 10**27) < 10**12, f"genesis supply {t} != 1,000,000,000 ZETAPHY"
PY

  z genesis gentx validator "${SELF_STAKE}${DENOM}" $K --chain-id "$CHAIN_ID" --home "$NODE_HOME" \
    --gas-prices "1000000000${DENOM}" --moniker "$MONIKER"
  z genesis collect-gentxs --home "$NODE_HOME" >/dev/null
  z genesis validate-genesis --home "$NODE_HOME"

fi

# Settings are re-applied on every run, so running the script again repairs them.
step "6/8 node settings"
C="$NODE_HOME/config/config.toml"; A="$NODE_HOME/config/app.toml"
as_node "sed -i -E 's/^timeout_commit = .*/timeout_commit = \"5s\"/' '$C'"            # ~5 s blocks
# Cosmos EVM's own mempool requires CometBFT to hand transactions to the app.
as_node "sed -i -E 's/^type = \"flood\"/type = \"app\"/' '$C'"
as_node "sed -i -E 's/^minimum-gas-prices = .*/minimum-gas-prices = \"1000000000$DENOM\"/' '$A'"
as_node "sed -i -E 's/^evm-chain-id = .*/evm-chain-id = $EVM_CHAIN_ID/' '$A'"
# Public: EVM JSON-RPC 8545 (read + send signed txs) and P2P 26656.
# Local only: CometBFT RPC 26657, REST 1317, gRPC 9090 (defaults).
as_node "python3 - '$A' <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
sec = re.search(r'(?ms)^\[json-rpc\].*?(?=^\[|\Z)', s).group(0)
new = re.sub(r'(?m)^enable = .*', 'enable = true', sec)
new = re.sub(r'(?m)^address = .*', 'address = \"0.0.0.0:8545\"', new)
new = re.sub(r'(?m)^ws-address = .*', 'ws-address = \"127.0.0.1:8546\"', new)
new = re.sub(r'(?m)^api = .*', 'api = \"eth,net,web3,txpool\"', new)
# The port is public: keep one caller from tying the node up.
limits = {
    'allow-insecure-unlock': 'false',         # no account unlocking over RPC
    'gas-cap': '10000000',                    # eth_call / estimateGas gas ceiling
    'evm-timeout': '\"3s\"',                  # eth_call wall-clock ceiling
    'logs-cap': '2000',                       # eth_getLogs results per call
    'block-range-cap': '2000',                # eth_getLogs block span per call
    'max-open-connections': '200',            # 0 meant unlimited
    'batch-request-limit': '50',
    'batch-response-max-size': '5000000',
    'http-body-limit': '1048576',             # 1 MB requests
}
for k, v in limits.items():
    new = re.sub(r'(?m)^' + re.escape(k) + r' = .*', k + ' = ' + v, new)
open(p, 'w').write(s.replace(sec, new))
PY"

step "7/8 service"
START="$BIN start --home $NODE_HOME --chain-id $CHAIN_ID --json-rpc.api eth,net,web3,txpool"
# Use systemd only when it is actually running (it may be installed but off,
# e.g. on WSL without systemd=true); otherwise start the node in the background.
if [ -z "$NO_SYSTEMD" ] && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/zetaphyd.service <<UNIT
[Unit]
Description=ZETAPHY testnet node
After=network-online.target
Wants=network-online.target

[Service]
User=$NODE_USER
ExecStart=$START
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now zetaphyd
else
  as_node "nohup $START > /home/$NODE_USER/zetaphyd.log 2>&1 &"
fi

step "8/8 firewall"
# Oracle's Ubuntu images reject everything except SSH in iptables; open the two public ports.
if command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  for port in 8545 26656; do
    iptables -C INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport $port -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

ip=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null || hostname -I | awk '{print $1}')
cat <<INFO | tee "/home/$NODE_USER/NODE-INFO.txt"

ZETAPHY testnet node is starting.
  Chain ID (Cosmos):   $CHAIN_ID
  Chain ID (EVM):      $EVM_CHAIN_ID
  MetaMask RPC URL:    http://$ip:8545
  Currency symbol:     ZETAPHY
  Genesis keys:        $KEYS_DIR (testnet only; MNEMONICS-KEEP-SECRET.txt)
  Logs:                journalctl -u zetaphyd -f
INFO

exit 0

# ---- ML-DSA precompile patch (applied in step 4; never executed as shell) ----
: <<'ZETAPHY_PQ_PATCH'
diff --git a/evmd/go.mod b/evmd/go.mod
index e503386..dc04366 100644
--- a/evmd/go.mod
+++ b/evmd/go.mod
@@ -88,6 +88,7 @@ require (
 	github.com/cenkalti/backoff/v5 v5.0.3 // indirect
 	github.com/cespare/xxhash/v2 v2.3.0 // indirect
 	github.com/chzyer/readline v1.5.1 // indirect
+	github.com/cloudflare/circl v1.6.3 // indirect
 	github.com/cloudwego/base64x v0.1.6 // indirect
 	github.com/cncf/xds/go v0.0.0-20260202195803-dba9d589def2 // indirect
 	github.com/cockroachdb/errors v1.13.0 // indirect
diff --git a/evmd/go.sum b/evmd/go.sum
index 92d6f82..4ce53b3 100644
--- a/evmd/go.sum
+++ b/evmd/go.sum
@@ -220,6 +220,8 @@ github.com/circonus-labs/circonus-gometrics v2.3.1+incompatible/go.mod h1:nmEj6D
 github.com/circonus-labs/circonusllhist v0.1.3/go.mod h1:kMXHVDlOchFAehlya5ePtbp5jckzBHf4XRpQvBOLI+I=
 github.com/clbanning/x2j v0.0.0-20191024224557-825249438eec/go.mod h1:jMjuTZXRI4dUb/I5gc9Hdhagfvm9+RyrPryS/auMzxE=
 github.com/client9/misspell v0.3.4/go.mod h1:qj6jICC3Q7zFZvVWo7KLAzC3yx5G7kyvSDkc90ppPyw=
+github.com/cloudflare/circl v1.6.3 h1:9GPOhQGF9MCYUeXyMYlqTR6a5gTrgR/fBLXvUgtVcg8=
+github.com/cloudflare/circl v1.6.3/go.mod h1:2eXP6Qfat4O/Yhh8BznvKnJ+uzEoTQ6jVKJRn81BiS4=
 github.com/cloudwego/base64x v0.1.6 h1:t11wG9AECkCDk5fMSoxmufanudBtJ+/HemLstXDLI2M=
 github.com/cloudwego/base64x v0.1.6/go.mod h1:OFcloc187FXDaYHvrNIjxSe8ncn0OOM8gEHfghB2IPU=
 github.com/cncf/udpa/go v0.0.0-20191209042840-269d4d468f6f/go.mod h1:M8M6+tZqaGXZJjfX53e64911xZQV5JYwmTeXPW+k8Sc=
diff --git a/go.mod b/go.mod
index 777e52d..c4797ba 100644
--- a/go.mod
+++ b/go.mod
@@ -119,6 +119,7 @@ require (
 	github.com/cenkalti/backoff/v5 v5.0.3 // indirect
 	github.com/cespare/xxhash/v2 v2.3.0 // indirect
 	github.com/chzyer/readline v1.5.1 // indirect
+	github.com/cloudflare/circl v1.6.3 // indirect
 	github.com/cloudwego/base64x v0.1.6 // indirect
 	github.com/cncf/xds/go v0.0.0-20260202195803-dba9d589def2 // indirect
 	github.com/cockroachdb/errors v1.13.0 // indirect
diff --git a/go.sum b/go.sum
index 11f8f59..bbea7b7 100644
--- a/go.sum
+++ b/go.sum
@@ -215,6 +215,8 @@ github.com/circonus-labs/circonus-gometrics v2.3.1+incompatible/go.mod h1:nmEj6D
 github.com/circonus-labs/circonusllhist v0.1.3/go.mod h1:kMXHVDlOchFAehlya5ePtbp5jckzBHf4XRpQvBOLI+I=
 github.com/clbanning/x2j v0.0.0-20191024224557-825249438eec/go.mod h1:jMjuTZXRI4dUb/I5gc9Hdhagfvm9+RyrPryS/auMzxE=
 github.com/client9/misspell v0.3.4/go.mod h1:qj6jICC3Q7zFZvVWo7KLAzC3yx5G7kyvSDkc90ppPyw=
+github.com/cloudflare/circl v1.6.3 h1:9GPOhQGF9MCYUeXyMYlqTR6a5gTrgR/fBLXvUgtVcg8=
+github.com/cloudflare/circl v1.6.3/go.mod h1:2eXP6Qfat4O/Yhh8BznvKnJ+uzEoTQ6jVKJRn81BiS4=
 github.com/cloudwego/base64x v0.1.6 h1:t11wG9AECkCDk5fMSoxmufanudBtJ+/HemLstXDLI2M=
 github.com/cloudwego/base64x v0.1.6/go.mod h1:OFcloc187FXDaYHvrNIjxSe8ncn0OOM8gEHfghB2IPU=
 github.com/cncf/udpa/go v0.0.0-20191209042840-269d4d468f6f/go.mod h1:M8M6+tZqaGXZJjfX53e64911xZQV5JYwmTeXPW+k8Sc=
diff --git a/precompiles/mldsa/mldsa.go b/precompiles/mldsa/mldsa.go
new file mode 100644
index 0000000..a291984
--- /dev/null
+++ b/precompiles/mldsa/mldsa.go
@@ -0,0 +1,98 @@
+// Package mldsa adds post-quantum signature verification to the EVM:
+// ML-DSA (FIPS 204, the NIST standard formerly called CRYSTALS-Dilithium).
+// ZETAPHY stage 5: smart wallets can require a signature that a quantum
+// computer cannot forge, alongside (or instead of) secp256k1 ECDSA.
+//
+// Input:  1 byte  parameter set: 44 (ML-DSA-44) or 65 (ML-DSA-65)
+//
+//	32 bytes message (usually a hash the wallet signed)
+//	public key  (1312 bytes for 44, 1952 for 65)
+//	signature   (2420 bytes for 44, 3309 for 65)
+//
+// Output: 32 bytes ending in 0x01 when the signature is valid; empty
+//
+//	otherwise (the same convention as the P256 precompile, RIP-7212).
+//
+// Pure ML-DSA with an empty context string, as FIPS 204 section 5.2.
+package mldsa
+
+import (
+	"github.com/cloudflare/circl/sign/mldsa/mldsa44"
+	"github.com/cloudflare/circl/sign/mldsa/mldsa65"
+	"github.com/ethereum/go-ethereum/common"
+	"github.com/ethereum/go-ethereum/core/vm"
+
+	evmtypes "github.com/cosmos/evm/x/vm/types"
+)
+
+var _ vm.PrecompiledContract = &Precompile{}
+
+const (
+	// Gas per verification. Verifying takes roughly the time of a few
+	// ECDSA recoveries; the large input already pays calldata gas.
+	VerifyGas44 uint64 = 30_000
+	VerifyGas65 uint64 = 45_000
+	// InvalidInputGas is charged when the input has no valid shape.
+	InvalidInputGas uint64 = 3_000
+
+	Variant44 byte = 44
+	Variant65 byte = 65
+)
+
+type Precompile struct{}
+
+func (Precompile) Name() string { return "mldsa" }
+
+func (Precompile) Address() common.Address {
+	return common.HexToAddress(evmtypes.MLDSAPrecompileAddress)
+}
+
+func (Precompile) RequiredGas(input []byte) uint64 {
+	if len(input) > 0 {
+		switch input[0] {
+		case Variant44:
+			return VerifyGas44
+		case Variant65:
+			return VerifyGas65
+		}
+	}
+	return InvalidInputGas
+}
+
+var valid = common.LeftPadBytes([]byte{1}, 32)
+
+func (p *Precompile) Run(_ *vm.EVM, contract *vm.Contract, _ bool) ([]byte, error) {
+	if Verify(contract.Input) {
+		return valid, nil
+	}
+	return nil, nil
+}
+
+// Verify checks one packed input as described in the package comment.
+func Verify(in []byte) bool {
+	if len(in) < 33 {
+		return false
+	}
+	variant, msg, rest := in[0], in[1:33], in[33:]
+	switch variant {
+	case Variant44:
+		if len(rest) != mldsa44.PublicKeySize+mldsa44.SignatureSize {
+			return false
+		}
+		var pk mldsa44.PublicKey
+		if pk.UnmarshalBinary(rest[:mldsa44.PublicKeySize]) != nil {
+			return false
+		}
+		return mldsa44.Verify(&pk, msg, nil, rest[mldsa44.PublicKeySize:])
+	case Variant65:
+		if len(rest) != mldsa65.PublicKeySize+mldsa65.SignatureSize {
+			return false
+		}
+		var pk mldsa65.PublicKey
+		if pk.UnmarshalBinary(rest[:mldsa65.PublicKeySize]) != nil {
+			return false
+		}
+		return mldsa65.Verify(&pk, msg, nil, rest[mldsa65.PublicKeySize:])
+	}
+	return false
+}
diff --git a/precompiles/mldsa/mldsa_test.go b/precompiles/mldsa/mldsa_test.go
new file mode 100644
index 0000000..7f61111
--- /dev/null
+++ b/precompiles/mldsa/mldsa_test.go
@@ -0,0 +1,117 @@
+package mldsa
+
+import (
+	"crypto/rand"
+	"testing"
+
+	"github.com/cloudflare/circl/sign/mldsa/mldsa44"
+	"github.com/cloudflare/circl/sign/mldsa/mldsa65"
+)
+
+func pack(variant byte, msg, pk, sig []byte) []byte {
+	out := append([]byte{variant}, msg...)
+	out = append(out, pk...)
+	return append(out, sig...)
+}
+
+func TestMLDSA44(t *testing.T) {
+	pk, sk, err := mldsa44.GenerateKey(rand.Reader)
+	if err != nil {
+		t.Fatal(err)
+	}
+	msg := make([]byte, 32)
+	_, _ = rand.Read(msg)
+	sig := make([]byte, mldsa44.SignatureSize)
+	if err := mldsa44.SignTo(sk, msg, nil, false, sig); err != nil {
+		t.Fatal(err)
+	}
+	pkb, _ := pk.MarshalBinary()
+	if !Verify(pack(44, msg, pkb, sig)) {
+		t.Fatal("valid signature rejected")
+	}
+	bad := append([]byte{}, msg...)
+	bad[0] ^= 1
+	if Verify(pack(44, bad, pkb, sig)) {
+		t.Fatal("signature over another message accepted")
+	}
+	sig[10] ^= 1
+	if Verify(pack(44, msg, pkb, sig)) {
+		t.Fatal("tampered signature accepted")
+	}
+	if Verify(pack(65, msg, pkb, sig)) || Verify(pack(44, msg, pkb, sig[:100])) || Verify([]byte{44}) || Verify(nil) {
+		t.Fatal("malformed input accepted")
+	}
+}
+
+func TestMLDSA65(t *testing.T) {
+	pk, sk, _ := mldsa65.GenerateKey(rand.Reader)
+	msg := make([]byte, 32)
+	sig := make([]byte, mldsa65.SignatureSize)
+	if err := mldsa65.SignTo(sk, msg, nil, true, sig); err != nil {
+		t.Fatal(err)
+	}
+	pkb, _ := pk.MarshalBinary()
+	if !Verify(pack(65, msg, pkb, sig)) {
+		t.Fatal("valid signature rejected")
+	}
+}
+
+func TestGas(t *testing.T) {
+	var p Precompile
+	if p.RequiredGas([]byte{44}) != VerifyGas44 || p.RequiredGas([]byte{65}) != VerifyGas65 || p.RequiredGas(nil) != InvalidInputGas {
+		t.Fatal("gas")
+	}
+}
+
+// FuzzVerify: no input, however malformed, may panic (a panic in a
+// precompile would halt the chain) or be accepted without a valid signature.
+func FuzzVerify(f *testing.F) {
+	pk, sk, _ := mldsa44.GenerateKey(rand.Reader)
+	pkb, _ := pk.MarshalBinary()
+	msg := make([]byte, 32)
+	sig := make([]byte, mldsa44.SignatureSize)
+	_ = mldsa44.SignTo(sk, msg, nil, false, sig)
+	good := pack(44, msg, pkb, sig)
+	f.Add(good)
+	f.Add([]byte{})
+	f.Add([]byte{65})
+	f.Add(good[:100])
+	f.Fuzz(func(t *testing.T, in []byte) {
+		ok := Verify(in) // must not panic
+		if ok && len(in) != len(good) {
+			t.Fatalf("accepted an input of the wrong size (%d bytes)", len(in))
+		}
+	})
+}
+
+// Measures verification time, to keep the gas price honest. For scale: the
+// ECRECOVER precompile costs 3,000 gas for roughly 25-50 microseconds.
+func BenchmarkVerify44(b *testing.B) {
+	pk, sk, _ := mldsa44.GenerateKey(rand.Reader)
+	pkb, _ := pk.MarshalBinary()
+	msg := make([]byte, 32)
+	sig := make([]byte, mldsa44.SignatureSize)
+	_ = mldsa44.SignTo(sk, msg, nil, false, sig)
+	in := pack(44, msg, pkb, sig)
+	b.ResetTimer()
+	for i := 0; i < b.N; i++ {
+		if !Verify(in) {
+			b.Fatal("rejected")
+		}
+	}
+}
+
+func BenchmarkVerify65(b *testing.B) {
+	pk, sk, _ := mldsa65.GenerateKey(rand.Reader)
+	pkb, _ := pk.MarshalBinary()
+	msg := make([]byte, 32)
+	sig := make([]byte, mldsa65.SignatureSize)
+	_ = mldsa65.SignTo(sk, msg, nil, false, sig)
+	in := pack(65, msg, pkb, sig)
+	b.ResetTimer()
+	for i := 0; i < b.N; i++ {
+		if !Verify(in) {
+			b.Fatal("rejected")
+		}
+	}
+}
diff --git a/precompiles/types/defaults.go b/precompiles/types/defaults.go
index cd68986..f192838 100644
--- a/precompiles/types/defaults.go
+++ b/precompiles/types/defaults.go
@@ -79,6 +79,7 @@ func DefaultStaticPrecompiles(
 	precompiles := NewStaticPrecompiles().
 		WithPraguePrecompiles().
 		WithP256Precompile().
+		WithMLDSAPrecompile().
 		WithBech32Precompile().
 		WithStakingPrecompile(stakingKeeper, bankKeeper, opts...).
 		WithDistributionPrecompile(distributionKeeper, stakingKeeper, bankKeeper, opts...).
diff --git a/precompiles/types/static_precompiles.go b/precompiles/types/static_precompiles.go
index 7f19b35..ec74b76 100644
--- a/precompiles/types/static_precompiles.go
+++ b/precompiles/types/static_precompiles.go
@@ -15,6 +15,7 @@ import (
 	govprecompile "github.com/cosmos/evm/precompiles/gov"
 	ics02precompile "github.com/cosmos/evm/precompiles/ics02"
 	ics20precompile "github.com/cosmos/evm/precompiles/ics20"
+	"github.com/cosmos/evm/precompiles/mldsa"
 	"github.com/cosmos/evm/precompiles/p256"
 	slashingprecompile "github.com/cosmos/evm/precompiles/slashing"
 	stakingprecompile "github.com/cosmos/evm/precompiles/staking"
@@ -46,6 +47,12 @@ func (s StaticPrecompiles) WithP256Precompile() StaticPrecompiles {
 	return s
 }
 
+func (s StaticPrecompiles) WithMLDSAPrecompile() StaticPrecompiles {
+	mldsaPrecompile := &mldsa.Precompile{}
+	s[mldsaPrecompile.Address()] = mldsaPrecompile
+	return s
+}
+
 func (s StaticPrecompiles) WithBech32Precompile() StaticPrecompiles {
 	bech32Precompile, err := bech32.NewPrecompile(bech32PrecompileBaseGas)
 	if err != nil {
diff --git a/x/vm/types/precompiles.go b/x/vm/types/precompiles.go
index a7e058a..d3819ff 100644
--- a/x/vm/types/precompiles.go
+++ b/x/vm/types/precompiles.go
@@ -3,6 +3,8 @@ package types
 const (
 	P256PrecompileAddress   = "0x0000000000000000000000000000000000000100"
 	Bech32PrecompileAddress = "0x0000000000000000000000000000000000000400"
+	// MLDSAPrecompileAddress: post-quantum ML-DSA (FIPS 204) verification (ZETAPHY).
+	MLDSAPrecompileAddress = "0x0000000000000000000000000000000000000900"
 )
 
 const (
@@ -23,6 +25,7 @@ const (
 var AvailableStaticPrecompiles = []string{
 	P256PrecompileAddress,
 	Bech32PrecompileAddress,
+	MLDSAPrecompileAddress,
 	StakingPrecompileAddress,
 	DistributionPrecompileAddress,
 	ICS20PrecompileAddress,
ZETAPHY_PQ_PATCH
