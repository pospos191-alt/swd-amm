// Evidence bundles: what a sentinel saw, in a canonical form anyone can re-run (the runners do, before they vote).
// evidenceHash = sha256 of the canonical bytes; the same digest is the IPFS CIDv1 (raw codec, sha2-256), so the
// bundle can be pinned on any IPFS node / gateway and fetched by the hash stored on chain. No server of ours needed.
import { sha256 } from '@noble/hashes/sha2.js';

const enc = new TextEncoder();
export const BUNDLE_FORMAT = 'zetaphy.immune.evidence.v1';

/** Canonical JSON: sorted keys, no spaces, bigint as decimal string, undefined dropped. */
export function canonical(v) {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

export const toHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('invalid hex');
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** The IPFS CIDv1 (raw, sha2-256, base32 "b…") of a sha256 digest (0x… 32 bytes). */
export function cidOf(digestHex) {
  const d = fromHex(digestHex);
  if (d.length !== 32) throw new Error('sha256 digest expected');
  return 'b' + base32(Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...d]));
}

/** sha256 of the bundle's canonical bytes -> { evidenceHash, cid, bytes }. */
export function contentHash(bundle) {
  const bytes = enc.encode(canonical(bundle));
  const evidenceHash = toHex(sha256(bytes));
  return { evidenceHash, cid: cidOf(evidenceHash), bytes };
}

/**
 * The bundle: the detector and its version, the chain and block, the raw inputs the detector read (logs, code,
 * transfers: enough to re-run it without an RPC), and what it concluded. Runners re-run `detector` on `inputs`.
 */
export function makeBundle({ detector, version = 1, chain, block = null, tx = null, inputs, finding, observedAt }) {
  return { format: BUNDLE_FORMAT, detector, version, chain, block, tx, inputs, finding, observedAt };
}

/** Does `bundle` hash to `evidenceHash`? (a feed reader or runner checks before trusting a fetched bundle) */
export const verifyBundle = (bundle, evidenceHash) => contentHash(bundle).evidenceHash.toLowerCase() === String(evidenceHash).toLowerCase();
