// The defense SDK (docs/future/immune-network.md, "Defend"): one call for wallets, dapps, bots and bridges.
//
//   const immune = createImmune({ mirrors: { 11155111: { rpc: 'https://…', address: '0x…ImmuneMirror' } },
//                                 feedUrl: 'https://cdn.jsdelivr.net/gh/<owner>/<repo>@immune-feed/', trustedKeys: ['0x…keyHash'] });
//   const r = await immune.checkAddress(11155111, '0x…');   // { flagged, severity, since, evidenceHash, source, … }
//
// Order: the chain's own ImmuneMirror first (a view call on that chain's RPC: the same answer a contract gets from
// ImmuneGuard), then the signed feed (its ML-DSA snapshot verified against a pinned key) when the mirror is not
// deployed, not reachable, paused or never written. `source` says which answered; 'none' = nothing could be read
// (the caller decides fail-open or fail-closed). Non-EVM chains (Solana base58, Cosmos bech32 accounts) use the feed.
//
// Circuit breakers (src/selfheal/, built separately) consume the SAME interface: poll checkAddress / the mirror's
// isFlagged(chainId, address) -> (flagged, severity, since, evidenceHash), or follow ThreatFlag / CodeThreatFlag
// logs (watchFlags below), and decide by themselves what to pause. The immune network never pauses anything.
import { Interface, keccak256 } from 'ethers';
import { addressKey, accountKey, codeKey } from './agree.js';
import { verifySnapshot } from './feed.js';
import { base58Hex, bech32Hex } from './detectors.js';

export const MIRROR_ABI = [
  'function isFlagged(uint256 chainId, address subject) view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash)',
  'function isCodeFlagged(bytes32 codeHash) view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash)',
  'function isAccountFlagged(uint256 chainId, bytes32 account) view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash)',
  'function live() view returns (bool)',
  'event ThreatFlag(uint256 indexed chainId, address indexed subject, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash)',
  'event CodeThreatFlag(bytes32 indexed codeHash, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash)',
];
const MI = new Interface(MIRROR_ABI);
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const NONE = { flagged: false, severity: 0, since: 0, evidenceHash: '0x' + '00'.repeat(32) };
const EMPTY_CODE = keccak256('0x');

/** A tiny JSON-RPC sender over fetch (the SDK's default; pass `send` per mirror to use your own client). */
export function jsonRpc(url, fetchImpl = globalThis.fetch) {
  let id = 0;
  return async (method, params = []) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(String(j.error.message ?? 'rpc error').slice(0, 200));
    return j.result;
  };
}

/** The account bytes (0x…, 20 or 32 bytes) of an address on any chain the network covers. */
export function accountBytes(address) {
  const a = String(address).trim();
  if (EVM_ADDR.test(a)) return a.toLowerCase();
  if (/^0x[0-9a-fA-F]{64}$/.test(a)) return a.toLowerCase();
  if (/^[a-z]{1,20}1[02-9ac-hj-np-z]{38,90}$/.test(a)) return bech32Hex(a);
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return base58Hex(a);
  throw new Error('not an address the immune network knows');
}

/** The feed keys that answer for (chainId, address): its own key and, for a 20-byte account, the every-EVM-chain key. */
export function keysFor(chainId, address) {
  const b = accountBytes(address);
  if (b.length === 42) return [addressKey(chainId, b), addressKey(0, b)];
  return [accountKey(chainId, b)];
}

/**
 * @param o.mirrors     { [chainId]: { address, rpc? | send? } } ImmuneMirror per chain (ZETAPHY: the ImmuneRegistry)
 * @param o.feedUrl     base URL of the feed files (feed.json, snapshot.pq.json); null: no fallback
 * @param o.trustedKeys ML-DSA keyHashes whose snapshot signature is accepted (empty: any valid signature, marked)
 * @param o.maxFeedAge  seconds after which the feed is treated as stale (default 6 h); a stale feed still answers
 *                      "flagged" (fail toward warning) but never "clean" without saying it is stale
 */
export function createImmune({ mirrors = {}, feedUrl = null, trustedKeys = [], fetchImpl = globalThis.fetch, maxFeedAge = 6 * 3600, cacheSeconds = 60, now = () => Math.floor(Date.now() / 1000) } = {}) {
  let feed = null; let feedAt = 0; let feedCheck = null;
  const sendOf = (m) => m.send ?? jsonRpc(m.rpc, fetchImpl);

  async function loadFeed() {
    if (!feedUrl) return null;
    if (feed && now() - feedAt < cacheSeconds) return feed;
    const get = async (f) => { const r = await fetchImpl(feedUrl.replace(/\/?$/, '/') + f, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); };
    const [f, snap] = await Promise.all([get('feed.json'), get('snapshot.pq.json').catch(() => null)]);
    const check = snap ? await verifySnapshot(f, snap, { trustedKeys }) : { ok: false, problems: ['no signed snapshot'] };
    if (!check.ok && trustedKeys.length) throw new Error(`feed refused: ${check.problems.join('; ')}`);
    feed = { byKey: new Map(f.items.map((e) => [e.key.toLowerCase(), e])), generatedAt: Number(f.generatedAt), vaccines: f.vaccines ?? [] };
    feedCheck = check; feedAt = now();
    return feed;
  }

  async function fromMirror(chainId, address) {
    const m = mirrors[chainId];
    if (!m || !EVM_ADDR.test(m.address ?? '') || !EVM_ADDR.test(address)) return null;
    const send = sendOf(m);
    const call = async (fn, args) => MI.decodeFunctionResult(fn, await send('eth_call', [{ to: m.address, data: MI.encodeFunctionData(fn, args) }, 'latest']));
    if (!(await call('live', []))[0]) return null; // paused or never written: the feed answers
    let r = await call('isFlagged', [chainId, address]);
    let best = { flagged: r[0], severity: Number(r[1]), since: Number(r[2]), evidenceHash: r[3], via: 'address' };
    const code = await send('eth_getCode', [address, 'latest']).catch(() => '0x');
    if (code && code !== '0x') {
      r = await call('isCodeFlagged', [keccak256(code)]);
      if (r[0] && Number(r[1]) > best.severity) best = { flagged: true, severity: Number(r[1]), since: Number(r[2]), evidenceHash: r[3], via: 'code' };
    }
    return { ...best, source: 'mirror', chainId: Number(chainId) };
  }

  async function fromFeed(chainId, address, codeHash = null) {
    const f = await loadFeed();
    if (!f) return null;
    const keys = keysFor(chainId, address);
    if (codeHash && codeHash !== EMPTY_CODE) keys.push(codeKey(codeHash));
    let best = null;
    for (const k of keys) {
      const e = f.byKey.get(k.toLowerCase());
      if (!e || !e.flagged || now() >= e.expiresAt) continue;
      if (!best || e.severity > best.severity) best = e;
    }
    const stale = now() - f.generatedAt > maxFeedAge;
    const signed = !!feedCheck?.ok;
    if (!best) return { ...NONE, source: 'feed', chainId: Number(chainId), stale, signed };
    return { flagged: true, severity: best.severity, since: best.since, evidenceHash: best.evidenceHash, kind: best.kindName, provisional: best.provisional,
      vaccine: best.vaccine, source: 'feed', chainId: Number(chainId), stale, signed, via: best.keyType === 3 ? 'code' : 'address' };
  }

  /** Is `address` on chain `chainId` flagged? Mirror first, signed feed as fallback. Never throws. */
  async function checkAddress(chainId, address, { codeHash = null } = {}) {
    let err = null;
    try { const r = await fromMirror(Number(chainId), String(address)); if (r) return r; } catch (e) { err = e; }
    try { const r = await fromFeed(Number(chainId), String(address), codeHash); if (r) return { ...r, mirrorError: err ? String(err.message).slice(0, 120) : undefined }; } catch (e) { err = e; }
    return { ...NONE, source: 'none', chainId: Number(chainId), error: err ? String(err.message).slice(0, 160) : 'no mirror and no feed configured' };
  }

  /** The decision most callers want: 'block' (severity >= blockAt), 'warn' (flagged below it), 'ok', or 'unknown'. */
  async function advise(chainId, address, { blockAt = 3 } = {}) {
    const r = await checkAddress(chainId, address);
    const action = r.source === 'none' ? 'unknown' : r.flagged ? (r.severity >= blockAt ? 'block' : 'warn') : 'ok';
    return { action, ...r };
  }

  return { checkAddress, advise, loadFeed, get feedCheck() { return feedCheck; } };
}

/**
 * Follows ThreatFlag / CodeThreatFlag on a mirror (or the registry) from `fromBlock`: for circuit breakers and
 * monitors. -> { events: [{ type, chainId?, subject?, codeHash?, flagged, severity, since, evidenceHash, block }], next }.
 */
export async function watchFlags(send, mirror, { fromBlock, toBlock = 'latest' }) {
  const topics = [[MI.getEvent('ThreatFlag').topicHash, MI.getEvent('CodeThreatFlag').topicHash]];
  const head = toBlock === 'latest' ? Number(BigInt(await send('eth_blockNumber', []))) : Number(toBlock);
  const logs = await send('eth_getLogs', [{ address: mirror, fromBlock: '0x' + Number(fromBlock).toString(16), toBlock: '0x' + head.toString(16), topics }]);
  const events = (logs ?? []).map((l) => {
    const p = MI.parseLog({ topics: l.topics, data: l.data });
    const base = { type: p.name, flagged: p.args.flagged, severity: Number(p.args.severity), since: Number(p.args.since), evidenceHash: p.args.evidenceHash, block: Number(BigInt(l.blockNumber)) };
    return p.name === 'ThreatFlag' ? { ...base, chainId: Number(p.args.chainId), subject: p.args.subject.toLowerCase() } : { ...base, codeHash: p.args.codeHash };
  });
  return { events, next: head + 1 };
}
