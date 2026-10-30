// Fund-flow graph (#/flow/<address>): where native ZETAPHY and tokens went, followed hop after
// hop for as long as the money keeps moving, drawn as an inline SVG.
// There is no indexer, so every address is read on its own and the page says exactly what was read:
//   - tokens: ERC-20 / 721 / 1155 Transfer logs touching the address, in 500-block eth_getLogs
//     windows from the newest block backwards ("Read older blocks" reads the next window)
//   - native ZETAPHY: the blocks the explorer already scans (chain.recentTxs), plus the node's
//     transaction index by address (tx_search, the validated queries of history.js), paginated
// "Follow" expands the graph breadth first, largest outflows first, until the money stops (no
// further outgoing transfer in the data read), every branch reaches a sink (contract, burn,
// module account, bridge, known exchange), or the viewer presses Stop. Any node can be clicked to
// expand it again, any number of times. Nothing is cut silently: per step at most BATCH neighbours
// of an address are added, and the rest is listed with "Load next 50". A transfer is counted once
// (deduplicated by tx and log), so amounts on an edge are conserved whichever side it was read from.
// Cycles are found (strongly connected parts) and drawn, never followed twice. Layers with many
// addresses collapse into "+N more"; the SVG pans and zooms (mouse or keyboard); a path view shows
// how the money went from the start to a chosen address; a paged table lists every transfer.
import { h, append } from './dom.js';
import { anyAddressLower, toAddress, short, formatUnits, formatZtphy, groupDigits, tokenText } from './format.js';
import { decodeTransfer, TOPICS } from './evm.js';
import { labelOf } from './labels.js';
import { addressQueries, HistoryMerger, LogScanner, LOG_WINDOW } from './history.js';
import { TTL } from './rpc.js';

export const NATIVE = 'native';
/** Practical step sizes (all shown on the page and continuable, never a silent cut). */
export const LIMITS = Object.freeze({ batch: 50, logWindow: LOG_WINDOW, layerShow: 12, tablePage: 50, indexPage: 50 });
/** Label kinds where followed money is considered to have left circulation (a sink). */
export const SINK_KINDS = new Set(['burn', 'zero', 'module', 'bridge', 'exchange']);

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

/** Native ZETAPHY moves from tx summaries: [{ key, from, to, asset: 'native', amount, tx, height }]. */
export function edgesFromTxs(txs) {
  const out = [];
  for (const x of txs ?? []) {
    if (!x || x.ok === false || x.value == null) continue;
    let amount;
    try { amount = BigInt(x.value); } catch { continue; }
    if (amount <= 0n) continue;
    const from = anyAddressLower(x.from); const to = anyAddressLower(x.to);
    if (!from || !to || from === to) continue;
    // one tx is one move: the same tx read from the block scan and from the tx index counts once
    const key = `n:${String(x.cometHash ?? x.hash).toUpperCase()}:${x.height}:${x.index ?? 0}`;
    out.push({ key, from, to, asset: NATIVE, amount, tx: x.hash, height: String(x.height) });
  }
  return out;
}

/** Token moves from Transfer logs: ERC-20 amounts, NFTs counted (ERC-721: 1, ERC-1155: the amounts). */
export function edgesFromLogs(logs) {
  const out = [];
  for (const l of logs ?? []) {
    const tr = decodeTransfer(l);
    if (!tr) continue;
    const e = transferEdge(tr, l.transactionHash, l.blockNumber, l.logIndex);
    if (e) out.push(e);
  }
  return out;
}

function transferEdge(tr, txHash, blockNumber, logIndex) {
  const from = tr.from.toLowerCase(); const to = tr.to.toLowerCase();
  if (from === to) return null;
  const amount = tr.standard === 'erc20' ? tr.amount : tr.standard === 'erc721' ? 1n : tr.amounts.reduce((n, x) => n + x, 0n);
  if (amount <= 0n) return null;
  let height = ''; try { height = blockNumber != null && blockNumber !== '' ? BigInt(blockNumber).toString() : ''; } catch { height = ''; }
  let li = ''; try { li = logIndex != null && logIndex !== '' ? BigInt(logIndex).toString() : ''; } catch { li = ''; }
  return { key: `t:${String(txHash).toLowerCase()}:${li}`, from, to, asset: tr.token.toLowerCase(), standard: tr.standard, amount, tx: txHash, height };
}

/** Same (from, to, asset) summed: [{ from, to, asset, standard, amount, count, txs: [≤3] }], deterministic order. */
export function aggregate(edges) {
  const m = new Map(); const seen = new Set();
  for (const e of edges) {
    if (e.key) { if (seen.has(e.key)) continue; seen.add(e.key); }
    const k = `${e.from}|${e.to}|${e.asset}`;
    const x = m.get(k) ?? { from: e.from, to: e.to, asset: e.asset, standard: e.standard ?? (e.asset === NATIVE ? NATIVE : 'erc20'), amount: 0n, count: 0, txs: [] };
    x.amount += e.amount; x.count++;
    if (x.txs.length < 3 && e.tx && !x.txs.includes(e.tx)) x.txs.push(e.tx);
    m.set(k, x);
  }
  return [...m.values()].sort(edgeOrder);
}

// native first, then larger amounts, then addresses: the same input always gives the same graph
export function edgeOrder(a, b) {
  if ((a.asset === NATIVE) !== (b.asset === NATIVE)) return a.asset === NATIVE ? -1 : 1;
  if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;
  const x = `${a.from}|${a.to}|${a.asset}`; const y = `${b.from}|${b.to}|${b.asset}`;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The growing graph. Every transfer read is kept once (by key); nodes are the addresses placed
 * so far, each with a layer (0 = start, +k = k hops downstream, −k = k hops upstream). Edges are
 * the aggregated transfers between placed nodes. expand() adds the next `batch` neighbours of a
 * node in a direction (largest first) and says how many are left: nothing is dropped.
 */
export class FlowGraph {
  constructor(root) {
    this.root = String(root).toLowerCase();
    this.transfers = new Map(); // key -> edge
    this.nodes = new Map([[this.root, { id: this.root, layer: 0, hop: 0, followed: false, status: 'open', sink: null, opened: { out: false, in: false } }]]);
    this.version = 0; this.aggCache = null;
  }

  /** Adds transfers (deduplicated); returns how many were new. */
  addTransfers(edges) {
    let n = 0;
    for (const e of edges ?? []) {
      const key = e.key ?? `${e.from}|${e.to}|${e.asset}|${e.tx ?? ''}|${e.height ?? ''}|${e.amount}`;
      if (this.transfers.has(key)) continue;
      this.transfers.set(key, { ...e, key }); n++;
    }
    if (n) { this.version++; this.aggCache = null; }
    return n;
  }

  /** All transfers aggregated per (from, to, asset), cached per version. */
  allEdges() {
    if (!this.aggCache) {
      const all = aggregate([...this.transfers.values()]);
      const out = new Map(); const inn = new Map();
      for (const e of all) {
        if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e);
        if (!inn.has(e.to)) inn.set(e.to, []); inn.get(e.to).push(e);
      }
      this.aggCache = { all, out, inn };
    }
    return this.aggCache;
  }

  /** Aggregated edges between placed nodes. */
  edges() { return this.allEdges().all.filter((e) => this.nodes.has(e.from) && this.nodes.has(e.to)); }

  /** Neighbour addresses of id in a direction (+1 receivers, −1 senders), largest first. */
  neighbours(id, dir) {
    const list = (dir > 0 ? this.allEdges().out.get(id) : this.allEdges().inn.get(id)) ?? [];
    const ids = [];
    for (const e of list) { const n = dir > 0 ? e.to : e.from; if (!ids.includes(n)) ids.push(n); }
    return ids;
  }

  /** How many neighbours of id in a direction are not placed yet. */
  remaining(id, dir) { return this.neighbours(id, dir).filter((x) => !this.nodes.has(x)).length; }

  place(id, layer, hop) {
    if (this.nodes.has(id)) return false;
    this.nodes.set(id, { id, layer, hop, followed: false, status: 'open', sink: null, opened: { out: false, in: false } });
    this.version++;
    return true;
  }

  /**
   * Places the next `batch` not-yet-placed neighbours of id in each direction of `dirs`.
   * The start's column holds the start only: an upstream node's outflows go to the downstream side.
   * Returns { added: [ids], left: { out, in } }.
   */
  expand(id, { dirs = [1, -1], batch = LIMITS.batch } = {}) {
    const n = this.nodes.get(String(id).toLowerCase());
    if (!n) return { added: [], left: { out: 0, in: 0 } };
    const added = [];
    for (const d of dirs) {
      n.opened[d > 0 ? 'out' : 'in'] = true;
      const fresh = this.neighbours(n.id, d).filter((x) => !this.nodes.has(x)).slice(0, Math.max(1, batch));
      const layer = n.layer + d === 0 ? d : n.layer + d;
      for (const x of fresh) if (this.place(x, layer, n.hop + 1)) added.push(x);
    }
    return { added, left: { out: this.remaining(n.id, 1), in: this.remaining(n.id, -1) } };
  }

  /** Amount that flowed into id from placed nodes (for "largest first" ordering): native, then tokens. */
  inflow(id) {
    let native = 0n; let tokens = 0n;
    for (const e of this.allEdges().inn.get(id) ?? []) if (this.nodes.has(e.from)) { if (e.asset === NATIVE) native += e.amount; else tokens += e.amount; }
    return { native, tokens };
  }
}

const byInflow = (g) => (a, b) => {
  const x = g.inflow(a.id); const y = g.inflow(b.id);
  if (x.native !== y.native) return x.native > y.native ? -1 : 1;
  if (x.tokens !== y.tokens) return x.tokens > y.tokens ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Follows the money from every placed downstream node not followed yet, breadth first (hop by
 * hop, the largest inflows first within a hop), with no hop limit. For each node: read(id) loads
 * its data (once), isSink(id) -> a sink kind or null (the start is never a sink), then its next
 * `batch` receivers are placed and queued. A node already placed is never queued again, so cycles
 * end. Stops when nothing is left (the money stops in the data read, or every branch is a sink)
 * or shouldStop() is true (checked before each node). onStep(info) after each node; pause() between
 * nodes keeps the page responsive.
 * Returns { stopped, hop, followed }.
 */
export async function follow(g, { read, isSink = async () => null, batch = LIMITS.batch, shouldStop = () => false, onStep = () => {}, pause = () => Promise.resolve() } = {}) {
  let followed = 0; let hop = 0;
  let level = [...g.nodes.values()].filter((n) => n.layer >= 0 && !n.followed && n.status !== 'sink');
  while (level.length) {
    hop = Math.min(...level.map((n) => n.hop));
    const now = level.filter((n) => n.hop === hop).sort(byInflow(g));
    const later = level.filter((n) => n.hop !== hop);
    const next = [];
    for (const n of now) {
      if (shouldStop()) return { stopped: true, hop, followed };
      if (n.followed) continue;
      await read(n.id);
      const sink = n.id === g.root ? null : await isSink(n.id);
      n.followed = true; followed++;
      if (sink) { n.status = 'sink'; n.sink = sink; } else {
        const { added } = g.expand(n.id, { dirs: [1], batch });
        n.status = g.neighbours(n.id, 1).length ? 'followed' : 'end';
        for (const id of added) next.push(g.nodes.get(id));
      }
      g.version++;
      onStep({ hop, node: n.id, followed, nodes: g.nodes.size });
      await pause();
    }
    level = [...later, ...next].filter((n) => !n.followed);
  }
  return { stopped: false, hop, followed };
}

/**
 * Cycles: the strongly connected parts (more than one address) of the placed graph, each a
 * sorted list of addresses (Tarjan, iterative: no recursion depth limit). Deterministic.
 */
export function findCycles(nodes, edges) {
  const ids = [...nodes].sort();
  const adj = new Map(ids.map((x) => [x, []]));
  for (const e of edges) if (adj.has(e.from) && adj.has(e.to) && !adj.get(e.from).includes(e.to)) adj.get(e.from).push(e.to);
  for (const l of adj.values()) l.sort();
  let index = 0; const idx = new Map(); const low = new Map(); const onStack = new Set(); const stack = []; const out = [];
  for (const start of ids) {
    if (idx.has(start)) continue;
    const work = [[start, 0]];
    idx.set(start, index); low.set(start, index); index++; stack.push(start); onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      const list = adj.get(v);
      if (i < list.length) {
        top[1]++;
        const w = list[i];
        if (!idx.has(w)) { idx.set(w, index); low.set(w, index); index++; stack.push(w); onStack.add(w); work.push([w, 0]); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u), low.get(v))); }
        if (low.get(v) === idx.get(v)) {
          const comp = [];
          for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === v) break; }
          if (comp.length > 1) out.push(comp.sort());
        }
      }
    }
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * The shortest path (fewest hops) along the direction of the money from `from` to `to`, among
 * the given aggregated edges; between equally short paths the larger transfers win (edges are
 * tried in edgeOrder). Returns { nodes: [ids], edges: [edge] } or null.
 */
export function findPath(edges, from, to) {
  const a = String(from).toLowerCase(); const b = String(to).toLowerCase();
  if (a === b) return { nodes: [a], edges: [] };
  const out = new Map();
  for (const e of [...edges].sort(edgeOrder)) { if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e); }
  const prev = new Map([[a, null]]); let frontier = [a];
  while (frontier.length && !prev.has(b)) {
    const next = [];
    for (const v of frontier) for (const e of out.get(v) ?? []) if (!prev.has(e.to)) { prev.set(e.to, e); next.push(e.to); }
    frontier = next;
  }
  if (!prev.has(b)) return null;
  const path = []; let v = b;
  while (prev.get(v)) { const e = prev.get(v); path.unshift(e); v = e.from; }
  return { nodes: [a, ...path.map((e) => e.to)], edges: path };
}

/**
 * What is drawn: per layer, the `shown` largest nodes (default LIMITS.layerShow; a collapsed
 * layer shows none) and one "+N more" placeholder for the rest; nodes on `keep` (the path, the
 * start) are always drawn. Edges between drawn nodes. Returns { root, nodes, edges, hidden }.
 */
export function visibleGraph(g, { shown = new Map(), collapsed = new Set(), keep = [] } = {}) {
  const must = new Set([g.root, ...keep]);
  const layers = new Map();
  for (const n of g.nodes.values()) { if (!layers.has(n.layer)) layers.set(n.layer, []); layers.get(n.layer).push(n); }
  const nodes = []; let hidden = 0;
  for (const [layer, list] of [...layers].sort((x, y) => x[0] - y[0])) {
    const order = layer < 0 ? (a, b) => outflowCmp(g, a, b) : byInflow(g);
    const sorted = [...list].sort(order);
    const limit = collapsed.has(layer) ? 0 : (shown.get(layer) ?? LIMITS.layerShow);
    const vis = sorted.filter((n, i) => i < limit || must.has(n.id));
    const rest = sorted.length - vis.length;
    for (const n of vis) nodes.push({ id: n.id, layer, hop: n.hop });
    if (rest > 0) { nodes.push({ id: `more:${layer}`, layer, more: rest }); hidden += rest; }
  }
  const ids = new Set(nodes.map((n) => n.id));
  return { root: g.root, nodes, edges: g.edges().filter((e) => ids.has(e.from) && ids.has(e.to)), hidden };
}

function outflowCmp(g, a, b) {
  const sum = (id) => (g.allEdges().out.get(id) ?? []).filter((e) => g.nodes.has(e.to)).reduce((n, e) => n + (e.asset === NATIVE ? e.amount : 0n), 0n);
  const x = sum(a.id); const y = sum(b.id);
  if (x !== y) return x > y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Deterministic layered layout: one column per layer (left = upstream), nodes in a column
 * ordered by the mean row of their neighbours in the column nearer the start (one barycentre
 * pass), ties by address. Edges are cubic curves with a label point.
 * Returns { width, height, nodes: [{ id, layer, x, y }], edges: [{ ...edge, d, lx, ly }] }.
 */
export function layoutGraph(g, { colW = 230, rowH = 70, nodeW = 168, nodeH = 40, pad = 24 } = {}) {
  const layers = [...new Set(g.nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const byLayer = new Map(layers.map((l) => [l, g.nodes.filter((n) => n.layer === l)]));
  const layerOf = new Map(g.nodes.map((n) => [n.id, n.layer]));
  const nb = new Map(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) { if (nb.has(e.from) && nb.has(e.to)) { nb.get(e.from).push(e.to); nb.get(e.to).push(e.from); } }
  const row = new Map();
  for (const l of [...layers].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)) {
    const inner = l === 0 ? null : l - Math.sign(l);
    const score = (n) => {
      if (inner == null || n.more) return n.more ? Infinity : 0;
      const rows = nb.get(n.id).filter((m) => layerOf.get(m) === inner).map((m) => row.get(m)).filter((x) => x != null);
      return rows.length ? rows.reduce((s, x) => s + x, 0) / rows.length : Infinity - 1;
    };
    const scored = byLayer.get(l).map((n) => ({ n, s: score(n) }));
    scored.sort((a, b) => (a.s === b.s ? (a.n.more ? 1 : b.n.more ? -1 : a.n.id < b.n.id ? -1 : 1) : a.s - b.s));
    scored.forEach(({ n }, i) => row.set(n.id, i));
    byLayer.set(l, scored.map((x) => x.n));
  }
  const tallest = Math.max(1, ...[...byLayer.values()].map((x) => x.length));
  const height = pad * 2 + (tallest - 1) * rowH + nodeH;
  const width = pad * 2 + (layers.length - 1) * colW + nodeW;
  const pos = new Map();
  layers.forEach((l, ci) => {
    const list = byLayer.get(l);
    const off = ((tallest - list.length) * rowH) / 2;
    list.forEach((n, i) => pos.set(n.id, { id: n.id, layer: l, x: pad + ci * colW, y: pad + off + i * rowH, ...(n.more ? { more: n.more } : {}) }));
  });
  const pairCount = new Map();
  const edges = g.edges.map((e) => {
    const a = pos.get(e.from); const b = pos.get(e.to);
    const key = [e.from, e.to].sort().join('|');
    const k = pairCount.get(key) ?? 0; pairCount.set(key, k + 1);
    const bend = k * 14;
    let d; let lx; let ly;
    if (b.x > a.x) {
      const x1 = a.x + nodeW; const y1 = a.y + nodeH / 2 + bend / 2; const x2 = b.x; const y2 = b.y + nodeH / 2 + bend / 2;
      const cx = (x1 + x2) / 2;
      d = `M${x1} ${y1} C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
      lx = cx; ly = (y1 + y2) / 2 - 4 + bend;
    } else {
      // backwards or in the same column (a cycle): a loop over the top of the nodes
      const x1 = a.x + nodeW / 2 + bend; const y1 = a.y; const x2 = b.x + nodeW / 2 - bend; const y2 = b.y;
      const top = Math.max(2, Math.min(y1, y2) - 26 - bend);
      d = `M${x1} ${y1} C${x1} ${top} ${x2} ${top} ${x2} ${y2}`;
      lx = (x1 + x2) / 2; ly = top + 8;
    }
    return { ...e, d, lx: Math.round(lx), ly: Math.round(ly) };
  });
  return { width, height, nodeW, nodeH, nodes: [...pos.values()].sort((x, y) => x.layer - y.layer || x.y - y.y), edges };
}

/** Edges grouped by (from, to), in their order (the largest of each pair first). */
export function pairs(edges) {
  const m = new Map();
  for (const e of edges) { const k = `${e.from}|${e.to}`; if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
  return [...m.values()];
}

/** A view box after a zoom (factor > 1: closer) around the point (cx, cy), or a pan by (dx, dy). Pure. */
export function zoomBox(box, factor, cx = box.x + box.w / 2, cy = box.y + box.h / 2) {
  const f = Math.min(8, Math.max(1 / 8, factor));
  const w = box.w / f; const h2 = box.h / f;
  return { x: cx - (cx - box.x) / f, y: cy - (cy - box.y) / f, w, h: h2 };
}
export const panBox = (box, dx, dy) => ({ ...box, x: box.x + dx, y: box.y + dy });

// ---- reading one address (the browser's data source) ----

/**
 * Per-address readers on the node: token Transfer logs in LIMITS.logWindow-block windows
 * backwards (LogScanner), native moves from the node's tx index (history.js queries, merged
 * and paginated, LIMITS.indexPage per read) and the block scan (given once: scanEdges).
 * read(id) the first time, older(id) for the next window / page. range(id) says what was read.
 */
export function nodeSource({ chain, comet, latest, scan, window = LIMITS.logWindow, indexPage = LIMITS.indexPage }) {
  const per = new Map();
  const top = Number(latest);
  const state = (id) => {
    if (per.has(id)) return per.get(id);
    const a = toAddress(id);
    const s = { read: false, logs: new LogScanner((from, to) => chain.transferLogs(id, from, to, TOPICS), top, { window }), index: null, indexError: null, indexCount: 0, indexLow: null };
    try {
      s.index = new HistoryMerger(addressQueries(a.hex), (src, page, perPage) => comet('tx_search', { query: src.query, prove: false, page: String(page), per_page: String(perPage), order_by: 'desc' }), { perPage: indexPage });
    } catch (e) { s.indexError = e; }
    per.set(id, s);
    return s;
  };
  async function step(id) {
    const s = state(id);
    const edges = [];
    if (!s.logs.done) {
      const items = await s.logs.loadMore({ minItems: Infinity, maxWindows: 1 });
      for (const x of items) { const e = transferEdge(x.tr, x.txHash, x.block, x.logIndex); if (e) edges.push(e); }
    }
    if (s.index && !s.index.done && !s.indexError) {
      try {
        const got = await s.index.loadMore(indexPage);
        if (s.index.failed) s.indexError = new Error(s.index.errors.map((x) => x.message).join('; '));
        const sums = [];
        for (const e of got) {
          let x; try { x = chain.summarize({ ...e.tx, hash: e.hash }); } catch { continue; }
          sums.push(x);
          const hgt = Number(x.height);
          if (s.indexLow == null || hgt < s.indexLow) s.indexLow = hgt;
        }
        s.indexCount += got.length;
        edges.push(...edgesFromTxs(sums));
      } catch (e) { s.indexError = e; }
    }
    s.read = true;
    return edges;
  }
  return {
    scanEdges: () => edgesFromTxs(scan?.txs ?? []),
    isRead: (id) => per.get(id)?.read ?? false,
    read: async (id) => (state(id).read ? [] : step(id)),
    older: (id) => step(id),
    /** More data available for id (an older window, or more tx index pages). */
    hasOlder: (id) => { const s = per.get(id); return !s || !s.logs.done || !!(s.index && !s.index.done && !s.indexError); },
    range(id) {
      const s = per.get(id);
      if (!s?.read) return null;
      return {
        tokens: { from: s.logs.from, to: top },
        scan: scan ? { from: Number(scan.from), to: Number(scan.to) } : null,
        index: s.indexError ? { refused: true } : s.index?.done ? { all: true, to: top, count: s.indexCount } : { from: s.indexLow ?? top, to: top, count: s.indexCount },
      };
    },
  };
}

// ---- the page ----

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (/^on/i.test(k) || k === 'style' || k === 'href') throw new Error(`refusing attribute ${k}`);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Replaces el's children (nodes or text; lists flattened; null, false and '' skipped). */
const put = (el, ...kids) => { el.replaceChildren(); return append(el, ...kids); };

/** "0x12…ab" or the known label, cut to fit a node. */
const nodeName = (id) => labelOf(id)?.name ?? short(toAddress(id)?.hex ?? id, 8, 6);
const fit = (x, n) => (x.length > n ? x.slice(0, n - 1) + '…' : x);

/** #/flow/<address> */
export async function pageFlow(view, param, ui) {
  const { t, chain, cfg, card, note, table, addrLink, loading, errorBox } = ui;
  const [raw] = String(param ?? '').split('?');
  const a = toAddress(decodeURIComponent(raw));
  if (!a) { view.append(errorBox(t('badAddress'))); return; }
  const status = h('p', { class: 'flow-status', role: 'status', 'aria-live': 'polite' });
  const followBtn = h('button', { type: 'button', id: 'flow-follow', on: { click: () => startFollow() } }, t('flowFollow'));
  const stopBtn = h('button', { type: 'button', id: 'flow-stop', class: 'secondary', disabled: '', on: { click: () => { stopping = true; } } }, t('flowStop'));
  const head = h('div', { class: 'flow-head' }, h('h1', null, t('flowTitle')), h('p', null, addrLink(a.hex, { full: true })),
    h('div', { class: 'row flow-toolbar' }, followBtn, stopBtn), status);
  const body = h('div', null, loading());
  view.append(head, body);

  const st = await chain.status();
  const latest = Number(st.height);
  const scan = await chain.recentTxs(st.height, cfg.scanBlocks);
  const src = nodeSource({ chain, comet: (m, p) => ui.api.comet(m, p, TTL.short), latest, scan });
  const g = new FlowGraph(a.lower);
  g.addTransfers(src.scanEdges());
  g.addTransfers(await src.read(a.lower));
  g.expand(a.lower); // hop 1, both ways

  const sinkCache = new Map();
  const isSink = (id) => {
    if (!sinkCache.has(id)) {
      sinkCache.set(id, (async () => {
        if (id === ZERO) return 'zero';
        if (id === DEAD) return 'burn';
        const l = labelOf(id);
        if (l && SINK_KINDS.has(l.kind)) return l.kind;
        try { const code = await chain.evmCall('eth_getCode', [toAddress(id).hex, 'latest']); if (typeof code === 'string' && code.length > 2) return 'contract'; } catch { /* unknown: keep following */ }
        return null;
      })());
    }
    return sinkCache.get(id);
  };

  const tokens = new Map(); const info = new Map();
  const loadTokens = async () => {
    const want = [...new Set([...g.transfers.values()].filter((e) => e.asset !== NATIVE).map((e) => e.asset))].filter((x) => !tokens.has(x));
    for (const x of want) tokens.set(x, ui.tokenInfo(x).then((i) => info.set(x, i)).catch(() => info.set(x, {})));
    await Promise.all(want.map((x) => tokens.get(x)));
  };
  const amountText = (e) => {
    if (e.asset === NATIVE) return formatZtphy(e.amount, { maxFrac: 4 });
    const i = info.get(e.asset) ?? {};
    const sym = tokenText(i.symbol, 12, short(e.asset, 6, 4));
    if (e.standard === 'erc721' || e.standard === 'erc1155') return `${groupDigits(e.amount.toString())} NFT ${sym}`;
    return `${i.decimals != null ? formatUnits(e.amount, i.decimals, { maxFrac: 4 }) : groupDigits(e.amount.toString())} ${sym}`;
  };
  const rangeText = (id) => {
    const r = src.range(id);
    if (!r) return t('flowNotRead');
    const parts = [t('flowRangeTokens', { from: groupDigits(r.tokens.from), to: groupDigits(r.tokens.to) })];
    if (r.scan) parts.push(t('flowRangeScan', { from: groupDigits(r.scan.from), to: groupDigits(r.scan.to) }));
    parts.push(r.index.refused ? t('flowRangeIndexOff') : r.index.all ? t('flowRangeIndexAll', { n: groupDigits(r.index.count) })
      : t('flowRangeIndexFrom', { from: groupDigits(r.index.from), to: groupDigits(r.index.to), n: groupDigits(r.index.count) }));
    return parts.join(' · ');
  };
  const statusText = (n) => (n.id === g.root ? t('flowStatus_root') : n.status === 'sink' ? t('flowStatus_sink', { k: t(`flowSink_${n.sink}`) }) : t(`flowStatus_${n.status}`));

  // view state
  const shown = new Map(); const collapsed = new Set();
  let path = null; let pathAsked = false; let box = null; let base = null; let tablePage = 0; let nodePage = 0;
  let running = false; let stopping = false; let lastResult = null;

  const svgWrap = h('div', { class: 'flow-wrap', tabindex: '0', role: 'group', 'aria-label': t('flowPanHint') });
  const zoomBar = h('div', { class: 'row flow-zoom' },
    h('button', { type: 'button', class: 'secondary', 'aria-label': t('flowZoomIn'), title: t('flowZoomIn'), on: { click: () => zoom(1.25) } }, '+'),
    h('button', { type: 'button', class: 'secondary', 'aria-label': t('flowZoomOut'), title: t('flowZoomOut'), on: { click: () => zoom(0.8) } }, '−'),
    h('button', { type: 'button', class: 'secondary', on: { click: () => { box = null; applyBox(); } } }, t('flowZoomReset')),
    h('span', { class: 'small dim' }, t('flowPanHint')));
  const layerBar = h('div', { class: 'flow-layers' });
  const cycleBox = h('div');
  const pathBox = h('div', { class: 'flow-path-box' });
  const pathSel = h('select', { id: 'flow-path-to', class: 'filter-select' });
  const pathCard = card(t('flowPathTitle'), h('div', { class: 'row' }, h('label', { for: 'flow-path-to' }, t('flowPathTo')), pathSel,
    h('button', { type: 'button', id: 'flow-path-show', on: { click: () => { path = findPath(g.edges(), g.root, pathSel.value); pathAsked = true; renderPath(); draw(); } } }, t('flowPathShow')),
    h('button', { type: 'button', id: 'flow-path-clear', class: 'secondary', on: { click: () => { path = null; pathAsked = false; renderPath(); draw(); } } }, t('flowPathClear'))), pathBox);
  const nodesBox = h('div'); const tableBox = h('div');
  const scope = note(t('flowScope', { from: groupDigits(scan.from), to: groupDigits(scan.to), w: groupDigits(LIMITS.logWindow), b: LIMITS.batch })
    + (scan.complete ? '' : ` ${t('scanIncomplete')}`), 'info');

  let svg = null;
  const applyBox = () => {
    if (!svg || !base) return;
    const b = box ?? base;
    svg.setAttribute('viewBox', `${Math.round(b.x)} ${Math.round(b.y)} ${Math.round(b.w)} ${Math.round(b.h)}`);
  };
  const zoom = (f, cx, cy) => { box = zoomBox(box ?? base, f, cx, cy); applyBox(); };
  const pan = (fx, fy) => { const b = box ?? base; box = panBox(b, b.w * fx, b.h * fy); applyBox(); };
  svgWrap.addEventListener('keydown', (ev) => {
    const k = ev.key;
    const act = { ArrowLeft: () => pan(-0.1, 0), ArrowRight: () => pan(0.1, 0), ArrowUp: () => pan(0, -0.1), ArrowDown: () => pan(0, 0.1), '+': () => zoom(1.25), '=': () => zoom(1.25), '-': () => zoom(0.8), _: () => zoom(0.8), 0: () => { box = null; applyBox(); } }[k];
    if (act && ev.target === svgWrap) { ev.preventDefault(); act(); }
  });
  svgWrap.addEventListener('wheel', (ev) => {
    if (!svg || !ev.ctrlKey) return; // plain wheel scrolls the page; ctrl + wheel (and pinch) zooms
    ev.preventDefault();
    const r = svg.getBoundingClientRect(); const b = box ?? base;
    zoom(ev.deltaY < 0 ? 1.15 : 1 / 1.15, b.x + ((ev.clientX - r.left) / r.width) * b.w, b.y + ((ev.clientY - r.top) / r.height) * b.h);
  }, { passive: false });
  let drag = null;
  svgWrap.addEventListener('pointerdown', (ev) => { if (svg && ev.button === 0 && !ev.target.closest?.('.flow-node')) drag = { x: ev.clientX, y: ev.clientY, b: box ?? base }; });
  svgWrap.addEventListener('pointermove', (ev) => {
    if (!drag || !svg) return;
    const r = svg.getBoundingClientRect();
    box = panBox(drag.b, -((ev.clientX - drag.x) / r.width) * drag.b.w, -((ev.clientY - drag.y) / r.height) * drag.b.h); applyBox();
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) svgWrap.addEventListener(ev, () => { drag = null; });

  function renderPath() {
    if (!path) { put(pathBox, pathAsked ? note(t('flowPathNone')) : ''); return; }
    put(pathBox, h('p', { class: 'small' }, t('flowPathSteps', { n: path.edges.length })),
      h('ol', { class: 'flow-path-list' }, path.edges.map((e) => h('li', null, addrLink(e.from), ' → ', addrLink(e.to), ' · ', amountText(e), ` (${e.count} tx)`))));
  }

  function draw() {
    if (g.nodes.size === 1 && !g.edges().length) { put(body, note(t('flowEmpty')), scope); return; }
    const keep = path ? path.nodes : [];
    const vg = visibleGraph(g, { shown, collapsed, keep });
    const L = layoutGraph(vg);
    const cycles = findCycles(g.nodes.keys(), g.edges());
    const inCycle = new Set(cycles.flat());
    const cycleOf = new Map(); cycles.forEach((c, i) => c.forEach((x) => cycleOf.set(x, i)));
    const onPath = new Set(path ? path.edges.map((e) => `${e.from}|${e.to}`) : []);
    const pathNodes = new Set(keep);
    const nodeById = (id) => g.nodes.get(id);
    svg = s('svg', { class: 'flow-svg', width: L.width, height: L.height, role: 'img', 'aria-labelledby': 'flow-svg-title', preserveAspectRatio: 'xMinYMin meet' },
      s('title', { id: 'flow-svg-title' }, t('flowSvgTitle', { n: g.nodes.size, e: g.edges().length })),
      s('defs', null, s('marker', { id: 'flow-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0 0 L10 5 L0 10 z', class: 'flow-arrowhead' }))),
      // one curve per (from, to): its assets in one label (largest first), all of them in the tooltip
      pairs(L.edges).map((list) => {
        const e = list[0];
        const label = list.length > 1 ? `${amountText(e)} +${list.length - 1}` : amountText(e);
        const cyc = cycleOf.has(e.from) && cycleOf.get(e.from) === cycleOf.get(e.to);
        return s('g', { class: ['flow-edge', list.some((x) => x.asset === NATIVE) ? 'flow-native' : 'flow-token', cyc && 'flow-cycle', onPath.has(`${e.from}|${e.to}`) && 'flow-on-path'] },
          s('path', { d: e.d, 'marker-end': 'url(#flow-arrow)' }, s('title', null, `${nodeName(e.from)} → ${nodeName(e.to)}: ${list.map((x) => `${amountText(x)} (${x.count} tx)`).join(', ')}`)),
          s('text', { x: e.lx, y: e.ly, 'text-anchor': 'middle', class: 'flow-amount' }, fit(label, 24)));
      }),
      L.nodes.map((n) => {
        if (n.more) {
          const layer = n.layer;
          const showMore = () => { collapsed.delete(layer); shown.set(layer, (shown.get(layer) ?? LIMITS.layerShow) + LIMITS.batch); draw(); };
          return s('g', { class: 'flow-node flow-more', transform: `translate(${n.x} ${n.y})`, tabindex: 0, role: 'button', 'data-more': String(layer),
            'aria-label': t('flowMoreTitle', { n: Math.min(n.more, LIMITS.batch) }),
            on: { click: showMore, keydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showMore(); } } } },
          s('title', null, t('flowMoreTitle', { n: Math.min(n.more, LIMITS.batch) })),
          s('rect', { width: L.nodeW, height: L.nodeH, rx: 8 }),
          s('text', { x: 10, y: 24, class: 'flow-node-name' }, t('flowMore', { n: groupDigits(n.more) })));
        }
        const fn = nodeById(n.id);
        const label = labelOf(n.id);
        const node = s('g', { class: ['flow-node', n.id === g.root && 'flow-root', label && 'flow-known', inCycle.has(n.id) && 'flow-in-cycle', fn?.status === 'sink' && 'flow-sink', pathNodes.has(n.id) && 'flow-on-path'],
          transform: `translate(${n.x} ${n.y})`, tabindex: 0, role: 'button', 'data-address': n.id, 'data-hop': String(n.layer), 'aria-label': t('flowExpandNode', { a: nodeName(n.id) }),
          on: { click: () => expandNode(n.id), keydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); expandNode(n.id); } } } },
        s('title', null, `${toAddress(n.id)?.hex ?? n.id}${label ? `\n${label.name}` : ''}\n${statusText(fn)}\n${rangeText(n.id)}\n${t('flowClick')}`),
        s('rect', { width: L.nodeW, height: L.nodeH, rx: 8 }),
        s('text', { x: 10, y: 17, class: 'flow-node-name' }, fit(nodeName(n.id), 22)),
        s('text', { x: 10, y: 32, class: 'flow-node-sub' }, n.id === g.root ? t('flowRoot') : n.layer < 0 ? t('flowUpstream', { n: -n.layer }) : t('flowDownstream', { n: n.layer })));
        ui.risk?.lookup(n.id).then((r) => { if (r.state === 'flagged') { node.classList.add('flow-flagged'); node.querySelector('title').textContent += `\n⚠ ${t('riskFlagged')}`; } else if (r.state === 'clean') node.classList.add('flow-clean'); });
        return node;
      }));
    base = { x: 0, y: 0, w: L.width, h: L.height };
    applyBox();
    put(svgWrap, svg);
    // layers: collapse / show
    const layerIds = [...new Set([...g.nodes.values()].map((n) => n.layer))].sort((x, y) => x - y).filter((l) => l !== 0);
    put(layerBar, h('span', { class: 'small dim' }, t('flowLayers')), ' ', layerIds.map((l) => {
      const count = [...g.nodes.values()].filter((n) => n.layer === l).length;
      const name = l < 0 ? t('flowUpstream', { n: -l }) : t('flowDownstream', { n: l });
      return h('button', { type: 'button', class: ['secondary', 'flow-layer-btn'], 'aria-pressed': collapsed.has(l) ? 'false' : 'true', 'data-layer': String(l),
        on: { click: () => { if (collapsed.has(l)) collapsed.delete(l); else collapsed.add(l); draw(); } } },
      `${collapsed.has(l) ? t('flowExpandLayer', { h: name }) : t('flowCollapse', { h: name })} (${groupDigits(count)})`);
    }));
    put(cycleBox, cycles.length ? note(t('flowCycles', { n: cycles.length }) + ' ' + cycles.map((c) => c.map(nodeName).join(' ⇄ ')).join(' · '), 'warn') : '');
    // the path selector: every placed address
    const cur = pathSel.value;
    put(pathSel, [...g.nodes.values()].filter((n) => n.id !== g.root).sort((x, y) => x.layer - y.layer || (x.id < y.id ? -1 : 1))
      .map((n) => h('option', { value: n.id }, `${n.layer < 0 ? t('flowUpstream', { n: -n.layer }) : t('flowDownstream', { n: n.layer })} · ${nodeName(n.id)}`)));
    if (cur && g.nodes.has(cur)) pathSel.value = cur;
    renderNodes(); renderTable();
    if (!body.contains(svgWrap)) {
      put(body, 
        card(null, h('div', { class: 'flow-legend' }, h('span', { class: 'flow-key flow-key-native' }, t('flowNative')), ' ', h('span', { class: 'flow-key flow-key-token' }, t('flowTokens')), ' ',
          h('span', { class: 'flow-key flow-key-flagged' }, t('riskFlagged')), ' ', h('span', { class: 'flow-key flow-key-cycle' }, t('flowCycle')), ' ', h('span', { class: 'small dim' }, t('flowClickHint'))),
        zoomBar, svgWrap, layerBar, cycleBox, scope),
        pathCard,
        card(t('flowNodesTitle'), nodesBox),
        card(t('flowTableTitle'), tableBox));
    }
  }

  const pager = (page, total, set) => {
    const n = LIMITS.tablePage;
    if (total <= n) return null;
    const from = page * n + 1; const to = Math.min(total, (page + 1) * n);
    return h('div', { class: 'row flow-pager' },
      h('button', { type: 'button', class: 'secondary', disabled: page === 0 ? '' : null, on: { click: () => set(page - 1) } }, t('flowPrevPage', { n })),
      h('span', { class: 'small' }, t('flowPage', { from: groupDigits(from), to: groupDigits(to), n: groupDigits(total) })),
      h('button', { type: 'button', class: 'secondary', disabled: to >= total ? '' : null, on: { click: () => set(page + 1) } }, t('flowNextPage', { n: Math.min(n, total - to) })));
  };

  function renderNodes() {
    const list = [...g.nodes.values()].sort((x, y) => Math.abs(x.layer) - Math.abs(y.layer) || x.layer - y.layer || (x.id < y.id ? -1 : 1));
    nodePage = Math.min(nodePage, Math.max(0, Math.ceil(list.length / LIMITS.tablePage) - 1));
    const rows = list.slice(nodePage * LIMITS.tablePage, (nodePage + 1) * LIMITS.tablePage).map((n) => {
      const out = n.opened.out ? g.remaining(n.id, 1) : 0; const inn = n.opened.in ? g.remaining(n.id, -1) : 0;
      const actions = [
        out ? h('button', { type: 'button', class: 'secondary flow-next', 'data-address': n.id, on: { click: () => { g.expand(n.id, { dirs: [1] }); draw(); } } },
          `${t('flowMoreOut', { n: groupDigits(out) })} · ${t('flowLoadNext', { n: Math.min(out, LIMITS.batch) })}`) : null,
        inn ? h('button', { type: 'button', class: 'secondary flow-next', on: { click: () => { g.expand(n.id, { dirs: [-1] }); draw(); } } },
          `${t('flowMoreIn', { n: groupDigits(inn) })} · ${t('flowLoadNext', { n: Math.min(inn, LIMITS.batch) })}`) : null,
        src.isRead(n.id) && src.hasOlder(n.id) ? h('button', { type: 'button', class: 'secondary flow-older', 'data-address': n.id, on: { click: (ev) => readOlder(n.id, ev.currentTarget) } }, t('flowReadOlder')) : null,
      ].filter(Boolean);
      return [addrLink(n.id), n.id === g.root ? t('flowRoot') : n.layer < 0 ? t('flowUpstream', { n: -n.layer }) : t('flowDownstream', { n: n.layer }), statusText(n),
        h('span', { class: 'small flow-range', 'data-address': n.id }, rangeText(n.id)), actions.length ? h('span', { class: 'flow-actions' }, actions) : '—'];
    });
    put(nodesBox, note(t('flowBatchNote', { n: LIMITS.batch }), 'info'),
      table([t('address'), t('flowHop'), t('flowStatus'), t('flowData'), ''], rows, { cls: 'flow-nodes' }),
      pager(nodePage, list.length, (p) => { nodePage = p; renderNodes(); }));
  }

  function renderTable() {
    const all = g.edges();
    tablePage = Math.min(tablePage, Math.max(0, Math.ceil(all.length / LIMITS.tablePage) - 1));
    const rows = all.slice(tablePage * LIMITS.tablePage, (tablePage + 1) * LIMITS.tablePage)
      .map((e) => [addrLink(e.from), addrLink(e.to), amountText(e), String(e.count), e.txs.length ? ui.hashLink(e.txs[0]) : '—']);
    put(tableBox, table([t('from'), t('to'), t('flowAmount'), t('flowTxCount'), t('txHash')], rows, { cls: 'flow-table' }),
      pager(tablePage, all.length, (p) => { tablePage = p; renderTable(); }));
  }

  // redraws while following: at most every 150 ms
  let pending = null;
  const schedule = () => { if (pending) return; pending = setTimeout(async () => { pending = null; await loadTokens(); if (view.isConnected) draw(); }, 150); };

  const say = (x) => { status.textContent = x; };
  async function readOlder(id, btn) {
    if (btn) btn.disabled = true;
    try { g.addTransfers(await src.older(id)); await loadTokens(); } catch (e) { say(String(e?.message ?? e)); }
    draw();
  }
  async function expandNode(id) {
    if (running) return;
    const n = g.nodes.get(id); if (!n) return;
    try {
      g.addTransfers(await src.read(id));
      let r = g.expand(id);
      // nothing new to place: read older data of this address, then try again
      if (!r.added.length && src.hasOlder(id)) { g.addTransfers(await src.older(id)); r = g.expand(id); }
      say(t('flowExpanded', { a: nodeName(id), n: r.added.length }));
    } catch (e) { say(String(e?.message ?? e)); }
    await loadTokens();
    draw();
  }
  async function startFollow() {
    if (running) return;
    running = true; stopping = false;
    followBtn.disabled = true; stopBtn.disabled = false;
    try {
      lastResult = await follow(g, {
        read: async (id) => { g.addTransfers(await src.read(id)); },
        isSink, shouldStop: () => stopping || !view.isConnected,
        onStep: (x) => { say(t('flowFollowing', { h: x.hop, n: groupDigits(x.nodes) })); schedule(); },
        pause: () => new Promise((r) => setTimeout(r, 0)),
      });
      const maxHop = Math.max(0, ...[...g.nodes.values()].map((n) => n.layer));
      say(lastResult.stopped ? t('flowStopped', { h: lastResult.hop }) : t('flowDone', { h: maxHop, n: groupDigits(g.nodes.size) }));
    } catch (e) { say(String(e?.message ?? e)); }
    running = false; followBtn.disabled = false; stopBtn.disabled = true;
    clearTimeout(pending); pending = null;
    await loadTokens();
    if (view.isConnected) draw();
  }

  await loadTokens();
  draw();
  say(t('flowReady'));
  if (new URLSearchParams(String(param ?? '').split('?')[1] ?? '').get('follow') === '1') startFollow();
}
