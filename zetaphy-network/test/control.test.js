import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBytes32String } from 'ethers';
import { createChain } from './helpers/evm.js';

const SKILL = '0x' + 'ab'.repeat(32), SKILL2 = '0x' + 'cd'.repeat(32);
const BSC = encodeBytes32String('bsc'), ETH = encodeBytes32String('eth');
let c, ctl;
const a = (n) => c.acct[n].toString();
beforeEach(async () => {
  c = await createChain(['gov', 'fund', 'guardian', 'r1', 'r2', 'thief', 'o1', 'o2', 'o3']);
  ctl = await c.deploy('NeuroControl', [a('gov'), a('fund'), 8, 2], 'gov');
});

test('constructor refuses missing addresses and silly sizes', async () => {
  const Z = '0x' + '00'.repeat(20);
  await assert.rejects(c.deploy('NeuroControl', [Z, a('fund'), 8, 2], 'gov'));
  await assert.rejects(c.deploy('NeuroControl', [a('gov'), Z, 8, 2], 'gov'));
  await assert.rejects(c.deploy('NeuroControl', [a('gov'), a('fund'), 3, 2], 'gov'));
  await assert.rejects(c.deploy('NeuroControl', [a('gov'), a('fund'), 8, 0], 'gov'));
  assert.equal(await ctl.call('BURN'), '0x000000000000000000000000000000000000dEaD');
  assert.equal(await ctl.call('paused'), false);
});

test('only governance changes the knobs', async () => {
  const calls = [['unpause', []], ['setGuardian', [a('thief'), true]], ['setGovernance', [a('thief')]], ['approveSkill', [SKILL]],
    ['revokeSkill', [SKILL]], ['setActiveSkill', [SKILL]], ['approveDefender', [a('r1')]], ['removeDefender', [a('r1')]],
    ['release', [a('r1')]], ['setMaxBodies', [100]], ['setMaxRegrowPerHour', [4]], ['setCommunityFund', [a('thief')]],
    ['approveChain', [BSC]], ['approveChains', [[BSC]]], ['removeChain', [BSC]],
    ['setChallengeBond', [1n]], ['setChallengeWindow', [600]], ['setDefenderTimeout', [600]]];
  for (const [fn, args] of calls) await assert.rejects(ctl.send('thief', fn, args), /NotGovernance/, fn);
  await assert.rejects(ctl.send('thief', 'pause'), /NotGuardian/);
});

test('stop button: a guardian pauses at once, only governance unpauses', async () => {
  await ctl.send('gov', 'setGuardian', [a('guardian'), true]);
  const ev = await ctl.send('guardian', 'pause');
  assert.ok(ev.some((e) => e?.name === 'Paused'));
  assert.equal(await ctl.call('paused'), true);
  await assert.rejects(ctl.send('guardian', 'unpause'), /NotGovernance/);
  await ctl.send('gov', 'unpause');
  assert.equal(await ctl.call('paused'), false);
  await ctl.send('gov', 'pause'); // governance may pause too
  assert.equal(await ctl.call('paused'), true);
});

test('skills: only an approved skill becomes active; the active one cannot be revoked', async () => {
  await assert.rejects(ctl.send('gov', 'setActiveSkill', [SKILL]), /NotApproved/);
  await assert.rejects(ctl.send('gov', 'approveSkill', ['0x' + '00'.repeat(32)]), /BadValue/);
  await ctl.send('gov', 'approveSkill', [SKILL]);
  assert.equal(await ctl.call('skillApproved', [SKILL]), true);
  await ctl.send('gov', 'setActiveSkill', [SKILL]);
  assert.equal(await ctl.call('activeSkill'), SKILL);
  await assert.rejects(ctl.send('gov', 'revokeSkill', [SKILL]), /SkillInUse/);
  await ctl.send('gov', 'approveSkill', [SKILL2]);
  await ctl.send('gov', 'setActiveSkill', [SKILL2]);
  await ctl.send('gov', 'revokeSkill', [SKILL]);
  assert.equal(await ctl.call('skillApproved', [SKILL]), false);
});

test('defender roster, release, sizes and community fund', async () => {
  await ctl.send('gov', 'approveDefender', [a('r1')]);
  await ctl.send('gov', 'approveDefender', [a('r2')]);
  await assert.rejects(ctl.send('gov', 'approveDefender', [a('r1')]), /BadValue/);
  assert.deepEqual([...await ctl.call('roster')].map((x) => x.toLowerCase()), [a('r1'), a('r2')].map((x) => x.toLowerCase()));
  await ctl.send('gov', 'removeDefender', [a('r1')]);
  assert.deepEqual([...await ctl.call('roster')].map((x) => x.toLowerCase()), [a('r2').toLowerCase()]);
  assert.equal(await ctl.call('defenderApproved', [a('r1')]), false);
  await assert.rejects(ctl.send('gov', 'removeDefender', [a('r1')]), /NotApproved/);

  await ctl.send('gov', 'release', [a('r1')]);
  assert.equal(await ctl.call('releasedAt', [a('r1')]), c.now());

  await assert.rejects(ctl.send('gov', 'setMaxBodies', [3]), /BadValue/);
  await assert.rejects(ctl.send('gov', 'setMaxBodies', [1001]), /BadValue/);
  await ctl.send('gov', 'setMaxBodies', [20]);
  assert.equal(await ctl.call('maxBodies'), 20n);
  await ctl.send('gov', 'setMaxRegrowPerHour', [3]);
  assert.equal(await ctl.call('maxRegrowPerHour'), 3n);
  await ctl.send('gov', 'setCommunityFund', [a('r2')]);
  assert.equal((await ctl.call('communityFund')).toLowerCase(), a('r2').toLowerCase());
});

test('challenge bond, challenge window and defender timeout: defaults and bounds', async () => {
  assert.equal(await ctl.call('challengeBond'), 10n ** 18n);
  assert.equal(await ctl.call('challengeWindow'), 0n); // 0 = NeuroJobs' jobTimeout
  assert.equal(await ctl.call('defenderTimeout'), 6n * 3600n);
  await assert.rejects(ctl.send('gov', 'setChallengeBond', [0]), /BadValue/);
  await ctl.send('gov', 'setChallengeBond', [5n * 10n ** 18n]);
  assert.equal(await ctl.call('challengeBond'), 5n * 10n ** 18n);
  for (const bad of [59, 7 * 86400 + 1]) {
    await assert.rejects(ctl.send('gov', 'setChallengeWindow', [bad]), /BadValue/);
    await assert.rejects(ctl.send('gov', 'setDefenderTimeout', [bad]), /BadValue/);
  }
  await assert.rejects(ctl.send('gov', 'setDefenderTimeout', [0]), /BadValue/);
  await ctl.send('gov', 'setChallengeWindow', [3600]);
  await ctl.send('gov', 'setChallengeWindow', [0]); // back to the default
  await ctl.send('gov', 'setDefenderTimeout', [1800]);
  assert.equal(await ctl.call('defenderTimeout'), 1800n);
});

test('chain allowlist: governance approves (one or many) and removes chain keys', async () => {
  assert.equal(await ctl.call('chainAllowed', [BSC]), false);
  await ctl.send('gov', 'approveChains', [[BSC, ETH]]);
  assert.equal(await ctl.call('chainAllowed', [BSC]), true);
  assert.equal(await ctl.call('chainAllowed', [ETH]), true);
  await assert.rejects(ctl.send('gov', 'approveChains', [[]]), /BadValue/);
  await assert.rejects(ctl.send('gov', 'approveChain', ['0x' + '00'.repeat(32)]), /BadValue/);
  await ctl.send('gov', 'removeChain', [ETH]);
  assert.equal(await ctl.call('chainAllowed', [ETH]), false);
  await assert.rejects(ctl.send('gov', 'removeChain', [ETH]), /NotApproved/);
});

test('governance can be a SimpleMultisig: 2 of 3 owners pause Neuro', async () => {
  const ms = await c.deploy('SimpleMultisig', [[a('o1'), a('o2'), a('o3')], 2], 'gov');
  await ctl.send('gov', 'setGovernance', [ms.address]);
  await assert.rejects(ctl.send('gov', 'pause'), /NotGuardian/); // the old key is out
  await ms.send('o1', 'propose', [ctl.address, 0, ctl.iface.encodeFunctionData('pause', [])]);
  await ms.send('o2', 'confirm', [0]);
  await ms.send('o3', 'execute', [0]);
  assert.equal(await ctl.call('paused'), true);
});

test('gov.sh neuro writes a MsgEVMCall proposal from the gov module with the same calldata as the CLI', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { neuroCall, GOV_MODULE } = await import('../cli.js');
  const { sha256 } = await import('ethers');
  // The gov module's EVM address is the first 20 bytes of sha256("gov").
  assert.equal(GOV_MODULE.toLowerCase(), sha256(Buffer.from('gov')).slice(0, 42));
  const dir = mkdtempSync(join(tmpdir(), 'govsh-'));
  // A stand-in zetaphyd: records the proposal file, then shows it as proposal 1.
  const fake = join(dir, 'zetaphyd');
  writeFileSync(fake, `#!/bin/bash
case "$*" in
  "q auth module-account gov"*) echo '{"account":{"value":{"address":"zetaphy10d07y265gmmuvt4z0w9aw880jnsr700jvr86lj"}}}' ;;
  "q gov proposals"*) if [ -f ${dir}/p.json ]; then echo '{"proposals":[{"id":"1"}]}'; else echo '{"proposals":[]}'; fi ;;
  "tx gov submit-proposal"*) cp "$4" ${dir}/p.json; echo '{"code":0}' ;;
esac
`);
  chmodSync(fake, 0o755);
  const CTL = '0x' + '12'.repeat(20), RUNNER = '0x' + '34'.repeat(20), ID = '0x' + '56'.repeat(32);
  const gov = (...args) => execFileSync(new URL('../../zetaphy-chain/gov.sh', import.meta.url).pathname, args, { env: { ...process.env, ZETAPHYD: fake }, encoding: 'utf8' });
  for (const [action, value] of [['pause'], ['unpause'], ['approve-skill', ID], ['revoke-skill', ID], ['set-active-skill', ID], ['approve-defender', RUNNER],
    ['remove-defender', RUNNER], ['release', RUNNER], ['set-max-bodies', '12'], ['set-max-regrow', '3'], ['set-community-fund', RUNNER],
    ['approve-chain', 'bsc'], ['remove-chain', 'arbitrum'], ['approve-chain', 'my-chain-2'],
    ['set-challenge-bond', '2.5'], ['set-challenge-bond', '1000'], ['set-challenge-bond', '0.000000000000000001'], ['set-challenge-bond', '123456789012.123456789012345678'],
    ['set-challenge-window', '3600'], ['set-defender-timeout', '21600']]) {
    const out = gov('neuro', action, ...(value ? [value] : []), CTL);
    assert.match(out, /proposal 1 submitted/);
    const p = JSON.parse(readFileSync(join(dir, 'p.json'), 'utf8'));
    const m = p.messages[0];
    assert.equal(m['@type'], '/zetaphy.pq.v1.MsgEVMCall');
    assert.equal(m.Sender, 'zetaphy10d07y265gmmuvt4z0w9aw880jnsr700jvr86lj');
    assert.equal(m.To, CTL);
    assert.equal('0x' + Buffer.from(m.Data, 'base64').toString('hex'), neuroCall(action, value).data, action);
    execFileSync('rm', [join(dir, 'p.json')]);
  }
  assert.throws(() => gov('neuro', 'set-max-bodies', 'many', CTL));
  assert.throws(() => gov('neuro', 'explode', CTL));
  assert.throws(() => gov('neuro', 'approve-chain', 'BSC!', CTL));
  assert.throws(() => neuroCall('approve-chain', 'x'.repeat(32)));
  for (const bad of ['0', '0.0', '1.', '-1', '1e18', '0.0000000000000000001']) {
    assert.throws(() => gov('neuro', 'set-challenge-bond', bad, CTL), undefined, bad);
    assert.throws(() => neuroCall('set-challenge-bond', bad), undefined, bad);
  }
});
