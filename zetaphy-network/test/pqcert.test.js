// Post-quantum block verifier (src/pqcert.js) against a mocked CometBFT RPC:
// the same rule as the chain's pqCheckCert (zetaphy-chain evmd/zetaphy_pqcert.go),
// plus a replay of a real devnet block whose certificate Go built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { TxRaw, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { encodeTxBody, encodeTxRaw, varint, bytesToHex, hexToBytes } from '../src/pqtx.js';
import {
  verifyBlock, exportVoteKeys, voteMessage, decodeCertificate, decodeVoteKeyEntry, voteKeyAt, headerHash, txsHash, merkleRoot,
  parsePinnedKeys, cometClient, CERT_TYPE_URL, ATTESTATION_BYTES,
} from '../src/pqcert.js';

const CHAIN = 'zetaphy-test-1';
const H = 100;
const utf8 = (s) => new TextEncoder().encode(s);
const b64 = (b) => Buffer.from(b).toString('base64');
const upper = (b) => bytesToHex(b).toUpperCase();
const cat = (...p) => Uint8Array.from(Buffer.concat(p.map((x) => Buffer.from(x))));
const lenDelim = (field, b) => cat(varint((field << 3) | 2), varint(b.length), b);

// Four validators with deterministic ML-DSA-44 vote keys (and a spare key each for rotations).
const VALS = ['A', 'B', 'C', 'D'].map((name, i) => ({
  name,
  address: upper(new Uint8Array(20).fill(0x10 + i)),
  key: ml_dsa44.keygen(new Uint8Array(32).fill(i + 1)),
  spare: ml_dsa44.keygen(new Uint8Array(32).fill(i + 101)),
}));
const [A, B, C, D] = VALS;

/** A zetaphypq vote key entry: since || pubkey || previous pubkey. */
function entry(since, pub, prev) {
  const s = new Uint8Array(8);
  new DataView(s.buffer).setBigUint64(0, BigInt(since));
  return cat(s, pub, ...(prev ? [prev] : []));
}

function header(height, txs, chainId = CHAIN) {
  return {
    version: { block: '11' }, chain_id: chainId, height: String(height), time: '2026-10-20T09:00:00.12345Z',
    last_block_id: { hash: '11'.repeat(32), parts: { total: 1, hash: '22'.repeat(32) } },
    last_commit_hash: '33'.repeat(32), data_hash: upper(txsHash(txs)), validators_hash: '44'.repeat(32), next_validators_hash: '44'.repeat(32),
    consensus_hash: '55'.repeat(32), app_hash: '66'.repeat(32), last_results_hash: '77'.repeat(32), evidence_hash: '88'.repeat(32), proposer_address: A.address,
  };
}
const blockResult = (h) => ({ block_id: { hash: upper(headerHash(h)), parts: { total: 1, hash: '99'.repeat(32) } }, block: { header: h, data: { txs: [] } } });

/** MsgPQCertificate in a TxRaw, as the chain's proposer builds it. */
function certTx(height, attestations, { typeUrl = CERT_TYPE_URL, extra = [] } = {}) {
  const value = cat(lenDelim(1, utf8('zetaphy1certsigner')), varint(2 << 3), varint(height), lenDelim(3, attestations));
  const bodyBytes = encodeTxBody({ messages: [{ typeUrl, value }, ...extra] });
  return encodeTxRaw({ bodyBytes, authInfoBytes: new Uint8Array(), signatures: [] });
}

/**
 * One attestation. Defaults: the validator signs (CHAIN, H, hash of H) with its key.
 * Overrides: key (another key pair), hash, height, chainId, flip (corrupt one bit).
 */
const attest = (ctx, v, o = {}) => {
  const sig = ml_dsa44.sign(voteMessage(o.chainId ?? CHAIN, o.height ?? H, o.hash ?? ctx.hash), (o.key ?? v.key).secretKey);
  if (o.flip) sig[100] ^= 1;
  return cat(hexToBytes(v.address), sig);
};

/**
 * A mocked CometBFT RPC holding blocks H and H+1. vals: [[validator, power]];
 * entries: { address: entry bytes } at state H; cert(ctx) -> attestations or a
 * full tx list for H+1 ({ txs }). Validators come 2 per page to exercise paging.
 */
function mockChain({ vals = [[A, 30], [B, 30], [C, 20], [D, 20]], entries, cert, next = true, chainId = CHAIN }) {
  entries ??= Object.fromEntries(vals.map(([v]) => [v.address, entry(H - 10, v.key.publicKey)]));
  const hb = blockResult(header(H, [], chainId));
  const ctx = { hash: hexToBytes(hb.block_id.hash) };
  const out = cert ? cert(ctx) : cat(...vals.map(([v]) => attest(ctx, v)));
  const txs = out instanceof Uint8Array ? [certTx(H, out)] : out.txs;
  const nb = blockResult(header(H + 1, txs, chainId));
  nb.block.data.txs = txs.map(b64);
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(`${method}@${params?.height ?? ''}`);
    const latest = next ? H + 1 : H;
    if (method === 'status') return { node_info: { network: chainId }, sync_info: { latest_block_height: String(latest) } };
    if (method === 'block') {
      const h = Number(params.height);
      if (h > latest) throw new Error(`block: height ${h} must be less than or equal to the current blockchain height ${latest}`);
      if (h === H) return hb;
      if (h === H + 1) return nb;
      throw new Error(`no block ${h} in the mock`);
    }
    if (method === 'validators') { // the same set at H and H+1
      assert.ok([String(H), String(H + 1)].includes(params.height));
      const page = Number(params.page);
      const all = vals.map(([v, p]) => ({ address: v.address, voting_power: String(p), pub_key: {}, proposer_priority: '0' }));
      return { block_height: String(H), validators: all.slice((page - 1) * 2, page * 2), count: '2', total: String(all.length) };
    }
    if (method === 'abci_query') {
      assert.equal(params.path, '/store/zetaphypq/key');
      assert.ok([String(H), String(H + 1)].includes(params.height));
      assert.match(params.data, /^02[0-9A-F]{40}$/);
      const e = entries[params.data.slice(2)];
      return { response: { code: 0, value: e ? b64(e) : null, height: params.height } };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls, hash: hb.block_id.hash, ctx };
}

test('vote message: prefix, chain id, uint64 BE height, hash', () => {
  const hash = new Uint8Array(32).fill(7);
  const m = voteMessage('zetaphy_77390-1', 258, hash);
  assert.deepEqual([...m], [...cat(utf8('zetaphy/pq-vote\0zetaphy_77390-1\0'), [0, 0, 0, 0, 0, 0, 1, 2], hash)]);
});

test('a valid certificate passes', async () => {
  const c = mockChain({});
  const r = await verifyBlock(c.rpc, H);
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.pqMajority, true);
  assert.equal(r.height, H);
  assert.equal(r.hash, c.hash);
  assert.equal(r.chainId, CHAIN);
  assert.equal(r.totalPower, 100n);
  assert.equal(r.unregisteredPower, 0n);
  assert.equal(r.signedPower, 100n);
  assert.equal(r.required, 67n);
  assert.deepEqual(r.signers.map((s) => s.address), VALS.map((v) => v.address));
  assert.deepEqual(r.problems, []);
  assert.equal(r.keysFrom, 'node');
  assert.equal(r.certificate, true);
  assert.deepEqual(c.calls.filter((m) => m.startsWith('validators')), [`validators@${H}`, `validators@${H}`], 'paged through the validator set at H');
  assert.deepEqual(c.calls.filter((m) => m.startsWith('abci_query')), VALS.map(() => `abci_query@${H}`), 'vote keys read at state H');
});

test('a duplicate signer counts once; a bad first copy does not stop a good second one', async () => {
  // A and B hold 50 each: A alone (even listed twice) is not more than 2/3.
  const vals = [[A, 50], [B, 50]];
  const twice = await verifyBlock(mockChain({ vals, cert: (ctx) => cat(attest(ctx, A), attest(ctx, A)) }).rpc, H);
  assert.equal(twice.signedPower, 50n);
  assert.equal(twice.ok, false);
  assert.deepEqual(twice.signers.map((s) => s.address), [A.address]);
  assert.ok(twice.problems.some((p) => /more than once: counted once/.test(p)));

  const all = await verifyBlock(mockChain({ vals, cert: (ctx) => cat(attest(ctx, A), attest(ctx, A), attest(ctx, B), attest(ctx, B)) }).rpc, H);
  assert.equal(all.signedPower, 100n);
  assert.equal(all.ok, true);
  assert.equal(all.signers.length, 2);

  const retry = await verifyBlock(mockChain({ vals, cert: (ctx) => cat(attest(ctx, A, { flip: true }), attest(ctx, A), attest(ctx, B)) }).rpc, H);
  assert.equal(retry.signedPower, 100n, 'as in Go: only a valid signature marks the validator as counted');
  assert.equal(retry.ok, true);
});

test('a signature over the wrong hash, height or chain, or a corrupted one, does not count', async () => {
  const cases = {
    hash: { hash: new Uint8Array(32).fill(1) },
    height: { height: H - 1 },
    chain: { chainId: 'other-1' },
    corrupted: { flip: true },
    'wrong key': { key: A.spare },
  };
  for (const [name, o] of Object.entries(cases)) {
    // A's bad signature, B C D good: 70 of 100 still passes; A is not counted.
    const r = await verifyBlock(mockChain({ cert: (ctx) => cat(attest(ctx, A, o), attest(ctx, B), attest(ctx, C), attest(ctx, D)) }).rpc, H);
    assert.equal(r.signedPower, 70n, name);
    assert.equal(r.ok, true, name);
    assert.ok(!r.signers.some((s) => s.address === A.address), name);
    assert.ok(r.problems.some((p) => p.startsWith(`${A.address}: the ML-DSA-44 signature does not verify`)), name);
    assert.equal(r.validators.find((v) => v.address === A.address).signed, false);
  }
  // Without C and D, A's bad signature leaves 30 + 30 short of 67.
  const short = await verifyBlock(mockChain({ cert: (ctx) => cat(attest(ctx, A, { flip: true }), attest(ctx, B)) }).rpc, H);
  assert.equal(short.signedPower, 30n);
  assert.equal(short.ok, false);
  assert.ok(short.problems.some((p) => /not enough: needs at least 67/.test(p)));

  // A certificate whose height field is not H is ignored as a whole.
  const wrongHeight = await verifyBlock(mockChain({ cert: (ctx) => ({ txs: [certTx(H - 1, cat(...VALS.map((v) => attest(ctx, v))))] }) }).rpc, H);
  assert.equal(wrongHeight.signedPower, 0n);
  assert.equal(wrongHeight.ok, false);
  assert.ok(wrongHeight.problems.some((p) => /is for height 99, not 100/.test(p)));

  // Attestations that are not whole entries: ignored as a whole (as in Go).
  const ragged = await verifyBlock(mockChain({ cert: (ctx) => cat(...VALS.map((v) => attest(ctx, v)), [0]) }).rpc, H);
  assert.equal(ragged.signedPower, 0n);
  assert.ok(ragged.problems.some((p) => new RegExp(`not a multiple of ${ATTESTATION_BYTES}`).test(p)));

  // Unknown addresses are ignored.
  const stranger = { ...A, address: 'FF'.repeat(20) };
  const unknown = await verifyBlock(mockChain({ cert: (ctx) => cat(attest(ctx, stranger), ...VALS.map((v) => attest(ctx, v))) }).rpc, H);
  assert.equal(unknown.signedPower, 100n);
  assert.ok(unknown.problems.some((p) => p.includes(`${stranger.address} signed but is not a validator`)));
});

test('the node cannot swap the block data: header and txs must hash to the signed hash', async () => {
  const c = mockChain({});
  const lying = async (method, params) => {
    const r = await c.rpc(method, params);
    if (method === 'block' && params.height === String(H)) return { ...r, block: { ...r.block, header: { ...r.block.header, app_hash: 'AB'.repeat(32) } } };
    return r;
  };
  const r = await verifyBlock(lying, H);
  assert.equal(r.signedPower, 100n, 'the signatures are over the hash, which is right');
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /header for block 100 does not hash to/.test(p)));

  const extraTx = async (method, params) => {
    const res = await c.rpc(method, params);
    if (method === 'block' && params.height === String(H)) return { ...res, block: { ...res.block, data: { txs: [b64(utf8('smuggled'))] } } };
    return res;
  };
  const t = await verifyBlock(extraTx, H);
  assert.equal(t.ok, false);
  assert.ok(t.problems.some((p) => /txs for block 100 do not match/.test(p)));
});

test('threshold: 3 * signed > 2 * total - 3 * unregistered, in integers', async () => {
  // C and D (40) have no key: T = 100, U = 40, need = 80: signed must be > 26.67.
  const entries = { [A.address]: entry(1, A.key.publicKey), [B.address]: entry(1, B.key.publicKey) };
  const onlyA = await verifyBlock(mockChain({ entries, cert: (ctx) => attest(ctx, A) }).rpc, H);
  assert.equal(onlyA.unregisteredPower, 40n);
  assert.equal(onlyA.required, 27n);
  assert.equal(onlyA.signedPower, 30n);
  assert.equal(onlyA.ok, true);
  assert.equal(onlyA.pqMajority, false, 'signed 30 of 100 is not a post-quantum 2/3 majority');
  assert.deepEqual(onlyA.validators.map((v) => v.hasKey), [true, true, false, false]);

  // Exactly 2/3 is not enough: A 60 and B 30 (both with keys), A alone: 3 * 60 = 180 = 2 * 90.
  const vals = [[A, 60], [B, 30]];
  const exact = await verifyBlock(mockChain({ vals, cert: (ctx) => attest(ctx, A) }).rpc, H);
  assert.equal(exact.required, 61n);
  assert.equal(exact.ok, false);
  // One more unit of power without a key tips it: T = 91, U = 1, need = 179 < 180.
  const tipped = await verifyBlock(mockChain({ vals: [[A, 60], [B, 30], [C, 1]], entries: { [A.address]: entry(1, A.key.publicKey), [B.address]: entry(1, B.key.publicKey) }, cert: (ctx) => attest(ctx, A) }).rpc, H);
  assert.equal(tipped.required, 60n);
  assert.equal(tipped.ok, true);

  // Keys on less than 1/3 of the power: nothing is required, even without a certificate.
  const few = { [A.address]: entry(1, A.key.publicKey) };
  const none = await verifyBlock(mockChain({ vals: [[A, 30], [B, 40], [C, 40]], entries: few, cert: () => ({ txs: [] }) }).rpc, H);
  assert.equal(none.required, 0n);
  assert.equal(none.unregisteredPower, 80n);
  assert.equal(none.ok, true);
  assert.equal(none.certificate, false);
  assert.deepEqual(none.problems, []);
  // need = 0 (keys on exactly 1/3): one signature is required.
  const third = await verifyBlock(mockChain({ vals: [[A, 30], [B, 30], [C, 30]], entries: few, cert: () => ({ txs: [] }) }).rpc, H);
  assert.equal(third.required, 1n);
  assert.equal(third.ok, false);
});

test('since / previous key: a key registered in block H covers votes from H+1 on', () => {
  const now = A.key.publicKey, prev = A.spare.publicKey;
  const e = (since, p) => decodeVoteKeyEntry(entry(since, now, p));
  assert.deepEqual(voteKeyAt(e(H - 1), H), now, 'since < H: the key');
  assert.equal(voteKeyAt(e(H), H), null, 'since = H, no previous key: no key');
  assert.equal(voteKeyAt(e(H + 5), H), null);
  assert.deepEqual(voteKeyAt(e(H, prev), H), prev, 'since = H: the previous key');
  assert.deepEqual(voteKeyAt(e(H - 1, prev), H), now);
  assert.equal(decodeVoteKeyEntry(new Uint8Array(100)), null, 'too short: no key');
  assert.equal(decodeVoteKeyEntry(entry(1, now).subarray(0, 1319)), null);
  // An entry of an odd length past one key is read as one key without a previous one (as in Go).
  assert.equal(decodeVoteKeyEntry(cat(entry(1, now), [1, 2, 3])).previousPubKey, null);
  assert.equal(voteKeyAt({ pubKey: now }, H), now, 'a pinned key without since is valid at every height');
});

test('since / previous key on the rule: rotation in block H, registration in block H', async () => {
  // A rotated its key in block H: votes on H are still signed with the previous key.
  const rotated = { [A.address]: entry(H, A.spare.publicKey, A.key.publicKey), [B.address]: entry(5, B.key.publicKey) };
  const vals = [[A, 60], [B, 40]];
  const r = await verifyBlock(mockChain({ vals, entries: rotated }).rpc, H);
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.signedPower, 100n);
  // Signed with the new key: too early, it does not count.
  const early = await verifyBlock(mockChain({ vals, entries: rotated, cert: (ctx) => cat(attest(ctx, A, { key: A.spare }), attest(ctx, B)) }).rpc, H);
  assert.equal(early.signedPower, 40n);
  assert.equal(early.ok, false);

  // A registered its first key in block H: A counts as without a key for votes on H.
  const fresh = { [A.address]: entry(H, A.key.publicKey), [B.address]: entry(5, B.key.publicKey) };
  const f = await verifyBlock(mockChain({ vals, entries: fresh, cert: (ctx) => attest(ctx, B) }).rpc, H);
  assert.equal(f.unregisteredPower, 60n);
  assert.equal(f.required, 7n, '2 * 100 - 3 * 60 = 20: more than 20 / 3 is needed');
  assert.equal(f.ok, true);
  const f2 = await verifyBlock(mockChain({ vals, entries: fresh, cert: (ctx) => cat(attest(ctx, A), attest(ctx, B)) }).rpc, H);
  assert.ok(f2.problems.some((p) => p.includes(`${A.address} signed but has no vote key valid at ${H}`)));
  assert.equal(f2.signedPower, 40n);
});

test('a missing certificate fails', async () => {
  const empty = await verifyBlock(mockChain({ cert: () => ({ txs: [] }) }).rpc, H);
  assert.equal(empty.ok, false);
  assert.equal(empty.certificate, false);
  assert.ok(empty.problems.some((p) => /block 101 does not start with a vote certificate/.test(p)));

  // Some other tx first (the certificate must be txs[0]).
  const other = encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: new Uint8Array([10, 1, 65]) }] }), authInfoBytes: new Uint8Array(), signatures: [] });
  const notFirst = await verifyBlock(mockChain({ cert: (ctx) => ({ txs: [other, certTx(H, cat(...VALS.map((v) => attest(ctx, v))))] }) }).rpc, H);
  assert.equal(notFirst.ok, false);
  assert.equal(notFirst.signedPower, 0n);

  // A certificate with a second message is not a certificate (pqCertOf: exactly one message).
  const two = await verifyBlock(mockChain({ cert: (ctx) => ({ txs: [certTx(H, cat(...VALS.map((v) => attest(ctx, v))), { extra: [{ typeUrl: CERT_TYPE_URL, value: new Uint8Array() }] })] }) }).rpc, H);
  assert.equal(two.ok, false);
  // Garbage first tx.
  const junk = await verifyBlock(mockChain({ cert: () => ({ txs: [Uint8Array.of(0x0a, 0xff)] }) }).rpc, H);
  assert.equal(junk.ok, false);
  assert.ok(junk.problems.some((p) => /not valid protobuf/.test(p)));

  // Block H+1 not committed yet.
  const pending = await verifyBlock(mockChain({ next: false }).rpc, H);
  assert.equal(pending.ok, false);
  assert.ok(pending.problems.some((p) => /block 101 is not committed yet/.test(p)));
  await assert.rejects(verifyBlock(mockChain({ next: false }).rpc, H + 5), /block 105 is not committed yet/);
  await assert.rejects(verifyBlock(mockChain({}).rpc, 0), /height must be a block number/);
});

test('pinned keys: the node is not asked for keys, and its keys are not trusted', async () => {
  const c = mockChain({});
  const pin = await exportVoteKeys(c.rpc, { height: H });
  assert.equal(pin.chainId, CHAIN);
  assert.equal(pin.height, String(H));
  assert.deepEqual(Object.keys(pin.validators), VALS.map((v) => v.address));
  assert.deepEqual(pin.validators[A.address], { power: '30', since: String(H - 10), pubKey: bytesToHex(A.key.publicKey), previousPubKey: null });
  assert.equal((await exportVoteKeys(c.rpc)).height, String(H + 1), 'default: the latest block');

  const c2 = mockChain({});
  const r = await verifyBlock(c2.rpc, H, { pinnedKeys: JSON.parse(JSON.stringify(pin)) });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.keysFrom, 'pinned');
  assert.equal(r.signedPower, 100n);
  assert.ok(!c2.calls.some((m) => m.startsWith('abci_query')), 'no vote key comes from the node');

  // The node registers a key of its own choosing for A and signs with it: the pin wins.
  const evil = mockChain({ entries: { ...Object.fromEntries(VALS.map((v) => [v.address, entry(1, v.key.publicKey)])), [A.address]: entry(1, A.spare.publicKey) },
    cert: (ctx) => cat(attest(ctx, A, { key: A.spare }), attest(ctx, B), attest(ctx, C)) });
  assert.equal((await verifyBlock(evil.rpc, H)).ok, true, 'trusting the node, its own key for A counts');
  const pinned = await verifyBlock(evil.rpc, H, { pinnedKeys: pin });
  assert.equal(pinned.ok, false, 'with the pin it does not');
  assert.equal(pinned.signedPower, 50n, 'B and C only');

  // The node invents a validator with most of the power: ignored with a pin, noted.
  const big = { ...D, address: 'EE'.repeat(20) };
  const inflated = mockChain({ vals: [[A, 30], [B, 30], [C, 20], [D, 20], [big, 1000]], entries: { [big.address]: entry(1, big.key.publicKey) }, cert: (ctx) => attest(ctx, big) });
  const p2 = await verifyBlock(inflated.rpc, H, { pinnedKeys: pin });
  assert.equal(p2.ok, false);
  assert.equal(p2.totalPower, 100n);
  assert.ok(p2.problems.some((p) => /differs from the pinned one/.test(p)));

  // A pin of plain keys: { address: { power, pubKey } }.
  const plain = Object.fromEntries(VALS.map((v) => [v.address, { power: 25, pubKey: bytesToHex(v.key.publicKey) }]));
  assert.equal((await verifyBlock(mockChain({}).rpc, H, { pinnedKeys: plain })).ok, true);
  // The pin's chain id is the one signed over.
  const otherChain = await verifyBlock(mockChain({}).rpc, H, { pinnedKeys: { ...pin, chainId: 'other-1' } });
  assert.equal(otherChain.ok, false);
  assert.ok(otherChain.problems.some((p) => /on chain zetaphy-test-1, not other-1/.test(p)));

  assert.throws(() => parsePinnedKeys({ validators: { xyz: { power: 1 } } }), /consensus address/);
  assert.throws(() => parsePinnedKeys({ validators: { [A.address]: { power: 0 } } }), /positive power/);
  assert.throws(() => parsePinnedKeys({ validators: { [A.address]: { power: 1, pubKey: 'abcd' } } }), /1312 bytes/);
  assert.throws(() => parsePinnedKeys({ validators: {} }), /no validators/);
});

test('a real devnet block: Go-built certificate, CometBFT header hash', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/pqcert-devnet.json', import.meta.url), 'utf8'));
  const rpc = async (method, params) => {
    if (method === 'block') return fx.block[params.height] ?? Promise.reject(new Error(`block: height ${params.height} must be less than or equal to the current blockchain height 14`));
    if (method === 'validators') return fx.validators[params.height];
    if (method === 'abci_query') return fx.abci_query[params.data.slice(2)];
    throw new Error(method);
  };
  for (const h of ['13', '14']) assert.equal(upper(headerHash(fx.block[h].block.header)), fx.block[h].block_id.hash);
  const txs = fx.block['14'].block.data.txs.map((t) => Buffer.from(t, 'base64'));
  assert.equal(upper(txsHash(txs)), fx.block['14'].block.header.data_hash);

  // Our protobuf reader agrees with the official Cosmos SDK types.
  const raw = TxRaw.decode(txs[0]);
  const body = TxBody.decode(raw.bodyBytes);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].typeUrl, CERT_TYPE_URL);
  const cert = decodeCertificate(txs[0]);
  assert.equal(cert.height, 13n);
  assert.equal(cert.attestations.length, 2 * ATTESTATION_BYTES);
  assert.match(cert.signer, /^zetaphy1/);

  const r = await verifyBlock(rpc, 13);
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.pqMajority, true);
  assert.equal(r.chainId, 'zetaphy-pqcert-1');
  assert.equal(r.signedPower, 10_000_000n);
  assert.equal(r.signers.length, 2);
  assert.equal((await verifyBlock(rpc, 13, { chainId: 'zetaphy_77390-1' })).ok, false);
});

test('merkle root matches CometBFT for 0, 1 and uneven counts', () => {
  assert.equal(upper(merkleRoot([])), 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855');
  // RFC 6962: leaf = sha256(0 || x), inner = sha256(1 || l || r), split at the largest power of 2 below n.
  const sha = (...p) => createHash('sha256').update(cat(...p)).digest();
  const leaf = (x) => sha([0], x), inner = (l, r) => sha([1], l, r);
  const [a, b, c] = ['a', 'b', 'c'].map(utf8);
  assert.deepEqual(Buffer.from(merkleRoot([a])), leaf(a));
  assert.deepEqual(Buffer.from(merkleRoot([a, b, c])), inner(inner(leaf(a), leaf(b)), leaf(c)));
});

test('CometBFT RPC over HTTP: JSON-RPC POST, node errors passed on', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { method, params, id } = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (method === 'status') res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { echo: params } }));
      else res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: 'height 9 must be less than or equal to the current blockchain height 5' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const rpc = cometClient(`http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(await rpc('status', { a: '1' }), { echo: { a: '1' } });
    await assert.rejects(rpc('block', { height: '9' }), /block: height 9 must be less than or equal/);
    await assert.rejects(verifyBlock(`http://127.0.0.1:${server.address().port}`, 9), /block 9 is not committed yet/);
  } finally { server.close(); }
});

test('CLI: pq verify-block prints the result and exits 1 when not verified; export-vote-keys pins', async () => {
  // Serve the mock chain over HTTP for the CLI.
  const serve = async (c) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        const { method, params, id } = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        try { res.end(JSON.stringify({ jsonrpc: '2.0', id, result: await c.rpc(method, params) })); } catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: e.message.replace(/^block: /, '') } })); }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  };
  // cli.js reads ZETAPHY_HOME when first imported; these commands write nothing there.
  const tmp = mkdtempSync(join(tmpdir(), 'zetaphy-pqcert-'));
  process.env.ZETAPHY_HOME = tmp;
  const { main } = await import('../cli.js');
  const run = async (args) => { const out = []; const code = await main(args, {}, (l) => out.push(l)); return { code, out: out.join('\n') }; };
  const good = await serve(mockChain({}));
  const bad = await serve(mockChain({ cert: (ctx) => attest(ctx, A) }));
  try {
    const ok = await run(['pq', 'verify-block', String(H), '--rpc', good.url]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /block 100: VERIFIED post-quantum/);
    assert.match(ok.out, new RegExp(`✓ ${A.address} power 30: signed`));
    assert.match(ok.out, /trusted for validator powers and keys/);

    const no = await run(['pq', 'verify-block', String(H), '--rpc', bad.url]);
    assert.equal(no.code, 1);
    assert.match(no.out, /block 100: NOT VERIFIED/);
    assert.match(no.out, new RegExp(`✗ ${B.address} power 30: no valid signature`));

    const pending = await run(['pq', 'verify-block', String(H + 1), '--rpc', good.url]);
    assert.equal(pending.code, 1);
    assert.match(pending.out, /block 102 is not committed yet/);

    const json = await run(['pq', 'verify-block', String(H), '--rpc', good.url, '--json']);
    assert.equal(JSON.parse(json.out).signedPower, '100');

    const exp = await run(['pq', 'export-vote-keys', '--rpc', good.url, '--height', String(H)]);
    assert.equal(exp.code, 0);
    const file = join(tmp, 'pinned.json');
    writeFileSync(file, exp.out);
    const pinned = await run(['pq', 'verify-block', String(H), '--rpc', good.url, '--keys', file]);
    assert.equal(pinned.code, 0, pinned.out);
    assert.match(pinned.out, /pinned in .*pinned\.json \(the node is not trusted\)/);

    await assert.rejects(run(['pq', 'verify-block', 'latest', '--rpc', good.url]), /usage: zetaphy pq verify-block/);
  } finally { good.server.close(); bad.server.close(); rmSync(tmp, { recursive: true, force: true }); }
});
