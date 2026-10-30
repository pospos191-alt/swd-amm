# Property and invariant index

Every property written for the in-scope contracts, the tool that checks it, and its status in the
runs done on 2026-10-30 (commit `d07b980` + this change). Manual review: [`manual-review.md`](manual-review.md).

## How to run (free tools only)

Foundry `forge` 1.3.5 (release binary), solc 0.8.26 (`~/.svm/0.8.26/solc-0.8.26`; the configs set
`offline = true`, so put the static solc binary from the Solidity GitHub release there if forge
cannot download it). forge-std v1.9.7 is vendored at `audit/lib/forge-std` (src only, MIT/Apache).

```sh
cd zetaphy-network && forge test            # 256 runs x depth 50 (local default)
cd zetaphy-dex     && forge test
cd zetaphy-nft     && forge test
FOUNDRY_PROFILE=deep forge test             # 1000 x 100, for CI / nightly

# Echidna 2.2.x (+ pip crytic-compile), from zetaphy-network/:
echidna . --contract EchidnaCheques --config audit/invariants/echidna/echidna.yaml
# Medusa 1.x, from zetaphy-network/:
medusa fuzz --config audit/invariants/echidna/medusa.json
# Halmos 0.3.x (pip), solver bitwuzla (HALMOS_ALLOW_DOWNLOAD=1 lets halmos fetch it):
cd zetaphy-dex     && halmos --forge-build-out audit/out --contract DlmmMathSymbolic --solver bitwuzla
cd zetaphy-dex     && halmos --forge-build-out audit/out --contract PairSymbolic --solver bitwuzla
cd zetaphy-network && halmos --forge-build-out audit/out --contract ChequesSymbolic --solver bitwuzla
cd zetaphy-network && halmos --forge-build-out audit/out --contract RewardVaultSymbolic --loop 12 --solver bitwuzla
```

Build output goes to `audit/out` and `audit/cache` (git-ignored). The contracts are compiled where
they are (`src = "contracts"`); `zetaphy-network` imports the DEX through the `zetaphy-dex/` remapping
for the offline-orders suite.

**Expected failures.** Three properties fail, because they are true statements of what the contract
should guarantee and the contract does not: `SimpleMultisigInvariants.invariant_executeNeedsCurrentOwnersQuorum`
(SM-1, fails every run), `BugBountyInvariants.invariant_noStrandedFunds` (BB-2) and
`NeuroJobsInvariants.invariant_bondHeldWhileSlashable` (NJ-1); the last two depend on the random seed
at 256×50 (forge replays a found counterexample from `audit/cache/invariant/failures/` on later runs). A CI job should treat these two as
known failures until the findings are fixed, then as regressions. Every finding also has a
deterministic `test_finding_*` that passes while the bug exists (it asserts the bad outcome); after a
fix, flip each one into a regression test that asserts the good outcome.

Status legend: **pass** (held for the whole budget), **FAIL** (counterexample found; see the
finding), **not run** (with the reason), **timeout** (the tool did not finish within its budget).

## zetaphy-network

| Contract | Property | Tool / file | Status |
|---|---|---|---|
| ZetaphyCheques | balance of each asset = Σ(deposit − paid) over live channels; paid ≤ deposit; deposits = cashed + withdrawn + held | Foundry invariant `ZetaphyCheques.inv.t.sol::invariant_conservation` | pass |
| ZetaphyCheques | a cheque never pays more than deposit − paid; payee receives exactly what `cash` reports | Foundry `invariant_noOverpay` | pass |
| ZetaphyCheques | no cashing after the challenge period or after the payer withdrew | Foundry `invariant_noCashAfterClose` | pass |
| ZetaphyCheques | withdraw pays exactly deposit − paid; only the payer tops up / closes / withdraws | Foundry `invariant_payerOnly` | pass |
| ZetaphyCheques | the four properties above | Echidna `EchidnaCheques` (20,000 calls, seqLen 50); Medusa (shared run, 201,565 calls over the 5 harnesses) | pass / pass |
| ZetaphyCheques | for ANY deposit and any two accepted cheques: payee gets ≤ deposit, contract keeps deposit − paid | Halmos `ChequesSymbolic::check_chequesNeverPayMoreThanDeposit` | **pass** (proven: 66 paths, 3.9 s, bitwuzla) |
| ZetaphyCheques | an ERC-777-style token hook cannot re-enter `cash` | Foundry `Reentrancy.t.sol::test_cheques_tokenHookCannotReenter` | pass |
| ZetaphyOfflineOrders | nothing kept between calls (tokens, native, router allowance) | Foundry `OfflineOrders.inv.t.sol::invariant_noResidue` (real router + pairs) | pass |
| ZetaphyOfflineOrders | one fill per nonce; cancelled nonce never fills; maker pays exactly amountIn, gets ≥ minAmountOut; relayer ≤ fee | Foundry `invariant_fillRules` | pass |
| RewardVault | in = vault balance + paid to recipients | Foundry `Governance.inv.t.sol::invariant_conservation` | pass |
| RewardVault | with no deposit in between, ≤ 10% of the balance leaves in any 365 days | Foundry `invariant_scheduleAtMost10PercentPerYear` | pass |
| RewardVault | releasedDays never ahead of daysElapsed | Foundry `invariant_releasedDaysNotAhead` | pass |
| RewardVault | for ANY balance ≤ 1e30 wei: one release after n ∈ {1,7,30,91,182,364,365} days pays ≤ 10% (+ bal/1e20 + 2 wei) and grows with n | Halmos `RewardVaultSymbolic::check_releaseAtMost10PercentPerYear` | timeout (default solver: TIMEOUT after 991 s; bitwuzla, 600 s per query: no result after 28 min, stopped). The 256-bit `bal * z / RAY` products are the bottleneck. Covered by the Foundry schedule invariant above |
| RewardVault | a deposit arriving after N idle days is released retroactively (RV-1) | Foundry `test_finding_depositIsReleasedRetroactively` | demonstrates RV-1 |
| SimpleMultisig | a proposal executes only with `threshold` confirmations of the CURRENT owners | Foundry `invariant_executeNeedsCurrentOwnersQuorum` | **FAIL** (SM-1), every run; shrunk to 12 calls |
| SimpleMultisig | same property | Echidna `EchidnaMultisig` (20,000 calls); Medusa (shared 201,565-call run) | pass / pass — neither found the sequence in this budget (Foundry did in every run, and the unit reproduction proves it): a pass here is not evidence of safety |
| SimpleMultisig | threshold ∈ [2, owners]; owners distinct, non-zero | Foundry `invariant_config` | pass |
| SimpleMultisig | removed owner's confirmation still executes a proposal (SM-1) | Foundry `test_finding_removedOwnerConfirmationStillCounts` | demonstrates SM-1 |
| ZetaphyTimelock | no operation before its delay; only proposers schedule; executions = effects | Foundry `invariant_delayRespected` | pass |
| ZetaphyTimelock | the timelock is its own and only admin | Foundry `invariant_selfAdministered` | pass |
| BridgeGuard + BridgeAirlock | bridged supply = released − burned | Foundry `Bridge.inv.t.sol::invariant_supplyMatchesFlows` | pass |
| BridgeAirlock | release only with ≥ threshold independent attestations, after quarantine, not vetoed, not marked, once | Foundry `invariant_releaseRules` (includes lying lanes) | pass |
| BridgeGuard | per UTC day, minted ≤ the highest hard cap in force at a mint that day | Foundry `invariant_dailyCap` | pass |
| BridgeGuard | paused ⇒ nothing mints or burns | Foundry `invariant_pauseStopsEverything` | pass |
| BridgeAirlock | removed lane's attestation still counts (BA-1) | Foundry `test_finding_removedLaneAttestationCounts` | demonstrates BA-1 |
| HyperlaneLockBoxV2 | balance = locked = locks − claims | Foundry `invariant_backing` | pass |
| HyperlaneLockBoxV2 | claim once, only when ready, unvetoed, unpaused, within the daily limit | Foundry `invariant_claimRules` | pass |
| HyperlaneLockBoxV2 | messages from another sender / naming another source never queued | Foundry `invariant_noForgedQueue` | pass |
| HyperlaneLockBoxV2 | backing + claim rules | Echidna `EchidnaLockBox` (20,000 calls); Medusa | pass / pass |
| HyperlaneLockBoxV2 | a re-entering receiver cannot double-claim | Foundry `test_lockbox_receiverCannotDoubleClaim` | pass |
| HackInsurance | balance ≥ bondsHeld and bondsHeld = exactly the live bonds | Foundry `HackInsurance.inv.t.sol::invariant_bondsBacked` | pass |
| HackInsurance | activeCover = Σ amounts of covers not ended | Foundry `invariant_activeCover` | pass |
| HackInsurance | Σ LP shares = totalShares; one payout per cover | Foundry `invariant_sharesAndSinglePayout` | pass |
| HackInsurance | approved claim paid 0 by a stranger once the daily cap is used (HI-1) | Foundry `test_finding_payoutGriefedToZeroByDailyCap` | demonstrates HI-1 |
| HackInsurance | standing withdrawal flees a pending claim (HI-2) | Foundry `test_finding_standingWithdrawalFleesKnownIncident` | demonstrates HI-2 |
| UsefulIssuance | balance = Σ accrued + pendingOverflow; accrued ≤ cap; in = held + out | Foundry `Rewards.inv.t.sol::invariant_accounting`, Echidna `EchidnaIssuance`, Medusa | pass / pass / pass |
| UsefulWork (+ UsefulIssuance) | balance = reserve + Σ credits + (fee + deposits) of unsettled jobs | Foundry `invariant_conservation` | pass |
| UsefulWork | an accepted result has ≥ quorum matching reveals | Foundry `invariant_resultHasQuorum` | pass |
| BugBounty | solvent: balance ≥ credits + open rewards + open deposits | Foundry `invariant_solvent` | pass |
| BugBounty | no money stranded (balance = liabilities) | Foundry `invariant_noStrandedFunds` | **FAIL** (BB-2) in the first full run (stranded 0.5 ether after 13 calls); passed in the second run (seed-dependent at 256×50) |
| BugBounty | deposit stranded after payout (BB-2) | Foundry `test_finding_depositStrandedAfterPayout` | demonstrates BB-2 |
| BugBounty | sponsor fills the 32 slots, gets everything back (BB-1) | Foundry `test_finding_sponsorFillsFindingSlots` | demonstrates BB-1 |
| ComputeMarket | balance = Σ credits + prices of unsettled tasks; one settlement per task | Foundry `invariant_escrow`, Echidna `EchidnaCompute`, Medusa | pass / pass / pass |
| ComputeMarket | a re-entering withdrawer gets nothing more | Foundry `test_compute_withdrawReentryGetsNothing` | pass |
| DataDAO | reserved = what live rounds owe; balance ≥ reserved; claims pay their leaf | Foundry `invariant_reserved` | pass |
| AgentPolicyWallet | per token ≤ 2× perPeriod in any sliding period; no unlimited token; nothing while frozen; allowed recipients only; cosign threshold respected | Foundry `Wallets.inv.t.sol::invariant_agentWithinCaps` | pass |
| AgentPolicyWallet | agent moves an NFT of an allowed target uncapped (APW-1) | Foundry `test_finding_agentMovesNftOfAllowedTarget` | demonstrates APW-1 |
| QuantumWallet | nonce = authorised actions; no replay; both keys needed (precompile mocked) | Foundry `invariant_noReplay` | pass |
| AgentRegistry | balance = Σ bonds + open-claim deposits; openClaims counter exact; no bond out while a claim is open | Foundry `invariant_accounting` | pass |
| AgentRegistry | bond withdrawn inside the 30-day claim window (AR-1) | Foundry `test_finding_bondWithdrawnInsideClaimWindow` | demonstrates AR-1 |
| StableGateway | one request per nonce; user pays ≤ maxCost; reserve pays exactly fee | Foundry `invariant_requests` | pass |
| StableGateway + NeuroJobs | unanswered job refunds 95% in native to the user (SG-1) | Foundry `test_finding_userGetsNativeRefundForStablecoin` | demonstrates SG-1 |
| ZetaphyEarly | balances sum to the fixed supply | Foundry `Early.inv.t.sol::invariant_supplyConserved` | pass |
| ZetaphyEarlyFarm | owed ≤ ZEARLY held; Σ earned ≤ owed; staked = LP held | Foundry `invariant_farmFunded` | pass |
| ZetaphyEarlyFarm | idle-period rewards locked (EF-1) | Foundry `test_finding_idleRewardsLocked` | demonstrates EF-1 |
| ZetaphyEarlyFarm | LP-token hook cannot re-enter `withdraw` | Foundry `test_farm_lpHookCannotReenterWithdraw` | pass |
| ZetaphyEarlyPolls / Pass / Quests | release once; polls hold locked votes; one pass per wallet ≤ maxSupply; one quest payment per wallet ≤ cap | Foundry `invariant_pollsPassQuests` | pass |
| NeuroJobs | balance = reward pool + Σ credits + Σ bonds + open fees + open challenge bonds | Foundry `NeuroJobs.inv.t.sol::invariant_solvency` | pass |
| NeuroJobs | totalActiveBond / activeWorkers match the runners | Foundry `invariant_activeBond` | pass |
| NeuroJobs | no bond withdrawn while its runner can still be slashed (open round, grace, challengeable or challenged round 1) | Foundry `invariant_bondHeldWhileSlashable` | **FAIL** (NJ-1) in 1 of 3 full runs (5-call counterexample); passed in the other two (seed-dependent) |
| NeuroJobs | unrevealed seat withdraws its bond before anyone calls expire (NJ-1) | Foundry `test_finding_unrevealedSeatWithdrawsBondBeforeExpire` | demonstrates NJ-1 |

Harness checks (not properties): `test_handlerReaches*` and `EchidnaHarnessesSmoke` assert that each
handler actually reaches the money-moving paths, so a passing invariant is not vacuous.

## zetaphy-dex

| Contract | Property | Tool / file | Status |
|---|---|---|---|
| ZetaphyPair (+ router) | no swap (exact in, exact out, flash with any pay-back) lowers reserve0 × reserve1 | Foundry `ZetaphyPair.inv.t.sol::invariant_kNeverDecreasesOnSwap` | pass |
| ZetaphyPair | value of one LP share (√k / supply incl. pending protocol-fee LP) never decreases | Foundry `invariant_shareValueNonDecreasing` | pass |
| ZetaphyPair / Router | reserves ≤ balances; Σ LP = supply; MINIMUM_LIQUIDITY locked; router keeps nothing | Foundry `invariant_accounting` | pass |
| ZetaphyPair | for ANY inputs and requested outputs, a successful swap keeps k | Halmos `PairSymbolic::check_swapNeverDecreasesK` | timeout (160 paths, 685 s; 256-bit symbolic products) — covered by the Foundry invariant above |
| ZetaphyPair | burning ANY amount of LP pays ≤ the pro-rata share | Halmos `PairSymbolic::check_burnPaysAtMostShare` | timeout (300 s per query) — covered by `invariant_shareValueNonDecreasing` |
| ZetaphyDlmmPair | Σ bins = reserves; balances ≥ reserves + protocol fees | Foundry `Dlmm.inv.t.sol::invariant_reservesMatchBins` | pass |
| ZetaphyDlmmPair | bins above active hold only X, below only Y | Foundry `invariant_singleSided` | pass |
| ZetaphyDlmmPair | per bin Σ LP = supply; shares ⇔ reserves; non-empty bins in the bitmap; no burn of others' shares | Foundry `invariant_shares` | pass |
| ZetaphyDlmmPair | a round trip never returns more than paid (donations swept first) | Foundry `invariant_noRoundTripProfit` | pass |
| DlmmMath | mulDiv = floor(a·b/d) vs. a 512-bit reference; reverts iff the result overflows; mulDivUp = ceil | Foundry fuzz `DlmmMathFuzz` (3 tests) | pass |
| DlmmMath | price strictly increasing in id; p(id)·p(−id) ≈ 1 (1e-9) | Foundry fuzz `testFuzz_priceMonotonic` | pass |
| DlmmBinTree | below/above equal a naive scan after random adds/removes | Foundry fuzz `testFuzz_binTreeMatchesReference` | pass |
| DlmmMath | mulDiv exact for ANY a, b < 2^128, d ≠ 0 | Halmos `DlmmMathSymbolic::check_mulDivExactWhenNoOverflow` | timeout (300 s per query, also with 40-bit operands) — covered by the 512-bit-reference fuzz |
| DlmmMath | X→Y→X at a bin price never gains; mulPriceUp ≥ mulPriceDown (ANY amount, ANY valid price) | Halmos `check_priceRoundTripFavoursPool` | timeout (300 s per query) — covered by `invariant_noRoundTripProfit` |

## zetaphy-nft

| Contract | Property | Tool / file | Status |
|---|---|---|---|
| NFTMarketplace | balance = Σ credits + Σ open offers | Foundry `NFTMarketplace.inv.t.sol::invariant_escrow` | pass |
| NFTMarketplace | every sale credits exactly the price and delivers the token(s) | Foundry `invariant_sales` | pass |

## Counts

Runs recorded here: `forge test` at 256 runs × depth 50 (12,800 calls per invariant) in each package;
Echidna 2.2.6, 20,000 calls per harness; Medusa 1.3.1, 300 s / 201,565 calls over all five harnesses;
Halmos 0.3.3 with bitwuzla, 300 s per query.

| Package | Foundry invariants | Fuzz / unit property tests | Finding reproductions | Re-entrancy tests | Echidna/Medusa properties | Halmos checks | Result |
|---|---|---|---|---|---|---|---|
| zetaphy-network | 40 | – | 12 | 4 | 9 (5 harnesses) | 2 | 3 full runs: run 1 failed SM-1 + BB-2, run 2 failed SM-1 only, run 3 failed SM-1 + BB-2 + NJ-1 (all other tests pass in every run; 63 forge tests; once found, forge replays a counterexample, so the final run shows all three); Echidna 9/9 and Medusa 9/9 pass; Halmos: cheques pass, vault timeout |
| zetaphy-dex | 7 | 5 | 0 | 0 | – | 4 | 12 of 12 forge tests pass; Halmos 4 timeouts |
| zetaphy-nft | 2 | – | 0 | 0 | – | – | 2 of 2 pass |

Per contract (invariants + symbolic + finding/re-entrancy tests; harness smoke tests not counted):
ZetaphyCheques 6, ZetaphyOfflineOrders 2, RewardVault 5, SimpleMultisig 3, ZetaphyTimelock 2,
BridgeGuard + BridgeAirlock 5, HyperlaneLockBoxV2 4, HackInsurance 5, UsefulIssuance 1, UsefulWork 2,
BugBounty 4, ComputeMarket 2, DataDAO 1, AgentPolicyWallet 2, QuantumWallet 1, AgentRegistry 2,
StableGateway 2 (one with NeuroJobs), ZetaphyEarly 1, ZetaphyEarlyFarm 3, Polls/Pass/Quests 1
(combined), NeuroJobs 4, ZetaphyPair/Router 5, ZetaphyDlmmPair 4, DlmmMath/DlmmBinTree 7,
NFTMarketplace 2.

## What did not run here, and why

- **Halmos on the AMM and DLMM math** (`PairSymbolic`, `DlmmMathSymbolic`): written and run, all four
  time out at 300 s per query. Symbolic 256-bit multiplication/division is the bottleneck; I also
  tried 40-bit operands for mulDiv and a narrow price range for the round trip, and those timed out
  too (removed). The properties are covered by the fuzz/invariant suites instead; run the Halmos
  checks overnight with `--solver-timeout-assertion 0` if a proof is wanted.
- **Halmos on RewardVault with a symbolic day count**: did not finish in 20 minutes (division plus the
  bit loop of `_rpow`). The committed check uses a symbolic balance and a concrete grid of days that
  includes the worst case (365). That one did not finish either (see the table): run it overnight
  with `--solver-timeout-assertion 0`.
- **Echidna/Medusa** were run on the five network harnesses only (Cheques, UsefulIssuance,
  ComputeMarket, HyperlaneLockBoxV2, SimpleMultisig). The other suites use cheatcodes that Echidna
  does not support (`vm.setBlockhash`, `vm.snapshotState`, `vm.etch` of the ML-DSA mock) or need
  the cross-package DEX build; they run under Foundry only.
- **Not covered by any property:** the contracts out of scope (see manual-review.md), the real ML-DSA
  precompile and WebAuthn/P-256 verifier (mocked or not exercised), NeuroControl-driven behaviour of
  NeuroJobs (defenders, pause, roster — the suite runs without a NeuroControl), the ZETAPHY native
  ERC-20 precompile variant of WZETAPHY (only the classic WZETAPHY is used), FROST signature
  verification (no test vectors re-derived), and anything cross-chain beyond the mocked Mailbox.
- **Existing JS suites:** `zetaphy-dex npm test` 117/117 pass. `zetaphy-network npm test` 657/658 on
  the first run; the failure was `test/detectorloop.test.js` importing the sibling package
  `zetaphy-neuro`, whose `node_modules` were not installed in this checkout. After `npm ci` in
  `zetaphy-neuro` that file passes (3/3), so all 658 pass. No JS test or contract was changed.
