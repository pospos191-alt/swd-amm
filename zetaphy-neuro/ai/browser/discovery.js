// Automatic peer discovery: browsers that share a topic (the same model's chunks,
// or a pipeline stage of the same model) find each other through a board
// (ai/browser/boards.js: the ZETAPHY chain by default) and open WebRTC data
// channels (ai/browser/p2p.js) with no one pasting codes.
//
//   1. every browser posts a signed ANNOUNCE {role, layers, …} (public, expires in ttl);
//   2. a browser that wants a peer it saw posts an OFFER to it: its SDP, encrypted
//      to that peer's key (signal.js);
//   3. the peer answers with an ANSWER encrypted back; the data channel opens.
// If both offer at once, the lower peer id's offer wins. Nothing here is trusted:
// a peer only gets a channel; what flows on it (model chunks, activations) is
// checked by the loader (hashes against ModelRegistry) or by the coordinator.
//
// Limits (all options): maxPeers connected, maxPending offers, a post budget per
// minute (below SignalBoard's 12 per 60 s), offerTimeoutMs, a cap on remembered
// peers and seen messages. Privacy: an announce is public and permanent on a
// chain board (a session key, the topic, the time); the SDP inside offers/answers
// (IP addresses) is encrypted to the one recipient, but once connected the peer
// sees your IP address, as with any WebRTC connection. ICE: no STUN/TURN by
// default (same network); pass iceServers to cross NATs.

import { createIdentity, sealEnvelope, openEnvelope, MAX_TTL } from './signal.js';
import { createOffer, acceptOffer } from './p2p.js';

/**
 * @param {object} o
 * @param {object} o.board  a board (boards.js)
 * @param {Uint8Array} o.topic  32 bytes (signal.js topicFor)
 * @param {object} [o.meta]  what this browser announces (small JSON), e.g. {role:'stage', from:3, to:6}
 * @param {Function} [o.want]  (peerMeta) => boolean: whether to connect to a peer that announced this
 * @param {Function} [o.onPeer]  ({id, channel, meta, pc}) when a data channel opens
 */
export function createSwarm({
  board, topic, meta = {}, want = () => true, onPeer, onEvent,
  maxPeers = 4, maxPending = 2, ttl = 300, pollMs = 4000, offerTimeoutMs = 90_000, maxPostsPerMinute = 10, graceMs = null,
  iceServers = [], RTC = globalThis.RTCPeerConnection, gatherMs = 3000, now = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!board || !(topic instanceof Uint8Array) || topic.length !== 32) throw new Error('createSwarm: board and a 32-byte topic');
  if (!(ttl > 30 && ttl <= MAX_TTL)) throw new Error(`ttl: 31..${MAX_TTL} s`);
  let identity = null;
  let timer = null;
  let announcedUntil = 0;
  let busy = false;
  const known = new Map();    // peer id -> {idPub, ecdhPub, meta, expiresAt}
  const cooldown = new Map(); // peer id -> time before which we do not offer to it again
  const peers = new Map();    // peer id -> {channel, pc, meta}
  const pending = new Map();  // peer id -> {offer, at}
  const incoming = new Map(); // peer id -> {pc, at}: answered, channel not open yet (counts toward maxPeers)
  const seen = new Set();
  const posts = [];
  const stats = { announces: 0, offers: 0, answers: 0, rejected: 0, connected: 0 };
  const event = (type, data = {}) => { try { onEvent?.({ type, ...data }); } catch { /* the listener's problem */ } };

  async function post(kind, body, recipient = null) {
    const t = now();
    while (posts.length && posts[0] < Date.now() - 60_000) posts.shift();
    if (posts.length >= maxPostsPerMinute) throw new Error('post budget for this minute used');
    posts.push(Date.now());
    const expiresAt = t + (kind === 'announce' ? ttl : Math.min(ttl, 120));
    const bytes = await sealEnvelope(identity, { kind, topic, expiresAt, body, recipient, domain: board.domain });
    await board.post({ topic, to: recipient ? recipient.id : null, expiresAt, bytes });
    return expiresAt;
  }

  async function announce() {
    announcedUntil = await post('announce', meta);
    stats.announces++;
    event('announced', { until: announcedUntil });
  }

  function addPeer(id, channel, pc, peerMeta) {
    if (peers.has(id) || peers.size >= maxPeers) { try { pc?.close(); channel.close?.(); } catch { /* closed */ } return; }
    const entry = { id, channel, pc, meta: peerMeta };
    peers.set(id, entry);
    stats.connected++;
    const drop = () => { if (peers.get(id) === entry) { peers.delete(id); event('peer-left', { id }); } };
    channel.addEventListener?.('close', drop);
    pc?.addEventListener?.('connectionstatechange', () => { if (['failed', 'closed'].includes(pc.connectionState)) drop(); });
    event('peer', { id, meta: peerMeta });
    try { onPeer?.(entry); } catch { /* the listener's problem */ }
  }

  async function connect(id) {
    const p = known.get(id);
    const offer = await createOffer({ iceServers, RTC, gatherMs });
    pending.set(id, { offer, at: Date.now() });
    try {
      await post('offer', { code: offer.code, meta }, { id: p.idBytes, ecdhPub: p.ecdhPub });
    } catch (err) {
      try { offer.pc.close(); } catch { /* closed */ }
      pending.delete(id);
      cooldown.set(id, Date.now() + offerTimeoutMs);
      throw err;
    }
    stats.offers++;
    event('offered', { id });
  }

  async function handle(m) {
    let e;
    try { e = await openEnvelope(m.bytes, { identity, topic, domain: board.domain, now: now() }); } catch (err) {
      if (!/addressed to another peer/.test(err.message)) { stats.rejected++; event('rejected', { why: err.message }); }
      return;
    }
    if (e.from === identity.idHex || seen.has(e.hash)) return;
    seen.add(e.hash);
    if (seen.size > 4096) seen.delete(seen.values().next().value);
    board.learn?.(e.from, m.via);
    if (e.kind === 'announce') {
      if (known.size >= 256 && !known.has(e.from)) return;
      const was = known.get(e.from);
      known.set(e.from, { idBytes: e.fromId, ecdhPub: e.ecdhPub, meta: e.body, expiresAt: e.expiresAt, seenAt: was?.seenAt ?? Date.now() });
      return;
    }
    const body = e.body ?? {};
    if (typeof body.code !== 'string' || body.code.length > 8000) return;
    if (e.kind === 'offer') {
      if (peers.has(e.from)) return;
      if (pending.has(e.from)) {
        if (identity.idHex < e.from) return; // both offered: ours wins
        try { pending.get(e.from).offer.pc.close(); } catch { /* closed */ }
        pending.delete(e.from);
      }
      if (incoming.has(e.from) || peers.size + incoming.size >= maxPeers || !want(body.meta ?? {})) return;
      if (peers.size + incoming.size + 1 >= maxPeers) for (const [id, p] of pending) { try { p.offer.pc.close(); } catch { /* closed */ } pending.delete(id); }
      known.set(e.from, { idBytes: e.fromId, ecdhPub: e.ecdhPub, meta: body.meta ?? {}, expiresAt: e.expiresAt, seenAt: known.get(e.from)?.seenAt ?? Date.now() });
      const a = await acceptOffer(body.code, { iceServers, RTC, gatherMs });
      await post('answer', { code: a.code, meta }, { id: e.fromId, ecdhPub: e.ecdhPub });
      stats.answers++;
      event('answered', { id: e.from });
      incoming.set(e.from, { pc: a.pc, at: Date.now() });
      a.channel.then((ch) => { if (incoming.get(e.from)?.pc === a.pc) { incoming.delete(e.from); addPeer(e.from, ch, a.pc, body.meta ?? {}); } else { try { a.pc.close(); } catch { /* closed */ } } }, () => incoming.delete(e.from));
      return;
    }
    if (e.kind === 'answer') {
      const p = pending.get(e.from);
      if (!p || p.answered) return;
      if (peers.size + incoming.size >= maxPeers) { try { p.offer.pc.close(); } catch { /* closed */ } pending.delete(e.from); return; }
      p.answered = true; // stays pending (and counted) until the channel opens or fails
      p.offer.accept(body.code).then(
        (ch) => { pending.delete(e.from); addPeer(e.from, ch, p.offer.pc, body.meta ?? known.get(e.from)?.meta ?? {}); },
        (err) => { pending.delete(e.from); event('failed', { id: e.from, why: err.message }); },
      );
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (now() > announcedUntil - ttl / 3) await announce();
      const msgs = await board.read(topic);
      for (const m of msgs) await handle(m).catch((err) => event('error', { why: err.message }));
      // stale offers and expired announces
      for (const [id, p] of incoming) if (Date.now() - p.at > offerTimeoutMs) { try { p.pc.close(); } catch { /* closed */ } incoming.delete(id); }
      for (const [id, p] of pending) if (Date.now() - p.at > offerTimeoutMs) { try { p.offer.pc.close(); } catch { /* closed */ } pending.delete(id); cooldown.set(id, Date.now() + 2 * offerTimeoutMs); event('timeout', { id }); }
      for (const [id, k] of known) if (k.expiresAt < now()) known.delete(id);
      // new connections
      for (const [id, k] of known) {
        if (peers.size + incoming.size + pending.size >= maxPeers || pending.size >= maxPending) break;
        if (peers.has(id) || pending.has(id) || !want(k.meta) || (cooldown.get(id) ?? 0) > Date.now()) continue;
        if (identity.idHex > id && Date.now() - k.seenAt < (graceMs ?? 3 * pollMs)) continue; // the lower id offers first: fewer posts, no glare
        await connect(id).catch((err) => event('error', { why: err.message }));
      }
    } catch (err) {
      event('error', { why: err.message });
    } finally { busy = false; }
  }

  return {
    get id() { return identity?.idHex ?? null; },
    peers, known, stats,
    async start() {
      identity ??= await createIdentity();
      await tick();
      timer = setInterval(tick, pollMs);
      timer.unref?.(); // Node: a forgotten swarm does not keep the process alive
      return this;
    },
    tick,
    stop() {
      clearInterval(timer); timer = null;
      for (const p of pending.values()) { try { p.offer.pc.close(); } catch { /* closed */ } }
      for (const p of peers.values()) { try { p.channel.close(); p.pc?.close(); } catch { /* closed */ } }
      for (const p of incoming.values()) { try { p.pc.close(); } catch { /* closed */ } }
      pending.clear(); peers.clear(); incoming.clear();
    },
  };
}
