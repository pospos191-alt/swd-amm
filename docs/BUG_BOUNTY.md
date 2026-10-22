**English** | [ภาษาไทย](BUG_BOUNTY.th.md)

# ZETAPHY Bug Bounty program

> **There is no real reward money yet.** ZETAPHY is on a testnet, its coins have no value, and there is no reward pool yet
> - **During the testnet:** rewards are **credit** only (a name in the Hall of Fame below, thanks in fix notes and reports); no money, no tokens
> - **Before mainnet:** real reward money must be transferred into a separate pool (the community fund, held by a multisig) by a governance vote **before** real money is accepted, and the amount announced in this file
>   Until it is announced, the figures in the table are only "targets", not promises
> - The lock/mint bridge (`BridgeAirlock`) is **closed** and will open only after this program has real money (see `zetaphy-network/README.md` stage 3)

English summary at the end.

## Scope (in scope)

| Component | Located in |
|---|---|
| The chain patch (Cosmos EVM: ML-DSA, `MsgEVMCall`, quantum lock, fee burning, randomness, `x/ratelimit`, preinstalls) | `zetaphy-chain/` |
| Bridge: `BridgeGuard`, `BridgedToken`, `BridgeAirlock` (including markers), `NeuroLane`, `HyperlaneLane`, `HyperlaneLockBox`, `LockBox`, `zetaphy bridge watch` / `open` / `monitor` | `zetaphy-network/contracts/`, `zetaphy-network/src/` |
| Neuro contracts: `NeuroJobs`, `NeuroJobsChallenges`, `NeuroControl`, `ThreatRegistry`, `ThreatReports`, `NeuroIdentity`, `NeuroValidation`, `ComputeMarket`, `RewardVault`, `StableGateway`, `QuantumWallet`, `SimpleMultisig` | `zetaphy-network/contracts/` |
| Governance and prices: `ZetaphyTimelock` (OpenZeppelin `TimelockController` 5.4.0 pinned in `vendor/`, including the launch tool's handover of rights), `ZetaphyOracle`, `TwapRecorder`, `ZetaphyPythRelay`, the guardian's emergency switches, `zetaphy timelock` / `oracle` | `zetaphy-network/contracts/`, `zetaphy-network/vendor/`, `zetaphy-network/src/`, `zetaphy-launch/` |
| DEX (factory, router, pair) | `zetaphy-dex/` |
| NFT (factory, marketplace) | `zetaphy-nft/` |
| Web wallet (including PQ accounts) | `zetaphy-wallet/` |
| MetaMask Snap | `zetaphy-snap/` |

**Out of scope:** third-party services (Oracle Cloud, Vercel, GitHub, MetaMask, Hyperlane, Noble) unless the problem is in how we use them ·
DoS by sending large numbers of requests (spam/flood) · social engineering or phishing against the team and users · vulnerabilities that require the victim's private key or device first ·
reports from automated scanning tools without a way to reproduce · issues already recorded as "accepted risk" in `SECURITY.md` or a package's README ·
a wrong Neuro flag (that is a matter for an appeal, `zetaphy threat appeal`, not a vulnerability) unless there is a way to force a flag to be set or cleared beyond one's rights

## Severity levels and rewards

The Immunefi Vulnerability Severity Classification System v2.3 is used as the main guideline, judged by real, reproducible impact

| Level | Examples | Target reward after mainnet (USD equivalent) | During the testnet |
|---|---|---|---|
| Critical | Minting tokens on the bridge without a real lock · stealing or permanently freezing user funds · forging ML-DSA signatures / taking over a quantum-locked account · permanently splitting or halting the chain | 10% of the funds at risk, up to 50,000 (minimum 10,000) | Credit + Hall of Fame |
| High | Bypassing `BridgeGuard`'s daily cap or pause · a minority of Neuro runners taking over Neuro's results · temporarily freezing funds · bypassing governance rights | 5,000 – 10,000 | Credit |
| Medium | Making a contract unusable (griefing) without losing money · stealing small amounts of fees/rewards · bypassing the DEX/NFT ThreatRegistry check | 1,000 – 5,000 | Credit |
| Low | A function not doing what it says without loss of money · the wallet/Snap showing wrong information that could mislead users | 100 – 1,000 | Credit |

- Paid from the **community fund** when governance votes to approve it (a proposal per report); the team proposes the level and amount, the community votes
- Paid in USDC or ZETAPHY as voted, not exceeding the amount announced as available in the pool
- Duplicate reports: the reward goes to the first person to send a complete report
- A single problem with the same root cause counts as one report
- People working for the project (paid) or auditors currently engaged do not receive reward money (they get credit)
- Must comply with the laws of the reporter's country (including tax and sanctions); the team may ask for identity verification (KYC) before paying real money

## Rules

1. Test only on **your own devnet** (`zetaphy-network/scripts/devnet.sh`, `npm run test:devnet*`) or the public testnet. Do not touch other chains' mainnets or other people's funds
2. On the public testnet: use your own accounts; do not steal/freeze other people's test coins beyond what is needed for proof; do not halt the chain (tell us first; we will help set up a test chain for you)
3. Do not disclose publicly before the fix is finished (see the timeline below)
4. No DoS, spam, social engineering, or accessing personal data
5. Include how to reproduce: the commit tested, the steps, a script or test (best is a `node --test` test that fails before the fix), and the expected impact
6. One report per problem

### Safe harbor

If you follow the rules above in good faith:
- We consider your research authorized, will not take legal action or complain to the authorities, and will not ask service providers to suspend your accounts
- If a third party takes action against you because of research done under these rules, we will let them know that we authorized it
- If you are not sure whether a test is within the rules, ask us first (private channels below)

This safe harbor applies only to the actions of the **project maintainers**; it does not bind third parties and is not legal advice (see `docs/LEGAL.md`)

## Reporting privately

**Do not open a public issue for a vulnerability**

1. **GitHub Private vulnerability reporting (main channel):** repo page → **Security** tab → **Report a vulnerability**
   - The repo owner must enable it first: **Settings → Code security** (or **Security**) → **Private vulnerability reporting** → **Enable**
   - Reports are visible only to the repo maintainers; follow-up discussion and issuing an advisory / CVE happen in one place
2. **Email (fallback):** `security@<project domain>` — *does not exist yet; the project owner must create it and put it in place of this text (like step 11 in `docs/LAUNCH.md`)*
   If you send sensitive files, ask for a PGP key first

Include in the report: the affected component, the commit, the level you assess, how to reproduce, the impact, a proposed fix (if any), the name you want in the Hall of Fame (or anonymous)

## Timeline

| When | What |
|---|---|
| Within 3 business days | Acknowledge receipt of the report |
| Within 10 business days | Confirm it can be reproduced, and give an initial assessment of the level |
| During the fix | If it involves the bridge or user funds: the guardian presses pause (`zetaphy bridge pause`) / closes the route first, then fixes |
| Fix finished | Critical/High: target 30 days · Medium/Low: 90 days |
| Disclosure | After the fix is deployed, or 90 days after the report (whichever comes first); the date is agreed with the reporter; a GitHub Security Advisory is issued crediting the reporter |

If we do not respond on time, the reporter has the right to disclose after 90 days, giving us 7 days' notice

## Hall of Fame

(none yet)

---

## English summary

**There is no real money in this program yet.** ZETAPHY is a testnet; its coins have no value. Until mainnet, rewards are
**recognition only** (Hall of Fame, credit in advisories). Real reward amounts must be **funded into a separate community-fund
pool held by a multisig, by a governance vote, before mainnet** and announced here; until then the amounts below are targets,
not promises. The lock/mint bridge stays closed until this program is funded.

- **Scope:** the chain patch (`zetaphy-chain/`), the bridge (`BridgeGuard`, `BridgeAirlock`, `NeuroLane`, `HyperlaneLane`,
  `HyperlaneLockBox`, `LockBox`, the airlock's markers and the CLI around them, including the bridge monitor), the Neuro contracts (`zetaphy-network/contracts/`),
  the governance timelock and its handover (`ZetaphyTimelock`, the pinned OpenZeppelin files in `zetaphy-network/vendor/`, `zetaphy-launch/`), the guardians'
  emergency switches, the price oracle (`ZetaphyOracle`, `TwapRecorder`, `ZetaphyPythRelay`, `StableGateway`'s pricing),
  the DEX (`zetaphy-dex/`), NFT (`zetaphy-nft/`), the web wallet (`zetaphy-wallet/`) and the MetaMask Snap (`zetaphy-snap/`).
  Out of scope: third-party services, volumetric DoS, social engineering, issues needing the victim's key or device,
  unreproduced scanner output, risks already accepted in `SECURITY.md`, and disputes about a Neuro flag (use the appeal).
- **Severity / target rewards after mainnet (USD equivalent):** Critical 10% of funds at risk, 10,000–50,000 · High
  5,000–10,000 · Medium 1,000–5,000 · Low 100–1,000 (Immunefi severity system v2.3). Paid from the community fund
  after a governance vote; first complete report wins; one root cause, one report.
- **Rules:** test on your own devnet or the public testnet only, with your own accounts; no DoS, spam, social engineering
  or privacy violations; no public disclosure before the fix; include a reproduction (ideally a failing `node --test`).
- **Safe harbor:** good-faith research under these rules is authorized; we will not pursue or support legal action
  against you for it. This binds the project maintainers only, and is not legal advice.
- **Report privately:** GitHub → this repository → **Security → Report a vulnerability** (the owner enables it under
  **Settings → Code security → Private vulnerability reporting**). Fallback e-mail: `security@<project domain>`
  (placeholder: the owner still has to create it). Never open a public issue for a vulnerability.
- **Timeline:** acknowledge within 3 business days, triage within 10, fix target 30 days (critical/high) or 90 days
  (medium/low), coordinated disclosure after the fix or 90 days, whichever comes first, with a GitHub Security Advisory.
