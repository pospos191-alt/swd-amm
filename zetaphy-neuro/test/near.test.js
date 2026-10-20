// NEAR reader. RPC shapes follow @near-js/types (AccountView.code_hash,
// AccessKeyList.keys[].access_key.permission, ContractCodeView.code_base64,
// call_function result: number[]). The WASM modules are built byte by byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { createNearRpc } from '../src/rpc.js';
import { wasmExports, isNearAccount } from '../src/near.js';
import { explain } from '../src/explain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);

const leb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
/** A minimal WASM module exporting `names` as functions (plus a memory export, kind 2). */
function wasm(names) {
  const enc = (s) => [...leb(Buffer.byteLength(s)), ...Buffer.from(s)];
  const exports = [...leb(names.length + 1), ...names.flatMap((n, i) => [...enc(n), 0, ...leb(i)]), ...enc('memory'), 2, 0];
  const typeSec = [1, ...leb(4), 1, 0x60, 0, 0]; // one type () -> ()
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...typeSec, 7, ...leb(exports.length), ...exports]);
}

function fakeNear(accounts) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params.request_type, params.method_name]);
      const a = accounts[params.account_id];
      if (!a) throw new Error(`[-32000] Server error: account ${params.account_id} does not exist while viewing (UNKNOWN_ACCOUNT)`);
      switch (params.request_type) {
        case 'view_account': return { amount: '1', locked: '0', code_hash: a.code ? 'Hash1111111111111111111111111111' : '11111111111111111111111111111111', storage_usage: 1, storage_paid_at: 0 };
        case 'view_access_key_list': return { keys: a.keys ?? [] };
        case 'view_code': return { code_base64: wasm(a.code).toString('base64'), hash: 'h' };
        case 'call_function': {
          const v = a.views?.[params.method_name];
          if (v === undefined) throw new Error('wasm execution failed: MethodNotFound');
          return { result: [...Buffer.from(JSON.stringify(v))], logs: [] };
        }
        default: throw new Error('unexpected');
      }
    },
  };
}

const FULL = { public_key: 'ed25519:x', access_key: { nonce: 1, permission: 'FullAccess' } };
const FN_KEY = { public_key: 'ed25519:y', access_key: { nonce: 1, permission: { FunctionCall: { allowance: '0', receiver_id: 'x', method_names: [] } } } };
const TOKEN_METHODS = ['ft_transfer', 'ft_transfer_call', 'ft_balance_of', 'ft_total_supply', 'ft_metadata', 'storage_deposit'];

test('account ids and the WASM export reader', () => {
  for (const ok of ['wrap.near', 'usdt.tether-token.near', 'a-b_c.d', '0x' + 'ab'.repeat(20), 'ab'.repeat(32)]) assert.ok(isNearAccount(ok), ok);
  for (const bad of ['A.near', 'x', 'a..near', '-a.near', 'a.near.', 'a'.repeat(65)]) assert.ok(!isNearAccount(bad), bad);
  assert.deepEqual(wasmExports(wasm(['mint', 'ft_transfer'])), ['mint', 'ft_transfer'], 'memory (kind 2) is not a function');
  assert.throws(() => wasmExports(Buffer.from('not wasm at all')), /not wasm/);
});

test('NEP-141 token whose account still has a full-access key and a mint method', async () => {
  const rpc = fakeNear({ 'meme.near': {
    code: [...TOKEN_METHODS, 'mint', 'set_paused', 'is_paused', 'get_owner', 'upgrade'],
    keys: [FULL, FN_KEY],
    views: { ft_metadata: { spec: 'ft-1.0.0', name: 'Meme', symbol: 'MEME', decimals: 24 }, ft_total_supply: '1000000000000000000000000000' },
  } });
  const r = await readContract('near', 'meme.near', { rpc });
  assert.equal(r.analysis.level, 'high');
  assert.equal(find(r, 'near-full-access').params.count, 1);
  assert.deepEqual(find(r, 'can-mint').params.functions, ['contract::mint']);
  assert.deepEqual(find(r, 'can-pause').params.functions, ['contract::set_paused'], 'getters like is_paused are not powers');
  assert.equal(find(r, 'near-upgrade-method').severity, 'medium');
  assert.equal(r.near.fullAccessKeys, 1);
  assert.match(explain(r, 'th').lines[0].text, /Meme.*MEME.*1,000/);
  assert.ok(rpc.calls.every(([m]) => m === 'query'));
});

test('a locked token (no full-access key) with no extra powers reads as clean', async () => {
  const rpc = fakeNear({ 'fair.near': {
    code: TOKEN_METHODS, keys: [FN_KEY],
    views: { ft_metadata: { spec: 'ft-1.0.0', name: 'Fair', symbol: 'FAIR', decimals: 18 }, ft_total_supply: '5' },
  } });
  const r = await readContract('near', 'fair.near', { rpc });
  assert.deepEqual(ids(r), ['near-token', 'near-locked', 'near-caveat']);
  // ... but an upgrade method with no key is the real lever: high.
  const up = await readContract('near', 'fair.near', { rpc: fakeNear({ 'fair.near': {
    code: [...TOKEN_METHODS, 'update_contract'], keys: [],
    views: { ft_metadata: { name: 'Fair', symbol: 'FAIR', decimals: 18 }, ft_total_supply: '5' },
  } }) });
  assert.equal(find(up, 'near-upgrade-method').severity, 'high');
});

test('official USDt is capped at low; copies are flagged; plain and missing accounts', async () => {
  const usdt = { code: [...TOKEN_METHODS, 'mint', 'add_to_blacklist'], keys: [FULL],
    views: { ft_metadata: { name: 'Tether USD', symbol: 'USDt', decimals: 6 }, ft_total_supply: '10' } };
  const real = await readContract('near', 'usdt.tether-token.near', { rpc: fakeNear({ 'usdt.tether-token.near': usdt }) });
  assert.ok(ids(real).includes('known-issuer'));
  assert.equal(real.analysis.level, 'low');
  const fake = await readContract('near', 'usdt-claim.near', { rpc: fakeNear({ 'usdt-claim.near': usdt }) });
  assert.equal(find(fake, 'lookalike').params.issuer, 'Tether');

  const plain = await readContract('near', 'alice.near', { rpc: fakeNear({ 'alice.near': { keys: [FULL] } }) });
  assert.deepEqual(ids(plain), ['near-no-contract', 'nothing-found', 'near-caveat']);
  const none = await readContract('near', 'nobody.near', { rpc: fakeNear({}) });
  assert.ok(ids(none).includes('near-not-found'));
});

test('a contract that is not a token', async () => {
  const r = await readContract('near', 'dex.near', { rpc: fakeNear({ 'dex.near': { code: ['swap', 'add_liquidity', 'set_fee_rate'], keys: [] } }) });
  assert.equal(find(r, 'near-contract').params.count, 3);
  assert.deepEqual(find(r, 'can-change-fee').params.functions, ['contract::set_fee_rate']);
});

test('RPC client: mainnet only, read methods only', async () => {
  const fetchImpl = async (url, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === 'status' ? { chain_id: url.includes('test') ? 'testnet' : 'mainnet' } : { ok: 1 };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  const rpc = createNearRpc(['https://test.example', 'https://main.example'], 'mainnet', { fetchImpl });
  assert.deepEqual(await rpc.call('query', { request_type: 'view_account', account_id: 'a.near', finality: 'final' }), { ok: 1 });
  await assert.rejects(rpc.call('broadcast_tx_commit', ['x']), /not allowed/);
});
