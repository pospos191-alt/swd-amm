// ZETAPHY's crypto precompiles in JS, for the in-memory EVM (createChain(..., { precompiles })):
//   0x…0900  ML-DSA (FIPS 204) verify, the same input as the chain's precompile
//            (variant ‖ 32-byte message ‖ public key ‖ signature -> uint256(1) or empty),
//            checked with @noble/post-quantum, so tests sign with real ML-DSA-44 keys;
//   0x…0100  P-256 verify (RIP-7212, cosmos/evm's p256 precompile:
//            hash ‖ r ‖ s ‖ x ‖ y -> uint256(1) or empty), a plain BigInt implementation.
// Plus a WebAuthn "authenticator" (passkey) that signs assertions like a browser would.
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { ml_dsa44, ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { hexlify, getBytes, keccak256, randomBytes } from 'ethers';

export const MLDSA = '0x0000000000000000000000000000000000000900';
export const P256 = '0x0000000000000000000000000000000000000100';
const ONE = new Uint8Array(32); ONE[31] = 1;

export function mldsaPrecompile(input) {
  if (input.length < 33) return null;
  const variant = input[0];
  const msg = input.subarray(1, 33);
  const rest = input.subarray(33);
  const [alg, pkLen] = variant === 44 ? [ml_dsa44, 1312] : variant === 65 ? [ml_dsa65, 1952] : [null, 0];
  if (!alg || rest.length !== pkLen + alg.lengths.signature) return null;
  try { return alg.verify(rest.subarray(pkLen), msg, rest.subarray(0, pkLen)) ? ONE : null; } catch { return null; }
}

// ---------------------------------------------------------------- P-256
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const G = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n];
const mod = (a, m) => ((a % m) + m) % m;
function inv(a, m) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0, m);
}
function add(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  let l;
  if (x1 === x2) {
    if (mod(y1 + y2, P) === 0n) return null;
    l = mod((3n * x1 * x1 + A) * inv(2n * y1, P), P);
  } else l = mod((y2 - y1) * inv(x2 - x1, P), P);
  const x3 = mod(l * l - x1 - x2, P);
  return [x3, mod(l * (x1 - x3) - y1, P)];
}
function mul(k, pt) {
  let r = null, q = pt;
  for (; k > 0n; k >>= 1n) { if (k & 1n) r = add(r, q); q = add(q, q); }
  return r;
}
const onCurve = ([x, y]) => x < P && y < P && mod(y * y - (x * x * x + A * x + B), P) === 0n;
const big = (b) => BigInt(hexlify(b));

export function p256Precompile(input) {
  if (input.length !== 160) return null;
  const [h, r, s, x, y] = [0, 1, 2, 3, 4].map((i) => big(input.subarray(32 * i, 32 * i + 32)));
  if (r <= 0n || r >= N || s <= 0n || s >= N || !onCurve([x, y])) return null;
  const w = inv(s, N);
  const X = add(mul(mod(h * w, N), G), mul(mod(r * w, N), [x, y]));
  return X && mod(X[0], N) === r ? ONE : null;
}

export const PRECOMPILES = { [MLDSA]: mldsaPrecompile, [P256]: p256Precompile };

// ---------------------------------------------------------------- keys for tests
/** A real ML-DSA-44 key: { publicKey, keyHash, sign(digest) }. */
export function mldsaKey(seed = randomBytes(32)) {
  const { publicKey, secretKey } = ml_dsa44.keygen(getBytes(seed));
  return { publicKey: hexlify(publicKey), keyHash: keccak256(publicKey), sign: (d) => hexlify(ml_dsa44.sign(getBytes(d), secretKey)) };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const sha256 = (b) => createHash('sha256').update(b).digest();

/**
 * A passkey on a test authenticator: x, y (uint256 as bigint) and
 * assert(challengeHex, {rpId, flags, type}) -> the Assertion tuple
 * [authenticatorData, clientDataJSON, r, s] as hex / bigint, exactly what a browser returns.
 */
export function passkey(rpId = 'app.sawasdeecoin.com') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = BigInt('0x' + Buffer.from(jwk.x, 'base64url').toString('hex'));
  const y = BigInt('0x' + Buffer.from(jwk.y, 'base64url').toString('hex'));
  return {
    x, y, rpIdHash: hexlify(sha256(rpId)),
    assert(challengeHex, { rp = rpId, flags = 0x05, type = 'webauthn.get', origin = `https://${rpId}`, extra = '' } = {}) {
      const authData = Buffer.concat([sha256(rp), Buffer.from([flags]), Buffer.from([0, 0, 0, 0])]);
      const client = Buffer.from(`{"type":"${type}","challenge":"${b64url(getBytes(challengeHex))}","origin":"${origin}","crossOrigin":false${extra}}`);
      const sig = nodeSign('sha256', Buffer.concat([authData, sha256(client)]), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return [hexlify(authData), hexlify(client), BigInt(hexlify(sig.subarray(0, 32))), BigInt(hexlify(sig.subarray(32)))];
    },
  };
}
