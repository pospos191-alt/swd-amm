// A ZETAPHY node stand-in for native PQ accounts over the in-memory EVM (helpers/evm.js), behaving
// like the chain where the submitter depends on it:
//   zetaphy_sendCosmosTx  decodes the TxRaw with the official Cosmos SDK types, checks the ML-DSA-44
//                         signature over the SignDoc, the address (sha256 of the key), the account
//                         number and the sequence (CheckTx: the last block's sequence plus the txs
//                         already in the mempool), the fee; answers like CometBFT's broadcast_tx_sync
//                         (code 32 "account sequence mismatch, expected N, got M", 19 already in cache)
//   mine()                runs the mempool's MsgEVMCalls in order on the EVM with msg.sender = the
//                         account's 0x address (each tx moves the sequence on, even when its call fails)
//   zetaphy_pqAccount     the sequence of the last block (as the real node: txs in the mempool not counted)
//   eth_call, eth_getBalance, eth_gasPrice, eth_getBlockByNumber
// Faults for the retry tests: dropAnswers(n) (the node takes the tx but the answer is lost),
// failSends(n, code, log) (refusals such as a full mempool).
import { TxRaw, TxBody, AuthInfo } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { Address } from '@ethereumjs/util';
import { createChain } from './evm.js';
import { encodeSignDoc, pqAddress, normalizeAddress, txHashOf, bytesToHex, hexToBytes, PUBKEY_TYPE_URL, MSG_EVM_CALL_TYPE_URL, CHAIN_ID, DENOM } from '../../src/pqtx.js';

const GAS_PRICE = 10n ** 9n;

function fields(bytes) {
  const out = {};
  let i = 0;
  const varint = () => { let v = 0n; let s = 0n; for (;;) { const b = bytes[i++]; v |= BigInt(b & 0x7f) << s; s += 7n; if (!(b & 0x80)) return v; } };
  while (i < bytes.length) {
    const k = varint(); const f = Number(k >> 3n); const w = Number(k & 7n);
    if (w === 0) out[f] = varint();
    else if (w === 2) { const n = Number(varint()); out[f] = bytes.slice(i, i + n); i += n; } else throw new Error(`wire type ${w}`);
  }
  return out;
}
const text = (b) => (b ? new TextDecoder().decode(b) : '');
/** zetaphy.pq.v1.MsgEVMCall { sender 1, to 2, value 3, data 4, gas_limit 5, as_owner 6 } */
export function decodeMsgEVMCall(bytes) {
  const f = fields(bytes);
  return { sender: text(f[1]), to: text(f[2]), value: f[3] ? BigInt(text(f[3])) : 0n, data: f[4] ?? new Uint8Array(), gasLimit: f[5] ?? 0n, asOwner: text(f[6]) };
}

export async function createPqNode({ names = ['gov'], fund = {}, precompiles, chainId = CHAIN_ID } = {}) {
  const c = await createChain(names, fund, precompiles ? { precompiles } : {});
  const accounts = new Map(); // bech32 -> { accountNumber, sequence (last block), pending (in the mempool) }
  let numbers = 10n;
  const mempool = []; // { hash, signer, msgs }
  const results = new Map(); // hash -> { code, log, height }
  const sent = []; // every tx the node accepted (hex)
  let drop = 0;
  const failures = [];
  const acctOf = (bech32) => {
    if (!accounts.has(bech32)) accounts.set(bech32, { accountNumber: numbers++, sequence: 0n, pending: 0n, pubKey: null });
    return accounts.get(bech32);
  };
  const balanceOf = async (hex) => c.balance(Address.fromString(hex));

  function checkTx(txHex) {
    const bytes = hexToBytes(txHex);
    const hash = txHashOf(bytes);
    if (mempool.some((t) => t.hash === hash) || results.has(hash)) return { code: 19, log: 'tx already exists in cache', txHash: hash };
    const raw = TxRaw.decode(bytes);
    const auth = AuthInfo.decode(raw.authInfoBytes);
    const body = TxBody.decode(raw.bodyBytes);
    const si = auth.signerInfos[0];
    if (si.publicKey.typeUrl !== PUBKEY_TYPE_URL) return { code: 4, log: 'unsupported key type' };
    const pk = PubKey.decode(si.publicKey.value).key;
    const me = pqAddress(pk);
    for (const m of body.messages) {
      if (m.typeUrl !== MSG_EVM_CALL_TYPE_URL) return { code: 4, log: `this stand-in only runs MsgEVMCall, not ${m.typeUrl}` };
      if (decodeMsgEVMCall(m.value).sender !== me.bech32) return { code: 4, log: 'pubKey does not match signer address: unauthorized' };
    }
    const a = acctOf(me.bech32);
    const want = a.sequence + a.pending;
    if (si.sequence !== want) return { code: 32, log: `account sequence mismatch, expected ${want}, got ${si.sequence}: incorrect account sequence` };
    const doc = encodeSignDoc({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId, accountNumber: a.accountNumber });
    if (!ml_dsa44.verify(raw.signatures[0], doc, pk)) return { code: 4, log: 'signature verification failed; please verify account number and chain-id: unauthorized' };
    const fee = auth.fee.amount.find((x) => x.denom === DENOM);
    if (!fee || BigInt(fee.amount) < auth.fee.gasLimit * GAS_PRICE) return { code: 13, log: `insufficient fee; got: ${fee?.amount ?? 0}${DENOM} required: ${auth.fee.gasLimit * GAS_PRICE}${DENOM}: insufficient fee` };
    a.pubKey = pk;
    a.pending += 1n;
    mempool.push({ hash, signer: me, msgs: body.messages.map((m) => decodeMsgEVMCall(m.value)) });
    sent.push(txHex);
    return { code: 0, log: '', txHash: hash };
  }

  async function rpcCall(method, params) {
    if (method === 'zetaphy_sendCosmosTx') {
      if (failures.length) { const f = failures.shift(); return { code: f.code, log: f.log, txHash: txHashOf(hexToBytes(params[0])) }; }
      const r = checkTx(params[0]);
      if (drop > 0 && r.code === 0) { drop -= 1; throw new Error('socket hang up (ECONNRESET)'); }
      return r;
    }
    if (method === 'zetaphy_pqAccount') {
      const a = normalizeAddress(params[0]);
      const known = accounts.get(a.bech32);
      const exists = !!known || (await balanceOf(a.hex)) > 0n;
      const acct = exists ? acctOf(a.bech32) : null;
      return { address: a.bech32, hex: a.hex, chainId, denom: DENOM, exists, accountNumber: acct ? String(acct.accountNumber) : null,
        sequence: acct ? String(acct.sequence) : null, pubKeyType: acct?.pubKey ? 'mldsa44' : null, quantumLockedTo: null };
    }
    if (method === 'eth_gasPrice') return '0x' + GAS_PRICE.toString(16);
    if (method === 'eth_getBalance') return '0x' + (await balanceOf(params[0])).toString(16);
    if (method === 'eth_getBlockByNumber') return { number: '0x' + c.blockNumber().toString(16), timestamp: '0x' + c.now().toString(16) };
    if (method === 'eth_call') {
      const q = params[0];
      const r = await c.staticCall(q.from ?? '0x' + '00'.repeat(20), q.to, q.data ?? '0x', q.value ? BigInt(q.value) : 0n);
      if (!r.ok) { const e = new Error(`execution reverted (${r.returnHex})`); e.data = r.returnHex; throw e; }
      return r.returnHex;
    }
    throw new Error(`unexpected ${method}`);
  }

  /** One block: every tx in the mempool runs, in order. */
  async function mine() {
    const txs = mempool.splice(0);
    for (const t of txs) {
      const a = acctOf(t.signer.bech32);
      a.pending -= 1n;
      a.sequence += 1n;
      let ok = true; let log = '';
      for (const m of t.msgs) {
        const r = await c.rawTx(t.signer.hex, normalizeAddress(m.to).hex, '0x' + bytesToHex(m.data), m.value);
        if (!r.ok) { ok = false; log = `execution reverted (${r.returnHex})`; break; }
      }
      results.set(t.hash, { code: ok ? 0 : 7, log });
    }
    return txs.length;
  }

  return {
    chain: c, rpcCall, mine, sent,
    mempool: () => mempool.length,
    txResult: async (hash) => results.get(hash) ?? null,
    dropAnswers(n) { drop = n; },
    failSends(n, code, log) { for (let i = 0; i < n; i++) failures.push({ code, log }); },
  };
}
