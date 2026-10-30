// The free, open threat feed (docs/future/immune-network.md, "Feed"): static files a GitHub Action rebuilds from
// ZETAPHY's ImmuneRegistry and pushes to the `immune-feed` branch (served by raw.githubusercontent.com / jsDelivr;
// no server of ours):
//   feed.json        { format, generatedAt, source, stats, items: [entry], vaccines: [vaccine] }
//   feed.ndjson      one entry per line (stream / grep friendly)
//   rss.xml, atom.xml  the latest 100 changes (readers, Slack/Discord RSS bots)
//   snapshot.pq.json an ML-DSA-44 signed archive (zetaphy-hub/pqattest.js format) over sha256(canonical(feed.json))
// The feed is a convenience copy: the registry (and every mirror) stays the source of truth, and the SDK checks the
// snapshot's signature against the key it pins before trusting a fallback answer.
import { sha256 } from '@noble/hashes/sha2.js';
import { Interface } from 'ethers';
import { canonical as pqCanonical } from '../../../zetaphy-hub/pqattest.js';
import { signPayload, verifyFile } from '../pqattest.js';
import { toHex, cidOf } from './evidence.js';
import { vaccineIntact } from './vaccines.js';

export const FEED_FORMAT = 'zetaphy.immune.feed.v1';
export const KIND_NAMES = { 1: 'exploit-contract', 2: 'attacker', 3: 'drainer', 4: 'malicious-spender', 5: 'flagged-code-clone', 6: 'compromised' };
export const SEVERITY_NAMES = { 1: 'info', 2: 'suspicious', 3: 'high', 4: 'critical' };
const enc = new TextEncoder();
const ZERO32 = '0x' + '00'.repeat(32);

/** One feed entry from a registry ImmuneItem (+ its job and whether it is still provisional). */
export function entryOf(it, { jobId = null, provisional = false, now = Math.floor(Date.now() / 1000) } = {}) {
  const subject = String(it.subject).toLowerCase();
  const evm = BigInt(subject) >> 160n === 0n;
  const active = !!it.flagged && now < Number(it.expiresAt);
  return {
    key: String(it.key).toLowerCase(), round: Number(it.round), flagged: active, keyType: Number(it.keyType),
    chainId: Number(it.chainId), subject, address: Number(it.keyType) === 3 ? null : evm ? '0x' + subject.slice(-40) : subject,
    codeHash: Number(it.keyType) === 3 ? subject : null,
    kind: Number(it.kind), kindName: KIND_NAMES[Number(it.kind)] ?? null, severity: Number(it.severity), severityName: SEVERITY_NAMES[Number(it.severity)] ?? null,
    since: Number(it.since), expiresAt: Number(it.expiresAt), evidenceHash: String(it.evidenceHash).toLowerCase(),
    evidenceCid: it.evidenceHash && it.evidenceHash !== ZERO32 ? cidOf(it.evidenceHash) : null,
    vaccine: it.vaccine && it.vaccine !== ZERO32 ? String(it.vaccine).toLowerCase() : null,
    jobId: jobId == null ? null : Number(jobId), provisional: !!provisional,
  };
}

/**
 * The feed object. items: ImmuneItem-like (registry), each optionally { jobId, provisional }. vaccines: objects
 * (only intact ones referenced by an entry are included). changes: [{ key, round, at, flagged }] for RSS/Atom.
 */
export function buildFeed({ items, vaccines = [], source = {}, now = Math.floor(Date.now() / 1000), coverage = null }) {
  const entries = items.map((it) => entryOf(it, { jobId: it.jobId, provisional: it.provisional, now })).sort((a, b) => b.since - a.since || a.key.localeCompare(b.key));
  const wanted = new Set(entries.map((e) => e.vaccine).filter(Boolean));
  const vs = vaccines.filter((v) => vaccineIntact(v) && wanted.has(v.id.toLowerCase()));
  const active = entries.filter((e) => e.flagged);
  return {
    format: FEED_FORMAT, generatedAt: now,
    source: { chainId: 77390, ...source },
    stats: {
      flaggedNow: active.length, flagged24h: active.filter((e) => e.since >= now - 86400).length, keys: entries.length,
      chains: [...new Set(active.map((e) => e.chainId))].sort((a, b) => a - b), vaccines: vs.length,
      ...(coverage ? { coverage } : {}),
    },
    items: entries, vaccines: vs,
  };
}

export const feedBytes = (feed) => enc.encode(pqCanonical(feed));
export const feedHash = (feed) => toHex(sha256(feedBytes(feed)));
export const toNdjson = (feed) => feed.items.map((e) => JSON.stringify(e)).join('\n') + (feed.items.length ? '\n' : '');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const title = (e) => `${e.flagged ? 'FLAG' : 'LIFT'} ${e.severityName ?? e.severity} ${e.kindName ?? e.kind}: ${e.address ?? e.codeHash} (chain ${e.chainId || 'every EVM'})`;
const descr = (e) => `key ${e.key} round ${e.round}; evidence sha256 ${e.evidenceHash} (ipfs ${e.evidenceCid ?? '-'})${e.vaccine ? `; vaccine ${e.vaccine}` : ''}${e.provisional ? '; provisional (challenge window open)' : ''}; expires ${new Date(e.expiresAt * 1000).toISOString()}`;

/** RSS 2.0 of the latest `n` entries. base: where the files are served (links). */
export function toRss(feed, { base = '', n = 100 } = {}) {
  const items = feed.items.slice(0, n).map((e) => `<item><title>${xml(title(e))}</title><guid isPermaLink="false">${xml(`${e.key}:${e.round}`)}</guid>`
    + `<pubDate>${new Date(e.since * 1000).toUTCString()}</pubDate><link>${xml(`${base}feed.json#${e.key}`)}</link><description>${xml(descr(e))}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>ZETAPHY immune network: threat flags</title><link>${xml(base + 'feed.json')}</link>`
    + `<description>Flags agreed by k-of-n bonded Neuro runners on ZETAPHY (testnet prototype). Not financial or legal advice.</description>`
    + `<lastBuildDate>${new Date(feed.generatedAt * 1000).toUTCString()}</lastBuildDate>${items}</channel></rss>\n`;
}

/** Atom 1.0 of the latest `n` entries. */
export function toAtom(feed, { base = '', n = 100 } = {}) {
  const iso = (t) => new Date(t * 1000).toISOString();
  const entries = feed.items.slice(0, n).map((e) => `<entry><id>urn:zetaphy:immune:${xml(e.key)}:${e.round}</id><title>${xml(title(e))}</title>`
    + `<updated>${iso(e.since)}</updated><link href="${xml(`${base}feed.json#${e.key}`)}"/><summary>${xml(descr(e))}</summary></entry>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:zetaphy:immune:feed</id><title>ZETAPHY immune network: threat flags</title>`
    + `<updated>${iso(feed.generatedAt)}</updated><link href="${xml(base + 'atom.xml')}" rel="self"/>${entries}</feed>\n`;
}

/** The signed snapshot: an ML-DSA-44 archive (pqattest) whose payload pins the feed's sha256. key: src/pq.js pqFromSeed. */
export async function signSnapshot(feed, key, { createdAt = new Date(feed.generatedAt * 1000).toISOString() } = {}) {
  return signPayload({ kind: 'immune-feed', createdAt, subject: { chain: 'zetaphy', address: String(feed.source.registry ?? '').toLowerCase() },
    feedHash: feedHash(feed), format: FEED_FORMAT, generatedAt: feed.generatedAt, flaggedNow: feed.stats.flaggedNow, keys: feed.stats.keys }, key);
}

/**
 * Checks a feed against its snapshot: the ML-DSA signature (pqattest), the signer among `trustedKeys` (keyHashes),
 * and the feed's hash. -> { ok, problems[], keyHash, signer }.
 */
export async function verifySnapshot(feed, snapshot, { trustedKeys = [], maxAgeSeconds = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const r = await verifyFile(snapshot, { trustedKeys });
  const problems = [...r.problems];
  if (snapshot?.payload?.kind !== 'immune-feed') problems.push('not an immune-feed snapshot');
  if (snapshot?.payload?.feedHash !== feedHash(feed)) problems.push('the feed is not the one signed (feedHash differs)');
  if (trustedKeys.length && r.signer !== 'trusted') problems.push('signed by a key this reader does not trust');
  if (maxAgeSeconds != null && now - Number(feed.generatedAt) > maxAgeSeconds) problems.push(`the feed is older than ${maxAgeSeconds}s`);
  return { ok: problems.length === 0, problems, keyHash: r.keyHash, signer: r.signer };
}

/** All files of one build: { 'feed.json': string, ... }. key null: no snapshot (an unsigned feed says so). */
export async function feedFiles(feed, { key = null, base = '' } = {}) {
  const files = { 'feed.json': JSON.stringify(feed, null, 1) + '\n', 'feed.ndjson': toNdjson(feed), 'rss.xml': toRss(feed, { base }), 'atom.xml': toAtom(feed, { base }) };
  if (key) files['snapshot.pq.json'] = JSON.stringify(await signSnapshot(feed, key), null, 1) + '\n';
  return files;
}

// ---------------------------------------------------------------- reading the registry over JSON-RPC (the Action)

export const REGISTRY_ABI = [
  'function historyCount() view returns (uint256)',
  'function snapshot(uint256 start, uint256 n) view returns (bytes32[] keys, uint32[] rounds, bool[] flagged)',
  'function itemOf(bytes32 key) view returns (tuple(bytes32 key, uint32 round, bool flagged, uint8 keyType, uint64 chainId, bytes32 subject, uint8 kind, uint8 severity, uint64 since, uint64 expiresAt, bytes32 evidenceHash, bytes32 vaccine))',
  'function jobOf(bytes32 key) view returns (uint256 jobId, bytes32 verdict)',
  'function provisional(bytes32 key) view returns (bool)',
];
const RI = new Interface(REGISTRY_ABI);

/** Every key the registry ever touched, with its current item: send(method, params) is a JSON-RPC client. */
export async function readRegistry(send, registry, { page = 200, maxKeys = 20_000 } = {}) {
  const call = async (fn, args) => RI.decodeFunctionResult(fn, await send('eth_call', [{ to: registry, data: RI.encodeFunctionData(fn, args) }, 'latest']));
  const total = Number((await call('historyCount', []))[0]);
  const keys = new Set();
  for (let s = Math.max(0, total - maxKeys); s < total; s += page) for (const k of (await call('snapshot', [s, page]))[0]) keys.add(k.toLowerCase());
  const items = [];
  for (const k of keys) {
    const it = (await call('itemOf', [k]))[0];
    const [jobId] = await call('jobOf', [k]);
    const provisional = (await call('provisional', [k]))[0];
    items.push({ key: it.key, round: Number(it.round), flagged: it.flagged, keyType: Number(it.keyType), chainId: Number(it.chainId), subject: it.subject,
      kind: Number(it.kind), severity: Number(it.severity), since: Number(it.since), expiresAt: Number(it.expiresAt), evidenceHash: it.evidenceHash, vaccine: it.vaccine,
      jobId: Number(jobId), provisional });
  }
  return items;
}
