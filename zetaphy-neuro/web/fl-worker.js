// Web Worker for the federated-learning panel (web/fl-panel.js): local training,
// clipping, noise (crypto.getRandomValues) and encoding, off the page's main thread.
// Gets the model, the head and this browser's labelled examples; gives back only
// the encoded, clipped and noised update.
import { checkModel } from '../ml/model.js';
import { checkHead } from '../ml/fl/head.js';
import { roundUpdate } from '../ml/fl/client.js';

self.onmessage = (e) => {
  try {
    const { model, head, rows, round, privacy } = e.data ?? {};
    const m = checkModel(model);
    const h = checkHead(m, head);
    const r = roundUpdate(m, h, rows, { round, privacy });
    self.postMessage({ ok: true, bytes: r.bytes, n: r.n, dim: r.dim, norm: r.norm }, [r.bytes.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message ?? err).slice(0, 300) });
  }
};
