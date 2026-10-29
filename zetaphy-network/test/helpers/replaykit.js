// helpers/ReplayKit.sol compiled with solc (like mocks.js): ReplayToken, ToyVault, RunnersStub, PriceStub, each { abi, bytecode }.
import { readFileSync } from 'node:fs';
import solc from 'solc';

let cache = null;
export function replayKit() {
  if (cache) return cache;
  const input = { language: 'Solidity', sources: { 'ReplayKit.sol': { content: readFileSync(new URL('./ReplayKit.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  cache = Object.fromEntries(Object.entries(out.contracts['ReplayKit.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return cache;
}
