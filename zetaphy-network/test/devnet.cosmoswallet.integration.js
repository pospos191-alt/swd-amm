// Cosmos wallets (Keplr, Leap, Cosmostation) on a real ZETAPHY devnet: what
// such a wallet does on an "eth-key-sign" chain (Evmos-style), done by hand
// with no wallet library, so each step the chain must accept is visible:
//   key      BIP39 mnemonic -> m/44'/60'/0'/0/0 (coin type 60), address =
//            keccak256(public key)[12:], the same 20 bytes as the 0x address
//   pubkey   /cosmos.evm.crypto.v1.ethsecp256k1.PubKey (33-byte compressed)
//   sign     secp256k1 over keccak256(sign bytes): SIGN_MODE_DIRECT (64-byte
//            r||s), SIGN_MODE_LEGACY_AMINO_JSON, and amino JSON signed as
//            EIP-712 typed data (Keplr with a Ledger, 65-byte r||s||v)
//   reads    REST /cosmos/auth/v1beta1/accounts, /cosmos/bank/v1beta1/balances,
//            /cosmos/tx/v1beta1/simulate (Keplr's gas estimate)
//   sends    REST POST /cosmos/tx/v1beta1/txs (Keplr) and CometBFT RPC
//            broadcast_tx_sync (CosmJS-based wallets)
// Txs are encoded with cosmjs-types, the ts-proto code these wallets ship.
// What Keplr does was read from @keplr-wallet/stores, /background and /hooks
// 0.13.41 (account/cosmos.js, keyring-cosmos/service.js, tx/gas-simulator.js).
//   ZETAPHYD=/path/to/zetaphyd npm run test:devnet:cosmoswallet

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HDNodeWallet, Mnemonic, Wallet, JsonRpcProvider, TypedDataEncoder, concat, getBytes, randomBytes, parseEther } from 'ethers';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { TxRaw, TxBody, AuthInfo, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { MsgDelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx';
// ethsecp256k1.PubKey has the same wire format as secp256k1.PubKey: bytes key = 1.
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys';
import { toBech32, fromBech32, bytesToHex } from '../src/pqtx.js';

const PORT = 20545; // EVM JSON-RPC; scripts/devnet.sh: CometBFT +100, gRPC +102, REST +103
const EVM_RPC = `http://127.0.0.1:${PORT}`;
const COMET = `http://127.0.0.1:${PORT + 100}`;
const REST = `http://127.0.0.1:${PORT + 103}`;
const CHAIN_ID = 'zetaphy-local-1';
const EVM_CHAIN_ID = 77390;
const DENOM = 'azetaphy';
const PUBKEY_TYPE_URL = '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey';
// What Keplr writes instead when the chain info lacks the "eth-secp256k1-cosmos" feature.
const ETHERMINT_PUBKEY_TYPE_URL = '/ethermint.crypto.v1.ethsecp256k1.PubKey';
const KEPLR_PATH = "m/44'/60'/0'/0/0";
// zetaphy-chain/setup-node.sh publishes keplr.json with gasPriceStep average 2 gwei.
const GAS_PRICE = 2_000_000_000n;
// Keplr's gas: REST simulate (with the fee, without the public key) x 1.3, the
// default of its GasSimulator (@keplr-wallet/hooks tx/gas-simulator.js).
const GAS_ADJUSTMENT = 1.3;
const ZETAPHYD = process.env.ZETAPHYD || 'zetaphyd';

const root = mkdtempSync(join(tmpdir(), 'zetaphy-cosmoswallet-'));
const chainHome = join(root, 'chain');
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
const funder = Wallet.createRandom(); // a genesis account (scripts/devnet.sh funds it)
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let provider;
let nodePid;

// ---- the devnet ----

function nodeAlive() {
  try { process.kill(nodePid, 0); return true; } catch { return false; }
}
before(() => {
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname, [chainHome, String(PORT), funder.address],
    { stdio: 'inherit', env: { ...env, REST: '1', ZETAPHYD } });
  nodePid = Number(readFileSync(join(chainHome, 'node.pid'), 'utf8'));
  provider = new JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true });
});
after(async () => {
  if (!nodePid) return;
  try { process.kill(nodePid); } catch {}
  for (let i = 0; i < 40 && nodeAlive(); i++) await sleep(250);
  if (nodeAlive()) try { process.kill(nodePid, 'SIGKILL'); } catch {}
});
// Also on Ctrl-C or a kill, and the temp chain is removed when every test passed.
process.once('exit', (code) => {
  if (nodePid && nodeAlive()) try { process.kill(nodePid, 'SIGKILL'); } catch {}
  if (code === 0) rmSync(root, { recursive: true, force: true });
});
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(1));

// ---- REST and CometBFT RPC, as the wallets call them ----

async function rest(path, body, signal) {
  const r = await fetch(REST + path, body === undefined ? { signal } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  return { status: r.status, json: await r.json() };
}
/** Keplr's BaseAccount.fromProtoJSON: a 404 means a fresh account (number 0, sequence 0). */
async function account(bech32) {
  const { status, json } = await rest(`/cosmos/auth/v1beta1/accounts/${bech32}`);
  if (status === 404) return { exists: false, accountNumber: 0n, sequence: 0n, raw: json };
  assert.equal(status, 200, JSON.stringify(json));
  const a = json.account.base_account ?? json.account;
  return { exists: true, type: json.account['@type'], address: a.address, pubKey: a.pub_key,
    accountNumber: BigInt(a.account_number), sequence: BigInt(a.sequence) };
}
async function balance(bech32) {
  const { status, json } = await rest(`/cosmos/bank/v1beta1/balances/${bech32}?pagination.limit=1000`);
  assert.equal(status, 200, JSON.stringify(json));
  return BigInt(json.balances.find((c) => c.denom === DENOM)?.amount ?? 0);
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
/** POST /cosmos/tx/v1beta1/txs, mode SYNC: Keplr's sendTx. */
async function broadcastRest(txBytes, signal) {
  const { status, json } = await rest('/cosmos/tx/v1beta1/txs', { tx_bytes: b64(txBytes), mode: 'BROADCAST_MODE_SYNC' }, signal);
  assert.equal(status, 200, JSON.stringify(json));
  return { code: json.tx_response.code, hash: json.tx_response.txhash, log: json.tx_response.raw_log, codespace: json.tx_response.codespace };
}
/** CometBFT JSON-RPC broadcast_tx_sync: what CosmJS (StargateClient) does. */
async function broadcastComet(txBytes, signal) {
  const r = await (await fetch(COMET, { method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'broadcast_tx_sync', params: { tx: b64(txBytes) } }) })).json();
  assert.ok(r.result, JSON.stringify(r));
  return { code: r.result.code ?? 0, hash: r.result.hash, log: r.result.log, codespace: r.result.codespace };
}
/** The tx as included in a block, read back through REST. */
async function waitTx(hash, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const { status, json } = await rest(`/cosmos/tx/v1beta1/txs/${hash}`);
    if (status === 200 && json.tx_response) return json.tx_response;
  }
  throw new Error(`tx ${hash} is not in a block after ${ms} ms`);
}
const evm = (method, params = []) => provider.send(method, params);

// ---- the wallet ----

/** Keplr's key for an eth-key-sign chain (bip44 coinType 60). */
function walletFromMnemonic(phrase) {
  const node = HDNodeWallet.fromPhrase(phrase, undefined, KEPLR_PATH);
  const uncompressed = getBytes(node.signingKey.publicKey); // 0x04 || X || Y
  const address = keccak_256(uncompressed.slice(1)).slice(12); // "eth-address-gen"
  return { node, pubKey: getBytes(node.signingKey.compressedPublicKey), address, bech32: toBech32(address), hex: node.address };
}
const rs = (sig) => getBytes(concat([sig.r, sig.s])); // 64 bytes, what Keplr's software key returns
/** secp256k1 over keccak256(bytes) (Keplr: keyRingService.sign(..., "keccak256")). */
const signKeccak = (w, bytes) => rs(w.node.signingKey.sign(keccak_256(bytes)));
/** The same, over sha256: what a wallet would do if it treated the chain as a plain Cosmos chain. */
const signSha256 = (w, bytes) => rs(w.node.signingKey.sign(sha256(bytes)));

const anyMsgSend = (from, to, amount) => ({ typeUrl: '/cosmos.bank.v1beta1.MsgSend',
  value: MsgSend.encode({ fromAddress: from, toAddress: to, amount: [{ denom: DENOM, amount: String(amount) }] }).finish() });
const aminoMsgSend = (from, to, amount) => ({ type: 'cosmos-sdk/MsgSend',
  value: { from_address: from, to_address: to, amount: [{ denom: DENOM, amount: String(amount) }] } });
const anyMsgDelegate = (delegator, validator, amount) => ({ typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
  value: MsgDelegate.encode({ delegatorAddress: delegator, validatorAddress: validator, amount: { denom: DENOM, amount: String(amount) } }).finish() });

const feeFor = (gas) => ({ amount: [{ denom: DENOM, amount: String(GAS_PRICE * BigInt(gas)) }], gas: BigInt(gas) });

function encodeBody(messages, memo) {
  return TxBody.encode(TxBody.fromPartial({ messages, memo })).finish();
}
function encodeAuthInfo({ w, mode, sequence, fee, pubKeyTypeUrl = PUBKEY_TYPE_URL }) {
  return AuthInfo.encode(AuthInfo.fromPartial({
    signerInfos: [{
      publicKey: { typeUrl: pubKeyTypeUrl, value: PubKey.encode({ key: w.pubKey }).finish() },
      modeInfo: { single: { mode } },
      sequence,
    }],
    fee: { amount: fee.amount, gasLimit: fee.gas },
  })).finish();
}

/** Keplr's signDirect for an eth-key-sign chain. */
function signDirectTx({ w, acct, messages, fee, memo = '', sign = signKeccak, pubKeyTypeUrl }) {
  const bodyBytes = encodeBody(messages, memo);
  const authInfoBytes = encodeAuthInfo({ w, mode: SignMode.SIGN_MODE_DIRECT, sequence: acct.sequence, fee, pubKeyTypeUrl });
  const signBytes = SignDoc.encode({ bodyBytes, authInfoBytes, chainId: CHAIN_ID, accountNumber: acct.accountNumber }).finish();
  return TxRaw.encode({ bodyBytes, authInfoBytes, signatures: [sign(w, signBytes)] }).finish();
}

// Amino JSON: the StdSignDoc with its keys sorted (Keplr's sortObjectByKey + serializeSignDoc).
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const aminoSignDoc = ({ acct, aminoMsgs, fee, memo }) => sortKeys({
  account_number: String(acct.accountNumber), chain_id: CHAIN_ID, fee: { amount: fee.amount, gas: String(fee.gas) },
  memo, msgs: aminoMsgs, sequence: String(acct.sequence) });
/** A LEGACY_AMINO_JSON tx: the body and fee as signed, plus the signature. */
function aminoTx({ w, acct, messages, fee, memo, signature }) {
  const bodyBytes = encodeBody(messages, memo);
  const authInfoBytes = encodeAuthInfo({ w, mode: SignMode.SIGN_MODE_LEGACY_AMINO_JSON, sequence: acct.sequence, fee });
  return TxRaw.encode({ bodyBytes, authInfoBytes, signatures: [signature] }).finish();
}
/** Keplr's signAmino (software key) for an eth-key-sign chain: keccak256 of the JSON. */
function signAminoTx({ w, acct, messages, aminoMsgs, fee, memo = '', sign = signKeccak }) {
  const doc = aminoSignDoc({ acct, aminoMsgs, fee, memo });
  return aminoTx({ w, acct, messages, fee, memo, signature: sign(w, new TextEncoder().encode(JSON.stringify(doc))) });
}

/**
 * Keplr with a Ledger (Ethereum app) on an eth-key-sign chain: the amino sign
 * doc with fee.feePayer added, signed as EIP-712 typed data built like
 * getEip712TypedDataBasedOnChainInfo (@keplr-wallet/stores) with MsgSend's
 * rlpTypes; the tx says SIGN_MODE_LEGACY_AMINO_JSON and has no extension
 * option. Keplr takes the domain chainId from an Ethermint-style chain id
 * (name_<evm id>-<n>); here it is the EVM chain id the node uses.
 */
function signEip712SendTx({ w, acct, to, amount, fee, memo = '', evmChainId = EVM_CHAIN_ID }) {
  const message = sortKeys({ ...aminoSignDoc({ acct, aminoMsgs: [aminoMsgSend(w.bech32, to, amount)], fee, memo }),
    fee: { amount: fee.amount, gas: String(fee.gas), feePayer: w.bech32 } });
  const types = {
    Tx: [{ name: 'account_number', type: 'string' }, { name: 'chain_id', type: 'string' }, { name: 'fee', type: 'Fee' },
      { name: 'memo', type: 'string' }, { name: 'msgs', type: 'Msg[]' }, { name: 'sequence', type: 'string' }],
    Fee: [{ name: 'feePayer', type: 'string' }, { name: 'amount', type: 'Coin[]' }, { name: 'gas', type: 'string' }],
    Coin: [{ name: 'denom', type: 'string' }, { name: 'amount', type: 'string' }],
    Msg: [{ name: 'type', type: 'string' }, { name: 'value', type: 'MsgValue' }],
    MsgValue: [{ name: 'from_address', type: 'string' }, { name: 'to_address', type: 'string' }, { name: 'amount', type: 'TypeAmount[]' }],
    TypeAmount: [{ name: 'denom', type: 'string' }, { name: 'amount', type: 'string' }],
  };
  const domainTypes = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'string' }, { name: 'salt', type: 'string' }] };
  const domain = { name: 'Cosmos Web3', version: '1.0.0', chainId: String(evmChainId), verifyingContract: 'cosmos', salt: '0' };
  const digest = keccak_256(getBytes(concat(['0x1901', TypedDataEncoder.from(domainTypes).hash(domain), TypedDataEncoder.from(types).hash(message)])));
  const signature = getBytes(w.node.signingKey.sign(digest).serialized); // r || s || v, 65 bytes
  return aminoTx({ w, acct, messages: [anyMsgSend(w.bech32, to, amount)], fee, memo, signature });
}

/**
 * Keplr's simulateTx: no public key, mode LEGACY_AMINO_JSON, an all-zero
 * signature; its GasSimulator passes the fee. publicKey: include it, as CosmJS does.
 */
async function simulateGas({ w, acct, messages, memo = '', publicKey = false }) {
  const tx = TxRaw.encode({
    bodyBytes: encodeBody(messages, memo),
    authInfoBytes: AuthInfo.encode(AuthInfo.fromPartial({
      signerInfos: [{
        ...(publicKey ? { publicKey: { typeUrl: PUBKEY_TYPE_URL, value: PubKey.encode({ key: w.pubKey }).finish() } } : {}),
        modeInfo: { single: { mode: SignMode.SIGN_MODE_LEGACY_AMINO_JSON } }, sequence: acct.sequence,
      }],
      fee: { amount: feeFor(200000n).amount },
    })).finish(),
    signatures: [new Uint8Array(64)],
  }).finish();
  const { status, json } = await rest('/cosmos/tx/v1beta1/simulate', { tx_bytes: b64(tx) });
  assert.equal(status, 200, `simulate: ${JSON.stringify(json)}`);
  const used = BigInt(json.gas_info.gas_used);
  return { used, gas: BigInt(Math.ceil(Number(used) * GAS_ADJUSTMENT)) };
}

/** Send through REST and wait for the block; the block result must be code 0. */
async function sendAndWait(txBytes, via = broadcastRest) {
  const r = await via(txBytes);
  assert.equal(r.code, 0, `refused at CheckTx: code ${r.code} (${r.codespace}) ${r.log}`);
  const res = await waitTx(r.hash);
  assert.equal(res.code, 0, `failed in block: code ${res.code} ${res.raw_log}`);
  return res;
}

// ---- the tests (they run in order and share the account) ----

const phrase = Mnemonic.fromEntropy(randomBytes(32)).phrase; // 24 words, as Keplr offers
const w = walletFromMnemonic(phrase);
const friend = walletFromMnemonic(Mnemonic.fromEntropy(randomBytes(16)).phrase).bech32;
const FUND = parseEther('100');

test("Keplr's key: BIP39 -> m/44'/60'/0'/0/0; the zetaphy1 address is the 0x address's 20 bytes; zetaphyd derives the same", () => {
  // The well-known Hardhat mnemonic gives 0xf39F...2266 at this path, so the path is coin type 60.
  const known = walletFromMnemonic('test test test test test test test test test test test junk');
  assert.equal(known.hex, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.equal(bytesToHex(known.address), known.hex.slice(2).toLowerCase());

  assert.equal(w.pubKey.length, 33);
  assert.equal('0x' + bytesToHex(w.address), w.hex.toLowerCase());
  assert.match(w.bech32, /^zetaphy1[02-9ac-hj-np-z]{38}$/);
  assert.equal(bytesToHex(fromBech32(w.bech32)), bytesToHex(getBytes(w.hex)));

  // The chain's own keyring, given the same mnemonic (eth_secp256k1, default path).
  const out = execFileSync(ZETAPHYD, ['keys', 'add', 'keplr', '--recover', '--algo', 'eth_secp256k1', '--keyring-backend', 'test',
    '--home', join(root, 'keyring'), '--output', 'json'], { input: phrase + '\n', env }).toString();
  const key = JSON.parse(out.trim().split('\n').pop());
  assert.equal(key.address, w.bech32);
  assert.deepEqual(JSON.parse(key.pubkey), { '@type': PUBKEY_TYPE_URL, key: b64(w.pubKey) });
  // And the chain maps the 0x address to the same zetaphy1 address.
  const dbg = execFileSync(ZETAPHYD, ['debug', 'addr', w.hex], { env }).toString();
  assert.equal(/Bech32 Acc (\S+)/.exec(dbg)[1], w.bech32);
});

test('fresh account: REST answers 404 until it is funded, then account number, sequence 0 and the balance', { timeout: 60_000 }, async () => {
  const fresh = await account(w.bech32);
  assert.equal(fresh.exists, false, 'the new account should not exist yet');
  assert.equal(await balance(w.bech32), 0n);

  // A genesis account funds it (an EVM transfer to the same 20 bytes).
  const tx = await funder.connect(provider).sendTransaction({ to: w.hex, value: FUND });
  await tx.wait();
  const a = await account(w.bech32);
  assert.equal(a.exists, true);
  assert.equal(a.type, '/cosmos.auth.v1beta1.BaseAccount');
  assert.equal(a.address, w.bech32);
  assert.equal(a.pubKey, null, 'no public key until its first tx');
  // Cosmos SDK v0.54 numbers accounts made after genesis with a 64-bit hash
  // (top bit set), far beyond 2^53: wallets must keep it as a string or bigint
  // (@cosmjs/stargate <= 0.38 calls Uint64.toNumber() on it and throws).
  assert.ok(a.accountNumber >= 2n ** 63n, `account number ${a.accountNumber}`);
  assert.equal(a.sequence, 0n);
  assert.equal(await balance(w.bech32), FUND);
  const byDenom = await rest(`/cosmos/bank/v1beta1/balances/${w.bech32}/by_denom?denom=${DENOM}`);
  assert.equal(byDenom.json.balance.amount, FUND.toString());
});

test('SIGN_MODE_DIRECT over keccak256 (Keplr signDirect): MsgSend through REST, gas from REST simulate', { timeout: 60_000 }, async () => {
  const acct = await account(w.bech32);
  const amount = parseEther('1.5');
  const messages = [anyMsgSend(w.bech32, friend, amount)];
  const sim = await simulateGas({ w, acct, messages, memo: 'keplr direct' });
  // Without the key the node prices the signature as a plain secp256k1 key
  // (auth param sig_verify_cost_secp256k1) while an eth_secp256k1 signature
  // costs 21000 (ante/sigverify.go). Genesis sets the param to 21000 (devnet.sh
  // and setup-node.sh), so the estimate matches without Keplr's 1.3.
  const withKey = await simulateGas({ w, acct, messages, memo: 'keplr direct', publicKey: true });
  const fee = feeFor(sim.gas);
  const txBytes = signDirectTx({ w, acct, messages, fee, memo: 'keplr direct' });
  assert.equal(TxRaw.decode(txBytes).signatures[0].length, 64);
  const start = await balance(w.bech32);
  const res = await sendAndWait(txBytes);
  console.log(`first tx, direct MsgSend: simulate ${sim.used} gas without the public key (Keplr), ${withKey.used} with it (CosmJS); ` +
    `limit ${sim.gas}, used ${res.gas_used}`);
  assert.ok(BigInt(res.gas_used) <= sim.gas, `used ${res.gas_used} > limit ${sim.gas}`);
  assert.ok(BigInt(res.gas_used) <= sim.used + 3000n, `simulate ${sim.used} under-counts: used ${res.gas_used}`);

  assert.equal(await balance(friend), amount);
  assert.equal(await balance(w.bech32), start - amount - BigInt(fee.amount[0].amount));
  const after = await account(w.bech32);
  assert.equal(after.sequence, 1n);
  assert.deepEqual(after.pubKey, { '@type': PUBKEY_TYPE_URL, key: b64(w.pubKey) }); // set by the first tx
});

let validator;
test('SIGN_MODE_DIRECT over keccak256: MsgDelegate through REST', { timeout: 60_000 }, async () => {
  const vals = (await rest('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED')).json.validators;
  validator = vals[0].operator_address;
  assert.match(validator, /^zetaphyvaloper1/);
  const acct = await account(w.bech32);
  const amount = parseEther('10');
  const messages = [anyMsgDelegate(w.bech32, validator, amount)];
  const sim = await simulateGas({ w, acct, messages });
  const fee = feeFor(sim.gas);
  const start = await balance(w.bech32);
  const res = await sendAndWait(signDirectTx({ w, acct, messages, fee }));
  console.log(`direct MsgDelegate: simulate ${sim.used} gas, limit ${sim.gas}, used ${res.gas_used}`);

  const d = (await rest(`/cosmos/staking/v1beta1/delegations/${w.bech32}`)).json.delegation_responses;
  assert.equal(d.length, 1);
  assert.equal(d[0].delegation.validator_address, validator);
  assert.equal(d[0].balance.amount, amount.toString());
  // Delegating also withdraws nothing yet (first delegation), so the balance drops by amount + fee.
  assert.equal(await balance(w.bech32), start - amount - BigInt(fee.amount[0].amount));
  assert.equal((await account(w.bech32)).sequence, 2n);
});

test('SIGN_MODE_LEGACY_AMINO_JSON over keccak256 (Keplr signAmino): MsgSend through REST', { timeout: 60_000 }, async () => {
  const acct = await account(w.bech32);
  const amount = parseEther('0.25');
  const messages = [anyMsgSend(w.bech32, friend, amount)];
  const sim = await simulateGas({ w, acct, messages, memo: 'keplr amino' });
  const fee = feeFor(sim.gas);
  const start = [await balance(w.bech32), await balance(friend)];
  const r = await broadcastRest(signAminoTx({ w, acct, messages, aminoMsgs: [aminoMsgSend(w.bech32, friend, amount)], fee, memo: 'keplr amino' }));
  assert.equal(r.code, 0, `amino JSON tx refused at CheckTx: code ${r.code} (${r.codespace}) ${r.log}`);
  const res = await waitTx(r.hash);
  assert.equal(res.code, 0, `amino JSON tx failed in block: code ${res.code} ${res.raw_log}`);
  assert.equal(await balance(friend), start[1] + amount);
  assert.equal(await balance(w.bech32), start[0] - amount - BigInt(fee.amount[0].amount));
  assert.equal((await account(w.bech32)).sequence, acct.sequence + 1n);
});

// The node checks it in ethsecp256k1.PubKey.VerifySignature: keccak256 of the
// amino JSON fails, then the EIP-712 fallback (eip712.LegacyGetEIP712BytesForMsg,
// which adds fee.feePayer) matches.
test('SIGN_MODE_LEGACY_AMINO_JSON signed as EIP-712 (Keplr with a Ledger): MsgSend through REST', { timeout: 60_000 }, async () => {
  const acct = await account(w.bech32);
  const amount = parseEther('0.125');
  const fee = feeFor(200000n);
  const start = [await balance(w.bech32), await balance(friend)];
  // Signed for another EVM chain id (Evmos's 9001): refused, the domain must say 77390.
  await assertRefused(signEip712SendTx({ w, acct, to: friend, amount, fee, memo: 'keplr ledger', evmChainId: 9001 }), /signature verification failed/);
  const txBytes = signEip712SendTx({ w, acct, to: friend, amount, fee, memo: 'keplr ledger' });
  assert.equal(TxRaw.decode(txBytes).signatures[0].length, 65);
  const r = await broadcastRest(txBytes);
  assert.equal(r.code, 0, `EIP-712 tx refused at CheckTx: code ${r.code} (${r.codespace}) ${r.log}`);
  const res = await waitTx(r.hash);
  assert.equal(res.code, 0, `EIP-712 tx failed in block: code ${res.code} ${res.raw_log}`);
  assert.equal(await balance(friend), start[1] + amount);
  assert.equal(await balance(w.bech32), start[0] - amount - BigInt(fee.amount[0].amount));
});

test('CometBFT RPC broadcast_tx_sync (CosmJS wallets): a direct-signed MsgSend', { timeout: 60_000 }, async () => {
  const acct = await account(w.bech32);
  const amount = parseEther('0.5');
  const fee = feeFor(200000n);
  const start = await balance(friend);
  const r = await broadcastComet(signDirectTx({ w, acct, messages: [anyMsgSend(w.bech32, friend, amount)], fee, memo: 'cosmjs rpc' }));
  assert.equal(r.code, 0, `refused: ${r.log}`);
  // Read back through CometBFT RPC too: /tx?hash=0x...
  let tx;
  for (const end = Date.now() + 30_000; !tx && Date.now() < end; await sleep(500)) {
    tx = (await (await fetch(`${COMET}/tx?hash=0x${r.hash}`)).json()).result;
  }
  assert.ok(tx, 'not in a block after 30 s');
  assert.equal(tx.tx_result.code ?? 0, 0, tx.tx_result.log);
  assert.equal(await balance(friend), start + amount);
});

// A tx the chain must refuse, with nothing changed: the sequence and balance stay.
async function assertRefused(txBytes, pattern) {
  const acct = await account(w.bech32);
  const bal = await balance(w.bech32);
  const r = await broadcastRest(txBytes);
  assert.notEqual(r.code, 0, 'the chain accepted it');
  assert.match(r.log, pattern);
  await sleep(2500); // a block or two
  assert.equal((await account(w.bech32)).sequence, acct.sequence);
  assert.equal(await balance(w.bech32), bal);
  return r;
}

test('the chain checks keccak256, not sha256: txs signed over sha256(sign bytes) are refused', { timeout: 60_000 }, async () => {
  const acct = await account(w.bech32);
  const msg = (memo) => ({ messages: [anyMsgSend(w.bech32, friend, 1000n)], fee: feeFor(200000n), memo });
  const d = await assertRefused(signDirectTx({ w, acct, ...msg('sha256 direct'), sign: signSha256 }), /signature verification failed/);
  assert.equal(d.code, 4); // sdk ErrUnauthorized
  const a = await assertRefused(signAminoTx({ w, acct, ...msg('sha256 amino'), aminoMsgs: [aminoMsgSend(w.bech32, friend, 1000n)], sign: signSha256 }),
    /signature verification failed/);
  assert.equal(a.code, 4);
  console.log(`sha256-signed tx refused: code ${d.code} (${d.codespace}) ${d.log}`);
  // The same tx over keccak256 goes through: only the hash differs.
  await sendAndWait(signDirectTx({ w, acct, ...msg('keccak direct') }));
});

test("Keplr's default ethsecp256k1 type URL (/ethermint.crypto.v1...) does not decode here: its chain info needs the \"eth-secp256k1-cosmos\" feature", async () => {
  // Keplr writes /cosmos.evm.crypto.v1.ethsecp256k1.PubKey only when the chain
  // info lists "eth-secp256k1-cosmos". Its simulate leaves the key out, so only
  // the signed tx carries the type the node does not know.
  const acct = await account(w.bech32);
  const tx = signDirectTx({ w, acct, messages: [anyMsgSend(w.bech32, friend, 1000n)], fee: feeFor(200000n), pubKeyTypeUrl: ETHERMINT_PUBKEY_TYPE_URL });
  const { status, json } = await rest('/cosmos/tx/v1beta1/decode', { tx_bytes: b64(tx) });
  assert.notEqual(status, 200);
  assert.match(json.message, /unable to resolve type URL \/ethermint\.crypto\.v1\.ethsecp256k1\.PubKey/);
  console.log(`decode: HTTP ${status} ${json.message}`);
});

// Upstream cosmos/evm v0.7.3 returned (nil, err) from CheckTx for a tx that
// does not decode, and CometBFT then never answered the broadcast. ZETAPHY
// patches mempool/mempool_handlers.go to answer with ErrTxDecode instead.
test('an undecodable tx gets an error answer from REST and from CometBFT broadcast_tx_sync', { timeout: 60_000 }, async () => {
  const answer = async (what, call) => {
    try { return await call(AbortSignal.timeout(10_000)); } catch (e) {
      if (e.name === 'TimeoutError') assert.fail(`${what}: no answer in 10 s`);
      throw e;
    }
  };
  const acct = await account(w.bech32);
  const keplrTx = signDirectTx({ w, acct, messages: [anyMsgSend(w.bech32, friend, 1000n)], fee: feeFor(200000n), pubKeyTypeUrl: ETHERMINT_PUBKEY_TYPE_URL });
  const r = await answer('REST POST /cosmos/tx/v1beta1/txs', (signal) => broadcastRest(keplrTx, signal));
  assert.notEqual(r.code, 0);
  const c = await answer('CometBFT broadcast_tx_sync', (signal) => broadcastComet(randomBytes(40), signal));
  assert.notEqual(c.code, 0);
});

test('EVM JSON-RPC sees the same account: eth_getBalance = bank balance, nonce = sequence', async () => {
  for (const [bech, hex] of [[w.bech32, w.hex], [friend, '0x' + bytesToHex(fromBech32(friend))]]) {
    const [onEvm, inBank] = [BigInt(await evm('eth_getBalance', [hex, 'latest'])), await balance(bech)];
    assert.equal(onEvm, inBank, `${bech}: eth_getBalance ${onEvm} != bank ${inBank}`);
  }
  assert.equal(BigInt(await evm('eth_getTransactionCount', [w.hex, 'latest'])), (await account(w.bech32)).sequence);
});

test("Keplr + Ledger on ZETAPHY's chain id", () => {
  // @keplr-wallet/cosmos EthermintChainIdHelper.parse, used for every Ledger
  // signature on an eth-key-sign chain: the chain id must be name_<evm id>-<n>.
  // Keplr also needs the chain info feature "force-enable-evm-ledger" for a
  // chain id it does not list.
  const setup = readFileSync(new URL('../../zetaphy-chain/setup-node.sh', import.meta.url), 'utf8');
  const chainId = /^CHAIN_ID="([^"]+)"/m.exec(setup)[1];
  const m = /^([a-z]{1,})_{1}([1-9][0-9]*)-{1}([1-9][0-9]*)$/.exec(chainId);
  assert.ok(m, `Invalid chainId for ethermint: ${chainId}`);
  assert.equal(Number(m[2]), EVM_CHAIN_ID);
  assert.equal(Number(/^EVM_CHAIN_ID=(\d+)/m.exec(setup)[1]), EVM_CHAIN_ID);
  assert.match(setup, /"force-enable-evm-ledger"/);
});

