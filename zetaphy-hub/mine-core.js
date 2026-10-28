// The faucet proof of work (a captcha for the testnet faucet, not mining a coin), shared by the
// page (mine.js), its Web Worker (mine-worker.js) and the tests. The node checks the same thing
// in zetaphy_faucetPow (evmd/zetaphy_rpc.go):
//
//   sha256( chainId (8 bytes, big-endian) || blockHash (32) || address (20) || nonce (8, big-endian) )
//   must start with at least `bits` zero bits.
//
// 68 bytes are two SHA-256 blocks. The first 64 bytes (everything up to the nonce's high 4 bytes)
// stay the same while a worker counts the low 4 bytes, so their state is computed once and each
// try costs one compression of the second block.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** One SHA-256 compression of the 16 words in w[0..15] (w has room for 64) into state s (8 words), in place. */
function compress(s, w) {
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15], b = w[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
  s[4] = (s[4] + e) | 0; s[5] = (s[5] + f) | 0; s[6] = (s[6] + g) | 0; s[7] = (s[7] + h) | 0;
}

const word = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) | 0;

/** SHA-256 of any bytes (for checks and tests; the search uses the midstate below). */
export function sha256(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const bits = len * 8;
  const n = padded.length;
  padded[n - 4] = (bits >>> 24) & 0xff; padded[n - 3] = (bits >>> 16) & 0xff; padded[n - 2] = (bits >>> 8) & 0xff; padded[n - 1] = bits & 0xff;
  padded[n - 5] = Math.floor(bits / 2 ** 32) & 0xff;
  const s = new Int32Array(IV), w = new Int32Array(64);
  for (let off = 0; off < n; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = word(padded, off + i * 4);
    compress(s, w);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[i * 4] = s[i] >>> 24; out[i * 4 + 1] = (s[i] >>> 16) & 0xff; out[i * 4 + 2] = (s[i] >>> 8) & 0xff; out[i * 4 + 3] = s[i] & 0xff; }
  return out;
}

/** Leading zero bits of a hash (bytes). */
export function zeroBits(hash) {
  let n = 0;
  for (const b of hash) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

const hexBytes = (hex, len) => {
  const h = String(hex).replace(/^0x/, '');
  if (!new RegExp(`^[0-9a-fA-F]{${len * 2}}$`).test(h)) throw new Error(`expected ${len} bytes of hex`);
  return Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
};

/** The 60 fixed bytes: chainId || blockHash || address. */
export function powPrefix(chainId, blockHash, address) {
  const out = new Uint8Array(60);
  let c = BigInt(chainId);
  for (let i = 7; i >= 0; i--) { out[i] = Number(c & 0xffn); c >>= 8n; }
  out.set(hexBytes(blockHash, 32), 8);
  out.set(hexBytes(address, 20), 40);
  return out;
}

/** The 8-byte nonce (hi, lo: unsigned 32-bit) as the node takes it: 0x + 16 hex digits. */
export const nonceHex = (hi, lo) => `0x${(hi >>> 0).toString(16).padStart(8, '0')}${(lo >>> 0).toString(16).padStart(8, '0')}`;

/** The full 68-byte message of a proof. */
export function powMessage(prefix, hi, lo) {
  const m = new Uint8Array(68);
  m.set(prefix);
  const v = new DataView(m.buffer);
  v.setUint32(60, hi >>> 0); v.setUint32(64, lo >>> 0);
  return m;
}

/** Does this proof hold (the node's check, in JS)? */
export const powOk = (prefix, hi, lo, bits) => zeroBits(sha256(powMessage(prefix, hi, lo))) >= bits;

/**
 * Searches lo = from, from+1, … (at most `count` tries) for a proof with the nonce's high word `hi`.
 * Returns the lo that works, or -1. `bits` from 1 to 64.
 */
export function search(prefix, hi, bits, from, count) {
  // state after the first block (prefix + the nonce's high 4 bytes)
  const mid = new Int32Array(IV), w = new Int32Array(64);
  const first = new Uint8Array(64);
  first.set(prefix);
  new DataView(first.buffer).setUint32(60, hi >>> 0);
  for (let i = 0; i < 16; i++) w[i] = word(first, i * 4);
  compress(mid, w);
  const s = new Int32Array(8);
  const mask0 = bits >= 32 ? -1 : bits === 0 ? 0 : (~0 << (32 - bits)) | 0;
  const mask1 = bits <= 32 ? 0 : bits >= 64 ? -1 : (~0 << (64 - bits)) | 0;
  const end = Math.min(from + count, 2 ** 32);
  for (let lo = from; lo < end; lo++) {
    // second block: lo, the 0x80 pad, zeros, the length (68 * 8 = 544 bits)
    w[0] = lo | 0; w[1] = 0x80000000 | 0;
    for (let i = 2; i < 15; i++) w[i] = 0;
    w[15] = 544;
    s.set(mid);
    compress(s, w);
    if ((s[0] & mask0) === 0 && (s[1] & mask1) === 0) return lo;
  }
  return -1;
}

/** Expected tries for `bits` zero bits: 2^bits. */
export const expectedTries = (bits) => 2 ** bits;
