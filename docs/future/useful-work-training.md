**English** | [ภาษาไทย](useful-work-training.th.md)

# Proof of useful work for AI training: the network's compute trains Neuro

Testnet only. Nothing here holds or pays real money, and the training data in the simulation is **synthetic**
(labelled as such). This page describes what exists in the repository, what it proves, and what it does not.

| Piece | Where | Status |
|---|---|---|
| Bit-reproducible trainer (GBDT, Neuro's tree format), checkpoints, spot-check re-runs, evaluation | `zetaphy-hub/train-core.js` (one file, runs in browsers and Node) | Done, tested (golden hashes; Node = another V8 isolate = Chromium) |
| `TrainingMarket.sol` (rounds, commit-reveal, spot-checks, evaluation quorum, payouts) + `TrainingPool.sol` (staked workers, slashing) | `zetaphy-network/contracts/` | Done as testnet contracts with tests. **Not deployed** |
| Node worker + simulation + CLI | `zetaphy-network/src/trainwork/` (`core.js`, `worker.js`, `simulate.js`, `cli.js`) | Done (in-memory chain) |
| Browser practice job | Hub → Mine → 🧠 Useful work → **Training work** (`train-worker.js`, 8 languages) | Practice only: nothing sent, nothing paid |
| Label work (a) through `UsefulWork` | `src/trainwork/core.js` `labelRow` | Done (the existing scan-job contract, no change) |

## Why this is "useful" work

Proof of work burns energy on hashes nobody needs. Here the network's spare compute does the three jobs that
make Neuro (the scam-detection model, `zetaphy-neuro/ml`) better, and a contributor is paid only when the
work is **verified** and the result is **measurably useful**:

1. **(a) Label work** — turn contracts into training rows: a worker reads a contract's bytecode, extracts
   Neuro's features (`zetaphy-neuro/ml/features.js`) and the rules' weak label. The row's keccak is the
   verdict of an ordinary `UsefulWork` scan job: 3 seats, paid only when 2 agree, commit-reveal so nobody can
   copy (unchanged contract; `labelRow`).
2. **(b) Training work** — a worker trains a boosting step (a few decision trees) on its assigned data shard,
   from a fixed seed. Because training is bit-reproducible, other workers can re-run any piece of it and must
   get the same bytes.
3. **(c) Evaluation work** — workers measure the candidate model (the current model + the verified training
   steps) on held-out rows that **nobody could know in advance**. This is the definition of "useful": a round
   pays its trainers **only if** the held-out AUC rises by at least `minGainAuc` (0.005) and recall at 1% FPR
   does not fall.

Verification is paid whatever the outcome (verifiers and evaluators have no reason to prefer acceptance);
training is paid only on acceptance.

## Bit-reproducible training in JavaScript

`train-core.js` grows gradient-boosted trees (logistic loss, Neuro's `neuro-ml-gbdt/1` format, so the trees
run unchanged in `zetaphy-neuro/ml/model.js`). Two honest workers must produce **identical bytes** on any
JS engine. JavaScript numbers are IEEE-754 doubles and `+ - * /` are correctly rounded everywhere (and the
language never fuses `a*b+c`), but `Math.exp/log/pow` are only "implementation-approximated". So:

- **no engine-defined math**: `dexp` is our own range reduction (`x = k·ln2 + r`, fdlibm's split ln2) and a
  degree-16 polynomial, then exact multiplications by 2 — within 2.2e-16 of `Math.exp`, and the same bits
  everywhere. A test fails if `Math.exp/log/pow/random/sqrt/…`, `**`, `toPrecision` appear in the file;
- **one summation order**: rows by index, bins by index, trees by index; margins are updated tree by tree;
- **integer randomness**: xoshiro128** seeded per tree from `(seed, shard, tree)`; row/column sampling
  compares 32-bit integers;
- **snapped values**: leaf values are rounded to a 2^-24 grid; split ties go to the lowest feature, then bin.

The proof is in the tests: `zetaphy-network/test/trainwork.test.js` pins golden hashes (base model, shard rows,
checkpoint root, trees) and recomputes the root in a fresh V8 isolate (a worker thread); the hub's browser test
(`zetaphy-hub/test/work.e2e.mjs`) runs the practice job in **Chromium's** Web Worker and checks that its
checkpoint root equals Node's, bit for bit.

## Checkpoints and spot-checks ("proof of learning" style)

A job of `T` trees is cut into `C = T / every` segments (default 24 trees, 8 segments of 3). For each segment
the trainer hashes the trees it grew **and a transcript of how**: every split's gain and gradient sums
`(G, H)`, every leaf's `(G, H)`:

```
d_s  = keccak("zetaphy-train/1 segment" ‖ s ‖ trees_s ‖ transcript_s)
root = keccak(d_1 ‖ … ‖ d_C)
```

It commits `keccak(root, treesHash, worker, salt, task)`, reveals `root` and `treesHash` later, and publishes its
trees (content-addressed by `treesHash`). Then a **future block hash** draws `checksPerJob` segments of every
job (and `verifiersPerCheck` verifiers per segment, never the trainer). A verifier takes the published trees
**before** segment `s`, re-trains segment `s` and seals its own `d_s` (commit, then reveal). Only after the
verifiers are sealed does the trainer open `d_1..d_C` (checked against `root`). The majority answer decides:

- majority = trainer's `d_s` → the check passes;
- majority ≠ (a faked segment, a made-up transcript, trees that are not published or do not hash to
  `treesHash` → `UNAVAILABLE`) → the job **fails** and the trainer loses `trainSlash` (half of it goes to the
  verifiers who caught it, `catchBps`);
- verifiers in the minority or silent lose `missSlash`.

Why the transcript: the trees alone are public once published, so a lazy verifier could hash them instead of
re-training ("verifier's dilemma"). The transcript (gains, gradient sums) is never published before the
verifiers commit; producing it **is** re-running the segment.

### How likely is a cheater caught?

With `s` distinct segments sampled out of `C`, a job with `f` faked segments escapes with probability
`C(C-f, s) / C(C, s)`. Computed, and (in brackets) measured with the contract's own sampler over 1,000 random
draws (`node src/trainwork/cli.js table`):

| segments | faked | 1 check | 2 checks | 3 checks | 4 checks |
|---|---|---|---|---|---|
| 8 | 1 | 12.5% (11.9%) | 25.0% (26.2%) | 37.5% (38.3%) | 50.0% (50.9%) |
| 8 | 2 | 25.0% (25.2%) | 46.4% (45.9%) | 64.3% (65.1%) | 78.6% (78.6%) |
| 8 | 4 | 50.0% (51.6%) | 78.6% (79.6%) | 92.9% (92.0%) | 98.6% (99.3%) |
| 8 | 6 | 75.0% (77.0%) | 96.4% (96.1%) | 100.0% (100.0%) | 100.0% (100.0%) |
| 16 | 1 | 6.3% (5.4%) | 12.5% (12.2%) | 18.8% (18.5%) | 25.0% (25.0%) |
| 16 | 4 | 25.0% (21.6%) | 45.0% (43.8%) | 60.7% (59.6%) | 72.8% (71.1%) |
| 16 | 8 | 50.0% (50.9%) | 76.7% (77.2%) | 90.0% (90.9%) | 96.2% (96.5%) |
| 16 | 12 | 75.0% (76.0%) | 95.0% (94.4%) | 99.3% (99.7%) | 99.9% (99.9%) |
| 32 | 1 | 3.1% (2.4%) | 6.3% (6.2%) | 9.4% (11.1%) | 12.5% (10.7%) |
| 32 | 8 | 25.0% (24.1%) | 44.4% (46.6%) | 59.2% (61.0%) | 70.5% (71.9%) |
| 32 | 16 | 50.0% (48.9%) | 75.8% (75.4%) | 88.7% (88.2%) | 94.9% (93.6%) |
| 32 | 24 | 75.0% (74.9%) | 94.4% (93.9%) | 98.9% (97.5%) | 99.8% (99.8%) |

The economics, not the probability alone, is what deters. Faking a fraction `φ` of the work saves `φ·cost`;
with probability `P` the cheater loses its pay and `trainSlash`. Honest work is the better bet when
`φ·cost < P·(pay + trainSlash)`. A cheater who fakes little saves little and is rarely caught; one who fakes
a lot is almost surely caught. Faking 1 segment of 32 is cheap to hide, but it is also nearly worthless to
the cheater (and it still has to pass the held-out evaluation together with the honest jobs). Reputation
(`WorkerReputation`) adds a cost that lasts beyond one round.

## The contracts

**`TrainingPool`** — workers stake (`join`, at least `minStake`). A market named by governance can lock a
member while it holds a seat or an assignment and slash it (the coins go to that market's reserve). `exit`
leaves the draw at once; the stake comes back after `exitDelay` (longer than a whole round, checked by the
market), so a cheater cannot leave before it is judged.

**`TrainingMarket`** — one task = one round:

| Phase | Who | What |
|---|---|---|
| post | poster (a feeder for a subsidised round) | budget (escrow), `specHash` (data shards, base model, seed, hyper-parameters), base model = the version in force in `ModelEpochs`, `heldoutCommit = keccak(secret, poster)` |
| seats → commit → reveal | pool members | seat j trains shard j; seal `keccak(root, treesHash, worker, salt, task)`; reveal |
| requestDraw → draw | anyone | the hash of a block fixed **before** it exists picks segments, verifiers (never the trainer), evaluators (never a trainer with a revealed result). An unrevealed seat loses `missSlash` |
| verify | verifiers, trainers, poster | sealed digests; trainers open `d_1..d_C`; verifiers reveal; poster reveals its secret |
| judge | anyone | majority per check; failed jobs slashed; verifiers paid (`checkBps` of the budget); candidate id = `keccak(baseModel ‖ treesHash of each passed job)`; held-out seed = `keccak(secret, randomness)` |
| eval → finalize | evaluators | sealed `keccak(baseAuc, candAuc, baseRecall, candRecall)`; majority; evaluators paid (`evalBps`); **accepted** iff `candAuc ≥ baseAuc + minGainAuc` and `candRecall ≥ baseRecall`; then trainers of passed jobs share `trainBps` + the subsidy |

Accepted candidates are recorded (`acceptedBy`), and the **new model version is scheduled by governance**:
a timelock vote calls `ModelEpochs.schedule(candidate, activation, uri)` (the simulation does exactly this).
The market itself never changes the model in force, and a new round must start from the version in force
(`StaleBase` otherwise).

**No admin key.** Both contracts require governance to be a timelock with at least 2 days' delay
(`NotTimelock` for an EOA), and the market starts paused until a vote opens it. There is no withdraw of others'
money: payouts are pull (`withdraw`). The test checks the books after every scenario:
`balance(market) = owed + reserve + escrow`, `balance(pool) = totalStake`.

**Issuance.** A feeder's round may carry a `subsidy` (≤ `maxSubsidy`) for the trainers of an accepted round,
taken first from the market's reserve (slashed stakes) and then from **`UsefulIssuance`** (a capped bucket of
RewardVault rewards, pull-only, timelocked; see [useful-work.md](useful-work.md) item 34). It mints nothing.
Training a scam detector is security work, which is what that issuance share is for; it is paid only after
the held-out gain is accepted.

## End-to-end simulation (in-memory chain, real contracts)

`node zetaphy-network/src/trainwork/cli.js simulate` (and the test) runs six pool workers: w1–w4 honest, **w5
a cheater** (trains 2 of its 8 segments and makes up the other 6 to save compute), **w6 a lazy copier**
(copies other workers' sealed commitments and tries to replay their reveals). Rounds: 4 shards × 8 segments
× 3 trees; 2 checks per job, 3 verifiers per check, 3 evaluators; budget 30, subsidy 3, `trainSlash` 5,
`missSlash` 1, stake 20 (test ZETAPHY).

- **Label work**: 1 contract (VulnerableVault's code) → a 76-feature row, accepted 2 of 3; w1, w2 paid 0.6
  each; the copier's reveal refused (`BadReveal`: the commitment binds the worker's address), deposit lost.
- **Training**: jobs w1 passed, w2 passed, **w5 failed** (its segment 7 was drawn: verifiers' digest ≠ its
  claim; its other drawn segment, 0, was one it really trained and passed — the check is probabilistic),
  **w6 missed** (its copied commitment cannot be revealed).
- **Evaluation** on 1,029 held-out rows: **AUC 0.7342 → 0.8466 (+0.1124)**, recall at 1% FPR 0.1625 →
  0.2244: accepted; a timelock vote then made the candidate the version in force in `ModelEpochs`.
- **Compute verified**: 24 segments claimed, 18 actually trained; 6 segments sampled = **25% of the claimed
  training re-executed** (14 segment re-runs = 58% extra compute: the price of verification here).

| worker | behaviour | earned | stake lost | net | trained / re-ran / evaluated |
|---|---|---|---|---|---|
| w1 | honest | 11.786 | 0 | **+11.786** | 8 / 3 / 0 |
| w2 | honest | 12.607 | 0 | **+12.607** | 8 / 2 / 0 |
| w3 | honest | 4.893 | 0 | **+4.893** | 0 / 5 / 1 |
| w4 | honest | 2.357 | 0 | **+2.357** | 0 / 2 / 1 |
| w5 | cheater | 0.857 | 5 | **−4.143** | 2 / 2 / 0 |
| w6 | copier | 0 | 6 | **−6.000** | 0 / 0 / 0 |

(w5 earned 0.857 for honest spot-checks of others' work; it lost the whole trainSlash. Poster refund 3 = the
10% of the budget that is no pool; the subsidy came from the slash reserve, so UsefulIssuance was not drawn
this time — the test with an honest round and an empty reserve checks that it then comes from UsefulIssuance.)

### Data poisoning, and what the held-out evaluation does about it

Spot-checks prove the **computation** was honest, not that the **data** was. The test feeds a round shards
whose labels are poisoned (the new scam family relabelled "safe", `world: 'v1p'`) while the held-out rows come
from the true world. Every spot-check passes (the training was honest), but the evaluation measures
**AUC 0.7164 → 0.5120**, recall 0.1238 → 0.0766: **rejected**. The trainers get nothing for training, the
verifiers and evaluators are paid, the poster gets the training pool back, and the model in force does not
change. This works because the held-out rows are (1) chosen by a seed nobody knows until after the training
is committed and (2) never part of a training shard (shards are fixed by the spec, and the spot-checks enforce
that a job trained on its own shard only — training on the held-out pool would change the digests).

## Limits (read before trusting it)

- **Spot-checking is probabilistic.** A job that fakes a small part is caught with a small probability (table).
  The defence is economic (slash ≫ saving) plus reputation, not a proof. More checks cost more re-execution.
- **Honest-majority assumption.** Each check is decided by 3 randomly drawn staked members. A party that
  controls most of the pool controls the checks. The draw is per member, not per stake; Sybils pay
  `minStake` each. Stake-weighted draws or reputation-weighted ones are a next step.
- **Randomness.** The draw uses a block hash fixed before it exists; the block proposer can bias it by
  withholding a block. The held-out seed also mixes in the poster's secret, so neither side alone controls it;
  a poster who never reveals it loses the whole refund. A beacon (drand, VRF) would be stronger.
- **Data availability.** Published trees live off-chain (the simulation's store stands in for IPFS / HTTP).
  Withholding them fails the job (tested), but an outage of the store could fail honest jobs too.
- **Data poisoning beyond the aggregate metric.** The held-out gate stops poisoning that lowers AUC/recall.
  A targeted backdoor (a trigger that flips one family while aggregate metrics stay fine) can pass it.
  Mitigations already in the repo: Neuro's red-team evasion set (`ml/redteam`), per-family recall checks in
  `ml/train/train.js`, and `combine.js` never lowering a rules verdict. Label work (a) is k-of-n agreement on
  a *weak* label; ground truth still comes from outcomes and human labels (DataDAO, label registries).
- **Adaptive overfitting of the evaluation pool.** Many rounds against the same pool slowly leak it (the
  "reusable holdout" problem). The pool must be rotated with fresh labelled data.
- **Determinism is only for this trainer.** It works because the model is small CPU code in plain JS.
  GPU deep-learning is not bit-reproducible across hardware without special kernels; that is the hard part
  the projects below work on.
- **Synthetic data** in the simulation and the browser practice job. In production the shards would be corpus
  rows (`rowsHash` of content-addressed files) and the base model `zetaphy-neuro/ml/model.json` (same tree
  format; the test runs candidate trees through `ml/model.js`).
- **Costs.** Verification overhead in the simulation is 58% extra compute; gas grows with jobs × checks ×
  verifiers. `TrainingMarket` is 24,491 bytes, just under the 24,576-byte contract-size limit (EIP-170): further features need another split (the pool already is one).
- **Not deployed**, not audited.

## How it compares

| | What is verified | How | Notes |
|---|---|---|---|
| **This (ZETAPHY)** | that a training step was really computed on the assigned shard, and that the result helps | bit-reproducible JS trainer; sealed segment digests incl. a transcript; random re-execution by staked verifiers; held-out evaluation with a late-revealed seed | small models only (GBDT); honest-majority checks; synthetic data so far |
| **Gensyn** | ML compute on untrusted hardware | its published approach combines reproducible operators across hardware (RepOps) with refereed delegation / dispute games that narrow a disagreement down to one operation (Verde) | aims at deep learning on GPUs; much stronger reproducibility engineering than ours |
| **Bittensor** | that a miner's output is valued by validators | Yuma consensus: validators score miners, stake-weighted, and rewards follow the scores | no re-execution: "useful" is what validators score; known issues with weight copying and gaming subjective scores |
| **Prime Intellect** | decentralised training runs | low-communication training (DiLoCo-style) across contributed GPUs; TOPLOC (locality-sensitive hashes of activations) to verify inference | production-scale training; contributors historically vetted rather than fully trustless |
| **Proof-of-learning research** | that a model results from claimed training | Jia et al. 2021: checkpoints + re-executing random segments, very close to our design; later work (e.g. Fang et al. 2023) showed spoofing attacks against PoL when re-execution tolerates float error | our exact (bit-for-bit) re-execution removes the tolerance those attacks exploit, at the price of restricting the model and arithmetic |

The general idea — commit to checkpoints, re-execute random segments, slash on mismatch — is the
proof-of-learning / Truebit pattern. What this repository adds is making the step **exactly**
reproducible in browsers, sealing a transcript so verification cannot be skipped, and tying payment to a
held-out gain that also defends against poisoning that hurts the metric.

## Try it

```bash
cd zetaphy-network
npm run build                                  # compiles TrainingMarket + TrainingPool
node --test test/trainwork.test.js             # determinism, soundness, contracts, simulation, poisoning
node src/trainwork/cli.js simulate             # the 6-worker round, as a markdown report
node src/trainwork/cli.js table                # the detection-probability table
node src/trainwork/cli.js train spec.json 0 --out trees.json   # train a shard of a spec (JSON from T.makeSpec)
node src/trainwork/cli.js verify spec.json 0 trees.json 3 0x<treesHash>   # what a verifier seals
```

In the hub: **Mine → 🧠 Useful work → Training work → Practice training job** (Web Worker; the checkpoint
root shown is the one Node computes).

## What is missing

- Deployment (a deploy script and a hub on-chain mode like `UsefulWork`'s); the hub's training card is practice only.
- Real corpus shards and `ml/model.json` as the base (the code paths and formats are ready; the simulation uses synthetic rows).
- Stake- or reputation-weighted verifier draws; a randomness beacon; an on-chain dispute game for one tree
  (a single split is cheap enough to referee on-chain) instead of majority voting.
- Training the federated head (`ml/fl/head.js`) as a work unit: the same pattern applies (its update step is a
  few dot products), with the same determinism rules.
