// Unit tests: the step runner (order, resume, dry-run, --only, failures), the state file
// (atomic, no secrets), the config writers, argument checks and the key loader. No chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { runSteps, newState, saveState, loadState, outputs, assertNoSecrets } from '../src/runner.js';
import { dexWeb, nftWeb, explorerConfig, walletHtml, snapConfig, publicBase, neuroReportUrl, CONFIG_FILES } from '../src/configs.js';
import { readDeployerKey, keyFolder } from '../src/key.js';
import { parseArgs, governanceTarget } from '../launch.js';
import { launchSteps, adminRoles, evmCallProposal, handoverPlan, GOV_MODULE, GOV_MODULE_BECH32, BRIDGE_GATES } from '../src/steps.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'zetaphy-launch-unit-'));
const A = (n) => '0x' + String(n).padStart(40, '0');

/** Fake steps that record calls. */
function fakeSteps(calls, { failAt = null } = {}) {
  const mk = (name, extra = {}) => ({ name, describe: `do ${name}`, async run() { calls.push(name); if (name === failAt) throw new Error('boom'); return { [`${name}Addr`]: A(calls.length) }; }, ...extra });
  return [mk('a'), mk('b'), mk('c', { when: (ctx) => (ctx.withC ? true : 'no c') }), mk('d', { always: true })];
}

test('runs the steps in order and records each one with its outputs', async () => {
  const calls = [], saves = [];
  const state = newState({ chainId: 77390 });
  const r = await runSteps({ steps: fakeSteps(calls), state, ctx: { withC: true }, log: () => {}, save: (s) => saves.push(JSON.stringify(s)) });
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
  assert.deepEqual(r.ran, ['a', 'b', 'c', 'd']);
  assert.equal(saves.length, 4, 'saved after every step');
  assert.equal(outputs(state).bAddr, A(2));
  assert.ok(state.steps.a.doneAt);
});

test('resume: done steps are skipped, `always` steps run again, a skipped `when` is not recorded', async () => {
  const calls = [];
  const state = newState({ chainId: 77390 });
  await runSteps({ steps: fakeSteps(calls), state, ctx: {}, log: () => {} });
  assert.deepEqual(calls, ['a', 'b', 'd']);
  assert.equal(state.steps.c, undefined);
  calls.length = 0;
  const lines = [];
  const r = await runSteps({ steps: fakeSteps(calls), state, ctx: { withC: true }, log: (l) => lines.push(l) });
  assert.deepEqual(calls, ['c', 'd']);
  assert.deepEqual(r.skipped, ['a', 'b']);
  assert.ok(lines.some((l) => /✓ a: done/.test(l)));
});

test('a failure keeps the finished steps; the next run continues at the failed one', async () => {
  const calls = [];
  const dir = tmp();
  const file = join(dir, 'state', '77390.json');
  const state = newState({ chainId: 77390, deployer: A(9) });
  await assert.rejects(runSteps({ steps: fakeSteps(calls, { failAt: 'b' }), state, ctx: {}, log: () => {}, save: (s) => saveState(file, s) }),
    (e) => e.step === 'b' && /step b failed: boom/.test(e.message) && /--resume/.test(e.message));
  const back = loadState(file);
  assert.ok(back.steps.a.doneAt);
  assert.equal(back.steps.b, undefined);
  calls.length = 0;
  await runSteps({ steps: fakeSteps(calls), state: back, ctx: {}, log: () => {}, save: (s) => saveState(file, s) });
  assert.deepEqual(calls, ['b', 'd']);
  assert.deepEqual(readdirSync(join(dir, 'state')), ['77390.json'], 'no temp file left behind');
});

test('a stale-nonce failure is retried (after settle); other failures are not', async () => {
  const state = newState({ chainId: 77390 });
  let tries = 0, settles = 0;
  const flaky = { name: 'x', describe: 'x', async run() { if (++tries < 3) throw new Error('nonce has already been used'); return { xAddr: A(1) }; } };
  await runSteps({ steps: [flaky], state, ctx: {}, log: () => {}, settle: async () => { settles++; } });
  assert.equal(tries, 3);
  assert.equal(settles, 3);
  assert.equal(outputs(state).xAddr, A(1));
  let once = 0;
  const bad = { name: 'y', describe: 'y', async run() { once++; throw new Error('execution reverted'); } };
  await assert.rejects(runSteps({ steps: [bad], state, ctx: {}, log: () => {} }), /step y failed/);
  assert.equal(once, 1);
  let always = 0;
  const stale = { name: 'z', describe: 'z', async run() { always++; throw Object.assign(new Error('x'), { code: 'NONCE_EXPIRED' }); } };
  await assert.rejects(runSteps({ steps: [stale], state, ctx: {}, log: () => {}, attempts: 2 }), /step z failed/);
  assert.equal(always, 2);
});

test('dry-run runs nothing and records nothing', async () => {
  const calls = [];
  const state = newState({ chainId: 77390 });
  let saved = 0;
  const lines = [];
  const r = await runSteps({ steps: fakeSteps(calls), state, ctx: {}, dryRun: true, log: (l) => lines.push(l), save: () => saved++ });
  assert.deepEqual(calls, []);
  assert.deepEqual(r.wouldRun, ['a', 'b', 'd']);
  assert.equal(saved, 0);
  assert.deepEqual(state.steps, {});
  assert.ok(lines.some((l) => /c: skipped \(no c\)/.test(l)));
});

test('--only runs just those steps; --redo runs a done one again; an unknown name is refused', async () => {
  const calls = [];
  const state = newState({ chainId: 77390 });
  await runSteps({ steps: fakeSteps(calls), state, ctx: {}, only: ['b'], log: () => {} });
  assert.deepEqual(calls, ['b']);
  await runSteps({ steps: fakeSteps(calls), state, ctx: {}, only: ['b'], log: () => {} });
  assert.deepEqual(calls, ['b'], 'done: not run again');
  await runSteps({ steps: fakeSteps(calls), state, ctx: {}, only: ['b'], redo: true, log: () => {} });
  assert.deepEqual(calls, ['b', 'b']);
  await assert.rejects(runSteps({ steps: fakeSteps(calls), state, ctx: {}, only: ['nope'], log: () => {} }), /no such step/);
});

test('the state file holds no secrets', () => {
  assert.throws(() => assertNoSecrets({ steps: { a: { out: { privateKey: '0x' + '1'.repeat(64) } } } }), /secret/);
  assert.throws(() => assertNoSecrets({ mnemonic: 'a b c' }), /secret/);
  assert.doesNotThrow(() => assertNoSecrets({ nft: { collectionCodeKeys: { erc721: '0x' + '1'.repeat(64) } }, codeKey: '0x1' }));
  const file = join(tmp(), 's.json');
  assert.throws(() => saveState(file, { ...newState({ chainId: 1 }), deployerKey: 'x' }), /secret/);
  assert.equal(existsSync(file), false);
});

test('the real step list: order puts configuration before the handover, which is opt-in', () => {
  const names = launchSteps().map((s) => s.name);
  assert.deepEqual(names, ['neuro', 'skill', 'threats', 'reports', 'identity', 'vault', 'pq', 'stable', 'compute', 'bridge', 'dex', 'nft', 'wire', 'protect', 'configs', 'snap', 'handover']);
  const byName = Object.fromEntries(launchSteps().map((s) => [s.name, s]));
  assert.notEqual(byName.handover.when({ handover: false }), true);
  assert.equal(byName.handover.when({ handover: true }), true);
  assert.notEqual(byName.bridge.when({}), true, 'the bridge is off by default');
  assert.match(byName.bridge.describe, /deployed CLOSED/, 'the launch deploys the bridge closed, never open');
  // Every artifact a step prices (the cost estimate) is committed.
  for (const st of launchSteps()) for (const [pkg, n] of st.artifacts ?? []) assert.ok(existsSync(join(ROOT, pkg, 'artifacts', `${n}.json`)), `${st.name}: ${pkg}/${n}`);
  const gates = BRIDGE_GATES.join('\n');
  for (const re of [/independentLanes\(\) >= 2/, /--audit-sha256/, /10 independent Neuro runners/, /different multisigs/, /starter cap 1,000/, /--i-understand-real-funds/]) assert.match(gates, re);
  assert.notEqual(byName.identity.when({}), true, 'identity needs --neuro-url');
  for (const n of ['skill', 'wire', 'protect', 'configs', 'snap', 'handover']) assert.equal(byName[n].always, true, `${n} re-checks every run`);
});

const OUT = {
  publicRpc: 'https://1-2-3-4.sslip.io/', threatRegistry: A(7), neuroUrl: 'https://neuro.example.org/web/', walletOrigin: 'https://wallet.example.org',
  dex: { name: 'ZETAPHY DEX', chainId: 77390, rpc: 'x', contracts: { factory: A(1), router: A(2), wnative: A(3), threatRegistry: A(7) }, tokens: [] },
  nft: { network: 'zetaphy-testnet', chainId: 77390, rpc: 'x', factory: A(4), marketplace: A(5), threatRegistry: A(7) },
};
const committed = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('config writers: DEX and NFT deployments.json', () => {
  const dex = JSON.parse(dexWeb(committed('zetaphy-dex/web/deployments.json'), OUT));
  assert.equal(dex.rpc, 'https://1-2-3-4.sslip.io');
  assert.equal(dex.contracts.router, A(2));
  assert.equal(dex.neuroRegistry, A(7));
  const nft = JSON.parse(nftWeb(committed('zetaphy-nft/web/deployments.json'), OUT));
  assert.equal(nft.rpc, 'https://1-2-3-4.sslip.io');
  assert.equal(nft.marketplace, A(5));
  assert.throws(() => dexWeb('', { ...OUT, dex: undefined }), /not deployed/);
  assert.throws(() => nftWeb('', { ...OUT, nft: { factory: '', marketplace: A(5) } }), /no address/);
});

test('config writers: explorer keeps its other settings', () => {
  const ex = JSON.parse(explorerConfig(committed('zetaphy-explorer/config.json'), { ...OUT, neuroReadsZetaphy: true }));
  assert.equal(ex.node, 'https://1-2-3-4.sslip.io');
  assert.equal(ex.threatRegistry, A(7));
  assert.equal(ex.neuroReportUrl, 'https://neuro.example.org/web/?chain=zetaphy&address={address}');
  assert.equal(ex.scanBlocks, 100);
  assert.equal(ex.evmRpc, '');
  const noLink = JSON.parse(explorerConfig(committed('zetaphy-explorer/config.json'), OUT));
  assert.equal(noLink.neuroReportUrl, '', 'no link while the Neuro page does not read ZETAPHY');
});

test('config writers: wallet meta tags (adds zetaphy-rpc if missing, escapes)', () => {
  const html = walletHtml(committed('zetaphy-wallet/index.html'), OUT);
  assert.match(html, /<meta name="zetaphy-rpc" content="https:\/\/1-2-3-4\.sslip\.io">/);
  assert.match(html, new RegExp(`<meta name="zetaphy-threat-registry" content="${A(7)}">`));
  assert.match(html, /<meta name="zetaphy-snap-id" content="npm:@zetaphy\/snap">/, 'other tags untouched');
  const bare = walletHtml('<head>\n<title>t</title>', OUT);
  assert.match(bare, /<meta name="zetaphy-rpc" content="https:\/\/1-2-3-4\.sslip\.io">\n<meta name="zetaphy-threat-registry"[^\n]*\n<title>/);
  assert.equal(walletHtml(html, OUT), html, 'idempotent');
});

test('config writers: snap.config.js constants (and only those)', () => {
  const before = committed('zetaphy-snap/snap.config.js');
  const after = snapConfig(before, OUT);
  assert.match(after, /ZETAPHY_THREAT_RPC: 'https:\/\/1-2-3-4\.sslip\.io'/);
  assert.match(after, new RegExp(`ZETAPHY_THREAT_REGISTRY: '${A(7)}'`));
  assert.match(after, /ZETAPHY_WALLET_ORIGINS: 'https:\/\/wallet\.example\.org'/);
  assert.equal(after.split('\n').length, before.split('\n').length);
  const keep = snapConfig(before, { ...OUT, walletOrigin: null });
  assert.match(keep, /ZETAPHY_WALLET_ORIGINS: 'https:\/\/wallet\.zetaphy\.invalid'/, 'no --wallet-origin: kept');
  assert.throws(() => snapConfig(before, { ...OUT, walletOrigin: "https://x.org/'+evil" }), /origin/);
  assert.throws(() => snapConfig(before, { ...OUT, threatRegistry: '' }), /ThreatRegistry/);
});

test('config writers: the list covers every web app config', () => {
  assert.deepEqual(CONFIG_FILES.map(([f]) => f), ['zetaphy-dex/web/deployments.json', 'zetaphy-nft/web/deployments.json', 'zetaphy-explorer/config.json',
    'zetaphy-wallet/index.html', 'zetaphy-snap/snap.config.js']);
  for (const [f] of CONFIG_FILES) assert.ok(existsSync(join(ROOT, f)), f);
});

test('URLs: https only (http for localhost), no credentials', () => {
  assert.equal(publicBase('https://a.b/'), 'https://a.b');
  assert.equal(publicBase('http://127.0.0.1:8545'), 'http://127.0.0.1:8545');
  assert.throws(() => publicBase('http://1.2.3.4:8545'), /https/);
  assert.throws(() => publicBase('https://u:p@a.b'), /credentials/);
  assert.throws(() => neuroReportUrl('http://x.org/web/'), /https/);
});

test('arguments: no key on the command line; governance targets', () => {
  assert.throws(() => parseArgs(['--key', '0xabc']), /--key-file/);
  assert.throws(() => parseArgs(['--rpc']), /needs a value/);
  assert.deepEqual(parseArgs(['--rpc', 'https://x', '--dry-run', '--only', 'a,b']), { rpc: 'https://x', 'dry-run': true, only: 'a,b' });
  assert.equal(governanceTarget(undefined), null);
  assert.equal(governanceTarget('deployer'), null);
  assert.equal(governanceTarget('gov'), GOV_MODULE);
  assert.equal(governanceTarget(A(5).toLowerCase()), A(5));
  assert.throws(() => governanceTarget('0x12'), /governance/);
});

test('the deployer key: from a 0600 file or the environment; never in an error message', () => {
  const dir = tmp();
  const w = Wallet.createRandom();
  const f = join(dir, 'k');
  writeFileSync(f, w.privateKey.slice(2) + '\n', { mode: 0o600 });
  assert.equal(readDeployerKey({ 'key-file': f }, {}).privateKey, w.privateKey);
  writeFileSync(join(dir, 'open'), w.privateKey, { mode: 0o644 });
  assert.throws(() => readDeployerKey({ 'key-file': join(dir, 'open') }, {}), /chmod 600/);
  assert.equal(readDeployerKey({}, { ZETAPHY_DEPLOYER_KEY: w.privateKey, ZETAPHY_HOME: dir }).source, 'env ZETAPHY_DEPLOYER_KEY');
  writeFileSync(join(dir, 'bad'), 'not-a-key-but-secret-text', { mode: 0o600 });
  assert.throws(() => readDeployerKey({ 'key-file': join(dir, 'bad') }, {}), (e) => !e.message.includes('secret-text'));
  assert.throws(() => readDeployerKey({}, { ZETAPHY_HOME: dir }), /no deployer key/);
  const kf = keyFolder(w.privateKey);
  assert.equal(statSync(kf.dir).mode & 0o777, 0o700);
  assert.equal(statSync(kf.keyFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(kf.home, 'worker.key')).mode & 0o777, 0o600);
  kf.cleanup();
  assert.equal(existsSync(kf.dir), false);
});

test('handover: roles, the gov proposal for the DEX, the printed plan', () => {
  const o = { neuroControl: A(1), threatRegistry: A(2), stableGateway: A(3), dex: { contracts: { factory: A(4) } }, nft: { marketplace: A(5) } };
  const roles = adminRoles(o);
  assert.deepEqual(roles.map((r) => r.address), [A(1), A(2), A(3), A(5), A(4)]);
  assert.equal(roles.find((r) => r.address === A(4)).twoStep, true);
  const p = evmCallProposal({ to: A(4), data: '0x0e18b681', title: 't', summary: 's' });
  assert.equal(p.messages[0]['@type'], '/zetaphy.pq.v1.MsgEVMCall');
  assert.equal(p.messages[0].Sender, GOV_MODULE_BECH32);
  assert.equal(p.messages[0].Data, Buffer.from('0e18b681', 'hex').toString('base64'));
  const state = { chainId: 77390, steps: { x: { doneAt: 't', out: o } } };
  const plan = handoverPlan({ governance: null, address: A(9), publicRpc: 'https://h' }, state);
  assert.match(plan, /handover = yes/);
  assert.match(plan, new RegExp(`gov\\.sh neuro pause ${A(1)}`));
  assert.match(plan, /dex-accept-governance\.json/);
});
