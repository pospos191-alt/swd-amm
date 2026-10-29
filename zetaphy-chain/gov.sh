#!/bin/bash
# ZETAPHY on-chain governance in one command (stage 2: "vote on upgrades").
# Run on the node as the node user. Every change to the chain goes through a
# public vote: a proposal needs a 1,000 ZETAPHY deposit, staked ZETAPHY votes,
# and the result runs automatically (an upgrade stops the chain at the agreed
# height so every validator switches binary at the same block).
#
#   gov.sh propose-upgrade <name> <height> "<summary>"   schedule a binary upgrade
#   gov.sh propose-text "<title>" "<summary>"            a signalling vote, no code change
#   gov.sh propose-file <proposal.json | https URL>      submit a prepared proposal (e.g. zetaphy-chain/proposals/*.json)
#   gov.sh propose-min-gas-price <gwei>                 chain-wide lowest gas price, e.g. 1 (0.000021 ZETAPHY a transfer)
#   gov.sh vote <id> yes|no|abstain|no_with_veto
#   gov.sh status [id]                                   one proposal, or all of them
#   gov.sh plan                                          the upgrade the chain is waiting for
#   gov.sh propose-ratelimit <denom> <channel> <send%> <recv%> <hours>
#                                                        cap IBC flow of a denom on a channel
#   gov.sh ratelimits                                    the IBC limits in force
#   gov.sh delegate <zetaphyvaloper1…> <ZETAPHY> [key]   stake from a fund (default community)
#   gov.sh validators                                    who validates, and their share
#   gov.sh quantum-lock <ML-DSA controller>              hand the FROM account to a PQ account, for good
#   gov.sh vote-key                                      register or replace this node's ML-DSA vote key
#   gov.sh pq-evidence on|off                            propose to stop (on) / resume (off) slashing on
#                                                        ed25519-only double-sign evidence for
#                                                        validators with an ML-DSA vote key
#   gov.sh neuro <action> [value] <NeuroControl 0x…>     a vote that steers Neuro (not the coin):
#     pause | unpause | approve-skill ID | revoke-skill ID | set-active-skill ID | approve-defender 0x…
#     remove-defender 0x… | release 0x… | set-max-bodies N | set-max-regrow N | set-community-fund 0x…
#     approve-chain KEY | remove-chain KEY   (chain keys NeuroJobs takes requests for, e.g. bsc)
#     set-challenge-bond ZETAPHY | set-challenge-window SECONDS | set-defender-timeout SECONDS
#   ---- security core (docs/SECURITY-CORE.md) ----
#   gov.sh security                                      Q-day, threat gate and IBC hold settings in force
#   gov.sh qday <height> [reveal-delay-blocks]           propose Q-day (0 = unschedule): ECDSA-signed txs refused from it
#   gov.sh threat-gate <ThreatRegistry 0x…> on|off       propose the threat gate (enforced flags need the sender's consent)
#   gov.sh ibc-hold <delay-seconds> [guardian]           propose the IBC large-transfer hold delay and guardian
#   gov.sh ibc-hold-rule <denom|*> <min-amount> <bps>    propose when an inbound transfer is held (0 0 removes the rule; "*": bps from min-amount up)
#   gov.sh ibc-holds                                     inbound transfers waiting
#   ---- v5 protocol research (docs/future/chain-protocol.md; all off until voted) ----
#   gov.sh ai-model <model.hex | ->                      propose the AI precompile's model (tools/gbdt-export.mjs; - removes it)
#   gov.sh immune '<json>'                               immune system settings, e.g. '{"enabled":true,"enforce_bps":9000,"hold_bps":8000}'
#   gov.sh breaker '<json>'                              watch a bridge (circuit breaker); "enabled":false stops watching it
#   gov.sh breaker-rearm <bridge 0x…>                    let a tripped breaker fire again (after governance unpaused the bridge)
#   gov.sh model-epochs <ModelEpochs 0x… | ->            propose the Neuro model registry the chain reads (ModelAt; - removes it)
#   gov.sh model-at <height>                             the Neuro model version in force at a height (state after height-1)
#   gov.sh ibc-hold-cancel <id>                          the guardian (FROM) returns a held transfer to its sender
#   gov.sh ibc-usdc-denom <channel>                      USDC from Noble via that channel: ibc/<hash>, ERC-20 0x…
#   gov.sh ibc-usdc-ratelimit <channel> [send%] [recv%] [hours]   cap USDC on it, or change the cap (default 1 1 24)
#   gov.sh ibc-usdc-erc20 <channel>                      USDC as an ERC-20 (MetaMask, explorer, DEX token lists)
#   gov.sh ibc-usdc-metadata <channel>                   its bank metadata (USDC, 6 decimals) for a genesis / upgrade
#   gov.sh erc20-register <0x…> [0x…]                    ERC-20 tokens made on ZETAPHY become coins (erc20/0x…) that IBC can carry
#                                                        (a vote, or a plain tx when registration is permissionless)
#   gov.sh ibc-send <channel> <ZETAPHY|0x…|denom> <amount> <receiver>
#                                                        send from FROM over IBC (amount in base units: 18 decimals for ZETAPHY);
#                                                        an ERC-20 is converted to its coin first
#   ---- CosmWasm (README.md, stage 7) ----
#   gov.sh wasm-store <file.wasm> "<title>" [everybody|nobody|zetaphy1…,zetaphy1…]
#                                                        propose storing contract code (who may instantiate it; default everybody)
#   gov.sh wasm-upload-access nobody|everybody|zetaphy1…,zetaphy1…   propose who may store code without a vote (default: nobody)
#   gov.sh wasm-codes                                    stored contract codes and the upload rule in force
#
# Env (defaults match setup-node.sh): NODE_HOME, KEYS_DIR, FROM (key name),
# ZETAPHYD, NODE (CometBFT RPC), CHAIN_ID, DEPOSIT (azetaphy).
set -euo pipefail
ZETAPHYD=${ZETAPHYD:-/usr/local/bin/zetaphyd}
NODE_HOME=${NODE_HOME:-$HOME/.zetaphy}
KEYS_DIR=${KEYS_DIR:-$HOME/.zetaphy-genesis-keys}
FROM=${FROM:-validator}
NODE=${NODE:-tcp://127.0.0.1:26657}
CHAIN_ID=${CHAIN_ID:-zetaphy_77390-1}
DEPOSIT=${DEPOSIT:-1000000000000000000000azetaphy}   # 1,000 ZETAPHY

# Flags go after the subcommand: zetaphyd rejects tx/query flags placed before it.
QF="--home $NODE_HOME --node $NODE -o json"
TXF="--home $NODE_HOME --node $NODE --keyring-backend test --keyring-dir $KEYS_DIR --from $FROM --chain-id $CHAIN_ID --gas auto --gas-adjustment 1.5 --gas-prices 1000000000azetaphy -y -o json"

# Runs a tx; prints the chain's error (not a silent exit) when it is refused.
send() {
  local out
  out=$("$ZETAPHYD" "$@" $TXF 2>&1) || { echo "rejected: $(echo "$out" | grep -m1 -E 'rpc error|Error' || echo "$out" | tail -1)"; exit 1; }
  out=$(echo "$out" | tail -1)
  [ "$(echo "$out" | jq -r .code 2>/dev/null)" = 0 ] || { echo "rejected: $(echo "$out" | jq -r .raw_log 2>/dev/null || echo "$out")"; exit 1; }
}

submit() { # the tx that submits the proposal, e.g.: tx gov submit-proposal <file>
  local before id=""
  before=$($ZETAPHYD q gov proposals $QF 2>/dev/null | jq -r '[.proposals[]?.id | tonumber] | max // 0')
  send "$@"
  # Wait for the block that includes it (blocks are ~5 s).
  for _ in $(seq 1 12); do
    sleep 2
    id=$($ZETAPHYD q gov proposals $QF 2>/dev/null | jq -r --argjson b "$before" '[.proposals[]?.id | tonumber | select(. > $b)] | max // empty')
    [ -n "$id" ] && break
  done
  [ -n "$id" ] || { echo "submitted, but no new proposal showed up yet: check with gov.sh status"; return; }
  echo "proposal $id submitted; vote with: gov.sh vote $id yes"
}

case "${1:-}" in
  propose-file)
    src=${2:?a proposal .json file or an https URL}; f=$(mktemp)
    if [[ "$src" =~ ^https:// ]]; then curl -fsSL "$src" -o "$f"; else cp "$src" "$f"; fi
    jq -e '.messages | type == "array"' "$f" >/dev/null || { echo "not a proposal file (no messages array)"; rm -f "$f"; exit 1; }
    echo "title: $(jq -r .title "$f")"
    jq -r '.messages[] | "  \(.["@type"]) -> \(.To // .authority // "")"' "$f"
    submit tx gov submit-proposal "$f"; rm -f "$f" ;;
  propose-min-gas-price)
    # The feemarket base fee falls to this floor when blocks are empty, so
    # wallets never quote 0 and spam still pays. Every validator enforces it
    # (app.toml minimum-gas-prices is per node). 0 removes the floor.
    g=${2:?gwei, e.g. 1}
    [[ "$g" =~ ^([0-9]{1,3})(\.([0-9]{1,9}))?$ ]] || { echo "gwei: a number from 0 to 999, up to 9 decimals (e.g. 1 or 0.5)"; exit 1; }
    f9=$(printf '%-9s' "${BASH_REMATCH[3]}" | tr ' ' 0)   # gwei decimals -> wei
    wei=$((10#${BASH_REMATCH[1]} * 1000000000 + 10#$f9))
    gov=$($ZETAPHYD q auth module-account gov $QF | jq -r '.account.value.address')
    params=$($ZETAPHYD q feemarket params $QF | jq -c '.params // .')
    echo "$params" | jq -e 'has("base_fee_change_denominator")' >/dev/null || { echo "could not read the feemarket params"; exit 1; }
    echo "now: min_gas_price $(echo "$params" | jq -r .min_gas_price) azetaphy, base_fee $(echo "$params" | jq -r .base_fee)"
    transfer=$(awk -v w="$wei" 'BEGIN { printf "%.9f", w * 21000 / 1e18 }')
    f=$(mktemp)
    jq -n --arg gov "$gov" --argjson p "$params" --arg m "$wei.000000000000000000" --arg d "$DEPOSIT" --arg g "$g" --arg t "$transfer" \
      '{messages:[{"@type":"/cosmos.evm.feemarket.v1.MsgUpdateParams",authority:$gov,params:($p + {min_gas_price:$m})}],
        metadata:"",deposit:$d,title:("Minimum gas price " + $g + " gwei"),
        summary:("The lowest gas price on ZETAPHY becomes " + $g + " gwei (a plain transfer costs " + $t + " ZETAPHY). Cheap for people, but spam still pays, and wallets never see a price of 0."),expedited:false}' > "$f"
    submit tx gov submit-proposal "$f"; rm -f "$f" ;;
  propose-upgrade)
    name=${2:?name}; height=${3:?height}; summary=${4:?summary}
    [[ "$name" =~ ^[a-z0-9.-]{1,40}$ ]] || { echo "name: lowercase letters, digits, . and - only"; exit 1; }
    [[ "$height" =~ ^[0-9]+$ ]] || { echo "height must be a block number"; exit 1; }
    now=$($ZETAPHYD --home "$NODE_HOME" --node "$NODE" status | jq -r '.sync_info.latest_block_height')
    [ "$height" -gt "$((now + 100))" ] || { echo "height must be well after the current block ($now) so the vote can finish"; exit 1; }
    gov=$($ZETAPHYD q auth module-account gov $QF | jq -r '.account.value.address')
    f=$(mktemp)
    jq -n --arg gov "$gov" --arg name "$name" --arg h "$height" --arg d "$DEPOSIT" --arg s "$summary" \
      '{messages:[{"@type":"/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade",authority:$gov,plan:{name:$name,height:$h,info:""}}],
        metadata:"",deposit:$d,title:("Upgrade to " + $name),summary:$s,expedited:false}' > "$f"
    submit tx gov submit-proposal "$f"; rm -f "$f" ;;
  propose-text)
    title=${2:?title}; summary=${3:?summary}
    f=$(mktemp)
    # A proposal with no messages must carry metadata (SDK rule).
    jq -n --arg d "$DEPOSIT" --arg t "$title" --arg s "$summary" '{messages:[],metadata:$t,deposit:$d,title:$t,summary:$s,expedited:false}' > "$f"
    submit tx gov submit-proposal "$f"; rm -f "$f" ;;
  vote)
    id=${2:?id}; opt=${3:?option}
    [[ "$opt" =~ ^(yes|no|abstain|no_with_veto)$ ]] || { echo "vote: yes, no, abstain or no_with_veto"; exit 1; }
    send tx gov vote "$id" "$opt"
    echo "voted $opt on proposal $id" ;;
  status)
    if [ -n "${2:-}" ]; then $ZETAPHYD q gov proposal "$2" $QF | jq '.proposal | {id, title, status, voting_end_time, final_tally_result}'
    else $ZETAPHYD q gov proposals $QF | jq -c '.proposals[] | {id, title, status}'; fi ;;
  plan)
    $ZETAPHYD q upgrade plan $QF 2>/dev/null || echo "no upgrade scheduled" ;;
  propose-ratelimit)
    # E.g. USDC from Noble: at most 10% of its supply on this chain may come
    # in or go out through channel-0 per 24 hours; a packet that would go
    # over is refused (the funds stay with the sender).
    denom=${2:?denom}; channel=${3:?channel}; send=${4:?send percent}; recv=${5:?recv percent}; hours=${6:?hours}
    [[ "$channel" =~ ^(channel-[0-9]+|[a-z0-9-]+-[0-9]+)$ ]] || { echo "channel: channel-N (or an IBC v2 client id)"; exit 1; }
    for n in "$send" "$recv"; do [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -le 100 ] || { echo "percent: 0 to 100"; exit 1; }; done
    [[ "$hours" =~ ^[1-9][0-9]*$ ]] || { echo "hours: a whole number above 0"; exit 1; }
    gov=$($ZETAPHYD q auth module-account gov $QF | jq -r '.account.value.address')
    f=$(mktemp)
    jq -n --arg gov "$gov" --arg dn "$denom" --arg ch "$channel" --arg s "$send" --arg r "$recv" --arg h "$hours" --arg d "$DEPOSIT" \
      '{messages:[{"@type":"/ratelimit.v1.MsgAddRateLimit",authority:$gov,denom:$dn,channel_or_client_id:$ch,
        max_percent_send:$s,max_percent_recv:$r,duration_hours:$h}],
        metadata:"",deposit:$d,title:("IBC rate limit: " + $dn + " on " + $ch),
        summary:("At most " + $s + "% out / " + $r + "% in of the supply of " + $dn + " through " + $ch + " every " + $h + " hours."),expedited:false}' > "$f"
    submit tx gov submit-proposal "$f"; rm -f "$f" ;;
  ratelimits)
    $ZETAPHYD q ratelimit list-rate-limits $QF ;;
  delegate)
    # Delegation program: the community fund stakes with new validators so
    # voting power does not stay with the first node.
    val=${2:?validator operator address}; amt=${3:?ZETAPHY}; key=${4:-community}
    [[ "$val" =~ ^zetaphyvaloper1[0-9a-z]{38}$ ]] || { echo "validator: zetaphyvaloper1… (gov.sh validators)"; exit 1; }
    [[ "$amt" =~ ^[1-9][0-9]*$ ]] || { echo "amount: whole ZETAPHY"; exit 1; }
    TXF=${TXF/--from $FROM/--from $key}
    send tx staking delegate "$val" "${amt}000000000000000000azetaphy"
    echo "delegated $amt ZETAPHY from $key to $val" ;;
  validators)
    $ZETAPHYD q staking validators $QF | jq -r '[.validators[] | select(.status=="BOND_STATUS_BONDED")] as $v
      | ($v | map(.tokens | tonumber) | add) as $t
      | $v[] | "\(.operator_address)  \(.description.moniker)  \((.tokens | tonumber) / $t * 100 | floor)%"' ;;
  pq-evidence)
    v=${2:?on or off}; [[ "$v" =~ ^(on|off)$ ]] || { echo "on or off"; exit 1; }
    submit tx pq-evidence-proposal "$v" --deposit "$DEPOSIT" ;;
  neuro)
    # The gov module calls NeuroControl as its owner: a MsgEVMCall whose
    # sender is the gov module (EVM address 0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2,
    # the first 20 bytes of sha256("gov")). The calldata is built here, so
    # the node needs no Node.js; ID is a skill id from `zetaphy neuro skill-id`.
    act=${2:?action}
    declare -A SEL=([pause]=8456cb59 [unpause]=3f4ba83a [approve-skill]=53c91c08 [revoke-skill]=615ef428
      [set-active-skill]=dcad4460 [approve-defender]=ccaa1df0 [remove-defender]=874d8a07 [release]=19165587
      [set-max-bodies]=3f1f3008 [set-max-regrow]=ecd0e17e [set-community-fund]=37339a16
      [approve-chain]=2c003714 [remove-chain]=2ccde4b6
      [set-challenge-bond]=18c281a6 [set-challenge-window]=01c1aa0d [set-defender-timeout]=d1d4a2e5)
    sel=${SEL[$act]:-}; [ -n "$sel" ] || { echo "neuro: unknown action $act"; exit 1; }
    case "$act" in
      pause|unpause) arg=""; ctl=${3:?NeuroControl 0x…}; word="" ;;
      *) val=${3:?value}; ctl=${4:?NeuroControl 0x…}
         case "$act" in
           *-skill) [[ "$val" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "skill id: 0x + 64 hex (zetaphy neuro skill-id)"; exit 1; }; word=${val#0x} ;;
           set-max-*|set-challenge-window|set-defender-timeout)
                    [[ "$val" =~ ^[1-9][0-9]{0,5}$ ]] || { echo "a whole number above 0"; exit 1; }; word=$(printf '%064x' "$val") ;;
           set-challenge-bond)
                    # ZETAPHY (up to 18 decimals) -> wei -> 32-byte hex, by long division (bash has 64-bit numbers only).
                    [[ "$val" =~ ^([0-9]{1,12})(\.([0-9]{1,18}))?$ ]] || { echo "an amount of ZETAPHY, e.g. 2.5"; exit 1; }
                    frac=${BASH_REMATCH[3]}; zeros=000000000000000000; n=${BASH_REMATCH[1]}${frac}${zeros:0:$((18 - ${#frac}))}
                    n=$(echo "$n" | sed 's/^0*//'); [ -n "$n" ] || { echo "an amount of ZETAPHY above 0"; exit 1; }
                    word=""
                    while [ -n "$n" ]; do
                      q=""; r=0
                      for ((i = 0; i < ${#n}; i++)); do d=$((r * 10 + ${n:i:1})); q+=$((d / 16)); r=$((d % 16)); done
                      word=$(printf '%x' "$r")$word; n=$(echo "$q" | sed 's/^0*//')
                    done
                    word=$(printf '%064s' "$word" | tr ' ' 0) ;;
           *-chain) [[ "$val" =~ ^[a-z0-9-]{1,31}$ ]] || { echo "chain key: 1-31 of a-z 0-9 - (e.g. bsc)"; exit 1; }
                    word=$(printf '%s' "$val" | od -An -tx1 | tr -d ' \n'); word=$word$(printf '%0*d' $((64 - ${#word})) 0) ;;
           *) [[ "$val" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "address: 0x + 40 hex"; exit 1; }; word=000000000000000000000000${val#0x} ;;
         esac
         arg=" $val" ;;
    esac
    [[ "$ctl" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "NeuroControl: 0x + 40 hex"; exit 1; }
    hex="$sel$word"
    data=$(printf "$(echo -n "$hex" | sed 's/../\\x&/g')" | base64 -w0)
    gov=$($ZETAPHYD q auth module-account gov $QF | jq -r '.account.value.address')
    f=$(mktemp)
    # MsgEVMCall's JSON uses its Go field names (Sender, To, Value, Data as base64, GasLimit).
    jq -n --arg gov "$gov" --arg to "$ctl" --arg data "$data" --arg d "$DEPOSIT" --arg t "Neuro: $act$arg" \
      '{messages:[{"@type":"/zetaphy.pq.v1.MsgEVMCall",Sender:$gov,To:$to,Value:"0",Data:$data,GasLimit:"300000"}],
        metadata:"",deposit:$d,title:$t,summary:("NeuroControl " + $to + ": " + $t + ". Steers Neuro only, never coin transfers."),expedited:false}' > "$f"
    submit tx gov submit-proposal "$f"; rm -f "$f" ;;
  quantum-lock)
    # Afterwards the FROM key is refused; the controller acts for the account
    # (zetaphy pq native ... --as <this account>).
    ctrl=${2:?controller: zetaphy1… or 0x… of an ML-DSA-44 account that has sent a tx}
    send tx quantum-lock "$ctrl"
    echo "$FROM is now controlled by $ctrl" ;;
  vote-key)
    # To replace the key: move pq_vote_key.seed to pq_vote_key.seed.old, put
    # the new seed in pq_vote_key.seed (64 hex characters), then run this.
    TXF=${TXF/--gas auto --gas-adjustment 1.5/--gas 600000}
    send tx pq-vote-key
    echo "vote key registered" ;;

  # ---- security core (docs/SECURITY-CORE.md) --------------------------------
  security)
    rpc=${EVM_RPC:-http://127.0.0.1:8545}
    curl -fsS "$rpc" -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"zetaphy_securityStatus","params":[]}' | jq .result ;;
  qday)
    h=${2:?height (0 = unschedule)}; d=${3:-}
    [[ "$h" =~ ^[0-9]+$ ]] || { echo "height: a block number"; exit 1; }
    if [ "$h" != 0 ]; then
      now=$($ZETAPHYD --home "$NODE_HOME" --node "$NODE" status | jq -r '.sync_info.latest_block_height')
      [ "$h" -gt "$((now + ${QDAY_MIN_NOTICE:-100}))" ] || { echo "Q-day must be well after the current block ($now): the vote must finish and people need time to migrate"; exit 1; }
    fi
    [ -z "$d" ] || [[ "$d" =~ ^[0-9]+$ ]] || { echo "reveal delay: a number of blocks"; exit 1; }
    submit tx security-proposal qday "$h" $d --deposit "$DEPOSIT" ;;
  threat-gate)
    reg=${2:?ThreatRegistry 0x…}; v=${3:?on or off}
    [[ "$reg" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "registry: 0x + 40 hex"; exit 1; }
    [[ "$v" =~ ^(on|off)$ ]] || { echo "on or off"; exit 1; }
    submit tx security-proposal threat-gate "$reg" "$v" --deposit "$DEPOSIT" ;;
  ibc-hold)
    d=${2:?delay in seconds, e.g. 21600 (6 h)}; g=${3:-}
    [[ "$d" =~ ^[0-9]+$ ]] || { echo "delay: seconds"; exit 1; }
    submit tx security-proposal ibc-hold "$d" $g --deposit "$DEPOSIT" ;;
  ibc-hold-rule)
    dn=${2:?denom (ibc/… or *)}; min=${3:?minimum amount in the base unit (0: none)}; bps=${4:?share of supply in basis points (0: none)}
    [[ "$min" =~ ^[0-9]+$ && "$bps" =~ ^[0-9]+$ ]] || { echo "min-amount and bps: whole numbers"; exit 1; }
    submit tx security-proposal ibc-hold-rule "$dn" "$min" "$bps" --deposit "$DEPOSIT" ;;
  ai-model)
    f=${2:?model hex file (node zetaphy-chain/tools/gbdt-export.mjs > model.hex), or - to remove}
    [ "$f" = - ] || [ -f "$f" ] || { echo "$f: no such file"; exit 1; }
    submit tx security-proposal ai-model "$f" --deposit "$DEPOSIT" ;;
  immune|breaker)
    j=${2:?settings as JSON}
    echo "$j" | jq -e . >/dev/null || { echo "settings: JSON"; exit 1; }
    submit tx security-proposal "$1" "$j" --deposit "$DEPOSIT" ;;
  breaker-rearm)
    b=${2:?bridge 0x…}; [[ "$b" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "bridge: 0x + 40 hex"; exit 1; }
    submit tx security-proposal breaker-rearm "$b" --deposit "$DEPOSIT" ;;
  model-epochs)
    r=${2:?ModelEpochs 0x… (zetaphy-network/contracts/ModelEpochs.sol), or - to remove it}
    [ "$r" = - ] || [[ "$r" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "registry: 0x + 40 hex, or -"; exit 1; }
    submit tx security-proposal model-epochs "$r" --deposit "$DEPOSIT" ;;
  model-at)
    h=${2:?height}; [[ "$h" =~ ^[0-9]+$ ]] || { echo "height: a block number"; exit 1; }
    $ZETAPHYD q neuro model-at "$h" $QF ;;
  ibc-holds)
    rpc=${EVM_RPC:-http://127.0.0.1:8545}
    curl -fsS "$rpc" -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"zetaphy_ibcHolds","params":[]}' | jq .result ;;
  ibc-hold-cancel)
    id=${2:?hold id (gov.sh ibc-holds)}; [[ "$id" =~ ^[0-9]+$ ]] || { echo "id: a number"; exit 1; }
    send tx ibc-hold-cancel "$id"
    echo "held transfer $id returned: the relayer carries the error acknowledgement back and the source chain refunds the sender" ;;

  # ---- ERC-20s made on ZETAPHY, and sending over IBC ------------------------
  erc20-register)
    shift; [ $# -ge 1 ] || { echo "usage: gov.sh erc20-register <0x…> [0x…]"; exit 1; }
    native=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee   # ZETAPHY itself (native precompile): a coin already
    todo=()
    for a in "$@"; do
      [[ "$a" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "not an ERC-20 address: $a"; exit 1; }
      [ "$(echo "$a" | tr 'A-F' 'a-f')" = "$native" ] && { echo "$a is ZETAPHY itself: already a coin (azetaphy)"; continue; }
      if $ZETAPHYD q erc20 token-pair "$a" $QF >/dev/null 2>&1; then echo "$a is registered already"; continue; fi
      todo+=("$a")
    done
    [ ${#todo[@]} -gt 0 ] || exit 0
    gov=$($ZETAPHYD q auth module-account gov $QF | jq -r '.account.value.address')
    params=$($ZETAPHYD q erc20 params $QF | jq -c .params)
    on=$(echo "$params" | jq -r '.enable_erc20 // false'); open=$(echo "$params" | jq -r '.permissionless_registration // false')
    if [ "$on" = true ] && [ "$open" = true ]; then
      send tx erc20 register-erc20 "${todo[@]}"
      echo "registered: ${todo[*]} (coins erc20/<address>)"; exit 0
    fi
    # Governance registers them (MsgRegisterERC20 signed by the gov module);
    # the ERC-20 module is switched on in the same proposal when it is off.
    f=$(mktemp)
    printf '%s\n' "${todo[@]}" | jq -R . | jq -s --arg gov "$gov" --argjson p "$params" --arg on "$on" --arg d "$DEPOSIT" \
      '. as $a | {messages:((if $on == "true" then [] else [{"@type":"/cosmos.evm.erc20.v1.MsgUpdateParams",authority:$gov,
          params:{enable_erc20:true,permissionless_registration:($p.permissionless_registration // false)}}] end)
        + [{"@type":"/cosmos.evm.erc20.v1.MsgRegisterERC20",signer:$gov,erc20addresses:$a}]),
        metadata:"",deposit:$d,title:("Register " + ($a | length | tostring) + " ERC-20 token(s) as coins"),
        summary:("So IBC can carry them: " + ($a | join(", ")) + ". Each becomes the coin erc20/<address>."),expedited:false}' > "$f"
    submit tx gov submit-proposal "$f"; rm -f "$f" ;;

  ibc-send)
    ch=${2:?channel on the ZETAPHY side, e.g. channel-1}; tok=${3:?ZETAPHY, an ERC-20 0x…, or a coin denom}
    amt=${4:?amount in base units}; to=${5:?receiver on the other chain, e.g. osmo1…}
    [[ "$ch" =~ ^channel-[0-9]+$ ]] || { echo "channel: channel-N"; exit 1; }
    [[ "$amt" =~ ^[1-9][0-9]{0,35}$ ]] || { echo "amount: a whole number of base units"; exit 1; }
    [[ "$to" =~ ^[a-z][a-z0-9]{0,19}1[02-9ac-hj-np-z]{20,90}$ || "$to" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "receiver: a bech32 address (e.g. osmo1…) or 0x…"; exit 1; }
    case "$tok" in
      ZETAPHY|zetaphy|azetaphy|0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE|0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee) denom=azetaphy ;;
      0x*)
        [[ "$tok" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "not an ERC-20 address: $tok"; exit 1; }
        pair=$($ZETAPHYD q erc20 token-pair "$tok" $QF 2>/dev/null | jq -c '.token_pair // empty' || true)
        [ -n "$pair" ] || { echo "$tok is not registered as a coin yet: gov.sh erc20-register $tok"; exit 1; }
        [ "$(echo "$pair" | jq -r '.enabled // false')" = true ] || { echo "$tok: its conversion is paused by governance"; exit 1; }
        denom=$(echo "$pair" | jq -r .denom)
        # An ERC-20 made on ZETAPHY travels as its coin: convert the amount first.
        [[ "$denom" == erc20/* ]] && { send tx erc20 convert-erc20 "$tok" "$amt"; echo "converted $amt of $tok to $denom"; } ;;
      *) [[ "$tok" =~ ^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$ ]] || { echo "not a coin denom: $tok"; exit 1; }; denom=$tok ;;
    esac
    send tx ibc-transfer transfer transfer "$ch" "$to" "${amt}${denom}"
    echo "sent $amt $denom through $ch to $to; the relayer carries it (a timeout refunds it here)" ;;

  # ---- IBC: USDC from Noble (zetaphy-chain/ibc/README.md) ------------------
  ibc-usdc-denom|ibc-usdc-ratelimit|ibc-usdc-erc20|ibc-usdc-metadata)
    ch=${2:?ZETAPHY side channel, e.g. channel-0 (ibc/setup-relayer.sh status)}
    [[ "$ch" =~ ^channel-[0-9]+$ ]] || { echo "channel: channel-N (the ZETAPHY side of the Noble channel)"; exit 1; }
    # ICS-20: Noble's uusdc arriving through transfer/<ch> becomes the coin
    # ibc/ + uppercase hex sha256("transfer/<ch>/uusdc"). Cosmos EVM v0.7.3
    # gives it the ERC-20 address made of the last 20 bytes of that hash
    # (utils.GetIBCDenomAddress), served by the ERC-20 precompile (STRv2).
    hash=$(printf 'transfer/%s/uusdc' "$ch" | sha256sum | awk '{print toupper($1)}')
    denom="ibc/$hash"; erc20="0x$(echo "${hash:24}" | tr 'A-F' 'a-f')"
    case "$1" in
      ibc-usdc-denom)
        echo "denom  $denom"; echo "erc20  $erc20" ;;
      ibc-usdc-metadata)
        # ibc-go writes metadata for a voucher only when the first one arrives
        # and none exists, and its default (symbol UUSDC, display "uusdc") makes
        # the ERC-20 report 0 decimals. This entry (for app_state.bank.denom_metadata
        # of a new chain, or an upgrade handler) gives USDC with 6 decimals.
        jq -n --arg dn "$denom" --arg ch "$ch" \
          '{description:("USDC from Noble (IBC transfer/" + $ch + "/uusdc)"),
            denom_units:[{denom:$dn,exponent:0,aliases:["uusdc"]},{denom:"usdc",exponent:6,aliases:[]}],
            base:$dn,display:"usdc",name:"USD Coin",symbol:"USDC",uri:"",uri_hash:""}' ;;
      ibc-usdc-ratelimit)
        # Low by default: 1% of the USDC on ZETAPHY in and 1% out per 24 hours.
        send=${3:-1}; recv=${4:-1}; hours=${5:-24}
        # x/ratelimit caps a share of the coin's supply here, so it refuses a
        # limit while there is none: bring a little USDC in first.
        supply=$($ZETAPHYD q bank total-supply-of "$denom" $QF | jq -r '.amount.amount // "0"')
        [ "$supply" != 0 ] || { echo "no USDC on ZETAPHY through $ch yet; a rate limit needs some first:"
          echo "  sudo bash setup-relayer.sh send-usdc <your 0x…> 1000000   (1 USDC)"; exit 1; }
        echo "USDC on ZETAPHY now: $supply uusdc; proposing at most $send% out / $recv% in every $hours h"
        has=$($ZETAPHYD q ratelimit list-rate-limits $QF 2>/dev/null | jq --arg dn "$denom" --arg ch "$ch" \
          '[.. | objects | select(.path? != null and .path.denom == $dn and .path.channel_or_client_id == $ch)] | length' || echo 0)
        [ "$has" = 0 ] && exec bash "$0" propose-ratelimit "$denom" "$ch" "$send" "$recv" "$hours"
        # A limit is already in force: change it (MsgUpdateRateLimit; its counters restart).
        for n in "$send" "$recv"; do [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -le 100 ] || { echo "percent: 0 to 100"; exit 1; }; done
        [[ "$hours" =~ ^[1-9][0-9]*$ ]] || { echo "hours: a whole number above 0"; exit 1; }
        gov=$($ZETAPHYD q auth module-account gov $QF | jq -r '.account.value.address')
        f=$(mktemp)
        jq -n --arg gov "$gov" --arg dn "$denom" --arg ch "$ch" --arg s "$send" --arg r "$recv" --arg h "$hours" --arg d "$DEPOSIT" \
          '{messages:[{"@type":"/ratelimit.v1.MsgUpdateRateLimit",authority:$gov,denom:$dn,channel_or_client_id:$ch,
            max_percent_send:$s,max_percent_recv:$r,duration_hours:$h}],
            metadata:"",deposit:$d,title:("IBC rate limit change: USDC on " + $ch),
            summary:("USDC from Noble (" + $dn + "): at most " + $s + "% out / " + $r + "% in through " + $ch + " every " + $h + " hours."),expedited:false}' > "$f"
        submit tx gov submit-proposal "$f"; rm -f "$f" ;;
      ibc-usdc-erc20)
        gov=$($ZETAPHYD q auth module-account gov $QF | jq -r '.account.value.address')
        params=$($ZETAPHYD q erc20 params $QF | jq -c .params)
        if [ "$(echo "$params" | jq -r '.enable_erc20 // false')" != true ]; then
          # The whole ERC-20 module is switched off: switch it on.
          f=$(mktemp)
          jq -n --arg gov "$gov" --argjson p "$params" --arg d "$DEPOSIT" \
            '{messages:[{"@type":"/cosmos.evm.erc20.v1.MsgUpdateParams",authority:$gov,
               params:{enable_erc20:true,permissionless_registration:($p.permissionless_registration // false)}}],
              metadata:"",deposit:$d,title:"Turn on ERC-20 conversion",summary:"So IBC coins such as USDC from Noble show up as ERC-20 tokens.",expedited:false}' > "$f"
          submit tx gov submit-proposal "$f"; rm -f "$f"
          echo "after it passes, run: gov.sh ibc-usdc-erc20 $ch"; exit 0
        fi
        # v0.7.3 has no proposal that registers a coin: the erc20 IBC
        # middleware registers each new ibc/ coin by itself (OnRecvPacket),
        # when the first one arrives. Governance can only pause or resume it.
        pair=$($ZETAPHYD q erc20 token-pair "$denom" $QF 2>/dev/null | jq -c '.token_pair // empty' || true)
        if [ -z "$pair" ]; then
          echo "USDC is not on ZETAPHY yet: the first USDC that arrives through $ch makes it an ERC-20 at"
          echo "  $erc20"
          echo "bring some in: sudo bash setup-relayer.sh send-usdc <your 0x…> 1000000   (1 USDC), then run this again"
          exit 1
        fi
        addr=$(echo "$pair" | jq -r .erc20_address)
        [ "$(echo "$addr" | tr 'A-F' 'a-f')" = "$erc20" ] || { echo "unexpected: the chain has $addr for $denom, not $erc20"; exit 1; }
        if [ "$(echo "$pair" | jq -r '.enabled // false')" != true ]; then
          f=$(mktemp)
          jq -n --arg gov "$gov" --arg dn "$denom" --arg d "$DEPOSIT" --arg a "$addr" \
            '{messages:[{"@type":"/cosmos.evm.erc20.v1.MsgToggleConversion",authority:$gov,token:$dn}],
              metadata:"",deposit:$d,title:"Resume USDC (Noble) as an ERC-20",summary:("Turns the ERC-20 " + $a + " of " + $dn + " back on."),expedited:false}' > "$f"
          submit tx gov submit-proposal "$f"; rm -f "$f"
          echo "the USDC ERC-20 is paused; after this passes it works again at $addr"; exit 0
        fi
        echo "USDC (from Noble via $ch) is the ERC-20 $addr"
        # decimals() comes from the coin's bank metadata (see ibc-usdc-metadata);
        # with none, the precompile reads 6 from the "u" of uusdc.
        meta=$($ZETAPHYD q bank denom-metadata "$denom" $QF 2>/dev/null || true)
        dec=6
        [ -n "$meta" ] && dec=$(echo "$meta" | jq -r '.metadata | (.display | split("/") | last) as $d
          | [.denom_units[] | select(.denom == $d) | .exponent // 0][0] // "?"' 2>/dev/null || echo "?")
        if [ "$dec" != 6 ]; then
          echo "WARNING: the chain reports $dec decimals for it (ibc-go's default metadata), so wallets"
          echo "  show amounts in uusdc. Fixing it needs a chain upgrade that sets: gov.sh ibc-usdc-metadata $ch"
        fi
        echo "MetaMask: Import tokens -> this address (symbol USDC, 6 decimals)."
        echo "Token list entry (explorer, wallet, DEX):"
        jq -n --arg a "$addr" --arg dn "$denom" --argjson c "${EVM_CHAIN_ID:-77390}" \
          '{chainId:$c,address:$a,name:"USD Coin (Noble)",symbol:"USDC",decimals:6,extensions:{cosmosDenom:$dn,origin:"noble uusdc"}}' ;;
    esac ;;
  # ---- CosmWasm ----------------------------------------------------------
  wasm-store)
    # Code upload is governance only on ZETAPHY: the code goes in a proposal
    # (MsgStoreCode from the gov module), gzipped (wasmd unpacks it; at most
    # 800 KiB unpacked). Its sha256 is in the title so voters can compare it
    # with the published build.
    file=${2:?contract .wasm file}; title=${3:?title}; who=${4:-everybody}
    [ -f "$file" ] || { echo "no such file: $file"; exit 1; }
    head -c4 "$file" | od -An -tx1 | tr -d ' \n' | grep -q '^0061736d' || gzip -t "$file" 2>/dev/null || { echo "not a wasm file: $file"; exit 1; }
    case "$who" in
      everybody) perm='{permission:"Everybody",addresses:[]}' ;;
      nobody)    perm='{permission:"Nobody",addresses:[]}' ;;
      *) [[ "$who" =~ ^zetaphy1[0-9a-z]{38,58}(,zetaphy1[0-9a-z]{38,58})*$ ]] || { echo "instantiate: everybody, nobody or zetaphy1…,zetaphy1…"; exit 1; }
         perm="{permission:\"AnyOfAddresses\",addresses:$(echo "$who" | jq -R -c 'split(",")')}" ;;
    esac
    sum=$( (gzip -dc "$file" 2>/dev/null || cat "$file") | sha256sum | cut -d' ' -f1)
    gov=$($ZETAPHYD q auth module-account gov $QF | jq -r '.account.value.address')
    z=$(mktemp); f=$(mktemp)
    (gzip -t "$file" 2>/dev/null && cat "$file" || gzip -9nc "$file") | base64 -w0 > "$z"
    jq -n --arg gov "$gov" --rawfile code "$z" --arg d "$DEPOSIT" --arg t "$title" --arg sum "$sum" --arg who "$who" \
      "{messages:[{\"@type\":\"/cosmwasm.wasm.v1.MsgStoreCode\",sender:\$gov,wasm_byte_code:\$code,instantiate_permission:$perm}],
        metadata:\"\",deposit:\$d,title:(\$t + \" (wasm sha256 \" + \$sum[0:16] + \"…)\"),
        summary:(\"Store CosmWasm code, sha256 \" + \$sum + \". Who may instantiate it: \" + \$who + \".\"),expedited:false}" > "$f"
    echo "code sha256 $sum"
    # Storing the proposal costs gas per byte of code; a tight margin keeps a
    # large contract under the 30,000,000 block gas limit.
    TXF=${TXF/--gas-adjustment 1.5/--gas-adjustment 1.1}
    submit tx gov submit-proposal "$f"; rm -f "$f" "$z" ;;
  wasm-upload-access)
    who=${2:?nobody, everybody or zetaphy1…,zetaphy1…}
    case "$who" in
      everybody) up='{permission:"Everybody",addresses:[]}' ;;
      nobody)    up='{permission:"Nobody",addresses:[]}' ;;
      *) [[ "$who" =~ ^zetaphy1[0-9a-z]{38,58}(,zetaphy1[0-9a-z]{38,58})*$ ]] || { echo "nobody, everybody or zetaphy1…,zetaphy1…"; exit 1; }
         up="{permission:\"AnyOfAddresses\",addresses:$(echo "$who" | jq -R -c 'split(",")')}" ;;
    esac
    gov=$($ZETAPHYD q auth module-account gov $QF | jq -r '.account.value.address')
    inst=$($ZETAPHYD q wasm params $QF | jq -r '(.params // .).instantiate_default_permission // "Everybody"')
    f=$(mktemp)
    jq -n --arg gov "$gov" --arg inst "$inst" --arg d "$DEPOSIT" --arg who "$who" \
      "{messages:[{\"@type\":\"/cosmwasm.wasm.v1.MsgUpdateParams\",authority:\$gov,params:{code_upload_access:$up,instantiate_default_permission:\$inst}}],
        metadata:\"\",deposit:\$d,title:(\"CosmWasm code upload: \" + \$who),
        summary:(\"Who may store contract code without a vote: \" + \$who + \". Governance can always store code by proposal.\"),expedited:false}" > "$f"
    submit tx gov submit-proposal "$f"; rm -f "$f" ;;
  wasm-codes)
    $ZETAPHYD q wasm params $QF | jq -c '.params // .'
    $ZETAPHYD q wasm list-code $QF | jq -c '.code_infos[]? | {code_id, creator, data_hash, instantiate_permission}' ;;

  *)
    sed -n '8,58p' "$0" | sed 's/^# //'; exit 2 ;;
esac
