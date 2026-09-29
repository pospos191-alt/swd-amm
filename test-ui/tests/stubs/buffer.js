// Minimal stand-in for the `buffer` package, used ONLY by smoke.mjs (see
// stubs/web3.js). Enough for Buffer.from(string|array) in PDA seeds.
export class Buffer extends Uint8Array {
  static from(x, enc) {
    if (typeof x === "string") {
      if (enc === "hex") return Buffer.of(...(x.match(/../g) || []).map((h) => parseInt(h, 16)));
      return new Buffer(new TextEncoder().encode(x));
    }
    return new Buffer(Uint8Array.from(x));
  }
  static alloc(n) { return new Buffer(n); }
  static isBuffer(x) { return x instanceof Uint8Array; }
  static concat(list) { const out = new Buffer(list.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of list) { out.set(b, o); o += b.length; } return out; }
}
export default { Buffer };
