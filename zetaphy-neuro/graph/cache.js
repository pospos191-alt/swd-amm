// A small key-value cache for answers that never change (old logs, mined
// transactions) and for Neuro's own past results. In a browser it uses
// IndexedDB, else localStorage, else memory; every storage call is wrapped in
// try/catch (private windows, blocked site data and previews throw or come
// back empty, and the graph must work the same without a cache). In Node it
// keeps answers in memory for the life of the process.

const DB = 'neuro-graph';
const STORE = 'kv';
const LS_PREFIX = 'neuro-graph:';
const LS_MAX_VALUE = 64 * 1024; // localStorage is small: skip big answers

function memoryBackend(max = 5000) {
  const m = new Map();
  return {
    kind: 'memory',
    async get(k) { return m.get(k); },
    async set(k, v) { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, v); },
    async del(k) { m.delete(k); },
    async keys(prefix = '') { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

function idbBackend() {
  let dbp = null;
  const open = () => {
    dbp ??= new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  };
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    kind: 'indexeddb',
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
    keys: async (prefix = '') => (await tx('readonly', (s) => s.getAllKeys()) ?? []).map(String).filter((k) => k.startsWith(prefix)),
  };
}

function localStorageBackend() {
  const ls = globalThis.localStorage;
  return {
    kind: 'localstorage',
    async get(k) { const s = ls.getItem(LS_PREFIX + k); return s == null ? undefined : JSON.parse(s); },
    async set(k, v) {
      const s = JSON.stringify(v);
      if (s.length > LS_MAX_VALUE) return;
      try { ls.setItem(LS_PREFIX + k, s); } catch { /* quota: drop our oldest entries, once */
        for (let i = ls.length - 1; i >= 0; i--) { const key = ls.key(i); if (key?.startsWith(LS_PREFIX)) ls.removeItem(key); }
        ls.setItem(LS_PREFIX + k, s);
      }
    },
    async del(k) { ls.removeItem(LS_PREFIX + k); },
    async keys(prefix = '') {
      const out = [];
      for (let i = 0; i < ls.length; i++) { const key = ls.key(i); if (key?.startsWith(LS_PREFIX + prefix)) out.push(key.slice(LS_PREFIX.length)); }
      return out;
    },
  };
}

function pickBackend() {
  try { if (globalThis.indexedDB && typeof globalThis.indexedDB.open === 'function') return idbBackend(); } catch { /* blocked */ }
  try { if (globalThis.localStorage) { globalThis.localStorage.getItem('x'); return localStorageBackend(); } } catch { /* blocked */ }
  return memoryBackend();
}

/**
 * createCache({ backend?, now? }) -> { get(key), set(key, value, ttlMs?), del, keys(prefix) }.
 * Values must be JSON-serialisable. get() resolves undefined for a miss, an
 * expired entry or any storage error; set() never throws.
 */
export function createCache({ backend, now = () => Date.now() } = {}) {
  let be = backend ?? pickBackend();
  const fallback = memoryBackend();
  const safe = async (fn) => {
    try { return await fn(be); } catch {
      be = fallback; // storage broke mid-session: carry on in memory
      try { return await fn(be); } catch { return undefined; }
    }
  };
  return {
    get kind() { return be.kind; },
    async get(key) {
      const e = await safe((b) => b.get(key));
      if (!e || typeof e !== 'object' || !('v' in e)) return undefined;
      if (e.exp && e.exp < now()) { safe((b) => b.del(key)); return undefined; }
      return e.v;
    },
    async set(key, value, ttlMs = 0) { await safe((b) => b.set(key, { v: value, exp: ttlMs ? now() + ttlMs : 0 })); },
    async del(key) { await safe((b) => b.del(key)); },
    async keys(prefix = '') { return (await safe((b) => b.keys(prefix))) ?? []; },
  };
}

export const memoryCache = () => createCache({ backend: memoryBackend() });
