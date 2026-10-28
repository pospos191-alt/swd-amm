// Read-only network clients for the money-flow graph. Like src/rpc.js, they
// can only read: every client has an allow-list (JSON-RPC methods, or GET
// paths), and nothing here can sign or send a transaction.
//
// Differences from src/rpc.js (which stays unchanged: it is part of the skill id):
//   - the graph needs history: eth_getLogs, eth_getTransactionCount,
//     eth_getBlockByNumber, eth_blockNumber and, where a node offers it,
//     trace_filter; Solana getSignaturesForAddress / getTransaction
//   - every request counts against a shared budget (graph/util.js createBudget)
//   - requests to one host go out one at a time with a small gap (free
//     endpoints rate-limit), and a 429 waits and retries once
//   - answers that cannot change (a mined transaction, logs of an old block
//     range) are cached (graph/cache.js)

import { BudgetError, sleep, canonical } from './util.js';

export class GraphRpcError extends Error {}

export const EVM_GRAPH_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getLogs', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getBalance', 'trace_filter',
]);
export const SOLANA_GRAPH_METHODS = new Set(['getGenesisHash', 'getSignaturesForAddress', 'getTransaction', 'getAccountInfo']);

/** One request at a time per client, at least `gapMs` apart. */
function pacer(gapMs) {
  let queue = Promise.resolve();
  let last = 0;
  return (fn) => {
    const p = queue.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    queue = p.catch(() => {});
    return p;
  };
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new GraphRpcError(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof GraphRpcError) throw e;
    throw new GraphRpcError(e?.name === 'AbortError' ? 'timeout' : (e?.message ?? 'network error'));
  } finally {
    clearTimeout(timer);
  }
}

const noBudget = { take() {} };

/**
 * JSON-RPC client over several URLs (failover), verified once per URL with
 * `identify`. call(method, params, { cache: true }) caches the answer.
 */
function jsonRpc(urls, { allowed, identify, fetchImpl = globalThis.fetch, budget = noBudget, cache = null, gapMs = 120, timeoutMs = 12_000, retryMs = 1200 }) {
  const verified = new Set();
  const pace = pacer(gapMs);
  const unsupported = new Set(); // methods a node said it does not have
  let id = 0;

  const post = (url, method, params) => pace(async () => {
    budget.take();
    const body = await fetchJson(fetchImpl, url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    }, timeoutMs);
    if (!body) throw new GraphRpcError('HTTP 404');
    if (body.error) {
      const e = new GraphRpcError(String(body.error.message ?? 'rpc error').slice(0, 200));
      e.code = body.error.code;
      throw e;
    }
    return body.result;
  });

  async function call(method, params = [], { cache: useCache = false } = {}) {
    if (!allowed.has(method)) throw new GraphRpcError(`method not allowed: ${method}`);
    if (unsupported.has(method)) throw new GraphRpcError(`unsupported: ${method}`);
    const key = useCache && cache ? `rpc:${urls[0]}:${method}:${canonical(params)}` : null;
    if (key) { const hit = await cache.get(key); if (hit !== undefined) return hit; }
    let lastErr;
    for (let round = 0; round < 2; round++) {
      let limited = false;
      for (const url of urls) {
        try {
          if (!verified.has(url)) { await identify((m, p) => post(url, m, p), url); verified.add(url); }
          const out = await post(url, method, params);
          if (key && out != null) await cache.set(key, out);
          return out;
        } catch (e) {
          if (e instanceof BudgetError) throw e;
          lastErr = e;
          if (e.code === -32601 || /method not found|not supported|does not exist|not available/i.test(e.message)) {
            unsupported.add(method);
            throw new GraphRpcError(`unsupported: ${method}`);
          }
          if (/HTTP 429/.test(e.message)) limited = true;
        }
      }
      if (!limited) break;
      if (round === 0) await sleep(retryMs);
    }
    throw new GraphRpcError(`all endpoints failed: ${lastErr?.message ?? 'unknown'}`);
  }
  return { call, supports: (m) => !unsupported.has(m) };
}

/** EVM client; refuses endpoints whose eth_chainId is not `chainId`. */
export function createEvmClient(urls, chainId, opts = {}) {
  return jsonRpc(urls, {
    ...opts,
    allowed: EVM_GRAPH_METHODS,
    identify: async (post, url) => {
      const cid = parseInt(await post('eth_chainId', []), 16);
      if (cid !== chainId) throw new GraphRpcError(`wrong chain ${cid} at ${url}`);
    },
  });
}

/** Solana client; refuses endpoints whose genesis hash differs. */
export function createSolanaClient(urls, genesisHash, opts = {}) {
  return jsonRpc(urls, {
    gapMs: 250, // the public mainnet endpoint allows only a few requests a second
    ...opts,
    allowed: SOLANA_GRAPH_METHODS,
    identify: async (post, url) => {
      const g = await post('getGenesisHash', []);
      if (g !== genesisHash) throw new GraphRpcError(`wrong cluster ${g} at ${url}`);
    },
  });
}

// Blockscout: free, keyless, and sends CORS headers, so a browser can read it
// directly. Only these GET calls are made.
const BLOCKSCOUT_ACTIONS = new Set(['account.txlist', 'account.txlistinternal', 'logs.getLogs', 'contract.getcontractcreation']);

/** Blockscout's Etherscan-compatible API (GET /api?module=…&action=…). */
export function createBlockscout(base, { fetchImpl = globalThis.fetch, budget = noBudget, cache = null, gapMs = 220, timeoutMs = 15_000 } = {}) {
  const pace = pacer(gapMs);
  return {
    base,
    async get(params, { cacheTtlMs = 10 * 60_000 } = {}) {
      if (!BLOCKSCOUT_ACTIONS.has(`${params.module}.${params.action}`)) throw new GraphRpcError(`blockscout action not allowed: ${params.module}.${params.action}`);
      const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
      const url = `${base}/api?${qs}`;
      const key = cache ? `bs:${url}` : null;
      if (key) { const hit = await cache.get(key); if (hit !== undefined) return hit; }
      let body;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          body = await pace(async () => { budget.take(); return fetchJson(fetchImpl, url, { method: 'GET' }, timeoutMs); });
          break;
        } catch (e) {
          if (e instanceof BudgetError || attempt || !/HTTP 429/.test(e.message)) throw e;
          await sleep(1500);
        }
      }
      if (!body) return [];
      // status "0" with an empty result means "nothing found", not an error.
      if (body.status === '0' && !/no (transactions|records|logs)|not found/i.test(String(body.message ?? '')) && !Array.isArray(body.result)) {
        throw new GraphRpcError(`blockscout: ${String(body.result ?? body.message).slice(0, 120)}`);
      }
      const out = Array.isArray(body.result) ? body.result : [];
      if (key) await cache.set(key, out, cacheTtlMs);
      return out;
    },
  };
}

/** Cosmos REST (LCD), GET only, under /cosmos/ and /cosmwasm/ paths. */
export function createCosmosClient(urls, { fetchImpl = globalThis.fetch, budget = noBudget, cache = null, gapMs = 150, timeoutMs = 12_000 } = {}) {
  const pace = pacer(gapMs);
  return {
    async get(path) {
      if (!/^\/(cosmos|cosmwasm)\/[A-Za-z0-9_/.%?=&'-]+$/.test(path)) throw new GraphRpcError(`path not allowed: ${path.slice(0, 80)}`);
      const key = cache ? `cosmos:${urls[0]}${path}` : null;
      if (key) { const hit = await cache.get(key); if (hit !== undefined) return hit; }
      let lastErr;
      for (const url of urls) {
        try {
          const out = await pace(async () => { budget.take(); return fetchJson(fetchImpl, url + path, { method: 'GET' }, timeoutMs); });
          if (key && out) await cache.set(key, out, 10 * 60_000);
          return out;
        } catch (e) {
          if (e instanceof BudgetError) throw e;
          lastErr = e;
        }
      }
      throw new GraphRpcError(`all endpoints failed: ${lastErr?.message ?? 'unknown'}`);
    },
  };
}
