// One wallet connection for the whole hub: the button at the top right.
//  - Finds every EVM wallet in the browser (EIP-6963 + older injected objects:
//    MetaMask, Rabby, Trust, OKX, Coinbase, Brave, Binance, Phantom, Keplr, ...);
//    on a phone without one, links that open this page in a wallet app.
//  - Shows the account's ZETAPHY and the tokens it holds on the ZETAPHY chain, and for each the ZETAPHY Saphan
//    token routes it can take out to other chains (planned / closed / open, from hub-config.json).
//  - Connecting here connects Swap, NFT and Stake & vote too: the choice is kept
//    under SHARED_KEY in this site's storage, which the apps in the frames read
//    (same origin) and follow through the "storage" event. Only eth_accounts is
//    used to reconnect (no prompt). The post-quantum wallet keeps its own keys.
// Never stores a key or a signature: only the wallet's id ("6963:io.metamask", or "ledger:<i>" for the
// i-th account of a Ledger over USB: ledger.js, an EIP-1193 shim, so every app's code path is the same).
// Safety (wallet-safety.js): "Use a hardware wallet" help, a banner above BIG_BALANCE, the account
// forgotten after 30 minutes without activity (60 / 120 / 240 to choose in the help), and a summary before each transaction (hub.js send()).
import { safety } from './wallet-safety.js';
import { LEDGER_ID_RE, ledgerId, ledgerProvider, hidSupported, preloadTransport } from './ledger.js';

export const SHARED_KEY = 'zetaphy:wallet';
const ID_RE = /^(6963:[\w.:-]{1,120}|injected:[a-z0-9]{1,20}|ledger:\d{1,3})$/;
/** At or above this many ZETAPHY on the connected account, the hardware-wallet banner shows. */
export const BIG_BALANCE = 1000n * 10n ** 18n;
/** Which help sections the hub shows (EVM with Ledger over USB, Cosmos/Keplr). */
export const HELP = { chains: ['evm', 'cosmos'], ledger: true };
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
/** A stored wallet id, or null when it is not one this site writes. */
export function cleanId(raw) {
  let v = raw;
  try { v = JSON.parse(raw); } catch { /* stored as plain text */ }
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

const BALANCE_OF = '0x70a08231';
const SYMBOL = '0x95d89b41';
const DECIMALS = '0x313ce567';
/** balanceOf(account) call data. */
export const balanceOfData = (account) => BALANCE_OF + account.slice(2).toLowerCase().padStart(64, '0');
// Letters, digits, space and ._- only, at most 12 UTF-16 units; a letter outside the
// BMP (e.g. U+1D400) cut in half by the limit is dropped, not left as a lone surrogate.
const plainShort = (s) => s.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 12).replace(/[\ud800-\udbff]$/, '');
/** An ABI string return value (symbol()), as plain short text; '' when it is not one. */
export function decodeString(hex) {
  try {
    const h = String(hex).replace(/^0x/, '');
    if (h.length === 64) { // bytes32 symbols (old tokens)
      return plainShort(new TextDecoder().decode(Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)))).replace(/\0+$/, ''));
    }
    const len = parseInt(h.slice(64, 128), 16);
    if (!Number.isSafeInteger(len) || len > 64) return '';
    const bytes = Uint8Array.from((h.slice(128, 128 + len * 2).match(/../g) ?? []).map((b) => parseInt(b, 16)));
    return plainShort(new TextDecoder().decode(bytes));
  } catch { return ''; }
}
/** An amount with `decimals` as a short decimal string (at most 4 fraction digits). */
export function formatUnits(v, decimals = 18) {
  const n = BigInt(v);
  const d = 10n ** BigInt(decimals);
  const whole = n / d;
  let frac = (n % d).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {(m: string, p?: any[]) => Promise<any>} o.evmCall  the node's JSON-RPC (reads only)
 * @param {() => Array<{address:string, symbol?:string, decimals?:number, saphan?:Array<{chain:string, symbol:string, state:string}>}>} o.tokens
 *        ZETAPHY-chain tokens to show (saphan: its token routes out, build.mjs chainTokens)
 * @param {() => Array<{chain:string, symbol:string, state:string}>} [o.nativeSaphan]  the native coin's token routes out
 * @param {(k: string) => string} o.T   texts
 * @param {object} o.lib   { discoverWallets, openInAppLinks, evmChainParams, nodeEndpoints, EVM_CHAIN_ID_HEX }
 * @param {() => string} o.node   the node URL (for wallet_addEthereumChain)
 * @param {(account: string|null) => void} [o.onChange]
 * @param {() => string} [o.lang]   the page language (for the safety texts)
 * @param {() => Element|null} [o.bannerHost]  where the large-balance banner goes
 * @param {{check: (address: string) => Promise<boolean>, label: () => string, tip: () => string}} [o.neuroBadge]
 *        the "Neuro-checked" certificate (NeuroAttest.badge, assist.js): shown next to a held token that has one
 */
export function walletBar({ win, evmCall, tokens, T, lib, node, onChange = () => {}, nativeSaphan = () => [], lang = () => 'en', bannerHost = () => null, neuroBadge = null }) {
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const store = {
    get: () => { try { return win.localStorage.getItem(SHARED_KEY); } catch { return null; } },
    set: (v) => { try { win.localStorage.setItem(SHARED_KEY, JSON.stringify(v)); } catch { /* private mode */ } },
    del: () => { try { win.localStorage.removeItem(SHARED_KEY); } catch { /* private mode */ } },
  };
  const el = (tag, attrs = {}, ...kids) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c);
    return e;
  };
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const meta = new Map(); // token address -> { symbol, decimals }
  let wallet = null; // { id, name, provider }
  let account = null;
  let balances = null;
  const discovery = lib.discoverWallets(win, () => { if ($('wb-dialog')?.open && !account) renderDialog(); });
  const sf = safety({ win, lang });
  const chainId = Number(BigInt(lib.EVM_CHAIN_ID_HEX));
  let ledgerW = null;
  /** The Ledger as a wallet entry (index null: not chosen yet; the picker sets it). */
  function ledgerWallet(index = null) {
    if (ledgerW && (index == null || ledgerW.provider.index() === index)) return ledgerW;
    const w = { id: index == null ? 'ledger:new' : ledgerId(index), name: 'Ledger', hardware: true };
    w.provider = ledgerProvider({ win, rpc: evmCall, chainId, index, chooseAccount: sf.chooseAccount, onDevice: sf.deviceToast, onIndex: (i) => { w.id = ledgerId(i); } });
    ledgerW = w;
    return w;
  }
  const isHardware = () => !!(wallet?.hardware || wallet?.provider?.isHardware);

  async function ensureChain(p) {
    try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: lib.EVM_CHAIN_ID_HEX }] }); } catch (e) {
      if (e?.code === 4001) throw e;
      await p.request({ method: 'wallet_addEthereumChain', params: [lib.evmChainParams(lib.nodeEndpoints(node()))] });
    }
  }

  function setAccount(w, a) {
    const changed = a !== account;
    wallet = a ? w : null;
    account = a && ADDR_RE.test(a) ? a : null;
    balances = null;
    render();
    if (changed) { onChange(account); if (account) loadBalances(); }
  }

  async function connect(w, { silent = false } = {}) {
    const accounts = await w.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
    const a = Array.isArray(accounts) ? accounts.find((x) => ADDR_RE.test(x)) : null;
    if (!a) { if (!silent) throw new Error(T('wbNoAccount')); return null; }
    if (!w.subscribed && typeof w.provider.on === 'function') {
      w.subscribed = true;
      w.provider.on('accountsChanged', (x) => { if (wallet === w) setAccount(w, Array.isArray(x) ? x.find((y) => ADDR_RE.test(y)) : null); });
    }
    store.set(w.id);
    setAccount(w, a);
    if (!silent) await ensureChain(w.provider).catch(() => { /* the apps ask again before sending */ });
    return a;
  }

  function disconnect() {
    wallet?.provider?.forget?.();
    if (wallet && wallet === ledgerW) ledgerW = null; // the next Ledger connection asks for the account again
    store.del();
    setAccount(null, null);
  }

  /** Idle: forget the account here and in every page of the site; ask the wallet to drop this site's permission. */
  function forgetIdle() {
    const p = wallet?.provider;
    disconnect();
    p?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })?.catch?.(() => {});
    if ($('wb-dialog')?.open) $('wb-dialog').close();
    sf.idleNotice();
  }

  async function restore() {
    const id = cleanId(store.get());
    if (!id) { if (account) setAccount(null, null); return; }
    if (wallet?.id === id && account) return;
    const m = LEDGER_ID_RE.exec(id);
    const w = m ? ledgerWallet(Number(m[1])) : discovery.list().find((x) => x.id === id);
    if (w) await connect(w, { silent: true }).catch(() => {});
  }

  async function tokenMeta(t) {
    const k = t.address.toLowerCase();
    if (meta.has(k)) return meta.get(k);
    const [s, d] = await Promise.all([
      t.symbol ? t.symbol : evmCall('eth_call', [{ to: t.address, data: SYMBOL }, 'latest']).then(decodeString).catch(() => ''),
      t.decimals != null ? t.decimals : evmCall('eth_call', [{ to: t.address, data: DECIMALS }, 'latest']).then((x) => Number(BigInt(x))).catch(() => 18),
    ]);
    const m = { symbol: s || short(t.address), decimals: Number.isInteger(d) && d >= 0 && d <= 36 ? d : 18 };
    meta.set(k, m);
    return m;
  }

  async function loadBalances() {
    const a = account;
    if (!a) return;
    try {
      const native = BigInt(await evmCall('eth_getBalance', [a, 'latest']));
      const list = await Promise.all(tokens().map(async (t) => {
        const raw = await evmCall('eth_call', [{ to: t.address, data: balanceOfData(a) }, 'latest']).catch(() => '0x0');
        let v = 0n; try { v = BigInt(raw === '0x' ? '0x0' : raw); } catch { v = 0n; }
        const checked = v > 0n && neuroBadge ? await neuroBadge.check(t.address).catch(() => false) : false;
        const logo = typeof t.logo === 'string' && /^[\w-]+\.(png|svg)$/.test(t.logo) ? t.logo : null; // a file of this site
        return { ...(await tokenMeta(t)), address: t.address, value: v, saphan: Array.isArray(t.saphan) ? t.saphan : [], checked, logo };
      }));
      if (a !== account) return;
      balances = { native, tokens: list.filter((x) => x.value > 0n) };
    } catch { if (a === account) balances = { error: true }; }
    render();
    banner();
  }

  function renderDialog() {
    // every token: its picture (logo, else its first letter) with the ZETAPHY network badge, as wallets show a token's chain
    const tokIcon = (logo, sym) => el('span', { class: 'wb-tok', title: 'ZETAPHY' },
      logo ? el('img', { class: 'wb-logo', src: logo, alt: '', width: 20, height: 20 }) : el('span', { class: 'wb-logo wb-letter', 'data-l': String(sym ?? '?').slice(0, 1).toUpperCase(), 'aria-hidden': 'true' }),
      el('img', { class: 'wb-net', src: 'favicon.svg', alt: '', width: 10, height: 10 }));
    const body = $('wb-body');
    body.replaceChildren();
    if (account) {
      body.append(
        el('div', { class: 'wb-acc mono', text: account }, isHardware() ? el('span', { class: 'ws-hw', text: sf.t('hwBadge') }) : null),
        el('h4', { text: T('wbHoldings') }),
        !balances ? el('p', { class: 'dim', text: '…' })
          : balances.error ? el('p', { class: 'dim', text: T('wbNoNode') })
            : el('ul', { class: 'wb-bal' },
              el('li', {}, el('span', {}, tokIcon('logo.svg', 'Z'), 'ZETAPHY'), el('b', { class: 'mono', text: formatUnits(balances.native) })),
              saphanLine(nativeSaphan()),
              balances.tokens.flatMap((x) => [el('li', {}, el('span', { title: x.address },
                tokIcon(x.logo, x.symbol), x.symbol,
                // into the wallet's own token list, with its picture when it has one (EIP-747)
                el('button', { type: 'button', class: 'btn ghost sm wb-add', text: T('wbAddToken'), onclick: () => wallet?.provider?.request({ method: 'wallet_watchAsset',
                  params: { type: 'ERC20', options: { address: x.address, symbol: x.symbol, decimals: x.decimals ?? 18, ...(x.logo ? { image: new URL(x.logo, win.location.href).href } : {}) } } }).catch(() => {}) }),
                x.checked && neuroBadge ? el('span', { class: 'wb-neuro', 'data-badge': 'neuro-checked', title: neuroBadge.tip(), text: ` ✓ ${neuroBadge.label()}` }) : null),
                el('b', { class: 'mono', text: formatUnits(x.value, x.decimals) })),
                saphanLine(x.saphan)])),
        el('p', { class: 'dim small', text: T('wbShared') }),
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn ghost sm', text: T('wbRefresh'), onclick: () => { balances = null; renderDialog(); loadBalances(); } }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T('wbDisconnect'), onclick: () => { disconnect(); $('wb-dialog').close(); } })),
        el('p', { class: 'small' }, sf.helpLink(HELP)),
      );
      return;
    }
    const list = discovery.list();
    if (list.length) {
      body.append(el('div', { class: 'wb-list' }, list.map((w) => el('button', { type: 'button', class: 'wb-wallet', onclick: async () => {
        $('wb-msg').textContent = '';
        try { await connect(w); renderDialog(); } catch (e) { $('wb-msg').textContent = e?.code === 4001 ? T('wbRejected') : String(e?.message ?? e).slice(0, 200); }
      } }, w.icon ? el('img', { src: w.icon, alt: '', width: 24, height: 24 }) : el('span', { class: 'wb-ico' }), el('span', { text: w.name })))));
    } else {
      body.append(el('p', { text: T('wbNone') }), el('div', { class: 'wb-list' }, lib.openInAppLinks(win.location.href).map((l) => el('a', { class: 'wb-wallet', href: l.href, rel: 'noopener noreferrer', text: l.name }))));
    }
    // A Ledger over USB (Chrome, Edge, Brave on a computer); elsewhere: use it through MetaMask / Rabby.
    if (hidSupported(win)) {
      preloadTransport();
      body.append(el('div', { class: 'wb-list' }, el('button', { type: 'button', class: 'wb-wallet', id: 'wb-ledger', onclick: async () => {
        $('wb-msg').textContent = '';
        try { await connect(ledgerWallet()); renderDialog(); } catch (e) { $('wb-msg').textContent = e?.code === 4001 ? T('wbRejected') : String(e?.message ?? e).slice(0, 200); }
      } }, el('span', { class: 'wb-ico' }), el('span', { text: sf.t('ldBtn') }))));
    } else {
      body.append(el('p', { class: 'dim small', text: sf.t('ldNoHid') }));
    }
    body.append(el('p', { class: 'wb-msg bad', id: 'wb-msg', role: 'status' }), el('p', { class: 'dim small', text: T('wbPq') }), el('p', { class: 'small' }, sf.helpLink(HELP)));
  }

  /** "Saphan: zZETAPHY → Sepolia (planned), Base Sepolia (open)": where this token can go out (or nothing). */
  function saphanLine(list) {
    const ok = (Array.isArray(list) ? list : []).filter((r) => typeof r?.chain === 'string' && typeof r?.symbol === 'string');
    if (!ok.length) return null;
    const word = { open: T('wbStOpen'), closed: T('wbStClosed') };
    return el('li', { class: 'wb-saphan dim small', title: T('wbSaphanTip') },
      `${T('wbSaphan')}: ${ok[0].symbol} → ${ok.map((r) => `${r.chain.slice(0, 40)} (${word[r.state] ?? T('wbStPlanned')})`).join(', ')}`);
  }

  function render() {
    const b = $('wb-btn');
    if (!b) return;
    const bal = account && balances && !balances.error ? ` · ${formatUnits(balances.native)} ZETAPHY` : '';
    b.textContent = account ? `${short(account)}${bal}` : T('wbConnect');
    b.classList.toggle('ghost', !!account);
    if ($('wb-dialog')?.open) renderDialog();
    banner();
  }

  /** The large-balance banner (a hardware account, or one under BIG_BALANCE, gets none). */
  function banner() {
    sf.balanceBanner({ host: bannerHost(), amount: account && balances && !balances.error ? balances.native : null, threshold: BIG_BALANCE, symbol: 'ZETAPHY', hardware: isHardware(), help: HELP });
  }

  function mount() {
    $('wb-btn').addEventListener('click', () => { renderDialog(); $('wb-dialog').showModal(); if (account && !balances) loadBalances(); });
    $('wb-close').addEventListener('click', () => $('wb-dialog').close());
    // Another page of this site (an app in a frame, another tab) connected or disconnected.
    win.addEventListener('storage', (e) => { if (e.key === SHARED_KEY || e.key === null) restore(); });
    sf.idleGuard({ active: () => !!account, onIdle: forgetIdle });
    render();
    setTimeout(restore, 400); // EIP-6963 wallets answer within a moment
  }

  return { mount, render, connect, disconnect, restore, refresh: loadBalances, account: () => account, provider: () => wallet?.provider ?? null, ensureChain: () => ensureChain(wallet.provider), open: () => $('wb-btn').click(), safety: sf, isHardware };
}
