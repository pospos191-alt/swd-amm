// BZTPHY testnet reward points: who earned how much in one epoch (one UTC day), and the
// mainnet conversion. Pure functions; scripts/points.js does the network calls.
//
// Validators: a bonded, unjailed validator earns validatorDaily x its uptime (the share of the
//   slashing window's blocks it signed), if the uptime is at least minUptime.
// Runners: perJob for each Neuro job they revealed a verdict for that day, at most jobCapDaily.
// Mainnet: each holder gets pool x balance / totalSupply ZETAPHY at the freeze (pro rata), so
//   the promise never exceeds the pool however many points were awarded.
import { sha256 } from '@noble/hashes/sha2.js';
import { fromBech32, toChecksumHex } from './pqtx.js';

export const ZETA = 10n ** 18n;
export const DAY = 86400;

export const DEFAULTS = {
  validatorDaily: 100n * ZETA,
  minUptime: 0.5,
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

/**
 * @param validators   GET /cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED → .validators
 * @param signingInfos GET /cosmos/slashing/v1beta1/signing_infos → .info
 * @param window       slashing params signed_blocks_window
 */
export function validatorAwards(validators, signingInfos, window, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const missedBy = new Map(signingInfos.map((s) => [hex(fromBech32(s.address, 'zetaphyvalcons')), Number(s.missed_blocks_counter || 0)]));
  const excluded = new Set(c.excludeAddresses.map((a) => a.toLowerCase()));
  const out = [];
  for (const v of validators) {
    if (v.jailed || v.status !== 'BOND_STATUS_BONDED') continue;
    if (c.excludeMonikers.includes(v.description?.moniker)) continue;
    const to = operatorEvm(v.operator_address);
    if (excluded.has(to.toLowerCase())) continue;
    const missed = missedBy.get(hex(consBytes(v.consensus_pubkey)));
    if (missed === undefined) continue; // no signing record yet
    const uptime = Math.max(0, 1 - missed / Number(window));
    if (uptime < c.minUptime) continue;
    const bps = BigInt(Math.floor(uptime * 10000));
    out.push({ to, amount: (c.validatorDaily * bps) / 10000n, why: `validator ${v.description?.moniker ?? ''} uptime ${(uptime * 100).toFixed(2)}%` });
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
