// Neuro federated learning: the wire format of one update.
//
// The same bytes go to a runner (signed envelope) or on chain (commit-reveal in
// FederatedRounds). Big-endian:
//   "NFL1"            4 bytes  magic + version
//   headHash         32 bytes  sha256 of the head the update was computed on
//   round             u32
//   dim               u16
//   clip              u32      clip norm C x 1e6
//   z                 u32      noise multiplier x 1e3
//   values         dim x i32   each coordinate x 1e6, rounded, saturated
// Fixed point keeps the bytes (and so every hash and signature) identical on
// every platform.

const MAGIC = [0x4e, 0x46, 0x4c, 0x31]; // NFL1
export const HEADER = 4 + 32 + 4 + 2 + 4 + 4;
export const SCALE = 1e6;
const I32 = 2147483647;
export const MAX_DIM = 4096;

const hexToBytes = (hex) => {
  const h = hex.replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error('headHash must be 32 bytes hex');
  return Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
};
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * @param {{headHash:string, round:number, clip:number, z:number, values:ArrayLike<number>}} u
 * @returns {Uint8Array}
 */
export function encodeUpdate(u) {
  const dim = u.values.length;
  if (dim === 0 || dim > MAX_DIM) throw new Error('bad dim');
  if (!Number.isInteger(u.round) || u.round < 0 || u.round > 0xffffffff) throw new Error('bad round');
  const buf = new Uint8Array(HEADER + 4 * dim);
  const dv = new DataView(buf.buffer);
  buf.set(MAGIC, 0);
  buf.set(hexToBytes(u.headHash), 4);
  dv.setUint32(36, u.round);
  dv.setUint16(40, dim);
  dv.setUint32(42, Math.round(u.clip * 1e6));
  dv.setUint32(46, Math.round(u.z * 1e3));
  for (let i = 0; i < dim; i++) {
    const x = u.values[i];
    if (!Number.isFinite(x)) throw new Error('non-finite value');
    dv.setInt32(HEADER + 4 * i, Math.max(-I32, Math.min(I32, Math.round(x * SCALE))));
  }
  return buf;
}

/** Inverse of encodeUpdate; throws on anything malformed. */
export function decodeUpdate(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (b.length < HEADER || MAGIC.some((m, i) => b[i] !== m)) throw new Error('not a Neuro FL update');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dim = dv.getUint16(40);
  if (dim === 0 || dim > MAX_DIM || b.length !== HEADER + 4 * dim) throw new Error('bad update length');
  const values = new Float64Array(dim);
  for (let i = 0; i < dim; i++) values[i] = dv.getInt32(HEADER + 4 * i) / SCALE;
  return {
    headHash: bytesToHex(b.subarray(4, 36)),
    round: dv.getUint32(36),
    clip: dv.getUint32(42) / 1e6,
    z: dv.getUint32(46) / 1e3,
    values,
  };
}

/** The text a wallet signs (EIP-191 personal_sign) for an off-chain envelope. */
export const signText = (digestHex) => `Neuro federated update v1\nsha256:${digestHex}`;

export const toBase64 = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
