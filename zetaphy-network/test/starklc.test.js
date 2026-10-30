// STARK light client (src/starklc): valid proofs verify; forged power, forged
// bitmaps, wrong set roots, tampered certificates and tampered proofs fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { P, mul, inv, ntt, intt, rootOfUnity, cosetEval, cosetInterpolate, evalPoly } from '../src/starklc/field.js';
import { buildTree, openMany, verifyMany, leafHash } from '../src/starklc/hash.js';
import {
  buildSet, prove, verifyProof, encodeProof, decodeProof, statementMessage, StarkLightClient, proveBlock, proveHandoff,
  handoffMessage, blockStatement, collectFromNode, sampleBits, samplesFor, starkBitsConjectured, starkBitsProvable, DEFAULT_PARAMS,
} from '../src/starklc/index.js';
import { testValidators, signAll } from '../src/starklc/fixtures.js';

const CHAIN = 'zetaphy-test-1';
const HASH = new Uint8Array(32).map((_, i) => i * 7);
const st = blockStatement(CHAIN, 1234, HASH);
const V4 = testValidators(4); // powers 100, 137, 174, 211 (total 622)
const SET4 = buildSet(V4);
const sigsOf = (vs, s = st) => signAll(vs, statementMessage(s));
const verify = (p, o = {}) => verifyProof(p instanceof Uint8Array ? p : encodeProof(p), { pin: SET4.pin, chainId: CHAIN, ...o });

test('field: NTT round trip, coset LDE, inverses', () => {
  const w = rootOfUnity(16);
  const a = Array.from({ length: 16 }, (_, i) => BigInt(i * i + 3));
  assert.deepEqual(intt(ntt(a, w), w), a);
  const ev = cosetEval(a.slice(0, 5), 32, 3n);
  assert.deepEqual(cosetInterpolate(ev, 3n).slice(0, 5), a.slice(0, 5));
  assert.equal(ev[7], evalPoly(a.slice(0, 5), mul(3n, (rootOfUnity(32) ** 7n) % P)));
  assert.equal(mul(inv(123456789n), 123456789n), 1n);
});

test('merkle multiproofs: every subset opens, a wrong leaf or index fails', () => {
  const leaves = Array.from({ length: 16 }, (_, i) => leafHash(Uint8Array.of(i)));
  const t = buildTree(leaves);
  for (const idx of [[0], [15], [0, 1], [3, 4, 9], [0, 2, 4, 6, 8, 10, 12, 14], [...Array(16).keys()]]) {
    const pr = openMany(t, idx);
    assert.ok(verifyMany(t.root, 4, idx, idx.map((i) => leaves[i]), pr));
    assert.ok(!verifyMany(t.root, 4, idx, idx.map((i) => leaves[(i + 1) % 16]), pr));
  }
  assert.ok(!verifyMany(t.root, 4, [2, 1], [leaves[2], leaves[1]], openMany(t, [1, 2])));
});

test('valid proofs verify in all three modes, and report the rule and security', () => {
  const sigs = sigsOf(V4);
  const all = prove({ set: SET4, statement: st, signatures: sigs, reveal: 'all' });
  const r = verify(all);
  assert.equal(r.ok, true);
  assert.equal(r.pqMajority, true);
  assert.equal(r.S, 622n); assert.equal(r.T, 622n); assert.equal(r.U, 0n); assert.equal(r.C, 4n);
  assert.equal(r.required, 415n);
  assert.equal(r.sigBits, Infinity);
  assert.equal(r.revealed, 4);
  assert.equal(r.statement.hash, Buffer.from(HASH).toString('hex'));
  assert.equal(r.starkBits.conjectured, 128);
  assert.equal(r.starkBits.provable, 72);

  const sample = prove({ set: SET4, statement: st, signatures: sigs, reveal: 'sample', sigBits: 40 });
  const rs = verify(sample, { minSigBits: 40 });
  assert.ok(rs.sigBits >= 40 && rs.sigBits < 41, String(rs.sigBits));
  assert.throws(() => verify(sample), /below the required 128/); // default: 128 bits

  const none = prove({ set: SET4, statement: st, signatures: sigs, reveal: 'none' });
  assert.throws(() => verify(none), /mode none/);
  const rn = verify(none, { minSigBits: 0 }); // explicit trust in the prover for ML-DSA validity
  assert.equal(rn.sigBits, 0); assert.equal(rn.S, 622n); assert.equal(rn.revealed, 0);
});

test('not enough signers: the proof verifies but ok is false', () => {
  const sigs = sigsOf(V4.slice(2)); // 174 + 211 = 385 < 415
  const r = verify(prove({ set: SET4, statement: st, signatures: sigs }));
  assert.equal(r.S, 385n); assert.equal(r.C, 2n);
  assert.equal(r.ok, false); assert.equal(r.pqMajority, false);
});

test('keyless validators: U is proven and the chain rule 3S > 2T - 3U applied', () => {
  const vs = testValidators(6, { keyless: 3 }); // validators 2 and 5 have no key
  const set = buildSet(vs);
  const signers = vs.filter((v) => v.pubKey).slice(0, 3);
  const r = verifyProof(encodeProof(prove({ set, statement: st, signatures: sigsOf(signers) })), { pin: set.pin, chainId: CHAIN });
  const T = vs.reduce((a, v) => a + v.power, 0n), U = vs.filter((v) => !v.pubKey).reduce((a, v) => a + v.power, 0n);
  assert.equal(r.T, T); assert.equal(r.U, U);
  assert.equal(r.ok, 3n * r.S > 2n * T - 3n * U);
  assert.throws(() => prove({ set, statement: st, signatures: new Map([[vs[2].address, new Uint8Array(2420)]]) }), /no vote key/);
});

test('forged power: public S, T, U or C changed after the fact fails', () => {
  const sigs = sigsOf(V4.slice(1));
  for (const key of ['S', 'T', 'U', 'C']) {
    const p = prove({ set: SET4, statement: st, signatures: sigs });
    p.pub[key] += 1000n;
    assert.throws(() => verify(p), /constraints do not hold|sample|counts/, key);
    // ... and a prover that claims it from the start, with an otherwise honest trace
    const q = prove({ set: SET4, statement: st, signatures: sigs, hooks: { witness: (_, pub) => { pub[key] += 1000n; } } });
    assert.throws(() => verify(q), /constraints do not hold|counts|FRI/, key);
  }
});

test('forged bitmap: a bit set without the matching sums, or a non-binary bit, fails', () => {
  const sigs = sigsOf(V4.slice(2));
  const flip = prove({ set: SET4, statement: st, signatures: sigs, reveal: 'none', hooks: { witness: (t) => { t[0][0] = 1n; } } });
  assert.throws(() => verify(flip, { minSigBits: 0 }), /constraints do not hold|FRI/);
  const two = prove({ set: SET4, statement: st, signatures: sigs, reveal: 'none', hooks: { witness: (t, pub) => {
    t[0][3] = 2n; for (let i = 3; i < 7; i++) t[2][i + 1] = t[2][i] + t[0][i] * SET4.cols[3][i]; pub.S = t[2][7];
  } } });
  assert.throws(() => verify(two, { minSigBits: 0 }), /constraints do not hold|FRI/);
});

test('forged signer with consistent sums: caught by the signature reveals, NOT by mode none', () => {
  // Validators 0 and 1 did not sign; the prover claims they did with junk signatures.
  const sigs = sigsOf(V4.slice(2));
  const junk = new Map([...sigs, [V4[0].address, new Uint8Array(2420).fill(1)], [V4[1].address, new Uint8Array(2420).fill(2)]]);
  const base = { set: SET4, statement: st, signatures: junk, checkSignatures: false };
  assert.throws(() => verify(prove({ ...base, reveal: 'all' })), /ML-DSA-44 signature does not verify/);
  assert.throws(() => verify(prove({ ...base, reveal: 'sample', sigBits: 40 }), { minSigBits: 40 }), /does not verify/);
  // mode none trusts the prover: the forged accounting passes. This is the stated trust assumption.
  assert.equal(verify(prove({ ...base, reveal: 'none' }), { minSigBits: 0 }).ok, true);
  // 'all' with a signer left out of the reveals (count mismatch)
  const p = prove({ set: SET4, statement: st, signatures: sigsOf(V4), reveal: 'all' });
  p.reveals.pop();
  assert.throws(() => verify(p), /revealed but the proof counts/);
});

test('tampered certificate: a signature over another block, chain or height is rejected', () => {
  const other = blockStatement(CHAIN, 1235, HASH);
  const wrong = new Map([...sigsOf(V4.slice(1)), [V4[0].address, ml_dsa44.sign(statementMessage(other), V4[0].secretKey)]]);
  assert.throws(() => prove({ set: SET4, statement: st, signatures: wrong }), /does not verify/);
  const p = proveBlock({ set: SET4, chainId: CHAIN, height: 1234, blockHash: HASH, signatures: wrong });
  assert.deepEqual(p.skipped, [V4[0].address]); // the honest prover drops it, as the chain does
  assert.equal(verify(p.bytes).C, 3n);
  // a revealed signature swapped for another valid one of the same validator: not the committed one
  const q = prove({ set: SET4, statement: st, signatures: sigsOf(V4) });
  q.reveals[0].sig = ml_dsa44.sign(statementMessage(st), V4.find((v) => v.pubKey && q.reveals[0].pk.every((b, i) => b === v.pubKey[i])).secretKey);
  assert.throws(() => verify(q), /not the one committed|does not verify/);
});

test('wrong set root, wrong chain, wrong statement: rejected', () => {
  const bytes = encodeProof(prove({ set: SET4, statement: st, signatures: sigsOf(V4) }));
  const otherSet = buildSet(V4.map((v, i) => (i ? v : { ...v, power: v.power + 1n })));
  // the set root is in the Fiat-Shamir transcript, so another root changes every challenge
  assert.throws(() => verifyProof(bytes, { pin: otherSet.pin, chainId: CHAIN }), /constraints do not hold|pinned set root/);
  assert.throws(() => verifyProof(bytes, { pin: buildSet(testValidators(9)).pin, chainId: CHAIN }), /rows/);
  assert.throws(() => verify(bytes, { chainId: 'other-1' }), /not other-1/);
  const p = decodeProof(bytes);
  p.statement.hash = new Uint8Array(32).fill(9);
  assert.throws(() => verify(p), /./);
  const h = decodeProof(bytes);
  h.statement.height += 1n;
  assert.throws(() => verify(h), /./);
});

test('tampered proof bytes: every flipped byte is rejected', () => {
  const bytes = encodeProof(prove({ set: SET4, statement: st, signatures: sigsOf(V4.slice(1)), reveal: 'sample', sigBits: 20 }));
  verify(bytes, { minSigBits: 20 });
  const step = Math.max(1, Math.floor(bytes.length / 400));
  let n = 0;
  for (let i = 0; i < bytes.length; i += step) {
    const b = bytes.slice();
    b[i] ^= 0x01;
    assert.throws(() => verify(b, { minSigBits: 20 }), undefined, `byte ${i}`);
    n++;
  }
  assert.ok(n >= 300);
  assert.throws(() => verify(bytes.subarray(0, bytes.length - 1)), /malformed/);
});

test('weak parameters are refused; security numbers', () => {
  const sigs = sigsOf(V4);
  const weak = prove({ set: SET4, statement: st, signatures: sigs, params: { queries: 8, grind: 4 } });
  assert.throws(() => verify(weak), /STARK parameters give 36 bits/);
  assert.equal(verify(weak, { minStarkBits: 30 }).ok, true);
  assert.equal(starkBitsConjectured(DEFAULT_PARAMS), 128);
  assert.equal(starkBitsProvable(DEFAULT_PARAMS), 72);
  // all power signed vs a 2/3 threshold: log2(1.5) = 0.585 bits per sample
  assert.equal(samplesFor(128, 300n, 600n), 219);
  assert.ok(Math.abs(sampleBits(219, 300n, 600n) - 128.1) < 0.1);
  assert.equal(sampleBits(10, 200n, 600n), 0);
  assert.equal(sampleBits(0, 1n, 0n), Infinity);
});

test('sampling: forging part of the signers is caught with the stated probability', () => {
  // 21 validators; 15 sign honestly (just under 2/3 after removing one), the prover adds 6 junk signers.
  const vs = testValidators(21, { powerOf: () => 10n });
  const set = buildSet(vs);
  const honest = sigsOf(vs.slice(0, 13)); // 130 of 210: below the 141 needed
  const junk = new Map([...honest, ...vs.slice(13).map((v, i) => [v.address, new Uint8Array(2420).fill(i + 1)])]);
  // S = 210 (claimed), need = 420: the bound uses 3S/need = 1.5 (0.585 bits a sample), so 30 bits -> 52
  // samples; the real chance a sample hits a junk signer is 80/210, so all pass w.p. (130/210)^52 < 2^-36.
  let caught = 0;
  for (const h of [1, 2, 3]) {
    const s = blockStatement(CHAIN, h, HASH);
    const p = prove({ set, statement: s, signatures: junk, checkSignatures: false, reveal: 'sample', sigBits: 30 });
    assert.equal(p.reveal.k, 52);
    try { verifyProof(encodeProof(p), { pin: set.pin, chainId: CHAIN, minSigBits: 30 }); } catch (e) { if (/does not verify/.test(e.message)) caught++; }
  }
  assert.equal(caught, 3);
});

test('epoch chain: genesis pin -> handoff -> blocks of the new set; a bad handoff is refused', () => {
  const g = testValidators(4, { label: 'epoch0' });
  const nextVals = testValidators(5, { label: 'epoch1' });
  const set0 = buildSet(g), set1 = buildSet(nextVals);
  const lc = new StarkLightClient({ chainId: CHAIN, pin: set0.pin });
  const ho = proveHandoff({ set: set0, nextSet: set1, chainId: CHAIN, epoch: 1, signatures: signAll(g, handoffMessage(CHAIN, 1, set1)) });
  // a block of epoch 1 is not accepted before the handoff
  const blk = proveBlock({ set: set1, chainId: CHAIN, height: 50, blockHash: HASH, signatures: signAll(nextVals, statementMessage(blockStatement(CHAIN, 50, HASH))) });
  assert.throws(() => lc.verifyBlock(blk.bytes), /rows|pinned set root|constraints do not hold/);
  // a handoff signed by the next set itself (not the current one) is refused
  const selfSigned = proveHandoff({ set: set1, nextSet: set1, chainId: CHAIN, epoch: 1, signatures: signAll(nextVals, handoffMessage(CHAIN, 1, set1)) });
  assert.throws(() => lc.applyHandoff(selfSigned.bytes), /rows|pinned set root|constraints do not hold/);
  // a handoff with less than 2/3 of the power is refused
  const weak = proveHandoff({ set: set0, nextSet: set1, chainId: CHAIN, epoch: 1, signatures: signAll(g.slice(0, 2), handoffMessage(CHAIN, 1, set1)) });
  assert.throws(() => lc.applyHandoff(weak.bytes), /2\/3/);
  // a block proof is not a handoff, and the epoch must follow
  assert.throws(() => lc.applyHandoff(proveBlock({ set: set0, chainId: CHAIN, height: 1, blockHash: HASH, signatures: signAll(g, statementMessage(blockStatement(CHAIN, 1, HASH))) }).bytes), /not a handoff/);
  const skip = proveHandoff({ set: set0, nextSet: set1, chainId: CHAIN, epoch: 2, signatures: signAll(g, handoffMessage(CHAIN, 2, set1)) });
  assert.throws(() => lc.applyHandoff(skip.bytes), /expected 1/);
  lc.applyHandoff(ho.bytes);
  assert.equal(lc.epoch, 1n);
  assert.equal(lc.pin.root, set1.pin.root);
  const r = lc.verifyBlock(blk.bytes);
  assert.equal(r.ok, true); assert.equal(r.statement.height, 50n);
});

test('from a real devnet block (Go-built certificate in pqcert-devnet.json) to a verified proof', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/pqcert-devnet.json', import.meta.url), 'utf8'));
  const rpc = async (method, params) => {
    if (method === 'block') return fx.block[params.height];
    if (method === 'validators') return fx.validators[params.height];
    if (method === 'abci_query') return fx.abci_query[params.data.slice(2)];
    throw new Error(method);
  };
  const data = await collectFromNode(rpc, 13);
  assert.equal(data.chainId, 'zetaphy-pqcert-1');
  const { set, bytes, skipped } = proveBlock(data);
  assert.deepEqual(skipped, []);
  const lc = new StarkLightClient({ chainId: 'zetaphy-pqcert-1', pin: set.pin });
  const r = lc.verifyBlock(bytes);
  assert.equal(r.ok, true); assert.equal(r.pqMajority, true);
  assert.equal(r.S, 10_000_000n); assert.equal(r.C, 2n);
  assert.equal(r.statement.hash.toUpperCase(), fx.block['13'].block_id.hash);
});
