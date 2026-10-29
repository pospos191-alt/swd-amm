import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChain } from './helpers/evm.js';
import { readVersions, versionForHeight, scheduleProposal, REGISTRY, selectVersion } from '../src/modelepochs.js';
import { rng } from '../../zetaphy-neuro/ml/lib/rng.js';

const EPOCH = 100n;
const H = (n) => '0x' + n.toString(16).padStart(64, '0');
let c, reg;
const a = (n) => c.acct[n].toString();
beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'thief']);
  reg = await c.deploy('ModelEpochs', [a('gov'), EPOCH, 10], 'gov');
});
/** First epoch boundary at least `ahead` blocks after the next transaction's block. */
const boundary = (ahead) => ((c.blockNumber() + BigInt(ahead) + EPOCH - 1n) / EPOCH) * EPOCH;

test('constructor refuses missing governance, zero epoch and silly delays', async () => {
  const Z = '0x' + '00'.repeat(20);
  await assert.rejects(c.deploy('ModelEpochs', [Z, 100, 10], 'gov'));
  await assert.rejects(c.deploy('ModelEpochs', [a('gov'), 0, 10], 'gov'));
  await assert.rejects(c.deploy('ModelEpochs', [a('gov'), 100, 0], 'gov'));
  await assert.rejects(c.deploy('ModelEpochs', [a('gov'), 100, 1_000_001], 'gov'));
  assert.equal(await reg.call('epochLength'), EPOCH);
  assert.equal(await reg.call('minDelay'), 10n);
  const [found] = await reg.call('current');
  assert.equal(found, false, 'no version: Neuro runs on its rules only');
});

test('only governance schedules; a guardian may only cancel', async () => {
  const at = boundary(20);
  await assert.rejects(reg.send('thief', 'schedule', [H(1), at, 'ipfs://x']), /NotGovernance/);
  await reg.send('gov', 'setGuardian', [a('guardian'), true]);
  await assert.rejects(reg.send('guardian', 'schedule', [H(1), at, 'ipfs://x']), /NotGovernance/);
  for (const [fn, args] of [['setGuardian', [a('thief'), true]], ['setGovernance', [a('thief')]], ['setMinDelay', [5]]]) {
    await assert.rejects(reg.send('thief', fn, args), /NotGovernance/, fn);
  }
  await reg.send('gov', 'schedule', [H(1), at, 'ipfs://x']);
  await assert.rejects(reg.send('thief', 'cancelLast'), /NotGuardian/);
  const ev = await reg.send('guardian', 'cancelLast');
  assert.ok(ev.some((e) => e?.name === 'Cancelled'));
  assert.equal(await reg.call('count'), 0n);
});

test('schedule rules: hash, epoch boundary, notice, increasing, uri', async () => {
  const at = boundary(20);
  await assert.rejects(reg.send('gov', 'schedule', ['0x' + '00'.repeat(32), at, 'u']), /BadValue/);
  await assert.rejects(reg.send('gov', 'schedule', [H(1), at + 1n, 'u']), /BadValue/);
  await assert.rejects(reg.send('gov', 'schedule', [H(1), at, '']), /BadValue/);
  await assert.rejects(reg.send('gov', 'schedule', [H(1), at, 'x'.repeat(257)]), /BadValue/);
  await reg.send('gov', 'setMinDelay', [1000]);
  await assert.rejects(reg.send('gov', 'schedule', [H(1), at, 'u']), /TooSoon/);
  await reg.send('gov', 'setMinDelay', [10]);
  const ev = await reg.send('gov', 'schedule', [H(1), at, 'u1']);
  assert.ok(ev.some((e) => e?.name === 'Scheduled'));
  await assert.rejects(reg.send('gov', 'schedule', [H(2), at, 'u2']), /BadValue/, 'same height');
  await reg.send('gov', 'schedule', [H(2), at + EPOCH, 'u2']);
  const v = await readVersions(reg);
  assert.deepEqual(v.map((x) => [x.hash, x.activation, x.uri]), [[H(1), at, 'u1'], [H(2), at + EPOCH, 'u2']]);
});

test('the version for height h cannot change once the chain is past h-1', async () => {
  const at = boundary(20);
  await reg.send('gov', 'schedule', [H(1), at, 'u1']);
  c.mine(Number(at - c.blockNumber())); // now at block `at`
  assert.equal((await reg.call('versionAt', [at]))[2], H(1));
  await assert.rejects(reg.send('gov', 'cancelLast'), /NotPending/, 'an active version cannot be cancelled');
  await assert.rejects(reg.send('gov', 'schedule', [H(2), at, 'u2']), /TooSoon/, 'no version can start at a height already reached');
  // a later version only affects heights from its own activation
  const next = boundary(20);
  await reg.send('gov', 'schedule', [H(2), next, 'u2']);
  assert.equal((await reg.call('versionAt', [next - 1n]))[2], H(1));
  assert.equal((await reg.call('versionAt', [next]))[2], H(2));
  assert.equal((await versionForHeight(reg, next - 1n)).hash, H(1));
  // cancelling the pending one restores the old answer for every height
  await reg.send('gov', 'cancelLast');
  assert.equal((await reg.call('versionAt', [next + 5n]))[2], H(1));
  await assert.rejects(reg.send('gov', 'cancelLast'), /NotPending/);
});

test('contract versionAt = JS selectVersion (browsers and nodes) on random schedules and heights', async () => {
  const R = rng('mr');
  await reg.send('gov', 'setMinDelay', [1]);
  let at = boundary(5);
  for (let i = 0; i < 12; i++) {
    await reg.send('gov', 'schedule', [H(i + 1), at, `uri-${i}`]);
    at += EPOCH * BigInt(1 + R.int(4));
  }
  const versions = await readVersions(reg);
  const last = versions.at(-1).activation;
  for (let k = 0; k < 60; k++) {
    const h = BigInt(R.int(Number(last) + 300));
    const [found, index, hash, activation, uri] = await reg.call('versionAt', [h]);
    const js = selectVersion(versions, h);
    assert.equal(found, js !== null, `height ${h}`);
    if (js) assert.deepEqual([index, hash, activation, uri], [BigInt(js.index), js.hash, js.activation, js.uri]);
  }
  assert.equal((await versionForHeight(reg, last)).index, 11);
});

test('gov proposal: a MsgEVMCall that calls schedule(hash, activation, uri)', () => {
  const p = scheduleProposal({ registry: '0x' + '11'.repeat(20), hash: H(9), activation: 4200n, uri: 'https://x/m.json', govBech32: 'zetaphy10d07y265gmmuvt4z0w9aw880jnsr700j5tzgnc', modelId: 'nml-a', headId: 'nfh-b' });
  const m = p.messages[0];
  assert.equal(m['@type'], '/zetaphy.pq.v1.MsgEVMCall');
  const call = REGISTRY.parseTransaction({ data: '0x' + Buffer.from(m.Data, 'base64').toString('hex') });
  assert.equal(call.name, 'schedule');
  assert.deepEqual([call.args[0], call.args[1], call.args[2]], [H(9), 4200n, 'https://x/m.json']);
  assert.match(p.title, /nml-a \+ head nfh-b from height 4200/);
});

test('the committed Neuro manifest hash fits the registry (bytes32)', async () => {
  const text = readFileSync(new URL('../../zetaphy-neuro/ml/manifest.json', import.meta.url));
  const { sha256 } = await import('ethers');
  const hash = sha256(text);
  await reg.send('gov', 'schedule', [hash, boundary(20), 'https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/zetaphy-neuro/ml/manifest.json']);
  assert.equal((await readVersions(reg))[0].hash, hash);
});
