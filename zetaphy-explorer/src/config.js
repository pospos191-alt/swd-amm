// Explorer settings: defaults, config.json (the site's), then this browser's
// own overrides (Settings page, localStorage). Only https URLs are accepted
// (http only for localhost, for local runs).

export const DEFAULTS = Object.freeze({
  // The node's public https host (zetaphy-chain/setup-node.sh puts Caddy in front):
  //   <node>/        EVM JSON-RPC     <node>/rpc/  CometBFT RPC
  //   <node>/rest/   Cosmos REST      <node>/zetaphy/  files
  node: 'https://<node-host>',
  // Leave empty to derive from `node`; set to use other hosts for each API.
  evmRpc: '',
  cometRpc: '',
  rest: '',
  chainName: 'ZETAPHY',
  evmChainId: 77390,
  // ThreatRegistry (zetaphy-network/contracts/ThreatRegistry.sol) on ZETAPHY: 0x… or empty (not checked).
  threatRegistry: '',
  // ImmuneRegistry (zetaphy-network/contracts/ImmuneRegistry.sol, docs/future/immune-network.md) on ZETAPHY: 0x… or
  // empty (no immune badges). Any IImmuneFeed works (an ImmuneMirror on another chain too).
  immuneFeed: '',
  // AuditCertificate (zetaphy-network/contracts/AuditCertificate.sol) on ZETAPHY: 0x… or empty (no audit badges).
  auditCertificate: '',
  // Neuro web report of a contract; {address} and {chainId} are filled in. Empty: no link.
  neuroReportUrl: '',
  // Chain activity counts (Neuro's /api/chain-stats, any origin may read it). Empty: not shown.
  chainStatsUrl: 'https://neuro.sawasdeecoin.com/api/chain-stats',
  // Where the quantum-exposure advice sends people to move to an ML-DSA-44 account or set a quantum lock.
  hubWalletUrl: 'https://app.sawasdeecoin.com/?tab=wallet',
  // Public IPFS gateway for NFT metadata and images (ipfs:// URIs). Only https://ipfs.io is in the
  // CSP's img-src: images through another gateway are fetched and shown from a blob: URL.
  ipfsGateway: 'https://ipfs.io',
  // The hub's governance assistant (proposal simulation); empty: no link.
  hubGovUrl: 'https://app.sawasdeecoin.com/?tab=gov',
  // How many recent blocks the explorer scans for "latest transactions" (no indexer).
  scanBlocks: 100,
  maxScanBlocks: 1000,
  // Politeness toward the public node.
  maxRps: 8,
  maxConcurrent: 4,
});

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const STORAGE_KEY = 'zetaphy-explorer:settings';

/** An API base URL: https (or http on localhost), no credentials, no query. Returns the normalised URL or throws. */
export function checkUrl(u, { trailingSlash = false } = {}) {
  let url;
  try { url = new URL(String(u).trim()); } catch { throw new Error('not a URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('the URL must start with https://');
  if (url.username || url.password) throw new Error('the URL must not hold a user name or password');
  if (url.search || url.hash) throw new Error('the URL must not have ? or #');
  if (/[<>]/.test(decodeURIComponent(url.href))) throw new Error('placeholder URL: set the node host');
  let s = url.href;
  if (trailingSlash && !s.endsWith('/')) s += '/';
  return s;
}

/** True while the node URL is still the placeholder (nothing to talk to). */
export const isPlaceholder = (cfg) => /[<>]/.test(String(cfg.node ?? '')) && !(cfg.evmRpc && cfg.cometRpc && cfg.rest);

/**
 * { evm, comet, rest } from a config. Comet and REST need a trailing slash: Caddy
 * serves them under handle_path /rpc/* and /rest/*, which "/rpc" does not match.
 */
export function endpoints(cfg) {
  const base = String(cfg.node ?? '').replace(/\/+$/, '');
  return {
    evm: checkUrl(cfg.evmRpc || base + '/'),
    comet: checkUrl(cfg.cometRpc || base + '/rpc/', { trailingSlash: true }),
    rest: checkUrl(cfg.rest || base + '/rest/', { trailingSlash: true }),
  };
}

/** A Neuro report link for a contract, or '' (no template, or not https). */
export function neuroLink(cfg, address) {
  const tpl = String(cfg.neuroReportUrl ?? '').trim();
  if (!tpl) return '';
  const s = tpl.replaceAll('{address}', encodeURIComponent(address)).replaceAll('{chainId}', encodeURIComponent(String(cfg.evmChainId)));
  try { const u = new URL(s); return u.protocol === 'https:' && !/[<>]/.test(s) ? u.href : ''; } catch { return ''; }
}

/** Merges and checks: unknown keys dropped, wrong types replaced by defaults. */
export function sanitizeConfig(...layers) {
  const out = { ...DEFAULTS };
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const [k, v] of Object.entries(layer)) {
      if (!(k in DEFAULTS) || v == null) continue;
      if (typeof DEFAULTS[k] === 'number') { const n = Number(v); if (Number.isFinite(n) && n > 0) out[k] = n; continue; }
      if (typeof v !== 'string') continue;
      if ((k === 'threatRegistry' || k === 'auditCertificate' || k === 'immuneFeed') && v && !ADDR.test(v.trim())) continue;
      if (k === 'chainStatsUrl' && v.trim()) { try { checkUrl(v); } catch { continue; } }
      if (k === 'ipfsGateway') { try { out[k] = checkUrl(v).replace(/\/+$/, ''); } catch { /* keep the default */ } continue; }
      if (k === 'hubGovUrl' && v.trim()) { try { const u = new URL(v.trim()); if (u.protocol !== 'https:' || u.username) continue; } catch { continue; } }
      out[k] = v.trim();
    }
  }
  out.scanBlocks = Math.min(Math.max(1, Math.floor(out.scanBlocks)), out.maxScanBlocks);
  out.maxRps = Math.min(out.maxRps, 50);
  out.maxConcurrent = Math.min(Math.floor(out.maxConcurrent), 16);
  return out;
}

const readLocal = (storage) => { try { return JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null'); } catch { return null; } };

/** Defaults <- config.json <- this browser's settings. */
export async function loadConfig({ fetchFn = (...a) => fetch(...a), storage } = {}) {
  let site = null;
  try {
    const res = await fetchFn('config.json', { cache: 'no-cache', credentials: 'omit' });
    if (res.ok) site = await res.json();
  } catch { /* defaults */ }
  const local = readLocal(storage);
  return { site: sanitizeConfig(site), config: sanitizeConfig(site, local), local: local ?? {} };
}

export function saveLocal(storage, values) {
  try {
    if (!values || !Object.keys(values).length) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(values));
    return true;
  } catch { return false; }
}
