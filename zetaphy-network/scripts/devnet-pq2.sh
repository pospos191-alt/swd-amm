#!/usr/bin/env bash
# Throwaway two-validator ZETAPHY chain with ML-DSA-44 vote signatures (vote
# extensions on from block 1), set up the way zetaphy-chain/test-vote-keys.sh
# does: A holds 60% of the power and B 40%, so every block needs both.
# Vote keys are written to <home>/{A,B}/config/pq_vote_key.seed but NOT
# registered; the caller registers them, e.g.
#   zetaphyd tx pq-vote-key --from valA --keyring-backend test --home <home>/A ...
#
#   scripts/devnet-pq2.sh <home-dir> <base-port>
# Node A: CometBFT RPC on <base-port> (p2p +1, gRPC +2, API +3, ABCI +4, geth metrics +5);
# node B: the same from <base-port>+10. Pids in <home>/{A,B}/pid, logs in node.log.
# Waits until block 3. Stop with: kill $(cat <home>/A/pid) $(cat <home>/B/pid)
set -euo pipefail
W=$1; P=$2
BIN=${ZETAPHYD:-zetaphyd}; CHAIN=${COSMOS_CHAIN_ID:-zetaphy-pqcert-1}; D=azetaphy
K="--keyring-backend test"
seed() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
rm -rf "$W"; mkdir -p "$W"
for n in A B; do
  $BIN init $n --chain-id $CHAIN --home "$W/$n" >/dev/null 2>&1
  $BIN keys add val$n $K --home "$W/$n" --algo eth_secp256k1 >/dev/null 2>&1
done
G="$W/A/config/genesis.json"
jq ".app_state.staking.params.bond_denom=\"$D\" | .app_state.evm.params.evm_denom=\"$D\" | .app_state.mint.params.mint_denom=\"$D\" | .app_state.gov.params.min_deposit[0].denom=\"$D\" | .app_state.gov.params.expedited_min_deposit[0].denom=\"$D\"
  | .app_state.bank.denom_metadata=[{description:\"ZETAPHY\",denom_units:[{denom:\"$D\",exponent:0},{denom:\"zetaphy\",exponent:18}],base:\"$D\",display:\"zetaphy\",name:\"ZETAPHY\",symbol:\"ZETAPHY\"}]
  | .consensus.params.abci.vote_extensions_enable_height=\"1\"" "$G" > "$G.t" && mv "$G.t" "$G"
for n in A B; do $BIN genesis add-genesis-account "$($BIN keys show val$n -a $K --home "$W/$n")" "100000000000000000000000000$D" --home "$W/A"; done
cp "$G" "$W/B/config/genesis.json"
$BIN genesis gentx valA "6000000000000000000000000$D" $K --home "$W/A" --chain-id $CHAIN --gas-prices "1000000000$D" >/dev/null 2>&1
$BIN genesis gentx valB "4000000000000000000000000$D" $K --home "$W/B" --chain-id $CHAIN --gas-prices "1000000000$D" >/dev/null 2>&1
cp "$W"/B/config/gentx/*.json "$W/A/config/gentx/"
$BIN genesis collect-gentxs --home "$W/A" >/dev/null 2>&1
cp "$G" "$W/B/config/genesis.json"

Q=$P
for n in A B; do
  sed -i -E "s/^timeout_commit = .*/timeout_commit = \"1s\"/; s/^type = \"flood\"/type = \"app\"/; s#^laddr = \"tcp://127.0.0.1:26657\"#laddr = \"tcp://127.0.0.1:$Q\"#; s#^laddr = \"tcp://0.0.0.0:26656\"#laddr = \"tcp://127.0.0.1:$((Q+1))\"#; s/^addr_book_strict = .*/addr_book_strict = false/; s/^allow_duplicate_ip = .*/allow_duplicate_ip = true/; s#^proxy_app = .*#proxy_app = \"tcp://127.0.0.1:$((Q+4))\"#; s#^pprof_laddr = .*#pprof_laddr = \"\"#" "$W/$n/config/config.toml"
  python3 - "$W/$n/config/app.toml" "$Q" "$D" <<'PY'
import re, sys
p, port, d = sys.argv[1], int(sys.argv[2]), sys.argv[3]; s = open(p).read()
s = re.sub(r'(?m)^minimum-gas-prices = .*', f'minimum-gas-prices = "1000000000{d}"', s)
s = re.sub(r'(?m)^geth-metrics-address = .*', f'geth-metrics-address = "127.0.0.1:{port+5}"', s)
for sec, key, val in [('json-rpc', 'enable', 'false'), ('grpc', 'enable', 'false'), ('grpc', 'address', f'"127.0.0.1:{port+2}"'), ('api', 'address', f'"tcp://127.0.0.1:{port+3}"')]:
    s = re.sub(rf'(?ms)(^\[{sec}\].*?^{key} = )\S+', rf'\g<1>{val}', s)
open(p, 'w').write(s)
PY
  (umask 077 && seed > "$W/$n/config/pq_vote_key.seed")
  Q=$((Q+10))
done
sed -i -E "s/^persistent_peers = .*/persistent_peers = \"$($BIN comet show-node-id --home "$W/A")@127.0.0.1:$((P+1))\"/" "$W/B/config/config.toml"

for n in A B; do
  nohup $BIN start --home "$W/$n" --chain-id $CHAIN >> "$W/$n/node.log" 2>&1 &
  echo $! > "$W/$n/pid"
done
for _ in $(seq 1 90); do
  h=$(curl -s -m 2 "http://127.0.0.1:$P/status" | jq -r '.result.sync_info.latest_block_height // 0' 2>/dev/null || echo 0)
  if [ "${h:-0}" -ge 3 ]; then echo "two-validator devnet up: CometBFT RPC http://127.0.0.1:$P and :$((P+10)) (chain $CHAIN)"; exit 0; fi
  sleep 1
done
echo "devnet did not start; last log lines:"; tail -20 "$W/A/node.log"; exit 1
