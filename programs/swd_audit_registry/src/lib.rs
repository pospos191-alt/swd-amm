// SWD Audit Registry — a readable on-chain registry of SWD Audit results for
// SAWASDEE COIN (SWD). Design, trust model, costs and the deploy path:
// docs/SWD_AUDIT_REGISTRY.md (Thai: docs/SWD_AUDIT_REGISTRY.th.md).
//
// ============================================================================
// STATUS: UNAUDITED DRAFT. NOT ON MAINNET. An independent review is required
// before mainnet (docs/SWD_AUDIT_REGISTRY.md "Before mainnet").
// ============================================================================
//
// One `Record` PDA per audited subject (seeds "audit" + chain id + sha256 of
// the normalized address) holds the latest level / verdict / attestation hash.
// ANYONE may submit a record (a relayer, a crank, the site's cron), but only
// with an Ed25519 signature by one of the registry's ACTIVE attestor keys over
// the exact record bytes (message.rs), checked through the Ed25519 precompile
// instruction placed immediately before `upsert_record` in the same
// transaction. The registry trusts the signature, never the caller.
//
// The attestation's ML-DSA-44 (post-quantum) signature cannot be verified on
// Solana (no syscall; ~2.4 KB signatures). The record keeps the ML-DSA key id
// and the attestation's payloadHash, so anyone can fetch the full attestation
// and run the hybrid check off-chain (site: /api/audit/attest, or
// scripts/verify-attestation.mjs in the site repo).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

pub mod message;
pub mod reader;

use message::*;

// TODO(before build): replace with the real program id.
// Generate one with `solana-keygen new -o target/deploy/swd_audit_registry-keypair.json`
// after `anchor build` creates the target/ directory, then run
// `anchor keys list` and paste the result here AND in Anchor.toml. The value
// below is a random placeholder so this file parses (CI rewrites it to a
// throwaway key for each run); it is NOT a deployed program.
declare_id!("AX4Z8w2r7558cz4uK2nq3iPoE8HWzwh58ew47caPVyCZ");

pub const CONFIG_SEED: &[u8] = b"config";
pub const RECORD_SEED: &[u8] = b"audit";

pub const MAX_ATTESTORS: usize = 4;
/// A record may be stamped at most this far in the future (attestor clock skew).
pub const MAX_FUTURE_SKEW_SECS: i64 = 300;

pub const ATTESTOR_ACTIVE: u8 = 1;
pub const ATTESTOR_RETIRED: u8 = 2;
pub const ATTESTOR_REVOKED: u8 = 3;

pub const CONFIG_VERSION: u8 = 1;
pub const RECORD_VERSION: u8 = 1;

/// The Ed25519 signature-verification precompile.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

#[program]
pub mod swd_audit_registry {
    use super::*;

    /// One-time bootstrap. Only the program's UPGRADE AUTHORITY may call it
    /// (read from its ProgramData), so nobody can front-run a fresh deploy and
    /// make themselves the registry authority. `authority` should be the
    /// Squads vault on mainnet.
    pub fn initialize(
        ctx: Context<Initialize>,
        authority: Pubkey,
        attestors: Vec<AttestorInput>,
    ) -> Result<()> {
        let (expected_program_data, _) = Pubkey::find_program_address(
            &[crate::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        );
        require_keys_eq!(
            ctx.accounts.program_data.key(),
            expected_program_data,
            RegistryError::Unauthorized
        );
        require!(
            ctx.accounts.program_data.upgrade_authority_address == Some(ctx.accounts.payer.key()),
            RegistryError::Unauthorized
        );
        require_keys_neq!(
            authority,
            Pubkey::default(),
            RegistryError::InvalidAuthority
        );

        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        config.version = CONFIG_VERSION;
        config.bump = ctx.bumps.config;
        config.authority = authority;
        config.pending_authority = None;
        config.paused = false;
        config.record_count = 0;
        config.attestors = apply_attestors(&[], &attestors, now)?;

        emit!(RegistryInitialized {
            config: config.key(),
            authority
        });
        emit_attestors(config);
        Ok(())
    }

    /// Creates or updates the Record of (chain_id, address). Permissionless;
    /// the Ed25519 instruction right before this one must carry an ACTIVE
    /// attestor's signature over `record_message(config, fields)`.
    pub fn upsert_record(ctx: Context<UpsertRecord>, input: RecordInput) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, RegistryError::Paused);

        // ---- the fields themselves
        require!(
            chain_name(input.chain_id).is_some(),
            RegistryError::UnknownChain
        );
        check_address(input.chain_id, &input.address).map_err(|e| match e {
            AddressError::Empty => error!(RegistryError::AddressEmpty),
            AddressError::TooLong => error!(RegistryError::AddressTooLong),
            AddressError::Format => error!(RegistryError::AddressFormat),
        })?;
        require!(
            address_hash(&input.address) == input.address_hash,
            RegistryError::AddressHashMismatch
        );
        require!(input.level <= LEVEL_HIGH, RegistryError::InvalidLevel);
        let clock = Clock::get()?;
        require!(input.audited_at > 0, RegistryError::InvalidTimestamp);
        require!(
            input.audited_at <= clock.unix_timestamp.saturating_add(MAX_FUTURE_SKEW_SECS),
            RegistryError::TimestampInFuture
        );

        // ---- the signature (Ed25519 precompile, the instruction just before this one)
        let ixs = ctx.accounts.instructions.to_account_info();
        let current = ix_sysvar::load_current_index_checked(&ixs)?;
        require!(current > 0, RegistryError::MissingEd25519Instruction);
        let ed_ix = ix_sysvar::load_instruction_at_checked((current - 1) as usize, &ixs)?;
        require_keys_eq!(
            ed_ix.program_id,
            ED25519_PROGRAM_ID,
            RegistryError::MissingEd25519Instruction
        );
        require!(
            ed_ix.accounts.is_empty(),
            RegistryError::InvalidEd25519Instruction
        );
        let parsed = parse_ed25519_ix(&ed_ix.data).map_err(|e| match e {
            Ed25519IxError::Count => error!(RegistryError::InvalidEd25519Instruction),
            Ed25519IxError::ForeignInstruction => error!(RegistryError::Ed25519ForeignOffsets),
            Ed25519IxError::Bounds => error!(RegistryError::InvalidEd25519Instruction),
        })?;
        let signer = Pubkey::new_from_array(parsed.public_key);
        let attestor = config
            .attestors
            .iter()
            .find(|a| a.pubkey == signer)
            .ok_or_else(|| error!(RegistryError::UnknownAttestor))?;
        require!(
            attestor.status == ATTESTOR_ACTIVE,
            RegistryError::AttestorNotActive
        );
        require!(
            attestor.key_id == input.ed25519_key_id,
            RegistryError::KeyIdMismatch
        );

        let fields = input.fields();
        let expected = record_message(&config.key().to_bytes(), &fields);
        require!(
            parsed.message == expected.as_slice(),
            RegistryError::MessageMismatch
        );

        // ---- write (no rollback, no write over a revoked record)
        let record = &mut ctx.accounts.record;
        let created = record.version == 0;
        let previous_level = if created { None } else { Some(record.level) };
        if created {
            record.version = RECORD_VERSION;
            record.bump = ctx.bumps.record;
            record.chain_id = input.chain_id;
            record.address_hash = input.address_hash;
            record.address = input.address.clone();
            record.revoked = false;
            let config = &mut ctx.accounts.config;
            config.record_count = config
                .record_count
                .checked_add(1)
                .ok_or_else(|| error!(RegistryError::Overflow))?;
        } else {
            require!(
                record.version == RECORD_VERSION,
                RegistryError::UnsupportedVersion
            );
            // seeds already bind (chain_id, address_hash); belt and braces:
            require!(
                record.chain_id == input.chain_id && record.address_hash == input.address_hash,
                RegistryError::AddressHashMismatch
            );
            require!(!record.revoked, RegistryError::RecordRevoked);
            require!(
                input.audited_at > record.audited_at,
                RegistryError::StaleRecord
            );
        }
        record.level = input.level;
        record.verdict = input.verdict;
        record.payload_hash = input.payload_hash;
        record.mldsa_key_id = input.mldsa_key_id;
        record.ed25519_key_id = input.ed25519_key_id;
        record.audited_at = input.audited_at;
        record.updated_slot = clock.slot;

        emit!(RecordUpserted {
            record: record.key(),
            chain_id: input.chain_id,
            address_hash: input.address_hash,
            level: input.level,
            previous_level,
            verdict: input.verdict,
            payload_hash: input.payload_hash,
            ed25519_key_id: input.ed25519_key_id,
            audited_at: input.audited_at,
            created,
            relayer: ctx.accounts.payer.key(),
        });
        Ok(())
    }

    /// Authority: marks a record as revoked (e.g. a wrong result, or one signed
    /// by a key later found compromised). A revoked record cannot be updated
    /// until `restore_record`. `reason` is a free code recorded in the event.
    pub fn revoke_record(ctx: Context<RecordAdmin>, reason: u16) -> Result<()> {
        let record = &mut ctx.accounts.record;
        require!(!record.revoked, RegistryError::RecordRevoked);
        record.revoked = true;
        record.updated_slot = Clock::get()?.slot;
        emit!(RecordRevokedEvent {
            record: record.key(),
            chain_id: record.chain_id,
            address_hash: record.address_hash,
            reason
        });
        Ok(())
    }

    /// Authority: lifts a revocation (the next signed audit may then update it).
    pub fn restore_record(ctx: Context<RecordAdmin>) -> Result<()> {
        let record = &mut ctx.accounts.record;
        require!(record.revoked, RegistryError::RecordNotRevoked);
        record.revoked = false;
        record.updated_slot = Clock::get()?.slot;
        emit!(RecordRestored {
            record: record.key(),
            chain_id: record.chain_id,
            address_hash: record.address_hash
        });
        Ok(())
    }

    /// Authority: replaces the attestor list (key rotation). Rules in
    /// `apply_attestors`: at most MAX_ATTESTORS, no duplicates, statuses
    /// active / retired / revoked, and a revoked key can never come back.
    pub fn set_attestors(ctx: Context<Admin>, attestors: Vec<AttestorInput>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        config.attestors = apply_attestors(&config.attestors, &attestors, now)?;
        emit_attestors(config);
        Ok(())
    }

    /// Authority: stops / resumes `upsert_record` (reads and admin calls keep working).
    pub fn set_paused(ctx: Context<Admin>, paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.paused = paused;
        emit!(PausedSet {
            config: config.key(),
            paused
        });
        Ok(())
    }

    /// Authority: step 1 of a two-step authority hand-over (e.g. deployer → Squads vault).
    pub fn propose_authority(ctx: Context<Admin>, new_authority: Option<Pubkey>) -> Result<()> {
        if let Some(a) = new_authority {
            require_keys_neq!(a, Pubkey::default(), RegistryError::InvalidAuthority);
        }
        let config = &mut ctx.accounts.config;
        config.pending_authority = new_authority;
        emit!(AuthorityProposed {
            config: config.key(),
            current: config.authority,
            proposed: new_authority
        });
        Ok(())
    }

    /// The proposed authority accepts (must sign), finishing the hand-over.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let new = ctx.accounts.new_authority.key();
        require!(
            config.pending_authority == Some(new),
            RegistryError::Unauthorized
        );
        let old = config.authority;
        config.authority = new;
        config.pending_authority = None;
        emit!(AuthorityAccepted {
            config: config.key(),
            previous: old,
            authority: new
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------
// Attestor list rules (pure, unit-tested)
// ---------------------------------------------------------------------

pub fn apply_attestors(
    current: &[Attestor],
    wanted: &[AttestorInput],
    now: i64,
) -> Result<Vec<Attestor>> {
    require!(
        wanted.len() <= MAX_ATTESTORS,
        RegistryError::TooManyAttestors
    );
    let mut out: Vec<Attestor> = Vec::with_capacity(wanted.len());
    for w in wanted {
        require_keys_neq!(w.pubkey, Pubkey::default(), RegistryError::InvalidAttestor);
        require!(
            matches!(
                w.status,
                ATTESTOR_ACTIVE | ATTESTOR_RETIRED | ATTESTOR_REVOKED
            ),
            RegistryError::InvalidAttestorStatus
        );
        require!(
            !out.iter().any(|a| a.pubkey == w.pubkey),
            RegistryError::DuplicateAttestor
        );
        let prev = current.iter().find(|a| a.pubkey == w.pubkey);
        if let Some(p) = prev {
            require!(
                !(p.status == ATTESTOR_REVOKED && w.status != ATTESTOR_REVOKED),
                RegistryError::AttestorRevokedForever
            );
        }
        out.push(Attestor {
            pubkey: w.pubkey,
            key_id: key_id_of(w.pubkey.as_ref()),
            status: w.status,
            since: match prev {
                Some(p) if p.status == w.status => p.since,
                _ => now,
            },
        });
    }
    Ok(out)
}

fn emit_attestors(config: &Account<Config>) {
    emit!(AttestorsUpdated {
        config: config.key(),
        pubkeys: config.attestors.iter().map(|a| a.pubkey).collect(),
        statuses: config.attestors.iter().map(|a| a.status).collect(),
    });
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Attestor {
    /// Ed25519 public key (SWD's audit signing key — NOT the memo-anchor fee wallet).
    pub pubkey: Pubkey,
    /// first 8 bytes of sha256(pubkey) = the site's "ed25519-<16 hex>" key id
    pub key_id: [u8; 8],
    /// 1 active (may sign new records), 2 retired (its records stay trusted,
    /// it may not sign new ones), 3 revoked (its records are NOT trusted)
    pub status: u8,
    /// unix time of the last status change
    pub since: i64,
}
impl Attestor {
    pub const SIZE: usize = 32 + 8 + 1 + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AttestorInput {
    pub pubkey: Pubkey,
    pub status: u8,
}

/// Registry settings: one per deployment, PDA ["config"].
#[account]
#[derive(Debug)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    /// may revoke / restore records, rotate attestors, pause (Squads vault on mainnet)
    pub authority: Pubkey,
    pub pending_authority: Option<Pubkey>,
    pub paused: bool,
    /// Records created so far (never decreases; records are never closed)
    pub record_count: u64,
    pub attestors: Vec<Attestor>,
}
impl Config {
    /// 8 discriminator + fields, with room for MAX_ATTESTORS (= 284 bytes).
    pub const SPACE: usize = 8 + 1 + 1 + 32 + (1 + 32) + 1 + 8 + 4 + MAX_ATTESTORS * Attestor::SIZE;
}

/// The latest SWD Audit result of one subject: PDA
/// ["audit", chain_id (u16 LE), sha256(normalized address)].
///
/// Fixed byte offsets (for `getProgramAccounts` memcmp filters and raw reads):
///   0 discriminator(8) · 8 version · 9 bump · 10 chain_id(u16) · 12 level ·
///   13 revoked · 14 address_hash(32) · 46 verdict(32) · 78 payload_hash(32) ·
///   110 mldsa_key_id(8) · 118 ed25519_key_id(8) · 126 audited_at(i64) ·
///   134 updated_slot(u64) · 142 address_len(u32) · 146 address bytes
/// Size = 146 + address length (190 bytes for a 44-character Solana mint).
#[account]
#[derive(Debug)]
pub struct Record {
    pub version: u8,
    pub bump: u8,
    pub chain_id: u16,
    /// 0 info, 1 low, 2 medium, 3 high
    pub level: u8,
    pub revoked: bool,
    pub address_hash: [u8; 32],
    pub verdict: [u8; 32],
    pub payload_hash: [u8; 32],
    pub mldsa_key_id: [u8; 8],
    pub ed25519_key_id: [u8; 8],
    pub audited_at: i64,
    pub updated_slot: u64,
    pub address: Vec<u8>,
}
impl Record {
    pub const FIXED: usize = 8 + 1 + 1 + 2 + 1 + 1 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 4;
    pub const fn space(address_len: usize) -> usize {
        Self::FIXED + address_len
    }
    pub const OFFSET_CHAIN_ID: usize = 10;
    pub const OFFSET_LEVEL: usize = 12;
    pub const OFFSET_REVOKED: usize = 13;
    pub const OFFSET_ADDRESS_HASH: usize = 14;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecordInput {
    pub chain_id: u16,
    pub address_hash: [u8; 32],
    pub address: Vec<u8>,
    pub level: u8,
    pub verdict: [u8; 32],
    pub payload_hash: [u8; 32],
    pub mldsa_key_id: [u8; 8],
    pub ed25519_key_id: [u8; 8],
    pub audited_at: i64,
}
impl RecordInput {
    pub fn fields(&self) -> RecordFields {
        RecordFields {
            chain_id: self.chain_id,
            address_hash: self.address_hash,
            level: self.level,
            verdict: self.verdict,
            payload_hash: self.payload_hash,
            mldsa_key_id: self.mldsa_key_id,
            ed25519_key_id: self.ed25519_key_id,
            audited_at: self.audited_at,
        }
    }
}

pub fn config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID)
}

pub fn record_pda(chain_id: u16, address: &[u8]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[RECORD_SEED, &chain_id.to_le_bytes(), &address_hash(address)],
        &crate::ID,
    )
}

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = Config::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// This program's ProgramData; its upgrade authority must be `payer`.
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(input: RecordInput)]
pub struct UpsertRecord<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    // init_if_needed is safe here: the PDA is owned by this program once
    // created, `version != 0` marks an existing record (the update branch
    // never re-sets chain/address/bump), and the space is a pure function of
    // the address, which the seeds pin.
    #[account(
        init_if_needed,
        payer = payer,
        space = Record::space(input.address.len()),
        seeds = [RECORD_SEED, &input.chain_id.to_le_bytes(), &input.address_hash],
        bump
    )]
    pub record: Account<'info, Record>,
    /// Pays rent for a new record (the relayer). Gets no rights over it.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the instructions sysvar (address-checked), read for the Ed25519 instruction.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordAdmin<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [RECORD_SEED, &record.chain_id.to_le_bytes(), &record.address_hash],
        bump = record.bump
    )]
    pub record: Account<'info, Record>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub new_authority: Signer<'info>,
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------

#[event]
pub struct RegistryInitialized {
    pub config: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct AttestorsUpdated {
    pub config: Pubkey,
    pub pubkeys: Vec<Pubkey>,
    pub statuses: Vec<u8>,
}

#[event]
pub struct RecordUpserted {
    pub record: Pubkey,
    pub chain_id: u16,
    pub address_hash: [u8; 32],
    pub level: u8,
    pub previous_level: Option<u8>,
    pub verdict: [u8; 32],
    pub payload_hash: [u8; 32],
    pub ed25519_key_id: [u8; 8],
    pub audited_at: i64,
    pub created: bool,
    pub relayer: Pubkey,
}

#[event]
pub struct RecordRevokedEvent {
    pub record: Pubkey,
    pub chain_id: u16,
    pub address_hash: [u8; 32],
    pub reason: u16,
}

#[event]
pub struct RecordRestored {
    pub record: Pubkey,
    pub chain_id: u16,
    pub address_hash: [u8; 32],
}

#[event]
pub struct PausedSet {
    pub config: Pubkey,
    pub paused: bool,
}

#[event]
pub struct AuthorityProposed {
    pub config: Pubkey,
    pub current: Pubkey,
    pub proposed: Option<Pubkey>,
}

#[event]
pub struct AuthorityAccepted {
    pub config: Pubkey,
    pub previous: Pubkey,
    pub authority: Pubkey,
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

#[error_code]
pub enum RegistryError {
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Authority must be a real public key")]
    InvalidAuthority,
    #[msg("The registry is paused")]
    Paused,
    #[msg("Unknown chain id")]
    UnknownChain,
    #[msg("Address is empty")]
    AddressEmpty,
    #[msg("Address is longer than 200 bytes")]
    AddressTooLong,
    #[msg("Address is not in the chain's normalized form")]
    AddressFormat,
    #[msg("address_hash is not sha256(address)")]
    AddressHashMismatch,
    #[msg("Level must be 0 (info) to 3 (high)")]
    InvalidLevel,
    #[msg("audited_at must be a positive unix time")]
    InvalidTimestamp,
    #[msg("audited_at is in the future")]
    TimestampInFuture,
    #[msg("The instruction before upsert_record must be an Ed25519 signature check")]
    MissingEd25519Instruction,
    #[msg("Malformed Ed25519 instruction (exactly one signature expected)")]
    InvalidEd25519Instruction,
    #[msg("Ed25519 instruction reads data from another instruction")]
    Ed25519ForeignOffsets,
    #[msg("Signing key is not a registry attestor")]
    UnknownAttestor,
    #[msg("Signing key is retired or revoked")]
    AttestorNotActive,
    #[msg("ed25519_key_id does not match the signing key")]
    KeyIdMismatch,
    #[msg("Signed message does not match the record")]
    MessageMismatch,
    #[msg("audited_at is not newer than the stored record (no rollback)")]
    StaleRecord,
    #[msg("Record is revoked")]
    RecordRevoked,
    #[msg("Record is not revoked")]
    RecordNotRevoked,
    #[msg("Unsupported account version")]
    UnsupportedVersion,
    #[msg("Too many attestors")]
    TooManyAttestors,
    #[msg("Attestor must be a real public key")]
    InvalidAttestor,
    #[msg("Attestor status must be 1 (active), 2 (retired) or 3 (revoked)")]
    InvalidAttestorStatus,
    #[msg("Attestor listed twice")]
    DuplicateAttestor,
    #[msg("A revoked attestor key cannot be reinstated")]
    AttestorRevokedForever,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Account is not the SWD Audit Registry config")]
    NotRegistryConfig,
    #[msg("Account is not the SWD Audit Registry record for this subject")]
    NotRegistryRecord,
}

#[cfg(test)]
mod tests;
