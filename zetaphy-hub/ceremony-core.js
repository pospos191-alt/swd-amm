// The phase-2 trusted-setup ceremony transcript for Neuro's zkML circuit (docs/future/onchain-ml.md, item 4):
// one pure module shared by the browser contribution page (ceremony.html) and the CLI / CI verifier
// (zetaphy-neuro/ml/onchain/zk/ceremony/ceremony.js). No DOM, no Node APIs: only globalThis.crypto.subtle (sha256).
//
// Transcript (ceremony/transcript.json), format "zetaphy-zk-ceremony/1":
//   init           the zkey `snarkjs groth16 setup` makes from the circuit and the pinned phase-1 file. Deterministic,
//                  so anyone can rebuild it and check its sha256. link0 = H(tag, circuit csHash, ptau sha256, init sha256).
//   contributions  one entry per phase-2 step, in order: { index, type: "contribution" | "beacon", name, github,
//                  contributionHash (snarkjs' blake2b of the step's public key), zkeySha256, zkeyBytes, url, link }.
//                  link_k = sha256 over (tag, link_{k-1}, k, type, name, github, contributionHash, zkeySha256[, beacon fields]):
//                  each entry commits to the whole history before it, so no step can be dropped, reordered or swapped.
//   beacon         named in advance by the owner (e.g. { chain: "ethereum", block: N, iterationsExp: 10 }) while the
//                  ceremony is open; the last entry is then the beacon step with that block's hash. After it the zkey is final.
// Soundness needs only ONE honest contributor: if any one participant destroyed their random value, nobody (not even all
// the others together) can forge proofs. The beacon only removes the last contributor's ability to bias the result.

export const FORMAT = 'zetaphy-zk-ceremony/1';
export const TAG = 'zetaphy-zk-ceremony-v1';
export const HEX64 = /^[0-9a-f]{64}$/;
export const HEX128 = /^[0-9a-f]{128}$/;
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** A zkey is published as a GitHub release asset (the contributor's fork or this repo): no server we run. */
export const ZKEY_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/releases\/download\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\.zkey$/;
export const MAX_NAME = 64; // snarkjs keeps 64 characters of a contribution's name

const enc = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

/** sha256 of bytes (Uint8Array / ArrayBuffer) or a string, as 64 lowercase hex. */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/** A contribution name: printable, no line breaks, at most 64 characters (what snarkjs stores). */
export const validName = (s) => typeof s === 'string' && s.trim() === s && s.length >= 1 && s.length <= MAX_NAME && !/[\u0000-\u001f\u007f]/.test(s);

/** link0: binds the circuit, the phase-1 file and the initial zkey. */
export const initLink = (csHash, ptauSha256, initSha256) => sha256Hex([TAG, 'init', csHash, ptauSha256, initSha256].join('\n'));

/** link_k for an entry given link_{k-1}. */
export function entryLink(prev, e) {
  const parts = [TAG, prev, String(e.index), e.type, e.name, e.github ?? '', e.contributionHash, e.zkeySha256];
  if (e.type === 'beacon') parts.push(e.beacon.chain, String(e.beacon.block), e.beacon.blockHash, String(e.beacon.iterationsExp));
  return sha256Hex(parts.join('\n'));
}

/** The current tip: { index, link, zkeySha256 } of the last entry (or the init zkey). */
export function tip(t) {
  const last = t.contributions[t.contributions.length - 1];
  return last ? { index: last.index, link: last.link, zkeySha256: last.zkeySha256, final: last.type === 'beacon' } : { index: 0, link: t.init.link, zkeySha256: t.init.zkeySha256, final: false };
}

/** Problems with the transcript's own structure and hash chain (does not open any zkey). [] = fine. */
export async function checkChain(t) {
  const bad = [];
  if (!t || t.format !== FORMAT) return [`format is not ${FORMAT}`];
  if (!HEX128.test(t.circuit?.csHash ?? '')) bad.push('circuit.csHash: 128 hex');
  if (!HEX64.test(t.phase1?.sha256 ?? '')) bad.push('phase1.sha256: 64 hex');
  if (!HEX64.test(t.init?.zkeySha256 ?? '')) bad.push('init.zkeySha256: 64 hex');
  if (bad.length) return bad;
  if (t.init.link !== await initLink(t.circuit.csHash, t.phase1.sha256, t.init.zkeySha256)) bad.push('init.link does not match');
  if (!Array.isArray(t.contributions)) return [...bad, 'contributions: not a list'];
  let prev = t.init.link;
  const seen = new Set([t.init.zkeySha256]);
  for (const [i, e] of t.contributions.entries()) {
    const at = `contributions[${i}]`;
    if (e.index !== i + 1) bad.push(`${at}.index must be ${i + 1}`);
    if (e.type !== 'contribution' && e.type !== 'beacon') bad.push(`${at}.type`);
    if (!validName(e.name)) bad.push(`${at}.name: 1-${MAX_NAME} printable characters`);
    if (e.type === 'contribution' && !GITHUB_LOGIN.test(e.github ?? '')) bad.push(`${at}.github: a GitHub login`);
    if (!HEX128.test(e.contributionHash ?? '')) bad.push(`${at}.contributionHash: 128 hex (snarkjs blake2b)`);
    if (!HEX64.test(e.zkeySha256 ?? '')) bad.push(`${at}.zkeySha256: 64 hex`);
    else if (seen.has(e.zkeySha256)) bad.push(`${at}.zkeySha256 repeats an earlier zkey`);
    seen.add(e.zkeySha256);
    if (!ZKEY_URL.test(e.url ?? '')) bad.push(`${at}.url: a GitHub release asset https://github.com/<owner>/<repo>/releases/download/<tag>/<file>.zkey`);
    if (e.type === 'beacon') {
      if (i !== t.contributions.length - 1) bad.push(`${at}: the beacon must be the last step`);
      const b = e.beacon ?? {};
      const d = t.beacon ?? {};
      if (b.chain !== d.chain || b.block !== d.block || b.iterationsExp !== d.iterationsExp) bad.push(`${at}.beacon is not the beacon named in advance (transcript.beacon)`);
      if (!/^[0-9a-f]{64}$/.test(b.blockHash ?? '')) bad.push(`${at}.beacon.blockHash: 64 hex`);
      if (t.contributions.filter((x) => x.type === 'contribution').length < (t.minContributions ?? 1)) bad.push(`${at}: fewer than minContributions (${t.minContributions}) contributions before the beacon`);
    }
    if (bad.length) return bad;
    const want = await entryLink(prev, e);
    if (e.link !== want) bad.push(`${at}.link does not chain from the previous entry`);
    prev = want;
  }
  return bad;
}

/** A new contribution entry on top of the transcript's tip (link computed). */
export async function nextEntry(t, { name, github, contributionHash, zkeySha256, zkeyBytes, url }) {
  const index = tip(t).index + 1;
  const e = { index, type: 'contribution', name, github, contributionHash, zkeySha256, zkeyBytes, url };
  e.link = await entryLink(tip(t).link, e);
  return e;
}

/** The beacon (final) entry. */
export async function beaconEntry(t, { name = 'Final beacon', blockHash, contributionHash, zkeySha256, zkeyBytes, url }) {
  const index = tip(t).index + 1;
  const e = { index, type: 'beacon', name, contributionHash, zkeySha256, zkeyBytes, url, beacon: { ...t.beacon, blockHash } };
  e.link = await entryLink(tip(t).link, e);
  return e;
}

const strip = (t) => JSON.stringify({ ...t, contributions: undefined });
const without = (t, k) => JSON.stringify({ ...t, [k]: undefined });

/**
 * The owner names the beacon in advance: a PR that changes only `beacon`, from null to { chain, block, iterationsExp },
 * once at least minContributions contributions are in. (That the block is still in the future is checked against the
 * chain by the CLI, and again at finalization against the time the declaration was merged.)
 */
export function checkDeclare(base, head, chains = ['ethereum', 'zetaphy']) {
  const problems = [];
  if (without(base, 'beacon') !== without(head, 'beacon')) problems.push('a beacon declaration changes only `beacon`');
  if (base.beacon) problems.push('the beacon is already named');
  const b = head.beacon ?? {};
  if (!chains.includes(b.chain)) problems.push(`beacon.chain: one of ${chains.join(', ')}`);
  if (!Number.isSafeInteger(b.block) || b.block <= 0) problems.push('beacon.block: a block number');
  if (!Number.isInteger(b.iterationsExp) || b.iterationsExp < 10 || b.iterationsExp > 63) problems.push('beacon.iterationsExp: 10..63 (2^n hash iterations)');
  if (Object.keys(b).sort().join() !== 'block,chain,iterationsExp') problems.push('beacon: exactly { chain, block, iterationsExp }');
  if (base.contributions.filter((x) => x.type === 'contribution').length < (base.minContributions ?? 1)) problems.push(`fewer than minContributions (${base.minContributions}) contributions so far`);
  return problems;
}

/**
 * The only change a contribution PR may make: append exactly one contribution (or, once the beacon is named, the
 * beacon step) and change nothing else. Returns { added, problems }.
 */
export async function checkAppend(base, head) {
  const problems = [...(await checkChain(head)).map((x) => `new transcript: ${x}`)];
  if (problems.length) return { added: null, problems };
  if (strip(base) !== strip(head)) problems.push('only contributions may change in a contribution PR (circuit, phase1, init, beacon, settings are fixed)');
  if (tip(base).final) problems.push('the ceremony is already final');
  if (head.contributions.length !== base.contributions.length + 1) problems.push('add exactly one entry');
  for (const [i, e] of base.contributions.entries()) if (JSON.stringify(head.contributions[i]) !== JSON.stringify(e)) problems.push(`entry ${i + 1} was changed`);
  const added = head.contributions.at(-1) ?? null;
  if (added?.type === 'beacon' && !base.beacon) problems.push('no beacon was named in advance');
  if (added?.type === 'contribution' && base.beacon) problems.push('the beacon is named: contributions are closed');
  return { added, problems };
}

/**
 * Entropy for a browser or CLI contribution: 64 bytes from a CSPRNG plus whatever the person typed (and any extra
 * bytes, e.g. key timings), hashed together. snarkjs mixes in its own CSPRNG bytes as well.
 */
export async function mixEntropy(random, typed = '', extra = '') {
  if (!(random instanceof Uint8Array) || random.length < 32) throw new Error('need at least 32 random bytes');
  return (await sha256Hex(hex(random) + '\n' + typed + '\n' + extra)) + hex(random.slice(0, 32));
}

/**
 * The contribution hashes (and beacon fields) that snarkjs' `zkey verify` logs, in order:
 * [{ n, name, hash, beaconHash?, iterationsExp? }]. `lines` are the logger's info messages.
 */
export function parseVerifyLog(lines) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const s = String(raw);
    const m = s.match(/^contribution #(\d+) ?(.*?):\s*\n([\s0-9a-f]+)$/);
    if (m) { cur = { n: Number(m[1]), name: m[2], hash: m[3].replace(/\s+/g, '') }; out.push(cur); continue; }
    const b = s.match(/^Beacon generator: ([0-9a-f]+)$/);
    if (b && cur) cur.beaconHash = b[1];
    const it = s.match(/^Beacon iterations Exp: (\d+)$/);
    if (it && cur) cur.iterationsExp = Number(it[1]);
  }
  return out.sort((a, b) => a.n - b.n);
}

/** The circuit hash snarkjs logs ("Circuit Hash: " + 4 lines of hex), as 128 hex. */
export function parseCircuitHash(lines) {
  for (const s of lines.map(String)) {
    const m = s.match(/^Circuit hash:\s*\n([\s0-9a-f]+)$/i);
    if (m) return m[1].replace(/\s+/g, '');
  }
  return null;
}

/** Transcript entries vs the contributions inside the zkey (from parseVerifyLog). [] = they agree. */
export function matchZkey(t, logged) {
  const bad = [];
  if (logged.length !== t.contributions.length) bad.push(`the zkey has ${logged.length} contributions, the transcript ${t.contributions.length}`);
  for (const [i, e] of t.contributions.entries()) {
    const z = logged[i];
    if (!z) break;
    if (z.hash !== e.contributionHash) bad.push(`entry ${e.index}: contribution hash in the zkey ${z.hash.slice(0, 16)}… is not the transcript's ${e.contributionHash.slice(0, 16)}…`);
    if (z.name !== e.name) bad.push(`entry ${e.index}: name in the zkey "${z.name}" is not "${e.name}"`);
    const isBeacon = z.beaconHash !== undefined;
    if (isBeacon !== (e.type === 'beacon')) bad.push(`entry ${e.index}: type in the zkey is ${isBeacon ? 'beacon' : 'contribution'}`);
    if (isBeacon && (z.beaconHash !== e.beacon.blockHash || z.iterationsExp !== e.beacon.iterationsExp)) bad.push(`entry ${e.index}: the zkey's beacon is not the named block hash / iterations`);
  }
  return bad;
}
