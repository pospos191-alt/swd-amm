// Binary proof format of the ZETAPHY STARK light client (version 1).
// All integers big-endian; field elements 32 bytes (canonical, < p); digests 32 bytes.
//
//   "ZSLC" u8 version=1
//   u8 logBlowup  u8 queries  u8 grind  u8 logFinalDeg  u8 logN
//   statement:  u8 kind (0 block, 1 handoff)  u8 len  chainId  u64 height  hash[32]  u8 nextLogN  u8 nextLogBlowup
//   S T U C (4 fields)
//   u8 revealMode (0 none, 1 sample, 2 all)  u16 k
//   traceRoot[32]  qRoot[32]
//   ood: 6 trace + 4 next-row + 4 set + 1 Q (15 fields)
//   u16 reveals:  each  u32 row, 7 fields (B G CS CS_next A K P), signature[2420], public key[1312]
//   u16 samples:  each  u16 reveal index
//   u8 friRoots:  each [32]
//   u8 finalPoly: each field
//   u64 nonce
//   u16 queries Q:  Q x (12 trace fields), Q x (8 set fields), Q x (2 Q fields)
//   3 Merkle multiproofs (trace, set, Q): u16 count, count x [32]
//   per FRI layer: u16 openings, openings x (2 fields), multiproof

import { fromBytes, toBytes } from './field.js';
import { MODES, MODE_NAMES } from './protocol.js';
import { SIGNATURE_BYTES, PUBLIC_KEY_BYTES } from './air.js';

const MAGIC = [0x5a, 0x53, 0x4c, 0x43]; // ZSLC

class Writer {
  constructor() { this.parts = []; this.n = 0; }
  bytes(b) { this.parts.push(b); this.n += b.length; }
  u8(v) { this.bytes(Uint8Array.of(v)); }
  u16(v) { if (v > 0xffff) throw new Error('proof: count too large'); this.bytes(Uint8Array.of(v >> 8, v & 255)); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); this.bytes(b); }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); this.bytes(b); }
  f(x) { this.bytes(toBytes(x)); }
  fs(xs) { xs.forEach((x) => this.f(x)); }
  d(b) { if (b.length !== 32) throw new Error('proof: digest is not 32 bytes'); this.bytes(b); }
  out() { const o = new Uint8Array(this.n); let p = 0; for (const b of this.parts) { o.set(b, p); p += b.length; } return o; }
}

class Reader {
  constructor(b) { this.b = b; this.p = 0; this.dv = new DataView(b.buffer, b.byteOffset, b.length); }
  take(n) { if (this.p + n > this.b.length) throw new Error('truncated'); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  u8() { return this.take(1)[0]; }
  u16() { const s = this.take(2); return (s[0] << 8) | s[1]; }
  u32() { this.take(4); return this.dv.getUint32(this.p - 4); }
  u64() { this.take(8); return this.dv.getBigUint64(this.p - 8); }
  f() { return fromBytes(this.take(32)); }
  fs(n) { return Array.from({ length: n }, () => this.f()); }
  d() { return this.take(32).slice(); }
  ds(n) { return Array.from({ length: n }, () => this.d()); }
}

const writeMulti = (w, nodes) => { w.u16(nodes.length); nodes.forEach((x) => w.d(x)); };

export function encodeProof(proof) {
  const w = new Writer();
  w.bytes(Uint8Array.from(MAGIC)); w.u8(1);
  const p = proof.params;
  [p.logBlowup, p.queries, p.grind, p.logFinalDeg, proof.logN].forEach((x) => w.u8(x));
  const st = proof.statement;
  const chain = new TextEncoder().encode(st.chainId);
  w.u8(st.kind === 'handoff' ? 1 : 0); w.u8(chain.length); w.bytes(chain); w.u64(st.height); w.d(st.hash);
  w.u8(st.kind === 'handoff' ? st.nextLogN : 0); w.u8(st.kind === 'handoff' ? st.nextLogBlowup : 0);
  w.fs([proof.pub.S, proof.pub.T, proof.pub.U, proof.pub.C]);
  w.u8(MODES[proof.reveal.mode]); w.u16(proof.reveal.k);
  w.d(proof.traceRoot); w.d(proof.qRoot);
  w.fs([...proof.ood.t, ...proof.ood.tn, ...proof.ood.s, proof.ood.q]);
  w.u16(proof.reveals.length);
  for (const r of proof.reveals) { w.u32(r.row); w.fs(r.vals); w.bytes(r.sig); w.bytes(r.pk); }
  w.u16(proof.samples.length); proof.samples.forEach((s) => w.u16(s));
  w.u8(proof.friRoots.length); proof.friRoots.forEach((r) => w.d(r));
  w.u8(proof.finalPoly.length); w.fs(proof.finalPoly);
  w.u64(proof.nonce);
  w.u16(proof.traceLeaves.length);
  proof.traceLeaves.forEach((l) => w.fs(l)); proof.setLeaves.forEach((l) => w.fs(l)); proof.qLeaves.forEach((l) => w.fs(l));
  writeMulti(w, proof.traceProof); writeMulti(w, proof.setProof); writeMulti(w, proof.qProof);
  for (const layer of proof.friLayers) { w.u16(layer.leaves.length); layer.leaves.forEach((l) => w.fs(l)); writeMulti(w, layer.proof); }
  return w.out();
}

export function decodeProof(bytes) {
  const r = new Reader(bytes);
  const magic = r.take(4);
  if (MAGIC.some((m, i) => magic[i] !== m)) throw new Error('not a ZETAPHY STARK light-client proof');
  if (r.u8() !== 1) throw new Error('unsupported proof version');
  const [logBlowup, queries, grind, logFinalDeg, logN] = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
  if (logN < 3 || logN > 20 || logBlowup < 1 || logBlowup > 6) throw new Error('parameters out of range');
  const kind = r.u8();
  if (kind > 1) throw new Error('unknown statement kind');
  const chainId = new TextDecoder('utf-8', { fatal: true }).decode(r.take(r.u8()));
  const height = r.u64(), hash = r.d(), nextLogN = r.u8(), nextLogBlowup = r.u8();
  const statement = kind === 1 ? { kind: 'handoff', chainId, height, hash, nextLogN, nextLogBlowup } : { kind: 'block', chainId, height, hash };
  const [S, T, U, C] = r.fs(4);
  const modeId = r.u8();
  if (modeId > 2) throw new Error('unknown reveal mode');
  const reveal = { mode: MODE_NAMES[modeId], k: r.u16() };
  const traceRoot = r.d(), qRoot = r.d();
  const o = r.fs(15);
  const ood = { t: o.slice(0, 6), tn: o.slice(6, 10), s: o.slice(10, 14), q: o[14] };
  const reveals = Array.from({ length: r.u16() }, () => ({ row: r.u32(), vals: r.fs(7), sig: r.take(SIGNATURE_BYTES).slice(), pk: r.take(PUBLIC_KEY_BYTES).slice() }));
  const samples = Array.from({ length: r.u16() }, () => r.u16());
  const friRoots = r.ds(r.u8());
  const finalPoly = r.fs(r.u8());
  const nonce = r.u64();
  const nq = r.u16();
  const traceLeaves = Array.from({ length: nq }, () => r.fs(12));
  const setLeaves = Array.from({ length: nq }, () => r.fs(8));
  const qLeaves = Array.from({ length: nq }, () => r.fs(2));
  const traceProof = r.ds(r.u16()), setProof = r.ds(r.u16()), qProof = r.ds(r.u16());
  const friLayers = friRoots.map(() => { const n = r.u16(); const leaves = Array.from({ length: n }, () => r.fs(2)); return { leaves, proof: r.ds(r.u16()) }; });
  if (r.p !== bytes.length) throw new Error('trailing bytes');
  return { version: 1, params: { logBlowup, queries, grind, logFinalDeg }, logN, statement, pub: { S, T, U, C }, reveal,
    traceRoot, qRoot, ood, reveals, samples, friRoots, finalPoly, nonce, traceLeaves, setLeaves, qLeaves, traceProof, setProof, qProof, friLayers };
}

/** Size breakdown of an encoded proof (bytes): signatures/keys revealed vs the STARK itself. */
export function proofSize(proof) {
  const total = encodeProof(proof).length;
  const reveals = proof.reveals.length * (4 + 7 * 32 + SIGNATURE_BYTES + PUBLIC_KEY_BYTES);
  return { total, reveals, stark: total - reveals };
}
