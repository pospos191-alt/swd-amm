// NeuroScore: Neuro's gradient-boosted trees evaluated on-chain (in-memory EVM).
//   - publishing checks the NSM1 format; activating a model goes through the timelock only;
//   - parity on the held-out rows: JS float model vs JS fixed-point vs Solidity
//     (Solidity = JS fixed-point exactly; float vs fixed within the documented tolerance);
//   - feeders, scoreOf (unknown after a model change), rescore; gas is measured and printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ZeroHash, encodeBytes32String, keccak256 } from 'ethers';
import { createChain } from './helpers/evm.js';
import { evalFixed, fromHex, quantizeVector, packFeatures, levelOf, scoreToProbability, SCALE } from '../../zetaphy-neuro/ml/onchain/fixed.js';
import { probability, modelLevel, checkModel } from '../../zetaphy-neuro/ml/model.js';

const NEURO_ML = new URL('../../zetaphy-neuro/ml/', import.meta.url);
// The on-chain model is pinned on its own (ml/onchain/model.json): the zk circuit and its public ceremony hard-wire
// its bytes, so it may lag ml/model.json (the browser / runner model) until a new ceremony is run.
const MODEL = checkModel(JSON.parse(readFileSync(new URL('onchain/model.json', NEURO_ML), 'utf8')));
const FIXED = JSON.parse(readFileSync(new URL('onchain/model.fixed.json', NEURO_ML), 'utf8'));
const HELD = JSON.parse(readFileSync(new URL('onchain/heldout.json', NEURO_ML), 'utf8'));
const BYTES = fromHex(FIXED.bytes);
const DELAY = 48n * 3600n;
const LEVEL = { low: 1, medium: 2, high: 3 };
/** Documented tolerance (docs/future/onchain-ml.md): |p_float - p_fixed| and |logit_float - logit_fixed| on any row. */
const P_TOL = 1e-6;
const LOGIT_TOL = 2e-5;

const calldataGas = (hex) => { let g = 0; for (let i = 2; i < hex.length; i += 2) g += hex.slice(i, i + 2) === '00' ? 4 : 16; return g; };
const vecOf = (row) => { const v = new Array(MODEL.features.length).fill(0); for (const [i, x] of row.x) v[i] = x; return v; };

async function setup() {
  const c = await createChain(['deployer', 'multisig', 'feeder', 'anyone', 'eve']);
  const A = (n) => c.acct[n].toString();
  const tl = await c.deploy('ZetaphyTimelock', [DELAY, [A('multisig')], ['0x' + '00'.repeat(20)], '0x' + '00'.repeat(20)], 'deployer');
  const ns = await c.deploy('NeuroScore', [tl.address], 'deployer');
  const govern = async (fn, args, salt = ZeroHash) => {
    const data = ns.iface.encodeFunctionData(fn, args);
    await tl.send('multisig', 'schedule', [ns.address, 0, data, ZeroHash, salt, DELAY]);
    c.advance(DELAY);
    return tl.send('anyone', 'execute', [ns.address, 0, data, ZeroHash, salt]);
  };
  const activate = (hash = FIXED.hash, id = FIXED.modelId, salt = ZeroHash) =>
    govern('activateModel', [hash, encodeBytes32String(id), FIXED.levels.low, FIXED.levels.medium, FIXED.levels.high], salt);
  return { c, A, tl, ns, govern, activate };
}

test('exporter: hash = keccak256(bytes); JS fixed-point replays the model\'s own check rows', () => {
  assert.equal(keccak256(FIXED.bytes), FIXED.hash);
  assert.equal(FIXED.modelId, MODEL.id, 'model.fixed.json is the export of the committed ml/onchain/model.json (rerun node ml/onchain/export.js)');
  for (const row of Object.values(MODEL.check)) {
    const v = MODEL.features.map((n) => row.f[n] ?? 0);
    const r = evalFixed(BYTES, quantizeVector(v));
    assert.ok(Math.abs(r.margin / SCALE - row.margin) < 1e-4, `${r.margin} vs ${row.margin}`);
  }
});

test('publish: anyone, format checked, stored in data contracts; activation only through the timelock', async () => {
  const { c, ns, activate } = await setup();
  // broken bytes are refused
  const bad = (mut) => { const b = BYTES.slice(); mut(b); return '0x' + Buffer.from(b).toString('hex'); };
  await assert.rejects(ns.send('eve', 'publishModel', [bad((b) => { b[0] = 0x58; })]), /BadModel/, 'magic');
  const firstNode = 24 + FIXED.trees;
  await assert.rejects(ns.send('eve', 'publishModel', [bad((b) => { b[firstNode] = 200; })]), /BadModel/, 'feature index out of range');
  await assert.rejects(ns.send('eve', 'publishModel', [bad((b) => { b[firstNode + 5] = 0; })]), /BadModel/, 'right child before the node');
  await assert.rejects(ns.send('eve', 'publishModel', [FIXED.bytes + '00']), /BadModel/, 'trailing bytes');

  const g = await ns.gas('anyone', 'publishModel', [FIXED.bytes]);
  console.log(`publishModel (${FIXED.size} bytes): ${g.exec + 21000 + calldataGas(g.data)} gas`);
  assert.equal(await ns.call('publishedSize', [FIXED.hash]), BigInt(FIXED.size));
  assert.equal(await ns.call('modelBytes', [FIXED.hash]), FIXED.bytes, 'the stored bytes are the published bytes');
  assert.equal((await ns.call('chunksOf', [FIXED.hash])).length, 1);
  await ns.send('eve', 'publishModel', [FIXED.bytes]); // idempotent
  assert.equal(await ns.call('version'), 0n);
  await assert.rejects(ns.call('evaluate', ['0x' + '00'.repeat(4 * FIXED.features.length)]), /NoModel/);

  // governance only, and governance is the timelock: the multisig itself is refused
  await assert.rejects(ns.send('multisig', 'activateModel', [FIXED.hash, ZeroHash, 0, 1, 2]), /NotGovernance/);
  await assert.rejects(ns.send('eve', 'setFeeder', [c.acct.eve.toString(), true]), /NotGovernance/);
  await activate();
  assert.equal(await ns.call('version'), 1n);
  const m = await ns.call('model', [1]);
  assert.equal(m.hash, FIXED.hash);
  assert.equal(m.nFeatures, BigInt(FIXED.features.length));
  assert.equal(m.medium, BigInt(FIXED.levels.medium));
});

test('a model larger than one data contract is split into chunks and evaluates the same', async () => {
  const { ns, govern } = await setup();
  // 2 copies of the trees: same format, ~37 KB, so two data contracts
  const h = new DataView(BYTES.buffer);
  const nt = h.getUint16(6);
  const sizes = BYTES.slice(24, 24 + nt);
  const nodes = BYTES.slice(24 + nt);
  const big = new Uint8Array(24 + 2 * nt + 2 * nodes.length);
  big.set(BYTES.slice(0, 24));
  new DataView(big.buffer).setUint16(6, 2 * nt);
  big.set(sizes, 24); big.set(sizes, 24 + nt);
  big.set(nodes, 24 + 2 * nt); big.set(nodes, 24 + 2 * nt + nodes.length);
  const hex = '0x' + Buffer.from(big).toString('hex');
  await ns.send('anyone', 'publishModel', [hex]);
  const hash = keccak256(hex);
  assert.equal((await ns.call('chunksOf', [hash])).length, 2);
  assert.equal(await ns.call('modelBytes', [hash]), hex);
  await govern('activateModel', [hash, ZeroHash, 0, 1, 2]);
  const row = HELD.rows[0];
  const q = quantizeVector(vecOf(row));
  const [score] = await ns.call('evaluate', [packFeatures(q)]);
  assert.equal(score, BigInt(evalFixed(big, q).score));
});

test('parity on the held-out rows: Solidity = JS fixed-point exactly; float vs fixed within tolerance, same decisions', async () => {
  const { ns, activate } = await setup();
  await ns.send('anyone', 'publishModel', [FIXED.bytes]);
  await activate();
  assert.equal(HELD.modelId, MODEL.id, 'heldout.json was cut for this model');
  assert.ok(HELD.rows.length >= 300, `held-out rows: ${HELD.rows.length}`);
  let maxDp = 0; let maxDz = 0; let flips = 0; let gasMax = 0; let gasSum = 0; let gasN = 0;
  const flipRows = [];
  for (const row of HELD.rows) {
    const v = vecOf(row);
    const q = quantizeVector(v);
    const fx = evalFixed(BYTES, q);
    const [score, level] = await ns.call('evaluate', [packFeatures(q)]);
    assert.equal(score, BigInt(fx.score), `${row.id}: Solidity vs JS fixed`);
    assert.equal(Number(level), levelOf(fx.score, FIXED.levels), `${row.id}: level`);
    const pf = probability(MODEL, v);
    const px = scoreToProbability(fx.score);
    maxDp = Math.max(maxDp, Math.abs(pf - px));
    const floatLevel = LEVEL[modelLevel(MODEL, pf)] ?? 0;
    if (floatLevel !== Number(level)) { flips++; flipRows.push({ id: row.id, pf, px }); }
    if (gasN < 60) {
      const g = await ns.gas('anyone', 'evaluate', [packFeatures(q)]);
      gasMax = Math.max(gasMax, g.exec); gasSum += g.exec; gasN++;
    }
    maxDz = Math.max(maxDz, Math.abs(Math.log(px / (1 - px)) - Math.log(pf / (1 - pf))));
  }
  console.log(`held-out rows ${HELD.rows.length}: max |p_float - p_fixed| ${maxDp.toExponential(2)}, max |logit diff| ${maxDz.toExponential(2)}, level flips ${flips}`);
  console.log(`evaluate() execution gas over ${gasN} rows: mean ${Math.round(gasSum / gasN)}, max ${gasMax}`);
  assert.ok(maxDp <= P_TOL, `max |dp| ${maxDp}`);
  assert.ok(maxDz <= LOGIT_TOL, `max |dlogit| ${maxDz}`);
  // A decision may differ only for a row whose float probability sits within the tolerance of a level threshold.
  for (const f of flipRows) {
    const near = Object.values(MODEL.thresholds).some((t) => Math.abs(f.pf - t) <= P_TOL);
    assert.ok(near, `decision flip far from a threshold: ${JSON.stringify(f)}`);
  }
});

test('feeders post features (scored on-chain); a model change makes scores unknown until anyone rescores them', async () => {
  const { c, A, ns, govern, activate } = await setup();
  await ns.send('anyone', 'publishModel', [FIXED.bytes]);
  await activate();
  const token = '0x' + '7a'.repeat(20);
  const row = HELD.rows.find((r) => r.y === 1) ?? HELD.rows[0];
  const feats = packFeatures(quantizeVector(vecOf(row)));
  await assert.rejects(ns.send('eve', 'postFeatures', [token, feats]), /NotFeeder/);
  await govern('setFeeder', [A('feeder'), true]);
  await assert.rejects(ns.send('feeder', 'postFeatures', [token, feats + '00']), /BadFeatures/);
  let [known] = await ns.call('scoreOf', [token]);
  assert.equal(known, false, 'never scored');
  const g = await ns.gas('feeder', 'postFeatures', [token, feats]);
  console.log(`postFeatures (score stored, ${(feats.length - 2) / 2} bytes of features): ${g.exec + 21000 + calldataGas(g.data)} gas total`);
  const ev = await ns.send('feeder', 'postFeatures', [token, feats]);
  const scored = ev.find((e) => e?.name === 'Scored');
  assert.equal(scored.args.features, feats, 'the vector is in the event, so anyone can rescore');
  let score; let level;
  [known, score, level] = await ns.call('scoreOf', [token]);
  assert.equal(known, true);
  const fx = evalFixed(BYTES, quantizeVector(vecOf(row)));
  assert.equal(score, BigInt(fx.score));
  assert.equal(Number(level), levelOf(fx.score, FIXED.levels));

  // model v2 (the same bytes, stricter levels): old scores are unknown until rescored
  await activate(FIXED.hash, 'v2', '0x' + '01'.repeat(32));
  assert.equal(await ns.call('version'), 2n);
  [known] = await ns.call('scoreOf', [token]);
  assert.equal(known, false);
  await assert.rejects(ns.send('eve', 'rescore', [token, feats.slice(0, -2) + 'ff']), /UnknownFeatures/);
  await assert.rejects(ns.send('eve', 'rescore', ['0x' + '01'.repeat(20), feats]), /UnknownFeatures/);
  await ns.send('eve', 'rescore', [token, feats]);
  [known, score] = await ns.call('scoreOf', [token]);
  assert.equal(known, true);
  assert.equal(score, BigInt(fx.score));
  assert.equal((await ns.call('scoreRecord', [token])).version, 2n);

  // feeder removed: no more posts
  await govern('setFeeder', [A('feeder'), false], '0x' + '02'.repeat(32));
  await assert.rejects(ns.send('feeder', 'postFeatures', [token, feats]), /NotFeeder/);
  assert.ok(c);
});
