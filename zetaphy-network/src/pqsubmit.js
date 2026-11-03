// The PQ submitter: a long-running service (an oracle reporter, a Hyperlane delivery, any keeper)
// sends its transactions on ZETAPHY as a native ML-DSA-44 account (src/pqtx.js) instead of a
// secp256k1 EOA. EVM calls go through /zetaphy.pq.v1.MsgEVMCall, so contracts see msg.sender =
// the account's own 0x address: give that address the role (relayer, reporter, keeper) an EOA had.
//
// What it adds to pqClient (which reads the sequence from the node before every tx):
//   - sequences for back-to-back txs: zetaphy_pqAccount reports the sequence of the last block, so
//     a second tx sent before that block would reuse it. The submitter counts on from the last one
//     it got accepted, and when the node says "account sequence mismatch, expected N" it signs again
//     with N (another process using the same key, a dropped tx).
//   - retries: a lost answer (network error) resends the SAME signed bytes, so a tx that did reach
//     the node is not sent twice ("tx already exists in cache" counts as accepted); a full mempool or
//     a fee below the node's minimum is retried (with a higher price for the latter); anything else
//     (unauthorized, out of funds, a call that reverts in eth_call) fails at once.
//   - one tx at a time per account (a queue), and confirm(): wait until the tx is in a block.
// Pure ESM; rpcCall is ethers' provider.send or a fetch wrapper, so it runs anywhere pqtx.js runs.

import {
  pqClient, pqAddress, msgEVMCall, buildTx, bumpGasPrice, normalizeAddress, toChecksumHex, addressBytes, bytesToHex, hexToBytes,
  formatZeta, CHAIN_ID, DENOM, PREFIX, DEFAULT_EVM_GAS_LIMIT, EVM_CALL_GAS_OVERHEAD,
} from './pqtx.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/** zetaphy_sendCosmosTx refuses bodies over 64 KB (docs/CHAIN_AUDIT_SCOPE.md). */
export const MAX_TX_BYTES = 64 * 1024;
// Cosmos SDK error codes (types/errors) the submitter acts on.
export const CODE = { insufficientFee: 13, txInMempoolCache: 19, mempoolFull: 20, wrongSequence: 32 };

const qty = (v) => '0x' + BigInt(v).toString(16);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The sequence the node expected, from its refusal ("account sequence mismatch, expected 7, got 5"); null if none. */
export function expectedSequence(log) {
  const m = /sequence mismatch,? expected (\d+)/i.exec(String(log ?? ''));
  return m ? BigInt(m[1]) : null;
}

/** What to do with a zetaphy_sendCosmosTx answer: accepted | resequence | reprice | wait | fail. */
export function classify(r) {
  if (r.code === 0) return 'accepted';
  const log = String(r.log ?? '');
  if (r.code === CODE.txInMempoolCache || /tx already (exists )?in (the )?(mempool )?cache/i.test(log)) return 'accepted';
  if (r.code === CODE.wrongSequence || /sequence mismatch/i.test(log)) return 'resequence';
  if (r.code === CODE.insufficientFee || /insufficient fee/i.test(log)) return 'reprice';
  if (r.code === CODE.mempoolFull || /mempool is full/i.test(log)) return 'wait';
  return 'fail';
}

/**
 * A submitter for one ML-DSA-44 account.
 *   rpcCall(method, params)  the node's EVM JSON-RPC (zetaphy_pqAccount, zetaphy_sendCosmosTx, eth_*)
 *   publicKey, sign(bytes)   the account (pq.js pqFromSeed: publicKeyBytes, signBytes)
 *   retries                  extra attempts after the first (lost answers, full mempool, sequence, fee)
 *   backoffMs                wait before attempt n: backoffMs * n (sleep(ms) is injectable for tests)
 *   txResult(hash)           optional: the tx's block result { code, log } or null while not in a block
 *                            (cometTxResult below); without it confirm() watches the account's sequence
 */
export function pqSubmitter({ rpcCall, publicKey, sign, chainId = CHAIN_ID, denom = DENOM, prefix = PREFIX,
  retries = 4, backoffMs = 1500, sleep = realSleep, txResult = null, log = () => {} }) {
  if (typeof rpcCall !== 'function') throw new Error('rpcCall is required');
  if (typeof sign !== 'function') throw new Error('sign must be a function');
  const client = pqClient(rpcCall, { chainId, denom, prefix });
  const me = pqAddress(publicKey, prefix);
  let next = null; // the sequence after the last tx this submitter got accepted
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

  async function account() {
    const a = await client.account(me.bech32);
    if (!a.exists || a.accountNumber == null) throw new Error(`account ${me.bech32} (${me.hex}) does not exist on chain yet: send ZETAPHY to it first`);
    return a;
  }

  /**
   * Signs and sends messages ({ typeUrl, value }) from this account; resolves once the node accepted
   * the tx (not yet in a block: confirm() waits for that). value: azetaphy the messages take besides the fee.
   */
  function submitMsgs({ messages, gasLimit, gasPrice, memo = '', value = 0n, preflight }) {
    return serial(async () => {
      const acct = await account();
      let sequence = next != null && next > acct.sequence ? next : acct.sequence;
      let price = gasPrice == null ? await client.gasPrice() : BigInt(gasPrice);
      const gas = BigInt(gasLimit);
      const bal = await client.balance(me.hex);
      if (BigInt(value) + gas * price > bal) throw new Error(`not enough ZETAPHY in ${me.hex}: need ${formatZeta(BigInt(value) + gas * price)}, have ${formatZeta(bal)}`);
      const checked = preflight ? await preflight() : undefined;
      const build = () => {
        const tx = buildTx({ publicKey, sign, messages, denom, chainId, accountNumber: acct.accountNumber, sequence, gasLimit: gas, gasPrice: price, memo });
        if (tx.txBytes.length > MAX_TX_BYTES) throw new Error(`the tx is ${tx.txBytes.length} bytes, over the node's ${MAX_TX_BYTES}-byte limit: send less per tx`);
        return tx;
      };
      let tx = build();
      let lastError = '';
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0 && lastError !== 'resequence') await sleep(backoffMs * attempt);
        let r;
        try {
          r = await rpcCall('zetaphy_sendCosmosTx', [tx.txHex]);
        } catch (e) {
          // No answer: the tx may or may not have reached the node. Resend the same bytes: if it did,
          // the node answers "already in cache" (accepted); it cannot run twice (same sequence).
          lastError = `no answer from the node: ${e.shortMessage ?? e.message}`;
          log(`attempt ${attempt + 1}: ${lastError}`);
          continue;
        }
        if (!r || typeof r.code !== 'number') throw new Error('the node did not answer zetaphy_sendCosmosTx');
        const what = classify(r);
        if (what === 'accepted') {
          next = sequence + 1n;
          return { txHash: r.txHash || tx.txHash, from: me, sequence, accountNumber: acct.accountNumber, fee: tx.fee, gasLimit: gas, gasPrice: price, attempts: attempt + 1, checked };
        }
        lastError = what;
        log(`attempt ${attempt + 1}: code ${r.code}: ${r.log || 'no log'}`);
        if (what === 'fail') throw new Error(`the node rejected the transaction (code ${r.code}): ${r.log || 'no log'}`);
        if (what === 'resequence') {
          const want = expectedSequence(r.log);
          sequence = want ?? (await account()).sequence;
          tx = build();
        } else if (what === 'reprice') {
          price = bumpGasPrice(price > 0n ? price : await client.gasPrice());
          if (BigInt(value) + gas * price > await client.balance(me.hex)) throw new Error(`not enough ZETAPHY in ${me.hex} for the higher fee the node asks`);
          tx = build();
        }
      }
      throw new Error(`the tx was not accepted after ${retries + 1} attempts (last: ${lastError})`);
    });
  }

  /**
   * Calls a contract as this account (msg.sender = address.hex). The call is first run with eth_call,
   * so one that would revert is refused before anything is signed (check: false skips that).
   */
  async function callEVM({ to, data = '0x', value = 0n, evmGasLimit = DEFAULT_EVM_GAS_LIMIT, gasLimit, gasPrice, memo = '', check = true }) {
    const toHex = toChecksumHex(addressBytes(to, prefix));
    const bytes = typeof data === 'string' ? hexToBytes(data) : data;
    const evmGas = BigInt(evmGasLimit);
    const txGas = gasLimit == null ? evmGas + EVM_CALL_GAS_OVERHEAD : BigInt(gasLimit);
    if (txGas <= evmGas) throw new Error('the tx gas limit must be more than the EVM gas limit');
    const m = msgEVMCall({ sender: me.bech32, to: toHex, value, data: bytes, gasLimit: evmGas, prefix });
    const dataHex = '0x' + bytesToHex(bytes);
    const preflight = check ? async () => {
      const call = { from: me.hex, to: toHex, data: dataHex, gas: qty(evmGas) };
      if (BigInt(value) > 0n) call.value = qty(value);
      try { return await rpcCall('eth_call', [call, 'latest']); } catch (e) { throw new Error(`the call would fail, so nothing was sent: ${e.shortMessage ?? e.message}`); }
    } : undefined;
    const r = await submitMsgs({ messages: [m], gasLimit: txGas, gasPrice, memo, value, preflight });
    return { ...r, to: toHex, data: dataHex, evmGasLimit: evmGas, result: r.checked };
  }

  /**
   * Waits until a submitted tx is in a block. With txResult: its result, and a tx that failed in the
   * block (e.g. the call reverted after all) throws. Without: the account's sequence moving past the
   * tx's proves it is in a block, not that the call succeeded ({ code: null }).
   */
  async function confirm(sent, { timeoutMs = 60_000, pollMs = 1000 } = {}) {
    for (let waited = 0; ; waited += pollMs) {
      if (txResult) {
        const r = await txResult(sent.txHash);
        if (r) {
          if (r.code !== 0) throw new Error(`tx ${sent.txHash} is in a block but failed (code ${r.code}): ${r.log || 'no log'}`);
          return { included: true, code: 0, log: r.log ?? '' };
        }
      } else if ((await account()).sequence > BigInt(sent.sequence)) return { included: true, code: null };
      if (waited >= timeoutMs) throw new Error(`tx ${sent.txHash} is not in a block after ${timeoutMs} ms`);
      await sleep(pollMs);
    }
  }

  /** eth_call from this account: the 0x return data (a revert throws). */
  const read = ({ to, data }) => rpcCall('eth_call', [{ from: me.hex, to: toChecksumHex(addressBytes(to, prefix)), data }, 'latest']);

  return { address: me, client, account, read, submitMsgs, callEVM, confirm, nextSequence: () => next };
}

/** txResult for pqSubmitter over a CometBFT RPC (http://127.0.0.1:26657, or a guard that allows `tx`). */
export function cometTxResult(url, fetchFn = globalThis.fetch) {
  const base = String(url).replace(/\/+$/, '');
  return async (hash) => {
    try {
      const r = await (await fetchFn(`${base}/tx?hash=0x${hash}`)).json();
      const t = r?.result?.tx_result;
      return t ? { code: t.code ?? 0, log: t.log ?? '' } : null;
    } catch { return null; }
  };
}

// ---- Hyperlane: deliver a message to ZETAPHY's Mailbox as a PQ account ----

export const MAILBOX_SELECTORS = {
  process: '0x7c39d130', // process(bytes,bytes)
  delivered: '0xe495f1d4', // delivered(bytes32)
  localDomain: '0x8d3638f4', // localDomain()
};
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const abiBytes = (b) => {
  const hex = bytesToHex(b);
  return word(qty(b.length)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
};

/** keccak256 of a Hyperlane message: its id (Mailbox.delivered key). */
export const messageIdOf = (message) => '0x' + bytesToHex(keccak_256(typeof message === 'string' ? hexToBytes(message) : message));

/** The destination domain of a Hyperlane v3 message (version 1 | nonce 4 | origin 4 | sender 32 | destination 4 | …). */
export function destinationOf(message) {
  const b = typeof message === 'string' ? hexToBytes(message) : message;
  if (b.length < 77) throw new Error('not a Hyperlane message (shorter than its 77-byte header)');
  return ((b[41] << 24) >>> 0) + (b[42] << 16) + (b[43] << 8) + b[44];
}

/** { to, data, messageId } of Mailbox.process(metadata, message). */
export function hyperlaneProcessCall({ mailbox, metadata, message, prefix = PREFIX }) {
  const md = typeof metadata === 'string' ? hexToBytes(metadata) : metadata;
  const msg = typeof message === 'string' ? hexToBytes(message) : message;
  const head = word(qty(64)) + word(qty(64 + 32 + Math.ceil(md.length / 32) * 32));
  return { to: normalizeAddress(mailbox, prefix).hex, data: MAILBOX_SELECTORS.process + head + abiBytes(md) + abiBytes(msg), messageId: messageIdOf(msg) };
}

/**
 * Delivers a Hyperlane message to the Mailbox on ZETAPHY with the submitter's ML-DSA-44 account
 * (what Hyperlane's relayer does with its ECDSA key). The ISM still decides: the metadata (e.g.
 * src/qsafe/pqism.js pqIsmMetadata for PQMultisigIsm) is checked by eth_call before anything is
 * signed. A message already delivered, or meant for another domain, is not sent.
 */
export async function deliverHyperlane({ submitter, mailbox, metadata, message, evmGasLimit = 3_000_000n, confirm = false }) {
  const call = hyperlaneProcessCall({ mailbox, metadata, message });
  const read = async (data) => submitter.read({ to: call.to, data });
  const local = BigInt(await read(MAILBOX_SELECTORS.localDomain));
  const dest = destinationOf(message);
  if (BigInt(dest) !== local) throw new Error(`the message is for domain ${dest}, this Mailbox is domain ${local}: nothing sent`);
  if (BigInt(await read(MAILBOX_SELECTORS.delivered + word(call.messageId))) !== 0n) return { messageId: call.messageId, alreadyDelivered: true };
  const r = await submitter.callEVM({ to: call.to, data: call.data, evmGasLimit });
  const c = confirm ? await submitter.confirm(r) : undefined;
  return { ...r, messageId: call.messageId, alreadyDelivered: false, confirmed: c };
}
