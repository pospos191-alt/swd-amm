// Pair, factory and router: liquidity, swaps, fees, TWAP, flash swaps,
// reentrancy, deadlines and slippage, on an in-memory EVM (npm test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@ethereumjs/util';
import { keccak256, solidityPacked, getCreate2Address, Interface } from 'ethers';
import { setupDex, art, wrap, reserves, sqrt, amountOut, amountIn, ONE } from './helpers/dex.js';

const MAX = 2n ** 256n - 1n;
const pairIface = new Interface(art('ZetaphyPair').abi);
const LOCKED = pairIface.getError('Locked').selector;

async function withPool(amtA = 1000n * ONE, amtB = 4000n * ONE) {
  const d = await setupDex();
  const { router, A, B, addr, deadline, pairAt, factory } = d;
  await router.send('alice', 'addLiquidity', [A.address, B.address, amtA, amtB, 0, 0, addr('alice'), deadline()]);
  const pair = pairAt(await factory.call('getPair', [A.address, B.address]));
  const t0 = await pair.call('token0');
  const aIs0 = t0.toLowerCase() === A.address.toLowerCase();
  const res = async () => { const [r0, r1] = await reserves(pair); return aIs0 ? [r0, r1] : [r1, r0]; }; // [reserveA, reserveB]
  return { ...d, pair, aIs0, res };
}

const bal = (t, who) => t.call('balanceOf', [who]);

test('factory: CREATE2 pairs at the address the router computes; one pair per token pair', async () => {
  const { factory, router, A, B, C, c, addr } = await setupDex();
  await factory.send('bob', 'createPair', [A.address, B.address]);
  const pair = await factory.call('getPair', [A.address, B.address]);
  assert.equal(await factory.call('getPair', [B.address, A.address]), pair);
  assert.equal((await router.call('pairFor', [B.address, A.address])).toLowerCase(), pair.toLowerCase());
  const [t0, t1] = A.address.toLowerCase() < B.address.toLowerCase() ? [A.address, B.address] : [B.address, A.address];
  const hash = await factory.call('PAIR_CODE_HASH');
  assert.equal(getCreate2Address(factory.address, keccak256(solidityPacked(['address', 'address'], [t0, t1])), hash), pair);
  assert.equal(hash, keccak256(art('ZetaphyPair').bytecode), 'the code hash the UI and router use');
  const p = wrap(c, pair, art('ZetaphyPair'));
  assert.equal((await p.call('token0')).toLowerCase(), t0.toLowerCase());
  assert.equal((await p.call('factory')).toLowerCase(), factory.address.toLowerCase());
  assert.equal(await factory.call('allPairsLength'), 1n);
  await assert.rejects(factory.send('bob', 'createPair', [B.address, A.address]), /PairExists/);
  await assert.rejects(factory.send('bob', 'createPair', [A.address, A.address]), /IdenticalAddresses/);
  await assert.rejects(factory.send('bob', 'createPair', [A.address, '0x' + '00'.repeat(20)]), /ZeroAddress/);
  const ZERO = '0x' + '0'.repeat(40);
  assert.deepEqual([...(await factory.call('pairParameters'))], [ZERO, ZERO], 'cleared after createPair');
  void C; void addr;
});

test('add liquidity: the first deposit mints sqrt(a*b) - 1000 and locks MINIMUM_LIQUIDITY at address(0); later ones are pro rata', async () => {
  const { pair, res, A, B, router, addr, deadline } = await withPool(1000n * ONE, 4000n * ONE);
  const minted = sqrt(1000n * ONE * 4000n * ONE);
  assert.equal(await pair.call('totalSupply'), minted);
  assert.equal(await bal(pair, addr('alice')), minted - 1000n);
  assert.equal(await bal(pair, '0x' + '00'.repeat(20)), 1000n);
  assert.deepEqual(await res(), [1000n * ONE, 4000n * ONE]);
  // Bob offers 10 A and up to 100 B at a 1:4 price: the router takes 10 A and 40 B.
  const b0 = await bal(B, addr('bob'));
  await router.send('bob', 'addLiquidity', [A.address, B.address, 10n * ONE, 100n * ONE, 0, 0, addr('bob'), deadline()]);
  assert.equal(b0 - (await bal(B, addr('bob'))), 40n * ONE);
  assert.equal(await bal(pair, addr('bob')), (10n * ONE * minted) / (1000n * ONE));
  // The other way round: up to 100 A and exactly 40 B -> 10 A.
  const a0 = await bal(A, addr('bob'));
  await router.send('bob', 'addLiquidity', [A.address, B.address, 100n * ONE, 40n * ONE, 0, 0, addr('bob'), deadline()]);
  assert.equal(a0 - (await bal(A, addr('bob'))), 10n * ONE);
  // Slippage on liquidity: the minimums are checked.
  await assert.rejects(router.send('bob', 'addLiquidity', [A.address, B.address, 10n * ONE, 100n * ONE, 0, 41n * ONE, addr('bob'), deadline()]), /InsufficientBAmount/);
  await assert.rejects(router.send('bob', 'addLiquidity', [A.address, B.address, 100n * ONE, 40n * ONE, 11n * ONE, 0, addr('bob'), deadline()]), /InsufficientAAmount/);
});

test('minimum liquidity: a first deposit worth <= 1000 LP is refused; the locked 1000 keep the pool from ever being emptied', async () => {
  const { router, A, B, addr, deadline, factory, pairAt } = await setupDex();
  await assert.rejects(router.send('alice', 'addLiquidity', [A.address, B.address, 1000n, 1000n, 0, 0, addr('alice'), deadline()]), /InsufficientLiquidityMinted/);
  await router.send('alice', 'addLiquidity', [A.address, B.address, 1001n, 1001n, 0, 0, addr('alice'), deadline()]);
  const pair = pairAt(await factory.call('getPair', [A.address, B.address]));
  assert.equal(await bal(pair, addr('alice')), 1n);
  await pair.send('alice', 'approve', [router.address, MAX]);
  await router.send('alice', 'removeLiquidity', [A.address, B.address, 1n, 0, 0, addr('alice'), deadline()]);
  const [r0, r1] = await reserves(pair);
  assert.ok(r0 >= 1000n && r1 >= 1000n, 'reserves never reach 0');
  assert.equal(await pair.call('totalSupply'), 1000n);
});

test('remove liquidity: pro rata share of both tokens, with minimums', async () => {
  const { pair, res, A, B, router, addr, deadline } = await withPool(1000n * ONE, 4000n * ONE);
  const lp = await bal(pair, addr('alice'));
  await pair.send('alice', 'approve', [router.address, lp]);
  const total = await pair.call('totalSupply');
  const [rA, rB] = await res();
  await assert.rejects(router.send('alice', 'removeLiquidity', [A.address, B.address, lp / 2n, rA, 0, addr('alice'), deadline()]), /InsufficientAAmount/);
  await assert.rejects(router.send('alice', 'removeLiquidity', [A.address, B.address, lp / 2n, 0, rB, addr('alice'), deadline()]), /InsufficientBAmount/);
  const a0 = await bal(A, addr('carol'));
  await router.send('alice', 'removeLiquidity', [A.address, B.address, lp / 2n, 0, 0, addr('carol'), deadline()]);
  assert.equal((await bal(A, addr('carol'))) - a0, (lp / 2n) * rA / total);
  assert.equal(await bal(B, addr('carol')), (lp / 2n) * rB / total);
  assert.equal(await bal(pair, addr('alice')), lp - lp / 2n);
});

test('swaps both ways: exact input and exact output, matching getAmountOut / getAmountIn; k never goes down', async () => {
  const { res, A, B, router, addr, deadline } = await withPool(1000n * ONE, 4000n * ONE);
  let [rA, rB] = await res();
  const k0 = rA * rB;
  // A -> B, exact in
  const out = amountOut(10n * ONE, rA, rB);
  assert.equal((await router.call('getAmountsOut', [10n * ONE, [A.address, B.address]]))[1], out);
  const b0 = await bal(B, addr('carol'));
  await router.send('bob', 'swapExactTokensForTokens', [10n * ONE, out, [A.address, B.address], addr('carol'), deadline()]);
  assert.equal((await bal(B, addr('carol'))) - b0, out);
  assert.deepEqual(await res(), [rA + 10n * ONE, rB - out]);
  [rA, rB] = await res();
  assert.ok(rA * rB > k0);
  // B -> A, exact out
  const need = amountIn(5n * ONE, rB, rA);
  assert.equal((await router.call('getAmountsIn', [5n * ONE, [B.address, A.address]]))[0], need);
  const bb = await bal(B, addr('bob'));
  const a0 = await bal(A, addr('carol'));
  await router.send('bob', 'swapTokensForExactTokens', [5n * ONE, need, [B.address, A.address], addr('carol'), deadline()]);
  assert.equal(bb - (await bal(B, addr('bob'))), need);
  assert.equal((await bal(A, addr('carol'))) - a0, 5n * ONE);
  const [rA2, rB2] = await res();
  assert.ok(rA2 * rB2 > rA * rB);
});

test('slippage: amountOutMin / amountInMax are enforced', async () => {
  const { res, A, B, router, addr, deadline } = await withPool();
  const [rA, rB] = await res();
  const out = amountOut(10n * ONE, rA, rB);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [10n * ONE, out + 1n, [A.address, B.address], addr('bob'), deadline()]), /InsufficientOutputAmount/);
  const need = amountIn(10n * ONE, rA, rB);
  await assert.rejects(router.send('bob', 'swapTokensForExactTokens', [10n * ONE, need - 1n, [A.address, B.address], addr('bob'), deadline()]), /ExcessiveInputAmount/);
  // A sandwich moves the price first: the victim's minimum then fails instead of losing value.
  await router.send('alice', 'swapExactTokensForTokens', [50n * ONE, 0, [A.address, B.address], addr('alice'), deadline()]);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [10n * ONE, (out * 995n) / 1000n, [A.address, B.address], addr('bob'), deadline()]), /InsufficientOutputAmount/);
});

test('deadline: every router entry point refuses an expired deadline', async () => {
  const { A, B, router, addr, c, pair } = await withPool();
  const past = c.now() - 1n;
  const p = [A.address, B.address];
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, p, addr('bob'), past]), /Expired/);
  await assert.rejects(router.send('bob', 'swapTokensForExactTokens', [ONE, MAX, p, addr('bob'), past]), /Expired/);
  await assert.rejects(router.send('bob', 'addLiquidity', [A.address, B.address, ONE, ONE, 0, 0, addr('bob'), past]), /Expired/);
  await pair.send('alice', 'approve', [router.address, MAX]);
  await assert.rejects(router.send('alice', 'removeLiquidity', [A.address, B.address, 1000n, 0, 0, addr('alice'), past]), /Expired/);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokensSupportingFeeOnTransferTokens', [ONE, 0, p, addr('bob'), past]), /Expired/);
  // The current second is still fine.
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, p, addr('bob'), c.now()]);
});

test('multi-hop: A -> B -> C in one call; each pair gets exactly the previous output', async () => {
  const { A, B, C, router, addr, deadline, factory, pairAt } = await withPool(1000n * ONE, 4000n * ONE);
  await router.send('alice', 'addLiquidity', [B.address, C.address, 4000n * ONE, 2000n * ONE, 0, 0, addr('alice'), deadline()]);
  const path = [A.address, B.address, C.address];
  const amounts = await router.call('getAmountsOut', [7n * ONE, path]);
  const ab = pairAt(await factory.call('getPair', [A.address, B.address]));
  const bc = pairAt(await factory.call('getPair', [B.address, C.address]));
  const bcB0 = await bal(B, bc.address);
  const c0 = await bal(C, addr('carol'));
  await router.send('bob', 'swapExactTokensForTokens', [7n * ONE, amounts[2], path, addr('carol'), deadline()]);
  assert.equal((await bal(C, addr('carol'))) - c0, amounts[2]);
  assert.equal((await bal(B, bc.address)) - bcB0, amounts[1]);
  assert.equal(amounts[1], amountOut(7n * ONE, 1000n * ONE, 4000n * ONE));
  // Exact output through two hops.
  const ins = await router.call('getAmountsIn', [ONE, path]);
  const a0 = await bal(A, addr('bob'));
  await router.send('bob', 'swapTokensForExactTokens', [ONE, ins[0], path, addr('carol'), deadline()]);
  assert.equal(a0 - (await bal(A, addr('bob'))), ins[0]);
  void ab;
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address], addr('bob'), deadline()]), /InvalidPath/);
});

test('price impact: the bigger the trade against the pool, the worse the price (matches 1 - r/(r+0.997x))', async () => {
  const { res, router, A, B } = await withPool(1000n * ONE, 4000n * ONE);
  const [rA, rB] = await res();
  const spot = (rB * 10n ** 18n) / rA; // 4.0
  let lastImpact = -1;
  for (const x of [1n, 10n, 100n, 500n, 1000n, 5000n]) {
    const out = (await router.call('getAmountsOut', [x * ONE, [A.address, B.address]]))[1];
    const exec = (out * 10n ** 18n) / (x * ONE);
    const impact = Number(10n ** 18n - (exec * 10n ** 18n) / spot) / 1e18; // includes the 0.3% fee
    const expected = 1 - (0.997 * Number(rA)) / (Number(rA) + 0.997 * Number(x * ONE));
    assert.ok(Math.abs(impact - expected) < 1e-9, `${x}: ${impact} vs ${expected}`);
    assert.ok(impact > lastImpact);
    lastImpact = impact;
    assert.ok(out < rB, 'never the whole reserve');
  }
  assert.ok(lastImpact > 0.8, 'a trade 5x the pool loses most of its value');
});

test('fees: 0.3% stays in the pool (LPs earn), 1 wei more than the formula is refused (K)', async () => {
  const { pair, res, aIs0, A, B, router, addr, deadline } = await withPool(1000n * ONE, 1000n * ONE);
  const [rA, rB] = await res();
  const x = 100n * ONE;
  const out = amountOut(x, rA, rB);
  // Direct pair use: send the input, ask for one wei too much.
  await A.send('bob', 'transfer', [pair.address, x]);
  const outs = (o) => (aIs0 ? [0n, o] : [o, 0n]);
  await assert.rejects(pair.send('bob', 'swap', [...outs(out + 1n), addr('bob'), '0x']), /\bK$/);
  await pair.send('bob', 'swap', [...outs(out), addr('bob'), '0x']);
  // The fee: rA*rB grew by the 0.3% of x left in the pool.
  const [rA2, rB2] = await res();
  assert.equal(rA2, rA + x);
  const noFeeOut = (x * rB) / (rA + x);
  assert.ok(noFeeOut > out);
  assert.ok(rA2 * rB2 > rA * rB);
  // Round trips by bob pay fees; alice (the only LP) gets more back than she put in, in value.
  for (let i = 0; i < 10; i++) {
    await router.send('bob', 'swapExactTokensForTokens', [50n * ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
    await router.send('bob', 'swapExactTokensForTokens', [50n * ONE, 0, [B.address, A.address], addr('bob'), deadline()]);
  }
  const lp = await bal(pair, addr('alice'));
  await pair.send('alice', 'approve', [router.address, lp]);
  const [fa, fb] = await res();
  const total = await pair.call('totalSupply');
  const getA = (lp * fa) / total, getB = (lp * fb) / total;
  assert.ok(getA * getB > (1000n * ONE - 1000n) * (1000n * ONE - 1000n), 'sqrt(k) per LP share grew');
});

test('protocol fee: off by default; when governance sets feeTo, 1/6 of the sqrt(k) growth is minted to it on the next liquidity event', async () => {
  const { pair, res, A, B, router, addr, deadline, factory } = await withPool(1000n * ONE, 1000n * ONE);
  await assert.rejects(factory.send('alice', 'setFeeTo', [addr('feeTo')]), /NotGovernance/);
  // Off: no LP minted to anyone, kLast stays 0.
  await router.send('bob', 'swapExactTokensForTokens', [100n * ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
  await router.send('bob', 'addLiquidity', [A.address, B.address, ONE, 10n * ONE, 0, 0, addr('bob'), deadline()]);
  assert.equal(await pair.call('kLast'), 0n);
  // On.
  await factory.send('gov', 'setFeeTo', [addr('feeTo')]);
  await router.send('bob', 'addLiquidity', [A.address, B.address, ONE, 10n * ONE, 0, 0, addr('bob'), deadline()]); // sets kLast
  let [rA, rB] = await res();
  assert.equal(await pair.call('kLast'), rA * rB);
  const kLast = rA * rB;
  for (let i = 0; i < 5; i++) {
    await router.send('bob', 'swapExactTokensForTokens', [200n * ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
    await router.send('bob', 'swapExactTokensForTokens', [200n * ONE, 0, [B.address, A.address], addr('bob'), deadline()]);
  }
  [rA, rB] = await res();
  const ts = await pair.call('totalSupply');
  const rootK = sqrt(rA * rB), rootKLast = sqrt(kLast);
  const expected = (ts * (rootK - rootKLast)) / (rootK * 5n + rootKLast);
  assert.ok(expected > 0n);
  assert.equal(await bal(pair, addr('feeTo')), 0n, 'minted only on the next mint/burn');
  await pair.send('alice', 'approve', [router.address, MAX]);
  await router.send('alice', 'removeLiquidity', [A.address, B.address, ONE, 0, 0, addr('alice'), deadline()]);
  assert.equal(await bal(pair, addr('feeTo')), expected);
  // Share of the growth: feeTo's LP value / total value growth = 1/6.
  const share = Number(expected * rootK) / Number(ts + expected) / Number(rootK - rootKLast);
  assert.ok(Math.abs(share - 1 / 6) < 1e-6, String(share));
  // Off again: kLast is cleared at the next event.
  await factory.send('gov', 'setFeeTo', ['0x' + '00'.repeat(20)]);
  await router.send('alice', 'removeLiquidity', [A.address, B.address, ONE, 0, 0, addr('alice'), deadline()]);
  assert.equal(await pair.call('kLast'), 0n);
});

test('governance: two-step handover; only governance sets feeTo and the registry', async () => {
  const { factory, addr } = await setupDex();
  await assert.rejects(factory.send('bob', 'setGovernance', [addr('bob')]), /NotGovernance/);
  await factory.send('gov', 'setGovernance', [addr('bob')]);
  assert.equal((await factory.call('governance')).toLowerCase(), addr('gov').toLowerCase());
  await assert.rejects(factory.send('carol', 'acceptGovernance'), /NotPendingGovernance/);
  await factory.send('bob', 'acceptGovernance');
  assert.equal((await factory.call('governance')).toLowerCase(), addr('bob').toLowerCase());
  await assert.rejects(factory.send('gov', 'setFeeTo', [addr('gov')]), /NotGovernance/);
  await assert.rejects(factory.send('gov', 'setThreatRegistry', [addr('gov')]), /NotGovernance/);
});

test('K invariant: a swap that takes out more than the fee-adjusted input allows is refused; no input at all too', async () => {
  const { pair, aIs0, A, addr } = await withPool(1000n * ONE, 1000n * ONE);
  const outs = (o) => (aIs0 ? [0n, o] : [o, 0n]);
  await assert.rejects(pair.send('bob', 'swap', [...outs(ONE), addr('bob'), '0x']), /InsufficientInputAmount/);
  await assert.rejects(pair.send('bob', 'swap', [0n, 0n, addr('bob'), '0x']), /InsufficientOutputAmount/);
  await assert.rejects(pair.send('bob', 'swap', [...outs(1000n * ONE), addr('bob'), '0x']), /InsufficientLiquidity/);
  await assert.rejects(pair.send('bob', 'swap', [...outs(ONE), A.address, '0x']), /InvalidTo/);
  // Input without the fee: x in, x*rB/(rA+x) out (the no-fee price) fails.
  await A.send('bob', 'transfer', [pair.address, 10n * ONE]);
  await assert.rejects(pair.send('bob', 'swap', [...outs((10n * ONE * 1000n * ONE) / (1010n * ONE)), addr('bob'), '0x']), /\bK$/);
});

test('TWAP: price accumulators grow by the UQ112.112 price times the seconds since the last update', async () => {
  const { pair, res, aIs0, A, B, router, addr, deadline, c } = await withPool(1000n * ONE, 4000n * ONE);
  const [, , t0] = await pair.call('getReserves');
  const p0 = await pair.call('price0CumulativeLast');
  const p1 = await pair.call('price1CumulativeLast');
  const [rA, rB] = await res();
  const [r0, r1] = aIs0 ? [rA, rB] : [rB, rA];
  c.advance(3600);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
  const [, , t1] = await pair.call('getReserves');
  assert.equal(BigInt(t1) - BigInt(t0), 3600n);
  assert.equal((await pair.call('price0CumulativeLast')) - p0, ((r1 << 112n) / r0) * 3600n);
  assert.equal((await pair.call('price1CumulativeLast')) - p1, ((r0 << 112n) / r1) * 3600n);
  // The average price of A in B over that hour is 4.
  const avg = ((await pair.call(aIs0 ? 'price0CumulativeLast' : 'price1CumulativeLast')) - (aIs0 ? p0 : p1)) / 3600n;
  assert.equal(Number(avg >> 100n) / 4096, 4);
  // Same block (no time passed): no change.
  const before = await pair.call('price0CumulativeLast');
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
  assert.equal(await pair.call('price0CumulativeLast'), before);
});

test('skim sends out what is above the reserves; sync sets the reserves to the balances', async () => {
  const { pair, res, A, addr } = await withPool(1000n * ONE, 4000n * ONE);
  const [rA, rB] = await res();
  await A.send('bob', 'transfer', [pair.address, 3n * ONE]);
  assert.deepEqual(await res(), [rA, rB]);
  const c0 = await bal(A, addr('carol'));
  await pair.send('carol', 'skim', [addr('carol')]);
  assert.equal((await bal(A, addr('carol'))) - c0, 3n * ONE);
  assert.deepEqual(await res(), [rA, rB]);
  await A.send('bob', 'transfer', [pair.address, 2n * ONE]);
  await pair.send('carol', 'sync');
  assert.deepEqual(await res(), [rA + 2n * ONE, rB]);
});

test('flash swap: borrow, get called back (zetaphyDexCall), repay with the fee; underpaying is refused', async () => {
  const { pair, aIs0, A, c, addr, res } = await withPool(1000n * ONE, 4000n * ONE);
  const fb = await c.deployRaw(art('FlashBorrower'), [], 'bob');
  await A.send('bob', 'transfer', [fb.address, 10n * ONE]); // enough for the fee
  const outs = (o) => (aIs0 ? [o, 0n] : [0n, o]); // borrow A
  const [rA] = await res();
  await fb.send('bob', 'borrow', [pair.address, ...outs(100n * ONE)]);
  assert.equal((await fb.call('lastSender')).toLowerCase(), fb.address.toLowerCase());
  const [rA2] = await res();
  assert.ok(rA2 > rA, 'the fee stayed in the pool');
  assert.equal(rA2 - rA, (100n * ONE * 1000n) / 997n + 1n - 100n * ONE);
  await fb.send('bob', 'setRepayBps', [9990n]);
  await assert.rejects(fb.send('bob', 'borrow', [pair.address, ...outs(100n * ONE)]), /\bK$/);
  void addr;
});

test('reentrancy: a token that calls back into its pair during a transfer meets Locked() on every entry point', async () => {
  const d = await setupDex();
  const { c, router, A, addr, deadline, factory, pairAt } = d;
  const re = await c.deployRaw(art('ReentrantToken'), [10_000_000n * ONE], 'alice');
  await re.send('alice', 'approve', [router.address, MAX]);
  await router.send('alice', 'addLiquidity', [A.address, re.address, 1000n * ONE, 1000n * ONE, 0, 0, addr('alice'), deadline()]);
  const pair = pairAt(await factory.call('getPair', [A.address, re.address]));
  for (const mode of [1, 2, 3, 4, 5]) {
    await re.send('alice', 'arm', [pair.address, mode]);
    // A swap A -> RE makes the pair transfer RE out, which calls back.
    await router.send('alice', 'swapExactTokensForTokens', [ONE, 0, [A.address, re.address], addr('alice'), deadline()]);
    assert.equal(await re.call('mode'), 0n, `mode ${mode} fired`);
    assert.equal(await re.call('lastRevert'), LOCKED, `mode ${mode} hit the lock`);
  }
  assert.equal(await re.call('attempts'), 5n);
  // And through burn (removeLiquidity transfers RE out while the pair is locked).
  await re.send('alice', 'arm', [pair.address, 1]);
  await pair.send('alice', 'approve', [router.address, MAX]);
  await router.send('alice', 'removeLiquidity', [A.address, re.address, ONE, 0, 0, addr('alice'), deadline()]);
  assert.equal(await re.call('lastRevert'), LOCKED);
});

test('native ZETAPHY: add liquidity (refunding the rest), swap both ways, exact in and out, remove', async () => {
  const { c, A, router, weth, addr, deadline, factory, pairAt } = await setupDex();
  const W = weth.address;
  const n0 = await c.balance('alice');
  await router.send('alice', 'addLiquidityETH', [A.address, 1000n * ONE, 0, 0, addr('alice'), deadline()], 500n * ONE);
  assert.equal(n0 - (await c.balance('alice')), 500n * ONE);
  // Second add at the 2:1 price, offering too much native: the rest comes back.
  const n1 = await c.balance('bob');
  await router.send('bob', 'addLiquidityETH', [A.address, 10n * ONE, 0, 0, addr('bob'), deadline()], 50n * ONE);
  assert.equal(n1 - (await c.balance('bob')), 5n * ONE);
  const pair = pairAt(await factory.call('getPair', [A.address, W]));
  assert.equal(await weth.call('balanceOf', [pair.address]), 505n * ONE);
  // native -> A, exact in
  const out = (await router.call('getAmountsOut', [ONE, [W, A.address]]))[1];
  const a0 = await bal(A, addr('carol'));
  await router.send('carol', 'swapExactETHForTokens', [out, [W, A.address], addr('carol'), deadline()], ONE);
  assert.equal((await bal(A, addr('carol'))) - a0, out);
  // A -> native, exact in
  await A.send('carol', 'approve', [router.address, out]);
  const nOut = (await router.call('getAmountsOut', [out, [A.address, W]]))[1];
  const n2 = await c.balance('carol');
  await router.send('carol', 'swapExactTokensForETH', [out, nOut, [A.address, W], addr('carol'), deadline()]);
  assert.equal((await c.balance('carol')) - n2, nOut);
  // native -> exact A, refunding the rest
  const need = (await router.call('getAmountsIn', [ONE, [W, A.address]]))[0];
  const n3 = await c.balance('carol');
  await router.send('carol', 'swapETHForExactTokens', [ONE, [W, A.address], addr('carol'), deadline()], need + 5n * ONE);
  assert.equal(n3 - (await c.balance('carol')), need);
  await assert.rejects(router.send('carol', 'swapETHForExactTokens', [ONE, [W, A.address], addr('carol'), deadline()], need / 2n), /ExcessiveInputAmount/);
  // A -> exact native
  const needA = (await router.call('getAmountsIn', [ONE, [A.address, W]]))[0];
  const n4 = await c.balance('bob');
  await router.send('bob', 'swapTokensForExactETH', [ONE, needA, [A.address, W], addr('bob'), deadline()]);
  assert.equal((await c.balance('bob')) - n4, ONE);
  // wrong ends of the path
  await assert.rejects(router.send('bob', 'swapExactETHForTokens', [0, [A.address, W], addr('bob'), deadline()], ONE), /InvalidPath/);
  await assert.rejects(router.send('bob', 'swapExactTokensForETH', [ONE, 0, [W, A.address], addr('bob'), deadline()]), /InvalidPath/);
  // remove: native comes back as native
  const lp = await bal(pair, addr('bob'));
  await pair.send('bob', 'approve', [router.address, lp]);
  const n5 = await c.balance('bob');
  await router.send('bob', 'removeLiquidityETH', [A.address, lp, 0, 0, addr('bob'), deadline()]);
  assert.ok((await c.balance('bob')) - n5 > 4n * ONE);
  // The router accepts native coins only from the wrapper.
  await assert.rejects(router.sendValue('bob', ONE), /OnlyWNative/);
});

test('fee-on-transfer tokens: the Supporting* functions work where the exact-amount ones cannot', async () => {
  const { c, A, router, weth, addr, deadline, token, factory, pairAt } = await setupDex();
  const W = weth.address;
  const F = await token('Fee Token', 'FEE', 100); // 1% burned per transfer
  await F.send('alice', 'approve', [router.address, MAX]);
  await F.send('alice', 'transfer', [addr('bob'), 10_000n * ONE]);
  await F.send('bob', 'approve', [router.address, MAX]);
  await router.send('alice', 'addLiquidity', [F.address, A.address, 1000n * ONE, 1000n * ONE, 0, 0, addr('alice'), deadline()]);
  const pair = pairAt(await factory.call('getPair', [F.address, A.address]));
  assert.equal(await bal(F, pair.address), 990n * ONE, 'the pair counts what it received');
  // Exact-amount swap with F in: the pair gets 1% less than getAmountsOut assumed -> K.
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [10n * ONE, 0, [F.address, A.address], addr('bob'), deadline()]), /\bK$/);
  // Supporting: measured, works; the minimum is checked on what `to` really got.
  const a0 = await bal(A, addr('bob'));
  await router.send('bob', 'swapExactTokensForTokensSupportingFeeOnTransferTokens', [10n * ONE, 0, [F.address, A.address], addr('bob'), deadline()]);
  const got = (await bal(A, addr('bob'))) - a0;
  assert.equal(got, amountOut(99n * ONE / 10n, 990n * ONE, 1000n * ONE));
  // A -> F: `to` receives 1% less than the pair sent; amountOutMin is checked on that.
  const [r0, r1] = await reserves(pair);
  const fIs0 = (await pair.call('token0')).toLowerCase() === F.address.toLowerCase();
  const [rF, rA] = fIs0 ? [r0, r1] : [r1, r0];
  const sent = amountOut(ONE, rA, rF);
  const recv = sent - sent / 100n;
  await assert.rejects(router.send('bob', 'swapExactTokensForTokensSupportingFeeOnTransferTokens', [ONE, recv + 1n, [A.address, F.address], addr('bob'), deadline()]), /InsufficientOutputAmount/);
  const f0 = await bal(F, addr('bob'));
  await router.send('bob', 'swapExactTokensForTokensSupportingFeeOnTransferTokens', [ONE, recv, [A.address, F.address], addr('bob'), deadline()]);
  assert.equal((await bal(F, addr('bob'))) - f0, recv);
  // Native pairs.
  await router.send('alice', 'addLiquidityETH', [F.address, 1000n * ONE, 0, 0, addr('alice'), deadline()], 100n * ONE);
  const fb = await bal(F, addr('carol'));
  await router.send('carol', 'swapExactETHForTokensSupportingFeeOnTransferTokens', [0, [W, F.address], addr('carol'), deadline()], ONE);
  const fGot = (await bal(F, addr('carol'))) - fb;
  assert.ok(fGot > 0n);
  await F.send('carol', 'approve', [router.address, MAX]);
  const n0 = await c.balance('carol');
  await router.send('carol', 'swapExactTokensForETHSupportingFeeOnTransferTokens', [fGot, 0, [F.address, W], addr('carol'), deadline()]);
  assert.ok((await c.balance('carol')) > n0);
  await assert.rejects(router.send('carol', 'swapExactTokensForETHSupportingFeeOnTransferTokens', [ONE, 0, [F.address, A.address], addr('carol'), deadline()]), /InvalidPath/);
  // Removing: the exact variant fails (the router got 1% less F than it forwards), Supporting works.
  const fw = pairAt(await factory.call('getPair', [F.address, W]));
  const lp = await bal(fw, addr('alice'));
  await fw.send('alice', 'approve', [router.address, MAX]);
  await assert.rejects(router.send('alice', 'removeLiquidityETH', [F.address, lp / 2n, 0, 0, addr('alice'), deadline()]), /TransferFailed/);
  const nA = await c.balance('alice');
  await router.send('alice', 'removeLiquidityETHSupportingFeeOnTransferTokens', [F.address, lp / 2n, 0, 0, addr('alice'), deadline()]);
  assert.ok((await c.balance('alice')) > nA);
  assert.equal(await bal(F, router.address), 0n, 'nothing left in the router');
});

test('router keeps nothing: after every kind of swap its token and wrapped balances are zero', async () => {
  const { A, B, router, weth, addr, deadline, c } = await withPool();
  await router.send('alice', 'addLiquidityETH', [A.address, 1000n * ONE, 0, 0, addr('alice'), deadline()], 100n * ONE);
  await router.send('bob', 'swapExactETHForTokens', [0, [weth.address, A.address, B.address], addr('bob'), deadline()], ONE);
  await router.send('bob', 'swapExactTokensForETH', [ONE, 0, [B.address, A.address, weth.address], addr('bob'), deadline()]);
  for (const t of [A, B, weth]) assert.equal(await bal(t, router.address), 0n);
  assert.equal(await c.balance(Address.fromString(router.address)), 0n);
});
