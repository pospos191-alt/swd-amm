// Money flow, investigator and watch list on the Neuro page. Self-contained:
// it adds its own sections, listens for the `neuro:report` event that
// app.js sends after each check, and follows the page language (<html lang>).
// Everything from the chain is written with textContent / SVG attributes,
// never innerHTML; no third-party code; no inline styles (strict CSP).
// Nothing is traced until the user asks: tracing costs dozens of requests
// to free public endpoints.
import { buildFlowGraph } from '../graph/build.js';
import { graphSupported } from '../graph/sources.js';
import { renderFlowGraph } from '../graph/view.js';
import { flowUi, flowWords, signalText } from '../graph/i18n.js';
import { createCache } from '../graph/cache.js';
import { createVerdictMemory } from '../graph/knownbad.js';
import { investigate } from '../agent/pipeline.js';
import { createWatchList, createWatcher } from '../agent/watch.js';
import { explorerUrl, explorerTxUrl, CHAINS } from '../src/chains.js';
import { LANGS } from '../src/explain.js';

const cache = createCache();
const memory = createVerdictMemory(cache);
const watchList = createWatchList();
const $ = (id) => document.getElementById(id);
const make = (tag, attrs = {}, text) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
const lang = () => (LANGS[document.documentElement.lang] ? document.documentElement.lang : 'en');
const GRAPH_LIMITS = { maxRequests: 220, timeMs: 75_000 };

let current = null; // { chain, address, report }
let shown = null;   // { kind: 'graph'|'investigation', data, chain }
let busy = false;

// ------------------------------------------------------------ sections
function buildSections() {
  const flow = make('section', { id: 'flow', class: 'flow', hidden: '' });
  flow.append(make('h2', { id: 'flow-title' }), make('p', { id: 'flow-intro', class: 'flow-intro' }));
  const actions = make('div', { class: 'flow-actions' });
  actions.append(make('button', { id: 'flow-go', type: 'button' }), make('button', { id: 'flow-investigate', type: 'button', class: 'secondary' }), make('button', { id: 'flow-follow', type: 'button', class: 'secondary' }));
  flow.append(actions, make('p', { id: 'flow-status', class: 'flow-status', role: 'status', 'aria-live': 'polite' }),
    make('ul', { id: 'flow-steps', class: 'flow-steps' }), make('ul', { id: 'flow-signals', class: 'flow-signals' }),
    make('div', { id: 'flow-graph', class: 'flow-graph' }), make('dl', { id: 'flow-detail', class: 'flow-detail', hidden: '' }), make('ul', { id: 'flow-legend', class: 'flow-legend' }));
  const anchor = $('disclaimer');
  if (anchor) anchor.before(flow); else $('result')?.append(flow);

  const watch = make('section', { id: 'watch', class: 'watch', hidden: '' });
  watch.append(make('h2', { id: 'watch-title' }), make('p', { id: 'watch-note', class: 'watch-note' }), make('ul', { id: 'watch-list', class: 'watch-list' }));
  const footer = document.querySelector('footer');
  if (footer) footer.before(watch); else document.body.append(watch);

  $('flow-go').addEventListener('click', () => trace());
  $('flow-investigate').addEventListener('click', () => runInvestigation());
  $('flow-follow').addEventListener('click', () => {
    if (!current) return;
    if (watchList.has(current.chain, current.address)) watchList.unfollow(current.chain, current.address); else watchList.follow(current.chain, current.address);
    renderStatic(); renderWatch();
  });
}

function status(text, error = false) { $('flow-status').textContent = text; $('flow-status').className = `flow-status${error ? ' error' : ''}`; }

function renderStatic() {
  const ui = flowUi(lang());
  $('flow-title').textContent = ui.title;
  $('flow-intro').textContent = ui.intro;
  $('flow-go').textContent = ui.trace;
  $('flow-investigate').textContent = ui.investigate;
  $('flow-follow').textContent = current && watchList.has(current.chain, current.address) ? ui.unfollow : ui.follow;
  $('watch-title').textContent = ui.watchTitle;
  $('watch-note').textContent = ui.watchNote;
  const W = flowWords(lang());
  $('flow-legend').replaceChildren(...['token', 'deployer', 'funder', 'hub', 'cluster-source', 'pool', 'lp-receiver', 'prior', 'flagged']
    .map((r) => make('li', { class: r === 'flagged' ? 'flagged' : `r-${r}` }, W.ROLE[r])));
  $('flow-legend').hidden = !shown;
}

// ------------------------------------------------------------ results
const safeLink = (u) => (u && u.startsWith('https://') ? u.replace(/[<>"'`\s]/g, (c) => encodeURIComponent(c)) : null);

function evidenceLine(chain, ev) {
  const small = make('small');
  small.textContent = `${flowUi(lang()).evidence}: ${(ev ?? []).slice(0, 4).map((e) => e.value).join(' · ')}`;
  return small;
}

function renderSignals(list, chain) {
  const ui = flowUi(lang());
  const items = list.filter((s) => s.severity !== 'info' || !s.source || s.source === 'graph');
  if (!items.length) { $('flow-signals').replaceChildren(make('li', { class: 'good' }, ui.none)); return; }
  $('flow-signals').replaceChildren(...items.map((s) => {
    const li = make('li', { class: s.severity });
    const words = !s.source || s.source === 'graph' ? signalText(s, lang())
      : s.source === 'ml' ? `ML: ${Math.round((s.params?.score ?? 0) * 100)}%`
        : (LANGS[lang()].T[s.id] ?? LANGS.en.T[s.id] ?? (() => s.id))(s.params ?? {});
    li.append(words);
    if (s.evidence?.length) li.append(evidenceLine(chain, s.evidence));
    return li;
  }));
}

function renderDetail(node, edges, chain) {
  const ui = flowUi(lang());
  const W = flowWords(lang());
  const dl = $('flow-detail');
  dl.replaceChildren();
  const row = (k, v) => { dl.append(make('dt', {}, k)); const dd = make('dd'); if (v instanceof Node) dd.append(v); else dd.textContent = v; dl.append(dd); };
  row(ui.selected, node.id);
  row(ui.role, node.roles.map((r) => W.ROLE[r] ?? r).join(', ') + (node.flagged ? ` · ${W.ROLE.flagged}` : ''));
  const link = safeLink(/^0x[0-9a-f]{40}$/.test(node.id) || CHAINS[chain]?.kind !== 'evm' ? explorerUrl(chain, node.id) : null);
  if (link) { const a = make('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, ui.explorer); row(ui.explorer, a); }
  for (const e of edges.slice(0, 8)) {
    const other = e.from === node.id ? `→ ${e.to}` : `← ${e.from}`;
    const txUrl = e.tx ? safeLink(explorerTxUrl(chain, e.tx)) : null;
    const dd = make('span', {}, `${other}${e.tx ? ' · ' : ''}`);
    if (e.tx) { if (txUrl) dd.append(make('a', { href: txUrl, target: '_blank', rel: 'noopener noreferrer' }, e.tx)); else dd.append(e.tx); }
    row(W.EDGE[e.kind] ?? e.kind, dd);
  }
  dl.hidden = false;
}

function renderGraph(graph, chain) {
  const ui = flowUi(lang());
  $('flow-detail').hidden = true;
  if (!graph?.nodes?.length) { $('flow-graph').replaceChildren(); return; }
  renderFlowGraph($('flow-graph'), graph, { lang: lang(), label: ui.graphLabel, onSelect: (n, e) => renderDetail(n, e, chain) });
}

function renderShown() {
  renderStatic();
  if (!shown) return;
  const ui = flowUi(lang());
  const W = flowWords(lang());
  if (shown.kind === 'graph') {
    const g = shown.data;
    $('flow-steps').replaceChildren();
    renderSignals(g.signals, shown.chain);
    renderGraph(g, shown.chain);
    status(`${g.partial ? `${ui.partial} · ` : ''}${g.stats.requests} ${ui.requests}`);
  } else {
    const r = shown.data;
    $('flow-steps').replaceChildren(...r.steps.map((s) => make('li', {}, `${W.STEP[s.name] ?? s.name}: ${W.STATUS[s.status] ?? s.status}`)),
      make('li', {}, `${ui.confidence}: ${Math.round(r.confidence * 100)}%`));
    renderSignals(r.signals.filter((s) => s.source !== 'rules'), shown.chain); // rule findings are already listed above
    renderGraph(r.graph, shown.chain);
    status(r.graph?.partial ? ui.partial : '');
  }
}

// ------------------------------------------------------------ actions
async function trace() {
  if (!current || busy) return;
  const { chain, address } = current;
  busy = true; $('flow-go').disabled = true; $('flow-investigate').disabled = true;
  status(flowUi(lang()).tracing);
  try {
    const g = await buildFlowGraph(chain, address, { cache, memory, ...GRAPH_LIMITS, onProgress: (s) => status(`${flowUi(lang()).tracing} (${s})`) });
    if (current?.address !== address) return;
    shown = { kind: 'graph', data: g, chain };
    renderShown();
  } catch (e) {
    status(flowUi(lang()).failed + String(e?.message ?? e).slice(0, 160), true);
  } finally {
    busy = false; $('flow-go').disabled = false; $('flow-investigate').disabled = false;
  }
}

async function runInvestigation() {
  if (!current || busy) return;
  const { chain, address, report } = current;
  busy = true; $('flow-go').disabled = true; $('flow-investigate').disabled = true;
  const W = flowWords(lang());
  try {
    const r = await investigate({ chain, address }, {
      report, graphOptions: { cache, memory, ...GRAPH_LIMITS },
      onStep: (s, st) => status(`${W.STEP[s] ?? s}: ${W.STATUS[st] ?? '…'}`),
    });
    if (current?.address !== address) return;
    if (r.level === 'high') memory.remember(chain, address, { level: 'high', ref: r.reportHash });
    shown = { kind: 'investigation', data: r, chain };
    renderShown();
  } catch (e) {
    status(flowUi(lang()).failed + String(e?.message ?? e).slice(0, 160), true);
  } finally {
    busy = false; $('flow-go').disabled = false; $('flow-investigate').disabled = false;
  }
}

// ------------------------------------------------------------ watch list
const watcher = createWatcher({
  list: watchList,
  isVisible: () => document.visibilityState !== 'hidden',
  investigate: async (item) => {
    const r = await investigate({ chain: item.chain, address: item.address }, { graphOptions: { cache, memory, maxRequests: 150, timeMs: 60_000 } });
    if (r.level === 'high') memory.remember(item.chain, item.address, { level: 'high', ref: r.reportHash });
    return r;
  },
  onChange: () => renderWatch(),
});

function renderWatch() {
  const ui = flowUi(lang());
  const items = watchList.list();
  $('watch').hidden = !items.length;
  if (!items.length) { $('watch-list').replaceChildren(make('li', {}, ui.watchEmpty)); return; }
  const levels = LANGS[lang()].LEVEL ?? LANGS.en.LEVEL;
  $('watch-list').replaceChildren(...items.map((x) => {
    const li = make('li');
    li.append(make('span', { class: 'addr' }, `${CHAINS[x.chain]?.name ?? x.chain} · ${x.address}`));
    const buttons = make('span', { class: 'watch-buttons' });
    const check = make('button', { type: 'button' }, ui.checkNow);
    check.addEventListener('click', async () => { check.disabled = true; try { await watcher.checkNow(x.key); } catch { /* shown as not updated */ } check.disabled = false; renderWatch(); });
    const drop = make('button', { type: 'button' }, ui.unfollow);
    drop.addEventListener('click', () => { watchList.unfollow(x.chain, x.address); renderWatch(); renderStatic(); });
    buttons.append(check, drop);
    li.append(buttons);
    const meta = make('span', { class: 'meta' });
    if (x.level) meta.append(make('span', { class: `lvl-${x.level}` }, `${levels[x.level] ?? x.level}`), ` · ${ui.confidence} ${Math.round((x.confidence ?? 0) * 100)}% · `);
    meta.append(`${ui.lastChecked}: ${x.checked ? new Date(x.checked).toLocaleString(lang()) : ui.notYet}`);
    if (x.worse) meta.append(' · ', make('span', { class: 'worse' }, ui.worse));
    li.append(meta);
    return li;
  }));
}

// ------------------------------------------------------------ wiring
buildSections();
document.addEventListener('neuro:report', (ev) => {
  const { chain, address, report } = ev.detail ?? {};
  if (!chain || !address || report?.kind === 'tx') { $('flow').hidden = true; current = null; return; }
  current = { chain, address, report };
  shown = null;
  $('flow-signals').replaceChildren(); $('flow-steps').replaceChildren(); $('flow-graph').replaceChildren(); $('flow-detail').hidden = true;
  const supported = graphSupported(chain);
  $('flow-go').hidden = !supported;
  status(supported ? '' : flowUi(lang()).unsupported);
  $('flow').hidden = false;
  if (report?.analysis?.level === 'high') memory.remember(chain, address, { level: 'high', ref: report.reportHash });
  renderStatic();
});
// Another panel (e.g. a wallet's holdings) can ask to follow tokens.
document.addEventListener('neuro:follow', (ev) => {
  const { chain, address } = ev.detail ?? {};
  if (typeof chain === 'string' && typeof address === 'string' && CHAINS[chain] && address.length <= 128) { watchList.follow(chain, address); renderWatch(); renderStatic(); }
});
new MutationObserver(() => { renderShown(); renderWatch(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
renderStatic();
renderWatch();
watcher.start();
