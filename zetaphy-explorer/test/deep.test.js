// Unit tests of the tx page's deep view and the contract card, checked against
// ethers where it can: the ABI codec (abi.js), the signature tables (sigs.js,
// sigdb.js, the generated known-abi.js), contract recognition and proxies
// (contract.js), and the tx analysis (txdeep.js): input / log / revert decoding,
// the call tree, balance changes, gas and fee split, summary and risk flags.
//   node --test test/deep.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, id as ethId, getAddress, MaxUint256, keccak256 } from 'ethers';
import {
  parseSignature, parseCompact, toCompact, fromJsonAbi, decodeParams, encodeParams, encodeCall, decodeCall, decodeEvent, decodeRevert,
  parseInput, canonicalType, valueText, PANIC_CODES,
} from '../src/abi.js';
import { COMMON } from '../src/sigs.js';
import { makeSigDb, codeConstants } from '../src/sigdb.js';
import { KNOWN } from '../src/known-abi.js';
import { SLOTS, slotAddress, readProxy, readSourcify, contractResolver, mergeAbi, readFunction, readable, writable } from '../src/contract.js';
import {
  decodeInput, decodeLogWith, decodeRevertWith, flattenCalls, nativeFlows, netNative, balanceChanges, tokenDeltas, gasInfo, summarize,
  approvalsInLogs, threatTargets, isUnsupported, receiptTransfers, FEE_BURN_BPS, APPROVAL_TOPIC,
} from '../src/txdeep.js';
import { parseZeta } from '../src/contractview.js';
import { T } from '../src/i18n.js';

const coder = AbiCoder.defaultAbiCoder();
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const A = '0x' + '11'.repeat(20); const B = '0x' + '22'.repeat(20); const C = '0x' + '33'.repeat(20); const D = '0x' + '44'.repeat(20);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const topicAddr = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const db = makeSigDb(KNOWN);
const ROUTER_ART = JSON.parse(readFileSync(new URL('../../zetaphy-dex/artifacts/ZetaphyRouter.json', import.meta.url), 'utf8'));
const DEX = JSON.parse(readFileSync(new URL('../../zetaphy-dex/web/deployments.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- abi.js

test('abi: human-readable signatures, canonical types and selectors match ethers', () => {
  const s = parseSignature('swap((address a,uint b)[] legs, bytes32[2] salt, int amount)');
  assert.equal(s.name, 'swap');
  assert.deepEqual(s.inputs.map(canonicalType), ['(address,uint256)[]', 'bytes32[2]', 'int256']);
  assert.deepEqual(s.inputs.map((p) => p.name), ['legs', 'salt', 'amount']);
  for (const list of [COMMON.functions]) {
    for (const c of list) {
      const f = parseCompact('function', c);
      const frag = new Interface([`function ${f.signature.replace(/^(\w+)/, '$1')}`]).fragments[0];
      assert.equal('0x' + f.selector, frag.selector, c);
      assert.equal(parseCompact('function', toCompact(f)).signature, f.signature, 'compact round trip');
    }
  }
  for (const c of COMMON.events) assert.equal(parseCompact('event', c).topic, ethId(parseCompact('event', c).signature), c);
  const ev = parseCompact('event', 'Transfer(address indexed from,address indexed to,uint256 value)');
  assert.equal(ev.topic, ethId('Transfer(address,address,uint256)'));
  assert.deepEqual(ev.inputs.map((p) => !!p.indexed), [true, true, false]);
  assert.throws(() => parseSignature('bad(uint7 x)'));
  assert.throws(() => parseSignature('bad((uint256)'));
});

test('abi: decodeParams / encodeParams agree with ethers on nested and dynamic types', () => {
  const types = ['uint8', 'int256', 'address', 'bool', 'bytes32', 'bytes', 'string', 'uint256[]', 'string[]', 'tuple(address,uint256[],string)[]', 'bytes4[2]', 'int24[]'];
  const values = [255, -12345678901234567890n, getAddress(A), true, '0x' + 'ab'.repeat(32), '0x0102030405', 'สวัสดี ZETAPHY', [1n, 2n, 3n], ['a', '', 'ccc'],
    [[getAddress(B), [7n], 'x'], [getAddress(C), [], 'yy']], ['0x01020304', '0xaabbccdd'], [-5n, 8388607n]];
  const encoded = coder.encode(types, values);
  const params = parseSignature(`f(${['uint8', 'int256', 'address', 'bool', 'bytes32', 'bytes', 'string', 'uint256[]', 'string[]', '(address,uint256[],string)[]', 'bytes4[2]', 'int24[]'].join(',')})`).inputs;
  const out = decodeParams(params, encoded);
  assert.equal(out[0], 255n); assert.equal(out[1], -12345678901234567890n); assert.equal(out[2], getAddress(A)); assert.equal(out[3], true);
  assert.equal(out[5], '0x0102030405'); assert.equal(out[6], 'สวัสดี ZETAPHY'); assert.deepEqual(out[7], [1n, 2n, 3n]); assert.deepEqual(out[8], ['a', '', 'ccc']);
  assert.deepEqual(out[9], [[getAddress(B), [7n], 'x'], [getAddress(C), [], 'yy']]);
  assert.deepEqual(out[10], ['0x01020304', '0xaabbccdd']); assert.deepEqual(out[11], [-5n, 8388607n]);
  assert.equal(encodeParams(params, out), encoded, 're-encodes to the same bytes');
  // strict mode refuses dirty words; lenient mode reads them
  const dirty = '0x' + 'ff'.repeat(12) + 'aa'.repeat(20);
  assert.throws(() => decodeParams([{ type: 'address', name: '' }], dirty));
  assert.equal(decodeParams([{ type: 'address', name: '' }], dirty, { strict: false })[0], getAddress('0x' + 'aa'.repeat(20)));
  assert.throws(() => decodeParams([{ type: 'bool', name: '' }], '0x' + word(2)));
  assert.throws(() => decodeParams([{ type: 'uint8', name: '' }], '0x' + word(256)));
  // bounds: a huge offset or length never reads outside the data
  assert.throws(() => decodeParams([{ type: 'bytes', name: '' }], '0x' + word(2n ** 200n)));
  assert.throws(() => decodeParams([{ type: 'uint256[]', name: '' }], '0x' + word(32) + word(10_000_000)));
  assert.throws(() => decodeParams([{ type: 'uint256', name: '' }], '0x1234'));
});

test('abi: calls, events and fromJsonAbi against ethers Interface', () => {
  const iface = new Interface(ROUTER_ART.abi);
  const data = iface.encodeFunctionData('swapExactETHForTokens', [5n, [getAddress(A), getAddress(B)], getAddress(C), 1700000000n]);
  const abi = fromJsonAbi(ROUTER_ART.abi);
  const f = abi.functions.find((x) => x.name === 'swapExactETHForTokens');
  assert.equal(f.mutability, 'payable');
  assert.deepEqual(decodeCall(f, data, { canonical: true }), [5n, [getAddress(A), getAddress(B)], getAddress(C), 1700000000n]);
  assert.equal(encodeCall(f, [5n, [A, B], C, 1700000000n]), data);
  assert.throws(() => decodeCall(f, '0xdeadbeef' + data.slice(10)));
  assert.throws(() => decodeCall(f, data + '00', { canonical: true }), 'trailing byte: not canonical');
  assert.equal(abi.errors.length, ROUTER_ART.abi.filter((e) => e.type === 'error').length);
  // events: indexed values from topics, a hashed indexed string
  const ei = new Interface(['event Named(address indexed who, string indexed tag, uint256 amount, string note)']);
  const log = ei.encodeEventLog('Named', [getAddress(A), 'hello', 42n, 'note ✓']);
  const ev = fromJsonAbi(ei.formatJson() && JSON.parse(ei.formatJson())).events[0];
  const vals = decodeEvent(ev, { topics: log.topics, data: log.data }, { canonical: true });
  assert.equal(vals[0], getAddress(A)); assert.deepEqual(vals[1], { hashed: ethId('hello') }); assert.equal(vals[2], 42n); assert.equal(vals[3], 'note ✓');
  assert.match(valueText(vals[1]), /^keccak 0x/);
  assert.throws(() => decodeEvent(ev, { topics: log.topics.slice(0, 2), data: log.data }), 'wrong topic count');
  // untrusted JSON: bad entries skipped, never guessed
  const weird = fromJsonAbi([{ type: 'function', name: 'ok', inputs: [{ type: 'uint' }], outputs: [] }, { type: 'function', name: 'bad', inputs: [{ type: 'uint7' }] },
    { type: 'function', name: '<img>', inputs: [] }, { type: 'event', name: 'E', inputs: [{ type: 'tuple', components: 'x' }] }, null, 'x']);
  assert.deepEqual(weird.functions.map((x) => x.signature), ['ok(uint256)']);
  assert.equal(weird.events.length, 0);
  assert.deepEqual(fromJsonAbi('nope'), { functions: [], events: [], errors: [] });
});

test('abi: revert data: Error(string), Panic(uint256) with its meaning, custom errors, empty, raw', () => {
  const err = '0x08c379a0' + coder.encode(['string'], ['Router: EXPIRED']).slice(2);
  assert.deepEqual(decodeRevert(err), { kind: 'error', message: 'Router: EXPIRED' });
  const panic = (c) => decodeRevert('0x4e487b71' + word(c));
  assert.deepEqual(panic(0x11), { kind: 'panic', code: 0x11, key: 'panic11' });
  assert.equal(panic(0x12).key, 'panic12'); assert.equal(panic(0x32).key, 'panic32'); assert.equal(panic(0x99).key, 'panicUnknown');
  for (const k of [...Object.values(PANIC_CODES), 'panicUnknown']) assert.ok(T.en[k] && T.th[k], k);
  assert.deepEqual(decodeRevert('0x'), { kind: 'empty' });
  assert.equal(decodeRevert('0x12345678').kind, 'raw');
  // a custom error from the router's ABI, and the same through the tables
  const iface = new Interface(ROUTER_ART.abi);
  const data = iface.encodeErrorResult('InsufficientOutputAmount', []);
  const abi = fromJsonAbi(ROUTER_ART.abi);
  const r = decodeRevert(data, (sel) => abi.errors.filter((e) => e.selector === sel).map((fragment) => ({ fragment, source: 'verified' })));
  assert.equal(r.kind, 'custom'); assert.equal(r.fragment.name, 'InsufficientOutputAmount'); assert.equal(r.source, 'verified');
  const c = decodeRevertWith(new Interface(['error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)']).encodeErrorResult('ERC20InsufficientBalance', [A, 1n, 2n]), null, db);
  assert.equal(c.kind, 'custom'); assert.equal(c.source, 'guessed'); assert.deepEqual(c.values, [getAddress(A), 1n, 2n]);
});

test('abi: form input parsing (numbers, addresses incl. zetaphy1, bools, bytes, lists, tuples)', () => {
  const p = (type) => parseSignature(`f(${type} x)`).inputs[0];
  assert.equal(parseInput(p('uint256'), ' 1000 '), 1000n);
  assert.equal(parseInput(p('uint256'), '0x10'), 16n);
  assert.throws(() => parseInput(p('uint8'), '256'));
  assert.throws(() => parseInput(p('uint256'), '-1'));
  assert.equal(parseInput(p('int8'), '-128'), -128n);
  assert.equal(parseInput(p('address'), 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r'), '0x6DA134EbFcb035273E87954f0641bD920ED073Ba');
  assert.throws(() => parseInput(p('address'), '0x1234'));
  assert.equal(parseInput(p('bool'), 'true'), true); assert.throws(() => parseInput(p('bool'), 'yes'));
  assert.equal(parseInput(p('bytes4'), '0xA9059CBB'), '0xa9059cbb'); assert.throws(() => parseInput(p('bytes4'), '0xa9'));
  assert.deepEqual(parseInput(p('address[]'), `["${A}", "${B}"]`), [getAddress(A), getAddress(B)]);
  assert.deepEqual(parseInput(p('(address,uint256)'), `["${A}", "5"]`), [getAddress(A), 5n]);
  assert.throws(() => parseInput(p('uint256[2]'), '["1"]'));
  assert.equal(parseZeta('1.5'), 15n * 10n ** 17n); assert.equal(parseZeta(''), 0n); assert.throws(() => parseZeta('1e5')); assert.throws(() => parseZeta('0.0000000000000000001'));
});

// ---------------------------------------------------------------- sigdb.js and the generated table

test('known-abi.js: generated from the repo artifacts with keys that match their signatures; npm run build wrote it', () => {
  assert.ok(read('src/known-abi.js').startsWith('// Generated by `npm run build`'));
  assert.ok(KNOWN.contracts.length > 50 && KNOWN.functions.length > 500);
  for (const [k, s] of KNOWN.functions.slice(0, 200)) assert.equal(parseCompact('function', s).selector, k, s);
  for (const [k, s] of KNOWN.events.slice(0, 100)) assert.equal(parseCompact('event', s).topic.slice(2, 18), k, s);
  for (const [k, s] of KNOWN.errors.slice(0, 100)) assert.equal(parseCompact('error', s).selector, k, s);
  assert.equal(KNOWN.addresses[DEX.contracts.router.toLowerCase()][1], 'ZETAPHY Swap');
  assert.equal(KNOWN.contracts[KNOWN.addresses[DEX.contracts.router.toLowerCase()][0]].name, 'ZetaphyRouter');
  assert.ok(!read('src/known-abi.js').includes('"bytecode"'), 'no bytecode shipped');
});

test('sigdb: lookups by selector / topic, repo contracts recognised by address, code hash, fp1 and selectors', () => {
  assert.equal(db.functions('a9059cbb')[0].fragment.signature, 'transfer(address,uint256)');
  const transfers = db.events(ethId('Transfer(address,address,uint256)'));
  assert.ok(transfers.length >= 2, 'ERC-20 and ERC-721 forms (indexed differ)');
  assert.equal(db.errors('e450d38c')[0]?.fragment.name, 'ERC20InsufficientBalance');
  const code = ROUTER_ART.deployedBytecode;
  assert.equal(db.recognise(DEX.contracts.router, code).matchedBy, 'address');
  assert.equal(db.recognise(A, code).matchedBy, 'codeHash');
  assert.equal(db.recognise(A, code).contract.name, 'ZetaphyRouter');
  // the deployed copy has its immutables filled in: not the same bytes, the same fp1 fingerprint
  const zeroPush32 = '7f' + '00'.repeat(32);
  assert.ok(code.includes(zeroPush32), 'the artifact has an immutable placeholder');
  const deployed = code.replace(zeroPush32, '7f' + '00'.repeat(12) + 'ab'.repeat(20));
  const r = db.recognise(A, deployed);
  assert.equal(r.matchedBy, 'fp1'); assert.equal(r.contract.name, 'ZetaphyRouter');
  assert.ok(r.contract.abi.functions.some((f) => f.name === 'swapExactETHForTokens'));
  // a dispatcher that holds every selector of a known contract: a guess by selectors
  const sels = KNOWN.contracts.find((c) => c.name === 'ZetaphyRouter').f.map((i) => KNOWN.functions[i][0]);
  const fake = '0x' + sels.map((s) => '63' + s + '14').join('') + '00';
  assert.equal(db.recognise(A, fake).matchedBy, 'selectors');
  assert.equal(db.recognise(A, '0x'), null);
  // functions and events of an unknown contract from its PUSH4 / PUSH32 constants
  const g = db.guessAbi('0x63a9059cbb147f' + ethId('Approval(address,address,uint256)').slice(2) + '00');
  assert.ok(g.functions.some((f) => f.signature === 'transfer(address,uint256)'));
  assert.ok(g.events.some((e) => e.name === 'Approval'));
  const cc = codeConstants('0x6001630a0b0c0d60ff');
  assert.deepEqual([...cc.push4], ['0a0b0c0d']);
  assert.deepEqual([...codeConstants('0x7f63a9059cbb').push4], [], 'push data is skipped, not read as opcodes');
});

// ---------------------------------------------------------------- contract.js

test('contract: EIP-1967 slots, slot words, proxies (1967, beacon, 1167) read from the node', async () => {
  assert.equal(SLOTS.implementation, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
  assert.equal(SLOTS.admin, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103');
  assert.equal(SLOTS.beacon, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50');
  assert.equal(slotAddress('0x' + word(BigInt(A))), A); assert.equal(slotAddress('0x' + word(0)), null);
  assert.equal(slotAddress('0x' + 'ff'.repeat(32)), null); assert.equal(slotAddress('nope'), null); assert.equal(slotAddress('0x1'), '0x' + '0'.repeat(39) + '1', 'a compact answer is padded');
  const store = (map) => async (m, p) => {
    if (m === 'eth_getStorageAt') return '0x' + word(map[p[1]] ?? 0);
    if (m === 'eth_call') return '0x' + word(map.beaconImpl ?? 0);
    throw new Error(m);
  };
  assert.deepEqual(await readProxy(store({ [SLOTS.implementation]: BigInt(B), [SLOTS.admin]: BigInt(C) }), A, '0x6080'),
    { kind: 'eip1967', implementation: B, admin: C, beacon: null });
  assert.deepEqual(await readProxy(store({ [SLOTS.beacon]: BigInt(D), beaconImpl: BigInt(B) }), A, '0x6080'), { kind: 'beacon', implementation: B, admin: null, beacon: D });
  assert.equal(await readProxy(store({}), A, '0x6080'), null);
  assert.equal(await readProxy(store({}), A, '0x'), null);
  const clone = `0x363d3d373d3d3d363d73${'be'.repeat(20)}5af43d82803e903d91602b57fd5bf3`;
  assert.deepEqual(await readProxy(() => { throw new Error('not asked'); }, A, clone), { kind: 'eip1167', implementation: '0x' + 'be'.repeat(20), admin: null, beacon: null });
  // unreadable slots count as empty
  assert.equal(await readProxy(async () => { throw new Error('pruned'); }, A, '0x6080'), null);
});

test('contract: Sourcify v2 answers read defensively; resolver: verified, known, proxy with the implementation\'s ABI', async () => {
  const body = { match: 'exact_match', abi: ROUTER_ART.abi, compilation: { name: 'ZetaphyRouter', language: 'Solidity', compilerVersion: '0.8.28+commit.7893614a' },
    sources: { 'contracts/ZetaphyRouter.sol': { content: 'contract ZetaphyRouter {}' }, 'b‮.sol': { content: 'x' } },
    deployment: { transactionHash: '0x' + 'ab'.repeat(32), blockNumber: '12', deployer: getAddress(D) } };
  const s = readSourcify(body);
  assert.equal(s.match, 'full'); assert.equal(s.name, 'ZetaphyRouter'); assert.equal(s.compiler, '0.8.28+commit.7893614a');
  assert.deepEqual(s.files.map((f) => f.path), ['b.sol', 'contracts/ZetaphyRouter.sol']); // bidi override removed
  assert.deepEqual(s.deployment, { txHash: '0x' + 'ab'.repeat(32), block: '12', deployer: getAddress(D) });
  assert.equal(readSourcify({ match: 'match', abi: 'x', deployment: { transactionHash: 'evil' } }).match, 'partial');
  assert.equal(readSourcify({ match: 'match', deployment: { transactionHash: 'evil' } }).deployment, null);
  assert.equal(readSourcify({}), null);

  const PROXY = '0x' + '99'.repeat(20); const IMPL = '0x' + '88'.repeat(20);
  const codes = { [A]: '0x6080604052', [PROXY]: '0x60806040526000', [IMPL]: ROUTER_ART.deployedBytecode, [B]: '0x' };
  const evm = async (m, p) => {
    if (m === 'eth_getCode') return codes[p[0]] ?? '0x';
    if (m === 'eth_getStorageAt') return '0x' + word(p[0] === PROXY && p[1] === SLOTS.implementation ? BigInt(IMPL) : 0);
    throw new Error(m);
  };
  const fetched = [];
  const fetchFn = async (url) => {
    fetched.push(url);
    if (url.includes(A.slice(2))) return { status: 200, ok: true, json: async () => body };
    return { status: 404, ok: false, json: async () => ({}) };
  };
  const r = contractResolver({ evm, fetchFn, known: () => KNOWN });
  const a = await r.resolve(A);
  assert.equal(a.source, 'verified'); assert.equal(a.name, 'ZetaphyRouter'); assert.ok(a.fullAbi.functions.length > 10);
  assert.match(fetched[0], /^https:\/\/sourcify\.dev\/server\/v2\/contract\/77390\/0x1111/);
  const p = await r.resolve(PROXY);
  assert.equal(p.proxy.kind, 'eip1967'); assert.equal(p.impl.source, 'known'); assert.equal(p.impl.matchedBy, 'codeHash');
  assert.equal(p.source, 'known', 'a proxy without its own ABI takes its implementation\'s');
  assert.ok(readable(p.fullAbi).some((f) => f.name === 'factory')); assert.ok(writable(p.fullAbi).some((f) => f.name === 'swapExactETHForTokens'));
  const eoa = await r.resolve(B);
  assert.equal(eoa.isContract, false); assert.equal(eoa.source, null);
  assert.equal(await r.resolve(A), a, 'cached');
  // Sourcify down: said, not taken as "not verified"
  const r2 = contractResolver({ evm, fetchFn: async () => { throw new Error('offline'); }, known: () => KNOWN });
  const x = await r2.resolve(IMPL);
  assert.equal(x.sourcifyError, 'offline'); assert.equal(x.source, 'known');
  // merge keeps the first on a clash
  const m = mergeAbi({ functions: [parseCompact('function', 'v|a()|(uint256)')] }, { functions: [parseCompact('function', 'v|a()|(uint256)'), parseCompact('function', 'v|b()|(uint256)')] });
  assert.deepEqual(m.functions.map((f) => f.name), ['a', 'b']);
});

test('contract: readFunction decodes results and keeps revert data', async () => {
  const f = parseCompact('function', 'v|getReserves()|(uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)');
  const ok = await readFunction(async () => coder.encode(['uint112', 'uint112', 'uint32'], [5n, 6n, 7n]), A, f, []);
  assert.deepEqual(ok.values, [5n, 6n, 7n]);
  const bad = await readFunction(async () => { throw new Error('eth_call: 0x08c379a0' + coder.encode(['string'], ['nope']).slice(2)); }, A, f, []);
  assert.equal(decodeRevert(bad.revert).message, 'nope');
});

// ---------------------------------------------------------------- txdeep.js

test('txdeep: input decoded as verified / known / guessed / unknown, guesses must be canonical', () => {
  const verified = { source: 'verified', abi: fromJsonAbi(ROUTER_ART.abi) };
  verified.fullAbi = verified.abi;
  const data = new Interface(ROUTER_ART.abi).encodeFunctionData('swapExactETHForTokens', [1n, [A, B], C, 9n]);
  const d = decodeInput(data, verified, db);
  assert.equal(d.kind, 'decoded'); assert.equal(d.source, 'verified'); assert.equal(d.fragment.name, 'swapExactETHForTokens'); assert.equal(d.viaProxy, false);
  // a proxy: the implementation's ABI, marked "via proxy"
  const proxy = { source: 'known', abi: null, impl: { source: 'known', abi: verified.abi }, fullAbi: verified.abi };
  assert.equal(decodeInput(data, proxy, db).viaProxy, true);
  assert.equal(decodeInput(data, proxy, db).source, 'known');
  const g = decodeInput('0xa9059cbb' + word(BigInt(A)) + word(5), null, db);
  assert.equal(g.source, 'guessed'); assert.equal(g.fragment.signature, 'transfer(address,uint256)'); assert.deepEqual(g.values, [getAddress(A), 5n]);
  assert.equal(decodeInput('0xa9059cbb' + word(BigInt(A)) + word(5) + 'ff', null, db).kind, 'unknown', 'extra bytes: no guess');
  assert.equal(decodeInput('0xa9059cbb' + 'ff'.repeat(12) + 'aa'.repeat(20) + word(5), null, db).kind, 'unknown', 'dirty address: no guess');
  assert.deepEqual(decodeInput('0x', null, db), { kind: 'none' });
  assert.equal(decodeInput('0x1234', null, db).kind, 'short');
  assert.deepEqual(decodeInput('0xdeadbeef', null, db), { kind: 'unknown', selector: '0xdeadbeef' });
});

test('txdeep: logs decoded with the emitter\'s ABI or the tables (ERC-20 vs ERC-721 Transfer told apart)', () => {
  const t = ethId('Transfer(address,address,uint256)');
  const erc20 = decodeLogWith({ address: A, topics: [t, topicAddr(B), topicAddr(C)], data: '0x' + word(7) }, null, db);
  assert.equal(erc20.source, 'guessed'); assert.deepEqual(erc20.values, [getAddress(B), getAddress(C), 7n]); assert.equal(erc20.fragment.inputs[2].indexed, undefined);
  const nft = decodeLogWith({ address: A, topics: [t, topicAddr(B), topicAddr(C), '0x' + word(9)], data: '0x' }, null, db);
  assert.deepEqual(nft.values, [getAddress(B), getAddress(C), 9n]); assert.equal(nft.fragment.inputs[2].indexed, true);
  const swept = new Interface(ROUTER_ART.abi);
  const ev = swept.getEvent('Swept');
  const log = swept.encodeEventLog(ev, ev.inputs.map((i) => (i.type === 'address' ? A : 3n)));
  const verified = { source: 'verified', abi: fromJsonAbi(ROUTER_ART.abi) }; verified.fullAbi = verified.abi;
  assert.equal(decodeLogWith({ address: A, ...log }, verified, db).source, 'verified');
  assert.equal(decodeLogWith({ address: A, topics: ['0x' + 'ee'.repeat(32)], data: '0x' }, null, db), null);
  assert.equal(decodeLogWith({ address: A, topics: [], data: '0x' }, null, db), null);
});

test('txdeep: call tree from callTracer, value moved only by calls that were not undone', () => {
  const root = { type: 'CALL', from: A, to: B, value: '0x64', gas: '0x5208', gasUsed: '0x5000', input: '0x7ff36ab5', calls: [
    { type: 'DELEGATECALL', from: B, to: C, value: '0x5', input: '0x' },
    { type: 'CALL', from: B, to: D, value: '0x0a', input: '0x', calls: [{ type: 'CALL', from: D, to: A, value: '0x03' }] },
    { type: 'CALL', from: B, to: C, value: '0x07', error: 'execution reverted', calls: [{ type: 'CALL', from: C, to: A, value: '0x01' }] },
    { type: 'STATICCALL', from: B, to: C, input: '0x0902f1ac' },
  ] };
  const { calls, truncated } = flattenCalls(root);
  assert.equal(truncated, false);
  assert.deepEqual(calls.map((c) => [c.id, c.depth, c.type, c.reverted]), [
    ['0', 0, 'CALL', false], ['0.0', 1, 'DELEGATECALL', false], ['0.1', 1, 'CALL', false], ['0.1.0', 2, 'CALL', false],
    ['0.2', 1, 'CALL', true], ['0.2.0', 2, 'CALL', true], ['0.3', 1, 'STATICCALL', false]]);
  assert.equal(calls[0].value, 100n); assert.equal(calls[0].gasUsed, 0x5000n); assert.equal(calls[4].error, 'execution reverted');
  const flows = nativeFlows(calls);
  assert.deepEqual(flows.map((f) => [f.from, f.to, f.value]), [[A, B, 100n], [B, D, 10n], [D, A, 3n]]);
  const net = netNative(flows);
  assert.equal(net.get(A), -97n); assert.equal(net.get(B), 90n); assert.equal(net.get(D), 7n);
  assert.equal(flattenCalls(root, { max: 3 }).truncated, true);
  assert.deepEqual(flattenCalls(null).calls, []);
  assert.ok(isUnsupported({ code: -32601, message: 'the method debug_traceTransaction does not exist/is not available' }));
  assert.ok(isUnsupported({ message: 'debug namespace is disabled' }));
  assert.ok(!isUnsupported({ code: -32000, message: 'transaction not found in block' }));
});

test('txdeep: balance changes from the prestate diff and from token transfers', () => {
  const diff = { pre: { [A]: { balance: '0x64', nonce: 1 }, [B]: { balance: '0x0a' }, [C]: { balance: '0x05' } }, post: { [A]: { balance: '0x32', nonce: 2 }, [B]: { balance: '0x3c' }, [D]: { balance: '0x01' } } };
  assert.deepEqual(balanceChanges(diff).map((r) => [r.address, r.before, r.after, r.delta]), [
    [A, 100n, 50n, -50n], [C, 5n, 0n, -5n], [D, 0n, 1n, 1n], [B, 10n, 60n, 50n]]);
  assert.deepEqual(balanceChanges({ pre: { [A]: { balance: '0x1' } }, post: { [A]: { nonce: 3 } } }), [], 'unchanged balance not listed');
  assert.deepEqual(balanceChanges(null), []);
  const trs = [
    { standard: 'erc20', token: D, from: A, to: B, amount: 10n }, { standard: 'erc20', token: D, from: B, to: C, amount: 4n },
    { standard: 'erc721', token: C, from: '0x0000000000000000000000000000000000000000', to: A, tokenId: 7n, mint: true },
    { standard: 'erc1155', token: B, from: A, to: C, ids: [1n, 2n], amounts: [3n, 0n] },
  ];
  const rows = tokenDeltas(trs).map((r) => [r.holder, r.token, r.standard, r.id, r.delta]);
  assert.deepEqual(rows, [[A, D, 'erc20', null, -10n], [B, D, 'erc20', null, 6n], [C, D, 'erc20', null, 4n], [A, C, 'erc721', 7n, 1n], [A, B, 'erc1155', 1n, -3n], [C, B, 'erc1155', 1n, 3n]]);
});

test('txdeep: gas used %, effective price, fee, half burned, base fee and tip split', () => {
  const g = gasInfo({ gas: '0x249f0', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00' }, { gasUsed: '0xef32', effectiveGasPrice: '0x59682f00' }, { baseFeePerGas: '0x1dcd6500' });
  assert.equal(g.used, 61234n); assert.equal(g.limit, 150000n); assert.equal(g.usedPct, 40.82);
  assert.equal(g.fee, 61234n * 1500000000n); assert.equal(g.burned, g.fee / 2n); assert.equal(g.toValidators, g.fee - g.burned);
  assert.equal(g.baseCost, 61234n * 500000000n); assert.equal(g.tip, 61234n * 1000000000n); assert.equal(g.baseCost + g.tip, g.fee);
  assert.equal(FEE_BURN_BPS, 5000n);
  const legacy = gasInfo({ gas: '0x5208', gasPrice: '0x3b9aca00' }, { gasUsed: '0x5208' }, null);
  assert.equal(legacy.usedPct, 100); assert.equal(legacy.baseFee, null); assert.equal(legacy.tip, null); assert.equal(legacy.fee, 21000n * 10n ** 9n);
});

test('txdeep: summary in plain words and risk flags', () => {
  const ok = { status: '0x1', logs: [] };
  const tx = (o) => ({ from: A, to: B, value: '0x0', input: '0x', ...o });
  const transferLog = (token, from, to, v) => ({ address: token, topics: [ethId('Transfer(address,address,uint256)'), topicAddr(from), topicAddr(to)], data: '0x' + word(v) });
  // unlimited approval
  const appr = '0x095ea7b3' + word(BigInt(C)) + MaxUint256.toString(16);
  let s = summarize({ tx: tx({ input: appr }), rc: ok, input: decodeInput(appr, null, db) });
  assert.equal(s.key, 'sumApproveUnlimited'); assert.equal(s.vars.spender, C); assert.equal(s.vars.token, B);
  assert.deepEqual(s.risks, [{ key: 'riskUnlimited', vars: { spender: C, token: B } }]);
  const small = '0x095ea7b3' + word(BigInt(C)) + word(1000);
  s = summarize({ tx: tx({ input: small }), rc: ok, input: decodeInput(small, null, db) });
  assert.equal(s.key, 'sumApprove'); assert.deepEqual(s.vars.asset, { kind: 'erc20', token: B, value: 1000n }); assert.deepEqual(s.risks, []);
  // setApprovalForAll(true / false)
  const all = '0xa22cb465' + word(BigInt(C)) + word(1);
  s = summarize({ tx: tx({ input: all }), rc: ok, input: decodeInput(all, null, db) });
  assert.equal(s.key, 'sumApproveAll'); assert.equal(s.risks[0].key, 'riskApproveAll');
  assert.equal(summarize({ tx: tx({ input: all.slice(0, -1) + '0' }), rc: ok }).key, 'sumRevokeAll');
  // a swap: 10 ZETAPHY in (native value), 1,234 tokens out to the sender, through a labelled router
  const swapRc = { status: '0x1', logs: [transferLog(D, C, A, 1234n)] };
  s = summarize({ tx: tx({ value: '0x0a', input: '0x7ff36ab5' }), rc: swapRc, input: { kind: 'decoded', fragment: { name: 'swapExactETHForTokens' } }, transfers: receiptTransfers(swapRc), native: netNative([{ from: A, to: B, value: 10n }]), label: 'ZETAPHY Swap' });
  assert.equal(s.key, 'sumSwapOn'); assert.deepEqual(s.vars.a, { kind: 'native', token: undefined, value: 10n }); assert.deepEqual(s.vars.b, { kind: 'erc20', token: D, value: 1234n }); assert.equal(s.vars.on, 'ZETAPHY Swap');
  // token for token, no label
  const t2t = { status: '0x1', logs: [transferLog(C, A, B, 5n), transferLog(D, B, A, 6n)] };
  s = summarize({ tx: tx({ input: '0x38ed1739' }), rc: t2t, input: { kind: 'unknown', selector: '0x38ed1739' }, transfers: receiptTransfers(t2t) });
  assert.equal(s.key, 'sumSwap'); assert.equal(s.vars.a.token, C); assert.equal(s.vars.b.token, D);
  // an ERC-20 transfer() call
  const tr = '0xa9059cbb' + word(BigInt(C)) + word(77);
  const trRc = { status: '0x1', logs: [transferLog(B, A, C, 77n)] };
  s = summarize({ tx: tx({ input: tr }), rc: trRc, input: decodeInput(tr, null, db), transfers: receiptTransfers(trRc) });
  assert.equal(s.key, 'sumToken'); assert.deepEqual(s.vars.asset, { kind: 'erc20', token: B, value: 77n }); assert.equal(s.vars.to, C);
  // NFTs sent
  const nft = [{ standard: 'erc721', token: D, from: A, to: C, tokenId: 1n }, { standard: 'erc1155', token: D, from: A, to: C, ids: [2n], amounts: [4n] }];
  s = summarize({ tx: tx({ input: '0x12345678' }), rc: ok, input: { kind: 'unknown', selector: '0x12345678' }, transfers: nft });
  assert.equal(s.key, 'sumNft'); assert.equal(s.vars.n, '5'); assert.equal(s.vars.to, C);
  // plain send, failure, contract creation, a generic call
  assert.equal(summarize({ tx: tx({ value: '0x5' }), rc: ok, input: { kind: 'none' } }).key, 'sumSend');
  assert.equal(summarize({ tx: tx({ input: tr }), rc: { status: '0x0', logs: [] }, input: decodeInput(tr, null, db) }).key, 'sumFailedFn');
  assert.equal(summarize({ tx: tx({ to: null, input: '0x6080' }), rc: { status: '0x1', contractAddress: getAddress(D), logs: [] } }).vars.contract, D);
  assert.equal(summarize({ tx: tx({ input: '0xd0e30db0', value: '0x1' }), rc: ok, input: decodeInput('0xd0e30db0', null, db) }).key, 'sumCallValue');
  assert.equal(summarize({ tx: tx({ input: '0xdeadbeef' }), rc: ok, input: decodeInput('0xdeadbeef', null, db) }).key, 'sumCallRaw');
  // an unlimited approval inside a multicall shows up through its Approval log
  const mc = { status: '0x1', logs: [{ address: D, topics: [APPROVAL_TOPIC, topicAddr(A), topicAddr(C)], data: '0x' + MaxUint256.toString(16) }] };
  assert.deepEqual(approvalsInLogs(mc.logs, A), [{ token: D, spender: C, unlimited: true }]);
  assert.equal(approvalsInLogs(mc.logs, B).length, 0, 'only the sender\'s own approvals');
  s = summarize({ tx: tx({ input: '0xac9650d8' }), rc: mc, input: { kind: 'unknown', selector: '0xac9650d8' } });
  assert.deepEqual(s.risks, [{ key: 'riskUnlimited', vars: { spender: C, token: D } }]);
  assert.deepEqual(threatTargets(tx({}), s.risks), [B, C]);
});

test('i18n: every key the tx and contract views use exists in all 8 languages, with the placeholders the summary fills', () => {
  const src = read('src/txview.js') + read('src/contractview.js');
  const used = new Set([...src.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  for (const k of ['srcVerified', 'srcKnown', 'srcGuessed', 'srcVerifiedHelp', 'srcKnownHelp', 'srcGuessedHelp', 'riskUnlimited', 'riskApproveAll', 'riskThreat',
    ...['address', 'codeHash', 'fp1', 'selectors'].map((x) => `xcMatched_${x}`), ...['eip1967', 'eip1167', 'beacon'].map((x) => `xcProxy_${x}`)]) used.add(k);
  for (const m of read('src/txdeep.js').matchAll(/'(sum[A-Z][A-Za-z]+)'/g)) used.add(m[1]);
  for (const lang of Object.keys(T)) for (const k of used) assert.ok(typeof T[lang][k] === 'string' && T[lang][k].trim(), `${lang}.${k}`);
  // the summary's variables cover every placeholder of its sentence
  const vars = { sumSwapOn: ['from', 'a', 'b', 'on'], sumApproveUnlimited: ['from', 'spender', 'token'], sumToken: ['from', 'asset', 'to'], sumNft: ['from', 'n', 'to'] };
  for (const [k, v] of Object.entries(vars)) for (const lang of Object.keys(T)) assert.deepEqual((T[lang][k].match(/\{\w+\}/g) ?? []).map((x) => x.slice(1, -1)).sort(), [...v].sort(), `${lang}.${k}`);
  const all = JSON.stringify(T).toLowerCase();
  for (const w of ['scam', 'fraud', 'หลอกลวง', 'มิจฉาชีพ']) assert.ok(!all.includes(w), w);
});

test('security: the new views build DOM with text only, Sourcify is the only new host', () => {
  for (const f of ['src/abi.js', 'src/sigdb.js', 'src/contract.js', 'src/txdeep.js', 'src/txview.js', 'src/contractview.js']) {
    const s = read(f);
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!s.includes(sink), `${f} uses ${sink}`);
    const hosts = [...s.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    for (const h of hosts) assert.ok(['sourcify.dev', 'repo.sourcify.dev'].includes(h), `${f} talks to ${h}`);
  }
  assert.ok(read('src/contractview.js').includes('view.textContent = f.content'), 'source files shown as text');
  assert.equal(keccak256('0x'), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});
