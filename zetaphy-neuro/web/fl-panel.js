// Federated learning panel on the Neuro page (docs/future/federated.md, item 6).
//
// Off by default. When the user turns it on:
//  - each EVM token checked on this page is kept IN THIS BROWSER (localStorage): its
//    feature vector, the trade simulation's pool, the pool's liquidity and whether the
//    ThreatRegistry flagged it, at scan time;
//  - the user can say afterwards how it turned out, and the panel re-reads outcomes from
//    the chain later (ml/fl/labels.js: cannot sell any more, liquidity pulled, flagged);
//  - once per round, in a Web Worker (web/fl-worker.js), it trains the head on the labelled
//    checks, clips and noises the change (crypto.getRandomValues) and encodes it;
//  - the user's wallet commits and later reveals it to FederatedRounds (ml/fl/rounds.js).
// Only the clipped + noised update leaves the browser. The privacy budget (ml/fl/dp.js
// PrivacyLedger) is counted before anything is committed and is never reset by this page.
//
// Self-contained like web/flow.js: it adds its own section, listens for the
// `neuro:report` event of app.js, follows <html lang>. Everything shown is textContent.
import { flText, fill } from './fl-i18n.js';
import { createWallet } from './fl-wallet.js';
import { CHAINS } from '../src/chains.js';
import { createRpc } from '../src/rpc.js';
import { readContract } from '../src/reader.js';
import { extractFeatures } from '../ml/features.js';
import { checkModel } from '../ml/model.js';
import { checkHead, sealHead } from '../ml/fl/head.js';
import { PrivacyLedger, DEFAULT_PRIVACY, epsilonOf, rhoPerRound, roundsAllowed } from '../ml/fl/dp.js';
import { checkDeployment } from '../ml/fl/deployment.js';
import { roundsClient, commitmentFor, newSalt, toHex, fromHex } from '../ml/fl/rounds.js';
import { scanEntry, observation, finalLabel, labelledExamples, dueForRecheck, poolLiquidity, threatFlagged, DEFAULT_LABELING } from '../ml/fl/labels.js';

const KEY = 'neuro-fl-v1';
const MAX_OBS = 12;
const SHOWN = 50;
const PRIVACY = DEFAULT_PRIVACY;
const $ = (id) => document.getElementById(id);
const lang = () => document.documentElement.lang || 'en';
const T = () => flText(lang());
const make = (tag, attrs = {}, text) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v === true) e.setAttribute(k, ''); else if (v != null && v !== false) e.setAttribute(k, v); }
  if (text != null) e.textContent = text;
  return e;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ------------------------------------------------------------ local state (never sent)
function fresh() { return { v: 1, optIn: false, entries: [], ledger: { spent: [] }, pending: null }; }
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && s.v === 1 && Array.isArray(s.entries) && Array.isArray(s.ledger?.spent)) {
      s.entries = s.entries.filter((e) => e && typeof e.id === 'string' && e.f && typeof e.f === 'object' && Array.isArray(e.obs));
      s.ledger.spent = s.ledger.spent.filter((x) => Number.isSafeInteger(x?.round) && Number.isFinite(x?.rho) && x.rho > 0);
      return { ...fresh(), ...s, optIn: s.optIn === true };
    }
  } catch { /* storage blocked or malformed */ }
  return fresh();
}
let st = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* private mode */ } };
const ledger = () => new PrivacyLedger({ epsBudget: PRIVACY.epsBudget, delta: PRIVACY.delta, spent: st.ledger.spent });

// ------------------------------------------------------------ deployment, model, chain
let dep = null;        // checked ml/fl/deployment.json
let depError = null;
let headInfo = null;   // { dim }
let model = null; let head = null;
let roundStatus = null; let statusError = false;
let busy = false;
let wallet = null;

async function loadDeployment() {
  try { dep = checkDeployment(await (await fetch('../ml/fl/deployment.json', { cache: 'no-store' })).json()); depError = null; } catch (e) { dep = null; depError = e.message; }
}
async function loadHeadInfo() {
  try { const h = await (await fetch('../ml/fl/head.json')).json(); headInfo = { dim: Number(h.dim) || null }; } catch { headInfo = null; }
}
async function loadModel() {
  if (model && head) return;
  const m = checkModel(await (await fetch('../ml/model.json')).json());
  const h = checkHead(m, await (await fetch('../ml/fl/head.json')).json());
  // The update names the head by its hash: recompute it here (WebCrypto) rather than trust the file.
  if ((await sealHead(h)).hash !== h.hash) throw new Error('ml/fl/head.json does not match its own hash');
  model = m; head = h;
}

/** Read-only JSON-RPC to the deployment's node (no wallet needed). */
async function chainRead(method, params) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(dep.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(String(j.error.message ?? 'rpc error').slice(0, 200));
    return j.result;
  } finally { clearTimeout(t); }
}

async function refreshStatus() {
  if (!dep?.deployed) { roundStatus = null; render(); return; }
  try {
    roundStatus = await roundsClient(chainRead, dep.rounds).status(wallet?.account() ?? null);
    statusError = false;
    // A pending update whose round is over without a reveal is not used (its cost stays counted).
    const p = st.pending;
    if (p && !p.revealed && (roundStatus.round > BigInt(p.round))) { p.missed = true; save(); }
  } catch { statusError = true; }
  render();
}

// ------------------------------------------------------------ scans -> stored entries
async function capture({ chain, address, report } = {}) {
  if (!st.optIn || !report || report.kind === 'tx' || !report.analysis) return;
  const c = CHAINS[chain];
  if (!c || c.kind !== 'evm' || !/^0x[0-9a-fA-F]{40}$/.test(String(address))) return;
  if ((report.analysis.findings ?? []).some((f) => f.id === 'no-code')) return;
  const id = `${chain}:${address.toLowerCase()}`;
  const rpc = createRpc(c.rpcs, c.id);
  const call = (m, p) => rpc.call(m, p);
  const liquidity = report.sim?.pair && c.dex?.weth ? await poolLiquidity(call, report.sim.pair, c.dex.weth) : null;
  const flagged = dep?.threatRegistry ? await threatFlagged(chainRead, dep.threatRegistry, { chainId: c.id, address, fingerprint: report.fingerprint }) : null;
  const existing = st.entries.find((e) => e.id === id);
  if (existing) { // checked again: a later observation of the same token
    existing.obs.push(observation({ sim: report.sim, liquidity, flagged }));
    existing.obs = existing.obs.slice(-MAX_OBS);
  } else {
    const code = await call('eth_getCode', [address, 'latest']).catch(() => null);
    const impl = report.proxy?.implementation;
    const logicCode = impl ? await call('eth_getCode', [impl, 'latest']).catch(() => null) : null;
    const features = extractFeatures({ report, code, logicCode });
    st.entries.unshift(scanEntry({ chain, chainId: c.id, address, features, sim: report.sim, liquidity, flagged, fingerprint: report.fingerprint }));
    st.entries = st.entries.slice(0, DEFAULT_LABELING.maxEntries);
  }
  save();
  render();
}

/** Re-reads outcomes of entries that are due (at most `max` per call: free public endpoints). */
async function recheck(max = 5) {
  const due = dueForRecheck(st.entries).slice(0, max);
  for (let i = 0; i < due.length; i++) {
    say(fill(T().rechecking, { n: due.length - i }));
    const e = due[i];
    const c = CHAINS[e.chain];
    if (!c) continue;
    try {
      const report = await readContract(e.chain, e.address);
      const rpc = createRpc(c.rpcs, c.id);
      const pair = report.sim?.pair ?? e.pair;
      const liquidity = pair && c.dex?.weth ? await poolLiquidity((m, p) => rpc.call(m, p), pair, c.dex.weth) : null;
      const flagged = dep?.threatRegistry ? await threatFlagged(chainRead, dep.threatRegistry, { chainId: c.id, address: e.address, fingerprint: e.fp }) : null;
      e.obs.push(observation({ sim: report.sim, liquidity, flagged }));
      e.obs = e.obs.slice(-MAX_OBS);
      save();
    } catch { /* try again next time */ }
  }
  say(T().rechecked);
  render();
}

// ------------------------------------------------------------ one round: train, commit, reveal
function trainInWorker(rows, round) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./fl-worker.js', import.meta.url), { type: 'module' });
    const done = (f) => (x) => { w.terminate(); f(x); };
    w.onmessage = done((e) => (e.data?.ok ? resolve(e.data) : reject(new Error(e.data?.error ?? 'worker failed'))));
    w.onerror = done((e) => reject(new Error(e.message || 'worker failed')));
    w.postMessage({ model, head, rows, round, privacy: PRIVACY });
  });
}

async function ensureWallet() {
  if (!wallet?.account()) throw new Error(T().noWallet);
  await wallet.ensureChain();
  return wallet.account();
}

async function trainAndCommit() {
  const t = T();
  if (busy || !dep?.deployed) return;
  busy = true; render();
  try {
    const me = await ensureWallet();
    const rc = roundsClient((m, p) => wallet.request(m, p), dep.rounds);
    const s = await roundsClient(chainRead, dep.rounds).status(me);
    roundStatus = s;
    if (s.paused) throw new Error(t.closed);
    if (s.phase !== 1) throw new Error(t.needCommit);
    const round = Number(s.round);
    if (s.committed) throw new Error(t.already);
    let p = st.pending;
    if (!(p && p.round === round && p.account.toLowerCase() === me.toLowerCase() && !p.committedTx)) {
      const rows = labelledExamples(st.entries);
      if (!rows.length) throw new Error(t.needLabels);
      const L = ledger();
      const why = L.refuse(round, PRIVACY.z);
      if (why) throw new Error(why === 'privacy budget used up' ? t.budgetOut : t.already);
      say(fill(t.training, { n: rows.length }));
      await loadModel();
      const out = await trainInWorker(rows, round);
      // Counted BEFORE anything is committed: once the noised update exists it is spent.
      L.record(round, PRIVACY.z);
      st.ledger.spent = L.toJSON().spent;
      p = st.pending = { round, account: me, payload: '0x' + toHex(out.bytes), salt: newSalt(), dim: out.dim, norm: out.norm, n: out.n, at: Date.now() };
      save();
      render();
    }
    say(t.committing);
    const payload = fromHex(p.payload);
    const tx = await rc.commit(me, round, commitmentFor(payload, p.salt, me));
    p.committedTx = tx.hash;
    save();
    say(fill(t.committed, { r: round }));
  } catch (e) {
    say(t.failed + (e?.code === 4001 ? 'rejected in the wallet' : String(e?.message ?? e).slice(0, 200)), true);
  } finally {
    busy = false;
    await refreshStatus();
  }
}

async function reveal() {
  const t = T();
  const p = st.pending;
  if (busy || !dep?.deployed || !p?.committedTx || p.revealed) return;
  busy = true; render();
  try {
    const me = await ensureWallet();
    if (me.toLowerCase() !== p.account.toLowerCase()) throw new Error(`switch the wallet to ${short(p.account)}`);
    const s = await roundsClient(chainRead, dep.rounds).status(me);
    roundStatus = s;
    if (s.phase !== 2 || Number(s.round) !== p.round) throw new Error(s.round > BigInt(p.round) ? fill(t.missed, { r: p.round }) : t.needReveal);
    say(t.revealing);
    const tx = await roundsClient((m, q) => wallet.request(m, q), dep.rounds).reveal(me, p.round, p.salt, fromHex(p.payload));
    p.revealed = tx.hash;
    // The salt and the payload are no longer needed: keep only what the panel shows.
    st.pending = { round: p.round, account: p.account, committedTx: p.committedTx, revealed: p.revealed, dim: p.dim, norm: p.norm };
    save();
    say(fill(t.revealed, { r: p.round }));
  } catch (e) {
    say(t.failed + (e?.code === 4001 ? 'rejected in the wallet' : String(e?.message ?? e).slice(0, 200)), true);
  } finally {
    busy = false;
    await refreshStatus();
  }
}

// ------------------------------------------------------------ view
function say(text, error = false) { const el = $('fl-status'); if (el) { el.textContent = text; el.className = `fl-status${error ? ' error' : ''}`; } }

function build() {
  const s = make('section', { id: 'fl', class: 'fl' });
  s.append(make('h2', { id: 'fl-title' }), make('p', { id: 'fl-intro', class: 'fl-help' }));
  const lab = make('label', { class: 'fl-check' });
  lab.append(make('input', { id: 'fl-optin', type: 'checkbox' }), make('span', { id: 'fl-optin-text' }));
  s.append(lab, make('p', { id: 'fl-off', class: 'fl-help' }));
  const body = make('div', { id: 'fl-body' });
  body.append(
    make('p', { id: 'fl-wallet-note', class: 'fl-help' }),
    make('h3', { id: 'fl-privacy-title' }), make('p', { id: 'fl-privacy' }),
    make('h3', { id: 'fl-sent-title' }), make('p', { id: 'fl-sent', class: 'fl-help' }),
    make('h3', { id: 'fl-labels-title' }), make('p', { id: 'fl-labels-help', class: 'fl-help' }), make('p', { id: 'fl-reads', class: 'fl-help' }),
    make('ul', { id: 'fl-list', class: 'fl-list' }),
  );
  const tools = make('div', { class: 'fl-actions' });
  tools.append(make('button', { id: 'fl-recheck', type: 'button', class: 'secondary' }), make('button', { id: 'fl-delete', type: 'button', class: 'secondary' }));
  body.append(tools, make('h3', { id: 'fl-round-title' }), make('p', { id: 'fl-round' }), make('p', { id: 'fl-mine' }), make('p', { id: 'fl-preview', class: 'fl-help' }));
  const acts = make('div', { class: 'fl-actions', id: 'fl-wallets' });
  const go = make('div', { class: 'fl-actions' });
  go.append(make('button', { id: 'fl-train', type: 'button' }), make('button', { id: 'fl-reveal', type: 'button' }), make('button', { id: 'fl-refresh', type: 'button', class: 'secondary' }));
  body.append(acts, go);
  s.append(body, make('p', { id: 'fl-status', class: 'fl-status', role: 'status', 'aria-live': 'polite' }));
  const footer = document.querySelector('footer');
  if (footer) footer.before(s); else document.body.append(s);
  // The footer says the page never connects a wallet: say where the one exception is.
  if (footer) footer.querySelector('p')?.after(make('p', { id: 'fl-footer-note' }));

  $('fl-optin').addEventListener('change', async () => {
    st.optIn = $('fl-optin').checked;
    save();
    render();
    if (st.optIn) { await Promise.all([loadDeployment(), loadHeadInfo()]); await refreshStatus(); }
  });
  $('fl-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const entry = st.entries.find((x) => x.id === b.dataset.id);
    if (!entry) return;
    entry.user = b.dataset.v === '1' ? 1 : b.dataset.v === '0' ? 0 : null;
    save(); render();
  });
  $('fl-recheck').addEventListener('click', () => { if (!busy) recheck().catch(() => {}); });
  $('fl-delete').addEventListener('click', () => {
    // The ledger stays: deleting it would let this browser spend its privacy budget again.
    st.entries = []; if (st.pending && !st.pending.committedTx) st.pending = null;
    save(); render(); say(T().deleted);
  });
  $('fl-train').addEventListener('click', () => trainAndCommit());
  $('fl-reveal').addEventListener('click', () => reveal());
  $('fl-refresh').addEventListener('click', () => refreshStatus());
}

function renderWallets(t) {
  const box = $('fl-wallets');
  if (!dep?.deployed) { box.replaceChildren(); return; }
  if (wallet?.account()) { box.replaceChildren(make('span', { class: 'fl-acc' }, fill(t.connected, { a: wallet.account() }))); return; }
  const list = wallet ? wallet.list() : [];
  if (!list.length) { box.replaceChildren(make('span', { class: 'fl-help' }, t.noWallet)); return; }
  box.replaceChildren(...list.map((w) => {
    const b = make('button', { type: 'button', class: 'secondary', 'data-wallet': w.id }, fill(t.connect, { w: w.name }));
    b.addEventListener('click', async () => {
      try { await wallet.connect(w); await refreshStatus(); } catch (e) { say(t.failed + String(e?.message ?? e).slice(0, 200), true); }
    });
    return b;
  }));
}

function renderList(t) {
  const now = Date.now();
  const items = st.entries.slice(0, SHOWN).map((e) => {
    const li = make('li', { 'data-entry': e.id });
    const c = CHAINS[e.chain];
    li.append(make('span', { class: 'fl-token' }, `${c?.name ?? e.chain} · ${short(e.address)} · ${new Date(e.at).toLocaleDateString(lang())}`));
    const f = finalLabel(e, now);
    const lines = [];
    if (e.user === 0 || e.user === 1) lines.push(fill(t.you, { v: t[`v${e.user}`] }));
    if (f.auto.label != null) lines.push(fill(t.auto, { v: `${t[`v${f.auto.label}`]} (${t[`src_${f.auto.source.replace(/-/g, '_')}`]})` }));
    else lines.push(fill(t.autoWait, { v: `${f.auto.source ? `${t[`src_${f.auto.source.replace(/-/g, '_')}`]}: ` : ''}${t[`w_${f.auto.why.replace(/-/g, '_')}`] ?? f.auto.why}` }));
    if (f.conflict) lines.push(t.conflict);
    else if (f.label != null) lines.push(fill(t.used, { v: t[`v${f.label}`] }));
    li.append(make('small', { class: f.conflict ? 'fl-conflict' : '' }, lines.join(' · ')));
    const btns = make('span', { class: 'fl-label-btns' });
    for (const [v, k] of [['1', 'scam'], ['0', 'notScam'], ['', 'clear']]) {
      btns.append(make('button', { type: 'button', class: `secondary${String(e.user ?? '') === v ? ' on' : ''}`, 'data-id': e.id, 'data-v': v, 'aria-pressed': String(String(e.user ?? '') === v && v !== '') }, t[k]));
    }
    li.append(btns);
    return li;
  });
  $('fl-list').replaceChildren(...(items.length ? items : [make('li', { class: 'fl-help' }, t.none)]));
}

function renderRound(t) {
  const el = $('fl-round');
  const p = st.pending;
  let mine = '';
  if (!dep) el.textContent = depError ? `${t.notDeployed}` : '…';
  else if (!dep.deployed) el.textContent = t.notDeployed;
  else if (statusError) el.textContent = t.unreachable;
  else if (!roundStatus) el.textContent = '…';
  else {
    const s = roundStatus;
    const v = { r: String(s.round), n: String(s.blocksLeft), c: String(s.commits), v: String(s.reveals) };
    el.textContent = s.paused ? t.closed : s.phase === 0 ? fill(t.before, v) : fill(s.phase === 1 ? t.phase1 : t.phase2, v);
    const st8 = p && p.round === Number(s.round) ? (p.revealed ? 's_revealed' : p.committedTx ? 's_committed' : 's_none') : (s.revealed ? 's_revealed' : s.committed ? 's_committed' : 's_none');
    mine = fill(t.mine, { s: t[st8] });
  }
  $('fl-mine').textContent = mine;
  $('fl-preview').textContent = p?.dim ? fill(t.preview, { dim: p.dim, norm: Number(p.norm).toFixed(2) }) + (p.missed && !p.revealed ? ` ${fill(t.missed, { r: p.round })}` : '') : '';
  const deployed = !!dep?.deployed;
  const connected = !!wallet?.account();
  $('fl-train').disabled = busy || !deployed || !connected;
  $('fl-reveal').disabled = busy || !deployed || !connected || !(p?.committedTx && !p.revealed && !p.missed);
  $('fl-train').hidden = !deployed;
  $('fl-reveal').hidden = !deployed;
  $('fl-refresh').hidden = !deployed;
}

function render() {
  if (!$('fl')) return;
  const t = T();
  $('fl-title').textContent = t.title;
  $('fl-intro').textContent = t.intro;
  $('fl-optin').checked = st.optIn;
  $('fl-optin-text').textContent = t.optin;
  $('fl-off').textContent = t.off;
  $('fl-off').hidden = st.optIn;
  $('fl-body').hidden = !st.optIn;
  $('fl-footer-note')?.replaceChildren(t.walletNote);
  if (!st.optIn) return;
  const L = ledger();
  const per = epsilonOf(rhoPerRound(PRIVACY.z), PRIVACY.delta);
  const left = Math.max(0, roundsAllowed(PRIVACY.z, PRIVACY.epsBudget, PRIVACY.delta) - L.spent.length);
  $('fl-wallet-note').textContent = t.walletNote;
  $('fl-privacy-title').textContent = t.privacyTitle;
  $('fl-privacy').textContent = fill(t.privacy, { used: L.epsilon.toFixed(2), budget: PRIVACY.epsBudget, per: per.toFixed(2), left });
  $('fl-sent-title').textContent = t.sentTitle;
  $('fl-sent').textContent = fill(t.sent, { dim: headInfo?.dim ?? '…', clip: PRIVACY.clip, sigma: PRIVACY.z * PRIVACY.clip });
  $('fl-labels-title').textContent = t.labelsTitle;
  $('fl-labels-help').textContent = fill(t.labelsHelp, { days: DEFAULT_LABELING.minDelayDays });
  $('fl-reads').textContent = t.readsNote;
  $('fl-recheck').textContent = t.recheck;
  $('fl-delete').textContent = t.deleteData;
  $('fl-round-title').textContent = t.roundTitle;
  $('fl-train').textContent = t.train;
  $('fl-reveal').textContent = t.reveal;
  $('fl-refresh').textContent = t.refresh;
  renderList(t);
  renderRound(t);
  renderWallets(t);
}

// ------------------------------------------------------------ start
build();
render();
document.addEventListener('neuro:report', (e) => { capture(e.detail).catch(() => {}); });
new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
(async () => {
  await Promise.all([loadDeployment(), st.optIn ? loadHeadInfo() : null]);
  const cid = dep?.chainId ?? 77390;
  wallet = createWallet(window, { chainId: cid, chainName: 'ZETAPHY testnet', rpc: dep?.rpc ?? 'https://rpc.sawasdeecoin.com', onChange: () => render() });
  render();
  if (!st.optIn) return;
  await wallet.restore();
  await refreshStatus();
  // Re-read a few due outcomes in the background (opted-in users only; free public endpoints).
  if (dueForRecheck(st.entries).length) setTimeout(() => { if (!busy) recheck(3).catch(() => {}); }, 5000);
})();
setInterval(() => { if (st.optIn && dep?.deployed && !busy && document.visibilityState === 'visible') refreshStatus(); }, 30_000);
