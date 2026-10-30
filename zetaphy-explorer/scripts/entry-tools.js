// Bundle entry for vendor/zetaphy-tools-lib.js (npm run build): secp256k1 from @noble/curves
// for the Tools page (#/tools: recover the sender of a signed EVM tx, check personal_sign).
// Loaded only when that page is opened, so the other pages do not download it.
export { secp256k1 } from '@noble/curves/secp256k1.js';
