// Neuro tier 1 for Bitcoin Runes. Read-only: GET /rune/<name or id> on
// ordinals.com, which runs `ord`, the reference Runes indexer (free, no key).
// Its JSON API is switched off (HTTP 406), so the page itself is read; its
// layout is ord's templates/rune.html. Hiro's Runes/BRC-20 APIs were shut
// down in March 2026; BRC-20 has no free keyless API and is not read yet.
//
// Bitcoin has no token contracts. A Rune is a set of rules written once, when
// it is etched, and read by indexers. Nobody can freeze, blacklist, pause,
// tax or upgrade it later. What still matters:
//   open mint   anyone can still mint until the cap or end block, so the
//               supply is still growing
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

// ------------------------------------------------------------ the page
const unescape = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const text = (h) => unescape(h.replace(/<[^>]*>/g, '')).trim();

/** ord prints amounts as "123.45 SYMBOL": back to raw units with `dec` decimals. */
export function pileUnits(str, dec) {
  const m = String(str ?? '').match(/^(\d+)(?:\.(\d+))?/);
  if (!m || (m[2] ?? '').length > dec) return null;
  return BigInt(m[1] + (m[2] ?? '').padEnd(dec, '0'));
}

/** The <dt>/<dd> pairs of an ord /rune/ page (the mint terms' inner list included), or null. */
export function parseRunePage(html) {
  const h1 = String(html).match(/<h1>([^<]*)<\/h1>/);
  if (!h1) return null;
  const f = {};
  // A <dd> holding a nested <dl> (the mint terms) is skipped so its own pairs are read.
  for (const m of String(html).matchAll(/<dt>([^<]+)<\/dt>\s*<dd[^>]*>((?:(?!<d[ltd][\s>]).)*?)<\/dd>/gs)) {
    const k = m[1].trim();
    if (!(k in f)) f[k] = text(m[2]);
  }
  if (!f.id || !RUNE_ID.test(f.id) || f.divisibility == null) return null;
  return { name: text(h1[1]), f };
}

// ---------------------------------------------------------------- reader
/** `api.getText(path)` returns the page, or null on 404. */
export async function readRune(api, input) {
  const q = parseRune(input);
  if (!q) return { kind: 'missing' };
  const page = parseRunePage((await api.getText(`/rune/${encodeURIComponent(q)}`)) ?? '');
  if (!page) return { kind: 'missing' };
  const { f } = page;

  const dec = Number(f.divisibility);
  const d = Number.isInteger(dec) && dec >= 0 && dec <= 38 ? dec : 0;
  const terms = 'mints' in f;
  const premine = pileUnits(f.premine, d) ?? 0n;
  const supply = pileUnits(f.supply, d) ?? 0n;
  const amount = terms && f.amount !== 'none' ? pileUnits(f.amount, d) : null;
  const cap = terms ? big(f.cap) ?? 0n : null;
  const mints = terms ? big(f.mints) ?? 0n : 0n;
  const end = terms && /^\d+$/.test(f.end ?? '') ? Number(f.end) : null;
  // ord shows a missing cap as 0: then nobody can mint.
  const max = premine + (cap ?? 0n) * (amount ?? 0n);
  return {
    kind: 'rune',
    id: f.id,
    open: f.mintable === 'true',
    mintedPct: cap ? pct(mints, cap) : null,
    endHeight: end,
    premineShare: max > 0n ? pct(premine, max) : 0,
    turbo: f.turbo === 'true',
    token: {
      name: cleanText(page.name, 40) ?? undefined,
      symbol: f.symbol ? cleanText(f.symbol, 8) || undefined : undefined,
      decimals: d,
      totalSupply: supply.toString(),
      maxSupply: terms && cap ? max.toString() : undefined,
      burned: pileUnits(f.burned, d)?.toString(),
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
    // ord never lets an uncapped rune be minted, so an open mint always ends at its cap.
    if (m.open) add('btc-open-mint', 'info', { percent: m.mintedPct ?? undefined, end: m.endHeight ?? undefined, maxSupply: t.maxSupply, decimals: t.decimals });
    if (m.premineShare >= 50) add('btc-premine', 'medium', { percent: m.premineShare });
    else if (m.premineShare >= 10) add('btc-premine', 'low', { percent: m.premineShare });
    if (m.turbo) add('btc-turbo', 'info');
  }
  add('btc-caveat', 'info');
  return { level: levelOf(findings), control: m.kind, findings };
}
