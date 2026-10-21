// Similarity to known-bad code (src/similarity.js) and the unknown-pattern
// signal (src/analyze.js), on real compiled contracts (test/helpers/contracts.sol).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readContract } from '../src/reader.js';
import { explain } from '../src/explain.js';
import { THREAT_REASONS } from '../src/threat-reasons.js';
import { verdictOf } from '../src/verdict.js';
import { analyze } from '../src/analyze.js';
import { similaritySignature, closestFlagged, similarityPercent, severityFor, makeEntry, entrySource, maskedOpcodes } from '../src/similarity.js';
import { THREAT_SIGNATURES, ADDED } from '../src/threat-signatures.js';
import { SEEDS } from '../src/threat-signatures.generated.js';
import { buildThreatSignatures } from '../scripts/build-threat-signatures.js';
import { createLocalChain } from './helpers/local-chain.js';

const find = (r, id) => r.analysis.findings.find((f) => f.id === id);
const ids = (r) => r.analysis.findings.map((f) => f.id);
const seedFp = (name, optimize) => SEEDS.find((e) => e.source.includes(` ${name} `) && e.source.includes(optimize ? 'on)' : 'off)')).fingerprint;

test('committed dataset matches scripts/build-threat-signatures.js (run `npm run threat-signatures` if this fails)', async () => {
  const committed = readFileSync(new URL('../src/threat-signatures.generated.js', import.meta.url), 'utf8');
  assert.equal(await buildThreatSignatures(), committed);
  assert.equal(SEEDS.length, 10);
  for (const e of [...SEEDS, ...ADDED]) {
    assert.match(e.fingerprint, /^fp1:[0-9a-f]{64}$/);
    assert.equal(e.baseline, THREAT_SIGNATURES.baseline.id, `${e.source}: made against another baseline`);
    assert.equal(e.minhash.length, 128 * 8);
    assert.ok(THREAT_REASONS.slice(1).includes(e.reason));
  }
});

test('thresholds: low from 60%, medium from 75%, high from 90%', () => {
  assert.equal(severityFor(59), null);
  assert.equal(severityFor(60), 'low');
  assert.equal(severityFor(75), 'medium');
  assert.equal(severityFor(90), 'high');
  assert.equal(severityFor(100), 'high');
});

test('masking: PUSH data and metadata are not opcodes', () => {
  // PUSH2 ffff ; STOP ; metadata a1 ff ff 0003
  assert.deepEqual(maskedOpcodes('0x61ffff00a1ffff0003'), [0x61, 0x00]);
});

for (const optimize of [true, false]) {
  describe(`similarity (optimizer ${optimize ? 'on' : 'off'})`, () => {
    let chain;
    const read = (addr, opts = {}) => readContract('bsc', addr, { rpc: chain.rpc, ...opts });
    before(async () => { chain = await createLocalChain({ optimize }); });

    test('near-duplicate of a flagged honeypot: warned, though its fingerprint is new', async () => {
      const r = await read(await chain.deploy('QuietCopy'));
      const f = find(r, 'similar-flagged');
      assert.ok(f, 'warned');
      assert.notEqual(r.fingerprint, f.params.fingerprint, 'not an exact match');
      assert.equal(f.params.fingerprint, seedFp('QuietHoneypot', optimize));
      assert.equal(f.params.reason, 'cannot-sell-in-simulation');
      assert.ok(f.params.percent >= 60 && f.params.percent < 100, String(f.params.percent));
      assert.equal(f.severity, severityFor(f.params.percent));
      assert.match(explain(r, 'th').lines.find((l) => l.id === 'similar-flagged').text, /^โค้ดนี้คล้ายโค้ดที่ผู้รัน Neuro ติดธงไว้ \d+% \(ลายนิ้วมือ fp1:/);
      assert.match(explain(r, 'en').lines.find((l) => l.id === 'similar-flagged').text, /^This code is \d+% similar to code that Neuro runners flagged \(fingerprint fp1:/);
      assert.ok(!ids(r).includes('nothing-found'));
    });

    test('hidden mint with every function renamed: warned', async () => {
      const r = await read(await chain.deploy('HiddenCopy'));
      const f = find(r, 'similar-flagged');
      assert.equal(f.params.fingerprint, seedFp('HiddenPowers', optimize));
      assert.ok(['medium', 'high'].includes(f.severity));
    });

    test('exact copy of flagged code: 100%, high', async () => {
      const r = await read(await chain.deploy('ScamToken'));
      assert.deepEqual([find(r, 'similar-flagged').params.percent, find(r, 'similar-flagged').severity], [100, 'high']);
    });

    test('unrelated and honest contracts: no warning', async () => {
      for (const [name, args] of [['CleanToken'], ['RenouncedToken'], ['RolesToken'], ['FakeUSDT'], ['PhishToken'],
        ['ZetaStyleToken', '0'.repeat(63) + '1' + '0'.repeat(63) + '5'], ['TaxToken', '0'.repeat(128)], ['UpgradeableToken'], ['Drainer'], ['MockWETH']]) {
        const r = await read(await chain.deploy(name, args ?? ''));
        assert.ok(!ids(r).includes('similar-flagged'), `${name}: ${JSON.stringify(find(r, 'similar-flagged')?.params)}`);
      }
      const clean = await read(await chain.deploy('CleanToken'));
      assert.ok(ids(clean).includes('nothing-found'), 'a clean token still reads as clean');
    });

    test('deterministic: same code, same signature, same finding, same verdict', async () => {
      const a = await chain.deploy('QuietCopy');
      const code = await chain.rpc.call('eth_getCode', [a, 'latest']);
      assert.deepEqual(similaritySignature(code, THREAT_SIGNATURES.baseline), similaritySignature(code, THREAT_SIGNATURES.baseline));
      const r1 = await read(a);
      const r2 = await read(a);
      assert.deepEqual(r1.analysis, r2.analysis);
      assert.equal(r1.reportHash, r2.reportHash);
      assert.equal(await verdictOf(r1), await verdictOf(r2));
      // Another deployment of the same code (another address): same finding.
      const r3 = await read(await chain.deploy('QuietCopy'));
      assert.deepEqual(find(r3, 'similar-flagged'), find(r1, 'similar-flagged'));
      // It is part of the verdict runners agree on.
      const off = await read(a, { threatSignatures: false });
      assert.notEqual(await verdictOf(off), await verdictOf(r1));
    });

    test('a dataset entry made from a new flagged contract catches its copies', async () => {
      const code = await chain.rpc.call('eth_getCode', [await chain.deploy('HiddenCopy'), 'latest']);
      const entry = await makeEntry(code, THREAT_SIGNATURES.baseline, { reason: 'unlimited-mint', source: 'test' });
      const only = { baseline: THREAT_SIGNATURES.baseline, entries: [entry] };
      // what `node cli.js signature` prints is a valid entry, pasted as is
      const pasted = (0, eval)(`[\n${entrySource({ ...entry, source: "bsc 0xab… (it's a test)" })}\n]`)[0];
      assert.deepEqual(pasted, { ...entry, source: "bsc 0xab… (it's a test)" });
      const hp = await chain.rpc.call('eth_getCode', [await chain.deploy('HiddenPowers'), 'latest']);
      assert.ok(closestFlagged(hp, null, only).percent >= 60);
      // An entry made against another baseline is skipped, not misread.
      assert.equal(closestFlagged(hp, null, { ...only, entries: [{ ...entry, baseline: '00000000' }] }), null);
      const clean = await chain.rpc.call('eth_getCode', [await chain.deploy('CleanToken'), 'latest']);
      assert.equal(similaritySignature(clean, THREAT_SIGNATURES.baseline).n, 0, 'all boilerplate');
      assert.equal(closestFlagged(clean, null, only), null);
    });

    test('unknown pattern: unnamed functions that move value are not "nothing found"', async () => {
      const r = await read(await chain.deploy('Drainer'));
      const f = find(r, 'unknown-pattern');
      assert.equal(f.severity, 'low');
      assert.deepEqual(f.params, { count: 3, share: 100 });
      assert.ok(!ids(r).includes('nothing-found'));
      assert.match(explain(r, 'th').lines.find((l) => l.id === 'unknown-pattern').text, /^Neuro ยังไม่รู้จักรูปแบบนี้ ระวัง/);
      for (const name of ['CleanToken', 'ScamToken', 'HiddenPowers']) {
        assert.ok(!ids(await read(await chain.deploy(name))).includes('unknown-pattern'), name);
      }
    });
  });
}

test('unknown pattern needs both: mostly unnamed AND value-moving code', () => {
  const base = { hasCode: true, functions: [], proxy: { kind: null }, token: {}, owner: undefined };
  const sig = (input) => analyze({ ...base, ...input }).findings.find((f) => f.id === 'unknown-pattern');
  assert.ok(sig({ dispatched: 3, unknownSelectors: ['a', 'b', 'c'], opcodes: { call: true } }));
  assert.equal(sig({ dispatched: 3, unknownSelectors: ['a', 'b', 'c'], opcodes: {} }), undefined, 'cannot move value');
  assert.equal(sig({ dispatched: 10, unknownSelectors: ['a', 'b', 'c', 'd'], opcodes: { call: true } }), undefined, '40% unknown');
  assert.equal(sig({ dispatched: 1, unknownSelectors: ['a'], opcodes: { call: true } }), undefined, 'one function only');
  assert.ok(sig({ dispatched: 0, unknownSelectors: [], opcodes: { selfdestruct: true } }), 'no functions at all');
  assert.equal(sig({ unknownSelectors: ['a', 'b'], opcodes: { call: true } }), undefined, 'non-EVM input: not judged');
  assert.equal(sig({ dispatched: 2, unknownSelectors: ['a', 'b'], opcodes: { call: true }, proxy: { kind: 'eip1967' } }), undefined, 'proxy: judged by its implementation');
});

test('percent: boilerplate-only code is never compared', () => {
  const a = { selectors: ['11111111'], n: 3, minhash: 'ab'.repeat(512) };
  assert.equal(similarityPercent(a, a), 0);
  assert.equal(similarityPercent({ ...a, n: 20 }, { ...a, n: 20 }), 100);
});
