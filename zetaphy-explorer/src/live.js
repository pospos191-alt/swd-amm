// Live view: new blocks as they are made, the node's pending transactions, and
// "watch this tx". New blocks come from a websocket when one is allowed:
//   1. CometBFT  wss://<node>/rpc/websocket   subscribe tm.event='NewBlock' (the block's txs come with it)
//   2. EVM       wss://<node>/ws              eth_subscribe newHeads (open on the public node)
//   3. polling   `status` every 6 s (only while the tab is visible)
// A socket is only opened to the host the site's CSP allows (config.json's node,
// whose wss:// origin is in vercel.json connect-src); a node set on the Settings
// page uses polling. Parsing is pure and unit-tested.
import { h, fill, append } from './dom.js';
import { safeText, groupDigits, short, ago, formatZtphy, fromBase64 } from './format.js';
import { cometTxHash, decodeTx } from './cosmos.js';
import { txHashParam } from './watch.js';

export const POLL_MS = 6000;
const clip = (s, n = 200) => String(s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, n);
const HEIGHT = /^\d{1,19}$/;

/** The websocket URLs of the node's endpoints: { comet, evm }. */
export function wsEndpoints(eps) {
  const toWs = (u) => String(u).replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  const comet = toWs(eps.comet.endsWith('/') ? eps.comet : eps.comet + '/') + 'websocket';
  const evm = toWs(new URL(eps.evm).origin) + '/ws';
  return { comet, evm };
}

/** The host whose wss:// the CSP allows (config.json's node), or '' when there is none. */
export function socketHost(siteCfg) {
  try {
    const u = new URL(String(siteCfg?.node ?? ''));
    return u.protocol === 'https:' && !/[<>]/.test(u.href) ? u.host : (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) ? u.host : '');
  } catch { return ''; }
}

export const cometSubscribe = (id = 1) => JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id, params: { query: "tm.event='NewBlock'" } });
export const evmSubscribe = (id = 1) => JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscribe', id, params: ['newHeads'] });

const parse = (raw) => {
  if (typeof raw !== 'string' || raw.length > 8_000_000) return null;
  try { const m = JSON.parse(raw); return m && typeof m === 'object' && !Array.isArray(m) ? m : null; } catch { return null; }
};

/**
 * A CometBFT websocket message:
 *   { kind: 'ack' } | { kind: 'block', height, time, proposer, txs: [base64] } | { kind: 'error', message } | null (anything else).
 */
export function parseCometWs(raw) {
  const m = parse(raw);
  if (!m) return null;
  if (m.error) return { kind: 'error', message: clip(m.error.data || m.error.message) };
  const r = m.result;
  if (!r || typeof r !== 'object') return null;
  if (!r.data && !r.query && Object.keys(r).length === 0) return { kind: 'ack' };
  const d = r.data;
  if (d?.type !== 'tendermint/event/NewBlock') return null;
  const b = d.value?.block; const hd = b?.header;
  const height = String(hd?.height ?? '');
  if (!HEIGHT.test(height)) return null;
  const txs = Array.isArray(b?.data?.txs) ? b.data.txs.filter((x) => typeof x === 'string' && /^[A-Za-z0-9+/=]*$/.test(x)).slice(0, 10000) : [];
  const time = String(hd.time ?? '');
  return { kind: 'block', height, time: Number.isFinite(Date.parse(time)) ? time : '', proposer: /^[0-9A-Fa-f]{40}$/.test(String(hd.proposer_address)) ? String(hd.proposer_address).toUpperCase() : '', txs };
}

const bigOrNull = (v) => { try { return v == null ? null : BigInt(v); } catch { return null; } };

/**
 * An EVM websocket message (eth_subscribe newHeads):
 *   { kind: 'ack', id } | { kind: 'block', height, time, baseFee, gasUsed, gasLimit } | { kind: 'error', message } | null.
 */
export function parseEvmWs(raw) {
  const m = parse(raw);
  if (!m) return null;
  if (m.error) return { kind: 'error', message: clip(m.error.message) };
  if (typeof m.result === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(m.result)) return { kind: 'ack', id: m.result };
  if (m.method !== 'eth_subscription') return null;
  const r = m.params?.result;
  const n = bigOrNull(r?.number);
  if (n == null || n < 0n) return null;
  const ts = bigOrNull(r?.timestamp);
  return {
    kind: 'block', height: n.toString(), time: ts != null && ts < 10n ** 12n ? new Date(Number(ts) * 1000).toISOString() : '',
    baseFee: bigOrNull(r?.baseFeePerGas), gasUsed: bigOrNull(r?.gasUsed), gasLimit: bigOrNull(r?.gasLimit), txs: null,
  };
}

/**
 * New blocks, by websocket when possible, else by polling. Listeners get
 * { height, time, txs (base64, CometBFT socket only) | null, source }; heights only go up.
 *   new LiveFeed({ endpoints, host, poll: async () => ({ height, time }) })
 */
export class LiveFeed {
  constructor({ endpoints, host = '', poll, WebSocketImpl = globalThis.WebSocket, interval = POLL_MS, openTimeoutMs = 8000, order = ['comet', 'evm'], hidden = () => globalThis.document?.hidden ?? false } = {}) {
    this.urls = endpoints ? wsEndpoints(endpoints) : {};
    this.host = host; this.poll = poll; this.WS = WebSocketImpl; this.interval = interval; this.openTimeoutMs = openTimeoutMs;
    this.order = order; this.hidden = hidden;
    this.listeners = new Set(); this.modeListeners = new Set();
    this.mode = 'off'; this.last = 0n; this.ws = null; this.timer = null; this.slow = null; this.retries = 0; this.stopped = true;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onMode(fn) { this.modeListeners.add(fn); fn(this.mode); return () => this.modeListeners.delete(fn); }
  setMode(m) { if (this.mode === m) return; this.mode = m; for (const f of this.modeListeners) { try { f(m); } catch { /* a view went away */ } } }

  emit(b) {
    if (!b || !HEIGHT.test(String(b.height))) return;
    const hgt = BigInt(b.height);
    if (hgt <= this.last) return;
    const prev = this.last; this.last = hgt;
    for (const f of this.listeners) { try { f({ ...b, height: hgt.toString(), previous: prev ? prev.toString() : null }); } catch { /* listener error */ } }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.tryNext(0);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer); clearInterval(this.slow); this.timer = null; this.slow = null;
    if (this.ws) { try { this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } catch { /* closed */ } }
    this.ws = null;
    this.setMode('off');
  }

  allowed(url) {
    try { return !!this.host && new URL(url).host === this.host; } catch { return false; }
  }

  tryNext(i) {
    if (this.stopped) return;
    const kind = this.order[i];
    if (!kind) { this.startPolling(); return; }
    const url = this.urls[kind];
    if (!this.WS || !url || !this.allowed(url)) { this.tryNext(i + 1); return; }
    this.setMode('connecting');
    let ws; let established = false; let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true; clearTimeout(timeout);
      if (this.ws === ws) this.ws = null;
      try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(); } catch { /* closed */ }
      if (this.stopped) return;
      if (established && this.retries < 3) { this.retries++; setTimeout(() => this.tryNext(i), 3000 * this.retries); return; }
      this.tryNext(i + 1);
    };
    try { ws = new this.WS(url); } catch { this.tryNext(i + 1); return; }
    this.ws = ws;
    const timeout = setTimeout(() => { if (!established) fail(); }, this.openTimeoutMs);
    ws.onopen = () => { try { ws.send(kind === 'comet' ? cometSubscribe(1) : evmSubscribe(1)); } catch { fail(); } };
    ws.onerror = () => fail();
    ws.onclose = () => fail();
    ws.onmessage = (ev) => {
      const m = kind === 'comet' ? parseCometWs(ev.data) : parseEvmWs(ev.data);
      if (!m) return;
      if (m.kind === 'error') { if (!established) fail(); return; }
      if (m.kind === 'ack') {
        established = true; this.retries = 0; clearTimeout(timeout);
        this.setMode(kind === 'comet' ? 'comet-ws' : 'evm-ws');
        this.startSlowPoll();
        return;
      }
      if (m.kind === 'block') this.emit({ ...m, source: kind });
    };
  }

  /** While a socket is up, a status read every 30 s catches anything it missed. */
  startSlowPoll() {
    clearInterval(this.slow);
    this.slow = setInterval(() => { if (!this.hidden()) this.pollOnce(); }, 5 * this.interval);
  }

  async pollOnce() {
    if (!this.poll) return;
    try { const s = await this.poll(); if (s) this.emit({ height: s.height, time: s.time, txs: null, source: 'poll' }); } catch { /* next tick */ }
  }

  startPolling() {
    if (this.stopped) return;
    clearInterval(this.slow);
    this.setMode('polling');
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (!this.hidden()) this.pollOnce(); }, this.interval);
  }
}

/** A pending tx (base64 from unconfirmed_txs): { hash, evmHash, label, from, value, size }. */
export function pendingSummary(b64, summarize) {
  let bytes;
  try { bytes = fromBase64(b64); } catch { return null; }
  const hash = cometTxHash(bytes);
  const s = summarize({ hash, tx: b64, height: '0', index: 0, tx_result: {} });
  const d = decodeTx(bytes);
  return { hash, evmHash: d.evmHashes[0] ?? null, label: s.label, from: s.from, to: s.to, value: s.value, size: bytes.length, evm: s.evm };
}

/** num_unconfirmed_txs and (where the node shares it) unconfirmed_txs. */
export async function pendingSnapshot(comet, { limit = 30 } = {}) {
  const num = await comet('num_unconfirmed_txs', {}, 0); // never cached: it changes every block
  let txs = null; let refused = '';
  try {
    const r = await comet('unconfirmed_txs', { limit: String(limit) }, 0);
    txs = Array.isArray(r?.txs) ? r.txs.filter((x) => typeof x === 'string').slice(0, limit) : [];
  } catch (e) { refused = clip(e?.message ?? e); }
  return { count: Number(num?.total ?? num?.n_txs ?? 0) || 0, bytes: Number(num?.total_bytes ?? 0) || 0, txs, refused };
}

/** Is the tx in a block yet? For watched txs: { height, ok } or null. */
export async function txLanded(chain, e) {
  if (e.hash.startsWith('0x')) {
    const rc = await chain.evmReceipt(e.hash);
    if (!rc?.blockNumber) return null;
    return { height: BigInt(rc.blockNumber).toString(), ok: rc.status === '0x1' };
  }
  const r = await chain.cosmosTx(e.hash.toLowerCase());
  return r ? { height: r.height, ok: Number(r.txResult?.code ?? 0) === 0 } : null;
}

/** The mode as a short label. */
export const modeLabel = (t, m) => ({ 'comet-ws': t('liveModeComet'), 'evm-ws': t('liveModeEvm'), polling: t('liveModePolling', { s: POLL_MS / 1000 }), connecting: t('liveConnecting') }[m] ?? t('liveOff'));

/** A small "● Live · …" line that follows the feed's mode. */
export function liveIndicator(ctx) {
  const el = h('p', { class: 'live-indicator', role: 'status', id: 'live-mode' });
  let off = null; let shown = false;
  off = ctx.live?.onMode((m) => {
    if (shown && !el.isConnected) { off?.(); return; } // the page went away
    shown = true;
    fill(el, h('span', { class: ['live-dot', m === 'polling' || m === 'connecting' ? 'live-dot-poll' : ''] }), ' ', modeLabel(ctx.t, m));
  });
  ctx.onLeave?.(() => off?.());
  return el;
}

/** Marks table rows that link to blocks above `prevTop` as new (CSS animation). */
export function markNewRows(container, prevTop) {
  if (!prevTop) return;
  for (const a of container.querySelectorAll('a[href^="#/block/"]')) {
    const n = Number(a.getAttribute('href').slice(8));
    if (n > Number(prevTop)) a.closest('tr')?.classList.add('row-new');
  }
}

// ---- the Live page (#/live) ----

export async function pageLive(view, ctx) {
  const { t, chain, api, live, txWatch } = ctx;
  const blocks = h('ol', { class: 'live-blocks', 'aria-live': 'polite' });
  const pending = h('div', null, ctx.loading());
  const watched = h('div', null);
  const input = h('input', { id: 'watch-tx', placeholder: t('liveWatchPlaceholder'), 'aria-label': t('liveWatchPlaceholder'), autocomplete: 'off', spellcheck: 'false' });
  const msg = h('p', { class: 'msg-line', role: 'status' });
  const form = h('form', { class: 'watch-form', on: { submit: (e) => {
    e.preventDefault();
    const p = txHashParam(input.value);
    if (!p) { msg.textContent = t('badHash'); return; }
    txWatch.add(p.hash); input.value = ''; msg.textContent = t('liveWatching');
    renderWatched(); txWatch.checkAll();
  } } }, input, h('button', { type: 'submit' }, t('liveWatchTx')));
  append(view, [
    h('h1', null, t('liveTitle')),
    liveIndicator(ctx),
    h('div', { class: 'grid2' },
      ctx.card(t('liveBlocks'), blocks, ctx.note(t('liveBlocksNote'))),
      ctx.card(t('livePending'), pending)),
    ctx.card(t('liveWatched'), form, msg, watched, ctx.note(t('liveWatchNote'))),
  ]);

  const st = await chain.status();
  const addBlock = (height, time, n, isNew) => {
    const li = h('li', { class: ['live-block', isNew && 'row-new'] }, ctx.blockLink(height), ' ', h('span', { class: 'small dim' }, time ? ago(time, Date.now(), ctx.lang) : ''),
      n != null ? h('span', { class: 'small' }, ` · ${t('liveTxCount', { n })}`) : null);
    blocks.prepend(li);
    while (blocks.children.length > 12) blocks.lastChild.remove();
  };
  const metas = await chain.blockMetas(Math.max(1, Number(st.height) - 7), st.height, st.height).catch(() => []);
  for (const m of [...metas].reverse()) addBlock(m.header.height, m.header.time, Number(m.num_txs), false);

  async function renderPending() {
    try {
      const p = await pendingSnapshot(api.comet);
      const rows = (p.txs ?? []).map((b) => pendingSummary(b, chain.summarize)).filter(Boolean);
      fill(pending,
        h('p', null, h('strong', { id: 'pending-count' }, t('livePendingCount', { n: groupDigits(p.count), kb: groupDigits(Math.ceil(p.bytes / 1024)) }))),
        p.txs == null ? ctx.note(t('livePendingRefused'), 'warn') : rows.length ? ctx.table([t('txHash'), t('type'), t('from'), t('value'), t('size'), ''], rows.map((x) => [
          h('span', { class: 'mono', title: x.evmHash ?? x.hash }, short(x.evmHash ?? x.hash, 10, 6)), safeText(x.label, 48), x.from ? ctx.anyLink(x.from) : '—',
          x.value != null ? formatZtphy(x.value, { maxFrac: 4 }) : '—', `${groupDigits(x.size)} B`,
          h('button', { type: 'button', class: 'secondary small-btn', on: { click: () => { txWatch.add(x.hash, x.evmHash); renderWatched(); msg.textContent = t('liveWatching'); } } }, t('liveWatchTx')),
        ])) : ctx.note(t('livePendingNone')));
    } catch (e) { fill(pending, ctx.errorBox(e)); }
  }

  function renderWatched() {
    const list = txWatch.list();
    fill(watched, list.length ? ctx.table([t('txHash'), t('status'), ''], list.map((e) => [
      ctx.hashLink(e.evmHash ?? e.hash),
      e.status === 'pending' ? ctx.badge(t('pending'), 'warn') : h('span', null, ctx.badge(e.status === 'failed' ? t('failed') : t('liveConfirmed'), e.status === 'failed' ? 'bad' : 'ok'), ' ', t('liveInBlock'), ' ', ctx.blockLink(e.height)),
      h('button', { type: 'button', class: 'secondary small-btn', on: { click: () => { txWatch.remove(e.hash); renderWatched(); } } }, t('watchRemove')),
    ])) : ctx.note(t('liveWatchNone')));
  }

  renderPending(); renderWatched();
  const offWatch = txWatch.onChange(() => { if (view.isConnected) renderWatched(); });
  txWatch.checkAll();
  const off = live.on((b) => {
    if (!view.isConnected) { off(); return; }
    addBlock(b.height, b.time, b.txs ? b.txs.length : null, true);
    renderPending();
  });
  ctx.onLeave(off); ctx.onLeave(offWatch);
}
