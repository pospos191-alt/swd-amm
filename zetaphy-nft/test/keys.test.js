// The CLI's deployer key: plain file, keystore with ZETAPHY_PASSPHRASE, env;
// never overwritten, written 0600, and the CLI never prints it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Wallet } from 'ethers';

const dir = mkdtempSync(join(tmpdir(), 'zn-keys-'));
const cli = (args, env = {}) => {
  try { return { code: 0, out: execFileSync(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ZETAPHY_HOME: dir, ZETAPHY_PASSPHRASE: '', ZETAPHY_PRIVATE_KEY: '', ZETAPHY_KEY_FILE: '', ...env } }) }; } catch (e) { return { code: e.status, out: e.stdout + e.stderr }; }
};

test('key new: 0600 file, address only, never overwrites; key address reads it back', () => {
  const r = cli(['key', 'new']);
  assert.equal(r.code, 0, r.out);
  const file = join(dir, 'deployer.key');
  const key = readFileSync(file, 'utf8').trim();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(r.out, new RegExp(key.slice(2)));
  assert.match(r.out, new RegExp(new Wallet(key).address));
  assert.notEqual(cli(['key', 'new']).code, 0, 'refuses to overwrite');
  assert.equal(cli(['key', 'address']).out.trim(), new Wallet(key).address);
});

test('keystore with ZETAPHY_PASSPHRASE, env key, bad files', () => {
  const w = Wallet.createRandom();
  const ks = join(dir, 'ks.key.json');
  writeFileSync(ks, w.encryptSync('pw 1'));
  assert.match(cli(['key', 'address', '--key-file', join(dir, 'ks.key')]).out, /encrypted: set ZETAPHY_PASSPHRASE/);
  assert.match(cli(['key', 'address', '--key-file', ks], { ZETAPHY_PASSPHRASE: 'wrong' }).out, /wrong ZETAPHY_PASSPHRASE/);
  assert.equal(cli(['key', 'address', '--key-file', ks], { ZETAPHY_PASSPHRASE: 'pw 1' }).out.trim(), w.address);
  assert.equal(cli(['key', 'address'], { ZETAPHY_PRIVATE_KEY: w.privateKey, ZETAPHY_HOME: join(dir, 'none') }).out.trim(), w.address);
  writeFileSync(join(dir, 'bad.key'), 'hello');
  assert.match(cli(['key', 'address', '--key-file', join(dir, 'bad.key')]).out, /not a key file/);
  assert.match(cli(['key', 'address'], { ZETAPHY_HOME: join(dir, 'none') }).out, /no key at .*key new/);
  assert.match(cli(['deploy']).out, /--rpc URL is required/);
});
