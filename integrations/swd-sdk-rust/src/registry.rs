//! Reader for the on-chain **SWD Audit Registry** (`programs/swd_audit_registry`, documented in
//! `docs/SWD_AUDIT_REGISTRY.md` on the `claude/onchain-registry` branch).
//!
//! > The registry is an UNAUDITED DRAFT and is not deployed anywhere yet. [`DRAFT_PROGRAM_ID`] is the placeholder id
//! > from its `declare_id!`; pass the real program id once SWD publishes it.
//!
//! Pure functions, no Solana SDK: PDA derivation (sha256 + an off-curve check), the byte layout of `Record` and
//! `Config`, and the trust decision (`evaluate`, the same logic as the program's `reader::evaluate`). Plus a small
//! JSON-RPC `getAccountInfo` helper for both clients.
//!
//! A missing or untrusted record means **"not known"**, never "safe".

use crate::types::Level;
use base64::Engine;
use curve25519_dalek::edwards::CompressedEdwardsY;
use sha2::{Digest, Sha256};
use std::fmt;

/// Placeholder program id of the draft (NOT a real deployment).
pub const DRAFT_PROGRAM_ID: &str = "AX4Z8w2r7558cz4uK2nq3iPoE8HWzwh58ew47caPVyCZ";
pub const CONFIG_SEED: &[u8] = b"config";
pub const RECORD_SEED: &[u8] = b"audit";
/// sha256("account:Record")[..8]
pub const RECORD_DISCRIMINATOR: [u8; 8] = [0xfe, 0xe9, 0x75, 0xfc, 0x4c, 0xa6, 0x92, 0x8b];
/// sha256("account:Config")[..8]
pub const CONFIG_DISCRIMINATOR: [u8; 8] = [0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82];
pub const RECORD_FIXED: usize = 146;
pub const MAX_ADDRESS_LEN: usize = 200;
pub const ATTESTOR_ACTIVE: u8 = 1;
pub const ATTESTOR_RETIRED: u8 = 2;
pub const ATTESTOR_REVOKED: u8 = 3;

/// Chain ids: part of every PDA and signed message, never renumbered.
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

pub fn chain_id_of(name: &str) -> Option<u16> {
    CHAINS.iter().find(|(_, n)| *n == name).map(|(id, _)| *id)
}
pub fn chain_name_of(id: u16) -> Option<&'static str> {
    CHAINS.iter().find(|(i, _)| *i == id).map(|(_, n)| *n)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    BadPubkey,
    UnknownChain,
    /// wrong discriminator, size or field value
    BadData(&'static str),
    NoPda,
}
impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegistryError::BadPubkey => write!(f, "not a base58 32-byte public key"),
            RegistryError::UnknownChain => write!(f, "unknown chain"),
            RegistryError::BadData(w) => write!(f, "not a registry account: {w}"),
            RegistryError::NoPda => write!(f, "no program address found"),
        }
    }
}
impl std::error::Error for RegistryError {}

pub type Pubkey = [u8; 32];

pub fn pubkey_from_str(s: &str) -> Result<Pubkey, RegistryError> {
    let v = bs58::decode(s).into_vec().map_err(|_| RegistryError::BadPubkey)?;
    v.try_into().map_err(|_| RegistryError::BadPubkey)
}
pub fn pubkey_to_string(k: &Pubkey) -> String {
    bs58::encode(k).into_string()
}

/// The address form the registry keys on: EVM chains (ids 1–5) lowercase, everything else as given (trimmed).
pub fn normalize_address(chain_id: u16, address: &str) -> String {
    let a = address.trim();
    if (1..=5).contains(&chain_id) {
        a.to_ascii_lowercase()
    } else {
        a.to_string()
    }
}

pub fn address_hash(address: &[u8]) -> [u8; 32] {
    Sha256::digest(address).into()
}

fn on_curve(b: &[u8; 32]) -> bool {
    CompressedEdwardsY(*b).decompress().is_some()
}

/// Solana `create_program_address`.
pub fn create_program_address(seeds: &[&[u8]], program_id: &Pubkey) -> Option<Pubkey> {
    let mut h = Sha256::new();
    for s in seeds {
        h.update(s);
    }
    h.update(program_id);
    h.update(b"ProgramDerivedAddress");
    let out: [u8; 32] = h.finalize().into();
    if on_curve(&out) {
        None
    } else {
        Some(out)
    }
}

/// Solana `find_program_address`: the PDA and its bump.
pub fn find_program_address(seeds: &[&[u8]], program_id: &Pubkey) -> Result<(Pubkey, u8), RegistryError> {
    for bump in (0..=255u8).rev() {
        let b = [bump];
        let mut s: Vec<&[u8]> = seeds.to_vec();
        s.push(&b);
        if let Some(k) = create_program_address(&s, program_id) {
            return Ok((k, bump));
        }
    }
    Err(RegistryError::NoPda)
}

pub fn config_pda(program_id: &Pubkey) -> Result<(Pubkey, u8), RegistryError> {
    find_program_address(&[CONFIG_SEED], program_id)
}

/// The record PDA of (chain, address). The address is normalized first.
pub fn record_pda(program_id: &Pubkey, chain_id: u16, address: &str) -> Result<(Pubkey, u8), RegistryError> {
    if chain_name_of(chain_id).is_none() {
        return Err(RegistryError::UnknownChain);
    }
    let a = normalize_address(chain_id, address);
    find_program_address(&[RECORD_SEED, &chain_id.to_le_bytes(), &address_hash(a.as_bytes())], program_id)
}

/// One `Record` account (190 bytes for a Solana mint).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub version: u8,
    pub bump: u8,
    pub chain_id: u16,
    pub level: Level,
    pub revoked: bool,
    pub address_hash: [u8; 32],
    pub verdict: [u8; 32],
    /// the attestation's payloadHash: fetch the full attestation and verify it off-chain
    pub payload_hash: [u8; 32],
    pub mldsa_key_id: [u8; 8],
    pub ed25519_key_id: [u8; 8],
    /// unix seconds (the attestation's observedAt)
    pub audited_at: i64,
    pub updated_slot: u64,
    pub address: String,
}

fn arr<const N: usize>(d: &[u8], at: usize) -> [u8; N] {
    d[at..at + N].try_into().expect("bounds checked")
}

impl Record {
    pub fn parse(d: &[u8]) -> Result<Record, RegistryError> {
        if d.len() < RECORD_FIXED {
            return Err(RegistryError::BadData("too short"));
        }
        if d[..8] != RECORD_DISCRIMINATOR {
            return Err(RegistryError::BadData("discriminator"));
        }
        let level = Level::from_byte(d[12]).ok_or(RegistryError::BadData("level"))?;
        let revoked = match d[13] {
            0 => false,
            1 => true,
            _ => return Err(RegistryError::BadData("revoked")),
        };
        let len = u32::from_le_bytes(arr(d, 142)) as usize;
        if len == 0 || len > MAX_ADDRESS_LEN || d.len() < RECORD_FIXED + len {
            return Err(RegistryError::BadData("address length"));
        }
        let addr = &d[RECORD_FIXED..RECORD_FIXED + len];
        let address = String::from_utf8(addr.to_vec()).map_err(|_| RegistryError::BadData("address"))?;
        let r = Record {
            version: d[8],
            bump: d[9],
            chain_id: u16::from_le_bytes(arr(d, 10)),
            level,
            revoked,
            address_hash: arr(d, 14),
            verdict: arr(d, 46),
            payload_hash: arr(d, 78),
            mldsa_key_id: arr(d, 110),
            ed25519_key_id: arr(d, 118),
            audited_at: i64::from_le_bytes(arr(d, 126)),
            updated_slot: u64::from_le_bytes(arr(d, 134)),
            address,
        };
        if address_hash(addr) != r.address_hash {
            return Err(RegistryError::BadData("address hash"));
        }
        Ok(r)
    }
    pub fn payload_hash_hex(&self) -> String {
        format!("0x{}", hex(&self.payload_hash))
    }
    pub fn verdict_hex(&self) -> String {
        format!("0x{}", hex(&self.verdict))
    }
    /// The site's key id form, e.g. "ed25519-0123456789abcdef".
    pub fn ed25519_key_id_str(&self) -> String {
        format!("ed25519-{}", hex(&self.ed25519_key_id))
    }
    pub fn mldsa_key_id_str(&self) -> String {
        format!("mldsa44-{}", hex(&self.mldsa_key_id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attestor {
    pub pubkey: Pubkey,
    pub key_id: [u8; 8],
    /// 1 active, 2 retired, 3 revoked
    pub status: u8,
    pub since: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    pub authority: Pubkey,
    pub pending_authority: Option<Pubkey>,
    pub paused: bool,
    pub record_count: u64,
    pub attestors: Vec<Attestor>,
}

impl Config {
    pub fn parse(d: &[u8]) -> Result<Config, RegistryError> {
        let need = |n: usize| if d.len() < n { Err(RegistryError::BadData("too short")) } else { Ok(()) };
        need(8 + 2 + 32 + 1)?;
        if d[..8] != CONFIG_DISCRIMINATOR {
            return Err(RegistryError::BadData("discriminator"));
        }
        let mut o = 10;
        let authority: Pubkey = arr(d, o);
        o += 32;
        let pending_authority = match d[o] {
            0 => {
                o += 1;
                None
            }
            1 => {
                need(o + 33)?;
                let k = arr(d, o + 1);
                o += 33;
                Some(k)
            }
            _ => return Err(RegistryError::BadData("pending_authority")),
        };
        need(o + 1 + 8 + 4)?;
        let paused = match d[o] {
            0 => false,
            1 => true,
            _ => return Err(RegistryError::BadData("paused")),
        };
        let record_count = u64::from_le_bytes(arr(d, o + 1));
        let n = u32::from_le_bytes(arr(d, o + 9)) as usize;
        o += 13;
        if n > 4 {
            return Err(RegistryError::BadData("attestors"));
        }
        need(o + n * 49)?;
        let attestors = (0..n)
            .map(|i| {
                let b = o + i * 49;
                Attestor { pubkey: arr(d, b), key_id: arr(d, b + 32), status: d[b + 40], since: i64::from_le_bytes(arr(d, b + 41)) }
            })
            .collect();
        Ok(Config { version: d[8], bump: d[9], authority, pending_authority, paused, record_count, attestors })
    }
}

/// The level a reader should trust: None if the record is revoked or its key is revoked / no longer listed.
pub fn evaluate(config: &Config, record: &Record) -> Option<Level> {
    if record.revoked {
        return None;
    }
    let a = config.attestors.iter().find(|a| a.key_id == record.ed25519_key_id)?;
    (a.status == ATTESTOR_ACTIVE || a.status == ATTESTOR_RETIRED).then_some(record.level)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---- JSON-RPC getAccountInfo ----

/// An account as an RPC returned it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub owner: Pubkey,
    pub data: Vec<u8>,
}

pub(crate) fn account_request(pubkey: &Pubkey) -> String {
    serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "getAccountInfo",
        "params": [pubkey_to_string(pubkey), { "encoding": "base64", "commitment": "confirmed" }]
    })
    .to_string()
}

pub(crate) fn parse_account(body: &[u8]) -> Result<Option<Account>, crate::SwdError> {
    use crate::SwdError::BadResponse;
    let v: serde_json::Value = serde_json::from_slice(body).map_err(|e| BadResponse(e.to_string()))?;
    if let Some(e) = v.get("error") {
        return Err(BadResponse(format!("rpc: {e}")));
    }
    let val = &v["result"]["value"];
    if val.is_null() {
        return Ok(None);
    }
    let owner = pubkey_from_str(val["owner"].as_str().unwrap_or("")).map_err(|e| BadResponse(e.to_string()))?;
    let b64 = val["data"][0].as_str().ok_or_else(|| BadResponse("no data".into()))?;
    let data = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| BadResponse("data is not base64".into()))?;
    Ok(Some(Account { owner, data }))
}

/// What a lookup found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    /// no record (never written): "not known"
    NotFound,
    /// a record exists but is revoked or signed by a key that is no longer trusted
    Untrusted(Record),
    Trusted(Record),
}

/// Decides from the two raw accounts (as fetched). Errors when an account is not the registry's.
pub fn decide(program_id: &Pubkey, config: Option<Account>, record: Option<Account>) -> Result<Lookup, RegistryError> {
    let c = config.ok_or(RegistryError::BadData("no config account"))?;
    if &c.owner != program_id {
        return Err(RegistryError::BadData("config owner"));
    }
    let cfg = Config::parse(&c.data)?;
    let Some(r) = record else { return Ok(Lookup::NotFound) };
    if &r.owner != program_id {
        return if r.data.is_empty() { Ok(Lookup::NotFound) } else { Err(RegistryError::BadData("record owner")) };
    }
    let rec = Record::parse(&r.data)?;
    Ok(match evaluate(&cfg, &rec) {
        Some(_) => Lookup::Trusted(rec),
        None => Lookup::Untrusted(rec),
    })
}

/// Async lookup through a Solana RPC (`rpc_url`, e.g. your own RPC provider).
pub async fn lookup(http: &reqwest::Client, rpc_url: &str, program_id: &Pubkey, chain: &str, address: &str) -> Result<Lookup, crate::SwdError> {
    let reg = |e: RegistryError| crate::SwdError::BadInput(e.to_string());
    let chain_id = chain_id_of(chain).ok_or_else(|| reg(RegistryError::UnknownChain))?;
    let (cfg, _) = config_pda(program_id).map_err(reg)?;
    let (rec, _) = record_pda(program_id, chain_id, address).map_err(reg)?;
    let mut got = Vec::new();
    for k in [cfg, rec] {
        let r = http.post(rpc_url).header("content-type", "application/json").body(account_request(&k)).send().await?;
        got.push(parse_account(&r.bytes().await?)?);
    }
    let record = got.pop().flatten();
    decide(program_id, got.pop().flatten(), record).map_err(|e| crate::SwdError::BadResponse(e.to_string()))
}

/// Blocking lookup through a Solana RPC.
#[cfg(feature = "blocking")]
pub fn lookup_blocking(http: &reqwest::blocking::Client, rpc_url: &str, program_id: &Pubkey, chain: &str, address: &str) -> Result<Lookup, crate::SwdError> {
    let reg = |e: RegistryError| crate::SwdError::BadInput(e.to_string());
    let chain_id = chain_id_of(chain).ok_or_else(|| reg(RegistryError::UnknownChain))?;
    let (cfg, _) = config_pda(program_id).map_err(reg)?;
    let (rec, _) = record_pda(program_id, chain_id, address).map_err(reg)?;
    let mut got = Vec::new();
    for k in [cfg, rec] {
        let r = http.post(rpc_url).header("content-type", "application/json").body(account_request(&k)).send()?;
        got.push(parse_account(&r.bytes()?)?);
    }
    let record = got.pop().flatten();
    decide(program_id, got.pop().flatten(), record).map_err(|e| crate::SwdError::BadResponse(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_account_parsing() {
        let k = [3u8; 32];
        let req: serde_json::Value = serde_json::from_str(&account_request(&k)).unwrap();
        assert_eq!(req["method"], "getAccountInfo");
        assert_eq!(req["params"][0], pubkey_to_string(&k));
        assert_eq!(parse_account(br#"{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":null}}"#).unwrap(), None);
        let body = format!(r#"{{"jsonrpc":"2.0","id":1,"result":{{"value":{{"owner":"{}","data":["AQID","base64"],"lamports":1}}}}}}"#, DRAFT_PROGRAM_ID);
        let a = parse_account(body.as_bytes()).unwrap().unwrap();
        assert_eq!(a.data, vec![1, 2, 3]);
        assert_eq!(pubkey_to_string(&a.owner), DRAFT_PROGRAM_ID);
        assert!(parse_account(br#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}"#).is_err());
    }

    #[test]
    fn discriminators() {
        assert_eq!(Sha256::digest(b"account:Record")[..8], RECORD_DISCRIMINATOR);
        assert_eq!(Sha256::digest(b"account:Config")[..8], CONFIG_DISCRIMINATOR);
    }
}
