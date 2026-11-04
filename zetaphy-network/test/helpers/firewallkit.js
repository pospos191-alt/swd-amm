// helpers/FirewallKit.sol (with contracts/Firewalled.sol and contracts/CircuitBreakable.sol) compiled with solc,
// like selfhealkit.js: FwVault, PlainVault, SolvencyInvariant, ModeInvariant, FwAttacker, FwSmartWallet,
// MockCertificates, each { abi, bytecode }. The vault's and the attacker's ABIs also carry InvariantFirewall's
// errors, so a violation that bubbles up through them is decoded by name.
import { readFileSync } from 'node:fs';
import solc from 'solc';

let cache = null;
export function firewallKit() {
  if (cache) return cache;
  const src = (u) => ({ content: readFileSync(new URL(u, import.meta.url), 'utf8') });
  const input = {
    language: 'Solidity',
    sources: {
      'test/helpers/FirewallKit.sol': src('./FirewallKit.sol'),
      'contracts/Firewalled.sol': src('../../contracts/Firewalled.sol'),
      'contracts/CircuitBreakable.sol': src('../../contracts/CircuitBreakable.sol'),
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const fwErrors = JSON.parse(readFileSync(new URL('../../artifacts/InvariantFirewall.json', import.meta.url), 'utf8')).abi.filter((x) => x.type === 'error');
  cache = Object.fromEntries(Object.entries(out.contracts['test/helpers/FirewallKit.sol']).map(([n, c]) => {
    const abi = ['FwVault', 'FwAttacker', 'FwSmartWallet'].includes(n) ? [...c.abi, ...fwErrors.filter((e) => !c.abi.some((x) => x.type === 'error' && x.name === e.name))] : c.abi;
    return [n, { abi, bytecode: '0x' + c.evm.bytecode.object }];
  }));
  return cache;
}
