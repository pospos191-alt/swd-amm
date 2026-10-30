// "Private identity" card of the Agents page (agents.js): a zero-knowledge identity over the labelled-human registry
// (docs/future/zk-identity.md).
//   create   two random field elements in this browser (localStorage); export / import an encrypted backup
//   register ZkIdentityRegistry.register(commitment) from the connected, person-labelled account
//   prove    rebuild the Merkle tree from the chain (leavesRange), find our leaf LOCALLY (the RPC never learns which
//            commitment we look for), prove in a Web Worker (zkid-worker.js, the only file with WebAssembly allowed),
//            with the prover files checked against zkid/manifest.json (sha256)
//   claim    PrivateAirdrop.claim from the connected wallet, or the calldata for any relayer
// Contract addresses come from hub-config.json (contracts.zkIdentityRegistry, contracts.privateAirdrop) or are typed
// in. Everything shown is set with textContent.
import { isEvmAddress, short, formatZeta } from './chainlib.js';
import { withFallback } from './i18n.js';
import { ZKID } from './zkid-i18n.js';
import {
  newIdentity, commitment, parseIdentity, identityJson, encryptBackup, decryptBackup, proofInput, proofWords, findLeaf, toHex32,
  SEL, encodeRegister, encodeLeavesRange, encodeSignalOf, encodeClaim, encodeAddr, encodeUint, decodeUintArray,
} from './zkid-core.js';

export const STORE_KEY = 'zetaphy-hub:zkid';
const L = (ctx) => withFallback(ZKID, ctx.lang);
const safe = (f) => { try { return f(); } catch { return null; } };
const local = () => safe(() => globalThis.localStorage);
const say = (node, text, cls = '') => { if (node) { node.textContent = text; node.className = `msg ${cls}`; } };
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const val = (id) => document.querySelector(`#${id}`)?.value.trim() ?? '';
const call = (ctx, to, data) => ctx.evmCall('eth_call', [{ to, data }, 'latest']);
const uint = (hex, i = 0) => BigInt(`0x${(String(hex).replace(/^0x/, '').match(/.{64}/g) ?? [])[i] ?? '0'}`);
const errText = (e) => String(e?.message ?? e).slice(0, 200);

export function loadIdentity() {
  try { const s = local()?.getItem(STORE_KEY); return s ? parseIdentity(JSON.parse(s)) : null; } catch { return null; }
}
function saveIdentity(id) {
  safe(() => (id ? local()?.setItem(STORE_KEY, JSON.stringify(identityJson(id))) : local()?.removeItem(STORE_KEY)));
}

/** All leaves of the registry, in pages of 500. */
export async function readLeaves(ctx, registry) {
  const n = Number(uint(await call(ctx, registry, SEL.leafCount)));
  const out = [];
  for (let from = 0; from < n; from += 500) out.push(...decodeUintArray(await call(ctx, registry, encodeLeavesRange(from, Math.min(500, n - from)))));
  return out;
}

const sha256Hex = async (buf) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (b) => b.toString(16).padStart(2, '0')).join('');
let files = null; // { manifest, wasm, zkey } once loaded and checked
/** The prover files, refused unless their sha256 is the manifest's. */
export async function proverFiles(fetchFn = globalThis.fetch, base = './zkid/') {
  if (files) return files;
  const manifest = await (await fetchFn(`${base}manifest.json`)).json();
  const get = async (f) => { const r = await fetchFn(`${base}${f.file}`); if (!r.ok) throw new Error(`${f.file}: HTTP ${r.status}`); return r.arrayBuffer(); };
  const [wasm, zkey] = await Promise.all([get(manifest.wasm), get(manifest.zkey)]);
  if (await sha256Hex(wasm) !== manifest.wasm.sha256 || await sha256Hex(zkey) !== manifest.zkey.sha256) throw new Error('bad-files');
  files = { manifest, wasm, zkey };
  return files;
}

/** One proof in a fresh worker (ended afterwards). */
function proveInWorker(input, { wasm, zkey }) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./zkid-worker.js', import.meta.url)); } catch (e) { reject(new Error('no-worker')); return; }
    w.onmessage = (e) => { w.terminate(); e.data?.error ? reject(new Error(e.data.error)) : resolve(e.data); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'no-worker')); };
    w.postMessage({ input, wasm: wasm.slice(0), zkey: zkey.slice(0) });
  });
}

function showStatus(ctx) {
  const t = L(ctx);
  const id = loadIdentity();
  const node = document.querySelector('#zk-id');
  if (node) node.textContent = id ? fill(t.ready, { c: short(toHex32(commitment(id)), 10, 8) }) : t.none;
  for (const b of ['zk-register', 'zk-export', 'zk-forget', 'zk-prove']) { const n = document.querySelector(`#${b}`); if (n) n.disabled = !id; }
  const c = document.querySelector('#zk-create');
  if (c) c.disabled = Boolean(id);
}

let forgetArmed = false;
function forget(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#zk-msg');
  if (!forgetArmed) { forgetArmed = true; say(msg, t.forgetAgain, 'bad'); return; }
  forgetArmed = false;
  saveIdentity(null);
  showStatus(ctx);
  say(msg, t.forgotten, 'ok');
}

function create(ctx) {
  if (loadIdentity()) return;
  saveIdentity(newIdentity());
  showStatus(ctx);
  say(document.querySelector('#zk-msg'), L(ctx).created, 'ok');
}

async function register(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#zk-msg');
  const reg = val('zk-reg');
  const id = loadIdentity();
  if (!id) return;
  if (!isEvmAddress(reg)) { say(msg, t.badAddr, 'bad'); return; }
  try {
    const account = ctx.account() ?? await ctx.connect();
    const level = Number(uint(await call(ctx, reg, encodeAddr(SEL.levelNow, account))));
    if (!level) { say(msg, t.notHuman, 'bad'); return; }
    await ctx.send(reg, encodeRegister(commitment(id)), t.registerAction);
    say(msg, fill(t.registered, { level }), 'ok');
  } catch (e) { say(msg, errText(e), 'bad'); }
}

async function exportBackup(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#zk-msg');
  const id = loadIdentity();
  if (!id) return;
  const pw = document.querySelector('#zk-pw')?.value ?? '';
  if (pw.length < 8) { say(msg, t.pwShort, 'bad'); return; }
  try {
    const b = await encryptBackup(id, pw);
    const a = ctx.el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' })), download: 'zetaphy-identity-backup.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    say(msg, t.exported, 'ok');
  } catch (e) { say(msg, errText(e), 'bad'); }
}

async function importBackup(ctx, file) {
  const t = L(ctx);
  const msg = document.querySelector('#zk-msg');
  const pw = document.querySelector('#zk-pw')?.value ?? '';
  if (!file) return;
  if (pw.length < 8) { say(msg, t.pwShort, 'bad'); return; }
  try {
    const id = await decryptBackup(await file.text(), pw);
    saveIdentity(id);
    showStatus(ctx);
    say(msg, t.imported, 'ok');
  } catch (e) {
    say(msg, e?.message === 'bad-password' ? t.badPassword : t.badBackup, 'bad');
  }
}

let ready = null; // { airdrop, data } of the last proof
async function prove(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#zk-cmsg');
  const out = document.querySelector('#zk-out');
  out.replaceChildren();
  ready = null;
  const [reg, drop, recipient, feeText] = [val('zk-reg'), val('zk-drop'), val('zk-to'), val('zk-fee') || '0'];
  const id = loadIdentity();
  if (!id) return;
  if (![reg, drop, recipient].every(isEvmAddress)) { say(msg, t.badAddr, 'bad'); return; }
  if (!/^\d{1,40}$/.test(feeText)) { say(msg, t.badFee, 'bad'); return; }
  const fee = BigInt(feeText);
  try {
    if (typeof Worker === 'undefined') throw new Error('no-worker');
    const [scope, minLevel, amount] = (await Promise.all([SEL.scope, SEL.minLevel, SEL.amount].map((s) => call(ctx, drop, s)))).map((h) => uint(h));
    if (fee > amount) { say(msg, t.badFee, 'bad'); return; }
    const signalHash = uint(await call(ctx, drop, encodeSignalOf(recipient, fee)));
    const leaves = await readLeaves(ctx, reg);
    const where = findLeaf(leaves, id);
    if (!where) { say(msg, t.notMember, 'bad'); return; }
    if (where.level < Number(minLevel)) { say(msg, fill(t.levelLow, { need: minLevel, level: where.level }), 'bad'); return; }
    const { input } = proofInput({ id, leaves, scope, signalHash, minLevel });
    if (uint(await call(ctx, drop, encodeUint(SEL.nullifierUsed, BigInt(input.nullifier))))) { say(msg, t.already, 'bad'); return; }
    out.append(ctx.el('p', { class: 'dim small', text: fill(t.members, { n: leaves.filter((x) => x !== 0n).length }) }));
    say(msg, fill(t.loading, { mb: '5.1' }));
    const f = await proverFiles();
    say(msg, t.proving);
    const r = await proveInWorker(input, f);
    const words = proofWords(r.proof);
    const data = encodeClaim(recipient, fee, BigInt(r.publicSignals[0]), BigInt(r.publicSignals[1]), words);
    ready = { drop, data };
    const relay = JSON.stringify({ to: drop, data, recipient, fee: String(fee), amount: `${formatZeta(amount)} ZTPHY` }, null, 1);
    out.append(
      ctx.el('p', { class: 'dim small', text: fill(t.proved, { s: (r.ms / 1000).toFixed(1), n: short(toHex32(BigInt(r.publicSignals[1])), 10, 8) }) }),
      ctx.el('p', { class: 'warnline small', text: t.linkWarn }),
      ctx.el('div', { class: 'row' }, ctx.el('button', { type: 'button', class: 'btn', id: 'zk-send', text: t.sendClaim, onclick: () => sendClaim(ctx) })),
      ctx.el('p', { class: 'dim small', text: t.relayer }),
      ctx.el('div', { class: 'code' }, ctx.el('pre', { class: 'mono', text: relay }), ctx.copyBtn(relay)));
    say(msg, '');
  } catch (e) {
    const m = e?.message === 'bad-files' ? t.badFiles : e?.message === 'no-worker' ? t.noWorker : errText(e);
    say(msg, m, 'bad');
  }
}

async function sendClaim(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#zk-cmsg');
  if (!ready) return;
  try {
    await ctx.send(ready.drop, ready.data, t.claimAction);
    say(msg, t.claimed, 'ok');
  } catch (e) { say(msg, errText(e), 'bad'); }
}

/** The card (agents.js puts it in the right-hand column). */
export function zkidCard(ctx) {
  const t = L(ctx);
  const el = ctx.el;
  forgetArmed = false;
  ready = null;
  const input = (id, attrs) => el('input', { id, spellcheck: 'false', autocomplete: 'off', ...attrs });
  const file = el('input', { type: 'file', id: 'zk-file', accept: '.json,application/json', hidden: true, onchange: (e) => importBackup(ctx, e.target.files?.[0]) });
  const card = el('div', { class: 'card ag-card', id: 'zk-card' },
    el('div', { class: 'card-head' }, el('h2', { text: t.title }), el('span', { class: 'info', tabindex: 0, 'data-tip': t.tip, text: 'i' })),
    el('p', { class: 'dim small', text: t.intro }),
    el('div', { class: 'sp-form' },
      el('label', { for: 'zk-reg', text: t.registry }), input('zk-reg', { class: 'mono', value: ctx.cfg?.contracts?.zkIdentityRegistry ?? '', placeholder: '0x…' }),
      el('label', { for: 'zk-drop', text: t.airdrop }), input('zk-drop', { class: 'mono', value: ctx.cfg?.contracts?.privateAirdrop ?? '', placeholder: '0x…' })),
    el('p', { class: 'mono small', id: 'zk-id', role: 'status' }),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn', id: 'zk-create', text: t.create, onclick: () => create(ctx) }),
      el('button', { type: 'button', class: 'btn', id: 'zk-register', text: t.register, onclick: () => register(ctx) }),
      el('button', { type: 'button', class: 'btn ghost', id: 'zk-forget', text: t.forget, onclick: () => forget(ctx) })),
    el('details', {}, el('summary', { text: t.backup }),
      el('div', { class: 'sp-form' }, el('label', { for: 'zk-pw', text: t.password }), input('zk-pw', { type: 'password', minlength: 8 })),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn ghost', id: 'zk-export', text: t.exportBackup, onclick: () => exportBackup(ctx) }),
        el('button', { type: 'button', class: 'btn ghost', id: 'zk-import', text: t.importBackup, onclick: () => file.click() }), file)),
    el('p', { class: 'msg', id: 'zk-msg', role: 'status', 'aria-live': 'polite' }),
    el('h3', { text: t.claimTitle }),
    el('div', { class: 'sp-form' },
      el('label', { for: 'zk-to', text: t.recipient, 'data-tip': t.tipRecipient }), input('zk-to', { class: 'mono', placeholder: '0x…' }),
      el('label', { for: 'zk-fee', text: t.fee, 'data-tip': t.tipFee }), input('zk-fee', { inputmode: 'numeric', value: '0' })),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn', id: 'zk-prove', text: t.prove, onclick: () => prove(ctx) })),
    el('div', { id: 'zk-out' }),
    el('p', { class: 'msg', id: 'zk-cmsg', role: 'status', 'aria-live': 'polite' }),
    el('p', { class: 'warnline small', text: t.limits }));
  queueMicrotask(() => showStatus(ctx));
  return card;
}

