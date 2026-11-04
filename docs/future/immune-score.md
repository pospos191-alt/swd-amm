**English** | [ภาษาไทย](immune-score.th.md)

# Vaccines from confirmed exploits, a live security score, and the audit network auditing itself

Testnet only (ZETAPHY, chain 77390). Nothing here holds or pays real money, nothing is deployed yet, and none of it
has been audited by an outside firm. It builds on the [open audit network](audit-network.md) and the
[immune network](immune-network.md); read those first.

Three pieces:

| Piece | What it does | Where |
|---|---|---|
| **SS5 cross-chain vaccine** | A *confirmed* exploit becomes a vaccine (code hash, body hash, distinctive selectors). Copies on ZETAPHY are **held pending review** in ThreatRegistry and their owners notified; other chains get it through the existing immune path. | `contracts/ImmuneVaccines.sol`, `ThreatRegistry.sol` (review holds), `src/immune/confirmed.js`, `src/immune/detectors.js` (`confirmed`) |
| **S10 + SS7 security score** | A live 0–1000 score per contract that any DeFi contract can read, from on-chain facts only. An example collateral helper uses it. The explorer shows it. | `contracts/SecurityScore.sol` (`SecurityScore`, `ScoredCollateral`), `zetaphy-explorer/src/score.js` |
| **SS8 self-audit** | AuditNetwork, AuditRunners, AuditJudges and AuditCertificate go through their own audit network. A CI check fails when one of them lacks a live certificate. Formal properties of the four contracts run as Foundry invariants. | `src/auditself.js`, `scripts/audit-self.js`, `test/audit-self.test.js`, `audit/invariants/AuditNetwork.inv.t.sol`, `.github/workflows/security.yml` |

Tests: `zetaphy-network/test/immune-vaccine.test.js`, `test/securityscore.test.js`, `test/audit-self.test.js`,
`audit/invariants/AuditNetwork.inv.t.sol` (forge), `zetaphy-explorer/test/unit.test.js` (score badge).

## SS5: vaccines from confirmed exploits

### What counts as confirmed

`ImmuneVaccines` trusts nothing a caller says. A caller only points at one of three facts on chain:

| Call | The fact it reads |
|---|---|
| `vaccinateFromFinding(findingId)` | An `AuditNetwork` finding that the judges decided **valid** with severity **high or critical**, with no appeal open. This covers a contest finding and a post-certificate finding. |
| `vaccinateFromRevocation(chainId, target)` | An `AuditCertificate` certificate that was revoked, or whose code hash was revoked. |
| `vaccinateFromClaim(claimId, target)` | A `HackInsurance` claim that was **Approved** or **Paid**, whose cover's target key is `addressKey(chainid, target)`. HackInsurance covers this chain only. The code hash is the target's code at that moment. |

All three point at the same vulnerable code. The vaccine id is `keccak256("zetaphy.vaccine.v1", chainId, target,
codeHash)`, so each extra confirmation of the same code adds a source to the same vaccine (`sources` is a bitmask).

### The vaccine

When the code is on ZETAPHY and unchanged, the contract derives the pattern itself, on chain, from the code. Otherwise
anyone can call `derivePattern(id, code)` with the runtime code, and it must hash to the vaccine's code hash. The
pattern is:

- **code hash**: `keccak256` of the runtime code. This is an exact match.
- **body hash**: `keccak256` of the code without its CBOR metadata, which catches the same source recompiled. This is
  Neuro's `codeLengthWithoutMetadata`.
- **distinctive selectors**: every `PUSH4 <sel> EQ` (or `PUSH4 <sel> DUP2 EQ`) in the dispatcher, minus Neuro's
  honest-ERC-20 baseline. These are exactly the selectors that Neuro's scanner (`zetaphy-neuro/src/bytecode.js`) and
  `src/immune/vaccines.js signatureOf(code).selectors` find. The test compares them on real compiled contracts. The
  baseline constant is checked against `threat-signatures.generated.js`.

### On ZETAPHY: held pending review, owners notified

Anyone may call `checkMatch(id, contract)`. The contract re-checks the match on chain:

| Strength | Rule | What happens |
|---|---|---|
| 3 exact | same EXTCODEHASH | **held pending review** + owner notified |
| 2 body | same code without metadata | **held pending review** + owner notified |
| 1 selectors | at least 80% of the vaccine's distinctive selectors (it needs at least 3) | a **suspect**: recorded and the owner notified, **not held** (the score drops by 150) |

A **hold** is `ThreatRegistry.holdForReview(addressKey(chainid, contract), vaccine, reviewWindow)`. It is additive and
bounded:

- Only the `vaccines` address that governance (the timelock) set in ThreatRegistry may call it.
- A hold lasts at most `MAX_REVIEW_HOLD` (14 days). `reviewWindow` in ImmuneVaccines is bounded to 1–14 days and
  defaults to 7.
- A **hold is not a flag**. `is*Held` report it with `Reason.Other`, so BridgeAirlock and BridgeGuard hold that
  party's bridging, reversibly. `is*Flagged` and `is*Enforced` do not change. Only the runners' quorum can flag, as
  before.
- **Protected keys are never held.** Protecting a key drops its hold.
- A hold is put **once per (contract, vaccine)**. When the window ends or someone releases it, nobody can renew it.
  After that, only a flag from the runners' quorum can hold the contract again.
- A hold ends in one of four ways:
  - the window ends;
  - governance or a ThreatRegistry guardian calls `releaseReview` after reviewing it;
  - the key is protected;
  - the vaccine is retired, and then anyone calls `release`.

**Notifying owners.** Every match emits `OwnerNotified(owner, contract, vaccine, strength)`. The owner is the
contract's `owner()`, read with a gas cap, or zero when there is none. Wallets, the hub and indexers follow the event.
The owner can answer through ThreatRegistry's right of reply.

**Retiring.** Anyone may call `retire(id)`. It re-checks every confirmation and drops the ones that no longer hold:
- an audit finding that an appeal overturned;
- an insurance claim that was overturned.

An appeal that is merely **open** drops nothing, so filing an appeal cannot lift holds. A revoked certificate is final.
When no confirmation is left, the vaccine is retired and its exploit no longer counts in the history. `release(contract)`
then lifts its holds.

### Other chains: the existing immune path

Nothing new crosses chains. The confirmed exploit enters the immune network the way any finding does:

1. `src/immune/confirmed.js confirmedReport({ record, id, code, vaccines })` builds a report for a new detector,
   **`confirmed`** (`detectors.js confirmedVerdict`). It is a pure verdict over the ImmuneVaccines record and the
   code: the record is active, it names this chain and address, and `keccak256(code)` equals its code hash. The report
   carries the full off-chain vaccine (`vaccines.js deriveVaccine`: exact, fingerprint, similarity and selectors).
2. NeuroJobs runners re-run it from the bundle alone (`runnerVote`) and agree. Then `ImmuneRegistry.attest` flags the
   exploit contract's account and its **code hash on every chain**, together with the vaccine id.
3. `ImmuneBroadcaster.broadcast` carries the flag and the vaccine id to every `ImmuneMirror`, where `isCodeFlagged`
   and `vaccineOf` answer. The sentinels on every chain load the vaccine and scan new contracts with it, so a
   recompiled or modified clone is caught by `clone` and goes through the same agreement.

The test `immune-vaccine.test.js` runs all of this on in-process chains:
- an insurance claim on ZETAPHY becomes a NeuroJobs-agreed flag, mirrored to B and C with its vaccine;
- the same vault recompiled with another metadata hash (so another code hash) on C is caught with that vaccine;
- honest code is not caught.

`findMatches(send, record, candidates)` in `confirmed.js` uses the contract's own rule to pick which ZETAPHY
contracts to send to `checkMatch`. The test checks that the JS and the contract agree on every strength.

## S10 + SS7: the security score

### Who posts what

**Nobody posts a score.** `SecurityScore.breakdown(chainId, target)` computes it at every call, from contracts that
already hold accountable facts. The sources are fixed at deploy, any of them may be zero, and there is no setter and
no admin key:

| Source | Read | Written there by |
|---|---|---|
| AuditCertificate | the certificate: level, issued, expires, revoked; a revoked code hash | `certify` (every audit rule); `revokeFor` (a judged valid critical/high) |
| AuditNetwork | the 16 newest findings of the certificate's request: revealed, undecided, post-certificate, claiming high/critical | bonded auditors (commit-reveal); the judges decide |
| CircuitBreaker | registered (monitored); tripped now; the start of the last trip and whether it was proven false | the protocol's own governance; bonded runners or invariants |
| NeuroScore | `scoreOf(target)`: the active model's risk level | governance-appointed feeders and the timelock's model |
| ImmuneVaccines | `exploitsOf(chainId, target)`, `matchOf(target)` | confirmed exploits only (see above) |
| ThreatRegistry | flagged, enforced, held pending review | a quorum of bonded runners; ImmuneVaccines (holds only) |
| ImmuneRegistry / ImmuneMirror | `isFlagged`, `isCodeFlagged` | k-of-n NeuroJobs agreement |

`refresh(chainId, target)` (anyone) stores the score and emits `ScoreUpdated` for indexers. `cached` reads it back,
for a protocol that accepts its age. DeFi contracts should call `score` live.

### The formula (fixed in code)

| Part | Points |
|---|---|
| Certificate | valid: Bronze 250, Silver 325, Gold 400, times (½ + ½ × the share of its validity left) |
| Neuro | known level 0: 200, level 1: 150, level 2: 60, level 3: 0; unknown, or another chain: 100 |
| Monitoring | registered with the CircuitBreaker: 150 |
| History | 250 − 125 per confirmed exploit in the last 365 days (2 or more: 0) |
| − open findings | 100 for each revealed, undecided post-certificate finding claiming high/critical (at most 3) |
| − breaker | 300 while tripped; otherwise 100 when the last trip began within 30 days (unless proven false) |
| − suspect | 150 when the contract matches most selectors of an active vaccine |

The maximum is 400 + 200 + 150 + 250 = 1000. Then **caps**, where the lowest wins:

| Cap | When |
|---|---|
| 0 | ThreatRegistry enforces a flag on it, or the immune feed says critical (4) |
| 100 | ThreatRegistry flags it; the feed says high (3); an active vaccine's exact or body match |
| 150 | an exploit confirmed within the last 30 days |
| 200 | its certificate, or the certified code, was revoked |
| 300 | held pending review |
| 400 | the feed says suspicious (2) |
| 500 | a configured source could not be read (`degraded`) |

Every read is gas-capped and caught: a broken source **lowers** the score (degraded) and never blocks a protocol.
In the tests, a live read of a monitored, Neuro-scored contract costs under 600k gas.

Worked examples from `securityscore.test.js`:

| Contract | Score |
|---|---|
| Unknown contract | 350 |
| Neuro low risk + monitored | 600 |
| Fresh Bronze certificate | 850 |
| An open high claim after the certificate | 750 |
| Tripped | 550 |
| Revoked | 200 |
| Revoked, with the vaccine's recent exploit | 150 |
| An exact copy of exploited code | 100 |
| A look-alike | 200 |
| An enforced flag | 0 |

### The example integration: `ScoredCollateral`

There is no lending contract in this repository; the DEX only has pairs and routers. So the example is a collateral
helper that any lending market, vault or pool would call:

- `collateralFactorBps(asset)` and `maxBorrow(asset, value)` follow the live score through governance's tiers. The
  defaults in the tests are 400 → 40%, 600 → 60%, 800 → 75%.
- `poolLimit(pool, baseLimit)` scales a pool's, vault's or route's limit linearly. It is 0 at a score of 300 or less
  and the whole limit at 1000.

The tiers belong to governance (the timelock), inside fixed bounds:
- at most 4 tiers;
- each factor at most 85%;
- minimum scores strictly increasing, and factors never decreasing;
- the **lowest tier needs more than 300**. So anything flagged, held, recently exploited or revoked (all capped at
  300 or less) is **never worth anything as collateral**, whatever governance sets.

A revoked certificate, a confirmed exploit, a vaccine match or a flag changes the factor in the same block.

### In the explorer

When `securityScore` is set in `config.json` (or in Settings), the address and token pages of a contract show a badge
such as "Security 850/1000". It adds "· held pending review" or "· flagged" when that applies. The tooltip lists every
part of the score. The texts exist in all 8 languages (en, zh, es, ko, ja, ru, vi, th). The badge reads
`breakdown(77390, address)` with one `eth_call`, cached for the visit, and shows nothing when the node fails.

## SS8: the audit network audits itself

### The scripted self-audit

`test/audit-self.test.js` runs the whole process on an in-memory ZETAPHY (chain 77390):

1. It deploys AuditNetwork, AuditRunners, AuditJudges and AuditCertificate.
2. It files **four requests, each on the contract's own address and EXTCODEHASH**.
3. Three bonded auditors take part in the contest.
4. Three runners commit and reveal the automated result: the pipeline adapter on the committed report fixture, plus
   **Neuro's code-only scan of each contract's deployed code**. Neuro finds only info/low on all four, so the open
   critical/high count is 0.
5. Settlement, then a certificate for each.

The test then writes the record, runs the CI check on it (it passes), and shows that the check fails:
- on an expired certificate;
- on a changed artifact;
- after a valid post-certificate critical against AuditJudges, which revokes it (the live check fails).

On the testnet:

```
node scripts/audit-self.js plan   --rpc https://… [--source <commit>]   # prints the four `zetaphy audit request` commands
# … the audit runs through the network like anyone's …
node scripts/audit-self.js record --rpc https://…                       # writes deployments/audit-self-77390.json
node scripts/audit-self.js check  [--rpc https://…]                     # what CI runs
```

### The CI check (OFF until the record exists)

`.github/workflows/security.yml` runs `node scripts/audit-self.js check` in the zetaphy-network job. While
`zetaphy-network/deployments/audit-self-77390.json` does not exist, it prints `OFF` and passes. Once the record
exists, it **fails** unless each of the four contracts meets all of these:
- it has an issued, unrevoked, unexpired certificate for its recorded code hash;
- the committed artifact is the one that was audited. A source change means a new artifact, and that needs a new
  request.

With `--rpc`, it also checks on chain that the deployed code is still the recorded one and that
`AuditCertificate.isCertified` is true.

### Formal properties (invariants)

`zetaphy-network/audit/invariants/AuditNetwork.inv.t.sol` follows the repo's Foundry style. The handler fuzzes all of
these:
- requests;
- auditor commits and reveals;
- three runner seats (clean or critical results);
- judge votes, report rejections, appeals and governance resolutions;
- settlement and certification;
- post-certificate findings;
- every claim and withdrawal.

It also has whole-request and whole-finding steps, so random runs reach certificates and revocations. A probe checked
that random runs reach both, and `test_handlerReachesCertificatesAndRevocations` pins it.

| Property | Invariant |
|---|---|
| No payout exceeds deposits: a request never pays more than its pool; nobody withdraws more than was paid in; balances = deposits − withdrawals | `invariant_noPayoutExceedsDeposits` |
| Every owed balance, auditor and judge bond and escrowed slash is backed by the contract's balance | `invariant_creditsBacked` |
| A certificate never issues with an open critical: zero valid critical/high, zero undecided, no open appeal, an agreed automated tier with zero critical/high | `invariant_noCertificateWithOpenCritical` |
| A certificate hit by a valid post-certificate critical/high is never valid again | `invariant_revokedStaysRevoked` |

Run: `cd zetaphy-network && forge test --match-path audit/invariants/AuditNetwork.inv.t.sol`
(`FOUNDRY_PROFILE=deep` for 1000 × 100). The pipeline's invariant step (`audit/tools/invariants.sh`) picks it up with
the other suites.

## Deploying (testnet; every step through the timelock)

1. Deploy `ImmuneVaccines(AuditNetwork, AuditCertificate, HackInsurance, ThreatRegistry, timelock)`.
2. Have the timelock call `ThreatRegistry.setVaccines(ImmuneVaccines)`. Until then, `checkMatch` on an exact or body
   match reverts (`NotVaccines`), so the misconfiguration is visible.
3. Deploy `SecurityScore(AuditCertificate, AuditNetwork, CircuitBreaker, NeuroScore, ImmuneVaccines, ThreatRegistry,
   ImmuneRegistry)` (any source may be zero), and optionally `ScoredCollateral(SecurityScore, timelock, tiers)`.
4. Set the explorer's `securityScore`.

No contract here has an owner key. Governance can only:
- change `reviewWindow` (1–14 days);
- set the vaccines address in ThreatRegistry;
- change the collateral tiers (bounded as above).

## Limits (what is prototype)

- **Not deployed**: all of this ran on in-process EVMs. The NeuroJobs agreement, broadcast and mirrors use the
  immune network's simulated Hyperlane (see [immune-network.md](immune-network.md)).
- **Selector matches are heuristics.** That is why they never hold anything, only lower the score and notify. Exact and
  body matches are not heuristics.
- **The fixed version of an exploited contract** usually keeps its selectors, so it shows as a *suspect* (−150) until
  it gets its own certificate. That is intended, but the score says it plainly.
- **Owner notification is an event.** Contracts without `owner()` are notified as `0x0`; their parties use
  ThreatRegistry's responder route.
- **The score reads the 16 newest post-certificate findings** of the certificate's request: a bounded gas cost. An
  older open finding does not count.
- **Cross-chain targets** score from what ZETAPHY knows: certificate, history and flags. They get no Neuro, breaker or
  vaccine-match points or penalties.
- **The self-audit has run in tests only.** The CI check is OFF until the record of a real testnet self-audit is
  committed. The formal properties are invariant tests (fuzzed), not machine proofs.
