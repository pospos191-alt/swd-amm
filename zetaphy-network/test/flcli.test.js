// `zetaphy fl deploy | propose | status | config` (src/flcli.js) on the in-memory EVM, and the
// browser's hand-written FederatedRounds client (zetaphy-neuro/ml/fl/rounds.js) against ethers
// and the compiled contract: same commitment, same calldata, a whole commit + reveal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hexlify, id as hashText, getAddress } from 'ethers';
import { createChain } from './helpers/evm.js';
import { flCommand, ROUNDS_IFACE, governanceCall, proposal, deploymentRecord } from '../src/flcli.js';
import { commitmentFor as ethersCommitment, ROUNDS } from '../src/fl.js';
import { roundsClient, commitmentFor, revealData, commitData } from '../../zetaphy-neuro/ml/fl/rounds.js';
import { checkDeployment } from '../../zetaphy-neuro/ml/fl/deployment.js';
import { GOV_MODULE } from '../src/bridgegate.js';

const TIMELOCK = '0x' + '7a'.repeat(20);

async function setup() {
  const c = await createChain(['deployer', 'gov', 'u0', 'u1']);
  await c.putCode(TIMELOCK, '0x600160005260206000f3');
  const a = (n) => c.acct[n].toString();
  const request = async (m, p) => {
    if (m === 'eth_blockNumber') return '0x' + c.blockNumber().toString(16);
    if (m === 'eth_call') return c.rawCallHex(p[0].to, p[0].data);
    if (m === 'eth_sendTransaction') {
      const r = await c.rawCall(p[0].from, p[0].to, p[0].data);
      const hash = hashText(`${p[0].from}${p[0].data}${c.blockNumber()}`);
      receipts.set(hash, { status: r.ok ? '0x1' : '0x0', blockNumber: '0x' + c.blockNumber().toString(16) });
      return hash;
    }
    if (m === 'eth_getTransactionReceipt') return receipts.get(p[0]) ?? null;
    throw new Error(m);
  };
  const receipts = new Map();
  const deps = {
    me: a('deployer'), request,
    getCode: async (x) => (x.toLowerCase() === TIMELOCK ? '0x6001' : '0x'),
    deploy: async (args) => ({ address: (await c.deploy('FederatedRounds', args, 'deployer')).address, block: Number(c.blockNumber()) }),
  };
  return { c, a, deps, request };
}

async function run(cmd, rest, opt, deps) {
  const out = [];
  const code = await flCommand({ cmd, rest, opt, write: (l) => out.push(l), s: { rpc: 'http://127.0.0.1:8545' }, deps });
  return { code, out: out.join('\n') };
}

test('fl deploy: governance must be the timelock (a contract) or gov, never this key; the contract starts closed', async () => {
  const { a, deps } = await setup();
  await assert.rejects(run('deploy', [], {}, deps), /--governance/);
  await assert.rejects(run('deploy', [], { governance: a('gov') }, deps), /single key/);
  await assert.rejects(run('deploy', [], { governance: a('deployer'), devnet: false }, deps), /not this deployer key|single key/);
  await assert.rejects(run('deploy', [], { governance: TIMELOCK, start: '1' }, deps), /not after the current block/);
  const dir = mkdtempSync(join(tmpdir(), 'flcli-'));
  try {
    const out = join(dir, 'deployment.json');
    const r = await run('deploy', [], { governance: TIMELOCK, 'start-in': '500', 'commit-blocks': '50', 'reveal-blocks': '40', out }, deps);
    assert.equal(r.code, 0);
    assert.match(r.out, /CLOSED/);
    assert.match(r.out, /zetaphy fl propose open --rounds 0x[0-9a-fA-F]{40} --timelock/);
    const rec = checkDeployment(JSON.parse(readFileSync(out, 'utf8')));
    assert.equal(rec.deployed, true);
    assert.equal(rec.governance, getAddress(TIMELOCK));
    assert.equal(rec.chainId, 77390);
    const st = await run('status', [], { rounds: rec.rounds }, deps);
    assert.match(st.out, /CLOSED/);
    assert.match(st.out, /before the first round/);
    // gov module as governance: no code check, the record names the module's EVM address
    const g = await run('deploy', [], { governance: 'gov', 'start-in': '10' }, deps);
    assert.match(g.out, new RegExp(GOV_MODULE));
    assert.match(g.out, /--proposal-out open\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fl propose: calldata the governance runs to open, close and cap; the timelock operation and a gov proposal', async () => {
  const { c, a, deps } = await setup();
  const r = await run('deploy', [], { governance: a('gov'), devnet: true, 'start-in': '4', 'commit-blocks': '30', 'reveal-blocks': '30' }, deps);
  const rounds = /FederatedRounds (0x[0-9a-fA-F]{40})/.exec(r.out)[1];
  const open = proposal(rounds, governanceCall('open'), { timelock: TIMELOCK, salt: 'fl-open', delay: 86400 });
  assert.deepEqual([...ROUNDS_IFACE.decodeFunctionData('setPaused', open.data)], [false]);
  assert.equal(open.delay, 86400);
  assert.match(open.schedule, /^0x01d5062a/); // TimelockController.schedule
  assert.equal(open.proposal.messages[0]['@type'], '/zetaphy.pq.v1.MsgEVMCall');
  assert.equal(open.proposal.messages[0].To, getAddress(TIMELOCK));
  assert.equal(governanceCall('max', '5').fn, 'setMaxPerRound');
  assert.throws(() => governanceCall('max', '0'), /positive/);
  assert.throws(() => governanceCall('nope'), /usage/);
  const printed = await run('propose', ['close'], { rounds, timelock: TIMELOCK }, deps);
  assert.match(printed.out, /setPaused\(true\)/);
  assert.match(printed.out, /operation 0x[0-9a-f]{64}/);
  // governance sends the printed calldata: the contract opens
  assert.equal((await c.rawCall('gov', rounds, open.data)).ok, true);
  assert.match((await run('status', [], { rounds }, deps)).out, /: open/);
  assert.equal((await c.rawCall('u0', rounds, open.data)).ok, false, 'only governance');
});

test('fl config: the record for an existing contract', async () => {
  const { deps } = await setup();
  await assert.rejects(run('config', [], {}, deps), /usage/);
  const r = await run('config', [], { rounds: '0x' + '12'.repeat(20), block: '7', governance: TIMELOCK }, deps);
  const rec = checkDeployment(JSON.parse(r.out));
  assert.equal(rec.deployBlock, 7);
  assert.throws(() => deploymentRecord({ rounds: '0x12', deployBlock: 1, governance: TIMELOCK, rpc: 'https://x.example' }));
});

test('browser client (ml/fl/rounds.js) = ethers and the contract: commitment, calldata, a whole commit and reveal', async () => {
  const { c, a, deps, request } = await setup(); // (this test chain moves 2 blocks per call)
  const r = await run('deploy', [], { governance: a('gov'), devnet: true, 'start-in': '6', 'commit-blocks': '400', 'reveal-blocks': '400' }, deps);
  const rounds = /FederatedRounds (0x[0-9a-fA-F]{40})/.exec(r.out)[1];
  const payload = Uint8Array.from({ length: 70 }, (_, i) => (i * 37) & 255);
  const salt = hashText('salt');
  assert.equal(commitmentFor(payload, salt, a('u0')), ethersCommitment(payload, salt, a('u0')));
  assert.equal(revealData(3, salt, payload), ROUNDS.encodeFunctionData('reveal', [3, salt, payload]));
  assert.equal(commitData(3, salt), ROUNDS.encodeFunctionData('commit', [3, salt]));
  await c.rawCall('gov', rounds, ROUNDS_IFACE.encodeFunctionData('setPaused', [false]));
  const rc = roundsClient(request, rounds);
  while ((await rc.status()).phase !== 1) c.mine(1);
  const s = await rc.status(a('u0'));
  assert.equal(s.round, 0n);
  assert.equal(s.committed, false);
  await rc.commit(a('u0'), 0, commitmentFor(payload, salt, a('u0')), { poll: 1 });
  const s2 = await rc.status(a('u0'));
  assert.equal(s2.committed, true);
  assert.equal(s2.commits, 1n);
  await assert.rejects(rc.reveal(a('u0'), 0, salt, payload, { poll: 1 }), /reverted/, 'not in the reveal phase yet');
  while ((await rc.status()).phase !== 2) c.mine(1);
  await rc.reveal(a('u0'), 0, salt, payload, { poll: 1 });
  const s3 = await rc.status(a('u0'));
  assert.equal(s3.revealed, true);
  assert.equal(s3.reveals, 1n);
  assert.equal(hexlify(payload).length, 2 + 140);
});
