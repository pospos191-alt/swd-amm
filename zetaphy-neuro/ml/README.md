**English** | [ภาษาไทย](README.th.md)

# Neuro ML: a learned risk score + a red team

Neuro's fixed rules say what a contract's code **can** do. This folder adds two things on top, all free, with no server:

- **Stage 2, a learned model** (`model.json`, 87 KB): gradient-boosted trees that turn what Neuro already computes into a
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

## Features (`features.js`, 133 numbers)

From what Neuro already computes, nothing new is fetched:

| group | examples |
|---|---|
| rules (`r_*`) | rules level, who controls it (owner / renounced / roles / upgradeable / unknown), proxy kind, link in name, look-alike, official issuer, template, similarity %, unknown pattern, DELEGATECALL finding |
| functions (`s_*`) | how many functions, how many unnamed, share of ERC-20, count per kind: mint, blacklist, pause, fee setters, trading switch, limits, upgrade, roles... |
| code (`o_*`, `p_*`, `g3_*`) | code size; SELFDESTRUCT / DELEGATECALL / CREATE2 / CALL present; share of SSTORE, CALLER, ORIGIN, TIMESTAMP, NUMBER, GASPRICE, EXTCODEHASH...; patterns: caller-equals-stored-address checks, hashed or XOR-masked caller checks (hidden owners), tx.origin checks, time/block-number conditions, gas-price conditions, "is it a contract" checks; 32 hashed opcode 3-gram buckets |
| simulation (`m_*`) | buy/sell ran, ok / tax 10-50% / tax > 50% / cannot sell / skipped, buy and sell tax |
| market (`k_*`, optional) | largest holder share, top-10 share, liquidity locked, liquidity, contract age, verified source, holders; each with a `_known` flag (missing = 0 and unknown, never guessed) |

## Model

Gradient-boosted decision trees (logistic loss, 160 trees of depth 4, learning rate 0.15) written from scratch in
`train/gbdt.js`, then Platt-calibrated on a separate calibration split. Training is deterministic: sorted thresholds, a
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

## Results (committed model `nml-b4c35477f7b1`)

**Read this first: these are synthetic numbers.** Train and test rows come from the same generators, and the market
facts are made up, so they overstate how the model will do on real contracts. The harder estimates are the
leave-one-family-out and fresh red-team rows.

Held-out split (390 rows, 201 scam, never trained on):

| | AUC | recall @ 1% FPR | recall @ 5% FPR | Brier | ECE |
|---|---:|---:|---:|---:|---:|
| model | 0.9975 | 0.950 | 0.985 | 0.020 | 0.026 |
| model, market facts removed | 0.9963 | 0.950 | 0.975 | 0.026 | 0.037 |
| model, generated Solidity rows only | 0.9949 | 0.923 | 0.977 | 0.029 | 0.035 |
| rules alone (levels as a ranking) | 0.7966 | | | | |

What a user sees ("medium" or higher): rules + simulation catch 71.1% of scams with 22.8% of benign tokens also at
medium+ (benign tokens whose owner can mint or pause are medium/high by design); with the model 95.0% of scams, and the
benign rate stays 22.8% (model adds no false alarm on this split; 0 rows lowered).

Leave one scam family out of training entirely (recall at the 1%-FPR threshold / share alarmed by rules / by rules + model):
blacklist trap 0.68 / 0.38 / 0.68, dormant fee 0.31 / 0.39 / 0.69, drain 0.86 / 0.00 / 0.80, hidden mint 0.37 / 0.45 /
0.62, seize 0.92 / 0.00 / 0.85; honeypot, max-sell, high tax 1.0 (the simulation already catches them). A brand-new
kind of trap is caught much less often than one the model has seen.

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
| B, fresh seed, against the committed model trained on A's evasions (`report-B-fresh-vs-current.md`) | 160 | 56% | 84% (26 evasions) |

Findings:
- The first model leaned on "an owner is active": hiding the owner (fake renounce, hash, XOR, tx.origin) pushed it
  down. After learning A's evasions, hashed/XOR/origin owners are mostly caught (B: 88% / 90% / 77%); fake renounce
  stays hard (63%), because `owner() = 0` reads exactly like an honest renounce.
- Time bombs and block ramps beat today's simulation by design (the trap is closed when Neuro trades); the model
  catches 50% / 14% of them in B. Benign vesting code also uses TIMESTAMP, so time alone is not a signal.
- "Seller is a contract" sim detection (the simulation sells from a contract, real users from wallets) passes the
  simulation; caught 0 of 1 in B. Worth fixing in `src/honeypot.js` (sell from an address with no code), not just in ML.
- A custom proxy hides the whole token interface, but the DELEGATECALL rule already flags it medium (100%).
- The 14 recorded evasions the committed model still misses are listed in `data/redteam/known-gaps.json`;
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
