import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { Wallet, keccak256, concat, randomBytes, hexlify, Interface } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';

const MLDSA = '0x0000000000000000000000000000000000000900';
const PK = hexlify(randomBytes(1312)); // shape of an ML-DSA-44 public key
const PK_HASH = keccak256(PK);
const owner = Wallet.createRandom();
const ZERO = '0x' + '00'.repeat(20);

function mockRuntime() {
  const input = { language: 'Solidity', sources: { 'M.sol': { content: readFileSync(new URL('./helpers/MockMLDSA.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } } };
  return '0x' + JSON.parse(solc.compile(JSON.stringify(input))).contracts['M.sol'].MockMLDSA.evm.deployedBytecode.object;
}
const MOCK = mockRuntime();
const pqSign = (digest, pk = PK) => keccak256(concat([digest, pk])); // the stand-in's rule
const ecdsaSign = (digest, w = owner) => w.signingKey.sign(digest).serialized;

let c, factory, wallet;
beforeEach(async () => {
  c = await createChain(['payer', 'bob', 'relay']);
  await c.putCode(MLDSA, MOCK);
  factory = await c.deploy('QuantumWalletFactory', [], 'payer');
});

async function makeWallet(ecdsaOwner) {
  const predicted = await factory.call('predict', [ecdsaOwner, 44, PK_HASH]);
  await factory.send('relay', 'create', [ecdsaOwner, 44, PK_HASH]);
  const art = JSON.parse(readFileSync(new URL('../artifacts/QuantumWallet.json', import.meta.url), 'utf8'));
  const w = { address: predicted, iface: new Interface(art.abi) };
  // Bind send/call on the predicted address through a tiny proxy of the helper.
  w.send = (from, fn, args = [], value = 0n) => c.sendTo(from, predicted, w.iface, fn, args, value);
  w.call = (fn, args = []) => c.callAt(predicted, w.iface, fn, args);
  return w;
}

async function act(w, { to, value = 0n, data = '0x', deadline = c.now() + 600n, pk = PK, pq, ec }) {
  const d = await w.call('digest', [to, value, data, deadline]);
  const auth = [pk, pq ?? pqSign(d, pk), ec ?? ecdsaSign(d)];
  return w.send('relay', 'execute', [to, value, data, deadline, auth]);
}

test('factory deploys at the predicted address', async () => {
  const w = await makeWallet(owner.address);
  assert.equal(await w.call('pqKeyHash'), PK_HASH);
  assert.equal(await w.call('ecdsaOwner'), owner.address);
});

test('hybrid mode: needs both ECDSA and ML-DSA; anyone can relay', async () => {
  const w = await makeWallet(owner.address);
  await c.transfer('payer', w.address, 10n * ZETA);
  const bob = c.acct.bob.toString();
  const before = await c.balance('bob');
  await act(w, { to: bob, value: ZETA });
  assert.equal(await c.balance('bob') - before, ZETA);
  assert.equal(await w.call('nonce'), 1n);

  await assert.rejects(act(w, { to: bob, value: ZETA, ec: ecdsaSign('0x' + '00'.repeat(32), Wallet.createRandom()) }), /BadEcdsa/);
  await assert.rejects(act(w, { to: bob, value: ZETA, pq: '0x' + '11'.repeat(32) }), /BadPq/);
  await assert.rejects(act(w, { to: bob, value: ZETA, pk: hexlify(randomBytes(1312)) }), /WrongKey/);
  await assert.rejects(act(w, { to: bob, value: ZETA, deadline: c.now() - 1n }), /Expired/);
});

test('a signed action cannot be replayed (nonce is in the digest)', async () => {
  const w = await makeWallet(owner.address);
  await c.transfer('payer', w.address, 10n * ZETA);
  const bob = c.acct.bob.toString();
  const deadline = c.now() + 600n;
  const d = await w.call('digest', [bob, ZETA, '0x', deadline]);
  const auth = [PK, pqSign(d), ecdsaSign(d)];
  await w.send('relay', 'execute', [bob, ZETA, '0x', deadline, auth]);
  await assert.rejects(w.send('relay', 'execute', [bob, ZETA, '0x', deadline, auth]), /BadEcdsa|BadPq/);
});

test('post-quantum-only mode: no ECDSA key at all', async () => {
  const w = await makeWallet(ZERO);
  await c.transfer('payer', w.address, 2n * ZETA);
  await act(w, { to: c.acct.bob.toString(), value: ZETA, ec: '0x' });
  await assert.rejects(act(w, { to: c.acct.bob.toString(), value: ZETA, ec: '0x', pq: '0x' + '22'.repeat(32) }), /BadPq/);
});

test('keys rotate only through the wallet itself', async () => {
  const w = await makeWallet(owner.address);
  const PK2 = hexlify(randomBytes(1312));
  await assert.rejects(w.send('bob', 'setKeys', [ZERO, 44, keccak256(PK2)]), /OnlySelf/);
  const data = w.iface.encodeFunctionData('setKeys', [ZERO, 44, keccak256(PK2)]);
  await act(w, { to: w.address, data });
  assert.equal(await w.call('ecdsaOwner'), ZERO);
  assert.equal(await w.call('pqKeyHash'), keccak256(PK2));
  // the old key no longer works; the new one does
  await assert.rejects(act(w, { to: c.acct.bob.toString(), ec: '0x' }), /WrongKey/);
  await act(w, { to: c.acct.bob.toString(), ec: '0x', pk: PK2 });
  await assert.rejects(act(w, { to: w.address, ec: '0x', pk: PK2, data: w.iface.encodeFunctionData('setKeys', [ZERO, 7, keccak256(PK2)]) }), /CallFailed/);
});
