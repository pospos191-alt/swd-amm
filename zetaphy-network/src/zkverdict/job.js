// Proven verdicts, step 3: the runner's job. For each token: read its code, derive zfeat/1 (features.js), prove the
// pinned model's score on it (prover.js), check the proof locally against the committed verifier, and post the
// verdicts to ProvenVerdicts, several per transaction (submitBatch) when there are several.
//
//   const r = await provenVerdictJob({ call, tokens, prover, submit, batchSize: 4 });
//
// `call` is the EVM JSON-RPC of the chain, `submit(proofs[])` sends ProvenVerdicts.submit / submitBatch (the CLI or a
// test wires it to a contract). A proof that would not verify on-chain (a key other than the ceremony's final one),
// or whose margin is not the model's on the posted features, is never sent: posting it would only get the runner
// slashed (ProvenVerdicts.challengeScore) or reverted.

import { zfeat1, FIXED } from './features.js';
import { MARGIN_OFFSET } from '../../../zetaphy-neuro/ml/onchain/zk/gen-circuit.js';

const enc = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0');
/** bytes32 model id the contract checks (ProvenVerdicts.modelId), e.g. "nml-b4c35477f7b1". */
export const MODEL_ID = enc(FIXED.modelId);

/** The ProvenVerdicts.Proof struct for a token, its zfeat/1 features and a proof of them. */
export function proofStruct(token, f, p, modelId = MODEL_ID) {
  return { token, modelId, features: f.packed, a: p.a, b: p.b, c: p.c, commitment: p.commitment, margin: p.margin };
}

/**
 * @param {object} o
 * @param {(method: string, params: any[]) => Promise<any>} o.call
 * @param {string[]} o.tokens
 * @param {{prove: (q: number[]) => Promise<object>}} o.prover
 * @param {(proofs: object[]) => Promise<any>} o.submit
 * @param {number} [o.batchSize]  verdicts per transaction (1 = submit)
 * @returns {{posted: object[], skipped: {token, reason}[], timings: number[]}}
 */
export async function provenVerdictJob({ call, tokens, prover, submit, batchSize = 4, log = () => {} }) {
  const ready = [];
  const skipped = [];
  const timings = [];
  for (const token of tokens) {
    let f;
    try {
      const code = await call('eth_getCode', [token, 'latest']);
      f = zfeat1(code);
    } catch (e) { skipped.push({ token, reason: `features: ${e.message}` }); continue; }
    let p;
    try { p = await prover.prove(f.q); } catch (e) { skipped.push({ token, reason: `prove: ${e.message}` }); continue; }
    if (p.proveMs != null) timings.push(p.proveMs);
    if (BigInt(p.margin) !== BigInt(f.margin) + MARGIN_OFFSET) { skipped.push({ token, reason: 'the proof is not for these features (margin differs)' }); continue; }
    if (!p.onChain) { skipped.push({ token, reason: 'the proof does not verify against the committed verifier (not the ceremony\'s final key)' }); continue; }
    ready.push({ token, f, p, s: proofStruct(token, f, p) });
    log(`${token}: score ${f.score} (level ${f.level}), proved${p.proveMs != null ? ` in ${Math.round(p.proveMs)} ms` : ''}`);
  }
  const posted = [];
  for (let i = 0; i < ready.length; i += Math.max(1, batchSize)) {
    const chunk = ready.slice(i, i + Math.max(1, batchSize));
    await submit(chunk.map((x) => x.s));
    posted.push(...chunk.map((x) => ({ token: x.token, score: x.f.score, level: x.f.level, featuresHash: x.f.featuresHash, codeHash: x.f.codeHash })));
  }
  return { posted, skipped, timings };
}
