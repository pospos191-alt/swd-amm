// Quantum-safe AI attestations (item 30): ML-DSA-44 archives of Neuro reports, tamper detection, the on-chain
// anchor (NeuroAnchor), and the same checks as the hub's browser verifier (zetaphy-hub/pqattest.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { pqFromSeed } from '../src/pq.js';
import { reportPayload, signPayload, verifyFile, NODE_CRYPTO } from '../src/pqattest.js';
import { canonical, verifyArchive, archiveHash, anchoredAtData, readAnchoredAt, FORMAT } from '../../zetaphy-hub/pqattest.js';
import { createChain } from './helpers/evm.js';

const KEY = pqFromSeed('0x' + '42'.repeat(32));
const OTHER = pqFromSeed('0x' + '43'.repeat(32));
const REPORT = {
  chain: 'zetaphy', address: '0xAbCd000000000000000000000000000000000001', functions: ['transfer(address,uint256)', 'mint(address,uint256)'],
  unknownSelectors: [], fingerprint: 'fp1:' + 'ab'.repeat(32), owner: '0x00000000000000000000000000000000000000Fe',
  analysis: { level: 'warn', control: 'owner', findings: [{ id: 'mint-unlimited', severity: 'warn' }, { id: 'sim-sell', severity: 'info' }] },
};
const clone = (x) => JSON.parse(JSON.stringify(x));

async function archive() {
  return signPayload(await reportPayload(REPORT, { skill: '0x' + '5c'.repeat(32), model: 'claude-sonnet-5-5', createdAt: '2026-10-28T00:00:00.000Z' }), KEY);
}

test('canonical JSON: sorted keys, no spaces, refuses what JSON cannot carry exactly', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonical({ a: 1n }), /bigint/);
  assert.throws(() => canonical({ a: NaN }), /non-finite/);
});

test('a signed archive verifies: payload hash, key hash, ML-DSA-44 signature, the report gives its reportHash', async () => {
  const a = await archive();
  assert.equal(a.format, FORMAT);
  assert.equal(a.signature.alg, 'ML-DSA-44');
  assert.equal((a.signature.publicKey.length - 2) / 2, 1312);
  assert.equal((a.signature.sig.length - 2) / 2, 2420);
  assert.equal(a.signature.keyHash, KEY.keyHash, 'the same key hash QuantumWallet / zetaphy pq use');
  assert.equal(a.payload.subject.address, REPORT.address.toLowerCase());
  const r = await verifyFile(a, { trustedKeys: [KEY.keyHash] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.signer, 'trusted');
  assert.equal((await verifyFile(a)).signer, 'unknown', 'valid, but not a key the reader trusts');
  // JSON round trip (the archive is a file) changes nothing
  assert.equal((await verifyFile(JSON.parse(JSON.stringify(a)))).ok, true);
});

test('tamper detection: payload, report, hash, key, signature, format', async () => {
  const a = await archive();
  const bad = async (mut, re) => { const x = clone(a); mut(x); const r = await verifyFile(x); assert.equal(r.ok, false); assert.ok(r.problems.some((p) => re.test(p)), `${re}: ${r.problems.join('; ')}`); };
  await bad((x) => { x.payload.model = 'other'; }, /payload changed/);
  await bad((x) => { x.payload.reportHash = '0x' + '00'.repeat(32); }, /payload changed/);
  await bad((x) => { x.payload.report.analysis.findings[0].severity = 'info'; }, /payload changed/);
  // a forger who also recomputes payloadHash still fails the signature; the report check sees a swapped report
  await bad((x) => { x.payload.report.functions = []; x.payloadHash = '0x' + Buffer.from(NODE_CRYPTO.sha256(new TextEncoder().encode(canonical(x.payload)))).toString('hex'); }, /signature does not verify/);
  await bad((x) => { x.payload.report.functions = []; x.payloadHash = '0x' + Buffer.from(NODE_CRYPTO.sha256(new TextEncoder().encode(canonical(x.payload)))).toString('hex'); }, /does not give its reportHash/);
  await bad((x) => { x.signature.keyHash = OTHER.keyHash; }, /keyHash/);
  await bad((x) => { x.signature.publicKey = '0x' + Buffer.from(OTHER.publicKeyBytes).toString('hex'); x.signature.keyHash = OTHER.keyHash; }, /signature does not verify/);
  await bad((x) => { const s = x.signature.sig; x.signature.sig = s.slice(0, 100) + (s[100] === '0' ? '1' : '0') + s.slice(101); }, /signature does not verify/);
  await bad((x) => { x.signature.sig = x.signature.sig.slice(0, -2); }, /2420/);
  await bad((x) => { x.format = 'other.v1'; }, /format/);
  await bad((x) => { x.signature.alg = 'ECDSA'; }, /alg/);
  // re-signed by another key: valid, but no longer the trusted signer
  const re = await signPayload(a.payload, OTHER);
  const r = await verifyFile(re, { trustedKeys: [KEY.keyHash] });
  assert.equal(r.ok, true);
  assert.equal(r.signer, 'unknown');
});

test('anchored on ZETAPHY: NeuroAnchor holds the archive hash; a wrong hash or time is caught', async () => {
  const c = await createChain(['me']);
  const anchor = await c.deploy('NeuroAnchor', [], 'me');
  const a = await archive();
  const h = await archiveHash(a, NODE_CRYPTO);
  assert.equal(h, keccak256(new TextEncoder().encode(canonical({ format: a.format, payloadHash: a.payloadHash, signature: { alg: a.signature.alg, publicKey: a.signature.publicKey, sig: a.signature.sig } }))));
  await anchor.send('me', 'anchor', [h]);
  const provider = { call: async ({ to, data }) => {
    assert.equal(data, anchoredAtData(h));
    const [time, block, by] = await anchor.call('anchoredAt', ['0x' + data.slice(10)]);
    const w = (v) => BigInt(v).toString(16).padStart(64, '0');
    return '0x' + w(time) + w(block) + w(by);
  } };
  a.anchor = { chainId: 77390, contract: anchor.address, hash: h, time: Number(c.now()) };
  let r = await verifyFile(a, { provider });
  assert.deepEqual(r.problems, []);
  assert.equal(r.anchored.time, Number(c.now()));
  assert.equal(readAnchoredAt(await provider.call({ to: anchor.address, data: anchoredAtData(h) })).time, Number(c.now()));
  // the anchor field is outside the hash; a stated time that differs from the chain is caught
  const t = clone(a); t.anchor.time += 5;
  assert.ok((await verifyFile(t, { provider })).problems.some((p) => /anchor time/.test(p)));
  // a changed payload fails its own hash (the anchor covers payloadHash); a changed payloadHash is another archive
  const u = clone(a); u.payload.model = 'x';
  assert.ok((await verifyFile(u, { provider })).problems.some((p) => /payload changed/.test(p)));
  const v = clone(a); v.payloadHash = '0x' + '11'.repeat(32);
  r = await verifyFile(v, { provider });
  assert.ok(r.problems.some((p) => /anchor.hash is not/.test(p)));
  // an archive nobody anchored
  const w = await signPayload({ ...a.payload, createdAt: '2026-10-29T00:00:00.000Z' }, KEY);
  w.anchor = { chainId: 77390, contract: anchor.address, hash: await archiveHash(w, NODE_CRYPTO) };
  assert.ok((await verifyFile(w, { provider: { call: async () => '0x' + '00'.repeat(96) } })).problems.some((p) => /not anchored/.test(p)));
});

test('the browser verifier path (injected async crypto) gives the same answer', async () => {
  const a = await archive();
  const asyncCrypto = { sha256: async (b) => NODE_CRYPTO.sha256(b), keccak256: async (b) => NODE_CRYPTO.keccak256(b), verify: async (s, m, p) => NODE_CRYPTO.verify(s, m, p) };
  const r = await verifyArchive(a, asyncCrypto);
  assert.equal(r.ok, true);
  assert.equal(r.archiveHash, await archiveHash(a, NODE_CRYPTO));
});
