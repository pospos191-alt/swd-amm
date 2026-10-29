// Test-only contracts (helpers/OracleMocks.sol), compiled here with solc like watched.js:
// MockPyth, MockPriceOracle, SameBlockAttacker, Caller. Each { abi, bytecode }.
import { readFileSync } from 'node:fs';
import solc from 'solc';

let cache = null;
export function mockArtifacts() {
  if (cache) return cache;
  const input = { language: 'Solidity', sources: { 'OracleMocks.sol': { content: readFileSync(new URL('./OracleMocks.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  cache = Object.fromEntries(Object.entries(out.contracts['OracleMocks.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return cache;
}

/** zetaphy-dex's committed artifacts (the real pair, factory and test token). */
export const dexArt = (n) => JSON.parse(readFileSync(new URL(`../../../zetaphy-dex/artifacts/${n}.json`, import.meta.url), 'utf8'));

/** helpers/AgentKit.sol (ShareVault, Drainer, Sink, MockBridge), each { abi, bytecode }. */
let kit = null;
export function agentKit() {
  if (kit) return kit;
  const input = { language: 'Solidity', sources: { 'AgentKit.sol': { content: readFileSync(new URL('./AgentKit.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  kit = Object.fromEntries(Object.entries(out.contracts['AgentKit.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return kit;
}
