**English** | [ภาษาไทย](markets.th.md)

# Forecasts, data and detectors that train Neuro (testnet)

Five pieces that turn people's and models' judgement into labelled data and better detectors for Neuro.
**Testnet only.** Every stake, bond and reward is testnet ZETAPHY, which has no value; the scripts refuse any
chain but 77390. None of this is a way to make money, and the wording everywhere says "forecast", never "bet".
Nothing here changes `zetaphy-neuro/src/` (Neuro's skill id is unchanged); the ML code lives in `zetaphy-neuro/ml/`.

| # | Item | Status |
|---|---|---|
| 15 | Risk forecasts (RiskForecasts) + labelled export | **Done** (testnet prototype, tested; not deployed) |
| 16 | Data DAO (DataDAO) + attribution + rewards root | **Done** (prototype; attribution on real data not yet run) |
| 26 | Evolving detectors (DetectorPool) + the automated loop | **Done** (testnet prototype; breed → submit → forecast → reveal → score → settle runs as one scheduled command, deterministic, tested; not deployed) |
| 27 | Red-vs-blue arena (RedBlueArena) + k-of-n sandbox runners | **Done** (testnet prototype; k-of-n bonded runners with commit-reveal results, slashing, a pinned sandbox and a challenge path, tested; not deployed) |
| 29 | Proof of Foresight (ForesightRegistry) | **Done** (tested; not deployed) |

How they fit: RiskForecasts (and later the arena) *resolve* questions from chain facts → ForesightRegistry scores every
committed probability (Brier) → DetectorPool pays/slashes detector organisms by those scores → the mutation job breeds new
organisms from the best → resolved questions and arena results are exported as labelled rows → the Data DAO pays for
labelled data by how much it improves Neuro's model.

## 29. Proof of Foresight — `zetaphy-network/contracts/ForesightRegistry.sol`

- A **model id** (bytes32, e.g. `keccak256("neuro-ml nml-b4c35477f7b1")`, `src/markets.js modelIdOf`) belongs to the first
  address that registers it.
- Only **resolvers approved by governance** (contracts that answer from chain facts: RiskForecasts, later the arena) may
  open events, so nobody can farm a track record on events whose answer they choose.
- Before `commitEnd` the model's owner commits `keccak256(abi.encode(eventId, modelId, p, salt))`, p in basis points.
  The model id is inside the hash, so copying another model's commitment cannot be revealed. After `commitEnd` and
  before `revealEnd` anyone with the salt reveals. The resolver can close commits early (RiskForecasts does it the moment
  the condition is seen).
- `score` adds the Brier score `(p − outcome)²` (1e8 = 1.0) to the model's track; **an unrevealed commitment scores 1.0**
  after the reveal deadline, so hiding a bad forecast never helps. Void events are not scored.
- `brierOf(model)` → (n, mean); `skill(model)` → basis points better than always-50%, shrunk by n/(n+10).
- Used as a weight: DetectorPool reads the tracks (item 26); `zetaphy-neuro/ml/detectors/spec.js foresightWeighted`
  combines several models' probabilities by on-chain skill (advisory, like the ML score — never the verdict).
- Salt without storage: `scripts/markets.js commit|reveal` derives the salt from the key + event + model
  (`derivedSalt`), so a scheduled job can commit and later reveal without saving anything. (A probability has only 10001
  values; a guessable salt would leak it.)

## 15. Risk forecasts — `contracts/RiskForecasts.sol`

- Question kinds: **LiquidityDrop** ("the other side of token X's pool loses ≥ N% of what it held at opening, before the
  deadline"; N from 10% to 100%, pool at least `minReserve`) and **Flagged** ("X is flagged in the ThreatRegistry before the
  deadline": `isAddressFlagged(chainid, X)` or `isContractFlagged(X)`; refused if already flagged).
- Forecasters back yes/no with testnet ZETAPHY until `closeAt`, and never while the condition already holds.
- Resolution only from chain state: anyone `poke`s (a keeper does hourly). A drop must still hold `confirmDelay` (1 h)
  later — a flash swap or one-block dip is not enough; it resets when it stops holding. A flag confirms at once (it already
  took a quorum of runners). The first sighting closes forecasts and the Foresight event's commits.
- `propose` states the answer the facts give (yes once confirmed; no after deadline + confirm time). During the
  `disputeWindow` (1 day) anyone may post `disputeBond` (10 testnet ZETAPHY); governance then decides yes / no / void (e.g.
  an honest pool migration, or a flag later found wrong). The bond comes back if the answer changed.
- Payout: accurate forecasters split the whole pot pro rata; if nobody was right, or the question is void, everyone gets
  their stake back. Pull payments (`claim` → `withdraw`).
- **Labelled data**: `node scripts/markets.js export --forecasts 0x… --out forecasts.jsonl --votes votes.json`. Each final,
  non-void question → `{label: 1 if the bad thing happened, address, chain: "zetaphy", question, horizonDays, crowdP}`.
  `votes.json` is the format `zetaphy-neuro/ml/data/votes.js` already reads, which re-reads each token with Neuro to get
  features (`node ml/data/votes.js --in votes.json`). `crowdP` (stake-weighted yes share) is kept separate, never the label.
- Keeper: `.github/workflows/markets.yml` `keeper` job (hourly, only if the variable `RISK_FORECASTS` is set; dry run unless
  the secret `MARKETS_KEY`, a testnet key with gas, is set).

## 16. Data DAO — `contracts/DataDAO.sol`, `zetaphy-neuro/ml/dao/attribute.js`

- `submit(dataHash, uri, rows, license)`: unique by hash, URI ≤ 200 bytes; governance can `exclude` bad or unlicensed data.
- Attribution (`attribute.js`): utility U(S) = −logloss on a **fixed held-out set** of a model trained on the base corpus +
  contributors S (the same GBDT as `ml/train`, 40 trees by default). Methods: **leave-one-contributor-out** (C+1 models) or
  **Monte-Carlo Shapley** (`--method shapley --perms K`, subsets cached). Before training, rows already given by the base or
  an earlier submission are dropped (copying earns 0) and data without an open licence is unusable. Shares = positive scores
  normalised. Report: per contributor rows given/used/duplicates, score, share; held-out logloss/AUC with base only / all.
- Root: `node scripts/markets.js dao-root --report report.json --budget 100 --dao 0x… --round N --out root.json`. Leaf
  `keccak256(keccak256(abi.encode(dao, chainid, round, account, amount)))`, sorted pairs.
- Contract: `postRound(root, total, reportHash, reportUri)` by the governance-chosen **poster** (a multisig that checked the
  job's report); claims open after `vetoDelay` (2 days, governance may veto a wrong root), expire after `claimPeriod` (60 days)
  and `sweep` returns the rest to the pool. Anyone may submit a claim for an account; coins go to the account.
- Tests: `test/datadao.test.js` (contract, merkle, the dao-root command), `ml/test/markets.test.js` (useful data scores > noisy
  data, copied data gets 0, unlicensed unusable, LOO and Shapley).

## 26. Evolving detectors — `contracts/DetectorPool.sol`, `zetaphy-neuro/ml/detectors/`

- Organism = a spec (`neuro-detector/1`: weighted threshold rules over Neuro's 133 ML features, p = sigmoid(bias + Σ w·[f op t]))
  with author, testnet stake (≥ 1), parent organism, `specHash` (keccak256 of the canonical JSON) + URI, and a Foresight
  model id owned by the author. At most 64 alive.
- Each round (7 days; anyone calls `scoreRound`) the pool reads every organism's Foresight Brier scores from that round:
  ≥ `minForecasts` (3) and better than 0.25 → winner, paid `rewardPerRound` (from funding) + all slashed stakes, by
  (0.25 − Brier) × forecasts; worse than 0.25 → 20% of stake slashed, a strike; 3 strikes or stake < minimum → retired (rest
  returned). Four idle rounds in a row → retired without a slash. `requestExit` only takes effect after the next round is
  scored, so a bad round cannot be dodged.
- Mutation (`ml/detectors/mutate.js`): threshold moves (often to a value seen in the data), weight/bias jitter, op flip, rule
  drop/add, crossover, then a short hill-climb; a child is kept only if its Brier on a **held-out 30%** beats its parent's.
  Deterministic per round. `--predict` gives each spec's probability (basis points) per row for Foresight commits.
- **The loop, automated** (`zetaphy-network/src/detectorloop.js`, `node scripts/markets.js detectors-round`, scheduled every 6 hours by
  the `detectors` job of `.github/workflows/markets.yml`). One pass does whatever is due, so repeated passes complete a round with
  no hand work:
  1. **breed**, once per DetectorPool round: parents = the living organisms whose spec is in the population folder (else the seed);
     `mutate.js evolve()` seeded with the pool's round number; a child is kept only if its Brier on **held-out labelled rows** beats
     its parent's. The held-out rows are a curated file when given (`--held`, never trained on: `ml/detectors/held-out.jsonl` once
     curated) else the deterministic 30% split;
  2. **submit**: each child gets its Foresight model id and a DetectorPool organism with the testnet stake; its spec file is
     content-addressed (`<first 16 hex of specHash>.json`) and published on the branch `detectors/population` (its URI);
  3. **forecast**: for every open Foresight event of RiskForecasts (or an `--events` list), each of the runner's living organisms
     commits p = its spec on Neuro's features of the event's token (read with Neuro from ZETAPHY, read-only), salt derived from the key;
  4. **reveal** after the commit deadline: p is recovered from the on-chain commitment by trying its 10,001 possible values with the
     derived salt, so nothing is stored between runs and a token that changed meanwhile cannot change what is revealed;
  5. **score** resolved events (`scoreMany`, every living organism's model); 6. **settle** the pool round (`scoreRound`) once it ended.
  Each pass writes a **manifest** (inputs' hashes, seed, parents, children, every prediction with the features it used, every
  action; uploaded as an artifact); `checkManifest` re-derives the children and predictions offline. Without `--send` (the workflow
  without `DETECTORS_SUBMIT=on`) it only plans. Testnet only (chain 77390).
- `evolve` (weekly, no key) still breeds offline from the synthetic corpus and uploads the children as an artifact.
- Tests: `test/detectorpool.test.js` (pay/slash/retire/idle/exit with real Foresight records), `test/detectorloop.test.js` (the
  whole loop with real signed transactions at chain id 77390: breed on held-out rows, submit, commit, reveal with p recovered, score,
  `scoreRound` pays the detectors; idempotent passes; a second world gives the same children and predictions; dry run sends nothing;
  the `detectors-round` CLI through a JSON-RPC node), `ml/test/markets.test.js` (incl. the curated held-out set).

## 27. Red-vs-blue arena — `contracts/RedBlueArena.sol`, `zetaphy-neuro/ml/redteam/arena.js`

- Governance opens a round with bounties (red share in bps). Red (bond 1) commits a scam-token manifest, blue (bond 1) a
  detector spec: `keccak256(arena, round, side, author, contentHash, salt)` before `commitEnd`, reveal (content hash + URI)
  after it, so neither side can tailor to the other.
- Runner (`arena.js`, built on `ml/redteam`): fetch (`markets.js arena-fetch`, https/ipfs, 100 kB) and hash-check each entry;
  each red token is compiled, deployed and listed **only on the in-memory sandbox devnet** (`ml/lib/chain.js`), read by Neuro
  (rules + sell simulation) and the committed model; then a victim buys for 0.1, the owner runs the declared trap steps
  (or `dump`), and the victim sells. **Valid** = the victim gets back < 50% of the quote right after buying (or cannot sell);
  **evaded** = valid and Neuro shows < medium. Blue score = valid reds caught (p ≥ 0.5) − 2 × benign reference tokens flagged
  (generated benign families, fixed seed). Output: `result.json` (the result and its sandbox id, what runners commit and reveal) + `dataset.jsonl` (each valid red as a
  label-1 row with features and `evaded`).
- **No single trusted runner** (the contract):
  - **k-of-n**: up to `seats` (n, default 3) runners that governance approved **and** that posted `runnerBond` (10 testnet ZETAPHY)
    take a seat by committing `keccak(arena, round, runner, resultKey, salt)` before `resultCommitEnd`; nobody can copy another's
    result. They reveal the full result (bitmaps + blue scores; bits only for revealed reds, evaded ⊆ valid) before `judgeEnd`.
  - **pinned sandbox**: the round names `sandbox`, the hash of the runner environment (`ml/redteam/sandbox.js`: exact
    `@ethereumjs/evm` 3.1.1 / common 4.4.0 / util 9.1.0 and solc 0.8.26, optimizer settings, a fixed block (number, timestamp; zero
    coinbase, prevRandao, base fee), Neuro's model id, the simulation seed, the benign reference set's seed and size, the judging
    rules' version); `resultKey = keccak(sandbox, result)`. The runner refuses to judge with other package versions or for a round
    opened with another sandbox, and two runs give byte-identical results (tested), so honest runners agree.
  - **finalize** (anyone, after `judgeEnd`): the result `quorum` (k > n/2, default 2) runners revealed is the round's result. Runners
    that revealed another result, or never revealed, lose `slashBps` (50%) of the runner bond; no quorum → void (silent runners are
    still slashed).
  - **challenge** (anyone, during `challengeWindow`, 1 day, with `challengeBond`, 5 testnet ZETAPHY), naming the result it says is
    right. Governance (the timelock) re-runs the pinned sandbox and resolves: **upheld** → the challenger's result replaces it, the
    runners who posted the wrong one are slashed, the challenger gets its bond back plus half of those slashes; **rejected** → the bond
    goes to the agreeing runners. Unanswered within `appealWindow` (7 days) → it lapses: bond back, result stands.
  - **settle** (after the challenge window): evading reds split the red pool, valid reds get bonds back, invalid/unrevealed lose
    them; positive blue scores split the blue pool; the agreeing runners split `runnerFeeBps` (5%) of the pools plus the slashed
    bonds; leftovers carry to the next round; void → revealed bonds back. Runner bonds unbond after `unbondDelay` (14 days) and not
    while seated in an open round.
- **Runner commands** (`scripts/markets.js`): `arena-fetch` (entries + the round's sandbox) → `node ml/redteam/arena.js --round
  round.json` → `arena-commit` → `arena-reveal` (the salt is derived from the runner's key, so the reveal needs only the same
  result.json) → `arena-finalize` → `arena-check [--challenge]` → `arena-settle`. `node ml/redteam/arena.js --sandbox` prints the
  sandbox id to open a round with.
- Test result (`ml/test/arena.test.js`): a token whose 99% sell fee is switched on after the scan is judged valid but
  **caught** (rules show medium because of the fee setter); a plain token is invalid; tampered/unrevealed/uncompilable
  entries are rejected; the seed detector catches it with 0 false positives on the reference set; the sandbox id is stable,
  includes the model and the benign set, the pinned versions are installed, a round opened for another sandbox is refused, and
  two independent judgings of a round are byte-identical. `test/arena.test.js`: k-of-n judging and payouts, a colluding
  quorum overturned by an upheld challenge, a rejected and a lapsed challenge, no quorum, bonds, seats, parameters;
  `test/arena-runners.test.js`: three runners through the real CLI (one slashed).

## Hub page

`zetaphy-hub/forecasts.html` (menu: "Risk forecasts"), 8 languages (`forecasts-i18n.js`), strict CSP (no inline code, same-origin
module). Tabs: Risk forecasts (questions from the chain; forecast yes/no, claim, withdraw from MetaMask), Proof of Foresight
(look up a model's Brier and skill), Detectors (organisms, stake, strikes/wins, last Brier), Data DAO (submissions, rounds),
Red vs blue (rounds, entries, result). Contract addresses come from `hub-config.json` (`riskForecasts`, `foresight`,
`detectorPool`, `dataDao`, `arena` in the launch state); until deployed each tab shows the local commands. Tests:
`test/forecasts.test.mjs` (selectors vs ABIs, i18n, CSP), `test/forecasts.e2e.mjs` (Chromium, mocked node, phone width).

## How to run

```bash
cd zetaphy-network && npm ci && node --test test/forecasts.test.js test/datadao.test.js test/detectorpool.test.js test/detectorloop.test.js test/arena.test.js test/arena-runners.test.js
cd ../zetaphy-neuro && npm ci && node --test ml/test/markets.test.js ml/test/arena.test.js
node ml/detectors/mutate.js --rows ml/data/redteam/evasions.jsonl,ml/data/out/corpus.jsonl --round 1
node ml/dao/attribute.js --base corpus.jsonl --held held.jsonl --contrib contributions.json --method shapley --perms 20
node ml/redteam/arena.js --sandbox          # the sandbox id a round is opened with
node ml/redteam/arena.js --round round.json
cd ../zetaphy-hub && npm ci && npm test && npm run test:e2e
```

## Limits and what remains (honest)

- **Not deployed.** No launch step deploys these contracts yet; the hub shows "not deployed" until `hub-config.json` has the
  addresses. Deploy order: ForesightRegistry → RiskForecasts (resolver), DetectorPool, DataDAO, RedBlueArena; then
  `setResolver(RiskForecasts)`; governance should be the timelock.
- **Liquidity facts are manipulable at the edges**: an LP who adds liquidity just before opening and removes it later makes
  "yes" true (that *is* a liquidity pull, but a staged one). `minReserve`, the confirm delay and the dispute window reduce
  this; they do not remove it. Forecasts and commits placed between the real event and the first poke leak information; the
  hourly keeper bounds that window, it does not close it. Only Uniswap-V2-style pairs (`token0/token1/getReserves`).
- **Selection bias in Foresight**: a model chooses which events it forecasts. DetectorPool needs ≥ 3 per round and retires
  idle organisms, but a model can still skip hard questions. A fix (score every open event, missing = 0.25 or 1.0) needs an
  on-chain list of events per round — not built.
- **Detector loop**: automated end to end, but it needs the contracts deployed and the variables `DETECTOR_POOL`, `FORESIGHT`,
  `RISK_FORECASTS`, `DETECTORS_SUBMIT=on` and the secret `MARKETS_KEY` in the `testnet-automation` environment. The curated
  held-out file (`ml/detectors/held-out.jsonl`) does not exist yet, so until it is curated children are judged on the 30% split of
  the synthetic corpus + red-team evasions (synthetic data: a child that wins there can still do badly on real tokens; the
  Foresight scores are the real test). Features are read at commit time; a token that changes later is forecast as it was. A
  runner only forecasts with its own organisms (Foresight model owners).
- **Data DAO attribution** has only been run on synthetic rows in tests. On real data its cost is (C+1) trainings for LOO and
  ~perms × C for Shapley; with 40 trees and ~2k rows each training is seconds, so tens of contributors fit in a CI job;
  hundreds would need grouping. Leave-one-out undervalues overlapping datasets (use Shapley). The held-out set must be
  curated and never contributable — that curation is not done. The poster is a trusted (governance) role.
- **Arena runners**: no single runner is trusted any more, but runners are still governance-approved and seats are first come,
  first served, so one operator with several approved, bonded addresses could fill a quorum; the challenge path is the backstop and
  it ends with governance (the timelock) re-running the sandbox, so governance is trusted to resolve challenges honestly. There is
  still one runner implementation (pinned, deterministic). The validity test covers "the victim loses ≥ 50%" scams (sell blocks,
  fees, blacklists, seizes, mint-and-dump) but not slow drains, approvals phishing or multi-contract setups beyond one source
  file. Trap steps run as the deployer on the token only. Time-based traps need explicit trigger calls (the sandbox does not
  advance time).
- RiskForecasts uses a ThreatRegistry stand-in in tests (the real registry needs a runner quorum to flag).
