**English** | [ภาษาไทย](red-team.th.md)

# Red team: break it before someone else does, and pay whoever does

**Testnet prototype.** Nothing here holds or pays real money. Every attack runs on a **local fork or an in-memory
EVM**, never on a live chain, a mainnet, or anyone else's contract. The contracts have not been audited.

An audit says a contract passed a process on a day. It does not say the contract is unbreakable, and it says
nothing about the economics around it. The Open Audit Network ([audit-network.md](audit-network.md)) is the
blue team. This is the **red team**: a standing effort to break what is certified, a market that pays anyone who
brings a working exploit, and a simulation that puts a number on how much a DeFi contract can lose to an
economic attack.

Three pieces, each builds on what the network already has (deterministic replay, bonded NeuroJobs runners with
commit-reveal, CircuitBreaker):

| Piece | What | Where |
|---|---|---|
| **S1 — Exploit market** | anyone submits a working exploit against a listed contract; deterministic replay decides it, no judges; the submitter is paid from the contract's escrow and the contract can be paused | `zetaphy-network/contracts/ExploitMarket.sol` |
| **SS3 — AI red team** | an off-chain agent that keeps attacking certified contracts on a local fork (a strategy library + a seeded search, an optional LLM), and builds the S1 submission when it finds a working exploit | `zetaphy-network/src/redteam/…`, CLI `zetaphy redteam`, the (manual) `red-team` workflow |
| **SS4 — Economic security** | an agent-based simulation of economic attacks (sandwich, oracle manipulation, liquidation cascades) against the DEX, giving a reproducible "max extractable loss ≤ X", attachable to an audit request | `zetaphy-network/src/redteam/economic.js`, `zetaphy-network/contracts/EconomicBounds.sol` |

Everything deterministic works **without any API key or model**. An LLM is an optional source of attack ideas;
it can never decide an outcome.

---

## S1 — The exploit market

A sponsor lists a contract on ZETAPHY and escrows a bounty. Anyone (not the sponsor) submits a working exploit:
a bundle of transactions replayed on a **fork of the chain** at a chosen block. Three bonded NeuroJobs runners
replay the bundle and commit their verdict (commit-reveal, 2 of 3 must agree). No judges — the replay is
deterministic, so two honest runners get the same bytes. A confirmed exploit:

- pays the submitter from the escrow **at once** (pull payout), with its bond back;
- pays the agreeing runners a cut of the reward;
- marks the listing **exploited** (closed; a fix is a new listing on new code);
- if the contract opted in to `CircuitBreaker`, emits `PauseRequested` with the evidence the runners use to trip
  the breaker (the breaker's own quorum and guardian bonds still decide; nothing here can pause on its own).

A listing fixes, in advance, what a confirmed exploit pays:

- a **loss** claim: the replay must show the listed `asset` (native coin or an ERC-20) leaving the target by at
  least the claimed amount; the reward is `claimedLoss × unitValue × rewardBps`, capped at `maxReward` and the
  escrow;
- an **invariant** claim: the replay must break one invariant of the suite the listing commits
  (`invariantsHash`); the reward is a fixed `invariantReward`.

**Binding and anti-copy.** The submission's `evidenceHash` binds the chain, the target, its code hash, the fork
block, the bundle hash, the claim **and** the submitter (the beneficiary). Only the hash is on chain; the bundle
reaches the runners off chain. Copying the hash pays nobody else; a runner who resubmits someone's bundle as its
own is later in the listing's queue (first come, first paid). A spam bond is paid to the runners when an exploit
is rejected, and refunded when there is no 2-of-3 agreement.

**Effects before interactions, pull payouts.** The only value-moving call is `withdraw`, which zeroes the credit
before it pays and writes nothing after. The sponsor takes the escrow back `unlistDelay` after asking (longer
than one submission's whole life), never while a submission is pending, so a known exploit cannot be fled.
Governance (`ZetaphyTimelock`) only sets bounded parameters; it never moves escrow. No new admin key.

```
zetaphy exploit list   --market 0x… --target 0x… --pool 100 --min-loss 1 --unit-value 1 --max-reward 100 [--breaker --invariants suite.json]
zetaphy exploit submit --market 0x… --listing <id> --bundle redteam-0.json [--invariant <id> --suite suite.json]
zetaphy exploit commit --market 0x… --id <sub> --verdict report.json   # a runner; then reveal, then settle
zetaphy exploit withdraw --market 0x…
```

---

## SS3 — The AI red team, 24/7

An off-chain agent (`zetaphy-network/src/redteam/`) that forks a chain locally and keeps trying to break a
contract. It needs the target's ABI (found automatically when the runtime code matches a repo artifact).

**The fork** (`fork.js`) is an in-memory EVM (the same EthereumJS the contract tests use) reading a chain's state
lazily at one block — over JSON-RPC, or the repo's own test chain — and never writing back; or a local `anvil`
the caller started with `--fork-url`. It **refuses any chain that is not a testnet or a local chain**
(`TESTNET_CHAIN_IDS`): it cannot be pointed at mainnet. Snapshots nest, so a search tries thousands of sequences
on one fork.

**The strategy library** (`strategies.js`), each reading the ABI and the fork and proposing attack plans:

- **access-control** — privileged-looking functions called by a stranger, alone and followed by a payout;
- **reentrancy** — a deposit, then a payout whose callback re-enters it 1..15 times (through the red team's
  `RedTeamAttacker` contract);
- **flash-price** — flash-borrow a token, swap it through the AMM pair the target prices from (moving the spot
  price), call the target with everything bought, swap back and repay — oracle/price manipulation;
- **signature-replay** — re-send a signed call seen in the target's history: as is, redirected to the attacker,
  or with a malleable `s`;
- **rounding** — one small amount many times in a transaction (rounding that burns 0 shares or pays 1 extra).

**The search** (`search.js`) is a seeded random walk over call sequences (EOA or through the attack contract,
with re-entry), mutated from a corpus of sequences that got further. Same seed, same fork, same result —
reproducible. Every working exploit is **minimized** to the fewest steps that still break the same thing.

**The optional LLM** (`agent.js`) asks a model (a local Ollama by default, or any provider configured through
`zetaphy-neuro/ai/providers.js`, needing an API key) for plans in a small JSON language. Every proposed plan is
checked against the ABI and **run on the fork like any other** — the model cannot decide an outcome, only
suggest. With no model configured, the deterministic strategies and the search run alone and nothing changes.

When the red team finds a working exploit it prints it and writes the **S1 submission bundle**, ready for
`zetaphy exploit submit`.

```
zetaphy redteam targets --certificate 0x<AuditCertificate>          # every contract with a valid certificate
zetaphy redteam scan    --target 0x… --source-rpc <testnet rpc> [--abi <artifact|file>] [--runs 300] [--out dir]
                        [--asset 0x… --min-loss <wei>] [--llm-model qwen2.5-coder:7b]
zetaphy redteam replay  --market 0x… --submission <id> --bundle bundle.json   # a runner recomputes the verdict
```

**The workflow** (`.github/workflows/red-team.yml`) is **off by default**: it runs the tests on a PR that
touches the red team, and a maintainer can run an attack sweep by hand (`workflow_dispatch`). The nightly cron is
commented out; a maintainer who wants it opts in. It only ever runs on local forks of demo targets.

### Demo targets and tests

`test/helpers/RedTeamDemo.sol` holds one deliberately vulnerable contract per bug class — and a `SafeBank` that
has none, so the red team must find **nothing** on it (no false positive). `test/redteam.test.js` runs each
strategy against its target, the full S1 loop end to end (list → red team builds the submission → submit →
runners replay and confirm → the submitter is paid), the search, and the LLM hook with a fake provider.
`scripts/redteam-sweep.js` is the standalone sweep the workflow runs.

---

## SS4 — Economic security

An audit covers code. It does not cover what a contract loses when the market around it is attacked. SS4
(`economic.js`) is an agent-based simulation of economic attacks against the **ZETAPHY DEX** (the real
`zetaphy-dex` Factory/Pair/Router contracts, run in the in-memory EVM), producing

> **max extractable loss under the scenario set S with seeds R ≤ X**

bit-for-bit reproducible: the same scenarios and seeds give the same report and the same number. The scenarios
each run on a fresh local chain per seed, with seeded noise traders moving the pool first:

- **sandwich** (MEV) — a victim swaps with a slippage limit; the attacker front-runs and back-runs it. The
  attacker's gain is bounded by the victim's own slippage limit (shown).
- **oracle-spot** — a lender that values collateral at the pair's **spot** price; the attacker flash-borrows,
  pumps the price in one transaction, borrows against the inflated collateral, dumps back. Loss = the lender's
  bad debt. *(Manipulable — the simulation shows a large loss.)*
- **oracle-twap** — the same lender reading the pair's **TWAP** over a window; the pump only counts for the
  blocks it is held. *(The simulation shows this defeats a single-block manipulation: loss 0.)*
- **liquidation-cascade** — borrowers near their threshold; an attacker shocks the price, liquidators sell
  seized collateral into the same pool and move it further. Loss = the bad debt left after the cascade.

The lender, the borrowers and the liquidators are agents in the simulation (there is no lending protocol in the
repo yet); every price they see and every trade they make is a **real call to the DEX contracts** on the fork.

The report binds the **code hashes** of the DEX contracts it simulated and the **scenario set + seeds**
(`scenariosHash`), so it is reproducible and tamper-evident. Its `keccak256` is the bound a sponsor attaches to
an audit request:

```
zetaphy econ sim [--scenarios scenarios.json --seeds 1,2,3] [--out econ-report.json]
zetaphy econ attach  --bounds 0x<EconomicBounds> --request <id> --report econ-report.json --fee 1
zetaphy econ commit  --bounds 0x… --id <request> --report econ-report.json   # a runner reruns and confirms; then reveal, settle
```

### `EconomicBounds` — attaching the bound to a certificate

`EconomicBounds.sol` is a **separate** contract: it does not change `AuditCertificate`'s behaviour. A request's
sponsor attaches `(reportHash, bound, scenariosHash)`. Three bonded NeuroJobs runners **rerun the simulation**
and confirm it with commit-reveal; the claim is confirmed when at least 2 of 3 reveal exactly the same
`(reportHash, bound)`. A reader asks `boundFor(chainId, target)`: the bound holds **only** while the target's
`AuditCertificate` holds and was issued for the request the bound was confirmed for. So a bound cannot outlive
the certificate it describes, and it cannot be moved onto other code. The confirming runners share the sponsor's
fee; otherwise it goes back. Pull payouts, no admin key.

---

## What this is and is not

- A confirmed exploit proves **that specific loss on that code and state** by replay. It is not proof the
  contract has no other bug.
- A max-extractable-loss bound is a statement about **the simulated scenarios and seeds only**. A real attacker
  has scenarios the set does not. Widen the set and the seeds for important code; the bound is a floor on what a
  defender should expect, not a ceiling on what an attacker can do.
- The red team finds **classes** of bugs its strategies and search cover. A clean red-team run is evidence, not
  a guarantee.
- Everything is testnet. No real money, no live chain, no key. The fork refuses any non-testnet chain by its
  chain id.

## Economics (defaults; every value bounded)

| Parameter | Default | Bounds |
|---|---|---|
| Exploit submit bond | 1 ZTPHY | (0, 100] ZTPHY |
| Runners' cut of an exploit reward (`runnerBps`) | 10% | 0..20% |
| Commit / reveal window (exploit) | 1 h each | 1 h .. 7 d |
| Unlist delay | 2×(commit+reveal) | ≥ 2×(commit+reveal), ≤ 90 d |
| Economic-bound runner quorum | 2 of 3 | fixed |
| Economic-bound commit / reveal window | 2 d each | fixed |

## What is missing

- **Not deployed.** `zetaphy deploy-redteam` deploys `ExploitMarket` (and `EconomicBounds` when the audit network
  and certificate addresses are given). The runner roles reuse the existing NeuroJobs bar.
- **No lending protocol in the repo yet**, so SS4's lender/borrower/liquidator are agents in the simulation, not
  on-chain contracts. When one lands, the scenarios point at it.
- **The on-chain pause** from S1 is a `PauseRequested` event plus the evidence; the actual trip goes through
  `CircuitBreaker`'s own quorum (self-healing.md). S1 cannot pause anything by itself.
- **Not audited.** These contracts have not been through the Open Audit Network, or any other process.
