// Chunked, verified model distribution: the manifest format and its Merkle root.
// Plain ES module, no dependencies: runs in the browser (crypto.subtle) and in
// Node >= 20 (globalThis.crypto.subtle), so the builder, the loader, runners and
// tests all compute the same hashes.
//
// An artifact (model weights, a skill bundle, a prompt pack, a rule set) is cut
// into chunks of `chunkSize` bytes (default 4 MiB; the last one may be shorter).
// The manifest lists the sha256 of every chunk in order and the Merkle root over
// them:
//   leaf_i = sha256(0x00 || chunkHash_i)
//   node   = sha256(0x01 || left || right)
//   a level with an odd count carries its last node up unchanged (no duplication,
//   so two different chunk lists never share a root)
// The on-chain ModelRegistry (zetaphy-network/contracts/ModelRegistry.sol) holds
// sha256(manifest file bytes) and the root; the loader checks both, then every
// chunk, whichever mirror or peer served it.

export const MANIFEST_FORMAT = 'zetaphy-manifest/1';
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
export const MIN_CHUNK = 1024;            // same bounds as ModelRegistry
export const MAX_CHUNK = 64 * 1024 * 1024;
export const KINDS = ['none', 'model', 'skill', 'prompt', 'ruleset']; // ModelRegistry.Kind
export const STATUSES = ['none', 'active', 'suspended', 'deprecated', 'revoked']; // ModelRegistry.Status

const HEX64 = /^[0-9a-f]{64}$/;
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}
/** Lower-case 64-hex without 0x (accepts 0x-prefixed input). */
export const normHash = (h) => String(h ?? '').toLowerCase().replace(/^0x/, '');

/** sha256 of bytes -> Uint8Array(32). */
export async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}
export const sha256Hex = async (bytes) => toHex(await sha256(bytes));

const cat = (tag, ...parts) => {
  const out = new Uint8Array(1 + parts.reduce((s, p) => s + p.length, 0));
  out[0] = tag;
  let o = 1;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Merkle levels from chunk hashes (hex) up to the root: levels[0] = leaves. */
async function levels(chunkHashes) {
  if (!chunkHashes.length) throw new Error('no chunks');
  let level = await Promise.all(chunkHashes.map((h) => sha256(cat(0, fromHex(h)))));
  const all = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? await sha256(cat(1, level[i], level[i + 1])) : level[i]);
    all.push(next);
    level = next;
  }
  return all;
}

/** Merkle root (hex) over chunk hashes (hex, in order). */
export async function merkleRoot(chunkHashes) {
  const l = await levels(chunkHashes);
  return toHex(l[l.length - 1][0]);
}

/** Proof that chunk `index` is in the tree: sibling hashes bottom-up ({hash, left} per level that has one). */
export async function merkleProof(chunkHashes, index) {
  const l = await levels(chunkHashes);
  const proof = [];
  let i = index;
  for (let d = 0; d < l.length - 1; d++) {
    const sib = i ^ 1;
    if (sib < l[d].length) proof.push({ hash: toHex(l[d][sib]), left: sib < i });
    i >>= 1;
  }
  return proof;
}

/** Checks one chunk hash against the root with a proof (a peer can serve a chunk with its proof). */
export async function verifyProof(chunkHash, proof, root) {
  let h = await sha256(cat(0, fromHex(chunkHash)));
  for (const p of proof) h = p.left ? await sha256(cat(1, fromHex(p.hash), h)) : await sha256(cat(1, h, fromHex(p.hash)));
  return toHex(h) === normHash(root);
}

/** Chunk count for a size. */
export const chunkCount = (size, chunkSize) => Math.ceil(size / chunkSize);
/** Expected length of chunk i. */
export const chunkLength = (i, size, chunkSize) => Math.min(chunkSize, size - i * chunkSize);

/**
 * Builds a manifest for `bytes`. Returns {manifest, bytes: manifest file bytes,
 * manifestHash, chunks: [{hash, data}]}. The manifest file is the canonical
 * JSON below (2-space indent, trailing newline): its exact bytes are hashed.
 */
export async function buildManifest(bytes, { kind = 'model', name, version = 1, runtime, license, chunkSize = DEFAULT_CHUNK_SIZE, mirrors = [], meta = {} } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('nothing to package');
  if (!KINDS.includes(kind) || kind === 'none') throw new Error(`kind: one of ${KINDS.slice(1).join(', ')}`);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(name ?? ''))) throw new Error('name: a-z 0-9 . _ - (1-64)');
  if (!Number.isInteger(version) || version < 1 || version > 0xffffffff) throw new Error('version: a whole number >= 1');
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) throw new Error(`chunkSize: ${MIN_CHUNK}..${MAX_CHUNK}`);
  if (!/^[\x21-\x7e]{1,64}$/.test(String(license ?? ''))) throw new Error('license: an SPDX id');
  if (!/^[A-Za-z0-9._/-]{1,64}$/.test(String(runtime ?? ''))) throw new Error('runtime: which engine loads it, e.g. neuro-ml-gbdt/1');
  const chunks = [];
  for (let o = 0; o < bytes.length; o += chunkSize) {
    const data = bytes.subarray(o, Math.min(o + chunkSize, bytes.length));
    chunks.push({ hash: await sha256Hex(data), data });
  }
  const manifest = {
    format: MANIFEST_FORMAT, kind, name, version, runtime, license,
    size: bytes.length, chunkSize, sha256: await sha256Hex(bytes),
    root: await merkleRoot(chunks.map((c) => c.hash)),
    chunks: chunks.map((c) => c.hash),
    mirrors: checkMirrors(mirrors),
    meta,
  };
  const file = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, bytes: file, manifestHash: await sha256Hex(file), chunks };
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
/** https anywhere, http only on this machine, relative URLs (this site) allowed; no user:password. */
export function checkUrl(u) {
  const s = String(u ?? '');
  if (/^\/(?!\/)|^\.\.?\//.test(s)) return s; // same-site path
  let url;
  try { url = new URL(s); } catch { throw new Error(`not a URL: ${s.slice(0, 80)}`); }
  if (url.username || url.password) throw new Error('no user:password in mirror URLs');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.has(url.hostname))) throw new Error('mirrors must be https (or http on localhost)');
  return s;
}

/**
 * Mirrors: where the manifest and the chunks are served. `chunk` is a URL
 * template with {hash} (the chunk's sha256 hex), so one shape covers this
 * site (/web/models/<name>/<v>/{hash}.bin), GitHub Releases
 * (…/releases/download/<tag>/{hash}.bin) and IPFS gateways (…/ipfs/<cid>/{hash}.bin).
 * Mirrors are hints: nothing they serve is trusted before it is hashed.
 */
export function checkMirrors(list) {
  if (!Array.isArray(list)) throw new Error('mirrors: a list');
  return list.slice(0, 16).map((m) => {
    const manifest = m.manifest == null ? undefined : checkUrl(m.manifest);
    if (typeof m.chunk !== 'string' || !m.chunk.includes('{hash}')) throw new Error('mirror chunk URL needs {hash}');
    checkUrl(m.chunk.replace('{hash}', '0'.repeat(64)));
    return { ...(m.label ? { label: String(m.label).slice(0, 40) } : {}), ...(manifest ? { manifest } : {}), chunk: m.chunk };
  });
}

/**
 * Parses and checks a manifest file against what the registry says.
 * `expect` = {manifestHash, chunkRoot, size?, chunkSize?} (hex, 0x optional).
 * Throws on any mismatch; returns the parsed manifest.
 */
export async function checkManifest(fileBytes, expect) {
  const got = await sha256Hex(fileBytes);
  if (got !== normHash(expect.manifestHash)) throw new Error(`manifest sha256 ${got.slice(0, 12)}… is not the registry's ${normHash(expect.manifestHash).slice(0, 12)}…`);
  let m;
  try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fileBytes)); } catch { throw new Error('manifest is not JSON'); }
  if (m?.format !== MANIFEST_FORMAT) throw new Error('unknown manifest format');
  if (!Number.isSafeInteger(m.size) || m.size < 1 || !Number.isInteger(m.chunkSize) || m.chunkSize < MIN_CHUNK || m.chunkSize > MAX_CHUNK) throw new Error('manifest size/chunkSize');
  if (!Array.isArray(m.chunks) || m.chunks.length !== chunkCount(m.size, m.chunkSize) || !m.chunks.every((h) => HEX64.test(h))) throw new Error('manifest chunk list');
  if (!HEX64.test(m.sha256) || !HEX64.test(m.root)) throw new Error('manifest hashes');
  const root = await merkleRoot(m.chunks);
  if (root !== m.root || root !== normHash(expect.chunkRoot)) throw new Error('chunk list does not match the registry\'s Merkle root');
  if (expect.size != null && BigInt(expect.size) !== BigInt(m.size)) throw new Error('size differs from the registry');
  if (expect.chunkSize != null && Number(expect.chunkSize) !== m.chunkSize) throw new Error('chunk size differs from the registry');
  return m;
}
