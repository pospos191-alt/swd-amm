#!/usr/bin/env bash
# Throwaway single-node ZETAPHY chain for integration tests (NOT the testnet).
# Same binary, chain settings and EVM chain id as zetaphy-chain/setup-node.sh,
# but 1 s blocks, a temp home, and the given 0x addresses funded at genesis.
#
#   scripts/devnet.sh <home-dir> <rpc-port> 0xADDR [0xADDR ...]
# Starts the node in the background, writes its pid to <home>/node.pid and
# waits until the EVM JSON-RPC answers. Stop it with: kill $(cat <home>/node.pid)
set -euo pipefail
HOME_DIR=$1; PORT=$2; shift 2
BIN=${ZETAPHYD:-zetaphyd}
DENOM=azetaphy; CHAIN_ID=zetaphy-local-1; EVM_CHAIN_ID=77390
K="--keyring-backend test --home $HOME_DIR"
rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR"

$BIN init devnet --chain-id $CHAIN_ID --home "$HOME_DIR" >/dev/null 2>&1
$BIN keys add validator $K --algo eth_secp256k1 >/dev/null 2>&1
G="$HOME_DIR/config/genesis.json"
jqg() { jq "$1" "$G" > "$G.tmp" && mv "$G.tmp" "$G"; }
jqg ".app_state.staking.params.bond_denom=\"$DENOM\" | .app_state.gov.params.min_deposit[0].denom=\"$DENOM\" | .app_state.gov.params.expedited_min_deposit[0].denom=\"$DENOM\" | .app_state.evm.params.evm_denom=\"$DENOM\" | .app_state.mint.params.mint_denom=\"$DENOM\""
jqg ".app_state.bank.denom_metadata=[{\"description\":\"ZETAPHY (devnet)\",\"denom_units\":[{\"denom\":\"$DENOM\",\"exponent\":0},{\"denom\":\"zetaphy\",\"exponent\":18}],\"base\":\"$DENOM\",\"display\":\"zetaphy\",\"name\":\"ZETAPHY\",\"symbol\":\"ZETAPHY\"}]"
jqg ".app_state.erc20.native_precompiles=[\"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE\"] | .app_state.erc20.token_pairs=[{contract_owner:1,erc20_address:\"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE\",denom:\"$DENOM\",enabled:true}]"
jqg '.consensus.params.block.max_gas="30000000" | .app_state.gov.params.voting_period="20s" | .app_state.gov.params.expedited_voting_period="10s" | .app_state.gov.params.max_deposit_period="20s"'
jqg '.app_state.gov.params.min_deposit[0].amount="1000000000000000000000" | .app_state.gov.params.expedited_min_deposit[0].amount="5000000000000000000000"'

$BIN genesis add-genesis-account "$($BIN keys show validator -a $K)" "100000000000000000000000000$DENOM" --home "$HOME_DIR"
for a in "$@"; do
  bech=$($BIN debug addr "$a" --home "$HOME_DIR" | awk '/Bech32 Acc/ {print $3}')
  $BIN genesis add-genesis-account "$bech" "1000000000000000000000000$DENOM" --home "$HOME_DIR"   # 1,000,000 ZETAPHY
done
$BIN genesis gentx validator "10000000000000000000000000$DENOM" $K --chain-id $CHAIN_ID --gas-prices "1000000000$DENOM" >/dev/null 2>&1
$BIN genesis collect-gentxs --home "$HOME_DIR" >/dev/null 2>&1
$BIN genesis validate-genesis --home "$HOME_DIR" >/dev/null

C="$HOME_DIR/config/config.toml"; A="$HOME_DIR/config/app.toml"
sed -i -E 's/^timeout_commit = .*/timeout_commit = "1s"/; s/^type = "flood"/type = "app"/' "$C"
sed -i -E "s#^laddr = \"tcp://127.0.0.1:26657\"#laddr = \"tcp://127.0.0.1:$((PORT+100))\"#; s#^laddr = \"tcp://0.0.0.0:26656\"#laddr = \"tcp://127.0.0.1:$((PORT+101))\"#" "$C"
sed -i -E "s/^minimum-gas-prices = .*/minimum-gas-prices = \"1000000000$DENOM\"/; s/^evm-chain-id = .*/evm-chain-id = $EVM_CHAIN_ID/" "$A"
python3 - "$A" "$PORT" <<'PY'
import re, sys
p, port = sys.argv[1], int(sys.argv[2]); s = open(p).read()
sec = re.search(r'(?ms)^\[json-rpc\].*?(?=^\[|\Z)', s).group(0)
new = re.sub(r'(?m)^enable = .*', 'enable = true', sec)
new = re.sub(r'(?m)^address = .*', f'address = "127.0.0.1:{port}"', new)
new = re.sub(r'(?m)^ws-address = .*', f'ws-address = "127.0.0.1:{port+1}"', new)
new = re.sub(r'(?m)^api = .*', 'api = "eth,net,web3,txpool"', new)
s = s.replace(sec, new)
s = re.sub(r'(?ms)(^\[grpc\].*?^address = )"[^"]*"', rf'\1"127.0.0.1:{port+102}"', s)
s = re.sub(r'(?ms)(^\[api\].*?^address = )"[^"]*"', rf'\1"tcp://127.0.0.1:{port+103}"', s)
open(p, 'w').write(s)
PY

nohup $BIN start --home "$HOME_DIR" --chain-id $CHAIN_ID --json-rpc.api eth,net,web3,txpool > "$HOME_DIR/node.log" 2>&1 &
echo $! > "$HOME_DIR/node.pid"
for i in $(seq 1 90); do
  if curl -s -m 2 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "http://127.0.0.1:$PORT" | grep -q '"result":"0x[1-9a-f]'; then
    echo "devnet up: http://127.0.0.1:$PORT (pid $(cat "$HOME_DIR/node.pid"))"; exit 0
  fi
  sleep 1
done
echo "devnet did not start; last log lines:"; tail -20 "$HOME_DIR/node.log"; exit 1
