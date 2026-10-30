// ZETAPHY Offline Cash, the logic without a page (docs/future/offline-cash.md). Shared by the hub's Offline tab
// (offline-cash.js, in the browser under CSP) and the CLI (zetaphy-network/src/offlinecash.js); the contract is
// zetaphy-network/contracts/ZetaphyOfflineCash.sol and every hash here is the contract's (checked in tests).
// No imports but the Mesh helpers: the caller hands in the crypto, so the same code runs in Node and the browser:
//   c = { keccak(bytes) -> bytes32, verify(sig, msg, pk) -> bool (ML-DSA-44, FIPS 204 pure, empty context),
//         headerHash?(cometHeader) -> bytes (default: the port below; the CLI passes pqcert.js's) }
// A signer is { pk: Uint8Array (1312), sign(digest32) -> Uint8Array (2420) }.
//
// A note bundle (what travels hand to hand, JSON with hex strings, or binary for Mesh):
//   { v: 1, chainId: 77390, contract, note: { id, issuer, value, lockUntil, issuerKey }, links: [{ to, cond, pk, sig }],
//     terminal?: { payout, fee, pk, sig }, proofs?: [proof items] }
// Holder 0 is note.issuerKey; link i is signed by holder i and names holder i+1 (`to`, keccak256 of its public key).
// Proof items (offline proof of funds, checked against a pinned validator set, see verifyProofItem):
//   { kind: 'results', chainId, header (CometBFT header of block H+1, JSON as /block returns it), attestations (hex:
//     (consensus address 20 || ML-DSA-44 signature 2420)*, the PQ certificate of block H+1), txIndex, total, aunts [hex],
//     result: { code, data (hex), gasWanted, gasUsed }, logIndex }
//     -> the log is in the EVM tx response of tx txIndex of block H, committed by header(H+1).last_results_hash.
//   { kind: 'attest', chainId, height, time, log: { address, topics, data }, attestations }: the fallback, validators
//     sign the log itself with their vote keys (k-of-n ML-DSA-44) when no results proof is available.
import { sha256 as sha256Sync, concat, utf8, toHex, fromHex, varint, readVarint } from './mesh-frames.js';

export const BUNDLE_VERSION = 1;
export const CHAIN_ID = 77390;
export const COSMOS_CHAIN_ID = 'zetaphy_77390-1';
export const PK_BYTES = 1312;
export const SIG_BYTES = 2420;
export const CLAIM_WINDOW = 30 * 86400;
export const BOND_BPS = 15_000n;
export const ATTESTATION_BYTES = 20 + SIG_BYTES;
export const MIN_LOCK_LEFT = 3 * 86400;     // the hub warns when a note can be reclaimed within 3 days
export const MAX_PROOF_AGE = 7 * 86400;     // bond facts older than this are "stale"
export const EVM_RESPONSE_TYPE = '/cosmos.evm.vm.v1.MsgEthereumTxResponse';
export const ZERO32 = `0x${'00'.repeat(32)}`;

export const SIGS = {
  noteIssued: 'NoteIssued(uint256,address,bytes32,uint96,uint64)',
  issuerBonded: 'IssuerBonded(address,uint256,uint64,uint256)',
  holderBonded: 'HolderBonded(bytes32,address,uint256,uint64)',
  redeem: 'redeem(uint256,(bytes32,bytes32,bytes,bytes)[],(address,uint96,bytes,bytes))',
  settleSwap: 'settleSwap((uint256,uint256,bytes32,bytes32,address,uint256,uint256,bytes32,bytes32,address,uint256),(bytes32,bytes32,bytes,bytes)[],(bytes32,bytes32,bytes,bytes)[])',
  bondHolder: 'bondHolder(bytes32,uint64)',
  notes: 'notes(uint256)',
  spentBy: 'spentBy(bytes32)',
};
const TAG_TEXT = {
  note: 'ZetaphyCash.Note(uint256 id,uint256 value,uint256 lockUntil,bytes32 issuerKey)',
  link: 'ZetaphyCash.Link(uint256 noteId,uint256 seq,bytes32 prev,bytes32 to,bytes32 cond)',
  terminal: 'ZetaphyCash.Terminal(bytes32 prev,address payout,uint256 fee)',
  swap: 'ZetaphyCash.Swap(uint256 noteA,uint256 seqA,bytes32 prevA,bytes32 toA,address payoutA,uint256 noteB,uint256 seqB,bytes32 prevB,bytes32 toB,address payoutB,uint256 deadline)',
};

// ---------------------------------------------------------------- words and hashes

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
export const isAddr = (a) => ADDR.test(String(a ?? ''));
export const isB32 = (h) => B32.test(String(h ?? ''));
export const hex = (b) => `0x${toHex(b)}`;
export const bytes = (h) => (h instanceof Uint8Array ? h : fromHex(h));
const U256 = 2n ** 256n;
export function word(v) {
  const n = BigInt(v);
  if (n < 0n || n >= U256) throw new Error('uint256 out of range');
  return fromHex(n.toString(16).padStart(64, '0'));
}
const addrWord = (a) => { if (!isAddr(a)) throw new Error(`not an address: ${a}`); return fromHex(String(a).slice(2).toLowerCase().padStart(64, '0')); };
const b32 = (h) => { const b = bytes(h); if (b.length !== 32) throw new Error('not 32 bytes'); return b; };
const k = (c, ...parts) => hex(c.keccak(concat(...parts)));
const tagCache = new WeakMap();
function tags(c) {
  let t = tagCache.get(c.keccak);
  if (!t) { t = Object.fromEntries(Object.entries(TAG_TEXT).map(([n, s]) => [n, c.keccak(utf8(s))])); tagCache.set(c.keccak, t); }
  return t;
}
export const keyHash = (c, pk) => hex(c.keccak(bytes(pk)));
export const topicOf = (c, sig) => hex(c.keccak(utf8(sig)));
export const selectorOf = (c, sig) => hex(c.keccak(utf8(sig)).subarray(0, 4));

/** The contract's DOMAIN: keccak256(abi.encode(keccak256("ZETAPHY Offline Cash v1"), chainId, contract)). */
export const domainOf = (c, chainId, contract) => k(c, c.keccak(utf8('ZETAPHY Offline Cash v1')), word(chainId), addrWord(contract));
export const noteRoot = (c, dom, n) => k(c, tags(c).note, b32(dom), word(n.id), word(n.value), word(n.lockUntil), b32(n.issuerKey));
export const linkHash = (c, dom, id, seq, prev, to, cond = ZERO32) => k(c, tags(c).link, b32(dom), word(id), word(seq), b32(prev), b32(to), b32(cond));
export const terminalHash = (c, dom, prev, payout, fee) => k(c, tags(c).terminal, b32(dom), b32(prev), addrWord(payout), word(fee));
export function ticketId(c, dom, t) {
  return k(c, tags(c).swap, b32(dom), word(t.noteA), word(t.seqA), b32(t.prevA), b32(t.toA), addrWord(t.payoutA),
    word(t.noteB), word(t.seqB), b32(t.prevB), b32(t.toB), addrWord(t.payoutB), word(t.deadline));
}
const domOfBundle = (c, b) => domainOf(c, b.chainId, b.contract);

// ---------------------------------------------------------------- bundles

/** A clean copy of a bundle (numbers as decimal strings, hex lower case); throws on anything malformed. */
export function cleanBundle(b) {
  if (!b || typeof b !== 'object' || b.v !== BUNDLE_VERSION) throw new Error('not a ZETAPHY note (v1)');
  const n = b.note ?? {};
  const dec = (v, what) => { if (!/^\d{1,78}$/.test(String(v))) throw new Error(`note: bad ${what}`); return String(BigInt(v)); };
  if (!isAddr(b.contract) || !isAddr(n.issuer) || !isB32(n.issuerKey)) throw new Error('note: bad contract, issuer or issuer key');
  const lk = (l) => {
    if (!l || !isB32(l.to) || !(l.cond == null || isB32(l.cond))) throw new Error('note: bad link');
    const pk = bytes(l.pk), sig = bytes(l.sig);
    if (pk.length !== PK_BYTES || sig.length !== SIG_BYTES) throw new Error('note: link key or signature has the wrong size');
    return { to: l.to.toLowerCase(), cond: (l.cond ?? ZERO32).toLowerCase(), pk: hex(pk), sig: hex(sig) };
  };
  if (!Array.isArray(b.links) || b.links.length > 64) throw new Error('note: bad links');
  const out = {
    v: 1, chainId: Number(dec(b.chainId, 'chain id')), contract: b.contract.toLowerCase(),
    note: { id: dec(n.id, 'id'), issuer: n.issuer.toLowerCase(), value: dec(n.value, 'value'), lockUntil: Number(dec(n.lockUntil, 'lockUntil')), issuerKey: n.issuerKey.toLowerCase() },
    links: b.links.map(lk),
  };
  if (b.terminal) {
    const t = b.terminal;
    if (!isAddr(t.payout)) throw new Error('note: bad payout');
    const pk = bytes(t.pk), sig = bytes(t.sig);
    if (pk.length !== PK_BYTES || sig.length !== SIG_BYTES) throw new Error('note: terminal key or signature has the wrong size');
    out.terminal = { payout: t.payout.toLowerCase(), fee: dec(t.fee ?? 0, 'fee'), pk: hex(pk), sig: hex(sig) };
  }
  if (Array.isArray(b.proofs)) out.proofs = b.proofs.slice(0, 16);
  return out;
}

/**
 * Checks every signature of a bundle's chain (no network): { ok, problems, prevs, msgs, keys, holder, seq, conditional }.
 * prevs[i] is what message i spends, msgs[i] the hash of link i, keys[i] holder i (keys[0] the issuer key);
 * holder = keys[n], the key that holds the note now; seq = n.
 */
export function walk(c, bundle) {
  const b = cleanBundle(bundle);
  const dom = domOfBundle(c, b);
  const prevs = [noteRoot(c, dom, b.note)], msgs = [], keys = [b.note.issuerKey];
  const problems = [];
  let conditional = false;
  b.links.forEach((l, i) => {
    const h = linkHash(c, dom, b.note.id, i, prevs[i], l.to, l.cond);
    if (keyHash(c, l.pk) !== keys[i]) problems.push(`link ${i}: signed with a key that is not holder ${i}'s`);
    else {
      let good = false;
      try { good = c.verify(bytes(l.sig), bytes(h), bytes(l.pk)); } catch { good = false; }
      if (!good) problems.push(`link ${i}: the ML-DSA-44 signature does not verify`);
    }
    if (l.cond !== ZERO32) conditional = true;
    msgs.push(h); prevs.push(h); keys.push(l.to);
  });
  const n = b.links.length;
  let terminalMsg = null;
  if (b.terminal) {
    terminalMsg = terminalHash(c, dom, prevs[n], b.terminal.payout, b.terminal.fee);
    if (keyHash(c, b.terminal.pk) !== keys[n]) problems.push('terminal: not signed by the current holder');
    else {
      let good = false;
      try { good = c.verify(bytes(b.terminal.sig), bytes(terminalMsg), bytes(b.terminal.pk)); } catch { good = false; }
      if (!good) problems.push('terminal: the ML-DSA-44 signature does not verify');
    }
    if (BigInt(b.terminal.fee) > BigInt(b.note.value)) problems.push('terminal: the fee is above the note value');
  }
  return { ok: problems.length === 0, problems, prevs, msgs, keys, holder: keys[n], seq: n, conditional, terminalMsg, bundle: b, domain: dom };
}

/** The bundle passed on to key `to` (keccak256 of the next holder's ML-DSA-44 public key), signed by `signer`. */
export function passOn(c, bundle, signer, to, { cond = ZERO32 } = {}) {
  const w = walk(c, bundle);
  if (!w.ok) throw new Error(`cannot pass on a note that does not verify: ${w.problems[0]}`);
  if (w.conditional) throw new Error('a swap leg cannot be passed on: settle the swap');
  if (w.bundle.terminal) throw new Error('this note already has a cash-out signature: it cannot be passed on');
  if (!isB32(to) || to === ZERO32) throw new Error('the next holder is a 32-byte key hash (0x + 64 hex)');
  if (keyHash(c, signer.pk) !== w.holder) throw new Error('you are not the holder of this note');
  const h = linkHash(c, w.domain, w.bundle.note.id, w.seq, w.prevs[w.seq], to, cond);
  const out = { ...w.bundle, links: [...w.bundle.links, { to: to.toLowerCase(), cond: cond.toLowerCase(), pk: hex(signer.pk), sig: hex(signer.sign(bytes(h))) }] };
  delete out.proofs;
  if (bundle.proofs) out.proofs = bundle.proofs;
  return out;
}

/** The holder's cash-out signature: pay the note to `payout`, `fee` to whoever submits it (a relayer). */
export function signTerminal(c, bundle, signer, payout, fee = 0n) {
  const w = walk(c, bundle);
  if (!w.ok) throw new Error(`the note does not verify: ${w.problems[0]}`);
  if (keyHash(c, signer.pk) !== w.holder) throw new Error('you are not the holder of this note');
  if (!isAddr(payout)) throw new Error('payout: a 0x address');
  if (BigInt(fee) > BigInt(w.bundle.note.value)) throw new Error('the fee is above the note value');
  const h = terminalHash(c, w.domain, w.prevs[w.seq], payout, fee);
  return { ...w.bundle, terminal: { payout: payout.toLowerCase(), fee: String(BigInt(fee)), pk: hex(signer.pk), sig: hex(signer.sign(bytes(h))) } };
}

/**
 * Two chains of one note: where they split, and who double-spent. null when one extends the other.
 * { seq, cheater (key hash), issuer (true when the issuer split it), a, b (the two messages) }.
 * Terminals count: a holder that passed the note on AND signed a cash-out of the same position split it.
 */
export function findSplit(c, a, b) {
  const wa = walk(c, a), wb = walk(c, b);
  if (wa.domain !== wb.domain || wa.bundle.note.id !== wb.bundle.note.id) throw new Error('not the same note');
  if (wa.prevs[0] !== wb.prevs[0]) throw new Error('the note terms differ (not the same issuance)');
  const ma = [...wa.msgs, ...(wa.terminalMsg ? [wa.terminalMsg] : [])];
  const mb = [...wb.msgs, ...(wb.terminalMsg ? [wb.terminalMsg] : [])];
  for (let i = 0; i < Math.min(ma.length, mb.length); i++) {
    if (ma[i] !== mb[i]) return { seq: i, cheater: wa.keys[i], issuer: i === 0, a: ma[i], b: mb[i], valid: wa.ok && wb.ok };
  }
  return null;
}

// ---------------------------------------------------------------- swap tickets

/**
 * A swap ticket: holder P of note `a` and holder Q of note `b` trade them. toA = Q's key (gets A), toB = P's key,
 * payoutA = where A's value goes when settled (Q's address), payoutB likewise (P's). Deadline: unix seconds.
 */
export function makeTicket(c, { a, b, toA, toB, payoutA, payoutB, deadline }) {
  const wa = walk(c, a), wb = walk(c, b);
  if (!wa.ok || !wb.ok) throw new Error('both notes must verify');
  if (wa.conditional || wb.conditional) throw new Error('a note in a pending swap cannot be swapped again');
  if (wa.domain !== wb.domain) throw new Error('both notes must be of the same contract and chain');
  if (wa.bundle.note.id === wb.bundle.note.id) throw new Error('two different notes are needed');
  if (![toA, toB].every(isB32) || ![payoutA, payoutB].every(isAddr)) throw new Error('keys are 0x + 64 hex, payouts 0x addresses');
  return { noteA: wa.bundle.note.id, seqA: wa.seq, prevA: wa.prevs[wa.seq], toA: toA.toLowerCase(), payoutA: payoutA.toLowerCase(),
    noteB: wb.bundle.note.id, seqB: wb.seq, prevB: wb.prevs[wb.seq], toB: toB.toLowerCase(), payoutB: payoutB.toLowerCase(), deadline: Number(deadline) };
}
/** The holder of leg 'A' or 'B' signs it (a link whose cond is the ticket id). Returns the swap bundle with that leg. */
export function signLeg(c, swap, leg, signer) {
  const t = swap.ticket;
  const side = leg === 'A' ? 'a' : 'b';
  const bundle = swap[side];
  const w = walk(c, bundle);
  const L = leg === 'A' ? { seq: t.seqA, prev: t.prevA, to: t.toA } : { seq: t.seqB, prev: t.prevB, to: t.toB };
  if (w.seq !== L.seq || w.prevs[w.seq] !== L.prev) throw new Error(`leg ${leg}: the note is not where the ticket says`);
  if (keyHash(c, signer.pk) !== w.holder) throw new Error(`leg ${leg}: you are not the holder of this note`);
  const tid = ticketId(c, w.domain, t);
  const h = linkHash(c, w.domain, w.bundle.note.id, w.seq, L.prev, L.to, tid);
  return { ...swap, [`sig${leg}`]: { pk: hex(signer.pk), sig: hex(signer.sign(bytes(h))) } };
}
/** A swap bundle { v, kind: 'swap', ticket, a, b, sigA?, sigB? }: the two chains with their legs appended (when signed). */
export const newSwap = (c, a, b, ticketArgs) => ({ v: 1, kind: 'swap', ticket: makeTicket(c, { a, b, ...ticketArgs }), a: cleanBundle(a), b: cleanBundle(b) });
/** Each note's chain with its signed leg appended (for settleSwap), or null for a leg not signed yet. */
export function swapChains(c, swap) {
  const t = swap.ticket;
  const dom = domainOf(c, swap.a.chainId, swap.a.contract);
  const tid = ticketId(c, dom, t);
  const leg = (bundle, s, to) => (s ? { ...bundle, links: [...bundle.links, { to, cond: tid, pk: s.pk, sig: s.sig }] } : null);
  return { tid, a: leg(swap.a, swap.sigA, t.toA), b: leg(swap.b, swap.sigB, t.toB) };
}
/** Checks a swap bundle offline: { ok (both legs signed and valid), complete, problems, tid }. */
export function verifySwap(c, swap, { now = Math.floor(Date.now() / 1000) } = {}) {
  const problems = [];
  if (!swap || swap.kind !== 'swap' || !swap.ticket) return { ok: false, complete: false, problems: ['not a swap ticket'] };
  const t = swap.ticket;
  let tid = null;
  try {
    const wa = walk(c, swap.a), wb = walk(c, swap.b);
    if (!wa.ok || !wb.ok) problems.push('a note in the ticket does not verify');
    if (wa.bundle.note.id !== String(t.noteA) || wb.bundle.note.id !== String(t.noteB)) problems.push('the ticket names other notes');
    if (wa.seq !== Number(t.seqA) || wa.prevs[wa.seq] !== t.prevA || wb.seq !== Number(t.seqB) || wb.prevs[wb.seq] !== t.prevB) problems.push('a note is not where the ticket says');
    const ch = swapChains(c, swap);
    tid = ch.tid;
    for (const [leg, bundle] of [['A', ch.a], ['B', ch.b]]) {
      if (!bundle) continue;
      const w = walk(c, bundle);
      if (!w.ok) problems.push(`leg ${leg}: ${w.problems.at(-1)}`);
    }
  } catch (e) { problems.push(e.message); }
  if (Number(t.deadline) <= now) problems.push('the ticket deadline has passed');
  const complete = !!(swap.sigA && swap.sigB);
  return { ok: problems.length === 0 && complete, complete, problems, tid };
}

// ---------------------------------------------------------------- binary (Mesh payloads)

const u8 = (n) => Uint8Array.of(n);
function readN(buf, i, n) { if (i + n > buf.length) throw new Error('truncated'); return [buf.subarray(i, i + n), i + n]; }
/** A bundle as compact bytes: no JSON, no hex (the keys and signatures are 3,732 of each link's 3,765 bytes). */
export function encodeBundle(bundle) {
  const b = cleanBundle(bundle);
  const parts = [u8(BUNDLE_VERSION), varint(b.chainId), bytes(b.contract), varint(b.note.id), bytes(b.note.issuer), varint(b.note.value),
    varint(b.note.lockUntil), bytes(b.note.issuerKey), varint(b.links.length)];
  for (const l of b.links) {
    const cond = l.cond !== ZERO32;
    parts.push(bytes(l.to), u8(cond ? 1 : 0), ...(cond ? [bytes(l.cond)] : []), bytes(l.pk), bytes(l.sig));
  }
  if (b.terminal) parts.push(u8(1), bytes(b.terminal.payout), varint(b.terminal.fee), bytes(b.terminal.pk), bytes(b.terminal.sig));
  else parts.push(u8(0));
  return concat(...parts);
}
export function decodeBundle(buf, start = 0, { withEnd = false } = {}) {
  let i = start, v, x;
  if (buf[i++] !== BUNDLE_VERSION) throw new Error('not a ZETAPHY note (v1)');
  const out = { v: 1, note: {}, links: [] };
  [v, i] = readVarint(buf, i); out.chainId = Number(v);
  [x, i] = readN(buf, i, 20); out.contract = hex(x);
  [v, i] = readVarint(buf, i); out.note.id = String(v);
  [x, i] = readN(buf, i, 20); out.note.issuer = hex(x);
  [v, i] = readVarint(buf, i); out.note.value = String(v);
  [v, i] = readVarint(buf, i); out.note.lockUntil = Number(v);
  [x, i] = readN(buf, i, 32); out.note.issuerKey = hex(x);
  let n;
  [n, i] = readVarint(buf, i);
  if (n > 64n) throw new Error('too many links');
  for (let j = 0; j < Number(n); j++) {
    const l = {};
    [x, i] = readN(buf, i, 32); l.to = hex(x);
    const flag = buf[i++];
    if (flag === 1) { [x, i] = readN(buf, i, 32); l.cond = hex(x); } else if (flag === 0) l.cond = ZERO32; else throw new Error('bad link flag');
    [x, i] = readN(buf, i, PK_BYTES); l.pk = hex(x);
    [x, i] = readN(buf, i, SIG_BYTES); l.sig = hex(x);
    out.links.push(l);
  }
  const tf = buf[i++];
  if (tf === 1) {
    const t = {};
    [x, i] = readN(buf, i, 20); t.payout = hex(x);
    [v, i] = readVarint(buf, i); t.fee = String(v);
    [x, i] = readN(buf, i, PK_BYTES); t.pk = hex(x);
    [x, i] = readN(buf, i, SIG_BYTES); t.sig = hex(x);
    out.terminal = t;
  } else if (tf !== 0) throw new Error('bad terminal flag');
  if (!withEnd && i !== buf.length) throw new Error('trailing bytes');
  const b = cleanBundle(out);
  return withEnd ? [b, i] : b;
}
export function encodeSwap(swap) {
  const t = swap.ticket;
  const sig = (s) => (s ? concat(u8(1), bytes(s.pk), bytes(s.sig)) : u8(0));
  return concat(varint(t.noteA), varint(t.seqA), bytes(t.prevA), bytes(t.toA), bytes(t.payoutA), varint(t.noteB), varint(t.seqB), bytes(t.prevB), bytes(t.toB),
    bytes(t.payoutB), varint(t.deadline), sig(swap.sigA), sig(swap.sigB), encodeBundle(swap.a), encodeBundle(swap.b));
}
export function decodeSwap(buf) {
  let i = 0, v, x;
  const t = {};
  const num = () => { [v, i] = readVarint(buf, i); return String(v); };
  const b = (n) => { [x, i] = readN(buf, i, n); return hex(x); };
  t.noteA = num(); t.seqA = Number(num()); t.prevA = b(32); t.toA = b(32); t.payoutA = b(20);
  t.noteB = num(); t.seqB = Number(num()); t.prevB = b(32); t.toB = b(32); t.payoutB = b(20); t.deadline = Number(num());
  const sig = () => { const f = buf[i++]; if (f === 0) return undefined; if (f !== 1) throw new Error('bad flag'); return { pk: b(PK_BYTES), sig: b(SIG_BYTES) }; };
  const sigA = sig(), sigB = sig();
  let a, bb;
  [a, i] = decodeBundle(buf, i, { withEnd: true });
  [bb, i] = decodeBundle(buf, i, { withEnd: true });
  if (i !== buf.length) throw new Error('trailing bytes');
  const out = { v: 1, kind: 'swap', ticket: t, a, b: bb };
  if (sigA) out.sigA = sigA;
  if (sigB) out.sigB = sigB;
  return out;
}
/** A proof item as bytes: varint(json length) | JSON without attestations | raw attestations. */
export function encodeProof(item) {
  const { attestations, ...rest } = item;
  const j = utf8(JSON.stringify(rest));
  return concat(varint(j.length), j, bytes(attestations ?? '0x'));
}
export function decodeProof(buf) {
  const [len, i] = readVarint(buf, 0);
  const end = i + Number(len);
  if (end > buf.length) throw new Error('truncated proof');
  const rest = JSON.parse(new TextDecoder().decode(buf.subarray(i, end)));
  return { ...rest, attestations: hex(buf.subarray(end)) };
}

// ---------------------------------------------------------------- ABI (calldata for redeem / settleSwap)

const LINK_T = { tuple: ['bytes32', 'bytes32', 'bytes', 'bytes'] };
const TERM_T = { tuple: ['address', 'uint', 'bytes', 'bytes'] };
const TICKET_T = { tuple: ['uint', 'uint', 'bytes32', 'bytes32', 'address', 'uint', 'uint', 'bytes32', 'bytes32', 'address', 'uint'] };
const isDyn = (t) => t === 'bytes' || !!t.array || (!!t.tuple && t.tuple.some(isDyn));
function encodeOne(t, v) {
  if (t === 'uint') return word(v);
  if (t === 'address') return addrWord(v);
  if (t === 'bytes32') return b32(v);
  if (t === 'bytes') { const b = bytes(v); const pad = new Uint8Array((32 - (b.length % 32)) % 32); return concat(word(b.length), b, pad); }
  if (t.array) return concat(word(v.length), encodeSeq(v.map(() => t.array), v));
  if (t.tuple) return encodeSeq(t.tuple, v);
  throw new Error('abi type');
}
function encodeSeq(types, values) {
  const enc = types.map((t, i) => encodeOne(t, values[i]));
  const heads = [], tails = [];
  let off = types.reduce((n, t, i) => n + (isDyn(t) ? 32 : enc[i].length), 0); // a static tuple sits in the head
  types.forEach((t, i) => {
    if (isDyn(t)) { heads.push(word(off)); tails.push(enc[i]); off += enc[i].length; } else heads.push(enc[i]);
  });
  return concat(...heads, ...tails);
}
const linkTuple = (l) => [l.to, l.cond, l.pk, l.sig];
/** redeem(id, links, terminal) calldata (hex) for a bundle with a terminal. */
export function encodeRedeem(c, bundle) {
  const b = cleanBundle(bundle);
  if (!b.terminal) throw new Error('sign the cash-out first');
  const t = b.terminal;
  return hex(concat(bytes(selectorOf(c, SIGS.redeem)), encodeSeq(['uint', { array: LINK_T }, TERM_T], [b.note.id, b.links.map(linkTuple), [t.payout, t.fee, t.pk, t.sig]])));
}
/** settleSwap(ticket, linksA, linksB) calldata (hex) for a fully signed swap bundle. */
export function encodeSettleSwap(c, swap) {
  const ch = swapChains(c, swap);
  if (!ch.a || !ch.b) throw new Error('both legs must be signed');
  const t = swap.ticket;
  return hex(concat(bytes(selectorOf(c, SIGS.settleSwap)), encodeSeq([TICKET_T, { array: LINK_T }, { array: LINK_T }],
    [[t.noteA, t.seqA, t.prevA, t.toA, t.payoutA, t.noteB, t.seqB, t.prevB, t.toB, t.payoutB, t.deadline], ch.a.links.map(linkTuple), ch.b.links.map(linkTuple)])));
}
export const encodeBondHolder = (c, key, until) => hex(concat(bytes(selectorOf(c, SIGS.bondHolder)), b32(key), word(until)));
export const encodeNotes = (c, id) => hex(concat(bytes(selectorOf(c, SIGS.notes)), word(id)));
/** notes(id) return data -> { issuer, value, lockUntil, done, issuerKey } (null for an unknown note). */
export function decodeNotes(retHex) {
  const b = bytes(retHex);
  if (b.length < 160) return null;
  const w = (i) => BigInt(hex(b.subarray(32 * i, 32 * i + 32)));
  const issuer = `0x${toHex(b.subarray(12, 32))}`;
  if (/^0x0{40}$/.test(issuer)) return null;
  return { issuer, value: String(w(1)), lockUntil: Number(w(2)), done: w(3) !== 0n, issuerKey: hex(b.subarray(128, 160)) };
}

// ---------------------------------------------------------------- CometBFT header hash (a port of zetaphy-network/src/pqcert.js)

const leafHash = (h, b) => h(concat(Uint8Array.of(0), b));
const innerHash = (h, l, r) => h(concat(Uint8Array.of(1), l, r));
/** CometBFT merkle.HashFromByteSlices (RFC 6962). */
export function merkleRoot(items, h = sha256Sync) {
  if (items.length === 0) return h(new Uint8Array());
  if (items.length === 1) return leafHash(h, items[0]);
  let s = 1;
  while (s * 2 < items.length) s *= 2;
  return innerHash(h, merkleRoot(items.slice(0, s), h), merkleRoot(items.slice(s), h));
}
/** The aunts of leaf `index` (CometBFT merkle.ProofsFromByteSlices), deepest first. */
export function merkleAunts(items, index, h = sha256Sync) {
  if (items.length <= 1) return [];
  let s = 1;
  while (s * 2 < items.length) s *= 2;
  return index < s ? [...merkleAunts(items.slice(0, s), index, h), merkleRoot(items.slice(s), h)]
    : [...merkleAunts(items.slice(s), index - s, h), merkleRoot(items.slice(0, s), h)];
}
/** CometBFT Proof.Verify: the root from a leaf, its index, the total and the aunts. */
export function rootFromAunts(leaf, index, total, aunts, h = sha256Sync) {
  const go = (lh, i, t, au) => {
    if (i >= t || i < 0) throw new Error('merkle index out of range');
    if (t === 1) { if (au.length) throw new Error('merkle: extra aunts'); return lh; }
    if (!au.length) throw new Error('merkle: missing aunts');
    let s = 1;
    while (s * 2 < t) s *= 2;
    const last = au[au.length - 1], rest = au.slice(0, -1);
    return i < s ? innerHash(h, go(lh, i, s, rest), last) : innerHash(h, last, go(lh, i - s, t - s, rest));
  };
  return go(leafHash(h, leaf), index, total, aunts);
}
const pbKey = (field, wire) => varint((field << 3) | wire);
const pbVarint = (field, v) => (BigInt(v ?? 0) === 0n ? new Uint8Array() : concat(pbKey(field, 0), varint(BigInt.asUintN(64, BigInt(v)))));
const pbBytes = (field, b) => (b.length ? concat(pbKey(field, 2), varint(b.length), b) : new Uint8Array());
const pbMessage = (field, b) => concat(pbKey(field, 2), varint(b.length), b);
const hx = (s) => fromHex(s ?? '');
function timestampBytes(t) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(String(t));
  if (!m) throw new Error(`unsupported time ${t}`);
  const ms = Date.parse(`${m[1]}Z`);
  if (!Number.isFinite(ms)) throw new Error(`unsupported time ${t}`);
  return concat(pbVarint(1, BigInt(ms / 1000)), pbVarint(2, Number((m[2] ?? '').padEnd(9, '0'))));
}
/** The hash of a CometBFT header as /block returns it (types.Header.Hash). */
export function headerHash(hd, h = sha256Sync) {
  const blockId = (id) => concat(pbBytes(1, hx(id?.hash)), pbMessage(2, concat(pbVarint(1, BigInt(id?.parts?.total ?? 0)), pbBytes(2, hx(id?.parts?.hash)))));
  return merkleRoot([
    concat(pbVarint(1, BigInt(hd.version?.block ?? 0)), pbVarint(2, BigInt(hd.version?.app ?? 0))),
    pbBytes(1, utf8(hd.chain_id ?? '')),
    pbVarint(1, BigInt(hd.height)),
    timestampBytes(hd.time),
    blockId(hd.last_block_id),
    ...['last_commit_hash', 'data_hash', 'validators_hash', 'next_validators_hash', 'consensus_hash',
      'app_hash', 'last_results_hash', 'evidence_hash', 'proposer_address'].map((key) => pbBytes(1, hx(hd[key]))),
  ], h);
}
/** CometBFT's deterministic ExecTxResult bytes (code 1, data 2, gas_wanted 5, gas_used 6): what last_results_hash commits. */
export const resultLeaf = (r) => concat(pbVarint(1, r.code ?? 0), pbBytes(2, bytes(r.data ?? '0x')), pbVarint(5, r.gasWanted ?? 0), pbVarint(6, r.gasUsed ?? 0));
/** The bytes a validator signs for block `height` (zetaphy/pq-vote; pqcert.js voteMessage). */
export function voteMessage(chainId, height, hash) {
  const be = new Uint8Array(8);
  new DataView(be.buffer).setBigUint64(0, BigInt(height));
  return concat(utf8(`zetaphy/pq-vote\0${chainId}\0`), be, hash);
}
/** The bytes validators sign in the attestation fallback: the log itself, at a height and time. */
export function attestMessage(c, chainId, height, time, log) {
  const be = new Uint8Array(16);
  const dv = new DataView(be.buffer);
  dv.setBigUint64(0, BigInt(height)); dv.setBigUint64(8, BigInt(time));
  const body = c.keccak(concat(bytes(log.address), ...log.topics.map(b32), bytes(log.data ?? '0x')));
  return concat(utf8(`zetaphy/cash-attest\0${chainId}\0`), be, body);
}

// ---------------------------------------------------------------- the EVM logs inside a tx result

function pbFields(buf) {
  const out = [];
  for (let i = 0; i < buf.length;) {
    let key, value;
    [key, i] = readVarint(buf, i);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) [value, i] = readVarint(buf, i);
    else if (wire === 2) { let len; [len, i] = readVarint(buf, i); if (BigInt(buf.length - i) < len) throw new Error('truncated field'); value = buf.subarray(i, i + Number(len)); i += Number(len); }
    else if (wire === 1 || wire === 5) { const n = wire === 1 ? 8 : 4; value = buf.subarray(i, i + n); i += n; }
    else throw new Error(`unsupported wire type ${wire}`);
    out.push({ field, wire, value });
  }
  return out;
}
const dec = (b) => new TextDecoder().decode(b);
/** The EVM logs in an ExecTxResult's data (TxMsgData.msg_responses[*] MsgEthereumTxResponse.logs), in order; vmError if any. */
export function logsOfResult(dataBytes) {
  const logs = [];
  let vmError = '';
  for (const any of pbFields(dataBytes).filter((f) => f.field === 2 && f.wire === 2)) {
    const af = pbFields(any.value);
    if (dec(af.find((f) => f.field === 1)?.value ?? new Uint8Array()) !== EVM_RESPONSE_TYPE) continue;
    const resp = pbFields(af.find((f) => f.field === 2)?.value ?? new Uint8Array());
    for (const f of resp) {
      if (f.field === 4 && f.wire === 2 && f.value.length) vmError = dec(f.value);
      if (f.field !== 2 || f.wire !== 2) continue;
      const lf = pbFields(f.value);
      logs.push({ address: dec(lf.find((x) => x.field === 1)?.value ?? new Uint8Array()).toLowerCase(),
        topics: lf.filter((x) => x.field === 2).map((x) => dec(x.value).toLowerCase()), data: hex(lf.find((x) => x.field === 3)?.value ?? new Uint8Array()) });
    }
  }
  return { logs, vmError };
}
/** The inverse, for tests and tools: an ExecTxResult data blob holding one EVM response with these logs. */
export function encodeResultData(logs) {
  const log = (l) => concat(pbBytes(1, utf8(l.address)), ...l.topics.map((t) => pbBytes(2, utf8(t))), pbBytes(3, bytes(l.data ?? '0x')));
  const resp = concat(pbBytes(1, utf8('0x' + 'ab'.repeat(32))), ...logs.map((l) => pbMessage(2, log(l))), pbVarint(5, 50_000));
  return concat(pbMessage(2, concat(pbBytes(1, utf8(EVM_RESPONSE_TYPE)), pbBytes(2, resp))));
}

// ---------------------------------------------------------------- offline proof of funds

/** A pinned validator set (zetaphy pq export-keys / pqcert.js exportVoteKeys output). */
export function parsePin(pin) {
  const p = typeof pin === 'string' ? JSON.parse(pin) : pin;
  const map = p?.validators;
  if (!map || typeof map !== 'object') throw new Error('pinned keys: no "validators" map');
  const vals = Object.entries(map).map(([addr, v]) => {
    const a = String(addr).replace(/^0x/i, '').toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(a) || !/^\d+$/.test(String(v?.power ?? '')) || BigInt(v.power) <= 0n) throw new Error(`pinned keys: bad entry ${addr}`);
    const key = (x) => (x ? bytes(x) : null);
    return { address: a, power: BigInt(v.power), since: v.since == null ? null : BigInt(v.since), pubKey: key(v.pubKey), previousPubKey: key(v.previousPubKey) };
  });
  if (!vals.length) throw new Error('pinned keys: no validators');
  return { chainId: p.chainId ?? null, validators: vals };
}
const keyAt = (v, h) => (!v.pubKey ? null : v.since == null || v.since < BigInt(h) ? v.pubKey : v.previousPubKey);

/** Counts the ML-DSA-44 attestations over `msg` by the pinned validators valid at `height`: { signed, total, ok (> 2/3 of ALL power) }. */
export function countAttestations(c, pin, height, msg, attestations) {
  const att = bytes(attestations ?? '0x');
  const problems = [];
  if (att.length % ATTESTATION_BYTES) return { ok: false, signed: 0n, total: 0n, problems: ['attestations are not (address 20 || signature 2420)*'] };
  let total = 0n, signed = 0n;
  const by = new Map();
  for (const v of pin.validators) { total += v.power; by.set(v.address, { ...v, key: keyAt(v, height), done: false }); }
  for (let i = 0; i < att.length; i += ATTESTATION_BYTES) {
    const addr = toHex(att.subarray(i, i + 20)).toUpperCase();
    const v = by.get(addr);
    if (!v || !v.key || v.done) { problems.push(`${addr.slice(0, 8)}…: not a pinned validator with a key, or counted already`); continue; }
    let good = false;
    try { good = c.verify(att.subarray(i + 20, i + ATTESTATION_BYTES), msg, v.key); } catch { good = false; }
    if (!good) { problems.push(`${addr.slice(0, 8)}…: the signature does not verify`); continue; }
    v.done = true; signed += v.power;
  }
  return { ok: 3n * signed > 2n * total, signed, total, problems };
}

/**
 * Verifies one proof item with NO network: { ok, log, height (the block holding the log), time (unix), problems }.
 * opts: { pin (pinned validator set), chainId (cosmos chain id, default the pin's), contract? (the log must come from it) }.
 */
export function verifyProofItem(c, item, { pin, chainId, contract } = {}) {
  const problems = [];
  const fail = (m) => ({ ok: false, problems: [...problems, m] });
  let p;
  try { p = parsePin(pin); } catch (e) { return fail(e.message); }
  const chain = chainId ?? p.chainId ?? item.chainId;
  if (item.chainId !== chain) return fail(`made for chain ${item.chainId}, not ${chain}`);
  let log, height, time;
  try {
    if (item.kind === 'results') {
      const hd = item.header;
      if (hd.chain_id !== chain) return fail(`the header is of chain ${hd.chain_id}`);
      const hh = (c.headerHash ?? headerHash)(hd);
      const cert = countAttestations(c, p, hd.height, voteMessage(chain, hd.height, hh), item.attestations);
      problems.push(...cert.problems);
      if (!cert.ok) return fail(`the block certificate has ${cert.signed} of ${cert.total} power: more than 2/3 is needed`);
      const leaf = resultLeaf(item.result);
      const root = rootFromAunts(leaf, Number(item.txIndex), Number(item.total), (item.aunts ?? []).map(bytes));
      if (hex(root) !== `0x${String(hd.last_results_hash).toLowerCase()}`) return fail('the tx result is not in the certified block (last_results_hash)');
      if (Number(item.result.code ?? 0) !== 0) return fail('the transaction failed');
      const r = logsOfResult(bytes(item.result.data));
      if (r.vmError) return fail(`the transaction reverted: ${r.vmError}`);
      log = r.logs[Number(item.logIndex)];
      if (!log) return fail('no such log in the transaction');
      height = Number(hd.height) - 1;
      time = Math.floor(Date.parse(String(hd.time).replace(/\.\d+Z$/, 'Z')) / 1000);
    } else if (item.kind === 'attest') {
      log = { address: String(item.log.address).toLowerCase(), topics: item.log.topics.map((t) => t.toLowerCase()), data: String(item.log.data ?? '0x').toLowerCase() };
      const cert = countAttestations(c, p, item.height, attestMessage(c, chain, item.height, item.time, log), item.attestations);
      problems.push(...cert.problems);
      if (!cert.ok) return fail(`the attestation has ${cert.signed} of ${cert.total} power: more than 2/3 is needed`);
      height = Number(item.height); time = Number(item.time);
    } else return fail(`unknown proof kind ${item.kind}`);
  } catch (e) { return fail(`malformed proof: ${e.message}`); }
  if (contract && log.address !== String(contract).toLowerCase()) return fail('the log is from another contract');
  return { ok: true, log, height, time, problems };
}

const wordAt = (data, i) => BigInt(hex(bytes(data).subarray(32 * i, 32 * i + 32)));
const addrTopic = (t) => `0x${String(t).slice(26)}`;
/** Decodes the contract's events this module proves: { event, ... } or null. */
export function decodeCashLog(c, log) {
  const t0 = log.topics[0];
  if (t0 === topicOf(c, SIGS.noteIssued)) {
    return { event: 'NoteIssued', id: String(BigInt(log.topics[1])), issuer: addrTopic(log.topics[2]), issuerKey: hex(bytes(log.data).subarray(0, 32)),
      value: String(wordAt(log.data, 1)), lockUntil: Number(wordAt(log.data, 2)) };
  }
  if (t0 === topicOf(c, SIGS.issuerBonded)) {
    return { event: 'IssuerBonded', issuer: addrTopic(log.topics[1]), amount: String(wordAt(log.data, 0)), until: Number(wordAt(log.data, 1)), outstanding: String(wordAt(log.data, 2)) };
  }
  if (t0 === topicOf(c, SIGS.holderBonded)) {
    return { event: 'HolderBonded', key: log.topics[1], owner: addrTopic(log.topics[2]), amount: String(wordAt(log.data, 0)), until: Number(wordAt(log.data, 1)) };
  }
  return null;
}

/**
 * Proof of funds for a bundle, offline: { note: 'proven' | 'missing' | 'mismatch', facts, covered, perHolder, asOf, stale, problems }.
 * covered: how much of the note value the bonds of every key that signed in the chain answer for (the least of them):
 * the issuer bond for holder 0 (only while >= 150% of outstanding as of the proof), each later signer's holder bond
 * (only when locked until lockUntil + 30 days at least). Bonds are a snapshot "as of" the proof's block.
 */
export function proofOfFunds(c, bundle, { pin, chainId, now = Math.floor(Date.now() / 1000) } = {}) {
  const b = cleanBundle(bundle);
  const problems = [];
  const facts = { note: null, issuerBond: null, holderBonds: {} };
  let asOf = null;
  for (const item of b.proofs ?? []) {
    const r = verifyProofItem(c, item, { pin, chainId, contract: b.contract });
    if (!r.ok) { problems.push(r.problems.at(-1)); continue; }
    const ev = decodeCashLog(c, r.log);
    if (!ev) continue;
    const at = { ...ev, height: r.height, time: r.time };
    if (ev.event === 'NoteIssued' && ev.id === b.note.id) facts.note = at;
    else if (ev.event === 'IssuerBonded' && ev.issuer === b.note.issuer && (!facts.issuerBond || r.height >= facts.issuerBond.height)) facts.issuerBond = at;
    else if (ev.event === 'HolderBonded' && (!facts.holderBonds[ev.key] || r.height >= facts.holderBonds[ev.key].height)) facts.holderBonds[ev.key] = at;
    else continue;
    asOf = asOf == null ? r.time : Math.min(asOf, r.time);
  }
  const n = facts.note;
  const note = !n ? 'missing'
    : n.issuer === b.note.issuer && n.issuerKey === b.note.issuerKey && n.value === b.note.value && n.lockUntil === b.note.lockUntil ? 'proven' : 'mismatch';
  const value = BigInt(b.note.value);
  const claimUntil = b.note.lockUntil + CLAIM_WINDOW;
  const keys = [b.note.issuerKey, ...b.links.map((l) => l.to)].slice(0, b.links.length); // everyone who signed a link
  const perHolder = keys.map((key, i) => {
    if (i === 0) {
      const ib = facts.issuerBond;
      const healthy = ib && BigInt(ib.amount) * 10_000n >= BigInt(ib.outstanding) * BOND_BPS && ib.until >= claimUntil;
      return { seq: 0, key, issuer: true, bond: ib ? ib.amount : null, until: ib?.until ?? null, counts: healthy ? BigInt(ib.amount) : 0n };
    }
    const hb = facts.holderBonds[key];
    const counts = hb && hb.until >= claimUntil ? BigInt(hb.amount) : 0n;
    return { seq: i, key, issuer: false, bond: hb ? hb.amount : null, until: hb?.until ?? null, counts };
  });
  let covered = note === 'proven' ? value : 0n;
  for (const h of perHolder) if (h.counts < covered) covered = h.counts;
  return { note, facts, covered, value, perHolder, asOf, stale: asOf != null && now - asOf > MAX_PROOF_AGE, problems };
}

// ---------------------------------------------------------------- what a payee checks

/**
 * The payee's offline check of a received note: { ok, problems (codes), warnings (codes), value, seq, funds }.
 * opts: { me (my key hash), now, minLockLeft, pin, chainId, contract (the one this device trusts), evmChainId }.
 * Hard problems (ok = false): badChain, notToYou, wrongContract, wrongChain, conditional, hasTerminal, lockPassed.
 * Warnings: lockSoon, noProof, proofMismatch, staleProof, notCovered (some of the value is not covered by bonds).
 */
export function receiveCheck(c, bundle, { me, now = Math.floor(Date.now() / 1000), minLockLeft = MIN_LOCK_LEFT, pin = null, chainId, contract, evmChainId = CHAIN_ID } = {}) {
  const problems = [], warnings = [];
  let w;
  try { w = walk(c, bundle); } catch (e) { return { ok: false, problems: ['badFormat'], warnings, error: e.message }; }
  const b = w.bundle;
  if (!w.ok) problems.push('badChain');
  if (b.chainId !== Number(evmChainId)) problems.push('wrongChain');
  if (contract && b.contract !== String(contract).toLowerCase()) problems.push('wrongContract');
  if (me && w.holder !== String(me).toLowerCase()) problems.push('notToYou');
  if (w.conditional) problems.push('conditional');
  if (b.terminal) problems.push('hasTerminal');
  if (b.note.lockUntil <= now) problems.push('lockPassed');
  else if (b.note.lockUntil - now < minLockLeft) warnings.push('lockSoon');
  let funds = null;
  if (!pin || !(b.proofs?.length)) warnings.push('noProof');
  else {
    funds = proofOfFunds(c, b, { pin, chainId, now });
    if (funds.note !== 'proven') warnings.push(funds.note === 'missing' ? 'noProof' : 'proofMismatch');
    if (funds.stale) warnings.push('staleProof');
    if (funds.covered < funds.value) warnings.push('notCovered');
  }
  return { ok: problems.length === 0, problems, warnings, value: b.note.value, seq: w.seq, holder: w.holder, funds, bundle: b };
}

// ---------------------------------------------------------------- text form (copy / paste, files)

export const NOTE_PREFIX = 'ZNOTE1:';
const b64u = (b) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
/** A bundle as one line of text: ZNOTE1:<base64url of the binary bundle>[.<base64url of each proof>]. */
export const noteToText = (bundle) => NOTE_PREFIX + [encodeBundle(bundle), ...(bundle.proofs ?? []).map(encodeProof)].map(b64u).join('.');
export function noteFromText(text) {
  const s = String(text ?? '').trim();
  if (!s.startsWith(NOTE_PREFIX)) throw new Error('not a ZETAPHY note (ZNOTE1:)');
  const [head, ...proofs] = s.slice(NOTE_PREFIX.length).split('.');
  const b = decodeBundle(unb64u(head));
  if (proofs.length) b.proofs = proofs.slice(0, 16).map((p) => decodeProof(unb64u(p)));
  return b;
}
