import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeString, decodeAddress, decodeUint, cleanText } from '../src/abi.js';

const w = (h) => h.padStart(64, '0');

test('decodes ABI string', () => {
  const hello = Buffer.from('Hello').toString('hex');
  const hex = '0x' + w('20') + w('5') + hello.padEnd(64, '0');
  assert.equal(decodeString(hex), 'Hello');
});

test('decodes bytes32 string (old tokens)', () => {
  const mkr = Buffer.from('MKR').toString('hex').padEnd(64, '0');
  assert.equal(decodeString('0x' + mkr), 'MKR');
});

test('rejects malformed string lengths', () => {
  assert.equal(decodeString('0x' + w('20') + w('ffff')), null);
  assert.equal(decodeString('0x'), null);
});

test('address and uint', () => {
  assert.equal(decodeAddress('0x' + w('abcdef0000000000000000000000000000000001')), '0xabcdef0000000000000000000000000000000001');
  assert.equal(decodeUint('0x' + w('ff')), 255n);
  assert.equal(decodeUint('0x'), null);
});

test('cleanText strips control and bidi-override characters and caps length', () => {
  assert.equal(cleanText('‮CLAIM\u0000'), 'CLAIM');
  assert.equal(cleanText('x'.repeat(100), 10), 'xxxxxxxxxx…');
  assert.equal(cleanText(null), null);
});
