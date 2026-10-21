// The DEX page's browser scenario (helpers/webscenario.js) against a real
// ZETAPHY chain: a throwaway zetaphyd devnet (zetaphy-network/scripts/devnet.sh),
// the native ERC-20 precompile as WETH, real blocks and gas. The page's RPC
// requests are forwarded to the devnet; the mock wallet signs with a test key
// in Node (ethers) and sends to the devnet.
// Needs zetaphyd (ZETAPHYD=…). On shared machines:
//   flock /tmp/ci-test/devnet.lock npm run test:web:devnet
// Ports: ZDEX_DEVNET_PORT (default 24545) and the next ~110.

import { test, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, ContractFactory, NonceManager } from 'ethers';
import { setupDex, runScenario } from './helpers/webscenario.js';

const PORT = Number(process.env.ZDEX_DEVNET_PORT ?? 24545);
const RPC = `http://127.0.0.1:${PORT}`;
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-dex-web-devnet-'));
const actors = Object.fromEntries(['deployer', 'user', 'r1', 'r2', 'r3', 'r4'].map((n) => [n, Wallet.createRandom()]));
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
let provider;

before(() => {
  execFileSync(new URL('../../zetaphy-network/scripts/devnet.sh', import.meta.url).pathname,
    [join(root, 'chain'), String(PORT), ...Object.values(actors).map((w) => w.address)],
    { stdio: 'inherit', env: { ...env, COSMOS_CHAIN_ID: 'zetaphy_77390-1' } });
  provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: false, polling: true, pollingInterval: 500 });
});
after(() => { try { process.kill(Number(readFileSync(join(root, 'chain', 'node.pid'), 'utf8'))); } catch {} });

let rpcId = 0;
async function rawRpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
  return j.result;
}

function devnetBackend() {
  const signers = Object.fromEntries(Object.entries(actors).map(([n, w]) => [n, new NonceManager(w.connect(provider))]));
  const byAddress = Object.fromEntries(Object.entries(actors).map(([n, w]) => [w.address.toLowerCase(), signers[n]]));
  const send = async (s, to, data, value = 0n) => {
    const r = await (await s.sendTransaction({ to, data, value })).wait();
    if (r.status !== 1) throw new Error(`tx to ${to} failed`);
  };
  return {
    name: 'zetaphyd devnet',
    deployer: actors.deployer.address,
    user: actors.user.address,
    runners: ['r1', 'r2', 'r3', 'r4'].map((n) => actors[n].address),
    wnative: async () => NATIVE,
    async deploy(art, args) {
      const k = await new ContractFactory(art.abi, art.bytecode, signers.deployer).deploy(...args);
      await k.waitForDeployment();
      return k.getAddress();
    },
    tx: (to, data, value) => send(signers.deployer, to, data, value),
    txAs: (from, to, data) => send(byAddress[from.toLowerCase()], to, data),
    call: (to, data) => provider.call({ to, data, from: actors.deployer.address }),
    rpc: rawRpc,
    async walletSend(tx) {
      const s = signers.user;
      const sent = await s.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) });
      return sent.hash;
    },
  };
}

test('the DEX page on a real ZETAPHY devnet: connect, swap native <-> tUSD, liquidity, Neuro, token import', { timeout: 900_000 }, async () => {
  const b = devnetBackend();
  const d = await setupDex(b);
  console.log(`  DEX on devnet: router ${d.router}, WETH = native precompile ${d.wnative}`);
  await runScenario(b, d, (m) => console.log(`  ${m}`));
});
