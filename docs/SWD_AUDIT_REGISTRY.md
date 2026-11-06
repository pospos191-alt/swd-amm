# SWD Audit Registry (on-chain)

ภาษาไทย: [SWD_AUDIT_REGISTRY.th.md](SWD_AUDIT_REGISTRY.th.md)

`programs/swd_audit_registry` is a Solana program for SAWASDEE COIN (SWD). It
stores the latest **SWD Audit** result for each audited token or contract, so
wallets, DEXes and other programs can read a token's risk level from a PDA,
with no API call and no need for SWD's site to be online.

> **Status (2026-11-06): UNAUDITED DRAFT, not deployed anywhere.** The
> placeholder program id in `declare_id!` / `Anchor.toml` is not a real
> deployment. Read "Before mainnet" below.

The registry does not replace the current Solana memo anchoring
(`lib/audit/attest-anchor.ts` in the site repo). The memo is a cheap,
append-only proof that an attestation existed. The registry is a state you
can **look up by address**, holding one current record per subject.

## 1. Accounts

### Config: PDA `["config"]`, 284 bytes

| field | type | meaning |
|---|---|---|
| version, bump | u8, u8 | |
| authority | Pubkey | revokes and restores records, rotates attestors, pauses. **The Squads vault on mainnet.** |
| pending_authority | Option<Pubkey> | two-step hand-over (`propose_authority` then `accept_authority`) |
| paused | bool | stops `upsert_record` only. Reads and admin calls keep working. |
| record_count | u64 | records created so far |
| attestors | Vec<Attestor>, at most 4 | `{ pubkey, key_id (8 bytes), status, since }` |

Attestor status:

- **1 active**: may sign new records.
- **2 retired**: may not sign new records. Records it already signed stay trusted.
- **3 revoked**: records it signed are **not** trusted. This is final: a revoked key can never be set back to active or retired.

`key_id` = the first 8 bytes of sha256(pubkey). This is the site's
`ed25519-<16 hex>` key id (`keyIdOf` in `lib/audit/attest-core.ts`).

### Record: PDA `["audit", chain_id u16 LE, sha256(normalized address)]`

| off | size | field |
|---|---|---|
| 0 | 8 | Anchor discriminator |
| 8 | 1 | version (1) |
| 9 | 1 | bump |
| 10 | 2 | chain_id (u16 LE) |
| **12** | 1 | **level**: 0 info, 1 low, 2 medium, 3 high |
| **13** | 1 | **revoked** (0 or 1) |
| 14 | 32 | address_hash = sha256(address) |
| 46 | 32 | verdict (Neuro verdict id) |
| 78 | 32 | payload_hash (the attestation's `payloadHash`) |
| 110 | 8 | mldsa_key_id |
| 118 | 8 | ed25519_key_id |
| 126 | 8 | audited_at (i64 unix seconds, the payload's `observedAt`) |
| 134 | 8 | updated_slot (u64) |
| 142 | 4 | address length (u32) |
| 146 | n | address bytes (at most 200) |

The size is **146 + address length**: 190 bytes for a Solana mint (44
characters) and 188 for an EVM address. Each account is sized exactly for
its own address, so long addresses cost nothing extra for everyone else.

### Chain ids

These ids are part of every PDA and every signed message. **Never renumber
them.** A new chain gets the next free id.

| id | chain | id | chain |
|---|---|---|---|
| 1 | eth | 8 | aptos |
| 2 | bsc | 9 | osmosis |
| 3 | base | 10 | neutron |
| 4 | arbitrum | 11 | near |
| 5 | zetaphy | 12 | starknet |
| 6 | sol | 13 | bitcoin |
| 7 | sui | 14 | ton |

**Address normalization** follows `normalizeAddress` in
`lib/audit/shared.ts`:

- EVM chains (1 to 5): `0x` followed by 40 **lowercase** hex digits. The program enforces this, so two spellings of one EVM address can never create two records.
- Solana (6): base58, 32 to 44 characters.
- Other chains: the exact string the site audited, as printable ASCII with no spaces. Bitcoin Runes use the id form, e.g. `840000:3`.

## 2. Instructions

| instruction | who | what |
|---|---|---|
| `initialize(authority, attestors)` | the program's **upgrade authority** only (checked against ProgramData) | creates the Config. Nobody can front-run a fresh deploy. |
| `upsert_record(input)` | **anyone** (a relayer or crank) | creates or updates a Record. Needs a valid attestor signature (see below). |
| `revoke_record(reason)` / `restore_record()` | authority | marks a record revoked, or lifts the mark. A revoked record cannot be updated. |
| `set_attestors(list)` | authority | replaces the attestor list (key rotation) |
| `set_paused(bool)` | authority | pauses or resumes `upsert_record` |
| `propose_authority(Option<Pubkey>)` / `accept_authority()` | authority / the new authority | two-step hand-over, e.g. deployer → Squads vault |

Every instruction emits an event: `RegistryInitialized`, `RecordUpserted`
(with `previous_level`, `created` and `relayer`), `RecordRevokedEvent`,
`RecordRestored`, `AttestorsUpdated`, `PausedSet`, `AuthorityProposed` and
`AuthorityAccepted`.

### `upsert_record`: what is checked

1. The registry is not paused.
2. `chain_id` is known. The address is non-empty, at most 200 bytes and normalized. `address_hash == sha256(address)`. `level` is 3 or less. `0 < audited_at ≤ now + 300 s`.
3. **The signature.** The instruction **immediately before** this one must be an Ed25519 precompile instruction (`Ed25519SigVerify111…`) with:
   - exactly one signature, and no accounts;
   - all three offsets (signature, public key, message) pointing **inside that Ed25519 instruction itself** (instruction index `0xFFFF`). An offset that reads another instruction is rejected. This is the Wormhole-2022 class of bug, where the precompile verifies one thing and the program reads another.
   - a public key that is an **active** attestor;
   - `ed25519_key_id == sha256(pubkey)[0..8]`;
   - a message **byte-for-byte equal** to `record_message(config PDA, fields)`.

   The precompile has already checked the signature itself, otherwise the whole transaction fails. So the registry trusts the signature and **never the caller**.
4. On an existing record: it must not be revoked, and `audited_at` must be **strictly newer** than the stored one. There is no rollback, and replaying the same record fails with `StaleRecord`.

### The signed record message (177 bytes, little-endian)

```
 0  22  "swd.audit-registry.v1\0"   domain tag (differs from the attestation message at byte 10)
22  32  registry                    the Config PDA: binds program id + cluster (a devnet signature is useless on mainnet)
54   2  chain_id
56  32  sha256(address)
88   1  level
89  32  verdict
121 32  payload_hash
153  8  mldsa_key_id
161  8  ed25519_key_id
169  8  audited_at (i64)
```

The same golden vector is checked in Rust (`src/tests.rs`,
`GOLDEN_MESSAGE_HEX`) and in TypeScript (`tests/swd_audit_registry.ts`), so
encoders cannot drift apart.

## 3. Trust model

**What a record proves.** An SWD audit key, active when the record was
written, signed this level, verdict and attestation hash for this
(chain, address) at `audited_at`, in **this** registry.

**What it does not prove.**

- **That the audit is right.** Neuro is a fixed rule engine. A "low" result is not a guarantee.
- **The post-quantum half of the attestation.** Solana has no ML-DSA-44 syscall, and a 2,420-byte ML-DSA signature cannot fit in a transaction next to everything else. The record stores the **ML-DSA key id** and the attestation's **payloadHash**. Full hybrid verification (ML-DSA-44 **and** Ed25519 over `swd.audit-attestation.v1\n<payloadHash>\n…`) stays off-chain:
  1. Fetch the attestation from the audit permalink or `/api/audit/attest`.
  2. Check that sha256(canonical(payload)) == `payload_hash`.
  3. Run `verifyAttestation` / `scripts/verify-attestation.mjs` (site repo).
  4. Check that the payload's chain, subject, level, verdict and observedAt match the record.

  On-chain security is therefore classical Ed25519 only.
- **That a relayer will submit.** Anyone can relay, but nobody has to. A missing or old record means "not known", not "safe". Readers decide their own policy: a strict policy blocks tokens with no record, and a lenient one only blocks a known `high`.

**Who can do what.**

| actor | can | cannot |
|---|---|---|
| relayer or any wallet | pay to write a record that an active key signed | invent or alter a record, roll a record back, or write over a revoked record |
| attestor key (site server) | sign records | change the authority or the attestor list. A stolen key can write false records until it is revoked. |
| authority (Squads vault) | revoke and restore records, rotate or revoke keys, pause, hand over authority | write or alter a record's content. Only the attestor signs content. |
| upgrade authority (Squads vault) | upgrade the program | — (this is the usual Solana trust assumption; see "Before mainnet") |

**Key compromise playbook.** As a Squads proposal, call `set_attestors` with
the stolen key set to `revoked` and a new active key. Every record the
stolen key signed then reads as untrusted at once (see `reader::evaluate`).
Re-sign the affected subjects with the new key. A newer `audited_at`
replaces them; a record the attacker stamped with a far-future time is
limited by the 300-second skew check. If needed, `revoke_record` the
affected records, then `restore_record` and rewrite them.

**Known limits.**

- A key removed from the list (instead of set to `revoked`) reads as "unknown", which is also untrusted. Keep retired keys **listed** while their records matter.
- A revoked key that was removed from the list could be added back as a "new" key. That is an authority (multisig) decision, recorded in the `AttestorsUpdated` event.
- Records are never closed. Their rent stays locked. A future `close_record` could return it.
- The registry holds only `kind = "contract"` attestations. Transaction checks are not indexed by subject.

## 4. Reading a level

### TypeScript (wallet, DEX front-end, bot)

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

const REGISTRY = new PublicKey("<registry program id>");
const LEVEL = ["info", "low", "medium", "high"] as const;
const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

export function recordPda(chainId: number, address: string) {
  const hash = createHash("sha256").update(Buffer.from(address, "utf8")).digest();
  return PublicKey.findProgramAddressSync([Buffer.from("audit"), u16le(chainId), hash], REGISTRY)[0];
}

/** null = no record (unknown). Lowercase EVM addresses first. */
export async function auditLevel(conn: Connection, chainId: number, address: string) {
  const info = await conn.getAccountInfo(recordPda(chainId, address), "confirmed");
  if (!info || !info.owner.equals(REGISTRY)) return null;
  const d = info.data;
  return {
    level: LEVEL[d[12]],
    revoked: d[13] === 1,
    auditedAt: new Date(Number(d.readBigInt64LE(126)) * 1000),
    ed25519KeyId: d.subarray(118, 126).toString("hex"),      // check against Config.attestors
    payloadHash: "0x" + d.subarray(78, 110).toString("hex"),  // fetch + verify the full attestation off-chain
  };
}

// e.g. a Solana mint:  await auditLevel(conn, 6, mint.toBase58())
```

To decide whether to **trust** a record, also read the Config (with the IDL,
`program.account.config.fetch(configPda)`) and check that the record's
`ed25519KeyId` belongs to an attestor with status 1 or 2, and that the
record is not revoked. This is the same logic as `reader::evaluate`.
`getProgramAccounts` with a `memcmp` on offset 12 (level) or offset 10
(chain_id) lists, for example, every `high` record.

### Rust: a program that blocks level ≥ high

```toml
# Cargo.toml of the calling program
swd_audit_registry = { git = "https://github.com/pospos191-alt/swd-amm", features = ["cpi"] }
```

```rust
use swd_audit_registry::{message::LEVEL_HIGH, reader};

#[derive(Accounts)]
pub struct Buy<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: verified by reader::trusted_level (owner + PDA + discriminator)
    pub audit_config: UncheckedAccount<'info>,
    /// CHECK: verified by reader::trusted_level (may be an empty, never-written PDA)
    pub audit_record: UncheckedAccount<'info>,
    // ...
}

pub fn buy(ctx: Context<Buy>) -> Result<()> {
    let mint = ctx.accounts.mint.key().to_string();
    let level = reader::trusted_level(
        &ctx.accounts.audit_config.to_account_info(),
        &ctx.accounts.audit_record.to_account_info(),
        6, // sol
        mint.as_bytes(),
    )?; // Err if someone passed a fake account
    if let Some(l) = level {
        require!(l < LEVEL_HIGH, MyError::HighRiskToken);
    }
    // None = no trusted record: allow, or block if your policy is strict
    Ok(())
}
```

No CPI is needed: reading the record is a plain account read. The `cpi`
feature only turns off the registry's entrypoint so it links as a library.

## 5. How the site will write records

This is not implemented in the site yet. The intended design reuses the memo
anchor's queue pattern (`lib/audit/attest-anchor.ts`):

1. **Sign.** When `runAudit` produces a `kind: "contract"` attestation for a chain in the table above, the server also signs `record_message(REGISTRY_CONFIG_PDA, …)` with **the same Ed25519 audit key** (`lib/audit/attest.ts`). The fields are: `chain_id` from the table, `sha256(normalized address)`, the level, the verdict, `payloadHash`, both key ids as 8 bytes (the hex part of `mldsa44-…` / `ed25519-…`), and `audited_at` = `observedAt` in unix seconds. Only the **signature** and the fields are queued, never the key.
2. **Queue.** Store it in KV, one entry per (chain, address), keeping only the newest `audited_at`.
3. **Relay.** A cron job (for example every 15 minutes, the same cadence as the memo flush) sends one transaction per record: `[Ed25519 instruction, upsert_record]`. The fee payer is a **dedicated relayer wallet** (e.g. `AUDIT_REGISTRY_RELAYER_SECRET`, and never a project or claim wallet, the same rule as `forbiddenWallets`). The cron also needs a daily cap and a minimum balance. Treat `StaleRecord` as "already done".
4. **Per-audit write (optional).** For a subject that is not yet in the registry, the API can relay at once. Updates wait for the cron.

Because the signature is what counts, anyone can run a relayer: a DEX that
wants fresh data can relay signed records it fetches from the site.

## 6. Costs

| item | lamports | SOL (≈ USD at $150/SOL) |
|---|---|---|
| Record rent, Solana mint (190 B) | 2,213,280 | 0.00221 (≈ $0.33) |
| Record rent, EVM address (188 B) | 2,199,360 | 0.00220 |
| Record rent, max 200-byte address (346 B) | 3,299,040 | 0.00330 |
| Config rent (284 B, once) | 2,867,520 | 0.00287 |
| Fee per upsert (1 tx signature + 1 Ed25519 precompile signature) | 10,000 | 0.00001 |

Rent = (128 + size) × 3,480 lamports/byte-year × 2 years (the rent-exempt
minimum). The relayer pays rent once per new subject. Updates cost only the
fee. The transaction size is about 810 bytes for a Solana mint, so there is
**one record per legacy transaction**. Two records fit only in a v0
transaction with an address lookup table.

So 1,000 audited tokens cost about 2.2 SOL of one-time rent, plus 0.01 SOL
per 1,000 updates.

## 7. Tests

- `cargo test -p swd_audit_registry` (18 unit tests): the message layout and golden vector, every field changing the message, the domain tag separation, key-id and sha256 vectors, the chain table, address normalization, the Ed25519 instruction parser (count, foreign offsets, bounds), PDA derivation, the Record and Config byte sizes and offsets, the rent figures above, the attestor rotation rules, `reader::evaluate`, and `reader::load_record` / `load_config` against fake accounts (wrong owner, wrong PDA, wrong discriminator, never-written PDA).
- `tests/swd_audit_registry.ts` (`anchor test`, run in CI): upgrade-authority-only initialize; a relayer that is not the authority writes a record; update; no rollback (including a replay by another relayer); a missing or misplaced Ed25519 instruction; an unknown key; a tampered field; a signature for another registry; a wrong key id; a forged signature (fails in the precompile); foreign offsets; address, hash, chain, level and time checks; the Ed25519 instruction found by position; pause; revoke and restore; key rotation (retired keys cannot sign, revoked keys are final); the two-step authority hand-over; reading the level byte by PDA.

## 8. Deploy: devnet, then mainnet via Squads

**Devnet**

```bash
solana-keygen new -o target/deploy/swd_audit_registry-keypair.json
anchor keys list        # paste the id into declare_id! and Anchor.toml (both clusters)
anchor build -p swd_audit_registry
solana program deploy target/deploy/swd_audit_registry.so \
  --program-id target/deploy/swd_audit_registry-keypair.json --url devnet
# initialize (the deployer = upgrade authority), with the DEVNET audit key as attestor
# then run the relayer against devnet for a week; compare records with the site
```

CI's manual "deploy to Devnet" job only deploys `swd_amm` (`anchor deploy -p
swd_amm`). The registry is deployed by hand as shown above, until it has its
own job and secrets.

**Mainnet** (same gates as `docs/MAINNET_RUNBOOK.md`)

1. **Independent audit** of `programs/swd_audit_registry` (it is small: about 900 lines including comments, plus 400 lines of unit tests). Freeze the commit.
2. Use fresh keys: a one-time deployer, a **new** mainnet audit Ed25519 key (not the devnet one), and a relayer wallet holding only fee and rent money.
3. Build with `solana-verify build` (verified build, Gate 7b) and deploy with the one-time deployer.
4. `initialize(authority = <SQUADS VAULT PDA>, attestors = [{mainnet audit key, active}])`, signed by the deployer, which is still the upgrade authority.
5. `solana program set-upgrade-authority <ID> --new-upgrade-authority <SQUADS VAULT PDA>`.
6. Verify on-chain: `config.authority == vault`, `program show` lists the vault as authority, and the attestor list is correct.
7. From then on, `set_attestors`, `revoke_record`, `set_paused` and upgrades are Squads proposals (2 of 3).
8. Publish the program id, the Config PDA and the attestor key ids on the site, next to `/api/audit/attest/keys`.

## Before mainnet

- [ ] Independent audit and fixes re-reviewed
- [ ] Devnet run, with the site relayer writing records for at least a week
- [ ] Verified build hash published
- [ ] Squads vault is both the authority and the upgrade authority
- [ ] Mainnet audit key generated fresh, its key id published, and the relayer wallet isolated
