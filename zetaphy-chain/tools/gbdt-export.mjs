#!/usr/bin/env node
// Converts Neuro's learned model (zetaphy-neuro/ml/model.json, "neuro-ml-gbdt/1",
// floats) into the integer "ZGB1" model the AI precompile (0x…0902) runs,
// as hex for `zetaphyd tx security-proposal ai-model <file>`.
//
//   node zetaphy-chain/tools/gbdt-export.mjs [model.json] > model.hex
//
// Integers: features and thresholds are floor(x × 1e4) (int32, clamped),
// leaves and base are logits × 1e4 with the Platt calibration folded in
// (a·z + b). A row can take another branch than the float model only when a
// feature lies within 1e-4 of a threshold. scoreInt below is the chain's
// algorithm, byte for byte (evmd/zetaphy_aimodel.go).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCALE = 1e4;
const I32 = 2 ** 31;
const clamp32 = (v) => Math.max(-I32, Math.min(I32 - 1, v));
export const quant = (x) => clamp32(Math.floor(x * SCALE));

const SIGMOID = [3, 4, 6, 7, 9, 12, 15, 19, 25, 32, 41, 52, 67, 86, 110, 141, 180, 230, 293, 373, 474, 601, 759, 953,
  1192, 1480, 1824, 2227, 2689, 3208, 3775, 4378, 5000, 5622, 6225, 6792, 7311, 7773, 8176, 8520, 8808, 9047, 9241, 9399, 9526,
  9627, 9707, 9770, 9820, 9859, 9890, 9914, 9933, 9948, 9959, 9968, 9975, 9981, 9985, 9988, 9991, 9993, 9994, 9996, 9997];

/** The chain's integer sigmoid: logit × 1e4 -> basis points. */
export function sigmoidBps(z) {
  const step = 2500;
  if (z <= -32 * step) return 0;
  if (z >= 32 * step) return 10000;
  const u = z + 32 * step;
  const i = Math.floor(u / step);
  const r = u % step;
  return SIGMOID[i] + Math.trunc(((SIGMOID[i + 1] - SIGMOID[i]) * r) / step);
}

/** model.json -> {bytes: Uint8Array, base, trees: [[{f, th, l, r, v}]], features} */
export function exportModel(model) {
  if (model?.format !== 'neuro-ml-gbdt/1') throw new Error('unsupported model format');
  const a = model.calib?.a ?? 1;
  const b = model.calib?.b ?? 0;
  const features = model.features.length;
  if (features > 1024 || model.trees.length > 512) throw new Error('model too large for the chain');
  const base = clamp32(Math.round((a * model.base + b) * SCALE));
  const trees = model.trees.map((t) => {
    const n = t.length / 5;
    if (n > 255) throw new Error('a tree has more than 255 nodes');
    const out = [];
    for (let i = 0; i < n; i++) {
      const [f, th, l, r, v] = t.slice(i * 5, i * 5 + 5);
      if (f < 0) out.push({ f: 0xffff, th: 0, l: 0, r: 0, v: clamp32(Math.round(a * v * SCALE)) });
      else {
        if (!(l > i && r > i)) throw new Error('children must follow their node');
        out.push({ f, th: quant(th), l, r, v: 0 });
      }
    }
    return out;
  });
  const size = 12 + trees.reduce((s, t) => s + 2 + 14 * t.length, 0);
  if (size > 65536) throw new Error(`model is ${size} bytes; the chain takes 65536`);
  const buf = new DataView(new ArrayBuffer(size));
  [...'ZGB1'].forEach((c, i) => buf.setUint8(i, c.charCodeAt(0)));
  buf.setUint16(4, features);
  buf.setUint16(6, trees.length);
  buf.setInt32(8, base);
  let p = 12;
  for (const t of trees) {
    buf.setUint16(p, t.length);
    p += 2;
    for (const n of t) {
      buf.setUint16(p, n.f);
      buf.setInt32(p + 2, n.th);
      buf.setUint16(p + 6, n.l);
      buf.setUint16(p + 8, n.r);
      buf.setInt32(p + 10, n.v);
      p += 14;
    }
  }
  return { bytes: new Uint8Array(buf.buffer), base, trees, features };
}

/** Score a float feature vector the way the chain does (after quant). */
export function scoreInt(exp, x) {
  const q = x.map(quant);
  let z = exp.base;
  for (const t of exp.trees) {
    let i = 0;
    while (t[i].f !== 0xffff) i = q[t[i].f] <= t[i].th ? t[i].l : t[i].r;
    z += t[i].v;
  }
  return sigmoidBps(z);
}

/** The int32 big-endian feature bytes for score(bytes). */
export function featureBytes(x) {
  const dv = new DataView(new ArrayBuffer(4 * x.length));
  x.forEach((v, i) => dv.setInt32(4 * i, quant(v)));
  return new Uint8Array(dv.buffer);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? new URL('../../zetaphy-neuro/ml/model.json', import.meta.url);
  const exp = exportModel(JSON.parse(readFileSync(path, 'utf8')));
  process.stdout.write(Buffer.from(exp.bytes).toString('hex') + '\n');
  process.stderr.write(`ZGB1: ${exp.features} features, ${exp.trees.length} trees, ${exp.bytes.length} bytes\n`);
}
