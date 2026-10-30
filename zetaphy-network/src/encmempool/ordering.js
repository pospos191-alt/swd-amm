// The consensus-side state machine of the encrypted lane (what every node would
// run deterministically; zetaphy-chain integration points are in the doc).
//
// Ordering rule ("order first, decrypt later"):
//   block h      carries encrypted envelopes targeted at h. Their order in the block is
//                final once h commits: batchHash(h) = H(envelope hashes in block order).
//                Nobody (proposer included) can read them yet.
//   after h      validators release their shares, signed over batchHash(h). Releases
//                for a height whose batch is not committed are refused.
//   block h' > h first block whose key data holds >= t valid releases for h: at the
//                VERY START of h' (before any plaintext tx of h'), every node rebuilds
//                the keys, decrypts batch h and executes it in the committed order.
//                Undecryptable envelopes (garbage, wrong keys) are skipped; their
//                inclusion fee was already paid at inclusion.
//   expiry       if batch h is still not decryptable when h' > h + ttl, it expires: none
//                of its txs ever run (users keep their nonces and can resubmit).
// Batches run strictly in height order: a pending older batch blocks newer ones
// until it decrypts or expires, so the inclusion order is never inverted.
//
// Why this kills sandwiching (below the threshold): a front-run must execute before
// the victim. Every tx that executes before the victim was either in an earlier block,
// in block h itself, or in batch h ahead of the victim; all of them were fixed while
// the victim was still ciphertext. A back-run after the reveal is still possible
// (that is ordinary arbitrage and does not hurt the victim's price).

import { verifyEnvelope, decryptEnvelope } from './envelope.js';
import { batchHash, verifyRelease, reconstructSeeds, decodeRelease } from './release.js';
import { hex } from './util.js';

export class EncryptedLane {
  /**
   * chainId, committee (public validators, index = position), t, ttl (blocks after h
   * during which batch h may still decrypt), rules: { minFeePerByte, maxGas, maxEnvelopesPerBlock }.
   */
  constructor({ chainId, committee, t, ttl = 4, rules = {} }) {
    Object.assign(this, { chainId, committee, t, ttl, rules });
    this.epochs = new Map(); // epoch -> { startHeight, length, dealings }
    this.pending = new Map(); // height -> { batchHash, envelopes, releases: Map validator -> release }
    this.log = [];
  }

  setEpoch(epoch, dealings) {
    if (!dealings.length) throw new Error('an epoch needs at least one accepted dealing');
    const { startHeight, length } = dealings[0];
    if (dealings.some((d) => d.epoch !== epoch || d.startHeight !== startHeight || d.length !== length)) throw new Error('dealings disagree on the epoch');
    this.epochs.set(epoch, { epoch, startHeight, length, dealings });
  }

  epochFor(height) {
    const h = BigInt(height);
    for (const e of this.epochs.values()) if (h >= e.startHeight && h < e.startHeight + BigInt(e.length)) return e;
    return null;
  }

  /** What a wallet needs to encrypt for block `height`. */
  publicKeys(height) {
    const e = this.epochFor(height);
    if (!e) throw new Error(`no keys for height ${height}`);
    const k = Number(BigInt(height) - e.startHeight);
    return { epoch: e.epoch, keys: e.dealings.map((d) => ({ dealer: d.dealer, ek: d.eks[k] })) };
  }

  rulesFor(height) {
    const e = this.epochFor(height);
    if (!e) return null;
    return { chainId: this.chainId, height, epoch: e.epoch, dealers: e.dealings.map((d) => d.dealer), ...this.rules };
  }

  /** CheckTx / ProcessProposal check of one envelope for block `height`. */
  checkEnvelope(bytes, height) {
    const rules = this.rulesFor(height);
    return rules ? verifyEnvelope(bytes, rules) : { ok: false, reason: 'no keys for this height' };
  }

  /**
   * ProcessProposal + commit of block `height`: every envelope must be valid for
   * this height and unique; returns the batch hash (the ordering commitment).
   * Throws (= reject the proposal) on any invalid envelope.
   */
  commitBatch(height, envelopeBytes) {
    const h = BigInt(height);
    if (this.pending.has(h)) throw new Error('batch already committed');
    if (this.rules.maxEnvelopesPerBlock !== undefined && envelopeBytes.length > this.rules.maxEnvelopesPerBlock) throw new Error('too many envelopes');
    const seen = new Set();
    const envelopes = envelopeBytes.map((b, i) => {
      const r = this.checkEnvelope(b, h);
      if (!r.ok) throw new Error(`envelope ${i}: ${r.reason}`);
      const id = hex(r.envelope.hash);
      if (seen.has(id)) throw new Error(`envelope ${i}: duplicate`);
      seen.add(id);
      return r.envelope;
    });
    const bh = batchHash(this.chainId, h, envelopes.map((e) => e.hash));
    if (envelopes.length) this.pending.set(h, { height: h, batchHash: bh, envelopes, releases: new Map(), epoch: this.epochFor(h) });
    return bh;
  }

  /** Adds a release (bytes or decoded). Refused unless batch h is committed and pending. */
  addRelease(rel) {
    let r = rel;
    try { if (rel instanceof Uint8Array) r = decodeRelease(rel); } catch (e) { return { ok: false, reason: `malformed: ${e.message}` }; }
    const p = this.pending.get(r.height);
    if (!p) return { ok: false, reason: 'no committed pending batch at this height' };
    const v = verifyRelease(r, { chainId: this.chainId, committee: this.committee, dealings: p.epoch.dealings, height: r.height, batchHash: p.batchHash });
    if (!v.ok) return v;
    p.releases.set(r.validator, r);
    return { ok: true };
  }

  /**
   * Start of block `height` (PreBlocker): decrypt-and-execute ready batches in
   * height order, expire stale ones. Returns { execute, expired, faultyDealers }:
   * execute = [{ height, index, hash, tx | null }] in the exact order to run them.
   */
  beginBlock(height) {
    const now = BigInt(height);
    const execute = [], expired = [], faultyDealers = [];
    for (const h of [...this.pending.keys()].sort((a, b) => (a < b ? -1 : 1))) {
      if (h >= now) break;
      const p = this.pending.get(h);
      const rec = reconstructSeeds({ releases: [...p.releases.values()], dealings: p.epoch.dealings, height: h, t: this.t });
      if (rec.ok) {
        p.envelopes.forEach((e, index) => execute.push({ height: h, index, hash: e.hash, tx: decryptEnvelope(e, rec.seeds), fee: e.fee, payerPub: e.payerPub }));
        this.pending.delete(h);
        this.log.push({ at: now, height: h, outcome: 'decrypted', releases: p.releases.size });
        continue;
      }
      if (rec.faulty?.length) faultyDealers.push(...rec.faulty.map((dealer) => ({ height: h, dealer })));
      if (now > h + BigInt(this.ttl) || rec.faulty?.length) {
        p.envelopes.forEach((e, index) => expired.push({ height: h, index, hash: e.hash, fee: e.fee }));
        this.pending.delete(h);
        this.log.push({ at: now, height: h, outcome: rec.faulty?.length ? 'expired (faulty dealer)' : 'expired', releases: p.releases.size });
        continue;
      }
      break; // head-of-line: keep inclusion order across blocks
    }
    return { execute, expired, faultyDealers };
  }
}
