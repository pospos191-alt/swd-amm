// DLMM property test (contracts/dlmm/, UNAUDITED): random sequences of swaps
// (both ways, exact in and exact out, through the router and straight on the
// pair), deposits over random ranges (dust included), partial and full
// withdrawals, share transfers, donations + skim, protocol-fee collection and
// time jumps (volatility fee), with the protocol fee on or off. After every
// step:
//   - reserves == the sum of the bins; the pair holds at least reserves +
//     protocol fees of each token (equal once donations are skimmed);
//   - bins above the active bin hold no Y, bins below hold no X;
//   - each bin's totalSupply == the sum of its holders' shares, and what all
//     holders could withdraw (rounded down) never exceeds the bin;
//   - no free value: a bin's value per share, (x * price + y * 2^128) / supply,
//     never decreases (swaps add fees, deposits and withdrawals round in the
//     bin's favour);
//   - the bitmap lists exactly the bins with shares; quotes equal results;
//   - the router never keeps tokens.
// Seeded (ZDLMM_FUZZ_SEED, ZDLMM_FUZZ_STEPS), so a failure can be replayed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDlmm, lp, spot, path, liveBins, ONE, Q128 } from './helpers/dlmm.js';

const STEPS = Number(process.env.ZDLMM_FUZZ_STEPS ?? 60);
// Comma-separated seeds; even positions run bin step 10 without the protocol fee, odd ones bin step 25 with it.
const SEEDS = process.env.ZDLMM_FUZZ_SEED ? process.env.ZDLMM_FUZZ_SEED.split(',').map((v) => BigInt(v)) : [0xd1a1n, 0xb1e5n];

function rng(seed) {
  let s = seed & ((1n << 64n) - 1n) || 1n;
  const next = () => { s ^= (s << 13n) & ((1n << 64n) - 1n); s ^= s >> 7n; s ^= (s << 17n) & ((1n << 64n) - 1n); return s; };
  return {
    below: (n) => (n <= 0n ? 0n : ((next() << 64n) | next()) % n), // 128-bit draws: amounts reach past 2^64 wei
    int: (lo, hi) => lo + Number(next() % BigInt(hi - lo + 1)),
    pick: (arr) => arr[Number(next() % BigInt(arr.length))],
    bool: () => (next() & 1n) === 1n,
  };
}

const EXPECTED = /OutOfLiquidity|TooManyBinsCrossed|InsufficientAmountOut|ZeroShares|ZeroAmount|InsufficientLiquidity|SingleSidedViolation|InsufficientOutputAmount/;

for (const [k, seed] of SEEDS.entries()) {
  const feeOn = k % 2 === 1;
  const binStep = feeOn ? 25 : 10; // 25: volatility-fee preset
  test(`fuzz: ${STEPS} random steps, seed 0x${seed.toString(16)}, bin step ${binStep}, protocol fee ${feeOn ? 'on (30%)' : 'off'}`, { timeout: 600_000 }, async () => {
    const r = rng(seed);
    const d = await setupDlmm();
    const { router, factory, X, Y, addr, deadline, pairAt, c } = d;
    const s0 = spot(8, 40n * ONE);
    await router.send('alice', 'addLiquidity', [lp({ X, Y, binStep, activeId: 0, ...s0, to: addr('alice'), deadline: deadline() })]);
    const pair = pairAt(await factory.call('getPair', [X.address, Y.address, binStep]));
    if (feeOn) {
      await factory.send('gov', 'setPairProtocolShare', [pair.address, 3000]);
      await factory.send('gov', 'setFeeTo', [addr('feeTo')]);
    }
    const actors = ['alice', 'bob', 'carol', 'mallory'];
    for (const a of actors) await pair.send(a, 'setApprovalForAll', [router.address, true]);
    const prices = new Map();
    const priceOf = async (id) => { if (!prices.has(id)) prices.set(id, await pair.call('getPriceFromId', [id])); return prices.get(id); };
    const bal = (t, who) => t.call('balanceOf', [who]);
    let perShare = new Map(); // id -> [value, supply]
    const touched = new Set(s0.deltas);
    const counts = {};

    for (let step = 0; step < STEPS; step++) {
      const who = r.pick(actors);
      const op = r.pick(['swapXY', 'swapYX', 'swapXY', 'swapYX', 'exactOut', 'direct', 'add', 'add', 'remove', 'transfer', 'donate', 'collect', 'time']);
      const ctx = `step ${step} ${op} by ${who}`;
      const rx = await pair.call('reserveX');
      const ry = await pair.call('reserveY');
      try {
        if (op === 'swapXY' || op === 'swapYX') {
          const forY = op === 'swapXY';
          const [tin, tout] = forY ? [X, Y] : [Y, X];
          const reserveOut = forY ? ry : rx;
          // Mostly within the pool, sometimes beyond it, sometimes dust.
          const amt = r.below(5n) === 0n ? 1n + r.below(1000n) : 1n + r.below((reserveOut * 13n) / 10n + 1n);
          // Tokens donated and not skimmed count as part of the next input.
          const excess = (await bal(tin, pair.address)) - (forY ? rx + (await pair.call('protocolFeesX')) : ry + (await pair.call('protocolFeesY')));
          const [left, qOut] = await pair.call('getSwapOut', [amt + excess, forY]).catch(() => [1n, 0n]);
          const o0 = await bal(tout, addr(who));
          await router.send(who, 'swapExactTokensForTokens', [amt, 0, path([binStep], [tin, tout]), addr(who), deadline()]);
          assert.equal(left, 0n, `${ctx}: a swap went through, so the quote had no leftover`);
          assert.equal((await bal(tout, addr(who))) - o0, qOut, `${ctx}: out == quote`);
        } else if (op === 'exactOut') {
          const forY = r.bool();
          const [tin, tout] = forY ? [X, Y] : [Y, X];
          const want = 1n + r.below(((forY ? ry : rx) * 9n) / 10n + 1n);
          const [need, outLeft] = await pair.call('getSwapIn', [want, forY]);
          const pending = (await bal(tin, pair.address)) - (forY ? rx + (await pair.call('protocolFeesX')) : ry + (await pair.call('protocolFeesY')));
          if (outLeft === 0n && pending === 0n) {
            const i0 = await bal(tin, addr(who));
            const o0 = await bal(tout, addr(who));
            await router.send(who, 'swapTokensForExactTokens', [want, need, path([binStep], [tin, tout]), addr(who), deadline()]);
            assert.equal(i0 - (await bal(tin, addr(who))), need, ctx);
            assert.ok((await bal(tout, addr(who))) - o0 >= want, ctx);
          }
        } else if (op === 'direct') {
          // Straight on the pair: the quoted output, exactly.
          const forY = r.bool();
          const tin = forY ? X : Y;
          const amt = 1n + r.below(20n * ONE);
          const excess = (await bal(tin, pair.address)) - (forY ? rx + (await pair.call('protocolFeesX')) : ry + (await pair.call('protocolFeesY')));
          const [left, qOut] = await pair.call('getSwapOut', [amt + excess, forY]).catch(() => [1n, 0n]);
          await tin.send(who, 'transfer', [pair.address, amt]);
          const tout = forY ? Y : X;
          const o0 = await bal(tout, addr(who));
          await pair.send(who, 'swap', [forY, addr(who)]).then(async () => {
            assert.equal(left, 0n, ctx);
            assert.equal((await bal(tout, addr(who))) - o0, qOut, ctx);
          }, async (e) => {
            await pair.send(who, 'skim', [addr(who)]);
            throw e;
          });
        } else if (op === 'add') {
          const active = Number(await pair.call('getActiveId'));
          const lo = r.int(-12, 0);
          const hi = r.int(0, 12);
          const deltas = [];
          const ax = [];
          const ay = [];
          for (let dd = lo; dd <= hi; dd++) {
            if (r.below(4n) === 0n) continue;
            const amt = r.below(4n) === 0n ? 1n + r.below(100n) : 1n + r.below(30n * ONE);
            deltas.push(dd);
            ax.push(dd >= 0 ? amt : 0n);
            ay.push(dd <= 0 ? (dd === 0 ? 1n + r.below(30n * ONE) : amt) : 0n);
            touched.add(active + dd);
          }
          if (deltas.length) await router.send(who, 'addLiquidity', [lp({ X, Y, binStep, activeId: active, deltas, ax, ay, to: addr(who), deadline: deadline() })]);
        } else if (op === 'remove') {
          const bins = await liveBins(pair);
          const ids = [];
          const sh = [];
          for (const b of bins) {
            const s = await pair.call('balanceOf', [addr(who), b.id]);
            if (s === 0n || r.below(3n) === 0n) continue;
            ids.push(b.id);
            sh.push(r.bool() ? s : 1n + r.below(s));
          }
          if (ids.length) await router.send(who, 'removeLiquidity', [X.address, Y.address, binStep, ids, sh, 0, 0, addr(who), deadline()]);
        } else if (op === 'transfer') {
          const bins = await liveBins(pair);
          const b = bins.length ? r.pick(bins) : null;
          const s = b ? await pair.call('balanceOf', [addr(who), b.id]) : 0n;
          if (s > 0n) await pair.send(who, 'batchTransferFrom', [addr(who), addr(r.pick(actors)), [b.id], [1n + r.below(s)]]);
        } else if (op === 'donate') {
          await (r.bool() ? X : Y).send(who, 'transfer', [pair.address, 1n + r.below(5n * ONE)]);
          if (r.bool()) await pair.send(who, 'skim', [addr(who)]);
        } else if (op === 'collect') {
          if (feeOn) await pair.send(who, 'collectProtocolFees');
        } else {
          c.advance(1 + Number(r.below(900n)));
        }
      } catch (e) {
        assert.match(e.message, EXPECTED, ctx);
        counts[`${op}:${e.message}`] = (counts[`${op}:${e.message}`] ?? 0) + 1;
      }
      counts[op] = (counts[op] ?? 0) + 1;

      // ---- invariants ----
      const active = Number(await pair.call('getActiveId'));
      const bins = await liveBins(pair);
      const nrx = await pair.call('reserveX');
      const nry = await pair.call('reserveY');
      assert.equal(bins.reduce((a, b) => a + b.x, 0n), nrx, `${ctx}: reserveX == sum of bins`);
      assert.equal(bins.reduce((a, b) => a + b.y, 0n), nry, `${ctx}: reserveY == sum of bins`);
      assert.ok((await bal(X, pair.address)) >= nrx + (await pair.call('protocolFeesX')), `${ctx}: X held >= accounted`);
      assert.ok((await bal(Y, pair.address)) >= nry + (await pair.call('protocolFeesY')), `${ctx}: Y held >= accounted`);
      const next = new Map();
      for (const b of bins) {
        if (b.id > active) assert.equal(b.y, 0n, `${ctx}: bin ${b.id} above the active bin ${active} holds no Y`);
        if (b.id < active) assert.equal(b.x, 0n, `${ctx}: bin ${b.id} below the active bin holds no X`);
        assert.ok(b.supply > 0n && b.x + b.y > 0n, `${ctx}: a listed bin has shares and tokens`);
        let sum = 0n;
        let claimX = 0n;
        let claimY = 0n;
        for (const a of actors) {
          const s = await pair.call('balanceOf', [addr(a), b.id]);
          sum += s;
          claimX += (b.x * s) / b.supply;
          claimY += (b.y * s) / b.supply;
        }
        assert.equal(sum, b.supply, `${ctx}: bin ${b.id} supply == sum of shares`);
        assert.ok(claimX <= b.x && claimY <= b.y, `${ctx}: claims <= bin`);
        const value = b.x * (await priceOf(b.id)) + b.y * Q128;
        const prev = perShare.get(b.id);
        if (prev) assert.ok(value * prev[1] >= prev[0] * b.supply, `${ctx}: bin ${b.id} value per share never drops`);
        next.set(b.id, [value, b.supply]);
      }
      for (const id of touched) {
        if (!next.has(id)) assert.equal(await pair.call('totalSupply', [id]), 0n, `${ctx}: bin ${id} with shares is in the bitmap`);
      }
      perShare = next;
      for (const t of [X, Y]) assert.equal(await bal(t, router.address), 0n, `${ctx}: router keeps nothing`);
    }
    if (feeOn) assert.ok((await pair.call('protocolFeesX')) + (await pair.call('protocolFeesY')) + (await bal(X, addr('feeTo'))) + (await bal(Y, addr('feeTo'))) > 0n, 'protocol fees accrued');
    console.log(`  seed 0x${seed.toString(16)}: ${JSON.stringify(counts)}`);
  });
}
