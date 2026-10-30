**English** | [ภาษาไทย](README.th.md)

# Neuro ML: a learned risk score + a red team

Neuro's fixed rules say what a contract's code **can** do. This folder adds two things on top, all free, with no server:

- **Stage 2, a learned model** (`model.json`, 75 KB): gradient-boosted trees that turn what Neuro already computes into a
  calibrated probability that a token is a trap, plus the features that pushed the score up or down.
- **Stage 5, a red team** (`redteam/`): rewrites scam tokens to slip past Neuro, runs them through Neuro + the model,
  and feeds every evasion back into training and into a regression test.

Training runs in GitHub Actions once a week (`.github/workflows/neuro-ml.yml`); it proposes a new model by pull request
only when it beats the current one. Nothing is deployed automatically.

## The rules stay in charge

- The model can **raise** the level Neuro shows, **never lower** it (`combine.js`; tested over every level pair and 600
  random reports).
- An official issuer's contract or a registered template ("good" in the rules) is raised to "low" at most.
- The model is **not part of the network verdict or the reportHash**: `rulesLevel` stays what the rules decided, no
  finding is added, and the score lives in `analysis.ml`. Runners' 2-of-3 agreement (src/verdict.js) is unchanged.
- `ml/` is outside `src/`, so it does not change Neuro's skill id (no governance vote needed to ship or update it).
- Wording: the score is "a statistical estimate", not a finding, and never says "scam" about a project.

## Using it

```js
import { checkModel } from './ml/model.js';
import { withModel } from './ml/combine.js';
const model = checkModel(await (await fetch('/ml/model.json')).json());   // browser; or readFileSync in Node
const out = withModel(model, report, { code, logicCode, market, lang: 'th' });
// out.analysis.level      shown level (>= the rules' level)
// out.analysis.rulesLevel what the rules decided (the verdict uses this)
// out.analysis.ml         { model, p, level, raised, top: [{feature, label, value, effect}] }
```

`node ml/cli.js bsc 0x...` does the same for a real token (read-only public RPC). Inference is plain JS with no
dependencies (`model.js`, `features.js`, `combine.js`), so the web page, a runner and Node all get the same number.

## Features (`features.js`, 158 numbers)

From what Neuro already computes, nothing new is fetched:

| group | examples |
|---|---|
| rules (`r_*`) | rules level, who controls it (owner / renounced / roles / upgradeable / unknown), proxy kind, link in name, look-alike, official issuer, template, similarity %, unknown pattern, DELEGATECALL finding |
| functions (`s_*`) | how many functions, how many unnamed, share of ERC-20, count per kind: mint, blacklist, pause, fee setters, trading switch, limits, upgrade, roles... |
| code (`o_*`, `p_*`, `g3_*`) | code size; SELFDESTRUCT / DELEGATECALL / CREATE2 / CALL present; share of SSTORE, CALLER, ORIGIN, TIMESTAMP, NUMBER, GASPRICE, EXTCODEHASH...; patterns: caller-equals-stored-address checks, hashed or XOR-masked caller checks (hidden owners), tx.origin checks, time/block-number conditions, gas-price conditions, "is it a contract" checks; 32 hashed opcode 3-gram buckets |
| simulation (`m_*`) | buy/sell ran, ok / tax 10-50% / tax > 50% / cannot sell / skipped, buy and sell tax |
| paths (`x_*`, `flow.js`) | per function: owner-only (incl. hashed / XOR / tx.origin owners), moves or creates tokens, bounded by a fixed cap, unnamed; owner sets the fee rate (capped or not); `owner()` constant while owner-only functions remain; what `transfer()` checks: owner exemption, time / block, gas price, tx.origin, contract sender, ETH balance, coinbase, gas left, branches, stored values read, percentage |
| market (`k_*`, optional) | largest holder share, top-10 share, liquidity locked, liquidity, contract age, verified source, holders; each with a `_known` flag (missing = 0 and unknown, never guessed) |

## Model

Gradient-boosted decision trees (logistic loss, 160 trees of depth 4, learning rate 0.15) written from scratch in
`train/gbdt.js`, then Platt-calibrated (with a weak prior around the identity, so a perfectly separated calibration split still gives
finite probabilities) on a separate calibration split. Training is deterministic: sorted thresholds, a
seeded PRNG for row/column sampling, fixed tie-breaks, and every number rounded to 7 significant digits **before** it is
used, so the exported JSON reproduces the trainer's scores bit for bit (`model.check` holds rows the tests replay).
Each tree node stores its subtree's value, so a score splits exactly into bias + one contribution per feature
(Saabas path attribution): that is the "why" (`top`). Every row is also trained once with the market facts removed,
so the model still works when they are missing (the usual case in a browser).

Levels the model may raise to: low at p >= 0.5, medium at p >= 0.8, high at p >= 0.95 (each also tight enough to keep
the calibration set's false-positive rate under 10% / 2% / 0.5%).

## Data

| source | rows | label | licence |
|---|---:|---|---|
| Generated Solidity tokens (`data/solgen.js`): 9 scam families (honeypot sell block, max-sell, hidden mint, blacklist trap, seize, 25-95% sell tax, dormant uncapped fee, drain, link in name) and 11 benign ones (plain, renounced, capped mint, pausable, small tax, vesting, rewards, anti-whale, trading launch, burnable, compliance), with renamed functions and noise; compiled with solc 0.8.26 with and without the optimizer, listed on the in-memory DEX and read by Neuro's own reader, rules and buy/sell simulation | 1,200 | from construction | ours |
| tests-10k's scam-vs-benign generator (`data/synth-dispatch.js`): dispatcher-only code, weight 0.3 | 600 | as in tests-10k | ours |
| Red-team evasions (`data/redteam/evasions.jsonl`) | 67 | scam | ours |
| [forta-network/labelled-datasets](https://github.com/forta-network/labelled-datasets) `malicious_smart_contracts.csv` (exploit / heist / phish contracts, Ethereum), weight 0.5 | 0 here, up to 200 in CI | malicious | MIT |
| [ethereum-lists/tokens](https://github.com/ethereum-lists/tokens) (listed Ethereum tokens; listed is not proof of safe), weight 0.5 | 0 here, up to 200 in CI | benign (weak) | MIT |
| Neuro runner votes (`data/votes.js`) | 0 | flagged / not | own |

`data/import-public.js` checks each source's licence text before using it (MIT, Apache-2.0, BSD, CC0, ISC, Unlicense
only) and records source, licence and counts in `public-sources.json`. Considered and not used: HoneyBadger's honeypot
list and CRPWarner's rug-pull list (no licence file, so all rights reserved) and Uniswap's default token list (GPL-3.0).
The lists are reachable from this sandbox but the public RPCs and the GitHub API are not, so the committed model was
trained on synthetic data only; the weekly CI run reads the public contracts. Runner votes: the ThreatRegistry stores
fingerprint keys only and `src/threat-signatures.js` ships empty, so there is nothing to import yet; `votes.js` takes
an exported list of decided jobs once there is one.

Market facts for synthetic tokens (`data/market.js`) are drawn from made-up distributions that differ by label.

## Results (committed model `nml-3ab3cd303911`; before it `nml-b4c35477f7b1`)

**Read this first: these are synthetic numbers.** Train and test rows come from the same generators, and the market
facts are made up, so they overstate how the model will do on real contracts (a held-out AUC of 1.0 says the test set
is too easy, not that the model is perfect). The harder estimates are the leave-one-family-out and fresh red-team rows.

Same held-out split (390 rows, 201 scam, never trained on), same corpus, before -> after:

| | before (`nml-b4c35477f7b1`) | after (`nml-3ab3cd303911`) |
|---|---:|---:|
| AUC / recall @ 1% FPR / recall @ 5% FPR | 0.9975 / 0.950 / 0.985 | **1.000 / 1.000 / 1.000** |
| Brier / log loss / ECE (calibration) | 0.020 / 0.073 / 0.026 | **0.002 / 0.014 / 0.010** |
| market facts removed: AUC / recall @ 1% FPR | 0.9963 / 0.950 | **1.000 / 1.000** |
| generated Solidity rows only: AUC / recall @ 1% FPR | 0.9949 / 0.923 | **1.000 / 1.000** |
| what users see (medium+): scams caught / benign alarmed | 95.0% / 22.8% | **99.5%** / 22.8% (model alone: 99.0%) |
| leave one family out, recall @ 1% FPR: blacklist / dormant fee / drain / hidden mint / seize | 0.68 / 0.31 / 0.86 / 0.37 / 0.92 | **0.99 / 0.66 / 1.0 / 1.0 / 1.0** |
| leave one family out, alarmed (medium+): blacklist / dormant fee / drain / hidden mint / seize | 0.68 / 0.69 / 0.80 / 0.62 / 0.85 | **0.71 / 1.0 / 1.0 / 1.0 / 1.0** |
| fresh red team (never trained on), seeds B / C, caught at medium+ | 84% / 83% | **97% / 97%** |
| recorded evasions still missed (`known-gaps.json`) | 14 of 67 | **2** of 67 |
| model file / trees / on-chain bytes / zk constraints | 87 KB / 160 / 18,616 / 21,689 | **75 KB** / 160 / **15,544 / 15,518** (measured, not on-chain yet) |

**Where each model runs.** `nml-3ab3cd303911` is the model of the browser (the pinned pack in `web/models/neuro-ml-gbdt/1/`)
and the runners. The on-chain score (`NeuroScore`) and the zk circuit stay on the previous model `nml-b4c35477f7b1`
(`onchain/model.json`, 133 features, no path features) until a new public zk ceremony is run; see "On-chain score and zkML"
below. The last row's "after" figures are what the new model would take on-chain.

Rules alone (levels as a ranking) stay at AUC 0.7966 and catch 71.1% of scams with 22.8% of benign tokens at medium+
(benign tokens whose owner can mint or pause are medium/high by design); 0 rows lowered. Honeypot, max-sell and high tax
stay at 1.0 in every run (the simulation already catches them).

What changed:

- **Per-function path features** (`flow.js`, 25 `x_*` features, feature version 2): the dispatcher gives each
  function's entry; a bounded abstract interpreter follows its jumps and marks owner checks (`require(msg.sender ==
  owner)` and the hidden forms: hashed, XOR-masked, tx.origin), Transfer emission, fixed caps, storage writes, and what
  `transfer()` reads (time, gas price, origin, "is a contract", coinbase, gas left). That gives "an owner-only function
  moves or creates tokens with no cap" (drain, seize, hidden mint), "the owner can set the fee transfers charge to any
  value" (dormant fee), "`owner()` returns a constant while owner-only functions remain" (fake renounce) and owner
  exemptions inside `transfer()` (honeypots), however the functions are named. Plain JS, ~1 ms per corpus contract,
  ~0.2 s for a 24 KB contract.
- **Calibration** (`train/gbdt.js fitPlatt`): a weak prior around the identity and damped Newton steps. With the new
  features the calibration rows are perfectly separated and the old fit ran the slope off to ~1e8, rounding every
  probability to 0 or 1 (AUC fell to 0.988 in a first try); the prior keeps it finite.
- **Path checks next to the model** (`checks.js`): the three plain facts above raise the shown level to medium on
  their own (never lower it; at most "low" for an official issuer or template), because a learned model cannot flag a
  trap it never saw: with the dormant-fee family left out of training the model alone raised none of it, the check
  raises all of it. They add no false alarm on the held-out split.
- **Plain-words reasons** (`combine.js`): `ml.reasons` lists the checks that fired, then only what pushed the score
  UP (`top` mixes both directions); the in-browser analyst shows them.

## Red team (`redteam/run.js`)

Mutations: renamed functions; `owner()` returning 0 while a hidden admin stays (fake renounce); owner kept as a hash, an
XOR-masked number, or checked through `tx.origin`; the trap moved into a second contract (split guard); a custom
non-EIP-1967 proxy; a sell block that only closes after N days (time bomb); a 99% sell fee after N blocks (block ramp);
traps that let the simulation through (gas price 0, empty origin, seller is a contract, a 99% sale, lots of gas left,
coinbase 0). Base traps: honeypot, max-sell, hidden mint, blacklist, seize, drain, high tax, dormant fee, or none
(stealth). Every variant is compiled, deployed, listed and read like the corpus. No anvil/hardhat needed: Neuro's tests
use an in-memory `@ethereumjs/evm`, and so does this.

| run | variants | rules + simulation caught | with the model |
|---|---:|---:|---:|
| A, against the first model (`data/redteam/report-A-vs-first-model.md`) | 160 | 51% | 58% (67 evasions recorded) |
| B, fresh seed, against `nml-b4c35477f7b1` (trained on A's evasions) | 160 | 56% | 84% (26 evasions) |
| B again, against `nml-3ab3cd303911` + path checks (`report-B-fresh-vs-current.md`) | 160 | 56% | 97% (5 evasions, all time-bomb / block-ramp / coinbase stealth traps) |
| C, fresh seed, against `nml-3ab3cd303911` + path checks | 160 | 55% | 97% (5 evasions) |

Findings:
- The first model leaned on "an owner is active": hiding the owner (fake renounce, hash, XOR, tx.origin) pushed it
  down. After learning A's evasions, hashed/XOR/origin owners are mostly caught (B: 88% / 90% / 77%); fake renounce
  stays hard (63%), because `owner() = 0` reads exactly like an honest renounce.
- Time bombs and block ramps beat today's simulation by design (the trap is closed when Neuro trades); the model
  catches 50% / 14% of them in B. Benign vesting code also uses TIMESTAMP, so time alone is not a signal.
- "Seller is a contract" sim detection (the simulation sells from a contract, real users from wallets) passes the
  simulation; caught 0 of 1 in B. Worth fixing in `src/honeypot.js` (sell from an address with no code), not just in ML.
- A custom proxy hides the whole token interface, but the DELEGATECALL rule already flags it medium (100%).
- The 2 recorded evasions the committed model still misses (14 for `nml-b4c35477f7b1`) are listed in `data/redteam/known-gaps.json`;
  `ml/test/redteam.test.js` fails if any other recorded evasion slips back below medium.

## Weekly training (`.github/workflows/neuro-ml.yml`)

Monday 04:17 UTC and on demand. Steps: ML tests, synthetic corpus, public lists (read with Neuro through free public
RPCs), red team against the committed model (new evasions join the data), train a candidate, evaluate the committed
and the candidate model on the same held-out rows, fresh red team against the candidate, candidate must pass the ML
tests. If and only if the candidate is better (AUC and recall @ 1% FPR both no worse, one clearly better), a separate
job with `contents: write` + `pull-requests: write` opens a PR from branch `neuro-ml/model-<id>` with the metrics.
Everything else runs with `contents: read`. Actions are pinned by SHA; no secrets (only the job's own token).
One-time setting: Settings -> Actions -> General -> "Allow GitHub Actions to create and approve pull requests".
Pull requests also run the ML tests when `zetaphy-neuro/ml/**` or `src/**` change.

## On-chain score and zkML (`onchain/`)

The on-chain model is a separate, older model version: **`nml-b4c35477f7b1`** (`onchain/model.json`, feature version 1,
133 features), not `model.json`. The zk circuit hard-wires the model and the public phase-2 ceremony
(`onchain/zk/ceremony/transcript.json`) is for exactly that circuit, so the on-chain model moves only together with a new
ceremony. Until then the chain is fed only that model's own 133 features (feature versions only append, so they are
computed exactly as before; the new `x_*` path features never reach it), and a token may get a different level in the
browser than on-chain.

`node ml/onchain/export.js` turns `onchain/model.json` into integers (scale 1e7) packed 6 bytes per node (`onchain/model.fixed.json`,
18,616 bytes, its keccak256 is the model hash H). `zetaphy-network/contracts/NeuroScore.sol` runs exactly those bytes on-chain;
the DEX router can optionally refuse buys above a score. `onchain/zk/` is a Groth16 prototype proving "a committed feature
vector yields this margin under H". After a new ceremony, `node ml/onchain/export.js --promote --heldout` moves the on-chain
model to the current `model.json`; the weekly training never does. Parity, gas, proof size/time and limits:
`docs/future/onchain-ml.md`.

## Commands

```bash
npm run test:ml                         # features, determinism, JS parity, never-lower, red-team smoke + regression (~10 s)
node ml/data/build-corpus.js            # synthetic corpus -> ml/data/out/corpus.jsonl (~4 min)
node ml/data/import-public.js --max 200 # public lists (needs public RPCs)
node ml/train/train.js [--promote]      # train + evaluate -> ml/out/candidate (promote only if better)
node ml/redteam/run.js --n 160 --seed x # red team -> ml/out/redteam/report.md, appends evasions
node ml/redteam/run.js --gaps           # rewrite known-gaps.json for ml/model.json
node ml/cli.js bsc 0x...                # score a real token
```

## Limits

- Synthetic training data: real scams are more varied, real benign tokens more varied still. Expect real-world
  precision and recall well below the tables above until the public and vote data grow.
- EVM only (the bytecode features need EVM code).
- The model sees only what Neuro reads; a trap behind an unknown proxy or in another contract is only partly visible.
- A model can be studied and evaded like any rule: that is what the weekly red team is for.

## Federated learning (testnet-ready, not deployed; `fl/`)

Browsers can improve the score from labels users confirm after the outcome, without sending the labels: a small
logistic-regression head on top of the fixed trees (`fl/head.js`, theta = 0 = this model), local updates clipped
and noised on the device (local differential privacy, epsilon 5.3 per round at the default z = 2, budget 16),
commit-reveal on chain or signed envelopes, a coordinate-wise trimmed mean, a canary gate, and a trust region.
The model + head in force at a block height is chosen by the on-chain ModelEpochs (`manifest.json` is what it
schedules). Design, privacy accounting, simulated honest vs poisoned clients and limits:
[docs/future/federated.md](../../docs/future/federated.md). The opt-in browser panel is `web/fl-panel.js` (user and automatic outcome labels in `fl/labels.js`); the round contract is not deployed yet (`fl/deployment.json`).
