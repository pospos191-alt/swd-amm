// Signed messages between Neuro instances, across contracts and chains.
//
// A message is EIP-712 typed data signed by a runner key. It names the
// sending agent and the receiving agent (or 0 = broadcast) by their ERC-8004
// agentId in the NeuroIdentity registry that the EIP-712 domain points at.
//
// A message from another Neuro is DATA, NEVER A COMMAND:
//   - parseMessage() accepts only known kinds, known fields and known types,
//     within size limits; anything else is refused, not "best-effort" read.
//   - Free text has control, bidi and other invisible format characters
//     stripped, and any "scheme://" is defanged. Nothing is fetched, opened,
//     evaluated or run, and this module has no way to act on a message.
//   - verifyMessage() also checks the domain (the registry the reader trusts,
//     always required), the signature, the expiry, the nonce (with a seen-set)
//     and that the signer may speak for the sending agent: its owner, operator
//     or agentWallet; or, only while that identity is still held by the
//     registry (an unclaimed contract's Neuro, which nobody owns), a bonded
//     runner. A runner can never sign as a claimed or plain agent. What to do
//     with a verified message is up to the reader, who should treat it like
//     any other untrusted report.

import { TypedDataEncoder, verifyTypedData, keccak256, toUtf8Bytes, getAddress, isAddress } from 'ethers';
import { randomBytes } from 'node:crypto';
import { NEURO_CHAINS } from './identity.js';

export const MSG_VERSION = 1;
export const MAX_ENVELOPE_BYTES = 16 * 1024;
export const MAX_PAYLOAD_BYTES = 4 * 1024;
export const MAX_TTL_SECONDS = 7 * 24 * 3600;
export const BROADCAST = 0n;

export const MSG_TYPES = {
  NeuroMessage: [
    { name: 'fromAgent', type: 'uint256' },
    { name: 'toAgent', type: 'uint256' },
    { name: 'sourceChain', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
};

/** EIP-712 domain: bound to the identity registry that gives agentIds their meaning. */
export function msgDomain(chainId, verifyingContract) {
  return { name: 'ZETAPHY Neuro Message', version: '1', chainId: BigInt(chainId), verifyingContract: getAddress(verifyingContract) };
}

// ------------------------------------------------------------------ schemas

const REASONS = ['drainer', 'honeypot', 'hidden-mint', 'fake-token', 'phishing', 'other'];

/** The only kinds there are. required/optional: field -> type. */
export const KINDS = {
  hello: { required: { name: 'text:64' }, optional: { version: 'text:32', kinds: 'kinds' } },
  verdict: {
    required: { chain: 'chain', address: 'target', verdictHash: 'bytes32', score: 'score' },
    optional: { fingerprint: 'bytes32', jobId: 'uint', summary: 'text:280' },
  },
  'threat-report': {
    required: { chain: 'chain', address: 'target', fingerprint: 'bytes32', reason: `enum:${REASONS.join(',')}` },
    optional: { severity: 'enum:low,medium,high', note: 'text:280' },
  },
  ack: { required: { ref: 'bytes32' }, optional: { note: 'text:140' } },
};

// Cc (controls), Cf (bidi overrides/isolates, zero-width, BOM, soft hyphen…), Co/Cn are dropped.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu;
const SEPARATORS = /[\p{Zl}\p{Zp}\s]+/gu;

/** Plain, inert text: invisible characters stripped, whitespace collapsed, links defanged. */
export function cleanText(s) {
  const out = String(s).normalize('NFC').replace(SEPARATORS, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim()
    .replace(/([a-z][a-z0-9+.-]{0,30}):\/\//gi, '$1[:]//')
    .replace(/\b(javascript|data|vbscript|file):/gi, '$1[:]');
  return out;
}

const TARGET_RE = /^(?:[A-Za-z0-9._:-]|%[0-9A-F]{2}){1,128}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
const UINT64_MAX = (1n << 64n) - 1n;
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

class MsgError extends Error {}
const fail = (m) => { throw new MsgError(m); };
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const onlyKeys = (o, allowed, what) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${what}: unknown field "${k.slice(0, 40)}"`);
};

/** Checks one payload field; returns [value as signed, cleaned value, stripped?]. */
function field(type, v, name) {
  if (type.startsWith('text:')) {
    const max = Number(type.slice(5));
    if (typeof v !== 'string') fail(`${name}: must be text`);
    if ([...v].length > max * 2) fail(`${name}: too long`);
    const c = cleanText(v);
    if ([...c].length > max) fail(`${name}: too long (max ${max})`);
    return [v, c, c !== v];
  }
  if (type.startsWith('enum:')) {
    if (typeof v !== 'string' || !type.slice(5).split(',').includes(v)) fail(`${name}: not one of ${type.slice(5)}`);
    return [v, v, false];
  }
  switch (type) {
    case 'chain': if (typeof v !== 'string' || !Object.hasOwn(NEURO_CHAINS, v)) fail(`${name}: unknown chain`); return [v, v, false];
    case 'target': if (typeof v !== 'string' || !TARGET_RE.test(v)) fail(`${name}: not a canonical target`); return [v, v, false];
    case 'bytes32': if (typeof v !== 'string' || !BYTES32_RE.test(v)) fail(`${name}: must be 0x + 64 lowercase hex`); return [v, v, false];
    case 'uint': if (typeof v !== 'string' || !UINT_RE.test(v)) fail(`${name}: must be a decimal string`); return [v, v, false];
    case 'score': if (!Number.isInteger(v) || v < 0 || v > 100) fail(`${name}: must be an integer 0-100`); return [v, v, false];
    case 'kinds':
      if (!Array.isArray(v) || v.length > 8 || !v.every((k) => typeof k === 'string' && Object.hasOwn(KINDS, k))) fail(`${name}: must list known kinds (max 8)`);
      return [v, [...v], false];
    default: fail(`${name}: bad schema`);
  }
}

/** Validates a payload for `kind`. Returns { raw, data, stripped } where data is the cleaned, frozen copy. */
export function checkPayload(kind, payload) {
  if (!Object.hasOwn(KINDS, kind)) fail(`unknown kind "${String(kind).slice(0, 40)}"`);
  if (!isPlain(payload)) fail('payload must be a JSON object');
  const { required, optional } = KINDS[kind];
  onlyKeys(payload, [...Object.keys(required), ...Object.keys(optional)], 'payload');
  const raw = {}, data = {};
  let stripped = false;
  for (const [k, t] of [...Object.entries(required), ...Object.entries(optional)]) {
    if (!Object.hasOwn(payload, k)) { if (Object.hasOwn(required, k)) fail(`payload: missing "${k}"`); continue; }
    const [r, c, s] = field(t, payload[k], k);
    raw[k] = r; data[k] = c; stripped ||= s;
  }
  if (Buffer.byteLength(canonicalJson(raw)) > MAX_PAYLOAD_BYTES) fail(`payload over ${MAX_PAYLOAD_BYTES} bytes`);
  return { raw, data: deepFreeze(data), stripped };
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

/** Sorted keys, no spaces: the bytes that payloadHash commits to. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const payloadHash = (payload) => keccak256(toUtf8Bytes(canonicalJson(payload)));

// ------------------------------------------------------------------ parsing

/**
 * Strict parse of an envelope (JSON text or object). Throws on anything it
 * does not know. Returns { domain, message, payload?, data?, stripped, signature }.
 */
export function parseMessage(input) {
  let text = input;
  if (typeof input !== 'string') {
    try { text = JSON.stringify(input); } catch { fail('not JSON'); }
  }
  if (typeof text !== 'string') fail('not JSON');
  if (Buffer.byteLength(text) > MAX_ENVELOPE_BYTES) fail(`message over ${MAX_ENVELOPE_BYTES} bytes`);
  let env;
  try { env = JSON.parse(text); } catch { fail('not JSON'); }
  if (!isPlain(env)) fail('message must be a JSON object');
  onlyKeys(env, ['v', 'domain', 'message', 'payload', 'signature'], 'envelope');
  if (env.v !== MSG_VERSION) fail(`unsupported version (want ${MSG_VERSION})`);

  if (!isPlain(env.domain)) fail('domain missing');
  onlyKeys(env.domain, ['chainId', 'verifyingContract'], 'domain');
  const chainId = String(env.domain.chainId ?? '');
  if (!UINT_RE.test(chainId) || chainId === '0') fail('domain.chainId: bad');
  if (typeof env.domain.verifyingContract !== 'string' || !isAddress(env.domain.verifyingContract)) fail('domain.verifyingContract: bad');

  const m = env.message;
  if (!isPlain(m)) fail('message missing');
  const names = MSG_TYPES.NeuroMessage.map((f) => f.name);
  onlyKeys(m, names, 'message');
  for (const n of names) if (!Object.hasOwn(m, n)) fail(`message: missing "${n}"`);
  for (const n of ['fromAgent', 'toAgent', 'nonce', 'expiry']) if (typeof m[n] !== 'string' || !UINT_RE.test(m[n])) fail(`message.${n}: must be a decimal string`);
  if (m.fromAgent === '0') fail('message.fromAgent: must be an agentId (not 0)');
  for (const n of ['nonce', 'expiry']) if (BigInt(m[n]) > UINT64_MAX) fail(`message.${n}: over uint64`);
  if (typeof m.sourceChain !== 'string' || !CAIP2_RE.test(m.sourceChain)) fail('message.sourceChain: must be a CAIP-2 chain id');
  if (typeof m.kind !== 'string' || !Object.hasOwn(KINDS, m.kind)) fail(`unknown kind "${String(m.kind).slice(0, 40)}"`);
  if (typeof m.payloadHash !== 'string' || !BYTES32_RE.test(m.payloadHash)) fail('message.payloadHash: must be 0x + 64 lowercase hex');
  if (typeof env.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(env.signature)) fail('signature: must be 65 bytes hex');

  const out = {
    domain: msgDomain(chainId, env.domain.verifyingContract),
    message: { ...m },
    signature: env.signature,
    stripped: false,
  };
  if (Object.hasOwn(env, 'payload')) {
    const p = checkPayload(m.kind, env.payload);
    if (payloadHash(p.raw) !== m.payloadHash) fail('payload does not match payloadHash');
    out.payload = p.raw;
    out.data = p.data;
    out.stripped = p.stripped;
  }
  return out;
}

// ------------------------------------------------------------------ replay

/** Remembers (signer, fromAgent, nonce) until the message expires. */
export function createSeenSet({ max = 50_000, entries = {} } = {}) {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k, Number(v)]));
  return {
    key: (signer, fromAgent, nonce) => `${String(signer).toLowerCase()}:${fromAgent}:${nonce}`,
    has(key) { return map.has(key); },
    add(key, expiry) {
      if (map.size >= max) this.prune(Math.floor(Date.now() / 1000));
      if (map.size >= max) throw new Error('seen-set full: refusing new messages until old ones expire');
      map.set(key, Number(expiry));
    },
    prune(now) { for (const [k, exp] of map) if (exp < now) map.delete(k); },
    get size() { return map.size; },
    toJSON() { return Object.fromEntries(map); },
  };
}

// ------------------------------------------------------------------ signing

/**
 * Builds and signs a message. `wallet` is an ethers Wallet (the runner key).
 * Text in the payload is cleaned before signing, so what is signed is what a
 * reader sees.
 */
export async function signMessage(wallet, { chainId, registry, fromAgent, toAgent = 0, sourceChain, kind, payload, inline = true, ttl = 3600, now = Math.floor(Date.now() / 1000), nonce } = {}) {
  if (!(ttl > 0 && ttl <= MAX_TTL_SECONDS)) throw new Error(`ttl must be 1-${MAX_TTL_SECONDS} seconds`);
  if (!Object.hasOwn(KINDS, kind)) throw new Error(`unknown kind "${kind}" (one of: ${Object.keys(KINDS).join(', ')})`);
  const cleaned = {};
  const types = { ...KINDS[kind].required, ...KINDS[kind].optional };
  for (const [k, v] of Object.entries(payload ?? {})) cleaned[k] = typeof v === 'string' && types[k]?.startsWith('text:') ? cleanText(v) : v;
  const { raw } = checkPayload(kind, cleaned);
  const message = {
    fromAgent: BigInt(fromAgent).toString(),
    toAgent: BigInt(toAgent).toString(),
    sourceChain: String(sourceChain),
    kind,
    payloadHash: payloadHash(raw),
    nonce: (nonce ?? BigInt('0x' + randomBytes(8).toString('hex'))).toString(),
    expiry: String(Math.floor(now) + Math.floor(ttl)),
  };
  const domain = msgDomain(chainId, registry);
  const signature = await wallet.signTypedData(domain, MSG_TYPES, message);
  const env = { v: MSG_VERSION, domain: { chainId: domain.chainId.toString(), verifyingContract: domain.verifyingContract }, message, signature };
  if (inline) env.payload = raw;
  parseMessage(env); // never hand out something our own parser would refuse
  return env;
}

export const messageDigest = (domain, message) => TypedDataEncoder.hash(domain, MSG_TYPES, message);

/**
 * Verifies a message. Never throws on bad input; returns
 * { ok, reason?, signer?, role?, digest?, message?, data?, stripped? }.
 *
 * opts.expect      { chainId, registry }: the domain this reader trusts (required)
 * opts.isOperator  async (agentId, address) => bool   owner/operator/agentWallet of fromAgent?
 * opts.isRunner    async (address) => bool       bonded NeuroJobs runner?
 * opts.isRegistryHeld async (agentId) => bool    is fromAgent still held by the registry
 *                  (ownerOf == registry: an unclaimed Neuro identity)? A runner
 *                  is accepted only for such an agent, so give both or neither.
 * opts.seen        createSeenSet() to refuse replays (the message is recorded on success)
 * opts.me          this reader's agentId: refuse messages addressed to another agent
 * opts.now         unix seconds
 */
export async function verifyMessage(input, opts = {}) {
  const now = Math.floor(opts.now ?? Date.now() / 1000);
  let p;
  try { p = parseMessage(input); } catch (e) { return { ok: false, reason: e instanceof MsgError ? e.message : 'unreadable message' }; }
  const { domain, message } = p;
  const base = { message, data: p.data, stripped: p.stripped };
  if (!opts.expect) return { ok: false, reason: 'no expected domain (give expect: { chainId, registry })', ...base };
  let sameDomain;
  try {
    sameDomain = BigInt(opts.expect.chainId) === domain.chainId && getAddress(opts.expect.registry) === domain.verifyingContract;
  } catch { return { ok: false, reason: 'bad expected domain', ...base }; }
  if (!sameDomain) return { ok: false, reason: 'signed for a different identity registry', ...base };
  const expiry = Number(message.expiry);
  if (expiry <= now) return { ok: false, reason: 'expired', ...base };
  if (expiry - now > MAX_TTL_SECONDS) return { ok: false, reason: 'expiry too far in the future', ...base };
  if (opts.me != null && message.toAgent !== '0' && message.toAgent !== BigInt(opts.me).toString()) {
    return { ok: false, reason: 'addressed to another agent', ...base };
  }
  let signer;
  try { signer = verifyTypedData(domain, MSG_TYPES, message, p.signature); } catch { return { ok: false, reason: 'bad signature', ...base }; }
  const digest = messageDigest(domain, message);
  const runnerCheck = !!(opts.isRunner && opts.isRegistryHeld);
  if (!opts.isOperator && !runnerCheck) {
    return { ok: false, reason: 'no way to check the signer (give isOperator, and/or isRunner with isRegistryHeld)', signer, digest, ...base };
  }
  const from = BigInt(message.fromAgent);
  let role = null;
  try {
    if (opts.isOperator && await opts.isOperator(from, signer) === true) role = 'operator';
    // A runner speaks only for an identity nobody owns yet (held by the registry).
    else if (runnerCheck && await opts.isRegistryHeld(from) === true && await opts.isRunner(signer) === true) role = 'runner';
  } catch { return { ok: false, reason: 'could not check the signer', signer, digest, ...base }; }
  if (!role) {
    return { ok: false, reason: `signer may not speak for agent ${message.fromAgent} (not its owner/operator/agentWallet, and not a bonded runner signing for an unclaimed Neuro identity)`, signer, digest, ...base };
  }
  if (opts.seen) {
    const key = opts.seen.key(signer, message.fromAgent, message.nonce);
    if (opts.seen.has(key)) return { ok: false, reason: 'replay: nonce already seen', signer, role, digest, ...base };
    try { opts.seen.add(key, expiry); } catch (e) { return { ok: false, reason: e.message, signer, role, digest, ...base }; }
  }
  return { ok: true, signer, role, digest, notice: 'data from another Neuro, not a command', ...base };
}
