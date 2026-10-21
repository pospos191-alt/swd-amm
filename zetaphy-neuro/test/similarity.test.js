// Similarity to known-bad code (src/similarity.js) and the unknown-pattern
// signal (src/analyze.js), on real compiled contracts (test/helpers/contracts.sol).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readContract } from '../src/reader.js';
import { explain, LANGS } from '../src/explain.js';
import { THREAT_REASONS } from '../src/threat-reasons.js';
import { verdictOf } from '../src/verdict.js';
import { analyze } from '../src/analyze.js';
import { readdirSync } from 'node:fs';
import { similaritySignature, closestFlagged, similarityPercent, severityFor, makeEntry, entrySource, maskedOpcodes, hasFlagRef, buildBaseline, loadBaseline } from '../src/similarity.js';
import { THREAT_SIGNATURES, ADDED } from '../src/threat-signatures.js';
import { buildThreatSignatures, BASELINE_FILE, SAMPLES_FILE, BASELINE_CONTRACTS } from '../scripts/build-threat-signatures.js';
import { createLocalChain } from './helpers/local-chain.js';
import { SAMPLES, FLAGGED, REFERENCE_SAMPLES, fakeFlag } from './helpers/test-signatures.js';

const find = (r, id) => r.analysis.findings.find((f) => f.id === id);
const ids = (r) => r.analysis.findings.map((f) => f.id);
const similar = (r) => r.analysis.findings.find((f) => f.id === 'similar-flagged' || f.id === 'similar-reference');
const sampleFp = (name, optimize) => REFERENCE_SAMPLES.find((e) => e.source.includes(` ${name} `) && e.source.includes(optimize ? 'on)' : 'off)')).fingerprint;
// "flagged" wording, in every language that has it (the reference wording must never use it)
const FLAGGED_WORDS = /flagged|ติดธง|标记|フラグ|플래그|gắn cờ|ditandai/;

test('committed baseline and test samples match scripts/build-threat-signatures.js (run `npm run threat-signatures` if this fails)', async () => {
  const built = await buildThreatSignatures();
  assert.equal(built.baseline, readFileSync(BASELINE_FILE, 'utf8'));
  assert.equal(built.samples, readFileSync(SAMPLES_FILE, 'utf8'));
  assert.equal(REFERENCE_SAMPLES.length, 10);
  for (const e of [...REFERENCE_SAMPLES, ...ADDED]) {
    assert.match(e.fingerprint, /^fp1:[0-9a-f]{64}$/);
    assert.equal(e.baseline, THREAT_SIGNATURES.baseline.id, `${e.source}: made against another baseline`);
    assert.equal(e.minhash.length, 128 * 8);
    assert.ok(THREAT_REASONS.slice(1).includes(e.reason));
  }
  // the test samples were never flagged by anyone: no on-chain reference
  assert.ok(REFERENCE_SAMPLES.every((e) => e.flag === null && !hasFlagRef(e)));
  // the baseline covers the common OpenZeppelin-style patterns
  for (const n of ['OZPausableToken', 'OZPermitToken', 'OZBurnableToken', 'OZCappedToken', 'OZOwnable2StepToken', 'OZAccessControlToken', 'OZBlacklistToken']) {
    assert.ok(BASELINE_CONTRACTS.includes(n), n);
  }
});

test('the production dataset ships EMPTY: test contracts are not flagged code', async () => {
  assert.deepEqual(ADDED, []);
  assert.deepEqual(THREAT_SIGNATURES.entries, []);
  // every real entry must name its on-chain flag (or it is only a reference sample)
  for (const e of ADDED) assert.ok(e.flag === null || hasFlagRef(e), e.source);
  // nothing under src/ (what the skill id hashes) carries the test samples
  for (const f of readdirSync(new URL('../src/', import.meta.url))) {
    if (!f.endsWith('.js')) continue;
    const text = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!REFERENCE_SAMPLES.some((e) => text.includes(e.fingerprint)), `${f} ships a test sample`);
    assert.ok(!/test\/helpers\/contracts\.sol (ScamToken|QuietHoneypot|NotLaunched|HiddenPowers|Killable)/.test(text), `${f} names a test contract as data`);
  }
  // so a read with the default dataset never says "similar"
  const chain = await createLocalChain();
  for (const name of ['QuietCopy', 'HiddenCopy', 'ScamToken']) {
    const r = await readContract('bsc', await chain.deploy(name), { rpc: chain.rpc });
    assert.equal(similar(r), undefined, name);
  }
});

test('provenance: hasFlagRef needs a non-zero ThreatRegistry key and reportHash', () => {
  const k = '0x' + '12'.repeat(32);
  assert.equal(hasFlagRef({ flag: { key: k, reportHash: k } }), true);
  for (const flag of [null, undefined, { key: k }, { reportHash: k }, { key: k, reportHash: '0x' + '0'.repeat(64) }, { key: '0x12', reportHash: k },
    { key: '0x' + 'AB'.repeat(32), reportHash: k }]) {
    assert.equal(hasFlagRef({ flag }), false, JSON.stringify(flag));
  }
});

test('thresholds: low from 60%, medium from 75%, high from 90% (before the cap)', () => {
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

    test('near-duplicate of a reference sample: "similar to a reference sample", never "flagged"', async () => {
      const r = await read(await chain.deploy('QuietCopy'), { threatSignatures: SAMPLES });
      const f = find(r, 'similar-reference');
      assert.ok(f, 'warned');
      assert.equal(find(r, 'similar-flagged'), undefined);
      assert.notEqual(r.fingerprint, f.params.fingerprint, 'not an exact match');
      assert.equal(f.params.fingerprint, sampleFp('QuietHoneypot', optimize));
      assert.equal(f.params.reason, 'cannot-sell-in-simulation');
      assert.ok(f.params.percent >= 60 && f.params.percent < 100, String(f.params.percent));
      assert.ok(['low', 'medium'].includes(f.severity), 'informational: at most medium');
      assert.match(explain(r, 'th').lines.find((l) => l.id === 'similar-reference').text, /^โค้ดนี้คล้ายตัวอย่างอ้างอิงในชุดข้อมูลของ Neuro \d+% \(ลายนิ้วมือ fp1:/);
      assert.match(explain(r, 'en').lines.find((l) => l.id === 'similar-reference').text, /^This code is \d+% similar to a reference sample in Neuro's dataset \(fingerprint fp1:/);
      for (const lang of Object.keys(LANGS)) {
        const text = explain(r, lang).lines.find((l) => l.id === 'similar-reference').text;
        // the only mention of flags is the denial ("not code that runners flagged")
        assert.ok(!FLAGGED_WORDS.test(text.split(/[)）]/)[0]), `${lang}: ${text}`);
      }
      assert.ok(!ids(r).includes('nothing-found'));
    });

    test('near-duplicate of an entry with an on-chain flag: "flagged by runners", still at most medium', async () => {
      const r = await read(await chain.deploy('QuietCopy'), { threatSignatures: FLAGGED });
      const f = find(r, 'similar-flagged');
      assert.equal(f.params.fingerprint, sampleFp('QuietHoneypot', optimize));
      assert.ok(['low', 'medium'].includes(f.severity));
      assert.match(explain(r, 'th').lines.find((l) => l.id === 'similar-flagged').text, /^โค้ดนี้คล้ายโค้ดที่ผู้รัน Neuro ติดธงไว้ \d+% \(ลายนิ้วมือ fp1:/);
      assert.match(explain(r, 'en').lines.find((l) => l.id === 'similar-flagged').text, /^This code is \d+% similar to code that Neuro runners flagged \(fingerprint fp1:/);
    });

    test('hidden mint with every function renamed: warned, capped at medium (even at 100%)', async () => {
      for (const ds of [SAMPLES, FLAGGED]) {
        const r = await read(await chain.deploy('HiddenCopy'), { threatSignatures: ds });
        const f = similar(r);
        assert.equal(f.params.fingerprint, sampleFp('HiddenPowers', optimize));
        assert.equal(f.severity, 'medium', String(f.params.percent));
      }
    });

    test('exact copy: high only when the entry names its on-chain flag', async () => {
      const a = await chain.deploy('ScamToken');
      const flagged = await read(a, { threatSignatures: FLAGGED });
      assert.deepEqual([find(flagged, 'similar-flagged').params.percent, find(flagged, 'similar-flagged').severity], [100, 'high']);
      const sample = await read(a, { threatSignatures: SAMPLES });
      assert.deepEqual([find(sample, 'similar-reference').params.percent, find(sample, 'similar-reference').severity], [100, 'medium']);
      assert.equal(find(sample, 'similar-flagged'), undefined);
    });

    test('unrelated and honest contracts, including the widened OpenZeppelin-style baseline: no warning', async () => {
      for (const [name, args] of [['CleanToken'], ['RenouncedToken'], ['RolesToken'], ['FakeUSDT'], ['PhishToken'],
        ['ZetaStyleToken', '0'.repeat(63) + '1' + '0'.repeat(63) + '5'], ['TaxToken', '0'.repeat(128)], ['UpgradeableToken'], ['Drainer'], ['MockWETH'],
        // honest library patterns, alone (baseline) and combined in ways the baseline does not list
        ...BASELINE_CONTRACTS.map((n) => [n]),
        ['HonestFullToken'], ['HonestRolesToken'], ['HonestCappedBlacklist'], ['HonestPermitBurnable'], ['HonestMinPausable']]) {
        const r = await read(await chain.deploy(name, args ?? ''), { threatSignatures: FLAGGED });
        assert.equal(similar(r), undefined, `${name}: ${JSON.stringify(similar(r)?.params)}`);
      }
      const clean = await read(await chain.deploy('CleanToken'), { threatSignatures: FLAGGED });
      assert.ok(ids(clean).includes('nothing-found'), 'a clean token still reads as clean');
      // OpenZeppelin-style tokens are all library code: nothing left to compare
      for (const name of ['HonestRolesToken', 'HonestPermitBurnable']) {
        const code = await chain.rpc.call('eth_getCode', [await chain.deploy(name), 'latest']);
        assert.ok(similaritySignature(code, THREAT_SIGNATURES.baseline).n < 8, name);
      }
    });

    test('deterministic: same code, same signature, same finding, same verdict', async () => {
      const a = await chain.deploy('QuietCopy');
      const code = await chain.rpc.call('eth_getCode', [a, 'latest']);
      assert.deepEqual(similaritySignature(code, THREAT_SIGNATURES.baseline), similaritySignature(code, THREAT_SIGNATURES.baseline));
      const r1 = await read(a, { threatSignatures: FLAGGED });
      const r2 = await read(a, { threatSignatures: FLAGGED });
      assert.deepEqual(r1.analysis, r2.analysis);
      assert.equal(r1.reportHash, r2.reportHash);
      assert.equal(await verdictOf(r1), await verdictOf(r2));
      // Another deployment of the same code (another address): same finding.
      const r3 = await read(await chain.deploy('QuietCopy'), { threatSignatures: FLAGGED });
      assert.deepEqual(find(r3, 'similar-flagged'), find(r1, 'similar-flagged'));
      // the dataset's provenance is part of the verdict: a reference sample is another finding id
      const s1 = await read(a, { threatSignatures: SAMPLES });
      assert.equal(s1.reportHash, (await read(a, { threatSignatures: SAMPLES })).reportHash);
      assert.notEqual(await verdictOf(s1), await verdictOf(r1));
      // It is part of the verdict runners agree on.
      const off = await read(a, { threatSignatures: false });
      assert.notEqual(await verdictOf(off), await verdictOf(r1));
    });

    test('a dataset entry made from a new flagged contract catches its copies', async () => {
      const code = await chain.rpc.call('eth_getCode', [await chain.deploy('HiddenCopy'), 'latest']);
      const flag = fakeFlag('fp1:' + '5a'.repeat(32));
      const entry = await makeEntry(code, THREAT_SIGNATURES.baseline, { reason: 'unlimited-mint', source: 'test', flag });
      assert.deepEqual(entry.flag, flag);
      const only = { baseline: THREAT_SIGNATURES.baseline, entries: [entry] };
      // what `node cli.js signature` prints is a valid entry, pasted as is (with or without a flag reference)
      for (const e of [entry, { ...entry, flag: null }]) {
        const pasted = (0, eval)(`[\n${entrySource({ ...e, source: "bsc 0xab… (it's a test)" })}\n]`)[0];
        assert.deepEqual(pasted, { ...e, source: "bsc 0xab… (it's a test)" });
      }
      await assert.rejects(makeEntry(code, THREAT_SIGNATURES.baseline, { reason: 'other', source: 't', flag: { key: '0x12', reportHash: flag.reportHash } }), /flag/);
      assert.equal(closestFlagged(code, null, only).flagged, true);
      assert.equal(closestFlagged(code, null, { ...only, entries: [{ ...entry, flag: null }] }).flagged, false);
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
        assert.ok(!ids(await read(await chain.deploy(name), { threatSignatures: SAMPLES })).includes('unknown-pattern'), name);
      }
    });
  });
}

test('why the baseline was widened: with only the 2 minimal tokens, an honest pause + blacklist token scored >= 60%', async () => {
  const old = [];
  const now = [];
  for (const optimize of [true, false]) {
    const chain = await createLocalChain({ optimize });
    const code = async (n) => chain.rpc.call('eth_getCode', [await chain.deploy(n), 'latest']);
    const narrow = loadBaseline(await buildBaseline([await code('MinToken'), await code('MinOwnedMintToken')]));
    const scam = await code('ScamToken');
    const honest = await code('HonestMinPausable');
    old.push(similarityPercent(similaritySignature(honest, narrow), similaritySignature(scam, narrow)));
    now.push(similarityPercent(similaritySignature(honest, THREAT_SIGNATURES.baseline), similaritySignature(scam, THREAT_SIGNATURES.baseline)));
  }
  assert.ok(Math.max(...old) >= 60, `old baseline: ${old}`);
  assert.ok(Math.max(...now) < 60, `widened baseline: ${now}`);
});

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
