// Private identity prover (a classic Web Worker started by zkid.js). It is the only place the hub runs WebAssembly:
// vercel.json gives this one file a CSP with 'wasm-unsafe-eval' (a worker gets the CSP of its own script), so the
// pages keep script-src 'self' with no WebAssembly. snarkjs comes from vendor/snarkjs.min.js (pinned, same origin).
//   in:  { input, wasm: ArrayBuffer, zkey: ArrayBuffer }   (the page has checked both files' sha256)
//   out: { proof, publicSignals, ms }  |  { error }
// Single-threaded (no nested blob workers). The secret is in `input` only for the time of the proof; the worker
// keeps nothing and the page ends it after each proof.
/* global snarkjs, importScripts */
importScripts('vendor/snarkjs.min.js');

self.onmessage = async (e) => {
  const { input, wasm, zkey } = e.data ?? {};
  try {
    const t = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, { type: 'mem', data: new Uint8Array(wasm) }, { type: 'mem', data: new Uint8Array(zkey) },
      undefined, undefined, { singleThread: true });
    self.postMessage({ proof, publicSignals, ms: Math.round(performance.now() - t) });
  } catch (err) {
    self.postMessage({ error: String(err?.message ?? err).slice(0, 300) });
  }
};
