// Neuro tier 1 for Solana: reads an SPL token mint (or a program) and turns
// what it finds into findings. Read-only: only getGenesisHash and
// getAccountInfo are ever called.
//
// Solana tokens have no Solidity code to scan. The powers live in the mint
// account itself (mint and freeze authorities) and, for Token-2022, in
// "extensions" such as a transfer fee, a transfer hook or a permanent
// delegate that can move anyone's tokens. The RPC's jsonParsed encoding
// decodes all of these for us.

import { cleanText } from './abi.js';
import { addPowerFindings } from './move.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

// ---------------------------------------------------------------- base58
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = Object.fromEntries([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = INDEX[c];
    if (v === undefined) throw new Error('invalid base58');
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

/** 32-byte public key from base58, or throws. */
export function pubkeyBytes(address) {
  const b = base58Decode(address);
  if (b.length !== 32) throw new Error('invalid address');
  return b;
}

// ------------------------------------------------- program derived address
const P = 2n ** 255n - 19n;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
const D = ((-121665n % P + P) * modpow(121666n, P - 2n, P)) % P;

/** Is this 32-byte string a valid ed25519 point? PDAs must NOT be. */
export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modpow(v, P - 2n, P)) % P;
  if (x2 === 0n) return sign === 0n;
  return modpow(x2, (P - 1n) / 2n, P) === 1n;
}

async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/** Same as Solana's find_program_address. Returns base58. */
export async function findProgramAddress(seeds, programId) {
  const program = pubkeyBytes(programId);
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, marker];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    const h = await sha256(buf);
    if (!isOnCurve(h)) return base58Encode(h);
  }
  throw new Error('no program address');
}

// ------------------------------------------------------ Metaplex metadata
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Parses the start of a Metaplex token-metadata account. */
export function parseMetaplexMetadata(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 1 + 32 + 32; // key, update authority, mint
  const updateAuthority = base58Encode(data.subarray(1, 33));
  const str = () => {
    const len = dv.getUint32(o, true); o += 4;
    if (len > 1000) throw new Error('bad metadata');
    const s = new TextDecoder().decode(data.subarray(o, o + len)); o += len;
    return s.replace(/\0+$/, '');
  };
  const name = str();
  const symbol = str();
  str(); // uri
  o += 2; // seller fee
  if (data[o++] === 1) o += 4 + dv.getUint32(o, true) * 34; // creators
  o += 1; // primary sale happened
  const isMutable = data[o] === 1;
  return { name, symbol, updateAuthority, isMutable };
}

// ---------------------------------------------------------------- analysis
const RANK = { high: 3, medium: 2, low: 1, info: 0, good: 0 };
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|io|xyz|app|site|top|vip|pro|finance|claims?|gift|live|online|info)\b|t\.me\/)/i;

/**
 * @param {object} m  what was read: { kind:'mint'|'program'|'other'|'missing', ... }
 * @param {{known?:object, lookalike?:object}} ctx
 */
export function analyzeSolana(m, ctx = {}) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  const known = ctx.known ?? null;
  const cap = (s) => (known && RANK[s] > RANK.low ? 'low' : s);
  const issuer = known ? { issuer: known.issuer } : {};

  if (m.kind === 'missing') {
    add('sol-not-found', 'info');
  } else if (m.kind === 'other') {
    add('sol-not-token', 'info', { owner: m.owner });
  } else if (m.kind === 'program') {
    if (m.upgradeAuthority) add('sol-program-upgradeable', 'high', { authority: m.upgradeAuthority });
    else add('sol-program-immutable', 'good');
    // Anchor IDL: the program's own list of instructions (Rust source names).
    const idl = m.idl;
    if (idl) {
      add('sol-idl', 'info', { name: idl.name, count: idl.instructions });
      if (idl.admin.length) add('sol-admin-instructions', 'medium', { functions: idl.admin });
      addPowerFindings(add, idl.powers, (x) => x, {});
    } else {
      add('sol-no-idl', 'info');
    }
  } else {
    const t = m.token;
    add('sol-token', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.supply, program: m.program2022 ? 'Token-2022' : 'SPL Token' });
    if ((t.name && LINK_RE.test(t.name)) || (t.symbol && LINK_RE.test(t.symbol))) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
    if (known) add('known-issuer', 'good', { symbol: known.symbol, issuer: known.issuer, kind: known.kind });
    if (ctx.lookalike) add('lookalike', 'high', { symbol: t.symbol, official: ctx.lookalike.address, issuer: ctx.lookalike.issuer });

    if (m.mintAuthority) add('sol-mint-authority', cap('high'), { authority: m.mintAuthority, ...issuer });
    else add('sol-mint-renounced', 'good');
    if (m.freezeAuthority) add('sol-freeze-authority', cap('high'), { authority: m.freezeAuthority, ...issuer });
    else add('sol-freeze-renounced', 'good');

    const x = m.extensions;
    if (x.permanentDelegate?.delegate) add('sol-permanent-delegate', cap('high'), { delegate: x.permanentDelegate.delegate, ...issuer });
    if (x.transferFeeConfig) {
      const fee = x.transferFeeConfig.newerTransferFee ?? x.transferFeeConfig.olderTransferFee ?? {};
      const bps = Number(fee.transferFeeBasisPoints ?? 0);
      const authority = x.transferFeeConfig.transferFeeConfigAuthority ?? null;
      // 10%+ is high; a fee authority can raise it later (up to 100%), so medium.
      const sev = bps >= 1000 ? 'high' : authority ? 'medium' : 'low';
      add('sol-transfer-fee', cap(sev), { percent: bps / 100, maxFee: fee.maximumFee, authority });
    }
    if (x.transferHook?.programId) add('sol-transfer-hook', cap('high'), { programId: x.transferHook.programId, authority: x.transferHook.authority ?? null });
    if (x.defaultAccountState?.accountState === 'frozen') add('sol-default-frozen', cap('high'));
    if (x.pausableConfig) add('sol-pausable', cap('high'), { authority: x.pausableConfig.authority ?? null, paused: !!x.pausableConfig.paused });
    if (x.mintCloseAuthority?.closeAuthority) add('sol-close-authority', cap('medium'), { authority: x.mintCloseAuthority.closeAuthority });
    if ('nonTransferable' in x) add('sol-non-transferable', 'medium');
    if (m.metadataMutable) add('sol-metadata-mutable', cap('low'), { authority: m.metadataUpdateAuthority });
  }

  if (!findings.some((f) => RANK[f.severity] > 0 || f.severity === 'good')) add('nothing-found', 'info');
  add('sol-caveat', 'info');
  const level = findings.reduce((acc, f) => (RANK[f.severity] > RANK[acc] ? f.severity : acc), 'info');
  return { level, control: m.kind, findings };
}

// ------------------------------------------------------------------ reader
/**
 * Reads one Solana address. `rpc.call` must allow getAccountInfo.
 * Returns the raw facts for analyzeSolana plus display data.
 */
export async function readSolanaAccount(rpc, address) {
  pubkeyBytes(address); // throws on a malformed address
  const res = await rpc.call('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const acc = res?.value;
  if (!acc) return { kind: 'missing' };

  const parsed = acc.data?.parsed;
  if ((acc.owner === TOKEN_PROGRAM || acc.owner === TOKEN_2022_PROGRAM) && parsed?.type === 'mint') {
    const info = parsed.info ?? {};
    const extensions = Object.fromEntries((info.extensions ?? []).map((e) => [e.extension, e.state ?? {}]));
    let name; let symbol; let metadataMutable = false; let metadataUpdateAuthority = null;
    if (extensions.tokenMetadata) {
      ({ name, symbol } = extensions.tokenMetadata);
      metadataUpdateAuthority = extensions.tokenMetadata.updateAuthority ?? null;
      metadataMutable = !!metadataUpdateAuthority;
    } else {
      try {
        const pda = await findProgramAddress(
          [new TextEncoder().encode('metadata'), pubkeyBytes(METADATA_PROGRAM), pubkeyBytes(address)], METADATA_PROGRAM);
        const md = await rpc.call('getAccountInfo', [pda, { encoding: 'base64', commitment: 'confirmed' }]);
        if (md?.value?.owner === METADATA_PROGRAM) {
          const meta = parseMetaplexMetadata(b64(md.value.data[0]));
          ({ name, symbol } = meta);
          metadataMutable = meta.isMutable;
          metadataUpdateAuthority = meta.updateAuthority;
        }
      } catch {
        /* no or unreadable metadata: the token still gets analysed */
      }
    }
    return {
      kind: 'mint',
      program2022: acc.owner === TOKEN_2022_PROGRAM,
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      extensions,
      metadataMutable,
      metadataUpdateAuthority,
      token: {
        name: cleanText(name) ?? undefined,
        symbol: cleanText(symbol, 24) ?? undefined,
        decimals: info.decimals,
        supply: info.supply,
      },
    };
  }

  if (acc.owner === UPGRADEABLE_LOADER && parsed?.type === 'program') {
    const pd = await rpc.call('getAccountInfo', [parsed.info.programData,
      { encoding: 'base64', dataSlice: { offset: 0, length: 45 }, commitment: 'confirmed' }]);
    const d = b64(pd.value.data[0]);
    // ProgramData: u32 tag (3), u64 slot, Option<Pubkey> upgrade authority
    const upgradeAuthority = d[12] === 1 ? base58Encode(d.subarray(13, 45)) : null;
    return { kind: 'program', upgradeAuthority };
  }

  return { kind: 'other', owner: acc.owner };
}
