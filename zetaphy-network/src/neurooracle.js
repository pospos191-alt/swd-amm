// Neuro cross-chain security oracle and herd immunity (docs/future/crosschain-assist.md, items 18 and 28).
//   - which ThreatRegistry keys each destination still lacks, and pushing them (the herd-immunity pusher:
//     `zetaphy immune push`, run by a runner next to `node start` or by a GitHub Actions schedule);
//   - the coverage meter: the share of ZETAPHY's currently flagged keys each mirror holds at the same round;
//   - the IBC route to osmo-test-5: the ibc-hooks sender a CosmWasm contract must accept.
// Pure where it can be (tests run it without a chain); the chain calls go through ethers Contracts.
import { Contract, Interface, sha256, getBytes, concat, toUtf8Bytes, getAddress } from 'ethers';
import { toBech32, fromBech32 } from './pqtx.js';

export const SENDER_ABI = [
  'function push(uint32 domain, bytes32[] keys) payable returns (bytes32)',
  'function pushVerdict(uint32 domain, uint256 jobId) payable returns (bytes32)',
  'function quote(uint32 domain, bytes32[] keys) view returns (uint256)',
  'function pending(uint32 domain, bytes32[] keys) view returns (bool[])',
  'function snapshot(uint256 start, uint256 n) view returns (bytes32[] keys, uint32[] rounds, bool[] flagged)',
  'function receivers(uint32) view returns (bytes32)',
  'function domains(uint256) view returns (uint32)',
  'function domainCount() view returns (uint256)',
  'function threats() view returns (address)',
  'function ibcMemo(bytes32[] keys) view returns (string)',
  'function MAX_ITEMS() view returns (uint256)',
];
export const ORACLE_ABI = [
  'function roundsOf(bytes32[] keys) view returns (uint32[])',
  'function flaggedNow() view returns (uint256)',
  'function keyCount() view returns (uint256)',
  'function lastUpdate() view returns (uint64)',
  'function paused() view returns (bool)',
  'function check(address token) view returns (bool flagged, bool enforced, uint8 reason)',
];
export const REGISTRY_EVENTS = new Interface([
  'event Flagged(bytes32 indexed fingerprint, uint8 reason)',
  'event Cleared(bytes32 indexed fingerprint)',
  'event FastEnforced(bytes32 indexed key, address indexed by)',
  'event HeldNow(bytes32 indexed key, address indexed by)',
  'event Protected(bytes32 indexed key, bool on)',
]);
export const MAX_ITEMS = 32;

/** The registry's flag history (snapshot pages) -> { key: round } of the keys flagged right now. */
export function currentFlags(pages) {
  const out = new Map();
  for (const p of pages) {
    p.keys.forEach((k, i) => { if (p.flagged[i]) out.set(String(k).toLowerCase(), Number(p.rounds[i])); else out.delete(String(k).toLowerCase()); });
  }
  return out;
}

/**
 * Coverage of one mirror: of the keys flagged on ZETAPHY now (Map key -> round), how many the mirror holds at the
 * same round. `mirrored`: Map key -> mirrored round (0: never). { flagged, mirrored, share (0..1, null when nothing
 * is flagged), missing: [keys] }. Never rounded up: share 1 means every flag is there.
 */
export function coverage(flags, mirrored) {
  const missing = [];
  let have = 0;
  for (const [k, r] of flags) { if (Number(mirrored.get(k) ?? 0) === r) have += 1; else missing.push(k); }
  return { flagged: flags.size, mirrored: have, share: flags.size ? have / flags.size : null, missing };
}

/** "97.5%" / "–" (no flags yet): floor to 0.1%, so a mirror missing one key of 1000 never shows 100%. */
export const coverageText = (share) => (share == null ? '–' : `${(Math.floor(share * 1000) / 10).toFixed(1)}%`);

/** Every page of the sender's snapshot (keys may repeat; the last state of a key wins). */
export async function readSnapshot(sender, { page = 200 } = {}) {
  const pages = [];
  for (let start = 0; ; start += page) {
    const [keys, rounds, flagged] = await sender.snapshot(start, page);
    pages.push({ keys: [...keys], rounds: [...rounds].map(Number), flagged: [...flagged] });
    if (keys.length < page) break;
  }
  return currentFlags(pages);
}

/** Coverage of each mirror: mirrors = [{ name, oracle (ethers Contract with ORACLE_ABI) }]. */
export async function measure(sender, mirrors) {
  const flags = await readSnapshot(sender);
  const keys = [...flags.keys()];
  const out = [];
  for (const m of mirrors) {
    try {
      const rounds = keys.length ? await m.oracle.roundsOf(keys) : [];
      const got = new Map(keys.map((k, i) => [k, Number(rounds[i])]));
      out.push({ name: m.name, ...coverage(flags, got), paused: await m.oracle.paused().catch(() => null), lastUpdate: Number(await m.oracle.lastUpdate().catch(() => 0)) });
    } catch (e) { out.push({ name: m.name, error: String(e.shortMessage ?? e.message).slice(0, 160) }); }
  }
  return { flagged: flags.size, mirrors: out };
}

/** Splits keys into message-sized batches. */
export const batches = (keys, n = MAX_ITEMS) => Array.from({ length: Math.ceil(keys.length / n) }, (_, i) => keys.slice(i * n, (i + 1) * n));

/** Keys touched by registry events in the given logs (Flagged, Cleared, FastEnforced, HeldNow, Protected). */
export function touchedKeys(logs) {
  const out = new Set();
  for (const l of logs) {
    try { const e = REGISTRY_EVENTS.parseLog(l); if (e) out.add(String(e.args[0]).toLowerCase()); } catch { /* not one of these */ }
  }
  return [...out];
}

/**
 * One round of the herd-immunity pusher: the registry keys changed since `state.fromBlock` (plus every currently
 * flagged key on the first run), for every destination of the sender, the ones still pending there, pushed in
 * batches (each paying the quoted Hyperlane fee). `sender` is bound to a signer. Returns the new state and what was sent.
 * `maxFee` (wei per message) refuses a fee above it (a misconfigured hook must not drain the pusher).
 */
export async function pushRound({ sender, provider, registry, state = {}, maxFee = 10n ** 17n, log = () => {} }) {
  const head = await provider.getBlockNumber();
  let keys;
  if (state.fromBlock == null) keys = [...(await readSnapshot(sender)).keys()];
  else {
    const logs = state.fromBlock > head ? [] : await provider.getLogs({ address: registry, fromBlock: state.fromBlock, toBlock: head });
    keys = touchedKeys(logs);
  }
  const carried = Object.fromEntries(Object.entries(state.retry ?? {}).map(([d, ks]) => [d, ks]));
  const n = Number(await sender.domainCount());
  const sent = [];
  const retry = {};
  for (let i = 0; i < n; i++) {
    const domain = Number(await sender.domains(i));
    if ((await sender.receivers(domain)) === '0x' + '00'.repeat(32)) continue;
    const all = [...new Set([...keys, ...(carried[domain] ?? [])])];
    if (!all.length) continue;
    const flags = await sender.pending(domain, all);
    const todo = all.filter((_, j) => flags[j]);
    for (const b of batches(todo)) {
      try {
        const fee = await sender.quote(domain, b);
        if (fee > maxFee) throw new Error(`fee ${fee} above --max-fee ${maxFee}`);
        const tx = await sender.push(domain, b, { value: fee });
        await tx.wait();
        sent.push({ domain, keys: b.length, tx: tx.hash });
        log(`pushed ${b.length} key(s) to domain ${domain}: ${tx.hash}`);
      } catch (e) {
        (retry[domain] ??= []).push(...b);
        log(`domain ${domain}: ${String(e.shortMessage ?? e.message).slice(0, 160)} (retried next round)`);
      }
    }
  }
  return { state: { fromBlock: head + 1, retry }, sent };
}

// ---------------------------------------------------------------- IBC: ibc-hooks on Osmosis

/**
 * The address ibc-hooks (osmosis-labs/osmosis x/ibc-hooks, DeriveIntermediateSender) executes a memo's wasm call
 * from: bech32(prefix, sha256(sha256("ibc-wasm-hook-intermediary") || "<channel>/<original sender>")), where
 * channel is the RECEIVING chain's channel (Osmosis' end) and the original sender is the packet's sender string
 * (our NeuroOracleSender's zetaphy1… address). Check on osmo-test-5 before use:
 *   osmosisd q ibc-hooks wasm-sender <channel> <zetaphy1…>
 */
export function ibcHooksSender(channel, originalSender, prefix = 'osmo') {
  if (!/^channel-\d{1,6}$/.test(String(channel))) throw new Error('channel: channel-N (Osmosis\' end of the channel)');
  const typ = getBytes(sha256(toUtf8Bytes('ibc-wasm-hook-intermediary')));
  const h = getBytes(sha256(concat([typ, toUtf8Bytes(`${channel}/${originalSender}`)])));
  return toBech32(h, prefix);
}

/** A 0x contract on ZETAPHY as the ICS-20 packet's sender string (zetaphy1…). */
export const zetaphyBech32 = (addr) => toBech32(getBytes(getAddress(addr)), 'zetaphy');
export { fromBech32 };

/** The JSON the CosmWasm oracle receives, parsed back from a memo (what tests and the dry run compare). */
export function parseMemo(memo) {
  const j = JSON.parse(memo);
  const m = j?.wasm?.msg?.mirror;
  if (!j?.wasm?.contract || !m || !Array.isArray(m.items)) throw new Error('not a NeuroOracle memo');
  return { contract: j.wasm.contract, srcChain: m.src_chain, items: m.items };
}

export const senderContract = (address, signerOrProvider) => new Contract(address, SENDER_ABI, signerOrProvider);
export const oracleContract = (address, provider) => new Contract(address, ORACLE_ABI, provider);
