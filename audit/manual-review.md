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

| ID | Contract | Title | Severity | Confidence | Reproduced by | Resolution |
|---|---|---|---|---|---|---|
| HI-1 | HackInsurance | Anyone can make an approved claim pay 0 (or a fraction) by calling `payout` when the daily cap is used | High | High | `HackInsurance.inv.t.sol` `test_finding_payoutGriefedToZeroByDailyCap` | **Fixed** in `3867da9`: the entitlement is fixed at approval; `payout` pays what is left of it within the day's cap and the pool, keeps the claim Approved until fully paid (later days), reverts (`NothingToPay`) instead of paying 0. Regression: `test_regression_HI1_*`, invariant `invariant_sharesAndSinglePayout` (no 0-payout, no overpay) |
| SM-1 | SimpleMultisig | Confirmations of removed owners keep counting after `setOwners` | Medium | High | invariant `invariant_executeNeedsCurrentOwnersQuorum` **fails**; `test_finding_removedOwnerConfirmationStillCounts` | **Fixed** in `3867da9`: `setOwners` starts a new owner epoch; proposals of an older epoch can be neither confirmed nor executed (`Stale`). Regression: `test_regression_SM1_*`; the invariant passes |
| HI-2 | HackInsurance | A withdrawal request never expires: LPs can keep a standing exit and flee a known incident | Medium | High | `test_finding_standingWithdrawalFleesKnownIncident` | **Fixed** in `3867da9`: a ready request must be used within `WITHDRAW_WINDOW` (2 days), and no withdrawal runs while any claim is open (`openClaims`). Regression: `test_regression_HI2_noStandingWithdrawal`, invariant `invariant_noFleeingOpenClaims` |
| BB-1 | BugBounty | The sponsor can fill all 32 finding slots and block real finders at zero net cost | Medium | High | `test_finding_sponsorFillsFindingSlots` | **Fixed** in `3867da9`: the sponsor cannot commit; at most 4 commitments per address; only findings still in play count against the 32 slots (junk frees its slot when its reveal window ends); forfeited deposits never go back to the sponsor (burned at the refund). Regression: `test_regression_BB1_*`, invariant `invariant_sponsorCannotBlockOrProfit` |
| AR-1 | AgentRegistry | Bond can be withdrawn 7 days after an action although claims are "open for 30 days" | Medium | High | `test_finding_bondWithdrawnInsideClaimWindow` | **Fixed** in `3867da9`: `withdrawBond` also waits until the claim window of the agent's last action is over (`lastActionAt`, `withdrawableAt`). Regression: `test_regression_AR1_*`, invariant `invariant_accounting` (no bond out inside a claim window) |
| AR-2 | AgentRegistry | The operator picks the checker, so it can pick one that names itself as the victim and take the bond back at once | Medium | High (design) | `AR-2` test in `zetaphy-network/test/agents.test.js` | **Fixed**: checkers need governance approval (`setChecker`, `approvedChecker`); `register`/`update` refuse others; `claimByChecker` pays only while the checker is still approved, so revoking a bad one stops its payouts (the committee path stays). `ai-deploy` deploys the ConstitutionChecker and approves it before handing AgentRegistry to the timelock |
| APW-1 | AgentPolicyWallet | Selector deny-list is incomplete: value-moving calls on an allow-listed target run uncapped | Medium | High (code) / depends on owner config | `test_finding_agentMovesNftOfAllowedTarget` | **Fixed** in `3867da9`: allow-list design: a contract call needs an allow-listed (target, selector) pair (`setAllowedCall`, deny by default); transfer-like selectors (ERC-721/1155 `safeTransferFrom`/batch, ERC-777, ERC-677/1363 `*AndCall`, DAI `move`/`pull`/`push`/`permit`, Permit2, `burn*`) are refused and cannot be allow-listed; native value stays capped. Same list now forbidden in IntentExecutor. Regression: `test_regression_APW1_*`, `testFuzz_APW1_contractCallsNeedAllowedSelector` |
| SG-1 | StableGateway + NeuroJobs | A job nobody answers refunds 95% of the fee in native ZETAPHY to the user: the reserve is a stablecoin→ZETAPHY exchange at the oracle price | Medium | High (mechanism) / Medium (profitability) | `test_finding_userGetsNativeRefundForStablecoin` | **Fixed** in `3867da9`: the gateway is the job's requester (`requestFor(address(this), …)`); the ZETAPHY refund returns to the reserve and `refund(jobId)` pays the user 95% of the stablecoin it paid. Regression: `test_regression_SG1_refundStaysInStablecoin`, `testFuzz_SG1_noExchange` |
| BA-1 | BridgeAirlock | Removing a lane does not withdraw its attestations on pending transfers | Low | High | `test_finding_removedLaneAttestationCounts` | **Fixed** in `3867da9`: at release only attestations of lanes still on (and not removed/re-added since: `laneGen`) count; a transfer that fell below the threshold restarts its quarantine when it reaches it again. Regression: `test_regression_BA1_*` |
| NJ-1 | NeuroJobs | A runner that never reveals keeps its whole bond if nobody calls `expire`/`settle` within the second jobTimeout | Low | High | invariant `invariant_bondHeldWhileSlashable` **failed** in 1 of 3 runs; `test_finding_unrevealedSeatWithdrawsBondBeforeExpire` | **Fixed** in `3867da9`: `openSeats` counts each runner's committed seats not yet revealed or penalised; `withdrawBond` needs 0, so the penalty lands whoever calls `expire`/`settle` and whenever (the runner can call them itself). Regression: `test_regression_NJ1_*`; the invariant passes |
| BB-2 | BugBounty | Deposits of findings closed after the bounty was paid/refunded are stranded forever | Low | High | invariant `invariant_noStrandedFunds` **fails**; `test_finding_depositStrandedAfterPayout` | **Fixed** in `3867da9`: a deposit forfeited after the bounty was paid/refunded is burned (`0x…dEaD`, `burned`), never added to a closed reward. Regression: `test_regression_BB2_*`; the invariant passes |
| RV-1 | RewardVault | The release rate applies retroactively to money deposited after the last release | Low | High | `test_finding_depositIsReleasedRetroactively` | **Fixed** in `3867da9`: money vests from its arrival: `receive()` and `release()` checkpoint (what vested moves to a due amount; the rest, new money included, vests from today). Regression: `test_regression_RV1_*`, `testFuzz_RV1_depositNeverVestsRetroactively` |
| EF-1 | ZetaphyEarlyFarm | Rewards streamed while nothing is staked are owed to nobody and cannot be recovered | Low | High | `test_finding_idleRewardsLocked` | **Fixed** in `3867da9`: while `totalSupply == 0` the streamed amount is removed from `owed` at the next update, so `recover` can take it. Regression: `test_regression_EF1_*`, invariant `invariant_farmFunded` (nothing owed to nobody) |
| HI-3 | HackInsurance | Share price when the pool is empty but shares exist; donation inflation | Low | Medium | reasoning (no test) | **Fixed** in `3867da9`: +1 virtual share / +1 virtual wei pricing (1:1 for the first deposit; old shares of an emptied pool are worth < 1 wei of new money; a donation attack loses the attacker money, a deposit that would mint 0 shares reverts). Tests: `test_HI3_*`, `testFuzz_HI3_roundTripNeverPaysMoreThanPool` |
| I-1…I-14 | various | Informational notes | Info | – | – | Not changed (Info), except I-4 (comment fixed with BA-1) |

No Critical issue was found. **All 13 findings are fixed** in commit `3867da9` (branch `audit-fixes`), each
with a regression test that asserts the good outcome where the reproduction used to assert the bad one;
the three properties that used to fail (SM-1, BB-2, NJ-1) now pass, and new properties were added
(no 0-payout and no fleeing an open claim in HackInsurance, no bond out inside a claim window in
AgentRegistry, the sponsor never holds a slot or profits in BugBounty, nothing owed to nobody in the
farm). The fixes change behaviour that users and integrations see (listed per contract below), and the
deployed testnet copies keep the old code until they are redeployed (see
[Redeploying the fixes](#redeploying-the-fixes-testnet-77390)).

The original "reproduced by" tests were renamed `test_regression_*` / extended; the text of each
finding below is kept as written, with a **Resolution** line added.

Follow-ups in `a543082`, from the in-house pipeline's fast tier run on the fixed code (no behaviour
change): `StableGateway.refund` marks the job refunded before any external call (CEI);
`BugBounty._forfeit` takes the deposit as `uint128` (no narrowing cast); `RewardVault.applyShares`
refuses to run while `release()` is paying recipients (the list being paid can never change under
it). The same commit makes the pipeline run these suites (see `invariants.md`), and the gate passes:
the 30 High tool findings on the new code and on the Audit Network contracts were each read in the
code and are recorded in `triage.yml` (false positives, owner to confirm), none of them real.

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
  **Resolution (`3867da9`):** the second option, without calling recipients from `receive()`: the vault keeps
  `_vesting` (balance vesting since the last checkpoint) and `_due` (vested, unpaid). `receive()` and
  `release()` checkpoint first, so a deposit vests from the day it arrives; coins that bypass `receive()`
  (selfdestruct) vest from the next checkpoint; a recipient re-entering `release()` gets nothing.
  Behaviour change: fund the vault with a call that forwards gas (a 2300-gas `transfer` can fail when a
  checkpoint is due).
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
  **Resolution (`3867da9`):** the first option (`ownersEpoch`, `proposalEpoch`, error `Stale`); it also stops
  a lowered threshold from applying to old proposals. Behaviour change: proposals pending when the
  owners change must be proposed again.
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
  **Resolution (`3867da9`):** both: each transfer records its attesting lanes with their controller and
  generation; `liveAttestations(id)` counts distinct controllers of lanes still on and of the same
  generation (a removed lane that governance re-adds starts fresh and may attest again). A removal
  bumps `removalEpoch`; a transfer that reaches the threshold again after a removal gets a fresh
  quarantine. `status()` reports the live count. I-4's comment is corrected.
- *Info (I-4):* `setThreshold`'s comment says a raise "does not hold back transfers that already
  reached the old one"; the code (`release` compares with the current threshold) does hold them back,
  which is the safer behaviour. Fix the comment. **Resolution:** comment fixed in `3867da9`.

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
  **Resolution (`3867da9`):** `entitlement[id]` = min(loss, cover, target cap, maxClaimBps of the pool) is fixed
  when the claim is approved (vote quorum; an upheld dispute keeps it), `paidOut[id]` tracks payments.
  `payout` pays min(what is left, today's cap left, the pool) and closes the claim (Paid, bond back,
  cover used) only when the whole entitlement is paid; a payout that would pay 0 reverts
  (`NothingToPay`). `payout` stays permissionless (the hub's "anyone may take it on" flow): with the
  entitlement fixed at approval and 0-payouts refused, a stranger can only pay the claimant what is
  due, never shrink it.
- **HI-2 (Medium) – standing withdrawal requests.** `requestWithdraw` (`:165`) sets `readyAt = now +
  withdrawDelay`; `withdraw` (`:172`) accepts any time after that, forever. An LP requests at deposit
  time and keeps a "ready" exit; when a hack becomes known (a claim is filed) it withdraws in the same
  block, before any vote, defeating "a known incident cannot be fled" (`test_finding_standingWithdrawalFleesKnownIncident`
  empties the pool while a claim is pending). *Fix:* give the request an execution window
  (e.g. `readyAt ≤ now ≤ readyAt + 1 day`), and/or snapshot: a request made before a claim was filed
  is paid at the price after that claim is settled.
  **Resolution (`3867da9`):** both a window and a freeze: `withdraw` works only in
  `[readyAt, readyAt + WITHDRAW_WINDOW]` (2 days; `RequestExpired` after) and only while no claim is
  open (`openClaims` counts Voting, Approved-not-fully-paid and Disputed claims; `ClaimsOpen`). The
  window alone would not do (several addresses could stagger requests); the freeze alone would leave
  standing exits after the incident. Residual: a claim filed and left to expire freezes withdrawals for
  its vote window; runners should reject junk claims (the bond is then lost).
- **HI-3 (Low) – share pricing edge cases.** `deposit` (`:156`) mints 1:1 when `before == 0` even if
  `totalShares > 0` (pool emptied by payouts with `maxClaimBps = 10000`): old share holders then own
  part of the new deposit. The usual first-depositor/donation inflation also applies (`selfdestruct`
  donation; NoShares protects only the zero-share case). *Fix:* when `totalShares > 0 && before == 0`,
  refuse deposits or burn the dead shares; add virtual shares/assets (ERC-4626 style offset).
  **Resolution (`3867da9`):** virtual offset: `shares = v·(totalShares+1)/(assets+1)` and
  `amount = s·(assets+1)/(totalShares+1)` (capped at the pool). The first deposit stays 1:1; an emptied
  pool's old shares are worth < 1 wei of a new deposit; a 1-wei-plus-donation attacker loses money and a
  victim deposit that would mint 0 shares reverts. Tests: `test_HI3_emptiedPoolDoesNotDiluteNewDeposit`,
  `test_HI3_donationInflationUnprofitable`, `testFuzz_HI3_roundTripNeverPaysMoreThanPool`.
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
  **Resolution (`3867da9`):** the sponsor cannot commit to its own bounty (`BadFinding`); one address holds at
  most `MAX_PER_FINDER` = 4 commitments per bounty; only findings still in play (not rejected, closed,
  or past their reveal window unrevealed) count against `MAX_FINDINGS` = 32 (`MAX_COMMITS` = 256 bounds
  the loops); forfeited deposits still grow the reward for a winner, but `forfeitedOf[id]` of them is
  burned at a refund instead of going to the sponsor. A flood now costs 32 burned deposits per reveal
  window and blocks nobody for longer than that window.
- **BB-2 (Low) – stranded deposits.** A finding rejected (`:235`) or closed unrevealed (`:273`) after
  its bounty was paid or refunded adds its deposit to `reward` of a closed bounty; no function pays it
  out again. The invariant `invariant_noStrandedFunds` fails on this; minimal case in
  `test_finding_depositStrandedAfterPayout`. *Fix:* if `b.paid || b.refunded`, credit the deposit to
  the sponsor (or the neutral sink of BB-1).
  **Resolution (`3867da9`):** the neutral sink: a deposit forfeited after the bounty was paid or refunded is
  burned at once (`Burned` event, `burned` total). `invariant_noStrandedFunds` now passes.

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
  **Resolution (`3867da9`):** `_request` calls `jobs.requestFor{value: fee}(address(this), …)` and records
  `paidJobs[jobId]` (user, token, cost). When the job failed or expired, anyone calls `refund(jobId)`:
  it pulls the gateway's NeuroJobs credit back into the reserve and pays the user
  `cost × (1 − FAIL_BURN_BPS)` in the stablecoin it paid, once. A per-request fee cap is not needed for
  the exchange (refunds are now in the paying currency). Residual (trust): the owner (timelock) can
  `sweep` stablecoin; it must keep enough for refunds of jobs still open.
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
  **Resolution (`3867da9`):** both. `setAllowedCall(target, selector, on)` allow-lists pairs; any contract
  call other than transfer/approve needs its pair (`SelectorNotAllowed`), so nothing value-moving runs
  just because its contract is allowed. `isTransferLike` refuses (and `setAllowedCall` cannot allow) the
  selectors above plus ERC-1155 batch, ERC-777 `authorizeOperator`, ERC-1363 `transferAndCall` /
  `transferFromAndCall` / `approveAndCall`, DAI `move`/`pull`/`push`/`permit`, Permit2
  `permit`/`approve`/`transferFrom`, `burn`/`burnFrom`. Native value of an allowed call is capped as
  before. Behaviour change: owners re-allow the functions their agent calls. An allowed router function
  still lets the agent pick the swap recipient: allow only the functions you mean (documented here).
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
  **Resolution (`3867da9`):** the first option, in the `update` modifier: while `totalSupply == 0`,
  `rewardRate × (lastTime − lastUpdate)` leaves `owed` (it was owed to nobody), so `recover` can take it;
  stakers' earnings are unchanged.
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
  **Resolution (`3867da9`):** the first option: `openSeats[w]` +1 on every seat taken (round 1 and challenge
  rounds), −1 when the seat reveals or is penalised (`_miss` from `expire`, `settle`,
  `challengeExpire`); `withdrawBond` requires 0. Every unrevealed seat has a path that resolves it
  (expire / settle / challengeExpire are permissionless and callable at any time after their deadline),
  so no bond can get stuck, and the runner itself must trigger its penalty to leave.
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
  **Resolution (`3867da9`):** the first option (`lastActionAt[id]`, `withdrawableAt(id)` = max(unbondAt,
  lastActionAt + CLAIM_WINDOW + 1)); an agent with no recent action still leaves after 7 days. A claim
  filed in the last second of the window holds the bond (`OpenClaims`).
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

---

## Redeploying the fixes (testnet 77390)

The fixes are in the source and the committed artifacts (`3867da9`); contracts already deployed keep
their old code (none is upgradeable). From `zetaphy-launch/state/77390.json` and
`zetaphy-chain/hyperlane/bridge-testnet.json`, these deployed testnet contracts run code with a fixed
finding and need a new deployment for the fix to take effect (testnet only; never with real keys):

| Deployed contract (77390) | Address | Finding | What else follows |
|---|---|---|---|
| NeuroJobs (+ its NeuroJobsChallenges, deployed by its constructor) | `0x698dC17df6a34b02263b295d101BE39F3F3B433B` | NJ-1 | Everything that names NeuroJobs must point at the new one: NeuroControl `0xc0081832…23c6` (setControl is once-only on NeuroJobs: wire the new NeuroJobs to it), StableGateway (immutable `jobs`, below), ThreatRegistry `0xaB5745b6…417f` (its runner committee is the NeuroJobs address given to its constructor, so redeploy it, and ThreatReports with it) and the RewardVault share that pays NeuroJobs through `fund()` (`proposeShares`, 7-day delay). Runners re-register their bonds on the new contract. |
| StableGateway | `0x20Eaf743cD495258aD9F36F97206e59fC6ef2AE4` | SG-1 | Needs the new NeuroJobs (immutable). Move the ZETAPHY reserve and stablecoins with `withdrawReserve` / `sweep` (timelock), set the oracle and tokens again, hand ownership to the timelock. |
| RewardVault | `0x6a26055803556ff891CAB11CF47aB363aC1D0Ed8` | RV-1 | No withdraw path exists by design: the old vault keeps releasing what it holds to its recipients; fund the new vault for future money. |
| SimpleMultisig (the guardian) | `0x5bcC8290fff6f1410d7a04c5f6839b6AfD917Eb5` | SM-1 | Deploy a new one with the same owners/threshold; governance (timelock) re-points every role that names the guardian (BridgeGuard.setGuardian, StableGateway.setGuardian, …) and the old one is retired. |
| BridgeAirlock | `0xa381502c65a2b3F2a9CB9083D98Fa3C75355EE5B` (route closed) | BA-1 | NeuroLane `0xafdeb233…6e96` and HyperlaneLane `0x81960582…8CBE` attest to the airlock they were built with: redeploy them for the new airlock; BridgeGuard `0xE8850D63…3eC3` sets the new route (timelock). |

Not listed there, so not deployed by the launch or bridge records: HackInsurance, BugBounty,
AgentRegistry, AgentPolicyWallet, IntentExecutor, ZetaphyEarlyFarm. Any copy deployed by hand or by
another workflow (`zetaphy deploy-useful-work` for BugBounty, `early-token.yml` for the farm,
`insurance-replay.yml`, a user's own AgentPolicyWallet) runs the old code and must be redeployed too;
compare its `EXTCODEHASH` with the code hashes in `audit/REPORT.md`.
