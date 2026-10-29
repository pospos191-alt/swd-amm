// Reads ModelRegistry (zetaphy-network/contracts/ModelRegistry.sol) with eth_call:
// the release a loader must match. No ethers: hand-written ABI for three views.

import { keccak256, selectorOf } from '../../src/keccak.js';
import { KINDS, STATUSES, toHex } from './manifest.js';
import { readWord, wordUint, wordAddress, readString, uintWord } from './rpc.js';

export const SEL = {
  latest: selectorOf('latest(bytes32)'),
  release: selectorOf('release(bytes32,uint32)'),
  isUsable: selectorOf('isUsable(bytes32,uint32,bytes32,bytes32)'),
};

/** ModelRegistry.idOf(kind, name) computed locally: keccak256("zetaphy.registry" ‖ uint8 kind ‖ name). */
export function registryId(kind, name) {
  const k = typeof kind === 'number' ? kind : KINDS.indexOf(kind);
  if (k < 1 || k >= KINDS.length) throw new Error('unknown kind');
  const pre = new TextEncoder().encode('zetaphy.registry');
  const n = new TextEncoder().encode(String(name));
  const b = new Uint8Array(pre.length + 1 + n.length);
  b.set(pre); b[pre.length] = k; b.set(n, pre.length + 1);
  return '0x' + toHex(keccak256(b));
}

/** Decodes an ABI-encoded Release tuple that starts at word `base` of `hex`. */
export function decodeRelease(hex, base) {
  const w = (i) => readWord(hex, base + i);
  const kind = Number(wordUint(w(0)));
  const status = Number(wordUint(w(1)));
  const strOff = Number(wordUint(w(9)));
  return {
    kind: KINDS[kind] ?? `#${kind}`,
    status: STATUSES[status] ?? `#${status}`,
    chunkSize: Number(wordUint(w(2))),
    size: wordUint(w(3)),
    publishedAt: Number(wordUint(w(4))),
    updatedAt: Number(wordUint(w(5))),
    manifestHash: '0x' + w(6),
    chunkRoot: '0x' + w(7),
    author: wordAddress(w(8)),
    license: readString(hex, base * 32 + strOff),
  };
}

/** latest(id) -> {version, ...release}; version 0 = unknown id. */
export async function readLatest(reader, registry, id) {
  const data = '0x' + SEL.latest + id.replace(/^0x/, '').padStart(64, '0');
  const out = await reader.call('eth_call', [{ to: registry, data }, 'latest']);
  const version = Number(wordUint(readWord(out, 0)));
  const tupleWord = Number(wordUint(readWord(out, 1))) / 32;
  return { version, ...decodeRelease(out, tupleWord) };
}

/** release(id, version) -> release (status "none" = no such release). */
export async function readRelease(reader, registry, id, version) {
  const data = '0x' + SEL.release + id.replace(/^0x/, '').padStart(64, '0') + uintWord(version);
  const out = await reader.call('eth_call', [{ to: registry, data }, 'latest']);
  return { version: Number(version), ...decodeRelease(out, Number(wordUint(readWord(out, 0))) / 32) };
}
