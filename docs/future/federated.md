**English** | [ภาษาไทย](federated.th.md)

# Federated learning for Neuro, and a model bound to chain height

Workstream `fut-federated`. Two items:

| # | item | status |
|---|---|---|
| 6 | Federated learning for Neuro's learned score (`zetaphy-neuro/ml/`) | **testnet-ready, not deployed**: opt-in browser panel on the Neuro page (8 languages, Web Worker training, wallet commit + reveal), user and automatic on-chain outcome labels, client, privacy, wire format, commit-reveal contract (closed by default), signed envelopes, robust aggregation, canary gate, `zetaphy fl` deploy/propose/status, aggregator + weekly workflow that reads the committed deployment record. Tested with five real Chromium browsers on an in-memory EVM. **Not deployed yet; no real-world accuracy claim** (no labels collected yet). |
| 35 | Consensus-synchronized model (version bound to chain height) | **done on the contract, JS and node side**: `ModelEpochs` contract, deterministic version-by-height selection in JS (browsers, runners) checked against the contract, manifest hashing, gov proposal builder; in the chain patch, the registry address set by governance (`gov.sh model-epochs`), the keeper lookup `ModelVersionAt`, `zetaphyd q neuro model-at`, JSON-RPC `zetaphy_modelAt` and a `modelEpochs()` view on `0x…0902`. Nothing in consensus uses the model yet; no sidecar daemon (below). |

Everything is testnet only, free, and has no always-on server: browsers compute updates, the chain or a runner
carries them, a scheduled GitHub Actions job aggregates, a governance vote decides.

---

## Item 6: federated learning

### Why a head, not the trees

Neuro's model (`ml/model.json`) is 160 gradient-boosted trees. Trees cannot be averaged across clients, so federated
learning trains a small **logistic-regression head** on top of the fixed trees:

```
phi(x) = [ 1, margin_gbdt(x), clamp(x_j, -8, 8) for 28 named features ]      (optional: + the leaf value of each tree)
z(x)   = margin_gbdt(x) + theta . phi(x)
p      = sigmoid(calib.a * z + calib.b)                                       (the model's own Platt calibration)
```

- `theta = 0` is exactly the committed model (tested bit for bit on every check row and red-team row), so the
  committed head `ml/fl/head.json` changes nothing until a vote adopts a trained one.
- The 28 features are the rules, owner tricks, simulation and market facts (`DEFAULT_HEAD_FEATURES` in
  `ml/fl/head.js`): where new scam families show first. The margin input lets the head sharpen or soften the trees.
- `leaves: true` adds one weight per tree (the "head on fixed tree leaf features" variant). It is implemented and
  tested, but off by default: every update carries the same privacy noise in every coordinate, so 160 more
  coordinates lower the signal-to-noise ratio. In the simulation it did worse (AUC 0.786 vs 0.800).
- **Trust region**: `||theta|| <= maxNorm` (4). `applyDelta` projects back onto the ball, `checkHead` refuses a head
  outside it. Whatever the updates were, the head moves a score by at most `maxNorm x ||phi(x)||` logits from the
  governance-approved trees.
- The head is advisory like the trees: `combine.js` still never lowers a rules verdict, and the model is still not
  in the network verdict or reportHash. `scoreReport(model, report, { head })` uses it; the "why" list still
  explains the trees.

### What a browser does (`ml/fl/client.js`, `dp.js`, `codec.js`)

1. Keeps, locally, the feature vector of each token it scanned and a label the **user confirmed after the outcome**
   ("I could not sell" = 1, "traded normally for weeks" = 0): `makeExample(model, head, features, label)`.
2. Local training: 10 epochs of gradient descent from the current head with a small pull back to it
   (`localDelta`).
3. **Clip** the change to L2 norm `C = 1`, then add Gaussian noise `N(0, (z C)^2)` to every coordinate, `z = 2`
   (`privatize`). The noise comes from `crypto.getRandomValues` (`cryptoUniform`); a seeded generator would void the
   guarantee, and tests are the only place one is passed.
4. Check its privacy budget (`PrivacyLedger`, kept in browser storage): one update per round, and refuse once the
   total epsilon would pass the budget (16 by default).
5. Encode (`encodeUpdate`: `NFL1` magic, head sha256, round, dim, clip, z, int32 fixed-point values; the same
   bytes on every platform) and send it one of two ways:
   - **on chain, commit-reveal** (`FederatedRounds.sol`): `commit(round, keccak256(abi.encode(keccak256(payload),
     salt, sender)))` in the commit phase, `reveal(round, salt, payload)` in the reveal phase. Nobody can tailor an
     update to the others of the same round; the sender is inside the commitment so a commitment cannot be copied;
     the tx signature is the update's signature;
   - **off chain, signed envelope** (`zetaphy-network/src/fl.js`): EIP-191 `personal_sign` over
     `"Neuro federated update v1\nsha256:<digest>"`, handed to a runner or committed under
     `zetaphy-neuro/ml/fl/inbox/round-N/`. The aggregator verifies every signature.

The whole client runs in Chromium as plain ES modules under a strict CSP (`ml/test/fl.browser.e2e.js`), including
WebCrypto hashing that matches Node's byte for byte.

### The browser panel (`zetaphy-neuro/web/fl-panel.js`)

A section of the Neuro page (and of the hub, which serves the same page under `/neuro/web/` with `ml/` next to it).
**Off by default**; nothing is stored or sent until the user ticks "Take part". Then it shows:

- **The privacy budget**: epsilon used of 16, epsilon per round (5.30 at z = 2), rounds left. The ledger
  (`PrivacyLedger`) lives in `localStorage` with the stored checks; "Delete my stored checks" keeps it, so deleting
  cannot buy a fresh budget. A round is counted **before** anything is committed, as soon as the noised update exists;
  a failed or rejected commit reuses that same update and salt, so a retry never spends twice.
- **What leaves the browser**: one update of `dim` numbers (30 with the default head), clipped to length 1, Gaussian
  noise of size 2 per number, the round number and the head hash, in a commit and a reveal transaction from the
  user's own wallet. Never sent: the tokens checked, the answers, their features. A note in the page footer says
  this panel is the only part of Neuro that connects a wallet or sends a transaction.
- **The user's checks** (the last 200 EVM tokens checked, kept in this browser): for each, "It was a scam" / "It was not"
  / "Clear", the automatic outcome (below) or why there is none yet, and which label training will use. When the
  user's answer and the automatic one disagree, the example is not used.
- **The round**: "not deployed yet" (the committed `ml/fl/deployment.json` has `rounds: null`; no buttons, no round
  reads), "closed" (deployed but paused by governance), "before the first round", or "round r, commit/reveal phase,
  n blocks left, c commits, v reveals", and the user's part in it.
- **Connect**: the wallets found in the browser (EIP-6963 + an injected `window.ethereum`), the same pattern as the
  hub's wallet bar; the choice is stored under the hub's shared key `zetaphy:wallet` (an id, never a key), so inside
  the hub the panel follows the wallet bar silently (`eth_accounts`) and the wallet is asked for the ZETAPHY testnet
  (`wallet_switchEthereumChain`, else `wallet_addEthereumChain`).
- **Train here and commit**: labelled checks -> `roundUpdate` (`ml/fl/client.js`) **in a Web Worker** (`web/fl-worker.js`:
  local training, clip, noise from `crypto.getRandomValues`, NFL1 encoding) -> a fresh 32-byte salt ->
  `commit(round, keccak256(abi.encode(keccak256(payload), salt, sender)))` through the wallet (`ml/fl/rounds.js`, a
  dependency-free FederatedRounds client checked against ethers and the compiled contract).
- **Reveal my update** in the reveal phase: `reveal(round, salt, payload)`; afterwards the salt and payload are
  deleted from storage. A round that ends before the reveal is shown as missed (not used; its privacy cost stays).

Reads of round state go to the deployment's public RPC (`eth_call`, `eth_blockNumber`); the wallet is used only to
send and to wait for receipts. All text is set with `textContent`; no inline script or style (the page's strict CSP
holds, the Worker is `script-src 'self'`).

### Where labels come from (`zetaphy-neuro/ml/fl/labels.js`)

1. **The user, after the fact**: "it was a scam" (1) or "it was not" (0).
2. **Automatic outcomes observed on chain later.** At scan time the panel keeps the feature vector, the trade
   simulation's pool and stage, the pool's native-coin reserve, and whether the ZETAPHY ThreatRegistry flags the
   token (address key or Neuro fingerprint). Later, while the page is open (a few due tokens automatically, more with
   "Re-check outcomes now"; at most every 12 hours per token, for 60 days), it re-reads the token with the same reader
   and trade simulation as a scan, the pool's reserve, and the registry. Checking the same token again on the page
   also adds a reading. Signals:
   - `sell-failed`: the simulation buys but cannot sell any more -> 1;
   - `liquidity-pulled`: the pool's native side fell by 90% or more since the scan, or the pool has no liquidity left
     although it had some at scan time -> 1;
   - `threat-flagged`: the registry flags it now and did **not** at scan time -> 1 (a flag present at scan time is not
     an outcome);
   - `traded-normally`: only after **30 days**, the latest two readings (12 h+ apart) sell with a tax of at most 10%,
     keep at least half of the scan-time pool, no flag, and **no positive signal was ever seen** -> 0.

   A positive signal counts only when seen in **two readings at least 12 hours apart and still seen in the latest**
   (a flaky RPC or a briefly empty pool makes no label); a positive followed by a recovery is "mixed" and not used. No
   label is used before **3 days** after the scan. Combined with the user's answer: both present and different -> not
   used.

**Label noise, honestly.** Automatic labels are not ground truth and their real error rate is unknown until real
data exists. Known ways they are wrong: an honest team migrating its pool looks like "liquidity pulled" (false 1); a
slow rug or a trap that fires after 30 days looks like "traded normally" (false 0); the simulator's own blind spots
(traps aimed at particular callers, amounts or times) carry over; a registry flag can be wrong and cleared on appeal
(the next reading then drops the label). The re-reads go to the same public RPCs a check uses (and the ZETAPHY node
for the registry), which see which token is read, as with any check; the panel says so. Simulated effect (same
drifted world as below, 30 rounds, trimmed mean, gate on): symmetric noise of 10% costs nothing measurable (AUC 0.805),
5% false scam / 10% missed scam costs a little (0.788), but **10% false scam / 30% missed scam undoes the gain and
lowers accuracy below the untouched model** (AUC 0.746, accuracy 0.607 vs 0.641) **without the canary gate noticing**
(it refused only 4 rounds): missed scams push scores down in exactly the new families the canaries do not cover yet.
That is why the automatic 0 waits 30 days and needs a clean history, and why fresh, drifted canaries are listed below
as remaining work.

### Privacy: what epsilon means here

**Local** differential privacy at **user level**: the noise is added on the device, so neither the aggregator, the
runners nor anyone reading the chain has to be trusted. Two clipped updates of one user differ by at most `2C`,
so the Gaussian mechanism with std `zC` is `rho = 2 / z^2` zero-concentrated DP per submitted round; rounds add up;
`epsilon = rho + 2 sqrt(rho ln(1/delta))`, `delta = 1e-5` (Bun & Steinke 2016). No amplification by sampling or
shuffling is claimed.

| z | epsilon per round | rounds within epsilon 16 | rounds within epsilon 8 |
|---:|---:|---:|---:|
| 1 | 11.60 | 1 | 0 |
| **2 (default)** | **5.30** | **6** | 2 |
| 3 | 3.42 | 15 | 4 |
| 4 | 2.52 | 27 | 8 |

Be honest about the size: epsilon 5.3 per round is a weak guarantee by central-DP standards, typical of local DP.
It bounds what any single update reveals about the user's labels; it does not hide *that* the address took part
(the commit/reveal transactions and envelope signatures are public). A user who wants unlinkability should use a
fresh address per round.

### Aggregation and poisoning (`ml/fl/aggregate.js`, `gate.js`)

1. **Shape checks** per update: the round's head hash, round number, size, clip and noise multiplier; every
   coordinate within `C + 6zC` and the norm within `C + zC (sqrt(d) + 6)` (what an honest clipped + noised update
   reaches with overwhelming probability). A sender with two submissions loses both, so the result never depends on
   arrival order.
2. **Coordinate-wise trimmed mean** (20% each side; median and plain mean available). With at most 20% attackers,
   every coordinate of the result lies between the smallest and largest *honest* value of that coordinate
   (`boundedInfluence`, tested on 40 random poisoned rounds). With noise that range is wide (about +-4zC), so this
   bound alone is weak, which the simulation shows.
3. **Canary gate** before anything is proposed: the candidate is compared with the plain trees (theta = 0, not
   the last round, so small losses cannot ratchet). Every recorded red-team evasion the model catches
   (`data/redteam/evasions.jsonl` minus `known-gaps.json`) must stay medium+; recall at medium on the canary rows
   may not fall more than 1 point; false alarms may not rise more than 10 points. In CI, held-out corpus rows can be
   added with `--rows`.
4. **Trust region** (above) and a minimum of 20 valid updates per round.

### Simulated clients (`ml/fl/simulate.js`, `ml/test/fl.test.js`)

Synthetic, and labelled as such. A 30-tree model is trained on a "source" world; browsers live in a **drifted**
world (a new time-bomb family where a time gate means a trap, and fake renounces so "renounced" no longer means
safe). 3,000 browsers with 1-8 labels each; 300 updates per round; 30 rounds; z = 2; trust region 4. Test set: 1,500
rows of the drifted world. Reproduce with `npm run ml:fl:simulate` (about 15 s).

| scenario | AUC before | AUC after | accuracy before | accuracy after | rounds refused by gate |
|---|---:|---:|---:|---:|---:|
| honest, plain mean | 0.741 | 0.806 | 0.641 | 0.749 | 15 |
| honest, trimmed mean 20% (default) | 0.741 | 0.800 | 0.641 | 0.741 | 17 |
| honest, median | 0.741 | 0.807 | 0.641 | 0.734 | 10 |
| honest, trimmed mean, + one weight per tree | 0.741 | 0.786 | 0.641 | 0.729 | 16 |
| honest, trimmed mean, gate off | 0.741 | 0.801 | 0.641 | 0.743 | 0 |
| honest, no noise (no privacy; reference) | 0.741 | 0.764 | 0.641 | 0.720 | 27 |
| honest, no noise, gate off (reference) | 0.741 | 0.795 | 0.641 | 0.730 | 0 |
| honest, trimmed mean, automatic-label noise 5% false scam / 10% missed scam | 0.741 | 0.788 | 0.641 | 0.737 | 4 |
| honest, trimmed mean, automatic-label noise 10% false scam / 30% missed scam | 0.741 | **0.746** | 0.641 | **0.607** | 4 |
| 20% label flippers, plain mean | 0.741 | 0.770 | 0.641 | 0.717 | 3 |
| 20% label flippers, trimmed mean | 0.741 | 0.780 | 0.641 | 0.714 | 4 |
| 15% colluding push-down, plain mean, gate off | 0.741 | **0.357** | 0.641 | 0.381 | 0 |
| 15% colluding push-down, trimmed mean, gate off | 0.741 | 0.630 | 0.641 | 0.402 | 0 |
| 15% colluding push-down, median, gate off | 0.741 | 0.595 | 0.641 | 0.391 | 0 |
| 15% colluding push-down, trimmed mean + gate | 0.741 | **0.741** | 0.641 | 0.641 | 30 |

What this shows, and what it does not:
- Honest browsers fix most of the drift (AUC +0.06, accuracy +0.10) with the privacy noise on.
- Label flipping by 20% of each round only slows learning. Label noise that is one-sided (many scams labelled 0, as a
  wrong automatic "traded normally" would) is worse than adversarial flipping and passes the gate (above).
- The strong attack (colluding clients, each coordinate at the largest value the shape checks accept, aimed at
  lowering scam scores) **wrecks the plain mean**; the trimmed mean and median only **bound** it (the trimmed mean
  of noisy updates is biased by the attackers' share times the noise spread, and that bias adds up over rounds).
  **The gate is what stops it**: every attacked round is refused and the model stays exactly the governance one.
  The cost: an attacker can stall learning (denial of service), not steer it past the gate.
- The gate also refuses many honest rounds: the drifted world really does raise scores on rows of the old world,
  and the noise-free run is refused most because it moves fastest. The tolerances are a policy choice for
  governance; the numbers above are with the defaults.
- A smarter attacker who targets only a pattern absent from the canaries is limited by the trust region, not
  stopped. More and fresher canaries (the weekly red team adds them) shrink that room.
- Users in the simulation join up to 9 rounds (epsilon 18.9); a real browser stops at its budget (6 rounds at
  z = 2, epsilon 16).

### Deployment (`zetaphy fl`, `zetaphy-neuro/ml/fl/deployment.json`)

`FederatedRounds` is **closed by default**: the constructor leaves it paused, so nobody can commit until governance
opens it (reveals of commitments already made stay possible while paused). The deployment path:

```bash
cd zetaphy-network
# 1. deploy (this machine's key pays gas and never holds a role; governance = the ZetaphyTimelock or gov)
node cli.js fl deploy --governance 0x731db92410B3b15Ae4b6b41E47fc3c9a66390340 \
  [--start-in 14400 --commit-blocks 72000 --reveal-blocks 28800 --max-per-round 1000] --out ../zetaphy-neuro/ml/fl/deployment.json
# 2. commit deployment.json in a pull request: the Neuro page and the weekly aggregator read it
# 3. open it through the timelock (prints the call, the timelock schedule/execute data and the operation id;
#    --proposal-out writes a MsgEVMCall gov proposal for zetaphyd tx gov submit-proposal)
node cli.js fl propose open --timelock 0x731db92410B3b15Ae4b6b41E47fc3c9a66390340 [--proposal-out open.json]
node cli.js fl status          # open/closed, round, phase, commits, reveals (read only)
```

`fl deploy` refuses a governance that is a single key (an EOA) or the deployer itself (allowed only with `--devnet` on
a local RPC), checks the new contract reads back as closed, and prints the record. Defaults: one round a week at ~6 s
blocks (5 days commit + 2 days reveal), first round a day after the deploy, at most 1,000 commits a round.
`fl propose close | max <n> | governance <0x…>` print the other governance calls; `fl config` writes the record for a
contract deployed another way. The same deploy runs from the workflow (`mode: deploy`, below), which pushes the record
to the branch `neuro-fl/deployment` for a pull request. The committed record today has `rounds: null`, and the page
says "not deployed yet".

### Aggregator and governance

```bash
# anyone, any machine: same inputs -> same head, byte for byte
node zetaphy-network/scripts/fl-aggregate.js --round 3 --inbox zetaphy-neuro/ml/fl/inbox \
  [--rpc https://… --rounds 0xFederatedRounds] [--rows held-out.jsonl] --out out/fl \
  [--registry 0xModelEpochs --gov-bech32 zetaphy1… --activation 1234000 --uri https://…/manifest.json]
```

Without `--rounds`/`--rpc` it uses `zetaphy-neuro/ml/fl/deployment.json` (`--deployment` for another file), and without
`--round` the last finished round. `--min-updates` (default 20) may be lowered only on a devnet or in tests.

It writes `head.json`, `manifest.json`, `decision.json`, `body.md` and, with `--registry`, `proposal.json` (a
`MsgEVMCall` from the gov module to `ModelEpochs.schedule`, for `zetaphyd tx gov submit-proposal`). The weekly job
`.github/workflows/neuro-fl.yml` (Thursdays 05:43 UTC, `contents: read`; only the PR job may write) runs it on the
last finished round and opens a pull request when the gate passes. It needs **no secret and no setting** once a
deployed `deployment.json` is committed (repository variables `ZETAPHY_RPC`, `FL_ROUNDS_ADDRESS`, `MODEL_EPOCHS_ADDRESS`,
`GOV_BECH32`, `FL_ACTIVATION` still override or add the proposal); until then it does nothing. The manual `mode: deploy`
run is the only job with a key: the existing secret `ZETAPHY_DEPLOYER_KEY`, which lives only in the `testnet-deploy`
environment (main only, the owner approves each run; `docs/SECRETS-HARDENING.md`). No new secret is needed. The pull request is not the decision: the
manifest takes effect only when a vote schedules its hash in the ModelEpochs (item 35). Voters can rerun the
script and compare the hash.

A new tree model from the weekly training (`neuro-ml.yml`) resets the head to theta = 0 and rewrites the manifest
(`node ml/fl/manifest.js`); `node ml/fl/manifest.js --check` and the tests fail when the committed manifest is stale.

### Limits and what remains (item 6)

- **Not deployed yet.** `FederatedRounds` is tested on the in-memory EVM (unit tests and a five-browser Chromium
  round); the deploy, the record and the open proposal are one manual workflow run + two pull requests + a timelock
  operation away. Until then the panel stores answers locally and sends nothing.
- **No real labels yet**, so no claim about real-world accuracy. All numbers above are a synthetic drift scenario.
  The automatic labels' real error rates are unknown; the simulation shows one-sided noise (missed scams) can undo the
  gain without the gate noticing. Before a head trained on real labels is proposed, governance should see the rejected
  rounds and add **fresh canaries from the drifted world** (recent, independently confirmed scams and clean tokens),
  so the gate measures what the labels claim to teach.
- **Sybil resistance is not provided.** One address = one update per round; anyone can make many addresses. Robust
  aggregation assumes attackers are a minority of a round's updates. Options: require a NeuroIdentity registration
  or a small refundable bond to commit, or weight by runner stake.
- **No secure aggregation.** Each update is public on chain, which is why the noise must be local and large. Secure
  aggregation (or a trusted shuffler) would allow far less noise; it needs an interactive protocol between clients that
  this no-server design does not have.
- **Participation is public.** The commit and reveal transactions show that an address took part (not what it
  labelled); use a fresh address for unlinkability. The re-reads for automatic labels reveal the token to public RPCs,
  as a check does.
- **Re-checks need the page open.** There is no background job in the browser; outcomes are read when the user visits
  (a few automatically) or presses "Re-check". Tokens checked once and never revisited get user labels only.
- **Off-chain envelopes are not in the panel.** The signed-envelope path (`src/fl.js`, `ml/fl/inbox/`) stays for
  runners and tools; the browser uses commit-reveal only.
- Label quality: a user's "outcome" can be wrong or malicious; the gate and trust region bound the damage, they do
  not make labels true.

---

## Item 35: a model version bound to chain height

### Contract (`zetaphy-network/contracts/ModelEpochs.sol`)

| call | who | rule |
|---|---|---|
| `schedule(bytes32 hash, uint64 activation, string uri)` | governance | `hash != 0`; `activation % epochLength == 0`; `activation >= block.number + minDelay` (minDelay >= 1); activation above the last version's; `1 <= len(uri) <= 256` |
| `cancelLast()` | governance or a guardian | only the latest version, only while `activation > block.number` |
| `versionAt(uint256 h)` | anyone | `(found, index, hash, activation, uri)` of the last version with `activation <= h`; `found = false` before the first |
| `current()` | anyone | `versionAt(block.number)` |
| `count()`, `versionByIndex(i)`, `epochLength()`, `minDelay()` | anyone | |
| `setMinDelay`, `setGuardian`, `setGovernance` | governance | |

`hash` is the sha256 of the manifest file's exact bytes (`zetaphy-neuro/ml/manifest.json`):

```json
{
 "format": "neuro-model-manifest/1",
 "model": { "id": "nml-…", "sha256": "<file sha256>", "path": "ml/model.json" },
 "head": { "id": "nfh-…", "sha256": "<file sha256>", "path": "ml/fl/head.json" }
}
```

The committed manifest (model `nml-3ab3cd303911`, zero head `nfh-543c87aea110`) has sha256
`0x15997221ce73b6007a45ee8d47f491c4ce83c895dcfae37195028506f59f57a7`.

**Finality argument.** At block `b`, `schedule` needs `activation >= b + minDelay > b` and `cancelLast` needs the
version's `activation > b`. So no transaction in block `h` or later can add, remove or change a version with
`activation <= h`. Therefore `versionAt(h)` evaluated on the state after block `h-1` equals `versionAt(h)` evaluated
on any later state. Tested in `test/modelepochs.test.js` ("cannot change once the chain is past h-1").

### Selection in JS (browsers, runners): `zetaphy-neuro/ml/fl/registry.js`

- `selectVersion(versions, height)`: binary search for the last `activation <= height`, `null` before the first.
  Tested against a linear scan (200 random schedules) and against the contract's `versionAt` (60 random heights).
- `loadForHeight({ versions, height, fetchBytes })`: selects, fetches the manifest from `uri`, checks its sha256
  against the registry, fetches the model and head and checks theirs, checks ids. Any mismatch throws: a browser
  that cannot verify falls back to the rules alone, never to another model.
- `zetaphy-network/src/modelepochs.js`: `readVersions`, `versionForHeight` (JS selection cross-checked with the
  contract), `onChain(address, provider, blockTag)` to read at a given block, and `scheduleProposal(...)` (gov
  proposal JSON).

Which height to use: the height of the block that **defines the question**. For a live scan in a browser, the
latest block it reads; for a network job, the block of its request transaction (the request event's block number;
`NeuroJobs` also keeps a round's `startBlock`), so every runner of that job selects the same version however late it runs; for re-checking an old report, the height
stored with it.

### Node side (in the chain patch: `zetaphy-chain/setup-node.sh`, file `evmd/zetaphy_modelat.go`)

The registry is an EVM contract, so nodes need no new state beyond its address: they read it.

1. **Where the registry is.** One 20-byte value in the `zetaphypq` store (key `0x30`, with the other v5 settings),
   set only by governance through `MsgSetFuture{kind: "model-epochs", data: {"address":"0x…"}}`:
   ```bash
   bash zetaphy-chain/gov.sh model-epochs 0xModelEpochs   # - removes it (no model in consensus)
   ```
   The chain refuses an address with no contract, and refuses the setting before the v5 height like every v5
   setting. The value is kept in genesis exports. (The spec's `neuro.model_epochs` "module param" is this value:
   the chain has no neuro module, and v5 keeps every setting in the `zetaphypq` store.) Recommended deployment:
   `governance` = the gov module's EVM address `0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2`, `epochLength = 14400`
   (one day at 6 s blocks) and `minDelay >= epochLength`.
2. **Lookup.** `app.ModelVersionAt(ctx sdk.Context, h int64) (ModelVersion{Found, Index, Hash, Activation, URI}, error)`:
   a read-only EVM call of `versionAt(h)` on a cache context that is never written back (no commit, 200,000 gas,
   `from` = the `neuro` module address `authtypes.NewModuleAddress("neuro")`, free gas meter, no events). Not found,
   with the reason in `error`, when: no registry is set, no code at it, the call reverts or runs out of gas, the
   answer is not the ABI shape or longer than 4 KiB, or the registry breaks its own rules (a zero hash, an
   activation above `h`, an empty uri or one above 256 bytes). Called while processing block `h`, the context's
   state is the committed state after `h-1`, whose answer is final (finality argument above).
3. **Determinism rules.** Consensus code compares **hashes only**. It never downloads the manifest or files in the
   consensus path. A validator that has not fetched and verified the files for the selected hash, or whose local
   files hash differently, **abstains** (puts no ML score in its vote extension) rather than use another version.
   VerifyVoteExtension must reject an extension whose stated model hash differs from `ModelVersionAt(h).Hash`. These
   rules bind whatever first puts a model output into consensus; today nothing does.
4. **Queries.** All read the state after `height - 1` (an archive node for old heights) and give
   `{height, stateHeight, registry, found, index, hash, activation, uri, error}`:
   - `zetaphyd q neuro model-at <height>` (`gov.sh model-at <height>`);
   - JSON-RPC `zetaphy_modelAt(height)` on the public EVM endpoint (8545), next to `zetaphy_faucet` and the other
     `zetaphy_*` methods;
   - `modelEpochs()` on the AI precompile `0x…0902` returns the registry address, so contracts can call
     `versionAt` on it directly.

   The queries read the registry address with a store query and run `versionAt` through the EVM module's `EthCall`
   at that height; the tests check this path against the keeper lookup. Browsers and runners can still use
   `eth_call` with `blockTag = height - 1`, which gives the same answer. A separate gRPC service
   `zetaphy.neuro.v1.Query/ModelAt` was not added: the chain's other ZETAPHY queries are JSON-RPC and CLI, and the
   EVM module's `EthCall` query is already there for gRPC clients.
5. **Off-chain fetch (outside consensus).** Not a daemon: the runner or browser calls `zetaphy_modelAt` (or
   `eth_call`) and `loadForHeight` (`zetaphy-neuro/ml/fl/registry.js`) fetches the manifest and files and checks
   every sha256, starting at least one epoch before activation (minDelay guarantees the notice).
6. **Tests** (`zetaphy-chain/fork-tests/evmd/zetaphy_modelat_test.go`, `TestFutureModelAt`, on the real
   `ModelEpochs` bytecode from `artifacts/ModelEpochs.json`):
   - no registry set; a non-contract, a non-governance sender and unknown JSON fields refused; the `modelEpochs()`
     view;
   - an empty registry (no version, no error);
   - versions at 20 and 30: not found at 11 and 19, the first at 20 and 29, the second at 30 and 1,000,000;
     the query path (`EthCall`) agrees at every height;
   - determinism: 20 repeated lookups agree, with no account, nonce or event change; a second app that replays the
     same txs gives the same answer at every height;
   - finality: at height 21, `cancelLast` drops only the version at 30, the version in force cannot be cancelled
     or replaced, and every answer for heights <= 21 stays;
   - a registry that loops (out of gas), one that answers junk, and decoded answers that break the rules (an
     activation above `h`, a zero hash) are "not found"; height 0 is refused;
   - removal by governance; the genesis export keeps the address; the `security-proposal model-epochs` command.

**What remains (item 35, node side).**

- Nothing in consensus uses the model (`combine.js` keeps it out of the verdict and reportHash on purpose), so the
  abstain / VerifyVoteExtension rule of point 3 has no caller yet; it applies when an ML score enters a vote
  extension.
- The multi-validator devnet test of the spec (3 validators, a version scheduled at `H`, replay from genesis, a
  wrong-hash vote extension rejected) is not done: the fork tests run the real keeper, EVM and contract inside one
  app, and `TestFutureModelAt` compares two apps. `zetaphy_modelAt` and `q neuro model-at` were run once by
  hand against a single-node devnet (`zetaphy-network/scripts/devnet.sh`) with a stand-in registry put in genesis
  (both answered from the state after `height - 1`; height 1 is refused); not yet against the real `ModelEpochs`
  on a live chain, and there is no devnet test in CI for it.
- No sidecar process that pre-fetches files; `loadForHeight` does it on demand.
- Running v5 chains get the new store key, the `modelEpochs()` view and the queries with the new binary; the
  registry stays unset (nothing changes) until a governance vote sets it.

---

## Files

- `zetaphy-neuro/ml/fl/`: `head.js` (head, trust region, hashing), `client.js` (+ `roundUpdate`), `dp.js` (clip, noise,
  zCDP accounting, ledger), `codec.js` (wire format), `aggregate.js` (shape checks, trimmed mean, median), `gate.js`,
  `labels.js` (user + automatic outcome labels), `rounds.js` (browser FederatedRounds client), `deployment.js` +
  `deployment.json` (where the contract is; `rounds: null` today), `registry.js` (version by height, manifests),
  `manifest.js` (writes/checks `ml/manifest.json`), `simulate.js` (+ label noise), `head.json` (committed zero head), `inbox/`.
- `zetaphy-neuro/web/`: `fl-panel.js` (the panel), `fl-worker.js` (training in a Web Worker), `fl-wallet.js` (EIP-6963 +
  the hub's shared wallet id), `fl-i18n.js` (en zh es ko ja ru vi th), `fl.css`; `zetaphy-hub/build.mjs` ships `ml/` as
  `neuro/ml/` (runtime files only).
- `zetaphy-neuro/ml/manifest.json`; `zetaphy-neuro/ml/combine.js` (optional `head`).
- `zetaphy-neuro/ml/test/fl.test.js`, `registry.test.js`, `flbrowser.test.js`, `fl.browser.e2e.js`;
  `zetaphy-neuro/test/fl.e2e.js` (five Chromium browsers, a whole round on the real contract in an in-memory EVM,
  then `fl-aggregate.js` over JSON-RPC), `test/helpers/fl-chain.js`.
- `zetaphy-network/contracts/ModelEpochs.sol`, `FederatedRounds.sol` (+ `artifacts/`), `src/modelepochs.js`,
  `src/fl.js`, `src/flcli.js` (`zetaphy fl …`), `scripts/fl-aggregate.js`, `test/modelepochs.test.js`,
  `test/federated.test.js`, `test/flcli.test.js`.
- `.github/workflows/neuro-fl.yml`; `.github/workflows/neuro-ml.yml` (regenerates the manifest with a new model).

## Commands

```bash
cd zetaphy-neuro
node --test ml/test/fl.test.js ml/test/registry.test.js ml/test/flbrowser.test.js
node --test ml/test/fl.browser.e2e.js test/fl.e2e.js      # the client and the panel in Chromium (~70 s)
npm run ml:fl:simulate                                    # the table above
node ml/fl/manifest.js [--check]
cd ../zetaphy-network
node --test test/modelepochs.test.js test/federated.test.js test/flcli.test.js
node cli.js fl status | fl propose open --timelock 0x… | fl deploy --governance 0x… (see Deployment)
```
