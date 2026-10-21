// Copied from zetaphy-wallet/wallets.js (same repository, MIT), EVM parts only:
// the chain's wallet_addEthereumChain parameters, EIP-6963 wallet discovery
// (MetaMask, Rabby, OKX, Trust, Binance, Coinbase, Brave, Phantom, ...) and the
// older injected providers. Keep the chain values in step with that file.
// The chain values are the same as in zetaphy-chain/wallets/*.template.json.

export const CHAIN_ID = 'zetaphy_77390-1';
export const EVM_CHAIN_ID = 77390;
export const EVM_CHAIN_ID_HEX = '0x12e4e';
export const CHAIN_NAME = 'ZETAPHY Testnet';
export const DENOM = 'azetaphy';
export const DISPLAY_DENOM = 'ZETAPHY';
export const DECIMALS = 18;
// The EVM wallets' ticker. MetaMask refuses a wallet_addEthereumChain whose
// nativeCurrency.symbol is longer than 6 characters, and ethereum-lists/chains (what
// chainlist.org shows) refuses 7 or more, so it cannot be "ZETAPHY". Change it here,
// in zetaphy-chain/wallets/evm-add-chain.template.json and in
// zetaphy-chain/wallets/ethereum-lists/eip155-77390.json together.
export const EVM_SYMBOL = 'ZTPHY';

/**
 * The node's endpoints from its EVM JSON-RPC URL. Wallets accept only https (or
 * localhost), so http on another host is refused ('chainNeedHttps').
 */
export function nodeEndpoints(rpcUrl) {
  let u;
  try { u = new URL(String(rpcUrl).trim()); } catch { throw new Error('badRpc'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('badRpc');
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) throw new Error('chainNeedHttps');
  return {
    evm: u.origin + u.pathname.replace(/\/+$/, '') + u.search, // no user:pass, no #fragment
    host: u.origin,
    rpc: `${u.origin}/rpc`,
    rest: `${u.origin}/rest`,
  };
}

/** wallet_addEthereumChain's parameter (EIP-3085). MetaMask refuses any other key. */
export function evmChainParams(ep) {
  return {
    chainId: EVM_CHAIN_ID_HEX,
    chainName: CHAIN_NAME,
    nativeCurrency: { name: DISPLAY_DENOM, symbol: EVM_SYMBOL, decimals: DECIMALS },
    rpcUrls: [ep.evm],
  };
}

// ---- EVM wallets in this browser ----

/** Known wallets: EIP-6963 rdns, or the flag an injected provider sets. */
const KNOWN = [
  { kind: 'metamask', name: 'MetaMask', rdns: ['io.metamask', 'io.metamask.mobile'] },
  { kind: 'flask', name: 'MetaMask Flask', rdns: ['io.metamask.flask'] },
  { kind: 'rabby', name: 'Rabby', rdns: ['io.rabby'] },
  { kind: 'coinbase', name: 'Coinbase Wallet', rdns: ['com.coinbase.wallet'] },
  { kind: 'okx', name: 'OKX Wallet', rdns: ['com.okex.wallet', 'com.okx.wallet'] },
  { kind: 'trust', name: 'Trust Wallet', rdns: ['com.trustwallet.app'] },
  { kind: 'brave', name: 'Brave Wallet', rdns: ['com.brave.wallet'] },
  { kind: 'binance', name: 'Binance Wallet', rdns: ['com.binance.wallet', 'com.binance.w3w'], match: /binance/i },
  { kind: 'phantom', name: 'Phantom', rdns: ['app.phantom'], match: /^phantom$/i },
];
const KIND_NAMES = Object.fromEntries(KNOWN.map((k) => [k.kind, k.name]));

export function kindOf({ rdns, name }) {
  const r = String(rdns ?? '').toLowerCase();
  const n = String(name ?? '');
  return KNOWN.find((k) => k.rdns.includes(r))?.kind ?? KNOWN.find((k) => k.match?.test(n) || k.match?.test(r))?.kind ?? 'unknown';
}

/** An injected provider's own flags. Many set isMetaMask too, so that one is checked last. */
function flagKind(p) {
  try {
    if (p.isPhantom) return 'phantom';
    if (p.isBinance || p.isBinanceW3W || p.isBinanceWallet) return 'binance';
    if (p.isRabby) return 'rabby';
    if (p.isCoinbaseWallet) return 'coinbase';
    if (p.isOkxWallet || p.isOKExWallet) return 'okx';
    if (p.isTrust || p.isTrustWallet) return 'trust';
    if (p.isBraveWallet) return 'brave';
    if (p.isMetaMask) return 'metamask';
  } catch { /* a provider whose getters throw */ }
  return 'unknown';
}

/** A wallet's name as plain text: no control or bidi characters, at most 40 characters. */
export function cleanName(s) {
  return String(s ?? '').replace(/\p{C}/gu, '').trim().slice(0, 40);
}

/**
 * An icon this page shows: only a data:image/… URI (EIP-6963 says so, and the
 * CSP's img-src allows only 'self' and data:), never a URL that would load
 * something from elsewhere. SVG is fine: an <img> does not run its scripts.
 */
export function safeIcon(icon) {
  return typeof icon === 'string' && icon.length <= 200000 && /^data:image\/[a-z0-9.+-]+[;,]/i.test(icon) && !/[\s"'<>]/.test(icon) ? icon : null;
}

const hasRequest = (p) => { try { return !!p && typeof p.request === 'function'; } catch { return false; } };

/**
 * Starts listening for EIP-6963 announcements and asks wallets to announce.
 * Returns list(): the wallets now in the browser, each
 * { id, name, icon, kind, rdns, source, provider }. onChange runs when one appears.
 */
export function discoverWallets(win, onChange) {
  const announced = new Map(); // uuid -> wallet
  win.addEventListener('eip6963:announceProvider', (e) => {
    const info = e?.detail?.info;
    const provider = e?.detail?.provider;
    if (!info || typeof info.uuid !== 'string' || !hasRequest(provider)) return;
    const rdns = typeof info.rdns === 'string' ? info.rdns.slice(0, 100) : '';
    const kind = kindOf({ rdns, name: info.name });
    const name = cleanName(info.name) || KIND_NAMES[kind] || rdns || 'EIP-6963';
    announced.set(info.uuid, { id: `6963:${rdns || info.uuid}`, name, icon: safeIcon(info.icon), kind, rdns, source: 'eip6963', provider });
    onChange();
  });
  for (const ev of ['ethereum#initialized', 'load']) win.addEventListener(ev, () => onChange(), { once: true });
  win.dispatchEvent(new Event('eip6963:requestProvider'));

  /** Injected providers (older wallets, in-app browsers), unless already announced. */
  function injected() {
    const out = [];
    const add = (id, provider, kind) => {
      if (!hasRequest(provider) || out.some((w) => w.provider === provider)) return;
      out.push({ id, name: KIND_NAMES[kind] ?? 'window.ethereum', icon: null, kind, rdns: '', source: 'injected', provider });
    };
    const get = (f) => { try { return f(); } catch { return undefined; } };
    add('injected:binancew3w', get(() => win.binancew3w?.ethereum), 'binance');
    add('injected:phantom', get(() => win.phantom?.ethereum), 'phantom');
    const eth = get(() => win.ethereum);
    add('injected:ethereum', eth, eth ? flagKind(eth) : 'unknown');
    return out;
  }

  function list() {
    const fromEvents = [...announced.values()];
    // An announced wallet is the same one as an injected object (same provider, or same kind).
    const extra = injected().filter((w) => !fromEvents.some((a) => a.provider === w.provider || (w.kind !== 'unknown' && a.kind === w.kind)));
    // Two announcements with the same rdns (an extension reloaded): keep the last.
    const byId = new Map();
    for (const w of [...fromEvents, ...extra]) byId.set(w.id, w);
    return [...byId.values()];
  }

  return { list };
}

/** Links that open this page inside a wallet app's browser (phones without an injected wallet). */
export function openInAppLinks(href) {
  const u = new URL(href);
  const page = u.origin + u.pathname;
  const enc = encodeURIComponent(page);
  return [
    { name: 'MetaMask', href: `https://metamask.app.link/dapp/${u.host}${u.pathname}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    { name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
    { name: 'OKX Wallet', href: `okx://wallet/dapp/url?dappUrl=${enc}` },
  ];
}
