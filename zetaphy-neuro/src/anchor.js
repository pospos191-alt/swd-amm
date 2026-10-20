// Solana programs written in Rust with Anchor publish their interface (the
// IDL: every instruction and the accounts it needs) in an account on chain.
// Reading it lets Neuro name what a program lets its admin do, the same way
// it reads EVM selectors or Move function names.
//
// IDL address (anchor idl.ts): createWithSeed(findProgramAddress([], program),
// "anchor:idl", program). Account data: 8-byte discriminator, authority
// pubkey, then a u32-length vector of zlib-compressed JSON.

import { base58Encode, pubkeyBytes, findProgramAddress } from './solana.js';
import { scanFunctions } from './move.js';

async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/** Same as PublicKey.createWithSeed. Returns base58. */
export async function createWithSeed(base, seed, programId) {
  const parts = [pubkeyBytes(base), new TextEncoder().encode(seed), pubkeyBytes(programId)];
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return base58Encode(await sha256(buf));
}

export async function idlAddress(programId) {
  const base = await findProgramAddress([], programId);
  return createWithSeed(base, 'anchor:idl', programId);
}

const MAX_IDL = 2_000_000; // bytes after inflating; real IDLs are far smaller

async function inflate(bytes) {
  // zlib format, as written by pako.deflate in the Anchor CLI.
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_IDL) { await reader.cancel(); throw new Error('IDL too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** IDL account bytes -> { authority, idl } (throws on malformed data). */
export async function parseIdlAccount(data) {
  if (data.length < 8 + 32 + 4) throw new Error('bad IDL account');
  const authority = base58Encode(data.subarray(8, 40));
  const len = new DataView(data.buffer, data.byteOffset + 40, 4).getUint32(0, true);
  if (44 + len > data.length) throw new Error('bad IDL account');
  const json = new TextDecoder().decode(await inflate(data.subarray(44, 44 + len)));
  return { authority, idl: JSON.parse(json) };
}

// camelCase (Anchor < 0.30) -> snake_case (0.30+), so one set of rules fits both.
const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

// Signer names that mean "an admin", not "the user". A bare `authority` or
// `owner` is usually the user signing for their own tokens (Jupiter's swaps
// use `user_transfer_authority`), so those alone do not count.
const ADMIN_ACCOUNT = /(^|_)(admin|governor|governance|operator|manager|multisig|guardian|minter|pauser|freezer|config_authority|admin_authority|update_authority|upgrade_authority|freeze_authority|mint_authority|pause_authority|fee_authority|global_authority)(_|$)/;

/** Flattens nested account groups (composite accounts). */
function flatAccounts(accs) {
  return (accs ?? []).flatMap((a) => (Array.isArray(a.accounts) ? flatAccounts(a.accounts) : [a]));
}

/**
 * IDL -> { name, instructions, admin: [names needing an admin signer], powers }.
 * Works for both the legacy and the 0.30+ IDL format.
 */
export function idlFacts(idl) {
  const ins = Array.isArray(idl?.instructions) ? idl.instructions : [];
  const names = [];
  const admin = [];
  for (const i of ins) {
    if (typeof i?.name !== 'string') continue;
    const name = snake(i.name);
    if (!/^[a-z0-9_]{1,64}$/.test(name)) continue; // written by the program's author: keep only plain names
    names.push(name);
    const signerAdmin = flatAccounts(i.accounts).some((a) => (a.signer || a.isSigner) && ADMIN_ACCOUNT.test(snake(a.name ?? '')));
    if (signerAdmin) admin.push(name);
  }
  const raw = idl?.metadata?.name ?? idl?.name;
  const name = typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : 'program';
  return {
    name,
    instructions: names.length,
    admin: admin.sort().slice(0, 12),
    powers: scanFunctions(names.map((n) => ({ module: name, name: n, callable: true }))),
  };
}

/** Reads a program's Anchor IDL, or null if it has none (or it is unreadable). */
export async function readAnchorIdl(rpc, programId) {
  try {
    const addr = await idlAddress(programId);
    const res = await rpc.call('getAccountInfo', [addr, { encoding: 'base64', commitment: 'confirmed' }]);
    const acc = res?.value;
    if (!acc || acc.owner !== programId) return null; // only the program itself can write its IDL
    const data = Uint8Array.from(atob(acc.data[0]), (c) => c.charCodeAt(0));
    const { authority, idl } = await parseIdlAccount(data);
    return { address: addr, authority, ...idlFacts(idl) };
  } catch {
    return null;
  }
}
