// BtcLightClient (contracts/BtcLightClient.sol) with REAL Bitcoin mainnet data
// (fixtures/btc-mainnet.json, rebuilt and re-checked by scripts/btc-fixture.js from public files):
// a 17-header chain, the difficulty retarget at height 306432, Bitcoin Core's pow_tests retarget
// vectors, and an SPV proof of a transaction in block 592920.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChain } from './helpers/evm.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/btc-mainnet.json', import.meta.url), 'utf8'));
const raw = (h) => Buffer.from(h.raw, 'hex');
const time = (h) => raw(h).readUInt32LE(68);
const bits = (h) => raw(h).readUInt32LE(72);
const hx = (b) => '0x' + Buffer.from(b).toString('hex');

/** A client whose checkpoint is `anchor` (its height, time, bits) with the period's start time. */
async function client(anchor, periodStart = 0, maxWalk = 1000) {
  const chain = await createChain(['relayer']);
  const c = await chain.deploy('BtcLightClient', ['0x' + anchor.hash, anchor.height, time(anchor), bits(anchor), periodStart, maxWalk], 'relayer');
  return { chain, c };
}

test('real mainnet headers: genesis, a 17-header chain, proof of work and linking', async () => {
  const { c } = await client(fx.chain.anchor);
  // genesis: double-SHA256 and the compact target, as on chain
  assert.equal(await c.call('dsha', [hx(raw(fx.genesis))]), '0x' + fx.genesis.hash);
  assert.equal(await c.call('targetOf', [0x1d00ffff]), 0xffffn << 208n);
  const all = Buffer.concat(fx.chain.headers.map(raw));
  const g = await c.gas('relayer', 'addHeaders', [hx(all)]); // (gas() runs the transaction)
  console.log(`addHeaders: ${fx.chain.headers.length} headers, ${g.exec} gas (${Math.round(g.exec / fx.chain.headers.length)} per header, execution)`);
  const last = fx.chain.headers.at(-1);
  assert.equal(await c.call('tip'), '0x' + last.hash);
  assert.equal(await c.call('tipHeight'), BigInt(last.height));
  // a header again, a header whose parent is unknown, a tampered nonce (no proof of work), a changed bits field
  await assert.rejects(c.send('relayer', 'addHeaders', [hx(raw(fx.chain.headers[3]))]), /BadHeader/);
  await assert.rejects(c.send('relayer', 'addHeaders', [hx(raw(fx.spv.header))]), /BadHeader/);
  const { c: c2 } = await client(fx.chain.anchor);
  const t = raw(fx.chain.headers[0]); t[79] ^= 1;
  await assert.rejects(c2.send('relayer', 'addHeaders', [hx(t)]), /BadHeader/);
  const b = raw(fx.chain.headers[0]); b.writeUInt32LE(bits(fx.chain.headers[0]) + 1, 72);
  await assert.rejects(c2.send('relayer', 'addHeaders', [hx(b)]), /BadHeader/);
  await assert.rejects(c2.send('relayer', 'addHeaders', [hx(raw(fx.chain.headers[0]).subarray(0, 79))]), /BadHeader/);
});

test('difficulty: the real retarget at 306432, and Bitcoin Core pow_tests vectors', async () => {
  const { c } = await client(fx.retarget.anchor, time(fx.retarget.periodStart));
  assert.equal(fx.retarget.headers[0].height % 2016, 0);
  assert.notEqual(bits(fx.retarget.headers[0]), bits(fx.retarget.anchor)); // the difficulty really changes here
  await c.send('relayer', 'addHeaders', [hx(Buffer.concat(fx.retarget.headers.map(raw)))]);
  assert.equal(await c.call('tip'), '0x' + fx.retarget.headers[1].hash);
  // with a wrong period start the expected bits differ, so the real header is refused
  const { c: c2 } = await client(fx.retarget.anchor, time(fx.retarget.periodStart) + 86_400);
  await assert.rejects(c2.send('relayer', 'addHeaders', [hx(raw(fx.retarget.headers[0]))]), /BadHeader/);
  // src/test/pow_tests.cpp (real mainnet values): CalculateNextWorkRequired
  const v = [
    [0x1d00ffff, 1261130161, 1262152739, 0x1d00d86a], // get_next_work (blocks 30240..32255)
    [0x1d00ffff, 1231006505, 1233061996, 0x1d00ffff], // pow limit
    [0x1c05a3f4, 1279008237, 1279297671, 0x1c0168fd], // lower clamp
    [0x1c387f6f, 1263163443, 1269211443, 0x1d00e1fd], // upper clamp
  ];
  for (const [last, first, lastTime, want] of v) assert.equal(Number(await c.call('nextBits', [last, first, lastTime])), want);
});

test('SPV: a real transaction in block 592920 (index 26), with confirmations', async () => {
  const h = fx.spv.header;
  const prev = raw(h).subarray(4, 36).toString('hex');
  const { c } = await client({ hash: prev, height: h.height - 1, raw: h.raw }, 0);
  await c.send('relayer', 'addHeaders', [hx(raw(h))]);
  const tx = Buffer.concat(['version', 'vin', 'vout', 'locktime'].map((k) => Buffer.from(fx.spv.tx[k], 'hex')));
  const sib = fx.spv.siblings.map((s) => '0x' + s);
  const txid = await c.call('verifyTx', [hx(tx), '0x' + h.hash, fx.spv.index, sib, 1]);
  assert.equal(txid, '0x' + fx.spv.txid);
  const g = await c.gas('relayer', 'verifyTx', [hx(tx), '0x' + h.hash, fx.spv.index, sib, 1]);
  console.log(`verifyTx: ${sib.length} siblings, ${g.exec} gas (execution)`);
  await assert.rejects(c.call('verifyTx', [hx(tx), '0x' + h.hash, fx.spv.index + 1, sib, 1]), /BadProof/);
  await assert.rejects(c.call('verifyTx', [hx(tx), '0x' + h.hash, fx.spv.index, sib, 2]), /BadProof/); // only 1 confirmation
  const t2 = Buffer.from(tx); t2[10] ^= 1;
  await assert.rejects(c.call('verifyTx', [hx(t2), '0x' + h.hash, fx.spv.index, sib, 1]), /BadProof/);
  await assert.rejects(c.call('verifyTx', [hx(Buffer.alloc(64)), '0x' + h.hash, 0, sib, 1]), /BadProof/); // 64-byte "tx"
  assert.equal(await c.call('verifyTxid', ['0x' + fx.spv.txid, '0x' + h.hash, fx.spv.index, sib, 1]), true);
});
