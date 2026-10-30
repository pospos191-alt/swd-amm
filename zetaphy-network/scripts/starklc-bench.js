#!/usr/bin/env node
// Benchmarks of the STARK light client (src/starklc) against verifying every
// ML-DSA-44 signature of a certificate directly (what pqcert.js does today).
//   node scripts/starklc-bench.js [n ...]              (default 4 21 100)
//   node scripts/starklc-bench.js --json out.json 4 21
//   node scripts/starklc-bench.js --demo <dir>         writes the explorer demo proofs
// Test keys only (deterministic public seeds): never real validator keys.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import {
  buildSet, prove, verifyProof, encodeProof, proofSize, statementMessage, blockStatement, proveHandoff, handoffMessage,
} from '../src/starklc/index.js';
import { testValidators, signAll } from '../src/starklc/fixtures.js';

const CHAIN = 'zetaphy_77390-1';
const HASH = Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 7) & 255);
const now = () => performance.now();
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;

function timeIt(fn, reps) {
  const ts = [];
  let out;
  for (let i = 0; i < reps; i++) { const t = now(); out = fn(); ts.push(now() - t); }
  return { ms: median(ts), out };
}

export function bench(n, { reps = 3 } = {}) {
  const vals = testValidators(n);
  const tSet = now();
  const set = buildSet(vals);
  const setMs = now() - tSet;
  const st = blockStatement(CHAIN, 1000 + n, HASH);
  const msg = statementMessage(st);
  const sigs = signAll(vals, msg);
  const rows = [];
  for (const [mode, sigBits] of [['none', 0], ['sample', 40], ['sample', 128], ['all', 0]]) {
    const pr = timeIt(() => prove({ set, statement: st, signatures: sigs, reveal: mode, sigBits }), 1);
    const bytes = encodeProof(pr.out);
    const v = timeIt(() => verifyProof(bytes, { pin: set.pin, chainId: CHAIN, minSigBits: 0 }), reps);
    const size = proofSize(pr.out);
    rows.push({ n, mode: mode === 'sample' ? `sample-${sigBits}` : mode, proveMs: pr.ms, verifyMs: v.ms, bytes: size.total, starkBytes: size.stark,
      revealed: pr.out.reveals.length, sigBits: v.out.sigBits, ok: v.out.ok });
  }
  // Direct: the certificate (address + signature per signer) and n ML-DSA-44 verifications,
  // with the keys pinned beforehand (n x 1312 bytes per validator-set change).
  const list = [...sigs.entries()];
  const d = timeIt(() => list.every(([a, s]) => ml_dsa44.verify(s, msg, vals.find((v) => v.address === a).pubKey)), reps);
  rows.push({ n, mode: 'direct', proveMs: 0, verifyMs: d.ms, bytes: list.length * 2440, starkBytes: 0, revealed: list.length, sigBits: Infinity, ok: d.out,
    pinnedKeyBytes: n * (1312 + 20 + 8) });
  return { n, N: set.N, setMs, setRoot: set.pin.root, rows };
}

function table(results) {
  const lines = ['| n | mode | proof size | of which STARK | prove (node) | verify (node) | sig check |', '|---|---|---|---|---|---|---|'];
  for (const r of results.flatMap((x) => x.rows)) {
    const sig = r.mode === 'none' ? 'trusted' : r.sigBits === Infinity ? 'all signers' : `${r.sigBits.toFixed(0)} bits (${r.revealed} revealed)`;
    lines.push(`| ${r.n} | ${r.mode} | ${kb(r.bytes)} | ${r.mode === 'direct' ? '-' : kb(r.starkBytes)} | ${r.mode === 'direct' ? '-' : `${(r.proveMs / 1000).toFixed(2)} s`} | ${r.verifyMs.toFixed(0)} ms | ${sig} |`);
  }
  return lines.join('\n');
}

function demo(dir) {
  // Epoch 0: 4 validators (the pinned genesis set). Epoch 1: 21 validators, certified by epoch 0.
  mkdirSync(dir, { recursive: true });
  const g = testValidators(4, { label: 'zetaphy-starklc-demo/epoch0' });
  const e1 = testValidators(21, { label: 'zetaphy-starklc-demo/epoch1' });
  const set0 = buildSet(g), set1 = buildSet(e1);
  const ho = proveHandoff({ set: set0, nextSet: set1, chainId: CHAIN, epoch: 1, signatures: signAll(g, handoffMessage(CHAIN, 1, set1)) });
  writeFileSync(join(dir, 'handoff-1.bin'), ho.bytes);
  const files = [];
  const block = (name, height, signers, reveal, sigBits = 128) => {
    const st = blockStatement(CHAIN, height, HASH.map((b) => b ^ (height & 255)));
    const p = prove({ set: set1, statement: st, signatures: signAll(signers, statementMessage(st)), reveal, sigBits });
    writeFileSync(join(dir, name), encodeProof(p));
    files.push({ file: name, height, reveal, note: `${signers.length} of 21 validators signed` });
  };
  block('block-501-all.bin', 501, e1, 'all');
  block('block-502-trusted.bin', 502, e1, 'none');
  block('block-503-minority.bin', 503, e1.slice(0, 11), 'all');
  const manifest = {
    note: 'Demo data made with TEST keys (public seeds) by zetaphy-network/scripts/starklc-bench.js --demo. Not a real chain.',
    chainId: CHAIN, genesis: { epoch: 0, ...set0.pin, validators: g.map((v) => ({ address: v.address, power: v.power.toString() })) },
    handoffs: [{ epoch: 1, file: 'handoff-1.bin' }], blocks: files,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  console.log(`demo written to ${dir}`);
}

const args = process.argv.slice(2);
if (args[0] === '--demo') demo(args[1]);
else {
  let json = null;
  if (args[0] === '--json') { json = args[1]; args.splice(0, 2); }
  const ns = args.length ? args.map(Number) : [4, 21, 100];
  const results = [];
  for (const n of ns) { const r = bench(n); results.push(r); console.error(`n=${n}: N=${r.N}, set commitment ${r.setMs.toFixed(0)} ms`); }
  console.log(table(results));
  if (json) writeFileSync(json, JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? v.toString() : v === Infinity ? 'Infinity' : v), 1));
}
