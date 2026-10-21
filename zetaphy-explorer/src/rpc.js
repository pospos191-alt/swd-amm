// The node clients: EVM JSON-RPC, CometBFT JSON-RPC and Cosmos REST, all
// behind one polite queue so the explorer never hammers a public node:
//   - at most `maxConcurrent` requests in flight and `maxRps` started per second
//   - answers cached in memory (LRU) with a time to live chosen per call:
//     finished blocks and txs never change (long TTL), "latest" things expire fast
//   - the same request in flight twice is sent once
// No cookies or credentials are ever sent (credentials: 'omit').

export class Limiter {
  constructor({ maxConcurrent = 4, maxRps = 8, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.interval = 1000 / Math.max(0.1, maxRps);
    this.active = 0;
    this.queue = [];
    this.nextStart = 0;
    this.now = now; this.sleep = sleep;
  }

  run(fn) {
    return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this.pump(); });
  }

  async pump() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      (async () => {
        const wait = this.nextStart - this.now();
        this.nextStart = Math.max(this.now(), this.nextStart) + this.interval;
        if (wait > 0) await this.sleep(wait);
        try { job.resolve(await job.fn()); } catch (e) { job.reject(e); } finally { this.active--; this.pump(); }
      })();
    }
  }
}

export class LruCache {
  constructor(max = 800, now = () => Date.now()) { this.max = max; this.map = new Map(); this.now = now; }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp <= this.now()) { this.map.delete(k); return undefined; }
    this.map.delete(k); this.map.set(k, e); // most recently used last
    return e.v;
  }
  set(k, v, ttl) {
    if (!(ttl > 0)) return;
    this.map.delete(k);
    this.map.set(k, { v, exp: this.now() + ttl });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
}

export const TTL = { latest: 4000, short: 15000, minute: 60000, forever: 6 * 3600 * 1000 };

export class RpcError extends Error {
  constructor(message, { code, kind } = {}) { super(message); this.code = code; this.kind = kind; }
}

const clip = (s, n = 300) => String(s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, n);

/**
 * endpoints: { evm, comet, rest } base URLs (comet and rest end with '/').
 * Returns { evm(method, params, ttl), comet(method, params, ttl), rest(path, ttl), stats, clear }.
 */
export function createApi(endpoints, { maxConcurrent = 4, maxRps = 8, timeoutMs = 15000, fetchFn = (...a) => fetch(...a) } = {}) {
  const limiter = new Limiter({ maxConcurrent, maxRps });
  const cache = new LruCache();
  const inflight = new Map();
  const stats = { requests: 0, cached: 0, errors: 0 };
  let id = 0;

  async function request(url, init, kind) {
    stats.requests++;
    let res;
    try {
      res = await fetchFn(url, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      stats.errors++;
      throw new RpcError(`cannot reach ${kind} ${url}: ${clip(e?.message ?? e)}`, { kind: 'network' });
    }
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { res, body };
  }

  function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit !== undefined) { stats.cached++; return Promise.resolve(hit); }
    if (inflight.has(key)) return inflight.get(key);
    const p = limiter.run(fn).then((v) => { cache.set(key, v, typeof ttl === 'function' ? ttl(v) : ttl); return v; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const jsonRpc = (url, kind) => (method, params = [], ttl = TTL.latest) => cached(`${kind}|${url}|${method}|${JSON.stringify(params)}`, ttl, async () => {
    const { res, body } = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }, kind);
    if (body?.error) throw new RpcError(`${method}: ${clip(body.error.data || body.error.message)}`, { code: body.error.code, kind: 'rpc' });
    if (!res.ok || !body || !('result' in body)) { stats.errors++; throw new RpcError(`${method}: ${kind} answered HTTP ${res.status}`, { code: res.status, kind: 'http' }); }
    return body.result;
  });

  const rest = (path, ttl = TTL.latest) => {
    const url = endpoints.rest + String(path).replace(/^\//, '');
    return cached(`rest|${url}`, ttl, async () => {
      const { res, body } = await request(url, { method: 'GET' }, 'REST');
      if (!res.ok || !body) {
        throw new RpcError(`REST ${path}: ${clip(body?.message ?? `HTTP ${res.status}`)}`, { code: body?.code ?? res.status, kind: res.status === 404 ? 'notfound' : 'http' });
      }
      return body;
    });
  };

  return { evm: jsonRpc(endpoints.evm, 'EVM RPC'), comet: jsonRpc(endpoints.comet, 'CometBFT RPC'), rest, stats, endpoints, clear: () => cache.clear() };
}
