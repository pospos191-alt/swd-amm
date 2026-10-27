// ZETAPHY post-quantum finality certificate verifier (zetaphy-network/src/pqcert.js):
// one valid ML-DSA-44 certificate for block H on a mocked CometBFT RPC, then
// single-bit mutations of everything the certificate and the block hash cover.

import { ml_dsa44 } from '../../zetaphy-network/node_modules/@noble/post-quantum/ml-dsa.js';
import { encodeTxBody, encodeTxRaw, varint, bytesToHex, hexToBytes } from '../../zetaphy-network/src/pqtx.js';
import { verifyBlock, voteMessage, headerHash, txsHash, CERT_TYPE_URL } from '../../zetaphy-network/src/pqcert.js';
import { ok, eq } from '../lib/harness.mjs';

const CHAIN = 'zetaphy-tests10k-1';
const H = 100;
const utf8 = (s) => new TextEncoder().encode(s);
const b64 = (b) => Buffer.from(b).toString('base64');
const upper = (b) => bytesToHex(b).toUpperCase();
const cat = (...p) => Uint8Array.from(Buffer.concat(p.map((x) => Buffer.from(x))));
const lenDelim = (field, b) => cat(varint((field << 3) | 2), varint(b.length), b);
const SIGNER = 'zetaphy1certsigner';

// Three validators: 40 + 30 + 30. Losing the 40 drops the signed power to 60 (< 2/3); losing a 30 keeps 70 (> 2/3).
const VALS = [40, 30, 30].map((power, i) => ({ power, address: upper(new Uint8Array(20).fill(0x10 + i)), key: ml_dsa44.keygen(new Uint8Array(32).fill(i + 1)) }));
const HEADER_FIELDS = ['chain_id', 'last_commit_hash', 'validators_hash', 'next_validators_hash', 'consensus_hash', 'app_hash', 'last_results_hash', 'evidence_hash', 'proposer_address', 'data_hash'];

function header(height, txs) {
  return {
    version: { block: '11' }, chain_id: CHAIN, height: String(height), time: '2026-10-27T09:00:00.5Z',
    last_block_id: { hash: '11'.repeat(32), parts: { total: 1, hash: '22'.repeat(32) } },
    last_commit_hash: '33'.repeat(32), data_hash: upper(txsHash(txs)), validators_hash: '44'.repeat(32), next_validators_hash: '44'.repeat(32),
    consensus_hash: '55'.repeat(32), app_hash: '66'.repeat(32), last_results_hash: '77'.repeat(32), evidence_hash: '88'.repeat(32), proposer_address: VALS[0].address,
  };
}
function certTx(attestations) {
  const value = cat(lenDelim(1, utf8(SIGNER)), varint(2 << 3), varint(H), lenDelim(3, attestations));
  return encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: CERT_TYPE_URL, value }] }), authInfoBytes: new Uint8Array(), signatures: [] });
}
function entry(since, pub) { const s = new Uint8Array(8); new DataView(s.buffer).setBigUint64(0, BigInt(since)); return cat(s, pub); }

/** A mocked CometBFT RPC serving block H (header hH, hash `hash`) and H+1 holding `tx`. */
function rpcFor(hH, hash, tx) {
  const nb = { block_id: { hash: 'AB'.repeat(32), parts: { total: 1, hash: '99'.repeat(32) } }, block: { header: header(H + 1, [tx]), data: { txs: [b64(tx)] } } };
  const hb = { block_id: { hash, parts: { total: 1, hash: '99'.repeat(32) } }, block: { header: hH, data: { txs: [] } } };
  const entries = Object.fromEntries(VALS.map((v) => [v.address, entry(H - 10, v.key.publicKey)]));
  return async (method, params) => {
    if (method === 'block') { const h = Number(params.height); if (h === H) return hb; if (h === H + 1) return nb; throw new Error(`no block ${h}`); }
    if (method === 'validators') return { block_height: String(H), validators: VALS.map((v) => ({ address: v.address, voting_power: String(v.power) })), count: '3', total: '3' };
    if (method === 'abci_query') return { response: { code: 0, value: b64(entries[params.data.slice(2)]), height: params.height } };
    throw new Error(`unexpected ${method}`);
  };
}

const flipBit = (bytes, bit) => { const b = Uint8Array.from(bytes); b[bit >> 3] ^= 1 << (bit & 7); return b; };
const flipHexBit = (hex, bit) => upper(flipBit(hexToBytes(hex), bit % (hex.length * 4)));

export const pqCert = {
  group: 'ZETAPHY', name: 'zetaphy/pq-cert-mutations', count: 300,
  what: 'PQ finality certificate (ML-DSA-44, 3 validators 40/30/30): the valid one passes; any single-bit flip in a signature or signer address drops exactly that validator (ok iff the rest > 2/3); a flip in the cert height, type URL or protobuf framing, in the block hash, or in any header field makes it fail; flips in the unsigned signer string change nothing',
  setup() {
    const hH = header(H, []);
    const hash = upper(headerHash(hH));
    const msg = voteMessage(CHAIN, H, hexToBytes(hash));
    const atts = VALS.map((v) => cat(hexToBytes(v.address), ml_dsa44.sign(msg, v.key.secretKey)));
    const tx = certTx(cat(...atts));
    const buf = Buffer.from(tx);
    const attStart = buf.indexOf(Buffer.from(atts[0]));
    const signerStart = buf.indexOf(Buffer.from(SIGNER));
    const typeStart = buf.indexOf(Buffer.from(CERT_TYPE_URL));
    return { hH, hash, tx, attStart, signerStart, heightAt: signerStart + SIGNER.length + 1, typeStart };
  },
  gen(R) {
    const region = R.pick(['sig', 'sig', 'sig', 'addr', 'height', 'typeurl', 'frame', 'hash', 'header', 'signer', 'none']);
    return { region, v: R.int(3), bit: R.u32(), field: R.pick(HEADER_FIELDS), nonce: region === 'none' ? R.u32() : 0 };
  },
  async check({ region, v, bit, field }, s) {
    let hH = s.hH, hash = s.hash, tx = s.tx;
    const att = s.attStart + v * 2440;
    if (region === 'sig') tx = flipBit(tx, (att + 20) * 8 + (bit % (2420 * 8)));
    else if (region === 'addr') tx = flipBit(tx, att * 8 + (bit % 160));
    else if (region === 'height') tx = flipBit(tx, s.heightAt * 8 + (bit % 8));
    else if (region === 'typeurl') tx = flipBit(tx, s.typeStart * 8 + (bit % (CERT_TYPE_URL.length * 8)));
    else if (region === 'frame') tx = flipBit(tx, bit % (s.typeStart * 8)); // TxRaw / TxBody / Any tags and lengths before the type URL
    else if (region === 'signer') tx = flipBit(tx, s.signerStart * 8 + (bit % (SIGNER.length * 8)));
    else if (region === 'hash') hash = flipHexBit(hash, bit);
    else if (region === 'header') {
      hH = structuredClone(hH);
      hH[field] = field === 'chain_id' ? CHAIN.slice(0, -1) + String.fromCharCode(CHAIN.charCodeAt(CHAIN.length - 1) ^ (1 << (bit % 7))) : flipHexBit(hH[field], bit);
    }
    const r = await verifyBlock(rpcFor(hH, hash, tx), H, { chainId: CHAIN });
    const signers = r.signers.map((x) => x.address);
    if (region === 'none' || region === 'signer') {
      ok(r.ok && r.pqMajority, `valid certificate passes (${region}): ${r.problems.join('; ')}`);
      eq(signers.length, 3, 'all three signed');
    } else if (region === 'sig' || region === 'addr') {
      ok(!signers.includes(VALS[v].address), 'the mutated attestation is not counted');
      eq(signers.length, 2, 'the two others still count');
      eq(r.ok, 3 * (100 - VALS[v].power) > 200, `ok iff the remaining power is more than 2/3 (validator ${v})`);
    } else {
      ok(!r.ok, `a flipped bit in ${region}${region === 'header' ? ' ' + field : ''} must fail verification`);
    }
  },
};

export default [pqCert];
