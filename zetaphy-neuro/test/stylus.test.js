// Code that is not EVM bytecode: Arbitrum Stylus (Rust/C compiled to WASM,
// stored behind the 0xEFF000 prefix) and EIP-7702 delegated wallets
// (0xEF0100 + target address). Neither may be scanned as EVM opcodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { explain } from '../src/explain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);
const ADDR = '0x' + '42'.repeat(20);
const OWNER = '0x' + '0b'.repeat(20);

const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const abiString = (s) => {
  const b = Buffer.from(s);
  return '0x' + word('20') + word(b.length.toString(16)) + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0');
};

function fakeEvm(code, calls = {}) {
  const seen = [];
  return {
    seen,
    async call(method, params) {
      seen.push(method);
      if (method === 'eth_getCode') return code;
      if (method === 'eth_getStorageAt') return '0x' + '0'.repeat(64);
      if (method === 'eth_call') {
        const r = calls[params[0].data];
        if (!r) throw new Error('execution reverted');
        return r;
      }
      throw new Error(method);
    },
  };
}

// A Stylus program: prefix + (pretend) brotli-compressed WASM. The bytes after
// the prefix contain 0xff (SELFDESTRUCT) and 0x63 (PUSH4) that must be ignored.
const STYLUS = '0xeff00000' + 'ff63a9059cbb14ff'.repeat(40);

test('Stylus contract: token data via ABI, powers reported as unreadable', async () => {
  const rpc = fakeEvm(STYLUS, {
    '0x06fdde03': abiString('Rusty Coin'), '0x95d89b41': abiString('RUST'),
    '0x313ce567': '0x' + word('12'), '0x18160ddd': '0x' + word('3e8'), '0x8da5cb5b': '0x' + word(OWNER.slice(2)),
  });
  const r = await readContract('arbitrum', ADDR, { rpc });
  assert.equal(r.format, 'stylus');
  assert.deepEqual(ids(r), ['erc20', 'stylus-code', 'owner-active', 'bytecode-only']);
  assert.equal(find(r, 'stylus-code').severity, 'medium');
  assert.ok(!ids(r).includes('selfdestruct'), 'WASM bytes are not EVM opcodes');
  assert.equal(r.owner, OWNER);
  assert.equal(r.analysis.level, 'medium');
  assert.match(explain(r, 'th').lines[0].text, /Rusty Coin/);
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'stylus-code').text, /Rust/);
});

test('Stylus with no token functions and no owner still reads cleanly', async () => {
  const r = await readContract('arbitrum', ADDR, { rpc: fakeEvm(STYLUS) });
  assert.deepEqual(ids(r), ['stylus-code', 'bytecode-only']);
});

test('other 0xEF formats are not scanned as EVM either', async () => {
  const r = await readContract('eth', ADDR, { rpc: fakeEvm('0xef0001010004' + 'ff'.repeat(20)) });
  assert.equal(r.format, 'eof');
  assert.ok(ids(r).includes('unknown-code-format'));
});

test('EIP-7702 wallet: shows which contract it runs', async () => {
  const target = '0x' + 'ab'.repeat(20);
  const rpc = fakeEvm('0xef0100' + target.slice(2));
  const r = await readContract('bsc', ADDR, { rpc });
  assert.equal(r.delegation, target);
  assert.deepEqual(ids(r), ['eip7702', 'bytecode-only']);
  assert.deepEqual(rpc.seen, ['eth_getCode'], 'nothing else is called');
  assert.match(explain(r, 'en').lines[0].text, new RegExp(target));
});
