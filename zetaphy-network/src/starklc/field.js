// Prime field arithmetic for the STARK light client.
//
// Field: the "Stark252" prime p = 2^251 + 17 * 2^192 + 1 (the Cairo field).
// Why this field in a prototype:
//   - 252 bits: random challenges (constraint mixing, out-of-domain point, DEEP
//     and FRI coefficients) are drawn from the base field and still give ~2^-230
//     error terms, so no extension field is needed (simpler code to audit).
//   - p - 1 = 2^192 * (2^59 + 17): power-of-two subgroups of any useful size
//     for the FFT (two-adicity 192).
//   - 3 is a quadratic non-residue, so 3^((p-1)/2^k) is a primitive 2^k-th root
//     of unity, and 3 is outside every power-of-two subgroup (coset offset).
// The cost is speed and proof size (32-byte elements, BigInt arithmetic); a
// production prover would use a 64-bit or 31-bit field with an extension
// (see docs/future/stark-light-client.md).

export const P = (1n << 251n) + 17n * (1n << 192n) + 1n;
export const GENERATOR = 3n;
export const ELEMENT_BYTES = 32;

export const mod = (a) => { const r = a % P; return r < 0n ? r + P : r; };
export const add = (a, b) => { const c = a + b; return c >= P ? c - P : c; };
export const sub = (a, b) => { const c = a - b; return c < 0n ? c + P : c; };
export const mul = (a, b) => (a * b) % P;
export const neg = (a) => (a === 0n ? 0n : P - a);

export function pow(b, e) {
  let r = 1n;
  b = mod(b);
  e = BigInt(e);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

/** Inverse by the extended Euclidean algorithm (much faster than a^(p-2) with BigInt). */
export function inv(a) {
  a = mod(a);
  if (a === 0n) throw new Error('field: inverse of zero');
  let t = 0n, nt = 1n, r = P, nr = a;
  while (nr !== 0n) {
    const q = r / nr;
    [t, nt] = [nt, t - q * nt];
    [r, nr] = [nr, r - q * nr];
  }
  return t < 0n ? t + P : t;
}

/** Montgomery batch inversion: n inverses for one inversion and 3n multiplications. */
export function batchInv(xs) {
  const n = xs.length;
  const out = new Array(n);
  if (!n) return out;
  let acc = 1n;
  for (let i = 0; i < n; i++) { out[i] = acc; acc = (acc * xs[i]) % P; }
  let ia = inv(acc);
  for (let i = n - 1; i >= 0; i--) { const t = (out[i] * ia) % P; ia = (ia * xs[i]) % P; out[i] = t; }
  return out;
}

const isPow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
export const log2 = (n) => { if (!isPow2(n)) throw new Error(`not a power of two: ${n}`); return Math.round(Math.log2(n)); };

/** A primitive n-th root of unity (n a power of two, up to 2^30 here). */
export function rootOfUnity(n) {
  const k = log2(n);
  if (k > 30) throw new Error('field: domain too large');
  const w = pow(GENERATOR, (P - 1n) >> BigInt(k));
  if (n > 1 && pow(w, n / 2) !== P - 1n) throw new Error('field: root of unity check failed');
  return w;
}

/** In-order radix-2 NTT: evaluations of the polynomial with coefficients `a` at w^0..w^(n-1). */
export function ntt(input, w) {
  const n = input.length;
  log2(n);
  const a = input.slice();
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = a[i]; a[i] = a[j]; a[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const wl = pow(w, n / len);
    const tw = new Array(half);
    tw[0] = 1n;
    for (let k = 1; k < half; k++) tw[k] = (tw[k - 1] * wl) % P;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const u = a[i + k], v = (a[i + k + half] * tw[k]) % P;
        const s = u + v;
        a[i + k] = s >= P ? s - P : s;
        const d = u - v;
        a[i + k + half] = d < 0n ? d + P : d;
      }
    }
  }
  return a;
}

/** Coefficients of the polynomial taking values `evals` at w^0..w^(n-1). */
export function intt(evals, w) {
  const n = evals.length;
  const a = ntt(evals, inv(w));
  const ni = inv(BigInt(n));
  for (let i = 0; i < n; i++) a[i] = (a[i] * ni) % P;
  return a;
}

/** Evaluations of `coeffs` (length <= size) on the coset offset * <w_size>. */
export function cosetEval(coeffs, size, offset) {
  const a = new Array(size).fill(0n);
  let s = 1n;
  for (let i = 0; i < coeffs.length; i++) { a[i] = (coeffs[i] * s) % P; s = (s * offset) % P; }
  return ntt(a, rootOfUnity(size));
}

/** Coefficients of the polynomial taking values `evals` on offset * <w_n>. */
export function cosetInterpolate(evals, offset) {
  const n = evals.length;
  const c = intt(evals, rootOfUnity(n));
  const oi = inv(offset);
  let s = 1n;
  for (let i = 0; i < n; i++) { c[i] = (c[i] * s) % P; s = (s * oi) % P; }
  return c;
}

export function evalPoly(coeffs, x) {
  let r = 0n;
  for (let i = coeffs.length - 1; i >= 0; i--) r = (r * x + coeffs[i]) % P;
  return r;
}

export function toBytes(x) {
  const out = new Uint8Array(ELEMENT_BYTES);
  let v = BigInt(x);
  for (let i = ELEMENT_BYTES - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/** Big-endian bytes -> integer (no reduction). */
export function bytesToBigInt(b) {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** A canonical 32-byte element (< p) or an error. */
export function fromBytes(b) {
  if (b.length !== ELEMENT_BYTES) throw new Error('field: element is not 32 bytes');
  const v = bytesToBigInt(b);
  if (v >= P) throw new Error('field: non-canonical element');
  return v;
}

export function fieldsToBytes(xs) {
  const out = new Uint8Array(xs.length * ELEMENT_BYTES);
  xs.forEach((x, i) => out.set(toBytes(x), i * ELEMENT_BYTES));
  return out;
}
