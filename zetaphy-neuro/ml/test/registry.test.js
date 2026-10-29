// Model version selection by block height (ml/fl/registry.js); the same
// schedule is checked against the ModelEpochs contract in
// zetaphy-network/test/modelepochs.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectVersion, checkSchedule, nextActivation, buildManifest, loadForHeight } from '../fl/registry.js';
import { sha256Hex } from '../fl/head.js';
import { rng } from '../lib/rng.js';

const h = (n) => '0x' + n.toString(16).padStart(64, '0');

test('selection: last version with activation <= height; none before the first', () => {
  const v = checkSchedule([{ hash: h(1), activation: 100 }, { hash: h(2), activation: 200 }, { hash: h(3), activation: 500 }], 100);
  assert.equal(selectVersion(v, 0), null);
  assert.equal(selectVersion(v, 99), null);
  assert.equal(selectVersion(v, 100).index, 0);
  assert.equal(selectVersion(v, 199).hash, h(1));
  assert.equal(selectVersion(v, 200).hash, h(2));
  assert.equal(selectVersion(v, 499).index, 1);
  assert.equal(selectVersion(v, 500n).index, 2);
  assert.equal(selectVersion(v, 10n ** 30n).index, 2);
  assert.equal(selectVersion([], 5), null);
});

test('selection = linear scan on random schedules and heights', () => {
  const R = rng('reg');
  for (let t = 0; t < 200; t++) {
    let a = 0;
    const v = Array.from({ length: R.int(12) }, (_, i) => ({ hash: h(i + 1), activation: (a += 1 + R.int(50)) }));
    for (let k = 0; k < 30; k++) {
      const height = R.int(a + 20);
      let want = null;
      for (const [i, x] of v.entries()) if (x.activation <= height) want = i;
      assert.equal(selectVersion(v, height)?.index ?? null, want);
    }
  }
});

test('schedule checks', () => {
  assert.throws(() => checkSchedule([{ hash: h(1), activation: 10 }, { hash: h(2), activation: 10 }]), /not increasing/);
  assert.throws(() => checkSchedule([{ hash: h(1), activation: 15 }], 10), /epoch/);
  assert.throws(() => checkSchedule([{ hash: '0x' + '00'.repeat(32), activation: 10 }]), /bad hash/);
  assert.throws(() => checkSchedule([{ hash: '0x12', activation: 10 }]), /bad hash/);
  assert.equal(nextActivation(1, 100), 100n);
  assert.equal(nextActivation(100, 100), 100n);
  assert.equal(nextActivation(101, 100), 200n);
});

test('loadForHeight verifies the manifest and every file against the registry hash', async () => {
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  const model = { id: 'nml-a', format: 'x' };
  const head = { id: 'nfh-b', model: 'nml-a' };
  const files = { 'ml/model.json': enc(model), 'ml/fl/head.json': enc(head) };
  const { text, hash } = await buildManifest({ model, modelBytes: files['ml/model.json'], head, headBytes: files['ml/fl/head.json'] });
  files['m.json'] = new TextEncoder().encode(text);
  const fetchBytes = async (p) => { if (!files[p]) throw new Error('404'); return files[p]; };
  const versions = [{ hash: '0x' + hash, activation: 50, uri: 'm.json' }];
  assert.equal(await loadForHeight({ versions, height: 49, fetchBytes }), null);
  const got = await loadForHeight({ versions, height: 50, fetchBytes });
  assert.equal(got.model.id, 'nml-a');
  assert.equal(got.head.id, 'nfh-b');
  assert.equal(hash, await sha256Hex(text));
  // a swapped file or manifest is refused
  files['ml/fl/head.json'] = enc({ ...head, theta: [9] });
  await assert.rejects(loadForHeight({ versions, height: 60, fetchBytes }), /does not match its manifest/);
  await assert.rejects(loadForHeight({ versions: [{ ...versions[0], hash: h(7) }], height: 60, fetchBytes }), /registry hash/);
});

test('the committed manifest names the committed files', async () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const model = readFileSync(new URL('../model.json', import.meta.url));
  const head = readFileSync(new URL('../fl/head.json', import.meta.url));
  assert.equal(m.model.sha256, await sha256Hex(model));
  assert.equal(m.head.sha256, await sha256Hex(head));
});
