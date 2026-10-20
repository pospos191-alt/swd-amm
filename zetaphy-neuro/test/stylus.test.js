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

// A real (tiny) WASM module, brotli-compressed the way cargo-stylus stores
// it: 0xEFF000 + dictionary byte 0x00 + brotli(wasm).
import { brotliCompressSync } from 'node:zlib';
import { scanWasm } from '../src/stylus.js';

const leb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const sleb = (n) => { // n as a signed 32-bit integer
  n |= 0; const out = [];
  for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { out.push(b); return out; } out.push(b | 0x80); }
};
const name = (s) => [...leb(s.length), ...Buffer.from(s)];
const section = (id, body) => [id, ...leb(body.length), ...body];
/** imports: vm_hooks functions; consts: 32-bit values used with i32.const in the body. */
function stylusWasm(imports, consts) {
  const type = section(1, [1, 0x60, 0, 0]);
  const imp = section(2, [...leb(imports.length), ...imports.flatMap((n) => [...name('vm_hooks'), ...name(n), 0, 0])]);
  const func = section(3, [1, 0]);
  const exp = section(7, [1, ...name('user_entrypoint'), 0, imports.length]);
  const body = [0, ...consts.flatMap((c) => [0x41, ...sleb(c), 0x1a]), 0x0b];
  const code = section(10, [1, ...leb(body.length), ...body]);
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...imp, ...func, ...exp, ...code]);
}
const swap = (n) => Buffer.from(n.toString(16).padStart(8, '0'), 'hex').readUInt32LE(0);
const packed = (wasm, dict = '00') => '0xeff000' + dict + brotliCompressSync(wasm).toString('hex');

test('Stylus WASM is unpacked and read: selectors in either byte order, host imports', async () => {
  // transfer + balanceOf (ERC-20), mint(address,uint256) as-is, pause() byte-swapped
  const wasm = stylusWasm(['read_args', 'delegate_call_contract'], [0xa9059cbb, 0x70a08231, 0x40c10f19, swap(0x8456cb59), 7, -1]);
  assert.deepEqual(scanWasm(wasm).imports, ['vm_hooks::read_args', 'vm_hooks::delegate_call_contract']);
  const rpc = fakeEvm(packed(wasm), {
    '0x06fdde03': abiString('Rusty Coin'), '0x95d89b41': abiString('RUST'),
    '0x313ce567': '0x' + word('12'), '0x18160ddd': '0x' + word('3e8'), '0x8da5cb5b': '0x' + word(OWNER.slice(2)),
  });
  const r = await readContract('arbitrum', ADDR, { rpc });
  assert.equal(r.format, 'stylus');
  assert.equal(r.stylus.wasmSize, wasm.length);
  assert.deepEqual(r.functions, ['balanceOf(address)', 'mint(address,uint256)', 'pause()', 'transfer(address,uint256)']);
  for (const id of ['stylus-read', 'erc20', 'owner-active', 'can-mint', 'can-pause', 'delegatecall']) assert.ok(ids(r).includes(id), id);
  assert.ok(!ids(r).includes('stylus-code'));
  assert.equal(r.analysis.level, 'high');
  const lines = explain(r, 'en').lines;
  assert.match(lines[0].text, /Stylus contract.*found 4 known function/);
  assert.match(lines[1].text, /Rusty Coin/);
});

test('Stylus code that cannot be unpacked stays "unreadable"', async () => {
  const wasm = stylusWasm([], [0x40c10f19]);
  const dict = await readContract('arbitrum', ADDR, { rpc: fakeEvm(packed(wasm, '01')) });
  assert.ok(ids(dict).includes('stylus-code'), 'compressed against a dictionary');
  const plainWasm = await readContract('arbitrum', ADDR, { rpc: fakeEvm('0xeff00000' + Buffer.from('not brotli').toString('hex')) });
  assert.ok(ids(plainWasm).includes('stylus-code'));
});
