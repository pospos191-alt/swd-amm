// The hub's data pages (like a chain explorer's): Earn, Mine (mine.js), Analytics, DeFi, Leaderboard, Developers.
// Each page: render(root, ctx) draws it once; refresh(ctx) (optional) updates live numbers.
// ctx = { T, lang, ep(), cfg, getJson, evmCall, el, short, formatZeta, show, copyBtn, account(), connect(), send(to, data) }
import { formatZeta, toEvm, toBech32, bech32Decode, parseUnits, formatUnits, encodeIbcTransfer, sentIbcTransfer, PRECOMPILES } from './chainlib.js';
import { withFallback } from './i18n.js';
import { EARN, EARN_METHODS, SAPHAN } from './pages-i18n.js';
import mine, { mineAddress } from './mine.js';

/** The Earn words in ctx.lang (English underneath), with each method's commands, icon and tab. */
const earnText = (ctx) => {
  const L = withFallback(EARN, ctx.lang);
  return { ...L, m: EARN_METHODS.map((x) => ({ ...x, ...L.m[x.id], steps: L.m[x.id].steps.map((t, i) => [t, x.cmds[i]]) })) };
};
const saphanText = (ctx) => withFallback(SAPHAN, ctx.lang);

// ------------------------------------------------------------------ eth_call helpers (selectors = keccak256, checked in tests)
export const SEL = {
  allPairsLength: '0x574f2ba3', allPairs: '0x1e3dd18b', token0: '0x0dfe1681', token1: '0xd21220a7', getReserves: '0x0902f1ac',
  symbol: '0x95d89b41', decimals: '0x313ce567', workerBond: '0x299f3d98', activeWorkers: '0x3da383ca', rewardPool: '0x66666aa9',
  totalActiveBond: '0x616b8ea8', jobCount: '0x4c5d8a0f',
};
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const call = (ctx, to, data) => ctx.evmCall('eth_call', [{ to, data }, 'latest']);
const uintAt = (hex, i = 0) => BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'}`);
const addrAt = (hex, i = 0) => `0x${hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`;
/** ABI string (or bytes32 fallback) -> text, at most 32 printable characters. */
export function decodeString(hex) {
  const h = String(hex).replace(/^0x/, '');
  let bytes;
  if (h.length >= 128 && BigInt(`0x${h.slice(0, 64)}`) === 32n) {
    const len = Number(BigInt(`0x${h.slice(64, 128)}`));
    bytes = h.slice(128, 128 + Math.min(len, 64) * 2);
  } else bytes = h.slice(0, 64).replace(/(00)+$/, '');
  const txt = (bytes.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join('');
  return txt.replace(/[^\x20-\x7e]/g, '').slice(0, 32) || '?';
}

// ------------------------------------------------------------------ small pieces
const code = (ctx, text) => ctx.el('div', { class: 'code' }, ctx.el('pre', { class: 'mono', text }), ctx.copyBtn(text));
const tile = (ctx, label, tipKey, id) => ctx.el('div', { class: 'stat', 'data-tip-key': tipKey, tabindex: 0 },
  ctx.el('span', { class: 'k', text: ctx.T(label) }), ctx.el('span', { class: 'v mono', id, text: '–' }));
const setText = (id, t) => { const n = document.getElementById(id); if (n) n.textContent = t; };

/** A one-hue column chart in SVG, with a hover tooltip per bar (title + data-tip). */
export function columns(ctx, values, { height = 150, fmt = (v) => String(v), label = (i) => String(i) } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 600, H = height, pad = { l: 34, r: 6, t: 8, b: 18 };
  const max = Math.max(1, ...values);
  const bw = (W - pad.l - pad.r) / Math.max(1, values.length);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  for (const f of [0, 0.5, 1]) {
    const y = pad.t + (H - pad.t - pad.b) * (1 - f);
    svg.append(mk('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'grid' }));
    const t = mk('text', { x: pad.l - 6, y: y + 4, class: 'axis', 'text-anchor': 'end' }); t.textContent = fmt(max * f); svg.append(t);
  }
  values.forEach((v, i) => {
    const h = Math.max(v > 0 ? 2 : 0, (H - pad.t - pad.b) * (v / max));
    const x = pad.l + i * bw + 1, y = H - pad.b - h, w = Math.max(1, bw - 2);
    svg.append(mk('rect', { x, y: pad.t, width: w, height: H - pad.t - pad.b, class: 'hit', 'data-tip': `${label(i)}: ${fmt(v)}` }));
    svg.append(mk('path', { d: `M${x},${H - pad.b} V${y + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, w / 2)},-${Math.min(4, h)} H${x + w - Math.min(4, w / 2)} q${Math.min(4, w / 2)},0 ${Math.min(4, w / 2)},${Math.min(4, h)} V${H - pad.b} Z`, class: 'bar', 'pointer-events': 'none' }));
  });
  return svg;
}
/** Horizontal one-hue bars with the label and value as text (no legend needed: one series). */
export function hbars(ctx, rows, { fmt = (v) => String(v) } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return ctx.el('div', { class: 'hbars' }, rows.map((r) => ctx.el('div', { class: 'hbar', 'data-tip': r.tip ?? `${r.label}: ${fmt(r.value)}` },
    ctx.el('span', { class: 'hb-label', text: r.label }),
    ctx.el('span', { class: 'hb-track' }, ctx.el('span', { class: 'hb-fill', style: null, 'data-w': String(Math.round((r.value / max) * 1000) / 10) })),
    ctx.el('span', { class: 'hb-val mono', text: fmt(r.value) }))));
}
// widths are set from data-w (no inline style attribute: the CSP allows only this site's style files)
export const sizeBars = (root) => root.querySelectorAll('.hb-fill[data-w]').forEach((n) => { n.style.width = `${n.dataset.w}%`; });

// ------------------------------------------------------------------ Earn
const EARN_ICONS = {
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  stake: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
  swap: '<path d="M7 7h12l-3-3"/><path d="M17 17H5l3 3"/>',
  pick: '<path d="M3 9c4-5 13-6 18-2"/><path d="M12 6l-5 15"/>',
};

/**
 * Asks the node's faucet (zetaphy_faucet) for `address`. Resolves { txHash } or rejects with an Error whose
 * `down` is true when the node cannot be reached (paused, offline, or a gateway error) and false when the node
 * answered with its own reason (already funded, daily limit, …), which is then the message.
 */
export async function askFaucet(rpcUrl, address, fetchFn = fetch) {
  const down = (m) => Object.assign(new Error(m), { down: true });
  let r;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    r = await fetchFn(rpcUrl, { method: 'POST', cache: 'no-store', credentials: 'omit', signal: ctl.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'zetaphy_faucet', params: [address] }) });
  } catch (e) { throw down(e?.message || 'unreachable'); } finally { clearTimeout(t); }
  let j = null;
  try { j = await r.json(); } catch { /* not JSON: a proxy or gateway page */ }
  if (j?.error) throw Object.assign(new Error(String(j.error.message || 'error').slice(0, 300)), { down: false });
  if (!r.ok || !j) throw down(`HTTP ${r.status}`);
  return { txHash: typeof j.result?.txHash === 'string' ? j.result.txHash : '' };
}

/** The faucet form of the Earn page's Faucet card: address (the connected wallet's, if any) and Get. */
function faucetForm(ctx, L) {
  const out = ctx.el('p', { class: 'msg', id: 'ef-msg', role: 'status', 'aria-live': 'polite' });
  const say = (text, cls = '') => { out.textContent = text; out.className = `msg ${cls}`; };
  const input = ctx.el('input', { id: 'ef-addr', class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: '0x… / zetaphy1…', 'aria-label': L.fAddr, value: ctx.account?.() ?? null });
  const btn = ctx.el('button', { type: 'submit', class: 'btn', id: 'ef-get', text: L.fGet });
  const form = ctx.el('form', { class: 'row ef-form', id: 'ef-form', autocomplete: 'off' }, input, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!mineAddress(raw)) { say(L.fBad, 'bad'); return; }
    btn.disabled = true;
    say('…');
    try {
      const { txHash } = await askFaucet(ctx.ep().evm, raw);
      say(L.fOk, 'ok');
      if (/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        out.append(' · ', ctx.el('a', { href: `explorer/#/tx/${txHash}`, class: 'mono', 'data-tip': txHash, text: `${L.fTx} ${ctx.short(txHash, 10, 6)}`,
          onclick: (ev) => { ev.preventDefault(); ctx.show('explorer', { hash: `#/tx/${txHash}` }); } }));
      }
    } catch (err) { say(err.down ? L.fDown : err.message, 'bad'); }
    btn.disabled = false;
  });
  return ctx.el('div', { class: 'ef' }, ctx.el('label', { for: 'ef-addr', class: 'dim small', text: L.fAddr }), form, out);
}
// The Earn page: one tab per way to get coins, easiest first. Each tab: short chips (get / need / time, the long
// text on each chip's "i"), then the steps beside the one action (two columns on wide screens); terminal commands
// come second. "Run a validator" shows the validator guide itself (validators.html, its own tabs and texts) in a
// frame that grows to the guide's height (the guide posts it), so the page scrolls as one and there is one copy.
export const EARN_TABS = ['faucet', 'mine', 'validator', 'stake', 'lp', 'runner'];
let earnSel = 'faucet', bondText = 'BOND', runnerStats = null, guideHeard = false;
function earnFill(ctx, s) {
  const host = new URL(ctx.ep().evm).host;
  return s.replaceAll('https://RPC', ctx.ep().evm).replaceAll('JOBS', ctx.cfg.contracts?.neuroJobs ?? '0x…').replaceAll('HOST', host).replaceAll('BOND', bondText);
}
const steps = (ctx, m, cls = 'howto') => ctx.el('ol', { class: cls }, m.steps.map(([text, cmd]) => ctx.el('li', {},
  ctx.el('p', { text: earnFill(ctx, text) }), cmd ? code(ctx, earnFill(ctx, cmd)) : null)));
/** The guide frame's height: validators.html?embed posts its own height (same origin only, from that frame only). */
function hearGuide() {
  if (guideHeard) return;
  guideHeard = true;
  window.addEventListener('message', (e) => {
    const f = document.getElementById('earn-guide-frame');
    if (!f || e.origin !== location.origin || e.source !== f.contentWindow) return;
    const h = Number(e.data?.zetaphyGuideHeight);
    if (Number.isFinite(h) && h > 0) f.style.height = `${Math.ceil(Math.min(h, 50_000))}px`;
  });
}
function earnDetail(ctx, root) {
  const L = earnText(ctx);
  const m = L.m.find((x) => x.id === earnSel) ?? L.m[0];
  const box = root.querySelector('.earn-detail');
  const el = ctx.el;
  const open = (tab) => el('div', { class: 'earn-cta' }, el('button', { type: 'button', class: 'btn big', id: `earn-open-${m.id}`, text: L.openIt, onclick: () => ctx.show(tab) }));
  const two = (main, side) => el('div', { class: 'earn-cols' }, el('div', { class: 'earn-main' }, main), el('div', { class: 'earn-side' }, side));
  const chip = (label, short, long) => el('span', { class: 'earn-chip' }, el('b', { text: label }), el('span', { text: short }),
    long && long !== short ? el('span', { class: 'info', tabindex: 0, 'data-tip': long, text: 'i' }) : null);
  const body = {
    faucet: () => two([faucetForm(ctx, L),
      el('div', { class: 'row wrap' }, el('button', { type: 'button', class: 'btn ghost', id: 'earn-to-mine', text: `⛏ ${L.m.find((x) => x.id === 'mine').title}`, onclick: () => ctx.show('mine') }))],
    [el('h3', { text: L.fTerminal }), steps(ctx, m)]),
    mine: () => two(steps(ctx, m), open('mine')),
    validator: () => {
      hearGuide();
      return el('iframe', { class: 'earn-guide-frame', id: 'earn-guide-frame', title: L.tabs.validator, src: `validators.html?embed=1&lang=${encodeURIComponent(ctx.lang)}#start` });
    },
    stake: () => two(steps(ctx, m), open(m.tab)),
    lp: () => two(steps(ctx, m), open(m.tab)),
    runner: () => [
      el('div', { class: 'stats three' }, tile(ctx, 'earnBond', 'tipEarnBond', 'e-bond'), tile(ctx, 'earnRunners', 'tipEarnRunners', 'e-runners'), tile(ctx, 'earnPool', 'tipEarnPool', 'e-pool')),
      steps(ctx, m, 'howto cols2')],
  }[m.id];
  box.classList.toggle('framed', m.id === 'validator');
  box.setAttribute('aria-label', earnFill(ctx, m.title));
  box.replaceChildren(
    el('div', { class: 'earn-head' },
      chip(L.get, m.getS, m.get), chip(L.need, earnFill(ctx, m.needS), earnFill(ctx, m.need)), chip(L.time, m.time),
      el('span', { class: 'pill', text: m.level }),
      m.id === 'validator' ? el('a', { class: 'small earn-ext', id: 'earn-guide', href: 'validators.html', target: '_blank', rel: 'noopener', text: L.openGuide }) : null),
    ...[body()].flat());
  if (m.id === 'runner' && runnerStats) { setText('e-bond', runnerStats[0]); setText('e-runners', runnerStats[1]); setText('e-pool', runnerStats[2]); }
  for (const n of root.querySelectorAll('.earn-tab')) {
    const on = n.dataset.id === m.id;
    n.setAttribute('aria-selected', String(on));
    n.tabIndex = on ? 0 : -1;
  }
}
function earnPick(ctx, root, id, focus = false) {
  earnSel = EARN_TABS.includes(id) ? id : 'faucet';
  earnDetail(ctx, root);
  const u = new URL(location.href);
  u.searchParams.set('way', earnSel);
  history.replaceState(history.state, '', u);
  if (focus) root.querySelector(`.earn-tab[data-id="${earnSel}"]`)?.focus();
  if (earnSel === 'runner') earn.refresh(root, ctx);
}
const earn = {
  render(root, ctx) {
    const L = earnText(ctx);
    const svg = (k) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = EARN_ICONS[k]; return s; };
    const way = new URL(location.href).searchParams.get('way');
    if (EARN_TABS.includes(way)) earnSel = way;
    const tabs = EARN_TABS.map((id) => L.m.find((x) => x.id === id));
    root.replaceChildren(
      ctx.el('div', { class: 'earn-tabs', role: 'tablist', 'aria-label': L.tabsLabel },
        tabs.map((m, i) => ctx.el('button', { type: 'button', role: 'tab', class: 'earn-tab', 'data-id': m.id, 'aria-controls': 'earn-panel',
          onclick: () => earnPick(ctx, root, m.id),
          onkeydown: (e) => {
            const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
            if (n === undefined) return;
            e.preventDefault();
            earnPick(ctx, root, tabs[(n + tabs.length) % tabs.length].id, true);
          } }, svg(EARN_METHODS.find((x) => x.id === m.id).icon), ctx.el('span', { text: L.tabs[m.id] })))),
      ctx.el('div', { class: 'card earn-detail', id: 'earn-panel', role: 'tabpanel' }),
      ctx.el('div', { class: 'earn-foot' },
        ctx.el('p', { class: 'note', 'data-tip': L.noPow, tabindex: 0, text: `⛏ ${L.whyNoPow}` }),
        ctx.el('p', { class: 'warnline small', text: L.warn })));
    earnDetail(ctx, root);
  },
  async refresh(root, ctx) {
    const jobs = ctx.cfg.contracts?.neuroJobs;
    if (!jobs) return;
    try {
      const [b, w, p] = await Promise.all([SEL.workerBond, SEL.activeWorkers, SEL.rewardPool].map((s) => call(ctx, jobs, s)));
      bondText = `${formatZeta(uintAt(b), 2)} ZETAPHY`;
      runnerStats = [formatZeta(uintAt(b), 2), uintAt(w).toString(), formatZeta(uintAt(p), 2)];
      // only the runner tab shows these: other tabs keep what the user typed (the faucet form, the guide)
      if (earnSel === 'runner') earnDetail(ctx, root);
    } catch { /* node unreachable: the steps still show */ }
  },
};

// ------------------------------------------------------------------ Analytics
const analytics = {
  render(root, ctx) {
    root.replaceChildren(
      ctx.el('div', { class: 'stats' }, tile(ctx, 'anSupply', 'tipAnSupply', 'a-supply'), tile(ctx, 'anAvgTime', 'tipBlockTime', 'a-time'),
        tile(ctx, 'anTxs', 'tipAnTxs', 'a-txs'), tile(ctx, 'anBondedPct', 'tipAnBondedPct', 'a-bonded')),
      ctx.el('div', { class: 'grid2' },
        ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('anTxsChart') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipAnTxsChart', tabindex: 0, text: 'i' })), ctx.el('div', { id: 'a-c1', class: 'chart-box' })),
        ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('anTimeChart') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipAnTimeChart', tabindex: 0, text: 'i' })), ctx.el('div', { id: 'a-c2', class: 'chart-box' })),
        ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('anAlloc') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipAnAlloc', tabindex: 0, text: 'i' })),
          hbars(ctx, [[ctx.T('alRewards'), 50], [ctx.T('alSwd'), 20], [ctx.T('alCommunity'), 15], [ctx.T('alLiquidity'), 10], [ctx.T('alTeam'), 5]].map(([label, value]) => ({ label, value })), { fmt: (v) => `${v}%` })),
        ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('anPower') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipAnPower', tabindex: 0, text: 'i' })), ctx.el('div', { id: 'a-power' }))));
    sizeBars(root);
  },
  async refresh(root, ctx) {
    try {
      const st = await ctx.getJson(`${ctx.ep().comet}/status`);
      const h = Number(st.result.sync_info.latest_block_height);
      const pages = await Promise.all([0, 1, 2].map((k) => ctx.getJson(`${ctx.ep().comet}/blockchain?minHeight=${Math.max(1, h - 20 * k - 19)}&maxHeight=${h - 20 * k}`).catch(() => null)));
      const metas = pages.flatMap((p) => p?.result?.block_metas ?? []).sort((a, b) => Number(a.header.height) - Number(b.header.height));
      if (metas.length > 1) {
        const txs = metas.map((m) => Number(m.num_txs));
        const times = metas.slice(1).map((m, i) => (Date.parse(m.header.time) - Date.parse(metas[i].header.time)) / 1000);
        const span = (Date.parse(metas.at(-1).header.time) - Date.parse(metas[0].header.time)) / 60000 || 1;
        setText('a-time', `${(times.reduce((s, x) => s + x, 0) / times.length).toFixed(1)}s`);
        setText('a-txs', (txs.reduce((s, x) => s + x, 0) / span).toFixed(2));
        const hs = metas.map((m) => Number(m.header.height));
        document.getElementById('a-c1')?.replaceChildren(columns(ctx, txs, { label: (i) => `#${hs[i]}`, fmt: (v) => String(Math.round(v)) }));
        document.getElementById('a-c2')?.replaceChildren(columns(ctx, times, { label: (i) => `#${hs[i + 1]}`, fmt: (v) => `${v.toFixed(1)}s` }));
      }
      const [sup, pool, vals] = await Promise.all([
        ctx.getJson(`${ctx.ep().rest}/cosmos/bank/v1beta1/supply/by_denom?denom=azetaphy`),
        ctx.getJson(`${ctx.ep().rest}/cosmos/staking/v1beta1/pool`),
        ctx.getJson(`${ctx.ep().rest}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200`)]);
      const supply = BigInt(sup.amount.amount), bonded = BigInt(pool.pool.bonded_tokens);
      setText('a-supply', formatZeta(supply, 0));
      setText('a-bonded', `${(Number((bonded * 10000n) / (supply || 1n)) / 100).toFixed(2)}%`);
      const total = vals.validators.reduce((s, v) => s + BigInt(v.tokens), 0n) || 1n;
      const rows = vals.validators.map((v) => ({ label: v.description?.moniker || ctx.short(v.operator_address), value: Number((BigInt(v.tokens) * 10000n) / total) / 100 }))
        .sort((a, b) => b.value - a.value).slice(0, 10);
      const box = document.getElementById('a-power');
      if (box) { box.replaceChildren(hbars(ctx, rows, { fmt: (v) => `${v.toFixed(2)}%` })); sizeBars(box); }
    } catch { /* keep the last numbers */ }
  },
};

// ------------------------------------------------------------------ DeFi
const defi = {
  render(root, ctx) {
    root.replaceChildren(
      ctx.el('div', { class: 'stats three' }, tile(ctx, 'dfPools', 'tipDfPools', 'd-pools'), tile(ctx, 'dfDlmm', 'tipDfDlmm', 'd-dlmm'), tile(ctx, 'dfJobs', 'tipDfJobs', 'd-jobs')),
      ctx.el('div', { class: 'card grow' },
        ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('dfPoolList') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipDfPoolList', tabindex: 0, text: 'i' })),
        ctx.el('div', { class: 'scroll' }, ctx.el('table', { class: 'tbl' },
          ctx.el('thead', {}, ctx.el('tr', {}, ['#', ctx.T('dfPair'), ctx.T('dfReserves'), ctx.T('dfPrice'), ''].map((t) => ctx.el('th', { text: t })))),
          ctx.el('tbody', { id: 'd-rows' }, ctx.el('tr', {}, ctx.el('td', { colspan: 5, class: 'dim', text: '…' })))))),
      ctx.el('div', { class: 'grid3' }, ['swap', 'nft', 'neuro'].map((t) => ctx.el('button', { type: 'button', class: 'card app-card', onclick: () => ctx.show(t), 'data-tip-key': `tipApp_${t}` },
        ctx.el('b', { text: ctx.T(`app_${t}`) }), ctx.el('span', { class: 'dim small', text: ctx.T(`appSub_${t}`) })))));
  },
  async refresh(root, ctx) {
    const d = ctx.cfg.dex;
    if (!d?.factory) return;
    try {
      const n = Number(uintAt(await call(ctx, d.factory, SEL.allPairsLength)));
      setText('d-pools', String(n));
      if (d.dlmmFactory) call(ctx, d.dlmmFactory, SEL.allPairsLength).then((x) => setText('d-dlmm', uintAt(x).toString())).catch(() => {});
      if (ctx.cfg.contracts?.neuroJobs) call(ctx, ctx.cfg.contracts.neuroJobs, SEL.jobCount).then((x) => setText('d-jobs', uintAt(x).toString())).catch(() => {});
      const sym = new Map(), dec = new Map();
      const token = async (a) => {
        if (!sym.has(a)) {
          const [s, de] = await Promise.all([call(ctx, a, SEL.symbol).catch(() => '0x'), call(ctx, a, SEL.decimals).catch(() => '0x12')]);
          sym.set(a, decodeString(s)); dec.set(a, Number(uintAt(de)) || 18);
        }
        return { symbol: sym.get(a), decimals: dec.get(a) };
      };
      const rows = [];
      for (let i = 0; i < Math.min(n, 30); i++) {
        const pair = addrAt(await call(ctx, d.factory, SEL.allPairs + word(i)));
        const [t0, t1, r] = await Promise.all([call(ctx, pair, SEL.token0), call(ctx, pair, SEL.token1), call(ctx, pair, SEL.getReserves)]);
        const [a, b] = await Promise.all([token(addrAt(t0)), token(addrAt(t1))]);
        const r0 = uintAt(r, 0), r1 = uintAt(r, 1);
        const fmt = (v, dp) => formatZeta(v * 10n ** BigInt(18 - Math.min(18, dp)), 2);
        const price = r0 > 0n ? Number((r1 * 10n ** BigInt(a.decimals) * 1000000n) / (r0 * 10n ** BigInt(b.decimals))) / 1e6 : 0;
        rows.push(ctx.el('tr', {},
          ctx.el('td', { class: 'dim', text: String(i + 1) }),
          ctx.el('td', { 'data-tip': pair }, ctx.el('b', { text: `${a.symbol} / ${b.symbol}` })),
          ctx.el('td', { class: 'num', text: `${fmt(r0, a.decimals)} ${a.symbol} · ${fmt(r1, b.decimals)} ${b.symbol}` }),
          ctx.el('td', { class: 'num', text: price ? `1 ${a.symbol} = ${price.toLocaleString('en-US', { maximumSignificantDigits: 6 })} ${b.symbol}` : '–' }),
          ctx.el('td', {}, ctx.el('button', { type: 'button', class: 'btn ghost sm', text: ctx.T('dfTrade'), onclick: () => ctx.show('swap') }))));
      }
      document.getElementById('d-rows')?.replaceChildren(...(rows.length ? rows : [ctx.el('tr', {}, ctx.el('td', { colspan: 5, class: 'dim', text: ctx.T('dfNone') }))]));
    } catch (e) { document.getElementById('d-rows')?.replaceChildren(ctx.el('tr', {}, ctx.el('td', { colspan: 5, class: 'dim', text: e.message }))); }
  },
};

// ------------------------------------------------------------------ Leaderboard
const leaderboard = {
  render(root, ctx) {
    const table = (id, heads) => ctx.el('div', { class: 'scroll' }, ctx.el('table', { class: 'tbl' },
      ctx.el('thead', {}, ctx.el('tr', {}, heads.map((t) => ctx.el('th', { text: t })))), ctx.el('tbody', { id }, ctx.el('tr', {}, ctx.el('td', { colspan: heads.length, class: 'dim', text: '…' })))));
    root.replaceChildren(ctx.el('div', { class: 'grid2 tall' },
      ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('lbHolders') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipLbHolders', tabindex: 0, text: 'i' })),
        table('l-holders', ['#', ctx.T('lbAccount'), ctx.T('lbBalance'), '%'])),
      ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('lbValidators') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipLbValidators', tabindex: 0, text: 'i' })),
        table('l-vals', ['#', ctx.T('colName'), ctx.T('lbStake'), ctx.T('colCommission')]))));
  },
  async refresh(root, ctx) {
    try {
      const [own, sup, mods] = await Promise.all([
        ctx.getJson(`${ctx.ep().rest}/cosmos/bank/v1beta1/denom_owners/azetaphy?pagination.limit=1000`),
        ctx.getJson(`${ctx.ep().rest}/cosmos/bank/v1beta1/supply/by_denom?denom=azetaphy`),
        ctx.getJson(`${ctx.ep().rest}/cosmos/auth/v1beta1/module_accounts`).catch(() => ({ accounts: [] }))]);
      const names = new Map((mods.accounts ?? []).map((a) => [a.base_account?.address ?? a.address, a.name]));
      const supply = BigInt(sup.amount.amount) || 1n;
      const top = own.denom_owners.map((o) => ({ a: o.address, v: BigInt(o.balance.amount) })).sort((x, y) => (y.v > x.v ? 1 : -1)).slice(0, 25);
      document.getElementById('l-holders')?.replaceChildren(...top.map((o, i) => ctx.el('tr', { class: 'link', onclick: () => { let hex; try { hex = toEvm(o.a); } catch { return; } ctx.show('explorer', { hash: `#/address/${hex}` }); } },
        ctx.el('td', { class: 'dim', text: String(i + 1) }),
        ctx.el('td', { 'data-tip': o.a }, names.has(o.a) ? ctx.el('span', { class: 'pill', text: names.get(o.a) }) : null, ` ${ctx.short(o.a, 12, 6)}`),
        ctx.el('td', { class: 'num', text: formatZeta(o.v, 0) }),
        ctx.el('td', { class: 'num', text: (Number((o.v * 10000n) / supply) / 100).toFixed(2) }))));
    } catch (e) { document.getElementById('l-holders')?.replaceChildren(ctx.el('tr', {}, ctx.el('td', { colspan: 4, class: 'dim', text: e.message }))); }
    try {
      const vals = await ctx.getJson(`${ctx.ep().rest}/cosmos/staking/v1beta1/validators?pagination.limit=200`);
      const list = vals.validators.sort((a, b) => (BigInt(b.tokens) > BigInt(a.tokens) ? 1 : -1));
      document.getElementById('l-vals')?.replaceChildren(...list.map((v, i) => ctx.el('tr', {},
        ctx.el('td', { class: 'dim', text: String(i + 1) }),
        ctx.el('td', { 'data-tip': v.operator_address }, ctx.el('b', { text: v.description?.moniker || ctx.short(v.operator_address) }),
          v.status !== 'BOND_STATUS_BONDED' ? ctx.el('span', { class: 'pill', text: v.jailed ? ctx.T('jailed') : 'inactive' }) : null),
        ctx.el('td', { class: 'num', text: formatZeta(v.tokens, 0) }),
        ctx.el('td', { class: 'num', text: `${(Number(v.commission?.commission_rates?.rate ?? 0) * 100).toFixed(1)}%` }))));
    } catch { /* keep */ }
  },
};

// ------------------------------------------------------------------ Developers
const dev = {
  render(root, ctx) {
    const e = ctx.ep();
    const c = ctx.cfg.contracts ?? {}, d = ctx.cfg.dex ?? {}, n = ctx.cfg.nft ?? {};
    const rows = [['NeuroJobs', c.neuroJobs], ['NeuroControl', c.neuroControl], ['ThreatRegistry', c.threatRegistry], ['RewardVault', c.rewardVault],
      ['StableGateway', c.stableGateway], ['ZetaphyOracle', c.oracle], ['DEX factory', d.factory], ['DEX router', d.router], ['DLMM factory', d.dlmmFactory],
      ['NFT marketplace', n.marketplace], ['Staking precompile', '0x0000000000000000000000000000000000000800'], ['Distribution precompile', '0x0000000000000000000000000000000000000801'],
      ['Gov precompile', '0x0000000000000000000000000000000000000805'], ['ML-DSA verify precompile', '0x0000000000000000000000000000000000000900']].filter(([, a]) => a);
    root.replaceChildren(ctx.el('div', { class: 'grid2 tall' },
      ctx.el('div', { class: 'card scroll-y' },
        ctx.el('h2', { text: ctx.T('devApi') }),
        ctx.el('p', { class: 'dim small', text: ctx.T('devApiSub') }),
        ...[['EVM JSON-RPC', `curl -s ${e.evm} -H "content-type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`],
          ['WebSocket (eth_subscribe)', `npx wscat -c ${e.ws}\n> {"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}`],
          ['CometBFT RPC', `curl -s ${e.comet}/status`],
          ['Cosmos REST', `curl -s "${e.rest}/cosmos/bank/v1beta1/supply/by_denom?denom=azetaphy"`],
          [ctx.T('devFaucet'), `curl -s ${e.evm} -H "content-type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"zetaphy_faucet","params":["0xYOUR_ADDRESS"]}'`],
          [ctx.T('devRegistry'), `curl -s ${e.files}/keplr.json\ncurl -s ${e.files}/evm-chain.json`],
          [ctx.T('devCli'), 'git clone https://github.com/pospos191-alt/swd-amm.git\ncd swd-amm/zetaphy-network && npm ci --omit=dev\nnode cli.js --help']]
          .flatMap(([t, cmd]) => [ctx.el('h3', { text: t }), code(ctx, cmd)]),
        ctx.el('p', { class: 'small' }, ctx.el('a', { href: 'https://github.com/pospos191-alt/swd-amm', target: '_blank', rel: 'noopener noreferrer', text: 'GitHub ↗' }))),
      ctx.el('div', { class: 'card' },
        ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('devContracts') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipDevContracts', tabindex: 0, text: 'i' })),
        ctx.el('div', { class: 'scroll' }, ctx.el('table', { class: 'tbl' }, ctx.el('tbody', {}, rows.map(([k, a]) => ctx.el('tr', {},
          ctx.el('td', { text: k }), ctx.el('td', { class: 'num' }, ctx.el('a', { href: '#', 'data-tip': a, text: ctx.short(a, 10, 6), onclick: (ev) => { ev.preventDefault(); ctx.show('explorer', { hash: `#/address/${a}` }); } })),
          ctx.el('td', {}, ctx.copyBtn(a))))))))));
  },
};


// ------------------------------------------------------------------ ZETAPHY Saphan (IBC, chain to chain; EVM chains over Hyperlane)
// IBC routes are the open ICS-20 channels the chain reports (no config to keep in
// sync); a transfer goes out through the ICS-20 precompile (0x…0802) from
// MetaMask. Coming in, the other chain's wallet sends to this account's zetaphy1….
// EVM routes (Hyperlane) come from the chain table, through hub-config.json (build.mjs
// saphanRoutes): a chain added to zetaphy-chain/hyperlane/saphan-chains.json is listed.
export const KNOWN_CHAINS = {
  'grand-1': { name: 'Noble testnet', prefix: 'noble', note: 'USDC (Circle)' },
  'noble-1': { name: 'Noble', prefix: 'noble', note: 'USDC (Circle)' },
  'osmo-test-5': { name: 'Osmosis testnet', prefix: 'osmo', note: 'DEX' },
  'osmosis-1': { name: 'Osmosis', prefix: 'osmo', note: 'DEX' },
  'cosmoshub-4': { name: 'Cosmos Hub', prefix: 'cosmos', note: 'ATOM' },
  'theta-testnet-001': { name: 'Cosmos Hub testnet', prefix: 'cosmos', note: 'ATOM' },
};
let routes = [], assets = [];
/** azetaphy, or an ibc/… voucher with its base denom: decimals from the base (u = 6, a = 18). */
export function assetOf(denom, base) {
  if (denom === 'azetaphy') return { denom, symbol: 'ZETAPHY', dec: 18 };
  const b = String(base || denom);
  const dec = /^u[a-z]/.test(b) ? 6 : /^a[a-z]/.test(b) ? 18 : 0;
  const symbol = (dec ? b.slice(1) : b).split('/').pop().toUpperCase().slice(0, 12) || denom.slice(0, 12);
  return { denom, symbol, dec };
}
async function loadRoutes(ctx) {
  const r = await ctx.getJson(`${ctx.ep().rest}/ibc/core/channel/v1/channels?pagination.limit=100`);
  const open = (r.channels ?? []).filter((c) => c.port_id === 'transfer' && c.state === 'STATE_OPEN');
  return Promise.all(open.map(async (c) => {
    let chainId = '';
    try {
      const cs = await ctx.getJson(`${ctx.ep().rest}/ibc/core/channel/v1/channels/${c.channel_id}/ports/transfer/client_state`);
      chainId = cs.identified_client_state?.client_state?.chain_id ?? '';
    } catch { /* unknown chain */ }
    const k = KNOWN_CHAINS[chainId] ?? {};
    return { channel: c.channel_id, their: c.counterparty?.channel_id ?? '?', chainId, name: k.name ?? (chainId || '?'), prefix: k.prefix ?? null, note: k.note ?? '' };
  }));
}
async function loadAssets(ctx, bech) {
  const out = [assetOf('azetaphy')];
  if (!bech) return out.map((a) => ({ ...a, amount: null }));
  const r = await ctx.getJson(`${ctx.ep().rest}/cosmos/bank/v1beta1/balances/${bech}?pagination.limit=100`);
  const bal = new Map((r.balances ?? []).map((b) => [b.denom, b.amount]));
  for (const d of bal.keys()) {
    if (!/^ibc\/[0-9A-F]{64}$/.test(d)) continue;
    let base = '';
    try { base = (await ctx.getJson(`${ctx.ep().rest}/ibc/apps/transfer/v1/denoms/${d.slice(4)}`)).denom?.base ?? ''; } catch { /* unknown */ }
    out.push(assetOf(d, base));
  }
  return out.map((a) => ({ ...a, amount: bal.get(a.denom) ?? '0' }));
}
function saphanForm(ctx, root) {
  const L = saphanText(ctx);
  const acct = ctx.account();
  const sel = (id, opts) => ctx.el('select', { id, class: 'mono' }, opts.map(([v, t]) => ctx.el('option', { value: v, text: t })));
  const box = root.querySelector('#sp-send');
  if (!routes.length) { box.replaceChildren(ctx.el('p', { class: 'dim', text: L.none })); return; }
  const form = ctx.el('form', { class: 'sp-form', autocomplete: 'off' },
    ctx.el('label', { text: L.route }), sel('sp-route', routes.map((r) => [r.channel, `${r.name} · ${r.channel}`])),
    ctx.el('label', { text: L.asset }), sel('sp-asset', assets.map((a) => [a.denom, `${a.symbol}${a.amount != null ? ` · ${formatUnits(a.amount, a.dec, 4)}` : ''}`])),
    ctx.el('label', { text: L.amount }), ctx.el('input', { id: 'sp-amount', class: 'mono', inputmode: 'decimal', placeholder: '0.0' }),
    ctx.el('label', { text: L.to }), ctx.el('input', { id: 'sp-to', class: 'mono', spellcheck: 'false', placeholder: `${routes[0].prefix ?? 'addr'}1…` }),
    ctx.el('div', { class: 'row end' }, ctx.el('button', { type: 'submit', class: 'btn', id: 'sp-go', text: acct ? L.go : L.connect })),
    ctx.el('p', { class: 'msg', id: 'sp-msg', role: 'status' }));
  form.querySelector('#sp-route').addEventListener('change', (e) => {
    const r = routes.find((x) => x.channel === e.target.value);
    form.querySelector('#sp-to').placeholder = `${r?.prefix ?? 'addr'}1…`;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = form.querySelector('#sp-msg');
    const say = (t, cls = '') => { out.textContent = t; out.className = `msg ${cls}`; };
    try {
      if (!ctx.account()) { await ctx.connect(); saphan.refresh(root, ctx); return; }
      const r = routes.find((x) => x.channel === form.querySelector('#sp-route').value);
      const a = assets.find((x) => x.denom === form.querySelector('#sp-asset').value);
      const to = form.querySelector('#sp-to').value.trim();
      const { hrp } = bech32Decode(to);
      if (r.prefix && hrp !== r.prefix) throw new Error(L.badTo(r.prefix));
      const amount = parseUnits(form.querySelector('#sp-amount').value, a.dec);
      if (a.amount != null && amount > BigInt(a.amount)) throw new Error(L.noBalance);
      const data = encodeIbcTransfer({ channel: r.channel, denom: a.denom, amount, sender: ctx.account(), receiver: to,
        timeoutNs: BigInt(Date.now() + 10 * 60_000) * 1_000_000n, memo: 'ZETAPHY Saphan' });
      say('…');
      const hash = await ctx.send(PRECOMPILES.ics20, data);
      const rc = await ctx.evmCall('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (rc && !sentIbcTransfer(rc)) throw new Error(`${L.noEvent} · ${ctx.short(hash, 10, 6)}`);
      say(`${L.sent} · ${ctx.short(hash, 10, 6)}`, 'ok');
      saphan.refresh(root, ctx);
    } catch (err) { say(err?.message ?? String(err), 'bad'); }
  });
  box.replaceChildren(form);
}
/** The EVM routes (Hyperlane) of the chain table: name, token, one way or both, state, the lockbox. */
export function evmRows(ctx) {
  const L = saphanText(ctx);
  const list = (ctx.cfg.saphan ?? []).filter((r) => r && typeof r.displayName === 'string');
  if (!list.length) return [];
  const pill = { open: ['passed', L.stOpen], closed: ['rejected', L.stClosed], planned: ['', L.stPlanned] };
  return [ctx.el('tr', {}, ctx.el('td', { class: 'dim small', colspan: 2, 'data-tip': L.tipEvm, tabindex: 0, text: L.evm })),
    ...list.map((r) => {
      const [cls, word] = pill[r.state] ?? pill.planned;
      const box = /^0x[0-9a-fA-F]{40}$/.test(r.lockbox ?? '') && /^https:\/\//.test(r.explorer ?? '')
        ? [' · ', ctx.el('a', { href: `${r.explorer}/address/${r.lockbox}`, target: '_blank', rel: 'noopener noreferrer', text: L.lockbox })] : [];
      const way = r.state === 'planned' ? '' : ` · ${r.twoWay ? L.twoWay : L.inOnly}`;
      return ctx.el('tr', {},
        ctx.el('td', { 'data-tip': `${r.chainId} · Hyperlane` }, ctx.el('b', { text: r.displayName }),
          ctx.el('div', { class: 'dim small mono' }, `${r.symbol}${way}`, ...box)),
        ctx.el('td', { class: 'num' }, ctx.el('span', { class: `pill ${cls}`.trim(), text: word })));
    })];
}

/**
 * Token routes (tokens born on ZETAPHY going out over Hyperlane): per token, its copy on each destination and the
 * route's state; a token that cannot move (BZTPHY) says so. From hub-config.json saphanTokens (build.mjs saphanTokenRoutes).
 */
export function tokenRows(ctx) {
  const L = saphanText(ctx);
  const list = (ctx.cfg.saphanTokens ?? []).filter((r) => r && typeof r.symbol === 'string' && Array.isArray(r.destinations));
  if (!list.length) return [];
  const pill = { open: ['passed', L.stOpen], closed: ['rejected', L.stClosed], planned: ['', L.stPlanned] };
  return [ctx.el('tr', {}, ctx.el('td', { class: 'dim small', colspan: 2, 'data-tip': L.tipTok, tabindex: 0, text: L.tok })),
    ...list.flatMap((r) => {
      if (!r.transferable || !r.destinations.length) {
        return [ctx.el('tr', {}, ctx.el('td', { 'data-tip': L.tipStays }, ctx.el('b', { text: r.symbol }), ctx.el('div', { class: 'dim small', text: L.stays })),
          ctx.el('td', { class: 'num' }, ctx.el('span', { class: 'pill', text: '—' })))];
      }
      return r.destinations.filter((d) => typeof d?.displayName === 'string').map((d) => {
        const [cls, word] = pill[d.state] ?? pill.planned;
        return ctx.el('tr', {},
          ctx.el('td', { 'data-tip': L.tipTokRow(r.symbol, r.synthetic, d.displayName) }, ctx.el('b', { text: `${r.symbol} → ${d.displayName}` }),
            ctx.el('div', { class: 'dim small mono', text: `${r.synthetic} · ${L.twoWay}` })),
          ctx.el('td', { class: 'num' }, ctx.el('span', { class: `pill ${cls}`.trim(), text: word })));
      });
    })];
}

const saphan = {
  render(root, ctx) {
    const L = saphanText(ctx);
    const head = (t, tip) => ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: t }), ctx.el('span', { class: 'info', 'data-tip': tip, tabindex: 0, text: 'i' }));
    root.replaceChildren(
      ctx.el('p', { class: 'dim small sp-intro', text: L.intro }),
      ctx.el('div', { class: 'grid3 sp-grid' },
        ctx.el('div', { class: 'card' }, head(L.routes, L.tipRoutes), ctx.el('div', { class: 'scroll' }, ctx.el('table', { class: 'tbl' },
          ctx.el('tbody', { id: 'sp-routes' }, ctx.el('tr', {}, ctx.el('td', { class: 'dim', text: '…' }))), ctx.el('tbody', { id: 'sp-evm' }, ...evmRows(ctx)), ctx.el('tbody', { id: 'sp-tok' }, ...tokenRows(ctx))))),
        ctx.el('div', { class: 'card' }, head(L.send, L.tipSend), ctx.el('div', { id: 'sp-send' }, ctx.el('p', { class: 'dim', text: '…' }))),
        ctx.el('div', { class: 'card' }, head(L.recv, L.tipRecv), ctx.el('div', { id: 'sp-recv', class: 'small' }))),
      ctx.el('p', { class: 'warnline small', text: L.limits }));
  },
  async refresh(root, ctx) {
    const L = saphanText(ctx);
    const acct = ctx.account();
    const bech = acct ? toBech32(acct) : null;
    try { routes = await loadRoutes(ctx); } catch { routes = []; }
    try { assets = await loadAssets(ctx, bech); } catch { assets = [{ ...assetOf('azetaphy'), amount: null }]; }
    root.querySelector('#sp-routes')?.replaceChildren(...(routes.length ? routes.map((r) => ctx.el('tr', {},
      ctx.el('td', { 'data-tip': `${r.chainId}${r.note ? ` · ${r.note}` : ''}` }, ctx.el('b', { text: r.name }),
        ctx.el('div', { class: 'dim small mono', text: `${r.channel} → ${r.their}` })),
      ctx.el('td', { class: 'num' }, ctx.el('span', { class: 'pill passed', text: 'open' }))))
      : [ctx.el('tr', {}, ctx.el('td', { class: 'dim', text: L.noRoute }))]));
    if (!root.querySelector('#sp-amount')?.value) saphanForm(ctx, root);
    const recv = root.querySelector('#sp-recv');
    if (recv) {
      recv.replaceChildren(
        ...(bech ? [ctx.el('p', { class: 'dim', text: L.myAddr }), ctx.el('div', { class: 'code' }, ctx.el('pre', { class: 'mono', text: bech }), ctx.copyBtn(bech))]
          : [ctx.el('p', { class: 'dim', text: L.connect })]),
        ...routes.map((r) => ctx.el('p', { text: L.recvHow(r.their, r.name) })),
        ...(acct ? [ctx.el('h3', { text: L.bal }), ctx.el('dl', { class: 'kv3' }, assets.flatMap((a) => [ctx.el('dt', { text: a.symbol, 'data-tip': a.denom }), ctx.el('dd', { class: 'mono', text: formatUnits(a.amount ?? '0', a.dec, 6) })]))] : []));
    }
  },
};

export const PAGES = { earn, mine, saphan, analytics, defi, leaderboard, dev };
