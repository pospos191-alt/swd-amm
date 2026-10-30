**English** | [ภาษาไทย](audit-as-a-service.th.md)

# Audit-as-a-Service: any chain orders an audit, the certificate is checked where the code runs

Testnet only. Orders are paid in testnet ZETAPHY, which has no value. Nothing here has been audited by an
outside firm, and a certificate is **not** a guarantee that code is safe.

A project on Ethereum, BNB Smart Chain, Base, Arbitrum, Optimism, Polygon, Avalanche (and their testnets),
Osmosis (CosmWasm) or Solana can order an audit from ZETAPHY's open audit network
([audit-network.md](audit-network.md)) and get a certificate that anyone can check: on the project's own chain
(a contract call), on any website (a badge and a live check page) and in wallets / explorers (the same check,
or the public registry). Nothing needs a server or an API key: the chains' free public endpoints, Sourcify, a
GitHub Action and static pages.

| Piece | Where |
|---|---|
| Chains, code hashes, proxies, status rules, badge, registry schema (shared by pages, CLI and Action) | `zetaphy-hub/aas-core.js` |
| Intake: address or repo + commit → AuditNetwork targets | `zetaphy-network/src/aas/intake.js`, `repo.js`, `net.js` |
| Ordering, tiers, payment plan | `zetaphy-network/src/aas/order.js` |
| Public registry + badges | `zetaphy-network/src/aas/registry.js`, `.github/workflows/audit-registry.yml` |
| CLI `zetaphy aas …` | `zetaphy-network/src/aascli.js` |
| On-chain check for other contracts | `zetaphy-network/contracts/AuditVerified.sol` (library over the NeuroOracle mirror) |
| Free automated audit for any repo | `.github/actions/zetaphy-audit/action.yml`, `.github/workflows/audit-reusable.yml` |
| Certificate check page / Audit Directory (8 languages) | `zetaphy-hub/audit.html` + `aas-verify.js`, `audits.html` + `aas-directory.js`, `aas-i18n.js` |
| Tests | `zetaphy-network/test/aas.test.js`; `zetaphy-hub/test/aas.test.mjs`, `aas.e2e.mjs` |

## 1. Intake: what exactly gets audited

```
zetaphy aas intake base 0xYourContract
zetaphy aas intake arbitrum 0x… --repo acme/vault --commit <40 hex> --pipeline-out out/
zetaphy aas intake osmosis osmo1… --repo acme/osmo-vault --commit <40 hex> --checksums artifacts/checksums.txt --wasm vault.wasm
zetaphy aas intake solana <program id> [--repo … --commit …]
```

A certificate binds to a **code hash**, so the intake first reads the code the chain runs now:

| Chain type | Code hash | Source binding | Can change under you |
|---|---|---|---|
| EVM | `keccak256(runtime code)` = `EXTCODEHASH` (`eth_getCode`; every RPC is asked `eth_chainId` first and refused if it serves another chain) | Sourcify v2 `exact_match` / `match`; otherwise a public GitHub repo at a full commit that the pipeline compiles and that reproduces the bytecode (byte for byte, or only the metadata hash differs) | proxies (below), `SELFDESTRUCT` + redeploy |
| CosmWasm (Osmosis, osmo-test-5) | the code checksum (sha256 of the wasm) the chain stores for the contract's code id (`/cosmwasm/wasm/v1/code-info/{id}`, or `data_hash` on older nodes) | repo + commit built with `cosmwasm/optimizer`; its `checksums.txt` must list the same checksum | an `admin` can migrate the contract to another code id |
| Solana (mainnet, devnet) | the `solana-verify` program hash: sha256 of the ELF in the program-data account, trailing zeros trimmed (the cluster's genesis hash is checked) | OtterSec's verified-builds API when it already verified that exact hash; otherwise repo + commit, rebuilt by the runners with `solana-verify build` | an upgrade authority can replace the program |

**Proxies.** EIP-1967 (implementation and beacon slots), EIP-1167 minimal clones and the old ZeppelinOS slot are
detected. A proxy is ordered as **two** targets: the proxy and its current implementation. The proxy's own code
does not change on an upgrade, so every check (the page, the CLI, `AuditVerified.requireCertifiedProxy`) also
compares the implementation: an upgrade to uncertified code shows as **CODE CHANGED**.

**No source, no order.** Code that is not verified on Sourcify and has no repo + commit that reproduces it cannot be
ordered: auditors would review source that is not the deployed code.

A non-EVM target fits the same AuditNetwork `Target {chainId, target, codeHash, sourceHash}`: `chainId` is a
reserved id above 9·10¹⁸ (Osmosis `9000000000000000001`, osmo-test-5 `…002`, Solana `…101`, devnet `…102`), and
`target` is a 20-byte stand-in, the last 20 bytes of `keccak256(abi.encode("zetaphy.aas.target", caip2, native))`.
The native address travels in the request URI: `zaas1|<chain>|<native address>|<role>|<link>`.

## 2. Tiers and prices (testnet tokens)

| Tier | What runs | Contest | Min auditors | Certificate | Price |
|---|---|---|---|---|---|
| **fast** (automated only) | the GitHub Action or `zetaphy audit run`: Slither, Aderyn, Semgrep, forge invariants, OSV (+ SMTChecker, mutation, Neuro in the full pipeline) | — | — | **never** (a "ZETAPHY scan" badge only) | free, your own CI minutes |
| **basic** (AuditNetwork tier 0) | 3 bonded runners (2 must agree) + open contest + bonded judges | ≥ 7 days | ≥ 3 | Bronze / Silver / Gold if everything passes | deposit = bounty pool + 10 % fee |
| **standard** (tier 1) | same | ≥ 14 days | ≥ 5 | same | same formula |
| **deep** (tier 2) | same | ≥ 21 days | ≥ 7 | same | same formula |

(The contest and auditor minimums are the live `getParams()` values: `minContest + 7 days × tier` and
`minAuditorsFloor + 2 × tier`; the numbers above are the testnet defaults.) The deposit is paid in testnet
ZETAPHY: the bounty pool (at least `minPool`, 10 ZETAPHY by default) goes to valid findings and participation
reports, the fee (10 %) to the runners (half) and the judges (half). A proxy is two orders.

```
zetaphy aas order base 0xYourProxy --tier standard --pool 100           # dry run: prints the transactions
zetaphy aas order base 0xYourProxy --tier standard --pool 100 --send    # signs them on ZETAPHY
```

### Paying from another chain

AuditNetwork takes native testnet ZETAPHY on ZETAPHY (chain 77390). `zetaphy aas pay --from <chain>` prints the
steps. ZETAPHY's Hyperlane routes from Sepolia, Base Sepolia and Arbitrum Sepolia carry **tokens** (a lockbox
there, a bridged token on ZETAPHY), not native ZETAPHY, so a one-transaction "order from Sepolia" would need a
remote order router: a contract on ZETAPHY that receives the bridged token plus the order over Hyperlane, swaps
or unwraps it and calls `AuditNetwork.request` for the sender. It is designed here and **not deployed**. Today:
get testnet ZETAPHY on ZETAPHY (the hub's Earn page) and send the request from any ZETAPHY wallet. The sponsor does
not have to be the deployer of the audited contract.

## 3. What a certificate means — and its limits

It means: this exact code (by hash) went through ZETAPHY's process — automated tools agreed by bonded runners, an
open contest of bonded auditors, bonded judges — with no valid critical or high finding left unfixed, and it
reached a level (Bronze / Silver / Gold) by auditors, contest length and mutation score.

It does **not** mean the code is safe, that the team is honest, or that deployment settings, keys, admin powers,
oracles, economics or off-chain parts were reviewed. It expires (180 days by default) and is revoked at once if a
critical or high bug is judged valid later. Further limits:
- **Upgradeable code** (proxy admins, CosmWasm admins, Solana upgrade authorities) can change at any time; the
  certificate then shows CODE CHANGED, but the change itself is not prevented.
- A checker must read the live code. A wallet that only reads the registry sees the state as of the last build.
- Off-ZETAPHY chains learn of a revocation only when someone pushes it to the NeuroOracle mirror there
  (`NeuroOracleSender.pushCertificate`; anyone may, paying the Hyperlane fee). The hub page always reads ZETAPHY.
- CosmWasm and Solana have no mirror contract in this delivery: their projects check via the page / CLI.
- Immutables: contracts with immutables bind through Sourcify (which handles them); the repo + commit path only
  matches byte-identical code (or a different metadata hash).

## 4. Checking a certificate

The four states (shared logic: `aas-core.js certificateStatus`, in this order):

| State | When |
|---|---|
| **REVOKED** | the certificate, or the same code under another request, was revoked after a valid critical/high finding |
| **EXPIRED** | past `expiresAt` |
| **CODE CHANGED** | the code hash running now differs from the certified one; for a proxy, its current implementation is uncertified, expired, revoked or changed |
| **VALID** | none of the above, and the live code could be read and matches |
| (NOT CERTIFIED / CANNOT CHECK NOW) | no certificate; or the chain's public endpoints did not answer |

**On the project's own chain (EVM).** Where a NeuroOracle mirror is deployed, `isCertified(block.chainid, target)`
returns true only while the mirrored certificate is unexpired and unrevoked and the target's `EXTCODEHASH` there
is still the certified hash. Contracts use the `AuditVerified` library:

```solidity
import "./AuditVerified.sol";
contract Router {
    using AuditVerified for IAVOracle;
    IAVOracle immutable oracle; // the NeuroOracle mirror on this chain
    function list(address pool) external { oracle.requireCertified(pool); /* … */ }
    function listGold(address pool) external { oracle.requireLevel(pool, 3); /* … */ }
    function listProxy(address p, address impl) external { oracle.requireCertifiedProxy(p, address(0), impl); /* … */ }
}
```

`isVerified` fails closed (no mirror, a reverting mirror: false). `requireCertifiedProxy` needs a proxy (or its
beacon) that answers `implementation()`; contracts cannot read another contract's EIP-1967 slot.

**On websites.** `https://app.sawasdeecoin.com/audit.html#<chain id or key>:<address>` (e.g. `#8453:0x…`,
`#solana:<program id>`, `#osmosis:osmo1…`) reads the certificate from ZETAPHY and the code from the project's
chain in the visitor's browser, and offers the badge snippet:

```html
<a href="https://app.sawasdeecoin.com/audit.html#8453:0xYourContract"><img src="https://cdn.jsdelivr.net/gh/pospos191-alt/swd-amm@audit-registry/badges/base-0xyourcontract.svg" alt="ZETAPHY audit certificate" height="20"></a>
```

The badge image is static (rebuilt every 6 hours); the link is the live check. Badges are plain SVG (no
script, no external reference), safe as `<img>` anywhere.

**In wallets and explorers.** Read `AuditCertificate.certificate(chainId, target)` on ZETAPHY plus the live code
hash (as the page does), or the mirror's `isCertified` on that chain, or the public registry
`https://raw.githubusercontent.com/pospos191-alt/swd-amm/audit-registry/audit-registry.json` (an index: re-check
live before showing VALID). ZETAPHY's own explorer already shows the badge for certified addresses.

**From a terminal.** `zetaphy aas verify base 0x…` prints the state and both hashes; exit code 0 only when VALID.

## 5. The public registry and the Audit Directory

`.github/workflows/audit-registry.yml` runs every 6 hours: it reads `CertificateIssued` and `RequestUri` events from
the public ZETAPHY RPC, writes `audit-registry.json` (every certificate, its level, expiry, report link, finding
counts, proxy ↔ implementation link) and one badge per certificate, and force-pushes them as one commit to the
orphan branch `audit-registry`. No server and no secret: the workflow's own token may push only that branch.
The hub's **Audit Directory** (`audits.html`, 8 languages) lists that registry (falling back to the copy shipped
with the hub), filters it by chain, state and text, and links every row to the live check.

## 6. The free GitHub Action (any repository)

```yaml
# .github/workflows/zetaphy-audit.yml in YOUR repository
on: [pull_request]
permissions: {}
jobs:
  audit:
    runs-on: ubuntu-24.04
    permissions: { contents: read, security-events: write }
    steps:
      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
        with: { persist-credentials: false }
      - id: zetaphy
        uses: pospos191-alt/swd-amm/.github/actions/zetaphy-audit@<full commit sha>
        with:
          path: contracts      # default: the repository root
          tier: fast           # or deep (hours)
          fail-on: high        # critical | high | none
```

or the reusable workflow:

```yaml
jobs:
  zetaphy-audit:
    uses: pospos191-alt/swd-amm/.github/workflows/audit-reusable.yml@<full commit sha>
    permissions: { contents: read, security-events: write }
    with: { path: contracts }
```

It installs the pinned tools (`audit/tools/install.sh`: every binary checked against a SHA-256, Python tools
from a hash-locked file), runs `audit/run.sh --target` on your code, writes `REPORT.md` (+ Thai), `findings.json`,
`summary.json` (`report.js --json`), `audit.sarif` (uploaded to code scanning when your repo has it) and
`zetaphy-scan.svg`, and fails on open findings at `fail-on`. Outputs: `status`, `critical`, `high`, `gate` and the
file paths. It needs **none** of ZETAPHY's secrets and none of yours; triage decisions go in your own
`audit/triage.yml` (same format as ours). Pin a full commit sha, never a branch. The automated tier only finds
what tools find: it is never a certificate.

## 7. What was tested, and how

- Intake per chain type against fixtures that copy the public APIs' shapes (no network in tests): every EVM chain
  of the list incl. testnets (chain-id check, Sourcify v2), EIP-1967 + admin, beacon, EIP-1167, repo + commit
  (exact, metadata-only, mismatch), Osmosis (new and old LCD), Solana (program-data parsing, genesis check,
  OtterSec verified / stale).
- On the real contracts in the in-memory EVM: intake of a proxy → two `AuditNetwork.request`s from `planOrder`'s
  calldata → certificates → NeuroOracle mirror → `AuditVerified` (`requireCertified`, `requireLevel`,
  `requireCertifiedProxy`); an implementation swap is CODE CHANGED for the page logic and reverts
  `ImplementationChanged`, an in-place code change flips the mirror; the registry built from the emitted events.
- The Action's files: composite, every `uses:` pinned to a commit, no `secrets.`, no `${{ }}` inside scripts.
- The check page and the directory in Chromium under the site's CSP with every RPC mocked: VALID (+ mirror),
  CODE CHANGED (redeploy, proxy swap), REVOKED, EXPIRED, NOT CERTIFIED, a Solana program, Thai, phone width.
