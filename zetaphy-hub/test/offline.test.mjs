// The Offline tab's logic (offline-core.js) against ethers: EIP-712 hashes of cheques and orders, signatures and
// recovery (low s only), the QR / text payloads, the offline checks a payee and a relayer run, the calldata, the
// encrypted offline key; the tab's words in 8 languages; the service worker's app shell (static files only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypedDataEncoder, Wallet, Interface, AbiCoder, id, recoverAddress, Signature, toBeHex, keccak256, solidityPacked, getAddress } from 'ethers';
import * as core from '../offline-core.js';
import { OFFLINE } from '../offline-i18n.js';
import { cleanState, qrSvg, channelKey } from '../offline.js';
import { LANG_CODES, TAB_TEXT, TEXT } from '../i18n.js';
import qrcode from '../vendor/qrcode.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const { secp256k1: secp, keccak_256: keccak } = await import('../../zetaphy-wallet/vendor/pqwallet.js');
const art = (n) => JSON.parse(readFileSync(join(HERE, '..', 'zetaphy-network', 'artifacts', `${n}.json`), 'utf8'));
const CHQ = '0x' + '5c'.repeat(20), ORD = '0x' + '0d'.repeat(20);
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const E18 = 10n ** 18n;
const signer = new Wallet(keccak256(solidityPacked(['string'], ['hub offline test signer'])));
const other = new Wallet(keccak256(solidityPacked(['string'], ['hub offline test other'])));
const sk = (w) => Uint8Array.from(Buffer.from(w.privateKey.slice(2), 'hex'));
const hex = (b) => `0x${Buffer.from(b).toString('hex')}`;
const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => shape(x, `${at}/${k}`)) : [`${at}:${typeof v}`]);

test('OFFLINE words: every language has every key, translated, placeholders filled; the tab in TAB_TEXT and the pill in TEXT', () => {
  assert.deepEqual(Object.keys(OFFLINE).sort(), [...LANG_CODES].sort());
  const en = shape(OFFLINE.en);
  for (const l of LANG_CODES) {
    assert.deepEqual(shape(OFFLINE[l]), en, l);
    const L = OFFLINE[l];
    if (l !== 'en') for (const k of ['intro', 'keyTip', 'recvTip', 'orderTip', 'relayTip', 'testnet']) assert.notEqual(L[k], OFFLINE.en[k], `${l}.${k} translated`);
    assert.equal(L.risks.length, 5, `${l}: five risks`);
    assert.ok(L.openAction('10', '0xab…cd', 30).includes('10') && L.openAction('10', '0xab…cd', 30).includes('0xab…cd'), `${l}.openAction`);
    assert.ok(L.chequeOk('2.5', '3', 'ZTPHY', '7').includes('2.5') && L.chequeOk('2.5', '3', 'ZTPHY', '7').includes('#7'), `${l}.chequeOk`);
    assert.ok(L.simOk('9.5', 'ZTPHY', '0.1').includes('9.5'), `${l}.simOk`);
    for (const code of ['wrongChain', 'wrongContract', 'badSignature', 'unknownChannel', 'wrongSigner', 'closing', 'notYourChannel', 'notNewer', 'nothingCovered', 'overDeposit', 'expired', 'expiresSoon', 'staleSync', 'badOrder', 'nonceUsed']) {
      assert.ok(L.problem[code]?.trim(), `${l}.problem.${code}`);
    }
    assert.equal(TAB_TEXT[l].offline?.length, 3, `${l}: tab text`);
    assert.ok(TEXT[l].netOffline && TEXT[l].tipNetOffline, `${l}: offline pill`);
  }
  assert.match(OFFLINE.th.testnet, /เทสต์เน็ต/);
  assert.match(OFFLINE.en.risks.join(' '), /24 hours/);
  assert.doesNotMatch(readFileSync(join(HERE, 'offline.js'), 'utf8'), /[฀-๿]/, 'no Thai in the code');
});

test('selectors and the ChannelOpened topic match the contracts\' ABI', () => {
  const chq = new Interface(art('ZetaphyCheques').abi), ord = new Interface(art('ZetaphyOfflineOrders').abi);
  for (const f of ['open', 'topUp', 'extend', 'startClose', 'withdraw', 'cash', 'release', 'channels', 'channelCount', 'cashable']) assert.equal(core.SEL[f], chq.getFunction(f).selector, f);
  for (const f of ['fill', 'cancel', 'isNonceUsed', 'router']) assert.equal(core.SEL[f], ord.getFunction(f).selector, f);
  for (const [k, sig] of Object.entries({ approve: 'approve(address,uint256)', allowance: 'allowance(address,address)', balanceOf: 'balanceOf(address)', decimals: 'decimals()', symbol: 'symbol()', WETH: 'WETH()', getAmountsOut: 'getAmountsOut(uint256,address[])' })) {
    assert.equal(core.SEL[k], id(sig).slice(0, 10), k);
  }
  assert.equal(core.CHANNEL_OPENED_TOPIC, chq.getEvent('ChannelOpened').topicHash);
  assert.equal(core.CHEQUE_TYPE, 'Cheque(uint256 channelId,uint256 cumulativeAmount)');
});

test('EIP-712: cheque and order digests equal ethers\' TypedDataEncoder; the wallet payloads hash the same', () => {
  const cheque = { contract: CHQ, chainId: 77390, channelId: 12n, cumulative: 345n * E18 };
  const dom = { name: 'ZETAPHY Cheques', version: '1', chainId: 77390, verifyingContract: CHQ };
  const types = { Cheque: [{ name: 'channelId', type: 'uint256' }, { name: 'cumulativeAmount', type: 'uint256' }] };
  const want = TypedDataEncoder.hash(dom, types, { channelId: 12n, cumulativeAmount: 345n * E18 });
  assert.equal(hex(core.chequeDigest(keccak, cheque)), want);
  const td = core.chequeTypedData(cheque);
  const { EIP712Domain, ...tdTypes } = td.types;
  assert.equal(TypedDataEncoder.hash(td.domain, tdTypes, td.message), want);
  assert.equal(EIP712Domain.length, 4);

  const order = { maker: signer.address, tokenIn: '0x' + '11'.repeat(20), tokenOut: core.NATIVE, amountIn: 10n * E18, minAmountOut: 9n * E18, deadline: 1_900_000_000n, nonce: 2n ** 63n + 5n, relayerFee: E18 / 10n };
  const otd = core.orderTypedData({ contract: ORD, order });
  const { EIP712Domain: _d, ...oTypes } = otd.types;
  const ow = TypedDataEncoder.hash({ name: 'ZETAPHY Offline Orders', version: '1', chainId: 77390, verifyingContract: ORD }, oTypes, order);
  assert.equal(hex(core.orderDigest(keccak, { contract: ORD, order })), ow);
  assert.equal(TypedDataEncoder.hash(otd.domain, oTypes, otd.message), ow);
  assert.equal(hex(core.orderHash(keccak, order)), TypedDataEncoder.hashStruct('Order', oTypes, order));
  // the chain id and the contract are in the domain
  assert.notEqual(hex(core.chequeDigest(keccak, { ...cheque, chainId: 1 })), want);
  assert.notEqual(hex(core.chequeDigest(keccak, { ...cheque, contract: ORD })), want);
});

test('signatures: r‖s‖v with low s that ethers recovers; high s, bad v, short or junk refused', () => {
  const d = core.chequeDigest(keccak, { contract: CHQ, channelId: 1n, cumulative: E18 });
  const sig = core.signDigest(secp, d, sk(signer));
  assert.match(sig, /^0x[0-9a-f]{130}$/);
  assert.equal(recoverAddress(hex(d), sig), signer.address);
  assert.equal(core.recoverSigner(secp, keccak, d, sig), signer.address.toLowerCase());
  assert.equal(core.recoverSigner(secp, keccak, d, signer.signingKey.sign(hex(d)).serialized), signer.address.toLowerCase(), 'an ethers signature too');
  assert.equal(core.addressOf(secp, keccak, sk(signer)), signer.address.toLowerCase());
  const s = Signature.from(sig);
  const high = s.r + toBeHex(N - BigInt(s.s), 32).slice(2) + (s.v === 27 ? '1c' : '1b');
  assert.equal(core.recoverSigner(secp, keccak, d, high), null, 'the contracts and the hub do not');
  assert.equal(core.recoverSigner(secp, keccak, d, sig.slice(0, -2) + '1d'), null);
  assert.equal(core.recoverSigner(secp, keccak, d, sig.slice(0, -2)), null);
  assert.equal(core.recoverSigner(secp, keccak, d, 'nonsense'), null);
  const v01 = sig.slice(0, -2) + (sig.endsWith('1b') ? '00' : '01');
  assert.equal(core.recoverSigner(secp, keccak, d, v01), signer.address.toLowerCase(), 'v as 0/1');
  const k = core.newKey(secp, keccak);
  assert.equal(k.sk.length, 32);
  assert.equal(new Wallet(hex(k.sk)).address.toLowerCase(), k.address);
});

test('payloads: a cheque and an order survive the QR / text round trip; anything else is refused', () => {
  const c = { chainId: 77390, contract: CHQ, channelId: '42', cumulative: (123n * E18 + 7n).toString(), sig: '0x' + 'ab'.repeat(65) };
  const t = core.encodeCheque(c);
  assert.ok(t.startsWith('ZCHQ1:'));
  assert.match(t, /^ZCHQ1:[A-Za-z0-9_-]+$/, 'QR byte mode, no padding');
  assert.deepEqual(core.decodeCheque(`  ${t}\n`), c);
  assert.equal(core.payloadKind(t), 'cheque');
  const order = { maker: '0x' + 'aa'.repeat(20), tokenIn: '0x' + '11'.repeat(20), tokenOut: core.NATIVE, amountIn: '10', minAmountOut: '9', deadline: '1900000000', nonce: '18446744073709551615', relayerFee: '1' };
  const ot = core.encodeOrder({ contract: ORD, order, sig: '0x' + 'cd'.repeat(65) });
  assert.equal(core.payloadKind(ot), 'order');
  assert.deepEqual(core.decodeOrder(ot), { chainId: 77390, contract: ORD, order, sig: '0x' + 'cd'.repeat(65) });
  for (const bad of ['', 'hello', 'ZCHQ1:', 'ZCHQ1:@@@', `ZCHQ1:${Buffer.from('{"c":1}').toString('base64url')}`, t.replace('ZCHQ1:', 'ZORD1:'), `${t}${'A'.repeat(3000)}`,
    `ZCHQ1:${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(t.slice(6), 'base64url')), a: '-1' })).toString('base64url')}`,
    `ZCHQ1:${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(t.slice(6), 'base64url')), a: (2n ** 256n).toString() })).toString('base64url')}`]) {
    assert.throws(() => core.decodeCheque(bad), /format/, bad.slice(0, 40));
  }
  assert.throws(() => core.decodeOrder(t), /format/);
  // both fit a QR code comfortably (the encoder picks the version)
  for (const text of [t, ot]) {
    const q = qrcode(0, 'M'); q.addData(text, 'Byte'); q.make();
    assert.ok(q.getModuleCount() <= 117, `version ≤ 25 for ${text.length} characters`);
  }
});

test('the QR code drawing: one SVG path of dark modules on a white square (no inline style)', () => {
  const made = [];
  const node = (tag) => { const n = { tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, append(...k) { this.kids.push(...k); } }; made.push(n); return n; };
  const doc = { createElementNS: (_ns, tag) => node(tag) };
  const svg = qrSvg(qrcode, 'ZCHQ1:abc', doc);
  assert.equal(svg.tag, 'svg');
  assert.match(svg.attrs.viewBox, /^0 0 \d+ \d+$/);
  const path = svg.kids.find((k) => k.tag === 'path');
  assert.match(path.attrs.d, /^(M\d+ \d+h1v1h-1z)+$/);
  assert.ok(made.every((n) => !('style' in n.attrs)));
});

const snap = (over = {}) => ({ payer: '0x' + '0a'.repeat(20), payee: '0x' + '0b'.repeat(20), token: core.NATIVE, signer: signer.address.toLowerCase(), deposit: (10n * E18).toString(), paid: '0',
  expiry: 2_000_000_000, closeAt: 0, done: false, syncedAt: 1_999_000_000, ...over });
const chequeText = (cum, key = signer, channelId = '3', contract = CHQ, chainId = 77390) => core.encodeCheque({ chainId, contract, channelId, cumulative: cum.toString(),
  sig: core.signDigest(secp, core.chequeDigest(keccak, { contract, chainId, channelId, cumulative: cum }), sk(key)) });

test('offline cheque check: valid, newer only, up to the deposit as synced, the channel\'s signer only, open channels only', () => {
  const opts = (o = {}) => ({ snapshot: snap(), lastSeen: 0n, keccak, secp, contract: CHQ, now: 1_999_000_100, ...o });
  const codes = (v) => v.problems.map((p) => p.code);
  let v = core.verifyCheque(core.decodeCheque(chequeText(4n * E18)), opts());
  assert.ok(v.ok, JSON.stringify(v.problems));
  assert.equal(v.covered, 4n * E18);
  assert.equal(v.signer, signer.address.toLowerCase());
  assert.equal(v.asOf, 1_999_000_000);
  assert.equal(v.expiresIn, 2_000_000_000 - 1_999_000_100);
  // the next cheque adds only the difference; an older or equal one is refused
  v = core.verifyCheque(core.decodeCheque(chequeText(6n * E18)), opts({ lastSeen: 4n * E18 }));
  assert.ok(v.ok); assert.equal(v.newAmount, 2n * E18);
  assert.deepEqual(codes(core.verifyCheque(core.decodeCheque(chequeText(4n * E18)), opts({ lastSeen: 4n * E18 }))), ['notNewer']);
  // over the deposit: covered up to it (warning), or nothing new at all (refused)
  v = core.verifyCheque(core.decodeCheque(chequeText(12n * E18)), opts({ lastSeen: 8n * E18 }));
  assert.ok(v.ok); assert.equal(v.covered, 2n * E18); assert.deepEqual(codes(v), ['overDeposit']);
  v = core.verifyCheque(core.decodeCheque(chequeText(12n * E18)), opts({ lastSeen: 10n * E18 }));
  assert.ok(!v.ok); assert.ok(codes(v).includes('nothingCovered'));
  // already cashed on chain counts as seen
  v = core.verifyCheque(core.decodeCheque(chequeText(5n * E18)), opts({ snapshot: snap({ paid: (5n * E18).toString() }) }));
  assert.ok(!v.ok);
  // wrong key, unknown channel, closing, other chain / contract, a cheque of another channel
  assert.deepEqual(codes(core.verifyCheque(core.decodeCheque(chequeText(E18, other)), opts())), ['wrongSigner']);
  assert.deepEqual(codes(core.verifyCheque(core.decodeCheque(chequeText(E18)), opts({ snapshot: null }))), ['unknownChannel']);
  assert.ok(codes(core.verifyCheque(core.decodeCheque(chequeText(E18)), opts({ snapshot: snap({ closeAt: 1_999_100_000 }) }))).includes('closing'));
  assert.ok(codes(core.verifyCheque(core.decodeCheque(chequeText(E18)), opts({ snapshot: snap({ done: true }) }))).includes('closing'));
  assert.ok(codes(core.verifyCheque(core.decodeCheque(chequeText(E18, signer, '3', CHQ, 1)), opts())).includes('wrongChain'));
  assert.ok(codes(core.verifyCheque(core.decodeCheque(chequeText(E18, signer, '3', ORD)), opts())).includes('wrongContract'));
  const forged = core.decodeCheque(chequeText(E18)); forged.cumulative = (9n * E18).toString();
  assert.ok(!core.verifyCheque(forged, opts()).ok, 'the amount is signed');
  // warnings: expiry soon / past, an old sync, someone else's channel
  assert.deepEqual(codes(core.verifyCheque(core.decodeCheque(chequeText(E18)), opts({ now: 2_000_000_000 - 60, snapshot: snap({ syncedAt: 2_000_000_000 - 100 }) }))), ['expiresSoon']);
  assert.ok(codes(core.verifyCheque(core.decodeCheque(chequeText(E18)), opts({ now: 2_000_000_100 }))).includes('expired'));
  assert.ok(codes(core.verifyCheque(core.decodeCheque(chequeText(E18)), opts({ now: 1_999_000_000 + 2 * 86400 }))).includes('staleSync'));
  assert.deepEqual(codes(core.verifyCheque(core.decodeCheque(chequeText(E18)), opts({ me: '0x' + '0c'.repeat(20) }))), ['notYourChannel']);
  assert.equal(core.cashBy(snap()), 2_000_000_000 + 86400);
});

test('offline order check: the maker\'s signature over every field, the deadline, sane amounts', () => {
  const order = { maker: signer.address.toLowerCase(), tokenIn: '0x' + '11'.repeat(20), tokenOut: '0x' + '22'.repeat(20), amountIn: '100', minAmountOut: '95', deadline: '1900000000', nonce: core.newNonce(), relayerFee: '1' };
  const sig = core.signDigest(secp, core.orderDigest(keccak, { contract: ORD, order }), sk(signer));
  const p = core.decodeOrder(core.encodeOrder({ contract: ORD, order, sig }));
  const o = { keccak, secp, contract: ORD, now: 1_800_000_000 };
  assert.ok(core.verifyOrder(p, o).ok);
  assert.deepEqual(core.verifyOrder({ ...p, order: { ...p.order, relayerFee: '50' } }, o).problems.map((x) => x.code), ['badSignature']);
  assert.ok(core.verifyOrder(p, { ...o, now: 1_900_000_001 }).problems.some((x) => x.code === 'expired'));
  assert.ok(core.verifyOrder(p, { ...o, contract: CHQ }).problems.some((x) => x.code === 'wrongContract'));
  const zero = { ...order, amountIn: '0' };
  const pz = { ...p, order: zero, sig: core.signDigest(secp, core.orderDigest(keccak, { contract: ORD, order: zero }), sk(signer)) };
  assert.ok(core.verifyOrder(pz, o).problems.some((x) => x.code === 'badOrder'));
  assert.match(core.newNonce(), /^\d{1,20}$/);
});

test('calldata equals ethers\' encoding of the contracts\' ABI; channels() answers decode', () => {
  const chq = new Interface(art('ZetaphyCheques').abi), ord = new Interface(art('ZetaphyOfflineOrders').abi);
  const a = (x) => '0x' + x.repeat(20);
  const sig = '0x' + '12'.repeat(64) + '1b';
  assert.equal(core.encodeOpen(a('01'), core.NATIVE, 5n * E18, 1_900_000_000, a('02')), chq.encodeFunctionData('open', [a('01'), core.NATIVE, 5n * E18, 1_900_000_000, a('02')]));
  assert.equal(core.encodeCash(7n, 3n * E18, sig), chq.encodeFunctionData('cash', [7n, 3n * E18, sig]));
  for (const f of ['startClose', 'withdraw', 'release', 'channels']) assert.equal(core[`encode${f === 'channels' ? 'Channel' : f[0].toUpperCase() + f.slice(1)}`](9n), chq.encodeFunctionData(f, [9n]), f);
  assert.equal(core.encodeTopUp(9n, 4n), chq.encodeFunctionData('topUp', [9n, 4n]));
  const order = { maker: a('aa'), tokenIn: a('11'), tokenOut: core.NATIVE, amountIn: '10', minAmountOut: '9', deadline: '1900000000', nonce: '77', relayerFee: '1' };
  const tuple = [order.maker, order.tokenIn, order.tokenOut, 10n, 9n, 1_900_000_000n, 77n, 1n];
  assert.equal(core.encodeFill(order, sig, []), ord.encodeFunctionData('fill', [tuple, sig, []]));
  assert.equal(core.encodeFill(order, sig, [a('11'), a('33'), a('44')]), ord.encodeFunctionData('fill', [tuple, sig, [a('11'), a('33'), a('44')]]));
  assert.equal(core.encodeCancel(77n), ord.encodeFunctionData('cancel', [77n]));
  assert.equal(core.encodeIsNonceUsed(a('aa'), 77n), ord.encodeFunctionData('isNonceUsed', [a('aa'), 77n]));
  const erc = new Interface(['function approve(address,uint256)', 'function getAmountsOut(uint256,address[])']);
  assert.equal(core.encodeApprove(a('0d'), 5n), erc.encodeFunctionData('approve', [a('0d'), 5n]));
  assert.equal(core.encodeAmountsOut(5n, [a('11'), a('22')]), erc.encodeFunctionData('getAmountsOut', [5n, [a('11'), a('22')]]));
  const ans = AbiCoder.defaultAbiCoder().encode(['address', 'uint64', 'uint64', 'address', 'address', 'address', 'uint256', 'uint256', 'bool'],
    [a('0a'), 1_900_000_000, 0, a('0b'), core.NATIVE, a('0e'), 10n * E18, 2n * E18, false]);
  assert.deepEqual(core.decodeChannel(ans), { payer: a('0a'), expiry: 1_900_000_000, closeAt: 0, payee: a('0b'), token: core.NATIVE, signer: a('0e'), deposit: (10n * E18).toString(), paid: (2n * E18).toString(), done: false });
  assert.equal(core.decodeChannel('0x' + '00'.repeat(32 * 9)), null, 'no such channel');
  const rc = { logs: [{ address: getAddress(CHQ), topics: [core.CHANNEL_OPENED_TOPIC, toBeHex(5n, 32)], data: '0x' }] };
  assert.equal(core.channelIdFromReceipt(rc, CHQ), '5');
  assert.equal(core.channelIdFromReceipt(rc, ORD), null);
  assert.equal(core.parseAmount('1.5'), 15n * E18 / 10n);
  assert.throws(() => core.parseAmount('-1'));
  assert.throws(() => core.parseAmount('1.0000000000000000001'));
  assert.equal(core.formatAmount(15n * E18 / 10n), '1.5');
});

test('the offline key: encrypted with a passphrase (PBKDF2 ≥ 310,000, AES-GCM), the address bound; wrong passphrase or tampering refused', async () => {
  const k = core.newKey(secp, keccak);
  const blob = await core.encryptKey({}, k.sk, 'a long passphrase', k.address, core.MIN_KDF_ITERATIONS);
  assert.equal(blob.iter, 310_000);
  assert.equal(blob.kdf, 'PBKDF2-SHA256');
  assert.ok(!JSON.stringify(blob).includes(Buffer.from(k.sk).toString('hex')), 'no key in clear');
  assert.deepEqual(await core.decryptKey({}, blob, 'a long passphrase'), k.sk);
  await assert.rejects(core.decryptKey({}, blob, 'a wrong passphrase'), /passphrase/);
  await assert.rejects(core.decryptKey({}, { ...blob, address: '0x' + '11'.repeat(20) }, 'a long passphrase'), /passphrase/, 'the address is authenticated');
  await assert.rejects(core.decryptKey({}, { ...blob, iter: 1000 }, 'a long passphrase'), /blob/, 'no downgrade of the KDF');
  const ct = Buffer.from(blob.ct, 'base64'); ct[0] ^= 1;
  await assert.rejects(core.decryptKey({}, { ...blob, ct: ct.toString('base64') }, 'a long passphrase'), /passphrase/);
  await assert.rejects(core.encryptKey({}, k.sk, 'short', k.address), /passphrase/);
  await assert.rejects(core.encryptKey({}, k.sk, 'a long passphrase', k.address, 100_000), /iterations/);
  assert.equal(core.KDF_ITERATIONS, 600_000);
  const b2 = await core.encryptKey({}, k.sk, 'a long passphrase', k.address, core.MIN_KDF_ITERATIONS);
  assert.notEqual(b2.salt, blob.salt); assert.notEqual(b2.iv, blob.iv);
});

test('stored state is cleaned: junk dropped, nothing trusted', () => {
  const k = channelKey(CHQ, 3n);
  assert.equal(k, `${CHQ}:3`);
  const good = { payer: '0x' + '0a'.repeat(20), payee: '0x' + '0b'.repeat(20), token: core.NATIVE, signer: signer.address, deposit: '10', paid: '0', expiry: 5, closeAt: 0, done: false, syncedAt: 1 };
  const s = cleanState({ key: { address: 'nope' }, channels: { [k]: good, 'bad:key': good, [`${CHQ}:4`]: { ...good, deposit: 'lots' } }, signed: { [k]: '5', x: '1' },
    cheques: { [k]: { text: 'junk' } }, orders: [{ text: 'junk' }] });
  assert.equal(s.key, null);
  assert.deepEqual(Object.keys(s.channels), [k]);
  assert.equal(s.channels[k].signer, signer.address.toLowerCase());
  assert.deepEqual(s.signed, { [k]: '5' });
  assert.deepEqual(s.cheques, {});
  assert.deepEqual(s.orders, []);
  assert.deepEqual(cleanState('garbage'), { key: null, channels: {}, signed: {}, cheques: {}, orders: [] });
});

test('the hub: an Offline tab with its page; the service worker keeps only the static app shell; CSP allows it', async () => {
  const hub = readFileSync(join(HERE, 'hub.js'), 'utf8');
  assert.match(hub, /\{ id: 'offline', page: true/);
  assert.match(readFileSync(join(HERE, 'pages.js'), 'utf8'), /offline,/);
  const csp = JSON.parse(readFileSync(join(HERE, 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /worker-src 'self'/);
  const { build, shellFiles } = await import('../build.mjs');
  const out = build();
  const files = shellFiles(out);
  for (const f of ['./', 'hub.js', 'hub.css', 'offline.js', 'offline-core.js', 'offline-i18n.js', 'vendor/qrcode.js', 'wallet/vendor/pqwallet.js', 'wallet/wallets.js', 'i18n.js', 'pages.js', 'hub-config.json']) assert.ok(files.includes(f), f);
  for (const f of files) assert.ok(f === './' || !/^(https?:|\/|api\/)/.test(f), `local only: ${f}`);
  for (const f of ['vendor/snarkjs.min.js', 'vendor/evm.js', 'ceremony.html']) assert.ok(!files.includes(f), `not in the shell: ${f}`);
  const sw = readFileSync(join(out, 'sw.js'), 'utf8');
  assert.doesNotMatch(sw, /__SHELL__|__VERSION__/);
  assert.match(sw, /const VERSION = "[0-9a-f]{16}";/);
  assert.match(sw, /u\.origin !== scope\.origin/, 'other origins (the RPC) are never cached');
  assert.match(sw, /req\.method !== 'GET'/);
  assert.match(sw, /\/api\//);
  const vendor = JSON.parse(readFileSync(join(HERE, 'vendor', 'qrcode.json'), 'utf8'));
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(readFileSync(join(HERE, 'vendor', 'qrcode.js'))).digest('hex'), vendor.sha256, 'the vendored QR encoder is the pinned file');
  assert.equal(vendor.license, 'MIT');
});
