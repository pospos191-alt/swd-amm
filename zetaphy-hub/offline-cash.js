// The Offline tab's "Offline cash" and "Mesh" cards (docs/future/offline-cash.md), drawn by offline.js.
//   - Offline cash (ZetaphyOfflineCash): a post-quantum cash key (ML-DSA-44, made here, its 32-byte seed kept
//     ENCRYPTED in this browser like the cheque key); receive a note and check it with no network (every signature of
//     its chain, and with a pinned validator set its proof of funds: locked on chain, how much the bonds cover); keep
//     it; sign it over to the next holder; cash it out (online) or sign a cash-out for a relayer.
//   - Mesh: any ZNOTE1 / ZCHQ1 / ZORD1 text as numbered frames for SMS, LoRa or QR codes, and the way back: frames
//     pasted in any order from any medium are reassembled here; a cash-out, cheque or order can then be submitted
//     (this browser acts as a relay, when online).
// The logic is cash-core.js and mesh-frames.js (shared with the CLI); everything shown goes in with textContent, no
// inline styles (CSP).
import { withFallback } from './i18n.js';
import { CASH } from './offline-cash-i18n.js';
import * as cash from './cash-core.js';
import * as M from './mesh-frames.js';
import * as off from './offline-core.js';

export const CW = (lang) => withFallback(CASH, lang);
const STORE = 'zetaphy-offline-cash:v1';
const LOCK_AFTER_MS = 15 * 60 * 1000;
const KEY_HEX = /^0x[0-9a-f]{64}$/;

// ---------------------------------------------------------------- what this browser keeps (localStorage, in try/catch)

const empty = () => ({ key: null, notes: [], pin: null });
/** The stored state, cleaned: a malformed note, key or pin is dropped, never trusted. */
export function cleanCashState(j) {
  const s = empty();
  if (!j || typeof j !== 'object') return s;
  if (j.key && typeof j.key === 'object' && KEY_HEX.test(String(j.key.keyHash)) && j.key.blob && typeof j.key.blob === 'object') s.key = { keyHash: j.key.keyHash, blob: j.key.blob };
  if (Array.isArray(j.notes)) {
    for (const n of j.notes.slice(-200)) {
      try { cash.noteFromText(n?.text); if (!s.notes.some((x) => x.text === n.text)) s.notes.push({ text: n.text, at: Number(n.at) || 0 }); } catch { /* dropped */ }
    }
  }
  if (typeof j.pin === 'string') { try { cash.parsePin(j.pin); s.pin = j.pin; } catch { /* dropped */ } }
  return s;
}
function load() { try { return cleanCashState(JSON.parse(localStorage.getItem(STORE) ?? 'null')); } catch { return empty(); } }
function save(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); return true; } catch { return false; } }
/** The label the encrypted seed is bound to (offline-core encryptKey wants an address-shaped string). */
export const keyLabel = (keyHash) => `0x${String(keyHash).slice(-40)}`;

// ---------------------------------------------------------------- crypto and QR (this site's own files)

let libsP = null;
const libs = () => (libsP ??= Promise.all([import('./wallet/vendor/pqwallet.js'), import('./vendor/qrcode.js')]).then(([w, q]) => ({
  c: { keccak: (b) => w.keccak_256(b), verify: (sig, m, pk) => w.ml_dsa44.verify(sig, m, pk) },
  ml: w.ml_dsa44, qrcode: q.default ?? q.qrcode,
})));
/** A holder from a seed with the bundle's ML-DSA-44: { pk, key, sign }. */
export function holderOf(ml, c, seed) {
  const { publicKey, secretKey } = ml.keygen(seed);
  return { pk: publicKey, key: cash.keyHash(c, publicKey), sign: (d) => ml.sign(d, secretKey) };
}

let unlocked = null; // { seed, holder } in memory only
let lockTimer = null;
function setUnlocked(u, redraw) {
  if (unlocked?.seed) unlocked.seed.fill(0);
  unlocked = u;
  clearTimeout(lockTimer);
  if (u) lockTimer = setTimeout(() => { setUnlocked(null); redraw?.(); }, LOCK_AFTER_MS);
}

// ---------------------------------------------------------------- reading what was pasted

/** Packets of a Mesh text (complete ones) through a long-lived reassembler: [{ type, payload, deadline }], progress. */
export function meshIn(asm, text) {
  const out = [], progress = new Map();
  let any = false;
  for (const t of M.framesInText(text)) {
    any = true;
    const r = asm.add(t);
    if (r.status === 'complete') { try { out.push(M.decodePacket(r.packet)); } catch { /* not a packet */ } progress.delete(r.id); }
    else if (r.status === 'partial' || r.status === 'duplicate') progress.set(r.id, { have: r.have, total: r.total, missing: asm.missing(r.id) });
  }
  return { any, packets: out, progress: [...progress.values()] };
}
/** A note from a packet list: the bundle (note / redeem packet) with any proof packets that came with it. */
export function noteFromPackets(packets) {
  const n = packets.find((p) => p.type === 'note' || p.type === 'redeem');
  if (!n) return null;
  const b = cash.decodeBundle(n.payload);
  const proofs = packets.filter((p) => p.type === 'proof').map((p) => cash.decodeProof(p.payload));
  return proofs.length ? { ...b, proofs } : b;
}
/** Packets for a text to send: a note becomes its binary bundle (+ one packet per proof); a cheque / order its text. */
export function packetsFor(text) {
  const t = String(text ?? '').trim();
  if (t.startsWith(cash.NOTE_PREFIX)) {
    const b = cash.noteFromText(t);
    return [M.encodePacket({ type: b.terminal ? 'redeem' : 'note', payload: cash.encodeBundle(b) }),
      ...(b.proofs ?? []).map((p) => M.encodePacket({ type: 'proof', payload: cash.encodeProof(p) }))];
  }
  const kind = off.payloadKind(t);
  if (kind) return [M.encodePacket({ type: kind, payload: M.utf8(t) })];
  return null;
}

// ---------------------------------------------------------------- the cards

/**
 * The cards for offline.js: h = { ctx, L (the Offline tab's words), card, field, say, qrSvg, inputBox, fmtDur, nowSec, online }.
 * Returns [cash card, receive card, notes card, mesh card].
 */
export function cashCards(h) {
  const { ctx, L, card, field, say, qrSvg, inputBox, fmtDur, nowSec, online } = h;
  const T = CW(ctx.lang);
  const el = ctx.el;
  const contract = cash.isAddr(ctx.cfg.contracts?.offlineCash) ? ctx.cfg.contracts.offlineCash : null;
  const errText = (e) => String(e?.message ?? e).slice(0, 200);
  const fmt = (wei) => off.formatAmount(BigInt(wei), 18);
  const asm = new M.Reassembler();
  const box = (cls = 'msg small') => el('p', { class: cls, role: 'status' });

  // ---- the key and the pinned validators
  const keyBox = el('div', { id: 'off-cash-key' });
  function drawKey() {
    const s = load();
    const kids = [];
    if (!s.key) {
      const p1 = el('input', { type: 'password', id: 'off-cash-pass', autocomplete: 'new-password', placeholder: L.passphrase, 'aria-label': L.passphrase });
      const p2 = el('input', { type: 'password', id: 'off-cash-pass2', autocomplete: 'new-password', placeholder: L.passphrase2, 'aria-label': L.passphrase2 });
      const out = box();
      const f = el('form', { class: 'off-form', id: 'off-cash-create-form', autocomplete: 'off' }, p1, p2, el('button', { type: 'submit', class: 'btn sm', id: 'off-cash-create', text: T.makeKey }), out);
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (p1.value.length < 10) return say(ctx, out, L.passShort, 'msg bad');
        if (p1.value !== p2.value) return say(ctx, out, L.passMismatch, 'msg bad');
        say(ctx, out, '…');
        try {
          const { ml, c } = await libs();
          const seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
          const holder = holderOf(ml, c, seed);
          const blob = await off.encryptKey({}, seed, p1.value, keyLabel(holder.key));
          const st = load(); st.key = { keyHash: holder.key, blob };
          if (!save(st)) throw new Error(L.noStorage);
          setUnlocked({ seed, holder }, drawAll);
          p1.value = ''; p2.value = '';
          drawAll();
        } catch (err) { say(ctx, out, errText(err), 'msg bad'); }
      });
      kids.push(el('p', { class: 'small', text: T.keyNone }), f);
    } else {
      kids.push(el('dl', { class: 'kv3' }, el('dt', { text: T.yourKey }), el('dd', { class: 'mono small', id: 'off-cash-keyhash', text: s.key.keyHash }),
        el('dt', { text: L.keyState }), el('dd', { id: 'off-cash-state', 'data-state': unlocked ? 'unlocked' : 'locked', text: unlocked ? L.unlocked : L.locked })),
      el('div', { class: 'row' }, ctx.copyBtn(s.key.keyHash)));
      if (!unlocked) {
        const p = el('input', { type: 'password', id: 'off-cash-unlock-pass', autocomplete: 'current-password', placeholder: L.passphrase, 'aria-label': L.passphrase });
        const out = box();
        const f = el('form', { class: 'row', id: 'off-cash-unlock-form', autocomplete: 'off' }, p, el('button', { type: 'submit', class: 'btn sm', id: 'off-cash-unlock', text: L.unlock }));
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          say(ctx, out, '…');
          try {
            const { ml, c } = await libs();
            const seed = await off.decryptKey({}, load().key.blob, p.value);
            const holder = holderOf(ml, c, seed);
            if (holder.key !== s.key.keyHash) throw new Error('passphrase');
            p.value = '';
            setUnlocked({ seed, holder }, drawAll);
            drawAll();
          } catch { say(ctx, out, L.passWrong, 'msg bad'); }
        });
        kids.push(f, out);
      } else kids.push(el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn ghost sm', id: 'off-cash-lock', text: L.lock, onclick: () => { setUnlocked(null); drawAll(); } })));
    }
    keyBox.replaceChildren(...kids);
  }
  const pinIn = el('textarea', { id: 'off-cash-pin', class: 'mono off-text', rows: 2, spellcheck: 'false', placeholder: '{"chainId":"zetaphy_77390-1","validators":{…}}', 'aria-label': T.pinTitle });
  const pinOut = box();
  const pinBtn = el('button', { type: 'button', class: 'btn ghost sm', id: 'off-cash-pin-save', text: T.pinSave, onclick: () => {
    try {
      const p = cash.parsePin(pinIn.value.trim());
      const st = load(); st.pin = pinIn.value.trim();
      if (!save(st)) throw new Error(L.noStorage);
      say(ctx, pinOut, T.pinSaved(p.validators.length), 'msg ok');
    } catch { say(ctx, pinOut, T.pinBad, 'msg bad'); }
  } });
  const pinNow = load().pin;
  if (pinNow) { try { pinOut.textContent = T.pinSaved(cash.parsePin(pinNow).validators.length); } catch { /* none */ } }

  // ---- receive
  const rOut = el('div', { id: 'off-cash-recv-out' });
  async function checkNote(b) {
    const { c } = await libs();
    const s = load();
    const r = cash.receiveCheck(c, b, { me: s.key?.keyHash ?? null, pin: s.pin, contract, now: nowSec() });
    const kids = [el('p', { class: r.ok ? 'msg ok' : 'msg bad', id: 'off-cash-verdict', 'data-ok': r.ok ? '1' : '0',
      text: r.ok ? T.valid(fmt(r.value), r.seq) : T.invalid })];
    if (r.problems.length) kids.push(el('ul', { class: 'small off-problems' }, r.problems.map((p) => el('li', { class: 'bad', 'data-code': p, text: T.problem[p] ?? p }))));
    if (r.warnings.length) kids.push(el('ul', { class: 'small off-problems' }, r.warnings.map((p) => el('li', { 'data-code': p, text: T.warn[p] ?? p }))));
    kids.push(el('p', { class: 'small', id: 'off-cash-funds', 'data-covered': r.funds ? String(r.funds.covered) : '',
      text: r.funds?.note === 'proven' ? T.funds(fmt(r.funds.covered), fmt(r.funds.value), h.fmtTime(r.funds.asOf)) : T.fundsNone }));
    if (r.ok) {
      const lockIn = r.bundle.note.lockUntil - nowSec();
      kids.push(el('p', { class: 'dim small', text: T.lockLeft(fmtDur(L, lockIn)) }));
      const kept = box();
      kids.push(el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn sm', id: 'off-cash-keep', text: T.keep, onclick: () => {
        const st = load();
        const text = cash.noteToText(r.bundle);
        if (!st.notes.some((n) => n.text === text)) st.notes.push({ text, at: nowSec() });
        if (!save(st)) return say(ctx, kept, L.noStorage, 'msg bad');
        say(ctx, kept, T.kept, 'msg ok');
        drawNotes();
      } })), kept);
    }
    rOut.replaceChildren(...kids);
  }
  const rIn = inputBox(ctx, L, 'off-cash-in', () => readReceived());
  async function readReceived() {
    const text = rIn.ta.value;
    try {
      if (text.trim().startsWith(cash.NOTE_PREFIX)) return await checkNote(cash.noteFromText(text));
      const m = meshIn(asm, text);
      if (!m.any) throw new Error(T.problem.badFormat);
      const b = noteFromPackets(m.packets);
      if (b) return await checkNote(b);
      const pr = m.progress[0];
      rOut.replaceChildren(el('p', { class: 'msg small', text: pr ? `${T.progress(pr.have, pr.total)} · ${T.missing(pr.missing.map((i) => i + 1).join(', '))}` : T.problem.badFormat }));
    } catch (e) { rOut.replaceChildren(el('p', { class: 'msg bad', text: errText(e) })); }
  }
  const rBtn = el('button', { type: 'button', class: 'btn sm', id: 'off-cash-check', text: L.check, onclick: () => readReceived() });

  // ---- notes on this device
  const notesBox = el('div', { id: 'off-cash-notes-list' });
  const shareOut = el('div', { id: 'off-cash-share' });
  function share(text) {
    exportIn.value = text;
    shareOut.replaceChildren(el('textarea', { class: 'mono off-text', id: 'off-cash-share-text', readonly: true, rows: 3, 'aria-label': T.exportWhat }), el('div', { class: 'row' }, ctx.copyBtn(text)));
    shareOut.firstChild.value = text;
    makeFrames();
  }
  async function drawNotes() {
    const s = load();
    if (!s.notes.length) return notesBox.replaceChildren(el('p', { class: 'dim small', text: T.noNotes }));
    const { c } = await libs().catch(() => ({ c: null }));
    notesBox.replaceChildren(...s.notes.map((n, idx) => {
      let b, w;
      try { b = cash.noteFromText(n.text); w = c ? cash.walk(c, b) : null; } catch { return null; }
      const out = box();
      const toIn = el('input', { class: 'mono', id: `off-cash-to-${idx}`, spellcheck: 'false', autocomplete: 'off', placeholder: '0x…', 'aria-label': T.passTo });
      const payIn = el('input', { class: 'mono', id: `off-cash-payout-${idx}`, spellcheck: 'false', autocomplete: 'off', placeholder: '0x…', value: ctx.account?.() ?? '', 'aria-label': T.payout });
      const feeIn = el('input', { id: `off-cash-fee-${idx}`, inputmode: 'decimal', autocomplete: 'off', value: '0', 'aria-label': T.fee });
      const needKey = () => { if (!unlocked) throw new Error(L.unlockFirst); return unlocked.holder; };
      const removeNote = () => { const st = load(); st.notes = st.notes.filter((x) => x.text !== n.text); save(st); };
      const terminal = () => {
        if (!cash.isAddr(payIn.value.trim())) throw new Error(L.badAddress);
        return cash.signTerminal(c, b, needKey(), payIn.value.trim(), off.parseAmount(feeIn.value.trim() || '0', 18));
      };
      return el('div', { class: 'off-ch', 'data-note': b.note.id },
        el('p', { class: 'small' }, el('strong', { text: `#${b.note.id} · ${fmt(b.note.value)} ZTPHY` }),
          el('span', { class: 'dim', text: ` · ${T.lockLeft(fmtDur(L, b.note.lockUntil - nowSec()))}${w && !w.ok ? ' · ⚠' : ''}` })),
        field(T.passTo, toIn),
        el('div', { class: 'row wrap' },
          el('button', { type: 'button', class: 'btn sm', id: `off-cash-pass-${idx}`, text: T.passBtn, onclick: () => {
            try {
              const to = toIn.value.trim().toLowerCase();
              if (!KEY_HEX.test(to)) throw new Error(T.badKey);
              const next = cash.passOn(c, b, needKey(), to);
              removeNote();
              say(ctx, out, T.passed, 'msg ok');
              share(cash.noteToText(next));
              drawNotes();
            } catch (e) { say(ctx, out, errText(e), 'msg bad'); }
          } })),
        field(T.payout, payIn), field(T.fee, feeIn),
        el('div', { class: 'row wrap' },
          el('button', { type: 'button', class: 'btn ghost sm', id: `off-cash-cash-${idx}`, text: T.cashBtn, onclick: async () => {
            try {
              if (!online()) throw new Error(L.needOnline);
              const t = terminal();
              say(ctx, out, L.sending);
              await ctx.send(t.contract, cash.encodeRedeem(c, t), T.cashAction(fmt(b.note.value)));
              removeNote(); say(ctx, out, L.done, 'msg ok'); drawNotes();
            } catch (e) { say(ctx, out, errText(e), 'msg bad'); }
          } }),
          el('button', { type: 'button', class: 'btn ghost sm', id: `off-cash-relay-${idx}`, text: T.relayBtn, onclick: () => {
            try { const t = terminal(); removeNote(); say(ctx, out, T.relayMade, 'msg ok'); share(cash.noteToText(t)); drawNotes(); } catch (e) { say(ctx, out, errText(e), 'msg bad'); }
          } }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T.forget, onclick: () => { if (confirm(T.forgetConfirm)) { removeNote(); drawNotes(); } } })), out);
    }).filter(Boolean));
  }

  // ---- Mesh: export and import
  const exportIn = el('textarea', { id: 'off-mesh-in', class: 'mono off-text', rows: 3, spellcheck: 'false', placeholder: 'ZNOTE1:… / ZCHQ1:… / ZORD1:…', 'aria-label': T.exportWhat });
  const medium = el('select', { id: 'off-mesh-medium', 'aria-label': T.medium }, Object.entries(T.media).map(([k, v]) => el('option', { value: k, text: v })));
  const framesOut = el('div', { id: 'off-mesh-frames' });
  async function makeFrames() {
    try {
      const packets = packetsFor(exportIn.value);
      if (!packets) throw new Error(T.unknownText);
      const frames = packets.flatMap((p) => M.toTextFrames(p, medium.value));
      const bytes = packets.reduce((n, p) => n + p.length, 0);
      const all = el('textarea', { class: 'mono off-text', id: 'off-mesh-out', readonly: true, rows: 4, 'aria-label': T.framesInfo(frames.length, bytes) });
      all.value = frames.join('\n');
      const { qrcode } = await libs();
      let i = 0;
      const qrBox = el('div', { class: 'off-share', id: 'off-mesh-qr' });
      const label = el('p', { class: 'small', id: 'off-mesh-qr-label' });
      const show = () => { const svg = qrSvg(qrcode, frames[i]); svg.setAttribute('aria-label', T.frameOf(i + 1, frames.length)); qrBox.replaceChildren(svg); label.textContent = T.frameOf(i + 1, frames.length); };
      show();
      framesOut.replaceChildren(el('p', { class: 'small', id: 'off-mesh-info', 'data-frames': String(frames.length), text: T.framesInfo(frames.length, bytes) }), all,
        el('div', { class: 'row' }, ctx.copyBtn(all.value),
          el('button', { type: 'button', class: 'btn ghost sm', id: 'off-mesh-prev', text: T.prev, onclick: () => { i = (i + frames.length - 1) % frames.length; show(); } }),
          el('button', { type: 'button', class: 'btn ghost sm', id: 'off-mesh-next', text: T.next, onclick: () => { i = (i + 1) % frames.length; show(); } })),
        label, qrBox);
    } catch (e) { framesOut.replaceChildren(el('p', { class: 'msg bad', text: errText(e) })); }
  }
  const mkBtn = el('button', { type: 'button', class: 'btn sm', id: 'off-mesh-make', text: T.makeFrames, onclick: () => makeFrames() });

  const impIn = inputBox(ctx, L, 'off-mesh-import', () => importFrames());
  const impOut = el('div', { id: 'off-mesh-import-out' });
  async function importFrames() {
    const m = meshIn(asm, impIn.ta.value);
    if (!m.any) return impOut.replaceChildren(el('p', { class: 'msg bad', text: T.badFrames }));
    const kids = m.progress.map((p) => el('p', { class: 'small', 'data-state': 'partial', text: `${T.progress(p.have, p.total)}${p.missing.length ? ` · ${T.missing(p.missing.map((x) => x + 1).join(', '))}` : ''}` }));
    const b = noteFromPackets(m.packets);
    for (const p of m.packets) {
      const expired = p.deadline && p.deadline < nowSec();
      const out = box();
      kids.push(el('p', { class: 'msg ok small', id: 'off-mesh-complete', 'data-type': p.type, text: `${T.complete(p.type)}${expired ? ` ${T.expired}` : ''}` }));
      if (p.type === 'proof') continue;
      const text = p.type === 'note' || p.type === 'redeem' ? cash.noteToText(b) : new TextDecoder().decode(p.payload);
      const ta = el('textarea', { class: 'mono off-text', readonly: true, rows: 2, 'aria-label': T.complete(p.type) });
      ta.value = text;
      kids.push(ta, el('div', { class: 'row' }, ctx.copyBtn(text)));
      let plan = null;
      try {
        if (p.type === 'redeem') { const { c } = await libs(); plan = { to: b.contract, data: cash.encodeRedeem(c, b), label: T.cashAction(fmt(b.note.value)) }; }
        else if (p.type === 'cheque') { const ch = off.decodeCheque(text); plan = { to: ch.contract, data: off.encodeCash(ch.channelId, ch.cumulative, ch.sig), label: L.cashAction(ch.channelId, '', '') }; }
        else if (p.type === 'order') { const o = off.decodeOrder(text); plan = { to: o.contract, data: off.encodeFill(o.order, o.sig, []), label: L.submitAction('', '') }; }
      } catch { plan = null; }
      if (p.type === 'note') { rIn.ta.value = text; await checkNote(b); }
      if (plan && !expired) {
        kids.push(el('button', { type: 'button', class: 'btn sm', id: 'off-mesh-submit', text: L.submit, onclick: async () => {
          try { if (!online()) throw new Error(L.needOnline); say(ctx, out, L.sending); await ctx.send(plan.to, plan.data, plan.label); say(ctx, out, L.done, 'msg ok'); } catch (e) { say(ctx, out, errText(e), 'msg bad'); }
        } }), out);
      }
    }
    impOut.replaceChildren(...kids);
  }
  const impBtn = el('button', { type: 'button', class: 'btn sm', id: 'off-mesh-import-btn', text: L.check, onclick: () => importFrames() });

  function drawAll() { drawKey(); drawNotes(); }
  drawAll();
  if (pinNow) pinIn.value = pinNow;

  return [
    card('off-cash', T.title, T.tip, contract ? null : el('p', { class: 'warnline small', 'data-state': 'not-deployed', text: L.notDeployed }),
      el('ul', { class: 'off-risks small' }, T.risks.map((r) => el('li', { text: r }))),
      el('h3', { text: T.keyTitle }), keyBox, el('h3', { text: T.pinTitle }), el('p', { class: 'dim small', text: T.pinTip }), pinIn, el('div', { class: 'row' }, pinBtn), pinOut),
    card('off-cash-recv', T.recvTitle, T.recvTip, rIn.node, el('div', { class: 'row' }, rBtn), rOut),
    card('off-cash-notes', T.notesTitle, null, notesBox, shareOut),
    card('off-mesh', T.meshTitle, T.meshTip, field(T.exportWhat, exportIn), field(T.medium, medium), el('div', { class: 'row' }, mkBtn), framesOut,
      el('h3', { text: T.importTitle }), impIn.node, el('div', { class: 'row' }, impBtn), impOut),
  ];
}
