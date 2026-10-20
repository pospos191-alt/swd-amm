// Neuro tier 1 for CosmWasm chains (Osmosis, Neutron): contracts written in
// Rust and compiled to WASM, plus Token Factory coins. Read-only: only GET
// requests to the chain's public REST (LCD) API.
//
// What decides a CosmWasm contract's risk is on chain, not in its source:
//   admin       may "migrate" the contract to brand-new code at any time
//   history     how many times the code was already replaced
//   CW20 minter who may mint the token, and up to what cap
// A Token Factory coin (factory/<creator>/<name>) has one admin who can
// mint more, and may attach a "before send" contract that every transfer
// must pass (it can block selling).

import { bech32Decode } from './bech32.js';
import { cleanText } from './abi.js';
import { RANK, LINK_RE, levelOf } from './move.js';

const FACTORY_RE = /^factory\/([a-z0-9]+)\/([A-Za-z0-9._/-]{1,44})$/;
// The denom goes into a URL path as is: no "." or ".." segments, no empty ones.
const safeSub = (sub) => !sub.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');

/** Is `s` a contract address (bech32 with this prefix) or a factory denom? */
export function isCosmwasmInput(s, prefix) {
  if (typeof s !== 'string') return false;
  const f = s.match(FACTORY_RE);
  if (f && !safeSub(f[2])) return false;
  try {
    const { hrp, bytes } = bech32Decode(f ? f[1] : s);
    return hrp === prefix && (bytes.length === 20 || bytes.length === 32);
  } catch {
    return false;
  }
}

const b64 = (o) => btoa(JSON.stringify(o));
const smartPath = (addr, q) => `/cosmwasm/wasm/v1/contract/${addr}/smart/${encodeURIComponent(b64(q))}`;

/** `api.get(path)` returns JSON, null on 404, throws on other errors. */
export async function readCosmwasmAccount(api, input) {
  const f = input.match(FACTORY_RE);
  if (f && !safeSub(f[2])) throw new Error('invalid address');
  return f ? readFactoryDenom(api, input, f[1]) : readContractInfo(api, input);
}

async function readContractInfo(api, addr) {
  let info;
  try { info = await api.get(`/cosmwasm/wasm/v1/contract/${addr}`); } catch { info = null; }
  const ci = info?.contract_info;
  if (!ci) return { kind: 'missing' };

  let migrations = 0;
  try {
    const h = await api.get(`/cosmwasm/wasm/v1/contract/${addr}/history?pagination.limit=100`);
    migrations = (h?.entries ?? []).filter((e) => e.operation === 'CONTRACT_CODE_HISTORY_OPERATION_TYPE_MIGRATE' || e.operation === 2).length;
  } catch { /* history is optional */ }

  // CW20? A contract that does not speak CW20 answers these with an error.
  const smart = async (q) => {
    try { return (await api.get(smartPath(addr, q)))?.data ?? null; } catch { return null; }
  };
  const tokenInfo = await smart({ token_info: {} });
  const isCw20 = !!(tokenInfo && typeof tokenInfo.symbol === 'string');
  const minter = isCw20 ? await smart({ minter: {} }) : null;
  const dec = Number(tokenInfo?.decimals);

  return {
    kind: isCw20 ? 'cw20' : 'contract',
    address: addr,
    codeId: String(ci.code_id ?? ''),
    label: cleanText(ci.label ?? '') || undefined,
    creator: ci.creator || null,
    admin: ci.admin || null,
    migrations,
    token: isCw20 ? {
      name: cleanText(tokenInfo.name) ?? undefined,
      symbol: cleanText(tokenInfo.symbol, 24) ?? undefined,
      decimals: Number.isInteger(dec) && dec >= 0 && dec <= 36 ? dec : undefined,
      supply: tokenInfo.total_supply != null ? String(tokenInfo.total_supply) : undefined,
    } : undefined,
    minter: minter?.minter ?? null,
    cap: minter?.cap ?? null,
  };
}

async function readFactoryDenom(api, denom, creator) {
  // Paths as osmojs builds them: the denom goes in raw, slashes and all.
  let auth;
  try { auth = await api.get(`/osmosis/tokenfactory/v1beta1/denoms/${denom}/authority_metadata`); } catch { auth = null; }
  if (!auth?.authority_metadata) return { kind: 'missing' };
  const q = encodeURIComponent(denom);
  const optional = async (path) => { try { return await api.get(path); } catch { return null; } };
  const [hook, supply, meta] = await Promise.all([
    optional(`/osmosis/tokenfactory/v1beta1/denoms/${denom}/before_send_hook`),
    optional(`/cosmos/bank/v1beta1/supply/by_denom?denom=${q}`),
    optional(`/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=${q}`),
  ]);
  const m = meta?.metadata ?? {};
  // Many factory coins set name/symbol/display to the raw denom: show the
  // subdenom instead of a 100-character string.
  const sub = denom.split('/').slice(2).join('/');
  const plain = (v) => (v && !String(v).startsWith('factory/') ? v : '');
  const exps = (m.denom_units ?? []).map((u) => Number(u.exponent)).filter(Number.isInteger);
  const decimals = exps.length ? Math.max(...exps) : 0;
  return {
    kind: 'factory',
    address: denom,
    creator,
    token: {
      name: cleanText(plain(m.name) || sub) ?? undefined,
      symbol: cleanText(plain(m.symbol) || plain(m.display) || '', 24) || undefined,
      decimals: decimals >= 0 && decimals <= 36 ? decimals : 0,
      supply: supply?.amount?.amount ?? undefined,
    },
    admin: auth.authority_metadata.admin || null,
    hook: hook?.cosmwasm_address || null,
  };
}

export function analyzeCosmwasm(m) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  const t = m.token ?? {};
  const linky = () => {
    if ((t.name && LINK_RE.test(t.name)) || (t.symbol && LINK_RE.test(t.symbol))) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
  };

  if (m.kind === 'missing') {
    add('cw-not-found', 'info');
  } else if (m.kind === 'factory') {
    add('tf-token', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.supply, creator: m.creator });
    linky();
    if (m.admin) add('tf-admin', 'high', { admin: m.admin });
    else add('tf-no-admin', 'good');
    if (m.hook) add('tf-hook', 'high', { contract: m.hook });
  } else {
    if (m.kind === 'cw20') {
      add('cw20-token', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.supply });
      linky();
    } else {
      add('cw-contract', 'info', { label: m.label, codeId: m.codeId });
    }
    if (m.admin) add('cw-admin', 'high', { admin: m.admin });
    else add('cw-no-admin', 'good');
    if (m.migrations) add('cw-migrated', 'info', { count: m.migrations });
    if (m.kind === 'cw20') {
      if (m.minter) add('cw20-minter', 'high', { minter: m.minter, cap: m.cap, decimals: t.decimals });
      else add('cw20-no-minter', 'good');
    }
  }

  if (!findings.some((f) => RANK[f.severity] > 0 || f.severity === 'good')) add('nothing-found', 'info');
  add('cw-caveat', 'info');
  return { level: levelOf(findings), control: m.kind, findings };
}
