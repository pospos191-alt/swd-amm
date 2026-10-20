// Neuro tier 1 for Bitcoin Runes. Read-only: GET /rune/<name or id> from the
// JSON API of `ord`, the reference Runes indexer (ordinals.com, free, no key).
// Hiro's Runes/BRC-20 APIs were shut down in March 2026; BRC-20 has no free
// keyless API and is not read yet.
//
// Bitcoin has no token contracts. A Rune is a set of rules written once, when
// it is etched, and read by indexers. Nobody can freeze, blacklist, pause,
// tax or upgrade it later. What still matters:
//   open mint   anyone can still mint until the cap or end block, so the
//               supply is still growing (without a cap or end: forever)
//   premine     part of the supply went to the etcher at creation
//   turbo       the etcher opted in to future protocol changes

import { cleanText } from './abi.js';
import { LINK_RE, levelOf } from './move.js';

const RUNE_ID = /^\d{1,7}:\d{1,5}$/;
const RUNE_NAME = /^[A-Za-z]+([•.][A-Za-z]+)*$/;

/** A rune id (840000:3) or name (DOG•GO•TO•THE•MOON; dots work as spacers), normalized; null if neither. */
export function parseRune(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 64) return null;
  if (RUNE_ID.test(s)) return s;
  if (!RUNE_NAME.test(s)) return null;
  const name = s.toUpperCase().replace(/\./g, '•');
  return name.replace(/•/g, '').length <= 28 ? name : null;
}
export const isRuneInput = (s) => parseRune(s) !== null;

const big = (v) => {
  if (v == null) return null;
  try { const n = BigInt(v); return n >= 0n ? n : null; } catch { return null; }
};
const pct = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : 0);

// ---------------------------------------------------------------- reader
/** `api.get(path)` returns parsed JSON (large integers as strings), or null on 404. */
export async function readRune(api, input) {
  const q = parseRune(input);
  if (!q) return { kind: 'missing' };
  const r = await api.get(`/rune/${encodeURIComponent(q)}`);
  const e = r?.entry;
  if (!e) return { kind: 'missing' };

  const dec = Number(e.divisibility);
  const d = Number.isInteger(dec) && dec >= 0 && dec <= 38 ? dec : 0;
  const t = e.terms ?? null;
  const premine = big(e.premine) ?? 0n;
  const amount = big(t?.amount);
  const cap = big(t?.cap);
  const mints = big(e.mints) ?? 0n;
  const supply = premine + mints * (amount ?? 0n);
  const max = premine + (cap ?? 0n) * (amount ?? 0n);
  const endHeight = t?.height?.[1] ?? (t?.offset?.[1] != null && e.block != null ? Number(e.block) + Number(t.offset[1]) : null);
  return {
    kind: 'rune',
    id: String(r.id ?? q),
    open: r.mintable === true,
    unlimited: !!t && amount != null && cap == null && endHeight == null,
    mintedPct: cap ? pct(mints, cap) : null,
    endHeight: endHeight ?? null,
    premineShare: max > 0n ? pct(premine, max) : 0,
    turbo: e.turbo === true,
    token: {
      name: cleanText(String(e.spaced_rune ?? q), 40) ?? undefined,
      symbol: e.symbol != null ? cleanText(String(e.symbol), 8) || undefined : undefined,
      decimals: d,
      totalSupply: supply.toString(),
      maxSupply: cap != null ? max.toString() : undefined,
      burned: big(e.burned)?.toString(),
    },
  };
}

export function analyzeRune(m) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  if (m.kind === 'missing') add('btc-not-found', 'info');
  else {
    const t = m.token;
    add('btc-rune', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.totalSupply, id: m.id });
    if (t.name && LINK_RE.test(t.name)) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
    add('btc-no-admin', 'good');
    if (m.open) add('btc-open-mint', m.unlimited ? 'medium' : 'info', { percent: m.mintedPct ?? undefined, end: m.endHeight ?? undefined, unlimited: m.unlimited, maxSupply: t.maxSupply, decimals: t.decimals });
    if (m.premineShare >= 50) add('btc-premine', 'medium', { percent: m.premineShare });
    else if (m.premineShare >= 10) add('btc-premine', 'low', { percent: m.premineShare });
    if (m.turbo) add('btc-turbo', 'info');
  }
  add('btc-caveat', 'info');
  return { level: levelOf(findings), control: m.kind, findings };
}
