// Honeypot check: a simulated buy and sell in one read-only eth_call with a
// state override (src/honeypot.js). Two kinds of test:
//   - fake RPCs (as in stylus.test.js) for each answer an endpoint can give;
//   - the real TradeSim bytecode on the in-memory EVM, against a mock
//     Uniswap-V2 DEX placed at PancakeSwap's addresses, with tokens that
//     tax or block selling under harmless function names.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { explain, LANGS } from '../src/explain.js';
import { verdictOf } from '../src/verdict.js';
import { CHAINS } from '../src/chains.js';
import { SIM_ADDRESS, taxPercent, runCalldata } from '../src/honeypot.js';
import { simFindings } from '../src/analyze.js';
import { TRADESIM_CODE, TRADESIM_RUN } from '../src/tradesim.generated.js';
import { compileTradeSim } from '../scripts/build-tradesim.js';
import { createLocalChain } from './helpers/local-chain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);
const DEX = CHAINS.bsc.dex;
const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n) => BigInt(n).toString(16).padStart(64, '0');
const PAIR = '0x' + 'aa'.repeat(20);

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

/** Answers getPair with `pair`; the override call with `sim` (a function of the params, or a value). */
function fakeRpc({ pair = PAIR, sim }) {
  const seen = [];
  return {
    seen,
    async call(method, params) {
      seen.push({ method, params });
      if (method === 'eth_getCode') return params[0] === TOKEN ? tokenCode : '0x';
      if (method === 'eth_getStorageAt') return '0x' + '0'.repeat(64);
      if (method !== 'eth_call') throw new Error(method);
      const { to, data } = params[0];
      if (to === DEX.factory && data.startsWith('0xe6a43905')) return '0x' + word(pair);
      if (to === SIM_ADDRESS) return typeof sim === 'function' ? sim(params) : sim;
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
  // The override call: TradeSim code and some native coin at the throwaway address, nothing else.
  const call = rpc.seen.find((c) => c.params?.[0]?.to === SIM_ADDRESS);
  assert.equal(call.params[1], 'latest');
  assert.deepEqual(Object.keys(call.params[2]), [SIM_ADDRESS]);
  assert.equal(call.params[2][SIM_ADDRESS].code, TRADESIM_CODE);
  assert.ok(BigInt(call.params[2][SIM_ADDRESS].balance) >= BigInt(DEX.amountIn));
  assert.equal(call.params[0].data, runCalldata(DEX, TOKEN));
  assert.ok(call.params[0].data.includes(word(DEX.router)) && call.params[0].data.includes(word(TOKEN)));
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
    // Once it is in Neuro's known-bad dataset, the fixed rules flag it too,
    // and the trade result still comes first.
    const known = await sim(t);
    assert.equal(find(known, 'similar-flagged').params.percent, 100);
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
    const a = await sim(t);
    const b = await sim(t);
    assert.deepEqual(a.sim, b.sim);
    assert.equal(await chain.rpc.call('eth_getCode', [SIM_ADDRESS, 'latest']), '0x', 'override gone after the call');
    assert.ok(chain.rpc.calls.every((m) => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(m)));
  });
});
