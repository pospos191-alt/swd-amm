// Unit tests: message layout, seeds, account sizes, the Ed25519 instruction
// parser, the attestor rules and the reader. `cargo test -p swd_audit_registry`.
// The on-chain flow (precompile + sysvar + accounts) is in tests/swd_audit_registry.ts.

use super::*;
use crate::reader::evaluate;
use anchor_lang::Discriminator;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn sample_fields() -> RecordFields {
    RecordFields {
        chain_id: 6,
        address_hash: address_hash(b"So11111111111111111111111111111111111111112"),
        level: LEVEL_HIGH,
        verdict: [0xab; 32],
        payload_hash: [0xcd; 32],
        mldsa_key_id: [1, 2, 3, 4, 5, 6, 7, 8],
        ed25519_key_id: [9, 10, 11, 12, 13, 14, 15, 16],
        audited_at: 1_793_000_000,
    }
}

/// Golden vector shared with tests/swd_audit_registry.ts (`GOLDEN_MESSAGE_HEX`):
/// registry = 32 × 0x11, fields = sample_fields(). If this changes, every
/// relayer's encoder must change with it.
pub const GOLDEN_MESSAGE_HEX: &str = concat!(
    "7377642e61756469742d72656769737472792e763100",
    "1111111111111111111111111111111111111111111111111111111111111111",
    "0600",
    "d77cf5c8a1c79d6b78408a3f545dea88441790fb0245268398f1d09455e29b18", // sha256("So111…112")
    "03",
    "abababababababababababababababababababababababababababababababab",
    "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    "0102030405060708",
    "090a0b0c0d0e0f10",
    "4002df6a00000000",
);

#[test]
fn message_layout() {
    let f = sample_fields();
    let m = record_message(&[0x11; 32], &f);
    assert_eq!(m.len(), RECORD_MESSAGE_LEN);
    assert_eq!(&m[0..22], DOMAIN_TAG);
    assert_eq!(&m[22..54], &[0x11; 32]);
    assert_eq!(&m[54..56], &6u16.to_le_bytes());
    assert_eq!(&m[56..88], &f.address_hash);
    assert_eq!(m[88], LEVEL_HIGH);
    assert_eq!(&m[89..121], &[0xab; 32]);
    assert_eq!(&m[121..153], &[0xcd; 32]);
    assert_eq!(&m[153..161], &f.mldsa_key_id);
    assert_eq!(&m[161..169], &f.ed25519_key_id);
    assert_eq!(&m[169..177], &1_793_000_000i64.to_le_bytes());
}

#[test]
fn message_golden_vector() {
    let m = record_message(&[0x11; 32], &sample_fields());
    assert_eq!(hex(&m), GOLDEN_MESSAGE_HEX);
}

#[test]
fn every_field_changes_the_message() {
    let base = record_message(&[0x11; 32], &sample_fields());
    let mut variants = vec![];
    let mut f = sample_fields();
    f.chain_id = 7;
    variants.push(f);
    let mut f = sample_fields();
    f.address_hash[0] ^= 1;
    variants.push(f);
    let mut f = sample_fields();
    f.level = LEVEL_LOW;
    variants.push(f);
    let mut f = sample_fields();
    f.verdict[31] ^= 1;
    variants.push(f);
    let mut f = sample_fields();
    f.payload_hash[0] ^= 1;
    variants.push(f);
    let mut f = sample_fields();
    f.mldsa_key_id[0] ^= 1;
    variants.push(f);
    let mut f = sample_fields();
    f.ed25519_key_id[7] ^= 1;
    variants.push(f);
    let mut f = sample_fields();
    f.audited_at += 1;
    variants.push(f);
    for v in variants {
        assert_ne!(record_message(&[0x11; 32], &v), base);
    }
    // another deployment (registry) -> another message
    assert_ne!(record_message(&[0x12; 32], &sample_fields()), base);
}

#[test]
fn domain_tag_cannot_be_an_attestation_message() {
    let att = b"swd.audit-attestation.v1\n";
    assert_ne!(&DOMAIN_TAG[..], &att[..DOMAIN_TAG.len()]);
    assert_eq!(DOMAIN_TAG.len(), 22);
    assert_eq!(*DOMAIN_TAG.last().unwrap(), 0);
}

#[test]
fn key_id_matches_site_format() {
    // site: keyIdOf = "<alg>-" + first 16 hex of sha256(publicKey)
    assert_eq!(hex(&key_id_of(b"")), "e3b0c44298fc1c14");
    assert_eq!(hex(&key_id_of(b"abc")), "ba7816bf8f01cfea");
    assert_eq!(
        hex(&address_hash(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn chain_table() {
    assert_eq!(CHAINS.len(), 14);
    for (i, (id, _)) in CHAINS.iter().enumerate() {
        assert_eq!(*id as usize, i + 1, "ids are 1..=14 in order");
    }
    let mut names: Vec<_> = CHAINS.iter().map(|(_, n)| *n).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), 14);
    assert_eq!(chain_id_of("sol"), Some(6));
    assert_eq!(chain_id_of("eth"), Some(1));
    assert_eq!(chain_id_of("ton"), Some(14));
    assert_eq!(chain_name(0), None);
    assert_eq!(chain_name(15), None);
}

#[test]
fn addresses() {
    let evm = b"0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
    assert_eq!(check_address(1, evm), Ok(()));
    assert_eq!(check_address(5, evm), Ok(()));
    assert_eq!(
        check_address(1, b"0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"),
        Err(AddressError::Format)
    );
    assert_eq!(check_address(1, b"0x5c69"), Err(AddressError::Format));
    assert_eq!(
        check_address(1, b"5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f00"),
        Err(AddressError::Format)
    );
    assert_eq!(
        check_address(6, b"So11111111111111111111111111111111111111112"),
        Ok(())
    );
    assert_eq!(
        check_address(6, b"So1111111111111111111111111111111111111111O"),
        Err(AddressError::Format)
    );
    assert_eq!(check_address(6, b"short"), Err(AddressError::Format));
    assert_eq!(check_address(7, b"0x2::sui::SUI"), Ok(()));
    assert_eq!(check_address(9, b"factory/osmo1abc/uname"), Ok(()));
    assert_eq!(
        check_address(13, b"UNCOMMON GOODS"),
        Err(AddressError::Format)
    ); // site sends the id form
    assert_eq!(check_address(13, b"840000:3"), Ok(()));
    assert_eq!(check_address(11, b""), Err(AddressError::Empty));
    assert_eq!(check_address(11, &[b'a'; MAX_ADDRESS_LEN]), Ok(()));
    assert_eq!(
        check_address(11, &[b'a'; MAX_ADDRESS_LEN + 1]),
        Err(AddressError::TooLong)
    );
    assert_eq!(
        check_address(14, "EQ\u{e9}".as_bytes()),
        Err(AddressError::Format)
    );
}

#[test]
fn ed25519_ix_roundtrip() {
    let pk = [7u8; 32];
    let sig = [9u8; 64];
    let msg = record_message(&[0x11; 32], &sample_fields());
    let d = build_ed25519_ix_data(&pk, &sig, &msg);
    // same layout as @solana/web3.js Ed25519Program: 16-byte header, pk at 16, sig at 48, msg at 112
    assert_eq!(d.len(), 112 + RECORD_MESSAGE_LEN);
    assert_eq!(&d[16..48], &pk);
    let p = parse_ed25519_ix(&d).unwrap();
    assert_eq!(p.public_key, pk);
    assert_eq!(p.signature, sig);
    assert_eq!(p.message, &msg[..]);
}

fn set_u16(d: &mut [u8], at: usize, v: u16) {
    d[at..at + 2].copy_from_slice(&v.to_le_bytes());
}

#[test]
fn ed25519_ix_rejects() {
    let msg = record_message(&[0x11; 32], &sample_fields());
    let good = build_ed25519_ix_data(&[7; 32], &[9; 64], &msg);
    // signature count
    for n in [0u8, 2] {
        let mut d = good.clone();
        d[0] = n;
        assert_eq!(parse_ed25519_ix(&d), Err(Ed25519IxError::Count));
    }
    // any part read from another instruction
    for field in [4usize, 8, 14] {
        let mut d = good.clone();
        set_u16(&mut d, field, 0);
        assert_eq!(
            parse_ed25519_ix(&d),
            Err(Ed25519IxError::ForeignInstruction),
            "field {field}"
        );
    }
    // out of bounds offsets / sizes
    let mut d = good.clone();
    set_u16(&mut d, 2, u16::MAX); // signature_offset
    assert_eq!(parse_ed25519_ix(&d), Err(Ed25519IxError::Bounds));
    let mut d = good.clone();
    set_u16(&mut d, 12, (RECORD_MESSAGE_LEN + 1) as u16); // message size
    assert_eq!(parse_ed25519_ix(&d), Err(Ed25519IxError::Bounds));
    assert_eq!(parse_ed25519_ix(&good[..10]), Err(Ed25519IxError::Bounds));
    // a shorter message parses but is then != the expected record bytes
    let mut d = good.clone();
    set_u16(&mut d, 12, 100);
    assert_ne!(parse_ed25519_ix(&d).unwrap().message, &msg[..]);
}

#[test]
fn pdas() {
    let addr = b"So11111111111111111111111111111111111111112";
    let (a, _) = record_pda(6, addr);
    let (b, _) = Pubkey::find_program_address(
        &[b"audit", &6u16.to_le_bytes(), &address_hash(addr)],
        &crate::ID,
    );
    assert_eq!(a, b);
    assert_ne!(record_pda(6, addr).0, record_pda(7, addr).0);
    assert_ne!(record_pda(1, b"0xaa").0, record_pda(1, b"0xab").0);
    let (c, _) = config_pda();
    assert_eq!(c, Pubkey::find_program_address(&[b"config"], &crate::ID).0);
}

fn sample_record(address: &[u8]) -> Record {
    Record {
        version: RECORD_VERSION,
        bump: 254,
        chain_id: 6,
        level: LEVEL_MEDIUM,
        revoked: false,
        address_hash: address_hash(address),
        verdict: [0xab; 32],
        payload_hash: [0xcd; 32],
        mldsa_key_id: [1; 8],
        ed25519_key_id: key_id_of(&[5; 32]),
        audited_at: 1_793_000_000,
        updated_slot: 42,
        address: address.to_vec(),
    }
}

fn account_bytes<T: AnchorSerialize + Discriminator>(v: &T) -> Vec<u8> {
    let mut out = T::DISCRIMINATOR.to_vec();
    v.serialize(&mut out).unwrap();
    out
}

#[test]
fn record_size_and_offsets() {
    let addr = b"So11111111111111111111111111111111111111112";
    let r = sample_record(addr);
    let bytes = account_bytes(&r);
    assert_eq!(Record::FIXED, 146);
    assert_eq!(bytes.len(), Record::space(addr.len()));
    assert_eq!(Record::space(44), 190);
    assert_eq!(Record::space(MAX_ADDRESS_LEN), 346);
    assert_eq!(
        &bytes[Record::OFFSET_CHAIN_ID..Record::OFFSET_CHAIN_ID + 2],
        &6u16.to_le_bytes()
    );
    assert_eq!(bytes[Record::OFFSET_LEVEL], LEVEL_MEDIUM);
    assert_eq!(bytes[Record::OFFSET_REVOKED], 0);
    assert_eq!(
        &bytes[Record::OFFSET_ADDRESS_HASH..Record::OFFSET_ADDRESS_HASH + 32],
        &r.address_hash
    );
    assert_eq!(&bytes[46..78], &[0xab; 32]);
    assert_eq!(&bytes[78..110], &[0xcd; 32]);
    assert_eq!(&bytes[126..134], &1_793_000_000i64.to_le_bytes());
    assert_eq!(&bytes[134..142], &42u64.to_le_bytes());
    assert_eq!(&bytes[142..146], &(addr.len() as u32).to_le_bytes());
    assert_eq!(&bytes[146..], addr);
}

#[test]
fn rent_estimate() {
    // Rent-exempt minimum = (128 + data_len) * 3480 lamports/byte-year * 2 years
    // (the cluster default; docs/SWD_AUDIT_REGISTRY.md "Costs").
    let rent = |len: usize| (128 + len as u64) * 3480 * 2;
    assert_eq!(rent(Record::space(44)), 2_213_280); // ~0.0022 SOL
    assert_eq!(rent(Record::space(42)), 2_199_360);
    assert_eq!(rent(Record::space(MAX_ADDRESS_LEN)), 3_299_040);
    assert_eq!(rent(Config::SPACE), 2_867_520);
}

fn attestor(pk: u8, status: u8) -> AttestorInput {
    AttestorInput {
        pubkey: Pubkey::new_from_array([pk; 32]),
        status,
    }
}

#[test]
fn config_space_fits_max() {
    let c = Config {
        version: 1,
        bump: 255,
        authority: Pubkey::new_unique(),
        pending_authority: Some(Pubkey::new_unique()),
        paused: true,
        record_count: u64::MAX,
        attestors: apply_attestors(
            &[],
            &[
                attestor(1, 1),
                attestor(2, 1),
                attestor(3, 2),
                attestor(4, 3),
            ],
            1,
        )
        .unwrap(),
    };
    assert_eq!(account_bytes(&c).len(), Config::SPACE);
    assert_eq!(Config::SPACE, 284);
}

#[test]
fn attestor_rules() {
    let list = apply_attestors(&[], &[attestor(1, ATTESTOR_ACTIVE)], 100).unwrap();
    assert_eq!(list[0].key_id, key_id_of(&[1; 32]));
    assert_eq!(list[0].since, 100);
    // rotation: old key retired, new one active; unchanged status keeps `since`
    let rotated = apply_attestors(
        &list,
        &[attestor(1, ATTESTOR_RETIRED), attestor(2, ATTESTOR_ACTIVE)],
        200,
    )
    .unwrap();
    assert_eq!(rotated[0].since, 200);
    let again = apply_attestors(
        &rotated,
        &[attestor(1, ATTESTOR_RETIRED), attestor(2, ATTESTOR_ACTIVE)],
        300,
    )
    .unwrap();
    assert_eq!(again[0].since, 200);
    // revoked is final
    let revoked = apply_attestors(
        &again,
        &[attestor(1, ATTESTOR_REVOKED), attestor(2, ATTESTOR_ACTIVE)],
        400,
    )
    .unwrap();
    assert!(apply_attestors(&revoked, &[attestor(1, ATTESTOR_ACTIVE)], 500).is_err());
    assert!(apply_attestors(&revoked, &[attestor(1, ATTESTOR_RETIRED)], 500).is_err());
    assert!(apply_attestors(&revoked, &[attestor(1, ATTESTOR_REVOKED)], 500).is_ok());
    // shape
    assert!(apply_attestors(&[], &[attestor(1, 1), attestor(1, 2)], 1).is_err());
    assert!(apply_attestors(&[], &[attestor(1, 0)], 1).is_err());
    assert!(apply_attestors(&[], &[attestor(1, 4)], 1).is_err());
    assert!(apply_attestors(&[], &[attestor(0, 1)], 1).is_err());
    assert!(apply_attestors(&[], &(1..=5).map(|i| attestor(i, 1)).collect::<Vec<_>>(), 1).is_err());
    assert!(apply_attestors(&[], &[], 1).unwrap().is_empty());
}

#[test]
fn reader_evaluate() {
    let addr = b"So11111111111111111111111111111111111111112";
    let mut config = Config {
        version: 1,
        bump: 255,
        authority: Pubkey::new_unique(),
        pending_authority: None,
        paused: false,
        record_count: 1,
        attestors: apply_attestors(&[], &[attestor(5, ATTESTOR_ACTIVE)], 1).unwrap(),
    };
    let mut r = sample_record(addr);
    assert_eq!(evaluate(&config, &r), Some(LEVEL_MEDIUM));
    config.attestors[0].status = ATTESTOR_RETIRED;
    assert_eq!(
        evaluate(&config, &r),
        Some(LEVEL_MEDIUM),
        "a retired key's records stay valid"
    );
    config.attestors[0].status = ATTESTOR_REVOKED;
    assert_eq!(
        evaluate(&config, &r),
        None,
        "a revoked key's records are not trusted"
    );
    config.attestors[0].status = ATTESTOR_ACTIVE;
    r.revoked = true;
    assert_eq!(evaluate(&config, &r), None);
    r.revoked = false;
    config.attestors.clear();
    assert_eq!(evaluate(&config, &r), None, "an unknown key is not trusted");
}

#[test]
fn reader_accounts() {
    let addr = b"So11111111111111111111111111111111111111112";
    let (pda, _) = record_pda(6, addr);
    let program = crate::ID;
    let system = anchor_lang::solana_program::system_program::ID;
    let mut lamports = 0u64;
    let mut empty: Vec<u8> = vec![];

    // never written: the right PDA, owned by the system program, no data -> None
    let info = AccountInfo::new(
        &pda,
        false,
        false,
        &mut lamports,
        &mut empty,
        &system,
        false,
        0,
    );
    assert!(reader::load_record(&info, 6, addr).unwrap().is_none());
    // the wrong subject's PDA -> error, never "no record"
    assert!(reader::load_record(&info, 7, addr).is_err());

    // a real record
    let mut data = account_bytes(&sample_record(addr));
    let mut lamports2 = 1u64;
    let info = AccountInfo::new(
        &pda,
        false,
        false,
        &mut lamports2,
        &mut data,
        &program,
        false,
        0,
    );
    assert_eq!(
        reader::load_record(&info, 6, addr).unwrap().unwrap().level,
        LEVEL_MEDIUM
    );

    // same address, but owned by another program -> error
    let other = Pubkey::new_unique();
    let mut data2 = account_bytes(&sample_record(addr));
    let mut lamports3 = 1u64;
    let info = AccountInfo::new(
        &pda,
        false,
        false,
        &mut lamports3,
        &mut data2,
        &other,
        false,
        0,
    );
    assert!(reader::load_record(&info, 6, addr).is_err());

    // a Config where a Record should be -> error (discriminator)
    let cfg = Config {
        version: 1,
        bump: 255,
        authority: Pubkey::new_unique(),
        pending_authority: None,
        paused: false,
        record_count: 0,
        attestors: vec![],
    };
    let mut data3 = account_bytes(&cfg);
    let mut lamports4 = 1u64;
    let info = AccountInfo::new(
        &pda,
        false,
        false,
        &mut lamports4,
        &mut data3,
        &program,
        false,
        0,
    );
    assert!(reader::load_record(&info, 6, addr).is_err());

    // config: wrong address -> error; right address -> ok
    let (cpda, _) = config_pda();
    let mut data4 = account_bytes(&cfg);
    let mut lamports5 = 1u64;
    let info = AccountInfo::new(
        &cpda,
        false,
        false,
        &mut lamports5,
        &mut data4,
        &program,
        false,
        0,
    );
    assert!(reader::load_config(&info).is_ok());
    let wrong = Pubkey::new_unique();
    let mut data5 = account_bytes(&cfg);
    let mut lamports6 = 1u64;
    let info = AccountInfo::new(
        &wrong,
        false,
        false,
        &mut lamports6,
        &mut data5,
        &program,
        false,
        0,
    );
    assert!(reader::load_config(&info).is_err());
}

#[test]
fn record_input_fields_roundtrip() {
    let f = sample_fields();
    let input = RecordInput {
        chain_id: f.chain_id,
        address_hash: f.address_hash,
        address: b"So11111111111111111111111111111111111111112".to_vec(),
        level: f.level,
        verdict: f.verdict,
        payload_hash: f.payload_hash,
        mldsa_key_id: f.mldsa_key_id,
        ed25519_key_id: f.ed25519_key_id,
        audited_at: f.audited_at,
    };
    assert_eq!(input.fields(), f);
}
