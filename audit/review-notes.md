# Review notes

## Decisions on the open Highs (2026-10-30, fixes in commit 6829bee)

Every High that was still open (the 72 of the report for eab6266 — 73 in the old baseline, one of which, BugBounty `3b50e2ce0378`, is no longer reported — plus the OSV-Scanner
finding CI's gate reported on `yarn.lock`) was read at its line and decided on its own.
All decisions are in `triage.yml` with the reason, marked
`claude-agent (auditor triage of the open Highs, by reading the code; owner to confirm)`:
they count as decided for the gate, `--json` and SARIF, and are shown as
**PENDING OWNER CONFIRMATION** until the owner puts their own name in `decided_by` (or
deletes an entry to reopen it).

| Decision | Count | What |
|---|---:|---|
| **fixed** | 3 | NeuroScore int64 truncation (2: the stored score and the event), `bigint-buffer@1.1.5` (GHSA-3gc7-fjrx-p6mg) |
| **accepted-risk** | 4 | `LockBox` and `HyperlaneLockBox` lock native coin by design (2); NeuroJobs runner lottery, the documented proposer bias (2) |
| **false-positive** | 67 | 41 aderyn re-entrancy, 21 aderyn unchecked-address sends, 4 slither arbitrary-send-eth, and the OSV match on the pure-JS `bigint-buffer` replacement |
| left open | 0 | |

Result of the fast tier on 6829bee (Go step not run here, see below): **0 open High /
Critical, gate passes**; invariant suites 96 passed, 0 failed.

**The fixes**

- **NeuroScore** (`_score`): the score `a * z / scale + b` of a governance-activated model
  can leave the int64 range; it was stored (and emitted) as `int64(score)`, truncated, while
  `evaluate()` returned the full value, so the stored level and score could disagree.
  `_toInt64` now reverts `ScoreOutOfRange` outside int64. Regression test: "a score outside
  int64 is refused" in `zetaphy-network/test/neuroscore.test.js` (a valid NSM1 model with
  scale 1 and int32-max calibration and leaves). Artifacts rebuilt.
- **bigint-buffer@1.1.5** (High, GHSA-3gc7-fjrx-p6mg: the native `toBigInt` overflows/aborts
  on a bad buffer; every version is affected, no fixed release; `@trufflesuite/bigint-buffer`
  ships the same C code, so switching to it would only hide the advisory). It comes from
  `@solana/spl-token` (0.3 via `@sqds/multisig`, and 0.4) → `@solana/buffer-layout-utils`,
  i.e. the Anchor test tooling. The root `package.json` `resolutions` now installs
  `scripts/vendor/bigint-buffer`, a pure-JS drop-in with the same four functions (the
  package's own JS fallback, input checked, low bytes kept like the native code), tested in
  `scripts/vendor/bigint-buffer/test.js`; `@solana/spl-token` account layouts encode/decode
  through it. `yarn.lock` loses `bigint-buffer@1.1.5`, `bindings` and `file-uri-to-path`.
  OSV-Scanner matches by name and version, so it still reports
  `bigint-buffer@1.1.5-pure-js.1`; that entry is triaged false-positive with this reason.
  Not verified here: the `anchor test` suite itself (no Solana toolchain in this sandbox);
  the CI job "program (cargo test + anchor test)" runs it with `yarn install --frozen-lockfile`.

**Why most re-entrancy findings are false positives.** Aderyn's
`reentrancy-state-change` flags any state write after any external call. In 34 of the 41 the
call is to a function declared `view`/`pure` in the interface (registries, `labelOf`,
`workers`, `isValid`, `token0`, `transferId`, …): solc compiles those to STATICCALL, so the
callee cannot write state or re-enter. The rest are calls to immutable/constructor-set
contracts of ours that call nothing back (TwapRecorder.record, ForesightRegistry.closeCommits,
UsefulIssuance.draw, the plain ZEARLY ERC-20), a `lock`/`nonReentrant` function, or a write
that runs only after a failed (fully reverted) call. Each entry names its own guard.

**Why the unchecked-address sends are false positives.** Each pays `msg.sender` its own
credit (zeroed first), or an address recorded in state (claimant, operator, maker of a signed
order, the Merkle-proven account, a governance-set fund or share list), never a
caller-chosen one.

**Accepted risks** (the owner must confirm; users must be told):
- `LockBox` / `HyperlaneLockBox`: no release or refund path by design ("a vetoed or held
  transfer stays locked"). Fine for the testnet lane; a release/refund path is needed before
  the bridge holds real value.
- NeuroJobs lottery (`j.seed`, `_eligible`): it already draws from `blockhash(startBlock + 1)`,
  a block after the round opens, fixed once that block exists (retries change nothing). What
  remains is documented in the contract: the proposer of that block can grind its hash, and a
  chain whose BLOCKHASH is 0 falls back to request data only. The chain's PREVRANDAO (from the
  PQ vote certificate, `zetaphy-chain/README.md` item 8) is also proposer-biasable, so using it
  would not remove the bias. Mainnet stakes on the lottery need commit-reveal or a VRF/beacon.

**New lead (not a tool finding), now fixed as AR-2 (`audit/manual-review.md`):** in **AgentRegistry**, the checker of an
action is the operator's choice (`register`/`update`), and `claimByChecker` pays the victim
the checker names, up to the whole bond, at once. An operator can therefore switch to a
checker that names an address of its own, record an action and take the bond back
immediately, around `UNBOND_DELAY` and around committee claims still open on earlier actions.
Re-entrancy is not the issue (the call is a STATICCALL); the trust model is. Options: a
governance allow-list of checkers, or a checker change that only applies after
`UNBOND_DELAY` and while no claim is open. The owner chose the allow-list: `setChecker`
(governance only), `register`/`update` refuse an unapproved checker, and `claimByChecker` pays
only while the action's checker is still approved.

**Pipeline changes in the same work**

- SARIF: triaged findings are uploaded with `suppressions` (kind `external`, status
  `accepted`, justification = status, reason, decider), so code scanning shows the 204 decided
  Highs as dismissed with their reason; open findings stay alerts at their severity.
- Semgrep `basic-arithmetic-underflow` (126 hits, the Medium review comments on PR #88): all
  126 are on Solidity `0.8.26` lines outside any `unchecked` block, where an underflow reverts.
  The report now gives the rule Info there (not in code scanning) and keeps Medium inside
  `unchecked` blocks or in files that allow solc < 0.8 (none today). README "Triage" explains it.
- `OSV_OFFLINE_DB=<dir>` lets OSV-Scanner use the downloadable database where api.osv.dev is
  blocked (as in this sandbox).
- Not run here: the Go step (no disk room to build the patched chain; `zetaphy-chain/` is
  unchanged), so the 19 gosec G115 entries show under "matched nothing" in this REPORT only.
  `npm audit` for zetaphy-dex got no answer from the registry here.

### All decisions

| # | Finding (tool / rule) | Where | Decision | Why (the guard / the fix) |
|---:|---|---|---|---|
| 1 | aderyn / unsafe-casting <br>`17b11df7e29a` | `network/NeuroScore.sol (_score)` | **fixed** | NeuroScore._score emitted int64(score) unchecked. Fixed in 6829bee: the event now carries the range-checked value from _toInt64 (reverts ScoreOutOfRange); regression test in zetaphy-network/test/neuroscore.test.js. |
| 2 | aderyn / unsafe-casting <br>`4e47b7e79173` | `network/NeuroScore.sol (_score)` | **fixed** | NeuroScore._score stored int64(score) unchecked. Fixed in 6829bee: _toInt64 reverts ScoreOutOfRange outside int64 instead of storing a truncated score (the event uses the same value); regression test "a score outside int64 is refused" in zetaphy-network/test/neuroscore.test.js. |
| 3 | osv-scanner / GHSA-3gc7-fjrx-p6mg <br>`035bd1566304` | `yarn.lock (was bigint-buffer@1.1.5)` | **fixed** | bigint-buffer@1.1.5 (native toBigInt buffer overflow, no fixed release) is replaced in 6829bee by scripts/vendor/bigint-buffer, a pure-JS drop-in with the same four functions, through the root package.json resolutions; yarn.lock no longer has bigint-buffer@1.1.5, bindings or file-uri-to-path. Tests: scripts/vendor/bigint-buffer/test.js; @solana/spl-token layouts decode/encode through it. |
| 4 | aderyn / contract-locks-ether <br>`d68ff4299dbc` | `network/BridgeAirlock.sol:477` | **accepted-risk** | LockBox is the source-chain side of the testnet Neuro bridge lane: lock() takes native coin and emits Locked; by design it has no withdraw/refund path (documented in the contract: a vetoed or held transfer stays locked). Accepted for testnet; users must be told before the lane holds real value, and a release/refund path is needed before mainnet. |
| 5 | aderyn / contract-locks-ether <br>`8d254d24e64c` | `network/HyperlaneLane.sol:149` | **accepted-risk** | HyperlaneLockBox, like LockBox, locks native coin with no refund path by design (documented: "Like LockBox it has no refund path: a vetoed or held transfer stays locked here"); only the Mailbox fee leaves it. Accepted for testnet; a release/refund path is needed before mainnet and users must be told. |
| 6 | aderyn / weak-randomness <br>`6e5cf1246faa` | `network/NeuroJobs.sol:867` | **accepted-risk** | j.seed (requester, chain, target, timestamp, counter) is only a per-job salt, not the randomness: runner selection uses keccak256(seed, blockhash(startBlock + 1), round), a block after the request/round opening, so neither the requester nor a runner retrying can pick it (contract docs, "Lottery bound to a block nobody picks"). Remaining, documented weakness: the proposer of block startBlock + 1 can grind that block's hash (validator-level bias), and on a chain whose BLOCKHASH is 0 the fallback is as predictable as the request. The chain's own randomness (PREVRANDAO from the PQ vote certificate, zetaphy-chain README item 8) is also proposer-biasable, so it would not remove the bias. Accepted for testnet; mainnet stakes on the lottery need commit-reveal or a VRF/beacon. |
| 7 | slither / weak-prng <br>`7bcac6f4961b` | `network/NeuroJobs.sol:301` | **accepted-risk** | _eligible draws with keccak256(_rand(seed, round), runner) % 1e18, where _rand is keccak256(seed, blockhash(startBlock + 1), round): bound to a future block, stored on first use, unchanged by retries. The residual bias is the proposer of startBlock + 1 (and the zero-BLOCKHASH fallback), documented in the contract; same decision as the aderyn weak-randomness entry on j.seed. Accepted for testnet; commit-reveal or a VRF/beacon before mainnet stakes. |
| 8 | aderyn / eth-send-unchecked-address <br>`24a8d2ef837d` | `network/AgentRegistry.sol:313` | **false-positive** | vote -> _close pays only recorded addresses: c.claimant (msg.sender of fileClaim) its deposit and the slashed damage, or a.operator (who registered the agent) the deposit. Claim state, openClaims and the bond are updated before each payment (_slash subtracts before _pay). |
| 9 | aderyn / eth-send-unchecked-address <br>`8f7ed6746973` | `network/AgentRegistry.sol:326` | **false-positive** | expireClaim -> _close(claimId, false) pays the claim deposit to a.operator, the address stored at register(); state (Rejected, openClaims--) is written before the payment. |
| 10 | aderyn / eth-send-unchecked-address <br>`99f52b427f59` | `network/BugBounty.sol:320` | **false-positive** | withdraw pays msg.sender its own owed[msg.sender], zeroed before the call. |
| 11 | aderyn / eth-send-unchecked-address <br>`ee45839a615c` | `network/ComputeMarket.sol:128` | **false-positive** | withdraw pays msg.sender its own credit[msg.sender], zeroed before the call. |
| 12 | aderyn / eth-send-unchecked-address <br>`a41374451ef7` | `network/DataDAO.sol:151` | **false-positive** | claim pays `account` exactly the amount in a Merkle leaf (round, account, amount) proven against the round root; claimed[round][account], r.claimed and reserved are written before the call. Anyone may submit, but the coins only go to the proven account. |
| 13 | aderyn / eth-send-unchecked-address <br>`a2d7aad084d2` | `network/DetectorPool.sol:228` | **false-positive** | withdraw pays msg.sender its own owed[msg.sender], zeroed before the call. |
| 14 | aderyn / eth-send-unchecked-address <br>`3e51299f8f84` | `network/HackInsurance.sol:187` | **false-positive** | withdraw pays msg.sender for its own shares (after the request delay, no open claims); pendingShares, shares and totalShares are reduced before _send. |
| 15 | aderyn / eth-send-unchecked-address <br>`48e465db72cd` | `network/HackInsurance.sol:211` | **false-positive** | buyCover refunds msg.sender only its own overpayment (msg.value - premium), after the cover is recorded. |
| 16 | aderyn / eth-send-unchecked-address <br>`7813ea08ae90` | `network/HackInsurance.sol:292` | **false-positive** | expire -> _close refunds the claim bond to k.claimant (msg.sender of the claim, stored); state, claimOfCover, openClaims, bondsHeld and k.bond are written before _send. |
| 17 | aderyn / eth-send-unchecked-address <br>`6bb46df40e5a` | `network/NeuroJobs.sol:830` | **false-positive** | withdraw pays msg.sender its own credit[msg.sender], zeroed before the call. |
| 18 | aderyn / eth-send-unchecked-address <br>`1caaf8480004` | `network/NeuroOracle.sol:253` | **false-positive** | push -> _dispatch pays the Mailbox fee to the immutable mailbox and refunds the excess only to msg.sender; sentRound/sentEnforcedFrom are written before the dispatch. |
| 19 | aderyn / eth-send-unchecked-address <br>`89756e82c0f6` | `network/RedBlueArena.sol:497` | **false-positive** | withdraw pays msg.sender its own owed[msg.sender], zeroed before the call. |
| 20 | aderyn / eth-send-unchecked-address <br>`b3b22c324606` | `network/RedBlueArena.sol:212` | **false-positive** | withdrawBond pays msg.sender its own bond after the unbonding delay and with no active seats; s.bond and s.unbondAt are zeroed before the call. |
| 21 | aderyn / eth-send-unchecked-address <br>`09024c8ab54d` | `network/RewardVault.sol:93` | **false-positive** | release pays the governance-set _shares (set through proposeShares with a 7-day DELAY; _check refuses address(0)); _due is zeroed and _paying set before the calls, and _paying makes a re-entering recipient's release() return 0 and applyShares() revert. |
| 22 | aderyn / eth-send-unchecked-address <br>`9ee49ec2404b` | `network/RewardVault.sol:147` | **false-positive** | applyShares -> release pays the current governance-set shares (7-day DELAY); _pending and pendingAt are cleared before release(), and applyShares refuses to run while _paying. |
| 23 | aderyn / eth-send-unchecked-address <br>`7e27372cfe7b` | `network/RiskForecasts.sol:280` | **false-positive** | withdraw pays msg.sender its own owed[msg.sender], zeroed before the call. |
| 24 | aderyn / eth-send-unchecked-address <br>`8ba55f9bdcb9` | `network/ThreatRegistry.sol:701` | **false-positive** | withdraw pays msg.sender its own owed[msg.sender], zeroed before _pay. |
| 25 | aderyn / eth-send-unchecked-address <br>`cf43cca96e36` | `network/ThreatReports.sol:105` | **false-positive** | settle pays only communityFund (set by governance, never address(0)) the dust or the expired fee; r.state is written before. |
| 26 | aderyn / eth-send-unchecked-address <br>`deac0b0c8e00` | `network/ThreatReports.sol:125` | **false-positive** | claim pays msg.sender (a voter of the settling flag, checked) its share; claimed and r.claims are written before the call. |
| 27 | aderyn / eth-send-unchecked-address <br>`fd1f9bc87c9e` | `network/UsefulIssuance.sol:111` | **false-positive** | sweepOverflow pays only `overflow` (set by governance, non-zero) the pending overflow, zeroed before the call. |
| 28 | aderyn / eth-send-unchecked-address <br>`a2ae25d4261d` | `network/UsefulWork.sol:374` | **false-positive** | withdraw pays msg.sender its own owed[msg.sender], zeroed before the call. |
| 29 | aderyn / reentrancy-state-change <br>`90694f24e172` | `dex/dlmm/ZetaphyDlmmFactory.sol:135` | **false-positive** | createPair: pairDeployer is immutable, created by this factory's constructor (`new ZetaphyDlmmPairDeployer()`), and its deploy() only CREATE2s a ZetaphyDlmmPair (whose constructor makes one view call back for its parameters); no token or user code runs. getPair is checked empty before, and the CREATE2 salt (tokenX, tokenY, binStep) makes a second pair for the same key impossible. |
| 30 | aderyn / reentrancy-state-change <br>`8769c5ef1b3d` | `dex/dlmm/ZetaphyDlmmPair.sol:602` | **false-positive** | collectProtocolFees has the pair's lock modifier; IDlmmFactoryForPair.feeTo() is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. The fees are zeroed before the token transfers. |
| 31 | aderyn / reentrancy-state-change <br>`a05e81fab0e0` | `dex/dlmm/ZetaphyDlmmPair.sol:184` | **false-positive** | pair constructor: IDlmmPairDeployer.pairParameters() is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. msg.sender is the deployer that is CREATE2-ing this pair. |
| 32 | aderyn / reentrancy-state-change <br>`a5f803434df8` | `dex/dlmm/ZetaphyDlmmRouter.sol:131` | **false-positive** | router constructor: IDlmmFactoryR.PAIR_CODE_HASH() / pairDeployer() is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. It runs once, at deploy, on the factory given by the deployer. |
| 33 | aderyn / reentrancy-state-change <br>`c4d27826f961` | `network/AgentPolicyWallet.sol:434` | **false-positive** | executeCosignedFrost (onlyAgent): ICosignCommittee.isValidFrost is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. The committee is set only by the owner (_config). cosignNonce++ after it is the replay counter of the digest just checked. |
| 34 | aderyn / reentrancy-state-change <br>`fdd324aa9a3b` | `network/AgentPolicyWallet.sol:415` | **false-positive** | executeCosigned (onlyAgent): ICosignCommittee.isValid is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. The committee is set only by the owner (_config). cosignNonce++ after it is the replay counter of the digest just checked. |
| 35 | aderyn / reentrancy-state-change <br>`71496f0f2b20` | `network/AgentRegistry.sol:295` | **false-positive** | claimByChecker: IPolicyChecker.check is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. So a malicious checker cannot re-enter to pay twice; act.slashed is then set before _slash pays (one payout per action), and _slash caps the payout at the bond. (Separate design note, not this finding: the checker is the operator's choice; see review-notes.md.) |
| 36 | aderyn / reentrancy-state-change <br>`44135552b910` | `network/BridgeAirlock.sol:447` | **false-positive** | attest (registered runners only, _runner()): control is immutable; INeuroControl.paused() is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 37 | aderyn / reentrancy-state-change <br>`fccfbb9d2469` | `network/BridgeAirlock.sol:448` | **false-positive** | attest: airlock is immutable and BridgeAirlock.transferId is `public pure`, a STATICCALL that hashes its arguments. The airlock's state-changing attest() is called last, after votedBy/votes/done are written. |
| 38 | aderyn / reentrancy-state-change <br>`7a2aeb935365` | `network/BugBounty.sol:279` | **false-positive** | claim: f.state = Paid and b.paid = true are written before issuance.draw; issuance is set only in the constructor (no setter) and is our UsefulIssuance, whose draw() pays the caller from its bucket after updating its own accounting. owed[] is only credited afterwards (pull payment via withdraw). |
| 39 | aderyn / reentrancy-state-change <br>`da98dfc4f428` | `network/ComputeMarket.sol:76` | **false-positive** | take: runners is immutable; IRunnersView.workers is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 40 | aderyn / reentrancy-state-change <br>`c136631d98f3` | `network/DetectorPool.sol:117` | **false-positive** | register: IForesightTracks.modelOwner is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. foresight is set only in the constructor. |
| 41 | aderyn / reentrancy-state-change <br>`d886404a1939` | `network/DetectorPool.sol:120` | **false-positive** | register: IForesightTracks.tracks is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. foresight is set only in the constructor. |
| 42 | aderyn / reentrancy-state-change <br>`1533ef55e154` | `network/HumanAgentLabels.sol:375` | **false-positive** | vouch: labels is an immutable LabelRegistry; the public getter LabelRegistry.humans is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 43 | aderyn / reentrancy-state-change <br>`1a4a6be2c98c` | `network/HumanAgentLabels.sol:559` | **false-positive** | faucet drip: labels is an immutable LabelRegistry; the public getter LabelRegistry.humans is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. lastDripCredential is written before the payment. |
| 44 | aderyn / reentrancy-state-change <br>`2075a0403a54` | `network/HumanAgentLabels.sol:613` | **false-positive** | trade gate check (isCaller only): labels is immutable; ILabels.labelOf is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 45 | aderyn / reentrancy-state-change <br>`3316bf660feb` | `network/HumanAgentLabels.sol:553` | **false-positive** | faucet drip: labels is an immutable LabelRegistry; LabelRegistry.labelOf is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. lastDrip is written before the payment to msg.sender. |
| 46 | aderyn / reentrancy-state-change <br>`4524c31345e1` | `network/HumanAgentLabels.sol:393` | **false-positive** | refresh: labels is an immutable LabelRegistry; LabelRegistry.labelOf is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 47 | aderyn / reentrancy-state-change <br>`bb6c35f65a54` | `network/HumanAgentLabels.sol:371` | **false-positive** | vouch: labels is an immutable LabelRegistry; LabelRegistry.labelOf is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 48 | aderyn / reentrancy-state-change <br>`4417665c3c47` | `network/HyperlaneLane.sol:121` | **false-positive** | handle: only the Mailbox (msg.sender check), only the configured origin/sender; airlock is immutable and transferId is `pure` (STATICCALL). delivered[id] is set before the airlock's attest() is called. |
| 49 | aderyn / reentrancy-state-change <br>`2b15d737e4a5` | `network/NeuroAttest.sol:95` | **false-positive** | attestFromJob: jobs is immutable; INAJobs.getJob is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 50 | aderyn / reentrancy-state-change <br>`62ad0686eab9` | `network/NeuroAttest.sol:97` | **false-positive** | attestFromJob: jobs is immutable; INAJobs.jobInfo is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 51 | aderyn / reentrancy-state-change <br>`8754a20c991f` | `network/NeuroAttest.sol:93` | **false-positive** | attestFromJob: jobs is immutable; INAJobs.assurance is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 52 | aderyn / reentrancy-state-change <br>`2de7e3e7c899` | `network/NeuroJobs.sol:1106` | **false-positive** | regrow: control is wired once by the deployer (setControl, then fixed); INeuroKnobs.roster is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 53 | aderyn / reentrancy-state-change <br>`bd0b6673df32` | `network/NeuroJobs.sol:1105` | **false-positive** | regrow: control is wired once by the deployer (setControl, then fixed); INeuroKnobs.maxRegrowPerHour is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 54 | aderyn / reentrancy-state-change <br>`065a092e6e42` | `network/RiskForecasts.sol:195` | **false-positive** | poke: foresight is set only in the constructor (our ForesightRegistry); its closeCommits() only checks msg.sender == the event resolver and moves the commit/reveal deadlines, calling nothing. s.seenAt is written before it; q.closeAt after it cannot be raced by anything that call can run. |
| 55 | aderyn / reentrancy-state-change <br>`5c0e6b3d4a40` | `network/ThreatReports.sol:129` | **false-positive** | claim: registry is immutable; IThreatRegistryView.voted is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. claimed[id][msg.sender] and r.claims are written before the payment. |
| 56 | aderyn / reentrancy-state-change <br>`6e0a74e63019` | `network/ThreatReports.sol:108` | **false-positive** | settle: registry is immutable; IThreatRegistryView.entries is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. r.state is written before any payment. |
| 57 | aderyn / reentrancy-state-change <br>`9ca6b87cd9a9` | `network/ThreatReports.sol:110` | **false-positive** | settle: registry is immutable; IThreatRegistryView.quorum is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 58 | aderyn / reentrancy-state-change <br>`b6f5936e67b2` | `network/ThreatReports.sol:130` | **false-positive** | claim: registry is immutable; IThreatRegistryView.quorum is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 59 | aderyn / reentrancy-state-change <br>`b98279c34116` | `network/ThreatReports.sol:96` | **false-positive** | report: registry is immutable (ThreatRegistry); IThreatRegistryView.entries is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 60 | aderyn / reentrancy-state-change <br>`0f4b07f15a88` | `network/UsefulIssuance.sol:115` | **false-positive** | sweepOverflow: pendingOverflow is zeroed before the call; the write after it (pendingOverflow = amount) runs only when the call FAILED, and a failed call reverts everything the callee did, including any re-entrant change; on success nothing is written after the call. |
| 61 | aderyn / reentrancy-state-change <br>`74f77558f70a` | `network/WorkerReputation.sol:126` | **false-positive** | linkAgent: identity is immutable; IRepIdentity.ownerOf is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 62 | aderyn / reentrancy-state-change <br>`ffb2067e19f9` | `network/ZetaphyEarlyFarm.sol:124` | **false-positive** | notifyReward (onlyOperator): rewardsToken is immutable; IERC20F.balanceOf is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 63 | aderyn / reentrancy-state-change <br>`25ec15001519` | `network/ZetaphyEarlyPass.sol:62` | **false-positive** | mint: zearly is immutable; IZearly.balanceOf is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 64 | aderyn / reentrancy-state-change <br>`7b246722d74e` | `network/ZetaphyEarlyPass.sol:65` | **false-positive** | mint: zearly is the immutable ZETAPHY Early token (contracts/ZetaphyEarly.sol), a plain ERC-20 whose transferFrom has no hooks or callbacks, so it cannot re-enter; minted[msg.sender] and totalSupply are written before it anyway, so a re-entrant mint would revert AlreadyMinted. |
| 65 | aderyn / reentrancy-state-change <br>`e315b91c5c79` | `network/ZetaphyEarlyPolls.sol:54` | **false-positive** | create: token is the immutable ZEARLY (contracts/ZetaphyEarly.sol), a plain ERC-20 whose transferFrom has no hooks or callbacks, so the deposit pull cannot re-enter; the poll is written after it with a fresh id (polls.length). |
| 66 | aderyn / reentrancy-state-change <br>`045d8518076e` | `network/ZetaphyOracle.sol:263` | **false-positive** | poke: recorder is immutable (our TwapRecorder); record() only reads the pair through view functions (current(): price*CumulativeLast, getReserves) and writes its own observation, calling nothing that can re-enter; the call is in try/catch. |
| 67 | aderyn / reentrancy-state-change <br>`17b0ee330e5b` | `network/ZetaphyOracle.sol:179` | **false-positive** | setTwap (onlyGov): IPairTokens.token0 is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 68 | aderyn / reentrancy-state-change <br>`ebc0f2e7dfd4` | `network/ZetaphyOracle.sol:183` | **false-positive** | setTwap (onlyGov): IDecimals.decimals is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 69 | aderyn / reentrancy-state-change <br>`fb12769dd4a8` | `network/ZetaphyOracle.sol:180` | **false-positive** | setTwap (onlyGov): IPairTokens.token1 is declared view/pure in the interface, so solc compiles the call to STATICCALL: the callee cannot write state or re-enter (any write in it reverts), and nothing it returns can be changed by a re-entrant caller. |
| 70 | osv-scanner / GHSA-3gc7-fjrx-p6mg <br>`33a6ef4d35fd` | `yarn.lock (bigint-buffer@1.1.5-pure-js.1)` | **false-positive** | OSV matches by name and version only: the yarn.lock entry is bigint-buffer@1.1.5-pure-js.1, the in-repo pure-JS replacement scripts/vendor/bigint-buffer (root package.json resolutions, 6829bee). The advisory is about the native addon's toBigInt (src/bigint-buffer.c, crash on a bad buffer); the replacement has no native code, checks its input (TypeError) and is tested in scripts/vendor/bigint-buffer/test.js. Used only by the Anchor test tooling (@solana/spl-token -> @solana/buffer-layout-utils), never shipped. |
| 71 | slither / arbitrary-send-eth <br>`cb31352524b9` | `network/AgentPolicyWallet.sol:601` | **false-positive** | _run is the wallet's execution path, reached only from the onlyAgent/onlyOwner execute functions: `to` and `value` pass _classify first (allow-listed recipient/target, allow-listed selector, transfer-like selectors refused) and the per-token spending cap in _run itself. Sending value to a chosen address is the wallet's purpose, inside the owner's policy. |
| 72 | slither / arbitrary-send-eth <br>`73db96ca6d23` | `network/AgentRegistry.sol:403` | **false-positive** | _pay recipients are only: the claimant stored by fileClaim, the operator stored by register, or the victim named by the agent's own checker (a STATICCALL, recorded for the action); amounts are the claim deposit or the slashed bond (capped at the bond, subtracted before the call). |
| 73 | slither / arbitrary-send-eth <br>`0ec044eea415` | `network/ThreatReports.sol:141` | **false-positive** | _pay recipients are only communityFund (governance-set, non-zero) and msg.sender in claim() after the voter check; amounts are the report fee or its per-voter share, accounted before the call. |
| 74 | slither / arbitrary-send-eth <br>`779f0ca40dd5` | `network/ZetaphyOfflineOrders.sol:237` | **false-positive** | _sendNative pays only o.maker (the EIP-712 signer of the order, recovered and checked in _fill) and msg.sender (the relayer fee the maker signed); fill/fillWithPermit are nonReentrant and the order nonce is used before any transfer. |

## Earlier: notes on the first run (2026-10-30, commit d07b980)

_Superseded for the open Highs by the decisions above; kept for the record._

Hand-written notes from reading the code behind the High findings of the first
fast-tier run (Solidity and the Go chain patches). The 123 High findings verified as false positives are in
`triage.yml`, each with its reason (marked "owner to confirm"). These are the
**73 still open**, grouped, with what reading the code suggests. They are leads for
the owner's triage, not decisions: nothing here changes a status.

| Group (count) | Where | Reading of the code | Suggested |
|---|---|---|---|
| aderyn `reentrancy-state-change` (42) | NeuroAttest, ThreatReports, HumanAgentLabels, ZetaphyOracle, DLMM factory/pair/router, BridgeAirlock, … | Almost all are **view** calls into our own registries (`registry.entries`, `labels.labelOf`, `jobs.getJob`, `control.roster`, `pair.token0`) set by governance or immutable, followed by state writes. Exploitable only if that registry is malicious. ZetaphyQuests (state written before the transfer) was a clear false positive and is triaged. | Mostly false-positive; check each callee is ours and not user-supplied. |
| aderyn `eth-send-unchecked-address` (21) | `withdraw()`s, HackInsurance, ThreatReports, RewardVault, NeuroOracle refunds, … | The ones read so far pay `msg.sender` from its own credit, or a recipient stored in state. | Likely false-positive per function; confirm each pays only its own/recorded address. |
| slither `arbitrary-send-eth` (4) | AgentPolicyWallet `_run`, AgentRegistry `_pay`, ThreatReports `_pay`, ZetaphyOfflineOrders `_sendNative` | Wallet execution authorised by the owner / payouts of recorded amounts; not fully traced. | Trace each caller's authorisation, then triage. |
| aderyn `contract-locks-ether` (2) | `LockBox` (BridgeAirlock.sol), `HyperlaneLockBox` (HyperlaneLane.sol) | Real in the literal sense: native coin locked there can never leave. By design and documented in both contracts ("no refund path": a vetoed or held transfer stays locked). | accepted-risk, if the owner agrees; users should be told before the bridge holds value. |
| slither `weak-prng` + aderyn `weak-randomness` (2) | NeuroJobs `_eligible` / `j.seed` | Runner selection uses a seed from the request plus a future-block lottery, with a fallback the code itself calls "as predictable as the request". A block proposer can bias it. | accepted-risk (documented trade-off) or a stronger randomness source (the chain's own randomness precompile). |
| aderyn `unsafe-casting` (2) | NeuroScore `int64(score)` | `score = a*z/scale + b` from a governance-activated model can exceed int64 for extreme parameters; the stored score would then be truncated while the returned one is not. Needs an odd model approved by governance. | Low real risk; a bound check in `_validate` / `_score` would close it. |

Other observations while verifying (not tool findings):

- **IntentExecutor**: `_call` forbids the `transferFrom`/`approve`/`permit`/
  `setApprovalForAll`/`increaseAllowance` selectors and the `tokenIn` target, but a
  signer chooses the targets. Allowance-moving functions under other selectors
  (`safeTransferFrom` of ERC-721/1155, DAI-style `move`/`pull`) are not blocked; they
  matter only if users give IntentExecutor approvals on such tokens. Worth a look.
  **Resolved (3867da9):** `_call` now refuses approve and the whole transfer-like list
  (`_transferLike`, the same list as AgentPolicyWallet: ERC-721/1155 `safeTransferFrom` /
  batch, ERC-777 `send`/`operatorSend`/`authorizeOperator`, ERC-677/1363 `*AndCall`, DAI
  `move`/`pull`/`push`/`permit`, Permit2 `permit`/`approve`/`transferFrom`, `burn*`);
  `test/intents.test.js` checks them.
- **Chain gosec in CI**: `security.yml` runs `gosec ./evmd` from the root module, but
  `evmd` is its own Go module; run that way here, gosec exited 0 with no findings,
  while running it inside `evmd/` (as `tools/go-scan.sh` does) reports 22 issues
  (19 G115, now triaged: `#nosec` comments that gosec does not attach to multi-line
  statements). The CI step may not be scanning `evmd` at all; worth checking.
  **Resolved (a543082):** confirmed: from the root module, `./evmd` is outside the module and
  gosec loads nothing there. `security.yml` now runs gosec inside `evmd/` (the app package,
  `./cmd/evmd/cmd`, `./config`, as `tools/go-scan.sh`), lists every issue in the job summary and
  fails on any non-G115 issue in a ZETAPHY file (`zetaphy_*.go`). The 22 issues of that run: the
  19 G115 on ZETAPHY lines, all triaged false-positive in `triage.yml` (owner to confirm; the
  author's `#nosec G115` is not attached to multi-line statements by gosec 2.22.8):
  `evmd/zetaphy_guard.go:230`, `evmd/zetaphy_immune.go:558`, `evmd/zetaphy_immune.go:574`, `evmd/zetaphy_immune.go:596`, `evmd/zetaphy_immune.go:638`, `evmd/zetaphy_modelat.go:140`, `evmd/zetaphy_pqcall.go:264`, `evmd/zetaphy_pqcall.go:276`, `evmd/zetaphy_pqcert.go:113`, `evmd/zetaphy_pqcert.go:139`, `evmd/zetaphy_pqcert.go:173`, `evmd/zetaphy_pqcert.go:203`, `evmd/zetaphy_pqguard.go:72`, `evmd/zetaphy_pqguard.go:295`, `evmd/zetaphy_qday.go:90`, `evmd/zetaphy_qday.go:244`, `evmd/zetaphy_random.go:86`, `evmd/zetaphy_random.go:102`, `evmd/zetaphy_threatgate.go:128`;
  the other 3 are on upstream evmd lines that the ZETAPHY patches did not add (report.js keeps
  only patched lines, so they never reached the report, and this sandbox has neither the patched
  source nor the room to rebuild it: the first CI run of the new step lists them in its summary;
  they do not fail it). No Go code was changed.
- **Mutation sample** (ZetaphyPair, 12 mutants): 5 survived. No test notices removing
  the uint112 overflow check in `_update`, the `MINIMUM_LIQUIDITY` and zero-liquidity
  checks in `mint`, or deleting `balance0 = _balance(_token0)` in `burn`.
