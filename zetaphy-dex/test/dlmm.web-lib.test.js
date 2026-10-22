// The DLMM tab's own library (web/lib/dlmm.js, no third-party code) against
// ethers and the DLMM artifacts: selectors, ABI encoding of signed ints,
// arrays and tuples, decoding, error names, bin <-> price conversions and the
// liquidity shapes (sums, single-sided rule, active-bin ratio).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { id, Interface, AbiCoder } from 'ethers';
import { DSEL, DLMM_ERRORS, encodeArgs, encodeDlmmCall, decodeWords, dlmmErrorName, rawPrice, displayPrice, idFromPrice, distribute, minAfter } from '../web/lib/dlmm.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const coder = AbiCoder.defaultAbiCoder();
const A1 = '0x' + '11'.repeat(20);
const A2 = '0x' + 'ab'.repeat(20);

test('every DLMM selector is keccak256(signature)[0..4] and exists in the contracts the page calls', () => {
  for (const [sig, sel] of Object.entries(DSEL)) assert.equal(sel, id(sig).slice(0, 10), sig);
  const fns = new Interface([...art('ZetaphyDlmmRouter').abi, ...art('ZetaphyDlmmPair').abi, ...art('ZetaphyDlmmFactory').abi, ...art('TestToken').abi]);
  for (const sig of Object.keys(DSEL)) assert.ok(fns.getFunction(sig), sig);
  const seen = new Set();
  const errs = new Interface([...art('ZetaphyDlmmRouter').abi, ...art('ZetaphyDlmmPair').abi, ...art('ZetaphyDlmmFactory').abi].filter((x) => x.type === 'error' && !seen.has(x.name) && seen.add(x.name)));
  for (const [sel, name] of Object.entries(DLMM_ERRORS)) assert.equal(errs.getError(name).selector, sel, name);
});

test('encoding matches ethers: signed ints, arrays, nested tuples (addLiquidity params, swap paths, removeLiquidity)', () => {
  const params = [A1, A2, 25, -123, 7, [-3, -1, 0, 2, 8_388_607, -8_388_607], [0n, 1n, 2n ** 255n, 5n, 6n, 7n], [9n, 0n, 1n, 2n, 3n, 4n], 10n, 0n, A1, 1_800_000_000n];
  const T = '(address,address,uint16,int24,uint24,int24[],uint256[],uint256[],uint256,uint256,address,uint256)';
  const mine = encodeArgs([['address', 'address', 'uint16', 'int24', 'uint24', 'int24[]', 'uint256[]', 'uint256[]', 'uint256', 'uint256', 'address', 'uint256']], [params]);
  assert.equal('0x' + mine, coder.encode([T], [params]));
  const iface = new Interface(art('ZetaphyDlmmRouter').abi);
  assert.equal(encodeDlmmCall(`addLiquidity(${T})`, [['address', 'address', 'uint16', 'int24', 'uint24', 'int24[]', 'uint256[]', 'uint256[]', 'uint256', 'uint256', 'address', 'uint256']], [params]), iface.encodeFunctionData('addLiquidity', [params]));
  const path = [[10, 25], [A1, A2, A1]];
  assert.equal(encodeDlmmCall('swapExactTokensForTokens(uint256,uint256,(uint16[],address[]),address,uint256)', ['uint256', 'uint256', ['uint16[]', 'address[]'], 'address', 'uint256'], [5n, 1n, path, A2, 9n]),
    iface.encodeFunctionData('swapExactTokensForTokens', [5n, 1n, path, A2, 9n]));
  assert.equal(encodeDlmmCall('removeLiquidity(address,address,uint16,int24[],uint256[],uint256,uint256,address,uint256)', ['address', 'address', 'uint16', 'int24[]', 'uint256[]', 'uint256', 'uint256', 'address', 'uint256'], [A1, A2, 10, [-1, 0, 1], [1n, 2n, 3n], 0n, 0n, A1, 1n]),
    iface.encodeFunctionData('removeLiquidity', [A1, A2, 10, [-1, 0, 1], [1n, 2n, 3n], 0n, 0n, A1, 1n]));
  assert.throws(() => encodeArgs(['int24'], [1 << 23]), /range/);
  assert.throws(() => encodeArgs(['uint16'], [-1]), /range/);
  assert.throws(() => encodeArgs(['address'], ['0x12']), /address/);
});

test('decoding: int24 (negative), bool, address, uint256[]; DLMM error names from revert data', () => {
  const hex = coder.encode(['int24', 'bool', 'address', 'uint128'], [-5, true, A2, 7n]);
  assert.deepEqual(decodeWords(['int24', 'bool', 'address', 'uint128'], hex), [-5n, true, A2, 7n]);
  assert.deepEqual(decodeWords(['uint256[]'], coder.encode(['uint256[]'], [[1n, 2n, 3n]])), [[1n, 2n, 3n]]);
  assert.deepEqual(decodeWords(['uint16[]'], coder.encode(['uint16[]'], [[1, 10, 25]])), [[1n, 10n, 25n]]);
  const err = new Interface(art('ZetaphyDlmmRouter').abi).encodeErrorResult('IdSlippage', [-4]);
  assert.equal(dlmmErrorName(err), 'IdSlippage');
  assert.equal(dlmmErrorName('0x12345678'), null);
});

test('price <-> bin: displayPrice inverts idFromPrice (decimals included); rawPrice follows (1 + step)^id', () => {
  assert.ok(Math.abs(rawPrice(100, 10) - 1.001 ** 100) < 1e-9);
  for (const [price, step, dx, dy] of [[1, 10, 18, 18], [2500, 25, 18, 6], [0.00042, 100, 6, 18], [1.5, 1, 18, 18]]) {
    const idv = idFromPrice(price, step, dx, dy);
    const back = displayPrice(idv, step, dx, dy);
    assert.ok(Math.abs(back / price - 1) <= step / 10_000, `${price} -> bin ${idv} -> ${back}`);
  }
  assert.throws(() => idFromPrice(0, 10, 18, 18));
  assert.equal(minAfter(10_000n, 50), 9_950n);
});

test('shapes: amounts sum to at most the totals, X only at or above the price and Y only at or below, the active bin in its own ratio', () => {
  for (const shape of ['spot', 'curve', 'bidask']) {
    for (const [below, above] of [[0, 0], [5, 0], [0, 5], [10, 10], [49, 50]]) {
      const totalX = 1_000_000_000_000_000_000n;
      const totalY = 777_777_777_777n;
      const d = distribute({ below, above, totalX, totalY, shape });
      const sx = d.ax.reduce((s, v) => s + v, 0n);
      const sy = d.ay.reduce((s, v) => s + v, 0n);
      assert.ok(sx <= totalX && sy <= totalY, `${shape} ${below}/${above}`);
      assert.ok(totalX - sx <= BigInt(above + 1) && totalY - sy <= BigInt(below + 1), 'rounding only');
      for (let i = 0; i < d.deltas.length; i++) {
        if (i) assert.ok(d.deltas[i] > d.deltas[i - 1], 'increasing');
        if (d.deltas[i] > 0) assert.equal(d.ay[i], 0n);
        if (d.deltas[i] < 0) assert.equal(d.ax[i], 0n);
      }
      if (shape === 'curve' && above >= 4) assert.ok(d.ax[d.deltas.indexOf(1)] > d.ax[d.deltas.indexOf(above)], 'curve: more near the price');
      if (shape === 'bidask' && above >= 4) assert.ok(d.ax[d.deltas.indexOf(1)] < d.ax[d.deltas.indexOf(above)], 'bid-ask: more away from the price');
    }
  }
  // Active bin holding 3 X : 1 Y: the active amounts keep that ratio.
  const d = distribute({ below: 2, above: 2, totalX: 3000n, totalY: 3000n, activeRatio: { x: 3n, y: 1n } });
  const i0 = d.deltas.indexOf(0);
  assert.ok(d.ax[i0] * 1n >= d.ay[i0] * 3n - 3n && d.ax[i0] * 1n <= d.ay[i0] * 3n + 3n, `${d.ax[i0]} : ${d.ay[i0]}`);
  // Only X in the active bin: no Y goes there.
  const dx = distribute({ below: 2, above: 2, totalX: 3000n, totalY: 3000n, activeRatio: { x: 5n, y: 0n } });
  assert.equal(dx.ay[dx.deltas.indexOf(0)], 0n);
  assert.throws(() => distribute({ below: 60, above: 40, totalX: 1n, totalY: 1n }), /range/);
});
