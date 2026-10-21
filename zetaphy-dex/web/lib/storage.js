// What the DEX page reads back from localStorage, validated strictly.
//
// Security finding M4: the page used to share its origin with the test-ui
// site, whose CSP is looser, so a script there could write this page's
// localStorage. The page now has its own origin (swap.sawasdeecoin.com), but
// stored values are still treated as untrusted input (an extension, an old
// browser profile or a future bug can write them too), so nothing stored is
// trusted beyond plain, bounded values:
//   - slippage: at most SLIPPAGE_MAX_BPS (5%); above SLIPPAGE_CONFIRM_BPS (1%)
//     the page asks for a fresh confirmation before each trade (never stored);
//   - the RPC: kept only in the exact form nodeEndpoints() gives; the page shows
//     a banner while it is not the deployment's RPC, and never hands it to the
//     wallet (wallet_addEthereumChain uses the deployment's RPC);
//   - the fee-on-transfer switch is not read back at all (off on every load);
//   - imported tokens: at most MAX_IMPORTED entries of this chain, each a clean
//     token-list entry; the page labels them "imported, not in the list" and
//     asks Neuro again right before a trade.

import { validEntry } from './tokens.js';
import { nodeEndpoints } from './wallets.js';

export const SLIPPAGE_DEFAULT_BPS = 50;
export const SLIPPAGE_MAX_BPS = 500;
export const SLIPPAGE_CONFIRM_BPS = 100;
export const DEADLINE_DEFAULT_MIN = 20;
export const MAX_IMPORTED = 50;
const MAX_TEXT = 50_000;

function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** An RPC URL in the exact form the page would have saved it, or ''. */
export function cleanRpc(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 300) return '';
  try {
    const evm = nodeEndpoints(v).evm;
    return evm === v ? evm : '';
  } catch { return ''; }
}

/** Settings from storage: { slippageBps, deadlineMin, rpc, fot: false }. Anything out of range falls back to the default. */
export function parseSettings(text) {
  const s = parseJson(text);
  const o = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  const bps = o.slippageBps;
  const dl = o.deadlineMin;
  return {
    slippageBps: Number.isInteger(bps) && bps >= 1 && bps <= SLIPPAGE_MAX_BPS ? bps : SLIPPAGE_DEFAULT_BPS,
    deadlineMin: Number.isInteger(dl) && dl >= 1 && dl <= 180 ? dl : DEADLINE_DEFAULT_MIN,
    rpc: cleanRpc(o.rpc),
    fot: false,
  };
}

/** What is written back (the fee-on-transfer switch is not). */
export const serializeSettings = (s) => JSON.stringify({ slippageBps: s.slippageBps, deadlineMin: s.deadlineMin, rpc: s.rpc });

/** Imported tokens from storage: clean entries of `chainId` only, no duplicates, at most MAX_IMPORTED. */
export function parseImported(text, chainId) {
  const arr = parseJson(text);
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const x of arr.slice(0, MAX_IMPORTED)) {
    if (!x || typeof x !== 'object' || x.chainId !== chainId) continue;
    const e = validEntry({ address: x.address, name: x.name, symbol: x.symbol, decimals: x.decimals, chainId, source: 'imported' }, chainId);
    if (!e || seen.has(e.address.toLowerCase())) continue;
    seen.add(e.address.toLowerCase());
    out.push(e);
  }
  return out;
}

/** The id of the wallet used last time (EIP-6963 rdns or an injected name), or null. */
export const cleanWalletId = (v) => (typeof v === 'string' && /^(6963|injected):[A-Za-z0-9._:-]{1,100}$/.test(v) ? v : null);

/** True while the page reads the chain through an RPC other than the deployment's. */
export const rpcIsCustom = (settingsRpc, defaultRpc) => !!settingsRpc && settingsRpc !== defaultRpc;
