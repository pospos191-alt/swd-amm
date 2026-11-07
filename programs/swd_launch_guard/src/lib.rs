// SWD Launch Guard — a Token-2022 Transfer Hook that slows bots down during
// the first hours of a launch, and then switches itself off for good.
// Design, trust model, costs and deploy path: docs/SWD_LAUNCH_GUARD.md
// (Thai: docs/SWD_LAUNCH_GUARD.th.md).
//
// ============================================================================
// STATUS: UNAUDITED DRAFT. NOT DEPLOYED. An independent audit is required
// before any mainnet use (docs/SWD_LAUNCH_GUARD.md "Before mainnet").
// ============================================================================
//
// The rule, in one line: during the window, a transfer FROM a launch wallet
// (a pool-vault authority or the creator) TO a wallet that is not a launch
// wallet is capped per transfer, capped in total per receiving wallet, and
// optionally rate-limited; the receiving wallet must be pre-registered (it
// pays a small, refundable rent). Everything else passes untouched:
//   - any transfer whose SOURCE is not a launch wallet (every sell, every
//     holder-to-holder transfer) is never restricted, in any phase;
//   - after `window_end` the hook returns immediately for every transfer;
//   - `window_end` is fixed at creation (<= launch_ts + 24 h, launch_ts <=
//     now + 7 days) and can only move EARLIER; limits can only be LOOSENED.
//
// Why pre-registration: a transfer hook runs inside Token-2022's CPI with
// every account de-escalated to non-signer, so it has no payer and cannot
// create the per-wallet tracking account itself. Tracking only by amount
// (no state) would make the cumulative cap meaningless. So the receiving
// wallet's `Recipient` PDA is created beforehand by `register_recipient`
// (anyone may pay; the UI adds it to the buyer's swap transaction), and a
// restricted transfer to an unregistered wallet fails. The rent goes back to
// whoever paid it after the window (`close_recipient`, permissionless).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        transfer_hook::{TransferHook, TransferHookAccount},
        BaseStateWithExtensions, StateWithExtensions,
    },
    state::{Account as SplAccount, Mint as SplMint},
};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub mod logic;
use logic::*;

// TODO(before build): replace with the real program id.
// `solana-keygen new -o target/deploy/swd_launch_guard-keypair.json`, then
// `anchor keys list`, and paste it here AND in Anchor.toml. This value is a
// random placeholder so the file parses (CI rewrites it to a throwaway key
// for each run); it is NOT a deployed program.
declare_id!("nt5WFDM35epwo19MpNEmXuKHEhQMzoPVCE3ZfUqpHu7");

/// Fixed by the transfer-hook interface: Token-2022 clients look for the
/// account list at PDA ["extra-account-metas", mint] of the hook program.
pub const EXTRA_METAS_SEED: &[u8] = b"extra-account-metas";
pub const GUARD_SEED: &[u8] = b"guard";
pub const RECIPIENT_SEED: &[u8] = b"recipient";

pub const GUARD_VERSION: u8 = 1;
pub const RECIPIENT_VERSION: u8 = 1;
/// Two extra accounts: the Guard config and the receiving wallet's Recipient.
pub const EXTRA_META_COUNT: usize = 2;

/// Byte offsets inside an SPL token account (same for Token and Token-2022).
const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;

#[program]
pub mod swd_launch_guard {
    use super::*;

    /// Creates the mint's Guard and its ExtraAccountMetaList in one step, so
    /// the hook is never half-configured. Must be signed by the mint's
    /// current MINT authority or by its TRANSFER-HOOK authority (the SWD
    /// launcher has the mint authority until the full supply is minted, so it
    /// calls this before revoking it). The mint must already point its
    /// TransferHook extension at this program.
    ///
    /// Until this runs, Token-2022 cannot resolve our extra accounts and every
    /// transfer of the mint fails — the launcher must run it right after
    /// creating the mint (docs: "Launch order").
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
        params: GuardParams,
    ) -> Result<()> {
        // ---- who may configure this mint
        {
            let mint_info = ctx.accounts.mint.to_account_info();
            require_keys_eq!(
                *mint_info.owner,
                spl_token_2022::ID,
                GuardError::NotToken2022Mint
            );
            let data = mint_info.try_borrow_data()?;
            let mint = StateWithExtensions::<SplMint>::unpack(&data)
                .map_err(|_| error!(GuardError::NotToken2022Mint))?;
            let hook = mint
                .get_extension::<TransferHook>()
                .map_err(|_| error!(GuardError::MintHasNoTransferHook))?;
            let hook_program: Option<Pubkey> = hook.program_id.into();
            require!(
                hook_program == Some(crate::ID),
                GuardError::HookPointsElsewhere
            );
            let hook_authority: Option<Pubkey> = hook.authority.into();
            let mint_authority: Option<Pubkey> = match mint.base.mint_authority {
                COption::Some(k) => Some(k),
                COption::None => None,
            };
            let signer = ctx.accounts.authority.key();
            require!(
                mint_authority == Some(signer) || hook_authority == Some(signer),
                GuardError::NotMintAuthority
            );
        }

        // ---- parameters
        let now = Clock::get()?.unix_timestamp;
        let limits = params.limits();
        let window_end =
            validate_init(now, params.launch_ts, params.window_secs, &limits).map_err(param_err)?;
        let wallets: Vec<[u8; 32]> = params.launch_wallets.iter().map(|k| k.to_bytes()).collect();
        validate_launch_wallets(&wallets).map_err(param_err)?;

        let guard = &mut ctx.accounts.guard;
        guard.version = GUARD_VERSION;
        guard.bump = ctx.bumps.guard;
        guard.mint = ctx.accounts.mint.key();
        guard.authority = params.guard_authority;
        guard.created_at = now;
        guard.launch_ts = params.launch_ts;
        guard.window_end = window_end;
        guard.max_per_transfer = limits.max_per_transfer;
        guard.max_per_wallet = limits.max_per_wallet;
        guard.cooldown_secs = limits.cooldown_secs;
        guard.launch_wallets = params.launch_wallets.clone();

        // ---- the extra accounts Token-2022 must pass to `execute`
        // index: 0 source, 1 mint, 2 destination, 3 owner, 4 this list,
        //        5 guard, 6 recipient
        let metas = extra_account_metas()?;
        let info = ctx.accounts.extra_account_meta_list.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;

        emit!(GuardInitialized {
            mint: guard.mint,
            authority: guard.authority,
            launch_ts: guard.launch_ts,
            window_end,
            max_per_transfer: guard.max_per_transfer,
            max_per_wallet: guard.max_per_wallet,
            cooldown_secs: guard.cooldown_secs,
            launch_wallets: guard.launch_wallets.clone(),
        });
        Ok(())
    }

    /// The SPL transfer-hook `Execute`, called by Token-2022 on every
    /// transfer of the mint. After the window it returns at once.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        let guard = &ctx.accounts.guard;
        let now = Clock::get()?.unix_timestamp;
        let ph = phase(guard.launch_ts, guard.window_end, now);
        if ph == Phase::Over {
            return Ok(()); // the cheap path, forever after the window
        }

        let mint = ctx.accounts.mint.key();
        let source_owner = token_account_owner_in_transfer(&ctx.accounts.source_token, &mint)?;
        let dest_owner = token_account_owner_in_transfer(&ctx.accounts.destination_token, &mint)?;

        let src_launch = guard.launch_wallets.contains(&source_owner);
        let dst_launch = guard.launch_wallets.contains(&dest_owner);
        if !is_restricted(src_launch, dst_launch) {
            return Ok(()); // sells, holder-to-holder, liquidity moves
        }
        require!(ph == Phase::Window, GuardError::NotOpenYet);

        // ---- the receiving wallet's Recipient (must be pre-registered)
        let info = ctx.accounts.recipient.to_account_info();
        require!(
            *info.owner == crate::ID && info.data_len() > 0,
            GuardError::RecipientNotRegistered
        );
        let mut rec: Recipient = {
            let data = info.try_borrow_data()?;
            Recipient::try_deserialize(&mut &data[..])?
        };
        // This program creates a Recipient only at ["recipient", mint, wallet]
        // with exactly these two fields, so matching fields = the right PDA.
        require!(
            rec.mint == mint && rec.wallet == dest_owner,
            GuardError::WrongRecipient
        );

        let limits = guard.limits();
        let next = check_receive(
            &limits,
            &Received {
                received: rec.received,
                transfers: rec.transfers,
                last_receive_ts: rec.last_receive_ts,
            },
            amount,
            now,
        )
        .map_err(|v| match v {
            Violation::NotOpen => error!(GuardError::NotOpenYet),
            Violation::OverPerTransfer => error!(GuardError::OverPerTransferCap),
            Violation::OverPerWallet => error!(GuardError::OverPerWalletCap),
            Violation::Cooldown => error!(GuardError::CooldownActive),
            Violation::Overflow => error!(GuardError::Overflow),
        })?;
        rec.received = next.received;
        rec.transfers = next.transfers;
        rec.last_receive_ts = next.last_receive_ts;
        let mut data = info.try_borrow_mut_data()?;
        rec.try_serialize(&mut &mut data[..])?;
        Ok(())
    }

    /// Creates the Recipient PDA of `wallet` so it can receive from launch
    /// wallets during the window. Anyone may pay (the buyer, the UI's fee
    /// payer); the rent goes back to the payer via `close_recipient`.
    pub fn register_recipient(ctx: Context<RegisterRecipient>, wallet: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now < ctx.accounts.guard.window_end, GuardError::WindowOver);
        require_keys_neq!(wallet, Pubkey::default(), GuardError::WrongRecipient);
        let r = &mut ctx.accounts.recipient;
        r.version = RECIPIENT_VERSION;
        r.bump = ctx.bumps.recipient;
        r.mint = ctx.accounts.guard.mint;
        r.wallet = wallet;
        r.payer = ctx.accounts.payer.key();
        r.received = 0;
        r.transfers = 0;
        r.last_receive_ts = 0;
        emit!(RecipientRegistered {
            mint: r.mint,
            wallet,
            payer: r.payer
        });
        Ok(())
    }

    /// After the window: anyone may close a Recipient; its rent goes back to
    /// whoever paid for it.
    pub fn close_recipient(ctx: Context<CloseRecipient>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.guard.window_end,
            GuardError::WindowNotOver
        );
        Ok(())
    }

    /// Ends the window now (never later than already set). A launch that has
    /// not started yet starts — and is over — immediately.
    pub fn end_window(ctx: Context<GuardAdmin>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let g = &mut ctx.accounts.guard;
        let (l, e) = end_early(g.launch_ts, g.window_end, now);
        g.launch_ts = l;
        g.window_end = e;
        emit!(WindowEnded {
            mint: g.mint,
            window_end: e
        });
        Ok(())
    }

    /// Loosens the limits (caps up, cooldown down). Tightening is impossible.
    pub fn relax_limits(
        ctx: Context<GuardAdmin>,
        max_per_transfer: u64,
        max_per_wallet: u64,
        cooldown_secs: i64,
    ) -> Result<()> {
        let g = &mut ctx.accounts.guard;
        let new = validate_relax(
            &g.limits(),
            &Limits {
                max_per_transfer,
                max_per_wallet,
                cooldown_secs,
            },
        )
        .map_err(param_err)?;
        g.max_per_transfer = new.max_per_transfer;
        g.max_per_wallet = new.max_per_wallet;
        g.cooldown_secs = new.cooldown_secs;
        emit!(LimitsRelaxed {
            mint: g.mint,
            max_per_transfer,
            max_per_wallet,
            cooldown_secs
        });
        Ok(())
    }

    /// Adds a launch wallet (e.g. a pool created later). Only BEFORE
    /// `launch_ts`: once trading opens the list can only shrink, so nobody's
    /// wallet can be turned into a restricted source mid-launch.
    pub fn add_launch_wallet(ctx: Context<GuardAdmin>, wallet: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let g = &mut ctx.accounts.guard;
        require!(
            now < g.launch_ts && now < g.window_end,
            GuardError::LaunchStarted
        );
        let mut list: Vec<[u8; 32]> = g.launch_wallets.iter().map(|k| k.to_bytes()).collect();
        list.push(wallet.to_bytes());
        validate_launch_wallets(&list).map_err(param_err)?;
        g.launch_wallets.push(wallet);
        emit!(LaunchWalletsChanged {
            mint: g.mint,
            launch_wallets: g.launch_wallets.clone()
        });
        Ok(())
    }

    /// Removes a launch wallet (any time; it only ever loosens what a
    /// non-launch wallet can do).
    pub fn remove_launch_wallet(ctx: Context<GuardAdmin>, wallet: Pubkey) -> Result<()> {
        let g = &mut ctx.accounts.guard;
        let before = g.launch_wallets.len();
        g.launch_wallets.retain(|k| *k != wallet);
        require!(
            g.launch_wallets.len() < before,
            GuardError::UnknownLaunchWallet
        );
        emit!(LaunchWalletsChanged {
            mint: g.mint,
            launch_wallets: g.launch_wallets.clone()
        });
        Ok(())
    }

    /// Hands the guard to another key, or renounces it (Pubkey::default()).
    pub fn set_authority(ctx: Context<GuardAdmin>, new_authority: Pubkey) -> Result<()> {
        let g = &mut ctx.accounts.guard;
        g.authority = new_authority;
        emit!(GuardAuthorityChanged {
            mint: g.mint,
            authority: new_authority
        });
        Ok(())
    }
}

/// The two extra accounts, as seeds Token-2022 (and every client using
/// `addExtraAccountMetasForExecute`) resolves on its own:
///   guard     = PDA(this program, ["guard", mint])
///   recipient = PDA(this program, ["recipient", mint, destination.owner]),
///               writable; destination.owner is read from the destination
///               token account's bytes 32..64.
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    Ok(vec![
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: GUARD_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: RECIPIENT_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountData {
                    account_index: 2,
                    data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                    length: 32,
                },
            ],
            false,
            true,
        )?,
    ])
}

/// The owner of a token account that is part of a transfer IN PROGRESS of
/// `mint`: owned by Token-2022, of this mint, with the `transferring` flag
/// Token-2022 sets only for the duration of the hook call. This stops anyone
/// from calling `execute` directly to inflate a victim's counters.
fn token_account_owner_in_transfer(acc: &UncheckedAccount, mint: &Pubkey) -> Result<Pubkey> {
    let info = acc.to_account_info();
    require_keys_eq!(*info.owner, spl_token_2022::ID, GuardError::NotInTransfer);
    let data = info.try_borrow_data()?;
    let st = StateWithExtensions::<SplAccount>::unpack(&data)
        .map_err(|_| error!(GuardError::NotInTransfer))?;
    require_keys_eq!(st.base.mint, *mint, GuardError::NotInTransfer);
    let ext = st
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(GuardError::NotInTransfer))?;
    require!(bool::from(ext.transferring), GuardError::NotInTransfer);
    Ok(st.base.owner)
}

fn param_err(e: ParamError) -> Error {
    match e {
        ParamError::WindowTooLong => error!(GuardError::WindowTooLong),
        ParamError::WindowEmpty => error!(GuardError::WindowEmpty),
        ParamError::LaunchTooFar => error!(GuardError::LaunchTooFar),
        ParamError::ZeroCap => error!(GuardError::ZeroCap),
        ParamError::WalletCapBelowTransferCap => error!(GuardError::WalletCapBelowTransferCap),
        ParamError::BadCooldown => error!(GuardError::BadCooldown),
        ParamError::TooManyLaunchWallets => error!(GuardError::TooManyLaunchWallets),
        ParamError::DuplicateLaunchWallet => error!(GuardError::DuplicateLaunchWallet),
        ParamError::NotLooser => error!(GuardError::NotLooser),
    }
}

// ---------------------------------------------------------------- accounts

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GuardParams {
    /// manages the guard afterwards (the creator); Pubkey::default() = nobody
    pub guard_authority: Pubkey,
    pub launch_ts: i64,
    /// 1..=86_400
    pub window_secs: i64,
    pub max_per_transfer: u64,
    pub max_per_wallet: u64,
    pub cooldown_secs: i64,
    /// owners of the pool vaults + the creator (<= 8)
    pub launch_wallets: Vec<Pubkey>,
}

impl GuardParams {
    fn limits(&self) -> Limits {
        Limits {
            max_per_transfer: self.max_per_transfer,
            max_per_wallet: self.max_per_wallet,
            cooldown_secs: self.cooldown_secs,
        }
    }
}

#[account]
#[derive(Debug)]
pub struct Guard {
    pub version: u8,
    pub bump: u8,
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub created_at: i64,
    pub launch_ts: i64,
    /// fixed at creation (<= launch_ts + 24h); only ever moves earlier
    pub window_end: i64,
    pub max_per_transfer: u64,
    pub max_per_wallet: u64,
    pub cooldown_secs: i64,
    pub launch_wallets: Vec<Pubkey>,
}

impl Guard {
    pub const SPACE: usize = 8 + 1 + 1 + 32 + 32 + 8 * 6 + 4 + 32 * MAX_LAUNCH_WALLETS;
    pub fn limits(&self) -> Limits {
        Limits {
            max_per_transfer: self.max_per_transfer,
            max_per_wallet: self.max_per_wallet,
            cooldown_secs: self.cooldown_secs,
        }
    }
}

#[account]
#[derive(Debug)]
pub struct Recipient {
    pub version: u8,
    pub bump: u8,
    pub mint: Pubkey,
    pub wallet: Pubkey,
    /// gets the rent back on `close_recipient`
    pub payer: Pubkey,
    pub received: u64,
    pub transfers: u32,
    pub last_receive_ts: i64,
}

impl Recipient {
    pub const SPACE: usize = 8 + 1 + 1 + 32 + 32 + 32 + 8 + 4 + 8;
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// the mint's mint authority or transfer-hook authority (checked in the handler)
    pub authority: Signer<'info>,
    /// CHECK: a Token-2022 mint; parsed and checked in the handler
    pub mint: UncheckedAccount<'info>,
    /// CHECK: created here with the interface's seeds; holds the TLV account list
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(EXTRA_META_COUNT).unwrap(),
        seeds = [EXTRA_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = Guard::SPACE, seeds = [GUARD_SEED, mint.key().as_ref()], bump)]
    pub guard: Account<'info, Guard>,
    pub system_program: Program<'info, System>,
}

/// Order fixed by the transfer-hook interface: source, mint, destination,
/// owner, validation account, then the extra accounts in list order.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: parsed (in the window only) by token_account_owner_in_transfer
    pub source_token: UncheckedAccount<'info>,
    /// CHECK: binds the guard PDA; token accounts are checked against it
    pub mint: UncheckedAccount<'info>,
    /// CHECK: parsed (in the window only) by token_account_owner_in_transfer
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: the source authority (owner or delegate); not used
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the validation account; not read by the program
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [GUARD_SEED, mint.key().as_ref()], bump = guard.bump)]
    pub guard: Account<'info, Guard>,
    /// CHECK: the destination owner's Recipient PDA; may not exist (checked
    /// in the handler, only when the transfer is restricted)
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RegisterRecipient<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub guard: Account<'info, Guard>,
    #[account(
        init,
        payer = payer,
        space = Recipient::SPACE,
        seeds = [RECIPIENT_SEED, guard.mint.as_ref(), wallet.as_ref()],
        bump
    )]
    pub recipient: Account<'info, Recipient>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseRecipient<'info> {
    pub guard: Account<'info, Guard>,
    #[account(
        mut,
        close = payer,
        has_one = payer @ GuardError::WrongRecipient,
        constraint = recipient.mint == guard.mint @ GuardError::WrongRecipient
    )]
    pub recipient: Account<'info, Recipient>,
    /// CHECK: receives the rent; must be the recorded payer (has_one)
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct GuardAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ GuardError::Unauthorized)]
    pub guard: Account<'info, Guard>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct GuardInitialized {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub launch_ts: i64,
    pub window_end: i64,
    pub max_per_transfer: u64,
    pub max_per_wallet: u64,
    pub cooldown_secs: i64,
    pub launch_wallets: Vec<Pubkey>,
}
#[event]
pub struct RecipientRegistered {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub payer: Pubkey,
}
#[event]
pub struct WindowEnded {
    pub mint: Pubkey,
    pub window_end: i64,
}
#[event]
pub struct LimitsRelaxed {
    pub mint: Pubkey,
    pub max_per_transfer: u64,
    pub max_per_wallet: u64,
    pub cooldown_secs: i64,
}
#[event]
pub struct LaunchWalletsChanged {
    pub mint: Pubkey,
    pub launch_wallets: Vec<Pubkey>,
}
#[event]
pub struct GuardAuthorityChanged {
    pub mint: Pubkey,
    pub authority: Pubkey,
}

#[error_code]
pub enum GuardError {
    #[msg("the mint is not a Token-2022 mint")]
    NotToken2022Mint,
    #[msg("the mint has no TransferHook extension")]
    MintHasNoTransferHook,
    #[msg("the mint's TransferHook points at another program")]
    HookPointsElsewhere,
    #[msg("signer is neither the mint authority nor the transfer-hook authority")]
    NotMintAuthority,
    #[msg("window longer than the hard maximum (24 h)")]
    WindowTooLong,
    #[msg("window must be at least 1 second")]
    WindowEmpty,
    #[msg("launch_ts more than 7 days ahead")]
    LaunchTooFar,
    #[msg("caps must be above zero")]
    ZeroCap,
    #[msg("per-wallet cap below per-transfer cap")]
    WalletCapBelowTransferCap,
    #[msg("cooldown must be between 0 and the window length")]
    BadCooldown,
    #[msg("at most 8 launch wallets")]
    TooManyLaunchWallets,
    #[msg("launch wallet listed twice")]
    DuplicateLaunchWallet,
    #[msg("limits can only be loosened")]
    NotLooser,
    #[msg("token account is not part of a transfer of this mint in progress")]
    NotInTransfer,
    #[msg("trading from launch wallets opens at launch_ts")]
    NotOpenYet,
    #[msg("the receiving wallet must call register_recipient first (launch window)")]
    RecipientNotRegistered,
    #[msg("recipient account does not belong to this mint / wallet")]
    WrongRecipient,
    #[msg("above the per-transfer cap during the launch window")]
    OverPerTransferCap,
    #[msg("above the per-wallet cap during the launch window")]
    OverPerWalletCap,
    #[msg("cooldown between receipts still running")]
    CooldownActive,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("the launch window is over")]
    WindowOver,
    #[msg("the launch window is not over yet")]
    WindowNotOver,
    #[msg("launch wallets can only be added before launch_ts")]
    LaunchStarted,
    #[msg("not a launch wallet")]
    UnknownLaunchWallet,
    #[msg("only the guard authority")]
    Unauthorized,
}

#[cfg(test)]
mod tests {
    use super::*;
    use spl_tlv_account_resolution::state::ExtraAccountMetaList;

    #[test]
    fn execute_discriminator_is_the_interface_one() {
        // sha256("spl-transfer-hook-interface:execute")[..8]
        let h = anchor_lang::solana_program::hash::hash(b"spl-transfer-hook-interface:execute")
            .to_bytes();
        assert_eq!(ExecuteInstruction::SPL_DISCRIMINATOR_SLICE, &h[..8]);
        assert_eq!(crate::instruction::Execute::DISCRIMINATOR, &h[..8]);
    }

    #[test]
    fn extra_metas_resolve_to_our_pdas() {
        let metas = extra_account_metas().unwrap();
        let mut buf = vec![0u8; ExtraAccountMetaList::size_of(EXTRA_META_COUNT).unwrap()];
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut buf, &metas).unwrap();
        assert_eq!(metas.len(), EXTRA_META_COUNT);
        assert!(!bool::from(metas[0].is_writable));
        assert!(bool::from(metas[1].is_writable));
        assert!(!bool::from(metas[1].is_signer));
    }

    #[test]
    fn spaces() {
        assert_eq!(Guard::SPACE, 8 + 2 + 64 + 48 + 4 + 256);
        assert_eq!(Recipient::SPACE, 8 + 2 + 96 + 20);
    }
}
