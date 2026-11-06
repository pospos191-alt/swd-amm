// Reading a record from another program (CPI-free: a plain account read).
//
//   [dependencies]
//   swd_audit_registry = { path = "...", features = ["cpi"] }
//
//   let level = swd_audit_registry::reader::trusted_level(
//       &ctx.accounts.audit_config, &ctx.accounts.audit_record, CHAIN_SOL, mint.key().to_string().as_bytes())?;
//   if let Some(l) = level { require!(l < LEVEL_HIGH, MyError::RiskyToken); }
//
// `trusted_level` returns:
//   Ok(None)        no record (account not created yet), the record is revoked,
//                   or its signing key is no longer trusted (revoked / removed);
//   Ok(Some(level)) a valid, trusted record;
//   Err(..)         the accounts passed are not the registry's (wrong owner,
//                   wrong PDA, bad data) — a caller must never treat a forged
//                   account as "no record".
// Whether "no record" means allow or block is the caller's policy (a DEX that
// wants to block only known-high tokens allows None; a strict one blocks it).

use crate::message::address_hash;
use crate::{
    Config, Record, RegistryError as ReaderError, ATTESTOR_ACTIVE, ATTESTOR_RETIRED, CONFIG_SEED,
    RECORD_SEED,
};
use anchor_lang::prelude::*;

/// Pure decision: the level a reader should trust, given both accounts' data.
pub fn evaluate(config: &Config, record: &Record) -> Option<u8> {
    if record.revoked {
        return None;
    }
    let signer = config
        .attestors
        .iter()
        .find(|a| a.key_id == record.ed25519_key_id)?;
    if signer.status == ATTESTOR_ACTIVE || signer.status == ATTESTOR_RETIRED {
        Some(record.level)
    } else {
        None
    }
}

pub fn load_config(info: &AccountInfo) -> Result<Config> {
    let (pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID);
    if *info.key != pda || *info.owner != crate::ID {
        return err!(ReaderError::NotRegistryConfig);
    }
    let data = info.try_borrow_data()?;
    Config::try_deserialize(&mut &data[..]).map_err(|_| error!(ReaderError::NotRegistryConfig))
}

/// The record of (chain_id, address), or None if it was never written.
pub fn load_record(info: &AccountInfo, chain_id: u16, address: &[u8]) -> Result<Option<Record>> {
    let (pda, _) = Pubkey::find_program_address(
        &[RECORD_SEED, &chain_id.to_le_bytes(), &address_hash(address)],
        &crate::ID,
    );
    if *info.key != pda {
        return err!(ReaderError::NotRegistryRecord);
    }
    // the right address but never created: owned by the system program, empty
    if *info.owner != crate::ID {
        if info.data_is_empty() {
            return Ok(None);
        }
        return err!(ReaderError::NotRegistryRecord);
    }
    let data = info.try_borrow_data()?;
    let r = Record::try_deserialize(&mut &data[..])
        .map_err(|_| error!(ReaderError::NotRegistryRecord))?;
    Ok(Some(r))
}

pub fn trusted_level(
    config: &AccountInfo,
    record: &AccountInfo,
    chain_id: u16,
    address: &[u8],
) -> Result<Option<u8>> {
    let c = load_config(config)?;
    Ok(load_record(record, chain_id, address)?.and_then(|r| evaluate(&c, &r)))
}
