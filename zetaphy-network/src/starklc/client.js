// The phone/browser side of the STARK light client: only the verifier (no
// prover, no RPC). Bundled for the explorer's light-client page.
import { bytesToHex } from '@noble/hashes/utils.js';
import { verifyProof, ProofError } from './verifier.js';
export { verifyProof, ProofError };
export { decodeProof } from './proof.js';

/** The phone/browser side: a pinned set, advanced epoch by epoch with handoff proofs. */
export class StarkLightClient {
  constructor({ chainId, pin, epoch = 0, minSigBits = 128, minStarkBits = 100 }) {
    if (!chainId || !pin?.root) throw new Error('light client: chainId and a pinned set { root, logN, logBlowup } are needed');
    this.chainId = chainId;
    this.pin = { root: typeof pin.root === 'string' ? pin.root.toLowerCase() : bytesToHex(pin.root), logN: pin.logN, logBlowup: pin.logBlowup };
    this.epoch = BigInt(epoch);
    this.opts = { minSigBits, minStarkBits };
  }

  /** Verifies a block proof under the current set: the result of verifyProof, with ok = rule holds. */
  verifyBlock(bytes, opts = {}) {
    const r = verifyProof(bytes, { pin: this.pin, chainId: this.chainId, ...this.opts, ...opts });
    if (r.statement.kind !== 'block') throw new ProofError('not a block proof');
    return r;
  }

  /** Moves to the next epoch's set when the current set certified it with more than 2/3 of all its power. */
  applyHandoff(bytes, opts = {}) {
    const r = verifyProof(bytes, { pin: this.pin, chainId: this.chainId, ...this.opts, ...opts });
    if (r.statement.kind !== 'handoff') throw new ProofError('not a handoff proof');
    if (BigInt(r.statement.height) !== this.epoch + 1n) throw new ProofError(`handoff is to epoch ${r.statement.height}, expected ${this.epoch + 1n}`);
    if (!r.pqMajority) throw new ProofError('handoff not signed by more than 2/3 of the power');
    this.pin = { root: r.statement.hash, logN: r.statement.nextLogN, logBlowup: r.statement.nextLogBlowup };
    this.epoch += 1n;
    return r;
  }
}
