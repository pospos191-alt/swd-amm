// Reads from the ZETAPHY node's EVM JSON-RPC (the URL in Settings), and finds
// events client-side with bounded block ranges: each eth_getLogs asks for at
// most `step` blocks (the node refuses more than 2000 and more than 2000 logs:
// a refused range is split in half), and a scan never goes further back than
// `maxBlocks`. Results are cached per (RPC, query) in localStorage, so a later
// visit only asks for the blocks since.

export class RpcError extends Error {
  constructor(message, code, data) { super(message); this.code = code; this.data = data; }
}

const hex = (n) => '0x' + BigInt(n).toString(16);

export function makeRpc(url, { fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 15_000 } = {}) {
  let id = 0;
  async function call(method, params = []) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (e) {
      throw new RpcError(`RPC unreachable: ${e?.message ?? e}`, -1);
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new RpcError(`RPC HTTP ${res.status}`, res.status);
    const j = await res.json();
    if (j.error) throw new RpcError(String(j.error.message ?? 'RPC error').slice(0, 300), j.error.code, j.error.data);
    return j.result;
  }
  return {
    url,
    call,
    chainId: async () => Number(BigInt(await call('eth_chainId'))),
    blockNumber: async () => Number(BigInt(await call('eth_blockNumber'))),
    getCode: (a) => call('eth_getCode', [a, 'latest']),
    getBalance: async (a) => BigInt(await call('eth_getBalance', [a, 'latest'])),
    ethCall: (to, data, from) => call('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']),
    receipt: (h) => call('eth_getTransactionReceipt', [h]),
    getLogs: (f) => call('eth_getLogs', [{ ...f, fromBlock: hex(f.fromBlock), toBlock: hex(f.toBlock) }]),
  };
}

/** Calls a fn() descriptor (lib/abi.js) and decodes the answer. */
export async function read(rpc, to, f, ...args) {
  return f.decode(await rpc.ethCall(to, f.encode(...args)));
}

/** Waits for a transaction's receipt (polling); throws if it reverted. */
export async function waitReceipt(rpc, hash, { tries = 90, delayMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await rpc.receipt(hash).catch(() => null);
    if (r) {
      if (r.status !== undefined && BigInt(r.status) === 0n) throw new RpcError('transaction reverted', 'reverted', r);
      return r;
    }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  throw new RpcError('no receipt yet: check the explorer later', 'timeout');
}

// ---- bounded log scanning with a cache ----

const memoryStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
function storage() {
  try { const s = globalThis.localStorage; s.setItem('__t', '1'); s.removeItem('__t'); return s; } catch { return memoryStore(); }
}
const MAX_CACHED_LOGS = 3000;

/**
 * Logs matching { address, topics } in the newest blocks, newest first.
 * opts: { floor: first block worth scanning (e.g. the deploy block), maxBlocks,
 *         step, want: stop going back once this many logs are found, cacheKey }.
 * Returns { logs, from, to, complete } (complete: reached `floor`).
 */
export async function scanLogs(rpc, filter, { floor = 0, maxBlocks = 50_000, step = 2000, want = Infinity, cacheKey = null, store = storage() } = {}) {
  const head = await rpc.blockNumber();
  const key = cacheKey ? `zn.logs.${cacheKey}` : null;
  let cache = null;
  if (key) { try { cache = JSON.parse(store.getItem(key)); } catch { cache = null; } }
  if (!cache || typeof cache.lo !== 'number' || typeof cache.hi !== 'number' || !Array.isArray(cache.logs) || cache.hi > head) cache = null;
  const lowest = Math.max(floor, head - maxBlocks + 1, 0);
  let logs = cache ? cache.logs.slice() : [];
  let lo = cache ? cache.lo : head + 1;
  let hi = cache ? cache.hi : head;

  async function range(from, to) {
    try {
      return await rpc.getLogs({ ...filter, fromBlock: from, toBlock: to });
    } catch (e) {
      if (to > from) { // too many blocks or logs: split
        const mid = Math.floor((from + to) / 2);
        return [...await range(from, mid), ...await range(mid + 1, to)];
      }
      throw e;
    }
  }
  // New blocks since the cache, oldest first.
  if (cache && hi < head) {
    const fresh = [];
    for (let from = hi + 1; from <= head; from += step) fresh.push(...await range(from, Math.min(head, from + step - 1)));
    logs = [...logs, ...fresh];
    hi = head;
  }
  // Older blocks, newest first, until enough or the bound.
  let budget = maxBlocks;
  while (lo > lowest && logs.length < want && budget > 0) {
    const to = lo - 1;
    const from = Math.max(lowest, to - step + 1);
    logs = [...await range(from, to), ...logs];
    budget -= to - from + 1;
    lo = from;
  }
  logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex ?? 0) - BigInt(b.logIndex ?? 0)));
  if (key) {
    const keep = logs.slice(-MAX_CACHED_LOGS);
    const keptLo = keep.length < logs.length ? Number(BigInt(keep[0].blockNumber)) : lo;
    try { store.setItem(key, JSON.stringify({ lo: keptLo, hi, logs: keep })); } catch { /* full: no cache */ }
  }
  return { logs: logs.reverse(), from: lo, to: hi, complete: lo <= Math.max(floor, 0) };
}
