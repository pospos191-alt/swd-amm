// Neuro tier 1 for Bitcoin tokens: Runes and BRC-20. Read-only: GET requests
// to the free Hiro indexer API (runes/v1, ordinals/v1/brc-20) only.
//
// Bitcoin has no token contracts. A Rune or BRC-20 token is a set of rules
// written once, when it is created ("etched" / "deployed"), and read by
// indexers. Nobody can freeze, blacklist, pause, tax or upgrade it later.
// What still matters:
//   open mint       anyone can still mint until the cap or end block,
//                   so the supply is still growing
//   premine         part of the supply went to the creator at creation
//   self-mint       (5-byte BRC-20) only the deployer may mint
//   top holder      one address holding much of the supply can dump it

import { cleanText } from './abi.js';
import { LINK_RE, levelOf } from './move.js';

const RUNE_ID = /^\d{1,7}:\d{1,5}$/;
const RUNE_NAME = /^[A-Za-z]+([•.][A-Za-z]+)*$/;
const utf8Len = (s) => new TextEncoder().encode(s).length;

/**
 * What the input can be: a rune id (840000:3), a rune name (DOG•GO•TO•THE•MOON,
 * dots work as spacers), a BRC-20 ticker (4 or 5 bytes, e.g. ordi), or
 * `brc20:<ticker>` to force a ticker. null if none.
 */
export function parseBitcoinInput(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 64) return null;
  if (RUNE_ID.test(s)) return { rune: s };
  const forced = s.match(/^brc-?20:(.+)$/i);
  const ticker = forced ? forced[1] : s;
  const isTicker = (utf8Len(ticker) === 4 || utf8Len(ticker) === 5) && !/[\s/?#%\\:]/.test(ticker);
  if (forced) return isTicker ? { ticker: ticker.toLowerCase() } : null;
  const letters = s.replace(/[•.]/g, '');
  const rune = RUNE_NAME.test(s) && letters.length <= 28 ? letters.toUpperCase() : null;
  if (!rune && !isTicker) return null;
  return { ...(rune ? { rune } : {}), ...(isTicker ? { ticker: ticker.toLowerCase() } : {}) };
}
export const isBitcoinInput = (s) => parseBitcoinInput(s) !== null;

/** "1234.50" with `dec` decimals -> 123450n (raw units). */
export function units(str, dec) {
  if (str == null) return null;
  const m = String(str).match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, dec).padEnd(dec, '0');
  return BigInt(m[1] + frac);
}

const pct = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : 0);

// ---------------------------------------------------------------- reader
/** `api.get(path)` returns parsed JSON, or null on 404. */
export async function readBitcoinToken(api, input) {
  const q = parseBitcoinInput(input);
  if (!q) return { kind: 'missing' };
  const enc = encodeURIComponent;

  if (q.ticker) {
    const t = await api.get(`/ordinals/v1/brc-20/tokens/${enc(q.ticker)}`);
    if (t?.token) {
      const dec = Number(t.token.decimals);
      const d = Number.isInteger(dec) && dec >= 0 && dec <= 18 ? dec : 18;
      const max = units(t.supply?.max_supply ?? t.token.max_supply, d);
      const minted = units(t.supply?.minted_supply ?? t.token.minted_supply, d);
      let top = null;
      try {
        const h = await api.get(`/ordinals/v1/brc-20/tokens/${enc(q.ticker)}/holders?limit=1`);
        const r = h?.results?.[0];
        if (r && minted > 0n) top = { address: String(r.address), share: pct(units(r.overall_balance, d) ?? 0n, minted) };
      } catch { top = null; }
      return {
        kind: 'brc20',
        id: String(t.token.ticker ?? q.ticker),
        deployer: t.token.address ? String(t.token.address) : undefined,
        selfMint: t.token.self_mint === true,
        open: max != null && minted != null && minted < max,
        mintedPct: max ? pct(minted ?? 0n, max) : null,
        top,
        token: {
          name: cleanText(String(t.token.ticker ?? q.ticker), 24) ?? undefined,
          symbol: cleanText(String(t.token.ticker ?? q.ticker), 24) ?? undefined,
          decimals: d,
          totalSupply: minted?.toString(),
          maxSupply: max?.toString(),
          holders: Number.isInteger(t.supply?.holders) ? t.supply.holders : undefined,
        },
      };
    }
  }

  if (q.rune) {
    const e = await api.get(`/runes/v1/etchings/${enc(q.rune)}`);
    if (e?.id) {
      const dec = Number(e.divisibility);
      const d = Number.isInteger(dec) && dec >= 0 && dec <= 38 ? dec : 0;
      const s = e.supply ?? {};
      const t = e.mint_terms ?? {};
      const current = units(s.current, d) ?? 0n;
      const premine = units(s.premine, d) ?? 0n;
      // Hiro formats the cap (a number of mints) with the rune's decimals too.
      const cap = units(t.cap, d);
      const amount = units(t.amount, d);
      const max = cap != null && amount != null ? premine + cap * amount : (amount == null ? premine : null);
      let top = null;
      try {
        const h = await api.get(`/runes/v1/etchings/${enc(e.id)}/holders?limit=1`);
        const r = h?.results?.[0];
        if (r && current > 0n) top = { address: r.address ? String(r.address) : undefined, share: pct(units(r.balance, d) ?? 0n, current) };
      } catch { top = null; }
      return {
        kind: 'rune',
        id: String(e.id),
        open: s.mintable === true,
        mintedPct: s.mint_percentage != null ? Number(s.mint_percentage) : null,
        endHeight: t.height_end ?? (t.offset_end != null && e.location?.block_height ? e.location.block_height + t.offset_end : null),
        unlimited: amount != null && cap == null && t.height_end == null && t.offset_end == null,
        premineShare: max && max > 0n ? pct(premine, max) : (premine > 0n ? 100 : 0),
        turbo: e.turbo === true,
        top,
        token: {
          name: cleanText(String(e.spaced_name ?? e.name), 40) ?? undefined,
          symbol: cleanText(String(e.symbol ?? ''), 8) || undefined,
          decimals: d,
          totalSupply: current.toString(),
          maxSupply: max?.toString(),
        },
      };
    }
  }
  return { kind: 'missing' };
}

export function analyzeBitcoin(m) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  if (m.kind === 'missing') add('btc-not-found', 'info');
  else {
    const t = m.token;
    if (m.kind === 'rune') add('btc-rune', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.totalSupply, id: m.id });
    else add('btc-brc20', 'info', { name: t.name, decimals: t.decimals, totalSupply: t.totalSupply, maxSupply: t.maxSupply, holders: t.holders });
    if (t.name && LINK_RE.test(t.name)) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
    add('btc-no-admin', 'good');

    if (m.kind === 'rune') {
      if (m.open) add('btc-open-mint', m.unlimited ? 'medium' : 'info', { percent: m.mintedPct, end: m.endHeight ?? undefined, unlimited: m.unlimited, maxSupply: t.maxSupply, decimals: t.decimals });
      if (m.premineShare >= 50) add('btc-premine', 'medium', { percent: m.premineShare });
      else if (m.premineShare >= 10) add('btc-premine', 'low', { percent: m.premineShare });
      if (m.turbo) add('btc-turbo', 'info');
    } else {
      if (m.selfMint && m.open) add('btc-self-mint', 'medium', { deployer: m.deployer, percent: m.mintedPct });
      else if (m.open) add('btc-open-mint', 'info', { percent: m.mintedPct, maxSupply: t.maxSupply, decimals: t.decimals });
    }
    if (m.top && m.top.share >= 50) add('btc-top-holder', 'medium', m.top);
    else if (m.top && m.top.share >= 20) add('btc-top-holder', 'low', m.top);
  }
  add('btc-caveat', 'info');
  return { level: levelOf(findings), control: m.kind, findings };
}
