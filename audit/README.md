# In-house audit pipeline

ภาษาไทย: [README.th.md](README.th.md)

An automated audit of our smart contracts and chain code, built only from free,
open-source tools and our own scripts. It runs the same kinds of machine checks
an audit firm runs before its people read the code (static analysis, formal
checks, fuzzing, mutation testing, dependency scanning) and turns them into one
report with a stable id for every finding and a record of every human decision.

**It is not an independent audit and does not replace one.** It finds known bug
patterns and keeps them from coming back; it does not understand what our
contracts are supposed to do. Before mainnet with real funds, SECURITY.md's
independent audit is still required. See [Limits](#limits).

The latest report: [REPORT.md](REPORT.md) (Thai summary: [REPORT.th.md](REPORT.th.md)).

## Tiers

| | Fast tier | Deep tier |
|---|---|---|
| When | every pull request that touches contracts, the chain patches, a lockfile, `*/audit/` or `audit/` | Sundays 02:37 UTC, and by hand (Actions → audit → Run workflow) |
| Time | ≤ 15 min (contracts and chain jobs run side by side) | ~1.5–2.5 h with budget `normal`; up to 6 h with `long` |
| Slither, Aderyn, Semgrep | yes | yes |
| solc SMTChecker | BMC engine, 4 core contracts, 5 min each | CHC engine, all 11 core contracts, 15 min each (`long`: 30) |
| Invariant suites (`*/audit/invariants/`) | forge smoke run (32 runs × depth 15) | forge 1000 × 100, halmos, medusa, echidna |
| Mutation testing | no | 5 core contracts, 15 mutants each (`long`: 40) |
| Neuro on our own bytecode | yes | yes |
| Go chain patches | gosec + `go test -race`, only when `zetaphy-chain/` changed | + staticcheck + govulncheck |
| npm audit (production deps) + OSV-Scanner | yes | yes |
| Fails the check | a **new** High/Critical finding not decided in `triage.yml` | never; it opens / updates a PR from branch `audit/report` |

Already elsewhere and not repeated: CodeQL covers the JS/TS web apps; `security.yml`
runs the chain's Go tests, fuzzing and gosec on every chain change, and cargo audit;
`zetaphy-chain-upstream.yml` runs govulncheck weekly.

## What is audited

[`scope.json`](scope.json) lists it: the Solidity in `zetaphy-network/contracts`,
`zetaphy-dex/contracts` (incl. `dlmm/`) and `zetaphy-nft/contracts`, compiled with
the same solc 0.8.26 and settings as the projects' own builds. Test helpers, mocks,
testnet faucet tokens and the deliberately vulnerable bug-bounty demo are excluded,
each with its reason (they are still compiled; their findings are not reported).
The "core" list names the money-holding contracts for the SMTChecker and mutation
testing.

The chain: `zetaphy-chain/setup-node.sh` carries our Go changes as patches. The
pipeline applies them to the pinned Cosmos EVM source exactly as CI and the
servers do, runs the Go tools on the result, and keeps only findings on lines
**our patches added** ([`tools/zetaphy-lines.js`](tools/zetaphy-lines.js)).

## Tools (all pinned)

| Tool | Version | What it does | Installed from |
|---|---|---|---|
| solc | 0.8.26 | compiler; SMTChecker (with z3 4.12) | GitHub release, SHA-256 checked |
| Slither (Trail of Bits) | 0.11.6 | ~100 static detectors | pip, `requirements.lock` (hashes) |
| Aderyn (Cyfrin) | 0.6.8 | AST static detectors | GitHub release, SHA-256 checked |
| Semgrep + Decurity rules | 1.183.0, rules `2e878a8` | patterns from real exploits | pip (hashes); rules at a fixed commit |
| Foundry (forge) | 1.2.3 | invariant / fuzz suites | GitHub release, SHA-256 checked |
| Halmos (a16z) | 0.3.3 | symbolic tests (`check_*`) | pip (hashes) |
| Medusa / Echidna (Trail of Bits) | 1.5.1 / 2.3.3 | property fuzzers | GitHub releases, SHA-256 checked |
| Mutation tester | ours | `tools/mutate.js` | this repository |
| staticcheck / gosec / govulncheck | 2026.1 / 2.22.8 / 1.1.4 | Go analysis, known Go vulns | `go install` (Go checksum database) |
| OSV-Scanner (Google) | 2.7.0 | known vulnerabilities in lockfiles | GitHub release, SHA-256 checked |
| npm audit | npm's | production npm dependencies | Node |
| Neuro | ours | our scanner reads our bytecode | `zetaphy-neuro/src` |

Versions and hashes live in [`tools/install.sh`](tools/install.sh) and
[`requirements.lock`](requirements.lock). To update a tool, change the version and
its hash in the same commit; expect new findings from new rules.

## Running it yourself

```sh
bash audit/tools/install.sh ~/.audit-tools fast   # prints PATH / LD_LIBRARY_PATH / SEMGREP_RULES lines
export PATH=~/.audit-tools/bin:~/.audit-tools/venv/bin:$PATH LD_LIBRARY_PATH=... SEMGREP_RULES=...
bash audit/run.sh --tier fast                      # writes audit/out/raw/ and audit/REPORT.md
node --test audit/test/*.test.js                   # tests of the pipeline itself
```

Options: `--tier fast|deep`, `--only slither,aderyn,...` / `--skip go,deps,...`
(steps: compile slither aderyn semgrep smtchecker invariants mutation neuro go deps),
`--out <dir>`, `--report <path>`. `OSV_OFFLINE_DB=<dir>` makes OSV-Scanner match against
OSV's downloadable database (kept in `<dir>`) instead of the api.osv.dev query API, for
networks that block the API. A tool that is not installed is recorded as
"not installed"; it never counts as passed. Mutation testing rewrites files in
place and restores them: run it on a clean tree.

**Another project's Solidity:** `audit/run.sh --target <dir> --tier fast --out <dir>`
finds the contracts by itself (skipping `node_modules`, `lib`, tests, mocks and
scripts; remappings from `remappings.txt` / `foundry.toml`), and writes
`<out>/REPORT.md`. The chain, SMTChecker core list and mutation steps are for this
repository only. `--commit <sha>` records which commit was audited.

**Machine-readable output:** `node audit/report.js --json <out>` prints one JSON object:

```json
{ "commit": "…",
  "codeHashes": { "ZetaphyPair": "0x<keccak-256 of the runtime bytecode>", "…": "…" },
  "findings": [ { "id": "slither:reentrancy-eth:zetaphy-dex/contracts/X.sol:0123456789ab", "tool": "slither",
                  "rule": "reentrancy-eth", "severity": "high", "file": "…", "line": 42, "title": "…",
                  "status": "open|fixed|false-positive|accepted" } ],
  "invariants": { "passed": 0, "failed": 0, "notRun": 3 },
  "mutationScore": 0.58 }
```

A contract name that occurs twice is keyed `path:Name`. `mutationScore` is null when
no mutation run is in the output.

## Invariant suites: where to put them

The pipeline runs whatever exists in `zetaphy-network/audit/invariants/`,
`zetaphy-dex/audit/invariants/` and `zetaphy-nft/audit/invariants/` (the list is in
`scope.json`). In each directory:

- `foundry.toml` → `forge test` runs `invariant_*` (stateful fuzzing) and `test*`
  functions; in the deep tier `halmos` proves every `check_*` function. The
  `foundry.toml` may also be the package's own, two levels up
  (`<package>/foundry.toml` with `test = "audit/invariants"`, `src = "contracts"`), as
  in the three packages here; forge then runs from the package root. Those configs
  set `offline = true`: `tools/install.sh` puts its SHA-256-checked solc 0.8.26 at
  `~/.svm/0.8.26/solc-0.8.26`, where forge looks for it.
- `medusa.json` → `medusa fuzz` with that config (its `targetContracts`), deep tier.
- `echidna.yaml` → `echidna` on every contract whose name contains `Echidna`, deep tier.
  (Both may sit in an `echidna/` subdirectory of the suite; they then run from the
  package root, as `zetaphy-network/audit/invariants/echidna/` expects.)

A missing directory, or one with none of these files, is "not run". A failed
property is a **High** finding (`<tool>:property-violated:<dir>:…`).

## Reading the report

1. **Summary**: counts by severity; "Open & new" means not yet in the baseline (below).
2. **Scope**: commit, files and lines audited, what is excluded and why.
3. **Methodology**: every tool, whether it ran, how long, which version.
4. **Findings**: Critical and High in full (id, place, the flagged line, tool, status);
   Medium as a table; Low and Info grouped by rule (each instance is in `findings.json`
   of the workflow artifact). Triaged ones show who decided and why.
5. **Formal checks**: what the SMTChecker proved, found, or could not finish.
6. **Coverage**: invariant suites, mutation score and the mutants no test caught
   (each one is a test worth writing).
7. **Neuro on our own bytecode**: what our scanner tells users about our contracts.
8. **Code hashes**: the runtime code each finding refers to; compare with `EXTCODEHASH`
   of a deployed contract.
9. **What this does NOT prove**, dated.

## Severity scale

| Severity | Meaning | Examples |
|---|---|---|
| **Critical** | funds can be stolen or frozen now, by anyone | a known critical CVE in a dependency on the money path |
| **High** | a likely path to loss, or a core guarantee broken | reentrancy into a payout, unchecked arbitrary call, a violated invariant, an SMTChecker assertion counterexample |
| **Medium** | loss under specific conditions, or a guarantee weakened | dangerous strict equality, divide before multiply, unused return value |
| **Low** | best practice / defence in depth | missing zero-address check, a revert inside a loop |
| **Info** | style, gas, notes | naming, literals, unproved SMTChecker targets |

Tool levels are mapped in [`lib/findings.js`](lib/findings.js): Slither and Semgrep
impact (High impact with *low* confidence becomes Medium), Aderyn high/low, gosec
severity × confidence, staticcheck `SA*` = Medium, govulncheck High only when the
vulnerable function is actually called, npm/OSV by advisory severity (CVSS ≥ 9
Critical, ≥ 7 High). Checked arithmetic overflows found by the SMTChecker are Low
(Solidity 0.8 reverts; at worst a stuck call).

## Triage

Every finding has an id `tool:rule:file:hash`, the hash covering the text of the
flagged line, so it survives code moving around but changes when that line changes.

**Only people edit [`triage.yml`](triage.yml).** The pipeline never writes it and
never marks anything by itself. For each finding someone has looked at:

```yaml
findings:
  - id: slither:reentrancy-eth:zetaphy-network/contracts/X.sol:0123456789ab
    status: false-positive        # fixed | false-positive | accepted-risk
    reason: "what in the code makes it safe (concrete: the modifier, the check, the line)"
    decided_by: pospos191         # who
    date: 2026-10-30
```

- **false-positive**: the tool is wrong about this code. Say why in terms another
  reviewer can check.
- **accepted-risk**: the issue is real but we keep it (a deliberate power, a
  documented trade-off). Say why and where users are told.
- **fixed**: fixed in code (name the commit and the regression test in the reason).
  Once the tool no longer reports it, the report lists it under "Fixed (no longer
  detected)", the record of the fix; if the tool still reports it, the report shows
  it open again ("marked fixed but still detected").

**In GitHub code scanning** (the SARIF upload): open findings of Medium and above are
alerts at their severity. Triaged ones (false-positive, accepted-risk, including those
pending owner confirmation) are uploaded too, with a SARIF `suppressions` entry (kind
`external`, status `accepted`, justification = the status, the reason and who decided),
so code scanning shows them as dismissed with that justification rather than as new
alerts; deleting the entry makes the alert open again on the next upload. A finding
marked fixed but still detected is an alert again (no suppression).

**Semgrep `basic-arithmetic-underflow`** (Decurity) flags any `a - b` where a function
parameter flows in. Solidity >= 0.8 reverts on underflow outside `unchecked { }`, so
there the result is a revert, not a wrap. `report.js` (`checkedArithmetic` in
`lib/findings.js`) therefore reports the rule as **Info** (in the report, not in code
scanning) when the file's pragma requires solc >= 0.8 (its lower bound is 0.8.x or
later) and the flagged line is outside every `unchecked` block; inside an `unchecked`
block, or in a file that allows solc < 0.8, it keeps the rule's severity (Medium) and
stays an alert. The rule is not switched off: a real wrap in unchecked code still
reaches the report and code scanning. (A revert on bad input can still matter, e.g.
a denial of service; that is what the other detectors and the reviews look at.)

The process: (1) read the finding and the code around it; (2) if it is real, fix it
in its own PR; (3) otherwise add an entry in a PR that a second person (or the owner)
reviews; (4) entries whose finding disappeared are listed in the report — delete them
(except `fixed` ones, which stay as the record of the fix).
The initial `triage.yml` holds only false positives verified by reading the code
during the pipeline's first run, each with its reason; the owner should confirm them.

**Pending owner confirmation.** An entry whose `decided_by` says "owner to confirm"
(or that has `pending: true`) is a provisional decision, proposed by a reviewer who
read the code. It has the same effect as a confirmed one everywhere it has an effect
(the PR gate, `--json`, SARIF), so the same finding is never blocking in one place
and decided in another; and it is labelled **PENDING OWNER CONFIRMATION** everywhere
it is shown: its own column in the REPORT summary, the finding's status line, the
Thai summary, and a `::warning::` of the gate with the count. The owner confirms by
writing their own name in `decided_by`, or rejects by deleting the entry (the
finding is open again, and blocks the gate if it is High/Critical and not in the
baseline).

**Baseline** ([`baseline.json`](baseline.json)): the open High/Critical findings a
person has already seen in a reviewed report. The PR gate fails only on High/Critical
findings that are neither triaged nor in the baseline, so an old finding does not
block unrelated work, and a new one cannot slip in. Baseline is **not** triage: those
findings stay "open" in every report until `triage.yml` decides them. The weekly PR
refreshes it; merging that PR is the acknowledgement.

**Weekly PR**: the deep run pushes `audit/REPORT.md`, `REPORT.th.md` and
`baseline.json` to branch `audit/report` (only that branch) and opens or updates
its PR. The repository needs Settings → Actions → General → "Allow GitHub Actions to
create and approve pull requests" for that step.

## Limits

- No finding is not "secure": tools know patterns, not our intent. Logic and
  economic bugs (pricing, incentives, flash-loan / oracle manipulation, MEV,
  governance capture) need people.
- The SMTChecker proves only what it reports as proved, in its time budget.
- Fuzzing and invariants check only the properties someone wrote down.
- Mutation testing samples a few dozen mutants per contract.
- Line coverage of the `node --test` suites is not measured: they run contracts on an
  in-process EVM that solidity-coverage / forge coverage cannot instrument. The
  mutation score is the measure of test strength instead.
- Deployment and operations are out of scope: keys, multisig/timelock settings,
  constructor arguments, front-ends, RPC.
- Only our chain patches are analysed, not Cosmos EVM / CometBFT / ibc-go.
- The tools have bugs and blind spots of their own.

## Files

| File | What |
|---|---|
| `run.sh` | runs the steps, writes `<out>/raw/` |
| `report.js` | merges raw outputs → REPORT.md, REPORT.th.md, findings.json, audit.sarif; `--json`; `--gate` |
| `lib/findings.js` | one parser per tool, severity mapping, finding ids |
| `lib/triage.js` | reads triage.yml, applies decisions |
| `lib/scope.js` | scope, import resolution, line counts |
| `tools/install.sh` | pinned tool installs |
| `tools/compile.js` | compile, runtime code hashes, artifact drift check |
| `tools/smtchecker.js` | SMTChecker runs with time / memory caps |
| `tools/invariants.sh` | runs the invariant suites |
| `tools/mutate.js` | mutation tester |
| `tools/neuro-dogfood.js` | Neuro on our bytecode |
| `tools/go-scan.sh`, `tools/zetaphy-lines.js` | the Go chain patches |
| `tools/merge.sh` | joins partial runs (CI's chain job) |
| `scope.json`, `triage.yml`, `baseline.json` | what is audited; human decisions; acknowledged open findings |
| `test/` | `node --test` tests of the pipeline |
