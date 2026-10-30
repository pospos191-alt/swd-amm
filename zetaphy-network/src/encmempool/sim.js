// Deterministic MEV simulation for the encrypted mempool: a searcher tries to
// sandwich a victim's swap on a constant-product AMM, (a) with a plaintext
// mempool, (b) with the encrypted lane, using the real crypto of this package
// (X-Wing dealings, Shamir shares, ML-DSA-44 signed releases), under collusion
// and share-withholding scenarios. Used by scripts/encmempool-sim.js and the tests.
//
// Model (deliberately simple, stated so the numbers can be checked by hand):
//   - pool A/B, x*y = k, 0.30% fee taken from the input (Uniswap v2 math, BigInt).
//   - victim swaps A -> B with a minimum output (slippage tolerance).
//   - a searcher who KNOWS the victim's tx buys B before it (front leg) and sells B
//     after it (back leg). It picks the front size that maximises profit while
//     keeping the victim above its minimum output (so the victim does not revert).
//   - the searcher pays `gasCost` (in A) per leg.
//   - with the encrypted lane the front leg can only be placed in block h (or
//     earlier): everything there executes before batch h, which runs at the start
//     of h+1. The back leg goes in h+1 after the batch.

import { makeValidator, publicValidator, selectDealers, defaultThreshold } from './committee.js';
import { createDealing, openDealing, signAck, acceptDealings } from './dealing.js';
import { encryptTx, decodeEnvelope, decryptEnvelope, payerFromSeed } from './envelope.js';
import { createRelease } from './release.js';
import { combine } from './shamir.js';
import { kemPublicKey } from './kem.js';
import { EncryptedLane } from './ordering.js';
import { drbg, utf8, hex } from './util.js';

// ------------------------------------------------------------------ AMM

export class Pool {
  constructor(a, b, feeBps = 30n) { this.a = a; this.b = b; this.feeBps = feeBps; }
  clone() { return new Pool(this.a, this.b, this.feeBps); }
  quote(dir, amountIn) {
    const [rin, rout] = dir === 'AtoB' ? [this.a, this.b] : [this.b, this.a];
    const inFee = amountIn * (10000n - this.feeBps);
    return (inFee * rout) / (rin * 10000n + inFee);
  }
  /** Executes a swap; returns { ok, out }. Reverts (ok false, no state change) below minOut. */
  swap(dir, amountIn, minOut = 0n) {
    const out = this.quote(dir, amountIn);
    if (out < minOut || amountIn <= 0n) return { ok: false, out: 0n };
    if (dir === 'AtoB') { this.a += amountIn; this.b -= out; } else { this.b += amountIn; this.a -= out; }
    return { ok: true, out };
  }
}

export const DEFAULT_MARKET = Object.freeze({
  // A = a dollar stablecoin with 6 decimals, B = an asset at ~2,000 A with 6 decimals
  poolA: 4_000_000n * 10n ** 6n,
  poolB: 2_000n * 10n ** 6n,
  victimIn: 60_000n * 10n ** 6n,
  slippageBps: 100n, // 1%
  gasCost: 2n * 10n ** 6n, // 2 A per searcher tx
  budget: 2_000_000n * 10n ** 6n,
});

export function victimTx(pool, m = DEFAULT_MARKET, nonce = 7) {
  const fair = pool.quote('AtoB', m.victimIn);
  return { from: 'victim', nonce, dir: 'AtoB', amountIn: m.victimIn, minOut: (fair * (10000n - m.slippageBps)) / 10000n };
}

export const encodeSwap = (tx) => utf8(JSON.stringify(tx, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)));
export const decodeSwap = (bytes) =>
  JSON.parse(new TextDecoder().decode(bytes), (_, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

/** Profit of front-running `victim` with `front` A on `pool` (pure; does not touch pool). */
export function sandwichOutcome(pool, victim, front, gasCost) {
  const p = pool.clone();
  const f = p.swap(victim.dir, front);
  if (!f.ok) return null;
  const v = p.swap(victim.dir, victim.amountIn, victim.minOut);
  const back = p.swap(victim.dir === 'AtoB' ? 'BtoA' : 'AtoB', f.out);
  return { victimOk: v.ok, victimOut: v.out, profit: back.out - front - 2n * gasCost };
}

/** Best sandwich for a searcher who knows the victim's tx, or null when unprofitable. */
export function planSandwich(pool, victim, { budget, gasCost }) {
  let lo = 0n, hi = budget; // largest front that keeps the victim above minOut
  for (let i = 0; i < 128 && lo < hi; i++) {
    const mid = (lo + hi + 1n) / 2n;
    const o = sandwichOutcome(pool, victim, mid, gasCost);
    if (o && o.victimOk) lo = mid; else hi = mid - 1n;
  }
  let best = null;
  for (const pct of [100n, 95n, 90n, 75n, 50n, 25n, 10n]) {
    const front = (lo * pct) / 100n;
    if (front <= 0n) continue;
    const o = sandwichOutcome(pool, victim, front, gasCost);
    if (o && o.victimOk && (!best || o.profit > best.profit)) best = { front, ...o };
  }
  return best && best.profit > 0n ? best : null;
}

/**
 * The searcher with NO knowledge of the victim: front-runs a guessed direction with
 * a fixed size, sees the revealed victim, then closes. Averages over `samples`
 * random victims (direction, size and slippage drawn from a seeded stream).
 */
export function blindSandwichEV({ front, samples = 2000, seed = 'blind', m = DEFAULT_MARKET }) {
  const rng = drbg(seed);
  const rnd = (k) => Number(BigInt('0x' + hex(rng(6))) % BigInt(k));
  let total = 0n, wins = 0, reverts = 0, informed = 0n;
  for (let i = 0; i < samples; i++) {
    const pool = new Pool(m.poolA, m.poolB);
    const dir = rnd(2) ? 'AtoB' : 'BtoA';
    const sizeA = BigInt(1_000 + rnd(99_000)) * 10n ** 6n;
    const amountIn = dir === 'AtoB' ? sizeA : (sizeA * m.poolB) / m.poolA;
    const slip = BigInt(30 + rnd(270));
    const fair = pool.quote(dir, amountIn);
    const victim = { dir, amountIn, minOut: (fair * (10000n - slip)) / 10000n };
    // blind: always buy B first (one could randomise; by symmetry it does not help)
    const p = pool.clone();
    const f = p.swap('AtoB', front);
    const v = p.swap(victim.dir, victim.amountIn, victim.minOut);
    if (!v.ok) reverts++;
    const back = p.swap('BtoA', f.out);
    const profit = back.out - front - 2n * m.gasCost;
    total += profit;
    if (profit > 0n) wins++;
    const plan = planSandwich(pool, victim, { budget: m.budget, gasCost: m.gasCost });
    informed += plan ? plan.profit : 0n;
  }
  const n = BigInt(samples);
  return { front, samples, meanProfit: total / n, winRate: wins / samples, victimRevertRate: reverts / samples, informedMeanProfit: informed / n };
}

// ------------------------------------------------------------------ chain setup (shared per n)

const setups = new Map();

/** Committee, dealings, acks and opened shares for one n (cached: the crypto is the slow part). */
export function setupCommittee({ n, t = defaultThreshold(n), d = Math.min(3, n), epochLength = 8, chainId = 'zetaphy_9369-1', seed = 'encmempool-sim' }) {
  const key = JSON.stringify({ n, t, d, epochLength, chainId, seed });
  if (setups.has(key)) return setups.get(key);
  const rng = drbg(`${seed}/n=${n}`);
  const validators = Array.from({ length: n }, (_, i) => makeValidator(i, rng(32), { deterministic: true }));
  const committee = validators.map(publicValidator);
  const dealers = selectDealers(rng(32), 0, n, d);
  const made = dealers.map((i) => createDealing({ chainId, epoch: 0, startHeight: 1n, length: epochLength, t, committee, dealer: validators[i], rng }));
  const opened = validators.map((v) => new Map(made.map(({ dealing }) => {
    const o = openDealing(dealing, v);
    if (!o.ok) throw new Error(o.reason);
    return [dealing.dealer, o.shares];
  })));
  const acks = made.flatMap(({ dealing }) => validators.map((v) => signAck(dealing, v)));
  const dealings = acceptDealings(made.map((x) => x.dealing), acks, committee, { chainId, epoch: 0, t, dealers });
  const keptSeeds = new Map(made.map(({ dealing, seeds }) => [dealing.dealer, seeds]));
  const s = { n, t, d, chainId, epochLength, validators, committee, dealers, dealings, opened, keptSeeds, rng, releaseCache: new Map() };
  setups.set(key, s);
  return s;
}

/** Validators in a coalition of size c: non-dealers first (highest index first), then dealers. */
export function pickCoalition(s, c) {
  const non = s.committee.map((v) => v.index).filter((i) => !s.dealers.includes(i)).reverse();
  return [...non, ...[...s.dealers].reverse()].slice(0, c);
}

/** What a coalition can rebuild for `height` before any release: Map dealer -> seed for the dealers it can open. */
export function coalitionSeeds(s, coalition, height) {
  const out = new Map();
  for (const d of s.dealings) {
    const k = Number(BigInt(height) - d.startHeight);
    if (coalition.includes(d.dealer)) { out.set(d.dealer, s.keptSeeds.get(d.dealer)[k]); continue; } // malicious dealer kept its seeds
    if (coalition.length >= s.t) {
      const seed = combine(coalition.slice(0, s.t).map((i) => ({ x: i + 1, y: s.opened[i].get(d.dealer)[k] })));
      if (kemPublicKey(seed).every((b, j) => b === d.eks[k][j])) out.set(d.dealer, seed);
    }
  }
  return out;
}

// ------------------------------------------------------------------ scenarios

/**
 * Runs one scenario. mode 'plain' | 'encrypted'.
 * coalition: validator indices colluding with the searcher (pool shares; dealers among them kept their seeds).
 * withhold: validator indices that never release shares.
 */
export function runScenario({ n = 4, mode = 'encrypted', coalition = [], withhold = [], ttl = 3, m = DEFAULT_MARKET, setup } = {}) {
  const fairPool = new Pool(m.poolA, m.poolB);
  const victim = victimTx(fairPool, m);
  const fairOut = fairPool.quote('AtoB', victim.amountIn);
  const res = { mode, n, coalition: coalition.length, withheld: withhold.length, fairOut, victimOut: 0n, victimLoss: 0n, searcherProfit: 0n, earlyDecrypt: false, executedAt: null, expired: false, envelopeBytes: 0, garbageSkipped: false };

  if (mode === 'plain') {
    const pool = new Pool(m.poolA, m.poolB);
    const plan = planSandwich(pool, victim, m);
    let front = null;
    if (plan) { front = pool.swap('AtoB', plan.front); }
    const v = pool.swap('AtoB', victim.amountIn, victim.minOut);
    if (plan) res.searcherProfit = pool.swap('BtoA', front.out).out - plan.front - 2n * m.gasCost;
    Object.assign(res, { t: '-', victimOut: v.out, victimLoss: fairOut - v.out, earlyDecrypt: true, executedAt: 1n });
    return res;
  }

  const s = setup ?? setupCommittee({ n });
  res.t = s.t; res.d = s.d;
  const H = 1n;
  const lane = new EncryptedLane({ chainId: s.chainId, committee: s.committee, t: s.t, ttl, rules: { minFeePerByte: 1_000_000_000n, maxGas: 10_000_000 } });
  lane.setEpoch(0, s.dealings);
  const { epoch, keys } = lane.publicKeys(H);

  // users: the victim, plus a spammer whose envelope is well-formed and paid for but encrypted to junk keys
  const envRng = drbg('envelopes');
  const victimPayer = payerFromSeed(envRng(32), { deterministic: true });
  const feeFor = (bytesLen) => 1_000_000_000n * BigInt(bytesLen + 64);
  const sizeProbe = encryptTx({ chainId: s.chainId, height: H, epoch, keys, fee: 0n, gasLimit: 200_000, payer: victimPayer, tx: encodeSwap(victim), rng: drbg('probe') });
  const victimEnv = encryptTx({ chainId: s.chainId, height: H, epoch, keys, fee: feeFor(sizeProbe.length), gasLimit: 200_000, payer: victimPayer, tx: encodeSwap(victim), rng: envRng });
  const junkKeys = keys.map((k) => ({ dealer: k.dealer, ek: kemPublicKey(envRng(32)) }));
  const spamPayer = payerFromSeed(envRng(32), { deterministic: true });
  const spamEnv = encryptTx({ chainId: s.chainId, height: H, epoch, keys: junkKeys, fee: feeFor(sizeProbe.length), gasLimit: 200_000, payer: spamPayer, tx: utf8('junk'), rng: envRng });
  res.envelopeBytes = victimEnv.length;
  res.inclusionFee = feeFor(sizeProbe.length);

  // the searcher looks at the mempool before block H
  const pool = new Pool(m.poolA, m.poolB);
  const known = coalitionSeeds(s, coalition, H);
  let plan = null;
  if (known.size === s.dealings.length) {
    const seen = decryptEnvelope(decodeEnvelope(victimEnv), known);
    if (seen) { res.earlyDecrypt = true; plan = planSandwich(pool, decodeSwap(seen), m); }
  }

  // block H: plaintext txs run (front leg), then the encrypted batch is committed in inclusion order
  let frontOut = null;
  if (plan) frontOut = pool.swap('AtoB', plan.front).out;
  const bh = lane.commitBatch(H, [victimEnv, spamEnv]);

  // after commit: releases (signed over the batch hash), except from withholders
  const cacheKey = hex(bh);
  if (!s.releaseCache.has(cacheKey)) {
    s.releaseCache.set(cacheKey, s.validators.map((v) => createRelease({ chainId: s.chainId, height: H, batchHash: bh, dealings: s.dealings, myShares: s.opened[v.index], me: v })));
  }
  for (const r of s.releaseCache.get(cacheKey)) {
    if (withhold.includes(r.validator)) continue;
    const ok = lane.addRelease(r);
    if (!ok.ok) throw new Error(`release ${r.validator}: ${ok.reason}`);
  }

  // blocks H+1 ...: decrypted batch first, then the back leg
  for (let h = H + 1n; h <= H + BigInt(ttl) + 1n; h++) {
    const { execute, expired } = lane.beginBlock(h);
    for (const x of execute) {
      if (!x.tx) { res.garbageSkipped = true; continue; }
      const tx = decodeSwap(x.tx);
      const v = pool.swap(tx.dir, tx.amountIn, tx.minOut);
      if (tx.from === 'victim') Object.assign(res, { victimOut: v.out, executedAt: h });
    }
    if (expired.length) { res.expired = true; res.expiredAt = h; break; }
    if (execute.length) break;
  }
  if (plan) res.searcherProfit = pool.swap('BtoA', frontOut).out - plan.front - 2n * m.gasCost;
  res.victimLoss = res.executedAt ? fairOut - res.victimOut : 0n;
  return res;
}

/** The standard scenario list for one n (what the script prints). */
export function standardScenarios(n) {
  const s = setupCommittee({ n });
  const all = s.committee.map((v) => v.index);
  return [
    ['plaintext mempool', { n, mode: 'plain' }],
    ['encrypted, no collusion', { n, setup: s }],
    [`encrypted, ${s.t - 1} colluders (t-1)`, { n, setup: s, coalition: pickCoalition(s, s.t - 1) }],
    [`encrypted, ${s.t} colluders (t)`, { n, setup: s, coalition: pickCoalition(s, s.t) }],
    [`encrypted, all ${s.d} dealers keep seeds`, { n, setup: s, coalition: [...s.dealers] }],
    [`encrypted, ${n - s.t} withhold (n-t)`, { n, setup: s, withhold: all.slice(0, n - s.t) }],
    [`encrypted, ${n - s.t + 1} withhold (n-t+1)`, { n, setup: s, withhold: all.slice(0, n - s.t + 1) }],
  ].map(([name, o]) => ({ name, ...runScenario(o) }));
}

export const fmtA = (x) => (Number(x) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtB = (x) => (Number(x) / 1e6).toFixed(6);
