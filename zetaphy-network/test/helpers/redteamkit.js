// helpers/RedTeamDemo.sol compiled with solc (like replaykit.js): the red team's deliberately vulnerable demo
// targets, each { abi, bytecode }. Plus a fork source over an in-memory test chain (helpers/evm.js), so the red
// team and the runners fork the test chain exactly as they fork a testnet over JSON-RPC.
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { Address } from '@ethereumjs/util';

let cache = null;
export function redTeamKit() {
  if (cache) return cache;
  const input = { language: 'Solidity', sources: { 'RedTeamDemo.sol': { content: readFileSync(new URL('./RedTeamDemo.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  cache = Object.fromEntries(Object.entries(out.contracts['RedTeamDemo.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return cache;
}

/** A fork source (src/redteam/fork.js) reading the chain's CURRENT state, reported as block `blockNumber`. */
export function chainSource(chain, { chainId = 31337, blockNumber } = {}) {
  const A = (a) => Address.fromString(a);
  return {
    chainId, blockNumber: Number(blockNumber ?? chain.blockNumber() - 1n), timestamp: Number(chain.now()),
    getBalance: async (a) => '0x' + (await chain.balance(A(a))).toString(16),
    getNonce: async (a) => '0x' + (await chain.nonce(A(a))).toString(16),
    getCode: (a) => chain.getCode(a),
    getStorage: (a, slot) => chain.getStorage(a, slot),
  };
}
