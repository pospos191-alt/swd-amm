// Sui reader tests. Responses follow the Sui GraphQL schema
// (@mysten/sui src/graphql/generated/schema.graphql): coinMetadata with
// supplyState / regulatedState / denyCap, package.previousTransaction
// object changes, multiGetObjects for the caps' current owners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { createSuiGraphql, isReadOnlyGraphql } from '../src/rpc.js';
import { SUI_MAINNET, Q_COIN } from '../src/sui.js';
import { isChainAddress } from '../src/chains.js';
import { explain } from '../src/explain.js';
import { longAddress, normalizeType, scanFunctions } from '../src/move.js';

const PKG = longAddress('0xabc123');
const TYPE = `${PKG}::meme::MEME`;
const TREASURY = longAddress('0x7777');
const UPCAP = longAddress('0x8888');
const DEV = longAddress('0xdead');
const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);

/** A fake Sui GraphQL service. `state` describes the chain. */
function fakeSui(state) {
  const calls = [];
  const owner = (o) => (o.kind === 'address' ? { __typename: 'AddressOwner', address: { address: o.address } }
    : o.kind === 'object' ? { __typename: 'ObjectOwner', address: { address: o.address } }
      : o.kind === 'shared' ? { __typename: 'Shared' } : { __typename: 'Immutable' });
  const api = {
    calls,
    async query(q, v) {
      calls.push(q);
      if (/NeuroSuiCoin/.test(q)) {
        const meta = state.coins?.[v.t] ?? null;
        const pkg = state.packages?.[v.p] ?? null;
        return {
          coinMetadata: meta && { ...meta, denyCap: meta.denyCap ? { address: meta.denyCap.id, owner: owner(meta.denyCap.owner) } : null },
          package: pkg && {
            address: v.p,
            previousTransaction: { digest: 'D', effects: { objectChanges: { nodes: (pkg.created ?? []).map((c) => ({
              address: c.id, idCreated: true,
              outputState: { owner: owner(c.owner), asMoveObject: { contents: { type: { repr: normalizeType(c.type) } } } },
            })) } } },
          },
        };
      }
      if (/NeuroSuiModules/.test(q)) {
        const pkg = state.packages?.[v.p];
        return { package: pkg && { modules: { pageInfo: { hasNextPage: false }, nodes: Object.entries(pkg.modules ?? {}).map(([name, fns]) => ({
          name, functions: { pageInfo: { hasNextPage: false }, nodes: fns.map(([n, visibility, isEntry]) => ({ name: n, visibility, isEntry })) },
        })) } } };
      }
      if (/NeuroSuiObjects/.test(q)) {
        return { multiGetObjects: v.keys.map(({ address }) => {
          const o = state.live?.[address];
          return o ? { address, owner: owner(o.owner), asMoveObject: { contents: { type: { repr: '' }, json: o.json ?? {} } } } : null;
        }) };
      }
      throw new Error('unexpected query');
    },
  };
  return api;
}

const memeState = (over = {}) => ({
  coins: { [TYPE]: { name: 'Meme', symbol: 'MEME', decimals: 9, supply: '1000000000000000000', supplyState: null, regulatedState: 'UNREGULATED', allowGlobalPause: null, ...over.meta } },
  packages: { [PKG]: {
    created: [
      { id: TREASURY, type: `0x2::coin::TreasuryCap<${TYPE}>`, owner: { kind: 'address', address: DEV } },
      { id: UPCAP, type: '0x2::package::UpgradeCap', owner: { kind: 'address', address: DEV } },
    ],
    modules: { meme: [['mint', 'PUBLIC', false], ['add_to_blacklist', 'PRIVATE', true], ['total', 'PUBLIC', false], ['init', 'PRIVATE', false]] },
  } },
  live: { [TREASURY]: { owner: { kind: 'address', address: DEV } }, [UPCAP]: { owner: { kind: 'address', address: DEV }, json: { policy: 0 } } },
  ...over.state,
});

test('Sui addresses and coin types are recognised', () => {
  assert.ok(isChainAddress('sui', '0x2::sui::SUI'));
  assert.ok(isChainAddress('sui', TYPE));
  assert.ok(isChainAddress('sui', PKG));
  assert.ok(!isChainAddress('sui', '0x2::sui'));
  assert.ok(!isChainAddress('sui', '0xzz::a::B'));
  assert.ok(!isChainAddress('sui', `${PKG}::m::N<0x2::sui::SUI>`), 'generic coin types are not accepted');
});

test('a fresh meme coin: dev wallet can mint, upgrade and blacklist', async () => {
  const api = fakeSui(memeState());
  const r = await readContract('sui', '0xabc123::meme::MEME', { api });
  assert.equal(r.address, TYPE, 'address normalised to 64 digits');
  assert.equal(r.analysis.level, 'high');
  assert.deepEqual(find(r, 'sui-treasury').params, { holder: DEV, where: 'address' });
  assert.equal(find(r, 'sui-treasury').severity, 'high');
  assert.equal(find(r, 'sui-upgradeable').params.policy, 'compatible');
  assert.deepEqual(find(r, 'can-mint').params.functions, ['meme::mint']);
  assert.deepEqual(find(r, 'can-blacklist').params.functions, ['meme::add_to_blacklist'], 'entry functions count even if private');
  assert.ok(!ids(r).includes('can-pause'));
  const th = explain(r, 'th');
  assert.equal(th.title, 'เสี่ยงสูง');
  assert.match(th.lines[0].text, /Meme.*MEME.*1,000,000,000/);
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'sui-treasury').text, new RegExp(DEV));
  assert.ok(api.calls.every(isReadOnlyGraphql), 'every query is read-only');
});

test('fixed supply and a destroyed UpgradeCap read as safe', async () => {
  const state = memeState({ meta: { supplyState: 'FIXED' } });
  state.live = {};
  state.packages[PKG].modules = { meme: [['total', 'PUBLIC', false]] };
  const r = await readContract('sui', TYPE, { api: fakeSui(state) });
  assert.deepEqual(ids(r).filter((i) => !['sui-coin', 'move-caveat'].includes(i)), ['sui-supply-fixed', 'sui-upgrade-cap-gone']);
  assert.equal(r.analysis.level, 'low');
});

test('regulated coin with global pause; treasury kept inside a contract is medium', async () => {
  const state = memeState({ meta: { regulatedState: 'REGULATED', allowGlobalPause: true, denyCap: { id: '0x99', owner: { kind: 'address', address: DEV } } } });
  state.live[TREASURY] = { owner: { kind: 'object', address: longAddress('0x55') } };
  const r = await readContract('sui', TYPE, { api: fakeSui(state) });
  assert.equal(find(r, 'sui-regulated').params.holder, DEV);
  assert.ok(ids(r).includes('sui-global-pause'));
  assert.equal(find(r, 'sui-treasury').severity, 'medium');
  assert.equal(find(r, 'sui-treasury').params.where, 'object');
});

test('official USDC: issuer powers are capped at low; a copy is flagged', async () => {
  const usdcPkg = longAddress('0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7');
  const usdc = `${usdcPkg}::usdc::USDC`;
  const state = {
    coins: { [usdc]: { name: 'USDC', symbol: 'USDC', decimals: 6, supply: '5', supplyState: null, regulatedState: 'REGULATED', allowGlobalPause: true } },
    packages: { [usdcPkg]: { created: [], modules: {} } },
  };
  const r = await readContract('sui', usdc, { api: fakeSui(state) });
  assert.ok(ids(r).includes('known-issuer'));
  assert.equal(r.analysis.level, 'low');
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'sui-regulated').text, /Circle/);

  const fake = memeState({ meta: { symbol: 'USDC', name: 'USD Coin' } });
  const f = await readContract('sui', TYPE, { api: fakeSui(fake) });
  assert.equal(find(f, 'lookalike').params.issuer, 'Circle');
});

test('SUI itself is system code with a fixed supply', async () => {
  const sui = normalizeType('0x2::sui::SUI');
  const state = {
    coins: { [sui]: { name: 'Sui', symbol: 'SUI', decimals: 9, supply: '10000000000000000000', supplyState: 'FIXED', regulatedState: 'UNREGULATED' } },
    packages: { [longAddress('0x2')]: { created: [], modules: { coin: [['mint', 'PUBLIC', false]] } } },
  };
  const r = await readContract('sui', '0x2::sui::SUI', { api: fakeSui(state) });
  assert.ok(ids(r).includes('sui-system'));
  assert.ok(ids(r).includes('known-issuer'));
  assert.ok(!ids(r).includes('sui-upgradeable'));
});

test('package id, missing coin and missing address', async () => {
  const pkg = await readContract('sui', PKG, { api: fakeSui(memeState()) });
  assert.ok(ids(pkg).includes('sui-package'));
  assert.ok(ids(pkg).includes('sui-upgradeable'));
  const wrong = await readContract('sui', `${PKG}::meme::OTHER`, { api: fakeSui(memeState()) });
  assert.ok(ids(wrong).includes('sui-not-coin'));
  const none = await readContract('sui', '0x1234', { api: fakeSui({}) });
  assert.deepEqual(ids(none), ['sui-not-found', 'nothing-found', 'move-caveat']);
});

test('function-name rules match whole words only', () => {
  const p = scanFunctions([
    { module: 'm', name: 'mint_to', callable: true },
    { module: 'm', name: 'minter_count', callable: true },
    { module: 'm', name: 'set_minter', callable: true },
    { module: 'm', name: 'mint', callable: false },
    { module: 'm', name: 'set_buy_fee', callable: true },
    { module: 'm', name: 'fee', callable: true },
    { module: 'm', name: 'emergency_pause', callable: true },
    { module: 'm', name: 'force_transfer', callable: true },
  ]);
  assert.deepEqual(p.mint, ['m::mint_to', 'm::set_minter']);
  assert.deepEqual(p.fee, ['m::set_buy_fee']);
  assert.deepEqual(p.pause, ['m::emergency_pause']);
  assert.deepEqual(p.seize, ['m::force_transfer']);
});

test('GraphQL client: queries only, and only on Sui mainnet', async () => {
  assert.ok(isReadOnlyGraphql(Q_COIN));
  assert.ok(!isReadOnlyGraphql('mutation { executeTransaction(transactionDataBcs: "", signatures: []) { effects { digest } } }'));
  assert.ok(!isReadOnlyGraphql('query { a } mutation { b }'));
  assert.ok(isReadOnlyGraphql('query { a(x: "mutation") }'), 'the word inside a string is fine');

  const seen = [];
  const fetchImpl = async (url, init) => {
    const { query } = JSON.parse(init.body);
    seen.push(url);
    const chain = url.includes('testnet') ? '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD' : SUI_MAINNET;
    const data = /chainIdentifier/.test(query) ? { chainIdentifier: chain } : { ok: 1 };
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const api = createSuiGraphql(['https://sui-testnet.example/graphql', 'https://sui.example/graphql'], SUI_MAINNET, { fetchImpl });
  assert.deepEqual(await api.query('query { ok }'), { ok: 1 });
  assert.ok(seen.every((u) => u === seen[0] || u.includes('sui.example')));
  assert.equal(seen.at(-1), 'https://sui.example/graphql', 'the testnet endpoint was refused');
  await assert.rejects(api.query('mutation { x }'), /all RPC endpoints failed: only queries/);
});
