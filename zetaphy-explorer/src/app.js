// ZETAPHY explorer: a static single-page app (hash routes). The browser reads
// the node's public EVM JSON-RPC, CometBFT RPC and Cosmos REST directly; there
// is no server, database or indexer. Chain data is shown with text nodes only.
import { h, fill, $, append } from './dom.js';
import { T, makeT, LANGS, pickLang } from './i18n.js';
import { loadConfig, saveLocal, endpoints, isPlaceholder, checkUrl, neuroLink, DEFAULTS, sanitizeConfig } from './config.js';
import { createApi, TTL } from './rpc.js';
import { chainApi } from './chain.js';
import { TOPICS, decodeTransfer, readTokenInfo, callData, decodeUint } from './evm.js';
import { TYPES, VOTE_OPTIONS, logsFromEvents, decodeTx } from './cosmos.js';
import { checkThreats } from './threat.js';
import { safety } from './wallet-safety.js';
import {
  safeText, tokenText, formatUnits, formatZtphy, formatCoin, short, percent, ago, utcTime, toAddress, toValoper, parseQuery,
  heightParam, hexPreview, toBig, groupDigits, DEAD_ADDRESS, anyAddressLower, fromBase64,
} from './format.js';
import { DISCLAIMER, REPRODUCE, keccak_256, bytesToHex, hexToBytes, PQ_LOCK_ADDRESS } from '../vendor/zetaphy-lib.js';

// ---- state ----

const store = (() => { try { const s = window.localStorage; s.getItem('x'); return s; } catch { return null; } })();
const pref = (k, v) => { try { if (v === undefined) return store?.getItem(`zetaphy-explorer:${k}`); store?.setItem(`zetaphy-explorer:${k}`, v); } catch { /* blocked */ } return null; };

let lang = pickLang(pref('lang')); // English unless a known language was chosen
// "Use a hardware wallet" help (wallet-safety.js, shared with the hub). The explorer connects no wallet;
// it records activity so the hub's 15-minute idle check counts reading here (same origin, in a frame).
const sf = safety({ win: window, lang: () => lang });
sf.track();
let t = makeT(lang);
let cfg = sanitizeConfig();
let siteCfg = sanitizeConfig();
let localCfg = {};
let api = null; let chain = null; let ready = false;
let validatorCache = { at: 0, rows: null, height: null, promise: null };
let refreshTimer = null;

// ---- small view helpers ----

const main = () => $('main');
const routeLink = (route, text, attrs = {}) => h('a', { href: `#/${route}`, ...attrs }, text);

function addrLink(addr, { full = false, label } = {}) {
  const a = toAddress(addr);
  if (!a) return h('span', { class: 'mono' }, safeText(addr, 90));
  return routeLink(`address/${a.hex}`, label ?? (full ? a.hex : short(a.hex, 8, 6)), { class: 'mono', title: `${a.hex}\n${a.bech32}` });
}
const valoperView = (v) => {
  const x = toValoper(v);
  if (!x) return h('span', { class: 'mono' }, safeText(v, 90));
  const mon = validatorCache.rows?.find((r) => r.operator === x.valoper)?.moniker;
  return h('span', null, mon ? h('span', { class: 'moniker' }, safeText(mon, 40), ' ') : null,
    routeLink(`validators/${x.valoper}`, short(x.valoper, 18, 6), { class: 'mono', title: x.valoper }));
};
const hashLink = (hash, { full = false } = {}) => routeLink(`tx/${hash}`, full ? hash : short(hash, 10, 6), { class: 'mono', title: hash });
const blockLink = (height) => routeLink(`block/${height}`, groupDigits(height), { class: 'mono' });
const badge = (text, kind = '') => h('span', { class: ['badge', kind && `badge-${kind}`] }, text);
const card = (title, ...children) => h('section', { class: 'card' }, title ? h('h2', null, title) : null, ...children);
const note = (text, kind = '') => h('p', { class: ['note', kind && `note-${kind}`] }, text);
const loading = () => h('p', { class: 'loading', role: 'status' }, t('loading'));
const errorBox = (e) => h('p', { class: 'error', role: 'alert' }, `${t('error')}: ${safeText(e?.message ?? e, 400)}`);

function kv(rows) {
  const dl = h('dl', { class: 'kv' });
  for (const r of rows) {
    if (!r) continue;
    const [k, v] = r;
    append(dl, [h('dt', null, k), h('dd', null, v ?? '—')]);
  }
  return dl;
}

function table(headers, rows, { empty, cls } = {}) {
  if (!rows.length) return note(empty ?? t('none'));
  return h('div', { class: 'table-wrap' }, h('table', { class: cls },
    h('thead', null, h('tr', null, headers.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { 'data-label': headers[i] }, c)))))));
}

function copyBtn(text) {
  return h('button', { type: 'button', class: 'copy', title: t('copy'), 'aria-label': t('copy'), on: { click: async (e) => {
    try { await navigator.clipboard.writeText(text); e.currentTarget.textContent = '✓'; } catch { /* clipboard blocked */ }
  } } }, '⧉');
}

const statusBadge = (ok) => (ok == null ? badge(t('pending'), 'warn') : ok ? badge(t('success'), 'ok') : badge(t('failed'), 'bad'));

/** A slot that fills itself when its promise settles (errors shown in place). */
function slot(promise, render, { inline = false } = {}) {
  const el = h(inline ? 'span' : 'div', { class: 'slot' }, inline ? '…' : loading());
  Promise.resolve(promise).then((v) => fill(el, render(v))).catch((e) => fill(el, inline ? h('span', { class: 'error' }, '?') : errorBox(e)));
  return el;
}

function windowNote(r) {
  return note(t('noIndexer', { n: groupDigits(Number(r.to) - Number(r.from) + 1), from: groupDigits(r.from), to: groupDigits(r.to) }), 'info');
}

// ---- header, settings banner, theme, language ----

function applyStatic() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  for (const el of document.querySelectorAll('[data-i18n-title]')) { el.setAttribute('title', t(el.dataset.i18nTitle)); el.setAttribute('aria-label', t(el.dataset.i18nTitle)); }
  $('lang').value = lang;
  document.title = t('title');
  $('footer-help')?.replaceChildren(sf.helpLink({ chains: ['evm', 'cosmos'], ledger: false }));
}

function applyTheme(theme) {
  const dark = theme ? theme === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme-toggle').textContent = dark ? '☀' : '☾';
}

function banner() {
  const b = $('banner');
  if (isPlaceholder(cfg)) {
    fill(b, h('p', null, t('placeholderNode'), ' ', routeLink('settings', t('openSettings'))));
    b.hidden = false;
  } else b.hidden = true;
}

// ---- pages ----

async function pageHome(view) {
  const stats = h('div', { class: 'stats' });
  const activity = h('section', { class: 'activity', hidden: '' });
  const blocks = h('div', null, loading());
  const txs = h('div', null, loading());
  append(view, [
    h('h1', null, t('homeTitle')),
    stats,
    activity,
    h('div', { class: 'grid2' }, card(t('latestBlocks'), blocks), card(t('latestTxs'), txs)),
  ]);
  loadActivity(activity).catch(() => { activity.hidden = true; });

  const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'stat-sub' }, sub) : null);

  async function refresh(first) {
    const st = await chain.status();
    const H = st.height;
    if (first) {
      fill(stats,
        stat(t('chainId'), h('span', { class: 'mono' }, safeText(st.chainId, 60)), `EVM ${cfg.evmChainId}`),
        stat(t('height'), h('span', { id: 'stat-height' }, blockLink(H)), h('span', { id: 'stat-age' }, ago(st.time, Date.now(), lang))),
        stat(t('supply'), slot(chain.supply(), (s) => (s == null ? '—' : formatZtphy(s, { maxFrac: 2 })), { inline: true }),
          slot(Promise.all([chain.supply(), chain.supplyAt(Math.max(1, Number(H) - 720))]), ([now, then]) => (now != null && then != null && then >= now
            ? t('burned1h', { x: formatZtphy(then - now, { maxFrac: 4 }) }) : t('supplyNote')), { inline: true })),
        stat(t('bonded'), slot(Promise.all([chain.stakingPool(), chain.supply()]), ([p, s]) => formatZtphy(p.bonded, { maxFrac: 0 }), { inline: true }),
          slot(Promise.all([chain.stakingPool(), chain.supply()]), ([p, s]) => (s ? t('bondedRatio', { p: percent(p.bonded, s) }) : ''), { inline: true })),
        stat(t('validators'), slot(getValidators(H), (rows) => String(rows.filter((r) => r.active).length), { inline: true }),
          slot(getValidators(H), (rows) => pqCoverage(rows), { inline: true })),
      );
    } else {
      const he = $('stat-height'); if (he) fill(he, blockLink(H));
      const ae = $('stat-age'); if (ae) ae.textContent = ago(st.time, Date.now(), lang);
    }
    const [metas, vals] = await Promise.all([chain.blockMetas(Math.max(1, Number(H) - 9), H, H), getValidators(H).catch(() => null)]);
    fill(blocks, table([t('block'), t('age'), t('proposer'), t('txs')], metas.map((m) => [
      blockLink(m.header.height), ago(m.header.time, Date.now(), lang), proposerView(m.header.proposer_address, vals), String(m.num_txs),
    ]), { cls: 'compact' }), note(t('txsCountNote')));
    const r = await chain.recentTxs(H, cfg.scanBlocks);
    const list = r.txs.slice(0, 15);
    fill(txs, txTable(list, { empty: t('noRecentTxs') }), windowNote(r), r.complete ? null : note(t('scanIncomplete'), 'warn'));
  }
  await refresh(true);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.hidden || !view.isConnected) return;
    refresh(false).catch(() => { /* next tick */ });
  }, 6000);
}

// Chain activity this month, from Neuro's daily counts (cfg.chainStatsUrl), read once per visit.
async function loadActivity(box) {
  const url = String(cfg.chainStatsUrl ?? '').trim();
  if (!url || isPlaceholder(cfg)) return;
  const res = await fetch(checkUrl(url), { credentials: 'omit', cache: 'default' });
  const r = res.ok ? await res.json() : null;
  if (!r?.enabled || !r.updatedAt || !r.thisMonth || !box.isConnected) return;
  const n = new Intl.NumberFormat(lang);
  const num = (x) => n.format(Number(x) || 0);
  const KEYS = [['all', 'actAll'], ['transfers', 'actTransfers'], ['staking', 'actStaking'], ['crossChain', 'actCrossChain'], ['evm', 'actEvm'], ['governance', 'actGovernance']];
  fill(box,
    h('h2', null, t('activityTitle')),
    h('div', { class: 'stats' }, ...KEYS.map(([k, label]) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, t(label)), h('div', { class: 'stat-value' }, num(r.thisMonth[k]))))),
    note(t('activityNote', { n: num(r.total?.all), when: ago(r.updatedAt, Date.now(), lang) })),
  );
  box.hidden = false;
}

function pqCoverage(rows) {
  const active = rows.filter((r) => r.active);
  const total = active.reduce((n, r) => n + r.power, 0n);
  const withKey = active.filter((r) => r.voteKey?.registered).reduce((n, r) => n + r.power, 0n);
  return t('pqCoverage', { p: percent(withKey, total || 1n) });
}

function proposerView(consAddr, vals) {
  const a = String(consAddr ?? '').toUpperCase();
  const v = vals?.find((r) => r.address === a);
  return v?.moniker ? h('span', { title: a }, safeText(v.moniker, 32)) : h('span', { class: 'mono', title: a }, short(a, 8, 4));
}

function txTable(list, { empty } = {}) {
  return table([t('txHash'), t('type'), t('block'), t('fromTo'), t('value'), t('status')], list.map((x) => [
    hashLink(x.hash),
    h('span', { class: 'txtype' }, x.evm ? badge('EVM', 'evm') : badge('Cosmos', 'cosmos'), ' ', x.zetaphy ? badge('ZETAPHY', 'pq') : null, h('span', { class: 'small label' }, safeText(x.label, 48))),
    blockLink(x.height),
    h('span', { class: 'fromto' }, x.from ? (x.from.startsWith('zetaphyvaloper') ? valoperView(x.from) : addrLink(x.from)) : '—', ' → ', x.to ? (x.to.startsWith('zetaphyvaloper') ? valoperView(x.to) : addrLink(x.to)) : '—'),
    x.value != null ? formatZtphy(x.value, { maxFrac: 4 }) : '—',
    statusBadge(x.ok),
  ]), { empty });
}

function getValidators(height) {
  if (validatorCache.promise && Date.now() - validatorCache.at < 300_000) return validatorCache.promise; // 5 min: one abci_query per validator
  const at = Date.now();
  const promise = chain.validators(height).then((rows) => { if (validatorCache.promise === promise) validatorCache.rows = rows; return rows; });
  promise.catch(() => { if (validatorCache.promise === promise) validatorCache.promise = null; });
  validatorCache = { at, rows: validatorCache.rows, height, promise };
  return promise;
}

// -- block --

async function pageBlock(view, param) {
  let H = heightParam(param);
  if (!H) { append(view, errorBox(t('badBlock'))); return; }
  const st = await chain.status();
  if (BigInt(H) > BigInt(st.height)) { append(view, h('h1', null, `${t('block')} #${groupDigits(H)}`), note(t('blockFuture', { h: groupDigits(st.height) }), 'warn')); return; }
  const [b, res, vals] = await Promise.all([chain.block(H), chain.blockResults(H).catch(() => null), getValidators(st.height).catch(() => [])]);
  const hd = b.block.header;
  const txs = b.block.data?.txs ?? [];
  const decoded = txs.map((x) => decodeTx(fromBase64(x)));
  const prev = BigInt(H) > 1n ? routeLink(`block/${BigInt(H) - 1n}`, `← ${t('prev')}`) : null;
  const next = BigInt(H) < BigInt(st.height) ? routeLink(`block/${BigInt(H) + 1n}`, `${t('next')} →`) : null;
  append(view, [
    h('h1', null, `${t('block')} #${groupDigits(H)}`),
    h('nav', { class: 'pager' }, prev, next),
    card(t('overview'), kv([
      [t('height'), groupDigits(H)],
      [t('blockHash'), h('span', { class: 'mono break' }, safeText(b.block_id?.hash, 80), ' ', copyBtn(String(b.block_id?.hash ?? '')))],
      [t('time'), `${utcTime(hd.time)} (${ago(hd.time, Date.now(), lang)})`],
      [t('proposer'), h('span', null, proposerView(hd.proposer_address, vals), ' ', h('span', { class: 'mono small' }, safeText(hd.proposer_address, 50)))],
      [t('chainId'), h('span', { class: 'mono' }, safeText(hd.chain_id, 60))],
      [t('txs'), String(txs.length)],
      [t('parentHash'), BigInt(H) > 1n ? routeLink(`block/${BigInt(H) - 1n}`, safeText(hd.last_block_id?.hash, 80), { class: 'mono break' }) : '—'],
      [t('appHash'), h('span', { class: 'mono break' }, safeText(hd.app_hash, 80))],
      [t('dataHash'), h('span', { class: 'mono break' }, safeText(hd.data_hash, 80))],
      [t('validatorsHash'), h('span', { class: 'mono break' }, safeText(hd.validators_hash, 80))],
    ])),
    pqCard(H, st.height, vals),
    card(t('transactions'), table(['#', t('txHash'), t('type'), t('status'), t('gasUsed')], decoded.map((d, i) => {
      const r = res?.txs_results?.[i];
      const evmHash = d.evmHashes[0];
      return [String(i), hashLink(evmHash ?? d.hash), h('span', null, d.isCertificate ? badge(t('pqCertTx'), 'pq') : null, ' ',
        d.isCertificate ? routeLink(`block/${d.messages[0].certificate.height}`, t('certifiesBlock', { h: groupDigits(String(d.messages[0].certificate.height)) })) : h('span', { class: 'mono small' }, safeText(d.messages.map((m) => m.name).join(', ') || (d.error ? t('undecodable') : ''), 80))),
      statusBadge(r ? Number(r.code ?? 0) === 0 : null), r?.gas_used ? groupDigits(String(r.gas_used)) : '—'];
    }), { empty: t('noTxsInBlock') })),
  ]);
}

/** The ML-DSA-44 certificate of block H (it is tx[0] of block H+1), checked here with pqcert.js. */
function pqCard(H, latest, vals) {
  const body = h('div', null);
  const box = card(t('pqTitle'), note(t('pqExplain', { h: groupDigits(H), n: groupDigits(String(BigInt(H) + 1n)) })), body);
  const moniker = (a) => vals?.find((v) => v.address === a)?.moniker;
  if (BigInt(H) >= BigInt(latest)) {
    append(body, note(t('pqNotYet', { n: groupDigits(String(BigInt(H) + 1n)) }), 'warn'));
    return box;
  }
  const run = () => {
    fill(body, h('p', { class: 'loading', role: 'status' }, t('pqVerifying')));
    chain.verifyPQ(H).then((r) => {
      // ok with nothing required and no certificate: no vote keys yet, so nothing was signed (not "valid")
      const verdict = r.ok && !r.certificate && r.required === 0n ? badge(t('pqNone'), 'warn')
        : r.ok ? badge(r.pqMajority ? t('pqOkMajority') : t('pqOk'), 'ok') : badge(t('pqFail'), 'bad');
      const pct = r.totalPower ? Number((r.signedPower * 10000n) / r.totalPower) / 100 : 0;
      const bar = h('div', { class: 'bar', role: 'img', 'aria-label': `${pct}%` }, h('div', { class: 'bar-fill' }));
      bar.firstChild.style.width = `${Math.min(100, pct)}%`; // CSSOM, allowed by the CSP
      if (r.totalPower) {
        const need = h('div', { class: 'bar-need' });
        need.style.left = `${Math.min(100, Number((r.required * 10000n) / r.totalPower) / 100)}%`;
        bar.append(need);
      }
      fill(body,
        h('p', { class: 'verdict' }, verdict, ' ', routeLink(`block/${BigInt(H) + 1n}`, t('pqInBlock', { n: groupDigits(String(BigInt(H) + 1n)) }))),
        // Next to the verdict, not below the table: the keys and powers come from this node.
        note(t('pqTrust'), 'info'),
        kv([
          [t('pqSigned'), `${groupDigits(r.signedPower.toString())} / ${groupDigits(r.totalPower.toString())} (${percent(r.signedPower, r.totalPower || 1n)})`],
          [t('pqRequired'), r.required > 0n ? groupDigits(r.required.toString()) : t('pqNothingRequired')],
          [t('pqUnregistered'), groupDigits(r.unregisteredPower.toString())],
          [t('pqRule'), t('pqRuleText')],
        ]),
        bar,
        table([t('validator'), t('consAddress'), t('power'), t('voteKey'), t('pqSignedCol')], r.validators.map((v) => [
          moniker(v.address) ? safeText(moniker(v.address), 40) : '—', h('span', { class: 'mono small' }, v.address), groupDigits(v.power.toString()),
          v.hasKey ? badge(t('yes'), 'ok') : badge(t('no'), 'warn'), v.signed ? badge('✓ ML-DSA-44', 'ok') : badge('—', ''),
        ])),
        r.problems.length ? h('ul', { class: 'problems' }, r.problems.map((p) => h('li', null, safeText(p, 300)))) : null,
      );
    }).catch((e) => fill(body, errorBox(e), h('button', { type: 'button', on: { click: run } }, t('retry'))));
  };
  run();
  return box;
}

// -- tx --

async function pageTx(view, param) {
  const q = String(param ?? '').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(q)) { append(view, errorBox(t('badHash'))); return; }
  const hex = q.replace(/^0x/i, '').toLowerCase();
  const tryEvm = async () => { const tx = await chain.evmTx('0x' + hex); return tx ? { evm: tx } : null; };
  const tryCosmos = async () => { const tx = await chain.cosmosTx(hex); return tx ? { cosmos: tx } : null; };
  const order = /^0x/i.test(q) ? [tryEvm, tryCosmos] : [tryCosmos, tryEvm];
  let found = null;
  for (const f of order) { try { found = await f(); } catch { found = null; } if (found) break; }
  if (!found) {
    // A block hash typed in the search box?
    try {
      const b = await chain.blockByHash(hex);
      if (b?.block?.header?.height) { location.hash = `#/block/${b.block.header.height}`; return; }
    } catch { /* not a block */ }
    append(view, h('h1', null, t('transaction')), note(t('txNotFound', { n: groupDigits(cfg.scanBlocks) }), 'warn'));
    return;
  }
  if (found.evm) await renderEvmTx(view, found.evm);
  else await renderCosmosTx(view, found.cosmos);
}

const tokenCache = new Map();
function tokenInfo(addr) {
  const k = addr.toLowerCase();
  if (!tokenCache.has(k)) tokenCache.set(k, readTokenInfo((to, data) => chain.ethCall(to, data), addr).catch(() => ({ standard: null })));
  return tokenCache.get(k);
}

function transferView(tr) {
  const amount = tr.standard === 'erc20'
    ? slot(tokenInfo(tr.token), (i) => `${i.decimals != null ? formatUnits(tr.amount, i.decimals, { maxFrac: 8 }) : groupDigits(tr.amount.toString())} ${tokenText(i.symbol, 16, '')}`, { inline: true })
    : tr.standard === 'erc721' ? `NFT #${safeText(tr.tokenId.toString(), 40)}`
      : tr.ids.map((id, i) => `#${safeText(id.toString(), 40)} ×${groupDigits(tr.amounts[i].toString())}`).join(', ');
  return h('div', { class: 'transfer' },
    badge(tr.standard.toUpperCase().replace('ERC', 'ERC-'), 'token'), ' ',
    tr.mint ? badge(t('mint'), 'ok') : tr.burn ? badge(t('burn'), 'warn') : null, ' ',
    addrLink(tr.from), ' → ', addrLink(tr.to), ' · ', amount, ' · ',
    routeLink(`token/${tr.token}`, slot(tokenInfo(tr.token), (i) => tokenText(i.name ?? i.symbol, 32, short(tr.token, 8, 4)), { inline: true }), { title: tr.token }));
}

function logsView(logs) {
  if (!logs.length) return note(t('noLogs'));
  return h('ol', { class: 'logs' }, logs.map((l) => {
    const tr = decodeTransfer(l);
    return h('li', null, tr ? transferView(tr) : h('div', null,
      h('div', null, t('emittedBy'), ' ', addrLink(l.address)),
      h('div', { class: 'mono small break' }, (l.topics ?? []).map((x, i) => h('div', null, `topic${i}: ${safeText(x, 70)}`))),
      h('div', { class: 'mono small break' }, `data: ${safeText(String(l.data ?? '').slice(0, 258), 260)}${String(l.data ?? '').length > 258 ? '…' : ''}`)));
  }));
}

async function renderEvmTx(view, tx) {
  const rc = await chain.evmReceipt(tx.hash);
  const status = rc ? (rc.status === '0x1') : null;
  const gasUsed = toBig(rc?.gasUsed); const price = toBig(rc?.effectiveGasPrice ?? tx.gasPrice);
  const input = String(tx.input ?? '0x');
  const toView = tx.to ? addrLink(tx.to, { full: true }) : rc?.contractAddress ? h('span', null, badge(t('contractCreated'), 'ok'), ' ', addrLink(rc.contractAddress, { full: true })) : t('contractCreation');
  let special = null;
  if (tx.to && tx.to.toLowerCase() === PQ_LOCK_ADDRESS.toLowerCase() && input.length === 42) special = note(t('quantumLockTx', { c: toAddress(input)?.bech32 ?? input }), 'info');
  if (tx.to && tx.to.toLowerCase() === DEAD_ADDRESS.toLowerCase()) special = note(t('deadTx'), 'info');
  append(view, [
    h('h1', null, t('transaction'), ' ', badge('EVM', 'evm')),
    card(t('overview'), kv([
      [t('txHash'), h('span', { class: 'mono break' }, tx.hash, ' ', copyBtn(tx.hash))],
      [t('status'), statusBadge(status)],
      [t('block'), tx.blockNumber ? blockLink(BigInt(tx.blockNumber).toString()) : t('pending')],
      [t('from'), addrLink(tx.from, { full: true })],
      [t('to'), toView],
      [t('value'), formatZtphy(toBig(tx.value) ?? 0n, { maxFrac: 18 })],
      [t('fee'), gasUsed != null && price != null ? formatZtphy(gasUsed * price, { maxFrac: 18 }) : '—'],
      [t('gas'), `${gasUsed != null ? groupDigits(gasUsed.toString()) : '?'} / ${groupDigits((toBig(tx.gas) ?? 0n).toString())}`],
      [t('gasPrice'), price != null ? `${formatUnits(price, 9, { maxFrac: 4 })} gwei` : '—'],
      [t('nonce'), (toBig(tx.nonce) ?? 0n).toString()],
      [t('txType'), String(toBig(tx.type) ?? 0n)],
      [t('input'), input === '0x' ? t('noInput') : h('details', null, h('summary', null, `${input.slice(0, 10)} · ${groupDigits((input.length - 2) / 2)} bytes`), h('div', { class: 'mono small break' }, input.slice(0, 20000)))],
    ]), special),
    card(t('logs'), rc ? logsView(rc.logs ?? []) : note(t('pending'))),
  ]);
}

function fieldView(f) {
  switch (f.kind) {
    case 'addr': case 'evmFrom': return f.value ? addrLink(f.value, { full: true }) : '—';
    case 'valoper': return valoperView(f.value);
    case 'valoperOrAddr': return String(f.value).startsWith('zetaphyvaloper') ? valoperView(f.value) : addrLink(f.value, { full: true });
    case 'coins': return f.value.map(formatCoin).join(', ') || '0';
    case 'coin': return formatCoin(f.value);
    case 'azeta': return /^\d*$/.test(f.value) ? formatZtphy(f.value || '0', { maxFrac: 18 }) : safeText(f.value, 80);
    case 'azetaBig': return formatZtphy(f.value, { maxFrac: 18 });
    case 'uint': return groupDigits(f.value.toString());
    case 'uintBool': return f.value ? t('on') : t('off');
    case 'bool': return f.value ? t('yes') : t('no');
    case 'voteOption': return VOTE_OPTIONS[Number(f.value)] ?? `#${f.value}`;
    case 'evmData': return f.value.length ? h('details', null, h('summary', { class: 'mono' }, `0x${bytesToHex(f.value.subarray(0, 4))} · ${f.value.length} bytes`), h('div', { class: 'mono small break' }, hexPreview(f.value, 4096))) : t('noInput');
    case 'bytes': return h('span', { class: 'mono small break' }, hexPreview(f.value, 48));
    case 'attestations': return `${groupDigits(f.value.length)} bytes`;
    case 'anys': return f.value.map((x) => safeText(x, 120)).join(', ');
    default: return safeText(f.value, 500);
  }
}

const MSG_HELP = {
  [TYPES.evmCall]: 'helpEvmCall', [TYPES.quantumLock]: 'helpQuantumLock', [TYPES.pqVoteKey]: 'helpPQVoteKey',
  [TYPES.pqCertificate]: 'helpPQCertificate', [TYPES.setPQEvidence]: 'helpSetPQEvidence', [TYPES.ethereumTx]: 'helpEthereumTx',
};

function messageView(m, i) {
  const extra = [];
  if (m.certificate) {
    const c = m.certificate;
    extra.push(kv([
      [t('certifiesBlockLabel'), blockLink(String(c.height))],
      [t('attestations'), c.attestations ? String(c.attestations.length) : t('malformed')],
    ]));
    if (c.attestations?.length) {
      const vals = validatorCache.rows;
      extra.push(table([t('validator'), t('consAddress')], c.attestations.map((a) => [safeText(vals?.find((v) => v.address === a.address)?.moniker ?? '—', 40), h('span', { class: 'mono small' }, a.address)])));
    }
    extra.push(note(t('pqVerifyOnBlock'), 'info'), routeLink(`block/${c.height}`, t('pqVerifyLink', { h: groupDigits(String(c.height)) })));
  }
  if (m.evmHash) extra.push(h('p', null, t('evmView'), ' ', hashLink(m.evmHash, { full: true })));
  if (m.contractCreation) extra.push(note(t('contractCreation'), 'info'));
  return h('div', { class: 'msg' },
    h('h3', null, `#${i} ${m.name}`, ' ', m.zetaphy ? badge('ZETAPHY', 'pq') : null, ' ', h('span', { class: 'mono small dim' }, safeText(m.typeUrl, 120))),
    MSG_HELP[m.typeUrl] ? note(t(MSG_HELP[m.typeUrl])) : null,
    kv(m.fields.map((f) => [f.name, fieldView(f)])),
    extra);
}

async function renderCosmosTx(view, r) {
  const d = r.decoded; const res = r.txResult;
  const code = Number(res?.code ?? 0);
  const blk = await chain.block(r.height).catch(() => null);
  const evLogs = logsFromEvents(res.events);
  append(view, [
    h('h1', null, t('transaction'), ' ', badge('Cosmos', 'cosmos'), ' ', d.isCertificate ? badge(t('pqCertTx'), 'pq') : null),
    card(t('overview'), kv([
      [t('txHash'), h('span', { class: 'mono break' }, d.hash, ' ', copyBtn(d.hash))],
      [t('status'), code === 0 ? statusBadge(true) : h('span', null, statusBadge(false), ` code ${code} · `, h('span', { class: 'small' }, safeText(res.log, 400)))],
      [t('block'), blockLink(r.height)],
      [t('time'), blk ? `${utcTime(blk.block.header.time)} (${ago(blk.block.header.time, Date.now(), lang)})` : '—'],
      [t('gas'), `${groupDigits(String(res.gas_used ?? '?'))} / ${groupDigits(String(res.gas_wanted ?? '?'))}`],
      [t('fee'), d.fee.amount.map(formatCoin).join(', ') || '0'],
      d.memo ? [t('memo'), safeText(d.memo, 256)] : null,
      [t('signers'), d.signers.length ? h('ul', { class: 'plain' }, d.signers.map((s) => h('li', null,
        s.pubKeyType === '/zetaphy.crypto.mldsa44.PubKey' ? badge(t('mldsaSigner'), 'pq') : badge(safeText(s.pubKeyLabel || t('unknown'), 60)), ` ${t('sequence')} ${s.sequence}`))) : t('noSigners')],
      [t('size'), `${groupDigits(d.size)} bytes`],
    ])),
    d.error ? errorBox(t('undecodable') + ': ' + d.error) : null,
    card(t('messages'), d.messages.map(messageView)),
    evLogs.length ? card(t('logs'), logsView(evLogs)) : null,
    card(t('events'), h('details', null, h('summary', null, t('showEvents', { n: res.events.length })),
      h('div', null, res.events.map((e) => h('div', { class: 'event' }, h('strong', null, safeText(e.type, 80)),
        kv(e.attributes.map((a) => [safeText(a.key, 80), h('span', { class: 'mono small break' }, safeText(a.value, 600))]))))))),
  ]);
}

// -- address --

async function pageAddress(view, param) {
  const a = toAddress(decodeURIComponent(param ?? ''));
  if (!a) { append(view, errorBox(t('badAddress'))); return; }
  const st = await chain.status();
  const acc = await chain.account(a);
  const isContract = acc.code !== '0x' && acc.code.length > 2;
  const pq = acc.pq && !acc.pq.error ? acc.pq : null;
  const badges = [
    isContract ? badge(t('contract'), 'evm') : badge(t('account'), ''),
    pq?.pubKeyType === 'mldsa44' ? badge(t('mldsaAccount'), 'pq') : null,
    pq?.quantumLockedTo ? badge(t('quantumLocked'), 'pq') : null,
    a.lower === DEAD_ADDRESS.toLowerCase() ? badge(t('deadAddress'), 'warn') : null,
  ];
  const tokenSlot = isContract ? slot(tokenInfo(a.hex), (i) => (i.standard ? h('p', null, badge(i.standard.toUpperCase().replace('ERC', 'ERC-'), 'token'), ' ', routeLink(`token/${a.hex}`, `${tokenText(i.name, 40)} (${tokenText(i.symbol, 16)}) · ${t('tokenPage')}`)) : '')) : null;
  append(view, [
    h('h1', null, isContract ? t('contract') : t('address')),
    h('p', null, badges),
    card(t('overview'), kv([
      ['0x', h('span', { class: 'mono break' }, a.hex, ' ', copyBtn(a.hex))],
      ['zetaphy1', h('span', { class: 'mono break' }, a.bech32, ' ', copyBtn(a.bech32))],
      [t('balance'), acc.balance != null ? formatZtphy(acc.balance, { maxFrac: 18 }) : '—'],
      [t('nonce'), acc.nonce != null ? acc.nonce.toString() : '—'],
      [t('sequence'), pq ? (pq.exists ? `${safeText(pq.sequence, 20)} (${t('accountNumber')} ${safeText(pq.accountNumber, 20)})` : t('notOnChain')) : '—'],
      [t('pubKeyType'), pq?.pubKeyType ? safeText(pq.pubKeyType, 40) : t('noPubKey')],
      [t('quantumLock'), pq?.quantumLockedTo ? h('span', null, t('lockedTo'), ' ', addrLink(pq.quantumLockedTo, { full: true })) : pq ? t('notLocked') : t('unknownRpc')],
      isContract ? [t('codeSize'), `${groupDigits((acc.code.length - 2) / 2)} bytes · keccak ${short('0x' + bytesToHex(keccak_256(hexToBytes(acc.code))), 12, 8)}`] : null,
      [t('otherBalances'), slot(chain.bankBalances(a.bech32), (bs) => bs.filter((b) => b.denom !== 'azetaphy').map(formatCoin).join(', ') || t('none'), { inline: true })],
      [t('delegated'), slot(chain.delegations(a.bech32), (ds) => (ds.length ? formatZtphy(ds.reduce((n, d) => n + (toBig(d.balance?.amount) ?? 0n), 0n), { maxFrac: 4 }) + ` · ${ds.length} ${t('validatorsLower')}` : t('none')), { inline: true })],
    ]), tokenSlot, pq?.quantumLockedTo ? note(t('quantumLockedHelp'), 'info') : null),
    threatCard(a, acc.code),
    card(t('tokenBalances'), slot(tokenBalances(a, st.height), (x) => x)),
    card(t('recentTxs'), slot(chain.recentTxs(st.height, cfg.scanBlocks), (r) => {
      const mine = r.txs.filter((x) => x.addresses.has(a.lower) || anyAddressLower(x.from) === a.lower || anyAddressLower(x.to) === a.lower);
      return h('div', null, txTable(mine.slice(0, 50), { empty: t('noTxsForAddress') }), windowNote(r));
    })),
  ]);
}

async function tokenBalances(a, latest) {
  const from = Math.max(1, Number(latest) - cfg.scanBlocks + 1);
  const logs = await chain.transferLogs(a.lower, from, Number(latest), TOPICS);
  const transfers = logs.map(decodeTransfer).filter(Boolean);
  const tokens = [...new Set(transfers.map((x) => x.token))].slice(0, 20);
  const rows = await Promise.all(tokens.map(async (tok) => {
    const info = await tokenInfo(tok);
    let bal = null;
    try { bal = decodeUint(await chain.ethCall(tok, callData.balanceOf(a.hex))); } catch { bal = null; }
    const shown = bal == null ? '?' : info.standard === 'erc20' && info.decimals != null ? formatUnits(bal, info.decimals, { maxFrac: 8 }) : groupDigits(bal.toString());
    return [routeLink(`token/${tok}`, tokenText(info.name, 32, short(tok, 8, 4)), { title: tok }), tokenText(info.symbol, 16), info.standard ? info.standard.toUpperCase().replace('ERC', 'ERC-') : '?', shown];
  }));
  return h('div', null,
    table([t('token'), t('symbol'), t('standard'), t('balance')], rows, { empty: t('noTokens') }),
    transfers.length ? h('details', null, h('summary', null, t('recentTransfers', { n: transfers.length })), h('div', null, transfers.slice(0, 50).map(transferView))) : null,
    note(t('tokenWindowNote', { n: groupDigits(Number(latest) - from + 1) }), 'info'));
}

// ThreatRegistry: neutral, factual wording (docs/LEGAL.md); the disclaimer is always shown with a flag.
function threatCard(a, code) {
  const body = h('div', null, loading());
  const box = card(t('threatTitle'), body);
  if (!cfg.threatRegistry) { fill(body, note(t('threatUnset'))); return box; }
  checkThreats((m, p) => chain.evmCall(m, p), { registry: cfg.threatRegistry, chainId: cfg.evmChainId, address: a.lower, code }).then((r) => {
    if (r.state === 'error') { fill(body, note(t('threatError', { e: safeText(r.error, 200) }), 'warn')); return; }
    if (r.state === 'clean') {
      fill(body, h('p', null, badge(t('threatClean'), 'ok')), note(t('threatCleanNote', { n: r.checked.length })), registryLine());
      return;
    }
    fill(body,
      r.flags.map((f) => h('div', { class: 'flag' },
        h('p', null, badge(f.enforced ? t('threatEnforced') : t('threatFlagged'), 'warn'), ' ', t('threatFlaggedBy')),
        kv([
          [t('threatKey'), `${t(`what_${f.what}`)}${f.via ? ` (${t('threatVia', { p: short(f.via, 8, 6) })})` : ''}`],
          [t('threatCategory'), `${f.reasonText[lang] ?? f.reasonText.en} (${f.reasonName})`],
          [t('threatEvidence'), f.evidence?.reportHash ? h('span', { class: 'mono small break' }, `reportHash ${f.evidence.reportHash}`, f.evidence.uri ? ` · ${safeText(f.evidence.uri, 200)}` : '', ` · ${t('by')} `, addrLink(f.evidence.by), f.evidence.at ? ` · ${utcTime(f.evidence.at)}` : '') : t('threatNoEvidence')],
          [t('threatResponse'), f.responses?.length ? h('ul', { class: 'plain' }, f.responses.map((x) => h('li', null, `“${safeText(x.text, 500)}” — `, addrLink(x.by), x.assigned ? ` (${t('threatAssigned')})` : ''))) : t('threatNoResponse')],
        ]))),
      h('p', { class: 'disclaimer' }, DISCLAIMER[lang] ?? DISCLAIMER.en),
      note(REPRODUCE[lang] ?? REPRODUCE.en),
      registryLine(),
    );
  });
  return box;
}
const registryLine = () => h('p', { class: 'small dim' }, 'ThreatRegistry ', addrLink(cfg.threatRegistry));

// -- token --

async function pageToken(view, param) {
  const a = toAddress(decodeURIComponent(param ?? ''));
  if (!a) { append(view, errorBox(t('badAddress'))); return; }
  const st = await chain.status();
  const [info, acc] = await Promise.all([tokenInfo(a.hex), chain.account(a)]);
  const isContract = acc.code !== '0x' && acc.code.length > 2;
  const link = neuroLink(cfg, a.hex);
  const supply = info.totalSupply == null ? '—' : info.standard === 'erc20' && info.decimals != null ? `${formatUnits(info.totalSupply, info.decimals, { maxFrac: 8 })} ${tokenText(info.symbol, 16)}` : groupDigits(info.totalSupply.toString());
  append(view, [
    h('h1', null, t('token'), ': ', h('span', { class: 'token-name' }, tokenText(info.name, 48)), ' ', h('span', { class: 'dim' }, `(${tokenText(info.symbol, 16)})`)),
    !isContract ? note(t('notAContract'), 'warn') : null,
    card(t('overview'), kv([
      [t('contract'), addrLink(a.hex, { full: true })],
      [t('standard'), info.standard ? info.standard.toUpperCase().replace('ERC', 'ERC-') : t('unknownStandard')],
      [t('name'), tokenText(info.name, 48)],
      [t('symbol'), tokenText(info.symbol, 16)],
      [t('decimals'), info.decimals != null ? String(info.decimals) : '—'],
      [t('totalSupply'), supply],
      [t('neuroReport'), link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, t('openNeuro')) : t('neuroUnset')],
    ]), note(t('tokenTextNote'))),
    threatCard(a, acc.code),
    card(t('recentTransfers', { n: '' }).trim(), slot((async () => {
      const from = Math.max(1, Number(st.height) - cfg.scanBlocks + 1);
      const logs = await chain.tokenLogs(a.hex, from, Number(st.height), TOPICS);
      const trs = logs.map((l) => ({ l, tr: decodeTransfer(l) })).filter((x) => x.tr).slice(0, 50);
      return h('div', null, trs.length ? trs.map(({ l, tr }) => h('div', { class: 'transfer-row' }, blockLink(BigInt(l.blockNumber).toString()), ' · ', hashLink(l.transactionHash), ' · ', transferView(tr))) : note(t('noTransfers')),
        note(t('tokenWindowNote', { n: groupDigits(Number(st.height) - from + 1) }), 'info'));
    })(), (x) => x)),
  ]);
}

// -- validators --

async function pageValidators(view, param) {
  const st = await chain.status();
  const rows = await getValidators(st.height);
  const active = rows.filter((r) => r.active);
  const total = active.reduce((n, r) => n + r.power, 0n);
  const keyed = active.filter((r) => r.voteKey?.registered).reduce((n, r) => n + r.power, 0n);
  const focus = param ? toValoper(decodeURIComponent(param))?.valoper : null;
  append(view, [
    h('h1', null, t('validators')),
    card(null, kv([
      [t('activeValidators'), String(active.length)],
      [t('totalPower'), groupDigits(total.toString())],
      [t('pqKeyPower'), `${groupDigits(keyed.toString())} (${percent(keyed, total || 1n)})`],
      [t('atHeight'), blockLink(st.height)],
    ]), note(t('pqKeyExplain'))),
    card(null, table(['#', t('validator'), t('operator'), t('power'), t('status'), t('commission'), t('voteKey')], rows.map((r, i) => [
      String(i + 1),
      h('span', { class: focus && r.operator === focus ? 'focus' : '' }, safeText(r.moniker || '—', 40)),
      r.operator ? h('span', null, h('span', { class: 'mono small', title: r.operator }, short(r.operator, 18, 6)), ' ', toValoper(r.operator)?.account ? routeLink(`address/${toValoper(r.operator).account.hex}`, t('accountLink')) : null) : '—',
      r.active ? `${groupDigits(r.power.toString())} (${percent(r.power, total || 1n)})` : '0',
      r.jailed ? badge(t('jailed'), 'bad') : r.active ? badge(t('active'), 'ok') : badge(t('inactive'), ''),
      r.commission ? percent(BigInt(Math.round(Number(r.commission) * 1e6)), 1000000n) : '—',
      r.voteKey?.registered ? h('span', null, badge(t('registered'), 'ok'), r.voteKey.since ? h('span', { class: 'small dim' }, ` ${t('sinceBlock', { h: groupDigits(r.voteKey.since) })}`) : null)
        : r.voteKey?.registered === false ? badge(t('notRegistered'), 'warn') : badge('?', ''),
    ]))),
  ]);
}

// -- settings --

function pageSettings(view) {
  const input = (id, value, placeholder) => h('input', { id, value: value ?? '', placeholder: placeholder ?? '', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
  const field = (id, label, value, placeholder, help) => h('div', { class: 'field' }, h('label', { for: id }, label), input(id, value, placeholder), help ? h('p', { class: 'hint' }, help) : null);
  const msg = h('p', { class: 'msg-line', role: 'status' });
  let eps; try { eps = endpoints(cfg); } catch (e) { eps = null; }
  const form = h('form', { class: 'settings', on: { submit: (e) => { e.preventDefault(); save(); } } },
    field('s-node', t('sNode'), localCfg.node ?? '', siteCfg.node, t('sNodeHelp')),
    h('details', null, h('summary', null, t('sAdvanced')),
      field('s-evm', t('sEvm'), localCfg.evmRpc ?? '', siteCfg.evmRpc || 'https://<node-host>/'),
      field('s-comet', t('sComet'), localCfg.cometRpc ?? '', siteCfg.cometRpc || 'https://<node-host>/rpc/'),
      field('s-rest', t('sRest'), localCfg.rest ?? '', siteCfg.rest || 'https://<node-host>/rest/')),
    field('s-threat', t('sThreat'), localCfg.threatRegistry ?? '', siteCfg.threatRegistry || '0x…', t('sThreatHelp')),
    field('s-neuro', t('sNeuro'), localCfg.neuroReportUrl ?? '', siteCfg.neuroReportUrl || 'https://…?address={address}', t('sNeuroHelp')),
    field('s-scan', t('sScan'), localCfg.scanBlocks ?? '', String(siteCfg.scanBlocks), t('sScanHelp', { max: cfg.maxScanBlocks })),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, t('save')), h('button', { type: 'button', class: 'secondary', on: { click: reset } }, t('resetDefaults')),
      h('button', { type: 'button', class: 'secondary', on: { click: test } }, t('testConnection'))),
    msg);
  append(view, [
    h('h1', null, t('settings')),
    card(null, note(t('settingsIntro')), form),
    card(t('effective'), eps ? kv([['EVM JSON-RPC', h('span', { class: 'mono break' }, eps.evm)], ['CometBFT RPC', h('span', { class: 'mono break' }, eps.comet)], ['Cosmos REST', h('span', { class: 'mono break' }, eps.rest)]]) : note(t('placeholderNode'), 'warn'), note(t('cspNote'))),
  ]);

  function collect() {
    const v = (id) => $(id).value.trim();
    const out = {};
    const urls = [['s-node', 'node', false], ['s-evm', 'evmRpc', false], ['s-comet', 'cometRpc', true], ['s-rest', 'rest', true]];
    for (const [id, key, slash] of urls) if (v(id)) out[key] = checkUrl(v(id), { trailingSlash: slash });
    if (v('s-threat')) { if (!/^0x[0-9a-fA-F]{40}$/.test(v('s-threat'))) throw new Error(t('sThreatBad')); out.threatRegistry = v('s-threat'); }
    if (v('s-neuro')) { const u = checkUrl(v('s-neuro').replaceAll('{address}', 'x').replaceAll('{chainId}', '1').split('?')[0]); if (!u) throw new Error('URL'); out.neuroReportUrl = v('s-neuro'); }
    if (v('s-scan')) { const n = Number(v('s-scan')); if (!Number.isInteger(n) || n < 1 || n > cfg.maxScanBlocks) throw new Error(t('sScanBad', { max: cfg.maxScanBlocks })); out.scanBlocks = n; }
    return out;
  }
  function save() {
    try {
      const values = collect();
      saveLocal(store, values);
      localCfg = values;
      setup(sanitizeConfig(siteCfg, values));
      msg.textContent = t('saved');
    } catch (e) { msg.textContent = `${t('error')}: ${safeText(e.message, 200)}`; }
  }
  function reset() {
    saveLocal(store, {});
    localCfg = {};
    setup(siteCfg);
    route();
  }
  async function test() {
    msg.textContent = t('loading');
    try {
      const st = await chain.status();
      msg.textContent = t('connected', { chain: safeText(st.chainId, 60), h: groupDigits(st.height) });
    } catch (e) { msg.textContent = `${t('error')}: ${safeText(e.message, 200)}`; }
  }
}

// ---- routing ----

const ROUTES = { '': pageHome, block: pageBlock, tx: pageTx, address: pageAddress, token: pageToken, validators: pageValidators, settings: pageSettings };

async function route() {
  clearInterval(refreshTimer);
  const [, name = '', param] = /^#\/?([a-z]*)\/?(.*)$/.exec(location.hash) ?? [];
  const page = ROUTES[name] ?? null;
  const view = h('div', { class: 'view' });
  fill(main(), view);
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.getAttribute('href') === `#/${name}`);
  if (!page) { append(view, errorBox(t('notFound'))); return; }
  if (!ready && name !== 'settings') { append(view, h('h1', null, t('title')), note(t('placeholderNode'), 'warn'), routeLink('settings', t('openSettings'))); return; }
  try { await page(view, param); } catch (e) {
    if (view.isConnected) append(view, errorBox(e), note(t('nodeHint')));
  }
  window.scrollTo?.(0, 0);
}

function search(e) {
  e.preventDefault();
  const q = parseQuery($('search').value);
  const go = (r) => { location.hash = `#/${r}`; $('search').value = ''; };
  if (q.type === 'block') go(`block/${q.height}`);
  else if (q.type === 'address') go(`address/${q.address.hex}`);
  else if (q.type === 'valoper') go(`validators/${q.valoper}`);
  else if (q.type === 'hash') go(`tx/${q.evm ? '0x' : ''}${q.hash}`);
  else { $('search').setCustomValidity(t('badSearch')); $('search').reportValidity(); setTimeout(() => $('search').setCustomValidity(''), 2500); }
}

function setup(c) {
  cfg = c;
  ready = !isPlaceholder(cfg);
  api = null; chain = null;
  if (ready) {
    try {
      api = createApi(endpoints(cfg), { maxConcurrent: cfg.maxConcurrent, maxRps: cfg.maxRps });
      chain = chainApi(api);
    } catch { ready = false; }
  }
  validatorCache = { at: 0, rows: null, height: null, promise: null };
  tokenCache.clear();
  banner();
  window.__explorer = { stats: () => ({ ...(api?.stats ?? {}) }), config: () => ({ ...cfg }) }; // for the tests and curious users
}

async function start() {
  fill($('lang'), LANGS.map(([code, label]) => h('option', { value: code, lang: code }, label)));
  applyStatic();
  applyTheme(pref('theme'));
  $('lang').addEventListener('change', (e) => { lang = pickLang(e.target.value); pref('lang', lang); t = makeT(lang); applyStatic(); banner(); route(); });
  $('theme-toggle').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; pref('theme', next); applyTheme(next); });
  $('search-form').addEventListener('submit', search);
  const loaded = await loadConfig({ storage: store });
  siteCfg = loaded.site; localCfg = loaded.local;
  setup(loaded.config);
  window.addEventListener('hashchange', route);
  route();
}

export { T };
start();
