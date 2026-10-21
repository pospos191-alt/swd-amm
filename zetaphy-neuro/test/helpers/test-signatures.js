// Similarity datasets for the TESTS (src/threat-signatures.js ships empty).
// SAMPLES: the reference samples built from test contracts, without an
// on-chain flag reference, as they really are. FLAGGED: the same entries
// with a made-up ThreatRegistry reference, to test the "flagged by runners"
// wording and the high severity of an exact match.
import { THREAT_SIGNATURES } from '../../src/threat-signatures.js';
import { REFERENCE_SAMPLES } from '../fixtures/reference-samples.generated.js';

export { REFERENCE_SAMPLES };
export const fakeFlag = (fingerprint) => ({ key: '0x' + fingerprint.slice(4), reportHash: '0x' + 'ab'.repeat(32) });
export const SAMPLES = { ...THREAT_SIGNATURES, entries: REFERENCE_SAMPLES };
export const FLAGGED = { ...THREAT_SIGNATURES, entries: REFERENCE_SAMPLES.map((e) => ({ ...e, flag: fakeFlag(e.fingerprint) })) };
