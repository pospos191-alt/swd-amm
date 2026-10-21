// npm run build: compiles contracts/**/*.sol with solc 0.8.26 and writes
// artifacts/<Name>.json (abi, bytecode, and the standard-JSON input for
// explorer verification), like zetaphy-network/scripts/build.js. The artifacts
// are committed, so the CLI and the tests need no compile step.
// `node scripts/build.js --check` rebuilds in memory and fails if a committed
// artifact differs (CI: the artifacts match the sources).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.sol') ? [p] : [];
  }).sort();
}

export function compile(files, root = ROOT) {
  const sources = Object.fromEntries(files.map((f) => [relative(root, f).split('\\').join('/'), { content: readFileSync(f, 'utf8') }]));
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (p) => (existsSync(join(root, p)) ? { contents: readFileSync(join(root, p), 'utf8') } : { error: `not found: ${p}` }),
  }));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const warnings = (out.errors ?? []).filter((e) => e.severity === 'warning').map((e) => e.formattedMessage);
  const arts = {};
  for (const [source, byName] of Object.entries(out.contracts)) {
    for (const [name, c] of Object.entries(byName)) {
      if (!c.evm.bytecode.object) continue; // interfaces, abstract contracts
      arts[name] = { contractName: name, sourceName: source, solcLongVersion: solc.version().replace(/\.Emscripten.*$/, ''),
        abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object, input };
    }
  }
  return { arts, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { arts, warnings } = compile(walk(join(ROOT, 'contracts')));
  for (const w of warnings) console.warn(w);
  mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
  let stale = 0;
  for (const [name, art] of Object.entries(arts)) {
    const file = join(ROOT, 'artifacts', `${name}.json`);
    const text = JSON.stringify(art, null, 2) + '\n';
    const size = (art.deployedBytecode.length - 2) / 2;
    if (size > 24576) { console.error(`${name}: ${size} bytes is over the EIP-170 limit (24576)`); process.exit(1); }
    if (check) {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== text) { console.error(`artifacts/${name}.json is stale: run npm run build`); stale++; }
    } else {
      writeFileSync(file, text);
      console.log(`artifacts/${name}.json  ${size} bytes`);
    }
  }
  if (stale) process.exit(1);
  if (check) console.log('artifacts match the sources');
}
