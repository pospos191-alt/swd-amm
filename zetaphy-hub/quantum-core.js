// The "Quantum safety" tab's logic (quantum.js), pure and testable (test/quantum.test.mjs):
//   - the network's Q-day readiness from the quantum-exposure inventory (zetaphy-network/src/qsafe/inventory.js,
//     summarised into hub-config.json `qsafe` by build.mjs);
//   - the verdict for one address (explorer/src/quantum.js quantumExposure, plus the chain's zetaphy_migration);
//   - a QuantumRescue pre-commitment (contracts/QuantumRescue.sol; the same as zetaphy-network/src/qsafe/rescue.js).
// Keccak comes in as `k` (Neuro's keccak256 in the browser, ethers' in tests).
import { encodeArgs, decodeArgs, calldata, keccakHex, strip } from './work-core.js';

export { calldata, keccakHex };
export const PK_BYTES = 1312; // ML-DSA-44
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const Z32 = `0x${'00'.repeat(32)}`;

/** QuantumRescue functions the tab calls (selectors are keccak256 of these, checked in tests). */
export const SIG = {
  commit: 'commit(bytes32)', slotOf: 'slotOf(address)', effectiveCommitment: 'effectiveCommitment(address)',
  controllerOf: 'controllerOf(address)', qdayHeight: 'qdayHeight()', maturity: 'maturity()',
};

/** keccak256(abi.encode("ZETAPHY QuantumRescue v1", chainId, contract, account, keyHash, secret)): QuantumRescue.commitmentOf. */
export function rescueCommitment(k, { chainId, contract, account, keyHash, secret }) {
  if (!ADDR.test(contract) || !ADDR.test(account)) throw new Error('address');
  if (!HEX32.test(keyHash) || !HEX32.test(secret)) throw new Error('bytes32');
  return keccakHex(k, encodeArgs(['string', 'uint256', 'address', 'address', 'bytes32', 'bytes32'],
    ['ZETAPHY QuantumRescue v1', BigInt(chainId), contract, account, keyHash, secret]));
}

/** keccak256 of an ML-DSA-44 public key given as hex (1312 bytes), or null. */
export function keyHashOf(k, pkHex) {
  const h = strip(String(pkHex ?? '').trim());
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length !== PK_BYTES * 2) return null;
  return keccakHex(k, `0x${h}`);
}

/** Decoded reads of an account's rescue state: { slot, effective, controller, qday, maturity }. */
export function decodeRescueReads({ slot, effective, controller, qday, maturity }) {
  const [active, pending, pendingAt] = decodeArgs(['bytes32', 'bytes32', 'uint64'], slot);
  return {
    slot: [active, pending, pendingAt],
    effective: decodeArgs(['bytes32'], effective)[0],
    controller: decodeArgs(['address'], controller)[0],
    qday: decodeArgs(['uint64'], qday)[0],
    maturity: decodeArgs(['uint64'], maturity)[0],
  };
}

/** Where an account stands with QuantumRescue (the same rule as zetaphy-network/src/qsafe/rescue.js rescueState). */
export function rescueState({ slot, effective, controller, qday, block, maturity }) {
  const zeroAddr = (a) => !a || /^0x0{40}$/i.test(a);
  if (!zeroAddr(controller)) return { state: 'rescued', controller };
  const [active, pending, pendingAt] = slot;
  const q = BigInt(qday ?? 0), b = BigInt(block), m = BigInt(maturity), at = BigInt(pendingAt ?? 0);
  const reached = q !== 0n && b >= q;
  if (effective && effective !== Z32) {
    return { state: reached ? 'revealable' : 'committed', commitment: effective, pending: at !== 0n && pending !== effective ? pending : null };
  }
  if (at !== 0n && pending !== Z32) {
    const countsFrom = at + m;
    return { state: q !== 0n && countsFrom > q ? 'too-late' : 'maturing', countsFrom, commitment: pending };
  }
  return { state: reached ? 'frozen' : 'none', commitment: active === Z32 ? null : active };
}

/**
 * The one thing to do next for an address, from the explorer's exposure level (quantumExposure().level) and the
 * chain's migration answer ({ migrated, pendingController } or null) and the rescue state (or null):
 *   'safe' (ML-DSA account, locked, or migrated) | 'contract' | 'lock' (exposed or hidden key: lock it now) |
 *   'rescue' (as 'lock', and a rescue pre-commitment is still possible) | 'covered' (a rescue commitment is in force) | 'unknown'
 */
export function nextStep({ level, migration = null, rescue = null }) {
  if (level === 'pq' || level === 'locked' || migration?.migrated === true || rescue === 'rescued') return 'safe';
  if (level === 'contract') return 'contract';
  if (level === 'unknown') return 'unknown';
  if (rescue === 'committed' || rescue === 'revealable' || rescue === 'maturing') return 'covered';
  return rescue === 'frozen' || rescue === 'too-late' ? 'lock' : 'rescue';
}

/** A readiness grade from the inventory score (0-100): 'low' < 50 <= 'medium' < 80 <= 'high'. */
export const grade = (score) => (score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low');

/** hub-config.json `qsafe` as the tab shows it, or null if missing / malformed. */
export function readiness(q) {
  if (!q || !Number.isInteger(q.score) || q.score < 0 || q.score > 100 || !Number.isInteger(q.total)) return null;
  const st = q.byStatus ?? {};
  const n = (x) => (Number.isInteger(st[x]) ? st[x] : 0);
  const open = (Array.isArray(q.open) ? q.open : []).filter((o) => o && /^[a-z0-9-]{1,40}$/.test(o.id ?? '')).slice(0, 8)
    .map((o) => ({ id: o.id, component: String(o.component ?? '').slice(0, 90), status: String(o.status ?? ''), impact: String(o.impact ?? '') }));
  return { score: q.score, grade: grade(q.score), total: q.total, pq: n('pq'), hybrid: n('hybrid'), partial: n('partial'), classical: n('classical'), open };
}

/** The text a user keeps offline for the reveal after Q-day (`zetaphy qsafe rescue-reveal` reads it). Seed only if the browser made the key. */
export function rescueKit({ chainId, contract, account, keyHash, controller, secret, seed = null }) {
  return JSON.stringify({
    kind: 'zetaphy-quantum-rescue-v1', chainId: Number(chainId), contract, account, keyHash, controller, secret,
    ...(seed ? { mldsa44Seed: seed } : {}),
    note: 'Keep this offline and private. After Q-day the reveal needs the secret and the ML-DSA-44 key (its seed).',
  }, null, 2);
}
