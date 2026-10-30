'use strict';
// node --test scripts/vendor/bigint-buffer/test.js : the pure-JS bigint-buffer drop-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { toBigIntLE, toBigIntBE, toBufferLE, toBufferBE } = require('./index.js');

test('round trips for the widths @solana/buffer-layout-utils uses (u64, u128, u192, u256)', () => {
  for (const w of [8, 16, 24, 32]) {
    const max = (1n << BigInt(8 * w)) - 1n;
    for (const v of [0n, 1n, 255n, 256n, 0x0102030405060708n, max >> 1n, max]) {
      assert.equal(toBigIntLE(toBufferLE(v, w)), v);
      assert.equal(toBigIntBE(toBufferBE(v, w)), v);
      assert.equal(toBufferLE(v, w).length, w);
    }
  }
});

test('byte order, empty and odd-length buffers', () => {
  assert.equal(toBigIntLE(Buffer.from([1, 2])), 0x0201n);
  assert.equal(toBigIntBE(Buffer.from([1, 2])), 0x0102n);
  assert.equal(toBigIntLE(Buffer.alloc(0)), 0n);
  assert.equal(toBigIntBE(Buffer.alloc(0)), 0n);
  assert.equal(toBigIntLE(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 2])), (2n << 64n) | 1n);
  assert.deepEqual([...toBufferLE(0x0102n, 4)], [2, 1, 0, 0]);
  assert.deepEqual([...toBufferBE(0x0102n, 4)], [0, 0, 1, 2]);
});

test('the advisory input (GHSA-3gc7-fjrx-p6mg): any length, any view, no out-of-bounds read', () => {
  const big = Buffer.alloc(4096, 0xff);
  assert.equal(toBigIntLE(big), (1n << 32768n) - 1n);
  const view = new Uint8Array(new ArrayBuffer(16), 3, 5).fill(1);
  assert.equal(toBigIntLE(view), 0x0101010101n);
  const src = Buffer.from([9, 8, 7]);
  toBigIntLE(src);
  assert.deepEqual([...src], [9, 8, 7], 'the input is not modified');
  assert.throws(() => toBigIntLE('00'), TypeError);
  assert.throws(() => toBufferLE(1n, -1), RangeError);
});

test('a value wider than the width keeps its low bytes (as the native addon did)', () => {
  assert.deepEqual([...toBufferLE(0x010203n, 2)], [3, 2]);
  assert.deepEqual([...toBufferBE(0x010203n, 2)], [2, 3]);
});
