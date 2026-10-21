// Honeypot check: a simulated buy and sell in one read-only eth_call with a
// state override (src/honeypot.js). Two kinds of test:
//   - fake RPCs (as in stylus.test.js) for each answer an endpoint can give;
//   - the real TradeSim bytecode on the in-memory EVM, against a mock
//     Uniswap-V2 DEX placed at PancakeSwap's addresses, with tokens that
//     tax or block selling under harmless function names, and tokens that
//     sell only when they recognise the simulation (SimAware).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { explain, LANGS } from '../src/explain.js';
import { verdictOf } from '../src/verdict.js';
import { CHAINS } from '../src/chains.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { taxPercent, runCalldata, simPlan, jobSimSeed, isReservedAddress } from '../src/honeypot.js';
import { simFindings } from '../src/analyze.js';
import { TRADESIM_CODE, TRADESIM_RUN } from '../src/tradesim.generated.js';
import { compileTradeSim } from '../scripts/build-tradesim.js';
import { createLocalChain } from './helpers/local-chain.js';
import { FLAGGED } from './helpers/test-signatures.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);
const DEX = CHAINS.bsc.dex;
const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n) => BigInt(n).toString(16).padStart(64, '0');
const PAIR = '0x' + 'aa'.repeat(20);
const RAND = '0x' + '5e'.repeat(32);
/** The TradeSim call among recorded RPC calls: the eth_call with a state override. */
const simCallOf = (seen) => seen.find((c) => c.method === 'eth_call' && c.params?.[2]);
/** run(...) calldata -> its arguments (6 words after the selector). */
function decodeRun(data) {
  const h = data.slice(10);
  const w = (i) => h.slice(i * 64, i * 64 + 64);
  return { router: '0x' + w(0).slice(24), token: '0x' + w(3).slice(24), amountIn: BigInt('0x' + w(4)), sellBps: BigInt('0x' + w(5)) };
}

test('committed TradeSim bytecode matches contracts/TradeSim.sol (run `npm run tradesim` if this fails)', () => {
  const { runtime, runSelector } = compileTradeSim();
  assert.equal(TRADESIM_CODE, runtime);
  assert.equal(TRADESIM_RUN, runSelector);
  // Compiled for Paris: no PUSH0 (0x5f) opcode, so any EVM chain can run it.
  // (Checked by walking opcodes, skipping PUSH data.)
  const code = Buffer.from(TRADESIM_CODE.slice(2), 'hex');
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    assert.notEqual(op, 0x5f, `PUSH0 at ${i}`);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
});

test('tax is measured against the router quote, floored to 0.1%', () => {
  assert.equal(taxPercent('1000', '1000'), 0);
  assert.equal(taxPercent('1000', '1010'), 0, 'more than quoted (reflection) is no tax');
  assert.equal(taxPercent('1000', '951'), 4.9);
  assert.equal(taxPercent('1000', '0'), 100);
  // The token's own integer rounding (a fee of floor(v * 5%)) is forgiven: still 5%.
  assert.equal(taxPercent('1000000000000', '950000000001'), 5);
  assert.equal(taxPercent('1000000000000', '950500000000'), 4.9);
  assert.equal(taxPercent('0', '0'), null);
});

test('thresholds: ok under 10%, medium from 10%, high over 50%, cannot sell from 99%', () => {
  const done = (buy, sell, sold = '1') => simFindings({ dex: 'D', native: 'W', stage: 'done', buyTax: buy, sellTax: sell, bought: '1', sold });
  const pick = (fs) => fs.map((f) => `${f.id}:${f.severity}`).join();
  assert.equal(pick(done(0, 9.9)), 'sim-ok:good');
  assert.equal(pick(done(10, 0)), 'sim-high-tax:medium');
  assert.equal(pick(done(3, 50)), 'sim-high-tax:medium');
  assert.equal(pick(done(3, 50.1)), 'sim-high-tax:high');
  assert.equal(pick(done(0, 99)), 'sim-cannot-sell:high');
  assert.equal(pick(done(0, 0, '0')), 'sim-cannot-sell:high');
  assert.equal(pick(simFindings({ stage: 'sell-failed', bought: '0', buyTax: 100 })), 'sim-high-tax:high', 'bought nothing');
  assert.equal(pick(simFindings({ stage: 'bad-router' })), 'sim-skipped:info');
  assert.deepEqual(simFindings(undefined), []);
});

// ------------------------------------------------------------- fake RPCs
// A real token's runtime code, so the reader sees ERC-20 functions.
let tokenCode;
before(async () => {
  const chain = await createLocalChain();
  tokenCode = await chain.rpc.call('eth_getCode', [await chain.deploy('CleanToken'), 'latest']);
});
const TOKEN = '0x' + '42'.repeat(20);

/**
 * Answers getPair with `pair`; the override call with `sim` (a function of
 * the params, or a value); eth_gasPrice with `gasPrice` (null: refuses it).
 */
function fakeRpc({ pair = PAIR, sim, gasPrice = '0x12a05f200' }) {
  const seen = [];
  return {
    seen,
    async call(method, params) {
      seen.push({ method, params });
      if (method === 'eth_getCode') return params[0] === TOKEN ? tokenCode : '0x';
      if (method === 'eth_getStorageAt') return '0x' + '0'.repeat(64);
      if (method === 'eth_gasPrice') { if (gasPrice == null) throw new Error('method not found'); return gasPrice; }
      if (method !== 'eth_call') throw new Error(method);
      const { to, data } = params[0];
      if (to === DEX.factory && data.startsWith('0xe6a43905')) return '0x' + word(pair);
      if (params[2]?.[to]) return typeof sim === 'function' ? sim(params) : sim;
      throw new Error('execution reverted');
    },
  };
}
/** ABI-encoded TradeSim.Result. */
const result = (stage, expectedBuy, bought, expectedSell = 0, sold = 0) =>
  '0x' + [stage, expectedBuy, bought, expectedSell, sold, 90000, 60000].map(uint).join('');
const read = (rpc, address = TOKEN) => readContract('bsc', address, { rpc, simulate: true });

test('pool found, sell reverts: buy-but-not-sell is high risk', async () => {
  const rpc = fakeRpc({ sim: result(4, 1000, 1000, 50) });
  const r = await read(rpc);
  const f = find(r, 'sim-cannot-sell');
  assert.equal(f.severity, 'high');
  assert.deepEqual(f.params, { dex: 'PancakeSwap V2', native: 'WBNB', buy: 0, sell: null });
  assert.equal(r.analysis.level, 'high');
  assert.equal(r.analysis.rulesLevel, 'info', 'the rules alone found nothing');
  assert.equal(r.sim.pair, PAIR);
  assert.equal(r.sim.stage, 'sell-failed');
  assert.equal(ids(r).at(-1), 'bytecode-only', 'the caveat stays last');
  // The override call: TradeSim code (plus a random tail) and some native
  // coin at the throwaway address, and coin for the caller; nothing else.
  const call = simCallOf(rpc.seen);
  const { to, from } = call.params[0];
  assert.equal(call.params[1], 'latest');
  assert.deepEqual(Object.keys(call.params[2]).sort(), [to, from].sort());
  assert.ok(call.params[2][to].code.startsWith(TRADESIM_CODE + 'fe'));
  assert.equal(call.params[2][from].code, undefined, 'the caller stays a plain account');
  const args = decodeRun(call.params[0].data);
  assert.ok(call.params[0].data.startsWith('0x' + TRADESIM_RUN));
  assert.deepEqual([args.router, args.token], [DEX.router.toLowerCase(), TOKEN]);
  assert.equal(String(args.amountIn), r.sim.amountIn);
  assert.ok(BigInt(call.params[2][to].balance) >= args.amountIn);
  assert.match(explain(r, 'th').lines.find((l) => l.id === 'sim-cannot-sell').text, /^ทดสอบขายไม่ผ่าน: .*ซื้อได้แต่ขายไม่ได้/);
  for (const L of Object.values(LANGS)) {
    // Wording states what the simulation saw; it never labels the token.
    const text = L.T['sim-cannot-sell']({ dex: 'PancakeSwap V2', buy: 0, sell: null });
    assert.doesNotMatch(text, /honeypot|scam|貔貅|ハニーポット|허니팟/i);
  }
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'sim-cannot-sell').text, /selling failed/);
});

test('high tax: medium over 10%, high over 50%', async () => {
  const medium = await read(fakeRpc({ sim: result(5, 1000, 950, 100, 80) }));
  assert.deepEqual(find(medium, 'sim-high-tax').params, { dex: 'PancakeSwap V2', native: 'WBNB', buy: 5, sell: 20 });
  assert.equal(find(medium, 'sim-high-tax').severity, 'medium');
  assert.equal(medium.analysis.level, 'medium');
  const high = await read(fakeRpc({ sim: result(5, 1000, 1000, 100, 30) }));
  assert.equal(find(high, 'sim-high-tax').severity, 'high');
  assert.match(explain(high, 'en').lines.find((l) => l.id === 'sim-high-tax').text, /0% when buying and 70% when selling/);
});

test('ok: round trip under 10% tax is a good sign, with the caveat', async () => {
  const r = await read(fakeRpc({ sim: result(5, 1000, 1000, 100, 98) }));
  const f = find(r, 'sim-ok');
  assert.equal(f.severity, 'good');
  assert.deepEqual([f.params.buy, f.params.sell], [0, 2]);
  assert.equal(r.analysis.level, 'info');
  const text = explain(r, 'en').lines.find((l) => l.id === 'sim-ok').text;
  assert.match(text, /0% buy, 2% sell/);
  assert.match(text, /current block/);
});

test('no pool: skipped with an info line, and no override call is made', async () => {
  const rpc = fakeRpc({ pair: '0x' + '00'.repeat(20), sim: () => assert.fail('no simulation without a pool') });
  const r = await read(rpc);
  assert.deepEqual(find(r, 'sim-skipped').params, { dex: 'PancakeSwap V2', native: 'WBNB', why: 'no-pool' });
  assert.equal(r.analysis.level, 'info');
  assert.ok(!rpc.seen.some((c) => c.method === 'eth_call' && c.params[2]), 'no state override sent');
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'sim-skipped').text, /No PancakeSwap V2 pool .* WBNB/);
  // A factory with no code (wrong chain or address) answers '0x': also "no pool".
  const empty = await read(fakeRpc({ pair: '', sim: () => assert.fail() }));
  assert.equal(empty.sim.stage, 'no-pool');
});

test('RPC rejects or ignores state overrides: skipped, never "safe"', async () => {
  const rejects = fakeRpc({ sim: () => { throw new Error('all RPC endpoints failed: state override not supported'); } });
  const r = await read(rejects);
  assert.equal(r.sim.stage, 'no-override');
  assert.match(r.sim.error, /state override/);
  assert.deepEqual(find(r, 'sim-skipped').params.why, 'no-override');
  assert.ok(!ids(r).includes('sim-ok'));
  // Dropping the override runs an address with no code: empty result.
  const ignores = await read(fakeRpc({ sim: '0x' }));
  assert.equal(ignores.sim.stage, 'no-override');
  assert.ok(ids(ignores).includes('sim-skipped'));
  assert.match(explain(ignores, 'th').lines.find((l) => l.id === 'sim-skipped').text, /state override/);
});

test('wrong router config or a failed pool lookup: skipped as an error', async () => {
  const bad = await read(fakeRpc({ sim: result(1, 0, 0) }));
  assert.equal(bad.sim.stage, 'bad-router');
  assert.equal(find(bad, 'sim-skipped').params.why, 'error');
  const down = { call: async (m, p) => (m === 'eth_getCode' ? tokenCode : m === 'eth_call' && p[0].to === DEX.factory ? Promise.reject(new Error('timeout')) : '0x' + '0'.repeat(64)) };
  const r = await read(down);
  assert.equal(r.sim.stage, 'error');
});

test('a buy that reverts: skipped, sell untested', async () => {
  const r = await read(fakeRpc({ sim: result(3, 1000, 0) }));
  assert.equal(find(r, 'sim-skipped').params.why, 'buy-failed');
  assert.equal(r.analysis.level, 'info');
});

test('off by default with an injected RPC, for official issuers and on chains without a DEX', async () => {
  const rpc = fakeRpc({ sim: () => assert.fail('not simulated') });
  const r = await readContract('bsc', TOKEN, { rpc });
  assert.equal(r.sim, undefined);
  assert.ok(!ids(r).some((id) => id.startsWith('sim-')));
  // USDT on BNB Chain: an official issuer's token is not simulated.
  const usdt = '0x55d398326f99059fF775485246999027B3197955';
  const official = fakeRpc({ sim: () => assert.fail('not simulated') });
  const k = await readContract('bsc', usdt, { rpc: { call: (m, p) => official.call(m, m === 'eth_getCode' ? [TOKEN] : p) }, simulate: true });
  assert.ok(!official.seen.some((c) => c.params[0]?.to === DEX.factory), 'no pool lookup either');
  assert.ok(ids(k).includes('known-issuer'));
  assert.equal(k.sim, undefined);
  const noDex = await readContract('zetaphy', TOKEN, { rpc: fakeRpc({ sim: () => assert.fail() }), simulate: true, chainConfig: { kind: 'evm', id: 77390, rpcs: [] } });
  assert.equal(noDex.sim, undefined);
});

// ------------------------------------- not recognisable as Neuro's test
test('two standalone checks use different addresses, code, amounts and shares', async () => {
  const a = fakeRpc({ sim: result(5, 1000, 1000, 100, 98) });
  const b = fakeRpc({ sim: result(5, 1000, 1000, 100, 98) });
  const ra = await read(a);
  const rb = await read(b);
  const [ca, cb] = [simCallOf(a.seen), simCallOf(b.seen)];
  assert.notEqual(ca.params[0].to, cb.params[0].to, 'TradeSim address');
  assert.notEqual(ca.params[0].from, cb.params[0].from, 'caller (tx.origin)');
  assert.notEqual(ca.params[0].to, '0x4e6575726f53696d000000000000000000000001', 'not the old fixed address');
  assert.notEqual(ca.params[2][ca.params[0].to].code, cb.params[2][cb.params[0].to].code, 'code hash');
  assert.notEqual(ca.params[0].data, cb.params[0].data, 'amount and share sold');
  assert.notEqual(ra.sim.amountIn, rb.sim.amountIn);
  // Same findings either way: taxes are measured against the router's quotes.
  assert.deepEqual(ids(ra), ids(rb));
  for (const c of [ca, cb]) {
    const { amountIn, sellBps } = decodeRun(c.params[0].data);
    assert.ok(amountIn >= BigInt(DEX.amountIn) * 3n / 4n && amountIn < BigInt(DEX.amountIn) * 5n / 4n, String(amountIn));
    assert.ok(sellBps >= 9000n && sellBps <= 9990n, String(sellBps));
    assert.ok(!isReservedAddress(c.params[0].to) && !isReservedAddress(c.params[0].from));
  }
});

test('a job-seeded check is the same on every runner of the job, and differs between jobs', async () => {
  const seed = jobSimSeed(7, RAND);
  const runner = async (s) => {
    const rpc = fakeRpc({ sim: result(4, 1000, 1000, 50) });
    const r = await readContract('bsc', TOKEN, { rpc, simulate: true, simSeed: s });
    return { call: simCallOf(rpc.seen), r };
  };
  const one = await runner(seed);
  const two = await runner(seed);
  assert.deepEqual(two.call.params, one.call.params, 'same addresses, code, amounts, gas and gas price');
  assert.equal(await verdictOf(one.r), await verdictOf(two.r));
  assert.deepEqual(one.r.sim, two.r.sim);
  const other = await runner(jobSimSeed(8, RAND));
  assert.notEqual(other.call.params[0].to, one.call.params[0].to);
  assert.notEqual((await runner(jobSimSeed(7, '0x' + '5f'.repeat(32)))).call.params[0].to, one.call.params[0].to, 'a new lottery, a new plan');
  // simPlan alone: the same seed gives the same plan.
  assert.deepEqual(simPlan(DEX, { seed }), simPlan(DEX, { seed }));
  assert.notDeepEqual(simPlan(DEX), simPlan(DEX));
});

test('jobSimSeed is keccak256("neuro-sim-job" || uint256 job || bytes32 lottery)', () => {
  const want = '0x' + Buffer.from(keccak_256(Buffer.concat([Buffer.from('neuro-sim-job'), Buffer.from(uint(7), 'hex'), Buffer.from(RAND.slice(2), 'hex')]))).toString('hex');
  assert.equal(jobSimSeed(7, RAND), want);
  assert.equal(jobSimSeed(7n, RAND.toUpperCase().replace('0X', '0x')), want);
  assert.throws(() => jobSimSeed(7, '0x1234'), /32 bytes/);
  assert.throws(() => simPlan(DEX, { seed: 'not hex' }), /hex/);
});

test('reserved addresses (precompiles, system contracts, OP predeploys) are never used', () => {
  for (const a of ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000001000',
    '0x00000000000000000000000000000000000000ff', '0x4200000000000000000000000000000000000006', '0xffffffffffffffffffffffffffffffffffffffff']) {
    assert.ok(isReservedAddress(a), a);
  }
  assert.ok(!isReservedAddress('0x4e6575726f53696d000000000000000000000001'));
  for (let i = 0; i < 50; i++) {
    const p = simPlan(DEX, { seed: '0x' + i.toString(16).padStart(2, '0') });
    assert.ok(!isReservedAddress(p.at) && !isReservedAddress(p.from) && p.at !== p.from);
  }
});

test('the call carries a real gas price and gas limit, and the caller can pay for them', async () => {
  const rpc = fakeRpc({ sim: result(5, 1000, 1000, 100, 98), gasPrice: '0x3b9aca00' }); // 1 gwei
  await read(rpc);
  const { params } = simCallOf(rpc.seen);
  const [tx, , override] = params;
  const price = BigInt(tx.gasPrice);
  const gas = BigInt(tx.gas);
  assert.ok(price >= 1_100_000_000n && price < 1_600_000_000n, `gas price ${price}: eth_gasPrice + 10-60%`);
  assert.ok(gas >= 4_000_000n && gas < 6_000_000n, `gas ${gas}: a wallet's limit, not a node's 50M default`);
  const fromBalance = BigInt(override[tx.from].balance);
  assert.ok(fromBalance > gas * price, 'tx.origin has coin left after paying for gas');
  // No round numbers a token could test for.
  const { amountIn } = decodeRun(tx.data);
  assert.notEqual(BigInt(override[tx.to].balance) % 10n ** 15n, 0n);
  assert.notEqual(BigInt(override[tx.to].balance), amountIn * 10n);
  assert.notEqual(fromBalance % 10n ** 15n, 0n);
});

test('a node that refuses the priced call is asked again without a gas price; no eth_gasPrice = unpriced', async () => {
  const sims = [];
  const picky = fakeRpc({ sim: (p) => { sims.push(p[0]); if (p[0].gasPrice) throw new Error('max fee per gas less than block base fee'); return result(5, 1000, 1000, 100, 98); } });
  const r = await read(picky);
  assert.equal(r.sim.stage, 'done');
  assert.equal(sims.length, 2);
  assert.ok(sims[0].gasPrice && !sims[1].gasPrice);
  assert.equal(sims[0].to, sims[1].to, 'same plan both times');
  // Any other refusal is not retried (no state overrides: skipped).
  const other = fakeRpc({ sim: () => { throw new Error('state override not supported'); } });
  assert.equal((await read(other)).sim.stage, 'no-override');
  assert.equal(other.seen.filter((c) => c.method === 'eth_call' && c.params[2]).length, 1);
  // No eth_gasPrice on this endpoint: one unpriced call.
  const noPrice = fakeRpc({ sim: result(5, 1000, 1000, 100, 98), gasPrice: null });
  assert.equal((await read(noPrice)).sim.stage, 'done');
  assert.equal(simCallOf(noPrice.seen).params[0].gasPrice, undefined);
});

test('the network verdict is the same with or without the simulation', async () => {
  const withSim = await read(fakeRpc({ sim: result(4, 1000, 1000, 50) }));
  const without = await readContract('bsc', TOKEN, { rpc: fakeRpc({ sim: '0x' }) });
  assert.notEqual(withSim.analysis.level, without.analysis.level);
  assert.equal(await verdictOf(withSim), await verdictOf(without));
});

// ------------------------------------------------- real bytecode, local EVM
describe('TradeSim on an in-memory EVM (mock Uniswap V2 at PancakeSwap addresses)', () => {
  let chain; let addPool;
  const sim = (addr) => readContract('bsc', addr, { rpc: chain.rpc, simulate: true });
  /** Deploys a token, gives it a pool of 1,000,000 tokens and 100 BNB, tells it the pool's address. */
  async function listed(name, args = '', setter = null) {
    const t = await chain.deploy(name, args);
    const pair = await addPool(t, 10n ** 24n, 10n ** 20n);
    if (setter) await chain.send(t, setter, [pair]);
    return t;
  }
  before(async () => {
    chain = await createLocalChain();
    addPool = await chain.installDex(DEX);
  });

  test('honest token: bought and sold back with 0% tax', async () => {
    const r = await sim(await listed('CleanToken'));
    assert.equal(r.sim.stage, 'done');
    assert.equal(r.sim.bought, r.sim.expectedBuy);
    assert.equal(r.sim.sold, r.sim.expectedSell);
    assert.ok(BigInt(r.sim.sold) > 0n);
    assert.deepEqual(find(r, 'sim-ok').params, { dex: 'PancakeSwap V2', native: 'WBNB', buy: 0, sell: 0 });
    assert.equal(r.analysis.level, 'info');
  });

  test('5% buy / 20% sell tax: medium', async () => {
    const r = await sim(await listed('TaxToken', uint(500) + uint(2000), 'setPool(address)'));
    const f = find(r, 'sim-high-tax');
    assert.equal(f.severity, 'medium');
    assert.equal(f.params.buy, 5);
    assert.ok(f.params.sell > 19 && f.params.sell <= 20, String(f.params.sell));
  });

  test('60% sell tax: high', async () => {
    const r = await sim(await listed('TaxToken', uint(300) + uint(6000), 'setPool(address)'));
    assert.equal(find(r, 'sim-high-tax').severity, 'high');
    assert.equal(r.analysis.level, 'high');
  });

  test('99.5% sell tax: "cannot sell" (selling returns almost nothing)', async () => {
    const r = await sim(await listed('TaxToken', uint(0) + uint(9950), 'setPool(address)'));
    const f = find(r, 'sim-cannot-sell');
    assert.ok(f.params.sell >= 99);
    assert.match(explain(r, 'en').lines.find((l) => l.id === 'sim-cannot-sell').text, /almost nothing/);
  });

  test('sell block behind a harmless name: rules see little, the trade catches it', async () => {
    const t = await listed('QuietHoneypot', '', 'syncRewards(address)');
    // As a brand-new honeypot: no known-bad code to compare with.
    const r = await readContract('bsc', t, { rpc: chain.rpc, simulate: true, threatSignatures: false });
    assert.equal(r.sim.stage, 'sell-failed');
    assert.equal(find(r, 'sim-cannot-sell').severity, 'high');
    assert.equal(r.analysis.level, 'high');
    assert.notEqual(r.analysis.rulesLevel, 'high', 'no name rule flags it');
    assert.match(explain(r, 'th').lines[1].text, /^ทดสอบขายไม่ผ่าน/, 'shown right under what the token is');
    // Once the network flags this exact code (an entry with an on-chain flag
    // reference), the fixed rules flag it too, and the trade result still comes first.
    const known = await readContract('bsc', t, { rpc: chain.rpc, simulate: true, threatSignatures: FLAGGED });
    assert.deepEqual([find(known, 'similar-flagged').params.percent, find(known, 'similar-flagged').severity], [100, 'high']);
    assert.equal(known.analysis.rulesLevel, 'high');
    assert.match(explain(known, 'th').lines[1].text, /^ทดสอบขายไม่ผ่าน/);
  });

  test('trading not open: the buy fails, reported as skipped', async () => {
    const r = await sim(await listed('NotLaunched', '', 'prepare(address)'));
    assert.equal(r.sim.stage, 'buy-failed');
    assert.equal(find(r, 'sim-skipped').params.why, 'buy-failed');
  });

  test('no pool on the DEX: skipped', async () => {
    const r = await sim(await chain.deploy('CleanToken'));
    assert.equal(r.sim.stage, 'no-pool');
  });

  test('the simulation changes nothing: same result twice, read-only methods only', async () => {
    const t = await listed('TaxToken', uint(500) + uint(2000), 'setPool(address)');
    const seen = [];
    const rpc = { call: (m, p) => { seen.push({ method: m, params: p }); return chain.rpc.call(m, p); } };
    const seed = jobSimSeed(1, RAND);
    const a = await readContract('bsc', t, { rpc, simulate: true, simSeed: seed });
    const b = await readContract('bsc', t, { rpc, simulate: true, simSeed: seed });
    assert.deepEqual(a.sim, b.sim);
    const { to, from } = simCallOf(seen).params[0];
    assert.equal(await chain.rpc.call('eth_getCode', [to, 'latest']), '0x', 'override gone after the call');
    assert.equal(await chain.rpc.call('eth_getCode', [from, 'latest']), '0x');
    assert.ok(chain.rpc.calls.every((m) => ['eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_gasPrice'].includes(m)));
    // A random check of the same token: other amounts, the same taxes.
    const c = await sim(t);
    assert.notEqual(c.sim.amountIn, a.sim.amountIn);
    assert.deepEqual([c.sim.buyTax, c.sim.stage], [a.sim.buyTax, a.sim.stage]);
  });

  // A token that sells only when it sees something fixed about the test.
  const simHash = '0x' + Buffer.from(keccak_256(Buffer.from(TRADESIM_CODE.slice(2), 'hex'))).toString('hex');
  const TELLS = { 1: 'the old fixed NeuroSim addresses', 2: 'gas price 0', 3: 'a caller with no coin',
    4: 'the public TradeSim code hash', 5: 'a sale of exactly 99%', 6: 'an exact allowance' };
  for (const [tell, what] of Object.entries(TELLS)) {
    test(`a token that lets only the test sell is caught (it looks for ${what})`, async () => {
      const t = await listed('SimAware', uint(tell) + word(simHash), 'setVenue(address)');
      const r = await sim(t);
      assert.equal(r.sim.stage, 'sell-failed', JSON.stringify(r.sim));
      assert.equal(find(r, 'sim-cannot-sell').severity, 'high');
      const job = await readContract('bsc', t, { rpc: chain.rpc, simulate: true, simSeed: jobSimSeed(3, RAND) });
      assert.equal(job.sim.stage, 'sell-failed', 'a job-seeded check too');
    });
  }

  test('the old fixed setup was fooled by such a token', async () => {
    // What every check used to look like: fixed addresses, no gas price,
    // a caller with no coin, 10x the amount, 99% sold.
    const t = await listed('SimAware', uint(1) + word(simHash), 'setVenue(address)');
    const OLD_SIM = '0x4e6575726f53696d000000000000000000000001';
    const plan = { amountIn: BigInt(DEX.amountIn), sellBps: 9900n };
    const out = await chain.rpc.call('eth_call', [{ from: '0x4e6575726f53696d000000000000000000000002', to: OLD_SIM, data: runCalldata(DEX, t, plan) }, 'latest',
      { [OLD_SIM]: { code: TRADESIM_CODE, balance: '0x' + (BigInt(DEX.amountIn) * 10n).toString(16) } }]);
    assert.equal(Number(BigInt(out.slice(0, 66))), 5, 'sold: the token recognised the test and behaved');
  });
});
