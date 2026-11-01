#!/usr/bin/env node
// The frontier button (src/frontierdeploy.js; .github/workflows/frontier-deploy.yml): deploys on the ZETAPHY testnet
// every frontier contract still missing, then the open audit network and offline trading, one transaction at a time
// from one key. Every governance is the ZetaphyTimelock of the launch state; the deploy key keeps no role.
//
//   node scripts/frontier-deploy.js [--treasury 0x…] [--router 0x…] [--mailbox 0x…] [--pq-validators 0x<keyHash>,… --pq-threshold 1]
//       deploys what the records do not have yet (a re-run resumes) and writes each record after every transaction:
//         deployments/frontier-77390.json   the frontier contracts, what was skipped and why
//         deployments/audit-77390.json      AuditNetwork, AuditRunners, AuditJudges, AuditCertificate (as `zetaphy deploy-audit`)
//         deployments/offline-77390.json    ZetaphyCheques, ZetaphyOfflineOrders, ZetaphyOfflineCash (as scripts/offline-deploy.js)
//         deployments/qsafe-77390.json      QuantumRescue, PQSettlement (the hub's Quantum tab)
//         ../zetaphy-chain/hyperlane/immune-network.json   registry, broadcaster, jobs
//   node scripts/frontier-deploy.js check
//       reads every contract back: code at each address, every governance() the timelock; fails otherwise
//
// Inputs: the launch state (timelock, NeuroJobs, ThreatRegistry, RewardVault = the audit treasury), deployments/ai-77390.json
// (LabelRegistry, VouchRegistry), zetaphy-chain/hyperlane/saphan-chains.json (ZETAPHY's Mailbox), zetaphy-dex/web/deployments.json (router).
// env: ZETAPHY_RPC (EVM JSON-RPC), KEYFILE (the deploy key, 0x… hex); for tests: LAUNCH_STATE and FRONTIER_FILE, AUDIT_FILE,
//      OFFLINE_FILE, QSAFE_FILE, AI_FILE, IMMUNE_FILE (default: the paths above). Refuses any chain but 77390.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { deployEverything, checkEverything, fromLaunchState, qsafeRecord, immuneNetworkUpdate } from '../src/frontierdeploy.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const die = (m) => { console.error(m); process.exit(1); };
const here = (p) => new URL(p, import.meta.url).pathname;
const FILES = {
  frontier: process.env.FRONTIER_FILE || here('../deployments/frontier-77390.json'),
  audit: process.env.AUDIT_FILE || here('../deployments/audit-77390.json'),
  offline: process.env.OFFLINE_FILE || here('../deployments/offline-77390.json'),
  qsafe: process.env.QSAFE_FILE || here('../deployments/qsafe-77390.json'),
  ai: process.env.AI_FILE || here('../deployments/ai-77390.json'),
  immune: process.env.IMMUNE_FILE || here('../../zetaphy-chain/hyperlane/immune-network.json'),
};
const STATE = process.env.LAUNCH_STATE || here('../../zetaphy-launch/state/77390.json');
const CHAINS = here('../../zetaphy-chain/hyperlane/saphan-chains.json');
const DEX = here('../../zetaphy-dex/web/deployments.json');
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const write = (f, r) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(r, null, 2)}\n`); };
const addr = (v) => (/^0x[0-9a-fA-F]{40}$/.test(String(v ?? '')) ? getAddress(v) : null);

const rpc = process.env.ZETAPHY_RPC || die('ZETAPHY_RPC is not set');
const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, polling: true, pollingInterval: 5000, cacheTimeout: -1 });
if (Number((await provider.getNetwork()).chainId) !== 77390) die('the RPC is not ZETAPHY (chain 77390)');
const records = { frontier: readJson(FILES.frontier), audit: readJson(FILES.audit), offline: readJson(FILES.offline) };

if (args[0] === 'check') {
  if (!records.frontier) die(`no ${FILES.frontier}: nothing deployed`);
  const rows = await checkEverything(provider, records);
  for (const r of rows) console.log(`${r.ok ? 'ok ' : 'BAD'} ${r.part} ${r.key} ${r.address ?? '(none)'}${r.governance ? ` governance ${r.governance}` : ''}`);
  for (const s of records.frontier.skipped ?? []) console.log(`skip ${s.what}: ${s.reason}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

const launch = JSON.parse(readFileSync(STATE, 'utf8'));
const st = fromLaunchState(launch);
const flat = Object.assign({}, ...Object.values(launch.steps ?? {}).map((s) => s.out ?? {}));
const ai = readJson(FILES.ai);
const aiOk = ai?.chainId === 77390 && ai.governance && st.gov && getAddress(ai.governance) === st.gov;
const list = (s) => (s ? s.split(',').map((v) => v.trim()).filter(Boolean) : []);
const pqValidators = list(opt('pq-validators'));
if (pqValidators.some((v) => !/^0x[0-9a-fA-F]{64}$/.test(v))) die('--pq-validators: ML-DSA-44 key hashes, 0x + 64 hex each, comma separated');
const o = { pqValidators, pqThreshold: Number(opt('pq-threshold', '1')) };
const inputs = {
  gov: st.gov, jobs: st.jobs, threats: st.threats,
  mailbox: addr(opt('mailbox')) ?? addr(readJson(CHAINS)?.zetaphy?.mailbox),
  labels: aiOk ? addr(ai.contracts?.labelRegistry) : null, vouch: aiOk ? addr(ai.contracts?.vouchRegistry) : null,
  treasury: addr(opt('treasury')) ?? addr(flat.rewardVault),
  router: addr(opt('router')) ?? addr(readJson(DEX)?.contracts?.router),
};
console.log(`governance (timelock) ${inputs.gov}; NeuroJobs ${inputs.jobs}; ThreatRegistry ${inputs.threats}; Mailbox ${inputs.mailbox}; `
  + `labels ${inputs.labels}; vouch ${inputs.vouch}; audit treasury ${inputs.treasury}; router ${inputs.router}`);

const key = readFileSync(process.env.KEYFILE || die('KEYFILE is not set'), 'utf8').trim();
const signer = new Wallet(key, provider);
const out = await deployEverything({ signer, ...inputs, records, o, log: console.log,
  saves: { frontier: (r) => write(FILES.frontier, r), audit: (r) => write(FILES.audit, r), offline: (r) => write(FILES.offline, r) } });

const qs = qsafeRecord(out.frontier);
if (qs) write(FILES.qsafe, qs);
if (out.frontier.contracts.immuneRegistry && existsSync(FILES.immune)) write(FILES.immune, immuneNetworkUpdate(readJson(FILES.immune), out.frontier, inputs.jobs));
console.log(`timelock getMinDelay() = ${out.frontier.timelockMinDelay} s`);
for (const [k, n] of Object.entries(out.frontier.notes ?? {})) console.log(`note ${k}: ${n}`);
for (const s of out.skipped) console.log(`skip ${s.what}: ${s.reason}`);
