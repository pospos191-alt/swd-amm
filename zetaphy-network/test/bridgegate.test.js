// The opening gates' checks (src/bridgegate.js) against a fake chain: multisig-only
// roles, independent lanes, audit, caps, devnet detection, runners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress } from 'ethers';
import { isLoopback, devnetOf, auditArgs, capProblems, multisigInfo, roleChecks, laneChecks, runnerProblems, GOV_MODULE } from '../src/bridgegate.js';

const A = (n) => getAddress('0x' + n.toString(16).padStart(40, '0'));
const DEPLOYER = A(0xd0);
const IFACE = new Interface([
  'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)',
  'function ownerCount() view returns (uint256)', 'function owners(uint256) view returns (address)', 'function threshold() view returns (uint8)',
  'function governance() view returns (address)', 'function owner() view returns (address)', 'function admin() view returns (address)',
  'function runners() view returns (address)', 'function mailbox() view returns (address)', 'function interchainSecurityModule() view returns (address)',
  'function getMinDelay() view returns (uint256)', 'function getRoleMemberCount(bytes32) view returns (uint256)', 'function getRoleMember(bytes32, uint256) view returns (address)',
]);

/** contracts: { address: { fn: value | (args) => value } } — addresses not listed are EOAs. */
function fakeProvider(contracts) {
  const k = Object.fromEntries(Object.entries(contracts).map(([a, v]) => [a.toLowerCase(), v]));
  return {
    async getCode(a) { return k[a.toLowerCase()] ? '0x6000' : '0x'; },
    async call({ to, data }) {
      const c = k[to.toLowerCase()];
      if (!c) return '0x';
      const f = IFACE.parseTransaction({ data });
      if (!(f.name in c)) throw new Error('execution reverted');
      const v = typeof c[f.name] === 'function' ? c[f.name](f.args) : c[f.name];
      return IFACE.encodeFunctionResult(f.name, [v]);
    },
  };
}
const safe = (owners, t) => ({ getOwners: owners, getThreshold: t });
const simple = (owners, t) => ({ ownerCount: owners.length, owners: ([i]) => owners[Number(i)], threshold: t });

test('devnet only with --devnet and a loopback RPC; --devnet on a public RPC is refused', () => {
  for (const u of ['http://127.0.0.1:8545', 'http://localhost:19045', 'http://[::1]:8545']) assert.equal(isLoopback(u), true, u);
  for (const u of ['https://1-2-3-4.sslip.io', 'http://10.0.0.1:8545', 'not a url']) assert.equal(isLoopback(u), false, u);
  assert.equal(devnetOf('http://127.0.0.1:8545', {}), false);
  assert.equal(devnetOf('http://127.0.0.1:8545', { devnet: true }), true);
  assert.throws(() => devnetOf('https://rpc.zetaphy.example', { devnet: true }), /only for a local devnet/);
});

test('audit: an https url and a non-zero sha256', () => {
  assert.deepEqual(auditArgs('https://audits.example/r.pdf', 'AB'.repeat(32)), { url: 'https://audits.example/r.pdf', sha: '0x' + 'ab'.repeat(32) });
  assert.throws(() => auditArgs('http://audits.example/r.pdf', 'ab'.repeat(32)), /https/);
  assert.throws(() => auditArgs(undefined, 'ab'.repeat(32)), /https/);
  assert.throws(() => auditArgs('https://audits.example/r.pdf', '00'.repeat(32)), /sha256/);
  assert.throws(() => auditArgs('https://audits.example/r.pdf', 'ab'.repeat(31)), /sha256/);
});

test('caps: above the 1,000-token starter needs --raise-cap; never above the on-chain cap', () => {
  const d = 6, u = (n) => BigInt(n) * 10n ** 6n;
  assert.deepEqual(capProblems({ limitUnits: u(1000), decimals: d }), []);
  assert.match(capProblems({ limitUnits: u(1001), decimals: d }).join(), /--raise-cap/);
  assert.deepEqual(capProblems({ limitUnits: u(1500), decimals: d, raiseCap: true, maxDailyLimit: u(2000) }), []);
  assert.match(capProblems({ limitUnits: u(3000), decimals: d, raiseCap: true, maxDailyLimit: u(2000) }).join(), /maxDailyLimit/);
  assert.match(capProblems({ limitUnits: 0n, decimals: d }).join(), /limit 0/);
});

test('multisigInfo tells a Safe, a SimpleMultisig, a key, the gov module and an unknown contract apart', async () => {
  const o = [A(1), A(2), A(3)];
  const p = fakeProvider({ [A(0x51)]: safe(o, 2), [A(0x52)]: simple(o, 2), [A(0x53)]: { owner: A(9) } });
  assert.deepEqual(await multisigInfo(p, A(0x51)), { address: A(0x51), kind: 'safe', owners: o, threshold: 2 });
  assert.deepEqual(await multisigInfo(p, A(0x52)), { address: A(0x52), kind: 'simple', owners: o, threshold: 2 });
  assert.equal((await multisigInfo(p, A(0x54))).kind, 'eoa');
  assert.equal((await multisigInfo(p, GOV_MODULE)).kind, 'gov-module');
  assert.equal((await multisigInfo(p, A(0x53))).kind, 'contract');
});

test('roles: multisigs (3+ owners, threshold 2+, no deployer) or the gov module; guardian and governance apart, no shared owner', async () => {
  const gOwners = [A(1), A(2), A(3)], dOwners = [A(4), A(5), A(6)];
  const p = fakeProvider({
    [A(0x61)]: safe(gOwners, 2), [A(0x62)]: simple(dOwners, 2),
    [A(0x63)]: simple([A(7), A(8)], 2), [A(0x64)]: safe([A(7), A(8), A(9)], 1), [A(0x65)]: safe([A(7), A(8), DEPLOYER], 2),
    [A(0x66)]: safe([A(4), A(10), A(11)], 2), [A(0x67)]: { owner: A(1) },
  });
  const ok = await roleChecks(p, { governance: [A(0x61), A(0x61)], guardians: [A(0x62)] }, { deployer: DEPLOYER });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.infos.length, 2);
  assert.deepEqual((await roleChecks(p, { governance: [GOV_MODULE], guardians: [A(0x62)] }, { deployer: DEPLOYER })).problems, []);
  const bad = async (roles, re, o = { deployer: DEPLOYER }) => assert.match((await roleChecks(p, roles, o)).problems.join('\n'), re);
  await bad({ governance: [DEPLOYER], guardians: [A(0x62)] }, /single key \(EOA, no code\).*deployer key/);
  await bad({ governance: [A(0x61)], guardians: [A(0x99)] }, /guardian 0x0+99 is a single key/);
  await bad({ governance: [A(0x61)], guardians: [] }, /no guardian/);
  await bad({ governance: [A(0x63)], guardians: [A(0x62)] }, /2 owner\(s\), needs at least 3/);
  await bad({ governance: [A(0x64)], guardians: [A(0x62)] }, /threshold 1, needs at least 2/);
  await bad({ governance: [A(0x65)], guardians: [A(0x62)] }, /deployer key .* is one of its owners/);
  await bad({ governance: [A(0x62)], guardians: [A(0x62)] }, /same address/);
  await bad({ governance: [A(0x66)], guardians: [A(0x62)] }, /hold keys in both/);
  await bad({ governance: [A(0x67)], guardians: [A(0x62)] }, /neither a Safe nor a SimpleMultisig/);
  // A key only on a devnet or with --allow-eoa-for-testing, and then as a warning.
  for (const o of [{ devnet: true }, { allowEoa: true }]) {
    const r = await roleChecks(p, { governance: [DEPLOYER], guardians: [A(0x98)] }, { deployer: DEPLOYER, ...o });
    assert.deepEqual(r.problems, []);
    assert.equal(r.warnings.length, 2);
  }
});

test('lanes: 2+ independent (on-chain count), contracts, no deployer behind any, no admin controlling another lane', async () => {
  const neuro = A(0x71), hyp = A(0x72), jobs = A(0x73), mailbox = A(0x74), msig = A(0x75), eoaLane = A(0x76);
  const lanesOf = (list, independent, controllers = {}) => ({
    lanes: async () => list, independentLanes: async () => BigInt(independent),
    laneControllerOf: async (l) => controllers[l] ?? l,
  });
  const contracts = { [neuro]: { runners: jobs }, [hyp]: { mailbox, governance: msig, interchainSecurityModule: A(0) } };
  const p = fakeProvider(contracts);
  const good = await laneChecks(p, lanesOf([neuro, hyp], 2, { [neuro]: jobs, [hyp]: mailbox }), { deployer: DEPLOYER });
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.lanes.map((l) => [l.kind, l.controller, l.admin]), [['NeuroLane', jobs, null], ['HyperlaneLane', mailbox, msig]]);
  const one = await laneChecks(p, lanesOf([neuro], 1, { [neuro]: jobs }), { deployer: DEPLOYER });
  assert.match(one.problems.join(), /1 independent lane/);
  const eoa = await laneChecks(p, lanesOf([neuro, eoaLane], 2, { [neuro]: jobs }), { deployer: DEPLOYER });
  assert.match(eoa.problems.join(), /single key \(EOA\)/);
  assert.deepEqual((await laneChecks(p, lanesOf([neuro, eoaLane], 2, { [neuro]: jobs }), { deployer: DEPLOYER, devnet: true })).problems, []);
  const p2 = fakeProvider({ ...contracts, [hyp]: { mailbox, governance: DEPLOYER } });
  assert.match((await laneChecks(p2, lanesOf([neuro, hyp], 2, { [neuro]: jobs, [hyp]: mailbox }), { deployer: DEPLOYER })).problems.join(), /still the deployer key/);
  const p3 = fakeProvider({ ...contracts, [hyp]: { mailbox, governance: jobs } });
  assert.match((await laneChecks(p3, lanesOf([neuro, hyp], 2, { [neuro]: jobs, [hyp]: mailbox }), { deployer: DEPLOYER })).problems.join(), /not independent/);
  assert.match((await laneChecks(p, lanesOf([neuro, hyp], 2, { [neuro]: DEPLOYER, [hyp]: mailbox }), { deployer: DEPLOYER })).problems.join(), /controller is the deployer/);
});

test('runners: NeuroJobs.activeWorkers against the minimum', async () => {
  assert.deepEqual(await runnerProblems({ activeWorkers: async () => 12n }, 10), { active: 12, problems: [] });
  assert.match((await runnerProblems({ activeWorkers: async () => 3n }, 10)).problems.join(), /3 active Neuro runner\(s\).*at least 10/);
});

test('governance calls: sent when this key is governance, else printed (to, data) for the multisig or a gov vote', async () => {
  const { govCall } = await import('../src/bridgecli.js');
  const iface = new Interface(['function setRoute(bytes32,address,uint128,bool)']);
  const sent = [];
  const k = (gov) => ({ target: A(0x99), interface: iface, governance: async () => gov, setRoute: async (...a) => { sent.push(a); return { wait: async () => ({}) }; } });
  const out = [];
  const args = ['0x' + '01'.repeat(32), A(0x98), 5n, true];
  assert.equal(await govCall(k(DEPLOYER), { me: DEPLOYER }, (l) => out.push(l), 'setRoute', args, 'enable'), true);
  assert.equal(sent.length, 1);
  assert.match(out.pop(), /enable \(done\)/);
  assert.equal(await govCall(k(A(0x51)), { me: DEPLOYER }, (l) => out.push(l), 'setRoute', args, 'enable'), false);
  assert.equal(sent.length, 1);
  assert.match(out.join('\n'), new RegExp(`to ${A(0x99)}\\n  data ${iface.encodeFunctionData('setRoute', args)}`));
  assert.match(out.join('\n'), /SimpleMultisig: an owner calls propose/);
  out.length = 0;
  await govCall(k(GOV_MODULE), { me: DEPLOYER }, (l) => out.push(l), 'setRoute', args, 'enable');
  assert.match(out.join('\n'), /MsgEVMCall proposal/);
});

test('governance behind a ZetaphyTimelock: its delay, its own admin role and its proposers are checked', async () => {
  const MS = A(0x51), GUARD = A(0x52), TL = A(0x7e);
  const PROPOSER = '0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1';
  const timelock = (delay, proposers, admins) => ({ getMinDelay: delay,
    getRoleMemberCount: ([r]) => (r === PROPOSER ? proposers.length : admins.length),
    getRoleMember: ([r, i]) => (r === PROPOSER ? proposers : admins)[Number(i)] });
  const ms = simple([A(1), A(2), A(3)], 2), guard = simple([A(4), A(5), A(6)], 2);
  const ok = fakeProvider({ [TL]: timelock(172800n, [MS], [TL]), [MS]: ms, [GUARD]: guard });
  const info = await multisigInfo(ok, TL);
  assert.equal(info.kind, 'timelock');
  assert.equal(info.proposers[0].kind, 'simple');
  assert.deepEqual((await roleChecks(ok, { governance: [TL], guardians: [GUARD] }, { deployer: DEPLOYER })).problems, []);
  const gov = fakeProvider({ [TL]: timelock(172800n, [GOV_MODULE], [TL]), [GUARD]: guard });
  assert.deepEqual((await roleChecks(gov, { governance: [TL], guardians: [GUARD] }, { deployer: DEPLOYER })).problems, []);
  const bad = fakeProvider({ [TL]: timelock(3600n, [DEPLOYER], [DEPLOYER]), [GUARD]: guard });
  const p = (await roleChecks(bad, { governance: [TL], guardians: [GUARD] }, { deployer: DEPLOYER })).problems.join('\n');
  assert.match(p, /3600 s delay: at least 86400/);
  assert.match(p, /must be its own only admin/);
  assert.match(p, /proposer of timelock .* is a single key/);
  const shared = fakeProvider({ [TL]: timelock(172800n, [MS], [TL]), [MS]: ms, [GUARD]: simple([A(1), A(5), A(6)], 2) });
  assert.match((await roleChecks(shared, { governance: [TL], guardians: [GUARD] }, { deployer: DEPLOYER })).problems.join('\n'), /hold keys in both/);
});
