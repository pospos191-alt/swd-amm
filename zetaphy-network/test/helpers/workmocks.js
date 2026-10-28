// Test-only contracts for the useful-work tests (helpers/WorkMocks.sol), compiled here with solc.
import { readFileSync } from 'node:fs';
import solc from 'solc';

let cache = null;
export function workMocks() {
  if (cache) return cache;
  const input = { language: 'Solidity', sources: { 'WorkMocks.sol': { content: readFileSync(new URL('./WorkMocks.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  cache = Object.fromEntries(Object.entries(out.contracts['WorkMocks.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return cache;
}
