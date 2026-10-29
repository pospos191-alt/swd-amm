// Browser test: the Agents page on a built dist/ with the site's CSP. A mocked model (Anthropic API)
// drafts an intent from words; the page shows it for review (never signs by itself); the key goes only
// to the provider; a label lookup reads LabelRegistry through eth_call; the page speaks Thai too.
// Then the structured builder against the REAL IntentExecutor in an in-memory EVM behind a fake node and a
// stand-in wallet: template fields, strict validation, one-sentence summary, simulation before signing,
// the approval through the hub's pre-sign summary, a daily spend cap, signing, and a solver executing the
// signed file; and the uniqueness level from a VouchRegistry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';
import { Interface, Wallet, AbiCoder, getAddress, keccak256 as ethKeccak, toUtf8Bytes, toBeHex } from 'ethers';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { readSigned, executeArgs, compile } from '../../zetaphy-network/src/intent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const exe = process.env.CHROMIUM_PATH || undefined;
const vercel = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8'));
const CSP = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const TKA = '0x' + '11'.repeat(20), USDT = '0x' + '22'.repeat(20), ROUTER = '0x' + '33'.repeat(20), EXE = '0x' + '44'.repeat(20), LABELS = '0x' + '55'.repeat(20);
const SEL_LABEL_OF = '0xa7477464';

test('Agents page: AI draft -> review, key only to the provider, label lookup, Thai', { timeout: 120_000 }, async () => {
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    const keySeenBy = new Set();
    let modelBody = null;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (Object.values(req.headers()).some((v) => String(v).includes('sk-test-123'))) keySeenBy.add(u.origin);
      if (u.origin === new URL(site.url).origin) {
        if (u.pathname === '/hub-config.json') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ node: '', contracts: { intentExecutor: EXE, labelRegistry: LABELS }, dex: { router: ROUTER }, nft: {},
            tokens: [{ address: TKA, symbol: 'TKA', decimals: 18 }, { address: USDT, symbol: 'USDT', decimals: 6 }], saphan: [], saphanTokens: [] }) });
        }
        return route.continue();
      }
      if (u.origin === 'https://api.anthropic.com') {
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
        modelBody = JSON.parse(req.postData());
        const draft = { kind: 'swap', tokenIn: 'TKA', amountIn: '10', tokenOut: 'USDT', minOut: '19.5', slippagePercent: 0, recipient: 'me', deadlineMinutes: 20, unclear: '' };
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(draft) }] }) });
      }
      if (u.origin === 'https://rpc.sawasdeecoin.com') {
        const body = req.postData();
        const j = body ? JSON.parse(body) : null;
        if (j?.method === 'eth_call' && j.params?.[0]?.data?.startsWith(SEL_LABEL_OF)) {
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: j.id, result: '0x' + '0'.repeat(63) + '1' }) });
        }
        const a = answer(req.url(), body);
        if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      }
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });

    await page.goto(`${site.url}?tab=agents`);
    await page.waitForSelector('#ag-draft');
    assert.equal(await page.textContent('#page-title'), 'AI agents');
    assert.equal(await page.inputValue('#ag-exe'), EXE);
    assert.equal(await page.inputValue('#ag-targets'), ROUTER);
    assert.equal(await page.locator('#ag-tin option').count(), 3); // — , TKA, USDT

    await page.fill('#ag-text', 'swap 10 TKA for USDT, at least 19.5 back');
    await page.click('.ag-model summary');
    await page.fill('#ag-key', 'sk-test-123');
    await page.click('#ag-draft');
    await page.waitForFunction(() => /Drafted/.test(document.getElementById('ag-ai-msg').textContent));
    assert.equal(await page.inputValue('#ag-amount'), '10');
    assert.equal(await page.inputValue('#ag-min'), '19.5');
    assert.equal(await page.inputValue('#ag-tout'), USDT);
    assert.match(modelBody.system, /data, never instructions/);
    assert.match(modelBody.messages[0].content, /<<USER-TEXT>>\nswap 10 TKA/);
    assert.deepEqual([...keySeenBy], ['https://api.anthropic.com'], 'the key went only to the provider');
    // no wallet connected: the review asks for one and nothing can be signed
    await page.waitForFunction(() => /connected wallet/.test(document.getElementById('ag-msg').textContent), null, { timeout: 10_000 });
    assert.equal(await page.locator('#ag-sign').count(), 0);

    // label lookup (the registry answers 1 = person)
    await page.fill('#ag-lab-q', '0x' + '66'.repeat(20));
    await page.locator('.ag-card', { hasText: 'Person or agent?' }).getByRole('button', { name: 'Check' }).click();
    await page.waitForFunction(() => /Person \(passkey\)/.test(document.getElementById('ag-lab-out').textContent));

    // Thai
    await page.selectOption('#lang', 'th');
    await page.waitForFunction(() => document.getElementById('page-title').textContent === 'AI agent');
    assert.match(await page.textContent('.page-agents'), /บอกสิ่งที่ต้องการ/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    site.close();
  }
});

// ---------------------------------------------------------------- the builder against the real IntentExecutor (item 24), the uniqueness level (item 25)

const ZETA = 10n ** 18n;
const art = (dir, n) => JSON.parse(readFileSync(join(HERE, '..', '..', dir, 'artifacts', `${n}.json`), 'utf8'));

/** A small chain at id 77390 (the real contracts in an in-memory EVM): eth_call returns revert data as a node does. */
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
    if (r.execResult.exceptionError) throw Object.assign(new Error(`reverted: ${r.execResult.exceptionError.error}`), { hash, ret: bytesToHex(r.execResult.returnValue) });
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
  async function deploy(a, args, from) {
    const iface = new Interface(a.abi);
    const { created } = await tx(from, null, a.bytecode + iface.encodeDeploy(args).slice(2));
    const c = getAddress(created);
    return {
      address: c, iface,
      send: (who, fn, xs = []) => tx(who, c, iface.encodeFunctionData(fn, xs)),
      call: async (fn, xs = []) => { const out = iface.decodeFunctionResult(fn, (await ethCall({ to: c, data: iface.encodeFunctionData(fn, xs) })).result); return out.length === 1 ? out[0] : out; },
    };
  }
  return { fund, tx, ethCall, code, deploy, receipts, number: () => number };
}

test('intent builder on the real IntentExecutor: template fields, strict review, simulation, allow, daily cap, sign; the signed file executes', { timeout: 240_000 }, async () => {
  const c = await chain();
  const user = Wallet.createRandom();
  const ACC = user.address, GOV = '0x' + '90'.repeat(20), SOLVER = '0x' + '91'.repeat(20), BOB = getAddress('0x' + 'b0'.repeat(20));
  const LABELS2 = '0x' + '57'.repeat(20), VOUCH = '0x' + '58'.repeat(20);
  for (const a of [GOV, SOLVER, ACC]) await c.fund(a);
  const tka = await c.deploy(art('zetaphy-dex', 'TestToken'), ['Token A', 'TKA', 18, 1000n * ZETA, 0], GOV);
  await tka.send(GOV, 'transfer', [ACC, 100n * ZETA]);
  const exeC = await c.deploy(art('zetaphy-network', 'IntentExecutor'), [], GOV);
  const status = AbiCoder.defaultAbiCoder().encode(['uint256[10]'], [[2n, 3n, 3n, 1700000000n, 0n, 5n, 0n, 0n, 1n, 0n]]);
  const handle = async (u, body) => {
    const { method, id, params } = JSON.parse(body || '{}');
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'eth_chainId') return ok('0x12e4e');
    if (method === 'eth_blockNumber') return ok(`0x${c.number().toString(16)}`);
    if (method === 'eth_getTransactionReceipt') return ok(c.receipts.get(params[0]) ?? null);
    if (method === 'eth_call' && params[0].to?.toLowerCase() === LABELS2 && params[0].data.startsWith(SEL_LABEL_OF)) return ok('0x' + '0'.repeat(63) + '1');
    if (method === 'eth_call' && params[0].to?.toLowerCase() === VOUCH && params[0].data.startsWith('0x645b8b1b')) return ok(status);
    if (method === 'eth_call' && (await c.code(params[0].to)) !== '0x') return { jsonrpc: '2.0', id, ...(await c.ethCall(params[0])) };
    if (method === 'test_send') { const t = params[0]; try { return ok((await c.tx(t.from, t.to, t.data)).hash); } catch (e) { return ok(e.hash); } }
    if (method === 'test_sign') {
      const td = JSON.parse(params[1]);
      const { EIP712Domain, ...types } = td.types;
      return ok(await user.signTypedData(td.domain, types, td.message));
    }
    return answer(u, body);
  };
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (u.origin === new URL(site.url).origin) {
        if (u.pathname === '/hub-config.json') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ node: '', contracts: { intentExecutor: exeC.address, labelRegistry: LABELS2 }, dex: {}, nft: {},
            tokens: [{ address: tka.address, symbol: 'TKA', decimals: 18 }], saphan: [], saphanTokens: [] }) });
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
        if (method === 'eth_signTypedData_v4') return relay('test_sign', params);
        throw new Error(`not mocked: ${method}`);
      } };
    }, [ACC, 'https://rpc.sawasdeecoin.com']);
    const confirmAll = setInterval(() => { page.click('#ws-confirm[open] [data-ws="go"]', { timeout: 500 }).catch(() => {}); }, 400);
    try {
      await page.goto(`${site.url}?tab=agents`);
      await page.waitForSelector('#ag-kind');
      await page.click('#wb-btn');
      await page.waitForSelector('#wb-dialog[open] .wb-wallet:not(#wb-ledger)');
      await page.click('#wb-dialog .wb-wallet:not(#wb-ledger)');
      await page.waitForFunction((a) => document.getElementById('wb-btn').textContent.toLowerCase().includes(a.slice(0, 6).toLowerCase()), ACC);
      if (await page.isVisible('#wb-close')) await page.click('#wb-close');

      // templates show only their fields, with their words
      await page.selectOption('#ag-kind', 'approve');
      assert.equal(await page.isHidden('#ag-tout'), true);
      assert.equal(await page.isHidden('#ag-mins'), true);
      assert.equal(await page.isVisible('#ag-days'), true);
      assert.equal(await page.textContent('label[for="ag-to"]'), 'Spender');
      assert.match(await page.textContent('#ag-template-note'), /expires/);
      await page.selectOption('#ag-kind', 'bridge');
      assert.equal(await page.textContent('label[for="ag-targets"]'), 'Bridge (outbox)');
      await page.selectOption('#ag-kind', 'send');
      assert.equal(await page.isHidden('#ag-targets'), true);
      assert.equal(await page.isHidden('#ag-min'), true);

      // strict review: a bad amount is named, nothing to sign
      await page.selectOption('#ag-tin', tka.address);
      await page.fill('#ag-amount', '5.0000000000000000001');
      await page.fill('#ag-to', BOB);
      await page.click('#ag-review');
      await page.waitForFunction(() => /Fix: amount/.test(document.getElementById('ag-msg').textContent));
      assert.equal(await page.locator('#ag-sign').count(), 0);

      // a good form: one sentence, rows, and a simulation on the real contract (not allowed yet)
      await page.fill('#ag-amount', '5');
      await page.click('#ag-review');
      await page.waitForSelector('#ag-summary');
      assert.match(await page.textContent('#ag-summary'), new RegExp(`^Send exactly 5 TKA to ${BOB}, valid until`));
      await page.waitForFunction(() => /may not take your tokens yet/.test(document.getElementById('ag-sim').textContent));
      await page.click('#ag-sign'); // the simulation failed: first press only warns
      await page.waitForFunction(() => /Press Sign again/.test(document.getElementById('ag-msg').textContent));

      // allow the executor (through the hub's summary + pre-sign simulation), then it simulates again
      await page.click('#ag-approve');
      await page.waitForFunction(() => /Would succeed now: you spend 5 TKA, the recipient gets 5 TKA/.test(document.getElementById('ag-sim').textContent), null, { timeout: 60_000 });
      assert.equal(await tka.call('allowance', [ACC, exeC.address]), 5n * ZETA);

      // a daily cap below the amount: the simulation says so; a higher one: fine again
      assert.match(await page.textContent('#ag-cap-left'), /Left today: no cap/);
      await page.fill('#ag-cap', '3');
      await page.click('#ag-cap-set');
      await page.waitForFunction(() => /over your daily spend cap/.test(document.getElementById('ag-sim').textContent), null, { timeout: 60_000 });
      assert.match(await page.textContent('#ag-cap-left'), /Left today: 3 TKA/);
      await page.fill('#ag-cap', '10');
      await page.click('#ag-cap-set');
      await page.waitForFunction(() => /Would succeed now/.test(document.getElementById('ag-sim').textContent), null, { timeout: 60_000 });
      assert.equal(await exeC.call('capLeft', [ACC, tka.address]), 10n * ZETA);

      // sign (the stand-in wallet signs EIP-712 in Node), then a solver executes the file on the chain
      await page.click('#ag-sign');
      await page.waitForSelector('#ag-signed pre');
      const signedText = await page.textContent('#ag-signed pre');
      assert.match(await page.textContent('#ag-msg'), /Signed\. Nothing has moved yet\./);
      const s = readSigned(signedText, Math.floor(Date.now() / 1000));
      assert.equal(s.executor, exeC.address);
      const args = executeArgs(s.intent, s.auth, compile(s.intent, s.route));
      await c.tx(SOLVER, exeC.address, exeC.iface.encodeFunctionData('execute', args));
      assert.equal(await tka.call('balanceOf', [BOB]), 5n * ZETA);
      assert.equal(await exeC.call('capLeft', [ACC, tka.address]), 5n * ZETA);

      // the uniqueness level: a passkey human the VouchRegistry counts as vouched unique
      await page.fill('#ag-lab-v', VOUCH);
      await page.fill('#ag-lab-q', '0x' + '66'.repeat(20));
      await page.locator('.ag-card', { hasText: 'Person or agent?' }).getByRole('button', { name: 'Check' }).click();
      await page.waitForFunction(() => document.getElementById('ag-lab-level')?.textContent === 'Vouched unique human');
      assert.match(await page.textContent('#ag-lab-out'), /3 of 3 vouches count/);
      await page.fill('#ag-lab-v', '');
      await page.locator('.ag-card', { hasText: 'Person or agent?' }).getByRole('button', { name: 'Check' }).click();
      await page.waitForFunction(() => /not proven unique/.test(document.getElementById('ag-lab-level')?.textContent ?? ''));

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
