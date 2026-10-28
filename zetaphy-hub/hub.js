// ZETAPHY hub: every app on one page, one screen, explanations on hover.
//  - Overview and Stake & vote are drawn here (CometBFT RPC + Cosmos REST of the node;
//    staking / rewards / votes are sent from MetaMask to the chain's precompiles).
//  - Wallet, Swap, NFT, Explorer and Neuro are the existing apps, served from this
//    same site (/wallet/ /swap/ /nft/ /explorer/ /neuro/web/) and shown in frames;
//    hub.js gives them the hub's look (embed.css) and folds their long hints into "i" icons.
import {
  PRECOMPILES, toBech32, isEvmAddress, encodeDelegate, encodeUndelegate, encodeClaimRewards, encodeVote,
  parseZeta, formatZeta, short,
} from './chainlib.js';
import { PAGES, askFaucet } from './pages.js';
import { LANGS, TEXT, TAB_TEXT, pickLang, locale } from './i18n.js';
import { walletBar } from './walletbar.js';
import * as walletLib from './wallet/wallets.js';

const EVM_CHAIN_ID = 77390;
const DEFAULT_NODE = 'https://rpc.sawasdeecoin.com';
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// The tabs: native panels and the apps (with their own explanations as hover text).
const ICONS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h2"/><path d="M3 9h15a3 3 0 0 0-3-3H6"/>',
  swap: '<path d="M7 7h12l-3-3"/><path d="M17 17H5l3 3"/>',
  stake: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
  nft: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 16l-5-5-9 9"/>',
  explorer: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  mine: '<path d="M3 9c4-5 13-6 18-2"/><path d="M12 6l-5 15"/>',
  guide: '<path d="M4 4h11l5 5v11H4z"/><path d="M8 13h8M8 17h5"/>',
  earn: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1.1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5v1.5M12 16v1.5"/>',
  analytics: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  defi: '<circle cx="8" cy="8" r="5"/><circle cx="16" cy="16" r="5"/>',
  leaderboard: '<path d="M8 21V11H3v10zM14.5 21V4h-5v17zM21 21v-7h-5v7z"/>',
  dev: '<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M13.5 5l-3 14"/>',
  saphan: '<path d="M2 18h20"/><path d="M4 18v-3a8 8 0 0 1 16 0v3"/><path d="M8 18v-6M12 18v-7M16 18v-6"/>',
  neuro: '<path d="M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-6 0"/>',
};
// Their words (label, title, hover text) are in i18n.js TAB_TEXT.
const TABS = [
  { id: 'home' },
  { id: 'wallet', src: 'wallet/' },
  { id: 'swap', src: 'swap/' },
  { id: 'stake', fresh: true },
  { id: 'earn', page: true, fresh: true },
  { id: 'mine', page: true, fresh: true },
  { id: 'saphan', page: true, fresh: true },
  { id: 'nft', src: 'nft/' },
  { id: 'explorer', src: 'explorer/', group: 'data' },
  { id: 'neuro', src: 'neuro/web/' },
  { id: 'analytics', page: true, group: 'data', fresh: true },
  { id: 'defi', page: true, group: 'data', fresh: true },
  { id: 'leaderboard', page: true, group: 'data', fresh: true },
  { id: 'dev', page: true, group: 'build', fresh: true },
];
const APP_HOSTS = { 'wallet.sawasdeecoin.com': 'wallet', 'swap.sawasdeecoin.com': 'swap', 'nft.sawasdeecoin.com': 'nft', 'explorer.sawasdeecoin.com': 'explorer', 'neuro.sawasdeecoin.com': 'neuro' };
// Each app's own language setting, so a language change here reaches them (every app takes all the codes in LANGS).
const APP_LANG = [['zetaphy-wallet:lang', (l) => l], ['zetaphy-dex:lang', (l) => l], ['zn.lang', (l) => JSON.stringify(l)], ['zetaphy-explorer:lang', (l) => l], ['neuro-lang', (l) => l]];
const APP_THEME = [['zetaphy-dex:theme', 'dark'], ['zn.theme', '"dark"'], ['zetaphy-explorer:theme', 'dark']];

let lang = pickLang(store.get('zetaphy-hub:lang'));
const T = (k) => TEXT[lang]?.[k] ?? TEXT.en[k] ?? k;
/** A tab's label / title / hover text in the current language (English if missing). */
const tabText = (t, i) => TAB_TEXT[lang]?.[t.id]?.[i] ?? TAB_TEXT.en[t.id][i];
const LABEL = 0, TITLE = 1, TIP = 2;
let NODE = DEFAULT_NODE;
let HUB = { contracts: {}, dex: {}, nft: {}, saphan: [], saphanTokens: [] }; // hub-config.json (written by build.mjs from the launch state and the Saphan chain table)
const ep = () => ({ evm: NODE, ws: `${NODE.replace(/^https:/, 'wss:')}/ws`, comet: `${NODE}/rpc`, rest: `${NODE}/rest`, files: `${NODE}/zetaphy` });
let current = null;
const frames = new Map();

// ------------------------------------------------------------------ helpers
async function getJson(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit', ...init, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function evmCall(method, params = []) {
  const j = await getJson(ep().evm, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};
const svg = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name]; return s; };
function age(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}${T('s')}`;
  if (s < 5400) return `${Math.round(s / 60)}${T('m')}`;
  return `${Math.round(s / 3600)}${T('h')}`;
}
const msg = (node, text, cls = '') => { node.textContent = text; node.className = `msg ${cls}`; };

// ------------------------------------------------------------------ tooltip (here and inside the apps)
function tipText(target, doc) {
  if (target.dataset.tip) return target.dataset.tip;
  if (target.dataset.tipKey) return T(target.dataset.tipKey);
  if (target.classList.contains('hub-i')) return target._src?.textContent?.trim() || '';
  return '';
}
function bindTips(doc, tip) {
  const sel = '[data-tip], [data-tip-key], .hub-i';
  const show = (e) => {
    const t = e.target.closest?.(sel);
    if (!t) return;
    const text = tipText(t, doc);
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    const r = t.getBoundingClientRect(), vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    let x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
    let y = r.bottom + 8;
    if (y + hgt > vh - 8) y = Math.max(8, r.top - hgt - 8);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  };
  const hide = (e) => { if (!e.relatedTarget || !e.relatedTarget.closest?.(sel)) tip.hidden = true; };
  doc.addEventListener('mouseover', show);
  doc.addEventListener('focusin', show);
  doc.addEventListener('mouseout', hide);
  doc.addEventListener('focusout', () => { tip.hidden = true; });
  doc.addEventListener('scroll', () => { tip.hidden = true; }, true);
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') tip.hidden = true; });
}

// ------------------------------------------------------------------ tabs and frames
function buildTabs() {
  const nav = $('tabs');
  const GROUP = { data: T('groupData'), build: T('groupBuild') };
  const order = [...TABS.filter((t) => !t.group), ...TABS.filter((t) => t.group === 'data'), ...TABS.filter((t) => t.group === 'build')];
  let last;
  nav.replaceChildren(...order.flatMap((t) => {
    const head = t.group && t.group !== last ? el('span', { class: 'group', text: GROUP[t.group] }) : null;
    last = t.group;
    return [head, el('a', { class: 'tab', href: `?tab=${t.id}`, 'data-tab': t.id, 'data-tip': tabText(t, TIP) },
      svg(t.id), el('span', { text: tabText(t, LABEL) }), t.fresh ? el('span', { class: 'new', text: 'new' }) : null)];
  }).filter(Boolean),
  // the validator guide is a page of its own on this site (validators.html), not a tab
  el('a', { class: 'tab', href: 'validators.html', id: 'nav-guide', 'data-tip': T('tipGuide') }, svg('guide'), el('span', { text: T('navGuide') })),
  // risk forecasts, Proof of Foresight, detectors, Data DAO, arena: a page of its own (forecasts.html; docs/future/markets.md)
  el('a', { class: 'tab', href: 'forecasts.html', id: 'nav-forecasts', 'data-tip': T('tipForecasts') }, svg('guide'), el('span', { text: T('navForecasts') })));
  const quick = $('quick');
  quick.replaceChildren(...TABS.filter((t) => t.id !== 'home' && !t.group).map((t) => el('a', { class: 'chip', href: `?tab=${t.id}`, 'data-tab': t.id, 'data-tip': tabText(t, TIP) }, svg(t.id), el('span', { text: tabText(t, LABEL) }))));
}

function show(id, { hash, push = true } = {}) {
  const tab = TABS.find((t) => t.id === id) ?? TABS[0];
  current = tab.id;
  $('tip').hidden = true;
  document.querySelectorAll('.tab').forEach((a) => { if (a.dataset.tab === tab.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('page-title').textContent = tabText(tab, TITLE);
  $('page-info').dataset.tip = tabText(tab, TIP);
  document.title = `${tabText(tab, LABEL)} · ZETAPHY`;
  $('panel-home').hidden = tab.id !== 'home';
  $('panel-stake').hidden = tab.id !== 'stake';
  for (const p of document.querySelectorAll('.panel[data-page]')) p.hidden = p.dataset.page !== tab.id;
  if (tab.page) openPage(tab.id);
  for (const [fid, f] of frames) f.hidden = fid !== tab.id;
  if (tab.src) {
    let f = frames.get(tab.id);
    if (!f) {
      f = el('iframe', { title: TAB_TEXT.en[tab.id][LABEL], src: tab.src + (hash ?? ''), allow: 'clipboard-write' });
      f.style.visibility = 'hidden'; // shown once the hub look is in (no flash of the app's own colours)
      f.addEventListener('load', () => embed(f, tab.id));
      $('frames').append(f);
      frames.set(tab.id, f);
    } else if (hash) {
      try { f.contentWindow.location.hash = hash; } catch { f.src = tab.src + hash; }
    }
  }
  if (tab.id === 'stake') loadStake();
  if (push) {
    const u = new URL(location.href);
    u.searchParams.set('tab', tab.id);
    if (u.href !== location.href) history.pushState({ tab: tab.id }, '', u);
  }
}

// The data pages (pages.js): drawn once per language, refreshed while shown.
const pageCtx = () => ({
  T, lang, ep, cfg: HUB, getJson, evmCall, el, short, formatZeta, show, account: () => account, connect, send,
  copyBtn: (text) => el('button', { type: 'button', class: 'copy', text: T('copy'), onclick: async (ev) => {
    try { await navigator.clipboard.writeText(text); ev.target.textContent = T('copied'); setTimeout(() => { ev.target.textContent = T('copy'); }, 1200); } catch { /* blocked */ }
  } }),
});
function openPage(id) {
  let root = document.querySelector(`.panel[data-page="${id}"]`);
  if (!root) {
    root = el('section', { class: `panel page page-${id}`, 'data-page': id });
    $('stage').insertBefore(root, $('frames'));
  }
  if (root.dataset.lang !== lang) { PAGES[id].render(root, pageCtx()); root.dataset.lang = lang; }
  PAGES[id].refresh?.(root, pageCtx());
}

// Inside an app: the hub look, folded hints, hover text, and links to the other apps stay in the hub.
const FOLD = {
  wallet: '.hint',
  swap: '.hint',
  neuro: '.disclaimer',
};
function fold(doc, app) {
  const sel = FOLD[app];
  if (!sel) return;
  for (const n of doc.querySelectorAll(sel)) {
    if (n._hubFolded || n.id || n.closest('footer, .footer, dialog, [role="status"], [aria-live]')) continue;
    if (n.querySelector('a, button, input, select, textarea') || !n.textContent.trim()) continue;
    n._hubFolded = true;
    const i = doc.createElement('span');
    i.className = 'hub-i'; i.textContent = 'i'; i.tabIndex = 0; i.setAttribute('role', 'note');
    i._src = n;
    const prev = n.previousElementSibling;
    if (prev && /^(LABEL|H2|H3|H4|LEGEND|SUMMARY|STRONG|B)$/.test(prev.tagName)) prev.append(i); else n.before(i);
    n.classList.add('hub-folded');
  }
}
function embed(frame, app) {
  let doc;
  try { doc = frame.contentDocument; } catch { frame.style.visibility = ''; return; }
  if (!doc?.documentElement || doc._hub) { frame.style.visibility = ''; return; }
  doc._hub = true;
  doc.documentElement.classList.add('hub-embed');
  doc.documentElement.dataset.app = app;
  const link = doc.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('embed.css', location.href).href;
  const reveal = () => { frame.style.visibility = ''; };
  link.addEventListener('load', reveal); link.addEventListener('error', reveal);
  setTimeout(reveal, 3000);
  doc.head.append(link);
  const tip = doc.createElement('div');
  tip.className = 'hub-tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip');
  doc.body.append(tip);
  bindTips(doc, tip);
  fold(doc, app);
  let pending = 0;
  new MutationObserver(() => { if (!pending) pending = setTimeout(() => { pending = 0; fold(doc, app); }, 150); })
    .observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    let u;
    try { u = new URL(a.href); } catch { return; }
    const to = APP_HOSTS[u.host];
    if (!to) return;
    e.preventDefault();
    show(to, { hash: u.hash || undefined });
  }, true);
}

// ------------------------------------------------------------------ language
function applyLang() {
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = T(n.dataset.i18n);
  $('lang').value = lang;
  buildTabs();
  renderEndpoints();
  wb.render();
  show(current ?? 'home', { push: false });
}
function syncApps() {
  for (const [k, f] of APP_LANG) store.set(k, f(lang));
  for (const [k, v] of APP_THEME) store.set(k, v);
}

// ------------------------------------------------------------------ overview
function renderEndpoints() {
  const e = ep();
  const rows = [[T('endpointChain'), `${EVM_CHAIN_ID} · zetaphy_77390-1`], [T('endpointEvm'), e.evm], ['WebSocket', e.ws], [T('endpointComet'), e.comet], [T('endpointRest'), e.rest]];
  $('endpoints').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v, title: v }),
    el('button', { type: 'button', class: 'copy', text: T('copy'), onclick: async (ev) => {
      try { await navigator.clipboard.writeText(v.split(' · ')[0]); ev.target.textContent = T('copied'); setTimeout(() => { ev.target.textContent = T('copy'); }, 1200); } catch { /* blocked */ }
    } })]));
}
let lastHeight = 0, validatorsCache = null, bondedCache = null;
async function refresh() {
  const net = $('net');
  try {
    const st = await getJson(`${ep().comet}/status`);
    const h = Number(st.result.sync_info.latest_block_height);
    lastHeight = h;
    net.className = 'net up';
    $('net-text').textContent = `#${h.toLocaleString('en-US')}`;
    $('s-height').textContent = h.toLocaleString('en-US');
    if (current === 'home') {
      const bc = await getJson(`${ep().comet}/blockchain?minHeight=${Math.max(1, h - 19)}&maxHeight=${h}`);
      const metas = bc.result.block_metas;
      if (metas.length > 1) {
        const t0 = Date.parse(metas[metas.length - 1].header.time), t1 = Date.parse(metas[0].header.time);
        $('s-time').textContent = `${((t1 - t0) / 1000 / (metas.length - 1)).toFixed(1)}s`;
      }
      const names = await validatorNames();
      $('blocks').replaceChildren(...metas.slice(0, 8).map((m) => {
        const height = m.header.height;
        return el('tr', { class: 'link', onclick: () => show('explorer', { hash: `#/block/${height}` }) },
          el('td', { class: 'num', text: Number(height).toLocaleString('en-US') }), el('td', { class: 'num', text: m.num_txs }),
          el('td', { text: names.get(m.header.proposer_address) ?? short(m.header.proposer_address, 6, 4) }), el('td', { class: 'dim', text: `${age(m.header.time)} ${T('ago')}` }));
      }));
    }
  } catch {
    net.className = 'net down';
    $('net-text').textContent = T('netDown');
  }
  try {
    const [vals, pool] = await Promise.all([bondedValidators(true), getJson(`${ep().rest}/cosmos/staking/v1beta1/pool`)]);
    bondedCache = pool.pool.bonded_tokens;
    $('s-vals').textContent = String(vals.length);
    $('s-bonded').textContent = formatZeta(bondedCache, 0);
  } catch { /* REST may be closed on some nodes */ }
}
async function bondedValidators(force = false) {
  if (validatorsCache && !force) return validatorsCache;
  const j = await getJson(`${ep().rest}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200`);
  validatorsCache = j.validators.sort((a, b) => (BigInt(b.tokens) > BigInt(a.tokens) ? 1 : -1));
  return validatorsCache;
}
// CometBFT proposer address (hex of the consensus key's sha256[:20]) -> moniker
let proposerNames = null;
async function validatorNames() {
  if (proposerNames) return proposerNames;
  proposerNames = new Map();
  try {
    const [vals, cv] = await Promise.all([bondedValidators(), getJson(`${ep().comet}/validators?per_page=100`)]);
    const byKey = new Map(vals.map((v) => [v.consensus_pubkey?.key, v.description?.moniker]));
    for (const v of cv.result.validators) if (byKey.has(v.pub_key?.value)) proposerNames.set(v.address, byKey.get(v.pub_key.value));
  } catch { /* names are only a nicety */ }
  return proposerNames;
}

async function faucet(e) {
  e.preventDefault();
  const out = $('faucet-msg');
  const a = $('faucet-addr').value.trim();
  if (!isEvmAddress(a) && !/^zetaphy1[02-9ac-hj-np-z]{38}$/.test(a)) { msg(out, T('badAddr'), 'bad'); return; }
  msg(out, '…');
  try {
    const r = await askFaucet(ep().evm, a);
    msg(out, `${T('faucetOk')}${r?.txHash ? ` · ${short(r.txHash, 10, 6)}` : ''}`, 'ok');
  } catch (err) { msg(out, err.down ? `${T('netDown')}` : err.message, 'bad'); }
}

// ------------------------------------------------------------------ wallet (one connection for the whole hub: walletbar.js)
let account = null;
const wb = walletBar({
  win: window, evmCall, T, lib: walletLib, node: () => NODE,
  tokens: () => HUB.tokens ?? [],
  nativeSaphan: () => (HUB.saphanTokens.find((r) => r?.native)?.destinations ?? []).map((d) => ({ chain: d.displayName, symbol: HUB.saphanTokens.find((r) => r?.native).synthetic, state: d.state })),
  onChange: (a) => { account = a; if (current === 'stake') loadMine(); },
  lang: () => lang,
  bannerHost: () => $('stage'),
});
// What each precompile is, for the summary shown before the wallet.
const TO_LABEL = { [PRECOMPILES.staking]: 'Staking', [PRECOMPILES.distribution]: 'Distribution', [PRECOMPILES.gov]: 'Governance', [PRECOMPILES.ics20]: 'ICS-20 (ZETAPHY Saphan)' };
/** The wallet the user connected (any EVM wallet), switched to ZETAPHY. */
async function addNetwork() {
  if (!wb.provider()) { wb.open(); throw new Error(T('wbConnectFirst')); }
  await wb.ensureChain();
}
async function addKeplr() {
  if (!window.keplr) throw new Error(T('noKeplr'));
  const info = await getJson(`${ep().files}/keplr.json`);
  await window.keplr.experimentalSuggestChain(info);
  await window.keplr.enable(info.chainId);
}
/** Resolves with the account once the user has connected in the wallet dialog (or rejects when it is closed). */
function connect() {
  if (account) return Promise.resolve(account);
  wb.open();
  return new Promise((resolve, reject) => {
    const dlg = $('wb-dialog');
    const done = () => { clearInterval(t); dlg.removeEventListener('close', onClose); };
    const t = setInterval(() => { if (account) { done(); resolve(account); } }, 250);
    const onClose = () => { setTimeout(() => { done(); account ? resolve(account) : reject(new Error(T('wbConnectFirst'))); }, 300); };
    dlg.addEventListener('close', onClose);
  });
}
/** Sends a call through the connected wallet after an in-page summary (`action`: what it does, in words; `value`: wei it pays). */
async function send(to, data, action = '', value = 0n) {
  if (!account) await connect();
  await addNetwork();
  const p = wb.provider();
  const cid = await p.request({ method: 'eth_chainId' }).catch(() => null);
  if (cid == null || Number(BigInt(cid)) !== EVM_CHAIN_ID) throw new Error(T('wbWrongChain'));
  const ok = await wb.safety.confirmTx({ network: `ZETAPHY (${EVM_CHAIN_ID})`, from: account, to, toLabel: TO_LABEL[to], data, action });
  if (ok == null) throw Object.assign(new Error(wb.safety.t('cfCancelled')), { code: 4001 });
  data = ok;
  const hash = await p.request({ method: 'eth_sendTransaction', params: [{ from: account, to, data, value: `0x${BigInt(value).toString(16)}`, chainId: `0x${EVM_CHAIN_ID.toString(16)}` }] });
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(T('failed'));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const rc = await evmCall('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (rc) { if (rc.status !== '0x1') throw new Error(`${T('failed')} · ${short(hash, 10, 6)}`); wb.refresh(); return hash; }
  }
  return hash;
}

// ------------------------------------------------------------------ stake & vote
let unbondingDays = null;
async function loadStake() {
  try {
    const [vals, params] = await Promise.all([bondedValidators(true), unbondingDays == null ? getJson(`${ep().rest}/cosmos/staking/v1beta1/params`) : null]);
    if (params) unbondingDays = Math.round(parseInt(params.params.unbonding_time, 10) / 86400 * 10) / 10;
    const total = vals.reduce((s, v) => s + BigInt(v.tokens), 0n) || 1n;
    $('vals').replaceChildren(...vals.map((v, i) => el('tr', {},
      el('td', { class: 'dim', text: String(i + 1) }),
      el('td', { 'data-tip': `${v.operator_address}${v.description?.details ? `\n${v.description.details}` : ''}` }, el('b', { text: v.description?.moniker || short(v.operator_address) }), v.jailed ? el('span', { class: 'pill rejected', text: T('jailed') }) : null),
      el('td', { class: 'num', text: `${(Number((BigInt(v.tokens) * 10000n) / total) / 100).toFixed(2)}%`, 'data-tip': `${formatZeta(v.tokens, 2)} ZTPHY` }),
      el('td', { class: 'num', text: `${(Number(v.commission?.commission_rates?.rate ?? 0) * 100).toFixed(1)}%` }),
      el('td', {}, el('button', { type: 'button', class: 'btn sm', text: T('stake'), onclick: () => stakeDialog(v, 'delegate') })))));
  } catch (e) { $('vals').replaceChildren(el('tr', {}, el('td', { colspan: 5, class: 'dim', text: e.message }))); }
  loadProposals();
  if (account) loadMine();
}
async function loadMine() {
  const body = $('mine-body');
  if (!account) return;
  const b32 = toBech32(account);
  try {
    const [bal, dels, rew] = await Promise.all([
      evmCall('eth_getBalance', [account, 'latest']),
      getJson(`${ep().rest}/cosmos/staking/v1beta1/delegations/${b32}`).catch(() => ({ delegation_responses: [] })),
      getJson(`${ep().rest}/cosmos/distribution/v1beta1/delegators/${b32}/rewards`).catch(() => ({ total: [] })),
    ]);
    const staked = dels.delegation_responses.reduce((s, d) => s + BigInt(d.balance.amount), 0n);
    const reward = (rew.total ?? []).find((c) => c.denom === 'azetaphy')?.amount ?? '0';
    const names = new Map((validatorsCache ?? []).map((v) => [v.operator_address, v.description?.moniker]));
    body.replaceChildren(
      el('div', { class: 'dim small mono', text: `${short(account, 8, 6)} · ${short(b32, 12, 6)}`, 'data-tip': `${account}\n${b32}` }),
      el('div', { class: 'bal' },
        el('div', {}, el('span', { text: T('balance') }), el('b', { text: formatZeta(BigInt(bal)) })),
        el('div', {}, el('span', { text: T('staked') }), el('b', { text: formatZeta(staked) })),
        el('div', {}, el('span', { text: T('rewards') }), el('b', { text: formatZeta(reward) }))),
      dels.delegation_responses.length
        ? el('ul', { class: 'dl' }, dels.delegation_responses.map((d) => el('li', {},
          el('span', { text: names.get(d.delegation.validator_address) ?? short(d.delegation.validator_address), 'data-tip': d.delegation.validator_address }),
          el('span', { class: 'mono', text: formatZeta(d.balance.amount, 2) }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T('unstake'), onclick: () => stakeDialog({ operator_address: d.delegation.validator_address, description: { moniker: names.get(d.delegation.validator_address) }, delegated: d.balance.amount }, 'undelegate') }))))
        : el('p', { class: 'dim small', text: T('noDelegations') }),
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn', text: T('claim'), disabled: reward === '0' || !dels.delegation_responses.length, onclick: async (e) => {
        const out = $('mine-msg');
        e.target.disabled = true;
        try { msg(out, T('sent')); await send(PRECOMPILES.distribution, encodeClaimRewards(account, 50), T('claim')); msg(out, T('done'), 'ok'); loadMine(); }
        catch (err) { msg(out, err.message, 'bad'); e.target.disabled = false; }
      } })),
      el('p', { class: 'msg', id: 'mine-msg', role: 'status' }));
    body._bal = BigInt(bal);
  } catch (e) { body.replaceChildren(el('p', { class: 'msg bad', text: e.message })); }
}
async function loadProposals() {
  const list = $('props');
  try {
    const j = await getJson(`${ep().rest}/cosmos/gov/v1/proposals?pagination.reverse=true&pagination.limit=20`);
    if (!j.proposals.length) { list.replaceChildren(el('li', { class: 'dim', text: T('noProposals') })); return; }
    list.replaceChildren(...j.proposals.map((p) => {
      const status = String(p.status).replace('PROPOSAL_STATUS_', '').toLowerCase();
      const voting = status === 'voting_period';
      const out = el('p', { class: 'msg', role: 'status' });
      const vote = (opt) => async () => {
        try { if (!account) await connect(); msg(out, T('sent')); await send(PRECOMPILES.gov, encodeVote(account, BigInt(p.id), opt, ''), `#${p.id} · ${T({ 1: 'yes', 2: 'abstain', 3: 'no', 4: 'veto' }[opt])}`); msg(out, T('voted'), 'ok'); }
        catch (err) { msg(out, err.message, 'bad'); }
      };
      return el('li', {},
        el('div', { class: 'p-top' }, el('span', { class: 'dim mono', text: `#${p.id}` }),
          el('span', { class: 'p-title', text: p.title || p.messages?.[0]?.['@type']?.split('.').pop() || '—', 'data-tip': p.summary || p.title || '' }),
          el('span', { class: `pill ${voting ? 'voting' : status}`, text: status.replace('_', ' ') })),
        voting ? el('div', { class: 'dim small', text: `${T('ends')} ${new Date(p.voting_end_time).toLocaleString(locale(lang))}` }) : null,
        voting ? el('div', { class: 'votes' },
          el('button', { type: 'button', class: 'btn sm', text: T('yes'), onclick: vote(1) }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T('no'), onclick: vote(3) }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T('abstain'), onclick: vote(2) }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T('veto'), onclick: vote(4) })) : null,
        out);
    }));
  } catch (e) { list.replaceChildren(el('li', { class: 'dim', text: e.message })); }
}
function stakeDialog(v, kind) {
  const dlg = $('amount-dlg');
  const name = v.description?.moniker || short(v.operator_address);
  $('amount-title').textContent = `${T(kind === 'delegate' ? 'stakeTitle' : 'unstakeTitle')} ${name}`;
  const max = kind === 'delegate' ? $('mine-body')._bal : BigInt(v.delegated ?? 0);
  $('amount-sub').textContent = [max != null ? `${T('available')}: ${formatZeta(max)} ZTPHY` : '', kind === 'undelegate' && unbondingDays != null ? `${T('unbondIn')} ${unbondingDays} ${T('days')}` : ''].filter(Boolean).join(' · ');
  $('amount').value = '';
  msg($('amount-msg'), '');
  $('amount-ok').disabled = false;
  $('amount-form').onsubmit = async (e) => {
    e.preventDefault();
    const out = $('amount-msg');
    let amt;
    try { amt = parseZeta($('amount').value); if (amt <= 0n) throw new Error(); } catch { msg(out, T('badAmount'), 'bad'); return; }
    if (max != null && amt > max) { msg(out, T('tooMuch'), 'bad'); return; }
    $('amount-ok').disabled = true;
    try {
      if (!account) await connect();
      msg(out, T('sent'));
      const data = kind === 'delegate' ? encodeDelegate(account, v.operator_address, amt) : encodeUndelegate(account, v.operator_address, amt);
      await send(PRECOMPILES.staking, data, `${$('amount-title').textContent} · ${formatZeta(amt)} ZTPHY`);
      msg(out, T('done'), 'ok');
      setTimeout(() => dlg.close(), 900);
      loadMine();
    } catch (err) { msg(out, err.message, 'bad'); $('amount-ok').disabled = false; }
  };
  $('amount-cancel').onclick = () => dlg.close();
  if (!account) connect().then(loadMine).catch((err) => msg($('amount-msg'), err.message, 'bad'));
  dlg.showModal();
}

// ------------------------------------------------------------------ start
async function start() {
  $('lang').replaceChildren(...LANGS.map(([code, name]) => el('option', { value: code, lang: code, text: name })));
  $('lang').value = lang;
  try { const c = await getJson('./hub-config.json'); if (/^https:\/\/[^/]+$/.test(c.node ?? '')) NODE = c.node; HUB = { contracts: c.contracts ?? {}, dex: c.dex ?? {}, nft: c.nft ?? {}, tokens: Array.isArray(c.tokens) ? c.tokens.filter((x) => isEvmAddress(x?.address)) : [], saphan: Array.isArray(c.saphan) ? c.saphan : [], saphanTokens: Array.isArray(c.saphanTokens) ? c.saphanTokens.filter((x) => x && typeof x === 'object' && Array.isArray(x.destinations)) : [] }; } catch { /* default */ }
  syncApps();
  bindTips(document, $('tip'));
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-tab]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    show(a.dataset.tab);
  });
  window.addEventListener('popstate', () => show(new URL(location.href).searchParams.get('tab') ?? 'home', { push: false }));
  $('lang').addEventListener('change', (e) => {
    lang = pickLang(e.target.value);
    store.set('zetaphy-hub:lang', lang);
    syncApps();
    for (const f of frames.values()) { f.remove(); }
    frames.clear();
    applyLang();
  });
  const report = (node) => (p) => p.then(() => msg(node, T('addedNet'), 'ok')).catch((e) => msg(node, e.message, 'bad'));
  $('add-net').addEventListener('click', () => addNetwork().catch(() => {}));
  $('add-metamask').addEventListener('click', () => report($('faucet-msg'))(addNetwork()));
  $('add-keplr').addEventListener('click', () => report($('faucet-msg'))(addKeplr()));
  $('faucet-form').addEventListener('submit', faucet);
  $('connect').addEventListener('click', () => connect().then(loadMine).catch((e) => msg($('mine-body').querySelector('.msg') ?? $('mine-body').appendChild(el('p', { class: 'msg' })), e.message, 'bad')));
  wb.mount();
  current = new URL(location.href).searchParams.get('tab') ?? 'home';
  applyLang();
  refresh();
  setInterval(() => {
    if (document.hidden) return;
    refresh();
    const t = TABS.find((x) => x.id === current);
    if (t?.page && t.id !== 'dev' && t.id !== 'earn') PAGES[t.id].refresh?.(document.querySelector(`.panel[data-page="${t.id}"]`), pageCtx());
  }, 12000);
}
start();
