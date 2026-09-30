// Governance v2: timelock, protocol fee settings and per-mint token policy.
//
// Added 2026-09-29 (SWDMM v2, step 1). Builds on governance.rs's
// GlobalConfig (governance / emergency authorities) without changing its
// account layout, so the GlobalConfig already live on devnet keeps
// working.
//
// WHAT THIS ADDS
// 1. GovernanceSettings (singleton PDA "gov_settings"): the timelock delay,
//    the protocol's share of SWDMM v2 trading fees and the treasury that
//    receives it.
// 2. Timelocked governance actions: governance PROPOSES an action (stored
//    in its own PendingAction PDA with an `execute_after` timestamp);
//    after the delay ANYONE can EXECUTE it (so a proposal can't be held
//    hostage), and governance can CANCEL it before that. Everything that
//    changes fees, unpauses a pool or moves protocol fees goes through
//    here:
//      - unpause a constant-product, DLMM or SWDMM v2 pool
//      - protocol fee share, timelock delay, treasury
//      - SWDMM v2 pool risk parameters (price-impact cap, dynamic fee on/off)
//      - withdraw accrued SWDMM v2 protocol fees to the treasury
//    The old instant `governed_unpause_pool` / `governed_unpause_dlmm_pool`
//    are refused once GovernanceSettings exists (see governance.rs).
// 3. MintPolicy (per-mint PDA "mint_policy"): allowlist entry that also
//    pins the mint's token program and, for Token-2022 mints, requires an
//    explicit "reviewed" flag plus the extension safety gate. SWDMM v2
//    pools require a MintPolicy for both mints.
//
// TIMELOCK BOUNDS
// - Build with `--features mainnet` for a mainnet deployment: the delay
//   must be 24h-48h, as the SWDMM spec requires.
// - Default (localnet / devnet) builds allow 5s-48h so the flow can be
//   tested without waiting a day. `GovernanceSettingsInitialized.mainnet_build`
//   records which build created the settings; the mainnet runbook checks it.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::governance::{GlobalConfig, GovernanceError, GLOBAL_CONFIG_SEED};
use crate::swdmm_v2::{SwdmmV2Pool, V2_POOL_SEED};
use crate::{DlmmPool, Pool, DLMM_POOL_SEED, POOL_SEED};

pub const GOV_SETTINGS_SEED: &[u8] = b"gov_settings";
pub const PENDING_ACTION_SEED: &[u8] = b"gov_action";
pub const MINT_POLICY_SEED: &[u8] = b"mint_policy";

#[cfg(feature = "mainnet")]
pub const MIN_TIMELOCK_SECS: i64 = 24 * 60 * 60;
#[cfg(not(feature = "mainnet"))]
pub const MIN_TIMELOCK_SECS: i64 = 5;
pub const MAX_TIMELOCK_SECS: i64 = 48 * 60 * 60;

/// Protocol share of SWDMM v2 trading fees can never exceed 20%.
pub const MAX_PROTOCOL_FEE_SHARE_BPS: u16 = 2_000;

pub fn is_mainnet_build() -> bool {
    cfg!(feature = "mainnet")
}

// ---------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------

pub(crate) fn initialize_governance_settings(
    ctx: Context<InitializeGovernanceSettings>,
    timelock_delay_secs: i64,
    protocol_fee_share_bps: u16,
    treasury: Pubkey,
) -> Result<()> {
    validate_delay(timelock_delay_secs)?;
    require!(protocol_fee_share_bps <= MAX_PROTOCOL_FEE_SHARE_BPS, TimelockError::ProtocolFeeShareTooHigh);
    require_keys_neq!(treasury, Pubkey::default(), TimelockError::InvalidTreasury);
    let s = &mut ctx.accounts.settings;
    s.timelock_delay_secs = timelock_delay_secs;
    s.protocol_fee_share_bps = protocol_fee_share_bps;
    s.treasury = treasury;
    s.next_action_id = 0;
    s.bump = ctx.bumps.settings;
    emit!(GovernanceSettingsInitialized {
        settings: s.key(),
        timelock_delay_secs,
        protocol_fee_share_bps,
        treasury,
        mainnet_build: is_mainnet_build(),
    });
    Ok(())
}

pub(crate) fn propose_action(ctx: Context<ProposeAction>, action: GovAction) -> Result<()> {
    validate_action(&action)?;
    let now = Clock::get()?.unix_timestamp;
    let s = &mut ctx.accounts.settings;
    let id = s.next_action_id;
    s.next_action_id = id.checked_add(1).ok_or(TimelockError::MathOverflow)?;
    let execute_after = now.checked_add(s.timelock_delay_secs).ok_or(TimelockError::MathOverflow)?;
    let p = &mut ctx.accounts.pending;
    p.id = id;
    p.action = action.clone();
    p.proposer = ctx.accounts.governance_authority.key();
    p.created_at = now;
    p.execute_after = execute_after;
    p.executed = false;
    p.cancelled = false;
    p.bump = ctx.bumps.pending;
    emit!(GovActionProposed { id, action, execute_after });
    Ok(())
}

pub(crate) fn cancel_action(ctx: Context<CancelAction>) -> Result<()> {
    let p = &mut ctx.accounts.pending;
    require!(!p.executed && !p.cancelled, TimelockError::ActionNotPending);
    p.cancelled = true;
    emit!(GovActionCancelled { id: p.id });
    Ok(())
}

/// Shared checks for every execute_* instruction: still pending and the
/// delay has passed. Marks it executed.
fn take_ready(p: &mut Account<PendingAction>) -> Result<GovAction> {
    require!(!p.executed && !p.cancelled, TimelockError::ActionNotPending);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= p.execute_after, TimelockError::TimelockNotElapsed);
    p.executed = true;
    emit!(GovActionExecuted { id: p.id });
    Ok(p.action.clone())
}

pub(crate) fn execute_unpause_pool(ctx: Context<ExecuteUnpausePool>) -> Result<()> {
    match take_ready(&mut ctx.accounts.pending)? {
        GovAction::UnpauseCpPool { pool, swap, deposit, withdraw } => {
            require_keys_eq!(pool, ctx.accounts.pool.key(), TimelockError::ActionAccountMismatch);
            let p = &mut ctx.accounts.pool;
            if swap { p.swap_paused = false; }
            if deposit { p.deposit_paused = false; }
            if withdraw { p.withdraw_paused = false; }
            Ok(())
        }
        _ => err!(TimelockError::WrongActionKind),
    }
}

pub(crate) fn execute_unpause_dlmm_pool(ctx: Context<ExecuteUnpauseDlmmPool>) -> Result<()> {
    match take_ready(&mut ctx.accounts.pending)? {
        GovAction::UnpauseDlmmPool { pool, swap, deposit, withdraw } => {
            require_keys_eq!(pool, ctx.accounts.pool.key(), TimelockError::ActionAccountMismatch);
            let p = &mut ctx.accounts.pool;
            if swap { p.swap_paused = false; }
            if deposit { p.deposit_paused = false; }
            if withdraw { p.withdraw_paused = false; }
            Ok(())
        }
        _ => err!(TimelockError::WrongActionKind),
    }
}

pub(crate) fn execute_v2_pool_action(ctx: Context<ExecuteV2PoolAction>) -> Result<()> {
    let action = take_ready(&mut ctx.accounts.pending)?;
    let pool_key = ctx.accounts.pool.key();
    let p = &mut ctx.accounts.pool;
    match action {
        GovAction::UnpauseV2Pool { pool, swap, deposit, withdraw } => {
            require_keys_eq!(pool, pool_key, TimelockError::ActionAccountMismatch);
            if swap { p.swap_paused = false; }
            if deposit { p.deposit_paused = false; }
            if withdraw { p.withdraw_paused = false; }
        }
        GovAction::SetV2PoolParams { pool, max_price_impact_bps, dynamic_fee_enabled } => {
            require_keys_eq!(pool, pool_key, TimelockError::ActionAccountMismatch);
            p.max_price_impact_bps = max_price_impact_bps;
            p.dynamic_fee.enabled = dynamic_fee_enabled && p.dynamic_fee.max_dynamic_fee_bps > 0;
        }
        _ => return err!(TimelockError::WrongActionKind),
    }
    Ok(())
}

pub(crate) fn execute_settings_action(ctx: Context<ExecuteSettingsAction>) -> Result<()> {
    let action = take_ready(&mut ctx.accounts.pending)?;
    let s = &mut ctx.accounts.settings;
    match action {
        GovAction::SetProtocolFeeShare { bps } => s.protocol_fee_share_bps = bps,
        GovAction::SetTimelockDelay { secs } => s.timelock_delay_secs = secs,
        GovAction::SetTreasury { treasury } => s.treasury = treasury,
        _ => return err!(TimelockError::WrongActionKind),
    }
    Ok(())
}

/// Moves a SWDMM v2 pool's accrued protocol fees to the treasury's token
/// accounts. Only reachable through a timelocked WithdrawV2ProtocolFees.
pub(crate) fn execute_withdraw_protocol_fees(ctx: Context<ExecuteWithdrawProtocolFees>) -> Result<()> {
    match take_ready(&mut ctx.accounts.pending)? {
        GovAction::WithdrawV2ProtocolFees { pool } => {
            require_keys_eq!(pool, ctx.accounts.pool.key(), TimelockError::ActionAccountMismatch);
        }
        _ => return err!(TimelockError::WrongActionKind),
    }
    crate::swdmm_v2::withdraw_protocol_fees(
        &mut ctx.accounts.pool,
        &ctx.accounts.vault_a,
        &ctx.accounts.vault_b,
        &ctx.accounts.mint_a,
        &ctx.accounts.mint_b,
        &ctx.accounts.treasury_token_a,
        &ctx.accounts.treasury_token_b,
        &ctx.accounts.token_program_a,
        &ctx.accounts.token_program_b,
    )
}

pub(crate) fn set_mint_policy(ctx: Context<SetMintPolicy>, enabled: bool, token_2022_reviewed: bool) -> Result<()> {
    let token_program = ctx.accounts.token_program.key();
    let mint_ai = ctx.accounts.mint.to_account_info();
    require_keys_eq!(*mint_ai.owner, token_program, TimelockError::TokenProgramMismatch);
    let is_2022 = token_program == anchor_spl::token_2022::ID;
    if is_2022 && enabled {
        require!(token_2022_reviewed, TimelockError::Token2022NotReviewed);
        crate::assert_mint_extensions_safe(&mint_ai)?;
        // SWDMM v2 reserve math assumes nominal == received amounts, so a
        // transfer-fee mint is refused here even though the CP pool
        // (lib.rs) can handle it.
        crate::swdmm_v2::assert_no_transfer_fee(&mint_ai)?;
    }
    let m = &mut ctx.accounts.mint_policy;
    m.mint = ctx.accounts.mint.key();
    m.token_program = token_program;
    m.enabled = enabled;
    m.is_token_2022 = is_2022;
    m.token_2022_reviewed = is_2022 && token_2022_reviewed;
    m.bump = ctx.bumps.mint_policy;
    emit!(MintPolicyUpdated {
        mint: m.mint,
        token_program,
        enabled,
        token_2022_reviewed: m.token_2022_reviewed,
    });
    Ok(())
}

fn validate_delay(secs: i64) -> Result<()> {
    require!(
        (MIN_TIMELOCK_SECS..=MAX_TIMELOCK_SECS).contains(&secs),
        TimelockError::InvalidTimelockDelay
    );
    Ok(())
}

fn validate_action(a: &GovAction) -> Result<()> {
    match a {
        GovAction::UnpauseCpPool { swap, deposit, withdraw, .. }
        | GovAction::UnpauseDlmmPool { swap, deposit, withdraw, .. }
        | GovAction::UnpauseV2Pool { swap, deposit, withdraw, .. } => {
            require!(*swap || *deposit || *withdraw, TimelockError::EmptyUnpause);
        }
        GovAction::SetProtocolFeeShare { bps } => {
            require!(*bps <= MAX_PROTOCOL_FEE_SHARE_BPS, TimelockError::ProtocolFeeShareTooHigh);
        }
        GovAction::SetTimelockDelay { secs } => validate_delay(*secs)?,
        GovAction::SetTreasury { treasury } => {
            require_keys_neq!(*treasury, Pubkey::default(), TimelockError::InvalidTreasury);
        }
        GovAction::SetV2PoolParams { max_price_impact_bps, .. } => {
            require!(
                *max_price_impact_bps > 0 && *max_price_impact_bps <= crate::swdmm_v2::MAX_PRICE_IMPACT_BPS,
                TimelockError::InvalidPriceImpactCap
            );
        }
        GovAction::WithdrawV2ProtocolFees { .. } => {}
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeGovernanceSettings<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = governance_authority.key() == config.governance_authority @ GovernanceError::Unauthorized)]
    pub governance_authority: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + GovernanceSettings::INIT_SPACE,
        seeds = [GOV_SETTINGS_SEED],
        bump
    )]
    pub settings: Account<'info, GovernanceSettings>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeAction<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = governance_authority.key() == config.governance_authority @ GovernanceError::Unauthorized)]
    pub governance_authority: Signer<'info>,

    #[account(mut, seeds = [GOV_SETTINGS_SEED], bump = settings.bump)]
    pub settings: Account<'info, GovernanceSettings>,

    #[account(
        init,
        payer = payer,
        space = 8 + PendingAction::INIT_SPACE,
        seeds = [PENDING_ACTION_SEED, &settings.next_action_id.to_le_bytes()],
        bump
    )]
    pub pending: Account<'info, PendingAction>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelAction<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = governance_authority.key() == config.governance_authority @ GovernanceError::Unauthorized)]
    pub governance_authority: Signer<'info>,

    #[account(mut, seeds = [PENDING_ACTION_SEED, &pending.id.to_le_bytes()], bump = pending.bump)]
    pub pending: Account<'info, PendingAction>,
}

#[derive(Accounts)]
pub struct ExecuteUnpausePool<'info> {
    #[account(mut, seeds = [PENDING_ACTION_SEED, &pending.id.to_le_bytes()], bump = pending.bump)]
    pub pending: Account<'info, PendingAction>,

    #[account(mut, seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct ExecuteUnpauseDlmmPool<'info> {
    #[account(mut, seeds = [PENDING_ACTION_SEED, &pending.id.to_le_bytes()], bump = pending.bump)]
    pub pending: Account<'info, PendingAction>,

    #[account(mut, seeds = [DLMM_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, DlmmPool>,
}

#[derive(Accounts)]
pub struct ExecuteV2PoolAction<'info> {
    #[account(mut, seeds = [PENDING_ACTION_SEED, &pending.id.to_le_bytes()], bump = pending.bump)]
    pub pending: Account<'info, PendingAction>,

    #[account(
        mut,
        seeds = [V2_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.base_fee.floor_fee_bps.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, SwdmmV2Pool>>,
}

#[derive(Accounts)]
pub struct ExecuteSettingsAction<'info> {
    #[account(mut, seeds = [PENDING_ACTION_SEED, &pending.id.to_le_bytes()], bump = pending.bump)]
    pub pending: Account<'info, PendingAction>,

    #[account(mut, seeds = [GOV_SETTINGS_SEED], bump = settings.bump)]
    pub settings: Account<'info, GovernanceSettings>,
}

#[derive(Accounts)]
pub struct ExecuteWithdrawProtocolFees<'info> {
    #[account(mut, seeds = [PENDING_ACTION_SEED, &pending.id.to_le_bytes()], bump = pending.bump)]
    pub pending: Account<'info, PendingAction>,

    #[account(seeds = [GOV_SETTINGS_SEED], bump = settings.bump)]
    pub settings: Account<'info, GovernanceSettings>,

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

    #[account(
        mut,
        token::mint = mint_a,
        token::authority = settings.treasury,
        token::token_program = token_program_a
    )]
    pub treasury_token_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint_b,
        token::authority = settings.treasury,
        token::token_program = token_program_b
    )]
    pub treasury_token_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = pool.token_program_a)]
    pub token_program_a: Interface<'info, TokenInterface>,
    #[account(address = pool.token_program_b)]
    pub token_program_b: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetMintPolicy<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = governance_authority.key() == config.governance_authority @ GovernanceError::Unauthorized)]
    pub governance_authority: Signer<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + MintPolicy::INIT_SPACE,
        seeds = [MINT_POLICY_SEED, mint.key().as_ref()],
        bump
    )]
    pub mint_policy: Account<'info, MintPolicy>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct GovernanceSettings {
    pub timelock_delay_secs: i64,
    pub protocol_fee_share_bps: u16,
    pub treasury: Pubkey,
    pub next_action_id: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, InitSpace)]
pub enum GovAction {
    UnpauseCpPool { pool: Pubkey, swap: bool, deposit: bool, withdraw: bool },
    UnpauseDlmmPool { pool: Pubkey, swap: bool, deposit: bool, withdraw: bool },
    UnpauseV2Pool { pool: Pubkey, swap: bool, deposit: bool, withdraw: bool },
    SetProtocolFeeShare { bps: u16 },
    SetTimelockDelay { secs: i64 },
    SetTreasury { treasury: Pubkey },
    SetV2PoolParams { pool: Pubkey, max_price_impact_bps: u16, dynamic_fee_enabled: bool },
    WithdrawV2ProtocolFees { pool: Pubkey },
}

#[account]
#[derive(InitSpace)]
pub struct PendingAction {
    pub id: u64,
    pub action: GovAction,
    pub proposer: Pubkey,
    pub created_at: i64,
    pub execute_after: i64,
    pub executed: bool,
    pub cancelled: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MintPolicy {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub enabled: bool,
    pub is_token_2022: bool,
    pub token_2022_reviewed: bool,
    pub bump: u8,
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------

#[event]
pub struct GovernanceSettingsInitialized {
    pub settings: Pubkey,
    pub timelock_delay_secs: i64,
    pub protocol_fee_share_bps: u16,
    pub treasury: Pubkey,
    pub mainnet_build: bool,
}

#[event]
pub struct GovActionProposed {
    pub id: u64,
    pub action: GovAction,
    pub execute_after: i64,
}

#[event]
pub struct GovActionCancelled {
    pub id: u64,
}

#[event]
pub struct GovActionExecuted {
    pub id: u64,
}

#[event]
pub struct MintPolicyUpdated {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub enabled: bool,
    pub token_2022_reviewed: bool,
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

#[error_code(offset = 8500)]
pub enum TimelockError {
    #[msg("Timelock delay is outside the allowed range for this build")]
    InvalidTimelockDelay,
    #[msg("Protocol fee share exceeds the 20% maximum")]
    ProtocolFeeShareTooHigh,
    #[msg("Treasury cannot be the default pubkey")]
    InvalidTreasury,
    #[msg("This governance action is not pending (already executed or cancelled)")]
    ActionNotPending,
    #[msg("The timelock delay has not elapsed yet")]
    TimelockNotElapsed,
    #[msg("This instruction cannot execute this kind of governance action")]
    WrongActionKind,
    #[msg("The account passed does not match the governance action")]
    ActionAccountMismatch,
    #[msg("An unpause action must clear at least one flag")]
    EmptyUnpause,
    #[msg("Price impact cap must be between 1 and MAX_PRICE_IMPACT_BPS")]
    InvalidPriceImpactCap,
    #[msg("Mint is not owned by the given token program")]
    TokenProgramMismatch,
    #[msg("Token-2022 mints must be explicitly marked as reviewed")]
    Token2022NotReviewed,
    #[msg("Instant unpause is disabled: use the timelocked propose/execute flow")]
    UseTimelockedUnpause,
    #[msg("Math overflow")]
    MathOverflow,
}
