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
