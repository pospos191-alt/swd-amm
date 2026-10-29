// "Mine testnet ZETAPHY": the browser proof-of-work faucet page (a data page of pages.js), drawn as one
// faucet card: a status pill, little miners at work (one per worker, CSS animation from hub.css, only while
// mining), the reward and the hashrate, then a table of true numbers and one big Start / Stop button.
// Not mining: ZETAPHY is proof of stake and this work secures nothing. The node's faucet
// (zetaphy_faucetPow) wants a few minutes of computer work per grant, so one person cannot empty it
// with many addresses; it pays one fixed reward per valid proof (nothing accumulates). Nothing runs until
// Start is pressed; it keeps running while other hub tabs are open (the hub shows a "Running" pill), pauses
// on Pause, and stops when the proof is found, on Stop, or when the page is redrawn (a new language).
// The two modes (faucet, useful work) live side by side: switching shows the other one and stops neither.
import { isEvmAddress, toEvm } from './chainlib.js';
import { withFallback } from './i18n.js';
import { MINE } from './pages-i18n.js';
import { powPrefix, powOk, nonceHex, expectedTries } from './mine-core.js';
import { WORK } from './work-i18n.js';

const B32 = /^zetaphy1[02-9ac-hj-np-z]{38}$/;
/** The address as the node binds the proof to it (0x…), or null. */
export function mineAddress(s) {
  const a = String(s ?? '').trim();
  if (isEvmAddress(a)) return a;
  if (B32.test(a)) { try { return toEvm(a); } catch { return null; } }
  return null;
}
/** Chance (0..1) that a proof was found within `tries` tries at `bits` zero bits. */
export const chanceBy = (tries, bits) => 1 - Math.exp(-tries / expectedTries(bits));
/** Seconds as m:ss (h:mm:ss past an hour), the same in every language. */
export function clock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
export const rate = (hps) => (hps >= 1e6 ? `${(hps / 1e6).toFixed(2)} MH/s` : hps >= 1e3 ? `${(hps / 1e3).toFixed(0)} kH/s` : `${Math.round(hps)} H/s`);
/** Workers: 1 up to the CPU cores this browser reports, at most 8. */
export const maxThreads = () => Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2));
const UNIT = 'ZTPHY';

let run = null; // the running miner (one per page)
let threads = 0; // the chosen number of workers (kept across redraws)
let rewardText = `10 ${UNIT}`;
let mode = 'mine'; // 'mine' (the faucet proof of work) or 'work' (useful work: work.js, loaded when chosen)
let workMod = null;

function stopRun() {
  if (!run) return;
  announce('faucet', false);
  clearInterval(run.tick);
  for (const w of run.workers) w.terminate();
  run.workers = [];
  run = null;
}

// ------------------------------------------------------------------ the miners (inline SVG, classes only: strict CSP)
const NS = 'http://www.w3.org/2000/svg';
const MINER = `
<path class="mg-rock" d="M86 98 L90 70 L102 58 L120 60 L132 74 L136 98 Z"/>
<path class="mg-ore" d="M104 70 l6 -5 l5 6 l-6 5 z"/><path class="mg-ore b" d="M118 82 l5 -4 l4 5 l-5 4 z"/><path class="mg-ore" d="M98 87 l4 -3 l3 4 l-4 3 z"/>
<g class="mg-coin"><circle cx="104" cy="60" r="6.5"/><text x="104" y="63.2" text-anchor="middle">Z</text></g>
<rect class="mg-leg" x="35" y="78" width="7" height="17" rx="2"/><rect class="mg-leg" x="45" y="78" width="7" height="17" rx="2"/>
<rect class="mg-boot" x="33" y="93" width="10" height="5" rx="2"/><rect class="mg-boot" x="44" y="93" width="10" height="5" rx="2"/>
<rect class="mg-body" x="32" y="54" width="23" height="27" rx="5"/><rect class="mg-strap" x="35" y="56" width="3" height="20" rx="1"/><rect class="mg-strap" x="48" y="56" width="3" height="20" rx="1"/>
<circle class="mg-skin" cx="43" cy="45" r="9"/><circle class="mg-eye" cx="47.5" cy="45.5" r="1.3"/>
<path class="mg-helmet" d="M33 43 a10 10 0 0 1 20 0 z"/><rect class="mg-helmet" x="31" y="41" width="25" height="3.4" rx="1.7"/><circle class="mg-lamp" cx="52" cy="38.5" r="2.4"/>
<g class="mg-arm"><path class="mg-handle" d="M58 66 L81 57"/><path class="mg-head" d="M74 47 Q80 56 89 72"/><path class="mg-sleeve" d="M47 59 L62 64"/><circle class="mg-skin" cx="63" cy="64.5" r="3.4"/></g>
<circle class="mg-spark s1" cx="89" cy="71" r="1.7"/><circle class="mg-spark s2" cx="89" cy="71" r="1.3"/><circle class="mg-spark s3" cx="89" cy="71" r="1.5"/>`;
function miner() {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 140 98');
  s.setAttribute('preserveAspectRatio', 'xMidYMax meet');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = MINER;
  return s;
}
/** One miner per worker: running ones swing (CSS animation while .on), the others stand still. */
function crew(n) {
  const c = $('mn-crew');
  if (!c) return;
  while (c.children.length < n) c.append(miner());
  while (c.children.length > n) c.lastElementChild.remove();
  c.dataset.n = String(n);
}

/** The two modes of the page: the faucet's proof of work, or useful work (scan jobs, bug hunting). */
function modeBar(root, ctx) {
  const W = withFallback(WORK, ctx.lang);
  const b = (id, text) => ctx.el('button', { type: 'button', role: 'tab', class: `wk-mode-btn${mode === id ? ' on' : ''}`, id: `mode-${id}`,
    'aria-selected': String(mode === id), text, onclick: () => setMode(root, ctx, id) });
  return ctx.el('div', { class: 'wk-mode', role: 'tablist' }, b('mine', `⛏ ${W.modeMine}`), b('work', `🧠 ${W.modeWork}`));
}

/** Show one mode; the other keeps running underneath. Useful work is loaded the first time it is shown. */
function setMode(root, ctx, m) {
  mode = m;
  for (const b of root.querySelectorAll('.wk-mode-btn')) { const on = b.id === `mode-${m}`; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
  const mh = $('mn-host'), wh = $('wk-host');
  if (!mh || !wh) return;
  mh.hidden = m !== 'mine';
  wh.hidden = m !== 'work';
  if (m === 'work' && !wh.dataset.ready) {
    wh.dataset.ready = '1';
    import('./work.js').then((w) => { workMod = w; if (wh.isConnected) w.renderWork(wh, ctx); })
      .catch((e) => { wh.textContent = String(e?.message ?? e); });
  }
}
let modeRoot = null;
// the AI map opens Mine on its useful-work side
globalThis.addEventListener?.('hub:mine-mode', (e) => { if (modeRoot?.root.isConnected) setMode(modeRoot.root, modeRoot.ctx, e.detail); else mode = e.detail; });
/** Tell the hub whether something runs here (its "Running" pill and the tab's dot). */
export const announce = (job, on) => globalThis.dispatchEvent?.(new CustomEvent('hub:busy', { detail: { id: 'mine', job, on } }));

const mine = {
  render(root, ctx) {
    stopRun();
    workMod?.stopWork();
    modeRoot = { root, ctx };
    const L = withFallback(MINE, ctx.lang);
    const el = ctx.el;
    if (!threads) threads = Math.min(2, maxThreads());
    threads = Math.min(threads, maxThreads());
    const row = (label, tip, ...value) => el('tr', {}, el('th', { scope: 'row', text: label, 'data-tip': tip ?? null }), el('td', {}, ...value));
    const dd = (id, text = '–', cls = 'mono') => el('span', { id, class: cls, text });
    const mineHost = el('div', { id: 'mn-host' });
    root.replaceChildren(modeBar(root, ctx), mineHost, el('div', { id: 'wk-host', hidden: true }));
    mineHost.replaceChildren(
      el('div', { class: 'mn-grid' },
        el('div', { class: 'card mn-card', 'aria-label': L.card },
          el('div', { class: 'mn-head' },
            el('div', { class: 'mn-title' }, el('h2', { text: L.card }), el('p', { class: 'small dim', id: 'mn-session', text: L.noSession })),
            el('span', { class: 'mn-pill', id: 'mn-status', 'data-s': 'idle', role: 'status', text: L.st.idle })),
          el('div', { class: 'mn-art', id: 'mn-art' },
            el('div', { class: 'mn-crew', id: 'mn-crew', role: 'img', 'aria-label': L.title }),
            el('button', { type: 'button', class: 'mn-pause', id: 'mn-pause', disabled: true, 'aria-label': L.pause, 'data-tip': L.pause, text: '❚❚', onclick: () => togglePause(L) })),
          el('div', { class: 'mn-tiles' },
            el('div', { class: 'mn-tile', 'data-tip': L.tipYourReward, tabindex: 0 },
              el('span', { class: 'k', text: L.yourReward }), el('span', { class: 'v mono', id: 'mn-won', text: `0 ${UNIT}` }),
              el('div', { class: 'hb-track mn-bar', 'data-tip': L.tipChance }, el('span', { class: 'hb-fill', id: 'mn-fill' }))),
            el('div', { class: 'mn-tile', 'data-tip': L.tipSpeed, tabindex: 0 },
              el('span', { class: 'k', text: L.speed }), el('span', { class: 'v mono', id: 'mn-rate', text: '0 H/s' }))),
          el('table', { class: 'mn-table' }, el('tbody', {},
            row(L.addr, null, el('div', { class: 'row' },
              el('input', { id: 'mn-addr', class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: '0x… / zetaphy1…', 'aria-label': L.addr }),
              el('button', { type: 'button', class: 'btn ghost sm', id: 'mn-wallet', text: L.useWallet, onclick: async () => {
                try { $('mn-addr').value = await ctx.connect(); } catch (e) { say(e.message, 'bad'); }
              } }))),
            row(L.threads, L.tipThreads, el('div', { class: 'mn-step' },
              el('button', { type: 'button', class: 'btn ghost sm', id: 'mn-less', 'aria-label': L.fewer, text: '−', onclick: () => setThreads(L, threads - 1) }),
              el('span', { class: 'mono', id: 'mn-threads', 'aria-live': 'polite', text: String(threads) }),
              el('button', { type: 'button', class: 'btn ghost sm', id: 'mn-more', 'aria-label': L.more, text: '+', onclick: () => setThreads(L, threads + 1) }))),
            row(L.reward, null, dd('mn-reward', rewardText)),
            row(L.limit, null, el('span', {}, `${L.oncePerDay} · `, dd('mn-left'), ` ${L.leftToday}`)),
            row(L.difficulty, L.tipDifficulty, dd('mn-bits')),
            row(L.eta, L.tipEta, dd('mn-eta')),
            row(L.tries, L.tipTries, dd('mn-tries', '0')),
            row(L.chance, L.tipChance, dd('mn-chance', '0%')),
            row(L.elapsed, null, dd('mn-elapsed', '0:00')),
            row(L.anchors, L.tipAnchors, dd('mn-anchors', '0')))),
          el('button', { type: 'button', class: 'btn mn-go', id: 'mn-start', text: L.start, onclick: () => go(ctx, root, L) }),
          el('p', { class: 'msg', id: 'mn-msg', role: 'status', 'aria-live': 'polite' }),
          el('p', { class: 'msg', id: 'mn-tx' })),
        el('div', { class: 'card mn-about' },
          el('h2', { text: L.whatH }),
          el('p', { class: 'small', text: L.what }),
          el('p', { class: 'small warnline', text: L.notMining }),
          el('h3', { text: L.howH }),
          el('ol', { class: 'howto small' }, L.how.map((t) => el('li', {}, el('p', { text: t })))),
          el('p', { class: 'small dim', text: L.battery }))));
    crew(threads);
    stepButtons();
    const acc = ctx.account?.();
    if (acc) $('mn-addr').value = acc;
    info(ctx, L).catch(() => {});
    setMode(root, ctx, mode);
  },
};

const $ = (id) => document.getElementById(id);
function say(text, cls = '') { const n = $('mn-msg'); if (n) { n.textContent = text; n.className = `msg ${cls}`; } }
/** The card's state: idle, mining, paused, claiming, done or error (pill, button, animation). */
function status(L, s) {
  const p = $('mn-status');
  if (!p) return;
  p.dataset.s = s;
  p.textContent = L.st[s];
  announce('faucet', s === 'mining' || s === 'paused' || s === 'claiming');
  $('mn-art').classList.toggle('on', s === 'mining');
  const b = $('mn-start');
  const busy = s === 'mining' || s === 'paused';
  b.textContent = busy ? L.stop : s === 'done' ? L.doneBtn : L.start;
  b.classList.toggle('stop', busy);
  b.classList.toggle('done', s === 'done');
  b.disabled = s === 'claiming';
  const pz = $('mn-pause');
  pz.disabled = !busy;
  const user = !!run?.userPaused;
  pz.textContent = user ? '▶' : '❚❚';
  pz.setAttribute('aria-label', user ? L.resume : L.pause);
  pz.dataset.tip = user ? L.resume : L.pause;
  $('mn-addr').disabled = busy || s === 'claiming';
}
function stepButtons() {
  if ($('mn-less')) $('mn-less').disabled = threads <= 1;
  if ($('mn-more')) $('mn-more').disabled = threads >= maxThreads();
}
/** − / +: the number of workers, live while mining (the work so far counts on). */
function setThreads(L, n) {
  threads = Math.max(1, Math.min(maxThreads(), n));
  $('mn-threads').textContent = String(threads);
  stepButtons();
  crew(threads);
  if (run) { run.threads = threads; if (!run.paused) run.spawn(); }
}
function togglePause(L) {
  if (!run) return;
  run.userPaused = !run.userPaused;
  run.tickNow?.();
}

async function info(ctx, L) {
  const i = await ctx.evmCall('zetaphy_faucetPowInfo', []);
  if (!i || !Number.isInteger(i.bits) || i.bits < 1 || i.bits > 64) throw new Error(L.noInfo);
  rewardText = `${ctx.formatZeta(BigInt(i.reward ?? 0), 0)} ${UNIT}`;
  if ($('mn-bits')) {
    $('mn-bits').textContent = `${i.bits} ${L.bits} · ≈ ${fmtCount(expectedTries(i.bits))} ${L.triesWord}`;
    $('mn-reward').textContent = rewardText;
    $('mn-left').textContent = `${i.remainingToday} / ${i.perDay}`;
  }
  return i;
}
const fmtCount = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : Math.round(n).toLocaleString('en-US'));

/** The newest block (height and hash) a proof can be built on. */
async function latestBlock(ctx) {
  const b = await ctx.evmCall('eth_getBlockByNumber', ['latest', false]);
  const height = Number(BigInt(b?.number ?? 0));
  if (!height || !/^0x[0-9a-fA-F]{64}$/.test(b?.hash ?? '')) throw new Error('no block');
  return { height, hash: b.hash };
}

/** The big button: Start, Stop, or (after a grant) back to the start. */
function go(ctx, root, L) {
  const s = $('mn-status').dataset.s;
  if (s === 'mining' || s === 'paused') { stopRun(); status(L, 'idle'); say(L.stopped); return; }
  if (s === 'done') { status(L, 'idle'); say(''); $('mn-tx').replaceChildren(); return; }
  start(ctx, root, L);
}

async function start(ctx, root, L) {
  if (run) return;
  const addr = mineAddress($('mn-addr').value);
  if (!addr) { say(L.badAddr, 'bad'); status(L, 'error'); return; }
  $('mn-tx').replaceChildren();
  $('mn-won').textContent = `0 ${UNIT}`;
  $('mn-start').disabled = true;
  say(L.asking);
  let i, base;
  try {
    i = await info(ctx, L);
    if (!i.enabled) throw new Error(L.off);
    if (i.remainingToday < 1) throw new Error(L.noneLeft);
    base = await latestBlock(ctx);
  } catch (e) { say(e.message, 'bad'); status(L, 'error'); return; }
  const r = {
    addr, bits: i.bits, chainId: i.chainId, maxAge: Number(i.maxAgeBlocks) || 100, threads, base,
    gen: 0, tries: 0, workers: [], paused: false, userPaused: false, window: [], checking: false, lastCheck: Date.now(),
    started: Date.now(), anchors: 0,
  };
  run = r;
  const t = new Date(r.started);
  $('mn-session').textContent = `${L.session} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} · ${ctx.short(addr, 6, 4)}`;
  $('mn-session').dataset.tip = addr;
  const job = () => {
    r.gen++;
    const prefix = powPrefix(r.chainId, r.base.hash, r.addr);
    const his = crypto.getRandomValues(new Uint32Array(r.workers.length));
    r.workers.forEach((w, k) => w.postMessage({ job: { gen: r.gen, prefix, bits: r.bits, hi: his[k] } }));
  };
  r.spawn = () => {
    for (const w of r.workers) w.terminate();
    r.window = [];
    r.workers = Array.from({ length: r.threads }, () => {
      const w = new Worker(new URL('./mine-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }) => {
        if (run !== r || data.gen !== r.gen) return;
        r.tries += data.tries;
        r.window.push([performance.now(), data.tries]);
        if (data.found) found(ctx, L, r, data.found);
      };
      w.onerror = () => { if (run === r) { stopRun(); status(L, 'error'); say(L.workerFail, 'bad'); } };
      return w;
    });
    job();
  };
  r.spawn();
  status(L, 'mining');
  say(L.mining);
  const tick = async () => {
    if (run !== r) return;
    // pause while nobody looks (the browser tab hidden, or another hub tab open) or on Pause
    // pause only on Pause (other hub tabs and other browser tabs do not stop it)
    const away = !root.isConnected || r.userPaused;
    if (away && !r.paused) { r.paused = true; for (const w of r.workers) w.terminate(); r.workers = []; r.window = []; status(L, 'paused'); say(r.userPaused ? '' : L.paused); return; }
    if (!away && r.paused) { r.paused = false; r.spawn(); status(L, 'mining'); say(L.mining); }
    if (r.paused) return;
    show(L, r);
    // keep the proof's block recent: past half the allowed age, start again on the newest block
    // (each try is a fresh chance: nothing done so far is lost)
    if (!r.checking && Date.now() - r.lastCheck > 20_000) {
      r.checking = true; r.lastCheck = Date.now();
      try {
        const now = await latestBlock(ctx);
        if (run === r && now.height - r.base.height >= r.maxAge / 2) { r.base = now; r.anchors++; job(); }
      } catch { /* the next check tries again */ }
      r.checking = false;
    }
  };
  r.tickNow = tick;
  r.tick = setInterval(tick, 1000);
}

function show(L, r) {
  const t = performance.now();
  r.window = r.window.filter(([at]) => t - at < 5000);
  const span = r.window.length > 1 ? (t - r.window[0][0]) / 1000 : 0;
  const hps = span > 0.5 ? r.window.slice(1).reduce((s, [, n]) => s + n, 0) / span : 0;
  const p = chanceBy(r.tries, r.bits);
  $('mn-rate').textContent = hps ? rate(hps) : '…';
  $('mn-tries').textContent = r.tries >= 1e6 ? `${(r.tries / 1e6).toFixed(1)}M` : r.tries.toLocaleString('en-US');
  $('mn-chance').textContent = `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
  $('mn-eta').textContent = hps ? `≈ ${clock(expectedTries(r.bits) / hps)}` : '…';
  $('mn-elapsed').textContent = clock((Date.now() - r.started) / 1000);
  $('mn-anchors').textContent = String(r.anchors);
  $('mn-fill').style.width = `${Math.min(100, p * 100).toFixed(1)}%`;
}

async function found(ctx, L, r, { hi, lo }) {
  const height = r.base.height;
  const prefix = powPrefix(r.chainId, r.base.hash, r.addr);
  for (const w of r.workers) w.terminate();
  r.workers = [];
  clearInterval(r.tick);
  if (!powOk(prefix, hi, lo, r.bits)) { stopRun(); status(L, 'error'); say(L.workerFail, 'bad'); return; }
  show(L, r);
  $('mn-fill').style.width = '100%';
  status(L, 'claiming');
  say(L.claiming);
  let ok = false;
  try {
    const res = await ctx.evmCall('zetaphy_faucetPow', [r.addr, `0x${height.toString(16)}`, nonceHex(hi, lo)]);
    const hash = res?.txHash;
    ok = true;
    say(L.done, 'ok');
    if ($('mn-won')) $('mn-won').textContent = rewardText;
    if (/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) {
      $('mn-tx').replaceChildren(document.createTextNode(`${L.tx}: `),
        ctx.el('a', { href: `explorer/#/tx/${hash}`, class: 'mono', 'data-tip': hash, text: ctx.short(hash, 10, 8), onclick: (ev) => { ev.preventDefault(); ctx.show('explorer', { hash: `#/tx/${hash}` }); } }),
        document.createTextNode(` · ${L.inExplorer}`));
    }
  } catch (e) { say(`${L.claimFail}: ${e.message}`, 'bad'); }
  if (run === r) run = null;
  status(L, ok ? 'done' : 'error');
  info(ctx, L).catch(() => {});
}

export default mine;
