// Test-only Hyperlane pieces (helpers/HyperlaneKit.sol, compiled here like mocks.js) and the
// checkpoint signing a Hyperlane validator does, so tests deliver messages through a Mailbox
// that checks a message-id multisig ISM, as on a real chain.
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { Wallet, keccak256, solidityPacked } from 'ethers';

let cache = null;
export function kitArtifacts() {
  if (cache) return cache;
  const input = { language: 'Solidity', sources: { 'HyperlaneKit.sol': { content: readFileSync(new URL('./HyperlaneKit.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  cache = Object.fromEntries(Object.entries(out.contracts['HyperlaneKit.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return cache;
}

/** The metadata a relayer hands a message-id multisig ISM (src/saphan.js). */
export { messageIdMetadata } from '../../src/saphan.js';

/** Fixed test validator keys (never used anywhere real). */
export const validator = (i) => new Wallet(keccak256(solidityPacked(['string', 'uint256'], ['saphan test validator', i])));
