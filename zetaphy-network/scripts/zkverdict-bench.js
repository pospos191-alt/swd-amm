#!/usr/bin/env node
// Proven verdicts: prove-time benchmark (docs/future/proven-verdicts.md, "Measured").
//   node scripts/zkverdict-bench.js [--zk-out <zetaphy-neuro/ml/onchain/zk/out>] [--zkey <file>] [--n 3]
// Proves the zfeat/1 features of a few of this repo's compiled contracts (real code-derived vectors) with the
// existing circuit, then verifies each proof three ways: snarkjs against the key's own verification key, and the
// browser's pure-JS check (zetaphy-hub/zkverdict-core.js) against that key and against the committed verifier.
// Needs `npm ci` in zetaphy-neuro/ml/onchain/zk and its out/ artifacts (node run.js builds them). With a key other
// than the ceremony's final one (e.g. the deterministic initial key out/ceremony/neuro_score_0000.zkey) the proofs
// are valid under that key only, and "onChain" is false: that measures time, not a postable proof.

import { readFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { createProver, loadVerifyLib } from '../src/zkverdict/prover.js';
import { zfeat1, FIXED } from '../src/zkverdict/features.js';
import { verifyGroth16, publicSignals } from '../../zetaphy-hub/zkverdict-core.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('zk-out', new URL('../../zetaphy-neuro/ml/onchain/zk/out/', import.meta.url).pathname).replace(/\/?$/, '/');
const wasm = `${OUT}neuro_score_js/neuro_score.wasm`;
const zkey = arg('zkey', `${OUT}ceremony/neuro_score_0000.zkey`);
const N = Number(arg('n', 3));
for (const f of [wasm, zkey]) if (!existsSync(f)) { console.error(`missing ${f}: run node run.js in zetaphy-neuro/ml/onchain/zk first`); process.exit(2); }

const prover = await createProver({ wasm, zkey });
const sj = await import(new URL('../../zetaphy-neuro/ml/onchain/zk/node_modules/snarkjs/main.js', import.meta.url).href);
const ownVk = await sj.zKey.exportVerificationKey(zkey);
const toCore = (vk) => ({
  ic: vk.IC.map((p) => [p[0], p[1]]),
  alpha: [vk.vk_alpha_1[0], vk.vk_alpha_1[1]],
  beta: [vk.vk_beta_2[0][1], vk.vk_beta_2[0][0], vk.vk_beta_2[1][1], vk.vk_beta_2[1][0]],
  gamma: [vk.vk_gamma_2[0][1], vk.vk_gamma_2[0][0], vk.vk_gamma_2[1][1], vk.vk_gamma_2[1][0]],
  delta: [vk.vk_delta_2[0][1], vk.vk_delta_2[0][0], vk.vk_delta_2[1][1], vk.vk_delta_2[1][0]],
});
const ownCore = toCore(ownVk);
const lib = await loadVerifyLib();
const names = ['TestStable', 'NeuroJobs', 'ThreatRegistry', 'ZetaphyPoints', 'NeuroAttest'].slice(0, N);
const rows = [];
for (const n of names) {
  const code = JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8')).deployedBytecode;
  const f = zfeat1(code);
  const p = await prover.prove(f.q);
  const pub = publicSignals(p.commitment, p.margin, FIXED.hash);
  const t = performance.now();
  const jsOk = verifyGroth16(lib, ownCore, p, pub);
  const jsMs = performance.now() - t;
  rows.push({ contract: n, score: f.score, level: f.level, proveMs: Math.round(p.proveMs), snarkjsVerifyMs: Math.round(p.verifyMs), snarkjsOk: p.ownOk, pureJsVerifyMs: Math.round(jsMs), pureJsOk: jsOk, onChain: p.onChain });
  console.log(rows.at(-1));
}
const ms = rows.map((r) => r.proveMs);
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, zkey, keyIsOnChain: prover.keyIsOnChain,
  proveMs: { min: Math.min(...ms), max: Math.max(...ms), mean: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) } }, null, 1));
process.exit(0); // snarkjs keeps worker threads alive
