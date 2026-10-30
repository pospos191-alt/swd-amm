// Shared by the Audit-as-a-Service pages (audit.html: aas-verify.js, audits.html: aas-directory.js): language,
// hub-config.json, DOM helpers. Everything goes in with textContent; no inline styles (CSP style-src 'self').
import { pickLang, locale, withFallback } from './i18n.js';
import { AAS } from './aas-i18n.js';

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
export const fmt = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (m, x) => (x in vars ? String(vars[x]) : m));
export const page = {
  lang: pickLang(new URLSearchParams(globalThis.location?.search ?? '').get('lang') ?? store.get('zetaphy-hub:lang')),
  get L() { return withFallback(AAS, this.lang); },
};
export const T = (k, vars) => fmt(page.L[k] ?? k, vars);
export const when = (t) => (t && BigInt(t) !== 0n ? new Date(Number(t) * 1000).toLocaleString(locale(page.lang)) : '–');

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

/** The node and the addresses this page needs from hub-config.json (public data); anything malformed is ignored. */
export async function loadConfig() {
  const ok = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const out = { node: 'https://rpc.sawasdeecoin.com', certificate: null, network: null, mirrors: [] };
  try {
    const cfg = await (await fetch('./hub-config.json', { cache: 'no-store', credentials: 'omit' })).json();
    if (/^https:\/\/[^/\s"<>]+$/.test(cfg.node ?? '')) out.node = cfg.node;
    if (ok(cfg.contracts?.auditCertificate)) out.certificate = cfg.contracts.auditCertificate.toLowerCase();
    if (ok(cfg.contracts?.auditNetwork)) out.network = cfg.contracts.auditNetwork.toLowerCase();
    out.mirrors = (cfg.immune?.mirrors ?? []).filter((m) => ok(m?.oracle) && Number.isInteger(m.chainId)).map((m) => ({ chainId: m.chainId, oracle: m.oracle.toLowerCase() }));
  } catch { /* defaults: nothing deployed */ }
  return out;
}

/** Fills [data-t] texts and wires the language menu; onChange re-renders the page's dynamic parts. */
export function setupLang(onChange) {
  const apply = () => {
    document.documentElement.lang = page.lang;
    for (const n of document.querySelectorAll('[data-t]')) n.textContent = T(n.dataset.t);
    document.getElementById('lang').value = page.lang;
  };
  apply();
  document.getElementById('lang').addEventListener('change', (e) => { page.lang = pickLang(e.target.value); store.set('zetaphy-hub:lang', page.lang); apply(); onChange(); });
}

export const short = (a) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
