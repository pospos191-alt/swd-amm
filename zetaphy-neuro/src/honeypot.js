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
//      99% straight back, report amounts against the router's own quotes.
//
// The override exists only inside that one call. Nothing is signed or sent,
// and no chain state changes. If the RPC refuses overrides, or there is no
// pool, the check says it was skipped; it never claims "safe" without a
// trade that went through. Findings are made in analyze.js (simFindings).

import { TRADESIM_CODE, TRADESIM_RUN } from './tradesim.generated.js';
import { decodeAddress } from './abi.js';

/** Where the helper runs ("NeuroSim" in ASCII, then a counter). No key exists for it. */
export const SIM_ADDRESS = '0x4e6575726f53696d000000000000000000000001';
const SIM_FROM = '0x4e6575726f53696d000000000000000000000002';
const GET_PAIR = 'e6a43905'; // getPair(address,address)
const STAGES = { 1: 'bad-router', 2: 'no-liquidity', 3: 'buy-failed', 4: 'sell-failed', 5: 'done' };
const ZERO = '0x0000000000000000000000000000000000000000';

const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
const shortError = (e) => String(e?.message ?? e).slice(0, 200);

/** Percent lost against the router's quote, one decimal, floored; null without a quote. */
export function taxPercent(expected, got) {
  const e = BigInt(expected);
  const g = BigInt(got);
  if (e <= 0n) return null;
  if (g >= e) return 0; // reflection tokens can pay out a little more than quoted
  return Number(((e - g) * 1000n) / e) / 10;
}

/** Calldata for TradeSim.run(router, factory, weth, token, amountIn). */
export function runCalldata(dex, token) {
  return '0x' + TRADESIM_RUN + word(dex.router) + word(dex.factory) + word(dex.weth) + word(token) + uintWord(dex.amountIn);
}

/**
 * @param {{call: Function}} rpc  read-only EVM client (src/rpc.js)
 * @param {{name:string, factory:string, router:string, weth:string, native:string, amountIn:string}} dex
 * @param {string} token  lowercase 0x address
 * @returns {Promise<object>} what happened; numbers are decimal strings, taxes are percent
 */
export async function simulateTrade(rpc, dex, token) {
  const sim = { dex: dex.name, native: dex.native, amountIn: String(dex.amountIn) };
  let pairWord;
  try {
    pairWord = await rpc.call('eth_call', [{ to: dex.factory, data: '0x' + GET_PAIR + word(token) + word(dex.weth) }, 'latest']);
  } catch (e) {
    return { ...sim, stage: 'error', error: shortError(e) };
  }
  const pair = decodeAddress(pairWord);
  if (!pair || pair === ZERO) return { ...sim, stage: 'no-pool' };
  sim.pair = pair;

  const override = {
    [SIM_ADDRESS]: { code: TRADESIM_CODE, balance: '0x' + (BigInt(dex.amountIn) * 10n).toString(16) },
  };
  let out;
  try {
    out = await rpc.call('eth_call', [{ from: SIM_FROM, to: SIM_ADDRESS, data: runCalldata(dex, token) }, 'latest', override]);
  } catch (e) {
    // Refused (no state overrides on this endpoint), or the call ran out of
    // gas: either way no trade was seen.
    return { ...sim, stage: 'no-override', error: shortError(e) };
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
