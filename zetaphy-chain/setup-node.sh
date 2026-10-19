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
  jqg ".app_state.evm.params.evm_denom=\"$DENOM\" | .app_state.mint.params.mint_denom=\"$DENOM\""
  # Fixed supply: no inflation. Rewards come from the rewards pool in a later step.
  jqg '.app_state.mint.minter.inflation="0.000000000000000000" | .app_state.mint.params.inflation_rate_change="0.000000000000000000" | .app_state.mint.params.inflation_max="0.000000000000000000" | .app_state.mint.params.inflation_min="0.000000000000000000"'
  jqg ".app_state.bank.denom_metadata=[{\"description\":\"ZETAPHY Chain native token (testnet)\",\"denom_units\":[{\"denom\":\"$DENOM\",\"exponent\":0,\"aliases\":[\"attozetaphy\"]},{\"denom\":\"zetaphy\",\"exponent\":18,\"aliases\":[]}],\"base\":\"$DENOM\",\"display\":\"zetaphy\",\"name\":\"ZETAPHY\",\"symbol\":\"ZETAPHY\",\"uri\":\"\",\"uri_hash\":\"\"}]"
  jqg '.app_state.evm.params.active_static_precompiles=["0x0000000000000000000000000000000000000100","0x0000000000000000000000000000000000000400","0x0000000000000000000000000000000000000800","0x0000000000000000000000000000000000000801","0x0000000000000000000000000000000000000802","0x0000000000000000000000000000000000000803","0x0000000000000000000000000000000000000804","0x0000000000000000000000000000000000000805","0x0000000000000000000000000000000000000806","0x0000000000000000000000000000000000000807"]'
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
open(p, 'w').write(s.replace(sec, new))
PY"

step "7/8 service"
START="$BIN start --home $NODE_HOME --chain-id $CHAIN_ID --json-rpc.api eth,net,web3,txpool"
if [ -z "$NO_SYSTEMD" ] && command -v systemctl >/dev/null; then
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
