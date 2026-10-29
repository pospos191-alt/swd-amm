#!/usr/bin/env node
// Reads a real EVM contract with Neuro and adds the model's risk score.
//
//   node ml/cli.js <evm chain> <address> [--lang th] [--json]
//
// The rules' report and verdict are exactly what `node cli.js` gives; the
// model only adds `analysis.ml` and may raise (never lower) the shown level.

import { readFileSync } from 'node:fs';
import { readContract } from '../src/reader.js';
import { CHAINS } from '../src/chains.js';
import { createRpc } from '../src/rpc.js';
import { checkModel } from './model.js';
import { withModel } from './combine.js';

const [chain, address] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const lang = process.argv.includes('--lang') ? process.argv[process.argv.indexOf('--lang') + 1] : 'en';
const cfg = CHAINS[chain];
if (!cfg || cfg.kind !== 'evm' || !address) {
  console.error('usage: node ml/cli.js <evm chain> <address> [--lang th] [--json]');
  process.exit(2);
}
const model = checkModel(JSON.parse(readFileSync(new URL('./model.json', import.meta.url), 'utf8')));
const rpc = createRpc(cfg.rpcs, cfg.id);
const report = await readContract(chain, address, { rpc, simulate: true });
const code = await rpc.call('eth_getCode', [address.toLowerCase(), 'latest']);
const impl = report.proxy?.implementation;
const logicCode = impl ? await rpc.call('eth_getCode', [impl, 'latest']) : null;
const out = withModel(model, report, { code, logicCode, lang });
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 1));
} else {
  const a = out.analysis;
  console.log(`rules level: ${a.rulesLevel}${report.analysis.level !== a.rulesLevel ? ` (with simulation: ${report.analysis.level})` : ''}`);
  console.log(`model ${a.ml.model}: risk ${(a.ml.p * 100).toFixed(1)}%${a.ml.level ? ` (${a.ml.level})` : ''}${a.ml.raised ? ' -> raised the shown level' : ''}`);
  console.log(`shown level: ${a.level}`);
  for (const t of a.ml.top) console.log(`  ${t.effect > 0 ? '+' : '-'} ${t.label} (${t.value})`);
  console.log('The score is a statistical estimate from synthetic training data, not a finding; it is not part of the network verdict.');
}
