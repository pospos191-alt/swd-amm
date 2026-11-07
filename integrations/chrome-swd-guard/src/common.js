// SWD Guard: pure helpers shared by the service worker, the content scripts, the popup and the tests.
// No network, no DOM, no chrome.* here. Loaded as a classic script (sets globalThis.SWDG) and by Node tests (module.exports).
(function (root) {
  "use strict";

  const API_BASE = "https://swd-zetaphy.sawasdeecoin.com";
  const LANGS = ["th", "en", "zh", "ja", "ko", "vi", "es", "ru"];
  const LEVELS = ["info", "low", "medium", "high"];
  const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const SOL_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
  const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
  const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

  /** the API language for a browser UI language ("zh-CN" → "zh", "pt-BR" → "en") */
  function apiLang(uiLang) {
    const l = String(uiLang || "en").toLowerCase().split(/[-_]/)[0];
    return LANGS.includes(l) ? l : "en";
  }

  /** chain names used by explorers / DEX sites → SWD Audit chain keys */
  const CHAIN_ALIASES = {
    solana: "sol", sol: "sol",
    ethereum: "eth", eth: "eth", mainnet: "eth",
    bsc: "bsc", bnb: "bsc", binance: "bsc",
    base: "base",
    arbitrum: "arbitrum", arb: "arbitrum", "arbitrum-one": "arbitrum",
  };
  const chainOf = (name) => CHAIN_ALIASES[String(name || "").toLowerCase()] || null;

  function validAddress(chain, a) {
    if (typeof a !== "string") return false;
    return chain === "sol" ? SOL_ADDRESS.test(a) : ["eth", "bsc", "base", "arbitrum"].includes(chain) ? EVM_ADDRESS.test(a) : false;
  }
  const target = (chain, address) => (chain && validAddress(chain, address) ? { chain, address: chain === "sol" ? address : address.toLowerCase() } : null);

  /**
   * The token a page is about, from its URL only: { chain, address } or null.
   *   solscan.io/token/<mint>                 dexscreener.com/<chain>/<pair>  (pair: read from the DOM instead)
   *   jup.ag/tokens/<mint>, jup.ag/swap/A-B, jup.ag/swap?buy=  (also sell / outputMint)
   *   birdeye.so/token/<addr>?chain=<chain>, birdeye.so/<chain>/token/<addr>
   *   pump.fun/coin/<mint>, pump.fun/<mint>
   */
  function detectToken(href) {
    let u;
    try {
      u = new URL(href);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^www\./, "");
    const seg = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const q = u.searchParams;
    if (host === "solscan.io") {
      if (seg[0] === "token" && seg[1]) return target("sol", seg[1]);
      return null;
    }
    if (host === "jup.ag" || host.endsWith(".jup.ag")) {
      if (seg[0] === "tokens" && seg[1]) return target("sol", seg[1]);
      const pick = (...vals) => {
        for (const v of vals) if (v && SOL_ADDRESS.test(v)) return target("sol", v);
        return null;
      };
      if (seg[0] === "swap") {
        const fromQuery = pick(q.get("buy"), q.get("outputMint"), q.get("sell"), q.get("inputMint"));
        if (fromQuery) return fromQuery;
        if (seg[1] && seg[1].includes("-")) {
          const [a, b] = seg[1].split("-");
          return pick(b, a);
        }
      }
      return null;
    }
    if (host === "birdeye.so") {
      if (seg[0] === "token" && seg[1]) return target(chainOf(q.get("chain") || "solana"), seg[1]);
      if (seg[1] === "token" && seg[2]) return target(chainOf(seg[0]), seg[2]);
      return null;
    }
    if (host === "pump.fun") {
      if (seg[0] === "coin" && seg[1]) return target("sol", seg[1]);
      if (seg.length === 1 && SOL_ADDRESS.test(seg[0])) return target("sol", seg[0]);
      return null;
    }
    return null;
  }

  /** dexscreener.com/<chain>/<pair>: the chain from the URL (the token comes from the page's explorer links) */
  function dexscreenerChain(href) {
    try {
      const u = new URL(href);
      if (u.hostname.replace(/^www\./, "") !== "dexscreener.com") return null;
      const seg = u.pathname.split("/").filter(Boolean);
      return seg.length >= 2 ? chainOf(seg[0]) : null;
    } catch {
      return null;
    }
  }

  /** an explorer token link → { chain, address } (solscan, etherscan, bscscan, basescan, arbiscan) */
  function tokenFromExplorerLink(href) {
    try {
      const u = new URL(href);
      const host = u.hostname.replace(/^www\./, "");
      const seg = u.pathname.split("/").filter(Boolean);
      if (seg[0] !== "token" || !seg[1]) return null;
      const chain = { "solscan.io": "sol", "etherscan.io": "eth", "bscscan.com": "bsc", "basescan.org": "base", "arbiscan.io": "arbitrum" }[host];
      return chain ? target(chain, seg[1]) : null;
    } catch {
      return null;
    }
  }

  /** What the popup's text box holds: a contract audit or a transaction check. */
  function classifyInput(raw, evmChain) {
    const s = String(raw || "").trim();
    const evm = ["eth", "bsc", "base", "arbitrum"].includes(evmChain) ? evmChain : "eth";
    if (EVM_HASH.test(s)) return { kind: "tx", chain: evm, value: s.toLowerCase() };
    if (EVM_ADDRESS.test(s)) return { kind: "contract", chain: evm, value: s.toLowerCase() };
    if (SOL_SIGNATURE.test(s)) return { kind: "tx", chain: "sol", value: s };
    if (SOL_ADDRESS.test(s)) return { kind: "contract", chain: "sol", value: s };
    // a pasted explorer / DEX link
    const t = detectToken(s) || tokenFromExplorerLink(s);
    if (t) return { kind: "contract", chain: t.chain, value: t.address };
    return null;
  }

  function normalizeHost(h) {
    return String(h || "").trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  }
  const validDomain = (d) => DOMAIN.test(d);

  /** the listed domain that covers `host` (the domain itself or a subdomain of it), or null */
  function listedDomain(host, domains) {
    const h = normalizeHost(host);
    for (const d of domains || []) if (h === d || h.endsWith("." + d)) return d;
    return null;
  }

  /** looks like SWD (the brand in the host name) but is not an official SWD domain */
  function lookalike(host, official) {
    const h = normalizeHost(host);
    if (listedDomain(h, official)) return false;
    return /sawasdee|sawadee|sawasdi|swd-?(coin|claim|airdrop|token|zetaphy)/.test(h.replace(/xn--/g, ""));
  }

  /** a downloaded list: only valid lowercase domains, at most `max` of them */
  function cleanDomainList(json, max = 2000) {
    const arr = json && Array.isArray(json.domains) ? json.domains : [];
    const out = [];
    for (const d of arr) {
      const n = normalizeHost(d);
      if (typeof d === "string" && validDomain(n) && !out.includes(n)) out.push(n);
      if (out.length >= max) break;
    }
    return out;
  }

  /** match patterns for content scripts: the domain and its subdomains */
  const matchPatterns = (domains) => domains.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);

  const API = {
    audit: (chain, address, lang) => `${API_BASE}/api/audit?${new URLSearchParams({ chain, address, lang })}`,
    tx: (chain, hash, lang) => `${API_BASE}/api/audit/tx?${new URLSearchParams({ chain, hash, lang })}`,
    permalink: (chain, address) => `${API_BASE}/audit/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`,
  };

  const api = { API_BASE, LANGS, LEVELS, apiLang, chainOf, validAddress, detectToken, dexscreenerChain, tokenFromExplorerLink, classifyInput, normalizeHost, validDomain, listedDomain, lookalike, cleanDomainList, matchPatterns, API };
  root.SWDG = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
