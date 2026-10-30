// Private identity (zero-knowledge), the pure part: identities, the Poseidon Merkle tree, the circuit input, the
// proof's calldata and the encrypted backup. No DOM, no network; WebCrypto only (browser and Node >= 20).
// Used by the Agents page card (zkid.js), its prover worker (zkid-worker.js), the circuit tooling
// (zetaphy-network/zkid/) and the contract tests (zetaphy-network/test/zkid.test.js). docs/future/zk-identity.md.
//
//   identity      { secret, nullifierKey }: two random field elements; never leave this browser unencrypted
//   commitment    C = Poseidon(secret, nullifierKey)           (what ZkIdentityRegistry.register takes)
//   leaf          Poseidon(C, level)                            (level 1 passkey human, 2 vouched unique)
//   nullifier     Poseidon(nullifierKey, scope)                 (one per person per scope)
import { F, poseidon2 } from './zkid-poseidon.js';

export { F, poseidon2 };
export const DEPTH = 20;
export const LEVELS = [1, 2];

const strip = (h) => String(h).replace(/^0x/, '');
export const toHex32 = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;

/** A uniformly random field element (31 random bytes: below 2^248 < F). */
export function randomField(rand = (b) => globalThis.crypto.getRandomValues(b)) {
  const b = rand(new Uint8Array(31));
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

export const newIdentity = (rand) => ({ secret: randomField(rand), nullifierKey: randomField(rand) });
export const commitment = (id) => poseidon2(id.secret, id.nullifierKey);
export const leafOf = (c, level) => poseidon2(c, BigInt(level));
export const nullifierOf = (id, scope) => poseidon2(id.nullifierKey, BigInt(scope));

/** Checks and normalizes an identity (hex or decimal strings or BigInts). Throws on anything else. */
export function parseIdentity(o) {
  const f = (v) => {
    if (!(typeof v === 'bigint' || (typeof v === 'string' && /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v)))) throw new Error('identity: not a field element');
    const n = BigInt(v);
    if (n <= 0n || n >= F) throw new Error('identity: not a field element');
    return n;
  };
  if (!o || typeof o !== 'object') throw new Error('identity: missing');
  return { secret: f(o.secret), nullifierKey: f(o.nullifierKey) };
}
export const identityJson = (id) => ({ v: 1, secret: toHex32(id.secret), nullifierKey: toHex32(id.nullifierKey) });

// ---------------------------------------------------------------- Merkle tree (as ZkIdentityRegistry)
let zeroCache = null;
/** zeros[i] = the root of an empty subtree of height i (zeros[0] = 0, an empty or removed leaf). */
export function zeros() {
  if (!zeroCache) {
    zeroCache = [0n];
    for (let i = 1; i <= DEPTH; i++) zeroCache.push(poseidon2(zeroCache[i - 1], zeroCache[i - 1]));
  }
  return zeroCache;
}

/** The tree over `leaves` (index order, 0 = empty), padded with empty subtrees to DEPTH. { layers, root } */
export function buildTree(leaves) {
  const z = zeros();
  if (leaves.length > 2 ** DEPTH) throw new Error('tree full');
  const layers = [leaves.map(BigInt)];
  for (let h = 0; h < DEPTH; h++) {
    const cur = layers[h];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(poseidon2(cur[i], i + 1 < cur.length ? cur[i + 1] : z[h]));
    layers.push(next);
  }
  return { layers, root: layers[DEPTH][0] ?? z[DEPTH] };
}

/** Siblings and left/right bits of leaf `index`. */
export function merklePath(tree, index) {
  const z = zeros();
  const pathElements = [];
  const pathIndices = [];
  let i = index;
  for (let h = 0; h < DEPTH; h++) {
    const sib = i ^ 1;
    pathElements.push(tree.layers[h][sib] ?? z[h]);
    pathIndices.push(i & 1);
    i >>= 1;
  }
  return { pathElements, pathIndices };
}

/** Where this identity's leaf is among `leaves`, at any level: { index, level } or null. Done locally, so the
 *  RPC node never learns which commitment the page looks for. */
export function findLeaf(leaves, id) {
  const c = commitment(id);
  for (const level of LEVELS) {
    const lf = leafOf(c, level);
    const index = leaves.findIndex((x) => BigInt(x) === lf);
    if (index >= 0) return { index, level };
  }
  return null;
}

/** The circuit's input (all decimal strings). Throws early if the statement would not hold. */
export function proofInput({ id, leaves, scope, signalHash, minLevel }) {
  const where = findLeaf(leaves, id);
  if (!where) throw new Error('not-in-tree');
  if (where.level < Number(minLevel)) throw new Error('level-too-low');
  const tree = buildTree(leaves);
  const { pathElements, pathIndices } = merklePath(tree, where.index);
  const s = (x) => BigInt(x).toString();
  return {
    input: {
      root: s(tree.root), nullifier: s(nullifierOf(id, scope)), scope: s(scope), signalHash: s(signalHash), minLevel: s(minLevel),
      secret: s(id.secret), nullifierKey: s(id.nullifierKey), level: s(where.level),
      pathElements: pathElements.map(s), pathIndices: pathIndices.map(s),
    },
    root: tree.root, index: where.index, level: where.level,
  };
}

/** snarkjs' Groth16 proof as the uint256[8] the contracts take: a, b (each pair swapped, as the EVM pairing wants), c. */
export function proofWords(proof) {
  const n = (x) => BigInt(x);
  return [n(proof.pi_a[0]), n(proof.pi_a[1]),
    n(proof.pi_b[0][1]), n(proof.pi_b[0][0]), n(proof.pi_b[1][1]), n(proof.pi_b[1][0]),
    n(proof.pi_c[0]), n(proof.pi_c[1])];
}

// ---------------------------------------------------------------- ABI (the few calls the card makes)
// keccak256 selectors (checked against ethers in test/zkid.test.mjs)
export const SEL = {
  register: '0xf207564e',          // register(uint256)
  sync: '0xa5841194',              // sync(address) — anyone may resync a member whose label changed
  root: '0xebf0c717',              // root()
  leafCount: '0x30e69fc3',         // leafCount()
  leavesRange: '0x008a79c8',       // leavesRange(uint256,uint256)
  memberOf: '0x3b4c9891',          // memberOf(address) -> (commitment, index, level, active)
  levelNow: '0x343af93f',          // levelNow(address)
  scope: '0x6e62d0a8',             // scope() on PrivateAirdrop
  minLevel: '0x96fe4288',          // minLevel()
  amount: '0xaa8c217c',            // amount()
  signalOf: '0x48e23660',          // signalOf(address,uint256)
  claim: '0x9d66e5ed',             // claim(address,uint256,uint256,uint256,uint256[8])
  nullifierUsed: '0x79f95ee9',     // nullifierUsed(uint256)
};
export const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
export const encodeRegister = (c) => `${SEL.register}${word(c)}`;
export const encodeLeavesRange = (from, count) => `${SEL.leavesRange}${word(from)}${word(count)}`;
export const encodeSignalOf = (recipient, fee) => `${SEL.signalOf}${addrWord(recipient)}${word(fee)}`;
export const encodeClaim = (recipient, fee, root, nullifier, words8) => `${SEL.claim}${addrWord(recipient)}${word(fee)}${word(root)}${word(nullifier)}${words8.map(word).join('')}`;
export const encodeAddr = (sel, a) => `${sel}${addrWord(a)}`;
export const encodeUint = (sel, n) => `${sel}${word(n)}`;
/** A returned uint256[] (one dynamic array). */
export function decodeUintArray(hex) {
  const w = strip(hex).match(/.{64}/g) ?? [];
  const len = Number(BigInt(`0x${w[1] ?? '0'}`));
  return w.slice(2, 2 + len).map((x) => BigInt(`0x${x}`));
}

// ---------------------------------------------------------------- encrypted backup
const B64 = { enc: (b) => btoa(String.fromCharCode(...b)), dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };
export const BACKUP_KIND = 'zetaphy-zkid-backup';
export const PBKDF2_ITERATIONS = 600_000;

async function keyFrom(password, salt, iterations) {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The identity encrypted with a password (PBKDF2-SHA-256 -> AES-256-GCM), as a JSON object to save as a file. */
export async function encryptBackup(id, password, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (String(password).length < 8) throw new Error('password-too-short');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt, iterations);
  const plain = new TextEncoder().encode(JSON.stringify(identityJson(id)));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(BACKUP_KIND) }, key, plain));
  return { kind: BACKUP_KIND, v: 1, kdf: { name: 'PBKDF2-SHA-256', iterations, salt: B64.enc(salt) }, cipher: { name: 'AES-256-GCM', iv: B64.enc(iv), data: B64.enc(ct) } };
}

/** The identity from a backup and its password; throws 'bad-password' (or 'bad-backup') otherwise. */
export async function decryptBackup(backup, password) {
  const b = typeof backup === 'string' ? JSON.parse(backup) : backup;
  if (b?.kind !== BACKUP_KIND || b.v !== 1 || !b.kdf || !b.cipher) throw new Error('bad-backup');
  const iterations = Number(b.kdf.iterations);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) throw new Error('bad-backup');
  const key = await keyFrom(password, B64.dec(b.kdf.salt), iterations);
  let plain;
  try {
    plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: B64.dec(b.cipher.iv), additionalData: new TextEncoder().encode(BACKUP_KIND) }, key, B64.dec(b.cipher.data));
  } catch { throw new Error('bad-password'); }
  return parseIdentity(JSON.parse(new TextDecoder().decode(plain)));
}
