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
import { pqAddress, encodeTxBody, encodeMsgSend, encodeAuthInfo, encodeSignDoc, encodeTxRaw, bytesToHex, MSG_SEND_TYPE_URL } from '../src/pqtx.js';

const PORT = 18845;
const RPC = `http://127.0.0.1:${PORT}`;
const MLDSA = '0x0000000000000000000000000000000000000900';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-pq-'));
const actors = Object.fromEntries(['deployer', 'alice', 'carol'].map((n) => [n, Wallet.createRandom()]));
const bob = Wallet.createRandom().address;
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', ZETAPHY_CHAIN_ID: 'zetaphy-local-1' };
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
    [join(root, 'chain'), String(PORT), ...Object.values(actors).map((w) => w.address)], { stdio: 'inherit', env: { ...env, PQ: '1', FAUCET: '1' } });
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

// Native PQ accounts: ordinary Cosmos transactions whose only key is
// ML-DSA-44 (no ECDSA anywhere, no gas payer), checked by the chain's ante
// handler and sent through zetaphy_sendCosmosTx on the public 8545 port.
test('native PQ account: send with ML-DSA only; forged, tampered and replayed txs are refused', { timeout: 180_000 }, async () => {
  const seed = (b) => '0x' + Buffer.alloc(32, b).toString('hex');
  for (const [n, b] of [['dave', 7], ['eve', 8]]) {
    mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, n, 'pq.seed'), seed(b) + '\n', { mode: 0o600 });
  }
  const dave = ml_dsa44.keygen(Buffer.alloc(32, 7));
  const eve = ml_dsa44.keygen(Buffer.alloc(32, 8));
  const daveAddr = pqAddress(dave.publicKey);
  const to = Wallet.createRandom().address;

  // Before it has funds the account does not exist.
  const empty = await cli('dave', ['pq', 'native']);
  assert.equal(empty.code, 0, empty.out);
  assert.match(empty.out, /send ZETAPHY to this address first/);

  await (await actors.deployer.connect(provider).sendTransaction({ to: daveAddr.hex, value: parseEther('10') })).wait();
  for (const amount of ['1', '0.25']) {
    const r = await cli('dave', ['pq', 'native', 'send', to, amount]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /signed with ML-DSA-44/);
    await new Promise((res) => setTimeout(res, 2500)); // next sequence needs the block
  }
  assert.equal(await provider.getBalance(to), parseEther('1.25'));
  const acct = await provider.send('zetaphy_pqAccount', [daveAddr.bech32]);
  assert.equal(acct.pubKeyType, 'mldsa44');
  assert.equal(acct.sequence, '2');

  // Hand-built txs from dave's account for the attacks below.
  const price = BigInt(await provider.send('eth_gasPrice', [])) * 2n;
  const build = ({ signer, key, sequence = BigInt(acct.sequence), tamper = false }) => {
    const bodyBytes = encodeTxBody({ messages: [{ typeUrl: MSG_SEND_TYPE_URL, value: encodeMsgSend({ fromAddress: daveAddr.bech32, toAddress: pqAddress(eve.publicKey).bech32, amount: [{ denom: 'azetaphy', amount: '1000' }] }) }] });
    const authInfoBytes = encodeAuthInfo({ signerInfos: [{ publicKey: signer.publicKey, sequence }], fee: { amount: [{ denom: 'azetaphy', amount: String(400000n * price) }], gasLimit: 400000n } });
    const sig = ml_dsa44.sign(encodeSignDoc({ bodyBytes, authInfoBytes, chainId: 'zetaphy-local-1', accountNumber: BigInt(acct.accountNumber) }), key.secretKey);
    if (tamper) sig[100] ^= 1;
    return '0x' + bytesToHex(encodeTxRaw({ bodyBytes, authInfoBytes, signatures: [sig] }));
  };
  const send = (hex) => provider.send('zetaphy_sendCosmosTx', [hex]);

  // Eve signs with her own key but claims dave's account: wrong key for the account.
  const forged = await send(build({ signer: eve, key: eve }));
  assert.notEqual(forged.code, 0, 'forged tx accepted');
  // Dave's key, but a flipped bit in the signature.
  const tampered = await send(build({ signer: dave, key: dave, tamper: true }));
  assert.notEqual(tampered.code, 0, 'tampered tx accepted');
  assert.match(tampered.log, /signature verification failed/);
  // A valid tx with an old sequence (a replay) is refused.
  const replay = await send(build({ signer: dave, key: dave, sequence: 0n }));
  assert.notEqual(replay.code, 0, 'replayed tx accepted');
  assert.match(replay.log, /sequence/);
  // Garbage is not passed on.
  await assert.rejects(send('0x1234'), /not a Cosmos transaction/);
  assert.equal(await provider.getBalance(to), parseEther('1.25'));
});

// Testnet faucet (zetaphy_faucet): newcomers get 10 ZETAPHY once a day,
// by 0x or zetaphy1 address; rich addresses and repeats are refused.
test('faucet: 10 ZETAPHY once per address; repeats and rich addresses refused', { timeout: 60_000 }, async () => {
  const fresh = Wallet.createRandom().address;
  const r = await provider.send('zetaphy_faucet', [fresh]);
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  const pqNew = pqAddress(ml_dsa44.keygen(Buffer.alloc(32, 9)).publicKey);
  await provider.send('zetaphy_faucet', [pqNew.bech32]);
  await new Promise((res) => setTimeout(res, 3000));
  assert.equal(await provider.getBalance(fresh), parseEther('10'));
  assert.equal(await provider.getBalance(pqNew.hex), parseEther('10'));
  await assert.rejects(provider.send('zetaphy_faucet', [fresh]), /less than a day ago|already has/);
  await assert.rejects(provider.send('zetaphy_faucet', [actors.deployer.address]), /already has ZETAPHY/);
  await assert.rejects(provider.send('zetaphy_faucet', ['not-an-address']), /invalid address/);
});
