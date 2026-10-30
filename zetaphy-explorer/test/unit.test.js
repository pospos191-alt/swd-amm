// Unit tests: decoders (Cosmos txs with ZETAPHY's messages, EVM raw txs, token
// Transfer events, ABI strings), formatters, config checks, the polite RPC
// queue/cache, ThreatRegistry reading, the recent-history scan, the i18n tables
// and static security checks of the source.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Wallet, Transaction, AbiCoder, id as ethId } from 'ethers';
import {
  encodeTxRaw, encodeTxBody, encodeAuthInfo, encodeMsgSend, encodeMsgEVMCall, encodeMsgQuantumLock, encodeAny, varint,
  ml_dsa44, keccak_256, bytesToHex, hexToBytes, sha256, addressKey, codeKey, codeHash, fingerprint1, THREAT_SEL, DETAIL_SEL,
} from '../vendor/zetaphy-lib.js';
import {
  safeText, tokenText, formatUnits, formatZtphy, formatCoin, percent, ago, utcTime, toAddress, toValoper, parseQuery, anyAddressLower,
  heightParam, fromBase64, toBase64, groupDigits, short, hexPreview,
} from '../src/format.js';
import { decodeTx, decodeMessage, TYPES, txAddresses, txLabel, logsFromEvents, normalizeEvents, splitAttestations, cometTxHash } from '../src/cosmos.js';
import { decodeTransfer, decodeAbiString, decodeUint, decodeRawEvmTx, rlpDecode, readTokenInfo, TOPICS, SEL, callData } from '../src/evm.js';
import { checkUrl, endpoints, isPlaceholder, sanitizeConfig, neuroLink, DEFAULTS } from '../src/config.js';
import { Limiter, LruCache, createApi, TTL } from '../src/rpc.js';
import { checkThreats } from '../src/threat.js';
import { chainApi } from '../src/chain.js';
import { T, makeT, LANGS, pickLang } from '../src/i18n.js';
import {
  eventQuery, addressQueries, HistoryMerger, kindOf, directionOf, transferDirection, matchesFilter, csvCell, toCsv, historyCsvRow, tokenCsvRow,
  HISTORY_CSV_HEADER, TOKEN_CSV_HEADER, LogScanner, KINDS,
} from '../src/history.js';
import { wsEndpoints, socketHost, cometSubscribe, parseCometWs, parseEvmWs, LiveFeed, pendingSummary, pendingSnapshot, txLanded } from '../src/live.js';
import { createWatchStore, createTxWatch, cleanNick, txHashParam, WATCH_KEY } from '../src/watch.js';
import { blockSeries, txsPerBlock, feeSeries, topAddresses, summary, bars } from '../src/charts.js';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const lenField = (f, b) => concat(varint((f << 3) | 2), varint(b.length), b);
const uintField = (f, v) => concat(varint(f << 3), varint(v));
const utf8 = (s) => new TextEncoder().encode(s);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');

// Known vector (zetaphy-network/test/pqtx.test.js): 0x6DA1…73Ba = zetaphy1dksnf6…
const HEX = '0x6DA134EbFcb035273E87954f0641bD920ED073Ba';
const BECH = 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r';
const OTHER = 'zetaphy1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3huramw'; // 0x1111…11
const VALOPER = 'zetaphyvaloper1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zfnr6v8'; // 0x2222…22

// ---------------- format ----------------

test('safeText removes control, bidi and zero-width characters and bounds the length', () => {
  assert.equal(safeText('Good‮token​⁦x⁩'), 'Goodtokenx');
  assert.equal(safeText('line1\nline2\r\n\tend\u0000\u0007'), 'line1 line2 end');
  assert.equal(safeText(' a b'), 'ab');
  assert.equal(safeText('x'.repeat(10), 4), 'xxxx…');
  assert.equal(safeText(null), '');
  assert.equal(safeText('ไทย 🚀'), 'ไทย 🚀'); // real text stays
  assert.equal(tokenText('‮​'), '?');
  assert.equal(tokenText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>'); // shown as text, never markup
});

test('formatUnits / formatZtphy / formatCoin', () => {
  assert.equal(formatUnits(1234567890000000000000n), '1,234.56789');
  assert.equal(formatUnits('1500000000000000000', 18, { maxFrac: 0 }), '1');
  assert.equal(formatUnits(1n, 18, { maxFrac: 18 }), '0.000000000000000001');
  assert.equal(formatUnits(1n, 18), '0');
  assert.equal(formatUnits(-25n, 1), '-2.5');
  assert.equal(formatUnits(123456789n, 0), '123,456,789');
  assert.equal(formatUnits('nope'), '?');
  assert.equal(formatZtphy(10n ** 18n * 2n), '2 ZETAPHY');
  assert.equal(formatCoin({ denom: 'azetaphy', amount: '500000000000000000' }), '0.5 ZETAPHY');
  assert.equal(formatCoin({ denom: 'ibc/AB‮CD', amount: '1000' }), '1,000 ibc/ABCD');
  assert.equal(groupDigits('-1234567'), '-1,234,567');
});

test('percent, short, ago, utcTime, hexPreview', () => {
  assert.equal(percent(2n, 3n), '66.7%');
  assert.equal(percent(1, 1), '100.0%');
  assert.equal(percent(0n, 0n), '0%');
  assert.equal(short('0x' + 'a'.repeat(40), 6, 4), '0xaaaa…aaaa');
  assert.equal(short('abc'), 'abc');
  const now = Date.parse('2026-10-21T00:10:00Z');
  assert.equal(ago('2026-10-21T00:09:55Z', now), '5 s ago');
  assert.equal(ago('2026-10-21T00:00:00Z', now, 'th'), '10 นาที ที่แล้ว');
  assert.equal(ago('2026-10-19T00:00:00Z', now), '2 d ago');
  assert.match(ago('2026-10-21T00:00:00Z', now, 'zh'), /10/); // Intl with the UI code as the locale
  assert.notEqual(ago('2026-10-21T00:00:00Z', now, 'ja'), '10 min ago');
  assert.equal(utcTime('2026-10-21T08:15:02.123456789Z'), '2026-10-21 08:15:02 UTC');
  assert.equal(utcTime(0), '1970-01-01 00:00:00 UTC');
  assert.equal(hexPreview(new Uint8Array(70), 2), '0x0000… (70 bytes)');
});

test('addresses: 0x and zetaphy1 are the same 20 bytes', () => {
  const a = toAddress(BECH); const b = toAddress(HEX.toLowerCase());
  assert.equal(a.hex, HEX); assert.equal(a.bech32, BECH); assert.deepEqual(a, b);
  assert.equal(toAddress('0x6da134ebfcb035273e87954f0641bd920ed073bA'), null); // bad EIP-55 checksum (mixed case)
  assert.equal(toAddress('zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9q'), null); // bad bech32 checksum
  assert.equal(toAddress('cosmos1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r'), null);
  const v = toValoper(VALOPER);
  assert.equal(v.account.hex, '0x' + '22'.repeat(20));
  assert.equal(anyAddressLower(VALOPER), '0x' + '22'.repeat(20));
  assert.equal(anyAddressLower(HEX), HEX.toLowerCase());
  assert.equal(anyAddressLower('not an address'), null);
});

test('parseQuery: block, tx hash, address, validator, invalid', () => {
  assert.deepEqual(parseQuery(' 42 '), { type: 'block', height: '42' });
  assert.deepEqual(parseQuery('#7'), { type: 'block', height: '7' });
  assert.equal(parseQuery('0').type, 'invalid');
  const h = 'AB'.repeat(32);
  assert.deepEqual(parseQuery(h), { type: 'hash', hash: h.toLowerCase(), evm: false });
  assert.deepEqual(parseQuery('0x' + h), { type: 'hash', hash: h.toLowerCase(), evm: true });
  assert.equal(parseQuery(BECH).address.hex, HEX);
  assert.equal(parseQuery(HEX.toLowerCase()).address.bech32, BECH);
  assert.equal(parseQuery(VALOPER.toUpperCase()).valoper, VALOPER);
  assert.equal(parseQuery('<script>').type, 'invalid');
  assert.equal(heightParam('12'), '12'); assert.equal(heightParam('1e3'), null); assert.equal(heightParam('0'), null);
  assert.deepEqual(fromBase64(toBase64(Uint8Array.of(0, 255, 7))), Uint8Array.of(0, 255, 7));
});

// ---------------- Cosmos tx decoding ----------------

const PUB = ml_dsa44.keygen(new Uint8Array(32).fill(1)).publicKey;

function cosmosTx(messages, { memo = '', fee = 400000n * 1000000000n } = {}) {
  return encodeTxRaw({
    bodyBytes: encodeTxBody({ messages, memo }),
    authInfoBytes: encodeAuthInfo({ signerInfos: [{ publicKey: PUB, sequence: 3n }], fee: { amount: [{ denom: 'azetaphy', amount: String(fee) }], gasLimit: 400000n } }),
    signatures: [new Uint8Array(2420)],
  });
}

test('decodeTx: MsgSend, MsgEVMCall (as owner), MsgQuantumLock with an ML-DSA-44 signer', () => {
  const bytes = cosmosTx([
    { typeUrl: TYPES.send, value: encodeMsgSend({ fromAddress: BECH, toAddress: OTHER, amount: [{ denom: 'azetaphy', amount: '1500000000000000000' }] }) },
    { typeUrl: TYPES.evmCall, value: encodeMsgEVMCall({ sender: BECH, to: '0x' + '33'.repeat(20), value: 5n, data: Uint8Array.of(0xa9, 0x05, 0x9c, 0xbb, 1), gasLimit: 200000n, asOwner: OTHER }) },
    { typeUrl: TYPES.quantumLock, value: encodeMsgQuantumLock({ signer: BECH, owner: OTHER, controller: BECH }) },
  ], { memo: 'hi‮there' });
  const d = decodeTx(bytes);
  assert.equal(d.error, undefined);
  assert.equal(d.hash, bytesToHex(sha256(bytes)).toUpperCase());
  assert.equal(d.hash, cometTxHash(bytes));
  assert.equal(d.memo, 'hi‮there'); // raw: the page shows it through safeText
  assert.equal(d.signers[0].pubKeyType, '/zetaphy.crypto.mldsa44.PubKey');
  assert.equal(d.signers[0].pubKeyLabel, 'ML-DSA-44 (post-quantum)');
  assert.equal(d.signers[0].pubKeyBytes, 1312);
  assert.equal(d.signers[0].sequence, 3n);
  assert.deepEqual(d.fee.amount, [{ denom: 'azetaphy', amount: '400000000000000' }]);
  assert.equal(d.fee.gasLimit, 400000n);
  const [send, call, lock] = d.messages;
  assert.equal(send.name, 'MsgSend');
  assert.deepEqual(send.fields.map((f) => [f.name, f.kind]), [['from', 'addr'], ['to', 'addr'], ['amount', 'coins']]);
  assert.deepEqual(send.fields[2].value, [{ denom: 'azetaphy', amount: '1500000000000000000' }]);
  assert.equal(call.name, 'MsgEVMCall'); assert.equal(call.zetaphy, true);
  const f = Object.fromEntries(call.fields.map((x) => [x.name, x.value]));
  assert.equal(f.sender, BECH); assert.equal(f.to, '0x' + '33'.repeat(20)); assert.equal(f.value, '5');
  assert.deepEqual(f.data, Uint8Array.of(0xa9, 0x05, 0x9c, 0xbb, 1)); assert.equal(f['gas limit'], 200000n); assert.equal(f['as owner'], OTHER);
  assert.equal(lock.name, 'MsgQuantumLock');
  assert.deepEqual(lock.fields.map((x) => x.value), [BECH, OTHER, BECH]);
  assert.equal(txLabel(d), 'MsgSend, MsgEVMCall, MsgQuantumLock');
  const addrs = txAddresses(d, anyAddressLower);
  assert.ok(addrs.has(HEX.toLowerCase()) && addrs.has('0x' + '11'.repeat(20)) && addrs.has('0x' + '33'.repeat(20)));
});

test('decodeTx: contract creation through MsgEVMCall (empty to)', () => {
  const d = decodeTx(cosmosTx([{ typeUrl: TYPES.evmCall, value: encodeMsgEVMCall({ sender: BECH, data: Uint8Array.of(0x60, 0x80), gasLimit: 3000000n }) }]));
  assert.equal(d.messages[0].contractCreation, true);
  assert.equal(d.messages[0].fields.find((x) => x.name === 'to'), undefined);
});

test('decodeMessage: MsgPQVoteKey, MsgSetPQEvidence and MsgPQCertificate', () => {
  const vk = concat(lenField(1, utf8(VALOPER)), lenField(2, PUB), lenField(3, new Uint8Array(2420).fill(9)), lenField(5, utf8(BECH)));
  const m = decodeMessage({ typeUrl: TYPES.pqVoteKey, value: vk });
  assert.equal(m.name, 'MsgPQVoteKey'); assert.equal(m.zetaphy, true);
  assert.deepEqual(m.fields.map((f) => f.name), ['operator', 'pub key', 'proof', 'validator owner']);
  assert.equal(m.fields[1].value.length, 1312);
  const ev = decodeMessage({ typeUrl: TYPES.setPQEvidence, value: concat(lenField(1, utf8(BECH)), uintField(2, 1)) });
  assert.deepEqual(ev.fields.map((f) => [f.name, f.value]), [['authority', BECH], ['enabled', 1n]]);
  const off = decodeMessage({ typeUrl: TYPES.setPQEvidence, value: lenField(1, utf8(BECH)) });
  assert.deepEqual(off.fields.map((f) => [f.name, f.value]), [['authority', BECH], ['enabled', 0n]]); // "off" is shown, not dropped
  const att = concat(new Uint8Array(20).fill(0xaa), new Uint8Array(2420), new Uint8Array(20).fill(0xbb), new Uint8Array(2420));
  const certTx = encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: TYPES.pqCertificate, value: concat(lenField(1, utf8('zetaphy1proposer')), uintField(2, 41), lenField(3, att)) }] }), authInfoBytes: new Uint8Array(), signatures: [] });
  const d = decodeTx(certTx);
  assert.equal(d.isCertificate, true);
  assert.equal(d.messages[0].certificate.height, 41n);
  assert.deepEqual(d.messages[0].certificate.attestations.map((a) => a.address), ['AA'.repeat(20), 'BB'.repeat(20)]);
  assert.equal(splitAttestations(new Uint8Array(5)), null);
});

test('decodeTx: MsgEthereumTx gives the Ethereum hash (keccak of the raw tx), from, to and value', async () => {
  const w = new Wallet('0x' + '11'.repeat(32));
  const tx = Transaction.from({ type: 2, chainId: 77390, nonce: 7, maxPriorityFeePerGas: 1n, maxFeePerGas: 2000000000n, gasLimit: 21000n, to: '0x' + '44'.repeat(20), value: 10n ** 18n, data: '0x' });
  tx.signature = w.signingKey.sign(tx.unsignedHash);
  const raw = hexToBytes(tx.serialized);
  const msg = concat(lenField(5, hexToBytes(w.address)), lenField(6, raw));
  const d = decodeTx(encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: TYPES.ethereumTx, value: msg }] }), authInfoBytes: new Uint8Array(), signatures: [] }));
  const m = d.messages[0];
  assert.equal(m.evmHash, tx.hash);
  assert.deepEqual(d.evmHashes, [tx.hash]);
  assert.equal(m.evm.to, '0x' + '44'.repeat(20)); assert.equal(m.evm.value, 10n ** 18n); assert.equal(m.evm.nonce, 7n); assert.equal(m.evm.type, 2);
  assert.equal(m.fields.find((f) => f.name === 'from').value, w.address);
  // legacy (EIP-155) and a contract call
  const legacy = Transaction.from({ type: 0, chainId: 77390, nonce: 0, gasPrice: 1n, gasLimit: 50000n, to: '0x' + '55'.repeat(20), value: 0n, data: '0xa9059cbb' + '00'.repeat(64) });
  legacy.signature = w.signingKey.sign(legacy.unsignedHash);
  const l = decodeRawEvmTx(hexToBytes(legacy.serialized));
  assert.equal(l.type, 0); assert.equal(l.selector, '0xa9059cbb'); assert.equal(l.to, '0x' + '55'.repeat(20)); assert.equal(l.gas, 50000n);
  const create = Transaction.from({ type: 2, chainId: 77390, nonce: 1, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: 100000n, data: '0x6080' });
  create.signature = w.signingKey.sign(create.unsignedHash);
  assert.equal(decodeRawEvmTx(hexToBytes(create.serialized)).to, null);
  assert.equal(decodeRawEvmTx(Uint8Array.of(2, 0xff)), null);
  assert.deepEqual(rlpDecode(Uint8Array.of(0xc2, 0x01, 0x80)), [Uint8Array.of(1), new Uint8Array()]);
  assert.throws(() => rlpDecode(Uint8Array.of(0xc5, 0x01)));
});

test('decodeTx: unknown messages field by field; malformed bytes never throw', () => {
  const unknown = encodeAny('/x.y.v1.MsgThing', concat(lenField(1, utf8('hello')), uintField(2, 9), lenField(3, Uint8Array.of(0, 1, 2))));
  const d = decodeTx(encodeTxRaw({ bodyBytes: lenField(1, unknown), authInfoBytes: new Uint8Array(), signatures: [] }));
  assert.equal(d.messages[0].known, false);
  assert.equal(d.messages[0].name, 'MsgThing');
  assert.deepEqual(d.messages[0].fields.map((f) => [f.name, f.kind]), [['#1', 'text'], ['#2', 'uint'], ['#3', 'bytes']]);
  const bad = decodeTx(Uint8Array.of(0x0a, 0xff, 0xff));
  assert.ok(bad.error); assert.deepEqual(bad.messages, []);
  const badMsg = decodeMessage({ typeUrl: TYPES.send, value: Uint8Array.of(0x0a, 0x09) });
  assert.equal(badMsg.known, false);
});

test('events: normalised strings; tx_log events give EVM logs', () => {
  const data = Buffer.from(word(5), 'hex').toString('base64');
  const log = { address: '0x' + '33'.repeat(20), topics: [TOPICS.transfer, '0x' + word(1), '0x' + word(2)], data };
  const ev = [{ type: 'tx_log', attributes: [{ key: 'txLog', value: JSON.stringify(log) }, { key: 'txLog', value: '{bad' }] }, { type: 'message', attributes: [{ key: 'sender', value: BECH }] }];
  const logs = logsFromEvents(ev);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].data, '0x' + word(5));
  assert.equal(decodeTransfer(logs[0]).amount, 5n);
  assert.deepEqual(normalizeEvents([{ type: 7, attributes: [{ key: null, value: 1 }] }]), [{ type: '7', attributes: [{ key: '', value: '1' }] }]);
  assert.deepEqual(normalizeEvents('nope'), []);
});

// ---------------- EVM decoding ----------------

const addrTopic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const A = '0x' + 'a1'.repeat(20); const B = '0x' + 'b2'.repeat(20); const TOK = '0x' + '33'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);

test('decodeTransfer: ERC-20, ERC-721, ERC-1155 single and batch', () => {
  assert.equal(TOPICS.transfer, ethId('Transfer(address,address,uint256)'));
  const e20 = decodeTransfer({ address: TOK, topics: [TOPICS.transfer, addrTopic(A), addrTopic(B)], data: '0x' + word(10n ** 18n) });
  assert.equal(e20.standard, 'erc20'); assert.equal(e20.amount, 10n ** 18n); assert.equal(e20.from.toLowerCase(), A); assert.equal(e20.to.toLowerCase(), B);
  assert.equal(e20.mint, false);
  const e721 = decodeTransfer({ address: TOK, topics: [TOPICS.transfer, addrTopic(ZERO), addrTopic(B), '0x' + word(42)], data: '0x' });
  assert.equal(e721.standard, 'erc721'); assert.equal(e721.tokenId, 42n); assert.equal(e721.mint, true);
  const single = decodeTransfer({ address: TOK, topics: [TOPICS.transferSingle, addrTopic(A), addrTopic(A), addrTopic(ZERO)], data: '0x' + word(7) + word(3) });
  assert.equal(single.standard, 'erc1155'); assert.deepEqual(single.ids, [7n]); assert.deepEqual(single.amounts, [3n]); assert.equal(single.burn, true);
  const batchData = AbiCoder.defaultAbiCoder().encode(['uint256[]', 'uint256[]'], [[1, 2], [10, 20]]);
  const batch = decodeTransfer({ address: TOK, topics: [TOPICS.transferBatch, addrTopic(A), addrTopic(A), addrTopic(B)], data: batchData });
  assert.deepEqual(batch.ids, [1n, 2n]); assert.deepEqual(batch.amounts, [10n, 20n]);
  // not transfers / malformed
  assert.equal(decodeTransfer({ address: TOK, topics: [ethId('Approval(address,address,uint256)'), addrTopic(A), addrTopic(B)], data: '0x' + word(1) }), null);
  assert.equal(decodeTransfer({ address: TOK, topics: [TOPICS.transfer, '0x' + 'ff'.repeat(32), addrTopic(B)], data: '0x' + word(1) }), null);
  assert.equal(decodeTransfer({ address: 'nope', topics: [TOPICS.transfer], data: '0x' }), null);
  assert.equal(decodeTransfer({ address: TOK, topics: [TOPICS.transferBatch, addrTopic(A), addrTopic(A), addrTopic(B)], data: '0x' + word(999) }), null);
});

test('decodeAbiString (string and bytes32, sanitised), decodeUint', () => {
  const s = AbiCoder.defaultAbiCoder().encode(['string'], ['Sawasdee ‮gnp.exe Coin']);
  assert.equal(decodeAbiString(s), 'Sawasdee gnp.exe Coin');
  assert.equal(decodeAbiString('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')), 'MKR');
  assert.equal(decodeAbiString('0x1234'), null);
  assert.equal(decodeAbiString('0x' + word(32) + word(1000000)), null);
  assert.equal(decodeAbiString(AbiCoder.defaultAbiCoder().encode(['string'], ['x'.repeat(100)])), 'x'.repeat(48) + '…');
  assert.equal(decodeUint('0x' + word(18)), 18n);
  assert.equal(decodeUint('0x'), null);
});

test('readTokenInfo: ERC-20 and ERC-721 detection from eth_call answers', async () => {
  const coder = AbiCoder.defaultAbiCoder();
  const erc20 = { [SEL.name]: coder.encode(['string'], ['Sawasdee']), [SEL.symbol]: coder.encode(['string'], ['SWD']), [SEL.decimals]: '0x' + word(9), [SEL.totalSupply]: '0x' + word(10n ** 18n) };
  const call = (tbl) => async (_to, data) => { const v = tbl[data.slice(2, 10)]; if (v == null) throw new Error('revert'); return v; };
  const i = await readTokenInfo(call(erc20), TOK);
  assert.deepEqual(i, { standard: 'erc20', name: 'Sawasdee', symbol: 'SWD', decimals: 9, totalSupply: 10n ** 18n });
  const nft = { [SEL.name]: coder.encode(['string'], ['Art']), [SEL.symbol]: coder.encode(['string'], ['ART']), [SEL.supportsInterface]: '0x' + word(1) };
  assert.equal((await readTokenInfo(call(nft), TOK)).standard, 'erc721'); // supportsInterface answers true for any id here: 721 checked first
  assert.equal((await readTokenInfo(call({}), TOK)).standard, null);
  assert.equal(callData.balanceOf(A), '0x' + SEL.balanceOf + A.slice(2).padStart(64, '0'));
});

// ---------------- config ----------------

test('config: https only, no credentials, placeholder detection, endpoints with trailing slashes', () => {
  assert.equal(checkUrl('https://node.example'), 'https://node.example/');
  assert.equal(checkUrl('http://127.0.0.1:8545'), 'http://127.0.0.1:8545/');
  assert.throws(() => checkUrl('http://node.example'), /https/);
  assert.throws(() => checkUrl('https://u:p@node.example'), /password/);
  assert.throws(() => checkUrl('javascript:alert(1)'), /https/);
  assert.throws(() => checkUrl('https://<node-host>'), /placeholder|URL/);
  assert.throws(() => checkUrl('https://node.example/?x=1'), /\?/);
  assert.equal(isPlaceholder(DEFAULTS), true);
  assert.equal(isPlaceholder({ node: 'https://n.example' }), false);
  assert.deepEqual(endpoints({ node: 'https://n.example/' }), { evm: 'https://n.example/', comet: 'https://n.example/rpc/', rest: 'https://n.example/rest/' });
  assert.deepEqual(endpoints({ node: 'https://n.example', cometRpc: 'https://c.example/rpc', rest: 'https://r.example' }).comet, 'https://c.example/rpc/');
  const c = sanitizeConfig({ node: 'https://a.example', bogus: 1, threatRegistry: 'nope', scanBlocks: 99999, maxRps: 'x' });
  assert.equal(c.node, 'https://a.example'); assert.equal(c.bogus, undefined); assert.equal(c.threatRegistry, ''); assert.equal(c.scanBlocks, DEFAULTS.maxScanBlocks); assert.equal(c.maxRps, DEFAULTS.maxRps);
  assert.equal(sanitizeConfig({ threatRegistry: TOK }).threatRegistry, TOK);
  assert.equal(sanitizeConfig({ chainStatsUrl: 'javascript:alert(1)' }).chainStatsUrl, DEFAULTS.chainStatsUrl, 'a bad stats URL keeps the default');
  assert.equal(sanitizeConfig({ chainStatsUrl: '' }).chainStatsUrl, '', 'empty turns it off');
  assert.equal(neuroLink({ neuroReportUrl: 'https://neuro.example/web/?chain=zetaphy&address={address}', evmChainId: 77390 }, A), `https://neuro.example/web/?chain=zetaphy&address=${A}`);
  assert.equal(neuroLink({ neuroReportUrl: 'javascript:alert({address})' }, A), '');
  assert.equal(neuroLink({ neuroReportUrl: '' }, A), '');
  // the shipped config.json is valid: the placeholder, or the live node the launch wrote (https)
  const shipped = sanitizeConfig(JSON.parse(read('config.json')));
  if (!isPlaceholder(shipped)) assert.match(shipped.node, /^https:\/\//);
});

// ---------------- rpc queue and cache ----------------

test('Limiter: never more than maxConcurrent in flight, spaced by maxRps', async () => {
  let clock = 0; const sleeps = [];
  const lim = new Limiter({ maxConcurrent: 2, maxRps: 10, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  let active = 0; let peak = 0;
  const job = () => lim.run(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return 1; });
  const r = await Promise.all(Array.from({ length: 6 }, job));
  assert.deepEqual(r, [1, 1, 1, 1, 1, 1]);
  assert.equal(peak, 2);
  assert.ok(sleeps.length >= 4 && sleeps.every((ms) => ms > 0 && ms <= 100), String(sleeps));
});

test('LruCache: TTL and size bound', () => {
  let now = 0;
  const c = new LruCache(2, () => now);
  c.set('a', 1, 10); c.set('b', 2, 100); c.get('a'); c.set('c', 3, 100);
  assert.equal(c.get('b'), undefined); // least recently used went
  assert.equal(c.get('a'), 1);
  now = 50; assert.equal(c.get('a'), undefined); assert.equal(c.get('c'), 3);
  c.set('d', 4, 0); assert.equal(c.get('d'), undefined); // ttl 0: not cached
});

test('createApi: caches, shares in-flight requests, omits credentials, maps errors', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    const body = init.body ? JSON.parse(init.body) : null;
    await new Promise((r) => setTimeout(r, 5));
    if (url.endsWith('/rest/missing')) return new Response(JSON.stringify({ code: 5, message: 'not found' }), { status: 404 });
    if (body?.method === 'bad') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'boom‮' } }));
    return new Response(JSON.stringify(body ? { jsonrpc: '2.0', id: body.id, result: body.method } : { ok: true }));
  };
  const api = createApi({ evm: 'https://n.example/', comet: 'https://n.example/rpc/', rest: 'https://n.example/rest/' }, { fetchFn, maxRps: 1000 });
  const [a, b] = await Promise.all([api.evm('eth_blockNumber', []), api.evm('eth_blockNumber', [])]);
  assert.equal(a, 'eth_blockNumber'); assert.equal(b, a);
  assert.equal(seen.length, 1); // shared
  await api.evm('eth_blockNumber', []);
  assert.equal(seen.length, 1); // cached
  assert.equal(api.stats.cached, 1);
  await api.comet('status', {});
  assert.equal(seen[1].url, 'https://n.example/rpc/');
  assert.equal(seen[1].init.credentials, 'omit');
  assert.deepEqual(await api.rest('cosmos/x'), { ok: true });
  assert.equal(seen[2].url, 'https://n.example/rest/cosmos/x');
  await assert.rejects(api.evm('bad', []), (e) => e.kind === 'rpc' && !/‮/.test(e.message));
  await assert.rejects(api.rest('missing'), (e) => e.kind === 'notfound');
  await assert.rejects(api.evm('bad', []), /boom/); // errors are not cached: asked again
  assert.equal(seen.filter((s) => s.init.body?.includes('"bad"')).length, 2);
});

// ---------------- ThreatRegistry ----------------

function fakeRegistry({ flagKeys = {}, enforced = new Set(), evidence = {}, responses = {}, code = {} }) {
  const reg = '0x' + '77'.repeat(20);
  const sels = Object.fromEntries(Object.entries(THREAT_SEL).flatMap(([what, [w, e]]) => [[w, [what, false]], [e, [what, true]]]));
  const keyOf = (what, arg) => (what === 'address' ? addressKey(Number(BigInt('0x' + arg.slice(0, 64))), '0x' + arg.slice(88, 128)) : what === 'code' ? codeKey('0x' + arg) : '0x' + arg);
  const call = async (method, params) => {
    if (method === 'eth_getCode') return code[params[0].toLowerCase()] ?? '0x';
    if (method === 'eth_getStorageAt') return '0x' + word(0);
    if (method !== 'eth_call') throw new Error(method);
    const { to, data } = params[0];
    if (to !== reg) throw new Error('revert');
    const sel = data.slice(2, 10); const arg = data.slice(10);
    if (sels[sel]) {
      const [what, isEnf] = sels[sel];
      const key = keyOf(what, arg);
      const reason = flagKeys[key];
      const on = reason != null && (!isEnf || enforced.has(key));
      return '0x' + word(on ? 1 : 0) + word(on ? reason : 0);
    }
    if (sel === DETAIL_SEL.evidence) { const ev = evidence['0x' + arg]; return ev ?? '0x' + word(0) + word(128) + word(0) + word(0) + word(0); }
    if (sel === DETAIL_SEL.responseAt) { const list = responses['0x' + arg.slice(0, 64)] ?? []; const i = Number(BigInt('0x' + arg.slice(64))); const r = list[i]; return r ?? '0x' + word(160) + word(0) + word(0) + word(0) + word(0) + word(0); }
    throw new Error('revert');
  };
  return { reg, call };
}
const strTail = (s) => { const h = Buffer.from(s).toString('hex'); return word(h.length / 2) + h.padEnd(64 * Math.ceil(h.length / 64 || 1), '0'); };

test('checkThreats: an address flagged with a reason, evidence and the owner\'s response', async () => {
  const target = '0x' + 'ab'.repeat(20);
  const key = addressKey(77390, target);
  const { reg, call } = fakeRegistry({
    flagKeys: { [key]: 2 },
    evidence: { [key]: '0x' + 'e7'.repeat(32) + word(128) + word(0x99) + word(5) + strTail('ipfs://report') },
    responses: { [key]: ['0x' + word(160) + word(0xab) + word(7) + word(77390) + word(BigInt(target)) + strTail('We cap minting by ‮governance')] },
  });
  const r = await checkThreats(call, { registry: reg, chainId: 77390, address: target, code: '0x' });
  assert.equal(r.state, 'flagged');
  const f = r.flags[0];
  assert.equal(f.what, 'address'); assert.equal(f.enforced, false); assert.equal(f.reason, 2); assert.equal(f.reasonName, 'unlimited-mint');
  assert.equal(f.reasonText.en, 'an address can mint new tokens without a cap');
  assert.equal(f.evidence.reportHash, '0x' + 'e7'.repeat(32)); assert.equal(f.evidence.uri, 'ipfs://report');
  assert.equal(f.responses.length, 1); assert.equal(f.responses[0].text, 'We cap minting by governance'); // bidi removed
});

test('checkThreats: code fingerprint flag (enforced), clean, unset and unreadable registry', async () => {
  const target = '0x' + 'cd'.repeat(20); const code = '0x6080604052';
  const fpKey = '0x' + fingerprint1(code).slice(4);
  const { reg, call } = fakeRegistry({ flagKeys: { [fpKey]: 1 }, enforced: new Set([fpKey]), code: { [target]: code } });
  const r = await checkThreats(call, { registry: reg, chainId: 77390, address: target, code });
  assert.equal(r.state, 'flagged'); assert.equal(r.flags[0].what, 'fingerprint'); assert.equal(r.flags[0].enforced, true);
  assert.equal(r.flags[0].evidence.reportHash, null); assert.deepEqual(r.flags[0].responses, []);
  const clean = await checkThreats(call, { registry: reg, chainId: 77390, address: '0x' + '01'.repeat(20), code: '0x' });
  assert.equal(clean.state, 'clean'); assert.equal(clean.checked.length, 1);
  assert.deepEqual(await checkThreats(call, { registry: '', chainId: 77390, address: target, code }), { state: 'unset' });
  const broken = await checkThreats(async (m) => (m === 'eth_call' ? '0x' : '0x'), { registry: reg, chainId: 77390, address: target, code: '0x' });
  assert.equal(broken.state, 'error'); // nothing is claimed when the registry cannot be read
  assert.equal(codeKey(codeHash(code)).length, 66);
});

// ---------------- recent history scan ----------------

test('recentTxs: aligned chunks via tx_search, certificates counted apart, cached; fallback to blocks', async () => {
  const send = cosmosTx([{ typeUrl: TYPES.send, value: encodeMsgSend({ fromAddress: BECH, toAddress: OTHER, amount: [{ denom: 'azetaphy', amount: '7' }] }) }]);
  const cert = encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: TYPES.pqCertificate, value: uintField(2, 1) }] }), authInfoBytes: new Uint8Array(), signatures: [] });
  const calls = [];
  const txAt = (h) => [{ hash: cometTxHash(cert), height: String(h), index: 0, tx: toBase64(cert), tx_result: { code: 0 } }]
    .concat(h % 10 === 0 ? [{ hash: cometTxHash(send), height: String(h), index: 1, tx: toBase64(send), tx_result: { code: h === 70 ? 5 : 0 } }] : []);
  let txSearch = true;
  const api = {
    comet: async (method, params) => {
      calls.push([method, params]);
      if (method === 'tx_search') {
        if (!txSearch) throw new Error('tx_search: transaction indexing is disabled');
        const [, lo, hi] = /tx.height>=(\d+) AND tx.height<=(\d+)/.exec(params.query).map(Number);
        const all = []; for (let h = hi; h >= lo; h--) all.push(...txAt(h));
        const page = Number(params.page);
        return { txs: all.slice((page - 1) * 100, page * 100), total_count: String(all.length) };
      }
      if (method === 'blockchain') {
        const metas = []; for (let h = Number(params.maxHeight); h >= Number(params.minHeight); h--) metas.push({ header: { height: String(h) }, num_txs: h % 10 === 0 ? '2' : '1' });
        return { block_metas: metas };
      }
      if (method === 'block') { const h = Number(params.height); return { block: { data: { txs: txAt(h).map((x) => x.tx) } } }; }
      if (method === 'block_results') { const h = Number(params.height); return { txs_results: txAt(h).map((x) => x.tx_result) }; }
      throw new Error(method);
    },
    evm: async () => { throw new Error('no'); },
    rest: async () => { throw new Error('no'); },
  };
  const chain = chainApi(api);
  const r = await chain.recentTxs('120', 100);
  assert.equal(r.from, '21'); assert.equal(r.to, '120'); assert.equal(r.mode, 'tx_search'); assert.equal(r.complete, true);
  assert.deepEqual(r.txs.map((x) => x.height), ['120', '110', '100', '90', '80', '70', '60', '50', '40', '30']);
  assert.equal(r.certificates, 100);
  const t70 = r.txs.find((x) => x.height === '70');
  assert.equal(t70.ok, false); assert.equal(t70.code, 5);
  assert.equal(t70.from, BECH); assert.equal(t70.to, OTHER); assert.equal(t70.value, 7n); assert.equal(t70.label, 'MsgSend');
  assert.ok(t70.addresses.has(HEX.toLowerCase()));
  // aligned chunks of 50: [101,120] (top, not finished), [51,100], [1,50]
  assert.deepEqual(calls.filter((c) => c[0] === 'tx_search').map((c) => c[1].query.match(/\d+/g).join('-')).filter((v, i, a) => a.indexOf(v) === i), ['101-120', '51-100', '1-50']);
  // the node without a tx index: blocks with txs, bounded
  txSearch = false;
  const chain2 = chainApi(api);
  const r2 = await chain2.recentTxs('120', 30, { maxBlockFetches: 100 });
  assert.equal(r2.mode, 'blocks');
  assert.deepEqual(r2.txs.map((x) => x.height), ['120', '110', '100']);
  const r3 = await chainApi(api).recentTxs('120', 30, { maxBlockFetches: 5 });
  assert.equal(r3.complete, false);
});

test('recentTxs: the chunk still being written is extended with new blocks only (node data stays low)', async () => {
  const cert = encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: TYPES.pqCertificate, value: uintField(2, 1) }] }), authInfoBytes: new Uint8Array(), signatures: [] });
  const queries = [];
  const api = {
    comet: async (method, params) => {
      if (method !== 'tx_search') throw new Error(method);
      const [, lo, hi] = /tx.height>=(\d+) AND tx.height<=(\d+)/.exec(params.query).map(Number);
      queries.push(`${lo}-${hi}`);
      const all = []; for (let h = hi; h >= lo; h--) all.push({ hash: `H${h}`, height: String(h), index: 0, tx: toBase64(cert), tx_result: { code: 0 } });
      return { txs: all.slice((Number(params.page) - 1) * 100, Number(params.page) * 100), total_count: String(all.length) };
    },
    evm: async () => { throw new Error('no'); },
    rest: async () => { throw new Error('no'); },
  };
  const chain = chainApi(api);
  assert.equal((await chain.recentTxs('120', 20)).certificates, 20);
  assert.deepEqual(queries, ['101-120']);
  const r = await chain.recentTxs('125', 20);
  assert.deepEqual(queries, ['101-120', '121-125'], 'only the 5 new blocks are asked for');
  assert.equal(r.certificates, 20); assert.equal(r.from, '106'); assert.equal(r.to, '125');
  await chain.recentTxs('125', 20);
  assert.equal(queries.length, 2, 'nothing new: nothing asked');
  // the chunk fills up and the next one starts: the finished one comes from memory
  await chain.recentTxs('152', 60);
  assert.deepEqual(queries.slice(2), ['151-152', '126-150', '51-100']);
});

// ---------------- i18n and static checks ----------------

test('i18n: the 8 languages, each with exactly the English keys and placeholders', () => {
  assert.deepEqual(LANGS.map(([c]) => c), ['en', 'zh', 'es', 'ko', 'ja', 'ru', 'vi', 'th']);
  assert.deepEqual(Object.keys(T).sort(), LANGS.map(([c]) => c).sort());
  const vars = (x) => (x.match(/\{\w+\}/g) ?? []).sort().join();
  for (const [code] of LANGS) {
    const enKeys = Object.keys(T.en).sort();
    assert.deepEqual(Object.keys(T[code]).sort(), enKeys, code);
    for (const k of enKeys) {
      assert.ok(typeof T[code][k] === 'string' && T[code][k].trim(), `${code}.${k} empty`);
      assert.equal(vars(T[code][k]), vars(T.en[k]), `${code}.${k} placeholders`);
    }
  }
  for (const [code] of LANGS) assert.equal(pickLang(code), code);
  for (const x of [null, undefined, '', 'xx', 'EN', 'zh-CN', '__proto__']) assert.equal(pickLang(x), 'en');
  // missing keys fall back to English
  const saved = T.zh.pqRule; delete T.zh.pqRule;
  try { assert.equal(makeT('zh')('pqRule'), 'Rule'); } finally { T.zh.pqRule = saved; }
  assert.equal(makeT('xx')('save'), 'Save');
});

test('i18n: every key the app uses exists', () => {
  const src = ['src/app.js', 'index.html', 'src/flow.js', 'src/quantum.js', 'src/risk.js', 'src/crosschain.js', 'src/ask.js', ...['validators2', 'gov', 'holders', 'nft', 'gas', 'tools'].map((m) => `src/${m}.js`)].map(read).join('\n');
  const used = new Set([...src.matchAll(/\bt\('([A-Za-z0-9_]+)'/g), ...src.matchAll(/data-i18n(?:-placeholder|-title)?="([A-Za-z_]+)"/g)].map((m) => m[1]));
  // keys built at run time in the page modules
  for (const k of ['gas_slow', 'gas_normal', 'gas_fast', 'gasActTransfer', 'gasActErc20', 'gasActSwap', 'gasActNftMint', 'gasActApprove',
    'govDeposit', 'govVoting', 'govPassed', 'govRejected', 'govFailedStatus', 'govYes', 'govNo', 'govAbstain', 'govVeto']) used.add(k);
  for (const w of ['address', 'code', 'fingerprint']) used.add(`what_${w}`);
  for (const m of src.matchAll(/'(help[A-Z][A-Za-z]+)'/g)) used.add(m[1]);
  for (const k of used) assert.ok(k in T.en, `missing key ${k}`);
  assert.equal(makeT('th')('pqCoverage', { p: '50%' }), '50% ของพลังโหวตมีกุญแจโหวต PQ');
  assert.equal(makeT('en')('nope'), 'nope');
  // the disclaimer and neutral wording (docs/LEGAL.md)
  const all = JSON.stringify(T).toLowerCase();
  for (const word of ['scam', 'fraud', 'หลอกลวง', 'มิจฉาชีพ']) assert.ok(!all.includes(word), word);
  assert.ok(read('src/app.js').includes('DISCLAIMER'));
});

test('security: no markup sinks in the source, strict CSP, no third-party scripts', () => {
  const files = ['index.html', ...readdirSync(new URL('src/', ROOT)).map((f) => `src/${f}`)];
  for (const f of files) {
    const s = read(f);
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setAttribute(\'on']) assert.ok(!s.includes(sink), `${f} uses ${sink}`);
  }
  const html = read('index.html');
  assert.ok(!/<script(?![^>]*src="src\/app\.js")/.test(html), 'only the app script');
  assert.ok(!/https?:\/\/[^"]*\.(js|css)/.test(html), 'no third-party scripts or styles');
  assert.ok(!/\sstyle=|\son[a-z]+=/i.test(html), 'no inline styles or handlers');
  const csp = JSON.parse(read('vercel.json')).headers[0].headers.find((x) => x.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self' https:/);
  assert.ok(!csp.includes('unsafe'), 'no unsafe-inline / unsafe-eval');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(read('vendor/zetaphy-lib.js').startsWith('// Generated by `npm run build`'), 'vendor bundle comes from npm run build');
});

// ---------------- history, live view, watch list, analytics ----------------

test('CSP: the only wss:// source is config.json\'s node (the live websocket), and the app opens sockets to that host only', () => {
  const csp = JSON.parse(read('vercel.json')).headers[0].headers.find((x) => x.key === 'Content-Security-Policy').value;
  const node = new URL(JSON.parse(read('config.json')).node);
  const connect = csp.split(';').map((x) => x.trim()).find((x) => x.startsWith('connect-src')).split(/\s+/).slice(1);
  assert.deepEqual(connect, ["'self'", 'https:', 'https://ipfs.io', `wss://${node.host}`], 'update vercel.json connect-src when config.json node changes');
  assert.equal(socketHost({ node: node.href }), node.host);
  assert.equal(socketHost({ node: 'https://<node-host>' }), '');
  assert.equal(socketHost({ node: 'http://evil.example' }), '');
  assert.match(read('scripts/serve.js'), /wss:\/\/\$\{u\.host\}/); // the local server derives it the same way
});

test('history: tx_search queries only take validated addresses (no injection)', () => {
  const q = addressQueries(BECH);
  assert.deepEqual(q.map((x) => x.query), [
    `message.sender='${BECH}'`, `message.sender='${HEX}'`, `transfer.sender='${BECH}'`, `transfer.recipient='${BECH}'`, `ethereum_tx.recipient='${HEX}'`,
  ]);
  assert.deepEqual(addressQueries(HEX.toLowerCase()).map((x) => x.query), q.map((x) => x.query)); // 0x of any case -> the same canonical forms
  assert.deepEqual(addressQueries(` ${BECH.toUpperCase()} `).map((x) => x.query), q.map((x) => x.query)); // a typed address is checked, then rewritten
  assert.deepEqual(q.map((x) => x.dir), ['out', 'out', 'out', 'in', 'in']);
  for (const bad of [
    `${BECH}' OR tx.height>0 AND message.sender='x`, `${BECH}'`, "x' OR '1'='1", '', null, `${HEX}; DROP`, HEX.slice(0, 41),
    BECH.slice(0, -1) + (BECH.endsWith('r') ? 'q' : 'r'), // bad checksum
    'zetaphyvaloper1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zfnr6v8', 'cosmos1dksnf6lukq6jw058j48svsdajg8dqua6tv0n8g', `${BECH}\n`.repeat(2),
  ]) assert.throws(() => addressQueries(bad), /refused/, String(bad));
  assert.equal(eventQuery('message.sender', BECH), `message.sender='${BECH}'`);
  assert.throws(() => eventQuery('message.sender', HEX.toLowerCase()), /canonical/); // the node indexes the EIP-55 spelling
  assert.throws(() => eventQuery('message.sender', BECH.toUpperCase()), /refused/);
  for (const k of ["message.sender='x' OR a.b", 'tx.height>', 'message', 'Message.sender', 'a.b c', "a.b'"]) assert.throws(() => eventQuery(k, BECH), /bad event key/, k);
});

const fakeTx = (h, i, tag = '') => ({ hash: bytesToHex(sha256(utf8(`${h}:${i}:${tag}`))).toUpperCase(), height: String(h), index: i, tx: '', tx_result: {} });

test('history: pages of several newest-first queries merge in order, without gaps or duplicates, fetching only what is needed', async () => {
  // A: 60 txs at heights 100..41; B: every 3rd of A's (the same txs) plus 5 of its own; C: nothing.
  const A = Array.from({ length: 60 }, (_, k) => fakeTx(100 - k, 0));
  const B = [...A.filter((_, k) => k % 3 === 0), ...[95, 70, 50, 20, 10].map((h) => fakeTx(h, 1))].sort((x, y) => Number(y.height) - Number(x.height) || y.index - x.index);
  const data = { A, B, C: [] };
  const calls = [];
  const fetchPage = async (s, page, per) => {
    calls.push(`${s.id}${page}`);
    const all = data[s.id];
    return { txs: all.slice((page - 1) * 10, page * 10), total_count: String(all.length) }; // the node caps pages at 10
  };
  const m = new HistoryMerger([{ id: 'A' }, { id: 'B' }, { id: 'C' }], fetchPage, { perPage: 100 });
  const first = await m.loadMore(15);
  assert.equal(first.length, 15);
  assert.deepEqual(calls.slice(0, 3).sort(), ['A1', 'B1', 'C1']);
  assert.deepEqual(m.total, { exact: null, min: 60, max: 85 });
  const all = [...first];
  while (!m.done) all.push(...await m.loadMore(15));
  const keys = all.map((e) => [Number(e.tx.height), e.tx.index]);
  assert.equal(all.length, 65);
  assert.equal(new Set(all.map((e) => e.hash)).size, 65);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1][0] > keys[i][0] || (keys[i - 1][0] === keys[i][0] && keys[i - 1][1] > keys[i][1]), `order at ${i}`);
  assert.deepEqual([...all.find((e) => e.tx.height === '100').sources].sort(), ['A', 'B']);
  assert.deepEqual(m.total, { exact: 65, min: 65, max: 65 });
  assert.equal(calls.filter((c) => c.startsWith('C')).length, 1, 'an empty query is asked once');
  assert.equal(new Set(calls).size, calls.length, 'no page asked twice');
  // a refused query is reported; all refused -> failed (the page then falls back to the scan)
  const bad = new HistoryMerger([{ id: 'A' }, { id: 'X' }], async (s, p) => { if (s.id === 'X') throw new Error('tx_search: not indexed'); return fetchPage(s, p); });
  assert.equal((await bad.loadMore(5)).length, 5);
  assert.equal(bad.failed, false); assert.deepEqual(bad.errors.map((e) => e.id), ['X']);
  const none = new HistoryMerger([{ id: 'X' }], async () => { throw new Error('refused'); });
  assert.deepEqual(await none.loadMore(5), []);
  assert.equal(none.failed, true);
  // junk from the node is skipped, never thrown
  const junk = new HistoryMerger([{ id: 'J' }], async () => ({ txs: [{ hash: 'zz', height: '1' }, { hash: 'A'.repeat(64), height: '-1' }, null], total_count: '3' }));
  assert.deepEqual(await junk.loadMore(5), []);
  assert.equal(junk.done, true);
});

test('history: kinds, directions and filters', () => {
  assert.equal(kindOf(['/cosmos.bank.v1beta1.MsgSend']), 'transfer');
  assert.equal(kindOf(['/cosmos.staking.v1beta1.MsgDelegate']), 'staking');
  assert.equal(kindOf(['/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward']), 'staking');
  assert.equal(kindOf(['/cosmos.evm.vm.v1.MsgEthereumTx']), 'evm');
  assert.equal(kindOf(['/zetaphy.pq.v1.MsgEVMCall']), 'evm');
  assert.equal(kindOf(['/cosmos.bank.v1beta1.MsgSend', '/ibc.applications.transfer.v1.MsgTransfer']), 'ibc');
  assert.equal(kindOf(['/cosmos.gov.v1.MsgVote']), 'governance');
  assert.equal(kindOf(['/zetaphy.pq.v1.MsgQuantumLock', '/cosmos.bank.v1beta1.MsgSend']), 'transfer');
  assert.equal(kindOf([]), 'other');
  const me = HEX.toLowerCase();
  assert.equal(directionOf({ from: BECH, to: OTHER }, me), 'out');
  assert.equal(directionOf({ from: OTHER, to: HEX }, me), 'in');
  assert.equal(directionOf({ from: HEX, to: BECH }, me), 'self');
  assert.equal(directionOf({ from: OTHER, to: '' }, me, new Set(['recipient'])), 'in');
  assert.equal(directionOf({ from: '', to: '' }, me, new Set(['evmSender'])), 'out');
  assert.equal(directionOf({ from: OTHER, to: '' }, me), 'other');
  assert.equal(transferDirection({ from: HEX, to: '0x' + '11'.repeat(20) }, me), 'out');
  assert.ok(matchesFilter({ dir: 'self', kind: 'evm' }, { dir: 'in', kind: 'evm' }));
  assert.ok(!matchesFilter({ dir: 'out', kind: 'evm' }, { dir: 'in' }));
  assert.ok(!matchesFilter({ dir: 'in', kind: 'staking' }, { kind: 'transfer' }));
  assert.ok(matchesFilter({ dir: 'other', kind: 'other' }, {}));
});

test('CSV: quoting and spreadsheet formula injection', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(12), '12');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  for (const s of ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
    const c = csvCell(s);
    assert.ok(c.startsWith("'") || c.startsWith('"\''), `${JSON.stringify(s)} -> ${c}`);
  }
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('=A1,B1'), '"\'=A1,B1"');
  assert.equal(toCsv(['a', 'b'], [['1', '=2'], ['x,y', '']]), "a,b\r\n1,'=2\r\n\"x,y\",\r\n");
  const row = historyCsvRow({ hash: '0xab', cometHash: 'AB', height: '5', index: 1, kind: 'transfer', dir: 'out', label: '=cmd|"/c calc"!A0', from: BECH, to: OTHER, value: 2500000000000000000n, ok: true, code: 0 });
  assert.equal(row.length, HISTORY_CSV_HEADER.length);
  assert.equal(row[6], '=cmd|"/c calc"!A0'); assert.equal(csvCell(row[6]), '"\'=cmd|""/c calc""!A0"');
  assert.equal(row[9], '2.5');
  const tr = tokenCsvRow({ txHash: '0x1', block: '9', logIndex: '0', dir: 'in', tr: { standard: 'erc1155', token: HEX, from: HEX, to: HEX, ids: [1n, 2n], amounts: [3n, 4n] } });
  assert.equal(tr.length, TOKEN_CSV_HEADER.length); assert.equal(tr[8], '#1x3 #2x4');
});

test('history: token transfer logs are read backwards in 500-block windows', async () => {
  const asked = [];
  const log = (block, idx, from, to) => ({ address: '0x' + '33'.repeat(20), topics: [TOPICS.transfer, '0x' + from.slice(2).toLowerCase().padStart(64, '0'), '0x' + to.slice(2).toLowerCase().padStart(64, '0')],
    data: '0x' + word(5), blockNumber: '0x' + block.toString(16), logIndex: '0x' + idx.toString(16), transactionHash: '0x' + word(block * 10 + idx) });
  const logs = [log(1200, 0, HEX, '0x' + '11'.repeat(20)), log(1200, 1, '0x' + '11'.repeat(20), HEX), log(300, 0, HEX, HEX)];
  const s = new LogScanner(async (from, to) => { asked.push([from, to]); return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to).concat(logs[0]); }, 1300);
  const a = await s.loadMore({ minItems: 1 });
  assert.deepEqual(asked, [[801, 1300]]);
  assert.deepEqual(a.map((r) => [r.block, r.logIndex]), [['1200', '1'], ['1200', '0']]); // newest first; the repeated log once
  assert.equal(s.from, 801); assert.equal(s.done, false);
  const b = await s.loadMore({ minItems: 5, maxWindows: 8 });
  assert.deepEqual(asked.slice(1), [[301, 800], [1, 300]]);
  assert.deepEqual(b.map((r) => r.block), ['300']);
  assert.equal(s.done, true);
  assert.deepEqual(await s.loadMore(), []);
});

test('live: websocket URLs and message parsing (CometBFT NewBlock, EVM newHeads)', () => {
  assert.deepEqual(wsEndpoints({ evm: 'https://n.example/', comet: 'https://n.example/rpc/', rest: 'https://n.example/rest/' }), { comet: 'wss://n.example/rpc/websocket', evm: 'wss://n.example/ws' });
  assert.deepEqual(wsEndpoints({ evm: 'http://localhost:8545/', comet: 'http://localhost:26657/' }), { comet: 'ws://localhost:26657/websocket', evm: 'ws://localhost:8545/ws' });
  assert.deepEqual(JSON.parse(cometSubscribe(3)), { jsonrpc: '2.0', method: 'subscribe', id: 3, params: { query: "tm.event='NewBlock'" } });
  assert.deepEqual(parseCometWs('{"jsonrpc":"2.0","id":1,"result":{}}'), { kind: 'ack' });
  const ev = { jsonrpc: '2.0', id: 1, result: { query: "tm.event='NewBlock'", data: { type: 'tendermint/event/NewBlock', value: { block: { header: { height: '42', time: '2026-10-30T01:02:03Z', proposer_address: 'ab'.repeat(20) }, data: { txs: ['AAE=', 'not base64!', 7] } } } } } };
  assert.deepEqual(parseCometWs(JSON.stringify(ev)), { kind: 'block', height: '42', time: '2026-10-30T01:02:03Z', proposer: 'AB'.repeat(20), txs: ['AAE='] });
  ev.result.data.value.block.header.height = '42; alert(1)';
  assert.equal(parseCometWs(JSON.stringify(ev)), null);
  assert.deepEqual(parseCometWs('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"subscribe","data":"max_subscriptions_per_client reached\\u202e"}}'), { kind: 'error', message: 'max_subscriptions_per_client reached ' });
  for (const junk of ['', 'nope', '[]', 'null', '{"result":{"data":{"type":"tendermint/event/Tx"}}}', 42, null]) assert.equal(parseCometWs(junk), null, String(junk));
  assert.deepEqual(parseEvmWs('{"jsonrpc":"2.0","id":1,"result":"0x9cef478923ff08bf67fde6c64013158d"}'), { kind: 'ack', id: '0x9cef478923ff08bf67fde6c64013158d' });
  const head = parseEvmWs(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0x1', result: { number: '0x2a', timestamp: '0x6720f0c3', baseFeePerGas: '0x3b9aca00', gasUsed: '0x5208', gasLimit: '0x1c9c380' } } }));
  assert.equal(head.kind, 'block'); assert.equal(head.height, '42'); assert.equal(head.baseFee, 1000000000n); assert.equal(head.gasUsed, 21000n);
  assert.equal(head.time, new Date(0x6720f0c3 * 1000).toISOString());
  assert.equal(parseEvmWs('{"method":"eth_subscription","params":{"result":{"number":"zz"}}}'), null);
  assert.equal(parseEvmWs('{"jsonrpc":"2.0","id":1,"result":true}'), null);
});

/** A WebSocket stand-in: the test decides what each URL does. */
function fakeSockets(behaviour) {
  const opened = [];
  class FakeWS {
    constructor(url) {
      this.url = url; opened.push(this);
      const b = behaviour(url);
      queueMicrotask(() => {
        if (b === 'throw-later') { this.onerror?.(); return; }
        if (b === 'close') { this.onclose?.(); return; }
        this.onopen?.();
      });
    }
    send(m) { this.sent = m; const b = behaviour(this.url); if (b === 'ack-comet') queueMicrotask(() => this.onmessage?.({ data: '{"jsonrpc":"2.0","id":1,"result":{}}' })); if (b === 'ack-evm') queueMicrotask(() => this.onmessage?.({ data: '{"jsonrpc":"2.0","id":1,"result":"0xab"}' })); }
    close() { this.closed = true; }
  }
  return { FakeWS, opened };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const EPS = { evm: 'https://n.example/', comet: 'https://n.example/rpc/', rest: 'https://n.example/rest/' };

test('live: CometBFT socket first, then EVM newHeads, then polling; heights only go up; sockets only to the allowed host', async () => {
  // CometBFT works
  let { FakeWS, opened } = fakeSockets(() => 'ack-comet');
  let feed = new LiveFeed({ endpoints: EPS, host: 'n.example', WebSocketImpl: FakeWS, poll: async () => null });
  const modes = []; const got = [];
  feed.onMode((m) => modes.push(m)); feed.on((b) => got.push([b.height, b.previous, b.source]));
  feed.start(); await tick(); await tick();
  assert.equal(feed.mode, 'comet-ws'); assert.equal(opened.length, 1); assert.equal(opened[0].url, 'wss://n.example/rpc/websocket');
  assert.match(opened[0].sent, /tm\.event='NewBlock'/);
  const block = (h) => JSON.stringify({ result: { data: { type: 'tendermint/event/NewBlock', value: { block: { header: { height: String(h) }, data: { txs: [] } } } } } });
  for (const h of [5, 6, 6, 4, 8]) opened[0].onmessage({ data: block(h) });
  assert.deepEqual(got, [['5', null, 'comet'], ['6', '5', 'comet'], ['8', '6', 'comet']]);
  feed.stop(); assert.equal(feed.mode, 'off'); assert.ok(opened[0].closed);
  // CometBFT refused (the public node's rpc-guard) -> EVM newHeads
  ({ FakeWS, opened } = fakeSockets((u) => (u.endsWith('/rpc/websocket') ? 'close' : 'ack-evm')));
  feed = new LiveFeed({ endpoints: EPS, host: 'n.example', WebSocketImpl: FakeWS, poll: async () => null });
  feed.start(); await tick(); await tick(); await tick();
  assert.equal(feed.mode, 'evm-ws'); assert.deepEqual(opened.map((w) => w.url), ['wss://n.example/rpc/websocket', 'wss://n.example/ws']);
  assert.match(opened[1].sent, /eth_subscribe.*newHeads/);
  feed.stop();
  // both fail -> polling
  ({ FakeWS, opened } = fakeSockets(() => 'throw-later'));
  let polls = 0;
  feed = new LiveFeed({ endpoints: EPS, host: 'n.example', WebSocketImpl: FakeWS, interval: 5, poll: async () => ({ height: String(10 + Math.floor(polls++ / 2)), time: '' }), hidden: () => false });
  const heights = []; feed.on((b) => heights.push(b.height));
  feed.start(); await new Promise((r) => setTimeout(r, 20));
  try { assert.equal(feed.mode, 'polling'); assert.equal(opened.length, 2); } catch (e) { feed.stop(); throw e; }
  await new Promise((r) => setTimeout(r, 60));
  feed.stop();
  assert.ok(heights.length >= 2 && heights.every((h, i) => !i || Number(h) > Number(heights[i - 1])), heights.join());
  // a node set on the Settings page (not the CSP's host): no socket at all
  ({ FakeWS, opened } = fakeSockets(() => 'ack-comet'));
  feed = new LiveFeed({ endpoints: { ...EPS, comet: 'https://other.example/rpc/', evm: 'https://other.example/' }, host: 'n.example', WebSocketImpl: FakeWS, poll: async () => null });
  feed.start(); await tick();
  assert.equal(feed.mode, 'polling'); assert.equal(opened.length, 0);
  feed.stop();
  // no WebSocket in this browser -> polling
  feed = new LiveFeed({ endpoints: EPS, host: 'n.example', WebSocketImpl: null, poll: async () => null });
  feed.start(); assert.equal(feed.mode, 'polling'); feed.stop();
});

test('live: pending txs (num_unconfirmed_txs, unconfirmed_txs refused on the public node) and when a watched tx lands', async () => {
  const send = cosmosTx([{ typeUrl: TYPES.send, value: encodeMsgSend({ fromAddress: BECH, toAddress: OTHER, amount: [{ denom: 'azetaphy', amount: '9' }] }) }]);
  const chain = chainApi({ comet: async () => { throw new Error('x'); }, evm: async () => null, rest: async () => null });
  const ps = pendingSummary(toBase64(send), chain.summarize);
  assert.equal(ps.hash, cometTxHash(send)); assert.equal(ps.label, 'MsgSend'); assert.equal(ps.from, BECH); assert.equal(ps.value, 9n); assert.equal(ps.size, send.length);
  assert.equal(pendingSummary('%%%', chain.summarize), null);
  const open = await pendingSnapshot(async (m) => (m === 'num_unconfirmed_txs' ? { n_txs: '1', total: '3', total_bytes: '900' } : { txs: [toBase64(send), 5] }));
  assert.deepEqual({ ...open, txs: open.txs.length }, { count: 3, bytes: 900, txs: 1, refused: '' });
  const shut = await pendingSnapshot(async (m) => { if (m === 'unconfirmed_txs') throw new Error('method not available on this public RPC'); return { total: '2', total_bytes: '10' }; });
  assert.equal(shut.txs, null); assert.equal(shut.count, 2); assert.match(shut.refused, /not available/);
  // txLanded: EVM receipts and CometBFT txs
  const c = { evmReceipt: async (h) => (h === '0x' + 'aa'.repeat(32) ? { blockNumber: '0x1f', status: '0x0' } : null), cosmosTx: async (h) => (h === 'bb'.repeat(32) ? { height: '7', txResult: { code: 0 } } : null) };
  assert.deepEqual(await txLanded(c, { hash: '0x' + 'aa'.repeat(32) }), { height: '31', ok: false });
  assert.deepEqual(await txLanded(c, { hash: 'BB'.repeat(32) }), { height: '7', ok: true });
  assert.equal(await txLanded(c, { hash: 'CC'.repeat(32) }), null);
});

/** A localStorage stand-in (optionally blocked: every call throws). */
function memStorage(blocked = false) {
  const m = new Map();
  const guard = () => { if (blocked) throw new Error('SecurityError: storage is blocked'); };
  return { getItem: (k) => { guard(); return m.has(k) ? m.get(k) : null; }, setItem: (k, v) => { guard(); m.set(k, String(v)); }, removeItem: (k) => { guard(); m.delete(k); }, map: m };
}

test('watch list: validated, nicknames cleaned, survives a reload, harmless when storage is blocked or edited by hand', async () => {
  const st = memStorage();
  const w = createWatchStore(st);
  assert.deepEqual(w.list(), []);
  assert.equal(w.set(BECH, '  My‮   wallet​ '), true);
  assert.equal(w.set('0xnope', 'x'), false);
  assert.equal(w.set(HEX.toLowerCase(), 'Renamed'), true); // the same address: renamed, not added twice
  assert.deepEqual(w.list(), [{ address: HEX, name: 'Renamed' }]);
  assert.equal(w.nameOf(BECH), 'Renamed'); assert.ok(w.has(HEX)); assert.equal(w.nameOf(OTHER), '');
  assert.equal(cleanNick('x'.repeat(100)).length, 40);
  assert.equal(createWatchStore(st).nameOf(HEX), 'Renamed', 'kept in storage');
  let changed = 0; w.onChange(() => changed++);
  w.set(OTHER, ''); w.remove(HEX);
  assert.equal(changed, 2);
  assert.deepEqual(w.list().map((e) => e.address), [toAddress(OTHER).hex]);
  st.setItem(WATCH_KEY, JSON.stringify([{ address: 'javascript:alert(1)' }, 7, null, { address: HEX, name: { x: 1 } }, { address: HEX, name: 'dup' }]));
  assert.deepEqual(createWatchStore(st).list(), [{ address: HEX, name: '[object Object]' }]);
  st.setItem(WATCH_KEY, '{oops');
  assert.deepEqual(createWatchStore(st).list(), []);
  const blocked = createWatchStore(memStorage(true));
  assert.deepEqual(blocked.list(), []); assert.equal(blocked.set(HEX, 'x'), false); assert.equal(blocked.nameOf(HEX), '');
  assert.deepEqual(createWatchStore(null).list(), []);
  // watched txs
  assert.deepEqual(txHashParam('0x' + 'AB'.repeat(32)), { hash: '0x' + 'ab'.repeat(32), evm: true });
  assert.deepEqual(txHashParam('ab'.repeat(32)), { hash: 'AB'.repeat(32), evm: false });
  assert.equal(txHashParam('0x123'), null); assert.equal(txHashParam(`${'ab'.repeat(32)}'`), null);
  const landedAt = new Map();
  const tw = createTxWatch(st, async (e) => landedAt.get(e.hash) ?? null);
  assert.equal(tw.add('cd'.repeat(32), '0x' + 'ef'.repeat(32)), true); assert.equal(tw.add('nope'), false);
  assert.equal(tw.add('0x' + '12'.repeat(32)), true);
  const events = []; tw.onChange((l) => events.push(l.map((e) => e.hash)));
  assert.deepEqual(await tw.checkAll(), []);
  landedAt.set('CD'.repeat(32), { height: '44', ok: true });
  landedAt.set('0x' + '12'.repeat(32), { height: '45', ok: false });
  const landed = await tw.checkAll();
  assert.deepEqual(landed.map((e) => [e.hash, e.status, e.height]), [['0x' + '12'.repeat(32), 'failed', '45'], ['CD'.repeat(32), 'confirmed', '44']]);
  assert.equal(events.length, 1);
  assert.deepEqual(createTxWatch(st, async () => null).list().map((e) => e.status), ['failed', 'confirmed']); // kept
  assert.deepEqual(await tw.checkAll(), []); // nothing pending any more
  assert.deepEqual(createTxWatch(memStorage(true), async () => null).list(), []);
});

test('analytics: block times, txs per block, fees, most active addresses, bar geometry', () => {
  const t0 = Date.parse('2026-10-30T00:00:00Z');
  const metas = [12, 10, 11, 11, 14].map((h) => ({ header: { height: String(h), time: new Date(t0 + h * 5000 + (h === 12 ? 1000 : 0)).toISOString() }, num_txs: String(h % 3) }));
  const s = blockSeries(metas);
  assert.deepEqual(s.map((x) => [x.height, x.txs, x.dt]), [[10, 1, null], [11, 2, 5], [12, 0, 6], [14, 2, null]]); // no dt across a gap
  assert.deepEqual(txsPerBlock([{ height: '11' }, { height: '11' }, { height: '13' }, { height: '99' }], 10, 13).map((x) => x.count), [0, 2, 0, 1]);
  assert.deepEqual(txsPerBlock([], 5, 4), []);
  const fees = feeSeries({ oldestBlock: '0xa', baseFeePerGas: ['0x3b9aca00', '0x77359400', '0x0'], gasUsedRatio: [0.5, 1.7] });
  assert.deepEqual(fees, [{ height: 10, baseFeeGwei: 1, gasRatio: 0.5 }, { height: 11, baseFeeGwei: 2, gasRatio: 1 }]);
  assert.deepEqual(feeSeries(null), []); assert.deepEqual(feeSeries({ oldestBlock: 'x' }), []);
  const top = topAddresses([{ from: BECH, to: OTHER }, { from: HEX, to: HEX }, { from: OTHER, to: '' }, { from: 'zetaphyvaloper1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zfnr6v8', to: BECH }]);
  assert.deepEqual(top.map((x) => [x.address, x.count]), [[HEX.toLowerCase(), 3], ['0x' + '11'.repeat(20), 2], ['0x' + '22'.repeat(20), 1]]);
  assert.deepEqual(summary([1, 2, null, 6]), { min: 1, max: 6, avg: 3 }); assert.equal(summary([null]), null);
  const b = bars([0, 5, 10, null], 400, 100, { gap: 0 });
  assert.deepEqual(b.map((x) => [x.x, x.y, x.w, x.h]), [[0, 100, 100, 0], [100, 50, 100, 50], [200, 0, 100, 100], [300, 100, 100, 0]]);
  assert.deepEqual(bars([], 10, 10), []);
  assert.deepEqual(bars([0, 0], 10, 10).map((x) => x.h), [0, 0]);
});

test('i18n: every key the history, live, watch and chart modules use exists', () => {
  const src = ['src/history.js', 'src/live.js', 'src/watch.js', 'src/charts.js'].map(read).join('\n');
  const used = new Set([...src.matchAll(/\bt\('([A-Za-z_]+)'/g)].map((m) => m[1]));
  for (const k of KINDS) used.add(`kind_${k}`);
  for (const d of ['in', 'out', 'self', 'other']) used.add(`dir_${d}`);
  assert.ok(used.size > 60);
  for (const k of used) assert.ok(k in T.en, `missing key ${k}`);
  assert.equal(makeT('th')('histTotal', { n: '57' }), 'ทั้งหมด 57 ธุรกรรม');
});
