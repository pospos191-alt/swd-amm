#!/usr/bin/env node
// Saphan private transfers (contracts/SaphanPrivacy.sol): proofs for the fixed scenario test/saphanprivacy.test.js
// replays, made with the SAME prover files the hub ships (zetaphy-hub/zkid/identity.wasm + identity.zkey, the DEV key of
// ZkIdentityVerifier). No new circuit, no new setup.
//
//   cd zetaphy-network/zkid && npm ci && node privacy-fixture.js      # writes ../test/fixtures/saphan-privacy.json
//
// Scenario (test identities derived from public constants, never used anywhere real):
//   chain id 1 (the test EVM), the pool deployed by the test's first account at its nonce 0; three notes deposited in
//   order; proof A spends note 2 against the root after 3 deposits (to R1, relayer fee 0.001), proof B spends note 1
//   against the OLDER root after 2 deposits (to R2, no fee).
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getCreateAddress } from 'ethers';
import * as snarkjs from 'snarkjs';
import { poseidon2 } from '../../zetaphy-hub/zkid-core.js';
import { prove, noteCommitment, noteLeaf, poolScope } from '../src/saphanprivacy.js';

export const CHAIN_ID = 1;
export const DEPLOYER = '0xa000000000000000000000000000000000000001'; // test/helpers/evm.js: the first named account
export const POOL = getCreateAddress({ from: DEPLOYER, nonce: 0 });
export const NOTES = [1n, 2n, 3n].map((n) => ({ secret: poseidon2(0x5a9an, n), nullifierKey: poseidon2(0x5a9an, n + 1000n) }));
export const R1 = '0x00000000000000000000000000000000000000b1';
export const R2 = '0x00000000000000000000000000000000000000b2';
export const FEE = 10n ** 15n;

const HUB = new URL('../../zetaphy-hub/zkid/', import.meta.url);
const wasm = new URL('identity.wasm', HUB).pathname;
const zkey = new URL('identity.zkey', HUB).pathname;
const leaves = NOTES.map(noteLeaf);

if (import.meta.url === `file://${process.argv[1]}`) {
  const sha = createHash('sha256').update(readFileSync(zkey)).digest('hex');
  const t = performance.now();
  const a = await prove({ snarkjs, wasm, zkey, note: NOTES[1], leaves, chainId: CHAIN_ID, pool: POOL, recipient: R1, fee: FEE });
  const b = await prove({ snarkjs, wasm, zkey, note: NOTES[0], leaves: leaves.slice(0, 2), chainId: CHAIN_ID, pool: POOL, recipient: R2, fee: 0n });
  const s = (x) => (Array.isArray(x) ? x.map(s) : typeof x === 'bigint' ? x.toString() : x);
  const fx = {
    about: 'Saphan privacy pool proofs (zetaphy-network/zkid/privacy-fixture.js), DEV Groth16 key of ZkIdentityVerifier. Test data only.',
    zkeySha256: sha, chainId: CHAIN_ID, deployer: DEPLOYER, pool: POOL, scope: poolScope(CHAIN_ID, POOL).toString(),
    commitments: NOTES.map((n) => noteCommitment(n).toString()), leaves: leaves.map(String),
    proofs: { a: s(a.args), b: s(b.args) }, proveSeconds: Math.round(performance.now() - t) / 1000,
  };
  writeFileSync(new URL('../test/fixtures/saphan-privacy.json', import.meta.url), JSON.stringify(fx, null, 1) + '\n');
  console.log(`saphan-privacy.json: 2 proofs in ${fx.proveSeconds} s`);
  process.exit(0);
}
