// The vaccine's read side, shared by the ZETAPHY web wallet (zetaphy-wallet,
// bundled into vendor/pqwallet.js) and the MetaMask Snap's transaction insight
// (zetaphy-snap): which ThreatRegistry views to ask about a destination, and
// where a proxy forwards its calls (best effort).
//
// Keys asked per destination (each with its warning view and its enforcement view):
//   - the address itself on the destination's chain: isAddressFlagged / isAddressEnforced(chainId, to)
//   - its code, byte for byte:                       isCodeFlagged / isCodeEnforced(keccak256(code))
//   - its Neuro fingerprint (fp1):                   isFlagged / isEnforced(fp1)
// Proxies: the code a destination forwards to is checked the same way: an
// EIP-1167 minimal proxy's target (and its PUSH0 form, ERC-7511), the EIP-1967
// implementation slot, the EIP-1967 beacon slot and that beacon's implementation(),
// up to PROXY_DEPTH hops. Other forwarding (custom slots, a target chosen per call)
// is not seen.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';

const enc = new TextEncoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function fromHex(hex) {
  const h = /^0x/i.test(hex) ? hex.slice(2) : hex;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const selector = (sig) => toHex(keccak_256(enc.encode(sig))).slice(0, 8);
/** [warning view, enforcement view] per kind of key. */
export const THREAT_SEL = {
  fingerprint: [selector('isFlagged(bytes32)'), selector('isEnforced(bytes32)')],
  code: [selector('isCodeFlagged(bytes32)'), selector('isCodeEnforced(bytes32)')],
  address: [selector('isAddressFlagged(uint256,address)'), selector('isAddressEnforced(uint256,address)')],
};
/**
 * ThreatRegistry.Reason, by its number: what the code does, or did in a
 * reproducible test. Never a claim about intent (see docs/LEGAL.md).
 */
export const REASONS = ['none', 'cannot-sell-in-simulation', 'unlimited-mint', 'owner-can-block-transfers',
  'owner-can-move-holder-funds', 'same-name-as-known-token', 'sweeps-approved-tokens', 'other'];
/** What each reason says, in Thai and English (wallet, snap, CLI). */
export const REASON_TEXT = [
  { th: '-', en: '-' },
  { th: 'ในการจำลองซื้อขาย ซื้อได้ แต่ขายไม่ได้หรือได้เงินคืนน้อยมาก', en: 'in a simulated trade, buying worked but selling failed or returned almost nothing' },
  { th: 'มีที่อยู่ที่สร้างเหรียญเพิ่มได้ไม่จำกัด', en: 'an address can mint new tokens without a cap' },
  { th: 'เจ้าของหรือผู้ดูแลระงับการโอนหรือการขายของผู้ถือได้', en: 'an owner or admin can stop holders from transferring or selling' },
  { th: 'เจ้าของหรือผู้ดูแลย้ายหรือเผาเหรียญหรือเงินในบัญชีของผู้ถือคนอื่นได้', en: 'an owner or admin can move or burn tokens or funds held by others' },
  { th: 'ใช้ชื่อหรือสัญลักษณ์เดียวกับเหรียญที่รู้จัก แต่อยู่คนละที่อยู่', en: 'uses the same name or symbol as a known token at a different address' },
  { th: 'ในการทดสอบที่ทำซ้ำได้ ย้ายเหรียญที่ได้รับอนุญาต (approve) ไปยังที่อยู่ที่ผู้ถือไม่ได้เลือก', en: 'in a reproducible test, it moved tokens approved to it to an address the holder did not choose' },
  { th: 'ข้อเท็จจริงอื่นของโค้ด (ดูหลักฐาน)', en: 'another code fact (see the evidence)' },
];
/** The line shown with every warning or refusal. */
export const DISCLAIMER = { th: 'ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา', en: 'Automated code analysis, not an accusation' };
/** How anyone checks the evidence: Neuro's report of the same code gives the same reportHash. */
export const REPRODUCE = {
  th: 'ตรวจซ้ำ: รัน Neuro กับโค้ดเดียวกัน (zetaphy-neuro: node cli.js <chain> <address> --json) แล้วเทียบ reportHash',
  en: 'reproduce: run Neuro on the same code (zetaphy-neuro: node cli.js <chain> <address> --json) and compare the reportHash',
};
/** Reason number -> { th, en } ('#n' for a number this code does not know). */
export const reasonText = (n) => REASON_TEXT[n] && n > 0 ? REASON_TEXT[n] : { th: `#${n}`, en: `#${n}` };
/** The views that explain a flag: its evidence and the response of the party behind it. */
export const DETAIL_SEL = { evidence: selector('evidenceOf(bytes32)'), response: selector('responseOf(bytes32)') };

// EIP-1967 slots: keccak256(name) - 1.
const slotOf = (name) => '0x' + (BigInt('0x' + toHex(keccak_256(enc.encode(name)))) - 1n).toString(16).padStart(64, '0');
export const SLOT_IMPL = slotOf('eip1967.proxy.implementation');
export const SLOT_BEACON = slotOf('eip1967.proxy.beacon');
export const SEL_IMPLEMENTATION = selector('implementation()');
// EIP-1167 minimal proxy, and its PUSH0 form (ERC-7511).
export const MINIMAL_PROXY = [/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i, /^0x365f5f375f5f365f73([0-9a-f]{40})5af43d5f5f3e5f3d91602a57fd5bf3$/i];
export const PROXY_DEPTH = 3;

const word = (v) => BigInt(v).toString(16).padStart(64, '0');

/** A 32-byte word holding an address (zero, or not an address: null). Throws on a malformed answer. */
export function wordAddress(hex) {
  const b = typeof hex === 'string' ? fromHex(hex) : null;
  if (!b || b.length < 32) throw new Error('not a word');
  const w = toHex(b.slice(0, 32));
  if (!/^0{24}/.test(w) || /^0{64}$/.test(w)) return null;
  return '0x' + w.slice(24);
}

/**
 * Where this contract's calls go (best effort): EIP-1167 target, EIP-1967
 * implementation, beacon and its implementation. `call(method, params)` is a
 * JSON-RPC call on the contract's own chain; a failed read throws.
 */
export async function proxyTargets(call, addr, code) {
  const out = [];
  for (const re of MINIMAL_PROXY) { const m = re.exec(code); if (m) out.push('0x' + m[1].toLowerCase()); }
  const impl = wordAddress(await call('eth_getStorageAt', [addr, SLOT_IMPL, 'latest']));
  if (impl) out.push(impl);
  const beacon = wordAddress(await call('eth_getStorageAt', [addr, SLOT_BEACON, 'latest']));
  if (beacon) {
    out.push(beacon);
    const bi = wordAddress(await call('eth_call', [{ to: beacon, data: '0x' + SEL_IMPLEMENTATION }, 'latest']));
    if (bi) out.push(bi);
  }
  return out;
}

// ---- Neuro's fp1 fingerprint (the same as zetaphy-neuro/src/fingerprint.js) ----
// Kept here so the snap's bundle does not depend on zetaphy-neuro's bytecode
// reader; the snap's tests check it against zetaphy-neuro's codeFingerprint.
const PUSH1 = 0x60, PUSH20 = 0x73, PUSH32 = 0x7f;
function codeLengthWithoutMetadata(code) {
  if (code.length < 4) return code.length;
  const metaLen = (code[code.length - 2] << 8) | code[code.length - 1];
  const start = code.length - 2 - metaLen;
  if (metaLen > 0 && start > 0 && code[start] >= 0xa1 && code[start] <= 0xa5) return start;
  return code.length;
}
/** 'fp1:<sha256 hex>' of runtime code: PUSH20 / PUSH32 data blanked, metadata tail dropped. */
export function fingerprint1(codeHex) {
  const code = fromHex(codeHex);
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
  return 'fp1:' + toHex(sha256(out));
}

/** keccak-256 of runtime code, 0x-prefixed (what extcodehash gives on chain). */
export const codeHash = (codeHex) => '0x' + toHex(keccak_256(fromHex(codeHex)));

// ---- the registry's keys, as ThreatRegistry.codeKey / addressKey compute them ----
const strWords = (str) => { const h = toHex(enc.encode(str)); return word(h.length / 2) + h.padEnd(64 * Math.ceil(h.length / 64), '0'); };
const keccakHex = (hex) => '0x' + toHex(keccak_256(fromHex(hex)));
/** keccak256(abi.encode("zetaphy.threat.code", codeHash)) */
export const codeKey = (codeHashHex) => keccakHex(word(64) + codeHashHex.replace(/^0x/, '').padStart(64, '0') + strWords('zetaphy.threat.code'));
/** keccak256(abi.encode("zetaphy.threat.address", chainId, address)) */
export const addressKey = (chainId, address) => keccakHex(word(96) + word(chainId) + address.toLowerCase().slice(2).padStart(64, '0') + strWords('zetaphy.threat.address'));

/** The registry key a query of threatQueries is about. */
export function threatKey(what, chainId, address, code) {
  if (what === 'address') return addressKey(chainId, address);
  if (what === 'code') return codeKey(codeHash(code));
  return '0x' + fingerprint1(code).slice(4);
}

/** eth_call data of evidenceOf(key) and responseOf(key). */
export const detailQueries = (key) => ({ evidence: '0x' + DETAIL_SEL.evidence + key.slice(2), response: '0x' + DETAIL_SEL.response + key.slice(2) });

// Text another party wrote (a URI, a response): shown as plain text, without
// control or bidi/invisible characters, at most `max` characters.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu;
export const plainText = (s, max = 500) => String(s).replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, '').trim().slice(0, max);

function abiString(b, at) {
  const big = (o) => BigInt('0x' + toHex(b.slice(o, o + 32)));
  const off = Number(big(at));
  if (off + 32 > b.length) throw new Error('bad string');
  const len = Number(big(off));
  if (len > 4096 || off + 32 + len > b.length) throw new Error('bad string');
  return new TextDecoder().decode(b.slice(off + 32, off + 32 + len));
}
const wordAddr = (b, at) => '0x' + toHex(b.slice(at + 12, at + 32));
const ZERO_HASH = '0x' + '0'.repeat(64);

/** evidenceOf's answer: { reportHash, uri, by, at } (reportHash null: none stored). Throws on a malformed answer. */
export function readEvidence(hex) {
  const b = fromHex(hex);
  if (b.length < 128) throw new Error('not an evidenceOf answer');
  const reportHash = '0x' + toHex(b.slice(0, 32));
  return { reportHash: reportHash === ZERO_HASH ? null : reportHash, uri: plainText(abiString(b, 32), 200), by: wordAddr(b, 64), at: Number(BigInt('0x' + toHex(b.slice(96, 128)))) };
}

/** responseOf's answer: { text, by, at, chainId, account } (text '': no response). Throws on a malformed answer. */
export function readResponse(hex) {
  const b = fromHex(hex);
  if (b.length < 160) throw new Error('not a responseOf answer');
  return { text: plainText(abiString(b, 0)), by: wordAddr(b, 32), at: Number(BigInt('0x' + toHex(b.slice(64, 96)))),
    chainId: BigInt('0x' + toHex(b.slice(96, 128))), account: wordAddr(b, 128) };
}

/**
 * The registry questions for one destination: [{ what, warn, enforced }] with
 * `warn` / `enforced` the eth_call data (0x…) of the two views. `code` is '0x'
 * (or empty) for an account without code: then only the address is asked.
 */
export function threatQueries(chainId, address, code) {
  const qs = [['address', word(chainId) + address.toLowerCase().slice(2).padStart(64, '0')]];
  if (code && code !== '0x') qs.push(['fingerprint', fingerprint1(code).slice(4)], ['code', codeHash(code).slice(2)]);
  return qs.map(([what, arg]) => ({ what, warn: '0x' + THREAT_SEL[what][0] + arg, enforced: '0x' + THREAT_SEL[what][1] + arg }));
}

/** The answers of a (warning, enforcement) pair: { flagged, enforced, reason }. Throws on a malformed answer (no registry there). */
export function readThreat(warnHex, enforcedHex) {
  const [w, e] = [warnHex, enforcedHex].map((h) => (typeof h === 'string' ? fromHex(h) : null));
  if (!w || w.length < 64 || !e || e.length < 64) throw new Error('not a ThreatRegistry answer');
  const big = (b, at) => BigInt('0x' + toHex(b.slice(at, at + 32)));
  const enforced = big(e, 0) !== 0n;
  const flagged = enforced || big(w, 0) !== 0n;
  const reason = flagged ? Number(big(enforced ? e : w, 32)) : 0;
  return { flagged, enforced, reason };
}
