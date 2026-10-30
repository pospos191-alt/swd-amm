# Review notes on the first run (2026-10-30, commit d07b980)

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
- **Chain gosec in CI**: `security.yml` runs `gosec ./evmd` from the root module, but
  `evmd` is its own Go module; run that way here, gosec exited 0 with no findings,
  while running it inside `evmd/` (as `tools/go-scan.sh` does) reports 22 issues
  (19 G115, now triaged: `#nosec` comments that gosec does not attach to multi-line
  statements). The CI step may not be scanning `evmd` at all; worth checking.
- **Mutation sample** (ZetaphyPair, 12 mutants): 5 survived. No test notices removing
  the uint112 overflow check in `_update`, the `MINIMUM_LIQUIDITY` and zero-liquidity
  checks in `mint`, or deleting `balance0 = _balance(_token0)` in `burn`.
