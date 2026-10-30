// The sentinels' detectors (docs/future/immune-network.md). Each is split in two:
//   - a collector (what a sentinel feeds blocks to, keeping a small window of state), and
//   - a PURE verdict over explicit inputs, which is what goes into the evidence bundle. A runner re-runs that verdict
//     on the bundle's inputs (reverify) before it votes, so no runner has to trust a sentinel.
// What they detect:
//   clone          a new contract matching a shared vaccine (vaccines.js)
//   flashloan      a flash loan + a pool price pushed >= 25% and back inside one transaction + profit to the caller
//   outflow        a protocol losing >= 10% of its value (or 8x its usual outflow) in one block, mostly to one address
//   drainer        one spender collecting unlimited approvals from >= 3 holders and sweeping >= 2 of them in a window
//   taint          funds leaving a flagged attacker/drainer to a fresh address (severity 2: a warning, never a block)
//   sol-drainer    Solana: one delegate / new owner taking SPL token accounts of >= 3 owners in a window
//   wasm-clone     Osmosis/CosmWasm: an instantiated code whose checksum matches a shared vaccine
//   authz-drainer  Cosmos: one grantee getting send grants from >= 3 granters in a window
// Thresholds are conservative on purpose: a false flag costs the runners who agree to it their bond (NeuroJobs).
import { keccak_256 } from '@noble/hashes/sha3.js';
import { toHex } from './evidence.js';
import { matchVaccine } from './vaccines.js';

const enc = new TextEncoder();
export const topic = (sig) => toHex(keccak_256(enc.encode(sig)));
export const TOPICS = {
  transfer: topic('Transfer(address,address,uint256)'),
  approval: topic('Approval(address,address,uint256)'),
  approvalForAll: topic('ApprovalForAll(address,address,bool)'),
  sync: topic('Sync(uint112,uint112)'),
  swap: topic('Swap(address,uint256,uint256,uint256,uint256,address)'),
};
/** Flash-loan events of the big lenders: Aave v3, Aave v2, Balancer vault, Uniswap v3 pools. */
export const FLASH_TOPICS = {
  [topic('FlashLoan(address,address,address,uint256,uint8,uint256,uint16)')]: 'aave-v3',
  [topic('FlashLoan(address,address,address,uint256,uint256,uint16)')]: 'aave-v2',
  [topic('FlashLoan(address,address,uint256,uint256)')]: 'balancer',
  [topic('Flash(address,address,uint256,uint256,uint256,uint256)')]: 'uniswap-v3',
};

export const KIND = { exploit: 1, attacker: 2, drainer: 3, spender: 4, clone: 5, compromised: 6 };
export const SEVERITY = { info: 1, suspicious: 2, high: 3, critical: 4 };
export const TTL = { exploit: 90 * 86400, attacker: 90 * 86400, drainer: 180 * 86400, clone: 90 * 86400, linked: 30 * 86400 };
export const UNLIMITED = (1n << 96n) - 1n;

const lower = (a) => String(a ?? '').toLowerCase();
const addrOfTopic = (t) => '0x' + lower(t).slice(-40);
const word = (data, i) => BigInt('0x' + (lower(data).replace(/^0x/, '').slice(64 * i, 64 * (i + 1)) || '0'));
/** A 20-byte address or 32-byte account as the bytes32 subject the registry takes. */
export const subjectOf = (hex) => '0x' + lower(hex).replace(/^0x/, '').padStart(64, '0');
const isEoaCode = (code) => code == null || code === '0x' || code === '0x0';

function finding(detector, chainId, { address, kind, severity, everyChain = false, codeHash = null, label, ttl }) {
  return { detector, chainId: Number(chainId), address: lower(address), subject: subjectOf(address), kind, severity, everyChain: !!everyChain,
    codeHash: codeHash ? lower(codeHash) : '0x' + '00'.repeat(32), label, ttl };
}

// ---------------------------------------------------------------- clone (vaccine match on a new contract)

/** Pure: does `code` at `address` match the vaccine? -> [finding] */
export function cloneVerdict({ chainId, address, code, codeHash, vaccine }) {
  const m = matchVaccine(vaccine, code);
  if (!m.match) return [];
  const severity = m.how === 'exact' || m.how === 'fingerprint' ? SEVERITY.critical : SEVERITY.high;
  return [{ ...finding('clone', chainId, { address, kind: KIND.clone, severity, codeHash, label: `${m.how} match (${m.score}%) of vaccine ${vaccine.id.slice(0, 18)}: ${vaccine.label}`, ttl: TTL.clone }),
    vaccineId: vaccine.id, match: m }];
}

// ---------------------------------------------------------------- flash loan + price manipulation (one tx)

/** Reserves of a Uniswap-v2 style Sync as a price (reserve1 * 1e18 / reserve0); null on a zero reserve. */
const priceOf = (data) => { const r0 = word(data, 0); const r1 = word(data, 1); return r0 === 0n ? null : (r1 * 10n ** 18n) / r0; };

/**
 * Pure: one transaction's receipt logs -> findings (the calling contract: exploit; the sender: attacker on every
 * EVM chain). inputs: { chainId, tx: {hash, from, to}, logs, toCode, minSwingBps }.
 */
export function flashLoanVerdict({ chainId, tx, logs, toCode = null, toCodeHash = null, minSwingBps = 2500 }) {
  const flash = logs.find((l) => FLASH_TOPICS[lower(l.topics?.[0])]);
  if (!flash) return [];
  const pools = new Map();
  for (const l of logs) if (lower(l.topics?.[0]) === TOPICS.sync) { const p = priceOf(l.data); if (p != null) (pools.get(lower(l.address)) ?? pools.set(lower(l.address), []).get(lower(l.address))).push(p); }
  let worst = null;
  for (const [pool, ps] of pools) {
    if (ps.length < 2) continue;
    let lo = ps[0]; let hi = ps[0];
    for (const p of ps) { if (p < lo) lo = p; if (p > hi) hi = p; }
    const swingBps = lo === 0n ? 0n : ((hi - lo) * 10_000n) / lo;
    if (swingBps >= BigInt(minSwingBps) && (!worst || swingBps > worst.swingBps)) worst = { pool, swingBps };
  }
  if (!worst) return [];
  // profit: a token that ends up with the caller (tx.from or tx.to) on net
  const me = new Set([lower(tx.from), lower(tx.to)]);
  const net = new Map();
  for (const l of logs) {
    if (lower(l.topics?.[0]) !== TOPICS.transfer || (l.topics?.length ?? 0) < 3) continue;
    const from = addrOfTopic(l.topics[1]); const to = addrOfTopic(l.topics[2]); const v = word(l.data, 0);
    const t = lower(l.address);
    if (me.has(to) && !me.has(from)) net.set(t, (net.get(t) ?? 0n) + v);
    if (me.has(from) && !me.has(to)) net.set(t, (net.get(t) ?? 0n) - v);
  }
  const profit = [...net.entries()].filter(([, v]) => v > 0n);
  if (!profit.length) return [];
  const label = `flash loan (${FLASH_TOPICS[lower(flash.topics[0])]}) + price swing ${Number(worst.swingBps) / 100}% on ${worst.pool} + profit in ${profit.length} token(s), tx ${tx.hash}`;
  const out = [];
  if (tx.to && !isEoaCode(toCode)) out.push(finding('flashloan', chainId, { address: tx.to, kind: KIND.exploit, severity: SEVERITY.critical, codeHash: toCodeHash, label, ttl: TTL.exploit }));
  out.push(finding('flashloan', chainId, { address: tx.from, kind: KIND.attacker, severity: SEVERITY.critical, everyChain: true, label, ttl: TTL.attacker }));
  return out;
}

// ---------------------------------------------------------------- abnormal outflow from a known protocol

/**
 * Pure: one block's outgoing transfers of a watched protocol vs its baseline and value.
 * inputs: { chainId, protocol: {address, name}, transfers: [{token, to, value, tx}], baseline: {token: avg}, tvl: {token: amount},
 *           recipientCode: {addr: code}, mult, floorBps }
 * Abnormal when, for some token, outflow >= max(mult x baseline, floorBps of tvl) and one recipient got >= half of it.
 */
export function outflowVerdict({ chainId, protocol, transfers, baseline = {}, tvl = {}, recipientCode = {}, mult = 8, floorBps = 1000 }) {
  const byToken = new Map();
  for (const t of transfers) {
    const k = lower(t.token);
    const e = byToken.get(k) ?? { total: 0n, to: new Map(), txs: new Map() };
    const v = BigInt(t.value);
    e.total += v;
    e.to.set(lower(t.to), (e.to.get(lower(t.to)) ?? 0n) + v);
    e.txs.set(lower(t.to), t.tx);
    byToken.set(k, e);
  }
  const out = [];
  for (const [token, e] of byToken) {
    const base = BigInt(baseline[token] ?? 0);
    const value = BigInt(tvl[token] ?? 0);
    const floor = (value * BigInt(floorBps)) / 10_000n;
    const limit = base * BigInt(mult) > floor ? base * BigInt(mult) : floor;
    if (value === 0n || e.total < limit || e.total === 0n) continue;
    const [top, got] = [...e.to.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))[0];
    if (got * 2n < e.total) continue;
    const share = Number((e.total * 10_000n) / value) / 100;
    const label = `${protocol.name ?? protocol.address} lost ${share}% of its ${token} in one block (usual ${base}), ${Number((got * 100n) / e.total)}% to ${top}`;
    const code = recipientCode[top];
    out.push(finding('outflow', chainId, { address: top, kind: isEoaCode(code) ? KIND.attacker : KIND.exploit, severity: SEVERITY.critical, everyChain: isEoaCode(code), label, ttl: TTL.attacker }));
  }
  return out;
}

/** Collector: per protocol and token, an exponential average of outgoing transfers per block (alpha 1/8). */
export class OutflowMonitor {
  constructor({ chainId, protocols = [], mult = 8, floorBps = 1000 }) {
    this.chainId = chainId; this.mult = mult; this.floorBps = floorBps;
    this.protocols = new Map(protocols.map((p) => [lower(p.address), { ...p, address: lower(p.address), tvl: Object.fromEntries(Object.entries(p.tvl ?? {}).map(([k, v]) => [lower(k), String(v)])) }]));
    this.avg = {}; // protocol -> token -> avg (decimal string)
  }
  /** One block's receipts -> [{ findings, inputs }]; updates the averages after judging the block. */
  block(receipts, codeOf = () => null) {
    const per = new Map();
    for (const r of receipts) for (const l of r.logs ?? []) {
      if (lower(l.topics?.[0]) !== TOPICS.transfer || (l.topics?.length ?? 0) < 3) continue;
      const from = addrOfTopic(l.topics[1]);
      if (!this.protocols.has(from)) continue;
      (per.get(from) ?? per.set(from, []).get(from)).push({ token: lower(l.address), to: addrOfTopic(l.topics[2]), value: word(l.data, 0).toString(), tx: r.transactionHash });
    }
    const results = [];
    for (const [addr, p] of this.protocols) {
      const transfers = per.get(addr) ?? [];
      const avg = (this.avg[addr] ??= {});
      if (transfers.length) {
        const recipientCode = {};
        for (const t of transfers) recipientCode[t.to] = codeOf(t.to) ?? '0x';
        const inputs = { chainId: this.chainId, protocol: { address: addr, name: p.name }, transfers, baseline: { ...avg }, tvl: p.tvl, recipientCode, mult: this.mult, floorBps: this.floorBps };
        const findings = outflowVerdict(inputs);
        if (findings.length) results.push({ findings, inputs });
      }
      // update the averages (every block counts, quiet blocks pull them down)
      const sums = {};
      for (const t of transfers) sums[t.token] = (sums[t.token] ?? 0n) + BigInt(t.value);
      for (const tok of new Set([...Object.keys(avg), ...Object.keys(sums)])) {
        const a = BigInt(avg[tok] ?? 0); const x = sums[tok] ?? 0n;
        avg[tok] = (a + (x - a) / 8n).toString();
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------- drainer approvals

/**
 * Pure: inputs { chainId, spender, approvals: [{owner, token, value|approved, block}], sweeps: [{owner, token, to, value, tx}],
 *                spenderCode, allowlist, minVictims, minSweeps }
 */
export function drainerVerdict({ chainId, spender, approvals, sweeps, spenderCode = '0x', spenderCodeHash = null, allowlist = [], minVictims = 3, minSweeps = 2 }) {
  if (allowlist.map(lower).includes(lower(spender))) return [];
  const owners = new Set(approvals.filter((a) => a.approved === true || (a.value != null && BigInt(a.value) >= UNLIMITED)).map((a) => lower(a.owner)));
  const swept = new Set(sweeps.filter((s) => owners.has(lower(s.owner))).map((s) => lower(s.owner)));
  if (owners.size < minVictims || swept.size < minSweeps) return [];
  const label = `${owners.size} holders gave ${spender} unlimited approvals; ${swept.size} were swept within the window`;
  const eoa = isEoaCode(spenderCode);
  const out = [finding('drainer', chainId, { address: spender, kind: KIND.drainer, severity: SEVERITY.critical, everyChain: eoa, codeHash: eoa ? null : spenderCodeHash, label, ttl: TTL.drainer })];
  const dests = new Map();
  for (const s of sweeps) if (owners.has(lower(s.owner)) && lower(s.to) !== lower(spender)) dests.set(lower(s.to), (dests.get(lower(s.to)) ?? 0) + 1);
  for (const [to, n] of dests) if (n >= minSweeps) out.push(finding('drainer', chainId, { address: to, kind: KIND.drainer, severity: SEVERITY.critical, everyChain: true, label: `receives the sweeps of ${spender}`, ttl: TTL.drainer }));
  return out;
}

/** Collector: unlimited approvals and the transfers out of approving holders, over the last `window` blocks. */
export class DrainerMonitor {
  constructor({ chainId, window = 300, allowlist = [], minVictims = 3, minSweeps = 2 }) {
    Object.assign(this, { chainId, window, allowlist: allowlist.map(lower), minVictims, minSweeps });
    this.approvals = []; // {spender, owner, token, value|approved, block}
    this.sweeps = [];    // {owner, token, to, value, tx, by, block}
    this.reported = new Set();
  }
  block(number, txs, receipts, codeOf = () => null, codeHashOf = () => null) {
    const n = Number(number);
    const txBy = new Map(txs.map((t) => [lower(t.hash), t]));
    for (const r of receipts) {
      const tx = txBy.get(lower(r.transactionHash)) ?? { from: r.from, to: r.to };
      for (const l of r.logs ?? []) {
        const t0 = lower(l.topics?.[0]);
        if (t0 === TOPICS.approval && l.topics.length === 3) {
          const v = word(l.data, 0);
          if (v >= UNLIMITED) this.approvals.push({ spender: addrOfTopic(l.topics[2]), owner: addrOfTopic(l.topics[1]), token: lower(l.address), value: v.toString(), block: n });
        } else if (t0 === TOPICS.approvalForAll && l.topics.length === 3) {
          if (word(l.data, 0) === 1n) this.approvals.push({ spender: addrOfTopic(l.topics[2]), owner: addrOfTopic(l.topics[1]), token: lower(l.address), approved: true, block: n });
        } else if (t0 === TOPICS.transfer && l.topics.length >= 3) {
          const from = addrOfTopic(l.topics[1]);
          // moved by someone other than the holder: a transferFrom (the caller or the contract it called)
          if (lower(tx.from) !== from) this.sweeps.push({ owner: from, token: lower(l.address), to: addrOfTopic(l.topics[2]), value: (l.topics.length === 4 ? 1n : word(l.data, 0)).toString(), tx: r.transactionHash, by: [lower(tx.from), lower(tx.to)], block: n });
        }
      }
    }
    this.approvals = this.approvals.filter((a) => a.block > n - this.window);
    this.sweeps = this.sweeps.filter((s) => s.block > n - this.window);
    const results = [];
    for (const spender of new Set(this.approvals.map((a) => a.spender))) {
      if (this.reported.has(spender)) continue;
      const approvals = this.approvals.filter((a) => a.spender === spender);
      const owners = new Set(approvals.map((a) => a.owner));
      const sweeps = this.sweeps.filter((s) => owners.has(s.owner) && approvals.some((a) => a.owner === s.owner && a.token === s.token) && s.by.includes(spender))
        .map(({ by: _b, ...s }) => s);
      const spenderCode = codeOf(spender) ?? '0x';
      const inputs = { chainId: this.chainId, spender, approvals, sweeps, spenderCode, spenderCodeHash: isEoaCode(spenderCode) ? null : codeHashOf(spender), allowlist: this.allowlist, minVictims: this.minVictims, minSweeps: this.minSweeps };
      const findings = drainerVerdict(inputs);
      if (findings.length) { this.reported.add(spender); results.push({ findings, inputs }); }
    }
    return results;
  }
}

// ---------------------------------------------------------------- taint: funds leaving a flagged address

/** Pure: inputs { chainId, flagged: {address, severity, kind}, transfer: {to, value, token|null, tx}, toCode, minValue } */
export function taintVerdict({ chainId, flagged, transfer, toCode = '0x', minValue = '0' }) {
  if (!flagged || flagged.severity < SEVERITY.high || ![KIND.attacker, KIND.drainer].includes(flagged.kind)) return [];
  if (BigInt(transfer.value) < BigInt(minValue) || !isEoaCode(toCode)) return [];
  return [finding('taint', chainId, { address: transfer.to, kind: KIND.attacker, severity: SEVERITY.suspicious, everyChain: true,
    label: `received ${transfer.value} ${transfer.token ?? 'native'} from flagged ${flagged.address} (tx ${transfer.tx})`, ttl: TTL.linked })];
}

// ---------------------------------------------------------------- Solana

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** base58 (Solana account) -> 0x hex of its bytes. */
export function base58Hex(s) {
  let n = 0n;
  for (const ch of String(s)) { const i = B58.indexOf(ch); if (i < 0) throw new Error('not base58'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const zeros = (String(s).match(/^1*/)?.[0].length) ?? 0;
  return '0x' + '00'.repeat(zeros) + (n === 0n ? '' : hex);
}

/** Pure: inputs { chainId, actor, grants: [{owner, account, kind ('approve'|'owner'), slot, sig}], minVictims } */
export function solDrainerVerdict({ chainId, actor, grants, minVictims = 3 }) {
  const owners = new Set(grants.map((g) => g.owner));
  if (owners.size < minVictims) return [];
  const f = finding('sol-drainer', chainId, { address: base58Hex(actor), kind: KIND.drainer, severity: SEVERITY.critical,
    label: `${owners.size} owners handed SPL token accounts to ${actor} (${[...new Set(grants.map((g) => g.kind))].join('+')})`, ttl: TTL.drainer });
  f.display = actor;
  return [f];
}

/** Collector over Solana blocks (getBlock, jsonParsed): spl-token approve / setAuthority(accountOwner). */
export class SolanaDrainerMonitor {
  constructor({ chainId, window = 1500, minVictims = 3, allowlist = [] }) { Object.assign(this, { chainId, window, minVictims, allowlist: new Set(allowlist) }); this.grants = []; this.reported = new Set(); }
  block(slot, block) {
    for (const tx of block?.transactions ?? []) {
      if (tx.meta?.err) continue;
      const ixs = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions ?? [])];
      for (const ix of ixs) {
        if (ix.program !== 'spl-token' || !ix.parsed) continue;
        const { type, info } = ix.parsed;
        if ((type === 'approve' || type === 'approveChecked') && info?.delegate) this.grants.push({ actor: info.delegate, owner: info.owner, account: info.source, kind: 'approve', slot, sig: tx.transaction.signatures?.[0] });
        if (type === 'setAuthority' && info?.authorityType === 'accountOwner' && info.newAuthority) this.grants.push({ actor: info.newAuthority, owner: info.authority ?? info.multisigAuthority, account: info.account, kind: 'owner', slot, sig: tx.transaction.signatures?.[0] });
      }
    }
    this.grants = this.grants.filter((g) => g.slot > slot - this.window);
    const out = [];
    for (const actor of new Set(this.grants.map((g) => g.actor))) {
      if (this.reported.has(actor) || this.allowlist.has(actor)) continue;
      const inputs = { chainId: this.chainId, actor, grants: this.grants.filter((g) => g.actor === actor), minVictims: this.minVictims };
      const findings = solDrainerVerdict(inputs);
      if (findings.length) { this.reported.add(actor); out.push({ findings, inputs }); }
    }
    return out;
  }
}

// ---------------------------------------------------------------- Cosmos / CosmWasm (Osmosis)

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]; }
  return chk;
}
/** bech32 account (any prefix, 20 or 32 bytes) -> 0x hex of its bytes; throws on a bad checksum. */
export function bech32Hex(addr) {
  const s = String(addr).toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw new Error('not bech32');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) throw new Error('not bech32');
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (polymod([...exp, ...data]) !== 1) throw new Error('bech32 checksum');
  let acc = 0; let bits = 0; const out = [];
  for (const v of data.slice(0, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  if (out.length !== 20 && out.length !== 32) throw new Error('not an account');
  return toHex(Uint8Array.from(out));
}

/** Pure: inputs { chainId, contract, codeId, checksum, vaccine } */
export function wasmCloneVerdict({ chainId, contract, checksum, vaccine }) {
  const m = matchVaccine(vaccine, checksum);
  if (!m.match) return [];
  const f = finding('wasm-clone', chainId, { address: bech32Hex(contract), kind: KIND.clone, severity: SEVERITY.critical, label: `CosmWasm code checksum ${checksum.slice(0, 16)}… matches vaccine ${vaccine.id.slice(0, 18)}: ${vaccine.label}`, ttl: TTL.clone });
  f.display = contract;
  return [f];
}

/** Pure: inputs { chainId, grantee, grants: [{granter, msg, height, tx}], minVictims } (authz send grants). */
export function authzDrainerVerdict({ chainId, grantee, grants, minVictims = 3 }) {
  const granters = new Set(grants.filter((g) => /MsgSend|SendAuthorization|MsgExec/.test(g.msg)).map((g) => g.granter));
  if (granters.size < minVictims) return [];
  const f = finding('authz-drainer', chainId, { address: bech32Hex(grantee), kind: KIND.drainer, severity: SEVERITY.critical, label: `${granters.size} accounts granted ${grantee} authz to send their funds`, ttl: TTL.drainer });
  f.display = grantee;
  return [f];
}

// ---------------------------------------------------------------- re-verification (runners)

const VERDICTS = { clone: cloneVerdict, flashloan: flashLoanVerdict, outflow: outflowVerdict, drainer: drainerVerdict, taint: taintVerdict,
  'sol-drainer': solDrainerVerdict, 'wasm-clone': wasmCloneVerdict, 'authz-drainer': authzDrainerVerdict };

/** Revives a bundle's inputs (JSON) for a verdict: a vaccine referenced by id comes from `vaccines` (a VaccineSet / Map). */
function revive(detector, inputs, vaccines) {
  if ((detector === 'clone' || detector === 'wasm-clone') && typeof inputs.vaccine === 'string') {
    const v = vaccines?.byId?.get?.(inputs.vaccine) ?? vaccines?.get?.(inputs.vaccine);
    if (!v) throw new Error(`vaccine ${inputs.vaccine} not known to this runner`);
    return { ...inputs, vaccine: v };
  }
  return inputs;
}

/**
 * A runner's independent check: re-runs the bundle's detector on its inputs and looks for the claimed finding
 * (same subject, kind, severity, every-chain scope, code hash). Returns { ok, reason }.
 */
export function reverify(bundle, claimed, { vaccines = null } = {}) {
  const fn = VERDICTS[bundle?.detector];
  if (!fn) return { ok: false, reason: `unknown detector ${bundle?.detector}` };
  let got;
  try { got = fn(revive(bundle.detector, bundle.inputs, vaccines)); } catch (e) { return { ok: false, reason: String(e.message).slice(0, 120) }; }
  const same = got.find((f) => f.subject === lower(claimed.subject) && f.kind === Number(claimed.kind) && f.severity === Number(claimed.severity)
    && f.everyChain === !!claimed.everyChain && lower(f.codeHash) === lower(claimed.codeHash) && f.chainId === Number(claimed.chainId));
  return same ? { ok: true, reason: null } : { ok: false, reason: 'the detector does not reproduce this finding from the evidence' };
}
