// "Neuro-checked" certificates (item 19) and the hash anchor (item 30): NeuroAttest + NeuroAnchor.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';

const V = '0x' + '5a'.repeat(32);
const SKILL = '0x' + '5c'.repeat(32);
const abi = AbiCoder.defaultAbiCoder();
let c, jobs, att, anchor;
const a = (n) => c.acct[n].toString();

async function job(chain, target) {
  await jobs.send('user', 'request', [encodeBytes32String(chain), target], ZETA / 10n);
  const id = (await jobs.call('jobCount')) - 1n;
  const salts = {};
  for (const w of ['w1', 'w2', 'w3']) {
    salts[w] = hexlify(randomBytes(32));
    await jobs.send(w, 'commit', [id, keccak256(abi.encode(['bytes32', 'address', 'bytes32'], [V, a(w), salts[w]]))]).catch(() => {});
  }
  for (const w of ['w1', 'w2', 'w3']) await jobs.send(w, 'reveal', [id, V, salts[w]]).catch(() => {});
  return id;
}

beforeEach(async () => {
  c = await createChain(['gov', 'launcher', 'user', 'w1', 'w2', 'w3', 'anyone']);
  jobs = await c.deploy('NeuroJobs', [100n * ZETA, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'gov');
  for (const w of ['w1', 'w2', 'w3']) await jobs.send(w, 'register', [], 100n * ZETA);
  c.advance(1);
  att = await c.deploy('NeuroAttest', [jobs.address, a('gov')], 'gov');
  anchor = await c.deploy('NeuroAnchor', [], 'gov');
});

test('an approved launcher attests a token it made: the badge shows report hash, skill, model, attester', async () => {
  const token = a('user');
  await assert.rejects(att.send('launcher', 'attest', [token, V, SKILL, encodeBytes32String('rules'), 'neuro:zetaphy:x']), /NotAttester/);
  await assert.rejects(att.send('launcher', 'setAttester', [a('launcher'), true]), /NotGovernance/);
  await att.send('gov', 'setAttester', [a('launcher'), true]);
  await assert.rejects(att.send('launcher', 'attest', [token, '0x' + '00'.repeat(32), SKILL, encodeBytes32String('rules'), '']), /NoReport/);
  await assert.rejects(att.send('launcher', 'attest', [token, V, SKILL, encodeBytes32String('rules'), 'x'.repeat(201)]), /TooLong/);
  const ev = await att.send('launcher', 'attest', [token, V, SKILL, encodeBytes32String('claude-sonnet-5-5'), 'neuro:zetaphy:x']);
  const uid = ev.find((e) => e?.name === 'Attested').args.uid;
  assert.equal(uid, 1n);
  const b = await att.call('badge', [token]);
  assert.equal(b.checked, true);
  assert.equal(b.reportHash, V);
  assert.equal(b.skill, SKILL);
  assert.equal(b.by.toLowerCase(), a('launcher').toLowerCase());
  const full = await att.call('getAttestation', [uid]);
  assert.equal(full.schema, keccak256(Buffer.from('zetaphy.neuro-checked.v1')));
  assert.equal(full.uri, 'neuro:zetaphy:x');
});

test('anyone turns a settled NeuroJobs verdict on chain "zetaphy" about the token into its certificate (once)', async () => {
  const token = a('anyone');
  const id = await job('zetaphy', token.toUpperCase().replace('0X', '0x')); // requested in mixed case: still the same token
  await assert.rejects(att.send('anyone', 'attestFromJob', [id, token]), /NotSettled/, 'inside the challenge window');
  c.advance(4000);
  await assert.rejects(att.send('anyone', 'attestFromJob', [id, a('user')]), /WrongJob/, 'another token');
  await att.send('anyone', 'attestFromJob', [id, token]);
  const b = await att.call('badge', [token]);
  assert.equal(b.checked, true);
  assert.equal(b.reportHash, V, 'the agreed verdict');
  assert.equal(b.by.toLowerCase(), jobs.address.toLowerCase(), 'attested by NeuroJobs itself');
  await assert.rejects(att.send('anyone', 'attestFromJob', [id, token]), /JobUsed/);
  const other = await job('eth', token);
  c.advance(4000);
  await assert.rejects(att.send('anyone', 'attestFromJob', [other, token]), /WrongJob/, 'a job about another chain');
});

test('governance revokes with a reason; the attester may revoke its own; a revoked badge reads unchecked', async () => {
  const token = a('user');
  await att.send('gov', 'setAttester', [a('launcher'), true]);
  await att.send('launcher', 'attest', [token, V, SKILL, encodeBytes32String('rules'), '']);
  await assert.rejects(att.send('anyone', 'revoke', [1, 'no']), /NotGovernance/);
  await att.send('gov', 'revoke', [1, 'report could not be reproduced']);
  assert.equal((await att.call('badge', [token])).checked, false);
  assert.equal(await att.call('revokeReason', [1]), 'report could not be reproduced');
  await assert.rejects(att.send('gov', 'revoke', [1, 'again']), /AlreadyRevoked/);
  await att.send('launcher', 'attest', [token, V, SKILL, encodeBytes32String('rules'), '']);
  assert.equal((await att.call('badge', [token])).checked, true, 'a new attestation');
  await att.send('launcher', 'revoke', [2, 'mine']);
  await assert.rejects(att.send('gov', 'revoke', [3, 'x']), /NoSuchAttestation/);
  assert.equal((await att.call('badge', [a('w1')])).checked, false, 'never attested');
});

test('NeuroAnchor: the first time a hash was anchored stays; zero and repeats are refused', async () => {
  const h = keccak256('0x1234');
  const [t0] = await anchor.call('anchoredAt', [h]);
  assert.equal(t0, 0n);
  await anchor.send('anyone', 'anchor', [h]);
  const [t1, , by] = await anchor.call('anchoredAt', [h]);
  assert.equal(t1, c.now());
  assert.equal(by.toLowerCase(), a('anyone').toLowerCase());
  c.advance(100);
  await assert.rejects(anchor.send('user', 'anchor', [h]), /AlreadyAnchored/);
  await assert.rejects(anchor.send('user', 'anchor', ['0x' + '00'.repeat(32)]), /Zero/);
});
