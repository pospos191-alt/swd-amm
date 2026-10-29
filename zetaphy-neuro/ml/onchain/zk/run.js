#!/usr/bin/env node
// zkML prototype for Neuro's model: builds the circuit, a (testnet-only) Groth16
// setup, proves held-out rows, verifies them, exports the Solidity verifier and
// reports sizes and timings honestly (measured on the machine that runs it).
//
//   cd zetaphy-neuro/ml/onchain/zk && npm ci && node run.js [--rows 5] [--install]
//
// Steps (outputs in ml/onchain/zk/out/, not committed):
//   1. circuit from ml/onchain/model.fixed.json (gen-circuit.js), compiled with circom 2 (circom2: WASM build, no Rust)
//   2. powers of tau (bn128, 2^power) made HERE with one random contribution, then the
//      circuit-specific phase 2 with one more. A setup one machine made alone is only
//      good for a testnet: whoever ran it could keep the randomness and forge proofs.
//      A real deployment needs a public multi-party ceremony (see docs/future/onchain-ml.md).
//   3. for --rows held-out rows: witness + Groth16 proof (timed), verification (timed),
//      checks that the public margin = the JS fixed-point margin and the hash = H
//   4. NeuroScoreVerifier.sol (snarkjs' Groth16 template) + the first proof as a fixture
//   --install copies the verifier to zetaphy-network/contracts/ and the fixture to
//   zetaphy-network/test/fixtures/neuroscore-zk.json (what the on-chain test uses).

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as snarkjs from 'snarkjs';
import { circuitSource, circuitInput, MARGIN_OFFSET } from './gen-circuit.js';
import { fromHex, evalFixed, quantizeVector } from '../fixed.js';

const HERE = new URL('./', import.meta.url);
const OUT = new URL('./out/', HERE);
const p = (u) => u.pathname;
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const ROWS = Number(arg('rows', 5));
const POWER = Number(arg('power', 15));
const NM = new URL('./node_modules/', HERE);
const SNARKJS_CLI = p(new URL('snarkjs/build/cli.cjs', NM));
const CIRCOM = p(new URL('circom2/cli.js', NM));

function run(file, args, cwd = p(OUT)) {
  const t = performance.now();
  const r = spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${args[0]} failed:\n${r.stdout}\n${r.stderr}`);
  return { ms: performance.now() - t, out: r.stdout };
}
const secs = (ms) => Math.round(ms) / 1000;
const entropy = () => randomBytes(32).toString('hex');

mkdirSync(OUT, { recursive: true });
const report = { when: new Date().toISOString(), node: process.version, cpu: (await import('node:os')).cpus()[0]?.model, steps: {} };

// 1. circuit
const fixed = JSON.parse(readFileSync(new URL('../model.fixed.json', HERE), 'utf8'));
const bytes = fromHex(fixed.bytes);
writeFileSync(new URL('neuro_score.circom', OUT), circuitSource(bytes, fixed.hash));
// circom2 (WASI) only sees the working directory: relative paths from here
const comp = run(CIRCOM, ['out/neuro_score.circom', '--r1cs', '--wasm', '-l', 'node_modules', '-o', 'out'], p(HERE));
const info = await snarkjs.r1cs.info(p(new URL('neuro_score.r1cs', OUT)));
report.model = { id: fixed.modelId, hash: fixed.hash, trees: fixed.trees, features: fixed.features.length };
report.circuit = { constraints: info.nConstraints, wires: info.nVars, publicOutputs: info.nOutputs, privateInputs: info.nPrvInputs, compileSeconds: secs(comp.ms) };
if (info.nConstraints > 2 ** POWER) throw new Error(`${info.nConstraints} constraints need --power ${Math.ceil(Math.log2(info.nConstraints))}`);
console.log(`circuit: ${info.nConstraints} constraints (compiled in ${secs(comp.ms)} s)`);

// 2. setup
const ptau = `pot${POWER}_final.ptau`;
if (!existsSync(new URL(ptau, OUT))) {
  const a = run(SNARKJS_CLI, ['powersoftau', 'new', 'bn128', String(POWER), `pot${POWER}_0.ptau`]);
  const b = run(SNARKJS_CLI, ['powersoftau', 'contribute', `pot${POWER}_0.ptau`, `pot${POWER}_1.ptau`, '--name=local', `-e=${entropy()}`]);
  const c = run(SNARKJS_CLI, ['powersoftau', 'prepare', 'phase2', `pot${POWER}_1.ptau`, ptau]);
  report.steps.powersOfTau = { power: POWER, seconds: secs(a.ms + b.ms + c.ms) };
}
const s1 = run(SNARKJS_CLI, ['groth16', 'setup', 'neuro_score.r1cs', ptau, 'neuro_score_0.zkey']);
const s2 = run(SNARKJS_CLI, ['zkey', 'contribute', 'neuro_score_0.zkey', 'neuro_score.zkey', '--name=local', `-e=${entropy()}`]);
report.steps.groth16Setup = { seconds: secs(s1.ms + s2.ms), zkeyBytes: statSync(new URL('neuro_score.zkey', OUT)).size };
const vkey = await snarkjs.zKey.exportVerificationKey(p(new URL('neuro_score.zkey', OUT)));
writeFileSync(new URL('verification_key.json', OUT), JSON.stringify(vkey, null, 1));
console.log(`setup done (${report.steps.groth16Setup.seconds} s, zkey ${report.steps.groth16Setup.zkeyBytes} bytes)`);

// 3. prove held-out rows
const held = JSON.parse(readFileSync(new URL('../heldout.json', HERE), 'utf8'));
const H = BigInt(fixed.hash);
const proofs = [];
for (const row of held.rows.slice(0, ROWS)) {
  const v = new Array(fixed.features.length).fill(0);
  for (const [i, x] of row.x) v[i] = x;
  const q = quantizeVector(v);
  const salt = BigInt('0x' + randomBytes(31).toString('hex'));
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput(q, salt), p(new URL('neuro_score_js/neuro_score.wasm', OUT)), p(new URL('neuro_score.zkey', OUT)));
  const proveMs = performance.now() - t0;
  const t1 = performance.now();
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  const verifyMs = performance.now() - t1;
  const [commitment, margin, hi, lo] = publicSignals.map(BigInt);
  const want = BigInt(evalFixed(bytes, q).margin) + MARGIN_OFFSET;
  if (!ok) throw new Error(`${row.id}: proof does not verify`);
  if (margin !== want) throw new Error(`${row.id}: circuit margin ${margin - MARGIN_OFFSET} != JS fixed ${want - MARGIN_OFFSET}`);
  if (((hi << 128n) | lo) !== H) throw new Error(`${row.id}: model hash in the proof is not H`);
  proofs.push({ id: row.id, proveSeconds: secs(proveMs), verifySeconds: secs(verifyMs), proof, publicSignals, commitment: String(commitment) });
  console.log(`${row.id}: proved in ${secs(proveMs)} s, verified in ${secs(verifyMs)} s, margin ${margin - MARGIN_OFFSET}`);
}
const prove = proofs.map((x) => x.proveSeconds);
report.proofs = {
  rows: proofs.length,
  proveSeconds: { min: Math.min(...prove), max: Math.max(...prove), mean: Math.round((prove.reduce((a, b) => a + b, 0) / prove.length) * 1000) / 1000 },
  verifySecondsJs: Math.max(...proofs.map((x) => x.verifySeconds)),
  proofBytesOnChain: 256, // Groth16: A (G1), B (G2), C (G1) = 8 x 32-byte words
  proofBytesJson: JSON.stringify(proofs[0].proof).length,
  publicSignals: 4,
};

// 4. Solidity verifier + fixture
const template = readFileSync(new URL('snarkjs/templates/verifier_groth16.sol.ejs', NM), 'utf8');
let sol = await snarkjs.zKey.exportSolidityVerifier(p(new URL('neuro_score.zkey', OUT)), { groth16: template });
sol = sol.replace(/contract Groth16Verifier/, 'contract NeuroScoreVerifier').replace(/pragma solidity [^;]+;/, 'pragma solidity 0.8.26;');
sol = `// GENERATED by zetaphy-neuro/ml/onchain/zk/run.js (snarkjs ${JSON.parse(readFileSync(new URL('snarkjs/package.json', NM), 'utf8')).version} Groth16 template) for model ${fixed.modelId}\n// hash ${fixed.hash}. TESTNET ONLY: its trusted setup was made by one machine (docs/future/onchain-ml.md).\n` + sol;
writeFileSync(new URL('NeuroScoreVerifier.sol', OUT), sol);
const cd = JSON.parse('[' + (await snarkjs.groth16.exportSolidityCallData(proofs[0].proof, proofs[0].publicSignals)) + ']');
const fixture = { modelId: fixed.modelId, hash: fixed.hash, row: proofs[0].id, marginOffset: String(MARGIN_OFFSET), a: cd[0], b: cd[1], c: cd[2], publicSignals: cd[3], report };
writeFileSync(new URL('fixture.json', OUT), JSON.stringify(fixture, null, 1) + '\n');
writeFileSync(new URL('report.json', OUT), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report, null, 1));

if (process.argv.includes('--install')) {
  const NET = new URL('../../../../zetaphy-network/', HERE);
  copyFileSync(new URL('NeuroScoreVerifier.sol', OUT), new URL('contracts/NeuroScoreVerifier.sol', NET));
  copyFileSync(new URL('fixture.json', OUT), new URL('test/fixtures/neuroscore-zk.json', NET));
  console.log('installed zetaphy-network/contracts/NeuroScoreVerifier.sol and test/fixtures/neuroscore-zk.json (run npm run build there)');
}
process.exit(0); // snarkjs keeps worker threads alive
