// Automatic peer discovery (docs/future/browser-ai.md item 2): signed, encrypted,
// short-lived signal envelopes; the SignalBoard contract as a board (real
// contract on an in-memory chain, real signed transactions from the browser's
// throwaway session key, the testnet faucet); a WebTorrent-tracker board against
// a fake tracker; and swarms that find each other and connect with no codes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { LegacyTransaction } from '@ethereumjs/tx';
import { Common } from '@ethereumjs/common';
import { hexToBytes, privateToAddress, bytesToHex } from '@ethereumjs/util';
import { createIdentity, sealEnvelope, openEnvelope, topicFor, hex, MAX_ENVELOPE } from '../ai/browser/signal.js';
import { memoryHub, chainBoard, trackerBoard, postCalldata, decodeSignalLog, SIGNAL_EVENT } from '../ai/browser/boards.js';
import { createSwarm } from '../ai/browser/discovery.js';
import { signLegacyTx, addressOf, sessionWallet, signHash } from '../ai/browser/evmtx.js';
import { servePeer, peerSource, rpcChannel } from '../ai/browser/p2p.js';
import { loadVerified } from '../ai/browser/loader.js';
import { buildManifest } from '../ai/browser/manifest.js';
import { memoryStore } from '../ai/browser/stores.js';
import { createSignalDevnet } from './helpers/signal-devnet.js';
import { fakeRTC } from './helpers/fake-rtc.js';

const NOW = () => Math.floor(Date.now() / 1000);
const DOMAIN = 'evm:77390:0x00000000000000000000000000000000000000aa';
const until = async (cond, ms = 5000, what = 'condition') => {
  const t0 = Date.now();
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};

test('envelopes: an announce is signed and public; an offer opens only for its recipient; tampering, another board, another topic and expiry are refused', async () => {
  const [a, b, c] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
  const topic = await topicFor('chunks', '0x' + 'ab'.repeat(32));
  assert.notEqual(hex(topic), hex(await topicFor('stage', '0x' + 'ab'.repeat(32))));
  const ann = await sealEnvelope(a, { kind: 'announce', topic, expiresAt: NOW() + 300, body: { role: 'seed' }, domain: DOMAIN });
  const o = await openEnvelope(ann, { topic, domain: DOMAIN });
  assert.deepEqual([o.kind, o.from, o.to, o.body], ['announce', a.idHex, null, { role: 'seed' }]);
  assert.ok(ann.length < 400, `announce is small (${ann.length} bytes)`);

  const sdp = { code: 'ZP1.' + 'x'.repeat(700), meta: { role: 'leech' } };
  const off = await sealEnvelope(a, { kind: 'offer', topic, expiresAt: NOW() + 60, body: sdp, recipient: { id: b.id, ecdhPub: b.ecdhPub }, domain: DOMAIN });
  assert.ok(off.length <= MAX_ENVELOPE);
  assert.equal(new TextDecoder().decode(off).includes('xxxx'), false, 'the SDP is not readable on the board');
  const got = await openEnvelope(off, { identity: b, topic, domain: DOMAIN });
  assert.deepEqual([got.kind, got.from, got.to, got.body], ['offer', a.idHex, b.idHex, sdp]);
  await assert.rejects(openEnvelope(off, { identity: c, topic, domain: DOMAIN }), /addressed to another peer/);
  await assert.rejects(openEnvelope(off, { topic, domain: DOMAIN }), /no identity/);

  // every byte is covered: flip one anywhere -> refused
  for (const i of [0, 3, 10, 40, 55, 70, 130, 195, 203, 210, off.length - 70, off.length - 1]) {
    const bad = off.slice(); bad[i] ^= 1;
    await assert.rejects(openEnvelope(bad, { identity: b, topic, domain: DOMAIN }), undefined, `byte ${i}`);
  }
  await assert.rejects(openEnvelope(off, { identity: b, topic, domain: 'evm:77390:0x' + 'bb'.repeat(20) }), /bad signature/);
  await assert.rejects(openEnvelope(off, { identity: b, topic: await topicFor('chunks', '0x' + 'cd'.repeat(32)), domain: DOMAIN }), /other topic/);
  await assert.rejects(openEnvelope(ann, { topic, domain: DOMAIN, now: NOW() + 1000 }), /expired/);
  const far = await sealEnvelope(a, { kind: 'announce', topic, expiresAt: NOW() + 5000, domain: DOMAIN });
  await assert.rejects(openEnvelope(far, { topic, domain: DOMAIN }), /too far/);
  // a forged sender: someone else's key in the envelope, signed by another key
  const forged = ann.slice(); forged.set(c.idPub, 60);
  await assert.rejects(openEnvelope(forged, { topic, domain: DOMAIN }), /bad signature/);
  await assert.rejects(sealEnvelope(a, { kind: 'offer', topic, expiresAt: NOW() + 60, body: { code: 'z'.repeat(9000) + Math.random() }, recipient: b, domain: DOMAIN }).then((e) => e.length > MAX_ENVELOPE || Promise.reject(new Error('too large'))), /too large/);
});

test('session key: transactions verify with @ethereumjs/tx; RFC 6979 is deterministic; the key is kept and never exposed', async () => {
  const common = Common.custom({ chainId: 77390 });
  for (let i = 0; i < 4; i++) {
    const priv = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const tx = { nonce: i, gasPrice: 10n ** 9n, gas: 90000n, to: '0x' + 'ab'.repeat(20), value: 0, data: '0x' + 'cd'.repeat(i * 40), chainId: 77390 };
    const s = await signLegacyTx(tx, priv);
    const t = LegacyTransaction.fromSerializedTx(hexToBytes(s.raw), { common });
    assert.ok(t.verifySignature());
    assert.equal(t.getSenderAddress().toString(), addressOf(priv));
    assert.equal(bytesToHex(privateToAddress(priv)), addressOf(priv));
    assert.equal(bytesToHex(t.hash()), s.hash);
    assert.deepEqual(await signHash(new Uint8Array(32).fill(i + 1), priv), await signHash(new Uint8Array(32).fill(i + 1), priv));
  }
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const w1 = sessionWallet({ storage });
  const w2 = sessionWallet({ storage });
  assert.equal(w1.address, w2.address, 'kept across page loads');
  assert.deepEqual(Object.keys(w1).sort(), ['address', 'signTx']);
});

async function chainSetup(opts = {}) {
  const net = await createSignalDevnet(opts);
  const mem = new Map();
  const wallet = sessionWallet({ storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) } });
  const board = chainBoard({ rpc: net, chainId: 77390, address: net.board, wallet });
  return { net, wallet, board };
}

test('SignalBoard on chain: post and look up by topic; the faucet pays the session key once; bounds and rate limit are the contract\'s', async () => {
  const { net, wallet, board } = await chainSetup();
  const id = await createIdentity();
  const topic = await topicFor('chunks', 'ab'.repeat(32));
  const other = await topicFor('chunks', 'cd'.repeat(32));
  assert.equal(board.domain, `evm:77390:${net.board.toLowerCase()}`);
  assert.deepEqual(await board.read(topic), []);
  const env = await sealEnvelope(id, { kind: 'announce', topic, expiresAt: NOW() + 300, body: { role: 'seed' }, domain: board.domain });
  await board.post({ topic, to: null, expiresAt: NOW() + 300, bytes: env });
  assert.equal(board.stats.faucet, 1, 'the empty session key asked the faucet once');
  const env2 = await sealEnvelope(id, { kind: 'announce', topic: other, expiresAt: NOW() + 300, domain: board.domain });
  await board.post({ topic: other, to: null, expiresAt: NOW() + 300, bytes: env2 });
  assert.equal(board.stats.faucet, 1);
  // a reader (no wallet) sees only its topic, envelope intact and verifiable
  const reader = chainBoard({ rpc: net, chainId: 77390, address: net.board });
  const msgs = await reader.read(topic);
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0].bytes, env);
  assert.equal(msgs[0].via, wallet.address);
  assert.equal((await openEnvelope(msgs[0].bytes, { topic, domain: reader.domain })).from, id.idHex);
  assert.deepEqual(await reader.read(topic), [], 'the next read only returns newer posts');
  await assert.rejects(reader.post({ topic, to: null, expiresAt: NOW() + 60, bytes: env }), /read-only/);
  // the contract's bounds (estimateGas reverts, so nothing is sent)
  const sent = net.sent.length;
  await assert.rejects(board.post({ topic, to: null, expiresAt: NOW() - 1, bytes: env }), /BadExpiry/);
  await assert.rejects(board.post({ topic, to: null, expiresAt: NOW() + 601 + 5, bytes: env }), /BadExpiry/);
  await assert.rejects(board.post({ topic, to: null, expiresAt: NOW() + 60, bytes: new Uint8Array(2049) }), /PayloadSize/);
  await assert.rejects(board.post({ topic: new Uint8Array(32), to: null, expiresAt: NOW() + 60, bytes: env }), /NoTopic/);
  assert.equal(net.sent.length, sent);
  // rate limit: 12 per 60 s per sender (2 used above), then a new window
  for (let i = 0; i < 10; i++) await board.post({ topic, to: null, expiresAt: NOW() + 60, bytes: env });
  await assert.rejects(board.post({ topic, to: null, expiresAt: NOW() + 60, bytes: env }), /RateLimited/);
  net.advance(61);
  await board.post({ topic, to: null, expiresAt: NOW() + 120, bytes: env });
  // gas: what one post costs on the testnet (about 0.00004 ZETAPHY at 1 gwei for a 1 KB offer)
  const big = net.sent.at(-1);
  assert.ok(big.ok && big.gasUsed < 80_000n, `gas ${big.gasUsed}`);
});

test('chain board: logs whose indexed fields disagree with the envelope are skipped; calldata and log decoding match the ABI', async () => {
  const { net, wallet, board } = await chainSetup();
  const id = await createIdentity();
  const topic = await topicFor('stage', 'ee'.repeat(32));
  const env = await sealEnvelope(id, { kind: 'announce', topic, expiresAt: NOW() + 200, domain: board.domain });
  // posted under the right topic but claiming another expiry than the envelope's: skipped by readers
  await board.post({ topic, to: null, expiresAt: NOW() + 100, bytes: env });
  await board.post({ topic, to: null, expiresAt: NOW() + 200, bytes: env });
  const r = chainBoard({ rpc: net, chainId: 77390, address: net.board });
  const got = await r.read(topic);
  assert.equal(got.length, 1);
  const logs = await net.call('eth_getLogs', [{ address: net.board, topics: [SIGNAL_EVENT] }]);
  assert.equal(logs.length, 2);
  const d = decodeSignalLog(logs[1]);
  assert.deepEqual(d.bytes, env);
  assert.equal(d.from, wallet.address);
  assert.match(postCalldata({ topic, to: null, expiresAt: 5, bytes: Uint8Array.of(1, 2) }), /^0x[0-9a-f]{8}/);
  // a board on another chain id is refused by the RPC check
  const wrong = chainBoard({ rpc: [ 'https://x.invalid' ], chainId: 1, address: net.board, fetchImpl: async () => ({ json: async () => ({ result: '0x12e4e' }) }) });
  await assert.rejects(wrong.read(topic), /serves chain 77390, not 1/);
});

const live = [];
after(() => { for (const s of live) s.stop(); });

async function swarmPair(boardOf, extra = {}) {
  const RTC = fakeRTC();
  const topic = await topicFor('chunks', '77'.repeat(32));
  const got = { a: [], b: [] };
  const a = createSwarm({ board: boardOf('a'), topic, RTC, meta: { role: 'seed' }, pollMs: 50, onPeer: (p) => got.a.push(p), ...extra });
  const b = createSwarm({ board: boardOf('b'), topic, RTC, meta: { role: 'leech' }, pollMs: 50, onPeer: (p) => got.b.push(p), ...extra });
  live.push(a, b);
  await a.start(); await b.start();
  await until(() => got.a.length && got.b.length, 30000, 'both peers');
  return { a, b, got, topic };
}

test('discovery over a memory board: two browsers find each other and the model travels peer to peer, verified', async () => {
  const hub = memoryHub();
  const { a, b, got } = await swarmPair((n) => hub.board('memory'));
  assert.equal(got.a[0].id, b.id);
  assert.equal(got.b[0].id, a.id);
  assert.deepEqual(got.b[0].meta, { role: 'seed' });
  // chunks over the discovered channel, checked by the loader as from any mirror
  const data = globalThis.crypto.getRandomValues(new Uint8Array(5000));
  const { manifest, bytes, manifestHash } = await buildManifest(data, { kind: 'model', name: 't', version: 1, runtime: 'x', license: 'MIT', chunkSize: 1024 });
  const release = { status: 'active', manifestHash: '0x' + manifestHash, chunkRoot: '0x' + manifest.root, size: data.length, chunkSize: 1024 };
  const store = memoryStore();
  for (const [i, h] of manifest.chunks.entries()) await store.put(h, data.slice(i * 1024, (i + 1) * 1024));
  await store.put(`m-${manifestHash}`, bytes);
  const server = servePeer(got.a[0].channel, store, { maxBytesPerSecond: 50_000 });
  const t0 = Date.now();
  const out = await loadVerified({ release, peers: [peerSource(got.b[0].channel, 'found')] });
  assert.deepEqual(out.bytes, data);
  assert.equal(out.stats.peer, 5);
  assert.equal(server.bytesSent, 5000);
  assert.ok(Date.now() - t0 >= 60, 'the upload limit paced the answers');
  a.stop(); b.stop();
});

test('discovery limits: maxPeers is kept, offers glare resolves to one connection, a peer that is not wanted is not offered to', async () => {
  const hub = memoryHub();
  const RTC = fakeRTC();
  const topic = await topicFor('chunks', '88'.repeat(32));
  const swarms = [];
  const peersOf = new Map();
  for (let i = 0; i < 4; i++) {
    const s = createSwarm({ board: hub.board(), topic, RTC, pollMs: 30, maxPeers: 1, offerTimeoutMs: 300, meta: { n: i } });
    peersOf.set(s, []);
    swarms.push(s);
  }
  await Promise.all(swarms.map((s) => s.start()));
  await until(() => swarms.every((s) => s.peers.size === 1), 30000, 'everyone paired');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(swarms.every((s) => s.peers.size === 1), swarms.map((s) => s.peers.size).join(','));
  for (const s of swarms) s.stop();
  // want(): leechers only connect to seeders
  const hub2 = memoryHub();
  const l1 = createSwarm({ board: hub2.board(), topic, RTC, pollMs: 30, meta: { role: 'leech' }, want: (m) => m.role === 'seed' });
  const l2 = createSwarm({ board: hub2.board(), topic, RTC, pollMs: 30, meta: { role: 'leech' }, want: (m) => m.role === 'seed' });
  await l1.start(); await l2.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(l1.peers.size + l2.peers.size, 0);
  assert.equal(l1.stats.offers + l2.stats.offers, 0);
  l1.stop(); l2.stop();
});

test('discovery: forged, replayed and expired messages on the board are ignored', async () => {
  const hub = memoryHub();
  const RTC = fakeRTC();
  const topic = await topicFor('chunks', '99'.repeat(32));
  const evil = await createIdentity();
  const board = hub.board();
  const s = createSwarm({ board: hub.board(), topic, RTC, pollMs: 30 });
  await s.start();
  const old = await sealEnvelope(evil, { kind: 'announce', topic, expiresAt: NOW() - 500, domain: 'memory' });
  const forged = (await sealEnvelope(evil, { kind: 'announce', topic, expiresAt: NOW() + 200, domain: 'memory' })).slice();
  forged[forged.length - 5] ^= 1;
  const otherBoard = await sealEnvelope(evil, { kind: 'announce', topic, expiresAt: NOW() + 200, domain: 'tracker:wss://x' });
  for (const bytes of [old, forged, otherBoard, new Uint8Array(10)]) await board.post({ topic, to: null, expiresAt: NOW() + 100, bytes });
  await until(() => s.stats.rejected >= 4, 3000, 'rejections');
  assert.equal(s.known.size, 0);
  // a valid announce, posted twice (replay): one known peer, no double connection attempt
  const ok = await sealEnvelope(evil, { kind: 'announce', topic, expiresAt: NOW() + 200, domain: 'memory' });
  await board.post({ topic, to: null, expiresAt: NOW() + 100, bytes: ok });
  await board.post({ topic, to: null, expiresAt: NOW() + 100, bytes: ok });
  await until(() => s.stats.offers >= 1, 3000, 'an offer');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.known.size, 1);
  assert.equal(s.stats.offers, 1, 'one offer to the (silent) peer, not one per copy');
  s.stop();
});

test('discovery over the ZETAPHY chain board: two session keys, faucet, real SignalBoard logs, connected with no codes', async () => {
  const net = await createSignalDevnet();
  const boardOf = () => {
    const mem = new Map();
    return chainBoard({ rpc: net, chainId: 77390, address: net.board, wallet: sessionWallet({ storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) } }) });
  };
  const { a, b, got } = await swarmPair(boardOf, { graceMs: 10_000 }); // only the lower id offers: no glare
  // announce x2, offer, answer: 4 posts, each a real transaction
  assert.equal(net.sent.filter((t) => t.ok).length, 4);
  const rA = rpcChannel(got.a[0].channel, { 11: async (p) => p.map((x) => x + 1) });
  const rB = rpcChannel(got.b[0].channel);
  assert.deepEqual([...(await rB.request(11, Uint8Array.of(1, 2, 3)))], [2, 3, 4]);
  rA.close(); rB.close();
  a.stop(); b.stop();
});

/** A WebTorrent tracker in memory (the announce / offer / answer forwarding of bittorrent-tracker's WebSocket server). */
function fakeTracker() {
  const swarms = new Map(); // info_hash -> Map(peer_id -> socket)
  const log = [];
  class WS {
    constructor(url) { this.url = url; setTimeout(() => this.onopen?.(), 0); }
    send(s) {
      const m = JSON.parse(s);
      log.push(m);
      const sw = swarms.get(m.info_hash) ?? new Map();
      swarms.set(m.info_hash, sw);
      sw.set(m.peer_id, this);
      const deliver = (to, o) => setTimeout(() => to.onmessage?.({ data: JSON.stringify(o) }), 0);
      if (m.answer) { const to = sw.get(m.to_peer_id); if (to) deliver(to, { action: 'announce', info_hash: m.info_hash, peer_id: m.peer_id, answer: m.answer, offer_id: m.offer_id }); return; }
      const others = [...sw.entries()].filter(([id]) => id !== m.peer_id).slice(0, m.numwant ?? 0);
      for (const [i, o] of (m.offers ?? []).entries()) if (others[i]) deliver(others[i][1], { action: 'announce', info_hash: m.info_hash, peer_id: m.peer_id, offer: o.offer, offer_id: o.offer_id });
    }
    close() {}
  }
  return { WS, log };
}

test('discovery over a WebTorrent tracker (optional, swappable): same envelopes, the tracker only forwards', async () => {
  const t = fakeTracker();
  const { a, b, got } = await swarmPair(() => trackerBoard({ url: 'wss://tracker.example', WebSocketImpl: t.WS }), { ttl: 31 });
  assert.equal(got.a.length, 1);
  assert.ok(t.log.some((m) => m.answer), 'one-to-one messages went as tracker answers');
  assert.ok(t.log.every((m) => !JSON.stringify(m).includes('v=0 fake')), 'the tracker never saw an SDP in clear');
  assert.throws(() => trackerBoard({ url: 'http://tracker.example' }), /wss/);
  a.stop(); b.stop();
});
