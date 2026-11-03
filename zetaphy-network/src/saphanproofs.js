// Saphan proven releases (contracts/SaphanProofs.sol): what anyone hands SaphanReleaseVerifier.prove, from the
// proofs src/starkbridge builds (ICS23 IAVL proof of ZetaphyOutbox's slot 0, multistore ops for "evm").
import { hexlify } from 'ethers';

/** The StateProof tuple: [outboxRoot, iavlLeafPrefix, iavlPath, storePath]. */
export function stateProofArgs(iavl, storeOps) {
  const op = (o) => [hexlify(o.prefix), hexlify(o.suffix)];
  return [hexlify(iavl.value), hexlify(iavl.leafPrefix), iavl.path.map(op), storeOps.map(op)];
}
