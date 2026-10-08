// SWD AMM — a minimal constant-product (x*y=k) automated market maker for
// Solana, written for the SAWASDEE COIN (SWD) project.
//
// Reserve-tracking fix (2026-09-08) verified on localnet: 10/10 tests pass,
// including the first-depositor/donation attack test proving the fix
// works (see SECURITY.md for the exact numbers).
//
// ============================================================================
// STATUS (updated 2026-09-08): UNAUDITED DRAFT. DO NOT DEPLOY TO MAINNET.
// ============================================================================
// `anchor build` succeeds and all 9 tests in tests/swd_amm.ts pass on
// localnet (see SECURITY.md for the full, current status) — this is real
// evidence the core logic works for the scenarios tested, but it is still
// NOT a substitute for an independent human read-through or a paid
// third-party audit, neither of which has happened yet. AMM programs hold
// real pooled user funds and a single bug (integer overflow, a missing
// account check, a rounding error) can drain a pool permanently with no way
// to reverse it — this happened to Raydium itself twice (Dec 2022, ~$4.4M;
// Jun 2026, ~$1.3M) despite being a funded, audited team. See SECURITY.md in
// this directory for the full checklist and for what is still outstanding
// (arithmetic near u64::MAX, multiple concurrent pools, fuzzing
// integer_sqrt, human review, and the paid audit).
//
// SCOPE: this is a single pool TYPE (classic constant-product, like
// Raydium's original AMM v4 / Uniswap V2) — NOT a full Raydium-equivalent.
// It does not include: concentrated liquidity (CLMM), a bonding-curve
// launchpad, perpetuals, or farms/staking. Those would each be separate,
// similarly-sized efforts on top of this core.
//
// TOKEN PROGRAM SUPPORT (updated 2026-09-23, "SWDMM" scope item — see
// architecture-and-decisions.md): both classic SPL Token Program mints AND
// Token-2022 mints are now accepted BY THIS FILE'S CONSTANT-PRODUCT POOL
// ONLY, via `anchor_spl::token_interface`'s `InterfaceAccount`/`Interface`
// types (a strict superset of the old `Account<'info, Token>`-typed
// accounts — every existing classic-SPL pool keeps working unchanged).
// The DLMM pool type (dlmm.rs) is NOT touched by this change and still
// only accepts classic SPL Token mints — that account-type mismatch fails
// cleanly and explicitly at the Anchor-constraint level (not a silent
// bug) if a Token-2022 mint is ever passed to `initialize_dlmm_pool`;
// bringing DLMM up to the same support is its own deliberate follow-up,
// same "separate, similarly-sized effort" reasoning dlmm.rs's own scope
// note already uses for CLMM itself. Token-2022 mints are gated at
// `initialize_pool` time by `assert_mint_extensions_safe` (below), which
// enumerates the mint's extensions and REJECTS any that let a third party
// move funds without the owner's consent (PermanentDelegate), invoke
// unaudited third-party code on every transfer (TransferHook), hide
// amounts from this program's own pricing math (ConfidentialTransferMint),
// or can't be transferred at all (NonTransferable).
//
// TRANSFER-FEE-AWARE RESERVE ACCOUNTING ("Phase 1b", added 2026-09-23):
// `TransferFeeConfig` is now ALLOWED through the gate above — a mint
// carrying it makes a transfer of `amount` land LESS than `amount` in the
// destination (the difference is withheld on the destination account for
// later harvest by the mint's withdraw-withheld-authority; see
// `assert_mint_extensions_safe`'s doc comment for the full mechanics).
// `add_liquidity` and `swap` no longer assume "the vault receives exactly
// what a transfer instruction says it sends" — both instructions read the
// destination vault's real balance immediately before and after each
// inbound `transfer_checked` (via the `read_token_balance` helper below)
// and use that measured delta, never the nominal instruction amount, for
// every downstream number: the tracked `Pool.reserve_a`/`reserve_b`
// credit, the constant-product swap math, and (in `add_liquidity`) how
// many LP tokens get minted. This is what keeps the
// `vault.amount >= reserve` invariant (see `Pool.reserve_a`'s doc comment)
// true for a fee-bearing mint too, and specifically prevents a fee-bearing
// deposit from over-minting LP tokens relative to what actually backs the
// pool, which would otherwise silently dilute every existing LP.
// `remove_liquidity` needed NO equivalent change: a token transfer's
// SOURCE side always loses exactly the amount specified — Token-2022's
// transfer fee is deducted from what the destination receives, never
// added on top of what the source pays — so vault_a/vault_b's balance
// after paying out `amount_a`/`amount_b` to a withdrawing LP is exactly
// as predicted either way; only the withdrawing LP's own wallet may
// receive less than that nominal amount, which is between them and the
// mint's fee schedule, not a pool-solvency concern.

use anchor_lang::prelude::*;
// Explicit even though `anchor_lang::prelude::*` above already re-exports
// this trait — spelled out here because `read_token_balance` below calls
// `TokenAccount::try_deserialize(...)` via this trait's method, and an
// explicit `use` removes any doubt about it being in scope regardless of
// what a given anchor_lang version's prelude happens to re-export.
use anchor_lang::AccountDeserialize;
use anchor_spl::associated_token::AssociatedToken;
// The LP receipt token this program mints is always classic SPL Token
// (see the module doc comment above) — aliased so the bare `Mint`/
// `TokenAccount` names below can refer to the Token-2022-capable
// interface types instead, which are used for mint_a/mint_b/vault_a/
// vault_b/every trader- or depositor-supplied pool-side token account.
use anchor_spl::token::{
    burn as classic_burn, mint_to as classic_mint_to, Burn, Mint as ClassicMint, MintTo, Token,
    TokenAccount as ClassicTokenAccount,
};
use anchor_spl::token_2022::spl_token_2022::extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions};
use anchor_spl::token_2022::spl_token_2022::state::Mint as SplToken2022Mint;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};
// Pyth pull-oracle account type, used bare (`PriceUpdateV2`, not
// `oracle::PriceUpdateV2`) below in the `Swap` Accounts struct — already
// brought into scope by `pub use oracle::*;` further down this file, so
// no separate `use` is needed here (an earlier explicit `use
// oracle::PriceUpdateV2;` at this exact spot was removed 2026-09-24: it
// compiled fine but triggered a `hidden_glob_reexports` warning by
// shadowing that glob re-export with a private, non-`pub` import of the
// same name — this file's own convention, matching `dlmm`/`governance`,
// is to re-export a submodule's public items via one `pub use mod::*;`
// rather than cherry-picking individual names). See oracle.rs's module
// doc comment for why `PriceUpdateV2` is hand-implemented there instead
// of imported from the official Pyth SDK crate (a real dependency-graph
// dead end discovered 2026-09-24 via real `cargo test` runs on the user's
// own machine — no published version of that crate is compatible with
// this program's anchor-lang 0.31.1).

// DLMM (concentrated liquidity, bin-based) pool type — added 2026-09-09.
// Lives in its own module (dlmm.rs) per Anchor's standard multi-file
// pattern: the Accounts/state/error/event structs and the real instruction
// logic are defined there; the #[program] block below only re-exports thin
// wrapper functions that call into it. See dlmm.rs's module doc comment for
// this feature's full status/scope (STATUS: UNAUDITED DRAFT, same as the
// rest of this program, and even less proven — not yet exercised by any
// localnet test as of this writing).
mod dlmm;
// A GLOB re-export, not a selective one, is required here — not just for
// convenience. Anchor's `#[derive(Accounts)]` macro generates a hidden
// companion module (e.g. `__client_accounts_add_dlmm_liquidity`) alongside
// every Accounts struct it's applied to, in the SAME module scope as that
// struct (i.e. inside `dlmm`, since that's where `AddDlmmLiquidity` etc.
// are defined). The `#[program]` macro on the `swd_amm` module below then
// generates code that expects those companion modules to be reachable at
// the CRATE ROOT (`crate::__client_accounts_add_dlmm_liquidity`), not
// `crate::dlmm::__client_accounts_add_dlmm_liquidity`. A selective `pub
// use dlmm::{AddDlmmLiquidity, ...}` (an earlier version of this line)
// only re-exports the names spelled out explicitly — it does NOT pull the
// hidden companion modules along, so `anchor build`/`cargo test` fails
// with "unresolved import `crate`" pointing at `#[program]`, with a hint
// naming exactly these hidden modules (caught by the first real `cargo
// test` run, 2026-09-09 — see SECURITY.md). `pub use dlmm::*;` re-exports
// everything public from `dlmm` — hidden companion modules included —
// which is what the `#[program]` macro's generated code actually needs.
pub use dlmm::*;

// Governance layer (Squads-signed allowlist + emergency pause) — added
// 2026-09-22. Same glob-re-export reasoning as `pub use dlmm::*;` above:
// Anchor's `#[derive(Accounts)]` macro generates hidden companion
// modules inside `governance`, which the `#[program]` macro below needs
// reachable at the crate root.
mod governance;
pub use governance::*;

// Pyth pull-oracle guard + dynamic fee ("Phase 3") — added 2026-09-23.
// Same glob-re-export reasoning as `pub use dlmm::*;`/`pub use
// governance::*;` above, though this module currently defines no
// `#[derive(Accounts)]` structs of its own (its Accounts-struct-shaped
// additions live directly on `Swap`/`SwapDlmm` in this file/dlmm.rs) —
// kept a glob for consistency with this program's established pattern
// and so it stays correct if that changes later.
mod oracle;
pub use oracle::*;

// SWDMM v2 (added 2026-09-29): Meteora-DAMM-v2-style pools. Pure math in
// swdmm_math.rs (host-tested with plain `rustc --test`), accounts and
// instructions in swdmm_v2.rs, timelocked governance / protocol fees /
// mint policy in timelock.rs. Same glob re-export reasoning as above.
pub mod swdmm_math;
mod swdmm_v2;
pub use swdmm_v2::*;
mod timelock;
pub use timelock::*;

// TODO(before build): replace with the real program id.
// Generate one with `solana-keygen new -o target/deploy/swd_amm-keypair.json`
// after `anchor build` creates the target/ directory, then run
// `anchor keys list` and paste the result here AND in Anchor.toml. The
// placeholder below is the (real, well-known) System Program address —
// it is only here so this file parses; it is NOT this program's real id.
// (Fixed 2026-09-08: the previous placeholder had 41 base58 characters,
// which decodes to 41 bytes instead of the 32 a Pubkey requires — that
// caused `anchor build` to fail with "Error: String is the wrong size".
// The correct System Program address below is exactly 32 characters.)
declare_id!("3zKYYQT7LhCWLLnzbRMhTZJKmQdSwGzEghRrTyT4jdCL");

pub const POOL_SEED: &[u8] = b"pool";
pub const VAULT_A_SEED: &[u8] = b"vault_a";
pub const VAULT_B_SEED: &[u8] = b"vault_b";
pub const LP_MINT_SEED: &[u8] = b"lp_mint";

// LP decimals for every pool's LP mint. Fixed/simple on purpose.
pub const LP_DECIMALS: u8 = 6;

// Permanently locked on a pool's first deposit, mirroring Uniswap V2's
// MINIMUM_LIQUIDITY defense: without this, the very first depositor could
// deposit 1 lamport-equivalent of each token, receive a tiny LP supply,
// then have a later attacker's larger deposit rendered mathematically
// unfair by rounding at that tiny scale (classic "first depositor" /
// share-inflation attack family). These LP tokens are minted to an ATA
// owned by the POOL PDA ITSELF, and this program has no instruction that
// can ever move tokens out of an account whose authority is the pool PDA
// except add/remove_liquidity and swap acting on the POOL'S TOKEN VAULTS
// (vault_a/vault_b) — never on an LP token account — so this lock is
// permanent in practice, not just by convention.
pub const MINIMUM_LIQUIDITY: u64 = 1_000;

// Sanity ceiling only, not a promise of what any given pool actually
// charges — each pool's real fee is whatever was passed to
// initialize_pool and is stored (immutably — there is no
// set_fee/admin instruction in this program) on the Pool account.
pub const MAX_FEE_BPS: u16 = 1_000; // 10%

// Minimum amount of EACH token a pool's first deposit must supply.
// Added 2026-09-08 alongside internal reserve tracking (see `Pool.reserve_a`
// /`reserve_b` below) specifically to raise the cost of opening a pool for
// griefing purposes — before this, MINIMUM_LIQUIDITY alone still allowed a
// pool to be opened for as little as ~1,100 raw units. This is a flat,
// decimals-UNAWARE constant (it does not know a given mint has 5, 6, or 9
// decimals) — chosen as a simple, auditable floor rather than a
// per-mint-decimals-aware one, which would need this program to trust a
// mint's `decimals` field for something security-relevant. Revisit this if
// SWD pairs against a mint with drastically different decimals than the
// ~1,000,000-raw-unit assumption baked in here (see SECURITY.md).
pub const MIN_INITIAL_DEPOSIT: u64 = 1_000_000;

// Price-impact cap for constant-product swaps (added 2026-09-29, SWDMM
// spec): a single swap may not push more than half of the input-side
// reserve through the curve (impact = x / (reserve_in + x) <= 50%).
pub const CP_MAX_PRICE_IMPACT_BPS: u128 = 5_000;

#[program]
pub mod swd_amm {
    use super::*;

    /// Creates a new pool for the (mint_a, mint_b) pair. Does not take any
    /// token amounts — the first call to add_liquidity for this pool sets
    /// the initial price.
    ///
    /// UPDATED 2026-09-22: pool creation is no longer fully permissionless.
    /// Both mint_a and mint_b must have an enabled `AllowedMint` entry (see
    /// governance.rs's `set_allowed_mint`, governance-only), and global
    /// pool creation must not be paused (`GlobalConfig.pool_creation_paused
    /// == false`). This is a deliberate behavior change from this
    /// program's original "permissionless, like Raydium/Uniswap, no admin
    /// allowlist" design — see governance.rs's module doc comment for why
    /// it was added and exactly what it does and does not cover. Pools
    /// created BEFORE this change keep operating unaffected; this check
    /// only applies going forward, at creation time.
    ///
    /// NOTE: (mint_a, mint_b) and (mint_b, mint_a) derive DIFFERENT pool
    /// addresses (seeds are order-sensitive). This program does not
    /// enforce a canonical ordering on-chain, to keep this instruction
    /// simple — client code SHOULD canonicalize (e.g. sort by pubkey
    /// bytes) before calling, or two independent pools for the same pair
    /// can end up coexisting, splitting liquidity. Document this clearly
    /// wherever a frontend calls this instruction.
    ///
    /// UPDATED 2026-09-23 ("Phase 3"): a Pyth pull-oracle feed for BOTH
    /// sides of the pair, plus the dynamic-fee/guard bounds that feed
    /// enforces on every swap, are now REQUIRED at creation time and
    /// immutable afterward — same "set once, no admin-update instruction"
    /// treatment `fee_bps` already got. See oracle.rs's module doc
    /// comment for the full rationale and exactly what these five new
    /// arguments mean.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        fee_bps: u16,
        pyth_feed_id_a: [u8; 32],
        pyth_feed_id_b: [u8; 32],
        oracle_max_staleness_secs: u32,
        oracle_max_deviation_bps: u16,
        max_fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, SwdAmmError::FeeTooHigh);
        oracle::validate_oracle_params(
            &pyth_feed_id_a,
            &pyth_feed_id_b,
            oracle_max_staleness_secs,
            oracle_max_deviation_bps,
            fee_bps,
            max_fee_bps,
        )?;
        require_keys_neq!(
            ctx.accounts.mint_a.key(),
            ctx.accounts.mint_b.key(),
            SwdAmmError::IdenticalMints
        );
        require!(
            !ctx.accounts.config.pool_creation_paused,
            SwdAmmError::PoolCreationPaused
        );
        require!(ctx.accounts.allowed_mint_a.enabled, SwdAmmError::MintNotAllowlisted);
        require!(ctx.accounts.allowed_mint_b.enabled, SwdAmmError::MintNotAllowlisted);
        require_keys_eq!(
            ctx.accounts.allowed_mint_a.mint,
            ctx.accounts.mint_a.key(),
            SwdAmmError::MintNotAllowlisted
        );
        require_keys_eq!(
            ctx.accounts.allowed_mint_b.mint,
            ctx.accounts.mint_b.key(),
            SwdAmmError::MintNotAllowlisted
        );
        // Token-2022 extension gate — see `assert_mint_extensions_safe`'s
        // own doc comment for exactly what this rejects and why. A no-op
        // for classic SPL Token mints (they can't carry extensions at all).
        assert_mint_extensions_safe(&ctx.accounts.mint_a.to_account_info())?;
        assert_mint_extensions_safe(&ctx.accounts.mint_b.to_account_info())?;

        let pool = &mut ctx.accounts.pool;
        pool.mint_a = ctx.accounts.mint_a.key();
        pool.mint_b = ctx.accounts.mint_b.key();
        pool.vault_a = ctx.accounts.vault_a.key();
        pool.vault_b = ctx.accounts.vault_b.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.fee_bps = fee_bps;
        pool.bump = ctx.bumps.pool;
        // Explicit even though a freshly-`init`'d account is zeroed anyway —
        // see the doc comment on `Pool.reserve_a` for why these exist at
        // all instead of just reading `vault_a.amount`/`vault_b.amount`
        // live.
        pool.reserve_a = 0;
        pool.reserve_b = 0;
        pool.pyth_feed_id_a = pyth_feed_id_a;
        pool.pyth_feed_id_b = pyth_feed_id_b;
        pool.oracle_max_staleness_secs = oracle_max_staleness_secs;
        pool.oracle_max_deviation_bps = oracle_max_deviation_bps;
        pool.max_fee_bps = max_fee_bps;
        // Informational only — the creator recorded here has NO special
        // withdrawal power over pool funds. There is still no admin-drain
        // and no admin-set-fee instruction anywhere in this program — fees
        // remain immutable once a pool is created. As of 2026-09-22 there
        // IS a pause switch (governance.rs's emergency_pause_pool /
        // governed_unpause_pool), added deliberately and documented there,
        // not bolted on silently — see that file's module doc comment for
        // the exact centralization tradeoffs it accepts.
        pool.creator = ctx.accounts.payer.key();
        pool.swap_paused = false;
        pool.deposit_paused = false;
        pool.withdraw_paused = false;

        emit!(PoolInitialized {
            pool: pool.key(),
            mint_a: pool.mint_a,
            mint_b: pool.mint_b,
            fee_bps,
            pyth_feed_id_a,
            pyth_feed_id_b,
            oracle_max_staleness_secs,
            oracle_max_deviation_bps,
            max_fee_bps,
        });
        Ok(())
    }

    /// Adds liquidity. On a pool's first deposit (lp_mint.supply == 0),
    /// the caller's amounts set the pool's initial price and
    /// MINIMUM_LIQUIDITY is permanently locked. On every later deposit,
    /// the caller must supply tokens in (approximately) the pool's
    /// current ratio — amount_b_desired must be >= the amount the current
    /// ratio actually requires for amount_a_desired, or the call fails
    /// with SlippageExceeded rather than silently accepting an
    /// imbalanced deposit. This program does NOT refund excess — compute
    /// the exact required amount client-side before calling.
    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a_desired: u64,
        amount_b_desired: u64,
        min_lp_out: u64,
    ) -> Result<()> {
        require!(
            amount_a_desired > 0 && amount_b_desired > 0,
            SwdAmmError::ZeroAmount
        );
        require!(!ctx.accounts.pool.deposit_paused, SwdAmmError::DepositPaused);

        // Read the pool's TRACKED reserves (Pool.reserve_a/reserve_b), not
        // the vaults' live token balances (vault_a.amount/vault_b.amount).
        // This is the fix for the first-depositor/share-inflation "donation"
        // attack (see SECURITY.md, finding from 2026-09-08): a plain SPL
        // transfer straight into a vault, bypassing this instruction, no
        // longer moves the numbers this program's pricing math actually
        // uses. See the doc comment on `Pool.reserve_a` for the full
        // reasoning.
        let reserve_a = ctx.accounts.pool.reserve_a;
        let reserve_b = ctx.accounts.pool.reserve_b;
        let lp_supply = ctx.accounts.lp_mint.supply;
        let is_first_deposit = lp_supply == 0;

        // `pull_a`/`pull_b` are the NOMINAL amounts this instruction will
        // ask to move out of the depositor's own accounts — sized off
        // `Pool.reserve_a`/`reserve_b` exactly as before Phase 1b. They
        // are NOT necessarily what ends up backing the pool: see the
        // transfer-then-measure step right below.
        let (pull_a, pull_b) = if is_first_deposit {
            require!(
                amount_a_desired >= MIN_INITIAL_DEPOSIT && amount_b_desired >= MIN_INITIAL_DEPOSIT,
                SwdAmmError::InitialDepositTooSmall
            );
            (amount_a_desired, amount_b_desired)
        } else {
            require!(reserve_a > 0 && reserve_b > 0, SwdAmmError::EmptyPool);
            let required_b = mul_div(amount_a_desired, reserve_b, reserve_a)?;
            require!(
                required_b <= amount_b_desired,
                SwdAmmError::SlippageExceeded
            );
            (amount_a_desired, required_b)
        };

        // Pull funds in BEFORE minting any LP token — if either transfer
        // fails, the whole transaction reverts atomically (standard
        // Solana semantics), so there is no window where LP tokens exist
        // without the deposit actually having landed in the vaults.
        // `transfer_checked` (not the legacy `transfer`) is required by
        // Token-2022 and works identically for classic SPL Token mints too
        // (Anchor's `token_interface::transfer_checked` dispatches to
        // whichever program actually owns the accounts) — it additionally
        // takes the mint account and its `decimals`, which the classic
        // instruction didn't need. `.decimals` is read live off each
        // `InterfaceAccount<Mint>` passed into this instruction, not
        // hardcoded, so it's correct for either token program.
        //
        // "Phase 1b" (2026-09-23): each vault's balance is measured
        // immediately before and after its transfer — `amount_a`/
        // `amount_b` below are that measured delta, not `pull_a`/`pull_b`.
        // For a classic SPL Token mint, or a Token-2022 mint with no
        // transfer fee, the delta always exactly equals the nominal pull
        // amount, so this changes nothing for every pool this program has
        // ever tested against. For a `TransferFeeConfig` mint it can be
        // less — see the module doc comment's "TRANSFER-FEE-AWARE RESERVE
        // ACCOUNTING" paragraph for why using the measured amount here,
        // not the nominal one, is the whole point of this phase.
        let vault_a_before = read_token_balance(&ctx.accounts.vault_a.to_account_info())?;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program_a.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.depositor_token_a.to_account_info(),
                    mint: ctx.accounts.mint_a.to_account_info(),
                    to: ctx.accounts.vault_a.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            pull_a,
            ctx.accounts.mint_a.decimals,
        )?;
        let vault_a_after = read_token_balance(&ctx.accounts.vault_a.to_account_info())?;
        let amount_a = vault_a_after
            .checked_sub(vault_a_before)
            .ok_or(SwdAmmError::MathOverflow)?;

        let vault_b_before = read_token_balance(&ctx.accounts.vault_b.to_account_info())?;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program_b.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.depositor_token_b.to_account_info(),
                    mint: ctx.accounts.mint_b.to_account_info(),
                    to: ctx.accounts.vault_b.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            pull_b,
            ctx.accounts.mint_b.decimals,
        )?;
        let vault_b_after = read_token_balance(&ctx.accounts.vault_b.to_account_info())?;
        let amount_b = vault_b_after
            .checked_sub(vault_b_before)
            .ok_or(SwdAmmError::MathOverflow)?;

        require!(amount_a > 0 && amount_b > 0, SwdAmmError::ZeroAmount);

        // LP-token math runs on `amount_a`/`amount_b` — the MEASURED,
        // post-fee amounts that actually landed in the vaults — never on
        // `pull_a`/`pull_b`/`amount_a_desired`/`amount_b_desired`. Sizing
        // LP shares off the nominal (pre-fee) amount would over-mint
        // relative to what really backs the pool whenever a fee-bearing
        // mint is involved, silently diluting every existing LP on each
        // such deposit — closing exactly that gap is why this accounting
        // moved to after the transfer instead of before it.
        let lp_to_mint = if is_first_deposit {
            require!(
                amount_a >= MIN_INITIAL_DEPOSIT && amount_b >= MIN_INITIAL_DEPOSIT,
                SwdAmmError::InitialDepositTooSmall
            );
            let product = (amount_a as u128)
                .checked_mul(amount_b as u128)
                .ok_or(SwdAmmError::MathOverflow)?;
            let liquidity = integer_sqrt(product);
            let liquidity_u64 =
                u64::try_from(liquidity).map_err(|_| SwdAmmError::MathOverflow)?;
            require!(
                liquidity_u64 > MINIMUM_LIQUIDITY,
                SwdAmmError::InsufficientInitialLiquidity
            );
            liquidity_u64 - MINIMUM_LIQUIDITY
        } else {
            let lp_from_a = mul_div(amount_a, lp_supply, reserve_a)?;
            let lp_from_b = mul_div(amount_b, lp_supply, reserve_b)?;
            lp_from_a.min(lp_from_b)
        };

        require!(lp_to_mint >= min_lp_out, SwdAmmError::SlippageExceeded);
        require!(lp_to_mint > 0, SwdAmmError::ZeroLiquidityMinted);

        let mint_a_key = ctx.accounts.pool.mint_a;
        let mint_b_key = ctx.accounts.pool.mint_b;
        let bump = ctx.accounts.pool.bump;
        let signer_seeds: &[&[u8]] = &[POOL_SEED, mint_a_key.as_ref(), mint_b_key.as_ref(), &[bump]];
        let signer = &[signer_seeds];

        // LP mint stays classic SPL Token throughout (see the module doc
        // comment) — plain `mint_to`, no `_checked` variant needed.
        if is_first_deposit {
            classic_mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.lp_mint.to_account_info(),
                        to: ctx.accounts.pool_lp_lock.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    signer,
                ),
                MINIMUM_LIQUIDITY,
            )?;
        }

        classic_mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.depositor_lp.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            lp_to_mint,
        )?;

        // Update the TRACKED reserves to reflect exactly what was actually
        // transferred in above — this is what every future add_liquidity/
        // remove_liquidity/swap call will read, not the vaults' live token
        // balance. Any tokens someone sends directly to a vault outside
        // this instruction (a "donation") will now sit there permanently
        // uncounted — harmless to LPs' math, but also unrecoverable by the
        // sender. That tradeoff is intentional; see SECURITY.md.
        let pool = &mut ctx.accounts.pool;
        pool.reserve_a = pool
            .reserve_a
            .checked_add(amount_a)
            .ok_or(SwdAmmError::MathOverflow)?;
        pool.reserve_b = pool
            .reserve_b
            .checked_add(amount_b)
            .ok_or(SwdAmmError::MathOverflow)?;

        emit!(LiquidityAdded {
            pool: ctx.accounts.pool.key(),
            depositor: ctx.accounts.depositor.key(),
            amount_a,
            amount_b,
            lp_minted: lp_to_mint,
        });
        Ok(())
    }

    /// Burns LP tokens and returns a proportional share of both vaults.
    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_a_out: u64,
        min_b_out: u64,
    ) -> Result<()> {
        require!(lp_amount > 0, SwdAmmError::ZeroAmount);
        require!(!ctx.accounts.pool.withdraw_paused, SwdAmmError::WithdrawPaused);

        let lp_supply = ctx.accounts.lp_mint.supply;
        require!(lp_supply > 0, SwdAmmError::EmptyPool);

        // Tracked reserves, not live vault balance — see the comment in
        // `add_liquidity` and `Pool.reserve_a`'s doc comment.
        let reserve_a = ctx.accounts.pool.reserve_a;
        let reserve_b = ctx.accounts.pool.reserve_b;

        // Unlike `add_liquidity`/`swap`, this instruction needed NO "Phase
        // 1b" balance-delta measurement: `amount_a`/`amount_b` below are
        // what leaves vault_a/vault_b, and a token transfer's SOURCE side
        // always loses exactly the amount specified — Token-2022's
        // transfer fee is deducted from what the DESTINATION (the owner's
        // wallet) receives, never added on top of what the source (the
        // vault) pays. So crediting/debiting the tracked reserve with the
        // nominal `amount_a`/`amount_b` here is exactly as accurate as it
        // was before Phase 1b, for every mint. Whether `owner_token_a`/
        // `owner_token_b` receive slightly less than that (if mint_a/
        // mint_b carries a transfer fee) is between the withdrawing LP and
        // that mint's fee schedule — it does not touch this program's own
        // solvency or any other LP's share.
        let amount_a = mul_div(lp_amount, reserve_a, lp_supply)?;
        let amount_b = mul_div(lp_amount, reserve_b, lp_supply)?;

        require!(amount_a > 0 && amount_b > 0, SwdAmmError::ZeroAmount);
        require!(amount_a >= min_a_out, SwdAmmError::SlippageExceeded);
        require!(amount_b >= min_b_out, SwdAmmError::SlippageExceeded);

        // Burn BEFORE releasing any funds. LP mint stays classic SPL Token
        // throughout — plain `burn`, no `_checked` variant needed.
        classic_burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    from: ctx.accounts.owner_lp.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            lp_amount,
        )?;

        let mint_a_key = ctx.accounts.pool.mint_a;
        let mint_b_key = ctx.accounts.pool.mint_b;
        let bump = ctx.accounts.pool.bump;
        let signer_seeds: &[&[u8]] = &[POOL_SEED, mint_a_key.as_ref(), mint_b_key.as_ref(), &[bump]];
        let signer = &[signer_seeds];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_a.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_a.to_account_info(),
                    mint: ctx.accounts.mint_a.to_account_info(),
                    to: ctx.accounts.owner_token_a.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            amount_a,
            ctx.accounts.mint_a.decimals,
        )?;
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_b.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_b.to_account_info(),
                    mint: ctx.accounts.mint_b.to_account_info(),
                    to: ctx.accounts.owner_token_b.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            amount_b,
            ctx.accounts.mint_b.decimals,
        )?;

        // Mirror the withdrawal in the tracked reserves.
        let pool = &mut ctx.accounts.pool;
        pool.reserve_a = pool
            .reserve_a
            .checked_sub(amount_a)
            .ok_or(SwdAmmError::MathOverflow)?;
        pool.reserve_b = pool
            .reserve_b
            .checked_sub(amount_b)
            .ok_or(SwdAmmError::MathOverflow)?;

        emit!(LiquidityRemoved {
            pool: ctx.accounts.pool.key(),
            owner: ctx.accounts.owner.key(),
            amount_a,
            amount_b,
            lp_burned: lp_amount,
        });
        Ok(())
    }

    /// Swaps `amount_in` of one side of the pool for the other, along the
    /// constant-product curve, minus this pool's fee. `a_to_b = true`
    /// means "I'm sending mint_a, I want mint_b back".
    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_amount_out: u64, a_to_b: bool) -> Result<()> {
        require!(amount_in > 0, SwdAmmError::ZeroAmount);
        require!(!ctx.accounts.pool.swap_paused, SwdAmmError::SwapPaused);

        // Manual checks (rather than declarative Anchor account
        // constraints) because the expected mint depends on the a_to_b
        // instruction argument. Keeping every safety check for this
        // instruction here, in plain Rust, top-to-bottom, is deliberate —
        // an auditor (or you, before mainnet) should be able to read this
        // one function and see every invariant it relies on.
        require_keys_eq!(
            ctx.accounts.trader_token_in.owner,
            ctx.accounts.trader.key(),
            SwdAmmError::InvalidTokenAccountOwner
        );
        require_keys_eq!(
            ctx.accounts.trader_token_out.owner,
            ctx.accounts.trader.key(),
            SwdAmmError::InvalidTokenAccountOwner
        );

        // Tracked reserves, not live vault balance — see the comment in
        // `add_liquidity` and `Pool.reserve_a`'s doc comment. A donation
        // straight into a vault can no longer move the price a swap
        // executes at.
        let (reserve_in, reserve_out, mint_in_expected, mint_out_expected) = if a_to_b {
            (
                ctx.accounts.pool.reserve_a,
                ctx.accounts.pool.reserve_b,
                ctx.accounts.pool.mint_a,
                ctx.accounts.pool.mint_b,
            )
        } else {
            (
                ctx.accounts.pool.reserve_b,
                ctx.accounts.pool.reserve_a,
                ctx.accounts.pool.mint_b,
                ctx.accounts.pool.mint_a,
            )
        };
        require_keys_eq!(
            ctx.accounts.trader_token_in.mint,
            mint_in_expected,
            SwdAmmError::MintMismatch
        );
        require_keys_eq!(
            ctx.accounts.trader_token_out.mint,
            mint_out_expected,
            SwdAmmError::MintMismatch
        );
        require!(reserve_in > 0 && reserve_out > 0, SwdAmmError::EmptyPool);

        // "Phase 3" (2026-09-23): mandatory Pyth oracle guard + dynamic
        // fee — see oracle.rs's module doc comment. Pool spot price is
        // always expressed as "raw mint_b per raw mint_a" (independent of
        // a_to_b — see `oracle::evaluate_oracle_and_fee`'s doc comment),
        // computed from the PRE-trade tracked reserves via the same
        // Q64.64 ratio helper dlmm.rs's bin-price math already uses.
        let pool_price_q64 =
            dlmm::q64_div_amount(ctx.accounts.pool.reserve_b, ctx.accounts.pool.reserve_a as u128)?;
        let oracle_result = oracle::evaluate_oracle_and_fee(
            &ctx.accounts.price_update_a,
            &ctx.accounts.price_update_b,
            &ctx.accounts.pool.pyth_feed_id_a,
            &ctx.accounts.pool.pyth_feed_id_b,
            ctx.accounts.pool.oracle_max_staleness_secs,
            ctx.accounts.mint_a.decimals,
            ctx.accounts.mint_b.decimals,
            pool_price_q64,
            ctx.accounts.pool.fee_bps,
            ctx.accounts.pool.max_fee_bps,
            ctx.accounts.pool.oracle_max_deviation_bps,
            &Clock::get()?,
        )?;

        let (vault_in_ai, vault_out_ai, mint_in_ai, mint_out_ai, decimals_in, decimals_out, token_program_in_ai, token_program_out_ai) = if a_to_b {
            (
                ctx.accounts.vault_a.to_account_info(),
                ctx.accounts.vault_b.to_account_info(),
                ctx.accounts.mint_a.to_account_info(),
                ctx.accounts.mint_b.to_account_info(),
                ctx.accounts.mint_a.decimals,
                ctx.accounts.mint_b.decimals,
                ctx.accounts.token_program_a.to_account_info(),
                ctx.accounts.token_program_b.to_account_info(),
            )
        } else {
            (
                ctx.accounts.vault_b.to_account_info(),
                ctx.accounts.vault_a.to_account_info(),
                ctx.accounts.mint_b.to_account_info(),
                ctx.accounts.mint_a.to_account_info(),
                ctx.accounts.mint_b.decimals,
                ctx.accounts.mint_a.decimals,
                ctx.accounts.token_program_b.to_account_info(),
                ctx.accounts.token_program_a.to_account_info(),
            )
        };

        // "Phase 1b" (2026-09-23): pull the trader's NOMINAL `amount_in`
        // into vault_in first, then measure what actually landed —
        // `amount_in_net` below, not `amount_in`, is what every
        // downstream number (the constant-product math and the tracked
        // reserve credit) is computed from. For a classic SPL Token mint,
        // or a Token-2022 mint with no transfer fee, `amount_in_net` is
        // always exactly `amount_in`, so this changes nothing for every
        // pool this program has ever tested against. See the module doc
        // comment's "TRANSFER-FEE-AWARE RESERVE ACCOUNTING" paragraph.
        let vault_in_before = read_token_balance(&vault_in_ai)?;
        transfer_checked(
            CpiContext::new(
                token_program_in_ai,
                TransferChecked {
                    from: ctx.accounts.trader_token_in.to_account_info(),
                    mint: mint_in_ai,
                    to: vault_in_ai.clone(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            amount_in,
            decimals_in,
        )?;
        let vault_in_after = read_token_balance(&vault_in_ai)?;
        let amount_in_net = vault_in_after
            .checked_sub(vault_in_before)
            .ok_or(SwdAmmError::MathOverflow)?;
        require!(amount_in_net > 0, SwdAmmError::ZeroAmount);

        // Uses the DYNAMIC fee `oracle_result` computed above (this
        // pool's base `fee_bps`, scaled up toward `max_fee_bps` if the
        // pool's price had drifted from the oracle) — not the pool's
        // static `fee_bps` field directly.
        let fee_bps = oracle_result.fee_bps as u128;
        let fee_multiplier = 10_000u128
            .checked_sub(fee_bps)
            .ok_or(SwdAmmError::MathOverflow)?;
        let amount_in_after_fee = (amount_in_net as u128)
            .checked_mul(fee_multiplier)
            .ok_or(SwdAmmError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(SwdAmmError::MathOverflow)?;

        let impact_bps = amount_in_after_fee
            .checked_mul(10_000)
            .ok_or(SwdAmmError::MathOverflow)?
            .checked_div((reserve_in as u128).checked_add(amount_in_after_fee).ok_or(SwdAmmError::MathOverflow)?)
            .ok_or(SwdAmmError::MathOverflow)?;
        require!(impact_bps <= CP_MAX_PRICE_IMPACT_BPS, SwdAmmError::PriceImpactTooHigh);

        // Constant product: (reserve_in + amount_in_after_fee) * (reserve_out - amount_out) = reserve_in * reserve_out
        let k = (reserve_in as u128)
            .checked_mul(reserve_out as u128)
            .ok_or(SwdAmmError::MathOverflow)?;
        let new_reserve_in = (reserve_in as u128)
            .checked_add(amount_in_after_fee)
            .ok_or(SwdAmmError::MathOverflow)?;
        require!(new_reserve_in > 0, SwdAmmError::MathOverflow);
        // The pool keeps ceil(k / new_reserve_in), so the payout rounds
        // DOWN (in the pool's favour). It used to keep floor(k / ...),
        // which rounded the payout up: a 2-raw-unit swap could pay out a
        // whole raw unit of a far more valuable token, repeatable many
        // times per transaction (attack suite, 2026-10-08:
        // attack_rounding_drain_with_dust_swaps).
        let new_reserve_out_ceil = k
            .checked_add(new_reserve_in - 1)
            .ok_or(SwdAmmError::MathOverflow)?
            .checked_div(new_reserve_in)
            .ok_or(SwdAmmError::MathOverflow)?;
        let amount_out_u128 = (reserve_out as u128)
            .checked_sub(new_reserve_out_ceil)
            .ok_or(SwdAmmError::MathOverflow)?;
        let amount_out = u64::try_from(amount_out_u128).map_err(|_| SwdAmmError::MathOverflow)?;

        require!(amount_out > 0, SwdAmmError::ZeroAmount);
        require!(amount_out >= min_amount_out, SwdAmmError::SlippageExceeded);
        // Should be mathematically impossible given the formula above, but
        // checked explicitly anyway — this is exactly the kind of
        // invariant an integer-math mistake could silently violate, and
        // the cost of checking it is one comparison.
        require!(amount_out < reserve_out, SwdAmmError::InvariantViolation);

        let mint_a_key = ctx.accounts.pool.mint_a;
        let mint_b_key = ctx.accounts.pool.mint_b;
        let bump = ctx.accounts.pool.bump;
        let signer_seeds: &[&[u8]] = &[POOL_SEED, mint_a_key.as_ref(), mint_b_key.as_ref(), &[bump]];
        let signer = &[signer_seeds];

        transfer_checked(
            CpiContext::new_with_signer(
                token_program_out_ai,
                TransferChecked {
                    from: vault_out_ai,
                    mint: mint_out_ai,
                    to: ctx.accounts.trader_token_out.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            amount_out,
            decimals_out,
        )?;

        // Mirror the swap in the tracked reserves. `amount_in_net` (the
        // MEASURED amount that actually landed in vault_in, including the
        // fee portion this pool's own `fee_bps` implies — just not any
        // Token-2022 transfer fee, which never reached the vault at all)
        // is what's credited here, not the nominal `amount_in` the
        // trader's wallet was debited for. Letting the pool's own fee
        // portion raise the tracked reserve (rather than vanish) is what
        // makes that fee accrue to LPs, matching the pre-existing design
        // note about fees accruing silently in the vaults; a mint's own
        // transfer fee, by contrast, never reaches the vault at all, so it
        // correctly does NOT get credited to the reserve or to LPs.
        let pool = &mut ctx.accounts.pool;
        if a_to_b {
            pool.reserve_a = pool
                .reserve_a
                .checked_add(amount_in_net)
                .ok_or(SwdAmmError::MathOverflow)?;
            pool.reserve_b = pool
                .reserve_b
                .checked_sub(amount_out)
                .ok_or(SwdAmmError::MathOverflow)?;
        } else {
            pool.reserve_b = pool
                .reserve_b
                .checked_add(amount_in_net)
                .ok_or(SwdAmmError::MathOverflow)?;
            pool.reserve_a = pool
                .reserve_a
                .checked_sub(amount_out)
                .ok_or(SwdAmmError::MathOverflow)?;
        }

        // Oracle guard on the post-trade price (see oracle::guard_allows).
        let post_price_q64 = dlmm::q64_div_amount(pool.reserve_b, pool.reserve_a as u128)?;
        oracle_result.enforce_guard(post_price_q64)?;

        emit!(SwapExecuted {
            pool: ctx.accounts.pool.key(),
            trader: ctx.accounts.trader.key(),
            a_to_b,
            amount_in,
            amount_out,
            fee_bps: oracle_result.fee_bps,
            deviation_bps: oracle_result.deviation_bps,
        });
        Ok(())
    }

    // -----------------------------------------------------------------
    // Governance (Squads-signed allowlist + emergency pause) — see
    // governance.rs for the real logic and full documentation. Thin
    // wrappers only, same reasoning as the DLMM wrappers below.
    // -----------------------------------------------------------------

    pub fn initialize_global_config(
        ctx: Context<InitializeGlobalConfig>,
        governance_authority: Pubkey,
        emergency_authority: Pubkey,
    ) -> Result<()> {
        governance::initialize_global_config(ctx, governance_authority, emergency_authority)
    }

    pub fn set_authorities(
        ctx: Context<GovernanceOnly>,
        new_governance_authority: Pubkey,
        new_emergency_authority: Pubkey,
    ) -> Result<()> {
        governance::set_authorities(ctx, new_governance_authority, new_emergency_authority)
    }

    pub fn set_pool_creation_paused(
        ctx: Context<GovernanceOnly>,
        paused: bool,
    ) -> Result<()> {
        governance::set_pool_creation_paused(ctx, paused)
    }

    pub fn set_allowed_mint(ctx: Context<SetAllowedMint>, enabled: bool) -> Result<()> {
        governance::set_allowed_mint(ctx, enabled)
    }

    pub fn emergency_pause_pool(
        ctx: Context<EmergencyPausePool>,
        pause_swap: bool,
        pause_deposit: bool,
        pause_withdraw: bool,
    ) -> Result<()> {
        governance::emergency_pause_pool(ctx, pause_swap, pause_deposit, pause_withdraw)
    }

    pub fn emergency_pause_dlmm_pool(
        ctx: Context<EmergencyPauseDlmmPool>,
        pause_swap: bool,
        pause_deposit: bool,
        pause_withdraw: bool,
    ) -> Result<()> {
        governance::emergency_pause_dlmm_pool(ctx, pause_swap, pause_deposit, pause_withdraw)
    }

    pub fn governed_unpause_pool(
        ctx: Context<GovernancePausePool>,
        unpause_swap: bool,
        unpause_deposit: bool,
        unpause_withdraw: bool,
    ) -> Result<()> {
        governance::governed_unpause_pool(ctx, unpause_swap, unpause_deposit, unpause_withdraw)
    }

    pub fn governed_unpause_dlmm_pool(
        ctx: Context<GovernancePauseDlmmPool>,
        unpause_swap: bool,
        unpause_deposit: bool,
        unpause_withdraw: bool,
    ) -> Result<()> {
        governance::governed_unpause_dlmm_pool(ctx, unpause_swap, unpause_deposit, unpause_withdraw)
    }

    /// "Phase 2" — see governance.rs's module doc comment ("SQUADS
    /// MULTISIG TRANSPARENCY") for what this does and its known
    /// uncertainty around the Squads vault PDA derivation.
    pub fn verify_governance_multisig(
        ctx: Context<VerifyGovernanceMultisig>,
        vault_index: u8,
    ) -> Result<()> {
        governance::verify_governance_multisig(ctx, vault_index)
    }

    // -----------------------------------------------------------------
    // DLMM (concentrated liquidity, bin-based) — see dlmm.rs for the real
    // logic and full documentation. These are thin wrappers only, per
    // Anchor's standard multi-file pattern (same reasoning as the module
    // doc comment above this mod's `mod dlmm;` declaration).
    // -----------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn initialize_dlmm_pool(
        ctx: Context<InitializeDlmmPool>,
        bin_step_bps: u16,
        fee_bps: u16,
        active_bin_id: i32,
        pyth_feed_id_a: [u8; 32],
        pyth_feed_id_b: [u8; 32],
        oracle_max_staleness_secs: u32,
        oracle_max_deviation_bps: u16,
        max_fee_bps: u16,
    ) -> Result<()> {
        dlmm::initialize_dlmm_pool(
            ctx,
            bin_step_bps,
            fee_bps,
            active_bin_id,
            pyth_feed_id_a,
            pyth_feed_id_b,
            oracle_max_staleness_secs,
            oracle_max_deviation_bps,
            max_fee_bps,
        )
    }

    pub fn add_dlmm_liquidity(
        ctx: Context<AddDlmmLiquidity>,
        bin_id_lower: i32,
        bin_id_upper: i32,
        amounts: Vec<BinLiquidityAmount>,
    ) -> Result<()> {
        dlmm::add_dlmm_liquidity(ctx, bin_id_lower, bin_id_upper, amounts)
    }

    pub fn remove_dlmm_liquidity(
        ctx: Context<RemoveDlmmLiquidity>,
        shares_to_remove: Vec<u128>,
        min_a_out: u64,
        min_b_out: u64,
    ) -> Result<()> {
        dlmm::remove_dlmm_liquidity(ctx, shares_to_remove, min_a_out, min_b_out)
    }

    pub fn swap_dlmm(
        ctx: Context<SwapDlmm>,
        amount_in: u64,
        min_amount_out: u64,
        a_to_b: bool,
    ) -> Result<()> {
        dlmm::swap_dlmm(ctx, amount_in, min_amount_out, a_to_b)
    }

    // -----------------------------------------------------------------
    // Governance v2 — timelock, protocol fee settings, mint policy
    // (timelock.rs)
    // -----------------------------------------------------------------

    pub fn initialize_governance_settings(
        ctx: Context<InitializeGovernanceSettings>,
        timelock_delay_secs: i64,
        protocol_fee_share_bps: u16,
        treasury: Pubkey,
    ) -> Result<()> {
        timelock::initialize_governance_settings(ctx, timelock_delay_secs, protocol_fee_share_bps, treasury)
    }

    pub fn propose_gov_action(ctx: Context<ProposeAction>, action: GovAction) -> Result<()> {
        timelock::propose_action(ctx, action)
    }

    pub fn cancel_gov_action(ctx: Context<CancelAction>) -> Result<()> {
        timelock::cancel_action(ctx)
    }

    pub fn execute_unpause_pool(ctx: Context<ExecuteUnpausePool>) -> Result<()> {
        timelock::execute_unpause_pool(ctx)
    }

    pub fn execute_unpause_dlmm_pool(ctx: Context<ExecuteUnpauseDlmmPool>) -> Result<()> {
        timelock::execute_unpause_dlmm_pool(ctx)
    }

    pub fn execute_v2_pool_action(ctx: Context<ExecuteV2PoolAction>) -> Result<()> {
        timelock::execute_v2_pool_action(ctx)
    }

    pub fn execute_settings_action(ctx: Context<ExecuteSettingsAction>) -> Result<()> {
        timelock::execute_settings_action(ctx)
    }

    pub fn execute_withdraw_protocol_fees(ctx: Context<ExecuteWithdrawProtocolFees>) -> Result<()> {
        timelock::execute_withdraw_protocol_fees(ctx)
    }

    pub fn set_mint_policy(ctx: Context<SetMintPolicy>, enabled: bool, token_2022_reviewed: bool) -> Result<()> {
        timelock::set_mint_policy(ctx, enabled, token_2022_reviewed)
    }

    // -----------------------------------------------------------------
    // SWDMM v2 pools (swdmm_v2.rs)
    // -----------------------------------------------------------------

    pub fn initialize_v2_pool(ctx: Context<InitializeV2Pool>, params: InitializeV2PoolParams) -> Result<()> {
        swdmm_v2::initialize_v2_pool(ctx, params)
    }

    pub fn create_v2_position(ctx: Context<CreateV2Position>) -> Result<()> {
        swdmm_v2::create_v2_position(ctx)
    }

    pub fn add_v2_liquidity(ctx: Context<ModifyV2Liquidity>, max_a: u64, max_b: u64, min_liquidity: u128) -> Result<()> {
        swdmm_v2::add_v2_liquidity(ctx, max_a, max_b, min_liquidity)
    }

    pub fn remove_v2_liquidity(ctx: Context<ModifyV2Liquidity>, liquidity: u128, min_a: u64, min_b: u64) -> Result<()> {
        swdmm_v2::remove_v2_liquidity(ctx, liquidity, min_a, min_b)
    }

    pub fn claim_v2_fees(ctx: Context<ModifyV2Liquidity>) -> Result<()> {
        swdmm_v2::claim_v2_fees(ctx)
    }

    pub fn lock_v2_liquidity(ctx: Context<LockV2Liquidity>, liquidity: u128) -> Result<()> {
        swdmm_v2::lock_v2_liquidity(ctx, liquidity)
    }

    pub fn transfer_v2_position(ctx: Context<OwnV2Position>, new_owner: Pubkey) -> Result<()> {
        swdmm_v2::transfer_v2_position(ctx, new_owner)
    }

    pub fn close_v2_position(ctx: Context<CloseV2Position>) -> Result<()> {
        swdmm_v2::close_v2_position(ctx)
    }

    pub fn swap_v2(ctx: Context<SwapV2>, amount_in: u64, min_amount_out: u64, a_to_b: bool) -> Result<()> {
        swdmm_v2::swap_v2(ctx, amount_in, min_amount_out, a_to_b)
    }

    pub fn emergency_pause_v2_pool(ctx: Context<EmergencyPauseV2Pool>, pause_swap: bool, pause_deposit: bool, pause_withdraw: bool) -> Result<()> {
        swdmm_v2::emergency_pause_v2_pool(ctx, pause_swap, pause_deposit, pause_withdraw)
    }
}

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

// Every non-trivial account below is `Box<...>`'d (not plain `Account<...>`/
// `InterfaceAccount<...>`) — added 2026-09-23 after the user's own
// `anchor build`/`anchor test` run hit this struct's `try_accounts`
// exceeding Solana's 4096-byte BPF stack frame limit (estimated frame size
// 4416 bytes, offset over by 40 bytes). This struct already took mint_a/
// mint_b as real accounts before Token-2022 support was added, but the
// Token-2022-capable `InterfaceAccount<Mint>` type is larger than the
// classic-only `Account<'info, token::Mint>` it replaced, and that was
// enough to push this already-large struct (7 non-trivial accounts, 2 of
// them freshly `init`'d PDAs) over the limit. Same fix already applied to
// `AddLiquidity`/`RemoveLiquidity`/`Swap` below and to dlmm.rs's
// `SwapDlmm` — boxing moves each account's deserialized data to the heap
// instead of the stack and does not change any validation behavior.
// Confirmed by the user's own build: the "Access violation in stack frame
// 5" runtime panic on every `initialize_pool` call was the direct
// consequence of skipping this on a struct this large.
#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,

    #[account(seeds = [governance::GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, governance::GlobalConfig>>,

    #[account(seeds = [governance::ALLOWED_MINT_SEED, mint_a.key().as_ref()], bump = allowed_mint_a.bump)]
    pub allowed_mint_a: Box<Account<'info, governance::AllowedMint>>,

    #[account(seeds = [governance::ALLOWED_MINT_SEED, mint_b.key().as_ref()], bump = allowed_mint_b.bump)]
    pub allowed_mint_b: Box<Account<'info, governance::AllowedMint>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Pool::SIZE,
        seeds = [POOL_SEED, mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        init,
        payer = payer,
        seeds = [VAULT_A_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = pool,
        token::token_program = token_program_a,
    )]
    pub vault_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [VAULT_B_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint_b,
        token::authority = pool,
        token::token_program = token_program_b,
    )]
    pub vault_b: Box<InterfaceAccount<'info, TokenAccount>>,

    // Classic-only, deliberately: the LP receipt token this program mints
    // is always a plain SPL Token mint regardless of what mint_a/mint_b
    // are — see the module doc comment ("TOKEN PROGRAM SUPPORT").
    #[account(
        init,
        payer = payer,
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
        bump,
        mint::decimals = LP_DECIMALS,
        mint::authority = pool,
    )]
    pub lp_mint: Box<Account<'info, ClassicMint>>,

    // Token-2022 support (added 2026-09-23): `mint_a`/`vault_a` and
    // `mint_b`/`vault_b` can each independently be owned by the classic
    // SPL Token program or Token-2022 — `Interface<TokenInterface>`
    // accepts either program id, and the `token::token_program = ...`
    // constraint on vault_a/vault_b above then pins each vault to
    // whichever program its own mint actually uses. A "mixed" pool (one
    // side classic, one side Token-2022) is allowed by this typing; both
    // sides still individually pass `assert_mint_extensions_safe` in the
    // handler below.
    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    // Boxed: this struct's `try_accounts` was measured exceeding Solana's
    // 4096-byte BPF stack frame limit (4504 bytes, over by 408) with these
    // as plain `Account<'info, T>` — boxing moves each account's
    // deserialized data onto the heap instead of the stack. This is the
    // standard, Anchor-documented fix for this class of build error and
    // does not change any account validation behavior.
    #[account(
        mut,
        seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, address = pool.vault_a)]
    pub vault_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.vault_b)]
    pub vault_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Box<Account<'info, ClassicMint>>,

    // Passed in (not just read from `pool.mint_a`/`pool.mint_b` as a
    // Pubkey, as before Token-2022 support) because `transfer_checked`
    // needs the actual mint account — both for its `decimals` field and
    // because Token-2022's `transfer_checked` CPI takes the mint as an
    // account, unlike the classic (now-legacy) `transfer` instruction.
    #[account(address = pool.mint_a)]
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pool.mint_b)]
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, token::mint = mint_a, token::authority = depositor, token::token_program = token_program_a)]
    pub depositor_token_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_b, token::authority = depositor, token::token_program = token_program_b)]
    pub depositor_token_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = lp_mint,
        associated_token::authority = depositor,
    )]
    pub depositor_lp: Box<Account<'info, ClassicTokenAccount>>,

    // Permanent lock destination for MINIMUM_LIQUIDITY on a pool's first
    // deposit — an ATA owned by the POOL PDA for its own LP mint. Nothing
    // in this program ever moves tokens out of an LP-mint ATA owned by
    // the pool itself.
    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = lp_mint,
        associated_token::authority = pool,
    )]
    pub pool_lp_lock: Box<Account<'info, ClassicTokenAccount>>,

    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    // Boxed for the same reason as in `AddLiquidity` — this struct's
    // `try_accounts` measured 4112 bytes, over Solana's 4096-byte BPF
    // stack limit by 16 bytes. Boxing moves account data to the heap.
    #[account(
        mut,
        seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, address = pool.vault_a)]
    pub vault_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.vault_b)]
    pub vault_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Box<Account<'info, ClassicMint>>,

    #[account(address = pool.mint_a)]
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pool.mint_b)]
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, token::mint = lp_mint, token::authority = owner)]
    pub owner_lp: Box<Account<'info, ClassicTokenAccount>>,
    #[account(mut, token::mint = mint_a, token::authority = owner, token::token_program = token_program_a)]
    pub owner_token_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_b, token::authority = owner, token::token_program = token_program_b)]
    pub owner_token_b: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, address = pool.vault_a)]
    pub vault_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.vault_b)]
    pub vault_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = pool.mint_a)]
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pool.mint_b)]
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub trader_token_in: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub trader_token_out: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,

    // Added 2026-09-23 ("Phase 3") — see oracle.rs's module doc comment.
    // Anchor's `Account<'info, PriceUpdateV2>` deserializer already
    // requires each of these be owned by the real Pyth Receiver program
    // (oracle::PYTH_RECEIVER_PROGRAM_ID) before this instruction's body
    // ever runs; the body then separately checks each one's `feed_id`
    // matches this specific pool's `pyth_feed_id_a`/`pyth_feed_id_b` and
    // is fresh enough (see `oracle::evaluate_oracle_and_fee`). Boxed for
    // the same BPF-stack-frame reason every other account in this struct
    // already is.
    pub price_update_a: Box<Account<'info, PriceUpdateV2>>,
    pub price_update_b: Box<Account<'info, PriceUpdateV2>>,
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

#[account]
pub struct Pool {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub lp_mint: Pubkey,
    pub creator: Pubkey, // informational only, see initialize_pool's doc comment
    pub fee_bps: u16,
    pub bump: u8,
    // Added 2026-09-08 to fix the first-depositor/share-inflation "donation"
    // attack that SECURITY.md's test suite measured on this date. BEFORE
    // this fix, every instruction computed prices/shares from
    // vault_a.amount/vault_b.amount — the vault's LIVE token balance — which
    // meant anyone could skew a pool's price for free by sending tokens
    // straight to a vault with a plain SPL transfer (no add_liquidity call,
    // no LP minted, nothing this program could see coming). AFTER this fix,
    // every instruction computes prices/shares from THESE fields instead,
    // which this program updates itself, exactly once, inside
    // add_liquidity/remove_liquidity/swap — never from a live balance read.
    // A direct donation to a vault therefore has ZERO effect on any
    // pricing/share math: the donated tokens just sit in the vault,
    // permanently uncounted and unrecoverable by anyone (this program has
    // no instruction that reads or moves the "surplus" between real vault
    // balance and these tracked numbers). That is a deliberate tradeoff —
    // the attacker's donated tokens become dead weight instead of a
    // griefing tool, at the cost of no one (including legitimate LPs) ever
    // being able to claim that surplus either.
    //
    // INVARIANT this program is responsible for maintaining: vault_a.amount
    // >= reserve_a and vault_b.amount >= reserve_b, always (equality holds
    // exactly when no one has ever donated directly to a vault). If you
    // modify add_liquidity/remove_liquidity/swap, preserve this — every
    // token that moves into/out of a vault under this program's own
    // authority must be mirrored here in the same instruction. "Phase 1b"
    // (2026-09-23) extended this same invariant to Token-2022 mints
    // carrying a `TransferFeeConfig` extension: add_liquidity/swap now
    // mirror the MEASURED amount a vault actually received (via
    // `read_token_balance`), not the nominal transfer amount, which is
    // what keeps this invariant true even when a fee is withheld before
    // the vault sees the funds — see the module doc comment.
    pub reserve_a: u64,
    pub reserve_b: u64,
    // Added 2026-09-22 alongside governance.rs. Each independently gates
    // one instruction: swap_paused -> swap, deposit_paused -> add_liquidity,
    // withdraw_paused -> remove_liquidity. Only emergency_pause_pool can set
    // these true; only governed_unpause_pool (governance_authority-signed)
    // can set them back to false — see governance.rs.
    pub swap_paused: bool,
    pub deposit_paused: bool,
    pub withdraw_paused: bool,
    // Added 2026-09-23 ("Phase 3") — set once at initialize_pool and
    // immutable afterward, same treatment as fee_bps. See oracle.rs's
    // module doc comment for what each of these means; `swap` reads all
    // five on every call via `oracle::evaluate_oracle_and_fee`.
    pub pyth_feed_id_a: [u8; 32],
    pub pyth_feed_id_b: [u8; 32],
    pub oracle_max_staleness_secs: u32,
    pub oracle_max_deviation_bps: u16,
    pub max_fee_bps: u16,
}

impl Pool {
    // 6 pubkeys (32 bytes each) + fee_bps (u16) + bump (u8) + reserve_a (u64)
    // + reserve_b (u64) + 3 pause bools (1 byte each) + 2 pyth feed ids
    // (32 bytes each) + oracle_max_staleness_secs (u32) +
    // oracle_max_deviation_bps (u16) + max_fee_bps (u16)
    pub const SIZE: usize = 32 * 6 + 2 + 1 + 8 + 8 + 1 + 1 + 1 + 32 * 2 + 4 + 2 + 2;
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub fee_bps: u16,
    // Added 2026-09-23 ("Phase 3") — see oracle.rs's module doc comment.
    pub pyth_feed_id_a: [u8; 32],
    pub pyth_feed_id_b: [u8; 32],
    pub oracle_max_staleness_secs: u32,
    pub oracle_max_deviation_bps: u16,
    pub max_fee_bps: u16,
}

#[event]
pub struct LiquidityAdded {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_minted: u64,
}

#[event]
pub struct LiquidityRemoved {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_burned: u64,
}

#[event]
pub struct SwapExecuted {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub a_to_b: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    // Added 2026-09-23 ("Phase 3") — the ACTUAL fee this swap paid
    // (fee_bps's static value, scaled up if the pool's price had
    // drifted from the oracle) and how far that price had drifted, in
    // basis points, at the moment this swap executed. Emitted for the
    // same transparency reason `verify_governance_multisig` emits an
    // event in governance.rs — so anyone can audit dynamic-fee behavior
    // off-chain without re-deriving it from raw account state.
    pub fee_bps: u16,
    pub deviation_bps: u64,
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

#[error_code]
pub enum SwdAmmError {
    #[msg("Fee exceeds the maximum allowed")]
    FeeTooHigh,
    #[msg("Mint A and Mint B must be different")]
    IdenticalMints,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Initial liquidity too small")]
    InsufficientInitialLiquidity,
    #[msg("A pool's first deposit must supply at least MIN_INITIAL_DEPOSIT of each token")]
    InitialDepositTooSmall,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("No liquidity would be minted")]
    ZeroLiquidityMinted,
    #[msg("Pool has no liquidity")]
    EmptyPool,
    #[msg("Token account owner mismatch")]
    InvalidTokenAccountOwner,
    #[msg("Token mint does not match pool")]
    MintMismatch,
    #[msg("Internal invariant violated — do not ignore this, it means the math above has a bug")]
    InvariantViolation,
    #[msg("Pool creation is paused by governance")]
    PoolCreationPaused,
    #[msg("This mint is not on the governance allowlist")]
    MintNotAllowlisted,
    #[msg("Swaps are paused on this pool")]
    SwapPaused,
    #[msg("Deposits are paused on this pool")]
    DepositPaused,
    #[msg("Withdrawals are paused on this pool")]
    WithdrawPaused,
    #[msg("This Token-2022 mint carries an extension this program does not yet support (transfer fee, transfer hook, confidential transfer, non-transferable, or permanent delegate)")]
    UnsupportedMintExtension,
    #[msg("Price impact exceeds the 50% cap for a single swap")]
    PriceImpactTooHigh,
}

// ---------------------------------------------------------------------
// Token-2022 extension gate
// ---------------------------------------------------------------------

/// Rejects a Token-2022 mint carrying an extension this program's reserve
/// accounting is not safe against yet. A no-op (always `Ok`) for a mint
/// owned by the classic SPL Token program, since that program has no
/// extension mechanism at all — the check only ever fires for a
/// Token-2022-owned mint.
///
/// ALLOWED-BUT-SPECIAL-CASED extension:
/// - `TransferFeeConfig` — a transfer of `amount` does NOT land `amount`
///   in the destination; some is withheld (on the destination account, for
///   later harvest by the mint's withdraw-withheld-authority) as a fee.
///   THIS is no longer blocked as of "Phase 1b" (2026-09-23): `add_liquidity`
///   and `swap` measure each vault's real balance immediately before and
///   after every inbound transfer and credit `Pool.reserve_a`/`reserve_b`
///   with that measured delta, never the nominal transferred amount — see
///   the module doc comment's "TRANSFER-FEE-AWARE RESERVE ACCOUNTING"
///   paragraph and `read_token_balance` below for the mechanics. This is
///   the one extension in this list that changes accounting arithmetic
///   rather than the safety of running this program's CPI/trust model at
///   all — every extension below this one is still blocked because it
///   changes something this program cannot compensate for by measuring a
///   balance delta.
///
/// BLOCKED extensions and why, one at a time:
/// - `TransferHook` — invokes arbitrary, mint-defined third-party program
///   logic on every transfer into/out of a vault, including on the CPI
///   transfers this program itself issues from a PDA-signed context. This
///   program has no way to audit what that hook program does; blocking it
///   is the same "don't execute code we can't reason about" principle
///   that keeps this whole program's CPI surface to well-understood SPL
///   Token instructions only.
/// - `ConfidentialTransferMint` — transferred amounts are encrypted
///   on-chain; this program's pricing/reserve math needs to read amounts
///   in the clear, which confidential transfers make structurally
///   impossible to combine with a public constant-product pool.
/// - `NonTransferable` — a swap/deposit/withdrawal literally cannot
///   transfer such a mint at all; better to reject cleanly at pool
///   creation than let every later instruction fail confusingly.
/// - `PermanentDelegate` — grants a fixed third-party authority the
///   ability to transfer/burn ANY holder's tokens for this mint, forever,
///   bypassing the holder's own signature. A pool vault holding such a
///   mint is one delegate-signed instruction away from being drained
///   outside this program's own logic entirely — a fund-safety property
///   no version of this program's own code can restore once the mint
///   itself grants that power away.
///
/// Every OTHER Token-2022 extension (e.g. `MetadataPointer`,
/// `TokenMetadata`, `InterestBearingConfig` — which changes what a UI
/// shows, not what a transfer actually moves) is allowed through.
fn assert_mint_extensions_safe(mint_ai: &AccountInfo) -> Result<()> {
    if mint_ai.owner != &anchor_spl::token_2022::ID {
        return Ok(());
    }

    const BLOCKED: [ExtensionType; 4] = [
        ExtensionType::TransferHook,
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::NonTransferable,
        ExtensionType::PermanentDelegate,
    ];

    let data = mint_ai.try_borrow_data()?;
    let mint_with_extensions = StateWithExtensions::<SplToken2022Mint>::unpack(&data)
        .map_err(|_| error!(SwdAmmError::UnsupportedMintExtension))?;
    let present = mint_with_extensions
        .get_extension_types()
        .map_err(|_| error!(SwdAmmError::UnsupportedMintExtension))?;

    for ext in present {
        require!(!BLOCKED.contains(&ext), SwdAmmError::UnsupportedMintExtension);
    }
    Ok(())
}

/// Reads a token account's spendable balance (the SPL `amount` field)
/// directly off its current raw account data — added 2026-09-23 ("Phase
/// 1b") so `add_liquidity`/`swap` can measure what a transfer ACTUALLY
/// moved instead of trusting the amount they asked it to move. Necessary
/// because a `TransferFeeConfig` mint can make the two differ (see
/// `assert_mint_extensions_safe`'s doc comment): the fee withheld on
/// transfer is tracked in a separate extension field on the destination
/// account, NOT included in this `amount` field, so this function's return
/// value is already exactly the "how much did the vault really gain"
/// number callers need — no fee-rate math of this program's own required.
/// Deliberately reads the raw `AccountInfo` (rather than calling `.reload()`
/// on an already-deserialized `InterfaceAccount<TokenAccount>` field) so it
/// works uniformly for `swap`'s vault_in/vault_out, which are resolved into
/// plain `AccountInfo`s because which of `vault_a`/`vault_b` plays each
/// role depends on the `a_to_b` argument.
fn read_token_balance(token_account_ai: &AccountInfo) -> Result<u64> {
    let data = token_account_ai.try_borrow_data()?;
    let account = TokenAccount::try_deserialize(&mut &data[..])
        .map_err(|_| error!(SwdAmmError::MathOverflow))?;
    Ok(account.amount)
}

// ---------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------

/// Computes floor(a * b / denom) using u128 intermediates to avoid
/// overflowing u64 (reserves and supplies can each be up to ~1.8e19 for a
/// 0-decimal token with u64::MAX raw amount; a*b alone can then exceed
/// u64's ~1.8e19 ceiling well before the division brings it back down).
fn mul_div(a: u64, b: u64, denom: u64) -> Result<u64> {
    require!(denom > 0, SwdAmmError::MathOverflow);
    let result = (a as u128)
        .checked_mul(b as u128)
        .ok_or(SwdAmmError::MathOverflow)?
        .checked_div(denom as u128)
        .ok_or(SwdAmmError::MathOverflow)?;
    u64::try_from(result).map_err(|_| SwdAmmError::MathOverflow.into())
}

/// Integer square root via the Babylonian method — standard technique
/// (same one Uniswap V2 uses), used only to size the initial LP supply on
/// a pool's first deposit. See the `tests` module below (run with
/// `cargo test`, NOT `anchor test` — this is a plain Rust unit/fuzz test,
/// not a localnet integration test) for the property/fuzz coverage that
/// used to be missing: 0, 1, every perfect square up to 1000^2,
/// non-perfect squares, u64::MAX, u128::MAX, and 10,000 pseudo-random
/// values across the full u128 range.
fn integer_sqrt(value: u128) -> u128 {
    if value == 0 {
        return 0;
    }
    let mut x = value;
    // Safe against overflow when value == u128::MAX. The original code
    // computed `(x + 1) / 2`, which is exactly `ceil(x / 2)` for every
    // unsigned integer x — but computed via an addition that overflows
    // `u128` in exactly the one case `x == u128::MAX`. `x / 2 + (x % 2)`
    // is the SAME mathematical value (`ceil(x/2)` via floor-division plus
    // the remainder, instead of via +1-then-floor-divide) without ever
    // performing an addition close to the type's ceiling — confirmed
    // equal to the original formula for every non-overflowing input by
    // this file's own test suite (`integer_sqrt_perfect_squares`,
    // `integer_sqrt_non_perfect_squares_floor_correctly`, and the 10,000-
    // value fuzz test all re-passed unchanged after this rewrite).
    //
    // (2026-09-08 history, for whoever reads this next: the first attempt
    // at this fix used `x / 2 + 1` instead, which is NOT the same value as
    // `ceil(x/2)` when x is even — e.g. x=2 gives 1+1=2 instead of the
    // correct 1 — and broke `integer_sqrt(2)` and similar small inputs.
    // Caught immediately by `integer_sqrt_non_perfect_squares_floor_correctly`
    // failing on the very next `cargo test` run. Left here as a reminder
    // that "avoids the overflow" and "is still correct" are two separate
    // things to verify — the fuzz/property tests are what caught it both
    // times.)
    let mut y = x / 2 + (x % 2);
    while y < x {
        x = y;
        y = (x + value / x) / 2;
    }
    x
}

// ---------------------------------------------------------------------
// Unit / fuzz tests for pure math helpers (2026-09-08).
//
// Run with `cargo test` from `programs/swd_amm/` (or the workspace root) —
// these are ordinary native Rust tests, not a Solana/Anchor integration
// test, so they do NOT need a validator and are NOT run by `anchor test`.
// They only exercise `integer_sqrt` and `mul_div`, which have zero Solana
// dependencies (no accounts, no CPI), so testing them natively like this
// is both valid and much faster than routing everything through
// `anchor test`.
// ---------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_sqrt_zero_and_one() {
        assert_eq!(integer_sqrt(0), 0);
        assert_eq!(integer_sqrt(1), 1);
    }

    #[test]
    fn integer_sqrt_perfect_squares() {
        // Every perfect square from 0^2 to 1000^2 must round-trip exactly.
        for i in 0u128..=1000 {
            let square = i * i;
            assert_eq!(
                integer_sqrt(square),
                i,
                "integer_sqrt({}) should be exactly {}",
                square,
                i
            );
        }
    }

    #[test]
    fn integer_sqrt_non_perfect_squares_floor_correctly() {
        // Hand-picked values where the correct floor is easy to verify by
        // hand, to catch an off-by-one in the Babylonian loop specifically.
        let cases: &[(u128, u128)] = &[
            (2, 1),
            (3, 1),
            (8, 2),   // 2^2=4, 3^2=9
            (9, 3),   // exact
            (10, 3),  // 3^2=9, 4^2=16
            (99, 9),  // 9^2=81, 10^2=100
            (100, 10), // exact
            (101, 10), // 10^2=100, 11^2=121
        ];
        for &(value, expected) in cases {
            assert_eq!(integer_sqrt(value), expected, "integer_sqrt({})", value);
        }
    }

    #[test]
    fn integer_sqrt_near_u64_max() {
        // u64::MAX is the largest value a real token reserve/supply can
        // ever be, so this is the realistic upper bound this function
        // needs to handle correctly (it's only ever called on
        // amount_a_desired * amount_b_desired, both u64).
        let v = u64::MAX as u128;
        let root = integer_sqrt(v);
        assert!(
            root * root <= v,
            "integer_sqrt(u64::MAX) = {} but root^2 > u64::MAX",
            root
        );
        assert!(
            (root + 1) * (root + 1) > v,
            "integer_sqrt(u64::MAX) = {} but (root+1)^2 <= u64::MAX — not the floor",
            root
        );
    }

    #[test]
    fn integer_sqrt_u128_max() {
        // The absolute ceiling this function's input type allows — even
        // though in practice amount_a_desired*amount_b_desired (u64*u64)
        // can never reach u128::MAX, the function must not panic or
        // misbehave if it's ever called with a value this large.
        let v = u128::MAX;
        let root = integer_sqrt(v);
        assert!(
            root.checked_mul(root).map_or(false, |sq| sq <= v),
            "integer_sqrt(u128::MAX) = {} but root^2 overflows or exceeds u128::MAX",
            root
        );
        // (root+1)^2 legitimately overflows u128 here (root is ~2^64, so
        // (root+1)^2 is ~2^128) — that overflow itself proves (root+1)^2 >
        // u128::MAX, so checked_mul returning None is a PASS, not
        // something to skip.
        if let Some(next_sq) = (root + 1).checked_mul(root + 1) {
            assert!(
                next_sq > v,
                "integer_sqrt(u128::MAX) = {} but (root+1)^2 <= u128::MAX — not the floor",
                root
            );
        }
    }

    #[test]
    fn integer_sqrt_fuzz_10000_values() {
        // No external fuzzing crate available in this environment, so this
        // is a simple deterministic PRNG (splitmix64) seeded with a fixed
        // constant — reproducible across runs, and still exercises 10,000
        // values spread across the full u128 range (including values with
        // only the low or only the high 64 bits set, which the
        // perfect-squares-only test above wouldn't catch).
        let mut seed: u64 = 0x9E3779B97F4A7C15;
        let mut next_u64 = || {
            seed = seed.wrapping_add(0x9E3779B97F4A7C15);
            let mut z = seed;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            z ^ (z >> 31)
        };

        for _ in 0..10_000 {
            let hi = next_u64() as u128;
            let lo = next_u64() as u128;
            let value = (hi << 64) | lo;
            let root = integer_sqrt(value);
            assert!(
                root.checked_mul(root).map_or(true, |sq| sq <= value),
                "integer_sqrt({}) = {} but root^2 > value",
                value,
                root
            );
            if let Some(next_sq) = (root + 1).checked_mul(root + 1) {
                assert!(
                    next_sq > value,
                    "integer_sqrt({}) = {} but (root+1)^2 <= value — not the floor",
                    value,
                    root
                );
            }
        }
    }

    #[test]
    fn mul_div_basic_and_overflow() {
        assert_eq!(mul_div(10, 20, 5).unwrap(), 40);
        assert_eq!(mul_div(0, 20, 5).unwrap(), 0);
        // denom = 0 must error, never panic-divide.
        assert!(mul_div(1, 1, 0).is_err());
        // Values that overflow u64 individually but not after the u128
        // intermediate and division back down.
        assert_eq!(mul_div(u64::MAX, 2, 2).unwrap(), u64::MAX);
        // A result that genuinely doesn't fit back into u64 must error,
        // not silently truncate.
        assert!(mul_div(u64::MAX, 2, 1).is_err());
    }
}
