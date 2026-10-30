// Self-healing detectors (docs/future/self-healing.md): what a Neuro runner computes from the chain
// to decide that an exploit is in progress against a protocol that opted in to CircuitBreaker, and
// the EVIDENCE it signs. Everything here is a pure function of chain data (logs, code, traces) over
// a block range plus a fixed look-back, so every honest runner computes the same evidence and the
// same evidence hash: that is what lets k of n runners sign one trip.
//
// Signals (none is enough alone: a trip needs the volume signal AND a reentrancy shape (burst or
// trace) or an oracle deviation, or an extreme outlier (zStrong, strongVolume) paid to a fresh
// contract that calls back):
//   volume       the block's outflow is a z-score outlier (z >= 3) against the look-back blocks
//                (idle blocks count as 0), and above an absolute floor. Deliberately sensitive: on
//                its own it is only what a plain monitor would ALERT on (a whale is an outlier
//                too); it never trips without one of the corroborating signals below
//   burst        reentrancy pattern from logs: >= `burst` outflows to ONE recipient inside ONE tx
//   trace        reentrancy pattern from a call trace (debug_traceTransaction callTracer), when the
//                node has it: protocol -> X (value out) -> ... -> protocol again
//   callback     Neuro bytecode scan: the recipient is a contract whose code pushes one of the
//                protocol's own paused selectors (it was written to call back into the protocol)
//   fresh        the recipient is a contract never paid in the look-back
//   oracle       a price-feed update deviates from the median of the look-back by >= oracleBps
// The evidence object lists the inputs (per-block volumes, baseline, recipients, signals); its
// hash is sha256 of its canonical JSON, like a Neuro reportHash.
import { createHash } from 'node:crypto';
import { getAddress, ZeroAddress, keccak256, toUtf8Bytes, AbiCoder, id as topicId } from 'ethers';
import { decodeLogs } from '../../../zetaphy-neuro/src/tx.js';
import { hexToBytes, codeLengthWithoutMetadata } from '../../../zetaphy-neuro/src/bytecode.js';

export const DETECTOR = 'neuro-selfheal/1';
export const DETECTOR_ID = keccak256(toUtf8Bytes(DETECTOR));
export const DEFAULT_THRESHOLDS = { z: 3, minVolume: 10n ** 18n, burst: 3, lookback: 40, oracleBps: 2000, minStdShare: 0.25, zStrong: 30, strongVolume: 10n ** 20n };
const TRANSFER = topicId('Transfer(address,address,uint256)');

const lower = (a) => String(a).toLowerCase();
const word = (data, i) => BigInt('0x' + (String(data).slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'));
const topicAddr = (t) => getAddress('0x' + String(t).slice(-40));
const sha = (s) => '0x' + createHash('sha256').update(s).digest('hex');

/** Canonical JSON: sorted keys, bigint as decimal strings. */
export function canonical(v) {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const evidenceHashOf = (evidence) => sha(canonical(evidence));

/**
 * A protocol's watch config. cfg: { address, selectors: ['0x…' in the policy's order], traces (bool: read callTracer traces),
 *   outflowEvents: [{ topic0, toTopic, amountWord, selector, asset }], tokenTransfers (bool),
 *   feeds: [{ address, topic0, assetTopic, priceWord }], thresholds }
 */
export function watchConfig(cfg) {
  return {
    ...cfg,
    address: getAddress(cfg.address),
    selectors: (cfg.selectors ?? []).map(lower),
    outflowEvents: (cfg.outflowEvents ?? []).map((e) => ({ toTopic: 1, amountWord: 0, asset: ZeroAddress, ...e, topic0: lower(e.topic0), selector: e.selector && lower(e.selector) })),
    feeds: (cfg.feeds ?? []).map((f) => ({ assetTopic: 1, priceWord: 0, ...f, address: getAddress(f.address), topic0: lower(f.topic0) })),
    thresholds: { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds ?? {}) },
  };
}

/** Logs -> outflows of the protocol: its configured events, and (Neuro's decodeLogs) ERC-20 Transfers out of it. */
export function outflowsOf(logs, cfg) {
  const out = [];
  const me = lower(cfg.address);
  for (const l of logs) {
    const block = Number(BigInt(l.blockNumber));
    const t0 = lower(l.topics?.[0] ?? '');
    if (lower(l.address) === me) {
      for (const e of cfg.outflowEvents) {
        if (e.topic0 !== t0) continue;
        out.push({ block, tx: l.transactionHash, asset: getAddress(e.asset), to: topicAddr(l.topics[e.toTopic]), amount: word(l.data, e.amountWord), selector: e.selector ?? null });
      }
    }
    if (cfg.tokenTransfers && t0 === lower(TRANSFER)) {
      for (const ev of decodeLogs([l])) {
        if (ev.kind === 'token' && ev.from === me && ev.amount > 0n) out.push({ block, tx: l.transactionHash, asset: getAddress(ev.token), to: getAddress(ev.to), amount: ev.amount, selector: null });
      }
    }
  }
  return out;
}

/** Logs -> price updates of the configured feeds. */
export function pricesOf(logs, cfg) {
  const out = [];
  for (const l of logs) for (const f of cfg.feeds) {
    if (lower(l.address) !== lower(f.address) || lower(l.topics?.[0] ?? '') !== f.topic0) continue;
    out.push({ block: Number(BigInt(l.blockNumber)), asset: topicAddr(l.topics[f.assetTopic]), price: word(l.data, f.priceWord) });
  }
  return out;
}

/** Mean and standard deviation of per-block volumes (in gwei, as numbers), idle blocks counted as 0. */
export function baselineOf(volumes) {
  const xs = volumes.map((v) => Number(v / 10n ** 9n));
  const n = xs.length || 1;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n: xs.length, mean: Math.round(mean), std: Math.round(std) };
}

/** z of a volume against a baseline; the std is floored (minStdShare x mean, at least 1 gwei) so a quiet history cannot make every outflow an outlier. */
export function zscore(volume, base, minStdShare = DEFAULT_THRESHOLDS.minStdShare) {
  const x = Number(volume / 10n ** 9n);
  const std = Math.max(base.std, base.mean * minStdShare, 1);
  return (x - base.mean) / std;
}

/** Reentrancy from logs: per tx and recipient, the number of outflows (bursts of >= min). */
export function burstsOf(outflows, min = DEFAULT_THRESHOLDS.burst) {
  const n = new Map();
  for (const o of outflows) { const k = `${o.tx}|${o.to}`; n.set(k, (n.get(k) ?? 0) + 1); }
  return [...n.entries()].filter(([, c]) => c >= min).map(([k, c]) => ({ tx: k.split('|')[0], to: k.split('|')[1], count: c })).sort((a, b) => (a.tx + a.to).localeCompare(b.tx + b.to));
}

/**
 * Reentrancy from a callTracer frame tree ({ from, to, input, value, calls }): the protocol pays X
 * (a call with value, or any call), and inside that call the protocol is entered again. Returns
 * the deepest re-entry depth (0 = none).
 */
export function reentrancyFromTrace(frame, protocol) {
  const p = lower(protocol);
  let best = 0;
  // outside: control left the protocol (it called out) and has not come back yet
  const walk = (f, outside, depth) => {
    const to = lower(f.to ?? '');
    let d = depth;
    let out = outside;
    if (to === p) { if (outside) d = depth + 1; out = false; } else if (lower(f.from ?? '') === p) out = true;
    best = Math.max(best, d);
    for (const c of f.calls ?? []) walk(c, out, d);
  };
  walk(frame, false, 0);
  return best;
}

/** Selectors (lowercase 0x…) the code pushes with PUSH4 (after Neuro's metadata strip). */
export function pushedSelectors(codeHex) {
  const code = hexToBytes(codeHex);
  const end = codeLengthWithoutMetadata(code);
  const out = new Set();
  for (let pc = 0; pc < end; pc++) {
    const op = code[pc];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4 && pc + 4 < code.length) out.add('0x' + Buffer.from(code.subarray(pc + 1, pc + 5)).toString('hex'));
      pc += n;
    }
  }
  return out;
}

const median = (xs) => { const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); return s.length ? s[(s.length - 1) >> 1] : null; };

/**
 * The evidence for blocks [from, to] (pure). data: {
 *   chainId, outflows (outflowsOf over [from - lookback, to]), prices (pricesOf, same range),
 *   code: { address: '0x…' code } of the recipients in [from, to], traces: { txHash: frame } (optional) }
 * Returns { anomalous, evidence, evidenceHash, mask }.
 */
export function evaluate(cfg, data, from, to) {
  const th = cfg.thresholds;
  const lb = th.lookback;
  const inWin = data.outflows.filter((o) => o.block >= from && o.block <= to);
  const past = data.outflows.filter((o) => o.block < from && o.block >= from - lb);
  const perBlock = (list, a, b) => { const v = []; for (let x = a; x <= b; x++) v.push(list.filter((o) => o.block === x).reduce((s, o) => s + o.amount, 0n)); return v; };
  const base = baselineOf(perBlock(past, from - lb, from - 1));
  const volumes = perBlock(inWin, from, to);
  const window = volumes.map((v, i) => ({ block: from + i, volume: v, z: Math.round(zscore(v, base, th.minStdShare) * 100) / 100 }));
  const peak = window.reduce((m, w) => (w.z > m.z ? w : m), window[0]);
  const signals = [];
  if (peak && peak.z >= th.z && peak.volume >= BigInt(th.minVolume)) signals.push({ id: 'volume', block: peak.block, z: peak.z, volume: peak.volume });

  for (const b of burstsOf(inWin, th.burst)) signals.push({ id: 'burst', tx: b.tx, to: b.to, count: b.count });

  for (const [tx, frame] of Object.entries(data.traces ?? {}).sort()) {
    const depth = reentrancyFromTrace(frame, cfg.address);
    if (depth > 0) signals.push({ id: 'trace', tx, depth });
  }

  const seen = new Set(past.map((o) => lower(o.to)));
  const paused = new Set(cfg.selectors);
  const recipients = [...new Set(inWin.map((o) => o.to))].sort();
  for (const r of recipients) {
    const code = data.code?.[r] ?? data.code?.[lower(r)] ?? '0x';
    if (code === '0x' || code.length <= 2) continue;
    const pushes = pushedSelectors(code);
    const hits = [...paused].filter((s) => pushes.has(s)).sort();
    if (hits.length) signals.push({ id: 'callback', to: r, selectors: hits });
    if (!seen.has(lower(r))) signals.push({ id: 'fresh', to: r });
  }

  const pastPrices = (data.prices ?? []).filter((p) => p.block < from && p.block >= from - lb);
  for (const p of (data.prices ?? []).filter((x) => x.block >= from && x.block <= to)) {
    const m = median(pastPrices.filter((q) => q.asset === p.asset).map((q) => q.price));
    if (!m) continue;
    const dev = Number(((p.price > m ? p.price - m : m - p.price) * 10_000n) / m);
    if (dev >= th.oracleBps) signals.push({ id: 'oracle', block: p.block, asset: p.asset, price: p.price, median: m, bps: dev });
  }

  const has = (id) => signals.some((x) => x.id === id);
  const vol = signals.find((x) => x.id === 'volume');
  // The volume signal is required (no trip without money moving), plus independent corroboration:
  // a reentrancy shape (logs or trace) or an oracle deviation; or, for an unknown exploit shape, a
  // much stronger outlier (zStrong, strongVolume) paid to a fresh contract written to call back.
  const strong = vol && vol.z >= th.zStrong && vol.volume >= BigInt(th.strongVolume) && has('fresh') && has('callback');
  const anomalous = !!vol && (has('burst') || has('trace') || has('oracle') || !!strong);
  // the selectors to pause: those whose outflow events carried the anomalous block's money
  let mask = 0;
  if (anomalous) {
    for (const o of inWin.filter((x) => x.block === peak.block && x.selector)) {
      const i = cfg.selectors.indexOf(o.selector);
      if (i >= 0) mask |= 1 << i;
    }
  }
  const evidence = {
    v: 1, detector: DETECTOR, chainId: String(data.chainId), protocol: cfg.address, fromBlock: from, toBlock: to, mask,
    baseline: { blocks: lb, ...base }, window, signals,
    outflows: inWin.map((o) => ({ block: o.block, tx: o.tx, asset: o.asset, to: o.to, amount: o.amount })),
  };
  return { anomalous, evidence, evidenceHash: evidenceHashOf(evidence), mask, signals };
}

/** The on-chain digest (CircuitBreaker.digest) of an evidence, computed locally. */
export function tripDigest({ chainId, breaker, protocol, epoch, fromBlock, toBlock, evidenceHash, detectorId = DETECTOR_ID, mask }) {
  const TYPEHASH = keccak256(toUtf8Bytes('ZetaphyCircuitBreakerTrip(uint256 chainId,address breaker,address protocol,uint256 epoch,uint64 fromBlock,uint64 toBlock,bytes32 evidenceHash,bytes32 detectorId,uint16 mask)'));
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'address', 'address', 'uint256', 'uint64', 'uint64', 'bytes32', 'bytes32', 'uint16'],
    [TYPEHASH, chainId, breaker, protocol, epoch, fromBlock, toBlock, evidenceHash, detectorId, mask]));
}

/** Reads what evaluate() needs from a provider (eth_getLogs, eth_getCode, debug traces when available). */
export async function collect(provider, cfg, from, to, { cache = {} } = {}) {
  const lo = Math.max(0, from - cfg.thresholds.lookback);
  const logs = await provider.send('eth_getLogs', [{ fromBlock: '0x' + lo.toString(16), toBlock: '0x' + to.toString(16), address: cfg.address }]);
  let tokenLogs = [];
  if (cfg.tokenTransfers) {
    tokenLogs = await provider.send('eth_getLogs', [{ fromBlock: '0x' + lo.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER, '0x' + '0'.repeat(24) + lower(cfg.address).slice(2)] }]);
  }
  let feedLogs = [];
  if (cfg.feeds.length) feedLogs = await provider.send('eth_getLogs', [{ fromBlock: '0x' + lo.toString(16), toBlock: '0x' + to.toString(16), address: cfg.feeds.map((f) => f.address) }]);
  const outflows = outflowsOf([...logs, ...tokenLogs], cfg);
  const prices = pricesOf(feedLogs, cfg);
  const code = {};
  for (const o of outflows.filter((x) => x.block >= from)) {
    if (!(o.to in code)) code[o.to] = cache[o.to] ??= await provider.send('eth_getCode', [o.to, 'latest']);
  }
  const tr = {};
  // Traces only when the watch config says so (cfg.traces): every runner of a protocol must use the
  // same inputs, or their evidence hashes differ. A node without debug_traceTransaction throws here.
  if (cfg.traces) {
    for (const tx of [...new Set(outflows.filter((x) => x.block >= from).map((o) => o.tx))]) {
      tr[tx] = await provider.send('debug_traceTransaction', [tx, { tracer: 'callTracer' }]);
    }
  }
  const chainId = (await provider.getNetwork()).chainId;
  return { chainId, outflows, prices, code, traces: tr };
}
