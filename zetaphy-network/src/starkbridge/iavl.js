// A minimal IAVL tree (cosmos/iavl v1 node hashing) and ICS23 existence proofs in
// the IavlSpec form, for the trustless-bridge prototype. The real chain's evm store is
// an IAVL tree keyed 0x02 || address || slot (cosmos/evm x/vm: KeyPrefixStorage) with
// the 32-byte slot value; abci_query("store/evm/key", prove=true) returns the same
// ICS23 ops this module produces (leaf prefix, then { prefix, suffix } per level).
//
// Node hash (iavl node.go writeHashBytes):
//   leaf:  sha256( zz(0) || zz(1) || zz(version) || uvarint(len k) || k || 0x20 || sha256(value) )
//   inner: sha256( zz(height) || zz(size) || zz(version) || 0x20 || left || 0x20 || right )
// where zz = Go binary.PutVarint (zigzag). Inner nodes do not hash their key.
// This builder makes a perfectly balanced tree with one version for every node, which
// is a valid IAVL shape; a live tree has mixed versions and AVL heights, which the
// proof format carries in each op's prefix (the verifier never assumes the shape).

import { sha256 } from '@noble/hashes/sha2.js';
import { concat, uvarint } from './merkle.js';

export const zz = (n) => uvarint(BigInt(n) * 2n); // non-negative values only
const LEN32 = Uint8Array.of(0x20);

export const leafPrefix = (version) => concat(zz(0), zz(1), zz(version));
export const iavlLeafHash = (key, value, version) =>
  sha256(concat(leafPrefix(version), uvarint(key.length), key, LEN32, sha256(value)));

const cmp = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

/** Builds the tree over [{ key, value }] (distinct keys). Returns { root, prove(key) }. */
export function buildIavl(entries, version = 1) {
  const kv = [...entries].sort((x, y) => cmp(x.key, y.key));
  for (let i = 1; i < kv.length; i++) if (!cmp(kv[i].key, kv[i - 1].key)) throw new Error('iavl: duplicate key');
  const build = (lo, hi) => {
    if (hi - lo === 1) return { height: 0, size: 1, hash: iavlLeafHash(kv[lo].key, kv[lo].value, version), lo, hi };
    const mid = lo + Math.ceil((hi - lo) / 2);
    const left = build(lo, mid), right = build(mid, hi);
    const height = 1 + Math.max(left.height, right.height), size = left.size + right.size;
    const pre = concat(zz(height), zz(size), zz(version));
    return { height, size, left, right, pre, lo, hi, hash: sha256(concat(pre, LEN32, left.hash, LEN32, right.hash)) };
  };
  const root = build(0, kv.length);
  return {
    root: root.hash,
    /** ICS23 existence proof { key, value, leafPrefix, path: [{ prefix, suffix }] (leaf to root) }. */
    prove(key) {
      const i = kv.findIndex((e) => !cmp(e.key, key));
      if (i < 0) throw new Error('iavl: key not found');
      const path = [];
      let n = root;
      while (n.left) {
        if (i < n.right.lo) { path.unshift({ prefix: concat(n.pre, LEN32), suffix: concat(LEN32, n.right.hash) }); n = n.left; }
        else { path.unshift({ prefix: concat(n.pre, LEN32, n.left.hash, LEN32), suffix: new Uint8Array(0) }); n = n.right; }
      }
      return { key: kv[i].key, value: kv[i].value, leafPrefix: leafPrefix(version), path };
    },
  };
}

/** Applies an IavlSpec existence proof: the root, or null when an op breaks the spec. */
export function applyIavlProof({ key, value, leafPrefix: lp, path }) {
  if (lp[0] !== 0) return null;
  let h = sha256(concat(lp, uvarint(key.length), key, LEN32, sha256(value)));
  for (const op of path) {
    if (op.prefix[0] === 0 || op.prefix.length < 4) return null;
    h = sha256(concat(op.prefix, h, op.suffix));
  }
  return h;
}
