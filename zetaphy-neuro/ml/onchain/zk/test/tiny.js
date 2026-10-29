// A tiny circuit + a tiny LOCAL phase 1, so the ceremony tool can be tested in seconds (never used for a real key).
//   node test/tiny.js --hub   also writes zetaphy-hub/test/fixtures/ceremony/ (the browser contribution test's inputs)
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { run, CIRCOM, SNARKJS_CLI, HERE, p, fileHash } from '../lib.js';
import { init } from '../ceremony/ceremony.js';

export const TINY = p(new URL('out/tiny/', HERE));

/** Builds out/tiny/{tiny.r1cs, tiny.ptau, tiny_other.ptau} once. */
export async function makeTiny() {
  mkdirSync(TINY, { recursive: true });
  if (existsSync(`${TINY}tiny_other.ptau`)) return { r1cs: `${TINY}tiny.r1cs`, ptau: `${TINY}tiny.ptau`, otherPtau: `${TINY}tiny_other.ptau` };
  writeFileSync(`${TINY}tiny.circom`, `pragma circom 2.1.6;
template Tiny() {
    signal input a;
    signal input b;
    signal output c;
    signal ab;
    ab <== a * b;
    c <== ab * a + b;
}
component main = Tiny();
`);
  run(CIRCOM, ['out/tiny/tiny.circom', '--r1cs', '--wasm', '-o', 'out/tiny'], p(HERE));
  for (const name of ['tiny', 'tiny_other']) {
    run(SNARKJS_CLI, ['powersoftau', 'new', 'bn128', '4', `${name}_0.ptau`], TINY);
    run(SNARKJS_CLI, ['powersoftau', 'contribute', `${name}_0.ptau`, `${name}_1.ptau`, '--name=test', `-e=${name} test entropy`], TINY);
    run(SNARKJS_CLI, ['powersoftau', 'prepare', 'phase2', `${name}_1.ptau`, `${name}.ptau`], TINY);
  }
  return { r1cs: `${TINY}tiny.r1cs`, ptau: `${TINY}tiny.ptau`, otherPtau: `${TINY}tiny_other.ptau` };
}

/** A phase-1 description for the tiny local file (tests only). */
export async function tinyPhase1(ptau) {
  return { name: 'TEST ONLY local tiny powers of tau', file: 'tiny.ptau', url: 'https://example.invalid/tiny.ptau', sha256: await fileHash(ptau), blake2b: await fileHash(ptau, 'blake2b'), power: 4 };
}

/** A fresh tiny ceremony in `dir`: transcript + init zkey. */
export async function tinyCeremony(dir, { minContributions = 2 } = {}) {
  const { r1cs, ptau } = await makeTiny();
  mkdirSync(dir, { recursive: true });
  const transcript = `${dir}/transcript.json`;
  await init({ transcript, dir, r1cs, ptau, ph: await tinyPhase1(ptau), modelHash: '0x' + '11'.repeat(32), minContributions, force: true });
  return { transcript, dir, r1cs, ptau };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { r1cs, ptau } = await makeTiny();
  if (process.argv.includes('--hub')) {
    const HUB = p(new URL('../../../../../zetaphy-hub/test/fixtures/ceremony/', import.meta.url));
    mkdirSync(HUB, { recursive: true });
    const c = await tinyCeremony(`${TINY}hub`);
    copyFileSync(`${c.dir}/neuro_score_0000.zkey`, `${HUB}tiny_0000.zkey`);
    copyFileSync(c.transcript, `${HUB}transcript.json`);
    copyFileSync(r1cs, `${HUB}tiny.r1cs`);
    copyFileSync(ptau, `${HUB}tiny.ptau`);
    console.log(`wrote ${HUB}`);
  }
  process.exit(0);
}
