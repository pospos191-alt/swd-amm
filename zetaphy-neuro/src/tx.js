// Transaction check (EVM chains, ZETAPHY included): reads one transaction and its
// receipt, lists what moved where (the "path": the call, every token and NFT
// movement and approval in its logs), and flags patterns scams use:
//   - an approval that lets a plain wallet (not a contract) spend your tokens
//   - unlimited approvals and "approve all NFTs" to anyone
//   - a 0-amount token transfer (address poisoning: a fake entry in your history)
//   - an address that looks like yours but is not (same first and last characters)
//   - money sent to a "claim / airdrop / verify…" function (wallet-drainer bait)
//   - a call to, or an approval for, a contract Neuro itself rates as risky
// Read-only: nothing is signed or sent. Internal ETH movements inside the call
// are not visible without a trace API, and the path says so.

import { CHAINS } from './chains.js';
import { createRpc } from './rpc.js';
import { SELECTORS } from './selectors.generated.js';
import { decodeUint, decodeString, cleanText } from './abi.js';
import { readContract, REPORT_VERSION } from './reader.js';

export const isTxHash = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s.trim());

const TOPIC = {
  transfer: 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  approval: '8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  approvalForAll: '17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
  single1155: 'c3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
};
/** Amounts at or above 2^255 are "unlimited" (wallets ask for 2^256-1). */
export const UNLIMITED = 2n ** 255n;
/** Function names wallet drainers use to make people send money. */
export const BAIT = /claim|airdrop|reward|bonus|gift|secur|verif|connect|sync|migrat|rectif|validat|restore|unlock|whitelist/i;
const RANK = { high: 3, medium: 2, low: 1, info: 0, good: 0 };
const MAX_TOKENS = 8; // token metadata reads per transaction
const MAX_CONTRACTS = 4; // contracts analysed per transaction (the callee and spenders)

const topicAddr = (t) => (t && t.length >= 66 ? '0x' + t.slice(-40).toLowerCase() : null);
const lower = (a) => (a ? String(a).toLowerCase() : a);

/** Same first 4 and last 4 hex characters, but a different address: made to be mistaken for the other. */
export function lookalike(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x !== y && x.slice(2, 6) === y.slice(2, 6) && x.slice(-4) === y.slice(-4);
}

/** Receipt logs -> path events (tokens moved, approvals given). Unknown logs are skipped. */
export function decodeLogs(logs) {
  const out = [];
  for (const l of logs ?? []) {
    const t0 = String(l.topics?.[0] ?? '').replace(/^0x/, '').toLowerCase();
    const token = lower(l.address);
    if (t0 === TOPIC.transfer && l.topics.length === 3) {
      const amount = decodeUint(l.data ?? '0x');
      if (amount === null) continue; // not an ERC-20 Transfer after all
      out.push({ kind: 'token', token, from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), amount });
    } else if (t0 === TOPIC.transfer && l.topics.length === 4) {
      out.push({ kind: 'nft', token, from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), id: BigInt(l.topics[3]).toString() });
    } else if (t0 === TOPIC.approval && l.topics.length === 3) {
      const amount = decodeUint(l.data ?? '0x') ?? 0n;
      out.push({ kind: 'approve', token, owner: topicAddr(l.topics[1]), spender: topicAddr(l.topics[2]), amount, unlimited: amount >= UNLIMITED });
    } else if (t0 === TOPIC.approvalForAll && l.topics.length === 3) {
      out.push({ kind: 'approveAll', token, owner: topicAddr(l.topics[1]), operator: topicAddr(l.topics[2]), approved: (decodeUint(l.data ?? '0x') ?? 0n) !== 0n });
    } else if (t0 === TOPIC.single1155 && l.topics.length === 4) {
      const d = String(l.data ?? '').replace(/^0x/, '');
      out.push({ kind: 'nft', token, from: topicAddr(l.topics[2]), to: topicAddr(l.topics[3]), id: BigInt('0x' + (d.slice(0, 64) || '0')).toString() });
    }
  }
  return out;
}

/**
 * The rules, on already-read data (pure; tests call it directly).
 * @param {object} t  { found, status, from, to, created, value: bigint, method: {selector, sig}|null,
 *                      events: decodeLogs(...), code: {addr: hasCode}, levels: {addr: Neuro level} }
 */
export function analyzeTx(t) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  if (!t.found) {
    add('tx-not-found', 'info');
    return { level: 'info', control: 'none', findings };
  }
  const me = lower(t.from);
  const code = t.code ?? {};
  const levels = t.levels ?? {};
  add('tx-summary', 'info', { from: t.from, to: t.to ?? t.created, method: t.method?.sig ?? t.method?.selector ?? null, value: String(t.value ?? 0n), native: t.native, created: !!t.created });
  if (t.status === false) add('tx-failed', 'info');
  if (t.created) add('tx-created', 'info', { address: t.created });

  for (const e of t.events ?? []) {
    if (e.kind === 'approve' && e.owner === me && e.amount > 0n) {
      const p = { token: e.token, symbol: e.symbol, spender: e.spender, unlimited: e.unlimited };
      if (code[e.spender] === false) add('tx-approve-wallet', 'high', p);
      else if (levels[e.spender] === 'high') add('tx-approve-risky', 'high', p);
      else if (e.unlimited) add('tx-approve-unlimited', 'medium', p);
    }
    if (e.kind === 'approveAll' && e.owner === me && e.approved) {
      const p = { token: e.token, symbol: e.symbol, operator: e.operator };
      if (code[e.operator] === false) add('tx-approve-all-wallet', 'high', p);
      else add('tx-approve-all', levels[e.operator] === 'high' ? 'high' : 'medium', p);
    }
    if (e.kind === 'token' && e.amount === 0n) add('tx-zero-transfer', 'high', { token: e.token, symbol: e.symbol, from: e.from, to: e.to });
  }
  // Look-alike addresses next to the sender (address poisoning), once per pair.
  const seen = new Set();
  for (const e of t.events ?? []) {
    for (const a of [e.from, e.to, e.spender, e.operator]) {
      for (const b of [me, t.to && lower(t.to)]) {
        if (a && b && lookalike(a, b) && !seen.has(a + b)) { seen.add(a + b); add('tx-lookalike', 'high', { a, b }); }
      }
    }
  }
  const value = t.value ?? 0n;
  const name = t.method?.sig ?? '';
  if (value > 0n && t.to && code[lower(t.to)] && (BAIT.test(name) || (!name && t.method?.selector))) {
    add('tx-bait-payable', 'medium', { method: name || t.method.selector, value: String(value), native: t.native });
  }
  const callee = t.to && lower(t.to);
  if (callee && (levels[callee] === 'high' || levels[callee] === 'medium')) add('tx-to-risky', levels[callee], { to: callee, level: levels[callee] });

  const level = findings.reduce((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), 'info');
  if (level === 'info') add('tx-nothing-found', 'info');
  return { level, control: 'none', findings };
}

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

/**
 * Reads a transaction on an EVM chain and checks it.
 * @returns report { kind: 'tx', chain, hash, address (= hash, for the verdict), from, to, value, status,
 *                   block, method, path: [...events with token symbols], analysis, reportHash }
 */
export async function readTransaction(chainKey, hash, opts = {}) {
  const chain = opts.chainConfig ?? CHAINS[chainKey];
  if (!chain || chain.kind !== 'evm') throw new Error('transaction checks are for EVM chains');
  if (!isTxHash(hash)) throw new Error('invalid transaction hash');
  const h = hash.trim().toLowerCase();
  const rpc = opts.rpc ?? createRpc(chain.rpcs, chain.id, { fetchImpl: opts.fetchImpl });
  const report = { version: REPORT_VERSION, kind: 'tx', chain: chainKey, chainId: chain.id, hash: h, address: h };
  const [tx, rc] = await Promise.all([rpc.call('eth_getTransactionByHash', [h]), rpc.call('eth_getTransactionReceipt', [h])]);
  if (!tx) {
    report.analysis = analyzeTx({ found: false });
    report.reportHash = await sha256Hex(JSON.stringify(plain(report)));
    return report;
  }
  const selector = tx.input && tx.input.length >= 10 ? tx.input.slice(2, 10).toLowerCase() : null;
  const method = selector ? { selector: '0x' + selector, sig: SELECTORS[selector]?.sig ?? null } : null;
  const to = lower(tx.to);
  const created = rc?.contractAddress ? lower(rc.contractAddress) : null;
  const events = decodeLogs(rc?.logs);
  Object.assign(report, {
    from: lower(tx.from), to: to ?? null, value: BigInt(tx.value ?? '0x0').toString(), native: chain.native ?? 'ETH',
    status: rc ? rc.status === '0x1' : null, block: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null, method, created,
  });

  const tryCall = async (a, data) => {
    try { const r = await rpc.call('eth_call', [{ to: a, data }, 'latest']); return r && r !== '0x' ? r : null; } catch { return null; }
  };
  // Token names for the path (symbol is as the contract writes it).
  const tokens = [...new Set(events.map((e) => e.token))].slice(0, MAX_TOKENS);
  const meta = {};
  await Promise.all(tokens.map(async (a) => {
    const [s, d] = await Promise.all([tryCall(a, '0x95d89b41'), tryCall(a, '0x313ce567')]);
    meta[a] = { symbol: s ? cleanText(decodeString(s), 16) : null, decimals: d ? Number(decodeUint(d)) : null };
  }));
  for (const e of events) Object.assign(e, { symbol: meta[e.token]?.symbol ?? null, decimals: meta[e.token]?.decimals ?? null });

  // Which addresses are contracts, and Neuro's own rating of the callee and the spenders.
  const parties = [...new Set([to, ...events.flatMap((e) => [e.spender, e.operator])].filter(Boolean))];
  const code = {};
  await Promise.all(parties.map(async (a) => {
    try { const c = await rpc.call('eth_getCode', [a, 'latest']); code[a] = !!c && c !== '0x'; } catch { /* unknown */ }
  }));
  const levels = {};
  await Promise.all(parties.filter((a) => code[a]).slice(0, MAX_CONTRACTS).map(async (a) => {
    try { levels[a] = (await readContract(chainKey, a, { rpc, simulate: false, chainConfig: opts.chainConfig })).analysis.level; } catch { /* unreadable */ }
  }));

  report.path = [
    created ? { kind: 'create', from: report.from, address: created } : { kind: 'call', from: report.from, to, method: method?.sig ?? method?.selector ?? null, value: report.value, native: report.native },
    ...events,
  ];
  report.analysis = analyzeTx({
    found: true, status: report.status, from: report.from, to, created, value: BigInt(report.value), method, events, code, levels, native: report.native,
  });
  report.reportHash = await sha256Hex(JSON.stringify(plain(report)));
  return plain(report);
}
