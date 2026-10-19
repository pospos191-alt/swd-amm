// Code fingerprint: identifies a contract TEMPLATE, so every token made by
// the same launcher matches even though each one has its own owner, name,
// supply or tax baked in.
//
// How: walk the opcodes, blank out the data of PUSH20 (addresses) and PUSH32
// (where Solidity puts `immutable` values set in the constructor), drop the
// compiler metadata tail, then SHA-256 what is left.

import { hexToBytes, codeLengthWithoutMetadata } from './bytecode.js';

const PUSH1 = 0x60;
const PUSH20 = 0x73;
const PUSH32 = 0x7f;

export const FINGERPRINT_VERSION = 'fp1';

export async function codeFingerprint(codeHex) {
  const code = hexToBytes(codeHex);
  const end = codeLengthWithoutMetadata(code);
  const out = code.slice(0, end);
  for (let pc = 0; pc < end; pc++) {
    const op = out[pc];
    if (op >= PUSH1 && op <= PUSH32) {
      const n = op - PUSH1 + 1;
      if (op === PUSH20 || op === PUSH32) out.fill(0, pc + 1, Math.min(pc + 1 + n, end));
      pc += n;
    }
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', out);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${FINGERPRINT_VERSION}:${hex}`;
}
