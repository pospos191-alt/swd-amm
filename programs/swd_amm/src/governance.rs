// Governance layer — added 2026-09-22 at the project owner's request to
// bring a Squads-multisig-governed allowlist + emergency-pause model into
// this program, on top of the existing permissionless constant-product
// (lib.rs) and DLMM (dlmm.rs) pool types.
//
// ============================================================================
// STATUS: UNAUDITED DRAFT, same as the rest of this program. This file adds
// new attack surface (new accounts, new authority checks) to a program that
// was already "DO NOT DEPLOY TO MAINNET" before this file existed — treat
// the whole program as no closer to mainnet-ready than it was before this
// was added. See SECURITY.md.
// ============================================================================
//
// DESIGN NOTE — why this does NOT re-implement Squads' threshold logic
// on-chain: an earlier draft of this feature (handed to me by the project
// owner, originally produced by a different AI tool) had this program load
// a Squads `Multisig` account directly and re-check its threshold/member
// count on every governed instruction, using the `squads-multisig` crate.
// That draft's own comments flagged real uncertainty about matching that
// crate's exact field names/API to whatever Squads version actually gets
// deployed. This file takes a simpler, more robust approach instead:
// `GlobalConfig.governance_authority` is just a Pubkey — expected to be a
// Squads Vault PDA, but this program never loads or inspects the Squads
// Multisig account itself. It only requires a signature from that exact
// pubkey on every governed instruction. This is safe for the same reason
// nearly every Solana program that is "governed by a multisig" works this
// way: by the time a Squads Vault PDA's signature reaches ANY program,
// Squads' own on-chain program has already enforced the M-of-N approval —
// re-checking it here would be redundant, and re-implementing it here
// (rather than just trusting the signature) would only add a second,
// independently-maintained copy of that logic that could drift out of sync
// with whatever Squads version is actually live. The tradeoff: this program
// cannot verify from the outside that `governance_authority` really is a
// well-formed Squads vault (as opposed to, say, a single hot wallet) —
// that is a deployment-time responsibility, not something this program can
// or should enforce on-chain. Document your actual Squads vault setup
// (members, threshold) in SECURITY.md / your deploy runbook, not in code.
//
// SCOPE of what this file adds:
// 1. GlobalConfig — one singleton PDA holding the governance authority (the
//    Squads vault), a SEPARATE emergency authority, and a global switch to
//    stop NEW pool creation.
// 2. AllowedMint — a per-mint allowlist gate. After this file, both
//    initialize_pool (lib.rs) and initialize_dlmm_pool (dlmm.rs) require
//    BOTH mints of a new pool to have an enabled AllowedMint entry. This is
//    a real behavior change from before this file existed — pool creation
//    used to be fully permissionless (see initialize_pool's old doc
//    comment, now updated). Existing pools created before this change are
//    unaffected; they do not need an AllowedMint entry to keep operating.
// 3. Emergency pause: emergency_authority can pause swap/deposit/withdraw
//    on an existing pool (either pool type) — and ONLY pause. There is
//    deliberately no emergency-unpause, no emergency fee/allowlist change,
//    and no emergency ability to move vault funds — matching this
//    program's existing "no admin-drain" principle for anything the
//    emergency key can reach. Only governance_authority (the Squads vault)
//    can unpause, and unpausing is intentionally instant (no additional
//    on-chain timelock) — Squads' own multi-signer approval already is the
//    human-review gate for that action; layering a second on-chain
//    timelock on top of it would slow down un-blocking real users after a
//    false alarm without a matching security benefit.
//
// EXPLICITLY NOT IN SCOPE (deferred, not silently dropped):
// - Governed, timelocked fee changes. Pool.fee_bps is immutable by the
//   original, deliberate design of this program (see initialize_pool's
//   comment history) — "there is no set_fee/admin instruction in this
//   program" was a security property, not an oversight. Making fees
//   governance-mutable is a real architecture change with its own
//   centralization tradeoffs (a compromised or coerced multisig could raise
//   fees on existing LPs) and needs its own explicit design/review, not a
//   quick addition here.
// - An oracle-guarded price/impact check. This program has no oracle
//   integration anywhere today; the constant-product and DLMM swap formulas
//   both derive price purely from pool reserves. Bolting an external oracle
//   dependency onto the already-tested swap math is a substantial change
//   that needs its own design pass (which oracle, staleness handling,
//   deviation bounds) — attempting it inside this file risked destabilizing
//   the 10/10 passing tests for a feature that wasn't part of what was
//   asked for (allowlist + pause).
// - Token-2022 support. Still fully out of scope program-wide — see the
//   ASSUMPTION note at the top of lib.rs. AllowedMint does not gate token
//   PROGRAM choice, only which legacy-SPL mints may be paired.
//
// SQUADS MULTISIG TRANSPARENCY ("Phase 2", added 2026-09-23): the design
// note above (why this file trusts `governance_authority`'s signature
// rather than re-checking Squads' own approval logic) still holds — this
// addition does NOT change that. What it adds is purely informational:
// `verify_governance_multisig` lets anyone load the REAL, live on-chain
// Squads `Multisig` account that `config.governance_authority` is
// supposedly a vault of, cryptographically confirm that binding (by
// re-deriving the vault PDA from the multisig account and checking it
// equals `governance_authority`), and emit that multisig's actual current
// `threshold`/member count in an event — so anyone watching on-chain
// activity can see for themselves "this program's governance really is
// gated by an M-of-N multisig with these exact parameters" instead of
// trusting an out-of-band claim in a README. Deliberately a SEPARATE,
// permissionless, read-only instruction rather than something bolted onto
// `set_authorities`/`governed_unpause_pool`/etc.: those instructions are
// already implemented and covered by the existing 26/26 passing test
// suite, and gating them on a NEW on-chain integration this file has less
// certainty about (see below) would risk bricking real governance actions
// if that integration turns out wrong. This way, a mistake in the new
// code only breaks the new, isolated instruction — every existing
// governance action keeps working exactly as it does today regardless.
//
// KNOWN UNCERTAINTY (read before trusting this in production): this file
// reads the Squads v4 `Multisig` account's raw bytes at fixed offsets
// (see `read_squads_multisig_summary`) rather than depending on Squads'
// own Rust crate — same reasoning as the design note above: avoiding a
// dependency whose exact version/API compatibility with this program's
// toolchain can't be verified here. The account's FIELD LAYOUT and the
// PROGRAM ID (`SQUADS_V4_PROGRAM_ID`) were confirmed directly against
// Squads' own published documentation (docs.squads.so) on 2026-09-23. The
// VAULT PDA SEED LITERALS (`SQUADS_SEED_PREFIX`/`SQUADS_SEED_VAULT`)
// were NOT independently confirmed byte-for-byte the same way — they are
// a best-effort reconstruction. `tests/governance.ts`'s Squads
// transparency test is the real verification for those two constants: it
// creates a genuine multisig with the official `@sqds/multisig` SDK,
// lets THAT SDK derive the real vault PDA, and checks this program's own
// derivation lands on the exact same address. If that test fails with
// `MultisigVaultMismatch`, these are the two constants to fix first —
// nothing else in this program depends on them.

use anchor_lang::prelude::*;
// Token-2022 support (added 2026-09-23, alongside lib.rs's — see that
// file's module doc comment): imported by name, not referenced inline as
// `anchor_spl::token_interface::InterfaceAccount<...>`, because Anchor's
// `#[derive(Accounts)]` macro rejects a segmented path as a field's OUTER
// type ("segmented paths are not currently allowed") — confirmed by the
// user's own `cargo test` run, 2026-09-23. `InterfaceAccount` itself is
// NOT imported here — it lives in `anchor_lang::prelude` (already brought
// in by the glob import above), not in `anchor_spl::token_interface`; a
// first attempt at this fix tried importing it from the latter and hit
// "no `InterfaceAccount` in `token_interface`" (also confirmed by the
// user's own build, 2026-09-23) — only `Mint` needs importing from
// `token_interface` here, aliased to `Token2022Mint` to keep intent
// obvious at the call site below (this file has no other `Mint` import to
// collide with, but the alias avoids any ambiguity with `crate::Pool`'s
// own classic-mint usage).
use anchor_spl::token_interface::Mint as Token2022Mint;

use crate::dlmm::DlmmPool;
use crate::{Pool, DLMM_POOL_SEED, POOL_SEED};

pub const GLOBAL_CONFIG_SEED: &[u8] = b"global-config";
pub const ALLOWED_MINT_SEED: &[u8] = b"allowed-mint";
/// Per-mint Pyth feed registry (2026-10-08) — see `set_mint_feed`.
pub const MINT_FEED_SEED: &[u8] = b"mint-feed";

// ---------------------------------------------------------------------
// Squads v4 constants — see the module doc comment's "SQUADS MULTISIG
// TRANSPARENCY" / "KNOWN UNCERTAINTY" paragraphs for what is and isn't
// independently confirmed here.
// ---------------------------------------------------------------------

/// Squads Protocol v4's on-chain program id — confirmed against Squads'
/// own bug-bounty page (docs.squads.so/main/security/bug-bounty) on
/// 2026-09-23. Do NOT confuse with the OLDER v3 program id
/// (`SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu`, a different program
/// with a different account layout) — that exact mixup happened once
/// while building this feature, from memory alone, before the official
/// docs were checked directly; left as a comment here as a reminder of
/// how easy that particular mistake is to make.
pub const SQUADS_V4_PROGRAM_ID: Pubkey = pubkey!("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

/// PDA seed literals for a Squads v4 Vault account. NOT independently
/// confirmed byte-for-byte against Squads' own source — see the module
/// doc comment. If `tests/governance.ts`'s Squads transparency test fails
/// with `MultisigVaultMismatch`, these two constants (and/or how
/// `vault_index` is encoded into the seed in `derive_squads_vault_pda`)
/// are the first thing to check against Squads' actual deployed program.
const SQUADS_SEED_PREFIX: &[u8] = b"multisig";
const SQUADS_SEED_VAULT: &[u8] = b"vault";

/// Minimum byte length of a Squads v4 `Multisig` account this program
/// needs to be able to read `threshold` and the `members` Vec's own
/// length prefix — see `read_squads_multisig_summary`'s doc comment for
/// the exact byte-offset layout this is derived from. A real Multisig
/// account with at least one member is always longer than this; a
/// shorter account is either a different account type entirely or one
/// Anchor initialized but Squads' own `create` instruction never
/// finished populating.
const SQUADS_MULTISIG_MIN_LEN: usize = 100;

// ---------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------

/// One-time bootstrap. Can only ever run once per deployment — the `init`
/// constraint on `config` fails on a second call, there is no
/// re-initialize/overwrite path. Changing either authority afterward
/// requires a new instruction signed by the CURRENT governance_authority
/// (see `set_authorities`), never just by paying rent again.
///
/// SECURITY (2026-10-08, attack suite `security/attack-tests`): the payer
/// must be the program's UPGRADE AUTHORITY, read from the program's own
/// ProgramData account. Before this, ANY wallet could call it first after
/// a deploy and make itself governance_authority (a deploy front-run: the
/// config is a singleton PDA, so the first caller wins for good).
pub(crate) fn initialize_global_config(
    ctx: Context<InitializeGlobalConfig>,
    governance_authority: Pubkey,
    emergency_authority: Pubkey,
) -> Result<()> {
    let (expected_program_data, _) = Pubkey::find_program_address(
        &[crate::ID.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    );
    require_keys_eq!(
        ctx.accounts.program_data.key(),
        expected_program_data,
        GovernanceError::Unauthorized
    );
    require!(
        ctx.accounts.program_data.upgrade_authority_address == Some(ctx.accounts.payer.key()),
        GovernanceError::Unauthorized
    );
    require_keys_neq!(
        governance_authority,
        emergency_authority,
        GovernanceError::EmergencyCannotEqualGovernance
    );

    let config = &mut ctx.accounts.config;
    config.governance_authority = governance_authority;
    config.emergency_authority = emergency_authority;
    config.pool_creation_paused = false;
    config.bump = ctx.bumps.config;

    emit!(GlobalConfigInitialized {
        config: config.key(),
        governance_authority,
        emergency_authority,
    });
    Ok(())
}

/// Rotates either authority. Signed by the CURRENT governance_authority —
/// so if the Squads vault itself is ever replaced (e.g. membership
/// changes), governance moves itself to the new vault deliberately rather
/// than this program trying to detect that change automatically. Passing
/// the same value as the field's current one is allowed (a no-op update)
/// to keep the instruction simple; it still emits an event either way so
/// off-chain monitoring sees every call.
pub(crate) fn set_authorities(
    ctx: Context<GovernanceOnly>,
    new_governance_authority: Pubkey,
    new_emergency_authority: Pubkey,
) -> Result<()> {
    require_keys_neq!(
        new_governance_authority,
        new_emergency_authority,
        GovernanceError::EmergencyCannotEqualGovernance
    );

    let config = &mut ctx.accounts.config;
    config.governance_authority = new_governance_authority;
    config.emergency_authority = new_emergency_authority;

    emit!(AuthoritiesUpdated {
        config: config.key(),
        governance_authority: new_governance_authority,
        emergency_authority: new_emergency_authority,
    });
    Ok(())
}

/// Governance-only global switch. When true, BOTH initialize_pool and
/// initialize_dlmm_pool refuse to create any new pool, regardless of
/// allowlist state — a fast-acting "stop new exposure" lever that does not
/// touch any existing pool's funds or trading. Existing pools are
/// completely unaffected; use emergency_pause_pool /
/// emergency_pause_dlmm_pool to actually stop trading on a specific pool
/// that is already live.
pub(crate) fn set_pool_creation_paused(ctx: Context<GovernanceOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.pool_creation_paused = paused;
    emit!(PoolCreationPausedSet {
        config: ctx.accounts.config.key(),
        paused,
    });
    Ok(())
}

/// Governance-only. Adding a mint here does not create or affect any pool
/// by itself — it only permits FUTURE calls to initialize_pool /
/// initialize_dlmm_pool that reference this mint. Disabling a previously-
/// enabled mint (enabled = false) also does not touch any pool already
/// created while it was enabled; those pools keep operating exactly as
/// before (see the module doc comment).
pub(crate) fn set_allowed_mint(ctx: Context<SetAllowedMint>, enabled: bool) -> Result<()> {
    let allowed = &mut ctx.accounts.allowed_mint;
    allowed.mint = ctx.accounts.mint.key();
    allowed.enabled = enabled;
    allowed.bump = ctx.bumps.allowed_mint;

    emit!(AllowedMintUpdated {
        mint: allowed.mint,
        enabled,
    });
    Ok(())
}

/// Records which Pyth feed prices `mint` (governance only). Pool creation
/// (CP, DLMM, and SWDMM v2 with its oracle guard on) must name exactly the
/// registered feeds. Added 2026-10-08: pool addresses are one per mint pair
/// (per fee tier for v2) and their oracle feeds are fixed at creation, so
/// whoever created a pair's pool first could bind it to the wrong asset's
/// price — or to a feed that never updates — for good.
pub(crate) fn set_mint_feed(ctx: Context<SetMintFeed>, pyth_feed_id: [u8; 32]) -> Result<()> {
    require!(pyth_feed_id != [0u8; 32], GovernanceError::InvalidFeedId);
    let f = &mut ctx.accounts.mint_feed;
    f.mint = ctx.accounts.mint.key();
    f.pyth_feed_id = pyth_feed_id;
    f.bump = ctx.bumps.mint_feed;
    emit!(MintFeedSet { mint: f.mint, pyth_feed_id });
    Ok(())
}

/// Pause-only, and only reachable by `config.emergency_authority` — a
/// deliberately DIFFERENT key from `governance_authority` (enforced at
/// `initialize_global_config` / `set_authorities` time). At least one of
/// the three flags must be requested true; this instruction can never turn
/// a flag OFF (see `require!` below) — that is `governed_unpause_pool`'s
/// job, and that one requires `governance_authority`, not
/// `emergency_authority`. This asymmetry (easy, narrow, single-signer
/// pause vs. multisig-only unpause) is the whole point of having a
/// separate emergency key at all: it can react fast to stop damage, but it
/// can never itself decide the incident is over.
pub(crate) fn emergency_pause_pool(
    ctx: Context<EmergencyPausePool>,
    pause_swap: bool,
    pause_deposit: bool,
    pause_withdraw: bool,
) -> Result<()> {
    require!(
        pause_swap || pause_deposit || pause_withdraw,
        GovernanceError::EmergencyPauseRequestEmpty
    );

    let pool = &mut ctx.accounts.pool;
    if pause_swap {
        pool.swap_paused = true;
    }
    if pause_deposit {
        pool.deposit_paused = true;
    }
    if pause_withdraw {
        pool.withdraw_paused = true;
    }

    emit!(PoolPaused {
        pool: pool.key(),
        swap_paused: pool.swap_paused,
        deposit_paused: pool.deposit_paused,
        withdraw_paused: pool.withdraw_paused,
    });
    Ok(())
}

/// DLMM-pool counterpart to `emergency_pause_pool` — see that function's
/// doc comment, identical reasoning and identical restrictions, just
/// typed against `DlmmPool` instead of `Pool` (Anchor's `Accounts` structs
/// are per concrete account type, so this program follows its own existing
/// pattern of a thin, separate wrapper per pool type rather than one
/// generic instruction — see lib.rs's swap / swap_dlmm for the precedent).
pub(crate) fn emergency_pause_dlmm_pool(
    ctx: Context<EmergencyPauseDlmmPool>,
    pause_swap: bool,
    pause_deposit: bool,
    pause_withdraw: bool,
) -> Result<()> {
    require!(
        pause_swap || pause_deposit || pause_withdraw,
        GovernanceError::EmergencyPauseRequestEmpty
    );

    let pool = &mut ctx.accounts.pool;
    if pause_swap {
        pool.swap_paused = true;
    }
    if pause_deposit {
        pool.deposit_paused = true;
    }
    if pause_withdraw {
        pool.withdraw_paused = true;
    }

    emit!(DlmmPoolPaused {
        pool: pool.key(),
        swap_paused: pool.swap_paused,
        deposit_paused: pool.deposit_paused,
        withdraw_paused: pool.withdraw_paused,
    });
    Ok(())
}

/// Governance-only (the Squads vault), instant — see the module doc
/// comment for why this deliberately has no additional on-chain timelock.
/// Clears whichever of the three flags are requested; flags not requested
/// are left exactly as they were (so a pool paused on swap+deposit can be
/// unpaused on just swap, leaving deposit paused, in one call or two —
/// caller's choice).
pub(crate) fn governed_unpause_pool(
    _ctx: Context<GovernancePausePool>,
    _unpause_swap: bool,
    _unpause_deposit: bool,
    _unpause_withdraw: bool,
) -> Result<()> {
    // Since 2026-09-29 (SWDMM spec) unpausing must go through the
    // timelocked propose/execute flow in timelock.rs. This instant path is
    // kept only so old clients get a clear error instead of an unknown
    // instruction.
    err!(crate::timelock::TimelockError::UseTimelockedUnpause)
}

/// DLMM-pool counterpart to `governed_unpause_pool` — see that function's
/// doc comment.
pub(crate) fn governed_unpause_dlmm_pool(
    _ctx: Context<GovernancePauseDlmmPool>,
    _unpause_swap: bool,
    _unpause_deposit: bool,
    _unpause_withdraw: bool,
) -> Result<()> {
    // Since 2026-09-29 (SWDMM spec) unpausing must go through the
    // timelocked propose/execute flow in timelock.rs. This instant path is
    // kept only so old clients get a clear error instead of an unknown
    // instruction.
    err!(crate::timelock::TimelockError::UseTimelockedUnpause)
}

/// Permissionless, read-only (in effect — it only emits an event, never
/// writes any account). Loads the Squads v4 `Multisig` account the caller
/// claims backs `config.governance_authority`, confirms that binding by
/// re-deriving the vault PDA at `vault_index` from the multisig account
/// and checking it equals `governance_authority` (so a caller can't just
/// pass an unrelated multisig with a favorable-looking threshold), and
/// emits the multisig's real, current threshold and member count. See the
/// module doc comment ("SQUADS MULTISIG TRANSPARENCY") for why this is a
/// standalone instruction rather than something the existing governance
/// instructions require.
pub(crate) fn verify_governance_multisig(
    ctx: Context<VerifyGovernanceMultisig>,
    vault_index: u8,
) -> Result<()> {
    let multisig_ai = ctx.accounts.squads_multisig.to_account_info();
    require!(
        *multisig_ai.owner == SQUADS_V4_PROGRAM_ID,
        GovernanceError::NotASquadsMultisigAccount
    );

    let (threshold, member_count) = read_squads_multisig_summary(&multisig_ai)?;

    let derived_vault = derive_squads_vault_pda(multisig_ai.key, vault_index);
    require_keys_eq!(
        derived_vault,
        ctx.accounts.config.governance_authority,
        GovernanceError::MultisigVaultMismatch
    );

    emit!(GovernanceMultisigVerified {
        config: ctx.accounts.config.key(),
        squads_multisig: *multisig_ai.key,
        vault_index,
        governance_authority: ctx.accounts.config.governance_authority,
        threshold,
        member_count,
    });
    Ok(())
}

/// Reads a Squads v4 `Multisig` account's `threshold` and the length
/// prefix of its `members: Vec<Member>` field (i.e. the member count)
/// directly off the account's raw bytes, at fixed offsets, rather than
/// Borsh-deserializing the whole struct (which would require also getting
/// `Member`'s own field layout exactly right — unnecessary, since neither
/// value this function returns depends on it: `Vec<T>`'s Borsh encoding
/// is always a little-endian `u32` length prefix followed by that many
/// `T`s, whatever `T` is). Layout (confirmed against Squads' own docs —
/// see the module doc comment):
///
/// ```text
/// [0..8)    Anchor account discriminator
/// [8..40)   create_key: Pubkey
/// [40..72)  config_authority: Pubkey
/// [72..74)  threshold: u16
/// [74..78)  time_lock: u32
/// [78..86)  transaction_index: u64
/// [86..94)  stale_transaction_index: u64
/// [94..95)  _reserved: u8
/// [95..96)  bump: u8
/// [96..100) members: Vec<Member> — u32 length prefix (member_count)
/// [100..)   the Member entries themselves — not read by this function
/// ```
fn read_squads_multisig_summary(multisig_ai: &AccountInfo) -> Result<(u16, u32)> {
    let data = multisig_ai.try_borrow_data()?;
    require!(
        data.len() >= SQUADS_MULTISIG_MIN_LEN,
        GovernanceError::MultisigAccountTooShort
    );
    let threshold = u16::from_le_bytes(data[72..74].try_into().unwrap());
    let member_count = u32::from_le_bytes(data[96..100].try_into().unwrap());
    Ok((threshold, member_count))
}

/// Re-derives a Squads v4 Vault PDA from a multisig account's own pubkey
/// and a vault index, so callers can confirm a claimed multisig account
/// really is the one behind a given vault address — see the module doc
/// comment's "KNOWN UNCERTAINTY" paragraph: the seed literals this uses
/// are a best-effort reconstruction, verified end-to-end by
/// `tests/governance.ts`'s Squads transparency test against the real
/// `@sqds/multisig` SDK's own derivation, not independently confirmed
/// against Squads' source directly.
fn derive_squads_vault_pda(multisig_key: &Pubkey, vault_index: u8) -> Pubkey {
    let (vault_pda, _bump) = Pubkey::find_program_address(
        &[
            SQUADS_SEED_PREFIX,
            multisig_key.as_ref(),
            SQUADS_SEED_VAULT,
            &[vault_index],
        ],
        &SQUADS_V4_PROGRAM_ID,
    );
    vault_pda
}

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeGlobalConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + GlobalConfig::SIZE,
        seeds = [GLOBAL_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// This program's ProgramData (PDA of the BPF upgradeable loader,
    /// seeds = [program id]); its upgrade authority must be `payer` —
    /// checked in `initialize_global_config`.
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

/// Shared account shape for every governance-only instruction that just
/// needs `config` plus a signature matching `config.governance_authority`
/// — that match is checked in the body (not a declarative `address =`
/// constraint) because `config` must be loaded first to know what address
/// to compare against, matching this program's existing style of doing
/// cross-account checks explicitly in the instruction body (see e.g.
/// `swap`'s doc comment in lib.rs for the same rationale).
#[derive(Accounts)]
pub struct GovernanceOnly<'info> {
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = governance_authority.key() == config.governance_authority @ GovernanceError::Unauthorized)]
    pub governance_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetAllowedMint<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = governance_authority.key() == config.governance_authority @ GovernanceError::Unauthorized)]
    pub governance_authority: Signer<'info>,

    // `InterfaceAccount` (not the classic-only `Account<'info,
    // anchor_spl::token::Mint>`) so a Token-2022 mint can be allowlisted
    // too — added 2026-09-23 alongside lib.rs's Token-2022 support (see
    // lib.rs's module doc comment, "TOKEN PROGRAM SUPPORT"). The
    // constant-product pool (lib.rs) additionally gates a Token-2022
    // mint's specific extensions at `initialize_pool` time via
    // `assert_mint_extensions_safe`; this allowlist entry only says "this
    // mint may be used at all", same as it always has for classic mints.
    // Written via the imported `InterfaceAccount`/`Token2022Mint` names
    // (not inline as `anchor_spl::token_interface::InterfaceAccount<...>`)
    // — see the `use` block above for why.
    pub mint: InterfaceAccount<'info, Token2022Mint>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AllowedMint::SIZE,
        seeds = [ALLOWED_MINT_SEED, mint.key().as_ref()],
        bump
    )]
    pub allowed_mint: Account<'info, AllowedMint>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMintFeed<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = governance_authority.key() == config.governance_authority @ GovernanceError::Unauthorized)]
    pub governance_authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Token2022Mint>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + MintFeed::SIZE,
        seeds = [MINT_FEED_SEED, mint.key().as_ref()],
        bump
    )]
    pub mint_feed: Account<'info, MintFeed>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EmergencyPausePool<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = emergency_authority.key() == config.emergency_authority @ GovernanceError::Unauthorized)]
    pub emergency_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct EmergencyPauseDlmmPool<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = emergency_authority.key() == config.emergency_authority @ GovernanceError::Unauthorized)]
    pub emergency_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [DLMM_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, DlmmPool>,
}

#[derive(Accounts)]
pub struct GovernancePausePool<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = governance_authority.key() == config.governance_authority @ GovernanceError::Unauthorized)]
    pub governance_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct GovernancePauseDlmmPool<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(constraint = governance_authority.key() == config.governance_authority @ GovernanceError::Unauthorized)]
    pub governance_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [DLMM_POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, DlmmPool>,
}

/// No signer at all — see `verify_governance_multisig`'s doc comment:
/// this instruction only reads accounts and emits an event, so anyone can
/// call it (the transparency it provides is only useful if ANYONE can
/// check it, not just governance_authority itself).
#[derive(Accounts)]
pub struct VerifyGovernanceMultisig<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    /// CHECK: not a typed Anchor account because it belongs to Squads'
    /// own program, not this one — validated by hand in the instruction
    /// body instead: `verify_governance_multisig` checks `owner ==
    /// SQUADS_V4_PROGRAM_ID` before parsing anything, and
    /// `read_squads_multisig_summary` checks the account is long enough
    /// before reading any offset out of it. Never written to.
    pub squads_multisig: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

#[account]
pub struct GlobalConfig {
    /// Expected to be a Squads Vault PDA — see the module doc comment for
    /// why this program only checks the signature, not Squads' own
    /// account internals.
    pub governance_authority: Pubkey,
    /// A DIFFERENT key from governance_authority (enforced at init/rotate
    /// time) with narrower, pause-only power — see emergency_pause_pool.
    pub emergency_authority: Pubkey,
    pub pool_creation_paused: bool,
    pub bump: u8,
}

impl GlobalConfig {
    pub const SIZE: usize = 32 + 32 + 1 + 1;
}

#[account]
pub struct AllowedMint {
    pub mint: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

impl AllowedMint {
    pub const SIZE: usize = 32 + 1 + 1;
}

#[account]
pub struct MintFeed {
    pub mint: Pubkey,
    pub pyth_feed_id: [u8; 32],
    pub bump: u8,
}

impl MintFeed {
    pub const SIZE: usize = 32 + 32 + 1;
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------

#[event]
pub struct GlobalConfigInitialized {
    pub config: Pubkey,
    pub governance_authority: Pubkey,
    pub emergency_authority: Pubkey,
}

#[event]
pub struct AuthoritiesUpdated {
    pub config: Pubkey,
    pub governance_authority: Pubkey,
    pub emergency_authority: Pubkey,
}

#[event]
pub struct PoolCreationPausedSet {
    pub config: Pubkey,
    pub paused: bool,
}

#[event]
pub struct AllowedMintUpdated {
    pub mint: Pubkey,
    pub enabled: bool,
}

#[event]
pub struct MintFeedSet {
    pub mint: Pubkey,
    pub pyth_feed_id: [u8; 32],
}

#[event]
pub struct PoolPaused {
    pub pool: Pubkey,
    pub swap_paused: bool,
    pub deposit_paused: bool,
    pub withdraw_paused: bool,
}

#[event]
pub struct DlmmPoolPaused {
    pub pool: Pubkey,
    pub swap_paused: bool,
    pub deposit_paused: bool,
    pub withdraw_paused: bool,
}

#[event]
pub struct PoolUnpaused {
    pub pool: Pubkey,
    pub swap_paused: bool,
    pub deposit_paused: bool,
    pub withdraw_paused: bool,
}

#[event]
pub struct DlmmPoolUnpaused {
    pub pool: Pubkey,
    pub swap_paused: bool,
    pub deposit_paused: bool,
    pub withdraw_paused: bool,
}

/// Emitted by `verify_governance_multisig` — see that function's doc
/// comment. `threshold`/`member_count` are read live off the real Squads
/// account at call time, never cached, so this event always reflects the
/// multisig's actual current configuration at the moment of the call.
#[event]
pub struct GovernanceMultisigVerified {
    pub config: Pubkey,
    pub squads_multisig: Pubkey,
    pub vault_index: u8,
    pub governance_authority: Pubkey,
    pub threshold: u16,
    pub member_count: u32,
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

// Own code range (2026-10-08): lib.rs 6000+, dlmm 6100+, governance
// 6200+, oracle 6300+, swdmm_v2 8000+, timelock 8500+. They all used to
// start at 6000, so a raw error number did not say which error it was.
#[error_code(offset = 6200)]
pub enum GovernanceError {
    #[msg("Signer does not match the required authority")]
    Unauthorized,
    #[msg("emergency_authority and governance_authority must be different keys")]
    EmergencyCannotEqualGovernance,
    #[msg("At least one pause/unpause flag must be true")]
    EmergencyPauseRequestEmpty,
    #[msg("Account is not owned by the Squads v4 program")]
    NotASquadsMultisigAccount,
    #[msg("Account is too short to be a Squads v4 Multisig account")]
    MultisigAccountTooShort,
    #[msg("The given multisig account's vault at this index does not match governance_authority")]
    MultisigVaultMismatch,
    #[msg("A Pyth feed id cannot be all zeros")]
    InvalidFeedId,
}
