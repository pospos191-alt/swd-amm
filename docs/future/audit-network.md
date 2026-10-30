**English** | [ภาษาไทย](audit-network.th.md)

# Open audit network: anyone audits, anyone gets audited, certificates bound to code

Testnet only. Nothing here holds or pays real money, and none of it has been audited by an outside firm.

ZETAPHY runs an **open audit platform**. Anyone can ask for an audit of a contract: one of ZETAPHY's own,
or a contract on another chain that Neuro reads. Anyone who posts a bond can audit. A bonded judging committee
decides every finding. Three runners run the automated tools on the exact code. Code that passes **all** of it
gets an on-chain certificate, and the certificate is bound to that code's hash. ZETAPHY audits other projects
and other projects audit ZETAPHY under the same rules. No owner key controls it: governance is the
`ZetaphyTimelock`, and every parameter has hard bounds.

| Piece | Where |
|---|---|
| Requests, auditor bonds, reports, findings, bounty money | `zetaphy-network/contracts/AuditNetwork.sol` |
| Automated tier: 3 runners, commit-reveal, 2 of 3 must agree | `zetaphy-network/contracts/AuditRunners.sol` |
| Judging committee, votes, appeals, judges' pay | `zetaphy-network/contracts/AuditJudges.sol` |
| Certificates: issue, expire, revoke, `isCertified`, cross-chain message | `zetaphy-network/contracts/AuditCertificate.sol` |
| Broadcast to other chains (message kind 3) | `NeuroOracleSender.pushCertificate` / `NeuroOracle.isCertified` in `NeuroOracle.sol` |
| Shared logic: tuples, commitments, pipeline adapter, canonical result | `zetaphy-hub/audit-core.js` (used by both the hub and the CLI) |
| Runner job, Sourcify, Neuro, optional LLM | `zetaphy-network/src/auditnet.js` |
| CLI `zetaphy audit …`, `zetaphy deploy-audit` | `zetaphy-network/src/auditnetcli.js`, `src/auditnetops.js` |
| Hub "Audit" tab (8 languages) | `zetaphy-hub/audit.js`, `audit-i18n.js` |
| Explorer certificate badge (8 languages) | `zetaphy-explorer/src/audit.js` |
| Orders from any chain (EVM, CosmWasm, Solana), badge, check page, directory, GitHub Action | [audit-as-a-service.md](audit-as-a-service.md) |
| Tests | `zetaphy-network/test/auditnet.test.js` (strictness and abuse), `test/auditnet-e2e.test.js` (end to end through the CLI); `zetaphy-hub/test/audit.test.mjs`, `audit.e2e.mjs`; `zetaphy-explorer/test/unit.test.js`, `explorer.e2e.js` |

## The flow

```
sponsor ── request(target{chainId, address, codeHash, sourceHash}, tier, contest, minAuditors, fixes?) + deposit
             │   deposit = pool (bounty) + fee (feeBps); fee → runners (runnerBps) + judges (the rest)
             │   on ZETAPHY: codeHash must equal EXTCODEHASH(address) right now
             ▼
 contest window (≥ minContest + 1 week per tier)
   auditors (bonded):  commitReport(hash)   commitFinding(hash of {finding, severity, PoC hash, auditor, salt, request})
   runners (NeuroJobs record): commit(hash of {resultHash, critical+high, invariants failed, not run, mutation})
             ▼
 reveal window:  revealReport · revealFinding · runners reveal  →  AuditRunners.settle (2 of 3 agree)
             ▼
 judging window: judges vote each finding (valid + severity + duplicate group | invalid),
                 reports (accept | reject), "invariants n/a" (accept | not), carried fixes (fixed | not)
             ▼
 appeal window:  anyone appeals a decision (bond) → governance (timelock) decides, or after appealTimeout it stands
             ▼
 settle → payouts (pull) → AuditCertificate.certify(request) — only if EVERY rule below holds
             ▼
 certificate (Bronze / Silver / Gold), expires after `validity`; post-certificate findings stay open until then;
 a valid critical/high one revokes it at once
```

A **fix is a new request**: new code is a new codeHash. The new request names the request it fixes (`prev`), and
every valid critical/high finding of the old version (and any carried finding the old version never got
confirmed) is **carried**. The judges must confirm each carried finding fixed on the new version. The new
version goes through the whole process again: contest, automated tier, judging and appeals.

## What a certificate requires, exactly

`AuditCertificate.certify(id)` succeeds only if `check(id) == 0`, which means **all** of these hold. Otherwise it
reverts with `NotCertifiable(reason)`, and the hub and the CLI name the reason.

1. **Settled**: the contest, reveal, judging and appeal windows are over, no appeal is open, and `settle` ran.
2. **Automated tier agreed**: at least 2 of the 3 runner seats revealed the *same* tuple, and that tuple has
   **zero open critical/high findings**. An "accepted" critical/high still counts as open. Only `fixed` or
   `false-positive` triage removes one.
3. **Invariants**: no invariant suite failed. Either every suite ran, or the sponsor declared them "not
   applicable" (`declareNotApplicable`, with a reason hash) and the judges **accepted** that by quorum.
4. **Contest**: it ran at least its minimum (the governance `minContest` at request time, plus a week per scope
   tier, and never under 3 days). At least `minAuditors` distinct bonded auditors revealed a participation
   report that the judges did not reject.
5. **Findings**: no valid critical/high finding, and no revealed finding left undecided. Every carried
   critical/high finding of the version it fixes must be confirmed fixed.
6. **Code and money**: on ZETAPHY the address still has exactly the audited code (EXTCODEHASH). That code
   hash was never revoked. The sponsor has not taken back the reserve that funds the post-certificate bounty.

**Levels**: Gold needs ≥ `goldAuditors` auditors, a contest of ≥ `goldContest` and a mutation score ≥
`goldMutationBps`. Silver uses the silver thresholds. Anything else that passes is Bronze. Defaults: Silver = 5
auditors, 14 days, 70%. Gold = 8 auditors, 21 days, 85%.

**Validity**: a certificate expires after `validity` (default 180 days, bounded to 30..365). `isCertified(chainId,
address)` is false when any of these is true:
- the certificate expired;
- it was revoked;
- its code hash was revoked anywhere;
- on ZETAPHY, the address's **current** EXTCODEHASH differs from the certified one.

So a redeploy, replaced code or a self-destruct makes it fail at once. For EIP-1967 proxies, see "Proxy
upgrades" under the threat model: certify the implementation, and check it too.
`certificate(chainId, address)` returns the record (request, code hash, report hash, source hash, level,
auditors, mutation score, issued, expires, revoked) and whether it holds now.

**Revocation**: post-certificate findings can be filed until the certificate expires. They use the same
commit and reveal, except the reveal must come from the next block on. The same judges decide them. When one is
judged valid with critical or high severity, `AuditNetwork` calls `AuditCertificate.revokeFor`. The certificate
is revoked and **the code hash is revoked everywhere**, so the same code can never be certified again. A later
appeal that overturns the finding does not un-revoke it, by design: a fix gets a new certificate through a new
request.

## What a certificate means, and what it does not

A certificate says: **"this exact code (code hash X) passed the ZETAPHY open audit process on date Y"**. On that
date it held all of the following:
- the automated tools found no open critical/high issue;
- the invariant suites passed, or "not applicable" was accepted;
- at least M bonded auditors looked at it in a public contest of at least N days;
- every finding was judged, with an appeal window, and none of critical/high severity stood.

It is **not** a guarantee that the code is safe, a statement about the team, the economics, the oracle feeds or
the admin keys around the contract, or any kind of insurance. Auditors miss bugs. Tools have blind spots. A
small or careless set of judges can be wrong. A certificate covers **code only, and only that code hash**: a
proxy's certificate says nothing about a future implementation. The hub, the explorer and the CLI say this next
to every certificate.

## Strictness rules (and the tests that check them)

| Rule | Where it is enforced | Test (`zetaphy-network/test/auditnet.test.js`) |
|---|---|---|
| Nobody can copy a finding before the reveal. Commitments are hashes bound to the auditor and the request. All contest reveals happen after the contest closed. | `commitFinding` / `revealFinding` | "copying a finding is impossible before the reveal…" |
| No certificate while any valid high is open. A fix is a new code hash through the whole process, with every carried finding confirmed fixed. | `AuditCertificate.check` R_CRIT_HIGH, R_FIX_UNCONFIRMED | "refused while any valid high finding is open…" |
| Too few auditors, a window that is too short, or an appeal window not yet over: refused. | `request` (bounds), `settle`, `check` | "refused with too few auditors…" |
| The automated tier must agree, with 0 open critical/high, 0 failed suites, and n/a only if accepted. | `AuditRunners.settle`, `check` | "the automated tier must agree…" |
| Revoked by a later valid critical. That code can never be certified again. | `decide` → `revokeFor` | "revoked at once by a later valid critical finding…" |
| Invalid after the code hash changes (proxy upgrade simulation). | `isCertified` checks EXTCODEHASH | "invalid at once when the code at the address changes…" |
| Bond slashing: invalid findings and rejected reports are escrowed until appeals end. A winning appeal restores the bond. | `_slash`, `claimSlash`, `resolveAppeal` | "bond slashing…" |
| Judge collusion is bounded by the quorum. Conflicts, double votes and outsiders are refused. | `AuditJudges.quorum`, `_cast` | "judge collusion is bounded by the quorum…" |
| Replay: no second reveal, no second certification, no reuse of a commitment on another request, no second claim. | commitments include the request id; flags | several tests |
| Reentrancy on payouts: pull payments only, behind a lock. | `nonReentrant` on every ETH-sending function | "reentrancy on payouts…" |
| Expiry. | `validity` | "happy path…" |
| Only governance changes parameters, and every parameter is bounded. | `_setParams`, `_setLevels` | "governance is the timelock only…" |

The end-to-end test (`test/auditnet-e2e.test.js`) runs the whole story on a chain with signed transactions,
through the CLI's command paths. It covers:
1. deploy, with the timelock as governance;
2. a request, then three runners running the pipeline adapter on the fixture and Neuro's code-only scan;
3. a contest, then a valid high, then a refused certification;
4. the fix as a new version, with the judges confirming the fix, then the certificate;
5. the explorer's badge reader and the hub's decoder reading that certificate.

## The automated tier: pipeline, Neuro, AI

Runners are the existing bonded NeuroJobs runners, with the bar BugBounty and ThreatRegistry use: active, at
least `minAgreed` accepted verdicts, and no more rejected than accepted. `zetaphy audit run <id>` does five
things:

1. It fetches the target's runtime code and checks keccak256(code) against the request's code hash. It also
   fetches the verified source from **Sourcify** when it has one (free, no key); otherwise the repo commit is
   what the pipeline audits.
2. It runs the **pipeline adapter**: `node audit/report.js --json <outdir>`. That pipeline is Slither, Aderyn,
   Semgrep, SMTChecker, Echidna/Medusa, Halmos, mutation testing and `triage.yml`, maintained under `audit/` at
   the repo root. The adapter expects exactly:
   ```
   { commit, codeHashes: {contract: 0x…}, findings: [{id, tool, rule, severity: critical|high|medium|low|info,
     file, line, title, status: open|fixed|false-positive|accepted}], invariants: {passed, failed, notRun}, mutationScore }
   ```
   Anything malformed is refused (`validatePipeline`). A runner never hashes a half-read report. Until
   `audit/report.js` lands, `--pipeline <file>` takes the JSON directly; the contract between the two is
   `zetaphy-network/test/fixtures/audit-report.json`.
3. It runs **Neuro's rules** on the exact code, the same free code-only scan as a useful-work job. Neuro's
   findings join the result as `neuro:<rule>` (trade-simulation findings are left out, as in verdicts). A
   pipeline entry with the same id (for example, triaged in `triage.yml`) decides its status.
4. It builds the **canonical result** (sorted keys and findings; titles and run-specific text left out) and
   hashes it. It then commits `(resultHash, critical+high, invariants failed, not run, mutation bps)` and
   reveals after the contest.
5. **Optional LLM review**: only when the runner's owner configures a model (`--llm-model`, a local Ollama by
   default, free). The AI findings are saved next to the result as **advisory**, and they are **never part of
   the hash**, because two honest runners must get the same hash. An auditor may submit them as ordinary
   findings, which the judges decide like any other. AI alone can never certify or fail a contract.

## Economics (defaults; every value has hard bounds)

| Parameter | Default | Bounds |
|---|---|---|
| Fee share of the deposit (`feeBps`) | 10% | 1%..30% |
| Runners' share of the fee (`runnerBps`) | 50% (the judges get the rest) | 20%..80% |
| Participation share of the pool (`participationBps`) | 10%, split among accepted revealed reports | 0..20% |
| Finding weights | info 0, low 1, medium 3, high 10, critical 30; duplicates split their group | fixed |
| Auditor bond / slash per invalid finding or rejected report | 10 ZTPHY / 20% of the bond requirement | (0, 1000] / 5%..50% |
| Judge bond / reputation needed / quorum | 100 ZTPHY / score 500 / 3 and a majority of active judges | quorum ≥ 3 |
| Appeal bond / appeal window / governance timeout | 10 ZTPHY / 5 days / 14 days | / 2..30 d / 7..90 d |
| Contest minimum / per tier | 7 days / +7 days per tier | ≥ 3 days |
| Certificate validity | 180 days | 30..365 days |
| Post-certificate bounty | what is left of the pool. Critical takes all of it, high half, medium 10%, low 2% | fixed |

Money moves like this:
- valid findings are paid from the pool, by weight;
- slashes of contest findings and rejected reports go to the sponsor (after appeals), and post-certificate
  slashes go to the treasury;
- a lost appeal's bond goes to the treasury; a won or expired appeal's bond goes back;
- the sponsor takes the reserve back once the certificate has expired, or at once if it was never certified.

All payments are pulled (`withdraw`). Outcomes feed `WorkerReputation`: valid findings count as `bugValid`,
invalid ones as `bugInvalid`, rejected reports as `slashed`, and runner seats as agreed, disagreed or missed.
Those scores gate who can become a judge.

## Threat model

- **Copying findings / front-running**: commit and reveal, with the commitment bound to the auditor and the
  request. Contest reveals open only after the contest closes. A post-certificate finding reveals from the next
  block on, and only the original of a duplicate group is paid.
- **Spam findings**: each auditor has a capped number of findings per request, and every invalid finding
  slashes the bond.
- **Sybil auditors padding `minAuditors`**: each one needs a bond, and the judges can reject an empty or
  plagiarised report, which slashes the bond and stops it from counting. *Limit*: a well-funded sponsor can
  still pay for bonded sock puppets that write plausible reports. The judges are the defence; raise
  `minAuditors` and the bond for important code.
- **Colluding judges**: a decision needs `max(judgeQuorum, majority of active judges)` identical votes.
  Judges must have a reputation record, cannot vote on requests they sponsored or audited, and are bonded.
  Governance can remove or slash a judge. Any decision can be appealed to governance. *Limit*: a majority of
  the committee colluding can decide wrongly until governance acts. Keep the committee large and diverse.
- **Colluding runners**: 2 of 3 must agree, the runners are bonded NeuroJobs runners with a track record, and
  the result is reproducible by anyone from the published canonical JSON. *Limit*: 2 colluding runners can post
  a clean result. The human contest and the judges are the second layer, and both are required.
- **Bait and switch** (certify one code, run another): the certificate binds to the code hash, and
  `isCertified` re-checks EXTCODEHASH on every call on ZETAPHY. On other chains the code hash is recorded, and
  the NeuroOracle mirror re-checks EXTCODEHASH on its own chain.
- **Proxy upgrades**: when a contract's code is replaced at the same address (a redeploy, or code changed
  under the address), the EXTCODEHASH check catches it at once (tested). An EIP-1967 proxy is different: its own
  bytecode never changes; its implementation does. A contract cannot read another contract's storage, so
  `isCertified(proxy)` alone cannot see an upgrade. Two things cover it:
  - **certify the implementation** (and the proxy, if you want);
  - **readers check both**. The explorer's badge reads the EIP-1967 implementation slot and holds only while
    the proxy *and* its current implementation are certified (tested).

  On-chain integrators must do the same: call `isCertified(implementation)`.
- **Reentrancy and griefing on payouts**: pull payments only, behind a reentrancy lock, and the CEI pattern
  throughout.
- **Governance abuse**: the timelock delays every change, every parameter has bounds (for example, a quorum
  below 3 or a contest under 3 days is impossible), and governance cannot move bounty money except through
  appeal outcomes.

## Cross-chain

A certificate for a contract on another chain is recorded with that chain's id and the keccak256 of its runtime
bytecode (supplied at request time; runners check it against the chain via Neuro's RPCs).
`NeuroOracleSender.pushCertificate(domain, chainId, address)` sends `AuditCertificate.certificateBody` (message
kind 3) over the existing Hyperlane route. `NeuroOracle` there stores the newest certificate, applies a
revocation, and refuses to roll back to an older message. `NeuroOracle.isCertified(chainId, address)` on that
chain re-checks EXTCODEHASH locally. **Enabling it on already-deployed oracles needs a redeploy** of the sender
and receiver (the contracts gained `setAudit` / `pushCertificate` / kind 3), then `setAudit(AuditCertificate)`
through the timelock.

## Using it

```
zetaphy deploy-audit --timelock 0x… --treasury 0x… --jobs 0x<NeuroJobs> [--reputation 0x<WorkerReputation>]
zetaphy audit request 77390 0x<contract> --source <git commit> --days 7 --auditors 3 --pool 100
zetaphy audit bond --amount 10 && zetaphy audit commit-report <id> --report report.md
zetaphy audit submit <id> --finding bug.md --severity high --poc Exploit.t.sol     # after the contest: zetaphy audit reveal <findingId>
zetaphy audit run <id> [--repo . --llm-model qwen2.5-coder:7b]                       # runners; later: --reveal
zetaphy audit judge-bond && zetaphy audit judge <findingId> --valid --severity high [--dup <findingId>]
zetaphy audit settle <id> && zetaphy audit certify <id> && zetaphy audit cert 77390 0x<contract>
```

The hub's **Audit** tab offers the same in a browser:
- browse requests and their findings, and see why a request is (or is not) certifiable;
- ask for an audit;
- as an auditor: post a bond, commit findings (the salt stays in the browser until the reveal; the PoC file is
  hashed locally and never uploaded) and reveal them;
- as a judge: vote and appeal;
- look up a certificate.

The **explorer** shows a badge ("Audited (ZETAPHY) · Gold · until …") on the address and token pages when
`auditCertificate` is set in its config.

## What is missing

- **Not deployed**: `zetaphy deploy-audit` writes `zetaphy-network/deployments/audit-77390.json`, and the hub
  picks it up from there. The reporter roles in WorkerReputation are timelock proposals that the deploy prints.
- **`audit/report.js`** is built separately. The adapter and its fixture define the interface; the end-to-end
  test uses the fixture.
- **Judge pay for post-certificate findings** is not funded (the contest pot is settled by then). Judges
  decide those for reputation.
- **Not audited**: these contracts have not been through this process, or any other, yet.
