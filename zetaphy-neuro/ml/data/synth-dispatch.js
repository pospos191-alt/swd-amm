// Fast synthetic rows from tests-10k's scam-vs-benign generator
// (tests-10k/neuro/engine.mjs `scamVsBenign.gen`): a function dispatcher made
// of known ERC-20 selectors plus an owner power, SELFDESTRUCT, or a link in
// the name. No function bodies, so these rows are structurally unlike real
// code; they get a low training weight and are kept apart in the metrics.

import { scanBytecode } from '../../src/bytecode.js';
import { analyze } from '../../src/analyze.js';
import { extractFeatures } from '../features.js';
import { scamVsBenign } from '../../../tests-10k/neuro/engine.mjs';
import { rng } from '../lib/rng.js';
import { sparse } from '../lib/pipeline.js';

const ZERO = '0x' + '00'.repeat(20);
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The dispatcher shape tests-10k builds: PUSH4 sel [DUP2] EQ PUSH2 0 JUMPI per function. */
function dispatcher(sels, R) {
  const out = [0x60, 0x00, 0x35, 0x60, 0xe0, 0x1c];
  for (const s of sels) {
    out.push(0x80, 0x63, ...Array.from({ length: 4 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16)));
    if (R.bool(0.3)) out.push(0x81);
    out.push(0x14, 0x61, 0x00, 0x00, 0x57);
  }
  out.push(0x00);
  return out;
}

/** n rows, deterministic for a seed. */
export function dispatchRows(n, seed = 'neuro-ml-dispatch') {
  const R = rng(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const g = scamVsBenign.gen(R);
    const sels = [...g.extra, '8da5cb5b'];
    const scam = g.kind === 'power' || g.kind === 'selfdestruct' || g.kind === 'link';
    const owner = g.kind === 'benign' || g.kind === 'renounced-power' ? ZERO : g.owner;
    const withPower = g.kind === 'power' || g.kind === 'renounced-power' ? [...sels, g.power] : sels;
    const code = toHex(Uint8Array.from([...dispatcher(withPower, R), ...(g.kind === 'selfdestruct' ? [0xff] : []), 0x00, 0x00]));
    const s = scanBytecode(code);
    const token = { name: g.name, symbol: g.symbol, decimals: 18, totalSupply: '1000000000000000000000000' };
    const analysis = analyze({ hasCode: true, functions: s.functions, opcodes: s.opcodes, proxy: { kind: null }, token, owner,
      template: null, known: null, lookalike: null, unknownSelectors: s.unknownSelectors, threat: null, similar: null, dispatched: s.selectors.length });
    const report = { analysis, functions: s.functions.map((f) => f.sig).sort(), unknownSelectors: s.unknownSelectors, proxy: { kind: null }, owner };
    const f = extractFeatures({ report, code });
    rows.push({ id: `d10k-${i}`, label: scam ? 1 : 0, family: `t10k-${g.kind}`, mutations: [], src: 'tests-10k', weight: 0.3,
      rulesLevel: analysis.level, level: analysis.level, sim: null, f: sparse(f) });
  }
  return rows;
}
