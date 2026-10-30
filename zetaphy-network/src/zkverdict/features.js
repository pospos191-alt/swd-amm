// Proven verdicts, step 1: the features a proof is about, re-derivable by anyone from the token's code.
//
// Profile "zfeat/1" (docs/future/proven-verdicts.md): the on-chain model's 133 features
// (zetaphy-neuro/ml/onchain/model.fixed.json, its own feature list) computed ONLY from the token's runtime bytecode:
//   - selectors and opcodes: zetaphy-neuro/src/bytecode.js scanBytecode (the reader's own scan)
//   - the rules: zetaphy-neuro/src/analyze.js analyze() fed nothing but that scan (no RPC reads: no name, symbol,
//     owner, proxy storage slots, known-token list, similarity dataset or ThreatRegistry; an EIP-1167 clone is
//     recognised from its bytes)
//   - the ML extractor: zetaphy-neuro/ml/features.js extractFeatures({ report, code }) (no simulation, no market:
//     m_* = 0 and every k_* unknown), quantized as NeuroScore takes it (ml/onchain/fixed.js, S = 1e7)
// So the vector is a pure function of the code, whose keccak256 (EXTCODEHASH) ProvenVerdicts records when a verdict
// lands. Anyone with the code recomputes it bit for bit; NeuroJobs runners do so for a "zfeat/1:<token>:<codehash>"
// job (src/worker.js) and reveal keccak256(packed features), which settles a contest.
// It is NOT the full Neuro report (no trade simulation, no holders, no rules that need RPC reads): the proven score
// is "the pinned model on the code-only features", which can differ from the score the Neuro site shows.

import { readFileSync } from 'node:fs';
import { keccak256 } from 'ethers';
import { scanBytecode, minimalProxyTarget, hexToBytes } from '../../../zetaphy-neuro/src/bytecode.js';
import { analyze } from '../../../zetaphy-neuro/src/analyze.js';
import { extractFeatures, toVector } from '../../../zetaphy-neuro/ml/features.js';
import { quantizeVector, packFeatures, evalFixed, fromHex, levelOf } from '../../../zetaphy-neuro/ml/onchain/fixed.js';

export const PROFILE = 'zfeat/1';
/** The pinned on-chain model (bound to the zk circuit and its ceremony): read only, never written here. */
export const FIXED = JSON.parse(readFileSync(new URL('../../../zetaphy-neuro/ml/onchain/model.fixed.json', import.meta.url), 'utf8'));
export const MODEL_BYTES = fromHex(FIXED.bytes);

const HEX = /^0x([0-9a-fA-F]{2})+$/;

/** The code-only report zfeat/1 feeds the ML extractor. */
export function codeReport(code) {
  const scan = scanBytecode(code);
  const clone = minimalProxyTarget(hexToBytes(code));
  const proxy = clone ? { kind: 'eip1167', implementation: clone } : { kind: null };
  const analysis = analyze({ hasCode: true, functions: scan.functions, opcodes: scan.opcodes, proxy, token: {}, owner: undefined,
    unknownSelectors: scan.unknownSelectors, dispatched: scan.selectors.length });
  return { analysis, proxy, functions: scan.functions.map((f) => f.sig).sort(), unknownSelectors: scan.unknownSelectors };
}

/**
 * zfeat/1 of runtime code (0x hex): { q: u32[] (model order), packed (0x hex, what ProvenVerdicts takes),
 * featuresHash (keccak256 of packed), codeHash (keccak256 of the code = EXTCODEHASH), margin, score, level }.
 */
export function zfeat1(code) {
  if (typeof code !== 'string' || !HEX.test(code)) throw new Error('zfeat/1: runtime code must be non-empty 0x hex');
  const lower = code.toLowerCase();
  const named = extractFeatures({ report: codeReport(lower), code: lower });
  const q = quantizeVector(toVector(named, FIXED.features));
  const packed = packFeatures(q);
  const { margin, score } = evalFixed(MODEL_BYTES, q);
  return { q, packed, featuresHash: keccak256(packed), codeHash: keccak256(lower), margin, score, level: levelOf(score, FIXED.levels) };
}

/** The NeuroJobs target that settles a contest (ProvenVerdicts.featureTarget): "zfeat/1:<token>:<codehash>". */
export const featureTarget = (token, codeHash) => `${PROFILE}:${String(token).toLowerCase()}:${String(codeHash).toLowerCase()}`;

/** Parses a feature target; null when it is not one. */
export function parseFeatureTarget(target) {
  const m = /^zfeat\/1:(0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/.exec(String(target));
  return m ? { token: m[1], codeHash: m[2] } : null;
}

/**
 * A NeuroJobs runner's verdict on a feature job: reads the token's code (eth_getCode), refuses code whose hash is not
 * the target's (it changed, or a wrong target), and returns keccak256 of its zfeat/1 features (bytes32 hex).
 * @param {(method: string, params: any[]) => Promise<any>} call  EVM JSON-RPC of chain "zetaphy"
 */
export async function featureVerdict(call, target) {
  const t = parseFeatureTarget(target);
  if (!t) throw new Error(`not a ${PROFILE} target`);
  const code = await call('eth_getCode', [t.token, 'latest']);
  if (typeof code !== 'string' || !HEX.test(code)) throw new Error('no code at the token');
  const f = zfeat1(code);
  if (f.codeHash !== t.codeHash) throw new Error(`code hash ${f.codeHash} is not the target's ${t.codeHash}`);
  return { verdict: f.featuresHash, features: f };
}
