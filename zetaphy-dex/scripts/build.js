// npm run build: compiles contracts/**/*.sol with solc 0.8.26 (the same
// settings as zetaphy-network/scripts/build.js) and writes artifacts/<Name>.json
// (abi, bytecode, and the standard-JSON input for explorer verification).
// The artifacts are committed, so cli.js and the tests need no compiler.
// contracts/test/*.sol are test-only contracts (never deployed by cli.js).
// `node scripts/build.js --check` compiles and compares with the committed
// artifacts instead of writing them (exit 1 if any differ): the artifacts are
// reproducible from the sources (test/build.test.js runs it).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import solc from 'solc';

const root = new URL('../', import.meta.url);
function walk(rel) {
  return readdirSync(new URL(rel, root)).flatMap((f) => {
    const p = `${rel}${f}`;
    return statSync(new URL(p, root)).isDirectory() ? walk(`${p}/`) : f.endsWith('.sol') ? [p] : [];
  });
}
const sources = Object.fromEntries(walk('contracts/').sort().map((p) => [p, { content: readFileSync(new URL(p, root), 'utf8') }]));
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
const check = process.argv.includes('--check');
const mismatches = [];
if (!check) mkdirSync(new URL('artifacts/', root), { recursive: true });
for (const [source, byName] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(byName)) {
    if (!c.evm.bytecode.object) continue; // interfaces
    const size = c.evm.deployedBytecode.object.length / 2;
    if (size > 24576) { console.error(`${name}: ${size} bytes, over the 24576-byte limit (EIP-170)`); process.exit(1); }
    const art = { contractName: name, sourceName: source, solcLongVersion: solc.version().replace(/\.Emscripten.*$/, ''),
      abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object, input };
    const file = new URL(`artifacts/${name}.json`, root);
    const text = JSON.stringify(art, null, 2) + '\n';
    if (check) {
      let committed = '';
      try { committed = readFileSync(file, 'utf8'); } catch { /* missing */ }
      if (committed !== text) mismatches.push(name);
      continue;
    }
    writeFileSync(file, text);
    console.log(`artifacts/${name}.json  ${size} bytes`);
  }
}
if (check) {
  if (mismatches.length) { console.error(`artifacts differ from a fresh build: ${mismatches.join(', ')} (run npm run build)`); process.exit(1); }
  console.log('artifacts match a fresh build');
}
