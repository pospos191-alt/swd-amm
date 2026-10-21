// Neuro's stop button, voted on a real ZETAPHY chain (zetaphyd, 1 s blocks,
// 20 s votes): NeuroControl's governance is the gov module's EVM address, and
// a gov proposal whose message is MsgEVMCall{sender: gov module} calls it
// (zetaphy-chain/gov.sh neuro ...).
//   - deploy NeuroJobs + NeuroControl with --governance gov; a job goes in
//   - the deployer key can no longer pause; a vote pauses Neuro
//   - NeuroJobs refuses requests, coin transfers still work
//   - a second vote unpauses it and requests work again
//   - only chains on NeuroControl's allowlist take requests; a vote removes one
//   - votes set the challenge bond (decimal ZETAPHY) and the defender timeout
// Needs a zetaphyd with MsgEVMCall: ZETAPHYD=/path/to/zetaphyd npm run test:devnet:neurogov

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, encodeBytes32String } from 'ethers';

const ZETAPHYD = process.env.ZETAPHYD || 'zetaphyd';
const PORT = 21545; // EVM JSON-RPC; scripts/devnet.sh also uses +1 and +100..+103
const RPC = `http://127.0.0.1:${PORT}`;
const GOV_MODULE = '0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-neurogov-'));
const chainHome = join(root, 'chain');
const actors = Object.fromEntries(['deployer', 'user'].map((n) => [n, Wallet.createRandom()]));
const env = { ...process.env, ZETAPHYD, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let jobsAddr, controlAddr;

function cli(actor, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args, '--rpc', RPC], {
      env: { ...env, ZETAPHY_HOME: join(root, actor) }, timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}

const govEnv = { ...env, NODE_HOME: chainHome, KEYS_DIR: chainHome, NODE: `tcp://127.0.0.1:${PORT + 100}`, CHAIN_ID: 'zetaphy-local-1' };
const gov = (...a) => execFileSync(new URL('../../zetaphy-chain/gov.sh', import.meta.url).pathname, a, { env: govEnv, encoding: 'utf8' });

/** gov.sh neuro <args>, vote yes with the only validator, wait for the result. */
async function vote(...args) {
  const out = gov('neuro', ...args);
  const id = /proposal (\d+) submitted/.exec(out)?.[1];
  assert.ok(id, out);
  assert.match(gov('vote', id, 'yes'), /voted yes/);
  let st;
  for (let i = 0; i < 60; i++) {
    st = JSON.parse(gov('status', id));
    if (st.status !== 'PROPOSAL_STATUS_VOTING_PERIOD' && st.status !== 'PROPOSAL_STATUS_DEPOSIT_PERIOD') break;
    await sleep(1000);
  }
  const full = JSON.parse(execFileSync(ZETAPHYD, ['q', 'gov', 'proposal', id, '--node', govEnv.NODE, '-o', 'json'], { env, encoding: 'utf8' })).proposal;
  assert.equal(st.status, 'PROPOSAL_STATUS_PASSED', `proposal ${id}: ${st.status} ${full.failed_reason ?? ''}`);
  return full;
}

before(() => {
  for (const [n, w] of Object.entries(actors)) {
    mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, n, 'worker.key'), w.privateKey + '\n', { mode: 0o600 });
  }
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname, [chainHome, String(PORT), ...Object.values(actors).map((w) => w.address)],
    { stdio: 'inherit', env });
});

after(async () => {
  try { process.kill(Number(readFileSync(join(chainHome, 'node.pid'), 'utf8'))); } catch { /* gone */ }
  await sleep(1000);
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test('the gov module address is the first 20 bytes of sha256("gov")', () => {
  const acct = JSON.parse(execFileSync(ZETAPHYD, ['q', 'auth', 'module-account', 'gov', '--node', govEnv.NODE, '-o', 'json'], { env, encoding: 'utf8' }));
  const bech = acct.account.value.address;
  const dbg = execFileSync(ZETAPHYD, ['debug', 'addr', bech, '--home', chainHome], { env, encoding: 'utf8' });
  assert.match(dbg, new RegExp(`Address hex: ${GOV_MODULE}`, 'i'));
});

test('deploy with --governance gov: the gov module owns NeuroControl, the voted skill is set', { timeout: 120_000 }, async () => {
  const d = await cli('deployer', ['deploy', '--governance', 'gov', '--window', '10', '--timeout', '60', '--unbond', '120']);
  assert.equal(d.code, 0, d.out);
  jobsAddr = /NeuroJobs deployed at (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  controlAddr = /NeuroControl (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const control = new Contract(controlAddr, art('NeuroControl').abi, provider);
  assert.equal((await control.governance()).toLowerCase(), GOV_MODULE.toLowerCase());
  const skill = (await cli('user', ['neuro', 'skill-id'])).out.trim();
  assert.equal(await control.activeSkill(), skill);
  const r = await cli('user', ['job', 'request', 'bsc', '0xc1ed4b78071e7c9a84958d8be0215a10984fc28f', '--jobs', jobsAddr]);
  assert.match(r.out, /job 0 requested/, r.out);
  // setControl came right after NeuroJobs, and the deploy voted in the runner's chains only.
  const jobs = new Contract(jobsAddr, art('NeuroJobs').abi, provider);
  assert.equal((await jobs.control()).toLowerCase(), controlAddr.toLowerCase());
  assert.equal(await control.chainAllowed(encodeBytes32String('zetaphy')), true);
  const fake = await cli('user', ['job', 'request', 'nonexistent', '0xc1ed4b78071e7c9a84958d8be0215a10984fc28f', '--jobs', jobsAddr]);
  assert.notEqual(fake.code, 0, fake.out);
  assert.match(fake.out, /UnknownChain|revert/i, fake.out);
  assert.equal(await jobs.jobCount(), 1n);
  // The deployer key handed governance over: it can no longer stop Neuro.
  const p = await cli('deployer', ['neuro', 'send', 'pause', '--jobs', jobsAddr]);
  assert.notEqual(p.code, 0, p.out);
  assert.equal(await control.paused(), false);
});

test('a gov vote (MsgEVMCall from the gov module) pauses Neuro; coin transfers go on; a second vote unpauses', { timeout: 300_000 }, async () => {
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const control = new Contract(controlAddr, art('NeuroControl').abi, provider);
  const jobs = new Contract(jobsAddr, art('NeuroJobs').abi, provider);

  const passed = await vote('pause', controlAddr);
  const msg = passed.messages[0];
  assert.equal(msg.type ?? msg['@type'], '/zetaphy.pq.v1.MsgEVMCall');
  assert.equal(await control.paused(), true);

  const r = await cli('user', ['job', 'request', 'bsc', '0xc1ed4b78071e7c9a84958d8be0215a10984fc28f', '--jobs', jobsAddr]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /Paused|revert/i, r.out);
  assert.equal(await jobs.jobCount(), 1n);
  const st = await cli('user', ['neuro', 'status', '--jobs', jobsAddr]);
  assert.match(st.out, /Neuro: +PAUSED/, st.out);
  assert.match(st.out, /gov module/, st.out);

  // The coin itself is not stopped.
  const w = new Wallet(actors.user.privateKey, provider);
  const to = Wallet.createRandom().address;
  await (await w.sendTransaction({ to, value: 12345n })).wait();
  assert.equal(await provider.getBalance(to), 12345n);

  await vote('unpause', controlAddr);
  assert.equal(await control.paused(), false);
  const again = await cli('user', ['job', 'request', 'bsc', '0xc1ed4b78071e7c9a84958d8be0215a10984fc28f', '--jobs', jobsAddr]);
  assert.match(again.out, /job 1 requested/, again.out);
});

test('a gov vote approves a defender and raises the body cap', { timeout: 300_000 }, async () => {
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const control = new Contract(controlAddr, art('NeuroControl').abi, provider);
  await vote('approve-defender', actors.user.address, controlAddr);
  assert.equal(await control.defenderApproved(actors.user.address), true);
  await vote('set-max-bodies', '80', controlAddr);
  assert.equal(await control.maxBodies(), 80n);
});

test('gov votes set the challenge bond and the defender timeout', { timeout: 300_000 }, async () => {
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const control = new Contract(controlAddr, art('NeuroControl').abi, provider);
  assert.equal(await control.challengeBond(), 10n ** 18n);
  await vote('set-challenge-bond', '2.5', controlAddr);
  assert.equal(await control.challengeBond(), 25n * 10n ** 17n);
  await vote('set-defender-timeout', '3600', controlAddr);
  assert.equal(await control.defenderTimeout(), 3600n);
  const st = await cli('user', ['neuro', 'status', '--jobs', jobsAddr]);
  assert.match(st.out, /challenges: bond at least max\(2 x fee, 2\.5 ZETAPHY\).*heartbeat every 3600 s/, st.out);
});

test('a gov vote removes a chain key: requests for it are refused', { timeout: 300_000 }, async () => {
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const control = new Contract(controlAddr, art('NeuroControl').abi, provider);
  assert.equal(await control.chainAllowed(encodeBytes32String('ton')), true);
  await vote('remove-chain', 'ton', controlAddr);
  assert.equal(await control.chainAllowed(encodeBytes32String('ton')), false);
  const r = await cli('user', ['job', 'request', 'ton', 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', '--jobs', jobsAddr]);
  assert.notEqual(r.code, 0, r.out);
  const st = await cli('user', ['neuro', 'status', '--jobs', jobsAddr]);
  assert.match(st.out, /not voted in: ton/, st.out);
});
