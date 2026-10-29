#!/usr/bin/env node
// Parametric hack insurance (item 32), end to end on LOCAL anvil chains only (foundry v1.2.3; ANVIL=<path> to pick
// the binary). Used by .github/workflows/insurance-replay.yml; also runs anywhere anvil is installed:
//   node scripts/insurance-replay-e2e.js
//
//  1. a local "ZETAPHY" (anvil, chain id 77390): the test fixtures of test/helpers/ReplayKit.sol (a vault whose
//     sweep() has no owner check, two tokens, a price stub), HackInsurance with a stand-in committee, two covers;
//  2. a scripted incident: three fixture transactions (one only valid at its own timestamp) and unrelated noise;
//  3. `zetaphy insurance replay` twice (each forks the chain with a fresh anvil at fromBlock-1): the same bytes,
//     the same hash, keccak256(file) = the hash, the expected loss; an on-chain-priced run;
//  4. `zetaphy insurance claim` + two runners' `zetaphy insurance vote`: Approved; a claim with a tampered loss: Rejected.
// Keys: anvil's public dev keys (local chain only). Prints INSURANCE REPLAY E2E OK.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, NonceManager, parseEther, keccak256, getAddress } from 'ethers';
import { replayKit } from '../test/helpers/replaykit.js';
import { targetKeyOf, FOUNDRY_VERSION } from '../src/replay.js';

const ANVIL = process.env.ANVIL ?? 'anvil';
const PORT = Number(process.env.E2E_PORT ?? 18545);
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's well-known development keys (public; never hold anything)
const DEV = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'];
const ART = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const CLI = new URL('../cli.js', import.meta.url).pathname;
const ok = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok  ${m}`); };
const work = mkdtempSync(join(tmpdir(), 'zetaphy-replay-'));

function zetaphy(home, args) {
  return execFileSync(process.execPath, [CLI, ...args, '--rpc', RPC], { encoding: 'utf8', env: { ...process.env, ZETAPHY_HOME: home, ANVIL }, stdio: ['ignore', 'pipe', 'pipe'] });
}
function home(name, key) {
  const h = join(work, name);
  mkdirSync(h, { recursive: true });
  if (key) writeFileSync(join(h, 'worker.key'), key, { mode: 0o600 });
  return h;
}
const pick = (out, k) => new RegExp(`^${k} (\\S+)`, 'm').exec(out)?.[1];

async function main() {
  const v = execFileSync(ANVIL, ['--version'], { encoding: 'utf8' }).split('\n')[0];
  console.log(`anvil: ${v} (pinned ${FOUNDRY_VERSION})`);
  const chain = spawn(ANVIL, ['--chain-id', '77390', '--port', String(PORT), '--host', '127.0.0.1', '--silent'], { stdio: 'ignore' });
  try {
    const p = new JsonRpcProvider(RPC, 77390, { staticNetwork: true, pollingInterval: 200 });
    for (let i = 0; ; i++) { try { await p.getBlockNumber(); break; } catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 500)); } }
    const [gov, holder, attacker, user, w1, w2] = DEV.map((k) => new NonceManager(new Wallet(k, p)));
    const addr = async (s) => getAddress(await s.getAddress());
    const kit = replayKit();
    const deploy = async (a, args, s) => { const k = await new ContractFactory(a.abi, a.bytecode, s).deploy(...args); await k.waitForDeployment(); return k; };
    const send = async (pr) => (await pr).wait();

    // 1. the fixtures and the insurance
    const token = await deploy(kit.ReplayToken, [6], gov);
    const other = await deploy(kit.ReplayToken, [18], gov);
    const vault = await deploy(kit.ToyVault, [], gov);
    const V = await vault.getAddress(), T = await token.getAddress(), O = await other.getAddress();
    await send(gov.sendTransaction({ to: V, value: parseEther('50') }));
    await send(token.mint(V, 2_000_000n));
    await send(other.mint(V, parseEther('5')));
    const NATIVE = '0x' + '5a'.repeat(20);
    const oracle = await deploy(kit.PriceStub, [], gov);
    await send(oracle.set(NATIVE, parseEther('2')));
    await send(oracle.set(T, parseEther('3')));
    const runners = await deploy(kit.RunnersStub, [], gov);
    const ins = await deploy(ART('HackInsurance'), [await runners.getAddress(), 2, 1, await addr(gov)], gov);
    const I = await ins.getAddress();
    await send(ins.deposit({ value: parseEther('1000') }));
    const key = targetKeyOf(77390, V);
    await send(ins.setTarget(key, true, parseEther('300')));
    const prem = await ins.premiumOf(parseEther('200'), 30 * 86400);
    for (let i = 0; i < 2; i++) await send(ins.connect(holder).buyCover(key, parseEther('200'), 30 * 86400, { value: prem }));

    // 2. the scripted incident (fixture transactions; noise in between is not part of the claim)
    const vi = vault.connect(attacker);
    const r1 = await send(vi.sweep(T, await addr(attacker)));
    await send(user.sendTransaction({ to: await addr(w1), value: parseEther('1') }));
    const at = (await p.getBlock('latest')).timestamp + 7;
    await p.send('evm_setNextBlockTimestamp', [at]);
    const r2 = await send(vi.sweepAt('0x' + '00'.repeat(20), await addr(attacker), at, at));
    const r3 = await send(vi.sweep(O, await addr(attacker)));
    await p.send('anvil_mine', ['0xf']);
    const txs = [r1.hash, r2.hash, r3.hash].join(','), from = String(r1.blockNumber), to = String(r3.blockNumber);
    console.log(`incident: blocks ${from}..${to}, vault ${V}`);

    // 3. the replay, twice: the same bytes and hash
    const h0 = home('replayer');
    const run = (out, extra) => zetaphy(h0, ['insurance', 'replay', '--target', V, '--tx', txs, '--from-block', from, '--to-block', to, '--out', join(work, out), ...extra]);
    const a = run('a.json', ['--price', `${T}=1.5`]);
    const b = run('b.json', ['--price', `${T.toLowerCase()}=1.500`]);
    console.log(a.trim().split('\n').map((l) => `    ${l}`).join('\n'));
    const fa = readFileSync(join(work, 'a.json')), fb = readFileSync(join(work, 'b.json'));
    ok(fa.equals(fb), 'two replays: byte-identical reports');
    ok(pick(a, 'reportHash') === pick(b, 'reportHash') && keccak256(fa) === pick(a, 'reportHash'), 'the same reportHash, = keccak256 of the file');
    ok(pick(a, 'loss') === parseEther('53').toString(), 'loss = 50 native + 2 RPL x 1.5 = 53 (the noise is not replayed)');
    const rep = JSON.parse(fa.toString());
    ok(rep.matchesOriginal === true && rep.txs.every((t) => t.replay === 'success'), 'every replayed transaction ends as the original (the timestamp-bound one too)');
    ok(rep.unpriced.length === 1 && rep.unpriced[0] === O.toLowerCase(), 'the token without a price is listed as unpriced');
    ok(rep.evidenceHash === await ins.evidenceHash(key, rep.txHashes, BigInt(from), BigInt(to)), "evidenceHash = HackInsurance's");
    const c = run('c.json', ['--price-oracle', await oracle.getAddress(), '--native-asset', NATIVE]);
    ok(pick(c, 'loss') === pick(a, 'loss') && pick(c, 'reportHash') !== pick(a, 'reportHash'), 'on-chain prices: the same loss, another report (the pricing is in it)');

    // 4. claim and committee votes
    zetaphy(home('holder', DEV[1]), ['insurance', 'claim', '--insurance', I, '--cover', '0', '--report', join(work, 'a.json')]);
    for (const [n, k] of [['w1', DEV[4]], ['w2', DEV[5]]]) {
      const out = zetaphy(home(n, k), ['insurance', 'vote', '--insurance', I, '--claim', '0', '--report', join(work, 'a.json'), '--accept-explicit-prices']);
      console.log(out.trim().split('\n').map((l) => `    ${l}`).join('\n'));
    }
    ok((await ins.claims(0)).state === 2n, 'claim 0 (the same report): Approved by the two runners');
    const tampered = { ...rep, loss: (BigInt(rep.loss) + 1n).toString() };
    writeFileSync(join(work, 't.json'), JSON.stringify(tampered));
    zetaphy(home('holder'), ['insurance', 'claim', '--insurance', I, '--cover', '1', '--report', join(work, 't.json')]);
    for (const [n] of [['w1'], ['w2']]) {
      const out = zetaphy(home(n), ['insurance', 'vote', '--insurance', I, '--claim', '1', '--report', join(work, 'a.json'), '--accept-explicit-prices']);
      console.log(out.trim().split('\n').map((l) => `    ${l}`).join('\n'));
    }
    ok((await ins.claims(1)).state === 3n, 'claim 1 (a tampered loss): Rejected by the two runners');
    p.destroy();
    console.log('INSURANCE REPLAY E2E OK');
  } finally {
    chain.kill('SIGTERM');
    rmSync(work, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (e) => { console.error(e.stderr?.toString?.() || ''); console.error(e.message); process.exit(1); });
