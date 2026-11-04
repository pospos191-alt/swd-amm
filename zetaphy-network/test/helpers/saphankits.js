// Test-only Solidity kits for the Saphan PR 6 tests, compiled once per process from test/helpers/*.sol
// (TokenKit.sol: KitToken; SafetyKit.sol: KitBtcClient, KitRunners).
import { readFileSync } from 'node:fs';
import solc from 'solc';

const cache = {};
export function kit(file) {
  if (cache[file]) return cache[file];
  const input = { language: 'Solidity', sources: { [file]: { content: readFileSync(new URL(`./${file}`, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  cache[file] = Object.fromEntries(Object.entries(out.contracts[file]).map(([n, x]) => [n, { abi: x.abi, bytecode: '0x' + x.evm.bytecode.object }]));
  return cache[file];
}

/** A built artifact's abi with the custom errors of other artifacts (so a nested revert decodes by name). */
export function withErrors(art, ...others) {
  return { abi: [...art.abi, ...others.flatMap((o) => o.abi.filter((f) => f.type === 'error'))], bytecode: art.bytecode };
}
