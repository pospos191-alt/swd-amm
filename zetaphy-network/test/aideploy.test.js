// One run deploys every AI-map contract that had no deploy step, each owned by the timelock (src/aideploy.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { createRpcChain } from './helpers/rpcchain.js';
import { deployAi, checkGovernance, fromLaunchState, AI_STEPS } from '../src/aideploy.js';

const ZERO = '0x' + '00'.repeat(20);

async function world() {
  const c = await createRpcChain({ accounts: 3 });
  const [key, multisig] = c.signers;
  const tl = await c.deploy('ZetaphyTimelock', [60n, [multisig.address], [ZERO], ZERO], key);
  const flags = await c.deploy('ThreatRegistry', [ZERO, 3, 1, key.address, 0], key).catch(() => null);
  return { c, key, gov: getAddress(await tl.getAddress()), threats: flags ? await flags.getAddress() : null };
}

test('deploys all, hands every contract to the timelock, wires RiskForecasts into Foresight', async () => {
  const { c, key, gov, threats } = await world();
  const saves = [];
  const jobs = getAddress('0x' + '11'.repeat(20)); // NeuroAttest only stores it
  const rec = await deployAi({ signer: key, gov, jobs, threats, save: (r) => saves.push(Object.keys(r.contracts).length) });
  const want = AI_STEPS.filter((s) => s.key !== 'riskForecasts' || threats).map((s) => s.key);
  assert.deepEqual(Object.keys(rec.contracts).sort(), want.sort());
  for (const [k, a] of Object.entries(rec.contracts)) assert.notEqual(await c.provider.getCode(a), '0x', k);
  assert.ok(saves.length >= want.length, 'saved after each contract');
  const gs = await checkGovernance(c.provider, rec);
  assert.ok(gs.length >= 10);
  for (const g of gs) assert.ok(g.ok, `${g.key} governance ${g.governance}`);
  const fs = c.at('ForesightRegistry', rec.contracts.foresight);
  assert.ok(threats, "the test chain has a ThreatRegistry");
  assert.equal(await fs.resolvers(rec.contracts.riskForecasts), true);
  const labels = c.at('LabelRegistry', rec.contracts.labelRegistry);
  assert.equal(getAddress(await labels.agents()), rec.contracts.agentRegistry);
  const reg = c.at('AgentRegistry', rec.contracts.agentRegistry);
  assert.equal(await reg.approvedChecker(rec.contracts.constitutionChecker), true, 'AR-2: the checker is approved before the handover');
});

test('a second run deploys nothing; refuses the key as governance and a record for another governance', async () => {
  const { key, gov, threats } = await world();
  const rec = await deployAi({ signer: key, gov, threats, only: ['arena', 'intentExecutor'] });
  assert.deepEqual(Object.keys(rec.contracts).sort(), ['arena', 'intentExecutor']);
  const lines = [];
  const again = await deployAi({ signer: key, gov, threats, record: structuredClone(rec), only: ['arena', 'intentExecutor'], log: (l) => lines.push(l) });
  assert.deepEqual(again.contracts, rec.contracts);
  assert.ok(lines.every((l) => /already at/.test(l)));
  await assert.rejects(deployAi({ signer: key, gov: key.address }), /timelock/);
  await assert.rejects(deployAi({ signer: key, gov: getAddress('0x' + '22'.repeat(20)), record: structuredClone(rec) }), /governance/);
});

test('NeuroAttest and RiskForecasts wait for the launch state; fromLaunchState picks the addresses', async () => {
  const { key, gov } = await world();
  const lines = [];
  const rec = await deployAi({ signer: key, gov, only: ['neuroAttest', 'foresight', 'riskForecasts'], log: (l) => lines.push(l) });
  assert.deepEqual(Object.keys(rec.contracts), ['foresight']);
  assert.ok(lines.some((l) => /neuroAttest: skipped \(needs jobs/.test(l)));
  const s = fromLaunchState({ steps: { neuro: { out: { neuroJobs: '0x' + 'aa'.repeat(20) } }, timelock: { out: { timelock: '0x' + 'bb'.repeat(20) } } } });
  assert.equal(s.gov, getAddress('0x' + 'bb'.repeat(20)));
  assert.equal(s.jobs, getAddress('0x' + 'aa'.repeat(20)));
  assert.equal(s.threats, null);
});
