#!/usr/bin/env node
// Writes fork-tests/evmd/testdata/neuro-gbdt.json: Neuro's model as ZGB1 hex
// and test vectors (quantized features, expected bps from scoreInt), so the
// Go test checks the chain's evaluator against this exporter.
//   node zetaphy-chain/tools/gbdt-vectors.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { exportModel, scoreInt, quant } from './gbdt-export.mjs';

const root = new URL('../', import.meta.url);
const model = JSON.parse(readFileSync(new URL('../zetaphy-neuro/ml/model.json', root), 'utf8'));
const exp = exportModel(model);
let seed = 77390;
const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const th = model.features.map(() => [0, 1]);
for (const t of model.trees) for (let i = 0; i < t.length; i += 5) if (t[i] >= 0) th[t[i]].push(t[i + 1]);
const vectors = [];
for (let k = 0; k < 40; k++) {
  const x = th.map((ts) => ts[Math.floor(r() * ts.length)] * (0.5 + r()));
  vectors.push({ x: x.map(quant), bps: scoreInt(exp, x) });
}
vectors.push({ x: model.features.map(() => 0), bps: scoreInt(exp, model.features.map(() => 0)) });
const dir = new URL('fork-tests/evmd/testdata/', root);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('neuro-gbdt.json', dir), JSON.stringify({ model: Buffer.from(exp.bytes).toString('hex'), vectors }) + '\n');
console.log(`${vectors.length} vectors, model ${exp.bytes.length} bytes`);
