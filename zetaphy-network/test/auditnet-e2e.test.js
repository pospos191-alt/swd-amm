// The open audit network end to end on an in-memory chain behind a real ethers provider (signed transactions,
// chain id 77390), through the CLI's own command paths (`zetaphy audit …`, src/auditnetcli.js):
//   deploy (governance = a ZetaphyTimelock, no key keeps a role) → request → automated tier (3 runners run the
//   pipeline adapter on the fixture + Neuro's code-only scan, commit, reveal; 2 of 3 agree) → contest (bonded
//   auditors commit reports and a finding, reveal) → judging (a valid high) → refused → the fix as a new version
//   (new codeHash, carries the high) → judges confirm the fix → certificate → the explorer's badge reader and the
//   hub's decoder read it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContractFactory, ZeroAddress, keccak256 } from 'ethers';
import { createRpcChain } from './helpers/rpcchain.js';
import { workMocks } from './helpers/workmocks.js';
import { deployAuditNetwork } from '../src/auditnetops.js';
import { auditCommand } from '../src/auditnetcli.js';
import { core } from '../src/auditnet.js';
import { createAudit } from '../../zetaphy-explorer/src/audit.js';

const DAY = 86400;
const FIXTURE = new URL('./fixtures/audit-report.json', import.meta.url).pathname;

test('e2e: request → automated tier → contest → judging → fix as a new version → certificate → explorer and hub read it', { timeout: 600_000 }, async () => {
  const c = await createRpcChain({ accounts: 12 });
  const [deployer, proposer, sponsor, a1, a2, a3, j1, j2, j3, r1, r2, r3] = c.signers;
  const tmp = mkdtempSync(join(tmpdir(), 'zetaphy-audit-e2e-'));
  try {
    const m = workMocks();
    const jobs = await new ContractFactory(m.MockRunners.abi, m.MockRunners.bytecode, deployer).deploy();
    await jobs.waitForDeployment();
    for (const r of [r1, r2, r3]) await (await jobs.set(r.address, true, 5, 0)).wait();
    const tl = await c.deploy('ZetaphyTimelock', [2 * DAY, [proposer.address], [ZeroAddress], ZeroAddress], deployer);
    const timelock = await tl.getAddress();
    const d = await deployAuditNetwork({ signer: deployer, governance: timelock, treasury: proposer.address, jobs: await jobs.getAddress(), judgeParams: { judgeMinScore: 0 } });
    assert.equal(d.chainId, 77390);
    const C = d.contracts;
    const net = c.at('AuditNetwork', C.auditNetwork, deployer);
    assert.equal(await net.governance(), timelock, 'governance is the timelock');
    await assert.rejects(net.setTreasury.staticCall(deployer.address), (e) => net.interface.parseError(e.data)?.name === 'NotGovernance', 'the deployer kept nothing');

    // the CLI, as each actor (each with its own ~/.zetaphy for salts)
    const logs = [];
    const cli = (who, argv) => {
      const [cmd, ...rest] = argv.filter((x) => !x.startsWith('--'));
      const opt = { 'audit-network': C.auditNetwork, 'audit-runners': C.auditRunners, 'audit-judges': C.auditJudges, 'audit-certificate': C.auditCertificate };
      for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const key = argv[i].slice(2); opt[key] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i]; }
      const home = join(tmp, who.address);
      return auditCommand({ group: 'audit', cmd, rest, opt, s: {}, home, write: (l) => logs.push(`${who.address.slice(0, 8)} ${l}`),
        connect: async () => ({ provider: c.provider, signer: who, me: who.address }), connectRpc: async () => c.provider });
    };
    const file = (name, text) => { const p = join(tmp, name); writeFileSync(p, text); return p; };

    // ---- version 1
    const v1 = await c.deploy('VulnerableVault', [], deployer);
    const v1a = await v1.getAddress();
    assert.equal(await cli(sponsor, ['request', '77390', v1a, '--source', 'd07b980', '--days', '7', '--auditors', '3', '--pool', '100']), 0);
    for (const r of [r1, r2, r3]) assert.equal(await cli(r, ['run', '0', '--pipeline', FIXTURE, '--no-sourcify', '--out', join(tmp, 'out')]), 0);
    for (const a of [a1, a2, a3]) {
      assert.equal(await cli(a, ['bond', '--amount', '10']), 0);
      assert.equal(await cli(a, ['commit-report', '0', '--report', file(`report-${a.address}.md`, `# Report by ${a.address}\nScope reviewed.`)]), 0);
    }
    const bug = file('bug.md', 'withdraw() sends before it zeroes the balance: reentrancy drains the vault');
    const poc = file('Exploit.t.sol', 'function test_reentrancy() public { attacker.attack(); }');
    assert.equal(await cli(a1, ['submit', '0', '--finding', bug, '--severity', 'high', '--poc', poc]), 0);
    // the commitment on-chain reveals nothing: the finding text is not derivable from it
    const f0 = await net.getFinding(0n);
    assert.notEqual(f0.findingHash, keccak256(Buffer.from('x')));
    assert.equal(f0.findingHash, '0x' + '00'.repeat(32), 'nothing but the commitment before the reveal');

    c.advance(7 * DAY);
    for (const a of [a1, a2, a3]) assert.equal(await cli(a, ['reveal-report', '0']), 0);
    assert.equal(await cli(a1, ['reveal', '0', '--uri', 'ipfs://bug']), 0);
    for (const r of [r1, r2, r3]) assert.equal(await cli(r, ['run', '0', '--reveal']), 0);
    for (const j of [j1, j2, j3]) {
      assert.equal(await cli(j, ['judge-bond', '--amount', '100']), 0);
      assert.equal(await cli(j, ['judge', '0', '--valid', '--severity', 'high']), 0);
    }
    c.advance(3 * DAY + 7 * DAY + 5 * DAY);
    assert.equal(await cli(sponsor, ['settle', '0']), 0);
    assert.equal(await cli(sponsor, ['certify', '0']), 1, 'refused: a valid high is open');
    assert.ok(logs.some((l) => /not certifiable: critHigh/.test(l)));
    assert.equal(await cli(a1, ['claim', '0']), 0, 'the finder is paid from the pool');

    // ---- version 2: the fix (new code, so a new codeHash and a new request through the whole process)
    const v2 = await c.deploy('TestStable', ['Fixed Vault', 'FIX'], deployer);
    const v2a = await v2.getAddress();
    assert.equal(await cli(sponsor, ['request', '77390', v2a, '--source', 'e1f2a3b', '--days', '7', '--auditors', '3', '--pool', '100', '--fixes', '0']), 0);
    assert.deepEqual([...await net.carriedOf(1n)].map(Number), [0], 'the high of version 1 is carried');
    for (const r of [r1, r2, r3]) assert.equal(await cli(r, ['run', '1', '--pipeline', FIXTURE, '--no-sourcify', '--out', join(tmp, 'out')]), 0);
    for (const a of [a1, a2, a3]) assert.equal(await cli(a, ['commit-report', '1', '--report', file(`report2-${a.address}.md`, 'v2 reviewed: the reentrancy is gone')]), 0);
    c.advance(7 * DAY);
    for (const a of [a1, a2, a3]) assert.equal(await cli(a, ['reveal-report', '1']), 0);
    for (const r of [r1, r2, r3]) assert.equal(await cli(r, ['run', '1', '--reveal']), 0);
    for (const j of [j1, j2, j3]) assert.equal(await cli(j, ['judge-fix', '1', '0', '--fixed']), 0);
    c.advance(3 * DAY + 7 * DAY + 5 * DAY);
    assert.equal(await cli(sponsor, ['settle', '1']), 0);
    assert.equal(await cli(sponsor, ['certify', '1']), 0);
    assert.equal(await cli(sponsor, ['cert', '77390', v2a]), 0);
    assert.ok(logs.some((l) => /CERTIFIED · bronze/.test(l)), logs.slice(-3).join('\n'));
    assert.equal(await cli(sponsor, ['cert', '77390', v1a]), 1, 'version 1 never got one');

    // ---- the explorer badge and the hub read the same certificate from the node
    const explorer = createAudit({ single: (method, params) => c.handle(method, params), contract: C.auditCertificate, chainId: 77390 });
    const e2 = await explorer.lookup(v2a);
    assert.equal(e2.state, 'valid');
    assert.equal(e2.level, 1);
    assert.equal((await explorer.lookup(v1a)).state, 'none');
    const raw = await c.handle('eth_call', [{ to: C.auditCertificate, data: core.calldata((await import('../src/auditnet.js')).k, core.SIG.certificate, [77390n, v2a]) }, 'latest']);
    const hub = core.decodeCertificate(raw);
    assert.equal(core.certState(hub, Number(c.now())), 'valid');
    assert.equal(hub.cert.codeHash, keccak256(await c.provider.getCode(v2a)), 'bound to the exact code');
    // the automated result every runner hashed is the certificate's report hash
    const [agreed, res] = await c.at('AuditRunners', C.auditRunners).result(1n);
    assert.equal(agreed, true);
    assert.equal(hub.cert.reportHash, res.resultHash.toLowerCase());
    // money out, through the pull payments
    for (const who of [a1, r1]) assert.equal(await cli(who, ['withdraw']), 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
