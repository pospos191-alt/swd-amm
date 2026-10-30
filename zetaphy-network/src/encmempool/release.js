// Decryption share release: after block h is COMMITTED (its ordered list of
// envelope hashes, the batch hash, is final), each validator publishes its shares
// of every accepted dealer's seed s[i,h], signed with its ML-DSA-44 vote key over
// the batch hash. Nodes check each share against the dealer's commitment, rebuild
// s[i,h] from t shares, and check XWing.getPublicKey(s[i,h]) == ek[i,h].
//
// Wire format:
//   body  = str "zetaphy/encmempool-release/v1" | str chain id | u32 epoch | u64 height
//           | u16 validator | 32 batch hash | u8 count | count x (u16 dealer | 32 share)
//   bytes = body || ML-DSA-44 signature (2420) over tag || body
//
// Signing over the batch hash makes early or forked release attributable: a valid
// release for height h whose batch hash is not the committed one is evidence that
// the validator released for a block that was never final (slashable on chain).

import { combine } from './shamir.js';
import { kemPublicKey } from './kem.js';
import { shareCommitment, SHARE_BYTES } from './dealing.js';
import { verifySig, signedMessage, VOTE_SIGNATURE_BYTES } from './committee.js';
import { Writer, Reader, tagHash, equalBytes, concat, utf8, u16, u64 } from './util.js';

const RELEASE_TAG = 'zetaphy/encmempool-release/v1';

/** The ordering commitment of block h: hash of its envelope hashes, in block order. */
export function batchHash(chainId, height, envelopeHashes) {
  return tagHash('zetaphy/encmempool-batch', utf8(chainId), u64(height), u16(envelopeHashes.length), ...envelopeHashes);
}

function encodeBody(r) {
  const w = new Writer().str(RELEASE_TAG).str(r.chainId).u32(r.epoch).u64(r.height).u16(r.validator).bytes(r.batchHash).u8(r.shares.length);
  for (const s of r.shares) w.u16(s.dealer).bytes(s.share);
  return w.finish();
}

/**
 * Validator `me` releases its shares for `height`. myShares: Map dealer -> opened
 * shares array (openDealing(...).shares); dealings: accepted dealings of the epoch.
 */
export function createRelease({ chainId, height, batchHash: bh, dealings, myShares, me }) {
  const h = BigInt(height);
  const epoch = dealings[0].epoch;
  const shares = dealings.map((d) => {
    const own = myShares.get(d.dealer);
    if (!own) throw new Error(`no share for dealer ${d.dealer}`);
    return { dealer: d.dealer, share: own[Number(h - d.startHeight)] };
  });
  const r = { chainId, epoch, height: h, validator: me.index, batchHash: bh, shares };
  const body = encodeBody(r);
  r.sig = me.sign(signedMessage(RELEASE_TAG, body));
  r.bytes = concat(body, r.sig);
  return r;
}

export function decodeRelease(bytes) {
  const rd = new Reader(bytes);
  if (rd.str() !== RELEASE_TAG) throw new Error('not a release');
  const r = { chainId: rd.str(), epoch: rd.u32(), height: rd.u64(), validator: rd.u16(), batchHash: rd.bytes(32) };
  const count = rd.u8();
  r.shares = Array.from({ length: count }, () => ({ dealer: rd.u16(), share: rd.bytes(SHARE_BYTES) }));
  r.sig = rd.bytes(VOTE_SIGNATURE_BYTES);
  rd.done();
  r.bytes = bytes;
  return r;
}

/**
 * Checks a release against the committed batch: signer, height, batch hash, one
 * share per accepted dealer, each matching its commitment.
 * ctx = { chainId, committee, dealings, height, batchHash }.
 */
export function verifyRelease(r, ctx) {
  if (r.chainId !== ctx.chainId) return { ok: false, reason: 'wrong chain' };
  if (r.height !== BigInt(ctx.height)) return { ok: false, reason: 'wrong height' };
  const v = ctx.committee[r.validator];
  if (!v) return { ok: false, reason: 'unknown validator' };
  if (!equalBytes(r.batchHash, ctx.batchHash)) return { ok: false, reason: 'batch hash is not the committed one' };
  if (r.shares.length !== ctx.dealings.length) return { ok: false, reason: 'wrong share count' };
  for (let i = 0; i < ctx.dealings.length; i++) {
    const d = ctx.dealings[i], s = r.shares[i];
    if (s.dealer !== d.dealer || r.epoch !== d.epoch) return { ok: false, reason: 'wrong dealer order or epoch' };
    const k = Number(r.height - d.startHeight);
    if (k < 0 || k >= d.length) return { ok: false, reason: 'height outside the epoch' };
    if (!equalBytes(shareCommitment(r.chainId, d.epoch, d.dealer, r.height, r.validator, s.share), d.commits[k][r.validator])) {
      return { ok: false, reason: `share for dealer ${d.dealer} does not match its commitment` };
    }
  }
  if (!verifySig(v.votePub, signedMessage(RELEASE_TAG, encodeBody(r)), r.sig)) return { ok: false, reason: 'bad signature' };
  return { ok: true };
}

/**
 * Rebuilds every dealer's seed for `height` from VERIFIED releases. Deterministic:
 * uses the t releases with the lowest validator indices. Returns
 * { ok: true, seeds: Map dealer -> seed } or { ok: false, missing, faulty }.
 * `faulty` lists dealers whose committed shares rebuild a key that does not match
 * their published public key (inconsistent dealing: attributable to the dealer).
 */
export function reconstructSeeds({ releases, dealings, height, t }) {
  const h = BigInt(height);
  const chosen = [...releases].sort((a, b) => a.validator - b.validator)
    .filter((r, i, a) => i === 0 || a[i - 1].validator !== r.validator).slice(0, t);
  if (chosen.length < t) return { ok: false, missing: t - chosen.length, faulty: [] };
  const seeds = new Map(), faulty = [];
  dealings.forEach((d, i) => {
    const seed = combine(chosen.map((r) => ({ x: r.validator + 1, y: r.shares[i].share })));
    if (equalBytes(kemPublicKey(seed), d.eks[Number(h - d.startHeight)])) seeds.set(d.dealer, seed);
    else faulty.push(d.dealer);
  });
  return faulty.length ? { ok: false, missing: 0, faulty } : { ok: true, seeds };
}

/** Exact size in bytes of one release (used by the benchmark and as a size bound). */
export const releaseBytes = (chainIdLength, dealers) =>
  1 + RELEASE_TAG.length + 1 + chainIdLength + 4 + 8 + 2 + 32 + 1 + dealers * (2 + SHARE_BYTES) + VOTE_SIGNATURE_BYTES;
