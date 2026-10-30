// What a contract is, for the tx and contract pages: its verified source and ABI
// on Sourcify (chain 77390), else one of this repo's own contracts (sigdb.js), else
// the functions its bytecode seems to have (guessed); whether it is a proxy
// (EIP-1967 implementation / admin / beacon slots, EIP-1167 minimal proxy) and then
// its implementation's ABI. Every source is said: verified, known or guessed.
// No server: Sourcify's public API is read from the browser (CSP connect-src https:).
import { fromJsonAbi, keccakHex, decodeParams, encodeCall } from './abi.js';
import { makeSigDb, loadKnown } from './sigdb.js';
import { safeText } from './format.js';

export const SOURCIFY_API = 'https://sourcify.dev/server';
export const SOURCIFY_REPO = 'https://repo.sourcify.dev';
const MAX_FILES = 60;
const MAX_FILE_CHARS = 400_000;

const enc = new TextEncoder();
const slotOf = (name) => '0x' + (BigInt('0x' + keccakHex(enc.encode(name))) - 1n).toString(16).padStart(64, '0');
/** EIP-1967 storage slots: keccak256(name) - 1. */
export const SLOTS = Object.freeze({
  implementation: slotOf('eip1967.proxy.implementation'),
  admin: slotOf('eip1967.proxy.admin'),
  beacon: slotOf('eip1967.proxy.beacon'),
});
// EIP-1167 minimal proxy and its PUSH0 form (ERC-7511)
const MINIMAL = [/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i, /^0x365f5f375f5f365f73([0-9a-f]{40})5af43d5f5f3e5f3d91602a57fd5bf3$/i];
const IMPLEMENTATION_SEL = '5c60da1b'; // implementation()

/** A 32-byte storage word holding an address -> 0x… (lower case), or null (zero / not an address / unreadable). */
export function slotAddress(word) {
  if (typeof word !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(word)) return null;
  const w = word.slice(2).padStart(64, '0').toLowerCase();
  if (!/^0{24}/.test(w) || /^0{64}$/.test(w)) return null;
  return '0x' + w.slice(24);
}

/**
 * Where a proxy forwards calls, or null when it is not one we can see:
 * { kind: 'eip1167' | 'eip1967' | 'beacon', implementation, admin, beacon }.
 * evm(method, params) is the node's EVM JSON-RPC; unreadable slots count as empty.
 */
export async function readProxy(evm, address, code) {
  if (typeof code !== 'string' || code.length <= 2) return null;
  for (const re of MINIMAL) { const m = re.exec(code); if (m) return { kind: 'eip1167', implementation: '0x' + m[1].toLowerCase(), admin: null, beacon: null }; }
  const read = (slot) => evm('eth_getStorageAt', [address, slot, 'latest']).then(slotAddress, () => null);
  const [implementation, admin, beacon] = await Promise.all([read(SLOTS.implementation), read(SLOTS.admin), read(SLOTS.beacon)]);
  if (beacon) {
    const bi = await evm('eth_call', [{ to: beacon, data: '0x' + IMPLEMENTATION_SEL }, 'latest']).then(slotAddress, () => null);
    return { kind: 'beacon', implementation: bi, admin, beacon };
  }
  if (implementation) return { kind: 'eip1967', implementation, admin, beacon: null };
  return null;
}

/**
 * Sourcify's answer for an address (v2 API) -> null when not verified there, else
 * { match: 'full' | 'partial', abi: { functions, events, errors }, name, language, compiler,
 *   files: [{ path, content }], deployment: { txHash, block, deployer } | null }.
 * Throws when Sourcify cannot be reached (so the page can say "could not check", not "not verified").
 */
export async function fetchSourcify(fetchFn, chainId, address, { api = SOURCIFY_API } = {}) {
  const url = `${api}/v2/contract/${Number(chainId)}/${String(address).toLowerCase()}?fields=abi,sources,compilation,deployment`;
  const res = await fetchFn(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'default', redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sourcify answered HTTP ${res.status}`);
  const body = await res.json();
  return readSourcify(body);
}

/** The v2 body -> the shape above (pure; untrusted input). */
export function readSourcify(body) {
  const m = body?.match ?? body?.runtimeMatch ?? null;
  if (!m) return null;
  const files = Object.entries(body.sources && typeof body.sources === 'object' ? body.sources : {})
    .slice(0, MAX_FILES)
    .map(([path, f]) => ({ path: safeText(path, 200), content: String(f?.content ?? '').slice(0, MAX_FILE_CHARS) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const c = body.compilation ?? {};
  const d = body.deployment ?? null;
  const addr = (x) => (/^0x[0-9a-fA-F]{40}$/.test(String(x ?? '')) ? String(x) : null);
  const hash = (x) => (/^0x[0-9a-fA-F]{64}$/.test(String(x ?? '')) ? String(x).toLowerCase() : null);
  return {
    match: m === 'exact_match' || m === 'perfect' || m === 'full' ? 'full' : 'partial',
    abi: fromJsonAbi(body.abi),
    name: safeText(c.name ?? '', 80) || null,
    language: safeText(c.language ?? '', 20) || null,
    compiler: safeText(c.compilerVersion ?? '', 80) || null,
    files,
    deployment: d && (hash(d.transactionHash) || addr(d.deployer)) ? { txHash: hash(d.transactionHash), block: /^\d+$/.test(String(d.blockNumber ?? '')) ? String(d.blockNumber) : null, deployer: addr(d.deployer) } : null,
  };
}

const emptyAbi = () => ({ functions: [], events: [], errors: [] });
/** Two ABIs as one (the first wins on a clash): a proxy's own functions plus its implementation's. */
export function mergeAbi(a, b) {
  const out = emptyAbi();
  for (const k of Object.keys(out)) {
    const seen = new Set();
    for (const f of [...(a?.[k] ?? []), ...(b?.[k] ?? [])]) {
      const key = (f.selector ?? f.topic) + f.signature;
      if (!seen.has(key)) { seen.add(key); out[k].push(f); }
    }
  }
  return out;
}

/**
 * The resolver the pages share (one per node connection):
 *   resolve(address) -> Promise<Info> (cached), where Info is
 *   { address, code, isContract, source: 'verified' | 'known' | 'guessed' | null, name, label,
 *     matchedBy, abi, sourcify, sourcifyError, proxy, impl (Info of the implementation) , fullAbi (own + implementation) }
 *   sigdb() -> Promise<the sigdb.js lookup>
 * evm(method, params, ttl?) is the queued node RPC; fetchFn is fetch (Sourcify).
 */
export function contractResolver({ evm, fetchFn = (...a) => fetch(...a), chainId = 77390, sourcifyApi = SOURCIFY_API, known = loadKnown }) {
  let dbPromise = null;
  const sigdb = () => (dbPromise ??= Promise.resolve(known()).then((K) => makeSigDb(K)).catch(() => makeSigDb()));
  const cache = new Map();

  async function build(address, depth) {
    const a = String(address).toLowerCase();
    const code = await evm('eth_getCode', [a, 'latest']).catch(() => null);
    const info = { address: a, code: typeof code === 'string' ? code : null, isContract: typeof code === 'string' && code.length > 2,
      source: null, name: null, label: null, matchedBy: null, abi: null, sourcify: null, sourcifyError: null, proxy: null, impl: null };
    if (!info.isContract) { info.fullAbi = emptyAbi(); return info; }
    const db = await sigdb();
    const [sv, proxy] = await Promise.all([
      fetchSourcify(fetchFn, chainId, a, { api: sourcifyApi }).catch((e) => { info.sourcifyError = String(e?.message ?? e).slice(0, 200); return null; }),
      readProxy(evm, a, info.code).catch(() => null),
    ]);
    if (sv) Object.assign(info, { source: 'verified', sourcify: sv, abi: sv.abi, name: sv.name, matchedBy: 'sourcify' });
    const rec = db.recognise(a, info.code);
    if (rec) {
      info.label = rec.label;
      if (!sv) Object.assign(info, { source: rec.matchedBy === 'selectors' ? 'guessed' : 'known', abi: rec.contract.abi, name: rec.contract.name, matchedBy: rec.matchedBy, repo: rec.contract.repo });
    }
    info.proxy = proxy;
    if (proxy?.implementation && depth < 2) info.impl = await resolve(proxy.implementation, depth + 1).catch(() => null);
    if (!info.abi && info.impl?.abi) info.source = info.impl.source; // a proxy: its implementation's ABI is the one that counts
    else if (!info.abi) {
      const g = db.guessAbi(info.code);
      if (g.functions.length || g.events.length) Object.assign(info, { source: 'guessed', abi: g, matchedBy: 'bytecode' });
    }
    info.fullAbi = mergeAbi(info.abi, info.impl?.abi);
    return info;
  }

  function resolve(address, depth = 0) {
    const k = String(address).toLowerCase();
    if (!cache.has(k)) {
      const p = build(k, depth);
      cache.set(k, p);
      p.catch(() => cache.delete(k));
    }
    return cache.get(k);
  }
  return { resolve, sigdb };
}

/**
 * Calls a view function: eth_call -> { values } decoded with its outputs, or { revert: data hex | null, error }.
 * call(to, data) -> hex (throws an RpcError whose message may hold the revert data).
 */
export async function readFunction(call, address, fragment, args) {
  const data = encodeCall(fragment, args);
  let out;
  try { out = await call(address, data); } catch (e) {
    const msg = String(e?.message ?? e);
    const hex = /0x[0-9a-fA-F]{8,}/.exec(msg)?.[0] ?? null;
    return { error: msg.slice(0, 300), revert: hex };
  }
  try { return { values: decodeParams(fragment.outputs, out, { strict: false }), raw: out }; } catch (e) { return { raw: out, error: `cannot decode: ${e.message}` }; }
}

/** Functions to list on the Read / Write tabs. */
export const readable = (abi) => (abi?.functions ?? []).filter((f) => f.mutability === 'view' || f.mutability === 'pure').sort((a, b) => a.name.localeCompare(b.name) || a.inputs.length - b.inputs.length);
export const writable = (abi) => (abi?.functions ?? []).filter((f) => f.mutability === 'nonpayable' || f.mutability === 'payable').sort((a, b) => a.name.localeCompare(b.name) || a.inputs.length - b.inputs.length);
