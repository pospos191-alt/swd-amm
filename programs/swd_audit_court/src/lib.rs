// SWD Audit Court — community disputes of SWD Audit results.
// Design, trust model, costs and deploy path: docs/SWD_AUDIT_COURT.md
// (Thai: docs/SWD_AUDIT_COURT.th.md).
//
// ============================================================================
// STATUS: UNAUDITED DRAFT. NOT DEPLOYED. An independent audit is required
// before any mainnet use (docs/SWD_AUDIT_COURT.md "Before mainnet").
// ============================================================================
//
// Flow:
//   open_dispute   anyone; escrows `bond_amount` SWD in a per-dispute vault.
//                  The subject is named exactly like the SWD Audit Registry
//                  names it: (chain_id u16, sha256(normalized address)); the
//                  court derives and stores the registry's Record PDA
//                  ["audit", chain_id LE, address_hash] under the configured
//                  registry program id, without reading or writing it.
//   defend         optional; one defender posts the same bond during voting.
//   vote           holders of a configured soulbound (Token-2022
//                  NonTransferable) badge; one VoteRecord PDA per voter per
//                  dispute; weight = sum of the weights of the distinct badge
//                  mints proven. Opener and defender cannot vote.
//   finalize       anyone, after the voting period: quorum + strict majority
//                  above `pass_bps` -> Upheld / Rejected, else NoQuorum. The
//                  winner's bond comes back, the loser's bond is split between
//                  the winner (`winner_share_bps`) and the treasury; NoQuorum
//                  refunds everyone. The ruling stays in the Dispute account
//                  and is emitted as `DisputeResolved`.
// The court never writes to the registry: the registry's authority applies an
// Upheld ruling there (and may call `mark_applied` here to say so).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        non_transferable::{NonTransferable, NonTransferableAccount},
        BaseStateWithExtensions, StateWithExtensions,
    },
    state::{Account as T22Account, Mint as T22Mint},
};

pub mod logic;
use logic::*;

// TODO(before build): replace with the real program id.
// `solana-keygen new -o target/deploy/swd_audit_court-keypair.json`, then
// `anchor keys list`, and paste it here AND in Anchor.toml. This value is a
// random placeholder so the file parses (CI rewrites it to a throwaway key
// for each run); it is NOT a deployed program.
declare_id!("BsUXzYhhZQyJnajrPFHJThd4SacP3MtPRXV8d8a3nXPP");

pub const CONFIG_SEED: &[u8] = b"court";
pub const DISPUTE_SEED: &[u8] = b"dispute";
pub const VAULT_SEED: &[u8] = b"vault";
pub const VOTE_SEED: &[u8] = b"vote";
/// The SWD Audit Registry's Record seed (programs/swd_audit_registry).
pub const REGISTRY_RECORD_SEED: &[u8] = b"audit";

/// The real SWD mint (classic SPL Token, 5 decimals); the mainnet build only
/// accepts it as the bond mint.
#[cfg(feature = "mainnet")]
pub const SWD_MINT: Pubkey = pubkey!("Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL");

pub const CONFIG_VERSION: u8 = 1;
pub const DISPUTE_VERSION: u8 = 1;

#[program]
pub mod swd_audit_court {
    use super::*;

    /// One-time bootstrap by the program's UPGRADE AUTHORITY (read from its
    /// ProgramData), so a fresh deploy cannot be front-run. `params.admin`
    /// should be the Squads vault. remaining_accounts: the badge mint
    /// accounts, in `params.badges` order (each checked NonTransferable).
    pub fn initialize<'info>(
        ctx: Context<'_, '_, 'info, 'info, Initialize<'info>>,
        params: CourtParams,
    ) -> Result<()> {
        let (expected_program_data, _) = Pubkey::find_program_address(
            &[crate::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        );
        require_keys_eq!(
            ctx.accounts.program_data.key(),
            expected_program_data,
            CourtError::Unauthorized
        );
        require!(
            ctx.accounts.program_data.upgrade_authority_address == Some(ctx.accounts.payer.key()),
            CourtError::Unauthorized
        );
        require_keys_neq!(params.admin, Pubkey::default(), CourtError::InvalidAdmin);
        #[cfg(feature = "mainnet")]
        require_keys_eq!(
            ctx.accounts.bond_mint.key(),
            SWD_MINT,
            CourtError::WrongBondMint
        );

        check_params(&params)?;
        check_badge_mints(ctx.remaining_accounts, &params.badges)?;

        let c = &mut ctx.accounts.config;
        c.version = CONFIG_VERSION;
        c.bump = ctx.bumps.config;
        c.admin = params.admin;
        c.pending_admin = None;
        c.paused = false;
        c.bond_mint = ctx.accounts.bond_mint.key();
        c.dispute_count = 0;
        c.apply(&params);
        emit!(ConfigChanged {
            config: c.key(),
            admin: c.admin,
            paused: c.paused
        });
        Ok(())
    }

    /// Admin: new parameters for FUTURE disputes (open ones keep the values
    /// snapshotted when they were opened). Badge changes apply to votes cast
    /// from now on. remaining_accounts: the badge mint accounts, in order.
    pub fn update_config<'info>(
        ctx: Context<'_, '_, 'info, 'info, AdminOnly<'info>>,
        params: CourtParams,
    ) -> Result<()> {
        check_params(&params)?;
        check_badge_mints(ctx.remaining_accounts, &params.badges)?;
        let c = &mut ctx.accounts.config;
        require_keys_eq!(params.admin, c.admin, CourtError::UseAdminHandover);
        c.apply(&params);
        emit!(ConfigChanged {
            config: c.key(),
            admin: c.admin,
            paused: c.paused
        });
        Ok(())
    }

    /// Admin: pause new disputes, defences and votes. Finalizing (and so
    /// getting bonds back) is never paused.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.paused = paused;
        emit!(ConfigChanged {
            config: c.key(),
            admin: c.admin,
            paused
        });
        Ok(())
    }

    /// Admin hand-over, step 1 (None cancels a pending hand-over).
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Option<Pubkey>) -> Result<()> {
        if let Some(k) = new_admin {
            require_keys_neq!(k, Pubkey::default(), CourtError::InvalidAdmin);
        }
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    /// Admin hand-over, step 2: signed by the proposed key.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(
            c.pending_admin == Some(ctx.accounts.new_admin.key()),
            CourtError::Unauthorized
        );
        c.admin = ctx.accounts.new_admin.key();
        c.pending_admin = None;
        emit!(ConfigChanged {
            config: c.key(),
            admin: c.admin,
            paused: c.paused
        });
        Ok(())
    }

    /// Opens a dispute on the audit record of (chain_id, address_hash) and
    /// escrows the bond. `disputed_payload_hash` is the registry record's
    /// attestation payloadHash being disputed (so a later re-audit is a
    /// different subject of dispute); `claimed_level` is the level the opener
    /// says is right (0..=3) or 255; `evidence_hash` = sha256 of the evidence
    /// document the opener publishes off-chain.
    pub fn open_dispute(
        ctx: Context<OpenDispute>,
        chain_id: u16,
        address_hash: [u8; 32],
        disputed_payload_hash: [u8; 32],
        claimed_level: u8,
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, CourtError::Paused);
        require!(chain_id != 0, CourtError::UnknownChain);
        require!(
            claimed_level <= LEVEL_HIGH || claimed_level == NO_CLAIM,
            CourtError::InvalidLevel
        );
        require!(address_hash != [0u8; 32], CourtError::InvalidSubject);

        let now = Clock::get()?.unix_timestamp;
        let (record, _) = Pubkey::find_program_address(
            &[REGISTRY_RECORD_SEED, &chain_id.to_le_bytes(), &address_hash],
            &c.registry_program,
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.opener_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.opener.to_account_info(),
                },
            ),
            c.bond_amount,
        )?;

        let d = &mut ctx.accounts.dispute;
        d.version = DISPUTE_VERSION;
        d.bump = ctx.bumps.dispute;
        d.vault_bump = ctx.bumps.vault;
        d.id = c.dispute_count;
        d.opener = ctx.accounts.opener.key();
        d.defender = Pubkey::default();
        d.chain_id = chain_id;
        d.address_hash = address_hash;
        d.record = record;
        d.disputed_payload_hash = disputed_payload_hash;
        d.claimed_level = claimed_level;
        d.evidence_hash = evidence_hash;
        d.opened_at = now;
        d.voting_ends_at = now
            .checked_add(c.voting_secs)
            .ok_or(error!(CourtError::Overflow))?;
        d.bond_amount = c.bond_amount;
        d.treasury_owner = c.treasury_owner;
        d.quorum_weight = c.quorum_weight;
        d.pass_bps = c.pass_bps;
        d.winner_share_bps = c.winner_share_bps;
        d.yes_weight = 0;
        d.no_weight = 0;
        d.voters = 0;
        d.status = STATUS_VOTING;
        d.resolved_at = 0;
        d.applied = false;

        let id = d.id;
        let config = &mut ctx.accounts.config;
        config.dispute_count = config
            .dispute_count
            .checked_add(1)
            .ok_or(error!(CourtError::Overflow))?;

        emit!(DisputeOpened {
            dispute: ctx.accounts.dispute.key(),
            id,
            opener: ctx.accounts.opener.key(),
            chain_id,
            address_hash,
            record,
            disputed_payload_hash,
            claimed_level,
            evidence_hash,
            bond_amount: ctx.accounts.dispute.bond_amount,
            voting_ends_at: ctx.accounts.dispute.voting_ends_at,
        });
        Ok(())
    }

    /// Optional: one defender (e.g. the audited project, or the SWD Audit
    /// operator) matches the bond during voting, to win the opener's bond
    /// share if the dispute is rejected.
    pub fn defend(ctx: Context<Defend>) -> Result<()> {
        require!(!ctx.accounts.config.paused, CourtError::Paused);
        let now = Clock::get()?.unix_timestamp;
        let d = &ctx.accounts.dispute;
        require!(
            d.status == STATUS_VOTING && now < d.voting_ends_at,
            CourtError::VotingClosed
        );
        require!(d.defender == Pubkey::default(), CourtError::AlreadyDefended);
        require_keys_neq!(
            ctx.accounts.defender.key(),
            d.opener,
            CourtError::ConflictOfInterest
        );
        let bond = d.bond_amount;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.defender_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.defender.to_account_info(),
                },
            ),
            bond,
        )?;
        let d = &mut ctx.accounts.dispute;
        d.defender = ctx.accounts.defender.key();
        emit!(DisputeDefended {
            dispute: d.key(),
            defender: d.defender
        });
        Ok(())
    }

    /// One vote per voter per dispute (the VoteRecord PDA cannot be created
    /// twice). remaining_accounts: the voter's Token-2022 badge token
    /// accounts — each must be owned by the voter, hold >= 1, be of a
    /// configured badge mint, and carry NonTransferableAccount.
    pub fn vote<'info>(
        ctx: Context<'_, '_, 'info, 'info, CastVote<'info>>,
        support: bool,
    ) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, CourtError::Paused);
        let now = Clock::get()?.unix_timestamp;
        let voter = ctx.accounts.voter.key();
        {
            let d = &ctx.accounts.dispute;
            require!(
                d.status == STATUS_VOTING && now < d.voting_ends_at,
                CourtError::VotingClosed
            );
            require!(
                voter != d.opener && voter != d.defender,
                CourtError::ConflictOfInterest
            );
        }
        require!(!ctx.remaining_accounts.is_empty(), CourtError::NoBadge);
        require!(
            ctx.remaining_accounts.len() <= MAX_BADGES,
            CourtError::TooManyBadges
        );

        let mut proven: Vec<[u8; 32]> = Vec::with_capacity(ctx.remaining_accounts.len());
        for acc in ctx.remaining_accounts.iter() {
            proven.push(badge_mint_of(acc, &voter, c)?.to_bytes());
        }
        let badges: Vec<([u8; 32], u16)> = c
            .badges
            .iter()
            .map(|b| (b.mint.to_bytes(), b.weight))
            .collect();
        let weight = vote_weight(&badges, &proven);
        require!(weight > 0, CourtError::NoBadge);

        let d = &mut ctx.accounts.dispute;
        if support {
            d.yes_weight = d
                .yes_weight
                .checked_add(weight)
                .ok_or(error!(CourtError::Overflow))?;
        } else {
            d.no_weight = d
                .no_weight
                .checked_add(weight)
                .ok_or(error!(CourtError::Overflow))?;
        }
        d.voters = d
            .voters
            .checked_add(1)
            .ok_or(error!(CourtError::Overflow))?;

        let v = &mut ctx.accounts.vote_record;
        v.bump = ctx.bumps.vote_record;
        v.dispute = d.key();
        v.voter = voter;
        v.support = support;
        v.weight = weight;
        v.voted_at = now;
        emit!(VoteCast {
            dispute: d.key(),
            voter,
            support,
            weight
        });
        Ok(())
    }

    /// Anyone, after the voting period: records the ruling and pays out the
    /// escrow. Recipients are associated token accounts, so if one was closed
    /// anyone can recreate it and finalize still goes through.
    pub fn finalize(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &ctx.accounts.dispute;
        require!(d.status == STATUS_VOTING, CourtError::AlreadyResolved);
        require!(now >= d.voting_ends_at, CourtError::VotingNotOver);
        let o = outcome(d.yes_weight, d.no_weight, d.quorum_weight, d.pass_bps);
        settle(ctx.accounts, Some(o), o.status(), now)
    }

    /// Admin: cancel an open dispute (e.g. a bug, a duplicate). Everyone is
    /// refunded in full; the admin can never take a bond.
    pub fn cancel_dispute(ctx: Context<AdminSettle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.settle.dispute.status == STATUS_VOTING,
            CourtError::AlreadyResolved
        );
        settle(&mut ctx.accounts.settle, None, STATUS_CANCELLED, now)
    }

    /// Admin (registry side): records that an Upheld ruling was applied to
    /// the registry. Informational only.
    pub fn mark_applied(ctx: Context<MarkApplied>) -> Result<()> {
        let d = &mut ctx.accounts.dispute;
        require!(d.status == STATUS_UPHELD, CourtError::NotUpheld);
        require!(!d.applied, CourtError::AlreadyApplied);
        d.applied = true;
        emit!(RulingApplied {
            dispute: d.key(),
            record: d.record
        });
        Ok(())
    }

    /// The voter takes back the VoteRecord's rent once the dispute is closed.
    pub fn close_vote(ctx: Context<CloseVote>) -> Result<()> {
        require!(
            ctx.accounts.dispute.status != STATUS_VOTING,
            CourtError::VotingNotOver
        );
        Ok(())
    }
}

fn settle<'info>(a: &mut Settle<'info>, o: Option<Outcome>, status: u8, now: i64) -> Result<()> {
    let d = &a.dispute;
    let has_defender = d.defender != Pubkey::default();
    let mut p = payout(o, d.bond_amount, has_defender, d.winner_share_bps);
    // Anyone can send extra tokens to the vault; if they stayed there,
    // close_account would fail and the escrow would be stuck for good. So
    // whatever is above the escrow goes to the treasury.
    let escrow = p.total();
    let held = a.vault.amount as u128;
    require!(held >= escrow, CourtError::VaultShort);
    p.to_treasury = p
        .to_treasury
        .checked_add((held - escrow) as u64)
        .ok_or(error!(CourtError::Overflow))?;
    let mint = a.config.bond_mint;

    // recipients: the ATAs of the opener / defender / treasury owner
    require_keys_eq!(
        a.opener_token.key(),
        get_associated_token_address(&d.opener, &mint),
        CourtError::WrongRecipient
    );
    require_keys_eq!(
        a.treasury_token.key(),
        get_associated_token_address(&d.treasury_owner, &mint),
        CourtError::WrongRecipient
    );
    if has_defender {
        let dt = a
            .defender_token
            .as_ref()
            .ok_or(error!(CourtError::WrongRecipient))?;
        require_keys_eq!(
            dt.key(),
            get_associated_token_address(&d.defender, &mint),
            CourtError::WrongRecipient
        );
    }

    let id_le = d.id.to_le_bytes();
    let bump = [d.bump];
    let seeds: &[&[u8]] = &[DISPUTE_SEED, &id_le, &bump];
    let signer = &[seeds];
    let tp = a.token_program.to_account_info();
    let vault = a.vault.to_account_info();
    let auth = a.dispute.to_account_info();
    pay(
        &tp,
        &vault,
        a.opener_token.to_account_info(),
        &auth,
        signer,
        p.to_opener,
    )?;
    if p.to_defender > 0 {
        let dt = a
            .defender_token
            .as_ref()
            .ok_or(error!(CourtError::WrongRecipient))?;
        pay(
            &tp,
            &vault,
            dt.to_account_info(),
            &auth,
            signer,
            p.to_defender,
        )?;
    }
    pay(
        &tp,
        &vault,
        a.treasury_token.to_account_info(),
        &auth,
        signer,
        p.to_treasury,
    )?;

    // the vault is empty now (payout conserves the escrow); its rent goes back
    // to the opener, who paid it
    token::close_account(CpiContext::new_with_signer(
        tp.clone(),
        CloseAccount {
            account: vault.clone(),
            destination: a.opener.to_account_info(),
            authority: auth.clone(),
        },
        signer,
    ))?;

    let d = &mut a.dispute;
    d.status = status;
    d.resolved_at = now;
    emit!(DisputeResolved {
        dispute: d.key(),
        id: d.id,
        chain_id: d.chain_id,
        address_hash: d.address_hash,
        record: d.record,
        disputed_payload_hash: d.disputed_payload_hash,
        claimed_level: d.claimed_level,
        status,
        yes_weight: d.yes_weight,
        no_weight: d.no_weight,
        voters: d.voters,
        to_opener: p.to_opener,
        to_defender: p.to_defender,
        to_treasury: p.to_treasury,
    });
    Ok(())
}

fn pay<'info>(
    tp: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    to: AccountInfo<'info>,
    auth: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            tp.clone(),
            Transfer {
                from: vault.clone(),
                to,
                authority: auth.clone(),
            },
            signer,
        ),
        amount,
    )
}

fn check_params(p: &CourtParams) -> Result<()> {
    let badges: Vec<([u8; 32], u16)> = p
        .badges
        .iter()
        .map(|b| (b.mint.to_bytes(), b.weight))
        .collect();
    validate_params(&CourtParamsView {
        bond_amount: p.bond_amount,
        voting_secs: p.voting_secs,
        quorum_weight: p.quorum_weight,
        pass_bps: p.pass_bps,
        winner_share_bps: p.winner_share_bps,
        badges: &badges,
    })
    .map_err(|e| match e {
        ParamError::ZeroBond => error!(CourtError::ZeroBond),
        ParamError::VotingPeriod => error!(CourtError::VotingPeriod),
        ParamError::ZeroQuorum => error!(CourtError::ZeroQuorum),
        ParamError::PassBps => error!(CourtError::PassBps),
        ParamError::WinnerShareBps => error!(CourtError::WinnerShareBps),
        ParamError::TooManyBadges => error!(CourtError::TooManyBadges),
        ParamError::NoBadges => error!(CourtError::NoBadge),
        ParamError::DuplicateBadge => error!(CourtError::DuplicateBadge),
        ParamError::BadgeWeight => error!(CourtError::BadgeWeight),
    })?;
    require_keys_neq!(
        p.treasury_owner,
        Pubkey::default(),
        CourtError::InvalidTreasury
    );
    require_keys_neq!(
        p.registry_program,
        Pubkey::default(),
        CourtError::InvalidRegistry
    );
    Ok(())
}

/// Each configured badge mint must be a Token-2022 mint with the
/// NonTransferable extension (an extension can never be removed from a mint,
/// so checking once here holds forever).
fn check_badge_mints(accounts: &[AccountInfo], badges: &[BadgeInput]) -> Result<()> {
    require!(
        accounts.len() == badges.len(),
        CourtError::BadgeMintAccounts
    );
    for (acc, b) in accounts.iter().zip(badges) {
        require_keys_eq!(acc.key(), b.mint, CourtError::BadgeMintAccounts);
        require_keys_eq!(
            *acc.owner,
            spl_token_2022::ID,
            CourtError::BadgeNotSoulbound
        );
        let data = acc.try_borrow_data()?;
        let m = StateWithExtensions::<T22Mint>::unpack(&data)
            .map_err(|_| error!(CourtError::BadgeNotSoulbound))?;
        m.get_extension::<NonTransferable>()
            .map_err(|_| error!(CourtError::BadgeNotSoulbound))?;
    }
    Ok(())
}

/// The badge mint proven by one Token-2022 token account of `voter`.
fn badge_mint_of(acc: &AccountInfo, voter: &Pubkey, c: &Config) -> Result<Pubkey> {
    require_keys_eq!(
        *acc.owner,
        spl_token_2022::ID,
        CourtError::InvalidBadgeAccount
    );
    let data = acc.try_borrow_data()?;
    let a = StateWithExtensions::<T22Account>::unpack(&data)
        .map_err(|_| error!(CourtError::InvalidBadgeAccount))?;
    require_keys_eq!(a.base.owner, *voter, CourtError::BadgeNotOwned);
    require!(a.base.amount >= 1, CourtError::NoBadge);
    require!(
        c.badges.iter().any(|b| b.mint == a.base.mint),
        CourtError::UnknownBadgeMint
    );
    // Token-2022 adds this to every account of a NonTransferable mint
    a.get_extension::<NonTransferableAccount>()
        .map_err(|_| error!(CourtError::BadgeNotSoulbound))?;
    Ok(a.base.mint)
}

// ---------------------------------------------------------------- state

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadgeInput {
    pub mint: Pubkey,
    pub weight: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CourtParams {
    pub admin: Pubkey,
    /// losing bonds go to this owner's associated token account
    pub treasury_owner: Pubkey,
    /// the SWD Audit Registry program id (only used to derive Record PDAs)
    pub registry_program: Pubkey,
    pub bond_amount: u64,
    pub voting_secs: i64,
    pub quorum_weight: u64,
    pub pass_bps: u16,
    pub winner_share_bps: u16,
    pub badges: Vec<BadgeInput>,
}

#[account]
#[derive(Debug)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub paused: bool,
    pub bond_mint: Pubkey,
    pub treasury_owner: Pubkey,
    pub registry_program: Pubkey,
    pub bond_amount: u64,
    pub voting_secs: i64,
    pub quorum_weight: u64,
    pub pass_bps: u16,
    pub winner_share_bps: u16,
    pub dispute_count: u64,
    pub badges: Vec<BadgeInput>,
}

impl Config {
    pub const SPACE: usize =
        8 + 1 + 1 + 32 + 33 + 1 + 32 * 3 + 8 * 3 + 2 * 2 + 8 + 4 + (32 + 2) * MAX_BADGES;
    fn apply(&mut self, p: &CourtParams) {
        self.treasury_owner = p.treasury_owner;
        self.registry_program = p.registry_program;
        self.bond_amount = p.bond_amount;
        self.voting_secs = p.voting_secs;
        self.quorum_weight = p.quorum_weight;
        self.pass_bps = p.pass_bps;
        self.winner_share_bps = p.winner_share_bps;
        self.badges = p.badges.clone();
    }
}

#[account]
#[derive(Debug)]
pub struct Dispute {
    pub version: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub id: u64,
    pub opener: Pubkey,
    /// Pubkey::default() = no defender
    pub defender: Pubkey,
    pub chain_id: u16,
    pub address_hash: [u8; 32],
    /// the registry's Record PDA for (chain_id, address_hash)
    pub record: Pubkey,
    pub disputed_payload_hash: [u8; 32],
    pub claimed_level: u8,
    pub evidence_hash: [u8; 32],
    pub opened_at: i64,
    pub voting_ends_at: i64,
    // snapshotted from Config when opened:
    pub bond_amount: u64,
    pub treasury_owner: Pubkey,
    pub quorum_weight: u64,
    pub pass_bps: u16,
    pub winner_share_bps: u16,
    // tally / ruling:
    pub yes_weight: u64,
    pub no_weight: u64,
    pub voters: u32,
    pub status: u8,
    pub resolved_at: i64,
    pub applied: bool,
}

impl Dispute {
    pub const SPACE: usize = 8
        + 3
        + 8
        + 32
        + 32
        + 2
        + 32
        + 32
        + 32
        + 1
        + 32
        + 8
        + 8
        + 8
        + 32
        + 8
        + 2
        + 2
        + 8
        + 8
        + 4
        + 1
        + 8
        + 1;
}

#[account]
#[derive(Debug)]
pub struct VoteRecord {
    pub bump: u8,
    pub dispute: Pubkey,
    pub voter: Pubkey,
    pub support: bool,
    pub weight: u64,
    pub voted_at: i64,
}

impl VoteRecord {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 1 + 8 + 8;
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = Config::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// This program's ProgramData; its upgrade authority must be `payer`.
    pub program_data: Account<'info, ProgramData>,
    pub bond_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ CourtError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub new_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct OpenDispute<'info> {
    #[account(mut)]
    pub opener: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = bond_mint)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = opener,
        space = Dispute::SPACE,
        seeds = [DISPUTE_SEED, &config.dispute_count.to_le_bytes()],
        bump
    )]
    pub dispute: Account<'info, Dispute>,
    #[account(
        init,
        payer = opener,
        seeds = [VAULT_SEED, dispute.key().as_ref()],
        bump,
        token::mint = bond_mint,
        token::authority = dispute,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = bond_mint, token::authority = opener)]
    pub opener_token: Account<'info, TokenAccount>,
    pub bond_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Defend<'info> {
    pub defender: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DISPUTE_SEED, &dispute.id.to_le_bytes()], bump = dispute.bump)]
    pub dispute: Account<'info, Dispute>,
    #[account(mut, seeds = [VAULT_SEED, dispute.key().as_ref()], bump = dispute.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.bond_mint, token::authority = defender)]
    pub defender_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DISPUTE_SEED, &dispute.id.to_le_bytes()], bump = dispute.bump)]
    pub dispute: Account<'info, Dispute>,
    #[account(
        init,
        payer = voter,
        space = VoteRecord::SPACE,
        seeds = [VOTE_SEED, dispute.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_record: Account<'info, VoteRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DISPUTE_SEED, &dispute.id.to_le_bytes()], bump = dispute.bump)]
    pub dispute: Account<'info, Dispute>,
    #[account(mut, seeds = [VAULT_SEED, dispute.key().as_ref()], bump = dispute.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: receives the vault's rent; must be the opener
    #[account(mut, address = dispute.opener @ CourtError::WrongRecipient)]
    pub opener: UncheckedAccount<'info>,
    /// the opener's ATA of the bond mint (checked in `settle`)
    #[account(mut, token::mint = config.bond_mint)]
    pub opener_token: Account<'info, TokenAccount>,
    /// the defender's ATA; required only when there is a defender
    #[account(mut, token::mint = config.bond_mint)]
    pub defender_token: Option<Account<'info, TokenAccount>>,
    /// the treasury owner's ATA (snapshotted in the dispute)
    #[account(mut, token::mint = config.bond_mint)]
    pub treasury_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminSettle<'info> {
    #[account(constraint = admin.key() == settle.config.admin @ CourtError::Unauthorized)]
    pub admin: Signer<'info>,
    pub settle: Settle<'info>,
}

#[derive(Accounts)]
pub struct MarkApplied<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ CourtError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [DISPUTE_SEED, &dispute.id.to_le_bytes()], bump = dispute.bump)]
    pub dispute: Account<'info, Dispute>,
}

#[derive(Accounts)]
pub struct CloseVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    pub dispute: Account<'info, Dispute>,
    #[account(
        mut,
        close = voter,
        seeds = [VOTE_SEED, dispute.key().as_ref(), voter.key().as_ref()],
        bump = vote_record.bump
    )]
    pub vote_record: Account<'info, VoteRecord>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct ConfigChanged {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub paused: bool,
}
#[event]
pub struct DisputeOpened {
    pub dispute: Pubkey,
    pub id: u64,
    pub opener: Pubkey,
    pub chain_id: u16,
    pub address_hash: [u8; 32],
    pub record: Pubkey,
    pub disputed_payload_hash: [u8; 32],
    pub claimed_level: u8,
    pub evidence_hash: [u8; 32],
    pub bond_amount: u64,
    pub voting_ends_at: i64,
}
#[event]
pub struct DisputeDefended {
    pub dispute: Pubkey,
    pub defender: Pubkey,
}
#[event]
pub struct VoteCast {
    pub dispute: Pubkey,
    pub voter: Pubkey,
    pub support: bool,
    pub weight: u64,
}
/// The ruling. The registry's authority watches for status = 1 (Upheld) and
/// re-audits / corrects the Record named by `record`.
#[event]
pub struct DisputeResolved {
    pub dispute: Pubkey,
    pub id: u64,
    pub chain_id: u16,
    pub address_hash: [u8; 32],
    pub record: Pubkey,
    pub disputed_payload_hash: [u8; 32],
    pub claimed_level: u8,
    /// 1 Upheld, 2 Rejected, 3 NoQuorum, 4 Cancelled
    pub status: u8,
    pub yes_weight: u64,
    pub no_weight: u64,
    pub voters: u32,
    pub to_opener: u64,
    pub to_defender: u64,
    pub to_treasury: u64,
}
#[event]
pub struct RulingApplied {
    pub dispute: Pubkey,
    pub record: Pubkey,
}

#[error_code]
pub enum CourtError {
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("admin must be a real key")]
    InvalidAdmin,
    #[msg("change the admin with propose_admin / accept_admin")]
    UseAdminHandover,
    #[msg("the mainnet build only accepts the SWD mint as bond")]
    WrongBondMint,
    #[msg("bond must be above zero")]
    ZeroBond,
    #[msg("voting period out of bounds")]
    VotingPeriod,
    #[msg("quorum must be above zero")]
    ZeroQuorum,
    #[msg("pass_bps must be 5000..=9000")]
    PassBps,
    #[msg("winner_share_bps must be <= 10000")]
    WinnerShareBps,
    #[msg("too many badge mints / accounts")]
    TooManyBadges,
    #[msg("badge mint listed twice")]
    DuplicateBadge,
    #[msg("badge weight must be 1..=1000")]
    BadgeWeight,
    #[msg("badge mint accounts do not match the badge list")]
    BadgeMintAccounts,
    #[msg("badge is not a NonTransferable Token-2022 badge")]
    BadgeNotSoulbound,
    #[msg("treasury owner must be a real key")]
    InvalidTreasury,
    #[msg("registry program must be a real key")]
    InvalidRegistry,
    #[msg("the court is paused")]
    Paused,
    #[msg("chain id 0 is not a chain")]
    UnknownChain,
    #[msg("claimed level must be 0..=3 or 255")]
    InvalidLevel,
    #[msg("address hash must not be zero")]
    InvalidSubject,
    #[msg("voting is closed")]
    VotingClosed,
    #[msg("voting has not ended")]
    VotingNotOver,
    #[msg("already defended")]
    AlreadyDefended,
    #[msg("opener / defender cannot do this")]
    ConflictOfInterest,
    #[msg("no valid badge")]
    NoBadge,
    #[msg("badge account is not a Token-2022 token account")]
    InvalidBadgeAccount,
    #[msg("badge account is not owned by the voter")]
    BadgeNotOwned,
    #[msg("badge mint is not configured")]
    UnknownBadgeMint,
    #[msg("dispute already resolved")]
    AlreadyResolved,
    #[msg("wrong payout account")]
    WrongRecipient,
    #[msg("dispute was not upheld")]
    NotUpheld,
    #[msg("ruling already marked applied")]
    AlreadyApplied,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("vault holds less than the escrow")]
    VaultShort,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spaces_fit_max_contents() {
        let c = Config {
            version: 1,
            bump: 255,
            admin: Pubkey::new_unique(),
            pending_admin: Some(Pubkey::new_unique()),
            paused: true,
            bond_mint: Pubkey::new_unique(),
            treasury_owner: Pubkey::new_unique(),
            registry_program: Pubkey::new_unique(),
            bond_amount: u64::MAX,
            voting_secs: i64::MAX,
            quorum_weight: u64::MAX,
            pass_bps: 1,
            winner_share_bps: 1,
            dispute_count: u64::MAX,
            badges: vec![
                BadgeInput {
                    mint: Pubkey::new_unique(),
                    weight: 1
                };
                MAX_BADGES
            ],
        };
        let mut buf = Vec::new();
        c.try_serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), Config::SPACE);

        let d = Dispute {
            version: 1,
            bump: 1,
            vault_bump: 1,
            id: 1,
            opener: Pubkey::new_unique(),
            defender: Pubkey::new_unique(),
            chain_id: 6,
            address_hash: [1; 32],
            record: Pubkey::new_unique(),
            disputed_payload_hash: [2; 32],
            claimed_level: 3,
            evidence_hash: [3; 32],
            opened_at: 1,
            voting_ends_at: 2,
            bond_amount: 3,
            treasury_owner: Pubkey::new_unique(),
            quorum_weight: 4,
            pass_bps: 5,
            winner_share_bps: 6,
            yes_weight: 7,
            no_weight: 8,
            voters: 9,
            status: 1,
            resolved_at: 10,
            applied: true,
        };
        let mut buf = Vec::new();
        d.try_serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), Dispute::SPACE);

        let v = VoteRecord {
            bump: 1,
            dispute: Pubkey::new_unique(),
            voter: Pubkey::new_unique(),
            support: true,
            weight: 1,
            voted_at: 1,
        };
        let mut buf = Vec::new();
        v.try_serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), VoteRecord::SPACE);
    }

    #[test]
    fn record_pda_matches_registry_seed_scheme() {
        // ["audit", chain_id u16 LE, sha256(normalized address)] — the
        // registry's own derivation (programs/swd_audit_registry `record_pda`)
        let registry = Pubkey::new_unique();
        let addr_hash = anchor_lang::solana_program::hash::hash(b"0xabc").to_bytes();
        let (a, _) = Pubkey::find_program_address(
            &[REGISTRY_RECORD_SEED, &6u16.to_le_bytes(), &addr_hash],
            &registry,
        );
        let (b, _) = Pubkey::find_program_address(&[b"audit", &[6, 0], &addr_hash], &registry);
        assert_eq!(a, b);
    }
}
