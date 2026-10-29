// Seeded deterministic PRNG (xoshiro128**, seeded by splitmix32): the same
// generator as tests-10k/lib/rng.mjs, copied so ml/ stands alone.

function splitmix32(a) {
  return () => {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15; t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0);
  };
}

/** A string seed -> 32-bit number (FNV-1a). */
export function seedOf(text) {
  let h = 0x811c9dc5;
  for (const c of String(text)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

export function rng(seed) {
  const sm = splitmix32(typeof seed === 'string' ? seedOf(seed) : seed);
  let a = sm(), b = sm(), c = sm(), d = sm();
  const u32 = () => {
    const t = b << 9; let r = Math.imul(b, 5); r = Math.imul((r << 7) | (r >>> 25), 9);
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return r >>> 0;
  };
  const R = {
    u32,
    float: () => u32() / 4294967296,
    /** integer in [0, n) */
    int: (n) => (n <= 0 ? 0 : Math.floor((u32() / 4294967296) * n)),
    /** integer in [lo, hi] */
    range: (lo, hi) => lo + Math.floor((u32() / 4294967296) * (hi - lo + 1)),
    bool: (p = 0.5) => u32() / 4294967296 < p,
    pick: (arr) => arr[Math.floor((u32() / 4294967296) * arr.length)],
    /** random BigInt of up to `bits` bits */
    big: (bits) => {
      let v = 0n;
      for (let i = 0; i < Math.ceil(bits / 32); i++) v = (v << 32n) | BigInt(u32());
      return v & ((1n << BigInt(bits)) - 1n);
    },
    /** BigInt in [0, n) */
    below: (n) => {
      if (n <= 0n) return 0n;
      const bits = n.toString(2).length + 16;
      return R.big(bits) % n;
    },
    /** a positive BigInt whose size is spread over many magnitudes: [1, 2^maxBits) */
    spread: (maxBits) => {
      const bits = 1 + R.int(maxBits);
      return R.big(bits) | (1n << BigInt(bits - 1));
    },
    bytes: (n) => { const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = u32() & 0xff; return out; },
    hex: (nBytes) => Array.from(R.bytes(nBytes), (b) => b.toString(16).padStart(2, '0')).join(''),
    shuffle: (arr) => { const x = [...arr]; for (let i = x.length - 1; i > 0; i--) { const j = R.int(i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; },
    /** a random string of `n` characters from `alphabet` */
    str: (n, alphabet) => { const chars = [...alphabet]; let s = ''; for (let i = 0; i < n; i++) s += chars[Math.floor((u32() / 4294967296) * chars.length)]; return s; },
  };
  return R;
}

