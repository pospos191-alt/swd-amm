// helpers/SelfHealKit.sol (with contracts/CircuitBreakable.sol) compiled with solc, like replaykit.js:
// HealVault, HealAttacker, HealSmartWallet, HealFeed, each { abi, bytecode }.
import { readFileSync } from 'node:fs';
import solc from 'solc';

let cache = null;
export function selfHealKit() {
  if (cache) return cache;
  const src = (u) => ({ content: readFileSync(new URL(u, import.meta.url), 'utf8') });
  const input = { language: 'Solidity', sources: { 'test/helpers/SelfHealKit.sol': src('./SelfHealKit.sol'), 'contracts/CircuitBreakable.sol': src('../../contracts/CircuitBreakable.sol') },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  cache = Object.fromEntries(Object.entries(out.contracts['test/helpers/SelfHealKit.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return cache;
}
