// "Do useful work": the logic shared by the page (work.js), its Web Worker (work-worker.js), the
// runners' CLI (zetaphy-network `zetaphy work` / `zetaphy bounty`) and the tests. No DOM, no network,
// no imports: Neuro's code and Keccak are passed in (the page loads them from ./neuro/src/, the
// tests and the CLI from zetaphy-neuro/src/), so this file runs the same in a browser and in Node.
//
//   - a small ABI codec (static and dynamic types, arrays, tuples) for UsefulWork and BugBounty;
//   - the code-only Neuro scan: readContract over an RPC that only knows the job's bytecode, so the
//     verdict depends on the code alone (no owner reads, no sourcify, no trade simulation) and every
//     honest worker gets the same one;
//   - commitments, exactly as the contracts compute them.

// ------------------------------------------------------------------ hex
export const strip = (h) => String(h).replace(/^0x/i, '');
export const toHex = (bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
export function fromHex(h) {
  const s = strip(h);
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('bad hex');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
const pad32 = (hexNo0x) => hexNo0x.padStart(64, '0');
const utf8 = (s) => new TextEncoder().encode(s);

/** keccak256 over hex or bytes, as 0x hex (k: Neuro's keccak256(bytes) -> bytes). */
export const keccakHex = (k, data) => toHex(k(typeof data === 'string' ? fromHex(data) : data));
export const selector = (k, sig) => keccakHex(k, utf8(sig)).slice(0, 10);
/** 32 random bytes as 0x hex. */
export const randomSalt = () => toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));

// ------------------------------------------------------------------ ABI codec
/** 'uint256' | 'bytes32[]' | '(address,uint64,string)' → a type tree. */
export function parseType(t) {
  t = t.trim();
  if (t.endsWith('[]')) return { kind: 'array', of: parseType(t.slice(0, -2)) };
  if (t.startsWith('(')) {
    const inner = t.slice(1, -1);
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of inner) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return { kind: 'tuple', of: parts.map(parseType) };
  }
  const m = /^(uint|int)(\d*)$/.exec(t);
  if (m) return { kind: m[1], bits: Number(m[2] || 256) };
  if (t === 'address' || t === 'bool' || t === 'string' || t === 'bytes') return { kind: t };
  const b = /^bytes(\d+)$/.exec(t);
  if (b) return { kind: 'bytesN', n: Number(b[1]) };
  throw new Error(`abi: unsupported type ${t}`);
}
const dynamic = (t) => t.kind === 'string' || t.kind === 'bytes' || t.kind === 'array' || (t.kind === 'tuple' && t.of.some(dynamic));
/** Bytes a type takes in the head: a static tuple sits inline (all its words), anything else is one word. */
const headSize = (t) => (t.kind === 'tuple' && !dynamic(t) ? t.of.reduce((s, x) => s + headSize(x), 0) : 32);

function encodeOne(t, v) {
  switch (t.kind) {
    case 'uint': { const x = BigInt(v); if (x < 0n || x >> BigInt(t.bits)) throw new Error('abi: uint out of range'); return pad32(x.toString(16)); }
    case 'int': { let x = BigInt(v); if (x < 0n) x += 1n << 256n; return pad32(x.toString(16)); }
    case 'address': { const a = strip(v); if (!/^[0-9a-fA-F]{40}$/.test(a)) throw new Error('abi: bad address'); return pad32(a.toLowerCase()); }
    case 'bool': return pad32(v ? '1' : '0');
    case 'bytesN': { const h = strip(v); if (h.length !== t.n * 2 || /[^0-9a-fA-F]/.test(h)) throw new Error(`abi: bad bytes${t.n}`); return h.toLowerCase().padEnd(64, '0'); }
    case 'string': case 'bytes': {
      const b = t.kind === 'string' ? utf8(v) : (typeof v === 'string' ? fromHex(v) : v);
      const h = strip(toHex(b));
      return pad32(b.length.toString(16)) + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
    }
    case 'array': return pad32(v.length.toString(16)) + encodeSeq(v.map(() => t.of), v);
    case 'tuple': return encodeSeq(t.of, v);
    default: throw new Error('abi: type');
  }
}
function encodeSeq(types, values) {
  if (types.length !== values.length) throw new Error('abi: wrong number of values');
  let head = '', tail = '';
  const headLen = types.reduce((s, t) => s + headSize(t), 0);
  types.forEach((t, i) => {
    const enc = encodeOne(t, values[i]);
    if (dynamic(t)) { head += pad32((headLen + tail.length / 2).toString(16)); tail += enc; } else head += enc;
  });
  return head + tail;
}
/** ABI-encodes values (no selector), 0x hex. */
export const encodeArgs = (types, values) => `0x${encodeSeq(types.map(parseType), values)}`;
/** Calldata: selector(sig) + args, with the types read from the signature. */
export function calldata(k, sig, values = []) {
  const types = splitTypes(sig.slice(sig.indexOf('(') + 1, -1));
  return selector(k, sig) + encodeSeq(types.map(parseType), values);
}
function splitTypes(list) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function decodeOne(t, d, at) {
  const word = (o) => d.slice(o * 2, o * 2 + 64);
  switch (t.kind) {
    case 'uint': return BigInt(`0x${word(at)}`);
    case 'int': { const x = BigInt(`0x${word(at)}`); return x >> 255n ? x - (1n << 256n) : x; }
    case 'address': return `0x${word(at).slice(24)}`;
    case 'bool': return BigInt(`0x${word(at)}`) !== 0n;
    case 'bytesN': return `0x${word(at).slice(0, t.n * 2)}`;
    case 'string': case 'bytes': {
      const n = Number(BigInt(`0x${word(at)}`));
      const h = d.slice((at + 32) * 2, (at + 32 + n) * 2);
      return t.kind === 'string' ? new TextDecoder().decode(fromHex(h)) : `0x${h}`;
    }
    case 'array': {
      const n = Number(BigInt(`0x${word(at)}`));
      return decodeSeq(Array(n).fill(t.of), d, at + 32);
    }
    case 'tuple': return decodeSeq(t.of, d, at);
    default: throw new Error('abi: type');
  }
}
function decodeSeq(types, d, base) {
  let slot = base;
  return types.map((t) => {
    const at = slot;
    slot += headSize(t);
    return dynamic(t) ? decodeOne(t, d, base + Number(BigInt(`0x${d.slice(at * 2, at * 2 + 64)}`))) : decodeOne(t, d, at);
  });
}
/** Decodes return data for these types: an array of values (tuples as arrays). */
export const decodeArgs = (types, hex) => decodeSeq(types.map(parseType), strip(hex), 0);

// ------------------------------------------------------------------ the contracts' surface
/** UsefulWork.Job, in field order (getJob returns it). */
export const JOB_FIELDS = ['poster', 'createdAt', 'closedAt', 'commitWindow', 'revealWindow', 'seats', 'quorum', 'taken', 'revealed',
  'subsidized', 'settled', 'canaryRevealed', 'minScore', 'fee', 'deposit', 'chain', 'codeHash', 'canary', 'canaryVerdict', 'result', 'target'];
export const JOB_TUPLE = '(address,uint64,uint64,uint32,uint32,uint8,uint8,uint8,uint8,bool,bool,bool,uint16,uint128,uint128,bytes32,bytes32,bytes32,bytes32,bytes32,string)';
export const PARAM_FIELDS = ['stampBits', 'stampSeats', 'stampLife', 'seatsPerDay', 'seats', 'quorum', 'commitWindow', 'revealWindow', 'seatDeposit', 'subsidy', 'priorityScore', 'priorityWindow'];
export const PARAM_TYPES = ['uint8', 'uint16', 'uint32', 'uint16', 'uint8', 'uint8', 'uint32', 'uint32', 'uint128', 'uint128', 'uint16', 'uint32'];
export const BOUNTY_FIELDS = ['sponsor', 'deadline', 'paid', 'refunded', 'reward', 'subsidy', 'specHash', 'specURI', 'findings'];
export const BOUNTY_TUPLE = '(address,uint64,bool,bool,uint128,uint128,bytes32,string,uint256[])';
export const FINDING_FIELDS = ['bounty', 'finder', 'committedAt', 'commitBlock', 'revealedAt', 'state', 'yes', 'no', 'deposit', 'commitment', 'findingHash'];
export const FINDING_TUPLE = '(uint256,address,uint64,uint64,uint64,uint8,uint8,uint8,uint128,bytes32,bytes32)';
export const FINDING_STATES = ['none', 'committed', 'revealed', 'accepted', 'rejected', 'paid', 'closed'];
/** UsefulWork.phase(): 0 taking seats, 1 revealing, 2 ready to settle, 3 settled. */
export const PHASES = ['open', 'reveal', 'settle', 'settled'];

export const named = (fields, values) => Object.fromEntries(fields.map((f, i) => [f, values[i]]));

/** bytes32 of a short ASCII string (like ethers' encodeBytes32String): the job's chain key. */
export function bytes32String(s) {
  const b = utf8(s);
  if (b.length > 31) throw new Error('too long');
  return `0x${strip(toHex(b)).padEnd(64, '0')}`;
}
export function parseBytes32String(h) {
  const b = fromHex(h);
  let n = b.indexOf(0);
  if (n < 0) n = b.length;
  return new TextDecoder().decode(b.slice(0, n));
}

// ------------------------------------------------------------------ commitments
/** UsefulWork.commitmentOf: keccak(abi.encode(verdict, worker, salt, jobId)). */
export const jobCommitment = (k, verdict, worker, salt, id) => keccakHex(k, encodeArgs(['bytes32', 'address', 'bytes32', 'uint256'], [verdict, worker, salt, id]));
/** UsefulWork canary: keccak(abi.encode(verdict, salt, jobId)). */
export const canaryCommitment = (k, verdict, salt, id) => keccakHex(k, encodeArgs(['bytes32', 'bytes32', 'uint256'], [verdict, salt, id]));
/** BugBounty.commitmentOf: keccak(abi.encode(findingHash, finder, salt, bountyId)). */
export const findingCommitment = (k, findingHash, finder, salt, bountyId) => keccakHex(k, encodeArgs(['bytes32', 'address', 'bytes32', 'uint256'], [findingHash, finder, salt, bountyId]));

// ------------------------------------------------------------------ the scan
/** The ZETAPHY testnet as a Neuro chain (a runner reads it with the same config). */
export const ZETAPHY_CHAIN = { kind: 'evm', id: 77390, name: 'ZETAPHY', rpcs: [] };
const ZERO_WORD = `0x${'0'.repeat(64)}`;

/**
 * An RPC that knows one contract's bytecode and nothing else: eth_getCode returns it, storage reads
 * are empty and every eth_call reverts. Neuro's reader then scans the code alone.
 */
export function codeOnlyRpc(code) {
  return {
    async call(method) {
      if (method === 'eth_getCode') return code;
      if (method === 'eth_getStorageAt') return ZERO_WORD;
      if (method === 'eth_call') throw new Error('execution reverted');
      throw new Error(`code-only scan: no ${method}`);
    },
  };
}

/** The chains a browser scan job may name: ZETAPHY and Neuro's EVM chains. */
export function scanChain(chainKey, CHAINS) {
  if (chainKey === 'zetaphy') return ZETAPHY_CHAIN;
  const c = CHAINS?.[chainKey];
  return c?.kind === 'evm' ? c : null;
}

/**
 * The code-only verdict of one job: neuro = { readContract, verdictOf, keccak256, CHAINS }.
 * The code must hash to the job's codeHash (the poster's view), or nothing is scanned.
 */
export async function codeVerdict(neuro, { chain, target, code, codeHash }) {
  const cfg = scanChain(chain, neuro.CHAINS);
  if (!cfg) throw new Error(`chain ${chain}: not an EVM chain this scan reads`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(target))) throw new Error('target: not an EVM address');
  if (!code || strip(code).length === 0) throw new Error('no code at the target');
  const got = keccakHex(neuro.keccak256, code);
  if (codeHash && got.toLowerCase() !== String(codeHash).toLowerCase()) throw new Error('the code changed since the job was posted');
  const report = await neuro.readContract(chain, target.toLowerCase(), { rpc: codeOnlyRpc(code), sourcify: false, simulate: false, chainConfig: cfg });
  return { verdict: await neuro.verdictOf(report), report };
}
