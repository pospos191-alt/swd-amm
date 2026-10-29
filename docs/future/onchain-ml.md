**English** | [ภาษาไทย](onchain-ml.th.md)

# On-chain ML scoring and a zkML prototype (testnet)

Two items of the "future" workstream, built on Neuro's learned risk model (`zetaphy-neuro/ml/`, gradient-boosted
trees, 160 trees of depth <= 4 over 133 features, committed model `nml-b4c35477f7b1`):

| item | status |
|---|---|
| (3) the model evaluated on-chain (`NeuroScore`), exporter, parity test, optional DEX router check, governance-only model updates | **done (testnet prototype)**, tested on an in-memory EVM |
| (4) zkML: a Groth16 proof that "this committed feature vector yields this margin under model hash H" + on-chain verifier | **ceremony tooling done**: public phase 1 pinned, multi-party phase 2 (CLI + browser page + PR-checking workflow + beacon), verifier with model-hash binding. The **public ceremony has not been run yet** (no participants so far), so the committed verifier still comes from a one-machine rehearsal: testnet only until the owner runs it (section 6) |

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

## 5. zkML (`zetaphy-neuro/ml/onchain/zk/`)

Tooling (all free, npm, no native binaries): **circom 2** through `circom2` 0.2.23 (the official compiler built to WASM),
**snarkjs 0.7.6** (Groth16 on BN254, pinned exactly in `package.json` + lock), **circomlib 2.0.5** (Num2Bits, Poseidon).

Circuit (`gen-circuit.js`, generated from the packed bytes, so it is exactly model H):

- private: the 133 u32 features `x`, a random `salt`. Public outputs: `commitment` = Poseidon chain over
  `[salt, x packed 7 per field element]`, `margin` = Z + 2^40, and H as two 128-bit halves (constants of the circuit).
- every feature range-checked to 32 bits; each of the **373 distinct (feature, threshold) pairs** is one 33-bit decomposition
  (`x <= T` = bit 32 of `T + 2^32 - x`); 1,296 multiplications build the path indicators (one leaf per tree is 1); the
  margin is a linear sum of leaf values.
- **21,689 constraints** (18,797 non-linear, 21,318 wires), fits a phase-1 file of power 15 (32,768).

### Trusted setup: public phase 1 + multi-party phase 2

Groth16 needs a setup whose secret randomness ("toxic waste") must be destroyed: whoever knows it can make a false
proof verify. It has two phases, and both are now multi-party:

- **Phase 1 (powers of tau, any circuit)**: not ours. `ceremony/phase1.json` pins the **Perpetual Powers of Tau**
  (BN254, 80+ independent contributors 2019-2023, coordinated by the Ethereum Foundation's PSE team), contribution 0080 with
  PSE's beacon applied, prepared for phase 2 and cut to power 15 by PSE: `ppot_0080_15.ptau`, 37,842,066 bytes, listed in
  their README. PSE publishes no per-file hash for the cut files, so the pin is the sha256 **and** blake2b-512 of the bytes
  downloaded on 2026-10-29 (`lib.js getPtau()` deletes and refuses any other bytes). Anyone can re-check that the file
  carries the public contributions and beacon with `snarkjs powersoftau verify` (the `neuro-zk-ceremony` workflow runs it on
  demand, input `verify_phase1`; it ran for more than 45 minutes on one core here without finishing, so that check was not
  completed in this sandbox). The better-known Hermez file, whose blake2b is printed in the snarkjs README, answered
  HTTP 403 from its bucket, so it is listed only as an alternative.
- **Phase 2 (this circuit)**: the ceremony in `ceremony/`, run with no server of ours:
  - `ceremony.js init` makes the initial key with `groth16 setup` from the circuit and the pinned phase 1. That step is
    deterministic: the verifier rebuilds it bit for bit (sha256 `4351818234f5…`, 11,338,460 bytes) and the first
    contributor can rebuild it too.
  - **Contributors** each add a random value and forget it: on the command line (`ceremony.js contribute --name … --github …`,
    entropy = 64 bytes from the OS CSPRNG + typed text, mixed by `ceremony-core.js mixEntropy`, never written, passed to
    snarkjs in memory, not on a command line) or in the **browser page `ceremony.html` in the hub** (entropy from
    `crypto.getRandomValues` + typed text + key and pointer timings; the person opens the transcript and the latest key
    as files and downloads the new key + the updated transcript). The page's own CSP has `connect-src 'none'`, so it
    cannot send anything anywhere; it is the only hub page allowed `'wasm-unsafe-eval'` and blob workers (snarkjs needs
    both), via a separate rule in `vercel.json`. snarkjs is vendored from the same pinned npm package
    (`vendor/snarkjs.json` holds its version, tarball integrity and sha256; a test compares them).
  - **Transcript** `ceremony/transcript.json` (format `zetaphy-zk-ceremony/1`, `zetaphy-hub/ceremony-core.js`, shared by
    the page and the CLI): circuit hash, model hash, r1cs sha256, the pinned phase 1, the snarkjs version, the initial key,
    then one entry per step with name, GitHub login, snarkjs' contribution hash (blake2b), the new key's sha256 and size,
    its release URL and `link_k = sha256(tag, link_{k-1}, k, type, name, github, contributionHash, zkeySha256[, beacon])`,
    starting from `link_0 = sha256(tag, circuit hash, phase-1 sha256, initial-key sha256)`. Every entry commits to the
    whole history before it: no step can be dropped, reordered, renamed or swapped.
  - **Verifier** (`ceremony.js verify`): the hash chain; the key's sha256; the initial key rebuilt; then
    `snarkjs zkey verify` against the circuit (rebuilt from the committed model) and the pinned phase 1, which checks
    every contribution's proof of knowledge, recomputes the beacon and checks the key's sections; finally the key's own
    list of contributions (hashes, names, the beacon) must equal the transcript's, one by one.
  - **Random beacon**: once enough people contributed (`minContributions`, 3 in the committed transcript), the owner names
    a future block in a PR (`declare-beacon --chain ethereum --block N`; the check refuses a block fewer than 300 blocks,
    ~1 h, ahead, or a declaration not from the owner). After block N is mined, anyone runs `finalize`: its hash, iterated
    2^10 times, is applied as the last step (`snarkjs zkey beacon`). The check asks public RPCs for block N (all that
    answer must agree), and refuses it unless the block's time is after the commit that merged the declaration. A
    ZETAPHY block can be named instead, but ZETAPHY's validators are run by the project, so an Ethereum block is the honest
    choice.
  - **Coordination = GitHub**: each contribution is a PR that changes only `transcript.json` (one appended entry); the key
    is a release asset in the contributor's fork. `.github/workflows/neuro-zk-ceremony.yml` (free Actions, no secrets)
    takes the tools from the target branch (the PR's code is never run), downloads the key from the entry's URL (size
    capped), and refuses the PR unless the entry names the PR author, nothing else changed, and the full verification passes.
    After a merge it verifies everything again and mirrors the keys to this repository's `zk-ceremony` release.
  - **One honest contributor is enough.** If any single participant really destroyed their random value, nobody, not even
    every other participant and the coordinator together, can forge a proof. A contributor who does not trust the
    others only has to contribute themselves. The beacon only stops the last contributor from choosing the final key.
- **Export**: `ceremony.js export` refuses a key that is not final (no beacon) and writes `NeuroScoreVerifier.sol` from the
  final key (`--check` compares it with the committed one; CI does this once the ceremony is final).

The verifier contract now binds the model: `MODEL_HASH` (= H), `ZKEY_SHA256` and `CEREMONY_LINK` (where its key came from),
and `verifyModelProof(a, b, c, commitment, margin)`, which supplies H's two halves itself so a caller cannot pass other
hash constants. `verifyProof` (the snarkjs entry point) is still there.

### Measured here

`node run.js --rows 5 --install` (rehearsal: 2 contributions + beacon on one machine), Node 22, 4 cores of an Intel Xeon
2.8 GHz **shared with other jobs (load average 18-31 during the run)**, so these are upper bounds; an earlier run of the
single-party pipeline on a quieter machine proved a row in 1.0-1.5 s.

| step | result |
|---|---|
| compile circuit | 19.6 s (~9 s when the machine was quiet) |
| phase 1 | downloaded once (36 MB), no local powers of tau any more (the old single-party one took 495 s) |
| initial key (`groth16 setup`, deterministic) | 23 s, 11,338,460 bytes |
| one contribution, CLI (Node) | 39-46 s; each adds ~400 bytes to the key |
| one contribution, **browser** (`ceremony.html`, Chromium, 4 workers, the real 11.3 MB key) | 64 s |
| beacon (2^10 iterations) | 37 s |
| full verification (rebuild init + `zkey verify` + chain) | 75-107 s per key |
| prove one row with the final key (witness + proof, Node) | 6.2-9.1 s here under load (1.0-1.5 s quiet) |
| verify in JS | 0.03-0.28 s |
| proof size | 256 bytes on-chain (2 G1 + 1 G2), 723 bytes as snarkjs JSON; 4 public signals |
| on-chain `verifyProof` | 208,992 execution gas, 235,480 as a transaction |
| on-chain `verifyModelProof` (binding included) | 210,874 execution gas |

Tests: `zetaphy-neuro/ml/onchain/zk/test/ceremony.test.js` (tiny circuit, seconds: full flow; edited / reordered /
dropped entries break the chain; a key that skips a step, a key from another phase 1, a wrong file, someone else's entry,
an edited history, a beacon named by a non-owner or too late, a wrong block hash, a block mined before the declaration,
disagreeing RPCs: all refused); `zetaphy-hub/test/ceremony.e2e.mjs` (the page under its CSP contributes to a tiny key,
refuses a wrong key, the result passes snarkjs' full verification, no request leaves the origin, 8 languages, phone
width); `zetaphy-network/test/neuroscore-zk.test.js` (accepts the proof from the final key, `verifyModelProof` binds H,
refuses tampered signals and **refuses proofs of the same statement made with the non-final key (before the beacon) and
with a forged key** (an independent setup of the same circuit), each valid under its own key).

### Limits, honestly

- **The public ceremony has not happened yet.** The transcript is initialised (0 contributions); nobody has contributed.
  The committed `NeuroScoreVerifier.sol` comes from a **rehearsal on one machine** (its header says so; the on-chain test
  checks the label), so it is still testnet-only: whoever ran the rehearsal could forge proofs. It becomes
  production-grade only after step 6 of section 6, and then only if at least one contributor was honest.
- Phase 1's pin is a hash of what PSE serves today, not a hash PSE published; the full `powersoftau verify` of the file was
  not completed here (on-demand workflow job).
- **Circuit size vs model size**: about 34 constraints per distinct (feature, threshold) pair, one per internal node, plus
  ~5k fixed (32-bit range checks of the 133 features, Poseidon). This model (160 trees, depth <= 4, 3,072 nodes) is 21.7k constraints; phase-1
  power 15 holds 32,768, so roughly 50% more trees or comparisons fit before a bigger file (power 16 = 72 MB, power 17 =
  144 MB, proving time and key size roughly double each step) and a new ceremony. Deeper trees grow the path products
  linearly in nodes. A neural network or thousands of trees would need power 20+ and minutes per proof; not attempted.
- Every new model is a new circuit, so a new phase-2 ceremony and a new verifier (phase 1 is reused). Making the model a
  private witness with a commitment would avoid that at a much larger circuit; not attempted.
- **Same trust gap as NeuroScore**: the proof shows the model was applied correctly to a committed vector, not that the
  vector is the token's real features.
- Not wired into `NeuroScore` or the router yet: `verifyModelProof` is the hook a scorer contract would call.
- Browser **proving** was not measured (only browser contributing).

## 6. Running the ceremony with N participants (owner's procedure)

1. `cd zetaphy-neuro/ml/onchain/zk && npm ci && node ceremony/ceremony.js status` (the transcript is initialised and
   committed). Run the `Neuro zkML ceremony` workflow by hand once: it verifies the initial key and puts
   `neuro_score_0000.zkey` on the `zk-ceremony` release.
2. Announce the ceremony with the hub page (`/ceremony.html`) and the CLI command; set the order (one PR at a time:
   each contribution builds on the previous key, so a second PR on the same base is refused and rebased by its author).
3. Each participant: download the latest key from the `zk-ceremony` release (or the last entry's URL), contribute (page or
   CLI), upload the new key as a release asset in their fork, open the PR with the new transcript. The check must be green
   before merging; merge in order.
4. When at least `minContributions` (set N there before starting if you want more) are merged, name an Ethereum block at
   least a few hours ahead in a PR (`declare-beacon`), and merge it before that block.
5. After the block: `node ceremony/ceremony.js finalize` (fetches the hash), upload the final key to the `zk-ceremony`
   release, open the PR; the check verifies the beacon and the whole chain.
6. `node ceremony/ceremony.js export --install`, `cd ../../../../zetaphy-network && npm run build && npm test`, and
   `node run.js --final --install` for a fixture proved with the final key; commit. From then on the `Neuro zkML`
   workflow proves with the final key and checks that the committed verifier is exactly the exported one.
7. A new model (new H) is a new circuit: a new phase 2 (phase 1 is reused), `init --force` on a fresh transcript.

## Files

- `zetaphy-neuro/ml/onchain/fixed.js`, `export.js`, `model.fixed.json`, `heldout.json`, `ml/test/onchain.test.js`
- `zetaphy-neuro/ml/onchain/zk/gen-circuit.js`, `lib.js`, `run.js`, `package.json` (+ lock), `ceremony/ceremony.js`,
  `ceremony/phase1.json`, `ceremony/transcript.json`, `test/ceremony.test.js`, `test/tiny.js`
- `zetaphy-hub/ceremony.html`, `ceremony.js`, `ceremony-core.js` (transcript format, shared with the CLI), `ceremony-i18n.js`,
  `ceremony.css`, `vendor/snarkjs.min.js` + `vendor/snarkjs.json` (pin), `tools/vendor-snarkjs.mjs`, `vercel.json` (its CSP),
  `test/ceremony.test.mjs`, `test/ceremony.e2e.mjs`, `test/fixtures/ceremony/`
- `zetaphy-network/contracts/NeuroScore.sol`, `NeuroScoreVerifier.sol` (generated), `test/neuroscore.test.js`,
  `test/neuroscore-zk.test.js`, `test/fixtures/neuroscore-zk.json`
- `zetaphy-dex/contracts/ZetaphyFactory.sol`, `ZetaphyRouter.sol`, `contracts/test/DexTestHelpers.sol` (`GasHogScorer`),
  `cli.js` (`set-neuro-score`), `web/i18n.js`, `test/neuroscore.test.js`
- `.github/workflows/neuro-ml.yml` (exports with each candidate), `.github/workflows/neuro-zk.yml`, `.github/workflows/neuro-zk-ceremony.yml`
