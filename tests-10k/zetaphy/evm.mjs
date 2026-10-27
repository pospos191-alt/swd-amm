// ZETAPHY DEX contracts on an in-memory EVM (zetaphy-dex/test/helpers, the
// committed artifacts): the router's pure math against the page's JS, real
// swaps on a pair (k, reserves, the K check), and the DLMM math library
// against exact BigInt arithmetic.

import { setupDex, ONE } from '../../zetaphy-dex/test/helpers/dex.js';
import { art as dlmmArt, Q128 } from '../../zetaphy-dex/test/helpers/dlmm.js';
import { createChain } from '../../zetaphy-dex/test/helpers/evm.js';
import * as amm from '../../zetaphy-dex/web/lib/amm.js';
import { ok, eq } from '../lib/harness.mjs';

const MAX = (1n << 256n) - 1n;
const fits = (v) => v >= 0n && v <= MAX;
const reverted = async (p) => { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, err: e.message }; } };

// ------------------------------------------------------------------ Z2
export const routerDiff = {
  group: 'ZETAPHY', name: 'zetaphy/router-vs-js (EVM)', count: 500,
  what: 'ZetaphyRouter.getAmountOut / getAmountIn / quote on the EVM = web/lib/amm.js for random (also overflowing) inputs; the contract reverts exactly where the JS says "no quote" or a product overflows',
  async setup() { const d = await setupDex(); return { router: d.router }; },
  gen(R) {
    const big = () => (R.bool(0.1) ? 0n : R.bool(0.1) ? MAX - R.below(1000n) : R.spread(R.pick([64, 112, 128, 200, 256])));
    return { fn: R.pick(['getAmountOut', 'getAmountOut', 'getAmountIn', 'getAmountIn', 'quote']), a: big(), rIn: big(), rOut: big() };
  },
  async check({ fn, a, rIn, rOut }, { router }) {
    const r = await reverted(router.call(fn, [a, rIn, rOut]));
    if (fn === 'getAmountOut') {
      const valid = a > 0n && rIn > 0n && rOut > 0n && fits(a * 997n) && fits(a * 997n * rOut) && fits(rIn * 1000n) && fits(rIn * 1000n + a * 997n);
      eq(r.ok, valid, `getAmountOut(${a}, ${rIn}, ${rOut}) reverts iff invalid/overflow (${r.err ?? ''})`);
      if (valid) eq(r.v, amm.getAmountOut(a, rIn, rOut), 'getAmountOut contract = JS');
      else if (!(a > 0n && rIn > 0n && rOut > 0n)) eq(amm.getAmountOut(a, rIn, rOut), 0n, 'JS gives 0 where the contract refuses');
    } else if (fn === 'getAmountIn') {
      const valid = a > 0n && rIn > 0n && rOut > 0n && a < rOut && fits(rIn * a) && fits(rIn * a * 1000n) && fits((rOut - a) * 997n);
      const js = amm.getAmountIn(a, rIn, rOut);
      const noOverflowAdd = valid ? fits((rIn * a * 1000n) / ((rOut - a) * 997n) + 1n) : true;
      eq(r.ok, valid && noOverflowAdd, `getAmountIn(${a}, ${rIn}, ${rOut}) reverts iff invalid/overflow (${r.err ?? ''})`);
      if (valid && noOverflowAdd) eq(r.v, js, 'getAmountIn contract = JS');
      if (!(a > 0n && rIn > 0n && a < rOut)) eq(js, null, 'JS gives null where the contract refuses');
    } else {
      const valid = a > 0n && rIn > 0n && rOut > 0n && fits(a * rOut);
      eq(r.ok, valid, `quote(${a}, ${rIn}, ${rOut}) reverts iff invalid/overflow (${r.err ?? ''})`);
      if (valid) eq(r.v, amm.quote(a, rIn, rOut), 'quote contract = JS');
    }
  },
};

// ------------------------------------------------------------------ Z3
export const pairSwaps = {
  group: 'ZETAPHY', name: 'zetaphy/pair-swaps (EVM)', count: 300,
  what: 'real swaps on a ZetaphyPair (router exact-in, router exact-out, direct pair swaps): received = quote, reserves = balances, k never decreases, asking 1 wei more than the quote reverts with K',
  async setup() {
    const d = await setupDex();
    const { router, A, B, addr, deadline, factory, pairAt } = d;
    await router.send('alice', 'addLiquidity', [A.address, B.address, 1000n * ONE, 3000n * ONE, 0, 0, addr('alice'), deadline()]);
    const pair = pairAt(await factory.call('getPair', [A.address, B.address]));
    const aIs0 = (await pair.call('token0')).toLowerCase() === A.address.toLowerCase();
    return { ...d, pair, aIs0 };
  },
  gen(R, i) { return { step: i, op: R.pick(['in', 'in', 'out', 'direct']), ab: R.bool(), frac: R.range(1, 5_000), wei: R.bool(0.1) }; },
  async check({ op, ab, frac, wei }, d) {
    const { router, A, B, addr, deadline, pair, aIs0 } = d;
    const bal = (t, who) => t.call('balanceOf', [who]);
    const res = async () => { const r = await pair.call('getReserves'); return aIs0 ? [r[0], r[1]] : [r[1], r[0]]; };
    const [rA, rB] = await res();
    const [tin, tout, rin, rout] = ab ? [A, B, rA, rB] : [B, A, rB, rA];
    const who = 'bob';
    const before = await bal(tout, addr(who));
    if (op === 'in') {
      const x = wei ? BigInt(frac) : (rin * BigInt(frac)) / 10_000n + 1n; // up to half the reserve
      const q = amm.getAmountOut(x, rin, rout);
      if (q === 0n) return; // dust: nothing to check beyond the quote
      await router.send(who, 'swapExactTokensForTokens', [x, q, [tin.address, tout.address], addr(who), deadline()]);
      eq((await bal(tout, addr(who))) - before, q, 'received exactly the quote');
    } else if (op === 'out') {
      const y = (rout * BigInt(frac)) / 40_000n + 1n; // below the reserve
      const need = amm.getAmountIn(y, rin, rout);
      const inBefore = await bal(tin, addr(who));
      await router.send(who, 'swapTokensForExactTokens', [y, need, [tin.address, tout.address], addr(who), deadline()]);
      eq((await bal(tout, addr(who))) - before, y, 'received exactly the asked amount');
      eq(inBefore - (await bal(tin, addr(who))), need, 'paid exactly getAmountIn');
    } else {
      const x = (rin * BigInt(frac)) / 10_000n + 1n;
      const q = amm.getAmountOut(x, rin, rout);
      await tin.send(who, 'transfer', [pair.address, x]);
      const outs = (v) => ((tout === A) === aIs0 ? [v, 0n] : [0n, v]);
      let refused = false;
      try { await pair.send(who, 'swap', [...outs(q + 1n), addr(who), '0x']); } catch (e) { refused = /K|InsufficientLiquidity/.test(e.message); }
      ok(refused, 'one wei more than the quote is refused (K)');
      if (q > 0n) await pair.send(who, 'swap', [...outs(q), addr(who), '0x']);
      else await pair.send(who, 'sync', []);
      eq((await bal(tout, addr(who))) - before, q, 'direct swap paid the quote');
    }
    const [nA, nB] = await res();
    ok(nA * nB >= rA * rB, `k never decreases (${rA * rB} -> ${nA * nB})`);
    eq(await bal(A, pair.address), nA, 'reserve A = balance');
    eq(await bal(B, pair.address), nB, 'reserve B = balance');
  },
};

// ------------------------------------------------------------------ Z4
/** (1 + s/10^4)^id * 2^128 with 512-bit fixed point (as zetaphy-dex/test/dlmm.math.test.js). */
function exactPrice(id, step) {
  const P = 512n;
  const s = BigInt(step);
  let base = id >= 0 ? ((10_000n + s) << P) / 10_000n : (10_000n << P) / (10_000n + s);
  let n = BigInt(Math.abs(id));
  let r = 1n << P;
  while (n > 0n) { if (n & 1n) r = (r * base) >> P; n >>= 1n; if (n > 0n) base = (base * base) >> P; }
  return r >> (P - 128n);
}
const msbOf = (x) => (x === 0n ? 0n : BigInt(x.toString(2).length - 1));
const lsbOf = (x) => (x === 0n ? 0n : msbOf(x & -x));

export const dlmmMath = {
  group: 'ZETAPHY', name: 'zetaphy/dlmm-math (EVM)', count: 500,
  what: 'DlmmMath on the EVM vs exact BigInt: mulDiv/mulDivUp (512-bit, revert iff d=0 or overflow), mulPrice/divPrice floor and ceil, msb/lsb, bin price within 1e-9 of (1+s/1e4)^id, strictly increasing in id, refused outside [2^-96, 2^96]',
  async setup() { const c = await createChain(['a']); return { h: await c.deployRaw(dlmmArt('DlmmMathHarness'), [], 'a') }; },
  gen(R) {
    const fn = R.pick(['mulDiv', 'mulDivUp', 'mulPrice', 'divPrice', 'bits', 'price', 'price']);
    const v = () => (R.bool(0.1) ? R.below(4n) : R.big(R.pick([8, 64, 128, 200, 255, 256])));
    if (fn === 'price') return { fn, id: R.bool(0.15) ? R.range(-8_400_000, 8_400_000) : R.range(-70_000, 70_000), step: R.pick([1, 2, 5, 10, 15, 20, 25, 50, 100, 250, 1000, R.range(1, 1000)]) };
    if (fn === 'mulPrice' || fn === 'divPrice') return { fn, a: R.big(R.range(1, 128)), p: (R.big(R.range(32, 224)) | (1n << 32n)) };
    return { fn, a: v(), b: v(), d: R.bool(0.05) ? 0n : v() };
  },
  async check(c, { h }) {
    if (c.fn === 'mulDiv' || c.fn === 'mulDivUp') {
      const r = await reverted(h.call(c.fn, [c.a, c.b, c.d]));
      if (c.d === 0n) { ok(!r.ok, 'division by zero reverts'); return; }
      const exact = c.fn === 'mulDiv' ? (c.a * c.b) / c.d : (c.a * c.b + c.d - 1n) / c.d;
      eq(r.ok, fits(exact), `${c.fn} reverts iff the result overflows`);
      if (r.ok) eq(r.v, exact, `${c.fn}(${c.a}, ${c.b}, ${c.d})`);
    } else if (c.fn === 'mulPrice') {
      const [down, up] = await h.call('mulPrice', [c.a, c.p]);
      const n = c.a * c.p;
      eq(down, n >> 128n, 'mulPriceDown = floor');
      eq(up, (n + Q128 - 1n) >> 128n, 'mulPriceUp = ceil');
    } else if (c.fn === 'divPrice') {
      const [down, up] = await h.call('divPrice', [c.a, c.p]);
      const n = c.a << 128n;
      eq(down, n / c.p, 'divPriceDown = floor');
      eq(up, (n + c.p - 1n) / c.p, 'divPriceUp = ceil');
    } else if (c.fn === 'bits') {
      const x = c.a;
      const [m, l] = await h.call('bits', [x]);
      eq(m, msbOf(x), `msb(${x})`); eq(l, lsbOf(x), `lsb(${x})`);
    } else {
      const { id, step } = c;
      const r = await reverted(h.call('price', [id, step]));
      const e = exactPrice(id, step);
      const MIN = 1n << 32n, MAXP = 1n << 224n;
      // Inside the range by a margin -> must answer; well outside -> must refuse.
      const inside = e > MIN + (MIN >> 20n) && e < MAXP - (MAXP >> 20n);
      const outside = e < MIN - (MIN >> 20n) || e > MAXP + (MAXP >> 20n);
      if (inside) ok(r.ok, `price(${id}, ${step}) in range must not revert (${r.err})`);
      if (outside) ok(!r.ok, `price(${id}, ${step}) out of range must revert`);
      if (r.ok) {
        const diff = r.v > e ? r.v - e : e - r.v;
        ok(diff * 1_000_000_000n <= e, `price(${id}, ${step}) within 1e-9 of exact (${r.v} vs ${e})`);
        if (id < 0) ok(r.v <= e + 2n, 'negative ids round down (never above the exact price)');
        const nx = await reverted(h.call('price', [id + 1, step]));
        if (nx.ok) ok(nx.v > r.v, `price strictly increasing at id ${id}`);
      }
    }
  },
};

export default [routerDiff, pairSwaps, dlmmMath];
