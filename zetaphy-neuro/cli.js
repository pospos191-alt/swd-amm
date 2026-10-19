#!/usr/bin/env node
// Neuro ZETAPHY tier 1 from the command line.
//   node cli.js <bsc|base|arbitrum> <address> [--lang th|en] [--json]
import { readContract } from './src/reader.js';
import { explain } from './src/explain.js';
import { CHAINS } from './src/chains.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--lang');
const [chain, address] = positional;

if (!chain || !address) {
  console.error(`usage: node cli.js <${Object.keys(CHAINS).join('|')}> <address> [--lang th|en] [--json]`);
  process.exit(2);
}

try {
  const report = await readContract(chain, address);
  if (flag('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const lang = opt('--lang', 'th');
    const out = explain(report, lang);
    const mark = { high: '!!', medium: '! ', low: '- ', info: '  ', good: '+ ' };
    console.log(`${CHAINS[chain].name} ${report.address}`);
    console.log(`== ${out.title} ==`);
    for (const l of out.lines) console.log(`${mark[l.severity]} ${l.text}`);
    console.log(`\nreport ${report.reportHash.slice(0, 16)} · ${CHAINS[chain].explorer}${report.address}`);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
