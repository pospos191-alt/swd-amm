// ZETAPHY audit certificate badge (docs/future/audit-network.md): AuditCertificate.certificate(chainId, address)
// read with one eth_call per address and remembered for the visit, like the Neuro risk badges (risk.js). The
// contract itself re-checks the address's EXTCODEHASH, so an upgraded or redeployed contract shows no badge.
// A certificate says "passed the ZETAPHY audit process at this codeHash on this date": never "safe".
import { h } from './dom.js';

const ADDR = /^0x[0-9a-f]{40}$/;
/** keccak256('certificate(uint64,address)')[0..4] (checked in test/unit.test.js). */
export const SEL_CERTIFICATE = '0xa5e5358f';
export const LEVELS = ['', 'Bronze', 'Silver', 'Gold'];

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const uint = (hex, i) => BigInt(`0x${word(hex, i) || '0'}`);

/** The eth_call data of certificate(chainId, address). */
export const certificateCall = (chainId, address) =>
  `${SEL_CERTIFICATE}${BigInt(chainId).toString(16).padStart(64, '0')}${String(address).slice(2).toLowerCase().padStart(64, '0')}`;

/**
 * Decodes certificate(...) -> (Cert, bool): { state: 'none' | 'valid' | 'invalid', level, expiresAt, issuedAt,
 * revoked, codeHash, reportHash, requestId }. Cert = (requestId, chainId, target, codeHash, reportHash, sourceHash,
 * level, auditors, mutationBps, issuedAt, expiresAt, revokedAt, revokedBy), then valid.
 */
export function decodeCertificate(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex) || hex.length < 2 + 14 * 64) throw new Error('bad certificate data');
  const issuedAt = uint(hex, 9);
  if (issuedAt === 0n) return { state: 'none' };
  return {
    state: uint(hex, 13) === 1n ? 'valid' : 'invalid',
    requestId: uint(hex, 0), codeHash: `0x${word(hex, 3)}`, reportHash: `0x${word(hex, 4)}`, level: Number(uint(hex, 6)), auditors: Number(uint(hex, 7)),
    mutationBps: Number(uint(hex, 8)), issuedAt: Number(issuedAt), expiresAt: Number(uint(hex, 10)), revoked: uint(hex, 11) !== 0n || uint(hex, 12) !== 0n,
  };
}

/** EIP-1967 implementation slot: a proxy's own bytecode never changes on an upgrade, its implementation does. */
export const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/**
 * single(method, params) -> result. Returns { lookup(address) -> Promise<Result> } (Result: decodeCertificate's, or
 * { state: 'unset' | 'error' }). For an EIP-1967 proxy the badge holds only while the CURRENT implementation is
 * certified too (Result.implementation, Result.implState), so an upgrade to unaudited code drops it at once.
 */
export function createAudit({ single, contract, chainId }) {
  const cache = new Map();
  const read = (a) => single('eth_call', [{ to: contract, data: certificateCall(chainId, a) }, 'latest']).then(decodeCertificate);
  async function resolve(a) {
    const [own, slot] = await Promise.all([read(a), single('eth_getStorageAt', [a, IMPL_SLOT, 'latest']).catch(() => '0x0')]);
    const impl = /^0x[0-9a-fA-F]{1,64}$/.test(String(slot)) ? `0x${String(slot).slice(2).padStart(64, '0').slice(24)}`.toLowerCase() : null;
    if (!impl || /^0x0{40}$/.test(impl) || own.state === 'none') return own;
    const ic = await read(impl);
    return { ...own, implementation: impl, implState: ic.state, state: own.state === 'valid' && ic.state !== 'valid' ? 'invalid' : own.state };
  }
  function lookup(address) {
    const a = String(address ?? '').toLowerCase();
    if (!contract || !ADDR.test(String(contract).toLowerCase())) return Promise.resolve({ state: 'unset' });
    if (!ADDR.test(a)) return Promise.resolve({ state: 'error' });
    if (!cache.has(a)) cache.set(a, resolve(a).catch(() => { cache.delete(a); return { state: 'error' }; }));
    return cache.get(a);
  }
  return { lookup };
}

let current = null;
export const setAudit = (x) => { current = x; };
export const getAudit = () => current;

const day = (sec, lang) => { try { return new Date(sec * 1000).toLocaleDateString(lang === 'en' ? 'en-GB' : lang); } catch { return new Date(sec * 1000).toISOString().slice(0, 10); } };

/**
 * The badge after an address or token title: empty while loading, without a certificate or when the
 * contract is not set; "Audited · Gold · until …" when valid; "Audit certificate not valid" when it was
 * revoked, expired or the code changed. t: the page's texts, lang: its language.
 */
export function auditBadge(address, { t, lang }) {
  const el = h('span', { class: 'audit-slot' });
  if (!current) return el;
  current.lookup(address).then((r) => {
    if (r.state === 'valid') {
      const lvl = t(`auditLevel${r.level}`);
      el.append(h('span', { class: ['badge', 'badge-ok', 'audit-badge'], title: `${t('auditTip', { level: lvl, date: day(r.issuedAt, lang), until: day(r.expiresAt, lang), code: r.codeHash.slice(0, 10) })}` },
        `✓ ${t('auditCertified')} · ${lvl} · ${t('auditUntil', { date: day(r.expiresAt, lang) })}`));
    } else if (r.state === 'invalid') {
      el.append(h('span', { class: ['badge', 'badge-warn', 'audit-badge'], title: t(r.revoked ? 'auditRevokedTip' : 'auditInvalidTip') },
        `${t(r.revoked ? 'auditRevoked' : 'auditInvalid')}`));
    }
  });
  return el;
}
