// SHA-256 Merkle trees (with batched multi-openings) and the Fiat-Shamir
// transcript of the STARK light client. SHA-256 is the only cryptographic
// assumption of the STARK itself (collision resistance for the commitments,
// random-oracle behaviour for Fiat-Shamir): a hash-based, post-quantum proof.

import { sha256 } from '@noble/hashes/sha2.js';
import { P, toBytes, fieldsToBytes, bytesToBigInt } from './field.js';

export const DIGEST_BYTES = 32;
const utf8 = (s) => new TextEncoder().encode(s);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const LEAF = Uint8Array.of(0), NODE = Uint8Array.of(1);
export const leafHash = (data) => sha256(concat(LEAF, data));
export const nodeHash = (l, r) => sha256(concat(NODE, l, r));
/** Leaf of field elements. */
export const fieldLeaf = (xs) => leafHash(fieldsToBytes(xs));

/** A Merkle tree over leaf hashes (count a power of two). layers[0] = leaves, last = [root]. */
export function buildTree(leafHashes) {
  const n = leafHashes.length;
  if (!n || (n & (n - 1))) throw new Error('merkle: leaf count must be a power of two');
  const layers = [leafHashes];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = new Array(prev.length / 2);
    for (let i = 0; i < next.length; i++) next[i] = nodeHash(prev[2 * i], prev[2 * i + 1]);
    layers.push(next);
  }
  return { layers, root: layers[layers.length - 1][0], depth: layers.length - 1 };
}

/**
 * Batched opening of the leaves at `indices` (sorted, unique): the sibling
 * hashes not computable from the opened leaves, level by level, left to right.
 */
export function openMany(tree, indices) {
  let cur = indices;
  const out = [];
  for (let lvl = 0; lvl < tree.depth; lvl++) {
    const next = [];
    for (let k = 0; k < cur.length; k++) {
      const i = cur[k];
      if ((i & 1) === 0 && cur[k + 1] === i + 1) k++;
      else out.push(tree.layers[lvl][i ^ 1]);
      next.push(i >> 1);
    }
    cur = next;
  }
  return out;
}

/** Checks an openMany proof: leafHashes[k] is the leaf at indices[k] (sorted, unique). */
export function verifyMany(root, depth, indices, leafHashes, proof) {
  if (indices.length !== leafHashes.length || !indices.length) return false;
  for (let k = 0; k < indices.length; k++) {
    if (!Number.isInteger(indices[k]) || indices[k] < 0 || indices[k] >= 2 ** depth) return false;
    if (k && indices[k] <= indices[k - 1]) return false;
  }
  let cur = indices.map((i, k) => [i, leafHashes[k]]);
  let p = 0;
  for (let lvl = 0; lvl < depth; lvl++) {
    const next = [];
    for (let k = 0; k < cur.length; k++) {
      const [i, h] = cur[k];
      let parent;
      if ((i & 1) === 0 && cur[k + 1] && cur[k + 1][0] === i + 1) { parent = nodeHash(h, cur[k + 1][1]); k++; }
      else {
        const sib = proof[p++];
        if (!sib) return false;
        parent = i & 1 ? nodeHash(sib, h) : nodeHash(h, sib);
      }
      next.push([i >> 1, parent]);
    }
    cur = next;
  }
  return p === proof.length && cur.length === 1 && cur[0][0] === 0 && equalBytes(cur[0][1], root);
}

/** Fiat-Shamir transcript: a SHA-256 hash chain; challenges are squeezed with a counter. */
export class Transcript {
  constructor(label) { this.state = sha256(utf8(`zetaphy/starklc/v1\0${label}`)); this.ctr = 0; }
  absorb(bytes) { this.state = sha256(concat(this.state, bytes)); this.ctr = 0; }
  absorbFields(xs) { this.absorb(fieldsToBytes(xs)); }
  squeeze() {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, this.ctr++);
    return sha256(concat(this.state, c));
  }
  /** A uniform field element (512 bits reduced mod p: bias < 2^-250). */
  field() { return bytesToBigInt(concat(this.squeeze(), this.squeeze())) % P; }
  /** A uniform integer in [0, n) for n < 2^200 (512 bits reduced: bias < 2^-300). */
  below(n) { return bytesToBigInt(concat(this.squeeze(), this.squeeze())) % BigInt(n); }
}

const leadingZeroBits = (h) => {
  let z = 0;
  for (const b of h) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; }
  return z;
};
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };

/** Proof of work ("grinding"): a nonce with sha256(state || nonce) having `bits` leading zero bits. */
export function grind(transcript, bits) {
  if (!bits) return 0n;
  for (let n = 0n; ; n++) if (leadingZeroBits(sha256(concat(transcript.state, u64(n)))) >= bits) return n;
}
export const checkGrind = (transcript, bits, nonce) => !bits || leadingZeroBits(sha256(concat(transcript.state, u64(nonce)))) >= bits;
export { u64, toBytes };
