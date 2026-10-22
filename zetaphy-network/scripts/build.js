// Compiles contracts/*.sol with solc 0.8.26 and writes artifacts/<Name>.json
// (abi, bytecode, and the standard-JSON input for explorer verification).
// The artifacts are committed so the CLI needs no compiler at runtime.
//
// Imports of "@openzeppelin/contracts/..." resolve ONLY to vendor/@openzeppelin/contracts/,
// a copy of exactly the files needed from the npm package @openzeppelin/contracts at the
// version pinned in vendor/openzeppelin-contracts.json (with the tarball's integrity and
// each file's sha256). The build refuses to run if a vendored file differs from its pinned
// hash or an import points anywhere else: no node_modules, no network, the same bytes on
// every machine. Contracts that import OpenZeppelin are compiled in their own unit, so the
// verification input of the other artifacts does not carry the OpenZeppelin sources.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import solc from 'solc';

const dir = new URL('../contracts/', import.meta.url);
const vendorRoot = new URL('../vendor/', import.meta.url);
const pin = JSON.parse(readFileSync(new URL('openzeppelin-contracts.json', vendorRoot), 'utf8'));
const OZ = '@openzeppelin/contracts/';

/** The vendored file for an import path, after checking its pinned sha256. */
function vendored(path) {
  if (!path.startsWith(OZ)) throw new Error(`import ${path}: only ${OZ}… (vendored) may be imported`);
  const rel = path.slice(OZ.length);
  const want = pin.files[rel];
  if (!want) throw new Error(`import ${path}: not in vendor/openzeppelin-contracts.json (vendor it from @openzeppelin/contracts@${pin.version} and pin its sha256)`);
  const file = new URL(`@openzeppelin/contracts/${rel}`, vendorRoot);
  if (!existsSync(file)) throw new Error(`import ${path}: vendor/@openzeppelin/contracts/${rel} is missing`);
  const content = readFileSync(file, 'utf8');
  const got = createHash('sha256').update(content).digest('hex');
  if (got !== want) throw new Error(`vendor/@openzeppelin/contracts/${rel}: sha256 ${got} is not the pinned ${want} (@openzeppelin/contracts@${pin.version})`);
  return content;
}

/** Every vendored file a source needs (its import closure), keyed as solc sees them. */
function closure(content, from, out) {
  for (const m of content.matchAll(/^\s*import\s+[^"']*["']([^"']+)["']/gm)) {
    let p = m[1];
    if (p.startsWith('.')) p = new URL(p, `file:///${from}`).pathname.slice(1);
    if (!p.startsWith(OZ)) throw new Error(`${from}: import ${m[1]}: contracts/ files import only ${OZ}… (vendored)`);
    if (out[p]) continue;
    out[p] = { content: vendored(p) };
    closure(out[p].content, p, out);
  }
  return out;
}

const all = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.sol')).sort()
  .map((f) => [`contracts/${f}`, { content: readFileSync(new URL(f, dir), 'utf8') }]));
const usesOz = (src) => /^\s*import\s/m.test(src.content);
const units = [
  Object.fromEntries(Object.entries(all).filter(([, s]) => !usesOz(s))),
  (() => {
    const own = Object.fromEntries(Object.entries(all).filter(([, s]) => usesOz(s)));
    const libs = {};
    for (const [k, s] of Object.entries(own)) closure(s.content, k, libs);
    return { ...own, ...Object.fromEntries(Object.entries(libs).sort(([a], [b]) => a.localeCompare(b))) };
  })(),
].filter((u) => Object.keys(u).length);

mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
let failed = false;
for (const sources of units) {
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: (p) => { try { return { contents: vendored(p) }; } catch (e) { return { error: e.message }; } } }));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) { console.error(errors.map((e) => e.formattedMessage).join('\n')); failed = true; continue; }
  for (const w of (out.errors ?? []).filter((e) => e.severity === 'warning')) console.warn(w.formattedMessage);
  for (const [source, byName] of Object.entries(out.contracts)) {
    if (!source.startsWith('contracts/')) continue; // vendored library code: no artifact of its own
    for (const [name, c] of Object.entries(byName)) {
      if (!c.evm.bytecode.object) continue; // interfaces
      const art = { contractName: name, sourceName: source, solcLongVersion: solc.version().replace(/\.Emscripten.*$/, ''),
        abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object, input };
      writeFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), JSON.stringify(art, null, 2) + '\n');
      console.log(`artifacts/${name}.json  ${(c.evm.deployedBytecode.object.length / 2)} bytes`);
    }
  }
}
if (failed) process.exit(1);
