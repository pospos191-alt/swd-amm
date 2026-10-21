// Neuro (ZETAPHY's code analysis) in the DEX page: asks the ThreatRegistry
// (zetaphy-network/contracts/ThreatRegistry.sol) about a token before it is
// imported, bought, or added to a pool. The same keys as the wallet's vaccine
// (zetaphy-network/src/vaccine.js), without keccak in the page:
//   - isContractFlagged / isContractEnforced(token): its address on this chain,
//     or its exact code (the registry hashes it on chain);
//   - isFlagged / isEnforced(fp1): Neuro's fingerprint of the code (sha256 via WebCrypto);
//   - the same for the code a proxy forwards to (EIP-1167, EIP-1967 implementation/beacon).
// Flagged: the page warns. Enforced: the page refuses (and so does the router,
// when governance set the registry there). Wording: facts about code, never an
// accusation (docs/LEGAL.md).

import { encodeCall, decode } from './abi.js';

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
export const reasonText = (n) => (REASON_TEXT[n] && n > 0 ? REASON_TEXT[n] : { th: `#${n}`, en: `#${n}` });
/** Shown with every warning or refusal. */
export const DISCLAIMER = { th: 'ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา', en: 'Automated code analysis, not an accusation' };

// EIP-1967 slots (keccak256(name) - 1) and EIP-1167 / ERC-7511 minimal proxies.
export const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const SEL_IMPLEMENTATION = '0x5c60da1b';
const MINIMAL_PROXY = [/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i, /^0x365f5f375f5f365f73([0-9a-f]{40})5af43d5f5f3e5f3d91602a57fd5bf3$/i];

function fromHex(hex) {
  const h = hex.replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---- Neuro's fp1 fingerprint (zetaphy-neuro/src/fingerprint.js): PUSH20/PUSH32 data blanked, metadata dropped, sha256 ----
function codeLengthWithoutMetadata(code) {
  if (code.length < 4) return code.length;
  const metaLen = (code[code.length - 2] << 8) | code[code.length - 1];
  const start = code.length - 2 - metaLen;
  if (metaLen > 0 && start > 0 && code[start] >= 0xa1 && code[start] <= 0xa5) return start;
  return code.length;
}
export async function fingerprint1(codeHex, subtle = globalThis.crypto.subtle) {
  const code = fromHex(codeHex);
  const end = codeLengthWithoutMetadata(code);
  const out = code.slice(0, end);
  for (let pc = 0; pc < end; pc++) {
    const op = out[pc];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x60 + 1;
      if (op === 0x73 || op === 0x7f) out.fill(0, pc + 1, Math.min(pc + 1 + n, end));
      pc += n;
    }
  }
  return '0x' + toHex(new Uint8Array(await subtle.digest('SHA-256', out)));
}

function wordAddress(hex) {
  const h = String(hex ?? '').replace(/^0x/, '');
  if (h.length < 64 || !/^0{24}/.test(h) || /^0{64}$/.test(h.slice(0, 64))) return null;
  return '0x' + h.slice(24, 64);
}

/** Where a proxy forwards its calls (best effort, like the wallet). `rpc(method, params)`. */
export async function proxyTargets(rpc, addr, code) {
  const out = [];
  for (const re of MINIMAL_PROXY) { const m = re.exec(code); if (m) out.push('0x' + m[1].toLowerCase()); }
  const impl = wordAddress(await rpc('eth_getStorageAt', [addr, SLOT_IMPL, 'latest']));
  if (impl) out.push(impl);
  const beacon = wordAddress(await rpc('eth_getStorageAt', [addr, SLOT_BEACON, 'latest']));
  if (beacon) {
    out.push(beacon);
    try { const bi = wordAddress(await rpc('eth_call', [{ to: beacon, data: SEL_IMPLEMENTATION }, 'latest'])); if (bi) out.push(bi); } catch { /* not a beacon */ }
  }
  return [...new Set(out)];
}

const call = (rpc, to, data) => rpc('eth_call', [{ to, data }, 'latest']);

/** The registry's two answers for one address: its address key and its code. */
async function askContract(rpc, registry, addr) {
  const [w, e] = await Promise.all([
    call(rpc, registry, encodeCall('isContractFlagged(address)', [addr])),
    call(rpc, registry, encodeCall('isContractEnforced(address)', [addr])),
  ]);
  return readPair(w, e);
}
async function askFingerprint(rpc, registry, fp) {
  const [w, e] = await Promise.all([
    call(rpc, registry, encodeCall('isFlagged(bytes32)', [fp])),
    call(rpc, registry, encodeCall('isEnforced(bytes32)', [fp])),
  ]);
  return readPair(w, e);
}
function readPair(w, e) {
  const [wf, wr] = decode(['bool', 'uint8'], w);
  const [ef, er] = decode(['bool', 'uint8'], e);
  return { flagged: wf || ef, enforced: ef, reason: Number(ef ? er : wf ? wr : 0n) };
}

/**
 * Checks `token` (and what it forwards to) against the registry.
 * Returns { status: 'clear'|'flagged'|'enforced'|'unknown'|'nocode', reason, via, error }.
 * 'unknown': no registry configured, or it did not answer (the page says so; it does not pretend all is fine).
 */
export async function checkToken(rpc, registry, token) {
  const code = await rpc('eth_getCode', [token, 'latest']);
  if (!code || code === '0x') return { status: 'nocode', reason: 0, via: null };
  if (!registry) return { status: 'unknown', reason: 0, via: null, error: 'noRegistry' };
  try {
    let worst = { status: 'clear', reason: 0, via: null };
    const consider = (r, via) => {
      if (r.enforced && worst.status !== 'enforced') worst = { status: 'enforced', reason: r.reason, via };
      else if (r.flagged && worst.status === 'clear') worst = { status: 'flagged', reason: r.reason, via };
    };
    consider(await askContract(rpc, registry, token), 'address/code');
    consider(await askFingerprint(rpc, registry, await fingerprint1(code)), 'fingerprint');
    let targets = [];
    try { targets = await proxyTargets(rpc, token, code); } catch { targets = []; }
    for (const t of targets.slice(0, 3)) {
      consider(await askContract(rpc, registry, t), `proxy ${t}`);
      const tc = await rpc('eth_getCode', [t, 'latest']);
      if (tc && tc !== '0x') consider(await askFingerprint(rpc, registry, await fingerprint1(tc)), `proxy ${t}`);
    }
    return worst;
  } catch (e) {
    return { status: 'unknown', reason: 0, via: null, error: String(e?.message ?? e) };
  }
}
