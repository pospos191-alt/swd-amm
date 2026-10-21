// Transaction insight (the vaccine for plain MetaMask): before the user confirms
// any EVM transaction, on any EVM chain, the snap asks the ZETAPHY ThreatRegistry
// whether the destination is flagged by the Neuro runners.
//
//   1. Destinations: the transaction's `to`, plus the spender / recipient an ERC-20
//      or NFT call names (approve, increaseAllowance, setApprovalForAll, transfer).
//   2. On the transaction's own chain (endowment:ethereum-provider): each
//      destination's code (eth_getCode), and where a proxy forwards to (EIP-1167,
//      EIP-1967 implementation and beacon: zetaphy-network/src/vaccine.js, the
//      wallet's code), up to PROXY_DEPTH hops.
//   3. One JSON-RPC batch to the ZETAPHY RPC (endowment:network-access), read only:
//      eth_chainId (must be ZETAPHY, 77390), then eth_call of the registry's warning
//      and enforcement views for each destination: isAddressFlagged(chainId, address),
//      isCodeFlagged(keccak256(code)) and isFlagged(fp1(code)), and their is*Enforced.
//      What leaves the browser: destination addresses, their chain id, code hashes and
//      fp1 fingerprints. Nothing about the user's account, amounts or call data.
//   4. Only if something is flagged, a second batch: evidenceOf(key) of each flag (its
//      reportHash and URI) and responseOf(key) of each key of a flagged destination
//      (the owner's right of reply), shown next to the warning. Best effort: if it
//      fails, the warning stands and says the details could not be read.
//
// The registry and RPC are build-time constants (snap.config.js `environment`, with
// placeholders), overridable by the ZETAPHY wallet's origin only (zetaphy_setThreatSource),
// stored with snap_manageState (not encrypted: nothing secret).
import { threatQueries, readThreat, proxyTargets, PROXY_DEPTH, threatKey, detailQueries, readEvidence, readResponse } from '../../zetaphy-network/src/vaccine.js';

export const ZETAPHY_EVM_CHAIN_ID = 77390n;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_DESTINATIONS = 8; // to + named spender, and what proxies forward to
const RPC_TIMEOUT_MS = 8000;

/** Build-time defaults (snap.config.js). Placeholders until the owner sets real ones. */
export const DEFAULT_SOURCE = {
  rpc: process.env.ZETAPHY_THREAT_RPC,
  registry: process.env.ZETAPHY_THREAT_REGISTRY,
};
/** Origins allowed to change the threat source (the ZETAPHY web wallet). */
export const WALLET_ORIGINS = String(process.env.ZETAPHY_WALLET_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** An RPC URL the snap may call: https, or http only on this machine (development). */
export function validRpc(url) {
  if (typeof url !== 'string' || url.length > 256) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
}
export const validRegistry = (a) => typeof a === 'string' && ADDR_RE.test(a) && a.toLowerCase() !== ZERO;

/** The source in use: the wallet's override if any, else the build-time one. */
export async function threatSource() {
  let state = null;
  try { state = await snap.request({ method: 'snap_manageState', params: { operation: 'get', encrypted: false } }); } catch { /* none: the built-in source */ }
  const o = state?.threatSource;
  if (o && validRpc(o.rpc) && validRegistry(o.registry)) return { rpc: o.rpc, registry: o.registry, overridden: true };
  return { ...DEFAULT_SOURCE, overridden: false };
}

export async function setThreatSource(source) {
  const state = (await snap.request({ method: 'snap_manageState', params: { operation: 'get', encrypted: false } })) ?? {};
  const next = { ...state };
  if (source) next.threatSource = { rpc: source.rpc, registry: source.registry };
  else delete next.threatSource;
  await snap.request({ method: 'snap_manageState', params: { operation: 'update', newState: next, encrypted: false } });
}

/** zetaphy_setThreatSource params: { rpc, registry } or { reset: true }. */
export function parseThreatSource(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be { rpc, registry } or { reset: true }');
  const keys = Object.keys(params);
  if (keys.length === 1 && params.reset === true) return null;
  if (keys.length !== 2 || !keys.includes('rpc') || !keys.includes('registry')) throw new Error('params must be { rpc, registry } or { reset: true }');
  if (!validRpc(params.rpc)) throw new Error('rpc: an https:// URL (http:// only for localhost), at most 256 characters, no credentials');
  if (!validRegistry(params.registry)) throw new Error('registry: the ThreatRegistry 0x address (40 hex digits, not zero)');
  return { rpc: params.rpc, registry: params.registry };
}

// Calls whose first argument is an address the user's tokens go to (or may be taken by).
const NAMED = {
  '095ea7b3': 'spender', // approve(address,uint256)
  '39509351': 'spender', // increaseAllowance(address,uint256)
  a22cb465: 'operator', // setApprovalForAll(address,bool)
  a9059cbb: 'recipient', // transfer(address,uint256)
};

/** The destinations of a transaction: [{ address, role }] (role: to, spender, operator, recipient). */
export function destinations(tx) {
  const out = [];
  if (typeof tx?.to === 'string' && ADDR_RE.test(tx.to)) out.push({ address: tx.to.toLowerCase(), role: 'to' });
  const data = typeof tx?.data === 'string' ? tx.data.toLowerCase() : '';
  const role = NAMED[data.slice(2, 10)];
  if (role && /^0x[0-9a-f]{8}0{24}[0-9a-f]{40}/.test(data)) {
    const a = '0x' + data.slice(34, 74);
    if (a !== ZERO && !out.some((d) => d.address === a)) out.push({ address: a, role });
  }
  return out;
}

/** CAIP-2 "eip155:<n>" → n (BigInt), else null. */
export function evmChainId(caip) {
  const m = /^eip155:([0-9]{1,20})$/.exec(String(caip ?? ''));
  return m ? BigInt(m[1]) : null;
}

/** JSON-RPC on the transaction's chain, through MetaMask (endowment:ethereum-provider). */
async function chainCaller(chainId) {
  const cur = await ethereum.request({ method: 'eth_chainId' });
  if (BigInt(cur) !== chainId) {
    await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + chainId.toString(16) }] });
    if (BigInt(await ethereum.request({ method: 'eth_chainId' })) !== chainId) throw new Error('could not reach that chain');
  }
  return (method, params) => ethereum.request({ method, params });
}

/** One JSON-RPC batch to the ZETAPHY RPC: eth_chainId, then each eth_call to the registry. */
async function zetaphyCalls(source, datas) {
  const body = [{ jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] },
    ...datas.map((data, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [{ to: source.registry, data }, 'latest'] }))];
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), RPC_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(source.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(ctl ? { signal: ctl.signal } : {}) });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`ZETAPHY RPC HTTP ${res.status}`);
  const answers = await res.json();
  if (!Array.isArray(answers)) throw new Error('ZETAPHY RPC: not a batch answer');
  const byId = new Map(answers.map((a) => [a?.id, a]));
  const result = (id) => {
    const a = byId.get(id);
    if (!a || a.error || typeof a.result !== 'string') throw new Error('ZETAPHY RPC: a call failed');
    return a.result;
  };
  if (BigInt(result(0)) !== ZETAPHY_EVM_CHAIN_ID) throw new Error('that RPC is not ZETAPHY');
  return datas.map((_, i) => result(i + 1));
}

/** Adds { evidence, response, detailsError } to each finding (one more batch to the registry). */
async function explain(source, findings, asked, id) {
  const keysOf = (address) => asked.filter(({ t }) => t.address === address).map(({ t, q }) => threatKey(q.what, id, t.address, t.code));
  const evKeys = [...new Set(findings.map((f) => f.key))];
  const rsKeys = [...new Set(findings.flatMap((f) => keysOf(f.address)))];
  let answers;
  try {
    answers = await zetaphyCalls(source, [...evKeys.map((k) => detailQueries(k).evidence), ...rsKeys.map((k) => detailQueries(k).response)]);
  } catch {
    for (const f of findings) f.detailsError = true;
    return;
  }
  const read = (fn, hex) => { try { return fn(hex); } catch { return null; } };
  const evidence = new Map(evKeys.map((k, i) => [k, read(readEvidence, answers[i])]));
  const responses = new Map(rsKeys.map((k, i) => [k, read(readResponse, answers[evKeys.length + i])]));
  for (const f of findings) {
    f.evidence = evidence.get(f.key);
    if (f.evidence === null) f.detailsError = true;
    // The flagged key's response first, else any other key of the same destination's.
    f.response = [f.key, ...keysOf(f.address)].map((k) => responses.get(k)).find((r) => r?.text) ?? null;
  }
}

/**
 * Checks a transaction. Returns { state, findings, error? }:
 *   state 'enforced' (an enforced flag), 'warned' (flagged, not enforced yet),
 *   'clean' (checked, nothing flagged), 'unchecked' (the check failed: error),
 *   'none' (no destination: a contract creation).
 * findings: [{ address, role, behind?, what, reason, enforced, key, evidence?, response?, detailsError? }].
 * A flag found is reported even if another part of the check failed.
 */
export async function checkTransaction({ transaction, chainId }, source) {
  const id = evmChainId(chainId);
  const first = destinations(transaction);
  if (!first.length) return { state: 'none', findings: [] };
  if (id === null) return { state: 'unchecked', findings: [], error: 'not an EVM chain' };
  if (!validRpc(source?.rpc) || !validRegistry(source?.registry)) return { state: 'unchecked', findings: [], error: 'no ThreatRegistry configured' };

  // 1. Code and proxies on the transaction's chain. A failure here still lets the addresses be checked.
  const targets = []; // { address, role, behind, code }
  let codeError = null;
  let call = null;
  try { call = await chainCaller(id); } catch (e) { codeError = e; }
  const queue = first.map((d) => ({ ...d, behind: null, depth: 0 }));
  const seen = new Set();
  while (queue.length && targets.length < MAX_DESTINATIONS) {
    const d = queue.shift();
    if (seen.has(d.address)) continue;
    seen.add(d.address);
    let code = null;
    if (call) {
      try {
        code = await call('eth_getCode', [d.address, 'latest']);
        if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new Error('bad code');
      } catch (e) { codeError = e; code = null; }
    }
    targets.push({ address: d.address, role: d.role, behind: d.behind, code });
    if (code && code.length > 2 && d.depth < PROXY_DEPTH) {
      try {
        for (const next of await proxyTargets(call, d.address, code)) queue.push({ address: next, role: d.role, behind: d.address, depth: d.depth + 1 });
      } catch (e) { codeError = e; }
    }
  }

  // 2. The registry, in one batch.
  const asked = targets.flatMap((t) => threatQueries(id, t.address, t.code).map((q) => ({ t, q })));
  let answers;
  try {
    answers = await zetaphyCalls(source, asked.flatMap(({ q }) => [q.warn, q.enforced]));
  } catch (e) {
    return { state: 'unchecked', findings: [], error: e?.message ?? String(e) };
  }
  const findings = [];
  try {
    asked.forEach(({ t, q }, i) => {
      const r = readThreat(answers[2 * i], answers[2 * i + 1]);
      if (r.flagged) findings.push({ address: t.address, role: t.role, behind: t.behind, what: q.what, reason: r.reason, enforced: r.enforced, key: threatKey(q.what, id, t.address, t.code) });
    });
  } catch (e) {
    return { state: 'unchecked', findings, error: 'no ThreatRegistry at that address' };
  }
  if (findings.length) await explain(source, findings, asked, id);
  if (findings.some((f) => f.enforced)) return { state: 'enforced', findings };
  if (findings.length) return { state: 'warned', findings, ...(codeError ? { error: 'code not read' } : {}) };
  if (codeError) return { state: 'unchecked', findings, error: 'could not read the destination\'s code on its chain' };
  return { state: 'clean', findings };
}
