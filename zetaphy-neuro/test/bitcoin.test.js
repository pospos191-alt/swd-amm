// Bitcoin Runes reader. ordinals.com runs `ord` with its JSON API switched
// off (HTTP 406), so the rune page is read. The pages below are rendered by
// hand from ord's templates/rune.html; amounts are printed by ord's Pile
// (whole.fraction, a no-break space, then the symbol or ¤).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { createOrdApi, createStarknetRpc } from '../src/rpc.js';
import { parseRune, pileUnits, parseRunePage } from '../src/bitcoin.js';
import { isChainAddress, explorerUrl } from '../src/chains.js';
import { explain } from '../src/explain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);
const NB = ' ';

function runePage({ name, id, number = 3, terms = null, supply, premine, burned = '0', divisibility, symbol, turbo = false }) {
  const [block, tx] = id.split(':');
  const mint = terms ? `
  <dd>
    <dl>
      <dt>start</dt>
      <dd>${terms.start ? `<a href=/block/${terms.start}>${terms.start}</a>` : 'none'}</dd>
      <dt>end</dt>
      <dd>${terms.end ? `<a href=/block/${terms.end}>${terms.end}</a>` : 'none'}</dd>
      <dt>amount</dt>
      <dd>${terms.amount ?? 'none'}</dd>
      <dt>mints</dt>
      <dd>${terms.mints}</dd>
      <dt>cap</dt>
      <dd>${terms.cap}</dd>
      <dt>remaining</dt>
      <dd>${terms.cap - terms.mints}</dd>
      <dt>mintable</dt>
      <dd>${terms.mintable}</dd>
      <dt>progress</dt>
      <dd>${((terms.mints / terms.cap) * 100).toFixed(2)}%</dd>
    </dl>
  </dd>` : `
  <dd>no</dd>`;
  return `<!doctype html><html><head><title>Rune ${name}</title></head><body><header><nav><a href=/>Ordinals</a></nav></header><main>
<h1>${name}</h1>
<dl>
  <dt>number</dt>
  <dd>${number}</dd>
  <dt>timestamp</dt>
  <dd><time>2024-04-20 00:09:27 UTC</time></dd>
  <dt>id</dt>
  <dd>${id}</dd>
  <dt>etching block</dt>
  <dd><a href=/block/${block}>${block}</a></dd>
  <dt>etching transaction</dt>
  <dd>${tx}</dd>
  <dt>mint</dt>${mint}
  <dt>supply</dt>
  <dd>${supply}</dd>
  <dt>premine</dt>
  <dd>${premine}</dd>
  <dt>premine percentage</dt>
  <dd>100%</dd>
  <dt>burned</dt>
  <dd>${burned}${NB}${symbol ?? '¤'}</dd>
  <dt>divisibility</dt>
  <dd>${divisibility}</dd>
${symbol ? `  <dt>symbol</dt>\n  <dd>${symbol}</dd>\n` : ''}  <dt>turbo</dt>
${turbo ? '  <dd class=turbo>true</dd>' : '  <dd>false</dd>'}
  <dt>etching</dt>
  <dd><a class=collapse href=/tx/${'e'.repeat(64)}>${'e'.repeat(64)}</a></dd>
</dl></main></body></html>`;
}
function fakeOrd(pages) {
  const paths = [];
  return { paths, async getText(path) { paths.push(path); return pages[path] ?? null; } };
}
const DOG = runePage({ name: 'DOG•GO•TO•THE•MOON', id: '840000:3', supply: `100000000000${NB}🐕`, premine: `100000000000${NB}🐕`, divisibility: 5, symbol: '🐕', turbo: true });
const DOG_PATH = '/rune/DOG%E2%80%A2GO%E2%80%A2TO%E2%80%A2THE%E2%80%A2MOON';

test('inputs, amounts and the page reader', () => {
  assert.equal(parseRune('840000:3'), '840000:3');
  assert.equal(parseRune('dog.go.to.the.moon'), 'DOG•GO•TO•THE•MOON');
  for (const bad of ['', 'a b', 'A'.repeat(29), 'x/y', '0x' + 'ab'.repeat(20), 'ORDI1']) assert.equal(parseRune(bad), null, bad);
  assert.ok(isChainAddress('bitcoin', 'UNCOMMON•GOODS'));
  assert.equal(explorerUrl('bitcoin', 'DOG•GO•TO•THE•MOON'), 'https://ordinals.com/rune/DOG•GO•TO•THE•MOON');
  assert.equal(pileUnits(`0.1${NB}¤`, 2), 10n);
  assert.equal(pileUnits(`1234${NB}🐕`, 5), 123400000n);
  assert.equal(pileUnits(`1.123${NB}¤`, 2), null, 'more decimals than the rune has');
  const p = parseRunePage(DOG);
  assert.equal(p.name, 'DOG•GO•TO•THE•MOON');
  assert.equal(p.f.turbo, 'true');
  assert.equal(p.f['etching block'], '840000');
  assert.equal(parseRunePage('<html><h1>Not found</h1></html>'), null);
});

test('a fully premined rune: no admin, premine flagged, supply exact', async () => {
  const r = await readContract('bitcoin', 'dog.go.to.the.moon', { api: fakeOrd({ [DOG_PATH]: DOG }) });
  assert.equal(r.address, 'DOG•GO•TO•THE•MOON');
  assert.equal(r.token.totalSupply, '10000000000000000');
  assert.equal(r.token.symbol, '🐕');
  assert.ok(ids(r).includes('btc-no-admin'));
  assert.equal(find(r, 'btc-premine').params.percent, 100);
  assert.equal(find(r, 'btc-premine').severity, 'medium');
  assert.ok(ids(r).includes('btc-turbo'));
  assert.ok(!ids(r).includes('btc-open-mint'));
  assert.match(explain(r, 'th').lines[0].text, /DOG•GO•TO•THE•MOON.*840000:3.*100,000,000,000/);
});

test('open mint with a cap and an end block; a finished mint is not flagged', async () => {
  const open = runePage({ name: 'OPEN•MINT', id: '1:0', divisibility: 0, supply: `350${NB}¤`, premine: `100${NB}¤`,
    terms: { start: 840000, end: 1050000, amount: `1${NB}¤`, mints: 250, cap: 900, mintable: true } });
  const r = await readContract('bitcoin', '1:0', { api: fakeOrd({ '/rune/1%3A0': open }) });
  const f = find(r, 'btc-open-mint');
  assert.equal(f.severity, 'info');
  assert.equal(f.params.end, 1050000);
  assert.equal(f.params.maxSupply, '1000');
  assert.equal(f.params.percent, 27.77);
  assert.equal(find(r, 'btc-premine').severity, 'low');
  assert.equal(r.token.totalSupply, '350');
  assert.equal(r.analysis.level, 'low');
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'btc-open-mint').text, /block 1050000.*1,000.*27.77%/);

  const done = runePage({ name: 'DONE', id: '1:0', divisibility: 0, supply: `900${NB}¤`, premine: `0${NB}¤`,
    terms: { start: null, end: null, amount: `1${NB}¤`, mints: 900, cap: 900, mintable: false } });
  const d = await readContract('bitcoin', '1:0', { api: fakeOrd({ '/rune/1%3A0': done }) });
  assert.deepEqual(ids(d), ['btc-rune', 'btc-no-admin', 'btc-caveat']);
});

test('an unknown rune', async () => {
  const none = await readContract('bitcoin', 'NOSUCHRUNE', { api: fakeOrd({}) });
  assert.deepEqual(ids(none), ['btc-not-found', 'btc-caveat']);
});

test('ord client: plain GET, /rune/ paths only', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([init.method, url]); return { ok: true, status: 200, text: async () => DOG }; };
  const api = createOrdApi(['https://ordinals.com'], { fetchImpl });
  assert.equal(await api.getText('/rune/ABC'), DOG);
  assert.throws(() => api.getText('/inscriptions'), /not allowed/);
  assert.deepEqual(seen, [['GET', 'https://ordinals.com/rune/ABC']]);
});

test('JSON-RPC clients try again once when every endpoint is rate-limited', async () => {
  let n = 0;
  const fetchImpl = async (url, init) => {
    const { method } = JSON.parse(init.body);
    if (method === 'starknet_chainId') return { ok: true, status: 200, json: async () => ({ result: '0x534e5f4d41494e' }) };
    n++;
    return n <= 2 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => ({ result: ['0x1'] }) };
  };
  const rpc = createStarknetRpc(['https://a.example', 'https://b.example'], '0x534e5f4d41494e', { fetchImpl, retryMs: 10 });
  assert.deepEqual(await rpc.call('starknet_call', [{}, 'latest']), ['0x1']);
  assert.equal(n, 3);
});
