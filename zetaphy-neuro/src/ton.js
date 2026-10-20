// Neuro tier 1 for TON. Read-only: only GET requests to tonapi.io, which
// returns jetton (TON token) data already decoded.
//
// A jetton is a "master" contract plus one wallet contract per holder.
// The master's powers that matter to a buyer:
//   mintable + admin   the admin can mint more
//   admin              the admin can change the name/logo and, in many
//                      contracts, more (the standard code allows minting
//                      and changing metadata; custom code can do anything)
//   no admin           ownership dropped: nobody can mint or change data

import { cleanText } from './abi.js';
import { RANK, LINK_RE, levelOf } from './move.js';

// ------------------------------------------------------------- addresses
const RAW_RE = /^(-1|0):[0-9a-fA-F]{64}$/;
const FRIENDLY_RE = /^[A-Za-z0-9_+/-]{48}$/;

function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Parses a raw (0:abcd…) or user-friendly (EQ…/UQ…) TON address.
 * Returns { raw: 'wc:hex', testnet } or throws 'invalid address'.
 */
export function parseTonAddress(s) {
  if (typeof s !== 'string') throw new Error('invalid address');
  if (RAW_RE.test(s)) {
    const [wc, h] = s.split(':');
    return { raw: `${wc}:${h.toLowerCase()}`, testnet: false };
  }
  if (!FRIENDLY_RE.test(s)) throw new Error('invalid address');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  let bytes;
  try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { throw new Error('invalid address'); }
  if (bytes.length !== 36) throw new Error('invalid address');
  if (crc16(bytes.subarray(0, 34)) !== ((bytes[34] << 8) | bytes[35])) throw new Error('invalid address');
  const flags = bytes[0];
  if ((flags & 0x7f) !== 0x11 && (flags & 0x7f) !== 0x51) throw new Error('invalid address');
  const wc = bytes[1] === 0xff ? -1 : bytes[1];
  if (wc !== 0 && wc !== -1) throw new Error('invalid address');
  return { raw: `${wc}:${hex(bytes.subarray(2, 34))}`, testnet: (flags & 0x80) !== 0 };
}

export function isTonAddress(s) {
  try { return !parseTonAddress(s).testnet; } catch { return false; }
}

// ---------------------------------------------------------------- reader
/** `api.get(path)` returns JSON, or null on 404. */
export async function readTonAccount(api, address) {
  const { raw, testnet } = parseTonAddress(address);
  if (testnet) throw new Error('testnet address');
  const acc = await api.get(`/v2/accounts/${encodeURIComponent(raw)}`);
  if (!acc || acc.status === 'nonexist' || acc.status === 'uninit') return { kind: 'missing', raw };
  const interfaces = Array.isArray(acc.interfaces) ? acc.interfaces : [];
  const accountScam = !!acc.is_scam;
  const isMaster = interfaces.includes('jetton_master') || (acc.get_methods ?? []).includes('get_jetton_data');
  if (!isMaster) {
    return { kind: 'other', raw, interfaces: interfaces.slice(0, 6), wallet: !!acc.is_wallet, accountScam, frozen: acc.status === 'frozen' };
  }
  const j = await api.get(`/v2/jettons/${encodeURIComponent(raw)}`);
  if (!j) return { kind: 'other', raw, interfaces: interfaces.slice(0, 6), wallet: false, accountScam, frozen: false };
  const md = j.metadata ?? {};
  const dec = Number(md.decimals ?? 9);
  return {
    kind: 'jetton',
    raw,
    token: {
      name: cleanText(md.name) ?? undefined,
      symbol: cleanText(md.symbol, 24) ?? undefined,
      decimals: Number.isInteger(dec) && dec >= 0 && dec <= 255 ? dec : undefined,
      supply: j.total_supply != null ? String(j.total_supply) : undefined,
      holders: Number.isInteger(j.holders_count) ? j.holders_count : undefined,
    },
    mintable: !!j.mintable,
    admin: j.admin?.address ?? null,
    adminScam: !!j.admin?.is_scam,
    verification: ['whitelist', 'blacklist', 'none'].includes(j.verification) ? j.verification : 'none',
    accountScam,
    frozen: acc.status === 'frozen',
  };
}

export function analyzeTon(m, ctx = {}) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  const known = ctx.known ?? null;
  const cap = (s) => (known && RANK[s] > RANK.low ? 'low' : s);
  const issuer = known ? { issuer: known.issuer } : {};

  if (m.kind === 'missing') {
    add('ton-not-found', 'info');
  } else if (m.kind === 'other') {
    add('ton-not-jetton', 'info', { interfaces: m.interfaces, wallet: m.wallet });
    if (m.accountScam) add('ton-scam', 'high');
  } else {
    const t = m.token;
    add('ton-jetton', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.supply, holders: t.holders });
    if ((t.name && LINK_RE.test(t.name)) || (t.symbol && LINK_RE.test(t.symbol))) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
    if (known) add('known-issuer', 'good', { symbol: known.symbol, issuer: known.issuer, kind: known.kind });
    if (ctx.lookalike) add('lookalike', 'high', { symbol: t.symbol, official: ctx.lookalike.display ?? ctx.lookalike.address, issuer: ctx.lookalike.issuer });
    if (m.accountScam || m.adminScam || m.verification === 'blacklist') add('ton-scam', 'high');
    else if (m.verification === 'whitelist') add('ton-listed', 'good');
    if (m.frozen) add('ton-frozen', 'high');
    if (m.admin) {
      if (m.mintable) add('ton-mintable', cap('high'), { admin: m.admin, ...issuer });
      add('ton-admin', cap('medium'), { admin: m.admin, ...issuer });
    } else {
      add('ton-admin-dropped', 'good');
      if (m.mintable) add('ton-mint-flag', 'info');
    }
  }

  if (!findings.some((f) => RANK[f.severity] > 0 || f.severity === 'good')) add('nothing-found', 'info');
  add('ton-caveat', 'info');
  return { level: levelOf(findings), control: m.kind, findings };
}
