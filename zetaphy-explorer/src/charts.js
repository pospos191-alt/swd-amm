// Home page analytics over the scanned blocks, drawn here as inline SVG (no
// library, no inline styles: colours come from classes in style.css, which the
// CSP allows). Every chart has an aria-label with its range and a data table
// behind "Show the numbers". Data: block metas (time, tx count), the scanned
// txs (user txs per block, most active addresses) and one eth_feeHistory call
// (base fee and gas used ratio per block). Data shaping is pure and unit-tested.
import { h, append } from './dom.js';
import { anyAddressLower, groupDigits, formatUnits } from './format.js';

const SVG = 'http://www.w3.org/2000/svg';
export const ANALYTICS_MAX_BLOCKS = 100; // also eth_feeHistory's usual cap (feehistory-cap 100)

/** Block metas -> [{ height, time (ms), txs, dt (s since the previous block, null for the first) }], oldest first. */
export function blockSeries(metas) {
  const rows = (metas ?? []).map((m) => ({ height: Number(m?.header?.height), time: Date.parse(m?.header?.time), txs: Number(m?.num_txs ?? 0) || 0 }))
    .filter((r) => Number.isSafeInteger(r.height) && r.height > 0)
    .sort((a, b) => a.height - b.height);
  const seen = new Set(); const out = [];
  for (const r of rows) {
    if (seen.has(r.height)) continue;
    seen.add(r.height);
    const prev = out[out.length - 1];
    const dt = prev && prev.height === r.height - 1 && Number.isFinite(r.time) && Number.isFinite(prev.time) ? Math.max(0, (r.time - prev.time) / 1000) : null;
    out.push({ ...r, dt });
  }
  return out;
}

/** User txs per block in [from, to] (certificates are already left out of the scan): [{ height, count }]. */
export function txsPerBlock(txs, from, to) {
  const lo = Number(from); const hi = Number(to);
  if (!(hi >= lo) || hi - lo > 100000) return [];
  const counts = new Map();
  for (const x of txs ?? []) { const n = Number(x.height); if (n >= lo && n <= hi) counts.set(n, (counts.get(n) ?? 0) + 1); }
  const out = [];
  for (let n = lo; n <= hi; n++) out.push({ height: n, count: counts.get(n) ?? 0 });
  return out;
}

/** eth_feeHistory result -> [{ height, baseFeeGwei, gasRatio (0..1) }]. */
export function feeSeries(fh) {
  let oldest;
  try { oldest = Number(BigInt(fh?.oldestBlock)); } catch { return []; }
  const ratios = Array.isArray(fh?.gasUsedRatio) ? fh.gasUsedRatio : [];
  const fees = Array.isArray(fh?.baseFeePerGas) ? fh.baseFeePerGas : [];
  return ratios.map((r, i) => {
    let fee = null;
    try { fee = Number(formatUnits(BigInt(fees[i]), 9, { maxFrac: 6, group: false })); } catch { fee = null; }
    const ratio = Number(r);
    return { height: oldest + i, baseFeeGwei: Number.isFinite(fee) ? fee : null, gasRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : null };
  });
}

/** The most active addresses in the scanned txs (sender or receiver; one count per tx each): [{ address (lower 0x), count }]. */
export function topAddresses(txs, n = 8) {
  const counts = new Map();
  for (const x of txs ?? []) {
    const seen = new Set([anyAddressLower(x.from), anyAddressLower(x.to)].filter(Boolean));
    for (const a of seen) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return [...counts].map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count || (a.address < b.address ? -1 : 1)).slice(0, n);
}

/** { min, max, avg } of the finite numbers (null when there are none). */
export function summary(values) {
  const v = (values ?? []).filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length };
}

/** Bar geometry in a W×H box: [{ x, y, w, h }] for values (0 at the bottom). */
export function bars(values, W, H, { gap = 1 } = {}) {
  const n = values.length;
  if (!n) return [];
  const max = Math.max(0, ...values.filter((x) => Number.isFinite(x)));
  const bw = W / n;
  return values.map((v, i) => {
    const hh = max > 0 && Number.isFinite(v) ? (Math.max(0, v) / max) * H : 0;
    return { x: +(i * bw).toFixed(2), y: +(H - hh).toFixed(2), w: +Math.max(0.5, bw - gap).toFixed(2), h: +hh.toFixed(2) };
  });
}

const svgEl = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null) el.setAttribute(k, String(v));
  for (const c of children) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

const fmt = (x, digits = 2) => (Number.isFinite(x) ? (Math.round(x * 10 ** digits) / 10 ** digits).toString() : '—');

/**
 * A bar chart with its data table: points [{ label (x, e.g. a height), value }].
 * t: the page's text function; title and unit are already translated.
 */
export function barChart(t, { id, title, unit = '', points, digits = 2, cls = '' }) {
  const W = 600; const H = 140; const PAD = 4;
  const values = points.map((p) => p.value);
  const s = summary(values);
  const first = points[0]?.label; const last = points[points.length - 1]?.label;
  const label = s ? t('chartAria', { title, from: first, to: last, min: fmt(s.min, digits), max: fmt(s.max, digits), avg: fmt(s.avg, digits), unit }) : `${title}: ${t('none')}`;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H + 18}`, role: 'img', 'aria-labelledby': `${id}-title`, class: ['chart-svg', cls].join(' ').trim(), preserveAspectRatio: 'none' },
    svgEl('title', { id: `${id}-title` }, label),
    svgEl('line', { x1: 0, y1: H + PAD / 2, x2: W, y2: H + PAD / 2, class: 'chart-axis' }),
    ...bars(values, W, H - PAD).map((b, i) => svgEl('rect', { x: b.x, y: b.y + PAD, width: b.w, height: b.h, class: 'chart-bar' },
      svgEl('title', null, `${points[i].label}: ${fmt(points[i].value, digits)}${unit ? ' ' + unit : ''}`))),
    svgEl('text', { x: 0, y: H + 16, class: 'chart-text' }, String(first ?? '')),
    svgEl('text', { x: W, y: H + 16, class: 'chart-text chart-text-end' }, String(last ?? '')));
  return h('figure', { class: 'chart', id },
    h('figcaption', null, h('strong', null, title), s ? h('span', { class: 'small dim' }, ` · ${t('chartRange', { min: fmt(s.min, digits), avg: fmt(s.avg, digits), max: fmt(s.max, digits) })}${unit ? ' ' + unit : ''}`) : null),
    svg,
    h('details', { class: 'chart-data' }, h('summary', null, t('chartTable')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'compact' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('block')), h('th', { scope: 'col' }, unit ? `${title} (${unit})` : title))),
        h('tbody', null, points.map((p) => h('tr', null, h('td', null, String(p.label)), h('td', null, fmt(p.value, digits)))))))));
}

/** Horizontal bars for the most active addresses (names are links made by the app). */
function topChart(t, ctx, rows) {
  const W = 600; const RH = 22;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const label = t('chartTopAria', { n: rows.length, list: rows.map((r) => `${r.address.slice(0, 10)}… ${r.count}`).join(', ') });
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${Math.max(RH, rows.length * RH)}`, role: 'img', 'aria-labelledby': 'chart-top-title', class: 'chart-svg chart-hbar', preserveAspectRatio: 'none' },
    svgEl('title', { id: 'chart-top-title' }, label),
    ...rows.map((r, i) => svgEl('rect', { x: 0, y: i * RH + 3, width: +((r.count / max) * W).toFixed(2), height: RH - 6, class: 'chart-bar' }, svgEl('title', null, `${r.address}: ${r.count}`))));
  return h('figure', { class: 'chart', id: 'chart-top' },
    h('figcaption', null, h('strong', null, t('chartTop'))),
    svg,
    ctx.table([t('address'), t('chartTxCount')], rows.map((r) => [ctx.addrLink(r.address), groupDigits(r.count)])));
}

/**
 * The analytics card: metas of the last blocks, the scan result r (recentTxs) and
 * eth_feeHistory (null when the node does not answer it).
 */
export function analyticsView(ctx, { metas, r, fh }) {
  const { t } = ctx;
  const series = blockSeries(metas);
  const from = series[0]?.height ?? Number(r.from); const to = series[series.length - 1]?.height ?? Number(r.to);
  const per = txsPerBlock(r.txs, from, to);
  const times = series.filter((x) => x.dt != null);
  const fees = feeSeries(fh).filter((x) => x.height >= from && x.height <= to);
  const top = topAddresses(r.txs.filter((x) => Number(x.height) >= from), 8);
  const grid = h('div', { class: 'chart-grid' },
    barChart(t, { id: 'chart-txs', title: t('chartTxs'), points: per.map((p) => ({ label: p.height, value: p.count })), digits: 2 }),
    barChart(t, { id: 'chart-time', title: t('chartBlockTime'), unit: t('chartSeconds'), points: times.map((p) => ({ label: p.height, value: p.dt })), digits: 2 }),
    fees.length ? barChart(t, { id: 'chart-gas', title: t('chartGas'), unit: '%', points: fees.map((p) => ({ label: p.height, value: p.gasRatio == null ? null : p.gasRatio * 100 })), digits: 2 }) : null,
    fees.length ? barChart(t, { id: 'chart-fee', title: t('chartBaseFee'), unit: 'gwei', points: fees.map((p) => ({ label: p.height, value: p.baseFeeGwei })), digits: 4, cls: 'chart-alt' }) : null,
    top.length ? topChart(t, ctx, top) : null);
  const out = h('div', null, grid);
  append(out, fees.length ? null : ctx.note(t('chartNoFees')), ctx.note(t('chartNote', { n: groupDigits(to - from + 1), from: groupDigits(from), to: groupDigits(to) })));
  return out;
}
