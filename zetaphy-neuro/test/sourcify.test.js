// Verified source (Sourcify v2) and the dependency-free keccak behind it.
// The contract is compiled from test/helpers/contracts.sol and run on the
// in-memory EVM; Sourcify's answer is a fake that returns its real ABI.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { keccak256, selectorOf } from '../src/keccak.js';
import { abiFunctions, categorize, lookupSourcify } from '../src/sourcify.js';
import { readContract } from '../src/reader.js';
import { explain } from '../src/explain.js';
import { createLocalChain, abis } from './helpers/local-chain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);
let chain;
before(async () => { chain = await createLocalChain(); });

test('keccak-256 matches @noble/hashes for every length across block boundaries', () => {
  for (let n = 0; n < 300; n++) {
    const b = randomBytes(n);
    assert.equal(Buffer.from(keccak256(b)).toString('hex'), Buffer.from(keccak_256(b)).toString('hex'), `length ${n}`);
  }
  assert.equal(selectorOf('transfer(address,uint256)'), 'a9059cbb');
  assert.equal(selectorOf('swap((address,uint256)[],bytes)'), Buffer.from(keccak_256(Buffer.from('swap((address,uint256)[],bytes)'))).toString('hex').slice(0, 8));
});

test('ABI functions: canonical tuple types, view functions are not powers', () => {
  const fns = abiFunctions([
    { type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }] }, { type: 'bytes' }] },
    { type: 'function', name: 'mintRewards', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }] },
    { type: 'function', name: 'isFrozen', stateMutability: 'view', inputs: [{ type: 'address' }] },
    { type: 'function', name: 'freezeWallet', stateMutability: 'nonpayable', inputs: [{ type: 'address' }] },
    { type: 'event', name: 'Frozen', inputs: [] },
    { type: 'function', name: 'bad name', inputs: [] },
  ]);
  assert.deepEqual(fns.map((f) => f.sig), ['execute((address,uint256)[],bytes)', 'mintRewards(address,uint256)', 'isFrozen(address)', 'freezeWallet(address)']);
  const cats = categorize(fns);
  assert.equal(cats[selectorOf('mintRewards(address,uint256)')], 'mint');
  assert.equal(cats[selectorOf('freezeWallet(address)')], 'blacklist');
  assert.equal(cats[selectorOf('isFrozen(address)')], undefined, 'view');
});

test('a verified ABI names hidden powers the selector list missed', async () => {
  const addr = await chain.deploy('HiddenPowers');
  const plain = await readContract('bsc', addr, { rpc: chain.rpc });
  assert.ok(ids(plain).includes('unknown-functions'));
  assert.ok(!ids(plain).includes('can-seize'));
  assert.equal(plain.source, undefined, 'not checked when an RPC is injected');

  const seen = [];
  const sourcify = async (chainId, a) => {
    seen.push([chainId, a]);
    return { match: 'exact', language: 'Solidity', compiler: 'v0.8.26+commit.8a97fa7a', name: 'HiddenPowers', abi: abis().HiddenPowers, url: `https://repo.sourcify.dev/${chainId}/${a}` };
  };
  const r = await readContract('bsc', addr, { rpc: chain.rpc, sourcify });
  assert.deepEqual(seen, [[56, addr.toLowerCase()]]);
  assert.deepEqual(find(r, 'can-mint').params.functions, ['mintRewards(address,uint256)']);
  assert.deepEqual(find(r, 'can-blacklist').params.functions, ['freezeWallet(address)']);
  assert.deepEqual(find(r, 'can-seize').params.functions, ['confiscate(address)']);
  assert.ok(!ids(r).includes('unknown-functions') || find(r, 'unknown-functions').params.count < find(plain, 'unknown-functions').params.count);
  assert.equal(find(r, 'source-verified').params.match, 'exact');
  assert.equal(r.source.name, 'HiddenPowers');
  assert.ok(r.functions.includes('setRewardRate(uint256)'), 'named even without a category');
  assert.match(explain(r, 'en').lines.find((l) => l.id === 'source-verified').text, /byte for byte.*HiddenPowers, Solidity/);
});

test('unverified and unreachable Sourcify', async () => {
  const addr = await chain.deploy('CleanToken');
  const none = await readContract('eth', addr, { rpc: chain.rpc, sourcify: async () => null });
  assert.ok(ids(none).includes('source-unverified'));
  assert.equal(none.source, null);
  assert.ok(ids(none).includes('nothing-found'), 'public source or not, a clean token still reads as clean');
  const down = await readContract('eth', addr, { rpc: chain.rpc, sourcify: async () => { throw new Error('offline'); } });
  assert.ok(!ids(down).some((i) => i.startsWith('source-')), 'not checked: say nothing');
});

test('lookup: v2 path, exact vs partial match, 404', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('0xdead')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ match: url.includes('0xbeef') ? 'match' : 'exact_match', abi: [], compilation: { language: 'Vyper', compilerVersion: '0.4.0', name: 'Pool' } }) };
  };
  assert.equal(await lookupSourcify(1, '0xdead', { fetchImpl }), null);
  assert.equal((await lookupSourcify(1, '0xbeef', { fetchImpl })).match, 'partial');
  const v = await lookupSourcify(8453, '0xcafe', { fetchImpl });
  assert.deepEqual([v.match, v.language, v.name, v.url], ['exact', 'Vyper', 'Pool', 'https://repo.sourcify.dev/8453/0xcafe']);
  assert.equal(urls[2], 'https://sourcify.dev/server/v2/contract/8453/0xcafe?fields=abi,compilation');
});
