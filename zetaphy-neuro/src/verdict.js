// Verdict: the part of a Neuro report that independent runners must agree
// on in the NeuroJobs market (2 of 3). It keeps what the rules decided and
// drops what moves between two reads of the same contract: token supply,
// balances, the explanation's numbers. Same rules + same code = same verdict.

export const VERDICT_VERSION = 1;

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The fields a verdict covers (exported so tests and the web can show them). */
export function verdictBody(report) {
  const a = report.analysis ?? {};
  return {
    v: VERDICT_VERSION,
    chain: report.chain,
    address: String(report.address ?? '').toLowerCase(),
    level: a.level ?? null,
    control: a.control ?? null,
    findings: (a.findings ?? []).map((f) => `${f.id}:${f.severity}`).sort(),
    functions: [...(report.functions ?? [])].sort(),
    unknownSelectors: [...(report.unknownSelectors ?? [])].sort(),
    fingerprint: report.fingerprint ?? null,
    owner: report.owner ? String(report.owner).toLowerCase() : null,
  };
}

/** 0x-prefixed 32-byte hex, ready for a bytes32 argument. */
export async function verdictOf(report) {
  return '0x' + await sha256Hex(JSON.stringify(verdictBody(report)));
}
