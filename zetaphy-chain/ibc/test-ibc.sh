#!/bin/bash
# The Noble kit, end to end, without Noble: two ZETAPHY devnets side by side.
#   A = zetaphy_77390-1  (ZETAPHY, as on the testnet)
#   B = zetaphy_77391-1  (stands in for Noble: its accounts hold "uusdc")
# setup-relayer.sh installs the pinned Hermes, makes its keys and config and
# opens the channel exactly as on the node (only the "Noble" endpoints point at
# B); gov.sh's ibc-usdc-* commands run against A. It checks:
#   1. the voucher denom ibc/<sha256("transfer/channel-0/uusdc")> and its
#      ERC-20 address, against the chain;
#   2. USDC sent B -> A arrives, becomes an ERC-20 by itself, and eth_call
#      balanceOf / symbol / decimals read it; a paused ERC-20 is resumed by
#      the MsgToggleConversion proposal ibc-usdc-erc20 makes. A has ibc-go's
#      default metadata (as the running testnet will: 0 decimals, and gov.sh
#      warns); B has `gov.sh ibc-usdc-metadata` in its genesis, and USDC sent
#      A -> B reads as symbol USDC, 6 decimals there (the fix for a new chain);
#   3. ibc-usdc-ratelimit (1% / 1% / 24 h) passes a vote, then a transfer over
#      the cap is refused in both directions (inbound: refunded on B;
#      outbound: the tx fails) and one under the cap goes through; re-running
#      it with 50% changes the limit by vote (MsgUpdateRateLimit);
#   2b. ZETAPHY Saphan: native ZETAPHY sent A -> B through the ICS-20 precompile
#      from an EVM account, with the hub's calldata (zetaphy-hub/chainlib.js);
#   4. the large-transfer hold (security core): gov.sh ibc-hold / ibc-hold-rule
#      pass votes; an inbound transfer over the threshold waits (nothing
#      delivered, zetaphy_ibcHolds lists it) and arrives after the delay; another
#      is returned by the guardian (gov.sh ibc-hold-cancel) and refunded on B.
#
#   ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock bash zetaphy-chain/ibc/test-ibc.sh
# Env: PORT_A / PORT_B (EVM JSON-RPC ports, default 27545 / 28545; CometBFT is
# +100, gRPC +102), HERMES_TARBALL (the pinned release .tar.gz, else it is
# downloaded; with no network the test SKIPS, exit 0), KEEP=1 keeps the temp dir.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
BIN=${ZETAPHYD:?set ZETAPHYD to a zetaphyd binary}
PA=${PORT_A:-27545}; PB=${PORT_B:-28545}
CA=zetaphy_77390-1; CB=zetaphy_77391-1
W=$(mktemp -d "${TMPDIR:-/tmp}/zetaphy-ibc-XXXXXX")
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
GP=1000000000azetaphy
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; exit 1; }

cleanup() {
  local code=$?
  [ -f "$W/hermes/hermes.pid" ] && kill "$(cat "$W/hermes/hermes.pid")" 2>/dev/null || true
  for n in a b; do [ -f "$W/$n/node.pid" ] && kill "$(cat "$W/$n/node.pid")" 2>/dev/null || true; done
  sleep 1
  if [ "$code" != 0 ]; then
    echo "--- hermes log (tail)"; tail -n 30 "$W/hermes/hermes.log" 2>/dev/null || true
  fi
  if [ -n "${KEEP:-}" ] || [ "$code" != 0 ]; then echo "kept $W"; else rm -rf "$W"; fi
}
trap cleanup EXIT

# ---- Hermes: the pinned release (setup-relayer.sh checks its SHA-256) ------
arch=$(uname -m)
if [ -z "${HERMES_TARBALL:-}" ]; then
  HERMES_TARBALL="$W/hermes.tar.gz"
  url="https://github.com/informalsystems/hermes/releases/download/v1.13.3/hermes-v1.13.3-$arch-unknown-linux-gnu.tar.gz"
  if ! curl -fsSL --retry 2 -m 600 -o "$HERMES_TARBALL" "$url"; then
    echo "SKIP: cannot download Hermes ($url); the hash and proposal parts are covered by"
    echo "      zetaphy-network/test/ibc.test.js. Set HERMES_TARBALL to a downloaded copy to run this."
    exit 0
  fi
fi

# ---- two devnets; "user" holds ZETAPHY on both and 1,000,000 USDC on B ----
UK="--keyring-backend test --keyring-dir $W/user"
"$BIN" keys add user $UK --algo eth_secp256k1 --home "$W/user" >/dev/null 2>&1
user=$("$BIN" keys show user -a $UK --home "$W/user")
userhex=$("$BIN" debug addr "$user" --home "$W/user" | awk '/Address hex/ {print $3}')
meta=$(bash "$REPO/zetaphy-chain/gov.sh" ibc-usdc-metadata channel-0 | jq -c .)
# A has the ICS-20 precompile (0x…0802) on, as setup-node.sh's genesis does (ZETAPHY Saphan sends through it)
COSMOS_CHAIN_ID=$CA EVM_CHAIN_ID=77390 ZETAPHYD="$BIN" EXTRA_COINS=1000000000000uusdc \
  GENESIS_JQ='.app_state.evm.params.active_static_precompiles = ((.app_state.evm.params.active_static_precompiles // []) + ["0x0000000000000000000000000000000000000802"] | unique)' \
  bash "$REPO/zetaphy-network/scripts/devnet.sh" "$W/a" "$PA" "$userhex"
COSMOS_CHAIN_ID=$CB EVM_CHAIN_ID=77391 ZETAPHYD="$BIN" EXTRA_COINS=1000000000000uusdc \
  GENESIS_JQ=".app_state.bank.denom_metadata += [$meta]" bash "$REPO/zetaphy-network/scripts/devnet.sh" "$W/b" "$PB" "$userhex"
NA=tcp://127.0.0.1:$((PA + 100)); NB=tcp://127.0.0.1:$((PB + 100))

q() { local node=$1; shift; "$BIN" q "$@" --node "$node" -o json; }
bal() { q "$1" bank balance "$2" "$3" | jq -r '.balance.amount // "0"'; }
# A signed tx from "user" (or $FROM_KEY in $FROM_DIR); waits for its block; prints its result.
tx() {
  local node=$1 chain=$2; shift 2
  local out hash res
  out=$("$BIN" tx "$@" --from "${FROM_KEY:-user}" --keyring-backend test --keyring-dir "${FROM_DIR:-$W/user}" \
    --home "$W/user" --node "$node" --chain-id "$chain" --gas 400000 --gas-prices $GP -y -o json 2>&1 | tail -1)
  hash=$(echo "$out" | jq -r '.txhash // empty' 2>/dev/null)
  [ -n "$hash" ] && [ "$(echo "$out" | jq -r .code)" = 0 ] || { echo "$out"; return 0; }
  for _ in $(seq 1 20); do
    sleep 1
    res=$(q "$node" tx "$hash" 2>/dev/null) && { echo "$res" | jq -c '{code, raw_log}'; return 0; }
  done
  echo '{"code":-1,"raw_log":"not included"}'
}
waitfor() { # $1 seconds, $2.. a command whose output must equal the last argument
  local t=$1; shift; local want=${*: -1}; local cmd=("${@:1:$#-1}") got=""
  for _ in $(seq 1 "$t"); do got=$("${cmd[@]}" 2>/dev/null || true); [ "$got" = "$want" ] && return 0; sleep 1; done
  echo "waited ${t}s for $want, last: $got"; return 1
}

# ---- the relayer, set up as on the node ------------------------------------
export AS_SELF=1 NO_SYSTEMD=1 ZETAPHYD="$BIN" HERMES_TARBALL
export HERMES_HOME="$W/hermes" HERMES_BIN="$W/bin/hermes"
export ZETAPHY_CHAIN_ID=$CA ZETAPHY_RPC=http://127.0.0.1:$((PA + 100)) ZETAPHY_GRPC=http://127.0.0.1:$((PA + 102))
export NOBLE_CHAIN_ID=$CB NOBLE_RPC=http://127.0.0.1:$((PB + 100)) NOBLE_WS=ws://127.0.0.1:$((PB + 100))/websocket \
  NOBLE_GRPC=http://127.0.0.1:$((PB + 102)) NOBLE_PREFIX=zetaphy NOBLE_FEE_DENOM=azetaphy NOBLE_GAS_PRICE=2000000000 \
  NOBLE_KEY_TYPE=ethermint NOBLE_HD_PATH="m/44'/60'/0'/0/0"
mkdir -p "$W/bin"
R() { bash "$HERE/setup-relayer.sh" "$@"; }
out=$(R) || { echo "$out"; fail "setup-relayer.sh setup"; }
echo "$out" | grep -qiE 'mnemonic|seed phrase|private' && fail "setup printed something secret"
ra=$(echo "$out" | awk -v c="$CA" '$1 == "ZETAPHY" {print $3}'); rb=$(echo "$out" | awk '$1 == "Noble" {print $3}')
[[ "$ra" =~ ^zetaphy1 && "$rb" =~ ^zetaphy1 ]] || { echo "$out"; fail "relayer addresses"; }
grep -q "1.13.2+bab3b80" <("$HERMES_BIN" version 2>/dev/null) || fail "pinned Hermes not installed"
pass "Hermes v1.13.3 installed (SHA-256 checked), relayer keys made; addresses $ra / $rb"
# The Hermes key is the same account the chain derives (eth_secp256k1, m/44'/60').
[ "$(R addresses | grep -oE '0x[0-9a-fA-F]{40}' | head -1 | tr A-F a-f)" = "$("$BIN" debug addr "$ra" | awk '/Address hex/ {print $3}' | tr A-F a-f)" ] \
  || fail "0x address of the relayer"
out2=$(R) || fail "setup-relayer.sh re-run"
[ "$(echo "$out2" | awk '$1 == "ZETAPHY" {print $3}')" = "$ra" ] || fail "re-run changed the relayer key"
pass "setup-relayer.sh is idempotent (same keys on re-run)"

# Gas for the relayer on both chains, and USDC on B for send-usdc.
tx "$NA" $CA bank send user "$ra" 10000000000000000000azetaphy >/dev/null
tx "$NB" $CB bank send user "$rb" 10000000000000000000azetaphy,200000000uusdc >/dev/null
waitfor 10 bal "$NB" "$rb" uusdc 200000000

out=$(R create-channel) || { echo "$out"; fail "create-channel"; }
grep -q '^ZETAPHY_CHANNEL=channel-0$' "$HERMES_HOME/channel.env" && grep -q '^NOBLE_CHANNEL=channel-0$' "$HERMES_HOME/channel.env" \
  || { echo "$out"; fail "channel ids"; }
grep -q "list = \[\['transfer', 'channel-0'\]\]" "$HERMES_HOME/config.toml" || fail "packet filter for the channel"
out=$(R create-channel); echo "$out" | grep -q 'already open' || { echo "$out"; fail "create-channel re-run"; }
pass "clients, connection and transfer channel-0 <-> channel-0 open (re-run: no new channel)"
R start >/dev/null

# ---- gov.sh against chain A ------------------------------------------------
G() { ZETAPHYD="$BIN" NODE_HOME="$W/a" KEYS_DIR="$W/a" FROM=validator NODE=$NA CHAIN_ID=$CA EVM_RPC=http://127.0.0.1:$PA bash "$REPO/zetaphy-chain/gov.sh" "$@"; }
pstatus() { G status "$1" | jq -r .status; }
vote_pass() { # $1: output of a gov.sh command that submitted a proposal -> vote yes -> wait for PASSED
  local id; id=$(echo "$1" | sed -n 's/^proposal \([0-9]*\) submitted.*/\1/p')
  [ -n "$id" ] || { echo "$1"; fail "no proposal id"; }
  G vote "$id" yes >/dev/null
  waitfor 60 pstatus "$id" PROPOSAL_STATUS_PASSED || { G status "$id"; fail "proposal $id did not pass"; }
}

denom=$(G ibc-usdc-denom channel-0 | awk '$1 == "denom" {print $2}')
erc20=$(G ibc-usdc-denom channel-0 | awk '$1 == "erc20" {print $2}')

# Before any USDC: both commands explain instead of proposing.
out=$(G ibc-usdc-ratelimit channel-0 2>&1 || true); echo "$out" | grep -q 'no USDC on ZETAPHY' || { echo "$out"; fail "ratelimit without supply"; }
out=$(G ibc-usdc-erc20 channel-0 2>&1 || true); echo "$out" | grep -q "$erc20" || { echo "$out"; fail "erc20 before USDC arrives"; }
pass "with no USDC yet: ratelimit and erc20 refuse and say what to do"

# ---- USDC B -> A; ERC-20 -----------------------------------------------------
R send-usdc "$userhex" 100000000 >/dev/null || fail "send-usdc"
waitfor 90 bal "$NA" "$user" "$denom" 100000000 || fail "100 USDC did not arrive on A"
pass "100 USDC relayed B -> A (send-usdc to a 0x address)"
# The chain knows the denom once one has arrived: same hash as gov.sh computed.
chain_hash=$(q "$NA" ibc-transfer denom-hash transfer/channel-0/uusdc | jq -r .hash)
[ "$denom" = "ibc/$chain_hash" ] || fail "denom $denom != chain ibc/$chain_hash"
pass "voucher denom $denom = chain's denom-hash of transfer/channel-0/uusdc"

pair=$(q "$NA" erc20 token-pair "$denom" | jq -c .token_pair)
[ "$(echo "$pair" | jq -r .erc20_address | tr A-F a-f)" = "$erc20" ] || fail "token pair $pair"
call() { # $1 4-byte selector + args hex -> result hex (on A, or on the EVM port $CALL_PORT)
  curl -s -X POST -H 'content-type: application/json' "http://127.0.0.1:${CALL_PORT:-$PA}" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$erc20\",\"data\":\"0x$1\"},\"latest\"]}" | jq -r .result
}
balhex=$(call "70a08231000000000000000000000000${userhex#0x}")
[ "$((16#${balhex#0x}))" = 100000000 ] || fail "balanceOf = $balhex"
# ibc-go's default metadata: symbol UUSDC, 0 decimals; gov.sh says so.
[ "$((16#$(call 313ce567 | sed 's/^0x//')))" = 0 ] || fail "decimals with default metadata"
sym=$(call 95d89b41); echo "${sym#0x}" | tail -c 65 | grep -q '^5555534443' || fail "symbol $sym"   # "UUSDC"
out=$(G ibc-usdc-erc20 channel-0) || { echo "$out"; fail "ibc-usdc-erc20"; }
echo "$out" | grep -qi "is the ERC-20 $(echo "$pair" | jq -r .erc20_address)" || { echo "$out"; fail "ibc-usdc-erc20 output"; }
echo "$out" | grep -q "WARNING: the chain reports 0 decimals" || { echo "$out"; fail "no decimals warning"; }
echo "$out" | sed -n '/^{/,$p' | jq -e '.symbol == "USDC" and .decimals == 6 and .chainId == 77390' >/dev/null || fail "token list entry"
pass "voucher is ERC-20 $erc20: eth_call balanceOf = 100000000; default metadata gives decimals 0 / UUSDC and gov.sh warns; token-list entry printed"

# With the metadata in genesis (chain B): USDC A -> B reads as USDC, 6 decimals.
res=$(tx "$NA" $CA ibc-transfer transfer transfer channel-0 "$user" 5000000uusdc)
[ "$(echo "$res" | jq -r .code)" = 0 ] || { echo "$res"; fail "send uusdc A -> B"; }
waitfor 90 bal "$NB" "$user" "$denom" 5000000 || fail "5 USDC did not arrive on B"
[ "$((16#$(CALL_PORT=$PB call 313ce567 | sed 's/^0x//')))" = 6 ] || fail "decimals with genesis metadata"
sym=$(CALL_PORT=$PB call 95d89b41); echo "${sym#0x}" | tail -c 65 | grep -q '^55534443000' || fail "symbol $sym"   # "USDC"
balhex=$(CALL_PORT=$PB call "70a08231000000000000000000000000${userhex#0x}")
[ "$((16#${balhex#0x}))" = 5000000 ] || fail "balanceOf on B = $balhex"
out=$(ZETAPHYD="$BIN" NODE_HOME="$W/b" KEYS_DIR="$W/b" FROM=validator NODE=$NB CHAIN_ID=$CB EVM_CHAIN_ID=77391 \
  bash "$REPO/zetaphy-chain/gov.sh" ibc-usdc-erc20 channel-0) || { echo "$out"; fail "ibc-usdc-erc20 on B"; }
echo "$out" | grep -q WARNING && { echo "$out"; fail "warning despite metadata"; }
pass "with gov.sh ibc-usdc-metadata in genesis: same ERC-20 address reads symbol USDC, decimals 6, balanceOf 5000000"

# ---- ZETAPHY Saphan: out through the ICS-20 precompile (0x…0802) from an EVM account ----
# The same calldata the hub's Saphan tab asks MetaMask to send (zetaphy-hub/chainlib.js).
key=$("$BIN" keys unsafe-export-eth-key user --keyring-backend test --keyring-dir "$W/user" --home "$W/user" 2>/dev/null)
zd="ibc/$(printf 'transfer/channel-0/azetaphy' | sha256sum | cut -c1-64 | tr a-f A-F)"
zb=$(bal "$NB" "$user" "$zd")
hash=$(cd "$REPO/zetaphy-network" && KEY="0x${key#0x}" RPC="http://127.0.0.1:$PA" TO="$user" HUB="$REPO/zetaphy-hub/chainlib.js" node --input-type=module -e '
import { JsonRpcProvider, Wallet } from "ethers";
const { encodeIbcTransfer, PRECOMPILES } = await import(process.env.HUB);
const w = new Wallet(process.env.KEY, new JsonRpcProvider(process.env.RPC));
const data = encodeIbcTransfer({ channel: "channel-0", denom: "azetaphy", amount: 3n * 10n ** 18n, sender: w.address,
  receiver: process.env.TO, timeoutNs: BigInt(Date.now() + 600000) * 1000000n, memo: "ZETAPHY Saphan" });
const tx = await w.sendTransaction({ to: PRECOMPILES.ics20, data, gasLimit: 600000n });
const r = await tx.wait();
if (r.status !== 1) throw new Error(`reverted: ${tx.hash}`);
const { sentIbcTransfer } = await import(process.env.HUB);
if (!sentIbcTransfer({ logs: r.logs.map((l) => ({ address: l.address, topics: l.topics })) })) throw new Error(`no IBCTransfer event: ${tx.hash}`);
console.log(tx.hash);') || fail "ICS-20 precompile transfer"
unset key
waitfor 90 bal "$NB" "$user" "$zd" "$(python3 -c "print($zb + 3 * 10**18)")" || fail "3 ZETAPHY sent through the precompile did not reach B"
pass "ZETAPHY Saphan: 3 ZETAPHY A -> B through the ICS-20 precompile from an EVM account (tx $hash), arrived as $zd"

# Pause it by vote (MsgToggleConversion), then ibc-usdc-erc20 proposes the resume.
gov=$(q "$NA" auth module-account gov | jq -r .account.value.address)
jq -n --arg gov "$gov" --arg dn "$denom" '{messages:[{"@type":"/cosmos.evm.erc20.v1.MsgToggleConversion",authority:$gov,token:$dn}],
  metadata:"",deposit:"1000000000000000000000azetaphy",title:"pause USDC ERC-20",summary:"test",expedited:false}' > "$W/pause.json"
last=$(q "$NA" gov proposals | jq -r '[.proposals[]?.id | tonumber] | max // 0')
FROM_KEY=validator FROM_DIR="$W/a" tx "$NA" $CA gov submit-proposal "$W/pause.json" >/dev/null
out="proposal $((last + 1)) submitted"
vote_pass "$out"
[ "$(q "$NA" erc20 token-pair "$denom" | jq -r .token_pair.enabled)" = false ] || fail "pause"
out=$(G ibc-usdc-erc20 channel-0) || { echo "$out"; fail "ibc-usdc-erc20 (paused)"; }
vote_pass "$out"
[ "$(q "$NA" erc20 token-pair "$denom" | jq -r .token_pair.enabled)" = true ] || fail "resume"
pass "paused USDC ERC-20 resumed through ibc-usdc-erc20's MsgToggleConversion proposal"

# ---- rate limit ------------------------------------------------------------------
out=$(G ibc-usdc-ratelimit channel-0) || { echo "$out"; fail "ibc-usdc-ratelimit"; }
vote_pass "$out"
rl=$(q "$NA" ratelimit rate-limit channel-0 --denom "$denom" 2>/dev/null || G ratelimits)
echo "$rl" | grep -q '"max_percent_send": *"1"' || echo "$rl" | jq -e '.. | objects | select(.max_percent_send? == "1" and .max_percent_recv? == "1" and .duration_hours? == "24")' >/dev/null \
  || { echo "$rl"; fail "rate limit not in force"; }
pass "ibc-usdc-ratelimit: 1% send / 1% recv / 24 h on $denom, voted in"

# In: 2 USDC (2% of 100) is refused on A and refunded to the sender on B.
before=$(bal "$NB" "$rb" uusdc)
R send-usdc "$userhex" 2000000 >/dev/null || fail "send-usdc 2"
[ "$(bal "$NB" "$rb" uusdc)" = "$((before - 2000000))" ] || fail "2 USDC not escrowed on B"
waitfor 90 bal "$NB" "$rb" uusdc "$before" || fail "over-cap inbound transfer not refunded on B"
[ "$(bal "$NA" "$user" "$denom")" = 100000000 ] || fail "over-cap inbound transfer arrived on A"
pass "inbound over the cap (2 USDC > 1%): refused on A, refunded on B"
R send-usdc "$userhex" 500000 >/dev/null || fail "send-usdc 0.5"
waitfor 90 bal "$NA" "$user" "$denom" 100500000 || fail "under-cap inbound transfer"
pass "inbound under the cap (0.5 USDC) arrives"

# Out: 2 USDC from A is refused when sent; 0.5 USDC goes through (back to uusdc on B).
ub=$(bal "$NB" "$user" uusdc)
res=$(tx "$NA" $CA ibc-transfer transfer transfer channel-0 "$user" "2000000$denom")
[ "$(echo "$res" | jq -r .code)" != 0 ] && echo "$res" | grep -qi 'quota' || { echo "$res"; fail "over-cap outbound transfer was not refused"; }
[ "$(bal "$NA" "$user" "$denom")" = 100500000 ] || fail "over-cap outbound moved funds"
pass "outbound over the cap (2 USDC): tx refused ($(echo "$res" | jq -r .raw_log | grep -oiE 'quota[^:]*' | head -1))"
res=$(tx "$NA" $CA ibc-transfer transfer transfer channel-0 "$user" "500000$denom")
[ "$(echo "$res" | jq -r .code)" = 0 ] || { echo "$res"; fail "under-cap outbound transfer"; }
waitfor 90 bal "$NB" "$user" uusdc "$((ub + 500000))" || fail "0.5 USDC did not reach B"
pass "outbound under the cap (0.5 USDC) arrives on B as uusdc"

# Re-running ibc-usdc-ratelimit changes the limit in force (MsgUpdateRateLimit).
out=$(G ibc-usdc-ratelimit channel-0 50 50 24) || { echo "$out"; fail "ibc-usdc-ratelimit update"; }
vote_pass "$out"
G ratelimits | jq -e --arg dn "$denom" '.. | objects | select(.path?.denom == $dn) | .quota.max_percent_send == "50"' >/dev/null \
  || { G ratelimits; fail "limit not raised"; }
ub=$(bal "$NB" "$user" uusdc)
res=$(tx "$NA" $CA ibc-transfer transfer transfer channel-0 "$user" "2000000$denom")
[ "$(echo "$res" | jq -r .code)" = 0 ] || { echo "$res"; fail "2 USDC out after raising the limit"; }
waitfor 90 bal "$NB" "$user" uusdc "$((ub + 2000000))" || fail "2 USDC did not reach B"
pass "re-run with 50%: limit changed by vote (MsgUpdateRateLimit); the 2 USDC refused before now goes out"

# ---- large-transfer hold (security core, docs/SECURITY-CORE.md) ------------------
# Inbound USDC from 10 USDC up waits 60 s; the guardian is A's validator key.
valaddr=$("$BIN" keys show validator -a --keyring-backend test --keyring-dir "$W/a" --home "$W/a")
out=$(G ibc-hold 60 "$valaddr") || { echo "$out"; fail "ibc-hold proposal"; }
vote_pass "$out"
out=$(G ibc-hold-rule "$denom" 10000000 0) || { echo "$out"; fail "ibc-hold-rule proposal"; }
vote_pass "$out"
G security | jq -e --arg dn "$denom" --arg g "$valaddr" '.ibcHoldDelaySeconds == 60 and .ibcHoldGuardian == $g and (.ibcHoldRules[] | select(.denom == $dn) | .minAmount == "10000000")' >/dev/null \
  || { G security; fail "hold settings not in force"; }
pass "ibc-hold (60 s, guardian = validator) and ibc-hold-rule ($denom from 10 USDC) voted in"
nholds() { G ibc-holds | jq length; }
a0=$(bal "$NA" "$user" "$denom")
R send-usdc "$userhex" 20000000 >/dev/null || fail "send-usdc 20"
waitfor 90 nholds 1 || fail "20 USDC was not held"
[ "$(bal "$NA" "$user" "$denom")" = "$a0" ] || fail "a held transfer was delivered at once"
waitfor 240 bal "$NA" "$user" "$denom" "$((a0 + 20000000))" || fail "held transfer not delivered after the delay"
waitfor 30 nholds 0 || fail "released hold still listed"
pass "inbound 20 USDC (over 10): held, listed by zetaphy_ibcHolds, delivered after the 60 s delay"
before=$(bal "$NB" "$rb" uusdc)
R send-usdc "$userhex" 30000000 >/dev/null || fail "send-usdc 30"
waitfor 90 nholds 1 || fail "30 USDC was not held"
id=$(G ibc-holds | jq -r '.[0].id')
out=$(G ibc-hold-cancel "$id") || { echo "$out"; fail "ibc-hold-cancel"; }
waitfor 240 bal "$NB" "$rb" uusdc "$before" || fail "returned transfer not refunded on B"
[ "$(bal "$NA" "$user" "$denom")" = "$((a0 + 20000000))" ] || fail "a returned transfer reached A"
pass "inbound 30 USDC held, returned by the guardian (ibc-hold-cancel $id): refunded on B, nothing on A"

echo "--- setup-relayer.sh status"; R status | sed 's/^/    /'
out=$(R balances) && echo "$out" | grep -q azetaphy && echo "$out" | grep -q uusdc || { echo "$out"; fail "balances"; }
R stop >/dev/null
pass "status, balances, stop"
echo "ALL PASS"
