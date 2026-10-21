// End to end on a real ZETAPHY devnet (zetaphy-network/scripts/devnet.sh, 1 s blocks):
//   - launch.js --dry-run sends nothing and writes nothing
//   - a full launch deploys every contract and writes every web app config with real addresses (code checked)
//   - --resume deploys nothing new; without it a second run is refused
//   - smoke: the DEX router quotes, the NFT factory makes a collection, NeuroJobs takes a request under the voted skill
//   - --governance gov --handover: every admin role goes to the gov module, and the DEX's
//     acceptGovernance proposal file passes a real vote
// The config files it writes are restored afterwards (the committed ones stay placeholders).
//
//   ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:devnet

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, JsonRpcProvider, Contract, NonceManager, encodeBytes32String, parseEther, ZeroAddress } from 'ethers';
import { CONFIG_FILES } from '../src/configs.js';
import { GOV_MODULE } from '../src/steps.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ZETAPHYD = process.env.ZETAPHYD || 'zetaphyd';
const PORT = Number(process.env.LAUNCH_DEVNET_PORT || 26545); // devnet.sh also uses +1 and +100..+103
const RPC = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'zetaphy-launch-e2e-'));
const chainHome = join(root, 'chain');
const stateFile = join(root, 'state.json');
const keyFile = join(root, 'deployer.key');
const deployer = Wallet.createRandom();
const user = Wallet.createRandom();
const env = { ...process.env, ZETAPHYD, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
// zetaphyd leaves a data/ folder in its working directory: run it (and devnet.sh) in the temp folder.
const zd = (args) => execFileSync(ZETAPHYD, args, { env, encoding: 'utf8', cwd: root });
const art = (pkg, n) => JSON.parse(readFileSync(join(ROOT, pkg, 'artifacts', `${n}.json`), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEURO_URL = 'https://neuro.example.org/web/';
const WALLET_ORIGIN = 'https://wallet.example.org';
const LOCKBOX = '11155111:0x00000000000000000000000000000000000Bd0C5';
// Every file the launch may change, restored in after().
const TOUCHED = [...CONFIG_FILES.map(([rel]) => rel), 'zetaphy-snap/snap.manifest.json'];
const saved = new Map();
let provider;

function launch(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, 'zetaphy-launch/launch.js'), '--rpc', RPC, '--key-file', keyFile, '--state', stateFile, ...args],
      { env: { ...env, ...extraEnv }, timeout: 900_000, maxBuffer: 64 << 20 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}
const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const outs = () => Object.assign({}, ...Object.values(state().steps).map((s) => s.out ?? {}));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
async function hasCode(a, what) {
  assert.match(String(a), /^0x[0-9a-fA-F]{40}$/, `${what}: ${a}`);
  assert.notEqual(await provider.getCode(a), '0x', `${what} ${a} has no code`);
}

before(() => {
  for (const rel of TOUCHED) saved.set(rel, existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel)) : null);
  writeFileSync(keyFile, deployer.privateKey + '\n', { mode: 0o600 });
  execFileSync(join(ROOT, 'zetaphy-network/scripts/devnet.sh'), [chainHome, String(PORT), deployer.address, user.address], { stdio: 'inherit', env, cwd: root });
  provider = new JsonRpcProvider(RPC, 77390n, { staticNetwork: true, pollingInterval: 500 });
});

after(async () => {
  for (const [rel, buf] of saved) { if (buf == null) rmSync(join(ROOT, rel), { force: true }); else writeFileSync(join(ROOT, rel), buf); }
  // dist/ (not committed) was built with the devnet constants: rebuild it from the restored config.
  try { execFileSync('npm', ['run', 'build'], { cwd: join(ROOT, 'zetaphy-snap'), env, stdio: 'ignore' }); } catch { /* no node_modules: nothing was built */ }
  provider?.destroy();
  try { process.kill(Number(readFileSync(join(chainHome, 'node.pid'), 'utf8'))); } catch { /* gone */ }
  await sleep(1000);
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test('the key never reaches the command line', async () => {
  const r = await launch(['--key', deployer.privateKey]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /--key is not accepted/);
  assert.ok(!r.out.includes(deployer.privateKey.slice(2)), 'the key is not echoed');
});

test('--dry-run: checks chain and balance, sends nothing, writes nothing', { timeout: 120_000 }, async (t) => {
  const nonce = await provider.getTransactionCount(deployer.address);
  const r = await launch(['--dry-run', '--neuro-url', NEURO_URL]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /EVM chain 77390/);
  assert.match(r.out, /need about [\d,.]+ ZETAPHY/);
  t.diagnostic(/balance .*/.exec(r.out)[0]);
  assert.match(r.out, /neuro: would run/);
  assert.match(r.out, /bridge: skipped/);
  assert.match(r.out, /handover: skipped/);
  assert.equal(existsSync(stateFile), false);
  assert.equal(await provider.getTransactionCount(deployer.address), nonce);
  for (const [rel, buf] of saved) assert.equal(read(rel), buf.toString(), `${rel} untouched`);
});

test('launch: every contract deployed and every config written with real addresses', { timeout: 900_000 }, async () => {
  const r = await launch(['--neuro-url', NEURO_URL, '--wallet-origin', WALLET_ORIGIN, '--bridge-lockbox', LOCKBOX]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes(deployer.privateKey.slice(2)), 'the key is never printed');
  assert.ok(!readFileSync(stateFile, 'utf8').includes(deployer.privateKey.slice(2)), 'the state holds no key');
  const o = outs();
  for (const k of ['neuroJobs', 'neuroControl', 'threatRegistry', 'threatReports', 'neuroIdentity', 'neuroValidation', 'rewardVault', 'quantumWalletFactory',
    'tUSDC', 'tUSDT', 'stableGateway', 'computeMarket', 'bridgeGuard', 'bridgeAirlock', 'neuroLane', 'decoyBridge']) await hasCode(o[k], k);
  assert.match(r.out, /Governance: the deployer is the admin/);
  assert.match(r.out, /gov\.sh neuro approve-skill/);

  // DEX web config
  const dex = JSON.parse(read('zetaphy-dex/web/deployments.json'));
  assert.equal(dex.chainId, 77390);
  assert.equal(dex.rpc, RPC);
  for (const k of ['factory', 'router']) await hasCode(dex.contracts[k], `dex ${k}`);
  await hasCode(dex.neuroRegistry, 'dex neuroRegistry');
  assert.equal(dex.neuroRegistry, o.threatRegistry);
  assert.equal(dex.contracts.threatRegistry, o.threatRegistry);
  assert.equal(dex.tokens.length, 2);
  for (const t of dex.tokens) await hasCode(t.address, t.symbol);
  // NFT web config
  const nft = JSON.parse(read('zetaphy-nft/web/deployments.json'));
  assert.equal(nft.rpc, RPC);
  for (const k of ['factory', 'marketplace', 'threatRegistry']) await hasCode(nft[k], `nft ${k}`);
  assert.equal(nft.threatRegistry, o.threatRegistry);
  // explorer
  const ex = JSON.parse(read('zetaphy-explorer/config.json'));
  assert.equal(ex.node, RPC);
  await hasCode(ex.threatRegistry, 'explorer threatRegistry');
  const { CHAINS } = await import('../../zetaphy-neuro/src/chains.js');
  assert.equal(ex.neuroReportUrl, Object.hasOwn(CHAINS, 'zetaphy') ? 'https://neuro.example.org/web/?chain=zetaphy&address={address}' : '');
  // wallet
  const html = read('zetaphy-wallet/index.html');
  assert.match(html, new RegExp(`<meta name="zetaphy-rpc" content="${RPC}">`));
  const reg = /<meta name="zetaphy-threat-registry" content="(0x[0-9a-fA-F]{40})">/.exec(html)?.[1];
  await hasCode(reg, 'wallet threat registry');
  // snap: constants, then a rebuilt manifest shasum
  const snap = read('zetaphy-snap/snap.config.js');
  assert.match(snap, new RegExp(`ZETAPHY_THREAT_RPC: '${RPC}'`));
  assert.match(snap, new RegExp(`ZETAPHY_THREAT_REGISTRY: '${o.threatRegistry}'`));
  assert.match(snap, new RegExp(`ZETAPHY_WALLET_ORIGINS: '${WALLET_ORIGIN}'`));
  const manifest = JSON.parse(read('zetaphy-snap/snap.manifest.json'));
  assert.notEqual(manifest.source.shasum, JSON.parse(saved.get('zetaphy-snap/snap.manifest.json')).source.shasum);
  assert.equal(manifest.source.shasum, o.snapShasum);

  // Wiring: the routers check the registry, the shared code keys and the bridge's own contracts are protected.
  const R = new Contract(o.threatRegistry, art('zetaphy-network', 'ThreatRegistry').abi, provider);
  for (const k of Object.values(nft.collectionCodeKeys)) assert.equal(await R.protectedKey(k), true, `code key ${k}`);
  assert.equal(await R.protectedKey(await R.addressKey(77390n, o.bridgeAirlock)), true, 'bridge airlock protected');
  assert.equal(await R.protectedKey(await R.addressKey(11155111n, LOCKBOX.split(':')[1])), true, 'lockbox protected');
  // The bridge is deployed CLOSED: its route disabled, the 1,000-token hard cap, no audit on record.
  const guard = new Contract(o.bridgeGuard, art('zetaphy-network', 'BridgeGuard').abi, provider);
  const route = await new Contract(o.bridgeAirlock, art('zetaphy-network', 'BridgeAirlock').abi, provider).route();
  assert.equal((await guard.routes(route)).enabled, false, 'the bridge route is closed');
  assert.equal(await guard.maxDailyLimit(), 1000n * 10n ** 18n);
  assert.equal(await guard.auditSha256(), '0x' + '00'.repeat(32));
  assert.equal(o.bridgeOpen, false);
  assert.match(r.out, /bridge: CLOSED \(route disabled\)\. It opens only through `zetaphy bridge open`/);
  const control = new Contract(o.neuroControl, art('zetaphy-network', 'NeuroControl').abi, provider);
  assert.equal(await control.activeSkill(), o.skillId);
  assert.equal(await control.governance(), deployer.address, 'the deployer keeps governance without --handover');
});

test('a second run: refused without --resume; --resume deploys nothing new', { timeout: 300_000 }, async () => {
  const before = state();
  const refused = await launch(['--neuro-url', NEURO_URL]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /pass --resume/);
  const nonce = await provider.getTransactionCount(deployer.address);
  const r = await launch(['--resume', '--neuro-url', NEURO_URL, '--wallet-origin', WALLET_ORIGIN, '--bridge-lockbox', LOCKBOX]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ neuro: done/);
  assert.match(r.out, /✓ dex: done/);
  assert.equal(await provider.getTransactionCount(deployer.address), nonce, 'no transaction: everything was done and in place');
  const after = state();
  for (const k of ['neuro', 'threats', 'dex', 'nft', 'compute']) assert.deepEqual(after.steps[k], before.steps[k], k);
});

test('smoke: the DEX router quotes, the NFT factory makes a collection, NeuroJobs takes a request under the voted skill', { timeout: 120_000 }, async () => {
  const o = outs();
  const dex = JSON.parse(read('zetaphy-dex/web/deployments.json'));
  const router = new Contract(dex.contracts.router, art('zetaphy-dex', 'ZetaphyRouter').abi, provider);
  const tusd = dex.tokens.find((t) => t.symbol === 'tUSD').address;
  const amounts = await router.getAmountsOut(parseEther('1'), [dex.contracts.wnative, tusd]);
  assert.ok(amounts[1] > parseEther('900') && amounts[1] < parseEther('1000'), `1 ZTPHY quotes ${amounts[1]} tUSD`);

  // The node can answer the pending nonce late right after a receipt: count nonces here.
  const signer = new NonceManager(user.connect(provider));
  const nft = JSON.parse(read('zetaphy-nft/web/deployments.json'));
  const factory = new Contract(nft.factory, art('zetaphy-nft', 'NFTFactory').abi, signer);
  const rc = await (await factory.createERC721({ name: 'Launch Cats', symbol: 'LCAT', baseURI: '', contractURI: '', royaltyReceiver: ZeroAddress, royaltyBps: 0n,
    maxSupply: 0n, publicMint: false, mintPrice: 0n })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'CollectionCreated');
  await hasCode(ev.args.collection, 'new collection');
  assert.equal(await factory.isCollection(ev.args.collection), true);

  const jobs = new Contract(o.neuroJobs, art('zetaphy-network', 'NeuroJobs').abi, signer);
  const jr = await (await jobs.request(encodeBytes32String('bsc'), '0xc1ed4b78071e7c9a84958d8be0215a10984fc28f', { value: await jobs.minFee(), gasLimit: 1_500_000n })).wait();
  const id = jr.logs.map((l) => { try { return jobs.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'JobRequested').args.id;
  const [skill] = await jobs.jobInfo(id);
  assert.equal(skill, o.skillId, 'the job carries the approved skill');
});

test('--governance gov --handover: every admin role goes to the gov module; the DEX acceptance passes a vote', { timeout: 300_000 }, async () => {
  const r = await launch(['--resume', '--governance', 'gov', '--handover', '--neuro-url', NEURO_URL, '--wallet-origin', WALLET_ORIGIN, '--bridge-lockbox', LOCKBOX, '--skip-snap-build']);
  assert.equal(r.code, 0, r.out);
  const o = outs();
  const N = (n) => art('zetaphy-network', n).abi;
  const read1 = async (a, abi, fn) => (await new Contract(a, abi, provider)[fn]()).toLowerCase();
  const gov = GOV_MODULE.toLowerCase();
  assert.equal(await read1(o.neuroControl, N('NeuroControl'), 'governance'), gov);
  assert.equal(await read1(o.threatRegistry, N('ThreatRegistry'), 'governance'), gov);
  assert.equal(await read1(o.rewardVault, N('RewardVault'), 'governance'), gov);
  assert.equal(await read1(o.stableGateway, N('StableGateway'), 'owner'), gov);
  assert.equal(await read1(o.neuroIdentity, N('NeuroIdentity'), 'admin'), gov);
  assert.equal(await read1(o.bridgeGuard, N('BridgeGuard'), 'governance'), gov);
  assert.equal(await read1(o.bridgeAirlock, N('BridgeAirlock'), 'governance'), gov);
  assert.equal(await read1(o.nft.marketplace, art('zetaphy-nft', 'NFTMarketplace').abi, 'governance'), gov);
  const f = new Contract(o.dex.contracts.factory, art('zetaphy-dex', 'ZetaphyFactory').abi, provider);
  assert.equal((await f.pendingGovernance()).toLowerCase(), gov);
  assert.equal((await f.governance()).toLowerCase(), deployer.address.toLowerCase());

  // The proposal file the handover wrote, through a real vote (as the owner does on the node).
  const file = join(root, 'proposals', '77390-dex-accept-governance.json');
  assert.ok(existsSync(file), r.out);
  const node = ['--node', `tcp://127.0.0.1:${PORT + 100}`];
  const tx = ['--home', chainHome, '--keyring-backend', 'test', '--from', 'validator', '--chain-id', 'zetaphy-local-1', ...node,
    '--gas', 'auto', '--gas-adjustment', '1.5', '--gas-prices', '1000000000azetaphy', '-y', '-o', 'json'];
  zd(['tx', 'gov', 'submit-proposal', file, ...tx]);
  let id;
  for (let i = 0; i < 20 && !id; i++) {
    await sleep(1000);
    const ps = JSON.parse(zd(['q', 'gov', 'proposals', ...node, '-o', 'json'])).proposals ?? [];
    id = ps.find((p) => p.title === 'DEX: accept governance')?.id;
  }
  assert.ok(id, 'proposal submitted');
  await sleep(2000);
  zd(['tx', 'gov', 'vote', String(id), 'yes', ...tx]);
  let st;
  for (let i = 0; i < 60; i++) {
    st = JSON.parse(zd(['q', 'gov', 'proposal', String(id), ...node, '-o', 'json'])).proposal;
    if (!/VOTING_PERIOD|DEPOSIT_PERIOD/.test(st.status)) break;
    await sleep(1000);
  }
  assert.equal(st.status, 'PROPOSAL_STATUS_PASSED', `${st.status} ${st.failed_reason ?? ''}`);
  assert.equal((await f.governance()).toLowerCase(), gov, 'the gov module governs the DEX factory');

  // A re-run is a no-op: everything is already handed over.
  const again = await launch(['--resume', '--governance', 'gov', '--handover', '--only', 'handover']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already 0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2/i);
});
