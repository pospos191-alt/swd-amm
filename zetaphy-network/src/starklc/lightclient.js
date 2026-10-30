// ZETAPHY STARK light client: high-level API.
//
//   Prover side (server / CI, from a node's data):
//     collectFromNode(rpc, H, { pinnedKeys })  -> { chainId, height, blockHash, validators, signatures }
//     proveBlock({ validators | set, chainId, height, blockHash, signatures, reveal })
//     proveHandoff({ set, nextSet, chainId, epoch, signatures, reveal })
//   Client side (browser / phone):
//     const lc = new StarkLightClient({ chainId, pin, epoch })  // pin of the genesis (trusted) set
//     lc.applyHandoff(bytes)   // epoch e -> e+1: the set of e certified the root of e+1
//     lc.verifyBlock(bytes)    // a block certified by the current set
//
// Validator-set changes ("sync committee" style): the set of epoch e is only
// known by its root. To move on, the client needs a handoff proof: validators of
// epoch e holding more than 2/3 of ALL its power signed, with their ML-DSA vote
// keys, "zetaphy/pq-setroot\0" || chain id || "\0" || uint64(e+1) || root(e+1) ||
// logN || logBlowup. The chain does not produce these signatures yet: it needs a
// vote-extension change (see docs/future/stark-light-client.md); here they are
// produced by tests and the demo with test keys.

import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { buildSet, statementMessage } from './air.js';
import { prove } from './prover.js';
import { encodeProof } from './proof.js';
import {
  getValidators, getVoteKeyEntry, voteKeyAt, decodeCertificate, parsePinnedKeys, cometClient, ADDRESS_BYTES, ATTESTATION_BYTES,
} from '../pqcert.js';

const fromBase64 = (s) => Uint8Array.from(atob(s ?? ''), (c) => c.charCodeAt(0));

/** Statement "block `height` with hash `blockHash` is certified". */
export const blockStatement = (chainId, height, blockHash) => ({
  kind: 'block', chainId, height: BigInt(height), hash: typeof blockHash === 'string' ? hexToBytes(blockHash.toLowerCase()) : blockHash,
});

/** Statement "the validator set of epoch `epoch` is `nextSet`". */
export const handoffStatement = (chainId, epoch, nextSet) => ({
  kind: 'handoff', chainId, height: BigInt(epoch), hash: nextSet.root, nextLogN: nextSet.logN, nextLogBlowup: nextSet.logBlowup,
});

/** Proves a block certificate. Invalid signatures are dropped (as the chain ignores them). */
export function proveBlock({ set, validators, chainId, height, blockHash, signatures, reveal = 'all', sigBits = 128, params }) {
  set ??= buildSet(validators);
  const statement = blockStatement(chainId, height, blockHash);
  const proof = prove({ set, statement, signatures, reveal, sigBits, params, onInvalid: 'skip' });
  return { set, proof, bytes: encodeProof(proof), skipped: proof.skipped };
}

/** Proves that the set of epoch `epoch - 1` (set) signed the root of `nextSet` for epoch `epoch`. */
export function proveHandoff({ set, nextSet, chainId, epoch, signatures, reveal = 'all', sigBits = 128, params }) {
  const statement = handoffStatement(chainId, epoch, nextSet);
  const proof = prove({ set, statement, signatures, reveal, sigBits, params, onInvalid: 'skip' });
  return { proof, bytes: encodeProof(proof), statement };
}

/** The message validators of the current set sign for a handoff to `nextSet` at `epoch`. */
export const handoffMessage = (chainId, epoch, nextSet) => statementMessage(handoffStatement(chainId, epoch, nextSet));

/**
 * Reads what the prover needs for block `height` from a CometBFT RPC: the block
 * hash, the certificate in block height+1, and the validators with the vote keys
 * valid at `height` (from pinnedKeys - exportVoteKeys output - or the node).
 * Nothing here needs trust for the proof's soundness: a node that lies produces
 * a proof the light client rejects (wrong set root or bad signatures).
 */
export async function collectFromNode(cometRpc, height, { pinnedKeys, chainId } = {}) {
  const rpc = typeof cometRpc === 'function' ? cometRpc : cometClient(String(cometRpc));
  const H = BigInt(height);
  const block = await rpc('block', { height: String(H) });
  const next = await rpc('block', { height: String(H + 1n) });
  const header = block?.block?.header;
  if (!header || !block.block_id?.hash) throw new Error(`block ${H}: unexpected answer from the node`);
  const pin = pinnedKeys == null ? null : parsePinnedKeys(typeof pinnedKeys === 'string' ? JSON.parse(pinnedKeys) : pinnedKeys);
  let validators;
  if (pin) validators = pin.validators.map((v) => ({ address: v.address, power: v.power, pubKey: voteKeyAt(v.entry, H) }));
  else {
    const vs = await getValidators(rpc, H);
    validators = [];
    for (const v of vs) validators.push({ address: v.address, power: v.power, pubKey: voteKeyAt(await getVoteKeyEntry(rpc, v.address, H), H) });
  }
  const tx0 = next?.block?.data?.txs?.[0];
  const cert = tx0 ? decodeCertificate(fromBase64(tx0)) : null;
  if (!cert) throw new Error(`block ${H + 1n} does not start with a vote certificate`);
  if (cert.height !== H) throw new Error(`the certificate in block ${H + 1n} is for height ${cert.height}`);
  if (cert.attestations.length % ATTESTATION_BYTES) throw new Error('malformed attestations');
  const signatures = new Map();
  for (let i = 0; i < cert.attestations.length; i += ATTESTATION_BYTES) {
    const addr = bytesToHex(cert.attestations.subarray(i, i + ADDRESS_BYTES)).toUpperCase();
    if (!signatures.has(addr)) signatures.set(addr, cert.attestations.slice(i + ADDRESS_BYTES, i + ATTESTATION_BYTES));
  }
  return { chainId: chainId ?? pin?.chainId ?? header.chain_id, height: H, blockHash: String(block.block_id.hash), validators, signatures };
}

export { StarkLightClient } from './client.js';
