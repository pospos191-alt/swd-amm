// Starknet reader. Shapes follow starknet.js: Sierra classes carry `abi` as
// a JSON string with `interface` items and `state_mutability`; Cairo 0 classes
// carry an ABI array; strings come back as one short-string felt or a
// ByteArray (data_len, words…, pending_word, pending_len); u256 = [low, high].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { createStarknetRpc } from '../src/rpc.js';
import { selector, decodeString, decodeU256, isStarknetAddress, SN_MAIN } from '../src/starknet.js';
import { explain } from '../src/explain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);
const ADDR = '0x01' + '23'.repeat(31);
const OWNER = '0x' + 'ab'.repeat(32);
const IMPL = '0x5aa1';

const felt = (s) => '0x' + Buffer.from(s).toString('hex');
const byteArray = (s) => {
  const words = []; let i = 0;
  for (; i + 31 <= s.length; i += 31) words.push(felt(s.slice(i, i + 31)));
  const rest = s.slice(i);
  return ['0x' + words.length.toString(16), ...words, rest ? felt(rest) : '0x0', '0x' + rest.length.toString(16)];
};
const fn = (name, mut = 'external') => ({ type: 'function', name, inputs: [], outputs: [], state_mutability: mut });

const ERC20_ABI = JSON.stringify([
  { type: 'impl', name: 'ERC20Impl', interface_name: 'IERC20' },
  { type: 'interface', name: 'IERC20', items: [fn('name', 'view'), fn('symbol', 'view'), fn('decimals', 'view'), fn('total_supply', 'view'), fn('balance_of', 'view'), fn('transfer'), fn('approve')] },
  { type: 'interface', name: 'IAdmin', items: [fn('mint'), fn('set_paused'), fn('is_paused', 'view'), fn('upgrade'), fn('owner', 'view')] },
  { type: 'event', name: 'Transfer', kind: 'struct', members: [] },
]);

function fakeStarknet({ classes = {}, implClasses = {}, calls = {} }) {
  const seen = [];
  return {
    seen,
    async call(method, params) {
      seen.push(method);
      if (method === 'starknet_getClassAt') {
        const c = classes[params[1]];
        if (!c) throw new Error('Contract not found');
        return c;
      }
      if (method === 'starknet_getClass') return implClasses[params[1]] ?? (() => { throw new Error('Class hash not found'); })();
      if (method === 'starknet_call') {
        const { contract_address: to, entry_point_selector: sel } = params[0];
        const r = calls[`${to}:${sel}`];
        if (!r) throw new Error('Entry point not found');
        return r;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}
const at = (addr, name) => `${addr}:${selector(name)}`;

test('selectors, strings, u256 and addresses', () => {
  assert.equal(selector('balanceOf'), '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e');
  assert.equal(decodeString([felt('Ether')]), 'Ether');
  assert.equal(decodeString(byteArray('A very long token name that needs two words')), 'A very long token name that needs two words');
  assert.equal(decodeU256(['0x5', '0x1']), 5n + (1n << 128n));
  assert.ok(isStarknetAddress('0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'));
  assert.ok(!isStarknetAddress('0x' + 'f'.repeat(64)), 'not a field element');
  assert.ok(!isStarknetAddress('0x0'));
});

test('Cairo 1 token with mint, pause and upgrade, owned', async () => {
  const rpc = fakeStarknet({
    classes: { [ADDR]: { sierra_program: ['0x1'], contract_class_version: '0.1.0', entry_points_by_type: {}, abi: ERC20_ABI } },
    calls: {
      [at(ADDR, 'name')]: byteArray('Stark Meme'), [at(ADDR, 'symbol')]: [felt('SMEME')], [at(ADDR, 'decimals')]: ['0x12'],
      [at(ADDR, 'total_supply')]: ['0x3635c9adc5dea00000', '0x0'], [at(ADDR, 'owner')]: [OWNER],
    },
  });
  const r = await readContract('starknet', ADDR, { rpc });
  assert.equal(r.analysis.level, 'high');
  assert.equal(r.token.name, 'Stark Meme');
  assert.equal(r.token.totalSupply, (1000n * 10n ** 18n).toString());
  assert.deepEqual(find(r, 'sn-upgradeable').params.functions, ['upgrade']);
  assert.deepEqual(find(r, 'can-mint').params.functions, ['contract::mint']);
  assert.deepEqual(find(r, 'can-pause').params.functions, ['contract::set_paused'], 'view functions are not powers');
  assert.equal(r.owner, OWNER);
  assert.match(explain(r, 'th').lines[0].text, /Stark Meme.*SMEME.*1,000/);
  assert.ok(rpc.seen.every((m) => m.startsWith('starknet_')));
});

test('renounced owner lowers powers; no upgrade function means no upgrade finding', async () => {
  const abi = JSON.stringify([{ type: 'interface', name: 'I', items: [fn('name', 'view'), fn('symbol', 'view'), fn('decimals', 'view'), fn('total_supply', 'view'), fn('balance_of', 'view'), fn('transfer'), fn('mint'), fn('owner', 'view')] }]);
  const r = await readContract('starknet', ADDR, { rpc: fakeStarknet({
    classes: { [ADDR]: { abi, sierra_program: [] } },
    calls: { [at(ADDR, 'name')]: [felt('Fair')], [at(ADDR, 'symbol')]: [felt('FAIR')], [at(ADDR, 'decimals')]: ['0x6'], [at(ADDR, 'total_supply')]: ['0x1', '0x0'], [at(ADDR, 'owner')]: ['0x0'] },
  }) });
  assert.ok(ids(r).includes('owner-renounced'));
  assert.equal(find(r, 'can-mint').severity, 'low');
  assert.ok(!ids(r).includes('sn-upgradeable'));
});

test('Cairo 0 proxy: the implementation class ABI is read too', async () => {
  const proxyAbi = [{ type: 'function', name: 'get_implementation_hash', inputs: [], outputs: [], stateMutability: 'view' }, { type: 'function', name: 'upgrade', inputs: [], outputs: [] }];
  const implAbi = [{ type: 'function', name: 'balanceOf', inputs: [], outputs: [], stateMutability: 'view' }, { type: 'function', name: 'transfer', inputs: [], outputs: [] }, { type: 'function', name: 'addToBlacklist', inputs: [], outputs: [] }, { type: 'function', name: 'name', stateMutability: 'view' }, { type: 'function', name: 'symbol', stateMutability: 'view' }, { type: 'function', name: 'decimals', stateMutability: 'view' }, { type: 'function', name: 'totalSupply', stateMutability: 'view' }];
  const r = await readContract('starknet', ADDR, { rpc: fakeStarknet({
    classes: { [ADDR]: { program: 'H4sI', entry_points_by_type: {}, abi: proxyAbi } },
    implClasses: { [IMPL]: { program: 'H4sI', abi: implAbi } },
    calls: { [at(ADDR, 'get_implementation_hash')]: [IMPL], [at(ADDR, 'name')]: [felt('Old')], [at(ADDR, 'symbol')]: [felt('OLD')], [at(ADDR, 'decimals')]: ['0x12'], [at(ADDR, 'totalSupply')]: ['0x64', '0x0'] },
  }) });
  assert.equal(r.starknet.cairo, 0);
  assert.equal(find(r, 'sn-upgradeable').params.implementation, IMPL);
  assert.deepEqual(find(r, 'can-blacklist').params.functions, ['contract::add_to_blacklist'], 'camelCase names are read too');
  assert.equal(r.token.symbol, 'OLD');
});

test('known STRK is capped; a copy is flagged; missing and non-token contracts', async () => {
  const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
  const token = (addr, sym) => ({ classes: { [addr]: { abi: ERC20_ABI, sierra_program: [] } }, calls: {
    [at(addr, 'name')]: [felt('Starknet Token')], [at(addr, 'symbol')]: [felt(sym)], [at(addr, 'decimals')]: ['0x12'], [at(addr, 'total_supply')]: ['0x1', '0x0'], [at(addr, 'owner')]: [OWNER] } });
  const real = await readContract('starknet', STRK, { rpc: fakeStarknet(token(STRK, 'STRK')) });
  assert.ok(ids(real).includes('known-issuer'));
  assert.equal(real.analysis.level, 'low');
  const fake = await readContract('starknet', ADDR, { rpc: fakeStarknet(token(ADDR, 'STRK')) });
  assert.ok(ids(fake).includes('lookalike'));

  assert.ok(ids(await readContract('starknet', ADDR, { rpc: fakeStarknet({}) })).includes('sn-not-found'));
  const dex = await readContract('starknet', ADDR, { rpc: fakeStarknet({ classes: { [ADDR]: { abi: JSON.stringify([fn('swap'), fn('set_fee_rate')]), sierra_program: [] } } }) });
  assert.equal(find(dex, 'sn-contract').params.count, 2);
  assert.ok(ids(dex).includes('can-change-fee'));
});

test('RPC client: SN_MAIN only, read methods only', async () => {
  const fetchImpl = async (url, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === 'starknet_chainId' ? (url.includes('sepolia') ? '0x534e5f5345504f4c4941' : SN_MAIN) : ['0x1'];
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  const rpc = createStarknetRpc(['https://sepolia.example', 'https://main.example'], SN_MAIN, { fetchImpl });
  assert.deepEqual(await rpc.call('starknet_call', [{}, 'latest']), ['0x1']);
  await assert.rejects(rpc.call('starknet_addInvokeTransaction', [{}]), /not allowed/);
});
