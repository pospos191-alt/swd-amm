**English** | [ภาษาไทย](proven-verdicts.th.md)

# Proven verdicts: "AI that proves every answer" (testnet)

Every Neuro risk verdict that goes on-chain through `ProvenVerdicts` carries a **zero-knowledge proof** (Groth16) that
the **pinned on-chain model** computed its score, and **the features the score is about can be re-derived by anyone
from the token's code**. A runner cannot post a score the model did not give, cannot prove a score for invented
features without losing its bond, and nobody has to trust the runner, the operator or the website to check it: the
check runs in the reader's own browser.

Built on what exists (nothing of it was changed): the on-chain model and its circuit (`docs/future/onchain-ml.md`),
the committed verifier `NeuroScoreVerifier.sol`, `NeuroScore`, `NeuroJobs`. Testnet only.

| item | status |
|---|---|
| runner job: features from the code (`zfeat/1`), proof with the existing circuit, local check, batch posting (`zetaphy-network/src/zkverdict/`) | **done**; proves in 1.3-2.0 s per verdict here |
| `ProvenVerdicts.sol`: proof checked by the model-bound verifier, score computed from the proven margin, proof mode (Optional / Required), bonds and slashing, batch | **done**, tested on the in-memory EVM with the real `NeuroScore`, verifier and `NeuroJobs` |
| features binding: on-chain score challenge (re-run the model) + feature contest settled by a NeuroJobs k-of-n job | **done** |
| browser verification in the hub (Immunity card) and the explorer (contract pages), 8 languages, pure JS (no WebAssembly, CSP unchanged) | **done**; ~70-130 ms per proof |
| production use | **not yet**: the verifier comes from a one-machine ceremony rehearsal (section 6), and the rehearsal key is not published, so today only the committed fixture proof verifies on-chain |

## 1. What is proven, and what is not

**The two models.** The proven model is the **on-chain model `nml-b4c35477f7b1`** (`zetaphy-neuro/ml/onchain/model.json`,
133 features, hash H `0x7c420111…a4132`), the one the zk circuit hard-wires and its ceremony is for. The **browser AI**
(`zetaphy-neuro/ai/browser`, model `nml-3ab3cd303911`, 158 features) is a **different model and is not proven**; the
pages say so next to every proven verdict. A token can get different levels from the two.

**The statement of a proof** (the existing circuit, unchanged): "a feature vector committed to as `commitment`
(Poseidon, with a random salt) yields margin Z under the model with hash H". The verifier supplies H itself
(`verifyModelProof`), so a proof for another model, another circuit or another key does not verify.

**What a proven verdict adds on top, and how each part is enforced:**

| claim | enforced by |
|---|---|
| the score is the model's on *some* vector | the Groth16 proof (checked on-chain at submission, and again in the browser) |
| the stored score is the proven one | the contract computes it from the proven margin: `score = trunc(calibA * Z / scale) + calibB`, the pinned model's calibration (read from the model bytes at deployment); the runner never states a score for a proven verdict |
| the proven vector is the **posted** features | `challengeScore(id, features)`: anyone re-runs the pinned model on the posted features on-chain (`NeuroScore.evaluateAt`); another score overturns the verdict and slashes the runner. The browser does the same check (it reads the model bytes from `NeuroScore`, checks their keccak is H, runs them on the posted features and compares the margin) |
| the posted features are **the token's** | they must be `zfeat/1` of the token's runtime code (section 2), whose keccak (EXTCODEHASH) is recorded when the verdict lands. Anyone recomputes them; a disagreement is settled by a NeuroJobs k-of-n job (section 2) and slashes the runner |

Why the margin check and not the commitment: the commitment is a Poseidon hash with 20 inputs (BN254 Poseidon of width 17
then 6), which the EVM cannot recompute at a reasonable cost and which the circuit cannot be changed to expose. Comparing
margins is exact for what matters: if the posted features give the proven margin, the posted score is the model's
score on the posted features, whatever vector the proof committed to. If they give another margin, the proof was for
other features, and the challenge wins with certainty (a deterministic on-chain computation, no trust in anything but
the model bytes).

**What it does not prove.** That a token is harmless or harmful: a score is a statistical estimate from synthetic
training data. That `zfeat/1` captures everything Neuro looks at: it is code only (section 2). And, until the public
ceremony is final, that the verifier's key is honest (section 6).

**Honest note on value.** For this small public model the strongest check is to re-run it (126k gas on-chain, under a
millisecond in JS), and both the contract and the pages do that too. The proof is what makes the runner's answer an
attested, slashable statement about a pinned model, checkable without re-running anything on-chain, and it is the only
check left once features are kept private or a model is too big for the EVM. The pipeline is built so that switching to
such a model is a new circuit + ceremony + verifier + `ProvenVerdicts` deployment, with the same runner job and pages.

## 2. Features anyone can re-derive: profile `zfeat/1`

`zetaphy-network/src/zkverdict/features.js`. The on-chain model's 133 features, computed **only from the runtime
bytecode**:

- selectors and opcodes: `zetaphy-neuro/src/bytecode.js scanBytecode` (the reader's own scan); an EIP-1167 clone is
  recognised from its bytes;
- the rules: `zetaphy-neuro/src/analyze.js analyze()` fed nothing but that scan: no RPC reads (no name, symbol, owner, proxy
  storage slots), no known-token list, no similarity dataset, no ThreatRegistry;
- the ML extractor `zetaphy-neuro/ml/features.js extractFeatures({ report, code })`: no trade simulation (`m_*` = 0) and
  no market facts (every `k_*_known` = 0); quantized exactly as `NeuroScore` takes them (scale 1e7, u32 big-endian).

So the vector is a pure function of the code. Anyone with the code (any RPC: `eth_getCode`, checked against the recorded
code hash) gets the same 532 bytes. The proven score is therefore "the pinned model on the code-only features" and can
differ from the score the Neuro site shows for the same token (which adds the simulation, holders and RPC facts).
A proxy's own code is used, not its implementation's (the implementation can change; the recorded code hash cannot).

**Contesting the features** (`contest` / `resolveContest` / `expireContest`):

1. Inside the challenge window, anyone posts `contestBond` against verdict `id` ("these are not the token's features").
   The runner's bond is held while it is open.
2. Anyone requests a NeuroJobs job on chain `"zetaphy"` with target `featureTarget(id)` =
   `zfeat/1:<token>:<code hash>`. NeuroJobs runners (`src/worker.js`) recognise the target, read the code, refuse it
   if its hash is not the target's, and commit / reveal **keccak256 of its zfeat/1 features** like any verdict:
   commit-reveal, 2-of-3 seats, its own challenge rounds.
3. Once that job is settled (`NeuroJobs.assurance`), anyone calls `resolveContest(id, jobId)`. A result different from the
   posted features' hash overturns the verdict and slashes the runner (the challenger gets its bond back plus half of the
   slash); the same hash upholds it (the contest bond goes to the runner).
4. With no settled job after `contestTimeout`, `expireContest`: the verdict stands, 80% of the bond goes back.

## 3. The flow

1. **Runner** (`zetaphy-network/src/zkverdict/job.js`): for each token, `eth_getCode` → `zfeat1(code)` → prove with the
   existing circuit (`prover.js`, `snarkjs.groth16.fullProve` on `zetaphy-neuro/ml/onchain/zk/out/neuro_score_js/` and the
   ceremony's final zkey) → check the proof locally against the committed verifier's key (pure JS) and that its margin is
   the model's on these features → post through `submit` or `submitBatch`. A proof that would not verify on-chain, or that
   is for other features, is never sent.
2. **`ProvenVerdicts.submit(Proof)`**: the runner is bonded; `modelId` must be the pinned one (`WrongModel`); 133 x 4 bytes of
   features; `verifier.verifyModelProof(a, b, c, commitment, margin)` must hold (`InvalidProof`); the same proof is
   refused twice for one token (`ProofUsed`); the token must have code. Stored: token, runner, time, score, level,
   proven = true, features hash, code hash, proof hash. Events: `Proven` (the verdict) and `ProofData` (the proof, the
   commitment, the margin and the 532 bytes of features: what a browser re-checks).
3. **Challenges** (section 1 and 2).
4. **Readers**: `verdictOf(token)` → known, score, level, proven, weight, settled, id. The hub (Immunity → Neuro-checked
   certificate) and the explorer (contract and token pages) re-check the proof in the browser and show
   "Proven by model nml-b4c35477f7b1 …" with the time it took, the testnet caveat and the note that the browser AI is
   another model.

**Proof mode** (`setProofMode`, governance = the timelock):

| mode | unproven `claim(token, features, score)` | how it reads |
|---|---|---|
| Optional (default) | accepted, weight 1 (`CLAIM_WEIGHT`); `challengeScore` slashes a claim whose score is not the model's | proven verdicts weight 3 (`PROVEN_WEIGHT`); a claim never hides a live proven verdict for the same code |
| Required | refused (`ProofRequired`) | earlier claims read as unknown (weight 0) |

A verifier for another model is refused at construction (`ModelMismatch`): `ProvenVerdicts` reads the model of the given
`NeuroScore` version and requires `verifier.MODEL_HASH()` to be its hash and the stored bytes to hash to it. A new model is
a new circuit, a new ceremony, a new verifier and a new `ProvenVerdicts`, deliberately: the verifier is immutable.

**Bonds and slashing.** `register()` with `runnerBond`; an overturned verdict costs half of the runner's bond (half to the
challenger, half burned) and deactivates it below the bond. The bond stays until every verdict it posted is out of its
challenge window and no contest is open (`withdrawBond` after `unbondDelay`).

## 4. Costs and batching

Measured on the in-memory EVM (Cancun rules) by `test/provenverdicts.test.js`:

| call | gas |
|---|---|
| `NeuroScoreVerifier.verifyModelProof` (from `onchain-ml.md`) | 210,874 execution |
| `ProvenVerdicts.submit` (proof + 532 bytes of features + record + events) | 418,570 execution, **~450k as a transaction** |
| `submitBatch` of 2 / 4 / 8 | 408.7k / 402.3k / **399.1k per verdict** |
| `challengeScore` (re-run the 160 trees + overturn + slash) | ~176k execution, ~202k as a transaction |
| `NeuroScore.postFeatures` (re-running the model instead of a proof, for comparison) | ~205k as a transaction |

Where the 450k goes: ~211k pairing check, ~110k for the record (5 storage words) plus the token pointer and the replay
guard, ~32k calldata (proof 256 bytes + features 532 bytes), ~10k for the 600-byte `ProofData` log. **Batching saves only
the per-transaction overhead (~11%)**: each proof still needs its own pairing check, which dominates. Real savings need
**proof aggregation** (SnarkPack-style aggregation of Groth16 proofs, or a recursive proof of N verifications): one
pairing check for N verdicts, log-size proofs; not implemented (it needs another circuit or a new library, and for the
recursive variant another ceremony). Cheaper today: post the 532 bytes once per code hash (identical code, identical
features) and let `submitBatch` reuse them; not done.

## 5. Measured (this machine)

Node 22, 4 cores of an Intel Xeon 2.8 GHz (load average ~1 during the run):

| what | result |
|---|---|
| prove one verdict, Node (`scripts/zkverdict-bench.js`: witness + Groth16, zfeat/1 of three of this repo's contracts) | **1.27-1.95 s** (mean 1.52 s) |
| verify, snarkjs (WebAssembly), Node | 25-29 ms |
| verify, pure JS (`zkverdict-core.js` + `@noble/curves` bn254), Node | 68-86 ms |
| verify in the browser: hub page in Chromium under the site's CSP (`test/zkverdict.e2e.mjs`) | **101-132 ms** over two runs (plus ~1 ms to re-run the model on the posted features) |
| vendored verifier bundle (`vendor/zkverify.js`) | 61.7 KB, pure JS |

The benchmark proves with the deterministic **initial** key of the ceremony (`out/ceremony/neuro_score_0000.zkey`): the
time is the same with any key of this circuit, but those proofs verify only under that key (`onChain: false`).

## 6. Trust: the ceremony

Groth16 needs a trusted setup. **Phase 1** is the public Perpetual Powers of Tau (80+ contributors). **Phase 2** (this
circuit) is a multi-party ceremony that is ready but **has not been run publicly**: the committed verifier comes from a
**rehearsal on one machine** (`onchain-ml.md`, section 6). Consequences, stated on every page that shows a proven verdict:

- whoever ran the rehearsal could forge proofs: **testnet only**;
- the rehearsal's final key was not published, so today runners cannot produce proofs the committed verifier accepts:
  the runner job refuses to post them (`onChain: false`), and the on-chain tests use the committed fixture proof (made
  with that key) plus a stand-in verifier for the plumbing;
- production = run the public ceremony (owner's procedure in `onchain-ml.md`, section 6). If at least one contributor
  destroys their randomness, nobody can forge. Then: export the verifier from the final key, regenerate
  `zetaphy-hub/zkverdict-vkey.json` (`node tools/zkverdict-vkey.mjs`; a test refuses a stale one), deploy `ProvenVerdicts`
  against it, publish the final key with the ceremony (runners need it to prove).

The ceremony transcript, the circuit, the generator, `ml/onchain/model.json` / `model.fixed.json` and
`NeuroScoreVerifier.sol` were not modified by this work.

## 7. Post-quantum: Groth16 is not, a STARK path is

Groth16 on BN254 rests on pairings and discrete logarithms: a large quantum computer running Shor's algorithm breaks it
(forged proofs). BN254 also gives ~100 bits of classical security, not 128. The STARK path:

- **STARKs** (FRI, hash-based: only collision-resistant hashes) are plausibly post-quantum and need **no trusted setup**,
  so no ceremony at all. Free, open-source provers exist (e.g. Stwo / Circle STARKs, Plonky3, RISC Zero, SP1 as zkVMs).
- The model is small (160 trees of depth <= 4, 3,072 nodes): an AIR or a zkVM program that walks the packed bytes is a
  few hundred thousand steps; proving in seconds on a laptop is plausible.
- **The catch is on-chain verification**: a STARK proof is ~100-500 KB and a direct EVM verifier costs millions of gas.
  The usual trick, wrapping the STARK in a Groth16 proof, brings back both the trusted setup and the quantum weakness.
  A post-quantum path keeps the STARK end to end: verify it **off-chain everywhere** (browser, wallets, runners: hash-based
  verification is fast in JS / WASM) and on-chain only via an optimistic scheme (post the proof's hash, anyone can
  challenge with the full verification in a dispute), or a chain precompile for a STARK verifier.
- The features commitment would become a hash-based commitment (e.g. Poseidon2 / BLAKE3 inside the STARK) and the binding
  stays the margin check of section 1.
- Not built here. ZETAPHY's accounts already have a post-quantum signature path (ML-DSA); proofs would be next.

## 8. Limits

- The rehearsal setup (section 6): forgeable by its operator, and no postable proofs until the public ceremony.
- `zfeat/1` is code only: weaker than Neuro's full report; a proxy's implementation is not followed. Feature extraction
  uses JavaScript floating point (`Math.log1p`, then rounding to 1e-7): engines that differ in the last bit of `log1p`
  could disagree on a feature exactly at a rounding boundary; NeuroJobs' 2-of-3 absorbs a single outlier.
- A NeuroJobs feature job takes its commit window, reveals and its own challenge window: `contestTimeout` must be longer
  (deployment parameter); the contest bond must make spam cost more than the job fee.
- The browser reads the `ProofData` log with `eth_getLogs` from block 0; RPCs that cap log ranges need a narrower query
  (the verdict's block is not stored).
- One model per deployment, by design. No aggregation (section 4). No proof of the browser model.
- Nothing here is wired into the DEX router or `ThreatRegistry` yet: they can read `verdictOf` (weight, proven) when
  governance wants a proven-only policy.

## Files and tests

- `zetaphy-network/contracts/ProvenVerdicts.sol`, `src/zkverdict/{features,prover,job}.js`, `src/worker.js` (feature
  jobs), `scripts/zkverdict-bench.js`, `test/provenverdicts.test.js` (valid proven verdict accepted; forged score, other
  keys, replay, wrong model id, wrong verifier, wrong feature count refused; feature mismatch slashed by `challengeScore`;
  wrong features slashed through a real NeuroJobs feature job; a wrong contest loses its bond; expiry; Optional / Required;
  batch with gas; the runner job's refusals), `test/zkverdict.test.js` (zfeat/1 determinism; the runner answers a feature
  job; the browser checker equals the on-chain verifier; end to end from the real contract's logs; the prover with the
  existing circuit, when `ZKVERDICT_ZK_OUT` points at its built artifacts), `test/helpers/ProvenKit.sol`.
- `zetaphy-hub/zkverdict-core.js` (shared verbatim with `zetaphy-explorer/src/`), `zkverdict-vkey.json`
  (`tools/zkverdict-vkey.mjs`), `vendor/zkverify.js` + `vendor/zkverify.json` (`tools/vendor-zkverify.mjs`), `assist.js` /
  `assist-i18n.js` (Immunity card), `test/zkverdict.test.mjs` (pin, key, fixture verify + tampered, model parity,
  decoders, every failure state, 8 languages, copies), `test/zkverdict.e2e.mjs` (Chromium, site CSP, verify time).
- `zetaphy-explorer/src/app.js` (proven-verdict card), `config.js` (`provenVerdicts`), `i18n.js`.
