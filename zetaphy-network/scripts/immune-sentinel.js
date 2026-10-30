#!/usr/bin/env node
// Runs immune sentinels (src/immune/sentinel.js) once over free public RPCs, or replays a recorded fixture.
// Read only: it never signs anything. Each finding is written as a report (finding + evidence bundle, named by
// the bundle's IPFS CID) for a runner / the requester to submit as a NeuroJobs "immune" job (agree.js jobTarget).
//   node scripts/immune-sentinel.js --chains sepolia,basesepolia [--state .immune/state.json] [--out .immune/reports]
//   node scripts/immune-sentinel.js --fixture test/fixtures/immune/sepolia-attacks.json
// The cursor per chain is saved after every chain (resumable); vaccines come from the feed (--feed <url>).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRpc, fixtureRpc } from '../src/immune/rpc.js';
import { byKey } from '../src/immune/chains.js';
import { EvmSentinel, SolanaSentinel, CosmosSentinel, lcdClient } from '../src/immune/sentinel.js';
import { VaccineSet } from '../src/immune/vaccines.js';
import { jobTarget } from '../src/immune/agree.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = opt('--out', '.immune/reports');
const big = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

function save(reports) {
  mkdirSync(out, { recursive: true });
  for (const r of reports) {
    writeFileSync(join(out, `${r.cid}.json`), JSON.stringify({ target: jobTarget(r), finding: r.finding, bundle: r.bundle, label: r.label }, big, 1) + '\n');
    console.log(`  ${r.bundle.detector.padEnd(13)} kind ${r.finding.kind} sev ${r.finding.severity} ${r.address} -> ${r.cid}`);
  }
}

async function main() {
  const vaccines = new VaccineSet();
  if (opt('--feed')) {
    const f = await (await fetch(opt('--feed').replace(/\/?$/, '/feed.json'))).json();
    for (const v of f.vaccines ?? []) vaccines.add(v);
  }
  if (opt('--fixture')) {
    const fx = JSON.parse(readFileSync(opt('--fixture'), 'utf8'));
    const c = byKey(fx.chain);
    const s = new EvmSentinel({ chain: c, rpc: fixtureRpc(fx), vaccines, protocols: fx.protocols ?? [], allowlist: fx.allowlist ?? [], state: { next: fx.start }, maxBlocks: 1000 });
    const r = await s.tick();
    console.log(`${fx.chain} (fixture, ${fx.source}): ${r.length} report(s)`);
    save(r);
    return;
  }
  const statePath = opt('--state', '.immune/state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  for (const key of String(opt('--chains', 'sepolia')).split(',')) {
    const c = byKey(key);
    if (!c) { console.error(`unknown chain ${key}`); continue; }
    state[key] ??= {};
    const rpc = c.kind === 'cosmwasm' ? lcdClient({ urls: c.rpc }) : createRpc({ urls: c.rpc, rps: c.rps });
    const s = c.kind === 'evm' ? new EvmSentinel({ chain: c, rpc, vaccines, state: state[key] })
      : c.kind === 'solana' ? new SolanaSentinel({ chain: c, rpc, state: state[key] }) : new CosmosSentinel({ chain: c, rpc, vaccines, state: state[key] });
    try {
      const r = await s.tick();
      console.log(`${key}: next ${state[key].next}, ${r.length} report(s)`);
      save(r);
    } catch (e) { console.error(`${key}: ${String(e.message).slice(0, 160)} (cursor kept at ${state[key].next})`); }
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 1) + '\n');
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
