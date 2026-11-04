// Saphan "AI liquidity" (contracts/SaphanLiquidity.sol, docs/SAPHAN-PR6.md item S9): the policy that moves a route's
// daily release limit with the flows it observes. Deterministic: the same flows give the same target on every machine,
// so anyone can check what the rebalancer proposed (the contract stores hint = hash of the input). An LLM may add a
// HINT (up / down / hold, a factor), which the policy bounds to +-20 % and then clamps like everything else; a bad or
// missing hint changes nothing. Whatever comes out, the contract's band [min, max] and step limit bind it again.
import { keccak256, toUtf8Bytes, Interface, getAddress } from 'ethers';

export const DAY = 86400;
export const DEFAULTS = { windowDays: 7, percentile: 0.9, headroom: 1.5, hintMax: 1.2, hintMin: 0.8 };

const canonical = (v) => {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
export const hashInput = (input) => keccak256(toUtf8Bytes(canonical(input)));

/** Released amount per UTC day over the last `windowDays` days before `now` (idle days count as 0), oldest first. */
export function dailyTotals(flows, now, windowDays = DEFAULTS.windowDays) {
  const today = Math.floor(Number(now) / DAY);
  const out = Array(windowDays).fill(0n);
  for (const f of flows) {
    const d = today - Math.floor(Number(f.t) / DAY);
    if (d >= 1 && d <= windowDays) out[windowDays - d] += BigInt(f.amount);
  }
  return out;
}

/** The p-th percentile (nearest rank) of a list of bigints. */
export function percentile(list, p) {
  if (!list.length) return 0n;
  const s = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

/** A hint from an LLM (or anything): { direction: 'up'|'down'|'hold', factor } -> a multiplier in [hintMin, hintMax] x 1000, or 1000. */
export function hintFactor(hint, o = DEFAULTS) {
  if (!hint || typeof hint !== 'object') return 1000n;
  const f = Number(hint.factor);
  if (!Number.isFinite(f) || f <= 0) return 1000n;
  if (hint.direction === 'up') return BigInt(Math.round(Math.min(Math.max(f, 1), o.hintMax) * 1000));
  if (hint.direction === 'down') return BigInt(Math.round(Math.max(Math.min(f, 1), o.hintMin) * 1000));
  return 1000n;
}

/** Parses an LLM's text answer into a hint, or null (the policy then ignores it). Only a JSON object is accepted. */
export function parseHint(text) {
  const m = /\{[^{}]*\}/.exec(String(text ?? ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return ['up', 'down', 'hold'].includes(j.direction) ? { direction: j.direction, factor: Number(j.factor ?? 1) } : null;
  } catch { return null; }
}

/**
 * The next target for one route.
 *   flows    [{ t (unix s), amount (wei) }]: releases observed (ReleaseQueued / Released events)
 *   current  the contract's current target (wei); bounds { min, max, maxStepBps } as on chain; lockboxLimit: the lockbox's dailyLimit now
 *   hint     optional LLM hint (see hintFactor)
 * Returns { target, demand, wanted, hintHash, action: 'propose'|'hold', needsGovernance (target > lockboxLimit), applyDown }.
 */
export function plan({ flows = [], now, current, bounds, lockboxLimit = null, hint = null, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const min = BigInt(bounds.min), max = BigInt(bounds.max), cur = BigInt(current ?? 0);
  const days = dailyTotals(flows, now, o.windowDays);
  const demand = percentile(days, o.percentile);
  let wanted = demand * BigInt(Math.round(o.headroom * 1000)) / 1000n;
  wanted = wanted * hintFactor(hint, o) / 1000n;
  const clamp = (v) => (v < min ? min : v > max ? max : v);
  wanted = clamp(wanted);
  const base = cur === 0n ? max : cur;
  const step = base * BigInt(bounds.maxStepBps) / 10000n;
  let target = wanted > cur ? (wanted - cur > step ? cur + step : wanted) : (cur - wanted > step ? cur - step : wanted);
  target = clamp(target);
  const hintHash = hashInput({ days, now: BigInt(now), current: cur, bounds: { min, max, maxStepBps: BigInt(bounds.maxStepBps) }, hint: hint ?? null, options: o });
  const limit = lockboxLimit == null ? null : BigInt(lockboxLimit);
  return {
    target, demand, wanted, days, hintHash,
    action: target === cur ? 'hold' : 'propose',
    needsGovernance: limit != null && target > limit,
    applyDown: limit != null && target < limit,
  };
}

const LOCKBOX = new Interface(['function setDailyLimit(uint256 v)']);
const TIMELOCK = new Interface(['function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)']);

/** A raise needs the lockbox's governance: the ZetaphyTimelock schedule() call its proposers would submit. */
export function raiseProposal({ lockbox, value, delay = 172800, salt = null }) {
  const data = LOCKBOX.encodeFunctionData('setDailyLimit', [BigInt(value)]);
  const s = salt ?? keccak256(toUtf8Bytes(`saphan-liquidity:${getAddress(lockbox)}:${value}`));
  return { target: getAddress(lockbox), value: 0n, data, salt: s, delay,
    schedule: TIMELOCK.encodeFunctionData('schedule', [getAddress(lockbox), 0n, data, '0x' + '00'.repeat(32), s, BigInt(delay)]) };
}
