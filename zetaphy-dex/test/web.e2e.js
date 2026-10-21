// Browser end-to-end test of the DEX page (zetaphy-dex/web/) in headless
// Chromium, served at the root under the CSP of web/vercel.json, with a mock
// EIP-6963 wallet and a mock JSON-RPC that is a real EVM (@ethereumjs/evm,
// chain id 77390) holding the real contracts: the DEX, test tokens, and Neuro's
// ThreatRegistry with one flagged and one enforced token.
//   npm run test:web     (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers, or ZDEX_CHROMIUM=<binary>)
// web.devnet.e2e.js runs the same scenario against a real zetaphyd devnet.

import { test } from 'node:test';
import { Address } from '@ethereumjs/util';
import { keccak256, toBeHex } from 'ethers';
import { createChain } from './helpers/evm.js';
import { setupDex, runScenario, ARTS } from './helpers/webscenario.js';

async function evmBackend() {
  const c = await createChain(['deployer', 'user', 'r1', 'r2', 'r3', 'r4'], {}, { chainId: 77390 });
  c.setTime(Math.floor(Date.now() / 1000));
  const addr = (n) => c.acct[n].toString();
  const receipts = new Map();
  let n = 0;
  const revert = (r) => Object.assign(new Error('execution reverted'), { code: 3, data: r.returnValue });
  const b = {
    name: 'in-memory EVM',
    deployer: addr('deployer'),
    user: addr('user'),
    runners: ['r1', 'r2', 'r3', 'r4'].map(addr),
    wnative: async () => (await c.deployRaw(ARTS.weth, [], 'deployer')).address,
    deploy: async (art, args) => (await c.deployRaw(art, args, 'deployer')).address,
    async tx(to, data, value = 0n) { const r = await c.rawSend(b.deployer, to, data, value); if (!r.ok) throw revert(r); },
    async txAs(from, to, data) { const r = await c.rawSend(from, to, data); if (!r.ok) throw revert(r); },
    async call(to, data) { const r = await c.staticCall(b.deployer, to, data); if (!r.ok) throw revert(r); return r.returnValue; },
    async walletSend(tx) {
      const r = await c.rawSend(tx.from, tx.to, tx.data, BigInt(tx.value ?? 0));
      const hash = keccak256(toBeHex(++n, 32));
      receipts.set(hash, { transactionHash: hash, status: r.ok ? '0x1' : '0x0', blockNumber: toBeHex(c.blockNumber()), gasUsed: toBeHex(r.gasUsed ?? 0n), logs: [] });
      return hash;
    },
    async rpc(method, params = []) {
      switch (method) {
        case 'eth_chainId': return '0x12e4e';
        case 'net_version': return '77390';
        case 'eth_blockNumber': return toBeHex(c.blockNumber());
        case 'eth_getBalance': return toBeHex(await c.balance(Address.fromString(params[0])));
        case 'eth_getCode': return c.code(params[0]);
        case 'eth_getStorageAt': return c.storageAt(params[0], params[1]);
        case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null;
        case 'eth_gasPrice': return '0x0';
        case 'eth_call': {
          const q = params[0];
          const r = await c.staticCall(q.from ?? '0x' + '00'.repeat(20), q.to, q.data ?? q.input ?? '0x', BigInt(q.value ?? 0));
          if (!r.ok) throw revert(r);
          return r.returnValue;
        }
        default: throw Object.assign(new Error(`mock RPC: ${method} not supported`), { code: -32601 });
      }
    },
  };
  return b;
}

test('the DEX page: connect, swap both ways, exact approvals, liquidity, Neuro warnings and refusals, token import (mock wallet + in-memory EVM)', { timeout: 300_000 }, async () => {
  const b = await evmBackend();
  const d = await setupDex(b);
  await runScenario(b, d, (m) => console.log(`  ${m}`));
});
