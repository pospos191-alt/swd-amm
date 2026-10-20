// Neuro tier 1 for Aptos (Move). Read-only: GET requests plus POST /view,
// which runs a #[view] function and cannot change state.
//
// Aptos has two token standards:
//   Coin            `0xADDR::module::Name`, powers are MintCapability,
//                   FreezeCapability and BurnCapability values
//   Fungible Asset  a metadata object at an address, powers are MintRef,
//                   TransferRef (freeze any holder, move tokens without
//                   permission) and BurnRef (burn from any holder)
// Wherever the creator stores these, the struct that holds them is declared
// in the creator's published code, and the code's ABI lists every struct's
// fields. So reading the ABI tells us which powers the package keeps.

import { cleanText } from './abi.js';
import {
  longAddress, shortAddress, parseMoveType, scanFunctions, addPowerFindings, levelOf,
  MOVE_ADDR_RE, MOVE_TYPE_RE, RANK, LINK_RE,
} from './move.js';

export const APTOS_MAINNET = 1;

const enc = encodeURIComponent;
const isFramework = (a) => BigInt(a) < 16n;

/** Is `s` an Aptos coin type or object/account address? */
export function isAptosInput(s) {
  return typeof s === 'string' && (MOVE_TYPE_RE.test(s) || MOVE_ADDR_RE.test(s));
}

const POWER_TYPES = [
  ['mint', /0x0*1::(fungible_asset::MintRef|coin::MintCapability)\b/],
  ['freeze', /0x0*1::(fungible_asset::TransferRef|coin::FreezeCapability)\b/],
  ['burn', /0x0*1::(fungible_asset::BurnRef|coin::BurnCapability)\b/],
];

/** Which framework power types appear in struct fields of these modules. */
export function powerStructs(modules) {
  const out = { mint: [], freeze: [], burn: [] };
  for (const m of modules) {
    const abi = m.abi;
    if (!abi) continue;
    for (const s of abi.structs ?? []) {
      for (const f of s.fields ?? []) {
        for (const [k, re] of POWER_TYPES) {
          if (re.test(f.type)) out[k].push(`${abi.name}::${s.name}`);
        }
      }
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort().slice(0, 8);
  return out;
}

const callableFns = (modules) => modules.flatMap((m) => (m.abi?.exposed_functions ?? []).map((f) => ({
  module: m.abi.name, name: f.name, callable: (f.is_entry || f.visibility === 'public') && !f.is_view,
})));

const firstOpt = (o) => (Array.isArray(o?.vec) && o.vec.length ? o.vec[0] : null);

/**
 * `api` has get(path) -> JSON or null on 404, and view(body) -> JSON.
 */
export async function readAptosAccount(api, input) {
  if (MOVE_TYPE_RE.test(input)) return readCoin(api, parseMoveType(input));
  const addr = longAddress(input);
  const resources = await api.get(`/accounts/${addr}/resources?limit=200`);
  if (!resources || !resources.length) {
    const modules = await api.get(`/accounts/${addr}/modules?limit=100`);
    if (!modules?.length) return { kind: 'missing' };
    return packageFacts(api, addr, modules, null);
  }
  const res = (t) => resources.find((r) => r.type === t)?.data ?? null;
  const md = res('0x1::fungible_asset::Metadata');
  if (!md) {
    if (res('0x1::code::PackageRegistry')) {
      const modules = await api.get(`/accounts/${addr}/modules?limit=100`) ?? [];
      return packageFacts(api, addr, modules, resources);
    }
    return { kind: 'other', address: addr, isAccount: !!res('0x1::account::Account') };
  }

  // Fungible Asset metadata object.
  const supplyR = res('0x1::fungible_asset::ConcurrentSupply');
  const fixedR = res('0x1::fungible_asset::Supply');
  let maxSupply = null;
  if (supplyR) maxSupply = supplyR.current?.max_value ?? null;
  else if (fixedR) maxSupply = firstOpt(fixedR.maximum);
  if (maxSupply === '340282366920938463463374607431768211455') maxSupply = null; // u128::MAX = unlimited
  let supply;
  try {
    const v = await api.view({ function: '0x1::fungible_asset::supply', type_arguments: ['0x1::fungible_asset::Metadata'], arguments: [addr] });
    supply = firstOpt(v?.[0]) ?? undefined;
  } catch { supply = undefined; }

  const core = res('0x1::object::ObjectCore');
  const dispatch = res('0x1::fungible_asset::DispatchFunctionStore');
  const hooks = dispatch
    ? ['withdraw_function', 'deposit_function', 'derived_balance_function']
      .map((k) => firstOpt(dispatch[k]))
      .filter(Boolean)
      .map((f) => `${shortAddress(f.module_address)}::${f.module_name}::${f.function_name}`)
    : [];

  // Packages that may hold the refs: the owners of non-framework resources
  // on the metadata object, and the object's owner.
  const candidates = new Set();
  for (const r of resources) {
    const a = r.type.split('::')[0];
    if (MOVE_ADDR_RE.test(a) && !isFramework(a)) candidates.add(longAddress(a));
  }
  if (core?.owner && MOVE_ADDR_RE.test(core.owner) && !isFramework(core.owner)) candidates.add(longAddress(core.owner));
  const modules = [];
  const packages = [];
  for (const a of [...candidates].slice(0, 4)) {
    const mods = await api.get(`/accounts/${a}/modules?limit=100`);
    if (!mods?.length) continue;
    modules.push(...mods);
    packages.push(await upgradePolicy(api, a));
  }

  return {
    kind: 'fa',
    address: addr,
    token: {
      name: cleanText(md.name) ?? undefined,
      symbol: cleanText(md.symbol, 24) ?? undefined,
      decimals: Number.isInteger(md.decimals) ? md.decimals : undefined,
      supply,
      maxSupply: maxSupply ?? undefined,
    },
    owner: core?.owner ? longAddress(core.owner) : null,
    hooks,
    untransferable: resources.some((r) => r.type === '0x1::fungible_asset::Untransferable'),
    refs: powerStructs(modules),
    powers: scanFunctions(callableFns(modules)),
    packages,
    framework: isFramework(addr),
  };
}

async function upgradePolicy(api, addr) {
  const reg = await api.get(`/accounts/${addr}/resource/${enc('0x1::code::PackageRegistry')}`);
  const pk = reg?.data?.packages ?? [];
  // policy: 0 arbitrary, 1 compatible, 2 immutable
  const upgradeable = pk.filter((p) => Number(p.upgrade_policy?.policy) !== 2).map((p) => p.name);
  return { address: addr, upgradeable, immutable: pk.length > 0 && upgradeable.length === 0 };
}

async function packageFacts(api, addr, modules, resources) {
  return {
    kind: 'package',
    address: addr,
    refs: powerStructs(modules),
    powers: scanFunctions(callableFns(modules)),
    packages: [await upgradePolicy(api, addr)],
    framework: isFramework(addr),
    hasResources: !!resources,
  };
}

async function readCoin(api, coin) {
  const type = `${shortAddress(coin.address)}::${coin.module}::${coin.name}`;
  const info = await api.get(`/accounts/${coin.address}/resource/${enc(`0x1::coin::CoinInfo<${type}>`)}`);
  if (!info) return { kind: 'missing' };
  const d = info.data ?? {};
  let supply;
  try {
    const v = await api.view({ function: '0x1::coin::supply', type_arguments: [type], arguments: [] });
    supply = firstOpt(v?.[0]) ?? undefined;
  } catch { supply = undefined; }
  // 0x1::managed_coin keeps all three capabilities at the creator's account.
  const managed = await api.get(`/accounts/${coin.address}/resource/${enc(`0x1::managed_coin::Capabilities<${type}>`)}`);
  const framework = isFramework(coin.address);
  const modules = framework ? [] : (await api.get(`/accounts/${coin.address}/modules?limit=100`) ?? []);
  const own = modules.filter((m) => m.abi?.name === coin.module);
  const refs = powerStructs(modules);
  if (managed) for (const k of ['mint', 'freeze', 'burn']) refs[k] = [...new Set([...refs[k], '0x1::managed_coin::Capabilities'])];
  return {
    kind: 'coin',
    type,
    address: coin.address,
    token: {
      name: cleanText(d.name) ?? undefined,
      symbol: cleanText(d.symbol, 24) ?? undefined,
      decimals: Number.isInteger(d.decimals) ? d.decimals : undefined,
      supply,
    },
    managed: !!managed,
    refs,
    powers: scanFunctions(callableFns(own)),
    packages: framework ? [] : [await upgradePolicy(api, coin.address)],
    framework,
  };
}

/** Facts -> { level, control, findings }. */
export function analyzeAptos(m, ctx = {}) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  const known = ctx.known ?? null;
  const cap = (s) => (known && RANK[s] > RANK.low ? 'low' : s);
  const issuer = known ? { issuer: known.issuer } : {};

  if (m.kind === 'missing') {
    add('apt-not-found', 'info');
  } else if (m.kind === 'other') {
    add('apt-not-token', 'info', { address: m.address, account: m.isAccount });
  } else {
    if (m.kind === 'coin' || m.kind === 'fa') {
      const t = m.token;
      add('apt-token', 'info', {
        standard: m.kind === 'coin' ? 'Coin' : 'Fungible Asset',
        name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.supply, maxSupply: t.maxSupply,
      });
      if ((t.name && LINK_RE.test(t.name)) || (t.symbol && LINK_RE.test(t.symbol))) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
      if (known) add('known-issuer', 'good', { symbol: known.symbol, issuer: known.issuer, kind: known.kind });
      if (ctx.lookalike) add('lookalike', 'high', { symbol: t.symbol, official: ctx.lookalike.display ?? ctx.lookalike.address, issuer: ctx.lookalike.issuer });
    } else {
      add('apt-package', 'info', { address: m.address });
    }

    if (!m.framework) {
      if (m.managed) add('apt-managed-coin', cap('high'), { account: m.address, ...issuer });
      if (m.refs.mint.length) add('apt-mint-power', cap('high'), { structs: m.refs.mint, ...issuer });
      if (m.refs.freeze.length) add('apt-freeze-power', cap('high'), { structs: m.refs.freeze, ...issuer });
      if (m.refs.burn.length) add('apt-burn-power', cap('high'), { structs: m.refs.burn, ...issuer });
      if (m.hooks?.length) add('apt-dispatch', cap('high'), { functions: m.hooks, ...issuer });
      if (m.untransferable) add('apt-untransferable', 'info');
      for (const p of m.packages ?? []) {
        if (p.upgradeable.length) add('apt-upgradeable', cap('high'), { address: p.address, packages: p.upgradeable, ...issuer });
        else if (p.immutable) add('apt-immutable', 'good', { address: p.address });
      }
      addPowerFindings(add, m.powers ?? {}, cap, issuer);
    } else {
      add('apt-framework', 'info');
    }
  }

  if (!findings.some((f) => RANK[f.severity] > 0 || f.severity === 'good')) add('nothing-found', 'info');
  add('move-caveat', 'info');
  return { level: levelOf(findings), control: m.kind, findings };
}
