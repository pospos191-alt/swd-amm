// The bytes an SWD audit key signs for the registry, the address rules, and
// the Ed25519 precompile instruction parser. Pure functions (no accounts, no
// syscalls besides sha256), so `cargo test -p swd_audit_registry` covers them.
//
// RECORD MESSAGE (177 bytes, every integer little-endian):
//
//   off len field
//     0  22 DOMAIN_TAG       b"swd.audit-registry.v1\0"
//    22  32 registry         the Config PDA of THIS deployment (binds program id
//                            + cluster: a devnet signature cannot be replayed on
//                            mainnet, nor into another copy of the program)
//    54   2 chain_id         u16 (see `chain_name`)
//    56  32 address_hash     sha256(normalized address bytes)
//    88   1 level            0 info, 1 low, 2 medium, 3 high
//    89  32 verdict          Neuro verdict id (32 bytes)
//   121  32 payload_hash     the attestation's payloadHash (sha256 of its
//                            canonical JSON payload)
//   153   8 mldsa_key_id     first 8 bytes of sha256(ML-DSA-44 public key)
//   161   8 ed25519_key_id   first 8 bytes of sha256(Ed25519 public key)
//   169   8 audited_at       i64 unix seconds (the payload's observedAt)
//   177
//
// The tag differs from the attestation message ("swd.audit-attestation.v1\n…")
// at byte 10, so a registry signature can never be read as an attestation
// signature or the other way round.

use anchor_lang::solana_program::hash::hash as sha256;

pub const DOMAIN_TAG: &[u8; 22] = b"swd.audit-registry.v1\0";
pub const RECORD_MESSAGE_LEN: usize = 177;

/// A key id is the first 8 bytes of sha256(public key) — the site writes it as
/// `"<alg>-" + 16 hex` (lib/audit/attest-core.ts `keyIdOf`).
pub const KEY_ID_LEN: usize = 8;
pub type KeyId = [u8; KEY_ID_LEN];

/// Longest address accepted (the site's `checkPayload` caps `subject` at 200).
pub const MAX_ADDRESS_LEN: usize = 200;

pub const LEVEL_INFO: u8 = 0;
pub const LEVEL_LOW: u8 = 1;
pub const LEVEL_MEDIUM: u8 = 2;
pub const LEVEL_HIGH: u8 = 3;

/// The 14 chains SWD Audit reads (lib/neuro-engine/chains.js, in its order).
/// The ids are part of every PDA and every signed message: NEVER renumber;
/// a new chain gets the next free id.
pub const CHAINS: [(u16, &str); 14] = [
    (1, "eth"),
    (2, "bsc"),
    (3, "base"),
    (4, "arbitrum"),
    (5, "zetaphy"),
    (6, "sol"),
    (7, "sui"),
    (8, "aptos"),
    (9, "osmosis"),
    (10, "neutron"),
    (11, "near"),
    (12, "starknet"),
    (13, "bitcoin"),
    (14, "ton"),
];

pub fn chain_name(chain_id: u16) -> Option<&'static str> {
    CHAINS
        .iter()
        .find(|(id, _)| *id == chain_id)
        .map(|(_, n)| *n)
}

pub fn chain_id_of(name: &str) -> Option<u16> {
    CHAINS.iter().find(|(_, n)| *n == name).map(|(id, _)| *id)
}

pub fn key_id_of(public_key: &[u8]) -> KeyId {
    let h = sha256(public_key).to_bytes();
    let mut out = [0u8; KEY_ID_LEN];
    out.copy_from_slice(&h[..KEY_ID_LEN]);
    out
}

pub fn address_hash(address: &[u8]) -> [u8; 32] {
    sha256(address).to_bytes()
}

/// Everything a record carries that the attestor signs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordFields {
    pub chain_id: u16,
    pub address_hash: [u8; 32],
    pub level: u8,
    pub verdict: [u8; 32],
    pub payload_hash: [u8; 32],
    pub mldsa_key_id: KeyId,
    pub ed25519_key_id: KeyId,
    pub audited_at: i64,
}

pub fn record_message(registry: &[u8; 32], f: &RecordFields) -> [u8; RECORD_MESSAGE_LEN] {
    let mut m = [0u8; RECORD_MESSAGE_LEN];
    m[0..22].copy_from_slice(DOMAIN_TAG);
    m[22..54].copy_from_slice(registry);
    m[54..56].copy_from_slice(&f.chain_id.to_le_bytes());
    m[56..88].copy_from_slice(&f.address_hash);
    m[88] = f.level;
    m[89..121].copy_from_slice(&f.verdict);
    m[121..153].copy_from_slice(&f.payload_hash);
    m[153..161].copy_from_slice(&f.mldsa_key_id);
    m[161..169].copy_from_slice(&f.ed25519_key_id);
    m[169..177].copy_from_slice(&f.audited_at.to_le_bytes());
    m
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressError {
    Empty,
    TooLong,
    Format,
}

const BASE58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// The address must already be in the site's normalized form
/// (lib/audit/shared.ts `normalizeAddress`): EVM chains lowercase, every
/// other chain exactly as written. Two spellings of one EVM address would
/// otherwise give two PDAs, so the canonical form is enforced here rather
/// than trusted. Other chains get a coarse shape check (printable ASCII, no
/// spaces); the attestor's signature over sha256(address) is what binds the
/// exact string.
pub fn check_address(chain_id: u16, address: &[u8]) -> Result<(), AddressError> {
    if address.is_empty() {
        return Err(AddressError::Empty);
    }
    if address.len() > MAX_ADDRESS_LEN {
        return Err(AddressError::TooLong);
    }
    match chain_id {
        // EVM: 0x + 40 lowercase hex
        1..=5 => {
            let ok = address.len() == 42
                && address.starts_with(b"0x")
                && address[2..]
                    .iter()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c));
            if ok {
                Ok(())
            } else {
                Err(AddressError::Format)
            }
        }
        // Solana: 32 bytes base58 = 32 to 44 characters
        6 => {
            if (32..=44).contains(&address.len()) && address.iter().all(|c| BASE58.contains(c)) {
                Ok(())
            } else {
                Err(AddressError::Format)
            }
        }
        _ => {
            if address.iter().all(|c| c.is_ascii_graphic()) {
                Ok(())
            } else {
                Err(AddressError::Format)
            }
        }
    }
}

// ---- the Ed25519 precompile instruction ------------------------------------------------------------------------
//
// data = u8 num_signatures, u8 padding, then per signature 7 × u16 LE:
//   signature_offset, signature_instruction_index, public_key_offset,
//   public_key_instruction_index, message_data_offset, message_data_size,
//   message_instruction_index
// An index of u16::MAX means "this same instruction". We accept exactly ONE
// signature whose three parts all live inside the Ed25519 instruction itself:
// an offset pointing into ANOTHER instruction would let the precompile check
// one thing while this program reads another (the bug class behind the 2022
// Wormhole exploit).

pub const ED25519_HEADER: usize = 2;
pub const ED25519_OFFSETS_LEN: usize = 14;
pub const SELF_INSTRUCTION: u16 = u16::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ed25519IxError {
    Count,
    ForeignInstruction,
    Bounds,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Ed25519Parsed<'a> {
    pub public_key: [u8; 32],
    pub signature: [u8; 64],
    pub message: &'a [u8],
}

fn u16_at(d: &[u8], at: usize) -> Result<u16, Ed25519IxError> {
    let b = d.get(at..at + 2).ok_or(Ed25519IxError::Bounds)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}

fn slice_at(d: &[u8], off: u16, len: usize) -> Result<&[u8], Ed25519IxError> {
    let start = off as usize;
    let end = start.checked_add(len).ok_or(Ed25519IxError::Bounds)?;
    d.get(start..end).ok_or(Ed25519IxError::Bounds)
}

pub fn parse_ed25519_ix(data: &[u8]) -> Result<Ed25519Parsed<'_>, Ed25519IxError> {
    if data.len() < ED25519_HEADER + ED25519_OFFSETS_LEN {
        return Err(Ed25519IxError::Bounds);
    }
    if data[0] != 1 {
        return Err(Ed25519IxError::Count);
    }
    let o = ED25519_HEADER;
    let sig_off = u16_at(data, o)?;
    let sig_ix = u16_at(data, o + 2)?;
    let pk_off = u16_at(data, o + 4)?;
    let pk_ix = u16_at(data, o + 6)?;
    let msg_off = u16_at(data, o + 8)?;
    let msg_len = u16_at(data, o + 10)?;
    let msg_ix = u16_at(data, o + 12)?;
    if sig_ix != SELF_INSTRUCTION || pk_ix != SELF_INSTRUCTION || msg_ix != SELF_INSTRUCTION {
        return Err(Ed25519IxError::ForeignInstruction);
    }
    let mut public_key = [0u8; 32];
    public_key.copy_from_slice(slice_at(data, pk_off, 32)?);
    let mut signature = [0u8; 64];
    signature.copy_from_slice(slice_at(data, sig_off, 64)?);
    let message = slice_at(data, msg_off, msg_len as usize)?;
    Ok(Ed25519Parsed {
        public_key,
        signature,
        message,
    })
}

/// Builds the instruction data the way `Ed25519Program.createInstructionWithPublicKey`
/// (@solana/web3.js) lays it out: offsets, then public key, signature, message.
/// Used by the tests and by Rust relayers.
pub fn build_ed25519_ix_data(
    public_key: &[u8; 32],
    signature: &[u8; 64],
    message: &[u8],
) -> Vec<u8> {
    let pk_off = (ED25519_HEADER + ED25519_OFFSETS_LEN) as u16;
    let sig_off = pk_off + 32;
    let msg_off = sig_off + 64;
    let mut d = Vec::with_capacity(msg_off as usize + message.len());
    d.push(1);
    d.push(0);
    for v in [
        sig_off,
        SELF_INSTRUCTION,
        pk_off,
        SELF_INSTRUCTION,
        msg_off,
        message.len() as u16,
        SELF_INSTRUCTION,
    ] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(public_key);
    d.extend_from_slice(signature);
    d.extend_from_slice(message);
    d
}
