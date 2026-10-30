// The Audit Directory (audits.html; docs/future/audit-as-a-service.md): every certificate in the public registry
// (audit-registry.json, built by .github/workflows/audit-registry.yml from ZETAPHY's own events, no server). The
// registry is untrusted input (aas-core cleanRegistry checks every field) and only an index: its states are as of
// its build; each row links to audit.html, which re-reads ZETAPHY and the target chain live.
import * as aas from './aas-core.js';
import { T, page, el, when, setupLang, fmt, short } from './aas-page.js';

let REG = null;
const STATES = ['valid', 'expired', 'revoked'];
const status = (text, cls = '') => { const s = document.getElementById('status'); s.textContent = text; s.className = `status ${cls}`; };

/** The first registry that loads and parses (the published branch, then the hub's own copy). */
export async function loadRegistry(urls = aas.REGISTRY_URLS, fetchImpl = globalThis.fetch) {
  for (const u of urls) {
    try {
      const r = await fetchImpl(u, { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) continue;
      const reg = aas.cleanRegistry(await r.json());
      if (reg.generatedAt || reg.entries.length) return reg;
    } catch { /* next */ }
  }
  return null;
}

function filters() {
  const fc = document.getElementById('f-chain'), fs = document.getElementById('f-state'), q = document.getElementById('q');
  const keep = [fc.value, fs.value];
  fc.replaceChildren(el('option', { value: '', text: T('allChains') }), ...aas.AAS_CHAINS.map((c) => el('option', { value: c.key, text: c.name })));
  fs.replaceChildren(el('option', { value: '', text: T('allStates') }), ...STATES.map((s) => el('option', { value: s, text: T(`st_${s}`) })));
  [fc.value, fs.value] = keep;
  q.placeholder = T('search');
  q.setAttribute('aria-label', T('search'));
  fc.setAttribute('aria-label', T('colChain'));
  fs.setAttribute('aria-label', T('colState'));
}

function render() {
  const root = document.getElementById('list');
  if (!REG) { root.replaceChildren(el('p', { class: 'muted', text: T('noRegistry') })); return; }
  const now = Date.now() / 1000;
  const q = document.getElementById('q').value.trim().toLowerCase();
  const fc = document.getElementById('f-chain').value, fs = document.getElementById('f-state').value;
  const rows = REG.entries.map((e) => ({ e, state: aas.registryState(e, now) }))
    .filter(({ e, state }) => (!fc || e.chain === fc) && (!fs || state === fs) && (!q || e.address.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)))
    .sort((a, b) => Number(BigInt(b.e.issuedAt) - BigInt(a.e.issuedAt)));
  const note = REG.generatedAt ? el('p', { class: 'muted', id: 'asof', text: T('asOf', { when: new Date(REG.generatedAt).toLocaleString(page.lang === 'en' ? 'en-GB' : page.lang) }) }) : null;
  if (!REG.entries.length) { root.replaceChildren(note ?? '', el('p', { class: 'muted', text: T('empty') })); return; }
  if (!rows.length) { root.replaceChildren(note ?? '', el('p', { class: 'muted', text: T('emptyFilter') })); return; }
  const tr = rows.map(({ e, state }) => {
    const chain = aas.chainOf(e.chain);
    const v = e.findings.valid;
    return el('tr', {},
      el('td', {}, e.name ? el('div', { text: e.name }) : null, el('div', { class: 'mono', title: e.address, text: short(e.address) }), el('div', { class: 'muted', text: page.L.roles[e.role] ?? e.role })),
      el('td', { text: chain.name }),
      el('td', { text: page.L.levels[e.level] || '–' }),
      el('td', {}, el('span', { class: `pill ${state}`, text: T(`st_${state}`) })),
      el('td', { text: when(e.expiresAt) }),
      el('td', { text: fmt(page.L.findingsLine, { valid: Object.values(v).reduce((a, b) => a + b, 0), ch: v.critical + v.high, fixed: e.findings.fixed }) }),
      el('td', {}, el('a', { href: `audit.html#${aas.refOf(chain, e.address)}`, text: T('open') })));
  });
  const head = ['colContract', 'colChain', 'colLevel', 'colState', 'colExpires', 'colFindings', 'colCheck'].map((x) => el('th', { text: T(x) }));
  root.replaceChildren(note ?? '', el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, head)), el('tbody', {}, tr))));
}

async function main() {
  filters();
  setupLang(() => { filters(); render(); });
  for (const id of ['q', 'f-chain', 'f-state']) document.getElementById(id).addEventListener('input', render);
  status('…');
  REG = await loadRegistry();
  status('');
  render();
}

if (typeof document !== 'undefined' && document.getElementById('list')) main();
