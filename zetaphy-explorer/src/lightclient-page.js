// lightclient.html: runs the STARK light-client VERIFIER (vendor/starklc-lib.js)
// in the browser. No RPC: the demo proofs are static files next to this page,
// and any other proof can be opened from disk.
import { StarkLightClient, verifyProof } from '../vendor/starklc-lib.js';

const $ = (id) => document.getElementById(id);
const DEMO = 'lightclient/demo/';
let lc = null;
let manifest = null;

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const sigText = (r) => (r.sigCheck === 'none' ? 'trusted (none)' : r.sigBits === Infinity ? `all ${r.revealed} checked` : `${r.sigBits.toFixed(0)} bits (${r.revealed} sampled)`);
const stText = (st) => (st.kind === 'block' ? `block ${st.height} ${st.hash.slice(0, 12)}…` : `handoff → epoch ${st.height}`);

function showPin() {
  $('lc-pin').textContent = `Current pin: epoch ${lc.epoch} · root ${lc.pin.root} · 2^${lc.pin.logN} rows`;
  $('lc-chain').value = lc.chainId;
  $('lc-root').value = lc.pin.root;
  $('lc-logn').value = lc.pin.logN;
}

function row(file, size, r, err) {
  const tr = el('tr');
  tr.append(el('td', file, 'lc-mono'));
  if (err) {
    tr.append(el('td', '–'), el('td', `rejected: ${err.message}`, 'lc-bad'));
    for (let i = 0; i < 4; i++) tr.append(el('td', '–'));
    tr.append(el('td', kb(size)), el('td', '–'));
  } else {
    tr.append(el('td', stText(r.statement)),
      el('td', r.ok ? (r.pqMajority ? 'certified (> 2/3 of all power)' : 'certified (chain rule)') : 'NOT certified: not enough power', r.ok ? 'lc-ok' : 'lc-warn'),
      el('td', `${r.S} / ${r.T} (${r.U})`), el('td', String(r.C)), el('td', sigText(r), r.sigCheck === 'none' ? 'lc-warn' : ''),
      el('td', kb(size)), el('td', `${r.ms.toFixed(0)} ms`));
  }
  $('lc-results').tBodies[0].append(tr);
  return tr;
}

async function fetchBytes(file) {
  const res = await fetch(DEMO + file);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function runDemo() {
  $('lc-run').disabled = true;
  $('lc-results').tBodies[0].replaceChildren();
  lc = new StarkLightClient({ chainId: manifest.chainId, pin: manifest.genesis, epoch: manifest.genesis.epoch });
  for (const h of manifest.handoffs) {
    const bytes = await fetchBytes(h.file);
    try { row(h.file, bytes.length, lc.applyHandoff(bytes)); } catch (e) { row(h.file, bytes.length, null, e); }
  }
  for (const b of manifest.blocks) {
    const bytes = await fetchBytes(b.file);
    // minSigBits 0: the demo also shows a 'none' proof, labelled as trusting the prover.
    try { row(b.file, bytes.length, lc.verifyBlock(bytes, { minSigBits: 0 })); } catch (e) { row(b.file, bytes.length, null, e); }
  }
  // A forged copy: one byte of the first block proof flipped must be rejected.
  const forged = await fetchBytes(manifest.blocks[0].file);
  forged[forged.length >> 1] ^= 1;
  try { row(`${manifest.blocks[0].file} (1 byte flipped)`, forged.length, lc.verifyBlock(forged)); } catch (e) { row(`${manifest.blocks[0].file} (1 byte flipped)`, forged.length, null, e); }
  showPin();
  document.body.dataset.demo = 'done';
  $('lc-run').disabled = false;
}

async function verifyFile() {
  const f = $('lc-file').files?.[0];
  if (!f) return;
  const out = $('lc-out');
  out.textContent = 'verifying…';
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const pin = { root: $('lc-root').value.trim().replace(/^0x/i, ''), logN: Number($('lc-logn').value), logBlowup: 4 };
    const r = verifyProof(bytes, { pin, chainId: $('lc-chain').value.trim(), minSigBits: Number($('lc-minsig').value) });
    out.className = `lc-out ${r.ok ? 'lc-ok' : 'lc-warn'}`;
    out.textContent = [`${r.ok ? 'VALID, rule holds' : 'VALID proof, but the rule does NOT hold'}: ${stText(r.statement)}`,
      `signed power S = ${r.S}, total T = ${r.T}, keyless U = ${r.U}, signers C = ${r.C}, required ${r.required}`,
      `signature check: ${sigText(r)}; STARK ${r.starkBits.conjectured} bits conjectured / ${r.starkBits.provable} provable`,
      `${kb(bytes.length)} verified in ${r.ms.toFixed(0)} ms`].join('\n');
  } catch (e) {
    out.className = 'lc-out lc-bad';
    out.textContent = `REJECTED: ${e.message}`;
  }
}

async function init() {
  try {
    manifest = await (await fetch(`${DEMO}manifest.json`)).json();
    $('lc-genesis').textContent = `${manifest.genesis.root} (${manifest.genesis.validators.length} validators, chain ${manifest.chainId})`;
    lc = new StarkLightClient({ chainId: manifest.chainId, pin: manifest.genesis, epoch: manifest.genesis.epoch });
    showPin();
    $('lc-run').disabled = false;
  } catch (e) { $('lc-genesis').textContent = `cannot load the demo: ${e.message}`; }
  $('lc-run').addEventListener('click', () => { runDemo().catch((e) => { $('lc-pin').textContent = e.message; $('lc-run').disabled = false; }); });
  $('lc-file').addEventListener('change', () => { verifyFile(); });
}
init();
