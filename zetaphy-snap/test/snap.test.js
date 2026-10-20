// The built snap (dist/bundle.js) in MetaMask's simulated environment
// (@metamask/snaps-jest): its account, its confirmation dialog for every kind of
// message, rejection, the signature, and malformed requests.
//   npm run build && npm test
import { describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';
import { SLIP10Node } from '@metamask/key-tree';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createHash } from 'node:crypto';
import { TxRaw, TxBody, AuthInfo, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { MsgDelegate, MsgUndelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx';
import { MsgWithdrawDelegatorReward } from 'cosmjs-types/cosmos/distribution/v1beta1/tx';
import { accountFromSeed, ENTROPY_SALT } from '../src/account.js';
import {
  pqAddress, bytesToHex, hexToBytes, encodeMsgEVMCall, encodeMsgQuantumLock, stakingCall, PQ_LOCK_ADDRESS,
} from '../src/pqtx.js';

const SNAP_ID = 'local:http://localhost:18096'; // jest.config.js fixes the port
const ORIGIN = 'https://wallet.zetaphy.test';
const SRP = 'test test test test test test test test test test test ball'; // snaps-jest's default
const OTHER_SRP = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const TO = 'zetaphy1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3huramw'; // 0x1111…11
const TO_HEX = '0x1111111111111111111111111111111111111111';
const VALOPER = 'zetaphyvaloper1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zfnr6v8'; // 0x2222…22
const TOKEN = '0x3333333333333333333333333333333333333333';
const OWNER = 'zetaphy1g3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zy4seeq9'; // 0x4444…44, a locked MetaMask account
const OWNER_HEX = '0x4444444444444444444444444444444444444444';
const NEW_CTRL = 'zetaphy1242424242424242424242424242424248wwy4h'; // 0x5555…55
const BASE = { chainId: 'zetaphy-testnet-1', accountNumber: '12', sequence: '4', gasLimit: '400000', gasPrice: '1200000000' };
const word = (v) => BigInt(v).toString(16).padStart(64, '0');

/** SIP-6, written out: what snap_getEntropy gives this snap for an SRP (BIP-32 secp256k1 under m/1399742832'). */
async function sip6Entropy(mnemonic, snapId, salt) {
  const utf8 = (s) => new TextEncoder().encode(s);
  const input = utf8(snapId);
  const hash = keccak_256(new Uint8Array([...input, ...keccak_256(utf8(salt))]));
  const view = new DataView(hash.buffer, hash.byteOffset, 32);
  const path = Array.from({ length: 8 }, (_, i) => `bip32:${view.getUint32(i * 4) & 0x7fffffff}'`);
  const node = await SLIP10Node.fromDerivationPath({ derivationPath: [`bip39:${mnemonic}`, "bip32:1399742832'", ...path], curve: 'secp256k1' });
  return node.privateKeyBytes;
}

/** Every line of a dialog: headings, texts, "label: value" rows, banner titles. */
function linesOf(node, out = []) {
  const flat = (c) => (c == null || typeof c === 'boolean' ? '' : typeof c === 'string' ? c : Array.isArray(c) ? c.map(flat).join('') : flat(c.props?.children));
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { for (const n of node) linesOf(n, out); return out; }
  if (typeof node === 'string') { out.push(node); return out; }
  const { type, props = {} } = node;
  if (type === 'Text' || type === 'Heading') out.push(flat(props.children));
  else if (type === 'Row') out.push(`${props.label}: ${flat(props.children)}`);
  else {
    if (type === 'Banner') out.push(props.title);
    linesOf(props.children, out);
  }
  return out;
}
const textOf = (ui) => linesOf(ui.content).join('\n');

/** Sends zetaphy_signTx, approves (or not) the dialog, and returns { text, response }. */
async function sign(snap, params, { approve = true, origin = ORIGIN } = {}) {
  const pending = snap.request({ origin, method: 'zetaphy_signTx', params });
  const ui = await pending.getInterface();
  expect(ui.type).toBe('confirmation');
  const text = textOf(ui);
  if (approve) await ui.ok(); else await ui.cancel();
  return { text, response: await pending };
}

let me; // the snap's account for SRP
async function snapAccount(snap) {
  const r = await snap.request({ origin: ORIGIN, method: 'zetaphy_getAccount' });
  return r.response.result;
}

/** The signed tx: the signature verifies over the SignDoc, rebuilt here with cosmjs-types. */
function decodeSigned(result, { chainId = BASE.chainId, accountNumber = 12n } = {}) {
  const raw = TxRaw.decode(hexToBytes(result.txHex));
  const doc = SignDoc.encode(SignDoc.fromPartial({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId, accountNumber })).finish();
  expect(raw.signatures).toHaveLength(1);
  expect('0x' + bytesToHex(raw.signatures[0])).toBe(result.signature);
  expect(ml_dsa44.verify(raw.signatures[0], doc, hexToBytes(me.publicKey))).toBe(true);
  expect(result.txHash).toBe(createHash('sha256').update(hexToBytes(result.txHex)).digest('hex').toUpperCase());
  expect(result.bodyBytes).toBe('0x' + bytesToHex(raw.bodyBytes));
  const body = TxBody.decode(raw.bodyBytes); const auth = AuthInfo.decode(raw.authInfoBytes);
  expect(auth.signerInfos[0].publicKey.typeUrl).toBe('/zetaphy.crypto.mldsa44.PubKey');
  return { body, auth, msg: body.messages[0] };
}

describe('the account', () => {
  it('uses the address formula of pqtx.js: seed 0x00..1f gives the known vector', () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const a = accountFromSeed(seed);
    expect(a.address.hex).toBe('0x6DA134EbFcb035273E87954f0641bD920ED073Ba');
    expect(a.address.bech32).toBe('zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r');
    expect(a.publicKey).toHaveLength(1312);
    expect(a.publicKey).toEqual(ml_dsa44.keygen(seed).publicKey);
    expect(pqAddress(a.publicKey)).toEqual(a.address);
    const h = createHash('sha256').update(Buffer.concat([Buffer.from('zetaphy/mldsa44\0'), Buffer.from(a.publicKey)])).digest('hex').slice(0, 40);
    expect(a.address.hex.slice(2).toLowerCase()).toBe(h);
    expect(() => accountFromSeed(seed.subarray(1))).toThrow(/32 bytes/);
  });

  it('zetaphy_getAccount is ML-DSA-44 of SIP-6 entropy: the same for the same SRP, another for another SRP', async () => {
    const snap = await installSnap(SNAP_ID, { options: { secretRecoveryPhrase: SRP } });
    me = await snapAccount(snap);
    expect(Object.keys(me).sort()).toEqual(['address', 'hex', 'publicKey']);
    // Recomputed outside MetaMask from the SRP, the snap ID and the salt alone.
    const entropy = await sip6Entropy(SRP, SNAP_ID, ENTROPY_SALT);
    const expected = accountFromSeed(entropy);
    expect(me.publicKey).toBe('0x' + bytesToHex(expected.publicKey));
    expect(me.address).toBe(expected.address.bech32);
    expect(me.hex).toBe(expected.address.hex);
    expect(me.address).toBe(pqAddress(hexToBytes(me.publicKey)).bech32);
    // Nothing secret in the answer.
    const all = JSON.stringify(me).toLowerCase();
    expect(all).not.toContain(bytesToHex(entropy));
    // (An ML-DSA secret key starts with rho, which the public key also starts with: check K and s1.)
    expect(all).not.toContain(bytesToHex(expected.secretKey.slice(32, 64)));
    expect(all).not.toContain(bytesToHex(expected.secretKey.slice(128, 192)));

    const again = await snapAccount(await installSnap(SNAP_ID, { options: { secretRecoveryPhrase: SRP } }));
    expect(again).toEqual(me);
    const other = await snapAccount(await installSnap(SNAP_ID, { options: { secretRecoveryPhrase: OTHER_SRP } }));
    expect(other.address).not.toBe(me.address);
    expect(other.address).toBe(accountFromSeed(await sip6Entropy(OTHER_SRP, SNAP_ID, ENTROPY_SALT)).address.bech32);
  });
});

describe('zetaphy_signTx', () => {
  const install = async () => {
    const snap = await installSnap(SNAP_ID, { options: { secretRecoveryPhrase: SRP } });
    me = me ?? await snapAccount(snap);
    return snap;
  };

  it('send: shows recipient, amount, denom, fee and chain, then signs a MsgSend that verifies', async () => {
    const snap = await install();
    const { text, response } = await sign(snap, { ...BASE, memo: 'rent', messages: [{ type: 'send', to: TO_HEX, amount: '1250000000000000000' }] });
    expect(text).toMatch(/^Sign a ZETAPHY transaction/);
    expect(text).toContain(`Requested by: ${ORIGIN}`);
    expect(text).toMatch(new RegExp(`To\\n${TO}`));
    expect(text).toMatch(new RegExp(`To \\(0x form\\)\\n${TO_HEX}`));
    expect(text).toContain('Amount: 1.25 ZETAPHY');
    expect(text).toContain('Max fee: 0.00048 ZETAPHY');
    expect(text).toContain('Gas limit × price: 400000 × 1200000000 azetaphy');
    expect(text).toContain('Your account pays (ZETAPHY amounts + max fee): 1.25048 ZETAPHY');
    expect(text).toContain('Memo: rent');
    expect(text).toContain('Chain: zetaphy-testnet-1');
    expect(text).toContain('Account number / sequence: 12 / 4');
    expect(text).toContain(me.address);
    expect(text).not.toMatch(/Not ZETAPHY testnet/);
    const { msg, body, auth } = decodeSigned(response.response.result);
    expect(msg.typeUrl).toBe('/cosmos.bank.v1beta1.MsgSend');
    expect(MsgSend.decode(msg.value)).toEqual({ fromAddress: me.address, toAddress: TO, amount: [{ denom: 'azetaphy', amount: '1250000000000000000' }] });
    expect(body.memo).toBe('rent');
    expect(auth.signerInfos[0].sequence).toBe(4n);
    expect(auth.fee).toEqual(expect.objectContaining({ gasLimit: 400000n, amount: [{ denom: 'azetaphy', amount: '480000000000000' }] }));
  });

  it('send of another denom, on another ZETAPHY chain: both said plainly', async () => {
    const snap = await install();
    const { text, response } = await sign(snap, { ...BASE, chainId: 'zetaphy-local-1', messages: [{ type: 'send', to: TO, amount: 42, denom: 'ibc/27394FB092D2ECCD' }] });
    expect(text).toContain('Amount: 42 ibc/27394FB092D2ECCD');
    expect(text).toContain('Not ZETAPHY testnet');
    expect(text).toContain('This transaction is for the chain zetaphy-local-1, not zetaphy-testnet-1.');
    expect(text).toContain('Your account pays (ZETAPHY amounts + max fee): 0.00048 ZETAPHY');
    const { msg } = decodeSigned(response.response.result, { chainId: 'zetaphy-local-1' });
    expect(MsgSend.decode(msg.value).amount).toEqual([{ denom: 'ibc/27394FB092D2ECCD', amount: '42' }]);
  });

  it('staking: validator and amount for delegate and undelegate, validator for rewards', async () => {
    const snap = await install();
    let r = await sign(snap, { ...BASE, gasLimit: '500000', messages: [{ type: 'delegate', validator: VALOPER.toUpperCase(), amount: '3000000000000000000' }] });
    expect(r.text).toContain('Stake (delegate)');
    expect(r.text).toMatch(new RegExp(`Validator\\n${VALOPER}`)); // canonical lower case
    expect(r.text).toContain('Amount: 3 ZETAPHY');
    expect(r.text).toContain('Your account pays (ZETAPHY amounts + max fee): 3.0006 ZETAPHY');
    expect(MsgDelegate.decode(decodeSigned(r.response.response.result).msg.value)).toEqual({ delegatorAddress: me.address, validatorAddress: VALOPER, amount: { denom: 'azetaphy', amount: '3000000000000000000' } });

    r = await sign(snap, { ...BASE, gasLimit: '500000', messages: [{ type: 'undelegate', validator: VALOPER, amount: '1000000000000000000' }] });
    expect(r.text).toContain('Unstake (undelegate)');
    expect(r.text).toContain('Amount: 1 ZETAPHY');
    expect(r.text).toContain('unbonding period');
    expect(r.text).toContain('Your account pays (ZETAPHY amounts + max fee): 0.0006 ZETAPHY');
    expect(MsgUndelegate.decode(decodeSigned(r.response.response.result).msg.value).amount.amount).toBe('1000000000000000000');

    r = await sign(snap, { ...BASE, messages: [{ type: 'withdrawRewards', validator: VALOPER }] });
    expect(r.text).toContain('Claim staking rewards');
    expect(r.text).toContain(VALOPER);
    expect(MsgWithdrawDelegatorReward.decode(decodeSigned(r.response.response.result).msg.value)).toEqual({ delegatorAddress: me.address, validatorAddress: VALOPER });
  });

  it('MsgEVMCall: the contract and the method (an ERC-20 transfer read out), EVM gas, and the signed call', async () => {
    const snap = await install();
    const data = '0xa9059cbb' + word(TO_HEX) + word(2_500_000);
    const { text, response } = await sign(snap, { ...BASE, gasLimit: '600000', messages: [{ type: 'evmCall', to: TOKEN, data, gasLimit: '200000' }] });
    expect(text).toContain('Call a contract');
    expect(text).toMatch(new RegExp(`Contract\\n${TOKEN}`, 'i'));
    expect(text).toMatch(/Method\ntransfer\(address,uint256\) · ERC-20/);
    expect(text).toMatch(/Token recipient\n0x1111111111111111111111111111111111111111/);
    expect(text).toContain('Token amount (smallest units): 2500000');
    expect(text).toContain('EVM gas limit: 200000');
    expect(text).toContain('Max fee: 0.00072 ZETAPHY');
    expect(text).not.toMatch(/cannot be read|Acting for/);
    const { msg } = decodeSigned(response.response.result);
    expect(msg.typeUrl).toBe('/zetaphy.pq.v1.MsgEVMCall');
    expect(msg.value).toEqual(encodeMsgEVMCall({ sender: me.address, to: '0x3333333333333333333333333333333333333333', data: hexToBytes(data), gasLimit: 200000n }));
  });

  it('MsgEVMCall: an unknown method is named by its selector with the raw data and a warning; an approval warns too', async () => {
    const snap = await install();
    let r = await sign(snap, { ...BASE, gasLimit: '600000', messages: [{ type: 'evmCall', to: TOKEN, data: '0xdeadbeef' + word(7), value: '500000000000000000' }] });
    expect(r.text).toContain('Method: unknown method 0xdeadbeef');
    expect(r.text).toContain(`Call data\n0xdeadbeef${word(7)}`);
    expect(r.text).toContain('This call cannot be read');
    expect(r.text).toContain(`Approve only if you trust ${ORIGIN}`);
    expect(r.text).toContain('ZETAPHY sent with it: 0.5 ZETAPHY');
    expect(r.text).toContain('Your account pays (ZETAPHY amounts + max fee): 0.50072 ZETAPHY');
    decodeSigned(r.response.response.result);

    const unlimited = '0x095ea7b3' + word(TO_HEX) + 'f'.repeat(64);
    r = await sign(snap, { ...BASE, gasLimit: '600000', messages: [{ type: 'evmCall', to: TOKEN, data: unlimited }] });
    expect(r.text).toMatch(/Method\napprove\(address,uint256\) · ERC-20/);
    expect(r.text).toContain('Allowance (smallest units): UNLIMITED');
    expect(r.text).toContain('Token approval');
    expect(r.text).toContain(`This lets ${TO_HEX} move your tokens`);

    // No data: a plain transfer through the EVM.
    r = await sign(snap, { ...BASE, gasLimit: '600000', messages: [{ type: 'evmCall', to: TO, value: '1' }] });
    expect(r.text).toContain('Send ZETAPHY (EVM transfer)');
    expect(r.text).toMatch(new RegExp(`To\\n${TO_HEX}`));
    expect(r.text).toContain('ZETAPHY sent with it: 0.000000000000000001 ZETAPHY');
  });

  it('as_owner and the staking precompile: who acts, the delegator, validator and amount', async () => {
    const snap = await install();
    const c = stakingCall({ action: 'delegate', delegator: OWNER_HEX, validator: VALOPER, amount: 3n * 10n ** 18n });
    const { text, response } = await sign(snap, { ...BASE, gasLimit: '700000', messages: [{ type: 'evmCall', to: c.to, data: '0x' + bytesToHex(c.data), gasLimit: '300000', asOwner: OWNER_HEX }] });
    expect(text).toMatch(/Contract\n0x0000000000000000000000000000000000000800 \(staking precompile\)/);
    expect(text).toMatch(/Method\ndelegate\(address,string,uint256\) · staking precompile/);
    expect(text).toMatch(new RegExp(`Delegator\\n${OWNER_HEX}`));
    expect(text).toMatch(new RegExp(`Validator\\n${VALOPER}`));
    expect(text).toContain('Amount: 3 ZETAPHY');
    expect(text).toMatch(new RegExp(`Acting for \\(as_owner\\)\\n${OWNER}\\n${OWNER_HEX}`));
    expect(text).toContain(`Funds and tokens leave ${OWNER_HEX}, which is quantum-locked to your account`);
    expect(text).toContain('Your account pays (ZETAPHY amounts + max fee): 0.00084 ZETAPHY'); // the owner pays the stake
    const { msg } = decodeSigned(response.response.result);
    expect(msg.value).toEqual(encodeMsgEVMCall({ sender: me.address, to: c.to, data: c.data, gasLimit: 300000n, asOwner: OWNER }));
  });

  it('deploy: says "Create a contract", the code size and hash; signs a MsgEVMCall with no "to"', async () => {
    const snap = await install();
    const initCode = '0x6080604052348015600f57600080fd5b50';
    const { text, response } = await sign(snap, { ...BASE, gasLimit: '3400000', messages: [{ type: 'evmDeploy', initCode }] });
    expect(text).toContain('Create a contract (deploy)');
    expect(text).toContain('Method: deploy (new contract)');
    expect(text).toContain('Contract code: 17 bytes');
    expect(text).toMatch(new RegExp(`Code hash \\(keccak-256\\)\\n0x${bytesToHex(keccak_256(hexToBytes(initCode)))}`));
    expect(text).toContain('EVM gas limit: 3000000');
    const { msg } = decodeSigned(response.response.result);
    expect(msg.value).toEqual(encodeMsgEVMCall({ sender: me.address, to: '', data: hexToBytes(initCode), gasLimit: 3000000n }));
  });

  it('quantum-lock handover: the locked account and the new controller, with a plain warning', async () => {
    const snap = await install();
    const { text, response } = await sign(snap, { ...BASE, messages: [{ type: 'quantumLock', owner: OWNER_HEX, controller: NEW_CTRL }] });
    expect(text).toContain('Hand over a quantum-locked account');
    expect(text).toMatch(new RegExp(`Locked account\\n${OWNER}\\n${OWNER_HEX}`));
    expect(text).toMatch(new RegExp(`New controller\\n${NEW_CTRL}`));
    expect(text).toContain('You give up control');
    expect(text).toContain(`your account can no longer act for ${OWNER}; only ${NEW_CTRL} can`);
    const { msg } = decodeSigned(response.response.result);
    expect(msg.typeUrl).toBe('/zetaphy.pq.v1.MsgQuantumLock');
    expect(msg.value).toEqual(encodeMsgQuantumLock({ signer: me.address, owner: OWNER, controller: NEW_CTRL }));
  });

  it('several messages are numbered, and the dialog follows lang: "th"', async () => {
    const snap = await install();
    const { text, response } = await sign(snap, { ...BASE, lang: 'th', gasLimit: '900000', messages: [
      { type: 'send', to: TO, amount: '1000000000000000000' },
      { type: 'delegate', validator: VALOPER, amount: '2000000000000000000' },
      { type: 'evmCall', to: PQ_LOCK_ADDRESS, data: '0x' + '55'.repeat(20) },
    ] });
    expect(text).toMatch(/^เซ็นธุรกรรม ZETAPHY/);
    expect(text).toContain('1. โอน');
    expect(text).toContain('2. Stake (delegate)');
    expect(text).toContain('3. เรียกสัญญา');
    expect(text).toContain('จำนวน: 1 ZETAPHY');
    expect(text).toContain('ค่าธรรมเนียมสูงสุด: 0.00108 ZETAPHY');
    expect(text).toContain('บัญชีคุณจ่าย (จำนวน ZETAPHY + ค่าธรรมเนียมสูงสุด): 3.00108 ZETAPHY');
    expect(text).toContain('นี่คือการเรียกที่อยู่ล็อกควอนตัม');
    expect(decodeSigned(response.response.result).body.messages.map((m) => m.typeUrl)).toEqual(['/cosmos.bank.v1beta1.MsgSend', '/cosmos.staking.v1beta1.MsgDelegate', '/zetaphy.pq.v1.MsgEVMCall']);
  });

  it('rejected in the dialog: an error (4001) and no signature', async () => {
    const snap = await install();
    const { response } = await sign(snap, { ...BASE, messages: [{ type: 'send', to: TO, amount: '1' }] }, { approve: false });
    expect(response).toRespondWithError(expect.objectContaining({ code: 4001, message: expect.stringContaining('nothing was signed') }));
    expect(response.response.result).toBeUndefined();
    expect(JSON.stringify(response.response)).not.toMatch(/signature|txHex/);
  });

  it('malformed input is refused before any dialog, with -32602', async () => {
    const snap = await install();
    const send = { type: 'send', to: TO, amount: '1' };
    const bad = [
      [[BASE], /params must be an object/],
      [{ ...BASE, messages: [send], signDoc: '0x0a' }, /unknown field "signDoc"/],
      [{ ...BASE, messages: [send], bodyBytes: '0x0a' }, /unknown field "bodyBytes"/],
      [{ ...BASE, chainId: 'cosmoshub-4', messages: [send] }, /ZETAPHY chain id/],
      [{ ...BASE, chainId: undefined, messages: [send] }, /"chainId" is required/],
      [{ ...BASE, messages: [] }, /non-empty array/],
      [{ ...BASE, messages: Array(9).fill(send) }, /at most 8 messages/],
      [{ ...BASE, messages: [{ ...send, type: 'mint' }] }, /type must be one of/],
      [{ ...BASE, messages: [{ ...send, from: OWNER }] }, /unknown field "from"/],
      [{ ...BASE, messages: [{ type: 'send', to: TO }] }, /"amount" is required/],
      [{ ...BASE, messages: [{ ...send, to: TO.slice(0, -1) + 'q' }] }, /invalid address/],
      [{ ...BASE, messages: [{ ...send, to: '0x6Da134EbFcb035273E87954f0641bD920ED073Ba' }] }, /checksum/],
      [{ ...BASE, messages: [{ ...send, amount: '0' }] }, /at least 1/],
      [{ ...BASE, messages: [{ ...send, amount: '-5' }] }, /whole number/],
      [{ ...BASE, messages: [{ ...send, amount: '1.5' }] }, /whole number/],
      [{ ...BASE, messages: [{ ...send, amount: 1e30 }] }, /whole number/],
      [{ ...BASE, messages: [{ ...send, denom: 'a' }] }, /denom/],
      [{ ...BASE, messages: [{ type: 'delegate', validator: TO, amount: '1' }] }, /zetaphyvaloper1/],
      [{ ...BASE, messages: [{ type: 'evmCall', to: TOKEN, data: '0x123' }] }, /hex bytes/],
      [{ ...BASE, messages: [{ type: 'evmCall', to: TOKEN, data: '0x' + '00'.repeat(49153) }] }, /longer than 49152 bytes/],
      [{ ...BASE, messages: [{ type: 'evmCall', to: TOKEN, gasLimit: '1000' }] }, /EVM gas limit must be between/],
      [{ ...BASE, gasLimit: '200000', messages: [{ type: 'evmCall', to: TOKEN }] }, /more than the EVM gas limits/],
      [{ ...BASE, messages: [{ type: 'evmCall', to: TOKEN, asOwner: me.address }] }, /as_owner is the sender itself/],
      [{ ...BASE, messages: [{ type: 'evmDeploy', initCode: '0x' }] }, /needs init code/],
      [{ ...BASE, messages: [{ type: 'quantumLock', owner: OWNER, controller: OWNER_HEX }] }, /another account than the owner/],
      [{ ...BASE, gasLimit: '0', messages: [send] }, /gasLimit must be at least 1/],
      [{ ...BASE, gasPrice: '1' + '0'.repeat(30), messages: [send] }, /gasPrice must be at most/],
      [{ ...BASE, accountNumber: '18446744073709551616', messages: [send] }, /accountNumber must be at most/],
      [{ ...BASE, memo: 'pay ‮evil', messages: [send] }, /control or invisible/],
      [{ ...BASE, memo: 'x'.repeat(257), messages: [send] }, /at most 256 characters/],
      [{ ...BASE, lang: 'fr', messages: [send] }, /lang must be/],
    ];
    for (const [params, why] of bad) {
      // Awaited directly: a dialog would block the request, so an answer means none was shown.
      const r = await snap.request({ origin: ORIGIN, method: 'zetaphy_signTx', params });
      expect(r).toRespondWithError(expect.objectContaining({ code: -32602 }));
      expect(r.response.error.message).toMatch(why);
    }
    const unknown = await snap.request({ origin: ORIGIN, method: 'zetaphy_exportKey' });
    expect(unknown).toRespondWithError(expect.objectContaining({ code: -32601 }));
  });
});
