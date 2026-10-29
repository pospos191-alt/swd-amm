// Neuro federated learning, network side: how an update travels.
//
// Two ways, the same bytes (zetaphy-neuro/ml/fl/codec.js):
//  - off chain: a signed envelope (EIP-191 personal_sign by the user's wallet
//    over "Neuro federated update v1\nsha256:<digest>") dropped to a runner or
//    into the aggregator's inbox (e.g. attached to an issue / PR);
//  - on chain: commit-reveal in FederatedRounds (the tx sender is the signer).
// The aggregator turns both into {sender, bytes} for aggregateRound().

import { readFileSync } from 'node:fs';
import { Interface, Contract, AbiCoder, keccak256, sha256, verifyMessage, getAddress, hexlify, getBytes } from 'ethers';
import { signText, toBase64, fromBase64 } from '../../zetaphy-neuro/ml/fl/codec.js';

export const ROUNDS_ABI = JSON.parse(readFileSync(new URL('../artifacts/FederatedRounds.json', import.meta.url), 'utf8')).abi;
export const ROUNDS = new Interface(ROUNDS_ABI);
export const ENVELOPE_FORMAT = 'neuro-fl-envelope/1';
const coder = AbiCoder.defaultAbiCoder();

/** FederatedRounds.commitmentFor, computed locally. */
export function commitmentFor(payload, salt, sender) {
  return keccak256(coder.encode(['bytes32', 'bytes32', 'address'], [keccak256(payload), salt, getAddress(sender)]));
}

/** sha256 of the update bytes, 64 hex without 0x. */
export const digestOf = (bytes) => sha256(bytes).slice(2);

/** Signs update bytes with an ethers signer (a wallet in the browser does the same with personal_sign). */
export async function signEnvelope(signer, bytes) {
  const signature = await signer.signMessage(signText(digestOf(bytes)));
  return { format: ENVELOPE_FORMAT, payload: toBase64(bytes), address: getAddress(await signer.getAddress()), signature };
}

/** Checks an envelope's signature; returns {sender, bytes} or throws. */
export function verifyEnvelope(env) {
  if (!env || env.format !== ENVELOPE_FORMAT) throw new Error('not a Neuro FL envelope');
  const bytes = fromBase64(String(env.payload));
  const who = verifyMessage(signText(digestOf(bytes)), String(env.signature));
  if (who.toLowerCase() !== String(env.address).toLowerCase()) throw new Error('signature does not match the address');
  return { sender: who, bytes };
}

/**
 * Revealed updates of a round from FederatedRounds events.
 * @returns {Promise<Array<{sender:string, bytes:Uint8Array, tx:string}>>}
 */
export async function readRevealed(address, provider, round, { fromBlock = 0, toBlock = 'latest' } = {}) {
  const c = new Contract(getAddress(address), ROUNDS_ABI, provider);
  const logs = await c.queryFilter(c.filters.Revealed(BigInt(round)), fromBlock, toBlock);
  return logs.map((l) => ({ sender: l.args.sender, bytes: getBytes(l.args.payload), tx: l.transactionHash }));
}

/** Parsed Revealed events from a list of raw logs (e.g. the test chain's send() output). */
export function revealedFromEvents(events) {
  return events.filter((e) => e?.name === 'Revealed').map((e) => ({ sender: e.args.sender, bytes: getBytes(e.args.payload) }));
}

export { hexlify };
