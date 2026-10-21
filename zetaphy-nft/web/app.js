// ZETAPHY NFT (nft.sawasdeecoin.com): a static page, no server. Reads the chain
// through the node's EVM JSON-RPC, finds listings and transfers from events in
// bounded block ranges, and sends transactions through the visitor's own wallet
// (EIP-6963). Everything a collection's creator wrote (names, metadata, images)
// is shown as text or as an <img src> only (lib/meta.js); nothing is ever
// inserted as HTML.
import { isAddress, checksum, topicOf, ZERO_ADDRESS } from './lib/abi.js';
import { F, E, KIND, STATUS, listingFrom, offerFrom, parseZtphy, formatZtphy, shortAddr } from './lib/contracts.js';
import { makeRpc, read, waitReceipt, scanLogs, RpcError } from './lib/rpc.js';
import { loadMetadata, normalizeTokenUri, normalizeGateway, substituteId, cleanText, cleanMultiline, imageSrc, safeLink, DEFAULT_GATEWAY, GATEWAYS, fetchMetadataJson, readMetadata } from './lib/meta.js';
import { discoverWallets, ensureChain, assertChain, EVM_CHAIN_ID, EVM_CHAIN_ID_HEX, EVM_SYMBOL, openInAppLinks } from './lib/wallet.js';
import { t, LANGS, errorText } from './lib/i18n.js';
import { threatQueries, readThreat, reasonText, DISCLAIMER, REPRODUCE } from './vendor/zetaphy-lib.js';

// ---------------------------------------------------------------- state

const store = (() => { try { const s = window.localStorage; s.setItem('__t', '1'); s.removeItem('__t'); return s; } catch { return null; } })();
const load = (k, d) => { try { return JSON.parse(store?.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { store?.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const S = {
  lang: load('zn.lang', (navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'th'),
  theme: load('zn.theme', null),
  settings: load('zn.settings', {}),
  dep: {},
  rpc: null,
  chainId: EVM_CHAIN_ID,
  registry: null,
  wallet: null, // { name, provider, account }
  wallets: null,
};
const T = (k, v) => t(S.lang, k, v);
const gateway = () => normalizeGateway(S.settings.gateway) ?? DEFAULT_GATEWAY;
const scanWindow = () => Math.min(Math.max(Number(S.settings.scanBlocks) || 50_000, 2_000), 2_000_000);
// "Scan older blocks" (?older=N): at most MAX_OLDER windows and MAX_SCAN blocks per scan.
const MAX_OLDER = 20;
const MAX_SCAN = 4_000_000;
const olderOf = (q) => Math.min(Math.max(Math.floor(Number(q.get('older')) || 1), 1), MAX_OLDER);
const scanSpan = (older) => Math.min(scanWindow() * older, MAX_SCAN);
// The factory and marketplace come from deployments.json (served with the site).
// Overriding them in Settings is a developer feature only: it needs ?dev=1 in the
// page URL, and every approval to a marketplace that is not the deployed one asks
// the user to type a confirmation first (setApprovalForAll lets it move all your tokens).
const DEV = (() => { try { return new URLSearchParams(location.search).get('dev') === '1'; } catch { return false; } })();
const market = () => (DEV && S.settings.marketplace) || S.dep.marketplace;
const factory = () => (DEV && S.settings.factory) || S.dep.factory;
const overridden = (a, deployed) => !!a && (!isAddress(deployed ?? '') || a.toLowerCase() !== deployed.toLowerCase());
const rpcUrl = () => S.settings.rpc || S.dep.rpc || '';
const ok = (a) => isAddress(a) && a !== ZERO_ADDRESS;

// ---------------------------------------------------------------- DOM helpers (text only)

/** h('div', { class, text, href, on: { click } }, ...children): never sets HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, f] of Object.entries(v)) el.addEventListener(ev, f);
    else if (k === 'href') el.setAttribute('href', String(v).startsWith('#/') || String(v) === '#' ? v : (safeLink(v) ?? '#'));
    else if (k === 'src') { if (typeof v === 'string' && (v.startsWith('https://') || v.startsWith('data:image/') || v.startsWith('./') || v.startsWith('http://localhost') || v.startsWith('http://127.0.0.1'))) el.setAttribute('src', v); }
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const $ = (sel) => document.querySelector(sel);
const main = () => $('#main');
const extLink = (href, text) => { const u = safeLink(href); return u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer nofollow', text }) : h('span', { text }); };
const addrLink = (a) => h('a', { href: `#/c/${a}`, class: 'mono', text: shortAddr(a), title: a });
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'label', text: label }), input, hint ? h('small', { class: 'hint', text: hint }) : null);
const input = (attrs) => h('input', { autocomplete: 'off', spellcheck: 'false', ...attrs });
const button = (text, onClick, cls = '') => h('button', { type: 'button', class: `btn ${cls}`.trim(), text, on: { click: onClick } });
const spinner = () => h('div', { class: 'loading', text: T('loading') });

function imgEl(src, alt) {
  if (!src) return h('div', { class: 'noimg', text: T('noImage') });
  const img = h('img', { src, alt: alt || '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(h('div', { class: 'noimg', text: T('noImage') })), { once: true });
  return img;
}

let statusTimer;
function status(msg, kind = 'info') {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status ${kind}`;
  el.hidden = !msg;
  clearTimeout(statusTimer);
  if (kind !== 'pending' && msg) statusTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 15000 : 6000);
}

// ---------------------------------------------------------------- chain reads

async function initRpc() {
  S.rpc = rpcUrl() ? makeRpc(rpcUrl()) : null;
  S.registry = null;
  if (!S.rpc) return;
  try { S.chainId = await S.rpc.chainId(); } catch { /* shown on the page that needs it */ }
  if (ok(market())) S.registry = await read(S.rpc, market(), F.threatRegistry).catch(() => S.dep.threatRegistry ?? null);
}

const infoCache = new Map();
/** What the page shows about a collection: kind, names, trusted factory, owner, mint settings. */
async function collectionInfo(addr) {
  const key = addr.toLowerCase();
  if (infoCache.has(key)) return infoCache.get(key);
  const p = (async () => {
    const r = (f, ...a) => read(S.rpc, addr, f, ...a).catch(() => null);
    const code = await S.rpc.getCode(addr);
    if (!code || code === '0x') return { addr, kind: KIND.NONE, noCode: true };
    let kind = KIND.NONE;
    if (ok(market())) kind = Number(await read(S.rpc, market(), F.kindOf, addr).catch(() => 0));
    if (!kind) kind = (await r(F.supportsInterface, '0x80ac58cd')) ? KIND.ERC721 : (await r(F.supportsInterface, '0xd9b67a26')) ? KIND.ERC1155 : KIND.NONE;
    const [name, symbol, owner, trusted, royaltyBps, maxSupply, publicMint, mintPrice, contractURI, frozen] = await Promise.all([
      r(F.name), r(F.symbol), r(F.owner), ok(factory()) ? read(S.rpc, factory(), F.isCollection, addr).catch(() => false) : false,
      r(F.royaltyBps), r(F.maxSupply), r(F.publicMint), r(F.mintPrice), r(F.contractURI), r(F.metadataFrozen)]);
    const minted = kind === KIND.ERC721 ? await r(F.totalMinted721) : kind === KIND.ERC1155 ? await r(F.tokenCount) : null;
    return { addr: checksum(addr), kind, code, name: cleanText(name ?? '', 80), symbol: cleanText(symbol ?? '', 20), owner, trusted, royaltyBps, maxSupply,
      publicMint, mintPrice, contractURI: contractURI ? cleanText(contractURI, 500) : '', frozen, minted };
  })();
  infoCache.set(key, p);
  p.catch(() => infoCache.delete(key));
  return p;
}

const threatCache = new Map();
/** Neuro: { off } | { flagged, enforced, reason } for the collection's address, code and fp1 fingerprint.
 *  For a factory collection (`trusted`) only its address key can be enforced here, as
 *  in the marketplace: a flag on the code every factory collection shares is shown as
 *  a warning (`shared`), never as a refusal. */
async function threatOf(addr, code, trusted = false) {
  if (!ok(S.registry)) return { off: true };
  const key = `${addr.toLowerCase()}:${trusted ? 1 : 0}`;
  if (threatCache.has(key)) return threatCache.get(key);
  const p = (async () => {
    const qs = threatQueries(S.chainId, addr.toLowerCase(), code ?? await S.rpc.getCode(addr));
    let out = { flagged: false, enforced: false, reason: 0 };
    for (const q of qs) {
      const [w, e] = await Promise.all([S.rpc.ethCall(S.registry, q.warn), S.rpc.ethCall(S.registry, q.enforced)]);
      let r = readThreat(w, e);
      if (trusted && q.what !== 'address' && r.flagged) r = { ...r, enforced: false, shared: true };
      if (r.enforced && !out.enforced) out = { ...r, what: q.what };
      else if (r.flagged && !out.flagged) out = { ...r, what: q.what };
    }
    return out;
  })().catch(() => ({ error: true }));
  threatCache.set(key, p);
  return p;
}

const metaCache = new Map();
async function tokenMeta(info, id) {
  const key = `${info.addr}:${id}`.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  const p = (async () => {
    let uri = info.kind === KIND.ERC1155 ? await read(S.rpc, info.addr, F.uri, id).catch(() => '') : await read(S.rpc, info.addr, F.tokenURI, id).catch(() => '');
    uri = info.kind === KIND.ERC1155 ? substituteId(uri, id) : uri;
    if (!uri) return { uri: '', error: T('noMetadata') };
    return { uri, ...(await loadMetadata(uri, { gateway: gateway() })) };
  })();
  metaCache.set(key, p);
  return p;
}

// ---------------------------------------------------------------- badges

function trustBadge(info) {
  return info.trusted
    ? h('span', { class: 'badge good', text: T('trusted'), title: T('trustedHint') })
    : h('span', { class: 'badge warn', text: T('external'), title: T('externalHint') });
}

function threatBox(th, compact = false) {
  if (!th || th.off) return compact ? null : h('p', { class: 'muted small', text: T('neuroOff') });
  if (th.error) return h('div', { class: 'neuro warnbox' }, h('strong', { text: T('neuroUnavailable') }));
  if (!th.flagged) return compact ? null : h('p', { class: 'neuro okline small', text: T('neuroClear') });
  const reason = reasonText(th.reason)[S.lang === 'th' ? 'th' : 'en'];
  if (compact) return h('span', { class: `badge ${th.enforced ? 'bad' : 'warn'}`, text: th.enforced ? T('neuroEnforcedShort') : T('neuroFlaggedShort'), title: reason });
  return h('div', { class: `neuro ${th.enforced ? 'badbox' : 'warnbox'}`, role: 'note' },
    h('strong', { text: th.enforced ? T('neuroEnforced') : T('neuroFlagged') }),
    th.shared ? h('p', { class: 'small', text: T('neuroShared') }) : null,
    h('p', { text: `${T('neuroReason')}: ${reason}` }),
    h('p', { class: 'small', text: `${DISCLAIMER.th} (${DISCLAIMER.en})` }),
    h('p', { class: 'small muted', text: REPRODUCE[S.lang === 'th' ? 'th' : 'en'] }));
}

// ---------------------------------------------------------------- wallet

function walletLabel() {
  const b = $('#connect');
  b.textContent = S.wallet ? shortAddr(S.wallet.account) : T('connect');
  b.title = S.wallet ? `${S.wallet.name}: ${S.wallet.account}` : '';
}

function pickWallet() {
  const list = S.wallets?.list() ?? [];
  const dlg = $('#walletDialog');
  const body = dlg.querySelector('.dialog-body');
  body.replaceChildren();
  if (!list.length) {
    body.append(h('p', { text: T('noWallet') }), h('ul', { class: 'plain' }, openInAppLinks(location.href).map((l) => h('li', {}, extLink(l.href, l.name)))));
  }
  for (const w of list) {
    body.append(h('button', { type: 'button', class: 'btn wallet-choice', on: { click: () => { dlg.close(); connect(w).catch(showError); } } },
      w.icon ? h('img', { src: w.icon, alt: '', width: 24, height: 24 }) : null, w.name));
  }
  dlg.showModal();
}

async function connect(w) {
  const accounts = await w.provider.request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0] || !isAddress(accounts[0])) throw new Error(T('noAccount'));
  S.wallet = { name: w.name, id: w.id, provider: w.provider, account: checksum(accounts[0]) };
  save('zn.wallet', w.id);
  try { w.provider.on?.('accountsChanged', (a) => { if (S.wallet) { S.wallet.account = a?.[0] ? checksum(a[0]) : null; if (!S.wallet.account) S.wallet = null; walletLabel(); route(); } }); } catch { /* optional */ }
  try { await ensureChain(w.provider, rpcUrl()); } catch (e) { status(T('switchNetwork'), 'error'); }
  walletLabel();
  route();
}

async function needWallet() {
  if (S.wallet?.account) return S.wallet;
  pickWallet();
  throw new Error(T('connectFirst'));
}

/** Simulates, then sends through the wallet, then waits for the receipt. The
 *  wallet's chain id is read again right before signing (the user may have
 *  switched networks meanwhile) and the transaction names chain 77390 itself. */
async function sendTx(to, data, value = 0n, what = '') {
  const w = await needWallet();
  if (!S.rpc) throw new Error(T('noRpc'));
  await ensureChain(w.provider, rpcUrl()).catch((e) => { throw e?.code === 'WRONG_CHAIN' ? new Error(T('wrongChain')) : e; });
  const v = '0x' + BigInt(value).toString(16);
  try {
    await S.rpc.call('eth_call', [{ from: w.account, to, data, value: v }, 'latest']);
  } catch (e) {
    throw new Error(`${T('wouldFail')}: ${errorText(S.lang, e)}`);
  }
  await assertChain(w.provider).catch(() => { throw new Error(T('wrongChain')); });
  status(`${what}${T('confirmInWallet')}`, 'pending');
  const hash = await w.provider.request({ method: 'eth_sendTransaction', params: [{ from: w.account, to, data, value: v, chainId: EVM_CHAIN_ID_HEX }] });
  status(`${what}${T('pending')} ${String(hash).slice(0, 12)}…`, 'pending');
  const r = await waitReceipt(S.rpc, hash);
  status(`${what}${T('done')}`, 'ok');
  infoCache.clear();
  metaCache.clear();
  return r;
}

function showError(e) {
  status(e?.code === 4001 ? T('rejected') : cleanText(e?.message ?? String(e), 300), 'error');
}

/** A button that runs an async action once at a time and reports errors. */
function actionButton(text, run, cls = 'primary') {
  const b = button(text, async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await run(); } catch (e) { showError(e); } finally { b.disabled = false; }
  }, cls);
  return b;
}

// ---------------------------------------------------------------- pages

function needSetup() {
  if (!S.rpc) return h('div', { class: 'card' }, h('h2', { text: T('setupTitle') }), h('p', { text: T('setupRpc') }), h('a', { href: '#/settings', class: 'btn primary', text: T('settings') }));
  if (!ok(market()) || !ok(factory())) return h('div', { class: 'card' }, h('h2', { text: T('setupTitle') }), h('p', { text: T('setupContracts') }), h('a', { href: '#/settings', class: 'btn primary', text: T('settings') }));
  return null;
}

async function listingCard(l, id) {
  const info = await collectionInfo(l.collection);
  const card = h('a', { class: 'nft-card', href: `#/i/${info.addr}/${l.tokenId}`, 'data-listing': String(id) });
  const media = h('div', { class: 'media' }, spinner());
  const th = await threatOf(info.addr, info.code, info.trusted);
  card.append(media, h('div', { class: 'body' },
    h('div', { class: 'title', text: `${info.name || shortAddr(info.addr)} #${l.tokenId}` }),
    h('div', { class: 'price', text: `${formatZtphy(l.unitPrice)} ${EVM_SYMBOL}${l.kind === KIND.ERC1155 ? ` × ${l.quantity}` : ''}` }),
    h('div', { class: 'badges' }, trustBadge(info), threatBox(th, true))));
  tokenMeta(info, l.tokenId).then((m) => {
    media.replaceChildren(imgEl(m.image, m.name));
    if (m.name) card.querySelector('.title').textContent = `${m.name}`;
  });
  return card;
}

async function pageExplore(el, q) {
  el.append(h('h1', { text: T('explore') }), h('p', { class: 'muted', text: T('exploreLead') }));
  const setup = needSetup();
  if (setup) { el.append(setup); return; }
  const grid = h('div', { class: 'grid' }, spinner());
  const more = h('div', { class: 'row' });
  el.append(h('h2', { text: T('recentListings') }), grid, more);
  const older = olderOf(q);
  const windowBlocks = scanSpan(older);
  const { logs, complete } = await scanLogs(S.rpc, { address: market(), topics: [E.Listed.topic] },
    { floor: S.dep.deployBlock ?? 0, maxBlocks: windowBlocks, want: 60, cacheKey: `${S.rpc.url}|${market()}|listed` });
  const ids = [...new Set(logs.map((lg) => E.Listed.decode(lg).id))].slice(0, 60);
  const rows = await Promise.all(ids.map(async (id) => {
    const [l, st] = await Promise.all([read(S.rpc, market(), F.getListing, id), read(S.rpc, market(), F.listingStatus, id, 0)]);
    return { id, l: listingFrom(l), st: Number(st) };
  }));
  const active = rows.filter((r) => r.st === 0);
  grid.replaceChildren(...(await Promise.all(active.map((r) => listingCard(r.l, r.id)))));
  if (!active.length) grid.replaceChildren(h('p', { class: 'muted', text: T('noListings') }));
  if (rows.length > active.length) more.append(h('span', { class: 'muted small', text: T('hiddenListings', { n: rows.length - active.length }) }));
  if (!complete && older < MAX_OLDER && windowBlocks < MAX_SCAN) more.append(h('a', { class: 'btn', href: `#/?older=${older + 1}`, text: T('loadOlder') }));

  // Collections made by the factory, newest first.
  const cgrid = h('div', { class: 'grid small-cards' });
  el.append(h('h2', { text: T('recentCollections') }), cgrid);
  const n = Number(await read(S.rpc, factory(), F.collectionCount));
  const start = Math.max(0, n - 12);
  const addrs = n ? (await read(S.rpc, factory(), F.collections, start, 12)).slice().reverse() : [];
  if (!addrs.length) cgrid.append(h('p', { class: 'muted', text: T('noCollections') }));
  for (const a of addrs) {
    const info = await collectionInfo(a);
    cgrid.append(h('a', { class: 'nft-card', href: `#/c/${info.addr}` }, h('div', { class: 'body' },
      h('div', { class: 'title', text: info.name || shortAddr(a) }), h('div', { class: 'muted small', text: `${info.symbol} · ${info.kind === KIND.ERC1155 ? 'ERC-1155' : 'ERC-721'}` }))));
  }
}

async function pageCollection(el, addr, q) {
  const setup = needSetup();
  if (setup && !S.rpc) { el.append(setup); return; }
  if (!isAddress(addr)) { el.append(h('p', { text: T('badAddress') })); return; }
  const info = await collectionInfo(addr);
  if (info.noCode || info.kind === KIND.NONE) { el.append(h('h1', { text: shortAddr(addr) }), h('p', { class: 'badbox', text: T('notNft') })); return; }
  const th = await threatOf(info.addr, info.code, info.trusted);
  const me = S.wallet?.account;
  const isOwner = me && info.owner && me.toLowerCase() === info.owner.toLowerCase();
  const head = h('div', { class: 'card collection-head' });
  const cmeta = h('div', { class: 'cmeta' });
  head.append(cmeta, h('div', {},
    h('h1', { text: info.name || shortAddr(info.addr) }),
    h('p', { class: 'mono small', text: info.addr }),
    h('div', { class: 'badges' }, h('span', { class: 'badge', text: info.kind === KIND.ERC1155 ? 'ERC-1155' : 'ERC-721' }), h('span', { class: 'badge', text: info.symbol }), trustBadge(info)),
    info.trusted ? null : h('p', { class: 'warnbox small', text: T('externalHint') }),
    threatBox(th),
    h('dl', { class: 'facts' },
      h('dt', { text: T('owner') }), h('dd', { class: 'mono', text: info.owner && info.owner !== ZERO_ADDRESS ? info.owner : T('none') }),
      h('dt', { text: T('royalty') }), h('dd', { text: info.royaltyBps !== null ? `${Number(info.royaltyBps) / 100}%` : '-' }),
      h('dt', { text: T('maxSupply') }), h('dd', { text: info.maxSupply === null ? '-' : info.maxSupply === 0n ? T('unlimited') : String(info.maxSupply) }),
      h('dt', { text: info.kind === KIND.ERC1155 ? T('tokenIds') : T('minted') }), h('dd', { text: info.minted !== null ? String(info.minted) : '-' }),
      h('dt', { text: T('publicMint') }), h('dd', { text: info.publicMint ? `${T('open')} · ${formatZtphy(info.mintPrice ?? 0n)} ${EVM_SYMBOL}` : T('closed') }),
      h('dt', { text: T('metadata') }), h('dd', { text: info.frozen ? T('frozen') : T('changeable') })),
    (isOwner || info.publicMint) && info.trusted ? h('a', { class: 'btn primary', href: `#/mint/${info.addr}`, text: T('mint') }) : null));
  el.append(head);
  if (info.contractURI) {
    loadMetadata(info.contractURI, { gateway: gateway() }).then((m) => {
      if (m.error) return;
      cmeta.append(imgEl(m.image, m.name), m.description ? h('p', { class: 'desc', text: m.description }) : null);
    });
  }
  // Tokens: factory collections count ids; others are found from mint events.
  const grid = h('div', { class: 'grid' }, spinner());
  el.append(h('h2', { text: T('items') }), grid);
  const page = Math.max(0, Number(q.get('p')) || 0);
  let ids = [];
  if (info.trusted && info.minted !== null) {
    const top = Number(info.minted) - page * 24;
    for (let i = top; i > Math.max(0, top - 24); i--) ids.push(BigInt(i));
  } else {
    const isMulti = info.kind === KIND.ERC1155;
    const topics = isMulti ? [E.TransferSingle.topic, null, topicOf(ZERO_ADDRESS)] : [E.Transfer721.topic, topicOf(ZERO_ADDRESS)];
    const { logs } = await scanLogs(S.rpc, { address: info.addr, topics }, { floor: 0, maxBlocks: scanWindow(), want: 200, cacheKey: `${S.rpc.url}|${info.addr}|mints` });
    ids = [...new Set(logs.map((lg) => { try { return isMulti ? E.TransferSingle.decode(lg).id : E.Transfer721.decode(lg).tokenId; } catch { return null; } }).filter((x) => x !== null).map(String))].map(BigInt).slice(page * 24, page * 24 + 24);
  }
  grid.replaceChildren(...ids.map((id) => {
    const card = h('a', { class: 'nft-card', href: `#/i/${info.addr}/${id}` }, h('div', { class: 'media' }, spinner()), h('div', { class: 'body' }, h('div', { class: 'title', text: `#${id}` })));
    tokenMeta(info, id).then((m) => { card.querySelector('.media').replaceChildren(imgEl(m.image, m.name)); if (m.name) card.querySelector('.title').textContent = m.name; });
    return card;
  }));
  if (!ids.length) grid.replaceChildren(h('p', { class: 'muted', text: T('noItems') }));
  const nav = h('div', { class: 'row' });
  if (page > 0) nav.append(h('a', { class: 'btn', href: `#/c/${info.addr}?p=${page - 1}`, text: T('newer') }));
  if (ids.length === 24) nav.append(h('a', { class: 'btn', href: `#/c/${info.addr}?p=${page + 1}`, text: T('older') }));
  el.append(nav);
}

async function pageItem(el, addr, idStr) {
  if (!S.rpc) { el.append(needSetup()); return; }
  if (!isAddress(addr) || !/^\d{1,78}$/.test(idStr)) { el.append(h('p', { text: T('badAddress') })); return; }
  const id = BigInt(idStr);
  const info = await collectionInfo(addr);
  if (info.noCode || info.kind === KIND.NONE) { el.append(h('p', { class: 'badbox', text: T('notNft') })); return; }
  const isMulti = info.kind === KIND.ERC1155;
  const [m, th] = await Promise.all([tokenMeta(info, id), threatOf(info.addr, info.code, info.trusted)]);
  const me = S.wallet?.account;
  const owner721 = isMulti ? null : await read(S.rpc, info.addr, F.ownerOf, id).catch(() => null);
  const myBal = me ? (isMulti ? await read(S.rpc, info.addr, F.balanceOf1155, me, id).catch(() => 0n) : (owner721 && owner721.toLowerCase() === me.toLowerCase() ? 1n : 0n)) : 0n;
  const [rRecv, rAmt] = await read(S.rpc, info.addr, F.royaltyInfo, id, 10_000n).catch(() => [ZERO_ADDRESS, 0n]);
  const blocked = !!th.enforced;

  const left = h('div', { class: 'item-media' }, imgEl(m.image, m.name));
  const right = h('div', { class: 'item-info' },
    h('a', { href: `#/c/${info.addr}`, class: 'muted', text: `${info.name || shortAddr(info.addr)} (${info.symbol})` }),
    h('h1', { text: m.name || `#${id}` }),
    h('div', { class: 'badges' }, h('span', { class: 'badge', text: `#${id}` }), trustBadge(info)),
    threatBox(th),
    m.error ? h('p', { class: 'warnbox small', text: `${T('metadataError')}: ${m.error}` }) : null,
    m.description ? h('p', { class: 'desc', text: m.description }) : null,
    m.attributes?.length ? h('div', { class: 'traits' }, m.attributes.map((a) => h('div', { class: 'trait' }, h('span', { class: 'muted small', text: a.trait }), h('strong', { text: a.value })))) : null,
    h('dl', { class: 'facts' },
      isMulti ? null : h('dt', { text: T('owner') }), isMulti ? null : h('dd', { class: 'mono', text: owner721 ?? '-' }),
      me ? h('dt', { text: T('youHold') }) : null, me ? h('dd', { text: String(myBal) }) : null,
      h('dt', { text: T('royalty') }), h('dd', { text: rAmt ? `${Number(rAmt) / 100}% → ${shortAddr(rRecv)}` : T('none') }),
      h('dt', { text: T('tokenUri') }), h('dd', { class: 'mono small break', text: cleanText(m.uri, 300) || '-' }),
      m.externalUrl ? h('dt', { text: T('link') }) : null, m.externalUrl ? h('dd', {}, extLink(m.externalUrl, cleanText(m.externalUrl, 80))) : null));
  el.append(h('div', { class: 'item' }, left, right));
  if (!ok(market())) return;

  // Listings and offers for this token, from events (bounded) + their current state.
  const colTopic = topicOf(info.addr);
  const [lres, ores] = await Promise.all([
    scanLogs(S.rpc, { address: market(), topics: [E.Listed.topic, null, null, colTopic] }, { floor: S.dep.deployBlock ?? 0, maxBlocks: scanWindow(), cacheKey: `${S.rpc.url}|${market()}|listed|${info.addr}` }),
    scanLogs(S.rpc, { address: market(), topics: [E.OfferMade.topic, null, null, colTopic] }, { floor: S.dep.deployBlock ?? 0, maxBlocks: scanWindow(), cacheKey: `${S.rpc.url}|${market()}|offers|${info.addr}` }),
  ]);
  const lids = [...new Set(lres.logs.map((lg) => E.Listed.decode(lg)).filter((x) => x.tokenId === id).map((x) => x.id))];
  const oids = [...new Set(ores.logs.map((lg) => E.OfferMade.decode(lg)).filter((x) => x.tokenId === id).map((x) => x.id))];
  const listings = (await Promise.all(lids.map(async (lid) => ({ id: lid, l: listingFrom(await read(S.rpc, market(), F.getListing, lid)), st: Number(await read(S.rpc, market(), F.listingStatus, lid, 0)) }))))
    .filter((x) => x.l.quantity > 0n);
  const offers = (await Promise.all(oids.map(async (oid) => ({ id: oid, o: offerFrom(await read(S.rpc, market(), F.getOffer, oid)) })))).filter((x) => x.o.amount > 0n);

  const sec = h('section', { class: 'card', id: 'listings' }, h('h2', { text: T('listings') }));
  if (!listings.length) sec.append(h('p', { class: 'muted', text: T('noListingsHere') }));
  // The connected seller's listings of this token that can no longer be bought (sold,
  // replaced, token moved away…): offer to cancel them, so they can never come back.
  const myStale = me ? listings.filter((x) => x.st !== 0 && x.l.seller.toLowerCase() === me.toLowerCase()) : [];
  if (myStale.length) sec.append(staleNotice(myStale.map((x) => x.id)));
  for (const { id: lid, l, st } of listings) {
    const mine = me && l.seller.toLowerCase() === me.toLowerCase();
    const qty = input({ type: 'number', min: '1', max: String(l.quantity), value: '1', class: 'qty', 'aria-label': T('quantity') });
    const row = h('div', { class: 'listing-row', 'data-listing': String(lid) },
      h('div', {}, h('strong', { class: 'price', text: `${formatZtphy(l.unitPrice)} ${EVM_SYMBOL}` }), isMulti ? h('span', { class: 'muted', text: ` ${T('each')} · ${T('available')} ${l.quantity}` }) : null,
        h('div', { class: 'small muted', text: `${T('seller')} ${shortAddr(l.seller)} · ${T('until')} ${new Date(l.expiry * 1000).toLocaleString(S.lang === 'th' ? 'th-TH' : 'en-GB')}` }),
        st !== 0 ? h('div', { class: 'small warnbox', text: T(`status_${STATUS[st]}`) }) : null));
    if (mine) row.append(actionButton(T('cancel'), async () => { await sendTx(market(), F.cancel.encode(lid), 0n, T('cancel')); route(); }, ''));
    else if (st === 0 && !blocked) {
      if (isMulti) row.append(qty);
      const quoteEl = h('div', { class: 'small muted quote' });
      const updateQuote = async () => {
        const n = BigInt(Math.max(1, Math.min(Number(qty.value) || 1, Number(l.quantity))));
        const [fee, roy, , rest] = await read(S.rpc, market(), F.quote, info.addr, id, l.unitPrice * n);
        quoteEl.textContent = `${T('total')} ${formatZtphy(l.unitPrice * n)} ${EVM_SYMBOL} · ${T('fee')} ${formatZtphy(fee)} · ${T('royalty')} ${formatZtphy(roy)} · ${T('sellerGets')} ${formatZtphy(rest)}`;
      };
      qty.addEventListener('input', () => updateQuote().catch(() => {}));
      updateQuote().catch(() => {});
      row.append(actionButton(T('buy'), async () => {
        const n = BigInt(isMulti ? Math.floor(Number(qty.value)) : 1);
        if (!(n >= 1n && n <= l.quantity)) throw new Error(T('badQuantity'));
        await sendTx(market(), F.buy.encode(lid, n), l.unitPrice * n, T('buy'));
        route();
      }), quoteEl);
    }
    sec.append(row);
  }
  el.append(sec);

  const osec = h('section', { class: 'card', id: 'offers' }, h('h2', { text: T('offers') }));
  if (!offers.length) osec.append(h('p', { class: 'muted', text: T('noOffers') }));
  const now = Date.now() / 1000;
  for (const { id: oid, o } of offers) {
    const mineOffer = me && o.buyer.toLowerCase() === me.toLowerCase();
    const row = h('div', { class: 'listing-row', 'data-offer': String(oid) }, h('div', {},
      h('strong', { text: `${formatZtphy(o.amount)} ${EVM_SYMBOL}` }), isMulti ? h('span', { class: 'muted', text: ` ${T('for')} ${o.quantity}` }) : null,
      h('div', { class: 'small muted', text: `${T('from')} ${shortAddr(o.buyer)} · ${o.expiry < now ? T('expired') : `${T('until')} ${new Date(o.expiry * 1000).toLocaleString(S.lang === 'th' ? 'th-TH' : 'en-GB')}`}` })));
    if (mineOffer) row.append(actionButton(T('cancelOffer'), async () => { await sendTx(market(), F.cancelOffer.encode(oid), 0n, T('cancelOffer')); route(); }, ''));
    else if (me && myBal >= o.quantity && o.expiry > now && !blocked) {
      // What the holder would get, as shown; it becomes acceptOffer's minProceeds, so a
      // higher fee or royalty at inclusion (or an RPC that showed a fake amount) reverts.
      const q = await read(S.rpc, market(), F.quote, info.addr, id, o.amount).catch(() => null);
      if (!q) { osec.append(row); continue; }
      const [fee, roy, , rest] = q;
      row.append(actionButton(T('accept'), async () => {
        await ensureApproval(info);
        await sendTx(market(), F.acceptOffer.encode(oid, rest), 0n, T('accept'));
        await route();
        afterSale(info, id);
      }), h('div', { class: 'small muted quote', text: `${T('fee')} ${formatZtphy(fee)} · ${T('royalty')} ${formatZtphy(roy)} · ${T('youGet')} ${formatZtphy(rest)} ${EVM_SYMBOL}` }));
    }
    osec.append(row);
  }
  el.append(osec);

  // Forms: list (holders), offer (anyone else).
  if (blocked) { el.append(h('p', { class: 'badbox', text: T('tradingRefused') })); return; }
  const forms = h('div', { class: 'forms' });
  if (me && myBal > 0n) {
    const price = input({ inputmode: 'decimal', placeholder: '1.5', name: 'price' });
    const qtyIn = input({ type: 'number', min: '1', max: String(myBal), value: '1', name: 'quantity' });
    const days = input({ type: 'number', min: '1', max: '365', value: '7', name: 'days' });
    forms.append(h('section', { class: 'card', id: 'listForm' }, h('h2', { text: T('sell') }),
      field(isMulti ? T('pricePerUnit') : T('price'), price, EVM_SYMBOL), isMulti ? field(T('quantity'), qtyIn) : null, field(T('days'), days),
      actionButton(T('listForSale'), async () => {
        const p = parseZtphy(price.value);
        if (!p) throw new Error(T('badPrice'));
        const n = BigInt(isMulti ? Math.floor(Number(qtyIn.value)) : 1);
        if (!(n >= 1n && n <= myBal)) throw new Error(T('badQuantity'));
        const d = Math.floor(Number(days.value));
        if (!(d >= 1 && d <= 365)) throw new Error(T('badDays'));
        await ensureApproval(info);
        await sendTx(market(), F.list.encode(info.addr, id, n, p, BigInt(Math.floor(Date.now() / 1000) + d * 86400)), 0n, T('listForSale'));
        route();
      })));
  }
  if (!me || (isMulti || myBal === 0n)) {
    const amount = input({ inputmode: 'decimal', placeholder: '1', name: 'offer' });
    const qtyIn = input({ type: 'number', min: '1', value: '1', name: 'offerQuantity' });
    const days = input({ type: 'number', min: '1', max: '365', value: '7', name: 'offerDays' });
    forms.append(h('section', { class: 'card', id: 'offerForm' }, h('h2', { text: T('makeOffer') }),
      field(isMulti ? T('offerTotal') : T('offerAmount'), amount, `${EVM_SYMBOL} · ${T('offerHeld')}`), isMulti ? field(T('quantity'), qtyIn) : null, field(T('days'), days),
      actionButton(T('makeOffer'), async () => {
        const v = parseZtphy(amount.value);
        if (!v) throw new Error(T('badPrice'));
        const n = BigInt(isMulti ? Math.floor(Number(qtyIn.value)) : 1);
        if (n < 1n) throw new Error(T('badQuantity'));
        const d = Math.floor(Number(days.value));
        if (!(d >= 1 && d <= 365)) throw new Error(T('badDays'));
        await sendTx(market(), F.makeOffer.encode(info.addr, id, n, BigInt(Math.floor(Date.now() / 1000) + d * 86400)), v, T('makeOffer'));
        route();
      })));
  }
  el.append(forms);
}

/** Cancels listings one by one (each is its own transaction), then reloads the page. */
async function cancelListings(ids) {
  for (const lid of ids) await sendTx(market(), F.cancel.encode(lid), 0n, T('cancel'));
  route();
}

/** "Your old listings of this token can no longer be bought: cancel them." */
function staleNotice(ids) {
  return h('div', { class: 'warnbox small', id: 'staleListings' },
    h('p', { text: T('staleMine', { n: ids.length }) }),
    actionButton(T('cancelStale', { n: ids.length }), () => cancelListings(ids), ''));
}

/** After the connected wallet sold this token (accepted an offer), offers to cancel
 *  its other listings of it that are still open (the contract already makes them
 *  unbuyable; cancelling also takes them off every list). */
async function afterSale(info, id) {
  const me = S.wallet?.account;
  if (!me || !ok(market())) return;
  const lres = await scanLogs(S.rpc, { address: market(), topics: [E.Listed.topic, null, topicOf(me), topicOf(info.addr)] },
    { floor: S.dep.deployBlock ?? 0, maxBlocks: scanWindow() }).catch(() => ({ logs: [] }));
  const lids = [...new Set(lres.logs.map((lg) => E.Listed.decode(lg)).filter((x) => x.tokenId === id).map((x) => x.id))];
  const open = [];
  for (const lid of lids) { const l = listingFrom(await read(S.rpc, market(), F.getListing, lid)); if (l.quantity > 0n) open.push(lid); }
  if (open.length && !document.querySelector('#staleListings')) document.querySelector('#listings')?.append(staleNotice(open));
}

/** Typed confirmation (in the page, no script dialog) before approving a marketplace
 *  that is not the one in deployments.json (only possible with ?dev=1). */
function confirmUnknownMarket(addr) {
  return new Promise((resolve) => {
    const want = addr.slice(-6).toLowerCase();
    const typed = input({ name: 'confirmMarket', 'aria-label': T('typeToConfirm', { code: want }) });
    typed.addEventListener('input', () => typed.setCustomValidity(''));
    const dlg = h('dialog', { class: 'dialog danger', id: 'marketConfirm' });
    const done = (yes) => { dlg.close(); dlg.remove(); resolve(yes); };
    dlg.append(h('div', { class: 'dialog-body' },
      h('h2', { class: 'bad', text: T('unknownMarketTitle') }),
      h('p', { class: 'badbox', text: T('unknownMarket', { addr }) }),
      field(T('typeToConfirm', { code: want }), typed),
      h('div', { class: 'row' },
        button(T('approveAnyway'), () => {
          if (typed.value.trim().toLowerCase() === want) return done(true);
          typed.setCustomValidity(T('typeToConfirm', { code: want }));
          typed.reportValidity();
        }, 'danger'),
        button(T('cancelAction'), () => done(false)))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** The marketplace may move this collection's tokens for the connected wallet. */
async function ensureApproval(info) {
  const me = S.wallet.account;
  if (await read(S.rpc, info.addr, F.isApprovedForAll, me, market())) return;
  if (overridden(market(), S.dep.marketplace) && !(await confirmUnknownMarket(market()))) throw new Error(T('approvalCancelled'));
  await sendTx(info.addr, F.setApprovalForAll.encode(market(), true), 0n, T('approve'));
}

function pageCreate(el) {
  el.append(h('h1', { text: T('createTitle') }), h('p', { class: 'muted', text: T('createLead') }));
  const setup = needSetup();
  if (setup) { el.append(setup); return; }
  const kind = h('select', { name: 'kind' }, h('option', { value: '721', text: T('kind721') }), h('option', { value: '1155', text: T('kind1155') }));
  const name = input({ name: 'name', maxlength: '80', required: true });
  const symbol = input({ name: 'symbol', maxlength: '20', required: true });
  const base = input({ name: 'baseURI', placeholder: 'ipfs://bafy…/' });
  const curi = input({ name: 'contractURI', placeholder: 'ipfs://bafy…/collection.json' });
  const roy = input({ name: 'royalty', inputmode: 'decimal', value: '5' });
  const recv = input({ name: 'royaltyReceiver', placeholder: '0x… ' + T('defaultYou') });
  const max = input({ name: 'maxSupply', type: 'number', min: '0', value: '0' });
  const pub = h('input', { type: 'checkbox', name: 'publicMint' });
  const price = input({ name: 'mintPrice', inputmode: 'decimal', value: '0' });
  const out = h('div', { class: 'result' });
  el.append(h('form', { class: 'card form', on: { submit: (e) => e.preventDefault() } },
    field(T('kind'), kind), field(T('name'), name), field(T('symbol'), symbol),
    field(T('baseUri'), base, T('baseUriHint')), field(T('contractUri'), curi, T('optional')),
    field(T('royaltyPct'), roy, T('royaltyHint')), field(T('royaltyReceiver'), recv),
    field(T('maxSupply'), max, T('maxSupplyHint')),
    h('label', { class: 'check' }, pub, h('span', { text: T('publicMintOn') })), field(T('mintPriceLabel'), price, EVM_SYMBOL),
    actionButton(T('create'), async () => {
      const w = await needWallet();
      const nm = name.value.trim(), sy = symbol.value.trim();
      if (!nm || !sy) throw new Error(T('needNameSymbol'));
      const b = base.value.trim() ? normalizeTokenUri(base.value) : '';
      const cu = curi.value.trim() ? normalizeTokenUri(curi.value) : '';
      if (b === null || cu === null) throw new Error(T('badUri'));
      const pct = Number(roy.value || 0);
      if (!(pct >= 0 && pct <= 10)) throw new Error(T('royaltyTooHigh'));
      const bps = Math.round(pct * 100);
      const rc = recv.value.trim() || w.account;
      if (bps && !isAddress(rc)) throw new Error(T('badAddress'));
      const mp = parseZtphy(price.value || '0');
      if (mp === null) throw new Error(T('badPrice'));
      const cap = BigInt(Math.max(0, Math.floor(Number(max.value) || 0)));
      const cfg = [nm, sy, b, cu, bps ? checksum(rc) : ZERO_ADDRESS, BigInt(bps), cap, pub.checked, mp];
      const f = kind.value === '1155' ? F.createERC1155 : F.createERC721;
      const r = await sendTx(factory(), f.encode(cfg), 0n, T('create'));
      const lg = (r.logs ?? []).find((x) => x.topics?.[0]?.toLowerCase() === E.CollectionCreated.topic);
      const created = lg ? E.CollectionCreated.decode(lg).collection : null;
      out.replaceChildren(h('p', { class: 'okline', text: T('created') }), created ? h('p', {}, h('a', { href: `#/c/${created}`, class: 'mono', text: created })) : null,
        created ? h('a', { class: 'btn primary', href: `#/mint/${created}`, text: T('mintNow') }) : null);
    })), out, ipfsHelp());
}

function ipfsHelp() {
  return h('details', { class: 'card help' }, h('summary', { text: T('ipfsTitle') }),
    h('p', { text: T('ipfsLead') }),
    h('ul', {}, ...['ipfsOpt1', 'ipfsOpt2', 'ipfsOpt3', 'ipfsOpt4'].map((k) => h('li', { text: T(k) }))),
    h('p', { class: 'small muted', text: T('ipfsNote') }),
    h('p', { class: 'small muted', text: T('privacyNote') }));
}

async function pageMint(el, addr) {
  if (!S.rpc) { el.append(needSetup()); return; }
  if (!isAddress(addr)) { el.append(h('p', { text: T('badAddress') })); return; }
  const info = await collectionInfo(addr);
  if (info.noCode || info.kind === KIND.NONE) { el.append(h('p', { class: 'badbox', text: T('notNft') })); return; }
  const isMulti = info.kind === KIND.ERC1155;
  const me = S.wallet?.account;
  const isOwner = me && info.owner && me.toLowerCase() === info.owner.toLowerCase();
  el.append(h('h1', { text: `${T('mint')}: ${info.name || shortAddr(info.addr)}` }), h('div', { class: 'badges' }, trustBadge(info)));
  if (!info.trusted) el.append(h('p', { class: 'warnbox', text: T('externalHint') }));
  if (!me) { el.append(h('p', {}, button(T('connect'), pickWallet, 'primary'))); return; }
  const done = (r) => {
    let id = null;
    for (const lg of r.logs ?? []) {
      try { id = isMulti ? E.TransferSingle.decode(lg).id : E.Transfer721.decode(lg).tokenId; break; } catch { /* other log */ }
    }
    return id !== null ? h('p', { class: 'okline' }, `${T('minted')} `, h('a', { href: `#/i/${info.addr}/${id}`, text: `#${id}` })) : h('p', { class: 'okline', text: T('done') });
  };
  const out = h('div', { class: 'result' });
  if (isOwner) {
    const to = input({ name: 'to', value: me });
    const uri = input({ name: 'tokenUri', placeholder: 'ipfs://bafy…/1.json · bafy… · https://… · data:application/json,…' });
    const preview = h('div', { class: 'preview' });
    const amount = input({ name: 'amount', type: 'number', min: '1', value: '1' });
    const existing = input({ name: 'existingId', type: 'number', min: '1', placeholder: T('newIdHint') });
    const previewBtn = button(T('preview'), async () => {
      const u = normalizeTokenUri(uri.value);
      if (!u) { preview.replaceChildren(h('p', { class: 'warnbox', text: T('badUri') })); return; }
      try {
        const md = readMetadata(await fetchMetadataJson(u, { gateway: gateway() }), gateway());
        preview.replaceChildren(h('div', { class: 'nft-card static' }, h('div', { class: 'media' }, imgEl(md.image, md.name)), h('div', { class: 'body' }, h('div', { class: 'title', text: md.name || '-' }), h('p', { class: 'desc small', text: md.description }))));
      } catch (e) { preview.replaceChildren(h('p', { class: 'warnbox', text: `${T('metadataError')}: ${cleanText(e.message, 100)}` })); }
    });
    el.append(h('section', { class: 'card form', id: 'ownerMint' }, h('h2', { text: T('ownerMint') }),
      field(T('to'), to), isMulti ? field(T('existingId'), existing, T('existingIdHint')) : null,
      field(T('tokenUriLabel'), uri, T('tokenUriHint')), previewBtn, preview,
      isMulti ? field(T('amount'), amount) : field(T('quantityBase'), amount, T('quantityBaseHint')),
      actionButton(T('mint'), async () => {
        if (!isAddress(to.value.trim())) throw new Error(T('badAddress'));
        const dest = checksum(to.value.trim());
        const u = uri.value.trim() ? normalizeTokenUri(uri.value) : '';
        if (u === null) throw new Error(T('badUri'));
        const n = BigInt(Math.floor(Number(amount.value) || 0));
        if (n < 1n) throw new Error(T('badQuantity'));
        let r;
        if (isMulti) {
          r = existing.value ? await sendTx(info.addr, F.mint1155.encode(dest, BigInt(existing.value), n), 0n, T('mint'))
            : await sendTx(info.addr, F.create1155.encode(dest, n, u), 0n, T('mint'));
        } else if (u || n === 1n) {
          r = await sendTx(info.addr, F.mint721.encode(dest, u), 0n, T('mint'));
        } else {
          r = await sendTx(info.addr, F.mintMany721.encode(dest, n), 0n, T('mint'));
        }
        out.replaceChildren(done(r));
      })), out, ipfsHelp());
  }
  if (info.publicMint) {
    const qty = input({ name: 'publicQuantity', type: 'number', min: '1', value: '1' });
    const pid = input({ name: 'publicId', type: 'number', min: '1', value: '1' });
    el.append(h('section', { class: 'card form', id: 'publicMint' }, h('h2', { text: `${T('publicMint')} · ${formatZtphy(info.mintPrice)} ${EVM_SYMBOL} ${T('each')}` }),
      isMulti ? field(T('tokenId'), pid) : null, field(T('quantity'), qty),
      actionButton(T('mint'), async () => {
        const n = BigInt(Math.floor(Number(qty.value) || 0));
        if (n < 1n) throw new Error(T('badQuantity'));
        const data = isMulti ? F.publicMint1155.encode(me, BigInt(pid.value || 1), n) : F.publicMint721.encode(me, n);
        out.replaceChildren(done(await sendTx(info.addr, data, info.mintPrice * n, T('mint'))));
      })), out);
  }
  if (!isOwner && !info.publicMint) el.append(h('p', { class: 'muted', text: T('mintClosed') }));
}

async function pageMe(el, q) {
  el.append(h('h1', { text: T('myNfts') }));
  if (!S.rpc) { el.append(needSetup()); return; }
  const who = isAddress(q.get('a')) ? checksum(q.get('a')) : S.wallet?.account;
  if (!who) { el.append(h('p', {}, button(T('connect'), pickWallet, 'primary'))); return; }
  el.append(h('p', { class: 'mono small', text: who }));
  if (ok(market()) && S.wallet?.account === who) {
    const owed = await read(S.rpc, market(), F.owed, who).catch(() => 0n);
    el.append(h('section', { class: 'card', id: 'balance' }, h('h2', { text: T('proceeds') }),
      h('p', { class: 'price', text: `${formatZtphy(owed)} ${EVM_SYMBOL}` }), h('p', { class: 'small muted', text: T('proceedsHint') }),
      h('div', { class: 'row' },
        owed > 0n ? actionButton(T('withdraw'), async () => { await sendTx(market(), F.withdraw.encode(), 0n, T('withdraw')); route(); }) : null,
        actionButton(T('cancelAll'), async () => { await sendTx(market(), F.cancelAll.encode(), 0n, T('cancelAll')); route(); }, ''))));
  }
  const grid = h('div', { class: 'grid' }, spinner());
  el.append(h('h2', { text: T('holdings') }), grid);
  const older = olderOf(q);
  const me = topicOf(who);
  const opts = (tag) => ({ floor: 0, maxBlocks: scanSpan(older), cacheKey: `${S.rpc.url}|${who}|${tag}` });
  const [a, b, c] = await Promise.all([
    scanLogs(S.rpc, { topics: [E.Transfer721.topic, null, me] }, opts('t721')),
    scanLogs(S.rpc, { topics: [E.TransferSingle.topic, null, null, me] }, opts('t1155')),
    scanLogs(S.rpc, { topics: [E.TransferBatch.topic, null, null, me] }, opts('t1155b')),
  ]);
  const found = new Map();
  for (const lg of a.logs) { if (lg.topics.length === 4) { try { const d = E.Transfer721.decode(lg); found.set(`${lg.address}:${d.tokenId}`.toLowerCase(), { addr: lg.address, id: d.tokenId }); } catch { /* ERC-20 */ } } }
  for (const lg of b.logs) { try { const d = E.TransferSingle.decode(lg); found.set(`${lg.address}:${d.id}`.toLowerCase(), { addr: lg.address, id: d.id }); } catch { /* malformed */ } }
  for (const lg of c.logs) { try { const d = E.TransferBatch.decode(lg); for (const id of d.ids.slice(0, 50)) found.set(`${lg.address}:${id}`.toLowerCase(), { addr: lg.address, id }); } catch { /* malformed */ } }
  const items = [...found.values()].slice(0, 120);
  const held = (await Promise.all(items.map(async (x) => {
    const info = await collectionInfo(checksum(x.addr)).catch(() => null);
    if (!info || info.kind === KIND.NONE) return null;
    const bal = info.kind === KIND.ERC1155 ? await read(S.rpc, info.addr, F.balanceOf1155, who, x.id).catch(() => 0n)
      : ((await read(S.rpc, info.addr, F.ownerOf, x.id).catch(() => ZERO_ADDRESS)).toLowerCase() === who.toLowerCase() ? 1n : 0n);
    return bal > 0n ? { info, id: x.id, bal } : null;
  }))).filter(Boolean);
  grid.replaceChildren(...held.map(({ info, id, bal }) => {
    const card = h('a', { class: 'nft-card', href: `#/i/${info.addr}/${id}` }, h('div', { class: 'media' }, spinner()),
      h('div', { class: 'body' }, h('div', { class: 'title', text: `${info.name || shortAddr(info.addr)} #${id}` }), info.kind === KIND.ERC1155 ? h('div', { class: 'muted small', text: `× ${bal}` }) : null,
        h('div', { class: 'badges' }, trustBadge(info))));
    tokenMeta(info, id).then((m) => { card.querySelector('.media').replaceChildren(imgEl(m.image, m.name)); if (m.name) card.querySelector('.title').textContent = m.name; });
    return card;
  }));
  if (!held.length) grid.replaceChildren(h('p', { class: 'muted', text: T('noHoldings') }));
  if (!(a.complete && b.complete && c.complete) && older < MAX_OLDER && scanSpan(older) < MAX_SCAN) el.append(h('a', { class: 'btn', href: `#/me?${who !== S.wallet?.account ? `a=${who}&` : ''}older=${older + 1}`, text: T('loadOlder') }));
}

function pageSettings(el) {
  el.append(h('h1', { text: T('settings') }));
  const rpc = input({ name: 'rpc', value: S.settings.rpc ?? '', placeholder: S.dep.rpc || 'https://rpc…' });
  const gwSel = h('select', { name: 'gatewayPreset' }, ...GATEWAYS.map((g) => h('option', { value: g, text: g, selected: g === gateway() })), h('option', { value: '', text: T('custom'), selected: !GATEWAYS.includes(gateway()) }));
  const gw = input({ name: 'gateway', value: GATEWAYS.includes(gateway()) ? '' : gateway(), placeholder: 'https://…/ipfs/' });
  // Contract overrides: developer mode (?dev=1) only, with a loud warning.
  const fac = DEV ? input({ name: 'factory', value: S.settings.factory ?? '', placeholder: S.dep.factory || '0x…' }) : null;
  const mk = DEV ? input({ name: 'marketplace', value: S.settings.marketplace ?? '', placeholder: S.dep.marketplace || '0x…' }) : null;
  const sb = input({ name: 'scanBlocks', type: 'number', min: '2000', step: '2000', value: String(scanWindow()) });
  el.append(h('form', { class: 'card form', on: { submit: (e) => e.preventDefault() } },
    field(T('rpcUrl'), rpc, T('rpcHint')), field(T('gateway'), gwSel), field(T('customGateway'), gw, T('gatewayHint')),
    DEV ? h('p', { class: 'badbox', id: 'devOverride', text: T('devOverrideWarn') }) : null,
    DEV ? field(T('factoryAddr'), fac, T('fromDeployments')) : null, DEV ? field(T('marketAddr'), mk, T('fromDeployments')) : null,
    field(T('scanBlocks'), sb, T('scanHint')),
    h('div', { class: 'row' },
      actionButton(T('save'), async () => {
        const next = {};
        const r = rpc.value.trim();
        if (r) { try { const u = new URL(r); if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw 0; next.rpc = u.href; } catch { throw new Error(T('badRpc')); } }
        const g = gw.value.trim() ? normalizeGateway(gw.value) : gwSel.value;
        if (!g) throw new Error(T('badGateway'));
        next.gateway = g;
        if (DEV) for (const [k, v] of [['factory', fac.value.trim()], ['marketplace', mk.value.trim()]]) { if (v) { if (!isAddress(v)) throw new Error(T('badAddress')); next[k] = checksum(v); } }
        next.scanBlocks = Number(sb.value) || 50_000;
        S.settings = next;
        save('zn.settings', next);
        infoCache.clear(); threatCache.clear(); metaCache.clear();
        await initRpc();
        status(T('saved'), 'ok');
      }),
      button(T('clearCache'), () => {
        try { for (const k of Object.keys(localStorage)) if (k.startsWith('zn.logs.')) localStorage.removeItem(k); } catch { /* none */ }
        status(T('cacheCleared'), 'ok');
      }))),
  h('section', { class: 'card' }, h('h2', { text: T('deployment') }), h('pre', { class: 'mono small break', text: JSON.stringify({ ...S.dep, registryNow: S.registry, chainId: S.chainId }, null, 2) })),
  h('p', { class: 'small muted', text: T('privacyNote') }),
  ipfsHelp());
}

// ---------------------------------------------------------------- router and chrome

let renderSeq = 0;
async function route() {
  const seq = ++renderSeq;
  const [path, query] = (location.hash.replace(/^#/, '') || '/').split('?');
  const q = new URLSearchParams(query ?? '');
  const parts = path.split('/').filter(Boolean);
  const el = h('div', { class: 'page' });
  main().replaceChildren(el);
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.getAttribute('href') === `#/${parts[0] ?? ''}`);
  try {
    if (!parts.length) await pageExplore(el, q);
    else if (parts[0] === 'c' && parts[1]) await pageCollection(el, parts[1], q);
    else if (parts[0] === 'i' && parts[1] && parts[2]) await pageItem(el, parts[1], parts[2]);
    else if (parts[0] === 'create') pageCreate(el);
    else if (parts[0] === 'mint' && parts[1]) await pageMint(el, parts[1]);
    else if (parts[0] === 'me') await pageMe(el, q);
    else if (parts[0] === 'settings') pageSettings(el);
    else el.append(h('p', { text: T('notFound') }));
  } catch (e) {
    if (seq === renderSeq) el.append(h('div', { class: 'badbox' }, h('strong', { text: T('loadError') }), h('p', { class: 'small', text: e instanceof RpcError ? cleanText(e.message, 200) : cleanText(e?.message ?? String(e), 200) })));
  }
  if (seq === renderSeq) el.setAttribute('data-ready', '1');
}

function applyChrome() {
  document.documentElement.lang = S.lang;
  if (S.theme) document.documentElement.setAttribute('data-theme', S.theme); else document.documentElement.removeAttribute('data-theme');
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = T(n.getAttribute('data-i18n'));
  $('#lang').textContent = S.lang === 'th' ? 'EN' : 'ไทย';
  $('#lang').setAttribute('aria-label', T('switchLang'));
  $('#theme').setAttribute('aria-label', T('switchTheme'));
  walletLabel();
}

async function start() {
  try {
    const r = await fetch('./deployments.json', { cache: 'no-cache' });
    if (r.ok) S.dep = await r.json();
  } catch { /* none yet */ }
  S.wallets = discoverWallets(window, () => {});
  applyChrome();
  $('#lang').addEventListener('click', () => { S.lang = LANGS[(LANGS.indexOf(S.lang) + 1) % LANGS.length]; save('zn.lang', S.lang); applyChrome(); route(); });
  $('#theme').addEventListener('click', () => {
    const dark = S.theme ? S.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    S.theme = dark ? 'light' : 'dark';
    save('zn.theme', S.theme);
    applyChrome();
  });
  $('#connect').addEventListener('click', () => (S.wallet ? route() : pickWallet()));
  $('#walletDialog .close').addEventListener('click', () => $('#walletDialog').close());
  window.addEventListener('hashchange', route);
  await initRpc();
  // Reconnect silently to the wallet used last time (eth_accounts: no prompt), before the first render.
  const last = load('zn.wallet', null);
  if (last) {
    await new Promise((r) => setTimeout(r, 60)); // EIP-6963 wallets answer the request event at once
    const w = S.wallets.list().find((x) => x.id === last);
    const acc = w ? await Promise.race([w.provider.request({ method: 'eth_accounts' }).catch(() => []), new Promise((r) => setTimeout(() => r([]), 1500))]) : [];
    if (acc?.[0] && isAddress(acc[0])) { S.wallet = { name: w.name, id: w.id, provider: w.provider, account: checksum(acc[0]) }; walletLabel(); }
  }
  await route();
}

start();
