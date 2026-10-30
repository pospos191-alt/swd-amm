// The hub's "Offline" tab (docs/future/offline-trading.md): trade on ZETAPHY with no internet for a while.
//   - Cheques (ZetaphyCheques): online once, the payer opens a channel whose cheques are signed by a dedicated
//     offline key that this page makes and keeps ENCRYPTED in this browser (AES-GCM, key from PBKDF2-SHA256 of a
//     passphrase, offline-core.js). Offline, the payer signs a cheque and shows it as a QR code / text / file; the
//     payee scans or pastes it and checks it with no network against the channel as last synced; the best cheque is
//     kept here and cashed when back online.
//   - Swap orders (ZetaphyOfflineOrders): signed offline, carried as a QR code / text; anyone relays them online
//     (checked offline, simulated with eth_call, then sent from the relayer's wallet, which earns the fee).
//   - Offline cash and Mesh (offline-cash.js, docs/future/offline-cash.md): bonded bearer notes signed over hand to hand
//     with a post-quantum key, checked offline with a proof of funds; any of these as SMS / LoRa / QR frames.
// The first visit registers the hub's service worker (sw.js: the static app shell only, never RPC data), so the
// hub and this tab load with no network. Everything shown goes in with textContent; no inline styles (CSP).
import { withFallback } from './i18n.js';
import { OFFLINE } from './offline-i18n.js';
import * as core from './offline-core.js';
import { cashCards } from './offline-cash.js';

export const OF = (lang) => withFallback(OFFLINE, lang);
const STORE = 'zetaphy-offline:v1';
const LOCK_AFTER_MS = 15 * 60 * 1000;
/** ZETAPHY's native coin as an ERC-20 (the router's WETH() on chain 77390): sell native ZETAPHY in an order with it. */
export const NATIVE_ERC20 = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// ---------------------------------------------------------------- what this browser keeps (localStorage, in try/catch)

const empty = () => ({ key: null, channels: {}, signed: {}, cheques: {}, orders: [] });
/** The stored state, cleaned (anything malformed is dropped, never trusted). */
export function cleanState(j) {
  const s = empty();
  if (!j || typeof j !== 'object') return s;
  if (j.key && typeof j.key === 'object' && core.isAddr(j.key.address)) s.key = j.key;
  const cid = /^0x[0-9a-f]{40}:\d{1,20}$/;
  for (const [k, c] of Object.entries(j.channels ?? {})) {
    if (!cid.test(k) || !c || !core.isAddr(c.signer) || !core.isAddr(c.payee) || !core.isAddr(c.payer) || !/^\d{1,78}$/.test(String(c.deposit))) continue;
    s.channels[k] = { payer: core.lc(c.payer), payee: core.lc(c.payee), token: core.isAddr(c.token) ? core.lc(c.token) : core.NATIVE, signer: core.lc(c.signer),
      deposit: String(c.deposit), paid: /^\d{1,78}$/.test(String(c.paid)) ? String(c.paid) : '0', expiry: Number(c.expiry) || 0, closeAt: Number(c.closeAt) || 0,
      done: c.done === true, syncedAt: Number(c.syncedAt) || 0, symbol: typeof c.symbol === 'string' ? c.symbol.slice(0, 12) : 'ZTPHY',
      decimals: Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 36 ? c.decimals : 18 };
  }
  for (const [k, v] of Object.entries(j.signed ?? {})) if (cid.test(k) && /^\d{1,78}$/.test(String(v))) s.signed[k] = String(v);
  for (const [k, v] of Object.entries(j.cheques ?? {})) {
    try { const c = core.decodeCheque(v?.text); if (cid.test(k)) s.cheques[k] = { text: v.text, cumulative: c.cumulative, at: Number(v.at) || 0 }; } catch { /* dropped */ }
  }
  if (Array.isArray(j.orders)) for (const o of j.orders.slice(-50)) { try { core.decodeOrder(o?.text); s.orders.push({ text: o.text, at: Number(o.at) || 0 }); } catch { /* dropped */ } }
  return s;
}
function load() { try { return cleanState(JSON.parse(localStorage.getItem(STORE) ?? 'null')); } catch { return empty(); } }
function save(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); return true; } catch { return false; } }
export const channelKey = (contract, id) => `${core.lc(contract)}:${BigInt(id)}`;

// ---------------------------------------------------------------- libraries (from this site: the wallet's bundle, the QR encoder)

let libsP = null;
const libs = () => (libsP ??= Promise.all([import('./wallet/vendor/pqwallet.js'), import('./vendor/qrcode.js')])
  .then(([w, q]) => ({ secp: w.secp256k1, keccak: w.keccak_256, qrcode: q.default ?? q.qrcode })));

let unlocked = null; // { sk, address } in memory only
let lockTimer = null;
function setUnlocked(k) {
  if (unlocked?.sk) unlocked.sk.fill(0);
  unlocked = k;
  clearTimeout(lockTimer);
  if (k) lockTimer = setTimeout(() => { setUnlocked(null); redraw?.(); }, LOCK_AFTER_MS);
}
let redraw = null;

// ---------------------------------------------------------------- small views

const online = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
const nowSec = () => Math.floor(Date.now() / 1000);
const fmtTime = (ctx, t) => { const d = new Date(Number(t) * 1000); return t && Number.isFinite(d.getTime()) ? d.toLocaleString(ctx.lang === 'en' ? 'en-GB' : ctx.lang) : '–'; };
function fmtDur(L, secs) {
  const s = Math.abs(Math.round(secs));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? L.dur(d, h, 'd') : h ? L.dur(h, m, 'h') : L.dur(m, 0, 'm');
}
const say = (ctx, box, text, cls = 'msg') => box.replaceChildren(ctx.el('p', { class: cls, text }));
const errText = (e) => String(e?.message ?? e).slice(0, 200);

/** The QR code of `text` as an SVG (one path; colours from hub.css). */
export function qrSvg(qrcode, text, doc = document) {
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount(), pad = 4;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + pad} ${y + pad}h1v1h-1z`;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + 2 * pad} ${n + 2 * pad}`);
  svg.setAttribute('class', 'off-qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = doc.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(n + 2 * pad)); bg.setAttribute('height', String(n + 2 * pad)); bg.setAttribute('class', 'off-qr-bg');
  const p = doc.createElementNS(NS, 'path');
  p.setAttribute('d', d); p.setAttribute('class', 'off-qr-fg');
  svg.append(bg, p);
  return svg;
}

/** A QR code, the text, Copy and Download: how a signed cheque / order leaves this device. */
async function shareBox(ctx, L, text, file, label) {
  const { qrcode } = await libs();
  const el = ctx.el;
  const svg = qrSvg(qrcode, text);
  svg.setAttribute('aria-label', label);
  const ta = el('textarea', { class: 'mono off-text', id: 'off-out-text', readonly: true, rows: 3, 'aria-label': label });
  ta.value = text;
  const dl = el('button', { type: 'button', class: 'btn ghost sm', text: L.download, onclick: () => {
    try {
      const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: file });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch { /* no downloads here */ }
  } });
  return el('div', { class: 'off-share' }, svg, el('div', { class: 'off-share-side' }, ta, el('div', { class: 'row' }, ctx.copyBtn(text), dl)));
}

/** Reads a payload from a picked file: text (.txt / .json) or a QR photo when the browser has BarcodeDetector. */
async function readPicked(file, L) {
  if (!file) return '';
  if (/^text\/|json$/.test(file.type) || /\.(txt|json)$/i.test(file.name)) return (await file.text()).trim().slice(0, core.MAX_PAYLOAD + 10);
  if (typeof globalThis.BarcodeDetector !== 'function') throw new Error(L.noDetector);
  const det = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
  const bmp = await createImageBitmap(file);
  const codes = await det.detect(bmp);
  const hit = codes.map((c) => String(c.rawValue ?? '')).find((t) => core.payloadKind(t));
  if (!hit) throw new Error(L.noCode);
  return hit.trim();
}
/** A paste box with a "QR photo / file" picker; `onText(text)` gets what was read. */
function inputBox(ctx, L, id, onText) {
  const el = ctx.el;
  const ta = el('textarea', { id, class: 'mono off-text', rows: 3, spellcheck: 'false', autocomplete: 'off', placeholder: L.pasteHere, 'aria-label': L.pasteHere });
  const msg = el('p', { class: 'msg small', role: 'status' });
  const pick = el('input', { type: 'file', accept: 'image/*,.txt,.json,text/plain', class: 'off-file', id: `${id}-file`, 'aria-label': L.scanPhoto });
  pick.addEventListener('change', async () => {
    try { const t = await readPicked(pick.files?.[0], L); ta.value = t; msg.textContent = ''; onText(t); } catch (e) { say(ctx, msg, errText(e), 'msg bad'); }
    pick.value = '';
  });
  const pickLabel = el('label', { class: 'btn ghost sm off-pick', for: `${id}-file`, text: typeof globalThis.BarcodeDetector === 'function' ? L.scanPhoto : L.openFile });
  return { node: el('div', { class: 'off-in' }, ta, el('div', { class: 'row' }, pickLabel, pick), msg), ta };
}

// ---------------------------------------------------------------- chain reads (online)

const call = (ctx, to, data) => ctx.evmCall('eth_call', [{ to, data }, 'latest']);
async function syncChannel(ctx, contract, id, s) {
  const ch = core.decodeChannel(await call(ctx, contract, core.encodeChannel(id)));
  if (!ch) return null;
  let symbol = 'ZTPHY', decimals = 18;
  if (ch.token !== core.NATIVE) {
    const known = (ctx.cfg.tokens ?? []).find((t) => core.lc(t.address) === ch.token);
    symbol = known?.symbol ?? ctx.short(ch.token, 6, 4);
    try { decimals = Number(BigInt(await call(ctx, ch.token, core.SEL.decimals))); } catch { decimals = known?.decimals ?? 18; }
  }
  const k = channelKey(contract, id);
  s.channels[k] = cleanState({ channels: { [k]: { ...ch, syncedAt: nowSec(), symbol, decimals } } }).channels[k];
  return s.channels[k];
}

// ---------------------------------------------------------------- the page

const page = {
  render(root, ctx) {
    const L = OF(ctx.lang);
    const el = ctx.el;
    const C = ctx.cfg.contracts ?? {};
    const cheques = core.isAddr(C.zetaphyCheques) ? C.zetaphyCheques : null;
    const orders = core.isAddr(C.offlineOrders) ? C.offlineOrders : null;
    registerShell(ctx, root);
    const card = (id, title, tip, ...kids) => el('div', { class: 'card off-card', id },
      el('div', { class: 'card-head' }, el('h2', { text: title }), tip ? el('span', { class: 'info', 'data-tip': tip, tabindex: 0, text: 'i' }) : null), ...kids);
    const field = (label, input) => el('label', { class: 'off-field' }, el('span', { class: 'dim small', text: label }), input);

    // ---- the offline key
    const keyBox = el('div', { id: 'off-key' });
    function drawKey() {
      const s = load();
      const kids = [];
      if (!s.key) {
        const p1 = el('input', { type: 'password', id: 'off-pass', autocomplete: 'new-password', placeholder: L.passphrase, 'aria-label': L.passphrase });
        const p2 = el('input', { type: 'password', id: 'off-pass2', autocomplete: 'new-password', placeholder: L.passphrase2, 'aria-label': L.passphrase2 });
        const out = el('p', { class: 'msg small', role: 'status' });
        const f = el('form', { class: 'off-form', id: 'off-create-form', autocomplete: 'off' }, p1, p2, el('button', { type: 'submit', class: 'btn sm', id: 'off-create', text: L.create }), out);
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (p1.value.length < 10) return say(ctx, out, L.passShort, 'msg bad');
          if (p1.value !== p2.value) return say(ctx, out, L.passMismatch, 'msg bad');
          say(ctx, out, '…');
          try {
            const { secp, keccak } = await libs();
            const k = core.newKey(secp, keccak);
            const blob = await core.encryptKey({}, k.sk, p1.value, k.address);
            const st = load(); st.key = blob;
            if (!save(st)) throw new Error(L.noStorage);
            setUnlocked(k);
            p1.value = ''; p2.value = '';
            drawAll();
          } catch (err) { say(ctx, out, errText(err), 'msg bad'); }
        });
        kids.push(el('p', { class: 'small', text: L.keyNone }), f);
      } else {
        const addr = s.key.address;
        kids.push(el('dl', { class: 'kv3' }, el('dt', { text: L.keyAddress }), el('dd', { class: 'mono', id: 'off-key-addr', text: addr }),
          el('dt', { text: L.keyState }), el('dd', { id: 'off-key-state', 'data-state': unlocked ? 'unlocked' : 'locked', text: unlocked ? L.unlocked : L.locked })));
        if (!unlocked) {
          const p = el('input', { type: 'password', id: 'off-unlock-pass', autocomplete: 'current-password', placeholder: L.passphrase, 'aria-label': L.passphrase });
          const out = el('p', { class: 'msg small', role: 'status' });
          const f = el('form', { class: 'row', id: 'off-unlock-form', autocomplete: 'off' }, p, el('button', { type: 'submit', class: 'btn sm', id: 'off-unlock', text: L.unlock }));
          f.addEventListener('submit', async (e) => {
            e.preventDefault();
            say(ctx, out, '…');
            try {
              const { secp, keccak } = await libs();
              const sk = await core.decryptKey({}, load().key, p.value);
              if (core.lc(core.addressOf(secp, keccak, sk)) !== core.lc(addr)) throw new Error('passphrase');
              p.value = '';
              setUnlocked({ sk, address: addr });
              drawAll();
            } catch { say(ctx, out, L.passWrong, 'msg bad'); }
          });
          kids.push(f, out);
        } else kids.push(el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn ghost sm', id: 'off-lock', text: L.lock, onclick: () => { setUnlocked(null); drawAll(); } })));
        const io = el('p', { class: 'msg small', role: 'status' });
        const imp = el('input', { type: 'file', accept: '.json,application/json', class: 'off-file', id: 'off-key-import', 'aria-label': L.importKey });
        imp.addEventListener('change', async () => {
          try {
            const blob = JSON.parse(await imp.files[0].text());
            if (blob?.v !== 1 || !core.isAddr(blob.address)) throw new Error('blob');
            if (!confirm(L.replaceConfirm)) return;
            const st = load(); st.key = blob; save(st); setUnlocked(null); drawAll();
          } catch { say(ctx, io, L.badBackup, 'msg bad'); }
          imp.value = '';
        });
        kids.push(el('div', { class: 'row wrap' },
          el('button', { type: 'button', class: 'btn ghost sm', id: 'off-key-export', text: L.exportKey, onclick: () => {
            try {
              const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(load().key, null, 2)], { type: 'application/json' })), download: `zetaphy-offline-key-${addr.slice(2, 8)}.json` });
              document.body.append(a); a.click(); a.remove();
            } catch { /* no downloads */ }
          } }),
          el('label', { class: 'btn ghost sm off-pick', for: 'off-key-import', text: L.importKey }), imp,
          el('button', { type: 'button', class: 'btn ghost sm', id: 'off-key-forget', text: L.forget, onclick: () => {
            if (!confirm(L.forgetConfirm)) return;
            const st = load(); st.key = null; save(st); setUnlocked(null); drawAll();
          } })), io);
      }
      keyBox.replaceChildren(...kids);
    }

    // ---- channels: open (online), sync, list
    const chBox = el('div', { id: 'off-ch-list' });
    const openOut = el('p', { class: 'msg small', role: 'status' });
    const payeeIn = el('input', { id: 'off-open-payee', class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: '0x…', 'aria-label': L.payee });
    const amtIn = el('input', { id: 'off-open-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '10', 'aria-label': L.depositAmount });
    const daysIn = el('input', { id: 'off-open-days', inputmode: 'numeric', autocomplete: 'off', value: '30', 'aria-label': L.days });
    const openForm = el('form', { class: 'off-form', id: 'off-open-form', autocomplete: 'off' },
      field(L.payee, payeeIn), field(L.depositAmount, amtIn), field(L.days, daysIn), el('button', { type: 'submit', class: 'btn sm', id: 'off-open', text: L.openBtn }), openOut);
    openForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const s = load();
      if (!cheques) return say(ctx, openOut, L.notDeployed, 'msg bad');
      if (!s.key) return say(ctx, openOut, L.needKey, 'msg bad');
      if (!online()) return say(ctx, openOut, L.needOnline, 'msg bad');
      const payee = payeeIn.value.trim();
      if (!core.isAddr(payee)) return say(ctx, openOut, L.badAddress, 'msg bad');
      let amount, days;
      try { amount = core.parseAmount(amtIn.value, 18); if (!amount) throw new Error(); } catch { return say(ctx, openOut, L.badAmount, 'msg bad'); }
      days = Number(daysIn.value);
      if (!Number.isInteger(days) || days < 1 || days > 365) return say(ctx, openOut, L.badDays, 'msg bad');
      const expiry = nowSec() + days * 86400;
      try {
        say(ctx, openOut, L.sending);
        const hash = await ctx.send(cheques, core.encodeOpen(payee, core.NATIVE, amount, expiry, s.key.address), L.openAction(core.formatAmount(amount), ctx.short(payee), days), amount);
        const rc = await ctx.evmCall('eth_getTransactionReceipt', [hash]);
        const id = core.channelIdFromReceipt(rc, cheques);
        const st = load();
        if (id) await syncChannel(ctx, cheques, id, st);
        save(st);
        say(ctx, openOut, id ? L.opened(id) : L.done, 'msg ok');
        drawAll();
      } catch (err) { say(ctx, openOut, errText(err), 'msg bad'); }
    });
    const syncIn = el('input', { id: 'off-sync-id', inputmode: 'numeric', autocomplete: 'off', placeholder: '1', 'aria-label': L.channelId });
    const syncOut = el('p', { class: 'msg small', role: 'status' });
    const syncForm = el('form', { class: 'row', id: 'off-sync-form', autocomplete: 'off' }, syncIn, el('button', { type: 'submit', class: 'btn sm', id: 'off-sync', text: L.syncBtn }));
    syncForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!cheques) return say(ctx, syncOut, L.notDeployed, 'msg bad');
      if (!online()) return say(ctx, syncOut, L.needOnline, 'msg bad');
      if (!/^\d{1,20}$/.test(syncIn.value.trim()) || BigInt(syncIn.value.trim()) === 0n) return say(ctx, syncOut, L.badId, 'msg bad');
      try {
        const st = load();
        const ch = await syncChannel(ctx, cheques, syncIn.value.trim(), st);
        if (!ch) return say(ctx, syncOut, L.noSuchChannel, 'msg bad');
        save(st);
        say(ctx, syncOut, L.synced, 'msg ok');
        drawAll();
      } catch (err) { say(ctx, syncOut, `${L.readFailed}: ${errText(err)}`, 'msg bad'); }
    });

    const roleOf = (s, c) => (s.key && core.lc(c.signer) === core.lc(s.key.address) ? 'payer' : 'payee');
    function drawChannels() {
      const s = load();
      const list = Object.entries(s.channels).filter(([k]) => cheques && k.startsWith(`${core.lc(cheques)}:`));
      if (!list.length) { chBox.replaceChildren(el('p', { class: 'dim small', text: L.noChannels })); return; }
      chBox.replaceChildren(el('table', { class: 'tbl off-ch' }, el('tbody', {}, list.map(([k, c]) => {
        const id = k.split(':')[1];
        const role = roleOf(s, c);
        const sym = c.symbol, dec = c.decimals;
        const signed = BigInt(s.signed[k] ?? '0'), best = BigInt(s.cheques[k]?.cumulative ?? '0');
        const out = el('span', { class: 'small', role: 'status' });
        const btns = [];
        const now = nowSec();
        const act = async (data, action) => {
          try { say(ctx, out, L.sending, 'small'); await ctx.send(cheques, data, action); const st = load(); await syncChannel(ctx, cheques, id, st); save(st); drawAll(); } catch (err) { say(ctx, out, errText(err), 'small bad'); }
        };
        btns.push(el('button', { type: 'button', class: 'btn ghost sm', 'data-act': 'sync', text: L.sync, onclick: async () => {
          try { const st = load(); await syncChannel(ctx, cheques, id, st); save(st); drawAll(); } catch (err) { say(ctx, out, errText(err), 'small bad'); }
        } }));
        if (role === 'payer' && !c.done && c.closeAt === 0 && now >= c.expiry) btns.push(el('button', { type: 'button', class: 'btn sm', 'data-act': 'close', text: L.startClose, onclick: () => act(core.encodeStartClose(id), L.closeAction(id)) }));
        if (role === 'payer' && !c.done && c.closeAt !== 0 && now >= c.closeAt) btns.push(el('button', { type: 'button', class: 'btn sm', 'data-act': 'withdraw', text: L.withdraw, onclick: () => act(core.encodeWithdraw(id), L.withdrawAction(id)) }));
        if (role === 'payee' && best > BigInt(c.paid) && !c.done && (c.closeAt === 0 || now < c.closeAt)) {
          const ch = core.decodeCheque(s.cheques[k].text);
          btns.push(el('button', { type: 'button', class: 'btn sm', 'data-act': 'cash', text: L.cash, onclick: () => act(core.encodeCash(id, ch.cumulative, ch.sig), L.cashAction(id, core.formatAmount(best, dec), sym)) }));
        }
        const state = c.done ? L.stDone : c.closeAt ? L.stClosing(fmtTime(ctx, c.closeAt)) : now >= c.expiry ? L.stExpired : L.stOpen(fmtDur(L, c.expiry - now));
        const money = role === 'payer'
          ? L.payerLine(core.formatAmount(c.deposit, dec), core.formatAmount(signed, dec), core.formatAmount(BigInt(c.deposit) - signed > 0n ? BigInt(c.deposit) - signed : 0n, dec), sym)
          : L.payeeLine(core.formatAmount(c.deposit, dec), core.formatAmount(best, dec), core.formatAmount(c.paid, dec), sym);
        return el('tr', { 'data-ch': id, 'data-role': role },
          el('td', { class: 'mono', text: `#${id}` }),
          el('td', {}, el('div', { text: role === 'payer' ? L.rolePayer(ctx.short(c.payee)) : L.rolePayee(ctx.short(c.payer)) }), el('div', { class: 'dim small', text: money }),
            el('div', { class: 'dim small', text: `${state} · ${L.asOf(fmtTime(ctx, c.syncedAt))}` })),
          el('td', {}, el('div', { class: 'row wrap' }, ...btns), out));
      }))));
    }

    // ---- write a cheque (offline)
    const wSel = el('select', { id: 'off-write-ch', 'aria-label': L.chooseChannel });
    const wAmt = el('input', { id: 'off-write-amt', inputmode: 'decimal', autocomplete: 'off', placeholder: '1.5', 'aria-label': L.payAmount });
    const wOut = el('div', { id: 'off-write-out', role: 'status' });
    const wForm = el('form', { class: 'off-form', id: 'off-write-form', autocomplete: 'off' }, field(L.chooseChannel, wSel), field(L.payAmount, wAmt),
      el('button', { type: 'submit', class: 'btn', id: 'off-write', text: L.writeBtn }), wOut);
    function drawWriteSelect() {
      const s = load();
      const mine = Object.entries(s.channels).filter(([k, c]) => cheques && k.startsWith(`${core.lc(cheques)}:`) && roleOf(s, c) === 'payer' && !c.done && c.closeAt === 0);
      wSel.replaceChildren(...(mine.length ? mine.map(([k, c]) => el('option', { value: k, text: `#${k.split(':')[1]} → ${ctx.short(c.payee)} (${c.symbol})` })) : [el('option', { value: '', text: L.noPayerChannel })]));
    }
    wForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const s = load();
      const k = wSel.value, c = s.channels[k];
      if (!c) return say(ctx, wOut, L.noPayerChannel, 'msg bad');
      if (!unlocked || core.lc(unlocked.address) !== core.lc(c.signer)) return say(ctx, wOut, L.unlockFirst, 'msg bad');
      let amount;
      try { amount = core.parseAmount(wAmt.value, c.decimals); if (!amount) throw new Error(); } catch { return say(ctx, wOut, L.badAmount, 'msg bad'); }
      const total = BigInt(s.signed[k] ?? '0') + amount;
      if (total > BigInt(c.deposit)) return say(ctx, wOut, L.overLeft(core.formatAmount(BigInt(c.deposit) - BigInt(s.signed[k] ?? '0'), c.decimals), c.symbol), 'msg bad');
      try {
        const { secp, keccak } = await libs();
        const [contract, id] = k.split(':');
        const sig = core.signDigest(secp, core.chequeDigest(keccak, { contract, channelId: id, cumulative: total }), unlocked.sk);
        const text = core.encodeCheque({ contract, channelId: id, cumulative: total, sig });
        // remember the new total BEFORE showing it: the next cheque builds on it
        s.signed[k] = total.toString();
        if (!save(s)) throw new Error(L.noStorage);
        wAmt.value = '';
        const box = await shareBox(ctx, L, text, `zetaphy-cheque-${id}-${total}.txt`, L.chequeQr);
        wOut.replaceChildren(el('p', { class: 'msg ok', id: 'off-write-ok', text: L.chequeMade(core.formatAmount(amount, c.decimals), core.formatAmount(total, c.decimals), c.symbol) }), box,
          el('p', { class: 'dim small', text: L.chequeShow }));
        drawChannels();
      } catch (err) { say(ctx, wOut, errText(err), 'msg bad'); }
    });

    // ---- receive a cheque (offline check)
    const rOut = el('div', { id: 'off-recv-out', role: 'status' });
    const rIn = inputBox(ctx, L, 'off-recv-text', () => checkCheque());
    async function checkCheque() {
      const text = rIn.ta.value.trim();
      if (!text) return;
      let ch;
      try { ch = core.decodeCheque(text); } catch { return rOut.replaceChildren(el('p', { class: 'msg bad', 'data-ok': '0', text: core.payloadKind(text) === 'order' ? L.isOrder : L.badFormat })); }
      const { secp, keccak } = await libs();
      const s = load();
      const k = channelKey(ch.contract, ch.channelId);
      const snap = s.channels[k] ?? null;
      const v = core.verifyCheque(ch, { snapshot: snap, lastSeen: BigInt(s.cheques[k]?.cumulative ?? '0'), me: ctx.account?.() ?? null, keccak, secp, contract: cheques ?? ch.contract });
      const dec = snap?.decimals ?? 18, sym = snap?.symbol ?? 'ZTPHY';
      const kids = [el('p', { class: v.ok ? 'msg ok off-verdict' : 'msg bad off-verdict', 'data-ok': v.ok ? '1' : '0',
        text: v.ok ? L.chequeOk(core.formatAmount(v.covered, dec), core.formatAmount(ch.cumulative, dec), sym, ch.channelId) : L.chequeBad })];
      kids.push(el('ul', { class: 'off-problems small' }, v.problems.map((p) => el('li', { class: p.level === 'bad' ? 'bad' : 'warnline', 'data-code': p.code, text: L.problem[p.code] ?? p.code }))));
      if (snap) {
        kids.push(el('dl', { class: 'kv3 small' },
          el('dt', { text: L.depositAsOf }), el('dd', { text: `${core.formatAmount(snap.deposit, dec)} ${sym} · ${L.asOf(fmtTime(ctx, snap.syncedAt))}` }),
          el('dt', { text: L.expiry }), el('dd', { text: v.expiresIn > 0 ? L.expiresIn(fmtDur(L, v.expiresIn)) : L.expiredAgo(fmtDur(L, v.expiresIn)) }),
          el('dt', { text: L.cashByLabel }), el('dd', { text: fmtTime(ctx, core.cashBy(snap)) }),
          el('dt', { text: L.signerLabel }), el('dd', { class: 'mono', text: v.signer ?? '–' })));
      }
      if (v.ok) {
        s.cheques[k] = { text, cumulative: ch.cumulative, at: nowSec() };
        kids.push(el('p', { class: 'dim small', text: save(s) ? L.kept : L.noStorage }));
        drawChannels();
      }
      rOut.replaceChildren(...kids);
    }
    const rBtn = el('button', { type: 'button', class: 'btn sm', id: 'off-recv-check', text: L.check, onclick: () => checkCheque() });

    // ---- swap orders: make (offline), relay (online)
    const tokens = [{ address: NATIVE_ERC20, symbol: 'ZTPHY*', decimals: 18 }, ...(ctx.cfg.tokens ?? []).filter((t) => core.isAddr(t.address) && t.symbol)];
    const tokOpt = (list) => list.map((t) => el('option', { value: core.lc(t.address), text: t.symbol }));
    const tIn = el('select', { id: 'off-o-in', 'aria-label': L.tokenIn }, tokOpt(tokens), el('option', { value: 'other', text: L.otherToken }));
    const tOut = el('select', { id: 'off-o-out', 'aria-label': L.tokenOut }, el('option', { value: core.NATIVE, text: L.nativeCoins }), tokOpt(tokens.slice(1)), el('option', { value: 'other', text: L.otherToken }));
    const tInOther = el('input', { id: 'off-o-in-addr', class: 'mono', placeholder: '0x…', autocomplete: 'off', 'aria-label': L.tokenIn, hidden: true });
    const tOutOther = el('input', { id: 'off-o-out-addr', class: 'mono', placeholder: '0x…', autocomplete: 'off', 'aria-label': L.tokenOut, hidden: true });
    tIn.addEventListener('change', () => { tInOther.hidden = tIn.value !== 'other'; });
    tOut.addEventListener('change', () => { tOutOther.hidden = tOut.value !== 'other'; });
    const oAmt = el('input', { id: 'off-o-amt', inputmode: 'decimal', autocomplete: 'off', placeholder: '100', 'aria-label': L.amountIn });
    const oMin = el('input', { id: 'off-o-min', inputmode: 'decimal', autocomplete: 'off', placeholder: '95', 'aria-label': L.minOut });
    const oFee = el('input', { id: 'off-o-fee', inputmode: 'decimal', autocomplete: 'off', value: '0', 'aria-label': L.fee });
    const oHours = el('input', { id: 'off-o-hours', inputmode: 'numeric', autocomplete: 'off', value: '24', 'aria-label': L.hours });
    const oWith = el('select', { id: 'off-o-with', 'aria-label': L.signWith }, el('option', { value: 'wallet', text: L.withWallet }), el('option', { value: 'key', text: L.withKey }));
    const oOut = el('div', { id: 'off-o-out', role: 'status' });
    const oForm = el('form', { class: 'off-form', id: 'off-order-form', autocomplete: 'off' },
      el('div', { class: 'off-2' }, field(L.tokenIn, tIn), field(L.tokenOut, tOut)), el('div', { class: 'off-2' }, tInOther, tOutOther),
      el('div', { class: 'off-2' }, field(L.amountIn, oAmt), field(L.minOut, oMin)), el('div', { class: 'off-2' }, field(L.fee, oFee), field(L.hours, oHours)),
      field(L.signWith, oWith), el('button', { type: 'submit', class: 'btn', id: 'off-o-sign', text: L.signOrder }), oOut);
    const decOf = (a) => (a === core.NATIVE ? 18 : tokens.find((t) => core.lc(t.address) === core.lc(a))?.decimals ?? 18);
    const symOf = (a) => (a === core.NATIVE ? L.nativeCoins : tokens.find((t) => core.lc(t.address) === core.lc(a))?.symbol ?? ctx.short(a, 6, 4));
    oForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!orders) return say(ctx, oOut, L.notDeployed, 'msg bad');
      const tokenIn = tIn.value === 'other' ? tInOther.value.trim() : tIn.value;
      const tokenOut = tOut.value === 'other' ? tOutOther.value.trim() : tOut.value;
      if (!core.isAddr(tokenIn) || !core.isAddr(tokenOut) || tokenIn === core.NATIVE || core.lc(tokenIn) === core.lc(tokenOut)
        || (tokenOut === core.NATIVE && core.lc(tokenIn) === core.lc(NATIVE_ERC20))) return say(ctx, oOut, L.badTokens, 'msg bad');
      let amountIn, minOut, fee;
      try { amountIn = core.parseAmount(oAmt.value, decOf(tokenIn)); minOut = core.parseAmount(oMin.value, decOf(tokenOut)); fee = core.parseAmount(oFee.value || '0', decOf(tokenOut)); if (!amountIn || !minOut) throw new Error(); } catch { return say(ctx, oOut, L.badAmount, 'msg bad'); }
      const hours = Number(oHours.value);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) return say(ctx, oOut, L.badHours, 'msg bad');
      try {
        const { secp, keccak } = await libs();
        const useKey = oWith.value === 'key';
        if (useKey && !unlocked) return say(ctx, oOut, L.unlockFirst, 'msg bad');
        const maker = useKey ? unlocked.address : (ctx.account?.() ?? await ctx.connect());
        if (!core.isAddr(maker)) throw new Error(L.badAddress);
        const order = { maker: core.lc(maker), tokenIn: core.lc(tokenIn), tokenOut: core.lc(tokenOut), amountIn: amountIn.toString(), minAmountOut: minOut.toString(),
          deadline: String(nowSec() + hours * 3600), nonce: core.newNonce(), relayerFee: fee.toString() };
        const sig = useKey ? core.signDigest(secp, core.orderDigest(keccak, { contract: orders, order }), unlocked.sk) : await ctx.signTyped(core.orderTypedData({ contract: orders, order }));
        if (core.lc(core.recoverSigner(secp, keccak, core.orderDigest(keccak, { contract: orders, order }), sig) ?? '') !== core.lc(order.maker)) throw new Error(L.problem.badSignature);
        const text = core.encodeOrder({ contract: orders, order, sig });
        const s = load(); s.orders.push({ text, at: nowSec() }); s.orders = s.orders.slice(-50); save(s);
        const box = await shareBox(ctx, L, text, `zetaphy-order-${order.nonce}.txt`, L.orderQr);
        const appr = el('p', { class: 'msg small', role: 'status' });
        oOut.replaceChildren(el('p', { class: 'msg ok', id: 'off-o-ok', text: L.orderMade(core.formatAmount(amountIn, decOf(tokenIn)), symOf(tokenIn), core.formatAmount(minOut, decOf(tokenOut)), symOf(tokenOut), core.formatAmount(fee, decOf(tokenOut))) }), box,
          el('p', { class: 'dim small', text: L.orderApproveNote(ctx.short(order.maker)) }),
          useKey ? null : el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn ghost sm', id: 'off-o-approve', text: L.approveBtn, onclick: async () => {
            try { say(ctx, appr, L.sending); await ctx.send(tokenIn, core.encodeApprove(orders, amountIn), L.approveAction(core.formatAmount(amountIn, decOf(tokenIn)), symOf(tokenIn))); say(ctx, appr, L.done, 'msg ok'); } catch (err) { say(ctx, appr, errText(err), 'msg bad'); }
          } }), el('button', { type: 'button', class: 'btn ghost sm', id: 'off-o-cancel', text: L.cancelOrder, onclick: async () => {
            try { say(ctx, appr, L.sending); await ctx.send(orders, core.encodeCancel(order.nonce), L.cancelAction(order.nonce)); say(ctx, appr, L.done, 'msg ok'); } catch (err) { say(ctx, appr, errText(err), 'msg bad'); }
          } })), appr);
      } catch (err) { say(ctx, oOut, errText(err), 'msg bad'); }
    });

    const relOut = el('div', { id: 'off-relay-out', role: 'status' });
    const relIn = inputBox(ctx, L, 'off-relay-text', () => checkOrder());
    async function checkOrder() {
      const text = relIn.ta.value.trim();
      if (!text) return;
      let p;
      try { p = core.decodeOrder(text); } catch { return relOut.replaceChildren(el('p', { class: 'msg bad', 'data-ok': '0', text: core.payloadKind(text) === 'cheque' ? L.isCheque : L.badFormat })); }
      const { secp, keccak } = await libs();
      const v = core.verifyOrder(p, { keccak, secp, contract: orders ?? p.contract });
      const o = p.order;
      const kids = [el('p', { class: v.ok ? 'msg ok off-verdict' : 'msg bad off-verdict', 'data-ok': v.ok ? '1' : '0', text: v.ok ? L.orderOk : L.orderBad }),
        el('ul', { class: 'off-problems small' }, v.problems.map((x) => el('li', { class: 'bad', 'data-code': x.code, text: L.problem[x.code] ?? x.code }))),
        el('dl', { class: 'kv3 small' },
          el('dt', { text: L.maker }), el('dd', { class: 'mono', text: o.maker }),
          el('dt', { text: L.sells }), el('dd', { text: `${core.formatAmount(o.amountIn, decOf(o.tokenIn))} ${symOf(o.tokenIn)}` }),
          el('dt', { text: L.getsAtLeast }), el('dd', { text: `${core.formatAmount(o.minAmountOut, decOf(o.tokenOut))} ${symOf(o.tokenOut)}` }),
          el('dt', { text: L.yourFee }), el('dd', { text: `${core.formatAmount(o.relayerFee, decOf(o.tokenOut))} ${symOf(o.tokenOut)}` }),
          el('dt', { text: L.expiry }), el('dd', { text: v.expiresIn > 0 ? L.expiresIn(fmtDur(L, v.expiresIn)) : L.expiredAgo(fmtDur(L, v.expiresIn)) }))];
      if (v.ok) {
        const simOut = el('p', { class: 'msg small', id: 'off-relay-sim', role: 'status' });
        const data = core.encodeFill(o, p.sig, []);
        kids.push(el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn ghost sm', id: 'off-relay-simulate', text: L.simulate, onclick: async () => {
            if (!online()) return say(ctx, simOut, L.needOnline, 'msg bad');
            try {
              const used = await call(ctx, p.contract, core.encodeIsNonceUsed(o.maker, o.nonce));
              if (BigInt(used) !== 0n) return say(ctx, simOut, L.problem.nonceUsed, 'msg bad');
              const r = await ctx.evmCall('eth_call', [{ from: ctx.account?.() ?? undefined, to: p.contract, data }, 'latest']);
              say(ctx, simOut, L.simOk(core.formatAmount(BigInt(r), decOf(o.tokenOut)), symOf(o.tokenOut), core.formatAmount(o.relayerFee, decOf(o.tokenOut))), 'msg ok');
            } catch (err) { say(ctx, simOut, L.simFail(errText(err)), 'msg bad'); }
          } }),
          el('button', { type: 'button', class: 'btn sm', id: 'off-relay-submit', text: L.submit, onclick: async () => {
            try { say(ctx, simOut, L.sending); await ctx.send(p.contract, data, L.submitAction(core.formatAmount(o.relayerFee, decOf(o.tokenOut)), symOf(o.tokenOut))); say(ctx, simOut, L.done, 'msg ok'); } catch (err) { say(ctx, simOut, errText(err), 'msg bad'); }
          } })), simOut);
      }
      relOut.replaceChildren(...kids);
    }
    const relBtn = el('button', { type: 'button', class: 'btn sm', id: 'off-relay-check', text: L.check, onclick: () => checkOrder() });

    function drawAll() { drawKey(); drawChannels(); drawWriteSelect(); }
    redraw = drawAll;

    const net = el('p', { class: 'off-net', id: 'off-net', role: 'status' });
    root.replaceChildren(
      el('p', { class: 'dim small sp-intro', text: L.intro }), net,
      el('div', { class: 'grid3 off-grid' },
        card('off-risks', L.riskTitle, null, el('ul', { class: 'off-risks small' }, L.risks.map((r) => el('li', { text: r }))), el('p', { class: 'warnline small', text: L.testnet })),
        card('off-keycard', L.keyTitle, L.keyTip, keyBox),
        card('off-channels', L.chTitle, L.chTip, cheques ? null : el('p', { class: 'warnline small', 'data-state': 'not-deployed', text: L.notDeployed }),
          el('h3', { text: L.openTitle }), openForm, el('h3', { text: L.syncTitle }), syncForm, syncOut, chBox),
        card('off-write-card', L.writeTitle, L.writeTip, wForm),
        card('off-recv-card', L.recvTitle, L.recvTip, rIn.node, el('div', { class: 'row' }, rBtn), rOut),
        card('off-orders', L.orderTitle, L.orderTip, orders ? null : el('p', { class: 'warnline small', 'data-state': 'not-deployed', text: L.notDeployed }), oForm),
        card('off-relay', L.relayTitle, L.relayTip, relIn.node, el('div', { class: 'row' }, relBtn), relOut),
        ...cashCards({ ctx, L, card, field, say, qrSvg, inputBox, fmtDur, nowSec, online, fmtTime: (t) => fmtTime(ctx, t) })));
    drawAll();
    page.refresh(root, ctx);
    if (!root.dataset.netBound) {
      root.dataset.netBound = '1';
      const upd = () => page.refresh(root, ctx);
      addEventListener('online', upd); addEventListener('offline', upd);
    }
  },

  refresh(root, ctx) {
    const L = OF(ctx.lang);
    const net = root?.querySelector('#off-net');
    if (!net) return;
    const on = online();
    net.dataset.online = on ? '1' : '0';
    net.textContent = on ? L.netOnline : L.netOffline;
    const sw = root.dataset.shell;
    if (sw) net.textContent += ` · ${sw === 'ready' ? L.shellReady : L.shellNo}`;
  },
};

/** Registers the hub's service worker (sw.js) once this tab is opened: from then on the hub loads with no network. */
function registerShell(ctx, root) {
  try {
    if (!('serviceWorker' in navigator) || !/^https:$|^http:$/.test(location.protocol)) { root.dataset.shell = 'no'; return; }
    navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready)
      .then(() => { root.dataset.shell = 'ready'; page.refresh(root, ctx); })
      .catch(() => { root.dataset.shell = 'no'; page.refresh(root, ctx); });
  } catch { root.dataset.shell = 'no'; }
}

export default page;
