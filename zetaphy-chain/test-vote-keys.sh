#!/bin/bash
# Real two-validator devnet (A 60%, B 40%: both are needed for a block) that
# checks the ML-DSA-44 vote signatures:
#   1. both register vote keys and blocks continue
#   2. B's key file is wrong: B stops itself rather than vote; blocks stop
#   3. B's key restored and B restarted: blocks continue
#   4. B replaces its key (old one kept as .old): blocks never stop
#   5. replacing a key without the current key's signature is refused
#   6. each block starts with the ML-DSA vote certificate of the block before
#   7. a new full node catches up from genesis (blocksync checks certificates)
#   8. a governance vote switches off slashing on ed25519-only evidence
#   9. v5: governance turns the immune system on; a new contract gets the
#      median of both validators' vote-extension scores (docs/future/chain-protocol.md)
#   bash test-vote-keys.sh <zetaphyd> [workdir]
set -euo pipefail
BIN=$1; W=${2:-$(mktemp -d)}; CHAIN=zetaphy-ve-1; D=azetaphy
trap '[ -n "${KEEP:-}" ] || for n in A B C; do [ -f $W/$n/pid ] && kill $(cat $W/$n/pid) 2>/dev/null; done; true' EXIT
fail() { echo "FAIL: $*"; tail -5 $W/B/node.log; exit 1; }
seed() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
rm -rf $W; mkdir -p $W
for n in A B C; do $BIN init $n --chain-id $CHAIN --home $W/$n >/dev/null 2>&1; done
$BIN keys add valA --keyring-backend test --home $W/A --algo eth_secp256k1 >/dev/null 2>&1
$BIN keys add valB --keyring-backend test --home $W/B --algo eth_secp256k1 >/dev/null 2>&1
G=$W/A/config/genesis.json
jq ".app_state.staking.params.bond_denom=\"$D\" | .app_state.evm.params.evm_denom=\"$D\" | .app_state.mint.params.mint_denom=\"$D\" | .app_state.gov.params.min_deposit[0].denom=\"$D\" | .app_state.gov.params.expedited_min_deposit[0].denom=\"$D\"
  | .app_state.bank.denom_metadata=[{description:\"ZETAPHY\",denom_units:[{denom:\"$D\",exponent:0},{denom:\"zetaphy\",exponent:18}],base:\"$D\",display:\"zetaphy\",name:\"ZETAPHY\",symbol:\"ZETAPHY\"}]
  | .consensus.params.abci.vote_extensions_enable_height=\"1\"
  | .app_state.gov.params.voting_period=\"8s\" | .app_state.gov.params.expedited_voting_period=\"4s\" | .app_state.gov.params.max_deposit_period=\"8s\"" $G > $G.t && mv $G.t $G
for n in A B; do $BIN genesis add-genesis-account "$($BIN keys show val$n -a --keyring-backend test --home $W/$n)" "100000000000000000000000000$D" --home $W/A; done
cp $G $W/B/config/genesis.json
$BIN genesis gentx valA "6000000000000000000000000$D" --keyring-backend test --home $W/A --chain-id $CHAIN --gas-prices "1000000000$D" >/dev/null 2>&1
$BIN genesis gentx valB "4000000000000000000000000$D" --keyring-backend test --home $W/B --chain-id $CHAIN --gas-prices "1000000000$D" >/dev/null 2>&1
cp $W/B/config/gentx/*.json $W/A/config/gentx/
$BIN genesis collect-gentxs --home $W/A >/dev/null 2>&1
cp $G $W/B/config/genesis.json; cp $G $W/C/config/genesis.json
P=28545
for n in A B C; do
  sed -i -E "s/^timeout_commit = .*/timeout_commit = \"1s\"/; s/^type = \"flood\"/type = \"app\"/; s#^laddr = \"tcp://127.0.0.1:26657\"#laddr = \"tcp://127.0.0.1:$((P+100))\"#; s#^laddr = \"tcp://0.0.0.0:26656\"#laddr = \"tcp://127.0.0.1:$((P+101))\"#; s/^addr_book_strict = .*/addr_book_strict = false/; s/^allow_duplicate_ip = .*/allow_duplicate_ip = true/; s#^proxy_app = .*#proxy_app = \"tcp://127.0.0.1:$((P+104))\"#; s#^pprof_laddr = .*#pprof_laddr = \"\"#" $W/$n/config/config.toml
  python3 - $W/$n/config/app.toml $P $D <<'PY'
import re, sys
p, port, d = sys.argv[1], int(sys.argv[2]), sys.argv[3]; s = open(p).read()
s = re.sub(r'(?m)^minimum-gas-prices = .*', f'minimum-gas-prices = "1000000000{d}"', s)
for sec, key, val in [('json-rpc', 'enable', 'false'), ('grpc', 'enable', 'false'), ('grpc', 'address', f'"127.0.0.1:{port+102}"'), ('api', 'address', f'"tcp://127.0.0.1:{port+103}"')]:
    s = re.sub(rf'(?ms)(^\[{sec}\].*?^{key} = )\S+', rf'\g<1>{val}', s)
open(p, 'w').write(s)
PY
  seed > $W/$n/config/pq_vote_key.seed
  P=$((P+110))
done
for n in B C; do sed -i -E "s/^persistent_peers = .*/persistent_peers = \"$($BIN comet show-node-id --home $W/A)@127.0.0.1:28646\"/" $W/$n/config/config.toml; done
start() { nohup $BIN start --home $W/$1 --chain-id $CHAIN >> $W/$1/node.log 2>&1 & echo $! > $W/$1/pid; }
start A; start B
hgt() { curl -s 127.0.0.1:28645/status | jq -r '.result.sync_info.latest_block_height // 0'; }
moving() { local h; sleep 3; h=$(hgt); sleep "$1"; [ "$(hgt)" -gt "$h" ]; }
votekey() { $BIN tx pq-vote-key --from val$1 --keyring-backend test --home $W/$1 --chain-id $CHAIN --node tcp://127.0.0.1:28645 --gas 600000 --gas-prices 1000000000$D -y -o json | jq -r .txhash; }
txcode() { sleep 5; $BIN q tx $1 --node tcp://127.0.0.1:28645 -o json | jq -r .code; }
for _ in $(seq 1 60); do [ "$(hgt)" -ge 3 ] && break; sleep 1; done
[ "$(txcode $(votekey A))" = 0 ] || fail "A could not register"
[ "$(txcode $(votekey B))" = 0 ] || fail "B could not register"
moving 5 || fail "1: blocks stopped after registering"; echo "ok 1 registered, blocks continue"
cp $W/B/config/pq_vote_key.seed $W/B.good; seed > $W/B/config/pq_vote_key.seed
sleep 6; ! moving 6 || fail "2: blocks continued with B's wrong key"
[ -z "$(ps -p "$(cat $W/B/pid)" -o pid= || true)" ] || fail "2: B kept running with a wrong key"
grep -q "no ML-DSA vote key here matches" $W/B/node.log || fail "2: no message"; echo "ok 2 wrong key: B stopped, blocks stopped"
cp $W/B.good $W/B/config/pq_vote_key.seed; start B
for _ in $(seq 1 30); do moving 2 && break; done
moving 4 || fail "3: blocks did not resume"; echo "ok 3 key restored: blocks continue"
mv $W/B/config/pq_vote_key.seed $W/B/config/pq_vote_key.seed.old; seed > $W/B/config/pq_vote_key.seed
[ "$(txcode $(votekey B))" = 0 ] || fail "4: rotation refused"
moving 5 || fail "4: blocks stopped after rotation"; echo "ok 4 key replaced, blocks continue"
seed > $W/B/config/pq_vote_key.seed.old
[ "$(txcode $(votekey B))" != 0 ] || fail "5: replacement without the current key accepted"
moving 4 || fail "5: blocks stopped"; echo "ok 5 replacement without the current key refused"
h=$(( $(hgt) - 1 ))
acts=$(curl -s "127.0.0.1:28645/block_results?height=$h" | jq -r '.result.txs_results[0].events[]? | select(.type=="message") | .attributes[] | select(.key=="action") | .value')
echo "$acts" | grep -q "/zetaphy.pq.v1.MsgPQCertificate" || fail "6: block $h does not start with a vote certificate"
size=$(curl -s "127.0.0.1:28645/block?height=$h" | jq -r '.result.block.data.txs[0]' | base64 -d | wc -c)
[ "$size" -gt $((2 * 2440)) ] || fail "6: the certificate of block $h holds fewer than 2 signatures ($size bytes)"
echo "ok 6 block $h starts with a vote certificate ($size bytes)"
start C
for _ in $(seq 1 90); do
  [ "$(curl -s 127.0.0.1:28865/status | jq -r '.result.sync_info.catching_up // true')" = false ] && break; sleep 2
done
c=$(curl -s 127.0.0.1:28865/status | jq -r '.result.sync_info.latest_block_height // 0')
[ "$c" -ge "$h" ] || fail "7: the new node stopped at $c (tip $h)"; echo "ok 7 a new node caught up to $c, checking every certificate"
F="--keyring-backend test --chain-id $CHAIN --node tcp://127.0.0.1:28645 --gas 800000 --gas-prices 1000000000$D -y -o json"
$BIN tx pq-evidence-proposal on --deposit "10000000$D" --from valA --home $W/A $F >/dev/null
sleep 4
id=$($BIN q gov proposals --node tcp://127.0.0.1:28645 -o json 2>/dev/null | jq -r '[.proposals[]?.id | tonumber] | max // empty')
[ -n "$id" ] || fail "8: no proposal"
for n in A B; do $BIN tx gov vote "$id" yes --from val$n --home $W/$n $F >/dev/null; done
for _ in $(seq 1 20); do
  v=$(curl -s "127.0.0.1:28645/abci_query?path=%22/store/zetaphypq/key%22&data=0x05" | jq -r '.result.response.value // empty')
  [ "$v" = "AQ==" ] && break; sleep 2
done
[ "$v" = "AQ==" ] || fail "8: the switch is not on after the vote (proposal $id)"
moving 3 || fail "8: blocks stopped after the switch"; echo "ok 8 governance turned the evidence switch on (proposal $id); blocks continue"

# 9. v5 immune system on the live devnet: governance turns it on, a contract
# is deployed, both validators score it in their vote extensions (after the
# ML-DSA signature) and the median is recorded; certificates keep working and
# the full node C, which follows by blocksync/consensus, has the same score.
$BIN tx security-proposal immune '{"enabled":true,"enforce_bps":5000}' --deposit "10000000$D" --from valA --home $W/A $F >/dev/null
sleep 4
id=$($BIN q gov proposals --node tcp://127.0.0.1:28645 -o json 2>/dev/null | jq -r '[.proposals[]?.id | tonumber] | max // empty')
for n in A B; do $BIN tx gov vote "$id" yes --from val$n --home $W/$n $F >/dev/null; done
for _ in $(seq 1 20); do
  v=$(curl -s "127.0.0.1:28645/abci_query?path=%22/store/zetaphypq/key%22&data=0x22" | jq -r '.result.response.value // empty')
  [ -n "$v" ] && break; sleep 2
done
echo "$v" | base64 -d | grep -q '"enabled":true' || fail "9: the immune system is not on after the vote (proposal $id)"
runtime=63a9059cbb6370a0823163095ea7b363f9f92be43260ff50ff   # ERC-20 look, blacklist, tx.origin, SELFDESTRUCT: 5500 bps
init=6019600c60003960196000f3$runtime
# The contract is deployed with an Ethereum tx signed by tools/ethsign (run
# from the patched cosmos/evm checkout, which has go-ethereum).
[ -n "${ZETAPHY_SRC:-}" ] || { echo "skip 9: set ZETAPHY_SRC=<patched cosmos/evm checkout> to deploy a contract"; exit 0; }
from=$($BIN keys show valA -a --keyring-backend test --home $W/A)
key=$(echo y | $BIN keys unsafe-export-eth-key valA --keyring-backend test --home $W/A 2>/dev/null | tail -1)
nonce=$($BIN q auth account "$from" --node tcp://127.0.0.1:28645 -o json | jq -r '.account.value.sequence // .account.sequence // "0"')
evmcid=$(sed -n 's/^evm-chain-id = //p' $W/A/config/app.toml)
ethsign=$(dirname "$(readlink -f "$0")")/tools/ethsign/main.go
signed=$(cd "$ZETAPHY_SRC/evmd" && go run "$ethsign" "$key" "$evmcid" "$nonce" - "$init" $D) || fail "9: could not sign the deploy"
raw=$(echo "$signed" | sed -n 1p); c=$(echo "$signed" | sed -n 2p)
[ -n "$raw" ] && [ -n "$c" ] || fail "9: could not sign the deploy"
r=$(curl -s "127.0.0.1:28645/broadcast_tx_sync?tx=$raw")
[ "$(echo "$r" | jq -r .result.code)" = 0 ] || fail "9: deploy refused: $(echo "$r" | jq -c .)"
sleep 5
[ "$($BIN q tx "$(echo "$r" | jq -r .result.hash)" --node tcp://127.0.0.1:28645 -o json | jq -r .code)" = 0 ] || fail "9: deploy failed"
key=0x24$(echo "${c#0x}" | tr 'A-F' 'a-f')
for port in 28645 28865; do
  for _ in $(seq 1 20); do
    s=$(curl -s "127.0.0.1:$port/abci_query?path=%22/store/zetaphypq/key%22&data=$key" | jq -r '.result.response.value // empty')
    [ -n "$s" ] && break; sleep 2
  done
  [ "$(echo "$s" | base64 -d | od -An -tx1 -N2 | tr -d ' \n')" = 157c ] || fail "9: no immune score 5500 for $c on port $port (got '$s')"
done
moving 3 || fail "9: blocks stopped"
h=$(( $(hgt) - 1 ))
acts=$(curl -s "127.0.0.1:28645/block_results?height=$h" | jq -r '.result.txs_results[0].events[]? | select(.type=="message") | .attributes[] | select(.key=="action") | .value')
echo "$acts" | grep -q "/zetaphy.pq.v1.MsgPQCertificate" || fail "9: block $h no longer starts with a vote certificate"
echo "ok 9 v5 immune system: $c scored 5500 bps by both validators' vote extensions, same on the full node; certificates continue"
