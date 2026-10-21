// Bundle entry for web/vendor/zetaphy-lib.js (npm run build:web): keccak-256 from
// @noble/hashes (selectors, event topics) and the read side of Neuro's vaccine
// shared with the ZETAPHY wallet and Snap (zetaphy-network/src/vaccine.js): the
// ThreatRegistry views to ask about a collection (its address, its exact code,
// its fp1 fingerprint), the neutral reason texts and the disclaimer.
export { keccak_256 } from '@noble/hashes/sha3.js';
export { threatQueries, readThreat, reasonText, DISCLAIMER, REPRODUCE, plainText, codeHash, fingerprint1 } from '../../zetaphy-network/src/vaccine.js';
