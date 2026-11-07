#![cfg(feature = "registry")]
use swd_sdk::registry::*;
use swd_sdk::{Level, SWD_MINT};

fn program() -> Pubkey {
    pubkey_from_str(DRAFT_PROGRAM_ID).unwrap()
}

// Reference values from @solana/web3.js PublicKey.findProgramAddressSync with the draft program id.
#[test]
fn pdas_match_solana() {
    let (c, cb) = config_pda(&program()).unwrap();
    assert_eq!(pubkey_to_string(&c), "EBKtNk8NmGxGifCnGE3MPmg1XzcuZRXHcPneAozhng6Y");
    assert_eq!(cb, 255);
    let (r, rb) = record_pda(&program(), 6, SWD_MINT).unwrap();
    assert_eq!(pubkey_to_string(&r), "B64YynvcWx2WpF9MFaiCygT7oPBEymmNTmkSnqrtVrnQ");
    assert_eq!(rb, 255);
    // EVM: checksummed spelling normalizes to the lowercase record
    let (e, eb) = record_pda(&program(), 1, "0xdAC17F958D2ee523a2206206994597C13D831ec7").unwrap();
    assert_eq!(pubkey_to_string(&e), "3FVPoQkmP5eczbLJrTqQDCx4yR7kRFo112Bak44BZ7AF");
    assert_eq!(eb, 254);
    assert!(record_pda(&program(), 99, "x").is_err());
    assert_eq!(chain_id_of("sol"), Some(6));
    assert_eq!(chain_name_of(14), Some("ton"));
}

fn record_bytes(level: u8, revoked: u8, key_id: [u8; 8], address: &str) -> Vec<u8> {
    let mut d = RECORD_DISCRIMINATOR.to_vec();
    d.push(1); // version
    d.push(254); // bump
    d.extend_from_slice(&6u16.to_le_bytes());
    d.push(level);
    d.push(revoked);
    d.extend_from_slice(&address_hash(address.as_bytes()));
    d.extend_from_slice(&[0xbb; 32]); // verdict
    d.extend_from_slice(&[0xcc; 32]); // payload hash
    d.extend_from_slice(&[0x11; 8]); // mldsa key id
    d.extend_from_slice(&key_id);
    d.extend_from_slice(&1_762_473_600i64.to_le_bytes());
    d.extend_from_slice(&42u64.to_le_bytes());
    d.extend_from_slice(&(address.len() as u32).to_le_bytes());
    d.extend_from_slice(address.as_bytes());
    d
}

fn config_bytes(attestors: &[([u8; 8], u8)], pending: bool) -> Vec<u8> {
    let mut d = CONFIG_DISCRIMINATOR.to_vec();
    d.extend_from_slice(&[1, 255]);
    d.extend_from_slice(&[7; 32]);
    if pending {
        d.push(1);
        d.extend_from_slice(&[8; 32]);
    } else {
        d.push(0);
    }
    d.push(0); // paused
    d.extend_from_slice(&3u64.to_le_bytes());
    d.extend_from_slice(&(attestors.len() as u32).to_le_bytes());
    for (id, status) in attestors {
        d.extend_from_slice(&[9; 32]);
        d.extend_from_slice(id);
        d.push(*status);
        d.extend_from_slice(&100i64.to_le_bytes());
    }
    d.resize(284, 0); // the account is allocated for 4 attestors
    d
}

#[test]
fn record_layout() {
    let d = record_bytes(3, 0, [0x22; 8], SWD_MINT);
    assert_eq!(d.len(), 190, "146 + 44 for a Solana mint");
    let r = Record::parse(&d).unwrap();
    assert_eq!(r.level, Level::High);
    assert!(!r.revoked);
    assert_eq!(r.chain_id, 6);
    assert_eq!(r.address, SWD_MINT);
    assert_eq!(r.audited_at, 1_762_473_600);
    assert_eq!(r.updated_slot, 42);
    assert_eq!(r.ed25519_key_id_str(), "ed25519-2222222222222222");
    assert_eq!(r.payload_hash_hex(), format!("0x{}", "cc".repeat(32)));

    let mut bad = d.clone();
    bad[0] ^= 1;
    assert!(Record::parse(&bad).is_err(), "discriminator");
    let mut bad = d.clone();
    bad[12] = 4;
    assert!(Record::parse(&bad).is_err(), "level");
    let mut bad = d.clone();
    bad[20] ^= 1;
    assert!(Record::parse(&bad).is_err(), "address hash");
    assert!(Record::parse(&d[..150]).is_err(), "truncated");
}

#[test]
fn config_layout_and_trust() {
    let c = Config::parse(&config_bytes(&[([0x22; 8], ATTESTOR_ACTIVE), ([0x33; 8], ATTESTOR_RETIRED), ([0x44; 8], ATTESTOR_REVOKED)], true)).unwrap();
    assert_eq!(c.attestors.len(), 3);
    assert_eq!(c.pending_authority, Some([8; 32]));
    assert_eq!(c.record_count, 3);
    let c0 = Config::parse(&config_bytes(&[], false)).unwrap();
    assert!(c0.pending_authority.is_none() && c0.attestors.is_empty());

    let rec = |id, revoked| Record::parse(&record_bytes(1, revoked, id, SWD_MINT)).unwrap();
    assert_eq!(evaluate(&c, &rec([0x22; 8], 0)), Some(Level::Low), "active key");
    assert_eq!(evaluate(&c, &rec([0x33; 8], 0)), Some(Level::Low), "retired key: its records stay trusted");
    assert_eq!(evaluate(&c, &rec([0x44; 8], 0)), None, "revoked key");
    assert_eq!(evaluate(&c, &rec([0x55; 8], 0)), None, "unknown key");
    assert_eq!(evaluate(&c, &rec([0x22; 8], 1)), None, "revoked record");
}

#[test]
fn decide_from_accounts() {
    let p = program();
    let cfg = Account { owner: p, data: config_bytes(&[([0x22; 8], ATTESTOR_ACTIVE)], false) };
    let rec = Account { owner: p, data: record_bytes(2, 0, [0x22; 8], SWD_MINT) };
    assert!(matches!(decide(&p, Some(cfg.clone()), Some(rec.clone())), Ok(Lookup::Trusted(r)) if r.level == Level::Medium));
    assert_eq!(decide(&p, Some(cfg.clone()), None), Ok(Lookup::NotFound));
    let empty_system = Account { owner: [0; 32], data: vec![] };
    assert_eq!(decide(&p, Some(cfg.clone()), Some(empty_system)), Ok(Lookup::NotFound));
    let forged = Account { owner: [5; 32], data: rec.data.clone() };
    assert!(decide(&p, Some(cfg.clone()), Some(forged)).is_err(), "a forged account is an error, never 'no record'");
    let forged_cfg = Account { owner: [5; 32], data: cfg.data.clone() };
    assert!(decide(&p, Some(forged_cfg), Some(rec)).is_err());
}
