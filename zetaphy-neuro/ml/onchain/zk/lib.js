// Shared pieces of the zkML pipeline (run.js) and the phase-2 ceremony tool (ceremony/ceremony.js):
// paths, the pinned snarkjs CLI, circuit build, the pinned public phase-1 file, the Solidity verifier with the
// model-hash binding. Everything runs on free npm packages (circom2 WASM, snarkjs, circomlib); no native tools.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, createReadStream, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as snarkjs from 'snarkjs';
import { circuitSource } from './gen-circuit.js';
import { fromHex } from '../fixed.js';

export const HERE = new URL('./', import.meta.url);
export const OUT = new URL('./out/', HERE);
export const NM = new URL('./node_modules/', HERE);
export const CEREMONY = new URL('./ceremony/', HERE);
export const p = (u) => (u instanceof URL ? u.pathname : u);
export const SNARKJS_CLI = p(new URL('snarkjs/build/cli.cjs', NM));
export const CIRCOM = p(new URL('circom2/cli.js', NM));
export const SNARKJS_VERSION = JSON.parse(readFileSync(new URL('snarkjs/package.json', NM), 'utf8')).version;
/** The snarkjs version the ceremony is pinned to (package.json devDependency, exact). */
export const PINNED_SNARKJS = JSON.parse(readFileSync(new URL('package.json', HERE), 'utf8')).devDependencies.snarkjs;
export const secs = (ms) => Math.round(ms) / 1000;

/** Runs a node script (snarkjs CLI, circom2) and returns { ms, out }; throws with its output on failure. */
export function run(file, args, cwd = p(OUT)) {
  const t = performance.now();
  const r = spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${args[0]} ${args[1] ?? ''} failed:\n${r.stdout}\n${r.stderr}`);
  return { ms: performance.now() - t, out: r.stdout };
}

/** sha256 / blake2b-512 of a file, streamed, as hex. */
export function fileHash(path, algo = 'sha256') {
  return new Promise((ok, fail) => {
    const h = createHash(algo === 'blake2b' ? 'blake2b512' : algo);
    createReadStream(p(path)).on('data', (d) => h.update(d)).on('error', fail).on('end', () => ok(h.digest('hex')));
  });
}

export const model = () => JSON.parse(readFileSync(new URL('../model.fixed.json', HERE), 'utf8'));

/** Writes out/neuro_score.circom from the committed model and compiles it (r1cs + wasm). Returns { info, ms }. */
export async function buildCircuit() {
  mkdirSync(OUT, { recursive: true });
  const fixed = model();
  writeFileSync(new URL('neuro_score.circom', OUT), circuitSource(fromHex(fixed.bytes), fixed.hash));
  // circom2 (WASI) only sees the working directory: relative paths from here
  const comp = run(CIRCOM, ['out/neuro_score.circom', '--r1cs', '--wasm', '-l', 'node_modules', '-o', 'out'], p(HERE));
  const info = await snarkjs.r1cs.info(p(new URL('neuro_score.r1cs', OUT)));
  return { info, ms: comp.ms, fixed };
}

/** The pinned phase-1 description (ceremony/phase1.json). */
export const phase1 = () => JSON.parse(readFileSync(new URL('phase1.json', CEREMONY), 'utf8'));

/**
 * The public phase-1 file at out/<file>: downloaded once from its pinned URL and refused unless its sha256 AND
 * blake2b-512 are the pinned ones. Returns its path. (Node's fetch honours no proxy; curl does, so it is used when present.)
 */
export async function getPtau({ log = console.log } = {}) {
  const ph = phase1();
  mkdirSync(OUT, { recursive: true });
  const dest = new URL(ph.file, OUT);
  if (!existsSync(dest)) {
    log(`downloading phase 1: ${ph.url} (${(ph.bytes / 1e6).toFixed(1)} MB)`);
    const tmp = p(dest) + '.part';
    const r = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', tmp, ph.url], { stdio: 'inherit' });
    if (r.status !== 0) {
      const res = await fetch(ph.url);
      if (!res.ok) throw new Error(`phase 1 download failed: HTTP ${res.status}`);
      writeFileSync(tmp, new Uint8Array(await res.arrayBuffer()));
    }
    renameSync(tmp, dest);
  }
  const [sha, b2] = await Promise.all([fileHash(dest, 'sha256'), fileHash(dest, 'blake2b')]);
  if (sha !== ph.sha256 || b2 !== ph.blake2b || statSync(dest).size !== ph.bytes) {
    rmSync(dest);
    throw new Error(`phase 1 file ${ph.file} is not the pinned one (sha256 ${sha}, blake2b ${b2.slice(0, 16)}…): deleted`);
  }
  return p(dest);
}

/**
 * NeuroScoreVerifier.sol from a zkey: snarkjs' Groth16 template + the model-hash binding:
 * MODEL_HASH (keccak256 of the packed model the circuit hard-wires), the ceremony it came from (sha256 of the final
 * zkey, the transcript's last link) and verifyModelProof(a, b, c, commitment, margin), which supplies H's two
 * halves itself, so a caller cannot pass a proof for another circuit's constants.
 */
export async function solidityVerifier(zkeyPath, { fixed = model(), zkeySha256, link, label }) {
  const template = readFileSync(new URL('snarkjs/templates/verifier_groth16.sol.ejs', NM), 'utf8');
  let sol = await snarkjs.zKey.exportSolidityVerifier(p(zkeyPath), { groth16: template });
  sol = sol.replace(/contract Groth16Verifier/, 'contract NeuroScoreVerifier').replace(/pragma solidity [^;]+;/, 'pragma solidity 0.8.26;');
  const binding = `
    /// keccak256 of the packed model the circuit hard-wires (zetaphy-neuro/ml/onchain/model.fixed.json, ${fixed.modelId})
    bytes32 public constant MODEL_HASH = ${fixed.hash};
    /// sha256 of the final zkey of the phase-2 ceremony this verifier was exported from
    bytes32 public constant ZKEY_SHA256 = 0x${zkeySha256};
    /// the last link of that ceremony's transcript (zetaphy-neuro/ml/onchain/zk/ceremony/)
    bytes32 public constant CEREMONY_LINK = 0x${link};

    /// A proof that the committed feature vector yields \`margin\` (Z + 2^40) under MODEL_HASH. The hash halves are
    /// supplied here, never by the caller.
    function verifyModelProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint256 commitment, uint256 margin) external view returns (bool) {
        uint256 h = uint256(MODEL_HASH);
        return this.verifyProof(_pA, _pB, _pC, [commitment, margin, h >> 128, h & type(uint128).max]);
    }
`;
  const end = sol.lastIndexOf('}');
  sol = sol.slice(0, end) + binding + sol.slice(end);
  return `// GENERATED by zetaphy-neuro/ml/onchain/zk (snarkjs ${SNARKJS_VERSION} Groth16 template) for model ${fixed.modelId}\n// hash ${fixed.hash}. ${label}\n` + sol;
}
