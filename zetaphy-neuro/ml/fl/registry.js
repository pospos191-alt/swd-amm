// Neuro model versions bound to chain height (consensus-synchronized model).
//
// The on-chain ModelEpochs (zetaphy-network/contracts/ModelEpochs.sol)
// holds a list of versions, each {hash, activation height, uri}, with
// activation heights strictly increasing and every one a multiple of the
// registry's epoch length. The version in force at block height h is the LAST
// version whose activation <= h; before the first one, none (rules only).
//
// Because a version may only be scheduled (or cancelled) while its activation
// height is still in the future, the answer for height h is fixed once block
// h-1 is committed, so every node and browser that reads the registry state
// at any height >= h-1 selects the same version for h.
//
// `hash` is the sha256 of a manifest file's exact bytes; the manifest names
// the model and head files and their own sha256:
//   {"format":"neuro-model-manifest/1",
//    "model":{"id":"nml-…","sha256":"…","path":"ml/model.json"},
//    "head":{"id":"nfh-…","sha256":"…","path":"ml/fl/head.json"} | null}
// Plain JS, no dependencies (WebCrypto for sha256).

import { sha256Hex } from './head.js';

export const MANIFEST_FORMAT = 'neuro-model-manifest/1';
const HEX32 = /^(0x)?[0-9a-f]{64}$/i;
const norm = (h) => h.toLowerCase().replace(/^0x/, '');

/**
 * Throws unless versions is a valid schedule: hashes 32 bytes, activations
 * strictly increasing (and multiples of epoch when given).
 * @param {Array<{hash:string, activation:number|bigint}>} versions
 */
export function checkSchedule(versions, epoch = 1) {
  let prev = -1n;
  for (const [i, v] of versions.entries()) {
    if (!HEX32.test(v.hash) || /^(0x)?0{64}$/.test(v.hash)) throw new Error(`version ${i}: bad hash`);
    const a = BigInt(v.activation);
    if (a <= prev) throw new Error(`version ${i}: activation not increasing`);
    if (a % BigInt(epoch) !== 0n) throw new Error(`version ${i}: activation not on an epoch boundary`);
    prev = a;
  }
  return versions;
}

/**
 * The version in force at `height`: the last one with activation <= height.
 * Deterministic and O(log n). Returns {index, ...version} or null (no model yet).
 */
export function selectVersion(versions, height) {
  const h = BigInt(height);
  let lo = 0;
  let hi = versions.length; // first index with activation > h
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BigInt(versions[mid].activation) <= h) lo = mid + 1; else hi = mid;
  }
  return lo === 0 ? null : { index: lo - 1, ...versions[lo - 1] };
}

/** The first epoch boundary at or after `minHeight` (where a new version may start). */
export function nextActivation(minHeight, epoch) {
  const h = BigInt(minHeight);
  const e = BigInt(epoch);
  return ((h + e - 1n) / e) * e;
}

/** The exact manifest bytes for a model (+ head): canonical, key order fixed, newline at the end. */
export async function buildManifest({ model, modelBytes, modelPath = 'ml/model.json', head = null, headBytes = null, headPath = 'ml/fl/head.json' }) {
  const m = {
    format: MANIFEST_FORMAT,
    model: { id: model.id, sha256: await sha256Hex(modelBytes), path: modelPath },
    head: head ? { id: head.id, sha256: await sha256Hex(headBytes), path: headPath } : null,
  };
  const text = JSON.stringify(m, null, 1) + '\n';
  return { manifest: m, text, hash: await sha256Hex(text) };
}

/**
 * Loads and verifies the model in force at `height`.
 * @param {{versions:Array, height:number|bigint, fetchBytes:(pathOrUri:string)=>Promise<Uint8Array>}} o
 *   fetchBytes(uri) for the manifest, fetchBytes(path) for the files it names
 * @returns {Promise<null|{version:object, manifest:object, model:object, head:object|null}>}
 */
export async function loadForHeight({ versions, height, fetchBytes }) {
  const version = selectVersion(versions, height);
  if (!version) return null;
  const mBytes = await fetchBytes(version.uri);
  if ((await sha256Hex(mBytes)) !== norm(version.hash)) throw new Error('manifest does not match the registry hash');
  const manifest = JSON.parse(new TextDecoder().decode(mBytes));
  if (manifest.format !== MANIFEST_FORMAT) throw new Error('unsupported manifest');
  const get = async (entry) => {
    const b = await fetchBytes(entry.path);
    if ((await sha256Hex(b)) !== norm(entry.sha256)) throw new Error(`${entry.path} does not match its manifest hash`);
    return JSON.parse(new TextDecoder().decode(b));
  };
  const model = await get(manifest.model);
  if (model.id !== manifest.model.id) throw new Error('model id differs from the manifest');
  const head = manifest.head ? await get(manifest.head) : null;
  if (head && (head.id !== manifest.head.id || head.model !== model.id)) throw new Error('head does not fit the manifest');
  return { version, manifest, model, head };
}
