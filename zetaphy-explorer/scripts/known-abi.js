// Part of `npm run build` (after vendor/zetaphy-lib.js): writes src/known-abi.js, this
// repo's own contracts as a compact signature table. From every artifact in
// zetaphy-network, zetaphy-dex and zetaphy-nft it keeps the function / event / error
// signatures (not the artifacts: no bytecode, no sources), each contract's runtime code
// hash and Neuro fp1 fingerprint (to recognise a deployed copy), and the addresses the
// deployment records name. The tx and contract pages mark what they decode with it "known".
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromJsonAbi, toCompact, keccakHex, parseCompact } from '../src/abi.js';
import { fingerprint1, hexToBytes } from '../vendor/zetaphy-lib.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = ROOT + '../';
const SOURCES = ['zetaphy-network', 'zetaphy-dex', 'zetaphy-nft'];

const fnSet = new Set(); const evSet = new Set(); const erSet = new Set();
const contracts = [];
for (const src of SOURCES) {
  const dir = `${REPO}${src}/artifacts/`;
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const art = JSON.parse(readFileSync(dir + file, 'utf8'));
    const abi = fromJsonAbi(art.abi);
    const c = { name: String(art.contractName ?? file.replace(/\.json$/, '')), source: src };
    c.f = abi.functions.map(toCompact); c.e = abi.events.map(toCompact); c.r = abi.errors.map(toCompact);
    c.f.forEach((x) => fnSet.add(x)); c.e.forEach((x) => evSet.add(x)); c.r.forEach((x) => erSet.add(x));
    const code = typeof art.deployedBytecode === 'string' ? art.deployedBytecode : '0x';
    if (code.length > 2 && /^0x([0-9a-fA-F]{2})+$/.test(code)) { c.codeHash = '0x' + keccakHex(hexToBytes(code)); c.fp1 = fingerprint1(code); }
    contracts.push(c);
  }
}
const functions = [...fnSet].sort(); const events = [...evSet].sort(); const errors = [...erSet].sort();
const index = (list) => new Map(list.map((x, i) => [x, i]));
const fi = index(functions); const ei = index(events); const ri = index(errors);
const table = contracts.map((c) => ({ name: c.name, source: c.source, ...(c.codeHash ? { codeHash: c.codeHash, fp1: c.fp1 } : {}),
  f: c.f.map((x) => fi.get(x)), e: c.e.map((x) => ei.get(x)), r: c.r.map((x) => ri.get(x)) }));
const byName = (n) => table.findIndex((c) => c.name === n);

// Deployment records -> address: [contract index, label]
const addresses = {};
const put = (addr, name, label) => { const i = byName(name); if (i >= 0 && /^0x[0-9a-fA-F]{40}$/.test(String(addr ?? ''))) addresses[addr.toLowerCase()] = [i, label]; };
const readJson = (p) => { try { return JSON.parse(readFileSync(REPO + p, 'utf8')); } catch { return null; } };
const dex = readJson('zetaphy-dex/web/deployments.json');
if (dex) {
  const c = dex.contracts ?? {};
  put(c.factory, 'ZetaphyFactory', 'ZETAPHY Swap factory'); put(c.router, 'ZetaphyRouter', 'ZETAPHY Swap');
  put(c.dlmmFactory, 'ZetaphyDlmmFactory', 'ZETAPHY Swap DLMM factory'); put(c.dlmmRouter, 'ZetaphyDlmmRouter', 'ZETAPHY Swap DLMM');
  for (const tk of dex.tokens ?? []) put(tk.address, 'TestToken', `${tk.symbol} token`);
}
const nft = readJson('zetaphy-nft/web/deployments.json');
if (nft) { put(nft.factory, 'NFTFactory', 'ZETAPHY NFT factory'); put(nft.marketplace, 'NFTMarketplace', 'ZETAPHY NFT marketplace'); }
const launch = readJson('zetaphy-launch/state/77390.json');
const LAUNCH = {
  neuroJobs: ['NeuroJobs', 'Neuro jobs'], neuroControl: ['NeuroControl', 'Neuro control'], threatRegistry: ['ThreatRegistry', 'ThreatRegistry'],
  threatReports: ['ThreatReports', 'ThreatReports'], neuroIdentity: ['NeuroIdentity', 'Neuro identity'], neuroValidation: ['NeuroValidation', 'Neuro validation'],
  rewardVault: ['RewardVault', 'Reward vault'], quantumWalletFactory: ['QuantumWalletFactory', 'Quantum wallet factory'], tUSDC: ['TestStable', 'tUSDC token'],
  tUSDT: ['TestStable', 'tUSDT token'], stableGateway: ['StableGateway', 'Stable gateway'], computeMarket: ['ComputeMarket', 'Compute market'],
  twapRecorder: ['TwapRecorder', 'TWAP recorder'], pythRelay: ['ZetaphyPythRelay', 'Pyth relay'], oracle: ['ZetaphyOracle', 'ZETAPHY oracle'],
  zetaPair: ['ZetaphyPair', 'ZETAPHY Swap pair'], guardianMultisig: ['SimpleMultisig', 'Guardian multisig'], timelock: ['ZetaphyTimelock', 'ZETAPHY timelock'],
};
for (const step of Object.values(launch?.steps ?? {})) for (const [k, v] of Object.entries(step.out ?? {})) if (LAUNCH[k]) put(v, ...LAUNCH[k]);

const sorted = Object.entries(addresses).sort(([a], [b]) => (a < b ? -1 : 1));
const lines = (list) => list.map((x) => `    ${JSON.stringify(x)},`).join('\n');
// [selector (8 hex) or the first 16 hex of the event topic, compact signature]: looked up without hashing
const keyed = (kind, list) => list.map((s) => { const f = parseCompact(kind, s); return [kind === 'event' ? f.topic.slice(2, 18) : f.selector, s]; });
writeFileSync(ROOT + 'src/known-abi.js', `// Generated by \`npm run build\` in zetaphy-explorer/ (scripts/known-abi.js) from the artifacts of
// ${SOURCES.join(', ')} and the deployment records (zetaphy-dex/web, zetaphy-nft/web,
// zetaphy-launch/state). Do not edit by hand. Signatures are [selector or first 16 hex of the event
// topic, abi.js compact form]; each contract lists indexes into them.
export const KNOWN = {
  functions: [
${lines(keyed('function', functions))}
  ],
  events: [
${lines(keyed('event', events))}
  ],
  errors: [
${lines(keyed('error', errors))}
  ],
  contracts: [
${lines(table)}
  ],
  addresses: {
${sorted.map(([a, v]) => `    ${JSON.stringify(a)}: ${JSON.stringify(v)},`).join('\n')}
  },
};
`);
console.log(`src/known-abi.js written: ${table.length} contracts, ${functions.length} functions, ${events.length} events, ${errors.length} errors, ${sorted.length} addresses`);
