#!/usr/bin/env node
// Packs a file (model weights, skill bundle, prompt pack, rule set) for verified
// distribution (ai/browser/manifest.js): cuts it into chunks, writes
// <out>/manifest.json and <out>/<sha256>.bin per chunk, and <out>/release.json
// (what ModelRegistry must hold for it). Upload <out>/ as is to any mirror:
// this site (web/models/…), a GitHub Release (every file as an asset), or IPFS
// (`ipfs add -r <out>`, then a gateway URL …/ipfs/<cid>/{hash}.bin).
//
//   node scripts/build-model-pack.js --in ml/model.json --name neuro-ml-gbdt --version 1 \
//     --runtime neuro-ml-gbdt/1 --license BUSL-1.1 [--kind model] [--chunk-size 4194304] \
//     [--mirror https://github.com/<o>/<r>/releases/download/<tag>/{hash}.bin ...] [--out web/models/<name>/<version>]
//
// Then put it on chain (testnet), through the timelock:
//   node ../zetaphy-network/scripts/model-registry.js propose --registry 0x… --release <out>/release.json --author 0x… [--timelock 0x…]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest, DEFAULT_CHUNK_SIZE } from '../ai/browser/manifest.js';
import { registryId } from '../ai/browser/registry.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));

export async function pack({ input, name, version, runtime, license, kind = 'model', chunkSize = DEFAULT_CHUNK_SIZE, mirrors = [], out }) {
  const bytes = new Uint8Array(readFileSync(input));
  const extra = mirrors.map((chunk, i) => ({ label: `mirror-${i + 1}`, chunk }));
  // this site serves the chunks next to the manifest
  const built = await buildManifest(bytes, { kind, name, version, runtime, license, chunkSize, mirrors: [{ label: 'same-site', chunk: './{hash}.bin' }, ...extra] });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), built.bytes);
  for (const c of built.chunks) writeFileSync(join(out, `${c.hash}.bin`), c.data);
  const release = {
    note: 'What ModelRegistry must hold for this pack. Until a registry is deployed and this release published there through the timelock, a page may only use it as a release PINNED in its own code (same trust as the page).',
    registryId: registryId(kind, name), kind, name, version,
    manifestHash: '0x' + built.manifestHash, chunkRoot: '0x' + built.manifest.root,
    size: built.manifest.size, chunkSize: built.manifest.chunkSize, license, runtime,
  };
  writeFileSync(join(out, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  return { release, chunks: built.chunks.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = opt('name');
  const version = Number(opt('version', 1));
  const r = await pack({
    input: opt('in'), name, version, runtime: opt('runtime'), license: opt('license'), kind: opt('kind', 'model'),
    chunkSize: Number(opt('chunk-size', DEFAULT_CHUNK_SIZE)), mirrors: all('mirror'),
    out: opt('out', join('web', 'models', String(name), String(version))),
  });
  console.log(`${r.chunks} chunk(s)`);
  console.log(JSON.stringify(r.release, null, 2));
}
