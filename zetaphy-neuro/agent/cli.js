#!/usr/bin/env node
// Investigator command line.
//   node agent/cli.js graph <chain> <address> [--json] [--hops 3] [--requests 220]
//   node agent/cli.js investigate <chain> <address> [--json]
//   node agent/cli.js scan-pools [--dry-run]              (what the scheduled workflow runs)
//   node agent/cli.js runner --jobs 0x<NeuroJobs> --key-file <file> --registry 0x<NeuroIdentity> --agent <id> [--outbox neuro-outbox.ndjson] [--rpc URL] [--once]
// The runner mode signs with the runner's key through zetaphy-network
// (neuromsg.js + ethers, installed on runner machines by setup-runner.sh).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildFlowGraph } from '../graph/build.js';
import { signalText } from '../graph/i18n.js';
import { createEvmClient } from '../graph/clients.js';
import { ZETAPHY } from '../graph/sources.js';
import { investigate } from './pipeline.js';
import { scanPools } from './scan-pools.js';
import { createGraphRunner, outboxPost } from './runner.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--json', '--dry-run', '--once'].includes(args[i - 1])));
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

function printSignals(signals) {
  for (const s of signals) {
    const text = s.source && s.source !== 'graph' ? s.id : signalText(s, 'en');
    console.log(`  [${s.severity}] ${s.source ? `${s.source}: ` : ''}${text}`);
    for (const e of (s.evidence ?? []).slice(0, 4)) console.log(`      ${e.kind}: ${e.value}`);
  }
}

async function main() {
  const [cmd, chain, address] = positional;
  if (cmd === 'graph') {
    const g = await buildFlowGraph(chain, address, { maxHops: Number(opt('hops', 3)), maxRequests: Number(opt('requests', 220)), onProgress: (s) => process.stderr.write(`… ${s}\n`) });
    if (flag('json')) { console.log(json(g)); return; }
    console.log(`Money flow of ${g.address} on ${g.chain}: ${g.level}${g.partial ? ' (incomplete)' : ''} · ${g.stats.requests} requests, ${g.stats.ms} ms`);
    console.log(`  deployer: ${g.creation?.deployer ?? 'unknown'}${g.creation?.tx ? ` (tx ${g.creation.tx})` : ''}`);
    printSignals(g.signals);
    console.log(`  graph id: ${g.graphHash}`);
    return;
  }
  if (cmd === 'investigate') {
    const r = await investigate({ chain, address }, { onStep: (s, st) => process.stderr.write(`… ${s}: ${st}\n`) });
    if (flag('json')) { console.log(json(r)); return; }
    console.log(`Investigation of ${r.target.address} on ${r.target.chain}: ${r.level}, score ${r.score}/100, confidence ${r.confidence}`);
    for (const s of r.steps) console.log(`  step ${s.name}: ${s.status}${s.error ? ` (${s.error})` : ''}`);
    printSignals(r.signals.filter((s) => s.severity !== 'info'));
    if (r.review) console.log(`  advisory review (${r.review.model ?? 'llm'}): ${r.review.summary}`);
    console.log(`  report id: ${r.reportHash}`);
    return;
  }
  if (cmd === 'scan-pools') { await scanPools({ dryRun: flag('dry-run') }); return; }
  if (cmd === 'runner') {
    let neuromsg; let ethers;
    try {
      neuromsg = await import('../../zetaphy-network/src/neuromsg.js');
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const req = createRequire(new URL('../../zetaphy-network/package.json', import.meta.url));
      const mod = await import(pathToFileURL(req.resolve('ethers')).href);
      ethers = mod.Wallet ? mod : mod.default;
    } catch {
      console.error('runner mode needs zetaphy-network with its dependencies (cd zetaphy-network && npm ci), as on a runner machine');
      process.exit(2);
    }
    const wallet = new ethers.Wallet(readFileSync(opt('key-file'), 'utf8').trim());
    const rpc = createEvmClient([opt('rpc', ZETAPHY.rpc)], ZETAPHY.chainId);
    const stateFile = opt('state', 'neuro-graph-runner.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
    const runner = createGraphRunner({
      rpc, jobs: opt('jobs'), state, log: console.log,
      zetaphyChain: { kind: 'evm', id: ZETAPHY.chainId, name: 'ZETAPHY (testnet)', rpcs: [opt('rpc', ZETAPHY.rpc)] },
      sign: (payload) => neuromsg.signMessage(wallet, { chainId: ZETAPHY.chainId, registry: opt('registry'), fromAgent: opt('agent', '0'), sourceChain: 'zetaphy', kind: 'verdict', payload, ttl: 7 * 24 * 3600 }),
      post: await outboxPost(opt('outbox', 'neuro-outbox.ndjson')),
    });
    do {
      try { await runner.tick(); } catch (e) { console.log(`runner: ${String(e?.message ?? e).slice(0, 200)}`); }
      writeFileSync(stateFile, JSON.stringify(runner.state), { mode: 0o600 });
      if (!flag('once')) await new Promise((r) => setTimeout(r, 60_000));
    } while (!flag('once'));
    return;
  }
  console.error('usage: node agent/cli.js graph|investigate <chain> <address> [--json] | scan-pools [--dry-run] | runner --jobs 0x… --key-file … --registry 0x… --agent <id>');
  process.exit(2);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
