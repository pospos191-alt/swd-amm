// ZetaphyOracle + TwapRecorder + ZetaphyPythRelay on an in-memory EVM, with the real
// ZETAPHY DEX pair (zetaphy-dex artifacts): a price or a clear revert, never a wrong value.
// Manipulation attempts: a swap in the same transaction as the read, a pool pushed for a
// block, a shallow pool, too few observations, a stale / wide / future / negative Pyth
// price, sources that disagree, decimals, jumps (the circuit breaker), and the roles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, keccak256, encodeBytes32String } from 'ethers';
import { createChain } from './helpers/evm.js';
import { mockArtifacts, dexArt } from './helpers/mocks.js';

const E18 = 10n ** 18n;
const FEED = encodeBytes32String('ZETAPHY/USD');
const ZERO = '0x' + '00'.repeat(20);
const coder = AbiCoder.defaultAbiCoder();
const BPS = (x, y) => ((x > y ? x - y : y - x) * 10_000n) / (x < y ? x : y);

/** A chain with the DEX, an asset/USD pool, the recorder, a mock Pyth and the oracle. */
async function setup({ assetDec = 18, quoteDec = 6, assetAmt = 1000n, quoteAmt = 2000n, twap = true, pyth = true,
  window = 1800, minObs = 5, maxGap = 2000, minLiq = 1000n * E18, guards = [200, 1500, 3000, 3600] } = {}) {
  const c = await createChain(['gov', 'guardian', 'keeper', 'attacker', 'eve']);
  const A = (n) => c.acct[n].toString();
  const factory = await c.deployRaw(dexArt('ZetaphyFactory'), [A('gov')], 'gov');
  const asset = await c.deployRaw(dexArt('TestToken'), ['Wrapped ZETAPHY', 'WZ', assetDec, 10n ** 40n, 0], 'gov');
  const usd = await c.deployRaw(dexArt('TestToken'), ['Test USD', 'tUSD', quoteDec, 10n ** 40n, 0], 'gov');
  await factory.send('gov', 'createPair', [asset.address, usd.address]);
  const pairAddr = await factory.call('getPair', [asset.address, usd.address]);
  const pairIface = new Interface(dexArt('ZetaphyPair').abi);
  const pair = { address: pairAddr, send: (from, fn, args = []) => c.sendTo(from, pairAddr, pairIface, fn, args), call: (fn, args = []) => c.callAt(pairAddr, pairIface, fn, args) };
  const addLiquidity = async (a, q) => {
    await asset.send('gov', 'transfer', [pairAddr, a]);
    await usd.send('gov', 'transfer', [pairAddr, q]);
    await pair.send('gov', 'mint', [A('gov')]);
  };
  await addLiquidity(assetAmt * 10n ** BigInt(assetDec), quoteAmt * 10n ** BigInt(quoteDec));
  const recorder = await c.deploy('TwapRecorder', [60], 'gov');
  const mp = await c.deployRaw(mockArtifacts().MockPyth, [], 'gov');
  const oracle = await c.deploy('ZetaphyOracle', [A('gov'), recorder.address, mp.address], 'gov');
  if (twap) await oracle.send('gov', 'setTwap', [asset.address, pairAddr, window, minObs, maxGap, minLiq]);
  if (pyth) await oracle.send('gov', 'setPythFeed', [asset.address, FEED, 120, 100]);
  await oracle.send('gov', 'setGuards', [asset.address, ...guards]);
  await oracle.send('gov', 'setGuardian', [A('guardian'), true]);
  const P = { price: (assetAmt * 10n ** 8n * quoteAmt) / assetAmt / assetAmt, conf: 10n ** 5n }; // Pyth price, expo -8 (the pool's price)
  const setPyth = (price = P.price, conf = P.conf, expo = -8, at = c.now()) => mp.send('gov', 'set', [FEED, price, conf, expo, at]);
  /** The keeper: n rounds of `step` seconds, Pyth updated, then poke. */
  const keep = async (n, step = 60, pythPrice = P.price) => {
    for (let i = 0; i < n; i++) { c.advance(step); if (pyth) await setPyth(pythPrice); await oracle.send('keeper', 'poke', [asset.address]); }
  };
  return { c, A, factory, asset, usd, pair, addLiquidity, recorder, mp, oracle, setPyth, keep, P };
}

const priceOf = (o, asset) => o.oracle.call('price', [asset ?? o.asset.address]);

test('both sources agree: Pyth\'s price, anchored by the TWAP, normalized to 18 decimals', async () => {
  const o = await setup();
  await assert.rejects(priceOf(o), /TwapUnavailable/, 'no observation history yet');
  await o.keep(35);
  const [v, at] = await priceOf(o);
  assert.equal(v, 2n * E18, '$2.00 (Pyth 200000000 x 10^-8)');
  assert.ok(at <= o.c.now() && at > o.c.now() - 120n);
  const [tv, , problem] = await o.oracle.call('livePrice', [o.asset.address]);
  assert.equal(problem, 0n);
  assert.equal(tv, 2n * E18);
  // the TWAP alone also says $2 (18-decimal asset, 6-decimal USD)
  await o.oracle.send('gov', 'setPythFeed', [o.asset.address, '0x' + '00'.repeat(32), 0, 0]);
  await o.keep(1);
  const [twapOnly] = await priceOf(o);
  assert.ok(BPS(twapOnly, 2n * E18) <= 1n, `${twapOnly}`);
});

test('decimals: an 8-decimal asset against an 18-decimal USD token', async () => {
  const o = await setup({ assetDec: 8, quoteDec: 18, assetAmt: 500n, quoteAmt: 1500n, pyth: false });
  await o.keep(35);
  const [v] = await priceOf(o);
  assert.ok(BPS(v, 3n * E18) <= 1n, `$3: ${v}`);
  // Pyth with exponent -5 and 0 normalizes the same way
  const p = await setup({ pyth: true, twap: false });
  await p.mp.send('gov', 'set', [FEED, 200000n, 100n, -5, p.c.now()]);
  await p.oracle.send('keeper', 'poke', [p.asset.address]);
  assert.equal((await priceOf(p))[0], 2n * E18);
  await p.mp.send('gov', 'set', [FEED, 2n, 0n, 0, p.c.now()]);
  await p.oracle.send('keeper', 'poke', [p.asset.address]);
  assert.equal((await priceOf(p))[0], 2n * E18);
});

test('a swap in the same transaction as the read moves nothing (single-block manipulation)', async () => {
  const o = await setup({ pyth: false });
  await o.keep(35);
  const [before] = await priceOf(o);
  o.c.advance(1); // the attacker's transaction opens the next block
  const atk = await o.c.deployRaw(mockArtifacts().SameBlockAttacker, [], 'attacker');
  await o.usd.send('gov', 'transfer', [atk.address, 50_000n * 10n ** 6n]);
  // 25x the pool's USD side in: the spot price of the asset goes up ~600x for this block
  const ev = await atk.send('attacker', 'attack', [o.pair.address, o.usd.address, 50_000n * 10n ** 6n, o.oracle.address, o.asset.address]);
  const r = ev.find((e) => e?.name === 'Result');
  assert.equal(r.args.priced, true, 'still priced');
  assert.equal(r.args.value, before, 'the same TWAP: the swap of this block counts for 0 seconds');
  const [r0, r1] = await o.pair.call('getReserves');
  const spot = (r1 * 10n ** 12n * E18) / r0; // USD per asset, 18 decimals
  assert.ok(spot > 500n * before, `the spot was pushed (${spot})`);
  assert.equal((await o.oracle.call('stateOf', [o.asset.address])).tripped, false);
});

test('a pool pushed for a block shows as a spike: no price (TwapSpike), never the pushed one', async () => {
  const o = await setup({ pyth: false });
  await o.keep(35);
  const atk = await o.c.deployRaw(mockArtifacts().SameBlockAttacker, [], 'attacker');
  await o.usd.send('gov', 'transfer', [atk.address, 5_000n * 10n ** 6n]);
  const ref = (await o.oracle.call('stateOf', [o.asset.address])).lastPrice;
  await atk.send('attacker', 'push', [o.pair.address, o.usd.address, 5_000n * 10n ** 6n]); // left pushed at the end of the block
  o.c.advance(1); // the next block
  await assert.rejects(priceOf(o), /TwapSpike/);
  const ev = await o.oracle.send('keeper', 'poke', [o.asset.address]);
  assert.ok(ev.some((e) => e?.name === 'SourceProblem' && e.args.problem === 6n), 'logged for the monitor');
  assert.equal((await o.oracle.call('stateOf', [o.asset.address])).lastPrice, ref, 'the reference did not move');
});

test('a shallow pool (low liquidity) and too few observations give no price', async () => {
  const shallow = await setup({ pyth: false, assetAmt: 10n, quoteAmt: 20n }); // $20 of USD in the pool, $1,000 needed
  await shallow.keep(35);
  await assert.rejects(priceOf(shallow), /LowLiquidity/);
  // depth must hold at every observation: a pool deepened only now is still refused
  await shallow.addLiquidity(10_000n * E18, 20_000n * 10n ** 6n);
  shallow.c.advance(60);
  assert.equal((await shallow.oracle.call('livePrice', [shallow.asset.address]))[2], 5n, 'LowLiquidity: the old observations were shallow');
  const few = await setup({ pyth: false, minObs: 10 });
  await few.keep(5, 700); // observations 700 s apart: the 1,800 s window holds 4
  await assert.rejects(priceOf(few), /TooFewObservations/);
  const stale = await setup({ pyth: false });
  await stale.keep(35);
  stale.c.advance(3 * 1800); // the keeper stopped: the newest observation old enough is too old
  await assert.rejects(priceOf(stale), /TwapStale/);
});

test('Pyth: stale, future-dated, negative or with a wide confidence interval is refused', async () => {
  const o = await setup({ twap: false });
  await o.setPyth();
  await o.oracle.send('keeper', 'poke', [o.asset.address]);
  assert.equal((await priceOf(o))[0], 2n * E18);
  o.c.advance(121);
  await assert.rejects(priceOf(o), /PythStale/);
  const ev = await o.oracle.send('keeper', 'poke', [o.asset.address]);
  assert.ok(ev.some((e) => e?.name === 'StaleFeed' && e.args.source === 2n), 'StaleFeed logged');
  await o.setPyth(o.P.price, o.P.conf, -8, o.c.now() + 3600n);
  await assert.rejects(priceOf(o), /PythInvalid/);
  await o.setPyth(-o.P.price);
  await assert.rejects(priceOf(o), /PythInvalid/);
  await o.setPyth(o.P.price, o.P.price / 20n); // conf 5% > 1%
  await assert.rejects(priceOf(o), /PythConfidence/);
  await o.setPyth();
  assert.equal((await priceOf(o))[0], 2n * E18);
});

test('sources that disagree beyond maxDeviation: no price (SourcesDeviate), DeviationTripped logged', async () => {
  const o = await setup();
  await o.keep(35);
  await o.setPyth((o.P.price * 103n) / 100n); // Pyth 3% above the TWAP, 2% allowed
  await assert.rejects(priceOf(o), /SourcesDeviate/);
  const ev = await o.oracle.send('keeper', 'poke', [o.asset.address]);
  const d = ev.find((e) => e?.name === 'DeviationTripped');
  assert.ok(d && d.args.bps >= 290n, 'logged with both prices');
  await o.setPyth((o.P.price * 101n) / 100n); // 1%: within
  assert.equal((await priceOf(o))[0], (2n * E18 * 101n) / 100n);
});

test('circuit breaker: a jump is refused; a poke that sees it trips the feed until governance resets it', async () => {
  const o = await setup({ twap: false, guards: [200, 1500, 3000, 3600] });
  await o.setPyth();
  await assert.rejects(priceOf(o), /NoReference/, 'a feed needs a first poke');
  await o.oracle.send('keeper', 'poke', [o.asset.address]);
  o.c.advance(10);
  await o.setPyth((o.P.price * 120n) / 100n); // +20% > 15%
  await assert.rejects(priceOf(o), /PriceJump/);
  const ev = await o.oracle.send('keeper', 'poke', [o.asset.address]);
  assert.ok(ev.some((e) => e?.name === 'CircuitBreakerTripped'));
  await o.setPyth(); // back to normal: still tripped
  await assert.rejects(priceOf(o), /BreakerTripped/);
  await assert.rejects(o.oracle.send('guardian', 'resetCircuitBreaker', [o.asset.address]), /NotGovernance/);
  await o.oracle.send('gov', 'resetCircuitBreaker', [o.asset.address]);
  await o.oracle.send('keeper', 'poke', [o.asset.address]);
  assert.equal((await priceOf(o))[0], 2n * E18);
  // per window: three +10% steps inside an hour pass one by one, but not past +30% of the window's start
  for (const pct of [110n, 121n]) { o.c.advance(60); await o.setPyth((o.P.price * pct) / 100n); assert.equal(await o.oracle.call('poke', [o.asset.address]), true); await o.oracle.send('keeper', 'poke', [o.asset.address]); }
  o.c.advance(60);
  await o.setPyth((o.P.price * 133n) / 100n);
  await assert.rejects(priceOf(o), /PriceJump/);
});

test('roles: a guardian pauses a feed at once; unpausing and every setting are governance\'s (the timelock)', async () => {
  const o = await setup({ twap: false });
  await o.setPyth();
  await o.oracle.send('keeper', 'poke', [o.asset.address]);
  await assert.rejects(o.oracle.send('eve', 'pauseFeed', [o.asset.address]), /NotGuardian/);
  await o.oracle.send('guardian', 'pauseFeed', [o.asset.address]);
  await assert.rejects(priceOf(o), /FeedIsPaused/);
  await assert.rejects(o.oracle.send('guardian', 'unpauseFeed', [o.asset.address]), /NotGovernance/);
  for (const [fn, args] of [['setTwap', [o.asset.address, ZERO, 0, 0, 0, 0]], ['setPythFeed', [o.asset.address, FEED, 1, 1]], ['setGuards', [o.asset.address, 1, 1, 1, 1]],
    ['setPyth', [ZERO]], ['setGuardian', [o.A('eve'), true]], ['setGovernance', [o.A('eve')]], ['resetCircuitBreaker', [o.asset.address]]]) {
    await assert.rejects(o.oracle.send('guardian', fn, args), /NotGovernance/, fn);
  }
  await o.oracle.send('gov', 'unpauseFeed', [o.asset.address]);
  assert.equal((await priceOf(o))[0], 2n * E18);
  await assert.rejects(priceOf({ ...o, asset: { address: o.A('eve') } }), /UnknownAsset/);
  // bad settings are refused
  await assert.rejects(o.oracle.send('gov', 'setGuards', [o.asset.address, 0, 1, 1, 1]), /BadConfig/);
  await assert.rejects(o.oracle.send('gov', 'setTwap', [o.A('eve'), o.pair.address, 1800, 5, 2000, 1n]), /BadConfig/, 'the asset must be in the pair');
});

test('TwapRecorder: anyone records, at most once per minSpacing, never twice in a block; ring of 96', async () => {
  const o = await setup({ pyth: false });
  assert.equal(await o.recorder.call('record', [o.pair.address]), true);
  await o.recorder.send('eve', 'record', [o.pair.address]);
  assert.equal(await o.recorder.call('record', [o.pair.address]), false, 'same block: no');
  o.c.advance(59);
  assert.equal(await o.recorder.call('record', [o.pair.address]), false, 'within minSpacing: no');
  for (let i = 0; i < 100; i++) { o.c.advance(60); await o.recorder.send('eve', 'record', [o.pair.address]); }
  assert.equal(await o.recorder.call('count', [o.pair.address]), 96n);
  const newest = await o.recorder.call('observation', [o.pair.address, 0]);
  assert.equal(newest.time, o.c.now());
});

test('ZetaphyPythRelay: Pyth\'s update format, only relayers, a threshold of identical updates, older ones ignored', async () => {
  const c = await createChain(['gov', 'r1', 'r2', 'eve']);
  const A = (n) => c.acct[n].toString();
  const relay = await c.deploy('ZetaphyPythRelay', [A('gov'), [A('r1'), A('r2')], 2], 'gov');
  // abi.encode(PythStructs.PriceFeed, uint64 prevPublishTime), as Pyth's MockPyth.createPriceFeedUpdateData builds it
  const upd = (price, t) => coder.encode(['tuple(bytes32 id, tuple(int64 price, uint64 conf, int32 expo, uint256 publishTime) price, tuple(int64 price, uint64 conf, int32 expo, uint256 publishTime) emaPrice)', 'uint64'],
    [[FEED, [price, 1000n, -8, t], [price, 1000n, -8, t]], t - 1n]);
  const u1 = upd(200_000_000n, c.now());
  await assert.rejects(relay.send('eve', 'updatePriceFeeds', [[u1]]), /NotRelayer/);
  await relay.send('r1', 'updatePriceFeeds', [[u1]]);
  await assert.rejects(relay.call('getPriceUnsafe', [FEED]), /PriceFeedNotFound/, 'one of two relayers: not yet');
  await relay.send('r1', 'updatePriceFeeds', [[u1]]);
  await assert.rejects(relay.call('getPriceUnsafe', [FEED]), /PriceFeedNotFound/, 'the same relayer twice counts once');
  await relay.send('r2', 'updatePriceFeeds', [[upd(999n, c.now())]]);
  await assert.rejects(relay.call('getPriceUnsafe', [FEED]), /PriceFeedNotFound/, 'a different update does not count');
  const ev = await relay.send('r2', 'updatePriceFeeds', [[u1]]);
  assert.ok(ev.some((e) => e?.name === 'PriceFeedUpdate' && e.args.price === 200_000_000n));
  assert.equal((await relay.call('getPriceUnsafe', [FEED])).price, 200_000_000n);
  // an older update is ignored (not an error), a future one refused, value refused
  c.advance(10);
  const old = upd(1n, c.now() - 20n);
  await relay.send('r1', 'updatePriceFeeds', [[old]]); await relay.send('r2', 'updatePriceFeeds', [[old]]);
  assert.equal((await relay.call('getPriceUnsafe', [FEED])).price, 200_000_000n);
  await assert.rejects(relay.send('r1', 'updatePriceFeeds', [[upd(5n, c.now() + 3600n)]]), /InvalidUpdateData/);
  await assert.rejects(relay.send('r1', 'updatePriceFeeds', [[u1]], 1n), /NoFee/);
  await assert.rejects(relay.call('getPriceNoOlderThan', [FEED, 5]), /StalePrice/);
  assert.equal(await relay.call('getUpdateFee', [[u1]]), 0n);
  for (const [fn, args] of [['setRelayer', [A('eve'), true]], ['setThreshold', [1]], ['setGovernance', [A('eve')]]]) await assert.rejects(relay.send('r1', fn, args), /NotGovernance/);
  // the oracle reads the relay as it would read Pyth
  const recorder = await c.deploy('TwapRecorder', [60], 'gov');
  const oracle = await c.deploy('ZetaphyOracle', [A('gov'), recorder.address, relay.address], 'gov');
  await oracle.send('gov', 'setPythFeed', [A('eve'), FEED, 120, 100]);
  await oracle.send('gov', 'setGuards', [A('eve'), 200, 1500, 3000, 3600]);
  await oracle.send('eve', 'poke', [A('eve')]);
  assert.equal((await oracle.call('price', [A('eve')]))[0], 2n * E18);
  assert.equal(keccak256(u1).length, 66);
});

test('Pyth update encoding: Hermes JSON to the relay\'s format and back', async () => {
  const { encodePriceFeed, decodePriceFeed, fromHermes, hermesUrl, usd } = await import('../src/oracle.js');
  const id = '0x' + 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace'.slice(0, 64);
  const [d] = fromHermes({ parsed: [{ id: id.slice(2), price: { price: '311234500000', conf: '150000000', expo: -8, publish_time: 1800000000 },
    ema_price: { price: '311000000000', conf: '140000000', expo: -8, publish_time: 1800000000 }, metadata: { prev_publish_time: 1799999999 } }] });
  const f = decodePriceFeed(d);
  assert.equal(f.id, id);
  assert.equal(f.price, 311234500000n);
  assert.equal(f.expo, -8);
  assert.equal(f.prevPublishTime, 1799999999n);
  assert.equal(encodePriceFeed({ id, price: 311234500000n, conf: 150000000n, expo: -8, publishTime: 1800000000, emaPrice: 311000000000n, emaConf: 140000000n, prevPublishTime: 1799999999 }), d);
  assert.throws(() => fromHermes({ parsed: [{ id: id.slice(2), price: { price: 'x' } }] }), /malformed/);
  assert.throws(() => fromHermes({}), /no parsed/);
  assert.match(hermesUrl([id]), /^https:\/\/hermes\.pyth\.network\/v2\/updates\/price\/latest\?ids%5B%5D=0xff61.*&parsed=true$/);
  assert.throws(() => hermesUrl([id], 'http://evil.example'), /https/);
  assert.equal(usd(2n * 10n ** 18n + 5n * 10n ** 16n), '$2.05');
});
