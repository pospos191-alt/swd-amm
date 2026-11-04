// EconomicBounds (SS4) on the in-memory EVM (docs/future/red-team.md): a request sponsor attaches
// (reportHash, bound, scenariosHash); three bonded runners rerun and confirm it with commit-reveal; 2 of 3
// identical (reportHash, bound) confirm it; the confirming runners share the fee, the rest goes back; boundFor
// holds only while the target's certificate holds and was issued for the confirmed request. AuditCertificate's
// own behaviour is untouched (a separate contract).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { AbiCoder, keccak256, toUtf8Bytes, hexlify, randomBytes, ZeroAddress } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { workMocks } from './helpers/workmocks.js';

const abi = AbiCoder.defaultAbiCoder();
const salt = () => hexlify(randomBytes(32));
const DAY = 86400;
let c, jobs, net, certs, eb;
const A = (n) => c.acct[n].toString();

const commitmentOf = (reportHash, bound, runner, s, id) =>
  keccak256(abi.encode(['string', 'bytes32', 'address', 'bytes32', 'uint256'], ['zetaphy.econ.bound', keccak256(abi.encode(['bytes32', 'uint256'], [reportHash, bound])), runner, s, id]));

const REPORT = keccak256(toUtf8Bytes('report'));
const BOUND = 42n * ZETA;
const SCEN = keccak256(toUtf8Bytes('scenarios'));

beforeEach(async () => {
  c = await createChain(['gov', 'sponsor', 'r1', 'r2', 'r3', 'outsider']);
  const m = workMocks();
  jobs = await c.deployRaw(m.MockRunners, [], 'gov');
  for (const r of ['r1', 'r2', 'r3']) await jobs.send('gov', 'set', [A(r), true, 5, 0]);
  // a minimal network + certificate stub: both from the test kit
  const kit = econKit();
  net = await c.deployRaw(kit.StubNetwork, [], 'gov');
  certs = await c.deployRaw(kit.StubCertificate, [], 'gov');
  eb = await c.deploy('EconomicBounds', [net.address, certs.address, jobs.address, 1], 'gov');
  await net.send('gov', 'setSponsor', [1n, A('sponsor')]);
});

let kitCache = null;
function econKit() {
  if (kitCache) return kitCache;
  const input = { language: 'Solidity', sources: { 'EconKit.sol': { content: readFileSync(new URL('./helpers/EconKit.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  kitCache = Object.fromEntries(Object.entries(out.contracts['EconKit.sol']).map(([n, cc]) => [n, { abi: cc.abi, bytecode: '0x' + cc.evm.bytecode.object }]));
  return kitCache;
}

async function attach(fee = ZETA) {
  await eb.send('sponsor', 'attach', [1n, [REPORT, BOUND, SCEN]], fee);
}
async function confirm(reports = [[REPORT, BOUND], [REPORT, BOUND], [REPORT, BOUND]], who = ['r1', 'r2', 'r3']) {
  const salts = {};
  for (const [i, r] of who.entries()) { salts[r] = salt(); await eb.send(r, 'commit', [1n, commitmentOf(reports[i][0], reports[i][1], A(r), salts[r], 1n)]); }
  c.advance(2 * DAY + 1);
  for (const [i, r] of who.entries()) await eb.send(r, 'reveal', [1n, reports[i][0], reports[i][1], salts[r]]);
}

test('a bound confirmed by 2 of 3 pays the confirming runners; boundOf returns it', async () => {
  await attach(3n * ZETA);
  await confirm();
  c.advance(1);
  await eb.send('outsider', 'settle', [1n]);
  const [confirmed, claim] = await eb.call('boundOf', [1n]);
  assert.equal(confirmed, true);
  assert.equal(claim.bound, BOUND);
  assert.equal(await eb.call('owed', [A('r1')]), ZETA, '3 ZTPHY fee / 3 confirmations');
});

test('a bound only 1 runner confirms is not confirmed; the fee goes back to the sponsor', async () => {
  await attach(3n * ZETA);
  await confirm([[REPORT, BOUND], [REPORT, BOUND + 1n], [keccak256(toUtf8Bytes('other')), BOUND]]);
  c.advance(2 * DAY + 1); // only 1 confirmation: settle must wait out the reveal window
  await eb.send('outsider', 'settle', [1n]);
  const [confirmed] = await eb.call('boundOf', [1n]);
  assert.equal(confirmed, false);
  assert.equal(await eb.call('owed', [A('sponsor')]), 3n * ZETA, 'the whole fee refunded');
});

test('only the request sponsor may attach, once', async () => {
  await assert.rejects(eb.send('outsider', 'attach', [1n, [REPORT, BOUND, SCEN]], ZETA), /NotSponsor/);
  await attach();
  await assert.rejects(attach(), /AlreadyIn/);
});

test('boundFor holds only while the certificate holds for the confirmed request', async () => {
  await attach();
  await confirm();
  c.advance(1);
  await eb.send('outsider', 'settle', [1n]);
  // certificate for (1, target) points at request 1 and is valid: boundFor holds
  await certs.send('gov', 'setCert', [1n, '0x00000000000000000000000000000000000c0de0', 1n, true]);
  let [holds, claim, reqId] = await eb.call('boundFor', [1n, '0x00000000000000000000000000000000000c0de0']);
  assert.equal(holds, true);
  assert.equal(reqId, 1n);
  assert.equal(claim.bound, BOUND);
  // certificate invalid: no bound
  await certs.send('gov', 'setCert', [1n, '0x00000000000000000000000000000000000c0de0', 1n, false]);
  [holds] = await eb.call('boundFor', [1n, '0x00000000000000000000000000000000000c0de0']);
  assert.equal(holds, false);
  // certificate valid but for a different request (no confirmed bound there): no bound
  await certs.send('gov', 'setCert', [1n, '0x00000000000000000000000000000000000c0de0', 9n, true]);
  [holds] = await eb.call('boundFor', [1n, '0x00000000000000000000000000000000000c0de0']);
  assert.equal(holds, false);
});
