#!/usr/bin/env node
// Writes (or checks) the committed head and manifest.
//
//   node ml/fl/manifest.js            # ml/fl/head.json (theta = 0 if missing or for another model) + ml/manifest.json
//   node ml/fl/manifest.js --check    # exit 1 unless both match ml/model.json byte for byte
//
// The manifest's sha256 is what governance schedules in the ModelEpochs
// (see docs/future/federated.md).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { checkModel } from '../model.js';
import { zeroHead, sealHead, checkHead } from './head.js';
import { buildManifest } from './registry.js';

const ML = new URL('../', import.meta.url);
const modelPath = new URL('model.json', ML);
const headPath = new URL('fl/head.json', ML);
const manifestPath = new URL('manifest.json', ML);

export async function currentManifest() {
  const modelBytes = readFileSync(modelPath);
  const model = checkModel(JSON.parse(modelBytes));
  const headBytes = readFileSync(headPath);
  const head = checkHead(model, JSON.parse(headBytes));
  return { model, head, ...(await buildManifest({ model, modelBytes, head, headBytes })) };
}

async function main() {
  const check = process.argv.includes('--check');
  if (!check) {
    const model = checkModel(JSON.parse(readFileSync(modelPath)));
    let head = existsSync(headPath) ? JSON.parse(readFileSync(headPath, 'utf8')) : null;
    if (!head || head.model !== model.id) {
      head = await sealHead(zeroHead(model));
      writeFileSync(headPath, JSON.stringify(head) + '\n');
    }
  }
  const { text, hash } = await currentManifest();
  if (check) {
    const committed = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
    if (committed !== text) { console.error('ml/manifest.json is stale: run node ml/fl/manifest.js'); process.exit(1); }
  } else writeFileSync(manifestPath, text);
  console.log(`manifest sha256 0x${hash}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
