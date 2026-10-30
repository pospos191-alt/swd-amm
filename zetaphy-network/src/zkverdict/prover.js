// Proven verdicts, step 2: the Groth16 proof of one score, with the EXISTING circuit and key of
// zetaphy-neuro/ml/onchain/zk/ (circuit generated from the pinned model, key from the phase-2 ceremony). Nothing
// of the circuit, the ceremony or the verifier is changed here: this wraps snarkjs.groth16.fullProve.
//
//   const prover = await createProver({ wasm, zkey });   // the circuit's wasm + the FINAL ceremony zkey
//   const p = await prover.prove(q);                    // q = zfeat/1 u32 features (features.js)
//   p.onChain                                           // true when the proof verifies against the committed verifier
//
// Artifacts (not committed, 5 MB + 11 MB): `cd zetaphy-neuro/ml/onchain/zk && npm ci && node run.js --final` builds
// out/neuro_score_js/neuro_score.wasm and fetches + verifies the final key of the public ceremony. Until that ceremony
// is final, the committed verifier comes from a one-machine rehearsal whose key is not published: a runner then
// proves with another key (e.g. the deterministic initial key out/ceremony/neuro_score_0000.zkey) and `onChain` is
// false; job.js refuses to post such a proof.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { circuitInput, MARGIN_OFFSET } from '../../../zetaphy-neuro/ml/onchain/zk/gen-circuit.js';
import { evalFixed } from '../../../zetaphy-neuro/ml/onchain/fixed.js';
import { verifyGroth16, publicSignals } from '../../../zetaphy-hub/zkverdict-core.js';
import { FIXED, MODEL_BYTES } from './features.js';

export const ZK_DIR = new URL('../../../zetaphy-neuro/ml/onchain/zk/', import.meta.url);
/** The verification key of the committed NeuroScoreVerifier.sol (zetaphy-hub/tools/zkverdict-vkey.mjs). */
export const ONCHAIN_VKEY = JSON.parse(readFileSync(new URL('../../../zetaphy-hub/zkverdict-vkey.json', import.meta.url), 'utf8'));

/** snarkjs as pinned by the zk package (its own npm ci), loaded on demand: runners that never prove need none of it. */
export async function loadSnarkjs() {
  return import(new URL('node_modules/snarkjs/main.js', ZK_DIR).href);
}

/** @noble/curves bn254 + keccak, as the browser uses them (vendored bundle of the same package). */
export async function loadVerifyLib() {
  return import(new URL('../../../zetaphy-hub/vendor/zkverify.js', import.meta.url).href);
}

/** snarkjs proof -> the EVM's order (what ProvenVerdicts / NeuroScoreVerifier take): b's coordinates are (im, re). */
export function evmProof(proof) {
  return {
    a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    b: [[BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]],
    c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  };
}

/**
 * @param {{wasm: string, zkey: string, snarkjs?: object, vkey?: object, verifyLib?: object}} o
 *   vkey: the verification key proofs must pass to be posted (default: the committed verifier's)
 */
export async function createProver({ wasm, zkey, snarkjs = null, vkey = ONCHAIN_VKEY, verifyLib = null }) {
  const sj = snarkjs ?? await loadSnarkjs();
  const lib = verifyLib ?? await loadVerifyLib();
  const zkeySha256 = createHash('sha256').update(readFileSync(zkey)).digest('hex');
  const ownVkey = await sj.zKey.exportVerificationKey(zkey);
  return {
    zkeySha256,
    /** true when this zkey is the one the committed verifier was exported from */
    keyIsOnChain: '0x' + zkeySha256 === vkey.zkeySha256,
    /** Proves `q` (u32 features in the model's order). Throws if the circuit's margin is not the JS fixed-point one. */
    async prove(q, { salt = BigInt('0x' + randomBytes(31).toString('hex')) } = {}) {
      const t0 = performance.now();
      const { proof, publicSignals: ps } = await sj.groth16.fullProve(circuitInput(q, salt), wasm, zkey);
      const proveMs = performance.now() - t0;
      const [commitment, margin, hi, lo] = ps.map(BigInt);
      if (((hi << 128n) | lo) !== BigInt(FIXED.hash)) throw new Error('the circuit is not the pinned model');
      const want = BigInt(evalFixed(MODEL_BYTES, q).margin) + MARGIN_OFFSET;
      if (margin !== want) throw new Error(`circuit margin ${margin - MARGIN_OFFSET} != fixed-point margin ${want - MARGIN_OFFSET}`);
      const t1 = performance.now();
      const ownOk = await sj.groth16.verify(ownVkey, ps, proof);
      const verifyMs = performance.now() - t1;
      const p = evmProof(proof);
      const onChain = verifyGroth16(lib, vkey, p, publicSignals(commitment, margin, vkey.modelHash));
      return { ...p, commitment, margin, salt, proveMs, verifyMs, ownOk, onChain };
    },
    /** Stops snarkjs' worker threads (else a Node process that proved stays alive). */
    async close() {
      const curve = await sj.curves.getCurveFromName('bn128');
      await curve.terminate();
    },
  };
}
