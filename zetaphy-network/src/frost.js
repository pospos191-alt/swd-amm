// FROST(secp256k1, SHA-256): two-round threshold Schnorr signatures (RFC 9591) with a distributed key
// generation (no dealer), for the AI co-signer committee (CosignCommittee.isValidFrost, checked on chain by
// FrostSecp256k1 in contracts/AgentPolicyWallet.sol).
//
// What is where:
//   - RFC 9591 §4–§5 and §6.5 (ciphersuite FROST-secp256k1-SHA256-v1): nonce generation, commitments, binding
//     factors (H1, H4, H5), group commitment, challenge (H2), signature shares, share verification,
//     aggregation, verification. Checked against the RFC's test vectors (test/fixtures/frost-secp256k1-*.json).
//   - DKG: the Pedersen DKG with proofs of knowledge from the FROST paper (Komlo & Goldberg, "FROST: Flexible
//     Round-Optimized Schnorr Threshold Signatures", SAC 2020, Figure 1 "KeyGen"), with the proof-of-knowledge
//     challenge HDKG = hash_to_field(id ‖ A0 ‖ R, DST "FROST-secp256k1-SHA256-v1dkg") and μ = k + a0·c, as the
//     Zcash Foundation's frost-core does; checked against its secp256k1 DKG vectors. The RFC itself leaves key
//     generation out of scope (its Appendix C is a trusted dealer, which we do not use).
//   - Transport (ours): round-1 packages are public; round-2 shares go to each recipient encrypted with
//     ECDH(secp256k1) → HKDF-SHA256 → AES-256-GCM, so every message can travel as a file or a copy-paste in a
//     public chat. There is no broadcast channel: participants must compare the transcript hash out of band
//     (it is printed by every step) — different hashes mean someone was shown other packages.
//
// Point arithmetic: @noble/curves (pinned 1.9.7). Hashing: node:crypto SHA-256. Secrets are BigInts in memory and
// hex in files the caller writes with mode 0600; nonces must never be used twice (the CLI deletes them on use).
import { createHash, randomBytes, createECDH, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';

const Point = secp256k1.ProjectivePoint;
export const N = secp256k1.CURVE.n;
export const CONTEXT = 'FROST-secp256k1-SHA256-v1';
const enc = new TextEncoder();

// ---------------------------------------------------------------- encodings
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => {
  const s = String(h).replace(/^0x/, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error('bad hex');
  return Uint8Array.from(Buffer.from(s, 'hex'));
};
const concat = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
export const mod = (a) => ((a % N) + N) % N;
function inv(a) {
  let r = 1n, b = mod(a), e = N - 2n;
  if (b === 0n) throw new Error('inverse of 0');
  while (e > 0n) { if (e & 1n) r = (r * b) % N; b = (b * b) % N; e >>= 1n; }
  return r;
}
/** SerializeScalar: 32 bytes big-endian. */
export const serS = (s) => unhex(mod(BigInt(s)).toString(16).padStart(64, '0'));
/** DeserializeScalar: refuses values ≥ n. */
export function desS(b) {
  const bytes = typeof b === 'string' ? unhex(b) : b;
  if (bytes.length !== 32) throw new Error('scalar: 32 bytes');
  const v = BigInt(`0x${hex(bytes)}`);
  if (v >= N) throw new Error('scalar ≥ n');
  return v;
}
/** SerializeElement: SEC1 compressed (33 bytes); the identity cannot be serialized. */
export function serE(P) {
  if (P.equals(Point.ZERO)) throw new Error('identity element');
  return P.toRawBytes(true);
}
/** DeserializeElement: a compressed point on the curve, not the identity. */
export function desE(b) {
  const bytes = typeof b === 'string' ? unhex(b) : b;
  if (bytes.length !== 33) throw new Error('element: 33 bytes');
  const P = Point.fromHex(bytes);
  P.assertValidity();
  return P;
}
const mulG = (k) => (mod(k) === 0n ? Point.ZERO : Point.BASE.multiply(mod(k)));
const mulP = (P, k) => (mod(k) === 0n ? Point.ZERO : P.multiply(mod(k)));

// ---------------------------------------------------------------- hashes (RFC 9591 §6.5)
const sha256 = (...parts) => Uint8Array.from(createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest());

/** RFC 9380 expand_message_xmd with SHA-256. */
export function expandXmd(msg, dst, lenInBytes) {
  const ell = Math.ceil(lenInBytes / 32);
  if (ell > 255 || dst.length > 255) throw new Error('xmd');
  const dstPrime = concat(dst, [dst.length]);
  const b0 = sha256(new Uint8Array(64), msg, [lenInBytes >> 8, lenInBytes & 0xff], [0], dstPrime);
  const out = [sha256(b0, [1], dstPrime)];
  for (let i = 2; i <= ell; i++) out.push(sha256(b0.map((x, j) => x ^ out[i - 2][j]), [i], dstPrime));
  return concat(...out).slice(0, lenInBytes);
}
/** hash_to_field(msg, 1) over the scalar field: 48 bytes of xmd, mod n. */
export const hashToScalar = (msg, dst) => mod(BigInt(`0x${hex(expandXmd(msg, dst, 48))}`));
const tag = (t) => enc.encode(CONTEXT + t);
export const H1 = (m) => hashToScalar(m, tag('rho'));
export const H2 = (m) => hashToScalar(m, tag('chal'));
export const H3 = (m) => hashToScalar(m, tag('nonce'));
export const H4 = (m) => sha256(tag('msg'), m);
export const H5 = (m) => sha256(tag('com'), m);
export const HDKG = (m) => hashToScalar(m, tag('dkg'));

// ---------------------------------------------------------------- RFC 9591 signing
function checkId(id) {
  const v = BigInt(id);
  if (v <= 0n || v >= N) throw new Error(`bad participant identifier ${id}`);
  return v;
}

/** §4.1 nonce_generate(secret): H3(random_bytes(32) ‖ SerializeScalar(secret)). `random` for test vectors only. */
export function nonceGenerate(secret, random = randomBytes(32)) {
  return H3(concat(random, serS(secret)));
}

/** §5.1 commit(sk_i): fresh hiding and binding nonces and their commitments. */
export function commit(secret, rand = {}) {
  const hiding = nonceGenerate(secret, rand.hiding);
  const binding = nonceGenerate(secret, rand.binding);
  return { nonces: { hiding, binding }, commitments: { hiding: mulG(hiding), binding: mulG(binding) } };
}

/** §4.3 encode_group_commitment_list (sorted by identifier). */
function sortCommitments(list) {
  const out = list.map((c) => ({ id: checkId(c.id), hiding: c.hiding, binding: c.binding })).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let i = 1; i < out.length; i++) if (out[i].id === out[i - 1].id) throw new Error(`participant ${out[i].id} twice`);
  return out;
}
const encodeCommitmentList = (list) => concat(...list.flatMap((c) => [serS(c.id), serE(c.hiding), serE(c.binding)]));

/** §4.4 compute_binding_factors: [{id, rho}] for a sorted commitment list. */
export function bindingFactors(groupPk, list, msg) {
  const prefix = concat(serE(groupPk), H4(msg), H5(encodeCommitmentList(list)));
  return list.map((c) => ({ id: c.id, rho: H1(concat(prefix, serS(c.id))) }));
}
/** §4.5 compute_group_commitment. */
export function groupCommitment(list, factors) {
  let R = Point.ZERO;
  for (const c of list) {
    const { rho } = factors.find((f) => f.id === c.id);
    R = R.add(c.hiding).add(mulP(c.binding, rho));
  }
  return R;
}
/** §4.6 compute_challenge: H2(R ‖ PK ‖ msg). */
export const challenge = (R, groupPk, msg) => H2(concat(serE(R), serE(groupPk), msg));
/** §4.2 derive_interpolating_value (Lagrange coefficient at 0). */
export function lagrange(ids, id) {
  const x = BigInt(id);
  if (!ids.some((i) => BigInt(i) === x)) throw new Error('participant not in the list');
  let num = 1n, den = 1n;
  for (const j of ids.map(BigInt)) {
    if (j === x) continue;
    num = mod(num * j);
    den = mod(den * (j - x));
  }
  return mod(num * inv(den));
}

/**
 * §5.2 sign: participant `id`'s signature share. commitments: [{id, hiding: Point, binding: Point}] of the t
 * signers (this one included), msg: bytes.
 */
export function signShare({ id, signingShare, groupPk, nonces, commitments, msg }) {
  const list = sortCommitments(commitments);
  const me = list.find((c) => c.id === BigInt(id));
  if (!me) throw new Error('my commitment is not in the signing package');
  if (!me.hiding.equals(mulG(nonces.hiding)) || !me.binding.equals(mulG(nonces.binding))) throw new Error('the package carries other commitments than mine');
  const factors = bindingFactors(groupPk, list, msg);
  const rho = factors.find((f) => f.id === BigInt(id)).rho;
  const R = groupCommitment(list, factors);
  const lambda = lagrange(list.map((c) => c.id), id);
  const c = challenge(R, groupPk, msg);
  return mod(nonces.hiding + nonces.binding * rho + lambda * BigInt(signingShare) * c);
}

/** §5.4 verify_signature_share. verifyingShares: Map/obj id -> Point. */
export function verifyShare({ id, share, verifyingShare, groupPk, commitments, msg }) {
  const list = sortCommitments(commitments);
  const me = list.find((c) => c.id === BigInt(id));
  if (!me) return false;
  const factors = bindingFactors(groupPk, list, msg);
  const rho = factors.find((f) => f.id === BigInt(id)).rho;
  const R = groupCommitment(list, factors);
  const c = challenge(R, groupPk, msg);
  const lambda = lagrange(list.map((x) => x.id), id);
  const lhs = mulG(share);
  const rhs = me.hiding.add(mulP(me.binding, rho)).add(mulP(verifyingShare, mod(c * lambda)));
  return lhs.equals(rhs);
}

/** §5.3 aggregate: the 65-byte signature R ‖ z (after checking every share against its verifying share). */
export function aggregate({ groupPk, commitments, msg, shares, verifyingShares }) {
  const list = sortCommitments(commitments);
  if (shares.length !== list.length) throw new Error('one share per signer in the package');
  let z = 0n;
  for (const s of shares) {
    if (verifyingShares) {
      const Y = verifyingShares[String(BigInt(s.id))];
      if (!Y || !verifyShare({ id: s.id, share: s.share, verifyingShare: Y, groupPk, commitments: list, msg })) throw new Error(`participant ${s.id} sent a bad share`);
    }
    z = mod(z + BigInt(s.share));
  }
  const R = groupCommitment(list, bindingFactors(groupPk, list, msg));
  return concat(serE(R), serS(z));
}

/** Prime-order group verification: z·G == R + c·PK. */
export function verify(groupPk, msg, sig) {
  try {
    const b = typeof sig === 'string' ? unhex(sig) : sig;
    if (b.length !== 65) return false;
    const R = desE(b.slice(0, 33));
    const z = desS(b.slice(33));
    const c = challenge(R, groupPk, msg);
    return mulG(z).equals(R.add(mulP(groupPk, c)));
  } catch { return false; }
}

/** Shares of a polynomial (trusted dealer, RFC Appendix C): only for the RFC test vectors, never for real keys. */
export const evalPoly = (coeffs, x) => coeffs.reduceRight((acc, a) => mod(acc * BigInt(x) + BigInt(a)), 0n);

// ---------------------------------------------------------------- DKG (FROST paper, Figure 1)
function randScalar() { for (;;) { const v = mod(BigInt(`0x${hex(randomBytes(48))}`)); if (v !== 0n) return v; } }
const dkgContext = (session) => enc.encode(`ZETAPHY FROST DKG v1 ${session}`);
/**
 * Proof of knowledge of a0: R = k·G, c = HDKG(id ‖ A0 ‖ R ‖ Φ), μ = k + a0·c; serialized R ‖ μ (65 bytes).
 * Φ is the paper's context string: our DKG binds the session (so a package cannot be replayed into another
 * session); with an empty Φ it is exactly frost-core's proof (its test vectors).
 */
export function proveKnowledge(id, a0, k = randScalar(), context = new Uint8Array(0)) {
  const A0 = mulG(a0);
  const R = mulG(k);
  const c = HDKG(concat(serS(id), serE(A0), serE(R), context));
  return concat(serE(R), serS(mod(k + BigInt(a0) * c)));
}
export function checkKnowledge(id, A0, pok, context = new Uint8Array(0)) {
  try {
    const b = typeof pok === 'string' ? unhex(pok) : pok;
    if (b.length !== 65) return false;
    const R = desE(b.slice(0, 33));
    const mu = desS(b.slice(33));
    const c = HDKG(concat(serS(id), serE(A0), serE(R), context));
    return R.equals(mulG(mu).add(mulP(A0, mod(-c))));
  } catch { return false; }
}
/** Σ_k x^k · C_k (the commitment to f(x)). */
function commitAt(C, x) {
  let acc = Point.ZERO, pow = 1n;
  for (const Ck of C) { acc = acc.add(mulP(Ck, pow)); pow = mod(pow * BigInt(x)); }
  return acc;
}

function checkParams(id, t, n) {
  if (!Number.isInteger(t) || !Number.isInteger(n) || t < 2 || n < t || n > 32) throw new Error('need 2 ≤ threshold ≤ participants ≤ 32');
  if (!Number.isInteger(id) || id < 1 || id > n) throw new Error(`id 1…${n}`);
}

/** DKG round 1: my secret polynomial (kept) and my public package (sent to everyone). */
export function dkgRound1({ id, threshold: t, participants: n, session }) {
  checkParams(id, t, n);
  if (!/^[0-9a-f]{32}$/.test(String(session ?? ''))) throw new Error('session: 32 hex (the same for everyone; pick one at random and share it)');
  const coeffs = Array.from({ length: t }, randScalar);
  const ecdh = createECDH('secp256k1');
  ecdh.generateKeys();
  const pkg = {
    v: 1, type: 'frost-dkg1', session, id, threshold: t, participants: n,
    commitments: coeffs.map((a) => hex(serE(mulG(a)))),
    pok: hex(proveKnowledge(id, coeffs[0], randScalar(), dkgContext(session))),
    encKey: hex(ecdh.getPublicKey(null, 'compressed')),
  };
  return { secret: { v: 1, type: 'frost-dkg-secret', session, id, threshold: t, participants: n, coeffs: coeffs.map((a) => hex(serS(a))), encPriv: hex(ecdh.getPrivateKey()), pkg }, pkg };
}

/** The sorted, checked set of round-1 packages (one per participant 1…n) and its hash (compare it out of band). */
export function checkRound1(packages, { session, threshold: t, participants: n }) {
  const byId = new Map();
  for (const p of packages) {
    if (p?.type !== 'frost-dkg1' || p.v !== 1) throw new Error('not a round-1 package');
    if (p.session !== session || p.threshold !== t || p.participants !== n) throw new Error(`participant ${p.id}: another session, threshold or size`);
    if (byId.has(p.id) && JSON.stringify(byId.get(p.id)) !== JSON.stringify(p)) throw new Error(`participant ${p.id} sent two different packages`);
    if (!Array.isArray(p.commitments) || p.commitments.length !== t) throw new Error(`participant ${p.id}: ${t} commitments expected`);
    const C = p.commitments.map(desE);
    if (!checkKnowledge(p.id, C[0], p.pok, dkgContext(session))) throw new Error(`participant ${p.id}: bad proof of knowledge (abort and exclude them)`);
    desE(p.encKey);
    byId.set(p.id, p);
  }
  for (let i = 1; i <= n; i++) if (!byId.has(i)) throw new Error(`missing the round-1 package of participant ${i}`);
  if (byId.size !== n) throw new Error('participants outside 1…n');
  const sorted = [...byId.values()].sort((a, b) => a.id - b.id);
  const canon = sorted.map((p) => [p.id, p.commitments, p.pok, p.encKey]);
  const transcript = hex(sha256(enc.encode(`ZETAPHY FROST DKG v1 ${session} ${t} ${n} `), enc.encode(JSON.stringify(canon))));
  return { sorted, transcript };
}

function shareKey(myPriv, theirPub, from, to, transcript) {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(unhex(myPriv)));
  const shared = ecdh.computeSecret(Buffer.from(unhex(theirPub)));
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(transcript, 'hex'), Buffer.from(`ZETAPHY FROST DKG share ${from}->${to}`), 32));
}

/** DKG round 2: check everyone's round-1 package, then my share f_i(j) for each other participant j, encrypted to j. */
export function dkgRound2({ secret, packages }) {
  const { sorted, transcript } = checkRound1(packages, secret);
  if (JSON.stringify(sorted.find((p) => p.id === secret.id)) !== JSON.stringify(secret.pkg)) throw new Error('my own round-1 package is not the one in the set');
  const coeffs = secret.coeffs.map(desS);
  const shares = {};
  for (const p of sorted) {
    if (p.id === secret.id) continue;
    const key = shareKey(secret.encPriv, p.encKey, secret.id, p.id, transcript);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(`${secret.session}:${secret.id}->${p.id}`));
    const ct = Buffer.concat([c.update(Buffer.from(serS(evalPoly(coeffs, p.id)))), c.final()]);
    shares[p.id] = hex(Buffer.concat([iv, ct, c.getAuthTag()]));
  }
  return { v: 1, type: 'frost-dkg2', session: secret.session, from: secret.id, transcript, shares };
}

/**
 * DKG round 3: decrypt and check the shares sent to me, then my key package (secret) and the group's public
 * data (publish it: group key, verifying shares).
 */
export function dkgRound3({ secret, packages, round2 }) {
  const { sorted, transcript } = checkRound1(packages, secret);
  const coeffs = secret.coeffs.map(desS);
  let s = evalPoly(coeffs, secret.id);
  const from = new Map();
  for (const m of round2) {
    if (m?.type !== 'frost-dkg2' || m.session !== secret.session) throw new Error('not a round-2 message of this session');
    if (m.transcript !== transcript) throw new Error(`participant ${m.from} saw other round-1 packages (transcript differs): abort`);
    if (m.from !== secret.id) from.set(m.from, m);
  }
  for (const p of sorted) {
    if (p.id === secret.id) continue;
    const m = from.get(p.id);
    if (!m?.shares?.[secret.id]) throw new Error(`no share for me from participant ${p.id}`);
    const raw = Buffer.from(unhex(m.shares[secret.id]));
    const d = createDecipheriv('aes-256-gcm', shareKey(secret.encPriv, p.encKey, p.id, secret.id, transcript), raw.subarray(0, 12));
    d.setAAD(Buffer.from(`${secret.session}:${p.id}->${secret.id}`));
    d.setAuthTag(raw.subarray(raw.length - 16));
    let share;
    try { share = desS(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()])); } catch { throw new Error(`participant ${p.id}: the share does not decrypt (complain about ${p.id})`); }
    if (!mulG(share).equals(commitAt(p.commitments.map(desE), secret.id))) throw new Error(`participant ${p.id}: the share does not match their commitments (complain about ${p.id})`);
    s = mod(s + share);
  }
  const Cs = sorted.map((p) => p.commitments.map(desE));
  const groupPk = Cs.reduce((acc, C) => acc.add(C[0]), Point.ZERO);
  const verifyingShares = {};
  for (let j = 1; j <= secret.participants; j++) verifyingShares[j] = hex(serE(Cs.reduce((acc, C) => acc.add(commitAt(C, j)), Point.ZERO)));
  if (!mulG(s).equals(desE(verifyingShares[secret.id]))) throw new Error('my signing share does not match the verifying share: abort');
  const groupKey = hex(serE(groupPk));
  if (BigInt(`0x${groupKey.slice(2)}`) >= N) throw new Error('the group key cannot be checked on chain (x ≥ n, probability ~2^-128): run the DKG again');
  const pub = { v: 1, type: 'frost-group', session: secret.session, threshold: secret.threshold, participants: secret.participants, groupKey, verifyingShares, transcript };
  return { key: { ...pub, type: 'frost-key', id: secret.id, signingShare: hex(serS(s)) }, group: pub };
}

// ---------------------------------------------------------------- files the CLI exchanges
/** Round 1 of signing: my nonces (secret, used once) and my public commitment. */
export function signRound1(key) {
  const { nonces, commitments } = commit(desS(key.signingShare));
  const commitment = { v: 1, type: 'frost-commit', groupKey: key.groupKey, id: key.id, hiding: hex(serE(commitments.hiding)), binding: hex(serE(commitments.binding)) };
  return { nonces: { v: 1, type: 'frost-nonces', groupKey: key.groupKey, id: key.id, hiding: hex(serS(nonces.hiding)), binding: hex(serS(nonces.binding)), commitment }, commitment };
}
const commitList = (pkg) => pkg.commitments.map((c) => ({ id: c.id, hiding: desE(c.hiding), binding: desE(c.binding) }));

/** A signing package: the 32-byte digest and the commitments of exactly `threshold` signers. */
export function signingPackage({ group, digest, commitments, extra = {} }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error('digest: 0x + 32 bytes');
  const cs = commitments.map((c) => {
    if (c?.type !== 'frost-commit' || c.groupKey !== group.groupKey) throw new Error('a commitment for another group');
    return { id: c.id, hiding: c.hiding, binding: c.binding };
  }).sort((a, b) => a.id - b.id);
  if (cs.length !== group.threshold) throw new Error(`exactly ${group.threshold} commitments (the threshold)`);
  sortCommitments(commitList({ commitments: cs }));
  return { v: 1, type: 'frost-package', groupKey: group.groupKey, digest: digest.toLowerCase(), commitments: cs, ...extra };
}

/** Round 2 of signing: my share for a package whose digest I computed myself (`expectDigest`). */
export function signRound2({ key, nonces, pkg, expectDigest }) {
  if (pkg?.type !== 'frost-package' || pkg.groupKey !== key.groupKey || nonces.groupKey !== key.groupKey || nonces.id !== key.id) throw new Error('package, nonces and key are not of the same group and signer');
  if (String(expectDigest).toLowerCase() !== pkg.digest) throw new Error('the package asks me to sign another digest than the one I computed: refused');
  const share = signShare({ id: key.id, signingShare: desS(key.signingShare), groupPk: desE(key.groupKey), nonces: { hiding: desS(nonces.hiding), binding: desS(nonces.binding) },
    commitments: commitList(pkg), msg: unhex(pkg.digest) });
  return { v: 1, type: 'frost-share', groupKey: key.groupKey, digest: pkg.digest, id: key.id, share: hex(serS(share)) };
}

/** Aggregate the shares into the 65-byte signature (0x hex), after checking each one. */
export function aggregateShares({ group, pkg, shares }) {
  for (const s of shares) if (s?.type !== 'frost-share' || s.groupKey !== group.groupKey || s.digest !== pkg.digest) throw new Error('a share for another group or digest');
  const groupPk = desE(group.groupKey);
  const verifyingShares = Object.fromEntries(Object.entries(group.verifyingShares).map(([k, v]) => [String(BigInt(k)), desE(v)]));
  const sig = aggregate({ groupPk, commitments: commitList(pkg), msg: unhex(pkg.digest), shares: shares.map((s) => ({ id: s.id, share: desS(s.share) })), verifyingShares });
  if (!verify(groupPk, unhex(pkg.digest), sig)) throw new Error('the aggregate signature does not verify');
  return `0x${hex(sig)}`;
}

export const toHex = (b) => `0x${hex(b)}`;
export { unhex, Point };
