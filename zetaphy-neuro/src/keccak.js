// Keccak-256 (the Ethereum hash), small and dependency-free so the web page
// can turn a verified ABI's function signatures into 4-byte selectors.
// test/sourcify.test.js checks it against @noble/hashes.

const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000], [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000], [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

// Lane i is (lo = s[2i], hi = s[2i+1]).
function rotl(lo, hi, n) {
  if (n === 0) return [lo, hi];
  if (n >= 32) { [lo, hi] = [hi, lo]; n -= 32; }
  if (n === 0) return [lo, hi];
  return [((lo << n) | (hi >>> (32 - n))) >>> 0, ((hi << n) | (lo >>> (32 - n))) >>> 0];
}

function keccakF(s) {
  const c = new Uint32Array(10);
  const b = new Uint32Array(50);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      c[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const [rl, rh] = rotl(c[2 * ((x + 1) % 5)], c[2 * ((x + 1) % 5) + 1], 1);
      const dl = c[2 * ((x + 4) % 5)] ^ rl;
      const dh = c[2 * ((x + 4) % 5) + 1] ^ rh;
      for (let y = 0; y < 25; y += 5) { s[2 * (x + y)] ^= dl; s[2 * (x + y) + 1] ^= dh; }
    }
    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        const [l, h] = rotl(s[2 * i], s[2 * i + 1], ROT[i]);
        b[2 * j] = l; b[2 * j + 1] = h;
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = y + x; const i1 = y + ((x + 1) % 5); const i2 = y + ((x + 2) % 5);
        s[2 * i] = b[2 * i] ^ (~b[2 * i1] & b[2 * i2]);
        s[2 * i + 1] = b[2 * i + 1] ^ (~b[2 * i1 + 1] & b[2 * i2 + 1]);
      }
    }
    // iota
    s[0] ^= RC[round][0]; s[1] ^= RC[round][1];
  }
}

/** Keccak-256 of bytes -> 32 bytes. */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Uint32Array(50);
  const dv = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 4; i++) s[i] ^= dv.getUint32(off + 4 * i, true);
    keccakF(s);
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, s[i], true);
  return out;
}

/** "transfer(address,uint256)" -> "a9059cbb" */
export function selectorOf(sig) {
  const h = keccak256(new TextEncoder().encode(sig));
  return Array.from(h.subarray(0, 4), (x) => x.toString(16).padStart(2, '0')).join('');
}
