// Shared helpers for Move chains (Sui and Aptos).
//
// Move code is published with its function names and signatures, so Neuro
// can read what a package lets its owner do much like it reads EVM
// selectors: a public or entry function called `mint`, `add_to_blacklist`
// or `set_fee` is a power someone can use.

export const RANK = { high: 3, medium: 2, low: 1, info: 0, good: 0 };
export const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|io|xyz|app|site|top|vip|pro|finance|claims?|gift|live|online|info)\b|t\.me\/)/i;

const HEX_ADDR = /0x[0-9a-fA-F]{1,64}/g;

/** 0x + 64 lowercase hex. Throws on anything that is not a 1–64 digit hex address. */
export function longAddress(a) {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(a)) throw new Error('invalid address');
  return '0x' + a.slice(2).toLowerCase().padStart(64, '0');
}

/** AIP-40 style: special addresses (0x0–0xf) short, everything else 64 digits. */
export function shortAddress(a) {
  const l = longAddress(a);
  const n = BigInt(l);
  return n < 16n ? '0x' + n.toString(16) : l;
}

/** Rewrites every address inside a Move type string to `fmt` (long by default). */
export function normalizeType(type, fmt = longAddress) {
  return String(type).replace(HEX_ADDR, (m) => fmt(m));
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]{0,127}';
// 0xADDR::module::Name with no generics: what a coin type looks like.
export const MOVE_TYPE_RE = new RegExp(`^0x[0-9a-fA-F]{1,64}::${IDENT}::${IDENT}$`);
export const MOVE_ADDR_RE = /^0x[0-9a-fA-F]{1,64}$/;

/** Splits a coin type into { address (long), module, name, type (long) }. */
export function parseMoveType(t) {
  if (!MOVE_TYPE_RE.test(t)) throw new Error('invalid address');
  const [addr, module, name] = t.split('::');
  const address = longAddress(addr);
  return { address, module, name, type: `${address}::${module}::${name}` };
}

// Function-name rules. Names are snake_case by convention; we match whole
// words between underscores so `minter_count` is not "mint" but `set_minter`
// (who may mint) is.
const RULES = [
  { cat: 'mint', re: /(^|_)(mint|mints|mint_to|issue)(_|$)|(^|_)(set|add|grant|update|change)_minters?(_|$)/ },
  { cat: 'blacklist', re: /(^|_)(blacklist|blacklisted|blocklist|denylist|deny|deny_list|freeze|unfreeze|frozen|ban|unban)(_|$)/ },
  { cat: 'pause', re: /(^|_)(pause|unpause|paused|set_paused|halt)(_|$)/ },
  { cat: 'fee', re: /(^|_)(set|update|change|modify)_([a-z0-9_]*_)?(fee|fees|tax|taxes|fee_rate|fee_bps)(_|$)/ },
  { cat: 'seize', re: /(^|_)(burn_from|confiscate|seize|clawback|claw_back|force_transfer|forced_transfer|recover_from)(_|$)/ },
];

/**
 * Categorises callable functions.
 * @param {Array<{module:string,name:string,callable:boolean}>} fns
 * @returns {{[cat:string]: string[]}}  e.g. { mint: ['coin::mint'] }
 */
export function scanFunctions(fns) {
  const out = {};
  for (const f of fns) {
    if (!f.callable) continue;
    const n = f.name.toLowerCase();
    for (const r of RULES) {
      if (r.re.test(n)) (out[r.cat] ??= []).push(`${f.module}::${f.name}`);
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort().slice(0, 8);
  return out;
}

const POWER_IDS = [
  ['mint', 'can-mint', 'high'],
  ['blacklist', 'can-blacklist', 'high'],
  ['pause', 'can-pause', 'high'],
  ['seize', 'can-seize', 'high'],
  ['fee', 'can-change-fee', 'medium'],
];

/** Adds can-* findings for the function scan. `cap` lowers severity for known issuers. */
export function addPowerFindings(add, powers, cap, issuer) {
  for (const [cat, id, sev] of POWER_IDS) {
    if (powers[cat]?.length) add(id, cap(sev), { functions: powers[cat], ...issuer });
  }
}

/** Highest severity among findings (good and info count as none). */
export function levelOf(findings) {
  return findings.reduce((acc, f) => (RANK[f.severity] > RANK[acc] ? f.severity : acc), 'info');
}
