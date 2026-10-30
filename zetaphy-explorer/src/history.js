// Full address history without an indexer. CometBFT's own tx index (tx_search)
// answers event queries over ALL heights, so the address page asks it directly:
//   message.sender='<bech32>'        Cosmos messages the address signed
//   message.sender='<0x EIP-55>'     EVM txs it sent (Cosmos EVM puts the 0x sender there)
//   transfer.sender='<bech32>'       coins it sent (fees included)
//   transfer.recipient='<bech32>'    coins it received
//   ethereum_tx.recipient='<0x>'     EVM txs sent to it
// Each query is read newest first (order_by desc, 100 per page) and the pages are
// merged in order and deduplicated (one tx often matches several queries). If the
// node refuses event queries, the old scan of the last N blocks is used instead and
// the page says so. Token transfers come from eth_getLogs (Transfer with the
// address in topic 1 or 2, ERC-1155 TransferSingle / TransferBatch), read
// backwards in 500-block windows (the public node's limit). Filters and CSV export
// work on what is loaded; the CSV is made here and saved with a Blob (no server).
import { h, fill, append } from './dom.js';
import { toAddress, anyAddressLower, safeText, formatUnits, formatZtphy, groupDigits, fromBase64, DECIMALS } from './format.js';
import { decodeTx } from './cosmos.js';
import { decodeTransfer, TOPICS } from './evm.js';
import { TTL } from './rpc.js';

export const PER_PAGE = 100;
export const SHOW_STEP = 25;
export const LOG_WINDOW = 500;
export const KINDS = ['transfer', 'staking', 'evm', 'ibc', 'governance', 'other'];

const BECH32 = /^zetaphy1[02-9ac-hj-np-z]{38}$/;
const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const EVENT_KEY = /^[a-z][a-z0-9_]{0,40}\.[A-Za-z][A-Za-z0-9_]{0,40}$/;

/**
 * One tx_search condition `key='value'`. Only a fixed-shape event key and a
 * validated address (canonical bech32 with a good checksum, or EIP-55 0x) are
 * accepted, so nothing a user types can change the query (no quotes, AND, OR…).
 */
export function eventQuery(key, value) {
  const k = String(key ?? ''); const v = String(value ?? '');
  if (!EVENT_KEY.test(k)) throw new Error('refused: bad event key');
  if (!BECH32.test(v) && !HEX40.test(v)) throw new Error('refused: not an address');
  const a = toAddress(v);
  if (!a || (v !== a.bech32 && v !== a.hex)) throw new Error('refused: not a canonical address');
  return `${k}='${v}'`;
}

/** The tx_search queries for an address (0x… or zetaphy1…): [{ id, query, dir }]. Throws on anything else. */
export function addressQueries(input) {
  const a = toAddress(input);
  if (!a) throw new Error('refused: not an address');
  return [
    { id: 'sender', query: eventQuery('message.sender', a.bech32), dir: 'out' },
    { id: 'evmSender', query: eventQuery('message.sender', a.hex), dir: 'out' },
    { id: 'transferSender', query: eventQuery('transfer.sender', a.bech32), dir: 'out' },
    { id: 'recipient', query: eventQuery('transfer.recipient', a.bech32), dir: 'in' },
    { id: 'evmRecipient', query: eventQuery('ethereum_tx.recipient', a.hex), dir: 'in' },
  ];
}

const keyOf = (tx) => ({ h: Number(tx?.height ?? 0), i: Number(tx?.index ?? 0) });
const cmpKey = (a, b) => (a.h - b.h) || (a.i - b.i);

/**
 * Merges several newest-first paginated streams into one newest-first list without
 * gaps: a tx is shown only once no stream can still hold a newer one (every open
 * stream has already been read below it). Duplicates are shown once.
 *   sources: [{ id, … }]; fetchPage(source, page, perPage) -> { txs, total_count }
 */
export class HistoryMerger {
  constructor(sources, fetchPage, { perPage = PER_PAGE, maxPages = 1000 } = {}) {
    this.fetchPage = fetchPage; this.perPage = perPage; this.maxPages = maxPages;
    this.src = sources.map((s) => ({ ...s, page: 0, got: 0, total: 0, done: false, last: null, error: null }));
    this.buf = new Map(); // hash -> { tx, key, sources } not shown yet
    this.shown = new Map(); // hash -> entry already handed out
  }

  /** Total count: exact once everything is read; otherwise a range (largest single query … sum of all). */
  get total() {
    const ok = this.src.filter((s) => !s.error);
    if (this.done) return { exact: this.shown.size, min: this.shown.size, max: this.shown.size };
    return { exact: null, min: Math.max(this.shown.size, ...ok.map((s) => s.total), 0), max: ok.reduce((n, s) => n + s.total, 0) };
  }
  get done() { return this.src.every((s) => s.done) && !this.buf.size; }
  get failed() { return this.src.length > 0 && this.src.every((s) => s.error); }
  get errors() { return this.src.filter((s) => s.error).map((s) => ({ id: s.id, message: String(s.error?.message ?? s.error) })); }

  async fetchNext(s) {
    const page = s.page + 1;
    let r;
    try { r = await this.fetchPage(s, page, this.perPage); } catch (e) { s.error = e; s.done = true; return; }
    s.page = page;
    const txs = Array.isArray(r?.txs) ? r.txs : [];
    s.total = Math.max(0, Number(r?.total_count ?? 0) || 0);
    s.got += txs.length;
    for (const tx of txs) {
      const hash = String(tx?.hash ?? '').toUpperCase();
      if (!/^[0-9A-F]{64}$/.test(hash) || !/^\d{1,19}$/.test(String(tx?.height ?? ''))) continue;
      const key = keyOf(tx);
      if (!s.last || cmpKey(key, s.last) < 0) s.last = key;
      const seen = this.shown.get(hash) ?? this.buf.get(hash);
      if (seen) { seen.sources.add(s.id); continue; }
      this.buf.set(hash, { hash, tx, key, sources: new Set([s.id]) });
    }
    if (!txs.length || !s.last || s.got >= s.total || page >= this.maxPages) s.done = true;
  }

  /** Moves txs that are safe to show (newest first) out of the buffer, at most `want`. */
  drain(out, want) {
    const open = this.src.filter((s) => !s.done);
    if (open.some((s) => !s.last)) return;
    const frontier = open.length ? open.map((s) => s.last).reduce((a, b) => (cmpKey(a, b) >= 0 ? a : b)) : null;
    const ready = [...this.buf.values()].sort((a, b) => cmpKey(b.key, a.key));
    for (const e of ready) {
      if (out.length >= want) break;
      if (frontier && cmpKey(e.key, frontier) < 0) break;
      this.buf.delete(e.hash); this.shown.set(e.hash, e); out.push(e);
    }
  }

  /** The next `want` txs (newest first): [{ hash, tx, sources }]. Fetches only the pages it needs. */
  async loadMore(want = SHOW_STEP) {
    const out = [];
    await Promise.all(this.src.filter((s) => !s.page && !s.done).map((s) => this.fetchNext(s)));
    for (;;) {
      this.drain(out, want);
      if (out.length >= want) break;
      const open = this.src.filter((s) => !s.done);
      if (!open.length) { this.drain(out, want); break; }
      // the stream holding the others back: the open one read least far down
      const s = open.reduce((a, b) => (cmpKey(a.last, b.last) >= 0 ? a : b));
      await this.fetchNext(s);
    }
    return out;
  }
}

// ---- kinds and directions ----

/** A tx's kind from its messages' type URLs: transfer, staking, evm, ibc, governance or other. */
export function kindOf(typeUrls) {
  const one = (u) => {
    const s = String(u ?? '');
    if (s === '/cosmos.evm.vm.v1.MsgEthereumTx' || s === '/zetaphy.pq.v1.MsgEVMCall') return 'evm';
    if (s.startsWith('/ibc.')) return 'ibc';
    if (s.startsWith('/cosmos.bank.')) return 'transfer';
    if (/^\/cosmos\.(staking|distribution|slashing)\./.test(s)) return 'staking';
    if (s.startsWith('/cosmos.gov.')) return 'governance';
    return 'other';
  };
  const kinds = (typeUrls ?? []).map(one);
  if (kinds.includes('ibc')) return 'ibc';
  return kinds.find((k) => k !== 'other') ?? 'other';
}

/** 'out', 'in', 'self' or 'other' for the address (lower-case 0x), from the tx summary and the queries that found it. */
export function directionOf(summary, addrLower, sources) {
  const from = anyAddressLower(summary?.from); const to = anyAddressLower(summary?.to);
  if (from === addrLower && to === addrLower) return 'self';
  if (from === addrLower) return 'out';
  if (to === addrLower) return 'in';
  const s = sources ? [...sources] : [];
  if (s.some((x) => x === 'sender' || x === 'evmSender')) return 'out';
  if (s.some((x) => x === 'recipient' || x === 'evmRecipient')) return 'in';
  if (s.includes('transferSender')) return 'out';
  return 'other';
}

/** A token transfer's direction for the address. */
export function transferDirection(tr, addrLower) {
  const f = String(tr?.from ?? '').toLowerCase(); const t = String(tr?.to ?? '').toLowerCase();
  if (f === addrLower && t === addrLower) return 'self';
  return f === addrLower ? 'out' : t === addrLower ? 'in' : 'other';
}

/** Filter: dir 'all' | 'in' | 'out' ('self' counts as both), kind 'all' | one of KINDS. */
export function matchesFilter(row, { dir = 'all', kind = 'all' } = {}) {
  if (dir !== 'all' && row.dir !== dir && row.dir !== 'self') return false;
  if (kind !== 'all' && row.kind !== kind) return false;
  return true;
}

// ---- CSV (made in the browser, saved with a Blob) ----

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting with
 * = + - @, tab or carriage return) gets a leading apostrophe; quotes, commas and
 * line breaks are quoted.
 */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export const HISTORY_CSV_HEADER = ['tx_hash', 'cometbft_hash', 'height', 'index', 'kind', 'direction', 'type', 'from', 'to', 'value_ZETAPHY', 'status', 'code'];
export const historyCsvRow = (r) => [r.hash, r.cometHash, r.height, r.index, r.kind, r.dir, safeText(r.label, 120), r.from, r.to,
  r.value != null ? formatUnits(r.value, DECIMALS, { maxFrac: 18, group: false }) : '', r.ok ? 'success' : 'failed', r.code];

export const TOKEN_CSV_HEADER = ['tx_hash', 'block', 'log_index', 'standard', 'token', 'direction', 'from', 'to', 'amount_or_token_id'];
export function tokenCsvRow(r) {
  const tr = r.tr;
  const amount = tr.standard === 'erc20' ? tr.amount.toString() : tr.standard === 'erc721' ? `#${tr.tokenId}` : tr.ids.map((id, i) => `#${id}x${tr.amounts[i]}`).join(' ');
  return [r.txHash, r.block, r.logIndex, tr.standard, tr.token, r.dir, tr.from, tr.to, amount];
}

/** Saves text as a file (Blob + object URL; nothing is uploaded). */
export function download(name, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- token transfers: eth_getLogs backwards in windows ----

/**
 * Reads logs backwards from `latest` in windows of `window` blocks.
 * fetchLogs(from, to) -> logs. loadMore stops after `minItems` new transfers or `maxWindows` windows.
 */
export class LogScanner {
  constructor(fetchLogs, latest, { window = LOG_WINDOW } = {}) {
    this.fetchLogs = fetchLogs; this.window = window;
    this.top = Number(latest); this.next = Number(latest); this.seen = new Set();
  }
  get done() { return this.next < 1; }
  /** Lowest block read so far (top + 1 before the first read). */
  get from() { return this.next + 1; }
  async loadMore({ minItems = 10, maxWindows = 8 } = {}) {
    const out = [];
    for (let w = 0; w < maxWindows && !this.done && out.length < minItems; w++) {
      const to = this.next; const from = Math.max(1, to - this.window + 1);
      const logs = await this.fetchLogs(from, to);
      this.next = from - 1;
      const sorted = [...(Array.isArray(logs) ? logs : [])].sort((a, b) => Number(BigInt(b.blockNumber ?? 0) - BigInt(a.blockNumber ?? 0)) || Number(BigInt(b.logIndex ?? 0) - BigInt(a.logIndex ?? 0)));
      for (const l of sorted) {
        const k = `${l.transactionHash}:${l.logIndex}`;
        if (this.seen.has(k)) continue;
        this.seen.add(k);
        const tr = decodeTransfer(l);
        if (!tr) continue;
        let block = '';
        try { block = BigInt(l.blockNumber).toString(); } catch { block = ''; }
        let logIndex = '';
        try { logIndex = BigInt(l.logIndex).toString(); } catch { logIndex = ''; }
        out.push({ tr, txHash: /^0x[0-9a-fA-F]{64}$/.test(String(l.transactionHash)) ? String(l.transactionHash) : '', block, logIndex });
      }
    }
    return out;
  }
}

// ---- the address page card ----

/** Rows of a tx_search result: the decoded summary plus kind and direction. */
function toRow(chain, e, addrLower) {
  const s = chain.summarize({ ...e.tx, hash: e.hash });
  let typeUrls = [];
  try { typeUrls = decodeTx(fromBase64(e.tx.tx)).messages.map((m) => m.typeUrl); } catch { typeUrls = []; }
  return { ...s, kind: kindOf(typeUrls), dir: directionOf(s, addrLower, e.sources) };
}

function select(id, label, options, value, onChange) {
  const sel = h('select', { id, class: 'filter-select', on: { change: (e) => onChange(e.target.value) } },
    options.map(([v, text]) => h('option', { value: v }, text)));
  sel.value = value;
  return h('label', { class: 'filter', for: id }, h('span', null, label), sel);
}

/**
 * The address history card: tabs "Transactions" (tx_search, or the block scan
 * fallback) and "Token transfers" (eth_getLogs windows). ctx: the app's helpers.
 */
export function addressHistory(ctx, a, latest) {
  const { t } = ctx;
  const tabs = [['txs', t('histTabTxs')], ['tokens', t('histTabTokens')]];
  const panels = { txs: h('div', { id: 'hist-panel-txs', role: 'tabpanel', 'aria-labelledby': 'hist-tab-txs' }), tokens: h('div', { id: 'hist-panel-tokens', role: 'tabpanel', 'aria-labelledby': 'hist-tab-tokens', hidden: '' }) };
  const started = {};
  const buttons = tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', id: `hist-tab-${id}`, class: 'tab', 'aria-controls': `hist-panel-${id}`, 'aria-selected': id === 'txs' ? 'true' : 'false', on: { click: () => show(id) } }, label));
  function show(id) {
    for (const b of buttons) b.setAttribute('aria-selected', String(b.id === `hist-tab-${id}`));
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== id;
    if (!started[id]) { started[id] = true; (id === 'txs' ? txPanel : tokenPanel)(ctx, a, latest, panels[id]); }
  }
  const box = ctx.card(t('histTitle'), h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('histTitle') }, buttons), panels.txs, panels.tokens);
  show('txs');
  return box;
}

function txPanel(ctx, a, latest, panel) {
  const { t, chain, api } = ctx;
  const state = { rows: [], dir: 'all', kind: 'all', mode: 'tx_search', merger: null, loading: false, scan: null };
  const head = h('div', { class: 'hist-head' }, ctx.loading());
  const filters = h('div', { class: 'filters' },
    select('hist-dir', t('histDir'), [['all', t('histAll')], ['in', t('histIn')], ['out', t('histOut')]], 'all', (v) => { state.dir = v; render(); }),
    select('hist-kind', t('histKind'), [['all', t('histAll')], ...KINDS.map((k) => [k, t(`kind_${k}`)])], 'all', (v) => { state.kind = v; render(); }));
  const list = h('div', { class: 'hist-list' });
  const more = h('button', { type: 'button', class: 'secondary', id: 'hist-more', on: { click: () => loadMore() } }, t('histLoadMore'));
  const csv = h('button', { type: 'button', class: 'secondary', id: 'hist-csv', on: { click: () => {
    download(`zetaphy-${a.hex}-transactions.csv`, toCsv(HISTORY_CSV_HEADER, state.rows.filter((r) => matchesFilter(r, state)).map(historyCsvRow)));
  } } }, t('histCsv'));
  const foot = h('div', { class: 'row' }, more, csv);
  const status = h('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  append(panel, head, filters, list, status, foot);

  const dirBadge = (d) => ctx.badge(t(`dir_${d}`), d === 'in' ? 'ok' : d === 'out' ? 'warn' : '');
  function render() {
    const shown = state.rows.filter((r) => matchesFilter(r, state));
    fill(list, shown.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, [t('txHash'), t('histKind'), t('block'), t('histDir'), t('fromTo'), t('value'), t('status')].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, shown.map((x) => {
        const cells = [
          ctx.hashLink(x.hash),
          h('span', { class: 'txtype' }, ctx.badge(t(`kind_${x.kind}`), x.kind === 'evm' ? 'evm' : 'cosmos'), h('span', { class: 'small label' }, safeText(x.label, 48))),
          ctx.blockLink(x.height),
          dirBadge(x.dir),
          h('span', { class: 'fromto' }, x.from ? ctx.anyLink(x.from) : '—', ' → ', x.to ? ctx.anyLink(x.to) : '—'),
          x.value != null ? formatZtphy(x.value, { maxFrac: 4 }) : '—',
          ctx.statusBadge(x.ok),
        ];
        const heads = [t('txHash'), t('histKind'), t('block'), t('histDir'), t('fromTo'), t('value'), t('status')];
        return h('tr', { data: { hash: x.cometHash } }, cells.map((c, i) => h('td', { 'data-label': heads[i] }, c)));
      })))) : ctx.note(state.rows.length ? t('histNoMatch') : state.mode === 'scan' ? t('noTxsForAddress') : t('histNone')));
    const tot = state.merger?.total;
    const total = state.mode === 'scan' ? t('histLoaded', { n: groupDigits(state.rows.length) })
      : tot.exact != null ? t('histTotal', { n: groupDigits(tot.exact) })
        : tot.min === tot.max ? t('histTotal', { n: groupDigits(tot.min) }) : t('histTotalRange', { min: groupDigits(tot.min), max: groupDigits(tot.max) });
    fill(head,
      h('p', { class: 'hist-mode' }, state.mode === 'scan' ? ctx.badge(t('histModeScan'), 'warn') : ctx.badge(t('histModeIndex'), 'ok'), ' ', h('strong', { id: 'hist-total' }, total)),
      state.mode === 'scan' ? ctx.note(t('histScanNote', { n: groupDigits(Number(state.scan.to) - Number(state.scan.from) + 1), from: groupDigits(state.scan.from), to: groupDigits(state.scan.to), e: safeText(state.scanReason, 160) }), 'warn')
        : ctx.note(t('histIndexNote'), 'info'),
      state.merger?.errors.length && state.mode !== 'scan' ? ctx.note(t('histPartial', { n: state.merger.errors.length }), 'warn') : null);
    status.textContent = t('histShowing', { n: groupDigits(shown.length), m: groupDigits(state.rows.length) });
    more.hidden = state.mode === 'scan' || !state.merger || state.merger.done;
    more.disabled = state.loading;
    csv.disabled = !state.rows.length;
  }

  const fetchPage = (s, page, per) => api.comet('tx_search', { query: s.query, prove: false, page: String(page), per_page: String(per), order_by: 'desc' }, TTL.short);

  async function fallback(reason) {
    state.mode = 'scan'; state.scanReason = reason;
    const r = await chain.recentTxs(latest, ctx.cfg.scanBlocks);
    state.scan = r;
    state.rows = r.txs.filter((x) => x.addresses.has(a.lower) || anyAddressLower(x.from) === a.lower || anyAddressLower(x.to) === a.lower)
      .map((x) => {
        let kind = 'other';
        if (x.evm) kind = 'evm';
        else if (/MsgSend|MsgMultiSend/.test(x.label)) kind = 'transfer';
        else if (/Delegat|Redelegat|Withdraw|Unjail|Validator/.test(x.label)) kind = 'staking';
        else if (/MsgVote|MsgDeposit|MsgSubmitProposal/.test(x.label)) kind = 'governance';
        else if (/MsgTransfer|MsgRecvPacket|MsgAcknowledgement/.test(x.label)) kind = 'ibc';
        return { ...x, kind, dir: directionOf(x, a.lower) };
      });
  }

  async function loadMore() {
    if (state.loading) return;
    state.loading = true; more.disabled = true; more.textContent = t('loading');
    try {
      if (!state.merger) {
        state.merger = new HistoryMerger(addressQueries(a.hex), fetchPage);
        const first = await state.merger.loadMore(SHOW_STEP);
        if (state.merger.failed) await fallback(state.merger.errors[0]?.message ?? '');
        else state.rows.push(...first.map((e) => toRow(chain, e, a.lower)));
      } else {
        const next = await state.merger.loadMore(SHOW_STEP);
        state.rows.push(...next.map((e) => toRow(chain, e, a.lower)));
      }
    } catch (e) {
      fill(status, ctx.errorBox(e));
      state.loading = false; more.textContent = t('histLoadMore'); more.disabled = false;
      return;
    }
    state.loading = false; more.textContent = t('histLoadMore');
    render();
  }
  loadMore();
}

function tokenPanel(ctx, a, latest, panel) {
  const { t, chain } = ctx;
  const scanner = new LogScanner((from, to) => chain.transferLogs(a.lower, from, to, TOPICS), latest);
  const state = { rows: [], dir: 'all', loading: false };
  const filters = h('div', { class: 'filters' },
    select('tok-dir', t('histDir'), [['all', t('histAll')], ['in', t('histIn')], ['out', t('histOut')]], 'all', (v) => { state.dir = v; render(); }));
  const list = h('div', { class: 'hist-list' });
  const range = h('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const more = h('button', { type: 'button', class: 'secondary', id: 'tok-more', on: { click: () => loadMore() } }, t('tokLoadMore'));
  const csv = h('button', { type: 'button', class: 'secondary', id: 'tok-csv', on: { click: () => {
    download(`zetaphy-${a.hex}-token-transfers.csv`, toCsv(TOKEN_CSV_HEADER, state.rows.filter((r) => matchesFilter(r, state)).map(tokenCsvRow)));
  } } }, t('histCsv'));
  append(panel, filters, list, range, h('div', { class: 'row' }, more, csv), ctx.note(t('tokScanNote', { w: LOG_WINDOW }), 'info'));

  function render() {
    const shown = state.rows.filter((r) => matchesFilter(r, state));
    const heads = [t('block'), t('txHash'), t('histDir'), t('histTransfer')];
    fill(list, shown.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, heads.map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, shown.map((r) => h('tr', null, [
        r.block ? ctx.blockLink(r.block) : '—', r.txHash ? ctx.hashLink(r.txHash) : '—',
        ctx.badge(t(`dir_${r.dir}`), r.dir === 'in' ? 'ok' : r.dir === 'out' ? 'warn' : ''), ctx.transferView(r.tr),
      ].map((c, i) => h('td', { 'data-label': heads[i] }, c))))))) : ctx.note(t('noTransfers')));
    range.textContent = scanner.done ? t('tokAllScanned', { n: groupDigits(state.rows.length) })
      : t('tokScanned', { from: groupDigits(scanner.from), to: groupDigits(scanner.top), n: groupDigits(state.rows.length) });
    more.hidden = scanner.done; more.disabled = state.loading; csv.disabled = !state.rows.length;
  }
  async function loadMore() {
    if (state.loading) return;
    state.loading = true; more.disabled = true; more.textContent = t('loading');
    try {
      const got = await scanner.loadMore();
      state.rows.push(...got.map((r) => ({ ...r, dir: transferDirection(r.tr, a.lower) })));
    } catch (e) { append(list, ctx.errorBox(e)); }
    state.loading = false; more.textContent = t('tokLoadMore');
    render();
  }
  render();
  loadMore();
}
