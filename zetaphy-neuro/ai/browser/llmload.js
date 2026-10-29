// Loads a zllm/1 language model (ai/browser/llama.js) through the verified loader,
// fetching only the chunks a role needs: the coordinator (head + its layers) or a
// stage (its layers only). Every chunk is still checked against the manifest,
// and the manifest against the registry release.

import { loadVerified } from './loader.js';
import { readHeader, neededRanges, openModel } from './llama.js';
import { memoryStore } from './stores.js';

/** Chunk indexes covering byte ranges [[start, end), …]. */
export function chunksFor(ranges, chunkSize, size) {
  const out = new Set();
  for (const [a, b] of ranges) {
    if (b <= a) continue;
    for (let i = Math.floor(a / chunkSize); i <= Math.floor((Math.min(b, size) - 1) / chunkSize); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * @param {object} o  loadVerified options (release, mirrors, peers, store, fetchImpl, base, onProgress, signal)
 * @param {number} [o.from] @param {number} [o.to] layers to load; @param {boolean} [o.head] embedding / output layer / tokenizer
 * @returns {Promise<{model, manifest, stats, chunks:number, total:number}>}
 */
export async function loadLlm({ from = 0, to = null, head = true, store = memoryStore(), ...rest }) {
  // the header first (chunk 0, more if the header is longer)
  let want = [0];
  let first, hdr;
  for (;;) {
    first = await loadVerified({ ...rest, store, only: () => want, onProgress: undefined });
    try { hdr = readHeader(first.bytes.subarray(0, (Math.max(...want) + 1) * first.manifest.chunkSize)); break; } catch (e) {
      if (!e.need) throw e;
      const n = Math.ceil(e.need / first.manifest.chunkSize);
      if (n > first.manifest.chunks.length || n <= want.length) throw e;
      want = Array.from({ length: n }, (_, i) => i);
    }
  }
  const L = hdr.header.config.nLayers;
  to ??= L;
  const idx = chunksFor(neededRanges(hdr, { from, to, head }), first.manifest.chunkSize, first.manifest.size);
  const r = await loadVerified({ ...rest, store, only: () => idx });
  return { model: openModel(r.bytes, { from, to, head }), manifest: r.manifest, stats: r.stats, chunks: idx.length, total: r.manifest.chunks.length };
}
