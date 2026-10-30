// Browser test: the "Private identity" card of the Agents page on a built dist/, served with the site's CSPs from
// vercel.json (the pages without WebAssembly, the prover worker with it), against the REAL contracts in an in-memory
// EVM (LabelRegistry, VouchRegistry, PoseidonT3, ZkIdentityVerifier, ZkIdentityRegistry, PrivateAirdrop) behind a fake
// node and a stand-in wallet: create an identity, export and re-import its encrypted backup, register from the
// person-labelled account, prove in the browser (Groth16, snarkjs in a Web Worker) and claim the airdrop to a fresh
// address; a second claim is refused before proving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';
import { Interface, Wallet, getAddress, keccak256 as ethKeccak, toUtf8Bytes, toBeHex, ZeroAddress } from 'ethers';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const exe = process.env.CHROMIUM_PATH || undefined;
const vercel = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8'));
const cspOf = (src) => vercel.headers.find((h) => h.source === src).headers.find((h) => h.key === 'Content-Security-Policy').value;
const CSP = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const WORKER_CSP = cspOf('/zkid-worker.js');
const ZETA = 10n ** 18n;
const art = (n) => JSON.parse(readFileSync(join(HERE, '..', '..', 'zetaphy-network', 'artifacts', `${n}.json`), 'utf8'));

async function chain() {
  const common = Common.custom({ chainId: 77390n }, { baseChain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const blockchain = { async getBlock(n) { const h = hexToBytes(ethKeccak(toBeHex(BigInt(n), 32))); return { hash: () => h }; }, shallowCopy() { return this; } };
  const evm = await EVM.create({ common, blockchain });
  const sm = evm.stateManager;
  let number = 100n, time = BigInt(Math.floor(Date.now() / 1000));
  const receipts = new Map();
  const block = () => ({ header: { number, timestamp: time, coinbase: Address.zero(), difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n } });
  const fund = async (hex) => { await sm.putAccount(Address.fromString(hex), new Account(0n, 1000n * ZETA)); };
  async function tx(from, to, data, value = 0n) {
    const r = await evm.runCall({ caller: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data), value, gasLimit: 15_000_000n, block: block() });
    const hash = ethKeccak(toUtf8Bytes(`${number}:${from}:${data}:${Math.random()}`));
    receipts.set(hash, { transactionHash: hash, blockNumber: `0x${number.toString(16)}`, status: r.execResult.exceptionError ? '0x0' : '0x1', contractAddress: r.createdAddress?.toString() ?? null, logs: [] });
    number += 2n; time += 6n;
    if (r.execResult.exceptionError) throw Object.assign(new Error(`reverted: ${r.execResult.exceptionError.error}`), { hash });
    return { hash, created: r.createdAddress?.toString() };
  }
  async function ethCall({ from, to, data }) {
    await sm.checkpoint();
    try {
      const r = await evm.runCall({ caller: from ? Address.fromString(from) : Address.zero(), to: Address.fromString(to), data: hexToBytes(data ?? '0x'), gasLimit: 15_000_000n, block: block() });
      return r.execResult.exceptionError ? { error: { code: 3, message: 'execution reverted', data: bytesToHex(r.execResult.returnValue) } } : { result: bytesToHex(r.execResult.returnValue) };
    } finally { await sm.revert(); }
  }
  const code = async (a) => bytesToHex(await sm.getContractCode(Address.fromString(a)));
  const balance = async (a) => (await sm.getAccount(Address.fromString(a)))?.balance ?? 0n;
  async function deploy(a, args, from, value = 0n) {
    const iface = new Interface(a.abi);
    const { created } = await tx(from, null, a.bytecode + iface.encodeDeploy(args).slice(2), value);
    const c = getAddress(created);
    return {
      address: c, iface,
      send: (who, fn, xs = [], v = 0n) => tx(who, c, iface.encodeFunctionData(fn, xs), v),
      call: async (fn, xs = []) => { const out = iface.decodeFunctionResult(fn, (await ethCall({ to: c, data: iface.encodeFunctionData(fn, xs) })).result); return out.length === 1 ? out[0] : out; },
    };
  }
  return { fund, tx, ethCall, code, balance, deploy, receipts, number: () => number, now: () => time };
}

test('Private identity: create, backup, register, prove in the browser, claim to a fresh address', { timeout: 300_000 }, async () => {
  const c = await chain();
  const user = Wallet.createRandom();
  const ACC = user.address, GOV = '0x' + '90'.repeat(20);
  const FRESH = getAddress('0x' + 'f1'.repeat(20));
  const attester = Wallet.createRandom();
  for (const a of [GOV, ACC]) await c.fund(a);
  const labels = await c.deploy(art('LabelRegistry'), [GOV, ZeroAddress, ZeroAddress, '0x' + '00'.repeat(32), 180 * 86400], GOV);
  await labels.send(GOV, 'setAttester', [attester.address, true]);
  const vouch = await c.deploy(art('VouchRegistry'), [labels.address, GOV], GOV);
  const poseidon = await c.deploy(art('PoseidonT3'), [], GOV);
  const verifier = await c.deploy(art('ZkIdentityVerifier'), [], GOV);
  const reg = await c.deploy(art('ZkIdentityRegistry'), [poseidon.address, verifier.address, labels.address, vouch.address, GOV, 3600], GOV);
  const drop = await c.deploy(art('PrivateAirdrop'), [reg.address, 123456789n, 1, ZETA], GOV, 0n);
  await c.tx(GOV, drop.address, '0x', 5n * ZETA);
  // the user's account is a labelled person (an attester's EIP-712 attestation)
  const until = c.now() + 30n * 86400n, deadline = c.now() + 600n, cred = ethKeccak(toUtf8Bytes('passkey'));
  const sig = await attester.signTypedData({ name: 'ZETAPHY Labels', version: '1', chainId: 77390, verifyingContract: labels.address },
    { HumanAttestation: [{ name: 'account', type: 'address' }, { name: 'credentialHash', type: 'bytes32' }, { name: 'validUntil', type: 'uint64' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    { account: ACC, credentialHash: cred, validUntil: until, nonce: 0n, deadline });
  await labels.send(GOV, 'attestHuman', [ACC, cred, until, deadline, sig]);
  // another member, so the tree has more than one leaf
  const OTHER = '0x' + '77'.repeat(20);
  await c.fund(OTHER);
  const sig2 = await attester.signTypedData({ name: 'ZETAPHY Labels', version: '1', chainId: 77390, verifyingContract: labels.address },
    { HumanAttestation: [{ name: 'account', type: 'address' }, { name: 'credentialHash', type: 'bytes32' }, { name: 'validUntil', type: 'uint64' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    { account: getAddress(OTHER), credentialHash: ethKeccak(toUtf8Bytes('passkey 2')), validUntil: until, nonce: 0n, deadline });
  await labels.send(GOV, 'attestHuman', [OTHER, ethKeccak(toUtf8Bytes('passkey 2')), until, deadline, sig2]);
  await reg.send(OTHER, 'register', [424242n]);

  const handle = async (u, body) => {
    const { method, id, params } = JSON.parse(body || '{}');
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'eth_chainId') return ok('0x12e4e');
    if (method === 'eth_blockNumber') return ok(`0x${c.number().toString(16)}`);
    if (method === 'eth_getTransactionReceipt') return ok(c.receipts.get(params[0]) ?? null);
    if (method === 'eth_call' && (await c.code(params[0].to)) !== '0x') return { jsonrpc: '2.0', id, ...(await c.ethCall(params[0])) };
    if (method === 'test_send') { const t = params[0]; try { return ok((await c.tx(t.from, t.to, t.data)).hash); } catch (e) { return ok(e.hash); } }
    return answer(u, body);
  };
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP }, pathHeaders: { '/zkid-worker.js': { 'content-security-policy': WORKER_CSP } } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (u.origin === new URL(site.url).origin) {
        if (u.pathname === '/hub-config.json') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ node: '', contracts: { zkIdentityRegistry: reg.address, privateAirdrop: drop.address, labelRegistry: labels.address }, dex: {}, nft: {}, tokens: [], saphan: [], saphanTokens: [] }) });
        }
        return route.continue();
      }
      if (u.origin === 'https://rpc.sawasdeecoin.com') {
        const a = await handle(req.url(), req.postData());
        if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      }
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });
    await page.addInitScript(([acc, rpc]) => {
      const relay = async (method, params) => (await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
      window.ethereum = { isMetaMask: true, on: () => {}, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acc];
        if (method === 'eth_chainId') return '0x12e4e';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction') return relay('test_send', params);
        throw new Error(`not mocked: ${method}`);
      } };
    }, [ACC, 'https://rpc.sawasdeecoin.com']);
    const confirmAll = setInterval(() => { page.click('#ws-confirm[open] [data-ws="go"]', { timeout: 500 }).catch(() => {}); }, 400);
    try {
      await page.goto(`${site.url}?tab=agents`);
      await page.waitForSelector('#zk-create');
      assert.equal(await page.inputValue('#zk-reg'), reg.address);
      assert.match(await page.textContent('#zk-id'), /No identity/);
      assert.equal(await page.isDisabled('#zk-register'), true);
      await page.click('#wb-btn');
      await page.waitForSelector('#wb-dialog[open] .wb-wallet:not(#wb-ledger)');
      await page.click('#wb-dialog .wb-wallet:not(#wb-ledger)');
      await page.waitForFunction((a) => document.getElementById('wb-btn').textContent.toLowerCase().includes(a.slice(0, 6).toLowerCase()), ACC);
      if (await page.isVisible('#wb-close')) await page.click('#wb-close');

      // create; the secret lives in this browser's storage only
      await page.click('#zk-create');
      await page.waitForFunction(() => /commitment 0x/.test(document.getElementById('zk-id').textContent));
      const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('zetaphy-hub:zkid')));
      assert.match(stored.secret, /^0x[0-9a-f]{64}$/);

      // encrypted backup: export, forget, import
      await page.click('#zk-card details summary');
      await page.fill('#zk-pw', 'short');
      await page.click('#zk-export');
      await page.waitForFunction(() => /at least 8/.test(document.getElementById('zk-msg').textContent));
      await page.fill('#zk-pw', 'a long test password');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#zk-export')]);
      const backup = readFileSync(await dl.path(), 'utf8');
      assert.match(backup, /zetaphy-zkid-backup/);
      assert.ok(!backup.includes(stored.secret.slice(2)), 'the backup does not contain the secret in clear');
      await page.click('#zk-forget');
      await page.click('#zk-forget');
      await page.waitForFunction(() => /No identity/.test(document.getElementById('zk-id').textContent));
      await page.setInputFiles('#zk-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
      await page.waitForFunction(() => /restored/.test(document.getElementById('zk-msg').textContent), null, { timeout: 30_000 });
      assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('zetaphy-hub:zkid'))), stored);

      // register from the labelled account
      await page.click('#zk-register');
      await page.waitForFunction(() => /Registered at level 1/.test(document.getElementById('zk-msg').textContent), null, { timeout: 120_000 });
      assert.equal(await reg.call('leafCount'), 2n);
      const m = await reg.call('memberOf', [ACC]);
      assert.equal(m.active, true);

      // prove in the browser and claim to a fresh address
      await page.fill('#zk-to', FRESH);
      const t0 = Date.now();
      await page.click('#zk-prove');
      await page.waitForFunction(() => /Proof made in/.test(document.getElementById('zk-out').textContent) || document.getElementById('zk-cmsg').classList.contains('bad'), null, { timeout: 180_000 });
      assert.match(await page.textContent('#zk-out'), /Proof made in/, await page.textContent('#zk-cmsg'));
      console.log(`browser proof (load + prove, single thread): ${((Date.now() - t0) / 1000).toFixed(1)} s; ${(await page.textContent('#zk-out')).match(/Proof made in [\d.]+ s/)?.[0]}`);
      assert.match(await page.textContent('#zk-out'), /Tree: 2 members/);
      await page.click('#zk-send');
      await page.waitForFunction(() => /Claimed/.test(document.getElementById('zk-cmsg').textContent), null, { timeout: 120_000 });
      assert.equal(await c.balance(FRESH), ZETA);
      // the same identity again: refused before any proof
      await page.click('#zk-prove');
      await page.waitForFunction(() => /already claimed/.test(document.getElementById('zk-cmsg').textContent), null, { timeout: 60_000 });

      // Thai
      await page.selectOption('#lang', 'th');
      await page.waitForFunction(() => /ตัวตนแบบส่วนตัว/.test(document.querySelector('#zk-card')?.textContent ?? ''));
      // a phone: no sideways scroll
      await page.setViewportSize({ width: 375, height: 800 });
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll at 375 px');
      assert.deepEqual(errors, []);
    } finally { clearInterval(confirmAll); }
  } finally {
    await browser.close();
    site.close();
  }
});
