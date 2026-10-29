// Browser-to-browser transport over WebRTC data channels, with no server.
//
// Signaling (how two browsers find each other) is MANUAL: one side makes an
// offer code, the other pastes it and answers with an answer code, which the
// first pastes back. A code is the SDP with every ICE candidate already inside
// (non-trickle), deflated and base64url-encoded ("ZP1." prefix), short enough
// to send over any chat app or show as a QR code. Nothing here runs a
// signaling server, and none is needed for that flow.
// ICE: by default no STUN/TURN server is configured, so only host candidates
// are used: same machine or same LAN. Passing iceServers (e.g. a public STUN)
// lets peers behind ordinary NATs connect; peers behind symmetric NATs need a
// TURN relay, which is a server: not provided (see docs/future/browser-ai.md).
//
// On top of a channel (RTCDataChannel, or memoryPair() in tests) this file has
// a small request/response protocol with fragmentation (data channels cap a
// message at ~256 KiB; model chunks are MiBs) and backpressure, used by:
//   - servePeer / peerSource: chunk exchange for the verified loader
//     (the receiver hashes every chunk, so a peer can only waste time);
//   - ai/browser/pipeline.js: activations between pipeline stages.

export const FRAG = 60 * 1024;
const HDR = 13; // kind u8 | reqId u32 | method u8 | part u16 | parts u16 | reserved u8 x3
export const KIND = { request: 1, response: 2, error: 3 };
export const METHOD = { chunk: 1, manifest: 2, forward: 10, hello: 11, llm: 12, llmEnd: 13 };
const MAX_PARTS = 2048; // 120 MiB per message

/** Two connected in-memory channels with RTCDataChannel's shape (send / message events). */
export function memoryPair({ dropEvery = 0 } = {}) {
  const mk = () => {
    const ls = new Set();
    return {
      readyState: 'open', bufferedAmount: 0, binaryType: 'arraybuffer', other: null, n: 0,
      addEventListener(t, f) { if (t === 'message') ls.add(f); },
      removeEventListener(t, f) { if (t === 'message') ls.delete(f); },
      send(d) {
        const buf = d instanceof ArrayBuffer ? d.slice(0) : new Uint8Array(d).slice().buffer;
        if (dropEvery && ++this.n % dropEvery === 0) return;
        const to = this.other;
        setTimeout(() => { for (const f of to._ls) f({ data: buf }); }, 0);
      },
      close() { this.readyState = 'closed'; },
      _ls: ls,
    };
  };
  const a = mk(); const b = mk();
  a.other = b; b.other = a;
  return [a, b];
}

/**
 * Request/response over one channel. handlers: {[method]: async (payload Uint8Array) => Uint8Array}.
 * Returns {request(method, payload, {timeoutMs}) -> Promise<Uint8Array>, close()}.
 */
export function rpcChannel(channel, handlers = {}, { maxInFlight = 64 } = {}) {
  // Several rpcChannels may share one data channel (chunks, pipeline stages): request ids
  // start at a random point and a response must match the method, so answers never cross.
  let next = 1 + Math.floor(Math.random() * 0x7fff0000);
  const waiting = new Map();   // reqId -> {resolve, reject, parts, got, timer}
  const incoming = new Map();  // reqId -> {method, parts, got}
  let served = 0;
  const lowWater = async () => {
    if (!(channel.bufferedAmount > 1024 * 1024)) return;
    await new Promise((r) => {
      const t = setInterval(() => { if (!(channel.bufferedAmount > 256 * 1024) || channel.readyState !== 'open') { clearInterval(t); r(); } }, 5);
    });
  };
  async function sendMsg(kind, reqId, method, payload) {
    const parts = Math.max(1, Math.ceil(payload.length / FRAG));
    if (parts > MAX_PARTS) throw new Error('message too large');
    for (let p = 0; p < parts; p++) {
      const body = payload.subarray(p * FRAG, Math.min(payload.length, (p + 1) * FRAG));
      const f = new Uint8Array(HDR + body.length);
      const v = new DataView(f.buffer);
      v.setUint8(0, kind); v.setUint32(1, reqId); v.setUint8(5, method); v.setUint16(6, p); v.setUint16(8, parts);
      f.set(body, HDR);
      await lowWater();
      if (channel.readyState && channel.readyState !== 'open') throw new Error('channel closed');
      channel.send(f);
    }
  }
  const join = (got, parts) => {
    const len = got.reduce((s, x) => s + x.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (let i = 0; i < parts; i++) { out.set(got[i], o); o += got[i].length; }
    return out;
  };
  async function onMessage(e) {
    const f = new Uint8Array(e.data instanceof ArrayBuffer ? e.data : e.data?.buffer ?? e.data);
    if (f.length < HDR) return;
    const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const kind = v.getUint8(0), reqId = v.getUint32(1), method = v.getUint8(5), part = v.getUint16(6), parts = v.getUint16(8);
    if (!parts || parts > MAX_PARTS || part >= parts) return;
    const body = f.slice(HDR);
    if (kind === KIND.request) {
      if (!handlers[method]) return; // another rpcChannel on this channel may serve it
      let m = incoming.get(reqId);
      if (!m) {
        if (incoming.size >= maxInFlight) return; // a flooding peer is ignored
        m = { method, parts, got: new Array(parts), n: 0 };
        incoming.set(reqId, m);
      }
      if (m.parts !== parts || m.got[part]) return;
      m.got[part] = body; m.n++;
      if (m.n < parts) return;
      incoming.delete(reqId);
      const h = handlers[method];
      try {
        const out = await h(join(m.got, parts));
        served++;
        await sendMsg(out ? KIND.response : KIND.error, reqId, method, out ?? new Uint8Array());
      } catch (err) {
        await sendMsg(KIND.error, reqId, method, new TextEncoder().encode(String(err?.message ?? 'error').slice(0, 200))).catch(() => {});
      }
      return;
    }
    const w = waiting.get(reqId);
    if (!w || w.method !== method) return;
    if (!w.got) { w.got = new Array(parts); w.parts = parts; w.n = 0; }
    if (w.parts !== parts || w.got[part]) return;
    w.got[part] = body; w.n++;
    if (w.n < parts) return;
    waiting.delete(reqId);
    clearTimeout(w.timer);
    const all = join(w.got, parts);
    if (kind === KIND.response) w.resolve(all); else w.reject(new Error(new TextDecoder().decode(all) || 'not available'));
  }
  channel.binaryType = 'arraybuffer';
  channel.addEventListener('message', onMessage);
  return {
    request(method, payload = new Uint8Array(), { timeoutMs = 30_000 } = {}) {
      const reqId = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error('peer timed out')); }, timeoutMs);
        waiting.set(reqId, { resolve, reject, timer, method });
        sendMsg(KIND.request, reqId, method, payload).catch((e) => { clearTimeout(timer); waiting.delete(reqId); reject(e); });
      });
    },
    get served() { return served; },
    close() { channel.removeEventListener('message', onMessage); for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error('closed')); } waiting.clear(); },
  };
}

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hashBytes = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(32); for (let i = 0; i < 32; i++) o[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return o; };

/**
 * Serves chunks (and manifests) this browser already has to a peer. It only
 * answers with what is in `store` under that hash; it never fetches for the peer.
 */
export function servePeer(channel, store, { extra = {}, maxBytesPerSecond = 0, maxBytesTotal = 0 } = {}) {
  // Upload limits: an average rate (answers wait their turn) and a total for this peer (then it gets "not available").
  let sent = 0, nextFree = 0;
  const limited = async (b) => {
    if (!b) return null;
    if (maxBytesTotal && sent + b.length > maxBytesTotal) return null;
    sent += b.length;
    if (maxBytesPerSecond > 0) {
      const t = Date.now();
      const start = Math.max(t, nextFree);
      nextFree = start + (b.length / maxBytesPerSecond) * 1000;
      if (start > t) await new Promise((r) => setTimeout(r, start - t));
    }
    return b;
  };
  const rpc = rpcChannel(channel, {
    [METHOD.chunk]: async (p) => (p.length === 32 ? limited(await store.get(hexOf(p))) : null),
    [METHOD.manifest]: async (p) => (p.length === 32 ? store.get(`m-${hexOf(p)}`) : null),
    ...extra,
  });
  return Object.defineProperty(rpc, 'bytesSent', { get: () => sent });
}

/** A loader source backed by a peer: {id, getChunk(hash), getManifest(hash)}. Answers are verified by the loader. */
export function peerSource(channel, id = 'peer', { timeoutMs = 30_000 } = {}) {
  const rpc = rpcChannel(channel);
  return {
    id,
    rpc,
    getChunk: (h) => rpc.request(METHOD.chunk, hashBytes(h), { timeoutMs }).catch(() => null),
    getManifest: (h) => rpc.request(METHOD.manifest, hashBytes(h), { timeoutMs }).catch(() => null),
  };
}

// ---- manual signaling (no server) ----

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function pipe(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** {type, sdp} -> "ZP1.<base64url(deflate-raw(json))>" (or ZP0. uncompressed where CompressionStream is missing). */
export async function encodeSignal(desc) {
  const json = new TextEncoder().encode(JSON.stringify({ t: desc.type, s: desc.sdp }));
  if (globalThis.CompressionStream) return 'ZP1.' + b64u(await pipe(json, new CompressionStream('deflate-raw')));
  return 'ZP0.' + b64u(json);
}

export async function decodeSignal(code) {
  const s = String(code ?? '').trim();
  if (s.length > 20000) throw new Error('code too long');
  let json;
  if (s.startsWith('ZP1.')) json = await pipe(unb64u(s.slice(4)), new DecompressionStream('deflate-raw'));
  else if (s.startsWith('ZP0.')) json = unb64u(s.slice(4));
  else throw new Error('not a ZETAPHY peer code');
  const o = JSON.parse(new TextDecoder().decode(json));
  if (!['offer', 'answer'].includes(o.t) || typeof o.s !== 'string' || o.s.length > 20000) throw new Error('bad peer code');
  return { type: o.t, sdp: o.s };
}

function gathered(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } });
  });
}
const opened = (dc) => (dc.readyState === 'open' ? Promise.resolve(dc) : new Promise((r, j) => { dc.addEventListener('open', () => r(dc)); dc.addEventListener('error', j); }));

/**
 * Side A: makes the offer code. Returns {code, accept(answerCode) -> Promise<RTCDataChannel>, pc}.
 * iceServers: [] by default (LAN only); pass e.g. [{urls:'stun:…'}] to cross NATs.
 */
export async function createOffer({ iceServers = [], label = 'zetaphy', gatherMs = 5000, RTC = globalThis.RTCPeerConnection } = {}) {
  if (!RTC) throw new Error('this browser has no WebRTC');
  const pc = new RTC({ iceServers });
  const dc = pc.createDataChannel(label, { ordered: true });
  dc.binaryType = 'arraybuffer';
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc, gatherMs);
  return {
    pc,
    code: await encodeSignal(pc.localDescription),
    async accept(answerCode) {
      const d = await decodeSignal(answerCode);
      if (d.type !== 'answer') throw new Error('expected an answer code');
      await pc.setRemoteDescription(d);
      return opened(dc);
    },
  };
}

/** Side B: takes an offer code, returns {code (the answer to send back), channel: Promise<RTCDataChannel>, pc}. */
export async function acceptOffer(offerCode, { iceServers = [], gatherMs = 5000, RTC = globalThis.RTCPeerConnection } = {}) {
  if (!RTC) throw new Error('this browser has no WebRTC');
  const d = await decodeSignal(offerCode);
  if (d.type !== 'offer') throw new Error('expected an offer code');
  const pc = new RTC({ iceServers });
  const channel = new Promise((r) => pc.addEventListener('datachannel', (e) => { e.channel.binaryType = 'arraybuffer'; r(opened(e.channel)); }));
  await pc.setRemoteDescription(d);
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc, gatherMs);
  return { pc, code: await encodeSignal(pc.localDescription), channel };
}
