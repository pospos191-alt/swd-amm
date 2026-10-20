#!/bin/bash
# Real two-validator devnet (A 60%, B 40%: both are needed for a block) that
# checks the ML-DSA-44 vote signatures:
#   1. both register vote keys and blocks continue
#   2. B's key file is wrong: B stops itself rather than vote; blocks stop
#   3. B's key restored and B restarted: blocks continue
#   4. B replaces its key (old one kept as .old): blocks never stop
#   5. replacing a key without the current key's signature is refused
#   bash test-vote-keys.sh <zetaphyd> [workdir]
set -euo pipefail
BIN=$1; W=${2:-$(mktemp -d)}; CHAIN=zetaphy-ve-1; D=azetaphy
trap 'for n in A B; do [ -f $W/$n/pid ] && kill $(cat $W/$n/pid) 2>/dev/null; done; true' EXIT
fail() { echo "FAIL: $*"; tail -5 $W/B/node.log; exit 1; }
seed() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
rm -rf $W; mkdir -p $W
for n in A B; do $BIN init $n --chain-id $CHAIN --home $W/$n >/dev/null 2>&1; done
$BIN keys add valA --keyring-backend test --home $W/A --algo eth_secp256k1 >/dev/null 2>&1
$BIN keys add valB --keyring-backend test --home $W/B --algo eth_secp256k1 >/dev/null 2>&1
G=$W/A/config/genesis.json
jq ".app_state.staking.params.bond_denom=\"$D\" | .app_state.evm.params.evm_denom=\"$D\" | .app_state.mint.params.mint_denom=\"$D\" | .app_state.gov.params.min_deposit[0].denom=\"$D\" | .app_state.gov.params.expedited_min_deposit[0].denom=\"$D\"
  | .app_state.bank.denom_metadata=[{description:\"ZETAPHY\",denom_units:[{denom:\"$D\",exponent:0},{denom:\"zetaphy\",exponent:18}],base:\"$D\",display:\"zetaphy\",name:\"ZETAPHY\",symbol:\"ZETAPHY\"}]
  | .consensus.params.abci.vote_extensions_enable_height=\"1\"" $G > $G.t && mv $G.t $G
for n in A B; do $BIN genesis add-genesis-account "$($BIN keys show val$n -a --keyring-backend test --home $W/$n)" "100000000000000000000000000$D" --home $W/A; done
cp $G $W/B/config/genesis.json
$BIN genesis gentx valA "6000000000000000000000000$D" --keyring-backend test --home $W/A --chain-id $CHAIN --gas-prices "1000000000$D" >/dev/null 2>&1
$BIN genesis gentx valB "4000000000000000000000000$D" --keyring-backend test --home $W/B --chain-id $CHAIN --gas-prices "1000000000$D" >/dev/null 2>&1
cp $W/B/config/gentx/*.json $W/A/config/gentx/
$BIN genesis collect-gentxs --home $W/A >/dev/null 2>&1
cp $G $W/B/config/genesis.json
P=28545
for n in A B; do
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
sed -i -E "s/^persistent_peers = .*/persistent_peers = \"$($BIN comet show-node-id --home $W/A)@127.0.0.1:28646\"/" $W/B/config/config.toml
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
