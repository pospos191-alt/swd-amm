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
#   gov.sh quantum-lock <ML-DSA controller>              hand the FROM account to a PQ account, for good
#   gov.sh vote-key                                      register or replace this node's ML-DSA vote key
#   gov.sh pq-evidence on|off                            propose to stop (on) / resume (off) slashing on
#                                                        ed25519-only double-sign evidence for
#                                                        validators with an ML-DSA vote key
#   gov.sh neuro <action> [value] <NeuroControl 0x…>     a vote that steers Neuro (not the coin):
#     pause | unpause | approve-skill ID | revoke-skill ID | set-active-skill ID | approve-defender 0x…
#     remove-defender 0x… | release 0x… | set-max-bodies N | set-max-regrow N | set-community-fund 0x…
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
      [set-max-bodies]=3f1f3008 [set-max-regrow]=ecd0e17e [set-community-fund]=37339a16)
    sel=${SEL[$act]:-}; [ -n "$sel" ] || { echo "neuro: unknown action $act"; exit 1; }
    case "$act" in
      pause|unpause) arg=""; ctl=${3:?NeuroControl 0x…}; word="" ;;
      *) val=${3:?value}; ctl=${4:?NeuroControl 0x…}
         case "$act" in
           *-skill) [[ "$val" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "skill id: 0x + 64 hex (zetaphy neuro skill-id)"; exit 1; }; word=${val#0x} ;;
           set-max-*) [[ "$val" =~ ^[1-9][0-9]{0,5}$ ]] || { echo "a whole number above 0"; exit 1; }; word=$(printf '%064x' "$val") ;;
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
  *)
    sed -n '8,25p' "$0" | sed 's/^# //'; exit 2 ;;
esac
