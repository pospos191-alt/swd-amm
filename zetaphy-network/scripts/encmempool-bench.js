#!/usr/bin/env node
// Benchmarks for the encrypted-mempool prototype (src/encmempool): ciphertext
// overhead per tx, encrypt/decrypt time, share and release sizes, per-block and
// per-epoch overhead for n = 4, 21, 100. Sizes are exact (they come from the real
// encoders); times are this machine, pure-JS crypto (@noble/post-quantum), single
// thread, so read them as an upper bound for a Go implementation.
//
//   node scripts/encmempool-bench.js [n ...]     (default 4 21 100; ~1-2 min)

import {
  drbg, makeValidator, publicValidator, defaultThreshold, createDealing, openDealing, encryptTx, verifyEnvelope,
  decodeEnvelope, decryptEnvelope, payerFromSeed, batchHash, createRelease, verifyRelease, reconstructSeeds, releaseBytes,
  kemKeygen, KEM_CIPHERTEXT_BYTES, KEM_PUBLIC_KEY_BYTES, MAX_ENVELOPE_BYTES,
} from '../src/encmempool/index.js';

const CHAIN = 'zetaphy_9369-1';
const ns = process.argv.slice(2).map(Number).filter((x) => x > 0);
const SIZES = ns.length ? ns : [4, 21, 100];
const EPOCH = 32; // blocks per dealing epoch
const D = 3; // dealers per epoch

function time(fn, iters) {
  fn(); // warm up
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}
const ms = (x) => `${x.toFixed(2)} ms`;
const kb = (x) => `${(x / 1024).toFixed(1)} KiB`;
function table(rows) {
  const keys = Object.keys(rows[0]);
  const w = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length)));
  const line = (cells) => '| ' + cells.map((c, i) => String(c).padEnd(w[i])).join(' | ') + ' |';
  console.log(line(keys));
  console.log('|' + w.map((x) => '-'.repeat(x + 2)).join('|') + '|');
  for (const r of rows) console.log(line(keys.map((k) => r[k])));
  console.log('');
}

const rng = drbg('bench');
const payer = payerFromSeed(rng(32), { deterministic: false });

// ---- 1. per-tx ciphertext overhead (exact sizes)
console.log('1. Envelope size per tx (exact). Fixed part = header + payer ML-DSA-44 key (1312) + signature (2420);');
console.log(`   each dealer adds one X-Wing ciphertext (${KEM_CIPHERTEXT_BYTES} B); payload padded to 256 B + 16 B GCM tag.\n`);
const sizeRows = [];
for (const d of [1, 3, 5]) {
  const keys = Array.from({ length: d }, (_, i) => ({ dealer: i, ek: kemKeygen(rng(32)).publicKey }));
  for (const txLen of [110, 250, 600]) {
    const env = encryptTx({ chainId: CHAIN, height: 1n, epoch: 0, keys, fee: 1n, gasLimit: 21000, payer, tx: new Uint8Array(txLen), rng });
    sizeRows.push({ dealers: d, 'plain tx (B)': txLen, 'envelope (B)': env.length, 'overhead (B)': env.length - txLen, 'x plain': (env.length / txLen).toFixed(1) });
  }
}
table(sizeRows);
console.log(`   Note: a plain ML-DSA-44 ZETAPHY tx already carries a 2420 B signature (+1312 B key on first use), so the`);
console.log(`   marginal cost vs. a plain PQ tx is mostly the ${KEM_CIPHERTEXT_BYTES} B per dealer. Max envelope: ${MAX_ENVELOPE_BYTES} B.\n`);

// ---- 2. client / node time per tx (d = 3)
const keys3 = Array.from({ length: D }, (_, i) => { const k = kemKeygen(rng(32)); return { dealer: i, ek: k.publicKey, seed: k.secretKey }; });
const seeds3 = new Map(keys3.map((k) => [k.dealer, k.seed]));
const tx = new Uint8Array(250);
const sample = encryptTx({ chainId: CHAIN, height: 1n, epoch: 0, keys: keys3, fee: 1n, gasLimit: 21000, payer, tx, rng });
const rules = { chainId: CHAIN, height: 1n, epoch: 0, dealers: [0, 1, 2] };
const decoded = decodeEnvelope(sample);
console.log(`2. Time per tx (d = ${D}, 250 B tx, pure JS on this machine)\n`);
table([
  { step: 'client: encrypt + ML-DSA sign envelope', time: ms(time(() => encryptTx({ chainId: CHAIN, height: 1n, epoch: 0, keys: keys3, fee: 1n, gasLimit: 21000, payer, tx, rng }), 10)) },
  { step: 'node: CheckTx/ProcessProposal (decode + ML-DSA verify)', time: ms(time(() => verifyEnvelope(sample, rules), 10)) },
  { step: `node: decrypt with rebuilt keys (${D} X-Wing decaps + AES-GCM)`, time: ms(time(() => decryptEnvelope(decoded, seeds3), 10)) },
]);

// ---- 3. per n: dealing, release, reconstruction, per-block overhead
console.log(`3. Committee costs (d = ${D} dealers, epoch = ${EPOCH} blocks, t = floor(2n/3)+1)\n`);
const rows = [];
const timing = [];
for (const n of SIZES) {
  const t = defaultThreshold(n);
  const vr = drbg(`bench-n${n}`);
  const vs = Array.from({ length: n }, (_, i) => makeValidator(i, vr(32)));
  const committee = vs.map(publicValidator);
  let dealing;
  const tDeal = time(() => { dealing = createDealing({ chainId: CHAIN, epoch: 0, startHeight: 1n, length: EPOCH, t, committee, dealer: vs[0], rng: vr }).dealing; }, 1);
  const tOpen = time(() => openDealing(dealing, vs[1]), 3);
  const dealings = [dealing, ...Array.from({ length: D - 1 }, (_, i) => createDealing({ chainId: CHAIN, epoch: 0, startHeight: 1n, length: EPOCH, t, committee, dealer: vs[i + 1], rng: vr }).dealing)];
  const opened = vs.map((v) => new Map(dealings.map((d) => [d.dealer, openDealing(d, v).shares])));
  const bh = batchHash(CHAIN, 1n, [new Uint8Array(32)]);
  const rel = vs.map((v) => createRelease({ chainId: CHAIN, height: 1n, batchHash: bh, dealings, myShares: opened[v.index], me: v }));
  const ctx = { chainId: CHAIN, committee, dealings, height: 1n, batchHash: bh };
  const tVerifyOne = time(() => verifyRelease(rel[0], ctx), 5);
  const tVerifyAll = time(() => rel.slice(0, t).forEach((r) => verifyRelease(r, ctx)), 1);
  const tRebuild = time(() => reconstructSeeds({ releases: rel, dealings, height: 1n, t }), 3);
  const relSize = releaseBytes(CHAIN.length, D);
  const perEpochDealing = dealing.bytes.length * D;
  rows.push({
    n, t,
    'release / validator / block': `${relSize} B`,
    'releases per block (n)': kb(relSize * n),
    'min. needed (t)': kb(relSize * t),
    'one dealing': kb(dealing.bytes.length),
    [`dealings per epoch (x${D})`]: kb(perEpochDealing),
    'amortised per block': kb(perEpochDealing / EPOCH + relSize * n),
    'per-tx share alt. (B/tx)': n * (KEM_CIPHERTEXT_BYTES + 32),
  });
  timing.push({
    n,
    'create 1 dealing': ms(tDeal),
    'open own blob': ms(tOpen),
    'verify 1 release': ms(tVerifyOne),
    'verify t releases': ms(tVerifyAll),
    [`rebuild ${D} keys (t shares)`]: ms(tRebuild),
  });
}
table(rows);
table(timing);
console.log('   "release / validator / block" = shares for every dealer (32 B each) + ML-DSA-44 signature (2420 B).');
console.log('   Inside a vote extension the ML-DSA vote signature already exists, but it covers the block, not the shares;');
console.log('   signing the shares separately is what makes them post-quantum authenticated (+2420 B).');
console.log(`   "per-tx share alt." = size each tx would need if users Shamir-shared their own key to all n validators`);
console.log(`   (no dealers, X-Wing ciphertext + 32 B share per validator): the dealer-free option, see the doc.`);
console.log(`   Public key per height per dealer: ${KEM_PUBLIC_KEY_BYTES} B (wallets fetch ${D * KEM_PUBLIC_KEY_BYTES} B per target height).`);
