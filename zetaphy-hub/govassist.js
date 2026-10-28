// Governance assistant (docs/future/crosschain-assist.md, item 21): what each open proposal and each queued timelock
// operation would do, in words, with flags on the changes that need a careful look. Read only:
//   - proposals in deposit or voting (Cosmos REST /cosmos/gov/v1/proposals), their messages decoded;
//   - parameter changes (MsgUpdateParams) compared with the module's current parameters;
//   - EVM calls (zetaphy.pq.v1.MsgEVMCall from the gov module; the timelock's scheduled calls) simulated with eth_call
//     against the current state, from the address that will make them (the gov module, the timelock);
//   - the ZetaphyTimelock's queue: CallScheduled events not yet executed or cancelled.
// The flags are rules (below), not a verdict: the page says "check" and why, never "vote yes/no".
import { toEvm } from './chainlib.js';
import { revertReason } from './presign.js';

/** keccak256 selectors (checked in test/assist.test.mjs) -> [name, risk]. risk: 'high' | 'medium' | 'info'. */
export const EVM_SELECTORS = {
  '0xab033ea9': ['setGovernance(address)', 'high'],
  '0xf2fde38b': ['transferOwnership(address)', 'high'],
  '0x3659cfe6': ['upgradeTo(address)', 'high'],
  '0x4f1ef286': ['upgradeToAndCall(address,bytes)', 'high'],
  '0x2f2ff15d': ['grantRole(bytes32,address)', 'high'],
  '0xd547741f': ['revokeRole(bytes32,address)', 'medium'],
  '0x238efcbc': ['acceptGovernance()', 'medium'],
  '0x2e779beb': ['setIsm(address)', 'high'],
  '0x8a0dac4a': ['setGuardian(address)', 'medium'],
  '0x2b8a1c5a': ['setGuardian(address,bool)', 'medium'],
  '0x8456cb59': ['pause()', 'info'],
  '0x3f4ba83a': ['unpause()', 'medium'],
  '0xb20d30a9': ['setDailyLimit(uint256)', 'medium'],
  '0x64d62353': ['updateDelay(uint256)', 'high'],
  '0xbd54a931': ['setProtected(bytes32[],bool)', 'medium'],
  '0xc5da919a': ['setEnforceDelay(uint64)', 'medium'],
  '0xdcad4460': ['setActiveSkill(bytes32)', 'high'],
  '0x53c91c08': ['approveSkill(bytes32)', 'medium'],
  '0xa9059cbb': ['transfer(address,uint256)', 'medium'],
  '0x095ea7b3': ['approve(address,uint256)', 'medium'],
  '0x5c0204d9': ['setAttester(address,bool)', 'medium'],
  '0xeb929ad5': ['revoke(uint256,string)', 'info'],
  '0x2f4c65ca': ['setReceiver(uint32,bytes32)', 'high'],
  '0x0be2f8f9': ['setTarget(bytes32,bool,uint128)', 'medium'],
};

/**
 * Parameter rules: [module, field, test(old, new) -> true when the change needs a careful look, why-key].
 * Durations are Go strings ("1814400s"), fractions decimal strings, amounts integer strings.
 */
const secs = (v) => (typeof v === 'string' && /^\d+(\.\d+)?s$/.test(v) ? parseFloat(v) : Number(v));
const num = (v) => Number(v);
const lower = (a, b) => num(b) < num(a);
const higher = (a, b) => num(b) > num(a);
export const PARAM_RULES = [
  ['gov', 'voting_period', (a, b) => secs(b) < secs(a) / 2 || secs(b) < 86400, 'shorterVote'],
  ['gov', 'expedited_voting_period', (a, b) => secs(b) < secs(a) / 2, 'shorterVote'],
  ['gov', 'quorum', lower, 'lowerQuorum'],
  ['gov', 'threshold', lower, 'lowerQuorum'],
  ['gov', 'veto_threshold', higher, 'lowerQuorum'],
  ['gov', 'min_deposit', (a, b) => BigInt(b?.[0]?.amount ?? 0) < BigInt(a?.[0]?.amount ?? 0) / 2n, 'cheaperProposals'],
  ['staking', 'unbonding_time', (a, b) => secs(b) < secs(a) / 2, 'shorterUnbonding'],
  ['staking', 'max_validators', (a, b) => num(b) < num(a), 'fewerValidators'],
  ['staking', 'bond_denom', (a, b) => a !== b, 'denomChange'],
  ['slashing', 'slash_fraction_double_sign', higher, 'harsherSlashing'],
  ['slashing', 'slash_fraction_downtime', higher, 'harsherSlashing'],
  ['slashing', 'min_signed_per_window', higher, 'harsherSlashing'],
  ['slashing', 'signed_blocks_window', lower, 'harsherSlashing'],
  ['slashing', 'downtime_jail_duration', higher, 'harsherSlashing'],
  ['mint', 'inflation_max', higher, 'moreInflation'],
  ['mint', 'inflation_min', higher, 'moreInflation'],
  ['mint', 'inflation_rate_change', higher, 'moreInflation'],
  ['distribution', 'community_tax', higher, 'moreTax'],
  ['bank', 'default_send_enabled', (a, b) => a === true && b === false, 'transfersOff'],
  ['evm', 'active_static_precompiles', (a, b) => Array.isArray(a) && Array.isArray(b) && a.some((x) => !b.includes(x)), 'precompileOff'],
  ['evm', 'access_control', (a, b) => JSON.stringify(a) !== JSON.stringify(b), 'evmAccess'],
  ['erc20', 'enable_erc20', (a, b) => a === true && b === false, 'transfersOff'],
  ['feemarket', 'no_base_fee', (a, b) => a === false && b === true, 'feeOff'],
];
const MODULE_REST = { gov: 'cosmos/gov/v1/params/tallying', staking: 'cosmos/staking/v1beta1/params', slashing: 'cosmos/slashing/v1beta1/params', mint: 'cosmos/mint/v1beta1/params',
  distribution: 'cosmos/distribution/v1beta1/params', bank: 'cosmos/bank/v1beta1/params', evm: 'cosmos/evm/vm/v1/params', erc20: 'cosmos/evm/erc20/v1/params', feemarket: 'cosmos/evm/feemarket/v1/params' };

/** The module a MsgUpdateParams type belongs to ("/cosmos.staking.v1beta1.MsgUpdateParams" -> "staking"). */
export function moduleOf(type) {
  const m = /^\/(?:cosmos\.)?(?:evm\.)?([a-z]+)\.(?:vm\.)?v\d+(?:beta\d+)?\.MsgUpdateParams$/.exec(String(type));
  return m ? (m[1] === 'vm' ? 'evm' : m[1]) : null;
}

/** Changed fields of a params object (shallow; nested values compared as JSON): [{ field, from, to, flag? }]. */
export function paramDiff(module, current, proposed) {
  const out = [];
  for (const k of Object.keys(proposed ?? {})) {
    const a = current?.[k], b = proposed[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const rule = PARAM_RULES.find(([m, f]) => m === module && f === k);
    let flag = null;
    try { if (rule && a !== undefined && rule[2](a, b)) flag = rule[3]; } catch { flag = rule[3]; }
    out.push({ field: k, from: a, to: b, flag });
  }
  return out;
}

/** An EVM call's selector in words, with its risk. */
export function describeCall(data) {
  const sel = String(data ?? '').slice(0, 10).toLowerCase();
  if (sel.length < 10) return { name: 'plain transfer (no call data)', risk: 'info', sel };
  const [name, risk] = EVM_SELECTORS[sel] ?? [`unknown function ${sel}`, 'medium'];
  return { name, risk, sel };
}

const b64hex = (s) => {
  if (typeof s !== 'string') return '0x';
  if (/^0x[0-9a-fA-F]*$/.test(s)) return s.toLowerCase();
  try { return '0x' + Array.from(atob(s), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); } catch { return '0x'; }
};
const toHexAddr = (a) => { if (/^0x[0-9a-fA-F]{40}$/.test(String(a))) return String(a); try { return toEvm(String(a)); } catch { return null; } };

/** One message of a proposal: { type, kind, text?, call?: { from, to, value, data }, module?, params?, flags[] }. */
export function readMessage(m) {
  const type = m?.['@type'] ?? '';
  const flags = [];
  if (moduleOf(type)) return { type, kind: 'params', module: moduleOf(type), params: m.params ?? {}, flags };
  if (/MsgEVMCall$/.test(type)) {
    const to = toHexAddr(m.to ?? m.To ?? '');
    const call = { from: toHexAddr(m.sender ?? m.Sender ?? ''), to, value: BigInt((m.value ?? m.Value) || 0), data: b64hex(m.data ?? m.Data) };
    const d = describeCall(call.data);
    if (!to) flags.push('creates');
    if (d.risk === 'high') flags.push('highRisk');
    return { type, kind: 'evm', call, fn: d, flags };
  }
  if (/MsgSoftwareUpgrade$/.test(type)) return { type, kind: 'upgrade', text: `${m.plan?.name ?? '?'} at height ${m.plan?.height ?? '?'}`, flags: ['upgrade'] };
  if (/MsgCommunityPoolSpend$/.test(type) || (/MsgSend$/.test(type))) return { type, kind: 'spend', text: `${(m.amount ?? []).map((c) => `${c.amount} ${c.denom}`).join(', ')} → ${m.recipient ?? m.to_address ?? '?'}`, flags: ['spend'] };
  if (/MsgExecLegacyContent$/.test(type)) return { type, kind: 'legacy', text: m.content?.['@type'] ?? '', flags: ['unknown'] };
  return { type, kind: 'other', flags: ['unknown'] };
}

/** Simulates an EVM call with eth_call on the current state: { ok, reason }. send: raw JSON-RPC (presign.js style). */
export async function simulateCall(send, call) {
  if (!call?.to) return { ok: null, reason: 'contract creation: not simulated' };
  const r = await send('eth_call', [{ from: call.from, to: call.to, data: call.data, value: `0x${BigInt(call.value ?? 0).toString(16)}` }, 'latest']).catch((e) => ({ error: { message: e.message } }));
  if (r?.error) return { ok: false, reason: revertReason(r.error.data ?? '') || String(r.error.message).slice(0, 200) };
  return { ok: true, reason: null };
}

/** Every open proposal (deposit or voting period) with its messages read, params compared and EVM calls simulated. */
export async function reviewProposals({ getJson, rest, send }) {
  const out = [];
  for (const status of ['PROPOSAL_STATUS_VOTING_PERIOD', 'PROPOSAL_STATUS_DEPOSIT_PERIOD']) {
    const j = await getJson(`${rest}/cosmos/gov/v1/proposals?proposal_status=${status}&pagination.limit=50`).catch(() => ({ proposals: [] }));
    for (const p of j.proposals ?? []) {
      const msgs = (p.messages ?? []).map(readMessage);
      for (const m of msgs) {
        if (m.kind === 'params') {
          const cur = await getJson(`${rest}/${MODULE_REST[m.module] ?? `cosmos/${m.module}/v1beta1/params`}`).catch(() => null);
          const current = cur?.params ?? cur?.tally_params ?? cur?.tallying_params ?? null;
          m.diff = paramDiff(m.module, current, m.params);
          if (!current) m.flags.push('noCurrent');
          for (const d of m.diff) if (d.flag) m.flags.push(d.flag);
        }
        if (m.kind === 'evm') { m.sim = await simulateCall(send, m.call); if (m.sim.ok === false) m.flags.push('wouldFail'); }
      }
      out.push({ id: p.id, title: String(p.title ?? '').slice(0, 140), summary: String(p.summary ?? '').slice(0, 400), status: status === 'PROPOSAL_STATUS_VOTING_PERIOD' ? 'voting' : 'deposit',
        ends: p.voting_end_time ?? p.deposit_end_time ?? null, expedited: !!p.expedited, messages: msgs, flags: [...new Set(msgs.flatMap((m) => m.flags))] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the ZetaphyTimelock queue
// OpenZeppelin TimelockController 5.x events and views.
export const TOPIC = {
  CallScheduled: '0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca',
  CallExecuted: '0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58',
  Cancelled: '0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70',
};
export const SEL_TIMESTAMP = '0xd45c4435'; // getTimestamp(bytes32)

/** A CallScheduled log -> { id, index, target, value, data, predecessor, delay }. */
export function readScheduled(log) {
  const h = String(log.data).slice(2);
  const w = (i) => h.slice(i * 64, (i + 1) * 64);
  const dataOff = Number(BigInt(`0x${w(2)}`)) / 32;
  const len = Number(BigInt(`0x${w(dataOff)}`));
  return { id: log.topics[1], index: Number(BigInt(log.topics[2])), target: `0x${w(0).slice(24)}`, value: BigInt(`0x${w(1)}`),
    data: `0x${h.slice((dataOff + 1) * 64, (dataOff + 1) * 64 + len * 2)}`, predecessor: `0x${w(3)}`, delay: Number(BigInt(`0x${w(4)}`)) };
}

/** The timelock's pending operations since `fromBlock`, each simulated as the timelock: [{ id, target, fn, sim, readyAt, flags }]. */
export async function reviewTimelock({ send, timelock, fromBlock = 0, now = Math.floor(Date.now() / 1000) }) {
  const logs = await send('eth_getLogs', [{ address: timelock, fromBlock: `0x${Number(fromBlock).toString(16)}`, toBlock: 'latest', topics: [[TOPIC.CallScheduled, TOPIC.CallExecuted, TOPIC.Cancelled]] }]);
  if (logs?.error) throw new Error(logs.error.message);
  const done = new Set();
  const ops = [];
  for (const l of logs.result ?? []) {
    if (l.topics[0] === TOPIC.CallScheduled) ops.push(readScheduled(l));
    else done.add(l.topics[1]);
  }
  const out = [];
  for (const op of ops.filter((o) => !done.has(o.id))) {
    const ts = await send('eth_call', [{ to: timelock, data: SEL_TIMESTAMP + op.id.slice(2) }, 'latest']);
    const readyAt = typeof ts?.result === 'string' ? Number(BigInt(ts.result)) : 0;
    if (readyAt <= 1) continue; // 0: unknown (cancelled), 1: done
    const fn = describeCall(op.data);
    const sim = await simulateCall(send, { from: timelock, to: op.target, value: op.value, data: op.data });
    const flags = [...(fn.risk === 'high' ? ['highRisk'] : []), ...(sim.ok === false ? ['wouldFail'] : []), ...(op.value > 0n ? ['spend'] : [])];
    out.push({ ...op, fn, sim, readyAt, ready: readyAt <= now, flags });
  }
  return out;
}
