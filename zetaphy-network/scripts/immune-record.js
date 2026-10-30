#!/usr/bin/env node
// Records what a sentinel reads into a fixture (test/fixtures/immune/<name>.json) that tests replay offline
// (src/immune/rpc.js fixtureRpc). Two sources:
//   node scripts/immune-record.js --mock [--out test/fixtures/immune/sepolia-attacks.json]
//        the deterministic attack scenarios of src/immune/scenarios.js on the mock multi-chain
//   node scripts/immune-record.js --live <chain key> [--blocks 5] [--out file]
//        a free public RPC of src/immune/chains.js (rate-limited, read only, no key); public endpoints are often
//        blocked from CI and sandboxes, so the committed fixtures come from --mock unless their name says "live"
import { writeFileSync } from 'node:fs';
import { createRpc, recordingRpc } from '../src/immune/rpc.js';
import { EvmSentinel } from '../src/immune/sentinel.js';
import { byKey } from '../src/immune/chains.js';
import { evmAttacks } from '../src/immune/scenarios.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

async function main() {
  if (args.includes('--live')) {
    const chain = byKey(opt('--live'));
    if (!chain || chain.kind !== 'evm') throw new Error('--live <evm chain key of src/immune/chains.js>');
    const rec = recordingRpc(createRpc({ urls: chain.rpc, rps: chain.rps }));
    const s = new EvmSentinel({ chain, rpc: rec, lookback: Number(opt('--blocks', 5)), maxBlocks: Number(opt('--blocks', 5)) });
    const reports = await s.tick();
    const out = opt('--out', `test/fixtures/immune/${chain.key}-live.json`);
    writeFileSync(out, JSON.stringify({ chain: chain.key, source: 'live', ...rec.fixture, reports: reports.length }, null, 1) + '\n');
    console.log(`${out}: ${Object.keys(rec.fixture.calls).length} calls, ${reports.length} report(s)`);
    return;
  }
  const sc = evmAttacks();
  const rec = recordingRpc(sc.chain.rpc());
  const s = new EvmSentinel({ chain: { key: 'sepolia', id: sc.chain.id }, rpc: rec, protocols: sc.protocols, allowlist: sc.allowlist, state: { next: sc.start - 7 }, maxBlocks: 50, now: () => 1_800_000_000 });
  const reports = await s.tick();
  const out = opt('--out', 'test/fixtures/immune/sepolia-attacks.json');
  const fixture = { chain: 'sepolia', source: 'mock (src/immune/scenarios.js evmAttacks)', recordedAt: '2026-10-30T00:00:00.000Z', start: sc.start - 7,
    protocols: sc.protocols, allowlist: sc.allowlist, expect: reports.map((r) => ({ detector: r.bundle.detector, kind: r.finding.kind, address: r.address })), calls: rec.fixture.calls };
  writeFileSync(out, JSON.stringify(fixture) + '\n');
  console.log(`${out}: ${Object.keys(fixture.calls).length} calls, ${reports.length} report(s): ${fixture.expect.map((e) => `${e.detector}/${e.kind}`).join(' ')}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
