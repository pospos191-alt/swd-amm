#!/usr/bin/env node
// zetaphy-verify: publish ZETAPHY launcher sources on block explorers.
//
//   node cli.js watch [--chain bsc] [--from-block N] [--to-block N]
//   node cli.js verify <chain> <address> [--tx 0x...]
//   node cli.js export <ContractName> [--out dir]   (files for the free web form)
//
// Env: ETHERSCAN_API_KEY (optional; Sourcify needs no key).

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './src/config.js';
import { createRpc } from './src/rpc.js';
import { loadBuildDir } from './src/build-info.js';
import { sourcify, etherscan } from './src/explorers.js';
import { verifyAddress } from './src/verify.js';
import { watchChain } from './src/watch.js';
import { findContract, exportForWebForm } from './src/export.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { cmd: pos[0], pos: pos.slice(1), opt };
}

const blockArg = (v, name) => {
  if (v == null || v === '') return undefined;
  if (!/^\d+$/.test(v)) throw new Error(`--${name} must be a block number`);
  return Number(v);
};

function summarize(rows, write) {
  const fmt = (r) => Object.entries(r.results ?? {}).map(([k, v]) => `${k}: ${v.status}${v.detail && !v.ok ? ` (${v.detail})` : ''}`).join(', ');
  for (const r of rows) write(`  ${r.chain} ${r.kind ?? ''} ${r.address} ${r.contract ?? ''} -> ${r.status}${r.results ? ' | ' + fmt(r) : r.detail ? ` (${r.detail})` : ''}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['| chain | kind | address | contract | result |', '|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.chain} | ${r.kind ?? ''} | \`${r.address}\` | ${r.contract ?? ''} | ${r.status}${r.results ? ': ' + fmt(r) : ''} |`)];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ZETAPHY verify\n\n${rows.length ? lines.join('\n') : 'Nothing new to verify.'}\n`);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, write = console.log) {
  const { cmd, pos, opt } = parse(argv);
  if (!['watch', 'verify', 'export'].includes(cmd)) {
    write('usage: node cli.js watch [--chain bsc] [--from-block N] [--to-block N]\n       node cli.js verify <chain> <address> [--tx 0x...]\n       node cli.js export <ContractName> [--out dir]');
    return 2;
  }
  const buildDir = fileURLToPath(new URL('./build-info/', import.meta.url));
  const builds = await loadBuildDir(buildDir);
  if (!builds.contracts.length) {
    write('No build-info found in zetaphy-verify/build-info/. Copy the launcher\'s build-info there first (see build-info/README.md).');
    return 0; // nothing to do yet is not an error
  }
  if (cmd === 'export') {
    const contract = findContract(builds, pos[0] ?? '');
    const { file, form } = exportForWebForm(contract, opt.out ?? fileURLToPath(new URL('./out/', import.meta.url)));
    write(`Wrote ${file}\nIn the explorer's "Verify and Publish" form:`);
    for (const [k, v] of Object.entries(form)) write(`  ${k}: ${v}`);
    return 0;
  }
  const explorers = [sourcify(), etherscan({ apiKey: env.ETHERSCAN_API_KEY })];
  if (!explorers[1]) write('ETHERSCAN_API_KEY not set: publishing to Sourcify only.');

  const rows = [];
  if (cmd === 'verify') {
    const [chainKey, address] = pos;
    const chain = CONFIG.chains[chainKey];
    if (!chain) throw new Error(`unknown chain: ${chainKey} (${Object.keys(CONFIG.chains).join(', ')})`);
    if (!ADDRESS.test(address ?? '')) throw new Error('invalid address');
    if (opt.tx && !TX.test(opt.tx)) throw new Error('invalid --tx');
    const rpc = createRpc(chain.rpcs, chain.chainId);
    rows.push({ chain: chainKey, ...await verifyAddress({ chainId: chain.chainId, address, txHash: opt.tx, rpc, builds, explorers }) });
  } else {
    const keys = opt.chain ? [opt.chain] : Object.keys(CONFIG.chains);
    const allFactories = Object.values(CONFIG.chains).flatMap((c) => c.factories);
    for (const key of keys) {
      const chain = CONFIG.chains[key];
      if (!chain) throw new Error(`unknown chain: ${key}`);
      const factories = CONFIG.probeFactories ? allFactories : chain.factories;
      try {
        const out = await watchChain({
          chain, factories, rpc: createRpc(chain.rpcs, chain.chainId), builds, explorers, topic: CONFIG.eventTopic,
          fromBlock: blockArg(opt['from-block'], 'from-block'), toBlock: blockArg(opt['to-block'], 'to-block'), log: write,
        });
        rows.push(...out.map((r) => ({ chain: key, ...r })));
      } catch (e) {
        rows.push({ chain: key, address: '-', status: 'failed', detail: e.message });
      }
    }
  }
  summarize(rows, write);
  return rows.some((r) => r.status === 'failed') ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
