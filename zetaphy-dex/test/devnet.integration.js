// End-to-end on a real ZETAPHY chain (zetaphyd, 1 s blocks, a throwaway
// single-node devnet from zetaphy-network/scripts/devnet.sh):
//   - cli.js deploy finds the native ERC-20 precompile (0xEeee…EEeE) and uses
//     it as the router's WETH; it deploys two test tokens and seeds their pools;
//   - a user swaps native ZETAPHY -> tUSD and back, adds and removes native
//     liquidity; the pair's native balance IS its precompile balance (reserve);
//   - Neuro: a real ThreatRegistry, a token flagged by two runners, the router
//     refuses to swap into it once governance sets the registry (selling works);
//   - S1: the DEX trusts the precompile's balances, so a call that moves native
//     coins through it and then reverts (the router's minimum, the pair's K
//     check, or a deliberate revert) must leave every native balance exactly as
//     it was; deposit{value} from a contract gives the coins back to it.
// Needs the zetaphyd binary (ZETAPHYD=…, default `zetaphyd` on PATH), so it is
// not part of `npm test`. Run: npm run test:devnet
// On shared machines: flock /tmp/ci-test/devnet.lock npm run test:devnet
// Ports: ZDEX_DEVNET_PORT (default 24545) and the next ~110.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, ContractFactory, parseEther, Interface, NonceManager } from 'ethers';

const PORT = Number(process.env.ZDEX_DEVNET_PORT ?? 24545);
const RPC = `http://127.0.0.1:${PORT}`;
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-dex-devnet-'));
const actors = Object.fromEntries(['deployer', 'user', 'r1', 'r2'].map((n) => [n, Wallet.createRandom()]));
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const REGISTRY_ART = JSON.parse(readFileSync(new URL('../../zetaphy-network/artifacts/ThreatRegistry.json', import.meta.url), 'utf8'));
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)',
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function transfer(address,uint256) returns (bool)'];
let provider, deployed;

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args, '--rpc', RPC], { env, timeout: 180_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
// One NonceManager per actor (the node's pending nonce can lag right after a
// receipt); reset() after cli.js sent transactions with the same key.
const signers = {};
const signer = (n) => (signers[n] ??= new NonceManager(actors[n].connect(provider)));

before(() => {
  writeFileSync(join(root, 'deployer.key'), actors.deployer.privateKey + '\n', { mode: 0o600 });
  execFileSync(new URL('../../zetaphy-network/scripts/devnet.sh', import.meta.url).pathname,
    [join(root, 'chain'), String(PORT), ...Object.values(actors).map((w) => w.address)],
    { stdio: 'inherit', env: { ...env, COSMOS_CHAIN_ID: 'zetaphy_77390-1' } });
  provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: false, polling: true, pollingInterval: 500 });
});

after(() => {
  try { process.kill(Number(readFileSync(join(root, 'chain', 'node.pid'), 'utf8'))); } catch {}
});

test('the native precompile behaves like WETH: ERC-20 views, deposit() gives the coins back, balances are native balances', { timeout: 120_000 }, async () => {
  assert.equal((await provider.getNetwork()).chainId, 77390n);
  const w = new Contract(NATIVE, [...ERC20, 'function deposit() payable', 'function withdraw(uint256)'], signer('user'));
  assert.equal(await w.decimals(), 18n);
  const sym = await w.symbol();
  assert.ok(typeof sym === 'string' && sym.length > 0, sym);
  const me = actors.user.address;
  assert.equal(await w.balanceOf(me), await provider.getBalance(me), 'precompile balance == native balance');
  const before = await provider.getBalance(me);
  const r = await mined(w.deposit({ value: parseEther('1') }));
  const fee = r.gasUsed * r.gasPrice;
  assert.equal(await provider.getBalance(me), before - fee, 'deposit returns the coins (only gas spent)');
  console.log(`native precompile: symbol ${sym}, deposit gas ${r.gasUsed}`);
});

test('cli.js deploy uses the precompile as WETH, deploys test tokens and seeds pools', { timeout: 300_000 }, async () => {
  const out = join(root, 'deployments.json');
  const r = await cli(['deploy', '--key-file', join(root, 'deployer.key'), '--test-tokens', '--out', out, '--public-rpc', 'https://rpc.example.invalid']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /wrapped native: 0xEeee\S+ \(native-precompile\)/);
  deployed = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(deployed.chainId, 77390);
  assert.equal(deployed.contracts.wnative, NATIVE);
  assert.equal(deployed.tokens.length, 2);
  assert.equal(deployed.rpc, 'https://rpc.example.invalid');
  const router = new Contract(deployed.contracts.router, art('ZetaphyRouter').abi, provider);
  assert.equal(await router.WETH(), NATIVE);
  // The seeded pool: its native balance is exactly the WZTPHY reserve.
  const tusd = deployed.tokens[0].address;
  const pair = new Contract(await router.pairFor(tusd, NATIVE), art('ZetaphyPair').abi, provider);
  const [r0, r1] = await pair.getReserves();
  const nativeIs0 = (await pair.token0()) === NATIVE;
  assert.equal(await provider.getBalance(await pair.getAddress()), nativeIs0 ? r0 : r1);
  assert.equal(nativeIs0 ? r0 : r1, parseEther('100'));
  const s = await cli(['status', '--deployments', out]);
  assert.match(s.out, /"pairs": 2/, s.out);
  console.log(r.out.trim());
});

// The node can answer eth_call from the block before a receipt's block right
// after the receipt arrives; wait until the next block exists before reading.
async function mined(tx) {
  const r = await (await tx).wait();
  while ((await provider.getBlockNumber()) <= r.blockNumber) await new Promise((res) => setTimeout(res, 200));
  return r;
}

test('a user swaps native ZETAPHY -> tUSD and back, adds and removes native liquidity', { timeout: 300_000 }, async () => {
  const user = signer('user');
  const me = actors.user.address;
  const router = new Contract(deployed.contracts.router, art('ZetaphyRouter').abi, user);
  const tusd = new Contract(deployed.tokens[0].address, ERC20, user);
  const path = [NATIVE, await tusd.getAddress()];
  const pairAddr = await router.pairFor(...path);

  // native -> tUSD
  const amounts = await router.getAmountsOut(parseEther('2'), path);
  const minOut = (amounts[1] * 995n) / 1000n; // 0.5% slippage
  const n0 = await provider.getBalance(me);
  const r1 = await mined(router.swapExactETHForTokens(minOut, path, me, deadline(), { value: parseEther('2') }));
  const got = await tusd.balanceOf(me);
  assert.equal(got, amounts[1], 'nobody else traded in between');
  assert.equal(n0 - (await provider.getBalance(me)), parseEther('2') + r1.gasUsed * r1.gasPrice);
  console.log(`swapped 2 ZTPHY -> ${got} tUSD wei (gas ${r1.gasUsed})`);

  // tUSD -> native, with an exact approval
  const back = got / 2n;
  await mined(tusd.approve(await router.getAddress(), back));
  const outs = await router.getAmountsOut(back, [path[1], NATIVE]);
  const n1 = await provider.getBalance(me);
  const r2 = await mined(router.swapExactTokensForETH(back, outs[1], [path[1], NATIVE], me, deadline()));
  assert.equal((await provider.getBalance(me)) - n1 + r2.gasUsed * r2.gasPrice, outs[1]);
  assert.equal(await tusd.allowance(me, await router.getAddress()), 0n, 'the exact approval is used up');
  assert.equal(await provider.getBalance(await router.getAddress()), 0n, 'the router keeps no native coins');
  console.log(`swapped ${back} tUSD wei -> ${outs[1]} ZTPHY wei (gas ${r2.gasUsed})`);

  // add native liquidity, then remove it (native comes back as native)
  const pair = new Contract(pairAddr, art('ZetaphyPair').abi, user);
  const add = await tusd.balanceOf(me);
  await mined(tusd.approve(await router.getAddress(), add));
  const nAdd = await provider.getBalance(me);
  const rAdd = await mined(router.addLiquidityETH(path[1], add, 0, 0, me, deadline(), { value: parseEther('5') }));
  const addedNative = nAdd - (await provider.getBalance(me)) - rAdd.gasUsed * rAdd.gasPrice; // the rest of the 5 was refunded
  assert.ok(addedNative > 0n && addedNative < parseEther('5'), `added ${addedNative}`);
  const lp = await pair.balanceOf(me);
  assert.ok(lp > 0n);
  const [q0, q1] = await pair.getReserves();
  assert.equal(await provider.getBalance(pairAddr), (await pair.token0()) === NATIVE ? q0 : q1, 'reserve == native balance');
  await mined(pair.approve(await router.getAddress(), lp));
  const n2 = await provider.getBalance(me);
  const r3 = await mined(router.removeLiquidityETH(path[1], lp, 0, 0, me, deadline()));
  const removedNative = (await provider.getBalance(me)) + r3.gasUsed * r3.gasPrice - n2;
  assert.ok(removedNative <= addedNative && removedNative > (addedNative * 999n) / 1000n, `added ${addedNative}, got back ${removedNative}`);
  console.log(`added ${addedNative} ZTPHY wei of liquidity (rest refunded), removed it: ${removedNative} back`);
  assert.equal(await pair.balanceOf(me), 0n);
  // Slippage and deadline are enforced on chain.
  await assert.rejects(router.swapExactETHForTokens.staticCall(amounts[1] * 10n, path, me, deadline(), { value: parseEther('2') }), /InsufficientOutputAmount|revert/);
  await assert.rejects(router.swapExactETHForTokens.staticCall(0, path, me, 1n, { value: parseEther('2') }), /Expired|revert/);
});

test('Neuro: a token flagged in a real ThreatRegistry is refused by the router once governance sets the registry; selling still works', { timeout: 300_000 }, async () => {
  const dep = signer('deployer');
  const runners = await new ContractFactory(art('MockRunners').abi, art('MockRunners').bytecode, dep).deploy();
  await runners.waitForDeployment();
  for (const r of ['r1', 'r2']) await mined(runners.set(actors[r].address, true));
  const reg = await new ContractFactory(REGISTRY_ART.abi, REGISTRY_ART.bytecode, dep).deploy(await runners.getAddress(), 2, 1, actors.deployer.address, 0);
  await reg.waitForDeployment();
  const tswd = deployed.tokens[1].address;
  const key = await reg.addressKey(77390n, tswd);
  for (const r of ['r1', 'r2']) await mined(reg.connect(signer(r)).vote(key, true, 2, '0x' + 'e7'.repeat(32), 'neuro:devnet'));
  assert.deepEqual([...(await reg.isContractEnforced(tswd))], [true, 2n]);

  const s = await cli(['set-registry', await reg.getAddress(), '--key-file', join(root, 'deployer.key'), '--deployments', join(root, 'deployments.json')]);
  assert.equal(s.code, 0, s.out);
  dep.reset();
  const user = signer('user');
  const me = actors.user.address;
  const router = new Contract(deployed.contracts.router, art('ZetaphyRouter').abi, user);
  const iface = new Interface(art('ZetaphyRouter').abi);
  const err = await router.swapExactETHForTokens.staticCall(0, [NATIVE, tswd], me, deadline(), { value: parseEther('1') }).catch((e) => e);
  const parsed = iface.parseError(err?.data ?? err?.info?.error?.data ?? '0x');
  assert.equal(parsed?.name, 'TokenEnforced', String(err?.message));
  assert.equal(parsed.args[0], tswd);
  // tUSD is unaffected; a holder of tSWD can still sell it.
  await mined(router.swapExactETHForTokens(0, [NATIVE, deployed.tokens[0].address], me, deadline(), { value: parseEther('1') }));
  const deployerRouter = router.connect(dep);
  const t = new Contract(tswd, ERC20, dep);
  await mined(t.approve(deployed.contracts.router, parseEther('10')));
  await mined(deployerRouter.swapExactTokensForETH(parseEther('10'), 0, [tswd, NATIVE], actors.deployer.address, deadline()));
  // Off again.
  const off = await cli(['set-registry', '0x0', '--key-file', join(root, 'deployer.key'), '--deployments', join(root, 'deployments.json')]);
  assert.equal(off.code, 0, off.out);
  await mined(router.swapExactETHForTokens(0, [NATIVE, tswd], me, deadline(), { value: parseEther('1') }));
  console.log('Neuro: swap into the enforced-flagged token refused (TokenEnforced), selling it worked, registry off -> allowed again');
});

test('S1: native coins moved through the precompile inside a reverting call are restored exactly; deposit{value} from a contract gives them back', { timeout: 300_000 }, async () => {
  const user = signer('user');
  const me = actors.user.address;
  const ri = new Interface(art('ZetaphyRouter').abi);
  const pi = new Interface(art('ZetaphyPair').abi);
  const wi = new Interface([...ERC20, 'function deposit() payable']);
  const probe = await new ContractFactory(art('RevertProbe').abi, art('RevertProbe').bytecode, user).deploy();
  await probe.waitForDeployment();
  const P = await probe.getAddress();
  const tusd = deployed.tokens[0].address;
  const router = new Contract(deployed.contracts.router, art('ZetaphyRouter').abi, provider);
  const pairAddr = await router.pairFor(NATIVE, tusd);
  const pair = new Contract(pairAddr, art('ZetaphyPair').abi, provider);
  const nativeIs0 = (await pair.token0()) === NATIVE;
  const reserveNative = async () => { const [r0, r1] = await pair.getReserves(); return nativeIs0 ? r0 : r1; };
  const t = new Contract(tusd, ERC20, provider);

  /** Runs one probe as `user`; checks the balances the chain reports inside and after the transaction. */
  async function run(name, calls, undo, value) {
    const n0 = await provider.getBalance(me);
    const p0 = await provider.getBalance(pairAddr);
    const t0 = await t.balanceOf(P);
    const r = await mined(probe.probe(calls, undo, NATIVE, pairAddr, { value, gasLimit: 3_000_000n }));
    const ev = r.logs.map((l) => { try { return probe.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Probed');
    assert.ok(ev, `${name}: Probed event`);
    const [before, afterwards, reverted, revertData] = ev.args;
    const gas = r.gasUsed * r.gasPrice;
    assert.equal(await provider.getBalance(me), n0 - gas, `${name}: the caller paid gas only (the value came back)`);
    assert.equal(await provider.getBalance(P), 0n, `${name}: the probe keeps nothing`);
    return { before: [...before], afterwards: [...afterwards], reverted, revertData, p0, t0 };
  }
  const unchanged = (name, x) => {
    assert.equal(x.reverted, true, name);
    assert.deepEqual(x.afterwards, x.before, `${name}: native and precompile balances inside the tx are what they were before the reverted call`);
  };
  const innerError = (x) => { const f = probe.interface.parseError(x.revertData); return f.name === 'Failed' ? [Number(f.args[0]), f.args[1]] : [f.name]; };
  const after = async (name, x) => {
    assert.equal(await provider.getBalance(pairAddr), x.p0, `${name}: the pair's native balance is unchanged after the tx`);
    assert.equal(await provider.getBalance(pairAddr), await reserveNative(), `${name}: and still equals its reserve`);
    assert.equal(await t.balanceOf(P), x.t0, `${name}: no tUSD reached the probe`);
  };
  const dl = deadline();
  const ONE = parseEther('1');

  // A: the router wraps (precompile transfer of 1 ZTPHY into the pair), swaps, then fails its minimum.
  const a = await run('A', [{ target: deployed.contracts.router, value: ONE,
    data: ri.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [2n ** 255n, [NATIVE, tusd], P, dl]) }], false, ONE);
  unchanged('A', a);
  const [ia, da] = innerError(a);
  assert.equal(ia, 0);
  assert.equal(ri.parseError(da)?.name, 'InsufficientOutputAmount', 'A: reverted by the router after the coins moved');
  await after('A', a);

  // B: 1 ZTPHY sent to the pair through the precompile's transfer, then a swap asking 1 wei too much: K.
  const [r0, r1] = await pair.getReserves();
  const [rIn, rOut] = nativeIs0 ? [r0, r1] : [r1, r0];
  const out = (ONE * 997n * rOut) / (rIn * 1000n + ONE * 997n) + 1n;
  const b = await run('B', [
    { target: NATIVE, value: 0n, data: wi.encodeFunctionData('transfer', [pairAddr, ONE]) },
    { target: pairAddr, value: 0n, data: pi.encodeFunctionData('swap', nativeIs0 ? [0n, out, P, '0x'] : [out, 0n, P, '0x']) },
  ], false, ONE);
  unchanged('B', b);
  const [ib, db] = innerError(b);
  assert.equal(ib, 1);
  assert.equal(pi.parseError(db)?.name, 'K', 'B: the pair\'s K check');
  await after('B', b);

  // C: a swap that succeeds, then a deliberate revert around it.
  const c = await run('C', [{ target: deployed.contracts.router, value: ONE,
    data: ri.encodeFunctionData('swapExactETHForTokens', [0n, [NATIVE, tusd], P, dl]) }], true, ONE);
  unchanged('C', c);
  assert.deepEqual(innerError(c), ['Undo']);
  await after('C', c);

  // D: deposit{value} called by a contract: the coins come straight back to it (nothing reverts).
  const d = await run('D', [{ target: NATIVE, value: ONE, data: wi.encodeFunctionData('deposit') }], false, ONE);
  assert.equal(d.reverted, false);
  assert.equal(d.before[2], ONE, 'D: the probe held the value');
  assert.deepEqual(d.afterwards, d.before, 'D: deposit gave the coins back to the calling contract (native == precompile balance, unchanged)');
  console.log(`S1: precompile transfers undone on revert (router minimum, K, deliberate); deposit{value} from a contract returns the coins`);
});
