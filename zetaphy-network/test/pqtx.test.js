// Native PQ accounts (src/pqtx.js): every encoding is decoded with the
// official Cosmos SDK protobuf types (cosmjs-types) and re-encoded, so the
// bytes must be exactly what the chain's decoder expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { TxRaw, TxBody, AuthInfo, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys';
import {
  buildSendTx, pqAddress, pqClient, toBech32, fromBech32, addressBytes, normalizeAddress, varint, bytesToHex, hexToBytes,
  parseZeta, formatZeta, bumpGasPrice, txHashOf, encodeSignDoc,
  PUBKEY_TYPE_URL, MSG_SEND_TYPE_URL, SIGN_MODE_DIRECT, CHAIN_ID, DENOM, DEFAULT_GAS_LIMIT,
} from '../src/pqtx.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const { publicKey, secretKey } = ml_dsa44.keygen(SEED);
const sign = (b) => ml_dsa44.sign(b, secretKey);
const ME = pqAddress(publicKey);
const OTHER = '0x' + '11'.repeat(20);
const sha256 = (b) => createHash('sha256').update(b).digest();

test('address of a known key is sha256("zetaphy/mldsa44\\0" || pk)[:20] in both forms', () => {
  assert.equal(publicKey.length, 1312);
  assert.deepEqual([...ME.bytes], [...sha256(Buffer.concat([Buffer.from('zetaphy/mldsa44\0'), publicKey])).subarray(0, 20)]);
  // Fixed vector: seed 0x00..1f. The chain checks the same one
  // (zetaphy-chain/fork-tests/crypto/mldsa44: TestAddressMatchesJavaScript).
  assert.equal(ME.hex, '0x6DA134EbFcb035273E87954f0641bD920ED073Ba');
  assert.equal(ME.bech32, 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r');
  assert.throws(() => pqAddress(publicKey.subarray(1)), /1312 bytes/);
});

test('bech32: known vector, round trips, bad checksums rejected', () => {
  // The Cosmos gov module account: sha256("gov")[:20].
  assert.equal(toBech32(sha256('gov').subarray(0, 20), 'cosmos'), 'cosmos10d07y265gmmuvt4z0w9aw880jnsr700j6zn9kn');
  for (let i = 0; i < 20; i++) {
    const b = Uint8Array.from({ length: 20 }, (_, j) => (i * 37 + j * 11) & 255);
    assert.deepEqual([...fromBech32(toBech32(b))], [...b]);
  }
  assert.deepEqual([...fromBech32(ME.bech32.toUpperCase())], [...ME.bytes], 'all upper case is valid bech32');
  const s = ME.bech32;
  const flip = s.slice(0, -1) + (s.at(-1) === 'q' ? 'p' : 'q');
  assert.throws(() => fromBech32(flip), /checksum/);
  assert.throws(() => fromBech32(s.slice(0, 12) + (s[12] === 'q' ? 'p' : 'q') + s.slice(13)), /checksum/);
  assert.throws(() => fromBech32(s.slice(0, 10) + s[10].toUpperCase() + s.slice(11)), /invalid address/, 'mixed case');
  assert.throws(() => fromBech32(toBech32(ME.bytes, 'cosmos')), /expected zetaphy1/);
  assert.throws(() => fromBech32(toBech32(new Uint8Array(32))), /20 bytes/);
  assert.throws(() => fromBech32('zetaphy1bbbbbb'), /invalid address/);
});

test('0x addresses: accepted as recipients, EIP-55 checksum enforced when mixed case', () => {
  assert.equal(normalizeAddress(ME.hex.toLowerCase()).bech32, ME.bech32);
  assert.equal(normalizeAddress(ME.bech32).hex, ME.hex);
  // A well-known EIP-55 address.
  assert.equal(normalizeAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed').hex, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.throws(() => addressBytes('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), /checksum/);
  assert.throws(() => addressBytes('0x1234'), /40 hex/);
  assert.throws(() => addressBytes(''), /invalid address/);
});

test('varint and amounts', () => {
  assert.equal(bytesToHex(varint(0)), '00');
  assert.equal(bytesToHex(varint(300)), 'ac02');
  assert.equal(bytesToHex(varint(2n ** 64n - 1n)), 'ffffffffffffffffff01');
  assert.deepEqual([...hexToBytes('0xAc02')], [0xac, 2]);
  assert.equal(parseZeta('1.5'), 1500000000000000000n);
  assert.equal(parseZeta('.000000000000000001'), 1n);
  assert.equal(parseZeta('2'), 2n * 10n ** 18n);
  assert.throws(() => parseZeta('1e3'), /not an amount/);
  assert.throws(() => parseZeta('0.0000000000000000001'), /decimal places/);
  assert.equal(formatZeta(1500000000000000000n), '1.5');
  assert.equal(formatZeta(0n), '0');
  assert.equal(bumpGasPrice(10n), 12n);
  assert.equal(bumpGasPrice(11n), 14n, '13.2 rounds up');
});

function sendTx(extra = {}) {
  return buildSendTx({ publicKey, sign, to: OTHER, amount: 1234567890123456789n, chainId: CHAIN_ID,
    accountNumber: 7n, sequence: 3n, gasLimit: 400000n, gasPrice: 12n, memo: 'hello', ...extra });
}

test('the tx decodes with the official Cosmos SDK types, field by field', () => {
  const tx = sendTx();
  const raw = TxRaw.decode(tx.txBytes);
  assert.deepEqual(TxRaw.encode(raw).finish(), tx.txBytes, 'TxRaw is canonical');
  assert.equal(tx.txHex, '0x' + bytesToHex(tx.txBytes));
  assert.equal(raw.signatures.length, 1);
  assert.equal(raw.signatures[0].length, 2420);

  const body = TxBody.decode(raw.bodyBytes);
  assert.deepEqual(TxBody.encode(body).finish(), raw.bodyBytes, 'TxBody is canonical');
  assert.equal(body.memo, 'hello');
  assert.equal(body.timeoutHeight, 0n);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].typeUrl, MSG_SEND_TYPE_URL);
  const send = MsgSend.decode(body.messages[0].value);
  assert.deepEqual(MsgSend.encode(send).finish(), body.messages[0].value, 'MsgSend is canonical');
  assert.equal(send.fromAddress, ME.bech32);
  assert.equal(send.toAddress, toBech32(hexToBytes(OTHER)));
  assert.deepEqual(send.amount, [{ denom: DENOM, amount: '1234567890123456789' }]);

  const auth = AuthInfo.decode(raw.authInfoBytes);
  assert.deepEqual(AuthInfo.encode(auth).finish(), raw.authInfoBytes, 'AuthInfo is canonical');
  assert.equal(auth.signerInfos.length, 1);
  const si = auth.signerInfos[0];
  assert.equal(si.publicKey.typeUrl, PUBKEY_TYPE_URL);
  assert.equal(PUBKEY_TYPE_URL, '/zetaphy.crypto.mldsa44.PubKey');
  // Same shape as secp256k1's PubKey { bytes key = 1 }.
  assert.deepEqual(PubKey.decode(si.publicKey.value).key, publicKey);
  assert.equal(si.modeInfo.single.mode, SIGN_MODE_DIRECT);
  assert.equal(si.sequence, 3n);
  assert.equal(auth.fee.gasLimit, 400000n);
  assert.deepEqual(auth.fee.amount, [{ denom: DENOM, amount: String(400000 * 12) }]);
  assert.equal(auth.fee.payer, '');
  assert.equal(auth.fee.granter, '');
  assert.equal(tx.fee, 4800000n);

  const doc = SignDoc.decode(tx.signDocBytes);
  assert.deepEqual(SignDoc.encode(doc).finish(), tx.signDocBytes, 'SignDoc is canonical');
  assert.deepEqual(doc.bodyBytes, raw.bodyBytes);
  assert.deepEqual(doc.authInfoBytes, raw.authInfoBytes);
  assert.equal(doc.chainId, 'zetaphy-testnet-1');
  assert.equal(doc.accountNumber, 7n);
  // The chain rebuilds the SignDoc itself; our bytes must equal its encoding.
  assert.deepEqual(SignDoc.encode(SignDoc.fromPartial({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: CHAIN_ID, accountNumber: 7n })).finish(), tx.signDocBytes);

  assert.ok(ml_dsa44.verify(raw.signatures[0], tx.signDocBytes, publicKey), 'ML-DSA signature over the SignDoc');
  assert.ok(!ml_dsa44.verify(raw.signatures[0], encodeSignDoc({ ...doc, chainId: 'other-1' }), publicKey), 'bound to the chain id');
  assert.equal(tx.txHash, sha256(tx.txBytes).toString('hex').toUpperCase());
});

test('defaults are left out: account number 0, sequence 0, no memo', () => {
  const tx = sendTx({ accountNumber: 0n, sequence: 0n, memo: '' });
  const raw = TxRaw.decode(tx.txBytes);
  assert.deepEqual(TxBody.encode(TxBody.decode(raw.bodyBytes)).finish(), raw.bodyBytes);
  assert.deepEqual(AuthInfo.encode(AuthInfo.decode(raw.authInfoBytes)).finish(), raw.authInfoBytes);
  assert.deepEqual(SignDoc.encode(SignDoc.decode(tx.signDocBytes)).finish(), tx.signDocBytes);
  assert.equal(SignDoc.decode(tx.signDocBytes).accountNumber, 0n);
  assert.equal(AuthInfo.decode(raw.authInfoBytes).signerInfos[0].sequence, 0n);
  // A bech32 recipient and a 0x recipient build the same message.
  assert.deepEqual(TxBody.decode(sendTx({ to: toBech32(hexToBytes(OTHER)) }).bodyBytes), TxBody.decode(sendTx().bodyBytes));
});

test('buildSendTx refuses bad input', () => {
  assert.throws(() => sendTx({ from: OTHER }), /does not match/);
  assert.throws(() => sendTx({ to: 'zetaphy1xyz' }), /invalid address/);
  assert.throws(() => sendTx({ amount: 0n }), /more than 0/);
  assert.throws(() => sendTx({ sign: () => new Uint8Array(64) }), /2420 bytes/);
  assert.throws(() => sendTx({ sequence: undefined }), /required/);
  assert.equal(TxRaw.decode(sendTx({ from: ME.bech32 }).txBytes).signatures.length, 1);
});

// ---- client against a fake node ----

function fakeNode({ exists = true, code = 0, log = '', balance = 10n ** 20n, chainId = CHAIN_ID } = {}) {
  const calls = [];
  const rpcCall = async (method, params) => {
    calls.push({ method, params });
    if (method === 'zetaphy_pqAccount') {
      const a = normalizeAddress(params[0]);
      return { address: a.bech32, hex: a.hex, chainId, denom: DENOM, exists, accountNumber: exists ? '42' : null, sequence: exists ? '5' : null };
    }
    if (method === 'eth_gasPrice') return '0x' + (10n ** 9n).toString(16);
    if (method === 'eth_getBalance') return '0x' + balance.toString(16);
    if (method === 'zetaphy_sendCosmosTx') return { txHash: txHashOf(hexToBytes(params[0])), code, log };
    throw new Error(`unexpected ${method}`);
  };
  return { rpcCall, calls };
}

test('client: send builds, signs and broadcasts with the node\'s account number and sequence', async () => {
  const node = fakeNode();
  const c = pqClient(node.rpcCall);
  const q = await c.quote({ publicKey });
  assert.equal(q.gasPrice, 1200000000n, 'eth_gasPrice x 1.2');
  assert.equal(q.fee, 400000n * 1200000000n);
  const r = await c.send({ publicKey, sign, to: OTHER, amount: parseZeta('1.5') });
  const sent = node.calls.find((x) => x.method === 'zetaphy_sendCosmosTx');
  const txBytes = hexToBytes(sent.params[0]);
  assert.equal(r.txHash, txHashOf(txBytes));
  const raw = TxRaw.decode(txBytes);
  const auth = AuthInfo.decode(raw.authInfoBytes);
  assert.equal(auth.signerInfos[0].sequence, 5n);
  assert.equal(auth.fee.amount[0].amount, String(400000n * 1200000000n));
  const doc = encodeSignDoc({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: CHAIN_ID, accountNumber: 42n });
  assert.ok(ml_dsa44.verify(raw.signatures[0], doc, publicKey));
  assert.equal(MsgSend.decode(TxBody.decode(raw.bodyBytes).messages[0].value).amount[0].amount, '1500000000000000000');
  assert.equal(node.calls.find((x) => x.method === 'eth_getBalance').params[0], ME.hex);
  // A fixed gas limit and price (as confirmed in the wallet) are used as given.
  const r2 = await c.send({ publicKey, sign, to: ME.bech32, amount: 1n, gasLimit: 250000n, gasPrice: 7n });
  assert.equal(r2.fee, 1750000n);
});

test('client: an account that does not exist yet says to fund it first', async () => {
  const node = fakeNode({ exists: false });
  const c = pqClient(node.rpcCall);
  const a = await c.account(ME.hex);
  assert.equal(a.exists, false);
  assert.equal(a.accountNumber, null);
  await assert.rejects(c.send({ publicKey, sign, to: OTHER, amount: 1n }), /send ZETAPHY to this address first/);
  assert.ok(!node.calls.some((x) => x.method === 'zetaphy_sendCosmosTx'));
});

test('client: a rejected tx (code != 0) is a clear error', async () => {
  const c = pqClient(fakeNode({ code: 5, log: 'insufficient funds' }).rpcCall);
  await assert.rejects(c.send({ publicKey, sign, to: OTHER, amount: 1n }), /rejected the transaction \(code 5\): insufficient funds/);
});

test('client: other refusals before anything is sent', async () => {
  await assert.rejects(pqClient(fakeNode({ balance: 1000n }).rpcCall).send({ publicKey, sign, to: OTHER, amount: 1n }), /not enough ZETAPHY/);
  await assert.rejects(pqClient(fakeNode({ chainId: 'evil-1' }).rpcCall).account(ME.bech32), /evil-1/);
  await assert.rejects(pqClient(async () => null).account(ME.bech32), /did not answer zetaphy_pqAccount/);
  await assert.rejects(pqClient(fakeNode().rpcCall).send({ publicKey, sign, to: 'zetaphy1bad', amount: 1n }), /invalid address/);
});

// ---- CLI against a local JSON-RPC server ----

test('CLI: zetaphy pq native and pq native send', async () => {
  const home = mkdtempSync(join(tmpdir(), 'zetaphy-pqtx-'));
  writeFileSync(join(home, 'pq.seed'), '0x' + bytesToHex(SEED) + '\n', { mode: 0o600 });
  process.env.ZETAPHY_HOME = home;
  let exists = false;
  const node = fakeNode();
  const answer = async ({ id, method, params }) => {
    if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0x12e4e' };
    if (method === 'zetaphy_pqAccount') {
      const a = normalizeAddress(params[0]);
      return { jsonrpc: '2.0', id, result: { address: a.bech32, hex: a.hex, chainId: CHAIN_ID, denom: DENOM, exists, accountNumber: exists ? '9' : null, sequence: exists ? '0' : null } };
    }
    return { jsonrpc: '2.0', id, result: await node.rpcCall(method, params) };
  };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    const out = Array.isArray(msg) ? await Promise.all(msg.map(answer)) : await answer(msg);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const rpc = `http://127.0.0.1:${server.address().port}`;
  try {
    const { main } = await import('../cli.js');
    const lines = [];
    const write = (l) => lines.push(l);
    assert.equal(await main(['pq', 'native', '--rpc', rpc], {}, write), 0);
    const out = lines.join('\n');
    assert.match(out, new RegExp(ME.bech32));
    assert.match(out, new RegExp(ME.hex));
    assert.match(out, /send ZETAPHY to this address first/);

    await assert.rejects(main(['pq', 'native', 'send', OTHER, '1', '--rpc', rpc], {}, write), /send ZETAPHY to this address first/);
    await assert.rejects(main(['pq', 'native', 'send', 'zetaphy1nope', '1', '--rpc', rpc], {}, write), /invalid address/);
    await assert.rejects(main(['pq', 'native', 'send', OTHER, '--rpc', rpc], {}, write), /usage/);

    exists = true;
    lines.length = 0;
    assert.equal(await main(['pq', 'native', 'send', toBech32(hexToBytes(OTHER)), '2.5', '--gas', '300000', '--rpc', rpc], {}, write), 0);
    const sent = node.calls.filter((x) => x.method === 'zetaphy_sendCosmosTx').at(-1);
    const raw = TxRaw.decode(hexToBytes(sent.params[0]));
    assert.equal(AuthInfo.decode(raw.authInfoBytes).fee.gasLimit, 300000n);
    const doc = encodeSignDoc({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: CHAIN_ID, accountNumber: 9n });
    assert.ok(ml_dsa44.verify(raw.signatures[0], doc, publicKey));
    assert.match(lines.join('\n'), new RegExp(`tx hash: ${txHashOf(hexToBytes(sent.params[0]))}`));
    assert.match(lines.join('\n'), /sent 2\.5 ZETAPHY/);
    assert.equal(DEFAULT_GAS_LIMIT, 400000n);
  } finally {
    server.close();
  }
});
