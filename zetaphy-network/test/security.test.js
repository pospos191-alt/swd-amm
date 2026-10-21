// The security core's client side (src/pqtx.js): the Q-day migration text,
// salt and commitment (zetaphy-chain QDayRevealText / QDayCommitment), the
// new messages' wire format, consent calldata and the threat-gate refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, SigningKey, hashMessage, hexlify, Interface, sha256, concat, toUtf8Bytes, getBytes } from 'ethers';
import {
  qdayRevealText, qdaySalt, qdayCommitment, msgQDayCommit, msgQDayReveal, msgIBCHoldCancel, msgConsent, consentCall,
  messageFromIntent, parseThreatRefusal, bytesToHex, pqAddress, SECURITY_PRECOMPILE, MAX_CONSENT_SECONDS,
  MSG_QDAY_COMMIT_TYPE_URL, MSG_QDAY_REVEAL_TYPE_URL, MSG_IBC_HOLD_CANCEL_TYPE_URL, MSG_EVM_CALL_TYPE_URL,
} from '../src/pqtx.js';

const owner = new Wallet('0x' + '11'.repeat(32));
const controller = '0x00000000000000000000000000000000000B0b00';

// The same vector is in zetaphy-chain/fork-tests/evmd/zetaphy_security_test.go
// (TestQDayVectorMatchesJavaScript): both sides must agree byte for byte.
export const VECTOR = {
  chainId: 'zetaphy_77390-1',
  owner: owner.address,
  controller,
};

function migration() {
  const text = qdayRevealText({ owner: owner.address, controller });
  const sig = owner.signingKey.sign(hashMessage(text)).serialized;
  const pub = SigningKey.computePublicKey(SigningKey.recoverPublicKey(hashMessage(text), sig), true);
  const salt = qdaySalt(sig);
  return { text, sig, pub, salt, commitment: qdayCommitment({ publicKey: pub, controller, salt }) };
}

test('Q-day migration text, salt and commitment', () => {
  const m = migration();
  assert.equal(m.text, `ZETAPHY Q-day migration\nChain: zetaphy_77390-1\nAccount: ${owner.address}\nNew ML-DSA-44 controller: ${controller}\nSign this only in the ZETAPHY wallet.`);
  // An independent computation of the commitment.
  const expect = sha256(concat([toUtf8Bytes('zetaphy/qday-commit\0zetaphy_77390-1\0'), m.pub, controller, m.salt]));
  assert.equal(hexlify(m.commitment), expect);
  console.log(`vector: sig ${m.sig} commitment ${hexlify(m.commitment)}`);
  assert.equal(hexlify(m.commitment), '0x5a438ce634b3440817d5b28d472f435e173b140eb90dacfcffe3888c686a5c72');
  // Another controller or chain: another commitment.
  assert.notEqual(hexlify(qdayCommitment({ publicKey: m.pub, controller: owner.address, salt: m.salt })), hexlify(m.commitment));
  assert.notEqual(hexlify(qdayCommitment({ chainId: 'other', publicKey: m.pub, controller, salt: m.salt })), hexlify(m.commitment));
  assert.throws(() => qdayCommitment({ publicKey: SigningKey.computePublicKey(m.pub, false), controller, salt: m.salt }), /compressed/);
  assert.throws(() => qdayCommitment({ publicKey: m.pub, controller, salt: new Uint8Array(31) }), /32 bytes/);
});

test('Q-day messages: wire format and intents (what the Snap rebuilds)', () => {
  const signer = pqAddress(new Uint8Array(1312).fill(3)).bech32;
  const m = migration();
  const c = msgQDayCommit({ signer, commitment: m.commitment });
  assert.equal(c.typeUrl, MSG_QDAY_COMMIT_TYPE_URL);
  // field 1 signer (string), field 2 commitment (32 bytes)
  assert.equal(bytesToHex(c.value), '0a' + (signer.length).toString(16).padStart(2, '0') + Buffer.from(signer).toString('hex') + '1220' + bytesToHex(m.commitment));
  assert.deepEqual(messageFromIntent(c.intent, signer).value, c.value);
  const r = msgQDayReveal({ signer, owner: owner.address, controller, salt: m.salt, signature: m.sig });
  assert.equal(r.typeUrl, MSG_QDAY_REVEAL_TYPE_URL);
  assert.deepEqual(messageFromIntent(r.intent, signer).value, r.value);
  assert.throws(() => msgQDayReveal({ signer, owner: owner.address, controller, salt: m.salt, signature: getBytes(m.sig).slice(0, 64) }), /65 bytes/);
  const x = msgIBCHoldCancel({ signer, id: 7 });
  assert.equal(x.typeUrl, MSG_IBC_HOLD_CANCEL_TYPE_URL);
  assert.ok(bytesToHex(x.value).endsWith('1007'));
  assert.deepEqual(messageFromIntent(x.intent, signer).value, x.value);
});

test('consent(target, seconds) on the security precompile', () => {
  const target = '0x00000000000000000000000000000000005Ca400'; // EIP-55
  const iface = new Interface(['function consent(address target, uint64 seconds) returns (uint64)']);
  const call = consentCall(target, 3600);
  assert.equal(call.to, SECURITY_PRECOMPILE);
  assert.equal('0x' + bytesToHex(call.data), iface.encodeFunctionData('consent', [target, 3600]));
  assert.throws(() => consentCall(target, MAX_CONSENT_SECONDS + 1), /a day/);
  const signer = pqAddress(new Uint8Array(1312).fill(4)).bech32;
  const m = msgConsent({ sender: signer, target, seconds: 600 });
  assert.equal(m.typeUrl, MSG_EVM_CALL_TYPE_URL);
  assert.deepEqual(m.intent, { type: 'consent', target, seconds: '600' });
  assert.deepEqual(messageFromIntent(m.intent, signer).value, m.value);
});

test('a threat-gate refusal is read back for the wallet', () => {
  const text = 'failed to execute message; 0x00000000000000000000000000000000005cA400 has an enforced flag in the Neuro threat registry 0x1111111111111111111111111111111111111111 (reason: SweepsApprovedTokens). Nothing was done.';
  assert.deepEqual(parseThreatRefusal(text), { target: '0x00000000000000000000000000000000005cA400', registry: '0x1111111111111111111111111111111111111111', reason: 'SweepsApprovedTokens' });
  assert.equal(parseThreatRefusal('insufficient funds'), null);
});
