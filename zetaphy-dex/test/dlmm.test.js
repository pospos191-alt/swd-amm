// DLMM pair, factory and router (contracts/dlmm/, UNAUDITED) on the
// in-memory EVM: presets and governance, liquidity across bins, swaps inside
// one bin and across many (exact amounts against a BigInt model), exact-out
// quotes, the volatility fee, the protocol fee, multi-hop and native routes,
// share transfers, slippage and deadlines, and gas for typical swaps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDlmm, seededPair, lp, spot, path, liveBins, binSwapJS, presetTuple, PRESETS, ONE, MAX, Q128, art } from './helpers/dlmm.js';

const ZERO = '0x' + '00'.repeat(20);
const bal = (t, who) => t.call('balanceOf', [who]);

/** Expected result of an exact-in swap with a constant fee (presets without the volatility fee). */
async function expectSwap(pair, amountIn, swapForY, feeBps) {
  let id = await pair.call('getActiveId');
  let left = amountIn;
  let out = 0n;
  const bins = [];
  for (;;) {
    const [x, y] = await pair.call('getBin', [id]);
    const binOut = swapForY ? y : x;
    if (binOut > 0n) {
      const r = binSwapJS(binOut, await pair.call('getPriceFromId', [id]), feeBps, left, swapForY);
      bins.push({ id, ...r });
      left -= r.inUsed;
      out += r.out;
      if (left === 0n) break;
    }
    const [next, found] = await pair.call('getNextNonEmptyBin', [swapForY, id]);
    if (!found) break;
    id = next;
  }
  return { out, left, bins, activeId: id };
}

test('governance: presets (validated), protocol share, feeTo, two-step handover (e.g. to a TimelockController); nobody else may', async () => {
  const { factory, addr, c } = await setupDlmm();
  assert.deepEqual((await factory.call('presetSteps')).map(Number).sort((a, b) => a - b), [1, 10, 25, 100]);
  const p = PRESETS[25];
  await assert.rejects(factory.send('alice', 'setPreset', [50, presetTuple(p)]), /NotGovernance/);
  await assert.rejects(factory.send('gov', 'setPreset', [0, presetTuple(p)]), /InvalidPreset/);
  await assert.rejects(factory.send('gov', 'setPreset', [1001, presetTuple(p)]), /InvalidPreset/);
  await assert.rejects(factory.send('gov', 'setPreset', [50, presetTuple({ ...p, baseFeeBps: 1001 })]), /InvalidPreset/);
  await assert.rejects(factory.send('gov', 'setPreset', [50, presetTuple({ ...p, maxDynamicFeeBps: 1001 })]), /InvalidPreset/);
  await assert.rejects(factory.send('gov', 'setPreset', [50, presetTuple({ ...p, filterPeriod: 600 })]), /InvalidPreset/, 'filter < decay');
  await assert.rejects(factory.send('gov', 'setPreset', [50, presetTuple({ ...p, reductionFactor: 10_001 })]), /InvalidPreset/);
  await assert.rejects(factory.send('gov', 'setPreset', [50, presetTuple({ ...p, maxVolatilityAccumulator: 0 })]), /InvalidPreset/);
  await factory.send('gov', 'setPreset', [50, presetTuple(p)]);
  await factory.send('gov', 'removePreset', [50]);
  await assert.rejects(factory.send('gov', 'removePreset', [50]), /PresetNotEnabled/);
  await assert.rejects(factory.send('gov', 'setDefaultProtocolShare', [5001]), /ShareTooHigh/);
  await factory.send('gov', 'setDefaultProtocolShare', [1000]);
  await assert.rejects(factory.send('bob', 'setFeeTo', [addr('bob')]), /NotGovernance/);
  await factory.send('gov', 'setFeeTo', [addr('feeTo')]);
  // Handover: propose, then the new holder (a timelock in production) accepts.
  await assert.rejects(factory.send('bob', 'setGovernance', [addr('carol')]), /NotGovernance/);
  await factory.send('gov', 'setGovernance', [addr('carol')]);
  await assert.rejects(factory.send('bob', 'acceptGovernance'), /NotPendingGovernance/);
  assert.equal((await factory.call('governance')).toLowerCase(), addr('gov').toLowerCase(), 'unchanged until accepted');
  await factory.send('carol', 'acceptGovernance');
  assert.equal((await factory.call('governance')).toLowerCase(), addr('carol').toLowerCase());
  assert.equal(await factory.call('pendingGovernance'), ZERO);
  await assert.rejects(factory.send('gov', 'setFeeTo', [ZERO]), /NotGovernance/, 'the old governance has no power left');
  void c;
});

test('createPair: sorted tokens, one pair per (pair, bin step), enabled presets only, a starting bin with a price; the router finds it by CREATE2', async () => {
  const { factory, router, X, Y, pairAt } = await setupDlmm();
  await assert.rejects(factory.send('bob', 'createPair', [X.address, X.address, 10, 0]), /IdenticalAddresses/);
  await assert.rejects(factory.send('bob', 'createPair', [X.address, ZERO, 10, 0]), /ZeroAddress/);
  await assert.rejects(factory.send('bob', 'createPair', [X.address, Y.address, 7, 0]), /PresetNotEnabled/);
  await assert.rejects(factory.send('bob', 'createPair', [X.address, Y.address, 100, 10_000]), /PriceOutOfRange/);
  await factory.send('bob', 'createPair', [Y.address, X.address, 25, -123]);
  await assert.rejects(factory.send('bob', 'createPair', [X.address, Y.address, 25, 0]), /PairExists/);
  await factory.send('bob', 'createPair', [X.address, Y.address, 10, 0]); // another bin step: another pair
  const addr25 = await factory.call('getPair', [X.address, Y.address, 25]);
  assert.equal(addr25, await factory.call('getPair', [Y.address, X.address, 25]));
  assert.equal(addr25, await router.call('pairFor', [Y.address, X.address, 25]));
  assert.equal(await factory.call('allPairsLength'), 2n);
  const pair = pairAt(addr25);
  assert.equal((await pair.call('tokenX')).toLowerCase(), X.address.toLowerCase());
  assert.equal(await pair.call('binStep'), 25n);
  assert.equal(await pair.call('baseFeeBps'), 25n);
  assert.equal(await pair.call('variableFeeControl'), 2000n);
  assert.equal(await pair.call('getActiveId'), -123n);
  assert.equal((await pair.call('factory')).toLowerCase(), factory.address.toLowerCase());
});

test('adding a spot range: bins above the price hold X, below hold Y; first-deposit shares = x * price + y * 2^128 (exact); the bitmap lists the bins', async () => {
  const d = await setupDlmm();
  const { X, Y, addr } = d;
  const a0 = await bal(X, addr('alice'));
  const b0 = await bal(Y, addr('alice'));
  const pair = await seededPair(d, { n: 5, perBin: 100n * ONE, activeId: 7 });
  assert.equal(await pair.call('getActiveId'), 7n);
  const bins = await liveBins(pair);
  assert.deepEqual(bins.map((b) => b.id), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (const b of bins) {
    const price = await pair.call('getPriceFromId', [b.id]);
    if (b.id > 7) assert.deepEqual([b.x, b.y], [100n * ONE, 0n]);
    if (b.id < 7) assert.deepEqual([b.x, b.y], [0n, 100n * ONE]);
    assert.equal(b.supply, b.x * price + b.y * Q128, `bin ${b.id} shares`);
    assert.equal(await pair.call('balanceOf', [addr('alice'), b.id]), b.supply);
  }
  assert.equal(a0 - (await bal(X, addr('alice'))), 550n * ONE);
  assert.equal(b0 - (await bal(Y, addr('alice'))), 550n * ONE);
  assert.equal(await pair.call('reserveX'), 550n * ONE);
  assert.equal(await bal(X, pair.address), 550n * ONE);
});

test('exact-in swaps match the BigInt model to the wei: inside one bin, and across bins (X in: price down, Y in: price up); quotes equal results', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d, { n: 5, perBin: 100n * ONE });
  for (const [amt, forY] of [[ONE, true], [3n * ONE, false], [260n * ONE, true], [777n * ONE, false], [12345n, true], [1n * ONE, true]]) {
    const exp = await expectSwap(pair, amt, forY, 10n);
    const [left, qOut] = await pair.call('getSwapOut', [amt, forY]);
    assert.equal(left, 0n);
    assert.equal(qOut, exp.out, 'quote');
    const [tin, tout] = forY ? [X, Y] : [Y, X];
    const b0 = await bal(tout, addr('bob'));
    await router.send('bob', 'swapExactTokensForTokens', [amt, exp.out, path([10], [tin, tout]), addr('bob'), deadline()]);
    assert.equal((await bal(tout, addr('bob'))) - b0, exp.out);
    assert.equal(await pair.call('getActiveId'), exp.activeId, 'active bin');
    for (const b of exp.bins) {
      const [x, y] = await pair.call('getBin', [b.id]);
      assert.ok(forY ? x > 0n : y > 0n, 'the input stayed in the bin');
    }
  }
  // Reserves are the sums of the bins; the pair holds exactly them (no protocol fee).
  const bins = await liveBins(pair);
  assert.equal(bins.reduce((s, b) => s + b.x, 0n), await pair.call('reserveX'));
  assert.equal(bins.reduce((s, b) => s + b.y, 0n), await pair.call('reserveY'));
  assert.equal(await bal(X, pair.address), await pair.call('reserveX'));
  assert.equal(await bal(Y, pair.address), await pair.call('reserveY'));
});

test('exact-out: getSwapIn is the smallest input that pays the output (one wei less pays less), through the router with amountInMax', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d, { n: 5, perBin: 100n * ONE });
  for (const [want, forY] of [[ONE, true], [150n * ONE, true], [333n * ONE, false], [7n, false]]) {
    const [need, outLeft] = await pair.call('getSwapIn', [want, forY]);
    assert.equal(outLeft, 0n);
    const [, outAtNeed] = await pair.call('getSwapOut', [need, forY]);
    const [, outBelow] = await pair.call('getSwapOut', [need - 1n, forY]);
    assert.ok(outAtNeed >= want, 'enough');
    assert.ok(outBelow < want, 'minimal');
    const [tin, tout] = forY ? [X, Y] : [Y, X];
    await assert.rejects(router.send('bob', 'swapTokensForExactTokens', [want, need - 1n, path([10], [tin, tout]), addr('bob'), deadline()]), /ExcessiveInputAmount/);
    const i0 = await bal(tin, addr('bob'));
    const o0 = await bal(tout, addr('bob'));
    await router.send('bob', 'swapTokensForExactTokens', [want, need, path([10], [tin, tout]), addr('bob'), deadline()]);
    assert.equal(i0 - (await bal(tin, addr('bob'))), need);
    assert.ok((await bal(tout, addr('bob'))) - o0 >= want);
  }
  // More than the pair holds: the quote says so, the router refuses.
  const [, left] = await pair.call('getSwapIn', [10_000n * ONE, true]);
  assert.ok(left > 0n);
  await assert.rejects(router.send('bob', 'swapTokensForExactTokens', [10_000n * ONE, MAX, path([10], [X, Y]), addr('bob'), deadline()]), /InsufficientLiquidity/);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [10_000n * ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]), /OutOfLiquidity/);
});

test('fees stay in the bins they were paid in: LPs withdraw more value than they put in; the protocol share goes to feeTo', async () => {
  const d = await setupDlmm();
  const { router, factory, X, Y, addr, deadline, c } = d;
  const pair = await seededPair(d, { n: 3, perBin: 100n * ONE });
  await assert.rejects(factory.send('alice', 'setPairProtocolShare', [pair.address, 2000]), /NotGovernance/);
  await assert.rejects(factory.send('gov', 'setPairProtocolShare', [pair.address, 5001]), /ShareTooHigh/);
  await assert.rejects(factory.send('gov', 'setPairProtocolShare', [addr('bob'), 2000]), /revert|UnknownPair/);
  await factory.send('gov', 'setPairProtocolShare', [pair.address, 2000]); // 20% of the fee
  assert.equal(await pair.call('protocolShareBps'), 2000n);
  for (let i = 0; i < 6; i++) {
    await router.send('bob', 'swapExactTokensForTokens', [50n * ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]);
    await router.send('bob', 'swapExactTokensForTokens', [50n * ONE, 0, path([10], [Y, X]), addr('bob'), deadline()]);
  }
  const pX = await pair.call('protocolFeesX');
  const pY = await pair.call('protocolFeesY');
  assert.ok(pX > 0n && pY > 0n, 'protocol fees accrued');
  // The pair holds reserves + protocol fees exactly.
  assert.equal(await bal(X, pair.address), (await pair.call('reserveX')) + pX);
  assert.equal(await bal(Y, pair.address), (await pair.call('reserveY')) + pY);
  await assert.rejects(pair.send('bob', 'collectProtocolFees'), /FeeToNotSet/);
  await factory.send('gov', 'setFeeTo', [addr('feeTo')]);
  await pair.send('bob', 'collectProtocolFees'); // anyone may trigger; only feeTo receives
  assert.equal(await bal(X, addr('feeTo')), pX);
  assert.equal(await bal(Y, addr('feeTo')), pY);
  assert.equal(await pair.call('protocolFeesX'), 0n);
  // Alice takes everything out: worth more than she put in at the current price.
  const bins = await liveBins(pair);
  await pair.send('alice', 'setApprovalForAll', [router.address, true]);
  const x0 = await bal(X, addr('alice'));
  const y0 = await bal(Y, addr('alice'));
  await router.send('alice', 'removeLiquidity', [X.address, Y.address, 10, bins.map((b) => b.id), bins.map((b) => b.supply), 0, 0, addr('alice'), deadline()]);
  const gotX = (await bal(X, addr('alice'))) - x0;
  const gotY = (await bal(Y, addr('alice'))) - y0;
  const price = await pair.call('getPriceFromId', [await pair.call('getActiveId')]);
  const valueOut = (gotX * price) / Q128 + gotY;
  const valueIn = (350n * ONE * price) / Q128 + 350n * ONE;
  assert.ok(valueOut > valueIn, `LPs earned the fees: ${valueOut} > ${valueIn}`);
  assert.equal(await pair.call('reserveX'), 0n, 'pair empty');
  assert.equal((await liveBins(pair)).length, 0);
  void c;
});

test('volatility fee (swdmm_math.rs design): grows with the bins the price moved from the reference, decays after filterPeriod, resets after decayPeriod', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline, c, pairAt, factory } = d;
  const s = spot(30, 10n * ONE);
  await router.send('alice', 'addLiquidity', [lp({ X, Y, binStep: 25, activeId: 0, deltas: s.deltas, ax: s.ax, ay: s.ay, to: addr('alice'), deadline: deadline() })]);
  const pair = pairAt(await factory.call('getPair', [X.address, Y.address, 25]));
  const feeOf = async (amt, forY) => (await pair.call('getSwapOut', [amt, forY]))[2];
  const small = ONE / 100n;
  const f0 = await feeOf(small, true);
  assert.equal(f0, (small * 25n + 9_999n) / 10_000n, 'at rest: base fee only (25 bps)');
  // A swap crossing ~10 bins: the accumulator holds |10| * 25 bps.
  await router.send('bob', 'swapExactTokensForTokens', [100n * ONE, 0, path([25], [X, Y]), addr('bob'), deadline()]);
  const moved = -Number(await pair.call('getActiveId'));
  assert.ok(moved >= 9, `moved ${moved} bins`);
  const [acc] = await pair.call('getVolatility');
  assert.equal(acc, BigInt(moved * 25));
  // Right after (inside filterPeriod, same reference bin), the next swap pays base + acc * 2000 / 10000 bps, capped at +100 bps.
  const varBps = BigInt(Math.min((moved * 25 * 2000) / 10_000, 100));
  const f1 = await feeOf(small, true);
  assert.equal(f1, (small * (25n + varBps) + 9_999n) / 10_000n, 'volatile: higher fee');
  // After filterPeriod (30 s) the reference moves to the current bin and half the volatility is carried.
  c.advance(60);
  const f2 = await feeOf(small, true);
  const carried = BigInt(moved * 25) * 5_000n / 10_000n;
  const v2 = (carried * 2000n) / 10_000n > 100n ? 100n : (carried * 2000n) / 10_000n;
  assert.equal(f2, (small * (25n + v2) + 9_999n) / 10_000n, 'decayed by reductionFactor');
  // After decayPeriod (600 s) without swaps: back to the base fee.
  c.advance(700);
  assert.equal(await feeOf(small, true), f0);
  // The fee is charged per bin as the swap walks: a big swap pays a higher average rate than a small one.
  const [, , feeBig] = await pair.call('getSwapOut', [150n * ONE, false]);
  assert.ok(feeBig * 10_000n > 150n * ONE * 25n, 'more than the base rate over many bins');
});

test('removing: needs the pair approval; bounded by amountXMin / amountYMin; partial removal; shares move with batchTransferFrom', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d, { n: 2, perBin: 10n * ONE });
  const ids = [-2, -1, 0, 1, 2];
  const sh = await Promise.all(ids.map((id) => pair.call('balanceOf', [addr('alice'), id])));
  await assert.rejects(router.send('alice', 'removeLiquidity', [X.address, Y.address, 10, ids, sh, 0, 0, addr('alice'), deadline()]), /NotApproved/);
  await pair.send('alice', 'setApprovalForAll', [router.address, true]);
  const half = sh.map((s) => s / 2n);
  await assert.rejects(router.send('alice', 'removeLiquidity', [X.address, Y.address, 10, ids, half, 13n * ONE, 0, addr('alice'), deadline()]), /InsufficientXAmount/);
  await assert.rejects(router.send('alice', 'removeLiquidity', [Y.address, X.address, 10, ids, half, 0, 0, addr('alice'), deadline()]), /UnsortedTokens/);
  await assert.rejects(router.send('alice', 'removeLiquidity', [X.address, Y.address, 10, ids, half, 0, 0, addr('alice'), 1]), /Expired/);
  const x0 = await bal(X, addr('carol'));
  await router.send('alice', 'removeLiquidity', [X.address, Y.address, 10, ids, half, 12n * ONE, 12n * ONE, addr('carol'), deadline()]);
  assert.equal((await bal(X, addr('carol'))) - x0, 12n * ONE + ONE / 2n, 'half of 25 X');
  // Shares are transferable (the ledger has no receiver callbacks).
  await assert.rejects(pair.send('bob', 'batchTransferFrom', [addr('alice'), addr('bob'), [0], [1n]]), /NotApproved/);
  await pair.send('alice', 'batchTransferFrom', [addr('alice'), addr('bob'), [0], [sh[2] - half[2]]]);
  assert.equal(await pair.call('balanceOf', [addr('bob'), 0]), sh[2] - half[2]);
  await assert.rejects(pair.send('alice', 'batchTransferFrom', [addr('alice'), addr('bob'), [0], [1n]]), /InsufficientShares/);
  const yb = await bal(Y, addr('bob'));
  await pair.send('bob', 'burn', [addr('bob'), addr('bob'), [0], [sh[2] - half[2]]]);
  assert.equal((await bal(Y, addr('bob'))) - yb, 5n * ONE / 2n);
});

test('the active bin takes only amounts in its own X:Y ratio (the rest comes back); a range slipped beyond idSlippage is refused', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d, { n: 2, perBin: 10n * ONE });
  // Move the price inside bin 0: it now holds more X than Y.
  await router.send('bob', 'swapExactTokensForTokens', [2n * ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]);
  const [bx, by] = await pair.call('getBin', [0]);
  const x0 = await bal(X, addr('carol'));
  const y0 = await bal(Y, addr('carol'));
  await router.send('carol', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, deltas: [0], ax: [ONE], ay: [ONE], to: addr('carol'), deadline: deadline() })]);
  const paidX = x0 - (await bal(X, addr('carol')));
  const paidY = y0 - (await bal(Y, addr('carol')));
  assert.equal(paidX, ONE, 'X is the scarce side here: all of it');
  assert.ok(paidY < ONE, 'Y: only the ratio');
  assert.ok(paidY * bx <= paidX * by + bx, 'paid in the bin ratio (rounded up)');
  // Only Y into a bin holding both: zero shares, refused.
  await assert.rejects(router.send('carol', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, deltas: [0], ax: [0n], ay: [ONE], to: addr('carol'), deadline: deadline() })]), /ZeroShares/);
  // Price moved two bins down: idSlippage 1 refuses, 2 accepts (the shape moves with the price).
  await router.send('bob', 'swapExactTokensForTokens', [25n * ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]);
  const act = Number(await pair.call('getActiveId'));
  assert.ok(act <= -2);
  const dist = { deltas: [1, 2], ax: [ONE, ONE], ay: [0n, 0n] };
  await assert.rejects(router.send('carol', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: act + 2, slip: 1, ...dist, to: addr('carol'), deadline: deadline() })]), /IdSlippage/);
  await router.send('carol', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: act + 2, slip: 2, ...dist, to: addr('carol'), deadline: deadline() })]);
  assert.ok((await pair.call('balanceOf', [addr('carol'), act + 1])) > 0n);
  await assert.rejects(router.send('carol', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: act, ...dist, minX: 3n * ONE, to: addr('carol'), deadline: deadline() })]), /InsufficientXAmount/);
  await assert.rejects(router.send('carol', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: act, ...dist, to: addr('carol'), deadline: 1n })]), /Expired/);
  await assert.rejects(router.send('carol', 'addLiquidity', [lp({ X: Y, Y: X, binStep: 10, activeId: act, ...dist, to: addr('carol'), deadline: deadline() })]), /UnsortedTokens/);
});

test('multi-hop X -> Y -> Z (exact in and exact out) and native routes (WZETAPHY): the router keeps nothing', async () => {
  const d = await setupDlmm();
  const { router, factory, X, Y, Z, weth, addr, deadline, c, pairAt } = d;
  await seededPair(d, { n: 5, perBin: 100n * ONE });
  const sortP = (a, b) => (BigInt(a.address) < BigInt(b.address) ? [a, b] : [b, a]);
  const [yz0, yz1] = sortP(Y, Z);
  const s = spot(5, 100n * ONE);
  await router.send('alice', 'addLiquidity', [lp({ X: yz0, Y: yz1, binStep: 25, activeId: 0, deltas: s.deltas, ax: s.ax, ay: s.ay, to: addr('alice'), deadline: deadline() })]);
  const p3 = path([10, 25], [X, Y, Z]);
  const amounts = await router.call('getAmountsOut', [5n * ONE, p3]);
  const z0 = await bal(Z, addr('bob'));
  await router.send('bob', 'swapExactTokensForTokens', [5n * ONE, amounts[2], p3, addr('bob'), deadline()]);
  assert.equal((await bal(Z, addr('bob'))) - z0, amounts[2]);
  const ins = await router.call('getAmountsIn', [3n * ONE, p3]);
  const x0 = await bal(X, addr('bob'));
  await router.send('bob', 'swapTokensForExactTokens', [3n * ONE, ins[0], p3, addr('bob'), deadline()]);
  assert.equal(x0 - (await bal(X, addr('bob'))), ins[0]);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10, 7], [X, Y, Z]), addr('bob'), deadline()]), /PairNotFound/);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [[10], [X.address]], addr('bob'), deadline()]), /InvalidPath/);

  // Native: X / WZETAPHY pair with native liquidity.
  const W = weth.address;
  const [n0, n1] = BigInt(X.address) < BigInt(W) ? [X.address, W] : [W, X.address];
  const sn = spot(4, 10n * ONE);
  const sumNative = (n0 === W ? sn.ax : sn.ay).reduce((a, b) => a + b, 0n);
  await assert.rejects(router.send('alice', 'addLiquidityNATIVE', [lp({ X: n0, Y: n1, binStep: 10, activeId: 0, ...sn, to: addr('alice'), deadline: deadline() })], sumNative - 1n), /WrongNativeAmount/);
  await router.send('alice', 'addLiquidityNATIVE', [lp({ X: n0, Y: n1, binStep: 10, activeId: 0, ...sn, to: addr('alice'), deadline: deadline() })], sumNative);
  const np = pairAt(await factory.call('getPair', [X.address, W, 10]));
  const pn = path([10], [W, X]);
  const xb = await bal(X, addr('bob'));
  await router.send('bob', 'swapExactNATIVEForTokens', [0, pn, addr('bob'), deadline()], ONE);
  assert.ok((await bal(X, addr('bob'))) > xb);
  const nb = await c.balance('bob');
  await router.send('bob', 'swapExactTokensForNATIVE', [ONE, 0, path([10], [X, W]), addr('bob'), deadline()]);
  assert.ok((await c.balance('bob')) > nb, 'native received (gas is free in the test chain)');
  const need = (await np.call('getSwapIn', [ONE / 2n, BigInt(W) < BigInt(X.address)]))[0];
  const before = await c.balance('bob');
  await router.send('bob', 'swapNATIVEForExactTokens', [ONE / 2n, pn, addr('bob'), deadline()], 5n * ONE);
  assert.equal(before - (await c.balance('bob')), need, 'only what was needed; the rest refunded');
  await router.send('bob', 'swapTokensForExactNATIVE', [ONE / 3n, 10n * ONE, path([10], [X, W]), addr('bob'), deadline()]);
  // Remove native liquidity: native comes back as native.
  await np.send('alice', 'setApprovalForAll', [router.address, true]);
  const ids = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
  const sh = await Promise.all(ids.map((id) => np.call('balanceOf', [addr('alice'), id])));
  const na = await c.balance('alice');
  await router.send('alice', 'removeLiquidityNATIVE', [X.address, 10, ids, sh, 0, 0, addr('alice'), deadline()]);
  assert.ok((await c.balance('alice')) > na);
  assert.equal(await c.balance(router.address), 0n, 'no native left in the router');
  assert.equal(await bal(weth, router.address), 0n);
  for (const t of [X, Y, Z]) assert.equal(await bal(t, router.address), 0n);
  // Native only comes into the router from WZETAPHY.
  await assert.rejects(router.sendValue('bob', 1n), /OnlyWNative/);
});

test('first LP sets the price: while a pair holds nothing anyone may move its active bin, the router does it atomically with the deposit; never once it holds liquidity', async () => {
  const d = await setupDlmm();
  const { router, factory, X, Y, addr, deadline, pairAt } = d;
  await factory.send('mallory', 'createPair', [X.address, Y.address, 10, 4_000]); // a far-off price
  const pair = pairAt(await factory.call('getPair', [X.address, Y.address, 10]));
  await pair.send('mallory', 'setActiveIdWhileEmpty', [-4_000]);
  assert.equal(await pair.call('getActiveId'), -4000n);
  await assert.rejects(pair.send('mallory', 'setActiveIdWhileEmpty', [1 << 22]), /PriceOutOfRange/);
  // Alice adds with activeIdDesired = 0, idSlippage 0: the router sets 0 first, then deposits.
  const s = spot(2, 10n * ONE);
  await router.send('alice', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, ...s, to: addr('alice'), deadline: deadline() })]);
  assert.equal(await pair.call('getActiveId'), 0n);
  await assert.rejects(pair.send('mallory', 'setActiveIdWhileEmpty', [5]), /NotEmpty/);
});

test('gas: typical swaps through the router (execution gas, excluding the 21,000 base and calldata)', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline, c } = d;
  const s = spot(60, 10n * ONE);
  // Two adds of 61 bins each (MAX_BINS_PER_CALL is 100).
  const half = (lo, hi) => ({ deltas: s.deltas.slice(lo, hi), ax: s.ax.slice(lo, hi), ay: s.ay.slice(lo, hi) });
  const add1 = await c.rawSend(addr('alice'), router.address, router.iface.encodeFunctionData('addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, ...half(0, 61), to: addr('alice'), deadline: deadline() })]));
  assert.ok(add1.ok);
  const add2 = await c.rawSend(addr('alice'), router.address, router.iface.encodeFunctionData('addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, ...half(61, 121), to: addr('alice'), deadline: deadline() })]));
  assert.ok(add2.ok);
  const gas = async (amt, forY) => {
    const [tin, tout] = forY ? [X, Y] : [Y, X];
    const before = await d.pairAt(await d.factory.call('getPair', [X.address, Y.address, 10])).call('getActiveId');
    const r = await c.rawSend(addr('bob'), router.address, router.iface.encodeFunctionData('swapExactTokensForTokens', [amt, 1, path([10], [tin, tout]), addr('bob'), deadline()]));
    assert.ok(r.ok, `swap ${amt}`);
    const after = await d.pairAt(await d.factory.call('getPair', [X.address, Y.address, 10])).call('getActiveId');
    return { gas: Number(r.gasUsed), bins: Math.abs(Number(after - before)) + 1 };
  };
  const g = {};
  g.inside = await gas(ONE, true); // first swap: cold storage
  g.inside2 = await gas(ONE, true);
  g.cross5 = await gas(50n * ONE, false);
  g.cross20 = await gas(200n * ONE, true);
  g.cross50 = await gas(500n * ONE, false);
  console.log(`  add 61 bins: ${add1.gasUsed} gas; ${JSON.stringify(g)}`);
  assert.ok(g.inside2.gas < 90_000, 'a swap inside one bin');
  assert.ok(g.cross50.gas < 2_000_000, '50 bins');
});

test('artifacts: DLMM contracts stay under EIP-170; the router derives pair addresses from the deployer and code hash', async () => {
  for (const n of ['ZetaphyDlmmFactory', 'ZetaphyDlmmPair', 'ZetaphyDlmmRouter', 'ZetaphyDlmmPairDeployer']) {
    const a = art(n);
    assert.ok((a.deployedBytecode.length - 2) / 2 <= 24576, n);
  }
  const { factory } = await setupDlmm();
  const { keccak256 } = await import('ethers');
  assert.equal(await factory.call('PAIR_CODE_HASH'), keccak256(art('ZetaphyDlmmPair').bytecode));
});
