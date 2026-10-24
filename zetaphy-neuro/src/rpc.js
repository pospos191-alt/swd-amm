// Minimal JSON-RPC clients. Read-only methods only: this module has no way to
// sign or send a transaction, by design (Neuro tier 1 never moves funds).

// eth_call may carry a state override (third parameter, used by the trade
// simulation in honeypot.js). It is still a call: the node runs it on a
// scratch copy of the state and throws the copy away; nothing is signed or sent.
// eth_gasPrice only reads the node's fee estimate (the simulation's gas price).
// eth_getTransactionByHash / eth_getTransactionReceipt only read a past transaction (the tx check).
const EVM_ALLOWED = new Set(['eth_chainId', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_gasPrice', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
const SOLANA_ALLOWED = new Set(['getGenesisHash', 'getAccountInfo']);
const NEAR_ALLOWED = new Set(['status', 'query']); // `query` only reads (view_* and view-function calls)
const STARKNET_ALLOWED = new Set(['starknet_chainId', 'starknet_getClassAt', 'starknet_getClass', 'starknet_call']);

export class RpcError extends Error {}

/**
 * Shared client: tries each URL in order, and before trusting a URL checks
 * once (via `identify`) that it really serves the expected chain.
 */
function makeClient(urls, { allowed, identify, fetchImpl = globalThis.fetch, timeoutMs = 15000, retryMs = 1500 }) {
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
    // Free endpoints rate-limit (HTTP 429): if that is why they all failed,
    // wait a moment and try the list once more.
    for (let round = 0; round < 2; round++) {
      let limited = false;
      for (const url of urls) {
        try {
          if (!verified.has(url)) {
            await identify((m, p) => post(url, m, p), url);
            verified.add(url);
          }
          return await post(url, method, params);
        } catch (e) {
          lastErr = e;
          if (/HTTP 429/.test(e.message)) limited = true;
        }
      }
      if (!limited) break;
      if (round === 0) await new Promise((r) => setTimeout(r, retryMs));
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

/** NEAR client; refuses endpoints whose chain_id is not `chainId`. */
export function createNearRpc(urls, chainId, opts = {}) {
  return makeClient(urls, {
    ...opts,
    allowed: NEAR_ALLOWED,
    identify: async (post, url) => {
      const st = await post('status', []);
      if (st?.chain_id !== chainId) throw new RpcError(`wrong chain ${st?.chain_id} at ${url}`);
    },
  });
}

/** Starknet client; refuses endpoints whose chain id differs (SN_MAIN). */
export function createStarknetRpc(urls, chainId, opts = {}) {
  return makeClient(urls, {
    ...opts,
    allowed: STARKNET_ALLOWED,
    identify: async (post, url) => {
      const id = await post('starknet_chainId', []);
      if (String(id).toLowerCase() !== chainId) throw new RpcError(`wrong chain ${id} at ${url}`);
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
export function createTonApi(urls, { fetchImpl = globalThis.fetch, timeoutMs = 15000, spacingMs = 1050 } = {}) {
  const run = failover(urls, async () => {});
  // Requests go out one at a time, at most about one per second.
  let queue = Promise.resolve();
  let last = 0;
  const paced = (fn) => {
    const p = queue.then(async () => {
      const wait = last + spacingMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    queue = p.catch(() => {});
    return p;
  };
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
  return { get: (path) => paced(() => run((url) => get1(url, path))) };
}

/**
 * Reads rune pages from an `ord` server (ordinals.com: free, no key; its JSON
 * API is switched off). GET only, /rune/ paths only.
 */
export function createOrdApi(urls, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const run = failover(urls, async () => {});
  const get1 = async (url, path) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url + path, { method: 'GET', signal: ctrl.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new RpcError(`HTTP ${res.status}`);
      return (await res.text()).slice(0, 200_000);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    getText(path) {
      if (!/^\/rune\/[^/?#]+$/.test(path)) throw new RpcError(`path not allowed: ${path}`);
      return run((url) => get1(url, path));
    },
  };
}

/** Cosmos REST (LCD) client, GET only; refuses endpoints serving another chain id. */
export function createCosmosRest(urls, chainId, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const run = failover(urls, async (url) => {
    const info = await fetchJson(fetchImpl, `${url}/cosmos/base/tendermint/v1beta1/node_info`, { method: 'GET' }, timeoutMs);
    const network = info?.default_node_info?.network;
    if (network !== chainId) throw new RpcError(`wrong chain ${network} at ${url}`);
  });
  return { get: (path) => run((url) => fetchJson(fetchImpl, url + path, { method: 'GET' }, timeoutMs)) };
}
