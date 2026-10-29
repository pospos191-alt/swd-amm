// A real (small) transformer language model split across browsers
// (docs/future/browser-ai.md item 7): deterministic math, the llama2.c format
// and tokenizer, the zllm/1 file and partial loading, the layer pipeline over
// channels (bit-exact against one place), and the model shipped in
// web/models/zetaphy-docs-tiny/1 against an independent numpy implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dexp, dsincos, dlog, dpow, dsilu } from '../ai/browser/detmath.js';
import {
  makeRandomLlama, openModel, buildZllm, fromLlama2c, toLlama2c, readHeader, neededRanges, createStage, createHead,
  chainStages, generate, makeSimpleTokenizer, paramCount, argmax, checkConfig,
} from '../ai/browser/llama.js';
import { loadTokenizer } from '../ai/browser/tokenizer.js';
import { serveLlmStage, remoteLlmStage, planLlmStages } from '../ai/browser/pipeline.js';
import { memoryPair } from '../ai/browser/p2p.js';
import { buildManifest } from '../ai/browser/manifest.js';
import { loadLlm, chunksFor } from '../ai/browser/llmload.js';
import { BROWSER_LLM, PINNED_LLM } from '../ai/browser/config.js';

const bits = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return b.getBigUint64(0).toString(16); };

test('deterministic math: within a few ulp of Math.*, built only from IEEE-exact operations (fixed bits)', () => {
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const x = (i / 20000) * 80 - 60;
    worst = Math.max(worst, Math.abs(dexp(x) - Math.exp(x)) / Math.exp(x));
  }
  assert.ok(worst < 1e-15, `exp ${worst}`);
  worst = 0;
  for (let i = 0; i < 20000; i++) {
    const x = (i / 20000) * 600 - 50;
    const [s, c] = dsincos(x);
    worst = Math.max(worst, Math.abs(s - Math.sin(x)), Math.abs(c - Math.cos(x)));
  }
  assert.ok(worst < 1e-13, `sin/cos ${worst}`);
  for (const x of [1e-300, 0.001, 0.7, 1, 2, 10000, 1e300]) assert.ok(Math.abs(dlog(x) - Math.log(x)) <= 1e-15 * Math.max(1, Math.abs(Math.log(x))), `log ${x}`);
  assert.ok(Math.abs(dpow(10000, 0.25) - 10) < 1e-13);
  assert.equal(dexp(0), 1);
  assert.equal(dexp(-1000), 0);
  assert.equal(dexp(1000), Infinity);
  assert.ok(Math.abs(dsilu(1.5) - 1.5 / (1 + Math.exp(-1.5))) < 1e-15);
  assert.throws(() => dsincos(1e7));
  // the exact bits every engine must produce (only + - * / and Math.round inside): this is what makes peers agree
  assert.deepEqual([dexp(0.5), dexp(-3.25), dsincos(1.234)[0], dsincos(1.234)[1], dlog(7.5), dpow(10000, 0.375)].map(bits),
    GOLDEN);
});
const GOLDEN = ['3ffa61298e1e069c', '3fa3da368521902d', '3fee33c23ed44442', '3fd526571fe8c7a5', '40001e85798eb9a3', '403f9f6e4990f22a'];

const CFG = { dim: 48, hiddenDim: 96, nLayers: 6, nHeads: 6, nKvHeads: 2, vocabSize: 300, seqLen: 64 };

test('zllm/1: build, read back, llama2.c round trip, partial open; bad files refused', () => {
  const bytes = makeRandomLlama(CFG, 3);
  const m = openModel(bytes);
  assert.equal(paramCount(m.config), CFG.vocabSize * CFG.dim + CFG.dim + CFG.nLayers * checkConfig(CFG).layerFloats);
  // llama2.c legacy checkpoint and back: same file, byte for byte
  const back = fromLlama2c(toLlama2c(m));
  assert.deepEqual(buildZllm({ ...back, tokenizer: m.tokenizer, meta: m.header.meta }), bytes);
  // a separate classifier survives the round trip too
  const sep = openModel(makeRandomLlama({ ...CFG, sharedClassifier: false }, 4));
  assert.equal(sep.config.sharedClassifier, false);
  const back2 = fromLlama2c(toLlama2c(sep));
  assert.deepEqual(back2.classifier, sep.classifier);
  // only layers 2..4 (no head): the other bytes may be zero
  const hdr = readHeader(bytes);
  const keep = new Uint8Array(bytes.length);
  for (const [a, b] of neededRanges(hdr, { from: 2, to: 4, head: false })) keep.set(bytes.subarray(a, b), a);
  const part = openModel(keep, { from: 2, to: 4, head: false });
  assert.deepEqual(part.layers[2].w1, m.layers[2].w1);
  assert.equal(part.layers[0], undefined);
  assert.equal(part.embedding, undefined);
  assert.throws(() => createStage(part, { from: 0, to: 4 }), /not loaded/);
  assert.throws(() => createHead(part), /head/);
  assert.throws(() => openModel(bytes.subarray(0, 100)), /need more bytes|shorter/);
  assert.throws(() => openModel(bytes.subarray(0, bytes.length - 8)), /shorter/);
  assert.throws(() => fromLlama2c(toLlama2c(m).subarray(0, 1000)), /truncated/);
  assert.throws(() => makeRandomLlama({ ...CFG, nKvHeads: 4 }), /heads/);
});

test('tokenizer: llama2.c encode (dummy space, UTF-8 or byte fallback, merges by score) and decode', () => {
  const tok = loadTokenizer(makeSimpleTokenizer(400), 400);
  const ids = tok.encode('the cat and the dog');
  assert.equal(ids[0], 1);
  assert.equal(tok.decode(ids.slice(1)), 'the cat and the dog');
  assert.ok(ids.length < 1 + 1 + 19, 'pieces were merged');
  assert.ok(ids.includes(tok.vocab.indexOf(' the')), 'by score');
  // characters not in the vocabulary go as UTF-8 bytes (ids 3..258) and come back whole
  const th = tok.encode('สวัสดี é', { bos: false });
  assert.ok(th.every((t) => (t >= 3 && t < 259) || tok.vocab[t] === ' '));
  assert.equal(tok.decode(th), 'สวัสดี é', 'after BOS the leading space goes, as in run.c');
  assert.equal(tok.decode(th, 300), ' สวัสดี é');
  assert.deepEqual(tok.encode('', { bos: true }), [1]);
  assert.deepEqual(tok.encode('x', { bos: false, eos: true }).at(-1), 2);
  assert.throws(() => loadTokenizer(new Uint8Array(8), 10));
});

async function stagesOver(bytes, cuts, model = 'm1') {
  const L = openModel(bytes).config.nLayers;
  const edges = [0, ...cuts, L];
  const out = [];
  const servers = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const [from, to] = [edges[i], edges[i + 1]];
    if (i === 0) { out.push(createStage(openModel(bytes, { from, to }), { from, to })); continue; }
    const [c, p] = memoryPair();
    servers.push(serveLlmStage(p, createStage(openModel(bytes, { from, to, head: false }), { from, to }), { model }));
    out.push(remoteLlmStage(c, { from, to, model }));
  }
  return { runner: chainStages(out, L), servers, stages: out };
}

test('pipeline: layers split over 2 and 3 peers give the same bits as one place (logits at every step, greedy and sampled text)', async () => {
  for (const [cfg, seed] of [[CFG, 7], [{ ...CFG, sharedClassifier: false, nKvHeads: 6 }, 8], [{ ...CFG, nLayers: 3, nHeads: 4, dim: 32, nKvHeads: 1 }, 9]]) {
    const bytes = makeRandomLlama(cfg, seed);
    const m = openModel(bytes);
    const head = createHead(m);
    const tokenizer = loadTokenizer(m.tokenizer, cfg.vocabSize);
    const single = createStage(m);
    for (const cuts of cfg.nLayers === 6 ? [[3], [2, 4], [1, 5]] : [[1], [1, 2]]) {
      const { runner, servers } = await stagesOver(bytes, cuts);
      // step by step: hidden states and logits identical
      const prompt = tokenizer.encode('the quick brown fox');
      const s1 = 'aa'.repeat(8), s2 = 'bb'.repeat(8);
      let a = await single.forward(s1, 0, head.embed(prompt), prompt.length);
      let b = await runner.forward(s2, 0, head.embed(prompt), prompt.length);
      assert.deepEqual(b, a);
      for (let pos = prompt.length; pos < prompt.length + 12; pos++) {
        const la = head.logits(a, a.length / cfg.dim - 1), lb = head.logits(b, b.length / cfg.dim - 1);
        assert.deepEqual(lb, la);
        const next = argmax(la);
        a = await single.forward(s1, pos, head.embed([next]), 1);
        b = await runner.forward(s2, pos, head.embed([next]), 1);
      }
      await single.end(s1); await runner.end(s2);
      const g1 = await generate({ head, tokenizer, runner: single }, 'once upon a time', { maxNew: 30 });
      const g2 = await generate({ head, tokenizer, runner }, 'once upon a time', { maxNew: 30 });
      assert.deepEqual(g2.tokens, g1.tokens);
      assert.equal(g2.text, g1.text);
      const r1 = await generate({ head, tokenizer, runner: single }, 'once', { maxNew: 25, temperature: 0.9, topp: 0.9, seed: 42 });
      const r2 = await generate({ head, tokenizer, runner }, 'once', { maxNew: 25, temperature: 0.9, topp: 0.9, seed: 42 });
      assert.deepEqual(r2.tokens, r1.tokens);
      assert.ok(servers.every((s) => s.tokens > 0));
      for (const s of servers) s.close();
    }
  }
  assert.deepEqual(planLlmStages(6, 2), [{ from: 0, to: 3 }, { from: 3, to: 6 }]);
  assert.deepEqual(planLlmStages(5, 3), [{ from: 0, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 5 }]);
});

test('a stage refuses another range, another model, bad sessions and out-of-order positions; sessions of two peers never mix', async () => {
  const bytes = makeRandomLlama(CFG, 11);
  const stage = createStage(openModel(bytes, { from: 3, to: 6, head: false }), { from: 3, to: 6 });
  const [c1, p1] = memoryPair();
  const [c2, p2] = memoryPair();
  serveLlmStage(p1, stage, { model: 'm1' });
  serveLlmStage(p2, stage, { model: 'm1' });
  const x = new Float32Array(CFG.dim).fill(0.1);
  await assert.rejects(remoteLlmStage(c1, { from: 2, to: 6, model: 'm1', timeoutMs: 2000 }).forward('ab'.repeat(8), 0, x, 1), /serves layers 3-6/);
  await assert.rejects(remoteLlmStage(c1, { from: 3, to: 6, model: 'other', timeoutMs: 2000 }).forward('ab'.repeat(8), 0, x, 1), /another model/);
  await assert.rejects(remoteLlmStage(c1, { from: 3, to: 6, model: 'm1', timeoutMs: 2000 }).forward('not hex!', 0, x, 1), /bad session/);
  const r1 = remoteLlmStage(c1, { from: 3, to: 6, model: 'm1', timeoutMs: 2000 });
  const r2 = remoteLlmStage(c2, { from: 3, to: 6, model: 'm1', timeoutMs: 2000 });
  await assert.rejects(r1.forward('ab'.repeat(8), 5, x, 1), /starts at position 0/);
  const s = 'cd'.repeat(8);
  const a1 = await r1.forward(s, 0, x, 1);
  await assert.rejects(r1.forward(s, 3, x, 1), /at position 1/);
  // the same session id from another peer is another session (starts at 0, same answer)
  const a2 = await r2.forward(s, 0, x, 1);
  assert.deepEqual(a2, a1);
  assert.equal(stage.sessions, 2);
  await r1.end(s); await r2.end(s);
  assert.equal(stage.sessions, 0);
  await assert.rejects(r1.forward(s, 0, new Float32Array(3), 1), /bad token count/);
});

test('partial loading: a stage fetches only its layers\' chunks, each verified; the coordinator only the head and its layers', async () => {
  const bytes = makeRandomLlama({ ...CFG, nLayers: 6 }, 12);
  const built = await buildManifest(bytes, { kind: 'model', name: 'rnd', version: 1, runtime: 'zllm/1', license: 'MIT', chunkSize: 4096 });
  const files = new Map([['m.json', built.bytes], ...built.chunks.map((c) => [`${c.hash}.bin`, c.data])]);
  const fetched = [];
  const fetchImpl = async (url) => {
    const name = url.split('/').pop();
    fetched.push(name);
    const b = files.get(name);
    return { ok: !!b, status: b ? 200 : 404, headers: { get: () => null }, arrayBuffer: async () => b.slice().buffer };
  };
  const release = { status: 'active', manifestHash: '0x' + built.manifestHash, chunkRoot: '0x' + built.manifest.root, size: bytes.length, chunkSize: 4096 };
  const mirrors = [{ label: 'test', manifest: 'https://m.example/m.json', chunk: 'https://m.example/{hash}.bin' }];
  const stagePart = await loadLlm({ release, mirrors, fetchImpl, from: 3, to: 6, head: false });
  assert.ok(stagePart.chunks < stagePart.total, `${stagePart.chunks} of ${stagePart.total}`);
  assert.equal(stagePart.stats.partial, true);
  const full = openModel(bytes);
  assert.deepEqual(stagePart.model.layers[5].w2, full.layers[5].w2);
  const coord = await loadLlm({ release, mirrors, fetchImpl, from: 0, to: 3, head: true });
  // split across the two partial loads = the whole model in one place
  const [c, p] = memoryPair();
  serveLlmStage(p, createStage(stagePart.model, { from: 3, to: 6 }), { model: 'x' });
  const runner = chainStages([createStage(coord.model, { from: 0, to: 3 }), remoteLlmStage(c, { from: 3, to: 6, model: 'x' })], 6);
  const tok = loadTokenizer(coord.model.tokenizer, CFG.vocabSize);
  const g1 = await generate({ head: createHead(full), tokenizer: tok, runner: createStage(full) }, 'abc', { maxNew: 20 });
  const g2 = await generate({ head: createHead(coord.model), tokenizer: tok, runner }, 'abc', { maxNew: 20 });
  assert.deepEqual(g2.tokens, g1.tokens);
  // a lying mirror cannot slip a byte into a stage
  const evil = async (url) => { const r = await fetchImpl(url); const b = new Uint8Array(await r.arrayBuffer()); if (url.endsWith('.bin')) b[7] ^= 1; return { ...r, arrayBuffer: async () => b.buffer }; };
  await assert.rejects(loadLlm({ release, mirrors, fetchImpl: evil, from: 3, to: 6, head: false }), /no source served the right bytes/);
  assert.deepEqual(chunksFor([[0, 10], [4096, 4097], [9000, 12289]], 4096, 20000), [0, 1, 2, 3]);
});

// ---------------------------------------------------------------- the shipped model

const PACK = new URL('../web/models/zetaphy-docs-tiny/1/', import.meta.url);
const fileFetch = async (url) => {
  const name = String(url).split('/').pop();
  const p = new URL(name, PACK);
  if (!existsSync(p)) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  const b = readFileSync(p);
  return { ok: true, status: 200, headers: { get: () => String(b.length) }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
};
const MIRRORS = [{ label: 'repo', manifest: 'https://repo.example/manifest.json', chunk: 'https://repo.example/{hash}.bin' }];

test('shipped model: the pinned release equals release.json; it loads verified from its chunks and writes text', async () => {
  const rel = JSON.parse(readFileSync(new URL('release.json', PACK), 'utf8'));
  for (const k of ['manifestHash', 'chunkRoot', 'size', 'chunkSize']) assert.equal(PINNED_LLM[k], rel[k], k);
  assert.equal(BROWSER_LLM.model.name, rel.name);
  const { model, stats } = await loadLlm({ release: PINNED_LLM, mirrors: MIRRORS, fetchImpl: fileFetch });
  assert.equal(stats.partial, false);
  assert.equal(model.config.nLayers, PINNED_LLM.layers);
  const tok = loadTokenizer(model.tokenizer, model.config.vocabSize);
  const out = await generate({ head: createHead(model), tokenizer: tok, runner: createStage(model) }, 'The browser', { maxNew: 60 });
  assert.ok(out.tokens.length >= 20);
  assert.match(out.text, /^[\x20-\x7e\n]+$/, 'English-looking text');
});

test('shipped model against an independent implementation (numpy, float64): same tokenizer ids, same greedy text, logits within 1e-4', async () => {
  const ref = JSON.parse(readFileSync(new URL('./fixtures/llm-reference.json', import.meta.url), 'utf8'));
  const { model } = await loadLlm({ release: PINNED_LLM, mirrors: MIRRORS, fetchImpl: fileFetch });
  const c = model.config;
  assert.deepEqual(ref.config, [c.dim, c.hiddenDim, c.nLayers, c.nHeads, c.nKvHeads, c.vocabSize, c.seqLen]);
  const tok = loadTokenizer(model.tokenizer, c.vocabSize);
  const head = createHead(model);
  let worst = 0, steps = 0;
  for (const k of ref.cases) {
    assert.deepEqual(tok.encode(k.prompt), k.tokens, k.prompt);
    const g = await generate({ head, tokenizer: tok, runner: createStage(model) }, k.prompt, { maxNew: k.steps.length });
    // greedy tokens equal as long as the reference's top-2 margin is above float32 noise
    // (generation stops at BOS/EOS; the reference just continues)
    const firm = k.steps.findIndex((s) => s.margin < 1e-3 || s.next === 1 || s.next === 2);
    const n = firm < 0 ? k.steps.length : firm;
    assert.ok(n >= 8, `${k.prompt}: ${n} comparable tokens`);
    assert.deepEqual(g.tokens.slice(0, n), k.steps.slice(0, n).map((s) => s.next), k.prompt);
    // teacher-forced logits on the reference's sequence
    const st = createStage(model);
    let x = await st.forward('ee'.repeat(8), 0, head.embed(k.tokens), k.tokens.length);
    let pos = k.tokens.length;
    let logits = head.logits(x, k.tokens.length - 1);
    for (const s of k.steps) {
      for (let i = 0; i < 8; i++) worst = Math.max(worst, Math.abs(logits[i] - s.head[i]));
      worst = Math.max(worst, Math.abs(logits[s.next] - s.max));
      steps++;
      if (pos >= c.seqLen) break;
      x = await st.forward('ee'.repeat(8), pos++, head.embed([s.next]), 1);
      logits = head.logits(x, 0);
    }
  }
  assert.ok(steps > 50);
  assert.ok(worst < 1e-4, `max |logit difference| ${worst}`);
});

test('shipped model split in two over a channel: the same text as one browser, and only the needed chunks per side', async () => {
  const L = PINNED_LLM.layers, k = Math.floor(L / 2);
  const stagePart = await loadLlm({ release: PINNED_LLM, mirrors: MIRRORS, fetchImpl: fileFetch, from: k, to: L, head: false });
  const coord = await loadLlm({ release: PINNED_LLM, mirrors: MIRRORS, fetchImpl: fileFetch, from: 0, to: k, head: true });
  assert.ok(stagePart.chunks < stagePart.total && coord.chunks < coord.total);
  const full = (await loadLlm({ release: PINNED_LLM, mirrors: MIRRORS, fetchImpl: fileFetch })).model;
  const [c, p] = memoryPair();
  serveLlmStage(p, createStage(stagePart.model, { from: k, to: L }), { model: 'docs' });
  const runner = chainStages([createStage(coord.model, { from: 0, to: k }), remoteLlmStage(c, { from: k, to: L, model: 'docs' })], L);
  const tok = loadTokenizer(coord.model.tokenizer, coord.model.config.vocabSize);
  for (const prompt of ['The browser', 'ZETAPHY is', 'A validator']) {
    const one = await generate({ head: createHead(full), tokenizer: tok, runner: createStage(full) }, prompt, { maxNew: 40 });
    const two = await generate({ head: createHead(coord.model), tokenizer: tok, runner }, prompt, { maxNew: 40 });
    assert.deepEqual(two.tokens, one.tokens, prompt);
  }
});
