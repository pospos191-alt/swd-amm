// ZETAPHY Mesh: store-and-forward transport for signed things (docs/future/offline-cash.md, "Mesh").
// No dependencies and no network: the same file runs in Node (src/mesh/relay.js, `zetaphy mesh`) and in the
// hub (zetaphy-hub/mesh-frames.js is a byte-identical copy, checked by test/mesh.test.js).
//
// Packet (binary): "Z" 0x01 | type (1) | flags (1) | deadline (uint32 BE, unix seconds, 0 = none)
//                  | relayer fee hint (varint, wei; the binding fee is the one inside the signed payload)
//                  | payload length (varint) | payload
//   id = first 8 bytes of SHA-256(packet): the relay dedupes on it.
// Frame (binary):  0xB1 | packet id (first 4 bytes) | seq (uint16 BE) | total (uint16 BE) | chunk | CRC-16 (BE)
//   CRC-16/CCITT-FALSE over everything before it. 11 bytes of overhead per frame. After reassembly the
//   packet must hash to the 4-byte id (a frame from another packet with the same short id is dropped).
// Text:            "ZM" + base45(frame) with its space written as "_" (base45: RFC 9285; with that one swap every
//                  character is in the GSM 03.38 7-bit basic set and no frame contains whitespace, so a chat or SMS
//                  export can be pasted as is), or "zm" + base32(frame) (RFC 4648, lower case, no padding) for media
//                  that lose case or punctuation.
// Profiles: how big one frame may be on each medium (binary frame bytes, or text characters).

export const PACKET_MAGIC = 0x5a; // "Z"
export const PACKET_VERSION = 1;
export const FRAME_MAGIC = 0xb1;
export const FRAME_OVERHEAD = 11;
export const TEXT_PREFIX = 'ZM';
export const TEXT32_PREFIX = 'zm';
export const TYPES = { tx: 1, note: 2, cheque: 3, order: 4, proof: 5, swap: 6, redeem: 7, raw: 15 };
export const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
/** maxBytes: binary frame size; maxChars: text frame size (null = binary medium). */
export const PROFILES = {
  'sms-binary': { maxBytes: 140, maxChars: null, label: 'SMS, 8-bit binary (140 bytes)' },
  'sms-text': { maxBytes: null, maxChars: 160, label: 'SMS, 7-bit text (160 characters, base45)' },
  lora: { maxBytes: 200, maxChars: null, label: 'LoRa / Meshtastic binary port (~200 bytes)' },
  'lora-text': { maxBytes: null, maxChars: 200, label: 'LoRa / Meshtastic text message (200 characters, base45)' },
  qr: { maxBytes: null, maxChars: 1500, label: 'QR code (1,500 characters of base45 text)' },
  file: { maxBytes: 65_535 + FRAME_OVERHEAD, maxChars: null, label: 'File / Bluetooth / USB (one frame)' },
};
export const MAX_FRAMES = 65_535;

// ---------------------------------------------------------------- bytes

const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(String(s));
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('not hex');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
export const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Unsigned LEB128 of a BigInt-able value. */
export function varint(v) {
  let n = BigInt(v);
  if (n < 0n) throw new Error('varint: negative');
  const out = [];
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n);
  return Uint8Array.from(out);
}
/** [value (BigInt), next offset]. */
export function readVarint(buf, i) {
  let v = 0n;
  for (let shift = 0n; shift < 140n; shift += 7n) {
    if (i >= buf.length) throw new Error('truncated varint');
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if (b < 0x80) return [v, i];
  }
  throw new Error('varint too long');
}

// ---------------------------------------------------------------- SHA-256 (FIPS 180-4), synchronous

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256(data) {
  const msg = data instanceof Uint8Array ? data : utf8(data);
  const bitLen = BigInt(msg.length) * 8n;
  const padLen = ((msg.length + 9 + 63) >> 6) << 6;
  const p = new Uint8Array(padLen);
  p.set(msg); p[msg.length] = 0x80;
  const dv = new DataView(p.buffer);
  dv.setBigUint64(padLen - 8, bitLen);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padLen; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + 4 * t);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + W[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, H[i]);
  return out;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// ---------------------------------------------------------------- base45 (RFC 9285) and base32 (RFC 4648)

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
export function base45Encode(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let n = bytes[i] * 256 + bytes[i + 1];
    const c = n % 45; n = (n - c) / 45;
    const d = n % 45; const e = (n - d) / 45;
    s += B45[c] + B45[d] + B45[e];
  }
  if (bytes.length % 2) { const n = bytes[bytes.length - 1]; s += B45[n % 45] + B45[Math.floor(n / 45)]; }
  return s;
}
export function base45Decode(str) {
  const v = Array.from(String(str), (ch) => { const i = B45.indexOf(ch); if (i < 0) throw new Error('base45: bad character'); return i; });
  if (v.length % 3 === 1) throw new Error('base45: bad length');
  const out = [];
  for (let i = 0; i < v.length; i += 3) {
    if (i + 2 < v.length) {
      const n = v[i] + v[i + 1] * 45 + v[i + 2] * 2025;
      if (n > 0xffff) throw new Error('base45: out of range');
      out.push(n >> 8, n & 0xff);
    } else {
      const n = v[i] + v[i + 1] * 45;
      if (n > 0xff) throw new Error('base45: out of range');
      out.push(n);
    }
  }
  return Uint8Array.from(out);
}
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32Encode(bytes) {
  let s = '', bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { s += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits) s += B32[(acc << (5 - bits)) & 31];
  return s;
}
export function base32Decode(str) {
  const out = [];
  let bits = 0, acc = 0;
  for (const ch of String(str).toLowerCase().replace(/=+$/, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('base32: bad character');
    acc = (acc << 5) | i; bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 0xff); bits -= 8; acc &= (1 << bits) - 1; }
  }
  if (acc) throw new Error('base32: non-zero padding bits');
  return Uint8Array.from(out);
}
/** Bytes that fit in `chars` characters of base45 (3 chars per 2 bytes, 2 for a last odd byte). */
export const base45Capacity = (chars) => Math.floor(chars / 3) * 2 + (chars % 3 === 2 ? 1 : 0);

// ---------------------------------------------------------------- packets

/** { type: name or number, payload: Uint8Array, deadline?: unix seconds, fee?: wei hint, flags? } -> bytes. */
export function encodePacket({ type, payload, deadline = 0, fee = 0n, flags = 0 }) {
  const t = typeof type === 'number' ? type : TYPES[type];
  if (!Number.isInteger(t) || t < 1 || t > 255) throw new Error(`packet: unknown type ${type}`);
  if (!(payload instanceof Uint8Array)) throw new Error('packet: payload must be bytes');
  const d = Number(deadline);
  if (!Number.isInteger(d) || d < 0 || d > 0xffffffff) throw new Error('packet: deadline must be unix seconds (uint32)');
  const head = new Uint8Array(8);
  head[0] = PACKET_MAGIC; head[1] = PACKET_VERSION; head[2] = t; head[3] = flags & 0xff;
  new DataView(head.buffer).setUint32(4, d);
  return concat(head, varint(fee), varint(payload.length), payload);
}
export function decodePacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) throw new Error('packet: too short');
  if (bytes[0] !== PACKET_MAGIC || bytes[1] !== PACKET_VERSION) throw new Error('packet: not a ZETAPHY Mesh packet');
  const deadline = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(4);
  let [fee, i] = readVarint(bytes, 8);
  let len;
  [len, i] = readVarint(bytes, i);
  if (BigInt(bytes.length - i) !== len) throw new Error('packet: length mismatch');
  return { type: TYPE_NAMES[bytes[2]] ?? bytes[2], typeCode: bytes[2], flags: bytes[3], deadline, fee, payload: bytes.subarray(i), id: packetId(bytes) };
}
/** The 8-byte packet id (hex) relays dedupe on. */
export const packetId = (packetBytes) => toHex(sha256(packetBytes).subarray(0, 8));

// ---------------------------------------------------------------- frames

/** The largest chunk a frame may carry for a profile (or explicit { maxBytes } / { maxChars }). */
export function chunkSize(profile) {
  const p = typeof profile === 'string' ? PROFILES[profile] : profile;
  if (!p) throw new Error(`unknown profile ${profile}`);
  const frameBytes = p.maxBytes ?? base45Capacity(p.maxChars - TEXT_PREFIX.length);
  const n = frameBytes - FRAME_OVERHEAD;
  if (n < 1) throw new Error('profile too small');
  return n;
}
/** Splits a packet into binary frames for a profile. */
export function toFrames(packetBytes, profile = 'lora') {
  const size = chunkSize(profile);
  const total = Math.max(1, Math.ceil(packetBytes.length / size));
  if (total > MAX_FRAMES) throw new Error(`packet needs ${total} frames (max ${MAX_FRAMES})`);
  const id = sha256(packetBytes).subarray(0, 4);
  const frames = [];
  for (let seq = 0; seq < total; seq++) {
    const chunk = packetBytes.subarray(seq * size, (seq + 1) * size);
    const head = new Uint8Array(9);
    head[0] = FRAME_MAGIC; head.set(id, 1);
    const dv = new DataView(head.buffer);
    dv.setUint16(5, seq); dv.setUint16(7, total);
    const body = concat(head, chunk);
    const crc = crc16(body);
    frames.push(concat(body, Uint8Array.of(crc >> 8, crc & 0xff)));
  }
  return frames;
}
/** Parses one binary frame: { id (hex, 4 bytes), seq, total, chunk } or throws (bad magic, length, CRC). */
export function parseFrame(f) {
  if (!(f instanceof Uint8Array) || f.length < FRAME_OVERHEAD) throw new Error('frame: too short');
  if (f[0] !== FRAME_MAGIC) throw new Error('frame: not a ZETAPHY Mesh frame');
  const crc = (f[f.length - 2] << 8) | f[f.length - 1];
  if (crc16(f.subarray(0, f.length - 2)) !== crc) throw new Error('frame: checksum mismatch');
  const dv = new DataView(f.buffer, f.byteOffset, f.length);
  const seq = dv.getUint16(5), total = dv.getUint16(7);
  if (total < 1 || seq >= total) throw new Error('frame: bad sequence number');
  return { id: toHex(f.subarray(1, 5)), seq, total, chunk: f.subarray(9, f.length - 2) };
}
export const frameToText = (f) => TEXT_PREFIX + base45Encode(f).replaceAll(' ', '_');
export const frameToText32 = (f) => TEXT32_PREFIX + base32Encode(f);
/** A frame from text: "ZM…" (base45) or "zm…" (base32); whitespace around it is ignored. */
export function textToFrame(t) {
  const s = String(t).trim();
  if (s.startsWith(TEXT_PREFIX)) return base45Decode(s.slice(TEXT_PREFIX.length).replaceAll('_', ' '));
  if (s.startsWith(TEXT32_PREFIX)) return base32Decode(s.slice(TEXT32_PREFIX.length));
  throw new Error('not a ZETAPHY Mesh frame (ZM… / zm…)');
}
/** Packet -> frames as text lines for a profile (base45 unless `base32`). */
export function toTextFrames(packetBytes, profile = 'sms-text', { base32 = false } = {}) {
  const p = typeof profile === 'string' ? PROFILES[profile] : profile;
  if (base32) {
    const size = Math.floor(((p.maxChars ?? 160) - TEXT32_PREFIX.length) * 5 / 8) - FRAME_OVERHEAD;
    return toFrames(packetBytes, { maxBytes: size + FRAME_OVERHEAD }).map(frameToText32);
  }
  return toFrames(packetBytes, p.maxChars ? p : { maxChars: 2 + Math.ceil(p.maxBytes * 3 / 2) }).map(frameToText);
}
/** Every "ZM…" / "zm…" token in a pasted text (lines, spaces, a chat export). */
export function framesInText(text) {
  return String(text).split(/[\s,;]+/).filter((w) => w.startsWith(TEXT_PREFIX) || w.startsWith(TEXT32_PREFIX));
}

/**
 * Reassembles packets from frames arriving in any order, from any medium, with duplicates and losses.
 * add(frame bytes | text) -> { status: 'partial' | 'complete' | 'duplicate' | 'done' | 'bad', id, have, total, packet? }.
 * A completed packet's id is remembered ('done' for any later frame of it: the multi-path copies).
 */
export class Reassembler {
  constructor({ maxPending = 64, maxAgeMs = 7 * 86400_000, now = () => Date.now() } = {}) {
    this.pending = new Map(); this.done = new Set(); this.maxPending = maxPending; this.maxAgeMs = maxAgeMs; this.now = now;
  }
  add(input) {
    let f;
    try { f = parseFrame(typeof input === 'string' ? textToFrame(input) : input); } catch (e) { return { status: 'bad', error: e.message }; }
    if (this.done.has(f.id)) return { status: 'done', id: f.id };
    let p = this.pending.get(f.id);
    if (p && p.total !== f.total) return { status: 'bad', id: f.id, error: 'frame: total differs from earlier frames' };
    if (!p) {
      this.gc();
      if (this.pending.size >= this.maxPending) this.pending.delete(this.pending.keys().next().value);
      p = { total: f.total, chunks: new Map(), at: this.now() };
      this.pending.set(f.id, p);
    }
    if (p.chunks.has(f.seq)) return { status: 'duplicate', id: f.id, have: p.chunks.size, total: p.total };
    p.chunks.set(f.seq, f.chunk);
    if (p.chunks.size < p.total) return { status: 'partial', id: f.id, have: p.chunks.size, total: p.total };
    const packet = concat(...Array.from({ length: p.total }, (_, i) => p.chunks.get(i)));
    this.pending.delete(f.id);
    if (toHex(sha256(packet).subarray(0, 4)) !== f.id) return { status: 'bad', id: f.id, error: 'frames do not hash to their packet id (mixed packets?)' };
    this.done.add(f.id);
    return { status: 'complete', id: f.id, have: p.total, total: p.total, packet };
  }
  /** Sequence numbers still missing for a pending packet. */
  missing(id) {
    const p = this.pending.get(id);
    return p ? Array.from({ length: p.total }, (_, i) => i).filter((i) => !p.chunks.has(i)) : [];
  }
  gc() { const t = this.now(); for (const [k, p] of this.pending) if (t - p.at > this.maxAgeMs) this.pending.delete(k); }
}

/** How many frames a packet of `bytes` needs on each profile: { profile: frames }. */
export function frameCounts(bytes) {
  return Object.fromEntries(Object.keys(PROFILES).map((k) => [k, Math.max(1, Math.ceil(bytes / chunkSize(k)))]));
}
