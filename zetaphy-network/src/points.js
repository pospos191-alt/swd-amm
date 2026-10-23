// BZTPHY testnet reward points: who earned how much in one epoch (one UTC day), and the
// mainnet conversion. Pure functions; scripts/points.js does the network calls.
//
// Validators: paid by the minute. Each minute of the UTC day one block is checked (1,440 a day);
//   a validator earns validatorDaily x (minutes whose block it signed) / 1440. Joining at noon and
//   staying online earns about half; so does stopping at noon. No minimum.
// Runners: perJob for each Neuro job they revealed a verdict for that day, at most jobCapDaily.
// Mainnet: each holder gets pool x balance / totalSupply ZETAPHY at the freeze (pro rata), so
//   the promise never exceeds the pool however many points were awarded.
import { sha256 } from '@noble/hashes/sha2.js';
import { fromBech32, toChecksumHex } from './pqtx.js';

export const ZETA = 10n ** 18n;
export const DAY = 86400;

export const DEFAULTS = {
  validatorDaily: 100n * ZETA,
  minutesPerDay: 1440,
  perJob: 2n * ZETA,
  jobCapDaily: 50n * ZETA,
  excludeMonikers: ['zetaphy-validator-0'], // the founding node: the team has its own allocation
  excludeAddresses: [],
};

/** UTC day number of a unix time; epoch e covers [e*86400, (e+1)*86400). */
export const epochOf = (unix) => Math.floor(Number(unix) / DAY);

/** The EVM address (0x…) of a validator operator (zetaphyvaloper1…): the same 20 bytes as its account. */
export function operatorEvm(valoper) {
  return toChecksumHex(fromBech32(valoper, 'zetaphyvaloper'));
}

/** valcons bytes of a consensus pubkey ({"@type": …ed25519.PubKey, key: base64}). */
function consBytes(pk) {
  return sha256(Buffer.from(pk.key, 'base64')).slice(0, 20);
}

const hex = (b) => Buffer.from(b).toString('hex');

/** Consensus address (hex, upper case, as CometBFT commits show it) of a validator. */
export function consAddress(v) {
  return hex(consBytes(v.consensus_pubkey)).toUpperCase();
}

/** Signers of one commit: GET <comet>/commit?height=h → result.signed_header.commit.signatures. */
export function commitSigners(signatures) {
  return new Set((signatures || []).filter((s) => Number(s.block_id_flag) === 2 && s.validator_address).map((s) => String(s.validator_address).toUpperCase()));
}

/** The block checked for each minute of a day whose blocks are from..to (spread evenly). */
export function minuteHeights(from, to, minutes = DEFAULTS.minutesPerDay) {
  const n = to - from + 1;
  return Array.from({ length: minutes }, (_, i) => from + Math.floor((i * n) / minutes));
}

/**
 * @param validators GET /cosmos/staking/v1beta1/validators (every status: one that left during the day
 *                   still earns its minutes) → .validators
 * @param minutes    one Set of signer addresses per checked minute (commitSigners), normally 1,440
 */
export function validatorAwards(validators, minutes, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const excluded = new Set(c.excludeAddresses.map((a) => a.toLowerCase()));
  const per = BigInt(c.minutesPerDay);
  const out = [];
  for (const v of validators) {
    if (c.excludeMonikers.includes(v.description?.moniker)) continue;
    const to = operatorEvm(v.operator_address);
    if (excluded.has(to.toLowerCase())) continue;
    const addr = consAddress(v);
    const signed = minutes.reduce((n, set) => n + (set.has(addr) ? 1 : 0), 0);
    if (!signed) continue;
    out.push({ to, amount: (c.validatorDaily * BigInt(signed)) / per, why: `validator ${v.description?.moniker ?? ''} ${signed}/${c.minutesPerDay} min` });
  }
  return out;
}

/** @param reveals [{ worker: '0x…' }] from NeuroJobs Revealed events in the epoch's blocks */
export function runnerAwards(reveals, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const excluded = new Set(c.excludeAddresses.map((a) => a.toLowerCase()));
  const n = new Map();
  for (const r of reveals) {
    const k = r.worker.toLowerCase();
    if (!excluded.has(k)) n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n].map(([k, jobs]) => {
    const amount = BigInt(jobs) * c.perJob;
    return { to: toChecksumHex(Buffer.from(k.slice(2), 'hex')), amount: amount > c.jobCapDaily ? c.jobCapDaily : amount, why: `runner ${jobs} jobs` };
  });
}

/** One award per address per epoch (the contract refuses a second): sums an address's parts. */
export function mergeAwards(...lists) {
  const m = new Map();
  for (const a of lists.flat()) {
    const k = a.to.toLowerCase();
    const prev = m.get(k);
    m.set(k, prev ? { to: prev.to, amount: prev.amount + a.amount, why: `${prev.why}; ${a.why}` } : { ...a });
  }
  return [...m.values()].filter((a) => a.amount > 0n).sort((x, y) => x.to.toLowerCase().localeCompare(y.to.toLowerCase()));
}

/**
 * Keeps one day's awards within what the contract still allows that day (its epochCap minus what it
 * already awarded): when more people earned more than that, everyone's award shrinks by the same
 * share (rounded down) instead of the contract refusing the whole day.
 */
export function fitCap(awards, room) {
  const total = awards.reduce((s, a) => s + a.amount, 0n);
  if (total <= room) return awards;
  if (room <= 0n) return [];
  return awards.map((a) => ({ ...a, amount: (a.amount * room) / total, why: `${a.why} (scaled to the daily cap)` })).filter((a) => a.amount > 0n);
}

/** Mainnet genesis amounts: pool x balance / total, rounded down; the dust stays in the pool. */
export function proRata(balances, pool) {
  const total = [...balances.values()].reduce((s, b) => s + b, 0n);
  if (total === 0n) return [];
  return [...balances].filter(([, b]) => b > 0n).map(([to, b]) => ({ to, points: b, zetaphy: (pool * b) / total }))
    .sort((x, y) => (y.points > x.points ? 1 : y.points < x.points ? -1 : 0));
}

/** Balances from the contract's Transfer events ({from, to, value}, in order). */
export function balancesFromTransfers(transfers) {
  const b = new Map();
  const zero = '0x0000000000000000000000000000000000000000';
  for (const t of transfers) {
    if (t.from.toLowerCase() !== zero) b.set(t.from, (b.get(t.from) ?? 0n) - t.value);
    if (t.to.toLowerCase() !== zero) b.set(t.to, (b.get(t.to) ?? 0n) + t.value);
  }
  return b;
}
