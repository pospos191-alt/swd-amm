// End to end: real compiled contracts on an in-memory EVM, read through
// readContract exactly as on mainnet. Runs with the optimizer on and off,
// since the optimizer changes how selectors appear in the bytecode.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { createLocalChain, encodeAddressBytes } from './helpers/local-chain.js';

const ids = (r) => r.analysis.findings.map((f) => f.id);
const sev = (r, id) => r.analysis.findings.find((f) => f.id === id)?.severity;

for (const optimize of [true, false]) {
  describe(`reader (optimizer ${optimize ? 'on' : 'off'})`, () => {
    let chain;
    const read = (addr) => readContract('bsc', addr, { rpc: chain.rpc });
    before(async () => { chain = await createLocalChain({ optimize }); });

    test('honest fixed-supply token: no risk found', async () => {
      const r = await read(await chain.deploy('CleanToken'));
      assert.equal(r.analysis.level, 'info');
      assert.ok(ids(r).includes('nothing-found'));
      const erc = r.analysis.findings.find((f) => f.id === 'erc20');
      assert.deepEqual(erc.params, { name: 'Clean Token', symbol: 'CLEAN', decimals: 18, totalSupply: (10n ** 24n).toString() });
    });

    test('scam-style token: every owner power is flagged', async () => {
      const r = await read(await chain.deploy('ScamToken'));
      assert.equal(r.analysis.level, 'high');
      assert.equal(r.analysis.control, 'owner');
      assert.equal(r.owner, '0x1111111111111111111111111111111111111111');
      for (const id of ['owner-active', 'can-mint', 'can-blacklist', 'can-pause', 'can-change-fee', 'trading-switch', 'can-limit', 'fee-exempt']) {
        assert.ok(ids(r).includes(id), `missing ${id}`);
      }
      assert.equal(sev(r, 'can-mint'), 'high');
    });

    test('unnamed dispatcher functions are reported instead of "nothing found"', async () => {
      const a = await chain.deploy('ZetaStyleToken', '0'.repeat(63) + '1' + '0'.repeat(63) + '5');
      const r = await read(a);
      const f = r.analysis.findings.find((x) => x.id === 'unknown-functions');
      assert.equal(f.severity, 'low', 'an owner still controls it');
      assert.ok(f.params.count >= 1);
      assert.ok(!ids(r).includes('nothing-found'));
      assert.deepEqual(r.unknownSelectors, f.params.selectors);
      const clean = await read(await chain.deploy('CleanToken'));
      assert.ok(!ids(clean).includes('unknown-functions'), 'all ERC-20 functions are named');
    });

    test('renounced owner lowers owner powers to low', async () => {
      const r = await read(await chain.deploy('RenouncedToken'));
      assert.equal(r.analysis.control, 'renounced');
      assert.ok(ids(r).includes('owner-renounced'));
      assert.equal(sev(r, 'can-mint'), 'low');
      assert.equal(r.analysis.level, 'low');
    });

    test('role-based token: mint stays high', async () => {
      const r = await read(await chain.deploy('RolesToken'));
      assert.equal(r.analysis.control, 'roles');
      assert.equal(sev(r, 'can-mint'), 'high');
    });

    test('phishing name is flagged and the symbol is cleaned', async () => {
      const r = await read(await chain.deploy('PhishToken'));
      assert.equal(sev(r, 'name-has-link'), 'high');
      assert.equal(r.token.symbol, 'CLAIM');
    });

    test('SELFDESTRUCT is flagged', async () => {
      const r = await read(await chain.deploy('Killable'));
      assert.equal(sev(r, 'selfdestruct'), 'high');
      assert.ok(ids(r).includes('not-erc20'));
    });

    test('EIP-1967 proxy: upgradeable, admin found, token read through the proxy', async () => {
      const impl = await chain.deploy('UpgradeableToken');
      const proxy = await chain.deploy('Proxy1967', encodeAddressBytes(impl, '8129fc1c')); // initialize()
      const r = await read(proxy);
      assert.equal(r.proxy.kind, 'eip1967');
      assert.equal(r.proxy.implementation, impl.toLowerCase());
      assert.equal(r.proxy.admin, '0x1111111111111111111111111111111111111111');
      assert.equal(sev(r, 'proxy-upgradeable'), 'high');
      assert.equal(r.token.name, 'Upgradeable Token');
      assert.ok(!ids(r).includes('delegatecall'), 'a proxy delegatecall is expected, not a finding');
    });

    test('ZeppelinOS proxy (USDC style): implementation found through the old slots', async () => {
      const impl = await chain.deploy('UpgradeableToken');
      const proxy = await chain.deploy('ProxyZos', encodeAddressBytes(impl, '8129fc1c'));
      const r = await read(proxy);
      assert.equal(r.proxy.kind, 'zos');
      assert.equal(r.proxy.implementation, impl.toLowerCase());
      assert.equal(sev(r, 'proxy-upgradeable'), 'high');
      assert.ok(ids(r).includes('erc20'), 'the token behind the proxy is read');
      assert.ok(!ids(r).includes('delegatecall'));
    });

    test('EIP-1167 clone: not upgradeable', async () => {
      const impl = await chain.deploy('CleanToken');
      const clone = '0x' + 'c1'.repeat(20);
      await chain.putCode(clone, `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`);
      const r = await read(clone);
      assert.equal(r.proxy.kind, 'eip1167');
      assert.ok(ids(r).includes('proxy-minimal'));
      assert.ok(!ids(r).includes('proxy-upgradeable'));
    });

    test('address with no code', async () => {
      const r = await read('0x' + '99'.repeat(20));
      assert.deepEqual(ids(r), ['no-code']);
    });

    test('same contract gives the same report hash (re-checkable by another node)', async () => {
      const a = await chain.deploy('ScamToken');
      const r1 = await read(a);
      const r2 = await read(a);
      assert.match(r1.reportHash, /^[0-9a-f]{64}$/);
      assert.equal(r1.reportHash, r2.reportHash);
    });

    test('only read-only RPC methods are used', () => {
      const allowed = new Set(['eth_getCode', 'eth_getStorageAt', 'eth_call']);
      assert.ok(chain.rpc.calls.every((m) => allowed.has(m)));
    });
  });
}

test('rejects bad input before touching the network', async () => {
  const rpc = { call: async () => { throw new Error('should not be called'); } };
  await assert.rejects(readContract('bsc', '0x123', { rpc }), /invalid address/);
  await assert.rejects(readContract('polygon', '0x' + '00'.repeat(20), { rpc }), /unknown chain/);
});

test('chainConfig reads a chain the website does not list', async () => {
  const chain = await createLocalChain();
  const addr = await chain.deploy('CleanToken');
  const r = await readContract('zetaphy', addr, { rpc: chain.rpc, chainConfig: { kind: 'evm', id: 77390, name: 'ZETAPHY testnet', rpcs: [] } });
  assert.equal(r.chain, 'zetaphy');
  assert.equal(r.chainId, 77390);
  assert.ok(r.analysis.findings.some((f) => f.id === 'erc20'));
  await assert.rejects(readContract('zetaphy', 'not-an-address', { rpc: chain.rpc, chainConfig: { kind: 'evm', id: 77390, rpcs: [] } }), /invalid address/);
  await assert.rejects(readContract('not-listed-chain', addr, { rpc: chain.rpc }), /unknown chain/);
});

test('a fingerprint flagged by the network is a high finding; an unreachable registry is ignored', async () => {
  const chain = await createLocalChain();
  const addr = await chain.deploy('CleanToken');
  const seen = [];
  const flagged = await readContract('bsc', addr, { rpc: chain.rpc, threatLookup: async (fp) => { seen.push(fp); return { flagged: true, reason: 'sweeps-approved-tokens' }; } });
  assert.match(seen[0], /^fp1:[0-9a-f]{64}$/);
  assert.equal(flagged.analysis.level, 'high');
  assert.ok(flagged.analysis.findings.some((f) => f.id === 'network-flagged' && f.params.reason === 'sweeps-approved-tokens'));
  const down = await readContract('bsc', addr, { rpc: chain.rpc, threatLookup: async () => { throw new Error('rpc down'); } });
  assert.equal(down.analysis.level, 'info');
});
