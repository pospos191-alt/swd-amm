// Browser test: "Do useful work" on the Mine page, on a built dist/ served with the site's own CSP.
//  1. practice mode (no contracts in hub-config): Neuro's code-only scan in a Web Worker gives the same
//     verdict as Node, and the bug hunt (vendor/evm.js in a worker) finds the vulnerable vault's bug;
//  2. on-chain: the real UsefulWork / BugBounty / WorkerReputation contracts run in an in-memory EVM
//     behind a fake node (chain id 77390) and a stand-in wallet. The browser stamps (PoW), scans,
//     commits, reveals and settles a scan job with two other workers, and submits a finding (commit,
//     then reveal one block later).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Interface, keccak256 as ethKeccak, toUtf8Bytes, encodeBytes32String, getAddress, ZeroAddress, toBeHex } from 'ethers';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';
import { keccak256 } from '../../zetaphy-neuro/src/keccak.js';
import { readContract } from '../../zetaphy-neuro/src/reader.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';
import { CHAINS } from '../../zetaphy-neuro/src/chains.js';
import { codeVerdict, jobCommitment } from '../work-core.js';
import { powPrefix, search } from '../mine-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const exe = process.env.CHROMIUM_PATH || undefined;
const vercel = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8'));
const CSP = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const ACC = '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245';
const RPC = 'https://rpc.sawasdeecoin.com';
const ZETA = 10n ** 18n;
const neuro = { readContract, verdictOf, keccak256, CHAINS };
const art = (n) => JSON.parse(readFileSync(join(HERE, '..', '..', 'zetaphy-network', 'artifacts', `${n}.json`), 'utf8'));

/** A small chain: the EVM at chain id 77390, blocks that move with each transaction, receipts with logs. */
async function chain() {
  const common = Common.custom({ chainId: 77390n }, { baseChain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const blockchain = { async getBlock(n) { const h = hexToBytes(ethKeccak(toBeHex(BigInt(n), 32))); return { hash: () => h }; }, shallowCopy() { return this; } };
  const evm = await EVM.create({ common, blockchain });
  const sm = evm.stateManager;
  let number = 100n, time = BigInt(Math.floor(Date.now() / 1000));
  const receipts = new Map();
  const block = () => ({ header: { number, timestamp: time, coinbase: Address.zero(), difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n } });
  const names = {};
  const fund = async (hex) => { await sm.putAccount(Address.fromString(hex), new Account(0n, 1000n * ZETA)); };
  async function tx(from, to, data, value = 0n) {
    const r = await evm.runCall({ caller: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data), value, gasLimit: 15_000_000n, block: block() });
    const hash = ethKeccak(toUtf8Bytes(`${number}:${from}:${data}:${Math.random()}`));
    receipts.set(hash, {
      transactionHash: hash, blockNumber: `0x${number.toString(16)}`, status: r.execResult.exceptionError ? '0x0' : '0x1',
      contractAddress: r.createdAddress?.toString() ?? null,
      logs: (r.execResult.logs ?? []).map(([a, topics, d]) => ({ address: bytesToHex(a), topics: topics.map(bytesToHex), data: bytesToHex(d) })),
    });
    number += 2n; time += 6n;
    if (r.execResult.exceptionError) throw Object.assign(new Error(`reverted: ${r.execResult.exceptionError.error}`), { hash, ret: bytesToHex(r.execResult.returnValue) });
    return { hash, created: r.createdAddress?.toString() };
  }
  async function ethCall({ to, data }) {
    await sm.checkpoint();
    try {
      const r = await evm.runCall({ caller: Address.zero(), to: Address.fromString(to), data: hexToBytes(data), gasLimit: 15_000_000n, block: block() });
      if (r.execResult.exceptionError) throw new Error('execution reverted');
      return bytesToHex(r.execResult.returnValue);
    } finally { await sm.revert(); }
  }
  const code = async (a) => bytesToHex(await sm.getContractCode(Address.fromString(a)));
  async function deploy(name, args, from) {
    const a = art(name);
    const iface = new Interface(a.abi);
    const { created } = await tx(from, null, a.bytecode + iface.encodeDeploy(args).slice(2));
    const c = getAddress(created);
    return {
      address: c, iface,
      send: (who, fn, xs = [], value = 0n) => tx(who, c, iface.encodeFunctionData(fn, xs), value),
      call: async (fn, xs = []) => { const out = iface.decodeFunctionResult(fn, await ethCall({ to: c, data: iface.encodeFunctionData(fn, xs) })); return out.length === 1 ? out[0] : out; },
    };
  }
  return { evm, fund, tx, ethCall, code, deploy, receipts, names, number: () => number, advance: (s) => { time += BigInt(s); } };
}

function launch() { return chromium.launch(exe ? { executablePath: exe } : {}); }

async function openPage(browser, site, onRpc) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (new URL(u).origin === new URL(site.url).origin) {
      if (onRpc.config && new URL(u).pathname === '/hub-config.json') {
        const c = JSON.parse(readFileSync(join(DIST, 'hub-config.json'), 'utf8'));
        c.contracts = { ...c.contracts, ...onRpc.config };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(c) });
      }
      return route.continue();
    }
    if (new URL(u).origin === RPC) {
      const a = await onRpc.handle(u, route.request().postData());
      if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
    }
    return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
  });
  return { page, errors };
}

test('useful work, practice mode: the browser scan matches Node; the hunt finds the bug', { timeout: 180_000 }, async () => {
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP } });
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, site, { handle: async (u, b) => answer(u, b) });
    await page.goto(`${site.url}?tab=mine`);
    await page.waitForSelector('#mn-start');
    assert.equal(await page.textContent('#mode-mine'), '⛏ Faucet proof of work');
    await page.click('#mode-work');
    await page.waitForSelector('#wk-practice');
    assert.match(await page.textContent('#wk-practice'), /practice/);
    assert.equal(await page.textContent('#wk-scan-go'), 'Practice scan');
    await page.click('#wk-scan-go');
    await page.waitForSelector('.wk-verdict', { timeout: 60_000 });
    const job = JSON.parse(readFileSync(join(DIST, 'bounties/sample-scan.json'), 'utf8'));
    const { verdict } = await codeVerdict(neuro, job);
    assert.equal(await page.getAttribute('.wk-verdict', 'data-tip'), verdict, 'the browser verdict is the runners\' verdict');
    assert.match(await page.textContent('#wk-scan-msg'), /Done: 1 job/);
    // bug hunt in the in-page EVM
    await page.click('#wk-hunt-go');
    await page.waitForSelector('#wk-finding:not([hidden])', { timeout: 90_000 });
    const f = await page.textContent('#wk-finding');
    assert.match(f, /^initialize\(\)\nsweep\(address\) 0x00000000000000000000000000000000000a77a1$/);
    assert.match(await page.textContent('#wk-hunt-msg'), /attacker gains 5 ZTPHY/);
    assert.equal(await page.isHidden('#wk-submit'), true, 'practice: nothing to submit');
    // a phone: one column, no sideways scroll
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll at 375 px');
    await page.click('#mode-mine');
    await page.waitForSelector('#mn-start');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    site.close();
  }
});

test('useful work on-chain: stamp, scan, commit, reveal, settle with two other workers; submit a finding', { timeout: 300_000 }, async () => {
  const c = await chain();
  const GOV = '0x' + '90'.repeat(20), W2 = '0x' + '92'.repeat(20), W3 = '0x' + '93'.repeat(20);
  for (const a of [GOV, W2, W3, ACC]) await c.fund(a);
  const rep = await c.deploy('WorkerReputation', [GOV, ZeroAddress, ZeroAddress], GOV);
  const PARAMS = { stampBits: 10, stampSeats: 5, stampLife: 86400, seatsPerDay: 20, seats: 3, quorum: 2, commitWindow: 600, revealWindow: 600, seatDeposit: ZETA / 10n, subsidy: 0n, priorityScore: 0, priorityWindow: 0 };
  const uw = await c.deploy('UsefulWork', [GOV, rep.address, ZeroAddress, PARAMS], GOV);
  await rep.send(GOV, 'setReporter', [uw.address, true]);
  const vault = await c.deploy('VulnerableVault', [], GOV);
  const runtime = await c.code(vault.address);
  await uw.send(GOV, 'post', [encodeBytes32String('zetaphy'), vault.address.toLowerCase(), ethKeccak(runtime), 0], 3n * ZETA);
  const bb = await c.deploy('BugBounty', [GOV, 2, 1, GOV, rep.address, ZeroAddress, ZETA / 10n, 3600, 86400], GOV);
  const specText = readFileSync(join(DIST, 'bounties/vulnerable-vault.json'), 'utf8');
  await bb.send(GOV, 'post', [ethKeccak(toUtf8Bytes(specText)), 'bounties/vulnerable-vault.json', 86400 * 7], 10n * ZETA);

  const sent = [];
  const handle = async (u, body) => {
    if (new URL(u).pathname !== '/' && new URL(u).pathname !== '') return answer(u, body);
    const { method, id, params } = JSON.parse(body || '{}');
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    try {
      if (method === 'eth_chainId') return ok('0x12e4e');
      if (method === 'eth_blockNumber') return ok(`0x${c.number().toString(16)}`);
      if (method === 'eth_getCode') return ok(await c.code(params[0]));
      if (method === 'eth_getTransactionReceipt') return ok(c.receipts.get(params[0]) ?? null);
      if (method === 'eth_call') {
        if ((await c.code(params[0].to)) === '0x') return answer(u, body);
        return ok(await c.ethCall(params[0]));
      }
      if (method === 'test_send') { // the stand-in wallet's eth_sendTransaction
        const t = params[0];
        sent.push(t);
        try { return ok((await c.tx(t.from, t.to, t.data, BigInt(t.value ?? 0))).hash); } catch (e) { return ok(e.hash); }
      }
    } catch (e) { return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } }; }
    return answer(u, body);
  };

  const site = await serve(DIST, { headers: { 'content-security-policy': CSP } });
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, site, { handle, config: { usefulWork: uw.address, bugBounty: bb.address, workerReputation: rep.address } });
    await page.addInitScript(([acc, rpc]) => {
      window.ethereum = { isMetaMask: true, on: () => {}, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acc];
        if (method === 'eth_chainId') return '0x12e4e';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction') {
          const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test_send', params }) });
          return (await r.json()).result;
        }
        throw new Error(`not mocked: ${method}`);
      } };
    }, [ACC, RPC]);
    /** Clicks "confirm" in the hub's own transaction summary each time one opens. */
    const confirmAll = setInterval(() => { page.click('#ws-confirm[open] [data-ws="go"]', { timeout: 500 }).catch(() => {}); }, 400);
    try {
      await page.goto(`${site.url}?tab=mine`);
      await page.waitForSelector('#mode-work');
      await page.click('#mode-work');
      await page.waitForSelector('#wk-scan-go');
      assert.equal(await page.textContent('#wk-scan-go'), 'Take scan jobs');
      await page.waitForFunction(() => document.getElementById('wk-open').textContent === '1');
      await page.click('#wk-scan-go');
      await page.waitForSelector('#wb-dialog[open] .wb-wallet');
      await page.click('#wb-dialog .wb-wallet');
      await page.waitForFunction(() => /0x6af5/i.test(document.getElementById('wb-dialog').textContent));
      if (await page.isVisible('#wb-dialog[open]')) await page.keyboard.press('Escape'); // connected: close the wallet dialog
      // the browser stamps, scans and commits
      for (let i = 0; i < 120 && /^0x0+$/.test(await uw.call('commitments', [0n, ACC])); i++) await new Promise((r) => setTimeout(r, 500));
      assert.doesNotMatch(await uw.call('commitments', [0n, ACC]), /^0x0+$/, 'the browser committed');
      assert.equal(sent[0].data.slice(0, 10), uw.iface.getFunction('stamp').selector, 'first the PoW stamp');
      assert.equal(BigInt(sent[1].value), ZETA / 10n, 'the seat deposit');
      // two other workers (Node) compute the same code-only verdict and take the other seats
      const { verdict } = await codeVerdict(neuro, { chain: 'zetaphy', target: vault.address, code: runtime, codeHash: ethKeccak(runtime) });
      for (const [i, w] of [W2, W3].entries()) {
        const h = c.number() - 1n;
        const seed = await uw.call('stampSeed', [h]);
        const prefix = powPrefix(77390, seed, w);
        const lo = search(prefix, 0, 10, 0, 2 ** 32);
        await uw.send(w, 'stamp', [h, BigInt(lo)]);
        await uw.send(w, 'commit', [0n, jobCommitment(keccak256, verdict, w, `0x${String(i + 1).padStart(64, '0')}`, 0n)], ZETA / 10n);
      }
      for (const [i, w] of [W2, W3].entries()) await uw.send(w, 'reveal', [0n, verdict, `0x${String(i + 1).padStart(64, '0')}`]);
      // the browser reveals, then settles
      await page.waitForFunction(() => /Done: 1 job/.test(document.getElementById('wk-scan-msg').textContent), null, { timeout: 120_000 });
      const job = await uw.call('getJob', [0n]);
      assert.equal(job.result, verdict, 'the browser agreed with the others');
      assert.equal(await uw.call('owed', [ACC]), ZETA + ZETA / 10n, 'a third of the fee and the deposit back');
      assert.equal((await rep.call('recordOf', [ACC])).agreed, 1n);
      await page.waitForFunction(() => /1\.1/.test(document.getElementById('wk-owed').textContent));

      // bug hunting against the on-chain bounty
      await page.click('#wk-hunt-go');
      await page.waitForSelector('#wk-submit:not([hidden])', { timeout: 90_000 }).catch(async (e) => { throw new Error(`${e.message}: ${await page.textContent('#wk-hunt-msg')}`); });
      assert.match(await page.textContent('#wk-bounty'), /^#0 · VulnerableVault/);
      await page.click('#wk-submit');
      await page.waitForFunction(() => /revealed/.test(document.getElementById('wk-hunt-msg').textContent), null, { timeout: 60_000 });
      const f = await bb.call('getFinding', [0n]);
      assert.equal(f.state, 2n, 'revealed');
      assert.equal(getAddress(f.finder), ACC);
    } finally {
      clearInterval(confirmAll);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    site.close();
  }
});
