// Deterministic elementary functions for the in-browser language model.
//
// JavaScript only promises correctly rounded + - * / and Math.sqrt; Math.exp,
// Math.sin, Math.cos, Math.pow may differ in the last bit between engines
// (V8, SpiderMonkey, JavaScriptCore) and versions. The pipeline split across
// browsers (ai/browser/llama.js) must give the SAME bits on every peer, so the
// model uses these instead: range reduction plus a fixed polynomial, written
// only with the operations IEEE 754 fixes exactly. Accuracy is a few ulp
// (checked against Math.* in test/llm.test.js), far below float32 rounding.

const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;
// 1/n! for n = 0..13 (computed once with exact division: deterministic)
const INV_FACT = (() => { const a = [1]; for (let n = 1; n <= 13; n++) a.push(a[n - 1] / n); return a; })();

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const HI = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 1 : 0; // little-endian: high word at [1]
/** 2^k exactly, for integer k in [-1022, 1023]. */
function pow2(k) {
  u32[HI] = (k + 1023) << 20; u32[1 - HI] = 0;
  return f64[0];
}

/** e^x, deterministic. */
export function dexp(x) {
  if (x !== x) return NaN;
  if (x > 709.78) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO; // |r| <= ~0.347
  let p = INV_FACT[13];
  for (let n = 12; n >= 0; n--) p = p * r + INV_FACT[n];
  // split the scale so subnormal results stay exact multiplications by powers of two
  if (k < -1021) return p * pow2(k + 600) * pow2(-600);
  if (k > 1023) return p * pow2(k - 600) * pow2(600);
  return p * pow2(k);
}

const PIO2_1 = 1.57079632673412561417e+00;  // first 33 bits of pi/2
const PIO2_1T = 6.07710050650619224932e-11; // pi/2 - PIO2_1
const INV_PIO2 = 6.36619772367581382433e-01;

function sinPoly(r) { // |r| <= pi/4
  const r2 = r * r;
  let p = 0;
  for (let n = 17; n >= 3; n -= 2) p = (p + (n % 4 === 1 ? 1 : -1) * INV_FACT_ODD[n]) * r2;
  return r + r * p;
}
function cosPoly(r) {
  const r2 = r * r;
  let p = 0;
  for (let n = 16; n >= 2; n -= 2) p = (p + (n % 4 === 0 ? 1 : -1) * INV_FACT_ODD[n]) * r2;
  return 1 + p;
}
const INV_FACT_ODD = (() => { const a = [1]; for (let n = 1; n <= 17; n++) a.push(a[n - 1] / n); return a; })();

/** [sin x, cos x], deterministic; meant for |x| < 2^20 (rotary angles are position x frequency). */
export function dsincos(x) {
  if (!Number.isFinite(x)) return [NaN, NaN];
  if (Math.abs(x) >= 1048576) throw new Error('dsincos: |x| too large');
  const n = Math.round(x * INV_PIO2);
  const r = (x - n * PIO2_1) - n * PIO2_1T;
  const s = sinPoly(r), c = cosPoly(r);
  switch (((n % 4) + 4) % 4) {
    case 0: return [s, c];
    case 1: return [c, -s];
    case 2: return [-s, -c];
    default: return [-c, s];
  }
}

/** x * sigmoid(x) (SiLU), deterministic. */
export const dsilu = (x) => x / (1 + dexp(-x));

/** a^b for a > 0, deterministic (exp(b * ln a) with ln from a fixed series). */
export function dpow(a, b) {
  if (!(a > 0)) throw new Error('dpow: a must be > 0');
  return dexp(b * dlog(a));
}

/** ln x for x > 0, deterministic (exponent split + atanh series). */
export function dlog(x) {
  if (!(x > 0) || !Number.isFinite(x)) throw new Error('dlog: x must be finite and > 0');
  f64[0] = x;
  let e = ((u32[HI] >>> 20) & 0x7ff) - 1023;
  let m;
  if (e === -1023) { // subnormal: scale up first
    f64[0] = x * pow2(600);
    e = ((u32[HI] >>> 20) & 0x7ff) - 1023 - 600;
  }
  u32[HI] = (u32[HI] & 0x800fffff) | (1023 << 20);
  m = f64[0]; // in [1, 2)
  if (m > 1.4142135623730951) { m /= 2; e += 1; }
  const t = (m - 1) / (m + 1); // |t| <= 0.1716
  const t2 = t * t;
  let p = 0;
  for (let n = 41; n >= 3; n -= 2) p = (p + 1 / n) * t2;
  return e * LN2_HI + (e * LN2_LO + 2 * (t + t * p));
}
