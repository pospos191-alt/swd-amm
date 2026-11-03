**English** | [ภาษาไทย](specs-and-proofs.th.md)

# Specs and proofs: the machine drafts the spec, a human approves it, provers prove it (testnet)

Testnet only (ZETAPHY testnet, chain 77390). Nothing here holds or pays real money, and none of it has been
audited by an outside firm. Part of the "SS tier" of the [open audit network](audit-network.md):

- **SS6**, *AI writes the spec, machines prove it*: `audit/spec/` reads a Solidity contract and drafts formal
  properties, a reviewer approves them, and the tool turns the approved spec into Halmos symbolic tests, solc
  SMTChecker targets and forge invariant tests and runs them with the pinned tools.
- **A3**, the **Proven** level: `ProofRegistry` records, per code hash, the approved spec, the proof artifacts,
  the tool versions and the recipe. A proof counts only when 2 of 3 bonded runners reproduce "all properties
  proven". A valid **Gold** certificate whose code is proven reads as **Proven**.
- **S9**, the **proof market**: a protocol posts properties with a bounty. A prover claims it with a proof
  (accepted as above) or with a counterexample (accepted by replaying it on-chain).

| Piece | Where |
|---|---|
| CLI: `draft`, `approve`, `gen`, `prove`, `hash`, `outcome` | `audit/spec/cli.js` |
| Solidity AST model (solc 0.8.26): writes, caller checks, external calls, locks, pause | `audit/spec/lib/analyze.js` |
| Deterministic heuristics (no AI) | `audit/spec/lib/heuristics.js` |
| Optional LLM step (only with `ANTHROPIC_API_KEY` and `--llm`), constrained JSON, screened | `audit/spec/lib/llm.js` |
| Spec format, expression language, spec hash, Markdown for review | `audit/spec/lib/spec.js` |
| Generators: Halmos `check_*`, forge invariants, SMTChecker wrapper, counterexample replay | `audit/spec/lib/gen.js` |
| Prover runner, `proof.json` / `PROOF.md` | `audit/spec/lib/prove.js` |
| Deliberately broken demo contract (test only) | `audit/spec/fixtures/BuggyVault.sol` |
| Specs, reviewer files and proof runs of the demos | `audit/spec/examples/` |
| `ProofRegistry` (Proven level, proof market) | `zetaphy-network/contracts/ProofRegistry.sol` |
| Commitments and tuples in JS | `zetaphy-network/src/proofs.js` |
| Tests | `audit/test/spec.test.js`, `zetaphy-network/test/proofs.test.js` |

## 1. The flow

```
contract.sol (+ docs)
  │  node audit/spec/cli.js draft X.sol --contract X [--docs d.md] [--llm] [--with review.json]
  ▼
X.spec.json + X.spec.md      every property "proposed": heuristics (always), LLM (optional), reviewer (--with)
  │  a human reads X.spec.md, then: approve --reviewer <name> --ids … | --all  [--reject …]
  ▼
approved spec, spec hash = keccak256(canonical JSON of target + harness + prover settings + approved properties)
  │  node audit/spec/cli.js prove X.spec.json
  ▼
work dir: test/Spec.t.sol (Halmos checks + forge invariants), smt/SpecSMT.sol, proof.json, PROOF.md
  │  prover commits, then submits (artifact hashes, tools, recipe) to ProofRegistry with the runners' fee
  ▼
3 NeuroJobs runners re-run `prove` on the same spec and code, commit, reveal → 2 of 3 agree "all proven"
  ▼
ProofRegistry: isProven(codeHash) · levelOf(chainId, target) = PROVEN on top of a valid Gold certificate
```

The spec hash covers exactly what is proven. If anyone edits the harness, a property or the prover settings
after approval, `gen` and `prove` refuse to run ("the spec changed after approval: approve it again").

## 2. Drafting a spec

### 2.1 Heuristics (deterministic, no AI)

`analyze.js` compiles the contract with solc (the pinned 0.8.26 binary, or solc-js from `zetaphy-network`) and
walks the AST. Internal calls, modifiers (code before and after `_`) and storage pointers
(`Route storage r = _use(...)`) are expanded. From that model it drafts:

| Pattern | Property drafted | Checked by |
|---|---|---|
| A state-changing function that reverts on `msg.sender != x` / `!m[msg.sender]` | **access**: every caller outside the set reverts, for all arguments and any ETH | Halmos |
| A uint only ever increased (`+=`, `++`) | **monotonic**: it never decreases | Halmos |
| A `mapping(address => uint)` and a uint total written together (token `balanceOf`/`totalSupply`, vault deposits) | **conservation**: each call moves the total by exactly the sum of the balance changes of the accounts it touches | Halmos |
| A uint increased in a payable function and decreased where ETH leaves | **backing** (supply ≤ backing): `address(t).balance >= t.x()` after any sequence of calls | Halmos, SMTChecker (CHC), forge |
| A `paused` flag | **pause-noloss**: pause and unpause change no balance and no public state except the flag; **paused-blocks**: functions that check the flag revert | Halmos |
| A function that calls out | **cei**: no storage write after the first external call, unless a real reentrancy lock guards it | the AST check |

Things that are not properties go to "Notes for the reviewer", for example a state-changing function nobody
guards. Every guess is a draft. On BuggyVault the heuristics guessed that `deposits` (a counter) sums the
balances. The reviewer rejected that guess. Had it been approved, the prover would have refuted it.

The AST model knows the difference between a reentrancy lock and accounting that happens to be named
`locked`. A lock is a variable read in a revert condition and only ever *assigned* (set on entry, reset on
exit), so `locked -= amount` in HyperlaneLockBoxV2 is accounting.

### 2.2 The optional LLM step

`draft --llm` calls the model only when `ANTHROPIC_API_KEY` is set (default `claude-opus-5-5`, overridden with
`ZETAPHY_SPEC_MODEL`). Without the key, the draft is the heuristics alone and nothing fails. The model must
answer in a JSON schema (`output_config.format`) and may add only three kinds:

- `invariant`: `expr` holds after setup and after every call in a sequence;
- `post`: after a successful call to one of `functions`, `expr` holds, where `old(e)` is the value of e before the call;
- `reverts`: a call reverts whenever `when` holds.

Every proposal goes through `screen()`, the same validator a reviewer's properties go through. An expression is a
Solidity boolean over `t.<view>(…)` (only views the target really has), `h.<view>(…)` (views the harness
declares), `address(t).balance`, literals, units and operators. Statements, semicolons, braces, cheatcodes
(`vm`), `call`, `assembly`, `new`, `this`, `msg` and state-changing functions are refused. Accepted proposals
enter as `proposed` with confidence `low`. Refused ones are listed in the Markdown with the reason. Nothing
the model says is proven until a prover proves it.

### 2.3 The harness, and the reviewer's file

Halmos needs a deployed instance. The draft writes one when the constructor only takes plain values (constant
addresses, plausible numbers). When it needs other contracts (a Mailbox, an ISM, an airlock), the harness is
marked `needs-review`. A reviewer then writes a `--with` file: harness code (helpers, state, setup, actors, custom
actions, harness views, sequence steps), prover settings and extra properties. The file is part of the approved
spec and of its hash. See `audit/spec/examples/review/HyperlaneLockBoxV2.review.json` and
`BridgeGuard.review.json`.

## 3. Proving

`node audit/spec/cli.js prove X.spec.json [--tools halmos,forge,smtchecker] [--code <deployed runtime hex>]`
generates the artifacts into `<spec dir>/X.proof/` and runs:

- **Halmos 0.3.3**: one `check_*` per property and function. Every input is a word of one `uint256[N] w`
  parameter, so it is fully symbolic. A pass is a proof for **all inputs within the stated scope**. The scope is
  printed per property, for example "every sequence of 3 calls over lock, handle, claim, … from the setup
  state". Sequences are bounded by `prover.depth`. The generated code has no loops for the prover to cut. A check
  whose loops were cut anyway (`num_bounded_loops > 0`) is `unknown`, not proven.
- **solc SMTChecker (CHC)**: state invariants that only read the target's own state are compiled as
  `assert`s into a subclass of the target. When CHC proves them, they hold in **every reachable state
  (unbounded)**. "Might happen" (not proved in time) is `unknown`.
- **forge 1.2.3**: the same invariants under the stateful fuzzer. This is evidence, never a proof:
  `fuzz-passed`.
- **The AST check** for `cei`.

**Counterexamples are replayed.** Each Halmos model is written back as a concrete forge test
(`test/SpecReplay.t.sol`) that calls the failed check with those exact inputs and must hit the same failed
`assert` (Panic 0x01) in a real EVM run. `PROOF.md` prints the counterexample as calls ("deposit(value …) by
0xA11CE, then emergencyWithdraw() by 0xA11CE").

**Honesty rules**: a property is `proven` only when a prover proved it (every Halmos check of it, or CHC, or
the AST check) and no tool found a counterexample. A tool that is not installed is `not-installed`. A run that
timed out or crashed is `unknown`. Neither ever counts as proven, and the exit code is 0 only when every approved
property is proven (1: a counterexample, 2: otherwise). Spec expressions are asserted inside `unchecked`, so a
wrong expression fails as an assertion instead of an arithmetic panic that Halmos would skip.

`proof.json` holds the spec hash, the source hash, the runtime code hash (keccak of the compiled runtime with
immutables zeroed; `--code` compares it with a deployed contract after masking its immutables), the tool
versions, the artifact hashes, the recipe, per-property results and a **result hash**. The result hash is the
keccak of the canonical result: statuses only, with no timings, logs or solver models. So two honest runners
get the same hash.

## 4. Results on this repository (2026-11-03, forge 1.2.3, halmos 0.3.3, solc 0.8.26)

Each row is a real run; `audit/spec/examples/<Name>.proof.json` and `<Name>.PROOF.md` hold the full results,
the spec next to them is what was approved.

| Contract | Spec | Result | Halmos time |
|---|---|---|---|
| `BuggyVault` (test-only, 2 planted bugs) | 11 drafted by the heuristics, 1 rejected by the reviewer (`deposits` is a counter, not a sum), 10 approved | **7 proven, 3 counterexamples**: `backing-totalDeposits` (Halmos, replayed in forge; forge's fuzzer; SMTChecker CHC), `conservation-balanceOf-totalDeposits` (Halmos on `emergencyWithdraw`, replayed), `cei-withdraw` (the AST check: `balanceOf`, `totalDeposits` written after the call). Halmos's trace for BUG 1: `deposit(value 39614081257132168796771975168) by 0xA11CE`, then `emergencyWithdraw() by 0xA11CE` | 22 s |
| `BridgedToken` (in `BridgeGuard.sol`) | 3 drafted, all approved; harness drafted by the tool, no review needed | **3 of 3 proven**: only the guard mints / burns; every mint, burn, transfer and transferFrom moves `totalSupply` by exactly the balance changes it makes | 34 s |
| `HyperlaneLockBoxV2` | 20 drafted + 3 by the reviewer; harness reviewed (MockMailbox, an ISM that accepts **every** message, 5 ETH locked at setup) | **23 of 23 proven**, including the backing rule `locked-never-below-releases` (any sequence of 2 calls over lock / any release message / claim / pause / veto: paid ≤ locked, and `locked` = locked − paid), `backing-locked` (ETH ≥ `locked`), `daily-limit`, `claim-pays-from-locked`, access control of all 12 guarded functions, `nonce` / `received` monotonic, pause loses nothing. The SMTChecker did **not** finish `backing-locked` in 300 s (`timeout`), so that proof is Halmos's bounded one; forge fuzzing found nothing | 114 s |
| `BridgeGuard` | 21 drafted + 5 by the reviewer (limits); harness reviewed (airlock and ThreatRegistry stand-ins, routes IN 600/day and OUT 400/day under the 1000 cap) | **26 of 26 proven**: no inbound / releaseHeld takes the day over the hard cap, no outbound either, per-route limits in both directions, one inbound mints at most the route's limit, 14 access properties, pause loses nothing, pause stops inbound / releaseHeld / outbound, checks-effects-interactions | 111 s |

**Vacuity check.** A proof of "after every successful X, P" is empty if X can never succeed. For every
post-condition, a copy of the spec with a deliberately false one (`false` after X) was run. Each must get a
counterexample, which shows X can succeed. The first BridgeGuard harness had no threat registry, so `releaseHeld`
could never succeed and its `cap-in` check was empty. The check caught this, and the harness now queues a held
mint and has an `unhold` step. After the fix, every call the post-conditions name (inbound, outbound,
releaseHeld, lock, handle, claim) was shown reachable.

**What did not work first time** (kept as evidence that the honesty rules hold): a Halmos run on HyperlaneLockBoxV2
with depth 3 did not finish in 30 minutes (so the spec uses depth 2 with 5 ETH locked at setup), and a run on a
stale build cache made Halmos skip every contract. Both came out as `unknown` (21 of 23 "unknown", 2 proven by
the AST check), never as proven. `prove` now always starts from a clean build.

## 5. ProofRegistry: the Proven level (A3)

`zetaphy-network/contracts/ProofRegistry.sol`, additive: AuditCertificate is not changed.

1. **Commit, then submit.** The prover commits `keccak256("zetaphy.proof.submit", codeHash, specHash,
   artifactsHash, prover, salt)`, then submits from a later block: code hash (EXTCODEHASH), spec hash, source
   hash, number of approved properties, artifact hashes (at most 32), tool versions, recipe URI and recipe hash,
   plus the runners' fee (at least `minFee`). The commitment binds the artifacts to the prover, so a copied proof
   cannot be claimed first.
2. **Three runners** (NeuroJobs workers: bonded, active, no unbond requested, at least `minAgreed` agreed jobs,
   not more rejected than agreed, and not the prover) each run `prove` on the same spec and code. Each commits
   `keccak256("zetaphy.proof.run", keccak256(abi.encode(outcome)), runner, salt, id)` during the commit window
   and reveals in the reveal window. outcome = (resultHash, proven, counterexamples, unknown).
3. **settle**: the proof is accepted only when at least 2 of the 3 seats revealed the **same** outcome, with
   `proven == properties`, no counterexample and nothing unknown (so nothing was "not installed"), and the spec was
   never refuted for that code. The agreeing runners share the fee. With no agreement the fee goes back to the
   prover. Every runner is reported to WorkerReputation (agreed, disagreed or missed).
4. **Reads**: `isProven(codeHash)`, `isProvenSpec(codeHash, specHash)`, `proof(id)`, `artifactsOf`, `toolsOf`,
   `recipeOf`. `levelOf(chainId, target)` returns AuditCertificate's level of the valid certificate (0 when
   there is none) and **PROVEN (4)** when it is a valid Gold certificate whose code hash is proven. Expiry,
   revocation and a code change all go through AuditCertificate's own `certificate()` validity.

## 6. The proof market (S9)

- `postBounty(codeHash, specHash, properties, deadline, checker, specUri)` with the bounty as value. The
  deadline must leave room to verify a proof (at least the commit plus reveal windows) and be at most a year away.
- **Claim by proof**: submit with `bountyId`. One proof is verified per bounty at a time (`Busy` otherwise). The
  accepted proof's prover is paid.
- **Claim by counterexample**: commit `keccak256("zetaphy.proof.cex", bountyId, property, keccak(cex),
  claimant, salt)`, then reveal from a later block. The bounty's **checker** contract replays it on-chain: it
  deploys the bountied code afresh, runs the calls, evaluates the property and reverts everything it did. The
  registry records the payout first (effects), then asks the checker. If the checker does not confirm, the whole
  claim reverts. A confirmed counterexample **refutes** the spec for that code for good: no earlier or later
  proof of it counts. A copied reveal is worthless, because the commitment names the claimant.
- Unclaimed after the deadline (and with no proof being verified), the poster takes the bounty back.
- Every payout is pulled: `withdraw(to)` to the caller or to the payout address it set (`setPayout`).

The checker is the poster's code, published with the spec. A dishonest poster can deploy a checker that never
confirms. Provers should read it before working (the test kit's `BuggyVaultChecker` shows the pattern). A
checker that re-enters the market finds the bounty already closed.

Governance is the ZetaphyTimelock. It sets only the windows (commit 1 h..30 d, reveal 1 h..7 d), `minFee`
(≤ 1000 ZETA) and `minAgreed` (≤ 10000), and can hand governance on. There is no admin key, no pause and no way
to move anyone's money.

## 7. What is real and what is a prototype

| | |
|---|---|
| Heuristics, AST model, spec format, approval and hashing, generators, prover runner, counterexample replay | **real**, run on three contracts of this repository and the demo (section 4) |
| The LLM step | **real code, not exercised here**: no API key in this environment. Its screen and the request shape are tested with a stand-in HTTP response |
| ProofRegistry | **tested** on the in-memory EVM (`test/proofs.test.js`, outcomes taken from the committed proof runs); **not deployed** |
| Runner job ("re-run `prove`, commit, reveal") | the commitments are in `src/proofs.js`; there is **no daemon** yet that picks up proof requests like `zetaphy audit run` does |
| On-chain counterexample checkers | written **by hand** per bounty (the test kit has one for BuggyVault); not generated from the spec yet |
| Proof scope | Halmos proofs are **bounded** to sequences of `prover.depth` calls from the harness's setup state. Only CHC gives unbounded state invariants, and it often cannot finish on contracts that call unknown code |

## 8. Limits

- A proof is about **the spec**. A wrong or weak property that is proven proves nothing useful. Read the spec,
  its harness and each property's scope.
- The harness is part of what is proven: mocks (an ISM that accepts everything, an airlock stand-in) are
  assumptions. They are written in the spec and hashed with it.
- Halmos models some things abstractly (for example `ecrecover`), and sequence depth is a bound, not an induction.
- The heuristics read patterns, not intent. They miss properties that no pattern names, and some of their
  guesses are wrong (section 2.1). That is why a human approves.

## 9. Reproduce

```sh
bash audit/tools/install.sh ~/.audit-tools fast        # forge 1.2.3, halmos 0.3.3, solc 0.8.26 (+ z3 4.12), all hashed
export PATH=~/.audit-tools/bin:~/.audit-tools/venv/bin:$PATH LD_LIBRARY_PATH=<from install.sh>
node audit/spec/cli.js prove audit/spec/examples/BuggyVault.spec.json           # 2 bugs refuted, the rest proven
node audit/spec/cli.js prove audit/spec/examples/HyperlaneLockBoxV2.spec.json
node --test audit/test/spec.test.js
cd zetaphy-network && node --test test/proofs.test.js
```
