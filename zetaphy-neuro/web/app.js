// Web page for Neuro ZETAPHY tier 1. Everything shown from the chain goes
// through textContent, never innerHTML: token names are written by strangers.
import { readContract } from '../src/reader.js';
import { explain, LANGS, uiText, pickLang } from '../src/explain.js';
import { CHAINS, isChainAddress, explorerUrl } from '../src/chains.js';

const $ = (id) => document.getElementById(id);
// What an address looks like on each kind of chain (placeholder and error hint).
const FORMAT = {
  evm: { placeholder: '0x…', hint: '0x + 40 hex' },
  solana: { placeholder: 'EPjFWdd5…', hint: 'base58, 32–44' },
  sui: { placeholder: '0x…::coin::COIN', hint: '0x…::module::NAME / 0x… (package)' },
  aptos: { placeholder: '0x… / 0x…::coin::COIN', hint: '0x… (Fungible Asset) / 0x…::module::Name' },
  ton: { placeholder: 'EQ… / UQ…', hint: 'EQ…/UQ… (48) / 0:…' },
  near: { placeholder: 'token.near', hint: 'name.near / 64 hex' },
  starknet: { placeholder: '0x…', hint: '0x + up to 64 hex' },
  bitcoin: { placeholder: 'DOG•GO•TO•THE•MOON', hint: 'Rune name / id (840000:3)' },
  cosmwasm: { placeholder: 'osmo1… / factory/osmo1…/name', hint: 'bech32 (osmo1… / neutron1…) / factory/<creator>/<name>' },
};
const kindOf = (chain) => CHAINS[chain]?.kind ?? 'evm';

let lang = 'th';
let last = null;
try { lang = pickLang(localStorage.getItem('neuro-lang') ?? 'th'); } catch { /* storage blocked */ }

for (const [key, c] of Object.entries(CHAINS)) $('chain').add(new Option(c.name, key));
$('chain').value = 'bsc';
for (const [code, L] of Object.entries(LANGS)) $('lang').add(new Option(L.NAME, code));
const setPlaceholder = () => { $('address').placeholder = FORMAT[kindOf($('chain').value)].placeholder; };
$('chain').addEventListener('change', setPlaceholder);

function applyLang() {
  document.documentElement.lang = lang;
  $('lang').value = lang;
  const ui = uiText(lang);
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = ui[el.dataset.i18n];
  $('lang').setAttribute('aria-label', ui.language);
  if (last) render(last);
}

function status(text, isError = false) {
  $('status').textContent = text;
  $('status').className = isError ? 'error' : '';
}

function render(report) {
  const out = explain(report, lang);
  const { m } = uiText(lang);
  $('verdict').className = `verdict ${out.level}`;
  $('title').textContent = out.title;
  const list = $('findings');
  list.replaceChildren(...out.lines.map((l) => {
    const li = document.createElement('li');
    li.className = l.severity;
    li.textContent = l.text;
    return li;
  }));
  const rows = [[m.chain, CHAINS[report.chain].name], [m.address, report.address]];
  if (report.proxy?.kind) rows.push([m.proxy, report.proxy.kind]);
  if (report.proxy?.implementation) rows.push([m.implementation, report.proxy.implementation]);
  if (report.owner) rows.push([m.owner, report.owner]);
  if (report.functions) rows.push([m.functions, String(report.functions.length)]);
  if (report.unknownSelectors?.length) rows.push([m.unknown, report.unknownSelectors.map((x) => '0x' + x).join(' ')]);
  if (report.solana) {
    const sol = report.solana;
    if (sol.program && sol.program !== 'upgradeable-loader') rows.push([m.program, sol.program]);
    if ('mintAuthority' in sol) rows.push([m.mintAuth, sol.mintAuthority ?? m.none]);
    if ('freezeAuthority' in sol) rows.push([m.freezeAuth, sol.freezeAuthority ?? m.none]);
    if (sol.extensions?.length) rows.push([m.extensions, sol.extensions.join(', ')]);
    if ('upgradeAuthority' in sol) rows.push([m.upgradeAuth, sol.upgradeAuthority ?? m.none]);
  }
  if (report.raw) rows.push([m.raw, report.raw]);
  if (report.move) {
    const mv = report.move;
    if (mv.standard) rows.push([m.standard, mv.standard]);
    if (mv.package) rows.push([m.package, mv.package]);
    if (mv.owner) rows.push([m.owner, mv.owner]);
    for (const p of mv.packages ?? []) rows.push([m.package, p.address]);
    if (mv.upgrade && 'policy' in mv.upgrade) rows.push([m.upgradeAuth, mv.upgrade.owner?.address ?? mv.upgrade.owner?.kind ?? m.none]);
  }
  if (report.ton) {
    rows.push([m.admin, report.ton.admin ?? m.none]);
    rows.push([m.listed, report.ton.verification]);
    const w = report.ton.wallet;
    if (w) rows.push([m.walletCode, `${w.interfaces.join(', ') || '?'} · ${w.codeHash ?? '?'}`]);
  }
  if (report.format) rows.push([m.format, report.format]);
  if (report.delegation) rows.push([m.delegation, report.delegation]);
  if (report.source) rows.push([m.source, `${report.source.match} · ${report.source.url}`]);
  // Trade simulation (honeypot check): the pool it used and the taxes it saw.
  const sim = report.sim;
  if (sim?.pair) rows.push([m.pool, `${sim.dex} · ${sim.pair}`]);
  if (sim?.buyTax != null) rows.push([m.simTax, `${sim.buyTax}% / ${sim.sellTax != null ? `${sim.sellTax}%` : m.simFailed}`]);
  if (report.solana?.idl) rows.push([m.idl, `${report.solana.idl.name} · ${report.solana.idl.address}`]);
  if (report.cosmwasm) {
    const c = report.cosmwasm;
    if (c.label) rows.push([m.label, c.label]);
    if (c.codeId) rows.push([m.codeId, c.codeId]);
    if (c.creator) rows.push([m.creator, c.creator]);
    rows.push([m.admin, c.admin ?? m.none]);
    if (c.migrations) rows.push([m.migrations, String(c.migrations)]);
    if (c.hook) rows.push([m.hook, c.hook]);
  }
  if (report.near) {
    rows.push([m.nearKeys, String(report.near.fullAccessKeys)]);
    rows.push([m.functions, String(report.near.methods)]);
    rows.push([m.codeHash, report.near.codeHash]);
  }
  if (report.starknet) {
    rows.push([m.cairo, String(report.starknet.cairo)]);
    rows.push([m.functions, String(report.starknet.functions)]);
    if (report.starknet.implementation) rows.push([m.implementation, report.starknet.implementation]);
  }
  if (report.bitcoin) {
    const b = report.bitcoin;
    rows.push([m.standard, b.standard]);
    rows.push([m.tokenId, b.id]);
    if (b.maxSupply) rows.push([m.maxSupply, b.maxSupply]);
  }
  if (report.token?.holders != null) rows.push([m.holders, report.token.holders.toLocaleString('en-US')]);
  if (report.fingerprint) rows.push([m.fingerprint, report.fingerprint]);
  rows.push([m.report, report.reportHash]);
  const dl = $('meta');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  const dt = document.createElement('dt'); dt.textContent = m.explorer;
  const dd = document.createElement('dd');
  const a = document.createElement('a');
  a.href = explorerUrl(report.chain, report.address); // address already validated
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = new URL(a.href).hostname;
  dd.append(a); dl.append(dt, dd);
  $('result').hidden = false;
}

// Counts one "check" toward the monthly user goal. Sends nothing about the
// contract or the visitor; skipped when the browser asks not to be tracked.
function reportUsage() {
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
  if (!/^https?:$/.test(location.protocol)) return;
  fetch('/api/usage', {
    method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'check' }),
  }).catch(() => { /* counter is optional */ });
}

async function run(chain, address) {
  const ui = uiText(lang);
  if (!isChainAddress(chain, address)) { status(ui.badAddress + FORMAT[kindOf(chain)].hint, true); return; }
  $('go').disabled = true;
  $('result').hidden = true;
  status(ui.reading);
  try {
    last = await readContract(chain, address);
    render(last);
    status('');
    reportUsage();
    const u = new URL(location.href);
    u.searchParams.set('chain', chain); u.searchParams.set('address', address);
    history.replaceState(null, '', u);
  } catch (e) {
    status(uiText(lang).failed + e.message, true);
  } finally {
    $('go').disabled = false;
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  run($('chain').value, $('address').value.trim());
});
$('lang').addEventListener('change', () => {
  lang = pickLang($('lang').value);
  try { localStorage.setItem('neuro-lang', lang); } catch { /* storage blocked */ }
  applyLang();
});

applyLang();
// Shareable links: ?chain=bsc&address=0x…
const q = new URLSearchParams(location.search);
if (q.get('chain') in CHAINS) $('chain').value = q.get('chain');
setPlaceholder();
if (q.get('address')) { $('address').value = q.get('address'); run($('chain').value, q.get('address').trim()); }
