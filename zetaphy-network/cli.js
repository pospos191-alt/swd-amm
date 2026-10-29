#!/usr/bin/env node
// zetaphy: one command for ZETAPHY testnet node runners and users.
//
//   zetaphy node start [--auto-register]   (--auto-register: wait for the bond to arrive, then register)
//   zetaphy node start                 check the machine, then run Neuro jobs (round-2 seats of challenges too;
//                                      a defender sends a heartbeat about every defenderTimeout/4)
//   zetaphy node start --watch-verdicts [--max-challenge-spend 10]   also re-run finalized verdicts and challenge
//                                      one that differs from ours (at most that many ZETAPHY of bonds a day)
//   zetaphy node start --llm-review [--llm-model qwen2.5-coder:7b --llm-url http://localhost:11434/v1 --llm-lang en]
//                                      opt-in: a local model (Ollama) writes an advisory "AI opinion" review of each
//                                      job we commit to, signed with the runner key (~/.zetaphy/reviews/job-N.json)
//   zetaphy review verify <job-N.json> check a signed LLM review: unedited, and which runner wrote it
//   zetaphy node register [--bond N]   put up the runner bond (ZETAPHY)
//   zetaphy node status                address, bond, earnings
//   zetaphy node withdraw              move earnings to the runner's wallet
//   zetaphy node unbond | withdraw-bond
//   zetaphy job request <chain> <address> [--fee N]   ask the network to check a contract
//   zetaphy job get <id>
//   zetaphy job settle <id>            after a quorum's reveal grace: penalize seats that never revealed (anyone may)
//   zetaphy job challenge <id> --verdict 0x<bytes32> [--bond N]   dispute a verdict inside its challenge window, naming
//                                      the right one: opens a round with 3 fresh runners (bond: at least max(2 x fee,
//                                      the voted challenge bond); see job get). No quorum: 80% back, may be re-challenged
//   zetaphy job request-stable <chain> <address> --relay URL [--token usdc --fee 0.1 --tip 0.01]
//                                      pay in test USDC/USDT through a relay: no ZETAPHY needed
//   zetaphy faucet <usdc|usdt> --relay URL   test stablecoins for this wallet (the relay pays gas)
//   zetaphy relay start [--port 8080 --min-tip 0.01 --poke-oracle 60]   serve users who pay in stablecoins (and keep the oracle poked)
//   zetaphy keys encrypt               encrypt ~/.zetaphy keys with ZETAPHY_PASSPHRASE (removes the plain files)
//   zetaphy gate                       progress toward gate 1 (30 days, no stalls, 10+ runners)
//   zetaphy pq new [--hybrid]          quantum-safe wallet (ML-DSA); --hybrid also needs this machine's ECDSA key
//   zetaphy pq address                 the wallet's address (fund it before or after it exists)
//   zetaphy pq send <to> <amount>      move ZETAPHY out of it, signed with ML-DSA
//   zetaphy pq native                  native PQ account (zetaphy1… / 0x…): Cosmos txs signed with ML-DSA only, no ECDSA key or gas payer
//   zetaphy pq native send <0x… or zetaphy1…> <amount> [--gas 400000]   send from it (fund the account first)
//   zetaphy pq native call <to 0x…> <calldata 0x…> [--value <ZETAPHY>] [--gas <EVM gas, default 200000>]
//                                      call an EVM contract as that account (msg.sender = its 0x form); no ECDSA key
//   zetaphy pq native token-send <token 0x…> <to 0x… or zetaphy1…> <amount>   ERC-20 transfer from it
//   zetaphy pq native token-balance <token 0x…>   its balance of an ERC-20
//   zetaphy pq native stake | unstake <zetaphyvaloper1…> <amount> [--gas 500000]   delegate to a validator, or undelegate
//   zetaphy pq native rewards <zetaphyvaloper1…>   withdraw staking rewards
//   zetaphy pq native deploy <init code 0x…> [--value <ZETAPHY>] [--gas <EVM gas, default 3000000>]   create a contract; prints its address
//                                      (EVM logs of these calls are not in eth_getLogs)
//   zetaphy pq native lock-ecdsa [<controller zetaphy1… or 0x…>] --yes   PERMANENT: hand this machine's ECDSA key's account
//                                      (~/.zetaphy/worker.key) to an ML-DSA-44 account (default: this pq native account);
//                                      an EVM tx to 0x…5051, after which the chain refuses the ECDSA key
//   zetaphy pq native ... --as <owner 0x… or zetaphy1…>   act for a quantum-locked account this one controls
//                                      (send, call, token-send, token-balance, stake, unstake, rewards, deploy; --gas is then EVM gas)
//   zetaphy pq native handover <owner> <new controller>   hand control of a locked account to another ML-DSA-44 account
//   zetaphy pq verify-block <height> [--rpc <CometBFT RPC, default http://127.0.0.1:26657>] [--keys pinned.json] [--chain-id ID] [--json]
//                                      check block <height>'s ML-DSA-44 vote certificate (in block height+1); exits 1 if not verified.
//                                      Without --keys the node is trusted for validator powers and vote keys
//   zetaphy pq export-vote-keys [--height h] [--rpc <CometBFT RPC>] > pinned.json   validator powers and vote keys, to pin
//   zetaphy deploy-pq                  deploy the QuantumWalletFactory
//   zetaphy security status | migration [<address>] | qday-commit | qday-reveal | consent <target 0x…> <seconds> [--as <owner>]
//                    | ibc-holds | ibc-hold-cancel <id>   the chain's security core (docs/SECURITY-CORE.md): Q-day migration
//                                      (commit–reveal for this machine's ECDSA key -> the pq native account), threat-gate consent,
//                                      held IBC transfers (src/securitycli.js)
//   zetaphy certify <token 0x…> --attest 0x<NeuroAttest> [--model rules --uri …]   run Neuro on a ZETAPHY token and attest it
//                                      "Neuro-checked" (approved attesters); certify from-job <jobId> <token> (anyone, settled verdict);
//                                      certify show <token> (src/assistcli.js)
//   zetaphy attest-pq sign <report.json> | verify <archive.json> | anchor <archive.json> --anchor 0x<NeuroAnchor>
//                                      ML-DSA-44-signed Neuro report archives, tamper check, hash anchored on ZETAPHY
//   zetaphy immune push --sender 0x<NeuroOracleSender> [--once --interval 30 --max-fee 0.1]   relay new flags to every chain's NeuroOracle
//   zetaphy immune coverage --sender 0x… --mirror <name>=<rpc>@0x<NeuroOracle> …   share of flags each chain mirrors
//   zetaphy deploy-assist attest|anchor|insurance [--governance 0x… --jobs 0x…]   NeuroAttest, NeuroAnchor, HackInsurance (testnet only)
//   zetaphy insurance replay --target 0x… --tx 0x…,… --from-block N --to-block M [--price 0x<token>=1.5,… | --price-oracle 0x… --native-asset 0x…]
//                    [--source-rpc URL --chain-id N --tokens 0x…,… --confirmations 12 --anvil anvil --out report.json]
//                                      the deterministic forensic replay (anvil fork, foundry v1.2.3): canonical report + reportHash + loss
//   zetaphy insurance hash <report.json> | claim --insurance 0x… --cover <id> --report <file> | vote --insurance 0x… --claim <id> [--report <file> --dry-run]
//                                      check a report, file a claim, or (a runner) recompute the replay and vote (HackInsurance, testnet only)
//   zetaphy deploy-multisig --owners 0xA,0xB,0xC [--threshold 2]   k-of-n admin for the contracts below
//   zetaphy deploy-bridge --lockbox <chainId>:0x<LockBox> [--quarantine 3600 --threshold 2 --lane 0x... --guardian 0x<multisig>
//                          --governance 0x<multisig>|gov --threats 0x<ThreatRegistry> --control 0x<NeuroControl> --daily-limit 1000
//                          --hyperlane-mailbox 0x… [--hyperlane-origin <domain> --hyperlane-sender 0x… --hyperlane-ism 0x…]
//                          [--hyperlane-outbox] --marker 0x<monitor key address> --devnet | --allow-eoa-for-testing]
//                                      BridgeGuard + BridgeAirlock + NeuroLane (+ HyperlaneLane), CLOSED:
//                                      the route is disabled until zetaphy bridge open. A --guardian / --governance must be
//                                      a multisig (Safe or SimpleMultisig, 3+ owners, threshold 2+) or (governance) the gov
//                                      module; a single key only with --devnet (local RPC) or --allow-eoa-for-testing.
//                                      Daily limit: at most 1,000 tokens (the starter cap; on-chain maxDailyLimit). NeuroLane's
//                                      pause switch defaults to the NeuroJobs' control(); the bridge's own contracts (and
//                                      the lockbox) are protected in the ThreatRegistry. --marker: a key that may mark
//                                      addresses (airlock.trip; e.g. the bridge monitor's own key, BRIDGE_MARKER_KEY).
//                                      --hyperlane-outbox: the way back too (Saphan v2, --lockbox is a HyperlaneLockBoxV2):
//                                      a HyperlaneOutbox burning through an outbound-only route of the guard (closed)
//                                      and dispatching releases to that lockbox (docs/SAPHAN-MULTICHAIN.md)
//   zetaphy bridge gates|open --audit-report <https url> --audit-sha256 <hex> [--daily-limit 1000 --min-runners 10
//                          --raise-cap --i-understand-real-funds --devnet --testnet --allow-eoa-for-testing]
//                                      --testnet: the public ZETAPHY testnet only (chain id 77390 + its block 1 hash),
//                                      test coins: the audit is docs/BRIDGE-TESTNET.md, 1+ runners, 2-owner multisigs,
//                                      daily limit <= 100 tokens; every line is marked TESTNET (not audited)
//                                      open the bridge only when every gate holds: 2+ lanes with distinct controllers
//                                      (none the deployer), the audit recorded on-chain, NeuroJobs activeWorkers >= 10,
//                                      multisig guardian and governance (no shared owner), the cap; gates only checks
//   zetaphy bridge close | pause        governance closes the route; a guardian pauses everything (only governance unpauses)
//   zetaphy bridge cap [show | propose <tokens> | apply | cancel]   the hard cap: a raise (x2 at most) waits 7 days
//   zetaphy bridge marker 0x<key> [--off]   governance names (or removes) a marker: a key that may mark addresses
//   zetaphy bridge untrip 0x<address>       governance lifts a mark (the address's bridge transfers can come out again)
//   zetaphy bridge monitor [--monitor-config f --launch-state f --state f --out report.json --summary f --issue f --quiet
//                          --volume-pct 80 --large-pct 25 --silent-minutes 30 --source-rpc URL --lockbox 0x… --fail-on-alert]
//                                      scan: alerts (volume, lanes disagreeing or silent, veto, pause, marks, holds,
//                                      governance changes, large transfers) as JSON + a Thai / English summary.
//                                      From the environment only (secrets): BRIDGE_MONITOR_THRESHOLDS (JSON over the
//                                      config's thresholds), BRIDGE_WATCHLIST (JSON [{address, callerTopic?}]: every log
//                                      of these contracts is an alert, never named in the output) and BRIDGE_MARKER_KEY
//                                      (a marker: marks their callers). --quiet: one line of counts (for public logs)
//   zetaphy bridge watch --source-rpc URL --lockbox 0x... [--confirmations 12 --release]
//                                      be one voice of the Neuro bridge (skips flagged sources, stops while Neuro is
//                                      paused or its switch cannot be read)
//   zetaphy deploy-threats [--quorum 3 --min-agreed 5 --enforce-delay 3600 --fast-quorum <2 x quorum> --guardian 0x...
//                           --governance 0x<multisig>|gov --community-fund 0x... --appeal-bond 1 --appeal-window 1209600
//                           --identity 0x<NeuroIdentity>]
//                                      ThreatRegistry (immune system + vaccine); flags block only after the delay,
//                                      or at once through the fast lane (fastQuorum runners, or enforceNow)
//   zetaphy threat flag <target>... --reason <code fact> --evidence <reportHash | neuro:<chain>:<address>> [--uri <≤200 bytes>]
//                                      reason (what the code does, never intent): cannot-sell-in-simulation | unlimited-mint |
//                                      owner-can-block-transfers | owner-can-move-holder-funds | same-name-as-known-token |
//                                      sweeps-approved-tokens | other. evidence: a Neuro reportHash (or the hash of another
//                                      reproducible report); neuro:<chain>:<address> runs Neuro and uses its reportHash.
//                                      (on a standing flag: backs it, toward the fast lane's fastQuorum)
//   zetaphy threat clear <target>... | zetaphy threat check <target>...
//   zetaphy threat protect|unprotect <target>... | threat enforce-delay <seconds> | threat set-governance <0x…|gov>
//   zetaphy threat fast-quorum <n, 0 = off> | threat guardian <0x…:on|off> | threat hold-delay <seconds, below enforce-delay>
//                                      governance only: sent if this key is governance, else printed as calldata
//                                      for a multisig proposal or a MsgEVMCall (gov module)
//   zetaphy threat enforce-now <target>...   governance or a guardian: enforce standing flags at once
//                                      target: fp1:<hex> (Neuro fingerprint), code:0x<codehash>,
//                                      0x<contract on ZETAPHY> (its address and code hash), <chainId>:0x<address>
//   zetaphy threat export [--out threats.json]   flagged and enforced keys as JSON, for other wallets / extensions
//   zetaphy deploy-reports [--fee 0.1 --ttl 2592000 --community-fund 0x...]   ThreatReports (user reports, fee to the voters)
//   zetaphy threat report <target> --note "..." [--chain bsc]   report a suspicious contract (pays the report fee)
//   zetaphy threat reports [--all --last 50] | threat settle <id> | threat claim <id>
//   zetaphy threat respond <target> --text "..." (≤500 bytes, empty removes your own)   right of reply, one per author: for an
//                                      address, the address itself or its owner() (on ZETAPHY) or the claimed NeuroIdentity owner
//                                      (<chainId>:0x…); for code: and fp1: keys only the responder governance named
//   zetaphy threat hold-now <target>...   governance or a guardian: hold bridging for standing flags at once (no hold-delay)
//   zetaphy threat appeal <target>     the same party: appeal a flag (pays the appeal bond); fresh runners vote on it:
//   zetaphy threat appeal-vote <target> --clear|--keep --evidence <reportHash> [--uri ...] | threat appeal-expire <target>
//   zetaphy threat withdraw | threat pay-fund   refunded appeal bonds / kept bonds to the community fund
//   zetaphy threat appeals-set --bond 1 --window 1209600 --community-fund 0x... | threat identity 0x<NeuroIdentity>
//   zetaphy threat responder <target> 0x<address>   governance only (as protect)
//   zetaphy deploy [--bond 100 --reward 1 --min-fee 0.1 --window 120 --timeout 600 --unbond 3600 --daily-reward-cap 100]
//                  [--control 0x<NeuroControl> | --governance 0x<multisig>|gov --community-fund 0x... --max-bodies 64 --max-regrow 4]
//                                      NeuroJobs wired to a NeuroControl (a new one, with this machine's Neuro skill voted in,
//                                      unless --control is given); --governance gov = the chain's gov module
//   zetaphy deploy-control [--governance 0x...|gov --community-fund 0x... --max-bodies 64 --max-regrow 4 --guardian 0x...]
//   zetaphy neuro skill-id             this machine's Neuro skill id (sha256 of zetaphy-neuro/src, see src/skill.js)
//   zetaphy neuro status               stop button, voted skill, bodies, defenders, quarantine
//   zetaphy neuro regrow               refill vacant defender seats from the voted roster (anyone may)
//   zetaphy neuro calldata <action> [value]   calldata of a NeuroControl governance call (no RPC needed);
//                                      action: pause unpause approve-skill revoke-skill set-active-skill approve-defender
//                                      remove-defender release set-max-bodies set-max-regrow set-community-fund
//                                      approve-chain remove-chain (value: a chain key such as bsc)
//                                      set-challenge-bond (ZETAPHY) set-challenge-window set-defender-timeout (seconds)
//                                      set-guardian (value 0x...:on|off) set-governance; skill value "local" = skill-id
//   zetaphy neuro send <action> [value]       send it from this key (a guardian's pause, or a key that is governance)
//   zetaphy neuro propose <action> [value] --multisig 0x...   propose it to a SimpleMultisig that is governance
//                                      (with the gov module as governance: zetaphy-chain/gov.sh neuro ...)
//   zetaphy deploy-stable [--oracle 0x<ZetaphyOracle> --zeta-asset 0x<WZETAPHY> | --testnet-fixed-price 0.01] [--reserve 1000 --guardian 0x…
//                         --governance 0x<timelock>]  test USDC/USDT + StableGateway, priced by ZetaphyOracle; --testnet-fixed-price
//                                      switches on the labeled testnet fallback (a fixed price, not a market)
//   zetaphy deploy-timelock --proposer 0x<multisig>[,…]|gov [--delay 172800 --executor open|proposers --devnet]
//                                      ZetaphyTimelock (OpenZeppelin TimelockController 5.4.0): the admin of the contracts below
//   zetaphy timelock status [<id>] | schedule --to 0x… (--data 0x… | --sig "fn(types)" --args a,b) [--salt s --delay s --proposal-out f.json]
//   zetaphy timelock execute <id> | cancel <id>   schedule/cancel: sent if this key is a proposer/canceller, else printed as
//                                      calldata for the multisig (and, with the gov module a proposer, a MsgEVMCall proposal);
//                                      execute: anyone, once the delay has passed
//   zetaphy deploy-oracle [--relayers 0x…,… --relay-threshold 1 | --pyth 0x<Pyth>] [--min-spacing 60 --guardian 0x…]
//                                      TwapRecorder + ZetaphyPythRelay + ZetaphyOracle (TWAP of the DEX + Pyth, with guards)
//   zetaphy oracle feed <asset> [--pair 0x… --window 1800 --min-observations 10 --min-liquidity 10000] [--pyth-id 0x… --max-age 120
//                          --max-conf 100] [--max-deviation 200 --max-change 1500 --max-window-change 3000 --change-window 3600]
//   zetaphy oracle status [asset] | poke <asset>… | pause <asset> (a guardian) | push --feed 0x… --price N --expo -8
//   zetaphy oracle relay-pyth --feed 0x<id>[,…] [--every 30 --hermes https://hermes.pyth.network]   a relayer forwards Pyth's prices
//   zetaphy deploy-vault [--validators 0x... --validators-share 30 --fund N --governance 0x<multisig>]
//                                      RewardVault: releases the reward pool at 10% a year (no withdraw)
//   zetaphy vault status | release     what has vested; pay it out (anyone may; node start does it daily)
//   zetaphy deploy-identity --web https://<neuro web>/web/ [--image URL --min-agreed 1 --claim-quorum 3 --claim-min-agreed 5
//                           --claim-delay 259200 --governance 0x<multisig>]
//                                      NeuroIdentity (ERC-8004 identity: 1 contract = 1 agent) + NeuroValidation (runner verdicts)
//   zetaphy work verdict <chain> <address>              the code-only verdict a browser scan job gets (docs/future/useful-work.md)
//   zetaphy work verify-finding <spec.json> <finding.json | 0x…>   replay a browser's bug finding against a bounty spec
//   zetaphy bounty check <findingId> --bounty 0x… --spec <spec.json> [--attest]   runners: verify a revealed finding, then vote
//   zetaphy identity register <chain> <address>          give a contract its Neuro identity (anyone may; one per contract)
//   zetaphy identity get <chain> <address> | <agentId>   who controls it, its Neuro report link, runner verdicts
//   zetaphy identity claim <agentId>                      the contract (or its owner()) takes control of its identity
//   zetaphy identity claim-request <agentId> --new-owner 0x… --owner-key <key> [--ttl s --out claim.json]
//                                      start claiming the identity of a target on ANOTHER chain (its owner there signs)
//   zetaphy identity attest-claim <claim.json> [--owner-sig 0x…]   a runner reads the owner on that chain and signs
//   zetaphy identity claim-remote <claim.json>          propose once a quorum of runners attested (NeuroIdentity.claimRemote)
//   zetaphy identity finalize-claim <agentId>           run a proposed claim after its contest window (claimDelay; anyone)
//   zetaphy identity contest-claim <agentId>            cancel a proposed claim in its window (the holder, or a runner meeting the bar)
//   zetaphy identity verdict <agentId> <verdict 0x…> <score 0-100> [--tag t --uri u]   a bonded runner posts (or replaces) its verdict
//   zetaphy msg sign <hello|verdict|threat-report|ack> --from <agentId> (--payload '<json>' | --payload-file f) [--to <agentId> --ttl 3600 --out f]
//                                      signer: the agent's owner/operator/agentWallet, or a runner for an unclaimed Neuro identity
//   zetaphy msg verify <file> [--me <agentId>]   check a signed message from another Neuro (it is data, never a command)
//                                      (--identity / ZETAPHY_IDENTITY, --validation / ZETAPHY_VALIDATION: the two addresses)
//   zetaphy intent show | compile | execute <signed-intent.json> [--router 0x… --path 0xA,0xB | --vault 0x… | --bridge 0x…]
//                                      Proof of Intent, as a solver: build the calls for a signed intent (from the hub's Agents
//                                      page) and submit them to IntentExecutor, which reverts unless the effects match
//   zetaphy intent spend <signed allowance intent> --to 0x… --amount <base units>   the spender of an "approve with cap" intent
//                                      pulls up to the cap until it expires (IntentExecutor.spendAllowance)
//   zetaphy cosign review --wallet 0x<AgentPolicyWallet> --to 0x… [--value wei --data 0x… --deadline unix --strict]
//                                      AI co-signer, as a committee runner: run Neuro on what the action touches, sign if clean
//   zetaphy cosign combine <a.json> <b.json> …   order the runners' signatures for executeCosigned (docs/future/agents.md)
//   zetaphy cosign dkg1 --id i --threshold t --participants n --session <32 hex> [--out f]
//   zetaphy cosign dkg2 --secret <dkg secret> <every round-1 package…> [--out f]
//   zetaphy cosign dkg3 --secret <dkg secret> --round1 a.json,b.json,… <round-2 messages…> [--key f --out group.json]
//                                      FROST (RFC 9591) threshold key for the committee, made by the members (no dealer);
//                                      every step is a file or a copy-paste; compare the printed transcript out of band
//   zetaphy cosign commit --key <frost key> [--out f]   signing round 1: a one-time commitment
//   zetaphy cosign frost-package --group group.json --wallet 0x… --to 0x… [--value --data --deadline --strict] <commitments…>
//   zetaphy cosign frost-sign --key <frost key> --package pkg.json   round 2: re-runs Neuro, signs only the digest it computed
//   zetaphy cosign frost-aggregate --group group.json --package pkg.json <shares…>   one 65-byte signature for executeCosignedFrost
//
// Settings: --rpc / ZETAPHY_RPC (ZETAPHY testnet JSON-RPC), --jobs / ZETAPHY_JOBS
// (ZETAPHY_CHAIN_ID: Cosmos chain id `pq native` expects, default zetaphy_77390-1)
// (NeuroJobs address). They are saved to ~/.zetaphy/config.json on first use.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Contract, ContractFactory, Interface, formatEther, parseEther, parseUnits, formatUnits, encodeBytes32String, decodeBytes32String, NonceManager, Signature, keccak256 } from 'ethers';
import { HOME, loadOrCreateKey, sealWorkerKey } from './src/keys.js';
import { detectHardware, pickProfile } from './src/hardware.js';
import { createWorker, SUPPORTED_CHAINS, send as padded } from './src/worker.js';
import { createLlmReviewer, verifyReview } from './src/llmreview.js';
import { skillId, skillFiles } from './src/skill.js';
import { createRelay } from './src/relay.js';
import { gate1 } from './src/gate.js';
import { loadOrCreatePq, sealPqSeed, VARIANT as PQ_VARIANT } from './src/pq.js';
import { pqClient, pqAddress, normalizeAddress, validatorAddress, parseZeta, formatZeta, quantumLockTx, DEFAULT_GAS_LIMIT, DEFAULT_EVM_GAS_LIMIT,
  DEFAULT_STAKING_GAS_LIMIT, DEFAULT_DEPLOY_GAS_LIMIT, DEFAULT_PRECOMPILE_GAS_LIMIT, MIN_EVM_GAS_LIMIT, MAX_EVM_GAS_LIMIT } from './src/pqtx.js';
import { createLaneWatcher, laneControl } from './src/lane.js';
import { verifyBlock, exportVoteKeys } from './src/pqcert.js';
import { securityCommand } from './src/securitycli.js';
import { identityCommand } from './src/identitycli.js';
import { bridgeCommand } from './src/bridgecli.js';
import { timelockCommand, timelockHint } from './src/timelockcli.js';
import { oracleCommand } from './src/oraclecli.js';
import { agentsCommand } from './src/agentscli.js';
import { assistCommand } from './src/assistcli.js';
import { devnetOf, testnetOf, testnetWrite, roleChecks, capProblems, STARTER_UNITS } from './src/bridgegate.js';

const art = (n) => JSON.parse(readFileSync(new URL(`./artifacts/${n}.json`, import.meta.url), 'utf8'));
const ART = art('NeuroJobs');
const CONTROL = art('NeuroControl');
const STABLE = art('TestStable');
const GATEWAY = art('StableGateway');
const QWALLET = art('QuantumWallet');
const QFACTORY = art('QuantumWalletFactory');
const B = Object.fromEntries(['BridgeGuard', 'BridgeAirlock', 'NeuroLane', 'HyperlaneLane', 'HyperlaneOutbox', 'LockBox', 'BridgedToken', 'SimpleMultisig', 'RewardVault', 'ThreatRegistry', 'ThreatReports'].map((n) => [n, art(n)]));
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
/** --governance: who takes over the admin role after setup (a multisig). */
function governanceOf(opt, write) {
  const g = opt.governance;
  if (g == null) { write('warning: no --governance given, so this key stays the only admin (fine for a quick test, not beyond)'); return null; }
  if (!ADDR_RE.test(String(g))) throw new Error('--governance must be a 0x address (e.g. from deploy-multisig)');
  return String(g);
}
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const STATUS = ['none', 'open', 'done', 'failed'];
const CHALLENGE = ['none', 'round 2 running', 'confirmed', 'overturned', 'disputed'];

// ---- Neuro governance (NeuroControl) ----
/** The gov module's EVM address: the first 20 bytes of sha256("gov") (zetaphy10d07y265gmmuvt4z0w9aw880jnsr700jvr86lj). */
export const GOV_MODULE = '0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2';
const NEURO_ACTIONS = {
  pause: ['pause'], unpause: ['unpause'],
  'approve-skill': ['approveSkill', 'skill'], 'revoke-skill': ['revokeSkill', 'skill'], 'set-active-skill': ['setActiveSkill', 'skill'],
  'approve-defender': ['approveDefender', 'address'], 'remove-defender': ['removeDefender', 'address'], release: ['release', 'address'],
  'set-max-bodies': ['setMaxBodies', 'uint'], 'set-max-regrow': ['setMaxRegrowPerHour', 'uint'],
  'set-community-fund': ['setCommunityFund', 'address'], 'set-governance': ['setGovernance', 'address'], 'set-guardian': ['setGuardian', 'guardian'],
  'approve-chain': ['approveChain', 'chain'], 'remove-chain': ['removeChain', 'chain'],
  'set-challenge-bond': ['setChallengeBond', 'zeta'], 'set-challenge-window': ['setChallengeWindow', 'uint'],
  'set-defender-timeout': ['setDefenderTimeout', 'uint'],
};
/** --governance for Neuro: a 0x address, or "gov" for the chain's gov module. */
const neuroGovernance = (g) => (g === 'gov' ? GOV_MODULE : g);
/** {fn, args, data} of a NeuroControl governance call. */
export function neuroCall(action, value) {
  const [fn, kind] = NEURO_ACTIONS[action] ?? [];
  if (!fn) throw new Error(`unknown action ${action}: ${Object.keys(NEURO_ACTIONS).join(', ')}`);
  let args = [];
  if (kind === 'skill') {
    const id = value === 'local' ? skillId() : String(value ?? '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error(`${action}: a skill id (0x + 64 hex, or "local" for zetaphy neuro skill-id)`);
    args = [id];
  } else if (kind === 'address') {
    const a = neuroGovernance(String(value ?? ''));
    if (!ADDR_RE.test(a)) throw new Error(`${action}: a 0x address`);
    args = [a];
  } else if (kind === 'uint') {
    if (!/^[1-9][0-9]{0,5}$/.test(String(value ?? ''))) throw new Error(`${action}: a whole number above 0`);
    args = [BigInt(value)];
  } else if (kind === 'zeta') {
    if (!/^[0-9]{1,12}(\.[0-9]{1,18})?$/.test(String(value ?? '')) || parseEther(String(value)) === 0n) throw new Error(`${action}: an amount of ZETAPHY above 0, e.g. 2.5`);
    args = [parseEther(String(value))];
  } else if (kind === 'chain') {
    if (!/^[a-z0-9-]{1,31}$/.test(String(value ?? ''))) throw new Error(`${action}: a chain key such as bsc (1-31 of a-z 0-9 -)`);
    args = [encodeBytes32String(String(value))];
  } else if (kind === 'guardian') {
    const m = /^(0x[0-9a-fA-F]{40}):(on|off)$/.exec(String(value ?? ''));
    if (!m) throw new Error('set-guardian: 0x<address>:on or 0x<address>:off');
    args = [m[1], m[2] === 'on'];
  } else if (value != null) throw new Error(`${action} takes no value`);
  return { fn, args, data: new Interface(CONTROL.abi).encodeFunctionData(fn, args) };
}
const EVM_CHAIN_ID = 77390n;

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); opt[k] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i]; }
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

function settings(opt, env) {
  const file = join(HOME, 'config.json');
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const s = { ...saved, rpc: opt.rpc ?? env.ZETAPHY_RPC ?? saved.rpc, jobs: opt.jobs ?? env.ZETAPHY_JOBS ?? saved.jobs };
  for (const k of ['gateway', 'usdc', 'usdt', 'pqFactory', 'airlock', 'neuroLane', 'hyperlaneLane', 'hyperlaneOutbox', 'bridgeGuard', 'vault', 'threats', 'reports',
    'timelock', 'timelockBlock', 'oracle', 'twapRecorder', 'pythRelay', 'zetaAsset']) if (opt[k]) s[k] = opt[k];
  if (!s.vault && env.ZETAPHY_VAULT) s.vault = env.ZETAPHY_VAULT;
  if (opt.hybrid) s.pqHybrid = true;
  if (JSON.stringify(s) !== JSON.stringify(saved)) {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(s, null, 2));
  }
  return s;
}

async function connectRpc(s) {
  if (!s.rpc) throw new Error('set the ZETAPHY testnet RPC: --rpc http://<node>:8545 (or ZETAPHY_RPC)');
  // The network is fixed to 77390, so every tx this key signs carries chain id 77390 whatever the RPC says later;
  // an RPC that answers another chain id is refused before anything is signed.
  const provider = new JsonRpcProvider(s.rpc, EVM_CHAIN_ID, { staticNetwork: true, polling: true, pollingInterval: 1000 });
  const id = BigInt(await provider.send('eth_chainId', []));
  if (id !== EVM_CHAIN_ID) { provider.destroy(); throw new Error(`that RPC is chain ${id}, not ZETAPHY testnet (${EVM_CHAIN_ID})`); }
  return provider;
}

async function connect(s, { needJobs = true } = {}) {
  const provider = await connectRpc(s);
  const { wallet, created, file } = loadOrCreateKey();
  const signer = new NonceManager(wallet.connect(provider));
  const me = await wallet.getAddress();
  let jobs = null;
  if (needJobs) {
    if (!s.jobs) throw new Error('set the NeuroJobs address: --jobs 0x... (or ZETAPHY_JOBS)');
    if ((await provider.getCode(s.jobs)) === '0x') throw new Error(`no contract at ${s.jobs}`);
    jobs = new Contract(s.jobs, ART.abi, signer);
  }
  return { provider, signer, me, created, file, jobs };
}

const zeta = (wei) => `${formatEther(wei)} ZETAPHY`;

/** --auto-register: ready once the wallet holds the bond plus a gas reserve (0.1 ZETAPHY); else what is missing. */
export function autoRegisterPlan(balance, bond, reserve = 10n ** 17n) {
  const need = BigInt(bond) + BigInt(reserve);
  const have = BigInt(balance);
  return have >= need ? { ready: true, missing: 0n } : { ready: false, missing: need - have };
}

const ERC20 = new Interface(['function transfer(address to, uint256 value) returns (bool)', 'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);

const tokenAmount = (v, decimals) => formatUnits(v, decimals).replace(/\.0$/, '');

/** decimals() and symbol() of an ERC-20, read with eth_call. */
async function tokenInfo(provider, token) {
  if ((await provider.send('eth_getCode', [token, 'latest'])) === '0x') throw new Error(`no contract at ${token}`);
  const raw = (fn, args = []) => provider.send('eth_call', [{ to: token, data: ERC20.encodeFunctionData(fn, args) }, 'latest']);
  let decimals;
  try { decimals = Number(ERC20.decodeFunctionResult('decimals', await raw('decimals'))[0]); } catch { throw new Error(`${token} does not look like an ERC-20 token (no decimals())`); }
  let symbol = '?';
  try {
    const r = await raw('symbol');
    try { symbol = ERC20.decodeFunctionResult('symbol', r)[0]; } catch { symbol = decodeBytes32String(r); } // some old tokens return bytes32
  } catch { /* no symbol(): keep '?' */ }
  return { decimals, symbol, balanceOf: async (who) => ERC20.decodeFunctionResult('balanceOf', await raw('balanceOf', [who]))[0] };
}

/**
 * zetaphy pq verify-block | export-vote-keys: CometBFT RPC only. They run before
 * settings(), so their --rpc (a CometBFT URL) never replaces the saved EVM RPC.
 */
async function pqBlockCommand(cmd, rest, opt, env, write) {
  const rpc = String(opt.rpc ?? env.ZETAPHY_COMET_RPC ?? 'http://127.0.0.1:26657');
  if (cmd === 'export-vote-keys') {
    if (opt.height != null && !/^\d+$/.test(String(opt.height))) throw new Error('usage: zetaphy pq export-vote-keys [--height h] [--rpc <CometBFT RPC>] > pinned.json');
    write(JSON.stringify(await exportVoteKeys(rpc, { height: opt.height == null ? undefined : String(opt.height) }), null, 2));
    return 0;
  }
  const [height] = rest;
  if (!/^\d+$/.test(height ?? '') || rest.length !== 1) throw new Error('usage: zetaphy pq verify-block <height> [--rpc <CometBFT RPC>] [--keys pinned.json] [--chain-id ID] [--json]');
  let pinnedKeys;
  if (opt.keys != null) {
    try { pinnedKeys = JSON.parse(readFileSync(String(opt.keys), 'utf8')); } catch (e) { throw new Error(`--keys ${opt.keys}: ${e.message}`); }
  }
  const r = await verifyBlock(rpc, height, { chainId: opt['chain-id'] == null ? undefined : String(opt['chain-id']), pinnedKeys });
  if (opt.json) {
    write(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return r.ok ? 0 : 1;
  }
  const verdict = !r.ok ? 'NOT VERIFIED'
    : r.pqMajority ? 'VERIFIED post-quantum: validators with more than 2/3 of the power signed it with ML-DSA-44'
      : r.required > 0n ? `VERIFIED by the chain's rule, but only partly post-quantum (${r.unregisteredPower} of the power has no vote key)`
        : 'OK by the chain\'s rule, but NOT post-quantum: validators with a vote key hold less than 1/3 of the power, so no ML-DSA-44 signature is required';
  write(`block ${r.height}: ${verdict}`);
  write(`  hash:     ${r.hash}`);
  write(`  chain:    ${r.chainId}`);
  write(`  signed:   ${r.signedPower} of ${r.totalPower} voting power (${r.unregisteredPower} without a vote key); ${r.required > 0n ? `needs ${r.required} or more` : 'nothing required'}`);
  write(`  keys:     ${r.keysFrom === 'pinned' ? `pinned in ${opt.keys} (the node is not trusted)` : `from the node ${rpc} (trusted for validator powers and keys; pin them with --keys)`}`);
  for (const v of r.validators) {
    write(`  ${v.signed ? '✓' : v.hasKey ? '✗' : '·'} ${v.address} power ${v.power}: ${v.signed ? 'signed' : v.hasKey ? 'no valid signature' : 'no vote key'}`);
  }
  for (const p of r.problems) write(`  - ${p}`);
  return r.ok ? 0 : 1;
}

/** Step 1 of a NeuroControl: checks the options and deploys it (this key is governance for now). */
async function newControl(c, opt) {
  const finalGov = opt.governance == null ? null : neuroGovernance(String(opt.governance));
  if (finalGov != null && !ADDR_RE.test(finalGov)) throw new Error('--governance must be a 0x address or "gov" (the chain\'s gov module)');
  const fund = String(opt['community-fund'] ?? c.me);
  if (!ADDR_RE.test(fund)) throw new Error('--community-fund must be a 0x address');
  if (opt.guardian != null && !ADDR_RE.test(String(opt.guardian))) throw new Error('--guardian must be a 0x address');
  const k = await new ContractFactory(CONTROL.abi, CONTROL.bytecode, c.signer).deploy(c.me, fund, BigInt(opt['max-bodies'] ?? 64), BigInt(opt['max-regrow'] ?? 4));
  await k.waitForDeployment();
  return { k, address: await k.getAddress(), finalGov, fund };
}

/** Step 2: votes in this machine's Neuro skill and the chains the runner reads, then hands it to --governance. */
async function configureControl(c, { k, address, finalGov, fund }, opt, write) {
  const id = skillId();
  await (await k.approveSkill(id)).wait();
  await (await k.setActiveSkill(id)).wait();
  await (await k.approveChains(SUPPORTED_CHAINS.map((ch) => encodeBytes32String(ch)))).wait();
  if (opt.guardian) await (await k.setGuardian(String(opt.guardian), true)).wait();
  if (finalGov && finalGov.toLowerCase() !== c.me.toLowerCase()) await (await k.setGovernance(finalGov)).wait();
  write(`NeuroControl ${address}: skill ${id} voted in, chains ${SUPPORTED_CHAINS.join(' ')}, community fund ${fund}, governance ${finalGov ?? c.me}${finalGov === GOV_MODULE ? ' (gov module: change it with zetaphy-chain/gov.sh neuro ...)' : ''}`);
  if (!finalGov) write('warning: no --governance given, so this key stays the only governance of Neuro (fine for a quick test, not beyond)');
  return address;
}

/** Deploys a NeuroControl with this machine's Neuro skill and chains voted in, then hands it to --governance. */
async function deployControl(c, opt, write) {
  return configureControl(c, await newControl(c, opt), opt, write);
}

export async function main(argv = process.argv.slice(2), env = process.env, write = console.log) {
  const { pos, opt } = parse(argv);
  const [group, cmd, ...rest] = pos;
  if (group === 'pq' && (cmd === 'verify-block' || cmd === 'export-vote-keys')) return pqBlockCommand(cmd, rest, opt, env, write);
  if (group === 'review' && cmd === 'verify') {
    // A runner's signed LLM review (node start --llm-review): who wrote it, and is it unedited?
    if (!rest[0]) throw new Error('usage: zetaphy review verify <job-N.json>');
    const rec = JSON.parse(readFileSync(rest[0], 'utf8'));
    const r = verifyReview(rec);
    write(r.ok ? `valid: signed by runner ${r.signer} (job ${rec.body.jobId}, ${rec.body.model}); AI opinion, not part of the verdict` : `NOT valid: ${r.reason}`);
    return r.ok ? 0 : 1;
  }
  const s = settings(opt, env);

  if (group === 'node' && cmd === 'start') {
    const hw = await detectHardware();
    const { profile, reason } = pickProfile(hw);
    write(`machine: ${hw.cpus} CPU, ${hw.memoryGB} GB RAM${hw.gpus.length ? ', ' + hw.gpus.map((g) => g.name).join(', ') : ''}`);
    if (!profile) throw new Error(`this machine cannot run Neuro: ${reason}`);
    write(`mode: ${profile} (${reason})`);
    const c = await connect(s);
    write(`runner address: ${c.me}${c.created ? ` (new key saved to ${c.file}; testnet only)` : ''}`);
    const w = await c.jobs.workers(c.me);
    if (!w.active && opt['auto-register']) {
      // One-command installs: wait until the wallet holds the bond (+ a little for gas), then register.
      if (await c.jobs.quarantined(c.me)) throw new Error('this runner address is quarantined: only a governance vote (release) lets it register again');
      for (let shown = 0; ; shown++) {
        const bond = await c.jobs.workerBond();
        const plan = autoRegisterPlan(await c.provider.getBalance(c.me), bond);
        if (plan.ready) {
          await (await padded(c.jobs.register, { value: bond })).wait();
          write(`registered ${c.me} with a bond of ${zeta(bond)}`);
          break;
        }
        if (shown % 10 === 0) write(`${new Date().toISOString()} waiting for funds: send ${zeta(plan.missing)} (or more) to ${c.me}; the bond is ${zeta(bond)}`);
        await new Promise((r) => setTimeout(r, Number(opt['fund-poll'] ?? 60) * 1000));
      }
    } else if (!w.active) {
      write(`not registered yet: run "zetaphy node register" (bond ${zeta(await c.jobs.workerBond())}), or start with --auto-register`);
      return 1;
    }
    // Governance: work only on jobs of this machine's (voted) skill; stop while paused.
    const controlAddr = await c.jobs.control();
    const control = controlAddr === ZERO_ADDR ? null : new Contract(controlAddr, CONTROL.abi, c.provider);
    const mySkill = control ? skillId() : null;
    if (control) {
      const active = await control.activeSkill();
      write(`skill: ${mySkill}${active.toLowerCase() === mySkill.toLowerCase() ? ' (the voted one)' : ` — NOT the voted skill ${active}: this runner takes no jobs until it runs that Neuro code`}`);
    }
    const watch = opt['watch-verdicts'] ? { maxPerDay: parseEther(String(opt['max-challenge-spend'] ?? 10)) } : null;
    if (watch) write(`watching verdicts: challenge one that differs from ours, at most ${formatEther(watch.maxPerDay)} ZETAPHY of bonds a day`);
    // Opt-in: a local model (Ollama) writes a signed, advisory review of each job we commit to.
    const reviewer = opt['llm-review'] ? createLlmReviewer({
      wallet: c.signer, dir: join(HOME, 'reviews'),
      ...(typeof opt['llm-model'] === 'string' ? { model: opt['llm-model'] } : {}),
      ...(typeof opt['llm-url'] === 'string' ? { baseUrl: opt['llm-url'] } : {}),
      ...(typeof opt['llm-lang'] === 'string' ? { lang: opt['llm-lang'] } : {}),
      log: (l) => write(`${new Date().toISOString()} ${l}`),
    }) : null;
    if (reviewer) write(`LLM review: on (local model; AI opinion saved and signed in ${join(HOME, 'reviews')}; never part of the verdict)`);
    const worker = createWorker({
      onReport: reviewer ? (job) => reviewer.queue(job) : null,
      skill: mySkill, paused: control ? () => control.paused() : null, watch,
      defenderTimeout: control ? () => control.defenderTimeout() : null,
      onRoster: control ? () => control.defenderApproved(c.me) : null,
      jobs: c.jobs, me: c.me, stateFile: join(HOME, `jobs-${s.jobs.toLowerCase()}.json`),
      zetaphyChain: { kind: 'evm', id: Number(EVM_CHAIN_ID), name: 'ZETAPHY testnet', rpcs: [s.rpc] },
      chainTime: async () => BigInt((await c.provider.getBlock('latest')).timestamp),
      log: (l) => write(`${new Date().toISOString()} ${l}`),
    });
    write('running: waiting for jobs (Ctrl+C to stop)');
    const every = Number(opt.every ?? 5) * 1000;
    // Pay out the reward vault's vested share about once an hour: anyone may,
    // so every runner helps keep rewards flowing (a few cents of gas a day).
    const vault = s.vault ? new Contract(s.vault, B.RewardVault.abi, c.signer) : null;
    let lastVault = 0;
    for (;;) {
      try { await worker.tick(); } catch (e) { write(`tick failed: ${e.shortMessage ?? e.message}`); }
      if (vault && Date.now() - lastVault > 3_600_000) {
        lastVault = Date.now();
        try {
          if ((await vault.releasable()) > 0n) {
            await (await vault.release()).wait();
            write(`${new Date().toISOString()} reward vault: released the vested rewards`);
          }
        } catch (e) { write(`vault release failed: ${e.shortMessage ?? e.message}`); }
      }
      if (opt.once) return 0;
      await new Promise((r) => setTimeout(r, every));
    }
  }

  if (group === 'node' && cmd === 'register') {
    const c = await connect(s);
    const bond = opt.bond ? parseEther(String(opt.bond)) : await c.jobs.workerBond();
    await (await padded(c.jobs.register, { value: bond })).wait();
    write(`registered ${c.me} with a bond of ${zeta(bond)}`);
    return 0;
  }

  if (group === 'node' && cmd === 'status') {
    const c = await connect(s);
    const w = await c.jobs.workers(c.me);
    write(`runner:   ${c.me}`);
    write(`wallet:   ${zeta(await c.provider.getBalance(c.me))}`);
    write(`bond:     ${zeta(w.bond)} (${w.active ? 'active' : w.unbondAt ? 'leaving' : 'not registered'})`);
    write(`earned:   ${zeta(await c.jobs.credit(c.me))} (withdraw with "zetaphy node withdraw")`);
    write(`verdicts: ${w.agreed} agreed, ${w.rejected} rejected, ${await c.jobs.strikes(c.me)} strikes in the last 5${(await c.jobs.quarantined(c.me)) ? ' — QUARANTINED: out, bond unbonding; only a governance vote (release) lets this address register again' : ''}${(await c.jobs.isDefender(c.me)) ? ' (defender)' : ''}`);
    write(`network:  ${await c.jobs.activeWorkers()} active runners, ${await c.jobs.jobCount()} jobs, reward pool ${zeta(await c.jobs.rewardPool())}`);
    return 0;
  }

  if (group === 'node' && ['withdraw', 'unbond', 'withdraw-bond'].includes(cmd)) {
    const c = await connect(s);
    const fn = { withdraw: 'withdraw', unbond: 'requestUnbond', 'withdraw-bond': 'withdrawBond' }[cmd];
    await (await padded(c.jobs[fn])).wait();
    write(`${cmd}: done`);
    return 0;
  }

  if (group === 'job' && cmd === 'request') {
    const [chainKey, target] = rest;
    if (!chainKey || !target) throw new Error('usage: zetaphy job request <chain> <address> [--fee N]');
    const c = await connect(s);
    const fee = opt.fee ? parseEther(String(opt.fee)) : await c.jobs.minFee();
    // Padded gas: the request's cost depends on the load meter's minute, which
    // may change between the estimate (latest block) and the block it lands in.
    const rc = await (await padded(c.jobs.request, encodeBytes32String(chainKey), target, { value: fee })).wait();
    const ev = rc.logs.map((l) => { try { return c.jobs.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'JobRequested');
    write(`job ${ev.args.id} requested: ${chainKey} ${target}, fee ${zeta(fee)}`);
    return 0;
  }

  if (group === 'job' && cmd === 'settle') {
    if (!/^\d+$/.test(rest[0] ?? '')) throw new Error('usage: zetaphy job settle <id>');
    const c = await connect(s);
    const rc = await (await padded(c.jobs.settle, BigInt(rest[0]))).wait();
    const missed = rc.logs.map((l) => { try { return c.jobs.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === 'Missed');
    write(`job ${rest[0]} settled: ${missed.length ? missed.map((e) => `${e.args.worker} never revealed (penalized, one strike)`).join('; ') : 'nothing to penalize'}`);
    return 0;
  }

  if (group === 'job' && cmd === 'challenge') {
    if (!/^\d+$/.test(rest[0] ?? '')) throw new Error('usage: zetaphy job challenge <id> --verdict 0x<bytes32> [--bond N]');
    const claim = String(opt.verdict ?? '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(claim)) throw new Error('--verdict 0x<64 hex>: the verdict you say is right (from your own Neuro run; it must differ from the job\'s)');
    const c = await connect(s);
    const id = BigInt(rest[0]);
    const need = await c.jobs.challengeBondOf(id);
    const bond = opt.bond ? parseEther(String(opt.bond)) : need;
    if (bond < need) throw new Error(`the bond must be at least ${zeta(need)}`);
    const as = await c.jobs.assurance(id);
    await (await padded(c.jobs.challenge, id, claim, { value: bond })).wait();
    write(`job ${id} challenged with ${zeta(bond)}, claiming ${claim} (window was open until ${new Date(Number(as.challengeUntil) * 1000).toISOString()}): a challenge round draws 3 fresh runners;`);
    write('  overturned to your verdict: bond back + half of the slashed bonds · confirmed, or overturned to another verdict: you lose the bond');
    write('  no quorum: 80% back (20% to the seats that revealed), verdict marked disputed, and it may be challenged again (3 rounds in all)');
    return 0;
  }

  if (group === 'job' && cmd === 'get') {
    const c = await connect(s);
    const id = BigInt(rest[0] ?? cmd);
    const j = await c.jobs.getJob(id);
    const out = { status: STATUS[Number(j.status)], target: j.target, fee: zeta(j.fee), verdict: j.result, commits: Number(j.commits), reveals: Number(j.reveals) };
    if (j.status === 2n) {
      const as = await c.jobs.assurance(id);
      out.confirmedBy = Number(as.agreedBy); // "ยืนยันแล้วโดย N คน"
      out.challenge = CHALLENGE[Number(as.state)];
      const rounds = Number((await c.jobs.challengeRound(id)).count);
      if (rounds) out.challenges = rounds;
      out.challengeUntil = new Date(Number(as.challengeUntil) * 1000).toISOString();
      out.final = as.settled;
      if ((as.state === 0n || as.state === 4n) && !as.settled) out.challengeBond = zeta(await c.jobs.challengeBondOf(id));
    }
    write(JSON.stringify(out, null, 2));
    return 0;
  }

  if (group === 'deploy') {
    const c = await connect(s, { needJobs: false });
    const p = (k, d) => opt[k] ?? d;
    if (opt.control != null && !ADDR_RE.test(String(opt.control))) throw new Error('--control must be a 0x address (NeuroControl)');
    // NeuroControl first (unconfigured: no skill yet, so it takes no requests),
    // then NeuroJobs and setControl straight away, and only then the rest of
    // the setup. A request slipped in before setControl only gets skill 0
    // (runners skip it; it expires and refunds) and cannot block setControl.
    const fresh = opt.control ? null : await newControl(c, opt);
    const factory = new ContractFactory(ART.abi, ART.bytecode, c.signer);
    const contract = await factory.deploy(parseEther(String(p('bond', 100))), parseEther(String(p('reward', 1))), parseEther(String(p('min-fee', 0.1))),
      BigInt(p('window', 120)), BigInt(p('timeout', 600)), BigInt(p('unbond', 3600)), parseEther(String(p('daily-reward-cap', 100))));
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const nj = new Contract(address, ART.abi, c.signer);
    const control = opt.control ? String(opt.control) : fresh.address;
    await (await padded(nj.setControl, control)).wait();
    if (fresh) await configureControl(c, fresh, opt, write);
    if (opt.fund) await (await padded(nj.fund, { value: parseEther(String(opt.fund)) })).wait();
    settings({ ...opt, jobs: address }, {});
    write(`NeuroJobs deployed at ${address}${opt.fund ? `, reward pool ${opt.fund} ZETAPHY` : ''}, governed by NeuroControl ${control}`);
    return 0;
  }

  if (group === 'deploy-control') {
    const c = await connect(s, { needJobs: false });
    await deployControl(c, opt, write);
    return 0;
  }

  if (group === 'neuro' && cmd === 'skill-id') {
    write(skillId());
    if (opt.files) for (const f of skillFiles()) write(`  ${f}`);
    return 0;
  }

  if (group === 'neuro' && cmd === 'calldata') {
    write(neuroCall(rest[0], rest[1]).data);
    return 0;
  }

  if (group === 'neuro' && ['status', 'regrow', 'send', 'propose'].includes(cmd)) {
    const c = await connect(s);
    const addr = await c.jobs.control();
    if (addr === ZERO_ADDR) throw new Error('this NeuroJobs has no NeuroControl (deployed before governance)');
    const control = new Contract(addr, CONTROL.abi, c.signer);
    if (cmd === 'status') {
      const [paused, active, gov, maxBodies, regrowCap, fund, bodies, load, burned, defenders, roster] = await Promise.all([
        control.paused(), control.activeSkill(), control.governance(), control.maxBodies(), control.maxRegrowPerHour(), control.communityFund(),
        c.jobs.bodies(), c.jobs.load(), c.jobs.totalBurned(), c.jobs.defenders(), control.roster()]);
      const mine = skillId();
      write(`NeuroControl ${addr}, governance ${gov}${gov.toLowerCase() === GOV_MODULE.toLowerCase() ? ' (the chain\'s gov module)' : ''}`);
      write(`Neuro:      ${paused ? 'PAUSED (no new requests or commits; coin transfers are not affected)' : 'running'}`);
      write(`skill:      ${active}${active.toLowerCase() === mine.toLowerCase() ? ' (this machine runs it)' : ` (this machine runs ${mine})`}`);
      write(`bodies:     ${bodies} now (4 defenders + ceil(${Number(load) / 30} requests/min ÷ 6)), at most ${maxBodies}`);
      write(`defenders:  ${defenders.filter((d) => d !== ZERO_ADDR).length} of 4 seated; roster ${roster.length}; regrow at most ${regrowCap}/hour`);
      for (const [i, d] of defenders.entries()) write(`  seat ${i}: ${d === ZERO_ADDR ? '(vacant: zetaphy neuro regrow)' : d}`);
      const [chBond, chWindow, defTimeout] = await Promise.all([control.challengeBond(), control.challengeWindow(), control.defenderTimeout()]);
      write(`challenges: bond at least max(2 x fee, ${zeta(chBond)}), window ${chWindow === 0n ? `${await c.jobs.jobTimeout()} s (jobTimeout)` : `${chWindow} s`} after the quorum; defenders need a heartbeat every ${defTimeout} s`);
      write(`fees:       90% runners, 5% burned (${zeta(burned)} so far, locked at 0x…dEaD), 5% community fund ${fund}; a failed job refunds 95%`);
      const allowed = await Promise.all(SUPPORTED_CHAINS.map((ch) => control.chainAllowed(encodeBytes32String(ch))));
      write(`chains:     ${SUPPORTED_CHAINS.filter((_, i) => allowed[i]).join(' ') || '(none)'} accepted${allowed.every(Boolean) ? '' : `; not voted in: ${SUPPORTED_CHAINS.filter((_, i) => !allowed[i]).join(' ')}`}`);
      return 0;
    }
    if (cmd === 'regrow') {
      const rc = await (await c.jobs.regrow()).wait();
      const evs = rc.logs.map((l) => { try { return c.jobs.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      for (const e of evs) if (e.name === 'DefenderVacated') write(`seat ${e.args.seat}: vacated ${e.args.worker}`);
      for (const e of evs) if (e.name === 'DefenderSeated') write(`seat ${e.args.seat}: seated ${e.args.worker}`);
      if (!evs.some((e) => e.name === 'DefenderSeated')) write('regrow: nothing seated (seats full, no fit runner on the roster, or the hourly cap is reached)');
      return 0;
    }
    const call = neuroCall(rest[0], rest[1]);
    if (cmd === 'send') {
      await (await c.signer.sendTransaction({ to: addr, data: call.data })).wait();
      write(`${rest[0]}: done (sent by ${c.me})`);
      return 0;
    }
    if (!ADDR_RE.test(String(opt.multisig ?? ''))) throw new Error('usage: zetaphy neuro propose <action> [value] --multisig 0x<SimpleMultisig>');
    const ms = new Contract(String(opt.multisig), B.SimpleMultisig.abi, c.signer);
    const rc = await (await ms.propose(addr, 0n, call.data)).wait();
    const ev = rc.logs.map((l) => { try { return ms.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Proposed');
    write(`proposed ${rest[0]} to multisig ${opt.multisig}${ev ? ` as #${ev.args[0]}` : ''}; other owners: confirm, then execute`);
    return 0;
  }

  if (group === 'gate') {
    const c = await connect(s);
    const r = await gate1(c.provider, c.jobs, opt['block-seconds'] ? { gate: { days: 30, runners: 10, maxGapSeconds: 60, blockSeconds: Number(opt['block-seconds']) } } : {});
    write(`gate 1 at block ${r.height}: ${r.passed ? 'PASSED (still confirm the runners are different people)' : 'not yet'}`);
    for (const ch of r.checks) write(`  ${ch.ok ? '✓' : '·'} ${ch.name}: ${ch.value}`);
    return 0;
  }

  if (group === 'deploy-pq') {
    const c = await connect(s, { needJobs: false });
    const k = await new ContractFactory(QFACTORY.abi, QFACTORY.bytecode, c.signer).deploy();
    await k.waitForDeployment();
    const address = await k.getAddress();
    settings({ ...opt, pqFactory: address }, {});
    write(`QuantumWalletFactory ${address}`);
    return 0;
  }

  if (group === 'security') {
    return securityCommand({ cmd, rest, opt, env, write, s, connectRpc, loadOrCreatePq, loadOrCreateKey });
  }

  if (group === 'pq' && cmd === 'native') {
    // Native PQ account: the chain checks the ML-DSA-44 signature itself, so
    // no ECDSA key, contract or gas payer is involved. Same seed as "pq new".
    const [sub, a1, a2, a3] = rest;
    // [usage, fewest args, most args]
    const USAGE = {
      send: ['<0x… or zetaphy1…> <amount> [--gas N] [--as <owner>]', 2, 2],
      call: ['<to 0x…> <calldata 0x…> [--value <ZETAPHY>] [--gas <EVM gas, default 200000>] [--as <owner>]', 2, 2],
      'token-send': ['<token 0x…> <to 0x… or zetaphy1…> <amount> [--gas <EVM gas, default 200000>] [--as <owner>]', 3, 3],
      'token-balance': ['<token 0x…> [--as <owner>]', 1, 1],
      stake: ['<zetaphyvaloper1…> <amount> [--gas N] [--as <owner>]', 2, 2],
      unstake: ['<zetaphyvaloper1…> <amount> [--gas N] [--as <owner>]', 2, 2],
      rewards: ['<zetaphyvaloper1…> [--gas N] [--as <owner>]', 1, 1],
      deploy: ['<init code 0x…> [--value <ZETAPHY>] [--gas <EVM gas, default 3000000>] [--as <owner>]', 1, 1],
      handover: ['<owner 0x… or zetaphy1…> <new controller zetaphy1… or 0x…> [--gas N]', 2, 2],
      'lock-ecdsa': ['[<controller zetaphy1… or 0x…>] --yes', 0, 1],
    };
    if (sub && !Object.hasOwn(USAGE, sub)) throw new Error(`usage: zetaphy pq native [${Object.keys(USAGE).join(' | ')}] …`);
    if (sub && (rest.length - 1 < USAGE[sub][1] || rest.length - 1 > USAGE[sub][2])) throw new Error(`usage: zetaphy pq native ${sub} ${USAGE[sub][0]}`);
    const contractArg = (a, what) => {
      if (!ADDR_RE.test(String(a))) throw new Error(`${what} must be a 0x address (40 hex digits)`);
      return normalizeAddress(a).hex; // checks the EIP-55 checksum of a mixed-case address
    };
    const zetaArg = (a) => {
      const v = parseZeta(a);
      if (v <= 0n) throw new Error('amount must be more than 0');
      return v;
    };
    const hexArg = (a, what) => {
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(String(a))) throw new Error(`${what} must be 0x followed by whole bytes of hex`);
      return String(a);
    };
    if (opt.gas != null && !/^[1-9]\d*$/.test(String(opt.gas))) throw new Error('--gas must be a whole number');
    if (opt.value != null && !['call', 'deploy'].includes(sub)) throw new Error('--value is only for "pq native call" and "pq native deploy"');
    if (opt.value === true) throw new Error('--value needs an amount in ZETAPHY');
    const AS = [undefined, 'send', 'call', 'token-send', 'token-balance', 'stake', 'unstake', 'rewards', 'deploy'];
    if (opt.as != null && !AS.includes(sub)) throw new Error(`--as is not for "pq native ${sub}"`);
    if (opt.as === true) throw new Error('--as needs the address of a quantum-locked account (0x… or zetaphy1…)');
    const asOwner = opt.as != null ? normalizeAddress(String(opt.as)) : null;
    if (opt.yes != null && sub !== 'lock-ecdsa') throw new Error('--yes is only for "pq native lock-ecdsa"');
    const gas = opt.gas != null ? BigInt(opt.gas) : undefined;
    let args = {};
    if (sub === 'send') { normalizeAddress(a1); args = { value: zetaArg(a2) }; }
    if (sub === 'call') {
      const to = contractArg(a1, 'to');
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(String(a2))) throw new Error('calldata must be 0x followed by whole bytes of hex (0x for none)');
      args = { to, data: a2, value: opt.value != null ? parseZeta(opt.value) : 0n };
    }
    if (sub === 'deploy') {
      args = { initCode: hexArg(a1, 'init code'), value: opt.value != null ? parseZeta(opt.value) : 0n };
      if (args.initCode === '0x') throw new Error('init code must not be empty');
    }
    if (sub === 'token-send') {
      args = { token: contractArg(a1, 'token'), to: normalizeAddress(a2).hex };
      if (!/^(\d+(\.\d*)?|\.\d+)$/.test(String(a3))) throw new Error(`not an amount: ${a3}`);
    }
    if (sub === 'token-balance') args = { token: contractArg(a1, 'token') };
    if (['stake', 'unstake', 'rewards'].includes(sub)) {
      args = { validator: validatorAddress(a1) };
      if (sub !== 'rewards') args.value = zetaArg(a2);
    }
    if (sub === 'handover') args = { owner: normalizeAddress(a1), controller: normalizeAddress(a2) };
    if (sub === 'lock-ecdsa' && a1 != null) args = { controller: normalizeAddress(a1) };
    // --gas is EVM gas for calls, token sends and deploys, and for everything done --as an owner (a MsgEVMCall).
    const evmGas = ['call', 'token-send', 'deploy'].includes(sub) || (asOwner && sub);
    if (evmGas && gas != null && (gas < MIN_EVM_GAS_LIMIT || gas > MAX_EVM_GAS_LIMIT)) {
      throw new Error(`--gas (EVM gas) must be between ${MIN_EVM_GAS_LIMIT} and ${MAX_EVM_GAS_LIMIT}`);
    }

    const provider = await connectRpc(s);
    // lock-ecdsa to a given controller needs no ML-DSA seed on this machine.
    const pq = sub === 'lock-ecdsa' && args.controller ? null : loadOrCreatePq();
    // ZETAPHY_CHAIN_ID: the Cosmos chain id to expect (a local devnet is not zetaphy_77390-1).
    const client = pqClient((method, params) => provider.send(method, params), process.env.ZETAPHY_CHAIN_ID ? { chainId: process.env.ZETAPHY_CHAIN_ID } : {});
    const me = pq ? pqAddress(pq.publicKeyBytes) : null;
    const signer = pq ? { publicKey: pq.publicKeyBytes, sign: pq.signBytes } : null;
    const signed = `signed with ML-DSA-${PQ_VARIANT}`;
    const landed = (r) => write(`tx hash: ${r.txHash} (accepted by the node; it lands in a block within seconds)`);
    const noLogs = () => write('note: this is a Cosmos tx, so its EVM logs are not in eth_getLogs; balances are correct');
    // Who the action is for: this account, or the locked owner it acts for.
    const from = asOwner ?? me;
    const fromText = !me ? '' : asOwner ? `${asOwner.bech32} (${asOwner.hex}, quantum-locked to ${me.bech32}, which signed)` : `${me.bech32} (${me.hex})`;
    const as = asOwner ? { asOwner: asOwner.bech32 } : {};
    if (!sub) {
      if (asOwner) {
        const a = await client.account(asOwner.bech32);
        write(`account ${asOwner.bech32}`);
        write(`  ${asOwner.hex} (same account, EVM form)`);
        write(`balance: ${zeta(await client.balance(asOwner.hex))}`);
        write(a.quantumLockedTo
          ? `quantum-locked to: ${a.quantumLockedTo}${a.quantumLockedTo === me.bech32 ? ' (this account: it can act for it with --as)' : ' (not this account)'}`
          : 'not quantum-locked: its own key still signs for it');
        return 0;
      }
      write(`native PQ account (ML-DSA-${PQ_VARIANT} only, no ECDSA key):`);
      write(`  ${me.bech32}`);
      write(`  ${me.hex} (same account, EVM form)`);
      if (pq.created) write(`new ML-DSA seed saved to ${pq.file} (keep a backup; it is the only way to move funds)`);
      const acct = await client.account(me.bech32);
      write(`balance: ${zeta(await client.balance(me.hex))}`);
      write(acct.exists ? `on chain: account ${acct.accountNumber}, ${acct.sequence} txs sent`
        : 'not on chain yet: send ZETAPHY to this address first (either form works); then it can send');
      if (acct.quantumLockedTo) write(`quantum-locked to: ${acct.quantumLockedTo} (only that account can act for this one)`);
      return 0;
    }
    if (sub === 'lock-ecdsa') {
      const ctrl = args.controller ?? me;
      const { wallet } = loadOrCreateKey(); // the key itself is never printed
      const owner = normalizeAddress(wallet.address);
      write(`quantum lock: ${owner.hex} (${owner.bech32}, this machine's ECDSA key) -> controller ${ctrl.bech32}`);
      write('this is PERMANENT: afterwards the chain refuses every tx this ECDSA key signs (EVM and Cosmos), and ecrecover');
      write('no longer accepts its signatures. Only the controller can move its funds, tokens and stake (pq native --as).');
      write('Lose the controller\'s ML-DSA seed and this account is lost too.');
      if (!opt.yes) throw new Error('nothing sent: run again with --yes to lock for good');
      await client.checkController(ctrl.bech32, owner.bech32);
      const before = await client.account(owner.bech32);
      if (before.quantumLockedTo) throw new Error(`${owner.bech32} is already quantum-locked to ${before.quantumLockedTo}`);
      if ((await provider.getBalance(owner.hex)) === 0n) throw new Error(`${owner.hex} has no ZETAPHY for the gas of the lock tx`);
      const lock = quantumLockTx(ctrl.hex);
      const sent = await wallet.connect(provider).sendTransaction({ to: lock.to, value: lock.value, data: lock.data });
      write(`lock tx sent: ${sent.hash}`);
      let rc;
      try { rc = await sent.wait(); } catch (e) { rc = e.receipt; if (!rc) throw e; }
      if (rc.status !== 1) throw new Error(`the lock tx ${sent.hash} failed in block ${rc.blockNumber}: the account is not locked`);
      const after = await client.account(owner.bech32);
      if (after.quantumLockedTo !== ctrl.bech32) throw new Error(`the lock tx landed but the node reports quantumLockedTo = ${after.quantumLockedTo}`);
      write(`locked: ${owner.hex} is controlled by ${ctrl.bech32} from now on; act for it with --as ${owner.hex}`);
      return 0;
    }
    if (sub === 'handover') {
      const r = await client.quantumLockHandover({ ...signer, owner: args.owner.bech32, controller: args.controller.bech32, gasLimit: gas ?? DEFAULT_GAS_LIMIT });
      write(`handed control of ${r.owner.bech32} (${r.owner.hex}) from ${me.bech32} to ${r.controller.bech32}, fee ${formatZeta(r.fee)} ZETAPHY, ${signed}`);
      landed(r);
      return 0;
    }
    if (sub === 'send') {
      const r = await client.send({ ...signer, ...as, to: a1, amount: args.value, ...(asOwner ? { evmGasLimit: gas ?? DEFAULT_EVM_GAS_LIMIT } : { gasLimit: gas ?? DEFAULT_GAS_LIMIT }) });
      write(`sent ${formatZeta(r.amount)} ZETAPHY to ${r.to.bech32} (${r.to.hex}) from ${asOwner ? fromText : r.from.bech32}, fee ${formatZeta(r.fee)} ZETAPHY, ${signed}`);
      landed(r);
      return 0;
    }
    if (sub === 'call') {
      const r = await client.callEVM({ ...signer, ...as, to: args.to, data: args.data, value: args.value, evmGasLimit: gas ?? DEFAULT_EVM_GAS_LIMIT });
      write(`called ${r.to} from ${fromText} with ${(args.data.length - 2) / 2} bytes of calldata${args.value ? `, value ${formatZeta(args.value)} ZETAPHY` : ''}`);
      write(`EVM gas ${r.evmGasLimit}, tx gas ${r.gasLimit}, fee ${formatZeta(r.fee)} ZETAPHY, ${signed}`);
      if (r.result && r.result !== '0x') write(`the call returns (checked with eth_call): ${r.result}`);
      landed(r); noLogs();
      return 0;
    }
    if (sub === 'deploy') {
      const r = await client.deploy({ ...signer, ...as, initCode: args.initCode, value: args.value, evmGasLimit: gas ?? DEFAULT_DEPLOY_GAS_LIMIT });
      write(`created contract ${r.created} from ${fromText}${args.value ? `, value ${formatZeta(args.value)} ZETAPHY` : ''}`);
      write(`EVM gas ${r.evmGasLimit}, tx gas ${r.gasLimit}, fee ${formatZeta(r.fee)} ZETAPHY, ${signed}`);
      landed(r); noLogs();
      return 0;
    }
    if (sub === 'token-balance' || sub === 'token-send') {
      const t = await tokenInfo(provider, args.token);
      write(`token ${t.symbol} at ${args.token} (${t.decimals} decimals)`);
      if (sub === 'token-balance') {
        write(`${from.bech32} (${from.hex}) holds ${tokenAmount(await t.balanceOf(from.hex), t.decimals)} ${t.symbol}`);
        return 0;
      }
      let units;
      try { units = parseUnits(String(a3), t.decimals); } catch { throw new Error(`${a3} has more decimal places than ${t.symbol} (${t.decimals})`); }
      if (units <= 0n) throw new Error('amount must be more than 0');
      const r = await client.callEVM({ ...signer, ...as, to: args.token, data: ERC20.encodeFunctionData('transfer', [args.to, units]), evmGasLimit: gas ?? DEFAULT_EVM_GAS_LIMIT,
        checkResult: (ret) => {
          if (ret && ret !== '0x' && !ERC20.decodeFunctionResult('transfer', ret)[0]) throw new Error('the token refused the transfer (transfer returned false), so nothing was sent');
        } });
      write(`sent ${tokenAmount(units, t.decimals)} ${t.symbol} to ${args.to} from ${fromText}, fee ${formatZeta(r.fee)} ZETAPHY, ${signed}`);
      landed(r); noLogs();
      return 0;
    }
    // Staking: a Cosmos message, or with --as the staking/distribution precompile called as the owner.
    const opts = { ...signer, ...as, validator: args.validator, amount: args.value,
      ...(asOwner ? { evmGasLimit: gas ?? DEFAULT_PRECOMPILE_GAS_LIMIT } : { gasLimit: gas ?? DEFAULT_STAKING_GAS_LIMIT }) };
    const via = asOwner ? ' (through the staking precompile)' : '';
    if (sub === 'stake') {
      const r = await client.delegate(opts);
      write(`staked ${formatZeta(args.value)} ZETAPHY with ${r.validator} from ${asOwner ? fromText : me.bech32}${via}, fee ${formatZeta(r.fee)} ZETAPHY, ${signed}`);
      landed(r);
      return 0;
    }
    if (sub === 'unstake') {
      const r = await client.undelegate(opts);
      write(`unstaking ${formatZeta(args.value)} ZETAPHY from ${r.validator}${asOwner ? ` for ${fromText}` : ''}${via} (it comes back after the unbonding period), fee ${formatZeta(r.fee)} ZETAPHY, ${signed}`);
      landed(r);
      return 0;
    }
    if (sub === 'rewards') {
      const r = await client.withdrawRewards(opts);
      write(`withdrew staking rewards from ${r.validator} to ${asOwner ? fromText : me.bech32}${asOwner ? ' (through the distribution precompile)' : ''}, fee ${formatZeta(r.fee)} ZETAPHY, ${signed}`);
      landed(r);
      return 0;
    }
  }

  if (group === 'pq') {
    if (!s.pqFactory) throw new Error('no QuantumWalletFactory yet: --pqFactory 0x... or "zetaphy deploy-pq"');
    const c = await connect(s, { needJobs: false });
    const pq = loadOrCreatePq();
    const ecdsaOwner = s.pqHybrid ? c.me : ZERO_ADDR;
    const factory = new Contract(s.pqFactory, QFACTORY.abi, c.signer);
    const address = await factory.predict(ecdsaOwner, PQ_VARIANT, pq.keyHash);
    const deployed = (await c.provider.getCode(address)) !== '0x';
    const mode = s.pqHybrid ? 'hybrid: ML-DSA + ECDSA' : 'post-quantum only: ML-DSA';
    if (cmd === 'new' || cmd === 'address') {
      write(`quantum-safe wallet: ${address} (${mode}, ML-DSA-${PQ_VARIANT})${deployed ? '' : ' - not deployed yet; it can receive funds already'}`);
      if (pq.created) write(`new ML-DSA seed saved to ${pq.file} (keep a backup; it is the only way to move funds)`);
      write(`balance: ${zeta(await c.provider.getBalance(address))}`);
      return 0;
    }
    if (cmd === 'send') {
      const [to, amount] = rest;
      if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? '') || !amount) throw new Error('usage: zetaphy pq send <0x address> <amount>');
      if (!deployed) await (await factory.create(ecdsaOwner, PQ_VARIANT, pq.keyHash)).wait();
      const wallet = new Contract(address, QWALLET.abi, c.signer);
      const value = parseEther(String(amount));
      const deadline = BigInt((await c.provider.getBlock('latest')).timestamp) + 600n;
      const digest = await wallet.digest(to, value, '0x', deadline);
      const ecdsaSig = s.pqHybrid ? c.signer.signer.signingKey.sign(digest).serialized : '0x';
      const args = [to, value, '0x', deadline, [pq.publicKey, pq.sign(digest), ecdsaSig]];
      // Cosmos EVM charges at least half the gas limit, so ask for what it needs, not a round number.
      const gasLimit = (await wallet.execute.estimateGas(...args)) * 12n / 10n;
      const rc = await (await wallet.execute(...args, { gasLimit })).wait();
      write(`sent ${zeta(value)} to ${to} from ${address}, signed with ML-DSA-${PQ_VARIANT} (gas ${rc.gasUsed})`);
      return 0;
    }
  }

  if (group === 'keys' && cmd === 'encrypt') {
    const done = [sealWorkerKey() && 'worker.key', sealPqSeed() && 'pq.seed'].filter(Boolean);
    write(done.length ? `encrypted: ${done.join(', ')} (keep ZETAPHY_PASSPHRASE safe: without it the keys are lost)` : 'no plain key files to encrypt');
    return 0;
  }

  if (group === 'deploy-vault') {
    // Shares: NeuroJobs' reward pool (through fund()) and, optionally, an
    // address that rewards validators.
    const c = await connect(s);
    const vShare = opt.validators ? Number(opt['validators-share'] ?? 30) : 0;
    if (opt.validators && !ADDR_RE.test(String(opt.validators))) throw new Error('--validators must be a 0x address');
    if (!(vShare >= 0 && vShare < 100)) throw new Error('--validators-share must be 0-99 (percent)');
    const shares = [{ to: s.jobs, bps: (100 - vShare) * 100, callFund: true }];
    if (vShare) shares.push({ to: String(opt.validators), bps: vShare * 100, callFund: false });
    const gov = governanceOf(opt, write) ?? c.me;
    const v = await new ContractFactory(B.RewardVault.abi, B.RewardVault.bytecode, c.signer).deploy(gov, shares);
    await v.waitForDeployment();
    const address = await v.getAddress();
    if (opt.fund) await (await c.signer.sendTransaction({ to: address, value: parseEther(String(opt.fund)) })).wait();
    settings({ ...opt, vault: address }, env);
    write(`RewardVault ${address}: ${shares.map((x) => `${x.bps / 100}% to ${x.to}`).join(', ')}${opt.fund ? `, pool ${opt.fund} ZETAPHY` : ''}`);
    write('it releases 10% of what remains per year; nobody can withdraw faster. Move the rewards account into it with --fund.');
    return 0;
  }

  if (group === 'vault') {
    if (!s.vault) throw new Error('set the vault: --vault 0x... (or ZETAPHY_VAULT)');
    const c = await connect(s, { needJobs: false });
    const v = new Contract(s.vault, B.RewardVault.abi, c.signer);
    if (cmd === 'release') {
      const due = await v.releasable();
      if (due === 0n) { write('nothing vested yet (releases are daily)'); return 0; }
      await (await v.release()).wait();
      write(`released ${zeta(due)}`);
      return 0;
    }
    const [bal, due, day, shares, pendingAt] = await Promise.all([
      c.provider.getBalance(s.vault), v.releasable(), v.daysElapsed(), v.shares(), v.pendingAt()]);
    write(`pool: ${zeta(bal)} (day ${day}); vested now: ${zeta(due)}; next year: ${zeta(bal / 10n)}`);
    for (const sh of shares) write(`  ${Number(sh.bps) / 100}% to ${sh.to}${sh.callFund ? ' (via fund())' : ''}`);
    if (pendingAt > 0n) write(`recipients change announced: applies after ${new Date(Number(pendingAt) * 1000).toISOString()}`);
    return 0;
  }

  if (group === 'deploy-multisig') {
    const owners = String(opt.owners ?? '').split(',').filter(Boolean);
    if (owners.length < 2 || !owners.every((o) => ADDR_RE.test(o))) throw new Error('usage: zetaphy deploy-multisig --owners 0xA,0xB,0xC [--threshold 2]');
    const c = await connect(s, { needJobs: false });
    const k = await new ContractFactory(B.SimpleMultisig.abi, B.SimpleMultisig.bytecode, c.signer).deploy(owners, Number(opt.threshold ?? 2));
    await k.waitForDeployment();
    write(`SimpleMultisig ${await k.getAddress()} (${opt.threshold ?? 2} of ${owners.length})`);
    // The bridge's gates (zetaphy bridge open) want 3+ distinct owners, threshold 2+, none of them this deployer key.
    if (owners.length < 3 || Number(opt.threshold ?? 2) < 2) write('warning: zetaphy bridge open refuses a multisig with fewer than 3 owners or a threshold below 2');
    if (owners.some((o) => o.toLowerCase() === c.me.toLowerCase())) write(`warning: this deployer key ${c.me} is an owner: zetaphy bridge open refuses that; each owner should be a hardware wallet of its own`);
    return 0;
  }

  const ZERO_HASH = '0x' + '0'.repeat(64);
  /** Targets → [label, ThreatRegistry key]: fp1:<hex>, code:0x<hash>, <chainId>:0x<addr>, or 0x<addr> (address + its code). */
  async function threatKeys(reg, provider, targets, usage = 'bad target') {
    const keys = [];
    for (const t of targets) {
      let m;
      if ((m = /^fp1:([0-9a-f]{64})$/i.exec(t))) keys.push([t, '0x' + m[1].toLowerCase()]);
      else if ((m = /^code:(0x[0-9a-fA-F]{64})$/.exec(t))) keys.push([t, await reg.codeKey(m[1])]);
      else if ((m = /^(\d+):(0x[0-9a-fA-F]{40})$/.exec(t))) keys.push([t, await reg.addressKey(BigInt(m[1]), m[2])]);
      else if (ADDR_RE.test(t)) {
        keys.push([`${t} (address on ZETAPHY)`, await reg.addressKey(EVM_CHAIN_ID, t)]);
        const code = await provider.getCode(t);
        if (code !== '0x') keys.push([`${t} (its code ${keccak256(code)})`, await reg.codeKey(keccak256(code))]);
      } else throw new Error(`${t}: not a target. ${usage}`);
    }
    return keys;
  }
  /**
   * A flag's evidence: [reportHash, uri]. --evidence 0x<64 hex> (a Neuro reportHash, or the hash of
   * another reproducible report), or neuro:<chain>:<address> to run Neuro here and use its reportHash.
   */
  async function threatEvidence(opt, write) {
    const ev = String(opt.evidence ?? '');
    let uri = typeof opt.uri === 'string' ? opt.uri : '';
    let m, hash;
    if ((m = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(ev))) hash = '0x' + m[1].toLowerCase();
    else if ((m = /^neuro:([a-z0-9-]{1,32}):(\S{1,128})$/.exec(ev))) {
      const { readContract } = await import('../zetaphy-neuro/src/reader.js');
      const report = await readContract(m[1], m[2]);
      hash = '0x' + report.reportHash;
      if (!uri) uri = `neuro:${m[1]}:${report.address ?? m[2]}`;
      write(`Neuro report of ${m[1]} ${m[2]}: reportHash ${hash} (reproduce: node zetaphy-neuro/cli.js ${m[1]} ${m[2]} --json)`);
    } else throw new Error('--evidence <reportHash: 0x + 64 hex> or neuro:<chain>:<address>: every flag carries reproducible evidence');
    if (/^0x0{64}$/.test(hash)) throw new Error('--evidence: not a zero hash');
    if (Buffer.byteLength(uri) > 200) throw new Error('--uri: at most 200 bytes');
    return [hash, uri];
  }
  /** Targets -> [label, key, chainId, account]: who answers for each key (respond / appeal). fp1: and code: need a named responder. */
  async function threatSubjects(reg, provider, targets) {
    const out = [];
    for (const t of targets) {
      let m;
      if ((m = /^(\d+):(0x[0-9a-fA-F]{40})$/.exec(t))) out.push([t, await reg.addressKey(BigInt(m[1]), m[2]), BigInt(m[1]), m[2]]);
      else if (ADDR_RE.test(t)) {
        out.push([`${t} (address on ZETAPHY)`, await reg.addressKey(EVM_CHAIN_ID, t), EVM_CHAIN_ID, t]);
        const code = await provider.getCode(t);
        if (code !== '0x') out.push([`${t} (its code: only its governance-named responder)`, await reg.codeKey(keccak256(code)), 0n, ZERO_ADDR]);
      } else for (const [label, key] of await threatKeys(reg, provider, [t])) out.push([label, key, 0n, ZERO_ADDR]);
    }
    return out;
  }
  /** A ThreatRegistry governance call: sent when this key is governance, else printed for a multisig / gov proposal. */
  async function governAction(reg, c, write, fn, args, what) {
    const gov = String(await reg.governance());
    if (gov.toLowerCase() === c.me.toLowerCase()) {
      await (await reg[fn](...args)).wait();
      write(`ThreatRegistry: ${what} (done)`);
      return true;
    }
    const data = reg.interface.encodeFunctionData(fn, args);
    const hint = await timelockHint(c.provider, gov, reg.target, data);
    if (hint) { write(`ThreatRegistry: to ${what}, ${hint.join('\n')}`); return false; }
    write(`ThreatRegistry governance is ${gov}, not this key. To ${what}, have it call:\n  to ${reg.target}\n  data ${data}`);
    if (gov.toLowerCase() === GOV_MODULE.toLowerCase()) write('  (the gov module: submit this as a MsgEVMCall proposal)');
    return false;
  }

  if (group === 'deploy-bridge') {
    // With a ThreatRegistry, the source LockBox must be protected (else two runners could hold every transfer
    // of the route, and the LockBox has no refund path): --lockbox, or an explicit --no-lockbox-protect.
    if (s.threats && opt.lockbox == null && !opt['no-lockbox-protect']) {
      throw new Error('deploy-bridge with a ThreatRegistry needs --lockbox <source chain id>:0x<LockBox>, so the source lockbox is protected (or pass --no-lockbox-protect to deploy without that, and protect it later: zetaphy threat protect <chainId>:0x<LockBox>)');
    }
    if (opt.lockbox != null && !/^\d+:0x[0-9a-fA-F]{40}$/.test(String(opt.lockbox))) throw new Error('--lockbox must be <source chain id>:0x<LockBox>');
    if (opt.control != null && !ADDR_RE.test(String(opt.control))) throw new Error('--control must be a 0x address (NeuroControl)');
    if (opt.enable || opt.open) throw new Error('deploy-bridge deploys the bridge CLOSED; open it with zetaphy bridge open once every gate is met');
    const hyp = opt['hyperlane-mailbox'];
    if (hyp != null && (!ADDR_RE.test(String(hyp)) || !opt.lockbox)) throw new Error('--hyperlane-mailbox 0x<Mailbox on ZETAPHY> needs --lockbox <chainId>:0x<HyperlaneLockBox>');
    if (opt['hyperlane-outbox'] && hyp == null) throw new Error('--hyperlane-outbox needs --hyperlane-mailbox 0x<Mailbox on ZETAPHY> and --lockbox <chainId>:0x<HyperlaneLockBoxV2>');
    const markers = [].concat(opt.marker ?? []).map(String);
    if (markers.some((m) => !ADDR_RE.test(m))) throw new Error('--marker must be a 0x address (the key that may mark addresses, e.g. the bridge monitor\'s)');
    const devnet = devnetOf(s.rpc, opt);
    const decimals = Number(opt.decimals ?? 18);
    const limitUnits = parseUnits(String(opt['daily-limit'] ?? STARTER_UNITS), decimals);
    const capP = capProblems({ limitUnits, decimals, raiseCap: !!opt['raise-cap'], maxDailyLimit: STARTER_UNITS * 10n ** BigInt(decimals) });
    if (capP.length) throw new Error(`--daily-limit: ${capP.join('; ')}`);
    const c = await connect(s);
    // --testnet: only on the public ZETAPHY testnet; 2-owner multisigs and a 100-token daily limit
    const testnet = await testnetOf(c.provider, opt);
    if (testnet) {
      write = testnetWrite(write);
      const capT = capProblems({ limitUnits, decimals, testnet: true });
      if (capT.length) throw new Error(`--daily-limit: ${capT.join('; ')}`);
    }
    // Roles named here must be multisigs (or the gov module), checked before anything is deployed.
    const gov = governanceOf(opt, write);
    const guardians = [].concat(opt.guardian ?? []).map(String);
    if (guardians.some((g) => !ADDR_RE.test(g))) throw new Error('--guardian must be a 0x address (a multisig)');
    if (gov || guardians.length) {
      const r = await roleChecks(c.provider, { governance: gov ? [gov] : [], guardians }, { deployer: c.me, devnet, allowEoa: !!opt['allow-eoa-for-testing'], testnet });
      const problems = r.problems.filter((p) => guardians.length || !/^no guardian/.test(p));
      for (const w of r.warnings) write(`warning: ${w}`);
      if (problems.length) throw new Error(`deploy-bridge refused (nothing deployed):\n  - ${problems.join('\n  - ')}`);
    }
    const deploy = async (a, args) => { const k = await new ContractFactory(a.abi, a.bytecode, c.signer).deploy(...args); await k.waitForDeployment(); return new Contract(await k.getAddress(), a.abi, c.signer); };
    const route = encodeBytes32String('airlock');
    const guard = await deploy(B.BridgeGuard, [c.me]);
    await (await guard.createToken(String(opt['token-name'] ?? 'USD Coin (bridged, testnet)'), String(opt['token-symbol'] ?? 'USDC'), decimals)).wait();
    const airlock = await deploy(B.BridgeAirlock, [guard.target, route, c.me, Number(opt.threshold ?? 2), BigInt(opt.quarantine ?? 3600)]);
    // CLOSED: the route is set up but disabled; BridgeGuard itself refuses to enable it without the audit and 2+ independent lanes.
    await (await guard.setRoute(route, airlock.target, limitUnits, false)).wait();
    // A runner needs this many accepted verdicts (won by lottery) before it speaks for the bridge.
    // --control: NeuroControl; while it says paused the lane attests nothing. Default: the NeuroJobs' own control().
    const control = opt.control ? String(opt.control) : String(await c.jobs.control());
    if (control === ZERO_ADDR) write('warning: NeuroJobs has no NeuroControl, so NeuroLane has no pause switch (pass --control 0x...)');
    const lane = await deploy(B.NeuroLane, [s.jobs, airlock.target, Number(opt.quorum ?? 2), Number(opt['min-agreed'] ?? 5), control]);
    for (const tx of [airlock.setLane(lane.target, true), airlock.setVetoer(lane.target, true)]) await (await tx).wait();
    // Markers: keys that may mark an address (its bridge transfers wait until governance untrips it); they move no funds.
    for (const m of markers) { await (await airlock.setMarker(m, true)).wait(); write(`marker ${m}: may mark addresses (BridgeAirlock.trip)`); }
    // The second lane: Hyperlane (its Mailbox on ZETAPHY; messages from the source chain's HyperlaneLockBox).
    let hypLane = null, outbox = null;
    if (hyp) {
      const [srcId, srcAddr] = String(opt.lockbox).split(':');
      const sender = String(opt['hyperlane-sender'] ?? srcAddr);
      if (!ADDR_RE.test(sender)) throw new Error('--hyperlane-sender must be a 0x address (the source HyperlaneLockBox or router)');
      const ism = opt['hyperlane-ism'] ? String(opt['hyperlane-ism']) : ZERO_ADDR;
      if (!ADDR_RE.test(ism)) throw new Error('--hyperlane-ism must be a 0x address');
      hypLane = await deploy(B.HyperlaneLane, [airlock.target, c.me, String(hyp), Number(opt['hyperlane-origin'] ?? srcId), '0x' + sender.slice(2).toLowerCase().padStart(64, '0'), BigInt(srcId), srcAddr, ism]);
      await (await airlock.setLane(hypLane.target, true)).wait();
      write(`HyperlaneLane: Mailbox ${hyp}, origin domain ${opt['hyperlane-origin'] ?? srcId}, sender ${sender}, ISM ${ism === ZERO_ADDR ? "the Mailbox's default" : ism}`);
      // The way back (Saphan v2): burn through the guard's outbound-only route, dispatch a release to the lockbox.
      if (opt['hyperlane-outbox']) {
        const outRoute = encodeBytes32String('out');
        outbox = await deploy(B.HyperlaneOutbox, [guard.target, outRoute, String(hyp), Number(opt['hyperlane-origin'] ?? srcId), BigInt(srcId),
          '0x' + srcAddr.slice(2).toLowerCase().padStart(64, '0'), ZERO_ADDR]);
        await (await guard.setOutboundRoute(outRoute, outbox.target, limitUnits, false)).wait();
        write(`HyperlaneOutbox: releases to ${srcId}:${srcAddr} (domain ${opt['hyperlane-origin'] ?? srcId}); outbound route CLOSED`);
      }
    }
    for (const l of [].concat(opt.lane ?? [])) await (await airlock.setLane(l, true)).wait();
    for (const g of guardians) { await (await airlock.setVetoer(g, true)).wait(); await (await guard.setGuardian(g, true)).wait(); }
    // Vaccine: flagged senders, source contracts and recipient code are held / refused.
    if (s.threats) {
      if (!ADDR_RE.test(String(s.threats))) throw new Error('--threats must be a 0x address (ThreatRegistry)');
      for (const tx of [airlock.setThreats(s.threats), guard.setThreats(s.threats)]) await (await tx).wait();
      write(`vaccine on: BridgeAirlock and BridgeGuard check ThreatRegistry ${s.threats}`);
      // The bridge's own parts must never be frozen by a runner flag: protect their addresses and code hashes.
      const reg = new Contract(s.threats, B.ThreatRegistry.abi, c.signer);
      const own = [guard.target, await guard.token(), airlock.target, lane.target, ...(hypLane ? [hypLane.target] : []), ...(outbox ? [outbox.target] : [])];
      const keys = await threatKeys(reg, c.provider, [...own, ...(opt.lockbox ? [String(opt.lockbox)] : [])]);
      await governAction(reg, c, write, 'setProtected', [keys.map((k) => k[1]), true], `protect the bridge's own contracts${opt.lockbox ? ' and the lockbox' : ''}`);
      if (!opt.lockbox) write('WARNING: --no-lockbox-protect: the source lockbox is NOT protected; protect it now: zetaphy threat protect <chainId>:0x<LockBox>');
    } else write('warning: no ThreatRegistry (--threats or deploy-threats), so flagged code is not refused by the bridge');
    if (gov) {
      for (const k of [guard, airlock, ...(hypLane ? [hypLane] : [])]) await (await k.setGovernance(gov)).wait();
      write(`admin of BridgeGuard, BridgeAirlock${hypLane ? ' and HyperlaneLane' : ''} handed to ${gov}`);
    }
    settings({ ...opt, airlock: airlock.target, neuroLane: lane.target, bridgeGuard: guard.target, ...(hypLane ? { hyperlaneLane: hypLane.target } : {}),
      ...(outbox ? { hyperlaneOutbox: outbox.target } : {}) }, {});
    write(`BridgeGuard ${guard.target}\nBridgedToken ${await guard.token()}\nBridgeAirlock ${airlock.target}\nNeuroLane ${lane.target}${hypLane ? `\nHyperlaneLane ${hypLane.target}` : ''}${outbox ? `\nHyperlaneOutbox ${outbox.target}` : ''}`);
    write(`bridge CLOSED (route disabled, daily limit ${tokenAmount(limitUnits, decimals)}, hard cap ${tokenAmount(await guard.maxDailyLimit(), decimals)}).`);
    write('To open: a second independent lane, an audit, 10+ Neuro runners, multisig guardian + governance, then zetaphy bridge open --audit-report <url> --audit-sha256 <hex>');
    return 0;
  }

  if (group === 'deploy-timelock' || group === 'timelock') {
    return timelockCommand({ group, cmd, rest, opt, write, s, connect, saveSettings: (o) => settings({ ...opt, ...o }, {}) });
  }

  if (group === 'deploy-oracle' || group === 'oracle') {
    return oracleCommand({ group, cmd, rest, opt, env, write, s, connect, saveSettings: (o) => settings({ ...opt, ...o }, {}) });
  }

  if (group === 'bridge' && ['open', 'gates', 'close', 'pause', 'cap', 'marker', 'untrip', 'monitor'].includes(cmd)) {
    return bridgeCommand({ group, cmd, rest, opt, env, write, s, connect, connectRpc });
  }

  if (group === 'bridge' && cmd === 'watch') {
    if (!opt['source-rpc'] || !opt.lockbox) throw new Error('usage: zetaphy bridge watch --source-rpc URL --lockbox 0x... [--confirmations 12 --release]');
    if (!s.airlock || !s.neuroLane) throw new Error('set --airlock and --neuroLane (or run deploy-bridge)');
    const c = await connect(s, { needJobs: false });
    const src = new JsonRpcProvider(String(opt['source-rpc']));
    const srcChainId = (await src.getNetwork()).chainId;
    const lane = new Contract(s.neuroLane, B.NeuroLane.abi, c.signer);
    const log = (l) => write(`${new Date().toISOString()} ${l}`);
    // Fail closed: while the lane's control() or the switch's paused() cannot be read (after retries), nothing is attested.
    const control = laneControl(lane, (a) => new Contract(a, ['function paused() view returns (bool)'], c.provider), { log });
    const watcher = createLaneWatcher({
      lockbox: new Contract(String(opt.lockbox), B.LockBox.abi, src),
      lane,
      control,
      airlock: new Contract(s.airlock, B.BridgeAirlock.abi, c.signer),
      me: c.me, srcChainId, confirmations: Number(opt.confirmations ?? 12), release: !!opt.release,
      stateFile: join(HOME, `lane-${srcChainId}-${String(opt.lockbox).toLowerCase()}.json`),
      chainTime: async () => BigInt((await c.provider.getBlock('latest')).timestamp),
      log,
    });
    const every = Number(opt.every ?? 5) * 1000;
    for (;;) {
      try { await watcher.tick(); } catch (e) { write(`tick failed: ${e.shortMessage ?? e.message}`); }
      if (opt.once) return 0;
      await new Promise((r) => setTimeout(r, every));
    }
  }

  if (group === 'deploy-threats') {
    const c = await connect(s);
    const delay = BigInt(opt['enforce-delay'] ?? 3600);
    // This key is governance at first, so deploy-bridge can protect the bridge's keys; --governance hands it on.
    const k = await new ContractFactory(B.ThreatRegistry.abi, B.ThreatRegistry.bytecode, c.signer)
      .deploy(s.jobs, Number(opt.quorum ?? 3), Number(opt['min-agreed'] ?? 5), c.me, delay);
    await k.waitForDeployment();
    const addr = await k.getAddress();
    settings({ ...opt, threats: addr }, {});
    write(`ThreatRegistry ${addr} (quorum ${opt.quorum ?? 3}, runners need ${opt['min-agreed'] ?? 5} accepted verdicts, flags enforced after ${delay}s)`);
    const regc = new Contract(addr, B.ThreatRegistry.abi, c.signer);
    if (opt['fast-quorum'] != null) {
      if (!/^\d{1,3}$/.test(String(opt['fast-quorum']))) throw new Error('--fast-quorum: a number above --quorum, or 0 (no fast lane)');
      await (await regc.setFastQuorum(Number(opt['fast-quorum']))).wait();
    }
    const fq = await regc.fastQuorum();
    write(fq === 0n ? 'fast lane: off (only enforceNow by governance or a guardian)' : `fast lane: a flag ${fq} runners stand behind is enforced at once`);
    if (opt['hold-delay'] != null) {
      if (!/^\d{1,8}$/.test(String(opt['hold-delay']))) throw new Error('--hold-delay: seconds, below --enforce-delay (0: a flag holds bridging at once)');
      await (await regc.setHoldDelay(BigInt(opt['hold-delay']))).wait();
    }
    write(`bridge holds: a flag holds bridging after ${await regc.holdDelay()}s (at once: fast lane, or holdNow by governance or a guardian)`);
    for (const g of [].concat(opt.guardian ?? [])) {
      if (!ADDR_RE.test(String(g))) throw new Error('--guardian must be a 0x address');
      await (await regc.setGuardian(String(g), true)).wait();
      write(`guardian ${g}: may enforce standing flags at once (enforceNow)`);
    }
    // Right of reply and appeal: kept appeal bonds go to the community fund (appeals stay off without one).
    if (opt['community-fund'] != null) {
      if (!ADDR_RE.test(String(opt['community-fund']))) throw new Error('--community-fund must be a 0x address');
      const bond = parseEther(String(opt['appeal-bond'] ?? '1'));
      await (await regc.setAppeals(bond, BigInt(opt['appeal-window'] ?? 14 * 86400), String(opt['community-fund']))).wait();
      write(`appeals on: bond ${zeta(bond)}, kept bonds to ${opt['community-fund']}`);
    } else write('appeals off until governance sets a community fund (zetaphy threat appeals-set); responses work already');
    if (opt.identity != null) {
      if (!ADDR_RE.test(String(opt.identity))) throw new Error('--identity must be a 0x address (NeuroIdentity)');
      await (await regc.setIdentity(String(opt.identity))).wait();
      write(`claimed NeuroIdentity owners (${opt.identity}) may answer for their addresses`);
    }
    if (opt.governance != null) {
      const g = neuroGovernance(String(opt.governance));
      if (!ADDR_RE.test(g)) throw new Error('--governance must be a 0x address or "gov"');
      await (await new Contract(addr, B.ThreatRegistry.abi, c.signer).setGovernance(g)).wait();
      write(`ThreatRegistry governance handed to ${g} (protect keys through it: zetaphy threat protect ...)`);
    } else write(`ThreatRegistry governance: this key (${c.me}); hand it on with zetaphy threat set-governance <multisig|gov>`);
    return 0;
  }

  if (group === 'threat' && ['enforce-delay', 'set-governance'].includes(cmd)) {
    if (!s.threats) throw new Error('set --threats 0x<ThreatRegistry> (or run deploy-threats)');
    const c = await connect(s, { needJobs: false });
    const reg = new Contract(s.threats, B.ThreatRegistry.abi, c.signer);
    if (cmd === 'enforce-delay') {
      if (!/^\d{1,8}$/.test(String(rest[0] ?? ''))) throw new Error('usage: zetaphy threat enforce-delay <seconds, at most 2592000>');
      await governAction(reg, c, write, 'setEnforceDelay', [BigInt(rest[0])], `enforce flags after ${rest[0]}s`);
    } else {
      const g = neuroGovernance(String(rest[0] ?? ''));
      if (!ADDR_RE.test(g)) throw new Error('usage: zetaphy threat set-governance <0x multisig | gov>');
      await governAction(reg, c, write, 'setGovernance', [g], `hand ThreatRegistry governance to ${g}`);
    }
    return 0;
  }

  if (group === 'threat' && ['flag', 'clear', 'check', 'protect', 'unprotect'].includes(cmd)) {
    const usage = 'usage: zetaphy threat flag|clear|check|protect|unprotect <fp1:hex | code:0x<codehash> | 0x<contract> | <chainId>:0x<address>>... [--reason <code fact> --evidence <reportHash> --uri ...]';
    if (!rest.length) throw new Error(usage);
    if (!s.threats) throw new Error('set --threats 0x<ThreatRegistry> (or run deploy-threats)');
    const c = await connect(s, { needJobs: false });
    const reg = new Contract(s.threats, B.ThreatRegistry.abi, c.signer);
    // Every target becomes one or more registry keys, with a label for the output.
    const keys = await threatKeys(reg, c.provider, rest, usage);
    if (cmd === 'protect' || cmd === 'unprotect') {
      await governAction(reg, c, write, 'setProtected', [keys.map((k) => k[1]), cmd === 'protect'], `${cmd} ${keys.map((k) => k[0]).join(', ')}`);
      return 0;
    }
    const { REASONS, DISCLAIMER } = await import('./src/vaccine.js');
    if (cmd === 'check') {
      write(DISCLAIMER.en);
      for (const [label, key] of keys) {
        const [flagged, reason] = await reg.isFlagged(key);
        const from = flagged ? await reg.enforcedFrom(key) : 0n;
        const now = BigInt((await c.provider.getBlock('latest')).timestamp);
        const fast = flagged && (await reg.entries(key)).fast;
        const when = !flagged ? '' : fast ? ', enforced (fast lane)' : from <= now ? ', enforced' : `, warning only until ${new Date(Number(from) * 1000).toISOString()} (then enforced)`;
        const prot = (await reg.protectedKey(key)) ? ' (protected by governance)' : '';
        write(`${label}: ${flagged ? `FLAGGED (${REASONS[Number(reason)] ?? reason}${when})` : 'not flagged'}${prot}`);
        if (flagged) {
          const [[held], hf] = await Promise.all([reg.isHeld(key), reg.heldFrom(key)]);
          write(held ? '  bridge hold: holding (BridgeAirlock / BridgeGuard hold its transfers until the flag is cleared or the key protected)'
            : `  bridge hold: from ${new Date(Number(hf) * 1000).toISOString()} (hold-delay; at once if governance or a guardian runs threat hold-now)`);
        }
        const [ev, rsCount, ap] = await Promise.all([reg.evidenceOf(key), reg.responseCount(key), reg.appeals(key)]);
        if (ev.reportHash !== ZERO_HASH) write(`  evidence: reportHash ${ev.reportHash}${ev.uri ? ` (${ev.uri})` : ''}, by ${ev.by}; reproduce: run Neuro on the same code and compare the reportHash`);
        // Responses, one per author: the governance-named responder's first, then the newest.
        for (let i = 0n; i < rsCount && i < 8n; i++) {
          const rs = await reg.responseAt(key, i);
          if (rs.text) write(`  response from ${rs.by} (${rs.chainId === 0n ? 'responder named by governance' : `for ${rs.chainId}:${rs.account}`}): ${JSON.stringify(rs.text)}`);
        }
        if (ap.appellant !== ZERO_ADDR) write(`  appeal open by ${ap.appellant} since ${new Date(Number(ap.openedAt) * 1000).toISOString()}: ${ap.clearVotes} vote(s) to clear, ${ap.keepVotes} to keep`);
      }
      return 0;
    }
    const reason = cmd === 'flag' ? REASONS.indexOf(String(opt.reason ?? '')) : 0;
    if (cmd === 'flag' && reason < 1) throw new Error(`--reason ${REASONS.slice(1).join('|')} (what the code does, not intent)`);
    const [reportHash, uri] = cmd === 'flag' ? await threatEvidence(opt, write) : [ZERO_HASH, ''];
    await (await reg.voteBatch(keys.map((k) => k[1]), cmd === 'flag', reason, reportHash, uri)).wait();
    write(`voted to ${cmd} ${keys.length} key(s): ${keys.map((k) => k[0]).join(', ')}${cmd === 'flag' ? ` (${REASONS[reason]}, evidence ${reportHash})` : ''}`);
    write(`(a key changes when ${await reg.quorum()} runners agree; check with: zetaphy threat check ...)`);
    return 0;
  }

  // ---- vaccine: fast lane, the data feed for other wallets, and user reports ----
  if (group === 'threat' && ['fast-quorum', 'guardian', 'enforce-now', 'hold-now', 'hold-delay', 'export'].includes(cmd)) {
    if (!s.threats) throw new Error('set --threats 0x<ThreatRegistry> (or run deploy-threats)');
    const c = await connect(s, { needJobs: false });
    const reg = new Contract(s.threats, B.ThreatRegistry.abi, c.signer);
    if (cmd === 'fast-quorum') {
      if (!/^\d{1,3}$/.test(String(rest[0] ?? '')) || Number(rest[0]) > 255) throw new Error('usage: zetaphy threat fast-quorum <n above the quorum, or 0 = off>');
      await governAction(reg, c, write, 'setFastQuorum', [Number(rest[0])], `enforce a flag at once when ${rest[0]} runners stand behind it`);
      return 0;
    }
    if (cmd === 'guardian') {
      const m = /^(0x[0-9a-fA-F]{40}):(on|off)$/.exec(String(rest[0] ?? ''));
      if (!m) throw new Error('usage: zetaphy threat guardian 0x<address>:on|off');
      await governAction(reg, c, write, 'setGuardian', [m[1], m[2] === 'on'], `${m[2] === 'on' ? 'let' : 'stop'} ${m[1]} enforce flags at once`);
      return 0;
    }
    if (cmd === 'hold-delay') {
      if (!/^\d{1,8}$/.test(String(rest[0] ?? ''))) throw new Error('usage: zetaphy threat hold-delay <seconds, below the enforce-delay; 0 = a flag holds bridging at once>');
      await governAction(reg, c, write, 'setHoldDelay', [BigInt(rest[0])], `hold bridging ${rest[0]}s after a flag`);
      return 0;
    }
    if (cmd === 'hold-now') {
      if (!rest.length) throw new Error('usage: zetaphy threat hold-now <target>... (governance or a guardian)');
      const keys = await threatKeys(reg, c.provider, rest);
      const gov = String(await reg.governance()).toLowerCase();
      const mayAct = gov === c.me.toLowerCase() || (await reg.guardian(c.me));
      for (const [label, key] of keys) {
        if (!(await reg.isFlagged(key))[0]) { write(`${label}: not flagged, nothing to hold`); continue; }
        if ((await reg.isHeld(key))[0]) { write(`${label}: already held`); continue; }
        if (mayAct) { await (await reg.holdNow(key)).wait(); write(`${label}: held now (bridging of it stops until the flag is cleared or the key protected)`); continue; }
        write(`${label}: this key is neither governance nor a guardian. Have one call:\n  to ${reg.target}\n  data ${reg.interface.encodeFunctionData('holdNow', [key])}`);
      }
      return 0;
    }
    if (cmd === 'enforce-now') {
      if (!rest.length) throw new Error('usage: zetaphy threat enforce-now <target>... (governance or a guardian)');
      const keys = await threatKeys(reg, c.provider, rest);
      const gov = String(await reg.governance()).toLowerCase();
      const mayAct = gov === c.me.toLowerCase() || (await reg.guardian(c.me));
      for (const [label, key] of keys) {
        if (!(await reg.isFlagged(key))[0]) { write(`${label}: not flagged, nothing to enforce`); continue; }
        if ((await reg.entries(key)).fast) { write(`${label}: already enforced (fast lane)`); continue; }
        if (mayAct) { await (await reg.enforceNow(key)).wait(); write(`${label}: enforced now`); continue; }
        write(`${label}: this key is neither governance nor a guardian. Have one call:\n  to ${reg.target}\n  data ${reg.interface.encodeFunctionData('enforceNow', [key])}`);
      }
      return 0;
    }
    // export: every standing flag, read at one block, as JSON other wallets and extensions can load.
    const block = await c.provider.getBlock('latest');
    const at = { blockTag: block.number };
    const [count, delay, fastQuorum, holdDelay] = await Promise.all([reg.flaggedCount(at), reg.enforceDelay(at), reg.fastQuorum(at), reg.holdDelay(at)]);
    const { REASONS, DISCLAIMER } = await import('./src/vaccine.js');
    const all = [];
    for (let i = 0n; i < count; i += 20n) {
      const n = count - i < 20n ? count - i : 20n;
      all.push(...await Promise.all(Array.from({ length: Number(n) }, (_, j) => reg.flaggedList(i + BigInt(j), at))));
    }
    const keys = [];
    for (const key of [...new Set(all.map((k) => k.toLowerCase()))]) {
      const [e, [enforced], from, ev, rsCount, ap, [held], heldFrom] = await Promise.all([reg.entries(key, at), reg.isEnforced(key, at), reg.enforcedFrom(key, at),
        reg.evidenceOf(key, at), reg.responseCount(key, at), reg.appeals(key, at), reg.isHeld(key, at), reg.heldFrom(key, at)]);
      // One response per author: the governance-named responder's first, then the newest (at most 8).
      const responses = (await Promise.all(Array.from({ length: Number(rsCount > 8n ? 8n : rsCount) }, (_, i) => reg.responseAt(key, i, at))))
        .filter((r) => r.text).map((r) => ({ text: r.text, by: r.by, at: Number(r.at), assigned: r.chainId === 0n, ...(r.chainId === 0n ? {} : { chainId: Number(r.chainId), account: r.account }) }));
      if (!e.flagged) continue; // cleared or protected since
      keys.push({ key, reason: REASONS[Number(e.reason)] ?? Number(e.reason), enforced, enforcedFrom: Number(from), fast: e.fast, flaggedAt: Number(e.updatedAt),
        evidence: { reportHash: ev.reportHash, uri: ev.uri, by: ev.by },
        held, heldFrom: Number(heldFrom),
        response: responses[0] ? { text: responses[0].text, by: responses[0].by, at: responses[0].at } : null, // the first of `responses` (format /2)
        responses,
        appealOpen: ap.appellant !== ZERO_ADDR });
    }
    const feed = {
      format: 'zetaphy-threats/2',
      registry: reg.target, chainId: Number(EVM_CHAIN_ID), block: block.number, timestamp: block.timestamp,
      enforceDelay: Number(delay), fastQuorum: Number(fastQuorum), holdDelay: Number(holdDelay),
      keyOf: {
        fingerprint: 'fp1 sha256 (zetaphy-neuro/src/fingerprint.js), as 0x + 64 hex',
        code: 'keccak256(abi.encode("zetaphy.threat.code", keccak256(runtime code)))',
        address: 'keccak256(abi.encode("zetaphy.threat.address", uint256 EVM chain id, address))',
      },
      policy: 'enforced: refuse. flagged, not enforced: warn. Not listed: not flagged at this block. Show the reason as a code fact, the evidence and the responses (each with its author) with every warning.',
      disclaimer: DISCLAIMER,
      reasons: 'what the code does, or did in a reproducible test (ThreatRegistry.Reason); never a claim about intent',
      keys,
    };
    const json = JSON.stringify(feed, null, 2) + '\n';
    if (opt.out) { writeFileSync(String(opt.out), json); write(`${keys.length} flagged key(s), ${keys.filter((k) => k.enforced).length} enforced, written to ${opt.out}`); } else process.stdout.write(json);
    return 0;
  }

  // ---- right of reply and appeal: the party behind a flagged key answers, and may appeal to fresh runners ----
  if (group === 'threat' && ['respond', 'appeal', 'appeal-vote', 'appeal-expire', 'withdraw', 'pay-fund', 'appeals-set', 'identity', 'responder'].includes(cmd)) {
    if (!s.threats) throw new Error('set --threats 0x<ThreatRegistry> (or run deploy-threats)');
    const c = await connect(s, { needJobs: false });
    const reg = new Contract(s.threats, B.ThreatRegistry.abi, c.signer);
    if (cmd === 'withdraw' || cmd === 'pay-fund') {
      const amount = cmd === 'withdraw' ? await reg.owed(c.me) : await reg.fundOwed();
      if (amount === 0n) { write('nothing to pay'); return 0; }
      await (await (cmd === 'withdraw' ? reg.withdraw() : reg.payFund())).wait();
      write(`${zeta(amount)} sent to ${cmd === 'withdraw' ? c.me : await reg.communityFund()}`);
      return 0;
    }
    if (cmd === 'appeals-set') {
      const fund = String(opt['community-fund'] ?? '');
      if (!ADDR_RE.test(fund)) throw new Error('usage: zetaphy threat appeals-set --bond <ZETAPHY, at most 1000> --window <seconds, 86400..7776000> --community-fund 0x...');
      const bond = parseEther(String(opt.bond ?? '1'));
      const window = BigInt(opt.window ?? 14 * 86400);
      await governAction(reg, c, write, 'setAppeals', [bond, window, fund], `appeal bond ${zeta(bond)}, window ${window}s, kept bonds to ${fund}`);
      return 0;
    }
    if (cmd === 'identity') {
      const a = String(rest[0] ?? '');
      if (!ADDR_RE.test(a)) throw new Error('usage: zetaphy threat identity 0x<NeuroIdentity> (0x000…0: off)');
      await governAction(reg, c, write, 'setIdentity', [a], `let claimed NeuroIdentity owners (${a}) answer for their addresses`);
      return 0;
    }
    if (cmd === 'responder') {
      const who = String(rest[1] ?? '');
      if (!rest[0] || !ADDR_RE.test(who)) throw new Error('usage: zetaphy threat responder <target> 0x<address> (0x000…0: the on-chain routes again)');
      for (const [label, key] of await threatKeys(reg, c.provider, [rest[0]])) await governAction(reg, c, write, 'setResponder', [key, who], `name ${who} the responder for ${label}`);
      return 0;
    }
    if (rest.length !== 1) throw new Error(`usage: zetaphy threat ${cmd} <fp1:hex | code:0x<codehash> | 0x<contract> | <chainId>:0x<address>>`);
    const subjects = await threatSubjects(reg, c.provider, rest);
    if (cmd === 'respond') {
      const text = typeof opt.text === 'string' ? opt.text : null;
      if (text === null || Buffer.byteLength(text) > 500) throw new Error('usage: zetaphy threat respond <target> --text "..." (at most 500 bytes; "" removes the response)');
      let done = 0;
      for (const [label, key, chainId, account] of subjects) {
        if (!text) {
          if (!(await reg.responseBy(key, c.me)).text) { write(`${label}: this key has no response there to remove`); continue; }
        } else if (!(await reg.mayAnswer(key, chainId, account, c.me))) { write(`${label}: this key may not answer for it (for an address: the address itself, its owner() on ZETAPHY, or the claimed NeuroIdentity owner; for code: and fp1: keys only the responder governance named)`); continue; }
        await (await reg.respond(key, chainId, account, text)).wait();
        write(`${label}: response ${text ? 'posted' : 'removed'} (shown next to the flag; it does not change the flag)`);
        done++;
      }
      return done ? 0 : 1;
    }
    for (const [label, key, chainId, account] of subjects) {
      const [flagged] = await reg.isFlagged(key);
      if (cmd === 'appeal') {
        if (!flagged) { write(`${label}: not flagged, nothing to appeal`); continue; }
        if (!(await reg.mayAnswer(key, chainId, account, c.me))) { write(`${label}: this key may not appeal it (see threat respond)`); continue; }
        const bond = await reg.appealBond();
        await (await reg.appeal(key, chainId, account, { value: bond })).wait();
        write(`${label}: appeal opened (bond ${zeta(bond)}); runners who did not vote for the flag decide: cleared -> bond back, kept -> bond to the community fund, undecided after ${await reg.appealWindow()}s -> bond back (threat appeal-expire)`);
      } else if ((await reg.appeals(key)).appellant === ZERO_ADDR) {
        write(`${label}: no appeal open`);
      } else if (cmd === 'appeal-vote') {
        if (!!opt.clear === !!opt.keep) throw new Error('appeal-vote: --clear or --keep');
        const [reportHash, uri] = await threatEvidence(opt, write);
        await (await reg.voteAppeal(key, !!opt.clear, reportHash, uri)).wait();
        write(`${label}: voted to ${opt.clear ? 'clear' : 'keep'} the flag in its appeal`);
      } else {
        await (await reg.expireAppeal(key)).wait();
        write(`${label}: appeal expired, bond refunded (the appellant takes it with: zetaphy threat withdraw)`);
      }
    }
    return 0;
  }

  if (group === 'deploy-reports') {
    if (!s.threats) throw new Error('set --threats 0x<ThreatRegistry> (or run deploy-threats)');
    const c = await connect(s, { needJobs: false });
    let fund = opt['community-fund'] ? String(opt['community-fund']) : null;
    if (!fund && s.jobs) {
      const control = await new Contract(s.jobs, ART.abi, c.provider).control().catch(() => ZERO_ADDR);
      if (control !== ZERO_ADDR) fund = String(await new Contract(control, CONTROL.abi, c.provider).communityFund());
    }
    if (!fund || !ADDR_RE.test(fund)) throw new Error('--community-fund 0x... (or --jobs with a NeuroControl that has one)');
    const fee = parseEther(String(opt.fee ?? '0.1'));
    const ttl = BigInt(opt.ttl ?? 30 * 86400);
    const k = await new ContractFactory(B.ThreatReports.abi, B.ThreatReports.bytecode, c.signer).deploy(s.threats, fund, fee, ttl);
    await k.waitForDeployment();
    const addr = await k.getAddress();
    settings({ ...opt, reports: addr }, {});
    write(`ThreatReports ${addr} (fee ${zeta(fee)}; flagged within ${ttl}s: the fee goes to the runners who flagged it, else to ${fund})`);
    return 0;
  }

  if (group === 'threat' && ['report', 'reports', 'settle', 'claim'].includes(cmd)) {
    if (!s.reports) throw new Error('set --reports 0x<ThreatReports> (or run deploy-reports)');
    if (!s.threats) throw new Error('set --threats 0x<ThreatRegistry> (or run deploy-threats)');
    const c = await connect(s, { needJobs: false });
    const rep = new Contract(s.reports, B.ThreatReports.abi, c.signer);
    const reg = new Contract(s.threats, B.ThreatRegistry.abi, c.signer);
    const STATE = ['open', 'flagged (runners claim the fee)', 'not flagged (fee to the community fund)'];
    if (cmd === 'report') {
      const usage = 'usage: zetaphy threat report <fp1:hex | code:0x<codehash> | 0x<contract> | <chainId>:0x<address>> --note "what you saw" [--chain bsc]';
      const target = String(rest[0] ?? '');
      const note = typeof opt.note === 'string' ? opt.note : '';
      if (!target || rest.length !== 1) throw new Error(usage);
      if (Buffer.byteLength(note) > 280) throw new Error('--note: at most 280 bytes');
      let m, key, chainKey = '0x' + '0'.repeat(64), addr = ZERO_ADDR;
      if ((m = /^(\d+):(0x[0-9a-fA-F]{40})$/.exec(target))) { key = await reg.addressKey(BigInt(m[1]), m[2]); chainKey = encodeBytes32String(`eip155:${m[1]}`); addr = m[2]; }
      else if (ADDR_RE.test(target)) {
        const code = await c.provider.getCode(target);
        key = code === '0x' ? await reg.addressKey(EVM_CHAIN_ID, target) : await reg.codeKey(keccak256(code)); // the code: every copy of it
        chainKey = encodeBytes32String(`eip155:${EVM_CHAIN_ID}`); addr = target;
      } else [[, key]] = await threatKeys(reg, c.provider, [target], usage);
      if (opt.chain) {
        if (!/^[a-z0-9:-]{1,31}$/.test(String(opt.chain))) throw new Error('--chain: a chain key such as bsc or eip155:56');
        chainKey = encodeBytes32String(String(opt.chain));
      }
      if ((await reg.isFlagged(key))[0]) { write(`${target}: already flagged (zetaphy threat check ${target}); no report needed`); return 0; }
      const fee = await rep.fee();
      const r = await (await rep.report(key, chainKey, addr, note, { value: fee })).wait();
      const ev = r.logs.map((l) => { try { return rep.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Reported');
      write(`report #${ev?.args.id ?? '?'} sent (${zeta(fee)}): key ${key}`);
      write('runners see it (zetaphy threat reports); if they flag it, they share the fee, else it goes to the community fund');
      return 0;
    }
    if (cmd === 'settle' || cmd === 'claim') {
      if (!/^\d{1,9}$/.test(String(rest[0] ?? ''))) throw new Error(`usage: zetaphy threat ${cmd} <report id>`);
      await (await rep[cmd](BigInt(rest[0]))).wait();
      const r = await rep.reports(BigInt(rest[0]));
      write(cmd === 'settle' ? `report #${rest[0]}: ${STATE[Number(r.state)]}` : `report #${rest[0]}: claimed ${zeta(r.share)}`);
      return 0;
    }
    // reports: newest first; open ones only unless --all.
    const n = await rep.reportCount();
    const last = BigInt(opt.last ?? 50);
    const [ttl, now] = [await rep.ttl(), BigInt((await c.provider.getBlock('latest')).timestamp)];
    let shown = 0;
    for (let i = n; i > 0n && i > n - last; i--) {
      const id = i - 1n;
      const r = await rep.reports(id);
      if (!opt.all && r.state !== 0n) continue;
      const [flagged] = await reg.isFlagged(r.key);
      let chain = '';
      try { chain = decodeBytes32String(r.chainKey); } catch { chain = r.chainKey; }
      const st = r.state !== 0n ? STATE[Number(r.state)] : flagged ? 'flagged since: settle it to pay the voters (zetaphy threat settle)'
        : now >= r.createdAt + ttl ? 'expired unflagged: settle it to send the fee to the community fund' : `open until ${new Date(Number(r.createdAt + ttl) * 1000).toISOString()}`;
      write(`#${id} ${st}\n  key ${r.key}${chain ? `  chain ${chain}` : ''}${r.target !== ZERO_ADDR ? `  target ${r.target}` : ''}\n  by ${r.reporter}, fee ${zeta(r.fee)}, ${new Date(Number(r.createdAt) * 1000).toISOString()}`);
      shown++;
    }
    write(`${shown} ${opt.all ? '' : 'open '}report(s) of ${n} (the note is in each Reported event)`);
    return 0;
  }

  if (group === 'deploy-stable') {
    if (opt.price != null) throw new Error('--price is gone: the gateway prices through ZetaphyOracle (--oracle, --zeta-asset); a fixed price only as --testnet-fixed-price, clearly labeled');
    const c = await connect(s);
    const deploy = async (a, args) => { const k = await new ContractFactory(a.abi, a.bytecode, c.signer).deploy(...args); await k.waitForDeployment(); return k.getAddress(); };
    const usdc = await deploy(STABLE, ['Test USDC (ZETAPHY testnet)', 'tUSDC']);
    const usdt = await deploy(STABLE, ['Test USDT (ZETAPHY testnet)', 'tUSDT']);
    const gwAddr = await deploy(GATEWAY, [s.jobs]);
    const gw = new Contract(gwAddr, GATEWAY.abi, c.signer);
    for (const t of [usdc, usdt]) await (await gw.setToken(t, true, false, 6)).wait(); // USD stablecoins, counted at $1
    let source;
    if (opt.oracle) {
      if (!ADDR_RE.test(String(opt.oracle)) || !ADDR_RE.test(String(opt['zeta-asset'] ?? ''))) throw new Error('--oracle 0x<ZetaphyOracle> needs --zeta-asset 0x<its id for ZETAPHY, the DEX\'s WZETAPHY>');
      await (await gw.setOracle(String(opt.oracle), String(opt['zeta-asset']))).wait();
      source = `ZetaphyOracle ${opt.oracle}`;
    }
    if (opt['testnet-fixed-price'] != null) {
      const price = parseUnits(String(opt['testnet-fixed-price']), 6); // stablecoin per 1 ZETAPHY
      for (const t of [usdc, usdt]) await (await gw.setTestnetFixedPrice(t, price)).wait();
      await (await gw.setTestnetFixedPrices(true)).wait();
      source = `TESTNET FIXED PRICE ${formatUnits(price, 6)} per ZETAPHY (not a market price; replaces the oracle until governance switches it off)`;
    }
    await (await c.signer.sendTransaction({ to: gwAddr, value: parseEther(String(opt.reserve ?? 1000)) })).wait();
    for (const g of [].concat(opt.guardian ?? [])) { if (!ADDR_RE.test(String(g))) throw new Error('--guardian 0x…'); await (await gw.setGuardian(String(g), true)).wait(); }
    const gov = governanceOf(opt, write);
    if (gov) { await (await gw.setOwner(gov)).wait(); write(`StableGateway owner handed to ${gov}`); }
    settings({ ...opt, gateway: gwAddr, usdc, usdt }, {});
    write(`tUSDC ${usdc}\ntUSDT ${usdt}\nStableGateway ${gwAddr} (price: ${source ?? 'none yet: setOracle(ZetaphyOracle, WZETAPHY) before it takes requests'}; reserve ${opt.reserve ?? 1000} ZETAPHY)`);
    return 0;
  }

  if (group === 'relay' && cmd === 'start') {
    if (!s.gateway) throw new Error('no StableGateway yet: run "zetaphy deploy-stable" or pass --gateway 0x...');
    const c = await connect(s, { needJobs: false });
    const gateway = new Contract(s.gateway, GATEWAY.abi, c.signer);
    const tokens = {};
    for (const k of ['usdc', 'usdt']) if (s[k]) tokens[k] = new Contract(s[k], STABLE.abi, c.signer);
    // --poke-oracle <seconds>: also be the oracle's keeper (anyone may poke: a TWAP observation, the reference price)
    const every = opt['poke-oracle'] != null ? Number(opt['poke-oracle']) : 0;
    let keeper = null;
    if (every > 0) {
      const oracleAddr = await gateway.oracle();
      const asset = await gateway.zetaAsset();
      if (/^0x0{40}$/i.test(oracleAddr)) throw new Error('--poke-oracle: this gateway has no oracle');
      const oracle = new Contract(oracleAddr, art('ZetaphyOracle').abi, c.signer);
      const poke = async () => { try { await (await oracle.poke(asset, { gasLimit: 800_000n })).wait(); } catch (e) { write(`${new Date().toISOString()} oracle poke failed: ${e.shortMessage ?? e.message}`); } };
      await poke();
      keeper = setInterval(poke, every * 1000);
    }
    const server = createRelay({ gateway, tokens, minTip: parseUnits(String(opt['min-tip'] ?? '0.01'), 6), log: (l) => write(`${new Date().toISOString()} ${l}`) });
    const port = Number(opt.port ?? 8080);
    await new Promise((r) => server.listen(port, opt.host ?? '0.0.0.0', r));
    write(`relay for ${s.gateway} on port ${port}; relay wallet ${c.me} pays the gas; price: ${await gateway.priceSource()}${every > 0 ? `; pokes the oracle every ${every} s` : ''}`);
    if (opt.once) { clearInterval(keeper); server.close(); return 0; }
    return new Promise(() => {}); // runs until stopped
  }

  if (group === 'faucet') {
    if (!opt.relay) throw new Error('usage: zetaphy faucet <usdc|usdt> --relay URL');
    const { wallet } = loadOrCreateKey();
    const r = await fetch(new URL('/faucet', opt.relay), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: cmd, address: wallet.address }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`faucet: ${body.error}`);
    write(`1,000 test ${cmd.toUpperCase()} sent to ${wallet.address}`);
    return 0;
  }

  if (group === 'job' && cmd === 'request-stable') {
    const [chainKey, target] = rest;
    if (!chainKey || !target || !opt.relay) throw new Error('usage: zetaphy job request-stable <chain> <address> --relay URL [--token usdc --fee 0.1 --tip 0.01]');
    const info = await (await fetch(new URL('/info', opt.relay))).json();
    const tokenKey = String(opt.token ?? 'usdc');
    const token = info.tokens?.[tokenKey];
    if (!token) throw new Error(`relay does not take ${tokenKey}`);
    const c = await connect(s, { needJobs: false });
    const gw = new Contract(info.gateway, GATEWAY.abi, c.provider);
    const stable = new Contract(token, STABLE.abi, c.provider);
    const net = await c.provider.getNetwork();
    const fee = parseEther(String(opt.fee ?? '0.1'));
    const tip = opt.tip ? parseUnits(String(opt.tip), 6) : BigInt(info.minTip);
    const cost = await gw.quote(token, fee);
    const deadline = BigInt((await c.provider.getBlock('latest')).timestamp) + 600n;
    const wallet = c.signer.signer; // the plain Wallet under the NonceManager
    const q = { user: c.me, token, chain: encodeBytes32String(chainKey), target, fee, tip, maxCost: cost + tip, nonce: await gw.nonces(c.me), deadline };
    const signature = await wallet.signTypedData(
      { name: 'ZETAPHY StableGateway', version: '1', chainId: net.chainId, verifyingContract: info.gateway },
      { JobRequest: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'chain', type: 'bytes32' }, { name: 'target', type: 'string' },
        { name: 'fee', type: 'uint256' }, { name: 'tip', type: 'uint256' }, { name: 'maxCost', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, q);
    const ps = Signature.from(await wallet.signTypedData(
      { name: await stable.name(), version: '1', chainId: net.chainId, verifyingContract: token },
      { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      { owner: c.me, spender: info.gateway, value: q.maxCost, nonce: await stable.nonces(c.me), deadline }));
    const str = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const r = await fetch(new URL('/request', opt.relay), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(str({ request: q, signature, permit: { value: q.maxCost, deadline, v: ps.v, r: ps.r, s: ps.s } })) });
    const body = await r.json();
    if (!r.ok) throw new Error(`relay refused: ${body.error}`);
    write(`job ${body.jobId} requested: ${chainKey} ${target}, paid ${formatUnits(cost + tip, 6)} ${tokenKey.toUpperCase()} (no ZETAPHY used)`);
    return 0;
  }

  // useful work: browser scan jobs and bug bounties, checked by runners (src/usefulworkcli.js)
  if (group === 'work' || group === 'bounty') {
    const { usefulWorkCommand } = await import('./src/usefulworkcli.js');
    return usefulWorkCommand({ group, cmd, rest, opt, write, s, connect, connectRpc });
  }

  // Neuro-checked certificates, ML-DSA-44 attestations, the herd-immunity pusher (src/assistcli.js)
  if (group === 'certify' || group === 'attest-pq' || group === 'immune' || group === 'deploy-assist') {
    return assistCommand({ group, cmd, rest, opt, write, s, connect, connectRpc, argv });
  }

  // parametric hack insurance: the deterministic forensic replay and the committee vote (src/insurancecli.js)
  if (group === 'insurance') {
    const { insuranceCommand } = await import('./src/insurancecli.js');
    return insuranceCommand({ cmd, rest, opt, write, s, connect, connectRpc });
  }

  // ERC-8004 identity and signed Neuro messages (src/identitycli.js)
  if (group === 'identity' || group === 'deploy-identity' || group === 'msg') {
    return identityCommand({ group, cmd, rest, opt, env, write, s, connect, connectRpc });
  }

  // Proof of Intent (solver side) and the AI co-signer (runner side): src/agentscli.js, docs/future/agents.md
  if (group === 'intent' || group === 'cosign') {
    return agentsCommand({ group, cmd, rest, opt, write, s, connect, connectRpc });
  }

  write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(3)).join('\n'));
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.shortMessage ?? e.message); process.exitCode = 1; });
}
