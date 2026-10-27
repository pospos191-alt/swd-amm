// Neuro rule engine: bytecode scanner, rule engine (analyze), explanations in
// every language, verdict hashing, opcode-pattern matching, ABI decoders.

import { scanBytecode, hexToBytes, codeLengthWithoutMetadata, minimalProxyTarget } from '../../zetaphy-neuro/src/bytecode.js';
import { SELECTORS } from '../../zetaphy-neuro/src/selectors.generated.js';
import { analyze, simFindings, withSimulation, SIM_TAX_HIGH, SIM_TAX_MEDIUM } from '../../zetaphy-neuro/src/analyze.js';
import { explain, LANGS, pickLang } from '../../zetaphy-neuro/src/explain.js';
import { verdictBody, verdictOf } from '../../zetaphy-neuro/src/verdict.js';
import { decodeAddress, decodeUint, decodeString } from '../../zetaphy-neuro/src/abi.js';
import { keccak256, selectorOf } from '../../zetaphy-neuro/src/keccak.js';
import { taxPercent } from '../../zetaphy-neuro/src/honeypot.js';
import { parseOpcodes, opcodesMatch } from '../../zetaphy-neuro/server/earlywarning.js';
import { keccak_256 } from '../../zetaphy-neuro/node_modules/@noble/hashes/sha3.js';
import { ok, eq } from '../lib/harness.mjs';
import { junkText, toHex } from '../lib/rng.mjs';

const RANK = { high: 3, medium: 2, low: 1, info: 0, good: 0 };
const ZERO = '0x' + '00'.repeat(20);
const BY_CAT = {};
for (const [sel, f] of Object.entries(SELECTORS)) (BY_CAT[f.cat] ??= []).push(sel);
const KNOWN = Object.keys(SELECTORS);
const DANGER = { 0xff: 'selfdestruct', 0xf4: 'delegatecall', 0xf2: 'callcode', 0xf5: 'create2', 0xf1: 'call', 0xf0: 'create' };
const POWER_IDS = { mint: 'can-mint', blacklist: 'can-blacklist', pause: 'can-pause', fee: 'can-change-fee', trading: 'trading-switch', limit: 'can-limit' };

/** Independent opcode walker: dangerous-opcode flags over [0, end). */
function refFlags(bytes, end) {
  const f = { selfdestruct: false, delegatecall: false, callcode: false, create2: false, call: false, create: false };
  for (let pc = 0; pc < end; pc++) {
    const op = bytes[pc];
    if (op >= 0x60 && op <= 0x7f) { pc += op - 0x5f; continue; }
    if (DANGER[op]) f[DANGER[op]] = true;
  }
  return f;
}
/** Selectors pushed with PUSH1..4 at instruction boundaries (what scanBytecode may name). */
function refPushed(bytes, end) {
  const out = new Set();
  for (let pc = 0; pc < end; pc++) {
    const op = bytes[pc];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n <= 4 && pc + n < bytes.length) out.add(toHex(bytes.subarray(pc + 1, pc + 1 + n)).padStart(8, '0'));
      pc += n;
    }
  }
  return out;
}

/** Random code: pure noise, or a stream of real instructions with PUSH data. */
function randomCode(R) {
  const len = R.int(R.bool(0.2) ? 40 : 700);
  if (R.bool(0.3)) return R.bytes(len);
  const out = [];
  while (out.length < len) {
    const r = R.float();
    if (r < 0.25) { const n = R.range(1, 32); out.push(0x5f + n, ...R.bytes(n)); }
    else if (r < 0.35) { out.push(0x63, ...Buffer.from(R.pick(KNOWN), 'hex'), R.pick([0x14, 0x81, 0x80])); if (R.bool()) out.push(0x14); }
    else if (r < 0.40) out.push(R.pick([0xff, 0xf4, 0xf2, 0xf5, 0xf1, 0xf0]));
    else out.push(R.int(256));
  }
  return Uint8Array.from(out.slice(0, Math.max(len, 0)));
}

// ------------------------------------------------------------------ N1
export const scanRandom = {
  group: 'Neuro', name: 'neuro/scanBytecode-random', count: 610,
  what: 'scanBytecode on random / instruction-shaped bytecode: never throws, flags match an independent opcode walker, selector lists sorted/consistent, metadata tail ignored, deterministic',
  gen(R) {
    const code = randomCode(R);
    const meta = R.bool(0.3) ? R.range(1, 60) : 0;
    return { code: toHex(code), meta, prefix: R.pick(['0x', '0X', '']), upper: R.bool(0.2), metaSeed: R.u32() };
  },
  check({ code, meta, prefix, upper, metaSeed }) {
    let full = code;
    if (meta) {
      // A CBOR-looking metadata blob (a2 ...), then its 2-byte length.
      const body = 'a2' + Buffer.from(Array.from({ length: meta - 1 }, (_, i) => (metaSeed >> (i % 24)) & 0xff)).toString('hex');
      full = code + body + meta.toString(16).padStart(4, '0');
    }
    const text = prefix + (upper ? full.toUpperCase() : full);
    const s = scanBytecode(text);
    const bytes = hexToBytes(text);
    eq(s.size, bytes.length, 'size');
    const end = codeLengthWithoutMetadata(bytes);
    ok(end <= bytes.length && end >= 0, 'metadata end within code');
    for (const [k, v] of Object.entries(refFlags(bytes, end))) eq(s.opcodes[k], v, `opcode flag ${k}`);
    if (meta && code.length) {
      // the metadata tail never changes what the code itself does
      const plain = refFlags(Buffer.from(code, 'hex'), code.length / 2);
      for (const [k, v] of Object.entries(plain)) eq(s.opcodes[k], v, `flag ${k} with metadata appended`);
    }
    const sorted = [...s.selectors].sort();
    eq(JSON.stringify(s.selectors), JSON.stringify(sorted), 'selectors sorted');
    eq(new Set(s.selectors).size, s.selectors.length, 'selectors unique');
    ok(s.selectors.every((x) => /^[0-9a-f]{8}$/.test(x)), 'selector format');
    eq(JSON.stringify(s.unknownSelectors), JSON.stringify(s.selectors.filter((x) => !SELECTORS[x])), 'unknownSelectors = dispatched minus known');
    const pushed = refPushed(bytes, end);
    for (const f of s.functions) {
      ok(SELECTORS[f.selector]?.sig === f.sig, `function ${f.selector} is a known selector`);
      ok(pushed.has(f.selector), `function ${f.selector} is really pushed by PUSH1-4`);
    }
    for (const sel of pushed) if (SELECTORS[sel]) ok(s.functions.some((f) => f.selector === sel), `pushed known selector ${sel} reported`);
    eq(JSON.stringify(scanBytecode(text)), JSON.stringify(s), 'deterministic');
  },
};

// ------------------------------------------------------------------ N2
/** A dispatcher: PUSH1 0 CALLDATALOAD PUSH1 e0 SHR, then (DUP1 PUSH4 sel [DUP2] EQ PUSH2 0 JUMPI)*, STOP. */
function dispatcher(sels, R) {
  const out = [0x60, 0x00, 0x35, 0x60, 0xe0, 0x1c];
  for (const s of sels) {
    out.push(0x80, 0x63, ...Buffer.from(s, 'hex'));
    if (R.bool(0.3)) out.push(0x81);
    out.push(0x14, 0x61, 0x00, 0x00, 0x57);
  }
  out.push(0x00);
  return out;
}
/** Bytes hidden inside PUSH32 data (never executed as instructions). */
function hidden(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 32) {
    const chunk = bytes.slice(i, i + 32);
    while (chunk.length < 32) chunk.push(0);
    out.push(0x7f, ...chunk, 0x50); // PUSH32 <data> POP
  }
  return out;
}
const unknownSel = (R) => { for (;;) { const s = R.hex(4); if (!SELECTORS[s] && !s.startsWith('00')) return s; } };

export const scanPlanted = {
  group: 'Neuro', name: 'neuro/scanBytecode-planted', count: 500,
  what: 'dispatcher entries are found (known named, unknown listed); selectors and dangerous opcodes hidden inside PUSH data are NOT reported',
  gen(R) {
    const n = R.range(0, 12);
    const sels = Array.from({ length: n }, () => (R.bool(0.6) ? R.pick(KNOWN) : unknownSel(R)));
    const hide = Array.from({ length: R.range(0, 6) }, () => (R.bool(0.6) ? R.pick(KNOWN) : unknownSel(R)));
    const realOps = R.shuffle([0xff, 0xf4, 0xf2, 0xf5, 0xf1, 0xf0]).slice(0, R.int(4));
    const hiddenOps = R.shuffle([0xff, 0xf4, 0xf2, 0xf5, 0xf1, 0xf0]).slice(0, R.int(6));
    return { sels, hide, realOps, hiddenOps, dup2: R.u32() };
  },
  check({ sels, hide, realOps, hiddenOps, dup2 }, ) {
    let seed = dup2;
    const R = { bool: () => ((seed = (seed * 1103515245 + 12345) >>> 0) & 0x100) !== 0 };
    const hidBytes = [];
    for (const h of hide) hidBytes.push(0x63, ...Buffer.from(h, 'hex'), 0x14); // looks like PUSH4 sel EQ, but is data
    hidBytes.push(...hiddenOps);
    const code = [...hidden(hidBytes), ...dispatcher(sels, R), ...realOps, 0x00, 0x00];
    const s = scanBytecode(toHex(Uint8Array.from(code)));
    const want = [...new Set(sels)].sort();
    eq(JSON.stringify(s.selectors), JSON.stringify(want), 'dispatched selectors');
    eq(JSON.stringify(s.unknownSelectors), JSON.stringify(want.filter((x) => !SELECTORS[x])), 'unknown selectors');
    const named = new Set(s.functions.map((f) => f.selector));
    for (const x of want) if (SELECTORS[x]) ok(named.has(x), `known ${x} named`);
    for (const x of hide) if (!sels.includes(x)) ok(!named.has(x) && !s.selectors.includes(x), `hidden ${x} not reported`);
    for (const [op, k] of Object.entries(DANGER)) eq(s.opcodes[k], realOps.includes(Number(op)), `${k} (real: ${realOps.includes(Number(op))})`);
  },
};

// ------------------------------------------------------------------ N3
/** analyze() input exactly as src/reader.js builds it from one scan. */
function analysisOf(codeHex, { owner, token }) {
  const s = scanBytecode(codeHex);
  return analyze({ hasCode: true, functions: s.functions, opcodes: s.opcodes, proxy: { kind: null }, token, owner,
    template: null, known: null, lookalike: null, unknownSelectors: s.unknownSelectors, threat: null, similar: null, dispatched: s.selectors.length });
}
const ERC20 = BY_CAT.erc20;
const SCAM_CATS = ['mint', 'blacklist', 'pause'];

export const scamVsBenign = {
  group: 'Neuro', name: 'neuro/scam-vs-benign', count: 600,
  what: 'synthesized tokens: owner-held mint/blacklist/pause, SELFDESTRUCT or a link in the name are flagged high; renounced plain ERC-20s are not; hiding the power in PUSH data, reordering the dispatcher or adding metadata are benign mutations',
  gen(R) {
    const kind = R.pick(['power', 'selfdestruct', 'link', 'benign', 'renounced-power']);
    const cat = R.pick(SCAM_CATS);
    const extra = R.shuffle(ERC20).slice(0, R.range(4, ERC20.length));
    const owner = '0x' + R.hex(20);
    const name = kind === 'link' ? `${R.pick(['Claim', 'Visit', 'Free'])} ${R.pick(['reward', 'drop', 'gift'])}${R.int(999)}.${R.pick(['com', 'xyz', 'io', 'site'])}` : R.str(R.range(1, 12), 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
    return { kind, cat, power: R.pick(BY_CAT[cat]), extra, owner, name, symbol: R.str(R.range(2, 6), 'ABCDEFGHJKLMNPQRSTUVWXYZ'), order: R.u32() };
  },
  check({ kind, cat, power, extra, owner, name, symbol, order }) {
    let seed = order;
    const R = { bool: () => ((seed = (seed * 1103515245 + 12345) >>> 0) & 0x100) !== 0 };
    const token = { name, symbol, decimals: 18, totalSupply: '1000000000000000000000000' };
    const sels = [...extra, ...(BY_CAT.ownership.slice(0, 1))];
    const tail = [0x00, 0x00];
    if (kind === 'benign') {
      const a = analysisOf(toHex(Uint8Array.from([...dispatcher(sels, R), ...tail])), { owner: ZERO, token });
      eq(a.level, 'info', `plain renounced ERC-20 level (findings ${a.findings.map((f) => f.id + ':' + f.severity)})`);
      ok(!a.findings.some((f) => RANK[f.severity] >= 2), 'no medium/high finding');
      return;
    }
    if (kind === 'renounced-power') {
      const a = analysisOf(toHex(Uint8Array.from([...dispatcher([...sels, power], R), ...tail])), { owner: ZERO, token });
      const f = a.findings.find((x) => x.id === POWER_IDS[cat]);
      ok(f && f.severity === 'low', `renounced ${cat} power reported as low, got ${f?.severity}`);
      ok(a.control === 'renounced', 'control renounced');
      return;
    }
    const scamSels = kind === 'power' ? [...sels, power] : sels;
    const real = [...dispatcher(R.bool() ? scamSels : [...scamSels].reverse(), R), ...(kind === 'selfdestruct' ? [0xff] : []), ...tail];
    const a = analysisOf(toHex(Uint8Array.from(real)), { owner, token });
    eq(a.level, 'high', `scam (${kind}) level`);
    const id = kind === 'power' ? POWER_IDS[cat] : kind === 'selfdestruct' ? 'selfdestruct' : 'name-has-link';
    ok(a.findings.some((f) => f.id === id && f.severity === 'high'), `${id} high`);
    // Mutation 1: same code + a metadata tail and the dispatcher reversed -> same verdict.
    const meta = [0xa2, 0x64, 0x69, 0x70, 0x66, 0x73, 0x00, 0x07];
    const real2 = [...dispatcher([...scamSels].reverse(), R), ...(kind === 'selfdestruct' ? [0xff] : []), 0x00, 0x00, ...meta];
    const b = analysisOf(toHex(Uint8Array.from(real2)), { owner, token });
    eq(JSON.stringify(b.findings.map((f) => f.id + ':' + f.severity).sort()), JSON.stringify(a.findings.map((f) => f.id + ':' + f.severity).sort()), 'reordered + metadata gives the same findings');
    // Mutation 2: the dangerous part moved into PUSH data (never executed) -> finding gone.
    if (kind !== 'link') {
      const hid = kind === 'power' ? [0x63, ...Buffer.from(power, 'hex'), 0x14] : [0xff];
      const benign = [...hidden(hid), ...dispatcher(sels, R), ...tail];
      const c = analysisOf(toHex(Uint8Array.from(benign)), { owner, token });
      ok(!c.findings.some((f) => f.id === id), `${id} not reported when only inside PUSH data`);
    }
  },
};

// ------------------------------------------------------------------ N4
const FN_CATS = Object.keys(BY_CAT);
function randomInput(R) {
  if (R.bool(0.03)) return { hasCode: false };
  const fns = R.shuffle(KNOWN).slice(0, R.int(14)).map((s) => ({ selector: s, ...SELECTORS[s] }));
  const ownerPick = R.int(4);
  const owner = ownerPick === 0 ? undefined : ownerPick === 1 ? ZERO : ownerPick === 2 ? null : '0x' + R.hex(20);
  const proxyKind = R.pick([null, null, null, 'eip1967', 'beacon', 'eip1167', 'zos']);
  const unknown = Array.from({ length: R.int(6) }, () => R.hex(4));
  const op = () => R.bool(0.2);
  const token = R.bool(0.8) ? { name: R.bool(0.9) ? junkText(R, 20) : undefined, symbol: R.bool(0.9) ? junkText(R, 8) : undefined, decimals: R.range(0, 30), totalSupply: R.big(R.range(1, 256)).toString() } : undefined;
  return {
    hasCode: true, functions: fns,
    opcodes: { selfdestruct: op(), delegatecall: op(), callcode: op(), create2: op(), call: op(), create: op() },
    proxy: proxyKind ? { kind: proxyKind, implementation: '0x' + R.hex(20), admin: R.bool() ? '0x' + R.hex(20) : undefined } : { kind: null },
    token,
    owner,
    template: R.bool(0.1) ? { project: 'P' + R.int(9), name: 'T' + R.int(9), guarantees: R.shuffle(['no-mint', 'no-blacklist', 'no-pause', 'tax-decrease-only']).slice(0, R.int(5)) } : null,
    known: R.bool(0.08) ? { symbol: 'USDX', issuer: 'Issuer', kind: 'stable', address: '0x' + R.hex(20) } : null,
    // reader.js looks for a lookalike only when the token has a symbol (lookalikeOf(chain, addr, token.symbol))
    lookalike: token?.symbol && R.bool(0.05) ? { symbol: token.symbol, issuer: 'Issuer', address: '0x' + R.hex(20) } : null,
    unknownSelectors: unknown,
    threat: R.bool(0.05) ? { flagged: true, reason: R.pick(['unlimited-mint', 'other', undefined]) } : null,
    similar: R.bool(0.1) ? { percent: R.range(60, 100), severity: R.pick(['low', 'medium', 'high']), fingerprint: 'fp1:' + R.hex(32), flagged: R.bool() } : null,
    dispatched: R.bool(0.8) ? fns.length + unknown.length + R.int(3) : undefined,
    source: R.pick([undefined, null, { match: 'full', language: 'Solidity', compiler: '0.8.26', name: 'X', url: 'https://x' }]),
  };
}

export const analyzeInvariants = {
  group: 'Neuro', name: 'neuro/analyze-invariants', count: 600,
  what: 'analyze() on random reader inputs: never throws; level = max finding severity; deterministic; caveat last; renounced => no power above low; selfdestruct => high; known issuer caps powers; withSimulation keeps rulesLevel',
  gen(R) { return { input: randomInput(R), sim: R.bool(0.5) ? { stage: R.pick(['done', 'done', 'sell-failed', 'no-pool', 'buy-failed', 'weird']), buyTax: R.bool(0.9) ? R.int(101) : null, sellTax: R.bool(0.9) ? R.int(101) : null, bought: R.pick(['0', '5']), sold: R.pick(['0', '7', '9']), dex: 'd', native: 'n' } : null }; },
  check({ input, sim }) {
    const a = analyze(structuredClone(input));
    const b = analyze(structuredClone(input));
    eq(JSON.stringify(a), JSON.stringify(b), 'deterministic');
    const max = a.findings.reduce((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), 'info');
    eq(a.level, max, 'level is the highest severity');
    ok(a.findings.every((f) => f.severity in RANK), 'known severities');
    if (!input.hasCode) { eq(a.findings[0].id, 'no-code', 'no code'); return; }
    eq(a.findings.at(-1).id, 'bytecode-only', 'caveat is last');
    if (input.opcodes.selfdestruct) ok(a.findings.some((f) => f.id === 'selfdestruct' && f.severity === 'high') && a.level === 'high', 'selfdestruct is high');
    if (a.control === 'renounced') {
      for (const id of Object.values(POWER_IDS)) {
        const f = a.findings.find((x) => x.id === id);
        if (f) ok(RANK[f.severity] <= 1, `${id} under renounced ownership is at most low (got ${f.severity})`);
      }
    }
    if (input.known) {
      for (const id of [...Object.values(POWER_IDS), 'proxy-upgradeable', 'roles', 'owner-unknown']) {
        const f = a.findings.find((x) => x.id === id);
        if (f) ok(RANK[f.severity] <= 1, `${id} of a known issuer is capped at low (got ${f.severity})`);
      }
    }
    const nothing = a.findings.some((f) => f.id === 'nothing-found');
    if (nothing) ok(!a.findings.some((f) => f.id !== 'nothing-found' && (RANK[f.severity] > 0 || f.severity === 'good') && f.id !== 'source-verified'), '"nothing found" only when nothing was found');
    if (sim) {
      const w = withSimulation(a, sim);
      const extra = simFindings(sim);
      eq(w.findings.length, a.findings.length + extra.length, 'sim findings added');
      eq(w.findings.at(-1).id, 'bytecode-only', 'caveat still last');
      ok(RANK[w.level] >= RANK[a.level], 'simulation never lowers the level');
      if (extra.length) eq(w.rulesLevel, a.level, 'rulesLevel keeps the rules level');
      if (sim.stage === 'done' && sim.buyTax != null && sim.sellTax != null && sim.sold !== '0') {
        const worst = Math.max(sim.buyTax, sim.sellTax);
        const sev = extra[0].severity;
        if (sim.sellTax >= 99 || worst > SIM_TAX_HIGH) eq(sev, 'high', 'big tax is high');
        else if (worst >= SIM_TAX_MEDIUM) eq(sev, 'medium', 'tax >= 10% is medium');
        else eq(sev, 'good', 'small tax is ok');
      }
    }
  },
};

// ------------------------------------------------------------------ N5
const LANG_CODES = Object.keys(LANGS);
const ALL_IDS = new Set(Object.keys(LANGS.en.T));
export const explainAll = {
  group: 'Neuro', name: 'neuro/explain-9-languages', count: 540,
  what: 'explain() for random analyses in all 9 languages: every line has non-empty text from a real template (no raw id, no "undefined"/"NaN"/"[object"), a title for every level, same ids/severities in every language',
  gen(R, i) { return { lang: LANG_CODES[i % LANG_CODES.length], input: randomInput(R), sim: R.bool(0.4) ? { stage: R.pick(['done', 'sell-failed', 'no-pool', 'no-override']), buyTax: R.int(101), sellTax: R.int(101), bought: R.pick(['0', '5']), sold: R.pick(['0', '7']), dex: 'PancakeSwap', native: 'BNB' } : null }; },
  check({ lang, input, sim }) {
    let analysis = analyze(input);
    if (sim) analysis = withSimulation(analysis, sim);
    const report = { analysis };
    const e = explain(report, lang);
    const en = explain(report, 'en');
    ok(typeof e.title === 'string' && e.title.length > 0, `title for level ${analysis.level}`);
    eq(e.lines.length, analysis.findings.length, 'one line per finding');
    eq(JSON.stringify(e.lines.map((l) => l.id + l.severity)), JSON.stringify(en.lines.map((l) => l.id + l.severity)), 'same ids and order as English');
    for (const l of e.lines) {
      ok(ALL_IDS.has(l.id), `finding id ${l.id} has an English template`);
      ok(typeof l.text === 'string' && l.text.trim().length > 0, `non-empty text for ${l.id}`);
      ok(l.text !== l.id, `text for ${l.id} is not the raw id`);
      ok(!/\bundefined\b|\bNaN\b|\[object /.test(l.text), `no undefined/NaN in ${lang} text for ${l.id}: ${l.text.slice(0, 200)}`);
    }
    eq(pickLang(lang), lang, 'language supported');
  },
};

// ------------------------------------------------------------------ N6
export const verdictProps = {
  group: 'Neuro', name: 'neuro/verdict', count: 400,
  what: 'verdict hash: deterministic, 32-byte hex, independent of finding/function order, address case and simulation results; changes when a rule finding, the owner or the chain changes',
  gen(R) {
    return { input: randomInput(R), chain: R.pick(['ethereum', 'bsc', 'base', 'arbitrum', 'zetaphy']), address: '0x' + R.hex(20), fp: R.bool() ? 'fp1:' + R.hex(32) : null, sim: { stage: 'done', buyTax: R.int(100), sellTax: R.int(100), bought: '5', sold: '7', dex: 'd', native: 'n' }, flip: R.int(3) };
  },
  async check({ input, chain, address, fp, sim, flip }) {
    const analysis = analyze(input);
    const report = { chain, address, analysis, functions: (input.functions ?? []).map((f) => f.sig), unknownSelectors: input.unknownSelectors ?? [], fingerprint: fp, owner: input.owner };
    const v1 = await verdictOf(report);
    ok(/^0x[0-9a-f]{64}$/.test(v1), 'verdict format');
    eq(await verdictOf(structuredClone(report)), v1, 'deterministic');
    const shuffled = { ...report, address: address.toUpperCase().replace('0X', '0x'), analysis: { ...analysis, findings: [...analysis.findings].reverse() }, functions: [...report.functions].reverse(), unknownSelectors: [...report.unknownSelectors].reverse() };
    eq(await verdictOf(shuffled), v1, 'order and address case do not matter');
    eq(await verdictOf({ ...report, analysis: withSimulation(analysis, sim) }), v1, 'simulation findings are left out');
    let changed;
    if (flip === 0) changed = { ...report, analysis: { ...analysis, findings: [...analysis.findings, { id: 'selfdestruct', severity: 'high', params: {} }] } };
    else if (flip === 1) changed = { ...report, owner: '0x' + 'ab'.repeat(20) === String(report.owner).toLowerCase() ? '0x' + 'cd'.repeat(20) : '0x' + 'ab'.repeat(20) };
    else changed = { ...report, chain: chain + '-x' };
    ok(await verdictOf(changed) !== v1, `verdict changes when ${['a finding', 'the owner', 'the chain'][flip]} changes`);
    const body = verdictBody(report);
    ok(body.findings.every((f) => !f.startsWith('sim-')), 'no sim in body');
  },
};

// ------------------------------------------------------------------ N7: opcode patterns
const OPN = ['ORIGIN', 'EQ', 'CALLER', 'SLOAD', 'SSTORE', 'JUMPI', 'ISZERO', 'CALL', 'PUSH*', 'DUP*', 'SWAP*', 'AND', 'ADD', 'SELFDESTRUCT', 'LOG*', 'MSTORE'];
const OPC = { ORIGIN: [0x32, 0x32], EQ: [0x14, 0x14], CALLER: [0x33, 0x33], SLOAD: [0x54, 0x54], SSTORE: [0x55, 0x55], JUMPI: [0x57, 0x57], ISZERO: [0x15, 0x15], CALL: [0xf1, 0xf1], 'PUSH*': [0x5f, 0x7f], 'DUP*': [0x80, 0x8f], 'SWAP*': [0x90, 0x9f], AND: [0x16, 0x16], ADD: [0x01, 0x01], SELFDESTRUCT: [0xff, 0xff], 'LOG*': [0xa0, 0xa4], MSTORE: [0x52, 0x52] };
/** Brute-force reference: try every start and every gap length (exponential, fine for short inputs). */
function refMatch(ops, words) {
  const go = (i, t) => {
    if (t === words.length) return true;
    const w = words[t];
    if (w === '*') { for (let k = 0; k <= 8 && i + k <= ops.length; k++) if (go(i + k, t + 1)) return true; return false; }
    if (i >= ops.length) return false;
    if (w === '?') return go(i + 1, t + 1);
    const [lo, hi] = OPC[w];
    return ops[i] >= lo && ops[i] <= hi && go(i + 1, t + 1);
  };
  for (let i = 0; i < ops.length; i++) if (go(i, 0)) return true;
  return false;
}
export const opcodePatterns = {
  group: 'Neuro', name: 'neuro/early-warning-opcodes', count: 400,
  what: 'early-warning opcode patterns (?, *, families) against a brute-force matcher on random opcode lists, incl. planted matches',
  gen(R) {
    const len = R.int(60);
    const vocab = Object.values(OPC).flatMap(([lo, hi]) => [lo, hi]);
    const ops = Array.from({ length: len }, () => (R.bool(0.8) ? R.pick(vocab) : R.int(256)));
    const n = R.range(2, 6);
    const words = Array.from({ length: n }, (_, k) => (k > 0 && k < n - 1 && R.bool(0.2) ? '*' : R.bool(0.15) ? '?' : R.pick(OPN)));
    if (R.bool(0.4) && len > 0) {
      // plant one occurrence of the pattern
      const at = R.int(len);
      let j = at;
      for (const w of words) {
        if (w === '*') { j += R.int(3); continue; }
        if (j >= ops.length) break;
        if (w !== '?') { const [lo, hi] = OPC[w]; ops[j] = lo + R.int(hi - lo + 1); }
        j++;
      }
    }
    return { ops, words };
  },
  check({ ops, words }) {
    const tokens = parseOpcodes(words.join(' '));
    eq(opcodesMatch(Uint8Array.from(ops), tokens), refMatch(ops, words), `match of "${words.join(' ')}"`);
  },
};

// ------------------------------------------------------------------ N8: ABI decoders, hex, keccak, tax
const ABI_STR = (bytes) => {
  const h = toHex(bytes);
  return '0x' + (32).toString(16).padStart(64, '0') + bytes.length.toString(16).padStart(64, '0') + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
};
export const decoders = {
  group: 'Neuro', name: 'neuro/abi-hex-keccak-tax', count: 250,
  what: 'ABI string/uint/address decoders round-trip and never throw on random hex; hexToBytes round-trip and rejects junk; keccak256 = @noble/hashes; minimal-proxy round trip and 1-byte mutation; taxPercent bounds and monotonicity',
  gen(R) {
    const text = junkText(R, 30).replace(/[\ud800-\udfff]/g, '');
    return { kind: R.pick(['str', 'uint', 'junk', 'hex', 'keccak', 'proxy', 'tax']), text, n: R.big(R.range(1, 256)), junk: R.hex(R.int(200)), msg: R.hex(R.int(300)), target: R.hex(20), pos: R.int(45), e: R.spread(120), g: R.spread(120) };
  },
  check({ kind, text, n, junk, msg, target, pos, e, g }) {
    if (kind === 'str') {
      const bytes = new TextEncoder().encode(text);
      // TextDecoder drops one leading U+FEFF (a BOM) by design; cleanText would remove it anyway.
      eq(decodeString(ABI_STR(bytes)), text.replace(/^\ufeff/, ''), 'string round trip');
    } else if (kind === 'uint') {
      const w = '0x' + n.toString(16).padStart(64, '0');
      eq(decodeUint(w), n, 'uint round trip');
      eq(decodeAddress(w), '0x' + n.toString(16).padStart(64, '0').slice(24), 'address = low 20 bytes');
    } else if (kind === 'junk') {
      for (const h of ['0x' + junk, junk]) { decodeString(h); decodeUint(h); decodeAddress(h); }
    } else if (kind === 'hex') {
      const b = hexToBytes('0x' + msg);
      eq(toHex(b), msg, 'hex round trip');
      let threw = false;
      try { hexToBytes('0x' + msg + 'g'); } catch { threw = true; }
      ok(threw, 'non-hex rejected');
    } else if (kind === 'keccak') {
      const b = Buffer.from(msg, 'hex');
      eq(toHex(keccak256(b)), toHex(keccak_256(b)), 'keccak256 differential');
      const sig = `f${msg.slice(0, 6)}(uint256)`;
      eq(selectorOf(sig), toHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8), 'selector');
    } else if (kind === 'proxy') {
      const code = `363d3d373d3d3d363d73${target}5af43d82803e903d91602b57fd5bf3`;
      eq(minimalProxyTarget(hexToBytes(code)), '0x' + target, 'EIP-1167 target');
      const b = hexToBytes(code);
      const p = pos < 10 ? pos : pos + 20; // a byte outside the target
      if (p < b.length) { b[p] ^= 0x01; eq(minimalProxyTarget(b), null, 'mutated clone is not a clone'); }
    } else {
      const t = taxPercent(e, g);
      ok(t >= 0 && t <= 100, `tax in [0,100]: ${t}`);
      if (g >= e) eq(t, 0, 'no loss, no tax');
      const t2 = taxPercent(e, g / 2n);
      ok(t2 >= t, `less received never means less tax (${t2} < ${t})`);
    }
  },
};

export default [scanRandom, scanPlanted, scamVsBenign, analyzeInvariants, explainAll, verdictProps, opcodePatterns, decoders];
