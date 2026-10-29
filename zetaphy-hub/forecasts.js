// Risk forecasts page (forecasts.html; docs/future/markets.md): reads RiskForecasts, ForesightRegistry,
// DetectorPool, DataDAO and RedBlueArena from the ZETAPHY testnet node (addresses from hub-config.json),
// and sends forecast / claim / withdraw from MetaMask. Testnet only. No third-party scripts.
import { pickLang, locale } from './i18n.js';
import { FORECASTS } from './forecasts-i18n.js';

const CHAIN_HEX = '0x12e4e'; // 77390
const DEFAULT_NODE = 'https://rpc.sawasdeecoin.com';
// keccak256 selectors (checked against the contracts' ABIs in test/forecasts.test.mjs)
export const SEL = {
  count: '0x06661abd', questions: '0x31b1b978', states: '0x017a9105', forecast: '0xc7190cd7', claim: '0xddd5e1b2', withdraw: '0x3ccfd60b',
  payoutOf: '0x16df4910', owed: '0xdf18e047', minStake: '0x375b3c0a', eventCount: '0x71be2e4a', brierOf: '0xdcd0439e', skill: '0xa7095c23',
  organismCount: '0x97f330b0', aliveCount: '0x0145a938', organism: '0x1939fce3', round: '0x146ca531', roundEnd: '0xc02e580e', pool: '0x16f0115b',
  submissionCount: '0x6ec02be9', submission: '0x9c8c701b', roundCount: '0x127f0b3f', rounds: '0x8c65c81f', counts: '0xdc715d1b', available: '0x48a0d754',
};
export const STATUS = ['none', 'open', 'proposed', 'disputed', 'final'];
export const ANSWER = ['none', 'no', 'yes', 'void'];
const MAX_ROWS = 50;

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const qs = new URLSearchParams(globalThis.location?.search ?? '');
let lang = pickLang(qs.get('lang') ?? store.get('zetaphy-hub:lang'));
const L = () => ({ ...FORECASTS.en, ...(FORECASTS[lang] ?? {}) });
const T = (k, ...a) => { const v = L()[k]; return typeof v === 'function' ? v(...a) : (v ?? k); };
let NODE = DEFAULT_NODE;
let C = {}; // contract addresses
let account = null;

// ------------------------------------------------------------------ ABI words
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const uintAt = (hex, i = 0) => BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'}`);
export const addrAt = (hex, i = 0) => `0x${hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`;
/** A dynamic string whose offset is in head word i. Printable characters only, at most 200. */
export function strAt(hex, i) {
  const off = Number(uintAt(hex, i)) * 2;
  const len = Number(BigInt(`0x${hex.slice(2 + off, 2 + off + 64) || '0'}`));
  const bytes = hex.slice(2 + off + 64, 2 + off + 64 + Math.min(len, 200) * 2);
  const u8 = Uint8Array.from((bytes.match(/../g) ?? []).map((b) => parseInt(b, 16)));
  return new TextDecoder().decode(u8).replace(/[\u0000-\u001f\u007f]/g, '');
}
export const fmtZeta = (wei, dp = 4) => {
  const s = BigInt(wei); const whole = s / 10n ** 18n; const frac = (s % 10n ** 18n).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};
export function parseZeta(text) {
  const m = /^\s*(\d{1,12})(?:\.(\d{1,18}))?\s*$/.exec(String(text));
  if (!m) return null;
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (t) => (t ? new Date(Number(t) * 1000).toLocaleString(locale(lang)) : '–');
const brier = (x) => (Number(x) / 1e8).toFixed(4);

async function rpc(method, params) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } finally { clearTimeout(t); }
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

// ------------------------------------------------------------------ DOM
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
const status = (text, cls = '') => { const s = document.getElementById('status'); s.textContent = text; s.className = `status ${cls}`; };
const stat = (k, v) => el('div', { class: 'stat' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));
const table = (head, rows) => el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h })))), el('tbody', {}, rows)));
const cmd = (text) => el('div', { class: 'cmd' }, el('pre', { text }));
const notDeployed = (lines) => [el('p', { class: 'muted', text: T('notDeployed') }), cmd(lines)];

// ------------------------------------------------------------------ wallet
async function connect() {
  const eth = window.ethereum;
  if (!eth) throw new Error(T('noWallet'));
  [account] = await eth.request({ method: 'eth_requestAccounts' });
  if ((await eth.request({ method: 'eth_chainId' })).toLowerCase() !== CHAIN_HEX) throw new Error(T('wrongChain'));
  return account;
}
async function send(to, data, value = 0n) {
  const from = account ?? await connect();
  const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value: `0x${value.toString(16)}` }] });
  status(`${T('sent')} ${hash}`, 'good');
  return hash;
}
const guarded = (fn) => async (e) => {
  const b = e?.currentTarget; if (b) b.disabled = true;
  try { await fn(); } catch (err) { status(String(err?.message ?? err).slice(0, 200), 'bad'); } finally { if (b) b.disabled = false; }
};

// ------------------------------------------------------------------ panels
export const encodeForecast = (id, yes) => `${SEL.forecast}${word(id)}${word(yes ? 1 : 0)}`;
export const encodeClaim = (id, who) => `${SEL.claim}${word(id)}${addrWord(who)}`;

async function forecastsPanel(root) {
  root.replaceChildren(el('p', { class: 'intro', text: T('intro_forecasts') }));
  const at = C.riskForecasts;
  if (!at) { root.append(...notDeployed('cd zetaphy-network && npm ci\nnode --test test/forecasts.test.js\nnode scripts/markets.js export --forecasts 0x… --out forecasts.jsonl')); return; }
  const n = Number(uintAt(await call(at, SEL.count)));
  const min = uintAt(await call(at, SEL.minStake));
  root.append(el('div', { class: 'stats' }, stat(T('questions'), String(n)), stat(T('minStake'), fmtZeta(min))));
  const rows = [];
  for (let id = n; id >= 1 && rows.length < MAX_ROWS; id--) {
    const q = await call(at, SEL.questions + word(id));
    const s = await call(at, SEL.states + word(id));
    const kind = Number(uintAt(q, 2)); const bps = Number(uintAt(q, 3));
    const st = STATUS[Number(uintAt(s, 0))] ?? '?'; const ans = ANSWER[Number(uintAt(s, 2))] ?? '?';
    const closeAt = Number(uintAt(q, 5));
    const open = st === 'open' && Date.now() / 1000 < closeAt && uintAt(s, 3) === 0n;
    const amount = el('input', { inputmode: 'decimal', value: fmtZeta(min), 'aria-label': T('amount') });
    const act = el('div', { class: 'act' });
    if (open) {
      const go = (yes) => guarded(async () => { const v = parseZeta(amount.value); if (v == null || v < min) throw new Error(T('badAmount')); await send(at, encodeForecast(id, yes), v); });
      act.append(amount, el('button', { type: 'button', text: T('btnYes'), on: { click: go(true) } }), el('button', { type: 'button', class: 'ghost', text: T('btnNo'), on: { click: go(false) } }));
    } else if (st === 'final') {
      act.append(el('button', { type: 'button', class: 'ghost', text: T('btnClaim'), on: { click: guarded(async () => { const who = account ?? await connect(); await send(at, encodeClaim(id, who)); }) } }));
    }
    rows.push(el('tr', {},
      el('td', { class: 'mono', text: `#${id}` }),
      el('td', { class: 'mono', text: short(addrAt(q, 0)) }),
      el('td', { text: kind === 1 ? T('qFlag') : T('qDrop', bps / 100) }),
      el('td', { text: when(uintAt(q, 6)) }),
      el('td', { text: T(`st_${st}`) + (st === 'final' ? ` · ${T(`ans_${ans}`)}` : '') }),
      el('td', { class: 'mono', text: `${fmtZeta(uintAt(s, 7))} / ${fmtZeta(uintAt(s, 8))}` }),
      el('td', {}, act)));
  }
  root.append(rows.length ? table(['#', T('colToken'), T('colQuestion'), T('colDeadline'), T('colStatus'), T('colYesNo'), ''], rows) : el('p', { class: 'muted', text: T('none') }),
    el('div', { class: 'act' }, el('button', { type: 'button', class: 'ghost', text: T('btnWithdraw'), on: { click: guarded(() => send(at, SEL.withdraw)) } })));
}

async function foresightPanel(root) {
  root.replaceChildren(el('p', { class: 'intro', text: T('intro_foresight') }));
  const at = C.foresight;
  if (!at) { root.append(...notDeployed('cd zetaphy-network && node --test test/forecasts.test.js\nKEYFILE=… node scripts/markets.js commit --foresight 0x… --event 1 --model "my-model" --p 8000 --send\nKEYFILE=… node scripts/markets.js reveal --foresight 0x… --event 1 --model "my-model" --p 8000 --send')); return; }
  root.append(el('div', { class: 'stats' }, stat(T('events'), String(uintAt(await call(at, SEL.eventCount))))));
  const input = el('input', { placeholder: '0x…', 'aria-label': T('modelLookup'), spellcheck: 'false' });
  const out = el('p', { class: 'mono' });
  const look = guarded(async () => {
    const id = input.value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error(T('badModel'));
    const b = await call(at, SEL.brierOf + id.slice(2));
    const s = await call(at, SEL.skill + id.slice(2));
    out.textContent = `${T('forecastsN')}: ${uintAt(b, 0)} · Brier ${brier(uintAt(b, 1))} · ${T('skill')} ${(Number(uintAt(s, 0)) / 100).toFixed(1)}%`;
  });
  root.append(el('label', { text: T('modelLookup') }), el('div', { class: 'lookup' }, input, el('button', { type: 'button', text: T('btnLookup'), on: { click: look } })), out,
    el('p', { class: 'muted', text: T('modelHint') }));
}

async function detectorsPanel(root) {
  root.replaceChildren(el('p', { class: 'intro', text: T('intro_detectors') }));
  const at = C.detectorPool;
  if (!at) { root.append(...notDeployed('cd zetaphy-neuro && npm ci\nnode ml/detectors/mutate.js --rows ml/data/redteam/evasions.jsonl,ml/data/out/corpus.jsonl --round 1\ncd ../zetaphy-network && node --test test/detectorpool.test.js')); return; }
  const n = Number(uintAt(await call(at, SEL.organismCount)));
  root.append(el('div', { class: 'stats' },
    stat(T('alive'), String(uintAt(await call(at, SEL.aliveCount)))), stat(T('organisms'), String(n)),
    stat(T('round'), String(uintAt(await call(at, SEL.round)))), stat(T('roundEnds'), when(uintAt(await call(at, SEL.roundEnd)))),
    stat(T('rewardPool'), fmtZeta(uintAt(await call(at, SEL.pool))))));
  const rows = [];
  for (let id = n; id >= 1 && rows.length < MAX_ROWS; id--) {
    const o = await call(at, SEL.organism + word(id));
    const alive = uintAt(o, 2) === 1n; const last = uintAt(o, 8);
    rows.push(el('tr', {},
      el('td', { class: 'mono', text: `#${id}` }), el('td', { class: 'mono', text: short(addrAt(o, 0)) }),
      el('td', { class: 'mono', text: uintAt(o, 1) ? `#${uintAt(o, 1)}` : '–' }),
      el('td', { class: alive ? 'good' : 'muted', text: alive ? T('alive') : T('retired') }),
      el('td', { class: 'mono', text: fmtZeta(uintAt(o, 3)) }), el('td', { class: 'mono', text: `${uintAt(o, 4)} / ${uintAt(o, 5)}` }),
      el('td', { class: 'mono', text: last ? brier(last) : '–' }), el('td', { class: 'mono', text: strAt(o, 9) })));
  }
  root.append(rows.length ? table(['#', T('colAuthor'), T('colParent'), '', T('colStake'), T('colStrikesWins'), T('colLastBrier'), 'URI'], rows) : el('p', { class: 'muted', text: T('none') }));
}

async function dataPanel(root) {
  root.replaceChildren(el('p', { class: 'intro', text: T('intro_data') }));
  const at = C.dataDao;
  if (!at) { root.append(...notDeployed('cd zetaphy-neuro && node ml/dao/attribute.js --base corpus.jsonl --held held.jsonl --contrib contributions.json --method shapley\ncd ../zetaphy-network && node scripts/markets.js dao-root --report report.json --budget 100 --dao 0x… --round 1')); return; }
  const n = Number(uintAt(await call(at, SEL.submissionCount)));
  const r = Number(uintAt(await call(at, SEL.roundCount)));
  root.append(el('div', { class: 'stats' }, stat(T('submissions'), String(n)), stat(T('rounds'), String(r)), stat(T('available'), fmtZeta(uintAt(await call(at, SEL.available))))));
  const subs = [];
  for (let id = n; id >= 1 && subs.length < MAX_ROWS; id--) {
    const s = await call(at, SEL.submission + word(id));
    subs.push(el('tr', { class: uintAt(s, 3) ? 'muted' : '' }, el('td', { class: 'mono', text: `#${id}` }), el('td', { class: 'mono', text: short(addrAt(s, 0)) }),
      el('td', { class: 'mono', text: String(uintAt(s, 2)) }), el('td', { text: strAt(s, 6) }), el('td', { class: 'mono', text: strAt(s, 5) })));
  }
  if (subs.length) root.append(el('h2', { text: T('submissions') }), table(['#', T('colContributor'), T('colRows'), T('colLicense'), 'URI'], subs));
  const rounds = [];
  for (let id = r; id >= 1 && rounds.length < MAX_ROWS; id--) {
    const x = await call(at, SEL.rounds + word(id));
    rounds.push(el('tr', {}, el('td', { class: 'mono', text: `#${id}` }), el('td', { class: 'mono', text: `${fmtZeta(uintAt(x, 2))} / ${fmtZeta(uintAt(x, 1))}` }),
      el('td', { text: when(uintAt(x, 4)) }), el('td', { class: uintAt(x, 6) ? 'bad' : '', text: uintAt(x, 6) ? T('vetoed') : '' }), el('td', { class: 'mono', text: strAt(x, 8) })));
  }
  if (rounds.length) root.append(el('h2', { text: T('rounds') }), table(['#', T('colClaimed'), T('colClaimsOpen'), '', T('colReport')], rounds));
  if (!subs.length && !rounds.length) root.append(el('p', { class: 'muted', text: T('none') }));
}

async function arenaPanel(root) {
  root.replaceChildren(el('p', { class: 'intro', text: T('intro_arena') }));
  const at = C.arena;
  if (!at) { root.append(...notDeployed('cd zetaphy-neuro && node --test ml/test/arena.test.js\nnode ml/redteam/arena.js --round round.json\ncd ../zetaphy-network && node --test test/arena.test.js')); return; }
  const n = Number(uintAt(await call(at, SEL.roundCount)));
  const rows = [];
  for (let id = n; id >= 1 && rows.length < MAX_ROWS; id--) {
    const x = await call(at, SEL.rounds + word(id));
    const c = await call(at, SEL.counts + word(id));
    const pop = (v) => v.toString(2).split('').filter((b) => b === '1').length;
    rows.push(el('tr', {}, el('td', { class: 'mono', text: `#${id}` }), el('td', { text: when(uintAt(x, 0)) }), el('td', { text: when(uintAt(x, 2)) }),
      el('td', { class: 'mono', text: `${uintAt(c, 0)} / ${uintAt(c, 1)}` }), el('td', { class: 'mono', text: `${fmtZeta(uintAt(x, 5))} / ${fmtZeta(uintAt(x, 6))}` }),
      el('td', { text: uintAt(x, 3) ? T('judgedN', pop(uintAt(x, 7)), pop(uintAt(x, 8))) : '–' })));
  }
  root.append(el('div', { class: 'stats' }, stat(T('rounds'), String(n))),
    rows.length ? table(['#', T('colCommitEnd'), T('colJudgeEnd'), T('colEntries'), T('colPools'), T('colResult')], rows) : el('p', { class: 'muted', text: T('none') }));
}

const PANELS = { forecasts: forecastsPanel, foresight: foresightPanel, detectors: detectorsPanel, data: dataPanel, arena: arenaPanel };
const TABS = Object.keys(PANELS);

async function open(tab, { focus = false } = {}) {
  if (!PANELS[tab]) tab = 'forecasts';
  for (const t of TABS) {
    const b = document.getElementById(`t-${t}`); const p = document.getElementById(`p-${t}`);
    b.setAttribute('aria-selected', String(t === tab)); b.tabIndex = t === tab ? 0 : -1; p.hidden = t !== tab;
  }
  if (focus) document.getElementById(`t-${tab}`).focus();
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  const root = document.getElementById(`p-${tab}`);
  root.replaceChildren(el('p', { class: 'muted', text: T('loading') }));
  status('');
  try { await PANELS[tab](root); } catch (e) { root.append(el('p', { class: 'bad', text: `${T('failed')} ${String(e?.message ?? e).slice(0, 160)}` })); }
}

function texts() {
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll('[data-t]')) n.textContent = T(n.dataset.t);
  document.getElementById('lang').value = lang;
}

async function main() {
  try {
    const r = await fetch('./hub-config.json', { cache: 'no-store', credentials: 'omit' });
    const cfg = await r.json();
    if (/^https:\/\/[^/]+$/.test(cfg.node ?? '')) NODE = cfg.node;
    const ok = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
    C = Object.fromEntries(['riskForecasts', 'foresight', 'detectorPool', 'dataDao', 'arena'].filter((k) => ok(cfg.contracts?.[k])).map((k) => [k, cfg.contracts[k]]));
  } catch { /* defaults: nothing deployed */ }
  texts();
  document.getElementById('lang').addEventListener('change', (e) => { lang = pickLang(e.target.value); store.set('zetaphy-hub:lang', lang); texts(); open(location.hash.slice(1)); });
  const tabs = document.getElementById('ftabs');
  tabs.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) open(b.dataset.tab); });
  tabs.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(document.activeElement?.dataset?.tab);
    if (i < 0 || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    open(TABS[j], { focus: true });
  });
  window.addEventListener('hashchange', () => open(location.hash.slice(1)));
  await open(location.hash.slice(1));
}

if (typeof document !== 'undefined' && document.getElementById('ftabs')) main();
