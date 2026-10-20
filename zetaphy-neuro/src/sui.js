// Neuro tier 1 for Sui (Move). Read-only: only GraphQL queries are sent,
// never a transaction or a mutation.
//
// A Sui coin is a Move type `0xPACKAGE::module::NAME`. Its powers are
// objects, not code paths:
//   TreasuryCap<T>  whoever holds it can mint (and burn) without limit
//   DenyCap<T>      a "regulated" coin: the holder can block addresses,
//                   and sometimes pause every transfer at once
//   UpgradeCap      whoever holds it can replace the package's code
// Sui's GraphQL service already tracks the first two for each currency
// (supplyState, regulatedState, denyCap). The TreasuryCap and UpgradeCap
// holders are found in the transaction that published the package.

import { cleanText } from './abi.js';
import {
  longAddress, normalizeType, parseMoveType, scanFunctions, addPowerFindings, levelOf,
  MOVE_ADDR_RE, MOVE_TYPE_RE, RANK, LINK_RE,
} from './move.js';

// Sui mainnet: base58 digest of the genesis checkpoint.
export const SUI_MAINNET = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

const OWNER = `owner { __typename
  ... on AddressOwner { address { address } }
  ... on ObjectOwner { address { address } }
  ... on ConsensusAddressOwner { address { address } } }`;

export const Q_COIN = `query NeuroSuiCoin($t: String!, $p: SuiAddress!) {
  coinMetadata(coinType: $t) {
    name symbol decimals supply supplyState regulatedState allowGlobalPause
    denyCap { address ${OWNER} }
  }
  package(address: $p) {
    address
    previousTransaction { digest effects { objectChanges(first: 50) { nodes {
      address idCreated
      outputState { ${OWNER} asMoveObject { contents { type { repr } } } }
    } } } }
  }
}`;

export const Q_MODULES = `query NeuroSuiModules($p: SuiAddress!) {
  package(address: $p) {
    modules(first: 50) {
      pageInfo { hasNextPage }
      nodes { name functions(first: 50) { pageInfo { hasNextPage } nodes { name visibility isEntry } } }
    }
  }
}`;

export const Q_OBJECTS = `query NeuroSuiObjects($keys: [ObjectKey!]!) {
  multiGetObjects(keys: $keys) {
    address ${OWNER}
    asMoveObject { contents { type { repr } json } }
  }
}`;

const SYSTEM_PACKAGES = new Set([1n, 2n, 3n, 0xdeeb7n]);
const isSystem = (addr) => SYSTEM_PACKAGES.has(BigInt(addr));

/** Is `s` a Sui coin type or a package/object id? */
export function isSuiInput(s) {
  return typeof s === 'string' && (MOVE_TYPE_RE.test(s) || MOVE_ADDR_RE.test(s));
}

/** Owner union -> { kind, address? } */
function ownerOf(o) {
  if (!o) return { kind: 'none' };
  switch (o.__typename) {
    case 'AddressOwner': return { kind: 'address', address: o.address?.address ?? null };
    case 'ConsensusAddressOwner': return { kind: 'address', address: o.address?.address ?? null };
    case 'ObjectOwner': return { kind: 'object', address: o.address?.address ?? null };
    case 'Shared': return { kind: 'shared' };
    case 'Immutable': return { kind: 'immutable' };
    default: return { kind: 'unknown' };
  }
}

// UpgradeCap.policy (sui::package): what the next upgrade may change.
const POLICY = { 0: 'compatible', 128: 'additive', 192: 'dependency-only' };

/**
 * Reads one Sui coin type (0x…::module::NAME) or package id.
 * `gql(query, variables)` must return the GraphQL `data` object.
 */
export async function readSuiAccount(gql, input) {
  const isType = MOVE_TYPE_RE.test(input);
  const coin = isType ? parseMoveType(input) : null;
  const pkg = coin ? coin.address : longAddress(input);

  const d = await gql(Q_COIN, { t: coin ? coin.type : '0x2::sui::SUI', p: pkg });
  const meta = coin ? d.coinMetadata : null;
  const published = d.package;
  if (!published && !meta) return { kind: 'missing' };

  // Function names of the package's modules (the readable part of Move code).
  let functions = [];
  let truncated = false;
  if (published) {
    const m = await gql(Q_MODULES, { p: pkg });
    const mods = m.package?.modules;
    truncated = !!mods?.pageInfo?.hasNextPage;
    for (const mod of mods?.nodes ?? []) {
      if (mod.functions?.pageInfo?.hasNextPage) truncated = true;
      for (const f of mod.functions?.nodes ?? []) {
        functions.push({ module: mod.name, name: f.name, callable: f.visibility === 'PUBLIC' || !!f.isEntry });
      }
    }
  }

  // Caps created when the package was published.
  let treasury = null;
  let upgrade = null;
  const system = isSystem(pkg);
  if (published && !system) {
    const created = (published.previousTransaction?.effects?.objectChanges?.nodes ?? [])
      .filter((c) => c.idCreated && c.outputState?.asMoveObject);
    const typeOf = (c) => normalizeType(c.outputState.asMoveObject.contents?.type?.repr ?? '');
    const UPGRADE = normalizeType('0x2::package::UpgradeCap');
    const TREASURY = coin ? normalizeType(`0x2::coin::TreasuryCap<${coin.type}>`) : null;
    const up = created.find((c) => typeOf(c) === UPGRADE);
    const tr = TREASURY ? created.find((c) => typeOf(c) === TREASURY) : null;
    const keys = [up, tr].filter(Boolean).map((c) => ({ address: c.address }));
    const now = keys.length ? (await gql(Q_OBJECTS, { keys })).multiGetObjects ?? [] : [];
    const live = (c) => (c ? now.find((o) => o && o.address === c.address) ?? null : null);
    if (up) {
      const o = live(up);
      upgrade = o
        ? { exists: true, id: up.address, owner: ownerOf(o.owner), policy: POLICY[Number(o.asMoveObject?.contents?.json?.policy)] ?? 'unknown' }
        : { exists: false, id: up.address };
    }
    if (tr) {
      const o = live(tr);
      treasury = o ? { exists: true, id: tr.address, owner: ownerOf(o.owner) } : { exists: false, id: tr.address };
    }
  }

  if (!coin || !meta) {
    return { kind: 'package', package: pkg, system, upgrade, powers: scanFunctions(functions), truncated, coinMissing: !!coin };
  }

  return {
    kind: 'coin',
    type: coin.type,
    package: pkg,
    system,
    token: {
      name: cleanText(meta.name) ?? undefined,
      symbol: cleanText(meta.symbol, 24) ?? undefined,
      decimals: Number.isInteger(meta.decimals) ? meta.decimals : undefined,
      supply: meta.supply ?? undefined,
    },
    supplyState: meta.supplyState ?? null, // FIXED | BURN_ONLY | null (treasury still exists)
    regulated: meta.regulatedState ?? null, // REGULATED | UNREGULATED | null
    globalPause: meta.allowGlobalPause ?? null,
    denyCap: meta.denyCap ? { id: meta.denyCap.address, owner: ownerOf(meta.denyCap.owner) } : null,
    treasury,
    upgrade,
    powers: scanFunctions(functions.filter((f) => f.module === coin.module)),
    truncated,
  };
}

/** Facts -> { level, control, findings }. */
export function analyzeSui(m, ctx = {}) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  const known = ctx.known ?? null;
  const cap = (s) => (known && RANK[s] > RANK.low ? 'low' : s);
  const issuer = known ? { issuer: known.issuer } : {};
  const holder = (o) => (o?.kind === 'address' ? o.address : null);

  if (m.kind === 'missing') {
    add('sui-not-found', 'info');
  } else {
    if (m.kind === 'coin') {
      const t = m.token;
      add('sui-coin', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.supply, type: m.type });
      if ((t.name && LINK_RE.test(t.name)) || (t.symbol && LINK_RE.test(t.symbol))) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
      if (known) add('known-issuer', 'good', { symbol: known.symbol, issuer: known.issuer, kind: known.kind });
      if (ctx.lookalike) add('lookalike', 'high', { symbol: t.symbol, official: ctx.lookalike.display ?? ctx.lookalike.address, issuer: ctx.lookalike.issuer });

      if (m.supplyState === 'FIXED') add('sui-supply-fixed', 'good');
      else if (m.supplyState === 'BURN_ONLY') add('sui-supply-burn-only', 'good');
      else if (!m.system) {
        // The treasury still exists: someone can mint.
        const tr = m.treasury;
        const who = tr?.exists ? tr.owner : null;
        add('sui-treasury', cap(who?.kind === 'address' ? 'high' : 'medium'),
          { holder: holder(who), where: who?.kind ?? 'unknown', ...issuer });
      }
      if (m.regulated === 'REGULATED') {
        add('sui-regulated', cap('high'), { holder: holder(m.denyCap?.owner), ...issuer });
        if (m.globalPause) add('sui-global-pause', cap('high'), { ...issuer });
      }
    } else {
      add(m.coinMissing ? 'sui-not-coin' : 'sui-package', 'info', { package: m.package });
    }

    if (m.system) add('sui-system', 'info');
    else if (m.upgrade?.exists) add('sui-upgradeable', cap('high'), { holder: holder(m.upgrade.owner), where: m.upgrade.owner.kind, policy: m.upgrade.policy, ...issuer });
    else if (m.upgrade) add('sui-upgrade-cap-gone', 'low');

    addPowerFindings(add, m.powers ?? {}, cap, issuer);
    if (m.truncated) add('move-truncated', 'info');
  }

  if (!findings.some((f) => RANK[f.severity] > 0 || f.severity === 'good')) add('nothing-found', 'info');
  add('move-caveat', 'info');
  return { level: levelOf(findings), control: m.kind, findings };
}
