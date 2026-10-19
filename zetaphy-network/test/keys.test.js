import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKey, sealWorkerKey } from '../src/keys.js';
import { loadOrCreatePq, sealPqSeed } from '../src/pq.js';

const dir = () => mkdtempSync(join(tmpdir(), 'zk-'));
afterEach(() => { delete process.env.ZETAPHY_PASSPHRASE; });

test('without a passphrase keys are plain files with 0600 permissions', () => {
  const f = join(dir(), 'worker.key');
  const a = loadOrCreateKey(f);
  assert.equal(a.encrypted, false);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(loadOrCreateKey(f).wallet.address, a.wallet.address);
});

test('with ZETAPHY_PASSPHRASE the runner key is an encrypted keystore; the wrong passphrase fails', { timeout: 120_000 }, () => {
  process.env.ZETAPHY_PASSPHRASE = 'correct horse battery staple';
  const f = join(dir(), 'worker.key');
  const a = loadOrCreateKey(f);
  assert.equal(a.encrypted, true);
  assert.ok(!existsSync(f) && existsSync(f + '.json'));
  assert.ok(!readFileSync(f + '.json', 'utf8').includes(a.wallet.privateKey.slice(2)));
  assert.equal(loadOrCreateKey(f).wallet.address, a.wallet.address);
  process.env.ZETAPHY_PASSPHRASE = 'wrong';
  assert.throws(() => loadOrCreateKey(f), /wrong ZETAPHY_PASSPHRASE/);
  delete process.env.ZETAPHY_PASSPHRASE;
  assert.throws(() => loadOrCreateKey(f), /set ZETAPHY_PASSPHRASE/);
});

test('the ML-DSA seed is sealed the same way, and plain files can be converted', { timeout: 120_000 }, () => {
  const d = dir();
  const plainPq = loadOrCreatePq(join(d, 'pq.seed'));
  const plainKey = loadOrCreateKey(join(d, 'worker.key'));
  process.env.ZETAPHY_PASSPHRASE = 'pass phrase';
  assert.equal(sealPqSeed(join(d, 'pq.seed')), true);
  assert.equal(sealWorkerKey(join(d, 'worker.key')), true);
  assert.ok(!existsSync(join(d, 'pq.seed')) && !existsSync(join(d, 'worker.key')));
  assert.equal(loadOrCreatePq(join(d, 'pq.seed')).keyHash, plainPq.keyHash);   // same wallet after sealing
  assert.equal(loadOrCreateKey(join(d, 'worker.key')).wallet.address, plainKey.wallet.address);
  process.env.ZETAPHY_PASSPHRASE = 'nope';
  assert.throws(() => loadOrCreatePq(join(d, 'pq.seed')), /wrong ZETAPHY_PASSPHRASE/);
});
