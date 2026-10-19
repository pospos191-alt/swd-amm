// Reads EVM runtime bytecode without running it.
// Walks the opcodes properly (skipping PUSH data), so bytes inside PUSH
// arguments are never mistaken for opcodes.

import { SELECTORS } from './selectors.generated.js';

const OP = {
  STOP: 0x00,
  PUSH1: 0x60,
  PUSH32: 0x7f,
  INVALID: 0xfe,
  CALLCODE: 0xf2,
  DELEGATECALL: 0xf4,
  CREATE2: 0xf5,
  SELFDESTRUCT: 0xff,
};

/** "0x60.." or "60.." -> Uint8Array. Throws on odd length or non-hex. */
export function hexToBytes(hex) {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Solidity appends CBOR metadata; its last 2 bytes give its length.
 * Returns the length of the code part (metadata excluded) when the tail
 * looks like Solidity/Vyper metadata, else the full length.
 */
export function codeLengthWithoutMetadata(code) {
  if (code.length < 4) return code.length;
  const metaLen = (code[code.length - 2] << 8) | code[code.length - 1];
  const start = code.length - 2 - metaLen;
  // CBOR map header 0xa1..0xa5 marks the start of the metadata blob.
  if (metaLen > 0 && start > 0 && code[start] >= 0xa1 && code[start] <= 0xa5) return start;
  return code.length;
}

/** EIP-1167 minimal proxy: 363d3d373d3d3d363d73<20-byte target>5af43d82803e903d91602b57fd5bf3 */
export function minimalProxyTarget(code) {
  const hex = toHex(code);
  const m = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(hex);
  return m ? '0x' + m[1] : null;
}

/**
 * Scans bytecode. Returns:
 *  - functions: known functions found in the dispatcher [{selector, sig, cat}]
 *  - opcodes: flags for dangerous opcodes that appear as real instructions
 *  - size: code size in bytes
 */
export function scanBytecode(codeHex) {
  const code = hexToBytes(codeHex);
  const end = codeLengthWithoutMetadata(code);
  const found = new Map();
  const opcodes = { selfdestruct: false, delegatecall: false, callcode: false, create2: false };

  for (let pc = 0; pc < end; pc++) {
    const op = code[pc];
    if (op >= OP.PUSH1 && op <= OP.PUSH32) {
      const n = op - OP.PUSH1 + 1;
      // Selectors are pushed with PUSH4, or PUSH1-3 when they start with 0x00 bytes.
      if (n <= 4 && pc + n < code.length) {
        const sel = toHex(code.subarray(pc + 1, pc + 1 + n)).padStart(8, '0');
        const known = SELECTORS[sel];
        if (known && !found.has(sel)) found.set(sel, { selector: sel, ...known });
      }
      pc += n;
      continue;
    }
    if (op === OP.SELFDESTRUCT) opcodes.selfdestruct = true;
    else if (op === OP.DELEGATECALL) opcodes.delegatecall = true;
    else if (op === OP.CALLCODE) opcodes.callcode = true;
    else if (op === OP.CREATE2) opcodes.create2 = true;
  }

  return { size: code.length, functions: [...found.values()], opcodes };
}
