# SWDMM v2 — Mainnet Runbook

This is the ordered checklist for taking swd-amm (constant-product, DLMM and
SWDMM v2 pools) to mainnet. Every gate must be ticked, in order, by the
people named in each step. Nothing here is automated on purpose: the CI
workflow never deploys to mainnet.

Status on 2026-09-29: gates 1–3 are done for the code in this repository;
gates 4–9 are not started.

## Gate 1 — Tests (done, keep green)

- `cargo test -p swd_amm` — unit tests plus the proptest property suite
  (`programs/swd_amm/tests/proptest_math.rs`, 4 invariants × 20,000 cases).
- `anchor test` — full localnet suite (46 tests, including
  `tests/swdmm_v2.ts` and the live Squads clone tests).
- `test-ui/tests/smoke.mjs` — page smoke test.
- CI runs all three plus `cargo audit` on every push.

## Gate 2 — Dependency review (done, repeat before release)

- `cargo audit`: 0 vulnerabilities; 3 advisory warnings on transitive
  Solana/Anchor crates (bincode and libsecp256k1 unmaintained, a rand
  soundness note). None is reachable from program logic; re-check on the
  release commit.
- Pin the toolchain used for the audited build (Anchor 0.31.1, Solana
  3.1.10, Rust stable of the audit date) and record `sha256sum
  target/deploy/swd_amm.so` of the audited build.

## Gate 3 — Token-2022 policy (done)

- SWDMM v2 pools only accept mints that governance enabled with
  `set_mint_policy`. A Token-2022 mint additionally needs the explicit
  `token_2022_reviewed` flag, passes the extension gate
  (`assert_mint_extensions_safe`: no TransferHook, PermanentDelegate,
  ConfidentialTransfer, NonTransferable…) and must not carry a
  TransferFeeConfig (SWDMM v2 books nominal amounts).
- Negative tests: `tests/swdmm_v2.ts` ("mint policy" cases) and
  `tests/swd_amm.ts` (Token-2022 extension cases).

## Gate 4 — Independent audit (NOT started)

- Hand `docs/AUDIT_SCOPE.md` to at least one independent Solana auditor
  (e.g. OtterSec, Neodyme, Sec3, Zellic, Halborn).
- Fix every critical/high finding, re-run gates 1–3, get the fixes
  re-reviewed, and publish the report.
- Freeze the audited commit hash here: `________`.

## Gate 5 — Fresh keys (NOT started)

Do not reuse any key that has touched devnet, CI secrets, a WSL file or a
browser wallet used for testing (in particular not 3sny8… and not the
devnet deployer secret).

| Role | Holder | Storage |
|---|---|---|
| Squads member 1 | person A | hardware wallet |
| Squads member 2 | person B | hardware wallet |
| Squads member 3 | person C | hardware wallet |
| Emergency authority | on-call person D (not a Squads member) | hardware wallet |
| Mainnet deployer | used once, then retired | hardware wallet / offline |
| Treasury | Squads vault (recommended) or a separate multisig | — |

## Gate 6 — Build for mainnet

```bash
anchor build -- --features mainnet      # timelock must be 24h–48h
sha256sum target/deploy/swd_amm.so      # must match the audited build
```

The `mainnet` feature is what makes `initialize_governance_settings` and
`propose SetTimelockDelay` refuse anything outside 24–48 hours. A build
without it allows 5 seconds — never deploy that to mainnet.
`GovernanceSettingsInitialized.mainnet_build` in the init transaction's
logs must read `true`.

## Gate 7 — Deploy and hand over to the multisig

Use a private RPC (Helius / Triton / QuickNode) for every mainnet step.

```bash
# 1. deploy with the one-time deployer key
solana program deploy target/deploy/swd_amm.so --program-id <PROGRAM_KEYPAIR> \
  --keypair <DEPLOYER> --url <MAINNET_RPC>

# 2. create the Squads 2-of-3 (or 3-of-5) multisig
ANCHOR_PROVIDER_URL=<MAINNET_RPC> ANCHOR_WALLET=<DEPLOYER> \
  yarn ts-node --transpile-only scripts/squads-setup.ts create 2 <M1> <M2> <M3> --yes

# 3. bootstrap governance (deployer is governance only for these two calls)
yarn governance init-global-config <DEPLOYER_PUBKEY> <EMERGENCY> --yes
yarn governance init-settings 86400 1000 <VAULT_PDA> --yes   # 24h, 10%, treasury = vault

# 4. hand governance and upgrades to the Squads vault
yarn governance set-authorities <VAULT_PDA> <EMERGENCY> --yes
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <VAULT_PDA> \
  --skip-new-upgrade-authority-signer-check --keypair <DEPLOYER> --url <MAINNET_RPC>

# 5. prove it on-chain
yarn governance verify-multisig <MULTISIG_PDA> 0     # prints threshold 2 of 3
yarn governance status
solana program show <PROGRAM_ID> --url <MAINNET_RPC>  # authority == VAULT_PDA
```

From here on every governance instruction (mint policy, proposals,
cancellations) is created as a Squads proposal and approved by 2 of 3
members. Timelocked actions can be executed by anyone once they are ready.

## Gate 8 — Launch configuration

- Allow the launch mints (`set-mint-policy <mint> true`, as Squads
  proposals). Allow wSOL (`So11111111111111111111111111111111111111112`) if
  SOL pairs are wanted.
- Consider `set-pool-creation-paused true` until the first pools are
  reviewed.
- Point test-ui (or the production UI) at the mainnet RPC and the mainnet
  program id; remove the devnet banner only after gates 4–7.

## Gate 9 — Operations

- Monitoring: alert on `V2PoolPaused`, `GovActionProposed`,
  `GovActionExecuted`, large `V2Swapped` price impact, and upgrade-authority
  changes.
- Incident: the emergency authority pauses (`emergency-pause-v2-pool`,
  `emergency-pause-pool`); only the multisig can unpause, and only after
  the timelock (`propose-unpause-*` → wait → `execute`).
- Bug bounty and a published `security.txt` contact.
