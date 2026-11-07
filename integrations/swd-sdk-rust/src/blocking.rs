//! The blocking client (reqwest::blocking). Do not call it from inside an async runtime; use the async client there.

use crate::core::*;
use crate::error::SwdError;
use crate::types::*;
use std::time::Duration;

/// Blocking client for the public SWD endpoints. Cheap to clone.
#[derive(Debug, Clone)]
pub struct SwdClient {
    base: Base,
    http: reqwest::blocking::Client,
}

impl SwdClient {
    /// The production site, 60 s timeout.
    pub fn new() -> Result<Self, SwdError> {
        Self::with_base_url(DEFAULT_BASE_URL)
    }
    /// Another deployment (e.g. `http://127.0.0.1:3000`).
    pub fn with_base_url(base_url: &str) -> Result<Self, SwdError> {
        Self::with_options(base_url, DEFAULT_TIMEOUT)
    }
    pub fn with_options(base_url: &str, timeout: Duration) -> Result<Self, SwdError> {
        let http = reqwest::blocking::Client::builder().timeout(timeout).user_agent(USER_AGENT).build()?;
        Ok(SwdClient { base: Base::parse(base_url)?, http })
    }
    pub fn base_url(&self) -> &str {
        self.base.0.as_str()
    }

    fn get(&self, url: url::Url, accept: &str) -> Result<(u16, Vec<u8>), SwdError> {
        let r = self.http.get(url).header("accept", accept).send()?;
        let s = r.status().as_u16();
        Ok((s, r.bytes()?.to_vec()))
    }

    /// Audit a contract / token (`full` keeps Neuro's full report in `extra["report"]`).
    pub fn audit(&self, chain: &str, address: &str, lang: &str, full: bool) -> Result<AuditResult, SwdError> {
        require(chain, "chain")?;
        require(address, "address")?;
        let (s, b) = self.get(self.base.url(P_AUDIT, &[("chain", chain), ("address", address), ("lang", lang)]), "application/json")?;
        let mut a: AuditResult = parse_ok(s, &b, "audit")?;
        strip_report(&mut a.extra, full);
        Ok(a)
    }

    /// Check one transaction (sol, eth, bsc, base, arbitrum, zetaphy).
    pub fn audit_tx(&self, chain: &str, hash: &str, lang: &str, full: bool) -> Result<TxCheckResult, SwdError> {
        require(chain, "chain")?;
        require(hash, "hash")?;
        let (s, b) = self.get(self.base.url(P_TX, &[("chain", chain), ("hash", hash), ("lang", lang)]), "application/json")?;
        let mut t: TxCheckResult = parse_ok(s, &b, "tx")?;
        strip_report(&mut t.extra, full);
        Ok(t)
    }

    /// The chains the audit API accepts.
    pub fn audit_chains(&self) -> Result<Vec<AuditChain>, SwdError> {
        let (s, b) = self.get(self.base.url(P_AUDIT, &[]), "application/json")?;
        parse_chains(s, &b)
    }

    /// SWD total and circulating supply.
    pub fn supply(&self) -> Result<Supply, SwdError> {
        let (s1, b1) = self.get(self.base.url(P_SUPPLY_TOTAL, &[]), "text/plain")?;
        let total = parse_number(s1, &b1)?;
        let (s2, b2) = self.get(self.base.url(P_SUPPLY_CIRC, &[]), "text/plain")?;
        Ok(Supply { total, circulating: parse_number(s2, &b2)? })
    }

    /// An UNSIGNED SOL → SWD transaction for `account` (the buyer, also the fee payer). `amount_sol` like "0.1".
    /// The SDK never signs: hand `bytes` to the buyer's wallet.
    pub fn buy_swd_transaction(&self, account: &str, amount_sol: &str, slippage_bps: Option<u16>, lang: &str) -> Result<BuySwdTransaction, SwdError> {
        let req = buy_request(&self.base, account, amount_sol, slippage_bps, lang)?;
        let r = self.http.post(req.url).header("content-type", "application/json").header("accept", "application/json").body(req.body).send()?;
        let s = r.status().as_u16();
        parse_buy(s, &r.bytes()?)
    }

    /// The SVG badge URL.
    pub fn badge_url(&self, chain: &str, address: &str) -> String {
        self.base.url("/api/audit/badge", &[("chain", chain), ("address", address)]).to_string()
    }
}
