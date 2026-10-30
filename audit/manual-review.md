# ZETAPHY smart contracts: manual review

In-house review, 2026-10-30, of commit `d07b980` (`main`). The review was done by hand alongside the
property suites in `zetaphy-network/audit/invariants/`, `zetaphy-dex/audit/invariants/` and
`zetaphy-nft/audit/invariants/` (index: [`audit/invariants.md`](invariants.md)). Thai summary:
[`audit/manual-review.th.md`](manual-review.th.md).

**This is not a third-party audit.** One reviewer read every contract that holds or moves value
once, in full, and wrote and ran property tests against it. Treat a clean section as "nothing found
in one careful pass", not as "safe". Before mainnet, the Critical/High/Medium items need fixes plus
regression tests, and the bridge, the DEX and NeuroJobs need an external audit.

## Scope

| Package | Contracts reviewed (all of each file) |
|---|---|
| zetaphy-network | ZetaphyCheques, ZetaphyOfflineOrders, RewardVault, BridgeAirlock (+ NeuroLane, LockBox), BridgeGuard (+ BridgedToken), HyperlaneLockBoxV2 (+ HyperlaneOutbox), HyperlaneLane (+ HyperlaneLockBox), HackInsurance, UsefulWork, UsefulIssuance, BugBounty, StableGateway, ComputeMarket, AgentPolicyWallet (+ FrostSecp256k1, CosignCommittee), QuantumWallet (+ factory), ZetaphyTimelock, SimpleMultisig, ZetaphyEarly, ZetaphyEarlyFarm, ZetaphyEarlyPolls, ZetaphyEarlyPass, ZetaphyQuests, DataDAO, NeuroJobs (+ NeuroJobsChallenges), AgentRegistry (+ ConstitutionChecker) |
| zetaphy-dex | ZetaphyPair, ZetaphyFactory, ZetaphyRouter, ZetaphyDlmmPair (+ deployer), ZetaphyDlmmFactory, ZetaphyDlmmRouter, DlmmMath / DlmmBinTree |
| zetaphy-nft | NFTMarketplace (collections only as far as the marketplace calls them) |

Out of scope: the other network contracts (oracle, threat registry, Neuro identity/score/control,
arena, etc.), off-chain code, the Cosmos chain and the CosmWasm contract. Where an in-scope
contract relies on one of them (ThreatRegistry views, NeuroControl knobs, the ML-DSA precompile at
`0x…0900`, the P-256 / WebAuthn verifier), that dependency is listed as a trust assumption.

Compiler: solc 0.8.26, optimizer 200 runs, `cancun` (same settings as `scripts/build.js`).
Everything relies on 0.8 checked arithmetic; the few `unchecked` blocks were each read and are
correct (balance moves after a `>=` check, wrap-by-design price accumulators and bitmap masks).

## Severity

| Severity | Meaning here |
|---|---|
| Critical | Anyone can steal or permanently lock funds that are not their own, with no special role. |
| High | Users lose funds or a core guarantee breaks, under realistic conditions, without a privileged role. |
| Medium | A stated guarantee breaks under specific conditions (an owner config, a timing window, a compromised key that the design says should be contained), or a griefing attack with real cost to others. |
| Low | Small or unlikely loss, stuck dust, or a documented guarantee that is weaker than written. |
| Info | Design notes, trust assumptions worth stating, doc mismatches. |

Every contract here says "testnet, no value". Severities are rated **as if real value were at
stake**, because that is when they matter.

## Findings summary

| ID | Contract | Title | Severity | Confidence | Reproduced by |
|---|---|---|---|---|---|
| HI-1 | HackInsurance | Anyone can make an approved claim pay 0 (or a fraction) by calling `payout` when the daily cap is used | High | High | `HackInsurance.inv.t.sol` `test_finding_payoutGriefedToZeroByDailyCap` |
| SM-1 | SimpleMultisig | Confirmations of removed owners keep counting after `setOwners` | Medium | High | invariant `invariant_executeNeedsCurrentOwnersQuorum` **fails**; `test_finding_removedOwnerConfirmationStillCounts` |
| HI-2 | HackInsurance | A withdrawal request never expires: LPs can keep a standing exit and flee a known incident | Medium | High | `test_finding_standingWithdrawalFleesKnownIncident` |
| BB-1 | BugBounty | The sponsor can fill all 32 finding slots and block real finders at zero net cost | Medium | High | `test_finding_sponsorFillsFindingSlots` |
| AR-1 | AgentRegistry | Bond can be withdrawn 7 days after an action although claims are "open for 30 days" | Medium | High | `test_finding_bondWithdrawnInsideClaimWindow` |
| APW-1 | AgentPolicyWallet | Selector deny-list is incomplete: value-moving calls on an allow-listed target run uncapped | Medium | High (code) / depends on owner config | `test_finding_agentMovesNftOfAllowedTarget` |
| SG-1 | StableGateway + NeuroJobs | A job nobody answers refunds 95% of the fee in native ZETAPHY to the user: the reserve is a stablecoin→ZETAPHY exchange at the oracle price | Medium | High (mechanism) / Medium (profitability) | `test_finding_userGetsNativeRefundForStablecoin` |
| BA-1 | BridgeAirlock | Removing a lane does not withdraw its attestations on pending transfers | Low | High | `test_finding_removedLaneAttestationCounts` |
| NJ-1 | NeuroJobs | A runner that never reveals keeps its whole bond if nobody calls `expire`/`settle` within the second jobTimeout | Low | High | invariant `invariant_bondHeldWhileSlashable` **failed** in 1 of 3 runs; `test_finding_unrevealedSeatWithdrawsBondBeforeExpire` |
| BB-2 | BugBounty | Deposits of findings closed after the bounty was paid/refunded are stranded forever | Low | High | invariant `invariant_noStrandedFunds` **fails**; `test_finding_depositStrandedAfterPayout` |
| RV-1 | RewardVault | The release rate applies retroactively to money deposited after the last release | Low | High | `test_finding_depositIsReleasedRetroactively` |
| EF-1 | ZetaphyEarlyFarm | Rewards streamed while nothing is staked are owed to nobody and cannot be recovered | Low | High | `test_finding_idleRewardsLocked` |
| HI-3 | HackInsurance | Share price when the pool is empty but shares exist; donation inflation | Low | Medium | reasoning (no test) |
| I-1…I-14 | various | Informational notes | Info | – | – |

No Critical issue was found. No finding was fixed in this change: none is a one-line fix without
a design decision (each fix below changes behaviour users or integrations see), so they are listed
for the owner to decide, with the reproducing tests ready to become regression tests.

---

## zetaphy-network

### ZetaphyCheques

- **Trust / roles:** none (no owner, no upgrade). The payer trusts its own `signer` key; the payee
  trusts that the deposit only grows before close (true: no path lowers `deposit`; `paid` only rises).
- **External calls:** token `transferFrom`/`transfer` (measured, fee-on-transfer refused), native
  `call` to payee/payer. All after state changes; every entry point `nonReentrant`.
- **Checked:** conservation per asset (balance = Σ deposit − paid over live channels), `paid ≤ deposit`,
  no cashing after `closeAt`/`done`, only the payer moves its channel, EIP-712 digest binds chain id +
  contract + channel id, `s ≤ n/2` malleability check, re-entrancy through an ERC-777-style token hook
  (refused). Halmos: for any deposit and any two accepted cheques the payee receives ≤ deposit.
- **Issues:** none above Info.
  - *Info:* `open` allows `signer == payee`; a payer who names the payee as signer lets the payee
    write its own cheques. Consider refusing it.
  - *Info:* `release()` can be called again after the challenge ended; harmless (it only re-sets
    `closeAt` to now, and cashing already stopped).

### ZetaphyOfflineOrders

- **Trust / roles:** none. The relayer chooses the route (`path`) and timing; the maker's protection
  is `minAmountOut` (checked on what the maker actually received) and the deadline.
- **External calls:** maker's token (`transferFrom`, measured), router swap, wrapped-coin `withdraw`,
  native sends to maker and relayer. Nonce is burned before any call; `nonReentrant`.
- **Checked (real ZETAPHY router + pairs):** nothing stays in the contract between calls (tokens,
  native, router allowance), one fill per nonce, cancelled nonces never fill, maker pays exactly
  `amountIn` and receives ≥ `minAmountOut`, relayer gets ≤ `relayerFee`.
- **Issues:**
  - *Info (I-1):* by design the relayer can route through pools it has moved (sandwich) and leave the
    maker exactly `minAmountOut`. Makers must set `minAmountOut` as a real limit, not 0.
  - *Info:* for native output the check `address(this).balance < got` (`ZetaphyOfflineOrders.sol:213`)
    also counts coins force-sent to the contract (selfdestruct). With WZETAPHY the unwrap always
    delivers, so this only matters for a wrapped coin whose `withdraw` is a no-op; use a before/after
    balance difference instead.

### RewardVault

- **Trust / roles:** `governance` (timelock) chooses recipients, effective 7 days after the proposal.
  It cannot withdraw; it can however point 100% of the stream to an address it controls (expected).
- **External calls:** `release()` calls each recipient (`fund()` or plain); failures keep the money
  in the vault. `releasedDays` is set before the calls; `applyShares` clears the pending list first.
- **Checked:** conservation (in = vault + paid out), schedule (no deposit in between ⇒ ≤ 10% in any
  365 days, rounding ≤ 1 wei/day), `releasedDays ≤ daysElapsed`. Halmos: for any balance ≤ 1e30 wei a
  release after n ≤ 365 days pays ≤ 10% was written but timed out (solver), see invariants.md.
- **RV-1 (Low) – release rate is retroactive.** `releasable()` (`RewardVault.sol:71`) applies
  `1 − 0.9^(n/365)` to the **current** balance, where `n` counts days since the last release, not since
  the money arrived. If the 500M pool is sent to a vault deployed (or last released) N days earlier,
  the first `release()` pays out `1 − 0.9^(N/365)` of it at once: 19% for a vault funded two years
  after deployment (`test_finding_depositIsReleasedRetroactively`). The doc ("Nobody can make the
  vault pay faster than the schedule") does not hold for late or added funds.
  *Fix:* in `receive()` call `release()` first (so the schedule restarts at the deposit; mind the
  re-entrancy of recipients), or track the balance as of the last release and apply the schedule only
  to it, vesting new money from its arrival.
- *Info (I-2):* the NatSpec says ComputeMarket can be a `callFund` recipient, but ComputeMarket has no
  `fund()` and no `receive()`: such a share would always fail (money stays in the vault).

### SimpleMultisig

- **Trust / roles:** owners (k-of-n). Owners/threshold change only via an executed proposal.
- **External calls:** `execute` → arbitrary call; `executed` set first.
- **SM-1 (Medium) – stale confirmations survive owner rotation.** `setOwners`
  (`SimpleMultisig.sol:75`) replaces the owner set but leaves `proposals[*].confirmations` and
  `confirmed[*][*]` untouched; `execute` (`:63`) compares the old counter with the new threshold.
  Scenario: owner A's key is stolen; the thief proposes a drain (1 confirmation). B and C rotate A
  out. The pending proposal still shows A's confirmation, so **one** current owner confirming it
  (with threshold 2) executes it — e.g. a new owner D who sees "1 of 2 already confirmed". Also a
  lowered threshold applies to old proposals. Found by the invariant fuzzer (shrunk to 12 calls)
  and reproduced in `test_finding_removedOwnerConfirmationStillCounts`.
  *Fix:* keep an `ownersNonce` incremented by `setOwners`, store it in each proposal, refuse
  confirm/execute of proposals from an older nonce; or count at execute time only confirmations of
  addresses that are owners now.
- *Info:* proposals never expire. The code comment already says to prefer an audited Safe on mainnet.

### ZetaphyTimelock

- OpenZeppelin 5.4.0 `TimelockController` + `AccessControlEnumerable`, unchanged (vendored, pinned
  by sha256). Admin is the timelock itself; executor role open (address(0)).
- **Checked:** no operation executes before `scheduledAt + delay`, only proposers schedule, the
  timelock is its own only admin. **Issues:** none.

### BridgeGuard (+ BridgedToken)

- **Trust / roles:** `governance` (timelock) sets routes, caps, audit record, registry, guardians;
  guardians can only pause, lower the cap, cancel a raise, disable a route. Route adapters are fully
  trusted for their direction: `outbound(id, from, amount)` burns from any `from` without its
  approval — safe only because the adapter (HyperlaneOutbox) passes `msg.sender`.
- **External calls:** `BridgedToken` (own), ThreatRegistry views, adapter `independentLanes()` (static).
- **Checked (with BridgeAirlock as adapter):** supply = released − burned, per-day minting ≤ the
  hard cap in force, nothing moves while paused.
- **Issues:** *Info (I-3):* an inbound to a held recipient is queued without counting against the
  daily limit; a compromised adapter can therefore queue any number of held mints (each ≤ the limit).
  They only mint later within the limits and governance can `dropHeld` them, so this is noise, not
  loss; consider a cap on queued amount per route.

### BridgeAirlock (+ NeuroLane, LockBox)

- **Trust / roles:** governance (lanes, threshold, quarantine, markers, registry); guardians of the
  guard (remove lane/marker, raise threshold/quarantine); vetoers; markers (trip only). Lane
  independence relies on each lane's self-reported `laneController()` — a malicious lane contract can
  report any controller; governance must only add lanes whose code it reviewed.
- **Checked:** no release without `threshold` distinct-controller attestations, quarantine, no veto,
  no mark; never twice; forged attestations (different amount) are a different id and never mint.
- **BA-1 (Low) – a removed lane's attestations still count.** `setLane(lane,false)` and
  `emergencyRemoveLane` (`BridgeAirlock.sol:193`) clear `isLane` but `transfers[id].attestations` and
  `attestedByController` keep the removed lane's votes; `release` (`:321`) counts them. A lane caught
  attesting a forged transfer is removed, but one more dishonest (or newly compromised) lane completes
  the threshold for every forged transfer it had pending. Mitigation today: veto each one.
  *Fix:* record per-transfer the set of lanes and at release count only lanes that are still on, or
  bump a lane epoch on removal and ignore older attestations.
- *Info (I-4):* `setThreshold`'s comment says a raise "does not hold back transfers that already
  reached the old one"; the code (`release` compares with the current threshold) does hold them back,
  which is the safer behaviour. Fix the comment.

### HyperlaneLockBoxV2 (+ HyperlaneOutbox) and HyperlaneLane

- **Trust / roles:** the Mailbox + the ISM this contract names (our validators) decide what is a
  release; governance changes the ISM, limits and delay; guardians pause/veto/lower/lengthen.
- **External calls:** Mailbox `dispatch`/`quoteDispatch`, refund of excess fee to the locker, native
  payment in `claim` (after `claimed` and `locked` are updated).
- **Checked:** the box holds exactly `locked`; claims ≤ locks; a claim pays once, only when ready,
  unvetoed, unpaused and within the day's limit; messages from another sender or naming another
  source are never queued; a re-entering receiver cannot double-claim.
- **Issues:** none above Info. *Info:* a guardian veto can only be lifted by governance; a stolen
  guardian key can delay every release until governance acts (intended trade-off).

### HackInsurance

- **Trust / roles:** governance (targets, parameters incl. `maxClaimBps` up to 100%, dispute
  resolution); runner committee from NeuroJobs records (quorum).
- **Checked:** bonds are never spent as pool money (`balance ≥ bondsHeld`, and `bondsHeld` equals the
  live bonds exactly), `activeCover` = sum of covers not ended, shares sum to `totalShares`, at most
  one payout per cover.
- **HI-1 (High) – payout can be griefed to zero.** `payout(id)` (`HackInsurance.sol:330`) is
  permissionless and pays `payoutOf(id)` (`:314`), which is capped by what is left of today's
  `dailyCap` (`:325-326`). It then marks the claim `Paid` and the cover `claimed` for good. Once the
  day's cap is used (by one legitimate payout, or by the attacker's own small approved claim), anyone
  can call `payout` for every other approved claim that day: each pays 0 (only the bond is returned).
  The same silent truncation happens without an attacker whenever two big claims land on one day.
  *Fix:* never close a claim for less than its entitlement: keep a `paidSoFar` and leave the claim
  `Approved` until fully paid (later days continue), or revert when `amount` is below the entitlement
  capped only by loss/cover/target cap; optionally restrict `payout` to the claimant.
- **HI-2 (Medium) – standing withdrawal requests.** `requestWithdraw` (`:165`) sets `readyAt = now +
  withdrawDelay`; `withdraw` (`:172`) accepts any time after that, forever. An LP requests at deposit
  time and keeps a "ready" exit; when a hack becomes known (a claim is filed) it withdraws in the same
  block, before any vote, defeating "a known incident cannot be fled" (`test_finding_standingWithdrawalFleesKnownIncident`
  empties the pool while a claim is pending). *Fix:* give the request an execution window
  (e.g. `readyAt ≤ now ≤ readyAt + 1 day`), and/or snapshot: a request made before a claim was filed
  is paid at the price after that claim is settled.
- **HI-3 (Low) – share pricing edge cases.** `deposit` (`:156`) mints 1:1 when `before == 0` even if
  `totalShares > 0` (pool emptied by payouts with `maxClaimBps = 10000`): old share holders then own
  part of the new deposit. The usual first-depositor/donation inflation also applies (`selfdestruct`
  donation; NoShares protects only the zero-share case). *Fix:* when `totalShares > 0 && before == 0`,
  refuse deposits or burn the dead shares; add virtual shares/assets (ERC-4626 style offset).
- *Info:* claim filing needs `toBlock < block.number` and covers start at the purchase block; a cover
  bought in the exploit block cannot claim that block — correct.

### UsefulIssuance

- **Trust / roles:** governance must be a timelock with `getMinDelay() ≥ 2 days` (checked by calling
  it; a contract can lie, so this is a sanity check, not a guarantee). Sinks pull only their bucket.
- **Checked:** balance = Σ accrued + pendingOverflow exactly; no bucket above its cap; in = held + out.
- **Issues:** none.

### UsefulWork

- **Trust / roles:** governance (params, feeders, pause); feeders post subsidised/canary jobs and are
  trusted to reveal the canary honestly (a feeder can slash every seat with a wrong canary, or skip
  revealing it).
- **Checked (with UsefulIssuance as the subsidy source):** balance = reserve + Σ credits + (fee +
  deposits) of unsettled jobs, to the wei; every non-zero accepted result had ≥ quorum matching
  reveals.
- **Issues:** *Info:* PoW stamps cost CPU, not money; Sybil resistance is per-address-day limits plus
  deposits. Fine for testnet.

### BugBounty

- **Trust / roles:** governance (subsidy, deposit, pause); runner committee (quorum) judges findings.
- **Checked:** solvency (balance ≥ credits + open rewards + open deposits).
- **BB-1 (Medium) – sponsor (or anyone) can fill the finding slots.** `commitFinding` refuses after
  `MAX_FINDINGS = 32` commits per bounty (`BugBounty.sol:193`), counting commits that will never be
  revealed. The sponsor commits 32 junk findings, real hunters get `TooMany`; after the deadline it
  `close`s them (their deposits go to *its own* reward, `:273`) and `refund`s everything
  (`test_finding_sponsorFillsFindingSlots`: sponsor ends with 100% of its money). A third party can do
  the same at the cost of 32 deposits (which the sponsor gets). *Fix:* do not count findings that
  were closed unrevealed, let new commits replace expired unrevealed ones, and send forfeited deposits
  to a neutral sink (burn / community / UsefulIssuance) instead of the sponsor's reward.
- **BB-2 (Low) – stranded deposits.** A finding rejected (`:235`) or closed unrevealed (`:273`) after
  its bounty was paid or refunded adds its deposit to `reward` of a closed bounty; no function pays it
  out again. The invariant `invariant_noStrandedFunds` fails on this; minimal case in
  `test_finding_depositStrandedAfterPayout`. *Fix:* if `b.paid || b.refunded`, credit the deposit to
  the sponsor (or the neutral sink of BB-1).

### StableGateway

- **Trust / roles:** owner (timelock) sets oracle, tokens, fixed testnet prices, and can `sweep` and
  `withdrawReserve` anything — users never leave funds here between calls, so this is acceptable.
- **External calls:** permit (try), token `transferFrom` (user → gateway, user → relayer), NeuroJobs
  `requestFor`, oracle `price`.
- **Checked:** one request per signed nonce, the user never pays more than `maxCost`, the reserve
  pays exactly `fee`.
- **SG-1 (Medium) – the reserve is an exchange.** `requestFor(refundTo = q.user, …)` makes NeuroJobs
  credit a failed/expired job's fee minus 5% to the **user**, in native ZETAPHY
  (`NeuroJobs.sol:1168`). A user signs a request with a large `fee` for a target nobody will answer,
  pays `quote()` in stablecoin, and after `jobTimeout` withdraws 95% of the fee in ZETAPHY
  (`test_finding_userGetsNativeRefundForStablecoin`: 50 USD → 95 ZETAPHY at a $0.50 oracle price,
  i.e. ZETAPHY bought at $0.526). Whenever the oracle (or the testnet fixed price, or a stale/lagging
  TWAP) is more than ~5% below the market, anyone drains the reserve at a discount. *Fix:* refunds
  of gateway-paid jobs go to the gateway (`refundTo = address(this)`, then refund the user in
  stablecoin at the price paid), and cap `fee` per request.
- *Info:* fee-on-transfer stablecoins are not detected (the owner chooses accepted tokens).
  `_recover` accepts `v` only as 27/28 (no 0/1 normalisation): wallets signing with 0/1 fail (no risk).

### ComputeMarket

- **Trust / roles:** none (escrow). The requester may reject any delivery within `REVIEW` and gets a
  full refund; runners rely on the public reject counters (by design).
- **Checked:** balance = Σ credits + prices of unsettled tasks; each task settles once; a re-entering
  withdrawer gets nothing more (CEI).
- **Issues:** Info only (see I-2 on RewardVault).

### AgentPolicyWallet (+ CosignCommittee, FrostSecp256k1)

- **Trust / roles:** owner (unlimited `ownerExecute`, policy); agent (inside policy); governance of
  the CosignCommittee (members, FROST key); the WebAuthn verifier and the ML-DSA precompile for freezes.
- **Checked:** per token, the agent moves at most 2× `perPeriod` in any sliding period (the cap is per
  fixed window, so 2× across a window boundary is the true bound), never a token without a limit,
  never while frozen, never to a non-allowed recipient, never above `cosignAbove` without the queue.
- **APW-1 (Medium) – incomplete selector filter.** `_classify` (`AgentPolicyWallet.sol:532`) forbids
  `transferFrom`, `increaseAllowance`, `setApprovalForAll`, `permit` and caps `transfer`/`approve`;
  **every other** call to an allow-listed target counts as amount = `msg.value`. Value-moving
  functions not in the list run uncapped and without cosign: ERC-721/1155 `safeTransferFrom`
  (`0x42842e0e`, `0xb88d4fde`, `0xf242432a`), `safeBatchTransferFrom`, ERC-777 `send`/`operatorSend`,
  ERC-677 `transferAndCall`, `burn`, a router's swap with `to` = the agent, etc.
  (`test_finding_agentMovesNftOfAllowedTarget`). Needs the owner to allow-list that contract as a
  target — a natural thing to do for an NFT collection or a DEX router. *Fix:* allow-list
  (target, selector) pairs, deny by default; at least add the selectors above, and document that an
  allowed router lets the agent choose the swap recipient.
- *Info:* `delay` may be 0, which makes the queue path equivalent to `execute` without the
  `cosignAbove` check; require a minimum delay.
- *Info:* FROST verification uses the ecrecover trick with 160-bit address comparison (stated in the
  code); `parseKey` refuses x ≥ n. I checked the algebra (r = PK.x, s = −c·PK.x, h = −z·PK.x) and it
  matches the cited construction; no test vectors were re-derived here.

### QuantumWallet (+ QuantumWalletFactory)

- **Trust / roles:** the ML-DSA precompile at `0x…0900` (only on ZETAPHY); the ECDSA owner in hybrid
  mode.
- **Checked (precompile mocked):** the nonce counts exactly the authorised actions; replays and
  wrong-key signatures never execute.
- **Issues:** none. *Info:* on a chain without the precompile every action fails (staticcall to an
  empty account returns no data → `BadPq`), so funds sent to a predicted address on another chain
  are stuck; worth a warning in the UI.

### ZetaphyEarly, ZetaphyEarlyFarm, ZetaphyEarlyPolls, ZetaphyEarlyPass, ZetaphyQuests

- **Trust / roles:** the farm/quests operator (funds and pays; can withdraw unpromised ZEARLY).
- **Checked:** ZEARLY balances sum to the fixed supply; farm `owed ≤ ZEARLY held`, Σ earned ≤ owed,
  staked LP = held LP; polls hold every locked vote, release pays once; one pass per wallet and
  ≤ `maxSupply`; one quest payment per (quest, wallet), ≤ cap; LP-token hook cannot re-enter the farm.
- **EF-1 (Low) – idle rewards locked.** `notifyReward` (`ZetaphyEarlyFarm.sol:109`) adds
  `rewardRate × duration` to `owed`; while `totalSupply == 0`, `rewardPerToken` (`:67`) does not
  advance, so that time's rewards are owed to nobody, and `recover` (`:124`) refuses to touch `owed`
  (`test_finding_idleRewardsLocked`: half of a 1,000 ZEARLY period stuck). *Fix:* track the
  undistributed part (`rewardRate × idle time`) and subtract it from `owed`, or start the period at
  the first stake.
- *Info:* `ZetaphyQuests.withdraw` can take the whole balance (documented: paid rewards are already
  sent, so all of it is unpromised).

### DataDAO

- **Trust / roles:** the poster (posts merkle roots up to the available balance) and governance
  (veto during `vetoDelay`, exclusions). Contributors trust that a wrong root is vetoed in time.
- **Checked:** `reserved` equals what live rounds still owe; balance ≥ reserved; no claim pays a
  different amount than its leaf. Leaves are double-hashed (no second-preimage via inner nodes).
- **Issues:** none.

### NeuroJobs (+ NeuroJobsChallenges)

- **Trust / roles:** deployer sets NeuroControl once; NeuroControl governance (pause, roster,
  challenge bond/window, community fund). Lottery bias by the proposer of block B+1 (documented).
- **External calls:** `withdraw` (credit zeroed first), burn sends to `0x…dEaD` (no code), NeuroControl
  views, `delegatecall` to its own `NeuroJobsChallenges` (immutable, deployed by the constructor,
  refuses direct calls).
- **Checked (no NeuroControl):** balance = reward pool + Σ credits + Σ bonds + fees of open jobs +
  bonds of open challenges, to the wei, through finalize, fail, expire, settle, challenge,
  overturn/confirm/dispute; `totalActiveBond`/`activeWorkers` match the runners; a bond is never
  withdrawn while its runner sits on a round that can still slash it (open round, pending grace, or
  round-1 seat of a job still challengeable or being challenged) — this last property **fails**, see NJ-1.
- **NJ-1 (Low) – non-reveal penalty escapable when no keeper calls `expire`.** A seat's bond hold
  ends at `start + 2 × jobTimeout` (`_take`), whatever happened to the round. A runner that committed
  and never revealed calls `requestUnbond`, and once `unbondAt` and `heldUntil` pass, `withdrawBond`
  pays the whole bond. If nobody called `expire(id)` (or `settle`) in the second `jobTimeout`, the
  later `expire` runs `_miss` → `_penalize` on a bond of 0: the 10% penalty is lost (the strike is
  still recorded). The NatSpec states the assumption ("expire()/settle() have the second jobTimeout
  to be called"); nothing enforces it, and on a quiet testnet nobody may call it in time (the
  requester has the refund incentive, but not a deadline). Found by the invariant fuzzer
  (5 calls: request, commit, requestUnbond, warp, withdrawBond); reproduced in
  `test_finding_unrevealedSeatWithdrawsBondBeforeExpire`. *Fix:* count each runner's unresolved
  seats (increment on commit, decrement when the seat is revealed, judged or missed) and require 0 in
  `withdrawBond`; or let `withdrawBond` itself settle the runner's expired rounds first.
- See SG-1 for the refund path used through StableGateway.

### AgentRegistry (+ ConstitutionChecker)

- **Trust / roles:** governance (committee, `minBond`, `claimDeposit`); the claims committee; the
  operator-chosen checker (a no-op checker means no checker claims — victims must check it).
- **Checked:** balance = Σ bonds + deposits of open claims; `openClaims` matches; no bond leaves
  while a claim is open.
- **AR-1 (Medium) – the bond leaves before the claim window ends.** Claims on an action are allowed
  for `CLAIM_WINDOW = 30 days` (`AgentRegistry.sol:359`), but the operator can `requestUnbond` right
  after the action and `withdrawBond` 7 days later (`UNBOND_DELAY`, `:198`, `:202`); afterwards
  `_claimable` refuses (`bond == 0`). Victims effectively have 7 days, and a claim filed in the same
  block can be front-run by `withdrawBond`. *Fix:* keep `lastActionAt` per agent and require
  `block.timestamp > lastActionAt + CLAIM_WINDOW` (and no open claims) in `withdrawBond`, or set
  `UNBOND_DELAY ≥ CLAIM_WINDOW`.
- *Info:* `setParams` allows `claimDeposit = 0`, which makes keeping a bond locked by a stream of
  claims free.

---

## zetaphy-dex

### ZetaphyPair / ZetaphyFactory / ZetaphyRouter (V2)

- **Trust / roles:** factory governance: fee switch, threat registry and score checks in the router
  (fail closed), router `sweep` of stray native coins. Cannot move pool funds.
- **Checked:** no swap (router, exact-out, or flash swap paying back anything) lowers
  `reserve0 × reserve1`; the value of an LP share (√k / supply, counting the protocol-fee LP that
  `_mintFee` would mint) never decreases; reserves ≤ balances; LP balances sum to supply;
  `MINIMUM_LIQUIDITY` stays at address(0); the router keeps nothing. Halmos: swap never lowers k and
  burn never pays more than the pro-rata share were written but timed out (solver), see invariants.md.
- **Issues:** *Info (I-5):* same as Uniswap V2: if the fee switch is turned off and on again with no
  mint/burn in between, `kLast` is stale and the protocol takes its 1/6 of the growth during the off
  period. *Info:* the first deposit after a donation + `sync` takes the donation (documented as M3).

### ZetaphyDlmmPair / Factory / Router, DlmmMath

- **Trust / roles:** factory governance (presets, protocol share ≤ 50% of fees, fee recipient).
  `setActiveIdWhileEmpty` is callable by anyone while the pair is empty (the router does it atomically
  with the first deposit and checks `activeIdDesired`).
- **Checked:** Σ bins = reserves; balances ≥ reserves + protocol fees; bins above the active one hold
  only X and below only Y; per bin, LP balances sum to supply, shares exist iff reserves exist, and
  every non-empty bin is in the bitmap; nobody burns another's shares without approval; a round trip
  X→Y→X never returns more than it put in. Math (fuzz vs. a 512-bit reference): `mulDiv` exact and
  reverting on overflow, `mulDivUp` = ceil, prices strictly increasing in id, p(id)·p(−id) ≈ 1,
  bitmap `below`/`above` equal a naive scan.
- **Issues:**
  - *Info (I-6):* `divPriceDown`/`divPriceUp` shift `amount << 128` without an overflow check.
    In `swap` the amounts are bounded by uint128 reserves (and `_u128` reverts otherwise), but the
    view `getSwapOut` with an input ≥ 2^128 returns a wrong (too small) output instead of reverting.
  - *Info (I-7):* tokens sent to a pair outside a call are taken by the next swap/mint (documented);
    integrators must not transfer in one transaction and call in another.

---

## zetaphy-nft

### NFTMarketplace

- **Trust / roles:** governance (fee ≤ 5%, recipient, threat registry). Collections are arbitrary
  contracts: a malicious collection can only hurt its own buyers/sellers (calls are `nonReentrant`
  and credits are pull-based).
- **Checked:** the marketplace holds exactly Σ credits + Σ open offers; every sale credits exactly
  the price (fee + royalty + seller) and delivers the token(s).
- **Issues:** none above Info. *Info:* `royaltyInfo` is capped at 10% and its gas is protected against
  starvation (good).

---

## Informational notes not listed above

- I-8: Several contracts send native coins with `call` to user-chosen addresses inside a state change
  (`AgentRegistry._pay`, `HackInsurance._send`, `ZetaphyCheques._pay`). All update state first, so
  re-entrancy is not exploitable, but a recipient that reverts blocks its own path (e.g. an operator
  that rejects ETH blocks the rejection of claims against it). Pull payments everywhere would remove
  that class.
- I-9: Governance setters in most contracts are single-step `setGovernance(g)` (a typo bricks it);
  the DEX factories use two-step. With a timelock as governance this is mitigated by the delay.
- I-10: Many contracts assume `block.timestamp` granularity of days for limits (UTC day buckets);
  two days' limits can be used back to back around midnight (2× the daily limit in a few minutes).
  Bridge caps should be sized with that in mind.
