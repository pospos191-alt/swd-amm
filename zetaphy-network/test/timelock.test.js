// ZetaphyTimelock (OpenZeppelin 5.4.0 TimelockController + role enumeration) in front of
// the admin roles, on an in-memory EVM: roles, delays, cancelling, self-administration,
// and the emergency paths that stay immediate (guardians: pause, lower a cap, close a
// route, remove a lane or a marker, raise the airlock's threshold or quarantine, pause
// a price feed, pause the gateway), while unpausing and every rule change wait.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroHash, ZeroAddress, encodeBytes32String, getAddress } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { dexArt, mockArtifacts } from './helpers/mocks.js';
import { ROLES, operationId, scheduleData, saltOf, callName, checkTimelock, rolesOf } from '../src/timelock.js';
import { readFileSync } from 'node:fs';

const DELAY = 48n * 3600n;
const ROUTE = encodeBytes32String('neuro');
const nftArt = (n) => JSON.parse(readFileSync(new URL(`../../zetaphy-nft/artifacts/${n}.json`, import.meta.url), 'utf8'));

async function setup() {
  const c = await createChain(['deployer', 'multisig', 'guardian', 'anyone', 'eve', 'lane1', 'lane2', 'marker']);
  const A = (n) => getAddress(c.acct[n].toString());
  const tl = await c.deploy('ZetaphyTimelock', [DELAY, [A('multisig')], [ZeroAddress], ZeroAddress], 'deployer');
  tl.address = getAddress(tl.address);
  /** schedule (by the multisig), wait, execute (by anyone): a governance call through the timelock. */
  const govern = async (k, fn, args = [], { salt = ZeroHash, wait = DELAY } = {}) => {
    const data = k.iface.encodeFunctionData(fn, args);
    await tl.send('multisig', 'schedule', [k.address, 0, data, ZeroHash, salt, DELAY]);
    c.advance(wait);
    return tl.send('anyone', 'execute', [k.address, 0, data, ZeroHash, salt]);
  };
  return { c, A, tl, govern };
}

test('roles: proposers = cancellers = the multisig, anyone executes, the timelock is its only admin (enumerable)', async () => {
  const { c, A, tl } = await setup();
  assert.equal(await tl.call('getMinDelay'), DELAY);
  assert.equal(await tl.call('hasRole', [ROLES.proposer, A('multisig')]), true);
  assert.equal(await tl.call('hasRole', [ROLES.canceller, A('multisig')]), true);
  assert.equal(await tl.call('hasRole', [ROLES.executor, ZeroAddress]), true, 'open executor');
  assert.equal(await tl.call('hasRole', [ROLES.admin, tl.address]), true);
  for (const r of Object.values(ROLES)) assert.equal(await tl.call('hasRole', [r, A('deployer')]), false, 'the deployer holds nothing');
  const roles = await rolesOf({ getRoleMemberCount: (r) => tl.call('getRoleMemberCount', [r]), getRoleMember: (r, i) => tl.call('getRoleMember', [r, i]) });
  assert.deepEqual(roles, { admin: [tl.address], proposer: [A('multisig')], executor: [ZeroAddress], canceller: [A('multisig')] });
  // checkTimelock: an EOA proposer is refused outside a devnet
  const provider = { getCode: async (a) => (a.toLowerCase() === tl.address.toLowerCase() ? '0x60' : '0x') };
  const view = { target: tl.address, getMinDelay: () => tl.call('getMinDelay'), getRoleMemberCount: (r) => tl.call('getRoleMemberCount', [r]), getRoleMember: (r, i) => tl.call('getRoleMember', [r, i]) };
  const bad = await checkTimelock(provider, view, { minDelay: DELAY, proposers: [A('multisig')], forbidden: [A('deployer')] });
  assert.ok(bad.problems.some((p) => /EOA/.test(p)), bad.problems.join('; '));
  const ok = await checkTimelock(provider, view, { minDelay: DELAY, proposers: [A('multisig')], forbidden: [A('deployer')], devnet: true });
  assert.deepEqual(ok.problems, []);
  const wrong = await checkTimelock(provider, view, { minDelay: 3600n, proposers: [A('eve')], devnet: true });
  assert.equal(wrong.problems.length, 3, wrong.problems.join('; '));
  assert.equal(c.acct.deployer != null, true);
});

test('a scheduled call waits the delay, then anyone executes it; early, unscheduled or by a non-proposer: refused', async () => {
  const { c, A, tl } = await setup();
  const guard = await c.deploy('BridgeGuard', [tl.address], 'deployer');
  const data = guard.iface.encodeFunctionData('setGuardian', [A('guardian'), true]);
  await assert.rejects(guard.send('multisig', 'setGuardian', [A('guardian'), true]), /NotGovernance/, 'the multisig itself is not governance');
  await assert.rejects(tl.send('eve', 'schedule', [guard.address, 0, data, ZeroHash, ZeroHash, DELAY]), /AccessControlUnauthorizedAccount/);
  await assert.rejects(tl.send('multisig', 'schedule', [guard.address, 0, data, ZeroHash, ZeroHash, DELAY - 1n]), /TimelockInsufficientDelay/);
  const ev = await tl.send('multisig', 'schedule', [guard.address, 0, data, ZeroHash, ZeroHash, DELAY]);
  const sched = ev.find((e) => e?.name === 'CallScheduled');
  const id = operationId({ target: guard.address, data });
  assert.equal(sched.args.id, id, 'the id the CLI computes');
  assert.equal(callName(sched.args.data), 'setGuardian(address,bool)', 'the monitor names the function');
  assert.equal(await tl.call('getOperationState', [id]), 1n, 'Waiting');
  c.advance(DELAY - 10n);
  await assert.rejects(tl.send('anyone', 'execute', [guard.address, 0, data, ZeroHash, ZeroHash]), /TimelockUnexpectedOperationState/);
  c.advance(10n);
  assert.equal(await tl.call('getOperationState', [id]), 2n, 'Ready');
  const ex = await tl.send('anyone', 'execute', [guard.address, 0, data, ZeroHash, ZeroHash]);
  assert.ok(ex.some((e) => e?.name === 'CallExecuted'));
  assert.equal(await guard.call('guardian', [A('guardian')]), true);
  await assert.rejects(tl.send('anyone', 'execute', [guard.address, 0, data, ZeroHash, ZeroHash]), /TimelockUnexpectedOperationState/, 'once only');
  // the same call again needs another salt
  await assert.rejects(tl.send('multisig', 'schedule', [guard.address, 0, data, ZeroHash, ZeroHash, DELAY]), /TimelockUnexpectedOperationState/);
  await tl.send('multisig', 'schedule', [guard.address, 0, data, ZeroHash, saltOf('again'), DELAY]);
});

test('cancelling: the canceller drops a waiting call; nobody else can', async () => {
  const { c, A, tl } = await setup();
  const guard = await c.deploy('BridgeGuard', [tl.address], 'deployer');
  const data = guard.iface.encodeFunctionData('setGovernance', [A('eve')]);
  await tl.send('multisig', 'schedule', [guard.address, 0, data, ZeroHash, ZeroHash, DELAY]);
  const id = operationId({ target: guard.address, data });
  await assert.rejects(tl.send('eve', 'cancel', [id]), /AccessControlUnauthorizedAccount/);
  const ev = await tl.send('multisig', 'cancel', [id]);
  assert.ok(ev.some((e) => e?.name === 'Cancelled'));
  c.advance(DELAY);
  await assert.rejects(tl.send('anyone', 'execute', [guard.address, 0, data, ZeroHash, ZeroHash]), /TimelockUnexpectedOperationState/);
  assert.equal(getAddress(await guard.call('governance')), tl.address);
});

test('the timelock administers itself: a new delay or proposer waits the delay too', async () => {
  const { c, A, tl, govern } = await setup();
  await assert.rejects(tl.send('multisig', 'updateDelay', [60]), /TimelockUnauthorizedCaller/);
  await assert.rejects(tl.send('multisig', 'grantRole', [ROLES.proposer, A('eve')]), /AccessControlUnauthorizedAccount/);
  const ev = await govern(tl, 'updateDelay', [72n * 3600n]);
  assert.ok(ev.some((e) => e?.name === 'MinDelayChange'));
  assert.equal(await tl.call('getMinDelay'), 72n * 3600n);
  await tl.send('multisig', 'schedule', [tl.address, 0, tl.iface.encodeFunctionData('grantRole', [ROLES.proposer, A('eve')]), ZeroHash, ZeroHash, 72n * 3600n]);
  c.advance(72n * 3600n);
  await tl.send('anyone', 'execute', [tl.address, 0, tl.iface.encodeFunctionData('grantRole', [ROLES.proposer, A('eve')]), ZeroHash, ZeroHash]);
  assert.equal(await tl.call('getRoleMemberCount', [ROLES.proposer]), 2n);
  assert.equal(scheduleData({ target: tl.address, data: '0x', delay: 1 }).slice(0, 10), new Interface(tl.iface.fragments).getFunction('schedule').selector);
});

test('BridgeGuard: guardians pause, lower the cap, cancel a raise and close a route at once; unpause and raises wait the timelock', async () => {
  const { c, A, tl, govern } = await setup();
  const guard = await c.deploy('BridgeGuard', [A('deployer')], 'deployer');
  await guard.send('deployer', 'createToken', ['Bridged', 'bZ', 18]);
  await guard.send('deployer', 'setGuardian', [A('guardian'), true]);
  await guard.send('deployer', 'setAudit', ['https://audit.example/r.pdf', '0x' + '11'.repeat(32)]);
  await guard.send('deployer', 'setRoute', [ROUTE, A('lane1'), 10n * ZETA, false]);
  await guard.send('deployer', 'proposeMaxDailyLimit', [1500n * ZETA]);
  await guard.send('deployer', 'setGovernance', [tl.address]); // the handover
  await assert.rejects(guard.send('deployer', 'unpause'), /NotGovernance/, 'the old admin has nothing');
  // emergency, at once
  await assert.rejects(guard.send('eve', 'pause'), /NotGuardian/);
  await guard.send('guardian', 'pause');
  assert.equal(await guard.call('paused'), true);
  await guard.send('guardian', 'cancelMaxDailyLimit');
  assert.equal(await guard.call('pendingMaxAt'), 0n);
  await assert.rejects(guard.send('guardian', 'lowerMaxDailyLimit', [2000n * ZETA]), /CapStep/, 'never a raise');
  await guard.send('guardian', 'lowerMaxDailyLimit', [500n * ZETA]);
  assert.equal(await guard.call('maxDailyLimit'), 500n * ZETA);
  await guard.send('guardian', 'disableRoute', [ROUTE]);
  for (const [fn, args] of [['unpause', []], ['proposeMaxDailyLimit', [100n]], ['setRoute', [ROUTE, A('lane1'), 1n, false]], ['setGuardian', [A('eve'), true]],
    ['setGovernance', [A('guardian')]], ['setThreats', [ZeroAddress]], ['dropHeld', [0]], ['setAudit', ['https://x.example/a', '0x' + '22'.repeat(32)]]]) {
    await assert.rejects(guard.send('guardian', fn, args), /NotGovernance/, fn);
  }
  // restarting goes through the timelock
  await govern(guard, 'unpause');
  assert.equal(await guard.call('paused'), false);
  // a guardian's cut, even to 0, is not permanent: governance restores the cap
  // it cut from in one raise (CAP_DELAY still applies), not in x2 steps from 0
  await guard.send('guardian', 'lowerMaxDailyLimit', [0n]);
  assert.equal(await guard.call('restoreMaxDailyLimit'), 1000n * ZETA, 'the highest cap before the cuts');
  await assert.rejects(govern(guard, 'proposeMaxDailyLimit', [1001n * ZETA]), undefined, 'not above the restore point (CapStep)');
  await govern(guard, 'proposeMaxDailyLimit', [1000n * ZETA]);
  c.advance(await guard.call('CAP_DELAY'));
  await guard.send('anyone', 'applyMaxDailyLimit');
  assert.equal(await guard.call('maxDailyLimit'), 1000n * ZETA);
  assert.equal(await guard.call('restoreMaxDailyLimit'), 0n, 'used up');
});

test('BridgeAirlock: guardians of the guard remove a lane or a marker and raise threshold / quarantine at once; the rest waits', async () => {
  const { c, A, tl, govern } = await setup();
  const guard = await c.deploy('BridgeGuard', [A('deployer')], 'deployer');
  await guard.send('deployer', 'setGuardian', [A('guardian'), true]);
  const airlock = await c.deploy('BridgeAirlock', [guard.address, ROUTE, A('deployer'), 2, 600], 'deployer');
  for (const l of ['lane1', 'lane2']) await airlock.send('deployer', 'setLane', [A(l), true]);
  await airlock.send('deployer', 'setMarker', [A('marker'), true]);
  await airlock.send('marker', 'trip', [A('eve')]);
  await airlock.send('deployer', 'setGovernance', [tl.address]);
  await guard.send('deployer', 'setGovernance', [tl.address]);
  await assert.rejects(airlock.send('eve', 'emergencyRemoveLane', [A('lane1')]), /NotGuardian/);
  await airlock.send('guardian', 'emergencyRemoveLane', [A('lane1')]);
  assert.equal(await airlock.call('isLane', [A('lane1')]), false);
  assert.deepEqual([...await airlock.call('lanes')], [A('lane2')]);
  await assert.rejects(airlock.send('guardian', 'emergencyRemoveLane', [A('lane1')]), /NotLane/);
  assert.equal(await airlock.call('tripped', [A('eve')]), true);
  await airlock.send('guardian', 'emergencyRemoveMarker', [A('marker')]);
  assert.equal(await airlock.call('markerCount'), 0n);
  // a guardian stops the marker from marking, but cannot lift its marks
  assert.equal(await airlock.call('tripped', [A('eve')]), true, 'marks stay until governance decides');
  assert.equal(await airlock.call('markerRevoked', [A('marker')]), true);
  await assert.rejects(airlock.send('marker', 'trip', [A('lane2')]), /NotMarker/);
  await assert.rejects(airlock.send('guardian', 'emergencyRemoveMarker', [A('marker')]), /NotMarker/);
  await assert.rejects(airlock.send('guardian', 'untrip', [A('eve')]), /NotGovernance/);
  await assert.rejects(airlock.send('guardian', 'emergencyRaiseThreshold', [2]), /raise only|revert|Error/, 'raise only');
  await airlock.send('guardian', 'emergencyRaiseThreshold', [3]);
  await assert.rejects(airlock.send('guardian', 'emergencyRaiseQuarantine', [600]), /raise only|revert|Error/, 'raise only');
  await assert.rejects(airlock.send('guardian', 'emergencyRaiseQuarantine', [31n * 86400n]), /raise only|revert|Error/, 'at most 30 days');
  await airlock.send('guardian', 'emergencyRaiseQuarantine', [86400]);
  assert.equal(await airlock.call('quarantine'), 86400n);
  for (const [fn, args] of [['setLane', [A('lane1'), true]], ['setMarker', [A('marker'), true]], ['setThreshold', [2]], ['setQuarantine', [1]], ['untrip', [A('eve')]],
    ['setVetoer', [A('eve'), true]], ['setThreats', [ZeroAddress]], ['setGovernance', [A('eve')]]]) {
    await assert.rejects(airlock.send('guardian', fn, args), /NotGovernance/, fn);
  }
  await govern(airlock, 'setThreshold', [2]);
  assert.equal(await airlock.call('threshold'), 2n);
  // governance removing the marker (through the timelock) lifts its marks
  await govern(airlock, 'setMarker', [A('marker'), false]);
  assert.equal(await airlock.call('markerRevoked', [A('marker')]), false);
  assert.equal(await airlock.call('tripped', [A('eve')]), false);
});

test('every other admin role behind the timelock: the old admin is refused, a scheduled call goes through', async () => {
  const { c, A, tl, govern } = await setup();
  const jobs = await c.deploy('NeuroJobs', [100n * ZETA, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'deployer');
  const control = await c.deploy('NeuroControl', [A('deployer'), A('deployer'), 64, 4], 'deployer');
  const registry = await c.deploy('ThreatRegistry', [jobs.address, 2, 1, A('deployer'), 3600], 'deployer');
  const reports = await c.deploy('ThreatReports', [registry.address, A('deployer'), ZETA / 10n, 30n * 86400n], 'deployer');
  const vault = await c.deploy('RewardVault', [A('deployer'), [[jobs.address, 10000, true]]], 'deployer');
  const gateway = await c.deploy('StableGateway', [jobs.address], 'deployer');
  const recorder = await c.deploy('TwapRecorder', [60], 'deployer');
  const oracle = await c.deploy('ZetaphyOracle', [A('deployer'), recorder.address, ZeroAddress], 'deployer');
  const relay = await c.deploy('ZetaphyPythRelay', [A('deployer'), [], 1], 'deployer');
  const factory = await c.deployRaw(dexArt('ZetaphyFactory'), [A('deployer')], 'deployer');
  const market = await c.deployRaw(nftArt('NFTMarketplace'), [A('deployer'), A('deployer'), 250, ZeroAddress, ZeroAddress], 'deployer');
  // the handover
  for (const [k, fn] of [[control, 'setGovernance'], [registry, 'setGovernance'], [vault, 'setGovernance'], [gateway, 'setOwner'], [oracle, 'setGovernance'],
    [relay, 'setGovernance'], [market, 'setGovernance'], [factory, 'setGovernance']]) await k.send('deployer', fn, [tl.address]);
  await govern(factory, 'acceptGovernance'); // two-step: the timelock accepts through itself
  const table = [
    [control, 'governance', 'setMaxBodies', [32]], [registry, 'governance', 'setEnforceDelay', [7200]], [reports, null, 'setFee', [ZETA / 20n]],
    [vault, 'governance', 'cancelShares', []], [gateway, 'owner', 'setTestnetFixedPrices', [true]], [oracle, 'governance', 'setPyth', [relay.address]],
    [relay, 'governance', 'setThreshold', [2]], [factory, 'governance', 'setFeeTo', [A('eve')]], [market, 'governance', 'setFee', [100, A('eve')]],
  ];
  for (const [k, read, fn, args] of table) {
    if (read) assert.equal((await k.call(read)).toLowerCase(), tl.address.toLowerCase(), `${fn}: governed by the timelock`);
    await assert.rejects(k.send('deployer', fn, args), /Not|revert/, `${fn}: the old admin is refused`);
    await govern(k, fn, args);
  }
  assert.equal(await control.call('maxBodies'), 32n);
  assert.equal(await reports.call('fee'), ZETA / 20n);
  assert.equal((await factory.call('feeTo')).toLowerCase(), A('eve').toLowerCase());
  assert.equal(await gateway.call('testnetFixedPrices'), true);
  // emergencies that stay immediate: Neuro's pause, holds, the gateway's pause, a feed's pause
  await govern(control, 'setGuardian', [A('guardian'), true]);
  await control.send('guardian', 'pause');
  assert.equal(await control.call('paused'), true);
  await assert.rejects(control.send('guardian', 'unpause'), /NotGovernance/);
  await govern(gateway, 'setGuardian', [A('guardian'), true]);
  await gateway.send('guardian', 'pause');
  await assert.rejects(gateway.send('guardian', 'unpause'), /NotOwner/);
  await govern(oracle, 'setGuardian', [A('guardian'), true]);
  await oracle.send('guardian', 'pauseFeed', [A('eve')]);
  await assert.rejects(oracle.send('guardian', 'unpauseFeed', [A('eve')]), /NotGovernance/);
  await govern(registry, 'setGuardian', [A('guardian'), true]);
  assert.equal(await registry.call('guardian', [A('guardian')]), true, 'ThreatRegistry guardians hold / enforce flags at once (holdNow, enforceNow)');
  assert.equal(mockArtifacts().Caller != null, true);
});

test('CLI helpers: calldata from --sig/--args, a gov proposal for the timelock, salts', async () => {
  const { callArgs, evmCallProposal, GOV_MODULE_BECH32 } = await import('../src/timelockcli.js');
  const to = '0x' + '12'.repeat(20);
  const a = callArgs({ to, sig: 'setGuardian(address,bool)', args: `${to},true` });
  assert.equal(a.data, new Interface(['function setGuardian(address,bool)']).encodeFunctionData('setGuardian', [to, true]));
  assert.equal(callName(a.data), 'setGuardian(address,bool)');
  assert.throws(() => callArgs({ to, sig: 'setGuardian(address,bool)', args: to }), /takes 2/);
  assert.throws(() => callArgs({ to }), /--data/);
  assert.throws(() => callArgs({ to: '0x12', data: '0x12345678' }), /--to/);
  const p = evmCallProposal({ to, data: '0xabcdef01', title: 't', summary: 's' });
  assert.equal(p.messages[0]['@type'], '/zetaphy.pq.v1.MsgEVMCall');
  assert.equal(p.messages[0].Sender, GOV_MODULE_BECH32);
  assert.equal(p.messages[0].Data, Buffer.from('abcdef01', 'hex').toString('base64'));
  assert.equal(saltOf(undefined), ZeroHash);
  assert.equal(saltOf('0x' + '01'.repeat(32)), '0x' + '01'.repeat(32));
  assert.notEqual(saltOf('raise-cap-1'), saltOf('raise-cap-2'));
});

// timelock execute (the workflow signs it with the deployer key) refuses an RPC that answers another chain id
// before anything is signed (and the CLI's network is fixed to 77390, so what it signs is for 77390 only).
test('CLI timelock execute: an RPC that is not chain 77390 gets nothing signed', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Wallet } = await import('ethers');
  const home = mkdtempSync(join(tmpdir(), 'zetaphy-tl-chain-'));
  writeFileSync(join(home, 'worker.key'), Wallet.createRandom().privateKey + '\n', { mode: 0o600 });
  process.env.ZETAPHY_HOME = home;
  const chainId = '0x1';
  const seen = [];
  const answer = ({ id, method }) => {
    seen.push(method);
    if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: chainId };
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `${method}: not in this fake` } };
  };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(msg) ? msg.map(answer) : answer(msg)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const rpc = `http://127.0.0.1:${server.address().port}`;
  try {
    const { main } = await import('../cli.js');
    const id = '0x' + '11'.repeat(32);
    await assert.rejects(main(['timelock', 'execute', id, '--timelock', '0x' + '22'.repeat(20), '--rpc', rpc], {}, () => {}), /that RPC is chain 1, not ZETAPHY testnet \(77390\)/);
    assert.ok(!seen.includes('eth_sendRawTransaction'), 'nothing signed or sent');
    assert.deepEqual([...new Set(seen)], ['eth_chainId']);
  } finally {
    server.close();
  }
});
