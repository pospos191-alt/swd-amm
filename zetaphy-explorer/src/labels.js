// Known-address labels: labels.json is generated at build time (scripts/known.js)
// from this repository's deployment records (launch state, DEX / NFT deployments,
// rewards, Hyperlane), module accounts, precompiles and the 0x…dEaD burn address.
// The app loads it once; labelTag() is used by the one address-link helper, so a
// label shows next to every address the explorer renders.
import { h } from './dom.js';
import { safeText } from './format.js';

const KINDS = new Set(['contract', 'token', 'module', 'precompile', 'burn', 'governance', 'bridge', 'neuro', 'deployer', 'zero']);
const ADDR = /^0x[0-9a-f]{40}$/;
// Always known, even before (or without) labels.json.
const BUILT_IN = [
  ['0x0000000000000000000000000000000000000000', 'Zero address (mint / burn)', 'zero'],
  ['0x000000000000000000000000000000000000dead', 'Burn address (0x…dEaD)', 'burn'],
];

let table = new Map();

/** Replaces the table with { lowerAddress: [name, kind] } (bad rows dropped, names sanitised). */
export function setLabels(obj) {
  table = new Map();
  for (const [a, name, kind] of BUILT_IN) table.set(a, { name, kind });
  for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
    const key = String(k).toLowerCase();
    if (!ADDR.test(key) || !Array.isArray(v)) continue;
    const name = safeText(v[0], 60);
    if (name) table.set(key, { name, kind: KINDS.has(v[1]) ? v[1] : 'contract' });
  }
  return table.size;
}
setLabels({});

/** Fetches labels.json next to the page (same origin); keeps the built-in table on failure. */
export async function loadLabels(fetchFn = (...a) => fetch(...a)) {
  try {
    const res = await fetchFn('labels.json', { credentials: 'omit', cache: 'default' });
    if (res.ok) return setLabels((await res.json())?.labels);
  } catch { /* built-in only */ }
  return table.size;
}

/** { name, kind } of an address (any case), or null. */
export const labelOf = (addr) => table.get(String(addr ?? '').toLowerCase()) ?? null;

/** The label chip shown after an address link (null when unknown). */
export function labelTag(addr) {
  const l = labelOf(addr);
  return l ? h('span', { class: ['addr-label', `label-${l.kind}`], title: l.name }, l.name) : null;
}

/** Every label (for the "ask" box: names that can be searched). */
export const allLabels = () => [...table.entries()].map(([address, l]) => ({ address, ...l }));
