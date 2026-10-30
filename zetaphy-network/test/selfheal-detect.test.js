// The self-healing detectors (src/selfheal/detect.js) as pure functions: outflow decoding (configured
// events and, through Neuro's decodeLogs, ERC-20 Transfers), the z-score baseline, reentrancy from
// logs and from call traces, Neuro's bytecode scan for call-back contracts, oracle deviation, the
// corroboration rule (a volume outlier alone never trips) and deterministic evidence hashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, ZeroAddress, id as topicId, zeroPadValue, getAddress, parseEther } from 'ethers';
import { watchConfig, outflowsOf, pricesOf, baselineOf, zscore, burstsOf, reentrancyFromTrace, pushedSelectors, evaluate, canonical, evidenceHashOf } from '../src/selfheal/detect.js';
import { selfHealKit } from './helpers/selfhealkit.js';

const P = getAddress('0x' + 'aa'.repeat(20));
const EOA = getAddress('0x' + '11'.repeat(20));
const BAD = getAddress('0x' + 'bb'.repeat(20));
const FEED = getAddress('0x' + 'fe'.repeat(20));
const TOKEN = getAddress('0x' + 'cc'.repeat(20));
const WD = topicId('Withdrawn(address,uint256,bool)');
const PRICE = topicId('Price(address,uint256)');
const TRANSFER = topicId('Transfer(address,address,uint256)');
const enc = (...v) => AbiCoder.defaultAbiCoder().encode(v.map((x) => (typeof x === 'boolean' ? 'bool' : 'uint256')), v);
const t32 = (a) => zeroPadValue(a, 32);
const hex = (n) => '0x' + n.toString(16);
const cfg = watchConfig({
  address: P, selectors: ['0xd0e30db0', '0x2e1a7d4d', '0x853828b6'], tokenTransfers: true,
  outflowEvents: [{ topic0: WD, toTopic: 1, amountWord: 0, selector: '0x853828b6' }],
  feeds: [{ address: FEED, topic0: PRICE }],
  thresholds: { minVolume: parseEther('50'), lookback: 20 },
});
const wd = (block, to, z, tx = `0x${block.toString(16).padStart(64, '0')}`) => ({ address: P, topics: [WD, t32(to)], data: enc(parseEther(String(z)), true), blockNumber: hex(block), transactionHash: tx });

test('outflowsOf: configured events and ERC-20 Transfers out of the protocol (Neuro decodeLogs)', () => {
  const logs = [
    wd(5, EOA, 3),
    { address: TOKEN, topics: [TRANSFER, t32(P), t32(EOA)], data: enc(7n), blockNumber: '0x5', transactionHash: '0x01' },
    { address: TOKEN, topics: [TRANSFER, t32(EOA), t32(P)], data: enc(9n), blockNumber: '0x5', transactionHash: '0x02' }, // inflow: ignored
    { address: EOA, topics: [WD, t32(EOA)], data: enc(1n, true), blockNumber: '0x5', transactionHash: '0x03' },       // not the protocol
  ];
  const o = outflowsOf(logs, cfg);
  assert.equal(o.length, 2);
  assert.deepEqual(o[0], { block: 5, tx: logs[0].transactionHash, asset: ZeroAddress, to: EOA, amount: parseEther('3'), selector: '0x853828b6' });
  assert.equal(o[1].asset, TOKEN);
  assert.equal(o[1].amount, 7n);
});

test('baseline and z-score: idle blocks count, the std is floored', () => {
  const b = baselineOf([0n, 10n ** 18n, 0n, 10n ** 18n]);
  assert.equal(b.mean, 5e8);
  assert.equal(b.std, 5e8);
  assert.ok(Math.abs(zscore(10n ** 19n, b) - 19) < 1e-9);
  assert.equal(zscore(10n ** 18n, { mean: 0, std: 0 }), 1e9, 'quiet history: floored at 1 gwei (the absolute floor minVolume guards it)');
});

test('reentrancy from logs (bursts) and from call traces', () => {
  const tx = '0x' + 'ab'.repeat(32);
  const o = [1, 2, 3].map(() => ({ tx, to: BAD })).concat([{ tx, to: EOA }]);
  assert.deepEqual(burstsOf(o, 3), [{ tx, to: BAD, count: 3 }]);
  const frame = { from: EOA, to: BAD, calls: [{ from: BAD, to: P, calls: [{ from: P, to: BAD, value: '0x1', calls: [{ from: BAD, to: P, calls: [{ from: P, to: BAD, value: '0x1', calls: [{ from: BAD, to: P }] }] }] }] }] };
  assert.equal(reentrancyFromTrace(frame, P), 2);
  const benign = { from: EOA, to: P, calls: [{ from: P, to: EOA, value: '0x1' }, { from: P, to: TOKEN, calls: [] }] };
  assert.equal(reentrancyFromTrace(benign, P), 0);
});

test('Neuro bytecode scan: the attacker contract pushes the vault\'s own selectors; a plain EOA has no code', () => {
  const kit = selfHealKit();
  const s = pushedSelectors(kit.HealAttacker.bytecode);
  assert.ok(s.has('0x853828b6') && s.has('0xd0e30db0'));
  assert.equal(pushedSelectors('0x').size, 0);
});

test('evaluate: a volume outlier alone never trips (a whale); with a reentrancy burst it does, pausing only the event\'s selector', () => {
  const past = []; for (let b = 80; b < 100; b++) if (b % 2) past.push(wd(b, EOA, 5));
  const whale = evaluate(cfg, { chainId: 1n, outflows: outflowsOf([...past, wd(100, EOA, 400)], cfg), prices: [], code: {} }, 100, 100);
  assert.equal(whale.anomalous, false);
  assert.ok(whale.signals.some((s) => s.id === 'volume'));
  const tx = '0x' + 'ee'.repeat(32);
  const drain = [...past, ...[1, 2, 3, 4].map(() => wd(100, BAD, 100, tx))];
  const code = { [BAD]: selfHealKit().HealAttacker.bytecode };
  const r = evaluate(cfg, { chainId: 1n, outflows: outflowsOf(drain, cfg), prices: [], code }, 100, 100);
  assert.equal(r.anomalous, true);
  assert.deepEqual(r.signals.map((s) => s.id).sort(), ['burst', 'callback', 'fresh', 'volume']);
  assert.equal(r.mask, 4);
  // deterministic: same inputs, same evidence hash, whatever the key order
  const again = evaluate(cfg, { chainId: 1n, outflows: outflowsOf([...drain].reverse().reverse(), cfg), prices: [], code: { ...code } }, 100, 100);
  assert.equal(again.evidenceHash, r.evidenceHash);
  assert.equal(evidenceHashOf(JSON.parse(JSON.stringify(r.evidence, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))), r.evidenceHash);
  assert.equal(canonical({ b: 1n, a: [2, 'x'] }), '{"a":[2,"x"],"b":"1"}');
  // a quiet history + small outflow under minVolume: nothing
  assert.equal(evaluate(cfg, { chainId: 1n, outflows: outflowsOf([wd(100, BAD, 10, tx), wd(100, BAD, 10, tx), wd(100, BAD, 10, tx)], cfg), prices: [] }, 100, 100).anomalous, false);
});

test('evaluate: an oracle deviation corroborates a volume outlier', () => {
  const feed = (b, p) => ({ address: FEED, topics: [PRICE, t32(TOKEN)], data: enc(p), blockNumber: hex(b), transactionHash: '0x' + b.toString(16).padStart(64, '0') });
  const past = []; for (let b = 80; b < 100; b++) { past.push(feed(b, 1000n + BigInt(b % 3))); if (b % 2) past.push(wd(b, EOA, 5)); }
  const logs = [...past, feed(100, 400n), wd(100, EOA, 300)];
  const prices = pricesOf(logs, cfg);
  assert.equal(prices.length, 21);
  const r = evaluate(cfg, { chainId: 1n, outflows: outflowsOf(logs, cfg), prices, code: {} }, 100, 100);
  assert.ok(r.signals.some((s) => s.id === 'oracle' && s.bps >= 5900));
  assert.equal(r.anomalous, true);
  const calm = evaluate(cfg, { chainId: 1n, outflows: outflowsOf(logs, cfg), prices: pricesOf([...past, feed(100, 1010n)], cfg), code: {} }, 100, 100);
  assert.equal(calm.anomalous, false);
});
