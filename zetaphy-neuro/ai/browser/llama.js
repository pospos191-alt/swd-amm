// A small Llama-architecture language model in plain JavaScript (no WASM, no
// WebGPU, no dependency), built to be cut into layer ranges that run in
// different browsers (ai/browser/pipeline.js: serveLlmStage / remoteLlmStage).
//
// Architecture = Karpathy's llama2.c (MIT): RMSNorm, rotary position embedding,
// grouped-query attention, SwiGLU feed-forward, KV cache, classifier tied to the
// token embedding or separate. Any llama2.c "legacy" checkpoint converts with
// fromLlama2c() (e.g. Karpathy's stories260K / stories15M), and the repo ships
// one model trained here (scripts/llm/train-tiny-llama.py, web/models/…).
//
// File format "zllm/1" (what the verified loader distributes; layer-major so a
// peer that serves layers [from, to) downloads only the chunks holding them):
//   u32 LE header length | header JSON | zero padding to a multiple of 64 = base
//   then sections at base + offset (each padded to 64 bytes):
//     tokenizer (llama2.c tokenizer.bin bytes), embedding (vocab x dim f32),
//     finalNorm (dim), classifier (vocab x dim, only if not shared),
//     layer 0 … layer L-1, each: attNorm, wq, wk, wv, wo, ffnNorm, w1, w2, w3 (f32 LE, row-major [out][in])
//
// Same bits everywhere: weights and activations are float32, every dot product
// is summed in float64 in a fixed order, and exp / sin / cos / pow come from
// ./detmath.js (only IEEE-exact operations), so running layers [0, 3) here and
// [3, 6) in another browser gives exactly the bits of running all six in one place,
// in any engine. Against llama2.c's C code (float sums, libm) the logits agree
// closely but not bit for bit (test/llm.test.js has the measured bound).

import { dexp, dsincos, dpow } from './detmath.js';

export const FORMAT = 'zllm/1';
export const BOS = 1;
export const EOS = 2;
export const TENSORS = ['attNorm', 'wq', 'wk', 'wv', 'wo', 'ffnNorm', 'w1', 'w2', 'w3'];
const ALIGN = 64;
const pad = (n) => Math.ceil(n / ALIGN) * ALIGN;
if (new Uint8Array(new Float32Array([1]).buffer)[3] !== 0x3f) throw new Error('big-endian platform: zllm/1 is little-endian');

/** Validates a model config; returns derived sizes. */
export function checkConfig(c) {
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!c || !int(c.dim, 2, 16384) || !int(c.hiddenDim, 1, 65536) || !int(c.nLayers, 1, 512) || !int(c.nHeads, 1, 512)
    || !int(c.nKvHeads, 1, 512) || !int(c.vocabSize, 3, 1 << 20) || !int(c.seqLen, 1, 1 << 16)) throw new Error('bad model config');
  if (c.dim % c.nHeads || c.nHeads % c.nKvHeads || (c.dim / c.nHeads) % 2) throw new Error('bad model config: heads');
  const headSize = c.dim / c.nHeads;
  const kvDim = c.nKvHeads * headSize;
  const sizes = { attNorm: c.dim, wq: c.dim * c.dim, wk: kvDim * c.dim, wv: kvDim * c.dim, wo: c.dim * c.dim, ffnNorm: c.dim, w1: c.hiddenDim * c.dim, w2: c.dim * c.hiddenDim, w3: c.hiddenDim * c.dim };
  const layerFloats = TENSORS.reduce((s, t) => s + sizes[t], 0);
  return { headSize, kvDim, sizes, layerFloats, kvMul: c.nHeads / c.nKvHeads };
}

/** Parameter count (embedding + final norm + layers + a separate classifier). */
export function paramCount(c) {
  const { layerFloats } = checkConfig(c);
  return c.vocabSize * c.dim * (c.sharedClassifier === false ? 2 : 1) + c.dim + c.nLayers * layerFloats;
}

// ---------------------------------------------------------------- building / converting

/** Writes a zllm/1 file. layers: [{attNorm, wq, …, w3}] Float32Arrays; tokenizer: Uint8Array (llama2.c tokenizer.bin). */
export function buildZllm({ config, embedding, finalNorm, classifier = null, layers, tokenizer, meta = {} }) {
  const c = {
    dim: config.dim, hiddenDim: config.hiddenDim, nLayers: config.nLayers, nHeads: config.nHeads, nKvHeads: config.nKvHeads,
    vocabSize: config.vocabSize, seqLen: config.seqLen, sharedClassifier: !classifier, normEps: config.normEps ?? 1e-5, ropeTheta: config.ropeTheta ?? 10000,
  };
  const { sizes } = checkConfig(c);
  if (layers.length !== c.nLayers) throw new Error('layer count');
  const sections = {};
  let off = 0;
  const parts = [];
  const add = (name, bytes) => { sections[name] = [off, bytes.length]; parts.push([off, bytes]); off += pad(bytes.length); };
  const fb = (a, n, what) => { if (!(a instanceof Float32Array) || a.length !== n) throw new Error(`${what}: expected ${n} floats`); return new Uint8Array(a.buffer, a.byteOffset, a.byteLength); };
  add('tokenizer', tokenizer);
  add('embedding', fb(embedding, c.vocabSize * c.dim, 'embedding'));
  add('finalNorm', fb(finalNorm, c.dim, 'finalNorm'));
  if (classifier) add('classifier', fb(classifier, c.vocabSize * c.dim, 'classifier'));
  sections.layers = layers.map((L, i) => {
    const start = off;
    let len = 0;
    for (const t of TENSORS) { const b = fb(L[t], sizes[t], `layer ${i} ${t}`); parts.push([off + len, b]); len += b.length; }
    off += pad(len);
    return [start, len];
  });
  const head = new TextEncoder().encode(JSON.stringify({ format: FORMAT, arch: 'llama2', config: c, sections, meta }));
  const base = pad(4 + head.length);
  const out = new Uint8Array(base + off);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  for (const [o, b] of parts) out.set(b, base + o);
  return out;
}

/** Reads a llama2.c legacy checkpoint (run.c's format): {config, embedding, finalNorm, classifier, layers}. */
export function fromLlama2c(bin) {
  const v = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  if (bin.length < 28) throw new Error('not a llama2.c checkpoint');
  const [dim, hiddenDim, nLayers, nHeads, nKvHeads, vocabRaw, seqLen] = Array.from({ length: 7 }, (_, i) => v.getInt32(i * 4, true));
  if (dim === 0x616b3432) throw new Error('llama2.c versioned export (ak42): export it with --version 0 (legacy) first');
  const config = { dim, hiddenDim, nLayers, nHeads, nKvHeads, vocabSize: Math.abs(vocabRaw), seqLen };
  const { sizes, headSize } = checkConfig(config);
  let o = 28;
  const take = (n) => {
    if (o + n * 4 > bin.length) throw new Error('llama2.c checkpoint is truncated');
    const a = new Float32Array(bin.slice(o, o + n * 4).buffer); o += n * 4; return a;
  };
  const embedding = take(config.vocabSize * dim);
  const per = {};
  for (const t of TENSORS) per[t] = Array.from({ length: nLayers }, () => take(sizes[t]));
  const finalNorm = take(dim);
  o += (seqLen * headSize / 2) * 4 * 2; // legacy freq_cis_real / freq_cis_imag (unused, as in run.c)
  const classifier = vocabRaw > 0 ? null : take(config.vocabSize * dim);
  if (o !== bin.length) throw new Error(`llama2.c checkpoint: ${bin.length - o} unexpected trailing bytes`);
  const layers = Array.from({ length: nLayers }, (_, l) => Object.fromEntries(TENSORS.map((t) => [t, per[t][l]])));
  return { config, embedding, finalNorm, classifier, layers };
}

/** An opened model (openModel, all layers + head) -> llama2.c legacy checkpoint bytes, to run with llama2.c's run.c. */
export function toLlama2c(model) {
  const c = model.config;
  const { headSize } = checkConfig(c);
  const separate = !c.sharedClassifier;
  const floats = [model.embedding, ...TENSORS.flatMap((t) => model.layers.map((L) => L[t])), model.finalNorm,
    new Float32Array(c.seqLen * headSize), ...(separate ? [model.classifier] : [])];
  const n = floats.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(28 + n * 4);
  const v = new DataView(out.buffer);
  [c.dim, c.hiddenDim, c.nLayers, c.nHeads, c.nKvHeads, separate ? -c.vocabSize : c.vocabSize, c.seqLen].forEach((x, i) => v.setInt32(i * 4, x, true));
  let o = 28;
  for (const a of floats) { out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o); o += a.byteLength; }
  return out;
}

function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

/**
 * A model with the real architecture and random weights (seeded): same file
 * format and code path as a trained one, for tests and benchmarks. Its tokenizer
 * has byte fallback, printable ASCII and a few pieces.
 */
export function makeRandomLlama(config, seed = 1) {
  const c = { normEps: 1e-5, ropeTheta: 10000, ...config };
  const { sizes } = checkConfig(c);
  const r = xorshift(seed);
  const rnd = (n, scale) => new Float32Array(n).map(() => (r() * 2 - 1) * scale);
  const norm = (n) => new Float32Array(n).map(() => 1 + (r() * 2 - 1) * 0.1);
  const s = 1 / Math.sqrt(c.dim);
  const layers = Array.from({ length: c.nLayers }, () => {
    const L = {};
    for (const t of TENSORS) L[t] = t.endsWith('Norm') ? norm(sizes[t]) : rnd(sizes[t], t === 'w2' ? 1 / Math.sqrt(c.hiddenDim) : s);
    return L;
  });
  const embedding = rnd(c.vocabSize * c.dim, 1);
  const classifier = c.sharedClassifier === false ? rnd(c.vocabSize * c.dim, s) : null;
  return buildZllm({ config: c, embedding, finalNorm: norm(c.dim), classifier, layers, tokenizer: makeSimpleTokenizer(c.vocabSize), meta: { name: 'random', seed } });
}

/** A llama2.c tokenizer.bin with byte fallback, printable ASCII and a few pieces (for generated models). */
export function makeSimpleTokenizer(vocabSize) {
  const pieces = ['<unk>', '\n<s>\n', '\n</s>\n'];
  for (let b = 0; b < 256; b++) pieces.push(`<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`);
  if (vocabSize < pieces.length) throw new Error('vocabSize too small for a byte-fallback tokenizer (needs >= 259)');
  for (let ch = 32; ch < 127 && pieces.length < vocabSize; ch++) pieces.push(String.fromCharCode(ch));
  const merges = [' t', 'he', ' the', ' a', 'in', 'er', 'on', ' o', ' of', 'ed', 'ing', ' an', ' and'];
  const rank = new Map();
  for (const w of merges) if (pieces.length < vocabSize) { rank.set(pieces.length, -rank.size); pieces.push(w); }
  while (pieces.length < vocabSize) pieces.push(`<pad${pieces.length}>`);
  const enc = pieces.map((p) => new TextEncoder().encode(p));
  const out = new Uint8Array(4 + enc.reduce((s, b) => s + 8 + b.length, 0));
  const v = new DataView(out.buffer);
  v.setInt32(0, Math.max(...enc.map((b) => b.length)), true);
  let o = 4;
  enc.forEach((b, i) => { v.setFloat32(o, rank.get(i) ?? -1e6, true); v.setInt32(o + 4, b.length, true); out.set(b, o + 8); o += 8 + b.length; });
  return out;
}

// ---------------------------------------------------------------- reading

/** Header of a zllm/1 file from its first bytes. Throws an error with .need when more bytes are needed. */
export function readHeader(bytes) {
  if (bytes.length < 4) throw Object.assign(new Error('zllm: need more bytes'), { need: 4 });
  const hl = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (hl > 1 << 20) throw new Error('zllm: header too large');
  if (bytes.length < 4 + hl) throw Object.assign(new Error('zllm: need more bytes'), { need: 4 + hl });
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl)));
  if (header.format !== FORMAT || header.arch !== 'llama2') throw new Error('not a zllm/1 llama2 model');
  checkConfig(header.config);
  if (!Array.isArray(header.sections?.layers) || header.sections.layers.length !== header.config.nLayers) throw new Error('zllm: bad sections');
  return { header, base: pad(4 + hl) };
}

/** Byte ranges [start, end) a peer needs: the header, the head parts (if head) and layers [from, to). */
export function neededRanges({ header, base }, { from = 0, to = header.config.nLayers, head = true } = {}) {
  const s = header.sections;
  const r = [[0, base]];
  const sec = (x) => { if (x) r.push([base + x[0], base + x[0] + x[1]]); };
  if (head) { sec(s.tokenizer); sec(s.embedding); sec(s.finalNorm); sec(s.classifier); }
  for (let l = from; l < to; l++) sec(s.layers[l]);
  return r;
}

/** Opens a zllm/1 file, or only the parts a stage needs (other bytes may be missing / zero). */
export function openModel(bytes, { from = 0, to = null, head = true } = {}) {
  const { header, base } = readHeader(bytes);
  const c = header.config;
  const { sizes } = checkConfig(c);
  to ??= c.nLayers;
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= c.nLayers && from <= to)) throw new Error('bad layer range');
  const f32 = (off, n) => {
    if (base + off + n * 4 > bytes.length) throw new Error('zllm: file shorter than its sections');
    return new Float32Array(bytes.slice(base + off, base + off + n * 4).buffer);
  };
  const s = header.sections;
  const m = { config: c, header, from, to, head, layers: new Array(c.nLayers) };
  if (head) {
    m.tokenizer = bytes.slice(base + s.tokenizer[0], base + s.tokenizer[0] + s.tokenizer[1]);
    m.embedding = f32(s.embedding[0], c.vocabSize * c.dim);
    m.finalNorm = f32(s.finalNorm[0], c.dim);
    m.classifier = c.sharedClassifier ? m.embedding : f32(s.classifier[0], c.vocabSize * c.dim);
  }
  for (let l = from; l < to; l++) {
    let off = s.layers[l][0];
    const L = {};
    for (const t of TENSORS) { L[t] = f32(off, sizes[t]); off += sizes[t] * 4; }
    m.layers[l] = L;
  }
  return m;
}

// ---------------------------------------------------------------- running

function matvec(out, W, x, xOff, n, d) {
  for (let i = 0; i < d; i++) {
    let acc = 0;
    const row = i * n;
    for (let j = 0; j < n; j++) acc += W[row + j] * x[xOff + j];
    out[i] = acc;
  }
}
function rmsnorm(out, x, xOff, w, n, eps) {
  let ss = 0;
  for (let j = 0; j < n; j++) ss += x[xOff + j] * x[xOff + j];
  ss = 1 / Math.sqrt(ss / n + eps);
  for (let j = 0; j < n; j++) out[j] = w[j] * (ss * x[xOff + j]);
}

const ropeCache = new Map();
/** sin/cos per (position, pair) for a head size, from detmath (the same bits on every peer). */
function ropeTable(c, headSize) {
  const theta = c.ropeTheta ?? 10000;
  const key = `${headSize}/${c.seqLen}/${theta}`;
  let t = ropeCache.get(key);
  if (t) return t;
  const half = headSize / 2;
  const freq = Array.from({ length: half }, (_, j) => 1 / dpow(theta, (2 * j) / headSize));
  t = { sin: new Float32Array(c.seqLen * half), cos: new Float32Array(c.seqLen * half) };
  for (let p = 0; p < c.seqLen; p++) for (let j = 0; j < half; j++) {
    const [s, co] = dsincos(p * freq[j]);
    t.sin[p * half + j] = s; t.cos[p * half + j] = co;
  }
  ropeCache.set(key, t);
  return t;
}

/**
 * Runs layers [from, to) of a model it holds. forward(session, pos, xs, n) takes
 * the hidden states of n consecutive tokens (Float32Array n x dim) starting at
 * position pos, keeps their keys/values in that session's cache, and returns the
 * hidden states after its last layer. Positions must follow each other
 * (0, 1, 2, … per session); end(session) frees the cache; the oldest session
 * is dropped past maxSessions.
 */
export function createStage(model, { from = model.from ?? 0, to = model.to ?? model.config.nLayers, maxSessions = 16 } = {}) {
  const c = model.config;
  const { headSize, kvDim, kvMul } = checkConfig(c);
  for (let l = from; l < to; l++) if (!model.layers[l]) throw new Error(`layer ${l} is not loaded here`);
  const eps = c.normEps ?? 1e-5;
  const rope = ropeTable(c, headSize);
  const half = headSize / 2;
  const sessions = new Map();
  const xb = new Float32Array(c.dim), xb2 = new Float32Array(c.dim), q = new Float32Array(c.dim);
  const hb = new Float32Array(c.hiddenDim), hb2 = new Float32Array(c.hiddenDim);
  const att = new Float64Array(c.seqLen);
  const invSqrt = 1 / Math.sqrt(headSize);

  function session(id, pos) {
    let s = sessions.get(id);
    if (!s) {
      if (pos !== 0) throw new Error('unknown session (a session starts at position 0)');
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
      s = { pos: 0, k: [], v: [] };
      for (let l = from; l < to; l++) { s.k.push(new Float32Array(c.seqLen * kvDim)); s.v.push(new Float32Array(c.seqLen * kvDim)); }
      sessions.set(id, s);
    } else { sessions.delete(id); sessions.set(id, s); }
    if (pos !== s.pos) throw new Error(`session is at position ${s.pos}, asked ${pos}`);
    return s;
  }

  function token(s, x, pos) {
    for (let l = from; l < to; l++) {
      const L = model.layers[l];
      const K = s.k[l - from], V = s.v[l - from];
      const ko = pos * kvDim;
      rmsnorm(xb, x, 0, L.attNorm, c.dim, eps);
      matvec(q, L.wq, xb, 0, c.dim, c.dim);
      matvec(xb2, L.wk, xb, 0, c.dim, kvDim); K.set(xb2.subarray(0, kvDim), ko);
      matvec(xb2, L.wv, xb, 0, c.dim, kvDim); V.set(xb2.subarray(0, kvDim), ko);
      // rotary embedding, as llama2.c: pairs (i, i+1) within each head
      for (let i = 0; i < c.dim; i += 2) {
        const j = (i % headSize) / 2;
        const sn = rope.sin[pos * half + j], cs = rope.cos[pos * half + j];
        const q0 = q[i], q1 = q[i + 1];
        q[i] = q0 * cs - q1 * sn; q[i + 1] = q0 * sn + q1 * cs;
        if (i < kvDim) {
          const k0 = K[ko + i], k1 = K[ko + i + 1];
          K[ko + i] = k0 * cs - k1 * sn; K[ko + i + 1] = k0 * sn + k1 * cs;
        }
      }
      for (let h = 0; h < c.nHeads; h++) {
        const qo = h * headSize, kh = Math.floor(h / kvMul) * headSize;
        let max = -Infinity;
        for (let t = 0; t <= pos; t++) {
          let a = 0;
          const kt = t * kvDim + kh;
          for (let i = 0; i < headSize; i++) a += q[qo + i] * K[kt + i];
          a *= invSqrt;
          att[t] = a;
          if (a > max) max = a;
        }
        let sum = 0;
        for (let t = 0; t <= pos; t++) { att[t] = dexp(att[t] - max); sum += att[t]; }
        for (let i = 0; i < headSize; i++) {
          let acc = 0;
          for (let t = 0; t <= pos; t++) acc += att[t] * V[t * kvDim + kh + i];
          xb[qo + i] = acc / sum;
        }
      }
      matvec(xb2, L.wo, xb, 0, c.dim, c.dim);
      for (let i = 0; i < c.dim; i++) x[i] += xb2[i];
      rmsnorm(xb, x, 0, L.ffnNorm, c.dim, eps);
      matvec(hb, L.w1, xb, 0, c.dim, c.hiddenDim);
      matvec(hb2, L.w3, xb, 0, c.dim, c.hiddenDim);
      for (let i = 0; i < c.hiddenDim; i++) { const a = hb[i]; hb[i] = (a / (1 + dexp(-a))) * hb2[i]; }
      matvec(xb2, L.w2, hb, 0, c.hiddenDim, c.dim);
      for (let i = 0; i < c.dim; i++) x[i] += xb2[i];
    }
  }

  return {
    from, to, dim: c.dim, seqLen: c.seqLen,
    get sessions() { return sessions.size; },
    async forward(id, pos, xs, n) {
      if (!Number.isInteger(n) || n < 1 || !Number.isInteger(pos) || pos < 0 || pos + n > c.seqLen) throw new Error(`positions ${pos}..${pos + n} outside 0..${c.seqLen}`);
      if (xs.length !== n * c.dim) throw new Error(`expected ${n} x ${c.dim} values`);
      const s = session(String(id), pos);
      const out = new Float32Array(xs);
      for (let t = 0; t < n; t++) {
        token(s, out.subarray(t * c.dim, (t + 1) * c.dim), pos + t);
        s.pos = pos + t + 1;
      }
      return out;
    },
    async end(id) { sessions.delete(String(id)); },
  };
}

/** Embedding and output layer: the "head", kept by whoever coordinates the generation. */
export function createHead(model) {
  const c = model.config;
  if (!model.embedding) throw new Error('the head (embedding, final norm, classifier) is not loaded here');
  const xb = new Float32Array(c.dim);
  return {
    config: c,
    embed(tokens) {
      const out = new Float32Array(tokens.length * c.dim);
      tokens.forEach((t, i) => {
        if (!Number.isInteger(t) || t < 0 || t >= c.vocabSize) throw new Error('token out of range');
        out.set(model.embedding.subarray(t * c.dim, (t + 1) * c.dim), i * c.dim);
      });
      return out;
    },
    /** Logits (Float32Array vocab) for one hidden state: row `row` of x (n x dim). */
    logits(x, row = 0) {
      rmsnorm(xb, x, row * c.dim, model.finalNorm, c.dim, c.normEps ?? 1e-5);
      const out = new Float32Array(c.vocabSize);
      matvec(out, model.classifier, xb, 0, c.dim, c.vocabSize);
      return out;
    },
  };
}

/** Joins stages [{from, to, forward, end}] that cover layers 0..nLayers in order into one runner. */
export function chainStages(stages, nLayers) {
  if (!stages.length || stages[0].from !== 0 || stages[stages.length - 1].to !== nLayers) throw new Error(`stages must cover layers 0..${nLayers}`);
  for (let i = 1; i < stages.length; i++) if (stages[i].from !== stages[i - 1].to) throw new Error('stages must be contiguous');
  return {
    stages,
    async forward(id, pos, xs, n) {
      let a = xs;
      for (const st of stages) a = await st.forward(id, pos, a, n);
      return a;
    },
    async end(id) { await Promise.all(stages.map((s) => Promise.resolve(s.end?.(id)).catch(() => {}))); },
  };
}

/** llama2.c's xorshift64* sampler RNG (deterministic). */
function rng64(seed) {
  let s = BigInt.asUintN(64, BigInt(seed) || 1n);
  return () => {
    s ^= s >> 12n; s ^= BigInt.asUintN(64, s << 25n); s ^= s >> 27n;
    const u32 = Number(BigInt.asUintN(64, s * 0x2545F4914F6CDD1Dn) >> 32n);
    return (u32 >>> 8) / 16777216;
  };
}

/** Index of the largest value (the first one on ties). */
export function argmax(a) {
  let best = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[best]) best = i;
  return best;
}

function sample(logits, temperature, topp, coin) {
  if (!(temperature > 0)) return argmax(logits);
  const n = logits.length;
  const p = new Float64Array(n);
  let max = -Infinity;
  for (let i = 0; i < n; i++) { p[i] = logits[i] / temperature; if (p[i] > max) max = p[i]; }
  let sum = 0;
  for (let i = 0; i < n; i++) { p[i] = dexp(p[i] - max); sum += p[i]; }
  for (let i = 0; i < n; i++) p[i] /= sum;
  const r = coin();
  if (!(topp > 0 && topp < 1)) {
    let cdf = 0;
    for (let i = 0; i < n; i++) { cdf += p[i]; if (r < cdf) return i; }
    return n - 1;
  }
  const cut = (1 - topp) / (n - 1);
  const idx = [];
  for (let i = 0; i < n; i++) if (p[i] >= cut) idx.push(i);
  idx.sort((a, b) => p[b] - p[a] || a - b);
  let total = 0, last = idx.length - 1;
  for (let k = 0; k < idx.length; k++) { total += p[idx[k]]; if (total > topp) { last = k; break; } }
  const r2 = r * total;
  let cdf = 0;
  for (let k = 0; k <= last; k++) { cdf += p[idx[k]]; if (r2 < cdf) return idx[k]; }
  return idx[last];
}

const newSession = () => {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

/**
 * Generates text. runner: {forward(session, pos, xs, n), end(session)}: one createStage over all
 * layers, or chainStages() of local and remote stages. The prompt goes through in one call
 * (prefill), then one token per call. Stops at maxNew tokens, the end of the context, or a
 * BOS/EOS token. Greedy (argmax) unless temperature > 0 (then top-p sampling, seeded: the
 * same seed gives the same text).
 */
export async function generate({ head, tokenizer, runner }, prompt, { maxNew = 64, temperature = 0, topp = 0.9, seed = 1, onToken, signal } = {}) {
  const c = head.config;
  const promptTokens = Array.isArray(prompt) ? prompt : tokenizer.encode(prompt, { bos: true });
  if (!promptTokens.length) throw new Error('empty prompt');
  if (promptTokens.length >= c.seqLen) throw new Error(`the prompt is ${promptTokens.length} tokens; the context holds ${c.seqLen}`);
  const coin = rng64(seed);
  const session = newSession();
  const tokens = [];
  const t0 = Date.now();
  let firstMs = null;
  try {
    let hs = await runner.forward(session, 0, head.embed(promptTokens), promptTokens.length);
    let pos = promptTokens.length;
    let logits = head.logits(hs, promptTokens.length - 1);
    let prev = promptTokens[promptTokens.length - 1];
    while (tokens.length < maxNew) {
      if (signal?.aborted) break;
      const next = sample(logits, temperature, topp, coin);
      if (next === BOS || next === EOS) break;
      tokens.push(next);
      firstMs ??= Date.now() - t0;
      onToken?.(next, tokenizer ? tokenizer.piece(prev, next) : null);
      prev = next;
      if (tokens.length >= maxNew || pos >= c.seqLen) break;
      hs = await runner.forward(session, pos, head.embed([next]), 1);
      pos++;
      logits = head.logits(hs, 0);
    }
  } finally {
    await Promise.resolve(runner.end?.(session)).catch(() => {});
  }
  const ms = Date.now() - t0;
  return {
    promptTokens, tokens, text: tokenizer ? tokenizer.decode(tokens, promptTokens[promptTokens.length - 1]) : null,
    ms, firstTokenMs: firstMs, tokensPerSecond: tokens.length ? tokens.length / (Math.max(1, ms) / 1000) : 0,
  };
}
