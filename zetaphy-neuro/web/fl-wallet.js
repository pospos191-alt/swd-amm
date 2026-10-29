// The wallet for the federated-learning panel only (web/fl-panel.js). Same patterns as
// the hub's wallet bar (zetaphy-hub/walletbar.js): EIP-6963 discovery plus older injected
// objects, and one connection for the whole site: the wallet's id (never a key or a
// signature) is kept under 'zetaphy:wallet', so inside the hub the panel follows the
// wallet bar's choice (silently, eth_accounts) and a connection made here shows there.
// Nothing connects until the user presses a button.

export const SHARED_KEY = 'zetaphy:wallet';
const ID_RE = /^(6963:[\w.:-]{1,120}|injected:[a-z0-9]{1,20}|ledger:\d{1,3})$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const hasRequest = (p) => !!p && typeof p.request === 'function';
const clean = (s) => String(s ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40);

/** The stored shared wallet id, or null. */
export function sharedId(win) {
  let raw = null;
  try { raw = win.localStorage.getItem(SHARED_KEY); } catch { return null; }
  let v = raw;
  try { v = JSON.parse(raw); } catch { /* plain text */ }
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

export function createWallet(win, { chainId, chainName, rpc, onChange = () => {} } = {}) {
  const announced = new Map();
  win.addEventListener('eip6963:announceProvider', (e) => {
    const info = e?.detail?.info; const provider = e?.detail?.provider;
    if (!info || typeof info.uuid !== 'string' || !hasRequest(provider)) return;
    const rdns = typeof info.rdns === 'string' ? info.rdns.slice(0, 100) : '';
    announced.set(info.uuid, { id: `6963:${rdns || info.uuid}`, name: clean(info.name) || rdns || 'EIP-6963', provider });
    onChange();
  });
  win.dispatchEvent(new Event('eip6963:requestProvider'));

  function list() {
    const out = [...announced.values()];
    let eth;
    try { eth = win.ethereum; } catch { eth = undefined; }
    if (hasRequest(eth) && !out.some((w) => w.provider === eth)) out.push({ id: 'injected:ethereum', name: 'Browser wallet', provider: eth });
    return out;
  }

  let wallet = null;
  let account = null;
  const hex = '0x' + Number(chainId).toString(16);

  function set(w, a) {
    wallet = a ? w : null;
    account = a && ADDR_RE.test(a) ? a : null;
    onChange();
  }

  async function connect(w, { silent = false } = {}) {
    const accs = await w.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
    const a = Array.isArray(accs) ? accs.find((x) => ADDR_RE.test(x)) : null;
    if (!a) { if (!silent) throw new Error('the wallet gave no account'); return null; }
    if (!w.subscribed && typeof w.provider.on === 'function') {
      w.subscribed = true;
      w.provider.on('accountsChanged', (x) => { if (wallet === w) set(w, Array.isArray(x) ? x.find((y) => ADDR_RE.test(y)) : null); });
    }
    if (!silent) { try { win.localStorage.setItem(SHARED_KEY, JSON.stringify(w.id)); } catch { /* private mode */ } }
    set(w, a);
    return a;
  }

  /** Follows the site-wide choice (hub wallet bar) without a prompt. */
  async function restore() {
    const id = sharedId(win);
    const w = id && list().find((x) => x.id === id);
    if (w && !account) await connect(w, { silent: true }).catch(() => null);
  }

  /** Asks the wallet for the ZETAPHY testnet (adds it when unknown). */
  async function ensureChain() {
    const p = wallet.provider;
    const now = await p.request({ method: 'eth_chainId' }).catch(() => null);
    if (now && BigInt(now) === BigInt(chainId)) return;
    try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); } catch (e) {
      if (e?.code === 4001) throw e;
      await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName, rpcUrls: [rpc], nativeCurrency: { name: 'ZETAPHY', symbol: 'ZETAPHY', decimals: 18 } }] });
    }
  }

  return {
    list, connect, restore, ensureChain,
    account: () => account,
    request: (method, params = []) => wallet.provider.request({ method, params }),
  };
}
