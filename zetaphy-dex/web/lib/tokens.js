// Token names and symbols are text a token's creator wrote: shown as plain
// text only (textContent), without control, format (bidi) or private-use
// characters, and cut to a short length. Lookalike checks against the list.

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

/** Plain, short, single-line text. */
export function cleanText(s, max = 40) {
  return Array.from(String(s ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

export const cleanName = (s) => cleanText(s, 40) || '?';
export const cleanSymbol = (s) => cleanText(s, 12) || '?';

/** A token list entry we accept (Uniswap token-list subset): returns a clean copy or null. */
export function validEntry(t, chainId) {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(t.address)) return null;
  if (t.chainId !== undefined && Number(t.chainId) !== Number(chainId)) return null;
  const decimals = Number(t.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return { address: t.address, name: cleanName(t.name), symbol: cleanSymbol(t.symbol), decimals, source: t.source ?? 'list' };
}

/** Folded form for lookalike checks: case, whitespace and common confusables. */
export function fold(s) {
  return cleanText(s, 64).normalize('NFKC').toLowerCase().replace(/\s/g, '')
    .replace(/[0о]/g, 'o').replace(/[1lі]/g, 'l').replace(/[ѕ]/g, 's').replace(/[аɑ]/g, 'a').replace(/[еє]/g, 'e').replace(/[рρ]/g, 'p').replace(/[сϲ]/g, 'c').replace(/[хχ]/g, 'x');
}

/** Listed tokens whose symbol or name looks the same as `t`'s but which sit at another address. */
export function lookalikes(t, list) {
  const s = fold(t.symbol), n = fold(t.name);
  return list.filter((o) => o.address.toLowerCase() !== t.address.toLowerCase() && (fold(o.symbol) === s || (n.length > 2 && fold(o.name) === n)));
}
