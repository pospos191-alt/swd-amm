> ภาษาไทย: [SWD_AUDIT_COURT.th.md](SWD_AUDIT_COURT.th.md)

# SWD Audit Court — community disputes of SWD Audit results

> **Status: UNAUDITED DRAFT, NOT DEPLOYED.** It needs an independent audit
> before mainnet ("Before mainnet" below). Program: `programs/swd_audit_court`.
> Tests: `programs/swd_audit_court/src/logic.rs` (Rust unit tests),
> `tests/swd_audit_court.ts` (local validator).

## Why

SWD Audit results are signed by the SWD attestor keys and stored by the SWD
Audit Registry (`programs/swd_audit_registry`, docs/SWD_AUDIT_REGISTRY.md).
The court lets the community challenge a result with money on the line,
decides by badge-weighted vote, and records the ruling on-chain. It **does not
write to the registry** (another program, not deployed): it stores the ruling
and emits `DisputeResolved`; the registry's authority applies it there.

## Flow

1. **`open_dispute(chain_id, address_hash, disputed_payload_hash, claimed_level, evidence_hash)`**
   — anyone; transfers `bond_amount` SWD into a per-dispute vault. The subject
   is named exactly like the registry names it: `chain_id` (u16, the
   registry's chain list) and `address_hash = sha256(normalized address)`.
   The court derives and stores the registry's Record PDA
   `["audit", chain_id LE, address_hash]` under the configured registry program
   id (it never reads or writes it). `disputed_payload_hash` pins which
   attestation is disputed; `claimed_level` (0..3 or 255 = none) is what the
   opener says is right; `evidence_hash` = sha256 of an evidence document
   published off-chain.
2. **`defend`** (optional) — one defender posts the same bond during voting.
3. **`vote(support)`** — badge holders, during the voting period. One
   `VoteRecord` PDA per (dispute, voter) makes a second vote impossible. The
   opener and the defender cannot vote.
4. **`finalize`** — anyone, after `voting_ends_at`:
   - `yes + no < quorum` → **NoQuorum**: everyone refunded;
   - `yes / (yes + no) > pass_bps` (strict) → **Upheld**;
   - otherwise → **Rejected**.
   The winner's bond comes back; the loser's bond is split: `winner_share_bps`
   to the winner, the rest to the treasury. A rejected dispute with no
   defender sends the opener's bond to the treasury. The vault's rent goes back
   to the opener; any tokens donated to the vault go to the treasury (so a
   donation cannot block the vault from closing).
5. The registry authority acts on `DisputeResolved { status = 1 (Upheld), record, … }`
   and may call **`mark_applied`** to record that it did.

## Badge verification (soulbound votes)

A voter passes its Token-2022 badge **token accounts** as remaining accounts.
For each one the program checks:

- owned by the Token-2022 program and parses as a token account;
- `owner == voter`, `amount >= 1`;
- `mint ∈ config.badges`;
- it carries the `NonTransferableAccount` extension (Token-2022 adds it to every
  account of a `NonTransferable` mint).

When the admin configures badge mints, each **mint** account must be a
Token-2022 mint with the `NonTransferable` extension (`BadgeNotSoulbound`
otherwise). Mint extensions cannot be removed, so this holds forever.

Weight = sum of the weights of the **distinct** badge mints proven (passing the
same mint twice counts once). Weights 1..1000, at most 8 badge mints.

## Accounts and costs

| account | seeds | size | rent | lifetime |
| --- | --- | --- | --- | --- |
| `Config` | `["court"]` | 484 B | ~0.0043 SOL | permanent (deployer) |
| `Dispute` | `["dispute", id u64 LE]` | 312 B | ~0.0031 SOL | permanent — it is the ruling record (opener pays) |
| vault (SPL token account) | `["vault", dispute]` | 165 B | ~0.0020 SOL | closed at finalize / cancel, rent → opener |
| `VoteRecord` | `["vote", dispute, voter]` | 90 B | ~0.0015 SOL | voter closes it after the ruling (`close_vote`) |

Opening a dispute therefore costs the bond + ~0.005 SOL (0.002 back at the
end). Program size ~510 KB → ~3.5 SOL of program-account rent.

Each dispute **snapshots** bond, quorum, `pass_bps`, `winner_share_bps` and the
treasury owner when opened, so config changes never move an open dispute's
goalposts.

## Admin (Squads vault)

| instruction | effect |
| --- | --- |
| `initialize(params)` | once, by the program's **upgrade authority** only (ProgramData check, no front-running of a fresh deploy); sets the admin |
| `update_config(params)` | bond, voting period, quorum, pass_bps, winner share, treasury owner, registry id, badge list; for future disputes |
| `set_paused(bool)` | pauses `open_dispute`, `defend`, `vote`; **never** `finalize` |
| `propose_admin` / `accept_admin` | two-step hand-over |
| `cancel_dispute` | while voting; **refunds everyone in full** |
| `mark_applied` | Upheld only, once; informational |

Bounds in code: bond > 0; voting period 5 s .. 30 days (the `mainnet` feature
raises the minimum to **3 days** and accepts only the SWD mint as bond mint);
quorum > 0; `pass_bps` 5000..9000; `winner_share_bps` ≤ 10000; 1..8 badges.

## Trust model

- **No one can take a bond.** Bonds leave the vault only by `finalize`
  (rule-based payout to the opener / defender / treasury ATAs) or
  `cancel_dispute` (full refund). The payout always sums to exactly the escrow
  (unit-tested over many values).
- Payouts go to **associated token accounts** of the opener, defender and
  treasury owner; if one was closed, anyone can recreate it and finalize still
  works — nobody can block a ruling by closing an account.
- **Badge issuers are trusted**: whoever holds a badge mint's mint authority
  can mint badges to many wallets (Sybil votes). Pick badge mints whose
  issuance is itself controlled (e.g. by the Squads vault, with a policy).
- **Admin powers** that matter: cancel a dispute (refund, no loss — but it is
  censorship), pause (votes stop; a paused dispute can end NoQuorum → refund),
  change the badge list (affects votes cast afterwards). Use Squads.
- **Program upgrade authority** can change everything; Squads + timelock.
- The court does not verify that the registry record exists (the registry is
  not deployed); a dispute on a non-existent record simply wastes the opener's
  bond if rejected.

## Known limits

- Votes are public and immediate (no commit–reveal): late voters see the tally.
- No appeal, no re-vote; a new dispute can be opened (new bond).
- Several disputes on the same subject can run at once; the registry authority
  decides what to do with multiple rulings.
- Bond mint is a classic SPL token (SWD). A Token-2022 bond mint is not
  supported (transfer fees would break the escrow math).
- If the bond mint had a freeze authority and froze an ATA, finalize would fail
  for that dispute (SWD has no freeze authority).

## Deploy (devnet)

```bash
anchor build -p swd_audit_court
solana-keygen new -o target/deploy/swd_audit_court-keypair.json   # once; keep it safe
anchor keys list   # paste the id into declare_id! in lib.rs AND Anchor.toml (both sections)
anchor build -p swd_audit_court
anchor deploy -p swd_audit_court --provider.cluster devnet   # deployer = upgrade authority
```

Then, from the deployer (the upgrade authority), call `initialize` with
`admin` = the devnet Squads vault (or a test key), the devnet SWD stand-in mint
as bond mint, the registry program id (any id until the registry is deployed),
and the badge mint accounts as remaining accounts. The CI deploy job deploys
only `swd_amm` (`anchor deploy -p swd_amm`).

Mainnet build: `anchor build -p swd_audit_court -- --features mainnet`.

## Tests

- `cargo test -p swd_audit_court` — outcome (quorum, strict majority,
  supermajority, no overflow), payout conservation over many values, payout
  cases, parameter bounds, distinct-mint weights, account sizes, Record PDA =
  registry seed scheme.
- `tests/swd_audit_court.ts` (in `anchor test`) — upgrade-authority-only
  init, bounds, non-soulbound badge mint refused, update_config, open (escrow +
  Record PDA), defend, weighted votes, one vote per voter, opener cannot vote,
  no badge / someone else's badge / unconfigured mint / classic token account
  refused, voting period, cancel (refund), pause (finalize still works),
  NoQuorum / Upheld / Rejected payouts and balances, vault donation cannot
  block finalize, wrong payout accounts refused, mark_applied, close_vote, admin
  hand-over.

## Before mainnet

- Independent audit of this program.
- Admin and upgrade authority = Squads vault (timelock).
- Decide bond size, voting period (≥ 3 days), quorum and badge weights with the
  community; publish them.
- Registry side: a documented procedure for applying an Upheld ruling (re-audit
  → new signed record), and `mark_applied` after it.
