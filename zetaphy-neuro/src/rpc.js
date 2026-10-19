// Minimal JSON-RPC client. Read-only methods only: this module has no way to
// sign or send a transaction, by design (Neuro tier 1 never moves funds).

const ALLOWED = new Set(['eth_chainId', 'eth_getCode', 'eth_getStorageAt', 'eth_call']);

export class RpcError extends Error {}

/**
 * Makes an RPC client over a list of URLs. `fetchImpl` is injectable for tests.
 * Checks eth_chainId once per URL so a misconfigured endpoint for another chain
 * is never trusted.
 */
export function createRpc(urls, expectedChainId, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const verified = new Set();
  let id = 0;

  async function post(url, method, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new RpcError(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new RpcError(body.error.message || 'rpc error');
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(method, params) {
    if (!ALLOWED.has(method)) throw new RpcError(`method not allowed: ${method}`);
    let lastErr;
    for (const url of urls) {
      try {
        if (!verified.has(url)) {
          const cid = parseInt(await post(url, 'eth_chainId', []), 16);
          if (cid !== expectedChainId) throw new RpcError(`wrong chain ${cid} at ${url}`);
          verified.add(url);
        }
        return await post(url, method, params);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new RpcError(`all RPC endpoints failed: ${lastErr?.message ?? 'unknown'}`);
  }

  return { call };
}
