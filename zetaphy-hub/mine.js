// "Mine testnet ZETAPHY": the browser proof-of-work faucet page (a data page of pages.js).
// Not mining: ZETAPHY is proof of stake and this work secures nothing. The node's faucet
// (zetaphy_faucetPow) wants a few minutes of computer work per grant, so one person cannot empty it
// with many addresses. Nothing runs until Start is pressed; it pauses while the tab or this page is
// hidden, and stops when the proof is found, on Stop, or when the page is left or redrawn.
import { isEvmAddress, toEvm } from './chainlib.js';
import { withFallback } from './i18n.js';
import { MINE } from './pages-i18n.js';
import { powPrefix, powOk, nonceHex, expectedTries } from './mine-core.js';

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
const maxThreads = () => Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2));

let run = null; // the running miner (one per page)

function stopRun() {
  if (!run) return;
  clearInterval(run.tick);
  for (const w of run.workers) w.terminate();
  run.workers = [];
  run = null;
}

const mine = {
  render(root, ctx) {
    stopRun();
    const L = withFallback(MINE, ctx.lang);
    const el = ctx.el;
    const stat = (id, label, tip) => el('div', { class: 'stat', 'data-tip': tip, tabindex: 0 }, el('span', { class: 'k', text: label }), el('span', { class: 'v mono', id, text: '–' }));
    const threads = el('select', { id: 'mn-threads', 'aria-label': L.threads, 'data-tip': L.tipThreads },
      Array.from({ length: maxThreads() }, (_, i) => el('option', { value: String(i + 1), text: String(i + 1), selected: i + 1 === Math.min(2, maxThreads()) })));
    root.replaceChildren(
      el('div', { class: 'stats' },
        stat('mn-rate', L.speed, L.tipSpeed), stat('mn-tries', L.tries, L.tipTries),
        stat('mn-chance', L.chance, L.tipChance), stat('mn-eta', L.eta, L.tipEta)),
      el('div', { class: 'grid2 mn-grid' },
        el('div', { class: 'card' },
          el('div', { class: 'card-head' }, el('h2', { text: L.title }), el('span', { class: 'pill', text: L.testnet })),
          el('div', { class: 'sp-form' },
            el('label', { for: 'mn-addr', text: L.addr }),
            el('div', { class: 'row' },
              el('input', { id: 'mn-addr', class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: '0x… / zetaphy1…' }),
              el('button', { type: 'button', class: 'btn ghost sm', id: 'mn-wallet', text: L.useWallet, onclick: async () => {
                try { $('mn-addr').value = await ctx.connect(); } catch (e) { say(e.message, 'bad'); }
              } })),
            el('label', { for: 'mn-threads', text: L.threads }), threads,
            el('div', { class: 'row' },
              el('button', { type: 'button', class: 'btn', id: 'mn-start', text: L.start, onclick: () => start(ctx, root, L) }),
              el('button', { type: 'button', class: 'btn ghost', id: 'mn-stop', text: L.stop, disabled: true, onclick: () => { stopRun(); idle(L); say(L.stopped); } })),
            el('div', { class: 'hb-track mn-bar', 'data-tip': L.tipChance }, el('span', { class: 'hb-fill', id: 'mn-fill' })),
            el('p', { class: 'msg', id: 'mn-msg', role: 'status', 'aria-live': 'polite' }),
            el('p', { class: 'msg', id: 'mn-tx' })),
          el('dl', { class: 'kv3 mn-info' },
            el('dt', { text: L.reward }), el('dd', { id: 'mn-reward', text: '–' }),
            el('dt', { text: L.difficulty }), el('dd', { id: 'mn-bits', text: '–', 'data-tip': L.tipDifficulty }),
            el('dt', { text: L.left }), el('dd', { id: 'mn-left', text: '–' }))),
        el('div', { class: 'card scroll-y' },
          el('h2', { text: L.whatH }),
          el('p', { class: 'small', text: L.what }),
          el('p', { class: 'small warnline', text: L.notMining }),
          el('h3', { text: L.howH }),
          el('ol', { class: 'howto small' }, L.how.map((t) => el('li', {}, el('p', { text: t })))),
          el('p', { class: 'small dim', text: L.battery }))));
    const acc = ctx.account?.();
    if (acc) $('mn-addr').value = acc;
    info(ctx, L).catch(() => {});
  },
};

const $ = (id) => document.getElementById(id);
function say(text, cls = '') { const n = $('mn-msg'); if (n) { n.textContent = text; n.className = `msg ${cls}`; } }
function idle(L) {
  const s = $('mn-start'), t = $('mn-stop');
  if (s) { s.disabled = false; s.textContent = L.start; }
  if (t) t.disabled = true;
  if ($('mn-threads')) $('mn-threads').disabled = false;
}

async function info(ctx, L) {
  const i = await ctx.evmCall('zetaphy_faucetPowInfo', []);
  if (!i || !Number.isInteger(i.bits) || i.bits < 1 || i.bits > 64) throw new Error(L.noInfo);
  if ($('mn-bits')) {
    $('mn-bits').textContent = `${i.bits} ${L.bits} · ≈ ${(expectedTries(i.bits) / 1e6).toFixed(0)}M ${L.triesWord}`;
    $('mn-reward').textContent = `${ctx.formatZeta(BigInt(i.reward ?? 0), 0)} ZETAPHY`;
    $('mn-left').textContent = `${i.remainingToday} / ${i.perDay}`;
  }
  return i;
}

/** The newest block (height and hash) a proof can be built on. */
async function latestBlock(ctx) {
  const b = await ctx.evmCall('eth_getBlockByNumber', ['latest', false]);
  const height = Number(BigInt(b?.number ?? 0));
  if (!height || !/^0x[0-9a-fA-F]{64}$/.test(b?.hash ?? '')) throw new Error('no block');
  return { height, hash: b.hash };
}

async function start(ctx, root, L) {
  if (run) return;
  const addr = mineAddress($('mn-addr').value);
  if (!addr) { say(L.badAddr, 'bad'); return; }
  $('mn-tx').replaceChildren();
  $('mn-start').disabled = true;
  say(L.asking);
  let i, base;
  try {
    i = await info(ctx, L);
    if (!i.enabled) throw new Error(L.off);
    if (i.remainingToday < 1) throw new Error(L.noneLeft);
    base = await latestBlock(ctx);
  } catch (e) { say(e.message, 'bad'); idle(L); return; }
  const n = Math.max(1, Math.min(maxThreads(), Number($('mn-threads').value) || 1));
  $('mn-threads').disabled = true;
  $('mn-stop').disabled = false;
  const r = {
    addr, bits: i.bits, chainId: i.chainId, maxAge: Number(i.maxAgeBlocks) || 100, threads: n, base,
    gen: 0, tries: 0, workers: [], paused: false, window: [], checking: false, lastCheck: Date.now(),
  };
  run = r;
  const job = () => {
    r.gen++;
    const prefix = powPrefix(r.chainId, r.base.hash, r.addr);
    const his = crypto.getRandomValues(new Uint32Array(r.workers.length));
    r.workers.forEach((w, k) => w.postMessage({ job: { gen: r.gen, prefix, bits: r.bits, hi: his[k] } }));
  };
  const spawn = () => {
    r.workers = Array.from({ length: r.threads }, () => {
      const w = new Worker(new URL('./mine-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }) => {
        if (run !== r || data.gen !== r.gen) return;
        r.tries += data.tries;
        r.window.push([performance.now(), data.tries]);
        if (data.found) found(ctx, L, r, data.found);
      };
      w.onerror = () => { if (run === r) { stopRun(); idle(L); say(L.workerFail, 'bad'); } };
      return w;
    });
    job();
  };
  spawn();
  say(L.mining);
  r.tick = setInterval(async () => {
    if (run !== r) return;
    // pause while nobody looks: the browser tab hidden, or another hub tab open
    const away = document.hidden || root.hidden || !root.isConnected;
    if (away && !r.paused) { r.paused = true; for (const w of r.workers) w.terminate(); r.workers = []; r.window = []; say(L.paused); return; }
    if (!away && r.paused) { r.paused = false; spawn(); say(L.mining); }
    if (r.paused) return;
    show(L, r);
    // keep the proof's block recent: past half the allowed age, start again on the newest block
    // (each try is a fresh chance: nothing done so far is lost)
    if (!r.checking && Date.now() - r.lastCheck > 20_000) {
      r.checking = true; r.lastCheck = Date.now();
      try {
        const now = await latestBlock(ctx);
        if (run === r && now.height - r.base.height >= r.maxAge / 2) { r.base = now; job(); }
      } catch { /* the next check tries again */ }
      r.checking = false;
    }
  }, 1000);
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
  $('mn-fill').style.width = `${Math.min(100, p * 100).toFixed(1)}%`;
}

async function found(ctx, L, r, { hi, lo }) {
  const height = r.base.height;
  const prefix = powPrefix(r.chainId, r.base.hash, r.addr);
  for (const w of r.workers) w.terminate();
  r.workers = [];
  clearInterval(r.tick);
  if (!powOk(prefix, hi, lo, r.bits)) { stopRun(); idle(L); say(L.workerFail, 'bad'); return; }
  show(L, r);
  $('mn-fill').style.width = '100%';
  say(L.claiming);
  try {
    const res = await ctx.evmCall('zetaphy_faucetPow', [r.addr, `0x${height.toString(16)}`, nonceHex(hi, lo)]);
    const hash = res?.txHash;
    say(L.done, 'ok');
    if (/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) {
      $('mn-tx').replaceChildren(document.createTextNode(`${L.tx}: `),
        ctx.el('a', { href: `explorer/#/tx/${hash}`, class: 'mono', 'data-tip': hash, text: ctx.short(hash, 10, 8), onclick: (ev) => { ev.preventDefault(); ctx.show('explorer', { hash: `#/tx/${hash}` }); } }),
        document.createTextNode(` · ${L.inExplorer}`));
    }
  } catch (e) { say(`${L.claimFail}: ${e.message}`, 'bad'); }
  if (run === r) run = null;
  idle(L);
  info(ctx, L).catch(() => {});
}

export default mine;
