// Test-only contracts for the forecast tests (helpers/MarketMocks.sol), compiled here like mocks.js.
import { readFileSync } from 'node:fs';
import solc from 'solc';

let cache = null;
/** { MockFlags }: each { abi, bytecode }. */
export function marketMocks() {
  if (cache) return cache;
  const input = { language: 'Solidity', sources: { 'MarketMocks.sol': { content: readFileSync(new URL('./MarketMocks.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  cache = Object.fromEntries(Object.entries(out.contracts['MarketMocks.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return cache;
}
