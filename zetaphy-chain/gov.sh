#!/bin/bash
# ZETAPHY on-chain governance in one command (stage 2: "vote on upgrades").
# Run on the node as the node user. Every change to the chain goes through a
# public vote: a proposal needs a 1,000 ZETAPHY deposit, staked ZETAPHY votes,
# and the result runs automatically (an upgrade stops the chain at the agreed
# height so every validator switches binary at the same block).
#
#   gov.sh propose-upgrade <name> <height> "<summary>"   schedule a binary upgrade
#   gov.sh propose-text "<title>" "<summary>"            a signalling vote, no code change
#   gov.sh vote <id> yes|no|abstain|no_with_veto
#   gov.sh status [id]                                   one proposal, or all of them
#   gov.sh plan                                          the upgrade the chain is waiting for
#   gov.sh propose-ratelimit <denom> <channel> <send%> <recv%> <hours>
#                                                        cap IBC flow of a denom on a channel
#   gov.sh ratelimits                                    the IBC limits in force
#   gov.sh delegate <zetaphyvaloper1…> <ZETAPHY> [key]   stake from a fund (default community)
#   gov.sh validators                                    who validates, and their share
#
# Env (defaults match setup-node.sh): NODE_HOME, KEYS_DIR, FROM (key name),
# ZETAPHYD, NODE (CometBFT RPC), CHAIN_ID, DEPOSIT (azetaphy).
set -euo pipefail
ZETAPHYD=${ZETAPHYD:-/usr/local/bin/zetaphyd}
NODE_HOME=${NODE_HOME:-$HOME/.zetaphy}
KEYS_DIR=${KEYS_DIR:-$HOME/.zetaphy-genesis-keys}
FROM=${FROM:-validator}
NODE=${NODE:-tcp://127.0.0.1:26657}
CHAIN_ID=${CHAIN_ID:-zetaphy-testnet-1}
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

submit() { # $1 = proposal file
  local before id=""
  before=$($ZETAPHYD q gov proposals $QF 2>/dev/null | jq -r '[.proposals[]?.id | tonumber] | max // 0')
  send tx gov submit-proposal "$1"
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
    submit "$f"; rm -f "$f" ;;
  propose-text)
    title=${2:?title}; summary=${3:?summary}
    f=$(mktemp)
    # A proposal with no messages must carry metadata (SDK rule).
    jq -n --arg d "$DEPOSIT" --arg t "$title" --arg s "$summary" '{messages:[],metadata:$t,deposit:$d,title:$t,summary:$s,expedited:false}' > "$f"
    submit "$f"; rm -f "$f" ;;
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
    submit "$f"; rm -f "$f" ;;
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
  *)
    sed -n '8,17p' "$0" | sed 's/^# //'; exit 2 ;;
esac
