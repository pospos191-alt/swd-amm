> ภาษาไทย: [SWD_LAUNCH_GUARD.th.md](SWD_LAUNCH_GUARD.th.md)

# SWD Launch Guard — Token-2022 transfer-hook anti-bot

> **Status: UNAUDITED DRAFT, NOT DEPLOYED.** It needs an independent audit
> before mainnet ("Before mainnet" below). Program: `programs/swd_launch_guard`.
> Tests: `programs/swd_launch_guard/src/logic.rs` (Rust unit tests),
> `tests/swd_launch_guard.ts` (Token-2022 transfers on a local validator).

## Why

Bots buy the first seconds of a launch from the pool, in size, from fresh
wallets. A Token-2022 **Transfer Hook** lets the mint run a program on every
transfer. This program uses that for a short, bounded **launch window** only:
it slows down buying from the launch's own wallets (pools, creator) and then
switches itself off for good. It is built for tokens from the SWD Token-2022
launcher (site repo `lib/create-token/token2022.ts`), which today does **not**
add a TransferHook (`FORBIDDEN_T22_EXTENSIONS`); see "Launcher integration".

## The rule

During the window, a transfer is **restricted** only if

```
source token account's owner ∈ launch_wallets   (a pool-vault authority, the creator)
AND destination token account's owner ∉ launch_wallets
```

A restricted transfer must satisfy, for the destination owner's `Recipient`
record (which must exist — see "Why pre-registration"):

| check | error |
| --- | --- |
| `amount <= max_per_transfer` | `OverPerTransferCap` |
| `received + amount <= max_per_wallet` (whole window) | `OverPerWalletCap` |
| `now >= last_receive_ts + cooldown_secs` (after the first receipt) | `CooldownActive` |
| a `Recipient` exists for the destination owner | `RecipientNotRegistered` |
| `now >= launch_ts` (buys open at launch) | `NotOpenYet` |

Everything else passes without any check:

- **Any transfer whose source is not a launch wallet** — every **sell**
  (holder → pool), every holder → holder transfer, in every phase, of any
  size. The hook never looks at the source's balance and never refuses a
  transfer out of a holder's wallet.
- launch wallet → launch wallet (creator adds liquidity, pool ↔ pool);
- **after `window_end` — every transfer**; the hook returns right after
  reading its config (measured: ~4.7k CU for the hook, vs ~7.9k inside the
  window).

## Anti-honeypot guarantees (enforced in code)

| guarantee | how |
| --- | --- |
| The window is at most **24 h** | `window_secs <= 86_400` at creation (`WindowTooLong`) |
| The window starts at most **7 days** after creation | `launch_ts <= now + 7d` (`LaunchTooFar`) |
| Nothing is ever restricted later than creation + 8 days | `window_end` is written once at creation; the only other write is `end_window`, which only moves it **earlier** (`min(window_end, now)`) |
| Limits can only get **looser** | `relax_limits` refuses a lower cap or a longer cooldown (`NotLooser`) |
| A holder cannot be turned into a restricted source mid-launch | `add_launch_wallet` only before `launch_ts` (`LaunchStarted`); removing is always allowed |
| Sells are never blocked | restriction requires a launch-wallet **source** (`is_restricted`), proven in unit and integration tests, also above every cap, during a cooldown, and before launch |
| The account list cannot be changed later | there is no `update_extra_account_meta_list`; the Guard and the list have no close instruction |
| `execute` cannot be called directly to grief someone's counters | both token accounts must be Token-2022 accounts of this mint with the `transferring` flag set, which Token-2022 sets only while it is calling the hook (`NotInTransfer`) |

## Accounts

| account | seeds (this program) | size | rent | who pays / gets it back |
| --- | --- | --- | --- | --- |
| `ExtraAccountMetaList` | `["extra-account-metas", mint]` (fixed by the interface) | 86 B | ~0.0015 SOL | launcher, permanent |
| `Guard` | `["guard", mint]` | 382 B | ~0.0036 SOL | launcher, permanent |
| `Recipient` | `["recipient", mint, wallet]` | 126 B | ~0.0018 SOL | whoever registers (buyer / UI); refunded by `close_recipient` after the window |

`Guard`: mint, authority, created_at, launch_ts, window_end, max_per_transfer,
max_per_wallet, cooldown_secs, launch_wallets (≤ 8 owners).
`Recipient`: mint, wallet, payer, received, transfers, last_receive_ts.

### Extra accounts of `Execute`

Token-2022 passes source(0), mint(1), destination(2), owner(3), the list (4),
then what the list says:

5. `guard` = PDA `["guard", mint(1)]`, read-only
6. `recipient` = PDA `["recipient", mint(1), destination(2).data[32..64]]`, writable
   (bytes 32..64 of a token account are its owner)

Clients resolve these themselves (`createTransferCheckedWithTransferHookInstruction`
/ `addExtraAccountMetasForExecute` in `@solana/spl-token`; DEX programs do the
same on-chain). The tests use exactly that path.

## Why pre-registration

The hook runs inside Token-2022's CPI; every account is de-escalated to
non-signer, so there is no payer and the hook **cannot create** the
per-wallet tracking account. The options were:

- *amount-only caps, no state*: the per-transfer cap still works, but the
  cumulative cap and cooldown become meaningless (a bot repeats small buys);
- *pre-registration* (chosen): `register_recipient(wallet)` creates the
  wallet's `Recipient` before buying. Anyone may pay (the buyer, or the UI's
  fee payer), so the swap UI can prepend it to the buyer's first swap
  transaction. A restricted transfer to an unregistered wallet fails during
  the window. After the window, anyone can `close_recipient` and the rent goes
  back to the recorded payer.

Registration ends at `window_end`; it is not needed afterwards.

## Instructions

| instruction | who | notes |
| --- | --- | --- |
| `initialize_extra_account_meta_list(params)` | the mint's **mint authority** or its **transfer-hook authority** | creates Guard + list atomically; mint must be Token-2022 with TransferHook → this program |
| `execute(amount)` | Token-2022 | interface discriminator `sha256("spl-transfer-hook-interface:execute")[..8]` |
| `register_recipient(wallet)` | anyone (payer) | before `window_end` |
| `close_recipient` | anyone | after `window_end`; rent → recorded payer |
| `end_window` | guard authority | `window_end = min(window_end, now)` |
| `relax_limits(...)` | guard authority | only looser |
| `add_launch_wallet` / `remove_launch_wallet` | guard authority | add only before `launch_ts` |
| `set_authority(new)` | guard authority | `Pubkey::default()` renounces |

The init instruction uses Anchor's own discriminator (the interface's
`InitializeExtraAccountMetaList` carries a raw list of metas; we take typed
parameters instead and build the list ourselves). Token-2022 never calls it, so
this does not affect compatibility.

## Trust model

- **Program upgrade authority** — the biggest trust point: an upgrade could
  replace the hook with one that blocks everything. Use the Squads vault (with
  its timelock) as upgrade authority, and consider making the program
  immutable after the audit.
- **TransferHook authority on the mint** — can repoint the hook to another
  program. The launcher should set it to **none** (the tests do).
- **Guard authority (creator)** — can only end the window early, loosen
  limits, remove launch wallets, add launch wallets before launch, or
  renounce. It cannot extend the window, tighten limits, or touch balances.
- **Launch order** — until `initialize_extra_account_meta_list` runs, every
  transfer of the mint fails (Token-2022 cannot find the extra accounts). If
  the mint authority is revoked and the hook authority is none before init,
  nobody can ever init it and the token cannot move. The launcher must init the
  guard before revoking the mint authority, and the site's mint verification
  must check that the Guard exists.

## Known limits (honest)

- **Sybil**: per-wallet caps are per wallet. A bot with many funded,
  registered wallets gets many caps. Registration (~0.0018 SOL each, locked
  until the window ends) and the cooldown slow this down; they do not stop it.
- **Unlisted pools** are not restricted: a pool whose vault authority is not in
  `launch_wallets` (e.g. created after launch) can be bought from freely.
  Since launch wallets cannot be added after `launch_ts`, list all pools
  before launch (Raydium CPMM uses one vault authority for all its pools, so
  listing it covers every CPMM pool of the mint).
- **Aggregator routes** that pass tokens through an intermediate,
  program-owned account (not a launch wallet) get capped at that hop during the
  window, and need that owner registered. Direct pool swaps work.
- A launch wallet listed before launch that is actually a holder (by mistake
  or malice) has its outflows to non-launch wallets capped during the window —
  its transfers to launch wallets (pools) stay free, and only for ≤ 24 h.
- Caps compare the gross transfer amount (before any transfer fee).

## Launcher integration (site repo — described, not implemented)

1. Add `ExtensionType.TransferHook` (authority **none**, program = this id) to
   the mint's fixed extensions in TX1 and move it from
   `FORBIDDEN_T22_EXTENSIONS` to the allow-list *only when the guard is chosen*.
2. In TX3, before `SetAuthority(MintTokens → none)`, call
   `initialize_extra_account_meta_list` signed by the project wallet (the mint
   authority at that point), with `guard_authority = creator` and
   `launch_wallets = [creator, pool vault authority]`.
3. `verifyCreatedMint`: accept TransferHook only if program = this id,
   authority = none, and the Guard PDA exists with `window_end - created_at <=
   8 days`.
4. Swap UI: during the window, prepend `register_recipient(buyer)` when the
   buyer's `Recipient` PDA does not exist.

## Deploy (devnet)

```bash
anchor build -p swd_launch_guard
solana-keygen new -o target/deploy/swd_launch_guard-keypair.json   # once; keep it safe
anchor keys list   # paste the id into declare_id! in lib.rs AND Anchor.toml (both sections)
anchor build -p swd_launch_guard
anchor deploy -p swd_launch_guard --provider.cluster devnet
```

Program size ~315 KB → ~2.2 SOL of program-account rent on devnet/mainnet
(the deploy buffer is refunded). The CI deploy job deploys only `swd_amm`
(`anchor deploy -p swd_amm`), so this program is never deployed by CI.

Then on devnet: create a Token-2022 mint with TransferHook → the program id
(authority none), init the guard, and run the same transfers as
`tests/swd_launch_guard.ts`.

## Tests

- `cargo test -p swd_launch_guard` — phases, restriction rule (sells never
  restricted), caps, cooldown, overflow, 24 h / 7 day bounds, relax-only,
  end-early never extends, launch-wallet list; the Execute discriminator
  equals the interface's; the extra-account list builds.
- `tests/swd_launch_guard.ts` (in `anchor test`) — real Token-2022 transfers
  through the hook: init authority, bounds, pre-launch refusal, caps,
  cooldown, unregistered wallet, exemptions, sells/holder transfers never
  blocked (also above caps / during cooldown / before launch), direct
  `execute` refused, add-after-launch refused, relax-only, end_window, no-op
  after the window (incl. CU bound), natural window end, close_recipient,
  renounce.

## Before mainnet

- Independent audit of this program (and of the launcher changes above).
- Upgrade authority = Squads vault with timelock, or immutable.
- Decide the default window / caps with the launcher team; document them on
  the launch page so buyers see the rules before buying.
