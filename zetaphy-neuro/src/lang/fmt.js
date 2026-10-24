// Formatting shared by every language file.

/** Raw integer amount -> "1,234.5678" using the token's decimals. */
export const fmtSupply = (raw, decimals) => {
  if (raw == null) return '?';
  let n;
  try { n = BigInt(raw); } catch { return '?'; }
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 0;
  const s = n.toString().padStart(d + 1, '0');
  const whole = s.slice(0, s.length - d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = d ? s.slice(s.length - d).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
};

/** ['a', 'b'] -> "a, b" */
export const list = (xs) => (xs ?? []).join(', ');

/** "0x0000…02" style short form for long Move and TON addresses. */
export const short = (a) => {
  const s = String(a ?? '?');
  return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
};

/** A token's symbol as its contract writes it, or its short address. */
export const sym = (p) => p.symbol || short(p.token);
