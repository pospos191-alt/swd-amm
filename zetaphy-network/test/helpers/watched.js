// Test-only contracts for the bridge monitor's watch list (never under contracts/,
// so they are not in the committed artifacts): compiled here with solc.
import { readFileSync } from 'node:fs';
import solc from 'solc';

let cache = null;
/** { WatchedEmitter, WatchedEmitterTopic2, Lure }: each { abi, bytecode }. */
export function watchedArtifacts() {
  if (cache) return cache;
  const src = (f) => ({ content: readFileSync(new URL(`./${f}`, import.meta.url), 'utf8') });
  const input = { language: 'Solidity', sources: { 'WatchedEmitter.sol': src('WatchedEmitter.sol'), 'Lure.sol': src('Lure.sol') },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const pick = (file, name) => ({ abi: out.contracts[file][name].abi, bytecode: '0x' + out.contracts[file][name].evm.bytecode.object });
  cache = { WatchedEmitter: pick('WatchedEmitter.sol', 'WatchedEmitter'), WatchedEmitterTopic2: pick('WatchedEmitter.sol', 'WatchedEmitterTopic2'), Lure: pick('Lure.sol', 'Lure') };
  return cache;
}
