#!/usr/bin/env node
// zkML pipeline for Neuro's model: builds the circuit, takes the Groth16 key from the phase-2 ceremony, proves
// held-out rows, verifies them, exports the Solidity verifier (with the model-hash binding) and reports sizes and
// timings honestly (measured on the machine that runs it).
//
//   cd zetaphy-neuro/ml/onchain/zk && npm ci && node run.js [--rows 5] [--contributors 2] [--final] [--install]
//
// Steps (outputs in ml/onchain/zk/out/, not committed):
//   1. circuit from ml/onchain/model.fixed.json (gen-circuit.js), compiled with circom 2 (circom2: WASM build, no Rust)
//   2. phase 1 = the public Perpetual Powers of Tau file pinned in ceremony/phase1.json (sha256 + blake2b checked)
//   3. phase 2:
//        --final  the public ceremony (ceremony/transcript.json) must be final; its zkeys are downloaded from their
//                 release URLs and the whole chain is verified before the final zkey is used.
//        default  a REHEARSAL of the same ceremony on this machine (N contributions + beacon, then the same
//                 verification). One party made it, so it is testnet-only, and the verifier says so in its header.
//   4. for --rows held-out rows: witness + Groth16 proof (timed), verification (timed), checks that the public
//      margin = the JS fixed-point margin and the hash = H
//   5. negative cases: the same row proved with the NON-FINAL zkey (last contribution before the beacon) and with a
//      FORGED zkey (an independent single-party setup over the same circuit): each verifies under its own key, never
//      under the final one.
//   6. NeuroScoreVerifier.sol (snarkjs' Groth16 template + MODEL_HASH binding) + the proofs as a fixture
//   --install copies the verifier to zetaphy-network/contracts/ and the fixture to
//   zetaphy-network/test/fixtures/neuroscore-zk.json (what the on-chain test uses).

import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as snarkjs from 'snarkjs';
import { circuitInput, MARGIN_OFFSET } from './gen-circuit.js';
import { fromHex, evalFixed, quantizeVector } from '../fixed.js';
import { OUT, p, secs, buildCircuit, getPtau, fileHash, SNARKJS_VERSION } from './lib.js';
import { rehearse, verify, exportVerifier, TRANSCRIPT, ZKEYS, R1CS, zkeyName } from './ceremony/ceremony.js';
import { tip } from '../../../../zetaphy-hub/ceremony-core.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const ROWS = Number(arg('rows', 5));
const CONTRIBUTORS = Number(arg('contributors', 2));
const FINAL = process.argv.includes('--final');

mkdirSync(OUT, { recursive: true });
const report = { when: new Date().toISOString(), node: process.version, cpu: (await import('node:os')).cpus()[0]?.model, cores: (await import('node:os')).cpus().length, snarkjs: SNARKJS_VERSION, steps: {} };

// 1. circuit
const { info, ms: compileMs, fixed } = await buildCircuit();
const bytes = fromHex(fixed.bytes);
report.model = { id: fixed.modelId, hash: fixed.hash, trees: fixed.trees, features: fixed.features.length };
report.circuit = { constraints: info.nConstraints, wires: info.nVars, publicOutputs: info.nOutputs, privateInputs: info.nPrvInputs, compileSeconds: secs(compileMs) };
console.log(`circuit: ${info.nConstraints} constraints (compiled in ${secs(compileMs)} s)`);

// 2. phase 1 (public, pinned)
const ptau = await getPtau();
const ph = JSON.parse(readFileSync(new URL('./ceremony/phase1.json', import.meta.url), 'utf8'));
if (info.nConstraints > ph.maxConstraints) throw new Error(`${info.nConstraints} constraints do not fit phase 1 power ${ph.power} (${ph.maxConstraints}): pin a bigger prepared file`);
report.phase1 = { name: ph.name, sha256: ph.sha256, power: ph.power };

// 3. phase 2: the public ceremony (final) or a rehearsal of it
let t;
let dir;
if (FINAL) {
  t = JSON.parse(readFileSync(TRANSCRIPT, 'utf8'));
  dir = ZKEYS;
  if (!tip(t).final) throw new Error('--final: the ceremony in ceremony/transcript.json is not final yet');
  const v = await verify({ t, dir, ptau, downloadMissing: true, modelHash: fixed.hash });
  if (!v.ok) throw new Error(`ceremony refused:\n  ${v.problems.join('\n  ')}`);
  // the non-final zkey (before the beacon) for the negative case
  const prev = t.contributions.at(-2);
  const pf = `${dir}/${zkeyName(prev.index)}`;
  if (!existsSync(pf) || await fileHash(pf) !== prev.zkeySha256) await verify({ t, dir, ptau, downloadMissing: true, upTo: prev.index, rebuildInit: false });
  report.ceremony = { kind: 'public', steps: t.contributions.length, verifySeconds: v.seconds };
} else {
  const r = await rehearse({ contributors: CONTRIBUTORS, ptau, log: console.log, prune: true });
  dir = r.dir;
  t = JSON.parse(readFileSync(r.transcript, 'utf8'));
  const v = await verify({ t, dir, ptau, modelHash: fixed.hash, keepInit: false });
  if (!v.ok) throw new Error(`rehearsal refused:\n  ${v.problems.join('\n  ')}`);
  report.ceremony = { kind: 'rehearsal (one machine: testnet only)', contributions: CONTRIBUTORS, ...r.timing, verifySeconds: v.seconds };
  // keep only the final and the non-final zkey (11 MB each)
  for (let i = 0; i < tip(t).index - 1; i++) rmSync(`${dir}/${zkeyName(i)}`, { force: true });
}
const last = tip(t);
const finalZkey = `${dir}/${zkeyName(last.index)}`;
const nonFinalZkey = `${dir}/${zkeyName(last.index - 1)}`;
report.steps.zkey = { bytes: statSync(finalZkey).size, sha256: last.zkeySha256, transcriptLink: last.link };
const vkey = await snarkjs.zKey.exportVerificationKey(finalZkey);
console.log(`ceremony ok: final zkey ${finalZkey} (${statSync(finalZkey).size} bytes)`);

// 4. prove held-out rows
const held = JSON.parse(readFileSync(new URL('../heldout.json', import.meta.url), 'utf8'));
const H = BigInt(fixed.hash);
const WASM = p(new URL('neuro_score_js/neuro_score.wasm', OUT));
const inputOf = (row) => {
  const v = new Array(fixed.features.length).fill(0);
  for (const [i, x] of row.x) v[i] = x;
  return quantizeVector(v);
};
const proofs = [];
for (const row of held.rows.slice(0, ROWS)) {
  const q = inputOf(row);
  const salt = BigInt('0x' + randomBytes(31).toString('hex'));
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput(q, salt), WASM, finalZkey);
  const proveMs = performance.now() - t0;
  const t1 = performance.now();
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  const verifyMs = performance.now() - t1;
  const [commitment, margin, hi, lo] = publicSignals.map(BigInt);
  const want = BigInt(evalFixed(bytes, q).margin) + MARGIN_OFFSET;
  if (!ok) throw new Error(`${row.id}: proof does not verify`);
  if (margin !== want) throw new Error(`${row.id}: circuit margin ${margin - MARGIN_OFFSET} != JS fixed ${want - MARGIN_OFFSET}`);
  if (((hi << 128n) | lo) !== H) throw new Error(`${row.id}: model hash in the proof is not H`);
  proofs.push({ id: row.id, salt, q, proveSeconds: secs(proveMs), verifySeconds: secs(verifyMs), proof, publicSignals, commitment: String(commitment) });
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

// 5. negative cases: a proof from the non-final zkey and from a forged (independent single-party) zkey
const first = proofs[0];
const negative = {};
{
  const nf = await snarkjs.groth16.fullProve(circuitInput(first.q, first.salt), WASM, nonFinalZkey);
  const nfKey = await snarkjs.zKey.exportVerificationKey(nonFinalZkey);
  if (!(await snarkjs.groth16.verify(nfKey, nf.publicSignals, nf.proof))) throw new Error('non-final proof does not verify under its own key');
  if (await snarkjs.groth16.verify(vkey, nf.publicSignals, nf.proof)) throw new Error('a proof from the NON-FINAL zkey verifies under the final key');
  negative.nonFinal = nf;
  const forged = p(new URL('forged.zkey', OUT));
  await snarkjs.zKey.newZKey(R1CS, ptau, p(new URL('forged_0.zkey', OUT)));
  await snarkjs.zKey.contribute(p(new URL('forged_0.zkey', OUT)), forged, 'attacker', randomBytes(32).toString('hex'));
  const fg = await snarkjs.groth16.fullProve(circuitInput(first.q, first.salt), WASM, forged);
  const fgKey = await snarkjs.zKey.exportVerificationKey(forged);
  if (!(await snarkjs.groth16.verify(fgKey, fg.publicSignals, fg.proof))) throw new Error('forged-setup proof does not verify under its own key');
  if (await snarkjs.groth16.verify(vkey, fg.publicSignals, fg.proof)) throw new Error('a proof from a FORGED zkey verifies under the final key');
  rmSync(p(new URL('forged_0.zkey', OUT)), { force: true });
  rmSync(forged, { force: true });
  negative.forged = fg;
  console.log('negative cases: proofs from the non-final and from a forged zkey are refused by the final key (JS)');
}

// 6. Solidity verifier + fixture
await exportVerifier({ t, zkey: finalZkey });
const call = async (x) => JSON.parse('[' + (await snarkjs.groth16.exportSolidityCallData(x.proof, x.publicSignals)) + ']');
const cd = await call(first);
const nf = await call(negative.nonFinal);
const fg = await call(negative.forged);
const fixture = {
  modelId: fixed.modelId, hash: fixed.hash, row: first.id, marginOffset: String(MARGIN_OFFSET),
  ceremony: { kind: report.ceremony.kind, zkeySha256: last.zkeySha256, link: last.link, steps: t.contributions.map((e) => ({ index: e.index, type: e.type, name: e.name, contributionHash: e.contributionHash })) },
  a: cd[0], b: cd[1], c: cd[2], publicSignals: cd[3],
  nonFinal: { about: 'the same row proved with the zkey before the beacon (a valid proof under THAT key)', a: nf[0], b: nf[1], c: nf[2], publicSignals: nf[3] },
  forged: { about: 'the same row proved with an independent single-party setup of the same circuit (a valid proof under THAT key)', a: fg[0], b: fg[1], c: fg[2], publicSignals: fg[3] },
  report,
};
writeFileSync(new URL('fixture.json', OUT), JSON.stringify(fixture, null, 1) + '\n');
writeFileSync(new URL('report.json', OUT), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report, null, 1));

if (process.argv.includes('--install')) {
  const NET = new URL('../../../../zetaphy-network/', import.meta.url);
  copyFileSync(new URL('NeuroScoreVerifier.sol', OUT), new URL('contracts/NeuroScoreVerifier.sol', NET));
  copyFileSync(new URL('fixture.json', OUT), new URL('test/fixtures/neuroscore-zk.json', NET));
  console.log('installed zetaphy-network/contracts/NeuroScoreVerifier.sol and test/fixtures/neuroscore-zk.json (run npm run build there)');
}
process.exit(0); // snarkjs keeps worker threads alive
