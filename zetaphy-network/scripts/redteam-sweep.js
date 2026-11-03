// A standalone red-team sweep over the deliberately vulnerable demo targets (test/helpers/RedTeamDemo.sol), on a
// fresh in-memory fork each (src/redteam/fork.js). It is what the red-team GitHub workflow runs on a manual
// dispatch and what SS3's `zetaphy redteam scan` does against a certified contract. LOCAL FORKS ONLY; it never
// touches a live chain, a key or real money. Prints a line per target and exits non-zero only on an unexpected
// result (a bug the red team should always find was missed, or the safe bank reported a false positive).
import { readFileSync } from 'node:fs';
import { Interface, keccak256, toUtf8Bytes, getBytes, Wallet, Signature, AbiCoder, getAddress } from 'ethers';
import { createFork } from '../src/redteam/fork.js';
import { redTeam } from '../src/redteam/agent.js';
import { redTeamKit } from '../test/helpers/redteamkit.js';

const abi = AbiCoder.defaultAbiCoder();
const E = 10n ** 18n;
const kit = redTeamKit();
const dep = '0x00000000000000000000000000000000000d0d01';
const vic = '0x00000000000000000000000000000000000b1c71';
const I = (n) => new Interface(kit[n].abi);

async function fork() { const w = await createFork(); await w.setBalance(dep, 10n ** 24n); await w.setBalance(vic, 10n ** 24n); return w; }
async function deploy(w, n, args = [], v = 0n) { return w.deploy(dep, kit[n].bytecode + I(n).encodeDeploy(args).slice(2), v); }
const dexArt = (n) => JSON.parse(readFileSync(new URL(`../../zetaphy-dex/artifacts/${n}.json`, import.meta.url), 'utf8'));

async function run(name, build) {
  const w = await fork();
  const { target, opts } = await build(w);
  const t0 = Date.now();
  const res = await redTeam(w, { minLoss: 1n, ...opts, address: target }, { runs: 200, log: () => {} });
  const ms = Date.now() - t0;
  const line = res.findings.map((f) => `${f.strategy}(${f.kind === 'loss' ? `loss ${f.loss}` : f.invariant})`).join(', ') || 'none';
  console.log(`${name.padEnd(16)} ${res.stats.runs} runs, ${ms} ms -> ${line}`);
  return res;
}

let bad = 0;
const must = (res, name) => { if (!res.findings.length) { console.error(`FAIL: ${name}: the red team found nothing (expected a known bug)`); bad++; } };
const mustNot = (res, name) => { if (res.findings.length) { console.error(`FAIL: ${name}: a false positive`); bad++; } };

must(await run('ReentrantBank', async (w) => { const a = await deploy(w, 'ReentrantBank'); await w.tx(vic, a, I('ReentrantBank').encodeFunctionData('deposit'), 40n * E); return { target: a, opts: { abi: kit.ReentrantBank.abi } }; }), 'ReentrantBank');
must(await run('OpenOwnerVault', async (w) => { const a = await deploy(w, 'OpenOwnerVault', [], 50n * E); return { target: a, opts: { abi: kit.OpenOwnerVault.abi } }; }), 'OpenOwnerVault');
must(await run('RoundingVault', async (w) => { const a = await deploy(w, 'RoundingVault'); await w.tx(vic, a, I('RoundingVault').encodeFunctionData('deposit'), 100n); await w.tx(dep, a, I('RoundingVault').encodeFunctionData('harvest'), 100n * E); return { target: a, opts: { abi: kit.RoundingVault.abi } }; }), 'RoundingVault');
must(await run('SigVouchers', async (w) => {
  const sk = new Wallet(keccak256(toUtf8Bytes('sweep voucher signer')));
  const a = await deploy(w, 'SigVouchers', [sk.address], 50n * E);
  const amount = 5n * E;
  const data = I('SigVouchers').encodeFunctionData('claim', [amount, ...(() => { const s = Signature.from(sk.signMessageSync(getBytes(keccak256(abi.encode(['address', 'uint256'], [getAddress(a), amount]))))); return [s.v, s.r, s.s]; })()]);
  await w.tx(vic, a, data);
  return { target: a, opts: { abi: kit.SigVouchers.abi, history: [{ from: vic, to: a, data, value: 0 }] } };
}), 'SigVouchers');
mustNot(await run('SafeBank', async (w) => { const a = await deploy(w, 'SafeBank'); await w.tx(vic, a, I('SafeBank').encodeFunctionData('deposit'), 40n * E); return { target: a, opts: { abi: kit.SafeBank.abi } }; }), 'SafeBank');

if (bad) { console.error(`\n${bad} unexpected result(s)`); process.exit(1); }
console.log('\nRED TEAM SWEEP OK');
