#!/usr/bin/env node
// Neuro ZETAPHY tier 1 from the command line.
//   node cli.js <chain> <address> [--lang th|en|zh|ja|ko|vi|id] [--json] [--sim-seed 0x<32 bytes>]
//       --sim-seed: re-run a NeuroJobs job's trade simulation with the same
//       addresses and amounts (jobSimSeed(job id, lottery) in src/honeypot.js)
//   node cli.js zetaphy-wasm <zetaphy1… contract> --rest https://<node>/rest [--lang ..] [--json]
//       a CosmWasm contract on ZETAPHY (no fixed public REST: name a node's)
//   node cli.js fingerprint <evm chain> <address>
//       prints a template entry to paste into src/templates.js
//   node cli.js signature <evm chain> <address> [--reason <ThreatRegistry code fact, src/threat-reasons.js>]
//                         [--flag-key 0x<ThreatRegistry key> --report-hash 0x<evidence reportHash>]
//       prints a dataset entry to paste into src/threat-signatures.js (ADDED).
//       Only an entry with --flag-key/--report-hash (the on-chain flag) is shown
//       to users as "flagged by Neuro runners"; without them it is a "reference sample".
//       --reason takes the ThreatRegistry category codes; the report shows them
//       as neutral descriptions of the code's behaviour (REASON in src/lang/*.js).

// Where a contract owner reads how to respond or ask for a correction.
const LEGAL = 'docs/LEGAL.md (web: /web/legal.html)';
import { readContract } from './src/reader.js';
import { createRpc } from './src/rpc.js';
import { makeEntry, entrySource } from './src/similarity.js';
import { THREAT_SIGNATURES } from './src/threat-signatures.js';
import { THREAT_REASONS } from './src/threat-reasons.js';
import { explain, LANGS, uiText } from './src/explain.js';
import { verdictOf } from './src/verdict.js';
import { CHAINS, explorerUrl, zetaphyCosmwasmChain } from './src/chains.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const VALUED = ['--lang', '--reason', '--flag-key', '--report-hash', '--sim-seed', '--rest', '--chain-id'];
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
const chains = Object.keys(CHAINS).join('|');

function usage() {
  console.error(`usage: node cli.js <${chains}> <address> [--lang ${Object.keys(LANGS).join('|')}] [--json] [--sim-seed 0x<32 bytes>]
       node cli.js fingerprint <${chains}> <address>
       node cli.js signature <${chains}> <address> [--reason cannot-sell-in-simulation|unlimited-mint|owner-can-block-transfers|owner-can-move-holder-funds|same-name-as-known-token|sweeps-approved-tokens|other]
                             [--flag-key 0x<ThreatRegistry key> --report-hash 0x<evidence reportHash>]`);
  process.exit(2);
}

async function fingerprint(chain, address) {
  if (CHAINS[chain]?.kind !== 'evm') throw new Error('fingerprints are for EVM contracts; other chains are recognised by their on-chain settings');
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

// A flagged contract's entry for Neuro's known-bad code dataset. Reads the
// code that actually runs (the implementation behind a proxy).
async function signature(chain, address, reason, flagRef) {
  const c = CHAINS[chain];
  if (c?.kind !== 'evm') throw new Error('similarity covers EVM bytecode only');
  const r = await readContract(chain, address, { sourcify: false, simulate: false, threatSignatures: false });
  if (!r.fingerprint) throw new Error('no EVM contract code at this address');
  const rpc = createRpc(c.rpcs, c.id);
  const code = await rpc.call('eth_getCode', [r.proxy?.implementation ?? r.address, 'latest']);
  const e = await makeEntry(code, THREAT_SIGNATURES.baseline, { reason, source: `${chain} ${r.proxy?.implementation ?? r.address}`, flag: flagRef });
  const risky = r.analysis.findings.filter((f) => f.severity === 'high' || f.severity === 'medium').map((f) => f.id);
  console.log(`// ${c.name} ${r.address}  (${r.token?.symbol ?? '?'}), rules found: ${risky.join(', ') || 'nothing high or medium'}`);
  if (e.n < 8) console.log('// WARNING: almost all of this code is ordinary token boilerplate; only an exact copy will match.');
  console.log('// Add only code the network flagged in the ThreatRegistry, with the behaviour documented and reproducible. Paste into ADDED in src/threat-signatures.js.');
  if (!flagRef) console.log('// No --flag-key/--report-hash: users will see this as "similar to a reference sample", never "flagged by runners".');
  else console.log(`// Check the flag first: ThreatRegistry.evidenceOf(${flagRef.key}) must return reportHash ${flagRef.reportHash}.`);
  console.log(entrySource(e));
}

try {
  if (positional[0] === 'signature') {
    if (!positional[1] || !positional[2]) usage();
    const reason = opt('--reason', 'cannot-sell-in-simulation');
    if (!THREAT_REASONS.slice(1).includes(reason)) usage();
    const key = opt('--flag-key');
    const reportHash = opt('--report-hash');
    if (!!key !== !!reportHash) usage();
    await signature(positional[1], positional[2], reason, key ? { key, reportHash } : null);
  } else if (positional[0] === 'fingerprint') {
    if (!positional[1] || !positional[2]) usage();
    await fingerprint(positional[1], positional[2]);
  } else {
    const [chain, address] = positional;
    if (!chain || !address) usage();
    const simSeed = opt('--sim-seed');
    if (simSeed !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(simSeed)) usage();
    const opts = simSeed ? { simSeed } : {};
    if (chain === 'zetaphy-wasm') {
      const rest = opt('--rest');
      if (!rest || !/^https?:\/\/[^\s]+$/.test(rest)) usage();
      opts.chainConfig = zetaphyCosmwasmChain([rest.replace(/\/+$/, '')], opt('--chain-id', 'zetaphy_77390-1'));
    }
    const report = await readContract(chain, address, opts);
    if (flag('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const lang = opt('--lang', 'en');
      const out = explain(report, lang);
      const ui = uiText(lang);
      const mark = { high: '!!', medium: '! ', low: '- ', info: '  ', good: '+ ' };
      console.log(`${(CHAINS[chain] ?? opts.chainConfig).name} ${report.address}`);
      console.log(`== ${out.title} ==`);
      for (const l of out.lines) console.log(`${mark[l.severity]} ${l.text}`);
      // Evidence: anyone can run the same command and compare the IDs.
      console.log(`\n${ui.m.report}: ${report.reportHash}`);
      console.log(`${ui.m.verdict}: ${await verdictOf(report)}`);
      console.log(`${ui.m.command}: node cli.js ${chain} ${report.address}${opts.chainConfig ? ` --rest ${opt('--rest')}` : ''} --lang ${lang}`);
      if (CHAINS[chain]) console.log(explorerUrl(chain, report.address));
      console.log(`\n${ui.disclaimer}\n${ui.correction}: ${LEGAL}`);
    }
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
