#!/usr/bin/env node
// Packs a llama2.c checkpoint (legacy format) and its tokenizer.bin as a zllm/1
// file (ai/browser/llama.js: layer-major, so a pipeline stage downloads only its
// layers) and then as a verified chunk pack (scripts/build-model-pack.js):
// manifest.json, <sha256>.bin chunks, release.json for ModelRegistry.
//
//   node scripts/build-llm-pack.js --model model.bin --tokenizer tokenizer.bin --name zetaphy-docs-tiny \
//     --version 1 --license BUSL-1.1 [--chunk-size 65536] [--source "how it was made"] [--mirror …] [--out web/models/<name>/<version>]
//
// The repo's own model: scripts/llm/train-tiny-llama.py writes model.bin + tokenizer.bin.
// Karpathy's TinyStories checkpoints (MIT, huggingface.co/karpathy/tinyllamas: stories260K
// with tok512.bin, stories15M with llama2.c's tokenizer.bin) pack the same way; they are
// not in this repo (fetch them where huggingface.co is reachable; stories15M is 58 MiB).
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fromLlama2c, buildZllm, openModel, paramCount } from '../ai/browser/llama.js';
import { loadTokenizer } from '../ai/browser/tokenizer.js';
import { pack } from './build-model-pack.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));

export async function packLlm({ model, tokenizer, name, version = 1, license, chunkSize = 64 * 1024, source = '', mirrors = [], out }) {
  const ckpt = fromLlama2c(new Uint8Array(readFileSync(model)));
  const tok = new Uint8Array(readFileSync(tokenizer));
  loadTokenizer(tok, ckpt.config.vocabSize); // refuses a tokenizer that does not fit
  const zllm = buildZllm({ ...ckpt, tokenizer: tok, meta: { name, version, license, source, params: paramCount({ ...ckpt.config, sharedClassifier: !ckpt.classifier }) } });
  openModel(zllm); // reads back
  const dir = mkdtempSync(join(tmpdir(), 'zllm-'));
  try {
    const file = join(dir, `${name}.zllm`);
    writeFileSync(file, zllm);
    const r = await pack({ input: file, name, version, runtime: 'zllm/1', license, chunkSize, mirrors, out });
    return { ...r, config: ckpt.config, bytes: zllm.length };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = opt('name');
  const version = Number(opt('version', 1));
  const r = await packLlm({
    model: opt('model'), tokenizer: opt('tokenizer'), name, version, license: opt('license'),
    chunkSize: Number(opt('chunk-size', 64 * 1024)), source: opt('source', ''), mirrors: all('mirror'),
    out: opt('out', join('web', 'models', String(name), String(version))),
  });
  console.log(`${r.bytes} bytes, ${r.chunks} chunk(s), config ${JSON.stringify(r.config)}`);
  console.log(JSON.stringify(r.release, null, 2));
}
