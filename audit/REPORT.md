# ZETAPHY in-house audit report

> Automated audit of commit `d07b9807b605287bc2d74b143bbd65fe58edf958`, fast tier, 2026-10-30T09:01:35Z.
> This is a machine-generated report from free open-source tools and our own scripts. It is **not** an independent audit and does not replace one (see [What this does NOT prove](#what-this-does-not-prove-as-of-2026-10-30)).

## Summary

| Severity | All | Open | Open & new (not in baseline) | Triaged |
|---|---:|---:|---:|---:|
| Critical | 0 | 0 | 0 | 0 |
| High | 196 | 73 | 0 | 123 |
| Medium | 331 | 331 | - | 0 |
| Low | 1272 | 1272 | - | 0 |
| Info | 289 | 289 | - | 0 |

- **Gate (PR tier):** passes: no new untriaged High/Critical finding.
- **Invariant / property suites:** 0 passed, 0 failed, 3 not run.
- **Mutation score:** 58.3% of 12 non-equivalent mutants (1 contract) caught by the tests.
- **Contracts compiled:** 85 audited contracts with code (85 committed artifacts match the source exactly, 0 do not).
- **Run time:** 9 min 14 s.

## Scope

Commit `d07b9807b605287bc2d74b143bbd65fe58edf958` · target `this repository (audit/scope.json)` · compiler 0.8.26+commit.8a97fa7a.Linux.g++

| Project | Files in scope | Code lines (no comments/blank) | Excluded (why) |
|---|---:|---:|---|
| zetaphy-network | 51 | 10994 | `contracts/VulnerableVault.sol`: deliberately vulnerable target of the testnet bug-bounty demo (see its header); never holds value<br>`contracts/MockMailbox.sol`: TEST ONLY stand-in for a Hyperlane Mailbox (see its header)<br>`contracts/VaultTestRecipients.sol`: test-only recipients for RewardVault tests<br>`contracts/TestStable.sol`: worthless testnet faucet stablecoin (see its header) |
| zetaphy-dex | 8 | 1942 | `contracts/test/DexTestHelpers.sol`: test-only helpers<br>`contracts/test/DlmmTestHelpers.sol`: test-only helpers<br>`contracts/TestToken.sol`: testnet-only token with an owner mint (see its header) |
| zetaphy-nft | 6 | 934 | - |
| **Total** | 65 | 13870 | |

Chain code: the ZETAPHY patches in `zetaphy-chain/setup-node.sh`, applied to the pinned Cosmos EVM source; only lines those patches add are reported. JS/TS web apps: covered by CodeQL, not here (their npm dependencies are).

## Methodology

| Step | Tool | Status | Time | Version / note |
|---|---|---|---:|---|
| compile every contract; runtime code hash; committed artifacts = source? | compile | ran | 28s | 0.8.26+commit.8a97fa7a.Linux.g++ |
| static analysis, all ~100 detectors (Trail of Bits) | slither | ran | 111s | 0.11.6 |
| pattern rules from real exploits (Decurity smart-contract rules) | semgrep | ran | 38s | 1.183.0 rules 2e878a8 |
| invariant / property suites: forge (fuzz), halmos (symbolic), medusa / echidna | invariants | ran | 0s | forge Version: 1.2.3-v1.2.3 · passed 0, failed 0, not run 3 |
| our own Neuro scanner on our own bytecode (dogfooding) | neuro | ran | 0s | zetaphy-neuro 14954dd · neuro: 85 contracts read; verdicts {"low":66,"info":3,"high":14,"medium":2} |
| known vulnerabilities in every lockfile (OSV database) | osv-scanner | failed | 32s | 2.7.0 · could not reach the OSV database from this sandbox (api.osv.dev: Forbidden by the proxy); CI can |
| known vulnerabilities in production npm dependencies | npm-audit | ran | 0s | npm 10.9.4 · production dependencies (--omit=dev) |
| static analysis, AST detectors (Cyfrin) | aderyn | ran | 17s | aderyn 0.6.8 |
| formal checks built into solc: assert, overflow, division by zero, bounds | smtchecker | ran | 230s | solc 0.8.26+commit.8a97fa7a.Linux.g++ · 4 contracts done; 0 not |
| plant small bugs, see if the tests notice (score) | mutation | ran | 188s | audit/tools/mutate.js · sample run by hand: ZetaphyPair.sol only, 12 mutants (the weekly deep run does 5 contracts x 30) |
| chain patches: staticcheck, gosec, govulncheck, go test -race | go | ran | 660s | go1.25.9 · same scripts, run separately (deep): staticcheck 396s; gosec 121s; go test -race 14s; govulncheck could not reach vuln.go.dev from this sandbox |

Severity scale (README.md): **Critical** funds can be stolen or frozen now; **High** a likely path to loss or a broken core guarantee; **Medium** loss under specific conditions, or a guarantee weakened; **Low** best practice / defence in depth; **Info** style, gas, notes. Tools' own levels are mapped to this scale (lib/findings.js); a High-impact detector with low confidence is reported as Medium.

## Findings

Every finding has a stable id (tool:rule:file:hash of the flagged line). To record a decision, add the id to `audit/triage.yml` (see README.md: only people do this).

Hand-written review notes on the open High findings (dated; they may be older than this run): [review-notes.md](review-notes.md).

### Critical (0: 0 open, 0 triaged)

None.

### High (196: 73 open, 123 triaged)

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:90694f24e172`
- where: [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:135`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L135) — `pair = ZetaphyDlmmPairDeployer(pairDeployer).deploy(keccak256(abi.encodePacked(tokenX, tokenY, binStep)), params);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `getPair[tokenX][tokenY][binStep] = pair`, `getPair[tokenY][tokenX][binStep] = pair`, `allPairs.push(pair)`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:a05e81fab0e0`
- where: [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:184`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L184) — `DlmmPairParameters memory p = IDlmmPairDeployer(msg.sender).pairParameters();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `factory = p.factory`, `tokenX = p.tokenX`, `tokenY = p.tokenY`, `binStep = p.binStep`, `baseFeeBps = p.baseFeeBps`, `maxDynamicFeeBps = p.maxDynamicFeeBps`, `variableFeeControl = p.variableFeeControl`, `filterPeriod = p.filterPeriod`, `decayPeriod = p.decayPeriod`, `reductionFactor = p.reductionFactor`, `maxVolatilityAccumulator = p.maxVolatilityAccumulator`, `_state = State({activeId: p.activeId, idReference: p.activeId, volatilityAccumulator: 0, volatilityReference: 0, lastUpdate: uint40(block.timestamp), protocolShareBps: p

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:8769c5ef1b3d`
- where: [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:602`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L602) — `address to = IDlmmFactoryForPair(factory).feeTo();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `protocolFeesX = 0`, `protocolFeesY = 0`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:a5f803434df8`
- where: [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:131`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L131) — `pairCodeHash = IDlmmFactoryR(factory_).PAIR_CODE_HASH();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `pairDeployer = IDlmmFactoryR(factory_).pairDeployer()`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/AgentPolicyWallet.sol:fdd324aa9a3b`
- where: [`zetaphy-network/contracts/AgentPolicyWallet.sol:406`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L406) — `if (address(committee) == address(0) \|\| !committee.isValid(cosignDigest(to, value, data, reportHash, deadline), sigs)) revert BadCosign();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `cosignNonce++`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/AgentPolicyWallet.sol:c4d27826f961`
- where: [`zetaphy-network/contracts/AgentPolicyWallet.sol:425`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L425) — `if (address(committee) == address(0) \|\| !committee.isValidFrost(cosignDigest(to, value, data, reportHash, deadline), sig)) revert BadCosign();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `cosignNonce++`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/AgentRegistry.sol:71496f0f2b20`
- where: [`zetaphy-network/contracts/AgentRegistry.sol:280`](../zetaphy-network/contracts/AgentRegistry.sol#L280) — `(bool violated, address victim, uint256 damage) = IPolicyChecker(act.checker).check(v, constitution, evidence);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `act.slashed = true`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/AgentRegistry.sol:24a8d2ef837d`
- where: [`zetaphy-network/contracts/AgentRegistry.sol:298`](../zetaphy-network/contracts/AgentRegistry.sol#L298) — `function vote(uint256 claimId, bool uphold) external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/AgentRegistry.sol:8f7ed6746973`
- where: [`zetaphy-network/contracts/AgentRegistry.sol:311`](../zetaphy-network/contracts/AgentRegistry.sol#L311) — `function expireClaim(uint256 claimId) external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/BridgeAirlock.sol:44135552b910`
- where: [`zetaphy-network/contracts/BridgeAirlock.sol:408`](../zetaphy-network/contracts/BridgeAirlock.sol#L408) — `if (address(control) != address(0) && control.paused()) revert NeuroPaused();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `votedBy[key][msg.sender] = true`, `uint8 v = ++votes[key]`, `done[key] = true`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/BridgeAirlock.sol:fccfbb9d2469`
- where: [`zetaphy-network/contracts/BridgeAirlock.sol:409`](../zetaphy-network/contracts/BridgeAirlock.sol#L409) — `bytes32 id = airlock.transferId(srcChainId, srcContract, srcNonce, sender, to, amount);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `votedBy[key][msg.sender] = true`, `uint8 v = ++votes[key]`, `done[key] = true`

#### Contract locks Ether without a withdraw function

- id: `aderyn:contract-locks-ether:zetaphy-network/contracts/BridgeAirlock.sol:d68ff4299dbc`
- where: [`zetaphy-network/contracts/BridgeAirlock.sol:438`](../zetaphy-network/contracts/BridgeAirlock.sol#L438) — `contract LockBox {`
- tool: aderyn (contract-locks-ether)
- status: open (known: in baseline, awaiting triage)
- detail: Contract locks Ether without a withdraw function.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/BugBounty.sol:3b50e2ce0378`
- where: [`zetaphy-network/contracts/BugBounty.sol:222`](../zetaphy-network/contracts/BugBounty.sol#L222) — `(, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `attested[fid][msg.sender] = true`, `f.yes++`, `f.no++`, `f.state = State.Accepted`, `f.state = State.Rejected`, `_bounties[f.bounty].reward += f.deposit`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/BugBounty.sol:7a2aeb935365`
- where: [`zetaphy-network/contracts/BugBounty.sol:260`](../zetaphy-network/contracts/BugBounty.sol#L260) — `try issuance.draw(b.subsidy) returns (uint256) {} catch {}`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `owed[f.finder] += amount + f.deposit`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/BugBounty.sol:99f52b427f59`
- where: [`zetaphy-network/contracts/BugBounty.sol:297`](../zetaphy-network/contracts/BugBounty.sol#L297) — `function withdraw() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ComputeMarket.sol:da98dfc4f428`
- where: [`zetaphy-network/contracts/ComputeMarket.sol:76`](../zetaphy-network/contracts/ComputeMarket.sol#L76) — `(, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `t.runner = msg.sender`, `t.status = Status.Taken`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/ComputeMarket.sol:ee45839a615c`
- where: [`zetaphy-network/contracts/ComputeMarket.sol:128`](../zetaphy-network/contracts/ComputeMarket.sol#L128) — `function withdraw() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/DataDAO.sol:a41374451ef7`
- where: [`zetaphy-network/contracts/DataDAO.sol:151`](../zetaphy-network/contracts/DataDAO.sol#L151) — `function claim(uint256 round, address account, uint256 amount, bytes32[] calldata proof) external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/DetectorPool.sol:c136631d98f3`
- where: [`zetaphy-network/contracts/DetectorPool.sol:117`](../zetaphy-network/contracts/DetectorPool.sol#L117) — `if (foresight.modelOwner(modelId) != msg.sender) revert NotModelOwner();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `_orgs.push(Organism(msg.sender, parent, 0, 0, 0, true, false, uint64(block.timestamp), uint128(msg.value), modelId, specHash, n, sum, 0, uri))`, `organismOfModel[modelId] = id`, `aliveIds.push(id)`, `totalStake += msg.value`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/DetectorPool.sol:d886404a1939`
- where: [`zetaphy-network/contracts/DetectorPool.sol:120`](../zetaphy-network/contracts/DetectorPool.sol#L120) — `(uint32 n,, uint64 sum) = foresight.tracks(modelId);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `_orgs.push(Organism(msg.sender, parent, 0, 0, 0, true, false, uint64(block.timestamp), uint128(msg.value), modelId, specHash, n, sum, 0, uri))`, `organismOfModel[modelId] = id`, `aliveIds.push(id)`, `totalStake += msg.value`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/DetectorPool.sol:a2d7aad084d2`
- where: [`zetaphy-network/contracts/DetectorPool.sol:228`](../zetaphy-network/contracts/DetectorPool.sol#L228) — `function withdraw() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/HackInsurance.sol:3e51299f8f84`
- where: [`zetaphy-network/contracts/HackInsurance.sol:172`](../zetaphy-network/contracts/HackInsurance.sol#L172) — `function withdraw() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/HackInsurance.sol:48e465db72cd`
- where: [`zetaphy-network/contracts/HackInsurance.sol:191`](../zetaphy-network/contracts/HackInsurance.sol#L191) — `function buyCover(bytes32 target, uint128 amount, uint64 duration) external payable returns (uint256 id) {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/HackInsurance.sol:7813ea08ae90`
- where: [`zetaphy-network/contracts/HackInsurance.sol:270`](../zetaphy-network/contracts/HackInsurance.sol#L270) — `function expire(uint256 id) external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/HumanAgentLabels.sol:bb6c35f65a54`
- where: [`zetaphy-network/contracts/HumanAgentLabels.sol:371`](../zetaphy-network/contracts/HumanAgentLabels.sol#L371) — `if (labels.labelOf(who) != 1) revert NotPasskeyHuman(who);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `vouchCredential[msg.sender][who] = cred`, `vouchersOf_[who].push(msg.sender)`, `me.activeGiven++`, `me.lastVouchAt = uint64(block.timestamp)`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/HumanAgentLabels.sol:1533ef55e154`
- where: [`zetaphy-network/contracts/HumanAgentLabels.sol:375`](../zetaphy-network/contracts/HumanAgentLabels.sol#L375) — `(, , bytes32 cred,) = labels.humans(who);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `vouchCredential[msg.sender][who] = cred`, `vouchersOf_[who].push(msg.sender)`, `me.activeGiven++`, `me.lastVouchAt = uint64(block.timestamp)`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/HumanAgentLabels.sol:4524c31345e1`
- where: [`zetaphy-network/contracts/HumanAgentLabels.sol:393`](../zetaphy-network/contracts/HumanAgentLabels.sol#L393) — `bool unique = labels.labelOf(a) == 1 && !p.banned && (p.genesis \|\| n >= vouchesNeeded);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `p.uniqueSince = uint64(block.timestamp)`, `p.uniqueSince = 0`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/HumanAgentLabels.sol:3316bf660feb`
- where: [`zetaphy-network/contracts/HumanAgentLabels.sol:553`](../zetaphy-network/contracts/HumanAgentLabels.sol#L553) — `uint8 label = labels.labelOf(msg.sender);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `lastDrip[msg.sender] = block.timestamp`, `lastDripCredential[cred] = block.timestamp`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/HumanAgentLabels.sol:1a4a6be2c98c`
- where: [`zetaphy-network/contracts/HumanAgentLabels.sol:559`](../zetaphy-network/contracts/HumanAgentLabels.sol#L559) — `(,, bytes32 cred,) = labels.humans(msg.sender);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `lastDripCredential[cred] = block.timestamp`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/HumanAgentLabels.sol:2075a0403a54`
- where: [`zetaphy-network/contracts/HumanAgentLabels.sol:613`](../zetaphy-network/contracts/HumanAgentLabels.sol#L613) — `label = labels.labelOf(trader);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `usedInWindow[trader] = used`, `windowStart[trader] = block.timestamp`, `usedInWindow[trader] = 0`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/HyperlaneLane.sol:4417665c3c47`
- where: [`zetaphy-network/contracts/HyperlaneLane.sol:121`](../zetaphy-network/contracts/HyperlaneLane.sol#L121) — `bytes32 id = airlock.transferId(chain, src, nonce, from, to, amount);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `delivered[id] = true`

#### Contract locks Ether without a withdraw function

- id: `aderyn:contract-locks-ether:zetaphy-network/contracts/HyperlaneLane.sol:8d254d24e64c`
- where: [`zetaphy-network/contracts/HyperlaneLane.sol:149`](../zetaphy-network/contracts/HyperlaneLane.sol#L149) — `contract HyperlaneLockBox {`
- tool: aderyn (contract-locks-ether)
- status: open (known: in baseline, awaiting triage)
- detail: Contract locks Ether without a withdraw function.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/NeuroAttest.sol:8754a20c991f`
- where: [`zetaphy-network/contracts/NeuroAttest.sol:93`](../zetaphy-network/contracts/NeuroAttest.sol#L93) — `(, , , bool settled) = jobs.assurance(jobId);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `jobUsed[jobId] = true`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/NeuroAttest.sol:2b15d737e4a5`
- where: [`zetaphy-network/contracts/NeuroAttest.sol:95`](../zetaphy-network/contracts/NeuroAttest.sol#L95) — `(, , , bytes32 chain, string memory target, , bytes32 result, , , ) = jobs.getJob(jobId);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `jobUsed[jobId] = true`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/NeuroAttest.sol:62ad0686eab9`
- where: [`zetaphy-network/contracts/NeuroAttest.sol:97`](../zetaphy-network/contracts/NeuroAttest.sol#L97) — `(bytes32 skill, , , , ) = jobs.jobInfo(jobId);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `jobUsed[jobId] = true`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/NeuroJobs.sol:6bb46df40e5a`
- where: [`zetaphy-network/contracts/NeuroJobs.sol:819`](../zetaphy-network/contracts/NeuroJobs.sol#L819) — `function withdraw() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Weak Randomness

- id: `aderyn:weak-randomness:zetaphy-network/contracts/NeuroJobs.sol:6e5cf1246faa`
- where: [`zetaphy-network/contracts/NeuroJobs.sol:856`](../zetaphy-network/contracts/NeuroJobs.sol#L856) — `j.seed = keccak256(abi.encode(requester, chain, target, block.timestamp, requestCount[requester]++));`
- tool: aderyn (weak-randomness)
- status: open (known: in baseline, awaiting triage)
- detail: Weak Randomness.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/NeuroJobs.sol:bd0b6673df32`
- where: [`zetaphy-network/contracts/NeuroJobs.sol:1094`](../zetaphy-network/contracts/NeuroJobs.sol#L1094) — `uint256 cap = control.maxRegrowPerHour();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `defender[i] = cand`, `regrownThisHour += 1`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/NeuroJobs.sol:2de7e3e7c899`
- where: [`zetaphy-network/contracts/NeuroJobs.sol:1095`](../zetaphy-network/contracts/NeuroJobs.sol#L1095) — `address[] memory r = control.roster();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `defender[i] = cand`, `regrownThisHour += 1`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/NeuroOracle.sol:1caaf8480004`
- where: [`zetaphy-network/contracts/NeuroOracle.sol:215`](../zetaphy-network/contracts/NeuroOracle.sol#L215) — `function push(uint32 domain, bytes32[] calldata keys) external payable returns (bytes32 id) {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Unsafe Casting of integers

- id: `aderyn:unsafe-casting:zetaphy-network/contracts/NeuroScore.sol:4e47b7e79173`
- where: [`zetaphy-network/contracts/NeuroScore.sol:188`](../zetaphy-network/contracts/NeuroScore.sol#L188) — `_scores[token] = Score(int64(score), v, level, uint64(block.timestamp), fh);`
- tool: aderyn (unsafe-casting)
- status: open (known: in baseline, awaiting triage)
- detail: Unsafe Casting of integers.

#### Unsafe Casting of integers

- id: `aderyn:unsafe-casting:zetaphy-network/contracts/NeuroScore.sol:17b11df7e29a`
- where: [`zetaphy-network/contracts/NeuroScore.sol:189`](../zetaphy-network/contracts/NeuroScore.sol#L189) — `emit Scored(token, v, int64(score), level, fh, features);`
- tool: aderyn (unsafe-casting)
- status: open (known: in baseline, awaiting triage)
- detail: Unsafe Casting of integers.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/RedBlueArena.sol:b3b22c324606`
- where: [`zetaphy-network/contracts/RedBlueArena.sol:212`](../zetaphy-network/contracts/RedBlueArena.sol#L212) — `function withdrawBond() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/RedBlueArena.sol:89756e82c0f6`
- where: [`zetaphy-network/contracts/RedBlueArena.sol:497`](../zetaphy-network/contracts/RedBlueArena.sol#L497) — `function withdraw() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/RewardVault.sol:09024c8ab54d`
- where: [`zetaphy-network/contracts/RewardVault.sol:79`](../zetaphy-network/contracts/RewardVault.sol#L79) — `function release() public returns (uint256 amount) {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/RewardVault.sol:9ee49ec2404b`
- where: [`zetaphy-network/contracts/RewardVault.sol:127`](../zetaphy-network/contracts/RewardVault.sol#L127) — `function applyShares() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/RiskForecasts.sol:065a092e6e42`
- where: [`zetaphy-network/contracts/RiskForecasts.sol:195`](../zetaphy-network/contracts/RiskForecasts.sol#L195) — `if (s.foresightId != 0 && nowT < q.closeAt) foresight.closeCommits(s.foresightId);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `s.confirmed = true`, `q.closeAt = nowT`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/RiskForecasts.sol:7e27372cfe7b`
- where: [`zetaphy-network/contracts/RiskForecasts.sol:280`](../zetaphy-network/contracts/RiskForecasts.sol#L280) — `function withdraw() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/ThreatRegistry.sol:8ba55f9bdcb9`
- where: [`zetaphy-network/contracts/ThreatRegistry.sol:701`](../zetaphy-network/contracts/ThreatRegistry.sol#L701) — `function withdraw() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ThreatReports.sol:b98279c34116`
- where: [`zetaphy-network/contracts/ThreatReports.sol:96`](../zetaphy-network/contracts/ThreatReports.sol#L96) — `(bool flagged, , , , , , , ) = registry.entries(key);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `reports.push(Report(key, chainKey, target, msg.sender, uint64(block.timestamp), 0, 0, uint128(msg.value), 0, 0))`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/ThreatReports.sol:cf43cca96e36`
- where: [`zetaphy-network/contracts/ThreatReports.sol:105`](../zetaphy-network/contracts/ThreatReports.sol#L105) — `function settle(uint256 id) external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ThreatReports.sol:6e0a74e63019`
- where: [`zetaphy-network/contracts/ThreatReports.sol:108`](../zetaphy-network/contracts/ThreatReports.sol#L108) — `(bool flagged, , uint64 updatedAt, uint32 round, , , , ) = registry.entries(r.key);`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `r.state = 1`, `r.flagRound = round - 1`, `r.share = uint128(r.fee / q)`, `r.state = 2`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ThreatReports.sol:9ca6b87cd9a9`
- where: [`zetaphy-network/contracts/ThreatReports.sol:110`](../zetaphy-network/contracts/ThreatReports.sol#L110) — `uint256 q = registry.quorum();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `r.state = 1`, `r.flagRound = round - 1`, `r.share = uint128(r.fee / q)`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/ThreatReports.sol:deac0b0c8e00`
- where: [`zetaphy-network/contracts/ThreatReports.sol:125`](../zetaphy-network/contracts/ThreatReports.sol#L125) — `function claim(uint256 id) external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ThreatReports.sol:5c0e6b3d4a40`
- where: [`zetaphy-network/contracts/ThreatReports.sol:129`](../zetaphy-network/contracts/ThreatReports.sol#L129) — `if (!registry.voted(r.key, r.flagRound, msg.sender)) revert NotVoter();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `r.claims += 1`, `claimed[id][msg.sender] = true`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ThreatReports.sol:b6f5936e67b2`
- where: [`zetaphy-network/contracts/ThreatReports.sol:130`](../zetaphy-network/contracts/ThreatReports.sol#L130) — `if (r.claims >= registry.quorum()) revert AlreadySettled(); // never more than the fee`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `r.claims += 1`, `claimed[id][msg.sender] = true`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/UsefulIssuance.sol:fd1f9bc87c9e`
- where: [`zetaphy-network/contracts/UsefulIssuance.sol:111`](../zetaphy-network/contracts/UsefulIssuance.sol#L111) — `function sweepOverflow() external returns (uint256 amount) {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/UsefulIssuance.sol:0f4b07f15a88`
- where: [`zetaphy-network/contracts/UsefulIssuance.sol:115`](../zetaphy-network/contracts/UsefulIssuance.sol#L115) — `(bool ok, ) = overflow.call{value: amount}("");`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `pendingOverflow = amount`

#### ETH transferred without address checks

- id: `aderyn:eth-send-unchecked-address:zetaphy-network/contracts/UsefulWork.sol:a2ae25d4261d`
- where: [`zetaphy-network/contracts/UsefulWork.sol:374`](../zetaphy-network/contracts/UsefulWork.sol#L374) — `function withdraw() external {`
- tool: aderyn (eth-send-unchecked-address)
- status: open (known: in baseline, awaiting triage)
- detail: ETH transferred without address checks.

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/WorkerReputation.sol:74f77558f70a`
- where: [`zetaphy-network/contracts/WorkerReputation.sol:126`](../zetaphy-network/contracts/WorkerReputation.sol#L126) — `if (address(identity) == address(0) \|\| identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `workerOfAgent[agentId] = msg.sender`, `agentOfWorker[msg.sender] = agentId`, `delete workerOfAgent[old]`, `delete agentOfWorker[prev]`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ZetaphyEarlyFarm.sol:ffb2067e19f9`
- where: [`zetaphy-network/contracts/ZetaphyEarlyFarm.sol:115`](../zetaphy-network/contracts/ZetaphyEarlyFarm.sol#L115) — `if (rewardsToken.balanceOf(address(this)) < streamed + total) revert Underfunded();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `rewardRate = total / duration`, `owed = streamed + rewardRate * duration`, `lastUpdate = block.timestamp`, `periodFinish = block.timestamp + duration`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ZetaphyEarlyPass.sol:25ec15001519`
- where: [`zetaphy-network/contracts/ZetaphyEarlyPass.sol:62`](../zetaphy-network/contracts/ZetaphyEarlyPass.sol#L62) — `if (block.timestamp < earlyUntil && zearly.balanceOf(msg.sender) < minHold) revert EarlyHoldersOnly();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `minted[msg.sender] = true`, `id = ++totalSupply`, `_owner[id] = msg.sender`, `balanceOf[msg.sender] += 1`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ZetaphyEarlyPass.sol:7b246722d74e`
- where: [`zetaphy-network/contracts/ZetaphyEarlyPass.sol:65`](../zetaphy-network/contracts/ZetaphyEarlyPass.sol#L65) — `if (price != 0 && !zearly.transferFrom(msg.sender, BURN, price)) revert PaymentFailed();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `_owner[id] = msg.sender`, `balanceOf[msg.sender] += 1`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ZetaphyEarlyPolls.sol:e315b91c5c79`
- where: [`zetaphy-network/contracts/ZetaphyEarlyPolls.sol:54`](../zetaphy-network/contracts/ZetaphyEarlyPolls.sol#L54) — `if (deposit != 0 && !token.transferFrom(msg.sender, address(this), deposit)) revert TransferFailed();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `Poll storage p = polls.push()`, `p.creator = msg.sender`, `p.end = uint64(block.timestamp) + duration`, `p.question = question`, `p.options.push(options[i])`, `p.tally.push(0)`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ZetaphyOracle.sol:17b0ee330e5b`
- where: [`zetaphy-network/contracts/ZetaphyOracle.sol:179`](../zetaphy-network/contracts/ZetaphyOracle.sol#L179) — `address t0 = IPairTokens(pair).token0();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `twapOf[asset] = c`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ZetaphyOracle.sol:fb12769dd4a8`
- where: [`zetaphy-network/contracts/ZetaphyOracle.sol:180`](../zetaphy-network/contracts/ZetaphyOracle.sol#L180) — `address t1 = IPairTokens(pair).token1();`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `twapOf[asset] = c`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ZetaphyOracle.sol:ebc0f2e7dfd4`
- where: [`zetaphy-network/contracts/ZetaphyOracle.sol:183`](../zetaphy-network/contracts/ZetaphyOracle.sol#L183) — `c = TwapConfig(pair, asset == t0, IDecimals(asset).decimals(), IDecimals(asset == t0 ? t1 : t0).decimals(),`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `twapOf[asset] = c`

#### Reentrancy: State change after external call

- id: `aderyn:reentrancy-state-change:zetaphy-network/contracts/ZetaphyOracle.sol:045d8518076e`
- where: [`zetaphy-network/contracts/ZetaphyOracle.sol:263`](../zetaphy-network/contracts/ZetaphyOracle.sol#L263) — `if (pair != address(0)) { try recorder.record(pair) {} catch {} }`
- tool: aderyn (reentrancy-state-change)
- status: open (known: in baseline, awaiting triage)
- detail: Reentrancy: State change after external call. State is changed at: `s.lastPrice = uint128(value)`, `s.lastAt = uint64(at)`, `s.windowPrice = uint128(value)`, `s.windowStart = uint64(block.timestamp)`, `s.windowPrice = s.lastPrice`, `s.windowStart = uint64(block.timestamp)`, `s.tripped = true`

#### arbitrary-send-eth

- id: `slither:arbitrary-send-eth:zetaphy-network/contracts/AgentPolicyWallet.sol:cb31352524b9`
- where: [`zetaphy-network/contracts/AgentPolicyWallet.sol:550`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L550) — `function _run(address to, uint256 value, bytes calldata data, address token, uint256 amount, bytes32 modelHash, bytes32 promptHash, uint8 path)`
- tool: slither (arbitrary-send-eth, confidence medium)
- status: open (known: in baseline, awaiting triage)
- detail: AgentPolicyWallet._run(address,uint256,bytes,address,uint256,bytes32,bytes32,uint8) (contracts/AgentPolicyWallet.sol#550-568) sends eth to arbitrary user Dangerous calls: - (ok,ret) = to.call{value: value}(data) (contracts/AgentPolicyWallet.sol#565)

#### arbitrary-send-eth

- id: `slither:arbitrary-send-eth:zetaphy-network/contracts/AgentRegistry.sol:73db96ca6d23`
- where: [`zetaphy-network/contracts/AgentRegistry.sol:388`](../zetaphy-network/contracts/AgentRegistry.sol#L388) — `function _pay(address to, uint256 amount) private {`
- tool: slither (arbitrary-send-eth, confidence medium)
- status: open (known: in baseline, awaiting triage)
- detail: AgentRegistry._pay(address,uint256) (contracts/AgentRegistry.sol#388-392) sends eth to arbitrary user Dangerous calls: - (ok,None) = to.call{value: amount}() (contracts/AgentRegistry.sol#390)

#### weak-prng

- id: `slither:weak-prng:zetaphy-network/contracts/NeuroJobs.sol:7bcac6f4961b`
- where: [`zetaphy-network/contracts/NeuroJobs.sol:295`](../zetaphy-network/contracts/NeuroJobs.sol#L295) — `function _eligible(uint256 id, Round storage r, address w, uint8 round) internal view returns (bool, bool) {`
- tool: slither (weak-prng, confidence medium)
- status: open (known: in baseline, awaiting triage)
- detail: NeuroJobsBase._eligible(uint256,NeuroJobsBase.Round,address,uint8) (contracts/NeuroJobs.sol#295-319) uses a weak PRNG: "x2 = uint256(keccak256(bytes)(abi.encode(_rand(j.seed,r,round),w))) % 1e18 (contracts/NeuroJobs.sol#317)"

#### arbitrary-send-eth

- id: `slither:arbitrary-send-eth:zetaphy-network/contracts/ThreatReports.sol:0ec044eea415`
- where: [`zetaphy-network/contracts/ThreatReports.sol:141`](../zetaphy-network/contracts/ThreatReports.sol#L141) — `function _pay(address to, uint256 amount) private {`
- tool: slither (arbitrary-send-eth, confidence medium)
- status: open (known: in baseline, awaiting triage)
- detail: ThreatReports._pay(address,uint256) (contracts/ThreatReports.sol#141-145) sends eth to arbitrary user Dangerous calls: - (ok,None) = to.call{value: amount}() (contracts/ThreatReports.sol#143)

#### arbitrary-send-eth

- id: `slither:arbitrary-send-eth:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:779f0ca40dd5`
- where: [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:237`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L237) — `function _sendNative(address to, uint256 amount) private {`
- tool: slither (arbitrary-send-eth, confidence medium)
- status: open (known: in baseline, awaiting triage)
- detail: ZetaphyOfflineOrders._sendNative(address,uint256) (contracts/ZetaphyOfflineOrders.sol#237-240) sends eth to arbitrary user Dangerous calls: - (ok,None) = to.call{value: amount}() (contracts/ZetaphyOfflineOrders.sol#238)

<details><summary>123 triaged high finding(s)</summary>

| Where | Tool / rule | Decision |
|---|---|---|
| [`zetaphy-dex/contracts/dlmm/DlmmMath.sol:131`](../zetaphy-dex/contracts/dlmm/DlmmMath.sol#L131) | aderyn / incorrect-caret-operator | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): intentional XOR, not exponentiation: this is the 512-bit mulDiv (Remco Bloemen / Uniswap FullMath). (3*d)^2 seeds the Newton iteration for the inverse of the odd d mod 2^256 with 4 correct bits; the six "inv *= 2 - d * inv" steps that follow double that to 256. <br>`aderyn:incorrect-caret-operator:zetaphy-dex/contracts/dlmm/DlmmMath.sol:3f59e3ab82c8` |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:375`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L375) | aderyn / unsafe-casting | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): `out` comes from _binSwap, which returns at most binOut (the bin's uint128 reserve) and reverts if out >= binOut on the partial path; the subtraction is checked arithmetic anyway. <br>`aderyn:unsafe-casting:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:30a395f5832a` |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:378`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L378) | aderyn / unsafe-casting | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): `out` comes from _binSwap, which returns at most binOut (the bin's uint128 reserve) and reverts if out >= binOut on the partial path; the subtraction is checked arithmetic anyway. <br>`aderyn:unsafe-casting:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:82843ee8f22d` |
| [`zetaphy-dex/contracts/WZETAPHY.sol:36`](../zetaphy-dex/contracts/WZETAPHY.sol#L36) | aderyn / eth-send-unchecked-address | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): withdraw() burns the caller's own WZETAPHY balance (checked arithmetic) and sends the same amount to msg.sender. <br>`aderyn:eth-send-unchecked-address:zetaphy-dex/contracts/WZETAPHY.sol:1ab53a06be60` |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:167`](../zetaphy-dex/contracts/ZetaphyPair.sol#L167) | aderyn / weak-randomness | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block.timestamp % 2**32 is the Uniswap V2 TWAP timestamp (wraps by design), not randomness. <br>`aderyn:weak-randomness:zetaphy-dex/contracts/ZetaphyPair.sol:7248a7a7744f` |
| [`zetaphy-network/contracts/AgentPolicyWallet.sol:51`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L51) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): RFC 9380 expand_message_xmd / RFC 9591 FROST challenge: the byte layout is fixed by the standards (fixed-width fields around one message, DST suffixed with its length), it must be packed exactly like this to interoperate. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/AgentPolicyWallet.sol:2f84fab07ccc` |
| [`zetaphy-network/contracts/AgentPolicyWallet.sol:60`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L60) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): RFC 9380 expand_message_xmd / RFC 9591 FROST challenge: the byte layout is fixed by the standards (fixed-width fields around one message, DST suffixed with its length), it must be packed exactly like this to interoperate. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/AgentPolicyWallet.sol:20b5033cc2ca` |
| [`zetaphy-network/contracts/AgentPolicyWallet.sol:450`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L450) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): input of the ML-DSA precompile (1 variant byte, 32-byte message, key, signature). The key must hash to the stored pqKeyHash (checked just before), so its length is fixed, and the precompile splits key and signature by the variant's fixed sizes; no two inputs can be confused. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/AgentPolicyWallet.sol:1051b8e85ee5` |
| [`zetaphy-network/contracts/AgentRegistry.sol:251`](../zetaphy-network/contracts/AgentRegistry.sol#L251) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): input of the ML-DSA precompile (1 variant byte, 32-byte message, key, signature). The key must hash to the stored pqKeyHash (checked just before), so its length is fixed, and the precompile splits key and signature by the variant's fixed sizes; no two inputs can be confused. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/AgentRegistry.sol:9157f2cf1eb8` |
| [`zetaphy-network/contracts/BridgeGuard.sol:353`](../zetaphy-network/contracts/BridgeGuard.sol#L353) | aderyn / unsafe-casting | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): _use() already reverted unless used + amount <= _limit(r), and _limit returns a uint128, so amount fits in uint128. <br>`aderyn:unsafe-casting:zetaphy-network/contracts/BridgeGuard.sol:f7604e43a592` |
| [`zetaphy-network/contracts/BridgeGuard.sol:394`](../zetaphy-network/contracts/BridgeGuard.sol#L394) | aderyn / unsafe-casting | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): _use() already reverted unless used + amount <= _limit(r), and _limit returns a uint128, so amount fits in uint128. <br>`aderyn:unsafe-casting:zetaphy-network/contracts/BridgeGuard.sol:3c93e5498278` |
| [`zetaphy-network/contracts/DetectorPool.sol:202`](../zetaphy-network/contracts/DetectorPool.sol#L202) | aderyn / unsafe-casting | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): cut = stake * slashBps / BPS with stake a uint128 and slashBps <= BPS, so cut <= stake fits in uint128. <br>`aderyn:unsafe-casting:zetaphy-network/contracts/DetectorPool.sol:5472502779b9` |
| [`zetaphy-network/contracts/ForesightRegistry.sol:200`](../zetaphy-network/contracts/ForesightRegistry.sol#L200) | aderyn / unsafe-casting | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): brier <= MAX_LOSS = ONE * ONE = 1e8 (p is basis points, ONE = 10_000), far below 2^64. <br>`aderyn:unsafe-casting:zetaphy-network/contracts/ForesightRegistry.sol:7d5c7d72d961` |
| [`zetaphy-network/contracts/HackInsurance.sol:330`](../zetaphy-network/contracts/HackInsurance.sol#L330) | aderyn / eth-send-unchecked-address | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): payout(id) pays the claimant recorded on an Approved claim after the dispute window, once (state set to Paid before sending). <br>`aderyn:eth-send-unchecked-address:zetaphy-network/contracts/HackInsurance.sol:eff01a1d1256` |
| [`zetaphy-network/contracts/HumanAgentLabels.sol:552`](../zetaphy-network/contracts/HumanAgentLabels.sol#L552) | aderyn / eth-send-unchecked-address | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): drip() pays msg.sender the amount for its own label, rate-limited per account and per credential, state written before the call. <br>`aderyn:eth-send-unchecked-address:zetaphy-network/contracts/HumanAgentLabels.sol:f18a77547d41` |
| [`zetaphy-network/contracts/HyperlaneLane.sol:54`](../zetaphy-network/contracts/HyperlaneLane.sol#L54) | aderyn / contract-locks-ether | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): the only payable functions (IMessageRecipient.handle / Pyth updatePriceFeeds, payable because the interface says so) revert when msg.value != 0, so no ether can enter. <br>`aderyn:contract-locks-ether:zetaphy-network/contracts/HyperlaneLane.sol:876eebe6c3d7` |
| [`zetaphy-network/contracts/HyperlaneLockBoxV2.sol:224`](../zetaphy-network/contracts/HyperlaneLockBoxV2.sol#L224) | aderyn / eth-send-unchecked-address | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): claim(id) pays the recipient recorded for that release (r.to), once, after its delay, within the daily limit and the locked backing; anyone may trigger it, the money can only go to r.to. <br>`aderyn:eth-send-unchecked-address:zetaphy-network/contracts/HyperlaneLockBoxV2.sol:825d4067ce4a` |
| [`zetaphy-network/contracts/IntentExecutor.sol:371`](../zetaphy-network/contracts/IntentExecutor.sol#L371) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): input of the ML-DSA precompile (1 variant byte, 32-byte message, key, signature). The key must hash to the stored pqKeyHash (checked just before), so its length is fixed, and the precompile splits key and signature by the variant's fixed sizes; no two inputs can be confused. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/IntentExecutor.sol:3a6d0fdcae1b` |
| [`zetaphy-network/contracts/ModelRegistry.sol:95`](../zetaphy-network/contracts/ModelRegistry.sol#L95) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): only one dynamic argument (name), last, after a constant string and a uint8: the packing is unambiguous. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/ModelRegistry.sol:acd91d26214d` |
| [`zetaphy-network/contracts/NeuroIdentity.sol:4`](../zetaphy-network/contracts/NeuroIdentity.sol#L4) | aderyn / reused-contract-name | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): both files declare the identical one-function ERC-721 receiver interface (same signature); they never end up in one contract, so the duplicate name changes no behaviour. <br>`aderyn:reused-contract-name:zetaphy-network/contracts/NeuroIdentity.sol:37669c344db5` |
| [`zetaphy-network/contracts/NeuroJobs.sol:468`](../zetaphy-network/contracts/NeuroJobs.sol#L468) | aderyn / contract-locks-ether | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): NeuroJobsChallenges is the delegatecall logic of NeuroJobs: its payable entry points carry `delegated`, which reverts when called directly, so ether only ever lands in NeuroJobs (which has withdraw()). <br>`aderyn:contract-locks-ether:zetaphy-network/contracts/NeuroJobs.sol:e2c7087665c1` |
| [`zetaphy-network/contracts/NeuroJobs.sol:968`](../zetaphy-network/contracts/NeuroJobs.sol#L968) | aderyn / yul-return | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): _delegate() is a proxy forwarder (delegatecall to NeuroJobsChallenges, then return or revert the returndata); ending execution with return() is the intent. <br>`aderyn:yul-return:zetaphy-network/contracts/NeuroJobs.sol:56997fc16170` |
| [`zetaphy-network/contracts/NeuroOracle.sol:264`](../zetaphy-network/contracts/NeuroOracle.sol#L264) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): builds a string (a CosmWasm JSON message / a CAIP-10 id / the expected clientDataJSON fragment), never hashed as a key, so a packing collision has nothing to collide with. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/NeuroOracle.sol:cf0665efa0ef` |
| [`zetaphy-network/contracts/NeuroOracle.sol:267`](../zetaphy-network/contracts/NeuroOracle.sol#L267) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): builds a string (a CosmWasm JSON message / a CAIP-10 id / the expected clientDataJSON fragment), never hashed as a key, so a packing collision has nothing to collide with. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/NeuroOracle.sol:b04a1e0e90b9` |
| [`zetaphy-network/contracts/NeuroOracle.sol:270`](../zetaphy-network/contracts/NeuroOracle.sol#L270) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): builds a string (a CosmWasm JSON message / a CAIP-10 id / the expected clientDataJSON fragment), never hashed as a key, so a packing collision has nothing to collide with. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/NeuroOracle.sol:d1db06a8132e` |
| [`zetaphy-network/contracts/NeuroOracle.sol:325`](../zetaphy-network/contracts/NeuroOracle.sol#L325) | aderyn / contract-locks-ether | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): the only payable functions (IMessageRecipient.handle / Pyth updatePriceFeeds, payable because the interface says so) revert when msg.value != 0, so no ether can enter. <br>`aderyn:contract-locks-ether:zetaphy-network/contracts/NeuroOracle.sol:fc02dce4041e` |
| [`zetaphy-network/contracts/NeuroScore.sol:265`](../zetaphy-network/contracts/NeuroScore.sol#L265) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): builds the creation code of a data contract (fixed header + data), not a hash key. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/NeuroScore.sol:13a02d8bdc94` |
| [`zetaphy-network/contracts/NeuroScoreVerifier.sol:76`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L76) | aderyn / yul-return | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): generated snarkjs 0.7.6 Groth16 verifier: the inline-assembly helpers end the call with return(0, 0x20) holding false on a bad input, by design of the template. <br>`aderyn:yul-return:zetaphy-network/contracts/NeuroScoreVerifier.sol:4f53abf6f46c` |
| [`zetaphy-network/contracts/NeuroScoreVerifier.sol:92`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L92) | aderyn / yul-return | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): generated snarkjs 0.7.6 Groth16 verifier: the inline-assembly helpers end the call with return(0, 0x20) holding false on a bad input, by design of the template. <br>`aderyn:yul-return:zetaphy-network/contracts/NeuroScoreVerifier.sol:4f53abf6f46c#2` |
| [`zetaphy-network/contracts/NeuroScoreVerifier.sol:102`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L102) | aderyn / yul-return | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): generated snarkjs 0.7.6 Groth16 verifier: the inline-assembly helpers end the call with return(0, 0x20) holding false on a bad input, by design of the template. <br>`aderyn:yul-return:zetaphy-network/contracts/NeuroScoreVerifier.sol:4f53abf6f46c#3` |
| [`zetaphy-network/contracts/NeuroScoreVerifier.sol:189`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L189) | aderyn / yul-return | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): generated snarkjs 0.7.6 Groth16 verifier: the inline-assembly helpers end the call with return(0, 0x20) holding false on a bad input, by design of the template. <br>`aderyn:yul-return:zetaphy-network/contracts/NeuroScoreVerifier.sol:4f53abf6f46c#4` |
| [`zetaphy-network/contracts/QuantumWallet.sol:84`](../zetaphy-network/contracts/QuantumWallet.sol#L84) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): input of the ML-DSA precompile (1 variant byte, 32-byte message, key, signature). The key must hash to the stored pqKeyHash (checked just before), so its length is fixed, and the precompile splits key and signature by the variant's fixed sizes; no two inputs can be confused. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/QuantumWallet.sol:141f63d7fec9` |
| [`zetaphy-network/contracts/QuantumWallet.sol:111`](../zetaphy-network/contracts/QuantumWallet.sol#L111) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): CREATE2 init code hash: creationCode followed by abi.encode(constructor args), the standard way to predict a CREATE2 address. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/QuantumWallet.sol:dcc8a6fbc7e1` |
| [`zetaphy-network/contracts/ThreatRegistry.sol:515`](../zetaphy-network/contracts/ThreatRegistry.sol#L515) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): builds a string (a CosmWasm JSON message / a CAIP-10 id / the expected clientDataJSON fragment), never hashed as a key, so a packing collision has nothing to collide with. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/ThreatRegistry.sol:c8a75fc38cbb` |
| [`zetaphy-network/contracts/TwapRecorder.sol:184`](../zetaphy-network/contracts/TwapRecorder.sol#L184) | aderyn / incorrect-caret-operator | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): intentional XOR, not exponentiation: this is the 512-bit mulDiv (Remco Bloemen / Uniswap FullMath). (3*d)^2 seeds the Newton iteration for the inverse of the odd d mod 2^256 with 4 correct bits; the six "inv *= 2 - d * inv" steps that follow double that to 256. <br>`aderyn:incorrect-caret-operator:zetaphy-network/contracts/TwapRecorder.sol:d52424546788` |
| [`zetaphy-network/contracts/WebAuthnVerifier.sol:44`](../zetaphy-network/contracts/WebAuthnVerifier.sol#L44) | aderyn / abi-encode-packed-hash-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): builds a string (a CosmWasm JSON message / a CAIP-10 id / the expected clientDataJSON fragment), never hashed as a key, so a packing collision has nothing to collide with. <br>`aderyn:abi-encode-packed-hash-collision:zetaphy-network/contracts/WebAuthnVerifier.sol:bda2ed80364b` |
| [`zetaphy-network/contracts/ZetaphyEarlyPass.sol:9`](../zetaphy-network/contracts/ZetaphyEarlyPass.sol#L9) | aderyn / reused-contract-name | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): both files declare the identical one-function ERC-721 receiver interface (same signature); they never end up in one contract, so the duplicate name changes no behaviour. <br>`aderyn:reused-contract-name:zetaphy-network/contracts/ZetaphyEarlyPass.sol:7def0c39fec1` |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:286`](../zetaphy-network/contracts/ZetaphyOracle.sol#L286) | aderyn / unsafe-casting | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): value is rejected unless 0 < value <= type(uint128).max where the source is read (TWAP and Pyth paths), and `at` is a timestamp. <br>`aderyn:unsafe-casting:zetaphy-network/contracts/ZetaphyOracle.sol:662e4e128e0b` |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:289`](../zetaphy-network/contracts/ZetaphyOracle.sol#L289) | aderyn / unsafe-casting | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): value is rejected unless 0 < value <= type(uint128).max where the source is read (TWAP and Pyth paths), and `at` is a timestamp. <br>`aderyn:unsafe-casting:zetaphy-network/contracts/ZetaphyOracle.sol:975848702b62` |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:290`](../zetaphy-network/contracts/ZetaphyOracle.sol#L290) | aderyn / unsafe-casting | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): value is rejected unless 0 < value <= type(uint128).max where the source is read (TWAP and Pyth paths), and `at` is a timestamp. <br>`aderyn:unsafe-casting:zetaphy-network/contracts/ZetaphyOracle.sol:2c7d6dfbc04d` |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:417`](../zetaphy-network/contracts/ZetaphyOracle.sol#L417) | aderyn / incorrect-caret-operator | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): intentional XOR, not exponentiation: this is the 512-bit mulDiv (Remco Bloemen / Uniswap FullMath). (3*d)^2 seeds the Newton iteration for the inverse of the odd d mod 2^256 with 4 correct bits; the six "inv *= 2 - d * inv" steps that follow double that to 256. <br>`aderyn:incorrect-caret-operator:zetaphy-network/contracts/ZetaphyOracle.sol:e6c2a0037feb` |
| [`zetaphy-network/contracts/ZetaphyPythRelay.sol:48`](../zetaphy-network/contracts/ZetaphyPythRelay.sol#L48) | aderyn / contract-locks-ether | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): the only payable functions (IMessageRecipient.handle / Pyth updatePriceFeeds, payable because the interface says so) revert when msg.value != 0, so no ether can enter. <br>`aderyn:contract-locks-ether:zetaphy-network/contracts/ZetaphyPythRelay.sol:b450c6c65624` |
| [`zetaphy-network/contracts/ZetaphyQuests.sol:72`](../zetaphy-network/contracts/ZetaphyQuests.sol#L72) | aderyn / reentrancy-state-change | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): paid[q][a], s.count and earned[a] are written BEFORE token.transfer in the same loop iteration (lines 68-72); the "after" state is the next iteration's. token is the immutable ZEARLY token and pay() is onlyOperator. <br>`aderyn:reentrancy-state-change:zetaphy-network/contracts/ZetaphyQuests.sol:3d425537bde6` |
| `zetaphy-chain:evmd/zetaphy_guard.go:230` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_guard.go:6e9974eb0dd8` |
| `zetaphy-chain:evmd/zetaphy_immune.go:558` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_immune.go:891b47ca4819` |
| `zetaphy-chain:evmd/zetaphy_immune.go:574` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_immune.go:027e43b6b8bd` |
| `zetaphy-chain:evmd/zetaphy_immune.go:596` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_immune.go:c9488a5e479f` |
| `zetaphy-chain:evmd/zetaphy_immune.go:638` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_immune.go:302831b2a3ee` |
| `zetaphy-chain:evmd/zetaphy_modelat.go:140` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_modelat.go:2d6fc72f5401` |
| `zetaphy-chain:evmd/zetaphy_pqcall.go:264` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): n is the index of a field of a small Go struct (pqMarshal iterates v.NumField()), so n+1 always fits in int32. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_pqcall.go:8c3652c5226f` |
| `zetaphy-chain:evmd/zetaphy_pqcall.go:276` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): n is the index of a field of a small Go struct (pqMarshal iterates v.NumField()), so n+1 always fits in int32. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_pqcall.go:e311c68754a0` |
| `zetaphy-chain:evmd/zetaphy_pqcert.go:113` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_pqcert.go:8fbbfef5d3e0` |
| `zetaphy-chain:evmd/zetaphy_pqcert.go:139` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_pqcert.go:58a3b797bd13` |
| `zetaphy-chain:evmd/zetaphy_pqcert.go:173` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_pqcert.go:0787b761e7da` |
| `zetaphy-chain:evmd/zetaphy_pqcert.go:203` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): pqBuildCert returns early unless height-1 equals the block height the previous block stored under pqLastBlockKey, so height-1 is a real block height (>= 1) and exact as uint64; the author annotated the line "#nosec G115 -- block heights", which gosec 2.22.8 does not attach to this multi-line statement. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_pqcert.go:90830e0ec108` |
| `zetaphy-chain:evmd/zetaphy_pqguard.go:72` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_pqguard.go:72650affea24` |
| `zetaphy-chain:evmd/zetaphy_pqguard.go:295` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_pqguard.go:4270fc3fa235` |
| `zetaphy-chain:evmd/zetaphy_qday.go:90` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_qday.go:388e9a5efffc` |
| `zetaphy-chain:evmd/zetaphy_qday.go:244` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_qday.go:f2b251fe05b7` |
| `zetaphy-chain:evmd/zetaphy_random.go:86` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_random.go:5f1ca0745033` |
| `zetaphy-chain:evmd/zetaphy_random.go:102` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block heights / rounds / unix seconds, always between 0 and 2^63 (written by the chain itself or taken from the block header); the author annotated the line "#nosec G115" with that reason, which gosec 2.22.8 does not attach to a multi-line if statement or call, so it still reports it. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_random.go:13faba03b2d3` |
| `zetaphy-chain:evmd/zetaphy_threatgate.go:128` | gosec / G115 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): until = block time (unix seconds, positive) + seconds, where setConsent caps seconds at one day, so the int64 is positive and the uint64 conversion is exact. <br>`gosec:G115:zetaphy-chain:evmd/zetaphy_threatgate.go:59d25d627c7f` |
| [`zetaphy-dex/contracts/dlmm/DlmmMath.sol:108`](../zetaphy-dex/contracts/dlmm/DlmmMath.sol#L108) | slither / incorrect-exp | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): intentional XOR, not exponentiation: this is the 512-bit mulDiv (Remco Bloemen / Uniswap FullMath). (3*d)^2 seeds the Newton iteration for the inverse of the odd d mod 2^256 with 4 correct bits; the six "inv *= 2 - d * inv" steps that follow double that to 256. <br>`slither:incorrect-exp:zetaphy-dex/contracts/dlmm/DlmmMath.sol:9096fa23eb2a` |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:441`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L441) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): _pay compares the pair's balance before/after one transferFrom to reject fee-on-transfer tokens; the router keeps no state or funds, and the pair does its own reserve accounting under its lock. <br>`slither:reentrancy-balance:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:8a43173e3ccc` |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:165`](../zetaphy-dex/contracts/ZetaphyPair.sol#L165) | slither / weak-prng | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): block.timestamp % 2**32 is the Uniswap V2 TWAP timestamp (wraps by design), not randomness. <br>`slither:weak-prng:zetaphy-dex/contracts/ZetaphyPair.sol:f98c1d2343a6` |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:462`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L462) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): the Uniswap V2 Router02 fee-on-transfer pattern: the router holds no funds between calls and the balance checked is the caller's own recipient; a token that re-enters can only distort the output of the swap its own caller chose. <br>`slither:reentrancy-balance:zetaphy-dex/contracts/ZetaphyRouter.sol:fcf892f14353` |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:474`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L474) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): the Uniswap V2 Router02 fee-on-transfer pattern: the router holds no funds between calls and the balance checked is the caller's own recipient; a token that re-enters can only distort the output of the swap its own caller chose. <br>`slither:reentrancy-balance:zetaphy-dex/contracts/ZetaphyRouter.sol:1feac58c8c01` |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:486`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L486) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): the Uniswap V2 Router02 fee-on-transfer pattern: the router holds no funds between calls and the balance checked is the caller's own recipient; a token that re-enters can only distort the output of the swap its own caller chose. <br>`slither:reentrancy-balance:zetaphy-dex/contracts/ZetaphyRouter.sol:c344d8733607` |
| [`zetaphy-network/contracts/AgentPolicyWallet.sol:448`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L448) | slither / encode-packed-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): input of the ML-DSA precompile (1 variant byte, 32-byte message, key, signature). The key must hash to the stored pqKeyHash (checked just before), so its length is fixed, and the precompile splits key and signature by the variant's fixed sizes; no two inputs can be confused. <br>`slither:encode-packed-collision:zetaphy-network/contracts/AgentPolicyWallet.sol:cf5a290425f8` |
| [`zetaphy-network/contracts/AgentRegistry.sol:244`](../zetaphy-network/contracts/AgentRegistry.sol#L244) | slither / encode-packed-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): input of the ML-DSA precompile (1 variant byte, 32-byte message, key, signature). The key must hash to the stored pqKeyHash (checked just before), so its length is fixed, and the precompile splits key and signature by the variant's fixed sizes; no two inputs can be confused. <br>`slither:encode-packed-collision:zetaphy-network/contracts/AgentRegistry.sol:2c451a576d40` |
| [`zetaphy-network/contracts/DataDAO.sol:151`](../zetaphy-network/contracts/DataDAO.sol#L151) | slither / arbitrary-send-eth | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): pays `account` only the amount proven by a Merkle proof against the round root, once (claimed flag set first), within the round's total. <br>`slither:arbitrary-send-eth:zetaphy-network/contracts/DataDAO.sol:05739bbc9ab4` |
| [`zetaphy-network/contracts/IntentExecutor.sol:239`](../zetaphy-network/contracts/IntentExecutor.sol#L239) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:7a372b901aa7` |
| [`zetaphy-network/contracts/IntentExecutor.sol:239`](../zetaphy-network/contracts/IntentExecutor.sol#L239) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:4477f56d0e75` |
| [`zetaphy-network/contracts/IntentExecutor.sol:239`](../zetaphy-network/contracts/IntentExecutor.sol#L239) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:cdd73439ce5a` |
| [`zetaphy-network/contracts/IntentExecutor.sol:239`](../zetaphy-network/contracts/IntentExecutor.sol#L239) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:ac27b1f4b08e` |
| [`zetaphy-network/contracts/IntentExecutor.sol:239`](../zetaphy-network/contracts/IntentExecutor.sol#L239) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:a49d496b6cfd` |
| [`zetaphy-network/contracts/IntentExecutor.sol:239`](../zetaphy-network/contracts/IntentExecutor.sol#L239) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:68d2825a8ee1` |
| [`zetaphy-network/contracts/IntentExecutor.sol:280`](../zetaphy-network/contracts/IntentExecutor.sol#L280) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:f019713c6bc6` |
| [`zetaphy-network/contracts/IntentExecutor.sol:280`](../zetaphy-network/contracts/IntentExecutor.sol#L280) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:51143b145b83` |
| [`zetaphy-network/contracts/IntentExecutor.sol:280`](../zetaphy-network/contracts/IntentExecutor.sol#L280) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:0b14f4fbbe0a` |
| [`zetaphy-network/contracts/IntentExecutor.sol:280`](../zetaphy-network/contracts/IntentExecutor.sol#L280) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:8aa8b7d7a455` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:8c830dca428f` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:06162550cbc6` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:2ecb39d51644` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:6f81a6ff768c` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:a95c48ba4da5` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:d9fed5f8dd41` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:5302430ff041` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:082fcf79f496` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:8a0635f208da` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:acfff0f98273` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:7234ea39cfc8` |
| [`zetaphy-network/contracts/IntentExecutor.sol:314`](../zetaphy-network/contracts/IntentExecutor.sol#L314) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/IntentExecutor.sol:cd2ec9a8ca4f` |
| [`zetaphy-network/contracts/IntentExecutor.sol:358`](../zetaphy-network/contracts/IntentExecutor.sol#L358) | slither / encode-packed-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): input of the ML-DSA precompile (1 variant byte, 32-byte message, key, signature). The key must hash to the stored pqKeyHash (checked just before), so its length is fixed, and the precompile splits key and signature by the variant's fixed sizes; no two inputs can be confused. <br>`slither:encode-packed-collision:zetaphy-network/contracts/IntentExecutor.sol:f3aacb725392` |
| [`zetaphy-network/contracts/NeuroJobs.sol:132`](../zetaphy-network/contracts/NeuroJobs.sol#L132) | slither / uninitialized-state | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): written outside the base contract that declares it: jobs.push() in NeuroJobs.request, control in the NeuroJobs constructor, challenges[id][k] (storage pointer) and challenged.push(id) in NeuroJobsChallenges.challenge (run by delegatecall on NeuroJobs storage). <br>`slither:uninitialized-state:zetaphy-network/contracts/NeuroJobs.sol:0441fc6eaf68` |
| [`zetaphy-network/contracts/NeuroJobs.sol:134`](../zetaphy-network/contracts/NeuroJobs.sol#L134) | slither / uninitialized-state | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): written outside the base contract that declares it: jobs.push() in NeuroJobs.request, control in the NeuroJobs constructor, challenges[id][k] (storage pointer) and challenged.push(id) in NeuroJobsChallenges.challenge (run by delegatecall on NeuroJobs storage). <br>`slither:uninitialized-state:zetaphy-network/contracts/NeuroJobs.sol:0d3f81935010` |
| [`zetaphy-network/contracts/NeuroJobs.sol:136`](../zetaphy-network/contracts/NeuroJobs.sol#L136) | slither / uninitialized-state | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): written outside the base contract that declares it: jobs.push() in NeuroJobs.request, control in the NeuroJobs constructor, challenges[id][k] (storage pointer) and challenged.push(id) in NeuroJobsChallenges.challenge (run by delegatecall on NeuroJobs storage). <br>`slither:uninitialized-state:zetaphy-network/contracts/NeuroJobs.sol:c3f7bd65a279` |
| [`zetaphy-network/contracts/NeuroJobs.sol:138`](../zetaphy-network/contracts/NeuroJobs.sol#L138) | slither / uninitialized-state | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): written outside the base contract that declares it: jobs.push() in NeuroJobs.request, control in the NeuroJobs constructor, challenges[id][k] (storage pointer) and challenged.push(id) in NeuroJobsChallenges.challenge (run by delegatecall on NeuroJobs storage). <br>`slither:uninitialized-state:zetaphy-network/contracts/NeuroJobs.sol:91dbf281f4c9` |
| [`zetaphy-network/contracts/NeuroJobs.sol:877`](../zetaphy-network/contracts/NeuroJobs.sol#L877) | slither / uninitialized-storage | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): `Round storage r;` in draw() is assigned on both branches of the if/else-if (j.r or ch.r) and the else branch reverts, so it is never used unassigned. <br>`slither:uninitialized-storage:zetaphy-network/contracts/NeuroJobs.sol:7d6408636bea` |
| [`zetaphy-network/contracts/NeuroScore.sol:58`](../zetaphy-network/contracts/NeuroScore.sol#L58) | slither / uninitialized-state | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): _chunks[hash] is filled through the storage pointer `address[] storage list = _chunks[hash]; list.push(...)` in publishModel. <br>`slither:uninitialized-state:zetaphy-network/contracts/NeuroScore.sol:5971cc5e7f8e` |
| [`zetaphy-network/contracts/NeuroScoreVerifier.sol:71`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L71) | slither / incorrect-return | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): generated snarkjs 0.7.6 Groth16 verifier: the inline-assembly helpers end the call with return(0, 0x20) holding false on a bad input, by design of the template. <br>`slither:incorrect-return:zetaphy-network/contracts/NeuroScoreVerifier.sol:b56fe4b60e94` |
| [`zetaphy-network/contracts/NeuroScoreVerifier.sol:71`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L71) | slither / incorrect-return | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): generated snarkjs 0.7.6 Groth16 verifier: the inline-assembly helpers end the call with return(0, 0x20) holding false on a bad input, by design of the template. <br>`slither:incorrect-return:zetaphy-network/contracts/NeuroScoreVerifier.sol:4cb2c34a128c` |
| [`zetaphy-network/contracts/NeuroScoreVerifier.sol:106`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L106) | slither / incorrect-return | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): generated snarkjs 0.7.6 Groth16 verifier: the inline-assembly helpers end the call with return(0, 0x20) holding false on a bad input, by design of the template. <br>`slither:incorrect-return:zetaphy-network/contracts/NeuroScoreVerifier.sol:c7cb5e89409e` |
| [`zetaphy-network/contracts/QuantumWallet.sol:51`](../zetaphy-network/contracts/QuantumWallet.sol#L51) | slither / arbitrary-send-eth | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): a smart wallet: execute() runs only after _authorize() checks the owner's ECDSA and ML-DSA signatures over (to, value, data, deadline, nonce); sending to the signed `to` is its purpose. <br>`slither:arbitrary-send-eth:zetaphy-network/contracts/QuantumWallet.sol:87580af76d20` |
| [`zetaphy-network/contracts/QuantumWallet.sol:83`](../zetaphy-network/contracts/QuantumWallet.sol#L83) | slither / encode-packed-collision | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): input of the ML-DSA precompile (1 variant byte, 32-byte message, key, signature). The key must hash to the stored pqKeyHash (checked just before), so its length is fixed, and the precompile splits key and signature by the variant's fixed sizes; no two inputs can be confused. <br>`slither:encode-packed-collision:zetaphy-network/contracts/QuantumWallet.sol:fbfc1d70d7dc` |
| [`zetaphy-network/contracts/RewardVault.sol:127`](../zetaphy-network/contracts/RewardVault.sol#L127) | slither / reentrancy-eth | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): applyShares clears _pending and pendingAt before release(), and release() moves releasedDays forward before paying, so a recipient re-entering finds TooEarly / nothing releasable; the writes after the call only install the already-taken pending list. <br>`slither:reentrancy-eth:zetaphy-network/contracts/RewardVault.sol:f9f3a307c2ff` |
| [`zetaphy-network/contracts/RewardVault.sol:158`](../zetaphy-network/contracts/RewardVault.sol#L158) | slither / weak-prng | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): n % 2 in _rpow is exponentiation by squaring (odd-exponent test), not randomness. <br>`slither:weak-prng:zetaphy-network/contracts/RewardVault.sol:fae92282b792` |
| [`zetaphy-network/contracts/StableGateway.sol:222`](../zetaphy-network/contracts/StableGateway.sol#L222) | slither / arbitrary-send-erc20 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): q.user is authenticated: _request requires an EIP-712 signature of q (user, token, fee, tip, maxCost, nonce, deadline) recovered to q.user, with a per-user nonce and deadline, before either transferFrom. <br>`slither:arbitrary-send-erc20:zetaphy-network/contracts/StableGateway.sol:7d0ae06aff07` |
| [`zetaphy-network/contracts/StableGateway.sol:222`](../zetaphy-network/contracts/StableGateway.sol#L222) | slither / arbitrary-send-erc20 | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): q.user is authenticated: _request requires an EIP-712 signature of q (user, token, fee, tip, maxCost, nonce, deadline) recovered to q.user, with a per-user nonce and deadline, before either transferFrom. <br>`slither:arbitrary-send-erc20:zetaphy-network/contracts/StableGateway.sol:0fa417499fb6` |
| [`zetaphy-network/contracts/TwapRecorder.sol:160`](../zetaphy-network/contracts/TwapRecorder.sol#L160) | slither / incorrect-exp | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): intentional XOR, not exponentiation: this is the 512-bit mulDiv (Remco Bloemen / Uniswap FullMath). (3*d)^2 seeds the Newton iteration for the inverse of the odd d mod 2^256 with 4 correct bits; the six "inv *= 2 - d * inv" steps that follow double that to 256. <br>`slither:incorrect-exp:zetaphy-network/contracts/TwapRecorder.sol:d03bd35b7388` |
| [`zetaphy-network/contracts/UsefulIssuance.sol:111`](../zetaphy-network/contracts/UsefulIssuance.sol#L111) | slither / reentrancy-eth | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): pendingOverflow is zeroed before the call; it is restored only if the call failed, in which case everything the callee did (any re-entry included) was reverted with it. <br>`slither:reentrancy-eth:zetaphy-network/contracts/UsefulIssuance.sol:8e07beda46a5` |
| [`zetaphy-network/contracts/ZetaphyCheques.sol:205`](../zetaphy-network/contracts/ZetaphyCheques.sol#L205) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/ZetaphyCheques.sol:4c54afa8742b` |
| [`zetaphy-network/contracts/ZetaphyCheques.sol:217`](../zetaphy-network/contracts/ZetaphyCheques.sol#L217) | slither / arbitrary-send-eth | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): _pay sends only to the channel's recorded payer (refund) or payee (cash), from nonReentrant entry points, after the state is updated. <br>`slither:arbitrary-send-eth:zetaphy-network/contracts/ZetaphyCheques.sol:803da5b49ae9` |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:182`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L182) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:406a8e84ce45` |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:182`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L182) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:9669a1b27d3b` |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:182`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L182) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:b841a57b52dc` |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:182`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L182) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:162887959b70` |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:182`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L182) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:46181161035e` |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:182`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L182) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:abaea1ce16f9` |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:182`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L182) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:6693bb172968` |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:209`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L209) | slither / reentrancy-balance | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): every external entry point that reaches this code is nonReentrant (IntentExecutor.execute; ZetaphyOfflineOrders.fill / fillWithPermit; ZetaphyCheques.open / topUp), so the measured balance cannot be changed by re-entering this contract. <br>`slither:reentrancy-balance:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:b3e311fb7f61` |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:393`](../zetaphy-network/contracts/ZetaphyOracle.sol#L393) | slither / incorrect-exp | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): intentional XOR, not exponentiation: this is the 512-bit mulDiv (Remco Bloemen / Uniswap FullMath). (3*d)^2 seeds the Newton iteration for the inverse of the odd d mod 2^256 with 4 correct bits; the six "inv *= 2 - d * inv" steps that follow double that to 256. <br>`slither:incorrect-exp:zetaphy-network/contracts/ZetaphyOracle.sol:313aa7184c39` |
| [`zetaphy-nft/contracts/CollectionBase.sol:193`](../zetaphy-nft/contracts/CollectionBase.sol#L193) | slither / msg-value-in-nonpayable | **false-positive** (claude-agent (initial review by reading the code; owner to confirm), 2026-10-30): _checkPublicPayment is internal and is called only from publicMintTo in ZetaphyERC721 and ZetaphyERC1155, both payable. Slither analysed CollectionBase.sol on its own, where no caller exists. <br>`slither:msg-value-in-nonpayable:zetaphy-nft/contracts/CollectionBase.sol:3e2149dbf4fe` |

</details>

### Medium (331)

| Where | Tool / rule | Finding | Status |
|---|---|---|---|
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:264`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L264) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:f7aef71205a9` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:265`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L265) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:f4e21df163e7` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:306`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L306) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:37c2a0ca781d` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:309`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L309) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:ef40ac7910ae` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:313`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L313) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:eadcdd78f342` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:176`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L176) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:aed882acf45d` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:178`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L178) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:e77d143191f4` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:180`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L180) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:ad68eb26dc33` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:316`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L316) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:cc391a00cd01` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:322`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L322) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:07c2a6ed7fc0` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:335`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L335) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:07c2a6ed7fc0#2` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:276`](../zetaphy-dex/contracts/ZetaphyPair.sol#L276) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyPair.sol:9558be9c7bdf` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:277`](../zetaphy-dex/contracts/ZetaphyPair.sol#L277) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyPair.sol:df8bad9cc285` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:280`](../zetaphy-dex/contracts/ZetaphyPair.sol#L280) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyPair.sol:69b6a7458624` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:281`](../zetaphy-dex/contracts/ZetaphyPair.sol#L281) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyPair.sol:3f3bf9739643` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:229`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L229) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:dfdb8964d232` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:236`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L236) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:7a71bbbccdbd` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:245`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L245) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:5ec0fa28efe8` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:246`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L246) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:7ec76b90da90` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:247`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L247) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:a9edf3994e4a` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:248`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L248) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:080d3eaae102` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:322`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L322) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:1121e6cb4d50` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:377`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L377) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:f901b6df5baf` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:398`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L398) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:f901b6df5baf#2` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:406`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L406) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:28412fceb99d` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:412`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L412) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:743d1ac448f8` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:413`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L413) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:e9a0d977ab50` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:419`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L419) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:28412fceb99d#2` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:422`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L422) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:f901b6df5baf#3` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:425`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L425) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:743d1ac448f8#2` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:426`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L426) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:e9a0d977ab50#2` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:439`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L439) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:f0884bc6b4f3` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:468`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L468) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:413385c84dcd` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:471`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L471) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:41c60809dcb5` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:480`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L480) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:413385c84dcd#2` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:483`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L483) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:41c60809dcb5#2` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:489`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L489) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-dex/contracts/ZetaphyRouter.sol:567786bda528` | open |
| [`zetaphy-network/contracts/AgentPolicyWallet.sol:464`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L464) | semgrep / arbitrary-low-level-call | arbitrary-low-level-call — An attacker may perform call() to an arbitrary address with controlled calldata <br>`semgrep:arbitrary-low-level-call:zetaphy-network/contracts/AgentPolicyWallet.sol:85998eb458cd` | open |
| [`zetaphy-network/contracts/AgentPolicyWallet.sol:511`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L511) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/AgentPolicyWallet.sol:651d71249958` | open |
| [`zetaphy-network/contracts/AgentRegistry.sol:411`](../zetaphy-network/contracts/AgentRegistry.sol#L411) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/AgentRegistry.sol:0e39dbb339ef` | open |
| [`zetaphy-network/contracts/BridgeGuard.sol:39`](../zetaphy-network/contracts/BridgeGuard.sol#L39) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/BridgeGuard.sol:2b28d5ba9954` | open |
| [`zetaphy-network/contracts/BridgeGuard.sol:45`](../zetaphy-network/contracts/BridgeGuard.sol#L45) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/BridgeGuard.sol:0290f3966e05` | open |
| [`zetaphy-network/contracts/BridgeGuard.sol:370`](../zetaphy-network/contracts/BridgeGuard.sol#L370) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/BridgeGuard.sol:5e6d56c46483` | open |
| [`zetaphy-network/contracts/BridgeGuard.sol:405`](../zetaphy-network/contracts/BridgeGuard.sol#L405) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/BridgeGuard.sol:56bb955e2513` | open |
| [`zetaphy-network/contracts/BridgeGuard.sol:406`](../zetaphy-network/contracts/BridgeGuard.sol#L406) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/BridgeGuard.sol:55e8ecc03c99` | open |
| [`zetaphy-network/contracts/DataDAO.sol:109`](../zetaphy-network/contracts/DataDAO.sol#L109) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/DataDAO.sol:a69ce1ec1636` | open |
| [`zetaphy-network/contracts/DataDAO.sol:116`](../zetaphy-network/contracts/DataDAO.sol#L116) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/DataDAO.sol:b4c01c2a2c73` | open |
| [`zetaphy-network/contracts/DataDAO.sol:141`](../zetaphy-network/contracts/DataDAO.sol#L141) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/DataDAO.sol:d7570d69621d` | open |
| [`zetaphy-network/contracts/DataDAO.sol:164`](../zetaphy-network/contracts/DataDAO.sol#L164) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/DataDAO.sol:85a43a68c297` | open |
| [`zetaphy-network/contracts/DataDAO.sol:165`](../zetaphy-network/contracts/DataDAO.sol#L165) | semgrep / arbitrary-low-level-call | arbitrary-low-level-call — An attacker may perform call() to an arbitrary address with controlled calldata <br>`semgrep:arbitrary-low-level-call:zetaphy-network/contracts/DataDAO.sol:c394542a3fc2` | open |
| [`zetaphy-network/contracts/DataDAO.sol:175`](../zetaphy-network/contracts/DataDAO.sol#L175) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/DataDAO.sol:073427736b19` | open |
| [`zetaphy-network/contracts/DataDAO.sol:176`](../zetaphy-network/contracts/DataDAO.sol#L176) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/DataDAO.sol:8b60f412a04b` | open |
| [`zetaphy-network/contracts/FederatedRounds.sol:98`](../zetaphy-network/contracts/FederatedRounds.sol#L98) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/FederatedRounds.sol:ccc81d6e646b` | open |
| [`zetaphy-network/contracts/ForesightRegistry.sol:130`](../zetaphy-network/contracts/ForesightRegistry.sol#L130) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ForesightRegistry.sol:60eefce0d93d` | open |
| [`zetaphy-network/contracts/ForesightRegistry.sol:132`](../zetaphy-network/contracts/ForesightRegistry.sol#L132) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ForesightRegistry.sol:f3bf36f19761` | open |
| [`zetaphy-network/contracts/ForesightRegistry.sol:144`](../zetaphy-network/contracts/ForesightRegistry.sol#L144) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ForesightRegistry.sol:60eefce0d93d#2` | open |
| [`zetaphy-network/contracts/ForesightRegistry.sol:146`](../zetaphy-network/contracts/ForesightRegistry.sol#L146) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ForesightRegistry.sol:314feffeb7bc` | open |
| [`zetaphy-network/contracts/ForesightRegistry.sol:191`](../zetaphy-network/contracts/ForesightRegistry.sol#L191) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ForesightRegistry.sol:9c8d1365328a` | open |
| [`zetaphy-network/contracts/ForesightRegistry.sol:227`](../zetaphy-network/contracts/ForesightRegistry.sol#L227) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ForesightRegistry.sol:cf22412afe35` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:197`](../zetaphy-network/contracts/HackInsurance.sol#L197) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HackInsurance.sol:5cd95226fb78` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:202`](../zetaphy-network/contracts/HackInsurance.sol#L202) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HackInsurance.sol:452e944d7e13` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:210`](../zetaphy-network/contracts/HackInsurance.sol#L210) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HackInsurance.sol:950ec78598dd` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:296`](../zetaphy-network/contracts/HackInsurance.sol#L296) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HackInsurance.sol:2d601c91beaf` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:304`](../zetaphy-network/contracts/HackInsurance.sol#L304) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HackInsurance.sol:07b04c6e1eb0` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:340`](../zetaphy-network/contracts/HackInsurance.sol#L340) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HackInsurance.sol:694d295bdb84` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:343`](../zetaphy-network/contracts/HackInsurance.sol#L343) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HackInsurance.sol:371e7c6a1398` | open |
| [`zetaphy-network/contracts/HyperlaneLane.sol:184`](../zetaphy-network/contracts/HyperlaneLane.sol#L184) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HyperlaneLane.sol:b2906b23beb0` | open |
| [`zetaphy-network/contracts/HyperlaneLane.sol:185`](../zetaphy-network/contracts/HyperlaneLane.sol#L185) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HyperlaneLane.sol:d958757ba24e` | open |
| [`zetaphy-network/contracts/HyperlaneLockBoxV2.sol:188`](../zetaphy-network/contracts/HyperlaneLockBoxV2.sol#L188) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HyperlaneLockBoxV2.sol:2520407786f3` | open |
| [`zetaphy-network/contracts/HyperlaneLockBoxV2.sol:238`](../zetaphy-network/contracts/HyperlaneLockBoxV2.sol#L238) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HyperlaneLockBoxV2.sol:70f1860643ec` | open |
| [`zetaphy-network/contracts/HyperlaneLockBoxV2.sol:368`](../zetaphy-network/contracts/HyperlaneLockBoxV2.sol#L368) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/HyperlaneLockBoxV2.sol:31a7015b833a` | open |
| [`zetaphy-network/contracts/IntentExecutor.sol:174`](../zetaphy-network/contracts/IntentExecutor.sol#L174) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/IntentExecutor.sol:eefd23fd3497` | open |
| [`zetaphy-network/contracts/IntentExecutor.sol:223`](../zetaphy-network/contracts/IntentExecutor.sol#L223) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/IntentExecutor.sol:2641e5561b89` | open |
| [`zetaphy-network/contracts/IntentExecutor.sol:227`](../zetaphy-network/contracts/IntentExecutor.sol#L227) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/IntentExecutor.sol:78920f39b0a2` | open |
| [`zetaphy-network/contracts/IntentExecutor.sol:234`](../zetaphy-network/contracts/IntentExecutor.sol#L234) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/IntentExecutor.sol:dfdd4519bdb3` | open |
| [`zetaphy-network/contracts/NeuroAttest.sol:135`](../zetaphy-network/contracts/NeuroAttest.sol#L135) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/NeuroAttest.sol:94f6aef05eba` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:833`](../zetaphy-network/contracts/NeuroIdentity.sol#L833) | semgrep / missing-assignment | missing-assignment — Meaningless statement that does not change any values could be a sign of missed security checks or other important changes. <br>`semgrep:missing-assignment:zetaphy-network/contracts/NeuroIdentity.sol:a89792fd764d` | open |
| [`zetaphy-network/contracts/NeuroOracle.sol:183`](../zetaphy-network/contracts/NeuroOracle.sol#L183) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/NeuroOracle.sol:ceb58f9d20d4` | open |
| [`zetaphy-network/contracts/NeuroScore.sol:220`](../zetaphy-network/contracts/NeuroScore.sol#L220) | semgrep / missing-assignment | missing-assignment — Meaningless statement that does not change any values could be a sign of missed security checks or other important changes. <br>`semgrep:missing-assignment:zetaphy-network/contracts/NeuroScore.sol:4ff253c30cbf` | open |
| [`zetaphy-network/contracts/NeuroScoreVerifier.sol:82`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L82) | semgrep / missing-assignment | missing-assignment — Meaningless statement that does not change any values could be a sign of missed security checks or other important changes. <br>`semgrep:missing-assignment:zetaphy-network/contracts/NeuroScoreVerifier.sol:eaf0b3355354` | open |
| [`zetaphy-network/contracts/QuantumWallet.sol:57`](../zetaphy-network/contracts/QuantumWallet.sol#L57) | semgrep / arbitrary-low-level-call | arbitrary-low-level-call — An attacker may perform call() to an arbitrary address with controlled calldata <br>`semgrep:arbitrary-low-level-call:zetaphy-network/contracts/QuantumWallet.sol:751d62195806` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:190`](../zetaphy-network/contracts/RedBlueArena.sol#L190) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/RedBlueArena.sol:a31d22fb0f67` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:237`](../zetaphy-network/contracts/RedBlueArena.sol#L237) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/RedBlueArena.sol:a180c18e8820` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:398`](../zetaphy-network/contracts/RedBlueArena.sol#L398) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/RedBlueArena.sol:b27eac13f7df` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:399`](../zetaphy-network/contracts/RedBlueArena.sol#L399) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/RedBlueArena.sol:c9f4e96b9851` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:437`](../zetaphy-network/contracts/RedBlueArena.sol#L437) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/RedBlueArena.sol:0d9a09c6ef53` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:438`](../zetaphy-network/contracts/RedBlueArena.sol#L438) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/RedBlueArena.sol:32e2ba25ac4b` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:440`](../zetaphy-network/contracts/RedBlueArena.sol#L440) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/RedBlueArena.sol:6c4d171fe796` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:442`](../zetaphy-network/contracts/RedBlueArena.sol#L442) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/RedBlueArena.sol:b8a3edd3f366` | open |
| [`zetaphy-network/contracts/SaphanTokens.sol:486`](../zetaphy-network/contracts/SaphanTokens.sol#L486) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/SaphanTokens.sol:02f6a09d596d` | open |
| [`zetaphy-network/contracts/SignalBoard.sol:67`](../zetaphy-network/contracts/SignalBoard.sol#L67) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/SignalBoard.sol:91772e5b0a52` | open |
| [`zetaphy-network/contracts/SimpleMultisig.sol:59`](../zetaphy-network/contracts/SimpleMultisig.sol#L59) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/SimpleMultisig.sol:0c5c89c944be` | open |
| [`zetaphy-network/contracts/StableGateway.sol:185`](../zetaphy-network/contracts/StableGateway.sol#L185) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/StableGateway.sol:74855a2a6ae7` | open |
| [`zetaphy-network/contracts/StableGateway.sol:193`](../zetaphy-network/contracts/StableGateway.sol#L193) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/StableGateway.sol:9c7d2610dfd8` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:607`](../zetaphy-network/contracts/ThreatRegistry.sol#L607) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ThreatRegistry.sol:6d5e08cb1fd2` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:609`](../zetaphy-network/contracts/ThreatRegistry.sol#L609) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ThreatRegistry.sol:32bbffd11509` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:610`](../zetaphy-network/contracts/ThreatRegistry.sol#L610) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ThreatRegistry.sol:8bbd724baed7` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:649`](../zetaphy-network/contracts/ThreatRegistry.sol#L649) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ThreatRegistry.sol:6bf0c33bb482` | open |
| [`zetaphy-network/contracts/ThreatReports.sol:114`](../zetaphy-network/contracts/ThreatReports.sol#L114) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ThreatReports.sol:90461aa775ab` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:62`](../zetaphy-network/contracts/TwapRecorder.sol#L62) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/TwapRecorder.sol:12b0a31e00cd` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:94`](../zetaphy-network/contracts/TwapRecorder.sol#L94) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/TwapRecorder.sol:f251a6c948e4` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:120`](../zetaphy-network/contracts/TwapRecorder.sol#L120) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/TwapRecorder.sol:aee6bb02e28a` | open |
| [`zetaphy-network/contracts/UsefulIssuance.sol:98`](../zetaphy-network/contracts/UsefulIssuance.sol#L98) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/UsefulIssuance.sol:a598311195ac` | open |
| [`zetaphy-network/contracts/UsefulIssuance.sol:146`](../zetaphy-network/contracts/UsefulIssuance.sol#L146) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/UsefulIssuance.sol:4ba34a1f78e2` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:184`](../zetaphy-network/contracts/UsefulWork.sol#L184) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/UsefulWork.sol:3e7b5cbf2c2f` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:346`](../zetaphy-network/contracts/UsefulWork.sol#L346) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/UsefulWork.sol:d61eed734a28` | open |
| [`zetaphy-network/contracts/ZetaphyCheques.sol:153`](../zetaphy-network/contracts/ZetaphyCheques.sol#L153) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ZetaphyCheques.sol:8d26f57b971c` | open |
| [`zetaphy-network/contracts/ZetaphyCheques.sol:170`](../zetaphy-network/contracts/ZetaphyCheques.sol#L170) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ZetaphyCheques.sol:4dc08b789df1` | open |
| [`zetaphy-network/contracts/ZetaphyCheques.sol:191`](../zetaphy-network/contracts/ZetaphyCheques.sol#L191) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ZetaphyCheques.sol:0bdf04ff4814` | open |
| [`zetaphy-network/contracts/ZetaphyEarlyFarm.sol:86`](../zetaphy-network/contracts/ZetaphyEarlyFarm.sol#L86) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ZetaphyEarlyFarm.sol:d7ba2bdb5b2c` | open |
| [`zetaphy-network/contracts/ZetaphyEarlyFarm.sol:87`](../zetaphy-network/contracts/ZetaphyEarlyFarm.sol#L87) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ZetaphyEarlyFarm.sol:48e0d712cddc` | open |
| [`zetaphy-network/contracts/ZetaphyPoints.sol:84`](../zetaphy-network/contracts/ZetaphyPoints.sol#L84) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ZetaphyPoints.sol:b505c63185d3` | open |
| [`zetaphy-network/contracts/ZetaphyPoints.sol:91`](../zetaphy-network/contracts/ZetaphyPoints.sol#L91) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ZetaphyPoints.sol:bfec7d54fd24` | open |
| [`zetaphy-network/contracts/ZetaphyPoints.sol:92`](../zetaphy-network/contracts/ZetaphyPoints.sol#L92) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ZetaphyPoints.sol:75e19439659b` | open |
| [`zetaphy-network/contracts/ZetaphyPythRelay.sol:144`](../zetaphy-network/contracts/ZetaphyPythRelay.sol#L144) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-network/contracts/ZetaphyPythRelay.sol:e5d694ade16e` | open |
| [`zetaphy-nft/contracts/NFTFactory.sol:65`](../zetaphy-nft/contracts/NFTFactory.sol#L65) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-nft/contracts/NFTFactory.sol:4ee5fffcf016` | open |
| [`zetaphy-nft/contracts/NFTMarketplace.sol:274`](../zetaphy-nft/contracts/NFTMarketplace.sol#L274) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-nft/contracts/NFTMarketplace.sol:83e839fec262` | open |
| [`zetaphy-nft/contracts/NFTMarketplace.sol:402`](../zetaphy-nft/contracts/NFTMarketplace.sol#L402) | semgrep / basic-arithmetic-underflow | basic-arithmetic-underflow — Possible arithmetic underflow <br>`semgrep:basic-arithmetic-underflow:zetaphy-nft/contracts/NFTMarketplace.sol:33f6509e5bfa` | open |
| [`zetaphy-dex/contracts/dlmm/DlmmMath.sol:52`](../zetaphy-dex/contracts/dlmm/DlmmMath.sol#L52) | slither / divide-before-multiply | divide-before-multiply — DlmmMath.getPriceX128(int256,uint256) (contracts/dlmm/DlmmMath.sol#52-76) performs a multiplication on the result of a division: - base = (O <br>`slither:divide-before-multiply:zetaphy-dex/contracts/dlmm/DlmmMath.sol:fc0973ec12f0` | open |
| [`zetaphy-dex/contracts/dlmm/DlmmMath.sol:108`](../zetaphy-dex/contracts/dlmm/DlmmMath.sol#L108) | slither / divide-before-multiply | divide-before-multiply — DlmmMath.mulDiv(uint256,uint256,uint256) (contracts/dlmm/DlmmMath.sol#108-140) performs a multiplication on the result of a division: - d /= <br>`slither:divide-before-multiply:zetaphy-dex/contracts/dlmm/DlmmMath.sol:bb69a0e175f4` | open |
| [`zetaphy-dex/contracts/dlmm/DlmmMath.sol:108`](../zetaphy-dex/contracts/dlmm/DlmmMath.sol#L108) | slither / divide-before-multiply | divide-before-multiply — DlmmMath.mulDiv(uint256,uint256,uint256) (contracts/dlmm/DlmmMath.sol#108-140) performs a multiplication on the result of a division: - p0 / <br>`slither:divide-before-multiply:zetaphy-dex/contracts/dlmm/DlmmMath.sol:d631247a84a7` | open |
| [`zetaphy-dex/contracts/dlmm/DlmmMath.sol:108`](../zetaphy-dex/contracts/dlmm/DlmmMath.sol#L108) | slither / divide-before-multiply | divide-before-multiply — DlmmMath.mulDiv(uint256,uint256,uint256) (contracts/dlmm/DlmmMath.sol#108-140) performs a multiplication on the result of a division: - d /= <br>`slither:divide-before-multiply:zetaphy-dex/contracts/dlmm/DlmmMath.sol:94d027697bb6` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:121`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L121) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in ZetaphyDlmmFactory.createPair(address,address,uint16,int24) (contracts/dlmm/ZetaphyDlmmFactory.sol#121-140): External calls: - <br>`slither:reentrancy-no-eth:zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:2d8266d4f1ff` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:121`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L121) | slither / unused-return | unused-return — ZetaphyDlmmFactory.createPair(address,address,uint16,int24) (contracts/dlmm/ZetaphyDlmmFactory.sol#121-140) ignores return value by DlmmMath <br>`slither:unused-return:zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:800099a6d1cf` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:183`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L183) | slither / unused-return | unused-return — ZetaphyDlmmPair.constructor() (contracts/dlmm/ZetaphyDlmmPair.sol#183-199) ignores return value by DlmmMath.getPriceX128(p.activeId,p.binSte <br>`slither:unused-return:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:439cdf975f49` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:232`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L232) | slither / incorrect-equality | incorrect-equality — ZetaphyDlmmPair.getNextNonEmptyBin(bool,int24) (contracts/dlmm/ZetaphyDlmmPair.sol#232-236) uses a dangerous strict equality: - i == DlmmBin <br>`slither:incorrect-equality:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:5cee00adfe50` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:248`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L248) | slither / incorrect-equality | incorrect-equality — ZetaphyDlmmPair.getSwapIn(uint256,bool) (contracts/dlmm/ZetaphyDlmmPair.sol#248-273) uses a dangerous strict equality: - i == DlmmBinTree.NO <br>`slither:incorrect-equality:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:021768b04064` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:283`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L283) | slither / incorrect-equality | incorrect-equality — ZetaphyDlmmPair.swap(bool,address) (contracts/dlmm/ZetaphyDlmmPair.sol#283-321) uses a dangerous strict equality: - amountOut == 0 (contract <br>`slither:incorrect-equality:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:f78a4f82ee00` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:283`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L283) | slither / incorrect-equality | incorrect-equality — ZetaphyDlmmPair.swap(bool,address) (contracts/dlmm/ZetaphyDlmmPair.sol#283-321) uses a dangerous strict equality: - amountIn == 0 (contracts <br>`slither:incorrect-equality:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:b441c6e451b0` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:341`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L341) | slither / incorrect-equality | incorrect-equality — ZetaphyDlmmPair._runSwap(bool,uint256,bool) (contracts/dlmm/ZetaphyDlmmPair.sol#341-362) uses a dangerous strict equality: - i == DlmmBinTre <br>`slither:incorrect-equality:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:255d67c1e0d1` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:365`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L365) | slither / incorrect-equality | incorrect-equality — ZetaphyDlmmPair._stepBin(ZetaphyDlmmPair.SwapResult,ZetaphyDlmmPair.State,int24,bool,bool) (contracts/dlmm/ZetaphyDlmmPair.sol#365-389) uses <br>`slither:incorrect-equality:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:f3ec098e1f53` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:365`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L365) | slither / incorrect-equality | incorrect-equality — ZetaphyDlmmPair._stepBin(ZetaphyDlmmPair.SwapResult,ZetaphyDlmmPair.State,int24,bool,bool) (contracts/dlmm/ZetaphyDlmmPair.sol#365-389) uses <br>`slither:incorrect-equality:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:0c8bc4414d23` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:451`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L451) | slither / incorrect-equality | incorrect-equality — ZetaphyDlmmPair.mint(address,int24[],uint256[],uint256[],address) (contracts/dlmm/ZetaphyDlmmPair.sol#451-475) uses a dangerous strict equal <br>`slither:incorrect-equality:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:3723359f448d` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:457`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L457) | slither / uninitialized-local | uninitialized-local — ZetaphyDlmmPair.mint(address,int24[],uint256[],uint256[],address).c (contracts/dlmm/ZetaphyDlmmPair.sol#457) is a local variable never initi <br>`slither:uninitialized-local:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:a8cfd31b399b` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:483`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L483) | slither / uninitialized-local | uninitialized-local — ZetaphyDlmmPair._mintBin(ZetaphyDlmmPair.MintCtx,address,int24,uint256,uint256).takeX (contracts/dlmm/ZetaphyDlmmPair.sol#483) is a local va <br>`slither:uninitialized-local:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:b16481c20e20` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:484`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L484) | slither / uninitialized-local | uninitialized-local — ZetaphyDlmmPair._mintBin(ZetaphyDlmmPair.MintCtx,address,int24,uint256,uint256).takeY (contracts/dlmm/ZetaphyDlmmPair.sol#484) is a local va <br>`slither:uninitialized-local:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:c7f4ed6bba7e` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:514`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L514) | slither / incorrect-equality | incorrect-equality — ZetaphyDlmmPair.burn(address,address,int24[],uint256[]) (contracts/dlmm/ZetaphyDlmmPair.sol#514-533) uses a dangerous strict equality: - amo <br>`slither:incorrect-equality:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:58c6bbf58a2f` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:559`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L559) | slither / unused-return | unused-return — ZetaphyDlmmPair.setActiveIdWhileEmpty(int24) (contracts/dlmm/ZetaphyDlmmPair.sol#559-569) ignores return value by DlmmMath.getPriceX128(id,b <br>`slither:unused-return:zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:cd89f0a84b5f` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:161`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L161) | slither / unused-return | unused-return — ZetaphyDlmmRouter.getAmountsOut(uint256,ZetaphyDlmmRouter.Path) (contracts/dlmm/ZetaphyDlmmRouter.sol#161-170) ignores return value by (left <br>`slither:unused-return:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:b7bcb575922c` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:173`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L173) | slither / unused-return | unused-return — ZetaphyDlmmRouter.getAmountsIn(uint256,ZetaphyDlmmRouter.Path) (contracts/dlmm/ZetaphyDlmmRouter.sol#173-182) ignores return value by (inNee <br>`slither:unused-return:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:78d19812e191` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:406`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L406) | slither / unused-return | unused-return — ZetaphyDlmmRouter._swapChain(address[],address[],address) (contracts/dlmm/ZetaphyDlmmRouter.sol#406-414) ignores return value by IDlmmPairR( <br>`slither:unused-return:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:6bbc613b1162` | open |
| [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:406`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L406) | slither / unused-return | unused-return — ZetaphyDlmmRouter._swapChain(address[],address[],address) (contracts/dlmm/ZetaphyDlmmRouter.sol#406-414) ignores return value by IDlmmPairR( <br>`slither:unused-return:zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:252a46452c53` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:165`](../zetaphy-dex/contracts/ZetaphyPair.sol#L165) | slither / divide-before-multiply | divide-before-multiply — ZetaphyPair._update(uint256,uint256,uint112,uint112) (contracts/ZetaphyPair.sol#165-180) performs a multiplication on the result of a divisi <br>`slither:divide-before-multiply:zetaphy-dex/contracts/ZetaphyPair.sol:35501b7b35e9` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:165`](../zetaphy-dex/contracts/ZetaphyPair.sol#L165) | slither / divide-before-multiply | divide-before-multiply — ZetaphyPair._update(uint256,uint256,uint112,uint112) (contracts/ZetaphyPair.sol#165-180) performs a multiplication on the result of a divisi <br>`slither:divide-before-multiply:zetaphy-dex/contracts/ZetaphyPair.sol:1e43e6d2407c` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:204`](../zetaphy-dex/contracts/ZetaphyPair.sol#L204) | slither / incorrect-equality | incorrect-equality — ZetaphyPair.mint(address) (contracts/ZetaphyPair.sol#204-229) uses a dangerous strict equality: - liquidity == 0 (contracts/ZetaphyPair.sol# <br>`slither:incorrect-equality:zetaphy-dex/contracts/ZetaphyPair.sol:8a29653ce1d8` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:204`](../zetaphy-dex/contracts/ZetaphyPair.sol#L204) | slither / incorrect-equality | incorrect-equality — ZetaphyPair.mint(address) (contracts/ZetaphyPair.sol#204-229) uses a dangerous strict equality: - _totalSupply == 0 (contracts/ZetaphyPair.s <br>`slither:incorrect-equality:zetaphy-dex/contracts/ZetaphyPair.sol:57731dd0ee45` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:232`](../zetaphy-dex/contracts/ZetaphyPair.sol#L232) | slither / incorrect-equality | incorrect-equality — ZetaphyPair.burn(address) (contracts/ZetaphyPair.sol#232-254) uses a dangerous strict equality: - amount0 == 0 \|\| amount1 == 0 (contracts/ <br>`slither:incorrect-equality:zetaphy-dex/contracts/ZetaphyPair.sol:3da906aca858` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:232`](../zetaphy-dex/contracts/ZetaphyPair.sol#L232) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in ZetaphyPair.burn(address) (contracts/ZetaphyPair.sol#232-254): External calls: - _safeTransfer(_token0,to,amount0) (contracts/ <br>`slither:reentrancy-no-eth:zetaphy-dex/contracts/ZetaphyPair.sol:ddd39e798fe7` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:259`](../zetaphy-dex/contracts/ZetaphyPair.sol#L259) | slither / incorrect-equality | incorrect-equality — ZetaphyPair.swap(uint256,uint256,address,bytes) (contracts/ZetaphyPair.sol#259-287) uses a dangerous strict equality: - amount0In == 0 && am <br>`slither:incorrect-equality:zetaphy-dex/contracts/ZetaphyPair.sol:68d6a56ee35d` | open |
| [`zetaphy-dex/contracts/ZetaphyPair.sol:259`](../zetaphy-dex/contracts/ZetaphyPair.sol#L259) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in ZetaphyPair.swap(uint256,uint256,address,bytes) (contracts/ZetaphyPair.sol#259-287): External calls: - _safeTransfer(_token0,t <br>`slither:reentrancy-no-eth:zetaphy-dex/contracts/ZetaphyPair.sol:651016948619` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:204`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L204) | slither / unused-return | unused-return — ZetaphyRouter.getReserves(address,address) (contracts/ZetaphyRouter.sol#204-208) ignores return value by (r0,r1,None) = IPair(pairFor(tokenA <br>`slither:unused-return:zetaphy-dex/contracts/ZetaphyRouter.sol:d6f4c8c3f89b` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:218`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L218) | slither / incorrect-equality | incorrect-equality — ZetaphyRouter.getAmountOut(uint256,uint256,uint256) (contracts/ZetaphyRouter.sol#218-223) uses a dangerous strict equality: - amountIn == 0  <br>`slither:incorrect-equality:zetaphy-dex/contracts/ZetaphyRouter.sol:93667db0c0b1` | open |
| [`zetaphy-dex/contracts/ZetaphyRouter.sol:444`](../zetaphy-dex/contracts/ZetaphyRouter.sol#L444) | slither / unused-return | unused-return — ZetaphyRouter._swapSupportingFeeOnTransferTokens(address[],address) (contracts/ZetaphyRouter.sol#444-460) ignores return value by (r0,r1,Non <br>`slither:unused-return:zetaphy-dex/contracts/ZetaphyRouter.sol:daeb9211f1cb` | open |
| [`zetaphy-network/contracts/AgentPolicyWallet.sol:197`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L197) | slither / uninitialized-local | uninitialized-local — CosignCommittee.isValid(bytes32,bytes[]).count (contracts/AgentPolicyWallet.sol#197) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/AgentPolicyWallet.sol:8db2ec2941c0` | open |
| [`zetaphy-network/contracts/AgentPolicyWallet.sol:198`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L198) | slither / uninitialized-local | uninitialized-local — CosignCommittee.isValid(bytes32,bytes[]).last (contracts/AgentPolicyWallet.sol#198) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/AgentPolicyWallet.sol:20f90afa2825` | open |
| [`zetaphy-network/contracts/AgentRegistry.sol:368`](../zetaphy-network/contracts/AgentRegistry.sol#L368) | slither / uninitialized-local | uninitialized-local — AgentRegistry._close(uint256,bool).paid (contracts/AgentRegistry.sol#368) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/AgentRegistry.sol:3bec2f6ff794` | open |
| [`zetaphy-network/contracts/AgentRegistry.sol:416`](../zetaphy-network/contracts/AgentRegistry.sol#L416) | slither / uninitialized-local | uninitialized-local — ConstitutionChecker._allowed(address,bytes32,address[],bytes32[]).targetOk (contracts/AgentRegistry.sol#416) is a local variable never initi <br>`slither:uninitialized-local:zetaphy-network/contracts/AgentRegistry.sol:97650a0b3a1e` | open |
| [`zetaphy-network/contracts/BridgeAirlock.sol:345`](../zetaphy-network/contracts/BridgeAirlock.sol#L345) | slither / unused-return | unused-return — BridgeAirlock._party(uint256,address,address,address,bool) (contracts/BridgeAirlock.sol#345-356) ignores return value by (f,None) = r.isCont <br>`slither:unused-return:zetaphy-network/contracts/BridgeAirlock.sol:c07efe3d78c0` | open |
| [`zetaphy-network/contracts/BridgeAirlock.sol:345`](../zetaphy-network/contracts/BridgeAirlock.sol#L345) | slither / unused-return | unused-return — BridgeAirlock._party(uint256,address,address,address,bool) (contracts/BridgeAirlock.sol#345-356) ignores return value by (f,None) = r.isAddr <br>`slither:unused-return:zetaphy-network/contracts/BridgeAirlock.sol:50aaedba4db2` | open |
| [`zetaphy-network/contracts/BridgeAirlock.sol:345`](../zetaphy-network/contracts/BridgeAirlock.sol#L345) | slither / unused-return | unused-return — BridgeAirlock._party(uint256,address,address,address,bool) (contracts/BridgeAirlock.sol#345-356) ignores return value by (f,None) = r.isAddr <br>`slither:unused-return:zetaphy-network/contracts/BridgeAirlock.sol:b20e2fc2712a` | open |
| [`zetaphy-network/contracts/BridgeAirlock.sol:345`](../zetaphy-network/contracts/BridgeAirlock.sol#L345) | slither / unused-return | unused-return — BridgeAirlock._party(uint256,address,address,address,bool) (contracts/BridgeAirlock.sol#345-356) ignores return value by (f,None) = r.isAddr <br>`slither:unused-return:zetaphy-network/contracts/BridgeAirlock.sol:9313731bc39f` | open |
| [`zetaphy-network/contracts/BridgeAirlock.sol:345`](../zetaphy-network/contracts/BridgeAirlock.sol#L345) | slither / unused-return | unused-return — BridgeAirlock._party(uint256,address,address,address,bool) (contracts/BridgeAirlock.sol#345-356) ignores return value by (f,None) = r.isCont <br>`slither:unused-return:zetaphy-network/contracts/BridgeAirlock.sol:c4ec6f2c0283` | open |
| [`zetaphy-network/contracts/BridgeAirlock.sol:345`](../zetaphy-network/contracts/BridgeAirlock.sol#L345) | slither / unused-return | unused-return — BridgeAirlock._party(uint256,address,address,address,bool) (contracts/BridgeAirlock.sol#345-356) ignores return value by (f,None) = r.isAddr <br>`slither:unused-return:zetaphy-network/contracts/BridgeAirlock.sol:a8763a4ec831` | open |
| [`zetaphy-network/contracts/BridgeAirlock.sol:401`](../zetaphy-network/contracts/BridgeAirlock.sol#L401) | slither / unused-return | unused-return — NeuroLane._runner() (contracts/BridgeAirlock.sol#401-404) ignores return value by (None,None,active,agreed,rejected) = runners.workers(msg.s <br>`slither:unused-return:zetaphy-network/contracts/BridgeAirlock.sol:9da9bc253983` | open |
| [`zetaphy-network/contracts/BridgeAirlock.sol:438`](../zetaphy-network/contracts/BridgeAirlock.sol#L438) | slither / locked-ether | locked-ether — Contract locking ether found: Contract LockBox (contracts/BridgeAirlock.sol#438-446) has payable functions: - LockBox.lock(address) (contrac <br>`slither:locked-ether:zetaphy-network/contracts/BridgeAirlock.sol:20570fe57ccc` | open |
| [`zetaphy-network/contracts/BridgeGuard.sol:241`](../zetaphy-network/contracts/BridgeGuard.sol#L241) | slither / incorrect-equality | incorrect-equality — BridgeGuard.applyMaxDailyLimit() (contracts/BridgeGuard.sol#241-250) uses a dangerous strict equality: - at == 0 (contracts/BridgeGuard.sol# <br>`slither:incorrect-equality:zetaphy-network/contracts/BridgeGuard.sol:70bd80e7d610` | open |
| [`zetaphy-network/contracts/BridgeGuard.sol:436`](../zetaphy-network/contracts/BridgeGuard.sol#L436) | slither / unused-return | unused-return — BridgeGuard._isHeld(address) (contracts/BridgeGuard.sol#436-440) ignores return value by (f,None) = t.isContractHeld(who) (contracts/BridgeG <br>`slither:unused-return:zetaphy-network/contracts/BridgeGuard.sol:e022a708420c` | open |
| [`zetaphy-network/contracts/BugBounty.sol:218`](../zetaphy-network/contracts/BugBounty.sol#L218) | slither / unused-return | unused-return — BugBounty.attest(uint256,bool) (contracts/BugBounty.sol#218-239) ignores return value by (None,None,active,agreed,rejected) = runners.worker <br>`slither:unused-return:zetaphy-network/contracts/BugBounty.sol:2abc5457edc6` | open |
| [`zetaphy-network/contracts/BugBounty.sol:242`](../zetaphy-network/contracts/BugBounty.sol#L242) | slither / unused-return | unused-return — BugBounty.claim(uint256) (contracts/BugBounty.sol#242-265) ignores return value by issuance.draw(b.subsidy) (contracts/BugBounty.sol#260) <br>`slither:unused-return:zetaphy-network/contracts/BugBounty.sol:9561930706f9` | open |
| [`zetaphy-network/contracts/BugBounty.sol:297`](../zetaphy-network/contracts/BugBounty.sol#L297) | slither / incorrect-equality | incorrect-equality — BugBounty.withdraw() (contracts/BugBounty.sol#297-304) uses a dangerous strict equality: - a == 0 (contracts/BugBounty.sol#299) <br>`slither:incorrect-equality:zetaphy-network/contracts/BugBounty.sol:d04447ff6156` | open |
| [`zetaphy-network/contracts/ComputeMarket.sol:74`](../zetaphy-network/contracts/ComputeMarket.sol#L74) | slither / unused-return | unused-return — ComputeMarket.take(uint256) (contracts/ComputeMarket.sol#74-82) ignores return value by (None,None,active,agreed,rejected) = runners.workers <br>`slither:unused-return:zetaphy-network/contracts/ComputeMarket.sol:5330e6055434` | open |
| [`zetaphy-network/contracts/DetectorPool.sol:115`](../zetaphy-network/contracts/DetectorPool.sol#L115) | slither / unused-return | unused-return — DetectorPool.register(bytes32,bytes32,uint32,string) (contracts/DetectorPool.sol#115-127) ignores return value by (n,None,sum) = foresight.t <br>`slither:unused-return:zetaphy-network/contracts/DetectorPool.sol:fccd096a2b39` | open |
| [`zetaphy-network/contracts/DetectorPool.sol:146`](../zetaphy-network/contracts/DetectorPool.sol#L146) | slither / incorrect-equality | incorrect-equality — DetectorPool.scoreRound() (contracts/DetectorPool.sol#146-182) uses a dangerous strict equality: - weight[i_scope_0] == 0 (contracts/Detecto <br>`slither:incorrect-equality:zetaphy-network/contracts/DetectorPool.sol:411456ee2dda` | open |
| [`zetaphy-network/contracts/DetectorPool.sol:150`](../zetaphy-network/contracts/DetectorPool.sol#L150) | slither / uninitialized-local | uninitialized-local — DetectorPool.scoreRound().totalWeight (contracts/DetectorPool.sol#150) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/DetectorPool.sol:7d042b7c5c30` | open |
| [`zetaphy-network/contracts/DetectorPool.sol:151`](../zetaphy-network/contracts/DetectorPool.sol#L151) | slither / uninitialized-local | uninitialized-local — DetectorPool.scoreRound().slashed (contracts/DetectorPool.sol#151) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/DetectorPool.sol:95a2379d5b61` | open |
| [`zetaphy-network/contracts/DetectorPool.sol:152`](../zetaphy-network/contracts/DetectorPool.sol#L152) | slither / uninitialized-local | uninitialized-local — DetectorPool.scoreRound().winners (contracts/DetectorPool.sol#152) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/DetectorPool.sol:405f9c255f49` | open |
| [`zetaphy-network/contracts/DetectorPool.sol:153`](../zetaphy-network/contracts/DetectorPool.sol#L153) | slither / uninitialized-local | uninitialized-local — DetectorPool.scoreRound().losers (contracts/DetectorPool.sol#153) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/DetectorPool.sol:6c6886c28bad` | open |
| [`zetaphy-network/contracts/DetectorPool.sol:163`](../zetaphy-network/contracts/DetectorPool.sol#L163) | slither / uninitialized-local | uninitialized-local — DetectorPool.scoreRound().paid (contracts/DetectorPool.sol#163) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/DetectorPool.sol:9e24d833f5da` | open |
| [`zetaphy-network/contracts/DetectorPool.sol:185`](../zetaphy-network/contracts/DetectorPool.sol#L185) | slither / unused-return | unused-return — DetectorPool._judge(uint32) (contracts/DetectorPool.sol#185-208) ignores return value by (n,None,sum) = foresight.tracks(o.modelId) (contrac <br>`slither:unused-return:zetaphy-network/contracts/DetectorPool.sol:ca77c608a316` | open |
| [`zetaphy-network/contracts/DetectorPool.sol:228`](../zetaphy-network/contracts/DetectorPool.sol#L228) | slither / incorrect-equality | incorrect-equality — DetectorPool.withdraw() (contracts/DetectorPool.sol#228-234) uses a dangerous strict equality: - a == 0 (contracts/DetectorPool.sol#230) <br>`slither:incorrect-equality:zetaphy-network/contracts/DetectorPool.sol:8a6811d5dcbd` | open |
| [`zetaphy-network/contracts/ForesightRegistry.sol:222`](../zetaphy-network/contracts/ForesightRegistry.sol#L222) | slither / divide-before-multiply | divide-before-multiply — ForesightRegistry.skill(bytes32) (contracts/ForesightRegistry.sol#222-229) performs a multiplication on the result of a division: - s = ((CO <br>`slither:divide-before-multiply:zetaphy-network/contracts/ForesightRegistry.sol:a57a474769bc` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:156`](../zetaphy-network/contracts/HackInsurance.sol#L156) | slither / incorrect-equality | incorrect-equality — HackInsurance.deposit() (contracts/HackInsurance.sol#156-163) uses a dangerous strict equality: - totalShares == 0 \|\| before == 0 (contrac <br>`slither:incorrect-equality:zetaphy-network/contracts/HackInsurance.sol:ba20a0b31eb4` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:156`](../zetaphy-network/contracts/HackInsurance.sol#L156) | slither / incorrect-equality | incorrect-equality — HackInsurance.deposit() (contracts/HackInsurance.sol#156-163) uses a dangerous strict equality: - s == 0 (contracts/HackInsurance.sol#159) <br>`slither:incorrect-equality:zetaphy-network/contracts/HackInsurance.sol:de85587896dd` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:243`](../zetaphy-network/contracts/HackInsurance.sol#L243) | slither / unused-return | unused-return — HackInsurance._checkRunner() (contracts/HackInsurance.sol#243-246) ignores return value by (None,None,active,agreed,rejected) = runners.work <br>`slither:unused-return:zetaphy-network/contracts/HackInsurance.sol:c917e92c9a04` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:314`](../zetaphy-network/contracts/HackInsurance.sol#L314) | slither / incorrect-equality | incorrect-equality — HackInsurance.payoutOf(uint256) (contracts/HackInsurance.sol#314-327) uses a dangerous strict equality: - uint64(block.timestamp / 86400) == <br>`slither:incorrect-equality:zetaphy-network/contracts/HackInsurance.sol:63b5e8a071b5` | open |
| [`zetaphy-network/contracts/HackInsurance.sol:361`](../zetaphy-network/contracts/HackInsurance.sol#L361) | slither / incorrect-equality | incorrect-equality — HackInsurance._send(address,uint256) (contracts/HackInsurance.sol#361-365) uses a dangerous strict equality: - amount == 0 (contracts/HackIn <br>`slither:incorrect-equality:zetaphy-network/contracts/HackInsurance.sol:150aaf855ea8` | open |
| [`zetaphy-network/contracts/HumanAgentLabels.sol:325`](../zetaphy-network/contracts/HumanAgentLabels.sol#L325) | slither / unused-return | unused-return — VouchRegistry.validVouches(address) (contracts/HumanAgentLabels.sol#325-333) ignores return value by (None,None,cred,None) = labels.humans(a <br>`slither:unused-return:zetaphy-network/contracts/HumanAgentLabels.sol:6e98e750dbda` | open |
| [`zetaphy-network/contracts/HumanAgentLabels.sol:363`](../zetaphy-network/contracts/HumanAgentLabels.sol#L363) | slither / unused-return | unused-return — VouchRegistry.vouch(address) (contracts/HumanAgentLabels.sol#363-381) ignores return value by (None,None,cred,None) = labels.humans(who) (co <br>`slither:unused-return:zetaphy-network/contracts/HumanAgentLabels.sol:ab24f66c340f` | open |
| [`zetaphy-network/contracts/HumanAgentLabels.sol:552`](../zetaphy-network/contracts/HumanAgentLabels.sol#L552) | slither / unused-return | unused-return — LabelFaucet.drip() (contracts/HumanAgentLabels.sol#552-567) ignores return value by (None,None,cred,None) = labels.humans(msg.sender) (contr <br>`slither:unused-return:zetaphy-network/contracts/HumanAgentLabels.sol:88553e993daa` | open |
| [`zetaphy-network/contracts/HyperlaneLane.sol:54`](../zetaphy-network/contracts/HyperlaneLane.sol#L54) | slither / locked-ether | locked-ether — Contract locking ether found: Contract HyperlaneLane (contracts/HyperlaneLane.sol#54-136) has payable functions: - IMessageRecipient.handle( <br>`slither:locked-ether:zetaphy-network/contracts/HyperlaneLane.sol:eb540e586c4c` | open |
| [`zetaphy-network/contracts/HyperlaneLockBoxV2.sol:245`](../zetaphy-network/contracts/HyperlaneLockBoxV2.sol#L245) | slither / incorrect-equality | incorrect-equality — HyperlaneLockBoxV2.remainingToday() (contracts/HyperlaneLockBoxV2.sol#245-248) uses a dangerous strict equality: - day == uint64(block.times <br>`slither:incorrect-equality:zetaphy-network/contracts/HyperlaneLockBoxV2.sol:1ad9a4c0470b` | open |
| [`zetaphy-network/contracts/IntentExecutor.sol:280`](../zetaphy-network/contracts/IntentExecutor.sol#L280) | slither / unused-return | unused-return — IntentExecutor._bridge(IntentExecutor.Intent,IntentExecutor.Plan) (contracts/IntentExecutor.sol#280-294) ignores return value by IIntentBrid <br>`slither:unused-return:zetaphy-network/contracts/IntentExecutor.sol:a11f99caac00` | open |
| [`zetaphy-network/contracts/IntentExecutor.sol:297`](../zetaphy-network/contracts/IntentExecutor.sol#L297) | slither / incorrect-equality | incorrect-equality — IntentExecutor._count(address,address,uint256) (contracts/IntentExecutor.sol#297-307) uses a dangerous strict equality: - c.perDay == 0 \|\| <br>`slither:incorrect-equality:zetaphy-network/contracts/IntentExecutor.sol:87271be65376` | open |
| [`zetaphy-network/contracts/IntentExecutor.sol:379`](../zetaphy-network/contracts/IntentExecutor.sol#L379) | slither / incorrect-equality | incorrect-equality — IntentExecutor._safe(address,bytes) (contracts/IntentExecutor.sol#379-382) uses a dangerous strict equality: - ! ok \|\| (ret.length != 0 && <br>`slither:incorrect-equality:zetaphy-network/contracts/IntentExecutor.sol:16e126052700` | open |
| [`zetaphy-network/contracts/ModelEpochs.sol:99`](../zetaphy-network/contracts/ModelEpochs.sol#L99) | slither / incorrect-equality | incorrect-equality — ModelEpochs.cancelLast() (contracts/ModelEpochs.sol#99-106) uses a dangerous strict equality: - n == 0 \|\| _versions[n - 1].activation <= b <br>`slither:incorrect-equality:zetaphy-network/contracts/ModelEpochs.sol:3f75437c06f9` | open |
| [`zetaphy-network/contracts/NeuroAttest.sol:90`](../zetaphy-network/contracts/NeuroAttest.sol#L90) | slither / unused-return | unused-return — NeuroAttest.attestFromJob(uint256,address) (contracts/NeuroAttest.sol#90-100) ignores return value by (skill,None,None,None,None) = jobs.job <br>`slither:unused-return:zetaphy-network/contracts/NeuroAttest.sol:89aaf256ad2d` | open |
| [`zetaphy-network/contracts/NeuroAttest.sol:90`](../zetaphy-network/contracts/NeuroAttest.sol#L90) | slither / unused-return | unused-return — NeuroAttest.attestFromJob(uint256,address) (contracts/NeuroAttest.sol#90-100) ignores return value by (None,None,None,settled) = jobs.assura <br>`slither:unused-return:zetaphy-network/contracts/NeuroAttest.sol:6d1f20b909d9` | open |
| [`zetaphy-network/contracts/NeuroAttest.sol:90`](../zetaphy-network/contracts/NeuroAttest.sol#L90) | slither / unused-return | unused-return — NeuroAttest.attestFromJob(uint256,address) (contracts/NeuroAttest.sol#90-100) ignores return value by (None,None,None,chain,target,None,resu <br>`slither:unused-return:zetaphy-network/contracts/NeuroAttest.sol:95526ed63275` | open |
| [`zetaphy-network/contracts/NeuroAttest.sol:132`](../zetaphy-network/contracts/NeuroAttest.sol#L132) | slither / incorrect-equality | incorrect-equality — NeuroAttest.badge(address) (contracts/NeuroAttest.sol#132-137) uses a dangerous strict equality: - uid == 0 (contracts/NeuroAttest.sol#134) <br>`slither:incorrect-equality:zetaphy-network/contracts/NeuroAttest.sol:11fc18c789c8` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:390`](../zetaphy-network/contracts/NeuroIdentity.sol#L390) | slither / incorrect-equality | incorrect-equality — NeuroIdentity.setAgentWallet(uint256,address,uint256,bytes) (contracts/NeuroIdentity.sol#390-403) uses a dangerous strict equality: - ! (ok  <br>`slither:incorrect-equality:zetaphy-network/contracts/NeuroIdentity.sol:99dfb80b1d31` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:509`](../zetaphy-network/contracts/NeuroIdentity.sol#L509) | slither / incorrect-equality | incorrect-equality — NeuroIdentity.finalizeClaim(uint256) (contracts/NeuroIdentity.sol#509-516) uses a dangerous strict equality: - p.readyAt == 0 (contracts/Neu <br>`slither:incorrect-equality:zetaphy-network/contracts/NeuroIdentity.sol:51bae27b703f` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:521`](../zetaphy-network/contracts/NeuroIdentity.sol#L521) | slither / incorrect-equality | incorrect-equality — NeuroIdentity.contestClaim(uint256) (contracts/NeuroIdentity.sol#521-529) uses a dangerous strict equality: - p.readyAt == 0 (contracts/Neur <br>`slither:incorrect-equality:zetaphy-network/contracts/NeuroIdentity.sol:32a1797f5af3` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:532`](../zetaphy-network/contracts/NeuroIdentity.sol#L532) | slither / unused-return | unused-return — NeuroIdentity._goodRunner(address) (contracts/NeuroIdentity.sol#532-536) ignores return value by (None,None,active,agreed,rejected) = claimR <br>`slither:unused-return:zetaphy-network/contracts/NeuroIdentity.sol:04f1d83a37a7` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:557`](../zetaphy-network/contracts/NeuroIdentity.sol#L557) | slither / uninitialized-local | uninitialized-local — NeuroIdentity._runnerQuorum(bytes32,bytes[]).last (contracts/NeuroIdentity.sol#557) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroIdentity.sol:11e2d0ece08e` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:684`](../zetaphy-network/contracts/NeuroIdentity.sol#L684) | slither / uninitialized-local | uninitialized-local — NeuroIdentity._addChain(string,string,uint8).colons (contracts/NeuroIdentity.sol#684) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroIdentity.sol:2cbc20dea3d8` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:740`](../zetaphy-network/contracts/NeuroIdentity.sol#L740) | slither / uninitialized-local | uninitialized-local — NeuroIdentity._parseAddress(bytes).v (contracts/NeuroIdentity.sol#740) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroIdentity.sol:d1331911a67f` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:751`](../zetaphy-network/contracts/NeuroIdentity.sol#L751) | slither / uninitialized-local | uninitialized-local — NeuroIdentity._toString(uint256).len (contracts/NeuroIdentity.sol#751) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroIdentity.sol:1f350789fca3` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:768`](../zetaphy-network/contracts/NeuroIdentity.sol#L768) | slither / divide-before-multiply | divide-before-multiply — NeuroIdentity._base64(bytes) (contracts/NeuroIdentity.sol#768-785) performs a multiplication on the result of a division: - out = new bytes( <br>`slither:divide-before-multiply:zetaphy-network/contracts/NeuroIdentity.sol:c5227acd7bc5` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:773`](../zetaphy-network/contracts/NeuroIdentity.sol#L773) | slither / uninitialized-local | uninitialized-local — NeuroIdentity._base64(bytes).j (contracts/NeuroIdentity.sol#773) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroIdentity.sol:b2e00aa6c9ff` | open |
| [`zetaphy-network/contracts/NeuroIdentity.sol:811`](../zetaphy-network/contracts/NeuroIdentity.sol#L811) | slither / divide-before-multiply | divide-before-multiply — NeuroTargets._tonRaw(bytes) (contracts/NeuroIdentity.sol#811-862) performs a multiplication on the result of a division: - k = (i / 4) * 3 ( <br>`slither:divide-before-multiply:zetaphy-network/contracts/NeuroIdentity.sol:2feae1aca7a8` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:343`](../zetaphy-network/contracts/NeuroJobs.sol#L343) | slither / incorrect-equality | incorrect-equality — NeuroJobsBase._toCommunity(uint256) (contracts/NeuroJobs.sol#343-347) uses a dangerous strict equality: - amount == 0 (contracts/NeuroJobs.s <br>`slither:incorrect-equality:zetaphy-network/contracts/NeuroJobs.sol:77b17865bf72` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:432`](../zetaphy-network/contracts/NeuroJobs.sol#L432) | slither / incorrect-equality | incorrect-equality — NeuroJobsBase.quarantined(address) (contracts/NeuroJobs.sol#432-436) uses a dangerous strict equality: - q == 0 (contracts/NeuroJobs.sol#434 <br>`slither:incorrect-equality:zetaphy-network/contracts/NeuroJobs.sol:bd71603cc61f` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:468`](../zetaphy-network/contracts/NeuroJobs.sol#L468) | slither / locked-ether | locked-ether — Contract locking ether found: Contract NeuroJobsChallenges (contracts/NeuroJobs.sol#468-624) has payable functions: - NeuroJobsChallenges.ch <br>`slither:locked-ether:zetaphy-network/contracts/NeuroJobs.sol:6d2a47fa12b6` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:552`](../zetaphy-network/contracts/NeuroJobs.sol#L552) | slither / uninitialized-local | uninitialized-local — NeuroJobsChallenges._resolve(uint256,NeuroJobsBase.Job,NeuroJobsBase.Challenge,bytes32).slashed (contracts/NeuroJobs.sol#552) is a local var <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroJobs.sol:cf0a6b962855` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:570`](../zetaphy-network/contracts/NeuroJobs.sol#L570) | slither / uninitialized-local | uninitialized-local — NeuroJobsChallenges._resolve(uint256,NeuroJobsBase.Job,NeuroJobsBase.Challenge,bytes32).n1 (contracts/NeuroJobs.sol#570) is a local variable <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroJobs.sol:440e5267a9d7` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:572`](../zetaphy-network/contracts/NeuroJobs.sol#L572) | slither / uninitialized-local | uninitialized-local — NeuroJobsChallenges._resolve(uint256,NeuroJobsBase.Job,NeuroJobsBase.Challenge,bytes32).n2 (contracts/NeuroJobs.sol#572) is a local variable <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroJobs.sol:096f7a91f8b4` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:576`](../zetaphy-network/contracts/NeuroJobs.sol#L576) | slither / uninitialized-local | uninitialized-local — NeuroJobsChallenges._resolve(uint256,NeuroJobsBase.Job,NeuroJobsBase.Challenge,bytes32).s2 (contracts/NeuroJobs.sol#576) is a local variable <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroJobs.sol:5d2ca7a9a4ec` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:586`](../zetaphy-network/contracts/NeuroJobs.sol#L586) | slither / uninitialized-local | uninitialized-local — NeuroJobsChallenges._resolve(uint256,NeuroJobsBase.Job,NeuroJobsBase.Challenge,bytes32).paid (contracts/NeuroJobs.sol#586) is a local variab <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroJobs.sol:886f3efc8a6f` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:603`](../zetaphy-network/contracts/NeuroJobs.sol#L603) | slither / divide-before-multiply | divide-before-multiply — NeuroJobsChallenges._dispute(uint256,NeuroJobsBase.Job,NeuroJobsBase.Challenge,bool) (contracts/NeuroJobs.sol#603-623) performs a multiplica <br>`slither:divide-before-multiply:zetaphy-network/contracts/NeuroJobs.sol:6badb3c58caa` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:819`](../zetaphy-network/contracts/NeuroJobs.sol#L819) | slither / incorrect-equality | incorrect-equality — NeuroJobs.withdraw() (contracts/NeuroJobs.sol#819-825) uses a dangerous strict equality: - amount == 0 (contracts/NeuroJobs.sol#821) <br>`slither:incorrect-equality:zetaphy-network/contracts/NeuroJobs.sol:6715d7844a96` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:843`](../zetaphy-network/contracts/NeuroJobs.sol#L843) | slither / uninitialized-local | uninitialized-local — NeuroJobs._request(address,bytes32,string).skill (contracts/NeuroJobs.sol#843) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroJobs.sol:84c0fb9ddb18` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:940`](../zetaphy-network/contracts/NeuroJobs.sol#L940) | slither / uninitialized-local | uninitialized-local — NeuroJobs.settle(uint256).any (contracts/NeuroJobs.sol#940) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroJobs.sol:aab569f64598` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:1116`](../zetaphy-network/contracts/NeuroJobs.sol#L1116) | slither / divide-before-multiply | divide-before-multiply — NeuroJobs._finalize(uint256,NeuroJobsBase.Job,bytes32) (contracts/NeuroJobs.sol#1116-1163) performs a multiplication on the result of a divi <br>`slither:divide-before-multiply:zetaphy-network/contracts/NeuroJobs.sol:3d359fe2ef5c` | open |
| [`zetaphy-network/contracts/NeuroJobs.sol:1116`](../zetaphy-network/contracts/NeuroJobs.sol#L1116) | slither / divide-before-multiply | divide-before-multiply — NeuroJobs._finalize(uint256,NeuroJobsBase.Job,bytes32) (contracts/NeuroJobs.sol#1116-1163) performs a multiplication on the result of a divi <br>`slither:divide-before-multiply:zetaphy-network/contracts/NeuroJobs.sol:d21a1f3dcfce` | open |
| [`zetaphy-network/contracts/NeuroOracle.sol:154`](../zetaphy-network/contracts/NeuroOracle.sol#L154) | slither / unused-return | unused-return — NeuroOracleSender.itemOf(bytes32) (contracts/NeuroOracle.sol#154-164) ignores return value by (flagged,reason,None,round,None,None,None,None <br>`slither:unused-return:zetaphy-network/contracts/NeuroOracle.sol:b0b1861f31ac` | open |
| [`zetaphy-network/contracts/NeuroOracle.sol:180`](../zetaphy-network/contracts/NeuroOracle.sol#L180) | slither / unused-return | unused-return — NeuroOracleSender.snapshot(uint256,uint256) (contracts/NeuroOracle.sol#180-194) ignores return value by (f,None,None,r,None,None,None,None)  <br>`slither:unused-return:zetaphy-network/contracts/NeuroOracle.sol:c831d65826c6` | open |
| [`zetaphy-network/contracts/NeuroOracle.sol:237`](../zetaphy-network/contracts/NeuroOracle.sol#L237) | slither / unused-return | unused-return — NeuroOracleSender.verdictBody(uint256) (contracts/NeuroOracle.sol#237-244) ignores return value by (agreedBy,None,None,settled) = jobs.assur <br>`slither:unused-return:zetaphy-network/contracts/NeuroOracle.sol:addf6dbf227a` | open |
| [`zetaphy-network/contracts/NeuroOracle.sol:237`](../zetaphy-network/contracts/NeuroOracle.sol#L237) | slither / unused-return | unused-return — NeuroOracleSender.verdictBody(uint256) (contracts/NeuroOracle.sol#237-244) ignores return value by (None,None,None,chain,target,None,result, <br>`slither:unused-return:zetaphy-network/contracts/NeuroOracle.sol:c7db4db9d419` | open |
| [`zetaphy-network/contracts/NeuroOracle.sol:237`](../zetaphy-network/contracts/NeuroOracle.sol#L237) | slither / unused-return | unused-return — NeuroOracleSender.verdictBody(uint256) (contracts/NeuroOracle.sol#237-244) ignores return value by (skill,None,None,None,None) = jobs.jobInf <br>`slither:unused-return:zetaphy-network/contracts/NeuroOracle.sol:f9d115b8abad` | open |
| [`zetaphy-network/contracts/NeuroOracle.sol:296`](../zetaphy-network/contracts/NeuroOracle.sol#L296) | slither / uninitialized-local | uninitialized-local — NeuroOracleSender._u(uint256).n (contracts/NeuroOracle.sol#296) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroOracle.sol:4141de79ee9b` | open |
| [`zetaphy-network/contracts/NeuroOracle.sol:325`](../zetaphy-network/contracts/NeuroOracle.sol#L325) | slither / locked-ether | locked-ether — Contract locking ether found: Contract NeuroOracle (contracts/NeuroOracle.sol#325-484) has payable functions: - NeuroOracle.handle(uint32,by <br>`slither:locked-ether:zetaphy-network/contracts/NeuroOracle.sol:0064094dc8f8` | open |
| [`zetaphy-network/contracts/NeuroScore.sol:166`](../zetaphy-network/contracts/NeuroScore.sol#L166) | slither / incorrect-equality | incorrect-equality — NeuroScore.rescore(address,bytes) (contracts/NeuroScore.sol#166-169) uses a dangerous strict equality: - _scores[token].featuresHash == byte <br>`slither:incorrect-equality:zetaphy-network/contracts/NeuroScore.sol:d39238a530f7` | open |
| [`zetaphy-network/contracts/NeuroValidation.sol:96`](../zetaphy-network/contracts/NeuroValidation.sol#L96) | slither / unused-return | unused-return — NeuroValidation.isRunner(address) (contracts/NeuroValidation.sol#96-99) ignores return value by (None,None,active,agreed,rejected) = runners <br>`slither:unused-return:zetaphy-network/contracts/NeuroValidation.sol:2ba377dc6a1e` | open |
| [`zetaphy-network/contracts/NeuroValidation.sol:127`](../zetaphy-network/contracts/NeuroValidation.sol#L127) | slither / unused-return | unused-return — NeuroValidation.postVerdict(uint256,bytes32,uint8,string,string) (contracts/NeuroValidation.sol#127-143) ignores return value by IIdentityRe <br>`slither:unused-return:zetaphy-network/contracts/NeuroValidation.sol:4fecea519533` | open |
| [`zetaphy-network/contracts/NeuroValidation.sol:136`](../zetaphy-network/contracts/NeuroValidation.sol#L136) | slither / uninitialized-local | uninitialized-local — NeuroValidation.postVerdict(uint256,bytes32,uint8,string,string).uri (contracts/NeuroValidation.sol#136) is a local variable never initializ <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroValidation.sol:e5882ab461dd` | open |
| [`zetaphy-network/contracts/NeuroValidation.sol:174`](../zetaphy-network/contracts/NeuroValidation.sol#L174) | slither / uninitialized-local | uninitialized-local — NeuroValidation.getSummary(uint256,address[],string).total (contracts/NeuroValidation.sol#174) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroValidation.sol:debc6071beac` | open |
| [`zetaphy-network/contracts/NeuroValidation.sol:181`](../zetaphy-network/contracts/NeuroValidation.sol#L181) | slither / uninitialized-local | uninitialized-local — NeuroValidation.getSummary(uint256,address[],string).found (contracts/NeuroValidation.sol#181) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/NeuroValidation.sol:9e00b8e08d8e` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:322`](../zetaphy-network/contracts/RedBlueArena.sol#L322) | slither / uninitialized-local | uninitialized-local — RedBlueArena._checkResult(uint256,uint256,uint256,int32[]).revealedMask (contracts/RedBlueArena.sol#322) is a local variable never initializ <br>`slither:uninitialized-local:zetaphy-network/contracts/RedBlueArena.sol:65c49e29ee69` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:334`](../zetaphy-network/contracts/RedBlueArena.sol#L334) | slither / uninitialized-local | uninitialized-local — RedBlueArena.finalize(uint256).best (contracts/RedBlueArena.sol#334) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/RedBlueArena.sol:98043e79c464` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:335`](../zetaphy-network/contracts/RedBlueArena.sol#L335) | slither / uninitialized-local | uninitialized-local — RedBlueArena.finalize(uint256).bestVotes (contracts/RedBlueArena.sol#335) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/RedBlueArena.sol:848325518a93` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:425`](../zetaphy-network/contracts/RedBlueArena.sol#L425) | slither / uninitialized-local | uninitialized-local — RedBlueArena.settle(uint256).redPaid (contracts/RedBlueArena.sol#425) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/RedBlueArena.sol:7ab2306149bf` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:426`](../zetaphy-network/contracts/RedBlueArena.sol#L426) | slither / uninitialized-local | uninitialized-local — RedBlueArena.settle(uint256).bluePaid (contracts/RedBlueArena.sol#426) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/RedBlueArena.sol:36627911f1e4` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:464`](../zetaphy-network/contracts/RedBlueArena.sol#L464) | slither / uninitialized-local | uninitialized-local — RedBlueArena._payBlue(uint256,uint256).total (contracts/RedBlueArena.sol#464) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/RedBlueArena.sol:6d32a324c15b` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:478`](../zetaphy-network/contracts/RedBlueArena.sol#L478) | slither / divide-before-multiply | divide-before-multiply — RedBlueArena._payRunners(uint256,uint256) (contracts/RedBlueArena.sol#478-486) performs a multiplication on the result of a division: - each <br>`slither:divide-before-multiply:zetaphy-network/contracts/RedBlueArena.sol:84b7a7debe18` | open |
| [`zetaphy-network/contracts/RedBlueArena.sol:480`](../zetaphy-network/contracts/RedBlueArena.sol#L480) | slither / uninitialized-local | uninitialized-local — RedBlueArena._payRunners(uint256,uint256).n (contracts/RedBlueArena.sol#480) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/RedBlueArena.sol:ceb8c35b824a` | open |
| [`zetaphy-network/contracts/RewardVault.sol:71`](../zetaphy-network/contracts/RewardVault.sol#L71) | slither / incorrect-equality | incorrect-equality — RewardVault.releasable() (contracts/RewardVault.sol#71-76) uses a dangerous strict equality: - n == 0 (contracts/RewardVault.sol#73) <br>`slither:incorrect-equality:zetaphy-network/contracts/RewardVault.sol:7bd3775d619f` | open |
| [`zetaphy-network/contracts/RewardVault.sol:79`](../zetaphy-network/contracts/RewardVault.sol#L79) | slither / incorrect-equality | incorrect-equality — RewardVault.release() (contracts/RewardVault.sol#79-99) uses a dangerous strict equality: - amount == 0 (contracts/RewardVault.sol#82) <br>`slither:incorrect-equality:zetaphy-network/contracts/RewardVault.sol:963f763b8bc3` | open |
| [`zetaphy-network/contracts/RewardVault.sol:127`](../zetaphy-network/contracts/RewardVault.sol#L127) | slither / incorrect-equality | incorrect-equality — RewardVault.applyShares() (contracts/RewardVault.sol#127-138) uses a dangerous strict equality: - pendingAt == 0 \|\| block.timestamp < pend <br>`slither:incorrect-equality:zetaphy-network/contracts/RewardVault.sol:c13c32babe9d` | open |
| [`zetaphy-network/contracts/RewardVault.sol:149`](../zetaphy-network/contracts/RewardVault.sol#L149) | slither / uninitialized-local | uninitialized-local — RewardVault._check(RewardVault.Share[]).total (contracts/RewardVault.sol#149) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/RewardVault.sol:a3f8d7aaaff9` | open |
| [`zetaphy-network/contracts/RewardVault.sol:158`](../zetaphy-network/contracts/RewardVault.sol#L158) | slither / divide-before-multiply | divide-before-multiply — RewardVault._rpow(uint256,uint256) (contracts/RewardVault.sol#158-164) performs a multiplication on the result of a division: - x = (x * x + <br>`slither:divide-before-multiply:zetaphy-network/contracts/RewardVault.sol:44be65eec61f` | open |
| [`zetaphy-network/contracts/RiskForecasts.sol:145`](../zetaphy-network/contracts/RiskForecasts.sol#L145) | slither / uninitialized-local | uninitialized-local — RiskForecasts.open(address,address,RiskForecasts.Kind,uint16,uint64,uint64).base (contracts/RiskForecasts.sol#145) is a local variable never <br>`slither:uninitialized-local:zetaphy-network/contracts/RiskForecasts.sol:0509ccf47815` | open |
| [`zetaphy-network/contracts/RiskForecasts.sol:183`](../zetaphy-network/contracts/RiskForecasts.sol#L183) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in RiskForecasts.poke(uint256) (contracts/RiskForecasts.sol#183-204): External calls: - foresight.closeCommits(s.foresightId) (co <br>`slither:reentrancy-no-eth:zetaphy-network/contracts/RiskForecasts.sol:45cc34c20a3d` | open |
| [`zetaphy-network/contracts/RiskForecasts.sol:207`](../zetaphy-network/contracts/RiskForecasts.sol#L207) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in RiskForecasts.propose(uint256) (contracts/RiskForecasts.sol#207-220): External calls: - poke(id) (contracts/RiskForecasts.sol# <br>`slither:reentrancy-no-eth:zetaphy-network/contracts/RiskForecasts.sol:cda1a5562b01` | open |
| [`zetaphy-network/contracts/RiskForecasts.sol:212`](../zetaphy-network/contracts/RiskForecasts.sol#L212) | slither / uninitialized-local | uninitialized-local — RiskForecasts.propose(uint256).a (contracts/RiskForecasts.sol#212) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/RiskForecasts.sol:e98da32c156d` | open |
| [`zetaphy-network/contracts/RiskForecasts.sol:300`](../zetaphy-network/contracts/RiskForecasts.sol#L300) | slither / unused-return | unused-return — RiskForecasts._flagged(address) (contracts/RiskForecasts.sol#300-306) ignores return value by (c,None) = threats.isContractFlagged(token) (c <br>`slither:unused-return:zetaphy-network/contracts/RiskForecasts.sol:81a121382d1d` | open |
| [`zetaphy-network/contracts/RiskForecasts.sol:300`](../zetaphy-network/contracts/RiskForecasts.sol#L300) | slither / unused-return | unused-return — RiskForecasts._flagged(address) (contracts/RiskForecasts.sol#300-306) ignores return value by (a,None) = threats.isAddressFlagged(block.chai <br>`slither:unused-return:zetaphy-network/contracts/RiskForecasts.sol:8e9fd60ffbcd` | open |
| [`zetaphy-network/contracts/RiskForecasts.sol:309`](../zetaphy-network/contracts/RiskForecasts.sol#L309) | slither / unused-return | unused-return — RiskForecasts._otherReserve(address,address) (contracts/RiskForecasts.sol#309-316) ignores return value by (r0,r1,None) = IRiskPair(pair).ge <br>`slither:unused-return:zetaphy-network/contracts/RiskForecasts.sol:e95412229913` | open |
| [`zetaphy-network/contracts/SaphanTokens.sol:261`](../zetaphy-network/contracts/SaphanTokens.sol#L261) | slither / incorrect-equality | incorrect-equality — SaphanTokenEndpoint.remainingToday() (contracts/SaphanTokens.sol#261-264) uses a dangerous strict equality: - day == uint64(block.timestamp  <br>`slither:incorrect-equality:zetaphy-network/contracts/SaphanTokens.sol:d5561344f294` | open |
| [`zetaphy-network/contracts/SaphanTokens.sol:375`](../zetaphy-network/contracts/SaphanTokens.sol#L375) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in ZetaphyTokenVault._take(address,uint256) (contracts/SaphanTokens.sol#375-383): External calls: - _call(abi.encodeWithSignature <br>`slither:reentrancy-no-eth:zetaphy-network/contracts/SaphanTokens.sol:f386d4dd2c2c` | open |
| [`zetaphy-network/contracts/SaphanTokens.sol:404`](../zetaphy-network/contracts/SaphanTokens.sol#L404) | slither / unused-return | unused-return — ZetaphyTokenVault._held(address) (contracts/SaphanTokens.sol#404-408) ignores return value by (h,None) = t.isContractHeld(who) (contracts/Sa <br>`slither:unused-return:zetaphy-network/contracts/SaphanTokens.sol:f998d5e580c4` | open |
| [`zetaphy-network/contracts/StableGateway.sol:196`](../zetaphy-network/contracts/StableGateway.sol#L196) | slither / unused-return | unused-return — StableGateway._price(address) (contracts/StableGateway.sol#196-199) ignores return value by (value) = oracle.price(asset) (contracts/StableG <br>`slither:unused-return:zetaphy-network/contracts/StableGateway.sol:cc381f487f72` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:350`](../zetaphy-network/contracts/ThreatRegistry.sol#L350) | slither / incorrect-equality | incorrect-equality — ThreatRegistry.holdNow(bytes32) (contracts/ThreatRegistry.sol#350-357) uses a dangerous strict equality: - e.fast \|\| heldNow[key].round == <br>`slither:incorrect-equality:zetaphy-network/contracts/ThreatRegistry.sol:833f39880e49` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:397`](../zetaphy-network/contracts/ThreatRegistry.sol#L397) | slither / unused-return | unused-return — ThreatRegistry._checkRunner() (contracts/ThreatRegistry.sol#397-400) ignores return value by (None,None,active,agreed,rejected) = runners.wo <br>`slither:unused-return:zetaphy-network/contracts/ThreatRegistry.sol:f310f448cd20` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:604`](../zetaphy-network/contracts/ThreatRegistry.sol#L604) | slither / uninitialized-local | uninitialized-local — ThreatRegistry.responseAt(bytes32,uint256).who (contracts/ThreatRegistry.sol#604) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/ThreatRegistry.sol:5812f6fbc083` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:709`](../zetaphy-network/contracts/ThreatRegistry.sol#L709) | slither / incorrect-equality | incorrect-equality — ThreatRegistry.payFund() (contracts/ThreatRegistry.sol#709-716) uses a dangerous strict equality: - amount == 0 (contracts/ThreatRegistry.so <br>`slither:incorrect-equality:zetaphy-network/contracts/ThreatRegistry.sol:d4c322d79d26` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:718`](../zetaphy-network/contracts/ThreatRegistry.sol#L718) | slither / incorrect-equality | incorrect-equality — ThreatRegistry._pay(address,uint256) (contracts/ThreatRegistry.sol#718-723) uses a dangerous strict equality: - amount == 0 (contracts/Threa <br>`slither:incorrect-equality:zetaphy-network/contracts/ThreatRegistry.sol:a5eafe771ea7` | open |
| [`zetaphy-network/contracts/ThreatRegistry.sol:762`](../zetaphy-network/contracts/ThreatRegistry.sol#L762) | slither / incorrect-equality | incorrect-equality — ThreatRegistry.isHeld(bytes32) (contracts/ThreatRegistry.sol#762-767) uses a dangerous strict equality: - e.fast \|\| heldNow[key].round ==  <br>`slither:incorrect-equality:zetaphy-network/contracts/ThreatRegistry.sol:86a664a56f27` | open |
| [`zetaphy-network/contracts/ThreatReports.sol:92`](../zetaphy-network/contracts/ThreatReports.sol#L92) | slither / unused-return | unused-return — ThreatReports.report(bytes32,bytes32,address,string) (contracts/ThreatReports.sol#92-101) ignores return value by (flagged,None,None,None,No <br>`slither:unused-return:zetaphy-network/contracts/ThreatReports.sol:e3754dac4d82` | open |
| [`zetaphy-network/contracts/ThreatReports.sol:105`](../zetaphy-network/contracts/ThreatReports.sol#L105) | slither / unused-return | unused-return — ThreatReports.settle(uint256) (contracts/ThreatReports.sol#105-122) ignores return value by (flagged,None,updatedAt,round,None,None,None,Non <br>`slither:unused-return:zetaphy-network/contracts/ThreatReports.sol:5af769ea6255` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:59`](../zetaphy-network/contracts/TwapRecorder.sol#L59) | slither / incorrect-equality | incorrect-equality — TwapRecorder.record(address) (contracts/TwapRecorder.sol#59-73) uses a dangerous strict equality: - d == 0 (contracts/TwapRecorder.sol#66) <br>`slither:incorrect-equality:zetaphy-network/contracts/TwapRecorder.sol:a978358c0d7b` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:76`](../zetaphy-network/contracts/TwapRecorder.sol#L76) | slither / divide-before-multiply | divide-before-multiply — TwapRecorder.current(address) (contracts/TwapRecorder.sol#76-89) performs a multiplication on the result of a division: - c1 += ((uint256(r0 <br>`slither:divide-before-multiply:zetaphy-network/contracts/TwapRecorder.sol:0aea1ca35cd6` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:76`](../zetaphy-network/contracts/TwapRecorder.sol#L76) | slither / divide-before-multiply | divide-before-multiply — TwapRecorder.current(address) (contracts/TwapRecorder.sol#76-89) performs a multiplication on the result of a division: - c0 += ((uint256(r1 <br>`slither:divide-before-multiply:zetaphy-network/contracts/TwapRecorder.sol:af41279ae446` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:109`](../zetaphy-network/contracts/TwapRecorder.sol#L109) | slither / incorrect-equality | incorrect-equality — TwapRecorder.consult(address,uint32) (contracts/TwapRecorder.sol#109-130) uses a dangerous strict equality: - span == 0 (contracts/TwapRecor <br>`slither:incorrect-equality:zetaphy-network/contracts/TwapRecorder.sol:e42c92a0b9a6` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:160`](../zetaphy-network/contracts/TwapRecorder.sol#L160) | slither / divide-before-multiply | divide-before-multiply — TwapRecorder._mulDiv(uint256,uint256,uint256) (contracts/TwapRecorder.sol#160-189) performs a multiplication on the result of a division: -  <br>`slither:divide-before-multiply:zetaphy-network/contracts/TwapRecorder.sol:3751687bcbf2` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:160`](../zetaphy-network/contracts/TwapRecorder.sol#L160) | slither / divide-before-multiply | divide-before-multiply — TwapRecorder._mulDiv(uint256,uint256,uint256) (contracts/TwapRecorder.sol#160-189) performs a multiplication on the result of a division: -  <br>`slither:divide-before-multiply:zetaphy-network/contracts/TwapRecorder.sol:c98daa1b0e21` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:160`](../zetaphy-network/contracts/TwapRecorder.sol#L160) | slither / divide-before-multiply | divide-before-multiply — TwapRecorder._mulDiv(uint256,uint256,uint256) (contracts/TwapRecorder.sol#160-189) performs a multiplication on the result of a division: -  <br>`slither:divide-before-multiply:zetaphy-network/contracts/TwapRecorder.sol:83600015155a` | open |
| [`zetaphy-network/contracts/TwapRecorder.sol:160`](../zetaphy-network/contracts/TwapRecorder.sol#L160) | slither / incorrect-equality | incorrect-equality — TwapRecorder._mulDiv(uint256,uint256,uint256) (contracts/TwapRecorder.sol#160-189) uses a dangerous strict equality: - prod1 == 0 (contracts <br>`slither:incorrect-equality:zetaphy-network/contracts/TwapRecorder.sol:71989048ae9a` | open |
| [`zetaphy-network/contracts/UsefulIssuance.sol:130`](../zetaphy-network/contracts/UsefulIssuance.sol#L130) | slither / uninitialized-local | uninitialized-local — UsefulIssuance.setBuckets(UsefulIssuance.Bucket[]).total (contracts/UsefulIssuance.sol#130) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/UsefulIssuance.sol:e4d477c11244` | open |
| [`zetaphy-network/contracts/UsefulIssuance.sol:137`](../zetaphy-network/contracts/UsefulIssuance.sol#L137) | slither / uninitialized-local | uninitialized-local — UsefulIssuance.setBuckets(UsefulIssuance.Bucket[]).free (contracts/UsefulIssuance.sol#137) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/UsefulIssuance.sol:6b1b3784f2ab` | open |
| [`zetaphy-network/contracts/UsefulIssuance.sol:141`](../zetaphy-network/contracts/UsefulIssuance.sol#L141) | slither / uninitialized-local | uninitialized-local — UsefulIssuance.setBuckets(UsefulIssuance.Bucket[]).kept (contracts/UsefulIssuance.sol#141) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/UsefulIssuance.sol:3b294233e0a8` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:251`](../zetaphy-network/contracts/UsefulWork.sol#L251) | slither / uninitialized-local | uninitialized-local — UsefulWork.commitMany(uint256[],bytes32[]).total (contracts/UsefulWork.sol#251) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/UsefulWork.sol:9f8515458f23` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:321`](../zetaphy-network/contracts/UsefulWork.sol#L321) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in UsefulWork.settle(uint256) (contracts/UsefulWork.sol#321-349): External calls: - pot += _subsidy(params.subsidy * agreed) (con <br>`slither:reentrancy-no-eth:zetaphy-network/contracts/UsefulWork.sol:52bfb1d3679f` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:321`](../zetaphy-network/contracts/UsefulWork.sol#L321) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in UsefulWork.settle(uint256) (contracts/UsefulWork.sol#321-349): External calls: - pot += _subsidy(params.subsidy * agreed) (con <br>`slither:reentrancy-no-eth:zetaphy-network/contracts/UsefulWork.sol:ee3429e03bbe` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:334`](../zetaphy-network/contracts/UsefulWork.sol#L334) | slither / uninitialized-local | uninitialized-local — UsefulWork.settle(uint256).agreed (contracts/UsefulWork.sol#334) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/UsefulWork.sol:b6c494abe16c` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:338`](../zetaphy-network/contracts/UsefulWork.sol#L338) | slither / uninitialized-local | uninitialized-local — UsefulWork.settle(uint256).pot (contracts/UsefulWork.sol#338) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/UsefulWork.sol:0b9284677ffa` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:436`](../zetaphy-network/contracts/UsefulWork.sol#L436) | slither / uninitialized-local | uninitialized-local — UsefulWork.openJobs(uint256,uint256).n (contracts/UsefulWork.sol#436) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/UsefulWork.sol:fb51586ba23a` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:474`](../zetaphy-network/contracts/UsefulWork.sol#L474) | slither / uninitialized-local | uninitialized-local — UsefulWork._majority(uint256,address[],uint8).n (contracts/UsefulWork.sol#474) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/UsefulWork.sol:4e5ab42ab5f8` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:482`](../zetaphy-network/contracts/UsefulWork.sol#L482) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in UsefulWork._subsidy(uint256) (contracts/UsefulWork.sol#482-494): External calls: - issuance.draw(want - got) (contracts/Useful <br>`slither:reentrancy-no-eth:zetaphy-network/contracts/UsefulWork.sol:35688b5c8094` | open |
| [`zetaphy-network/contracts/UsefulWork.sol:482`](../zetaphy-network/contracts/UsefulWork.sol#L482) | slither / unused-return | unused-return — UsefulWork._subsidy(uint256) (contracts/UsefulWork.sol#482-494) ignores return value by issuance.draw(want - got) (contracts/UsefulWork.sol# <br>`slither:unused-return:zetaphy-network/contracts/UsefulWork.sol:c6127c13bddc` | open |
| [`zetaphy-network/contracts/WorkerReputation.sol:143`](../zetaphy-network/contracts/WorkerReputation.sol#L143) | slither / unused-return | unused-return — WorkerReputation.weights(address) (contracts/WorkerReputation.sol#143-153) ignores return value by (agreed,rejected) = runners.workers(worke <br>`slither:unused-return:zetaphy-network/contracts/WorkerReputation.sol:e338dab50616` | open |
| [`zetaphy-network/contracts/ZetaphyEarlyFarm.sol:92`](../zetaphy-network/contracts/ZetaphyEarlyFarm.sol#L92) | slither / incorrect-equality | incorrect-equality — ZetaphyEarlyFarm.getReward() (contracts/ZetaphyEarlyFarm.sol#92-99) uses a dangerous strict equality: - r == 0 (contracts/ZetaphyEarlyFarm.s <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyEarlyFarm.sol:0a2af09edff9` | open |
| [`zetaphy-network/contracts/ZetaphyEarlyFarm.sol:101`](../zetaphy-network/contracts/ZetaphyEarlyFarm.sol#L101) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in ZetaphyEarlyFarm.exit() (contracts/ZetaphyEarlyFarm.sol#101-105): External calls: - withdraw(b) (contracts/ZetaphyEarlyFarm.so <br>`slither:reentrancy-no-eth:zetaphy-network/contracts/ZetaphyEarlyFarm.sol:ee4df0b1af2e` | open |
| [`zetaphy-network/contracts/ZetaphyEarlyFarm.sol:109`](../zetaphy-network/contracts/ZetaphyEarlyFarm.sol#L109) | slither / divide-before-multiply | divide-before-multiply — ZetaphyEarlyFarm.notifyReward(uint256,uint256) (contracts/ZetaphyEarlyFarm.sol#109-121) performs a multiplication on the result of a divisio <br>`slither:divide-before-multiply:zetaphy-network/contracts/ZetaphyEarlyFarm.sol:fa1c9b8e8b85` | open |
| [`zetaphy-network/contracts/ZetaphyEarlyFarm.sol:109`](../zetaphy-network/contracts/ZetaphyEarlyFarm.sol#L109) | slither / divide-before-multiply | divide-before-multiply — ZetaphyEarlyFarm.notifyReward(uint256,uint256) (contracts/ZetaphyEarlyFarm.sol#109-121) performs a multiplication on the result of a divisio <br>`slither:divide-before-multiply:zetaphy-network/contracts/ZetaphyEarlyFarm.sol:8d9a4acb15ca` | open |
| [`zetaphy-network/contracts/ZetaphyEarlyPass.sol:141`](../zetaphy-network/contracts/ZetaphyEarlyPass.sol#L141) | slither / uninitialized-local | uninitialized-local — ZetaphyEarlyPass._str(uint256).len (contracts/ZetaphyEarlyPass.sol#141) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/ZetaphyEarlyPass.sol:8cd136ce421c` | open |
| [`zetaphy-network/contracts/ZetaphyEarlyPass.sol:148`](../zetaphy-network/contracts/ZetaphyEarlyPass.sol#L148) | slither / divide-before-multiply | divide-before-multiply — ZetaphyEarlyPass._b64(bytes) (contracts/ZetaphyEarlyPass.sol#148-165) performs a multiplication on the result of a division: - out = new byt <br>`slither:divide-before-multiply:zetaphy-network/contracts/ZetaphyEarlyPass.sol:48950649a8bc` | open |
| [`zetaphy-network/contracts/ZetaphyEarlyPass.sol:153`](../zetaphy-network/contracts/ZetaphyEarlyPass.sol#L153) | slither / uninitialized-local | uninitialized-local — ZetaphyEarlyPass._b64(bytes).j (contracts/ZetaphyEarlyPass.sol#153) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/ZetaphyEarlyPass.sol:ddb895cf2b18` | open |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:197`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L197) | slither / unused-return | unused-return — ZetaphyOfflineOrders._swap(ZetaphyOfflineOrders.Order,address[],address,uint256) (contracts/ZetaphyOfflineOrders.sol#197-206) ignores return <br>`slither:unused-return:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:e2d820faabc6` | open |
| [`zetaphy-network/contracts/ZetaphyOfflineOrders.sol:197`](../zetaphy-network/contracts/ZetaphyOfflineOrders.sol#L197) | slither / unused-return | unused-return — ZetaphyOfflineOrders._swap(ZetaphyOfflineOrders.Order,address[],address,uint256) (contracts/ZetaphyOfflineOrders.sol#197-206) ignores return <br>`slither:unused-return:zetaphy-network/contracts/ZetaphyOfflineOrders.sol:24a7fa36acb4` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:177`](../zetaphy-network/contracts/ZetaphyOracle.sol#L177) | slither / uninitialized-local | uninitialized-local — ZetaphyOracle.setTwap(address,address,uint32,uint16,uint16,uint128).c (contracts/ZetaphyOracle.sol#177) is a local variable never initialize <br>`slither:uninitialized-local:zetaphy-network/contracts/ZetaphyOracle.sol:aa266abfd888` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:239`](../zetaphy-network/contracts/ZetaphyOracle.sol#L239) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle.price(address) (contracts/ZetaphyOracle.sol#239-250) uses a dangerous strict equality: - s.lastPrice == 0 (contracts/ZetaphyOr <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:d612fc7a7689` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:260`](../zetaphy-network/contracts/ZetaphyOracle.sol#L260) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle.poke(address) (contracts/ZetaphyOracle.sol#260-293) uses a dangerous strict equality: - p == Problem.SourcesDeviate (contracts <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:e3fb6bb8abbc` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:260`](../zetaphy-network/contracts/ZetaphyOracle.sol#L260) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle.poke(address) (contracts/ZetaphyOracle.sol#260-293) uses a dangerous strict equality: - p == Problem.TwapStale (contracts/Zeta <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:2917b78f5e37` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:260`](../zetaphy-network/contracts/ZetaphyOracle.sol#L260) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle.poke(address) (contracts/ZetaphyOracle.sol#260-293) uses a dangerous strict equality: - p == Problem.PythStale (contracts/Zeta <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:3b40aebff687` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:260`](../zetaphy-network/contracts/ZetaphyOracle.sol#L260) | slither / unused-return | unused-return — ZetaphyOracle.poke(address) (contracts/ZetaphyOracle.sol#260-293) ignores return value by recorder.record(pair) (contracts/ZetaphyOracle.sol <br>`slither:unused-return:zetaphy-network/contracts/ZetaphyOracle.sol:83b3bf7852af` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:314`](../zetaphy-network/contracts/ZetaphyOracle.sol#L314) | slither / uninitialized-local | uninitialized-local — ZetaphyOracle._live(address).twapValue (contracts/ZetaphyOracle.sol#314) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/ZetaphyOracle.sol:f60be5bc0904` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:314`](../zetaphy-network/contracts/ZetaphyOracle.sol#L314) | slither / uninitialized-local | uninitialized-local — ZetaphyOracle._live(address).twapAt (contracts/ZetaphyOracle.sol#314) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/ZetaphyOracle.sol:ea7d55d39e23` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:319`](../zetaphy-network/contracts/ZetaphyOracle.sol#L319) | slither / uninitialized-local | uninitialized-local — ZetaphyOracle._live(address).pythValue (contracts/ZetaphyOracle.sol#319) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/ZetaphyOracle.sol:7d365aaef970` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:319`](../zetaphy-network/contracts/ZetaphyOracle.sol#L319) | slither / uninitialized-local | uninitialized-local — ZetaphyOracle._live(address).pythAt (contracts/ZetaphyOracle.sol#319) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/ZetaphyOracle.sol:62a9c643e087` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:332`](../zetaphy-network/contracts/ZetaphyOracle.sol#L332) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._twap(ZetaphyOracle.TwapConfig) (contracts/ZetaphyOracle.sol#332-347) uses a dangerous strict equality: - value == 0 \|\| valu <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:313d6673487f` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:333`](../zetaphy-network/contracts/ZetaphyOracle.sol#L333) | slither / uninitialized-local | uninitialized-local — ZetaphyOracle._twap(ZetaphyOracle.TwapConfig).w (contracts/ZetaphyOracle.sol#333) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/ZetaphyOracle.sol:544f5487384a` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:350`](../zetaphy-network/contracts/ZetaphyOracle.sol#L350) | slither / uninitialized-local | uninitialized-local — ZetaphyOracle._pyth(ZetaphyOracle.PythConfig).q (contracts/ZetaphyOracle.sol#350) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-network/contracts/ZetaphyOracle.sol:4409d554b546` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:8875bab1afbe` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:36a6dd3dc420` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:c66f1778c0a3` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:77c54965809e` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:2978adc05016` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:688e0bb36ea7` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:7407a8e85b3f` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:c0259de5ed4e` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:248f6af7a5b3` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:364`](../zetaphy-network/contracts/ZetaphyOracle.sol#L364) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._fail(address,ZetaphyOracle.Problem,uint256,uint256) (contracts/ZetaphyOracle.sol#364-376) uses a dangerous strict equality: - <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:18f81c479350` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:379`](../zetaphy-network/contracts/ZetaphyOracle.sol#L379) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._bps(uint256,uint256) (contracts/ZetaphyOracle.sol#379-383) uses a dangerous strict equality: - lo == 0 (contracts/ZetaphyOrac <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:6ef103143fd2` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:393`](../zetaphy-network/contracts/ZetaphyOracle.sol#L393) | slither / divide-before-multiply | divide-before-multiply — ZetaphyOracle._mulDiv(uint256,uint256,uint256) (contracts/ZetaphyOracle.sol#393-422) performs a multiplication on the result of a division:  <br>`slither:divide-before-multiply:zetaphy-network/contracts/ZetaphyOracle.sol:0725c4aff63e` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:393`](../zetaphy-network/contracts/ZetaphyOracle.sol#L393) | slither / divide-before-multiply | divide-before-multiply — ZetaphyOracle._mulDiv(uint256,uint256,uint256) (contracts/ZetaphyOracle.sol#393-422) performs a multiplication on the result of a division:  <br>`slither:divide-before-multiply:zetaphy-network/contracts/ZetaphyOracle.sol:acb7f1b0b061` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:393`](../zetaphy-network/contracts/ZetaphyOracle.sol#L393) | slither / divide-before-multiply | divide-before-multiply — ZetaphyOracle._mulDiv(uint256,uint256,uint256) (contracts/ZetaphyOracle.sol#393-422) performs a multiplication on the result of a division:  <br>`slither:divide-before-multiply:zetaphy-network/contracts/ZetaphyOracle.sol:57d7c96fea01` | open |
| [`zetaphy-network/contracts/ZetaphyOracle.sol:393`](../zetaphy-network/contracts/ZetaphyOracle.sol#L393) | slither / incorrect-equality | incorrect-equality — ZetaphyOracle._mulDiv(uint256,uint256,uint256) (contracts/ZetaphyOracle.sol#393-422) uses a dangerous strict equality: - prod1 == 0 (contrac <br>`slither:incorrect-equality:zetaphy-network/contracts/ZetaphyOracle.sol:2baf2feb14c8` | open |
| [`zetaphy-network/contracts/ZetaphyPythRelay.sol:48`](../zetaphy-network/contracts/ZetaphyPythRelay.sol#L48) | slither / locked-ether | locked-ether — Contract locking ether found: Contract ZetaphyPythRelay (contracts/ZetaphyPythRelay.sol#48-146) has payable functions: - IPythLike.updatePri <br>`slither:locked-ether:zetaphy-network/contracts/ZetaphyPythRelay.sol:0bee946a2d85` | open |
| [`zetaphy-network/contracts/ZetaphyQuests.sol:61`](../zetaphy-network/contracts/ZetaphyQuests.sol#L61) | slither / reentrancy-no-eth | reentrancy-no-eth — Reentrancy in ZetaphyQuests.pay(uint8,address[]) (contracts/ZetaphyQuests.sol#61-75): External calls: - ! token.transfer(a,s.reward) (contra <br>`slither:reentrancy-no-eth:zetaphy-network/contracts/ZetaphyQuests.sol:6aa15c21c8fc` | open |
| [`zetaphy-nft/contracts/CollectionBase.sol:215`](../zetaphy-nft/contracts/CollectionBase.sol#L215) | slither / uninitialized-local | uninitialized-local — CollectionBase._toString(uint256).len (contracts/CollectionBase.sol#215) is a local variable never initialized <br>`slither:uninitialized-local:zetaphy-nft/contracts/CollectionBase.sol:a6e3fd225a41` | open |
| `zetaphy-chain:evmd/app.go:587` | staticcheck / SA1019 | SA1019 ratelimitv2.NewIBCMiddleware is deprecated: use NewIBCMiddlewareWithAsync — ratelimitv2.NewIBCMiddleware is deprecated: use NewIBCMiddlewareWithAsyncAcknowledgements when the middleware may be used in the IBC v2 asyn <br>`staticcheck:SA1019:zetaphy-chain:evmd/app.go:c14d745206f9` | open |

### Low (1272)

Grouped by rule; every instance with its id is in `findings.json` of the workflow artifact.

| Tool / rule | Count | Example |
|---|---:|---|
| aderyn / literal-instead-of-constant | 249 | [`zetaphy-dex/contracts/dlmm/DlmmMath.sol:158`](../zetaphy-dex/contracts/dlmm/DlmmMath.sol#L158) Literal Instead of Constant |
| slither / timestamp | 215 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:232`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L232) timestamp |
| slither / calls-loop | 127 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:161`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L161) calls-loop |
| aderyn / state-no-address-check | 75 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:178`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L178) Address State Variable Set Without Checks |
| aderyn / costly-loop | 66 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:167`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L167) Costly operations inside loop |
| slither / missing-zero-check | 59 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:177`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L177) missing-zero-check |
| slither / reentrancy-events | 54 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:121`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L121) reentrancy-events |
| aderyn / require-revert-in-loop | 49 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:254`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L254) Loop Contains `require`/`revert` |
| aderyn / large-numeric-literal | 43 | [`zetaphy-dex/contracts/dlmm/DlmmMath.sol:38`](../zetaphy-dex/contracts/dlmm/DlmmMath.sol#L38) Large Numeric Literal |
| aderyn / centralization-risk | 41 | [`zetaphy-network/contracts/AgentPolicyWallet.sol:438`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L438) Centralization Risk |
| aderyn / missing-inheritance | 36 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:35`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L35) Missing Inheritance |
| aderyn / unused-state-variable | 31 | [`zetaphy-network/contracts/NeuroIdentity.sol:793`](../zetaphy-network/contracts/NeuroIdentity.sol#L793) Unused State Variable |
| aderyn / unsafe-erc20-operation | 30 | [`zetaphy-network/contracts/IntentExecutor.sol:226`](../zetaphy-network/contracts/IntentExecutor.sol#L226) Unsafe ERC20 Operation |
| aderyn / unchecked-return | 25 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:128`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L128) Unchecked Return |
| aderyn / uninitialized-local-variable | 22 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:253`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L253) Uninitialized Local Variable |
| aderyn / state-change-without-event | 18 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:690`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L690) State Change Without Event |
| aderyn / unused-public-function | 18 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:161`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol#L161) Public Function Not Used Internally |
| smtchecker / overflow | 17 | [`zetaphy-dex/contracts/WZETAPHY.sol:32`](../zetaphy-dex/contracts/WZETAPHY.sol#L32) Overflow happens |
| aderyn / state-variable-could-be-immutable | 16 | [`zetaphy-network/contracts/AgentPolicyWallet.sol:283`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L283) State Variable Could Be Immutable |
| smtchecker / underflow | 13 | [`zetaphy-dex/contracts/ZetaphyPair.sol:146`](../zetaphy-dex/contracts/ZetaphyPair.sol#L146) Underflow happens |
| aderyn / storage-array-length-not-cached | 11 | [`zetaphy-network/contracts/AgentPolicyWallet.sol:210`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L210) Storage Array Length not Cached |
| slither / reentrancy-benign | 11 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:121`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L121) reentrancy-benign |
| aderyn / ecrecover | 9 | [`zetaphy-network/contracts/AgentPolicyWallet.sol:86`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L86) `ecrecover` Signature Malleability |
| aderyn / local-variable-shadowing | 7 | [`zetaphy-network/contracts/AgentRegistry.sol:62`](../zetaphy-network/contracts/AgentRegistry.sol#L62) Local Variable Shadows State Variable |
| aderyn / non-reentrant-not-first | 7 | [`zetaphy-network/contracts/SaphanTokens.sol:421`](../zetaphy-network/contracts/SaphanTokens.sol#L421) `nonReentrant` is Not the First Modifier |
| slither / return-bomb | 7 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:199`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L199) return-bomb |
| aderyn / internal-function-used-once | 4 | [`zetaphy-dex/contracts/dlmm/DlmmMath.sol:108`](../zetaphy-dex/contracts/dlmm/DlmmMath.sol#L108) Internal Function Used Only Once |
| smtchecker / division-by-zero | 4 | [`zetaphy-dex/contracts/ZetaphyPair.sol:219`](../zetaphy-dex/contracts/ZetaphyPair.sol#L219) Division by zero happens |
| aderyn / unused-error | 2 | [`zetaphy-network/contracts/NeuroIdentity.sol:180`](../zetaphy-network/contracts/NeuroIdentity.sol#L180) Unused Error |
| aderyn / inconsistent-type-names | 2 | [`zetaphy-network/contracts/NeuroScoreVerifier.sol:71`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L71) Inconsistent uint256/uint (or) int256/int types |
| aderyn / builtin-symbol-shadowing | 1 | [`zetaphy-network/contracts/BridgeGuard.sol:145`](../zetaphy-network/contracts/BridgeGuard.sol#L145) Builtin Symbol Shadowing |
| aderyn / dead-code | 1 | [`zetaphy-network/contracts/NeuroIdentity.sol:723`](../zetaphy-network/contracts/NeuroIdentity.sol#L723) Dead Code |
| aderyn / state-variable-could-be-constant | 1 | [`zetaphy-network/contracts/RedBlueArena.sol:106`](../zetaphy-network/contracts/RedBlueArena.sol#L106) State Variable Could Be Constant |
| slither / events-maths | 1 | [`zetaphy-network/contracts/BugBounty.sol:160`](../zetaphy-network/contracts/BugBounty.sol#L160) events-maths |

### Info (289)

Grouped by rule; every instance with its id is in `findings.json` of the workflow artifact.

| Tool / rule | Count | Example |
|---|---:|---|
| slither / unindexed-event-address | 78 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:75`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L75) unindexed-event-address |
| slither / low-level-calls | 67 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:199`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L199) low-level-calls |
| slither / naming-convention | 45 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:70`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L70) naming-convention |
| slither / costly-loop | 20 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:163`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol#L163) costly-loop |
| slither / assembly | 19 | [`zetaphy-network/contracts/AgentPolicyWallet.sol:65`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L65) assembly |
| slither / immutable-states | 12 | [`zetaphy-network/contracts/AgentPolicyWallet.sol:283`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L283) immutable-states |
| slither / cache-array-length | 11 | [`zetaphy-network/contracts/AgentPolicyWallet.sol:210`](../zetaphy-network/contracts/AgentPolicyWallet.sol#L210) cache-array-length |
| slither / constable-states | 11 | [`zetaphy-network/contracts/NeuroJobs.sol:127`](../zetaphy-network/contracts/NeuroJobs.sol#L127) constable-states |
| slither / cyclomatic-complexity | 6 | [`zetaphy-network/contracts/IntentExecutor.sol:239`](../zetaphy-network/contracts/IntentExecutor.sol#L239) cyclomatic-complexity |
| slither / missing-inheritance | 4 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:669`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L669) missing-inheritance |
| smtchecker / overflow | 4 | [`zetaphy-dex/contracts/ZetaphyPair.sol:140`](../zetaphy-dex/contracts/ZetaphyPair.sol#L140) Overflow might happen |
| slither / too-many-digits | 3 | [`zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:681`](../zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol#L681) too-many-digits |
| slither / dead-code | 3 | [`zetaphy-network/contracts/NeuroIdentity.sol:723`](../zetaphy-network/contracts/NeuroIdentity.sol#L723) dead-code |
| slither / unused-state | 1 | [`zetaphy-network/contracts/NeuroIdentity.sol:793`](../zetaphy-network/contracts/NeuroIdentity.sol#L793) unused-state |
| slither / var-read-using-this | 1 | [`zetaphy-network/contracts/NeuroScoreVerifier.sol:202`](../zetaphy-network/contracts/NeuroScoreVerifier.sol#L202) var-read-using-this |
| slither / unimplemented-functions | 1 | [`zetaphy-nft/contracts/CollectionBase.sol:32`](../zetaphy-nft/contracts/CollectionBase.sol#L32) unimplemented-functions |
| smtchecker / underflow | 1 | [`zetaphy-network/contracts/ZetaphyCheques.sol:170`](../zetaphy-network/contracts/ZetaphyCheques.sol#L170) Underflow might happen |
| staticcheck / U1000 | 1 | `zetaphy-chain:evmd/zetaphy_ibchold.go:143` U1000 func (*EVMD).ibcHoldRule is unused |
| staticcheck / ST1005 | 1 | `zetaphy-chain:mempool/zetaphy_lock.go:24` ST1005 error strings should not be capitalized |

## Formal checks (SMTChecker)

| Contract file | Engine | Result | Counterexamples | Unproved targets | Time |
|---|---|---|---:|---:|---:|
| `zetaphy-network/contracts/ZetaphyCheques.sol` | bmc | done | 6 | 1 | 134s |
| `zetaphy-network/contracts/RewardVault.sol` | bmc | done | 7 | 0 | 32s |
| `zetaphy-dex/contracts/WZETAPHY.sol` | bmc | done | 1 | 0 | 0s |
| `zetaphy-dex/contracts/ZetaphyPair.sol` | bmc | done | 20 | 4 | 230s |

A counterexample is a concrete input the solver found (BMC checks each function alone, without the contract's state invariants, so its arithmetic ones are often unreachable; they are Low findings). An unproved target means the solver ran out of time: NOT a pass and NOT a bug (Info). A contract that hit the time or memory cap reports nothing.

## Coverage

**Invariant / property suites** (`*/audit/invariants/`):

| Suite | Tool | Passed | Failed | Not run | Note |
|---|---|---:|---:|---:|---|
| `zetaphy-dex/audit/invariants` | none | 0 | 0 | 1 | directory not there yet |
| `zetaphy-network/audit/invariants` | none | 0 | 0 | 1 | directory not there yet |
| `zetaphy-nft/audit/invariants` | none | 0 | 0 | 1 | directory not there yet |

**Mutation testing** (custom mutator, `audit/tools/mutate.js`):

| Contract | Killed | Survived | Score | Stillborn | Equivalent | Tests used |
|---|---:|---:|---:|---:|---:|---|
| `zetaphy-dex/contracts/ZetaphyPair.sol` | 7 | 5 | 58% | 0 | 0 | amm.test.js, web-lib.test.js |

Surviving mutants: a test that fails on each of these would make the suite stronger.

| Where | Change no test noticed |
|---|---|
| `zetaphy-dex/contracts/ZetaphyPair.sol:166` | `if (balance0 > type(uint112).max \|\| balance1 > type(uint112).max) revert Overflow();` → `if (false) revert Overflow();` |
| `zetaphy-dex/contracts/ZetaphyPair.sol:215` | `if (root <= MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();` → `if (false) revert InsufficientLiquidityMinted();` |
| `zetaphy-dex/contracts/ZetaphyPair.sol:223` | `if (liquidity == 0) revert InsufficientLiquidityMinted();` → `if (false) revert InsufficientLiquidityMinted();` |
| `zetaphy-dex/contracts/ZetaphyPair.sol:248` | `balance0 = _balance(_token0);` → `/* mutant: deleted */` |
| `zetaphy-dex/contracts/ZetaphyPair.sol:303` | `if (y > 3) {` → `if (y >= 3) {` |

**Line coverage of the existing tests:** not measured. The project test suites run contracts on an in-process EVM through `node --test` helpers, which solidity-coverage and `forge coverage` cannot instrument; the mutation score above is the measure of test strength used instead. Suites under `*/audit/invariants/` that use Foundry can add `forge coverage` later.

## Neuro on our own bytecode (dogfooding)

Neuro read 85 of our contracts (offline, bytecode only): 66 low, 3 info, 14 high, 2 medium. This is what users of the explorer and wallet would see. A high verdict names a power (pause, mint, an owner that can move funds): it must be documented for users, or it is a Neuro false positive to fix in Neuro. Not counted as vulnerabilities.

| Contract | Neuro verdict | What Neuro reports |
|---|---|---|
| NeuroLane (`zetaphy-network/contracts/BridgeAirlock.sol`) | high | owner-unknown:medium, can-pause:high |
| BridgeGuard (`zetaphy-network/contracts/BridgeGuard.sol`) | high | owner-unknown:medium, can-mint:high, can-pause:high, delegatecall:medium |
| BridgedToken (`zetaphy-network/contracts/BridgeGuard.sol`) | high | owner-unknown:medium, can-mint:high |
| BugBounty (`zetaphy-network/contracts/BugBounty.sol`) | high | owner-unknown:medium, can-pause:high |
| FederatedRounds (`zetaphy-network/contracts/FederatedRounds.sol`) | high | owner-unknown:medium, can-pause:high |
| HyperlaneLockBoxV2 (`zetaphy-network/contracts/HyperlaneLockBoxV2.sol`) | high | owner-unknown:medium, can-pause:high |
| NeuroControl (`zetaphy-network/contracts/NeuroControl.sol`) | high | owner-unknown:medium, can-pause:high |
| NeuroJobs (`zetaphy-network/contracts/NeuroJobs.sol`) | high | owner-unknown:medium, can-pause:high, delegatecall:medium |
| NeuroJobsChallenges (`zetaphy-network/contracts/NeuroJobs.sol`) | high | owner-unknown:medium, can-pause:high |
| NeuroOracle (`zetaphy-network/contracts/NeuroOracle.sol`) | high | owner-unknown:medium, can-pause:high |
| SaphanSyntheticToken (`zetaphy-network/contracts/SaphanTokens.sol`) | high | owner-unknown:medium, can-pause:high |
| ZetaphyTokenVault (`zetaphy-network/contracts/SaphanTokens.sol`) | high | owner-unknown:medium, can-pause:high |
| StableGateway (`zetaphy-network/contracts/StableGateway.sol`) | high | owner-unknown:medium, can-pause:high |
| ThreatReports (`zetaphy-network/contracts/ThreatReports.sol`) | medium | owner-unknown:medium, can-change-fee:medium |
| UsefulWork (`zetaphy-network/contracts/UsefulWork.sol`) | high | owner-unknown:medium, can-pause:high |
| ZetaphyTimelock (`zetaphy-network/contracts/ZetaphyTimelock.sol`) | medium | roles:medium |

## Chain code (Go)

- staticcheck v0.7.0 ran (396s)
- gosec v2.22.8 ran (121s)
- go test -race passed (14s)
- govulncheck FAILED: vulnerability database unreachable (vuln.go.dev: Forbidden by this sandbox's proxy)

## Code hashes

keccak-256 of each audited contract's runtime bytecode, as compiled here. A deployed contract whose `EXTCODEHASH` differs is not the code this report covers.

<details><summary>85 contracts</summary>

| Contract | Runtime code hash |
|---|---|
| WZETAPHY | `0x06839f3c88ff0d55c689cc9d6932cf7e23db76156f6d60a3cb87668f334b1816` |
| ZetaphyFactory | `0x629b4c289fb22d2fe7da5bf7cb59989d7d9d422156cbcfa4b0bd1ebdaf99b95b` |
| ZetaphyPair | `0x445427d958af5f73406c2d9d9bfb52ab630920dc465b9170908a1f5795869975` |
| ZetaphyRouter | `0x539570db5e855e90a4969ed9c28a93cc3ea2b7d1d298ebf209ba75a1ba1c48ed` |
| DlmmBinTree | `0x3fd4d9e0b56f7e3e979b55d16bb3dc483bdb930343b2f43d0546a1bcd6b91901` |
| DlmmMath | `0xa03f29457eda2ca7dbb7912b52bb52c72e523f9735001ca0cf47d9ac2f967263` |
| ZetaphyDlmmFactory | `0x558e65a51a3e7d2a5bba789584ecb9370b34ff267a893e285581734d15f2fe29` |
| ZetaphyDlmmPair | `0x15e0dbd602042e5df7758e493fc47cbe946e3d788512f454050a6fc32d16f2cd` |
| ZetaphyDlmmPairDeployer | `0xf6c1ed428901b17a58f285dc0f59712a2efac28684c9c3c47b7fee01560b787d` |
| ZetaphyDlmmRouter | `0x1d37a7809e5b378f4e8438f6dc0dff389f5aa26191558ba9c8844541c0f781e1` |
| AgentPolicyWallet | `0xe2cbd4e545f9cebb45bac17e98e303d4f7824907267b6f01d164dd2607fffeb3` |
| CosignCommittee | `0xbc9b289649ad835d2247d046ab00e5f8329edd456ca1ff7fb998b3137332b191` |
| FrostSecp256k1 | `0x3da22d8691007b499449e3b79d690905fe171edad276213cedee10c4c0861597` |
| FrostVerifier | `0x5726b22ceca2a7745b6b5d667500b29578aec48bf5c6b30486c66cbdf4ec4248` |
| AgentRegistry | `0x7deccd5350efac1c89f7eb5ba2bf470ca0be288e5adc7f762c19bbb442361880` |
| ConstitutionChecker | `0xb37eab60df681f24d7faecec18b8e59ae0e57781684f12e5da96cff0d17dca92` |
| BridgeAirlock | `0xf53744ca726d36d2a7c2a1f72df4d6aeff81d25aaff5fa075aa851d4622e5338` |
| LockBox | `0x81c8f25efba87f0be6ac1eee332d33a52d16f3226d328e59779a255a4fd239ab` |
| NeuroLane | `0x4441092f027ba4fb757a061f8e94d43f3d871bb7fb91f69631a2a9998b0de978` |
| BridgeGuard | `0xc6e4974667da4b750f127b0bc852f2e1493b2e49861990ef36ab6064082a66a6` |
| BridgedToken | `0x93377ec85582345a708ab4411a6c7a3f47565cccf2ddeca460890a71e73dbaa0` |
| BugBounty | `0xfbe15e7a54586958f5240980609962b8d2006dc6ccfd44d8a17ae618540e6538` |
| ComputeMarket | `0x5d7e5d08e7e65968d9e2bc6b25eb250be8cca9d91b479c936979cc4c22548284` |
| DataDAO | `0x5bedc7135a49aeb72c4db60e798ff92d1d47d67779893806aec5903ae273595a` |
| DetectorPool | `0xabc3c2ef817175a67275c8f0983d6c15eb69014dad0cafdd7e62d7c2d6aad137` |
| FederatedRounds | `0x39b34158786f8839475b96eb3fb9aacaadd84479800507cd8b7028b3c78b6b55` |
| ForesightRegistry | `0x12d368b450f29b5cd5861d17691763c0b7543d5f665b89901854247d5928874f` |
| HackInsurance | `0xd33eee151ee0c23cb004db1be8b96637d6c1ec900c209a1436e4c48e06e306b6` |
| LabelFaucet | `0x89198851501357fd4d0f696e4b13a39520b56fc237d8bf9f4b3142704efe7e3a` |
| LabelRegistry | `0x90d5b50a926882941397a4c8ffe4b8c00c21e00c811ab4ad7ed86ff0f68976d8` |
| LabelSwapGate | `0xbcc60dcbcbfe05374deab10f6835ec48c1dd02f36dde669da239f40247a0eb21` |
| VouchRegistry | `0xac9fa9da07170957221b991f061d81290cf6664de11591ad1a70bf38910e2ee4` |
| HyperlaneLane | `0x68a948cdfa1239c00064641f6c3f940c12cec09c85f50e417287cc115922ad68` |
| HyperlaneLockBox | `0xf068cac9aaee21394cf2e21da5a9cc2c33ca82e520771e1d84bd753facd069b1` |
| HyperlaneLockBoxV2 | `0x1d779e5e7bf4c6b01c29583d9472df8e6f282083d30b4f06303bbd3730586293` |
| HyperlaneOutbox | `0xff255a0e88f54dbb04f052295b8fd95901b6d3ff68c8b94e4f629c9b437649da` |
| IntentExecutor | `0x7a69aed5514f22204718308c1a7f9baafb37948cc84fafce73e62109fa38980c` |
| ModelEpochs | `0x1c70bc40331b51fdbcfab31bcf4552ca3fecccadd5cc2600491ee32c7818ac13` |
| ModelRegistry | `0x4a9d128a86dbae7dff510aaebfbcc8fe3c1d033a217fda83d034692f206bb27a` |
| NeuroAnchor | `0xbc2caa3c489edbb2bd00fb05c1cfaab1c6cb43ee04af385946824be1543a7faa` |
| NeuroAttest | `0x32f5f7d650645ff0defb04af5e2ee4491314800dc3351e374e9ba9621e0f4d6b` |
| NeuroControl | `0x7833871874106d14df41e41960fd032ff65770cf6bacdbdbbfc8f4b74a34b625` |
| NeuroIdentity | `0x7a4dec222940c2f179746f295122d3c630dca41d15c81212140ec62eb080dffa` |
| NeuroTargets | `0x340759ade38117b9fd4082c5cb937369cfc86671d8f740ec9e98e1865799a470` |
| NeuroJobs | `0xf175a58551bd47f07151a5ee8274f48bfe69cdc8012726780e324eb97af6d974` |
| NeuroJobsChallenges | `0xe5f1d137efc29ca4b7c77ca7f4de6dc90e97ea0bfb3b4b591cde78a8a49afea5` |
| NeuroOracle | `0x503dab61025c83e89fc8d107dcab73fe3c22cb6ec34f4f2e593dec08706ffa36` |
| NeuroOracleSender | `0xe39019e49562520b96a9e129a2dada6017173089c8e3fc06114c692e5723574c` |
| NeuroScore | `0xdeeb869bf8d07bbc7ab9d347c97e1cb1921165d7db06d2938a47c64877238918` |
| NeuroScoreVerifier | `0x1c34f1f76eb298800b2d6d38ae04ef6358f337cff1eab618172007be05e7d205` |
| NeuroValidation | `0xf6c3c6bef6dd4a0e9d682d5de8da13b48c5a51a8373739dcf8279179f2a3e808` |
| QuantumWallet | `0x3713d060b6a56f7d86edd78f952f4c06792c187bd183ddbd281adbfa5174bd9b` |
| QuantumWalletFactory | `0xe79fcd6b1af92e765268cc7b75b177510a0410a148ae8b771d5b64f53ad06437` |
| RedBlueArena | `0x733bb4e75c6cf7925f7115814a7ce923cb536b6e9fffb6c65103a8ee852d9fe4` |
| RewardVault | `0xe6075f6fa3a7c5c1f08f7f90ec9e70ba0dcf431720269b7526e6ac3a88e2ed59` |
| RiskForecasts | `0xc6546a37253bab04f0ffd2a622e243d762a5b414d7a8f67fb34e4161149cf6cb` |
| SaphanSyntheticToken | `0x3e2c6afd455b3949bffd1672f5d2643674cad90df0354b11ed84c6c44ef55c59` |
| ZetaphyTokenVault | `0x0fa03846c4794f6ef681104f11ad9807b79df41f7d1b64d4847b5ea60bae56bf` |
| SignalBoard | `0xe4ca104924e8112d588a5d95167ba6dda941a68b71fe6d07eb1417828232a31a` |
| SimpleMultisig | `0x1632eba19332a6137061ef8c315c64ee0ce608dd893e4e5c4ad064816712141a` |
| StableGateway | `0x549713521729191d8513aded351c5de9db7285373687deadcff13dc1856464f9` |
| ThreatRegistry | `0xa702c42380a618267eb71652db750b19b2160a10838c740f4229492bbb510e62` |
| ThreatReports | `0xde81ff86f35b0a99ae31a31146a61ea29ff991a88e72ea744da0656383413cf5` |
| TwapRecorder | `0x023137448e01468d2876ebea600459e22146d20321f19ff3ecc0b682e3e98546` |
| UsefulIssuance | `0x54a813a6381f774c82d0c146c644a35d0fd9527db7e5c182b314aa887a34cd64` |
| UsefulWork | `0x7a5e6f737e9077cf3222d0f85f38b370f44dfc353e06be02de2f66f565492544` |
| WebAuthnVerifier | `0xeb7f5f44c5f85d12a4f4944012128d00f1784903db135526f631c1ffbb7021fb` |
| WorkerReputation | `0xea771e3823c141f166571ceabe21e36382b0fcf978186ab6f15da94f2045866f` |
| ZetaphyCheques | `0x631d5804120306ebfd89b68ce8ab0ca200e39d1dc70964da60c362466ae808ef` |
| ZetaphyEarly | `0x8c930bcb14d35388be0adba2e066466ed6dbf3dd87c7dbe0b9bba9cb1f3acb7e` |
| ZetaphyEarlyFarm | `0xc9aae302473115878155ec4a086cacafcad99187af7ab9a8395e19846b558930` |
| ZetaphyEarlyPass | `0x0d51177c42145caf7b89edadeb41e8b0039c3804100d1cd9ff047ea5c56ad030` |
| ZetaphyEarlyPolls | `0x71657551f3ebd26907df7e5937efaeb2ca2ea72334298f44a6e1d3b4985c8b8d` |
| ZetaphyOfflineOrders | `0x92ec7f6d5763050bc9b9ac9e26c03720ac6867afc8c2b46b2378b7cba9c4a397` |
| ZetaphyOracle | `0x3149bc68f17f340dfa322c8539617dbed6b55d128aaacc0b76b6caabd7dc2190` |
| ZetaphyPoints | `0x599bf2bbcfa5bff54df28dec2d8c8dfddc89202dcb4ed399369592ad666aa529` |
| ZetaphyPythRelay | `0x88c61050f4054baf1525fa8b2fc1ff6a20a41d6fc17b7d626d3b242fae1a6075` |
| ZetaphyQuests | `0xb6c41b783d4f4a365bfd352b008d465b7b6ce4400bab2ddaa78e5c292f7f269d` |
| ZetaphyTimelock | `0x91ed1eee50e1ce2c61f31057644db7c3360802a422703a8dc5d80cb3871f8e76` |
| ERC1155Deployer | `0xb261ff1feab4660d89762ec95d9935ca0f5fd9c34299257ff9520f3d3332c49e` |
| ERC721Deployer | `0xcbea423398e43cb66acc10dd9fc310a949ef06a0fa1bda7a672ec3a071ebf57b` |
| NFTFactory | `0x0ac17618557fe9906b24b58dbb7f8ef632c3169b55979f8fc2673758f12f0702` |
| NFTMarketplace | `0x7ba883b06b5c4345dc22618868b6e9500027210a2add28982c2631945b4ef87c` |
| ZetaphyERC1155 | `0x6e72e6235d2f93b50ebf92a6d085af497dfe0a0597216c1936b93a901a6e28c5` |
| ZetaphyERC721 | `0x9a2d953596ca845d6a1152089103e231643e325f89ac9f15b34f2b5c67657e2f` |

</details>

## What this does NOT prove (as of 2026-10-30)

- **No finding is not "secure".** Static analysers know patterns; they miss business-logic bugs (wrong fee maths, a price that can be pushed, a missing check that only the design says must exist), which is where most money is lost.
- **Economic and cross-contract attacks are not modelled**: flash-loan price manipulation, oracle manipulation, MEV / sandwiching, governance capture, griefing that costs the attacker little.
- **The SMTChecker proves only what it reports as proved**, within its time budget, and only the built-in properties (assert, arithmetic, bounds). "Unproved" means unknown.
- **Fuzzing and invariants** test only the properties someone wrote down, for the number of runs given. Suites that are missing are counted as "not run", never as passed.
- **Mutation testing** samples a few dozen mutants of a few contracts; a high score means the tests notice those kinds of edits, not that they are complete.
- **Deployment and operations are out of scope**: who holds the owner / admin keys, the multisig and timelock settings actually deployed, constructor arguments, upgrade procedures, the RPC and front-ends. The code hashes above let you check that what is deployed is what was analysed.
- **The chain**: only the ZETAPHY patches are analysed, not Cosmos EVM / CometBFT / ibc-go themselves, and consensus-level behaviour (liveness, validator collusion) is not tested here.
- **Tools have bugs and blind spots**, and the versions used are pinned (audit/tools/install.sh); a newer rule set may find more.
- **Before mainnet with real funds, an independent audit by people is still required** (SECURITY.md). This pipeline makes that audit cheaper and keeps regressions out between audits; it does not replace it.

