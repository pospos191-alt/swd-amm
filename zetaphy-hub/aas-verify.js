// The certificate check page (audit.html#<chain>:<address>; docs/future/audit-as-a-service.md). In the browser, with
// no server: reads AuditCertificate.certificate(chainId, target) from the ZETAPHY node, the code the target chain
// runs NOW from that chain's free public endpoints (EVM: EXTCODEHASH + proxy implementation, CosmWasm: the code
// checksum, Solana: the solana-verify program hash) and, where one is deployed, the NeuroOracle mirror there.
// Shows VALID / EXPIRED / REVOKED / CODE CHANGED (aas-core.js certificateStatus) and an embeddable badge.
import { keccak256 } from './neuro/src/keccak.js';
import * as aas from './aas-core.js';
import { T, page, el, when, loadConfig, setupLang } from './aas-page.js';

const k = keccak256;
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
let CFG = null;
let last = null; // the last result, re-rendered on a language change
let seq = 0;

const status = (text, cls = '') => { const s = document.getElementById('status'); s.textContent = text; s.className = `status ${cls}`; };

function chainOptions() {
  const sel = document.getElementById('chain');
  const cur = sel.value;
  sel.replaceChildren(...aas.AAS_CHAINS.map((c) => el('option', { value: c.key, text: c.name })));
  if (cur) sel.value = cur;
}

const reasonText = (r) => T(`r_${r}`);

function factsList(rows) {
  return el('dl', { class: 'facts' }, rows.filter(Boolean).flatMap(([dt, dd]) => [el('dt', { text: dt }), el('dd', { text: dd })]));
}

function render() {
  const root = document.getElementById('result');
  const badge = document.getElementById('badge');
  if (!last) { root.replaceChildren(); badge.hidden = true; return; }
  if (last.error) { root.replaceChildren(el('p', { class: 'bad', text: last.error })); badge.hidden = true; return; }
  const v = last.v;
  const chain = aas.chainOf(v.chain);
  const lv = page.L.levels[v.level];
  const head = el('div', { class: `verdict ${v.status}`, id: 'verdict', 'data-status': v.status },
    el('div', { class: 'big', text: T(`st_${v.status}`) + (v.status === 'valid' && v.level ? ` · ${page.L.levels[v.level]}` : '') }),
    el('p', { text: reasonText(v.reason) }),
    el('p', { class: 'mono muted', text: `${chain.name} · ${v.address}` }));
  const c = v.cert;
  const rows = [];
  if (c && c.issuedAt !== 0n) {
    rows.push([T('level'), lv || '–'], [T('certified'), c.codeHash], [T('running'), v.live?.codeHash ?? `${T('unreadable')} (${v.live?.error ?? ''})`],
      [T('issued'), when(c.issuedAt)], [T('expires'), when(c.expiresAt)], [T('request'), `#${c.requestId}`], [T('auditors'), String(c.auditors)],
      [T('reportHash'), c.reportHash], [T('sourceHash'), c.sourceHash]);
    if (v.impl) {
      const s = v.impl.cert ? aas.certificateStatus({ cert: v.impl.cert, valid: v.impl.valid, live: v.impl.live, now: Date.now() / 1000 }).status : 'none';
      rows.push([T('implementation'), `${v.impl.address ?? '?'} — ${T('implCert', { state: T(`st_${s}`) })}`]);
    }
    const who = v.live?.proxy?.admin ?? v.live?.admin ?? v.live?.authority;
    if (who) rows.push([T('admin'), who]);
    if (chain.kind === 'evm' && chain.key !== 'zetaphy') rows.push([T('mirror'), v.mirror == null ? T('mirrorNone') : v.mirror ? T('mirrorYes') : T('mirrorNo')]);
  } else if (v.live?.codeHash) rows.push([T('running'), v.live.codeHash]);
  root.replaceChildren(head, rows.length ? el('div', { class: 'card' }, factsList(rows)) : null);
  // the badge: as it looks right now (data: URL, CSP img-src allows it) + the snippet that embeds the published one
  const svg = aas.badgeSvg({ status: v.status, level: v.level });
  const s = aas.embedSnippets(chain, v.address);
  const copyBtn = (text) => el('button', { type: 'button', class: 'ghost', text: T('copy'), on: { click: async (e) => { try { await navigator.clipboard.writeText(text); e.target.textContent = T('copied'); } catch { /* no clipboard */ } } } });
  document.getElementById('badge-body').replaceChildren(
    el('p', {}, el('img', { class: 'badge', id: 'badge-img', alt: `ZETAPHY audit: ${T(`st_${v.status}`)}`, src: `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}` })),
    el('div', { class: 'snip' }, el('div', { class: 'row' }, el('strong', { text: 'HTML' }), copyBtn(s.html)), el('pre', { id: 'snip-html', text: s.html })),
    el('div', { class: 'snip' }, el('div', { class: 'row' }, el('strong', { text: 'Markdown' }), copyBtn(s.markdown)), el('pre', { text: s.markdown })));
  badge.hidden = false;
}

async function check(ref) {
  const my = ++seq;
  const chain = ref?.chain;
  if (!chain) { last = { error: T('badRef') }; render(); return; }
  if (!CFG.certificate) { last = { error: T('notDeployed') }; render(); return; }
  status(T('checking', { chain: chain.name }));
  document.getElementById('go').disabled = true;
  try {
    const zrpc = aas.rpcClient([CFG.node], { chainId: aas.ZETAPHY_CHAIN_ID });
    const zcall = (to, data) => zrpc('eth_call', [{ to, data }, 'latest']);
    const rpc = chain.key === 'zetaphy' ? zrpc : chain.kind === 'cosmwasm' ? null : aas.rpcClient(chain.rpcs, { chainId: chain.kind === 'evm' ? chain.chainId : null });
    const rest = chain.kind === 'cosmwasm' ? aas.restClient(chain.rpcs) : null;
    const m = chain.kind === 'evm' ? CFG.mirrors.find((x) => x.chainId === chain.chainId) : null;
    const mirror = m ? { oracle: m.oracle, call: (to, data) => rpc('eth_call', [{ to, data }, 'latest']) } : null;
    let v;
    try {
      v = await aas.verifyCertificate({ k, sha256, chain, address: ref.address, certificate: CFG.certificate, zcall, rpc, rest, mirror, now: Math.floor(Date.now() / 1000) });
    } catch (e) {
      if (my === seq) { last = { error: T('failed', { err: String(e?.message ?? e).slice(0, 160) }) }; render(); }
      return;
    }
    if (my !== seq) return;
    last = { v };
    render();
    status('');
  } finally {
    if (my === seq) document.getElementById('go').disabled = false;
  }
}

function fromHash() {
  const ref = aas.parseRef(location.hash);
  if (!ref) return null;
  document.getElementById('chain').value = ref.chain.key;
  document.getElementById('address').value = ref.address;
  return ref;
}

async function main() {
  CFG = await loadConfig();
  chainOptions();
  setupLang(() => { chainOptions(); render(); });
  document.getElementById('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const chain = aas.chainOf(document.getElementById('chain').value);
    const address = document.getElementById('address').value.trim();
    if (!chain || !aas.isNativeAddress(chain, address)) { last = { error: T('badRef') }; render(); return; }
    const h = `#${aas.refOf(chain, chain.kind === 'evm' ? address.toLowerCase() : address)}`;
    if (location.hash !== h) location.hash = h; // hashchange runs the check
    else check(aas.parseRef(h));
  });
  window.addEventListener('hashchange', () => { const r = fromHash(); if (r) check(r); });
  const ref = fromHash();
  if (ref) await check(ref);
  else if (location.hash.length > 1) { last = { error: T('badRef') }; render(); }
}

if (typeof document !== 'undefined' && document.getElementById('form')) main();
