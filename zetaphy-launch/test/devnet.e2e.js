// End to end on a real ZETAPHY devnet (zetaphy-network/scripts/devnet.sh, 1 s blocks):
//   - launch.js --dry-run sends nothing and writes nothing
//   - a full launch deploys every contract and writes every web app config with real addresses (code checked),
//     the DLMM factory + router included (default presets, router checking the ThreatRegistry)
//   - --resume deploys nothing new; without it a second run is refused
//   - smoke: the DEX router quotes, the NFT factory makes a collection, NeuroJobs takes a request under the voted skill
//   - the oracle step: ZetaphyOracle + TwapRecorder + ZetaphyPythRelay, the StableGateway priced by it
//   - --governance gov --guardian <key> --handover --devnet --timelock-delay 30: every admin role goes to the
//     ZetaphyTimelock (the DEX and DLMM factories' two-step included), the gov module is its only proposer/canceller,
//     anyone executes, the deployer keeps nothing; the guardian pauses Neuro at once but cannot unpause; a real
//     gov vote schedules NeuroControl.unpause() through the timelock (zetaphy timelock schedule --proposal-out),
//     anyone executes it after the delay (zetaphy timelock execute, the call given in full: a MsgEVMCall's logs
//     are not in eth_getLogs), and the bridge monitor reports both (the vote from the REST API, the run from logs)
//   - the handover's bootstrap audit: an operation the deployer key schedules with a Cosmos tx (MsgEVMCall, no log)
//     while the timelock is at zero delay makes the handover refuse that timelock (nothing handed over); one it
//     schedules with an EVM tx is cancelled before the deployer renounces
// The config files it writes are restored afterwards (the committed ones stay placeholders).
//
//   ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:devnet

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, JsonRpcProvider, Contract, NonceManager, encodeBytes32String, parseEther, ZeroAddress, ZeroHash, id as hashText, keccak256 } from 'ethers';
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
const guardian = Wallet.createRandom();
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
/** zetaphy-network/cli.js as `user` (a plain key: no role anywhere). */
function zcli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, 'zetaphy-network/cli.js'), ...args, '--rpc', RPC], { env: { ...env, ZETAPHY_HOME: join(root, 'user-home') }, timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}
const outs = () => Object.assign({}, ...Object.values(state().steps).map((s) => s.out ?? {}));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
async function hasCode(a, what) {
  assert.match(String(a), /^0x[0-9a-fA-F]{40}$/, `${what}: ${a}`);
  assert.notEqual(await provider.getCode(a), '0x', `${what} ${a} has no code`);
}

// A Cosmos tx signed by an eth_secp256k1 key (SIGN_MODE_DIRECT), protobuf written by hand: the launch never sends one,
// so the handover's audit must notice it. Broadcast through CometBFT (+100).
const pbVarint = (n) => { let v = BigInt(n); const out = []; while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; } out.push(Number(v)); return Buffer.from(out); };
const pbBytes = (no, b) => Buffer.concat([pbVarint((no << 3) | 2), pbVarint(Buffer.from(b).length), Buffer.from(b)]);
const pbStr = (no, str) => pbBytes(no, Buffer.from(String(str), 'utf8'));
const pbU64 = (no, n) => (BigInt(n) === 0n ? Buffer.alloc(0) : Buffer.concat([pbVarint(no << 3), pbVarint(n)]));
const pbAny = (typeUrl, value) => Buffer.concat([pbStr(1, typeUrl), pbBytes(2, value)]);
function toBech32(hex) {
  const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = []; let acc = 0, bits = 0;
  for (const b of Buffer.from(hex.slice(2), 'hex')) { acc = ((acc << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); } }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const polymod = (v) => { let c = 1; for (const x of v) { const t = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >> i) & 1) c ^= [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3][i]; } return c; };
  const hrp = 'zetaphy';
  const pm = polymod([...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  return `${hrp}1${[...data, ...Array.from({ length: 6 }, (_, i) => (pm >> (5 * (5 - i))) & 31)].map((d) => CH[d]).join('')}`;
}
const encodeEVMCall = ({ sender, to, data, gasLimit }) => pbAny('/zetaphy.pq.v1.MsgEVMCall',
  Buffer.concat([pbStr(1, sender), pbStr(2, to), pbStr(3, '0'), pbBytes(4, Buffer.from(data.slice(2), 'hex')), pbU64(5, gasLimit)]));
async function cosmosTx(wallet, msgAny) {
  const acct = zd(['q', 'auth', 'account', toBech32(wallet.address), '--node', `tcp://127.0.0.1:${PORT + 100}`, '-o', 'json']);
  const accountNumber = /"account_number":\s*"?(\d+)/.exec(acct)?.[1] ?? '0';
  const sequence = await provider.getTransactionCount(wallet.address);
  const body = pbBytes(1, msgAny);
  const pub = pbAny('/cosmos.evm.crypto.v1.ethsecp256k1.PubKey', pbBytes(1, Buffer.from(wallet.signingKey.compressedPublicKey.slice(2), 'hex')));
  const signerInfo = Buffer.concat([pbBytes(1, pub), pbBytes(2, pbBytes(1, pbU64(1, 1))), pbU64(3, sequence)]);
  const fee = Buffer.concat([pbBytes(1, Buffer.concat([pbStr(1, 'azetaphy'), pbStr(2, '1000000000000000')])), pbU64(2, 600000)]);
  const authInfo = Buffer.concat([pbBytes(1, signerInfo), pbBytes(2, fee)]);
  const signDoc = Buffer.concat([pbBytes(1, body), pbBytes(2, authInfo), pbStr(3, 'zetaphy-local-1'), pbU64(4, accountNumber)]);
  const sig = wallet.signingKey.sign(keccak256(signDoc));
  const raw = Buffer.concat([pbBytes(1, body), pbBytes(2, authInfo), pbBytes(3, Buffer.from(sig.r.slice(2) + sig.s.slice(2), 'hex'))]);
  const res = await fetch(`http://127.0.0.1:${PORT + 100}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'broadcast_tx_sync', params: { tx: raw.toString('base64') } }) });
  const j = await res.json();
  return { code: j.result?.code ?? -1, log: j.result?.log ?? JSON.stringify(j.error ?? j) };
}

before(() => {
  for (const rel of TOUCHED) saved.set(rel, existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel)) : null);
  writeFileSync(keyFile, deployer.privateKey + '\n', { mode: 0o600 });
  // REST=1: the Cosmos REST API (+103), where the monitor reads gov proposals that schedule in the timelock
  execFileSync(join(ROOT, 'zetaphy-network/scripts/devnet.sh'), [chainHome, String(PORT), deployer.address, user.address, guardian.address], { stdio: 'inherit', env: { ...env, REST: '1' }, cwd: root });
  mkdirSync(join(root, 'user-home'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'user-home', 'worker.key'), user.privateKey + '\n', { mode: 0o600 });
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
  assert.match(r.out, /oracle: would run/);
  assert.match(r.out, /dlmm: would run/);
  assert.match(r.out, /timelock: skipped/);
  assert.match(r.out, /handover: skipped/);
  assert.equal(existsSync(stateFile), false);
  assert.equal(await provider.getTransactionCount(deployer.address), nonce);
  for (const [rel, buf] of saved) assert.equal(read(rel), buf.toString(), `${rel} untouched`);
});

test('launch: every contract deployed and every config written with real addresses', { timeout: 900_000 }, async () => {
  const r = await launch(['--neuro-url', NEURO_URL, '--wallet-origin', WALLET_ORIGIN, '--bridge-lockbox', LOCKBOX, '--oracle-relayer', user.address]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes(deployer.privateKey.slice(2)), 'the key is never printed');
  assert.ok(!readFileSync(stateFile, 'utf8').includes(deployer.privateKey.slice(2)), 'the state holds no key');
  const o = outs();
  for (const k of ['neuroJobs', 'neuroControl', 'threatRegistry', 'threatReports', 'neuroIdentity', 'neuroValidation', 'rewardVault', 'quantumWalletFactory',
    'tUSDC', 'tUSDT', 'stableGateway', 'computeMarket', 'bridgeGuard', 'bridgeAirlock', 'neuroLane', 'oracle', 'twapRecorder', 'pythRelay', 'zetaPair']) await hasCode(o[k], k);
  // the oracle: ZETAPHY/USD from the DEX pool, the gateway priced by it, the relayer named
  const oracle = new Contract(o.oracle, art('zetaphy-network', 'ZetaphyOracle').abi, provider);
  assert.equal((await oracle.twapOf(o.zetaAsset)).pair, o.zetaPair);
  assert.equal((await oracle.guardsOf(o.zetaAsset)).maxDeviationBps, 200n);
  const gw = new Contract(o.stableGateway, art('zetaphy-network', 'StableGateway').abi, provider);
  assert.equal(await gw.oracle(), o.oracle);
  assert.equal(await gw.zetaAsset(), o.zetaAsset);
  assert.equal(await gw.priceSource(), 'ZetaphyOracle');
  assert.equal(await new Contract(o.pythRelay, art('zetaphy-network', 'ZetaphyPythRelay').abi, provider).isRelayer(user.address), true);
  await assert.rejects(oracle.price(o.zetaAsset), (e) => e.revert?.name === 'TwapUnavailable', 'no price before the TWAP window has filled');
  assert.match(r.out, /Governance: the deployer is the admin/);
  assert.match(r.out, /zetaphy timelock schedule/);

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
  // the DLMM: factory + router in the same web config, the default presets, the registry wired, the deployer governance for now
  for (const k of ['dlmmFactory', 'dlmmRouter']) { await hasCode(dex.contracts[k], `dex ${k}`); assert.equal(dex.contracts[k], o.dlmm.contracts[k]); }
  const dlmmF = new Contract(dex.contracts.dlmmFactory, art('zetaphy-dex', 'ZetaphyDlmmFactory').abi, provider);
  assert.deepEqual((await dlmmF.presetSteps()).map(Number).sort((a, b) => a - b), [1, 10, 25, 100]);
  assert.deepEqual(o.dlmm.presets, [1, 10, 25, 100]);
  assert.equal(await dlmmF.threatRegistry(), o.threatRegistry);
  assert.equal(await dlmmF.governance(), deployer.address);
  assert.equal(await dlmmF.PAIR_CODE_HASH(), dex.contracts.dlmmPairCodeHash);
  const dlmmR = new Contract(dex.contracts.dlmmRouter, art('zetaphy-dex', 'ZetaphyDlmmRouter').abi, provider);
  assert.equal(await dlmmR.factory(), dex.contracts.dlmmFactory);
  assert.equal(o.dlmm.wnative, dex.contracts.wnative, 'the same wrapped native as the V2 DEX');
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
  for (const k of ['neuro', 'threats', 'dex', 'dlmm', 'nft', 'compute', 'oracle']) assert.deepEqual(after.steps[k], before.steps[k], k);
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

test('--handover: every admin role to the timelock; the guardian pauses at once; a gov vote schedules, anyone executes after the delay', { timeout: 600_000 }, async () => {
  const handoverArgs = ['--resume', '--governance', 'gov', '--guardian', guardian.address, '--handover', '--devnet', '--timelock-delay', '30',
    '--neuro-url', NEURO_URL, '--wallet-origin', WALLET_ORIGIN, '--bridge-lockbox', LOCKBOX, '--skip-snap-build'];
  // refused without a guardian, and with a short delay outside --devnet
  const noGuard = await launch(['--resume', '--governance', 'gov', '--handover', '--devnet', '--timelock-delay', '30']);
  assert.match(noGuard.out, /--handover needs --guardian/);
  const short = await launch(['--resume', '--governance', 'gov', '--guardian', guardian.address, '--handover', '--timelock-delay', '30']);
  assert.match(short.out, /less than 86400 s \(24 h\) only with --devnet/);
  const N0 = (n) => art('zetaphy-network', n).abi;
  const P0 = hashText('PROPOSER_ROLE');
  const grantData = (tlAddr) => new Contract(tlAddr, N0('ZetaphyTimelock')).interface.encodeFunctionData('grantRole', [P0, user.address]);

  // The timelock alone (zero delay, the deployer its proposer). With the deployer key, someone schedules an operation
  // through a Cosmos tx (MsgEVMCall): no log eth_getLogs returns. The handover refuses this timelock.
  const t1 = await launch([...handoverArgs, '--only', 'timelock']);
  assert.equal(t1.code, 0, t1.out);
  const tlA = outs().timelock;
  const tlAc = new Contract(tlA, N0('ZetaphyTimelock'), provider);
  const salt = hashText('planted');
  const plantedA = await tlAc.hashOperation(tlA, 0, grantData(tlA), ZeroHash, salt);
  const sched = tlAc.interface.encodeFunctionData('schedule', [tlA, 0, grantData(tlA), ZeroHash, salt, 0]);
  const br = await cosmosTx(deployer, encodeEVMCall({ sender: toBech32(deployer.address), to: tlA, data: sched, gasLimit: 400000 }));
  assert.equal(br.code, 0, JSON.stringify(br));
  for (let i = 0; i < 20 && (await tlAc.getOperationState(plantedA)) !== 2n; i++) await sleep(500);
  assert.equal(await tlAc.getOperationState(plantedA), 2n, 'planted through MsgEVMCall: Ready at once');
  const refused = await launch([...handoverArgs, '--only', 'handover']);
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out, /signed 1 transaction\(s\) that are not EVM transactions .*MsgEVMCall/);
  assert.equal((await new Contract(outs().neuroControl, N0('NeuroControl'), provider).governance()), deployer.address, 'nothing handed over');

  // A new timelock; this time the planted operation is an EVM tx (a CallScheduled log): cancelled by the handover.
  const t2 = await launch([...handoverArgs, '--only', 'timelock', '--redo']);
  assert.equal(t2.code, 0, t2.out);
  const tlB = outs().timelock;
  assert.notEqual(tlB, tlA);
  const tlBw = new Contract(tlB, N0('ZetaphyTimelock'), new NonceManager(deployer.connect(provider)));
  await (await tlBw.schedule(tlB, 0, grantData(tlB), ZeroHash, salt, 0)).wait();
  const plantedB = await tlBw.hashOperation(tlB, 0, grantData(tlB), ZeroHash, salt);
  assert.equal(await tlBw.getOperationState(plantedB), 2n);
  const r = await launch(handoverArgs);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /checked on-chain: \d+ admin role\(s\) belong to the timelock/);
  assert.match(r.out, new RegExp(`WARNING: operation ${plantedB} was scheduled on the timelock by someone with the deployer key, not by the launch: cancelled`));
  assert.match(r.out, /no operation from the bootstrap is left but the handover's/);
  assert.equal(await tlBw.getOperationState(plantedB), 0n, 'cancelled');
  const o = outs();
  assert.equal(o.timelock, tlB);
  assert.deepEqual(o.cancelledOperations, [plantedB]);
  assert.match(o.handoverOperation, /^0x[0-9a-f]{64}$/);
  assert.equal(await tlBw.getOperationState(o.handoverOperation), 3n, 'the handover batch: Done');
  await hasCode(o.timelock, 'timelock');
  const T = o.timelock.toLowerCase();
  const N = (n) => art('zetaphy-network', n).abi;
  const read1 = async (a, abi, fn) => (await new Contract(a, abi, provider)[fn]()).toLowerCase();
  for (const [a, abi, fn] of [[o.neuroControl, N('NeuroControl'), 'governance'], [o.threatRegistry, N('ThreatRegistry'), 'governance'], [o.rewardVault, N('RewardVault'), 'governance'],
    [o.stableGateway, N('StableGateway'), 'owner'], [o.neuroIdentity, N('NeuroIdentity'), 'admin'], [o.bridgeGuard, N('BridgeGuard'), 'governance'],
    [o.bridgeAirlock, N('BridgeAirlock'), 'governance'], [o.oracle, N('ZetaphyOracle'), 'governance'], [o.pythRelay, N('ZetaphyPythRelay'), 'governance'],
    [o.nft.marketplace, art('zetaphy-nft', 'NFTMarketplace').abi, 'governance'], [o.dex.contracts.factory, art('zetaphy-dex', 'ZetaphyFactory').abi, 'governance'],
    [o.dlmm.contracts.dlmmFactory, art('zetaphy-dex', 'ZetaphyDlmmFactory').abi, 'governance']]) {
    assert.equal(await read1(a, abi, fn), T, `${a} ${fn}`);
  }
  // the two-step factories: accepted by the timelock, nobody left pending; the deployer can no longer change the DLMM
  for (const [a, n] of [[o.dex.contracts.factory, 'ZetaphyFactory'], [o.dlmm.contracts.dlmmFactory, 'ZetaphyDlmmFactory']]) {
    assert.equal(await read1(a, art('zetaphy-dex', n).abi, 'pendingGovernance'), ZeroAddress.toLowerCase(), `${n} pendingGovernance`);
  }
  const dlmmAsDeployer = new Contract(o.dlmm.contracts.dlmmFactory, art('zetaphy-dex', 'ZetaphyDlmmFactory').abi, deployer.connect(provider));
  await assert.rejects(dlmmAsDeployer.setFeeTo.staticCall(deployer.address), (e) => e.revert?.name === 'NotGovernance');
  assert.match(r.out, /DLMM factory .*accepted by the timelock/);
  // the timelock: the gov module proposes and cancels, anyone executes, it is its own admin, 30 s; the deployer holds nothing
  const tl = new Contract(o.timelock, N('ZetaphyTimelock'), provider);
  const P = hashText('PROPOSER_ROLE'), C = hashText('CANCELLER_ROLE'), E = hashText('EXECUTOR_ROLE');
  assert.equal(await tl.getMinDelay(), 30n);
  assert.deepEqual([await tl.getRoleMemberCount(P), await tl.getRoleMember(P, 0)], [1n, GOV_MODULE]);
  assert.deepEqual([await tl.getRoleMemberCount(C), await tl.getRoleMember(C, 0)], [1n, GOV_MODULE]);
  assert.deepEqual([await tl.getRoleMemberCount(E), await tl.getRoleMember(E, 0)], [1n, ZeroAddress]);
  assert.equal((await tl.getRoleMember(ZeroHash, 0)).toLowerCase(), T);
  for (const role of [P, C, E, ZeroHash]) assert.equal(await tl.hasRole(role, deployer.address), false);
  const control = new Contract(o.neuroControl, N('NeuroControl'), new NonceManager(guardian.connect(provider)));
  assert.equal(await control.guardian(guardian.address), true);
  assert.equal(await control.guardian(deployer.address), false);

  // the guardian pauses Neuro at once; it cannot unpause (only the timelock can)
  await (await control.pause()).wait();
  assert.equal(await control.paused(), true);
  await assert.rejects(control.unpause.staticCall(), (e) => e.revert?.name === 'NotGovernance');

  // a gov vote schedules NeuroControl.unpause() through the timelock; anyone executes it after 30 s
  const file = join(root, 'unpause.json');
  const s1 = await zcli(['timelock', 'schedule', '--timelock', o.timelock, '--to', o.neuroControl, '--sig', 'unpause()', '--proposal-out', file]);
  assert.equal(s1.code, 0, s1.out);
  assert.match(s1.out, /this key cannot/);
  const id = /operation (0x[0-9a-f]{64})/.exec(s1.out)[1];
  const node = ['--node', `tcp://127.0.0.1:${PORT + 100}`];
  const tx = ['--home', chainHome, '--keyring-backend', 'test', '--from', 'validator', '--chain-id', 'zetaphy-local-1', ...node,
    '--gas', 'auto', '--gas-adjustment', '1.5', '--gas-prices', '1000000000azetaphy', '-y', '-o', 'json'];
  zd(['tx', 'gov', 'submit-proposal', file, ...tx]);
  let pid;
  for (let i = 0; i < 20 && !pid; i++) {
    await sleep(1000);
    const ps = JSON.parse(zd(['q', 'gov', 'proposals', ...node, '-o', 'json'])).proposals ?? [];
    pid = ps.find((p) => /^Timelock: unpause/.test(p.title))?.id;
  }
  assert.ok(pid, 'proposal submitted');
  await sleep(2000);
  zd(['tx', 'gov', 'vote', String(pid), 'yes', ...tx]);
  let st;
  for (let i = 0; i < 60; i++) {
    st = JSON.parse(zd(['q', 'gov', 'proposal', String(pid), ...node, '-o', 'json'])).proposal;
    if (!/VOTING_PERIOD|DEPOSIT_PERIOD/.test(st.status)) break;
    await sleep(1000);
  }
  assert.equal(st.status, 'PROPOSAL_STATUS_PASSED', `${st.status} ${st.failed_reason ?? ''}`);
  assert.equal(await tl.getOperationState(id), 1n, 'Waiting');
  // a call the gov module scheduled leaves no log eth_getLogs returns: it is executed with the call given in full
  const call = ['--to', o.neuroControl, '--sig', 'unpause()'];
  assert.match(s1.out, new RegExp(`zetaphy timelock execute ${id} --timelock ${o.timelock} --to ${o.neuroControl} --data 0x3f4ba83a`));
  const early = await zcli(['timelock', 'execute', id, '--timelock', o.timelock, ...call]);
  assert.notEqual(early.code, 0);
  assert.match(early.out, /is Waiting until/);
  const status = await zcli(['timelock', 'status', id, '--timelock', o.timelock, '--from-block', String(o.timelockBlock)]);
  assert.match(status.out, /Waiting ETA/);
  for (let i = 0; i < 40 && (await tl.getOperationState(id)) !== 2n; i++) await sleep(1000);
  const ex = await zcli(['timelock', 'execute', id, '--timelock', o.timelock, ...call]);
  assert.equal(ex.code, 0, ex.out);
  assert.equal(await control.paused(), false, 'unpaused by the timelock, run by a plain key');

  // the bridge monitor saw the schedule (with the function's name and when it could run) and the run
  const rep = join(root, 'monitor.json');
  const m = await zcli(['bridge', 'monitor', '--launch-state', stateFile, '--from-block', String(o.timelockBlock), '--out', rep, '--rest', `http://127.0.0.1:${PORT + 103}`, '--comet-rpc', `http://127.0.0.1:${PORT + 100}`]);
  assert.equal(m.code, 0, m.out);
  const alerts = JSON.parse(readFileSync(rep, 'utf8')).alerts;
  assert.ok(alerts.some((a) => a.rule === 'timelock-proposal' && new RegExp(`gov proposal ${pid} .*schedule neuroControl ${o.neuroControl} unpause\\(\\) \\(delay 30 s\\)`).test(a.en)), JSON.stringify(alerts.map((a) => a.en)));
  assert.ok(alerts.some((a) => a.rule === 'timelock-executed' && /unpause\(\)/.test(a.en)));
  assert.ok(alerts.some((a) => a.rule === 'timelock-delay'), 'the handover set the delay (MinDelayChange 0 -> 30)');

  // A re-run is a no-op: everything is already handed over.
  const again = await launch([...handoverArgs, '--only', 'handover']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, new RegExp(`already ${o.timelock}`, 'i'));
});
