// SWDMM v2 — dynamic AMM pools modelled on Meteora DAMM v2.
//
// Added 2026-09-29. A third pool type in this program next to the
// constant-product pool (lib.rs) and DLMM (dlmm.rs). Full-range
// constant-product liquidity with the DAMM v2 feature set:
//
//   - Fee tiers (0.25% ... 6%) and a "Base Fee Mode":
//       Fixed | Time Scheduler | Market Cap Scheduler (linear or exponential)
//   - Optional dynamic (volatility) fee on top of the base fee
//   - Fee collection mode: Base + Quote | Quote | Quote + Compounding
//   - Start time (activation) for trading
//   - Liquidity positions (Position #0, #1, ...) with claimable fees,
//     transferable ownership, and a permanent lock option
//   - Protocol fee share (GovernanceSettings) withdrawable only through a
//     timelocked governance action (timelock.rs)
//   - Per-pool price-impact cap, optional Pyth oracle deviation guard,
//     emergency pause (emergency authority) and timelocked unpause
//
// Token A is the "base" token, token B the "quote" token (e.g. SOL).
// All pricing/fee math is in swdmm_math.rs (pure, host-tested); this file
// only wires it to accounts and token transfers.
//
// STATUS: UNAUDITED, same as the rest of this program. See SECURITY.md.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions};
use anchor_spl::token_2022::spl_token_2022::state::Mint as SplToken2022Mint;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::governance::{GlobalConfig, GovernanceError, GLOBAL_CONFIG_SEED};
use crate::oracle::{self, PriceUpdateV2};
use crate::swdmm_math as m;
use crate::timelock::{GovernanceSettings, MintPolicy, GOV_SETTINGS_SEED, MINT_POLICY_SEED};

pub const V2_POOL_SEED: &[u8] = b"swdmm_v2_pool";
pub const V2_VAULT_SEED: &[u8] = b"swdmm_v2_vault";
pub const V2_POSITION_SEED: &[u8] = b"swdmm_v2_position";

/// Largest per-pool price-impact cap (50%), per the SWDMM spec.
pub const MAX_PRICE_IMPACT_BPS: u16 = 5_000;
/// A pool's first deposit must supply at least this much of each token.
pub const V2_MIN_INITIAL_DEPOSIT: u64 = 1_000;
/// Activation can be scheduled at most 30 days ahead.
pub const MAX_ACTIVATION_DELAY_SECS: i64 = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct BaseFeeParams {
    pub mode: u8,
    pub decay: u8,
    pub cliff_fee_bps: u16,
    pub floor_fee_bps: u16,
    pub number_of_periods: u16,
    pub period_frequency: u64,
    pub reduction_factor: u64,
}

impl BaseFeeParams {
    fn to_math(self) -> m::BaseFeeConfig {
        m::BaseFeeConfig {
            mode: self.mode,
            decay: self.decay,
            cliff_fee_bps: self.cliff_fee_bps,
            floor_fee_bps: self.floor_fee_bps,
            number_of_periods: self.number_of_periods,
            period_frequency: self.period_frequency,
            reduction_factor: self.reduction_factor,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct DynamicFeeParams {
    pub enabled: bool,
    pub max_dynamic_fee_bps: u16,
    pub variable_fee_control: u32,
    pub filter_period: u32,
    pub decay_period: u32,
    pub reduction_factor: u16,
    pub max_volatility_accumulator: u64,
}

impl DynamicFeeParams {
    pub(crate) fn to_math(self) -> m::DynamicFeeConfig {
        m::DynamicFeeConfig {
            enabled: self.enabled,
            max_dynamic_fee_bps: self.max_dynamic_fee_bps,
            variable_fee_control: self.variable_fee_control,
            filter_period: self.filter_period,
            decay_period: self.decay_period,
            reduction_factor: self.reduction_factor,
            max_volatility_accumulator: self.max_volatility_accumulator,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct OracleGuardParams {
    pub enabled: bool,
    pub pyth_feed_id_a: [u8; 32],
    pub pyth_feed_id_b: [u8; 32],
    pub max_staleness_secs: u32,
    pub max_deviation_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct InitializeV2PoolParams {
    pub base_fee: BaseFeeParams,
    pub dynamic_fee: DynamicFeeParams,
    pub collect_fee_mode: u8,
    /// Unix seconds; 0 (or anything in the past) = trading opens now.
    pub activation_ts: i64,
    pub max_price_impact_bps: u16,
    pub oracle: OracleGuardParams,
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct SwdmmV2Pool {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub token_program_a: Pubkey,
    pub token_program_b: Pubkey,
    pub creator: Pubkey,

    /// Tokens backing the curve (never read from live vault balances).
    pub reserve_a: u64,
    pub reserve_b: u64,
    /// Total liquidity shares, including locked and the dead MINIMUM_LIQUIDITY.
    pub liquidity: u128,
    /// Permanently locked liquidity (dead share + user locks).
    pub locked_liquidity: u128,

    pub base_fee: BaseFeeParams,
    pub dynamic_fee: DynamicFeeParams,
    pub volatility_accumulator: u64,
    pub volatility_reference: u64,
    pub price_reference_q64: u128,
    pub last_swap_ts: i64,

    pub collect_fee_mode: u8,
    pub activation_ts: i64,
    pub init_price_q64: u128,
    pub max_price_impact_bps: u16,
    pub oracle: OracleGuardParams,

    /// Claimable LP fees per unit of liquidity (Q64.64).
    pub fee_per_liquidity_a: u128,
    pub fee_per_liquidity_b: u128,
    pub protocol_fee_a: u64,
    pub protocol_fee_b: u64,

    // Lifetime stats (for the UI)
    pub total_volume_a: u128,
    pub total_volume_b: u128,
    pub total_lp_fee_a: u128,
    pub total_lp_fee_b: u128,
    pub total_protocol_fee_a: u128,
    pub total_protocol_fee_b: u128,
    pub swap_count: u64,

    pub swap_paused: bool,
    pub deposit_paused: bool,
    pub withdraw_paused: bool,

    pub position_count: u64,
    pub created_at: i64,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

impl SwdmmV2Pool {
    fn signer_seeds(&self) -> [Vec<u8>; 5] {
        [
            V2_POOL_SEED.to_vec(),
            self.mint_a.to_bytes().to_vec(),
            self.mint_b.to_bytes().to_vec(),
            self.base_fee.floor_fee_bps.to_le_bytes().to_vec(),
            vec![self.bump],
        ]
    }

    fn vol_state(&self) -> m::VolatilityState {
        m::VolatilityState {
            volatility_accumulator: self.volatility_accumulator,
            volatility_reference: self.volatility_reference,
            price_reference_q64: self.price_reference_q64,
            last_update_ts: self.last_swap_ts,
        }
    }

    fn set_vol_state(&mut self, s: m::VolatilityState) {
        self.volatility_accumulator = s.volatility_accumulator;
        self.volatility_reference = s.volatility_reference;
        self.price_reference_q64 = s.price_reference_q64;
        self.last_swap_ts = s.last_update_ts;
    }

    /// Base + dynamic fee (bps) a swap would pay right now, before this
    /// swap's own volatility is accumulated. Used by `swap_v2`.
    pub fn current_base_fee_bps(&self, now: i64) -> Result<u64> {
        let price = m::price_q64(self.reserve_a, self.reserve_b).ok_or(SwdmmV2Error::MathOverflow)?;
        let cfg = self.base_fee.to_math();
        let n = m::scheduler_periods(&cfg, now, self.activation_ts, price, self.init_price_q64)
            .ok_or(SwdmmV2Error::MathOverflow)?;
        Ok(m::scheduled_fee_bps(&cfg, n).ok_or(SwdmmV2Error::MathOverflow)?)
    }
}

#[account]
#[derive(InitSpace)]
pub struct SwdmmV2Position {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub index: u64,
    /// Withdrawable liquidity.
    pub liquidity: u128,
    /// Permanently locked liquidity (still earns fees, never withdrawable).
    pub locked_liquidity: u128,
    pub fee_checkpoint_a: u128,
    pub fee_checkpoint_b: u128,
    pub pending_fee_a: u64,
    pub pending_fee_b: u64,
    pub total_claimed_fee_a: u64,
    pub total_claimed_fee_b: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl SwdmmV2Position {
    /// Brings pending fees up to date with the pool's fee growth.
    fn settle(&mut self, pool: &SwdmmV2Pool) -> Result<()> {
        let l = self.liquidity.checked_add(self.locked_liquidity).ok_or(SwdmmV2Error::MathOverflow)?;
        let fa = m::pending_fee(pool.fee_per_liquidity_a, self.fee_checkpoint_a, l).ok_or(SwdmmV2Error::MathOverflow)?;
        let fb = m::pending_fee(pool.fee_per_liquidity_b, self.fee_checkpoint_b, l).ok_or(SwdmmV2Error::MathOverflow)?;
        self.pending_fee_a = self.pending_fee_a.checked_add(fa).ok_or(SwdmmV2Error::MathOverflow)?;
        self.pending_fee_b = self.pending_fee_b.checked_add(fb).ok_or(SwdmmV2Error::MathOverflow)?;
        self.fee_checkpoint_a = pool.fee_per_liquidity_a;
        self.fee_checkpoint_b = pool.fee_per_liquidity_b;
        Ok(())
    }
}

// ---------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------

pub(crate) fn initialize_v2_pool(ctx: Context<InitializeV2Pool>, params: InitializeV2PoolParams) -> Result<()> {
    require!(!ctx.accounts.config.pool_creation_paused, SwdmmV2Error::PoolCreationPaused);
    require_keys_neq!(ctx.accounts.mint_a.key(), ctx.accounts.mint_b.key(), SwdmmV2Error::IdenticalMints);
    check_mint_policy(&ctx.accounts.mint_policy_a, &ctx.accounts.mint_a.to_account_info(), &ctx.accounts.token_program_a.key())?;
    check_mint_policy(&ctx.accounts.mint_policy_b, &ctx.accounts.mint_b.to_account_info(), &ctx.accounts.token_program_b.key())?;

    require!(m::validate_base_fee(&params.base_fee.to_math()), SwdmmV2Error::InvalidBaseFee);
    require!(m::validate_dynamic_fee(&params.dynamic_fee.to_math()), SwdmmV2Error::InvalidDynamicFee);
    require!(params.collect_fee_mode <= m::COLLECT_FEE_QUOTE_COMPOUND, SwdmmV2Error::InvalidCollectFeeMode);
    require!(
        params.max_price_impact_bps > 0 && params.max_price_impact_bps <= MAX_PRICE_IMPACT_BPS,
        SwdmmV2Error::InvalidPriceImpactCap
    );
    if params.oracle.enabled {
        oracle::validate_oracle_params(
            &params.oracle.pyth_feed_id_a,
            &params.oracle.pyth_feed_id_b,
            params.oracle.max_staleness_secs,
            params.oracle.max_deviation_bps,
            0,
            0,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    let activation = if params.activation_ts <= now { now } else { params.activation_ts };
    require!(activation - now <= MAX_ACTIVATION_DELAY_SECS, SwdmmV2Error::ActivationTooFar);

    let pool = &mut ctx.accounts.pool;
    pool.mint_a = ctx.accounts.mint_a.key();
    pool.mint_b = ctx.accounts.mint_b.key();
    pool.vault_a = ctx.accounts.vault_a.key();
    pool.vault_b = ctx.accounts.vault_b.key();
    pool.token_program_a = ctx.accounts.token_program_a.key();
    pool.token_program_b = ctx.accounts.token_program_b.key();
    pool.creator = ctx.accounts.creator.key();
    pool.base_fee = params.base_fee;
    pool.dynamic_fee = params.dynamic_fee;
    pool.collect_fee_mode = params.collect_fee_mode;
    pool.activation_ts = activation;
    pool.max_price_impact_bps = params.max_price_impact_bps;
    pool.oracle = params.oracle;
    pool.created_at = now;
    pool.bump = ctx.bumps.pool;

    emit!(V2PoolCreated {
        pool: pool.key(),
        mint_a: pool.mint_a,
        mint_b: pool.mint_b,
        creator: pool.creator,
        base_fee: params.base_fee,
        dynamic_fee_enabled: params.dynamic_fee.enabled,
        collect_fee_mode: params.collect_fee_mode,
        activation_ts: activation,
        max_price_impact_bps: params.max_price_impact_bps,
        oracle_enabled: params.oracle.enabled,
    });
    Ok(())
}

pub(crate) fn create_v2_position(ctx: Context<CreateV2Position>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let index = pool.position_count;
    pool.position_count = index.checked_add(1).ok_or(SwdmmV2Error::MathOverflow)?;
    let p = &mut ctx.accounts.position;
    p.pool = pool.key();
    p.owner = ctx.accounts.owner.key();
    p.index = index;
    p.fee_checkpoint_a = pool.fee_per_liquidity_a;
    p.fee_checkpoint_b = pool.fee_per_liquidity_b;
    p.created_at = Clock::get()?.unix_timestamp;
    p.bump = ctx.bumps.position;
    emit!(V2PositionCreated { pool: p.pool, position: p.key(), owner: p.owner, index });
    Ok(())
}

pub(crate) fn add_v2_liquidity(ctx: Context<ModifyV2Liquidity>, max_a: u64, max_b: u64, min_liquidity: u128) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(!pool.deposit_paused, SwdmmV2Error::DepositPaused);
    require!(max_a > 0 && max_b > 0, SwdmmV2Error::ZeroAmount);
    let position = &mut ctx.accounts.position;
    position.settle(pool)?;

    let (liquidity, amount_a, amount_b) = if pool.liquidity == 0 {
        // First deposit sets the price; only the creator may make it, so
        // nobody can front-run the creator with a bad initial price.
        require_keys_eq!(ctx.accounts.owner.key(), pool.creator, SwdmmV2Error::OnlyCreatorFirstDeposit);
        require!(max_a >= V2_MIN_INITIAL_DEPOSIT && max_b >= V2_MIN_INITIAL_DEPOSIT, SwdmmV2Error::InitialDepositTooSmall);
        let total = m::initial_liquidity(max_a, max_b).ok_or(SwdmmV2Error::InitialDepositTooSmall)?;
        pool.liquidity = m::MINIMUM_LIQUIDITY;
        pool.locked_liquidity = m::MINIMUM_LIQUIDITY;
        pool.init_price_q64 = m::price_q64(max_a, max_b).ok_or(SwdmmV2Error::MathOverflow)?;
        pool.price_reference_q64 = pool.init_price_q64;
        (total - m::MINIMUM_LIQUIDITY, max_a, max_b)
    } else {
        m::deposit_quote(pool.reserve_a, pool.reserve_b, pool.liquidity, max_a, max_b)
            .ok_or(SwdmmV2Error::DepositTooSmall)?
    };
    require!(liquidity >= min_liquidity, SwdmmV2Error::SlippageExceeded);

    transfer_in(
        &ctx.accounts.token_program_a,
        &ctx.accounts.owner_token_a,
        &ctx.accounts.mint_a,
        &ctx.accounts.vault_a,
        &ctx.accounts.owner,
        amount_a,
    )?;
    transfer_in(
        &ctx.accounts.token_program_b,
        &ctx.accounts.owner_token_b,
        &ctx.accounts.mint_b,
        &ctx.accounts.vault_b,
        &ctx.accounts.owner,
        amount_b,
    )?;

    pool.reserve_a = pool.reserve_a.checked_add(amount_a).ok_or(SwdmmV2Error::MathOverflow)?;
    pool.reserve_b = pool.reserve_b.checked_add(amount_b).ok_or(SwdmmV2Error::MathOverflow)?;
    pool.liquidity = pool.liquidity.checked_add(liquidity).ok_or(SwdmmV2Error::MathOverflow)?;
    position.liquidity = position.liquidity.checked_add(liquidity).ok_or(SwdmmV2Error::MathOverflow)?;

    emit!(V2LiquidityChanged {
        pool: pool.key(),
        position: position.key(),
        owner: position.owner,
        added: true,
        liquidity,
        amount_a,
        amount_b,
        reserve_a: pool.reserve_a,
        reserve_b: pool.reserve_b,
    });
    Ok(())
}

pub(crate) fn remove_v2_liquidity(ctx: Context<ModifyV2Liquidity>, liquidity: u128, min_a: u64, min_b: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(!pool.withdraw_paused, SwdmmV2Error::WithdrawPaused);
    require!(liquidity > 0, SwdmmV2Error::ZeroAmount);
    let position = &mut ctx.accounts.position;
    require!(liquidity <= position.liquidity, SwdmmV2Error::InsufficientLiquidity);
    position.settle(pool)?;

    let (amount_a, amount_b) = m::withdraw_quote(pool.reserve_a, pool.reserve_b, pool.liquidity, liquidity)
        .ok_or(SwdmmV2Error::MathOverflow)?;
    require!(amount_a >= min_a && amount_b >= min_b, SwdmmV2Error::SlippageExceeded);

    position.liquidity -= liquidity;
    pool.liquidity = pool.liquidity.checked_sub(liquidity).ok_or(SwdmmV2Error::MathOverflow)?;
    pool.reserve_a = pool.reserve_a.checked_sub(amount_a).ok_or(SwdmmV2Error::MathOverflow)?;
    pool.reserve_b = pool.reserve_b.checked_sub(amount_b).ok_or(SwdmmV2Error::MathOverflow)?;

    let seeds = pool.signer_seeds();
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    transfer_out(&ctx.accounts.token_program_a, &ctx.accounts.vault_a, &ctx.accounts.mint_a, &ctx.accounts.owner_token_a, pool, &seed_refs, amount_a)?;
    transfer_out(&ctx.accounts.token_program_b, &ctx.accounts.vault_b, &ctx.accounts.mint_b, &ctx.accounts.owner_token_b, pool, &seed_refs, amount_b)?;

    emit!(V2LiquidityChanged {
        pool: pool.key(),
        position: position.key(),
        owner: position.owner,
        added: false,
        liquidity,
        amount_a,
        amount_b,
        reserve_a: pool.reserve_a,
        reserve_b: pool.reserve_b,
    });
    Ok(())
}

pub(crate) fn claim_v2_fees(ctx: Context<ModifyV2Liquidity>) -> Result<()> {
    // A withdraw pause stops every outflow to LPs, fees included
    // (2026-10-08): if the incident is a fee-accounting bug, claims are
    // exactly what must stop.
    require!(!ctx.accounts.pool.withdraw_paused, SwdmmV2Error::WithdrawPaused);
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    position.settle(pool)?;
    let (fa, fb) = (position.pending_fee_a, position.pending_fee_b);
    position.pending_fee_a = 0;
    position.pending_fee_b = 0;
    position.total_claimed_fee_a = position.total_claimed_fee_a.saturating_add(fa);
    position.total_claimed_fee_b = position.total_claimed_fee_b.saturating_add(fb);

    let seeds = pool.signer_seeds();
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    if fa > 0 {
        transfer_out(&ctx.accounts.token_program_a, &ctx.accounts.vault_a, &ctx.accounts.mint_a, &ctx.accounts.owner_token_a, pool, &seed_refs, fa)?;
    }
    if fb > 0 {
        transfer_out(&ctx.accounts.token_program_b, &ctx.accounts.vault_b, &ctx.accounts.mint_b, &ctx.accounts.owner_token_b, pool, &seed_refs, fb)?;
    }
    emit!(V2FeesClaimed { pool: pool.key(), position: position.key(), owner: position.owner, fee_a: fa, fee_b: fb });
    Ok(())
}

/// Permanently locks `liquidity` of a position. Irreversible: there is no
/// unlock instruction. Locked liquidity keeps earning claimable fees.
pub(crate) fn lock_v2_liquidity(ctx: Context<LockV2Liquidity>, liquidity: u128) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    require!(liquidity > 0 && liquidity <= position.liquidity, SwdmmV2Error::InsufficientLiquidity);
    position.settle(pool)?;
    position.liquidity -= liquidity;
    position.locked_liquidity = position.locked_liquidity.checked_add(liquidity).ok_or(SwdmmV2Error::MathOverflow)?;
    pool.locked_liquidity = pool.locked_liquidity.checked_add(liquidity).ok_or(SwdmmV2Error::MathOverflow)?;
    emit!(V2LiquidityLocked { pool: pool.key(), position: position.key(), owner: position.owner, liquidity });
    Ok(())
}

pub(crate) fn transfer_v2_position(ctx: Context<OwnV2Position>, new_owner: Pubkey) -> Result<()> {
    require_keys_neq!(new_owner, Pubkey::default(), SwdmmV2Error::InvalidOwner);
    let p = &mut ctx.accounts.position;
    let old = p.owner;
    p.owner = new_owner;
    emit!(V2PositionTransferred { position: p.key(), from: old, to: new_owner });
    Ok(())
}

pub(crate) fn close_v2_position(ctx: Context<CloseV2Position>) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let p = &mut ctx.accounts.position;
    p.settle(pool)?;
    require!(
        p.liquidity == 0 && p.locked_liquidity == 0 && p.pending_fee_a == 0 && p.pending_fee_b == 0,
        SwdmmV2Error::PositionNotEmpty
    );
    Ok(())
}

pub(crate) fn swap_v2(ctx: Context<SwapV2>, amount_in: u64, min_amount_out: u64, a_to_b: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let protocol_share = ctx.accounts.settings.protocol_fee_share_bps as u64;
    let pool = &mut ctx.accounts.pool;
    require!(!pool.swap_paused, SwdmmV2Error::SwapPaused);
    require!(now >= pool.activation_ts, SwdmmV2Error::NotActivated);
    require!(amount_in > 0, SwdmmV2Error::ZeroAmount);
    require!(pool.reserve_a > 0 && pool.reserve_b > 0, SwdmmV2Error::EmptyPool);

    let price_before = m::price_q64(pool.reserve_a, pool.reserve_b).ok_or(SwdmmV2Error::MathOverflow)?;

    // Optional Pyth guard: refuse a trade that leaves the pool too far
    // from the oracle price, unless it moves the price back toward it
    // (enforced below, once the post-trade price is known).
    let oracle_result = if pool.oracle.enabled {
        let (Some(pa), Some(pb)) = (&ctx.accounts.price_update_a, &ctx.accounts.price_update_b) else {
            return err!(SwdmmV2Error::OracleAccountsMissing);
        };
        Some(oracle::evaluate_oracle_and_fee(
            pa,
            pb,
            &pool.oracle.pyth_feed_id_a,
            &pool.oracle.pyth_feed_id_b,
            pool.oracle.max_staleness_secs,
            ctx.accounts.mint_a.decimals,
            ctx.accounts.mint_b.decimals,
            price_before,
            0,
            0,
            pool.oracle.max_deviation_bps,
            &Clock::get()?,
        )?)
    } else {
        None
    };

    // Fee = scheduled base fee + volatility fee.
    let base_bps = pool.current_base_fee_bps(now)?;
    let dyn_cfg = pool.dynamic_fee.to_math();
    let mut vol = pool.vol_state();
    if dyn_cfg.enabled {
        m::update_references(&dyn_cfg, &mut vol, now, price_before);
        m::accumulate(&dyn_cfg, &mut vol, price_before, now);
    }
    let var_bps = m::variable_fee_bps(&dyn_cfg, &vol);
    let fee_bps = m::total_fee_bps(base_bps, var_bps);

    let r = m::swap(pool.reserve_a, pool.reserve_b, amount_in, a_to_b, fee_bps, protocol_share, pool.collect_fee_mode)
        .ok_or(SwdmmV2Error::SwapTooLarge)?;
    require!(r.price_impact_bps <= pool.max_price_impact_bps as u64, SwdmmV2Error::PriceImpactTooHigh);
    require!(r.amount_out >= min_amount_out, SwdmmV2Error::SlippageExceeded);

    // Fee bookkeeping.
    let fee_token_b = r.fee_in_b;
    if !r.compounded && r.lp_fee > 0 {
        let growth = m::fee_growth(r.lp_fee, pool.liquidity).ok_or(SwdmmV2Error::MathOverflow)?;
        if fee_token_b {
            pool.fee_per_liquidity_b = pool.fee_per_liquidity_b.checked_add(growth).ok_or(SwdmmV2Error::MathOverflow)?;
        } else {
            pool.fee_per_liquidity_a = pool.fee_per_liquidity_a.checked_add(growth).ok_or(SwdmmV2Error::MathOverflow)?;
        }
    }
    if fee_token_b {
        pool.protocol_fee_b = pool.protocol_fee_b.checked_add(r.protocol_fee).ok_or(SwdmmV2Error::MathOverflow)?;
        pool.total_lp_fee_b = pool.total_lp_fee_b.saturating_add(r.lp_fee as u128);
        pool.total_protocol_fee_b = pool.total_protocol_fee_b.saturating_add(r.protocol_fee as u128);
    } else {
        pool.protocol_fee_a = pool.protocol_fee_a.checked_add(r.protocol_fee).ok_or(SwdmmV2Error::MathOverflow)?;
        pool.total_lp_fee_a = pool.total_lp_fee_a.saturating_add(r.lp_fee as u128);
        pool.total_protocol_fee_a = pool.total_protocol_fee_a.saturating_add(r.protocol_fee as u128);
    }
    if a_to_b {
        pool.total_volume_a = pool.total_volume_a.saturating_add(amount_in as u128);
        pool.total_volume_b = pool.total_volume_b.saturating_add(r.amount_out as u128);
    } else {
        pool.total_volume_b = pool.total_volume_b.saturating_add(amount_in as u128);
        pool.total_volume_a = pool.total_volume_a.saturating_add(r.amount_out as u128);
    }
    pool.reserve_a = r.new_reserve_a;
    pool.reserve_b = r.new_reserve_b;
    pool.swap_count = pool.swap_count.saturating_add(1);

    if let Some(o) = &oracle_result {
        let price_after = m::price_q64(pool.reserve_a, pool.reserve_b).ok_or(SwdmmV2Error::MathOverflow)?;
        o.enforce_guard(price_after)?;
    }

    // This swap's own move feeds the next swap's volatility fee.
    if dyn_cfg.enabled {
        let price_after = m::price_q64(pool.reserve_a, pool.reserve_b).ok_or(SwdmmV2Error::MathOverflow)?;
        m::accumulate(&dyn_cfg, &mut vol, price_after, now);
    }
    pool.set_vol_state(vol);

    // Token movements.
    let seeds = pool.signer_seeds();
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    if a_to_b {
        transfer_in(&ctx.accounts.token_program_a, &ctx.accounts.trader_token_a, &ctx.accounts.mint_a, &ctx.accounts.vault_a, &ctx.accounts.trader, amount_in)?;
        transfer_out(&ctx.accounts.token_program_b, &ctx.accounts.vault_b, &ctx.accounts.mint_b, &ctx.accounts.trader_token_b, pool, &seed_refs, r.amount_out)?;
    } else {
        transfer_in(&ctx.accounts.token_program_b, &ctx.accounts.trader_token_b, &ctx.accounts.mint_b, &ctx.accounts.vault_b, &ctx.accounts.trader, amount_in)?;
        transfer_out(&ctx.accounts.token_program_a, &ctx.accounts.vault_a, &ctx.accounts.mint_a, &ctx.accounts.trader_token_a, pool, &seed_refs, r.amount_out)?;
    }

    emit!(V2Swapped {
        pool: pool.key(),
        trader: ctx.accounts.trader.key(),
        a_to_b,
        amount_in,
        amount_out: r.amount_out,
        fee: r.fee,
        protocol_fee: r.protocol_fee,
        fee_in_b: r.fee_in_b,
        fee_bps: fee_bps as u16,
        base_fee_bps: base_bps as u16,
        price_impact_bps: r.price_impact_bps as u16,
        reserve_a: pool.reserve_a,
        reserve_b: pool.reserve_b,
        ts: now,
    });
    Ok(())
}

pub(crate) fn emergency_pause_v2_pool(ctx: Context<EmergencyPauseV2Pool>, swap: bool, deposit: bool, withdraw: bool) -> Result<()> {
    require!(swap || deposit || withdraw, GovernanceError::EmergencyPauseRequestEmpty);
    let p = &mut ctx.accounts.pool;
    if swap { p.swap_paused = true; }
    if deposit { p.deposit_paused = true; }
    if withdraw { p.withdraw_paused = true; }
    emit!(V2PoolPaused { pool: p.key(), swap_paused: p.swap_paused, deposit_paused: p.deposit_paused, withdraw_paused: p.withdraw_paused });
    Ok(())
}

/// Called by timelock.rs after a WithdrawV2ProtocolFees action matured.
#[allow(clippy::too_many_arguments)]
pub(crate) fn withdraw_protocol_fees<'info>(
    pool: &mut Box<Account<'info, SwdmmV2Pool>>,
    vault_a: &Box<InterfaceAccount<'info, TokenAccount>>,
    vault_b: &Box<InterfaceAccount<'info, TokenAccount>>,
    mint_a: &Box<InterfaceAccount<'info, Mint>>,
    mint_b: &Box<InterfaceAccount<'info, Mint>>,
    to_a: &Box<InterfaceAccount<'info, TokenAccount>>,
    to_b: &Box<InterfaceAccount<'info, TokenAccount>>,
    token_program_a: &Interface<'info, TokenInterface>,
    token_program_b: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let (fa, fb) = (pool.protocol_fee_a, pool.protocol_fee_b);
    pool.protocol_fee_a = 0;
    pool.protocol_fee_b = 0;
    let seeds = pool.signer_seeds();
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    if fa > 0 {
        transfer_out(token_program_a, vault_a, mint_a, to_a, pool, &seed_refs, fa)?;
    }
    if fb > 0 {
        transfer_out(token_program_b, vault_b, mint_b, to_b, pool, &seed_refs, fb)?;
    }
    emit!(V2ProtocolFeesWithdrawn { pool: pool.key(), fee_a: fa, fee_b: fb });
    Ok(())
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

fn check_mint_policy(policy: &Account<MintPolicy>, mint_ai: &AccountInfo, token_program: &Pubkey) -> Result<()> {
    require!(policy.enabled, SwdmmV2Error::MintNotAllowed);
    require_keys_eq!(policy.mint, *mint_ai.key, SwdmmV2Error::MintNotAllowed);
    require_keys_eq!(policy.token_program, *token_program, SwdmmV2Error::MintNotAllowed);
    require_keys_eq!(*mint_ai.owner, *token_program, SwdmmV2Error::MintNotAllowed);
    if *token_program == anchor_spl::token_2022::ID {
        require!(policy.is_token_2022 && policy.token_2022_reviewed, SwdmmV2Error::MintNotAllowed);
        crate::assert_mint_extensions_safe(mint_ai)?;
        assert_no_transfer_fee(mint_ai)?;
    }
    Ok(())
}

/// SWDMM v2 books nominal transfer amounts, so a Token-2022 mint that
/// withholds a fee on transfer would break its reserve accounting.
pub(crate) fn assert_no_transfer_fee(mint_ai: &AccountInfo) -> Result<()> {
    if *mint_ai.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let data = mint_ai.try_borrow_data()?;
    let state = StateWithExtensions::<SplToken2022Mint>::unpack(&data).map_err(|_| SwdmmV2Error::MintNotAllowed)?;
    let exts = state.get_extension_types().map_err(|_| SwdmmV2Error::MintNotAllowed)?;
    require!(!exts.contains(&ExtensionType::TransferFeeConfig), SwdmmV2Error::TransferFeeMintNotSupported);
    Ok(())
}

fn transfer_in<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer_checked(
        CpiContext::new(
            token_program.to_account_info(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

fn transfer_out<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    pool: &Account<'info, SwdmmV2Pool>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(params: InitializeV2PoolParams)]
pub struct InitializeV2Pool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(seeds = [GOV_SETTINGS_SEED], bump = settings.bump)]
    pub settings: Box<Account<'info, GovernanceSettings>>,

    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,

    #[account(seeds = [MINT_POLICY_SEED, mint_a.key().as_ref()], bump = mint_policy_a.bump)]
    pub mint_policy_a: Box<Account<'info, MintPolicy>>,
    #[account(seeds = [MINT_POLICY_SEED, mint_b.key().as_ref()], bump = mint_policy_b.bump)]
    pub mint_policy_b: Box<Account<'info, MintPolicy>>,

    #[account(
        init,
        payer = creator,
        space = 8 + SwdmmV2Pool::INIT_SPACE,
        seeds = [V2_POOL_SEED, mint_a.key().as_ref(), mint_b.key().as_ref(), &params.base_fee.floor_fee_bps.to_le_bytes()],
        bump
    )]
    pub pool: Box<Account<'info, SwdmmV2Pool>>,

    #[account(
        init,
        payer = creator,
        seeds = [V2_VAULT_SEED, pool.key().as_ref(), mint_a.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = pool,
        token::token_program = token_program_a
    )]
    pub vault_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = creator,
        seeds = [V2_VAULT_SEED, pool.key().as_ref(), mint_b.key().as_ref()],
        bump,
        token::mint = mint_b,
        token::authority = pool,
        token::token_program = token_program_b
    )]
    pub vault_b: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateV2Position<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [V2_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.base_fee.floor_fee_bps.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, SwdmmV2Pool>>,

    #[account(
        init,
        payer = owner,
        space = 8 + SwdmmV2Position::INIT_SPACE,
        seeds = [V2_POSITION_SEED, pool.key().as_ref(), &pool.position_count.to_le_bytes()],
        bump
    )]
    pub position: Box<Account<'info, SwdmmV2Position>>,

    pub system_program: Program<'info, System>,
}

/// Shared by add / remove liquidity and claim fees.
#[derive(Accounts)]
pub struct ModifyV2Liquidity<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [V2_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.base_fee.floor_fee_bps.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, SwdmmV2Pool>>,

    #[account(
        mut,
        seeds = [V2_POSITION_SEED, pool.key().as_ref(), &position.index.to_le_bytes()],
        bump = position.bump,
        constraint = position.pool == pool.key() @ SwdmmV2Error::PositionPoolMismatch,
        constraint = position.owner == owner.key() @ SwdmmV2Error::NotPositionOwner
    )]
    pub position: Box<Account<'info, SwdmmV2Position>>,

    #[account(address = pool.mint_a)]
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pool.mint_b)]
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = pool.vault_a)]
    pub vault_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.vault_b)]
    pub vault_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, token::mint = mint_a, token::authority = owner, token::token_program = token_program_a)]
    pub owner_token_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_b, token::authority = owner, token::token_program = token_program_b)]
    pub owner_token_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = pool.token_program_a)]
    pub token_program_a: Interface<'info, TokenInterface>,
    #[account(address = pool.token_program_b)]
    pub token_program_b: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct LockV2Liquidity<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [V2_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.base_fee.floor_fee_bps.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, SwdmmV2Pool>>,

    #[account(
        mut,
        seeds = [V2_POSITION_SEED, pool.key().as_ref(), &position.index.to_le_bytes()],
        bump = position.bump,
        constraint = position.pool == pool.key() @ SwdmmV2Error::PositionPoolMismatch,
        constraint = position.owner == owner.key() @ SwdmmV2Error::NotPositionOwner
    )]
    pub position: Box<Account<'info, SwdmmV2Position>>,
}

#[derive(Accounts)]
pub struct OwnV2Position<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [V2_POSITION_SEED, position.pool.as_ref(), &position.index.to_le_bytes()],
        bump = position.bump,
        constraint = position.owner == owner.key() @ SwdmmV2Error::NotPositionOwner
    )]
    pub position: Box<Account<'info, SwdmmV2Position>>,
}

#[derive(Accounts)]
pub struct CloseV2Position<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [V2_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.base_fee.floor_fee_bps.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, SwdmmV2Pool>>,

    #[account(
        mut,
        close = owner,
        seeds = [V2_POSITION_SEED, pool.key().as_ref(), &position.index.to_le_bytes()],
        bump = position.bump,
        constraint = position.pool == pool.key() @ SwdmmV2Error::PositionPoolMismatch,
        constraint = position.owner == owner.key() @ SwdmmV2Error::NotPositionOwner
    )]
    pub position: Box<Account<'info, SwdmmV2Position>>,
}

#[derive(Accounts)]
pub struct SwapV2<'info> {
    pub trader: Signer<'info>,

    #[account(seeds = [GOV_SETTINGS_SEED], bump = settings.bump)]
    pub settings: Box<Account<'info, GovernanceSettings>>,

    #[account(
        mut,
        seeds = [V2_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.base_fee.floor_fee_bps.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, SwdmmV2Pool>>,

    #[account(address = pool.mint_a)]
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pool.mint_b)]
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = pool.vault_a)]
    pub vault_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.vault_b)]
    pub vault_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, token::mint = mint_a, token::authority = trader, token::token_program = token_program_a)]
    pub trader_token_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_b, token::authority = trader, token::token_program = token_program_b)]
    pub trader_token_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = pool.token_program_a)]
    pub token_program_a: Interface<'info, TokenInterface>,
    #[account(address = pool.token_program_b)]
    pub token_program_b: Interface<'info, TokenInterface>,

    /// Required only when the pool has the oracle guard enabled.
    pub price_update_a: Option<Account<'info, PriceUpdateV2>>,
    pub price_update_b: Option<Account<'info, PriceUpdateV2>>,
}

#[derive(Accounts)]
pub struct EmergencyPauseV2Pool<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = emergency_authority.key() == config.emergency_authority @ GovernanceError::Unauthorized)]
    pub emergency_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [V2_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.base_fee.floor_fee_bps.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, SwdmmV2Pool>>,
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------

#[event]
pub struct V2PoolCreated {
    pub pool: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub creator: Pubkey,
    pub base_fee: BaseFeeParams,
    pub dynamic_fee_enabled: bool,
    pub collect_fee_mode: u8,
    pub activation_ts: i64,
    pub max_price_impact_bps: u16,
    pub oracle_enabled: bool,
}

#[event]
pub struct V2PositionCreated {
    pub pool: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub index: u64,
}

#[event]
pub struct V2LiquidityChanged {
    pub pool: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub added: bool,
    pub liquidity: u128,
    pub amount_a: u64,
    pub amount_b: u64,
    pub reserve_a: u64,
    pub reserve_b: u64,
}

#[event]
pub struct V2FeesClaimed {
    pub pool: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub fee_a: u64,
    pub fee_b: u64,
}

#[event]
pub struct V2LiquidityLocked {
    pub pool: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub liquidity: u128,
}

#[event]
pub struct V2PositionTransferred {
    pub position: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
}

#[event]
pub struct V2Swapped {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub a_to_b: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee: u64,
    pub protocol_fee: u64,
    pub fee_in_b: bool,
    pub fee_bps: u16,
    pub base_fee_bps: u16,
    pub price_impact_bps: u16,
    pub reserve_a: u64,
    pub reserve_b: u64,
    pub ts: i64,
}

#[event]
pub struct V2PoolPaused {
    pub pool: Pubkey,
    pub swap_paused: bool,
    pub deposit_paused: bool,
    pub withdraw_paused: bool,
}

#[event]
pub struct V2ProtocolFeesWithdrawn {
    pub pool: Pubkey,
    pub fee_a: u64,
    pub fee_b: u64,
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

#[error_code(offset = 8000)]
pub enum SwdmmV2Error {
    #[msg("Pool creation is paused")]
    PoolCreationPaused,
    #[msg("Mint A and Mint B must be different")]
    IdenticalMints,
    #[msg("Mint is not enabled in the SWDMM v2 mint policy (or its token program does not match)")]
    MintNotAllowed,
    #[msg("Token-2022 mints with a transfer fee are not supported by SWDMM v2")]
    TransferFeeMintNotSupported,
    #[msg("Invalid base fee / scheduler parameters")]
    InvalidBaseFee,
    #[msg("Invalid dynamic fee parameters")]
    InvalidDynamicFee,
    #[msg("Invalid fee collection mode")]
    InvalidCollectFeeMode,
    #[msg("Price impact cap must be between 1 and 5000 bps")]
    InvalidPriceImpactCap,
    #[msg("Activation time is too far in the future")]
    ActivationTooFar,
    #[msg("Trading has not started for this pool yet")]
    NotActivated,
    #[msg("Only the pool creator can make the first deposit")]
    OnlyCreatorFirstDeposit,
    #[msg("The first deposit is too small")]
    InitialDepositTooSmall,
    #[msg("Deposit is too small to mint any liquidity")]
    DepositTooSmall,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Price impact exceeds this pool's cap")]
    PriceImpactTooHigh,
    #[msg("Swap is too large for this pool")]
    SwapTooLarge,
    #[msg("Pool has no liquidity")]
    EmptyPool,
    #[msg("Not enough liquidity in this position")]
    InsufficientLiquidity,
    #[msg("Position still holds liquidity or unclaimed fees")]
    PositionNotEmpty,
    #[msg("Position does not belong to this pool")]
    PositionPoolMismatch,
    #[msg("Signer does not own this position")]
    NotPositionOwner,
    #[msg("Invalid new owner")]
    InvalidOwner,
    #[msg("Swaps are paused on this pool")]
    SwapPaused,
    #[msg("Deposits are paused on this pool")]
    DepositPaused,
    #[msg("Withdrawals are paused on this pool")]
    WithdrawPaused,
    #[msg("This pool's oracle guard needs both Pyth price accounts")]
    OracleAccountsMissing,
    #[msg("Math overflow")]
    MathOverflow,
}
