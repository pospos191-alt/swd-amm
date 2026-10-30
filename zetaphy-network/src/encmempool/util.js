// Byte helpers shared by the encrypted-mempool prototype (src/encmempool/*):
// fixed-width big-endian encoders, a tiny Writer/Reader for the wire formats,
// domain-separated hashing and a deterministic random source for tests and the
// simulation. No secrets are kept here.

import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';

export const utf8 = (s) => new TextEncoder().encode(s);
export const hex = (b) => Buffer.from(b).toString('hex');

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

export function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; }
export function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
export function u64(n) {
  const v = BigInt(n);
  if (v < 0n || v >= 2n ** 64n) throw new Error('u64 out of range');
  const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v); return b;
}

/** sha256(tag || 0x00 || parts...): every hash in the scheme has its own tag. */
export const tagHash = (tag, ...parts) => sha256(concat(utf8(`${tag}\0`), ...parts));

export class Writer {
  constructor() { this.parts = []; }
  bytes(b) { this.parts.push(Uint8Array.from(b)); return this; }
  u8(n) { if (n < 0 || n > 255) throw new Error('u8 out of range'); this.parts.push(Uint8Array.of(n)); return this; }
  u16(n) { this.parts.push(u16(n)); return this; }
  u32(n) { this.parts.push(u32(n)); return this; }
  u64(n) { this.parts.push(u64(n)); return this; }
  str(s) { const b = utf8(s); this.u8(b.length); return this.bytes(b); }
  varbytes(b) { this.u32(b.length); return this.bytes(b); }
  finish() { return concat(...this.parts); }
}

export class Reader {
  constructor(buf) { this.buf = buf; this.o = 0; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  need(n) { if (this.o + n > this.buf.length) throw new Error('truncated'); }
  bytes(n) { this.need(n); const b = this.buf.subarray(this.o, this.o + n); this.o += n; return b; }
  u8() { this.need(1); return this.buf[this.o++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.o); this.o += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.o); this.o += 4; return v; }
  u64() { this.need(8); const v = this.dv.getBigUint64(this.o); this.o += 8; return v; }
  str() { return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(this.u8())); }
  varbytes(max = Infinity) { const n = this.u32(); if (n > max) throw new Error('field too large'); return this.bytes(n); }
  done() { if (this.o !== this.buf.length) throw new Error('trailing bytes'); }
}

/** Operating-system randomness: rng(n) → n bytes. */
export const systemRandom = (n) => new Uint8Array(randomBytes(n));

/**
 * Deterministic byte stream sha256(seed || counter) for tests and the
 * simulation only (never for real keys): the same seed gives the same run.
 */
export function drbg(seed) {
  const s = typeof seed === 'string' ? utf8(seed) : Uint8Array.from(seed);
  let counter = 0n;
  let pool = new Uint8Array(0);
  return (n) => {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      if (pool.length === 0) pool = tagHash('zetaphy/encmempool-drbg', s, u64(counter++));
      const take = Math.min(pool.length, n - o);
      out.set(pool.subarray(0, take), o);
      pool = pool.subarray(take);
      o += take;
    }
    return out;
  };
}
