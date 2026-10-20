// Bitcoin Runes reader. Responses follow ord's JSON API (GET /rune/<query>
// with Accept: application/json -> api::Rune { entry: RuneEntry, id,
// mintable, parent }; RuneEntry amounts are raw u128 JSON numbers, the rune
// name and id are strings, terms.height/offset are [start, end]).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { createOrdApi, parseJsonBigInts } from '../src/rpc.js';
import { parseRune } from '../src/bitcoin.js';
import { isChainAddress, explorerUrl } from '../src/chains.js';
import { explain } from '../src/explain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);

function fakeOrd(routes) {
  const paths = [];
  return { paths, async get(path) { paths.push(path); return routes[path] ?? null; } };
}
// DOG•GO•TO•THE•MOON as ord shows it: everything premined, no mint terms.
const DOG = {
  entry: { block: 840000, burned: '0', divisibility: 5, etching: 'e'.repeat(64), mints: '0', number: 3, premine: '10000000000000000',
    spaced_rune: 'DOG•GO•TO•THE•MOON', symbol: '🐕', terms: null, timestamp: 1713571767, turbo: true },
  id: '840000:3', mintable: false, parent: null,
};

test('inputs: rune names (dots as spacers) and ids', () => {
  assert.equal(parseRune('840000:3'), '840000:3');
  assert.equal(parseRune('DOG•GO•TO•THE•MOON'), 'DOG•GO•TO•THE•MOON');
  assert.equal(parseRune('dog.go.to.the.moon'), 'DOG•GO•TO•THE•MOON');
  for (const bad of ['', 'a b', 'A'.repeat(29), 'x/y', '0x' + 'ab'.repeat(20), 'ORDI1']) assert.equal(parseRune(bad), null, bad);
  assert.ok(isChainAddress('bitcoin', 'UNCOMMON•GOODS'));
  assert.equal(explorerUrl('bitcoin', 'DOG•GO•TO•THE•MOON'), 'https://ordinals.com/rune/DOG•GO•TO•THE•MOON');
});

test('a fully premined rune: no admin, premine flagged, supply exact', async () => {
  const api = fakeOrd({ '/rune/DOG%E2%80%A2GO%E2%80%A2TO%E2%80%A2THE%E2%80%A2MOON': DOG });
  const r = await readContract('bitcoin', 'dog.go.to.the.moon', { api });
  assert.equal(r.address, 'DOG•GO•TO•THE•MOON');
  assert.equal(r.token.totalSupply, '10000000000000000');
  assert.ok(ids(r).includes('btc-no-admin'));
  assert.equal(find(r, 'btc-premine').params.percent, 100);
  assert.equal(find(r, 'btc-premine').severity, 'medium');
  assert.ok(ids(r).includes('btc-turbo'));
  assert.ok(!ids(r).includes('btc-open-mint'));
  assert.match(explain(r, 'th').lines[0].text, /DOG•GO•TO•THE•MOON.*840000:3.*100,000,000,000/);
});

test('open mint with a cap and an end block; uncapped and endless is medium', async () => {
  // UNCOMMON•GOODS-like terms, with a 10% premine.
  const open = { entry: { ...DOG.entry, spaced_rune: 'OPEN•MINT', divisibility: 0, premine: '100', mints: '250', turbo: false,
    terms: { amount: '1', cap: '900', height: [840000, 1050000], offset: [null, null] } }, id: '1:0', mintable: true, parent: null };
  const r = await readContract('bitcoin', '1:0', { api: fakeOrd({ '/rune/1%3A0': open }) });
  const f = find(r, 'btc-open-mint');
  assert.equal(f.severity, 'info');
  assert.equal(f.params.end, 1050000);
  assert.equal(f.params.maxSupply, '1000');
  assert.equal(f.params.percent, 27.77);
  assert.equal(find(r, 'btc-premine').severity, 'low');
  assert.equal(r.token.totalSupply, '350');
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'btc-open-mint').text, /block 1050000.*1,000.*27.77%/);

  const forever = { ...open, entry: { ...open.entry, premine: '0', terms: { amount: '1', cap: null, height: [null, null], offset: [null, null] } } };
  const u = await readContract('bitcoin', '1:0', { api: fakeOrd({ '/rune/1%3A0': forever }) });
  assert.equal(find(u, 'btc-open-mint').severity, 'medium');
  assert.ok(!ids(u).includes('btc-premine'));
});

test('an unknown rune', async () => {
  const none = await readContract('bitcoin', 'NOSUCHRUNE', { api: fakeOrd({}) });
  assert.deepEqual(ids(none), ['btc-not-found', 'btc-caveat']);
});

test('ord client: GET with Accept: application/json, /rune/ only, big integers kept exact', async () => {
  assert.deepEqual(parseJsonBigInts('{"a":12345678901234567890,"b":[1,99999999999999999999],"c":"x:1234567890123456789"}'),
    { a: '12345678901234567890', b: [1, '99999999999999999999'], c: 'x:1234567890123456789' });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([init.method, init.headers.Accept, url]);
    return { ok: true, status: 200, text: async () => '{"entry":{"premine":340282366920938463463374607431768211455},"id":"1:0"}' };
  };
  const api = createOrdApi(['https://ordinals.com'], { fetchImpl });
  assert.equal((await api.get('/rune/ABC')).entry.premine, '340282366920938463463374607431768211455');
  assert.throws(() => api.get('/inscriptions'), /not allowed/);
  assert.deepEqual(seen, [['GET', 'application/json', 'https://ordinals.com/rune/ABC']]);
});
