**English** | [ภาษาไทย](SWD_MINE.th.md)

# SWD Mine — on-chain verified mining payouts

`programs/swd_mine` pays SWD (SAWASDEE COIN, mint
`Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL`, classic SPL Token, 5
decimals) for browser proof-of-work **without a hot wallet**.

> **Status (2026-11-06): UNAUDITED DRAFT. Not deployed on any cluster.**
> Order: localnet tests (CI) → devnet → **independent audit** → mainnet
> through Squads. Do not put real SWD in a vault before the audit.

## Why

Today the site (`swd-claim-site`, `lib/mine/swd-server.ts`) checks proofs
off-chain, keeps balances in KV and pays withdrawals by **co-signing with a
hot mining wallet** whose secret key (`MINE_WALLET_SECRET_KEY`) lives on the
web server. Whoever steals that key takes everything in the mining wallet,
and every balance is only as true as the KV database.

With `swd_mine`:

- The SWD sits in a **vault token account owned by a program PDA**. No
  private key can move it; only `claim` (to the miner who earned it) and
  `withdraw_unused` (to the authority, while paused) can.
- The website keeps **one** secret: an Ed25519 **challenge-signer** key that
  holds no funds. It decides *who gets a challenge* (IP limits, sybil and
  reputation rules stay off-chain, where they can see IPs). The program
  decides *whether a proof is paid*: signature, expiry, single use, work,
  per-wallet and site-wide daily caps, total budget.
- Balances are on-chain (`Miner` PDA per wallet) and every change emits an
  event, so anyone can audit the totals.

## Design

### Accounts

| Account | Seeds | Contents |
|---|---|---|
| `Config` | `["config"]` | authority, pending_authority, guardian, mint, vault, challenge_signer, difficulty_bits, reward_per_proof, wallet_daily_cap, site_daily_cap, total_budget, max_challenge_ttl_secs, mining_paused, claims_paused, total_credited, total_claimed, total_proofs, site_day, site_day_credited |
| vault | `["vault"]` | SPL token account for `mint`, **owner = Config PDA** |
| `Miner` | `["miner", wallet]` | wallet, accrued (claimable), total_mined, total_claimed, proofs, last_seq, day, day_credited |

### Challenge (signed by the website)

```
msg = "SWDMINE1"            8 bytes  domain tag
   || program_id           32        binds to this deployment
   || wallet               32        binds to the miner
   || seq       u64 LE      8        single-use counter (see below)
   || bits      u8          1        difficulty of THIS challenge
   || expires_at i64 LE     8        unix seconds
                           89 bytes
```

The site signs `msg` with the challenge-signer key (plain Ed25519) and
gives the browser `(seq, bits, expires_at, signature)`.

### Work

```
prefix = sha256("SWDMINE1\0" || msg || wallet) || sha256("SWDMINE1\1" || msg || wallet)[0..28]   (60 bytes)
proof  = sha256(prefix || nonce as u64 big-endian)                                              (68-byte message)
valid  ⇔ leading_zero_bits(proof) ≥ bits
```

This is sha256 over (challenge, wallet, nonce), shaped as the same
60-byte-prefix + 8-byte-nonce message the site's Web Workers already search
(`lib/mine/hub/mine-core.js`), so the fast midstate search is reused
unchanged — only the prefix derivation changes. A cross-language test
vector is in `logic.rs` (`pow_cross_language_vector`) and is reproduced by
`tests/swd_mine.ts`'s helpers and by plain Python `hashlib`.

### `submit_proof(seq, bits, expires_at, nonce)` — one transaction

```
ix 0: Ed25519 precompile (pubkey = challenge signer, signature, msg)   // Ed25519Program.createInstructionWithPublicKey
ix 1: swd_mine.submit_proof                                           // signed by the wallet
```

Checks, in order:

1. not `mining_paused`;
2. **signature**: the instruction right before (read through the
   instructions sysvar) is the Ed25519 program, has no accounts, carries
   exactly one signature with every data offset inside itself
   (instruction index `u16::MAX` — the classic introspection bug is
   accepting other indexes), its public key is `config.challenge_signer`
   and its message equals `msg` rebuilt from the arguments and the
   **signing wallet**. The runtime has verified the signature itself;
3. `bits ≥ config.difficulty_bits` (raising the difficulty retires easier
   challenges), `now < expires_at`, `expires_at − now ≤ max_challenge_ttl_secs`;
4. **single use**: `seq > miner.last_seq`;
5. **work**: ≥ `bits` leading zero bits;
6. **caps** (UTC day = `unix_ts div 86400`, checked math):
   wallet day ≤ `wallet_daily_cap`, site day ≤ `site_daily_cap`,
   `total_credited ≤ total_budget`;
7. credits `reward_per_proof` to `miner.accrued`, sets `last_seq = seq`,
   emits `ProofAccepted`.

The wallet pays the fee and, on its first proof, the `Miner` rent
(~0.0016 SOL, one time).

**Single use — why a per-wallet sequence and not a PDA per challenge.** A
PDA per challenge costs every proof ~0.001 SOL of rent plus a later close
transaction; a bitmap needs epoch bookkeeping. Instead each `Miner` keeps
`last_seq` and a challenge must carry a larger `seq`. That costs no extra
rent and no cleanup. The site must issue strictly increasing `seq` per
wallet (e.g. `max(now_ms, last_issued + 1)`); if two challenges are out at
once, using the newer one retires the older one — the page already asks
for one challenge at a time. `Miner` is never closed, because closing would
reset `last_seq` and the day counter.

### `claim()`

Transfers the wallet's whole `accrued` from the vault (Config PDA signs) to
the wallet's own SWD associated token account (created if missing — the
wallet pays the rent and the fee). Fails with `VaultInsufficient` if the
vault is under-funded (balances stay, nothing is lost) and with
`ClaimsPaused` when paused. Accrue-then-claim batches many rewards into one
token transfer.

### Admin

| Instruction | Who | Notes |
|---|---|---|
| `initialize(authority, guardian, challenge_signer, params)` | program **upgrade authority** only (ProgramData) | stops a deploy front-run; `--features mainnet` build also requires the SWD mint |
| `set_params(params)` | authority | bits 16–40, reward > 0, wallet cap ≥ reward, site cap ≥ wallet cap, budget ≥ reward and ≥ already credited, TTL 60–86400 s |
| `set_paused(mining, claims)` | authority | |
| `emergency_pause()` | guardian or authority | sets both flags; the guardian can never un-pause |
| `set_challenge_signer(pk)` | authority | old challenges die at once |
| `set_guardian(pk)` | authority | |
| `transfer_authority(pk)` / `accept_authority()` | authority / new authority | two-step |
| `withdraw_unused(amount)` | authority | only while **mining is paused**; destination must be an SWD account **owned by the authority**; limited to `vault − (credited − claimed)` (miner balances stay reserved) unless claims are paused too (emergency) |

Events: `Initialized`, `ProofAccepted`, `Claimed`, `ParamsUpdated`,
`PausedSet`, `ChallengeSignerSet`, `GuardianSet`,
`AuthorityTransferStarted`, `AuthorityTransferred`, `UnusedWithdrawn`.

No instruction moves lamports other than rent the signer pays for its own
new accounts.

## Threat model

| Threat | What stops it |
|---|---|
| Bots / farms | They need a challenge, and the website only signs challenges under its IP, sybil and reputation rules. Each challenge pays at most once, needs real work and expires. |
| Stealing someone's proof from the mempool | The challenge and the work are bound to the wallet, and the wallet must sign `submit_proof`. |
| Replay | `seq` must increase per wallet; `program_id` is in the message. **Use a different challenge-signer key per cluster** (devnet vs mainnet), in case both deployments share a program id. |
| Forged signature check | Ed25519 introspection accepts only the instruction right before, the Ed25519 program id, one signature, all offsets inline (`u16::MAX`), the configured key, the exact message. Unit tests cover the parser. |
| Fake vault / mint / destination | `has_one` + PDA seeds on config, vault and mint; ATA constraints for claims; authority-owned destination for withdrawals. |
| Overflow | Checked math everywhere, `overflow-checks = true` in release; `credit` is pure and all-or-nothing. |
| Deploy front-run of `initialize` | Only the program's upgrade authority may initialize. |
| Malicious upgrade | Upgrade authority = Squads vault (2-of-3), like swd_amm. |

### If the challenge-signer key leaks

The key is on the web server, so assume it can leak. An attacker with it can
sign challenges for **as many wallets as they like**, skipping the site's
IP/sybil rules. They still **cannot**:

- skip the work — every proof needs ≥ `difficulty_bits` (16–40) on-chain;
- exceed `wallet_daily_cap` per wallet per day;
- exceed **`site_daily_cap` per day in total** — this is the real bound;
- exceed `total_budget` overall;
- take more than the vault holds (keep the vault funded in tranches);
- touch the vault, params, pause flags or anyone else's balance.

**Worst case before anyone reacts ≈ `site_daily_cap` × days unnoticed**,
never more than `min(total_budget − total_credited, vault balance)`. Keep
`site_daily_cap` small (close to the real daily emission) and watch
`ProofAccepted` (a sudden jump in distinct wallets per day is the signal).

Response:

1. guardian: `emergency_pause` (mining + claims) — one signature, no
   multisig wait;
2. Squads: `set_challenge_signer(new key)`; rotate the server secret;
3. decide about fraudulent balances: claims stay paused while you look;
   `withdraw_unused` can move the vault to the authority while both flags
   are on; then fund a fresh vault amount and `set_paused(false, false)`.

Other residual risks: the authority (Squads) can drain the vault while
paused — the same trust as the program's upgrade authority, which could do
anything anyway; a wallet-side bug in the site could let users get
challenges they shouldn't (bounded by the same caps).

## Deploy

### Devnet first

```bash
solana-keygen new -o target/deploy/swd_mine-keypair.json   # never commit it (gitignored)
anchor keys list   # paste swd_mine's id into Anchor.toml AND declare_id! in programs/swd_mine/src/lib.rs
anchor build -p swd_mine
anchor deploy -p swd_mine --provider.cluster devnet
```

Then, from the upgrade-authority wallet: create a devnet test mint,
generate a **devnet-only** challenge-signer key, call `initialize` with
`authority` = your wallet, `guardian` = an on-call key, small params
(e.g. 20 bits, 1 SWD reward, 20 SWD wallet cap, 500 SWD site cap), fund the
vault, and point a preview deployment of the site at it (flag below). Run
for at least a week: real browsers, the caps, pause/unpause, signer rotation,
`withdraw_unused`.

### Mainnet (after the independent audit)

1. Build the audited commit with `anchor build -p swd_mine -- --features mainnet`
   (rejects any mint but SWD) and record `sha256sum target/deploy/swd_mine.so`;
   publish a verified build the same way as `scripts/verified-build.sh` does
   for swd_amm.
2. Deploy with the one-time deployer key; **immediately** `initialize`
   (only the upgrade authority can) with `authority` = the **Squads vault
   PDA**, `guardian` = the on-call emergency key (not a Squads member),
   `challenge_signer` = a fresh mainnet key, conservative params.
3. `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SQUADS_VAULT_PDA>`
   and check with `solana program show`.
4. Fund the vault from the treasury by Squads proposal, in tranches (e.g.
   one month of `site_daily_cap`), never the whole budget at once.
5. Every later `set_params` / `set_paused` / `set_challenge_signer` /
   `withdraw_unused` is a Squads proposal (2 of 3).

## Website switch (site repo — described here, not implemented)

Behind a flag, e.g. `MINE_ONCHAIN=1` with `MINE_PROGRAM_ID` and
`MINE_CHALLENGE_SIGNER_KEY` (Ed25519 secret; replaces `MINE_POW_SECRET` and,
at the end, `MINE_WALLET_SECRET_KEY`):

- **challenge**: the route keeps all its checks (wallet proof, IP day cap,
  reputation cap, sybil heuristics). Because submissions now go straight to
  the chain, the IP / reputation caps are applied **when issuing**: count
  challenges issued per IP / wallet per day (one challenge = at most one
  reward). It answers `{seq, bits, expiresAt, sig}`; `seq` strictly
  increasing per wallet.
- **workers**: unchanged; only `minePrefix` changes to the formula above.
- **submit**: the page builds `[Ed25519 ix, submit_proof]`, the wallet
  signs and pays; the server is no longer involved.
- **balance / history**: read the `Miner` PDA and the program's events.
- **withdraw**: replaced by one `claim` transaction the wallet signs.
- **migration**: stop issuing off-chain challenges; let existing KV
  balances be withdrawn with the old flow for a fixed window; then move what
  is left in the hot mining wallet to the vault and delete
  `MINE_WALLET_SECRET_KEY`. The program has no "admin credit" instruction
  on purpose.

## Tests

- `cargo test -p swd_mine` — pure logic (`src/logic.rs`): leading-zero bits
  at every bit position, UTC day buckets, challenge checks, params
  validation, caps/budget/overflow math, withdrawable amount, Ed25519
  instruction parser (good layout, other instruction indexes, bad shapes),
  a cross-language PoW vector.
- `tests/swd_mine.ts` (`anchor test`, run by CI's program job) — real
  Ed25519-signed challenges and real PoW at 16 bits: initialize guard,
  missing/wrong signature, other-wallet challenge, expired / too-long /
  too-easy challenges, weak work, accrual, replay, wallet / site caps,
  claim to a fresh ATA, admin auth and param validation, budget, signer
  rotation, pause + `withdraw_unused` limits, guardian pause, two-step
  authority handover.
