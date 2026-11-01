# Deploying the AI map's contracts (one button)

The hub's AI map (35 items) marks an item "Page ready, contract not deployed yet" until its contract is on the
testnet. One workflow deploys all of them: **Actions › ai-deploy › Run workflow** (environment `testnet-deploy`,
the owner approves; it needs the public RPC up).

What it does, in order:

1. Every missing AI contract (`zetaphy-network/src/aideploy.js`), each **owned by the ZetaphyTimelock** from the
   launch state. The deploy key keeps no role.
   - Model registry (1)
   - NeuroScore (3)
   - ModelEpochs (35)
   - SignalBoard (2, 7)
   - WebAuthn verifier and the co-signer committee (9, 14)
   - Agent registry (23)
   - Human/agent labels and vouches (25)
   - Intent executor (24)
   - Foresight (29), risk forecasts (15), detector pool (26), Data DAO (16) and the red-vs-blue arena (27)
   - NeuroAttest (19) and NeuroAnchor (30)

   RiskForecasts is accepted by Foresight as a resolver before Foresight is handed to the timelock.
2. Useful work (10, 34), deployed paused, if missing.
3. FederatedRounds (6), deployed closed, if missing.
4. The Neuro page's automatic peer discovery is pointed at the SignalBoard.

`node scripts/ai-deploy.js check` then reads every contract's governance back and fails if one is not the timelock.

The addresses go to `zetaphy-network/deployments/ai-77390.json` on the branch `ai/testnet`. Open its pull request
and merge it. The hub then shows each of those items as "Works now": the AI map reads `hub-config.json` and
switches an item once every contract it needs is there (`statusOf` in `zetaphy-hub/flow.js`).

A run that stops part way can be run again. It skips what is already in the record.

Contracts that are paused (useful work) or closed (federated rounds) are opened later by a timelock proposal,
as their own docs describe. The herd-immunity mirrors (28) are deployed on the other chains by the `neuro-oracle`
workflow.

Note: the testnet timelock keeps a 0 delay (`getMinDelay() = 0`), so step 2 (useful work) refuses to deploy: it
needs a delay of at least 2 days. That is intended; the check is not weakened.

## The frontier button: everything else that can go on the testnet now

**Actions › frontier-deploy › Run workflow** (environment `testnet-deploy`, the owner approves; it needs the public
RPC up, and the ai-deploy records merged for the private-identity registry). One key, one transaction at a time
(it shares ai-deploy's concurrency group, so the two never run at once). Every contract with a governance role takes
the **ZetaphyTimelock** in its constructor; the others have no owner. The deploy key keeps no role. Code:
`zetaphy-network/src/frontierdeploy.js`, `scripts/frontier-deploy.js`.

What it deploys, in order (each only if missing):

| Contract | Doc | Governance | Built with |
|---|---|---|---|
| ImmuneRegistry | immune-network.md | timelock | NeuroJobs, ThreatRegistry, k = 2 |
| ImmuneBroadcaster | immune-network.md | timelock | the registry, ZETAPHY's Hyperlane Mailbox (no routes yet: `setReceiver` per mirror, through the timelock) |
| CircuitBreaker | self-healing.md | timelock | NeuroJobs runners; guardian bond 10, claim bond 5, quorum ≥ 3, 1 accepted verdict |
| QuantumRescue | quantum-safe-settlement.md | timelock | the security precompile `0x…0901`, maturity 720 blocks |
| PQSettlement | quantum-safe-settlement.md | none | |
| ZetaphyOutbox | trustless-bridge.md | none | |
| PoseidonT3, ZkIdentityVerifier | zk-identity.md | none | **DEV trusted setup (one party): testnet only** |
| ZkIdentityRegistry, PrivatePoll | zk-identity.md | timelock / none | LabelRegistry and VouchRegistry from ai-77390.json, root TTL 1 hour |
| HackInsurance | crosschain-assist.md | timelock | as `zetaphy deploy-assist insurance`: NeuroJobs runners, quorum 3. Testnet only |
| AuditNetwork, AuditRunners, AuditJudges, AuditCertificate | audit-network.md | timelock (Runners: none) | as `zetaphy deploy-audit`; treasury = the RewardVault; no WorkerReputation (not deployed) |
| ZetaphyCheques, ZetaphyOfflineOrders, ZetaphyOfflineCash | offline-trading.md, offline-cash.md | none | as `scripts/offline-deploy.js`; the ZETAPHY Swap router |

PQMultisigIsm is deployed only when the run is given ML-DSA-44 validator key hashes (`pq_validators`); none exist
yet, so by default it is skipped.

What it does **not** deploy, and why (also written into the record as `skipped`):

- **TrainingPool, TrainingMarket; UsefulWork, UsefulIssuance, BugBounty, WorkerReputation**: they require a timelock
  delay of at least 2 days. The testnet timelock keeps 0.
- **ProvenVerdicts**: needs the public zkML ceremony's final key, which is not final yet.
- **StarkLightClient / StarkVerifier, ZetaphyBridgeInbox, ImmuneMirror, ZetaphyLockbox**: they live on other chains
  (or one per route) and need real checkpoints, mailboxes or tokens there.
- **BtcLightClient**: needs a real Bitcoin checkpoint header and a header relayer.
- **PrivateAirdrop**: one per airdrop, funded by its sponsor. **ImmuneGuardedRouter**: an example integration.
- **Encrypted mempool**: a chain module, not a contract.
- **NeuroJobs, StableGateway, RewardVault, BridgeAirlock** and the other launch contracts: already deployed;
  redeploying them would mean rewiring everything that points at them.

`node scripts/frontier-deploy.js check` then reads every address back and fails if any governance is not the
timelock. The records go to the branch `frontier/testnet`: `deployments/frontier-77390.json` (with the skips),
`audit-77390.json`, `offline-77390.json`, `qsafe-77390.json` and `zetaphy-chain/hyperlane/immune-network.json`.
Open its pull request and merge it; the hub reads them. A stopped run can be run again: it skips what is recorded,
adopts a contract whose deploy landed after the stop, and finishes a half-deployed audit network at its planned
addresses.
