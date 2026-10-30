**English** | [ภาษาไทย](useful-work.th.md)

# Useful work: browser scan jobs, worker reputation, bug hunting, security-backed issuance

Testnet only. Nothing here holds or pays real money. Status per item is at the end of each section, and
"What is missing" lists what is not done yet.

| Item | What exists now | Status |
|---|---|---|
| 5 · Proof of useful work in the browser | `UsefulWork.sol` + "Useful work" mode on the hub's Mine page (`work.js`, `work-worker.js`), `zetaphy deploy-useful-work`, the feeder (`zetaphy work feed`, `.github/workflows/useful-work.yml`) | **Ready to deploy**: a deploy path (paused, timelock-owned), a scheduled feeder and the hub's deployed / paused / not-deployed states, all tested. **Not deployed yet**: the owner runs the workflow once (below) |
| 10 · On-chain reputation | `WorkerReputation.sol` (ERC-8004-style reputation, links to `NeuroIdentity` agents, reads NeuroJobs' runner record) | Done for the new markets; NeuroJobs itself does not write into it (it is read instead) |
| 17 · Browser bug hunting | `BugBounty.sol`, `VulnerableVault.sol` (deliberately vulnerable), `fuzz-core.js` + `fuzz-hook.js`, `vendor/evm.js`, `zetaphy work fuzz`, `zetaphy bounty check` | **Coverage-guided, stateful fuzzer** with 7 invariants, reentrancy through an attacker contract, shrinking, seeds, corpus and reproducer files. Finds every bug in VulnerableVault and 5 more deliberately vulnerable fixtures, nothing in 3 safe ones (tested) |
| 34 · Security-backed issuance | `UsefulIssuance.sol` (RewardVault recipient, capped buckets, pull-only, timelocked) | Done as a testnet contract module with tests; economics below. Not deployed, not yet in `zetaphy-launch` |

## How the pieces fit

```
RewardVault (500M pool, 10%/yr of the remainder; shares change only after 7 days)
   │ a share (governance decides, e.g. 10%) via fund()
   ▼
UsefulIssuance ── buckets (bps, cap) ──► UsefulWork  (scan jobs)      ──┐ draw() only when work
   │                                 ──► BugBounty   (bug findings)   ──┤ is verified
   │                                 ──► TrainingMarket (training)   ──┘
   └── overflow (unclaimed share, over-cap) ──► e.g. the PoW faucet account / validators

Browser (hub Mine page → "Useful work")
   stamp (PoW) → scan (Neuro src in a Web Worker) → commitMany → revealMany → settle → withdraw
   hunt (EVM in a Web Worker) → commitFinding → revealFinding → runners attest → claim

WorkerReputation ◄── outcomes from UsefulWork and BugBounty (+ reads NeuroJobs agreed/rejected)
```

All contracts are in `zetaphy-network/contracts/`, compiled into `artifacts/` (`npm run build`), tested in
`zetaphy-network/test/usefulwork.test.js` (16 tests) and `zetaphy-hub/test/work.test.mjs` + `work.e2e.mjs`.

## Item 5 · Proof of useful work in the browser (`UsefulWork`)

**The job.** A scan job names a chain (`zetaphy` or one of Neuro's EVM chains), a contract address and the
`codeHash` (keccak256 of its runtime code) the poster saw. A worker reads the code, checks the hash, and runs
**Neuro's own reader** (`zetaphy-neuro/src/reader.js`, the code runners use) over an RPC that knows only that
bytecode (`work-core.js` `codeOnlyRpc`: storage reads are empty, every `eth_call` reverts, sourcify and the trade
simulation are off). The verdict is `zetaphy-neuro/src/verdict.js`'s hash of what the rules decided. It depends on
the code alone, so every honest worker gets the same 32 bytes (tested: browser verdict = Node verdict).
This **code-only verdict is not the NeuroJobs verdict**: NeuroJobs also reads the owner and token state.

**The flow** (all on-chain except the scan):

1. **Stamp** (Sybil cost): `sha256(chainId u64 ‖ seed ‖ worker ‖ nonce u64)` must start with `stampBits` zero
   bits, the PoW faucet's exact layout, so the page reuses `mine-core.js`/`mine-worker.js`. The seed is
   `keccak(blockhash(h), UsefulWork)` (`stampSeed(h)`, h within the last 256 blocks), so a faucet proof is not a
   stamp and a stamp cannot be precomputed. A stamp buys `stampSeats` seats for `stampLife` seconds; each
   address takes at most `seatsPerDay` seats per UTC day.
2. **Seats and redundancy**: each job has `seats` (2–5, default 3) seats and pays an answer only when `quorum`
   (> half) seats revealed the same verdict. Each seat posts `seatDeposit`.
3. **Commit-reveal**: the commitment is `keccak(abi.encode(verdict, worker, salt, jobId))`, bound to the worker
   and the job, so nobody can copy or replay another's sealed answer. Reveals open when the seats are full
   (or the commit window ended). `commitMany` / `revealMany` take several jobs in one transaction (one wallet
   prompt each).
4. **Settle** (anyone): agreeing seats get their deposit back plus an equal share of the poster's fee (plus
   `subsidy` per seat for a subsidized feeder job). Wrong answers and missing reveals lose the deposit to the
   subsidy reserve. No majority: the poster gets the fee back, revealers their deposits, nobody is judged.
5. **Canaries**: a feeder (an address governance names, e.g. a GitHub Action that posts new contracts from
   Neuro's watch list) may post a job with a hidden commitment to the known answer. After the commits close it
   reveals it; seats that disagree are **slashed** even if they agreed with each other (catches lazy
   colluders who answer a constant).
6. **Rewards** are testnet ZETAPHY: poster fees, forfeited deposits, and the UsefulIssuance bucket (item 34).
   No new minting. BZTPHY points: not wired (see "What is missing").

"Signed results": each result is a transaction signed by the worker's own wallet key; the accepted verdict is
stored on-chain (`getJob(id).result`) and every reveal is an event.

**How to use it.** Hub → Mine → **🧠 Useful work** (`?tab=mine`, then the mode switch). While the contracts are not
in `hub-config.json` the page runs a **practice scan** (the vault's code from `bounties/sample-scan.json`) and a
**practice hunt**: nothing is sent and nothing is paid. With the contracts configured (`usefulWork`,
`bugBounty`, `workerReputation` from the deployment file, see "Putting it on the testnet"), **Take scan jobs** stamps, scans up to 3 open jobs,
commits with the deposit, waits for the other seats, reveals, settles, and shows what you earned (**Withdraw
earnings**). The salts are saved in `localStorage` before the commit (without them the deposit is lost); if the
tab closes, pressing the button again resumes the reveals. Runners compare with
`zetaphy work verdict <chain> <address>`.

**Parameters** (`setParams`, governance; deploy with a ZetaphyTimelock as governance): `stampBits` (8–48),
`stampSeats`, `stampLife`, `seatsPerDay`, `seats`, `quorum`, `commitWindow`, `revealWindow`, `seatDeposit`,
`subsidy`, `priorityScore`, `priorityWindow`. Measured PoW speed (hub README): ≈2.4 MH/s per browser thread, so
20 bits ≈ 0.4 s, 24 bits ≈ 7 s, 28 bits ≈ 2 min on one thread.

### Putting it on the testnet

Everything below is built and tested (`test/usefulwork-deploy.test.js`: real signed transactions against an
in-memory chain at chain id 77390, and the CLI through a JSON-RPC node). **Nothing has been deployed**: that is
one manual run by the owner.

1. **Deploy, paused, owned by the timelock.** `zetaphy deploy-useful-work [--feeder 0x…]` (or Actions →
   **Useful work** → Run workflow, mode `deploy`: environment `testnet-deploy`, the owner approves, secret
   `ZETAPHY_DEPLOYER_KEY`; the feeder address comes from the repository *variable* `USEFUL_WORK_FEEDER`). It reads the
   ZetaphyTimelock, NeuroJobs, NeuroIdentity, guardian multisig and RewardVault (the issuance overflow) from
   `zetaphy-launch/state/77390.json`, refuses a timelock with less than 2 days of delay and any chain but 77390,
   deploys WorkerReputation, UsefulIssuance, UsefulWork and BugBounty, wires them (reporters, feeder, guardian),
   **pauses** UsefulWork and BugBounty and hands every admin role to the timelock (checked before it returns). The
   deployer keeps nothing. It writes `zetaphy-network/deployments/useful-work-77390.json`; the workflow opens a
   pull request with it.
2. **Paused** means: no stamps, no new jobs or seats, no new bounties or findings. Reveals, canaries, settling,
   votes, claims, refunds and withdrawals still work, so no deposit is ever stuck. The **guardian** (multisig)
   may pause at once; only governance (the timelock) unpauses.
3. **Open it.** The deployment file lists the timelock operations (`proposals`): `UsefulIssuance.setBuckets`
   (60% scans, 40% bounties, 500 testnet ZETAPHY caps), `UsefulWork.setPaused(false)`, `BugBounty.setPaused(false)`,
   each with its operation id and the `schedule` / `execute` calldata. The proposers schedule them, anyone
   executes them after the delay.
4. **The feeder** (`zetaphy work feed`, Actions → **Useful work**, every 3 hours): reveals the canaries whose
   commits closed, settles finished jobs, and posts new scan jobs (contracts created in the last 300 blocks of
   ZETAPHY, the launch state's contracts, an optional `--targets` file), every 3rd one a canary. It is stateless:
   a canary's salt is `keccak(key, UsefulWork, jobId)`, recomputed at reveal time. It skips a contract posted
   lately with the same code. Environment `testnet-automation`, secret **`USEFUL_WORK_FEEDER_KEY`** (a
   dedicated testnet key with a little testnet ZETAPHY; governance makes it a feeder through `--feeder` at deploy or
   `setFeeder` via the timelock). Without the secret it is a dry run; before the deployment file exists it does
   nothing.
5. **The hub** reads the addresses from `hub-config.json`, which `build.mjs` now also fills from the deployment
   file (testnet chain id only). Three states, each tested in Chromium: *not deployed* (practice, says so),
   *deployed but paused* ("open after a timelock vote", practice, nothing sent), *open* (paid jobs).

Needed from the owner (no secret is added by this change): the variable `USEFUL_WORK_FEEDER` (the feeder's
address), the secret `USEFUL_WORK_FEEDER_KEY` in `testnet-automation` (see docs/SECRETS-HARDENING.md), one
`deploy` run, merging its pull request, and the timelock proposals.

**Status: ready to deploy** (deploy path, feeder and hub states tested); not deployed yet.

## Item 10 · On-chain reputation (`WorkerReputation`)

- Records per worker: `agreed`, `disagreed`, `missed`, `slashed`, `bugValid`, `bugInvalid`, `lastAt`. Only
  **reporters** governance names (the UsefulWork and BugBounty contracts) write outcomes, and each outcome comes
  from a commit-reveal round they settled on-chain. Governance can `slash` by hand.
- `scoreOf(worker)` (0–1000) = `1000·good / (good + bad + 5)` with good = agreed + 3·bugValid + NeuroJobs
  `agreed`, bad = disagreed + 2·missed + 5·slashed + 3·bugInvalid + NeuroJobs `rejected`. The prior of 5 means a
  new address starts at 0. NeuroJobs runners therefore carry their record over without NeuroJobs changing.
- **Important jobs first**: a job's `minScore` is a hard floor, and during `priorityWindow` after posting only
  workers with `priorityScore` or more may take seats.
- **ERC-8004**: a worker that owns a `NeuroIdentity` agent can `linkAgent(agentId)`; `getSummary(agentId)` then
  returns `(count, averageScore 0–100)` in the ERC-8004 reputation shape. The link follows the agent's owner.
- Honest limit: the score measures **agreement with other workers and canaries, not truth**. A colluding
  majority raises its own scores (see the economics).

**Status: done** for UsefulWork and BugBounty (tested); NeuroJobs feeds it read-only.

## Item 17 · Browser bug hunting (`BugBounty`)

- A sponsor posts a bounty: the `specHash` (keccak256 of a spec file served by the hub, e.g.
  `zetaphy-hub/bounties/vulnerable-vault.json`) and a reward. The spec carries the init code, the callable
  functions, the setup (a victim deposits 5 ZETAPHY) and the invariant (`attacker-profit`: the attacker must
  not end with ≥ `minProfit` more than it started; gas is free in the replay, so this is exact).
- The browser fuzzes it in the **EthereumJS EVM** (the EVM the contract tests use), bundled to
  `zetaphy-hub/vendor/evm.js` by `npm run build:evm` (437 KB, 132 KB gzip; no eval, no WebAssembly: the bn254
  precompiles are stubbed). It is loaded only when a hunt starts. `fuzz-core.js` is a **coverage-guided, stateful
  fuzzer** (the same file runs in the browser's Web Worker, in the runners' replay and in `zetaphy work fuzz`):
  - **coverage**: every JUMP/JUMPI edge executed in the target is recorded from the EVM's `step` events; a call
    sequence that reaches a new edge joins the corpus, and 3 of 4 new sequences are mutations of corpus entries
    (change an argument or value, insert / drop / swap / repeat a step, splice two entries, route a step through
    the attacker contract, arm a re-entry). The page shows the share of the target's jump targets reached;
  - **stateful sequences** of 1–8 calls by the attacker, directly or through **FuzzHook**
    (`fuzz-hook.js`, from `zetaphy-network/test/fixtures/fuzz/FuzzHook.sol`), the attacker's own contract: it
    calls the target with value and, when armed, **re-enters** it from its `receive`/`fallback` up to N times.
    A step that made the target call back into the hook is kept and gets a re-entry armed more often;
  - **arguments** from a dictionary: the actors, the hook, the target, edge numbers, the target's balance, the
    numbers the spec's setup uses and the constants the target's own bytecode PUSHes; `bytes` arguments get the
    spec's and the hook's selectors;
  - **invariants** (spec version 2; a finding is valid when the replay breaks at least one):
    `attacker-profit` (the attacker + its hook end with ≥ `minProfit` more), `victim-can-exit` (after the attack
    the victim runs `exit` and gets `exitMin` back), `balance-conservation` (the target holds at least the sum of
    `solvency(actor)` over the actors), `privileged-unchanged` (every `watch` view such as `owner()` returns what it
    did), `no-selfdestruct`, `no-delegatecall-to-attacker` (DELEGATECALL / CALLCODE to the attacker or its hook),
    `token-drain` (the attacker gains ≥ `minTokenProfit` of a listed token, or the victim loses any). A violation
    with the target re-entered while it ran is also tagged `reentrancy`;
  - **shrinking**: a violation is reduced to the fewest steps, fewest re-entries, smallest values and direct
    calls that still break the same invariant;
  - **reproducible**: one seeded generator (xorshift32) and a fixed block environment: the same seed, spec and
    options give the same run, byte for byte (tested). The minimised corpus (greedy set cover of the edges) can be
    saved and resumed (`--save-corpus`, `--corpus`);
  - **reproducer export**: each finding can be saved (page: **Save reproducer**; CLI: `--out`) as
    `zetaphy-fuzz-repro/1` JSON: the spec hash, the seed, the environment, the violations, a per-step trace
    (ok / attacker and target balances) and the exact finding to reveal. `zetaphy work verify-finding <spec>
    <reproducer.json>` replays it.
  The hunt keeps going after the first finding (one finding per invariant); the page submits the most serious
  one (attacker profit first). Version-1 specs (only `attacker-profit`) still replay as before.
- **Tested** (`zetaphy-network/test/fuzz.test.js`): every bug in **VulnerableVault** (the takeover by
  `initialize()`, the theft by `initialize(); sweep(attacker)`, the stuck victim, the insolvency) and in five more
  deliberately vulnerable fixtures (`test/fixtures/fuzz/Vulnerable.sol`): **ReentrantBank** (reentrancy drain
  through the hook: profit, stuck victim, insolvency), **OpenDelegate** (delegatecall to attacker code),
  **KillSwitch** (selfdestruct by anyone), **LeakyToken** (transferFrom without allowance: token drain),
  **OwnerTakeover** (unprotected `transferOwnership`); every finding replays as valid and is ≤ 3 steps. **No false
  positive** on the fixed versions (`Safe.sol`: SafeBank, SafeVault, SafeToken). Plus: same seed same run,
  corpus minimisation keeps coverage and resumes, the reproducer replays through the CLI, malformed findings are
  refused. Browser: `zetaphy-hub/test/work.e2e.mjs` hunts in Chromium and downloads the reproducer.
- **Commit-reveal**: `commitFinding(bountyId, keccak(findingHash, finder, salt, bountyId))` with a deposit;
  `revealFinding` in a later block within `revealWindow` puts the finding (JSON call sequence) in calldata and
  the event, so runners need no server. Findings are numbered in commit order; **the earliest valid finding
  wins** (later duplicates get only their deposit back), so watching a reveal cannot help a copier.
- **Verification by runners**: NeuroJobs runners with a track record (active, `agreed ≥ minAgreed`,
  `rejected ≤ agreed`, the ThreatRegistry bar) replay it (`zetaphy bounty check <id> --bounty 0x… --spec file
  --attest`, or offline `zetaphy work verify-finding spec.json finding.json`) and `attest`. `quorum` matching
  votes accept or reject. Accepted: `claim` pays reward + the bounty's subsidy (UsefulIssuance) + deposit.
  Rejected: the deposit grows the reward. Outcomes go to WorkerReputation.
- **The deliberately vulnerable contract** `VulnerableVault.sol` (TEST ONLY): `initialize()` has no access
  control and the deployment never calls it, so anyone becomes owner and `sweep`s every deposit. Its spec
  (`bounties/vulnerable-vault.json`, version 2) checks six invariants. The fuzzer finds the takeover at once and
  `initialize(); sweep(attacker)` within a few dozen sequences.
- **Research use**: `zetaphy work fuzz <spec.json> [--seed n --runs n --all --out repro.json --save-corpus c.json]`.

**Status: real fuzzer, tested** (coverage guidance, stateful sequences with reentrancy, 7 invariants, shrinking,
seeds, corpus, reproducers; end to end: the browser finds, commits, reveals one block later; runners' replay
accepts it; the earliest finding is paid). Limits under "What is missing".

## Item 34 · Security-backed issuance (`UsefulIssuance`)

- **No minting.** It is a `RewardVault` recipient (`fund()`). The share of new rewards it gets is a RewardVault
  share, which governance changes only through `proposeShares` + the vault's 7-day delay.
- Arrivals are split into **buckets** (`sink`, `bps`, `cap`): UsefulWork, BugBounty, and later others. The
  `10,000 − Σbps` remainder and anything above a bucket's cap go to **overflow** (e.g. the PoW faucet account or
  the validators): money is not hoarded when there is little useful work.
- **Pull-only**: a sink can only `draw` its own bucket, and the sinks draw only when their rules verified the
  work (a settled agreement, an accepted finding). Unverified work is never paid.
- **Governance must be a timelock** whose `getMinDelay()` is at least 2 days (checked at deploy and on
  `setGovernance`); `setBuckets`, `setOverflow` all wait the delay. No withdraw, no mint (tested).

### The economics, honestly

- **It does not add security by itself.** ZETAPHY's consensus is proof of stake; neither the faucet PoW nor
  these jobs secure blocks. "Security-backed" here means: a slice of the existing reward pool pays for work that
  improves users' security (contract scans, bug finds) instead of pure hashing. It is a redistribution of a
  fixed pool, so every bps given here is taken from validators or NeuroJobs runners.
- **Scan jobs are cheap compute.** A code-only scan takes milliseconds. The value is coverage (many contracts,
  checked independently), not hard work. Redundancy ×3 triples the cost on purpose.
- **The stamp is rate limiting, not identity.** 2^20–2^24 hashes cost a browser seconds. One person with many
  browsers can still take many seats.
- **Collusion is the main weakness.** Seats are first come, first served. One person with three addresses can
  take all three seats of a job, scan once, and be paid three times. Commit-reveal stops copying between
  strangers, not coordination. Canaries catch lazy answers (constants), not "compute once, copy three times"
  (which still gives the right answer, but the redundancy is fake). Limits: subsidies only for feeder jobs,
  `minScore`/priority windows for important jobs, per-address daily caps, bucket caps, deposits. The fix
  (not built) is a NeuroJobs-style blockhash lottery among stamped workers.
- **Subsidy vs. cost.** For subsidies to be farmable profitably, `subsidy × seats` must exceed gas + the
  expected lost deposits + stamp cost. Keep `subsidy` small and the bucket cap low until the lottery exists.
- **Bug bounties** are bounded by the sponsor's reward plus the governance-set subsidy. A colluding runner
  quorum could accept a fake finding and steal one bounty; runners are bonded in NeuroJobs but BugBounty cannot
  slash that bond.
- **"Model improvements"**: there is no on-chain way to verify that a model improved. The issuance has room for
  a bucket, but no sink contract exists for it.

**Status: done as a testnet contract module** (tests: timelock requirement, split, caps, overflow, pull-only,
removal to overflow, RewardVault → issuance → UsefulWork subsidy).

## Tests

```
cd zetaphy-network && npm ci && npm run build && npm test          # incl. usefulwork, usefulwork-deploy, fuzz tests
cd zetaphy-hub && npm ci && npm test && npm run test:e2e           # incl. work.test.mjs, work.e2e.mjs (Chromium, site CSP)
```

`work.e2e.mjs` runs the real contracts in an in-memory EVM behind a fake node at chain id 77390 and a stand-in
wallet: the browser stamps, scans, commits, reveals and settles with two other workers, then hunts and submits a
finding (commit, then reveal one block later); in practice mode it hunts, lists every bug kind found, shows the
coverage and downloads the reproducer; with a paused deployment it says so and stays in practice mode.
`usefulwork-deploy.test.js` deploys through `deployUsefulWork` and the `zetaphy deploy-useful-work` CLI (JSON-RPC
node on port 18096), runs the timelock proposals, and runs the feeder (paused → nothing; open → jobs and canaries;
canaries revealed from the derived salt; settled). `fuzz.test.js` is described in item 17.

## What is missing

- **The deployment itself**: the path is ready and tested, but nothing is deployed until the owner sets
  `USEFUL_WORK_FEEDER` / `USEFUL_WORK_FEEDER_KEY`, runs the `deploy` mode once, merges its pull request and the
  timelock executes the opening proposals. It is not part of `zetaphy-launch` (its own file, its own workflow).
- **The feeder's targets** are contracts created on ZETAPHY lately plus a few known ones; Neuro's watch list lives
  only in users' browsers, so it cannot feed from it. Other chains need a `--targets` file.
- **Seat lottery** (blockhash draw among stamped workers) against one-person-three-seats collusion.
- **BZTPHY points** for useful work: the daily award job does not read `SeatOutcome` / `BountyPaid` yet.
- **Runner rewards for verifying bugs**, and slashing a runner's NeuroJobs bond for a wrong attestation.
- **Non-EVM scan jobs** (Solana, Move, TON): the code-only scan is EVM only.
- **The fuzzer's limits**: no symbolic execution or SMT (bugs behind a 32-byte magic value not in the code, or a
  hash preimage, are out of reach); one target contract per spec plus the attacker's hook (no multi-contract
  systems, no token callbacks such as ERC-721/1155/777 hooks); time does not advance (time-locked bugs need the
  spec's setup); every invariant needs the spec author to name its views (`watch`, `solvency`, `exit`, `tokens`), and
  a `watch` view that legitimately changes would be reported; arrays and tuples only shallowly. Speed: about
  10–25 ms per sequence (the EVM's per-opcode `step` events cost), i.e. a few thousand sequences a minute.
- **A model-evaluation market** (bucket sink for "model improvements"): now `TrainingMarket`, see [useful-work-training.md](useful-work-training.md) (training + spot-checks + held-out evaluation; not deployed).
- Runner installs (`setup-runner.sh`) now copy the three browser core files; verifying findings also needs the
  EthereumJS EVM (a devDependency of zetaphy-network: `npm i` with dev dependencies).
