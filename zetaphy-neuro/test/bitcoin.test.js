// Bitcoin Runes / BRC-20 reader. Response shapes follow Hiro's own API code
// (runehook api/src/api/util/helpers.ts parseEtchingResponse and the
// ordinals-api BRC-20 helpers): amounts are decimal strings already divided by
// the token's decimals; a rune's mint cap is formatted the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { createHiroApi } from '../src/rpc.js';
import { parseBitcoinInput, units } from '../src/bitcoin.js';
import { isChainAddress, explorerUrl } from '../src/chains.js';
import { explain } from '../src/explain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);

function fakeHiro(routes) {
  const paths = [];
  return { paths, async get(path) { paths.push(path); return routes[path] ?? null; } };
}

const etching = (over = {}) => ({
  id: '840000:3', name: 'DOGGOTOTHEMOON', spaced_name: 'DOG•GO•TO•THE•MOON', number: 3, divisibility: 5, symbol: '🐕', turbo: true,
  mint_terms: { amount: null, cap: null, height_start: null, height_end: null, offset_start: null, offset_end: null },
  supply: { current: '100000000000.00000', minted: '0.00000', total_mints: '0', mint_percentage: '0.0000', mintable: false, burned: '0.00000', total_burns: '0', premine: '100000000000.00000' },
  location: { block_hash: 'h', block_height: 840000, tx_index: 3, tx_id: 't', timestamp: 1 },
  ...over,
});
const runeHolders = (balance) => ({ limit: 1, offset: 0, total: 1, results: [{ address: 'bc1pholder', balance }] });

test('inputs: rune ids and names, BRC-20 tickers', () => {
  assert.deepEqual(parseBitcoinInput('840000:3'), { rune: '840000:3' });
  assert.deepEqual(parseBitcoinInput('DOG•GO•TO•THE•MOON'), { rune: 'DOGGOTOTHEMOON' });
  assert.deepEqual(parseBitcoinInput('dog.go.to.the.moon'), { rune: 'DOGGOTOTHEMOON' });
  assert.deepEqual(parseBitcoinInput('ordi'), { rune: 'ORDI', ticker: 'ordi' }, 'both until the indexer says which');
  assert.deepEqual(parseBitcoinInput('brc20:SATS'), { ticker: 'sats' });
  assert.deepEqual(parseBitcoinInput('$ore'), { ticker: '$ore' });
  for (const bad of ['', 'a b', 'TOOLONG'.repeat(5), 'brc20:toolongticker', 'x/y', '0x' + 'ab'.repeat(20)]) assert.equal(parseBitcoinInput(bad), null, bad);
  assert.ok(isChainAddress('bitcoin', 'UNCOMMON•GOODS'));
  assert.equal(units('1234.5', 3), 1234500n);
  assert.equal(units('0.00001', 5), 1n);
  assert.equal(explorerUrl('bitcoin', 'brc20:ordi'), 'https://ordiscan.com/brc20/ordi');
  assert.match(explorerUrl('bitcoin', 'DOG•GO•TO•THE•MOON'), /^https:\/\/ordinals\.com\/rune\//);
});

test('a fully premined rune: no admin, premine and holder share flagged', async () => {
  const api = fakeHiro({
    '/runes/v1/etchings/DOGGOTOTHEMOON': etching(),
    '/runes/v1/etchings/840000%3A3/holders?limit=1': runeHolders('5000000000.00000'),
  });
  const r = await readContract('bitcoin', 'DOG•GO•TO•THE•MOON', { api });
  assert.equal(r.address, 'DOG•GO•TO•THE•MOON');
  assert.ok(ids(r).includes('btc-no-admin'));
  assert.equal(find(r, 'btc-premine').params.percent, 100);
  assert.equal(find(r, 'btc-premine').severity, 'medium');
  assert.ok(ids(r).includes('btc-turbo'));
  assert.ok(!ids(r).includes('btc-top-holder'), '5% is not concentrated');
  assert.equal(r.analysis.level, 'medium');
  assert.match(explain(r, 'th').lines[0].text, /DOG•GO•TO•THE•MOON.*840000:3.*100,000,000,000/);
  assert.ok(api.paths.every((p) => p.startsWith('/runes/v1/')), 'a 14-letter name is not a BRC-20 ticker');
});

test('an open-mint rune with a cap; uncapped open mint is medium', async () => {
  // UNCOMMON•GOODS-like: amount 1, cap formatted with divisibility 0.
  const open = etching({ id: '1:0', name: 'OPENMINTRUNE', spaced_name: 'OPEN•MINT•RUNE', divisibility: 0, turbo: false,
    mint_terms: { amount: '1', cap: '1000', height_start: 840000, height_end: 1050000, offset_start: null, offset_end: null },
    supply: { current: '250', minted: '250', total_mints: '250', mint_percentage: '25.0000', mintable: true, burned: '0', total_burns: '0', premine: '0' } });
  const r = await readContract('bitcoin', '1:0', { api: fakeHiro({ '/runes/v1/etchings/1%3A0': open, '/runes/v1/etchings/1%3A0/holders?limit=1': runeHolders('130') }) });
  const f = find(r, 'btc-open-mint');
  assert.equal(f.severity, 'info');
  assert.equal(f.params.end, 1050000);
  assert.equal(f.params.maxSupply, '1000');
  assert.equal(find(r, 'btc-top-holder').params.share, 52);
  assert.ok(!ids(r).includes('btc-premine'));
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'btc-open-mint').text, /block 1050000.*1,000.*25%/);

  const forever = { ...open, mint_terms: { ...open.mint_terms, cap: null, height_end: null } };
  const u = await readContract('bitcoin', '1:0', { api: fakeHiro({ '/runes/v1/etchings/1%3A0': forever }) });
  assert.equal(find(u, 'btc-open-mint').severity, 'medium');
  assert.ok(find(u, 'btc-open-mint').params.unlimited);
});

const brc = (over = {}, supply = {}) => ({
  token: { id: 'x', number: 1, block_height: 779832, tx_id: 't', address: 'bc1pdeployer', ticker: 'ordi', max_supply: '21000000.000000000000000000', mint_limit: '1000.000000000000000000', decimals: 18, deploy_timestamp: 1, minted_supply: '21000000.000000000000000000', tx_count: 9, self_mint: false, ...over },
  supply: { max_supply: '21000000.000000000000000000', minted_supply: '21000000.000000000000000000', holders: 25000, ...supply },
});

test('BRC-20: fully minted, still minting, and self-mint', async () => {
  const done = await readContract('bitcoin', 'ordi', { api: fakeHiro({ '/ordinals/v1/brc-20/tokens/ordi': brc() }) });
  assert.equal(done.address, 'brc20:ordi');
  assert.deepEqual(ids(done), ['btc-brc20', 'btc-no-admin', 'btc-caveat']);
  assert.equal(done.analysis.level, 'info');
  assert.match(explain(done, 'en').lines[0].text, /BRC-20 token "ordi".*21,000,000 minted of a maximum 21,000,000, 25,000 holders/);

  const half = { minted_supply: '10500000.000000000000000000' };
  const open = await readContract('bitcoin', 'brc20:ordi', { api: fakeHiro({ '/ordinals/v1/brc-20/tokens/ordi': brc(half, half) }) });
  assert.equal(find(open, 'btc-open-mint').params.percent, 50);

  const self = await readContract('bitcoin', 'brc20:abcde', { api: fakeHiro({
    '/ordinals/v1/brc-20/tokens/abcde': brc({ ticker: 'abcde', self_mint: true, ...half }, half),
    '/ordinals/v1/brc-20/tokens/abcde/holders?limit=1': { results: [{ address: 'bc1pwhale', overall_balance: '9450000.0' }] },
  }) });
  assert.equal(find(self, 'btc-self-mint').params.deployer, 'bc1pdeployer');
  assert.equal(find(self, 'btc-top-holder').severity, 'medium', '90% of what is minted');
  assert.equal(self.analysis.level, 'medium');
});

test('a 4-letter input falls back from BRC-20 to a rune; nothing found', async () => {
  const api = fakeHiro({ '/runes/v1/etchings/ABCD': etching({ id: '900000:1', name: 'ABCD', spaced_name: 'ABCD' }) });
  const r = await readContract('bitcoin', 'abcd', { api });
  assert.ok(ids(r).includes('btc-rune'));
  assert.deepEqual(api.paths.slice(0, 2), ['/ordinals/v1/brc-20/tokens/abcd', '/runes/v1/etchings/ABCD']);
  const none = await readContract('bitcoin', 'NOSUCHRUNE', { api: fakeHiro({}) });
  assert.deepEqual(ids(none), ['btc-not-found', 'btc-caveat']);
});

test('Hiro client: GET only, token read paths only', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([init.method, url]); return { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
  const api = createHiroApi(['https://api.hiro.so'], { fetchImpl });
  assert.deepEqual(await api.get('/runes/v1/etchings/ABC'), { ok: 1 });
  assert.throws(() => api.get('/extended/v1/tx'), /not allowed/);
  assert.deepEqual(seen, [['GET', 'https://api.hiro.so/runes/v1/etchings/ABC']]);
});
