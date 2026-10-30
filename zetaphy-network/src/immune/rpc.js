// JSON-RPC for the sentinels: free public endpoints only, so every client is rate-limited (token bucket), times out,
// retries with backoff and rotates endpoints. The same `send(method, params)` shape is served by a recorded fixture
// (fixtureRpc) and by the mock multi-chain (mockchain.js), so detectors and sentinels run identically offline.

/** A token bucket: `rps` requests per second on average, at most `burst` at once. `now`/`sleep` injectable for tests. */
export function rateLimiter({ rps = 4, burst = 8, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let tokens = burst;
  let last = now();
  let waited = 0;
  return {
    async take() {
      for (;;) {
        const t = now();
        tokens = Math.min(burst, tokens + ((t - last) / 1000) * rps);
        last = t;
        if (tokens >= 1) { tokens -= 1; return; }
        const ms = Math.ceil(((1 - tokens) / rps) * 1000);
        waited += ms;
        await sleep(ms);
      }
    },
    get waitedMs() { return waited; },
  };
}

export class RpcError extends Error {
  constructor(message, { code = null, url = '' } = {}) { super(message); this.code = code; this.url = url; }
}

/**
 * A rate-limited JSON-RPC client over several free endpoints.
 * send(method, params) -> result; batch([{method, params}]) -> [result | Error] (falls back to one by one).
 */
export function createRpc({ urls, rps = 4, burst = 8, timeoutMs = 10_000, retries = 3, fetchImpl = globalThis.fetch, limiter = null, sleep = null } = {}) {
  if (!urls?.length) throw new Error('no RPC endpoint');
  const lim = limiter ?? rateLimiter({ rps, burst });
  const pause = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let at = 0;
  let id = 0;
  const stats = { requests: 0, errors: 0, rotations: 0 };

  async function post(body) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await lim.take();
      const url = urls[at % urls.length];
      stats.requests++;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl?.signal });
        if (r.status === 429 || r.status >= 500) throw new RpcError(`HTTP ${r.status}`, { code: r.status, url });
        if (!r.ok) throw new RpcError(`HTTP ${r.status}`, { code: r.status, url });
        return await r.json();
      } catch (e) {
        lastErr = e;
        stats.errors++;
        at++; stats.rotations++; // next endpoint
        await pause(Math.min(8000, 250 * 2 ** attempt));
      } finally { if (timer) clearTimeout(timer); }
    }
    throw lastErr ?? new RpcError('RPC failed');
  }

  async function send(method, params = []) {
    const j = await post({ jsonrpc: '2.0', id: ++id, method, params });
    if (j?.error) throw new RpcError(String(j.error.message ?? 'RPC error').slice(0, 200), { code: j.error.code });
    return j?.result;
  }

  async function batch(calls) {
    if (!calls.length) return [];
    try {
      const base = id;
      const j = await post(calls.map((c, i) => ({ jsonrpc: '2.0', id: base + i + 1, method: c.method, params: c.params ?? [] })));
      id += calls.length;
      if (!Array.isArray(j)) throw new Error('no batch');
      const by = new Map(j.map((x) => [x.id, x]));
      return calls.map((_, i) => { const x = by.get(base + i + 1); return x?.error ? new RpcError(String(x.error.message)) : x?.result ?? new RpcError('missing'); });
    } catch {
      return Promise.all(calls.map((c) => send(c.method, c.params).catch((e) => e)));
    }
  }

  return { send, batch, stats, limiter: lim };
}

const keyOf = (method, params) => `${method} ${JSON.stringify(params ?? [])}`;

/**
 * Serves a recorded fixture: { calls: { "<method> <params json>": result } }. Unknown calls throw (so a test notices
 * a detector asking for something that was never recorded). `misses` lists them.
 */
export function fixtureRpc(fixture) {
  const calls = fixture?.calls ?? {};
  const misses = [];
  const send = async (method, params = []) => {
    const k = keyOf(method, params);
    if (!(k in calls)) { misses.push(k); throw new RpcError(`not recorded: ${k.slice(0, 120)}`); }
    return calls[k];
  };
  return { send, batch: (cs) => Promise.all(cs.map((c) => send(c.method, c.params).catch((e) => e))), misses, stats: { requests: 0, errors: 0, rotations: 0 } };
}

/** Wraps a live client and records every answer into a fixture (scripts/immune-record.js writes it to disk). */
export function recordingRpc(inner) {
  const fixture = { recordedAt: new Date().toISOString(), calls: {} };
  const send = async (method, params = []) => {
    const r = await inner.send(method, params);
    fixture.calls[keyOf(method, params)] = r;
    return r;
  };
  return { send, batch: (cs) => Promise.all(cs.map((c) => send(c.method, c.params).catch((e) => e))), fixture, stats: inner.stats };
}
