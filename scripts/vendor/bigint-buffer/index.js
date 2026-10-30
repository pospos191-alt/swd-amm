'use strict';
// Pure-JS drop-in for bigint-buffer@1.1.5 (Apache-2.0, https://github.com/no2chem/bigint-buffer).
//
// Why: bigint-buffer's native addon (src/bigint-buffer.c, toBigInt) has a buffer overflow,
// GHSA-3gc7-fjrx-p6mg, and the package has no fixed release. Our only users are
// @solana/buffer-layout-utils (via @solana/spl-token, in the Anchor test tooling), which call these
// four functions. The root package.json `resolutions` installs this file in its place, so no native
// code runs. The functions follow the package's own pure-JS fallback, with one correction: a value
// wider than `width` keeps its LOW bytes (as the native addon did), not its high ones.
// Tests: scripts/vendor/bigint-buffer/test.js (`node scripts/vendor/bigint-buffer/test.js`).

function asBuffer(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) throw new TypeError('bigint-buffer: expected a Buffer');
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Little-endian buffer -> BigInt. */
function toBigIntLE(buf) {
  const reversed = Buffer.from(asBuffer(buf)); // a copy: the caller's buffer is not touched
  reversed.reverse();
  const hex = reversed.toString('hex');
  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);
}

/** Big-endian buffer -> BigInt. */
function toBigIntBE(buf) {
  const hex = asBuffer(buf).toString('hex');
  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);
}

function width(w) {
  if (!Number.isSafeInteger(w) || w < 0) throw new RangeError('bigint-buffer: width must be a non-negative integer');
  return w;
}

/** BigInt -> big-endian buffer of `w` bytes (the magnitude, low `w` bytes kept). */
function toBufferBE(num, w) {
  w = width(w);
  let n = BigInt(num);
  if (n < 0n) n = -n; // the native addon wrote the magnitude
  const hex = n.toString(16).padStart(w * 2, '0');
  return Buffer.from(hex.slice(hex.length - w * 2), 'hex');
}

/** BigInt -> little-endian buffer of `w` bytes. */
function toBufferLE(num, w) {
  return toBufferBE(num, w).reverse();
}

module.exports = { toBigIntLE, toBigIntBE, toBufferLE, toBufferBE };
