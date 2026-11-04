// SS4 economic security (docs/future/red-team.md): an agent-based simulation of economic attacks against the
// ZETAPHY DEX (zetaphy-dex: ZetaphyFactory, ZetaphyPair, ZetaphyRouter, their committed artifacts, executed in the
// in-memory EVM of src/redteam/fork.js) and the protocols that read it, giving
//
//     "max extractable loss under attack <= X"   for a named scenario set and seeds (reproducible bit for bit).
//
// Scenarios (each runs on a fresh local chain per seed; seeded noise traders move the pool first):
//   sandwich             MEV: a victim swaps through the router with a slippage limit; the attacker front-runs and
//                        back-runs it (front-run size searched). Loss = what the victim receives less than without
//                        the attack. Bounded by the victim's own slippage limit.
//   oracle-spot          a lender that values collateral at the pair's SPOT price; the attacker flash-borrows quote,
//                        pumps the price in one transaction, borrows against the inflated collateral, dumps back.
//                        Loss = the lender's bad debt (borrowed - collateral at the fair price) less nothing: the
//                        attacker's round-trip cost is its own.
//   oracle-twap          the same lender reading the pair's TWAP (cumulative prices, like TwapRecorder): the attacker
//                        must hold the manipulated price for `holdBlocks` blocks against an arbitrageur.
//   liquidation-cascade  seeded borrowers near their threshold; an attacker sells base into the pool (a shock);
//                        liquidators sell seized collateral into the same pool, which moves the price further.
//                        Loss = bad debt left after the cascade.
// The lender, the borrowers and the liquidators are agents in this file (there is no lending protocol in the
// repo); every price they see and every trade they make is a real call to the DEX contracts on the fork.
//
// The report is canonical JSON (no clock, no path): its keccak256 is the reportHash EconomicBounds takes, with
// bound = maxExtractableLoss (in wei of the quote token, which stands for the native coin: 18 decimals).
import { readFileSync } from 'node:fs';
import { Interface, keccak256, toUtf8Bytes, MaxUint256 } from 'ethers';
import { createFork, emptySource } from './fork.js';
import { canonicalJson } from '../replay.js';
import { rng } from './search.js';

export const ECON_KIND = 'zetaphy.econ.report';
const E = 10n ** 18n;
const art = (n) => JSON.parse(readFileSync(new URL(`../../../zetaphy-dex/artifacts/${n}.json`, import.meta.url), 'utf8'));
const DEX = { factory: art('ZetaphyFactory'), pair: art('ZetaphyPair'), router: art('ZetaphyRouter'), token: art('TestToken') };
const I = Object.fromEntries(Object.entries(DEX).map(([k, a]) => [k, new Interface(a.abi)]));
const ACT = {
  deployer: '0x00000000000000000000000000000000000d0d01', lp: '0x0000000000000000000000000000000000001b01',
  victim: '0x00000000000000000000000000000000000b1c71', attacker: '0x00000000000000000000000000000000000a77a1',
  noise: '0x000000000000000000000000000000000000a015', arb: '0x000000000000000000000000000000000000a4b1',
  liq: '0x000000000000000000000000000000000000110a',
};

/** The default scenario set (what `zetaphy econ sim` runs without --scenarios). */
export const DEFAULT_SCENARIOS = Object.freeze([
  { id: 'sandwich-1pct', kind: 'sandwich', pool: { base: '1000000', quote: '1000000' }, victim: '10000', slippageBps: 100 },
  { id: 'sandwich-5pct', kind: 'sandwich', pool: { base: '1000000', quote: '1000000' }, victim: '10000', slippageBps: 500 },
  { id: 'oracle-spot', kind: 'oracle', pricing: 'spot', pool: { base: '1000000', quote: '1000000' }, lenderLiquidity: '200000', ltvBps: 7500, flash: '3000000' },
  { id: 'oracle-twap', kind: 'oracle', pricing: 'twap', window: 1800, holdBlocks: 1, pool: { base: '1000000', quote: '1000000' }, lenderLiquidity: '200000', ltvBps: 7500, flash: '3000000' },
  { id: 'liquidation-cascade', kind: 'cascade', pool: { base: '1000000', quote: '1000000' }, borrowers: 20, thresholdBps: 8000, bonusBps: 500, shocks: ['50000', '150000', '300000'] },
]);
export const DEFAULT_SEEDS = Object.freeze([1, 2, 3]);

export const scenariosHash = (scenarios, seeds) => keccak256(toUtf8Bytes(canonicalJson({ scenarios, seeds })));
export const econReportHash = (report) => keccak256(toUtf8Bytes(canonicalJson(report)));
const W = (s) => BigInt(s) * E; // whole tokens in scenario JSON

// ------------------------------------------------------------------------------------------- the DEX on a fork

async function dexWorld(seed, pool) {
  const w = await createFork({ source: emptySource(31337, 1, 1_800_000_000) });
  for (const a of Object.values(ACT)) await w.setBalance(a, 10n ** 27n);
  const dep = ACT.deployer;
  const deploy = async (a, args) => w.deploy(dep, a.bytecode + new Interface(a.abi).encodeDeploy(args).slice(2));
  const send = async (from, to, iface, fn, args, value = 0n) => {
    const r = await w.tx(from, to, iface.encodeFunctionData(fn, args), value);
    if (!r.ok) throw new Error(`econ: ${fn} failed`);
    return r;
  };
  const base = await deploy(DEX.token, ['Base', 'BASE', 18, 0n, 0]);
  const quote = await deploy(DEX.token, ['Quote (stands for the native coin)', 'QUOTE', 18, 0n, 0]);
  const factory = await deploy(DEX.factory, [dep]);
  const router = await deploy(DEX.router, [factory, quote]);
  await send(dep, factory, I.factory, 'createPair', [base, quote]);
  const pair = '0x' + (await w.call(factory, I.factory.encodeFunctionData('getPair', [base, quote]))).slice(26);
  const mint = (tok, to, v) => send(dep, tok, I.token, 'mint', [to, v]);
  for (const a of [ACT.lp, ACT.victim, ACT.attacker, ACT.noise, ACT.arb, ACT.liq]) {
    await mint(base, a, 10n ** 30n); await mint(quote, a, 10n ** 30n);
    await send(a, base, I.token, 'approve', [router, MaxUint256]); await send(a, quote, I.token, 'approve', [router, MaxUint256]);
  }
  await send(ACT.lp, router, I.router, 'addLiquidity', [base, quote, W(pool.base), W(pool.quote), 0n, 0n, ACT.lp, 4_000_000_000n]);
  const d = {
    w, base, quote, factory, router, pair, send,
    async reserves() {
      const [r0, r1] = I.pair.decodeFunctionResult('getReserves', await w.call(pair, I.pair.encodeFunctionData('getReserves')));
      return base.toLowerCase() < quote.toLowerCase() ? { rb: BigInt(r0), rq: BigInt(r1) } : { rb: BigInt(r1), rq: BigInt(r0) };
    },
    /** price of 1 base in quote wei (spot) */
    async spot() { const { rb, rq } = await d.reserves(); return rq * E / rb; },
    async bal(tok, who) { return BigInt(I.token.decodeFunctionResult('balanceOf', await w.call(tok, I.token.encodeFunctionData('balanceOf', [who])))[0]); },
    /** a router swap: exact `amountIn` of `from` token; returns { ok, out } */
    async swap(who, from, amountIn, minOut = 0n) {
      const to = from === base ? quote : base;
      const before = await d.bal(to, who);
      const r = await w.tx(who, router, I.router.encodeFunctionData('swapExactTokensForTokens', [amountIn, minOut, [from, to], who, 4_000_000_000n]));
      return { ok: r.ok, out: (await d.bal(to, who)) - before };
    },
    async quoteOut(from, amountIn) {
      const { rb, rq } = await d.reserves();
      const [rIn, rOut] = from === base ? [rb, rq] : [rq, rb];
      return amountIn * 997n * rOut / (rIn * 1000n + amountIn * 997n);
    },
    /// Accrues the pair's cumulative prices up to now (no trade), so a TWAP covers the time since the last touch.
    async sync() { await send(ACT.noise, pair, I.pair, 'sync', []); },
    async cumulative() {
      const c = BigInt(I.pair.decodeFunctionResult('price0CumulativeLast', await w.call(pair, I.pair.encodeFunctionData('price0CumulativeLast')))[0]);
      const c1 = BigInt(I.pair.decodeFunctionResult('price1CumulativeLast', await w.call(pair, I.pair.encodeFunctionData('price1CumulativeLast')))[0]);
      return base.toLowerCase() < quote.toLowerCase() ? c : c1; // price of base in quote, UQ112.112 x seconds
    },
  };
  // seeded noise traders: 8 random swaps of up to 1% of the pool, one block apart
  const r = rng(seed);
  for (let i = 0; i < 8; i++) {
    const { rb, rq } = await d.reserves();
    const sellBase = r.bool();
    const amt = (sellBase ? rb : rq) * BigInt(1 + r.int(100)) / 10_000n;
    await d.swap(ACT.noise, sellBase ? base : quote, amt);
    w.advance(12, 1);
  }
  return d;
}

// ------------------------------------------------------------------------------------------- scenarios

async function sandwich(sc, seed) {
  const d = await dexWorld(seed, sc.pool);
  const x = W(sc.victim);
  const fair = await d.quoteOut(d.quote, x);
  const minOut = fair * BigInt(10_000 - sc.slippageBps) / 10_000n;
  // without the attack (reference)
  const s0 = await d.w.snapshot();
  const plain = await d.swap(ACT.victim, d.quote, x, minOut);
  await d.w.revert(s0);
  // the attacker searches the front-run size: the largest that still lets the victim's swap through is the most
  // harmful (the victim then gets just over its minimum)
  let best = { loss: 0n, profit: 0n, front: 0n };
  const { rq } = await d.reserves();
  let lo = 0n, hi = rq; // front-run sizes in quote
  for (let i = 0; i < 40 && hi - lo > E / 1000n; i++) {
    const f = (lo + hi) / 2n;
    const s = await d.w.snapshot();
    const qBefore = await d.bal(d.quote, ACT.attacker);
    const fr = await d.swap(ACT.attacker, d.quote, f);
    const v = await d.swap(ACT.victim, d.quote, x, minOut);
    if (fr.ok && v.ok) {
      await d.swap(ACT.attacker, d.base, fr.out);
      const profit = (await d.bal(d.quote, ACT.attacker)) - qBefore;
      const loss = plain.out - v.out; // in base units: valued at the fair price below
      if (loss > best.loss) best = { loss, profit, front: f };
      lo = f;
    } else hi = f;
    await d.w.revert(s);
  }
  // the victim's loss in quote wei: the base it did not get, at the price it saw
  const lossQuote = best.loss * x / (plain.out || 1n);
  return { loss: lossQuote, detail: { victimIn: x.toString(), minOut: minOut.toString(), plainOut: plain.out.toString(), frontRun: best.front.toString(), attackerProfit: best.profit.toString() } };
}

async function oracle(sc, seed) {
  const d = await dexWorld(seed, sc.pool);
  const liquidity = W(sc.lenderLiquidity);
  const ltv = BigInt(sc.ltvBps);
  const flash = W(sc.flash);
  let best = { loss: 0n, pump: 0n, collateral: 0n };
  for (const frac of [1n, 2n, 5n, 10n, 20n, 50n, 100n]) { // the pump: frac% of the flash liquidity
    const pump = flash * frac / 100n;
    for (const cfrac of [1n, 5n, 10n, 25n]) {          // the collateral posted: cfrac% of the base pool
      const s = await d.w.snapshot();
      const { rb } = await d.reserves();
      const collateral = rb * cfrac / 100n;
      const fairPrice = await d.spot();
      let seen;
      if (sc.pricing === 'spot') {
        await d.swap(ACT.attacker, d.quote, pump);
        seen = await d.spot();
      } else {
        // TWAP over `window` s: the attacker pumps, an arbitrageur trades it back after `holdBlocks` blocks. The
        // pump only counts for the blocks it is held, so a longer window dilutes it (the point of a TWAP oracle).
        await d.sync(); // accrue up to the window's start
        const c0 = await d.cumulative();
        const t0 = d.w.env.timestamp;
        const pre = await d.reserves();
        d.w.advance(12, 1);
        const p = await d.swap(ACT.attacker, d.quote, pump);
        d.w.advance(12 * sc.holdBlocks, sc.holdBlocks);
        await d.swap(ACT.arb, d.base, p.out); // the arbitrageur sells the base back, restoring the price
        d.w.advance(Math.max(12, sc.window - 12 * (sc.holdBlocks + 1)), 1);
        await d.sync(); // accrue the restored-price period up to now (no trivial trade, which would revert)
        const c1 = await d.cumulative();
        const dt = BigInt(d.w.env.timestamp - t0);
        seen = dt > 0n ? ((c1 - c0) * E) / (dt << 112n) : pre.rq * E / pre.rb;
      }
      const borrowable = collateral * seen / E * ltv / 10_000n;
      const lent = borrowable > liquidity ? liquidity : borrowable;
      const worth = collateral * fairPrice / E;
      const loss = lent > worth ? lent - worth : 0n; // the lender's bad debt once the price is back
      if (loss > best.loss) best = { loss, pump, collateral };
      await d.w.revert(s);
    }
  }
  return { loss: best.loss, detail: { pump: best.pump.toString(), collateral: best.collateral.toString() } };
}

async function cascade(sc, seed) {
  const d = await dexWorld(seed, sc.pool);
  const r = rng(seed * 7919 + 1);
  const p0 = await d.spot();
  const th = BigInt(sc.thresholdBps), bonus = BigInt(sc.bonusBps);
  // borrowers: collateral 1k..20k base, debt between 60% and 99% of the liquidation threshold
  const positions = Array.from({ length: sc.borrowers }, () => {
    const c = W(1000 + r.int(19_000));
    const debt = c * p0 / E * th / 10_000n * BigInt(60 + r.int(40)) / 100n;
    return { c, debt, open: true };
  });
  let worst = { loss: 0n, shock: 0n, liquidated: 0 };
  for (const shockS of sc.shocks) {
    const s = await d.w.snapshot();
    const shock = W(shockS);
    await d.swap(ACT.attacker, d.base, shock); // the attacker dumps base
    const ps = positions.map((p) => ({ ...p }));
    let bad = 0n, liquidated = 0;
    for (let round = 0; round < 20; round++) {
      const price = await d.spot();
      const due = ps.filter((p) => p.open && p.c * price / E * th / 10_000n < p.debt);
      if (!due.length) break;
      for (const p of due) {
        p.open = false;
        liquidated++;
        // the liquidator repays the debt and takes collateral worth debt x (1 + bonus) at the spot price, or all of it
        const want = p.debt * (10_000n + bonus) / 10_000n * E / price;
        const seized = want > p.c ? p.c : want;
        const got = (await d.swap(ACT.liq, d.base, seized)).out; // sold into the same pool
        if (got < p.debt) bad += p.debt - got;                   // what the protocol cannot recover
      }
    }
    if (bad > worst.loss) worst = { loss: bad, shock, liquidated };
    await d.w.revert(s);
  }
  return { loss: worst.loss, detail: { shock: worst.shock.toString(), liquidated: String(worst.liquidated) } };
}

const RUN = { sandwich, oracle, cascade };

/** Code identity of what was simulated: keccak256 of each artifact's creation code (zetaphy-dex/artifacts). */
export const dexCodeHashes = () => Object.fromEntries(Object.entries(DEX).map(([k, a]) => [k, keccak256(a.bytecode)]));

/** Runs the scenario set for every seed: the canonical report, its hash and the bound. */
export async function simulate({ scenarios = DEFAULT_SCENARIOS, seeds = DEFAULT_SEEDS, log = () => {} } = {}) {
  const out = [];
  let max = 0n;
  for (const sc of scenarios) {
    const fn = RUN[sc.kind];
    if (!fn) throw new Error(`econ: unknown scenario kind ${sc.kind}`);
    const runs = [];
    let sMax = 0n;
    for (const seed of seeds) {
      const r = await fn(sc, seed);
      runs.push({ seed, loss: r.loss.toString(), detail: r.detail });
      if (r.loss > sMax) sMax = r.loss;
      log(`  ${sc.id} seed ${seed}: loss ${r.loss}`);
    }
    if (sMax > max) max = sMax;
    out.push({ id: sc.id, kind: sc.kind, params: sc, runs, maxLoss: sMax.toString() });
  }
  const report = {
    kind: ECON_KIND, v: 1, unit: 'wei of the quote token (18 decimals; stands for the native coin)',
    code: dexCodeHashes(), scenariosHash: scenariosHash(scenarios, seeds), seeds: [...seeds],
    scenarios: out, maxExtractableLoss: max.toString(),
    statement: `max extractable loss under the ${scenarios.length} scenario(s) x ${seeds.length} seed(s) <= ${max}`,
  };
  return { report, reportHash: econReportHash(report), bound: max, scenariosHash: report.scenariosHash };
}

/** EconomicBounds.commitmentOf. */
export { canonicalJson };
