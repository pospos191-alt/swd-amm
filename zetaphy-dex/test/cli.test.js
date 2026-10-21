// cli.js: keys only from a file (or ZETAPHY_DEX_KEY_FILE), never from argv.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { main, loadKey } from '../cli.js';

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
