// A throwaway "session wallet" that can sign exactly one kind of thing: a
// legacy (EIP-155) transaction calling SignalBoard.post on the ZETAPHY testnet,
// paid with free faucet coins. No dependency: secp256k1 in BigInt, RFC 6979
// deterministic nonces (HMAC-SHA256 from WebCrypto), RLP, keccak from src/keccak.js.
//
// Said plainly: this code is NOT constant-time and is not a wallet. The key is
// random, made in this browser for signaling only, kept in this browser's
// storage, never shown, and holds testnet coins worth nothing. Never send real
// funds to it, never import it anywhere. Tests cross-check every signature with
// @ethereumjs/tx (test/signal.test.js).

import { keccak256 } from '../../src/keccak.js';

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function inv(a, m = P) {
  let [lo, hi, x0, x1] = [mod(a, m), m, 1n, 0n];
  while (lo > 1n) { const q = hi / lo; [lo, hi] = [hi - q * lo, lo]; [x0, x1] = [x1 - q * x0, x0]; }
  return mod(x0, m);
}
// Jacobian points [X, Y, Z]; Z = 0 is infinity
function dbl([X, Y, Z]) {
  if (Z === 0n || Y === 0n) return [0n, 1n, 0n];
  const S = mod(4n * X * Y * Y), M = mod(3n * X * X);
  const X3 = mod(M * M - 2n * S);
  return [X3, mod(M * (S - X3) - 8n * Y * Y * Y * Y), mod(2n * Y * Z)];
}
function add(p, q) {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const Z1Z1 = mod(p[2] * p[2]), Z2Z2 = mod(q[2] * q[2]);
  const U1 = mod(p[0] * Z2Z2), U2 = mod(q[0] * Z1Z1);
  const S1 = mod(p[1] * q[2] * Z2Z2), S2 = mod(q[1] * p[2] * Z1Z1);
  if (U1 === U2) return S1 === S2 ? dbl(p) : [0n, 1n, 0n];
  const H = mod(U2 - U1), R = mod(S2 - S1);
  const H2 = mod(H * H), H3 = mod(H2 * H);
  const X3 = mod(R * R - H3 - 2n * U1 * H2);
  return [X3, mod(R * (U1 * H2 - X3) - S1 * H3), mod(H * p[2] * q[2])];
}
function mul(k, pt = [GX, GY, 1n]) {
  let r = [0n, 1n, 0n];
  for (let b = BigInt(k.toString(2).length) - 1n; b >= 0n; b--) {
    r = dbl(r);
    if ((k >> b) & 1n) r = add(r, pt);
  }
  return r;
}
function affine([X, Y, Z]) {
  const zi = inv(Z), zi2 = mod(zi * zi);
  return [mod(X * zi2), mod(Y * zi2 * zi)];
}

const big = (b) => BigInt('0x' + (Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') || '0'));
const bytes32 = (n) => { const h = n.toString(16).padStart(64, '0'); return Uint8Array.from({ length: 32 }, (_, i) => parseInt(h.slice(2 * i, 2 * i + 2), 16)); };
const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

/** Uncompressed public key (65 bytes) of a 32-byte private key. */
export function publicKeyOf(priv) {
  const d = big(priv);
  if (d <= 0n || d >= N) throw new Error('bad private key');
  const [x, y] = affine(mul(d));
  return cat(Uint8Array.of(4), bytes32(x), bytes32(y));
}

/** 0x-address (lower case) of a private key. */
export const addressOf = (priv) => hex(keccak256(publicKeyOf(priv).subarray(1)).subarray(12));

async function hmac(key, ...msg) {
  const k = await globalThis.crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, cat(...msg)));
}

/** ECDSA over a 32-byte hash, RFC 6979 nonce, low s. Returns {r, s, recovery}. */
export async function signHash(hash, priv) {
  const d = big(priv), z = mod(big(hash), N);
  // RFC 6979 section 3.2 (qlen = hlen = 256)
  let V = new Uint8Array(32).fill(1), K = new Uint8Array(32);
  const x = bytes32(d), h1 = bytes32(z);
  K = await hmac(K, V, Uint8Array.of(0), x, h1); V = await hmac(K, V);
  K = await hmac(K, V, Uint8Array.of(1), x, h1); V = await hmac(K, V);
  for (;;) {
    V = await hmac(K, V);
    const k = big(V);
    if (k > 0n && k < N) {
      const [rx, ry] = affine(mul(k));
      const r = mod(rx, N);
      if (r !== 0n) {
        let s = mod(inv(k, N) * (z + r * d), N);
        let recovery = Number(ry & 1n) | (rx >= N ? 2 : 0);
        if (s > N / 2n) { s = N - s; recovery ^= 1; }
        if (s !== 0n) return { r, s, recovery };
      }
    }
    K = await hmac(K, V, Uint8Array.of(0)); V = await hmac(K, V);
  }
}

// ---- RLP ----
function rlpBytes(b) {
  if (b.length === 1 && b[0] < 0x80) return b;
  return cat(rlpLen(b.length, 0x80), b);
}
function rlpLen(n, off) {
  if (n < 56) return Uint8Array.of(off + n);
  const l = []; for (let x = n; x > 0; x = Math.floor(x / 256)) l.unshift(x & 255);
  return Uint8Array.of(off + 55 + l.length, ...l);
}
const rlpList = (items) => { const body = cat(...items); return cat(rlpLen(body.length, 0xc0), body); };
const intBytes = (n) => { n = BigInt(n); if (n === 0n) return new Uint8Array(); const h = n.toString(16); return Uint8Array.from({ length: Math.ceil(h.length / 2) }, (_, i) => parseInt(h.padStart(Math.ceil(h.length / 2) * 2, '0').slice(2 * i, 2 * i + 2), 16)); };
const hexBytes = (h) => { const s = String(h).replace(/^0x/, ''); return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16)); };

/** Signed legacy EIP-155 transaction (0x… raw) and its hash. tx: {nonce, gasPrice, gas, to, value, data, chainId}. */
export async function signLegacyTx(tx, priv) {
  const fields = [intBytes(tx.nonce), intBytes(tx.gasPrice), intBytes(tx.gas), hexBytes(tx.to), intBytes(tx.value ?? 0), hexBytes(tx.data ?? '0x')];
  const unsigned = rlpList([...fields, intBytes(tx.chainId), new Uint8Array(), new Uint8Array()].map(rlpBytes));
  const { r, s, recovery } = await signHash(keccak256(unsigned), priv);
  const v = BigInt(tx.chainId) * 2n + 35n + BigInt(recovery & 1);
  const raw = rlpList([...fields, intBytes(v), intBytes(r), intBytes(s)].map(rlpBytes));
  return { raw: hex(raw), hash: hex(keccak256(raw)) };
}

/**
 * The session wallet: a random key kept in `storage` (localStorage-like, optional) under `name`.
 * Returns {address, signTx(tx)}; never exposes the key.
 */
export function sessionWallet({ storage = null, name = 'zetaphy-signal-session-key' } = {}) {
  let priv = null;
  try { const h = storage?.getItem(name); if (h && /^[0-9a-f]{64}$/.test(h)) priv = hexBytes(h); } catch { priv = null; }
  if (!priv) {
    do { priv = globalThis.crypto.getRandomValues(new Uint8Array(32)); } while (big(priv) === 0n || big(priv) >= N);
    try { storage?.setItem(name, Array.from(priv, (x) => x.toString(16).padStart(2, '0')).join('')); } catch { /* blocked: this page only */ }
  }
  const address = addressOf(priv);
  return { address, signTx: (tx) => signLegacyTx(tx, priv) };
}
