// Signed, short-lived, encrypted signaling messages ("envelopes") that let two
// browsers set up a WebRTC connection through any untrusted board: the ZETAPHY
// chain (SignalBoard contract, ai/browser/boards.js chainBoard), a public
// WebTorrent tracker (trackerBoard, off by default) or memory (tests).
//
// Only WebCrypto (no dependency): ECDSA P-256 signs every envelope with a
// per-session identity key; ECDH P-256 + HKDF-SHA256 + AES-256-GCM encrypts the
// offer/answer (the SDP, which holds IP addresses) to the one recipient. The
// session keys live only in memory and are dropped when the page closes, so a
// log that stays on chain forever cannot be decrypted later from this side.
//
// Envelope bytes (all big-endian):
//   0  "ZS" | 2 version=1 | 3 kind (1 announce, 2 offer, 3 answer)
//   4  topic (32)        what it is about (topicFor: purpose + model hash)
//   36 to (16)           recipient peer id, zeros = everyone on the topic
//   52 expiresAt (u64)   unix seconds; readers drop it after that
//   60 idPub (65)        sender's ECDSA P-256 public key (raw); peer id = sha256(idPub)[0..16)
//   125 ecdhPub (65)     sender's ECDH P-256 public key (raw)
//   190 nonce (12)       AES-GCM IV (random)
//   202 bodyLen (u16)
//   204 body             announce: JSON meta (public); offer/answer: AES-GCM(JSON {code, meta})
//   … sig (64)           ECDSA P-256 / SHA-256 (r‖s) over "zetaphy-signal/1" ‖ domain ‖ everything before
// The domain names the board (chain id + contract address, or the tracker URL),
// so an envelope cannot be replayed onto another board.

export const SIGNAL_VERSION = 1;
export const KIND = { announce: 1, offer: 2, answer: 3 };
export const KIND_NAME = { 1: 'announce', 2: 'offer', 3: 'answer' };
export const MAX_TTL = 600;          // seconds (same as SignalBoard.MAX_TTL)
export const MAX_ENVELOPE = 2048;    // bytes (same as SignalBoard.MAX_PAYLOAD)
export const CLOCK_SKEW = 120;       // seconds of clock difference tolerated
const HDR = 204;
const SIG = 64;
const PREFIX = new TextEncoder().encode('zetaphy-signal/1');
const subtle = () => globalThis.crypto.subtle;

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function unhex(h) {
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex');
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
}
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async (b) => new Uint8Array(await subtle().digest('SHA-256', b));

/** The 32-byte topic for a purpose ("chunks", "stage", …) and a model/manifest hash. */
export async function topicFor(purpose, hash) {
  if (!/^[a-z0-9-]{1,32}$/.test(purpose)) throw new Error('bad purpose');
  return sha256(new TextEncoder().encode(`zetaphy-signal/1|${purpose}|${String(hash).toLowerCase().replace(/^0x/, '')}`));
}

/** Peer id (16 bytes) of an identity public key. */
export const peerIdOf = async (idPub) => (await sha256(idPub)).subarray(0, 16);

/** A fresh session identity: signing key + key-agreement key, both P-256, private halves not extractable. */
export async function createIdentity() {
  const sig = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const dh = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const idPub = new Uint8Array(await subtle().exportKey('raw', sig.publicKey));
  const ecdhPub = new Uint8Array(await subtle().exportKey('raw', dh.publicKey));
  const id = await peerIdOf(idPub);
  return {
    idPub, ecdhPub, id, idHex: hex(id),
    sign: async (bytes) => new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, sig.privateKey, bytes)),
    /** AES-GCM key shared with the holder of theirEcdhPub, bound to a context (salt, info). */
    async sharedKey(theirEcdhPub, salt, info) {
      const pub = await subtle().importKey('raw', theirEcdhPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const bits = await subtle().deriveBits({ name: 'ECDH', public: pub }, dh.privateKey, 256);
      const ikm = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    },
  };
}

const ZERO16 = new Uint8Array(16);
const ctxInfo = (kind, from, to) => cat(PREFIX, Uint8Array.of(kind), from, to);

async function compress(bytes) {
  if (!globalThis.CompressionStream) return cat(Uint8Array.of(0), bytes);
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return cat(Uint8Array.of(1), new Uint8Array(await new Response(s).arrayBuffer()));
}
async function decompress(bytes) {
  if (bytes[0] === 0) return bytes.subarray(1);
  if (bytes[0] !== 1) throw new Error('bad body encoding');
  const s = new Blob([bytes.subarray(1)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(s).arrayBuffer());
  if (out.length > 16384) throw new Error('body too large');
  return out;
}

/**
 * Builds a signed envelope. kind: 'announce' | 'offer' | 'answer'.
 * For offer/answer pass `recipient` {id (16 bytes), ecdhPub} and `body` (any JSON value): it is encrypted to them.
 * For announce, `body` is public JSON (keep it small: e.g. {role, layers}).
 */
export async function sealEnvelope(identity, { kind, topic, expiresAt, body = {}, recipient = null, domain }) {
  const k = KIND[kind];
  if (!k) throw new Error('bad kind');
  if (!(topic instanceof Uint8Array) || topic.length !== 32) throw new Error('bad topic');
  if (!domain) throw new Error('no domain');
  if (k !== KIND.announce && !recipient) throw new Error(`${kind} needs a recipient`);
  const to = recipient ? recipient.id : ZERO16;
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  let payload = await compress(new TextEncoder().encode(JSON.stringify(body)));
  const head = new Uint8Array(HDR);
  const v = new DataView(head.buffer);
  head.set([0x5a, 0x53, SIGNAL_VERSION, k]);
  head.set(topic, 4); head.set(to, 36);
  v.setBigUint64(52, BigInt(Math.floor(expiresAt)));
  head.set(identity.idPub, 60); head.set(identity.ecdhPub, 125); head.set(nonce, 190);
  if (k !== KIND.announce) {
    // the ciphertext length is known in advance (+16 tag), so the header can be authenticated as AAD
    v.setUint16(202, payload.length + 16);
    const key = await identity.sharedKey(recipient.ecdhPub, topic, ctxInfo(k, identity.id, to));
    payload = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: head }, key, payload));
  } else v.setUint16(202, payload.length);
  const unsigned = cat(head, payload);
  if (unsigned.length + SIG > MAX_ENVELOPE) throw new Error(`envelope too large (${unsigned.length + SIG} bytes)`);
  const sig = await identity.sign(cat(PREFIX, new TextEncoder().encode(domain), unsigned));
  return cat(unsigned, sig);
}

/**
 * Checks and opens an envelope. Throws on anything wrong: format, size, signature, topic,
 * expiry, recipient, decryption. Returns {kind, from (hex), fromId, idPub, ecdhPub, to (hex|null), expiresAt, body, hash}.
 * identity: needed to open offers/answers (they must be addressed to it).
 */
export async function openEnvelope(bytes, { identity = null, topic, domain, now = Math.floor(Date.now() / 1000) }) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HDR + SIG || bytes.length > MAX_ENVELOPE) throw new Error('bad envelope size');
  if (bytes[0] !== 0x5a || bytes[1] !== 0x53 || bytes[2] !== SIGNAL_VERSION) throw new Error('not a signal envelope');
  const k = bytes[3];
  if (!KIND_NAME[k]) throw new Error('bad kind');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = v.getUint16(202);
  if (HDR + len + SIG !== bytes.length) throw new Error('bad envelope length');
  const head = bytes.subarray(0, HDR);
  const t = bytes.subarray(4, 36);
  if (topic && hex(t) !== hex(topic)) throw new Error('other topic');
  const to = bytes.subarray(36, 52);
  const expiresAt = Number(v.getBigUint64(52));
  if (expiresAt < now - CLOCK_SKEW) throw new Error('expired');
  if (expiresAt > now + MAX_TTL + CLOCK_SKEW) throw new Error('expiry too far ahead');
  const idPub = bytes.slice(60, 125), ecdhPub = bytes.slice(125, 190), nonce = bytes.slice(190, 202);
  const pub = await subtle().importKey('raw', idPub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).catch(() => { throw new Error('bad sender key'); });
  const unsigned = bytes.subarray(0, HDR + len);
  const ok = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, bytes.subarray(HDR + len), cat(PREFIX, new TextEncoder().encode(domain), unsigned));
  if (!ok) throw new Error('bad signature');
  const fromId = await peerIdOf(idPub);
  const toHex = hex(to) === hex(ZERO16) ? null : hex(to);
  let payload = bytes.subarray(HDR, HDR + len);
  if (k !== KIND.announce) {
    if (!identity) throw new Error('cannot open: no identity');
    if (toHex !== identity.idHex) throw new Error('addressed to another peer');
    const key = await identity.sharedKey(ecdhPub, t, ctxInfo(k, fromId, to));
    try {
      payload = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: head }, key, payload));
    } catch { throw new Error('cannot decrypt'); }
  } else if (toHex) throw new Error('an announce has no recipient');
  const body = JSON.parse(new TextDecoder().decode(await decompress(payload)));
  return { kind: KIND_NAME[k], from: hex(fromId), fromId, idPub, ecdhPub, to: toHex, expiresAt, body, hash: hex(await sha256(bytes)) };
}

/** Peer id (hex) and expiry of an envelope without checking it (for boards that route by recipient). */
export function peekEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HDR + SIG) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { kind: KIND_NAME[bytes[3]], topic: bytes.slice(4, 36), to: bytes.slice(36, 52), expiresAt: Number(v.getBigUint64(52)) };
}
