// Test helpers for the trustless bridge (test/starkbridge.test.js):
//   - mldsaVerifierPrecompile: an "ML-DSA-44 verifier" at a fixed address for the Ethereum side
//     (input pk[1312] || sig[2420] || message -> uint256(1)), checked with @noble/post-quantum.
//     It stands in for an ML-DSA verifier contract or a future precompile; its `gas` is set by the
//     test to the estimate measured with helpers/MLDSACost.sol, so gas numbers include it.
//   - zetaphyBlock: a simulated ZETAPHY block whose app_hash commits to a real outbox root through a
//     real IAVL evm store and a Cosmos multistore, and whose CometBFT header hashes like a real one
//     (the template is the real devnet header in fixtures/pqcert-devnet.json).
//   - compileHelper: helpers/*.sol compiled here like mocks.js.
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { getBytes } from 'ethers';
import { headerHash, appHashProof, multistoreRoot, multistoreProof, buildIavl, storageKey } from '../../src/starkbridge/index.js';

export const MLDSA_VERIFIER = '0x0000000000000000000000000000000000000a44';
const ONE = new Uint8Array(32); ONE[31] = 1;

export function mldsaVerifierPrecompile(input) {
  if (input.length < 1312 + 2420) return null;
  const pk = input.subarray(0, 1312), sig = input.subarray(1312, 1312 + 2420), msg = input.subarray(1312 + 2420);
  try { return ml_dsa44.verify(sig, msg, pk) ? ONE : null; } catch { return null; }
}

const cache = {};
export function compileHelper(file) {
  if (cache[file]) return cache[file];
  const input = { language: 'Solidity', sources: { [file]: { content: readFileSync(new URL(`./${file}`, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  cache[file] = Object.fromEntries(Object.entries(out.contracts[file]).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return cache[file];
}

const TEMPLATE = JSON.parse(readFileSync(new URL('../fixtures/pqcert-devnet.json', import.meta.url), 'utf8')).block['13'].block.header;
const tag = (s) => sha256(new TextEncoder().encode(s));

/**
 * A ZETAPHY block at `height` whose state holds `slots` ([{ address, slot, value (32 bytes) }]) in the
 * evm store (plus filler keys), next to other module stores. Returns { header, blockHash, appHash,
 * aunts, prove(address, slot) -> { iavl, storeOps } }.
 */
export function zetaphyBlock({ chainId, height, slots, salt = 'a', version = Number(height) - 1 }) {
  const entries = slots.map((s) => ({ key: storageKey(s.address, s.slot), value: getBytes(s.value) }));
  for (let i = 0; i < 9; i++) entries.push({ key: Uint8Array.of(1, ...tag(`${salt}/code/${i}`).subarray(0, 20)), value: tag(`${salt}/codehash/${i}`) });
  const evm = buildIavl(entries, version);
  const stores = { acc: tag(`${salt}/acc`), bank: tag(`${salt}/bank`), distribution: tag(`${salt}/distr`), evm: evm.root,
    feemarket: tag(`${salt}/fee`), gov: tag(`${salt}/gov`), ibc: tag(`${salt}/ibc`), staking: tag(`${salt}/staking`), upgrade: tag(`${salt}/upgrade`), zetaphypq: tag(`${salt}/pq`) };
  const appHash = multistoreRoot(stores);
  const header = { ...TEMPLATE, chain_id: chainId, height: String(height), app_hash: bytesToHex(appHash).toUpperCase(),
    last_block_id: { hash: bytesToHex(tag(`${salt}/prev/${height}`)).toUpperCase(), parts: TEMPLATE.last_block_id.parts } };
  const blockHash = headerHash(header);
  return {
    header, blockHash, appHash, aunts: appHashProof(header).aunts,
    prove: (address, slot = 0n) => ({ iavl: evm.prove(storageKey(address, slot)), storeOps: multistoreProof(stores, 'evm') }),
  };
}
