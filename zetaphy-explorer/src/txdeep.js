// The EVM transaction page's analysis, as pure functions (no DOM, no network; the
// unit tests run them in Node): decoding the input, the logs and the revert reason
// with the best ABI there is (verified > known > guessed, always said), the call
// tree from debug_traceTransaction's callTracer, balance changes from the
// prestateTracer (diff mode) and from token Transfer logs, the gas and fee split,
// and a one-line summary in plain words with the risky parts flagged.
import { decodeCall, decodeEvent, decodeRevert, keccakHex } from './abi.js';
import { decodeTransfer, topicAddress } from './evm.js';
import { toBig } from './format.js';
import { decodeApproval, UNLIMITED_MIN } from './wallet-safety.js';

/** Half of every block's fees is burned, the other half goes to the validators (zetaphy-chain, evmd/zetaphy_feeburn.go). */
export const FEE_BURN_BPS = 5000n;
const ZERO = '0x0000000000000000000000000000000000000000';
const lc = (a) => String(a ?? '').toLowerCase();
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? ''));
const hexOf = (x) => (typeof x === 'string' && /^0x[0-9a-fA-F]*$/.test(x) ? x : '0x');
const topicOf = (sig) => '0x' + keccakHex(sig);
export const APPROVAL_TOPIC = topicOf('Approval(address,address,uint256)');
export const APPROVAL_ALL_TOPIC = topicOf('ApprovalForAll(address,address,bool)');

// ---------------------------------------------------------------- decoding with an ABI or a guess

/** Where a fragment of info.fullAbi came from: the contract's own ABI or its implementation's (a proxy). */
function sourceOf(info, f) {
  if ((info?.abi?.functions ?? []).includes(f) || (info?.abi?.events ?? []).includes(f) || (info?.abi?.errors ?? []).includes(f)) return info.source ?? 'guessed';
  return info?.impl?.source ?? 'guessed';
}

/**
 * Call data -> { kind: 'none' } (plain transfer) | { kind: 'short', data } | { kind: 'unknown', selector }
 *   | { kind: 'decoded', fragment, values, source: 'verified' | 'known' | 'guessed', viaProxy }.
 * info: contract.js resolve() result for the callee (or null); db: sigdb.js lookup (or null).
 * A guessed signature must decode strictly and re-encode to the same bytes.
 */
export function decodeInput(data, info, db) {
  const hex = hexOf(data).toLowerCase();
  if (hex === '0x') return { kind: 'none' };
  if (hex.length < 10) return { kind: 'short', data: hex };
  const sel = hex.slice(2, 10);
  for (const f of (info?.fullAbi?.functions ?? []).filter((x) => x.selector === sel)) {
    const source = sourceOf(info, f);
    try {
      return { kind: 'decoded', fragment: f, values: decodeCall(f, hex, source === 'guessed' ? { strict: true, canonical: true } : { strict: false }), source, viaProxy: !(info.abi?.functions ?? []).includes(f) };
    } catch { /* next */ }
  }
  for (const { fragment } of db?.functions(sel) ?? []) {
    try { return { kind: 'decoded', fragment, values: decodeCall(fragment, hex, { strict: true, canonical: true }), source: 'guessed', viaProxy: false }; } catch { /* next */ }
  }
  return { kind: 'unknown', selector: '0x' + sel };
}

/** A log -> { fragment, values, source } or null (anonymous / unknown events stay raw). */
export function decodeLogWith(log, info, db) {
  const t0 = lc(log?.topics?.[0]);
  if (!/^0x[0-9a-f]{64}$/.test(t0)) return null;
  for (const f of (info?.fullAbi?.events ?? []).filter((x) => x.topic === t0)) {
    const source = sourceOf(info, f);
    try { return { fragment: f, values: decodeEvent(f, log, source === 'guessed' ? { strict: true, canonical: true } : { strict: false }), source }; } catch { /* next */ }
  }
  for (const { fragment } of db?.events(t0) ?? []) {
    try { return { fragment, values: decodeEvent(fragment, log, { strict: true, canonical: true }), source: 'guessed' }; } catch { /* next */ }
  }
  return null;
}

/** Revert data decoded with the callee's errors first, then the tables (abi.js decodeRevert). */
export function decodeRevertWith(data, info, db) {
  return decodeRevert(data, (sel) => [
    ...(info?.fullAbi?.errors ?? []).filter((e) => e.selector === sel).map((fragment) => ({ fragment, source: sourceOf(info, fragment) })),
    ...(db?.errors(sel) ?? []).map((x) => ({ fragment: x.fragment, source: 'guessed' })),
  ]);
}

// ---------------------------------------------------------------- traces

/** Is this RPC error "the node has no such method" (rather than a failure of this one call)? */
export function isUnsupported(e) {
  const code = Number(e?.code);
  const m = String(e?.message ?? e);
  return code === -32601 || code === 404 || code === 405 || /method .*(not (found|available|supported|exist)|does not exist|unavailable)|not (supported|enabled|available)|unsupported|disabled|does not exist/i.test(m);
}

/**
 * callTracer's tree -> a flat list in call order, at most `max` entries:
 * { calls: [{ id, depth, type, from, to, value, gas, gasUsed, input, output, error, revertReason, reverted }], truncated }.
 * `reverted` is true for a failed call and everything under it (their effects were undone).
 */
export function flattenCalls(root, { max = 400 } = {}) {
  const calls = []; let truncated = false;
  const walk = (c, depth, parentReverted, id) => {
    if (!c || typeof c !== 'object') return;
    if (calls.length >= max || depth > 64) { truncated = true; return; }
    const error = c.error ? String(c.error).slice(0, 300) : null;
    const node = {
      id, depth, type: String(c.type ?? 'CALL').toUpperCase().slice(0, 16),
      from: isAddr(c.from) ? lc(c.from) : null, to: isAddr(c.to) ? lc(c.to) : null,
      value: toBig(c.value) ?? 0n, gas: toBig(c.gas), gasUsed: toBig(c.gasUsed),
      input: hexOf(c.input), output: hexOf(c.output), error, revertReason: c.revertReason ? String(c.revertReason).slice(0, 300) : null,
      reverted: parentReverted || !!error,
    };
    calls.push(node);
    (Array.isArray(c.calls) ? c.calls : []).forEach((k, i) => walk(k, depth + 1, node.reverted, `${id}.${i}`));
  };
  walk(root, 0, false, '0');
  return { calls, truncated };
}

const MOVES_VALUE = new Set(['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT']);
/** Native value moved by calls that were not undone: [{ from, to, value }] (the tx's own value is the first). */
export function nativeFlows(calls) {
  return calls.filter((c) => c.value > 0n && !c.reverted && MOVES_VALUE.has(c.type) && c.from && c.to).map((c) => ({ from: c.from, to: c.to, value: c.value, depth: c.depth }));
}

/** flows -> Map(address -> net change), fees not included. */
export function netNative(flows) {
  const m = new Map();
  const add = (a, v) => m.set(a, (m.get(a) ?? 0n) + v);
  for (const f of flows) { add(f.from, -f.value); add(f.to, f.value); }
  for (const [a, v] of m) if (v === 0n) m.delete(a);
  return m;
}

/**
 * prestateTracer { diffMode: true } -> [{ address, before, after, delta }] for native balances that changed.
 * In diff mode `post` holds only what changed; an account in `pre` but not in `post` was deleted.
 */
export function balanceChanges(diff) {
  const pre = diff?.pre && typeof diff.pre === 'object' ? diff.pre : {};
  const post = diff?.post && typeof diff.post === 'object' ? diff.post : {};
  const out = [];
  for (const a of new Set([...Object.keys(pre), ...Object.keys(post)])) {
    if (!isAddr(a)) continue;
    const before = toBig(pre[a]?.balance) ?? 0n;
    const after = a in post ? (toBig(post[a]?.balance) ?? before) : 0n;
    if (before !== after) out.push({ address: lc(a), before, after, delta: after - before });
  }
  return out.sort((x, y) => (x.delta < y.delta ? -1 : x.delta > y.delta ? 1 : 0));
}

/**
 * Token transfers (evm.js decodeTransfer results) -> net change per holder, token and NFT id:
 * [{ holder, token, standard, id (null for ERC-20), delta }]; the zero address (mint / burn side) is left out.
 */
export function tokenDeltas(transfers) {
  const m = new Map();
  const add = (holder, token, standard, id, v) => {
    if (lc(holder) === ZERO) return;
    const k = `${lc(holder)}|${lc(token)}|${id ?? ''}`;
    const e = m.get(k) ?? { holder: lc(holder), token: lc(token), standard, id, delta: 0n };
    e.delta += v; m.set(k, e);
  };
  for (const t of transfers) {
    if (!t) continue;
    if (t.standard === 'erc20') { add(t.from, t.token, 'erc20', null, -t.amount); add(t.to, t.token, 'erc20', null, t.amount); }
    else if (t.standard === 'erc721') { add(t.from, t.token, 'erc721', t.tokenId, -1n); add(t.to, t.token, 'erc721', t.tokenId, 1n); }
    else if (t.standard === 'erc1155') t.ids.forEach((id, i) => { add(t.from, t.token, 'erc1155', id, -t.amounts[i]); add(t.to, t.token, 'erc1155', id, t.amounts[i]); });
  }
  return [...m.values()].filter((e) => e.delta !== 0n);
}

// ---------------------------------------------------------------- gas

/**
 * { used, limit, usedPct, price, baseFee, fee, burned, toValidators, baseCost, tip } (BigInt; null when unknown).
 * fee = gasUsed × effective price; half is burned (FEE_BURN_BPS); baseCost / tip split it by the block's base fee.
 */
export function gasInfo(tx, rc, block) {
  const used = toBig(rc?.gasUsed); const limit = toBig(tx?.gas);
  const price = toBig(rc?.effectiveGasPrice ?? tx?.gasPrice); const baseFee = toBig(block?.baseFeePerGas);
  const fee = used != null && price != null ? used * price : null;
  const burned = fee != null ? (fee * FEE_BURN_BPS) / 10000n : null;
  return {
    used, limit, usedPct: used != null && limit ? Number((used * 10000n) / limit) / 100 : null, price, baseFee, fee, burned,
    toValidators: fee != null ? fee - burned : null,
    baseCost: baseFee != null && used != null ? baseFee * used : null,
    tip: baseFee != null && price != null && used != null && price >= baseFee ? (price - baseFee) * used : null,
    maxFee: toBig(tx?.maxFeePerGas), maxPriority: toBig(tx?.maxPriorityFeePerGas),
  };
}

// ---------------------------------------------------------------- summary and risks

const assetOf = (token, value, standard) => (token ? { kind: standard ?? 'erc20', token: lc(token), value } : { kind: 'native', value });

/** Approvals the sender gave in this tx's logs (covers multicalls and permits): [{ token, spender, unlimited, all }]. */
export function approvalsInLogs(logs, owner) {
  const out = [];
  for (const l of logs ?? []) {
    const t = (l?.topics ?? []).map(lc);
    if (t[0] === APPROVAL_TOPIC && t.length === 3 && topicAddress(t[1])?.toLowerCase() === lc(owner)) {
      const v = toBig(l.data);
      if (v != null && v >= UNLIMITED_MIN) out.push({ token: lc(l.address), spender: lc(topicAddress(t[2])), unlimited: true });
    } else if (t[0] === APPROVAL_ALL_TOPIC && t.length === 3 && topicAddress(t[1])?.toLowerCase() === lc(owner) && toBig(l.data) === 1n) {
      out.push({ token: lc(l.address), spender: lc(topicAddress(t[2])), all: true });
    }
  }
  return out;
}

/**
 * One line in plain words, as an i18n key and its variables, plus the risks:
 *   { key, vars: { from, to, fn, spender, contract, a, b, asset, n, ... }, risks: [{ key, vars }] }
 * Asset variables are { kind: 'native' | 'erc20' | 'erc721' | 'erc1155', token, value } (the page formats them);
 * address variables are lower-case 0x strings.
 * o: { tx, rc, input (decodeInput), transfers (decodeTransfer list), native (netNative map, or null), label (callee name, or null) }
 */
export function summarize({ tx, rc, input, transfers = [], native = null, label = null }) {
  const from = lc(tx?.from); const to = tx?.to ? lc(tx.to) : null;
  const value = toBig(tx?.value) ?? 0n;
  const fn = input?.kind === 'decoded' ? input.fragment.name : null;
  const risks = [];
  const vars = { from, to, fn, on: label };
  const ap = decodeApproval(String(tx?.input ?? ''));
  const seen = new Set();
  if (ap?.kind === 'erc20' && ap.unlimited) { risks.push({ key: 'riskUnlimited', vars: { spender: lc(ap.spender), token: to } }); seen.add(`${to}|${lc(ap.spender)}`); }
  if (ap?.kind === 'all' && ap.approved) { risks.push({ key: 'riskApproveAll', vars: { spender: lc(ap.spender), token: to } }); seen.add(`${to}|${lc(ap.spender)}|all`); }
  for (const x of approvalsInLogs(rc?.logs, from)) {
    const k = `${x.token}|${x.spender}${x.all ? '|all' : ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    risks.push({ key: x.all ? 'riskApproveAll' : 'riskUnlimited', vars: { spender: x.spender, token: x.token } });
  }
  const done = (key, more = {}) => ({ key, vars: { ...vars, ...more }, risks });

  if (rc && rc.status !== '0x1') return done(to ? (fn ? 'sumFailedFn' : 'sumFailed') : 'sumFailedCreate');
  if (!to) return done('sumCreate', { contract: rc?.contractAddress ? lc(rc.contractAddress) : null });
  if (ap?.kind === 'erc20') return done(ap.unlimited ? 'sumApproveUnlimited' : 'sumApprove', { spender: lc(ap.spender), asset: assetOf(to, ap.amount), token: to });
  if (ap?.kind === 'all') return done(ap.approved ? 'sumApproveAll' : 'sumRevokeAll', { spender: lc(ap.spender), contract: to });

  // the sender's net change per asset: tokens from the logs, the native coin from the calls (or the tx value)
  const mine = tokenDeltas(transfers).filter((d) => d.holder === from);
  const nativeDelta = native ? (native.get(from) ?? 0n) : -value;
  const fungible = mine.filter((d) => d.standard === 'erc20').map((d) => ({ ...assetOf(d.token, d.delta), delta: d.delta }));
  if (nativeDelta) fungible.push({ ...assetOf(null, nativeDelta), delta: nativeDelta });
  const outs = fungible.filter((x) => x.delta < 0n); const ins = fungible.filter((x) => x.delta > 0n);
  const abs = (x) => ({ kind: x.kind, token: x.token, value: x.delta < 0n ? -x.delta : x.delta });
  if (outs.length && ins.length) return done(label ? 'sumSwapOn' : 'sumSwap', { a: abs(outs[0]), b: abs(ins[0]) });

  const nfts = (transfers ?? []).filter((t) => t && t.standard !== 'erc20');
  const units = (list) => list.reduce((n, t) => n + (t.standard === 'erc721' ? 1n : t.amounts.reduce((s, x) => s + x, 0n)), 0n);
  const sentNft = nfts.filter((t) => lc(t.from) === from); const gotNft = nfts.filter((t) => lc(t.to) === from && t.mint);
  const tokenSent = (transfers ?? []).filter((t) => t?.standard === 'erc20' && lc(t.from) === from);
  if (/^(transfer|transferFrom)$/.test(fn ?? '') && tokenSent.length === 1) { // the call itself says what it is, whatever else moved
    return done('sumToken', { asset: assetOf(tokenSent[0].token, tokenSent[0].amount), to: lc(tokenSent[0].to) });
  }
  if (sentNft.length) {
    const recips = new Set(sentNft.map((t) => lc(t.to)));
    return done(recips.size === 1 ? 'sumNft' : 'sumNftMany', { n: units(sentNft).toString(), to: [...recips][0] });
  }
  if (gotNft.length) return done('sumNftMint', { n: units(gotNft).toString() });
  if (tokenSent.length) {
    const recips = new Set(tokenSent.map((t) => lc(t.to)));
    if (recips.size === 1 && new Set(tokenSent.map((t) => lc(t.token))).size === 1) {
      return done('sumToken', { asset: assetOf(tokenSent[0].token, tokenSent.reduce((n, t) => n + t.amount, 0n)), to: [...recips][0] });
    }
  }
  if (input?.kind === 'none') return done('sumSend', { asset: assetOf(null, value) });
  if (fn) return done(value ? 'sumCallValue' : 'sumCall', { asset: assetOf(null, value) });
  return done('sumCallRaw', { fn: input?.selector ?? String(tx?.input ?? '').slice(0, 10) });
}

/** Addresses worth checking against ThreatRegistry for this tx: the callee and every approved spender (at most 4). */
export function threatTargets(tx, risks) {
  const s = new Set();
  if (isAddr(tx?.to)) s.add(lc(tx.to));
  for (const r of risks ?? []) if (isAddr(r.vars?.spender)) s.add(r.vars.spender);
  return [...s].slice(0, 4);
}

/** Token transfers of a receipt (decoded), for the summary and the changes table. */
export const receiptTransfers = (rc) => (rc?.logs ?? []).map(decodeTransfer).filter(Boolean);
