// Saphan BTC withdrawals, BitVM2-style prototype (contracts/SaphanBitVM.sol, docs/SAPHAN-PR6.md item S7): what an
// operator builds and what a watcher checks. PROTOTYPE: no Bitcoin script, no peg-out; the payment is an ordinary
// Bitcoin transaction with an OP_RETURN commitment, proven by SPV only when someone challenges.
import { sha256, concat, getAddress, toBeHex, getBytes, hexlify, keccak256 } from 'ethers';

export const TAG = '0x5a54504859' + '57'; // "ZTPHYW"
export const SATS_TO_WEI = 10n ** 10n;

const le = (n, bytes) => { const b = getBytes(toBeHex(BigInt(n), bytes)); return hexlify(b.reverse()); };
const varint = (n) => (n < 0xfd ? toBeHex(n, 1) : n <= 0xffff ? concat(['0xfd', le(n, 2)]) : concat(['0xfe', le(n, 4)]));

/** The OP_RETURN payload for withdrawal `id` paid by `operator`: "ZTPHYW" || id (8 bytes, big-endian) || operator. */
export const commitment = (id, operator) => concat([TAG, toBeHex(BigInt(id), 8), getAddress(operator)]);
/** The OP_RETURN output script: OP_RETURN, push 34, the commitment. */
export const commitmentScript = (id, operator) => concat(['0x6a22', commitment(id, operator)]);

/**
 * A raw non-witness Bitcoin transaction (what the txid hashes): one input (`prevTxid` internal order, `prevVout`) and
 * outputs [{ sats, script }]. Enough for the prototype's tests and for an operator to check what it signs.
 */
export function rawTx({ inputs = [{ prevTxid: '0x' + '11'.repeat(32), prevVout: 0 }], outputs, locktime = 0 }) {
  const parts = [le(2, 4), varint(inputs.length)];
  for (const i of inputs) parts.push(i.prevTxid, le(i.prevVout, 4), '0x00', '0xffffffff');
  parts.push(varint(outputs.length));
  for (const o of outputs) { const s = getBytes(o.script); parts.push(le(o.sats, 8), varint(s.length), hexlify(s)); }
  parts.push(le(locktime, 4));
  return concat(parts);
}

/** The payment an operator sends for withdrawal `id`: output 0 pays `script` `sats`, output 1 is the commitment. */
export const paymentTx = ({ id, operator, script, sats, change = null }) => rawTx({ outputs: [{ sats, script }, { sats: 0, script: commitmentScript(id, operator) },
  ...(change ? [change] : [])] });

/** txid in internal byte order (what BtcLightClient.verifyTx returns): sha256d of the raw transaction. */
export const txidOf = (raw) => sha256(sha256(raw));

/**
 * A watcher's decision for one claim (the contract's Claimed event + the request), given what it found on Bitcoin:
 *   claim   { id, operator, txid, vout, sats, scriptHash }
 *   lookup  the raw transaction for claim.txid from its own Bitcoin node (null: not found / not confirmed enough)
 * Returns { challenge: bool, reason }. One honest watcher that challenges a bad claim is enough.
 */
export function judgeClaim(claim, raw) {
  if (!raw) return { challenge: true, reason: 'payment not found on Bitcoin' };
  if (txidOf(raw).toLowerCase() !== String(claim.txid).toLowerCase()) return { challenge: true, reason: 'txid does not match the transaction' };
  let outs;
  try { outs = parseOutputs(raw); } catch { return { challenge: true, reason: 'malformed transaction' }; }
  const o = outs[claim.vout];
  if (!o) return { challenge: true, reason: 'no such output' };
  if (keccak256(o.script) !== claim.scriptHash) return { challenge: true, reason: 'pays another script' };
  if (o.sats < BigInt(claim.sats)) return { challenge: true, reason: 'pays too little' };
  const want = commitmentScript(claim.id, claim.operator).toLowerCase();
  if (!outs.some((x, i) => i !== claim.vout && x.script.toLowerCase() === want)) return { challenge: true, reason: 'no commitment to this withdrawal and operator' };
  return { challenge: false, reason: 'paid' };
}

/** Outputs of a raw non-witness transaction: [{ sats, script }]. */
export function parseOutputs(raw) {
  const b = getBytes(raw);
  let p = 4;
  const rd = () => {
    const f = b[p++];
    if (f < 0xfd) return f;
    const n = f === 0xfd ? 2 : f === 0xfe ? 4 : 8;
    let v = 0;
    for (let i = 0; i < n; i++) v += b[p + i] * 2 ** (8 * i);
    p += n;
    return v;
  };
  const nIn = rd();
  for (let i = 0; i < nIn; i++) { p += 36; const l = rd(); p += l + 4; }
  const nOut = rd();
  const outs = [];
  for (let i = 0; i < nOut; i++) {
    if (p + 8 > b.length) throw new Error('truncated');
    let sats = 0n;
    for (let k = 7; k >= 0; k--) sats = (sats << 8n) | BigInt(b[p + k]);
    p += 8;
    const l = rd();
    if (p + l > b.length) throw new Error('truncated');
    outs.push({ sats, script: hexlify(b.slice(p, p + l)) });
    p += l;
  }
  if (p + 4 !== b.length) throw new Error('trailing bytes');
  return outs;
}
