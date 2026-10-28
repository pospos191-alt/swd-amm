// Draws a money-flow graph as inline SVG with DOM calls only (no innerHTML,
// no third-party code, no inline styles: the page's CSP allows neither).
// Layout is fixed, not physics: columns by role (funding trail on the left,
// the contract in the middle, receivers and liquidity on the right), so the
// same graph always draws the same way. Every node is focusable (Tab) and
// opens with Enter / Space or a click; the caller shows the details.
import { flowWords, short } from './i18n.js';

const NS = 'http://www.w3.org/2000/svg';
const COL_W = 150;
const ROW_H = 40;
const PAD = 30;
const R = 11;

// Which column a role sits in (relative to the contract); the first role a node has wins, in this order.
const ROLE_ORDER = ['token', 'deployer', 'factory', 'pool', 'prior', 'receiver', 'lp-provider', 'lp-receiver', 'cluster-source', 'hub', 'funder'];

function columnOf(n, deployerSide) {
  const role = ROLE_ORDER.find((r) => n.roles.includes(r)) ?? n.roles[0];
  switch (role) {
    case 'token': return 0;
    case 'deployer': case 'factory': case 'prior': return -1;
    case 'pool': case 'receiver': case 'lp-provider': return 1;
    case 'lp-receiver': return 2;
    default: // funders, hubs, shared funders
      return deployerSide.has(n.id) ? -1 - Math.min(n.hop ?? 1, 3) : 2 + Math.min((n.hop ?? 1) - 1, 1);
  }
}

/** Positions per node id: { x, y, col }. Exported for tests. */
export function layout(graph) {
  const deployerSide = new Set();
  const dep = graph.nodes.find((n) => n.roles.includes('deployer'))?.id;
  // Everything that funded the deployer (following "funded" edges backwards).
  const fundedBy = new Map();
  for (const e of graph.edges) if (e.kind === 'funded') { if (!fundedBy.has(e.to)) fundedBy.set(e.to, []); fundedBy.get(e.to).push(e.from); }
  const stack = dep ? [dep] : [];
  while (stack.length) { const a = stack.pop(); for (const f of fundedBy.get(a) ?? []) if (!deployerSide.has(f)) { deployerSide.add(f); stack.push(f); } }

  const cols = new Map();
  for (const n of graph.nodes) {
    const c = columnOf(n, deployerSide);
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c).push(n);
  }
  const keys = [...cols.keys()].sort((a, b) => a - b);
  const minCol = keys[0] ?? 0;
  const tallest = Math.max(1, ...[...cols.values()].map((l) => l.length));
  const pos = new Map();
  for (const c of keys) {
    const list = cols.get(c).sort((a, b) => ROLE_ORDER.indexOf(a.roles[0]) - ROLE_ORDER.indexOf(b.roles[0]) || (a.id < b.id ? -1 : 1));
    const offset = ((tallest - list.length) * ROW_H) / 2;
    list.forEach((n, i) => pos.set(n.id, { x: PAD + (c - minCol) * COL_W + COL_W / 2, y: PAD + offset + i * ROW_H + R, col: c }));
  }
  const width = PAD * 2 + keys.length * COL_W;
  const height = PAD * 2 + tallest * ROW_H;
  return { pos, width, height };
}

const el = (name, attrs = {}, parent = null) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.append(e);
  return e;
};

/**
 * Renders into `container` (replacing its children). Returns { svg, select(id) }.
 * @param {HTMLElement} container
 * @param {{nodes, edges}} graph
 * @param {{lang?: string, onSelect?: (node, edges) => void}} [opts]
 */
export function renderFlowGraph(container, graph, { lang = 'en', onSelect = () => {}, label = '' } = {}) {
  const W = flowWords(lang);
  const { pos, width, height } = layout(graph);
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'flow-svg', role: 'group', 'aria-label': label, width, height });
  const defs = el('defs', {}, svg);
  const marker = el('marker', { id: 'flow-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, defs);
  el('path', { d: 'M0 0L10 5L0 10z', class: 'flow-arrowhead' }, marker);

  const edgeLayer = el('g', { class: 'flow-edges' }, svg);
  const nodeLayer = el('g', { class: 'flow-nodes' }, svg);
  const edgeEls = [];
  for (const e of graph.edges) {
    const a = pos.get(e.from); const b = pos.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x; const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const [x1, y1, x2, y2] = [a.x + (dx / len) * R, a.y + (dy / len) * R, b.x - (dx / len) * (R + 2), b.y - (dy / len) * (R + 2)];
    const bend = a.col === b.col ? 40 : 0; // same column: curve out so it does not hide nodes
    const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${((x1 + x2) / 2 + bend).toFixed(1)} ${((y1 + y2) / 2).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    const p = el('path', { d, class: `flow-edge k-${e.kind}`, 'marker-end': 'url(#flow-arrow)' }, edgeLayer);
    const t = el('title', {}, p);
    t.textContent = `${W.EDGE[e.kind] ?? e.kind}${e.tx ? ` · ${e.tx}` : ''}`;
    edgeEls.push({ e, p });
  }

  const nodeEls = new Map();
  for (const n of graph.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const role = ROLE_ORDER.find((r) => n.roles.includes(r)) ?? n.roles[0];
    const roleText = n.roles.map((r) => W.ROLE[r] ?? r).join(', ');
    const g = el('g', { class: `flow-node r-${role}${n.flagged ? ' flagged' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${roleText}: ${n.id}${n.flagged ? ` · ${W.ROLE.flagged}` : ''}`, transform: `translate(${p.x} ${p.y})` }, nodeLayer);
    el('circle', { r: R, class: 'flow-dot' }, g);
    if (n.flagged) el('circle', { r: R + 4, class: 'flow-ring' }, g);
    const text = el('text', { y: R + 12, 'text-anchor': 'middle', class: 'flow-label' }, g);
    text.textContent = role === 'token' ? W.ROLE.token : short(n.id);
    const title = el('title', {}, g);
    title.textContent = `${roleText}\n${n.id}`;
    nodeEls.set(n.id, g);
  }

  function select(id) {
    const linked = graph.edges.filter((e) => e.from === id || e.to === id);
    for (const { e, p } of edgeEls) p.classList.toggle('on', e.from === id || e.to === id);
    for (const [nid, g] of nodeEls) g.classList.toggle('sel', nid === id);
    svg.classList.toggle('has-sel', !!id);
    const node = graph.nodes.find((n) => n.id === id);
    if (node) onSelect(node, linked);
  }
  for (const [id, g] of nodeEls) {
    g.addEventListener('click', () => select(id));
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(id); } });
  }
  container.replaceChildren(svg);
  return { svg, select };
}
