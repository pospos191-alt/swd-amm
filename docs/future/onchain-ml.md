**English** | [ภาษาไทย](onchain-ml.th.md)

# On-chain ML scoring and a zkML prototype (testnet)

Two items of the "future" workstream, built on Neuro's learned risk model (`zetaphy-neuro/ml/`, gradient-boosted
trees, 160 trees of depth <= 4 over 133 features, committed model `nml-b4c35477f7b1`):

| item | status |
|---|---|
| (3) the model evaluated on-chain (`NeuroScore`), exporter, parity test, optional DEX router check, governance-only model updates | **done (testnet prototype)**, tested on an in-memory EVM |
| (4) zkML: a Groth16 proof that "this committed feature vector yields this margin under model hash H" + on-chain verifier | **prototype, run and measured here**; the trusted setup is single-party, so testnet only |

Everything here is testnet-only. A score is a statistical estimate from synthetic training data (see `ml/README.md`,
"Results": the numbers there overstate real-world accuracy), never a finding about a project.

## 1. Fixed-point export (`zetaphy-neuro/ml/onchain/`)

`node ml/onchain/export.js` turns `ml/model.json` into integers and packs them (`fixed.js` documents the format):

- one scale S = 1e7. Feature `X = round(x*S)` as a u32 (Neuro's features are all >= 0; max 429.49 before clamping),
  threshold `T = round(t*S)` (a row goes left when `X <= T`), leaf / base `round(v*S)` as int32.
- margin `Z = base + sum of the leaves reached`; score `s = trunc(calibA * Z / S) + calibB` = the **Platt-calibrated logit x 1e7**,
  so `p = sigmoid(s / 1e7)`. Levels low / medium / high are thresholds on `s` (`round(logit(p_level) * S)`: 0 / 13,862,944 / 29,444,390).
- packing "NSM1": 24-byte header, 1 byte node count per tree, then 6 bytes per node in pre-order (left child = next node):
  `[feature u8][threshold u32][right index u8]` or a leaf `[0xFF][value i32][0x00]`. The committed model: 3,072 nodes,
  **18,616 bytes** (the float JSON is 87 KB). Its keccak256 is the model hash **H**
  (`0x7c420111…a4132`, in `ml/onchain/model.fixed.json`).
- `ml/onchain/heldout.json` = the trainer's own held-out split (390 rows, 201 scam, never trained on), cut from the
  regenerated corpus (`npm run ml:corpus`; the current model's AUC on it reproduces `metrics.json`: 0.9975).

### Parity (the documented tolerance)

On all 390 held-out rows:

| comparison | result | tolerance asserted in tests |
|---|---|---|
| Solidity `NeuroScore.evaluate` vs JS fixed-point (`evalFixed`) | **identical** integer score and level on every row | exact |
| JS float model vs JS fixed-point | max \|p_float - p_fixed\| = 1.3e-7, max \|logit diff\| = 8.6e-7 | \|dp\| <= 1e-6, \|dlogit\| <= 2e-5 |
| decisions (level reached: none / low / medium / high) | **same on all 390 rows** | any flip must sit within 1e-6 of a level threshold |

Why it can differ at all: rounding is monotone, so a row takes another branch than the float model only if a feature is
within 1/S = 1e-7 of a threshold. A first version with S = 1e6 hit exactly that on one held-out row (`g3_20` = 0.0779459 vs
threshold 0.0779458, logit off by 0.09, no level change), which is why S is 1e7. Leaf rounding alone is bounded by
160 x 0.5e-7. Tests: `zetaphy-neuro/ml/test/onchain.test.js` (export up to date + float vs fixed),
`zetaphy-network/test/neuroscore.test.js` (Solidity vs both).

## 2. `NeuroScore` (`zetaphy-network/contracts/NeuroScore.sol`)

- **publishModel(bytes)** (anyone): checks the NSM1 layout (every feature index < nFeatures, right child after its node and
  inside its tree, every path ends in a leaf, sizes add up) and stores the bytes as the code of data contracts (24,575 bytes
  each, more chunks for a bigger model; tested with a 2-chunk model). Publishing activates nothing.
- **activateModel(H, modelId, low, medium, high)**: governance only = the `ZetaphyTimelock` (48 h delay on the testnet
  setup in the tests; the multisig itself is refused). This contract is the model registry: each activation is a numbered
  `version` with its hash, id, levels and time, readable by `model(v)`. No separate model registry exists in the repo.
- **setFeeder(addr, bool)**: governance only. A feeder (a relay for Neuro runners' results) posts a token's feature vector
  with **postFeatures(token, bytes)**; the contract runs the model and stores score, level, version and the vector's hash; the
  vector itself is in the `Scored` event.
- **rescore(token, bytes)** (anyone, with the preimage of the stored hash) re-runs it under the active model.
  **scoreOf(token)** returns `known = false` for a token never scored or scored only under an older model.
- **evaluate(bytes)** / **evaluateAt(v, bytes)**: pure model evaluation (view).

Gas (in-memory EVM, Cancun rules, measured by the tests):

| call | gas |
|---|---|
| `evaluate` (load 18.6 KB via EXTCODECOPY + 160 trees), execution only | mean 126k, max 130k over 60 held-out rows |
| `postFeatures` (532 bytes of features; evaluate + store + event), whole transaction | ~205k |
| `publishModel` (18,616 bytes, one-off), whole transaction | ~6.05M |
| router buy check when on (one stored-score read) | ~+2.5k execution gas per bought token |

What it does **not** prove: that the posted features are what Neuro would compute for the token. The chain proves "stored
score = active model(posted vector)"; the feeder is trusted for the vector. Features need bytecode analysis plus a buy/sell
simulation, which is far too expensive to run in the EVM. Closing that gap would need runners' 2-of-3 agreement on the
vector (as `src/verdict.js` does for verdicts) or a proof of the feature extraction itself (not attempted).

## 3. DEX router check (`zetaphy-dex`)

- `ZetaphyFactory.setNeuroScore(scorer, threshold)`: **governance only, OFF by default** (`neuroScore = 0`). The address must
  answer `scoreOf` within `SCORE_GAS` = 50,000 when set (a typo cannot stop buys). `threshold` is in score units;
  `node cli.js set-neuro-score <NeuroScore> --min-p 0.8` converts a probability.
- `ZetaphyRouter._checkPath` (every swap): for each token received along the path (not the native coin) it refuses with
  `TokenScoreTooHigh(token, score)` when the token has a **current** score `>= threshold`. Unscored tokens and tokens scored only
  under an older model pass. Selling, `addLiquidity` and `removeLiquidity` never ask the scorer. A scorer that reverts, answers
  junk or needs more than `SCORE_GAS` **fails closed** (`ScoreUnavailable`) for buys only, until governance sets it to zero.
  The router reads registry, scorer and threshold in one call (`factory.buyChecks()`).
- Web app: error texts for both errors in all 8 languages (`web/i18n.js`).
- Tests: `zetaphy-dex/test/neuroscore.test.js` (real NeuroScore + the exported model: off by default, governance-only,
  NotAScorer, every swap kind and multi-hop refused, sells/liquidity/low-score/unscored allowed, model change -> unknown -> rescore,
  fail-closed, threshold boundary, gas, CLI conversion).
- Not done: the DLMM router (`contracts/dlmm/`) has only the ThreatRegistry check, not the score check.

## 4. Model updates

1. The weekly `neuro-ml.yml` run trains a candidate; the "candidate must pass the ML tests" step now also runs
   `node ml/onchain/export.js --heldout`, and the PR it opens includes `ml/onchain/model.fixed.json` + `heldout.json`.
2. After a human merges: anyone calls `NeuroScore.publishModel(bytes)` with `bytes` from `model.fixed.json`.
3. Governance schedules the activation through the timelock; `export.js` prints the exact command:
   `zetaphy timelock schedule --to <NeuroScore> --sig "activateModel(bytes32,bytes32,int64,int64,int64)" --args <H>,<id>,<low>,<medium>,<high>`,
   then `zetaphy timelock execute <id>` after the delay. Everyone sees H during the delay and can check it against the PR.
4. Old scores read as unknown until `rescore` (permissionless) or a new `postFeatures`. This avoids judging tokens with a
   stale model, at the price of the router check being inactive for them until rescored.

## 5. zkML prototype (`zetaphy-neuro/ml/onchain/zk/`)

Tooling (all free, npm, no native binaries): **circom 2** through `circom2` 0.2.23 (the official compiler built to WASM),
**snarkjs 0.7.6** (Groth16 on BN254), **circomlib 2.0.5** (Num2Bits, Poseidon). Installed and run in this sandbox.

Circuit (`gen-circuit.js`, generated from the packed bytes, so it is exactly model H):

- private: the 133 u32 features `x`, a random `salt`. Public outputs: `commitment` = Poseidon chain over
  `[salt, x packed 7 per field element]`, `margin` = Z + 2^40, and H as two 128-bit halves (constants of the circuit).
- every feature range-checked to 32 bits; each of the **373 distinct (feature, threshold) pairs** is one 33-bit decomposition
  (`x <= T` = bit 32 of `T + 2^32 - x`); 1,296 multiplications build the path indicators (one leaf per tree is 1); the
  margin is a linear sum of leaf values.
- **21,689 constraints** (18,797 non-linear), fits powers of tau 2^15.

Measured here (`node run.js --rows 5`, Node 22, one Intel Xeon 2.1 GHz sandbox core set):

| step | result |
|---|---|
| compile circuit | ~9 s |
| powers of tau 2^15, made locally (new + 1 contribution + prepare phase 2), one-off | 495 s |
| Groth16 setup + 1 phase-2 contribution | 12-20 s, proving key 11.3 MB |
| prove one row (witness + proof, snarkjs in Node) | 1.0-1.5 s (mean 1.1-1.3 s over 5 rows, two runs) |
| verify in JS | 0.02-0.09 s |
| proof size | 256 bytes on-chain (Groth16: 2 G1 + 1 G2 points), 722 bytes as snarkjs JSON; 4 public signals |
| on-chain `verifyProof` (`NeuroScoreVerifier.sol`, snarkjs template) | 209k execution gas, ~235k as a transaction |

Each proof's margin was checked against the JS fixed-point margin and its hash halves against H. Test:
`zetaphy-network/test/neuroscore-zk.test.js` (accepts the committed proof; rejects any changed public signal, a lower
margin, a broken proof point). CI: `.github/workflows/neuro-zk.yml` (on demand and on PRs touching the model / zk code)
rebuilds everything with a fresh setup on the runner, then runs that on-chain test against the fresh verifier; nothing is committed.

Limits, honestly:

- **The trusted setup is single-party** (this sandbox, then each CI run). Whoever runs it could keep the randomness and forge
  proofs. `NeuroScoreVerifier.sol` is committed only as a testnet artifact with that warning in its header. A real deployment
  needs phase 1 from a public ceremony (e.g. the Perpetual Powers of Tau / Hermez files) and a multi-party phase 2, or a
  transparent system (PLONK with a universal setup, or STARKs) at a cost in proof size/gas.
- **Same trust gap as NeuroScore**: the proof shows the model was applied correctly to a committed vector, not that the vector
  is the token's real features. What zk adds: the vector can stay private (only its commitment is public), and checking a
  proof (~235k gas) does not depend on model size, whereas on-chain evaluation grows with the trees.
- The model is hard-wired: every new model needs a new circuit and a new setup (a new verifier contract). Keeping the model
  private as a witness with a Poseidon commitment would avoid that, at a larger circuit; not attempted.
- Not wired into `NeuroScore` or the router: a contract that accepts `(token, commitment, margin, proof)` when the proof's H
  equals the active model's hash is the obvious next step and was left out of this prototype.
- Proof timings are from this sandbox; browser proving (snarkjs runs in browsers) was not measured.

## Files

- `zetaphy-neuro/ml/onchain/fixed.js`, `export.js`, `model.fixed.json`, `heldout.json`, `ml/test/onchain.test.js`
- `zetaphy-neuro/ml/onchain/zk/gen-circuit.js`, `run.js`, `package.json` (+ lock)
- `zetaphy-network/contracts/NeuroScore.sol`, `NeuroScoreVerifier.sol` (generated), `test/neuroscore.test.js`,
  `test/neuroscore-zk.test.js`, `test/fixtures/neuroscore-zk.json`
- `zetaphy-dex/contracts/ZetaphyFactory.sol`, `ZetaphyRouter.sol`, `contracts/test/DexTestHelpers.sol` (`GasHogScorer`),
  `cli.js` (`set-neuro-score`), `web/i18n.js`, `test/neuroscore.test.js`
- `.github/workflows/neuro-ml.yml` (exports with each candidate), `.github/workflows/neuro-zk.yml`
