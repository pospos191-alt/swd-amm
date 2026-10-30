// Quantum-safe AI attestations (docs/future/crosschain-assist.md, item 30): the archive format and its checks,
// shared by the CLI (zetaphy-network/src/pqattest.js: sign, verify, anchor) and the hub's browser verifier
// (assist.js). No imports: the caller hands in the crypto, so the same code runs in Node and under the hub's
// CSP (ML-DSA-44 and keccak-256 from the wallet's vendor/pqwallet.js, SHA-256 from WebCrypto).
//
// Archive (JSON):
//   { format: "zetaphy.neuro-attestation.v1",
//     payload: { kind, createdAt, subject: { chain, address }, reportHash, skill, model, verdict?, report? },
//     payloadHash: "0x" + sha256(canonical(payload)),
//     signature: { alg: "ML-DSA-44", publicKey: "0x…" (1312 bytes), keyHash: "0x" + keccak256(publicKey), sig: "0x…" (2420 bytes) },
//     anchor?: { chainId: 77390, contract: "0x…" (NeuroAnchor), hash: archiveHash, time, block, tx } }
// The signed message is the UTF-8 text "zetaphy.neuro-attestation.v1\n<payloadHash>" (FIPS 204 pure ML-DSA,
// empty context, as ZETAPHY's precompile). archiveHash = "0x" + keccak256(canonical({ format, payloadHash,
// signature: { alg, publicKey, sig } })) is what NeuroAnchor.anchor() records: the anchor shows the archive (payload,
// key and signature) existed by that block. `anchor` itself is outside the hash (it is added after anchoring).

export const FORMAT = 'zetaphy.neuro-attestation.v1';
export const ALG = 'ML-DSA-44';
export const PUBLIC_KEY_BYTES = 1312;
export const SIGNATURE_BYTES = 2420;
const HEX = /^0x([0-9a-f]{2})*$/;

export const toHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  if (typeof h !== 'string' || !HEX.test(h)) throw new Error('not lowercase 0x hex');
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}
const utf8 = (s) => new TextEncoder().encode(s);

/** Canonical JSON: object keys sorted (UTF-16 order), no spaces; refuses what JSON cannot carry exactly. */
export function canonical(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('canonical: non-finite number'); return JSON.stringify(v); }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  throw new Error(`canonical: cannot encode a ${typeof v}`);
}

/** The bytes ML-DSA signs for a payload hash. */
export const signedMessage = (payloadHash) => utf8(`${FORMAT}\n${payloadHash}`);

/** The part of an archive its hash (and the on-chain anchor) covers. */
export const anchoredPart = (a) => ({ format: a.format, payloadHash: a.payloadHash, signature: { alg: a.signature?.alg, publicKey: a.signature?.publicKey, sig: a.signature?.sig } });

/**
 * A signed archive. crypto: { sha256(bytes), keccak256(bytes), sign(messageBytes) -> sig bytes } (each may be async);
 * publicKey: Uint8Array (ML-DSA-44).
 */
export async function buildArchive(payload, publicKey, crypto) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload: an object');
  const payloadHash = toHex(await crypto.sha256(utf8(canonical(payload))));
  const sig = await crypto.sign(signedMessage(payloadHash));
  return { format: FORMAT, payload, payloadHash,
    signature: { alg: ALG, publicKey: toHex(publicKey), keyHash: toHex(await crypto.keccak256(publicKey)), sig: toHex(sig) } };
}

/** keccak256 of the anchored part: what NeuroAnchor records. */
export const archiveHash = async (a, crypto) => toHex(await crypto.keccak256(utf8(canonical(anchoredPart(a)))));

/**
 * Checks an archive. crypto: { sha256, keccak256, verify(sig, msg, publicKey) -> bool }. Optional:
 *   anchorOf(hash) -> { time, block } (time 0 / null: not anchored), to check the stated anchor on chain;
 *   checkReport(payload) -> problem text or null (e.g. the report's verdict hash recomputed with Neuro's code);
 *   trustedKeys: keyHashes the reader trusts (a runner's, Neuro's release key); others verify but are "unknown signer".
 * Returns { ok, problems[], payloadHash, archiveHash, keyHash, signer: 'trusted' | 'unknown', anchored: null | { time, block } }.
 */
export async function verifyArchive(a, crypto, { anchorOf = null, checkReport = null, trustedKeys = [] } = {}) {
  const problems = [];
  const out = { ok: false, problems, payloadHash: null, archiveHash: null, keyHash: null, signer: 'unknown', anchored: null };
  if (!a || typeof a !== 'object') { problems.push('not an archive'); return out; }
  if (a.format !== FORMAT) problems.push(`format is ${String(a.format).slice(0, 60)}, not ${FORMAT}`);
  if (a.signature?.alg !== ALG) problems.push(`signature alg is ${String(a.signature?.alg).slice(0, 30)}, not ${ALG}`);
  let pub = null, sig = null;
  try { pub = fromHex(a.signature?.publicKey); if (pub.length !== PUBLIC_KEY_BYTES) { problems.push(`public key is ${pub.length} bytes, not ${PUBLIC_KEY_BYTES}`); pub = null; } } catch { problems.push('public key: not hex'); }
  try { sig = fromHex(a.signature?.sig); if (sig.length !== SIGNATURE_BYTES) { problems.push(`signature is ${sig.length} bytes, not ${SIGNATURE_BYTES}`); sig = null; } } catch { problems.push('signature: not hex'); }
  let payloadHash = null;
  try { payloadHash = toHex(await crypto.sha256(utf8(canonical(a.payload)))); } catch (e) { problems.push(`payload: ${e.message}`); }
  out.payloadHash = payloadHash;
  if (payloadHash && payloadHash !== a.payloadHash) problems.push('payload changed: its hash is not payloadHash');
  if (pub) {
    out.keyHash = toHex(await crypto.keccak256(pub));
    if (a.signature.keyHash !== out.keyHash) problems.push('keyHash is not keccak256(publicKey)');
    if (trustedKeys.map((k) => String(k).toLowerCase()).includes(out.keyHash)) out.signer = 'trusted';
  }
  if (pub && sig && typeof a.payloadHash === 'string') {
    let good = false;
    try { good = await crypto.verify(sig, signedMessage(a.payloadHash), pub); } catch { good = false; }
    if (!good) problems.push('ML-DSA-44 signature does not verify');
  }
  try { out.archiveHash = await archiveHash(a, crypto); } catch (e) { problems.push(`archive hash: ${e.message}`); }
  if (a.anchor != null) {
    if (a.anchor.hash !== out.archiveHash) problems.push('anchor.hash is not this archive\'s hash');
    else if (anchorOf) {
      try {
        const got = await anchorOf(out.archiveHash, a.anchor);
        if (!got || !Number(got.time)) problems.push('not anchored on chain');
        else {
          out.anchored = { time: Number(got.time), block: Number(got.block ?? 0) };
          if (a.anchor.time != null && Number(a.anchor.time) !== out.anchored.time) problems.push('anchor time differs from the chain');
        }
      } catch (e) { problems.push(`anchor lookup failed: ${String(e.message).slice(0, 120)}`); }
    }
  }
  if (checkReport) {
    try { const p = await checkReport(a.payload); if (p) problems.push(p); } catch (e) { problems.push(`report check: ${String(e.message).slice(0, 120)}`); }
  }
  out.ok = problems.length === 0;
  return out;
}

/** NeuroAnchor.anchoredAt(bytes32) call data and its answer (time, block, by). */
export const ANCHORED_AT = '0x9591a610'; // anchoredAt(bytes32)
export const ANCHOR = '0xeecdf927'; // anchor(bytes32)
/** NeuroAnchor.anchor(bytes32) call data. */
export const anchorData = (hash) => ANCHOR + hash.slice(2);
/** The archive with its anchor written in (what `zetaphy attest-pq anchor` writes), for saving. */
export const withAnchor = (a, { contract, hash, time }) => ({ ...a, anchor: { chainId: 77390, contract, hash, time: Number(time) } });
export const anchoredAtData = (hash) => ANCHORED_AT + hash.slice(2);
export function readAnchoredAt(hex) {
  const h = String(hex).replace(/^0x/, '');
  if (h.length < 192) throw new Error('not an anchoredAt answer');
  return { time: Number(BigInt(`0x${h.slice(0, 64)}`)), block: Number(BigInt(`0x${h.slice(64, 128)}`)), by: `0x${h.slice(152, 192)}` };
}
