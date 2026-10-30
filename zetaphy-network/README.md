**English** | [ภาษาไทย](README.th.md)

# zetaphy-network: ZETAPHY stages 1–5 (testnet)

| Plan stage | What is available now |
|---|---|
| 1 · Anyone can run a runner | `zetaphy node start` checks the machine itself, then takes jobs from the NeuroJobs job market, checks answers 2-of-3, and pays rewards in ZETAPHY |
| 2 · ZETAPHY pays for AI | Users pay contract-check fees in ZETAPHY to runners |
| 2 · Pay fees in USDC/USDT | StableGateway + relay: people with no ZETAPHY at all can still use it, paying in test USDC/USDT |
| 2 · Built-in upgrade voting | `zetaphy-chain/gov.sh` proposes and votes on upgrades on-chain |
| 2 · Prepare the distribution to SWD holders | `airdrop/`: snapshot of SWD holders, proportional split, and Merkle root |
| 2 · Release rewards at 10% per year | `RewardVault`: the 500 million reward pool sits in the contract, released daily, totalling 10% of the remainder per year. There is no withdraw function |
| Gate 1 | `zetaphy gate` reports progress from on-chain data |
| 3 · Bridge: daily limit + bridge-only pause button | `BridgeGuard` + `BridgedToken` |
| 3 · Multiple bridges + Neuro as a bridge + marking attackers | `BridgeAirlock` (marker) + `NeuroLane` + `HyperlaneLane` + `zetaphy bridge watch` / `bridge monitor` |
| 3 · Bridge opening gate + monitoring (the bridge is **closed** by default) | `zetaphy bridge open` / `bridge monitor` + `.github/workflows/bridge-monitor.yml` |
| 2 · AI fees: 90% runners · 5% burned · 5% community fund | `NeuroJobs` splits the fee of every job (failed jobs refund the user 100%) |
| 4 · Runners grow/shrink + 4 defenders + quarantine/regrow | `NeuroJobs` + `NeuroControl` + `zetaphy neuro regrow` |
| 4 · AI pause button (does not pause the coin) + new skills need a governance vote | `NeuroControl` (owned by the chain's gov module or a multisig) + `gov.sh neuro ...` |
| 4 · Immune system | `ThreatRegistry`: runners with a track record vote to record code that behaves riskily toward users (re-checkable). Neuro warns about that code everywhere and **vaccinates**: the bridge refuses it, the wallet does not sign |
| 4 · AI compute market paid in ZETAPHY | `ComputeMarket`: the AI job deposit is held by the contract until the work is delivered and accepted |
| 1 contract = 1 identity (ERC-8004) + signed cross-chain messages | `NeuroIdentity` + `NeuroValidation` + `zetaphy identity` / `zetaphy msg`: messages from other Neuro instances are data, not commands |
| 5 · Quantum resistance | ML-DSA precompile (FIPS 204) in the chain + `QuantumWallet` + `zetaphy pq` + true PQ accounts (`zetaphy pq native`) |
| Future · Useful work (prototype, not deployed) | `UsefulWork` (browser scan jobs: PoW stamp, 2-of-3 commit-reveal, canaries) + `WorkerReputation` (ERC-8004-style) + `BugBounty` (browser fuzzing, runner-verified; `VulnerableVault` is deliberately vulnerable) + `UsefulIssuance` (a timelocked RewardVault share for verified work) + `zetaphy work` / `zetaphy bounty`: [docs/future/useful-work.md](../docs/future/useful-work.md) |
| Future · PQ threshold-encrypted mempool (research prototype, not in the chain) | `src/encmempool/` (X-Wing = ML-KEM-768 + X25519 envelopes, Shamir t-of-n per-height keys, ML-DSA-44 signed share release after the order is committed) + `scripts/encmempool-sim.js` (sandwich MEV: plaintext vs encrypted, collusion, withholding) + `scripts/encmempool-bench.js`: [docs/future/encrypted-mempool.md](../docs/future/encrypted-mempool.md) |
| Cross-chain security (testnet, docs/future/crosschain-assist.md) | `NeuroOracleSender` + `NeuroOracle`: Neuro's flags mirrored to other EVM testnets over Hyperlane (`zetaphy immune push/coverage`, `scripts/neuro-oracle.js`) and to Osmosis over IBC (`cosmwasm/neuro-oracle-osmo`) · `NeuroAttest`: "Neuro-checked" certificates (`zetaphy certify`) · `NeuroAnchor` + `zetaphy attest-pq`: ML-DSA-44-signed report archives · `HackInsurance`: parametric hack insurance prototype (testnet only), with the deterministic forensic replay (`zetaphy insurance replay/vote`, anvil 1.2.3) |

**No stage holds real money yet:** stage 3 and above on mainnet must first pass the gates in the "Before real money" section at the end of this file

All of this has been tested on a real ZETAPHY chain (`npm run test:devnet`)

Anyone can run Neuro with one command and earn rewards in ZETAPHY on testnet

## How it works

1. A user submits a "please check this contract" job and pays the service fee in ZETAPHY
2. The 4 defenders are always eligible for jobs (but only 1 defender can sit per job). The remaining runners (runners that grow with usage) come from a lottery weighted by bond. The first 3 eligible runners get seats. Each one runs Neuro on their own machine
   - The lottery is tied to the hash of the block after the block where the job was submitted (`blockhash`), which nobody can choose. So the submitter cannot know in advance who will get a seat, and cannot resubmit to re-roll (see "An unpredictable lottery")
3. Each runner sends a **commit**, a secret code of their answer, so they cannot see each other's answers and cannot copy
4. When the seats are full, or the commit time runs out, everyone **reveals** their answer
5. An answer that **matches 2 of 3** becomes the check result
   - The fee is split: **90%** to the runners who matched (split equally) · **5%** burned (sent to `0x…dEaD`, which nobody holds a key for; locked forever, but still counted in the bank supply) · **5%** to the community fund (remainders from uneven division go to the community fund; nothing is lost)
   - Runners who matched also get a reward from the common pool (at most 1 ZETAPHY and at most 1/4 of the job fee, under a daily cap)
   - Runners who did not match, or who committed but did not reveal, lose 10% of their bond and get 1 strike · 2 strikes within the last 5 settled jobs means quarantine
   - Once 2 of 3 is reached, seats that have not revealed get a grace period equal to the commit time (they can reveal and are judged like everyone else, but get no share). After that, anyone can call `zetaphy job settle <id>`. Seats that stay silent lose 10% and get a strike (the runner program calls this itself)
   - A job records the skill that passed a governance vote when the job was submitted. Runners only take jobs that match their own machine's skills
6. If no 2 answers match, or time runs out, the user gets 95% of the fee back and the other 5% is burned (people who send fake requests or unanswerable requests pay for it themselves)
7. After a result is in, anyone can **challenge** it within the set time if they think those 2 runners answered wrong, by stating the answer they believe is correct: this opens a challenge round with a new set of 3 runners (see "Challenge round")

The answer used for comparison is called the "verdict" and is built by `zetaphy-neuro/src/verdict.js`
It stores only what Neuro's rules decide, and does not store values that can change between two reads, such as supply
So every honest runner gets the same verdict

## Runners (node runner)

### Easiest: one command (Ubuntu server)

```
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/install.sh | sudo bash -s -- runner
```

- Installs everything: Node.js (SHA-256 checked), the ZETAPHY code, the runner key (made on the machine, never shown) and a service that keeps running, also after a reboot
- At the end it prints the runner address: send **100.1** testnet ZETAPHY (or more) there and the runner posts its bond by itself within about a minute and starts taking jobs
- After install: `sudo zetaphy-runner status` · `address` · `withdraw` · `logs` · `update` · `stop` · `start` · `uninstall`
- Safe to run again (updates the code, keeps the key) · `uninstall` keeps the key
- No machine: the "Deploy to Oracle Cloud" button in `deploy/oracle/README.md` creates a free one and installs everything
- Runners earn BZTPHY reward points, converted to real ZETAPHY at mainnet: `zetaphy-chain/rewards/README.md`

### Manual install (step by step)

```
npm i -g ./zetaphy-network          # or: node zetaphy-network/cli.js ...
zetaphy node start --rpc http://<ZETAPHY node>:8545 --jobs 0x<NeuroJobs>
```

- The first time, the system creates the runner's key at `~/.zetaphy/worker.key` (permissions 0600)
  - Use it on testnet only. Never use a key that holds real money
  - The key never leaves the machine
- The system checks the machine itself: an ordinary CPU machine runs light mode; a machine with an NVIDIA GPU of 8 GB or more runs heavy mode
  - Right now every job is still Neuro tier 1, which uses CPU only
- Steps:
  1. Send testnet ZETAPHY to the runner's address, then `zetaphy node register` to post the bond (default 100 ZETAPHY)
  2. `zetaphy node start` to start taking jobs
  3. `zetaphy node status` to see earnings and stats, then `zetaphy node withdraw` to withdraw earnings
  4. To stop running: `zetaphy node unbond`, wait 1 hour, then `zetaphy node withdraw-bond` and `zetaphy node withdraw`
- The `~/.zetaphy/jobs-*.json` files hold answers already committed. Do not delete them while jobs are pending, because if you cannot reveal, your bond is slashed
- `zetaphy node start` does all of this itself:
  - Draws the lottery (`draw`) for jobs nobody has drawn yet, then checks whether it is eligible
  - Also takes round-2 seats for challenged jobs (if it did not sit in round 1)
  - If it is a defender (or on the list), sends a `heartbeat` about every 1/4 of `defenderTimeout` (costs only gas)
- `zetaphy node start --llm-review [--llm-model qwen2.5-coder:7b --llm-url http://localhost:11434/v1 --llm-lang en]`: LLM review (opt-in, free, local)
  - After each commit, the runner's own Ollama writes an advisory "AI opinion" review of the report (zetaphy-neuro `ai/`, see its README "AI analyst")
  - Saved to `~/.zetaphy/reviews/job-<id>.json`, signed with the runner key; `zetaphy review verify <file>` checks it is unedited and who wrote it
  - Never part of the verdict: the commit is the same with or without it, and the review runs afterwards so it never delays a reveal
- `zetaphy node start --watch-verdicts --max-challenge-spend 10`: verdict-watching mode (opt-in)
  - Re-runs Neuro on jobs that have a result and are still within the challenge window. If its own machine's answer does not match, it challenges automatically
  - Spends at most `--max-challenge-spend` ZETAPHY per day on challenge stakes (default 10)
  - Challenges by stating its own machine's verdict as the correct answer
  - If a challenge round times out without a conclusion, it calls `challengeExpire` and gets 80% of the stake back
  - A challenge that ends as "disputed" (no conclusion) and is still within the new challenge window: if its own machine still disagrees with the result, it challenges again (up to the contract's round cap)
  - Gas is estimated from the latest block but the transaction lands in the next block, so every transaction adds 50% extra gas. If gas estimation returns `TooEarly` (the lottery block has not arrived yet), it waits for the next block and tries again

## Users: submit a contract check

```
zetaphy job request bsc 0xc1ed4b78071e7c9a84958d8be0215a10984fc28f --fee 0.1
zetaphy job get 0          # result + "confirmedBy" (confirmed by N runners) + challenge status
zetaphy job challenge 0 --verdict 0x<correct answer>   # do not trust this result: post a stake, state the answer you believe is correct, and open a challenge round
```

Supported chains: `zetaphy` (the ZETAPHY testnet itself) and every chain in `zetaphy-neuro/src/chains.js` (`eth`, `bsc`, `base`, `arbitrum`, `sol`, `sui`, `aptos`, `osmosis`, `neutron`, `near`, `starknet`, `bitcoin`, `ton`)
- Only chains on the NeuroControl list are accepted (`zetaphy deploy` sets up this list). For other chains `request` reverts (`UnknownChain`). Add/remove with the `approve-chain` / `remove-chain` votes

## Users without ZETAPHY: pay in test USDC/USDT (stage 2)

```
zetaphy faucet usdc --relay http://<relay>:8080                       # get 1,000 tUSDC per day (the relay pays the gas)
zetaphy job request-stable bsc 0x... --relay http://<relay>:8080      # submit a job, pay in tUSDC
```

1. The user's wallet signs 2 things: the job request (EIP-712) and a permit allowing the coins to be taken (EIP-2612)
2. The relay sends the transaction on-chain and pays the gas itself, then receives a tip in tUSDC of the amount the user agreed to
3. StableGateway takes tUSDC at the price from **ZetaphyOracle** (the ZETAPHY price in USD, checked in several layers; see "Price: ZetaphyOracle" below), counting tUSDC/tUSDT as $1
   - If the oracle has no trustworthy price (too old, price sources disagree, circuit breaker tripped, or paused), the request reverts with `PriceUnavailable` and a reason. There is no price guessing
   - **Fallback for testnet only:** a fixed price (e.g. 1 ZETAPHY = 0.01 tUSDC) works only when governance itself turns on `setTestnetFixedPrices(true)` (off from the start). `priceSource()` and the relay's `/info` clearly say "TESTNET FIXED PRICE", not a market price
4. The Gateway pays the job fee in ZETAPHY from its own reserve. If the job fails, the ZETAPHY is returned to the user

Good to know:
- The user can set the maximum they are willing to pay in `maxCost`
- The relay cannot reuse a request, change a request, or use an expired request
- Any runner can open a relay: `zetaphy relay start --port 8080` (add `--poke-oracle 60` to have the relay also poke the oracle every 60 seconds)
- The guardian (multisig) can stop accepting requests immediately (`pause`). Reopening must go through the timelock
- Real USDC/USDT will arrive over the bridge in stage 3

## Chain upgrade voting (stage 2)

On a node: `zetaphy-chain/gov.sh`

```
gov.sh propose-upgrade v2 <block height> "summary"   # deposit 1,000 ZETAPHY
gov.sh vote 1 yes
gov.sh status 1
gov.sh plan
```

## Reward pool released at 10% per year (stage 2)

```
zetaphy deploy-vault --validators 0x<validator reward contract or account> --validators-share 30 \
  --fund 500000000 --governance 0x<multisig>
zetaphy vault status        # how much is left in the pool, how much can be released now
zetaphy vault release       # anyone can call it, and `node start --vault 0x...` calls it itself about once an hour
```

- Each day releases 1 − 0.9^(1/365) of the remainder (about 0.0289%), which adds up to exactly 10% in one year, so the pool lasts for decades
- **There is no withdraw function.** The admin (multisig) can only choose the recipients, and a recipient change takes effect 7 days after it is announced
  Amounts that came due before the change are paid to the old recipient
- A recipient that rejects the money does not stop others from receiving. Its share stays in the pool
- The NeuroJobs share is paid through `fund()` directly into the runner reward pool

## Preparing the ZETAPHY distribution to SWD holders (stage 2: preparation only, no real distribution yet)

```
node airdrop/cli.js snapshot --mint <SWD mint> --exclude <pool vault addresses,...> > snapshot.json
node airdrop/cli.js allocate snapshot.json --min 1000000 --cap-bps 100 > allocations.json
node airdrop/cli.js merkle allocations.json > merkle.json
```

- **snapshot** sums the SWD balance of every account (SPL and Token-2022) per wallet owner. It only reads from Solana
  - Put the pool vault addresses in `--exclude` too, because coins in a pool belong to the liquidity providers, not to the PDA
- **allocate** splits 200,000,000 ZETAPHY proportionally
  - Filter out very small balances with `--min`
  - Cap each person's share with `--cap-bps` (100 = 1%). The amount above the cap is shared among the rest
  - Rounding remainders are shown in `dust` and are not lost
- **merkle** builds a 32-byte root plus each person's proof
  - This root is used with the distribution contract in stage 3
  - That contract must check the wallet owner's Solana signature and must pass an audit first

## Gate 1

```
zetaphy gate
```

Reports:
- How many days the chain has been running
- Whether blocks have ever stalled
- How many addresses of runners revealed answers in the last 30 days

On-chain data cannot tell whether these are "really different people", so this number is an upper bound and must be confirmed by a human

## Stage 3: a bridge whose losses cannot exceed a daily cap

> **The lock/mint bridge is CLOSED by default.** `deploy-bridge` (and the bridge step of `zetaphy-launch`) installs it closed: the route in `BridgeGuard` is not yet opened
> It can be opened with `zetaphy bridge open` only after passing **every gate** in the "Opening the bridge" section below, and `BridgeGuard` itself refuses to open without an audit or with fewer than 2 independent lanes

`BridgeGuard` sits between the bridge and the bridged coins, e.g. USDC on ZETAPHY

- **Each route's adapter** is the only one that can mint (inbound) or burn (outbound) that route's coins
  - An adapter that can be opened must be a `BridgeAirlock` with ≥ 2 independent lanes (`independentLanes()`). A single bridge (Hyperlane or any key directly) cannot be an adapter
  - Each direction has its own daily cap. If the bridge is hacked, the loss cannot exceed that day's cap
  - Every route's cap is at most `maxDailyLimit` (a hard cap, starting at 1,000 tokens; see "Caps grow step by step")
- The **guardian** can pause the bridge immediately, but cannot reopen it and cannot move funds
  - Only governance can reopen it (gov module or multisig)
  - Pausing the bridge does not stop the chain
- The IBC side (genuine USDC via Noble) also has a chain-level cap (`x/ratelimit`), set by governance with `zetaphy-chain/gov.sh propose-ratelimit` (see zetaphy-chain/README.md stage 3)

### The checkpoint before ZETAPHY: multiple bridges, Neuro as a bridge, marking attackers

```
Source chain (HyperlaneLockBox: lock + send Hyperlane message)
   │  lock coins
   ├──► Bridge 1: Hyperlane (HyperlaneLane) ─┐
   ├──► Bridge 2: Neuro (runners 2/3) ─┤──► BridgeAirlock (quarantine room) ──► BridgeGuard (daily cap) ──► ZETAPHY
   └──► (other bridges in future) ─────────┘          ▲ Neuro / guardian can veto during quarantine
                                                 ▲ marked address = not released until governance clears it
Attacker ──► contract watched by the monitor (secret list) ──► bridge monitor + marker key ──► BridgeAirlock.trip(caller)
```

1. **Several bridges must confirm the same thing:** one transfer must be confirmed by at least `threshold` independent bridges (default 2), and every detail must match
   - If a single bridge is hacked, it cannot forge money, no matter how long it waits
2. **Neuro is one bridge:** runners use `zetaphy bridge watch` to watch the LockBox on the source chain
   - Wait until the block has enough confirmations (`--confirmations`), then confirm the transfer
   - When runners with a full track record reach quorum (default 2) and agree, `NeuroLane` passes the confirmation on to the quarantine room
3. **Quarantine room:** once all confirmations are in, the transfer must wait `quarantine` seconds first
   - During that time runners can vote to veto (quorum), and the guardian can veto too
4. **Marking (marker):** governance sets a key that can mark addresses (`setMarker`: `deploy-bridge --marker 0x…` or `zetaphy bridge marker 0x…`). Normally this is the key of the monitor (bridge monitor) itself, which has no other rights at all
   - The only thing a marker can do is `trip(address)`: transfers from or to that address are not released (`Blocked`) until governance clears it (`untrip`, `zetaphy bridge untrip 0x…`). The money is not lost; it stays in the airlock
     (After clearing, `bridge watch` does not retry releasing items that previously got `Blocked`. Anyone can call `release` themselves)
   - A marker **cannot** confirm, veto, release, mint, or pause the bridge, and cannot move funds. If the key leaks, the damage is that some addresses' transfers are slowed, until governance removes the marker (`zetaphy bridge marker 0x… --off`) and clears the marks
   - The airlock **does not store the list of decoy contracts** on-chain: the list of contracts the monitor watches (watch list) is a repo secret (`BRIDGE_WATCHLIST`). It is not in any committed file and does not appear in the monitor's output. Whoever calls those contracts, the monitor alerts and marks the caller (see "Monitoring")
   - Only the direct caller is marked (the `msg.sender` that the watched contract emits in an event), not `tx.origin`. So someone tricked into calling an intermediate contract that touches a watched contract is not hit (the intermediate contract is hit instead)
   - Marking **does not actually pause the bridge** and is **not immediate**: the monitor does it in its next round, so `quarantine` must be set longer than the interval between monitor rounds (see "Monitoring")
5. Money that has passed every checkpoint must still pass the daily cap of `BridgeGuard` as one more layer
6. **Vaccine** (when `--threats` is set): a sender or source contract flagged in `ThreatRegistry`, or a recipient on ZETAPHY whose address or code is flagged
   - **Held once the flag is `holdDelay` old** (default 10 minutes, must be less than `enforceDelay`; governance adjusts it with `setHoldDelay` / `zetaphy threat hold-delay`):
     `BridgeAirlock` does not release (`ThreatHeld`). A newly added flag holds nothing yet, so 2 runners cannot instantly freeze someone's transfer, and governance and the guardian have time to look
     - **Immediate hold** is possible in two ways: the flag goes through the fast lane (`fastQuorum`), or governance / guardian calls `holdNow(key)` (`zetaphy threat hold-now <target>`)
     - **What lifts the hold:** only clearing the flag (same quorum, or a successful appeal) or governance protecting the key. Once lifted, it can be released immediately
     - **The LockBox side has no refund path:** while held (or vetoed), the coins stay locked in the LockBox on the source chain. There is no refund function, so the only option is to wait until the hold is lifted
     - `zetaphy bridge watch` asks `BridgeAirlock.heldParty` (using the registry's `is*Held`) before releasing. Held = not released. Cannot ask = not released (it can still confirm, because the airlock already holds it)
   - **Once the flag is enforced** (flagged for longer than `enforceDelay`, or via the fast lane; see stage 4): `NeuroLane` does not confirm, and `BridgeAirlock` refuses (`ThreatFlagged`), but the transfer **still stays pending and is not lost**. Once the flag is cleared, it can be released
   - `BridgeGuard` uses the same set of holds (`isContractHeld`: after `holdDelay`, via the fast lane, or `holdNow`) and does not wait for `enforceDelay`
     - **Inbound: queued, not reverted** (`InboundHeld`, id in `held`). The adapter's message counts as delivered, so there is no need to rely on the adapter to retry
       (Hyperlane does not resend the same message, and external adapters may not retry). Anyone can call `releaseHeld(id)` once the hold is lifted
       At release time it must still pass pause, the route still being open, and the route's daily cap (counted at release, not at queueing). Governance can drop items in the queue (`dropHeld`, e.g. from a hacked adapter)
     - **Outbound: revert** (`FlaggedContract`) just means nothing is burned yet. The coins stay with the holder (stolen money cannot be taken out over the bridge)
     - Via `BridgeAirlock`: a held transfer stays in the airlock itself (`release` later), and the airlock already checks the recipient before calling `inbound`
   - `BridgeGuard` **does not check the adapter**: governance chooses the adapter itself and can close routes itself, so a flag from runners (code hash or address) cannot stop a whole route
   - To hold longer than the flag (even after the flag is cleared): use the veto of the Neuro lane or the guardian
   - See details under "Vaccination" in stage 4
7. While Neuro is paused (`NeuroControl.paused`), `NeuroLane` confirms nothing, but can still vote to veto (keeping money safe at all times)
   - `deploy-bridge` uses NeuroJobs' `control()` as the switch automatically (`--control` can be used instead)
   - If `bridge watch` cannot read the switch (RPC down), it retries and **does not confirm** until it can read it (closed by default)

8. **Hyperlane is the second bridge (`HyperlaneLane`):** truly independent of NeuroLane, because what it confirms comes from Hyperlane's Mailbox and ISM (Hyperlane's validator set), not from runners
   - On the source side, `HyperlaneLockBox.lock(to, amount)` (pay amount + delivery fee `quoteLock`) locks the coins, emits a `Locked` event the same way as `LockBox` (runners can `bridge watch` as before)
     and sends a `dispatch(destinationDomain, recipient, body)` message through the Mailbox
   - On the ZETAPHY side, `HyperlaneLane.handle(origin, sender, body)` accepts only: the caller is the configured Mailbox, the configured origin domain, sender = the configured LockBox (or router),
     and the body states the source chain + source contract matching the configuration. Each item is accepted once (`Replay`)
   - body = `abi.encode(srcChainId, srcContract, nonce, sender, to, amount)`, the same fields that NeuroLane confirms, so it gets the same transfer id (`BridgeAirlock.transferId`)
   - Governance (multisig) can set the configuration (`setConfig`) and its own ISM (`setInterchainSecurityModule`; 0 = the Mailbox's default ISM). Every change is an event that the monitor alerts on
   - The Hyperlane v3 interface is hand-written in short form (no offline package), checked against `hyperlane-xyz/hyperlane-monorepo` commit `bc8cfcec461930ec005590bc838871f903a297a1` (see the header of `contracts/HyperlaneLane.sol`)
   - ZETAPHY does not have Hyperlane yet: Hyperlane's Mailbox + ISM + relayer + validators must be installed first (permissionless), and Hyperlane's validators must not be the same group as the Neuro runners
   - `independentLanes()` counts lanes by "controller" (`laneController()`: NeuroLane = NeuroJobs, HyperlaneLane = Mailbox, a direct key = itself). Two NeuroLanes on the same NeuroJobs count as 1
9. **The way back and more source chains (Saphan v2, docs/SAPHAN-MULTICHAIN.md):** one stack per source chain (its own `BridgeGuard`, so its own bridged token, airlock, lanes), so a hole in one route can never release ETH locked for another
   - Source side: `HyperlaneLockBoxV2` locks exactly like `HyperlaneLockBox` and also releases: only messages from ZETAPHY's domain and that route's `HyperlaneOutbox`, verified by a multisig ISM of OUR validators for origin ZETAPHY; each release waits a delay (guardian veto), a daily limit, a pause, and never exceeds what that lockbox holds for locks
   - ZETAPHY side: `HyperlaneOutbox.send(to, amount)` burns the route's token through an outbound-only route of the guard (`BridgeGuard.setOutboundRoute`: never mints, needs the audit and the cap) and dispatches the release; `deploy-bridge --hyperlane-outbox` deploys it closed, `bridge open` / `bridge close` handle both directions
   - The chain table (`zetaphy-chain/hyperlane/saphan-chains.json`), `scripts/saphan.js` (source-chain side) and the `saphan-route` workflow; `scripts/saphan-dryrun.js` runs a whole route on local chains
10. **Tokens born on ZETAPHY going out (Saphan token routes, docs/SAPHAN-TOKENS.md, `contracts/SaphanTokens.sol`):** the reverse of v2, for the native coin (its ERC-20 precompile `0xEeee…EEeE`) and any ERC-20 on ZETAPHY that governance adds to the table's `tokens`
   - ZETAPHY side: `ZetaphyTokenVault`, one per (token, destination chain): `lock(to, amount)` escrows the token and sends a mint; a burn coming back is released only from that chain's domain and its synthetic (an ISM of Hyperlane's validators for that chain), after a delay (guardian veto), within a daily limit, and never more than that vault holds; refuses fee-on-transfer, false-returning tokens and a `decimals()` other than the table's; optional ThreatRegistry holds
   - Destination side: `SaphanSyntheticToken` (e.g. `zZETAPHY`), an ERC-20 minted only by its vault's messages (a multisig ISM of OUR validators for origin ZETAPHY), after a delay, within a daily limit and a supply cap; `sendBack(to, amount)` burns and sends the release. Both ends start paused (closed); governance (the timelocks) opens them
   - `scripts/saphan.js token-check | token-prepare | token-vault | token-synthetic`, the `saphan-route` workflow with `token = <key>`, `scripts/saphan-dryrun.js --token <key|test>`; tests: `test/saphantokens.test.js`, `npm run test:devnet:saphantokens` (the native coin through the real precompile on a zetaphyd devnet)
   - BZTPHY (`ZetaphyPoints`) cannot be transferred, so it is listed but has no route

```
zetaphy deploy-threats --quorum 3 --min-agreed 5 --enforce-delay 3600
zetaphy deploy-bridge --lockbox 97:0x<HyperlaneLockBox> --quarantine 3600 --threats 0x<ThreatRegistry> \
  --hyperlane-mailbox 0x<Mailbox on ZETAPHY> --hyperlane-origin <source domain> [--hyperlane-ism 0x<ISM>] \
  --guardian 0x<guardian multisig> --governance 0x<governance multisig> --marker 0x<monitor key address>
#   installs closed (route not opened yet); daily cap starts at 1,000 tokens
#   --guardian / --governance must be multisigs (otherwise it does not deploy); a single key is allowed only with --devnet (RPC 127.0.0.1) or --allow-eoa-for-testing
#   with a ThreatRegistry, --lockbox is required (otherwise it does not deploy) so the source LockBox is always protected, or pass --no-lockbox-protect deliberately and run threat protect later
zetaphy threat set-governance gov        # or 0x<multisig>, after deploy-bridge has protected the bridge keys
zetaphy bridge watch --source-rpc https://<source chain> --lockbox 0x... --confirmations 12 --release
```

### Opening the bridge: every gate must pass

`zetaphy bridge gates ...` checks only · `zetaphy bridge open ...` checks then opens (if even one gate fails, it prints every missing item and exits with exit 1 without sending a transaction)

| # | Gate | Checked by |
|---|---|---|
| 1 | ≥ 2 lanes with **different controllers** (e.g. NeuroLane + HyperlaneLane). No lane whose controller or admin is the deployer's key. No admin of one lane controls another lane. No lane that is a single key | `BridgeGuard.setRoute(enabled)` requires `independentLanes() ≥ 2` (on-chain) + the CLI checks the rest and prints a lane / controller / admin / ISM table for a human to confirm |
| 2 | audit: `--audit-report <https url> --audit-sha256 <sha256 of the report file>` | On-chain: `BridgeGuard.setAudit` (event `AuditSet`), and `setRoute(enabled)` reverts `AuditMissing` if there is none yet |
| 3 | ≥ 10 independent Neuro runners (`--min-runners`, can be lowered on devnet only) | `NeuroJobs.activeWorkers()` (on-chain data cannot tell whether they are really different people: a human check is needed, like Gate 1) |
| 4 | guardian and governance are different multisigs (Safe or SimpleMultisig: threshold ≥ 2, owners ≥ 3, no duplicates, no deployer key). No owner is in both · governance may be the gov module | The CLI reads `getOwners/getThreshold` (Safe) or `owners/threshold` (SimpleMultisig) of the governance of BridgeGuard, BridgeAirlock, HyperlaneLane, and `BridgeGuard.guardians()` |
| 5 | Daily cap at most 1,000 tokens (above that needs `--raise-cap`) and at most `maxDailyLimit` on-chain | CLI + on-chain (`OverCap`) |
| 6 | Non-devnet chains need `--i-understand-real-funds` | CLI (devnet = `--devnet` + RPC 127.0.0.1/localhost: devnet and testnet use the same EVM chain id 77390, so they cannot be told apart by chain id) |
| 7 | (outside the CLI) a bug bounty already funded with real money (`docs/BUG_BOUNTY.md`) and the monitor already running | Project owner |

```
zetaphy bridge open --audit-report https://<auditor>/zetaphy-bridge.pdf --audit-sha256 <sha256sum of the file> \
  --daily-limit 1000 --i-understand-real-funds
#   if this key is not governance: prints to/data for the multisig (setAudit first, then setRoute), or a MsgEVMCall if governance is the gov module
zetaphy bridge pause        # guardian: stop everything immediately (only governance can reopen: unpause)
zetaphy bridge close        # governance: close the route
```

**Testnet mode (test coins only, NOT audited):** `--testnet` works only on the public ZETAPHY testnet. The CLI checks that the chain id is 77390 and that block 1 is `0xbfda796f…754295a`. Any other chain is refused, and so is `--testnet` together with `--devnet` or `--i-understand-real-funds`.
- What it relaxes, and only these:
  - The audit is the testnet notice [docs/BRIDGE-TESTNET.md](../docs/BRIDGE-TESTNET.md): its exact URL and the sha256 of the file.
  - 1 Neuro runner is enough.
  - Guardian and governance multisigs need only 2 owners (threshold still 2+, still no deployer key).
  - It stands in for `--i-understand-real-funds`.
- What it tightens: the daily limit is at most **100 tokens**, even with `--raise-cap`.
- Everything else holds: 2+ independent lanes, the on-chain hard cap.
- Every output line starts with `[TESTNET (not audited)]`. Mainnet needs a real audit and every gate.
```
zetaphy bridge open --testnet --audit-report https://github.com/pospos191-alt/swd-amm/blob/main/docs/BRIDGE-TESTNET.md \
  --audit-sha256 $(sha256sum docs/BRIDGE-TESTNET.md | cut -d' ' -f1) --daily-limit 100
```

### Caps grow step by step

- `maxDailyLimit` starts at **1,000 tokens** (in the token's decimals) at `createToken`. It is the hard cap for every route (a route set higher still uses this cap)
- **Lower:** governance can lower it immediately (`proposeMaxDailyLimit` with a lower value), which also cancels any pending raise
- **Raise:** governance can propose at most **2×** the current cap, then wait **7 days**. Anyone can call `applyMaxDailyLimit` after that (it can be cancelled with `cancelMaxDailyLimit`). Every step is an event the monitor reports
- CLI: `zetaphy bridge cap` / `bridge cap propose <tokens>` / `bridge cap apply` / `bridge cap cancel`
- Recommended plan (raise when the previous 2 weeks had no serious alerts and the bridge amount is still less than 1/3 of the stake, per Gate 3):

| Week | Daily cap |
|---|---|
| 0 (open) | 1,000 |
| 2 | 2,000 |
| 4 | 4,000 |
| 6 | 8,000 |
| 8 | 16,000 |
| Every 2 weeks after that | ×2 up to the target governance votes for |

### multisig + hardware wallet

- **Separate multisigs:** guardian (presses pause) and governance (sets config, opens routes, reopens) are different multisigs. **One person holds one key.** No owner is shared between the two. No deployer key
- **Each owner uses a hardware wallet** (Ledger or Trezor) through MetaMask: MetaMask → account icon → **Add account or hardware wallet → Add hardware wallet** → choose Ledger/Trezor → choose the account
  - Add the ZETAPHY network in MetaMask (chain id 77390, public RPC), then use that hardware account's address as the owner
  - Confirm every transaction on the device screen (check `to` and data). Never store the device seed on a computer or in the cloud
- **SimpleMultisig** (in this folder): `zetaphy deploy-multisig --owners 0xA,0xB,0xC --threshold 2`. Each owner does `propose` / `confirm` / `execute` from MetaMask (e.g. the explorer's "Write contract" page)
- **Safe:** the chain has the Safe singleton factory (`0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`) installed from genesis, so Safe (singleton, proxy factory) can be deployed at the same addresses as on other chains with
  safe-deployments, then use self-hosted Safe{Wallet} or the Safe CLI with the ZETAPHY RPC · `bridge open` can read the Safe's `getOwners()` / `getThreshold()`
- Governance can be the gov module (`0x7b5F…3dF2`, changes by vote), but the guardian should be a multisig that can act quickly

### Monitoring (monitor) and alerts

`zetaphy bridge monitor` reads events from BridgeGuard, BridgeAirlock, NeuroLane, HyperlaneLane, ThreatRegistry, ZetaphyTimelock, ZetaphyOracle (addresses read from the launch state or `--timelock` / `--oracle`; without a bridge it can still watch these two), (if `--source-rpc --lockbox` is given) the source LockBox, and the contracts in the watch list (if any), then alerts when (it uses a key only when `BRIDGE_MARKER_KEY` is set, for marking):

| Rule | When |
|---|---|
| `volume` | Today's inbound or outbound total ≥ 80% of the cap (`--volume-pct`) · reaching the cap = critical |
| `lanes-disagree` | The same deposit (same chain, contract, nonce) is confirmed with different details (critical) |
| `lane-missing` | One lane confirms, the other lane does not confirm within 30 minutes (`--disagree-minutes`) |
| `lane-silent` | There is a deposit on the source chain but no lane confirms within 30 minutes (`--silent-minutes`, requires `--source-rpc`) |
| `release-stalled` | All lanes + quarantine done but not released within 30 minutes (relayer silent, or held) |
| `veto` / `pause` | A veto happened, the guardian pressed pause (critical) |
| `watch-hit` | A contract in the watch list emitted an event (critical). It names only the caller, not which contract |
| `marked` | An address was marked (`Tripped`). Done by this monitor itself = warning · done by another marker = critical (check who holds that key) |
| `mark-failed` | Marking failed (key is not a marker, not enough gas). Retries every round (critical) |
| `mark-skipped` | The caller is a contract (e.g. Multicall, a router many people share), so it is not marked automatically; a human decides (warning) |
| `hold` | BridgeGuard's `InboundHeld`, ThreatRegistry's `HeldNow` / `FastEnforced` |
| `governance-change` | Changes to route, cap, `maxDailyLimit`, lane, vetoer, marker, guardian, governance, audit, registry, HyperlaneLane config/ISM, unpause, untrip |
| `large-transfer` | A single item ≥ 25% of the daily cap (`--large-pct`) |
| `timelock-scheduled` | A call was scheduled in ZetaphyTimelock: target contract, function name (if known), and the time it can run (ETA) · changes to governance/role/delay/lane/price = critical · this is the window when it can still be cancelled |
| `timelock-proposal` | A gov vote proposal that would schedule (or cancel) something in the timelock, read from the node's Cosmos REST (`--rest`, default `<RPC https>/rest`) and the MsgEVMCall details from CometBFT (`--comet-rpc`, default `<RPC https>/rpc`). Visible from the voting period |
| `timelock-executed` / `timelock-cancelled` | A call that finished waiting was actually executed / was cancelled |
| `timelock-delay` | The timelock's wait period changed (`MinDelayChange`, critical) · adding/removing a timelock role = `governance-change` |
| `oracle-deviation` | The DEX TWAP and Pyth differ by more than `maxDeviationBps` (`DeviationTripped`, no price, critical) |
| `oracle-stale` | A price source is too old (`StaleFeed`, or `price()` refuses with `TwapStale`/`PythStale`) |
| `oracle-breaker` | Circuit breaker: the price jumped past the per-round/per-period cap. No price until governance resets it through the timelock (critical) |
| `oracle-paused` / `oracle-problem` / `oracle-unavailable` | The guardian paused the price (critical) / other price source problems (low liquidity, not enough data, spike) / `price()` currently returns no price |

Output is JSON (`--out`), a Thai + English summary (`--summary` and the screen), and issue content (`--issue`). The same alert is not repeated (kept in `--state` along with the last block read) · `--quiet` prints only the counts (for public logs)

**Secret values are read only from the environment (repo secrets), never from committed files:**
- `BRIDGE_MONITOR_THRESHOLDS`: JSON overriding the thresholds in `bridge-monitor.json`, e.g. `{"volumePct": 60, "largePct": 10}` (keys `volumePct`, `largePct`, `silentMinutes`, `disagreeMinutes`)
  **The values in `bridge-monitor.json` are only public defaults.** The values actually used can be set as a secret (order: command-line option > secret > file > value in code)
- `BRIDGE_WATCHLIST`: JSON `[{"address": "0x…", "callerTopic": 1}]`, contracts where every event = alert. The caller is read from the topic at `callerTopic` (default 1 = the first indexed parameter)
  - A watched contract must put its own `msg.sender` into that topic. If the caller could choose the value that goes there, it could get anyone marked
  - Caller = the direct caller, so someone lured through an intermediate contract is not hit (the intermediate contract is hit instead)
  - No output of the monitor mentions a watched contract's address (alerts, JSON, summary, issue, state); it uses the words "a watched contract" instead. A test suite checks every output
- `BRIDGE_MARKER_KEY`: the marker's private key (governance sets it with `zetaphy bridge marker 0x<address of this key>`). The monitor calls `trip(caller)` for new callers that are not yet marked (remembered in state, not repeated)
  - This key is never printed or logged anywhere. Keep only enough ZETAPHY in it for gas, and do not give it any other rights
  - Addresses that governance has cleared (`untrip`) are not marked again by the monitor on its own (it alerts so a human decides)
- Once any of the values above is set, the `--state` file is encrypted (AES-256-GCM with a key derived from those secret values). Only the last block number read is left unencrypted
  Whenever a secret value changes (e.g. rotating the watch list or the marker key), the old memory can no longer be read. The monitor continues from the same block with a new memory (an old alert may repeat once; it does not re-read history)

**GitHub Actions (`.github/workflows/bridge-monitor.yml`):** the schedule is currently turned off (a private repo only gets 2,000 free minutes/month). It can be run manually (set `from_block` to re-read); once the bridge is open, enable the `schedule` line in the file
1. Put the bridge addresses in `zetaphy-network/bridge-monitor.json` (`bridgeGuard`, `bridgeAirlock`, `startBlock`, `rpc`), or leave them empty to read from `zetaphy-launch/state/77390.json`
   Put the RPC in that file or as the repository variable `ZETAPHY_RPC` (Settings → Secrets and variables → Actions → **Variables**)
2. No bridge yet = the workflow does nothing (notice, then exit 0)
3. **Actions logs, step summaries, artifacts and issues of a public repo are visible to everyone,** so the workflow prints only the alert count (`--quiet`), not the details
   and keeps the report artifact (`bridge-monitor-report`) only when the repo is private · the `bridge-monitor-state` artifact is encrypted with the secret values (above)
4. Alert details go to private channels only (all secrets; values are never printed to the log):
   - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` and/or `DISCORD_WEBHOOK_URL`
   - `PRIVATE_ALERTS_TOKEN`: a fine-grained token with Issues: read and write on the private repo only (variable `PRIVATE_ALERTS_REPO`, default `pospos191-alt/zetaphy-private`). Alerts become `bridge-alert` issues there
   - Issues in this repo **only** when the variable `BRIDGE_ALERT_ISSUES` = `on` (if the repo is public, the alerts become public)
5. Alerts but no channel to receive them = the run **fails** with a short message (counts only) and does not save state. The next round re-reads the same blocks and sends again
6. The last block read is kept in the `bridge-monitor-state` artifact of the last successful run. The next run continues from there and does not re-read
7. **Automatic marking is not immediate:** the monitor marks in its next round. The airlock's `quarantine` (default 3600 seconds) must be longer than the round interval plus the scheduler's delay (often 5–15 minutes)
   Otherwise the caller's transfer may be released first. Hourly runs need a quarantine well over 1 hour · recommended when the repo is public: every 15 minutes (`*/15`) with a quarantine of at least 2 hours (`setQuarantine(7200)`)
8. Cost: public repo free · private repo: hourly ~720 minutes/month, every 15 minutes ~2,900 minutes/month (over the 2,000 free quota)

## Timelock: every rule change waits 48 hours, except emergency buttons that only reduce risk

Every admin right of the important contracts belongs to **ZetaphyTimelock** (= OpenZeppelin `TimelockController` 5.4.0 unmodified + OpenZeppelin's `AccessControlEnumerable`, so it can be counted on-chain who holds which role)
- **Wait period (min delay):** 48 hours by default. Below 24 hours is allowed only on devnet (`--devnet` + RPC 127.0.0.1); both `deploy-timelock` and the launch tool refuse otherwise
- **proposer / canceller:** only the governance multisig (or the gov module `0x7b5F…3dF2`, proposing by vote)
- **executor: anyone** (`address(0)`), because what will be called is locked at scheduling time and everyone has seen it for 48 hours. Letting anyone press execute adds no risk, but prevents "hostage" situations: a proposer who disappears, or a gov module that would need a second vote, cannot leave an approved change stuck. While waiting, the canceller can always cancel (choose `--timelock-executor governance` if you want)
- **admin: the timelock itself.** There is no admin key. Adding a proposer or changing the wait period also has to wait 48 hours (`MinDelayChange`, `RoleGranted`; the monitor alerts)
- The OpenZeppelin files used are copied into `vendor/@openzeppelin/contracts/`, only the ones needed (22 files), unmodified. `vendor/openzeppelin-contracts.json` records version 5.4.0, the npm tarball integrity (`sha512-eCYg…6A==`), and the sha256 of every file. `scripts/build.js` refuses to build if any file does not match or imports from elsewhere (no node_modules, no network)

| Contract | Goes through the timelock (wait 48 h) | Can be done immediately (guardian: risk reduction only) |
|---|---|---|
| BridgeGuard | `setGovernance`, `setGuardian`, `setAudit`, `setRoute` (open/set), `proposeMaxDailyLimit` (raising the cap still waits its own 7 days), `setThreats`, `unpause`, `dropHeld` | `pause`, `lowerMaxDailyLimit` (lower only), `cancelMaxDailyLimit`, `disableRoute` |
| BridgeAirlock | `setLane`, `setMarker` (add), `setVetoer`, `setThreshold`, `setQuarantine`, `setThreats`, `untrip`, `setGovernance` | BridgeGuard's guardian: `emergencyRemoveLane`, `emergencyRemoveMarker`, `emergencyRaiseThreshold`, `emergencyRaiseQuarantine` (raise only, max 30 days) · vetoer: `veto` · marker: `trip` |
| HyperlaneLane (if any) | `setConfig`, `setInterchainSecurityModule`, `setGovernance` | – |
| ThreatRegistry (+ ThreatReports that follows it) | `setGovernance`, `setEnforceDelay`, `setHoldDelay`, `setFastQuorum`, `setGuardian`, `setIdentity`, `setResponder`, `setAppeals`, `setProtected` · ThreatReports: `setFee`, `setTtl`, `setCommunityFund` | `holdNow`, `enforceNow` (only flags already set by quorum) |
| NeuroControl (the NeuroJobs settings) | skills, defenders, chains, runner cap, challenge stake, community fund, `setGuardian`, `setGovernance`, `unpause` | `pause` |
| NeuroJobs | – (all values live in NeuroControl; `setControl` is a one-time call by the deployer, already used; launch checks it) | – |
| RewardVault | `proposeShares`, `cancelShares`, `setGovernance` (`applyShares` by anyone after its own 30 days) | – |
| StableGateway | `setOracle`, `setToken`, `setTestnetFixedPrices`, `setTestnetFixedPrice`, `sweep`, `withdrawReserve`, `setGuardian`, `setOwner`, `unpause` | `pause` |
| ZetaphyOracle | `setTwap`, `setPythFeed`, `setGuards`, `setPyth`, `setGuardian`, `setGovernance`, `unpauseFeed`, `resetCircuitBreaker` | `pauseFeed` |
| ZetaphyPythRelay | `setRelayer`, `setThreshold`, `setGovernance` | (stop using the price: the oracle's `pauseFeed`) |
| NeuroIdentity | `addChain`, `setWeb`, `setAdmin` | – |
| DEX factory (+ the router's `sweep`) | `setFeeTo`, `setThreatRegistry`, `setGovernance` (two steps: the timelock calls `acceptGovernance`) | – |
| NFT marketplace | `setFee`, `setThreatRegistry`, `setGovernance` | – |
| No admin | ComputeMarket, NeuroValidation, NFT factory, QuantumWalletFactory, NeuroLane, LockBox, TwapRecorder | – |

**Where roles are split (as little as possible):** BridgeGuard already has a guardian; only 3 risk-reducing functions were added · BridgeAirlock creates no new role; it uses the same BridgeGuard guardian · StableGateway and ZetaphyOracle have a guardian that can only pause. The rest use the existing guardian/vetoer/marker
- Removing a marker clears all marks that marker made (same as `setMarker(false)`)
- `dropHeld` (drop a held mint) cannot be undone, so it goes through the timelock. While waiting, the guardian can press `pause` immediately
- Security details of the timelock and guardian are kept separately for the team.

```
zetaphy deploy-timelock --proposer 0x<multisig>[,0x…] | gov [--delay 172800 --executor open]
zetaphy timelock schedule --to 0x<contract> --sig "setFee(uint16,address)" --args 100,0x… [--salt text --proposal-out p.json]
#   if this key is a proposer: sends directly · if not: prints to/data for the multisig (SimpleMultisig: propose/confirm/execute, Safe: Transaction Builder)
#   if the gov module is the proposer: writes a proposal file (MsgEVMCall to the timelock) for zetaphyd tx gov submit-proposal p.json, then gov.sh vote <id> yes
zetaphy timelock status [<operation id>]   # wait period, who holds which role, status (Waiting/Ready/Done) and ETA, the function to be called
zetaphy timelock execute <operation id>    # anyone, after the wait period ends (reads the details from the CallScheduled event itself)
zetaphy timelock execute <id> --to 0x… --sig "…" --args … [--salt …]   # calls scheduled by a gov vote: pass everything exactly as schedule printed (MsgEVMCall leaves no log in eth_getLogs)
zetaphy timelock cancel <operation id>     # canceller (multisig) while waiting
```
- The existing governance commands (`bridge …`, `threat …`, `oracle feed`) know when governance is the timelock and print the `zetaphy timelock schedule …` command to use instead
- Repeating the same call needs a new `--salt` (operation id = hash of to, value, data, predecessor, salt)

## Price: ZetaphyOracle (DEX TWAP + Pyth with guards against wrong prices)

`price(asset)` returns `(value, updatedAt)`: the price in USD with 18 decimals, or it always **reverts with a named reason**. It never returns a price that is stale, skewed, or jumping
- **(a) TWAP of trading pairs on our DEX** (ZetaphyPair stores `price0/1CumulativeLast`) against stablecoins counted as $1
  - `TwapRecorder` stores observations: anyone can `record(pair)` (keeper, relay, users), at most once per `minSpacing` and per block. No admin
  - Usable when the window is long enough, there are enough observations, the pool is deep enough at every observation, and no sub-period has an abnormal price (set with `oracle feed`)
- **(b) Price from Pyth** through Pyth's own `IPyth` interface (`getPriceUnsafe`, the same `Price` struct): checks age, future timestamps, positive price, confidence interval (`conf`), and converts the exponent (`expo`) to 18 decimals
  - ZETAPHY does not have Pyth yet: `ZetaphyPythRelay` accepts updates **in the same format as Pyth** (`abi.encode(PythStructs.PriceFeed, uint64 prevPublishTime)`, like `MockPyth.createPriceFeedUpdateData`) from relayers set by governance. It accepts only when `threshold` relayers send the same update
  - The relayer forwards prices from Hermes (Pyth's free public service): `zetaphy oracle relay-pyth --feed 0x<feed id> --every 30`
  - **Connecting to the real thing later:** (1) Pyth comes to ZETAPHY: the timelock calls `oracle.setPyth(<Pyth>)`, no contract change needed (Pyth checks Wormhole signatures itself), or (2) Hyperlane: a receiver whose `handle()` takes Pyth updates from a chain where Pyth has verified them acts as the single relayer (threshold 1) of ZetaphyPythRelay
- **The two sources must agree** within `maxDeviationBps` (otherwise `SourcesDeviate`). The returned value is Pyth's, anchored by the TWAP. A single source can also be enabled (testnet currently uses TWAP only until there is a feed)
- **Circuit breaker:** `poke(asset)` (anyone) records an observation and, if every check passes, sets that price as the reference price. A price that jumps past the per-round or per-period cap is rejected (`PriceJump`), and a poke that hits it trips the circuit (`CircuitBreakerTripped`). There is no price until governance calls `resetCircuitBreaker` through the timelock
- Every value belongs to the timelock, except `pauseFeed`, which the guardian can press immediately
- Send `poke` with fixed gas (the tools here use 800,000), not an estimate
- Security details (the reasons for the guard values and the limitations) are kept separately for the team.

```
zetaphy deploy-oracle --relayers 0x<relayer> [--min-spacing 60 --guardian 0x<multisig>]
zetaphy oracle feed 0x<WZETAPHY> --pair 0x<pool> --window 1800 --min-observations 10 --min-liquidity 10000 \
  [--pyth-id 0x<feed id> --max-age 120 --max-conf 100] --max-deviation 200 --max-change 1500 --max-window-change 3000 --change-window 3600
zetaphy oracle poke 0x<WZETAPHY>        # keeper (or relay start --poke-oracle 60)
zetaphy oracle status [0x<asset>]       # price sources, guard values, live price, and the reason if there is no price
zetaphy oracle pause 0x<asset>          # guardian: stop immediately (reopen through the timelock)
```

## Immunity and runners growing/shrinking

A **body** is a runner that is eligible to take one job

- Number of bodies = 4 + ceil(requests per minute ÷ 6), at most NeuroControl's `maxBodies` (default 64; going above the cap needs a vote)
  - Requests per minute = the recent busiest minute, which decays linearly to 0 over 30 minutes
  - E.g. a minute with 33 requests gives 10 bodies · idle for 15 minutes leaves 7 · idle for 29 minutes leaves 5 · after 30 minutes it goes back to 4
  - Each job remembers the body count at submission (`jobInfo`). Nobody can change it later
  - Only requests that pass every check are counted, and only chains on the list approved by vote are accepted, so requests for fake chains revert and do not make bodies grow
  - Unanswerable requests that time out still lose 5% (burned). The more someone attacks, the more money they lose
- **4 defender seats**: always eligible for jobs, and counted in the body count
  - Filled from the list approved by vote (`approve-defender`) with `zetaphy neuro regrow` (anyone can call it)
  - At most `maxRegrowPerHour` seats can be filled per hour (default 4)
  - If the defenders do not take a job before 1/3 of the commit time has passed, the lottery opens to at least 3 other bodies, then doubles, and in the last 1/3 every runner is eligible. So seats always fill if people are online, no matter how the lottery comes out
  - **1 defender per round, at all times**: a second defender can never sit in the same round (in all 3 phases of the commit time and in challenge rounds), unless all active runners are seated defenders (nobody else at all, so the job does not get stuck). So 2–3 defenders cannot take all the seats as long as there are other runners
  - Defenders do not use lottery eligibility (they can only enter through the defender seat)
- **heartbeat**: an offline defender loses its seat
  - The runner calls `heartbeat()` (a commit or reveal also counts). The runner program sends it itself about every 1/4 of `defenderTimeout`
  - Silent for longer than `defenderTimeout` (default 6 hours, changed by the `set-defender-timeout` vote) loses defender eligibility immediately, and the next `regrow` removes it from the seat
  - After coming back, it must `heartbeat` before `regrow` will seat it again
- **Quarantine**: 2 strikes (not matching the majority, or committing without revealing) within the last 5 settled jobs (K = 2), not necessarily in a row
  - Out immediately: `workers().active` becomes false and it is not counted in the runner count or the total bond, so ThreatRegistry, NeuroLane and NeuroValidation do not count its votes either. A defender loses its seat immediately
  - The bond starts withdrawing automatically: `zetaphy node withdraw-bond` works after a 1-hour wait (after penalties). Seats taken earlier can still reveal
  - The same address cannot register again until a vote passes (`release`). After that it can `register` again (any bond not yet withdrawn is counted, and the withdrawal is cancelled)
- Cycle: detected (repeated wrong answers) → quarantine → `regrow` grows new bodies from the list approved by vote → the whole network is informed through `ThreatRegistry`
- Check status: `zetaphy neuro status`

## Challenge round (challenge) and confidence level

While there are still few runners, 2 runners colluding might get seats together and decide the result themselves. But Neuro's verdict can always be recomputed (same data, same code, same answer). Anyone can re-run Neuro and prove that pair wrong

- **Challenge**: `zetaphy job challenge <id> --verdict 0x<correct answer>` (or `challenge(id, claim)` on the contract) within the challenge window after the result
  - You must state the answer you believe is correct (`claim`, must not be 0 and must not equal the current result)
  - Challenge window = NeuroControl's `challengeWindow` (default 0 = equal to the job timeout `jobTimeout`)
  - Stake = at least max(2 × job fee, `challengeBond`) (default 1 ZETAPHY)
  - Only one round can be open at a time. No challenges while the pause button is pressed
  - A round that ends as **disputed** can be challenged again within the new challenge window (counted from the end of that round), up to `MAX_CHALLENGES` = 2 times per job (3 rounds including round 1). A result that is confirmed or overturned is final
- **Challenge round**: 3 new seats, drawn by lottery the same way as round 1 (from the hash of the block after the challenge block). Nobody who sat in any earlier round, and no challenger, may sit. Uses commit-reveal and 2-of-3 as before
- **Outcome**:

| Challenge round | Round-1 runners who agreed on the wrong answer | Challenger | Who gets the money |
|---|---|---|---|
| **Overturned, to the answer the challenger stated** | Lose **50%** of bond + 1 strike (may be quarantined) | Gets the stake back + half of the slashed bond | The other half is split equally among the challenge-round runners who matched and the round-1 runners who were right but outvoted · the job's result changes to the challenge round's |
| **Overturned, to another answer** (matches neither the old result nor the challenger's claim) | Lose 50% of bond + 1 strike | **Loses the whole stake** (also stated the wrong answer) | The slashed money + stake are split equally among those who matched the new result |
| **Confirmed** (matches round 1) | Lose nothing | Loses the stake | Half to the challenge-round runners who matched, the other half to the round-1 runners who matched (so random challenges have a price) |
| **No conclusion** (no 2-of-3, or timeout: `challengeExpire`) | Lose nothing | Gets **80%** back | The other **20%** is split among that round's seats that revealed (nobody revealed: goes to the community fund) · the old result stays, labelled "disputed", and can be challenged again · seats that committed but did not reveal lose 10% + a strike |

- **Challenging yourself to close off further challenges** no longer works: previously a round with no conclusion refunded the full stake and closed challenges for good. Now it loses 20% and others can keep challenging
- In every case all money is accounted for to the wei: remainders from uneven division go to the community fund
- **The bond is held** (`heldUntil`) until nothing more can be slashed. It cannot be withdrawn early, so a lying pair cannot run away before being slashed
  - Every seat: until the round start time + 2 × `jobTimeout`
  - Round-1 runners: until the challenge window ends + 2 × `jobTimeout`, extended further when a challenge opens or ends as disputed (new challenge window)
  - Every round has a **reveal deadline** = round start time + `jobTimeout` (after that, reveal is not possible; you must `expire`/`challengeExpire`). So every slash happens before the bond is released from the hold, and `expire`/`settle` have another 1 `jobTimeout` for someone to call them
- Round-1 fee shares already paid are not clawed back. What makes cheating not worth it is the 50% bond slash (bond 100 ZETAPHY versus a job fee of 0.1 ZETAPHY)
- A runner slashed until its bond is below the minimum: stops taking jobs, and the bond withdrawal timer starts immediately (`withdraw-bond` works after `unbondDelay` and after the hold ends), or `register` to top up and come back (cancels the withdrawal). So leftover money does not get stuck in the contract
- Challenge-round seats have the same reveal grace period and `settle` as round 1
- **Confidence level** (`assurance(id)` on the contract, `zetaphy job get`): the Neuro web page can show "confirmed by N runners"
  - `agreedBy`: number of runners (unique) who matched the final result: 2 or 3 after round 1, 4 or more after a challenge confirms
  - Latest challenge status (none / challenge round running / confirmed / overturned / disputed), challenge window end, and `settled` (nobody can challenge any more) · `challengeRound(id)` tells how many challenges there have been and what answer the latest challenger stated

## An unpredictable lottery

- At job submission the contract records no random value, but remembers the submission block (B) and the total bond at that time
- The round's lottery value: `rand = keccak256(seed, blockhash(B + 1), round)`, usable from block B + 2
  - This value is fixed as soon as block B + 1 exists, no matter who computes it or when: **it cannot be re-rolled**
    - Previously (using `PREVRANDAO` of the commit block), a commit that reverted with `NotChosen` cancelled the draw, so someone could send a new commit every block until they got a value they liked, and a contract could help call `draw()` only when the result suited it. Now doing that gives the same value every time
  - `eligible()` can be computed from a view right away, without waiting for anyone to call `draw` · the first commit, or `draw(id)` (anyone can call it), records the value
  - A job cannot be submitted and drawn in the same block or the very next block (`TooEarly`)
  - Challenge rounds draw their own lottery the same way (from the hash of the block after the challenge block)
- **The total bond is snapshotted when the round opens**: someone posting a large bond after the job is submitted (or someone withdrawing) cannot change who is eligible. Previously an attacker could post a large bond after the draw to push eligible runners out until the last 1/3
- **Limitations**
  - `blockhash` only goes back 256 blocks. If nobody records the lottery within that range, `draw(id)` moves the round to the current block (`Redrawn`) and uses the new block hash. Someone who dislikes the result cannot force this to happen as long as at least one runner is watching (one commit or `draw` is enough to record it)
  - The proposer of block B + 1 (a validator) can still adjust that block's content to try several hash values. This is the remaining bias, and it belongs to validators only
  - Chains where `BLOCKHASH` returns 0 (older zetaphyd): a fixed fallback `keccak256(seed, 1, round)` is used. It still works, but is as predictable as drawing from the request data alone · zetaphyd v3 and later and the EVM in the test suite provide `blockhash`

## Neuro pause button and skill voting

`NeuroControl` is Neuro's control panel, separate from the coin. Its owner (governance) is the chain's gov module

- EVM address of the gov module: `0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2` (the first 20 bytes of sha256("gov") = `zetaphy10d07y265gmmuvt4z0w9aw880jnsr700jvr86lj`)
- **Pause button** (`paused`)
  - Stops new job submissions and commits
  - Runners stop taking jobs, but can still reveal the seats they already have
  - Does not stop coin transfers, staking, earnings withdrawals, or refunds
  - The guardian can pause immediately, but it can only be reopened by a vote
- **Skill** (skill id)
  - It is the sha256 of the Neuro code (`zetaphy-neuro/src/**/*.js` and `src/lang/*`). See it with `zetaphy neuro skill-id`
  - You can compute it yourself: `cd zetaphy-neuro && find src -type f \( -name '*.js' -o -path 'src/lang/*' \) | LC_ALL=C sort | xargs sha256sum | sha256sum`
  - A new skill (changed Neuro code) must pass the `approve-skill` vote, then `set-active-skill`
  - A job remembers the skill at submission. Runners only take jobs whose skill matches the code on their machine

```
zetaphy deploy --governance gov --community-fund 0x<community fund>   # NeuroJobs + NeuroControl, sets this machine's skill and chains, then hands over to the gov module
zetaphy neuro skill-id

# on a node: propose a vote (MsgEVMCall where the gov module calls NeuroControl)
gov.sh neuro pause 0x<NeuroControl>
gov.sh neuro unpause 0x<NeuroControl>
gov.sh neuro approve-skill 0x<skill id> 0x<NeuroControl>
gov.sh neuro set-active-skill 0x<skill id> 0x<NeuroControl>
gov.sh neuro approve-defender 0x<runner> 0x<NeuroControl>
gov.sh neuro release 0x<runner> 0x<NeuroControl>
gov.sh neuro set-max-bodies 100 0x<NeuroControl>
gov.sh neuro approve-chain bsc 0x<NeuroControl>    # chains NeuroJobs accepts jobs for (remove-chain removes one)
gov.sh neuro set-challenge-bond 2.5 0x<NeuroControl>       # minimum challenge stake (ZETAPHY, decimals allowed)
gov.sh neuro set-challenge-window 3600 0x<NeuroControl>    # seconds after the result during which challenges are allowed (60 to 7 days)
gov.sh neuro set-defender-timeout 21600 0x<NeuroControl>   # a defender silent longer than this loses its seat (60 to 7 days)
gov.sh vote <id> yes
```

Message in the proposal:

```
{"@type": "/zetaphy.pq.v1.MsgEVMCall", "Sender": "<gov module zetaphy1…>", "To": "0x<NeuroControl>",
 "Value": "0", "Data": "<calldata as base64>", "GasLimit": "300000"}
```

- If governance is a `SimpleMultisig` instead:
  - `zetaphy neuro propose pause --multisig 0x<multisig>`, then the other owners confirm and execute
  - `zetaphy neuro calldata <action> [value]` prints the calldata so you can send it yourself
- Guardian pause: `zetaphy neuro send pause`

## Stage 4: the immune system and the AI compute market

**ThreatRegistry**
- Runners that are still active and have accepted answers vote to record that "code with this fingerprint behaves riskily toward users in category X"
  (it is a factual record about code, not a judgement of the intent of a person or project)
- 3 votes from different addresses set the flag
- Neuro reads this flag through `threatLookup` and gives a **high** warning for every contract using the same code on every chain
- Clearing a flag also needs 3 votes (an appeal to the network, not to one person)
- The category (`Reason`) is a re-checkable fact about the code, not intent (numbered in the contract's order; codes in the CLI and `src/vaccine.js`):
  1 `cannot-sell-in-simulation` a simulated buy then sell could not sell · 2 `unlimited-mint` can mint unlimited coins ·
  3 `owner-can-block-transfers` the owner can block transfers · 4 `owner-can-move-holder-funds` the owner can move holders' funds ·
  5 `same-name-as-known-token` same name/symbol as a known token but a different address · 6 `sweeps-approved-tokens` tested and moved approved tokens to an address the holder did not choose · 7 `other`
- **Evidence for every flag:** a flag vote must include a `reportHash` (the reportHash of a Neuro report, or the hash of a reproducible report) and a short URI (at most 200 bytes)
  The evidence for every vote is in the `Voted` event; `evidenceOf(key)` stores the first vote's (the vote the flag's category came from). Anyone can re-check: run Neuro on the same code and compare the reportHash
  `voteBatch` uses one piece of evidence for the whole batch. Votes to clear a flag need no evidence
- **Right to respond:** `respond(key, chainId, account, text)` (at most 500 bytes). A response does not change the flag
  - **Stored separately per author** (key, author): you can edit or delete (empty text) only your own. Nobody can replace or delete someone else's. An author can always delete their own, even after losing the right to respond
  - At most `MAX_RESPONSES` (8) per key. A new author beyond that replaces the least recently edited one (not one from a governance-appointed responder)
  - Read: `responseAt(key, i)` — governance-appointed responders first, then newest first, `responseCount(key)`, `responseBy(key, author)`, `responseOf(key)` = `responseAt(key, 0)`
  - Wallets and the snap show at most 3 next to every warning, **with the author's address** (governance-appointed responders first)
  - Who can respond (`mayAnswer`):
    - `addressKey` of an address on ZETAPHY: the address itself, or the current `owner()` if it is a contract
    - `addressKey` on any chain: the owner of a claimed ERC-8004 identity for `eip155:<id>:<address>` in NeuroIdentity (`setIdentity`, zero = off)
    - **`codeKey` and `fp1`: only a governance-appointed responder (`setResponder`)**, because anyone can deploy a contract with the same code and set `owner()` to themselves, so a code key has no on-chain owner to ask
    - For any key where governance has appointed a responder: only that person can respond or appeal (other people's earlier responses remain until their authors delete them)
- **Appeal:** someone who may respond (`mayAnswer` above: so for `codeKey` / `fp1` only the appointed responder) calls `appeal(key, chainId, account)` (one open appeal per key at a time) with an `appealBond` (set by governance through `setAppeals`, max 1000 ZETAPHY;
  a community fund must exist before it opens). This opens a new voting round `voteAppeal(key, clear, reportHash, uri)` for "fresh eyes" runners only: those who did not vote on or confirm the flag in that round, and who are not the appellant
  - Quorum to clear: the flag is cleared, the bond is refunded in full, and those who set the flag get `strikes` +1 (a public record only, no slashing: the bond lives in NeuroJobs, and automatic penalties would let a colluding group harass honest runners)
  - Quorum to keep the flag: the bond goes to the community fund (not to the voters, so there is no incentive to keep a flag)
  - No conclusion within `appealWindow` (1–90 days, default 14 days), or the flag is cleared/protected another way first: the bond is refunded
  - Money is not sent out during voting: refunds are kept in `owed` and the appellant withdraws with `withdraw()`; the fund's share is sent with `payFund()`, so money does not get stuck
  - `payFund()` sends to the latest non-zero community fund that governance set (`fundPayee`), even after appeals are closed (fund = 0), so it never sends to address(0)
- Legal details (re-checkable facts, good faith, public interest): [`docs/LEGAL.md`](../docs/LEGAL.md)

### Vaccination: the whole network does not touch flagged code

The `fp1:` fingerprint cannot be computed on-chain (the code lives on another chain), so the same kind of vote can also flag "identities the contract can check":
- `codeKey(h)`: EVM code on ZETAPHY with `extcodehash` = h (empty code is never flagged, so ordinary accounts are not caught in the crossfire)
- `addressKey(chainId, address)`: an address on that chain, e.g. a bridge sender or source token
- Every key is in the same table, uses the same quorum, and is cleared the same way. `isFlagged(fp)` still works as before
- `voteBatch`: a runner votes a fingerprint together with the code hash and addresses of copies found, in one transaction. Each key still needs its own quorum

A few runners must not be able to stop the bridge or wallets, so governance (gov module through MsgEVMCall, or a multisig) controls another layer:
- **Warn vs enforce:** `isFlagged` / `is*Flagged` answer immediately (Neuro warns), while `isEnforced` / `isCodeEnforced` / `isAddressEnforced` / `isContractEnforced` answer true once the flag has existed for `enforceDelay` (default 1 hour, max 30 days). Everything that **refuses** uses this set. Clearing a flag takes effect immediately
  - Things that only **hold** (reversible: `BridgeAirlock` releases, `BridgeGuard`'s inbound and outbound queues; see item 6 in stage 3) use `isHeld` / `isCodeHeld` / `isAddressHeld` / `isContractHeld`:
    true once the flag is `holdDelay` old (default 10 minutes, or half of `enforceDelay` if that is shorter than 20 minutes; must be less than `enforceDelay`, or 0 = hold immediately)
    or immediately when the flag goes through the fast lane or governance / guardian calls `holdNow(key)` (`heldFrom(key)` tells when the hold started). So runners at just quorum cannot instantly freeze someone's transfer
- **Fast lane:** the flag is enforced immediately, without waiting for `enforceDelay`, when
  - `fastQuorum` runners confirm the flag (a supermajority, default 2× the quorum; governance can adjust it, or set 0 to turn it off). Runners can vote `flag` again on a key that is already flagged; it counts as a confirmation, once per runner
  - governance or a guardian (appointed by governance) calls `enforceNow(key)`, only on keys already flagged by quorum. A guardian cannot flag, clear a flag, or protect a key itself
  - Clearing a flag or protecting a key also cancels the fast lane. A new flag starts counting `enforceDelay` again. A protected key cannot be flagged, so it is never enforced
- **Protected keys:** `setProtected(keys, true)` means that key can never be flagged; if it is flagged, the flag is cleared immediately. `deploy-bridge` protects the addresses and code hashes of BridgeGuard, the token, BridgeAirlock, NeuroLane and LockBox (`--lockbox`) itself
- Governance can set `setEnforceDelay`, `setHoldDelay`, `setFastQuorum`, `setGuardian` and `setGovernance`. Runners cannot. A guardian can only call `enforceNow` / `holdNow` on flags already set by quorum

Who refuses what:
- **Bridge:** does not release transfers from a flagged sender/source contract, or to a flagged contract (see item 6 in stage 3). The transfer stays pending until the flag is cleared
- **Runners:** `zetaphy bridge watch` asks `BridgeAirlock.flaggedParty` (enforced) before confirming, and `heldParty` (held: after `holdDelay`, fast lane, or `holdNow`) before releasing, every time. If it cannot ask, it does not confirm or release (closed by default)
- **ZETAPHY wallet** (`zetaphy-wallet`): before signing any transfer or contract call, it reads the target code (and the real code behind a proxy), computes `fp1` and keccak-256, then asks `ThreatRegistry`. Enforced flag (including flags via the fast lane) = does not sign, no skip button. Flag not yet enforced = warning
- Every warning or refusal (wallet and snap) shows the category as a fact about the code, the evidence (reportHash, URI, how to re-check), responses (if any, with the author's address), and the line "Automated code analysis data, not an accusation"
- **Plain MetaMask** (`zetaphy-snap`, transaction insight): for every EVM transaction on every chain the user is about to confirm, the snap asks `ThreatRegistry` with `eth_call` through the ZETAPHY public RPC
  - Enforced flag = `critical` level (MetaMask asks for an extra confirmation). Flag not yet enforced = warning. No flag = "No flags found in what was checked" plus the list of what was checked. Could not check = "Could not check"
  - EIP-712 signatures (Permit, Permit2, Seaport-style orders) also check the spender / operator / zone (signature insight)
  - See [`zetaphy-snap/README.md`](../zetaphy-snap/README.md) (permissions, data sent out, and values to set before publishing)
- **Other wallets or extensions:** `zetaphy threat export` writes all flagged keys as JSON (read from `flaggedList` and the registry's views at the same block)
  - `format: zetaphy-threats/2`, `keys[]`: `key`, `reason` (code fact code), `enforced`, `enforcedFrom`, `fast`, `flaggedAt`, `evidence`, `response`, `appealOpen`, only flags still set (cleared or protected ones are not in the list)
  - Keys are hashes: the wallet computes `codeKey` from the keccak-256 of the code and `addressKey` from chain id + address itself (the formula is in the file's `keyOf`), then compares
  - Recommended policy (`policy`): `enforced` = refuse, flagged but not yet enforced = warn. The file is a snapshot at one block (`block`); fetch it again periodically

**User reports (`ThreatReports`)**: help find new kinds of code that is risky for users faster
- Anyone who finds a contract that should be checked pays a small report fee (`fee`, default 0.1 ZETAPHY, max 100), then `report(key, chainKey, target, note)`
  - `note` at most 280 bytes. One report per key. A key that is already flagged cannot be reported (there is no new work to pay for)
  - The `Reported` event lets the runners' tools watch for it. A report does not flag anything by itself; runners must check and vote with the normal quorum
- Report fee: if the key is flagged **after** the report, the runners who flagged it in that round (exactly quorum runners) share it equally (`claim`). Fast-lane confirmations do not count
  If it is not flagged within `ttl` (default 30 days), the report fee goes to the community fund. Anyone can call `settle(id)`
- The governance of `ThreatReports` is the governance of `ThreatRegistry` (sets fee, ttl, community fund)

```
zetaphy threat flag fp1:<hex> code:0x<codehash> 97:0x<sender on chain 97> --reason sweeps-approved-tokens --evidence 0x<reportHash> --uri <where to read the report>   # several keys, one piece of evidence
zetaphy threat flag 0x<contract on ZETAPHY> --reason owner-can-block-transfers --evidence neuro:bsc:0x<contract>   # runs Neuro and uses its reportHash
zetaphy threat clear <existing key>...                            # vote to clear a flag
zetaphy threat check <key>...                                # is it flagged, is it enforced yet, is it protected
zetaphy threat protect|unprotect <key>...                     # governance: sends itself if this key is governance, otherwise prints calldata for the multisig / MsgEVMCall
zetaphy threat enforce-delay 3600 | threat set-governance gov  # governance
zetaphy threat fast-quorum 6 | threat guardian 0x<guardian>:on  # governance: fast lane
zetaphy threat enforce-now <key>...                           # governance or guardian: enforce a set flag immediately
zetaphy threat hold-now <key>... | threat hold-delay 600       # governance or guardian: hold bridge transfers immediately / governance: set holdDelay
zetaphy threat export --out threats.json                      # data for other wallets or extensions
zetaphy deploy-reports --fee 0.1 --ttl 2592000                # ThreatReports (community fund: NeuroControl's or --community-fund)
zetaphy threat report 56:0x<contract on BSC> --note "airdrop site asks to approve this contract"   # user: report (pays the fee)
zetaphy threat reports [--all]                                # runners: reports still open
zetaphy threat settle <id> | threat claim <id>                # settle a report / runners who voted the flag take their share
zetaphy threat respond 0x<contract> --text "response"              # owner: respond for an address (the contract, owner(), or the owner of the ERC-8004 identity for <chainId>:0x…; code: / fp1: only the governance-appointed responder) --text "" deletes your own
zetaphy threat appeal 0x<contract>                                 # owner: appeal (pays the bond)
zetaphy threat appeal-vote 0x<contract> --clear|--keep --evidence 0x<reportHash>   # runners who did not set this flag
zetaphy threat appeal-expire <key> | threat withdraw | threat pay-fund
zetaphy threat appeals-set --bond 1 --window 1209600 --community-fund 0x... | threat identity 0x<NeuroIdentity> | threat responder <key> 0x...   # governance
```

**ComputeMarket**
- AI answers do not come out the same every time, so the 2-of-3 method of Neuro tier 1 cannot be used
- It uses a deposit held by the contract instead:
  1. The user pays in advance
  2. A runner with a track record takes the job, then delivers the result (hash + URI)
  3. The user accepts or rejects within 1 day. If the user stays silent, the runner gets the money
- The number of rejections is visible to both sides

## ERC-8004 identity and cross-chain messages

Every contract Neuro reads (on 13 chains and on ZETAPHY itself) can have 1 on-chain identity, "the Neuro of that contract"
It is an identity card following the [ERC-8004 Trustless Agents](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8004.md) standard, which other AI systems can read

**NeuroIdentity** (ERC-8004 Identity Registry: ERC-721 where tokenId = agentId)
- Anyone can register a contract (`zetaphy identity register bsc 0x...`), but 1 contract gets only one identity
  - The key is a CAIP-10 address, e.g. `eip155:56:0x...`. EVM addresses must be lowercase, so they cannot be spelled differently as a second identity
  - The contract also enforces one form: Sui/Aptos must be `0x` + 64 lowercase hex characters (may be followed by `::module::Name`), Solana must be base58
  - TON: the contract converts the friendly form (EQ…/UQ…, base64 or base64url, testnet flag) to the raw form `0:hex` / `-1:hex` itself after checking CRC16. Any form gets the same identity
  - Bitcoin rune: the contract removes separators (`•`, `%E2%80%A2` or `.`), and what is left must be A–Z only (1–28 characters). Rune id numbers (`840000:3`) are not accepted; use the name
  - `agentIdOf` accepts every correctly spelled form, and `canonicalAccount` tells the form the contract stores
  - It records who registered it
- A newly created identity is held by the registry contract itself. Nobody can change it or speak for it, neither the registrant nor the admin
  - The identity card (agentURI) is built on-chain and points only to the Neuro report: `/web/?chain=bsc&address=0x...`
  - So someone racing to register first gains nothing, except making it easier for others to find the Neuro report
- The real owner can take over the identity with proof (`zetaphy identity claim <agentId>`)
  - For contracts on ZETAPHY: it must be called from the contract itself, or from the address the contract's `owner()` returns
  - The right follows the contract: if the contract changes owner, the new owner can claim it back
  - Contracts on other chains: `claimRemote` (see below)
- Once claimed, it is a normal ERC-8004 agent: set agentURI, metadata, agentWallet, and transfer it
  - `neuroURI` / `getTarget` always still tell which contract this identity belongs to, whatever the owner writes
  - It cannot be transferred back into the registry (`RegistryCustody`), so an identity held by the registry always means "nobody has claimed it yet, and the agentURI is Neuro's"
- The admin can only add chains and move the Neuro web link. It cannot touch identities

**Claiming the identity of a contract on another chain** (`claimRemote`)
- The contract owner on that chain signs consent off-chain, stating the agentId, the new identity recipient on ZETAPHY, the contract, the owner key, a nonce, and a deadline (at most 1 day), on the registry's domain (chain 77390 + registry address)
- Runners read the owner from that chain with Neuro's reader, then sign an EIP-712 attestation. `claimQuorum` runners are needed (set at install, default 3)
  - EVM: `owner()` / `getOwner()` or the EIP-1967 admin
  - Solana: mint authority, freeze authority, or upgrade authority (ed25519)
  - Runners that count: NeuroJobs' `workers()` must be active, agreed at least `claimMinAgreed` (set at install, default 5), and rejected not more than agreed. Same criteria as ThreatRegistry. The NeuroJobs address is set at install and cannot be changed (whoever could change it could pick the attesters themselves)
- Owners on EVM: the contract checks the consent signature itself with ecrecover, so runners cannot move the identity of a real owner who did not ask
- **`claimRemote` only proposes; it does not move the identity yet:** wait `claimDelay` (set at install, default 3 days, 1 hour to 30 days), then anyone can call `finalizeClaim` to move it
  - While waiting, the current identity holder (if someone has already claimed it, including operators they approved) or **a single** runner meeting the criteria above can call `contestClaim` to cancel. The requester must start over with a new set of signatures
  - This was chosen because it is simpler and safer than quorum-based objection: one honest runner can stop a quorum that colludes. The downside is that one ill-intentioned runner can also delay a valid claim, but the result is that the identity stays where it is; nobody's identity is seized
  - Only one pending request per identity at a time (`ClaimPending`). See `pendingClaim(agentId)` and the events `RemoteClaimProposed` / `RemoteClaimContested` / `RemoteClaimFinalized`
- **Trust required:** the quorum must read the owner correctly. If a full quorum of runners colludes to lie that their own key is the owner (on EVM they can also sign consent with that key, so ecrecover does not help) and **nobody contests within `claimDelay`**, they can take the identity. So identity holders and runners should watch the `RemoteClaimProposed` event. For non-EVM owners (ed25519 etc.) the quorum also checks the consent signature; the contract cannot check it itself
- Replay protection: every claim (`claim`, a `claimRemote` proposal, and `finalizeClaim`) increments `claimNonce`, so old signatures cannot be used again, even if the request was contested
- Not yet supported: owners that are contracts (e.g. a Safe on another chain, which cannot sign ECDSA), and owners on TON, Cosmos, Sui/Aptos, which Neuro can read but whose consent signatures cannot be checked yet (the runners' tools refuse)
- If installed without `--jobs`, cross-chain claims are off (`RemoteClaimsOff`)
- `NeuroTargets`: a helper contract that NeuroIdentity creates at install, holding the spelling rules (split out so NeuroIdentity stays under 24,576 bytes)

**NeuroValidation** (ERC-8004 Validation Registry)
- Runners that are still active and have a track record submit Neuro check results for any identity: verdict hash + score 0–100 (`zetaphy identity verdict`)
- A contract owner cannot block results from showing
- 1 runner has one result slot per identity (`verdictRequestHash(agentId, runner)`). Submitting again overwrites the old one
  - This slot's hash starts with `NVD1`, and `validationRequest` refuses hashes like this (`ReservedHash`), so nobody can reserve a slot under another agent to steal results
- `getSummary` returns the number of results and the average score, counting each validator once per identity (latest answer), so one person cannot skew the result
- The `requestHash` of a spec request is first come, first served (the spec reads by the hash directly, so it cannot be tied to the requester): if someone takes it first you get `Exists` and should use a new hash. Validators should check `agentId` in `getValidationStatus` before answering

**Cross-contract and cross-chain messages** (`src/neuromsg.js`)
- Signed with EIP-712, stating:
  - The sending agent and the recipient (0 = broadcast to everyone)
  - The source chain (CAIP-2) and message type: `hello`, `verdict`, `threat-report`, `ack`
  - The hash of the data (the data may or may not be attached), a nonce, and an expiry time (at most 7 days)
- The recipient checks that:
  - The signature is valid and not expired
  - The nonce has never been seen before (replay protection)
  - The message is signed for the registry the recipient trusts (`expect` must always be given)
  - The signer is the owner / operator / agentWallet of the sending agent
  - Or a runner with a bond, only when the sending agent is still held by the registry (not yet claimed). So runners cannot speak for an agent that already has an owner
- **Messages from other Neuro instances are data, not commands:**
  - Only known types and fields are accepted, data types must match, and sizes must be within limits. Everything else is rejected
  - Control characters and bidirectional (bidi) characters are stripped from text. Links are made non-clickable
  - Nothing in a message can make anything happen by itself

```bash
zetaphy deploy-identity --web https://<Neuro website>/web/ --claim-quorum 3 --claim-min-agreed 5 --claim-delay 259200 --governance 0x<multisig>   # --jobs is required to enable cross-chain claims
zetaphy identity register bsc 0x...          # gives an agentId
zetaphy identity get bsc 0x...               # who manages it, the Neuro report link, and check results from runners
# claim the identity of a contract on another chain
zetaphy identity claim-request 12 --new-owner 0x<recipient> --owner-key 0x<owner on bsc> --out claim.json   # prints the message for the owner to sign
zetaphy identity attest-claim claim.json --owner-sig 0x...   # each runner: reads the owner from that chain, checks the signature, then signs an attestation
zetaphy identity claim-remote claim.json                     # anyone can send it once quorum is reached (only proposes; waits claimDelay)
zetaphy identity contest-claim 12                            # identity holder, or a runner meeting the criteria: cancels a pending request
zetaphy identity finalize-claim 12                           # anyone can call it once the contest period is over
zetaphy msg sign threat-report --from 12 --payload '{"chain":"bsc","address":"0x...","fingerprint":"0x...","reason":"cannot-sell-in-simulation"}' --out m.json
zetaphy msg verify m.json                    # checks the signature, expiry, nonce, and the signer's rights
```

## Stage 5: quantum resistance

The ZETAPHY chain has a precompile that verifies **ML-DSA** signatures (FIPS 204, the NIST standard that resists quantum computers) at `0x…0900`
- It uses Cloudflare CIRCL v1.6.3 and is installed through a patch in `zetaphy-chain/setup-node.sh`
- The precompile's test suite runs in CI every time the chain part changes
- **For contract authors:** if the signature is invalid, the precompile returns empty (does not revert), like P256 (RIP-7212). You must check that the return value is 1, not just that the call succeeded (`QuantumWallet` already checks this way)

```
zetaphy deploy-pq                 # admin: install QuantumWalletFactory
zetaphy pq new                    # a wallet that uses ML-DSA only, with no ECDSA key at all
zetaphy pq new --hybrid           # must sign with both ML-DSA and ECDSA
zetaphy pq address
zetaphy pq send 0x... 1.5
```

- The wallet address is known before it is created, so it can receive money even before the wallet exists
- The 32-byte seed is stored at `~/.zetaphy/pq.seed` (0600), or encrypted at `pq.seed.json` when `ZETAPHY_PASSPHRASE` is set
  - If it is lost, the money cannot be moved out. Keep a backup
- Tested: signatures from JavaScript (@noble/post-quantum) pass verification by Go (CIRCL) on a real chain

### True PQ accounts (native): no ECDSA key and no one else paying gas

`zetaphy pq new|address|send` above are contracts on the EVM, so they still need an ECDSA account to pay gas
Native accounts are different: they are ordinary Cosmos accounts where the chain verifies the ML-DSA-44 signature itself

```
zetaphy pq native                              # zetaphy1… and 0x… addresses (same account) + balance
zetaphy pq native send zetaphy1... 1.5         # or 0x... also works
zetaphy pq native send 0x... 1.5 --gas 500000  # default 400000

# call EVM contracts with this account (msg.sender = this account's 0x… address)
zetaphy pq native call 0x<contract> 0x<calldata> [--value 0.5] [--gas 200000]   # --gas is the EVM-side gas
zetaphy pq native token-balance 0x<token>                  # ERC-20 balance (read only)
zetaphy pq native token-send 0x<token> 0x... 12.5          # send ERC-20 (the recipient can also be zetaphy1…)

# stake with a validator
zetaphy pq native stake zetaphyvaloper1... 100             # --gas default 500000
zetaphy pq native unstake zetaphyvaloper1... 40            # returned after the unbonding period
zetaphy pq native rewards zetaphyvaloper1...               # withdraw staking rewards

# create a new contract (deploy) with this account, prints the resulting contract address
zetaphy pq native deploy 0x<init code> [--value 0.5] [--gas 3000000]
```

**Use EVM contracts and stake with no ECDSA key at all**
- `call` and `token-send` send a `/zetaphy.pq.v1.MsgEVMCall` message (a Cosmos transaction signed with ML-DSA-44)
  - The chain runs that call on the EVM with `msg.sender` set to this account's 0x… address (the same 20 bytes)
  - So tokens, DeFi and other contracts can be used just like with an ECDSA account
- `stake`, `unstake`, `rewards` are standard Cosmos SDK messages (`MsgDelegate`, `MsgUndelegate`, `MsgWithdrawDelegatorReward`)
  - Validator addresses must start with `zetaphyvaloper1`, and the checksum is checked every time
- `token-send` reads the token's `decimals()` and `symbol()` with `eth_call` and shows them before sending
- Before signing, the command first simulates the call with `eth_call` from this account
  - If it would revert (e.g. not enough tokens), nothing is sent
  - If it is sent and then reverts on-chain, the whole transaction fails; money and tokens do not move; only the fee is lost
- Gas: the chain counts EVM gas within the Cosmos transaction's gas meter
  - Transaction gas = EVM gas (`--gas`, default 200000) + 400000 (signature verification and transaction size)
  - EVM gas must be between 21000 and 10,000,000
  - Do not set `--gas` higher than needed: the chain charges at least a share of the gas you set
- Limitations
  - EVM logs from these commands **do not show up in `eth_getLogs`**, because they are Cosmos transactions, not EVM transactions
    - Balances and token balances are always correct, but web pages or indexers that watch `Transfer` events will not see these items
- `deploy` is a `MsgEVMCall` with no `to` (data = init code), one contract per transaction
  - Contract address = `CREATE(this account, nonce)`, where nonce = the signed sequence + 1 (the ante handler increments it first). The CLI computes and prints it
  - The creation also uses that nonce, so the account's sequence ends at the signed sequence + 2 (the CLI reads the sequence from `zetaphy_pqAccount` every time before signing)
  - With `--as`, address = `CREATE(the locked account, that account's current sequence)`
  - The transaction's `zetaphy_evm_call` event has a `created` attribute with the same address

### Quantum lock: permanently hand an ECDSA (MetaMask) account to an ML-DSA-44 account

The existing ECDSA account (address, balance, tokens, stake, rights in contracts) stays where it is, but from now on only the ML-DSA-44 account, as its controller, can give orders

```
# lock this machine's ECDSA key (~/.zetaphy/worker.key) to this machine's pq native account (or a given account)
zetaphy pq native lock-ecdsa [zetaphy1<controller>] --yes      # permanent! without --yes it shows a warning and sends nothing

# the controller acts on behalf of the locked account: add --as <that account's address>
zetaphy pq native --as 0x<owner>                               # balance, and who it is locked to (quantumLockedTo)
zetaphy pq native send 0x... 1.5 --as 0x<owner>                # send ZETAPHY out of that account
zetaphy pq native token-send 0x<token> 0x... 12.5 --as 0x<owner>
zetaphy pq native stake zetaphyvaloper1... 100 --as 0x<owner>  # through the staking precompile 0x…0800
zetaphy pq native rewards zetaphyvaloper1... --as 0x<owner>    # through the distribution precompile 0x…0801
zetaphy pq native call|deploy|unstake|token-balance ... --as 0x<owner>

# hand control on to another ML-DSA-44 account (the current controller signs)
zetaphy pq native handover 0x<owner> zetaphy1<new controller>
```

- Locking from MetaMask: send an EVM transaction to `0x0000000000000000000000000000000000005051` with value 0 and data = the controller's 20-byte address (no selector)
  - The web wallet (`zetaphy-wallet`) can do this through `window.ethereum`
  - It fails if data/value is wrong, the controller is not an ML-DSA-44 account that has sent a transaction before, it is the account itself, or it is already locked
  - An ML-DSA-44 account cannot be locked (it is already quantum-resistant)
- After the lock, the chain rejects every transaction signed by that ECDSA key (EVM, Cosmos, EIP-7702 authorizations) at submission (`eth_sendRawTransaction` returns an error containing the word quantum-locked), and `ecrecover` returns `address(0)` for that key's signatures (permits and meta-transactions do not work)
- The controller acts on its behalf with a `MsgEVMCall` that has `as_owner` = the locked account (`msg.sender` = that account). The fee is paid by the controller
  - With `--as`, `--gas` is always the EVM-side gas; stake/unstake/rewards default to 300,000 (about 1.5× the `eth_estimateGas` measured on devnet: undelegate ~190k, delegate ~114–154k, rewards ~98k)
- Check status: `zetaphy_pqAccount(address).quantumLockedTo` (the controller's `zetaphy1…` address, or null)
  - The chain also keeps a copy in the storage of `0x…5051`: slot = the account address (left-padded with 0 to 32 bytes), value = the controller
- If the controller's seed is lost, the locked account is lost too

- Uses the same seed as `zetaphy pq` (`~/.zetaphy/pq.seed` or `pq.seed.json`)
- Address = `sha256("zetaphy/mldsa44\0" + public key)[0:20]` (with a prefix so it cannot collide with other Cosmos SDK address types)
  - It can be written as either `zetaphy1…` or `0x…`, because it is the same 20 bytes
- The account exists on-chain only after it first receives money
  - If it does not exist yet, the command tells you to send ZETAPHY to this address first
- `send` is a Cosmos SDK `MsgSend`; every command signs with SIGN_MODE_DIRECT using ML-DSA-44 (pubkey `/zetaphy.crypto.mldsa44.PubKey`)
  - Sent through the same JSON-RPC port 8545 (`zetaphy_pqAccount`, `zetaphy_sendCosmosTx`)
- Fee = gas limit × (`eth_gasPrice` × 1.2) in `azetaphy`
- The code is in `src/pqtx.js` (works in both Node and the browser)
  - Tested by decoding with the official Cosmos SDK protobuf (`cosmjs-types`) and verifying the signature every time
- The web wallet for this kind of account is in `zetaphy-wallet/` (separate from zetaphy-neuro, which promises never to touch keys)
- Keys in MetaMask: `zetaphy-snap/` (a MetaMask Snap) derives the account from the Secret Recovery Phrase and signs transactions itself
  - Every message that `msg*` builds has an `intent` (the same message as JSON, without the sender), and `messageFromIntent(intent, sender)` rebuilds exactly the same bytes
  - Every `pqClient` command can take `signTx(request)` instead of `sign(bytes)` (`buildTxWith`): the external signer only gets the intent, never the bytes,
    and `pqClient` builds the tx itself around the returned signature. If the `txHex` the signer returns does not match, it is not sent
- Tested on a real chain (`npm run test:devnet:pq`, also run in CI): sending works, and the chain rejects transactions using another key to impersonate the account, tampered signatures, and replayed old transactions
  - The same suite tests `token-send`, `call --value`, `stake`, `rewards`, `unstake`, and that a reverted call must not move money (requires a `zetaphyd` with `MsgEVMCall`)
- Local test chain (chain id other than `zetaphy_77390-1`): set `ZETAPHY_CHAIN_ID`
- Validators sign votes with ML-DSA-44 in addition to ed25519, and every block carries an ML-DSA certificate for the previous block (check with `zetaphy pq verify-block`)

### Security in the chain core: `zetaphy security` (Q-day, consent, IBC hold)

Full guide: [`docs/SECURITY-CORE.md`](../docs/SECURITY-CORE.md). Every rule is off until voted on (`zetaphy-chain/gov.sh`)

```bash
zetaphy security status                    # the Q-day, threat gate, and IBC hold settings in use
zetaphy security migration [0x…]           # has this account (default: this machine's ECDSA key) migrated yet
# after Q-day: migrate an ECDSA key never used on-chain to this machine's pq native account
# (the old key only signs a message locally; it sends no transaction)
zetaphy security qday-commit               # step 1, can be done before Q-day
zetaphy security qday-reveal               # step 2, after Q-day and after waiting reveal_delay blocks
zetaphy security consent 0x<contract> 3600     # consent to call a contract with an enforced flag for 1 hour (0 = revoke) [--as <owner>]
zetaphy security ibc-holds                 # IBC inbound transfers on hold
zetaphy security ibc-hold-cancel <id>      # guardian refunds the sender
```
Before Q-day the best path is `zetaphy pq native lock-ecdsa --yes` (quantum lock). The library for other wallets is in
`src/pqtx.js` (`qdayRevealText`, `qdayCommitment`, `consentCall`, `msgQDayCommit`, `msgQDayReveal`, `pqClient().securityStatus/migration/...`)
Tested on a real chain: `ZETAPHYD=… npm run test:devnet:security`

### Quantum-resistant block verification: `zetaphy pq verify-block`

Validators that have registered an ML-DSA-44 vote key sign every block with ML-DSA-44 alongside ed25519, and the proposer of block H+1 includes the signatures for block H as the first transaction (`MsgPQCertificate`)
This command verifies that certificate itself with `@noble/post-quantum`, using only the CometBFT RPC

```
zetaphy pq verify-block 12345                        # --rpc default http://127.0.0.1:26657 (or ZETAPHY_COMET_RPC), not port 8545
zetaphy pq export-vote-keys > pinned.json            # do this on a trusted node (--height h is allowed)
zetaphy pq verify-block 12345 --rpc http://<any node>:26657 --keys pinned.json
zetaphy pq verify-block 12345 --json                 # JSON output; --chain-id sets the chain id yourself
```

- **What it proves:** validators holding enough voting power signed an ML-DSA-44 attestation of (chain id, height H, hash of block H), under the same rule every node enforces
  - Rule: 3 × power with valid signatures > 2 × total power − 3 × power of validators that have no key yet (if the right side is negative, no signatures are needed)
  - Each validator is counted once; addresses that are not validators and invalid signatures are skipped
  - The header and transactions of block H sent by the node must hash to the signed hash, so the block data can be trusted too
  - The certificate is in block H+1: the latest block cannot be verified yet; wait for the next block
- **Results:**
  - `VERIFIED post-quantum`: ML-DSA signers hold more than 2/3 of total power
  - Passes the rule but is only partly quantum-resistant: some validators have not registered keys yet
  - `NOT post-quantum`: validators with keys hold less than 1/3, so the chain does not enforce signatures yet (exit 0 because it passes the rule)
  - `NOT VERIFIED`: fails, with a reason and exit code 1
- **Trust model:**
  - You do not need to trust the node about the hash, header, transactions, or the certificate itself: if the node fakes them, the signatures will not verify
  - What you must trust is the validator list, voting power, and vote keys at block H
    - Without `--keys`: read from the same node (`/validators` and `abci_query` at `/store/zetaphypq/key`). A lying node can create fake validators and keys itself, so this is suitable for your own node
    - With `--keys pinned.json`: uses power and keys from a file exported from a trusted node; no need to trust the queried node at all
  - pinned.json is a snapshot at one height. Export it again when validators join/leave, power changes, or keys change
    - An old file gives "fails", not "passes wrongly", and the command warns when the node's validator set differs from the file
  - Chain id checked: `--chain-id`; if absent, the value in the pin file; if absent again, the value from the header
  - It does not prove that the transactions in the block follow the rules: you must trust that most validators are honest, like any light client
- On machines installed with `setup-node.sh`, port 26657 listens locally only: run it on that machine, or use `ssh -L 26657:127.0.0.1:26657`
- Use in code: `verifyBlock(rpc, height, { chainId, pinnedKeys })` and `exportVoteKeys(rpc, { height })` in `src/pqcert.js` (cryptography from `@noble` only)
- Tests: `npm test` (mock RPC and real recorded devnet blocks) and `npm run test:devnet:pqcert` (a real chain with 2 validators)

## Cosmos wallets: Keplr, Leap, Cosmostation

Accounts on ZETAPHY are eth_secp256k1 (an Evmos-style chain)
- Key: BIP39 → `m/44'/60'/0'/0/0` (coin type 60)
- The `zetaphy1…` address is the same 20 bytes as `0x…`
- pubkey: `/cosmos.evm.crypto.v1.ethsecp256k1.PubKey`

Tested on a real chain (`npm run test:devnet:cosmoswallet`, also run in CI)
- The test suite goes step by step the way Keplr does (read from the `@keplr-wallet` 0.13.41 source) without using a wallet library
- Result for each signing method:

| Signing method | Result |
|---|---|
| `SIGN_MODE_DIRECT` secp256k1 signature over keccak256 (the normal wallet method) | Works, for both `MsgSend` and `MsgDelegate` |
| `SIGN_MODE_LEGACY_AMINO_JSON` signature over keccak256 of the JSON (Keplr `signAmino`) | Works |
| `LEGACY_AMINO_JSON` signed as EIP-712 (Keplr + Ledger) | Works (domain chainId 77390; other domain chainIds are rejected) |
| Signature over sha256 (like ordinary Cosmos chains) | Chain rejects: code 4 `signature verification failed` |

- Can be sent through REST `POST /cosmos/tx/v1beta1/txs` and through CometBFT RPC `broadcast_tx_sync`
- Accounts and balances can be read through REST, `eth_getBalance` matches the bank balance, and the nonce matches the sequence
- REST is on only when you run `REST=1 scripts/devnet.sh …` (on testnet `setup-node.sh` already turns it on)

Fixed as a result of this testing:
- The `keplr.json` that `setup-node.sh` creates has the feature `"eth-secp256k1-cosmos"`
  - Without it, Keplr puts in the pubkey `/ethermint.crypto.v1.ethsecp256k1.PubKey`, which the chain cannot decode
- Transactions the chain cannot decode now get an error reply immediately (previously they hung with no reply, because cosmos/evm v0.7.3 returned the wrong kind of error to CometBFT)
  - Patch in `mempool/mempool_handlers.go`
- Keplr + Ledger: the chain id changed to `zetaphy_77390-1` (Ethermint style), and `keplr.json` has the feature `force-enable-evm-ledger`
- Genesis sets `sig_verify_cost_secp256k1 = 21000` so that simulation charges the same signature-check cost as the real thing

Still remaining:
- Cosmos SDK v0.54 gives account numbers as a 64-bit hash value, which exceeds 2^53
  - Keplr supports it, but `@cosmjs/stargate` 0.38 and below will error; 0.39 or later is required

## Weaknesses already fixed (self-review, 19 Oct 2026)

| # | Previous weakness | Fixed with |
|---|---|---|
| 1 | One person posing as many addresses could take seats first-come-first-served, then drain the reward pool | **Seat lottery weighted by bond**<br>• Uses a seed from the request, which others cannot change<br>• Must register before the job is submitted<br>• Reward at most 1/4 of the job fee, with a daily cap<br>• Submitting jobs and answering them yourself loses money, unless you hold more than 2/3 of the whole system's bond |
| 2 | The "runner with a track record" status could be pumped by oneself | Track record must come from being drawn in the lottery (item 1), and the Neuro bridge requires a track record of at least 5 jobs (`--min-agreed`) |
| 3 | Marking `tx.origin` made it possible to lure innocent people into being marked | Only the direct caller is marked (the `msg.sender` the watched contract emits). There is a test suite with a lure contract (`test/helpers/Lure.sol`) |
| 4 | Only one admin key | `SimpleMultisig` (k-of-n) + `--governance` passes the admin rights on after install |
| 5 | The public JSON-RPC could be flooded until it went down | Limits set in `setup-node.sh`: eth_call gas/time, log size, batch, request size, number of connections, and unlock disabled |
| 6 | The ML-DSA patch had not been reviewed by anyone | Fuzz test (no kind of bad data may crash the chain) and benchmark: ML-DSA-44 takes 80 µs, ML-DSA-65 takes 142 µs, so gas is set about 3–5× higher than the real work |
| 7 | Keys and seeds were plain files | Set `ZETAPHY_PASSPHRASE` and they are encrypted automatically (keystore scrypt / AES-256-GCM), and `zetaphy keys encrypt` converts existing files |
| 8 | Submitting a job before `setControl` could make it impossible to connect NeuroControl forever | `setControl` ignores whether jobs already exist (deployer only, once), and `zetaphy deploy` calls it right after install. Jobs that slipped in get skill 0, runners skip them, so they time out and refund 95% |
| 9 | Quarantined bodies still counted as active and could still vote and attest | Quarantine = out immediately (`active` false, removed from the total bond, bond withdrawal starts) |
| 10 | Quarantine could be avoided by not revealing or by lying on alternate jobs | Not revealing = 10% slash + strike (after the grace period / `settle`), and strikes are counted in a 2-of-5 window |
| 11 | Requests for fake chains made bodies grow to the cap with a full refund | Only chains approved by vote are accepted, and failed jobs refund 95% (5% burned) |
| 12 | With few runners, 2 runners (or 2 defenders that are always eligible) could collude to decide results | **Challenge round**: anyone can re-run Neuro and open round 2; the wrong pair loses 50% of bond + a strike · only 1 defender can sit per job · `assurance` tells how many runners confirmed |
| 13 | The job submitter could compute in advance who would get seats (the seed came from the request alone) | The lottery is tied to the `blockhash` of the block after the submission block, which nobody can choose (see "An unpredictable lottery") |
| 14 | An offline defender held its seat forever | `heartbeat` + `defenderTimeout` (votable): silent past the limit, `regrow` removes it; on return it must heartbeat first |
| 15 | The lottery could be re-rolled: a commit that reverted with `NotChosen` cancelled the draw (`PREVRANDAO` of that block), so one could resend every block until getting a liked result, or have a contract call `draw` only when the result suited it | Lottery = `keccak256(seed, blockhash(B + 1), round)`, fixed from block B + 1; resending or choosing the timing gives the same value · past 256 blocks the round moves to a new block · only the proposer of block B + 1 can still adjust the hash |
| 16 | Posting a large bond after the draw made eligible runners lose eligibility until the last 1/3 | The total bond is snapshotted into the round when the round opens |
| 17 | Free self-challenge: only one challenge was allowed, and a round with no conclusion refunded in full and then closed challenges for good | Challenges are allowed again after disputed (3 rounds total, new people every round) · no conclusion loses 20% to the seats that revealed (or the community fund) · the challenger must state an answer; if the new result matches neither side, the whole stake is lost |
| 18 | A runner slashed until its bond was below the minimum could not withdraw the rest (not active and withdrawal not started) | Slashed below the minimum = withdrawal timer starts immediately (still respecting the hold), or `register` to top up and come back |
| 19 | Reveal had no deadline, so a slash could arrive after the bond had already been withdrawn | Every round's reveal has a deadline (round start + `jobTimeout`) · every seat's bond is held until round start + 2 × `jobTimeout`, and round-1 runners' bonds are held further during a challenge |
| 20 | Gas was estimated from the latest block but the transaction landed in the next block (e.g. `job request` crossing a load-meter minute used about 1,700 different gas), so it occasionally ran out of gas | Every transaction from the CLI and the runner program adds 50% extra gas · if estimation returns `TooEarly`, it waits for the next block and tries again |
| 21 | After the first 1/3, 2–3 defenders could take all the seats if no lottery runners had arrived yet | 1 defender per round at all times, unless no other runner is active at all |

Still requiring real people: multiple validators (Gate 1) and audits (Gates 2–3)

## Before real money (do not skip)

Everything in this folder is for **testnet only**. Before mainnet or before accepting real money, these conditions must be met (per the plan)

| Gate | Condition | Who does it |
|---|---|---|
| 1 | The testnet chain runs 30 days without stalling, and has at least 10 runners who are really different people | Community + Oracle machine |
| 2 | Audit of the chain itself (including the ML-DSA patch) and every contract in this folder · ≥ 1,000 Neuro users per month | Audit firm (paid) |
| 3 | Bridge audit · legal opinion · ≥ 20 independent validators · stake per validator at most 33% · bridge amount less than 1/3 of stake | Audit firm + legal advisor + validators |

## Admin: deploying the contracts

```
zetaphy deploy --fund 100000 --governance gov --community-fund 0x<community fund>
                                  # uses the rewards account key and also funds the reward pool; the new NeuroControl belongs to the gov module
zetaphy deploy-stable --reserve 1000 --oracle 0x<ZetaphyOracle> --zeta-asset 0x<WZETAPHY>   # tUSDC, tUSDT and a StableGateway that prices through the oracle
                                  # (--testnet-fixed-price 0.01 = testnet fallback fixed price, clearly labelled, can be turned off by the timelock)
```
The launch tool (`zetaphy-launch`) does all of this, then at handover gives every admin right to ZetaphyTimelock (see docs/LAUNCH.md)

Defaults:

| Setting | Default |
|---|---|
| Bond | 100 ZETAPHY |
| Reward per job | 1 ZETAPHY |
| Minimum service fee | 0.1 ZETAPHY |
| Commit time | 120 seconds |
| Job timeout | 600 seconds |
| Bond withdrawal wait | 3600 seconds |
| Body cap (`--max-bodies`) | 64 |
| Defender refills per hour (`--max-regrow`) | 4 |
| Community fund (`--community-fund`) | The deployer's address (you should set it yourself) |
| Challenge stake (vote `set-challenge-bond`) | max(2 × job fee, 1 ZETAPHY) |
| Challenge window (vote `set-challenge-window`) | Equal to the job timeout (600 seconds) |
| Maximum defender silence (vote `set-defender-timeout`) | 6 hours |

## ModelRegistry (AI models, skills, prompts, rule sets)

`contracts/ModelRegistry.sol`: per (id, version) the manifest sha256, the chunks' Merkle root, size, license, author and
status. Only governance (the timelock) publishes or changes status; a guardian may only suspend, at once; revoked is final.
`node scripts/model-registry.js deploy | propose | status | show` (`src/modelregistry.js`); tests in `test/modelregistry.test.js`.
Browsers check every downloaded chunk against it: [docs/future/browser-ai.md](../docs/future/browser-ai.md).

## SignalBoard (browsers finding each other)

`contracts/SignalBoard.sol`: a notice board for WebRTC signaling. `post(topic, to, expiresAt, payload)` only emits
`Signal(...)` (payload 1..2048 bytes, expiry at most 600 s ahead, 12 posts per sender per 60 s); no owner, no funds,
nothing to govern. Browsers post signed, encrypted offers from a throwaway faucet-funded key and read with `eth_getLogs`.
`KEYFILE=… node scripts/signal-board.js deploy | show --board 0x…`; tests in `test/signalboard.test.js`.
Not deployed yet. Design and privacy: [docs/future/browser-ai.md](../docs/future/browser-ai.md).

## Offline trading: cheques and offline swap orders (testnet)

`contracts/ZetaphyCheques.sol`: one-way payment channels whose cheques (EIP-712 running totals) are signed by a dedicated
offline key; anyone may cash for the payee, never more than the deposit; the payer closes after expiry plus a 24-hour
challenge window. `contracts/ZetaphyOfflineOrders.sol`: swap orders signed offline, filled by anyone through the ZETAPHY
Swap router for a relayer fee (nonce bitmap, deadline, all-or-nothing). Neither has an owner.
`ZETAPHY_RPC=… KEYFILE=… node scripts/offline-deploy.js [--router 0x…]` deploys both (testnet only) and writes
`deployments/offline-77390.json`, which the hub reads; `… offline-deploy.js check` reads it back. Tests in `test/offline.test.js`.
Design, threat model and limits: [docs/future/offline-trading.md](../docs/future/offline-trading.md).

## STARK light client (prototype)

`src/starklc/`: a hash-based (SHA-256, FRI) STARK proving that signers holding the required power of a Merkle-committed
validator set signed a block (signer bitmap, power sums, the chain rule 3S > 2T − 3U, certificate commitment), with
ML-DSA-44 signatures revealed in full, sampled, or trusted (stated per proof), and validator-set epochs chained from a
pinned genesis root. Verified in the browser on `zetaphy-explorer/lightclient.html`. Tests in `test/starklc.test.js`,
benchmarks with `npm run bench:starklc`.
What is proven vs trusted, security bits, benchmarks, in-circuit ML-DSA and bridge roadmap:
[docs/future/stark-light-client.md](../docs/future/stark-light-client.md).

### Trustless bridge (prototype)

ZETAPHY → Ethereum without a multisig: `contracts/StarkVerifier.sol` verifies the STARK on chain (≈ 1.4–3 M gas in mode
none, 2–6 M with revealed signatures for n ≤ 21), `StarkLightClient.sol` keeps finalized headers and app hashes (signatures
disputable during a window, or checked at once), `ZetaphyOutbox.sol` commits outgoing messages in storage slot 0 and
`ZetaphyBridgeInbox.sol` releases tokens on IAVL + multistore + outbox proofs (≈ 0.21 M gas) with replay protection, a daily
limit and a pause. `BtcLightClient.sol`: Bitcoin headers and SPV on ZETAPHY, tested with real mainnet headers. Tests in
`test/starkbridge.test.js` and `test/btclc.test.js`; trust model per mode, gas and Bitcoin options:
[docs/future/trustless-bridge.md](../docs/future/trustless-bridge.md).

## Testing

- `npm test`: tests the contracts on an in-memory EVM and tests the runner program (CI runs it every time)
- `ZETAPHYD=<zetaphyd with the ML-DSA patch> npm run test:devnet:pq`: tests stage 5 on a real chain
- `ZETAPHYD=<zetaphyd with ML-DSA vote keys> npm run test:devnet:pqcert`: a chain with 2 validators registers vote keys, then verifies blocks with `zetaphy pq verify-block`
- `ZETAPHYD=<zetaphyd> npm run test:devnet:cosmoswallet`: Cosmos wallets (Keplr, Leap, Cosmostation) sign and send transactions on a real chain
- `ZETAPHYD=<zetaphyd> npm run test:devnet:neurogov`: a vote on a real chain pauses Neuro (the gov module calls NeuroControl through MsgEVMCall), then reopens it; coin transfers keep working during the pause; a vote removes a chain from the list and then requests for that chain are rejected; and votes set the challenge stake (2.5 ZETAPHY) and `defenderTimeout`
- `npm run test:devnet:bridge`: the Neuro bridge across 2 real chains (source and ZETAPHY), including: a flagged sender that the guardian enforces immediately (`enforce-now`) is rejected; a sender flagged at warning level is not held until `holdDelay` passes, but the guardian holds it immediately with `hold-now`, and both go through after the flag is cleared; `deploy-bridge` refuses to deploy without `--lockbox` or with a single-key guardian outside devnet, and installs closed; `bridge open` does not open until every gate passes; `bridge monitor` (watch list + marker key) marks whoever calls a watched contract before quarantine ends, so their transfer is rejected, with no output mentioning that contract's address, and reports setting changes, totals reaching the cap (thresholds from secrets) and pause; `threat export`; user reports (`report`, `reports`, `settle`, `claim`)
  - To run on a machine with a shared devnet: `flock /tmp/ci-test/devnet.lock env ZETAPHYD=<zetaphyd> npm run test:devnet:bridge`
- `npm test` includes `test/hyperlane.test.js` (HyperlaneLane with a mock Mailbox, on-chain gates, hard cap), `test/bridgegate.test.js` (CLI gates) and `test/monitor.test.js` (alert rules, watch list, marking, no watched contract address in any output, encrypted state, timelock/oracle alerts)
- `test/timelock.test.js`: timelock roles (proposer = canceller, executor anyone, admin = itself); calls before the time is up / not scheduled / by non-proposers are rejected; cancel; changing the wait period must also wait; every contract handed to the timelock rejects its old admin; and the guardian's emergency buttons work immediately but cannot reopen
- `test/oracle.test.js`: prices from a real DEX pair (zetaphy-dex artifacts) with a mock Pyth, decimals, every reason for no price (liquidity, observations, age, conf, the two sources disagreeing), circuit breaker, roles, ZetaphyPythRelay (threshold, old updates, Pyth/Hermes format), and a regression test suite for the price guards
- `npm run test:devnet:timelock` (requires `zetaphyd`, uses the same lock): the oracle on a real chain (TWAP + Pyth through the relay), StableGateway pricing through the oracle and a relay that pokes the oracle, a timelock with a 2-of-3 multisig as proposer (execute before time rejected, execute by someone without a role, cancel), the guardian pausing the price immediately, abnormal prices giving no price, and `bridge monitor` reporting everything
  Test-only contracts (`test/helpers/OracleMocks.sol`) are compiled in the test suite and are not in `contracts/`
  Test-only contracts (`test/helpers/WatchedEmitter.sol`, `test/helpers/Lure.sol`) are compiled in the test suite and are not in `contracts/` or `artifacts/`
- `npm run test:devnet`: tests on a real ZETAPHY chain; requires `zetaphyd`
  - The script sets up a 1-node chain (1 second per block)
  - 3 runners take a real job until it gets a 2-of-3 result and they get paid
  - Challenge the result (stating `--verdict`), then 2 new runners take the challenge-round seats (lottery from `blockhash`) until the result is confirmed ("confirmedBy" 4 or more)
  - A user with 0 ZETAPHY can pay the job fee in tUSDC through the relay
  - The upgrade vote passes, and the chain schedules the upgrade
  - `zetaphy gate` can read data from the chain

## Status

These contracts have not been audited yet. Use them with ZETAPHY testnet only. Security details are kept separately for the team.


## AI agents (testnet prototypes)

AgentRegistry (agent identity, ML-DSA-44 key, bond, constitution, claims), IntentExecutor (Proof of Intent),
LabelRegistry + WebAuthnVerifier (human/agent labels; passkeys checked by the P-256 precompile 0x…0100), AgentPolicyWallet
(guardrails for AI wallets) and CosignCommittee (runner co-signing after Neuro checks). CLI: `zetaphy intent …`, `zetaphy cosign …`.
Design, use and limits: [docs/future/agents.md](../docs/future/agents.md).
