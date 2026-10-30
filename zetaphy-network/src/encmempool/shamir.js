// Shamir secret sharing over GF(2^8) (byte-wise, AES polynomial x^8+x^4+x^3+x+1).
// Every byte of the secret is the constant term of its own random polynomial of
// degree t-1; share j is the polynomials evaluated at x = j (1..255). Any t
// shares give the secret back by Lagrange interpolation at 0; t-1 shares are
// independent of the secret (information-theoretic, so this part is
// post-quantum by construction: no computational assumption at all).
//
// Shares are NOT verifiable on their own (this is plain Shamir, not Feldman or
// Pedersen VSS, which would need a group where discrete log is hard and so would
// not be post-quantum). The scheme commits to each share with a hash instead
// (see dealing.js); a dealer can still hand out shares that are individually
// committed but inconsistent. That is caught after the fact (the rebuilt key does
// not match the published public key) and is attributable, not prevented.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // multiply by the generator 3: x*2 ^ x, reduced by 0x11b
    x ^= (x << 1) ^ ((x & 0x80) ? 0x11b : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
export const gfDiv = (a, b) => {
  if (b === 0) throw new Error('division by zero');
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
};

/**
 * Splits `secret` (bytes) into n shares, any t of which rebuild it.
 * rng(k) must return k uniformly random bytes. Returns [{ x, y }] with x = 1..n.
 */
export function split(secret, n, t, rng) {
  if (!Number.isInteger(n) || !Number.isInteger(t) || t < 1 || t > n || n > 255) throw new Error(`bad threshold ${t}-of-${n}`);
  const coeffs = rng((t - 1) * secret.length); // coefficient k of byte b: coeffs[(k-1)*len + b]
  const shares = [];
  for (let x = 1; x <= n; x++) {
    const y = new Uint8Array(secret.length);
    for (let b = 0; b < secret.length; b++) {
      // Horner: a_{t-1} x^{t-1} + ... + a_1 x + secret
      let acc = 0;
      for (let k = t - 1; k >= 1; k--) acc = gfMul(acc, x) ^ coeffs[(k - 1) * secret.length + b];
      y[b] = gfMul(acc, x) ^ secret[b];
    }
    shares.push({ x, y });
  }
  return shares;
}

/** Rebuilds the secret from shares [{ x, y }] (uses all of them; give exactly t, or more of the same polynomial). */
export function combine(shares) {
  if (!shares.length) throw new Error('no shares');
  const len = shares[0].y.length;
  const xs = new Set();
  for (const s of shares) {
    if (!Number.isInteger(s.x) || s.x < 1 || s.x > 255) throw new Error('bad share index');
    if (xs.has(s.x)) throw new Error('duplicate share index');
    if (s.y.length !== len) throw new Error('share length mismatch');
    xs.add(s.x);
  }
  // Lagrange basis at 0: l_i = prod_{j!=i} x_j / (x_j - x_i); subtraction is xor in GF(2^8)
  const basis = shares.map((si, i) => {
    let num = 1, den = 1;
    shares.forEach((sj, j) => {
      if (i === j) return;
      num = gfMul(num, sj.x);
      den = gfMul(den, sj.x ^ si.x);
    });
    return gfDiv(num, den);
  });
  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    shares.forEach((s, i) => { acc ^= gfMul(s.y[b], basis[i]); });
    out[b] = acc;
  }
  return out;
}
