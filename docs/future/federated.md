**English** | [ภาษาไทย](federated.th.md)

# Federated learning for Neuro, and a model bound to chain height

Workstream `fut-federated`. Two items:

| # | item | status |
|---|---|---|
| 6 | Federated learning for Neuro's learned score (`zetaphy-neuro/ml/`) | **prototype**: client, privacy, wire format, commit-reveal contract, signed envelopes, robust aggregation, canary gate, aggregator script + weekly workflow, simulated honest and poisoned clients. No browser UI yet, no real labels yet, contracts not deployed. |
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
rows of the drifted world. Reproduce with `npm run ml:fl:simulate` (about 6 s).

| scenario | AUC before | AUC after | accuracy before | accuracy after | rounds refused by gate |
|---|---:|---:|---:|---:|---:|
| honest, plain mean | 0.741 | 0.806 | 0.641 | 0.749 | 15 |
| honest, trimmed mean 20% (default) | 0.741 | 0.800 | 0.641 | 0.741 | 17 |
| honest, median | 0.741 | 0.807 | 0.641 | 0.734 | 10 |
| honest, trimmed mean, + one weight per tree | 0.741 | 0.786 | 0.641 | 0.729 | 16 |
| honest, trimmed mean, gate off | 0.741 | 0.801 | 0.641 | 0.743 | 0 |
| honest, no noise (no privacy; reference) | 0.741 | 0.764 | 0.641 | 0.720 | 27 |
| honest, no noise, gate off (reference) | 0.741 | 0.795 | 0.641 | 0.730 | 0 |
| 20% label flippers, plain mean | 0.741 | 0.770 | 0.641 | 0.717 | 3 |
| 20% label flippers, trimmed mean | 0.741 | 0.780 | 0.641 | 0.714 | 4 |
| 15% colluding push-down, plain mean, gate off | 0.741 | **0.357** | 0.641 | 0.381 | 0 |
| 15% colluding push-down, trimmed mean, gate off | 0.741 | 0.630 | 0.641 | 0.402 | 0 |
| 15% colluding push-down, median, gate off | 0.741 | 0.595 | 0.641 | 0.391 | 0 |
| 15% colluding push-down, trimmed mean + gate | 0.741 | **0.741** | 0.641 | 0.641 | 30 |

What this shows, and what it does not:
- Honest browsers fix most of the drift (AUC +0.06, accuracy +0.10) with the privacy noise on.
- Label flipping by 20% of each round only slows learning.
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

### Aggregator and governance

```bash
# anyone, any machine: same inputs -> same head, byte for byte
node zetaphy-network/scripts/fl-aggregate.js --round 3 --inbox zetaphy-neuro/ml/fl/inbox \
  [--rpc https://… --rounds 0xFederatedRounds] [--rows held-out.jsonl] --out out/fl \
  [--registry 0xModelEpochs --gov-bech32 zetaphy1… --activation 1234000 --uri https://…/manifest.json]
```

writes `head.json`, `manifest.json`, `decision.json`, `body.md` and, with `--registry`, `proposal.json` (a
`MsgEVMCall` from the gov module to `ModelEpochs.schedule`, for `zetaphyd tx gov submit-proposal`). The weekly job
`.github/workflows/neuro-fl.yml` (Thursdays 05:43 UTC, `contents: read`; only the PR job may write) runs it on the
last finished round and opens a pull request when the gate passes. The pull request is not the decision: the
manifest takes effect only when a vote schedules its hash in the ModelEpochs (item 35). Voters can rerun the
script and compare the hash.

A new tree model from the weekly training (`neuro-ml.yml`) resets the head to theta = 0 and rewrites the manifest
(`node ml/fl/manifest.js`); `node ml/fl/manifest.js --check` and the tests fail when the committed manifest is stale.

### Limits and what remains (item 6)

- **No browser UI yet.** Nothing in the Neuro page or the hub asks users for outcome labels or submits updates.
  The client library is ready and runs in Chromium; the UI (label buttons after a scan, "share a private update"
  with the epsilon shown, all 8 languages, strict CSP) is the next step.
- **No real labels yet**, so no claim about real-world accuracy. All numbers above are a synthetic drift scenario.
- **Sybil resistance is not provided.** One address = one update per round; anyone can make many addresses. Robust
  aggregation assumes attackers are a minority of a round's updates. Options: require a NeuroIdentity registration
  or a small refundable bond to commit, or weight by runner stake.
- **No secure aggregation.** Each update is public (on chain) or visible to the aggregator, which is why the noise
  must be local and large. Secure aggregation (or a trusted shuffler) would allow far less noise; it needs an
  interactive protocol between clients that this no-server design does not have.
- **Contracts not deployed.** `FederatedRounds` and `ModelEpochs` are compiled and tested on the in-memory EVM
  only. The workflow does nothing until the repository variables are set.
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

The committed manifest (model `nml-b4c35477f7b1`, zero head `nfh-ec54f839dc2d`) has sha256
`0xc8e6eb9ced9494e6773d0850d434c8dd436a5d76ba67f59ff0d29a8e8c1d9549`.

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

- `zetaphy-neuro/ml/fl/`: `head.js` (head, trust region, hashing), `client.js`, `dp.js` (clip, noise, zCDP
  accounting, ledger), `codec.js` (wire format), `aggregate.js` (shape checks, trimmed mean, median), `gate.js`,
  `registry.js` (version by height, manifests), `manifest.js` (writes/checks `ml/manifest.json`), `simulate.js`,
  `head.json` (committed zero head), `inbox/`.
- `zetaphy-neuro/ml/manifest.json`; `zetaphy-neuro/ml/combine.js` (optional `head`).
- `zetaphy-neuro/ml/test/fl.test.js`, `registry.test.js`, `fl.browser.e2e.js`.
- `zetaphy-network/contracts/ModelEpochs.sol`, `FederatedRounds.sol` (+ `artifacts/`), `src/modelepochs.js`,
  `src/fl.js`, `scripts/fl-aggregate.js`, `test/modelepochs.test.js`, `test/federated.test.js`.
- `.github/workflows/neuro-fl.yml`; `.github/workflows/neuro-ml.yml` (regenerates the manifest with a new model).

## Commands

```bash
cd zetaphy-neuro
node --test ml/test/fl.test.js ml/test/registry.test.js   # ~4 s
node --test ml/test/fl.browser.e2e.js                     # the client in Chromium
npm run ml:fl:simulate                                    # the table above
node ml/fl/manifest.js [--check]
cd ../zetaphy-network
node --test test/modelepochs.test.js test/federated.test.js
```
