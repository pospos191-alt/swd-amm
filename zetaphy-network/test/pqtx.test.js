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
import { MsgDelegate, MsgUndelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx';
import { MsgWithdrawDelegatorReward } from 'cosmjs-types/cosmos/distribution/v1beta1/tx';
import { Interface, getCreateAddress } from 'ethers';
import {
  msgEVMDeploy, msgQuantumLock, encodeMsgQuantumLock, createAddress, stakingCall, quantumLockTx, MSG_QUANTUM_LOCK_TYPE_URL, PQ_LOCK_ADDRESS,
  STAKING_PRECOMPILE, DISTRIBUTION_PRECOMPILE, DEFAULT_DEPLOY_GAS_LIMIT, DEFAULT_PRECOMPILE_GAS_LIMIT,
  buildSendTx, buildTx, msgSend, msgDelegate, msgUndelegate, msgWithdrawRewards, msgEVMCall, encodeMsgEVMCall, validatorAddress,
  MSG_DELEGATE_TYPE_URL, MSG_UNDELEGATE_TYPE_URL, MSG_WITHDRAW_REWARD_TYPE_URL, MSG_EVM_CALL_TYPE_URL, VALOPER_PREFIX,
  DEFAULT_EVM_GAS_LIMIT, EVM_CALL_GAS_OVERHEAD, DEFAULT_STAKING_GAS_LIMIT, pqAddress, pqClient, toBech32, fromBech32, addressBytes, normalizeAddress, varint, bytesToHex, hexToBytes,
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

// ---- staking, rewards and EVM calls ----

const VALOPER = toBech32(ME.bytes, VALOPER_PREFIX); // any 20 bytes make a valid zetaphyvaloper1…

test('validator addresses: zetaphyvaloper1… only, checksum checked, upper case normalized', () => {
  assert.match(VALOPER, /^zetaphyvaloper1/);
  assert.equal(validatorAddress(VALOPER), VALOPER);
  assert.equal(validatorAddress(VALOPER.toUpperCase()), VALOPER);
  assert.throws(() => validatorAddress(ME.bech32), /expected zetaphyvaloper1/);
  assert.throws(() => validatorAddress(toBech32(ME.bytes, 'cosmosvaloper')), /expected zetaphyvaloper1/);
  assert.throws(() => validatorAddress(VALOPER.slice(0, -1) + (VALOPER.at(-1) === 'q' ? 'p' : 'q')), /checksum/);
  assert.throws(() => validatorAddress(ME.hex), /invalid address/);
});

test('MsgDelegate, MsgUndelegate, MsgWithdrawDelegatorReward match the official Cosmos SDK types', () => {
  for (const [build, T, typeUrl, spends] of [[msgDelegate, MsgDelegate, MSG_DELEGATE_TYPE_URL, true], [msgUndelegate, MsgUndelegate, MSG_UNDELEGATE_TYPE_URL, false]]) {
    const m = build({ delegator: ME.hex, validator: VALOPER, amount: 5n * 10n ** 18n });
    assert.equal(m.typeUrl, typeUrl);
    assert.equal(T.typeUrl, typeUrl);
    const d = T.decode(m.value);
    assert.deepEqual(T.encode(d).finish(), m.value, `${typeUrl} is canonical`);
    assert.deepEqual(d, { delegatorAddress: ME.bech32, validatorAddress: VALOPER, amount: { denom: DENOM, amount: '5000000000000000000' } });
    assert.deepEqual(m.value, T.encode(T.fromPartial({ delegatorAddress: ME.bech32, validatorAddress: VALOPER, amount: { denom: DENOM, amount: '5000000000000000000' } })).finish());
    assert.equal(m.spend, spends ? 5n * 10n ** 18n : 0n, 'only delegating takes ZETAPHY out of the balance');
    assert.throws(() => build({ delegator: ME.hex, validator: VALOPER, amount: 0n }), /more than 0/);
    assert.throws(() => build({ delegator: ME.hex, validator: ME.bech32, amount: 1n }), /zetaphyvaloper1/);
  }
  const w = msgWithdrawRewards({ delegator: ME.bech32, validator: VALOPER });
  assert.equal(w.typeUrl, MSG_WITHDRAW_REWARD_TYPE_URL);
  assert.equal(MsgWithdrawDelegatorReward.typeUrl, MSG_WITHDRAW_REWARD_TYPE_URL);
  assert.deepEqual(MsgWithdrawDelegatorReward.decode(w.value), { delegatorAddress: ME.bech32, validatorAddress: VALOPER });
  assert.deepEqual(MsgWithdrawDelegatorReward.encode(MsgWithdrawDelegatorReward.decode(w.value)).finish(), w.value);
});

// A hand-written proto3 decoder for MsgEVMCall (there is no cosmjs-types entry):
// it returns every field with its wire type and fails on anything unexpected.
function decodeFields(bytes) {
  const out = [];
  let i = 0;
  const readVarint = () => {
    let v = 0n; let shift = 0n;
    for (;;) {
      if (i >= bytes.length) throw new Error('truncated varint');
      const b = bytes[i++];
      v |= BigInt(b & 0x7f) << shift; shift += 7n;
      if (!(b & 0x80)) return v;
    }
  };
  while (i < bytes.length) {
    const k = readVarint();
    const field = Number(k >> 3n); const wire = Number(k & 7n);
    if (wire === 0) out.push({ field, wire, value: readVarint() });
    else if (wire === 2) {
      const n = Number(readVarint());
      if (i + n > bytes.length) throw new Error('truncated field');
      out.push({ field, wire, value: bytes.slice(i, i + n) }); i += n;
    } else throw new Error(`unexpected wire type ${wire}`);
  }
  return out;
}
function decodeMsgEVMCall(bytes) {
  const m = { sender: '', to: '', value: '', data: new Uint8Array(), gasLimit: 0n };
  // as_owner (6) is only in the result when it is set.
  const want = { 1: ['sender', 2], 2: ['to', 2], 3: ['value', 2], 4: ['data', 4], 5: ['gasLimit', 0], 6: ['asOwner', 2] };
  let last = 0;
  for (const f of decodeFields(bytes)) {
    assert.ok(want[f.field], `unknown field ${f.field}`);
    assert.ok(f.field > last, 'fields in order, each once');
    last = f.field;
    const [name, kind] = want[f.field];
    assert.equal(f.wire, kind === 0 ? 0 : 2, `wire type of ${name}`);
    m[name] = kind === 2 ? new TextDecoder().decode(f.value) : f.value;
  }
  return m;
}

test('MsgEVMCall: golden vector built by hand, and a hand-written decoder round trip', () => {
  // Fields in number order, each as <tag> <length> <bytes>; tag = field << 3 | wire type:
  //   0a = field 1 (sender), length-delimited      2e = 46 bytes "zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r"
  //   12 = field 2 (to), length-delimited          2a = 42 bytes "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
  //   1a = field 3 (value), length-delimited       04 = "1000"
  //   22 = field 4 (data), length-delimited        04 = a9059cbb (the transfer selector)
  //   28 = field 5 (gas_limit), varint             c0 9a 0c = 200000 (0x30d40 in 7-bit groups, low first: 0x40|0x80, 0x1a|0x80, 0x0c)
  const golden =
    '0a2e' + '7a65746170687931646b736e66366c756b71366a773035386a343873767364616a673864717561366e36376c3972'
    + '122a' + '307835614165623630353346334539344339623941303966333336363934333545374566314265416564'
    + '1a04' + '31303030'
    + '2204' + 'a9059cbb'
    + '28' + 'c09a0c';
  // The recipient is given in lower case; the message carries it EIP-55 checksummed.
  const m = msgEVMCall({ sender: ME.hex, to: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', value: 1000n, data: '0xa9059cbb', gasLimit: 200000n });
  assert.equal(m.typeUrl, MSG_EVM_CALL_TYPE_URL);
  assert.equal(MSG_EVM_CALL_TYPE_URL, '/zetaphy.pq.v1.MsgEVMCall');
  assert.equal(bytesToHex(m.value), golden);
  assert.equal(m.spend, 1000n);
  assert.deepEqual(decodeMsgEVMCall(m.value), { sender: ME.bech32, to: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', value: '1000', data: hexToBytes('a9059cbb'), gasLimit: 200000n });

  // Cross-check vector shared with the chain (zetaphy-chain/fork-tests checks the same hex in Go).
  assert.equal(bytesToHex(msgEVMCall({ sender: 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r', to: '0x0000000000000000000000000000000000000242',
    value: 5n, data: '0xa9059cbb000000000000', gasLimit: 200000n }).value),
  '0a2e7a65746170687931646b736e66366c756b71366a773035386a343873767364616a673864717561366e36376c3972'
    + '122a307830303030303030303030303030303030303030303030303030303030303030303030303030323432'
    + '1a0135' + '220aa9059cbb000000000000' + '28c09a0c');

  // Value 0 and no calldata: fields 3 and 4 are left out (proto3 defaults), gas_limit defaults to 200000.
  const plain = msgEVMCall({ sender: ME.bech32, to: OTHER });
  const fields = decodeFields(plain.value).map((f) => f.field);
  assert.deepEqual(fields, [1, 2, 5]);
  assert.equal(decodeMsgEVMCall(plain.value).gasLimit, DEFAULT_EVM_GAS_LIMIT);
  assert.equal(bytesToHex(encodeMsgEVMCall({ sender: 'a', to: 'b', value: 0n, data: new Uint8Array(), gasLimit: 1n })), '0a0161120162' + '2801');

  // A big value and large calldata still round trip.
  const data = Uint8Array.from({ length: 300 }, (_, i) => i & 255);
  const big = decodeMsgEVMCall(msgEVMCall({ sender: ME.bech32, to: OTHER, value: 10n ** 30n, data, gasLimit: 10_000_000n }).value);
  assert.equal(big.value, '1000000000000000000000000000000');
  assert.deepEqual(big.data, data);
  assert.equal(big.gasLimit, 10_000_000n);
});

test('MsgEVMCall refuses bad input', () => {
  assert.throws(() => msgEVMCall({ sender: ME.bech32, to: '' }), /use msgEVMDeploy to create a contract/);
  assert.throws(() => msgEVMCall({ sender: ME.bech32 }), /use msgEVMDeploy to create a contract/);
  assert.throws(() => msgEVMCall({ sender: ME.bech32, to: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD' }), /checksum/);
  assert.throws(() => msgEVMCall({ sender: ME.bech32, to: OTHER, value: -1n }), /negative/);
  assert.throws(() => msgEVMCall({ sender: ME.bech32, to: OTHER, data: '0x123' }), /invalid hex/);
  assert.throws(() => msgEVMCall({ sender: ME.bech32, to: OTHER, gasLimit: 20999n }), /between 21000 and 10000000/);
  assert.throws(() => msgEVMCall({ sender: ME.bech32, to: OTHER, gasLimit: 10_000_001n }), /between/);
  assert.throws(() => msgEVMCall({ sender: 'zetaphy1bad', to: OTHER }), /invalid address/);
});

test('buildTx with two messages: both in the body in order, one signature, cosmjs-types agree', () => {
  const messages = [
    msgEVMCall({ sender: ME.bech32, to: OTHER, value: 5n, data: '0x01', gasLimit: 50000n }),
    msgDelegate({ delegator: ME.bech32, validator: VALOPER, amount: 9n }),
  ];
  const tx = buildTx({ publicKey, sign, messages, accountNumber: 4n, sequence: 1n, gasLimit: 900000n, gasPrice: 3n, memo: 'two' });
  const raw = TxRaw.decode(tx.txBytes);
  assert.deepEqual(TxRaw.encode(raw).finish(), tx.txBytes);
  const body = TxBody.decode(raw.bodyBytes);
  assert.deepEqual(TxBody.encode(body).finish(), raw.bodyBytes);
  assert.deepEqual(body.messages.map((m) => m.typeUrl), [MSG_EVM_CALL_TYPE_URL, MSG_DELEGATE_TYPE_URL]);
  assert.deepEqual(body.messages[0].value, messages[0].value);
  assert.equal(MsgDelegate.decode(body.messages[1].value).amount.amount, '9');
  assert.equal(body.memo, 'two');
  const auth = AuthInfo.decode(raw.authInfoBytes);
  assert.equal(auth.fee.gasLimit, 900000n);
  assert.equal(tx.fee, 2700000n);
  assert.equal(raw.signatures.length, 1);
  assert.ok(ml_dsa44.verify(raw.signatures[0], encodeSignDoc({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: CHAIN_ID, accountNumber: 4n }), publicKey));
  // buildSendTx is buildTx with one MsgSend: same bytes.
  const viaBuildTx = buildTx({ publicKey, sign, messages: [msgSend({ from: ME.bech32, to: OTHER, amount: 1234567890123456789n })], accountNumber: 7n, sequence: 3n, gasLimit: 400000n, gasPrice: 12n, memo: 'hello' });
  assert.deepEqual(viaBuildTx.bodyBytes, sendTx().bodyBytes);
  assert.deepEqual(viaBuildTx.authInfoBytes, sendTx().authInfoBytes);

  const base = { publicKey, sign, accountNumber: 4n, sequence: 1n, gasPrice: 3n };
  assert.throws(() => buildTx({ ...base, messages: [] }), /at least one message/);
  assert.throws(() => buildTx({ ...base, messages: [{ typeUrl: 'MsgSend', value: new Uint8Array() }] }), /typeUrl/);
  assert.throws(() => buildTx({ ...base, messages: [{ typeUrl: '/x.Msg', value: 'ab' }] }), /encoded bytes/);
  assert.throws(() => buildTx({ ...base, messages, gasLimit: 0n }), /gasLimit must be more than 0/);
  assert.throws(() => buildTx({ ...base, messages, publicKey: publicKey.subarray(1) }), /1312 bytes/);
});

// ---- client against a fake node ----

// A tiny ERC-20 the fake node answers eth_call for: 6 decimals, symbol tUSD,
// the PQ account holds 1234.5 tUSD; transfer() of more reverts.
const TOKEN = '0x' + '22'.repeat(20);
const ERC20 = new Interface(['function transfer(address to, uint256 value) returns (bool)', 'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const TOKEN_BALANCE = 1234500000n;
const RUNTIME = '0x6080'; // what eth_call answers for any init code
function fakeEthCall({ to, data }) {
  if (!to) return RUNTIME; // a contract creation returns the runtime code
  if (to === STAKING_PRECOMPILE || to === DISTRIBUTION_PRECOMPILE) return '0x' + '00'.repeat(31) + '01';
  if (to.toLowerCase() !== TOKEN) return '0x';
  const tx = ERC20.parseTransaction({ data });
  if (tx.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [6]);
  if (tx.name === 'symbol') return ERC20.encodeFunctionResult('symbol', ['tUSD']);
  if (tx.name === 'balanceOf') return ERC20.encodeFunctionResult('balanceOf', [TOKEN_BALANCE]);
  if (tx.args[1] > TOKEN_BALANCE) throw new Error('execution reverted: balance');
  return ERC20.encodeFunctionResult('transfer', [true]);
}

/** accounts: zetaphy_pqAccount fields per bech32 address (e.g. quantumLockedTo, pubKeyType, sequence), over the defaults. */
function fakeNode({ exists = true, code = 0, log = '', balance = 10n ** 20n, chainId = CHAIN_ID, ethCall = fakeEthCall, accounts = {} } = {}) {
  const calls = [];
  const rpcCall = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_call') return ethCall(params[0]);
    if (method === 'eth_getCode') return params[0].toLowerCase() === TOKEN ? '0x6000' : '0x';
    if (method === 'zetaphy_pqAccount') {
      const a = normalizeAddress(params[0]);
      return { address: a.bech32, hex: a.hex, chainId, denom: DENOM, exists, accountNumber: exists ? '42' : null, sequence: exists ? '5' : null,
        pubKeyType: exists ? 'mldsa44' : null, quantumLockedTo: null, ...accounts[a.bech32] };
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

test('client: sendMsgs signs any messages, counts what they spend, refuses value + fee > balance', async () => {
  const fee = DEFAULT_STAKING_GAS_LIMIT * 1200000000n;
  const stake = 2n * 10n ** 18n;
  const exact = stake + fee;
  // Exactly enough: sent.
  let node = fakeNode({ balance: exact });
  let c = pqClient(node.rpcCall);
  const r = await c.sendMsgs({ publicKey, sign, messages: [msgDelegate({ delegator: ME.bech32, validator: VALOPER, amount: stake })], gasLimit: DEFAULT_STAKING_GAS_LIMIT });
  assert.equal(r.value, stake);
  assert.equal(r.fee, fee);
  const raw = TxRaw.decode(hexToBytes(node.calls.find((x) => x.method === 'zetaphy_sendCosmosTx').params[0]));
  assert.equal(r.txHash, txHashOf(TxRaw.encode(raw).finish()));
  assert.ok(ml_dsa44.verify(raw.signatures[0], encodeSignDoc({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: CHAIN_ID, accountNumber: 42n }), publicKey));
  assert.equal(AuthInfo.decode(raw.authInfoBytes).signerInfos[0].sequence, 5n);
  // One azetaphy short: refused, nothing sent.
  node = fakeNode({ balance: exact - 1n });
  c = pqClient(node.rpcCall);
  await assert.rejects(c.sendMsgs({ publicKey, sign, messages: [msgDelegate({ delegator: ME.bech32, validator: VALOPER, amount: stake })], gasLimit: DEFAULT_STAKING_GAS_LIMIT }), /not enough ZETAPHY: need 2\.0006 \(amount \+ fee\)/);
  // Two messages: their spends add up (an EVM value and a delegation).
  await assert.rejects(c.sendMsgs({ publicKey, sign, gasLimit: DEFAULT_STAKING_GAS_LIMIT, messages: [
    msgEVMCall({ sender: ME.bech32, to: OTHER, value: stake / 2n }), msgDelegate({ delegator: ME.bech32, validator: VALOPER, amount: stake / 2n })] }), /not enough ZETAPHY/);
  // An explicit value overrides the messages' own count.
  await assert.rejects(c.sendMsgs({ publicKey, sign, messages: [msgWithdrawRewards({ delegator: ME.bech32, validator: VALOPER })], value: exact }), /not enough/);
  assert.ok(!node.calls.some((x) => x.method === 'zetaphy_sendCosmosTx'), 'nothing was sent');
  // Fee only (undelegate and rewards take nothing): fine with little ZETAPHY.
  const u = await c.undelegate({ publicKey, sign, validator: VALOPER, amount: 10n ** 24n });
  assert.equal(u.value, 0n);
  assert.equal(u.validator, VALOPER);
  await assert.rejects(pqClient(fakeNode({ balance: 1n }).rpcCall).withdrawRewards({ publicKey, sign, validator: VALOPER }), /need 0\.0006 \(fee\)/);
  // An account that does not exist yet, and an empty list.
  await assert.rejects(pqClient(fakeNode({ exists: false }).rpcCall).sendMsgs({ publicKey, sign, messages: [msgWithdrawRewards({ delegator: ME.bech32, validator: VALOPER })] }), /send ZETAPHY to this address first/);
  await assert.rejects(c.sendMsgs({ publicKey, sign, messages: [] }), /at least one message/);
});

test('client: delegate, undelegate, withdrawRewards and callEVM put the right message in the tx', async () => {
  const node = fakeNode();
  const c = pqClient(node.rpcCall);
  const lastMsg = () => {
    const raw = TxRaw.decode(hexToBytes(node.calls.filter((x) => x.method === 'zetaphy_sendCosmosTx').at(-1).params[0]));
    return { body: TxBody.decode(raw.bodyBytes), auth: AuthInfo.decode(raw.authInfoBytes) };
  };
  await c.delegate({ publicKey, sign, validator: VALOPER.toUpperCase(), amount: 3n });
  let { body, auth } = lastMsg();
  assert.equal(body.messages[0].typeUrl, MSG_DELEGATE_TYPE_URL);
  assert.deepEqual(MsgDelegate.decode(body.messages[0].value), { delegatorAddress: ME.bech32, validatorAddress: VALOPER, amount: { denom: DENOM, amount: '3' } });
  assert.equal(auth.fee.gasLimit, DEFAULT_STAKING_GAS_LIMIT);
  await c.withdrawRewards({ publicKey, sign, validator: VALOPER, gasLimit: 300000n });
  ({ body, auth } = lastMsg());
  assert.deepEqual(MsgWithdrawDelegatorReward.decode(body.messages[0].value), { delegatorAddress: ME.bech32, validatorAddress: VALOPER });
  assert.equal(auth.fee.gasLimit, 300000n);
  await assert.rejects(c.delegate({ publicKey, sign, validator: ME.bech32, amount: 3n }), /zetaphyvaloper1/);

  // callEVM: eth_call first (from the account's 0x form), then the tx; tx gas = EVM gas + 400000.
  const data = ERC20.encodeFunctionData('transfer', [OTHER, 5n]);
  const r = await c.callEVM({ publicKey, sign, to: TOKEN, data, evmGasLimit: 60000n });
  const call = node.calls.filter((x) => x.method === 'eth_call').at(-1).params;
  assert.deepEqual(call, [{ from: ME.hex, to: normalizeAddress(TOKEN).hex, data, gas: '0xea60' }, 'latest']);
  assert.equal(r.result, ERC20.encodeFunctionResult('transfer', [true]));
  ({ body, auth } = lastMsg());
  assert.equal(auth.fee.gasLimit, 60000n + EVM_CALL_GAS_OVERHEAD);
  assert.equal(EVM_CALL_GAS_OVERHEAD, 400000n);
  assert.deepEqual(decodeMsgEVMCall(body.messages[0].value), { sender: ME.bech32, to: normalizeAddress(TOKEN).hex, value: '', data: hexToBytes(data), gasLimit: 60000n });
  // With value: eth_call carries it too, and the balance check counts it.
  const sends = () => node.calls.filter((x) => x.method === 'zetaphy_sendCosmosTx').length;
  const before = sends();
  await c.callEVM({ publicKey, sign, to: OTHER, value: 10n ** 18n });
  assert.equal(node.calls.filter((x) => x.method === 'eth_call').at(-1).params[0].value, '0xde0b6b3a7640000');
  assert.equal(lastMsg().auth.fee.gasLimit, DEFAULT_EVM_GAS_LIMIT + EVM_CALL_GAS_OVERHEAD);
  assert.equal(sends(), before + 1);
  // A call that would revert is refused before anything is signed or sent.
  await assert.rejects(c.callEVM({ publicKey, sign, to: TOKEN, data: ERC20.encodeFunctionData('transfer', [OTHER, TOKEN_BALANCE + 1n]) }), /would fail, so nothing was sent: execution reverted: balance/);
  await assert.rejects(c.callEVM({ publicKey, sign, to: TOKEN, data, checkResult: () => { throw new Error('refused by checkResult'); } }), /refused by checkResult/);
  await assert.rejects(pqClient(fakeNode({ balance: 10n ** 18n }).rpcCall).callEVM({ publicKey, sign, to: OTHER, value: 10n ** 18n }), /not enough ZETAPHY/);
  await assert.rejects(c.callEVM({ publicKey, sign, to: OTHER, evmGasLimit: 100000n, gasLimit: 100000n }), /more than the EVM gas limit/);
  assert.equal(sends(), before + 1);
  // check: false skips eth_call (for tests of the chain's own revert handling).
  const n2 = fakeNode({ ethCall: () => { throw new Error('should not be called'); } });
  await pqClient(n2.rpcCall).callEVM({ publicKey, sign, to: OTHER, check: false });
  assert.equal(n2.calls.filter((x) => x.method === 'zetaphy_sendCosmosTx').length, 1);
});

// ---- CLI against a local JSON-RPC server ----

// cli.js reads ZETAPHY_HOME once, when first imported: one temp home for every CLI test.
const CLI_HOME = mkdtempSync(join(tmpdir(), 'zetaphy-pqtx-'));
writeFileSync(join(CLI_HOME, 'pq.seed'), '0x' + bytesToHex(SEED) + '\n', { mode: 0o600 });
process.env.ZETAPHY_HOME = CLI_HOME;

test('CLI: zetaphy pq native and pq native send', async () => {
  let exists = false;
  const node = fakeNode();
  const answer = async ({ id, method, params }) => {
    if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0x12e4e' };
    if (method === 'zetaphy_pqAccount') {
      const a = normalizeAddress(params[0]);
      return { jsonrpc: '2.0', id, result: { address: a.bech32, hex: a.hex, chainId: CHAIN_ID, denom: DENOM, exists, accountNumber: exists ? '9' : null, sequence: exists ? '0' : null } };
    }
    try {
      return { jsonrpc: '2.0', id, result: await node.rpcCall(method, params) };
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
    }
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

test('CLI: pq native call, token-send, token-balance, stake, unstake, rewards', async () => {
  const node = fakeNode();
  const answer = async ({ id, method, params }) => {
    if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0x12e4e' };
    try {
      return { jsonrpc: '2.0', id, result: await node.rpcCall(method, params) };
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
    }
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
  const { main } = await import('../cli.js');
  const lines = [];
  const write = (l) => lines.push(l);
  const run = (...args) => main(['pq', 'native', ...args, '--rpc', rpc], {}, write);
  const lastTx = () => {
    const raw = TxRaw.decode(hexToBytes(node.calls.filter((x) => x.method === 'zetaphy_sendCosmosTx').at(-1).params[0]));
    return { body: TxBody.decode(raw.bodyBytes), auth: AuthInfo.decode(raw.authInfoBytes), raw };
  };
  const sends = () => node.calls.filter((x) => x.method === 'zetaphy_sendCosmosTx').length;
  try {
    // Argument checks, all before anything is sent.
    const bad = [
      [['call', OTHER], /usage: zetaphy pq native call/],
      [['call', OTHER, '0x', 'extra'], /usage: zetaphy pq native call/],
      [['call', ME.bech32, '0x'], /to must be a 0x address/],
      [['call', OTHER, '0x123'], /calldata must be 0x/],
      [['call', OTHER, 'abcd'], /calldata must be 0x/],
      [['call', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD', '0x'], /checksum/],
      [['call', OTHER, '0x', '--value', 'lots'], /not an amount/],
      [['call', OTHER, '0x', '--value'], /--value needs an amount/],
      [['call', OTHER, '0x', '--gas', '1.5'], /whole number/],
      [['call', OTHER, '0x', '--gas', '20000'], /between 21000 and 10000000/],
      [['send', OTHER, '1', '--value', '1'], /--value is only for/],
      [['token-send', TOKEN, OTHER], /usage: zetaphy pq native token-send/],
      [['token-send', 'zetaphy1x', OTHER, '1'], /token must be a 0x address/],
      [['token-send', TOKEN, 'zetaphy1nope', '1'], /invalid address/],
      [['token-send', TOKEN, OTHER, '-1'], /not an amount/],
      [['token-balance'], /usage: zetaphy pq native token-balance/],
      [['token-balance', 'nope'], /token must be a 0x address/],
      [['stake', VALOPER], /usage: zetaphy pq native stake/],
      [['stake', ME.bech32, '1'], /expected zetaphyvaloper1/],
      [['stake', VALOPER, '0'], /more than 0/],
      [['unstake', VALOPER.slice(0, -1) + (VALOPER.at(-1) === 'q' ? 'p' : 'q'), '1'], /checksum/],
      [['rewards'], /usage: zetaphy pq native rewards/],
      [['rewards', VALOPER, '5'], /usage: zetaphy pq native rewards/],
      [['frobnicate'], /usage: zetaphy pq native \[send \| call/],
    ];
    for (const [args, re] of bad) await assert.rejects(run(...args), re, args.join(' '));
    assert.equal(sends(), 0);

    // call with --value to a plain address; --gas is the EVM gas.
    assert.equal(await run('call', OTHER, '0x', '--value', '0.75', '--gas', '50000'), 0);
    let t = lastTx();
    assert.deepEqual(decodeMsgEVMCall(t.body.messages[0].value), { sender: ME.bech32, to: normalizeAddress(OTHER).hex, value: '750000000000000000', data: new Uint8Array(), gasLimit: 50000n });
    assert.equal(t.auth.fee.gasLimit, 450000n);
    assert.ok(ml_dsa44.verify(t.raw.signatures[0], encodeSignDoc({ bodyBytes: t.raw.bodyBytes, authInfoBytes: t.raw.authInfoBytes, chainId: CHAIN_ID, accountNumber: 42n }), publicKey));
    let out = lines.join('\n');
    assert.match(out, /value 0\.75 ZETAPHY/);
    assert.match(out, /EVM gas 50000, tx gas 450000/);
    assert.match(out, /tx hash: [0-9A-F]{64}/);
    assert.match(out, /not in eth_getLogs/);

    // token-balance and token-send read decimals() and symbol() first.
    lines.length = 0;
    assert.equal(await run('token-balance', TOKEN), 0);
    assert.match(lines.join('\n'), /token tUSD at 0x2222222222222222222222222222222222222222 \(6 decimals\)/);
    assert.match(lines.join('\n'), /holds 1234\.5 tUSD/);
    lines.length = 0;
    assert.equal(await run('token-send', TOKEN, toBech32(hexToBytes(OTHER)), '12.5'), 0);
    t = lastTx();
    const m = decodeMsgEVMCall(t.body.messages[0].value);
    assert.equal(m.to, normalizeAddress(TOKEN).hex);
    assert.equal(m.value, '');
    assert.equal(m.gasLimit, DEFAULT_EVM_GAS_LIMIT);
    const tr = ERC20.decodeFunctionData('transfer', m.data);
    assert.equal(tr[0], normalizeAddress(OTHER).hex, 'a zetaphy1… recipient becomes its 0x form');
    assert.equal(tr[1], 12500000n);
    assert.match(lines.join('\n'), /sent 12\.5 tUSD to 0x1111111111111111111111111111111111111111/);
    const n = sends();
    await assert.rejects(run('token-send', TOKEN, OTHER, '1.0000001'), /more decimal places than tUSD \(6\)/);
    await assert.rejects(run('token-send', TOKEN, OTHER, '0'), /more than 0/);
    await assert.rejects(run('token-send', TOKEN, OTHER, '5000'), /would fail, so nothing was sent/);
    await assert.rejects(run('token-send', OTHER, OTHER, '1'), /no contract at/);
    assert.equal(sends(), n, 'nothing sent for refused token sends');

    // Staking.
    lines.length = 0;
    assert.equal(await run('stake', VALOPER, '3'), 0);
    t = lastTx();
    assert.deepEqual(MsgDelegate.decode(t.body.messages[0].value), { delegatorAddress: ME.bech32, validatorAddress: VALOPER, amount: { denom: DENOM, amount: '3000000000000000000' } });
    assert.equal(t.auth.fee.gasLimit, DEFAULT_STAKING_GAS_LIMIT);
    assert.match(lines.join('\n'), new RegExp(`staked 3 ZETAPHY with ${VALOPER}`));
    assert.equal(await run('unstake', VALOPER, '1.5', '--gas', '600000'), 0);
    t = lastTx();
    assert.equal(t.body.messages[0].typeUrl, MSG_UNDELEGATE_TYPE_URL);
    assert.equal(MsgUndelegate.decode(t.body.messages[0].value).amount.amount, '1500000000000000000');
    assert.equal(t.auth.fee.gasLimit, 600000n);
    assert.equal(await run('rewards', VALOPER), 0);
    t = lastTx();
    assert.deepEqual(MsgWithdrawDelegatorReward.decode(t.body.messages[0].value), { delegatorAddress: ME.bech32, validatorAddress: VALOPER });
    assert.match(lines.join('\n'), /withdrew staking rewards/);
  } finally {
    server.close();
  }
});

// ---- quantum lock, as_owner and contract creation ----

const OWNER = 'zetaphy1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zcpxmne'; // 0x2222…22, an ECDSA account locked to ME
const OWNER_HEX = '0x' + '22'.repeat(20);
const NEW_CTRL = 'zetaphy1xvenxvenxvenxvenxvenxvenxvenxven2l3xxt'; // 0x3333…33, another ML-DSA-44 account
const str = (s) => Buffer.from(s).toString('hex');

function decodeMsgQuantumLock(bytes) {
  const m = {};
  const names = { 1: 'signer', 2: 'owner', 3: 'controller' };
  for (const f of decodeFields(bytes)) {
    assert.ok(names[f.field] && f.wire === 2, `field ${f.field}`);
    m[names[f.field]] = new TextDecoder().decode(f.value);
  }
  return m;
}

test('MsgEVMCall as_owner (field 6) and contract creation (no field 2): golden vectors built by hand', () => {
  // as_owner = field 6, length-delimited: tag 6 << 3 | 2 = 0x32.
  assert.equal(bytesToHex(encodeMsgEVMCall({ sender: 'a', to: 'b', gasLimit: 1n, asOwner: 'c' })), '0a0161' + '120162' + '2801' + '320163');
  // Without as_owner nothing changes (the existing chain vector above still holds).
  assert.equal(bytesToHex(encodeMsgEVMCall({ sender: 'a', to: 'b', gasLimit: 1n })), '0a0161120162' + '2801');
  // A real one: value 7, gas 21000 (0x5208: 0x08|0x80, 0xa4 = 0x24|0x80, 0x01), owner given as 0x, sent as zetaphy1….
  const m = msgEVMCall({ sender: ME.hex, to: OTHER, value: 7n, gasLimit: 21000n, asOwner: OWNER_HEX });
  assert.equal(bytesToHex(m.value),
    '0a2e' + str(ME.bech32) + '122a' + str('0x1111111111111111111111111111111111111111') + '1a01' + '37' + '28' + '88a401' + '322e' + str(OWNER));
  assert.equal(OWNER.length, 0x2e);
  assert.equal(m.spend, 0n, 'the value leaves the owner, not the signer');
  assert.equal(m.ownerSpend, 7n);
  assert.deepEqual(decodeMsgEVMCall(m.value), { sender: ME.bech32, to: '0x1111111111111111111111111111111111111111', value: '7', data: new Uint8Array(), gasLimit: 21000n, asOwner: OWNER });

  // Creation: field 2 left out (empty to), init code as data, 3,000,000 EVM gas by default (0x2dc6c0 -> c0 8d b7 01).
  const d = msgEVMDeploy({ sender: ME.bech32, initCode: '0x6000' });
  assert.equal(bytesToHex(d.value), '0a2e' + str(ME.bech32) + '2202' + '6000' + '28' + 'c08db701');
  assert.equal(DEFAULT_DEPLOY_GAS_LIMIT, 3000000n);
  assert.deepEqual(decodeFields(d.value).map((f) => f.field), [1, 4, 5]);
  assert.equal(d.spend, 0n);
  assert.equal(msgEVMDeploy({ sender: ME.bech32, initCode: '0x6000', value: 9n }).spend, 9n);
  assert.equal(decodeMsgEVMCall(msgEVMDeploy({ sender: ME.bech32, initCode: '0x6000', asOwner: OWNER }).value).asOwner, OWNER);

  assert.throws(() => msgEVMDeploy({ sender: ME.bech32, initCode: '0x' }), /needs init code/);
  assert.throws(() => msgEVMDeploy({ sender: ME.bech32 }), /needs init code/);
  assert.throws(() => msgEVMCall({ sender: ME.bech32, to: OTHER, asOwner: ME.hex }), /as_owner is the sender itself/);
  assert.throws(() => msgEVMCall({ sender: ME.bech32, to: OTHER, asOwner: 'zetaphy1bad' }), /invalid address/);
});

test('MsgQuantumLock: golden vectors, all three addresses as zetaphy1…', () => {
  assert.equal(MSG_QUANTUM_LOCK_TYPE_URL, '/zetaphy.pq.v1.MsgQuantumLock');
  // signer = 1 (0a), owner = 2 (12), controller = 3 (1a), each a 1-byte string.
  assert.equal(bytesToHex(encodeMsgQuantumLock({ signer: 'a', owner: 'b', controller: 'c' })), '0a01611201621a0163');
  const m = msgQuantumLock({ signer: ME.hex, owner: OWNER_HEX, controller: NEW_CTRL.toUpperCase() });
  assert.equal(m.typeUrl, MSG_QUANTUM_LOCK_TYPE_URL);
  assert.equal(bytesToHex(m.value), '0a2e' + str(ME.bech32) + '122e' + str(OWNER) + '1a2e' + str(NEW_CTRL));
  assert.deepEqual(decodeMsgQuantumLock(m.value), { signer: ME.bech32, owner: OWNER, controller: NEW_CTRL });
  assert.equal(m.spend, 0n);
  assert.throws(() => msgQuantumLock({ signer: ME.hex, owner: OWNER, controller: OWNER_HEX }), /another account than the owner/);
  assert.throws(() => msgQuantumLock({ signer: ME.hex, owner: OWNER, controller: '0x1234' }), /40 hex/);
});

test('quantumLockTx: an EVM tx to 0x…5051 with no value and the controller\'s 20 bytes as data', () => {
  assert.equal(PQ_LOCK_ADDRESS, '0x0000000000000000000000000000000000005051');
  assert.deepEqual(quantumLockTx(ME.bech32), { to: PQ_LOCK_ADDRESS, value: 0n, data: '0x' + bytesToHex(ME.bytes) });
  assert.equal(quantumLockTx(ME.hex).data, '0x6da134ebfcb035273e87954f0641bd920ed073ba');
  assert.equal((quantumLockTx(ME.hex).data.length - 2) / 2, 20, 'exactly 20 bytes, no selector');
  assert.throws(() => quantumLockTx('zetaphy1bad'), /invalid address/);
});

test('createAddress: keccak256(rlp([sender, nonce]))[12:], known vectors and ethers agree', () => {
  // Widely used vectors for CREATE.
  assert.equal(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 0).toLowerCase(), '0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d');
  assert.equal(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 1).toLowerCase(), '0x343c43a37d37dff08ae8c4a11544c718abb4fcf8');
  assert.equal(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 2).toLowerCase(), '0xf778b86fa74e846c4f0a1fbd1335fe81c00a0c91');
  // RLP edge cases: 0 is the empty string, 1..127 one byte, 128 needs a length prefix.
  for (const n of [0, 1, 0x7f, 0x80, 0xff, 0x100, 0xffff, 0x10000, 2 ** 32, 2 ** 53 - 1]) {
    assert.equal(createAddress(ME.hex, n), getCreateAddress({ from: ME.hex, nonce: n }), `nonce ${n}`);
  }
  assert.equal(createAddress(ME.bech32, 5n), getCreateAddress({ from: ME.hex, nonce: 5 }), 'zetaphy1… works too');
  assert.throws(() => createAddress(ME.hex, -1n), /uint64/);
  assert.throws(() => createAddress(ME.hex, 2n ** 64n), /uint64/);
});

test('stakingCall: calldata for the staking and distribution precompiles matches ethers', () => {
  const S = new Interface(['function delegate(address delegatorAddress, string validatorAddress, uint256 amount) returns (bool)',
    'function undelegate(address delegatorAddress, string validatorAddress, uint256 amount) returns (int64)']);
  const D = new Interface(['function withdrawDelegatorRewards(address delegatorAddress, string validatorAddress) returns (tuple(string denom, uint256 amount)[])']);
  assert.equal(STAKING_PRECOMPILE, '0x0000000000000000000000000000000000000800');
  assert.equal(DISTRIBUTION_PRECOMPILE, '0x0000000000000000000000000000000000000801');
  const d = stakingCall({ action: 'delegate', delegator: OWNER, validator: VALOPER.toUpperCase(), amount: 3n * 10n ** 18n });
  assert.equal(d.to, STAKING_PRECOMPILE);
  assert.equal('0x' + bytesToHex(d.data), S.encodeFunctionData('delegate', [OWNER_HEX, VALOPER, 3n * 10n ** 18n]));
  // Hand check of the layout: selector, address word, string offset (0x60), amount, then length and bytes.
  const hex = bytesToHex(d.data);
  assert.equal(hex.slice(0, 8), S.getFunction('delegate').selector.slice(2));
  assert.equal(hex.slice(8, 72), '0'.repeat(24) + '22'.repeat(20));
  assert.equal(BigInt('0x' + hex.slice(72, 136)), 0x60n);
  assert.equal(BigInt('0x' + hex.slice(200, 264)), BigInt(VALOPER.length));
  const u = stakingCall({ action: 'undelegate', delegator: OWNER_HEX, validator: VALOPER, amount: 1n });
  assert.equal('0x' + bytesToHex(u.data), S.encodeFunctionData('undelegate', [OWNER_HEX, VALOPER, 1n]));
  const w = stakingCall({ action: 'withdrawRewards', delegator: OWNER_HEX, validator: VALOPER });
  assert.equal(w.to, DISTRIBUTION_PRECOMPILE);
  assert.equal('0x' + bytesToHex(w.data), D.encodeFunctionData('withdrawDelegatorRewards', [OWNER_HEX, VALOPER]));
  assert.throws(() => stakingCall({ action: 'delegate', delegator: OWNER, validator: VALOPER, amount: 0n }), /more than 0/);
  assert.throws(() => stakingCall({ action: 'delegate', delegator: OWNER, validator: OWNER, amount: 1n }), /zetaphyvaloper1/);
  assert.throws(() => stakingCall({ action: 'redelegate', delegator: OWNER, validator: VALOPER, amount: 1n }), /unknown staking action/);
});

/** The last broadcast tx's single message, after checking its signature. */
function lastSent(node) {
  const raw = TxRaw.decode(hexToBytes(node.calls.filter((x) => x.method === 'zetaphy_sendCosmosTx').at(-1).params[0]));
  assert.ok(ml_dsa44.verify(raw.signatures[0], encodeSignDoc({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: CHAIN_ID, accountNumber: 42n }), publicKey));
  const body = TxBody.decode(raw.bodyBytes);
  assert.equal(body.messages.length, 1);
  return { msg: body.messages[0], auth: AuthInfo.decode(raw.authInfoBytes) };
}
const sentCount = (node) => node.calls.filter((x) => x.method === 'zetaphy_sendCosmosTx').length;
const lockedToMe = { [OWNER]: { quantumLockedTo: ME.bech32, pubKeyType: 'eth_secp256k1', sequence: '3' } };

test('client: as_owner send, call, token transfer and staking: checked against quantumLockedTo, run as the owner', async () => {
  const node = fakeNode({ accounts: lockedToMe });
  const c = pqClient(node.rpcCall);
  // send: a MsgEVMCall to the recipient with the value; tx gas = EVM gas + overhead.
  const s = await c.send({ publicKey, sign, to: OTHER, amount: 10n ** 18n, asOwner: OWNER_HEX });
  assert.equal(s.asOwner.bech32, OWNER);
  let { msg, auth } = lastSent(node);
  assert.equal(msg.typeUrl, MSG_EVM_CALL_TYPE_URL);
  assert.deepEqual(decodeMsgEVMCall(msg.value), { sender: ME.bech32, to: normalizeAddress(OTHER).hex, value: '1000000000000000000', data: new Uint8Array(), gasLimit: DEFAULT_EVM_GAS_LIMIT, asOwner: OWNER });
  assert.equal(auth.fee.gasLimit, DEFAULT_EVM_GAS_LIMIT + EVM_CALL_GAS_OVERHEAD);
  const sim = node.calls.filter((x) => x.method === 'eth_call').at(-1).params[0];
  assert.equal(sim.from, normalizeAddress(OWNER).hex, 'simulated as the owner');
  assert.equal(sim.value, '0xde0b6b3a7640000');
  // The owner's balance pays the value: refused when the owner is short, even if the signer is rich.
  await assert.rejects(pqClient(fakeNode({ accounts: lockedToMe, balance: 10n ** 18n }).rpcCall).send({ publicKey, sign, to: OTHER, amount: 2n * 10n ** 18n, asOwner: OWNER }),
    new RegExp(`${OWNER} does not have enough ZETAPHY`));

  // ERC-20 transfer as the owner.
  const data = ERC20.encodeFunctionData('transfer', [OTHER, 5n]);
  const r = await c.callEVM({ publicKey, sign, to: TOKEN, data, asOwner: OWNER });
  assert.equal(r.result, ERC20.encodeFunctionResult('transfer', [true]));
  ({ msg } = lastSent(node));
  assert.equal(decodeMsgEVMCall(msg.value).asOwner, OWNER);
  assert.equal(node.calls.filter((x) => x.method === 'eth_call').at(-1).params[0].from, normalizeAddress(OWNER).hex);

  // Staking as the owner goes through the precompiles, with msg.sender = delegator = owner.
  await c.delegate({ publicKey, sign, validator: VALOPER, amount: 3n, asOwner: OWNER });
  ({ msg, auth } = lastSent(node));
  let m = decodeMsgEVMCall(msg.value);
  assert.equal(m.to, STAKING_PRECOMPILE);
  assert.equal(m.value, '', 'a delegation carries no EVM value');
  assert.deepEqual(m.data, stakingCall({ action: 'delegate', delegator: OWNER, validator: VALOPER, amount: 3n }).data);
  assert.equal(m.gasLimit, DEFAULT_PRECOMPILE_GAS_LIMIT);
  assert.equal(auth.fee.gasLimit, DEFAULT_PRECOMPILE_GAS_LIMIT + EVM_CALL_GAS_OVERHEAD);
  await c.undelegate({ publicKey, sign, validator: VALOPER, amount: 2n, asOwner: OWNER, evmGasLimit: 400000n });
  m = decodeMsgEVMCall(lastSent(node).msg.value);
  assert.deepEqual(m.data, stakingCall({ action: 'undelegate', delegator: OWNER, validator: VALOPER, amount: 2n }).data);
  assert.equal(m.gasLimit, 400000n);
  await c.withdrawRewards({ publicKey, sign, validator: VALOPER, asOwner: OWNER });
  m = decodeMsgEVMCall(lastSent(node).msg.value);
  assert.equal(m.to, DISTRIBUTION_PRECOMPILE);
  assert.equal(m.asOwner, OWNER);
  // A delegation larger than the owner's balance is refused before signing.
  await assert.rejects(pqClient(fakeNode({ accounts: lockedToMe, balance: 10n ** 18n }).rpcCall).delegate({ publicKey, sign, validator: VALOPER, amount: 10n ** 19n, asOwner: OWNER }), /does not have enough/);

  // Not locked, or locked to someone else: refused before anything is signed.
  const n = sentCount(node);
  const notMine = fakeNode({ accounts: { [OWNER]: { quantumLockedTo: NEW_CTRL } } });
  await assert.rejects(pqClient(notMine.rpcCall).send({ publicKey, sign, to: OTHER, amount: 1n, asOwner: OWNER }), new RegExp(`quantum-locked to ${NEW_CTRL}, not to ${ME.bech32}`));
  await assert.rejects(pqClient(fakeNode().rpcCall).delegate({ publicKey, sign, validator: VALOPER, amount: 1n, asOwner: OWNER }), /is not quantum-locked to/);
  assert.equal(sentCount(notMine), 0);
  // check: false skips the checks (so a devnet test can see the chain refuse it).
  await pqClient(notMine.rpcCall).send({ publicKey, sign, to: OTHER, amount: 1n, asOwner: OWNER, check: false });
  assert.equal(sentCount(notMine), 1);
  assert.equal(sentCount(node), n);
});

test('client: deploy predicts the address from the sequence; as the owner from the owner\'s sequence', async () => {
  const node = fakeNode({ accounts: lockedToMe });
  const c = pqClient(node.rpcCall);
  const r = await c.deploy({ publicKey, sign, initCode: '0x60806040', value: 5n });
  // Signed with sequence 5; the ante handler bumps it to 6 before the message runs, the
  // creation takes nonce 6, and the account's sequence ends at 7.
  assert.equal(r.sequence, 5n);
  assert.equal(r.created, getCreateAddress({ from: ME.hex, nonce: 6 }));
  const { msg, auth } = lastSent(node);
  assert.deepEqual(decodeMsgEVMCall(msg.value), { sender: ME.bech32, to: '', value: '5', data: hexToBytes('60806040'), gasLimit: DEFAULT_DEPLOY_GAS_LIMIT });
  assert.equal(auth.fee.gasLimit, DEFAULT_DEPLOY_GAS_LIMIT + EVM_CALL_GAS_OVERHEAD);
  const sim = node.calls.filter((x) => x.method === 'eth_call').at(-1).params[0];
  assert.deepEqual(sim, { from: ME.hex, data: '0x60806040', gas: '0x2dc6c0', value: '0x5' }, 'simulated as a creation (no to)');

  const o = await c.deploy({ publicKey, sign, initCode: '0x6000', asOwner: OWNER, evmGasLimit: 1000000n });
  assert.equal(o.created, getCreateAddress({ from: OWNER_HEX, nonce: 3 }), 'the owner\'s sequence, not bumped by this tx');
  assert.equal(decodeMsgEVMCall(lastSent(node).msg.value).asOwner, OWNER);

  // An init code that fails in eth_call is not sent.
  const bad = fakeNode({ ethCall: () => { throw new Error('execution reverted'); } });
  await assert.rejects(pqClient(bad.rpcCall).deploy({ publicKey, sign, initCode: '0xfe' }), /would fail, so nothing was sent/);
  assert.equal(sentCount(bad), 0);
});

test('client: quantumLockHandover signs MsgQuantumLock after checking both accounts', async () => {
  const accounts = { ...lockedToMe, [NEW_CTRL]: { pubKeyType: 'mldsa44' } };
  const node = fakeNode({ accounts });
  const c = pqClient(node.rpcCall);
  const r = await c.quantumLockHandover({ publicKey, sign, owner: OWNER_HEX, controller: NEW_CTRL });
  assert.equal(r.owner.bech32, OWNER);
  assert.equal(r.controller.bech32, NEW_CTRL);
  const { msg, auth } = lastSent(node);
  assert.equal(msg.typeUrl, MSG_QUANTUM_LOCK_TYPE_URL);
  assert.deepEqual(decodeMsgQuantumLock(msg.value), { signer: ME.bech32, owner: OWNER, controller: NEW_CTRL });
  assert.equal(auth.fee.gasLimit, DEFAULT_GAS_LIMIT);

  const refuse = async (acc, re) => {
    const n = fakeNode({ accounts: acc });
    await assert.rejects(pqClient(n.rpcCall).quantumLockHandover({ publicKey, sign, owner: OWNER, controller: NEW_CTRL }), re);
    assert.equal(sentCount(n), 0);
  };
  await refuse({ [NEW_CTRL]: { pubKeyType: 'mldsa44' } }, /is not quantum-locked to/);
  await refuse({ ...lockedToMe, [NEW_CTRL]: { pubKeyType: 'eth_secp256k1' } }, /not an ML-DSA-44 account/);
  await refuse({ ...lockedToMe, [NEW_CTRL]: { pubKeyType: null } }, /no ML-DSA-44 public key on chain/);
  await refuse({ ...lockedToMe, [NEW_CTRL]: { exists: false, pubKeyType: null } }, /no ML-DSA-44 public key on chain/);
  await refuse({ ...lockedToMe, [NEW_CTRL]: { pubKeyType: 'mldsa44', quantumLockedTo: ME.bech32 } }, /itself quantum-locked/);
  await assert.rejects(c.quantumLockHandover({ publicKey, sign, owner: OWNER, controller: OWNER_HEX }), /another account than the owner/);
  // checkController on its own, as the CLI and the wallet use it before a MetaMask lock.
  assert.equal((await c.checkController(NEW_CTRL, OWNER)).address.bech32, NEW_CTRL);
  await assert.rejects(c.checkController(OWNER, OWNER), /another account/);
});

/** A local JSON-RPC server for cli.js, answering from `node`. */
async function rpcServer(node) {
  const answer = async ({ id, method, params }) => {
    if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0x12e4e' };
    try {
      return { jsonrpc: '2.0', id, result: await node.rpcCall(method, params) };
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
    }
  };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    const out = Array.isArray(msg) ? await Promise.all(msg.map(answer)) : await answer(msg);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, rpc: `http://127.0.0.1:${server.address().port}` };
}

test('CLI: pq native deploy, --as, handover, lock-ecdsa refusals, and the lock shown in account info', async () => {
  const node = fakeNode({ accounts: { ...lockedToMe, [NEW_CTRL]: { pubKeyType: 'mldsa44' } } });
  const { server, rpc } = await rpcServer(node);
  const { main } = await import('../cli.js');
  const lines = [];
  const write = (l) => lines.push(l);
  const run = (...args) => main(['pq', 'native', ...args, '--rpc', rpc], {}, write);
  try {
    const bad = [
      [['deploy'], /usage: zetaphy pq native deploy/],
      [['deploy', '0x'], /must not be empty/],
      [['deploy', '6000'], /init code must be 0x/],
      [['deploy', '0x6000', '--gas', '20000'], /between 21000 and 10000000/],
      [['send', OTHER, '1', '--as'], /--as needs the address/],
      [['send', OTHER, '1', '--as', 'zetaphy1nope'], /invalid address/],
      [['handover', OWNER], /usage: zetaphy pq native handover/],
      [['handover', OWNER, NEW_CTRL, '--as', OWNER], /--as is not for "pq native handover"/],
      [['stake', VALOPER, '1', '--as', OWNER, '--gas', '20000'], /--gas \(EVM gas\)/],
      [['send', OTHER, '1', '--yes'], /--yes is only for/],
      [['lock-ecdsa', NEW_CTRL, 'extra'], /usage: zetaphy pq native lock-ecdsa/],
      [['token-send', TOKEN, OTHER, '1', '--value', '1'], /--value is only for/],
    ];
    for (const [args, re] of bad) await assert.rejects(run(...args), re, args.join(' '));
    assert.equal(sentCount(node), 0);

    // deploy prints the predicted address.
    assert.equal(await run('deploy', '0x60806040', '--value', '0.5', '--gas', '2000000'), 0);
    assert.match(lines.join('\n'), new RegExp(`created contract ${getCreateAddress({ from: ME.hex, nonce: 6 })} from ${ME.bech32}`));
    let m = decodeMsgEVMCall(lastSent(node).msg.value);
    assert.equal(m.to, '');
    assert.equal(m.value, '500000000000000000');
    assert.equal(m.gasLimit, 2000000n);

    // --as on send, token-send, stake, unstake, rewards and token-balance.
    lines.length = 0;
    assert.equal(await run('send', OTHER, '1.5', '--as', OWNER_HEX), 0);
    m = decodeMsgEVMCall(lastSent(node).msg.value);
    assert.equal(m.asOwner, OWNER);
    assert.equal(m.value, '1500000000000000000');
    assert.match(lines.join('\n'), new RegExp(`sent 1\\.5 ZETAPHY .* from ${OWNER} \\(0x2222222222222222222222222222222222222222, quantum-locked to ${ME.bech32}, which signed\\)`));
    assert.equal(await run('token-send', TOKEN, OTHER, '2', '--as', OWNER), 0);
    m = decodeMsgEVMCall(lastSent(node).msg.value);
    assert.equal(m.asOwner, OWNER);
    assert.equal(ERC20.decodeFunctionData('transfer', m.data)[1], 2000000n);
    lines.length = 0;
    assert.equal(await run('token-balance', TOKEN, '--as', OWNER), 0);
    assert.match(lines.join('\n'), new RegExp(`${OWNER} \\(0x2222222222222222222222222222222222222222\\) holds 1234\\.5 tUSD`));
    assert.equal(await run('stake', VALOPER, '3', '--as', OWNER, '--gas', '900000'), 0);
    m = decodeMsgEVMCall(lastSent(node).msg.value);
    assert.equal(m.to, STAKING_PRECOMPILE);
    assert.equal(m.gasLimit, 900000n, 'with --as, --gas is EVM gas');
    assert.match(lines.join('\n'), /through the staking precompile/);
    assert.equal(await run('unstake', VALOPER, '1', '--as', OWNER), 0);
    assert.equal(decodeMsgEVMCall(lastSent(node).msg.value).gasLimit, DEFAULT_PRECOMPILE_GAS_LIMIT);
    assert.equal(await run('rewards', VALOPER, '--as', OWNER), 0);
    assert.equal(decodeMsgEVMCall(lastSent(node).msg.value).to, DISTRIBUTION_PRECOMPILE);
    await assert.rejects(run('send', OTHER, '1', '--as', NEW_CTRL), /is not quantum-locked to/);

    // handover.
    lines.length = 0;
    assert.equal(await run('handover', OWNER_HEX, NEW_CTRL), 0);
    assert.deepEqual(decodeMsgQuantumLock(lastSent(node).msg.value), { signer: ME.bech32, owner: OWNER, controller: NEW_CTRL });
    assert.match(lines.join('\n'), new RegExp(`handed control of ${OWNER} .* to ${NEW_CTRL}`));

    // Account info shows the lock.
    lines.length = 0;
    assert.equal(await run('--as', OWNER), 0);
    assert.match(lines.join('\n'), new RegExp(`quantum-locked to: ${ME.bech32} \\(this account`));
    lines.length = 0;
    assert.equal(await run('--as', NEW_CTRL), 0);
    assert.match(lines.join('\n'), /not quantum-locked/);

    // lock-ecdsa: warns, needs --yes, and checks the controller first. Nothing is sent here.
    const n = sentCount(node);
    lines.length = 0;
    await assert.rejects(run('lock-ecdsa', NEW_CTRL), /run again with --yes/);
    assert.match(lines.join('\n'), /PERMANENT/);
    assert.ok(!/0x[0-9a-f]{64}\b/i.test(lines.join('\n').replace(/tx hash: \S+/g, '')), 'no key printed');
    await assert.rejects(run('lock-ecdsa', OWNER, '--yes'), /quantum-locked|not an ML-DSA-44/);
    assert.equal(sentCount(node), n);
    assert.ok(!node.calls.some((x) => x.method === 'eth_sendRawTransaction'));
  } finally {
    server.close();
  }
});
