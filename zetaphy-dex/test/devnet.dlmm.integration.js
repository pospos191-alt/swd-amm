// DLMM (contracts/dlmm/, UNAUDITED) end-to-end on a real ZETAPHY chain
// (zetaphyd, 1 s blocks, a throwaway single-node devnet from
// zetaphy-network/scripts/devnet.sh):
//   - dlmm-cli.js deploy: the DLMM factory, a router whose WNATIVE is the native
//     ERC-20 precompile (0xEeee…EEeE), the default presets, the addresses
//     merged into the deployments file and the web config; two test tokens;
//   - an LP adds native + token liquidity over a range of bins; the pair's
//     native balance IS its precompile balance (reserve + protocol fees);
//   - a user swaps native -> token (exact in, exact out with refund) and back,
//     multi-hop token -> native -> token, and the LP removes liquidity;
//   - native coins sent straight to the pair (a donation) change no bin;
//   - a swap that fails its minimum leaves every balance as it was;
//   - Neuro: a real ThreatRegistry, an enforced flag, the DLMM router refuses
//     to buy the token once governance sets the registry; selling it works;
//   - gas of typical swaps on the chain.
// Needs zetaphyd (ZETAPHYD=…), so it is not part of `npm test`.
// Run: ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:devnet:dlmm
// Ports: ZDLMM_DEVNET_PORT (default 24745) and the next ~110.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, ContractFactory, parseEther, Interface, NonceManager, MaxUint256 } from 'ethers';

const PORT = Number(process.env.ZDLMM_DEVNET_PORT ?? 24745);
const RPC = `http://127.0.0.1:${PORT}`;
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-dlmm-devnet-'));
const actors = Object.fromEntries(['deployer', 'lp', 'user', 'r1', 'r2'].map((n) => [n, Wallet.createRandom()]));
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const REGISTRY_ART = JSON.parse(readFileSync(new URL('../../zetaphy-network/artifacts/ThreatRegistry.json', import.meta.url), 'utf8'));
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)'];
let provider;
const C = {}; // deployed contracts
const signers = {};
const signer = (n) => (signers[n] ??= new NonceManager(actors[n].connect(provider)));
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const sorted = (a, b) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

before(() => {
  execFileSync(new URL('../../zetaphy-network/scripts/devnet.sh', import.meta.url).pathname,
    [join(root, 'chain'), String(PORT), ...Object.values(actors).map((w) => w.address)],
    { stdio: 'inherit', env: { ...env, COSMOS_CHAIN_ID: 'zetaphy_77390-1' } });
  provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: false, polling: true, pollingInterval: 500 });
});

after(() => {
  try { process.kill(Number(readFileSync(join(root, 'chain', 'node.pid'), 'utf8'))); } catch {}
});

// The node can answer eth_call from the block before a receipt's block right
// after the receipt arrives; wait until the next block exists before reading.
async function mined(tx) {
  const r = await (await tx).wait();
  while ((await provider.getBlockNumber()) <= r.blockNumber) await new Promise((res) => setTimeout(res, 200));
  return r;
}

async function deploy(name, args, who = 'deployer') {
  const a = art(name);
  const c = await new ContractFactory(a.abi, a.bytecode, signer(who)).deploy(...args);
  await c.waitForDeployment();
  return c;
}

function dlmmCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../dlmm-cli.js', import.meta.url).pathname, ...args, '--rpc', RPC], { env, timeout: 300_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}

test('dlmm-cli.js deploy on a real chain: factory, router on the native precompile, default presets, deployments + web config', { timeout: 300_000 }, async () => {
  assert.equal((await provider.getNetwork()).chainId, 77390n);
  const keyFile = join(root, 'deployer.key');
  writeFileSync(keyFile, actors.deployer.privateKey + '\n', { mode: 0o600 });
  const out = join(root, 'deployments.json');
  const web = join(root, 'web-deployments.json');
  writeFileSync(web, JSON.stringify({ name: 'ZETAPHY DEX', chainId: 77390, rpc: '', contracts: { factory: '0x' + '11'.repeat(20) }, tokens: [] }));
  const r = await dlmmCli(['deploy', '--key-file', keyFile, '--deployments', out, '--web', web]);
  assert.equal(r.code, 0, r.out);
  const d = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(d.contracts.wnative, NATIVE);
  assert.equal(d.dlmm.unaudited, true);
  const w = JSON.parse(readFileSync(web, 'utf8'));
  assert.equal(w.contracts.dlmmRouter, d.contracts.dlmmRouter);
  assert.equal(w.contracts.factory, '0x' + '11'.repeat(20), 'the web config keeps what it had');
  C.factory = new Contract(d.contracts.dlmmFactory, art('ZetaphyDlmmFactory').abi, signer('deployer'));
  C.router = new Contract(d.contracts.dlmmRouter, art('ZetaphyDlmmRouter').abi, signer('deployer'));
  assert.equal(await C.router.WNATIVE(), NATIVE);
  assert.deepEqual((await C.factory.presetSteps()).map(Number).sort((a, b) => a - b), [1, 10, 25, 100]);
  assert.equal(await C.factory.governance(), actors.deployer.address);
  const st = await dlmmCli(['status', '--deployments', out]);
  assert.match(st.out, /"presets": \[\s*1,\s*10,\s*25,\s*100\s*\]/, st.out);
  C.tusd = await deploy('TestToken', ['Test USD', 'tUSD', 18, parseEther('100000000'), 0]);
  C.tswd = await deploy('TestToken', ['Test SWD', 'tSWD', 18, parseEther('100000000'), 0]);
  for (const t of [C.tusd, C.tswd]) {
    await mined(t.transfer(actors.lp.address, parseEther('1000000')));
    await mined(t.transfer(actors.user.address, parseEther('1000')));
  }
  console.log(r.out.trim());
});

/** A spot range of n bins on each side, `per` per bin, in the pair's X/Y order. */
function spot(n, per) {
  const deltas = []; const ax = []; const ay = [];
  for (let d = -n; d <= n; d++) { deltas.push(d); ax.push(d > 0 ? per : d === 0 ? per / 2n : 0n); ay.push(d < 0 ? per : d === 0 ? per / 2n : 0n); }
  return { deltas, ax, ay };
}

test('an LP adds native + tUSD over 21 bins; the pair holds exactly its accounting, in native coins', { timeout: 300_000 }, async () => {
  const lp = signer('lp');
  const router = C.router.connect(lp);
  const tusd = await C.tusd.getAddress();
  for (const t of [C.tusd, C.tswd]) await mined(t.connect(lp).approve(await router.getAddress(), MaxUint256));
  for (const tok of [tusd, await C.tswd.getAddress()]) {
    const [X, Y] = sorted(tok, NATIVE);
    const s = spot(10, parseEther('10'));
    const nativeSum = (X === NATIVE ? s.ax : s.ay).reduce((a, b) => a + b, 0n);
    const p = [X, Y, 10, 0, 2, s.deltas, s.ax, s.ay, 0, 0, actors.lp.address, deadline()];
    const r = await mined(router.addLiquidityNATIVE(p, { value: nativeSum }));
    console.log(`addLiquidityNATIVE (21 bins, new pair): gas ${r.gasUsed}`);
  }
  C.pair = new Contract(await C.factory.getPair(tusd, NATIVE, 10), art('ZetaphyDlmmPair').abi, provider);
  const nativeIsX = (await C.pair.tokenX()) === NATIVE;
  C.nativeIsX = nativeIsX;
  const reserveNative = nativeIsX ? await C.pair.reserveX() : await C.pair.reserveY();
  assert.equal(reserveNative, parseEther('105'));
  assert.equal(await provider.getBalance(await C.pair.getAddress()), reserveNative, 'native balance == reserve');
  assert.equal(await provider.getBalance(await C.router.getAddress()), 0n);
});

test('a user swaps native -> tUSD (exact in, exact out with refund) and back; multi-hop tUSD -> native -> tSWD; gas on the chain', { timeout: 300_000 }, async () => {
  const user = signer('user');
  const me = actors.user.address;
  const router = C.router.connect(user);
  const tusd = await C.tusd.getAddress();
  const tswd = await C.tswd.getAddress();
  const t = C.tusd.connect(user);
  await mined(t.approve(await router.getAddress(), MaxUint256));
  const p1 = [[10], [NATIVE, tusd]];
  const outs = await router.getAmountsOut(parseEther('2'), p1);
  const b0 = await t.balanceOf(me);
  const r1 = await mined(router.swapExactNATIVEForTokens((outs[1] * 995n) / 1000n, p1, me, deadline(), { value: parseEther('2') }));
  assert.equal((await t.balanceOf(me)) - b0, outs[1]);
  const ins = await router.getAmountsIn(parseEther('1'), p1);
  const n0 = await provider.getBalance(me);
  const r2 = await mined(router.swapNATIVEForExactTokens(parseEther('1'), p1, me, deadline(), { value: parseEther('5') }));
  assert.equal(n0 - (await provider.getBalance(me)) - r2.gasUsed * r2.gasPrice, ins[0], 'only what was needed; the rest refunded');
  const n1 = await provider.getBalance(me);
  const back = parseEther('1');
  const outN = (await router.getAmountsOut(back, [[10], [tusd, NATIVE]]))[1];
  const r3 = await mined(router.swapExactTokensForNATIVE(back, outN, [[10], [tusd, NATIVE]], me, deadline()));
  assert.equal((await provider.getBalance(me)) - n1 + r3.gasUsed * r3.gasPrice, outN);
  // A bigger swap that crosses several bins.
  const r4 = await mined(router.swapExactNATIVEForTokens(0, p1, me, deadline(), { value: parseEther('25') }));
  // Multi-hop through two DLMM pairs.
  const p3 = [[10, 10], [tusd, NATIVE, tswd]];
  const out3 = (await router.getAmountsOut(parseEther('3'), p3))[2];
  const s0 = await C.tswd.balanceOf(me);
  const r5 = await mined(router.swapExactTokensForTokens(parseEther('3'), out3, p3, me, deadline()));
  assert.equal((await C.tswd.balanceOf(me)) - s0, out3);
  assert.equal(await provider.getBalance(await router.getAddress()), 0n, 'the router keeps no native coins');
  const nativeIsX = C.nativeIsX;
  const pairNative = await provider.getBalance(await C.pair.getAddress());
  assert.equal(pairNative, (nativeIsX ? await C.pair.reserveX() : await C.pair.reserveY()), 'pair native == reserve');
  console.log(`gas on the chain: native->tUSD 1 bin ${r1.gasUsed}, exact-out ${r2.gasUsed}, tUSD->native ${r3.gasUsed}, 25 ZTPHY across bins ${r4.gasUsed} (active ${await C.pair.getActiveId()}), 2 hops ${r5.gasUsed}`);
});

test('native coins sent straight to the pair change no bin and no price; skim returns them; a swap failing its minimum changes nothing', { timeout: 300_000 }, async () => {
  const user = signer('user');
  const me = actors.user.address;
  const pairAddr = await C.pair.getAddress();
  const active = await C.pair.getActiveId();
  const bin = [...(await C.pair.getBin(active))];
  const quote = [...(await C.pair.getSwapOut(parseEther('1'), !C.nativeIsX))];
  await mined(new Contract(NATIVE, ERC20, user).transfer(pairAddr, parseEther('3')));
  assert.equal(await C.pair.getActiveId(), active);
  assert.deepEqual([...(await C.pair.getBin(active))], bin);
  assert.deepEqual([...(await C.pair.getSwapOut(parseEther('1'), !C.nativeIsX))], quote);
  const n0 = await provider.getBalance(me);
  const rs = await mined(C.pair.connect(user).skim(me));
  assert.equal((await provider.getBalance(me)) - n0 + rs.gasUsed * rs.gasPrice, parseEther('3'), 'skim returned the donation');
  // A swap whose minimum is too high reverts; the pair's native balance is unchanged.
  const p0 = await provider.getBalance(pairAddr);
  const router = C.router.connect(user);
  const tusd = await C.tusd.getAddress();
  await assert.rejects(router.swapExactNATIVEForTokens.staticCall(2n ** 200n, [[10], [NATIVE, tusd]], me, deadline(), { value: parseEther('1') }), /InsufficientOutputAmount|revert/);
  const tx = await router.swapExactNATIVEForTokens(2n ** 200n, [[10], [NATIVE, tusd]], me, deadline(), { value: parseEther('1'), gasLimit: 1_000_000n });
  await assert.rejects(tx.wait());
  assert.equal(await provider.getBalance(pairAddr), p0);
});

test('Neuro: once governance sets a real ThreatRegistry, the DLMM router refuses to buy an enforced token; selling it for native works', { timeout: 300_000 }, async () => {
  const dep = signer('deployer');
  const runners = await deploy('MockRunners', []);
  for (const r of ['r1', 'r2']) await mined(runners.set(actors[r].address, true));
  const reg = await new ContractFactory(REGISTRY_ART.abi, REGISTRY_ART.bytecode, dep).deploy(await runners.getAddress(), 2, 1, actors.deployer.address, 0);
  await reg.waitForDeployment();
  const tswd = await C.tswd.getAddress();
  const key = await reg.addressKey(77390n, tswd);
  for (const r of ['r1', 'r2']) await mined(reg.connect(signer(r)).vote(key, true, 2, '0x' + 'e7'.repeat(32), 'neuro:devnet'));
  assert.deepEqual([...(await reg.isContractEnforced(tswd))], [true, 2n]);
  await mined(C.factory.connect(dep).setThreatRegistry(await reg.getAddress()));
  const user = signer('user');
  const me = actors.user.address;
  const router = C.router.connect(user);
  const err = await router.swapExactNATIVEForTokens.staticCall(0, [[10], [NATIVE, tswd]], me, deadline(), { value: parseEther('1') }).catch((e) => e);
  const parsed = new Interface(art('ZetaphyDlmmRouter').abi).parseError(err?.data ?? err?.info?.error?.data ?? '0x');
  assert.equal(parsed?.name, 'TokenEnforced', String(err?.message));
  // Selling tSWD for native still works.
  await mined(C.tswd.connect(user).approve(await router.getAddress(), MaxUint256));
  await mined(router.swapExactTokensForNATIVE(parseEther('1'), 0, [[10], [tswd, NATIVE]], me, deadline()));
  await mined(C.factory.connect(dep).setThreatRegistry('0x0000000000000000000000000000000000000000'));
  await mined(router.swapExactNATIVEForTokens(0, [[10], [NATIVE, tswd]], me, deadline(), { value: parseEther('1') }));
  console.log('Neuro on the DLMM router: buying the enforced token refused, selling it worked, registry off -> allowed');
});

test('the LP removes everything as native + tUSD; the pair is empty and holds no native coins', { timeout: 300_000 }, async () => {
  const lp = signer('lp');
  const pair = C.pair.connect(lp);
  await mined(pair.setApprovalForAll(await C.router.getAddress(), true));
  const ids = []; const shares = [];
  for (let id = -30; id <= 30; id++) {
    const s = await C.pair.balanceOf(actors.lp.address, id);
    if (s > 0n) { ids.push(id); shares.push(s); }
  }
  const n0 = await provider.getBalance(actors.lp.address);
  const r = await mined(C.router.connect(lp).removeLiquidityNATIVE(await C.tusd.getAddress(), 10, ids, shares, 0, 0, actors.lp.address, deadline()));
  assert.ok((await provider.getBalance(actors.lp.address)) + r.gasUsed * r.gasPrice > n0);
  assert.equal(await C.pair.reserveX(), 0n);
  assert.equal(await C.pair.reserveY(), 0n);
  assert.equal(await provider.getBalance(await C.pair.getAddress()), 0n);
  console.log(`removeLiquidityNATIVE (${ids.length} bins): gas ${r.gasUsed}`);
});
