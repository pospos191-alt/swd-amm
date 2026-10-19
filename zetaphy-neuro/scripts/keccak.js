// Dev-only helper (the runtime code ships with precomputed selectors).
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const selectorOf = (sig) => bytesToHex(keccak_256(utf8ToBytes(sig))).slice(0, 8);
