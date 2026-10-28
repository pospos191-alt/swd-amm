// Quantum-safe AI attestations, Node side (item 30): sign a Neuro report or verdict with this machine's ML-DSA-44
// key (~/.zetaphy/pq.seed, the same key as `zetaphy pq`), verify an archive (tamper detection), anchor its hash on
// ZETAPHY (NeuroAnchor). The format and the checks are zetaphy-hub/pqattest.js, shared with the browser verifier.
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { buildArchive, verifyArchive, archiveHash, FORMAT } from '../../zetaphy-hub/pqattest.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';

export { FORMAT, archiveHash };
/** The crypto pqattest.js needs, from @noble (the same libraries as the wallet's vendor/pqwallet.js). */
export const NODE_CRYPTO = {
  sha256: (b) => sha256(b),
  keccak256: (b) => keccak_256(b),
  verify: (sig, msg, pub) => ml_dsa44.verify(sig, msg, pub),
};

/** The payload for a Neuro report (zetaphy-neuro `node cli.js <chain> <address> --json`): its verdict hash, skill, model. */
export async function reportPayload(report, { skill, model = 'rules', createdAt = new Date().toISOString(), includeReport = true } = {}) {
  if (!report || typeof report !== 'object' || !report.chain) throw new Error('not a Neuro report (no chain)');
  return {
    kind: 'neuro-report', createdAt,
    subject: { chain: String(report.chain), address: String(report.raw ?? report.address ?? '').toLowerCase() },
    reportHash: await verdictOf(report), skill: String(skill ?? ''), model: String(model),
    ...(includeReport ? { report: JSON.parse(JSON.stringify(report)) } : {}),
  };
}

/** Signs a payload with an ML-DSA-44 key ({ publicKeyBytes, signBytes } from src/pq.js pqFromSeed). */
export const signPayload = (payload, key) => buildArchive(payload, key.publicKeyBytes, { ...NODE_CRYPTO, sign: (m) => key.signBytes(m) });

/** A report in the payload must give the payload's reportHash again (Neuro's verdict.js): else it was swapped. */
export async function checkReport(payload) {
  if (!payload?.report) return null;
  return (await verdictOf(payload.report)) === payload.reportHash ? null : 'the report in the payload does not give its reportHash (verdict.js)';
}

/** Verifies an archive; `provider` (optional): checks the anchor on ZETAPHY. */
export async function verifyFile(archive, { provider = null, trustedKeys = [] } = {}) {
  const anchorOf = provider ? async (hash, anchor) => {
    const data = '0x9591a610' + hash.slice(2);
    const r = await provider.call({ to: anchor.contract, data });
    const h = r.slice(2);
    return { time: Number(BigInt(`0x${h.slice(0, 64)}`)), block: Number(BigInt(`0x${h.slice(64, 128)}`)) };
  } : null;
  return verifyArchive(archive, NODE_CRYPTO, { anchorOf, checkReport, trustedKeys });
}
