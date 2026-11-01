// The frontier button (src/frontierdeploy.js): every frontier contract that only needs ZETAPHY-side addresses, the
// open audit network, HackInsurance and offline trading, in one run, one key, each governance the timelock - with
// the testnet's 0-delay timelock. A second run deploys nothing; a stopped run resumes; the skips carry reasons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractFactory, getAddress, getCreateAddress } from 'ethers';
import { createRpcChain, ZETA } from './helpers/rpcchain.js';
import { dexArt } from './helpers/mocks.js';
import { deployEverything, deployFrontier, checkEverything, qsafeRecord, immuneNetworkUpdate, FRONTIER_STEPS, FRONTIER_SKIPPED } from '../src/frontierdeploy.js';

const ZERO = '0x' + '00'.repeat(20);

async function world({ delay = 0n } = {}) {
  const c = await createRpcChain({ accounts: 3 });
  const [key, multisig] = c.signers;
  const tl = await c.deploy('ZetaphyTimelock', [delay, [multisig.address], [ZERO], ZERO], key);
  const gov = getAddress(await tl.getAddress());
  const jobs = await c.deploy('NeuroJobs', [ZETA, ZETA / 10n, ZETA / 100n, 120, 600, 3600, 1000n * ZETA], key);
  const threats = await c.deploy('ThreatRegistry', [await jobs.getAddress(), 3, 1, gov, 0], key);
  const mailbox = await c.deploy('MockMailbox', [77390], key);
  const labels = await c.deploy('LabelRegistry', [gov, ZERO, ZERO, '0x' + '00'.repeat(32), 400n * 86400n], key);
  const vouch = await c.deploy('VouchRegistry', [await labels.getAddress(), gov], key);
  const dex = async (n, args) => { const k = await new ContractFactory(dexArt(n).abi, dexArt(n).bytecode, key).deploy(...args); await k.waitForDeployment(); return k.getAddress(); };
  const wz = await dex('WZETAPHY', []);
  const router = await dex('ZetaphyRouter', [await dex('ZetaphyFactory', [key.address]), wz]);
  const a = async (k) => getAddress(await k.getAddress());
  return { c, key, multisig, gov, router, treasury: multisig.address,
    inputs: { jobs: await a(jobs), threats: await a(threats), mailbox: await a(mailbox), labels: await a(labels), vouch: await a(vouch) } };
}

function files() {
  const f = { frontier: null, audit: null, offline: null, writes: { frontier: 0, audit: 0, offline: 0 } };
  const saves = Object.fromEntries(['frontier', 'audit', 'offline'].map((k) => [k, (r) => { f[k] = structuredClone(r); f.writes[k] += 1; }]));
  return { f, saves };
}

test('one run deploys everything deployable with a 0-delay timelock; every governance is the timelock; the key keeps no role', async () => {
  const w = await world({ delay: 0n });
  const { f, saves } = files();
  const lines = [];
  const out = await deployEverything({ signer: w.key, gov: w.gov, ...w.inputs, treasury: w.treasury, router: w.router, saves, log: (l) => lines.push(l) });
  const want = FRONTIER_STEPS.map((s) => s.key).filter((k) => k !== 'pqMultisigIsm');
  assert.deepEqual(Object.keys(out.frontier.contracts).sort(), want.sort());
  assert.equal(out.frontier.timelockMinDelay, 0);
  assert.equal(out.frontier.pending, undefined);
  for (const [k, a] of Object.entries(out.frontier.contracts)) assert.notEqual(await w.c.provider.getCode(a), '0x', k);
  assert.deepEqual(Object.keys(out.audit.contracts).sort(), ['auditCertificate', 'auditJudges', 'auditNetwork', 'auditRunners']);
  assert.deepEqual(Object.keys(out.offline.contracts).sort(), ['offlineCash', 'offlineOrders', 'zetaphyCheques']);
  // the records were written as they went (frontier: before and after each transaction)
  assert.deepEqual(f.frontier.contracts, out.frontier.contracts);
  assert.deepEqual(f.audit.contracts, out.audit.contracts);
  assert.deepEqual(f.offline.contracts, out.offline.contracts);
  assert.ok(f.writes.frontier >= 2 * want.length);
  assert.equal(f.frontier.auditPlan, undefined, 'the audit plan is dropped once the audit network is complete');

  const rows = await checkEverything(w.c.provider, out);
  assert.ok(rows.length >= want.length + 4 + 3);
  for (const r of rows) assert.ok(r.ok, `${r.part} ${r.key} ${r.governance}`);
  const governed = rows.filter((r) => r.governance);
  assert.deepEqual(governed.map((r) => r.key).sort(), ['auditCertificate', 'auditJudges', 'auditNetwork', 'circuitBreaker', 'hackInsurance', 'immuneBroadcaster', 'immuneRegistry', 'quantumRescue', 'zkIdentityRegistry'].sort());
  for (const r of governed) assert.equal(r.governance, w.gov);

  // wiring: what each contract was built with
  const fc = out.frontier.contracts;
  assert.equal(getAddress(await w.c.at('ImmuneRegistry', fc.immuneRegistry).jobs()), w.inputs.jobs);
  assert.equal(Number(await w.c.at('ImmuneRegistry', fc.immuneRegistry).minAgreed()), 2);
  assert.equal(getAddress(await w.c.at('ImmuneBroadcaster', fc.immuneBroadcaster).registry()), fc.immuneRegistry);
  assert.equal(getAddress(await w.c.at('CircuitBreaker', fc.circuitBreaker).runners()), w.inputs.jobs);
  assert.equal(await w.c.at('QuantumRescue', fc.quantumRescue).security(), '0x0000000000000000000000000000000000000901');
  assert.equal(Number(await w.c.at('QuantumRescue', fc.quantumRescue).maturity()), 720);
  const zk = w.c.at('ZkIdentityRegistry', fc.zkIdentityRegistry);
  assert.equal(getAddress(await zk.verifier()), fc.zkIdentityVerifier);
  assert.equal(getAddress(await zk.poseidon()), fc.poseidonT3);
  assert.equal(getAddress(await zk.labels()), w.inputs.labels);
  assert.equal(await w.c.at('ZkIdentityVerifier', fc.zkIdentityVerifier).DEV_SETUP(), true);
  assert.match(out.frontier.notes.zkIdentityVerifier, /DEV trusted setup/);
  assert.equal(getAddress(await w.c.at('PrivatePoll', fc.privatePoll).registry()), fc.zkIdentityRegistry);
  assert.equal(getAddress(await w.c.at('HackInsurance', fc.hackInsurance).runners()), w.inputs.jobs);
  assert.equal(getAddress(await w.c.at('AuditNetwork', out.audit.contracts.auditNetwork).treasury()), getAddress(w.treasury));

  // the skips, with reasons: PQMultisigIsm (no validator set) and the fixed list
  const skip = Object.fromEntries(out.skipped.map((s) => [s.what, s.reason]));
  assert.match(skip['PQMultisigIsm (pqMultisigIsm)'], /ML-DSA-44 validator set/);
  for (const s of FRONTIER_SKIPPED) assert.equal(skip[s.what], s.reason);
  for (const name of ['TrainingPool', 'ProvenVerdicts', 'StarkLightClient', 'BtcLightClient', 'ZetaphyBridgeInbox', 'ImmuneMirror', 'NeuroJobs']) {
    assert.ok(out.skipped.some((s) => s.what.includes(name) && s.reason.length > 20), name);
  }
  assert.ok(lines.some((l) => /pqMultisigIsm: skipped/.test(l)));

  // a second run deploys nothing and sends no transaction
  const nonce = await w.c.provider.getTransactionCount(w.key.address);
  const lines2 = [];
  const again = await deployEverything({ signer: w.key, gov: w.gov, ...w.inputs, treasury: w.treasury, router: w.router,
    records: { frontier: structuredClone(f.frontier), audit: structuredClone(f.audit), offline: structuredClone(f.offline) }, log: (l) => lines2.push(l) });
  assert.equal(await w.c.provider.getTransactionCount(w.key.address), nonce);
  assert.deepEqual(again.frontier.contracts, out.frontier.contracts);
  assert.deepEqual(again.audit.contracts, out.audit.contracts);
  assert.ok(lines2.some((l) => /audit network: already/.test(l)) && lines2.some((l) => /offline trading: already/.test(l)));

  // the hub's quantum-safe record and the immune network file
  assert.deepEqual(qsafeRecord(out.frontier), { chainId: 77390, governance: w.gov, contracts: { quantumRescue: fc.quantumRescue, pqSettlement: fc.pqSettlement } });
  const imm = immuneNetworkUpdate({ registry: null, broadcaster: null, jobs: null, minAgreed: 2 }, out.frontier, w.inputs.jobs);
  assert.deepEqual([imm.registry, imm.broadcaster, imm.jobs, imm.minAgreed], [fc.immuneRegistry, fc.immuneBroadcaster, w.inputs.jobs, 2]);
  assert.throws(() => immuneNetworkUpdate({ registry: w.gov }, out.frontier, w.inputs.jobs), /registry/);
});

test('the skip reason is real: TrainingPool refuses the 0-delay timelock the button keeps', async () => {
  const w = await world({ delay: 0n });
  await assert.rejects(w.c.deploy('TrainingPool', [w.gov, ZETA, 3600], w.key));
});

test('missing inputs skip with reasons; the check fails on a governance that is not the timelock; refusals', async () => {
  const w = await world();
  const lines = [];
  const out = await deployEverything({ signer: w.key, gov: w.gov, record: null, labels: null, vouch: null, jobs: null, threats: null, mailbox: null,
    treasury: null, router: null, log: (l) => lines.push(l) });
  const got = Object.keys(out.frontier.contracts).sort();
  assert.deepEqual(got, ['pqSettlement', 'poseidonT3', 'quantumRescue', 'zetaphyOutbox', 'zkIdentityVerifier'].sort());
  const skip = Object.fromEntries(out.skipped.map((s) => [s.what, s.reason]));
  assert.match(skip['ImmuneRegistry (immuneRegistry)'], /NeuroJobs/);
  assert.match(skip['ImmuneBroadcaster (immuneBroadcaster)'], /Mailbox/);
  assert.match(skip['ZkIdentityRegistry (zkIdentityRegistry)'], /LabelRegistry/);
  assert.match(skip['PrivatePoll (privatePoll)'], /zkIdentityRegistry \(not deployed\)/);
  assert.match(skip['AuditNetwork, AuditRunners, AuditJudges, AuditCertificate'], /NeuroJobs/);
  assert.match(skip['ZetaphyCheques, ZetaphyOfflineOrders, ZetaphyOfflineCash'], /router/);
  assert.equal(out.audit, null);
  // an address with no code is not taken for a contract
  const fake = { ...w.inputs, mailbox: getAddress('0x' + '42'.repeat(20)) };
  const lines2 = [];
  await deployFrontier({ signer: w.key, gov: w.gov, ...fake, record: structuredClone(out.frontier), only: ['immuneRegistry', 'immuneBroadcaster'], log: (l) => lines2.push(l) });
  assert.ok(lines2.some((l) => /immuneBroadcaster: skipped \(needs .*no code at/.test(l)));

  // a contract whose governance is not the timelock fails the check
  const rogue = await w.c.deploy('QuantumRescue', [ZERO, w.key.address, 10], w.key);
  const bad = structuredClone(out.frontier);
  bad.contracts.quantumRescue = getAddress(await rogue.getAddress());
  const rows = await checkEverything(w.c.provider, { frontier: bad });
  assert.equal(rows.find((r) => r.key === 'quantumRescue').ok, false);

  await assert.rejects(deployFrontier({ signer: w.key, gov: w.key.address }), /timelock/);
  await assert.rejects(deployFrontier({ signer: w.key, gov: getAddress('0x' + '33'.repeat(20)) }), /no code/);
  await assert.rejects(deployFrontier({ signer: w.key, gov: w.inputs.labels, record: structuredClone(out.frontier) }), /governance/);
});

test('a stopped run resumes: a deploy that landed after the stop is adopted, not deployed twice; a half-deployed audit network is finished at its planned addresses', async () => {
  const w = await world();
  // the frontier: a run that sent PQSettlement's deploy and stopped before recording it
  let saved = null;
  await assert.rejects(deployFrontier({ signer: w.key, gov: w.gov, only: ['pqSettlement'],
    save: (r) => { saved = structuredClone(r); if (r.pending?.hash) throw new Error('the runner stopped'); } }), /stopped/);
  assert.equal(saved.pending.key, 'pqSettlement');
  assert.equal(saved.contracts.pqSettlement, undefined);
  const nonce = await w.c.provider.getTransactionCount(w.key.address);
  const lines = [];
  const landed = saved.pending.address;
  const rec = await deployFrontier({ signer: w.key, gov: w.gov, record: saved, only: ['pqSettlement'], log: (l) => lines.push(l) });
  assert.equal(rec.contracts.pqSettlement, landed);
  assert.equal(await w.c.provider.getTransactionCount(w.key.address), nonce, 'no second PQSettlement');
  assert.ok(lines.some((l) => /landed after the stopped run/.test(l)));
  assert.equal(rec.pending, undefined);

  // the audit network: a run that deployed AuditNetwork and AuditRunners, then stopped
  const { deployAuditNetwork } = await import('../src/auditnetops.js');
  let plan = null;
  let sent = 0;
  const start = await w.c.provider.getTransactionCount(w.key.address);
  const counting = new Proxy(w.key, { get: (t, p) => (p === 'sendTransaction' ? async (tx) => { if (++sent > 2) throw new Error('the runner stopped'); return t.sendTransaction(tx); } : (typeof t[p] === 'function' ? t[p].bind(t) : t[p])) });
  await assert.rejects(deployAuditNetwork({ signer: counting, governance: w.gov, treasury: w.treasury, jobs: w.inputs.jobs, onPlan: (p) => { plan = p; } }), /stopped/);
  assert.equal(plan.nonce, start);
  assert.notEqual(await w.c.provider.getCode(plan.contracts.auditRunners), '0x');
  assert.equal(await w.c.provider.getCode(plan.contracts.auditJudges), '0x');
  const fr = { ...structuredClone(rec), auditPlan: plan };
  const { f, saves } = files();
  const out = await deployEverything({ signer: w.key, gov: w.gov, ...w.inputs, treasury: w.treasury, router: w.router, records: { frontier: fr }, saves, parts: ['audit'] });
  assert.deepEqual(out.audit.contracts, plan.contracts);
  assert.equal(plan.contracts.auditCertificate, getAddress(getCreateAddress({ from: w.key.address, nonce: start + 3 })));
  for (const a of Object.values(out.audit.contracts)) assert.notEqual(await w.c.provider.getCode(a), '0x');
  assert.equal(f.frontier.auditPlan, undefined);
  for (const r of await checkEverything(w.c.provider, { frontier: out.frontier, audit: out.audit })) assert.ok(r.ok, r.key);
});

test('scripts/frontier-deploy.js: deploys into a fresh directory (creates it), check passes, a re-run sends nothing', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { serveRpc } = await import('./helpers/rpcchain.js');
  const run = promisify(execFile);
  const w = await world();
  const node = await serveRpc(w.c, 18143);
  const dir = mkdtempSync(join(tmpdir(), 'frontier-'));
  try {
    const out = join(dir, 'not-yet', 'deployments');
    const state = join(dir, 'state.json');
    writeFileSync(state, JSON.stringify({ steps: { neuro: { out: { neuroJobs: w.inputs.jobs } }, threats: { out: { threatRegistry: w.inputs.threats } },
      vault: { out: { rewardVault: w.treasury } }, timelock: { out: { timelock: w.gov } } } }));
    writeFileSync(join(dir, 'ai.json'), JSON.stringify({ chainId: 77390, governance: w.gov, contracts: { labelRegistry: w.inputs.labels, vouchRegistry: w.inputs.vouch } }));
    writeFileSync(join(dir, 'immune.json'), JSON.stringify({ registry: null, broadcaster: null, jobs: null, minAgreed: 2, mirrors: {} }));
    writeFileSync(join(dir, 'key'), w.key.privateKey);
    const env = { ...process.env, ZETAPHY_RPC: node.url, KEYFILE: join(dir, 'key'), LAUNCH_STATE: state, AI_FILE: join(dir, 'ai.json'), IMMUNE_FILE: join(dir, 'immune.json'),
      FRONTIER_FILE: join(out, 'frontier-77390.json'), AUDIT_FILE: join(out, 'audit-77390.json'), OFFLINE_FILE: join(out, 'offline-77390.json'), QSAFE_FILE: join(out, 'qsafe-77390.json') };
    const script = new URL('../scripts/frontier-deploy.js', import.meta.url).pathname;
    const a = await run('node', [script, '--mailbox', w.inputs.mailbox, '--router', w.router], { env, timeout: 120_000 });
    assert.doesNotMatch(a.stdout + a.stderr, new RegExp(w.key.privateKey.slice(2)), 'the key is never printed');
    assert.match(a.stdout, /skip PQMultisigIsm \(pqMultisigIsm\): needs an ML-DSA-44 validator set/);
    const fr = JSON.parse(readFileSync(env.FRONTIER_FILE, 'utf8'));
    assert.equal(Object.keys(fr.contracts).length, FRONTIER_STEPS.length - 1);
    assert.ok(existsSync(env.AUDIT_FILE) && existsSync(env.OFFLINE_FILE));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(env.QSAFE_FILE, 'utf8')).contracts), ['quantumRescue', 'pqSettlement']);
    assert.equal(JSON.parse(readFileSync(env.IMMUNE_FILE, 'utf8')).registry, fr.contracts.immuneRegistry);
    const chk = await run('node', [script, 'check'], { env, timeout: 120_000 });
    assert.doesNotMatch(chk.stdout, /^BAD/m);
    assert.match(chk.stdout, /ok  audit auditNetwork/);
    const nonce = await w.c.provider.getTransactionCount(w.key.address);
    await run('node', [script, '--mailbox', w.inputs.mailbox, '--router', w.router], { env, timeout: 120_000 });
    assert.equal(await w.c.provider.getTransactionCount(w.key.address), nonce);
  } finally {
    await node.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
