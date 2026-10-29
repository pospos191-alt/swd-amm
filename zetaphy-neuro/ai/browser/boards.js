// Where signal envelopes (ai/browser/signal.js) are posted and read: "boards".
// A board is untrusted: it can drop, delay or replay messages, and it sees who
// posts what and when, but every envelope is signed, short-lived and (offers /
// answers) encrypted to its recipient, so it cannot forge or read a connection.
//
// Same shape for all:
//   board.domain                      string bound into every signature
//   board.post({topic, to, expiresAt, bytes})   to: 16-byte peer id or null (everyone)
//   board.read(topic) -> [{bytes, via?}]        new messages since the last read
//   board.learn?(peerIdHex, via)                (tracker) where to reach a verified sender
//
//   memoryHub().board(domain)   in-process (tests, or several swarms in one page)
//   chainBoard({...})           the SignalBoard contract on the ZETAPHY chain: read with
//                               eth_getLogs, write with a throwaway session key paid by
//                               the testnet faucet. No server of ours; the default.
//   trackerBoard({url})         a public WebTorrent WebSocket tracker (third party, free,
//                               OFF by default: it needs a wss: entry in connect-src and
//                               the tracker sees who is online); swappable for any URL.

import { keccak256 } from '../../src/keccak.js';
import { hex, unhex, peekEnvelope } from './signal.js';

export function memoryHub() {
  const log = [];
  return {
    log,
    board(domain = 'memory') {
      let cursor = 0;
      return {
        domain,
        posts: 0,
        async post({ topic, to, expiresAt, bytes }) { this.posts++; log.push({ topic: hex(topic), to: to ? hex(to) : null, expiresAt, bytes: new Uint8Array(bytes) }); },
        async read(topic) {
          const t = hex(topic);
          const out = log.slice(cursor).filter((m) => m.topic === t).map((m) => ({ bytes: m.bytes }));
          cursor = log.length;
          return out;
        },
      };
    },
  };
}

// ---------------------------------------------------------------- the chain board

const enc = new TextEncoder();
export const SIGNAL_EVENT = '0x' + hex(keccak256(enc.encode('Signal(bytes32,bytes32,address,uint64,bytes)')));
export const POST_SELECTOR = hex(keccak256(enc.encode('post(bytes32,bytes32,uint64,bytes)')).subarray(0, 4));
const WRITES = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_gasPrice', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_estimateGas', 'eth_sendRawTransaction', 'eth_getTransactionReceipt', 'zetaphy_faucet']);

const w32 = (b) => hex(b).padEnd(64, '0');
const uint = (n) => BigInt(n).toString(16).padStart(64, '0');

/** Calldata of SignalBoard.post(topic, to, expiresAt, payload). */
export function postCalldata({ topic, to, expiresAt, bytes }) {
  const body = hex(bytes);
  return '0x' + POST_SELECTOR + w32(topic) + (to ? w32(to) : '0'.repeat(64)) + uint(expiresAt) + uint(128) + uint(bytes.length) + body.padEnd(Math.ceil(body.length / 64) * 64, '0');
}

/** Decodes a Signal log: {topic, to, from, expiresAt, bytes, block}. */
export function decodeSignalLog(log) {
  if (log.topics?.[0]?.toLowerCase() !== SIGNAL_EVENT || log.topics.length !== 4) throw new Error('not a Signal log');
  const d = String(log.data).replace(/^0x/, '');
  const expiresAt = Number(BigInt('0x' + d.slice(0, 64)));
  const off = Number(BigInt('0x' + d.slice(64, 128))) * 2;
  const len = Number(BigInt('0x' + d.slice(off, off + 64)));
  if (len > 4096) throw new Error('payload too large');
  return {
    topic: log.topics[1].toLowerCase().replace(/^0x/, ''),
    to: log.topics[2].toLowerCase().replace(/^0x/, ''),
    from: '0x' + log.topics[3].slice(-40).toLowerCase(),
    expiresAt,
    bytes: unhex(d.slice(off + 64, off + 64 + len * 2)),
    block: Number(BigInt(log.blockNumber ?? 0)),
  };
}

/** A JSON-RPC client limited to the reads and the one write the chain board makes; checks the chain id first. */
export function boardRpc(urls, chainId, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const verified = new Set();
  let id = 0;
  async function post(url, method, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      const j = await res.json();
      if (j.error) throw new Error(`${method}: ${String(j.error.message ?? 'error').slice(0, 160)}`);
      return j.result;
    } finally { clearTimeout(timer); }
  }
  return {
    async call(method, params = []) {
      if (!WRITES.has(method)) throw new Error(`${method} is not a call the signal board makes`);
      let last;
      for (const url of list) {
        try {
          if (!verified.has(url)) {
            const got = BigInt(await post(url, 'eth_chainId', []));
            if (got !== BigInt(chainId)) throw new Error(`${url} serves chain ${got}, not ${chainId}`);
            verified.add(url);
          }
          return await post(url, method, params);
        } catch (e) { last = e; }
      }
      throw last ?? new Error('no RPC URL');
    },
  };
}

/**
 * The SignalBoard contract as a board. wallet: evmtx.js sessionWallet() (only needed to post).
 * lookbackBlocks: how far back the first read goes (default 150 blocks, ~12 minutes at 5 s: longer than MAX_TTL).
 * faucet: ask the testnet faucet (zetaphy_faucet) once when the session key cannot pay for a post.
 */
export function chainBoard({ rpc, chainId, address, wallet = null, fetchImpl, lookbackBlocks = 150, faucet = true, gasPriceCap = 100n * 10n ** 9n, onSpend } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new Error('chainBoard: no SignalBoard address');
  const client = rpc?.call ? rpc : boardRpc(rpc, chainId, { fetchImpl });
  const board = String(address).toLowerCase();
  let next = null; // next block to read
  let asked = false;
  const B = (x) => BigInt(x);
  const stats = { posts: 0, reads: 0, gasWei: 0n, faucet: 0 };
  async function ensureFunds(need) {
    const bal = B(await client.call('eth_getBalance', [wallet.address, 'latest']));
    if (bal >= need) return;
    if (!faucet || asked) throw new Error('the session key has no testnet coins for a post (faucet not available)');
    asked = true;
    await client.call('zetaphy_faucet', [wallet.address]);
    stats.faucet++;
    for (let i = 0; i < 20; i++) {
      if (B(await client.call('eth_getBalance', [wallet.address, 'latest'])) >= need) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('the faucet did not pay in time');
  }
  return {
    domain: `evm:${chainId}:${board}`,
    stats,
    address: board,
    async post(msg) {
      if (!wallet) throw new Error('chainBoard: read-only (no session wallet)');
      const data = postCalldata(msg);
      let gasPrice = B(await client.call('eth_gasPrice', []));
      if (gasPrice > gasPriceCap) throw new Error('gas price above the cap: not posting');
      let gas;
      try { gas = (B(await client.call('eth_estimateGas', [{ from: wallet.address, to: board, data }])) * 13n) / 10n; } catch (e) {
        if (/RateLimited|BadExpiry|PayloadSize|revert/i.test(e.message)) throw e;
        gas = 300000n;
      }
      await ensureFunds(gas * gasPrice);
      const nonce = B(await client.call('eth_getTransactionCount', [wallet.address, 'pending']));
      const { raw, hash } = await wallet.signTx({ nonce, gasPrice, gas, to: board, value: 0, data, chainId });
      await client.call('eth_sendRawTransaction', [raw]);
      stats.posts++; stats.gasWei += gas * gasPrice;
      onSpend?.(gas * gasPrice);
      return hash;
    },
    async read(topic) {
      const head = Number(B(await client.call('eth_blockNumber', [])));
      const from = next ?? Math.max(0, head - lookbackBlocks);
      if (from > head) return [];
      const logs = await client.call('eth_getLogs', [{ address: board, topics: [SIGNAL_EVENT, '0x' + hex(topic)], fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) }]);
      next = head + 1;
      stats.reads++;
      const out = [];
      for (const l of logs ?? []) {
        try {
          const m = decodeSignalLog(l);
          // the contract's indexed fields must agree with the envelope itself
          const p = peekEnvelope(m.bytes);
          if (!p || hex(p.topic) !== m.topic || w32(p.to) !== m.to || p.expiresAt !== m.expiresAt) continue;
          out.push({ bytes: m.bytes, via: m.from });
        } catch { /* a malformed log is skipped */ }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- a WebTorrent tracker (optional)

const b64 = (b) => btoa(String.fromCharCode(...b));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const binStr = (b) => String.fromCharCode(...b);

/**
 * A public WebTorrent WebSocket tracker as a board (the BitTorrent "info_hash" is
 * the first 20 bytes of the topic). Announces go out as tracker "offers" (the
 * tracker hands them to up to `numwant` random peers on the topic), messages to
 * one peer as tracker "answers" with to_peer_id. OFF by default: it is a third
 * party, it sees every peer's IP address and topic, and the page's CSP must allow
 * its wss: URL. WebSocketImpl is injectable (tests).
 */
export function trackerBoard({ url, WebSocketImpl = globalThis.WebSocket, numwant = 8, reannounceMs = 60_000 } = {}) {
  if (!/^wss:\/\//.test(String(url)) && !/^ws:\/\/(localhost|127\.0\.0\.1)[:/]/.test(String(url))) throw new Error('trackerBoard: a wss:// URL');
  const peerId = binStr(globalThis.crypto.getRandomValues(new Uint8Array(20)).map((x) => 33 + (x % 90)));
  const inbox = new Map();     // info_hash -> [{bytes, via}]
  const joined = new Map();    // info_hash -> last announce time
  const route = new Map();     // peer id hex -> tracker peer_id
  let ws = null, open = null;
  const ih = (topic) => binStr(topic.subarray(0, 20));
  function connect() {
    if (open) return open;
    open = new Promise((resolve, reject) => {
      ws = new WebSocketImpl(url);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => { open = null; reject(new Error('tracker unreachable')); };
      ws.onclose = () => { open = null; joined.clear(); };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)); } catch { return; }
        const sdp = m.offer?.sdp ?? m.answer?.sdp;
        if (m.action !== 'announce' || typeof sdp !== 'string' || !sdp.startsWith('ZS:') || sdp.length > 4000) return;
        try {
          const list = inbox.get(m.info_hash) ?? [];
          if (list.length < 256) list.push({ bytes: unb64(sdp.slice(3)), via: m.peer_id });
          inbox.set(m.info_hash, list);
        } catch { /* not base64 */ }
      };
    });
    return open;
  }
  const send = async (o) => (await connect()).send(JSON.stringify(o));
  return {
    domain: `tracker:${url}`,
    peerId,
    learn(peerHex, via) { if (typeof via === 'string' && via.length === 20) route.set(peerHex, via); },
    async post({ topic, to, bytes }) {
      const info_hash = ih(topic);
      const offer_id = binStr(globalThis.crypto.getRandomValues(new Uint8Array(20)).map((x) => 33 + (x % 90)));
      const sdp = 'ZS:' + b64(bytes);
      if (!to) { await send({ action: 'announce', info_hash, peer_id: peerId, numwant, offers: [{ offer_id, offer: { type: 'offer', sdp } }] }); joined.set(info_hash, Date.now()); return; }
      const toPeer = route.get(hex(to));
      if (!toPeer) throw new Error('tracker: no route to that peer yet');
      await send({ action: 'announce', info_hash, peer_id: peerId, to_peer_id: toPeer, offer_id, answer: { type: 'answer', sdp } });
    },
    async read(topic) {
      const info_hash = ih(topic);
      if (!joined.has(info_hash) || Date.now() - joined.get(info_hash) > reannounceMs) {
        await send({ action: 'announce', info_hash, peer_id: peerId, numwant: 0, offers: [] });
        joined.set(info_hash, Date.now());
      }
      const out = inbox.get(info_hash) ?? [];
      inbox.set(info_hash, []);
      return out;
    },
    close() { try { ws?.close(); } catch { /* closed */ } },
  };
}
