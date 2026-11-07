//! What the async and the blocking client share: URLs, input checks, response parsing. No I/O here.

use crate::error::SwdError;
use crate::types::{AuditChain, BuySwdTransaction};
use base64::Engine;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::time::Duration;
use url::Url;

pub const DEFAULT_BASE_URL: &str = "https://swd-zetaphy.sawasdeecoin.com";
pub const SWD_MINT: &str = "Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL";
pub const SWD_DECIMALS: u8 = 5;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
pub const USER_AGENT: &str = concat!("swd-sdk-rust/", env!("CARGO_PKG_VERSION"));

/// Endpoint paths
pub const P_AUDIT: &str = "/api/audit";
pub const P_TX: &str = "/api/audit/tx";
pub const P_SUPPLY_TOTAL: &str = "/api/supply/total";
pub const P_SUPPLY_CIRC: &str = "/api/supply/circulating";
pub const P_BUY: &str = "/api/actions/buy-swd";

#[derive(Debug, Clone)]
pub(crate) struct Base(pub Url);

impl Base {
    pub fn parse(s: &str) -> Result<Base, SwdError> {
        let t = s.trim_end_matches('/');
        let u = Url::parse(t).map_err(|e| SwdError::BadInput(format!("base url: {e}")))?;
        if u.scheme() != "https" && u.scheme() != "http" {
            return Err(SwdError::BadInput("base url must be http(s)".into()));
        }
        Ok(Base(u))
    }
    pub fn url(&self, path: &str, q: &[(&str, &str)]) -> Url {
        let mut u = self.0.clone();
        let prefix = u.path().trim_end_matches('/').to_string();
        u.set_path(&format!("{prefix}{path}"));
        if q.is_empty() {
            u.set_query(None);
        } else {
            u.query_pairs_mut().clear().extend_pairs(q.iter());
        }
        u
    }
}

pub(crate) fn require(v: &str, what: &str) -> Result<(), SwdError> {
    if v.trim().is_empty() || v.len() > 200 {
        return Err(SwdError::BadInput(format!("{what} is required (at most 200 characters)")));
    }
    Ok(())
}

/// `{ ok: true, <field>: T }` or `{ ok: false, code, error }`
pub(crate) fn parse_ok<T: DeserializeOwned>(status: u16, body: &[u8], field: &str) -> Result<T, SwdError> {
    let v: Value = serde_json::from_slice(body).map_err(|_| SwdError::Api { code: "http_error".into(), message: format!("HTTP {status}"), status })?;
    if !(200..300).contains(&status) || v.get("ok") != Some(&Value::Bool(true)) {
        return Err(SwdError::Api {
            code: v.get("code").and_then(Value::as_str).unwrap_or("http_error").to_string(),
            message: v.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("HTTP {status}")),
            status,
        });
    }
    let inner = v.get(field).cloned().ok_or_else(|| SwdError::BadResponse(format!("no `{field}` in the answer")))?;
    serde_json::from_value(inner).map_err(|e| SwdError::BadResponse(e.to_string()))
}

pub(crate) fn parse_chains(status: u16, body: &[u8]) -> Result<Vec<AuditChain>, SwdError> {
    parse_ok(status, body, "chains")
}

/// `/api/supply/*`: one plain number
pub(crate) fn parse_number(status: u16, body: &[u8]) -> Result<String, SwdError> {
    let t = String::from_utf8_lossy(body).trim().to_string();
    if !(200..300).contains(&status) {
        return Err(SwdError::Api { code: "http_error".into(), message: format!("HTTP {status}"), status });
    }
    let ok = !t.is_empty() && t.split_once('.').map_or(t.bytes().all(|b| b.is_ascii_digit()), |(w, f)| {
        !w.is_empty() && !f.is_empty() && w.bytes().all(|b| b.is_ascii_digit()) && f.bytes().all(|b| b.is_ascii_digit())
    });
    if !ok {
        return Err(SwdError::BadResponse("not a number".into()));
    }
    Ok(t)
}

pub(crate) fn is_base58_address(s: &str) -> bool {
    (32..=44).contains(&s.len()) && s.bytes().all(|b| b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&b))
}

/// Checks a SOL amount string: 0.001–50 SOL, at most 9 decimals.
pub fn check_sol_amount(s: &str) -> Result<String, SwdError> {
    let s = s.trim();
    let (w, f) = s.split_once('.').unwrap_or((s, ""));
    let digits = |x: &str| x.bytes().all(|b| b.is_ascii_digit());
    if w.is_empty() || w.len() > 3 || !digits(w) || f.len() > 9 || !digits(f) || (s.contains('.') && f.is_empty()) {
        return Err(SwdError::BadInput("amount must be a SOL amount with at most 9 decimals".into()));
    }
    let lamports: u64 = w.parse::<u64>().unwrap_or(0) * 1_000_000_000 + format!("{f:0<9}").parse::<u64>().unwrap_or(0);
    if !(1_000_000..=50_000_000_000).contains(&lamports) {
        return Err(SwdError::BadInput("amount must be between 0.001 and 50 SOL".into()));
    }
    Ok(s.to_string())
}

pub(crate) struct BuyRequest {
    pub url: Url,
    pub body: String,
}

pub(crate) fn buy_request(base: &Base, account: &str, amount_sol: &str, slippage_bps: Option<u16>, lang: &str) -> Result<BuyRequest, SwdError> {
    if !is_base58_address(account) {
        return Err(SwdError::BadInput("account must be a Solana address".into()));
    }
    let amount = check_sol_amount(amount_sol)?;
    let slip = match slippage_bps {
        Some(b) if !(10..=300).contains(&b) => return Err(SwdError::BadInput("slippage_bps must be 10 to 300".into())),
        Some(b) => Some(b.to_string()),
        None => None,
    };
    let mut q: Vec<(&str, &str)> = vec![("amount", &amount), ("lang", lang)];
    if let Some(s) = &slip {
        q.push(("slippageBps", s));
    }
    Ok(BuyRequest { url: base.url(P_BUY, &q), body: serde_json::json!({ "account": account }).to_string() })
}

pub(crate) fn parse_buy(status: u16, body: &[u8]) -> Result<BuySwdTransaction, SwdError> {
    let v: Value = serde_json::from_slice(body).map_err(|_| SwdError::Api { code: "http_error".into(), message: format!("HTTP {status}"), status })?;
    if !(200..300).contains(&status) {
        let msg = v.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("HTTP {status}"));
        return Err(SwdError::Api { code: "http_error".into(), message: msg, status });
    }
    let tx = match (v.get("type").and_then(Value::as_str), v.get("transaction").and_then(Value::as_str)) {
        (Some("transaction"), Some(t)) => t.to_string(),
        _ => return Err(SwdError::BadResponse("no transaction in the answer".into())),
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(&tx).map_err(|_| SwdError::BadResponse("transaction is not base64".into()))?;
    Ok(BuySwdTransaction { transaction: tx, bytes, message: v.get("message").and_then(Value::as_str).map(str::to_string) })
}

/// Drops Neuro's full `report` unless asked for.
pub(crate) fn strip_report(extra: &mut serde_json::Map<String, Value>, full: bool) {
    if !full {
        extra.remove("report");
    }
}
