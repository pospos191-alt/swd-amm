// DLMM regression tests (contracts/dlmm/, UNAUDITED). The first group mirrors
// the regression suite of our Solana DLMM case by case ("ported:"); the second
// covers EVM-specific properties: reentrancy, donations, fee-on-transfer and
// rebasing tokens, extreme bins, the bin-crossing bound, first-deposit share
// pricing, and governance limits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { setupDlmm, seededPair, lp, spot, path, liveBins, art, wrap, ONE, MAX } from './helpers/dlmm.js';

const bal = (t, who) => t.call('balanceOf', [who]);
const LOCKED = new Interface(art('ZetaphyDlmmPair').abi).getError('Locked').selector;

/** Sends `amountIn` of tokenIn straight to the pair and calls swap (no router). */
async function directSwap(d, pair, who, tokenIn, amountIn, swapForY) {
  await tokenIn.send(who, 'transfer', [pair.address, amountIn]);
  return pair.send(who, 'swap', [swapForY, d.addr(who)]);
}

// ---------------------------------------------------------------------------
// Ported from the Solana DLMM regression suite
// ---------------------------------------------------------------------------

test('ported: baseline honest swap works', async () => {
  const d = await setupDlmm();
  await seededPair(d);
  const y0 = await bal(d.Y, d.addr('bob'));
  await d.router.send('bob', 'swapExactTokensForTokens', [ONE, 1, path([10], [d.X, d.Y]), d.addr('bob'), d.deadline()]);
  assert.ok((await bal(d.Y, d.addr('bob'))) > y0);
});

test('ported: excess Y offered to the active bin is not taken (refunded); deposit + withdraw returns no more than paid', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d, { n: 5, perBin: 10n * ONE });
  const x0 = await bal(X, addr('carol'));
  const y0 = await bal(Y, addr('carol'));
  await router.send('carol', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, deltas: [0], ax: [ONE], ay: [3n * ONE], to: addr('carol'), deadline: deadline() })]);
  const paidX = x0 - (await bal(X, addr('carol')));
  const paidY = y0 - (await bal(Y, addr('carol')));
  assert.ok(paidY <= ONE + 1n, `paid ${paidY} Y for a 1:1 bin`);
  const shares = await pair.call('balanceOf', [addr('carol'), 0]);
  await pair.send('carol', 'burn', [addr('carol'), addr('carol'), [0], [shares]]);
  assert.ok((await bal(X, addr('carol'))) <= x0 && (await bal(Y, addr('carol'))) <= y0, 'the round trip created no tokens');
  assert.ok(x0 - (await bal(X, addr('carol'))) <= 1n && y0 - (await bal(Y, addr('carol'))) <= 1n, 'and lost at most rounding');
  void paidX;
});

test('ported: draining the last bin exactly leaves the active bin on a priced bin with liquidity; the pool keeps trading the other way', async () => {
  const d = await setupDlmm();
  const { router, factory, addr, deadline, pairAt, token } = d;
  // Near the lowest price one wei of Y costs ~2^96 X: tokens with a large supply.
  const t1 = await token('Huge A', 'HGA', 0, 1n << 200n);
  const t2 = await token('Huge B', 'HGB', 0, 1n << 200n);
  const [X, Y] = BigInt(t1.address) < BigInt(t2.address) ? [t1, t2] : [t2, t1];
  for (const t of [X, Y]) { await t.send('alice', 'approve', [router.address, MAX]); await t.send('alice', 'transfer', [addr('bob'), 1n << 190n]); await t.send('bob', 'approve', [router.address, MAX]); }
  // Bin step 100: the lowest priced bin is about -6687. Liquidity sits in the
  // five lowest bins only, far below the active bin.
  let edge = -6600;
  const h = await d.c.deployRaw(art('DlmmMathHarness'), [], 'gov');
  while (true) { try { await h.call('price', [edge - 1, 100]); edge -= 1; } catch { break; } }
  await factory.send('alice', 'createPair', [X.address, Y.address, 100, 0]);
  const pair = pairAt(await factory.call('getPair', [X.address, Y.address, 100]));
  const deltas = [edge, edge + 1, edge + 2, edge + 3, edge + 4];
  await router.send('alice', 'addLiquidity', [lp({ X, Y, binStep: 100, activeId: 0, deltas, ax: deltas.map(() => 0n), ay: deltas.map(() => 10n ** 6n), to: addr('alice'), deadline: deadline() })]);
  // Walk the price down bin by bin with exact drains, down to the edge bin.
  for (const id of [edge + 4, edge + 3, edge + 2, edge + 1, edge]) {
    const [, y] = await pair.call('getBin', [id]);
    const [need] = await pair.call('getSwapIn', [y, true]);
    await directSwap(d, pair, 'alice', X, need, true);
    assert.equal(Number(await pair.call('getActiveId')), id);
    assert.equal((await pair.call('getBin', [id]))[1], 0n, `bin ${id} drained`);
  }
  // Nothing left below: more X in is refused, the active bin stays where it is.
  await X.send('bob', 'transfer', [pair.address, ONE]);
  await assert.rejects(pair.send('bob', 'swap', [true, addr('bob')]), /OutOfLiquidity/);
  await pair.send('bob', 'skim', [addr('bob')]);
  assert.equal(Number(await pair.call('getActiveId')), edge);
  await pair.call('getPriceFromId', [edge]);
  // The other direction works.
  const x0 = await bal(X, addr('bob'));
  await router.send('bob', 'swapExactTokensForTokens', [10n, 1, path([100], [Y, X]), addr('bob'), deadline()]);
  assert.ok((await bal(X, addr('bob'))) > x0);
});

test('ported: a pair (or a bin) whose price is outside the range is refused at creation, on setActiveIdWhileEmpty and on deposit', async () => {
  const d = await setupDlmm();
  const { router, factory, X, Y, addr, deadline, pairAt } = d;
  await assert.rejects(factory.send('mallory', 'createPair', [X.address, Y.address, 100, 7_000]), /PriceOutOfRange/);
  await assert.rejects(factory.send('mallory', 'createPair', [X.address, Y.address, 100, -7_000]), /PriceOutOfRange/);
  await factory.send('mallory', 'createPair', [X.address, Y.address, 100, 6_000]);
  const pair = pairAt(await factory.call('getPair', [X.address, Y.address, 100]));
  await assert.rejects(pair.send('mallory', 'setActiveIdWhileEmpty', [7_000]), /PriceOutOfRange/);
  await assert.rejects(router.send('alice', 'addLiquidity', [lp({ X, Y, binStep: 100, activeId: 6_000, deltas: [1_000], ax: [ONE], ay: [0n], to: addr('alice'), deadline: deadline() })]), /PriceOutOfRange/);
});

test("ported: removing someone else's position is refused (no approval)", async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d);
  const ids = [-1, 0, 1];
  const sh = await Promise.all(ids.map((id) => pair.call('balanceOf', [addr('alice'), id])));
  await assert.rejects(pair.send('mallory', 'burn', [addr('alice'), addr('mallory'), ids, sh]), /NotApproved/);
  // Through the router: it burns the caller's own shares only.
  await pair.send('mallory', 'setApprovalForAll', [router.address, true]);
  await assert.rejects(router.send('mallory', 'removeLiquidity', [X.address, Y.address, 10, ids, sh, 0, 0, addr('mallory'), deadline()]), /InsufficientShares/);
  // Alice approved the router: still only she can make it burn hers.
  await pair.send('alice', 'setApprovalForAll', [router.address, true]);
  await assert.rejects(router.send('mallory', 'removeLiquidity', [X.address, Y.address, 10, ids, sh, 0, 0, addr('mallory'), deadline()]), /InsufficientShares/);
});

test('ported: shares of one pair mean nothing on another pair', async () => {
  const d = await setupDlmm();
  const { router, factory, X, Y, addr, deadline, pairAt } = d;
  await seededPair(d, { binStep: 10 });
  const s = spot(5, 100n * ONE);
  await router.send('bob', 'addLiquidity', [lp({ X, Y, binStep: 25, activeId: 0, ...s, to: addr('bob'), deadline: deadline() })]);
  const p1 = pairAt(await factory.call('getPair', [X.address, Y.address, 10]));
  const p2 = pairAt(await factory.call('getPair', [X.address, Y.address, 25]));
  const sh = await p1.call('balanceOf', [addr('alice'), 0]);
  await assert.rejects(p2.send('alice', 'burn', [addr('alice'), addr('alice'), [0], [sh]]), /InsufficientShares/);
});

test('ported: removing one share more than owned is refused', async () => {
  const d = await setupDlmm();
  const pair = await seededPair(d);
  const sh = await pair.call('balanceOf', [d.addr('alice'), 0]);
  await assert.rejects(pair.send('alice', 'burn', [d.addr('alice'), d.addr('alice'), [0], [sh + 1n]]), /InsufficientShares/);
  await assert.rejects(pair.send('alice', 'burn', [d.addr('alice'), d.addr('alice'), [0, 0], [sh, 1n]]), /InsufficientShares/, 'nor by listing a bin twice');
});

test('ported: no substitution: the router derives every pair itself; input sent to one pair cannot be swapped on another; governance acts only on its own pairs', async () => {
  const d = await setupDlmm();
  const { router, factory, X, Y, Z, addr, deadline, pairAt, c, weth } = d;
  const p1 = await seededPair(d, { binStep: 10 });
  const s = spot(5, 100n * ONE);
  await router.send('alice', 'addLiquidity', [lp({ X, Y, binStep: 25, activeId: 0, ...s, to: addr('alice'), deadline: deadline() })]);
  const p2 = pairAt(await factory.call('getPair', [X.address, Y.address, 25]));
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10], [X, Z]), addr('bob'), deadline()]), /PairNotFound/);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([1], [X, Y]), addr('bob'), deadline()]), /PairNotFound/);
  await X.send('mallory', 'transfer', [p1.address, ONE]);
  await assert.rejects(p2.send('mallory', 'swap', [true, addr('mallory')]), /InsufficientAmountIn/);
  // A pair made by another factory is not this governance's to configure.
  const f2 = await c.deployRaw(art('ZetaphyDlmmFactory'), [addr('mallory')], 'mallory');
  await f2.send('mallory', 'setPreset', [10, [10, 0, 0, 0, 0, 0, 0, true]]);
  await f2.send('mallory', 'createPair', [X.address, Y.address, 10, 0]);
  const foreign = await f2.call('getPair', [X.address, Y.address, 10]);
  await assert.rejects(factory.send('gov', 'setPairProtocolShare', [foreign, 100]), /UnknownPair/);
  await assert.rejects(wrap(c, foreign, art('ZetaphyDlmmPair')).send('mallory', 'setProtocolShare', [100]), /NotFactory/);
  void weth;
});

test('ported: bad ranges and the single-sided rule', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d);
  const add = (deltas, ax, ay) => router.send('bob', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, deltas, ax, ay, to: addr('bob'), deadline: deadline() })]);
  await assert.rejects(add([1], [ONE], [ONE]), /SingleSidedViolation/, 'Y into a bin above the price');
  await assert.rejects(add([-1], [ONE], [0n]), /SingleSidedViolation/, 'X into a bin below the price');
  const wide = Array.from({ length: 101 }, (_, i) => i + 1);
  await assert.rejects(add(wide, wide.map(() => ONE), wide.map(() => 0n)), /InvalidLength/, 'over MAX_BINS_PER_CALL');
  await assert.rejects(add([3, 2], [ONE, ONE], [0n, 0n]), /IdsNotSorted/, 'unsorted');
  await assert.rejects(add([2, 2], [ONE, ONE], [0n, 0n]), /IdsNotSorted/, 'a bin twice');
  await assert.rejects(add([2], [ONE, ONE], [0n]), /InvalidLength/, 'lengths differ');
  await assert.rejects(add([], [], []), /InvalidLength/);
  await assert.rejects(add([2], [0n], [0n]), /ZeroAmount/, 'nothing to deposit');
  // An empty bin's first deposit may be 1 wei: its shares (2^128 per wei of Y) cannot be inflated (see the first-depositor test).
  await add([-30], [0n], [1n]);
  assert.equal(await pair.call('balanceOf', [addr('bob'), -30]), 1n << 128n);
});

test("ported: nobody can spend another wallet's tokens or shares", async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d);
  await pair.send('alice', 'setApprovalForAll', [router.address, true]);
  // Router functions take tokens from msg.sender only; there is no `from`.
  const a0 = await bal(X, addr('alice'));
  await router.send('mallory', 'swapExactTokensForTokens', [ONE, 0, path([10], [X, Y]), addr('mallory'), deadline()]);
  assert.equal(await bal(X, addr('alice')), a0);
  await assert.rejects(pair.send('mallory', 'batchTransferFrom', [addr('alice'), addr('mallory'), [0], [1n]]), /NotApproved/);
  // Approval can be withdrawn.
  await pair.send('alice', 'setApprovalForAll', [router.address, false]);
  await assert.rejects(router.send('alice', 'removeLiquidity', [X.address, Y.address, 10, [0], [1n], 0, 0, addr('alice'), deadline()]), /NotApproved/);
});

test('ported: dust swaps back and forth gain nothing', async () => {
  const d = await setupDlmm(['dust']);
  const { X, Y, addr } = d;
  const pair = await seededPair(d);
  await X.send('alice', 'transfer', [addr('dust'), 1000n]);
  await Y.send('alice', 'transfer', [addr('dust'), 1000n]);
  for (let i = 0; i < 20; i++) {
    const forY = i % 2 === 0;
    await directSwap(d, pair, 'dust', forY ? X : Y, 3n, forY).catch(async (e) => {
      assert.match(e.message, /InsufficientAmountOut/);
      await pair.send('dust', 'skim', [addr('dust')]); // take the dust back
    });
  }
  const total = (await bal(X, addr('dust'))) + (await bal(Y, addr('dust')));
  assert.ok(total <= 2000n, `dust round trips: 2000 -> ${total}`);
});

test('ported: deposit then withdraw (odd amounts, a 7-wei bin) returns no more than paid', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d);
  const x0 = await bal(X, addr('carol'));
  const y0 = await bal(Y, addr('carol'));
  await router.send('carol', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, deltas: [2, 3, 4], ax: [1_234_567n, 7n, 999_999n], ay: [0n, 0n, 0n], to: addr('carol'), deadline: deadline() })]);
  const sh = await Promise.all([2, 3, 4].map((id) => pair.call('balanceOf', [addr('carol'), id])));
  await pair.send('carol', 'burn', [addr('carol'), addr('carol'), [2, 3, 4], sh]);
  assert.ok((await bal(X, addr('carol'))) <= x0 && (await bal(Y, addr('carol'))) <= y0);
});

// ---------------------------------------------------------------------------
// EVM-specific
// ---------------------------------------------------------------------------

test('first depositor: a 1-wei position, shrunk to its last share, prices the next deposit at most 1 wei off', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline } = d;
  const pair = await seededPair(d, { n: 2 });
  // Mallory owns a bin below the price alone, then burns all but one share.
  await router.send('mallory', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, deltas: [-40], ax: [0n], ay: [ONE], to: addr('mallory'), deadline: deadline() })]);
  const s = await pair.call('balanceOf', [addr('mallory'), -40]);
  await pair.send('mallory', 'burn', [addr('mallory'), addr('mallory'), [-40], [s - 1n]]);
  const [, ry] = await pair.call('getBin', [-40]);
  assert.ok(ry <= 1n, 'one share is worth at most 1 wei');
  // Donations do not reach a bin.
  await Y.send('mallory', 'transfer', [pair.address, 10n ** 6n * ONE]);
  assert.equal((await pair.call('getBin', [-40]))[1], ry);
  await pair.send('mallory', 'skim', [addr('mallory')]);
  // Carol deposits an odd amount and withdraws it at once.
  const y0 = await bal(Y, addr('carol'));
  const amt = 10n ** 18n + 12_345n;
  await router.send('carol', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, deltas: [-40], ax: [0n], ay: [amt], to: addr('carol'), deadline: deadline() })]);
  const cs = await pair.call('balanceOf', [addr('carol'), -40]);
  await pair.send('carol', 'burn', [addr('carol'), addr('carol'), [-40], [cs]]);
  const lost = y0 - (await bal(Y, addr('carol')));
  assert.ok(lost <= 1n, `the depositor lost ${lost} wei`);
});

test('reentrancy: a token that calls back into the pair while the pair sends it meets Locked() on every entry point', async () => {
  const d = await setupDlmm();
  const { router, factory, X, addr, deadline, c, pairAt } = d;
  const re = await c.deployRaw(art('DlmmReentrantToken'), [10n ** 30n], 'alice');
  await re.send('alice', 'approve', [router.address, MAX]);
  await factory.send('gov', 'setFeeTo', [addr('feeTo')]);
  const [tx, ty] = BigInt(re.address) < BigInt(X.address) ? [re, X] : [X, re];
  const s = spot(3, 100n * ONE);
  await router.send('alice', 'addLiquidity', [lp({ X: tx, Y: ty, binStep: 10, activeId: 0, ...s, to: addr('alice'), deadline: deadline() })]);
  const pair = pairAt(await factory.call('getPair', [tx.address, ty.address, 10]));
  for (let mode = 1; mode <= 6; mode++) {
    await re.send('alice', 'arm', [pair.address, mode]);
    // Removing a little liquidity makes the pair send `re` out.
    const parts = await Promise.all([-1, 1].map(async (id) => (await pair.call('balanceOf', [addr('alice'), id])) / 100n));
    await pair.send('alice', 'burn', [addr('alice'), addr('alice'), [-1, 1], parts]);
    assert.equal(await re.call('lastRevert'), LOCKED, `mode ${mode} hit the lock`);
  }
  assert.equal(await re.call('attempts'), 6n);
});

test('donations: tokens sent straight to the pair never change a bin, the active bin or a quote; the next caller or skim() gets them', async () => {
  const d = await setupDlmm();
  const { X, Y, addr } = d;
  const pair = await seededPair(d);
  const before = await liveBins(pair);
  const q0 = [...(await pair.call('getSwapOut', [5n * ONE, true]))];
  await X.send('mallory', 'transfer', [pair.address, 1000n * ONE]);
  await Y.send('mallory', 'transfer', [pair.address, 1000n * ONE]);
  assert.deepEqual(await liveBins(pair), before);
  assert.equal(await pair.call('getActiveId'), 0n);
  assert.deepEqual([...(await pair.call('getSwapOut', [5n * ONE, true]))], q0);
  assert.equal(await pair.call('reserveX'), 550n * ONE);
  const x0 = await bal(X, addr('bob'));
  await pair.send('bob', 'skim', [addr('bob')]);
  assert.equal((await bal(X, addr('bob'))) - x0, 1000n * ONE);
  assert.equal(await bal(X, pair.address), 550n * ONE);
});

test('fee-on-transfer tokens are refused by the router (adding and swapping in)', async () => {
  const d = await setupDlmm();
  const { router, X, addr, deadline, token, factory } = d;
  const fot = await token('Fee Token', 'FOT', 100);
  await fot.send('alice', 'approve', [router.address, MAX]);
  const [tx, ty] = BigInt(fot.address) < BigInt(X.address) ? [fot, X] : [X, fot];
  const s = spot(2, 10n * ONE);
  await assert.rejects(router.send('alice', 'addLiquidity', [lp({ X: tx, Y: ty, binStep: 10, activeId: 0, ...s, to: addr('alice'), deadline: deadline() })]), /FeeOnTransferNotSupported/);
  // A pair seeded without the router still cannot be swapped into with it.
  await factory.send('alice', 'createPair', [tx.address, ty.address, 10, 0]);
  await assert.rejects(router.send('alice', 'swapExactTokensForTokens', [ONE, 0, path([10], [fot, X]), addr('alice'), deadline()]), /FeeOnTransferNotSupported/);
});

test('rebasing tokens: after a negative rebase the pair refuses to pay out more than it holds (BalanceBelowReserves); a positive one is skim-able surplus', async () => {
  const d = await setupDlmm();
  const { router, X, addr, deadline, c, factory, pairAt } = d;
  const rb = await c.deployRaw(art('DlmmRebaseToken'), [10n ** 30n], 'alice');
  await rb.send('alice', 'approve', [router.address, MAX]);
  const rbIsX = BigInt(rb.address) < BigInt(X.address);
  const [tx, ty] = rbIsX ? [rb, X] : [X, rb];
  const s = spot(3, 100n * ONE);
  await router.send('alice', 'addLiquidity', [lp({ X: tx, Y: ty, binStep: 10, activeId: 0, ...s, to: addr('alice'), deadline: deadline() })]);
  const pair = pairAt(await factory.call('getPair', [tx.address, ty.address, 10]));
  await rb.send('alice', 'rebase', [10n ** 18n / 2n]); // every balance halves
  // Buying rb (rb out): refused.
  await X.send('bob', 'transfer', [pair.address, 50n * ONE]);
  await assert.rejects(pair.send('bob', 'swap', [!rbIsX, addr('bob')]), /BalanceBelowReserves/);
  await pair.send('bob', 'skim', [addr('bob')]);
  // Up again (x3): the surplus is not part of any bin.
  await rb.send('alice', 'rebase', [3n * 10n ** 18n / 2n]);
  const r0 = rbIsX ? await pair.call('reserveX') : await pair.call('reserveY');
  await pair.send('carol', 'skim', [addr('carol')]);
  assert.equal(rbIsX ? await pair.call('reserveX') : await pair.call('reserveY'), r0);
  assert.ok((await rb.call('balanceOf', [addr('carol')])) > 0n);
});

test('extreme bins: near the top of the price range a bin holds little X (a larger deposit reverts), trades there settle exactly; reserves are capped at 2^128', async () => {
  const d = await setupDlmm();
  const { router, factory, addr, deadline, token, pairAt, c } = d;
  const huge = await token('Huge A', 'HGA', 0, 1n << 200n);
  const huge2 = await token('Huge B', 'HGB', 0, 1n << 200n);
  for (const t of [huge, huge2]) await t.send('alice', 'approve', [router.address, MAX]);
  const [tx, ty] = BigInt(huge.address) < BigInt(huge2.address) ? [huge, huge2] : [huge2, huge];
  const h = await c.deployRaw(art('DlmmMathHarness'), [], 'gov');
  let top = 6600;
  while (true) { try { await h.call('price', [top + 1, 100]); top += 1; } catch { break; } }
  await factory.send('alice', 'createPair', [tx.address, ty.address, 100, top - 1]);
  const pair = pairAt(await factory.call('getPair', [tx.address, ty.address, 100]));
  const addTop = (x) => router.send('alice', 'addLiquidity', [lp({ X: tx, Y: ty, binStep: 100, activeId: top - 1, deltas: [1], ax: [x], ay: [0n], to: addr('alice'), deadline: deadline() })]);
  await assert.rejects(addTop(1n << 40n), /Overflow/, 'x * price must fit 256 bits');
  await addTop(1000n);
  // Buy 1 wei of X at ~2^96 Y each: input rounded up, exact.
  const price = await pair.call('getPriceFromId', [top]);
  const [need] = await pair.call('getSwapIn', [1n, false]);
  assert.ok(need >= (price + (1n << 128n) - 1n) >> 128n);
  const x0 = await tx.call('balanceOf', [addr('bob')]).catch(() => 0n);
  await ty.send('alice', 'transfer', [addr('bob'), need]);
  await ty.send('bob', 'approve', [router.address, MAX]);
  await router.send('bob', 'swapTokensForExactTokens', [1n, need, path([100], [ty, tx]), addr('bob'), deadline()]);
  assert.equal((await tx.call('balanceOf', [addr('bob')])) - x0, 1n);
  // A bin (and the pair's total) cannot hold 2^128 of a token.
  const addLow = (ids, ys) => router.send('alice', 'addLiquidity', [lp({ X: tx, Y: ty, binStep: 100, activeId: top, deltas: ids, ax: ids.map(() => 0n), ay: ys, to: addr('alice'), deadline: deadline() })]);
  await assert.rejects(addLow([-1], [1n << 128n]), /Overflow/);
  await addLow([-2], [(1n << 127n)]);
  await assert.rejects(addLow([-3], [(1n << 127n)]), /Overflow/);
});

test('bin crossing is bounded: a swap needing more than MAX_BINS_CROSSED (100) bins reverts (quote too); 100 bins go through', async () => {
  const d = await setupDlmm();
  const { router, X, Y, addr, deadline, c, factory, pairAt } = d;
  const ids = Array.from({ length: 100 }, (_, i) => i - 99); // -99 .. 0 (Y)
  const add = (deltas) => router.send('alice', 'addLiquidity', [lp({ X, Y, binStep: 1, activeId: 0, deltas, ax: deltas.map(() => 0n), ay: deltas.map(() => ONE), to: addr('alice'), deadline: deadline() })]);
  await add(ids);
  await add([-150, -101, -100]); // bins further down (an empty gap is skipped, not counted)
  const pair = pairAt(await factory.call('getPair', [X.address, Y.address, 1]));
  assert.equal(await pair.call('MAX_BINS_CROSSED'), 100n);
  // Enough X to empty 101 bins (0 .. -100) and reach -101: 101 moves.
  await assert.rejects(pair.send('bob', 'getSwapOut', [103n * ONE, true]), /TooManyBinsCrossed/); // the quote (as a call)
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [103n * ONE, 0, path([1], [X, Y]), addr('bob'), deadline()]), /TooManyBinsCrossed/);
  // Up to bin -100 (100 moves): fine.
  const [need] = await pair.call('getSwapIn', [100n * ONE + ONE / 2n, true]);
  const r = await c.rawSend(addr('bob'), router.address, router.iface.encodeFunctionData('swapExactTokensForTokens', [need, 0, path([1], [X, Y]), addr('bob'), deadline()]));
  assert.ok(r.ok);
  assert.equal(await pair.call('getActiveId'), -100n);
  console.log(`  a swap across 101 bins (100 moves): ${r.gasUsed} gas`);
});

test('a pair created at a wrong price with dust in it is corrected by the first trade (empty bins are skipped)', async () => {
  const d = await setupDlmm();
  const { router, factory, X, Y, addr, deadline, pairAt } = d;
  await factory.send('mallory', 'createPair', [X.address, Y.address, 10, 4_000]);
  await router.send('mallory', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 4_000, deltas: [1], ax: [1n], ay: [0n], to: addr('mallory'), deadline: deadline() })]);
  const pair = pairAt(await factory.call('getPair', [X.address, Y.address, 10]));
  await assert.rejects(pair.send('alice', 'setActiveIdWhileEmpty', [0]), /NotEmpty/);
  // Alice places Y below the real price (bins -5 .. 0, i.e. -4005 .. -4000 from the active bin).
  const deltas = [-4005, -4004, -4003, -4002, -4001, -4000];
  await router.send('alice', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 4_000, deltas, ax: deltas.map(() => 0n), ay: deltas.map(() => 10n * ONE), to: addr('alice'), deadline: deadline() })]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE / 10n, 1, path([10], [X, Y]), addr('bob'), deadline()]);
  assert.equal(await pair.call('getActiveId'), 0n, 'the price is where the liquidity is');
});

test('governance cannot touch funds: the pair has no admin path to tokens; only the protocol share (capped) is settable, and only through the factory', async () => {
  const d = await setupDlmm();
  const { factory, router, addr } = d;
  const pair = await seededPair(d);
  const fns = new Interface(art('ZetaphyDlmmPair').abi).fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
  assert.deepEqual(fns, ['batchTransferFrom', 'burn', 'collectProtocolFees', 'mint', 'setActiveIdWhileEmpty', 'setApprovalForAll', 'setProtocolShare', 'skim', 'swap']);
  await assert.rejects(pair.send('gov', 'setProtocolShare', [100]), /NotFactory/);
  assert.equal(await pair.call('MAX_PROTOCOL_SHARE_BPS'), 5000n);
  await assert.rejects(router.send('alice', 'sweep', [addr('alice')]), /NotGovernance/);
  await router.send('gov', 'sweep', [addr('gov')]);
  void factory;
});
