// ZETAPHY Early (contracts/ZetaphyEarly.sol): fixed supply to the airdrop wallet, a plain ERC-20, and
// batchTransfer for the airdrop.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChain, ZETA } from './helpers/evm.js';

let c, t;
const a = (n) => c.acct[n].toString();
beforeEach(async () => {
  c = await createChain(['drop', 'alice', 'bob', 'carol']);
  t = await c.deploy('ZetaphyEarly', [a('drop')], 'drop');
});

test('1,000,000,000 ZEARLY, all with the airdrop wallet; nobody can make more', async () => {
  assert.equal(await t.call('name'), 'ZETAPHY Early');
  assert.equal(await t.call('symbol'), 'ZEARLY');
  assert.equal(await t.call('decimals'), 18n);
  assert.equal(await t.call('totalSupply'), 1_000_000_000n * ZETA);
  assert.equal(await t.call('balanceOf', [a('drop')]), 1_000_000_000n * ZETA);
  const fns = JSON.parse(readFileSync(new URL('../artifacts/ZetaphyEarly.json', import.meta.url), 'utf8')).abi.filter((x) => x.type === 'function').map((x) => x.name);
  assert.ok(fns.includes('batchTransfer'));
  for (const f of ['mint', 'owner', 'pause', 'burn', 'transferOwnership']) assert.ok(!fns.includes(f), `no ${f}`);
});

test('a plain ERC-20: transfer, approve, transferFrom, and the errors', async () => {
  await t.send('drop', 'transfer', [a('alice'), 50n * ZETA]);
  assert.equal(await t.call('balanceOf', [a('alice')]), 50n * ZETA);
  await assert.rejects(t.send('alice', 'transfer', [a('bob'), 51n * ZETA]), /InsufficientBalance/);
  await t.send('alice', 'approve', [a('bob'), 20n * ZETA]);
  await t.send('bob', 'transferFrom', [a('alice'), a('carol'), 20n * ZETA]);
  assert.equal(await t.call('balanceOf', [a('carol')]), 20n * ZETA);
  assert.equal(await t.call('allowance', [a('alice'), a('bob')]), 0n);
  await assert.rejects(t.send('bob', 'transferFrom', [a('alice'), a('carol'), 1n]), /InsufficientAllowance/);
  await assert.rejects(t.send('alice', 'transfer', ['0x0000000000000000000000000000000000000000', 1n]), /ZeroAddress/);
});

test('batchTransfer: the same amount to many wallets in one transaction, all or nothing', async () => {
  const logs = await t.send('drop', 'batchTransfer', [[a('alice'), a('bob'), a('carol')], 10_000n * ZETA]);
  for (const n of ['alice', 'bob', 'carol']) assert.equal(await t.call('balanceOf', [a(n)]), 10_000n * ZETA);
  assert.equal(await t.call('balanceOf', [a('drop')]), (1_000_000_000n - 30_000n) * ZETA);
  assert.equal(logs.filter((l) => l?.name === 'Transfer').length, 3);
  await assert.rejects(t.send('drop', 'batchTransfer', [[], 1n]), /BadBatch/);
  const many = Array.from({ length: 501 }, () => a('alice'));
  await assert.rejects(t.send('drop', 'batchTransfer', [many, 1n]), /BadBatch/);
  await assert.rejects(t.send('alice', 'batchTransfer', [[a('bob'), a('carol')], 6_000n * ZETA]), /InsufficientBalance/);
  assert.equal(await t.call('balanceOf', [a('bob')]), 10_000n * ZETA, 'nothing moved');
  await assert.rejects(t.send('drop', 'batchTransfer', [[a('bob'), '0x0000000000000000000000000000000000000000'], 1n]), /ZeroAddress/);
});

// ---------------------------------------------------------------- scripts/early.js, end to end
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Contract, getBytes } from 'ethers';
import { createRpcChain, serveRpc } from './helpers/rpcchain.js';
import { readList } from '../scripts/early.js';
import { toBech32 } from '../src/pqtx.js';

const SCRIPT = new URL('../scripts/early.js', import.meta.url).pathname;

test('the list: 0x… and zetaphy1… (same wallet once), comments, bad lines', () => {
  const x = '0x' + 'ab'.repeat(20);
  const { wallets, bad } = readList(`# from the bot\n${x}\n${toBech32(getBytes(x))}\n${x.toUpperCase().replace('0X', '0x')},5\nnope\n0x${'0'.repeat(40)}\n`);
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].toLowerCase(), x);
  assert.deepEqual(bad, ['nope', `0x${'0'.repeat(40)}`]);
});

test('deploy, dry run, airdrop in batches, re-run pays only new wallets (real signed txs)', async () => {
  const c = await createRpcChain({ accounts: 2 });
  const node = await serveRpc(c, 18131);
  try {
    const d = mkdtempSync(join(tmpdir(), 'zearly-'));
    writeFileSync(join(d, 'k'), c.signers[0].privateKey);
    const env = { ...process.env, ZETAPHY_RPC: node.url, KEYFILE: join(d, 'k') };
    // async: the in-memory node answers from this same process
    const run = (args, extra = {}) => new Promise((ok) => execFile(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60000, env: { ...env, ...extra } },
      (e, stdout, stderr) => ok({ code: e ? e.code ?? 1 : 0, out: stdout + stderr })));

    const dep = await run(['deploy']);
    assert.equal(dep.code, 0, dep.out);
    const info = JSON.parse(dep.out.trim().split('\n').at(-1));
    assert.equal(info.holder, c.signers[0].address);
    const E = { EARLY: info.token, FROM_BLOCK: String(info.fromBlock) };

    const people = Array.from({ length: 250 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
    writeFileSync(join(d, 'list.txt'), `# bot export\n${people.join('\n')}\n`);
    const dry = await run(['airdrop', '--list', join(d, 'list.txt'), '--each', '10000'], { ...E, KEYFILE: '' });
    assert.equal(dry.code, 1, 'a dry run without a key needs the holder: from the deployment file only');
    const dry2 = await run(['airdrop', '--list', join(d, 'list.txt'), '--each', '10000'], E);
    assert.match(dry2.out, /to pay now: 250 × 10000\.0 = 2500000\.0 ZEARLY/);
    assert.match(dry2.out, /dry run: nothing sent/);

    const send = await run(['airdrop', '--list', join(d, 'list.txt'), '--each', '10000', '--send'], E);
    assert.equal(send.code, 0, send.out);
    assert.equal((send.out.match(/sent 10000\.0 ZEARLY to/g) ?? []).length, 2, '200 + 50');
    const t = new Contract(info.token, JSON.parse(readFileSync(new URL('../artifacts/ZetaphyEarly.json', import.meta.url), 'utf8')).abi, c.provider);
    assert.equal(await t.balanceOf(people[249]), 10_000n * ZETA);

    writeFileSync(join(d, 'list.txt'), `${people.join('\n')}\n0x${'f'.repeat(40)}\n`);
    const again = await run(['airdrop', '--list', join(d, 'list.txt'), '--each', '10000', '--send'], E);
    assert.match(again.out, /paid before: 250, to pay now: 1 ×/);
    assert.equal(await t.balanceOf('0x' + 'f'.repeat(40)), 10_000n * ZETA);
    assert.equal(await t.balanceOf(people[0]), 10_000n * ZETA, 'nobody paid twice');
  } finally { node.close(); }
});
