//! Response shapes of the public SWD endpoints (the site's `lib/audit/run.ts`, `lib/audit/tx.ts`,
//! `lib/audit/attest-core.ts`). Fields a caller is likely to read are typed; everything else is kept in `extra`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Overall risk level from SWD Audit's fixed rules. `Info` = the rules found no risk (never "safe").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Low,
    Medium,
    High,
}

impl Level {
    /// The registry's byte: 0 info, 1 low, 2 medium, 3 high.
    pub fn from_byte(b: u8) -> Option<Level> {
        match b {
            0 => Some(Level::Info),
            1 => Some(Level::Low),
            2 => Some(Level::Medium),
            3 => Some(Level::High),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Low => "low",
            Level::Medium => "medium",
            Level::High => "high",
        }
    }
}

/// One finding. `severity` is a level or `"good"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub id: String,
    pub severity: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TokenName {
    pub name: Option<String>,
    pub symbol: Option<String>,
}

/// `GET /api/audit` → `audit`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditResult {
    pub chain: String,
    #[serde(default)]
    pub chain_name: String,
    pub address: String,
    pub level: Level,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub lines: Vec<Finding>,
    #[serde(default)]
    pub token: Option<TokenName>,
    #[serde(default)]
    pub report_hash: String,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub explorer: Option<String>,
    #[serde(default)]
    pub permalink: String,
    #[serde(default)]
    pub badge: String,
    #[serde(default)]
    pub audited_at: String,
    #[serde(default)]
    pub cached: bool,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub disclaimer: String,
    /// hybrid ML-DSA-44 + Ed25519 signed attestation (raw JSON; verify it with the site's verifier)
    #[serde(default)]
    pub attestation: Option<Value>,
    /// everything else, including Neuro's full `report`
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `GET /api/audit/tx` → `tx`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxCheckResult {
    pub chain: String,
    #[serde(default)]
    pub chain_name: String,
    pub hash: String,
    #[serde(default)]
    pub reader: String,
    pub found: bool,
    /// true = succeeded, false = failed, None = unknown (pending)
    #[serde(default)]
    pub status: Option<bool>,
    #[serde(default)]
    pub block: Option<u64>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    pub level: Level,
    /// the level including SWD's own notes
    pub overall: Level,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub lines: Vec<Finding>,
    #[serde(default)]
    pub notes: Vec<Finding>,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub explorer: Option<String>,
    #[serde(default)]
    pub permalink: String,
    #[serde(default)]
    pub checked_at: String,
    #[serde(default)]
    pub attestation: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// SWD total and circulating supply, whole SWD as decimal strings (no float rounding).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Supply {
    pub total: String,
    pub circulating: String,
}

/// An unsigned SOL → SWD transaction from the Buy SWD Solana Action. The buyer's wallet signs and sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuySwdTransaction {
    /// base64, as the Action returned it
    pub transaction: String,
    /// the same bytes, decoded (a v0 VersionedTransaction; the buyer is the fee payer)
    pub bytes: Vec<u8>,
    pub message: Option<String>,
}

/// A chain the audit API accepts (`GET /api/audit` with no query).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditChain {
    pub key: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub example: String,
}
