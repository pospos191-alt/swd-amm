// Human-or-agent labels: passkey (WebAuthn) proofs checked on chain through WebAuthnVerifier and the P-256
// precompile (a JS RIP-7212 implementation at 0x…0100 here; cosmos/evm's p256 precompile on ZETAPHY),
// EIP-712 attestations from approved runners, agent labels read live from AgentRegistry, and two hooks
// (a faucet and a DEX swap gate) that read the labels.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, hexlify, randomBytes, keccak256, AbiCoder, ZeroHash, getBytes } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES, passkey, mldsaKey } from './helpers/precompiles.js';

const DAY = 86_400;
const TTL = 180 * DAY;
const MAX = 2n ** 256n - 1n;
const attester = Wallet.createRandom();
let c, reg, wa, labels, pk;
const addr = (n) => c.acct[n].toString();

beforeEach(async () => {
  c = await createChain(['gov', 'alice', 'bob', 'bot', 'operator', 'relay', 'dex'], {}, { precompiles: PRECOMPILES });
  reg = await c.deploy('AgentRegistry', [addr('gov'), 10n * ZETA, 1n * ZETA], 'gov');
  wa = await c.deploy('WebAuthnVerifier', [], 'gov');
  pk = passkey('app.sawasdeecoin.com');
  labels = await c.deploy('LabelRegistry', [addr('gov'), reg.address, wa.address, pk.rpIdHash, TTL], 'gov');
});

const prove = async (who, key = pk, opts = {}) => {
  const ch = await labels.call('humanChallenge', [addr(who)]);
  return labels.send(who, 'proveHumanP256', [key.x, key.y, key.assert(opts.challenge ?? ch, opts)]);
};

test('base64url of the challenge matches what browsers write in clientDataJSON', async () => {
  for (let i = 0; i < 5; i++) {
    const b = hexlify(randomBytes(32));
    assert.equal(await wa.call('base64url', [b]), Buffer.from(getBytes(b)).toString('base64url'));
  }
});

test('a passkey assertion over the account\'s challenge labels it HUMAN (on-chain P-256 check)', async () => {
  assert.equal(await labels.call('labelOf', [addr('alice')]), 0n);
  await prove('alice');
  assert.equal(await labels.call('labelOf', [addr('alice')]), 1n);
  assert.equal(await labels.call('isHuman', [addr('alice')]), true);
  const h = await labels.call('humans', [addr('alice')]);
  assert.equal(h.credentialHash, keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [pk.x, pk.y])));
  assert.equal(h.method, 1n);
  c.advance(TTL + 1);
  assert.equal(await labels.call('labelOf', [addr('alice')]), 0n); // expired
});

test('refused: another site, no user verification, a registration instead of an assertion, another account\'s challenge, a bad signature, a replay', async () => {
  await assert.rejects(prove('alice', pk, { rp: 'evil.example' }), /BadPasskey/);
  await assert.rejects(prove('alice', pk, { flags: 0x01 }), /BadPasskey/); // present but not verified
  await assert.rejects(prove('alice', pk, { type: 'webauthn.create' }), /BadPasskey/);
  await assert.rejects(prove('alice', pk, { challenge: await labels.call('humanChallenge', [addr('bob')]) }), /BadPasskey/);
  const other = passkey('app.sawasdeecoin.com');
  const ch = await labels.call('humanChallenge', [addr('alice')]);
  await assert.rejects(labels.send('alice', 'proveHumanP256', [other.x, other.y, pk.assert(ch)]), /BadPasskey/);
  const a = pk.assert(ch);
  await labels.send('alice', 'proveHumanP256', [pk.x, pk.y, a]);
  await assert.rejects(labels.send('alice', 'proveHumanP256', [pk.x, pk.y, a]), /BadPasskey/); // the nonce moved on
  // extra fields in clientDataJSON (as some browsers add) are fine
  await prove('alice', pk, { extra: ',"other_keys_can_be_added_here":"x"' });
});

test('one passkey labels one account: moving it drops the old label', async () => {
  await prove('alice');
  await prove('bob');
  assert.equal(await labels.call('labelOf', [addr('bob')]), 1n);
  assert.equal(await labels.call('labelOf', [addr('alice')]), 0n);
});

async function attest(signer, account, cred, validUntil, deadline) {
  const nonce = await labels.call('nonces', [account]);
  return signer.signTypedData({ name: 'ZETAPHY Labels', version: '1', chainId: 1, verifyingContract: labels.address },
    { HumanAttestation: [{ name: 'account', type: 'address' }, { name: 'credentialHash', type: 'bytes32' }, { name: 'validUntil', type: 'uint64' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    { account, credentialHash: cred, validUntil, nonce, deadline });
}

test('attester path: an EIP-712 attestation from an approved runner, submitted by anyone', async () => {
  const cred = keccak256('0x1234');
  const until = c.now() + 30n * BigInt(DAY);
  const deadline = c.now() + 600n;
  const sig = await attest(attester, addr('alice'), cred, until, deadline);
  await assert.rejects(labels.send('relay', 'attestHuman', [addr('alice'), cred, until, deadline, sig]), /NotAttester/);
  await assert.rejects(labels.send('alice', 'setAttester', [attester.address, true]), /NotGovernance/);
  await labels.send('gov', 'setAttester', [attester.address, true]);
  await labels.send('relay', 'attestHuman', [addr('alice'), cred, until, deadline, sig]);
  assert.equal(await labels.call('labelOf', [addr('alice')]), 1n);
  assert.equal((await labels.call('humans', [addr('alice')])).attester, attester.address);
  await assert.rejects(labels.send('relay', 'attestHuman', [addr('alice'), cred, until, deadline, sig]), /NotAttester/); // replay
  const long = c.now() + BigInt(TTL) + 10n;
  await assert.rejects(labels.send('relay', 'attestHuman', [addr('bob'), cred, long, deadline, await attest(attester, addr('bob'), cred, long, deadline)]), /BadTtl/);
  const old = c.now() - 1n;
  await assert.rejects(labels.send('relay', 'attestHuman', [addr('bob'), cred, until, old, await attest(attester, addr('bob'), cred, until, old)]), /Expired/);
  // revoking: the account itself, governance or an attester; nobody else
  await assert.rejects(labels.send('bob', 'revokeHuman', [addr('alice')]), /NotAttester/);
  await labels.send('alice', 'revokeHuman', [addr('alice')]);
  assert.equal(await labels.call('labelOf', [addr('alice')]), 0n);
});

test('AGENT label follows AgentRegistry live, and wins over a human label', async () => {
  await prove('bot');
  assert.equal(await labels.call('labelOf', [addr('bot')]), 1n);
  await reg.send('operator', 'register', [addr('bot'), mldsaKey().keyHash, ZeroHash, '0x' + '00'.repeat(20)], 10n * ZETA);
  assert.equal(await labels.call('labelOf', [addr('bot')]), 2n);
  assert.equal(await labels.call('isAgent', [addr('bot')]), true);
  await reg.send('operator', 'requestUnbond', [1n]);
  assert.equal(await labels.call('labelOf', [addr('bot')]), 1n); // no longer an active agent
});

test('faucet hook: an amount per label, a cooldown per account and per passkey', async () => {
  const faucet = await c.deploy('LabelFaucet', [labels.address, addr('gov'), BigInt(DAY), [0n, 10n * ZETA, 1n * ZETA]], 'gov');
  await faucet.sendValue('gov', 100n * ZETA);
  await assert.rejects(faucet.send('alice', 'drip'), /NothingForLabel/);
  await prove('alice');
  let before = await c.balance('alice');
  await faucet.send('alice', 'drip');
  assert.equal(await c.balance('alice') - before, 10n * ZETA);
  await assert.rejects(faucet.send('alice', 'drip'), /TooSoon/);
  await prove('bob'); // the same passkey moved to bob: still the same person's cooldown
  await assert.rejects(faucet.send('bob', 'drip'), /TooSoon/);
  await reg.send('operator', 'register', [addr('bot'), mldsaKey().keyHash, ZeroHash, '0x' + '00'.repeat(20)], 10n * ZETA);
  before = await c.balance('bot');
  await faucet.send('bot', 'drip');
  assert.equal(await c.balance('bot') - before, 1n * ZETA);
  c.advance(DAY);
  await faucet.send('bob', 'drip');
});

test('DEX hook: an hourly input cap per label, counted only for allowed callers', async () => {
  const gate = await c.deploy('LabelSwapGate', [labels.address, addr('gov'), [100n, MAX, 50n]], 'gov');
  await assert.rejects(gate.send('dex', 'check', [addr('alice'), 1n]), /NotCaller/);
  await gate.send('gov', 'setCaller', [addr('dex'), true]);
  await gate.send('dex', 'check', [addr('alice'), 60n]);
  await assert.rejects(gate.send('dex', 'check', [addr('alice'), 41n]), /OverCap/);
  await prove('alice');
  await gate.send('dex', 'check', [addr('alice'), 10n ** 30n]); // humans uncapped here
  await reg.send('operator', 'register', [addr('bot'), mldsaKey().keyHash, ZeroHash, '0x' + '00'.repeat(20)], 10n * ZETA);
  await gate.send('dex', 'check', [addr('bot'), 50n]);
  await assert.rejects(gate.send('dex', 'check', [addr('bot'), 1n]), /OverCap/);
  c.advance(3600);
  await gate.send('dex', 'check', [addr('bot'), 50n]);
});
