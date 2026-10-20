// Neuro tier 1 for Starknet (contracts in Cairo). Read-only: only the
// JSON-RPC methods starknet_chainId, starknet_getClassAt, starknet_getClass
// and starknet_call.
//
// Every Starknet contract publishes its ABI on chain with each function's
// name and whether it only reads (`view`) or can change state (`external`).
// So the code itself says what powers it has: mint, pause, set_fee,
// upgrade (Cairo 1 contracts replace their own code with `upgrade`).
// Older Cairo 0 contracts sit behind a proxy whose implementation class is
// read too.

import { keccak256 } from './keccak.js';
import { cleanText } from './abi.js';
import { RANK, LINK_RE, levelOf, scanFunctions, addPowerFindings } from './move.js';

export const SN_MAIN = '0x534e5f4d41494e'; // "SN_MAIN"
const MASK_250 = (1n << 250n) - 1n;
const UPGRADE_RE = /(^|_)(upgrade|upgrade_to|replace_class|set_implementation|upgrade_implementation)(_|$)/;

export function isStarknetAddress(s) {
  if (typeof s !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(s)) return false;
  return BigInt(s) < 1n << 251n && BigInt(s) > 0n;
}
export const normalize = (a) => '0x' + BigInt(a).toString(16).padStart(64, '0');

/** Starknet selector: keccak256(name) masked to 250 bits. */
export function selector(name) {
  const h = keccak256(new TextEncoder().encode(name));
  let n = 0n;
  for (const b of h) n = (n << 8n) | BigInt(b);
  return '0x' + (n & MASK_250).toString(16);
}

// ------------------------------------------------------------ decoding
const shortString = (felt) => {
  let h = BigInt(felt).toString(16);
  if (h.length % 2) h = '0' + h;
  let s = '';
  for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return s;
};

/** A string answer: one short-string felt (older tokens) or a ByteArray (newer). */
export function decodeString(felts) {
  if (!Array.isArray(felts) || felts.length === 0) return null;
  if (felts.length === 1) return shortString(felts[0]);
  const n = Number(BigInt(felts[0]));
  if (felts.length !== n + 3) return shortString(felts[0]);
  const words = felts.slice(1, 1 + n).map(shortString).join('');
  const pendingLen = Number(BigInt(felts[n + 2]));
  return words + (pendingLen ? shortString(felts[n + 1]) : '');
}

/** u256 = [low, high]; a single felt is also accepted. */
export function decodeU256(felts) {
  if (!Array.isArray(felts) || felts.length === 0) return null;
  if (felts.length === 1) return BigInt(felts[0]);
  return BigInt(felts[0]) + (BigInt(felts[1]) << 128n);
}

/** ABI (Cairo 0 array or Cairo 1 JSON string) -> [{name, external}] */
export function abiFunctions(abi) {
  let list = abi;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  const out = [];
  const take = (f) => {
    if (f?.type !== 'function' || typeof f.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(f.name)) return;
    const mut = f.state_mutability ?? f.stateMutability;
    out.push({ name: f.name, external: mut !== 'view' });
  };
  for (const e of list) {
    if (e?.type === 'interface') (e.items ?? []).forEach(take);
    else take(e);
  }
  return out;
}

// ---------------------------------------------------------------- reader
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export async function readStarknetAccount(rpc, address) {
  const addr = normalize(address);
  let cls;
  try {
    cls = await rpc.call('starknet_getClassAt', ['latest', addr]);
  } catch (e) {
    if (/contract not found|CONTRACT_NOT_FOUND|\b20\b/i.test(e.message)) return { kind: 'missing' };
    throw e;
  }
  let fns = abiFunctions(cls?.abi);
  const call = async (name, to = addr) => {
    try { return await rpc.call('starknet_call', [{ contract_address: to, entry_point_selector: selector(name), calldata: [] }, 'latest']); } catch { return null; }
  };

  // Cairo 0 proxy: read the implementation class's ABI too.
  let proxy = null;
  const has = (n) => fns.some((f) => f.name === n);
  for (const getter of ['get_implementation_hash', 'get_implementation', 'implementation', 'getImplementation']) {
    if (!has(getter)) continue;
    const r = await call(getter);
    if (r?.[0] && BigInt(r[0]) !== 0n) {
      proxy = { implementation: '0x' + BigInt(r[0]).toString(16) };
      try {
        const impl = await rpc.call('starknet_getClass', ['latest', proxy.implementation]);
        fns = [...fns, ...abiFunctions(impl?.abi)];
      } catch { /* implementation may be a contract, not a class: keep the proxy ABI */ }
    }
    break;
  }

  const names = new Set(fns.map((f) => f.name));
  const isToken = ['balance_of', 'balanceOf'].some((n) => names.has(n)) && ['transfer'].some((n) => names.has(n));
  let token;
  if (isToken) {
    const [n, s, d, t] = await Promise.all([call('name'), call('symbol'), call('decimals'), names.has('totalSupply') ? call('totalSupply') : call('total_supply')]);
    const dec = d ? Number(BigInt(d[0])) : undefined;
    token = {
      name: cleanText(decodeString(n)) ?? undefined,
      symbol: cleanText(decodeString(s), 24) ?? undefined,
      decimals: Number.isInteger(dec) && dec >= 0 && dec <= 36 ? dec : undefined,
      totalSupply: decodeU256(t)?.toString(),
    };
  }
  let owner;
  if (names.has('owner')) {
    const o = await call('owner');
    if (o?.[0] != null) owner = BigInt(o[0]) === 0n ? null : normalize(o[0]);
  }

  const external = fns.filter((f) => f.external).map((f) => snake(f.name));
  return {
    kind: isToken ? 'token' : 'contract',
    address: addr,
    cairo: typeof cls?.abi === 'string' || Array.isArray(cls?.sierra_program) ? 1 : 0,
    functions: fns.length,
    proxy,
    owner,
    upgrade: [...new Set(external.filter((n) => UPGRADE_RE.test(n)))].slice(0, 8),
    powers: scanFunctions(external.map((n) => ({ module: 'contract', name: n, callable: true }))),
    token,
  };
}

export function analyzeStarknet(m, ctx = {}) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  const known = ctx.known ?? null;
  const cap = (s) => (known && RANK[s] > RANK.low ? 'low' : s);
  const issuer = known ? { issuer: known.issuer } : {};

  if (m.kind === 'missing') add('sn-not-found', 'info');
  else {
    if (m.kind === 'token') {
      const t = m.token;
      add('sn-token', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.totalSupply });
      if ((t.name && LINK_RE.test(t.name)) || (t.symbol && LINK_RE.test(t.symbol))) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
      if (known) add('known-issuer', 'good', { symbol: known.symbol, issuer: known.issuer, kind: known.kind });
      if (ctx.lookalike) add('lookalike', 'high', { symbol: t.symbol, official: ctx.lookalike.address, issuer: ctx.lookalike.issuer });
    } else {
      add('sn-contract', 'info', { count: m.functions, cairo: m.cairo });
    }
    const renounced = m.owner === null;
    if (m.proxy || m.upgrade.length) {
      add('sn-upgradeable', cap(renounced && !m.proxy ? 'medium' : 'high'), { functions: m.upgrade, implementation: m.proxy?.implementation, ...issuer });
    }
    if (typeof m.owner === 'string') add('owner-active', 'info', { owner: m.owner });
    else if (renounced) add('owner-renounced', 'good');
    addPowerFindings(add, m.powers, (s) => cap(renounced && RANK[s] > RANK.low ? 'low' : s), issuer);
  }

  if (!findings.some((f) => RANK[f.severity] > 0 || f.severity === 'good')) add('nothing-found', 'info');
  add('sn-caveat', 'info');
  return { level: levelOf(findings), control: m.kind, findings };
}
