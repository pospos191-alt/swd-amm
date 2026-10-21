// The timelock and the price oracle on a real ZETAPHY devnet (scripts/devnet.sh, 1 s blocks):
//   - a DEX pool (the real ZetaphyFactory / ZetaphyPair) of a wrapped-ZETAPHY stand-in and a 6-decimal tUSD;
//   - `zetaphy deploy-oracle` (TwapRecorder, ZetaphyPythRelay with a relayer, ZetaphyOracle) and `oracle feed`;
//     the relayer pushes Pyth-format prices (`oracle push`), anyone pokes; price() = $2 once the window filled;
//   - the StableGateway priced by it (`deploy-stable --oracle`): a user with no ZETAPHY pays 2 tUSDC for a
//     1 ZETAPHY job fee through a relay that also keeps the oracle poked (`relay start --poke-oracle`);
//   - a ZetaphyTimelock (`deploy-timelock`, a 2-of-3 SimpleMultisig as proposer, 20 s on --devnet) takes the oracle:
//     the old admin is refused; `timelock schedule` by a multisig owner prints the calldata, the multisig sends it;
//     `timelock execute` refuses early and runs after the delay (anyone); `timelock cancel` through the multisig;
//   - emergencies stay immediate: the guardian pauses the feed (FeedIsPaused), cannot unpause;
//   - manipulation: a big swap left in the pool for a block gives no price (TwapSpike / SourcesDeviate), and a Pyth
//     price 10% off the TWAP gives SourcesDeviate; `bridge monitor` reports the schedule, the run, the cancel,
//     the pause and the oracle trips.
//
//   ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:devnet:timelock

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, ContractFactory, NonceManager, encodeBytes32String, parseEther } from 'ethers';
import { encodePriceFeed } from '../src/oracle.js';

const PORT = 23545; // a devnet also uses its port +1 and +100..+103
const RPC = `http://127.0.0.1:${PORT}`;
const RELAY_PORT = PORT + 7;
const root = mkdtempSync(join(tmpdir(), 'zetaphy-timelock-'));
const names = ['deployer', 'a', 'b', 'c', 'relayer', 'guardian', 'keeper', 'user'];
const W = Object.fromEntries(names.map((n) => [n, Wallet.createRandom()]));
const poor = Wallet.createRandom(); // no ZETAPHY at all
const FEED = encodeBytes32String('ZETAPHY/USD');
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const dexArt = (n) => JSON.parse(readFileSync(new URL(`../../zetaphy-dex/artifacts/${n}.json`, import.meta.url), 'utf8'));
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let provider;

function cli(actor, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args, '--rpc', RPC], {
      env: { ...env, ZETAPHY_HOME: join(root, actor) }, timeout: 120_000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}
const signerOf = (n) => new NonceManager(W[n].connect(provider));
const ok = async (txp) => { const r = await (await txp).wait(); assert.equal(r.status, 1); return r; };

before(() => {
  for (const [n, w] of Object.entries({ ...W, poor })) {
    mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, n, 'worker.key'), w.privateKey + '\n', { mode: 0o600 });
  }
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname, [join(root, 'chain'), String(PORT), ...Object.values(W).map((w) => w.address)], { stdio: 'inherit', env });
  provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, pollingInterval: 500 });
});
after(() => { provider?.destroy(); try { process.kill(Number(readFileSync(join(root, 'chain', 'node.pid'), 'utf8'))); } catch {} });

const ctx = {};

test('the oracle on a real chain: TWAP of the DEX pool + Pyth through the relay, $2.00 once the window filled', { timeout: 600_000 }, async () => {
  // the DEX pool: 1,000 WZ (18 decimals) against 2,000 tUSD (6 decimals): $2
  const d = signerOf('deployer');
  const deploy = async (a, args) => { const k = await new ContractFactory(a.abi, a.bytecode, d).deploy(...args); await k.waitForDeployment(); return k; };
  const factory = await deploy(dexArt('ZetaphyFactory'), [W.deployer.address]);
  const wz = await deploy(dexArt('TestToken'), ['Wrapped ZETAPHY (test)', 'WZ', 18, parseEther('1000000'), 0]);
  const tusd = await deploy(dexArt('TestToken'), ['Test USD', 'tUSD', 6, 10n ** 15n, 0]);
  await ok(factory.createPair(wz.target, tusd.target));
  const pairAddr = await factory.getPair(wz.target, tusd.target);
  const pair = new Contract(pairAddr, dexArt('ZetaphyPair').abi, d);
  await ok(wz.transfer(pairAddr, parseEther('1000')));
  await ok(tusd.transfer(pairAddr, 2000n * 10n ** 6n));
  await ok(pair.mint(W.deployer.address));
  Object.assign(ctx, { factory, wz, tusd, pair, pairAddr });

  const dep = await cli('deployer', ['deploy-oracle', '--relayers', W.relayer.address, '--min-spacing', '5', '--guardian', W.guardian.address]);
  assert.equal(dep.code, 0, dep.out);
  ctx.oracle = /ZetaphyOracle (0x[0-9a-fA-F]{40})/.exec(dep.out)[1];
  ctx.relay = /ZetaphyPythRelay (0x[0-9a-fA-F]{40})/.exec(dep.out)[1];
  const feed = await cli('deployer', ['oracle', 'feed', wz.target, '--oracle', ctx.oracle, '--pair', pairAddr, '--window', '60', '--min-observations', '4',
    '--min-liquidity', '100', '--pyth-id', FEED, '--max-age', '60', '--max-conf', '100', '--max-deviation', '200']);
  assert.equal(feed.code, 0, feed.out);
  assert.match(feed.out, /guards of .* \(done\)/);
  const oracle = new Contract(ctx.oracle, art('ZetaphyOracle').abi, provider);
  ctx.oracleC = oracle;
  await assert.rejects(oracle.price(wz.target), (e) => e.revert?.name === 'TwapUnavailable');

  // the relayer pushes Pyth-format updates (the CLI once, then directly), a keeper pokes; ~75 s of history
  const push = await cli('relayer', ['oracle', 'push', '--relay', ctx.relay, '--feed', FEED, '--price', '200000000', '--conf', '100000', '--expo', '-8']);
  assert.equal(push.code, 0, push.out);
  assert.equal((await cli('keeper', ['oracle', 'poke', wz.target, '--oracle', ctx.oracle])).code, 0);
  const relay = new Contract(ctx.relay, art('ZetaphyPythRelay').abi, signerOf('relayer'));
  const keeper = new Contract(ctx.oracle, art('ZetaphyOracle').abi, signerOf('keeper'));
  ctx.keep = async (seconds, price = 200000000n) => {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const t = (await provider.getBlock('latest')).timestamp;
      await ok(relay.updatePriceFeeds([encodePriceFeed({ id: FEED, price, conf: 100000n, expo: -8, publishTime: t })]));
      await ok(keeper.poke(wz.target, { gasLimit: 800_000n })); // a fixed limit: the estimate may come from a block where no observation is due
      await sleep(5000);
    }
  };
  await ctx.keep(75);
  const [v] = await oracle.price(wz.target);
  assert.equal(v, 2n * 10n ** 18n, 'Pyth\'s $2.00, within 2% of the TWAP');
  const st = await cli('keeper', ['oracle', 'status', wz.target, '--oracle', ctx.oracle]);
  assert.match(st.out, /price\(\): \$2\b/);
});

test('the StableGateway priced by the oracle: 1 ZETAPHY of job fee costs 2 tUSDC, paid by a user with no ZETAPHY', { timeout: 300_000 }, async () => {
  const dj = await cli('deployer', ['deploy', '--fund', '100', '--window', '8', '--timeout', '60', '--unbond', '120']);
  assert.match(dj.out, /deployed at 0x/, dj.out);
  const jobsAddr = /deployed at (0x[0-9a-fA-F]{40})/.exec(dj.out)[1];
  const d = await cli('deployer', ['deploy-stable', '--jobs', jobsAddr, '--reserve', '50', '--oracle', ctx.oracle, '--zeta-asset', ctx.wz.target]);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /price: ZetaphyOracle/);
  const gateway = /StableGateway (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  const usdc = /tUSDC (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  const usdt = /tUSDT (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  const gw = new Contract(gateway, art('StableGateway').abi, provider);
  assert.equal(await gw.quote(usdc, parseEther('1')), 2n * 10n ** 6n);
  const relay = spawn(process.execPath, [new URL('../cli.js', import.meta.url).pathname, 'relay', 'start', '--rpc', RPC, '--gateway', gateway, '--usdc', usdc, '--usdt', usdt,
    '--port', String(RELAY_PORT), '--host', '127.0.0.1', '--poke-oracle', '5'], { env: { ...env, ZETAPHY_HOME: join(root, 'user') } });
  try {
    let out = '';
    await new Promise((resolve, reject) => {
      relay.stdout.on('data', (b) => { out += b; if (/relay for/.test(out)) resolve(); });
      relay.on('exit', (code) => reject(new Error(`relay exited ${code}: ${out}`)));
    });
    assert.match(out, /price: ZetaphyOracle; pokes the oracle every 5 s/);
    const URL_ = `http://127.0.0.1:${RELAY_PORT}`;
    assert.equal((await (await fetch(`${URL_}/info`)).json()).priceSource, 'ZetaphyOracle');
    // keep Pyth fresh while the user asks (the relay pokes, the relayer pushes)
    const keeping = ctx.keep(20);
    assert.equal((await cli('poor', ['faucet', 'usdc', '--relay', URL_])).code, 0);
    const r = await cli('poor', ['job', 'request-stable', 'zetaphy', jobsAddr, '--relay', URL_, '--fee', '1', '--tip', '0.01', '--jobs', jobsAddr]);
    await keeping;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /paid 2\.01 USDC/);
    assert.equal(await provider.getBalance(poor.address), 0n, 'the user never needed ZETAPHY');
  } finally { relay.kill(); }
});

test('the timelock: the multisig schedules, anyone executes after the delay, cancels go through; the guardian pauses at once', { timeout: 600_000 }, async () => {
  const ms = await cli('deployer', ['deploy-multisig', '--owners', [W.a, W.b, W.c].map((w) => w.address).join(','), '--threshold', '2']);
  assert.equal(ms.code, 0, ms.out);
  const multisig = /SimpleMultisig (0x[0-9a-fA-F]{40})/.exec(ms.out)[1];
  const refused = await cli('deployer', ['deploy-timelock', '--proposer', multisig, '--delay', '20']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /less than 86400 s \(24 h\) only on a devnet/);
  const dt = await cli('deployer', ['deploy-timelock', '--proposer', multisig, '--delay', '20', '--devnet']);
  assert.equal(dt.code, 0, dt.out);
  const T = /ZetaphyTimelock (0x[0-9a-fA-F]{40})/.exec(dt.out)[1];
  ctx.timelock = T;
  ctx.timelockBlock = (await provider.getBlockNumber()) - 5;
  const tl = new Contract(T, art('ZetaphyTimelock').abi, provider);
  assert.equal(await tl.getMinDelay(), 20n);
  // the oracle goes to the timelock
  const asDeployer = new Contract(ctx.oracle, art('ZetaphyOracle').abi, signerOf('deployer'));
  await ok(asDeployer.setGovernance(T));
  await assert.rejects(asDeployer.setGuards.staticCall(ctx.wz.target, 300, 1500, 3000, 3600), (e) => e.revert?.name === 'NotGovernance');
  const hint = await cli('deployer', ['oracle', 'feed', ctx.wz.target, '--oracle', ctx.oracle, '--max-deviation', '300']);
  assert.match(hint.out, /governance is the ZetaphyTimelock .*zetaphy timelock schedule --timelock/s);

  // an owner of the multisig asks the CLI: not a proposer itself, it prints the calldata; the multisig sends it
  const s1 = await cli('a', ['timelock', 'schedule', '--timelock', T, '--to', ctx.oracle, '--sig', 'setGuards(address,uint16,uint16,uint16,uint32)',
    '--args', `${ctx.wz.target},300,1500,3000,3600`, '--salt', 'guards-1']);
  assert.equal(s1.code, 0, s1.out);
  const id = /operation (0x[0-9a-f]{64})/.exec(s1.out)[1];
  const data = /data {2}(0x[0-9a-f]+)/.exec(s1.out)[1];
  const msig = (n) => new Contract(multisig, art('SimpleMultisig').abi, signerOf(n));
  const viaMultisig = async (to, calldata) => {
    const rc = await ok(msig('a').propose(to, 0n, calldata));
    const pid = rc.logs.map((l) => { try { return msig('a').interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Proposed').args.id;
    await ok(msig('b').confirm(pid));
    await ok(msig('a').execute(pid));
  };
  await viaMultisig(T, data);
  assert.equal(await tl.getOperationState(id), 1n, 'Waiting');
  const early = await cli('user', ['timelock', 'execute', id, '--timelock', T, '--from-block', String(ctx.timelockBlock)]);
  assert.notEqual(early.code, 0);
  assert.match(early.out, /is Waiting until/);
  for (let i = 0; i < 40 && (await tl.getOperationState(id)) !== 2n; i++) await sleep(1000);
  const ex = await cli('user', ['timelock', 'execute', id, '--timelock', T, '--from-block', String(ctx.timelockBlock)]);
  assert.equal(ex.code, 0, ex.out);
  assert.match(ex.out, /setGuards\(address,uint16,uint16,uint16,uint32\)/);
  assert.equal((await ctx.oracleC.guardsOf(ctx.wz.target)).maxDeviationBps, 300n, 'ran after the delay, by a key with no role');

  // a cancel: scheduled, then cancelled by the multisig (a canceller); it can never run
  const s2 = await cli('a', ['timelock', 'schedule', '--timelock', T, '--to', ctx.oracle, '--sig', 'setGovernance(address)', '--args', W.user.address]);
  const id2 = /operation (0x[0-9a-f]{64})/.exec(s2.out)[1];
  await viaMultisig(T, /data {2}(0x[0-9a-f]+)/.exec(s2.out)[1]);
  const c2 = await cli('a', ['timelock', 'cancel', id2, '--timelock', T]);
  await viaMultisig(T, /data {2}(0x[0-9a-f]+)/.exec(c2.out)[1]);
  assert.equal(await tl.getOperationState(id2), 0n, 'Unset: cancelled');
  const status = await cli('user', ['timelock', 'status', '--timelock', T, '--from-block', String(ctx.timelockBlock)]);
  assert.match(status.out, /proposer +0x[0-9a-fA-F]{40} \(simple\)/);
  assert.match(status.out, /executor +anyone/);
  assert.match(status.out, /Done/);

  // the guardian pauses the feed at once; it cannot unpause (only the timelock)
  const g = await cli('guardian', ['oracle', 'pause', ctx.wz.target, '--oracle', ctx.oracle]);
  assert.equal(g.code, 0, g.out);
  await assert.rejects(ctx.oracleC.price(ctx.wz.target), (e) => e.revert?.name === 'FeedIsPaused');
  const asGuardian = new Contract(ctx.oracle, art('ZetaphyOracle').abi, signerOf('guardian'));
  await assert.rejects(asGuardian.unpauseFeed.staticCall(ctx.wz.target), (e) => e.revert?.name === 'NotGovernance');
  const un = await cli('a', ['timelock', 'schedule', '--timelock', T, '--to', ctx.oracle, '--sig', 'unpauseFeed(address)', '--args', ctx.wz.target]);
  const idU = /operation (0x[0-9a-f]{64})/.exec(un.out)[1];
  await viaMultisig(T, /data {2}(0x[0-9a-f]+)/.exec(un.out)[1]);
  for (let i = 0; i < 40 && (await tl.getOperationState(idU)) !== 2n; i++) await sleep(1000);
  assert.equal((await cli('user', ['timelock', 'execute', idU, '--timelock', T, '--from-block', String(ctx.timelockBlock)])).code, 0);
});

test('manipulation on a real chain: a pushed pool or a lying Pyth price gives no price; the monitor reports it all', { timeout: 300_000 }, async () => {
  await ctx.keep(70); // a fresh window after the pause
  const [v] = await ctx.oracleC.price(ctx.wz.target);
  assert.equal(v, 2n * 10n ** 18n);
  // Pyth 10% off the TWAP: SourcesDeviate (300 bps allowed now)
  const t = (await provider.getBlock('latest')).timestamp;
  const relay = new Contract(ctx.relay, art('ZetaphyPythRelay').abi, signerOf('relayer'));
  await ok(relay.updatePriceFeeds([encodePriceFeed({ id: FEED, price: 220000000n, conf: 100000n, expo: -8, publishTime: t + 1 })]));
  await assert.rejects(ctx.oracleC.price(ctx.wz.target), (e) => e.revert?.name === 'SourcesDeviate');
  await ok(new Contract(ctx.oracle, art('ZetaphyOracle').abi, signerOf('keeper')).poke(ctx.wz.target, { gasLimit: 800_000n })); // logs DeviationTripped
  // a big swap left in the pool: the next blocks have no price either
  const d = signerOf('deployer');
  await ok(ctx.tusd.connect(d).transfer(ctx.pairAddr, 20_000n * 10n ** 6n));
  const [r0, r1] = await ctx.pair.getReserves();
  const in0 = (await ctx.pair.token0()).toLowerCase() === ctx.tusd.target.toLowerCase();
  const [rin, rout] = in0 ? [r0, r1] : [r1, r0];
  const amountIn = 20_000n * 10n ** 6n;
  const out = (amountIn * 997n * rout) / (rin * 1000n + amountIn * 997n);
  await ok(ctx.pair.connect(d).swap(in0 ? 0n : out, in0 ? out : 0n, W.deployer.address, '0x'));
  await sleep(2000);
  await assert.rejects(ctx.oracleC.price(ctx.wz.target), (e) => ['TwapSpike', 'SourcesDeviate'].includes(e.revert?.name), 'never the pushed price');

  const rep = join(root, 'monitor.json');
  const m = await cli('user', ['bridge', 'monitor', '--timelock', ctx.timelock, '--oracle', ctx.oracle, '--from-block', String(ctx.timelockBlock), '--out', rep]);
  assert.equal(m.code, 0, m.out);
  const alerts = JSON.parse(readFileSync(rep, 'utf8')).alerts;
  const has = (rule, re) => assert.ok(alerts.some((a) => a.rule === rule && (!re || re.test(a.en))), `${rule} ${re ?? ''}: ${JSON.stringify(alerts.map((a) => `${a.rule}: ${a.en}`), null, 1)}`);
  has('timelock-scheduled', /setGuards\(address,uint16,uint16,uint16,uint32\), executable after/);
  has('timelock-executed', /setGuards/);
  has('timelock-cancelled');
  has('oracle-paused');
  has('oracle-deviation');
  has('oracle-unavailable');
});
