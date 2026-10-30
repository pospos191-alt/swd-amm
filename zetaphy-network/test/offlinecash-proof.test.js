// ZETAPHY Offline Cash: the offline proof of funds (docs/future/offline-cash.md). Real contract logs (NoteIssued,
// IssuerBonded, HolderBonded from the in-memory EVM) are put in a mocked CometBFT chain: block H's tx results, the
// header of H+1 (its last_results_hash commits them) and the ML-DSA-44 certificate of H+1 in block H+2, signed by
// four validators with real keys. The proof is built from that RPC (src/offlinecash.js) and checked with NO network
// against a pinned validator set (zetaphy-hub/cash-core.js, with pqcert.js's header hash); then tampering, too few
// signers, the attestation fallback, coverage by bonds, and the payee's receive check. Also the formats round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { createHash } from 'node:crypto';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES } from './helpers/precompiles.js';
import { encodeTxBody, encodeTxRaw, varint, bytesToHex, hexToBytes } from '../src/pqtx.js';
import { headerHash as pqHeaderHash, merkleRoot as pqMerkleRoot, voteMessage as pqVoteMessage, CERT_TYPE_URL } from '../src/pqcert.js';
import { core, NODE_CRYPTO as C, holderFromSeed, buildResultsProof, attestLog } from '../src/offlinecash.js';
import { sha256 } from '../src/mesh/frames.js';

const CHAIN = 'zetaphy_77390-1';
const DAY = 86400;
const H = 500;
const b64 = (b) => Buffer.from(b).toString('base64');
const upper = (b) => bytesToHex(b).toUpperCase();
const cat = (...p) => Uint8Array.from(Buffer.concat(p.map((x) => Buffer.from(x))));
const lenDelim = (field, b) => cat(varint((field << 3) | 2), varint(b.length), b);
const VALS = [0, 1, 2, 3].map((i) => ({ address: upper(new Uint8Array(20).fill(0x30 + i)), key: ml_dsa44.keygen(new Uint8Array(32).fill(40 + i)), power: 25n }));
const PIN = { chainId: CHAIN, height: String(H), validators: Object.fromEntries(VALS.map((v) => [v.address, { power: String(v.power), since: '1', pubKey: bytesToHex(v.key.publicKey), previousPubKey: null }])) };
const ISSUER = holderFromSeed(new Uint8Array(32).fill(1));
const [A, B] = [2, 3].map((n) => holderFromSeed(new Uint8Array(32).fill(n)));

function certTx(height, attestations) {
  const value = cat(lenDelim(1, Buffer.from('zetaphy1certsigner')), varint(2 << 3), varint(height), lenDelim(3, attestations));
  return encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: CERT_TYPE_URL, value }] }), authInfoBytes: new Uint8Array(), signatures: [] });
}
function header(height, extra = {}) {
  return { version: { block: '11' }, chain_id: CHAIN, height: String(height), time: '2026-10-30T09:00:00.123456789Z',
    last_block_id: { hash: '11'.repeat(32), parts: { total: 1, hash: '22'.repeat(32) } }, last_commit_hash: '33'.repeat(32), data_hash: '44'.repeat(32),
    validators_hash: '55'.repeat(32), next_validators_hash: '55'.repeat(32), consensus_hash: '66'.repeat(32), app_hash: '77'.repeat(32),
    last_results_hash: '88'.repeat(32), evidence_hash: '99'.repeat(32), proposer_address: VALS[0].address, ...extra };
}

/** The contract world: issue a note, bond the issuer and holder A; returns the logs of each tx and the note bundle. */
async function world() {
  const c = await createChain(['issuer', 'alice'], {}, { precompiles: PRECOMPILES });
  const cash = await c.deploy('ZetaphyOfflineCash', [], 'issuer');
  const lockUntil = Number(c.now()) + 60 * DAY;
  const tx = async (from, fn, args, value) => { const r = await c.rawTx(from, cash.address, cash.iface.encodeFunctionData(fn, args), value); assert.ok(r.ok, fn); return r.logs.map((l) => ({ ...l, address: l.address.toLowerCase() })); };
  const bondLogs = await tx('issuer', 'bondIssuer', [BigInt(lockUntil + 31 * DAY)], 15n * ZETA);
  const issueLogs = await tx('issuer', 'issue', [ISSUER.key, BigInt(lockUntil), [4n * ZETA, 6n * ZETA]], 10n * ZETA);
  const holderLogs = await tx('alice', 'bondHolder', [A.key, BigInt(lockUntil + 31 * DAY)], 4n * ZETA);
  const bundle = { v: 1, chainId: 1, contract: cash.address.toLowerCase(), note: { id: '2', issuer: c.acct.issuer.toString().toLowerCase(), value: String(6n * ZETA), lockUntil, issuerKey: ISSUER.key }, links: [] };
  return { c, cash, bondLogs, issueLogs, holderLogs, bundle, now: Number(c.now()) };
}

/** A mocked CometBFT RPC: block H holds `txLogs` (one EVM tx per entry, plus a non-EVM tx first), H+1's header commits them. */
function mockComet(txLogs, { signers = VALS, tamperHeader = null } = {}) {
  const results = [{ code: 0, data: '', gas_wanted: '0', gas_used: '0' }, // the PQ certificate tx of H-1
    ...txLogs.map((logs, i) => ({ code: 0, data: b64(core.encodeResultData(logs)), gas_wanted: '300000', gas_used: String(100000 + i) }))];
  const leaves = results.map((r) => core.resultLeaf({ code: r.code, data: core.hex(Buffer.from(r.data, 'base64')), gasWanted: r.gas_wanted, gasUsed: r.gas_used }));
  const h1 = header(H + 1, { last_results_hash: upper(pqMerkleRoot(leaves)) });
  const hash = pqHeaderHash(h1);
  const att = cat(...signers.map((v) => cat(hexToBytes(v.address), ml_dsa44.sign(pqVoteMessage(CHAIN, H + 1, hash), v.key.secretKey))));
  const served = tamperHeader ? { ...h1, ...tamperHeader } : h1;
  return async (method, params) => {
    if (method === 'block_results' && params.height === String(H)) return { height: String(H), txs_results: results };
    if (method === 'block' && params.height === String(H + 1)) return { block_id: { hash: upper(hash) }, block: { header: served, data: { txs: [] } } };
    if (method === 'block' && params.height === String(H + 2)) return { block_id: { hash: 'AB'.repeat(32) }, block: { header: header(H + 2), data: { txs: [b64(certTx(H + 1, att))] } } };
    throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
  };
}
const noteTopics = (w, id) => [core.topicOf(C, core.SIGS.noteIssued), core.hex(core.word(id))];

test('proof of funds: built from CometBFT, verified offline against the pinned validators', async () => {
  const w = await world();
  const rpc = mockComet([w.bondLogs, w.issueLogs, w.holderLogs]);
  const item = await buildResultsProof(rpc, { height: H, contract: w.bundle.contract, topics: noteTopics(w, 2) });
  assert.deepEqual([item.txIndex, item.total, item.logIndex], [2, 4, 1], 'the second NoteIssued of the issue tx');
  const r = core.verifyProofItem(C, item, { pin: PIN, contract: w.bundle.contract });
  assert.ok(r.ok, r.problems.join());
  assert.equal(r.height, H);
  const ev = core.decodeCashLog(C, r.log);
  assert.deepEqual(ev, { event: 'NoteIssued', id: '2', issuer: w.bundle.note.issuer, issuerKey: ISSUER.key, value: String(6n * ZETA), lockUntil: w.bundle.note.lockUntil });
  // the hub's own header hash (no pqcert.js) agrees
  assert.ok(core.verifyProofItem({ keccak: C.keccak, verify: C.verify }, item, { pin: PIN }).ok);
  assert.equal(core.hex(core.headerHash(item.header)), core.hex(pqHeaderHash(item.header)));

  const bad = (mut, why) => { const x = structuredClone(item); mut(x); const v = core.verifyProofItem(C, x, { pin: PIN, contract: w.bundle.contract }); assert.equal(v.ok, false, why); return v.problems.at(-1); };
  assert.match(bad((x) => { x.result.data = x.result.data.slice(0, -2) + (x.result.data.endsWith('ff') ? '00' : 'ff'); }, 'log data changed'), /last_results_hash/);
  assert.match(bad((x) => { x.result.gasUsed = '1'; }, 'result changed'), /last_results_hash/);
  assert.match(bad((x) => { x.header.app_hash = 'FF'.repeat(32); }, 'header changed'), /certificate/);
  assert.match(bad((x) => { x.txIndex = 1; }, 'another leaf'), /last_results_hash/);
  assert.match(bad((x) => { x.aunts = x.aunts.slice(1); }, 'aunt dropped'), /malformed|last_results_hash/);
  assert.match(bad((x) => { x.chainId = 'other-1'; }, 'other chain'), /chain/);
  assert.match(bad((x) => { x.logIndex = 9; }, 'no such log'), /no such log/);
  assert.equal(core.verifyProofItem(C, item, { pin: PIN, contract: '0x' + '12'.repeat(20) }).ok, false, 'another contract');
  // a pin with other keys: nothing verifies (the node is trusted for nothing)
  const other = structuredClone(PIN);
  for (const v of Object.values(other.validators)) v.pubKey = bytesToHex(ml_dsa44.keygen(new Uint8Array(32).fill(99)).publicKey);
  assert.match(core.verifyProofItem(C, item, { pin: other }).problems.at(-1), /power/);
});

test('proof of funds: 2 of 4 validators (50%) is not enough; 3 of 4 is', async () => {
  const w = await world();
  const two = await buildResultsProof(mockComet([w.issueLogs], { signers: VALS.slice(0, 2) }), { height: H, contract: w.bundle.contract, topics: noteTopics(w, 2) });
  const v2 = core.verifyProofItem(C, two, { pin: PIN });
  assert.equal(v2.ok, false);
  assert.match(v2.problems.at(-1), /50 of 100 power/);
  const three = await buildResultsProof(mockComet([w.issueLogs], { signers: VALS.slice(1) }), { height: H, contract: w.bundle.contract, topics: noteTopics(w, 2) });
  assert.ok(core.verifyProofItem(C, three, { pin: PIN }).ok);
  // a signer listed twice counts once
  const dup = structuredClone(three);
  dup.attestations = dup.attestations + dup.attestations.slice(2, 2 + 2 * core.ATTESTATION_BYTES);
  assert.ok(core.verifyProofItem(C, dup, { pin: PIN }).problems.some((p) => /counted already/.test(p)));
  await assert.rejects(buildResultsProof(mockComet([w.bondLogs]), { height: H, contract: w.bundle.contract, topics: noteTopics(w, 2) }), /no such log/);
});

test('proof of funds: the attestation fallback (validators sign the log itself, k-of-n ML-DSA-44)', async () => {
  const w = await world();
  const log = w.issueLogs[1];
  const signer = (v) => ({ address: v.address, sign: (m) => ml_dsa44.sign(m, v.key.secretKey) });
  const item = attestLog(C, { chainId: CHAIN, height: H, time: w.now, log }, VALS.slice(0, 3).map(signer));
  const r = core.verifyProofItem(C, item, { pin: PIN, contract: w.bundle.contract });
  assert.ok(r.ok, r.problems.join());
  assert.equal(core.decodeCashLog(C, r.log).id, '2');
  assert.equal(core.verifyProofItem(C, { ...item, height: H + 1 }, { pin: PIN }).ok, false, 'height is signed');
  assert.equal(core.verifyProofItem(C, { ...item, time: w.now + 1 }, { pin: PIN }).ok, false, 'time is signed');
  assert.equal(core.verifyProofItem(C, { ...item, log: { ...log, data: log.data.slice(0, -2) + (log.data.endsWith('ff') ? '00' : 'ff') } }, { pin: PIN }).ok, false, 'log is signed');
  const two = attestLog(C, { chainId: CHAIN, height: H, time: w.now, log }, VALS.slice(0, 2).map(signer));
  assert.equal(core.verifyProofItem(C, two, { pin: PIN }).ok, false);
});

test('proof of funds: what the bonds cover, stale proofs, and the payee\'s receive check', async () => {
  const w = await world();
  const rpc = mockComet([w.bondLogs, w.issueLogs, w.holderLogs]);
  const items = [
    await buildResultsProof(rpc, { height: H, contract: w.bundle.contract, topics: noteTopics(w, 2) }),
    await buildResultsProof(rpc, { height: H, contract: w.bundle.contract, topics: [core.topicOf(C, core.SIGS.issuerBonded)], last: true }), // as of the issue
    await buildResultsProof(rpc, { height: H, contract: w.bundle.contract, topics: [core.topicOf(C, core.SIGS.holderBonded), A.key] }),
  ];
  const now = Date.parse('2026-10-31T09:00:00Z') / 1000;
  // straight from the issuer to A: covered by the issuer bond (15 = 150% of the 10 outstanding)
  const toA = { ...core.passOn(C, w.bundle, ISSUER, A.key), proofs: items };
  const f1 = core.proofOfFunds(C, toA, { pin: PIN, now });
  assert.equal(f1.note, 'proven');
  assert.equal(f1.covered, 6n * ZETA, 'the issuer bond covers the note');
  assert.deepEqual([f1.facts.issuerBond.amount, f1.facts.issuerBond.outstanding], [String(15n * ZETA), String(10n * ZETA)]);
  assert.equal(f1.stale, false);
  // A passes it to B: A's holder bond is 4: only 4 of 6 covered
  const toB = { ...core.passOn(C, toA, A, B.key), proofs: items };
  const f2 = core.proofOfFunds(C, toB, { pin: PIN, now });
  assert.equal(f2.covered, 4n * ZETA);
  assert.deepEqual(f2.perHolder.map((h) => [h.seq, String(h.counts)]), [[0, String(15n * ZETA)], [1, String(4n * ZETA)]]);
  const rc = core.receiveCheck(C, toB, { me: B.key, now, pin: PIN, evmChainId: 1, contract: w.bundle.contract });
  assert.ok(rc.ok, rc.problems.join());
  assert.deepEqual(rc.warnings, ['notCovered']);
  // without A's bond proof: nothing covered past A
  const f3 = core.proofOfFunds(C, { ...toB, proofs: items.slice(0, 2) }, { pin: PIN, now });
  assert.equal(f3.covered, 0n);
  // a week and a day later the bond facts are stale
  assert.equal(core.proofOfFunds(C, toA, { pin: PIN, now: now + 8 * DAY }).stale, true);
  // the wrong payee, a passed lockUntil, no proofs at all, a bad signature
  assert.deepEqual(core.receiveCheck(C, toB, { me: A.key, now, pin: PIN, evmChainId: 1 }).problems, ['notToYou']);
  assert.ok(core.receiveCheck(C, toB, { me: B.key, now: w.bundle.note.lockUntil + 1, evmChainId: 1 }).problems.includes('lockPassed'));
  assert.deepEqual(core.receiveCheck(C, { ...toB, proofs: [] }, { me: B.key, now, evmChainId: 1 }).warnings, ['noProof']);
  assert.ok(core.receiveCheck(C, toB, { me: B.key, now: w.bundle.note.lockUntil - DAY, evmChainId: 1 }).warnings.includes('lockSoon'));
  const sig = core.bytes(toB.links[1].sig); sig[9] ^= 1;
  assert.ok(core.receiveCheck(C, { ...toB, links: [toB.links[0], { ...toB.links[1], sig: core.hex(sig) }] }, { me: B.key, now, evmChainId: 1 }).problems.includes('badChain'));
  // a note whose terms differ from the proven issuance
  const fake = { ...toA, note: { ...toA.note, value: String(60n * ZETA) } };
  assert.equal(core.proofOfFunds(C, fake, { pin: PIN, now }).note, 'mismatch');
});

test('formats: ZNOTE1 text, binary bundle, swap and proof round trips; split detection; SHA-256 and merkle ports', async () => {
  const w = await world();
  const toA = core.passOn(C, w.bundle, ISSUER, A.key);
  const item = await buildResultsProof(mockComet([w.issueLogs]), { height: H, contract: w.bundle.contract, topics: noteTopics(w, 2) });
  const withProof = { ...core.cleanBundle(toA), proofs: [item] };
  const back = core.noteFromText(core.noteToText(withProof));
  assert.deepEqual(back, JSON.parse(JSON.stringify(withProof)));
  assert.ok(core.verifyProofItem(C, back.proofs[0], { pin: PIN }).ok);
  const term = core.signTerminal(C, toA, A, '0x' + 'ab'.repeat(20), 5n);
  assert.deepEqual(core.decodeBundle(core.encodeBundle(term)), core.cleanBundle(term));
  assert.throws(() => core.decodeBundle(core.encodeBundle(term).subarray(0, 500)), /truncated/);
  assert.throws(() => core.noteFromText('ZCHQ1:abc'), /not a ZETAPHY note/);
  // a swap round trip
  const [, n1] = [0, { ...w.bundle, note: { ...w.bundle.note, id: '1', value: String(4n * ZETA) } }];
  let s = core.newSwap(C, core.passOn(C, n1, ISSUER, B.key), toA, { toA: A.key, toB: B.key, payoutA: '0x' + '0a'.repeat(20), payoutB: '0x' + '0b'.repeat(20), deadline: w.now + DAY });
  s = core.signLeg(C, core.signLeg(C, s, 'A', B), 'B', A);
  assert.deepEqual(core.decodeSwap(core.encodeSwap(s)), JSON.parse(JSON.stringify(s)));
  assert.ok(core.verifySwap(C, core.decodeSwap(core.encodeSwap(s)), { now: w.now }).ok);
  // split detection: the payee holding toA learns of another chain from the same issuer position
  const toB = core.passOn(C, w.bundle, ISSUER, B.key);
  assert.deepEqual(core.findSplit(C, toA, toB), { seq: 0, cheater: ISSUER.key, issuer: true, a: core.walk(C, toA).msgs[0], b: core.walk(C, toB).msgs[0], valid: true });
  assert.equal(core.findSplit(C, toA, core.passOn(C, toA, A, B.key)), null, 'an extension is not a split');
  // the dependency-free SHA-256 and merkle helpers
  for (const len of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const m = new Uint8Array(len).map((_, i) => (i * 7) & 255);
    assert.equal(core.hex(sha256(m)), '0x' + createHash('sha256').update(m).digest('hex'), `sha256 of ${len} bytes`);
  }
  const leaves = Array.from({ length: 7 }, (_, i) => new Uint8Array([i, i + 1]));
  assert.equal(core.hex(core.merkleRoot(leaves)), core.hex(pqMerkleRoot(leaves)));
  for (let i = 0; i < 7; i++) assert.equal(core.hex(core.rootFromAunts(leaves[i], i, 7, core.merkleAunts(leaves, i))), core.hex(pqMerkleRoot(leaves)));
});
