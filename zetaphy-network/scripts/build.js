// Compiles contracts/*.sol with solc 0.8.26 and writes artifacts/<Name>.json
// (abi, bytecode, and the standard-JSON input for explorer verification).
// The artifacts are committed so the CLI needs no compiler at runtime.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import solc from 'solc';

const dir = new URL('../contracts/', import.meta.url);
const sources = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.sol'))
  .map((f) => [`contracts/${f}`, { content: readFileSync(new URL(f, dir), 'utf8') }]));
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length) { console.error(errors.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
for (const w of (out.errors ?? []).filter((e) => e.severity === 'warning')) console.warn(w.formattedMessage);
mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
for (const [source, byName] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(byName)) {
    if (!c.evm.bytecode.object) continue; // interfaces
    const art = { contractName: name, sourceName: source, solcLongVersion: solc.version().replace(/\.Emscripten.*$/, ''),
      abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object, input };
    writeFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), JSON.stringify(art, null, 2) + '\n');
    console.log(`artifacts/${name}.json  ${(c.evm.deployedBytecode.object.length / 2)} bytes`);
  }
}
