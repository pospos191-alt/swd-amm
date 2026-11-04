// Compiles the red team's attack contract (src/redteam/RedTeamAttacker.sol) with solc 0.8.26 into
// src/redteam/attacker.json ({ abi, bytecode }), so the agent needs no compiler at runtime.
// It is a local-fork tool, not a ZETAPHY contract: it is kept out of contracts/ (and out of the audit scope).
// `node scripts/build-redteam.js --check` fails when the committed JSON differs from a fresh compile.
import { readFileSync, writeFileSync } from 'node:fs';
import solc from 'solc';

const src = new URL('../src/redteam/RedTeamAttacker.sol', import.meta.url);
const out = new URL('../src/redteam/attacker.json', import.meta.url);

export function compileAttacker() {
  const input = { language: 'Solidity', sources: { 'RedTeamAttacker.sol': { content: readFileSync(src, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const res = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (res.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const c = res.contracts['RedTeamAttacker.sol'].RedTeamAttacker;
  return JSON.stringify({ contractName: 'RedTeamAttacker', solc: solc.version().replace(/\.Emscripten.*$/, ''), abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2) + '\n';
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const fresh = compileAttacker();
  if (process.argv.includes('--check')) {
    if (readFileSync(out, 'utf8') !== fresh) { console.error('src/redteam/attacker.json is stale: run node scripts/build-redteam.js'); process.exit(1); }
    console.log('src/redteam/attacker.json is up to date');
  } else {
    writeFileSync(out, fresh);
    console.log('wrote src/redteam/attacker.json');
  }
}
