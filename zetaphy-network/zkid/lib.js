// Shared pieces of the private-identity tooling (setup.js, test/): paths, the circuit build, the pinned public
// phase-1 file, the signals the example apps compute on chain, and the fixed test scenario.
import { readFileSync, mkdirSync, cpSync, existsSync, statSync, createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { keccak256 } from '../../zetaphy-neuro/src/keccak.js';
import { poseidon2, commitment, leafOf } from '../../zetaphy-hub/zkid-core.js';

export const HERE = new URL('./', import.meta.url);
export const OUT = new URL('./out/', HERE);
export const NM = new URL('./node_modules/', HERE);
export const HUB_ZKID = new URL('../../zetaphy-hub/zkid/', HERE);
export const p = (u) => (u instanceof URL ? u.pathname : u);
export const SNARKJS_CLI = p(new URL('snarkjs/build/cli.cjs', NM));
export const CIRCOM = p(new URL('circom2/cli.js', NM));
export const SNARKJS_VERSION = JSON.parse(readFileSync(new URL('snarkjs/package.json', NM), 'utf8')).version;
export const CIRCUIT = 'identity';
/** The public phase-1 file Neuro's zkML ceremony pins (Perpetual Powers of Tau 0080, power 15): the same pin. */
export const PHASE1 = JSON.parse(readFileSync(new URL('../../zetaphy-neuro/ml/onchain/zk/ceremony/phase1.json', HERE), 'utf8'));
export const secs = (ms) => Math.round(ms) / 1000;

export function run(file, args, cwd = p(HERE)) {
  const t = performance.now();
  const r = spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${args[0]} ${args[1] ?? ''} failed:\n${r.stdout}\n${r.stderr}`);
  return { ms: performance.now() - t, out: r.stdout };
}

export function fileHash(path, algo = 'sha256') {
  return new Promise((ok, fail) => {
    const h = createHash(algo === 'blake2b' ? 'blake2b512' : algo);
    createReadStream(p(path)).on('data', (d) => h.update(d)).on('error', fail).on('end', () => ok(h.digest('hex')));
  });
}

/** Compiles circuits/identity.circom (r1cs + wasm, --O2) into out/. circom2 (WASI) sees only the working directory,
 *  so circomlib's circuits are copied into out/lib first (node_modules may be a link). */
export function buildCircuit() {
  mkdirSync(new URL('lib/circomlib/', OUT), { recursive: true });
  cpSync(p(new URL('circomlib/circuits/', NM)), p(new URL('lib/circomlib/circuits/', OUT)), { recursive: true, dereference: true });
  const r = run(CIRCOM, [`circuits/${CIRCUIT}.circom`, '--O2', '--r1cs', '--wasm', '-l', 'out/lib', '-o', 'out']);
  const m = r.out.match(/non-linear constraints: (\d+)/);
  return { ms: r.ms, constraints: m ? Number(m[1]) : null };
}

/** The pinned phase-1 file: `--ptau <path>` or out/<file>, downloaded once; refused unless sha256 and blake2b match. */
export async function getPtau(given) {
  const dest = given ?? p(new URL(PHASE1.file, OUT));
  if (!existsSync(dest)) {
    mkdirSync(OUT, { recursive: true });
    console.log(`downloading phase 1: ${PHASE1.url} (${(PHASE1.bytes / 1e6).toFixed(1)} MB)`);
    const r = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', dest, PHASE1.url], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('phase 1 download failed');
  }
  const [sha, b2] = await Promise.all([fileHash(dest), fileHash(dest, 'blake2b')]);
  if (sha !== PHASE1.sha256 || b2 !== PHASE1.blake2b || statSync(dest).size !== PHASE1.bytes) throw new Error(`${dest} is not the pinned phase-1 file`);
  return dest;
}

// ---------------------------------------------------------------- what the example apps compute on chain
const hexBytes = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map((b) => parseInt(b, 16)));
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const kec = (hex) => BigInt('0x' + Array.from(keccak256(hexBytes(hex)), (b) => b.toString(16).padStart(2, '0')).join(''));
/** PrivateAirdrop.signalOf(recipient, fee) = keccak256(abi.encode(recipient, fee)) >> 8 */
export const airdropSignal = (recipient, fee) => kec(w(BigInt(recipient)) + w(fee)) >> 8n;
/** PrivatePoll.signalOf(scope, option) = keccak256(abi.encode(scope, option)) >> 8 */
export const pollSignal = (scope, option) => kec(w(scope) + w(option)) >> 8n;
/** A scope from a name: keccak256(name) >> 8 (any field element works; apps pick their own). */
export const scopeOf = (name) => kec(Array.from(new TextEncoder().encode(name), (b) => b.toString(16).padStart(2, '0')).join('')) >> 8n;

// ---------------------------------------------------------------- the fixed scenario the contract test replays
// Three members registered in this order: alice (passkey human, level 1), bob (vouched unique, level 2), carol (1).
// Test identities only: derived from public constants, never used anywhere real.
const testId = (n) => ({ secret: poseidon2(0x7e57n, BigInt(n)), nullifierKey: poseidon2(0x7e57n, BigInt(n) + 1000n) });
export const PEOPLE = { alice: { id: testId(1), level: 1 }, bob: { id: testId(2), level: 2 }, carol: { id: testId(3), level: 1 } };
export const ORDER = ['alice', 'bob', 'carol'];
export const leavesAfter = (n) => ORDER.slice(0, n).map((k) => leafOf(commitment(PEOPLE[k].id), PEOPLE[k].level));
export const SCOPES = {
  airdrop: scopeOf('zetaphy.zkid.test/airdrop-1'),
  oldRoot: scopeOf('zetaphy.zkid.test/airdrop-2'),
  unique: scopeOf('zetaphy.zkid.test/airdrop-vouched'),
  poll: scopeOf('zetaphy.zkid.test/poll-1'),
};
export const RECIPIENTS = { r1: '0x00000000000000000000000000000000000000d1', r2: '0x00000000000000000000000000000000000000d2', r3: '0x00000000000000000000000000000000000000d3', r4: '0x00000000000000000000000000000000000000d4' };
