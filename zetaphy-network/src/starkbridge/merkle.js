// CometBFT / Cosmos SDK hashing used by the trustless bridge (prototype):
//   - the "simple" Merkle tree of crypto/merkle (RFC 6962 style: leaf = sha256(0x00 || x),
//     inner = sha256(0x01 || l || r), split at the largest power of two below n),
//     with proofs as (index, total, aunts) exactly like merkle.Proof;
//   - the CometBFT header hash (Header.Hash(): 14 protobuf-encoded fields);
//   - the Cosmos SDK multistore commitment (app hash): a simple Merkle tree over
//     KV pairs (store name, sha256(store root)), sorted by name.
// Checked against a real devnet header in test/starkbridge.test.js.

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);
export const leafHash = (b) => sha256(concat(Uint8Array.of(0), b));
export const innerHash = (l, r) => sha256(concat(Uint8Array.of(1), l, r));
const split = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; };

/** merkle.HashFromByteSlices */
export function simpleRoot(items) {
  if (!items.length) return sha256(new Uint8Array(0));
  if (items.length === 1) return leafHash(items[0]);
  const k = split(items.length);
  return innerHash(simpleRoot(items.slice(0, k)), simpleRoot(items.slice(k)));
}

/** merkle.ProofsFromByteSlices for one index: { index, total, leafHash, aunts } (aunts bottom-up). */
export function simpleProof(items, index) {
  const aunts = [];
  const walk = (lo, hi) => {
    if (hi - lo === 1) return;
    const k = lo + split(hi - lo);
    if (index < k) { aunts.unshift(simpleRoot(items.slice(k, hi))); walk(lo, k); }
    else { aunts.unshift(simpleRoot(items.slice(lo, k))); walk(k, hi); }
  };
  walk(0, items.length);
  return { index, total: items.length, leafHash: leafHash(items[index]), aunts };
}

/** merkle.computeHashFromAunts (aunts bottom-up). */
export function rootFromAunts(index, total, leaf, aunts) {
  if (index >= total || total < 1) return null;
  if (total === 1) return aunts.length ? null : leaf;
  if (!aunts.length) return null;
  const k = split(total);
  const last = aunts[aunts.length - 1];
  if (index < k) { const l = rootFromAunts(index, k, leaf, aunts.slice(0, -1)); return l && innerHash(l, last); }
  const r = rootFromAunts(index - k, total - k, leaf, aunts.slice(0, -1));
  return r && innerHash(last, r);
}

// ---- protobuf bits (proto3: default values are omitted) ----
export function uvarint(n) {
  let v = BigInt(n);
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Uint8Array.from(out);
}
const field = (num, wire) => uvarint((num << 3) | wire);
const pbVarint = (num, v) => (BigInt(v) === 0n ? new Uint8Array(0) : concat(field(num, 0), uvarint(v)));
const pbBytes = (num, b) => (b.length ? concat(field(num, 2), uvarint(b.length), b) : new Uint8Array(0));
const hx = (s) => (s instanceof Uint8Array ? s : hexToBytes(String(s ?? '').toLowerCase()));

/** RFC 3339 time with nanoseconds -> { seconds, nanos } (google.protobuf.Timestamp). */
export function parseTime(s) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(s);
  if (!m) throw new Error(`header: unsupported time ${s}`);
  return { seconds: BigInt(Date.parse(`${m[1]}Z`) / 1000), nanos: Number((m[2] ?? '').padEnd(9, '0')) };
}

/** The 14 leaves of Header.Hash(), from a CometBFT RPC header (JSON; hashes as hex). */
export function headerLeaves(h) {
  const t = parseTime(h.time);
  const parts = h.last_block_id?.parts ?? {};
  const psh = concat(pbVarint(1, parts.total ?? 0), pbBytes(2, hx(parts.hash)));
  return [
    concat(pbVarint(1, h.version?.block ?? 0), pbVarint(2, h.version?.app ?? 0)),
    pbBytes(1, utf8(h.chain_id)),            // StringValue
    pbVarint(1, h.height),                    // Int64Value
    concat(pbVarint(1, t.seconds), pbVarint(2, t.nanos)),
    concat(pbBytes(1, hx(h.last_block_id?.hash)), pbBytes(2, psh)),
    ...['last_commit_hash', 'data_hash', 'validators_hash', 'next_validators_hash', 'consensus_hash', 'app_hash',
      'last_results_hash', 'evidence_hash', 'proposer_address'].map((k) => pbBytes(1, hx(h[k]))), // BytesValue
  ];
}
export const HEADER_FIELDS = 14;
export const APP_HASH_INDEX = 10;
export const headerHash = (h) => simpleRoot(headerLeaves(h));

/** Proof that `app_hash` (32 bytes) is field 10 of the header: its 4 aunts (bottom-up). */
export function appHashProof(h) {
  const p = simpleProof(headerLeaves(h), APP_HASH_INDEX);
  return { appHash: hx(h.app_hash), aunts: p.aunts };
}

// ---- Cosmos SDK multistore (rootmulti): app hash over (name, sha256(store root)) ----
export const kvPairBytes = (key, value) => concat(uvarint(key.length), key, uvarint(value.length), value);
const sortedStores = (stores) => Object.entries(stores).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
export function multistoreRoot(stores) {
  return simpleRoot(sortedStores(stores).map(([name, root]) => kvPairBytes(utf8(name), sha256(root))));
}

/**
 * Proof of one store's root in the app hash, as ICS23 InnerOps of the Tendermint spec
 * (what abci_query with prove=true returns for the multistore): { prefix, suffix } bottom-up,
 * prefix = 0x01 || left sibling (the node is a right child) or 0x01, suffix = right sibling or empty.
 */
export function multistoreProof(stores, name) {
  const sorted = sortedStores(stores);
  const items = sorted.map(([n, root]) => kvPairBytes(utf8(n), sha256(root)));
  const index = sorted.findIndex(([n]) => n === name);
  if (index < 0) throw new Error(`no store ${name}`);
  const ops = [];
  const walk = (lo, hi) => {
    if (hi - lo === 1) return;
    const k = lo + split(hi - lo);
    if (index < k) { walk(lo, k); ops.push({ prefix: Uint8Array.of(1), suffix: simpleRoot(items.slice(k, hi)) }); }
    else { walk(k, hi); ops.push({ prefix: concat(Uint8Array.of(1), simpleRoot(items.slice(lo, k))), suffix: new Uint8Array(0) }); }
  };
  walk(0, items.length);
  return ops;
}

/** Applies Tendermint-spec ICS23 ops: the app hash for (store name, store root). */
export function applyMultistoreOps(name, storeRoot, ops) {
  let h = leafHash(kvPairBytes(utf8(name), sha256(storeRoot)));
  for (const op of ops) h = sha256(concat(op.prefix, h, op.suffix));
  return h;
}
