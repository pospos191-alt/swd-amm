// A toy dense network (MLP) in plain JS: the model the pipeline-parallel
// prototype (ai/browser/pipeline.js) splits across browsers. It is NOT a
// language model and knows nothing: its weights come from a seeded PRNG. It
// exists to prove the mechanism (layer ranges per peer, activations over
// WebRTC, exact same output as running it in one place), with tests.
//
// File format "zmlp/1" (what the verified loader would distribute):
//   u32 LE header length | header JSON {format, dims:[d0..dn], acts:[...]} |
//   float32 LE weights, layer by layer: W (out x in, row-major) then b (out)

export const FORMAT = 'zmlp/1';

function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

/** A seeded toy MLP: dims e.g. [16, 64, 64, 64, 64, 8]; ReLU between layers, none at the end. */
export function makeToyModel(dims = [16, 64, 64, 64, 64, 8], seed = 7) {
  const r = prng(seed);
  const layers = [];
  for (let i = 0; i < dims.length - 1; i++) {
    const n = dims[i], m = dims[i + 1], scale = Math.sqrt(2 / n);
    const W = new Float32Array(m * n).map(() => (r() * 2 - 1) * scale);
    const b = new Float32Array(m).map(() => (r() * 2 - 1) * 0.01);
    layers.push({ in: n, out: m, W, b, act: i < dims.length - 2 ? 'relu' : 'none' });
  }
  return { format: FORMAT, dims: [...dims], layers };
}

/** Runs layers [from, to) on a batch: x is Float32Array(batch * dims[from]). */
export function forward(model, x, from = 0, to = model.layers.length, batch = 1) {
  let a = x;
  for (let li = from; li < to; li++) {
    const L = model.layers[li];
    if (a.length !== batch * L.in) throw new Error(`layer ${li}: expected ${batch}x${L.in} inputs`);
    const out = new Float32Array(batch * L.out);
    for (let s = 0; s < batch; s++) {
      for (let o = 0; o < L.out; o++) {
        let acc = L.b[o];
        const row = o * L.in, xs = s * L.in;
        for (let k = 0; k < L.in; k++) acc += L.W[row + k] * a[xs + k];
        out[s * L.out + o] = L.act === 'relu' && acc < 0 ? 0 : acc;
      }
    }
    a = out;
  }
  return a;
}

export function paramCount(model, from = 0, to = model.layers.length) {
  let n = 0;
  for (let i = from; i < to; i++) n += model.layers[i].W.length + model.layers[i].b.length;
  return n;
}

export function serialize(model) {
  const head = new TextEncoder().encode(JSON.stringify({ format: FORMAT, dims: model.dims, acts: model.layers.map((l) => l.act) }));
  const floats = paramCount(model);
  const out = new Uint8Array(4 + head.length + floats * 4);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  const f = new Float32Array(floats);
  let o = 0;
  for (const l of model.layers) { f.set(l.W, o); o += l.W.length; f.set(l.b, o); o += l.b.length; }
  const fb = new Uint8Array(f.buffer);
  // float32 little-endian on every platform that runs browsers today; checked here
  if (new Uint8Array(new Float32Array([1]).buffer)[3] !== 0x3f) throw new Error('big-endian platform');
  out.set(fb, 4 + head.length);
  return out;
}

export function deserialize(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hl = v.getUint32(0, true);
  if (hl > 65536 || 4 + hl > bytes.length) throw new Error('bad header');
  const h = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl)));
  if (h.format !== FORMAT || !Array.isArray(h.dims) || h.dims.length < 2 || h.acts?.length !== h.dims.length - 1) throw new Error('not a zmlp/1 model');
  const body = bytes.slice(4 + hl);
  const f = new Float32Array(body.buffer, body.byteOffset, body.byteLength / 4);
  const layers = [];
  let o = 0;
  for (let i = 0; i < h.dims.length - 1; i++) {
    const n = h.dims[i], m = h.dims[i + 1];
    const W = f.slice(o, o + n * m); o += n * m;
    const b = f.slice(o, o + m); o += m;
    layers.push({ in: n, out: m, W, b, act: h.acts[i] === 'relu' ? 'relu' : 'none' });
  }
  if (o !== f.length) throw new Error('weights size mismatch');
  return { format: FORMAT, dims: h.dims, layers };
}
