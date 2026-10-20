// Verified source from Sourcify (free, no key). Sourcify recompiles the
// published source and checks it produces the bytecode on chain, so an
// "exact match" proves the source shown is the code that runs.
//
// Neuro uses it to (1) say whether the source is public and in which
// language (Solidity, Vyper, Yul via Solidity), and (2) name functions its
// selector list did not know: the verified ABI gives every function's real
// name, so a tax setter called `setRewardSwapRatio` is no longer just
// "0x1234abcd".

import { selectorOf } from './keccak.js';
import { scanFunctions } from './move.js';

export const SOURCIFY = 'https://sourcify.dev/server';

/** ABI input -> canonical type ("tuple" expands to "(a,b)"). */
function canonical(input) {
  const t = String(input?.type ?? '');
  if (t.startsWith('tuple')) return `(${(input.components ?? []).map(canonical).join(',')})${t.slice(5)}`;
  return t;
}

const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** ABI -> [{ selector, sig, name, mutating }] for functions with plain names. */
export function abiFunctions(abi) {
  if (!Array.isArray(abi)) return [];
  return abi
    .filter((e) => e?.type === 'function' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(e.name ?? ''))
    .map((e) => {
      const sig = `${e.name}(${(e.inputs ?? []).map(canonical).join(',')})`;
      const mutating = !['view', 'pure'].includes(e.stateMutability) && e.constant !== true;
      return { selector: selectorOf(sig), sig, name: e.name, mutating };
    });
}

/**
 * Categorises functions found only through the ABI (names in camelCase),
 * with the same whole-word rules used for Move and Anchor names.
 * Returns { [selector]: cat }.
 */
export function categorize(fns) {
  const bySnake = new Map(fns.filter((f) => f.mutating).map((f) => [snake(f.name), f]));
  const cats = scanFunctions([...bySnake.keys()].map((n) => ({ module: 'x', name: n, callable: true })));
  const out = {};
  for (const [cat, list] of Object.entries(cats)) {
    for (const q of list) {
      const f = bySnake.get(q.slice(3)); // drop "x::"
      if (f && !out[f.selector]) out[f.selector] = cat;
    }
  }
  return out;
}

/**
 * Looks a contract up on Sourcify. Returns null when it is not verified
 * there, or { match, language, compiler, name, abi, url }.
 */
export async function lookupSourcify(chainId, address, { fetchImpl = globalThis.fetch, base = SOURCIFY, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/v2/contract/${chainId}/${address}?fields=abi,compilation`, { method: 'GET', signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = await res.json();
    const match = b.match ?? b.runtimeMatch ?? null;
    if (!match) return null;
    const c = b.compilation ?? {};
    return {
      match: match === 'exact_match' ? 'exact' : 'partial',
      language: typeof c.language === 'string' ? c.language.slice(0, 20) : undefined,
      compiler: typeof c.compilerVersion === 'string' ? c.compilerVersion.slice(0, 60) : undefined,
      name: typeof c.name === 'string' && /^[A-Za-z0-9_$]{1,64}$/.test(c.name) ? c.name : undefined,
      abi: Array.isArray(b.abi) ? b.abi : [],
      url: `https://repo.sourcify.dev/${chainId}/${address}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
