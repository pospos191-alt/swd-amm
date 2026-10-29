// A tiny read-only EVM JSON-RPC client for the browser AI (registry reads and the
// on-chain knowledge reader). Only these methods exist: it cannot sign or send.
// Before trusting an endpoint it checks once that eth_chainId is the expected chain.
// Separate from src/rpc.js on purpose (src/ is Neuro's skill id; eth_getLogs is
// needed here and not there).

const ALLOWED = new Set(['eth_chainId', 'eth_call', 'eth_getLogs', 'eth_blockNumber']);
export class ChainReadError extends Error {}

export function createReader(urls, expectedChainId, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) throw new ChainReadError('no RPC URL');
  const verified = new Set();
  let id = 0;
  async function post(url, method, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      const j = await res.json();
      if (j.error) throw new ChainReadError(`${method}: ${String(j.error.message ?? 'error').slice(0, 120)}`);
      return j.result;
    } finally { clearTimeout(timer); }
  }
  async function call(method, params = []) {
    if (!ALLOWED.has(method)) throw new ChainReadError(`${method} is not a read this client makes`);
    let last;
    for (const url of list) {
      try {
        if (expectedChainId != null && !verified.has(url)) {
          const got = BigInt(await post(url, 'eth_chainId', []));
          if (got !== BigInt(expectedChainId)) throw new ChainReadError(`${url} serves chain ${got}, not ${expectedChainId}`);
          verified.add(url);
        }
        return await post(url, method, params);
      } catch (e) { last = e; }
    }
    throw last instanceof ChainReadError ? last : new ChainReadError(String(last?.message ?? 'RPC failed'));
  }
  return { call };
}

// ---- small ABI helpers (static words, one dynamic string/bytes) ----
export const word = (hex) => String(hex).replace(/^0x/, '').padStart(64, '0');
export const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
export function readWord(hex, i) {
  const h = String(hex).replace(/^0x/, '');
  return h.slice(i * 64, i * 64 + 64);
}
export const wordUint = (w) => BigInt('0x' + (w || '0'));
export const wordAddress = (w) => '0x' + w.slice(24);
/** A dynamic string at byte offset `off` (from the start of `hex`). */
export function readString(hex, off) {
  const h = String(hex).replace(/^0x/, '');
  const at = Number(off) * 2;
  const len = Number(BigInt('0x' + h.slice(at, at + 64)));
  if (len > 100_000) throw new ChainReadError('string too long');
  const data = h.slice(at + 64, at + 64 + len * 2);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(data.slice(2 * i, 2 * i + 2), 16);
  return new TextDecoder().decode(bytes);
}
