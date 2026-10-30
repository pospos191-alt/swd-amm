// Epoch key dealing (no trusted single dealer, but no DKG either: see the doc).
//
// For epoch e (heights startHeight .. startHeight+length-1) each selected dealer i:
//   1. draws one fresh 32-byte X-Wing seed s[i,h] per height h and publishes the
//      public key ek[i,h] = XWing.getPublicKey(s[i,h]);
//   2. Shamir-splits every s[i,h] t-of-n (shamir.js) and publishes a hash
//      commitment to every share: C[i,h,j] = H(chain, e, i, h, j, share);
//   3. encrypts validator j's shares (all heights at once) to j's X-Wing
//      transport key (kem.sealTo);
//   4. signs the whole dealing with its ML-DSA-44 vote key, then ERASES the seeds.
// Each validator opens its blob, checks its shares against the commitments and
// signs an ack. A dealing with >= t acks is accepted for the epoch.
//
// Users encrypt a tx for height h to the keys ek[i,h] of ALL accepted dealers at
// once (envelope.js): reading it needs every s[i,h], and each of those needs t
// shares, or the dealer's own copy of the seed. So confidentiality holds if fewer
// than t validators collude AND at least one accepted dealer erased its seeds.

import { split } from './shamir.js';
import { kemPublicKey, sealTo, openFrom, KEM_PUBLIC_KEY_BYTES, KEM_CIPHERTEXT_BYTES, KEM_SEED_BYTES, AEAD_TAG_BYTES } from './kem.js';
import { committeeHash, verifySig, signedMessage, VOTE_SIGNATURE_BYTES } from './committee.js';
import { Writer, Reader, tagHash, equalBytes, u16, u32, u64, utf8, concat, systemRandom } from './util.js';

const DEALING_TAG = 'zetaphy/encmempool-dealing/v1';
const ACK_TAG = 'zetaphy/encmempool-ack/v1';
export const SHARE_BYTES = KEM_SEED_BYTES; // 32: a share of a 32-byte seed
export const MAX_EPOCH_LENGTH = 1024;

export const shareCommitment = (chainId, epoch, dealer, height, validator, share) =>
  tagHash('zetaphy/encmempool-share', utf8(chainId), u32(epoch), u16(dealer), u64(height), u16(validator), share);

const blobAad = (chainId, epoch, dealer, validator, cHash) =>
  tagHash('zetaphy/encmempool-dealing-blob', utf8(chainId), u32(epoch), u16(dealer), u16(validator), cHash);

function encodeBody(d) {
  const w = new Writer().str(DEALING_TAG).str(d.chainId).u32(d.epoch).u64(d.startHeight).u16(d.length)
    .u16(d.dealer).u8(d.t).u16(d.n).bytes(d.committeeHash);
  for (const ek of d.eks) w.bytes(ek);
  for (const row of d.commits) for (const c of row) w.bytes(c);
  for (const b of d.blobs) w.bytes(b.kemCt).varbytes(b.ct);
  return w.finish();
}

function finalize(d) {
  const body = encodeBody(d);
  const bytes = concat(body, d.sig);
  return { ...d, body, bytes, hash: tagHash('zetaphy/encmempool-dealing-id', bytes) };
}

/**
 * Creates dealer `dealer`'s dealing. Returns { dealing, seeds }; an honest dealer
 * drops `seeds` right away (they are returned only so tests and the simulation can
 * model a dealer that keeps them).
 */
export function createDealing({ chainId, epoch, startHeight, length, t, committee, dealer, rng = systemRandom }) {
  const n = committee.length;
  if (!(length >= 1 && length <= MAX_EPOCH_LENGTH)) throw new Error('bad epoch length');
  const cHash = committeeHash(committee);
  const seeds = [], eks = [], commits = [], perValidator = committee.map(() => []);
  for (let k = 0; k < length; k++) {
    const h = BigInt(startHeight) + BigInt(k);
    const seed = rng(KEM_SEED_BYTES);
    seeds.push(seed);
    eks.push(kemPublicKey(seed));
    const shares = split(seed, n, t, rng);
    commits.push(shares.map((s, j) => shareCommitment(chainId, epoch, dealer.index, h, j, s.y)));
    shares.forEach((s, j) => perValidator[j].push(s.y));
  }
  const blobs = committee.map((v, j) =>
    sealTo(v.transportPub, concat(...perValidator[j]), blobAad(chainId, epoch, dealer.index, j, cHash), rng));
  const d = { chainId, epoch, startHeight: BigInt(startHeight), length, dealer: dealer.index, t, n, committeeHash: cHash, eks, commits, blobs };
  d.sig = dealer.sign(signedMessage(DEALING_TAG, encodeBody(d)));
  return { dealing: finalize(d), seeds };
}

export function decodeDealing(bytes) {
  const r = new Reader(bytes);
  if (r.str() !== DEALING_TAG) throw new Error('not a dealing');
  const d = { chainId: r.str(), epoch: r.u32(), startHeight: r.u64(), length: r.u16(), dealer: r.u16(), t: r.u8(), n: r.u16(), committeeHash: r.bytes(32) };
  if (d.length < 1 || d.length > MAX_EPOCH_LENGTH || d.n < 1 || d.n > 255 || d.t < 1 || d.t > d.n) throw new Error('bad dealing header');
  d.eks = Array.from({ length: d.length }, () => r.bytes(KEM_PUBLIC_KEY_BYTES));
  d.commits = Array.from({ length: d.length }, () => Array.from({ length: d.n }, () => r.bytes(32)));
  d.blobs = Array.from({ length: d.n }, () => ({ kemCt: r.bytes(KEM_CIPHERTEXT_BYTES), ct: r.varbytes(d.length * SHARE_BYTES + AEAD_TAG_BYTES) }));
  d.sig = r.bytes(VOTE_SIGNATURE_BYTES);
  r.done();
  return finalize(d);
}

/** Public check every node runs: right committee, right shape, signed by the dealer. */
export function verifyDealing(d, committee, { chainId, epoch, t } = {}) {
  if (chainId !== undefined && d.chainId !== chainId) return { ok: false, reason: 'wrong chain' };
  if (epoch !== undefined && d.epoch !== epoch) return { ok: false, reason: 'wrong epoch' };
  if (t !== undefined && d.t !== t) return { ok: false, reason: 'wrong threshold' };
  if (d.n !== committee.length || !equalBytes(d.committeeHash, committeeHash(committee))) return { ok: false, reason: 'wrong committee' };
  const dealer = committee[d.dealer];
  if (!dealer) return { ok: false, reason: 'unknown dealer' };
  if (d.eks.length !== d.length || d.commits.length !== d.length || d.blobs.length !== d.n) return { ok: false, reason: 'bad shape' };
  if (!verifySig(dealer.votePub, signedMessage(DEALING_TAG, d.body), d.sig)) return { ok: false, reason: 'bad dealer signature' };
  return { ok: true };
}

/** Validator `me` decrypts its shares and checks them against the commitments. */
export function openDealing(d, me) {
  const blob = d.blobs[me.index];
  if (!blob) return { ok: false, reason: 'no blob for me' };
  const plain = openFrom(me.transportSecret, blob.kemCt, blob.ct, blobAad(d.chainId, d.epoch, d.dealer, me.index, d.committeeHash));
  if (!plain || plain.length !== d.length * SHARE_BYTES) return { ok: false, reason: 'blob does not decrypt' };
  const shares = [];
  for (let k = 0; k < d.length; k++) {
    const y = plain.slice(k * SHARE_BYTES, (k + 1) * SHARE_BYTES);
    const h = d.startHeight + BigInt(k);
    if (!equalBytes(shareCommitment(d.chainId, d.epoch, d.dealer, h, me.index, y), d.commits[k][me.index])) {
      return { ok: false, reason: `share for height ${h} does not match its commitment` };
    }
    shares.push(y);
  }
  return { ok: true, shares };
}

export const signAck = (d, me) => ({ validator: me.index, dealingHash: d.hash, sig: me.sign(signedMessage(ACK_TAG, d.hash)) });
export const verifyAck = (ack, committee) =>
  !!committee[ack.validator] && verifySig(committee[ack.validator].votePub, signedMessage(ACK_TAG, ack.dealingHash), ack.sig);

/**
 * Dealings accepted for the epoch: valid, from one of the selected dealers, at
 * most one per dealer, and acked by >= minAcks distinct validators.
 * Returned sorted by dealer index (the order users encapsulate in).
 */
export function acceptDealings(dealings, acks, committee, { chainId, epoch, t, dealers, minAcks = t }) {
  const out = new Map();
  for (const d of dealings) {
    if (dealers && !dealers.includes(d.dealer)) continue;
    if (out.has(d.dealer)) continue; // first valid dealing per dealer wins (on chain: first included)
    if (!verifyDealing(d, committee, { chainId, epoch, t }).ok) continue;
    const ackers = new Set(acks.filter((a) => equalBytes(a.dealingHash, d.hash) && verifyAck(a, committee)).map((a) => a.validator));
    if (ackers.size >= minAcks) out.set(d.dealer, d);
  }
  return [...out.values()].sort((a, b) => a.dealer - b.dealer);
}
