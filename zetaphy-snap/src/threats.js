// Transaction and signature insights (the vaccine for plain MetaMask): before the
// user confirms an EVM transaction, or signs EIP-712 typed data, on any EVM chain,
// the snap asks the ZETAPHY ThreatRegistry whether the addresses involved are
// flagged by the Neuro runners.
//
//   1. Addresses checked (and only these):
//      - a transaction: its `to`, plus the spender / operator / recipient the call
//        names: the FIRST argument of approve, increaseAllowance, setApprovalForAll
//        and transfer; the SECOND of transferFrom / safeTransferFrom (ERC-20, 721,
//        1155: the recipient) and of Permit2 approve(token, spender, …). Batches:
//        multicall(bytes[]) and multicall(deadline, bytes[]) are decoded (each inner
//        call read the same way), and so are Multicall3 aggregate / aggregate3 (their
//        inner call targets too). Other batch or execute forms (Safe execTransaction,
//        Universal Router execute, …) are NOT decoded: the insight says "inner calls
//        not checked". Any other address inside the call data is not checked either.
//      - typed data (eth_signTypedData_v3 / v4): the contract it is for
//        (domain.verifyingContract) and the message's spender (EIP-2612 Permit,
//        Permit2), operator, and zone plus consideration recipients (Seaport-style
//        orders), on domain.chainId. The signer's own address is never sent.
//   2. On that chain, through MetaMask's provider (endowment:ethereum-provider): each
//      address's code (eth_getCode), and where a proxy forwards to (EIP-1167,
//      EIP-1967 implementation and beacon: zetaphy-network/src/vaccine.js, the
//      wallet's code), up to PROXY_DEPTH hops. The snap NEVER switches the user's
//      network: if MetaMask's current chain is not the transaction's, the code
//      cannot be read and the insight says it could not check this chain.
//   3. One JSON-RPC batch to the ZETAPHY RPC (endowment:network-access), read only:
//      eth_chainId (must be ZETAPHY, 77390), then eth_call of the registry's warning
//      and enforcement views for each address: isAddressFlagged(chainId, address),
//      isCodeFlagged(keccak256(code)) and isFlagged(fp1(code)), and their is*Enforced.
//   4. Only if something is flagged, a second batch: evidenceOf(key) of each flag (its
//      reportHash and URI) and responseAt(key, 0..2) of each key of a flagged address
//      (the responses of the parties behind it, each with its author: the responder
//      governance assigned first, then the newest). Best effort: if it fails, the
//      warning stands and says the details could not be read.
//
// Privacy, plainly: the ZETAPHY RPC (whoever runs it) sees, BEFORE the user confirms,
// the addresses above, their chain id, code hashes and fp1 fingerprints, the time,
// and the user's IP address (as any HTTP request does). The user's own address,
// amounts and the raw call data are not sent, but once the transaction lands on its
// chain, the destination, chain and time can be matched to it and so linked to the
// user's account (and the IP to that account). Signatures the same way, if used.
//
// The registry and RPC are build-time constants (snap.config.js `environment`, with
// placeholders), overridable by the ZETAPHY wallet's origin only (zetaphy_setThreatSource,
// after the user approves), stored with snap_manageState (not encrypted: nothing secret).
// Every insight says when such a custom source is in use.
import { threatQueries, readThreat, proxyTargets, PROXY_DEPTH, threatKey, detailQueries, readEvidence, readResponse, selector } from '../../zetaphy-network/src/vaccine.js';

export const ZETAPHY_EVM_CHAIN_ID = 77390n;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_DESTINATIONS = 12; // named addresses, and what proxies forward to
const MAX_INNER = 16; // inner calls of a batch read
const RPC_TIMEOUT_MS = 8000;

/** Build-time defaults (snap.config.js). Placeholders until the owner sets real ones. */
export const DEFAULT_SOURCE = {
  rpc: process.env.ZETAPHY_THREAT_RPC,
  registry: process.env.ZETAPHY_THREAT_REGISTRY,
};
/** Origins allowed to read or change the threat source (the ZETAPHY web wallet). */
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

// ---- reading call data ----

// Calls naming an address the user's tokens go to (or may be taken by): [argument index, role].
const NAMED = Object.fromEntries([
  ['approve(address,uint256)', 0, 'spender'],
  ['increaseAllowance(address,uint256)', 0, 'spender'],
  ['setApprovalForAll(address,bool)', 0, 'operator'],
  ['transfer(address,uint256)', 0, 'recipient'],
  ['transferFrom(address,address,uint256)', 1, 'recipient'],
  ['safeTransferFrom(address,address,uint256)', 1, 'recipient'],
  ['safeTransferFrom(address,address,uint256,bytes)', 1, 'recipient'],
  ['safeTransferFrom(address,address,uint256,uint256,bytes)', 1, 'recipient'],
  ['safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', 1, 'recipient'],
  ['approve(address,address,uint160,uint48)', 1, 'spender'], // Permit2 AllowanceTransfer
].map(([sig, arg, role]) => [selector(sig), { arg, role }]));

// Batches decoded here: each inner call is read like a top-level one.
//   multicall(bytes[]) / multicall(uint256,bytes[]): inner calls to the same contract;
//   aggregate((address,bytes)[]) / aggregate3((address,bool,bytes)[]) (Multicall3): to their own targets.
const BATCH = {
  [selector('multicall(bytes[])')]: (h) => bytesArray(h, 0),
  [selector('multicall(uint256,bytes[])')]: (h) => bytesArray(h, 32),
  [selector('aggregate((address,bytes)[])')]: (h) => tupleCalls(h, 0, 1),
  [selector('aggregate3((address,bool,bytes)[])')]: (h) => tupleCalls(h, 0, 2),
};
// Batch or execute forms not decoded: their inner calls are said to be unchecked.
const OPAQUE = new Set(['execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
  'execute(bytes,bytes[])', 'execute(bytes,bytes[],uint256)', 'execute(address,uint256,bytes)', 'executeBatch(address[],uint256[],bytes[])',
  'executeBatch((address,uint256,bytes)[])', 'tryAggregate(bool,(address,bytes)[])', 'multicall((address,bytes)[])',
  'multiSend(bytes)', 'batch(bytes[],bool)'].map(selector));

// ABI reading over a hex string of call arguments (no selector), bounds-checked: null when malformed.
const uintAt = (h, at) => (at >= 0 && h.length >= 2 * at + 64 ? BigInt('0x' + h.slice(2 * at, 2 * at + 64)) : null);
function addrAt(h, at) {
  const w = at >= 0 && h.length >= 2 * at + 64 ? h.slice(2 * at, 2 * at + 64) : '';
  if (!/^0{24}[0-9a-f]{40}$/.test(w)) return null;
  const a = '0x' + w.slice(24);
  return a === ZERO ? null : a;
}
function bytesAt(h, at) {
  const len = uintAt(h, at);
  if (len === null || len > BigInt(h.length)) return null;
  const n = Number(len);
  return h.length >= 2 * (at + 32) + 2 * n ? h.slice(2 * (at + 32), 2 * (at + 32) + 2 * n) : null;
}
/** Offsets of a dynamic array's elements: [start of the array's data, element offsets]. */
function arrayAt(h, headAt) {
  const off = uintAt(h, headAt);
  if (off === null || off > BigInt(h.length)) return null;
  const n = uintAt(h, Number(off));
  if (n === null || n > BigInt(MAX_INNER)) return null;
  const base = Number(off) + 32;
  const out = [];
  for (let i = 0; i < Number(n); i++) {
    const e = uintAt(h, base + 32 * i);
    if (e === null || e > BigInt(h.length)) return null;
    out.push(base + Number(e));
  }
  return out;
}
function bytesArray(h, headAt) {
  const els = arrayAt(h, headAt);
  if (!els) return null;
  const calls = els.map((at) => bytesAt(h, at));
  return calls.some((c) => c === null) ? null : calls.map((data) => ({ target: null, data }));
}
function tupleCalls(h, headAt, bytesField) {
  const els = arrayAt(h, headAt);
  if (!els) return null;
  const calls = [];
  for (const at of els) {
    const target = addrAt(h, at);
    const off = uintAt(h, at + 32 * bytesField);
    const data = off === null || off > BigInt(h.length) ? null : bytesAt(h, at + Number(off));
    if (!target || data === null) return null;
    calls.push({ target, data });
  }
  return calls;
}

/**
 * What a transaction's call names: { destinations: [{ address, role }], innerUnchecked }
 * (role: to, spender, operator, recipient, inner). innerUnchecked: a batch or execute
 * form whose inner calls were not read.
 */
export function analyzeCall(tx) {
  const destinations = [];
  let innerUnchecked = false;
  const add = (address, role) => { if (address && address !== ZERO && !destinations.some((d) => d.address === address)) destinations.push({ address, role }); };
  if (typeof tx?.to === 'string' && ADDR_RE.test(tx.to)) add(tx.to.toLowerCase(), 'to');
  const data = typeof tx?.data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data) ? tx.data.slice(2).toLowerCase() : '';
  const scan = (d, depth) => {
    if (d.length < 8) return;
    const sel = d.slice(0, 8);
    const args = d.slice(8);
    if (NAMED[sel]) { add(addrAt(args, 32 * NAMED[sel].arg), NAMED[sel].role); return; }
    if (BATCH[sel]) {
      const calls = depth < 2 ? BATCH[sel](args) : null;
      if (!calls) { innerUnchecked = true; return; }
      for (const c of calls) { if (c.target) add(c.target, 'inner'); scan(c.data, depth + 1); }
      return;
    }
    if (OPAQUE.has(sel)) innerUnchecked = true;
  };
  scan(data, 0);
  return { destinations, innerUnchecked };
}

/** The destinations of a transaction: [{ address, role }]. */
export const destinations = (tx) => analyzeCall(tx).destinations;

/** CAIP-2 "eip155:<n>" → n (BigInt), else null. */
export function evmChainId(caip) {
  const m = /^eip155:([0-9]{1,20})$/.exec(String(caip ?? ''));
  return m ? BigInt(m[1]) : null;
}

// ---- typed data (signature insight) ----

const lower = (a) => (typeof a === 'string' && ADDR_RE.test(a) ? a.toLowerCase() : null);
function chainOf(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return BigInt(v);
  if (typeof v === 'string' && /^(?:0x[0-9a-fA-F]{1,16}|[0-9]{1,20})$/.test(v)) return BigInt(v);
  return null;
}

/**
 * What EIP-712 typed data authorises: { chainId (BigInt | null), destinations: [{ address, role }] }
 * (role: verifying, spender, operator, zone, recipient), or null for a signature that is not
 * typed data (personal_sign, eth_signTypedData v1) or unreadable. The signer's own address
 * (and the order's offerer) is never listed, so it is never sent.
 */
export function typedDataTargets(signature) {
  if (!signature || !['eth_signTypedData_v3', 'eth_signTypedData_v4'].includes(signature.signatureMethod)) return null;
  let td = signature.data;
  if (typeof td === 'string') { try { td = JSON.parse(td); } catch { return null; } }
  if (!td || typeof td !== 'object' || Array.isArray(td)) return null;
  const msg = td.message && typeof td.message === 'object' ? td.message : {};
  const own = new Set([lower(signature.from), lower(msg.offerer), lower(msg.owner), lower(msg.holder)].filter(Boolean));
  const destinations = [];
  const add = (a, role) => { const x = lower(a); if (x && x !== ZERO && !own.has(x) && !destinations.some((d) => d.address === x)) destinations.push({ address: x, role }); };
  add(td.domain?.verifyingContract, 'verifying');
  add(msg.spender, 'spender'); // EIP-2612 / DAI Permit, Permit2 (PermitSingle, PermitBatch, PermitTransferFrom, …)
  add(msg.operator, 'operator');
  add(msg.zone, 'zone'); // Seaport-style orders
  if (Array.isArray(msg.consideration)) for (const c of msg.consideration.slice(0, MAX_INNER)) add(c?.recipient, 'recipient');
  return { chainId: chainOf(td.domain?.chainId), destinations };
}

// ---- the check ----

/** JSON-RPC on the given chain through MetaMask, only if MetaMask is on it (never switches). */
async function chainCaller(chainId) {
  const cur = BigInt(await ethereum.request({ method: 'eth_chainId' }));
  if (cur !== chainId) {
    throw Object.assign(new Error(`couldn't check this chain: MetaMask's current network is eip155:${cur}, this is eip155:${chainId} (the snap never switches networks), so the code was not read; only the addresses were looked up`), { chainMismatch: true });
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

/** Adds { evidence, responses, detailsError } to each finding (one more batch to the registry). */
async function explain(source, findings, asked, id) {
  const keysOf = (address) => asked.filter(({ t }) => t.address === address).map(({ t, q }) => threatKey(q.what, id, t.address, t.code));
  const evKeys = [...new Set(findings.map((f) => f.key))];
  const rsKeys = [...new Set(findings.flatMap((f) => keysOf(f.address)))];
  const rsData = rsKeys.flatMap((k) => detailQueries(k).responses);
  const perKey = rsData.length / Math.max(rsKeys.length, 1);
  let answers;
  try {
    answers = await zetaphyCalls(source, [...evKeys.map((k) => detailQueries(k).evidence), ...rsData]);
  } catch {
    for (const f of findings) f.detailsError = true;
    return;
  }
  const read = (fn, hex) => { try { return fn(hex); } catch { return null; } };
  const evidence = new Map(evKeys.map((k, i) => [k, read(readEvidence, answers[i])]));
  const responses = new Map(rsKeys.map((k, i) => [k, answers.slice(evKeys.length + i * perKey, evKeys.length + (i + 1) * perKey)
    .map((h) => read(readResponse, h)).filter((r) => r?.text)]));
  for (const f of findings) {
    f.evidence = evidence.get(f.key);
    if (f.evidence === null) f.detailsError = true;
    // The flagged key's responses first, then the other keys' of the same address; each author once.
    const seen = new Set();
    f.responses = [f.key, ...keysOf(f.address)].flatMap((k) => responses.get(k) ?? [])
      .filter((r) => (seen.has(r.by) ? false : seen.add(r.by)))
      .sort((a, b) => Number(b.assigned) - Number(a.assigned)).slice(0, 3);
  }
}

/**
 * Checks addresses on chain `id`. Returns { state, findings, checked, innerUnchecked?, capped?, error? }:
 *   state 'enforced' (an enforced flag), 'warned' (flagged, not enforced yet),
 *   'clean' (checked, nothing flagged), 'unchecked' (the check failed: error),
 *   'none' (nothing to check, e.g. a contract creation).
 * checked: [{ address, role, behind }] what was looked up.
 * findings: [{ address, role, behind?, what, reason, enforced, key, evidence?, responses?, detailsError? }].
 * A flag found is reported even if another part of the check failed.
 */
export async function checkAddresses({ id, first, innerUnchecked = false }, source) {
  const notes = { ...(innerUnchecked ? { innerUnchecked: true } : {}) };
  if (!first.length) return { state: 'none', findings: [], checked: [], ...notes };
  if (id === null) return { state: 'unchecked', findings: [], checked: [], ...notes, error: 'not an EVM chain (no chain id)' };
  if (!validRpc(source?.rpc) || !validRegistry(source?.registry)) return { state: 'unchecked', findings: [], checked: [], ...notes, error: 'no ThreatRegistry configured' };

  // 1. Code and proxies on that chain. A failure here still lets the addresses be checked.
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
  if (queue.some((d) => !seen.has(d.address))) notes.capped = true;
  const checked = targets.map(({ address, role, behind }) => ({ address, role, behind }));

  // 2. The registry, in one batch.
  const asked = targets.flatMap((t) => threatQueries(id, t.address, t.code).map((q) => ({ t, q })));
  let answers;
  try {
    answers = await zetaphyCalls(source, asked.flatMap(({ q }) => [q.warn, q.enforced]));
  } catch (e) {
    return { state: 'unchecked', findings: [], checked, ...notes, error: e?.message ?? String(e) };
  }
  const findings = [];
  try {
    asked.forEach(({ t, q }, i) => {
      const r = readThreat(answers[2 * i], answers[2 * i + 1]);
      if (r.flagged) findings.push({ address: t.address, role: t.role, behind: t.behind, what: q.what, reason: r.reason, enforced: r.enforced, key: threatKey(q.what, id, t.address, t.code) });
    });
  } catch (e) {
    return { state: 'unchecked', findings, checked, ...notes, error: 'no ThreatRegistry at that address' };
  }
  if (findings.length) await explain(source, findings, asked, id);
  const codeMsg = codeError?.chainMismatch ? codeError.message : 'could not read the destination\'s code on its chain';
  if (findings.some((f) => f.enforced)) return { state: 'enforced', findings, checked, ...notes };
  if (findings.length) return { state: 'warned', findings, checked, ...notes, ...(codeError ? { error: codeError.chainMismatch ? codeMsg : 'code not read' } : {}) };
  if (codeError) return { state: 'unchecked', findings, checked, ...notes, error: codeMsg };
  return { state: 'clean', findings, checked, ...notes };
}

/** Checks a transaction (see checkAddresses). */
export async function checkTransaction({ transaction, chainId }, source) {
  const { destinations: first, innerUnchecked } = analyzeCall(transaction);
  if (!first.length) return { state: 'none', findings: [], checked: [] };
  return checkAddresses({ id: evmChainId(chainId), first, innerUnchecked }, source);
}

/** Checks EIP-712 typed data (see checkAddresses); null: not typed data, nothing to say. */
export async function checkSignature({ signature }, source) {
  const t = typedDataTargets(signature);
  if (!t) return null;
  if (!t.destinations.length) return { state: 'none', findings: [], checked: [] };
  if (t.chainId === null) return { state: 'unchecked', findings: [], checked: [], error: 'the typed data names no chain (domain.chainId)' };
  return checkAddresses({ id: t.chainId, first: t.destinations }, source);
}
