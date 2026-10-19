// Stage 5 on a real ZETAPHY chain built with the ML-DSA precompile patch
// (zetaphy-chain/setup-node.sh). Keys and signatures come from
// @noble/post-quantum (JavaScript); the chain verifies them with Cloudflare
// CIRCL (Go): two independent FIPS 204 implementations must agree.
//   ZETAPHYD=/path/to/patched/zetaphyd npm run test:devnet:pq

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, concat, getBytes, hexlify, parseEther, keccak256, toBeHex } from 'ethers';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';

const PORT = 18845;
const RPC = `http://127.0.0.1:${PORT}`;
const MLDSA = '0x0000000000000000000000000000000000000900';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-pq-'));
const actors = Object.fromEntries(['deployer', 'alice', 'carol'].map((n) => [n, Wallet.createRandom()]));
const bob = Wallet.createRandom().address;
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
let provider;

function cli(actor, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args, '--rpc', RPC], {
      env: { ...env, ZETAPHY_HOME: join(root, actor) }, timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}

before(() => {
  for (const [n, w] of Object.entries(actors)) {
    mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, n, 'worker.key'), w.privateKey + '\n', { mode: 0o600 });
  }
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname,
    [join(root, 'chain'), String(PORT), ...Object.values(actors).map((w) => w.address)], { stdio: 'inherit', env: { ...env, PQ: '1' } });
  provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
});
after(() => { try { process.kill(Number(readFileSync(join(root, 'chain', 'node.pid'), 'utf8'))); } catch {} });

test('the chain verifies ML-DSA-44 signatures made in JavaScript', async () => {
  const { publicKey, secretKey } = ml_dsa44.keygen(new Uint8Array(32).fill(9));
  const msg = getBytes(keccak256('0x1234'));
  const sig = ml_dsa44.sign(msg, secretKey);
  const input = (m, s) => hexlify(concat([toBeHex(44, 1), m, publicKey, s]));
  assert.equal(BigInt(await provider.call({ to: MLDSA, data: input(msg, sig) })), 1n);
  const bad = Uint8Array.from(sig); bad[5] ^= 1;
  assert.equal(await provider.call({ to: MLDSA, data: input(msg, bad) }), '0x');
  const other = Uint8Array.from(msg); other[0] ^= 1;
  assert.equal(await provider.call({ to: MLDSA, data: input(other, sig) }), '0x');
});

test('post-quantum-only wallet: receive before it exists, then send with ML-DSA', { timeout: 120_000 }, async () => {
  const d = await cli('deployer', ['deploy-pq']);
  assert.equal(d.code, 0, d.out);
  const factory = /QuantumWalletFactory (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  const a = await cli('alice', ['pq', 'new', '--pqFactory', factory]);
  assert.equal(a.code, 0, a.out);
  const wallet = /wallet: (0x[0-9a-fA-F]{40})/.exec(a.out)[1];
  assert.match(a.out, /post-quantum only/);
  assert.match(a.out, /not deployed yet/);

  const deployer = actors.deployer.connect(provider);
  await (await deployer.sendTransaction({ to: wallet, value: parseEther('5') })).wait();
  const s = await cli('alice', ['pq', 'send', bob, '1.5']);
  assert.equal(s.code, 0, s.out);
  assert.equal(await provider.getBalance(bob), parseEther('1.5'));
  assert.equal(await provider.getBalance(wallet), parseEther('3.5'));
  console.log(s.out.trim());
});

test('hybrid wallet: ML-DSA and ECDSA together', { timeout: 120_000 }, async () => {
  const factory = /QuantumWalletFactory (0x[0-9a-fA-F]{40})/.exec((await cli('deployer', ['deploy-pq'])).out)[1];
  const n = await cli('carol', ['pq', 'new', '--hybrid', '--pqFactory', factory]);
  assert.match(n.out, /hybrid/);
  const wallet = /wallet: (0x[0-9a-fA-F]{40})/.exec(n.out)[1];
  await (await actors.deployer.connect(provider).sendTransaction({ to: wallet, value: parseEther('2') })).wait();
  const s = await cli('carol', ['pq', 'send', bob, '0.5']);
  assert.equal(s.code, 0, s.out);
  assert.equal(await provider.getBalance(bob), parseEther('2'));
});
