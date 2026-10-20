// Neuro tier 1 for NEAR (contracts in Rust or JS, compiled to WASM).
// Read-only: only the JSON-RPC methods `status` and `query` (view_account,
// view_access_key_list, view_code, call_function on view methods).
//
// What decides a NEAR contract's risk:
//   full-access keys  a NEAR account can hold keys that may do anything,
//                     including deploying new code over the contract. A
//                     token whose account still has one can change at will.
//   exported methods  every public method of the WASM code is exported by
//                     name, so the code itself says whether it has `mint`,
//                     `pause`, `upgrade`, ...
//   NEP-141           the fungible-token standard: ft_metadata, ft_total_supply

import { cleanText } from './abi.js';
import { RANK, LINK_RE, levelOf, scanFunctions, addPowerFindings } from './move.js';

// NEAR account IDs (nomicon): lowercase parts joined by "." with "-"/"_"
// inside; 64-hex implicit accounts; 0x + 40 hex ETH-implicit accounts.
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function isNearAccount(s) {
  return typeof s === 'string' && s.length >= 2 && s.length <= 64 && (ACCOUNT_RE.test(s) || /^0x[0-9a-f]{40}$/.test(s));
}

const NO_CODE = '11111111111111111111111111111111';
// Methods that replace the contract's code. `upgrade_name_symbol` or
// `upgrade_icon` (USDt on NEAR) only change metadata, so whole names only.
const UPGRADE_RE = /^(upgrade|upgrade_contract|upgrade_code|upgrade_self|update_contract|deploy_code|deploy_contract|set_code|migrate|stage_code|deploy_staged|deploy_upgrade)$/;

// ------------------------------------------------------------------ WASM
function leb(bytes, o) {
  let v = 0; let shift = 0; let b;
  do {
    if (o >= bytes.length) throw new Error('bad wasm');
    b = bytes[o++];
    v += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80 && shift < 35);
  return [v, o];
}

/** Names of the functions a WASM module exports. Throws on non-WASM bytes. */
export function wasmExports(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error('not wasm');
  let o = 8;
  while (o < bytes.length) {
    const id = bytes[o++];
    let size;
    [size, o] = leb(bytes, o);
    const end = o + size;
    if (end > bytes.length) throw new Error('bad wasm');
    if (id === 7) {
      const names = [];
      let n;
      [n, o] = leb(bytes, o);
      for (let i = 0; i < n && o < end; i++) {
        let len;
        [len, o] = leb(bytes, o);
        const name = new TextDecoder().decode(bytes.subarray(o, o + len));
        o += len;
        const kind = bytes[o++];
        [, o] = leb(bytes, o);
        if (kind === 0) names.push(name);
      }
      return names;
    }
    o = end;
  }
  return [];
}

// ---------------------------------------------------------------- reader
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const missing = (e) => /UNKNOWN_ACCOUNT|does not exist|UnknownAccount/i.test(e?.message ?? '');

/** `rpc.call(method, params)` with params as an object (NEAR style). */
export async function readNearAccount(rpc, accountId) {
  const q = (params) => rpc.call('query', { finality: 'final', ...params, account_id: accountId });
  let acc;
  try { acc = await q({ request_type: 'view_account' }); } catch (e) {
    if (missing(e)) return { kind: 'missing' };
    throw e;
  }
  if (!acc || acc.error) return { kind: 'missing' };
  if (!acc.code_hash || acc.code_hash === NO_CODE) return { kind: 'account' };

  let keys = [];
  try { keys = (await q({ request_type: 'view_access_key_list' }))?.keys ?? []; } catch { keys = []; }
  const fullAccess = keys.filter((k) => k?.access_key?.permission === 'FullAccess').length;

  let methods = [];
  try {
    const code = await q({ request_type: 'view_code' });
    methods = wasmExports(b64ToBytes(code.code_base64))
      .filter((n) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(n))
      .slice(0, 500);
  } catch { methods = []; }

  // NEP-141 token? A non-token answers with an error (method not found).
  const view = async (method) => {
    try {
      const r = await q({ request_type: 'call_function', method_name: method, args_base64: btoa('{}') });
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
    } catch { return null; }
  };
  const meta = methods.length === 0 || methods.includes('ft_metadata') ? await view('ft_metadata') : null;
  const isToken = !!(meta && typeof meta.symbol === 'string');
  const supply = isToken ? await view('ft_total_supply') : null;
  const dec = Number(meta?.decimals);

  const lower = methods.map((m) => m.toLowerCase());
  return {
    kind: isToken ? 'token' : 'contract',
    account: accountId,
    codeHash: acc.code_hash,
    fullAccess,
    methods: methods.length,
    upgradeMethods: lower.filter((m) => UPGRADE_RE.test(m)).slice(0, 8),
    // WASM does not mark view methods; getters by name are not powers.
    powers: scanFunctions(lower.filter((m) => !/^(get|is|view|has)_/.test(m)).map((m) => ({ module: 'contract', name: m, callable: true }))),
    token: isToken ? {
      name: cleanText(meta.name) ?? undefined,
      symbol: cleanText(meta.symbol, 24) ?? undefined,
      decimals: Number.isInteger(dec) && dec >= 0 && dec <= 36 ? dec : undefined,
      supply: typeof supply === 'string' && /^\d+$/.test(supply) ? supply : undefined,
    } : undefined,
  };
}

export function analyzeNear(m, ctx = {}) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  const known = ctx.known ?? null;
  const cap = (s) => (known && RANK[s] > RANK.low ? 'low' : s);
  const issuer = known ? { issuer: known.issuer } : {};

  if (m.kind === 'missing') add('near-not-found', 'info');
  else if (m.kind === 'account') add('near-no-contract', 'info');
  else {
    if (m.kind === 'token') {
      const t = m.token;
      add('near-token', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.supply });
      if ((t.name && LINK_RE.test(t.name)) || (t.symbol && LINK_RE.test(t.symbol))) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
      if (known) add('known-issuer', 'good', { symbol: known.symbol, issuer: known.issuer, kind: known.kind });
      if (ctx.lookalike) add('lookalike', 'high', { symbol: t.symbol, official: ctx.lookalike.address, issuer: ctx.lookalike.issuer });
    } else {
      add('near-contract', 'info', { count: m.methods });
    }
    if (m.fullAccess > 0) add('near-full-access', cap('high'), { count: m.fullAccess, ...issuer });
    else add('near-locked', 'good');
    if (m.upgradeMethods.length) add('near-upgrade-method', cap(m.fullAccess > 0 ? 'medium' : 'high'), { functions: m.upgradeMethods, ...issuer });
    addPowerFindings(add, m.powers, cap, issuer);
  }

  if (!findings.some((f) => RANK[f.severity] > 0 || f.severity === 'good')) add('nothing-found', 'info');
  add('near-caveat', 'info');
  return { level: levelOf(findings), control: m.kind, findings };
}
