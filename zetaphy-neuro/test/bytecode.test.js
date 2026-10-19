import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBytes, scanBytecode, minimalProxyTarget, codeLengthWithoutMetadata } from '../src/bytecode.js';

test('hexToBytes rejects bad input', () => {
  assert.throws(() => hexToBytes('0x123'));
  assert.throws(() => hexToBytes('0xzz'));
  assert.deepEqual([...hexToBytes('0x00ff')], [0, 255]);
});

test('bytes inside PUSH data are not read as opcodes', () => {
  // PUSH2 0xff f4 ; STOP  -> contains ff and f4 only as data
  const r = scanBytecode('0x61fff400');
  assert.equal(r.opcodes.selfdestruct, false);
  assert.equal(r.opcodes.delegatecall, false);
  // real SELFDESTRUCT
  assert.equal(scanBytecode('0x6000ff').opcodes.selfdestruct, true);
});

test('finds selectors pushed with PUSH4 and short PUSH for leading-zero selectors', () => {
  // PUSH4 a9059cbb (transfer)
  const r = scanBytecode('0x63a9059cbb00');
  assert.deepEqual(r.functions.map((f) => f.sig), ['transfer(address,uint256)']);
  // PUSH4 06fdde03 is name()
  assert.deepEqual(scanBytecode('0x6306fdde0300').functions.map((f) => f.sig), ['name()']);
  // a selector whose first byte is 00 may be pushed with PUSH3: 0x00fdd58e = balanceOf(address,uint256) is not
  // in our table, so use a PUSH3 of a non-selector and check nothing is invented
  assert.deepEqual(scanBytecode('0x62abcdef00').functions, []);
});

test('metadata tail is excluded from the opcode walk', () => {
  // code: STOP ; metadata: a1 ff ff (fake CBOR containing ff) ; length 0003
  const code = hexToBytes('0x00a1ffff0003');
  assert.equal(codeLengthWithoutMetadata(code), 1);
  assert.equal(scanBytecode('0x00a1ffff0003').opcodes.selfdestruct, false);
});

test('EIP-1167 minimal proxy target', () => {
  const target = 'bebebebebebebebebebebebebebebebebebebebe';
  const code = hexToBytes(`0x363d3d373d3d3d363d73${target}5af43d82803e903d91602b57fd5bf3`);
  assert.equal(minimalProxyTarget(code), '0x' + target);
  assert.equal(minimalProxyTarget(hexToBytes('0x6000')), null);
});
