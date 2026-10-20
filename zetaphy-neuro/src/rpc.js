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

// ------------------------------------------------------------ Move + TON
// These chains speak GraphQL or REST, not JSON-RPC. Each client still tries
// its URLs in order, checks once that a URL serves mainnet, and can only
// read: the Sui client refuses any operation that is not a query, the
// Aptos client only GETs and calls #[view] functions, the TON client only
// GETs.

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new RpcError(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function failover(urls, identify) {
  const verified = new Set();
  return async (fn) => {
    let lastErr;
    for (const url of urls) {
      try {
        if (!verified.has(url)) { await identify(url); verified.add(url); }
        return await fn(url);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new RpcError(`all RPC endpoints failed: ${lastErr?.message ?? 'unknown'}`);
  };
}

/** A GraphQL document is read-only if every operation in it is a query. */
export function isReadOnlyGraphql(doc) {
  const s = String(doc).replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/\b(mutation|subscription)\b/.test(s)) return false;
  return /^\s*(query\b|\{)/.test(s);
}

/** Sui GraphQL client; refuses endpoints whose chainIdentifier differs. */
export function createSuiGraphql(urls, chainIdentifier, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const post = async (url, query, variables) => {
    if (!isReadOnlyGraphql(query)) throw new RpcError('only queries are allowed');
    const body = await fetchJson(fetchImpl, url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
    }, timeoutMs);
    if (!body) throw new RpcError('HTTP 404');
    if (body.errors?.length) throw new RpcError(body.errors[0].message || 'graphql error');
    return body.data;
  };
  const run = failover(urls, async (url) => {
    const d = await post(url, 'query { chainIdentifier }', {});
    if (d?.chainIdentifier !== chainIdentifier) throw new RpcError(`wrong chain ${d?.chainIdentifier} at ${url}`);
  });
  return { query: (q, v = {}) => run((url) => post(url, q, v)) };
}

/** Aptos REST client; refuses endpoints whose chain_id differs. */
export function createAptosRest(urls, chainId, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const run = failover(urls, async (url) => {
    const info = await fetchJson(fetchImpl, url, { method: 'GET' }, timeoutMs);
    if (info?.chain_id !== chainId) throw new RpcError(`wrong chain ${info?.chain_id} at ${url}`);
  });
  return {
    get: (path) => run((url) => fetchJson(fetchImpl, url + path, { method: 'GET' }, timeoutMs)),
    view: (body) => run((url) => fetchJson(fetchImpl, `${url}/view`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, timeoutMs)),
  };
}

/** TON client (tonapi.io REST, GET only). Mainnet is chosen by the URL. */
export function createTonApi(urls, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const run = failover(urls, async () => {});
  // The free tier allows about one request per second: wait and retry once.
  const get1 = async (url, path) => {
    try {
      return await fetchJson(fetchImpl, url + path, { method: 'GET' }, timeoutMs);
    } catch (e) {
      if (!/HTTP 429/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1100));
      return fetchJson(fetchImpl, url + path, { method: 'GET' }, timeoutMs);
    }
  };
  return { get: (path) => run((url) => get1(url, path)) };
}
