import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from '../src/rpc.js';

function fakeFetch(handlers) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const { method } = JSON.parse(init.body);
    seen.push(`${url} ${method}`);
    const h = handlers[url];
    if (!h) throw new Error('down');
    return { ok: true, json: async () => ({ result: h(method) }) };
  };
  return { fetchImpl, seen };
}

test('skips an endpoint that reports the wrong chain', async () => {
  const { fetchImpl } = fakeFetch({
    'https://a': (m) => (m === 'eth_chainId' ? '0x1' : '0xbad'),
    'https://b': (m) => (m === 'eth_chainId' ? '0x38' : '0x6000'),
  });
  const rpc = createRpc(['https://a', 'https://b'], 56, { fetchImpl });
  assert.equal(await rpc.call('eth_getCode', ['0x0', 'latest']), '0x6000');
});

test('falls back when the first endpoint is down, and checks chainId once', async () => {
  const { fetchImpl, seen } = fakeFetch({ 'https://b': (m) => (m === 'eth_chainId' ? '0x2105' : '0x') });
  const rpc = createRpc(['https://a', 'https://b'], 8453, { fetchImpl });
  await rpc.call('eth_getCode', ['0x0', 'latest']);
  await rpc.call('eth_getCode', ['0x0', 'latest']);
  assert.equal(seen.filter((s) => s === 'https://b eth_chainId').length, 1);
});

test('refuses anything that could send a transaction', async () => {
  const rpc = createRpc(['https://a'], 1, { fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(rpc.call('eth_sendRawTransaction', ['0x']), /not allowed/);
  await assert.rejects(rpc.call('eth_sendTransaction', [{}]), /not allowed/);
});
