// Cosmos SDK transaction decoding (TxRaw -> body, auth info, messages), with the
// standard messages and ZETAPHY's own (zetaphy.pq.v1: MsgEVMCall, MsgQuantumLock,
// MsgPQVoteKey, MsgPQCertificate, MsgSetPQEvidence; field numbers from
// zetaphy-chain/setup-node.sh pqMsgDefs). Unknown messages are shown field by
// field. Pure functions: the unit tests run them in Node.
import { protoFields, sha256, keccak_256, bytesToHex, toChecksumHex, CERT_TYPE_URL, ATTESTATION_BYTES, ADDRESS_BYTES } from '../vendor/zetaphy-lib.js';
import { decodeRawEvmTx } from './evm.js';

const dec = new TextDecoder('utf-8', { fatal: false });
const strictDec = new TextDecoder('utf-8', { fatal: true });
const str = (b) => (b ? dec.decode(b) : '');

export const TYPES = {
  send: '/cosmos.bank.v1beta1.MsgSend',
  delegate: '/cosmos.staking.v1beta1.MsgDelegate',
  undelegate: '/cosmos.staking.v1beta1.MsgUndelegate',
  redelegate: '/cosmos.staking.v1beta1.MsgBeginRedelegate',
  withdraw: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
  ethereumTx: '/cosmos.evm.vm.v1.MsgEthereumTx',
  evmCall: '/zetaphy.pq.v1.MsgEVMCall',
  quantumLock: '/zetaphy.pq.v1.MsgQuantumLock',
  pqVoteKey: '/zetaphy.pq.v1.MsgPQVoteKey',
  pqCertificate: CERT_TYPE_URL,
  setPQEvidence: '/zetaphy.pq.v1.MsgSetPQEvidence',
};

export const PUBKEY_LABELS = {
  '/zetaphy.crypto.mldsa44.PubKey': 'ML-DSA-44 (post-quantum)',
  '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey': 'eth_secp256k1',
  '/cosmos.crypto.secp256k1.PubKey': 'secp256k1',
  '/cosmos.crypto.ed25519.PubKey': 'ed25519',
  '/cosmos.crypto.multisig.LegacyAminoPubKey': 'multisig',
};

// ---- small protobuf helpers over pqcert's reader (BigInt varints) ----

const all = (fields, n) => fields.filter((f) => f.field === n);
function one(fields, n, wire) {
  let v;
  for (const f of fields) if (f.field === n && f.wire === wire) v = f.value; // proto3: last wins
  return v;
}
const getStr = (fs, n) => str(one(fs, n, 2));
const getBytes = (fs, n) => one(fs, n, 2) ?? new Uint8Array();
const getUint = (fs, n) => one(fs, n, 0) ?? 0n;

export function decodeAny(bytes) {
  const f = protoFields(bytes);
  return { typeUrl: getStr(f, 1), value: getBytes(f, 2) };
}

export function decodeCoin(bytes) {
  const f = protoFields(bytes);
  return { denom: getStr(f, 1), amount: getStr(f, 2) || '0' };
}

/** TxRaw { body_bytes = 1, auth_info_bytes = 2, signatures = 3 }. */
export function decodeTxRaw(bytes) {
  const f = protoFields(bytes);
  return { bodyBytes: getBytes(f, 1), authInfoBytes: getBytes(f, 2), signatures: all(f, 3).filter((x) => x.wire === 2).map((x) => x.value) };
}

/** TxBody { messages = 1 (Any), memo = 2, timeout_height = 3, extension_options = 1023 }. */
export function decodeTxBody(bytes) {
  const f = protoFields(bytes);
  return {
    messages: all(f, 1).filter((x) => x.wire === 2).map((x) => decodeAny(x.value)),
    memo: getStr(f, 2),
    timeoutHeight: getUint(f, 3),
    extensionOptions: all(f, 1023).filter((x) => x.wire === 2).map((x) => decodeAny(x.value).typeUrl),
  };
}

/** AuthInfo { signer_infos = 1, fee = 2 }: signers' key types and sequences, the fee. */
export function decodeAuthInfo(bytes) {
  const f = protoFields(bytes);
  const signers = all(f, 1).filter((x) => x.wire === 2).map((x) => {
    const s = protoFields(x.value);
    const pk = one(s, 1, 2);
    const any = pk ? decodeAny(pk) : null;
    let key = null;
    if (any) { try { key = getBytes(protoFields(any.value), 1); } catch { key = null; } }
    return { pubKeyType: any?.typeUrl ?? '', pubKeyLabel: PUBKEY_LABELS[any?.typeUrl] ?? (any?.typeUrl || ''), pubKeyBytes: key?.length ?? 0, sequence: getUint(s, 3) };
  });
  const feeB = one(f, 2, 2);
  let fee = { amount: [], gasLimit: 0n, payer: '', granter: '' };
  if (feeB) {
    const ff = protoFields(feeB);
    fee = { amount: all(ff, 1).filter((x) => x.wire === 2).map((x) => decodeCoin(x.value)), gasLimit: getUint(ff, 2), payer: getStr(ff, 3), granter: getStr(ff, 4) };
  }
  return { signers, fee };
}

// ---- messages ----
// Field kinds: addr (account, bech32 or 0x), valoper, text, uint, bytes, coin, coins,
// azeta (a decimal azetaphy amount in a string), evmData, bool, desc (validator description), any.

const MSGS = {
  [TYPES.send]: { name: 'MsgSend', fields: [[1, 'from', 'addr'], [2, 'to', 'addr'], [3, 'amount', 'coins']] },
  '/cosmos.bank.v1beta1.MsgMultiSend': { name: 'MsgMultiSend', fields: [] },
  [TYPES.delegate]: { name: 'MsgDelegate', fields: [[1, 'delegator', 'addr'], [2, 'validator', 'valoper'], [3, 'amount', 'coin']] },
  [TYPES.undelegate]: { name: 'MsgUndelegate', fields: [[1, 'delegator', 'addr'], [2, 'validator', 'valoper'], [3, 'amount', 'coin']] },
  [TYPES.redelegate]: { name: 'MsgBeginRedelegate', fields: [[1, 'delegator', 'addr'], [2, 'from validator', 'valoper'], [3, 'to validator', 'valoper'], [4, 'amount', 'coin']] },
  '/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation': { name: 'MsgCancelUnbondingDelegation', fields: [[1, 'delegator', 'addr'], [2, 'validator', 'valoper'], [3, 'amount', 'coin'], [4, 'creation height', 'uint']] },
  '/cosmos.staking.v1beta1.MsgCreateValidator': { name: 'MsgCreateValidator', fields: [[1, 'description', 'desc'], [5, 'validator', 'valoper'], [7, 'self delegation', 'coin'], [3, 'min self delegation', 'text']] },
  '/cosmos.staking.v1beta1.MsgEditValidator': { name: 'MsgEditValidator', fields: [[1, 'description', 'desc'], [2, 'validator', 'valoper']] },
  [TYPES.withdraw]: { name: 'MsgWithdrawDelegatorReward', fields: [[1, 'delegator', 'addr'], [2, 'validator', 'valoper']] },
  '/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission': { name: 'MsgWithdrawValidatorCommission', fields: [[1, 'validator', 'valoper']] },
  '/cosmos.distribution.v1beta1.MsgSetWithdrawAddress': { name: 'MsgSetWithdrawAddress', fields: [[1, 'delegator', 'addr'], [2, 'withdraw address', 'addr']] },
  '/cosmos.distribution.v1beta1.MsgFundCommunityPool': { name: 'MsgFundCommunityPool', fields: [[1, 'amount', 'coins'], [2, 'depositor', 'addr']] },
  '/cosmos.gov.v1.MsgVote': { name: 'MsgVote', fields: [[1, 'proposal', 'uint'], [2, 'voter', 'addr'], [3, 'option', 'voteOption'], [4, 'metadata', 'text']] },
  '/cosmos.gov.v1beta1.MsgVote': { name: 'MsgVote', fields: [[1, 'proposal', 'uint'], [2, 'voter', 'addr'], [3, 'option', 'voteOption']] },
  '/cosmos.gov.v1.MsgDeposit': { name: 'MsgDeposit', fields: [[1, 'proposal', 'uint'], [2, 'depositor', 'addr'], [3, 'amount', 'coins']] },
  '/cosmos.gov.v1.MsgSubmitProposal': { name: 'MsgSubmitProposal', fields: [[1, 'messages', 'anys'], [2, 'initial deposit', 'coins'], [3, 'proposer', 'addr'], [5, 'title', 'text'], [6, 'summary', 'text'], [7, 'expedited', 'bool']] },
  '/cosmos.slashing.v1beta1.MsgUnjail': { name: 'MsgUnjail', fields: [[1, 'validator', 'valoper']] },
  [TYPES.ethereumTx]: { name: 'MsgEthereumTx', fields: [[5, 'from', 'evmFrom']] },
  // ZETAPHY (zetaphy.pq.v1)
  [TYPES.evmCall]: { name: 'MsgEVMCall', zetaphy: true, fields: [[1, 'sender', 'addr'], [2, 'to', 'addr'], [3, 'value', 'azeta'], [4, 'data', 'evmData'], [5, 'gas limit', 'uint'], [6, 'as owner', 'addr']] },
  [TYPES.quantumLock]: { name: 'MsgQuantumLock', zetaphy: true, fields: [[1, 'signer', 'addr'], [2, 'owner', 'addr'], [3, 'controller', 'addr']] },
  [TYPES.pqVoteKey]: { name: 'MsgPQVoteKey', zetaphy: true, fields: [[1, 'operator', 'valoperOrAddr'], [2, 'pub key', 'bytes'], [3, 'proof', 'bytes'], [4, 'old key signature', 'bytes'], [5, 'validator owner', 'addr']] },
  [TYPES.pqCertificate]: { name: 'MsgPQCertificate', zetaphy: true, fields: [[1, 'signer', 'text'], [2, 'height', 'uint'], [3, 'attestations', 'attestations']] },
  [TYPES.setPQEvidence]: { name: 'MsgSetPQEvidence', zetaphy: true, fields: [[1, 'authority', 'addr'], [2, 'enabled', 'uintBool']] },
};

export const VOTE_OPTIONS = ['unspecified', 'yes', 'abstain', 'no', 'no with veto'];

/** The attestations of a certificate: [{ address (upper hex, CometBFT spelling), sigBytes }]; null if malformed. */
export function splitAttestations(bytes) {
  if (!bytes || bytes.length % ATTESTATION_BYTES) return null;
  const out = [];
  for (let i = 0; i < bytes.length; i += ATTESTATION_BYTES) {
    out.push({ address: bytesToHex(bytes.subarray(i, i + ADDRESS_BYTES)).toUpperCase(), sigBytes: ATTESTATION_BYTES - ADDRESS_BYTES });
  }
  return out;
}

function printable(bytes) {
  try {
    const s = strictDec.decode(bytes);
    return /^[\P{Cc}\t\n\r]*$/u.test(s) ? s : null;
  } catch { return null; }
}

/** Fields of a message nobody here knows: [{ name: '#n', kind, value }]. */
function genericFields(bytes) {
  let fs;
  try { fs = protoFields(bytes); } catch { return [{ name: 'raw', kind: 'bytes', value: bytes }]; }
  return fs.map((f) => {
    if (f.wire === 0) return { name: `#${f.field}`, kind: 'uint', value: f.value };
    if (f.wire === 2) {
      const s = printable(f.value);
      return s != null && s.length ? { name: `#${f.field}`, kind: 'text', value: s } : { name: `#${f.field}`, kind: 'bytes', value: f.value };
    }
    return { name: `#${f.field}`, kind: 'bytes', value: f.value };
  });
}

function fieldValue(fs, num, kind) {
  switch (kind) {
    case 'coins': return all(fs, num).filter((x) => x.wire === 2).map((x) => decodeCoin(x.value));
    case 'coin': { const b = one(fs, num, 2); return b ? decodeCoin(b) : null; }
    case 'uint': case 'voteOption': case 'uintBool': return getUint(fs, num);
    case 'bool': return getUint(fs, num) !== 0n;
    case 'bytes': case 'evmData': case 'attestations': return getBytes(fs, num);
    case 'evmFrom': { const b = getBytes(fs, num); return b.length === 20 ? toChecksumHex(b) : ''; }
    case 'desc': { const b = one(fs, num, 2); if (!b) return ''; const d = protoFields(b); return getStr(d, 1); } // moniker
    case 'anys': return all(fs, num).filter((x) => x.wire === 2).map((x) => decodeAny(x.value).typeUrl);
    default: return getStr(fs, num);
  }
}

/**
 * One message: { typeUrl, name, known, zetaphy, fields: [{ name, kind, value }], evmHash?, certificate? }.
 * Malformed bytes give known: false with the raw bytes (never a throw).
 */
export function decodeMessage({ typeUrl, value }) {
  const def = MSGS[typeUrl];
  const name = def?.name ?? (String(typeUrl).split('.').pop() || 'message');
  if (!def) return { typeUrl, name, known: false, zetaphy: false, fields: genericFields(value) };
  let fs;
  try { fs = protoFields(value); } catch { return { typeUrl, name, known: false, zetaphy: !!def.zetaphy, fields: [{ name: 'raw', kind: 'bytes', value }] }; }
  const out = { typeUrl, name, known: true, zetaphy: !!def.zetaphy, fields: [] };
  for (const [num, fname, kind] of def.fields) {
    const v = fieldValue(fs, num, kind);
    const empty = v == null || v === '' || (Array.isArray(v) && !v.length) || (v instanceof Uint8Array && !v.length) || (kind === 'uint' && v === 0n && fname !== 'height');
    if (empty && !['value', 'data', 'enabled'].includes(fname)) continue;
    out.fields.push({ name: fname, kind, value: v });
  }
  if (typeUrl === TYPES.ethereumTx) {
    const raw = getBytes(fs, 6);
    if (raw.length) {
      out.evmHash = '0x' + bytesToHex(keccak_256(raw)); // the Ethereum tx hash: keccak256 of the signed tx
      out.evm = decodeRawEvmTx(raw);
      if (out.evm?.to) out.fields.push({ name: 'to', kind: 'addr', value: out.evm.to });
      if (out.evm) out.fields.push({ name: 'value', kind: 'azetaBig', value: out.evm.value });
    }
  }
  if (typeUrl === TYPES.evmCall) {
    const to = getStr(fs, 2);
    if (!to) out.contractCreation = true;
  }
  if (typeUrl === TYPES.pqCertificate) {
    const att = getBytes(fs, 3);
    out.certificate = { signer: getStr(fs, 1), height: getUint(fs, 2), attestations: splitAttestations(att), attestationBytes: att.length };
  }
  return out;
}

/** CometBFT's hash of a tx: upper-case hex sha256 of its bytes. */
export const cometTxHash = (bytes) => bytesToHex(sha256(bytes)).toUpperCase();

/**
 * A whole tx from its bytes (as /block returns them, base64-decoded):
 * { hash, size, memo, messages, signers, fee, isCertificate, evmHashes, error? }.
 * A tx that is not valid protobuf gives { hash, size, error } (never a throw).
 */
export function decodeTx(bytes) {
  const hash = cometTxHash(bytes);
  try {
    const raw = decodeTxRaw(bytes);
    const body = decodeTxBody(raw.bodyBytes);
    const auth = raw.authInfoBytes.length ? decodeAuthInfo(raw.authInfoBytes) : { signers: [], fee: { amount: [], gasLimit: 0n } };
    const messages = body.messages.map(decodeMessage);
    return {
      hash, size: bytes.length, memo: body.memo, timeoutHeight: body.timeoutHeight, messages,
      signers: auth.signers, fee: auth.fee, signatures: raw.signatures.length,
      isCertificate: messages.length === 1 && messages[0].typeUrl === TYPES.pqCertificate,
      evmHashes: messages.filter((m) => m.evmHash).map((m) => m.evmHash),
      extensionOptions: body.extensionOptions,
    };
  } catch (e) {
    return { hash, size: bytes.length, error: String(e.message ?? e), messages: [], signers: [], fee: { amount: [], gasLimit: 0n }, evmHashes: [], isCertificate: false };
  }
}

/** Every account (lower-case 0x) a decoded tx's messages name: for "txs of this address". */
export function txAddresses(tx, toLower) {
  const out = new Set();
  for (const m of tx.messages ?? []) {
    for (const f of m.fields) {
      if (['addr', 'valoper', 'valoperOrAddr', 'evmFrom'].includes(f.kind) && typeof f.value === 'string') {
        const a = toLower(f.value);
        if (a) out.add(a);
      }
    }
  }
  return out;
}

/** A short label for a tx in lists: its message names ("MsgSend", "MsgEVMCall ×2"). */
export function txLabel(tx) {
  if (tx.error) return 'undecodable';
  const counts = new Map();
  for (const m of tx.messages) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ') || 'empty';
}

// ---- CometBFT events (tx_result.events), as plain strings ----

/**
 * Events as [{ type, attributes: [{ key, value }] }] with keys and values as strings
 * (CometBFT 0.38 sends plain strings; older nodes base64: decoded when that is clearly it).
 */
export function normalizeEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.slice(0, 200).map((e) => ({
    type: String(e?.type ?? ''),
    attributes: (Array.isArray(e?.attributes) ? e.attributes : []).slice(0, 100).map((a) => ({ key: String(a?.key ?? ''), value: String(a?.value ?? '') })),
  }));
}

/**
 * EVM logs found in events (cosmos/evm "tx_log" events, attribute "txLog": JSON of
 * { address, topics, data (base64 or 0x) }): [{ address, topics, data (0x hex) }].
 */
export function logsFromEvents(events) {
  const out = [];
  for (const e of normalizeEvents(events)) {
    if (e.type !== 'tx_log') continue;
    for (const a of e.attributes) {
      if (a.key !== 'txLog') continue;
      try {
        const j = JSON.parse(a.value);
        let data = j.data ?? '0x';
        if (typeof data === 'string' && !/^0x/i.test(data)) {
          const bin = atob(data);
          data = '0x' + Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
        }
        if (typeof j.address === 'string' && Array.isArray(j.topics)) out.push({ address: j.address, topics: j.topics.map(String), data: String(data) });
      } catch { /* not a log */ }
    }
  }
  return out;
}
