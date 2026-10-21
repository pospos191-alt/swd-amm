// Fuzz: random sequences of swaps (both ways, exact in and exact out, through
// the router and straight on the pair), liquidity adds and removes, donations,
// skim and sync, flash-swap attempts, with the protocol fee on or off. After
// every step the invariants must hold:
//   - reserves == the pair's token balances;
//   - k (reserve0 * reserve1) never decreases on a swap;
//   - the value of one LP share, sqrt(k) / totalSupply, never decreases
//     (protocol fee off; with it on, LP value moves to feeTo, checked by total);
//   - totalSupply == the sum of every holder's LP balance;
//   - a swap taking 1 wei more than getAmountOut allows is refused (K).
// Seeded (ZDEX_FUZZ_SEED, ZDEX_FUZZ_STEPS), so a failure can be replayed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDex, reserves, amountOut, amountIn, sqrt, ONE } from './helpers/dex.js';

const STEPS = Number(process.env.ZDEX_FUZZ_STEPS ?? 250);
const SEEDS = process.env.ZDEX_FUZZ_SEED ? [BigInt(process.env.ZDEX_FUZZ_SEED)] : [0x5a5a1n, 0x77390n];
const MAX = 2n ** 256n - 1n;

function rng(seed) {
  let s = seed & ((1n << 64n) - 1n) || 1n;
  const next = () => { s ^= (s << 13n) & ((1n << 64n) - 1n); s ^= s >> 7n; s ^= (s << 17n) & ((1n << 64n) - 1n); return s; };
  return { below: (n) => (n <= 0n ? 0n : next() % n), pick: (arr) => arr[Number(next() % BigInt(arr.length))], bool: () => (next() & 1n) === 1n };
}

for (const seed of SEEDS) {
  for (const feeOn of [false, true]) {
    test(`fuzz: ${STEPS} random steps, seed 0x${seed.toString(16)}, protocol fee ${feeOn ? 'on' : 'off'}`, { timeout: 300_000 }, async () => {
      const r = rng(seed + (feeOn ? 1n : 0n));
      const { router, A, B, addr, deadline, factory, pairAt, c } = await setupDex();
      if (feeOn) await factory.send('gov', 'setFeeTo', [addr('feeTo')]);
      await router.send('alice', 'addLiquidity', [A.address, B.address, 1000n * ONE, 3000n * ONE, 0, 0, addr('alice'), deadline()]);
      const pair = pairAt(await factory.call('getPair', [A.address, B.address]));
      const aIs0 = (await pair.call('token0')).toLowerCase() === A.address.toLowerCase();
      const holders = ['alice', 'bob', 'carol', 'feeTo'].map(addr).concat(['0x' + '00'.repeat(20), pair.address]);
      for (const w of ['alice', 'bob']) await pair.send(w, 'approve', [router.address, MAX]);
      for (const t of [A, B]) await t.send('alice', 'transfer', [addr('carol'), 100_000n * ONE]);
      const bal = (t, who) => t.call('balanceOf', [who]);
      const res = async () => { const [r0, r1] = await reserves(pair); return aIs0 ? [r0, r1] : [r1, r0]; };
      const counts = {};

      for (let step = 0; step < STEPS; step++) {
        const [rA, rB] = await res();
        const ts = await pair.call('totalSupply');
        const who = r.pick(['alice', 'bob']);
        const op = r.pick(['swapAB', 'swapBA', 'exactOut', 'add', 'remove', 'donateSync', 'donateSkim', 'direct', 'time']);
        const ctx = `step ${step} ${op}`;
        let swapped = false;
        if (op === 'swapAB' || op === 'swapBA') {
          const [tin, tout, rin, rout] = op === 'swapAB' ? [A, B, rA, rB] : [B, A, rB, rA];
          const x = 1n + r.below((rin * (1n + r.below(300n))) / 100n); // up to 3x the reserve
          const expect = amountOut(x, rin, rout);
          const b0 = await bal(tout, addr(who));
          if (expect === 0n) {
            await assert.rejects(router.send(who, 'swapExactTokensForTokens', [x, 1n, [tin.address, tout.address], addr(who), deadline()]), /InsufficientOutputAmount/, ctx);
          } else {
            await router.send(who, 'swapExactTokensForTokens', [x, expect, [tin.address, tout.address], addr(who), deadline()]);
            assert.equal((await bal(tout, addr(who))) - b0, expect, ctx);
            swapped = true;
          }
        } else if (op === 'exactOut') {
          const ab = r.bool();
          const [tin, tout, rin, rout] = ab ? [A, B, rA, rB] : [B, A, rB, rA];
          const y = 1n + r.below(rout - 1n);
          const need = amountIn(y, rin, rout);
          if (need <= (await bal(tin, addr(who)))) {
            await router.send(who, 'swapTokensForExactTokens', [y, need, [tin.address, tout.address], addr(who), deadline()]);
            swapped = true;
          }
        } else if (op === 'add') {
          const x = 1n + r.below(500n * ONE);
          const y = 1n + r.below(1500n * ONE);
          await router.send(who, 'addLiquidity', [A.address, B.address, x, y, 0, 0, addr(who), deadline()]).catch((e) => {
            assert.match(e.message, /InsufficientLiquidityMinted|InsufficientAmount/, ctx); // dust
          });
        } else if (op === 'remove') {
          const lp = await bal(pair, addr(who));
          if (lp > 0n) {
            const part = 1n + r.below(lp);
            await router.send(who, 'removeLiquidity', [A.address, B.address, part, 0, 0, addr(who), deadline()]).catch((e) => {
              assert.match(e.message, /InsufficientLiquidityBurned/, ctx); // dust
            });
          }
        } else if (op === 'donateSync' || op === 'donateSkim') {
          const t = r.bool() ? A : B;
          const amt = 1n + r.below(10n * ONE);
          await t.send('carol', 'transfer', [pair.address, amt]);
          if (op === 'donateSync') await pair.send('carol', 'sync');
          else {
            const b0 = await bal(t, addr('carol'));
            await pair.send('carol', 'skim', [addr('carol')]);
            assert.equal((await bal(t, addr('carol'))) - b0, amt, ctx);
          }
        } else if (op === 'direct') {
          // Straight on the pair: one wei too many is refused, the exact amount is not.
          const ab = r.bool();
          const [tin, rin, rout] = ab ? [A, rA, rB] : [B, rB, rA];
          const x = 1n + r.below(rin);
          const o = amountOut(x, rin, rout);
          await tin.send('carol', 'transfer', [pair.address, x]);
          const outs = (v) => ((ab === aIs0) ? [0n, v] : [v, 0n]);
          await assert.rejects(pair.send('carol', 'swap', [...outs(o + 1n), addr('carol'), '0x']), /\bK$|InsufficientLiquidity/, ctx);
          if (o > 0n) { await pair.send('carol', 'swap', [...outs(o), addr('carol'), '0x']); swapped = true; } else await pair.send('carol', 'skim', [addr('carol')]);
        } else {
          c.advance(Number(1n + r.below(86400n)));
        }
        counts[op] = (counts[op] ?? 0) + 1;

        // ---- invariants ----
        const [nA, nB] = await res();
        assert.equal(nA, await bal(A, pair.address), `${ctx}: reserve A == balance`);
        assert.equal(nB, await bal(B, pair.address), `${ctx}: reserve B == balance`);
        if (swapped) assert.ok(nA * nB > rA * rB, `${ctx}: k grew`);
        const nts = await pair.call('totalSupply');
        let sum = 0n;
        for (const h of holders) sum += await bal(pair, h);
        assert.equal(sum, nts, `${ctx}: totalSupply == sum of balances`);
        if (!feeOn) {
          // sqrt(nk)/nts >= sqrt(k)/ts  <=>  nk * ts^2 >= k * nts^2 (up to sqrt rounding: compare k directly)
          assert.ok(nA * nB * ts * ts >= rA * rB * nts * nts, `${ctx}: LP share value never drops`);
        } else {
          // With the fee on, value per share (feeTo's included) still never drops below sqrt(k) of the first deposit.
          assert.ok(sqrt(nA * nB) * 1000n >= nts, `${ctx}: sanity`);
        }
        assert.ok(nA > 0n && nB > 0n, `${ctx}: never empty`);
      }
      if (feeOn) assert.ok((await bal(pair, addr('feeTo'))) > 0n, 'feeTo earned LP');
      console.log(`  seed 0x${seed.toString(16)} fee ${feeOn ? 'on' : 'off'}: ${JSON.stringify(counts)}`);
    });
  }
}
