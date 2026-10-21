// dlmm-cli.js (DLMM deploy / governance, UNAUDITED contracts): the same key
// rules as cli.js (a file only, never argv), deploy only on chain 77390 unless
// --any-chain, and valid default presets. The real deploy runs in
// test/devnet.dlmm.integration.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { main, DEFAULT_PRESETS } from '../dlmm-cli.js';
import { setupDlmm } from './helpers/dlmm.js';

const dir = mkdtempSync(join(tmpdir(), 'zdlmm-cli-'));

test('dlmm-cli: help lists the commands; a key on the command line is refused; unknown commands are errors', async () => {
  const lines = [];
  await main(['help'], (l) => lines.push(l));
  assert.match(lines.join('\n'), /node dlmm-cli\.js deploy/);
  assert.match(lines.join('\n'), /UNAUDITED/);
  await assert.rejects(main(['deploy', '--rpc', 'http://127.0.0.1:1', '--key', '0x' + '11'.repeat(32)], () => {}), /--key is not accepted/);
  await assert.rejects(main(['bogus'], () => {}), /unknown command/);
});

test('dlmm-cli: deploy refuses a chain other than ZETAPHY (77390) before sending anything', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reqs = [].concat(JSON.parse(body));
      const out = reqs.map((r) => { seen.push(r.method); return r.method === 'eth_chainId' ? { jsonrpc: '2.0', id: r.id, result: '0x1' } : { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'not here' } }; });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const f = join(dir, 'deploy.key');
  writeFileSync(f, Wallet.createRandom().privateKey, { mode: 0o600 });
  try {
    await assert.rejects(main(['deploy', '--rpc', `http://127.0.0.1:${server.address().port}`, '--key-file', f], () => {}), /not ZETAPHY \(77390\); pass --any-chain/);
    assert.ok(!seen.includes('eth_sendRawTransaction'), seen.join(','));
  } finally { server.close(); }
});

test('dlmm-cli: the default presets pass the factory\'s validation', async () => {
  const { factory } = await setupDlmm();
  for (const [step, p] of Object.entries(DEFAULT_PRESETS)) await factory.send('gov', 'setPreset', [Number(step), p]);
  for (const step of Object.keys(DEFAULT_PRESETS)) assert.equal((await factory.call('presets', [Number(step)]))[7], true);
});
