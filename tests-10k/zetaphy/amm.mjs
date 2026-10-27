// ZETAPHY DEX page libraries (zetaphy-dex/web/lib): constant-product math,
// DLMM encoding / liquidity shapes, ABI encoding and amounts. Pure JS.

import * as amm from '../../zetaphy-dex/web/lib/amm.js';
import * as dl from '../../zetaphy-dex/web/lib/dlmm.js';
import * as abi from '../../zetaphy-dex/web/lib/abi.js';
import { AbiCoder, Interface, formatUnits as ethersFormatUnits } from '../../zetaphy-dex/node_modules/ethers/lib.esm/index.js';
import { ok, eq } from '../lib/harness.mjs';

const coder = AbiCoder.defaultAbiCoder();
const U112 = 112;

// ------------------------------------------------------------------ Z1
export const cpMath = {
  group: 'ZETAPHY', name: 'zetaphy/amm-math', count: 900,
  what: 'getAmountOut/getAmountIn (0.3% fee): output < reserve, k never decreases, the pair\'s fee-adjusted K check holds for the quote and fails for quote+1, monotonic in input, getAmountIn overcharges by at most 1 wei; slippage bounds, price impact in [0,100%], isqrt',
  gen(R) {
    const rIn = R.spread(U112), rOut = R.spread(U112);
    return { rIn, rOut, x: R.bool(0.15) ? R.below(1000n) + 1n : R.spread(U112 + 8), y: R.below(rOut) , d: R.spread(64), bps: R.range(0, 10_000), sq: R.bool(0.05) ? R.below(20n) : R.big(R.range(1, 256)) };
  },
  check({ rIn, rOut, x, y, d, bps, sq }) {
    const out = amm.getAmountOut(x, rIn, rOut);
    ok(out >= 0n && out < rOut, `0 <= out < reserveOut (${out} vs ${rOut})`);
    ok((rIn + x) * (rOut - out) >= rIn * rOut, 'k never decreases');
    // ZetaphyPair.swap's check: (bIn*1000 - in*3) * (bOut*1000) >= rIn*rOut*1000^2
    const K = (o) => ((rIn + x) * 1000n - x * 3n) * ((rOut - o) * 1000n) >= rIn * rOut * 1_000_000n;
    ok(K(out), 'quoted output passes the pair\'s K check');
    if (out + 1n < rOut) ok(!K(out + 1n), 'one wei more than the quote fails K (quote is the max)');
    ok(amm.getAmountOut(x + d, rIn, rOut) >= out, 'more input never gives less output');
    eq(amm.getAmountOut(0n, rIn, rOut), 0n, 'zero in, zero out');
    if (y > 0n) {
      const need = amm.getAmountIn(y, rIn, rOut);
      ok(need != null && need > 0n, 'getAmountIn defined below the reserve');
      ok(amm.getAmountOut(need, rIn, rOut) >= y, 'getAmountIn is enough');
      if (need >= 2n) ok(amm.getAmountOut(need - 2n, rIn, rOut) < y, 'getAmountIn overcharges by at most 1 wei');
    }
    eq(amm.getAmountIn(rOut, rIn, rOut), null, 'cannot buy the whole reserve');
    const lo = amm.minWithSlippage(out, bps), hi = amm.maxWithSlippage(out, bps);
    ok(lo <= out && hi >= out, 'slippage bounds around the amount');
    ok(lo * 10000n <= out * (10000n - BigInt(bps)) && (lo + 1n) * 10000n > out * (10000n - BigInt(bps)), 'min rounds down');
    ok(hi * 10000n >= out * (10000n + BigInt(bps)) && (hi - 1n) * 10000n < out * (10000n + BigInt(bps)), 'max rounds up');
    if (out > 0n) {
      const imp = amm.priceImpactBps([{ amountIn: x, amountOut: out, reserveIn: rIn, reserveOut: rOut }]);
      ok(imp >= 0n && imp <= 10000n, `impact in [0, 10000] bps: ${imp}`);
      const out2 = amm.getAmountOut(x * 2n, rIn, rOut);
      const imp2 = amm.priceImpactBps([{ amountIn: x * 2n, amountOut: out2, reserveIn: rIn, reserveOut: rOut }]);
      // With a tiny integer output the floor in getAmountOut dominates the "executed price";
      // monotonicity is only meaningful once that rounding is below 0.01 bps.
      if (out >= 1_000_000n) ok(imp2 + 1n >= imp, `a bigger trade never has a (meaningfully) smaller impact (${imp2} < ${imp})`);
    }
    const s = amm.sqrt(sq);
    ok(s * s <= sq && (s + 1n) * (s + 1n) > sq, 'isqrt');
  },
};

// ------------------------------------------------------------------ Z5
const STATIC = ['address', 'bool', 'uint8', 'uint16', 'uint24', 'uint256', 'int24', 'int256', 'uint128'];
function randType(R, depth = 0) {
  const r = R.float();
  if (depth < 2 && r < 0.15) return Array.from({ length: R.range(1, 4) }, () => randType(R, depth + 1));
  if (r < 0.3) return R.pick(['uint256', 'int24', 'uint16', 'address']) + '[]';
  return R.pick(STATIC);
}
function randValue(R, t) {
  if (Array.isArray(t)) return t.map((x) => randValue(R, x));
  if (t.endsWith('[]')) return Array.from({ length: R.int(5) }, () => randValue(R, t.slice(0, -2)));
  if (t === 'address') return '0x' + R.hex(20);
  if (t === 'bool') return R.bool();
  const m = /^(u?)int(\d+)$/.exec(t);
  const bits = Number(m[2]);
  if (m[1] === 'u') return R.big(R.int(bits + 1));
  const v = R.big(R.int(bits));
  return R.bool() ? -v : v;
}
const toEthersType = (t) => (Array.isArray(t) ? `(${t.map(toEthersType).join(',')})` : t);

export const dlmmLib = {
  group: 'ZETAPHY', name: 'zetaphy/dlmm-web-lib', count: 500,
  what: 'DLMM page lib: encodeArgs = ethers AbiCoder for random static/array/tuple types (signed ints too), decodeWords round trip; distribute() spends at most the totals, X only at/above and Y only at/below the active bin, active-bin ratio kept; idFromPrice(displayPrice(id)) = id',
  gen(R) {
    const kind = R.pick(['abi', 'abi', 'shape']);
    if (kind === 'abi') { const types = Array.from({ length: R.range(1, 5) }, () => randType(R)); return { kind, types, values: types.map((t) => randValue(R, t)) }; }
    return {
      kind, below: R.int(50), above: R.int(49), totalX: R.big(R.range(0, 120)), totalY: R.big(R.range(0, 120)), shape: R.pick(['spot', 'curve', 'bidask']),
      rx: R.bool(0.4) ? 0n : R.spread(100), ry: R.bool(0.4) ? 0n : R.spread(100), id: R.range(-60_000, 60_000), step: R.pick([1, 5, 10, 25, 50, 100, 250]), decX: R.range(0, 18), decY: R.range(0, 18),
    };
  },
  check(c) {
    if (c.kind === 'abi') {
      const mine = dl.encodeArgs(c.types, c.values);
      const theirs = coder.encode(c.types.map(toEthersType), c.values).slice(2);
      eq(mine, theirs, `encoding of (${c.types.map(toEthersType)})`);
      const flat = c.types.filter((t) => !Array.isArray(t) && (!t.endsWith('[]') || ['uint256[]', 'int24[]'].includes(t)));
      if (flat.length === c.types.length) {
        const back = dl.decodeWords(c.types, mine);
        c.types.forEach((t, i) => {
          const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : typeof v === 'bigint' ? v : v);
          const want = c.values[i];
          if (t.endsWith('[]')) eq(JSON.stringify(back[i].map(String)), JSON.stringify(want.map(String)), `decode ${t}`);
          else eq(String(norm(back[i])), String(norm(want)), `decode ${t}`);
        });
      }
      return;
    }
    const { below, above, totalX, totalY, shape, rx, ry } = c;
    const r = dl.distribute({ below, above, totalX, totalY, shape, activeRatio: { x: rx, y: ry } });
    const sx = r.ax.reduce((a, b) => a + b, 0n), sy = r.ay.reduce((a, b) => a + b, 0n);
    ok(sx <= totalX && sy <= totalY, 'never spends more than given');
    ok(r.deltas.every((d, i) => i === 0 || d > r.deltas[i - 1]), 'deltas strictly increasing');
    ok(r.deltas.every((d) => d >= -below && d <= above), 'deltas within range');
    r.deltas.forEach((d, i) => {
      if (d < 0) eq(r.ax[i], 0n, 'no X below the active bin');
      if (d > 0) eq(r.ay[i], 0n, 'no Y above the active bin');
      ok(r.ax[i] > 0n || r.ay[i] > 0n, 'no empty bins listed');
    });
    const i0 = r.deltas.indexOf(0);
    const x0 = i0 < 0 ? 0n : r.ax[i0], y0 = i0 < 0 ? 0n : r.ay[i0];
    if (rx > 0n && ry > 0n) { const diff = x0 * ry - y0 * rx; const m = rx > ry ? rx : ry; ok((diff < 0n ? -diff : diff) < m, 'active bin keeps its X:Y ratio'); }
    else if (rx > 0n) eq(y0, 0n, 'X-only active bin gets no Y');
    else if (ry > 0n) eq(x0, 0n, 'Y-only active bin gets no X');
    const p = dl.displayPrice(c.id, c.step, c.decX, c.decY);
    if (p > 1e-300 && p < 1e300) eq(dl.idFromPrice(p, c.step, c.decX, c.decY), c.id, 'idFromPrice(displayPrice(id))');
  },
};

// ------------------------------------------------------------------ Z6
const IFACE = new Interface(Object.keys(abi.SEL).map((s) => `function ${s}`));
function argFor(R, type) {
  if (type === 'address') return '0x' + R.hex(20);
  if (type === 'address[]') return Array.from({ length: R.range(0, 4) }, () => '0x' + R.hex(20));
  if (type === 'bool') return R.bool();
  if (type === 'bytes32') return '0x' + R.hex(32);
  return R.big(R.int(257));
}
const decStr = (R) => { const i = R.bool(0.2) ? '' : R.str(R.range(1, 20), '0123456789'); const f = R.bool(0.6) || !i ? R.str(R.range(1, 18), '0123456789') : null; return f != null ? `${i}.${f}` : i; };

export const dexAbi = {
  group: 'ZETAPHY', name: 'zetaphy/dex-abi-amounts', count: 500,
  what: 'DEX page ABI: encodeCall = ethers for every router/pair function with random args; string/uint256[] decode of ethers-encoded data; decodeError never throws on junk; parseUnits/formatUnits round trip and formatUnits = ethers (truncated, grouped)',
  gen(R) {
    const kind = R.pick(['call', 'decode', 'junk', 'units', 'units']);
    const sig = R.pick(Object.keys(abi.SEL));
    const inner = sig.slice(sig.indexOf('(') + 1, -1);
    return { kind, sig, args: inner ? inner.split(',').map((t) => argFor(R, t)) : [], str: R.str(R.int(80), 'abcXYZ 012 ฿€你😀'), arr: Array.from({ length: R.int(8) }, () => R.big(R.int(257))), junk: '0x' + R.hex(R.int(120)) + (R.bool(0.2) ? 'z' : ''), sel: R.pick(Object.keys(abi.ERRORS)), amount: decStr(R), decimals: R.range(0, 36), v: R.big(R.int(200)), maxFrac: R.range(0, 20) };
  },
  check(c) {
    if (c.kind === 'call') { eq(abi.encodeCall(c.sig, c.args), IFACE.encodeFunctionData(c.sig, c.args), `calldata for ${c.sig}`); return; }
    if (c.kind === 'decode') {
      eq(abi.decode(['string'], coder.encode(['string'], [c.str]))[0], c.str, 'string');
      eq(JSON.stringify(abi.decode(['uint256[]'], coder.encode(['uint256[]'], [c.arr]))[0].map(String)), JSON.stringify(c.arr.map(String)), 'uint256[]');
      return;
    }
    if (c.kind === 'junk') {
      for (const h of [c.junk, c.sel + c.junk.slice(2)]) { const r = abi.decodeError(h); ok(r === null || typeof r.name === 'string', 'decodeError returns null or {name}'); }
      return;
    }
    const [i, f = ''] = c.amount.split('.');
    if (f.length > c.decimals) {
      let threw = false; try { abi.parseUnits(c.amount, c.decimals); } catch { threw = true; }
      ok(threw, 'more decimals than the token has is refused');
    } else {
      const v = abi.parseUnits(c.amount, c.decimals);
      const shown = abi.formatUnits(v, c.decimals, 99).replace(/,/g, '');
      const norm = (BigInt(i || '0').toString()) + (f.replace(/0+$/, '') ? '.' + f.replace(/0+$/, '') : '');
      eq(shown, norm, `round trip of "${c.amount}" with ${c.decimals} decimals`);
    }
    // formatUnits vs ethers: truncated to maxFrac, trailing zeros dropped, thousands grouped.
    const e = ethersFormatUnits(c.v, c.decimals);
    const [ei, ef = ''] = e.split('.');
    const frac = ef.slice(0, c.maxFrac).replace(/0+$/, '');
    eq(abi.formatUnits(c.v, c.decimals, c.maxFrac), ei.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : ''), 'formatUnits vs ethers');
  },
};

export default [cpMath, dlmmLib, dexAbi];
