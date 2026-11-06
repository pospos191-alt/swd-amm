// SWD Mine — on-chain verified payouts for SWD (SAWASDEE COIN) browser mining.
//
// ============================================================================
// STATUS (2026-11-06): UNAUDITED DRAFT. NOT DEPLOYED ANYWHERE.
// Devnet first, then an INDEPENDENT AUDIT, then mainnet through Squads.
// See docs/SWD_MINE.md (design, threat model, deploy steps).
// ============================================================================
//
// What it replaces: the website's off-chain mining pays from a HOT mining
// wallet whose secret key lives on the web server (lib/mine/swd-server.ts in
// the site repo). Here the SWD sits in a vault token account owned by this
// program's Config PDA; no private key can move it. The website only SIGNS
// CHALLENGES (Ed25519, a key that holds no funds): its IP / sybil / reputation
// rules decide who gets a challenge, and this program decides — from the
// signature, the clock, the work and its own caps — whether a proof is paid.
//
// Flow:
//   1. site → wallet: challenge (seq, bits, expires_at) + Ed25519 signature
//      over `logic::challenge_message(program_id, wallet, seq, bits, expires_at)`.
//   2. wallet's browser finds `nonce` with
//      sha256(pow_prefix(challenge, wallet) || nonce_be) having ≥ bits
//      leading zero bits (the 60-byte-prefix shape the site's workers use).
//   3. wallet sends ONE transaction: [Ed25519 precompile ix (signer pubkey,
//      signature, message), submit_proof(seq, bits, expires_at, nonce)].
//      submit_proof reads the precompile ix right before it (instructions
//      sysvar) and checks it verified exactly that message under
//      `config.challenge_signer`; then expiry, single use (per-wallet
//      strictly increasing seq), work, wallet/site day caps, budget; then
//      accrues the reward on the wallet's Miner PDA.
//   4. claim(): the wallet pulls its whole accrued balance from the vault to
//      its own SWD associated token account (the wallet pays fees and, if
//      needed, the ATA rent).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub mod logic;
use logic::{Counters, ParamValues};

// TODO(before build): run `solana-keygen new -o target/deploy/swd_mine-keypair.json`
// after your first `anchor build`, then `anchor keys list` and paste the
// real program id here AND in Anchor.toml's [programs.*] swd_mine entries.
declare_id!("2zMuwaF7NXovgqSnpreRrYBLkhmABEkg6PWTEznA5RDF");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MINER_SEED: &[u8] = b"miner";

/// The real SWD mint (classic SPL Token, 5 decimals). Enforced by
/// `initialize` only in a `--features mainnet` build, so devnet/localnet can
/// use a test mint.
pub const SWD_MINT: Pubkey = pubkey!("Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL");

#[program]
pub mod swd_mine {
    use super::*;

    /// Creates the Config PDA and the PDA-owned vault. Only the program's
    /// UPGRADE AUTHORITY may call it (read from ProgramData), so nobody can
    /// front-run a fresh deploy and make themselves the authority — the same
    /// rule swd_amm's `initialize_global_config` uses. `authority` may be a
    /// different key (e.g. the Squads vault PDA) than the payer.
    pub fn initialize(
        ctx: Context<Initialize>,
        authority: Pubkey,
        guardian: Pubkey,
        challenge_signer: Pubkey,
        params: MineParams,
    ) -> Result<()> {
        let (expected_program_data, _) = Pubkey::find_program_address(
            &[crate::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        );
        require_keys_eq!(
            ctx.accounts.program_data.key(),
            expected_program_data,
            MineError::Unauthorized
        );
        require!(
            ctx.accounts.program_data.upgrade_authority_address == Some(ctx.accounts.payer.key()),
            MineError::Unauthorized
        );
        #[cfg(feature = "mainnet")]
        require_keys_eq!(ctx.accounts.mint.key(), SWD_MINT, MineError::WrongMint);
        require_keys_neq!(authority, Pubkey::default(), MineError::InvalidAuthority);
        require_keys_neq!(guardian, Pubkey::default(), MineError::InvalidAuthority);
        require_keys_neq!(challenge_signer, Pubkey::default(), MineError::InvalidChallengeSigner);
        logic::validate_params(&params.values(), 0)?;

        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.pending_authority = Pubkey::default();
        config.guardian = guardian;
        config.mint = ctx.accounts.mint.key();
        config.vault = ctx.accounts.vault.key();
        config.challenge_signer = challenge_signer;
        config.apply(&params);
        config.mining_paused = false;
        config.claims_paused = false;
        config.total_credited = 0;
        config.total_claimed = 0;
        config.total_proofs = 0;
        config.site_day = 0;
        config.site_day_credited = 0;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.vault;

        emit!(Initialized {
            config: config.key(),
            authority,
            guardian,
            mint: config.mint,
            vault: config.vault,
            challenge_signer,
            params,
        });
        Ok(())
    }

    /// Submits one proof of work on a challenge the website signed. The
    /// instruction immediately before this one in the same transaction must
    /// be the Ed25519 precompile verifying `config.challenge_signer`'s
    /// signature over `logic::challenge_message(...)` for these arguments
    /// and the signing wallet.
    pub fn submit_proof(
        ctx: Context<SubmitProof>,
        seq: u64,
        bits: u8,
        expires_at: i64,
        nonce: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.mining_paused, MineError::MiningPaused);
        let wallet = ctx.accounts.wallet.key();

        // --- 1. the challenge is the one the site signed, for this wallet
        let msg = logic::challenge_message(&crate::ID, &wallet, seq, bits, expires_at);
        verify_challenge_signature(
            &ctx.accounts.instructions.to_account_info(),
            &config.challenge_signer,
            &msg,
        )?;

        // --- 2. fresh Miner PDA (init_if_needed): bind it to the wallet once
        let miner = &mut ctx.accounts.miner;
        if miner.wallet == Pubkey::default() {
            miner.wallet = wallet;
            miner.bump = ctx.bumps.miner;
        }
        require_keys_eq!(miner.wallet, wallet, MineError::Unauthorized);

        // --- 3. expiry, difficulty, single use
        let now = Clock::get()?.unix_timestamp;
        logic::check_challenge(
            bits,
            config.difficulty_bits,
            expires_at,
            now,
            config.max_challenge_ttl_secs,
            seq,
            miner.last_seq,
        )?;

        // --- 4. the work
        let zero_bits = logic::check_work(&msg, &wallet, nonce, bits)?;

        // --- 5. caps + accrual (pure, all-or-nothing)
        let today = logic::day_index(now);
        let before = Counters {
            wallet_day: miner.day,
            wallet_day_credited: miner.day_credited,
            wallet_accrued: miner.accrued,
            wallet_total_mined: miner.total_mined,
            site_day: config.site_day,
            site_day_credited: config.site_day_credited,
            total_credited: config.total_credited,
        };
        let after = logic::credit(before, today, &config.values())?;

        miner.last_seq = seq;
        miner.day = after.wallet_day;
        miner.day_credited = after.wallet_day_credited;
        miner.accrued = after.wallet_accrued;
        miner.total_mined = after.wallet_total_mined;
        miner.proofs = miner.proofs.checked_add(1).ok_or(MineError::MathOverflow)?;
        config.site_day = after.site_day;
        config.site_day_credited = after.site_day_credited;
        config.total_credited = after.total_credited;
        config.total_proofs = config.total_proofs.checked_add(1).ok_or(MineError::MathOverflow)?;

        emit!(ProofAccepted {
            wallet,
            seq,
            bits,
            zero_bits: zero_bits.min(255) as u8,
            reward: config.reward_per_proof,
            accrued: miner.accrued,
            day: today,
            wallet_day_credited: miner.day_credited,
            site_day_credited: config.site_day_credited,
            total_credited: config.total_credited,
        });
        Ok(())
    }

    /// Pays the wallet's whole accrued balance from the vault to the
    /// wallet's own SWD associated token account (created if missing; the
    /// wallet pays).
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.claims_paused, MineError::ClaimsPaused);
        let amount = ctx.accounts.miner.accrued;
        require!(amount > 0, MineError::NothingToClaim);
        require!(ctx.accounts.vault.amount >= amount, MineError::VaultInsufficient);

        let bump = [config.bump];
        let seeds: &[&[u8]] = &[CONFIG_SEED, &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.wallet_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let miner = &mut ctx.accounts.miner;
        miner.accrued = 0;
        miner.total_claimed = miner.total_claimed.checked_add(amount).ok_or(MineError::MathOverflow)?;
        let config = &mut ctx.accounts.config;
        config.total_claimed = config.total_claimed.checked_add(amount).ok_or(MineError::MathOverflow)?;
        require!(config.total_claimed <= config.total_credited, MineError::InvariantViolation);

        emit!(Claimed {
            wallet: miner.wallet,
            amount,
            to: ctx.accounts.wallet_ata.key(),
            total_claimed: config.total_claimed,
        });
        Ok(())
    }

    // ------------------------------------------------------------------ admin

    pub fn set_params(ctx: Context<AdminOnly>, params: MineParams) -> Result<()> {
        let config = &mut ctx.accounts.config;
        logic::validate_params(&params.values(), config.total_credited)?;
        config.apply(&params);
        emit!(ParamsUpdated { authority: ctx.accounts.authority.key(), params });
        Ok(())
    }

    /// Emergency switch. `mining_paused` stops submit_proof; `claims_paused`
    /// stops claim (use both if the challenge-signer key may have leaked).
    pub fn set_paused(ctx: Context<AdminOnly>, mining_paused: bool, claims_paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.mining_paused = mining_paused;
        config.claims_paused = claims_paused;
        emit!(PausedSet { authority: ctx.accounts.authority.key(), mining_paused, claims_paused });
        Ok(())
    }

    /// Guardian (a single hot-ish key held by the on-call person, NOT a
    /// Squads member) or the authority: pause BOTH mining and claims at once.
    /// It can only pause; un-pausing needs the authority (Squads).
    pub fn emergency_pause(ctx: Context<EmergencyPause>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let by = ctx.accounts.signer.key();
        require!(by == config.guardian || by == config.authority, MineError::Unauthorized);
        config.mining_paused = true;
        config.claims_paused = true;
        emit!(PausedSet { authority: by, mining_paused: true, claims_paused: true });
        Ok(())
    }

    pub fn set_guardian(ctx: Context<AdminOnly>, guardian: Pubkey) -> Result<()> {
        require_keys_neq!(guardian, Pubkey::default(), MineError::InvalidAuthority);
        let config = &mut ctx.accounts.config;
        let old = config.guardian;
        config.guardian = guardian;
        emit!(GuardianSet { authority: ctx.accounts.authority.key(), old, new: guardian });
        Ok(())
    }

    /// Rotates the website's challenge-signing key. Every challenge signed by
    /// the old key stops working at once.
    pub fn set_challenge_signer(ctx: Context<AdminOnly>, challenge_signer: Pubkey) -> Result<()> {
        require_keys_neq!(challenge_signer, Pubkey::default(), MineError::InvalidChallengeSigner);
        let config = &mut ctx.accounts.config;
        let old = config.challenge_signer;
        config.challenge_signer = challenge_signer;
        emit!(ChallengeSignerSet { authority: ctx.accounts.authority.key(), old, new: challenge_signer });
        Ok(())
    }

    /// Step 1 of a two-step authority handover (e.g. to the Squads vault).
    pub fn transfer_authority(ctx: Context<AdminOnly>, new_authority: Pubkey) -> Result<()> {
        require_keys_neq!(new_authority, Pubkey::default(), MineError::InvalidAuthority);
        let config = &mut ctx.accounts.config;
        config.pending_authority = new_authority;
        emit!(AuthorityTransferStarted { authority: config.authority, pending: new_authority });
        Ok(())
    }

    /// Step 2: the new authority signs to accept.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_neq!(config.pending_authority, Pubkey::default(), MineError::Unauthorized);
        require_keys_eq!(config.pending_authority, ctx.accounts.new_authority.key(), MineError::Unauthorized);
        let old = config.authority;
        config.authority = config.pending_authority;
        config.pending_authority = Pubkey::default();
        emit!(AuthorityTransferred { old, new: config.authority });
        Ok(())
    }

    /// Moves SWD out of the vault to a token account OWNED BY THE AUTHORITY,
    /// only while mining is paused. Normally limited to what is not owed to
    /// miners; the whole vault only when claims are paused too (emergency).
    pub fn withdraw_unused(ctx: Context<WithdrawUnused>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(config.mining_paused, MineError::NotPaused);
        require!(amount > 0, MineError::ZeroAmount);
        let max = logic::withdrawable(
            ctx.accounts.vault.amount,
            config.total_credited,
            config.total_claimed,
            config.claims_paused,
        )?;
        require!(amount <= max, MineError::WithdrawTooMuch);

        let bump = [config.bump];
        let seeds: &[&[u8]] = &[CONFIG_SEED, &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(UnusedWithdrawn {
            authority: ctx.accounts.authority.key(),
            destination: ctx.accounts.destination.key(),
            amount,
            claims_paused: config.claims_paused,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Ed25519 instruction introspection
// ---------------------------------------------------------------------------

/// The instruction right before the current one must be the Ed25519
/// precompile, with no accounts, verifying ONE signature by `signer` over
/// exactly `expected_msg` (all data inside that instruction). If the
/// transaction executes, the runtime has already checked that signature.
fn verify_challenge_signature(
    instructions: &AccountInfo,
    signer: &Pubkey,
    expected_msg: &[u8],
) -> Result<()> {
    let current = load_current_index_checked(instructions)?;
    require!(current > 0, MineError::MissingEd25519Instruction);
    let ix = load_instruction_at_checked((current - 1) as usize, instructions)?;
    require_keys_eq!(ix.program_id, ed25519_program::ID, MineError::MissingEd25519Instruction);
    require!(ix.accounts.is_empty(), MineError::BadEd25519Instruction);
    let (pubkey, msg) = logic::parse_ed25519_single(&ix.data)?;
    require!(pubkey == signer.to_bytes(), MineError::WrongChallengeSigner);
    require!(msg == expected_msg, MineError::ChallengeMismatch);
    Ok(())
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin (a Squads vault PDA on mainnet).
    pub authority: Pubkey,
    /// Set by transfer_authority, cleared by accept_authority.
    pub pending_authority: Pubkey,
    /// May only `emergency_pause` (both flags on). Never un-pauses.
    pub guardian: Pubkey,
    pub mint: Pubkey,
    /// PDA token account (seeds ["vault"]) owned by this Config PDA.
    pub vault: Pubkey,
    /// Ed25519 public key the website signs challenges with.
    pub challenge_signer: Pubkey,
    pub difficulty_bits: u8,
    pub reward_per_proof: u64,
    pub wallet_daily_cap: u64,
    pub site_daily_cap: u64,
    /// Upper bound of `total_credited`, ever.
    pub total_budget: u64,
    pub max_challenge_ttl_secs: u32,
    pub mining_paused: bool,
    pub claims_paused: bool,
    pub total_credited: u64,
    pub total_claimed: u64,
    pub total_proofs: u64,
    /// UTC day index of `site_day_credited`.
    pub site_day: i64,
    pub site_day_credited: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Config {
    fn apply(&mut self, p: &MineParams) {
        self.difficulty_bits = p.difficulty_bits;
        self.reward_per_proof = p.reward_per_proof;
        self.wallet_daily_cap = p.wallet_daily_cap;
        self.site_daily_cap = p.site_daily_cap;
        self.total_budget = p.total_budget;
        self.max_challenge_ttl_secs = p.max_challenge_ttl_secs;
    }
    fn values(&self) -> ParamValues {
        ParamValues {
            difficulty_bits: self.difficulty_bits,
            reward_per_proof: self.reward_per_proof,
            wallet_daily_cap: self.wallet_daily_cap,
            site_daily_cap: self.site_daily_cap,
            total_budget: self.total_budget,
            max_challenge_ttl_secs: self.max_challenge_ttl_secs,
        }
    }
}

/// One per wallet (seeds ["miner", wallet]); created by the wallet's first
/// proof, the wallet paying its rent. Never closed: closing would reset
/// `last_seq` (the single-use guard) and the day counter.
#[account]
#[derive(InitSpace)]
pub struct Miner {
    pub wallet: Pubkey,
    /// Claimable SWD (raw units).
    pub accrued: u64,
    pub total_mined: u64,
    pub total_claimed: u64,
    pub proofs: u64,
    /// Highest challenge seq used; a new proof needs a larger one.
    pub last_seq: u64,
    /// UTC day index of `day_credited`.
    pub day: i64,
    pub day_credited: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MineParams {
    /// 16..=40
    pub difficulty_bits: u8,
    /// raw units (SWD has 5 decimals), > 0
    pub reward_per_proof: u64,
    /// ≥ reward_per_proof
    pub wallet_daily_cap: u64,
    /// ≥ wallet_daily_cap
    pub site_daily_cap: u64,
    /// ≥ reward_per_proof and ≥ what is already credited
    pub total_budget: u64,
    /// 60..=86400
    pub max_challenge_ttl_secs: u32,
}

impl MineParams {
    fn values(&self) -> ParamValues {
        ParamValues {
            difficulty_bits: self.difficulty_bits,
            reward_per_proof: self.reward_per_proof,
            wallet_daily_cap: self.wallet_daily_cap,
            site_daily_cap: self.site_daily_cap,
            total_budget: self.total_budget,
            max_challenge_ttl_secs: self.max_challenge_ttl_secs,
        }
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED],
        bump,
        token::mint = mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// This program's ProgramData; its upgrade authority must be `payer`
    /// (checked in the handler).
    pub program_data: Account<'info, ProgramData>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitProof<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed,
        payer = wallet,
        space = 8 + Miner::INIT_SPACE,
        seeds = [MINER_SEED, wallet.key().as_ref()],
        bump
    )]
    pub miner: Account<'info, Miner>,

    #[account(mut)]
    pub wallet: Signer<'info>,

    /// CHECK: the instructions sysvar (address-checked); read with the
    /// `load_*_checked` helpers in `verify_challenge_signature`.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = vault)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [MINER_SEED, wallet.key().as_ref()],
        bump = miner.bump,
        constraint = miner.wallet == wallet.key() @ MineError::Unauthorized
    )]
    pub miner: Account<'info, Miner>,

    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = wallet,
        associated_token::mint = mint,
        associated_token::authority = wallet,
        associated_token::token_program = token_program,
    )]
    pub wallet_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub wallet: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ MineError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct EmergencyPause<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub new_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawUnused<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ MineError::Unauthorized,
        has_one = mint,
        has_one = vault
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    /// Must be an SWD token account owned by the authority itself.
    #[account(
        mut,
        token::mint = mint,
        constraint = destination.owner == authority.key() @ MineError::DestinationNotAuthority,
        constraint = destination.key() != vault.key() @ MineError::DestinationNotAuthority
    )]
    pub destination: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Events (one per state change)
// ---------------------------------------------------------------------------

#[event]
pub struct Initialized {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub challenge_signer: Pubkey,
    pub params: MineParams,
}

#[event]
pub struct GuardianSet {
    pub authority: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct ProofAccepted {
    pub wallet: Pubkey,
    pub seq: u64,
    pub bits: u8,
    pub zero_bits: u8,
    pub reward: u64,
    pub accrued: u64,
    pub day: i64,
    pub wallet_day_credited: u64,
    pub site_day_credited: u64,
    pub total_credited: u64,
}

#[event]
pub struct Claimed {
    pub wallet: Pubkey,
    pub amount: u64,
    pub to: Pubkey,
    pub total_claimed: u64,
}

#[event]
pub struct ParamsUpdated {
    pub authority: Pubkey,
    pub params: MineParams,
}

#[event]
pub struct PausedSet {
    pub authority: Pubkey,
    pub mining_paused: bool,
    pub claims_paused: bool,
}

#[event]
pub struct ChallengeSignerSet {
    pub authority: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct AuthorityTransferStarted {
    pub authority: Pubkey,
    pub pending: Pubkey,
}

#[event]
pub struct AuthorityTransferred {
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct UnusedWithdrawn {
    pub authority: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub claims_paused: bool,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum MineError {
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Authority must not be the default pubkey")]
    InvalidAuthority,
    #[msg("Challenge signer must not be the default pubkey")]
    InvalidChallengeSigner,
    #[msg("Mainnet build: the mint must be the SWD mint")]
    WrongMint,
    #[msg("Difficulty must be 16..=40 bits")]
    InvalidDifficulty,
    #[msg("Reward per proof must be > 0")]
    InvalidReward,
    #[msg("Per-wallet daily cap must be >= reward per proof")]
    InvalidWalletCap,
    #[msg("Site daily cap must be >= per-wallet daily cap")]
    InvalidSiteCap,
    #[msg("Budget must be >= reward per proof and >= what is already credited")]
    InvalidBudget,
    #[msg("Max challenge TTL must be 60..=86400 seconds")]
    InvalidTtl,
    #[msg("Mining is paused")]
    MiningPaused,
    #[msg("Claims are paused")]
    ClaimsPaused,
    #[msg("The previous instruction must be an Ed25519 signature check")]
    MissingEd25519Instruction,
    #[msg("Malformed Ed25519 instruction (one signature, all data inline)")]
    BadEd25519Instruction,
    #[msg("Challenge was not signed by the configured challenge signer")]
    WrongChallengeSigner,
    #[msg("Signed challenge does not match these arguments and this wallet")]
    ChallengeMismatch,
    #[msg("Challenge difficulty is below the current minimum")]
    ChallengeTooEasy,
    #[msg("Challenge has expired")]
    ChallengeExpired,
    #[msg("Challenge expiry is further away than the max TTL")]
    ChallengeTtlTooLong,
    #[msg("Challenge already used (seq must increase per wallet)")]
    ChallengeAlreadyUsed,
    #[msg("Not enough leading zero bits")]
    InsufficientWork,
    #[msg("This wallet's daily cap is reached")]
    WalletDailyCapReached,
    #[msg("The site-wide daily cap is reached")]
    SiteDailyCapReached,
    #[msg("The mining budget is exhausted")]
    BudgetExhausted,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Vault holds less than the claim; the authority must top it up")]
    VaultInsufficient,
    #[msg("Mining must be paused first")]
    NotPaused,
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Amount exceeds what may be withdrawn (miner balances are reserved)")]
    WithdrawTooMuch,
    #[msg("Destination must be a token account owned by the authority")]
    DestinationNotAuthority,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Internal invariant violated")]
    InvariantViolation,
}
