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
// official list; if it fails, it is a warning, not a failure.

import { appendFileSync } from 'node:fs';
import { readContract } from '../src/reader.js';
import { explain } from '../src/explain.js';
import { CHAINS } from '../src/chains.js';

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
  { chain: 'ton', address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', label: 'USDT TON', expect: ['ton-jetton', 'known-issuer'] },
  { chain: 'ton', address: 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT', label: 'Notcoin', expect: ['ton-jetton'] },
  { chain: 'ton', address: 'EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS', label: 'DOGS', expect: ['ton-jetton'] },
  // Rust: CosmWasm
  { chain: 'neutron', address: 'neutron1hptk0k5kng7hjy35vmh009qd5m6l33609nypgf2yc6nqnewduqasxplt4e', label: 'Astroport factory (CosmWasm)', expect: ['cw-contract', 'cw-admin'] },
  { chain: 'neutron', address: 'factory/neutron1ug740qrkquxzrk2hh29qrlx3sktkfml3je7juusc2te7xmvsscns0n2wry/wstETH', label: 'wstETH Neutron (Token Factory)', expect: ['tf-token'] },
];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkOne(s) {
  const t0 = Date.now();
  try {
    const r = await readContract(s.chain, s.address);
    const ids = r.analysis.findings.map((f) => f.id);
    const missing = [
      ...s.expect.filter((id) => !ids.includes(id)),
      ...(s.absent ?? []).filter((id) => ids.includes(id)).map((id) => `unexpected ${id}`),
    ];
    return { ...s, ok: missing.length === 0, missing, level: r.analysis.level, ids, ms: Date.now() - t0, lines: explain(r, 'en').lines.map((l) => `${l.severity}: ${l.text}`) };
  } catch (e) {
    return { ...s, ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

const only = process.argv.slice(2);
const samples = SAMPLES.filter((s) => !only.length || only.includes(s.chain));
const results = [];
for (const s of samples) {
  if (!CHAINS[s.chain]) throw new Error(`unknown chain ${s.chain}`);
  const r = await checkOne(s);
  results.push(r);
  const mark = r.ok ? 'PASS' : r.soft ? 'WARN' : 'FAIL';
  console.log(`\n[${mark}] ${s.chain} ${s.label}  ${r.error ? `error: ${r.error}` : `${r.level}  (${r.ms} ms)`}`);
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
