// Minimal JSON-RPC client: tries each endpoint in turn and refuses one that
// answers for a different chain (a wrong or hijacked URL).

export function createRpc(urls, chainId, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  let checked = null;
  const bad = new Set();
  let id = 0;

  async function post(url, method, params) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
    return body.result;
  }

  async function pick() {
    if (checked) return checked;
    const errors = [];
    for (const url of urls) {
      if (bad.has(url)) continue;
      try {
        const got = Number(BigInt(await post(url, 'eth_chainId', [])));
        if (got !== chainId) { errors.push(`${url}: chain ${got}, expected ${chainId}`); continue; }
        checked = url;
        return url;
      } catch (e) {
        errors.push(`${url}: ${e.message}`);
      }
    }
    bad.clear(); // all failed: give every endpoint another chance next time
    throw new Error(`no working RPC for chain ${chainId} (${errors.join('; ')})`);
  }

  return {
    async call(method, params) {
      const url = await pick();
      try {
        return await post(url, method, params);
      } catch (e) {
        // Range limits on eth_getLogs are not an endpoint failure: let the
        // caller shrink the range instead of hopping endpoints.
        if (method === 'eth_getLogs') throw e;
        bad.add(url);
        checked = null;
        return post(await pick(), method, params);
      }
    },
  };
}
