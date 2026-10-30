// ZETAPHY -> Ethereum trustless bridge (prototype): what a relayer (anyone) builds off-chain.
// See docs/future/trustless-bridge.md.
//
//   1. a STARK light-client proof of block H (src/starklc: proveBlock) and the header's app_hash
//      with its 4 aunts (appHashProof) -> StarkLightClient.submit / submitChecked
//   2. after it is final: the outbox's slot 0 in the evm store (ICS23 IAVL proof) and the evm store
//      in the multistore (ICS23 Tendermint ops) at that app_hash - on a live chain both come from
//      abci_query path "store/evm/key", data 0x02 || outbox || 0x00..00, height H - 1, prove=true -
//      and the message's path in the outbox tree (from MessageSent events) -> ZetaphyBridgeInbox.release
import { hexlify } from 'ethers';

export { headerHash, headerLeaves, appHashProof, multistoreRoot, multistoreProof, applyMultistoreOps, simpleRoot, simpleProof, rootFromAunts } from './merkle.js';
export { buildIavl, applyIavlProof, iavlLeafHash } from './iavl.js';
export { messageLeaf, outboxProof, LEAF_TAG } from './outbox.js';

/** The evm-store key of a contract's storage slot (cosmos/evm x/vm: 0x02 || address || slot). */
export function storageKey(address, slot = 0n) {
  const a = String(address).replace(/^0x/, '').padStart(40, '0');
  const s = BigInt(slot).toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(`02${a}${s}`, 'hex'));
}

/**
 * ZetaphyBridgeInbox.release arguments:
 *   height: the final ZETAPHY header; iavl: ICS23 existence proof of the outbox slot (buildIavl().prove);
 *   storeOps: multistore ops for "evm"; message: { nonce, sender, dstChainId, receiver, payload };
 *   outbox: outboxProof(...) of that nonce.
 */
export function releaseArgs({ height, iavl, storeOps, message, outbox }) {
  const op = (o) => [hexlify(o.prefix), hexlify(o.suffix)];
  return [
    BigInt(height),
    [hexlify(iavl.value), hexlify(iavl.leafPrefix), iavl.path.map(op), storeOps.map(op)],
    [BigInt(message.nonce), message.sender, BigInt(message.dstChainId), message.receiver, message.payload],
    outbox.siblings,
    BigInt(outbox.count),
  ];
}
