// The verified loader: fetches a registered artifact (model, skill, prompt pack,
// rule set) chunk by chunk from any mix of mirrors and peers, and accepts a byte
// only after hashing it against what the on-chain ModelRegistry says.
//
//   1. release: {manifestHash, chunkRoot, size, chunkSize, status} read from
//      ModelRegistry (ai/browser/registry.js). Anything but status "active" is refused.
//   2. manifest: from the cache, a peer or a mirror; sha256(file) must equal
//      manifestHash and the Merkle root of its chunk list must equal chunkRoot.
//   3. each chunk: from the cache, then peers (other browsers over WebRTC,
//      ai/browser/p2p.js), then mirrors (rotating the start so the load spreads);
//      the first answer whose length and sha256 match is kept, every other answer
//      is counted as rejected and the next source is tried.
//   4. the whole: sha256 must equal the manifest's sha256 (a second check).
// A mirror or a peer can therefore only be slow or refuse; it cannot change a byte.

import { checkManifest, sha256Hex, normHash, chunkLength, checkUrl } from './manifest.js';
import { memoryStore } from './stores.js';

export class LoadError extends Error {}

const MAX_MANIFEST = 2 * 1024 * 1024;

function resolve(url, base) {
  checkUrl(url);
  try { return new URL(url, base ?? globalThis.location?.href).toString(); } catch { return url; }
}

async function fetchBytes(fetchImpl, url, { maxBytes, timeoutMs, signal }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener?.('abort', onAbort);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(len) && len > maxBytes) throw new Error('too large');
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > maxBytes) throw new Error('too large');
    return b;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * @param {object} o
 * @param {{manifestHash:string, chunkRoot:string, size?:bigint|number, chunkSize?:number, status?:string}} o.release  from the registry
 * @param {Array<{manifest?:string, chunk:string, label?:string}>} [o.mirrors]  URL templates ({hash})
 * @param {Array<{id:string, getManifest?:Function, getChunk:Function}>} [o.peers]  P2P sources (ai/browser/p2p.js)
 * @param {object} [o.store]  chunk cache (ai/browser/stores.js); memory by default
 * @param {Function} [o.onProgress]  ({done, total, from}) after each chunk
 * @param {Function} [o.only]  (manifest) => chunk indexes to load (a pipeline stage needs only its layers' chunks).
 *   The other bytes stay zero; each loaded chunk is still checked against the manifest, which is checked against
 *   the registry, but the whole-file sha256 cannot be (stats.partial = true).
 * @param {number} [o.peerStrikes]  a peer that fails this many chunks is not asked again during this load
 * @returns {Promise<{bytes:Uint8Array, manifest:object, stats:object}>}
 */
export async function loadVerified({ release, mirrors = [], peers = [], store = memoryStore(), fetchImpl = globalThis.fetch, onProgress, signal, timeoutMs = 60_000, base, only = null, peerStrikes = 3 } = {}) {
  if (!release) throw new LoadError('no registry release');
  if (release.status && release.status !== 'active') throw new LoadError(`the registry marks this release "${release.status}": not loaded`);
  const mh = normHash(release.manifestHash);
  const stats = { cache: 0, peer: 0, mirror: 0, rejected: [], manifestFrom: null };
  const reject = (from, what, why) => stats.rejected.push({ from, what: String(what).slice(0, 80), why: String(why).slice(0, 120) });

  // --- manifest ---
  let manifest = null;
  let manifestUrl = null;
  const tryManifest = async (from, get, url = null) => {
    try {
      const b = await get();
      if (!b) return false;
      manifest = await checkManifest(b, release);
      await store.put(`m-${mh}`, b).catch(() => {});
      stats.manifestFrom = from;
      manifestUrl = url;
      return true;
    } catch (e) { reject(from, 'manifest', e.message); return false; }
  };
  let done = await tryManifest('cache', () => store.get(`m-${mh}`));
  for (const p of peers) if (!done && p.getManifest) done = await tryManifest(`peer:${p.id}`, () => p.getManifest(mh));
  for (const m of mirrors) {
    if (done || !m.manifest) continue;
    const url = resolve(m.manifest, base);
    done = await tryManifest(`mirror:${m.label ?? m.manifest}`, () => fetchBytes(fetchImpl, url, { maxBytes: MAX_MANIFEST, timeoutMs, signal }), url);
  }
  if (!done) throw new LoadError('no source served a manifest matching the registry');

  // --- chunks ---
  const sources = [
    ...peers.map((p) => ({ from: `peer:${p.id}`, kind: 'peer', get: (h) => p.getChunk(h) })),
    // the manifest's own mirrors come after the caller's (same verification either way);
    // their relative URLs are relative to where the manifest came from
    ...[...mirrors.map((m) => [m, base]), ...(manifest.mirrors ?? []).map((m) => [m, manifestUrl ?? base])].map(([m, b]) => ({ from: `mirror:${m.label ?? m.chunk}`, kind: 'mirror', get: (h, max) => fetchBytes(fetchImpl, resolve(m.chunk.replaceAll('{hash}', h), b), { maxBytes: max, timeoutMs, signal }) })),
  ];
  const out = new Uint8Array(manifest.size);
  const total = manifest.chunks.length;
  let want = null;
  if (only) {
    want = new Set([...only(manifest)].filter((i) => Number.isInteger(i) && i >= 0 && i < total));
    stats.partial = want.size < total;
  }
  const strikes = new Map(); // peer -> wrong answers / errors (a missing chunk is not a strike)
  let loaded = 0;
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new LoadError('stopped');
    if (want && !want.has(i)) continue;
    const h = manifest.chunks[i];
    const len = chunkLength(i, manifest.size, manifest.chunkSize);
    const ok = async (b) => b && b.length === len && (await sha256Hex(b)) === h;
    let bytes = await store.get(h).catch(() => null);
    let from = 'cache';
    if (bytes && !(await ok(bytes))) { reject('cache', h, 'cached bytes do not match'); await store.delete(h).catch(() => {}); bytes = null; }
    if (!bytes) {
      const peerSources = sources.filter((s) => s.kind === 'peer' && (strikes.get(s.from) ?? 0) < peerStrikes);
      const mirrorSources = sources.filter((s) => s.kind === 'mirror');
      const rotated = mirrorSources.length ? [...mirrorSources.slice(i % mirrorSources.length), ...mirrorSources.slice(0, i % mirrorSources.length)] : [];
      for (const s of [...peerSources, ...rotated]) {
        const strike = () => { if (s.kind === 'peer') strikes.set(s.from, (strikes.get(s.from) ?? 0) + 1); };
        try {
          const b = await s.get(h, len);
          if (await ok(b)) { bytes = b; from = s.from; stats[s.kind]++; break; }
          reject(s.from, h, b ? 'wrong bytes' : 'not available');
          if (b) strike();
        } catch (e) { reject(s.from, h, e.message); strike(); }
      }
      if (!bytes) throw new LoadError(`chunk ${i + 1}/${total} (${h.slice(0, 12)}…): no source served the right bytes`);
      await store.put(h, bytes).catch(() => {});
    } else stats.cache++;
    out.set(bytes, i * manifest.chunkSize);
    onProgress?.({ done: ++loaded, total: want ? want.size : total, from });
  }
  stats.chunks = loaded;
  if (!stats.partial && (await sha256Hex(out)) !== manifest.sha256) throw new LoadError('assembled artifact does not match the manifest sha256');
  return { bytes: out, manifest, stats };
}
