// Buy/sell test: a simulated buy and sell of an EVM token (often called a
// "honeypot check"; reports describe the result, never label the token).
//
// The rules read function names, so code that blocks selling or takes a
// hidden tax under an unusual name can slip past them. A real trade cannot:
// either the tokens come back out or they do not. This is the honeypot.is
// technique, done with read-only calls only:
//
//   1. factory.getPair(token, WETH) (plain eth_call) finds the token's pool
//      on the chain's main Uniswap-V2-style DEX (chains.js `dex`).
//   2. ONE eth_call with a state override (third parameter) puts the
//      TradeSim helper (contracts/TradeSim.sol) and a little native coin at a
//      throwaway address, and runs it there: buy through the router, sell
//      most of it straight back, report amounts against the router's quotes.
//
// The override exists only inside that one call. Nothing is signed or sent,
// and no chain state changes. If the RPC refuses overrides, or there is no
// pool, the check says it was skipped; it never claims "safe" without a
// trade that went through. Findings are made in analyze.js (simFindings).
//
// Not looking like a test. This code is public, so a token can be written to
// behave honestly only when it sees this check and to block everyone else.
// Every value a token can observe and that would otherwise be fixed is
// picked per check (simPlan below):
//   - where TradeSim runs and who calls it (tx.origin): fresh random
//     addresses for a standalone check (web page, CLI); for a NeuroJobs job,
//     derived from the job and its lottery (jobSimSeed), which nobody knows
//     when the token is deployed, so every runner of the job runs the same
//     test and anyone can re-run it;
//   - TradeSim's code hash and size: a few random bytes after its code;
//   - the amount bought, the share sold back, the balances and the gas limit;
//   - tx.gasprice and block.basefee: a node runs a call without a gas price
//     at gas price 0 and (geth) with BASEFEE 0, which no real transaction
//     has. The call carries a gas price from eth_gasPrice, and the caller
//     gets the coin to pay for it.
// What this cannot hide (one eth_call cannot): the buyer and seller is a
// contract, not tx.origin itself. A token that only lets contracts sell is
// still possible; the fixed rules, the similarity dataset and the
// early-warning tier exist for what this test misses. A job's addresses are
// public once its lottery block exists, so a token owner who watches
// NeuroJobs could whitelist them before the runners call; the simulation is
// not part of the network verdict (verdict.js), so this only affects what a
// runner's own report shows.

import { TRADESIM_CODE, TRADESIM_RUN } from './tradesim.generated.js';
import { decodeAddress } from './abi.js';
import { keccak256 } from './keccak.js';

const GET_PAIR = 'e6a43905'; // getPair(address,address)
const STAGES = { 1: 'bad-router', 2: 'no-liquidity', 3: 'buy-failed', 4: 'sell-failed', 5: 'done' };
const ZERO = '0x0000000000000000000000000000000000000000';
// The node refused the priced call over the fee or the caller's balance:
// tried again once without a gas price (a weaker test, still a test).
const FEE_ERROR = /fee|gas ?price|insufficient funds|underpriced/i;

const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
const qty = (n) => '0x' + BigInt(n).toString(16);
const shortError = (e) => String(e?.message ?? e).slice(0, 200);
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function hexBytes(hex) {
  const h = hex.replace(/^0x/i, '');
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/**
 * Percent lost against the router's quote, one decimal, floored; null without
 * a quote. One part per million is forgiven first: a 5% fee computed as
 * floor(amount * 5%) loses a hair under 5%, and the amount changes per check.
 */
export function taxPercent(expected, got) {
  const e = BigInt(expected);
  const g = BigInt(got);
  if (e <= 0n) return null;
  if (g >= e) return 0; // reflection tokens can pay out a little more than quoted
  const ppm = ((e - g) * 1_000_000n) / e;
  return Number((ppm + 1n) / 1000n) / 10;
}

/**
 * Addresses a simulation must never use: precompiles and chain system
 * contracts (everything below 2^32: 0x01-0x11, 0x100, BNB Chain's 0x1000-0x2005,
 * Arbitrum's 0x64-0xff), OP-stack predeploys (0x4200...) and 0xffff...
 * A random address lands here with odds of about 2^-128; the check is cheap.
 */
export function isReservedAddress(address) {
  const h = String(address).replace(/^0x/i, '').toLowerCase();
  return /^0{32}/.test(h) || /^420{30}/.test(h) || /^f{32}/.test(h);
}

/** Seed for a NeuroJobs job: keccak256("neuro-sim-job" || uint256 jobId || bytes32 lottery). */
export function jobSimSeed(jobId, rand) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(rand))) throw new Error('rand must be 0x + 32 bytes');
  return '0x' + toHex(keccak256(concat(enc.encode('neuro-sim-job'), hexBytes(uintWord(jobId)), hexBytes(rand))));
}

function seedBytes(seed) {
  if (seed instanceof Uint8Array) return seed;
  if (typeof seed === 'string' && /^0x([0-9a-fA-F]{2})+$/.test(seed)) return hexBytes(seed);
  throw new Error('simulation seed must be 0x-prefixed hex bytes');
}

/**
 * Everything a token could observe about one simulation, picked from a seed:
 * a fixed seed always gives the same plan (NeuroJobs runners, re-runs); no
 * seed means 32 fresh random bytes (Web Crypto, browser or Node).
 * @param {{amountIn:string}} dex  chains.js `dex`
 * @param {{seed?: string|Uint8Array}} [opts]
 */
export function simPlan(dex, { seed } = {}) {
  let s;
  if (seed == null) {
    s = new Uint8Array(32);
    globalThis.crypto.getRandomValues(s);
  } else {
    s = seedBytes(seed);
  }
  // Byte stream: keccak256("neuro-sim-v1" || seed || counter), 32 bytes at a time.
  let counter = 0;
  let buf = new Uint8Array(0);
  const take = (n) => {
    while (buf.length < n) {
      const block = keccak256(concat(enc.encode('neuro-sim-v1'), s, hexBytes(counter.toString(16).padStart(8, '0'))));
      counter++;
      buf = concat(buf, block);
    }
    const out = buf.slice(0, n);
    buf = buf.slice(n);
    return out;
  };
  const num = (n) => BigInt('0x' + toHex(take(n)));
  const address = () => {
    for (;;) {
      const a = '0x' + toHex(take(20));
      if (!isReservedAddress(a)) return a;
    }
  };
  const at = address();
  let from = address();
  while (from === at) from = address();
  const base = BigInt(dex.amountIn);
  // 75%-125% of the chain's usual amount, in 0.01% steps: the size of a
  // small real buy, never one exact number a token could whitelist. Small
  // enough that it rarely meets a max-transaction limit.
  const amountIn = (base * (7500n + num(4) % 5000n)) / 10000n;
  return {
    at,
    from,
    amountIn,
    // Share sold back, 90.00%-99.90% (see TradeSim.sol).
    sellBps: 9000n + num(4) % 991n,
    // A gas limit like a generous wallet's, not a node's 50M default; high
    // enough for a buy and a sell of tokens with heavy transfer hooks.
    gas: 4_000_000n + num(4) % 2_000_000n,
    // 1-48 random bytes after an INVALID opcode at the end of TradeSim's
    // code: never executed, but its hash and size change every time.
    salt: 'fe' + toHex(take(1 + Number(num(1) % 48n))),
    // Coin TradeSim holds: the buy plus an uneven extra (no round balance).
    simBalance: amountIn + base * (1n + num(4) % 40n) + num(8) % base,
    // Coin the caller holds on top of the gas it pays for.
    fromExtra: base * (1n + num(4) % 60n) + num(8) % base,
    // Gas price: 110%-160% of eth_gasPrice, as wallets add headroom.
    priceBps: 11000n + num(4) % 5000n,
  };
}

/** Calldata for TradeSim.run(router, factory, weth, token, amountIn, sellBps). */
export function runCalldata(dex, token, plan) {
  return '0x' + TRADESIM_RUN + word(dex.router) + word(dex.factory) + word(dex.weth) + word(token)
    + uintWord(plan.amountIn) + uintWord(plan.sellBps);
}

/** eth_gasPrice with the plan's headroom, or null (unknown, or a chain at 0). */
async function gasPriceFor(rpc, plan) {
  try {
    const p = BigInt(await rpc.call('eth_gasPrice', []));
    return p > 0n ? (p * plan.priceBps) / 10000n : null;
  } catch {
    return null;
  }
}

/** [tx, override] for the TradeSim call; gasPrice null = an unpriced call. */
function simCall(dex, token, plan, gasPrice) {
  const tx = { from: plan.from, to: plan.at, data: runCalldata(dex, token, plan), gas: qty(plan.gas) };
  if (gasPrice != null) tx.gasPrice = qty(gasPrice);
  const override = {
    [plan.at]: { code: TRADESIM_CODE + plan.salt, balance: qty(plan.simBalance) },
    // The caller pays gas * gasPrice up front (the node checks it can).
    [plan.from]: { balance: qty((gasPrice ?? 0n) * plan.gas + plan.fromExtra) },
  };
  return [tx, override];
}

/**
 * @param {{call: Function}} rpc  read-only EVM client (src/rpc.js)
 * @param {{name:string, factory:string, router:string, weth:string, native:string, amountIn:string}} dex
 * @param {string} token  lowercase 0x address
 * @param {{seed?: string|Uint8Array}} [opts]  seed: a fixed plan (jobSimSeed for NeuroJobs); none = random
 * @returns {Promise<object>} what happened; numbers are decimal strings, taxes are percent
 */
export async function simulateTrade(rpc, dex, token, opts = {}) {
  const plan = simPlan(dex, opts);
  const sim = { dex: dex.name, native: dex.native, amountIn: String(plan.amountIn) };
  let pairWord;
  try {
    pairWord = await rpc.call('eth_call', [{ to: dex.factory, data: '0x' + GET_PAIR + word(token) + word(dex.weth) }, 'latest']);
  } catch (e) {
    return { ...sim, stage: 'error', error: shortError(e) };
  }
  const pair = decodeAddress(pairWord);
  if (!pair || pair === ZERO) return { ...sim, stage: 'no-pool' };
  sim.pair = pair;

  const gasPrice = await gasPriceFor(rpc, plan);
  let out;
  try {
    const [tx, override] = simCall(dex, token, plan, gasPrice);
    out = await rpc.call('eth_call', [tx, 'latest', override]);
  } catch (e) {
    if (gasPrice == null || !FEE_ERROR.test(shortError(e))) {
      // Refused (no state overrides on this endpoint), or the call ran out of
      // gas: either way no trade was seen.
      return { ...sim, stage: 'no-override', error: shortError(e) };
    }
    try {
      const [tx, override] = simCall(dex, token, plan, null);
      out = await rpc.call('eth_call', [tx, 'latest', override]);
    } catch (e2) {
      return { ...sim, stage: 'no-override', error: shortError(e2) };
    }
  }
  const h = String(out ?? '').replace(/^0x/, '');
  // An endpoint that silently drops the override runs an address with no
  // code and returns nothing.
  if (h.length < 64 * 7) return { ...sim, stage: 'no-override' };
  const w = (i) => BigInt('0x' + h.slice(i * 64, i * 64 + 64));
  const stage = STAGES[Number(w(0))];
  if (!stage) return { ...sim, stage: 'error', error: `unexpected result ${h.slice(0, 64)}` };
  Object.assign(sim, {
    stage,
    expectedBuy: w(1).toString(), bought: w(2).toString(),
    expectedSell: w(3).toString(), sold: w(4).toString(),
    buyGas: Number(w(5)), sellGas: Number(w(6)),
  });
  if (stage === 'sell-failed' || stage === 'done') sim.buyTax = taxPercent(sim.expectedBuy, sim.bought);
  if (stage === 'done') sim.sellTax = taxPercent(sim.expectedSell, sim.sold);
  return sim;
}
