// ZETAPHY Swap: the DEX page (static, no server). Reads the chain over
// JSON-RPC (the RPC in deployments.json or Settings, else the connected
// wallet), signs only through the user's wallet (EIP-6963), approves exact
// amounts, checks tokens with Neuro's ThreatRegistry before buying, importing
// or adding liquidity. Every text goes in with textContent.
// localStorage is shared with the rest of the site's origin, so what it holds
// is validated strictly and never trusted for anything that moves funds
// (lib/storage.js). Right before every eth_sendTransaction the wallet's chain
// is asked again (eth_chainId) and the transaction carries chainId 77390.

import { TEXT, pickLang } from './i18n.js';
import { encodeCall, decode, decodeError, decodeBytes32String, parseUnits, formatUnits, isAddress, ZERO_ADDRESS, SEL } from './lib/abi.js';
import { getAmountOut, minWithSlippage, priceImpactBps, impactLevel, quote, candidatePaths, poolKind, addLiquidityMins } from './lib/amm.js';
import { checkToken, checkBadge, reasonText, DISCLAIMER } from './lib/neuro.js';
import { cleanName, cleanSymbol, validEntry, lookalikes } from './lib/tokens.js';
import { EVM_CHAIN_ID, EVM_CHAIN_ID_HEX, EVM_SYMBOL, nodeEndpoints, evmChainParams, discoverWallets, openInAppLinks } from './lib/wallets.js';
import { parseSettings, serializeSettings, parseImported, cleanWalletId, rpcIsCustom, SLIPPAGE_MAX_BPS, SLIPPAGE_CONFIRM_BPS } from './lib/storage.js';
import { createDlmmTab } from './dlmm.js';
import { safety, ledgerReason } from './lib/wallet-safety.js';
import { LEDGER_ID_RE, ledgerId, ledgerProvider, hidSupported, preloadTransport } from './lib/ledger.js';

const $ = (id) => document.getElementById(id);
const BASE = './';
const KEYS = { lang: 'zetaphy-dex:lang', theme: 'zetaphy-dex:theme', settings: 'zetaphy-dex:settings', imported: `zetaphy-dex:imported:${EVM_CHAIN_ID}`, wallet: 'zetaphy-dex:wallet' };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
// One wallet connection for the whole site (zetaphy-hub/walletbar.js): the wallet's id as JSON text.
const SHARED_WALLET = 'zetaphy:wallet';
const sharedWalletId = () => { const raw = store.get(SHARED_WALLET); try { return cleanWalletId(JSON.parse(raw)); } catch { return cleanWalletId(raw); } };
const NATIVE = Object.freeze({ address: 'native', symbol: EVM_SYMBOL, name: 'ZETAPHY', decimals: 18, source: 'native' });
const MAX_POSITIONS_SCAN = 300;
// Wallet safety (lib/wallet-safety.js, shared with the hub): hardware-wallet help, a banner at or above
// BIG_BALANCE, the account forgotten after 30 idle minutes (or 60 / 120 / 240, chosen in the help), a summary before every transaction.
const BIG_BALANCE = 1000n * 10n ** 18n;
const HELP = { chains: ['evm', 'cosmos'], ledger: true };
// Inside the hub (same origin, a frame): the hub shows the banner and runs the idle check for every app.
const IN_HUB = (() => { try { return window.top !== window && !!window.top.document; } catch { return false; } })();

const state = {
  lang: 'en',
  cfg: null,
  tokens: [NATIVE],
  wallet: null, // { id, name, provider }
  account: null,
  chainId: null,
  settings: { slippageBps: 50, deadlineMin: 20, rpc: '', fot: false },
  neuro: new Map(), // address -> { at, result }
  registry: undefined,
  importCandidate: null,
};

const sf = safety({ win: window, lang: () => state.lang });
const st = sf.t; // the safety texts (lib/wallet-safety-i18n.js)

// ---------------------------------------------------------------- i18n / theme

function t(key, vars = {}) {
  const s = TEXT[state.lang]?.[key] ?? TEXT.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

function applyI18n() {
  document.documentElement.lang = state.lang;
  const sel = $('lang-btn');
  sel.value = state.lang;
  sel.setAttribute('aria-label', t('langLabel'));
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  renderConnect();
  $('footer-help').replaceChildren(sf.helpLink(HELP));
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function currentTheme() {
  return document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}

// ---------------------------------------------------------------- small DOM helpers

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
function setStatus(id, text, kind = '') {
  const s = $(id);
  s.textContent = text;
  s.className = 'status' + (kind ? ' ' + kind : '');
}
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmt = (v, dec, frac = 6) => formatUnits(v, dec, frac);

// ---------------------------------------------------------------- JSON-RPC

let rpcId = 0;
function rpcUrl() {
  return state.settings.rpc || state.cfg?.rpc || '';
}
async function rpc(method, params) {
  const url = rpcUrl();
  if (url) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
    });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(String(j.error.message ?? 'RPC error')), { data: j.error.data, code: j.error.code });
    return j.result;
  }
  if (state.wallet && state.chainId === EVM_CHAIN_ID) return state.wallet.provider.request({ method, params });
  throw new Error(t('noRpc'));
}
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const callDecode = async (to, sig, args, types) => decode(types, await ethCall(to, encodeCall(sig, args)));

/** Revert data hidden somewhere in a wallet's or node's error. */
function revertData(e) {
  for (const c of [e?.data, e?.data?.data, e?.error?.data, e?.data?.originalError?.data, e?.info?.error?.data, e?.cause?.data]) {
    if (typeof c === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(c)) return c;
  }
  const m = /0x[0-9a-fA-F]{8,}/.exec(String(e?.message ?? ''));
  return m ? m[0] : null;
}
function errorText(e) {
  if (typeof e?.statusCode === 'number') return st('ldErr', { msg: ledgerReason(e, st) }); // a Ledger status word
  if (e?.code === 4001 || /user (rejected|denied)/i.test(String(e?.message))) return t('rejected');
  const d = decodeError(revertData(e));
  if (d?.name === 'TokenEnforced') return t('err_TokenEnforced', { reason: reasonText(d.args[1])[state.lang] ?? reasonText(d.args[1]).en });
  if (d && TEXT.en[`err_${d.name}`]) return t(`err_${d.name}`);
  if (d?.name === 'Error') return String(d.args[0]).slice(0, 200);
  return String(e?.shortMessage ?? e?.message ?? e).replace(/[\r\n]+/g, ' ').slice(0, 240);
}

// ---------------------------------------------------------------- tokens

const isNative = (tok) => tok.address === 'native';
const addrOf = (tok) => (isNative(tok) ? state.cfg.contracts.wnative : tok.address);
const keyOf = (tok) => tok.address.toLowerCase();
const tokenByKey = (k) => state.tokens.find((x) => keyOf(x) === k);
function tokenByAddress(a) {
  if (state.cfg && a.toLowerCase() === state.cfg.contracts.wnative.toLowerCase()) return NATIVE;
  return state.tokens.find((x) => x.address.toLowerCase() === a.toLowerCase());
}

function loadImported() {
  return parseImported(store.get(KEYS.imported), EVM_CHAIN_ID);
}
function saveImported() {
  store.set(KEYS.imported, JSON.stringify(state.tokens.filter((x) => x.source === 'imported').map(({ address, name, symbol, decimals }) => ({ address, name, symbol, decimals, chainId: EVM_CHAIN_ID }))));
}

function buildTokens(list) {
  const out = [NATIVE];
  const seen = new Set(['native']);
  const w = state.cfg?.contracts?.wnative?.toLowerCase();
  const push = (x) => { if (!x) return; const k = keyOf(x); if (seen.has(k) || k === w) return; seen.add(k); out.push(x); };
  for (const x of state.cfg?.tokens ?? []) push(validEntry({ ...x, source: 'deploy' }, EVM_CHAIN_ID));
  for (const x of list) push(validEntry({ ...x, source: 'list' }, EVM_CHAIN_ID));
  for (const x of loadImported()) push(x);
  state.tokens = out;
}

/** name / symbol / decimals read from the contract (cleaned). Throws if it does not look like an ERC-20. */
async function readTokenInfo(address) {
  const str = async (sig) => {
    const hex = await ethCall(address, encodeCall(sig));
    try { return decode(['string'], hex)[0]; } catch { return decodeBytes32String(hex); }
  };
  const [decimals] = await callDecode(address, 'decimals()', [], ['uint8']);
  if (decimals > 36n) throw new Error('decimals');
  await callDecode(address, 'balanceOf(address)', [ZERO_ADDRESS], ['uint256']);
  const [name, symbol] = await Promise.all([str('name()').catch(() => ''), str('symbol()').catch(() => '')]);
  return { address, name: cleanName(name), symbol: cleanSymbol(symbol), decimals: Number(decimals) };
}

async function balanceOf(tok, who) {
  if (isNative(tok)) return BigInt(await rpc('eth_getBalance', [who, 'latest']));
  return (await callDecode(tok.address, 'balanceOf(address)', [who], ['uint256']))[0];
}
async function allowance(tokenAddress, owner, spender) {
  return (await callDecode(tokenAddress, 'allowance(address,address)', [owner, spender], ['uint256']))[0];
}

function fillSelect(sel, keep) {
  const prev = keep ?? sel.value;
  sel.replaceChildren(...state.tokens.map((x) => el('option', { value: keyOf(x), text: `${x.symbol} · ${x.name}${isNative(x) ? '' : ' · ' + short(x.address)}${x.source === 'imported' ? ` · ⚠ ${t('importedBadge')}` : ''}` })));
  if (prev && tokenByKey(prev)) sel.value = prev;
}
function fillAllSelects() {
  fillSelect($('swap-from'));
  fillSelect($('swap-to'), $('swap-to').value || keyOf(state.tokens[1] ?? NATIVE));
  fillSelect($('add-a'));
  fillSelect($('add-b'), $('add-b').value || keyOf(state.tokens[1] ?? NATIVE));
}

// ---------------------------------------------------------------- DEX reads

const deployed = () => !!(state.cfg?.contracts?.router && isAddress(state.cfg.contracts.router));

async function getPair(a, b) {
  const [p] = await callDecode(state.cfg.contracts.factory, 'getPair(address,address)', [a, b], ['address']);
  return p === ZERO_ADDRESS ? null : p;
}
/** { pair, reserveA, reserveB } for tokens a, b (addresses), or null. */
async function pool(a, b) {
  const pair = await getPair(a, b);
  if (!pair) return null;
  const [[r0, r1], [t0]] = await Promise.all([callDecode(pair, 'getReserves()', [], ['uint112', 'uint112', 'uint32']), callDecode(pair, 'token0()', [], ['address'])]);
  const aIs0 = t0.toLowerCase() === a.toLowerCase();
  return { pair, reserveA: aIs0 ? r0 : r1, reserveB: aIs0 ? r1 : r0 };
}

/** The best path (direct or through the native coin) for amountIn, with each hop's reserves. */
async function bestRoute(tin, tout, amountIn) {
  const a = addrOf(tin), b = addrOf(tout);
  if (a.toLowerCase() === b.toLowerCase()) return null;
  let best = null;
  for (const path of candidatePaths(a, b, state.cfg.contracts.wnative)) {
    const hops = [];
    let amt = amountIn;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      const p = await pool(path[i], path[i + 1]);
      if (!p || p.reserveA === 0n || p.reserveB === 0n) { ok = false; break; }
      const out = getAmountOut(amt, p.reserveA, p.reserveB);
      hops.push({ amountIn: amt, amountOut: out, reserveIn: p.reserveA, reserveOut: p.reserveB });
      amt = out;
    }
    if (ok && (!best || amt > best.out)) best = { path, hops, out: amt };
  }
  return best;
}

async function registryAddress() {
  if (state.registry !== undefined) return state.registry;
  let r = state.cfg?.neuroRegistry && isAddress(state.cfg.neuroRegistry) ? state.cfg.neuroRegistry : null;
  if (!r && deployed()) {
    try { const [x] = await callDecode(state.cfg.contracts.factory, 'threatRegistry()', [], ['address']); if (x !== ZERO_ADDRESS) r = x; } catch { /* old factory */ }
  }
  state.registry = r;
  return r;
}

/** Neuro's answer for a token, cached for a minute. The native coin is never checked. */
async function neuroCheck(address) {
  if (state.cfg && address.toLowerCase() === state.cfg.contracts.wnative.toLowerCase()) return { status: 'clear', reason: 0, via: null, native: true };
  const k = address.toLowerCase();
  const c = state.neuro.get(k);
  if (c && Date.now() - c.at < 60_000) return c.result;
  const result = await checkToken(rpc, await registryAddress(), address);
  // the Neuro-checked certificate (NeuroAttest), when this deployment names one
  if (result.status !== 'nocode') result.badge = await checkBadge(rpc, state.cfg?.contracts?.neuroAttest, address);
  state.neuro.set(k, { at: Date.now(), result });
  return result;
}

/** Neuro's answer asked again now (no cache): right before a trade or an add. */
async function neuroFresh(address) {
  state.neuro.delete(address.toLowerCase());
  return neuroCheck(address);
}

/**
 * Before signing: asks Neuro again about `tokens` (not the native coin). Throws
 * if one is enforced now, or needs an acknowledgement it did not have.
 */
async function recheckNeuro(tokens, acknowledged) {
  for (const tok of tokens) {
    if (isNative(tok)) continue;
    const r = await neuroFresh(tok.address);
    if (r.status === 'enforced') throw new Error(t('refusedEnforced', { sym: tok.symbol }));
    if (needsAck(r) && !acknowledged) throw new Error(t('neuroChanged', { sym: tok.symbol }));
  }
}

/** The worst of several answers, and the token it is about. */
function worstOf(results) {
  const rank = { enforced: 4, flagged: 3, unknown: 2, clear: 1, nocode: 0 };
  return results.reduce((w, r) => ((rank[r.result.status] ?? 0) > (rank[w?.result.status] ?? -1) ? r : w), null);
}

function renderNeuro(box, item) {
  if (!item || item.result.native) { box.hidden = true; return; }
  const { result, token } = item;
  const sym = token?.symbol ?? '?';
  box.className = `neuro ${result.status}`;
  const lines = [el('p', { class: 'neuro-head', text: `${t('neuroTitle')} · ${sym}` })];
  const rt = reasonText(result.reason);
  const reason = rt[state.lang] ?? rt.en;
  if (result.status === 'clear') lines.push(el('p', { text: t('neuroClear') }));
  else if (result.status === 'flagged') lines.push(el('p', { text: t('neuroFlagged', { reason }) }));
  else if (result.status === 'enforced') lines.push(el('p', { text: t('neuroEnforced', { reason }) }));
  else if (result.status === 'unknown') lines.push(el('p', { text: t('neuroUnknown', { why: result.error === 'noRegistry' ? t('neuroNoRegistry') : String(result.error ?? '').slice(0, 80) }) }));
  else if (result.status === 'nocode') lines.push(el('p', { text: t('noCode') }));
  if (result.via && result.status !== 'clear') lines.push(el('p', { class: 'hint', text: t('neuroVia', { via: result.via }) }));
  if (result.badge) lines.push(el('p', { class: 'neuro-badge', 'data-badge': result.badge.checked ? 'checked' : 'revoked', text: t(result.badge.checked ? 'neuroBadge' : 'neuroBadgeRevoked', { uid: String(result.badge.uid), by: `${result.badge.by.slice(0, 8)}…` }) }));
  lines.push(el('p', { class: 'neuro-disclaimer', text: DISCLAIMER[state.lang] ?? DISCLAIMER.en }));
  box.replaceChildren(...lines);
  box.hidden = false;
}
/** Does this answer need the user to tick "I have read"? */
const needsAck = (r) => r && (r.status === 'flagged' || (r.status === 'unknown' && r.error !== 'noRegistry'));

// ---------------------------------------------------------------- wallet

let discovery;
function walletsNow() { return discovery ? discovery.list() : []; }

function renderConnect() {
  const b = $('connect-btn');
  if (!b) return;
  b.textContent = state.account ? short(state.account) : t('connect');
  b.title = state.account ? t('disconnect') : '';
  renderBanner();
}

function renderWalletList() {
  const list = walletsNow();
  $('wallet-list').replaceChildren(...list.map((w) => {
    const b = el('button', { type: 'button', class: 'wallet-btn', onclick: () => connectWallet(w) });
    if (w.icon) b.append(el('img', { src: w.icon, alt: '' }));
    b.append(el('span', { text: w.name }));
    return b;
  }));
  $('wallet-none').hidden = list.length > 0;
  if (!list.length) {
    $('wallet-links').replaceChildren(...openInAppLinks(location.href).map((l) => el('a', { href: l.href, rel: 'noopener noreferrer', text: l.name })));
  }
  // A Ledger over USB (Chrome, Edge, Brave on a computer); elsewhere through MetaMask / Rabby (the help says how).
  if (hidSupported(window)) {
    preloadTransport();
    $('wallet-hw').replaceChildren(el('button', { type: 'button', class: 'wallet-btn', id: 'wallet-ledger', onclick: () => connectWallet(ledgerWallet()) }, el('span', { text: st('ldBtn') })));
  } else $('wallet-hw').replaceChildren(el('p', { class: 'hint', text: st('ldNoHid') }));
  $('wallet-help').replaceChildren(sf.helpLink(HELP));
}

let ledgerW = null;
/** The Ledger as a wallet entry: lib/ledger.js speaks EIP-1193, so connect / send work as for any wallet. */
function ledgerWallet(index = null) {
  if (ledgerW && (index == null || ledgerW.provider.index() === index)) return ledgerW;
  const w = { id: index == null ? 'ledger:new' : ledgerId(index), name: 'Ledger', hardware: true };
  // reads for the Ledger go to the node only (rpc() falls back to the wallet, which would loop)
  const nodeRpc = (m, p) => (rpcUrl() ? rpc(m, p) : Promise.reject(new Error(t('noRpc'))));
  w.provider = ledgerProvider({ win: window, rpc: nodeRpc, chainId: EVM_CHAIN_ID, index, chooseAccount: sf.chooseAccount, onDevice: sf.deviceToast, onIndex: (i) => { w.id = ledgerId(i); } });
  ledgerW = w;
  return w;
}
const isHardware = () => !!(state.wallet?.hardware || state.wallet?.provider?.isHardware);

/** The large-balance banner (ZETAPHY on the connected account; none for a hardware account or inside the hub). */
let bannerSeq = 0;
async function renderSafetyBanner() {
  const host = $('ws-host');
  if (IN_HUB || !host) return;
  const seq = ++bannerSeq;
  let amount = null;
  if (state.account && state.chainId === EVM_CHAIN_ID) amount = await balanceOf(NATIVE, state.account).catch(() => null);
  if (seq !== bannerSeq) return;
  sf.balanceBanner({ host, amount, threshold: BIG_BALANCE, symbol: 'ZETAPHY', hardware: isHardware(), help: HELP });
}

async function connectWallet(w, silent = false) {
  try {
    setStatus('wallet-status', '');
    const accounts = await w.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
    const acc = Array.isArray(accounts) ? accounts.find(isAddress) : null;
    if (!acc) return;
    state.wallet = w;
    state.account = acc;
    state.chainId = Number(BigInt(await w.provider.request({ method: 'eth_chainId' })));
    if (w.id === 'ledger:new') return; // the account picker was closed
    store.set(KEYS.wallet, w.id);
    if (sharedWalletId() !== w.id) store.set(SHARED_WALLET, JSON.stringify(w.id));
    if (typeof w.provider.on === 'function' && !w.subscribed) {
      w.subscribed = true;
      w.provider.on('accountsChanged', (a) => { if (state.wallet !== w) return; state.account = Array.isArray(a) && isAddress(a[0]) ? a[0] : null; if (!state.account) state.wallet = null; refreshAll(); });
      w.provider.on('chainChanged', (c) => { if (state.wallet !== w) return; try { state.chainId = Number(BigInt(c)); } catch { state.chainId = null; } refreshAll(); });
    }
    if ($('wallet-dialog').open) $('wallet-dialog').close();
    if (!silent && state.chainId !== EVM_CHAIN_ID) await ensureChain().catch(() => {});
    refreshAll();
  } catch (e) {
    if (!silent) setStatus('wallet-status', errorText(e), 'err');
  }
}

function disconnect({ everywhere = true } = {}) {
  state.wallet?.provider?.forget?.();
  if (state.wallet && state.wallet === ledgerW) ledgerW = null;
  state.wallet = null;
  state.account = null;
  state.chainId = null;
  store.del(KEYS.wallet);
  if (everywhere) store.del(SHARED_WALLET);
  refreshAll();
}

/** Switches the wallet to ZETAPHY, adding the network (ticker ZTPHY) if it does not know it. */
async function ensureChain() {
  const p = state.wallet?.provider;
  if (!p) throw new Error(t('connect'));
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: EVM_CHAIN_ID_HEX }] });
  } catch (e) {
    if (e?.code === 4001) throw e;
    // Only the deployment's RPC goes to the wallet, never one from Settings (storage can be written by other pages of this origin).
    let ep;
    try { ep = nodeEndpoints(state.cfg?.rpc || ''); } catch { throw new Error(t('addNetFailed', { msg: t('noDefaultRpc') })); }
    try {
      await p.request({ method: 'wallet_addEthereumChain', params: [evmChainParams(ep)] });
    } catch (e2) { throw new Error(t('addNetFailed', { msg: errorText(e2) })); }
  }
  state.chainId = Number(BigInt(await p.request({ method: 'eth_chainId' })));
}

/** Simulates, sends through the wallet, waits for the receipt. Updates `statusId`. */
async function sendTx(tx, statusId) {
  if (!state.account) throw new Error(t('connect'));
  if (state.chainId !== EVM_CHAIN_ID) await ensureChain();
  const call = { from: state.account, to: tx.to, data: tx.data, ...(tx.value ? { value: '0x' + tx.value.toString(16) } : {}) };
  // A dry run first: a revert is explained before the wallet shows anything.
  await rpc('eth_call', [call, 'latest']);
  // The wallet's chain, asked again right before signing (it may have switched without telling the page).
  const provider = state.wallet.provider;
  let cid = null;
  try { cid = Number(BigInt(await provider.request({ method: 'eth_chainId' }))); } catch { cid = null; }
  if (cid !== EVM_CHAIN_ID) {
    state.chainId = cid;
    renderBanner();
    throw new Error(t('chainChangedSend', { id: String(cid) }));
  }
  // What is about to be signed, in the page (the wallet or device shows it next): network, contract, value, action.
  const data = await sf.confirmTx({ network: `ZETAPHY (${EVM_CHAIN_ID})`, from: state.account, to: tx.to, toLabel: labelOf(tx.to), value: tx.value ?? 0n, symbol: EVM_SYMBOL,
    data: tx.data, action: actionOf(tx.data), token: tokenByAddress(tx.to) ?? undefined, exact: tx.exact });
  if (data == null) throw new Error(st('cfCancelled'));
  call.data = data;
  setStatus(statusId, t('confirmInWallet'));
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...call, chainId: EVM_CHAIN_ID_HEX }] });
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('wallet returned no transaction hash');
  setStatus(statusId, t('waiting', { hash: short(hash) }));
  for (let i = 0; i < 120; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) {
      if (r.status !== '0x1') throw new Error(`transaction ${short(hash)} reverted`);
      setStatus(statusId, t('done', { hash: short(hash) }), 'ok');
      return hash;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`no receipt for ${short(hash)} yet`);
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + state.settings.deadlineMin * 60);

// For the summary: what a contract address is, and the method a call runs.
const METHOD = Object.fromEntries(Object.entries(SEL).map(([sig, sel]) => [sel, sig.slice(0, sig.indexOf('('))]));
function labelOf(to) {
  const c = state.cfg?.contracts ?? {};
  const names = { router: 'Router', factory: 'Factory', wnative: 'WZETAPHY', dlmmRouter: 'DLMM router', dlmmFactory: 'DLMM factory' };
  for (const [k, n] of Object.entries(names)) if (isAddress(c[k]) && c[k].toLowerCase() === to.toLowerCase()) return n;
  const tok = tokenByAddress(to);
  return tok ? tok.symbol : '';
}
const actionOf = (data) => (typeof data === 'string' && data.length >= 10 ? METHOD[data.slice(0, 10).toLowerCase()] ?? '' : '');

// ---------------------------------------------------------------- banner

function renderBanner() {
  const b = $('banner');
  if (!b) return;
  const parts = [];
  if (!deployed()) parts.push(el('p', { text: t('notDeployed') }));
  else if (!rpcUrl() && !(state.wallet && state.chainId === EVM_CHAIN_ID)) parts.push(el('p', { text: t('noRpc') }));
  if (rpcIsCustom(state.settings.rpc, state.cfg?.rpc ?? '')) {
    parts.push(el('p', { id: 'banner-rpc', text: t('customRpc', { url: state.settings.rpc }) }));
    parts.push(el('button', { type: 'button', id: 'banner-rpc-default', text: t('useDefaultRpc'), onclick: () => {
      state.settings = { ...state.settings, rpc: '' };
      store.set(KEYS.settings, serializeSettings(state.settings));
      state.registry = undefined;
      state.neuro.clear();
      refreshAll();
    } }));
  }
  if (state.account && state.chainId !== EVM_CHAIN_ID) {
    parts.push(el('p', { text: t('wrongNet', { id: String(state.chainId) }) }));
    parts.push(el('button', { type: 'button', text: t('switchNet'), onclick: () => ensureChain().then(refreshAll).catch((e) => { b.append(el('p', { text: errorText(e) })); }) }));
  }
  b.replaceChildren(...parts);
  b.hidden = parts.length === 0;
}

// ---------------------------------------------------------------- imported tokens, high slippage

/** A warning line when one of `tokens` was imported by hand (not in the list). */
function showImported(box, tokens) {
  const tok = tokens.find((x) => x?.source === 'imported');
  box.hidden = !tok;
  if (tok) box.textContent = t('importedWarn', { sym: tok.symbol, addr: tok.address });
}

/** Shows `<prefix>-ack-slip-row` if the slippage setting is above 1%; returns whether a confirmation is needed. */
function showSlipAck(prefix) {
  const bps = state.settings.slippageBps;
  const need = bps > SLIPPAGE_CONFIRM_BPS;
  $(`${prefix}-ack-slip-row`).hidden = !need;
  if (need) $(`${prefix}-ack-slip-text`).textContent = t('slipAck', { s: (bps / 100).toString() });
  else $(`${prefix}-ack-slip`).checked = false;
  return need;
}

// ---------------------------------------------------------------- swap

let swapSeq = 0;
let swapPlan = null;

function swapTokens() {
  return { tin: tokenByKey($('swap-from').value) ?? NATIVE, tout: tokenByKey($('swap-to').value) ?? NATIVE };
}

function swapButton(text, enabled) {
  const b = $('swap-btn');
  b.textContent = text;
  b.disabled = !enabled;
}

async function updateSwap() {
  const seq = ++swapSeq;
  swapPlan = null;
  $('swap-approve').hidden = true;
  $('swap-details').hidden = true;
  $('swap-ack-impact-row').hidden = true;
  $('swap-ack-flag-row').hidden = true;
  $('swap-ack-slip-row').hidden = true;
  const { tin, tout } = swapTokens();
  showImported($('swap-imported'), [tout, tin]);
  $('swap-amount-out').textContent = '0.0';
  if (!deployed()) { swapButton(t('notDeployed'), false); $('swap-neuro').hidden = true; return; }
  // balances
  if (state.account) {
    Promise.all([balanceOf(tin, state.account), balanceOf(tout, state.account)]).then(([bi, bo]) => {
      if (seq !== swapSeq) return;
      $('swap-from-bal').textContent = t('balance', { v: fmt(bi, tin.decimals) });
      $('swap-to-bal').textContent = t('balance', { v: fmt(bo, tout.decimals) });
    }).catch(() => {});
  } else { $('swap-from-bal').textContent = ''; $('swap-to-bal').textContent = ''; }

  if (keyOf(tin) === keyOf(tout)) { swapButton(t('sameToken'), false); return; }
  let amountIn;
  try { amountIn = parseUnits($('swap-amount-in').value || '0', tin.decimals); } catch { amountIn = 0n; }
  // Neuro on the token bought (and the hop in between), even before an amount is typed.
  const checks = [];
  try {
    for (const tok of [tout]) if (!isNative(tok)) checks.push({ token: tok, result: await neuroCheck(tok.address) });
  } catch (e) { checks.push({ token: tout, result: { status: 'unknown', reason: 0, via: null, error: errorText(e) } }); }
  if (seq !== swapSeq) return;
  const worst = worstOf(checks);
  renderNeuro($('swap-neuro'), worst);
  if (amountIn === 0n) { swapButton(t('enterAmount'), false); return; }

  let route;
  try { route = await bestRoute(tin, tout, amountIn); } catch (e) { if (seq === swapSeq) { swapButton(t('rpcError', { msg: errorText(e) }), false); } return; }
  if (seq !== swapSeq) return;
  if (!route || route.out === 0n) { swapButton(t('noPool'), false); return; }

  const minOut = minWithSlippage(route.out, state.settings.slippageBps);
  const impact = priceImpactBps(route.hops);
  const level = impactLevel(impact);
  $('swap-amount-out').textContent = fmt(route.out, tout.decimals, 8);
  const rate = (route.out * 10n ** BigInt(tin.decimals)) / amountIn;
  $('swap-rate').textContent = `1 ${tin.symbol} ≈ ${fmt(rate, tout.decimals, 8)} ${tout.symbol}`;
  $('swap-impact').textContent = `${(Number(impact) / 100).toFixed(2)}%`;
  $('swap-impact').className = `impact-${level}`;
  $('swap-min-label').textContent = t('minReceived', { s: (state.settings.slippageBps / 100).toString() });
  $('swap-min').textContent = `${fmt(minOut, tout.decimals, 8)} ${tout.symbol}`;
  $('swap-route').textContent = route.path.map((a) => tokenByAddress(a)?.symbol ?? short(a)).join(' → ');
  $('swap-details').hidden = false;

  // Intermediate hop (through the native coin) is never a flagged token, so `worst` covers the path.
  if (worst?.result.status === 'enforced') { swapButton(t('refusedEnforced', { sym: worst.token.symbol }), false); return; }
  if (needsAck(worst?.result)) $('swap-ack-flag-row').hidden = false;
  if (level === 'severe') {
    $('swap-ack-impact-text').textContent = t('impactHighAck', { v: (Number(impact) / 100).toFixed(2) });
    $('swap-ack-impact-row').hidden = false;
  }
  const slipAck = showSlipAck('swap');
  swapPlan = { tin, tout, amountIn, route, minOut, flagAck: needsAck(worst?.result), impactAck: level === 'severe', slipAck };

  if (!state.account) { swapButton(t('connect'), true); return; }
  if (state.chainId !== EVM_CHAIN_ID) { swapButton(t('switchNet'), true); return; }
  try {
    const bal = await balanceOf(tin, state.account);
    if (seq !== swapSeq) return;
    if (bal < amountIn) { swapButton(t('insufficient', { sym: tin.symbol }), false); return; }
    if (!isNative(tin)) {
      const al = await allowance(tin.address, state.account, state.cfg.contracts.router);
      if (seq !== swapSeq) return;
      if (al < amountIn) {
        const a = $('swap-approve');
        a.textContent = t('approve', { amount: fmt(amountIn, tin.decimals, 8), sym: tin.symbol });
        a.hidden = false;
        a.disabled = false;
        swapPlan.needsApproval = true;
      }
    }
  } catch (e) { swapButton(t('rpcError', { msg: errorText(e) }), false); return; }
  checkSwapReady();
}

function checkSwapReady() {
  if (!swapPlan || !state.account || state.chainId !== EVM_CHAIN_ID) return;
  const ok = !swapPlan.needsApproval && (!swapPlan.flagAck || $('swap-ack-flag').checked) && (!swapPlan.impactAck || $('swap-ack-impact').checked)
    && (!swapPlan.slipAck || $('swap-ack-slip').checked);
  swapButton(t('swap'), ok);
}

async function onSwapClick() {
  if (!state.account) { openWallets(); return; }
  if (state.chainId !== EVM_CHAIN_ID) { await ensureChain().catch((e) => setStatus('swap-status', errorText(e), 'err')); refreshAll(); return; }
  const p = swapPlan;
  if (!p) return;
  if (p.slipAck && !$('swap-ack-slip').checked) return;
  const { tin, tout, amountIn, route, minOut } = p;
  const fot = state.settings.fot;
  const to = state.account;
  let sig, args, value = 0n;
  if (isNative(tin)) {
    sig = fot ? 'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)' : 'swapExactETHForTokens(uint256,address[],address,uint256)';
    args = [minOut, route.path, to, deadline()];
    value = amountIn;
  } else if (isNative(tout)) {
    sig = fot ? 'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)' : 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)';
    args = [amountIn, minOut, route.path, to, deadline()];
  } else {
    sig = fot ? 'swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)' : 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)';
    args = [amountIn, minOut, route.path, to, deadline()];
  }
  $('swap-btn').disabled = true;
  try {
    await recheckNeuro([tout], p.flagAck && $('swap-ack-flag').checked);
    await sendTx({ to: state.cfg.contracts.router, data: encodeCall(sig, args), value }, 'swap-status');
    $('swap-amount-in').value = '';
  } catch (e) {
    setStatus('swap-status', t('failed', { msg: errorText(e) }), 'err');
  }
  $('swap-ack-slip').checked = false; // a fresh confirmation for every transaction
  updateSwap();
}

async function onSwapApprove() {
  const p = swapPlan;
  if (!p) return;
  $('swap-approve').disabled = true;
  try {
    setStatus('swap-status', t('approving'));
    await sendTx({ to: p.tin.address, data: encodeCall('approve(address,uint256)', [state.cfg.contracts.router, p.amountIn]) }, 'swap-status');
  } catch (e) { setStatus('swap-status', t('failed', { msg: errorText(e) }), 'err'); }
  updateSwap();
}

// ---------------------------------------------------------------- add liquidity

let addSeq = 0;
let addPlan = null;
let addEdited = 'a';

async function updateAdd(source) {
  if (source === 'a' || source === 'b') addEdited = source;
  const seq = ++addSeq;
  addPlan = null;
  $('add-approve-a').hidden = true;
  $('add-approve-b').hidden = true;
  $('add-ack-flag-row').hidden = true;
  $('add-ack-slip-row').hidden = true;
  const btn = $('add-btn');
  const set = (text, en) => { btn.textContent = text; btn.disabled = !en; };
  $('add-info').textContent = '';
  if (!deployed()) { set(t('notDeployed'), false); $('add-neuro').hidden = true; return; }
  const ta = tokenByKey($('add-a').value) ?? NATIVE;
  const tb = tokenByKey($('add-b').value) ?? NATIVE;
  showImported($('add-imported'), [ta, tb]);
  if (keyOf(ta) === keyOf(tb)) { set(t('sameToken'), false); return; }
  if (state.account) {
    Promise.all([balanceOf(ta, state.account), balanceOf(tb, state.account)]).then(([x, y]) => {
      if (seq !== addSeq) return;
      $('add-a-bal').textContent = t('balance', { v: fmt(x, ta.decimals) });
      $('add-b-bal').textContent = t('balance', { v: fmt(y, tb.decimals) });
    }).catch(() => {});
  }
  let p, checks, ts = 0n;
  try {
    [p, checks] = await Promise.all([
      pool(addrOf(ta), addrOf(tb)),
      Promise.all([ta, tb].filter((x) => !isNative(x)).map(async (tok) => ({ token: tok, result: await neuroCheck(tok.address) }))),
    ]);
    if (p) [ts] = await callDecode(p.pair, 'totalSupply()', [], ['uint256']);
  } catch (e) { if (seq === addSeq) set(t('rpcError', { msg: errorText(e) }), false); return; }
  if (seq !== addSeq) return;
  const worst = worstOf(checks);
  renderNeuro($('add-neuro'), worst);

  const parse = (id, dec) => { try { return parseUnits($(id).value || '0', dec); } catch { return 0n; } };
  let amtA = parse('add-amt-a', ta.decimals);
  let amtB = parse('add-amt-b', tb.decimals);
  // Only a pool with LP has a price to follow. Reserves without LP (a donation
  // and sync()) are a new pool: the user enters both amounts (finding M3).
  const kind = poolKind(p, ts);
  const info = $('add-info');
  info.className = 'hint';
  if (kind === 'live') {
    if (addEdited === 'a' && amtA > 0n) { amtB = quote(amtA, p.reserveA, p.reserveB); $('add-amt-b').value = formatUnits(amtB, tb.decimals, tb.decimals).replace(/,/g, ''); }
    else if (addEdited === 'b' && amtB > 0n) { amtA = quote(amtB, p.reserveB, p.reserveA); $('add-amt-a').value = formatUnits(amtA, ta.decimals, ta.decimals).replace(/,/g, ''); }
    const price = (p.reserveB * 10n ** BigInt(ta.decimals)) / p.reserveA;
    let text = t('poolPrice', { a: ta.symbol, p: fmt(price, tb.decimals, 8), b: tb.symbol });
    if (amtA > 0n) {
      const liq = (amtA * ts) / p.reserveA;
      text += ' · ' + t('poolShare', { v: ((Number(liq) / Number(ts + liq)) * 100).toFixed(4) });
    }
    info.textContent = text;
  } else if (kind === 'unseeded') {
    info.className = 'warn-line';
    info.textContent = t('unseededPool');
  } else {
    info.textContent = t('newPool');
  }
  if (worst?.result.status === 'enforced') { set(t('refusedEnforced', { sym: worst.token.symbol }), false); return; }
  if (needsAck(worst?.result)) $('add-ack-flag-row').hidden = false;
  if (amtA === 0n || amtB === 0n) { set(t('enterAmount'), false); return; }
  addPlan = { ta, tb, amtA, amtB, kind, flagAck: needsAck(worst?.result), slipAck: kind === 'live' && showSlipAck('add') };
  if (!state.account) { set(t('connect'), true); return; }
  if (state.chainId !== EVM_CHAIN_ID) { set(t('switchNet'), true); return; }
  try {
    for (const [tok, amt, bid] of [[ta, amtA, 'add-approve-a'], [tb, amtB, 'add-approve-b']]) {
      const bal = await balanceOf(tok, state.account);
      if (bal < amt) { set(t('insufficient', { sym: tok.symbol }), false); return; }
      if (!isNative(tok) && (await allowance(tok.address, state.account, state.cfg.contracts.router)) < amt) {
        const b = $(bid);
        b.textContent = t('approve', { amount: fmt(amt, tok.decimals, 8), sym: tok.symbol });
        b.hidden = false;
        b.disabled = false;
        b.onclick = () => approveFor(tok, amt, 'add-status').then(() => updateAdd());
        addPlan.needsApproval = true;
      }
    }
  } catch (e) { set(t('rpcError', { msg: errorText(e) }), false); return; }
  if (seq !== addSeq) return;
  set(t('add'), !addPlan.needsApproval && (!addPlan.flagAck || $('add-ack-flag').checked) && (!addPlan.slipAck || $('add-ack-slip').checked));
}

async function approveFor(tok, amount, statusId) {
  try {
    setStatus(statusId, t('approving'));
    await sendTx({ to: tok.address, data: encodeCall('approve(address,uint256)', [state.cfg.contracts.router, amount]) }, statusId);
  } catch (e) { setStatus(statusId, t('failed', { msg: errorText(e) }), 'err'); }
}

async function onAddClick() {
  if (!state.account) { openWallets(); return; }
  if (state.chainId !== EVM_CHAIN_ID) { await ensureChain().catch((e) => setStatus('add-status', errorText(e), 'err')); refreshAll(); return; }
  const p = addPlan;
  if (!p) return;
  if (p.slipAck && !$('add-ack-slip').checked) return;
  // A new or unseeded pool: min = desired, so the router reverts if the ratio changed (finding M3).
  const [minA, minB] = addLiquidityMins(p.amtA, p.amtB, p.kind, state.settings.slippageBps);
  let tx;
  if (isNative(p.ta) || isNative(p.tb)) {
    const [tok, amtTok, amtNat, minTok, minNat] = isNative(p.ta) ? [p.tb, p.amtB, p.amtA, minB, minA] : [p.ta, p.amtA, p.amtB, minA, minB];
    tx = { to: state.cfg.contracts.router, value: amtNat,
      data: encodeCall('addLiquidityETH(address,uint256,uint256,uint256,address,uint256)', [tok.address, amtTok, minTok, minNat, state.account, deadline()]) };
  } else {
    tx = { to: state.cfg.contracts.router,
      data: encodeCall('addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)', [p.ta.address, p.tb.address, p.amtA, p.amtB, minA, minB, state.account, deadline()]) };
  }
  $('add-btn').disabled = true;
  try {
    setStatus('add-status', t('adding'));
    await recheckNeuro([p.ta, p.tb], p.flagAck && $('add-ack-flag').checked);
    await sendTx(tx, 'add-status');
    $('add-amt-a').value = '';
    $('add-amt-b').value = '';
    loadPositions();
  } catch (e) { setStatus('add-status', t('failed', { msg: errorText(e) }), 'err'); }
  $('add-ack-slip').checked = false;
  updateAdd();
}

// ---------------------------------------------------------------- positions

async function tokenMeta(address) {
  const known = tokenByAddress(address);
  if (known) return known;
  try { return { ...(await readTokenInfo(address)), source: 'unlisted' }; } catch { return { address, symbol: short(address), name: '?', decimals: 18, source: 'unlisted' }; }
}

async function loadPositions() {
  const box = $('positions');
  if (!deployed()) { box.replaceChildren(); return; }
  if (!state.account) { box.replaceChildren(el('p', { class: 'hint', text: t('connectToSee') })); return; }
  try {
    const f = state.cfg.contracts.factory;
    const [n] = await callDecode(f, 'allPairsLength()', [], ['uint256']);
    const count = Number(n > BigInt(MAX_POSITIONS_SCAN) ? BigInt(MAX_POSITIONS_SCAN) : n);
    const found = [];
    for (let i = 0; i < count; i += 8) {
      const batch = await Promise.all(Array.from({ length: Math.min(8, count - i) }, async (_, j) => {
        const [pair] = await callDecode(f, 'allPairs(uint256)', [BigInt(i + j)], ['address']);
        const [lp] = await callDecode(pair, 'balanceOf(address)', [state.account], ['uint256']);
        return { pair, lp };
      }));
      found.push(...batch.filter((x) => x.lp > 0n));
    }
    const items = [];
    for (const { pair, lp } of found) {
      const [[t0], [t1], [r0, r1], [ts]] = await Promise.all([
        callDecode(pair, 'token0()', [], ['address']), callDecode(pair, 'token1()', [], ['address']),
        callDecode(pair, 'getReserves()', [], ['uint112', 'uint112', 'uint32']), callDecode(pair, 'totalSupply()', [], ['uint256'])]);
      const [m0, m1] = await Promise.all([tokenMeta(t0), tokenMeta(t1)]);
      items.push(positionItem({ pair, lp, t0, t1, r0, r1, ts, m0, m1 }));
    }
    box.replaceChildren(...(items.length ? items : [el('p', { class: 'hint', text: t('noPositions') })]));
    if (items.length) showSlipAck('pos'); else $('pos-ack-slip-row').hidden = true;
  } catch (e) { setStatus('pos-status', t('rpcError', { msg: errorText(e) }), 'err'); }
}

function positionItem(pos) {
  const { lp, r0, r1, ts, m0, m1 } = pos;
  const share = (Number((lp * 1_000_000n) / ts) / 10_000).toFixed(4);
  const u0 = (lp * r0) / ts, u1 = (lp * r1) / ts;
  const main = el('div', { class: 'main' },
    el('span', { class: 'sym', text: `${m0.symbol} / ${m1.symbol}` }),
    el('span', { class: 'sub', text: `${t('lpTokens', { v: fmt(lp, 18) })} · ${t('shareOf', { v: share })}` }),
    el('span', { class: 'sub', text: t('underlying', { a: `${fmt(u0, m0.decimals)} ${m0.symbol}`, b: `${fmt(u1, m1.decimals)} ${m1.symbol}` }) }),
    el('span', { class: 'sub', text: short(pos.pair) }));
  const btns = el('div', { class: 'btns' }, ...[25, 50, 100].map((pct) => el('button', { type: 'button', class: 'ghost small', text: t('remove', { p: pct }), dataset: { remove: String(pct), pair: pos.pair }, onclick: (ev) => removeLiquidity(pos, pct, ev.currentTarget) })));
  return el('div', { class: 'item' }, main, btns);
}

async function removeLiquidity(pos, pct, button) {
  if (!state.account) { openWallets(); return; }
  if (showSlipAck('pos') && !$('pos-ack-slip').checked) { setStatus('pos-status', t('slipAck', { s: (state.settings.slippageBps / 100).toString() }), 'err'); return; }
  button.disabled = true;
  const router = state.cfg.contracts.router;
  const liq = (pos.lp * BigInt(pct)) / 100n;
  const bps = state.settings.slippageBps;
  try {
    const al = await allowance(pos.pair, state.account, router);
    if (al < liq) {
      setStatus('pos-status', t('approveLp', { v: fmt(liq, 18) }));
      await sendTx({ to: pos.pair, data: encodeCall('approve(address,uint256)', [router, liq]) }, 'pos-status');
    }
    const min0 = minWithSlippage((liq * pos.r0) / pos.ts, bps);
    const min1 = minWithSlippage((liq * pos.r1) / pos.ts, bps);
    const w = state.cfg.contracts.wnative.toLowerCase();
    let data;
    if (pos.t0.toLowerCase() === w || pos.t1.toLowerCase() === w) {
      const tokIs0 = pos.t1.toLowerCase() === w;
      const [token, minTok, minNat] = tokIs0 ? [pos.t0, min0, min1] : [pos.t1, min1, min0];
      data = state.settings.fot
        ? encodeCall('removeLiquidityETHSupportingFeeOnTransferTokens(address,uint256,uint256,uint256,address,uint256)', [token, liq, minTok, minNat, state.account, deadline()])
        : encodeCall('removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)', [token, liq, minTok, minNat, state.account, deadline()]);
    } else {
      data = encodeCall('removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)', [pos.t0, pos.t1, liq, min0, min1, state.account, deadline()]);
    }
    setStatus('pos-status', t('removing'));
    await sendTx({ to: router, data }, 'pos-status');
  } catch (e) { setStatus('pos-status', t('failed', { msg: errorText(e) }), 'err'); }
  $('pos-ack-slip').checked = false;
  loadPositions();
}

// ---------------------------------------------------------------- token list / import

function renderTokenList() {
  const srcText = { native: t('srcNative'), list: t('srcList'), deploy: t('srcDeploy'), imported: t('srcImported') };
  $('token-list').replaceChildren(...state.tokens.map((tok) => {
    const main = el('div', { class: 'main' },
      el('span', { class: 'sym', text: tok.symbol }),
      el('span', { class: 'sub', text: tok.name }),
      el('span', { class: 'sub', text: isNative(tok) ? (state.cfg?.contracts?.wnative ?? '') : tok.address }));
    const right = el('div', { class: 'btns' }, el('span', { class: 'tag', text: srcText[tok.source] ?? tok.source }));
    if (tok.source === 'imported') {
      right.append(el('button', { type: 'button', class: 'ghost small', text: t('removeToken'), onclick: () => {
        state.tokens = state.tokens.filter((x) => x !== tok);
        saveImported();
        fillAllSelects();
        renderTokenList();
      } }));
    }
    return el('div', { class: 'item', dataset: { token: keyOf(tok) } }, main, right);
  }));
}

async function onImportCheck() {
  const addr = $('import-addr').value.trim();
  state.importCandidate = null;
  $('import-result').hidden = true;
  setStatus('import-status', '');
  if (!isAddress(addr)) { setStatus('import-status', t('badAddress'), 'err'); return; }
  if (state.tokens.some((x) => x.address.toLowerCase() === addr.toLowerCase()) || addr.toLowerCase() === state.cfg?.contracts?.wnative?.toLowerCase()) {
    setStatus('import-status', t('already'), 'err');
    return;
  }
  $('import-check').disabled = true;
  setStatus('import-status', t('checking'));
  try {
    const code = await rpc('eth_getCode', [addr, 'latest']);
    if (!code || code === '0x') { setStatus('import-status', t('noCode'), 'err'); return; }
    let info;
    try { info = await readTokenInfo(addr); } catch { setStatus('import-status', t('notErc20'), 'err'); return; }
    const neuro = await neuroCheck(addr);
    const looks = lookalikes(info, state.tokens);
    $('import-info').textContent = t('asWritten', { name: info.name, sym: info.symbol, dec: info.decimals });
    $('import-warnings').replaceChildren(...looks.map((o) => el('p', { class: 'warn-line', text: '⚠ ' + t('lookalike', { sym: o.symbol, addr: short(isNative(o) ? state.cfg.contracts.wnative : o.address) }) })));
    renderNeuro($('import-neuro'), { token: info, result: neuro });
    const enforced = neuro.status === 'enforced';
    const ack = !enforced && (needsAck(neuro) || looks.length > 0);
    $('import-ack').checked = false;
    $('import-ack-row').hidden = !ack;
    $('import-add').hidden = enforced;
    $('import-add').disabled = ack;
    $('import-result').hidden = false;
    state.importCandidate = enforced ? null : { ...info, source: 'imported', ack };
    setStatus('import-status', enforced ? t('refusedEnforced', { sym: info.symbol }) : '', enforced ? 'err' : '');
  } catch (e) {
    setStatus('import-status', t('rpcError', { msg: errorText(e) }), 'err');
  } finally { $('import-check').disabled = false; }
}

function onImportAdd() {
  const c = state.importCandidate;
  if (!c || (c.ack && !$('import-ack').checked)) return;
  const entry = validEntry({ ...c, chainId: EVM_CHAIN_ID }, EVM_CHAIN_ID);
  if (!entry) return;
  state.tokens.push({ ...entry, source: 'imported' });
  saveImported();
  fillAllSelects();
  renderTokenList();
  $('import-result').hidden = true;
  $('import-addr').value = '';
  state.importCandidate = null;
  setStatus('import-status', t('imported', { sym: entry.symbol }), 'ok');
}

// ---------------------------------------------------------------- settings

/** Strictly validated (lib/storage.js): slippage <= 5%, a clean RPC URL, the fee-on-transfer switch never read back. */
function loadSettings() {
  state.settings = parseSettings(store.get(KEYS.settings));
}

function openSettings() {
  $('set-slippage').value = String(state.settings.slippageBps / 100);
  $('set-deadline').value = String(state.settings.deadlineMin);
  $('set-rpc').value = state.settings.rpc;
  $('set-fot').checked = state.settings.fot;
  setStatus('settings-status', '');
  $('settings-dialog').showModal();
}

function saveSettings() {
  const sl = Number($('set-slippage').value);
  const dl = Number($('set-deadline').value);
  const rpcText = $('set-rpc').value.trim();
  if (!(sl >= 0.01 && sl <= SLIPPAGE_MAX_BPS / 100)) { setStatus('settings-status', `${t('slippage')}: 0.01 – ${SLIPPAGE_MAX_BPS / 100}`, 'err'); return; }
  if (!(Number.isInteger(dl) && dl >= 1 && dl <= 180)) { setStatus('settings-status', t('deadline') + ': 1 – 180', 'err'); return; }
  let rpcValue = '';
  if (rpcText) {
    try { rpcValue = nodeEndpoints(rpcText).evm; } catch { setStatus('settings-status', t('rpcUrl'), 'err'); return; }
  }
  state.settings = { slippageBps: Math.round(sl * 100), deadlineMin: dl, rpc: rpcValue, fot: $('set-fot').checked };
  store.set(KEYS.settings, serializeSettings(state.settings)); // fot is for this visit only
  for (const id of ['swap-ack-slip', 'add-ack-slip', 'pos-ack-slip']) $(id).checked = false;
  state.registry = undefined;
  state.neuro.clear();
  $('settings-dialog').close();
  refreshAll();
}

// ---------------------------------------------------------------- tabs / startup

const TABS = ['swap', 'pool', 'tokens', 'dlmm'];
let dlmmTab = null; // the DLMM tab (dlmm.js, UNAUDITED contracts)

function showTab(name) {
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of TABS) $(`tab-${s}`).hidden = s !== name;
  if (name === 'dlmm') dlmmTab?.show().catch(() => {});
  if (name === 'pool') { updateAdd(); loadPositions(); }
  if (name === 'tokens') renderTokenList();
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

function openWallets() {
  renderWalletList();
  setStatus('wallet-status', '');
  $('wallet-dialog').showModal();
}

function refreshAll() {
  renderConnect();
  renderSafetyBanner();
  updateSwap();
  if (!$('tab-pool').hidden) { updateAdd(); loadPositions(); }
  if (!$('tab-dlmm').hidden) dlmmTab?.show().catch(() => {});
}

function debounce(fn, ms) {
  let h;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

async function fetchJson(path) {
  const r = await fetch(BASE + path, { cache: 'no-store', credentials: 'same-origin' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function validConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const ok = (a) => typeof a === 'string' && isAddress(a);
  const contracts = c.contracts && ok(c.contracts.factory) && ok(c.contracts.router) && ok(c.contracts.wnative) ? c.contracts : null;
  if (Number(c.chainId) !== EVM_CHAIN_ID && contracts) return null; // a deployment for another chain
  let rpcValue = '';
  try { if (c.rpc) rpcValue = nodeEndpoints(c.rpc).evm; } catch { rpcValue = ''; }
  return { ...c, rpc: rpcValue, contracts, tokens: Array.isArray(c.tokens) ? c.tokens : [], neuroRegistry: ok(c.neuroRegistry) ? c.neuroRegistry : null };
}

async function init() {
  state.lang = pickLang(store.get(KEYS.lang)); // English unless another language of the set was chosen
  applyTheme(store.get(KEYS.theme));
  loadSettings();
  applyI18n();

  try { state.cfg = validConfig(await fetchJson('deployments.json')); } catch { state.cfg = null; }
  if (!state.cfg) state.cfg = { contracts: null, tokens: [], rpc: '' };
  let list = [];
  try { const tl = await fetchJson('tokenlist.json'); list = Array.isArray(tl.tokens) ? tl.tokens : []; } catch { list = []; }
  buildTokens(list);
  fillAllSelects();
  if (deployed()) {
    $('footer-contracts').textContent = `Router ${state.cfg.contracts.router} · Factory ${state.cfg.contracts.factory}`;
  }

  dlmmTab = createDlmmTab({ state, $, el, setStatus, rpc, sendTx, errorText, revertData, neuroCheck, recheckNeuro, renderNeuro, needsAck,
    allowance, isNative, keyOf, tokenByKey, tokenByAddress, deadline, openWallets });

  // events
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('lang-btn').addEventListener('change', (e) => { state.lang = pickLang(e.target.value); store.set(KEYS.lang, state.lang); applyI18n(); fillAllSelects(); refreshAll(); renderTokenList(); });
  $('theme-btn').addEventListener('click', () => { const next = currentTheme() === 'dark' ? 'light' : 'dark'; applyTheme(next); store.set(KEYS.theme, next); });
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  $('settings-save').addEventListener('click', saveSettings);
  $('connect-btn').addEventListener('click', () => (state.account ? disconnect() : openWallets()));
  $('wallet-close').addEventListener('click', () => $('wallet-dialog').close());
  const swapDebounced = debounce(updateSwap, 250);
  $('swap-amount-in').addEventListener('input', swapDebounced);
  $('swap-from').addEventListener('change', updateSwap);
  $('swap-to').addEventListener('change', updateSwap);
  $('swap-flip').addEventListener('click', () => { const a = $('swap-from').value; $('swap-from').value = $('swap-to').value; $('swap-to').value = a; updateSwap(); });
  $('swap-max').addEventListener('click', async () => {
    if (!state.account) return;
    const { tin } = swapTokens();
    let b = await balanceOf(tin, state.account).catch(() => 0n);
    if (isNative(tin)) b = b > 10n ** 16n ? b - 10n ** 16n : 0n; // keep 0.01 ZTPHY for gas
    $('swap-amount-in').value = formatUnits(b, tin.decimals, tin.decimals).replace(/,/g, '');
    updateSwap();
  });
  $('swap-btn').addEventListener('click', onSwapClick);
  $('swap-approve').addEventListener('click', onSwapApprove);
  $('swap-ack-flag').addEventListener('change', checkSwapReady);
  $('swap-ack-impact').addEventListener('change', checkSwapReady);
  $('swap-ack-slip').addEventListener('change', checkSwapReady);
  const addDebounced = debounce(updateAdd, 250);
  $('add-amt-a').addEventListener('input', () => { addEdited = 'a'; addDebounced(); });
  $('add-amt-b').addEventListener('input', () => { addEdited = 'b'; addDebounced(); });
  $('add-a').addEventListener('change', () => updateAdd());
  $('add-b').addEventListener('change', () => updateAdd());
  $('add-ack-flag').addEventListener('change', () => updateAdd());
  $('add-ack-slip').addEventListener('change', () => updateAdd());
  $('add-btn').addEventListener('click', onAddClick);
  $('pos-refresh').addEventListener('click', loadPositions);
  $('import-check').addEventListener('click', onImportCheck);
  $('import-addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') onImportCheck(); });
  $('import-ack').addEventListener('change', () => { $('import-add').disabled = !$('import-ack').checked; });
  $('import-add').addEventListener('click', onImportAdd);

  discovery = discoverWallets(window, () => { if ($('wallet-dialog').open) renderWalletList(); });
  // Reconnect silently to the wallet used last time (eth_accounts: no prompt).
  // The site-wide choice (the hub's wallet button) first, then this page's own.
  const restore = () => {
    const id = sharedWalletId() ?? cleanWalletId(store.get(KEYS.wallet));
    const m = id && LEDGER_ID_RE.exec(id);
    const w = m ? ledgerWallet(Number(m[1])) : id && walletsNow().find((x) => x.id === id);
    if (w && (!state.account || state.wallet?.id !== id)) connectWallet(w, true);
  };
  setTimeout(restore, 400);
  // Connected or disconnected on another page of this site (the hub, another app, another tab).
  window.addEventListener('storage', (e) => {
    if (e.key !== SHARED_WALLET) return;
    if (sharedWalletId()) restore(); else if (state.account) disconnect({ everywhere: false });
  });
  // 30 minutes (or the 60 / 120 / 240 chosen in the help) without activity anywhere on the site: forget the account (the hub does it for the apps in its frames).
  if (IN_HUB) sf.track();
  else {
    sf.idleGuard({ active: () => !!state.account, onIdle: () => {
      const p = state.wallet?.provider;
      disconnect();
      p?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })?.catch?.(() => {});
      for (const d of document.querySelectorAll('dialog[open]')) d.close();
      sf.idleNotice();
    } });
  }

  const tab = location.hash.slice(1);
  showTab(TABS.includes(tab) ? tab : 'swap');
  renderBanner();
  await updateSwap();
  document.documentElement.dataset.appReady = '1';
}

init().catch((e) => {
  const b = $('banner');
  b.textContent = String(e?.message ?? e);
  b.hidden = false;
  document.documentElement.dataset.appReady = 'error';
});
