// Where verified chunks are kept between visits, keyed by their sha256 (hex).
// Every store has the same shape: get(hash) -> Uint8Array|null, put(hash, bytes),
// has(hash), keys(), delete(hash). The loader re-hashes whatever a store returns
// before using it, so a corrupted or tampered cache only costs a re-download.
//
//   memoryStore()          tests, Node, a page that should not persist anything
//   cacheStore(name)       Cache API (the default in browsers): responses under
//                          a synthetic same-origin URL /__zetaphy-chunks/<hash>
//   idbStore(name)         IndexedDB, for browsers or contexts without Cache API
//   bestStore()            Cache API if present, else IndexedDB, else memory

export function memoryStore() {
  const m = new Map();
  return {
    kind: 'memory',
    async get(h) { return m.get(h) ?? null; },
    async put(h, b) { m.set(h, new Uint8Array(b)); },
    async has(h) { return m.has(h); },
    async keys() { return [...m.keys()]; },
    async delete(h) { m.delete(h); },
  };
}

const PREFIX = '/__zetaphy-chunks/';
export function cacheStore(name = 'zetaphy-models-v1') {
  const open = () => globalThis.caches.open(name);
  const url = (h) => new URL(PREFIX + h, globalThis.location?.origin ?? 'https://localhost').toString();
  return {
    kind: 'cache',
    async get(h) {
      const r = await (await open()).match(url(h));
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    },
    async put(h, b) {
      await (await open()).put(url(h), new Response(b, { headers: { 'content-type': 'application/octet-stream' } }));
    },
    async has(h) { return !!(await (await open()).match(url(h))); },
    async keys() { return (await (await open()).keys()).map((r) => new URL(r.url).pathname.slice(PREFIX.length)); },
    async delete(h) { await (await open()).delete(url(h)); },
  };
}

export function idbStore(name = 'zetaphy-models-v1') {
  let dbp = null;
  const db = () => (dbp ??= new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('chunks');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('chunks', mode);
      const r = fn(t.objectStore('chunks'));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    kind: 'indexeddb',
    async get(h) { const v = await tx('readonly', (s) => s.get(h)); return v ? new Uint8Array(v) : null; },
    async put(h, b) { await tx('readwrite', (s) => s.put(new Uint8Array(b), h)); },
    async has(h) { return (await tx('readonly', (s) => s.count(h))) > 0; },
    async keys() { return (await tx('readonly', (s) => s.getAllKeys())) ?? []; },
    async delete(h) { await tx('readwrite', (s) => s.delete(h)); },
  };
}

export function bestStore(name) {
  try { if (globalThis.caches?.open) return cacheStore(name); } catch { /* blocked */ }
  try { if (globalThis.indexedDB?.open) return idbStore(name); } catch { /* blocked */ }
  return memoryStore();
}
