// Post-quantum block verifier for ZETAPHY: checks the ML-DSA-44 vote
// certificate that the proposer of block H+1 puts in front of its txs, the
// same rule every node applies (zetaphy-chain evmd/zetaphy_pqcert.go,
// pqCheckCert) but run by the client, over CometBFT RPC only.
//
// What the chain does
//   Each validator with a registered ML-DSA-44 vote key signs every precommit
//   (a vote extension) over
//     "zetaphy/pq-vote\0" || chain id || "\0" || uint64_be(H) || hash of block H (32 bytes)
//   (pure ML-DSA-44, empty context). Block H+1's first tx is a TxRaw whose body
//   holds one Any /zetaphy.pq.v1.MsgPQCertificate { signer = 1, height = 2 (= H),
//   attestations = 3 }, attestations being (consensus address 20 bytes ||
//   signature 2420 bytes)*. With T = power of H's validator set and U = power of
//   its validators without a key valid at H, nodes require
//     3 * (power with a valid signature) > 2T - 3U     (nothing when 2T - 3U < 0)
//   Vote keys are in the KV store "zetaphypq": key 0x02 || consensus address,
//   value since (uint64 BE, the block that registered it) || pubkey (1312) ||
//   previous pubkey (1312, optional). Votes on h use pubkey if since < h, else
//   the previous one (none: no key). Read at state H (abci_query height H).
//
// Trust model (what a passing verifyBlock proves)
//   - The signatures bind (chain id, H, block hash), so the block hash, the
//     certificate and the block data from the node need no trust: a node that
//     lies about the hash or forges the certificate cannot produce signatures
//     that verify. The header and txs of H are checked against that hash too
//     (CometBFT header merkle root, data_hash), so they are covered as well.
//   - What must be trusted is the validator set of H (addresses and powers) and
//     their vote keys. By default both come from the same node (/validators and
//     abci_query without proofs): a dishonest node could invent validators and
//     keys and "certify" anything. Pass pinnedKeys (exportVoteKeys output, made
//     earlier from a node you trust) to take powers and keys from that file
//     instead; then the node is trusted for nothing. A pin is a snapshot: re-export
//     after validator set changes or key rotations (a stale pin errs on the side of
//     "not verified": rotated keys and new validators simply do not count).
//   - The chain id signed over is options.chainId, else the pin's, else the
//     header's; pin it when the node is not trusted.
//   - Proven: validators holding the required power signed this hash with ML-DSA-44.
//     Not proven: that the state transitions in the block are valid (that needs
//     the validators to be honest, as for any light client).

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, varint, PUBLIC_KEY_BYTES, SIGNATURE_BYTES } from './pqtx.js';

export const CERT_TYPE_URL = '/zetaphy.pq.v1.MsgPQCertificate';
export const VOTE_KEY_STORE_PATH = '/store/zetaphypq/key';
export const ADDRESS_BYTES = 20;
export const ATTESTATION_BYTES = ADDRESS_BYTES + SIGNATURE_BYTES; // 2440
const VOTE_PREFIX = 'zetaphy/pq-vote\0';
const utf8 = (s) => new TextEncoder().encode(s);
const upperHex = (b) => bytesToHex(b).toUpperCase();

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const fromBase64 = (s) => Uint8Array.from(atob(s ?? ''), (c) => c.charCodeAt(0));

/** The bytes a validator signs for block `height` with hash `hash` (32 bytes). */
export function voteMessage(chainId, height, hash) {
  const h = BigInt(height);
  if (h < 0n || h >= 2n ** 64n) throw new Error('height out of range');
  const be = new Uint8Array(8);
  new DataView(be.buffer).setBigUint64(0, h);
  return concat([utf8(`${VOTE_PREFIX}${chainId}\0`), be, hash]);
}

// ---- vote keys ----

/** Decodes a zetaphypq vote key entry: { since, pubKey, previousPubKey } (bytes), or null. */
export function decodeVoteKeyEntry(value) {
  if (!value || value.length < 8 + PUBLIC_KEY_BYTES) return null;
  const since = new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0);
  const previousPubKey = value.length === 8 + 2 * PUBLIC_KEY_BYTES ? value.subarray(8 + PUBLIC_KEY_BYTES) : null;
  return { since, pubKey: value.subarray(8, 8 + PUBLIC_KEY_BYTES), previousPubKey };
}

/**
 * The key valid for votes on height h (pqVoteKeyAt): pubKey if since < h,
 * else the previous key, else null. An entry without `since` (a pin of plain
 * keys) is valid at every height.
 */
export function voteKeyAt(entry, h) {
  if (!entry || !entry.pubKey) return null;
  if (entry.since == null || BigInt(entry.since) < BigInt(h)) return entry.pubKey;
  return entry.previousPubKey ?? null;
}

// ---- minimal protobuf reader ----

function readVarint(buf, i) {
  let v = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (i >= buf.length) throw new Error('truncated varint');
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if (b < 0x80) return [BigInt.asUintN(64, v), i];
  }
  throw new Error('varint too long');
}

/** The fields of one protobuf message: [{ field, wire, value }] (value: BigInt or bytes). */
export function protoFields(buf) {
  const out = [];
  for (let i = 0; i < buf.length;) {
    let key, value;
    [key, i] = readVarint(buf, i);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (field === 0) throw new Error('field number 0');
    if (wire === 0) [value, i] = readVarint(buf, i);
    else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (i + n > buf.length) throw new Error('truncated fixed field');
      value = buf.subarray(i, i + n); i += n;
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      if (len > BigInt(buf.length - i)) throw new Error('truncated field');
      value = buf.subarray(i, i + Number(len)); i += Number(len);
    } else throw new Error(`unsupported wire type ${wire}`);
    out.push({ field, wire, value });
  }
  return out;
}

// proto3: the last occurrence of a scalar field wins.
function last(fields, field, wire) {
  let v;
  for (const f of fields) {
    if (f.field !== field) continue;
    if (f.wire !== wire) throw new Error(`field ${field}: wrong wire type`);
    v = f.value;
  }
  return v;
}

/**
 * The certificate in a tx (TxRaw bytes): { signer, height, attestations } when the
 * body holds exactly one message and it is a MsgPQCertificate (pqCertOf), else null.
 * Throws on malformed protobuf.
 */
export function decodeCertificate(txBytes) {
  const body = last(protoFields(txBytes), 1, 2);
  if (!body) return null;
  const msgs = protoFields(body).filter((f) => f.field === 1);
  if (msgs.length !== 1 || msgs[0].wire !== 2) return null;
  const any = protoFields(msgs[0].value);
  const typeUrl = new TextDecoder().decode(last(any, 1, 2) ?? new Uint8Array());
  if (typeUrl !== CERT_TYPE_URL) return null;
  const m = protoFields(last(any, 2, 2) ?? new Uint8Array());
  return {
    signer: new TextDecoder().decode(last(m, 1, 2) ?? new Uint8Array()),
    height: last(m, 2, 0) ?? 0n,
    attestations: last(m, 3, 2) ?? new Uint8Array(),
  };
}

// ---- CometBFT header and txs hashes (so the node's block data is checked too) ----

const leafHash = (b) => sha256(concat([Uint8Array.of(0), b]));
const innerHash = (l, r) => sha256(concat([Uint8Array.of(1), l, r]));

/** CometBFT merkle.HashFromByteSlices (RFC 6962). */
export function merkleRoot(items) {
  if (items.length === 0) return sha256(new Uint8Array());
  if (items.length === 1) return leafHash(items[0]);
  let k = 1;
  while (k * 2 < items.length) k *= 2;
  return innerHash(merkleRoot(items.slice(0, k)), merkleRoot(items.slice(k)));
}

const pbVarint = (field, v) => (BigInt(v ?? 0) === 0n ? new Uint8Array() : concat([varint(field << 3), varint(v)]));
const pbBytes = (field, b) => (b.length ? concat([varint((field << 3) | 2), varint(b.length), b]) : new Uint8Array());
const pbMessage = (field, b) => concat([varint((field << 3) | 2), varint(b.length), b]); // non-nullable: always written
const hex = (s) => hexToBytes(s ?? '');

/** RFC 3339 UTC time (as CometBFT prints it) -> google.protobuf.Timestamp bytes. */
function timestampBytes(t) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(String(t));
  if (!m) throw new Error(`unsupported time ${t}`);
  const ms = Date.parse(`${m[1]}Z`);
  if (!Number.isFinite(ms)) throw new Error(`unsupported time ${t}`);
  return concat([pbVarint(1, BigInt(ms / 1000)), pbVarint(2, Number((m[2] ?? '').padEnd(9, '0')))]);
}

/** The hash of a CometBFT header as /block returns it (types.Header.Hash). */
export function headerHash(h) {
  const blockId = (id) => concat([pbBytes(1, hex(id?.hash)),
    pbMessage(2, concat([pbVarint(1, BigInt(id?.parts?.total ?? 0)), pbBytes(2, hex(id?.parts?.hash))]))]);
  return merkleRoot([
    concat([pbVarint(1, BigInt(h.version?.block ?? 0)), pbVarint(2, BigInt(h.version?.app ?? 0))]),
    pbBytes(1, utf8(h.chain_id ?? '')),
    pbVarint(1, BigInt(h.height)),
    timestampBytes(h.time),
    blockId(h.last_block_id),
    ...['last_commit_hash', 'data_hash', 'validators_hash', 'next_validators_hash', 'consensus_hash',
      'app_hash', 'last_results_hash', 'evidence_hash', 'proposer_address'].map((k) => pbBytes(1, hex(h[k]))),
  ]);
}

/** CometBFT Txs.Hash (the header's data_hash): merkle root of sha256 of each tx. */
export const txsHash = (txs) => merkleRoot(txs.map((t) => sha256(t)));

// ---- CometBFT RPC ----

/** A CometBFT JSON-RPC client: (method, params) => result. Throws with the node's error text. */
export function cometClient(url, { timeoutMs = 20_000 } = {}) {
  let id = 0;
  return async (method, params = {}) => {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { throw new Error(`cannot reach CometBFT RPC ${url}: ${e.cause?.message ?? e.message}`); }
    let body;
    try { body = await res.json(); } catch { throw new Error(`${url} is not a CometBFT RPC (HTTP ${res.status})`); }
    if (body?.error) throw new Error(`${method}: ${body.error.data || body.error.message}`);
    if (!res.ok || !body || !('result' in body)) throw new Error(`${url} is not a CometBFT RPC (HTTP ${res.status})`);
    return body.result;
  };
}

const asRpc = (cometRpc) => (typeof cometRpc === 'function' ? cometRpc : cometClient(String(cometRpc)));
const NOT_YET = /must be less than or equal to the current blockchain height/;

async function getBlock(rpc, height) {
  const r = await rpc('block', { height: String(height) });
  if (!r?.block?.header || !r.block_id?.hash) throw new Error(`block ${height}: unexpected answer from the node`);
  return r;
}

/** The validator set at `height`: [{ address (hex, upper case), power (BigInt) }], all pages. */
export async function getValidators(rpc, height) {
  rpc = asRpc(rpc);
  const out = [];
  for (let page = 1; ; page++) {
    const r = await rpc('validators', { height: String(height), page: String(page), per_page: '100' });
    const vs = r?.validators ?? [];
    for (const v of vs) out.push({ address: String(v.address).toUpperCase(), power: BigInt(v.voting_power) });
    if (!vs.length || out.length >= Number(r.total ?? 0)) break;
  }
  if (new Set(out.map((v) => v.address)).size !== out.length) throw new Error(`validators at ${height}: the node listed a validator twice`);
  return out;
}

/** The raw vote key entry of one validator at state `height` (abci_query), decoded, or null. */
export async function getVoteKeyEntry(rpc, address, height) {
  rpc = asRpc(rpc);
  const r = await rpc('abci_query', { path: VOTE_KEY_STORE_PATH, data: `02${address}`, height: String(height), prove: false });
  const resp = r?.response;
  if (!resp) throw new Error('abci_query: unexpected answer from the node');
  if (resp.code) throw new Error(`abci_query ${VOTE_KEY_STORE_PATH} at ${height}: ${resp.log || `code ${resp.code}`}`);
  if (resp.height != null && String(resp.height) !== '0' && String(resp.height) !== String(height)) {
    throw new Error(`abci_query: asked for state ${height}, the node answered for ${resp.height}`);
  }
  return decodeVoteKeyEntry(fromBase64(resp.value));
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---- pinned keys ----

/**
 * Validator powers and vote keys at `height` (default: the latest block), to pin:
 * { chainId, height, validators: { <cons address hex>: { power, since, pubKey, previousPubKey } } }
 * (strings: decimal numbers and hex; pubKey null for a validator without a key).
 */
export async function exportVoteKeys(cometRpc, { height } = {}) {
  const rpc = asRpc(cometRpc);
  const status = await rpc('status', {});
  const latest = BigInt(status?.sync_info?.latest_block_height ?? 0);
  const h = height == null ? latest : BigInt(height);
  if (h < 1n) throw new Error('height must be 1 or more');
  if (h > latest) throw new Error(`height ${h} is beyond the node's latest block ${latest}`);
  const block = await getBlock(rpc, h);
  const vals = await getValidators(rpc, h);
  const entries = await mapLimit(vals, 8, (v) => getVoteKeyEntry(rpc, v.address, h));
  const validators = {};
  vals.forEach((v, i) => {
    const e = entries[i];
    validators[v.address] = { power: v.power.toString(), since: e ? e.since.toString() : null,
      pubKey: e ? bytesToHex(e.pubKey) : null, previousPubKey: e?.previousPubKey ? bytesToHex(e.previousPubKey) : null };
  });
  return { chainId: block.block.header.chain_id, height: h.toString(), validators };
}

/** Checks and decodes a pin (exportVoteKeys output, or { <address>: { power, pubKey } }). */
export function parsePinnedKeys(pin) {
  if (!pin || typeof pin !== 'object') throw new Error('pinned keys: not a JSON object');
  const map = pin.validators ?? pin;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('pinned keys: no "validators" map');
  const key = (v, what, addr) => {
    if (v == null || v === '') return null;
    const b = hexToBytes(v);
    if (b.length !== PUBLIC_KEY_BYTES) throw new Error(`pinned keys: ${addr} ${what} is not ${PUBLIC_KEY_BYTES} bytes`);
    return b;
  };
  const validators = Object.entries(map).map(([address, v]) => {
    const a = String(address).replace(/^0x/i, '').toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(a)) throw new Error(`pinned keys: ${address} is not a 20-byte consensus address (hex)`);
    if (!v || typeof v !== 'object') throw new Error(`pinned keys: ${address}: expected { power, pubKey }`);
    if (!/^\d+$/.test(String(v.power ?? '')) || BigInt(v.power) <= 0n) throw new Error(`pinned keys: ${address} needs a positive power`);
    if (v.since != null && !/^\d+$/.test(String(v.since))) throw new Error(`pinned keys: ${address} since must be a block height`);
    const pubKey = key(v.pubKey, 'pubKey', a);
    return { address: a, power: BigInt(v.power), entry: pubKey
      ? { since: v.since == null ? null : BigInt(v.since), pubKey, previousPubKey: key(v.previousPubKey, 'previousPubKey', a) }
      : null };
  });
  if (!validators.length) throw new Error('pinned keys: no validators');
  if (new Set(validators.map((v) => v.address)).size !== validators.length) throw new Error('pinned keys: a validator is listed twice');
  return { chainId: pin.validators ? pin.chainId ?? null : null, height: pin.validators && pin.height != null ? BigInt(pin.height) : null, validators };
}

// ---- the verifier ----

const short = (a) => `${a.slice(0, 8)}…`;

/**
 * Verifies the ML-DSA-44 certificate of block `height` (found in block height+1).
 * cometRpc: CometBFT RPC URL, or a function (method, params) => result.
 * options.chainId: the chain id the votes must be for (default: the pin's, else the header's).
 * options.pinnedKeys: exportVoteKeys output (or its JSON text) to trust instead of the node
 * for validator powers and keys.
 * Returns { height, hash, chainId, totalPower, unregisteredPower, signedPower, required, ok,
 *   pqMajority, signers: [{ address, power }], validators: [{ address, power, hasKey, signed }],
 *   problems: [text], keysFrom: 'node' | 'pinned', certificate: bool }.
 * ok: the chain's rule holds for this certificate and the node's block data matches the hash.
 * pqMajority: ok, and the ML-DSA signers alone hold more than 2/3 of all the power.
 * Powers are BigInt; required is the least signed power that passes (0n: nothing required).
 */
export async function verifyBlock(cometRpc, height, { chainId, pinnedKeys } = {}) {
  const rpc = asRpc(cometRpc);
  if (!/^\d+$/.test(String(height)) || BigInt(height) < 1n) throw new Error('height must be a block number (1 or more)');
  const H = BigInt(height);
  const problems = [];
  const pin = pinnedKeys == null ? null : parsePinnedKeys(typeof pinnedKeys === 'string' ? JSON.parse(pinnedKeys) : pinnedKeys);

  // Block H: its hash is what the validators sign. Header and txs are checked against it.
  const block = await getBlock(rpc, H).catch((e) => {
    throw NOT_YET.test(e.message) ? new Error(`block ${H} is not committed yet (${e.message.replace(/^block: /, '')})`) : e;
  });
  const hash = String(block.block_id.hash).toUpperCase();
  const header = block.block.header;
  const hashBytes = hexToBytes(hash);
  let dataOk = hashBytes.length === 32;
  if (!dataOk) problems.push(`the node's hash for block ${H} is not 32 bytes`);
  if (String(header.height) !== String(H)) { dataOk = false; problems.push(`the node returned block ${header.height} for ${H}`); }
  try {
    if (upperHex(headerHash(header)) !== hash) { dataOk = false; problems.push(`the node's header for block ${H} does not hash to ${hash}`); }
    const txs = (block.block.data?.txs ?? []).map(fromBase64);
    if (upperHex(txsHash(txs)) !== String(header.data_hash).toUpperCase()) { dataOk = false; problems.push(`the node's txs for block ${H} do not match the header's data_hash`); }
  } catch (e) { dataOk = false; problems.push(`cannot check the header of block ${H}: ${e.message}`); }
  const expectedChain = chainId ?? pin?.chainId ?? header.chain_id;
  if (header.chain_id !== expectedChain) { dataOk = false; problems.push(`block ${H} is on chain ${header.chain_id}, not ${expectedChain}`); }

  // Validators of H and the keys valid for votes on H.
  let vals;
  if (pin) {
    vals = pin.validators.map((v) => ({ address: v.address, power: v.power, key: voteKeyAt(v.entry, H) }));
    try { // the node's view, only to warn that the pin may be stale; never trusted
      const nodeVals = await getValidators(rpc, H);
      const pinned = new Map(pin.validators.map((v) => [v.address, v.power]));
      const differ = nodeVals.filter((v) => pinned.get(v.address) !== v.power).length + pin.validators.filter((v) => !nodeVals.some((n) => n.address === v.address)).length;
      if (differ) problems.push(`note: the node's validator set at ${H} differs from the pinned one in ${differ} validator(s); using the pin (re-export it from a trusted node if the set changed)`);
    } catch { /* the pin is enough */ }
  } else {
    const nodeVals = await getValidators(rpc, H);
    const entries = await mapLimit(nodeVals, 8, (v) => getVoteKeyEntry(rpc, v.address, H));
    vals = nodeVals.map((v, i) => ({ ...v, key: voteKeyAt(entries[i], H) }));
  }
  let total = 0n, unregistered = 0n;
  const byAddr = new Map();
  for (const v of vals) {
    total += v.power;
    if (!v.key) unregistered += v.power;
    byAddr.set(v.address, { address: v.address, power: v.power, hasKey: !!v.key, signed: false, key: v.key });
  }
  const need = 2n * total - 3n * unregistered; // signed power must be > need / 3
  const required = need < 0n ? 0n : need / 3n + 1n;

  // Block H+1's first tx: the certificate. Self-authenticating, so taken from the node as is.
  let signed = 0n, certificate = false, next = null;
  const signers = [];
  try { next = await getBlock(rpc, H + 1n); } catch (e) {
    if (!NOT_YET.test(e.message)) throw e;
    problems.push(`block ${H + 1n} is not committed yet, so block ${H} has no certificate yet`);
  }
  if (next) {
    const tx0 = next.block.data?.txs?.[0];
    let cert = null;
    try { cert = tx0 ? decodeCertificate(fromBase64(tx0)) : null; } catch (e) { problems.push(`block ${H + 1n}: its first tx is not valid protobuf (${e.message})`); }
    if (!cert) {
      if (need >= 0n) problems.push(`block ${H + 1n} does not start with a vote certificate`);
    } else if (cert.height !== H) {
      problems.push(`the certificate in block ${H + 1n} is for height ${cert.height}, not ${H}: ignored`);
    } else if (cert.attestations.length % ATTESTATION_BYTES) {
      problems.push(`the certificate's attestations are ${cert.attestations.length} bytes, not a multiple of ${ATTESTATION_BYTES}: ignored`);
    } else {
      certificate = true;
      const msg = voteMessage(expectedChain, H, hashBytes);
      for (let i = 0; i < cert.attestations.length; i += ATTESTATION_BYTES) {
        const addr = upperHex(cert.attestations.subarray(i, i + ADDRESS_BYTES));
        const sig = cert.attestations.subarray(i + ADDRESS_BYTES, i + ATTESTATION_BYTES);
        const v = byAddr.get(addr);
        if (!v) { problems.push(`${addr} signed but is not a validator at ${H}: ignored`); continue; }
        if (!v.key) { problems.push(`${addr} signed but has no vote key valid at ${H}: ignored`); continue; }
        if (v.signed) { problems.push(`${addr} is in the certificate more than once: counted once`); continue; }
        let good = false;
        try { good = ml_dsa44.verify(sig, msg, v.key); } catch { good = false; }
        if (!good) { problems.push(`${addr}: the ML-DSA-44 signature does not verify for block ${H} (${short(hash)}) on ${expectedChain}`); continue; }
        v.signed = true;
        signed += v.power;
        signers.push({ address: addr, power: v.power });
      }
    }
  }
  const ruleOk = need < 0n || 3n * signed > need;
  if (!ruleOk && next) problems.push(`signed power ${signed} is not enough: needs at least ${required} (more than 2/3 of ${total} minus ${unregistered} without a key)`);
  return {
    height: Number(H), hash, chainId: expectedChain,
    totalPower: total, unregisteredPower: unregistered, signedPower: signed, required,
    ok: ruleOk && dataOk && next != null,
    // Validators with more than 2/3 of ALL the power signed (not only of those with a key).
    pqMajority: ruleOk && dataOk && next != null && 3n * signed > 2n * total,
    signers,
    validators: [...byAddr.values()].map(({ key, ...v }) => v),
    problems,
    keysFrom: pin ? 'pinned' : 'node',
    certificate,
  };
}
