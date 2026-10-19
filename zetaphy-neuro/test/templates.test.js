import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { codeFingerprint } from '../src/fingerprint.js';
import { TEMPLATES } from '../src/templates.js';
import { createLocalChain } from './helpers/local-chain.js';

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const args = (supply, tax) => word(supply) + word(tax);
const ZETAPHY = { project: 'ZETAPHY', name: 'ZETAPHY token', guarantees: ['tax-decrease-only', 'no-mint', 'no-blacklist', 'no-pause'] };
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);

let chain;
before(async () => { chain = await createLocalChain(); });

test('tokens from one template share a fingerprint; other contracts do not', async () => {
  const a = await chain.deploy('ZetaStyleToken', args(10n ** 24n, 5));
  const b = await chain.deploy('ZetaStyleToken', args(7n * 10n ** 27n, 9));
  const c = await chain.deploy('CleanToken');
  const code = (x) => chain.rpc.call('eth_getCode', [x, 'latest']);
  const [ca, cb, cc] = await Promise.all([code(a), code(b), code(c)]);
  assert.notEqual(ca, cb, 'immutables make the raw bytecode differ');
  const [fa, fb, fc] = await Promise.all([codeFingerprint(ca), codeFingerprint(cb), codeFingerprint(cc)]);
  assert.match(fa, /^fp1:[0-9a-f]{64}$/);
  assert.equal(fa, fb);
  assert.notEqual(fa, fc);
});

test('registered ZETAPHY template: recognised, tax rule shown as decrease-only', async () => {
  const a = await chain.deploy('ZetaStyleToken', args(10n ** 24n, 5));
  const fp = (await readContract('bsc', a, { rpc: chain.rpc, templates: [] })).fingerprint;
  const r = await readContract('bsc', a, { rpc: chain.rpc, templates: [{ ...ZETAPHY, fingerprint: fp }] });
  assert.equal(find(r, 'template-match').severity, 'good');
  const fee = find(r, 'can-change-fee');
  assert.equal(fee.severity, 'low');
  assert.equal(fee.params.decreaseOnly, true);
  assert.ok(!find(r, 'template-mismatch'));
  assert.equal(r.analysis.level, 'low');
});

test('without the template the same tax setter is medium risk', async () => {
  const a = await chain.deploy('ZetaStyleToken', args(10n ** 24n, 5));
  const r = await readContract('bsc', a, { rpc: chain.rpc, templates: [] });
  assert.equal(find(r, 'can-change-fee').severity, 'medium');
  assert.ok(!find(r, 'template-match'));
});

test('template limited to other chains does not match', async () => {
  const a = await chain.deploy('ZetaStyleToken', args(10n ** 24n, 5));
  const fp = (await readContract('bsc', a, { rpc: chain.rpc, templates: [] })).fingerprint;
  const r = await readContract('bsc', a, { rpc: chain.rpc, templates: [{ ...ZETAPHY, fingerprint: fp, chains: ['base'] }] });
  assert.ok(!find(r, 'template-match'));
});

test('a wrong registry entry is reported, not trusted', async () => {
  const a = await chain.deploy('ScamToken');
  const fp = (await readContract('bsc', a, { rpc: chain.rpc, templates: [] })).fingerprint;
  const r = await readContract('bsc', a, { rpc: chain.rpc, templates: [{ ...ZETAPHY, fingerprint: fp }] });
  const bad = r.analysis.findings.filter((f) => f.id === 'template-mismatch');
  assert.equal(bad.length, 3, 'mint, blacklist and pause all contradict the template');
  assert.equal(r.analysis.level, 'high');
});

test('the shipped registry is well-formed', () => {
  const known = new Set(['tax-decrease-only', 'no-mint', 'no-blacklist', 'no-pause']);
  for (const t of TEMPLATES) {
    assert.match(t.fingerprint, /^fp1:[0-9a-f]{64}$/);
    assert.ok(t.project && t.name);
    for (const g of t.guarantees ?? []) assert.ok(known.has(g), `unknown guarantee ${g}`);
  }
});
