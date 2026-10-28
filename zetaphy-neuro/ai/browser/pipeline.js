// Pipeline-parallel inference across browsers: a PROTOTYPE on a toy model.
//
// A model too big for one browser is cut into contiguous layer ranges; each
// peer holds one range ("stage") and runs only those layers. A coordinator
// cuts the input batch into micro-batches and sends each through stage 1,
// 2, …, n over WebRTC data channels (ai/browser/p2p.js), keeping several
// micro-batches in flight so all stages work at once (GPipe-style, forward
// only). Activations travel as float32.
//
// Proven by tests (test/browserai.test.js, test/browserai.e2e.js): the
// pipelined output is bit-for-bit the output of running the whole model in one
// place, over in-memory channels and over real WebRTC data channels in Chromium.
//
// Limits (see docs/future/browser-ai.md): forward pass only (no training, no KV
// cache, no token-by-token decoding loop); no fault tolerance (a stage that
// leaves stops the run); a stage can lie about its output: the coordinator can
// only spot-check (recompute a random share of micro-batches when it holds the
// weights itself) or ask replicas; latency per hop is a network round trip.

import { forward, paramCount } from './toymodel.js';
import { rpcChannel, METHOD } from './p2p.js';

/** Splits layers into `n` contiguous ranges with about equal parameter counts. */
export function planStages(model, n) {
  const L = model.layers.length;
  if (n < 1 || n > L) throw new Error(`stages: 1..${L}`);
  const total = paramCount(model);
  const stages = [];
  let from = 0;
  for (let s = 0; s < n; s++) {
    if (s === n - 1) { stages.push({ from, to: L }); break; }
    let to = from + 1;
    const target = (total * (s + 1)) / n;
    while (to < L - (n - s - 1) && paramCount(model, 0, to + 1) <= target) to++;
    stages.push({ from, to });
    from = to;
  }
  return stages;
}

// Message: u32 header length | header JSON {from, to, batch} | float32 LE activations
function pack(h, x) {
  const head = new TextEncoder().encode(JSON.stringify(h));
  const out = new Uint8Array(4 + head.length + x.byteLength);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  out.set(new Uint8Array(x.buffer, x.byteOffset, x.byteLength), 4 + head.length);
  return out;
}
function unpack(b) {
  const hl = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
  if (hl > 4096) throw new Error('bad header');
  const h = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + hl)));
  const body = b.slice(4 + hl);
  return { h, x: new Float32Array(body.buffer, body.byteOffset, body.byteLength / 4) };
}

/**
 * A peer serving one stage: runs layers [from, to) of `model` for whoever asks.
 * It refuses requests for other ranges (it may not even have those weights).
 */
export function serveStage(channel, model, { from, to }) {
  let runs = 0;
  const rpc = rpcChannel(channel, {
    [METHOD.forward]: async (payload) => {
      const { h, x } = unpack(payload);
      if (h.from !== from || h.to !== to) throw new Error(`this peer serves layers ${from}-${to}`);
      if (!Number.isInteger(h.batch) || h.batch < 1 || h.batch > 4096) throw new Error('bad batch');
      runs++;
      const y = forward(model, x, from, to, h.batch);
      return pack({ from, to, batch: h.batch }, y);
    },
  });
  return { rpc, get runs() { return runs; } };
}

/**
 * The coordinator. stages: [{from, to, channel}] in order.
 * run(x, batch, {microBatch, inFlight, check}) -> Float32Array output.
 * check: {model, share} recomputes that share of micro-batches locally and throws on any difference.
 */
export function createPipeline(stages, { timeoutMs = 30_000 } = {}) {
  const rpcs = stages.map((s) => ({ ...s, rpc: rpcChannel(s.channel) }));
  const hop = async (st, x, batch) => {
    const out = unpack(await st.rpc.request(METHOD.forward, pack({ from: st.from, to: st.to, batch }, x), { timeoutMs }));
    if (out.h.batch !== batch) throw new Error('stage answered another batch size');
    return out.x;
  };
  return {
    async run(x, batch, { microBatch = Math.max(1, Math.ceil(batch / 4)), inFlight = 4, check = null, rand = Math.random } = {}) {
      const inDim = x.length / batch;
      const jobs = [];
      for (let s = 0; s < batch; s += microBatch) jobs.push({ s, n: Math.min(microBatch, batch - s) });
      const results = new Array(jobs.length);
      let next = 0;
      const timeline = [];
      const worker = async () => {
        while (next < jobs.length) {
          const j = next++;
          const { s, n } = jobs[j];
          let a = x.subarray(s * inDim, (s + n) * inDim);
          const x0 = a;
          for (const [k, st] of rpcs.entries()) {
            const t0 = Date.now();
            a = await hop(st, a, n);
            timeline.push({ micro: j, stage: k, ms: Date.now() - t0 });
          }
          if (check && rand() < check.share) {
            const ref = forward(check.model, x0, rpcs[0].from, rpcs[rpcs.length - 1].to, n);
            for (let i = 0; i < ref.length; i++) if (ref[i] !== a[i]) throw new Error(`micro-batch ${j}: a stage returned a wrong activation`);
          }
          results[j] = a;
        }
      };
      await Promise.all(Array.from({ length: Math.min(inFlight, jobs.length) }, worker));
      const outDim = results[0].length / jobs[0].n;
      const out = new Float32Array(batch * outDim);
      for (const [j, r] of results.entries()) out.set(r, jobs[j].s * outDim);
      this.timeline = timeline;
      return out;
    },
    close() { for (const s of rpcs) s.rpc.close(); },
  };
}
