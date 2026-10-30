// Validator keys for the encrypted mempool and the committee they form.
//
// Each validator has two post-quantum keys:
//   - its ML-DSA-44 vote key (the one ZETAPHY validators already register for PQ
//     block certificates, config/pq_vote_key.seed): signs dealings, acks and
//     share releases;
//   - a NEW X-Wing transport key (ML-KEM-768 + X25519): dealers encrypt each
//     validator's shares to it. On chain it would be registered by a message signed
//     with the vote key (see docs/future/encrypted-mempool.md, "Integration").
//
// makeValidator derives both from one 32-byte seed so tests and the simulation are
// reproducible. Real validators keep separate seed files and never derive keys from
// anything public.

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { kemKeygen } from './kem.js';
import { tagHash, concat, u16, u64, utf8 } from './util.js';

export const VOTE_PUBLIC_KEY_BYTES = 1312;
export const VOTE_SIGNATURE_BYTES = 2420;

/** Default threshold: more than 2/3 of the validators (t = floor(2n/3) + 1). */
export const defaultThreshold = (n) => Math.floor((2 * n) / 3) + 1;

/**
 * A validator with secrets. `deterministic` makes ML-DSA signing deterministic
 * (FIPS 204 allows it); the default is hedged (fresh randomness per signature).
 */
export function makeValidator(index, seed, { deterministic = false } = {}) {
  const vote = ml_dsa44.keygen(tagHash('zetaphy/encmempool-vote-seed', seed));
  const transport = kemKeygen(tagHash('zetaphy/encmempool-transport-seed', seed));
  const opts = deterministic ? { extraEntropy: false } : {};
  return {
    index,
    votePub: vote.publicKey,
    transportPub: transport.publicKey,
    transportSecret: transport.secretKey,
    sign: (msg) => ml_dsa44.sign(msg, vote.secretKey, opts),
  };
}

/** The public part only, as the chain would store it. */
export const publicValidator = (v) => ({ index: v.index, votePub: v.votePub, transportPub: v.transportPub });

export function verifySig(votePub, msg, sig) {
  if (!sig || sig.length !== VOTE_SIGNATURE_BYTES) return false;
  try { return ml_dsa44.verify(sig, msg, votePub); } catch { return false; }
}

/** Hash binding a dealing to the exact committee (indices, vote keys, transport keys). */
export function committeeHash(committee) {
  committee.forEach((v, i) => { if (v.index !== i) throw new Error('committee must be indexed 0..n-1'); });
  return tagHash('zetaphy/encmempool-committee', u16(committee.length),
    ...committee.flatMap((v) => [u16(v.index), v.votePub, v.transportPub]));
}

/**
 * Picks `d` distinct dealers for an epoch from public randomness (on chain: the
 * PREVRANDAO-style value derived from the ML-DSA certificate of the epoch's
 * last block before dealing). Deterministic, so every node agrees.
 */
export function selectDealers(randomness, epoch, n, d) {
  if (d > n) throw new Error('more dealers than validators');
  const order = Array.from({ length: n }, (_, i) => i)
    .map((i) => ({ i, k: tagHash('zetaphy/encmempool-dealer', randomness, u64(epoch), u16(i)) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.k), Buffer.from(b.k)));
  return order.slice(0, d).map((o) => o.i).sort((a, b) => a - b);
}

export const signedMessage = (tag, body) => concat(utf8(`${tag}\0`), body);
