// Arbitrum Stylus: contracts in Rust/C/C++ compiled to WASM. On chain the
// code is 0xEFF000, a dictionary byte (0x00 = none) and the WASM compressed
// with brotli. Neuro unpacks it and looks for what the EVM reader looks for:
//   function selectors  the router compares each call's 4-byte selector with
//                       constants in the code (i32.const), so known selectors
//                       (mint, pause, blacklist, setFee, ...) show up there
//   host imports        what the code may do: delegate_call_contract and
//                       create2 come in as imports from "vm_hooks"
// The WASM is never run.

import { SELECTORS } from './selectors.generated.js';

const MAX_WASM = 8 * 1024 * 1024;

/** Brotli-decompress with what the runtime has (Node zlib, or a browser that supports it). */
async function brotli(bytes) {
  if (globalThis.process?.versions?.node) {
    const zlib = await import('node:zlib');
    return new Uint8Array(zlib.brotliDecompressSync(bytes, { maxOutputLength: MAX_WASM }));
  }
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('brotli'); // throws where unsupported
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    if (out.byteLength > MAX_WASM) throw new Error('too large');
    return new Uint8Array(out);
  }
  throw new Error('no brotli');
}

/** The WASM inside a Stylus contract's code, or null if it cannot be unpacked. */
export async function stylusWasm(code) {
  if (!(code?.length > 4) || code[0] !== 0xef || code[1] !== 0xf0 || code[2] !== 0x00) return null;
  if (code[3] !== 0x00) return null; // compressed against a dictionary Neuro does not have
  try {
    const wasm = await brotli(code.subarray(4));
    return wasm.length >= 8 && wasm[0] === 0 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d ? wasm : null;
  } catch {
    return null;
  }
}

function uleb(b, o) {
  let v = 0; let shift = 0; let x;
  do {
    if (o >= b.length) throw new Error('bad wasm');
    x = b[o++];
    v += (x & 0x7f) * 2 ** shift;
    shift += 7;
  } while (x & 0x80 && shift < 35);
  return [v, o];
}

/** Signed LEB128 as a 32-bit pattern (0..2^32-1), or null if not a valid i32. */
function sleb32(b, o) {
  let v = 0n; let shift = 0n; let x; let n = 0;
  do {
    if (o >= b.length || n === 5) return null;
    x = b[o++]; n++;
    v |= BigInt(x & 0x7f) << shift;
    shift += 7n;
  } while (x & 0x80);
  if (x & 0x40) v -= 1n << shift;
  if (v < -(1n << 31n) || v >= 1n << 32n) return null;
  return Number(BigInt.asUintN(32, v));
}

const hex8 = (n) => n.toString(16).padStart(8, '0');
const swap = (n) => (((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >>> 8) & 0xff00) | (n >>> 24)) >>> 0;

/**
 * Known functions and host imports in a WASM module. Same shape as
 * scanBytecode's result so the EVM rules can be reused.
 */
export function scanWasm(wasm) {
  const found = new Map();
  const imports = [];
  let o = 8;
  while (o < wasm.length) {
    const id = wasm[o++];
    let size;
    [size, o] = uleb(wasm, o);
    const end = o + size;
    if (end > wasm.length) throw new Error('bad wasm');
    if (id === 2) {
      let n; let p = o;
      [n, p] = uleb(wasm, p);
      for (let i = 0; i < n && p < end; i++) {
        let len;
        [len, p] = uleb(wasm, p); const mod = new TextDecoder().decode(wasm.subarray(p, p + len)); p += len;
        [len, p] = uleb(wasm, p); const name = new TextDecoder().decode(wasm.subarray(p, p + len)); p += len;
        const kind = wasm[p++];
        if (kind === 0) [, p] = uleb(wasm, p);
        else if (kind === 1) { p++; let f; [f, p] = uleb(wasm, p); [, p] = uleb(wasm, p); if (f & 1) [, p] = uleb(wasm, p); }
        else if (kind === 2) { let f; [f, p] = uleb(wasm, p); [, p] = uleb(wasm, p); if (f & 1) [, p] = uleb(wasm, p); }
        else if (kind === 3) p += 2;
        else break;
        if (kind === 0) imports.push(`${mod}::${name}`);
      }
    } else if (id === 10) {
      // i32.const (0x41) immediates, in both byte orders (the compiler may
      // compare the selector as loaded little-endian).
      for (let p = o; p < end - 1; p++) {
        if (wasm[p] !== 0x41) continue;
        const v = sleb32(wasm, p + 1);
        if (v == null) continue;
        for (const sel of [hex8(v), hex8(swap(v))]) {
          const known = SELECTORS[sel];
          if (known && !found.has(sel)) found.set(sel, { selector: sel, ...known });
        }
      }
    }
    o = end;
  }
  const has = (n) => imports.includes(`vm_hooks::${n}`);
  return {
    size: wasm.length,
    functions: [...found.values()],
    unknownSelectors: [],
    opcodes: { selfdestruct: false, delegatecall: has('delegate_call_contract'), callcode: false, create2: has('create2') },
    imports,
  };
}
