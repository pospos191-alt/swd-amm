// EVM wallets in this browser, and the ZETAPHY network for them. Trimmed from
// zetaphy-wallet/wallets.js (same chain values, same EIP-6963 discovery, same
// sanitising of what a wallet announces): wallets announce themselves with
// EIP-6963; older injected objects (window.ethereum, Binance, Phantom) are
// found too. ZETAPHY is offered with wallet_addEthereumChain (EIP-3085).

export const CHAIN_ID = 'zetaphy_77390-1';
export const EVM_CHAIN_ID = 77390;
export const EVM_CHAIN_ID_HEX = '0x12e4e';
export const CHAIN_NAME = 'ZETAPHY Testnet';
export const DISPLAY_DENOM = 'ZETAPHY';
// MetaMask refuses a nativeCurrency.symbol longer than 6 characters: the EVM ticker is ZTPHY.
export const EVM_SYMBOL = 'ZTPHY';
export const DECIMALS = 18;

/** wallet_addEthereumChain's parameter (EIP-3085); rpcUrl must be https (or localhost). */
export function evmChainParams(rpcUrl, explorerUrl) {
  const p = { chainId: EVM_CHAIN_ID_HEX, chainName: CHAIN_NAME, nativeCurrency: { name: DISPLAY_DENOM, symbol: EVM_SYMBOL, decimals: DECIMALS }, rpcUrls: [rpcUrl] };
  if (explorerUrl) p.blockExplorerUrls = [explorerUrl];
  return p;
}

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
  } catch { /* getters that throw */ }
  return 'unknown';
}

/** A wallet's name as plain text: no control or bidi characters, at most 40 characters. */
export const cleanName = (s) => String(s ?? '').replace(/\p{C}/gu, '').trim().slice(0, 40);

/** Only a data:image/… icon (EIP-6963 says so); never a URL that loads from elsewhere. */
export const safeIcon = (icon) => (typeof icon === 'string' && icon.length <= 200000 && /^data:image\/[a-z0-9.+-]+[;,]/i.test(icon) && !/[\s"'<>]/.test(icon) ? icon : null);

const hasRequest = (p) => { try { return !!p && typeof p.request === 'function'; } catch { return false; } };

/** Starts EIP-6963 discovery; list() gives { id, name, icon, kind, provider }. */
export function discoverWallets(win, onChange) {
  const announced = new Map();
  win.addEventListener('eip6963:announceProvider', (e) => {
    const info = e?.detail?.info;
    const provider = e?.detail?.provider;
    if (!info || typeof info.uuid !== 'string' || !hasRequest(provider)) return;
    const rdns = typeof info.rdns === 'string' ? info.rdns.slice(0, 100) : '';
    const kind = kindOf({ rdns, name: info.name });
    announced.set(info.uuid, { id: `6963:${rdns || info.uuid}`, name: cleanName(info.name) || KIND_NAMES[kind] || rdns || 'EIP-6963', icon: safeIcon(info.icon), kind, provider });
    onChange();
  });
  for (const ev of ['ethereum#initialized', 'load']) win.addEventListener(ev, () => onChange(), { once: true });
  win.dispatchEvent(new Event('eip6963:requestProvider'));

  function injected() {
    const out = [];
    const get = (f) => { try { return f(); } catch { return undefined; } };
    const add = (id, provider, kind) => {
      if (!hasRequest(provider) || out.some((w) => w.provider === provider)) return;
      out.push({ id, name: KIND_NAMES[kind] ?? 'Browser wallet', icon: null, kind, provider });
    };
    add('injected:binancew3w', get(() => win.binancew3w?.ethereum), 'binance');
    add('injected:phantom', get(() => win.phantom?.ethereum), 'phantom');
    const eth = get(() => win.ethereum);
    add('injected:ethereum', eth, eth ? flagKind(eth) : 'unknown');
    return out;
  }
  function list() {
    const fromEvents = [...announced.values()];
    const extra = injected().filter((w) => !fromEvents.some((a) => a.provider === w.provider || (w.kind !== 'unknown' && a.kind === w.kind)));
    const byId = new Map();
    for (const w of [...fromEvents, ...extra]) byId.set(w.id, w);
    return [...byId.values()];
  }
  return { list };
}

/** The wallet's current chain id as a number, or null if it gives no sensible answer. */
export async function walletChainId(provider) {
  try {
    const v = await provider.request({ method: 'eth_chainId' });
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint') return null;
    const n = BigInt(v);
    return n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
  } catch { return null; }
}

/** Throws unless the wallet is on ZETAPHY (77390) right now. */
export async function assertChain(provider) {
  const id = await walletChainId(provider);
  if (id !== EVM_CHAIN_ID) {
    throw Object.assign(new Error(`wrong network: the wallet is on chain ${id ?? 'unknown'}, not ${EVM_CHAIN_ID} (ZETAPHY)`), { code: 'WRONG_CHAIN', chainId: id });
  }
}

/** Puts the wallet on ZETAPHY: switch, or add then switch (4902: unknown chain); then
 *  reads the chain id again and throws if the wallet still is not on 77390. */
export async function ensureChain(provider, rpcUrl) {
  if (await walletChainId(provider) === EVM_CHAIN_ID) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: EVM_CHAIN_ID_HEX }] });
  } catch (e) {
    if (e?.code !== 4902 && !/unrecognized|unknown|not added/i.test(e?.message ?? '')) throw e;
    await provider.request({ method: 'wallet_addEthereumChain', params: [evmChainParams(rpcUrl)] });
  }
  await assertChain(provider);
}

/** Links that open this page inside a wallet app's browser (phones without an injected wallet). */
export function openInAppLinks(href) {
  const u = new URL(href);
  const enc = encodeURIComponent(u.origin + u.pathname + u.hash);
  return [
    { name: 'MetaMask', href: `https://metamask.app.link/dapp/${u.host}${u.pathname}${u.hash}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    { name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
  ];
}
