// ZETAPHY Offline Cash, Node side (docs/future/offline-cash.md): the crypto for zetaphy-hub/cash-core.js (the logic
// shared with the hub), holder keys, the proof-of-funds builder that reads a CometBFT node (the offline check reuses
// pqcert.js's header hash), the validator attestation fallback, and the on-chain calls (issue, bonds, redeem, swap).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Contract, hexlify } from 'ethers';
import * as core from '../../zetaphy-hub/cash-core.js';
import { headerHash as pqHeaderHash, decodeCertificate, cometClient } from './pqcert.js';
import { HOME, loadOrCreateSecret } from './keys.js';

export { core };
/** The crypto cash-core.js needs, from @noble (the wallet bundle's libraries); the header hash is pqcert.js's. */
export const NODE_CRYPTO = {
  keccak: (b) => keccak_256(b),
  verify: (sig, msg, pk) => ml_dsa44.verify(sig, msg, pk),
  headerHash: (h) => pqHeaderHash(h),
};
export const ART = () => JSON.parse(readFileSync(new URL('../artifacts/ZetaphyOfflineCash.json', import.meta.url), 'utf8'));

/** A holder key from a 32-byte seed: { pk, key (keccak256 of pk), sign(digest) }. */
export function holderFromSeed(seed) {
  const { publicKey, secretKey } = ml_dsa44.keygen(seed instanceof Uint8Array ? seed : core.bytes(seed));
  return { pk: publicKey, key: core.keyHash(NODE_CRYPTO, publicKey), sign: (d) => ml_dsa44.sign(d, secretKey) };
}
/** This machine's holder key, ~/.zetaphy/cash.seed (0600; encrypted with ZETAPHY_PASSPHRASE like the other keys). */
export function loadOrCreateHolder(file = join(HOME, 'cash.seed')) {
  const r = loadOrCreateSecret(file, () => hexlify(randomBytes(32)));
  if (!/^0x[0-9a-fA-F]{64}$/.test(r.value)) throw new Error(`${r.file} is not a seed file`);
  return { ...holderFromSeed(r.value), created: r.created, file: r.file };
}

const b64 = (s) => Uint8Array.from(Buffer.from(s ?? '', 'base64'));
const asRpc = (x) => (typeof x === 'function' ? x : cometClient(String(x)));

/**
 * Builds a 'results' proof item for the first log of `contract` with topics starting `topics` in block `height`,
 * from a CometBFT RPC (URL or (method, params) => result): block_results(H), the header of H+1 (its
 * last_results_hash commits H's results) and the PQ certificate of H+1 (the first tx of H+2). `last`: the last match.
 */
export async function buildResultsProof(cometRpc, { height, contract, topics, last = false }) {
  const rpc = asRpc(cometRpc);
  const H = BigInt(height);
  const res = await rpc('block_results', { height: String(H) });
  const results = (res?.txs_results ?? []).map((r) => ({ code: Number(r.code ?? 0), data: core.hex(b64(r.data)), gasWanted: String(r.gas_wanted ?? '0'), gasUsed: String(r.gas_used ?? '0') }));
  const want = topics.map((t) => String(t).toLowerCase());
  let txIndex = -1, logIndex = -1;
  for (let i = 0; i < results.length && (last || txIndex < 0); i++) { // the first matching log, or the last one
    if (results[i].code !== 0) continue;
    let logs;
    try { ({ logs } = core.logsOfResult(core.bytes(results[i].data))); } catch { continue; }
    const match = (l) => l.address === String(contract).toLowerCase() && want.every((t, n) => l.topics[n] === t);
    const j = last ? logs.findLastIndex(match) : logs.findIndex(match);
    if (j >= 0) { txIndex = i; logIndex = j; }
  }
  if (txIndex < 0) throw new Error(`no such log of ${contract} in block ${H}`);
  const leaves = results.map(core.resultLeaf);
  const next = await rpc('block', { height: String(H + 1n) });
  const header = next?.block?.header;
  if (!header) throw new Error(`block ${H + 1n}: unexpected answer from the node`);
  const certBlock = await rpc('block', { height: String(H + 2n) });
  const tx0 = certBlock?.block?.data?.txs?.[0];
  const cert = tx0 ? decodeCertificate(b64(tx0)) : null;
  if (!cert || BigInt(cert.height) !== H + 1n) throw new Error(`block ${H + 2n} has no PQ certificate for block ${H + 1n}`);
  return {
    kind: 'results', chainId: header.chain_id, header, attestations: core.hex(cert.attestations),
    txIndex, total: results.length, aunts: core.merkleAunts(leaves, txIndex, (b) => sha256(b)).map(core.hex), result: results[txIndex], logIndex,
  };
}

/** The fallback: validators sign the log itself ({ address: consensus address hex, sign(msg) -> signature }). */
export function attestLog(c, { chainId, height, time, log }, validators) {
  const msg = core.attestMessage(c, chainId, height, time, log);
  const att = validators.map((v) => {
    const a = core.bytes(String(v.address).replace(/^(0x)?/i, '0x'));
    if (a.length !== 20) throw new Error('validator address: 20 bytes hex');
    return Buffer.concat([a, v.sign(msg)]);
  });
  return { kind: 'attest', chainId, height: Number(height), time: Number(time), log, attestations: core.hex(Buffer.concat(att)) };
}

// ---------------------------------------------------------------- on chain (an ethers signer)

export const cashContract = (address, runner) => new Contract(address, ART().abi, runner);

/** Issues notes and returns their bundles (holder 0 = issuerKey; nobody has signed anything yet). */
export async function issueNotes(contract, { issuerKey, lockUntil, values, chainId }) {
  const sum = values.reduce((a, v) => a + BigInt(v), 0n);
  const rc = await (await contract.issue(issuerKey, lockUntil, values, { value: sum })).wait();
  const addr = (await contract.getAddress()).toLowerCase();
  const issuer = (await contract.runner.getAddress()).toLowerCase();
  return rc.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .filter((e) => e?.name === 'NoteIssued')
    .map((e) => ({ v: 1, chainId: Number(chainId), contract: addr, note: { id: String(e.args.id), issuer, value: String(e.args.value), lockUntil: Number(e.args.lockUntil), issuerKey: e.args.issuerKey.toLowerCase() }, links: [] }));
}
/** Sends redeem() for a bundle with a terminal (anyone may: a relayer earns the terminal's fee). */
export async function redeemBundle(signer, bundle) {
  return (await signer.sendTransaction({ to: bundle.contract, data: core.encodeRedeem(NODE_CRYPTO, bundle) })).wait();
}
