// CosmWasm (Osmosis, Neutron) reader. Paths and response shapes follow
// osmojs' generated LCD clients: cosmwasm/wasm/v1 contract, history and
// smart queries; osmosis/tokenfactory/v1beta1 authority_metadata and
// before_send_hook; cosmos/bank/v1beta1 supply and denom metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { bech32Decode, bech32Encode } from '../src/bech32.js';
import { readContract } from '../src/reader.js';
import { createCosmosRest } from '../src/rpc.js';
import { isChainAddress } from '../src/chains.js';
import { explain } from '../src/explain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);
const osmo = (n = 32) => bech32Encode('osmo', randomBytes(n));
const CONTRACT = osmo();
const ADMIN = osmo(20);

test('bech32: BIP-173 vectors, round trip, typos and wrong prefix', () => {
  for (const ok of ['a12uel5l', 'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw', 'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w']) {
    assert.doesNotThrow(() => bech32Decode(ok), ok);
  }
  for (const bad of ['a12uel5m', 'A12UEL5L'.toLowerCase().replace('l', 'x'), 'pzry9x0s0muk', '1pzry9x0s0muk', 'A12uEL5L']) {
    assert.throws(() => bech32Decode(bad), /invalid address/, bad);
  }
  const b = randomBytes(32);
  const s = bech32Encode('neutron', b);
  assert.deepEqual([...bech32Decode(s).bytes], [...b]);
  assert.ok(isChainAddress('osmosis', CONTRACT));
  assert.ok(isChainAddress('neutron', s));
  assert.ok(!isChainAddress('osmosis', s), 'neutron address on osmosis');
  assert.ok(!isChainAddress('osmosis', CONTRACT.slice(0, -1) + (CONTRACT.endsWith('q') ? 'p' : 'q')), 'checksum');
  assert.ok(isChainAddress('osmosis', `factory/${ADMIN}/meme`));
  assert.ok(!isChainAddress('osmosis', `factory/${ADMIN}/../../x`), 'no path tricks');
  assert.ok(!isChainAddress('osmosis', `factory/${ADMIN}/a//b`));
});

function fakeLcd(routes) {
  const paths = [];
  return {
    paths,
    async get(path) {
      paths.push(path);
      if (path in routes) {
        const v = routes[path];
        if (v instanceof Error) throw v;
        return v;
      }
      return null;
    },
  };
}
const smart = (addr, q) => `/cosmwasm/wasm/v1/contract/${addr}/smart/${encodeURIComponent(Buffer.from(JSON.stringify(q)).toString('base64'))}`;
const info = (over = {}) => ({ address: CONTRACT, contract_info: { code_id: '42', creator: ADMIN, admin: ADMIN, label: 'meme cw20', created: null, ibc_port_id: '', extension: null, ...over } });

test('CW20 with an admin and a minter: high risk', async () => {
  const api = fakeLcd({
    [`/cosmwasm/wasm/v1/contract/${CONTRACT}`]: info(),
    [`/cosmwasm/wasm/v1/contract/${CONTRACT}/history?pagination.limit=100`]: { entries: [
      { operation: 'CONTRACT_CODE_HISTORY_OPERATION_TYPE_INIT', code_id: '41' },
      { operation: 'CONTRACT_CODE_HISTORY_OPERATION_TYPE_MIGRATE', code_id: '42' },
    ] },
    [smart(CONTRACT, { token_info: {} })]: { data: { name: 'Osmo Pepe', symbol: 'OPEPE', decimals: 6, total_supply: '1000000000' } },
    [smart(CONTRACT, { minter: {} })]: { data: { minter: ADMIN, cap: null } },
  });
  const r = await readContract('osmosis', CONTRACT, { api });
  assert.equal(r.analysis.level, 'high');
  assert.equal(find(r, 'cw-admin').params.admin, ADMIN);
  assert.equal(find(r, 'cw-migrated').params.count, 1);
  assert.equal(find(r, 'cw20-minter').params.minter, ADMIN);
  assert.equal(r.cosmwasm.codeId, '42');
  assert.match(explain(r, 'th').lines[0].text, /Osmo Pepe.*OPEPE.*1,000/);
  assert.ok(api.paths.every((p) => p.startsWith('/cosmwasm/wasm/v1/')));
});

test('CW20 with no admin and no minter is good; a non-token contract is described', async () => {
  const r = await readContract('osmosis', CONTRACT, { api: fakeLcd({
    [`/cosmwasm/wasm/v1/contract/${CONTRACT}`]: info({ admin: '' }),
    [smart(CONTRACT, { token_info: {} })]: { data: { name: 'Fair', symbol: 'FAIR', decimals: 6, total_supply: '1' } },
    [smart(CONTRACT, { minter: {} })]: { data: null },
  }) });
  assert.deepEqual(ids(r), ['cw20-token', 'cw-no-admin', 'cw20-no-minter', 'cw-caveat']);
  assert.equal(r.analysis.level, 'info');

  const pool = await readContract('osmosis', CONTRACT, { api: fakeLcd({
    [`/cosmwasm/wasm/v1/contract/${CONTRACT}`]: info({ label: 'dex pool' }),
    [smart(CONTRACT, { token_info: {} })]: new Error('HTTP 500'),
  }) });
  assert.deepEqual(find(pool, 'cw-contract').params, { label: 'dex pool', codeId: '42' });
  assert.ok(ids(pool).includes('cw-admin'));
});

test('Token Factory coin: admin and before-send hook', async () => {
  const denom = `factory/${ADMIN}/ROCKET`;
  const hook = osmo();
  const api = fakeLcd({
    [`/osmosis/tokenfactory/v1beta1/denoms/${denom}/authority_metadata`]: { authority_metadata: { admin: ADMIN } },
    [`/osmosis/tokenfactory/v1beta1/denoms/${denom}/before_send_hook`]: { cosmwasm_address: hook },
    [`/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`]: { amount: { denom, amount: '5000000' } },
    [`/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=${encodeURIComponent(denom)}`]: { metadata: {
      name: 'Rocket', symbol: 'RKT', display: 'rocket', denom_units: [{ denom, exponent: 0 }, { denom: 'rocket', exponent: 6 }] } },
  });
  const r = await readContract('osmosis', denom, { api });
  assert.equal(find(r, 'tf-admin').params.admin, ADMIN);
  assert.equal(find(r, 'tf-hook').params.contract, hook);
  assert.match(explain(r, 'en').lines[0].text, /Rocket.*RKT.*5$|Rocket.*RKT.*5[^0-9]/);

  const renounced = await readContract('osmosis', denom, { api: fakeLcd({
    [`/osmosis/tokenfactory/v1beta1/denoms/${denom}/authority_metadata`]: { authority_metadata: { admin: '' } },
  }) });
  assert.deepEqual(ids(renounced), ['tf-token', 'tf-no-admin', 'cw-caveat']);
  assert.equal(find(renounced, 'tf-token').params.name, 'ROCKET', 'no metadata: the subdenom is the name');
});

test('missing contract and missing denom', async () => {
  assert.ok(ids(await readContract('osmosis', CONTRACT, { api: fakeLcd({}) })).includes('cw-not-found'));
  assert.ok(ids(await readContract('osmosis', `factory/${ADMIN}/nope`, { api: fakeLcd({}) })).includes('cw-not-found'));
});

test('REST client: GET only and only the expected chain id', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([init.method, url]);
    if (url.endsWith('/node_info')) return { ok: true, status: 200, json: async () => ({ default_node_info: { network: url.includes('wrong') ? 'osmo-test-5' : 'osmosis-1' } }) };
    return { ok: true, status: 200, json: async () => ({ x: 1 }) };
  };
  const api = createCosmosRest(['https://wrong.example', 'https://right.example'], 'osmosis-1', { fetchImpl });
  assert.deepEqual(await api.get('/a'), { x: 1 });
  assert.ok(seen.every(([m]) => m === 'GET'));
  assert.ok(!seen.some(([, u]) => u === 'https://wrong.example/a'));
});
