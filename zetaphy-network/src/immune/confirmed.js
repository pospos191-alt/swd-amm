// Cross-chain vaccines from confirmed exploits (docs/future/immune-score.md, SS5): the JS side of ImmuneVaccines.
//   - patternOf / strengthOf: the same pattern and match rule as the contract (body hash = the code without its CBOR
//     metadata; distinctive dispatcher selectors = vaccines.js signatureOf(code).selectors), so a scanner knows which
//     contracts to send to checkMatch before paying for it;
//   - readVaccine: the on-chain record (eth_call ImmuneVaccines.vaccineOf);
//   - confirmedReport: the record + the vulnerable code -> the report NeuroJobs runners vote on (detector
//     `confirmed`), carrying the full vaccine (exact / fingerprint / similarity / selectors) that ImmuneRegistry stores
//     with the flag and ImmuneBroadcaster carries to every ImmuneMirror: sentinels on every chain then scan with it.
import { Interface } from 'ethers';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { signatureOf, codeHashOf } from './vaccines.js';
import { confirmedVerdict } from './detectors.js';
import { toReport } from './sentinel.js';
import { toHex, fromHex } from './evidence.js';

export const MATCH = { none: 0, selectors: 1, body: 2, exact: 3 };
export const SOURCE = { auditFinding: 1, revokedCert: 2, insurance: 3 };
const MAX_SELECTORS = 64;
const MIN_SELECTORS = 3;
const MATCH_BPS = 8000;

export const VACCINES_ABI = [
  'function vaccineOf(bytes32 id) view returns (tuple(uint64 chainId, address target, bytes32 codeHash, bytes32 bodyHash, uint8 severity, uint8 sources, bool active, uint64 createdAt, uint64 retiredAt, uint32 matches, bytes4[] selectors))',
  'function matchOf(address c) view returns (bytes32 vaccine, uint8 strength, bool held, uint64 at, address owner, bool active)',
  'function exploitsOf(uint64 chainId, address target) view returns (uint32 n, uint64 last)',
  'function idOf(uint64 chainId, address target, bytes32 codeHash) pure returns (bytes32)',
  'function count() view returns (uint256)',
  'function ids(uint256) view returns (bytes32)',
  'function checkMatch(bytes32 id, address c) returns (uint8)',
];
export const vaccinesIface = new Interface(VACCINES_ABI);

/** Length of runtime code without its CBOR metadata (Neuro's codeLengthWithoutMetadata, ImmuneVaccines.bodyLength). */
export function bodyLength(bytes) {
  const n = bytes.length;
  if (n < 4) return n;
  const metaLen = (bytes[n - 2] << 8) | bytes[n - 1];
  if (metaLen === 0 || n < metaLen + 3) return n;
  const start = n - 2 - metaLen;
  return bytes[start] >= 0xa1 && bytes[start] <= 0xa5 ? start : n;
}

/** { bodyHash, selectors } exactly as ImmuneVaccines.patternOf(code). */
export function patternOf(code) {
  const b = fromHex(code);
  const bodyHash = toHex(keccak_256(b.subarray(0, bodyLength(b))));
  const selectors = signatureOf(code).selectors.slice(0, MAX_SELECTORS).map((s) => '0x' + s);
  return { bodyHash, selectors };
}

/** Every dispatcher selector of the body (not baseline-filtered), as ImmuneVaccines._dispatched. */
function dispatched(code) {
  const b = fromHex(code);
  const end = bodyLength(b);
  const out = new Set();
  for (let pc = 0; pc < end; pc++) {
    const op = b[pc];
    if (op < 0x60 || op > 0x7f) continue;
    const w = op - 0x5f;
    if (w === 4 && pc + 5 < b.length) {
      const next = b[pc + 5];
      const next2 = pc + 6 < b.length ? b[pc + 6] : 0;
      if (next === 0x14 || (next === 0x81 && next2 === 0x14)) out.add(toHex(b.subarray(pc + 1, pc + 5)));
    }
    pc += w;
  }
  return out;
}

/** How strongly `code` matches a vaccine record { codeHash, bodyHash, selectors }: 3 exact, 2 body, 1 selectors, 0. */
export function strengthOf(v, code) {
  if (!/^0x([0-9a-f]{2})+$/i.test(code ?? '')) return MATCH.none;
  if (codeHashOf(code) === String(v.codeHash).toLowerCase()) return MATCH.exact;
  if (!v.bodyHash || /^0x0{64}$/.test(v.bodyHash)) return MATCH.none;
  if (patternOf(code).bodyHash === String(v.bodyHash).toLowerCase()) return MATCH.body;
  const want = (v.selectors ?? []).map((s) => String(s).toLowerCase());
  if (want.length < MIN_SELECTORS) return MATCH.none;
  const have = dispatched(code);
  const hit = want.filter((s) => have.has(s)).length;
  return hit * 10_000 >= want.length * MATCH_BPS ? MATCH.selectors : MATCH.none;
}

/** The record of vaccine `id`: { chainId, target, codeHash, bodyHash, severity, sources, active, ..., selectors }. */
export async function readVaccine(send, address, id) {
  const raw = await send('eth_call', [{ to: address, data: vaccinesIface.encodeFunctionData('vaccineOf', [id]) }, 'latest']);
  const v = vaccinesIface.decodeFunctionResult('vaccineOf', raw)[0];
  return { chainId: Number(v.chainId), target: v.target.toLowerCase(), codeHash: v.codeHash.toLowerCase(), bodyHash: v.bodyHash.toLowerCase(),
    severity: Number(v.severity), sources: Number(v.sources), active: v.active, createdAt: Number(v.createdAt), retiredAt: Number(v.retiredAt),
    matches: Number(v.matches), selectors: [...v.selectors].map((s) => s.toLowerCase()) };
}

/**
 * Which of `candidates` (addresses on the chain `send` reads, e.g. ZETAPHY's recent contracts) match vaccine `v`,
 * strongest first: [{ address, strength }]. The caller then sends checkMatch(id, address) for each (the contract
 * re-checks everything on chain).
 */
export async function findMatches(send, v, candidates) {
  const out = [];
  for (const a of candidates) {
    const code = await send('eth_getCode', [a, 'latest']);
    const s = strengthOf(v, code);
    if (s) out.push({ address: String(a).toLowerCase(), strength: s });
  }
  return out.sort((x, y) => y.strength - x.strength);
}

/**
 * The report NeuroJobs runners vote on for a confirmed exploit (detector `confirmed`): the exploit contract's code
 * hash flagged on every chain, with the vaccine derived from `code` (sentinel.js toReport).
 */
export function confirmedReport({ record, id, code, vaccines, observedAt = Math.floor(Date.now() / 1000) }) {
  const { selectors: _pattern, ...rest } = record; // the bundle carries the code itself
  const inputs = { chainId: record.chainId, address: record.target, code, vaccines, id, record: rest };
  const [f] = confirmedVerdict(inputs);
  if (!f) throw new Error('the record does not confirm this code (inactive, or another code hash)');
  return toReport(f, { detector: 'confirmed', inputs, code, observedAt });
}
