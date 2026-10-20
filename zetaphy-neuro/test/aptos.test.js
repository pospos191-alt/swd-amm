// Aptos reader tests. Responses follow the Aptos REST API types
// (@aptos-labs/ts-sdk src/types/types.ts: MoveResource, MoveModuleBytecode
// with abi.structs[].fields and abi.exposed_functions, LedgerInfo) and the
// framework resources 0x1::fungible_asset::{Metadata, ConcurrentSupply,
// DispatchFunctionStore}, 0x1::object::ObjectCore, 0x1::coin::CoinInfo,
// 0x1::code::PackageRegistry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { createAptosRest } from '../src/rpc.js';
import { isChainAddress } from '../src/chains.js';
import { explain } from '../src/explain.js';
import { longAddress } from '../src/move.js';

const CREATOR = longAddress('0xc0ffee');
const META = longAddress('0xfa11');
const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);

const fn = (name, o = {}) => ({ name, visibility: 'public', is_entry: false, is_view: false, generic_type_params: [], params: [], return: [], ...o });
const mod = (address, name, { structs = [], functions = [] } = {}) => ({
  bytecode: '0x00', abi: { address, name, friends: [], exposed_functions: functions, structs },
});
const struct = (name, fields) => ({ name, is_native: false, is_event: false, is_enum: false, abilities: ['key'], generic_type_params: [], fields: fields.map(([n, type]) => ({ name: n, type })) });
const registry = (policy, name = 'meme') => ({ type: '0x1::code::PackageRegistry', data: { packages: [{ name, upgrade_policy: { policy }, upgrade_number: '0', modules: [] }] } });

/** Fake Aptos REST API backed by an { address: { resources, modules } } map. */
function fakeAptos(world, views = {}) {
  const requests = [];
  return {
    requests,
    async get(path) {
      requests.push(['GET', path]);
      const m = path.match(/^\/accounts\/(0x[0-9a-f]+)\/(resources|modules|resource\/(.+))(\?.*)?$/);
      if (!m) throw new Error(`unexpected ${path}`);
      const acc = world[m[1]];
      if (!acc) return null;
      if (m[2] === 'resources') return acc.resources ?? [];
      if (m[2] === 'modules') return acc.modules ?? [];
      const type = decodeURIComponent(m[3]);
      return (acc.resources ?? []).find((r) => r.type === type) ?? null;
    },
    async view(body) {
      requests.push(['VIEW', body.function]);
      return views[body.function] ?? [{ vec: [] }];
    },
  };
}

const faWorld = (over = {}) => ({
  [META]: { resources: [
    { type: '0x1::fungible_asset::Metadata', data: { name: 'Pepe Aptos', symbol: 'PEPA', decimals: 8, icon_uri: '', project_uri: '' } },
    { type: '0x1::fungible_asset::ConcurrentSupply', data: { current: { max_value: '340282366920938463463374607431768211455', value: '0' } } },
    { type: '0x1::object::ObjectCore', data: { allow_ungated_transfer: false, guid_creation_num: '1', owner: CREATOR, transfer_events: {} } },
    { type: `${CREATOR}::pepa::Refs`, data: {} },
    ...(over.extra ?? []),
  ] },
  [CREATOR]: {
    resources: [registry(1, 'pepa')],
    modules: [mod(CREATOR, 'pepa', {
      structs: [struct('Refs', [['mint', '0x1::fungible_asset::MintRef'], ['transfer', '0x1::option::Option<0x1::fungible_asset::TransferRef>'], ['burn', '0x1::fungible_asset::BurnRef']])],
      functions: [fn('mint', { is_entry: true }), fn('set_paused', { is_entry: true, visibility: 'private' }), fn('balance', { is_view: true }), fn('blacklist_view', { is_view: true })],
    })],
  },
  ...over.world,
});

test('Aptos coin types and object addresses are recognised', () => {
  assert.ok(isChainAddress('aptos', '0x1::aptos_coin::AptosCoin'));
  assert.ok(isChainAddress('aptos', META));
  assert.ok(isChainAddress('aptos', '0xa'));
  assert.ok(!isChainAddress('aptos', 'aptos_coin'));
});

test('Fungible Asset whose creator keeps MintRef, TransferRef and BurnRef', async () => {
  const api = fakeAptos(faWorld(), { '0x1::fungible_asset::supply': [{ vec: ['100000000000'] }] });
  const r = await readContract('aptos', '0xfa11', { api });
  assert.equal(r.address, META);
  assert.equal(r.analysis.level, 'high');
  const tok = find(r, 'apt-token').params;
  assert.equal(tok.standard, 'Fungible Asset');
  assert.equal(tok.totalSupply, '100000000000');
  assert.equal(tok.maxSupply, undefined, 'u128::MAX means unlimited');
  assert.deepEqual(find(r, 'apt-mint-power').params.structs, ['pepa::Refs']);
  assert.deepEqual(find(r, 'apt-freeze-power').params.structs, ['pepa::Refs'], 'Option<TransferRef> counts');
  assert.ok(ids(r).includes('apt-burn-power'));
  assert.deepEqual(find(r, 'apt-upgradeable').params.packages, ['pepa']);
  assert.deepEqual(find(r, 'can-mint').params.functions, ['pepa::mint']);
  assert.deepEqual(find(r, 'can-pause').params.functions, ['pepa::set_paused'], 'entry functions count');
  assert.ok(!ids(r).includes('can-blacklist'), 'view functions are not powers');
  assert.match(explain(r, 'th').lines[0].text, /Pepe Aptos.*PEPA.*1,000/);
  assert.ok(api.requests.every(([m]) => m === 'GET' || m === 'VIEW'));
});

test('dispatch hooks are high risk; an immutable creator package is good', async () => {
  const w = faWorld({ extra: [{ type: '0x1::fungible_asset::DispatchFunctionStore', data: {
    withdraw_function: { vec: [{ module_address: CREATOR, module_name: 'pepa', function_name: 'withdraw' }] },
    deposit_function: { vec: [] }, derived_balance_function: { vec: [] },
  } }] });
  w[CREATOR].resources = [registry(2, 'pepa')];
  w[CREATOR].modules[0].abi.structs = [];
  w[CREATOR].modules[0].abi.exposed_functions = [];
  const r = await readContract('aptos', META, { api: fakeAptos(w) });
  assert.deepEqual(find(r, 'apt-dispatch').params.functions, [`${CREATOR}::pepa::withdraw`]);
  assert.ok(ids(r).includes('apt-immutable'));
  assert.ok(!ids(r).includes('apt-mint-power'));
});

test('legacy coin made with managed_coin: creator can mint, freeze and burn', async () => {
  const type = `${CREATOR}::meme::MEME`;
  const world = { [CREATOR]: {
    resources: [
      { type: `0x1::coin::CoinInfo<${type}>`, data: { name: 'Meme', symbol: 'MEME', decimals: 6, supply: { vec: [] } } },
      { type: `0x1::managed_coin::Capabilities<${type}>`, data: {} },
      registry(1),
    ],
    modules: [mod(CREATOR, 'meme', { functions: [fn('transfer', { is_entry: true })] })],
  } };
  const r = await readContract('aptos', '0xc0ffee::meme::MEME', { api: fakeAptos(world, { '0x1::coin::supply': [{ vec: ['42'] }] }) });
  assert.equal(find(r, 'apt-token').params.standard, 'Coin');
  assert.equal(find(r, 'apt-token').params.totalSupply, '42');
  assert.equal(find(r, 'apt-managed-coin').params.account, CREATOR);
  assert.deepEqual(find(r, 'apt-mint-power').params.structs, ['0x1::managed_coin::Capabilities']);
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'apt-managed-coin').text, /can mint at any time/);
});

test('APT itself is framework code and a known token', async () => {
  const type = '0x1::aptos_coin::AptosCoin';
  const world = { [longAddress('0x1')]: { resources: [
    { type: `0x1::coin::CoinInfo<${type}>`, data: { name: 'Aptos Coin', symbol: 'APT', decimals: 8, supply: { vec: [] } } },
  ] } };
  const r = await readContract('aptos', type, { api: fakeAptos(world) });
  assert.ok(ids(r).includes('apt-framework'));
  assert.ok(ids(r).includes('known-issuer'));
  assert.equal(r.analysis.level, 'info');
});

test('official USDt is capped at low; a fake USDT is flagged', async () => {
  const usdt = longAddress('0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b');
  const w = faWorld();
  w[usdt] = w[META];
  delete w[META];
  w[usdt].resources[0] = { type: '0x1::fungible_asset::Metadata', data: { name: 'Tether USD', symbol: 'USDt', decimals: 6 } };
  const r = await readContract('aptos', usdt, { api: fakeAptos(w) });
  assert.ok(ids(r).includes('known-issuer'));
  assert.equal(r.analysis.level, 'low');

  const f = faWorld();
  f[META].resources[0] = { type: '0x1::fungible_asset::Metadata', data: { name: 'Tether', symbol: 'USDT', decimals: 6 } };
  const fake = await readContract('aptos', META, { api: fakeAptos(f) });
  assert.equal(find(fake, 'lookalike').params.issuer, 'Tether');
});

test('accounts, packages and empty addresses', async () => {
  const world = faWorld();
  const pkg = await readContract('aptos', CREATOR, { api: fakeAptos(world) });
  assert.ok(ids(pkg).includes('apt-package'));
  assert.ok(ids(pkg).includes('apt-upgradeable'));
  const user = longAddress('0x5');
  world[longAddress('0x777')] = { resources: [{ type: '0x1::account::Account', data: {} }] };
  const acc = await readContract('aptos', '0x777', { api: fakeAptos(world) });
  assert.equal(find(acc, 'apt-not-token').params.account, true);
  const none = await readContract('aptos', '0x999', { api: fakeAptos(world) });
  assert.ok(ids(none).includes('apt-not-found'));
  assert.ok(user);
});

test('REST client: only mainnet, only GET and view', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([init.method, url]);
    if (url.endsWith('/v1')) return { ok: true, status: 200, json: async () => ({ chain_id: url.includes('testnet') ? 2 : 1 }) };
    if (url.endsWith('/missing')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ hello: 1 }) };
  };
  const api = createAptosRest(['https://testnet.example/v1', 'https://main.example/v1'], 1, { fetchImpl });
  assert.deepEqual(await api.get('/x'), { hello: 1 });
  assert.equal(await api.get('/missing'), null, '404 means "not there"');
  await api.view({ function: '0x1::coin::supply', type_arguments: [], arguments: [] });
  assert.ok(seen.some(([m, u]) => m === 'GET' && u === 'https://main.example/v1/x'));
  assert.ok(!seen.some(([, u]) => u.startsWith('https://testnet.example/v1/')), 'testnet endpoint was never used for data');
  assert.deepEqual([...new Set(seen.map(([m, u]) => (m === 'POST' ? u.replace(/^https:\/\/[^/]+/, '') : 'GET')))].sort(), ['/v1/view', 'GET']);
});
