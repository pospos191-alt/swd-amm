// DLMM math (contracts/dlmm/DlmmMath.sol, UNAUDITED), against exact BigInt
// arithmetic: bin prices (128.128) and their bounds, monotonicity and
// reciprocity (ported from dlmm.rs's dlmm_math_tests), the 512-bit mulDiv,
// the price conversions and their rounding, and the bin bitmap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChain } from './helpers/evm.js';
import { art, Q128 } from './helpers/dlmm.js';

const STEPS = [1, 10, 25, 100, 1000];
const MAX_P = 1n << 224n;
const MIN_P = 1n << 32n;

function rng(seed) {
  let s = BigInt(seed) & ((1n << 64n) - 1n) || 1n;
  const next = () => { s ^= (s << 13n) & ((1n << 64n) - 1n); s ^= s >> 7n; s ^= (s << 17n) & ((1n << 64n) - 1n); return s; };
  return {
    big: (bits) => { let v = 0n; for (let i = 0; i < Math.ceil(bits / 64); i++) v = (v << 64n) | next(); return v & ((1n << BigInt(bits)) - 1n); },
    below: (n) => (n <= 0n ? 0n : next() % n),
  };
}

/** (1 + s/10^4)^id * 2^128 to ~2^-500 relative precision (512-bit fixed point; exact enough as a reference). */
function exactPrice(id, step) {
  const P = 512n;
  const s = BigInt(step);
  let base = id >= 0 ? ((10_000n + s) << P) / 10_000n : (10_000n << P) / (10_000n + s);
  let n = BigInt(Math.abs(id));
  let r = 1n << P;
  while (n > 0n) {
    if (n & 1n) r = (r * base) >> P;
    n >>= 1n;
    if (n > 0n) base = (base * base) >> P;
  }
  return r >> (P - 128n);
}

const rel = (a, b) => { const d = a > b ? a - b : b - a; return Number((d * 10n ** 18n) / b) / 1e18; };

let h;
const harness = async () => {
  if (h) return h;
  const c = await createChain(['a']);
  h = await c.deployRaw(art('DlmmMathHarness'), [], 'a');
  return h;
};

test('price(0) is exactly 1.0 and prices match (1 + binStep/10^4)^id within rounding', async () => {
  const m = await harness();
  for (const step of STEPS) assert.equal(await m.call('price', [0, step]), Q128);
  for (const [id, step, tol] of [[1, 25, 1e-30], [-1, 25, 1e-30], [10, 25, 1e-30], [-50, 100, 1e-30], [100, 10, 1e-30], [-100, 10, 1e-30],
    [5_000, 25, 1e-25], [-5_000, 25, 1e-25], [600_000, 1, 1e-10], [-600_000, 1, 1e-10], [6_000, 100, 1e-12], [-690, 1000, 1e-7]]) {
    const p = await m.call('price', [id, step]);
    const e = exactPrice(id, step);
    assert.ok(rel(p, e) <= tol, `price(${id}, ${step}): ${p} vs exact ${e} (rel ${rel(p, e)})`);
  }
});

test('price(n) * price(-n) ~ 1 (dlmm.rs bin_price_up_and_down_are_reciprocal, bin_price_works_far_from_zero)', async () => {
  const m = await harness();
  for (const [n, step] of [[1, 25], [10, 25], [50, 100], [100, 10], [5_000, 25]]) {
    const up = await m.call('price', [n, step]);
    const down = await m.call('price', [-n, step]);
    const prod = (up * down) >> 128n;
    assert.ok(rel(prod, Q128) <= 1e-25, `n=${n} step=${step}: ${prod}`);
  }
});

test('the bin id range is where the price stays inside [2^-96, 2^96]; one bin further is refused (PriceOutOfRange)', async () => {
  const m = await harness();
  const ok = async (id, step) => { try { await m.call('price', [id, step]); return true; } catch (e) { assert.match(e.message, /PriceOutOfRange/); return false; } };
  for (const step of STEPS) {
    for (const sign of [1, -1]) {
      let lo = 0;
      let hi = 1 << 23;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await ok(sign * mid, step)) lo = mid; else hi = mid; }
      const edge = sign * lo;
      const pe = await m.call('price', [edge, step]);
      assert.ok(pe <= MAX_P && pe >= MIN_P, `step ${step}: price at the edge ${edge} in range`);
      assert.equal(await ok(edge + sign, step), false, `step ${step}: ${edge + sign} refused`);
      // The exact price one bin further is out of range too (within one step of the bound).
      const ex = exactPrice(edge + sign, step);
      if (sign > 0) assert.ok(ex * 10_000n >= MAX_P * 9_999n, `step ${step}: the bound is the price, not an arbitrary id`);
      else assert.ok(ex * 9_999n <= MIN_P * 10_000n, `step ${step}: the lower bound is the price`);
    }
  }
  // Ids beyond int24, bin step 0 and above 1000 are refused.
  await assert.rejects(m.call('price', [1 << 23, 1]), /PriceOutOfRange/);
  await assert.rejects(m.call('price', [0, 0]), /InvalidBinStep/);
  await assert.rejects(m.call('price', [0, 1001]), /InvalidBinStep/);
});

test('prices are strictly increasing in the bin id, also next to the range bounds (dlmm.rs bin_price_is_monotonic)', async () => {
  const m = await harness();
  const r = rng(77);
  for (const step of [1, 25, 1000]) {
    // a run around zero, random runs, and runs at both bounds
    const lim = { 1: 665_000, 25: 26_600, 1000: 697 }[step];
    const starts = [-20, Number(r.below(BigInt(lim))) - lim / 2, lim - 30, -lim + 5];
    for (const s0 of starts) {
      let last = null;
      for (let id = s0; id < s0 + 20; id++) {
        let p;
        try { p = await m.call('price', [id, step]); } catch { continue; }
        if (last !== null) assert.ok(p > last, `step ${step}: price(${id}) > price(${id - 1})`);
        last = p;
      }
    }
  }
});

test('mulDiv / mulDivUp equal floor / ceil of the exact 512-bit result; overflow and division by zero revert', async () => {
  const m = await harness();
  const r = rng(1);
  const M = (1n << 256n) - 1n;
  for (let i = 0; i < 120; i++) {
    const a = r.big(1 + Number(r.below(256n)));
    const b = r.big(1 + Number(r.below(256n)));
    const d = r.big(1 + Number(r.below(256n))) || 1n;
    const q = (a * b) / d;
    if (q > M) {
      await assert.rejects(m.call('mulDiv', [a, b, d]), /MulDivOverflow/);
      continue;
    }
    assert.equal(await m.call('mulDiv', [a, b, d]), q, `${a}*${b}/${d}`);
    const up = (a * b) % d === 0n ? q : q + 1n;
    if (up > M) await assert.rejects(m.call('mulDivUp', [a, b, d]), /MulDivOverflow/);
    else assert.equal(await m.call('mulDivUp', [a, b, d]), up);
  }
  assert.equal(await m.call('mulDiv', [M, M, M]), M);
  await assert.rejects(m.call('mulDiv', [M, 2n, 1n]), /MulDivOverflow/);
  await assert.rejects(m.call('mulDiv', [1n, 1n, 0n]), /MulDivOverflow/);
  await assert.rejects(m.call('mulDiv', [M, M, 0n]), /MulDivOverflow/);
});

test('price conversions round down (output) and up (input); converting there and back never creates value', async () => {
  const m = await harness();
  const r = rng(9);
  for (let i = 0; i < 60; i++) {
    const p = MIN_P + r.below(MAX_P - MIN_P);
    const a = r.big(1 + Number(r.below(128n)));
    const [down, up] = await m.call('mulPrice', [a, p]);
    assert.equal(down, (a * p) >> 128n);
    assert.equal(up, (a * p) % Q128 === 0n ? down : down + 1n);
    const [dd, du] = await m.call('divPrice', [a, p]);
    assert.equal(dd, (a << 128n) / p);
    assert.equal(du, (a << 128n) % p === 0n ? dd : dd + 1n);
    // dlmm.rs convert_at_bin_price_round_trips_approximately: X -> Y -> X never returns more.
    const [back] = await m.call('divPrice', [down, p]);
    assert.ok(back <= a, 'round trip X -> Y -> X never gains');
    // amount_in_for_output_matches_convert_at_bin_price: the input for an output, rounded up, buys at least that output.
    const [, need] = await m.call('divPrice', [a, p]); // X needed for `a` Y
    const [got] = await m.call('mulPrice', [need, p]);
    assert.ok(got >= a, 'input rounded up buys at least the output');
  }
});

test('msb / lsb, and the bin bitmap finds the nearest set index below and above (all three levels, both ends)', async () => {
  const m = await harness();
  for (const x of [1n, 2n, 3n, 255n, 256n, 1n << 128n, (1n << 255n) | 1n, (1n << 256n) - 1n]) {
    const [hi, lo] = await m.call('bits', [x]);
    assert.equal(hi, BigInt(x.toString(2).length - 1));
    let l = 0n; while (((x >> l) & 1n) === 0n) l++;
    assert.equal(lo, l);
  }
  const NONE = (1n << 256n) - 1n;
  const TOP = (1n << 24n) - 1n;
  const set = new Set();
  const r = rng(5);
  const pick = () => {
    const k = r.below(6n);
    if (k === 0n) return 0n; if (k === 1n) return TOP;
    if (k === 2n) return (r.below(256n) << 16n) | 0xffffn; // level boundaries
    if (k === 3n) return r.below(256n) << 16n;
    return r.below(TOP + 1n);
  };
  const check = async () => {
    const sorted = [...set].sort((a, b) => (a < b ? -1 : 1));
    const probes = [0n, TOP, ...sorted.slice(0, 6), ...Array.from({ length: 8 }, pick)];
    for (const i of probes) {
      const [has, below, above] = await m.call('treeQuery', [i]);
      assert.equal(has, set.has(i));
      const b = sorted.filter((v) => v < i).pop() ?? NONE;
      const a = sorted.find((v) => v > i) ?? NONE;
      assert.equal(below, b, `below(${i})`);
      assert.equal(above, a, `above(${i})`);
    }
  };
  await check();
  for (let round = 0; round < 6; round++) {
    const add = Array.from({ length: 12 }, pick);
    await m.send('a', 'treeAdd', [add]);
    add.forEach((v) => set.add(v));
    await check();
    const rem = [...set].filter(() => r.below(3n) === 0n);
    await m.send('a', 'treeRemove', [rem]);
    rem.forEach((v) => set.delete(v));
    await check();
  }
  await m.send('a', 'treeRemove', [[...set]]);
  set.clear();
  await check();
});
