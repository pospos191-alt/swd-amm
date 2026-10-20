#!/usr/bin/env node
// Live check: reads real tokens and contracts on every chain Neuro supports,
// through the same free public endpoints the web page uses, and checks the
// findings that must be there. Run by .github/workflows/neuro-live.yml
// (GitHub's runners can reach the chains; the unit tests never touch the
// network on purpose).
//
//   node scripts/live-check.js            all samples
//   node scripts/live-check.js ton sui    only these chains
//
// `expect`: findings that must be there; `absent`: ones that must not (past
// false alarms). A "soft" sample is one whose address is not from an
// official list, or that needs something a public RPC may refuse (the trade
// simulation's state override); if it fails, it is a warning, not a failure.
//
// Before the samples, each EVM chain's DEX for the trade simulation
// (src/chains.js `dex`) is checked on chain: code at the factory, router and
// wrapped coin, and router.factory() / router.WETH() matching. A wrong
// address there is a hard failure.

import { appendFileSync } from 'node:fs';
import { readContract } from '../src/reader.js';
import { explain } from '../src/explain.js';
import { CHAINS } from '../src/chains.js';
import { createRpc } from '../src/rpc.js';
import { decodeAddress } from '../src/abi.js';

const SAMPLES = [
  // Solidity / Vyper (EVM bytecode + Sourcify)
  { chain: 'eth', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', label: 'USDT (Solidity)', expect: ['erc20', 'known-issuer'] },
  { chain: 'eth', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', label: 'UNI (Solidity)', expect: ['erc20'] },
  { chain: 'eth', address: '0xD533a949740bb3306d119CC777fa900bA034cd52', label: 'CRV (Vyper)', expect: ['erc20'] },
  { chain: 'eth', address: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', label: 'Curve 3pool (Vyper)', expect: ['source-verified'], absent: ['can-mint'] },
  { chain: 'bsc', address: '0x55d398326f99059fF775485246999027B3197955', label: 'USDT BNB Chain', expect: ['erc20', 'known-issuer'] },
  { chain: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'USDC Base (ZeppelinOS proxy)', expect: ['erc20', 'known-issuer', 'proxy-upgradeable', 'can-blacklist'] },
  { chain: 'eth', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', label: 'USDC Ethereum (ZeppelinOS proxy)', expect: ['erc20', 'known-issuer', 'proxy-upgradeable'] },
  { chain: 'arbitrum', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', label: 'ARB', expect: ['erc20', 'known-issuer'] },
  // Trade simulation (honeypot check): liquid, untaxed tokens with a pool
  // against the wrapped coin on the chain's V2 DEX should buy and sell back.
  // Soft: a public RPC may refuse state overrides. The raw numbers are printed.
  { chain: 'eth', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', label: 'UNI trade simulation (Uniswap V2)', expect: ['sim-ok'], absent: ['sim-cannot-sell', 'sim-high-tax'], soft: true },
  { chain: 'eth', address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', label: 'PEPE trade simulation (Uniswap V2)', expect: ['sim-ok'], absent: ['sim-cannot-sell', 'sim-high-tax'], soft: true },
  { chain: 'bsc', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', label: 'CAKE trade simulation (PancakeSwap V2)', expect: ['sim-ok'], absent: ['sim-cannot-sell', 'sim-high-tax'], soft: true },
  // Not sure these have a Uniswap V2 pool with WETH; a "no pool" skip shows as a warning.
  { chain: 'base', address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', label: 'VIRTUAL trade simulation (Uniswap V2)', expect: ['sim-ok'], absent: ['sim-cannot-sell'], soft: true },
  { chain: 'arbitrum', address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', label: 'GMX trade simulation (Uniswap V2)', expect: ['sim-ok'], absent: ['sim-cannot-sell'], soft: true },
  // Rust: Solana (mints and Anchor programs)
  { chain: 'sol', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', label: 'USDC Solana', expect: ['sol-token', 'known-issuer'] },
  { chain: 'sol', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', label: 'BONK', expect: ['sol-token'] },
  { chain: 'sol', address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', label: 'Jupiter v6 (Anchor)', expect: ['sol-idl'] },
  { chain: 'sol', address: 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', label: 'Marinade (Anchor)', expect: ['sol-idl', 'sol-admin-instructions', 'can-pause'] },
  // Move
  { chain: 'sui', address: '0x2::sui::SUI', label: 'SUI', expect: ['sui-coin', 'known-issuer', 'sui-system'] },
  { chain: 'sui', address: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', label: 'USDC Sui', expect: ['sui-coin', 'known-issuer'] },
  { chain: 'aptos', address: '0x1::aptos_coin::AptosCoin', label: 'APT', expect: ['apt-token', 'known-issuer'] },
  { chain: 'aptos', address: '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b', label: 'USDt Aptos', expect: ['apt-token', 'known-issuer'] },
  // FunC / Tact
  { chain: 'ton', address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', label: 'USDT TON', expect: ['ton-jetton', 'known-issuer', 'ton-wallet-standard'] },
  { chain: 'ton', address: 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT', label: 'Notcoin', expect: ['ton-jetton', 'ton-wallet-standard'] },
  { chain: 'ton', address: 'EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS', label: 'DOGS', expect: ['ton-jetton', 'ton-wallet-standard'] },
  // Rust on NEAR (WASM exports)
  { chain: 'near', address: 'wrap.near', label: 'wNEAR (NEAR, Rust)', expect: ['near-token', 'known-issuer'] },
  { chain: 'near', address: 'usdt.tether-token.near', label: 'USDt NEAR', expect: ['near-token', 'known-issuer'] },
  // Cairo on Starknet (ABI on chain)
  { chain: 'starknet', address: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', label: 'STRK (Starknet, Cairo)', expect: ['sn-token', 'known-issuer'] },
  { chain: 'starknet', address: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', label: 'ETH on Starknet', expect: ['sn-token', 'known-issuer'] },
  // Bitcoin Runes (ord JSON API)
  { chain: 'bitcoin', address: 'UNCOMMON•GOODS', label: 'UNCOMMON•GOODS (first rune)', expect: ['btc-rune', 'btc-no-admin'] },
  { chain: 'bitcoin', address: 'DOG•GO•TO•THE•MOON', label: 'DOG (rune)', expect: ['btc-rune', 'btc-premine'] },
  { chain: 'bitcoin', address: '840000:3', label: 'DOG by id', expect: ['btc-rune'] },
  // Rust: CosmWasm
  { chain: 'neutron', address: 'neutron1hptk0k5kng7hjy35vmh009qd5m6l33609nypgf2yc6nqnewduqasxplt4e', label: 'Astroport factory (CosmWasm)', expect: ['cw-contract', 'cw-admin'] },
  { chain: 'neutron', address: 'factory/neutron1ug740qrkquxzrk2hh29qrlx3sktkfml3je7juusc2te7xmvsscns0n2wry/wstETH', label: 'wstETH Neutron (Token Factory)', expect: ['tf-token'] },
];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The trade simulation's DEX addresses for one chain, checked on chain. */
async function checkDex(chain) {
  const c = CHAINS[chain];
  const d = c.dex;
  const s = { chain, label: `${d.name} addresses (trade simulation)`, expect: [] };
  const t0 = Date.now();
  try {
    const rpc = createRpc(c.rpcs, c.id);
    const missing = [];
    for (const [name, a] of [['factory', d.factory], ['router', d.router], [d.native, d.weth]]) {
      const code = await rpc.call('eth_getCode', [a, 'latest']);
      if (!code || code === '0x') missing.push(`no code at ${name} ${a}`);
    }
    const read = async (data) => { try { return decodeAddress(await rpc.call('eth_call', [{ to: d.router, data }, 'latest'])); } catch (e) { return `error: ${e.message}`; } };
    const factory = await read('0xc45a0155'); // factory()
    const weth = await read('0xad5c4648'); // WETH()
    if (factory !== d.factory.toLowerCase()) missing.push(`router.factory() is ${factory}, expected ${d.factory}`);
    if (weth !== d.weth.toLowerCase()) missing.push(`router.WETH() is ${weth}, expected ${d.weth}`);
    const lines = [`factory ${d.factory}`, `router ${d.router}: factory() ${factory}, WETH() ${weth}`];
    return { ...s, ok: missing.length === 0, missing, level: missing.length ? 'wrong' : 'verified', ids: [], ms: Date.now() - t0, lines };
  } catch (e) {
    return { ...s, ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

async function checkOne(s) {
  const t0 = Date.now();
  try {
    const r = await readContract(s.chain, s.address);
    const ids = r.analysis.findings.map((f) => f.id);
    const missing = [
      ...s.expect.filter((id) => !ids.includes(id)),
      ...(s.absent ?? []).filter((id) => ids.includes(id)).map((id) => `unexpected ${id}`),
    ];
    const extra = r.ton?.wallet ? [`wallet: ${JSON.stringify(r.ton.wallet)}`] : [];
    // Raw trade simulation numbers (stage, pool, amounts quoted vs received, gas).
    if (r.sim) extra.push(`sim: ${JSON.stringify(r.sim)}`);
    return { ...s, ok: missing.length === 0, missing, level: r.analysis.level, ids, ms: Date.now() - t0, lines: [...explain(r, 'en').lines.map((l) => `${l.severity}: ${l.text}`), ...extra] };
  } catch (e) {
    return { ...s, ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

const only = process.argv.slice(2);
const samples = SAMPLES.filter((s) => !only.length || only.includes(s.chain));
const results = [];
const dexChains = Object.keys(CHAINS).filter((k) => CHAINS[k].dex && (!only.length || only.includes(k)));
const jobs = [...dexChains.map((chain) => ({ chain, dex: true })), ...samples];
for (const s of jobs) {
  if (!CHAINS[s.chain]) throw new Error(`unknown chain ${s.chain}`);
  const r = s.dex ? await checkDex(s.chain) : await checkOne(s);
  results.push(r);
  const mark = r.ok ? 'PASS' : r.soft ? 'WARN' : 'FAIL';
  console.log(`\n[${mark}] ${r.chain} ${r.label}  ${r.error ? `error: ${r.error}` : `${r.level}  (${r.ms} ms)`}`);
  if (r.missing?.length) console.log(`  missing: ${r.missing.join(', ')}`);
  for (const l of r.lines ?? []) console.log(`  ${l}`);
  if (s.chain === 'ton') await pause(1200); // tonapi free tier: ~1 request/second
}

const fails = results.filter((r) => !r.ok && !r.soft);
const warns = results.filter((r) => !r.ok && r.soft);
if (process.env.GITHUB_STEP_SUMMARY) {
  const row = (r) => `| ${r.ok ? '✅' : r.soft ? '⚠️' : '❌'} | ${r.chain} | ${r.label} | ${r.error ? `error: ${r.error}` : r.level} | ${r.missing?.length ? r.missing.join(', ') : ''} | ${r.ids?.join(', ') ?? ''} |`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `## Neuro live check: ${results.length - fails.length - warns.length}/${results.length} passed${warns.length ? `, ${warns.length} warning(s)` : ''}`,
    '', '| | chain | sample | level | missing | findings |', '|---|---|---|---|---|---|',
    ...results.map(row), '',
  ].join('\n'));
}
console.log(`\n${results.length - fails.length - warns.length}/${results.length} passed, ${warns.length} warning(s), ${fails.length} failure(s)`);
process.exit(fails.length ? 1 : 0);
