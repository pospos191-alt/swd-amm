// The hub's assistant pages (docs/future/crosschain-assist.md):
//   gov:    governance assistant (item 21): open proposals and the timelock queue, decoded, simulated, flagged (govassist.js)
//   immune: herd immunity (item 28: coverage of NeuroOracle mirrors per chain), the Neuro-checked certificate lookup
//           (item 19, NeuroAttest.badge) and the quantum-safe attestation verifier (item 30, pqattest.js), all in the browser
// Plus the pre-sign simulation rows and the AI explanation for hub.js send() (item 20, presign.js).
// Everything shown goes in with textContent; no inline styles (CSP style-src 'self').
import { withFallback } from './i18n.js';
import { ASSIST } from './assist-i18n.js';
import { reviewProposals, reviewTimelock } from './govassist.js';
import { verifyArchive, anchoredAtData, readAnchoredAt } from './pqattest.js';
import { simulateTx, simulationRows, explainTx, neuroAiSettings } from './presign.js';

export const A = (lang) => withFallback(ASSIST, lang);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const body = (h) => String(h ?? '').replace(/^0x/, '');

/** Raw JSON-RPC (keeps revert data): resolves { result } or { error }. */
export function rawSender(url, fetchImpl = fetch) {
  return async (method, params) => {
    const r = await fetchImpl(url, { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return r.json();
  };
}

// ---------------------------------------------------------------- herd immunity: coverage (same rules as zetaphy-network/src/neurooracle.js)

export const SEL = { snapshot: '0x37c3071a', roundsOf: '0x4dab653e', badge: '0x88e179c7', flaggedNow: '0x1e9699c1', paused: '0x5c975abb' };
const arrayAt = (h, w) => { const at = (i) => BigInt(`0x${h.slice(i * 64, (i + 1) * 64)}`); const o = Number(at(w)) / 32; const n = Number(at(o)); return Array.from({ length: n }, (_, i) => h.slice((o + 1 + i) * 64, (o + 2 + i) * 64)); };
/** snapshot(start, n)'s answer -> { keys, rounds, flagged }. */
export function readSnapshot(hex) {
  const h = body(hex);
  return { keys: arrayAt(h, 0).map((k) => `0x${k}`), rounds: arrayAt(h, 1).map((x) => Number(BigInt(`0x${x}`))), flagged: arrayAt(h, 2).map((x) => BigInt(`0x${x}`) !== 0n) };
}
export const roundsOfData = (keys) => SEL.roundsOf + word(32) + word(keys.length) + keys.map(body).join('');
export const readRounds = (hex) => arrayAt(body(hex), 0).map((x) => Number(BigInt(`0x${x}`)));
/** Pages of the registry's flag history -> Map key -> round of the keys flagged now (the last state of a key wins). */
export function currentFlags(pages) {
  const out = new Map();
  for (const p of pages) p.keys.forEach((k, i) => { if (p.flagged[i]) out.set(k.toLowerCase(), p.rounds[i]); else out.delete(k.toLowerCase()); });
  return out;
}
/** Share of the flags mirrored at the same round (null: nothing flagged). Floored to 0.1%: 1 missing of 1000 never shows 100%. */
export function coverageOf(flags, rounds) {
  const keys = [...flags.keys()];
  const have = keys.filter((k, i) => rounds[i] === flags.get(k)).length;
  return { flagged: keys.length, mirrored: have, share: keys.length ? have / keys.length : null };
}
export const pct = (share) => (share == null ? '–' : `${(Math.floor(share * 1000) / 10).toFixed(1)}%`);

/** Coverage of every mirror in hub-config immune: { flagged, mirrors: [{ name, share, mirrored, paused, error }] }. */
export async function measureCoverage({ immune, zSend, chainSend }) {
  const pages = [];
  for (let start = 0; ; start += 200) {
    const r = await zSend('eth_call', [{ to: immune.sender, data: SEL.snapshot + word(start) + word(200) }, 'latest']);
    if (r.error) throw new Error(r.error.message);
    const p = readSnapshot(r.result);
    pages.push(p);
    if (p.keys.length < 200) break;
  }
  const flags = currentFlags(pages);
  const keys = [...flags.keys()];
  const mirrors = [];
  for (const m of immune.mirrors ?? []) {
    try {
      const send = chainSend(m);
      const r = keys.length ? await send('eth_call', [{ to: m.oracle, data: roundsOfData(keys) }, 'latest']) : { result: '0x' + word(32) + word(0) };
      if (r.error) throw new Error(r.error.message);
      const ps = await send('eth_call', [{ to: m.oracle, data: SEL.paused }, 'latest']).catch(() => null);
      mirrors.push({ name: m.displayName ?? m.name, ...coverageOf(flags, readRounds(r.result)), paused: typeof ps?.result === 'string' && BigInt(ps.result || '0x0') !== 0n });
    } catch (e) { mirrors.push({ name: m.displayName ?? m.name, error: String(e.message).slice(0, 120) }); }
  }
  return { flagged: keys.length, mirrors };
}

// ---------------------------------------------------------------- Neuro-checked badge (NeuroAttest.badge)

export const badgeData = (token) => SEL.badge + body(token).toLowerCase().padStart(64, '0');
/** badge(address)'s answer -> { checked, uid, reportHash, skill, model, by, time }. */
export function readBadge(hex) {
  const h = body(hex);
  if (h.length < 7 * 64) throw new Error('not a badge answer');
  const w = (i) => h.slice(i * 64, (i + 1) * 64);
  const model = (w(4).match(/../g) ?? []).map((b) => parseInt(b, 16)).filter((b) => b >= 0x20 && b < 0x7f).map((b) => String.fromCharCode(b)).join('');
  return { checked: BigInt(`0x${w(0)}`) !== 0n, uid: BigInt(`0x${w(1)}`), reportHash: `0x${w(2)}`, skill: `0x${w(3)}`, model, by: `0x${w(5).slice(24)}`, time: Number(BigInt(`0x${w(6)}`)) };
}
/** The badge of `token` (null when NeuroAttest is not deployed or the read fails). */
export async function badgeOf(evmCall, attest, token) {
  if (!ADDR.test(attest ?? '') || !ADDR.test(token ?? '')) return null;
  try { return readBadge(await evmCall('eth_call', [{ to: attest, data: badgeData(token) }, 'latest'])); } catch { return null; }
}

// ---------------------------------------------------------------- pre-sign (hub.js send)

/** The confirmTx hooks for one transaction: simulate (rows in the page's words) and, if a model is set up in Neuro, explain. */
export function presignHooks({ lang, url, from, to, data, value = 0n, tokens = [], fetchImpl = fetch }) {
  const L = A(lang);
  const send = rawSender(url, fetchImpl);
  const info = (a) => tokens.find((t) => t.address.toLowerCase() === a.toLowerCase()) ?? null;
  let last = null;
  const simulate = async () => {
    last = await simulateTx({ send, from, to, data, value, known: tokens.map((t) => t.address) });
    return simulationRows(last, L, { tokenInfo: info });
  };
  const settings = neuroAiSettings();
  const explain = settings.provider && (settings.key || settings.provider === 'ollama') ? async () => {
    const { complete } = await import('./neuro/ai/providers.js');
    const summary = { network: 'ZETAPHY testnet (77390)', from, to, value: String(value), callData: String(data).slice(0, 2 + 8 + 64 * 6),
      simulation: last ? { ok: last.ok, reason: last.reason, nativeChange: last.native == null ? null : String(last.native),
        tokenChanges: last.tokens.map((t) => ({ token: info(t.address)?.symbol ?? t.address, change: String(t.delta) })) } : null };
    return explainTx({ summary, settings, lang, complete });
  } : null;
  return { simulate, explain };
}

// ---------------------------------------------------------------- pages

const card = (ctx, title, tip, ...kids) => ctx.el('div', { class: 'card' },
  ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: title }), tip ? ctx.el('span', { class: 'info', 'data-tip': tip, tabindex: 0, text: 'i' }) : null), ...kids);
const when = (ctx, t) => { const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t); return Number.isFinite(d.getTime()) ? d.toLocaleString(ctx.lang === 'en' ? 'en-GB' : ctx.lang) : '?'; };
const pv = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 80);

const gov = {
  render(root, ctx) {
    const L = A(ctx.lang);
    root.replaceChildren(ctx.el('p', { class: 'dim small sp-intro', text: L.govIntro }),
      ctx.el('div', { class: 'grid2' },
        card(ctx, L.govProps, null, ctx.el('div', { id: 'ga-props', class: 'scroll' }, ctx.el('p', { class: 'dim', text: '…' }))),
        card(ctx, L.govQueue, null, ctx.el('div', { id: 'ga-queue', class: 'scroll' }, ctx.el('p', { class: 'dim', text: '…' })))));
  },
  async refresh(root, ctx) {
    const L = A(ctx.lang);
    const send = rawSender(ctx.ep().evm);
    const flags = (fs) => fs.map((f) => ctx.el('p', { class: 'warnline small', 'data-flag': f, text: `⚑ ${L.flag[f] ?? f}` }));
    const sim = (s) => (s == null || s.ok == null ? L.govSimNo : s.ok ? L.govSimOk : L.govSimFail(s.reason));
    try {
      const props = await reviewProposals({ getJson: ctx.getJson, rest: ctx.ep().rest, send });
      root.querySelector('#ga-props')?.replaceChildren(...(props.length ? props.map((p) => ctx.el('div', { class: 'ga-item', 'data-proposal': p.id },
        ctx.el('h3', { text: `#${p.id} ${p.title}` }),
        ctx.el('p', { class: 'dim small', text: `${p.status} · ${L.govEnds(when(ctx, p.ends))}` }),
        ...p.messages.map((m) => ctx.el('div', { class: 'small' },
          ctx.el('div', { class: 'mono', text: m.type }),
          m.kind === 'params' ? ctx.el('dl', { class: 'kv3' }, (m.diff ?? []).flatMap((d) => [ctx.el('dt', { text: d.field }), ctx.el('dd', { class: 'mono', text: `${L.govFrom} ${pv(d.from)} → ${L.govTo} ${pv(d.to)}` })])) : null,
          m.kind === 'evm' ? ctx.el('p', { class: 'mono', text: `${m.fn.name} @ ${m.call.to ?? 'new'} · ${sim(m.sim)}` }) : null,
          m.text ? ctx.el('p', { class: 'mono', text: m.text }) : null,
          m.kind === 'other' || m.kind === 'legacy' ? ctx.el('p', { class: 'dim', text: L.govUnknown }) : null)),
        ...flags(p.flags))) : [ctx.el('p', { class: 'dim', text: L.govNone })]));
    } catch (e) { root.querySelector('#ga-props')?.replaceChildren(ctx.el('p', { class: 'dim', text: String(e.message).slice(0, 160) })); }
    const tl = ctx.cfg.contracts?.timelock;
    const q = root.querySelector('#ga-queue');
    if (!ADDR.test(tl ?? '')) { q?.replaceChildren(ctx.el('p', { class: 'dim', text: L.govNoTimelock })); return; }
    try {
      const ops = await reviewTimelock({ send, timelock: tl, fromBlock: ctx.cfg.contracts?.timelockBlock ?? 0 });
      q?.replaceChildren(...(ops.length ? ops.map((o) => ctx.el('div', { class: 'ga-item small', 'data-op': o.id },
        ctx.el('p', { class: 'mono', text: `${o.fn.name} @ ${o.target}` }),
        ctx.el('p', { class: 'dim', text: `${L.govReady(when(ctx, o.readyAt))} · ${sim(o.sim)}` }), ...flags(o.flags))) : [ctx.el('p', { class: 'dim', text: L.govQueueNone })]));
    } catch (e) { q?.replaceChildren(ctx.el('p', { class: 'dim', text: String(e.message).slice(0, 160) })); }
  },
};

/** The PQ archive check in this browser: ML-DSA-44 + keccak-256 from the wallet's bundle, SHA-256 from WebCrypto. */
export async function browserVerify(archive, { evmCall, pqwallet, verdict }) {
  const { ml_dsa44, keccak_256 } = pqwallet;
  const crypto = {
    sha256: async (b) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', b)),
    keccak256: (b) => keccak_256(b),
    verify: (sig, msg, pub) => ml_dsa44.verify(sig, msg, pub),
  };
  const anchorOf = async (hash, a) => {
    if (Number(a?.chainId) !== 77390 || !ADDR.test(a?.contract ?? '')) throw new Error('anchor on another chain');
    return readAnchoredAt(await evmCall('eth_call', [{ to: a.contract, data: anchoredAtData(hash) }, 'latest']));
  };
  const checkReport = verdict ? async (p) => (p?.report ? ((await verdict.verdictOf(p.report)) === p.reportHash ? null : 'the report in the payload does not give its reportHash') : null) : null;
  return verifyArchive(archive, crypto, { anchorOf, checkReport });
}

const immune = {
  render(root, ctx) {
    const L = A(ctx.lang);
    const certIn = ctx.el('input', { id: 'im-addr', class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: '0x…', 'aria-label': L.imCertHint });
    const certOut = ctx.el('div', { id: 'im-cert', class: 'small', role: 'status' });
    const certForm = ctx.el('form', { class: 'row', id: 'im-cert-form', autocomplete: 'off' }, certIn, ctx.el('button', { type: 'submit', class: 'btn', text: L.imCheck }));
    certForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const attest = ctx.cfg.contracts?.neuroAttest;
      if (!ADDR.test(attest ?? '')) { certOut.textContent = L.imCertNone; return; }
      if (!ADDR.test(certIn.value.trim())) { certOut.textContent = L.imCertNo; return; }
      const b = await badgeOf(ctx.evmCall, attest, certIn.value.trim());
      if (!b || b.uid === 0n) { certOut.replaceChildren(ctx.el('p', { text: L.imCertNo })); return; }
      certOut.replaceChildren(ctx.el('p', { class: b.checked ? 'msg ok' : 'warnline', 'data-badge': b.checked ? 'checked' : 'revoked', text: b.checked ? L.imCertYes(String(b.uid), ctx.short(b.by)) : L.imCertRevoked }),
        ctx.el('dl', { class: 'kv3' }, [[L.imReport, b.reportHash], [L.imSkill, b.skill], [L.imModel, b.model || '–']].flatMap(([k, v]) => [ctx.el('dt', { text: k }), ctx.el('dd', { class: 'mono', text: v })])));
    });
    const file = ctx.el('input', { type: 'file', id: 'im-pq-file', accept: '.json,application/json', 'aria-label': L.imPq });
    const pqOut = ctx.el('div', { id: 'im-pq', class: 'small', role: 'status' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      pqOut.textContent = '…';
      try {
        const archive = JSON.parse(await f.text());
        const [pqwallet, verdict] = await Promise.all([import('./wallet/vendor/pqwallet.js'), import('./neuro/src/verdict.js').catch(() => null)]);
        const r = await browserVerify(archive, { evmCall: ctx.evmCall, pqwallet, verdict });
        pqOut.replaceChildren(ctx.el('p', { class: r.ok ? 'msg ok' : 'warnline', 'data-pq': r.ok ? 'valid' : 'invalid', text: r.ok ? L.imPqOk : L.imPqBad }),
          ...r.problems.map((p) => ctx.el('p', { class: 'warnline', text: `– ${p}` })),
          r.keyHash ? ctx.el('p', { class: 'mono', text: `${L.imPqKey}: ${r.keyHash}` }) : null,
          ctx.el('p', { class: 'dim', text: r.anchored ? L.imPqAnchored(when(ctx, r.anchored.time)) : L.imPqNotAnchored }));
      } catch (e) { pqOut.replaceChildren(ctx.el('p', { class: 'warnline', 'data-pq': 'invalid', text: `${L.imPqBad}: ${String(e.message).slice(0, 160)}` })); }
    });
    root.replaceChildren(ctx.el('p', { class: 'dim small sp-intro', text: L.imIntro }),
      ctx.el('div', { class: 'grid3' },
        card(ctx, L.imCoverage, null, ctx.el('div', { id: 'im-cov' }, ctx.el('p', { class: 'dim', text: '…' }))),
        card(ctx, L.imCert, L.imCertHint, certForm, certOut),
        card(ctx, L.imPq, L.imPqHint, file, pqOut)));
  },
  async refresh(root, ctx) {
    const L = A(ctx.lang);
    const box = root.querySelector('#im-cov');
    const im = ctx.cfg.immune;
    if (!ADDR.test(im?.sender ?? '') || !(im.mirrors ?? []).length) { box?.replaceChildren(ctx.el('p', { class: 'dim', text: L.imNotDeployed })); return; }
    try {
      const m = await measureCoverage({ immune: im, zSend: rawSender(ctx.ep().evm), chainSend: (x) => rawSender(x.rpc) });
      box?.replaceChildren(ctx.el('p', { class: 'dim', text: L.imFlagged(m.flagged) }),
        ctx.el('table', { class: 'tbl' }, ctx.el('tbody', {}, m.mirrors.map((x) => ctx.el('tr', { 'data-chain': x.name },
          ctx.el('td', { text: x.name }), ctx.el('td', { class: 'num mono', text: x.error ? L.imDown : `${pct(x.share)}${x.paused ? ` · ${L.imPaused}` : ''}` }))))));
    } catch (e) { box?.replaceChildren(ctx.el('p', { class: 'dim', text: String(e.message).slice(0, 160) })); }
  },
};

export const ASSIST_PAGES = { gov, immune };
