#!/usr/bin/env node
// node tools/vendor-snarkjs.mjs: copies snarkjs' browser bundle (build/snarkjs.min.js, GPL-3.0, iden3) for the zkML
// ceremony page (ceremony.html) from the zk package's npm install (zetaphy-neuro/ml/onchain/zk: `npm ci`, which
// checks the tarball's integrity from its package-lock.json), so the browser and the CLI / CI verifier run the very
// same pinned snarkjs. Writes vendor/snarkjs.min.js and vendor/snarkjs.json (version, tarball integrity, sha256 of
// the file); test/ceremony.test.mjs checks the file against that pin. Served from the site's own origin, no CDN.
//   node tools/vendor-snarkjs.mjs           write
//   node tools/vendor-snarkjs.mjs --check   only compare (exit 1 when they differ)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HUB = fileURLToPath(new URL('..', import.meta.url));
const ZK = fileURLToPath(new URL('../../zetaphy-neuro/ml/onchain/zk/', import.meta.url));

export function source() {
  const pin = JSON.parse(readFileSync(`${ZK}package.json`, 'utf8')).devDependencies.snarkjs;
  const lock = JSON.parse(readFileSync(`${ZK}package-lock.json`, 'utf8')).packages['node_modules/snarkjs'];
  if (lock.version !== pin) throw new Error(`zk package-lock has snarkjs ${lock.version}, package.json pins ${pin}`);
  const file = `${ZK}node_modules/snarkjs/build/snarkjs.min.js`;
  if (!existsSync(file)) throw new Error(`run npm ci in ${ZK} first`);
  const installed = JSON.parse(readFileSync(`${ZK}node_modules/snarkjs/package.json`, 'utf8')).version;
  if (installed !== pin) throw new Error(`installed snarkjs ${installed} is not the pinned ${pin}: npm ci`);
  const bytes = readFileSync(file);
  return { bytes, meta: { package: 'snarkjs', version: pin, license: 'GPL-3.0', file: 'build/snarkjs.min.js', integrity: lock.integrity, resolved: lock.resolved, sha256: createHash('sha256').update(bytes).digest('hex') } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { bytes, meta } = source();
  if (process.argv.includes('--check')) {
    const same = existsSync(`${HUB}vendor/snarkjs.min.js`) && readFileSync(`${HUB}vendor/snarkjs.min.js`).equals(bytes);
    console.log(same ? `vendor/snarkjs.min.js = snarkjs ${meta.version}` : 'vendor/snarkjs.min.js differs from the pinned snarkjs');
    process.exit(same ? 0 : 1);
  }
  writeFileSync(`${HUB}vendor/snarkjs.min.js`, bytes);
  writeFileSync(`${HUB}vendor/snarkjs.json`, JSON.stringify(meta, null, 2) + '\n');
  console.log(`vendor/snarkjs.min.js: snarkjs ${meta.version}, ${bytes.length} bytes, sha256 ${meta.sha256}`);
}
