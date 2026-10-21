// cli.js: keys only from a file (or ZETAPHY_DEX_KEY_FILE), never from argv;
// a key file other users can read is refused; deploy only on chain 77390
// unless --any-chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { main, loadKey, checkDeployChain } from '../cli.js';

const dir = mkdtempSync(join(tmpdir(), 'zdex-cli-'));

test('a key on the command line is refused; no key at all is an error, not a prompt', async () => {
  await assert.rejects(main(['deploy', '--rpc', 'http://127.0.0.1:1', '--key', '0x' + '11'.repeat(32)]), /--key is not accepted/);
  const saved = process.env.ZETAPHY_DEX_KEY_FILE;
  delete process.env.ZETAPHY_DEX_KEY_FILE;
  try {
    await assert.rejects(main(['deploy', '--rpc', 'http://127.0.0.1:1']), /no key: pass --key-file/);
  } finally { if (saved !== undefined) process.env.ZETAPHY_DEX_KEY_FILE = saved; }
});

test('key files: plain hex (with or without 0x), keystore JSON with ZETAPHY_PASSPHRASE; junk refused', () => {
  const w = Wallet.createRandom();
  const f1 = join(dir, 'a.key');
  writeFileSync(f1, w.privateKey + '\n', { mode: 0o600 });
  assert.equal(loadKey(f1), w.privateKey);
  const f2 = join(dir, 'b.key');
  writeFileSync(f2, w.privateKey.slice(2), { mode: 0o600 });
  assert.equal(loadKey(f2), w.privateKey);
  const f3 = join(dir, 'c.json');
  writeFileSync(f3, w.encryptSync('pass phrase', { scrypt: { N: 1024 } }), { mode: 0o600 });
  const saved = process.env.ZETAPHY_PASSPHRASE;
  delete process.env.ZETAPHY_PASSPHRASE;
  try {
    assert.throws(() => loadKey(f3), /set ZETAPHY_PASSPHRASE/);
    process.env.ZETAPHY_PASSPHRASE = 'pass phrase';
    assert.equal(loadKey(f3), w.privateKey);
  } finally { if (saved === undefined) delete process.env.ZETAPHY_PASSPHRASE; else process.env.ZETAPHY_PASSPHRASE = saved; }
  const f4 = join(dir, 'd.key');
  writeFileSync(f4, 'not a key', { mode: 0o600 });
  assert.throws(() => loadKey(f4), /does not hold a 32-byte hex private key/);
});

test('help lists the commands', async () => {
  const lines = [];
  await main(['help'], (l) => lines.push(l));
  assert.match(lines.join('\n'), /node cli\.js deploy/);
  await assert.rejects(main(['bogus'], () => {}), /unknown command/);
});

test('a key file readable by the group or by everyone is refused, with the chmod 600 fix in the error', { skip: process.platform === 'win32' }, () => {
  const w = Wallet.createRandom();
  const f = join(dir, 'open.key');
  writeFileSync(f, w.privateKey + '\n');
  for (const mode of [0o644, 0o640, 0o604, 0o660]) {
    chmodSync(f, mode);
    assert.throws(() => loadKey(f), /readable or writable by other users.*chmod 600/, mode.toString(8));
  }
  chmodSync(f, 0o600);
  assert.equal(loadKey(f), w.privateKey);
  chmodSync(f, 0o400);
  assert.equal(loadKey(f), w.privateKey);
});

test('deploy refuses a chain other than ZETAPHY (77390) unless --any-chain', async () => {
  assert.doesNotThrow(() => checkDeployChain(77390n, false));
  assert.throws(() => checkDeployChain(1n, false), /chain id 1, not ZETAPHY \(77390\); pass --any-chain/);
  assert.doesNotThrow(() => checkDeployChain(1n, true));
  // Through main(): an RPC that says chain id 1. Nothing is sent: it stops after eth_chainId.
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reqs = [].concat(JSON.parse(body));
      const out = reqs.map((r) => { seen.push(r.method); return r.method === 'eth_chainId' ? { jsonrpc: '2.0', id: r.id, result: '0x1' } : { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'not here' } }; });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const w = Wallet.createRandom();
  const f = join(dir, 'deploy.key');
  writeFileSync(f, w.privateKey, { mode: 0o600 });
  try {
    await assert.rejects(main(['deploy', '--rpc', `http://127.0.0.1:${server.address().port}`, '--key-file', f], () => {}), /not ZETAPHY \(77390\); pass --any-chain/);
    assert.ok(!seen.includes('eth_sendRawTransaction') && !seen.includes('eth_getBalance'), seen.join(','));
  } finally { server.close(); }
});
