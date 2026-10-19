// Minimal JSON-RPC clients. Read-only methods only: this module has no way to
// sign or send a transaction, by design (Neuro tier 1 never moves funds).

const EVM_ALLOWED = new Set(['eth_chainId', 'eth_getCode', 'eth_getStorageAt', 'eth_call']);
const SOLANA_ALLOWED = new Set(['getGenesisHash', 'getAccountInfo']);

export class RpcError extends Error {}

/**
 * Shared client: tries each URL in order, and before trusting a URL checks
 * once (via `identify`) that it really serves the expected chain.
 */
function makeClient(urls, { allowed, identify, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
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
    if (!allowed.has(method)) throw new RpcError(`method not allowed: ${method}`);
    let lastErr;
    for (const url of urls) {
      try {
        if (!verified.has(url)) {
          await identify((m, p) => post(url, m, p), url);
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

/** EVM client; refuses endpoints whose eth_chainId differs from `expectedChainId`. */
export function createRpc(urls, expectedChainId, opts = {}) {
  return makeClient(urls, {
    ...opts,
    allowed: EVM_ALLOWED,
    identify: async (post, url) => {
      const cid = parseInt(await post('eth_chainId', []), 16);
      if (cid !== expectedChainId) throw new RpcError(`wrong chain ${cid} at ${url}`);
    },
  });
}

/** Solana client; refuses endpoints whose genesis hash is not `genesisHash`. */
export function createSolanaRpc(urls, genesisHash, opts = {}) {
  return makeClient(urls, {
    ...opts,
    allowed: SOLANA_ALLOWED,
    identify: async (post, url) => {
      const g = await post('getGenesisHash', []);
      if (g !== genesisHash) throw new RpcError(`wrong cluster ${g} at ${url}`);
    },
  });
}
