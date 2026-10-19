#!/usr/bin/env node
// Neuro ZETAPHY tier 1 from the command line.
//   node cli.js <bsc|base|arbitrum> <address> [--lang th|en] [--json]
//   node cli.js fingerprint <bsc|base|arbitrum> <address>
//       prints a template entry to paste into src/templates.js
import { readContract } from './src/reader.js';
import { explain } from './src/explain.js';
import { CHAINS } from './src/chains.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--lang');
const chains = Object.keys(CHAINS).join('|');

function usage() {
  console.error(`usage: node cli.js <${chains}> <address> [--lang th|en] [--json]
       node cli.js fingerprint <${chains}> <address>`);
  process.exit(2);
}

async function fingerprint(chain, address) {
  if (CHAINS[chain]?.kind === 'solana') throw new Error('fingerprints are for EVM contracts; Solana tokens are recognised by their mint settings');
  const r = await readContract(chain, address);
  if (!r.fingerprint) throw new Error('no contract code at this address');
  const has = (id) => r.analysis.findings.some((f) => f.id === id);
  const guarantees = [
    !has('can-mint') && 'no-mint',
    !has('can-blacklist') && 'no-blacklist',
    !has('can-pause') && 'no-pause',
  ].filter(Boolean);
  console.log(`// ${CHAINS[chain].name} ${r.address}  (${r.token?.symbol ?? '?'})`);
  console.log(`// Powers found in this code: ${r.analysis.findings.filter((f) => f.id.startsWith('can-') || f.id === 'trading-switch').map((f) => f.id).join(', ') || 'none'}`);
  console.log('// Only add tax-decrease-only to guarantees after reading the tax setter in the source.');
  console.log(`  {
    fingerprint: '${r.fingerprint}',
    project: 'ZETAPHY',
    name: 'ZETAPHY token',
    chains: ['${chain}'],
    guarantees: ${JSON.stringify(guarantees).replace(/"/g, "'").replace(/,/g, ', ')},
    source: '${chain} ${r.address}',
  },`);
}

try {
  if (positional[0] === 'fingerprint') {
    if (!positional[1] || !positional[2]) usage();
    await fingerprint(positional[1], positional[2]);
  } else {
    const [chain, address] = positional;
    if (!chain || !address) usage();
    const report = await readContract(chain, address);
    if (flag('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const out = explain(report, opt('--lang', 'th'));
      const mark = { high: '!!', medium: '! ', low: '- ', info: '  ', good: '+ ' };
      console.log(`${CHAINS[chain].name} ${report.address}`);
      console.log(`== ${out.title} ==`);
      for (const l of out.lines) console.log(`${mark[l.severity]} ${l.text}`);
      console.log(`\nreport ${report.reportHash.slice(0, 16)} · ${CHAINS[chain].explorer}${report.address}`);
    }
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
