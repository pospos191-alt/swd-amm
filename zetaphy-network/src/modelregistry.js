// ModelRegistry (contracts/ModelRegistry.sol) from JavaScript: ids, the publish /
// status calldata governance needs, and the timelock operation wrapping them.
// The browser side reads the same contract with zetaphy-neuro/ai/browser/registry.js.

import { readFileSync } from 'node:fs';
import { Interface, solidityPackedKeccak256, getAddress, ZeroHash } from 'ethers';
import { operationId, scheduleData, executeData, saltOf, DEFAULT_DELAY } from './timelock.js';

export const MODEL_REGISTRY = JSON.parse(readFileSync(new URL('../artifacts/ModelRegistry.json', import.meta.url), 'utf8'));
export const REGISTRY = new Interface(MODEL_REGISTRY.abi);
export const KINDS = ['none', 'model', 'skill', 'prompt', 'ruleset'];
export const STATUSES = ['none', 'active', 'suspended', 'deprecated', 'revoked'];

const kindNo = (k) => { const n = typeof k === 'number' ? k : KINDS.indexOf(String(k)); if (n < 1 || n >= KINDS.length) throw new Error(`kind: ${KINDS.slice(1).join(', ')}`); return n; };
const statusNo = (s) => { const n = typeof s === 'number' ? s : STATUSES.indexOf(String(s)); if (n < 1 || n >= STATUSES.length) throw new Error(`status: ${STATUSES.slice(1).join(', ')}`); return n; };
const hash32 = (h) => { const s = String(h); if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error('expected 0x + 64 hex'); return s.toLowerCase(); };

/** ModelRegistry.idOf(kind, name), computed locally. */
export const registryIdOf = (kind, name) => solidityPackedKeccak256(['string', 'uint8', 'string'], ['zetaphy.registry', kindNo(kind), String(name)]);

/**
 * publish(...) calldata from a release record (zetaphy-neuro scripts/build-model-pack.js release.json).
 * @param {{kind, name, version, manifestHash, chunkRoot, size, chunkSize, license}} rel
 */
export function publishCall(rel, author) {
  const id = registryIdOf(rel.kind, rel.name);
  if (rel.registryId && rel.registryId.toLowerCase() !== id.toLowerCase()) throw new Error('release.json registryId does not match kind/name');
  const args = [id, kindNo(rel.kind), Number(rel.version), hash32(rel.manifestHash), hash32(rel.chunkRoot), BigInt(rel.size), Number(rel.chunkSize), getAddress(author), String(rel.license)];
  return { id, fn: 'publish', args, data: REGISTRY.encodeFunctionData('publish', args) };
}

export function statusCall(kind, name, version, status) {
  const id = registryIdOf(kind, name);
  const args = [id, Number(version), statusNo(status)];
  return { id, fn: 'setStatus', args, data: REGISTRY.encodeFunctionData('setStatus', args) };
}

/** The timelock operation for a registry call: schedule / execute calldata and its id. */
export function timelockOp(registry, data, { salt, delay = DEFAULT_DELAY } = {}) {
  const op = { target: getAddress(registry), value: 0n, data, predecessor: ZeroHash, salt: saltOf(salt) };
  return { id: operationId(op), schedule: scheduleData({ ...op, delay }), execute: executeData(op), salt: op.salt, delay };
}
