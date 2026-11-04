// Saphan offline transfers (contracts/SaphanOffline.sol, docs/SAPHAN-PR6.md item H): a ZETAPHY -> source-chain
// transfer signed with no network, carried as a QR code or text, relayed by anyone later. The payload format follows the
// offline cheques / orders of zetaphy-hub/offline-core.js ("ZCHQ1:", "ZORD1:"): a prefix and base64url JSON.
//   ZSPH1:<base64url of {"c": chainId, "k": contract, "t": {from, outbox, to, amount, relayerFee, nonce, deadline}, "s": sig}>
import { Wallet, TypedDataEncoder, verifyTypedData, getAddress, isAddress, Signature } from 'ethers';

export const PREFIX = 'ZSPH1:';
export const DOMAIN_NAME = 'ZETAPHY Saphan Offline';
export const MAX_PAYLOAD = 2000;
export const FIELDS = [
  { name: 'from', type: 'address' }, { name: 'outbox', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'relayerFee', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
];
const TYPES = { Transfer: FIELDS };
const U256 = 2n ** 256n;
const HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;

export const domain = (chainId, contract) => ({ name: DOMAIN_NAME, version: '1', chainId: BigInt(chainId), verifyingContract: getAddress(contract) });

/** The transfer with checked fields (addresses checksummed, numbers as bigint); throws Error('format'). */
export function normalize(t) {
  const out = {};
  for (const { name, type } of FIELDS) {
    const v = t?.[name];
    if (type === 'address') {
      if (!isAddress(String(v ?? ''))) throw new Error('format');
      out[name] = getAddress(String(v));
    } else {
      if (!/^\d{1,78}$/.test(String(v ?? '')) || BigInt(v) >= U256) throw new Error('format');
      out[name] = BigInt(v);
    }
  }
  if (out.amount === 0n) throw new Error('format');
  return out;
}

/** The EIP-712 digest SaphanOfflineTransfers.digest(t) computes. */
export const digestOf = ({ chainId, contract, transfer }) => TypedDataEncoder.hash(domain(chainId, contract), TYPES, normalize(transfer));

/** Signs offline (an ethers Wallet or a 0x private key); low-s, v 27/28 (what the contract accepts). */
export async function signTransfer({ chainId, contract, transfer, key }) {
  const w = typeof key === 'string' ? new Wallet(key) : key;
  const t = normalize(transfer);
  if (getAddress(w.address) !== t.from) throw new Error('the key is not transfer.from');
  return Signature.from(await w.signTypedData(domain(chainId, contract), TYPES, t)).serialized;
}

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');

export function encodePayload({ chainId, contract, transfer, sig }) {
  const t = normalize(transfer);
  const o = Object.fromEntries(FIELDS.map(({ name, type }) => [name, type === 'address' ? t[name].toLowerCase() : t[name].toString()]));
  const text = PREFIX + b64u(JSON.stringify({ c: Number(chainId), k: getAddress(contract).toLowerCase(), t: o, s: String(sig).toLowerCase() }));
  if (text.length > MAX_PAYLOAD) throw new Error('payload too long');
  return text;
}

/** Text -> { chainId, contract, transfer, sig }; throws Error('format') on anything else. */
export function decodePayload(text) {
  const s = String(text ?? '').trim();
  if (s.length > MAX_PAYLOAD || !s.startsWith(PREFIX)) throw new Error('format');
  const raw = s.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('format');
  let j;
  try { j = JSON.parse(unb64u(raw)); } catch { throw new Error('format'); }
  if (!j || typeof j !== 'object' || !Number.isSafeInteger(j.c) || j.c <= 0 || !isAddress(String(j.k ?? '')) || !/^0x[0-9a-f]{130}$/.test(String(j.s ?? ''))) throw new Error('format');
  return { chainId: j.c, contract: getAddress(j.k), transfer: normalize(j.t), sig: j.s };
}

/**
 * Offline checks of a payload (no network): the signature is the sender's, low-s, not expired; the outbox is one of
 * `knownOutboxes` (the deployed routes, saphan-routes.json zetaphy.hyperlaneOutbox) when given.
 * Returns { ok, problems: [codes], signer, digest }.
 */
export function verifyPayload(p, { now = Math.floor(Date.now() / 1000), knownOutboxes = null, contract = null, chainId = null } = {}) {
  const problems = [];
  let signer = null;
  try {
    const sig = Signature.from(p.sig);
    if (BigInt(sig.s) > HALF_N) problems.push('high-s');
    signer = getAddress(verifyTypedData(domain(p.chainId, p.contract), TYPES, p.transfer, p.sig));
  } catch { problems.push('bad-signature'); }
  if (signer && signer !== p.transfer.from) problems.push('not-signed-by-sender');
  if (BigInt(now) > p.transfer.deadline) problems.push('expired');
  if (knownOutboxes && !knownOutboxes.map((a) => getAddress(a)).includes(p.transfer.outbox)) problems.push('unknown-route');
  if (contract && getAddress(contract) !== p.contract) problems.push('other-contract');
  if (chainId != null && Number(chainId) !== p.chainId) problems.push('other-chain');
  return { ok: problems.length === 0, problems, signer, digest: digestOf(p) };
}

/** A random 64-bit nonce (unused nonces cost nothing; the bitmap makes each one single-use). */
export const newNonce = () => BigInt('0x' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(8))).toString('hex'));

/** The relay() call's arguments: [transfer tuple, sig]. */
export const relayArgs = (p) => [FIELDS.map(({ name }) => p.transfer[name]), p.sig];
