// Browser test for the wallet: serves the static site with its real CSP,
// answers the node's JSON-RPC from a mock (Playwright route, no network) and
// checks key creation, encrypt/unlock, a signed send, ERC-20 transfers
// (MsgEVMCall, simulated with eth_call first), staking, a quantum lock from
// MetaMask (window.ethereum mocked) and acting for a locked account (as_owner).
//   npm test            (uses Playwright's Chromium)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { TxRaw, TxBody, AuthInfo, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { MsgDelegate, MsgUndelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx';
import { MsgWithdrawDelegatorReward } from 'cosmjs-types/cosmos/distribution/v1beta1/tx';
import { BinaryReader } from 'cosmjs-types/binary';
import { keccak_256 } from '@noble/hashes/sha3.js';

const PORT = 18090;
const ORIGIN = `http://localhost:${PORT}`;
const RPC = 'https://rpc.zetaphy.test:8545/';
const SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
// Same vector as zetaphy-network/test/pqtx.test.js.
const SEED_BECH32 = 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r';
const SEED_HEX_ADDR = '0x6DA134EbFcb035273E87954f0641bD920ED073Ba';
const TO = 'zetaphy1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3huramw'; // 0x1111…11
const PASS = 'correct horse 1';
const TOKEN = '0x3333333333333333333333333333333333333333';
const VALOPER = 'zetaphyvaloper1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zfnr6v8'; // 0x2222…22
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
/** ABI encoding of a single string return value. */
const abiString = (str) => { const h = Buffer.from(str).toString('hex'); return '0x' + word(32) + word(h.length / 2) + h.padEnd(64 * Math.ceil(h.length / 64), '0'); };
let server; let browser;

async function launch() {
  const opts = { headless: true };
  try { return await chromium.launch(opts); } catch {
    return chromium.launch({ ...opts, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', cwd: new URL('..', import.meta.url) });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); });

/** A page whose node RPC is answered by `node` (mutable state). */
async function openPage(node = {}, { ethereum } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  // A mock MetaMask: window.ethereum.request, its calls recorded in window.__eth.
  if (ethereum) {
    await page.addInitScript((cfg) => {
      window.__eth = [];
      window.__ethCfg = cfg;
      window.ethereum = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          window.__eth.push({ method, params });
          const c = window.__ethCfg;
          if (c.reject === method) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          if (method === 'eth_requestAccounts') return [c.account];
          if (method === 'eth_chainId') return c.chainId;
          if (method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32);
          throw new Error(`unexpected ${method}`);
        },
      };
    }, ethereum);
  }
  const errors = []; const outside = []; const sent = []; const calls = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', (r) => { const u = new URL(r.url()); if (u.origin !== ORIGIN && u.host !== 'rpc.zetaphy.test:8545' && u.protocol !== 'blob:') outside.push(r.url()); });
  await page.route((url) => url.host === 'rpc.zetaphy.test:8545', async (route) => {
    const { id, method, params } = JSON.parse(route.request().postData());
    let result; let error;
    if (method === 'eth_chainId') result = '0x12e4e';
    else if (method === 'eth_getCode') result = params[0].toLowerCase() === TOKEN ? '0x6080604052' : '0x';
    else if (method === 'eth_call') {
      // A mock ERC-20 at TOKEN: TUSD, 6 decimals.
      calls.push(params[0]);
      const sel = params[0].data.slice(2, 10);
      if (params[0].to === '0x0000000000000000000000000000000000000800' || params[0].to === '0x0000000000000000000000000000000000000801') result = '0x' + word(1);
      else if (!params[0].data || params[0].data === '0x') result = '0x'; // a plain value transfer
      else if (sel === '313ce567') result = '0x' + word(6);
      else if (sel === '95d89b41') result = abiString('TUSD');
      else if (sel === '70a08231') result = '0x' + word(node.tokenBalance ?? 12_500_000n);
      else if (sel === 'a9059cbb' && node.revert) error = { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance' };
      else if (sel === 'a9059cbb') result = '0x' + word(node.transferResult ?? 1);
      else error = { code: -32000, message: 'execution reverted' };
    }
    else if (method === 'eth_gasPrice') result = '0x3b9aca00'; // 1 gwei
    else if (method === 'eth_getBalance') result = '0x' + (node.balances?.[params[0].toLowerCase()] ?? node.balance ?? 10n ** 19n).toString(16);
    else if (method === 'zetaphy_pqAccount') {
      // Other accounts (locked owners, by lower-case 0x or zetaphy1…) from node.accounts.
      const other = node.accounts?.[params[0].toLowerCase()];
      result = other ? { chainId: 'zetaphy-testnet-1', denom: 'azetaphy', exists: true, accountNumber: '30', sequence: '2', pubKeyType: 'eth_secp256k1', quantumLockedTo: null, ...other }
        : params[0] !== SEED_BECH32 && params[0].toLowerCase() !== SEED_HEX_ADDR.toLowerCase()
          ? { chainId: 'zetaphy-testnet-1', denom: 'azetaphy', exists: false, accountNumber: null, sequence: null, pubKeyType: null, quantumLockedTo: null }
          : { address: SEED_BECH32, hex: SEED_HEX_ADDR, chainId: 'zetaphy-testnet-1', denom: 'azetaphy', exists: !!node.exists,
            accountNumber: node.exists ? '12' : null, sequence: node.exists ? '4' : null, pubKeyType: node.exists ? (node.pubKeyType === undefined ? 'mldsa44' : node.pubKeyType) : null, quantumLockedTo: null };
    } else if (method === 'zetaphy_sendCosmosTx') {
      sent.push(params[0]);
      result = { txHash: createHash('sha256').update(Buffer.from(params[0].slice(2), 'hex')).digest('hex').toUpperCase(), code: node.code ?? 0, log: node.log ?? '' };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) });
  });
  const res = await page.goto(`${ORIGIN}/`);
  return { page, context, errors, outside, sent, calls, res };
}

/** English page with the test seed imported and the mock RPC saved. */
async function importedPage(node, opts) {
  const p = await openPage(node, opts);
  const { page } = p;
  await page.click('#lang');
  await page.click('#mode-import');
  await page.fill('#seed-in', SEED_HEX);
  await page.fill('#pass1', PASS);
  await page.fill('#pass2', PASS);
  await page.click('#save-key');
  await visible(page, '#wallet');
  await page.fill('#rpc', RPC);
  await page.click('#rpc-save');
  await page.waitForFunction(() => document.getElementById('balance').textContent.includes('ZETAPHY'));
  return p;
}

const statusMatches = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("status").textContent), re.source, { timeout: 5000 }).catch(async (e) => { throw new Error(`status is "${await page.textContent("#status")}", wanted ${re}`); });

/** The single message of a broadcast tx, after checking its ML-DSA-44 signature. */
function decodeSent(hex) {
  const raw = TxRaw.decode(Buffer.from(hex.slice(2), 'hex'));
  const doc = SignDoc.encode(SignDoc.fromPartial({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: 'zetaphy-testnet-1', accountNumber: 12n })).finish();
  assert.ok(ml_dsa44.verify(raw.signatures[0], doc, ml_dsa44.keygen(Buffer.from(SEED_HEX, 'hex')).publicKey), 'ML-DSA-44 signature over the SignDoc');
  const body = TxBody.decode(raw.bodyBytes);
  assert.equal(body.messages.length, 1);
  return { msg: body.messages[0], auth: AuthInfo.decode(raw.authInfoBytes) };
}

/** zetaphy.pq.v1.MsgEVMCall { sender = 1; to = 2; value = 3; data = 4; gas_limit = 5 }, decoded by hand. */
function decodeMsgEVMCall(bytes) {
  const r = new BinaryReader(bytes);
  const m = { sender: '', to: '', value: '', data: new Uint8Array(), gasLimit: 0n };
  while (r.pos < r.len) {
    const tag = r.uint32();
    switch (tag >>> 3) {
      case 1: m.sender = r.string(); break;
      case 2: m.to = r.string(); break;
      case 3: m.value = r.string(); break;
      case 4: m.data = r.bytes(); break;
      case 5: m.gasLimit = r.uint64(); break;
      case 6: m.asOwner = r.string(); break;
      default: r.skipType(tag & 7);
    }
  }
  return m;
}

const visible = (page, sel) => page.waitForSelector(`${sel}:not([hidden])`, { timeout: 8000 }).catch(async (e) => { throw new Error(`${sel} not shown; status "${await page.textContent('#status')}"`); });

test('page loads in Thai with warnings and its CSP, then switches to English', async () => {
  const { page, context, errors, outside, res } = await openPage();
  assert.match(res.headers()['content-security-policy'], /script-src 'self'.*connect-src \*.*frame-ancestors 'none'/);
  assert.equal(res.headers()['x-content-type-options'], 'nosniff');
  await visible(page, '#setup');
  assert.equal(await page.getAttribute('html', 'lang'), 'th');
  assert.match(await page.textContent('#warning'), /testnet/);
  assert.match(await page.textContent('#warning'), /หาย/);
  assert.equal(await page.inputValue('#rpc'), '', 'no default RPC');
  await page.click('#lang');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.match(await page.textContent('#warning'), /not real money/);
  await page.reload();
  assert.equal(await page.getAttribute('html', 'lang'), 'en', 'language remembered');
  assert.deepEqual(outside, [], 'no requests to other sites');
  assert.deepEqual(errors, []);
  await context.close();
});

test('create a key, back it up, then lock and unlock (wrong passphrase refused)', async () => {
  const { page, context, errors } = await openPage();
  await page.fill('#pass1', PASS);
  await page.fill('#pass2', 'something else');
  await page.click('#save-key');
  assert.match(await page.textContent('#status'), /ไม่ตรงกัน/);
  await page.fill('#pass2', PASS);
  await page.click('#save-key');
  await visible(page, '#wallet');
  const bech32 = await page.textContent('#addr-bech32');
  const hex = await page.textContent('#addr-hex');
  assert.match(bech32, /^zetaphy1[02-9ac-hj-np-z]{38}$/);
  assert.match(hex, /^0x[0-9a-fA-F]{40}$/);

  // The backup is the plain seed, and it gives the address shown.
  assert.ok(await page.isDisabled('#backup'), 'backup needs the warning ticked');
  await page.check('#backup-ok');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
  const seedHex = readFileSync(await dl.path(), 'utf8').trim();
  assert.match(seedHex, /^0x[0-9a-f]{64}$/);
  const pk = ml_dsa44.keygen(Buffer.from(seedHex.slice(2), 'hex')).publicKey;
  assert.equal(createHash('sha256').update(Buffer.concat([Buffer.from('zetaphy/mldsa44\0'), Buffer.from(pk)])).digest('hex').slice(0, 40), hex.slice(2).toLowerCase());

  // Only the encrypted form is stored.
  const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  const all = JSON.stringify(stored);
  assert.ok(!all.includes(seedHex.slice(2)), 'plain seed never in localStorage');
  const blob = JSON.parse(stored['zetaphy-wallet:seed:v1']);
  assert.equal(blob.kdf, 'PBKDF2-SHA256');
  assert.equal(blob.iterations, 600000);
  assert.equal(blob.cipher, 'AES-256-GCM');
  assert.equal(blob.address, bech32);

  await page.reload();
  await visible(page, '#locked');
  assert.equal(await page.textContent('#locked-addr'), bech32);
  await page.fill('#unlock-pass', 'wrong passphrase');
  await page.click('#unlock');
  await page.waitForSelector('#status.error');
  assert.match(await page.textContent('#status'), /รหัสผ่านไม่ถูกต้อง/);
  assert.ok(await page.isHidden('#wallet'));
  await page.fill('#unlock-pass', PASS);
  await page.click('#unlock');
  await visible(page, '#wallet');
  assert.equal(await page.textContent('#addr-bech32'), bech32);
  await page.click('#lock');
  await visible(page, '#locked');
  assert.deepEqual(errors, []);
  await context.close();
});

test('import a seed, see "fund it first", then send a signed tx the node receives', async () => {
  const node = { exists: false };
  const { page, context, errors, outside, sent } = await openPage(node);
  await page.click('#lang'); // English for this one
  await page.click('#mode-import');
  await page.fill('#seed-in', '0x' + SEED_HEX);
  await page.fill('#pass1', PASS);
  await page.fill('#pass2', PASS);
  await page.click('#save-key');
  await visible(page, '#wallet');
  assert.equal(await page.textContent('#addr-bech32'), SEED_BECH32, 'same address as the CLI');
  assert.equal(await page.textContent('#addr-hex'), SEED_HEX_ADDR);

  await page.fill('#rpc', RPC);
  await page.click('#rpc-save');
  await page.waitForFunction(() => document.getElementById('balance').textContent.includes('ZETAPHY'));
  assert.equal(await page.textContent('#balance'), '10 ZETAPHY');
  assert.match(await page.textContent('#acct-status'), /send ZETAPHY to this address first/);

  await page.fill('#to', TO);
  await page.fill('#amount', '1.25');
  await page.click('#review');
  await page.waitForSelector('#status.error');
  assert.match(await page.textContent('#status'), /send ZETAPHY to this address first/);
  assert.ok(await page.isHidden('#confirm'));

  node.exists = true;
  await page.fill('#to', 'zetaphy1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3huramq');
  await page.click('#review');
  await page.waitForFunction(() => /checksum/.test(document.getElementById('status').textContent));

  await page.fill('#to', TO);
  await page.click('#review');
  await visible(page, '#confirm');
  assert.equal(await page.textContent('#c-amount'), '1.25 ZETAPHY');
  assert.equal(await page.textContent('#c-fee'), '0.00048 ZETAPHY', '400000 gas x 1.2 gwei');
  assert.equal(await page.textContent('#c-total'), '1.25048 ZETAPHY');
  assert.match(await page.textContent('#c-to'), /0x1111111111111111111111111111111111111111/);
  assert.equal(sent.length, 0, 'nothing sent before confirming');
  await page.click('#confirm-send');
  await visible(page, '#tx-result');

  assert.equal(sent.length, 1);
  const txBytes = Buffer.from(sent[0].slice(2), 'hex');
  assert.equal(await page.textContent('#tx-hash'), createHash('sha256').update(txBytes).digest('hex').toUpperCase());
  const raw = TxRaw.decode(txBytes);
  const body = TxBody.decode(raw.bodyBytes);
  const msg = MsgSend.decode(body.messages[0].value);
  assert.equal(body.messages[0].typeUrl, '/cosmos.bank.v1beta1.MsgSend');
  assert.equal(msg.fromAddress, SEED_BECH32);
  assert.equal(msg.toAddress, TO);
  assert.deepEqual(msg.amount, [{ denom: 'azetaphy', amount: '1250000000000000000' }]);
  const auth = AuthInfo.decode(raw.authInfoBytes);
  assert.equal(auth.signerInfos[0].publicKey.typeUrl, '/zetaphy.crypto.mldsa44.PubKey');
  assert.equal(auth.signerInfos[0].sequence, 4n);
  assert.deepEqual(auth.fee.amount, [{ denom: 'azetaphy', amount: '480000000000000' }]);
  const doc = SignDoc.encode(SignDoc.fromPartial({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: 'zetaphy-testnet-1', accountNumber: 12n })).finish();
  const pk = ml_dsa44.keygen(Buffer.from(SEED_HEX, 'hex')).publicKey;
  assert.ok(ml_dsa44.verify(raw.signatures[0], doc, pk), 'ML-DSA-44 signature over the SignDoc');

  // A rejection from the node is shown, not swallowed.
  node.code = 13; node.log = 'insufficient fee';
  await page.fill('#amount', '1');
  await page.click('#review');
  await visible(page, '#confirm');
  await page.click('#confirm-send');
  await page.waitForFunction(() => /insufficient fee/.test(document.getElementById('status').textContent));
  assert.match(await page.textContent('#status'), /rejected the transaction.*code 13/);

  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('ERC-20: look up a token, then send it as a MsgEVMCall checked with eth_call first', async () => {
  const node = { exists: true };
  const { page, context, errors, outside, sent, calls } = await importedPage(node);

  await page.fill('#token', '0x33333');
  await page.click('#token-load');
  await statusMatches(page, /0x and 40 hex digits/);
  await page.fill('#token', '0x4444444444444444444444444444444444444444');
  await page.click('#token-load');
  await statusMatches(page, /no contract at 0x4444/);
  await page.fill('#token', TOKEN);
  await page.click('#token-load');
  await visible(page, '#token-info');
  assert.equal(await page.textContent('#token-balance'), '12.5 TUSD');
  assert.match(await page.textContent('#token-meta'), /TUSD · 6 decimals · contract 0x3333/);
  assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy-wallet:token')), TOKEN, 'last token remembered');
  const balanceOf = calls.find((c) => c.data.startsWith('0x70a08231'));
  assert.equal(balanceOf.data, '0x70a08231' + word(SEED_HEX_ADDR), 'balanceOf(this account)');

  // Bad inputs are refused before anything is signed.
  await page.fill('#token-to', 'zetaphy1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3huramq');
  await page.fill('#token-amount', '1');
  await page.click('#token-review');
  await statusMatches(page, /Invalid recipient/);
  await page.fill('#token-to', TO);
  await page.fill('#token-amount', '1.0000001');
  await page.click('#token-review');
  await statusMatches(page, /more than 6 decimal places for TUSD/);
  await page.fill('#token-amount', '13');
  await page.click('#token-review');
  await statusMatches(page, /Not enough of the token: sending 13 TUSD, have 12.5/);
  await page.fill('#token-amount', '2.5');
  await page.click('#token-form summary');
  await page.fill('#token-gas', '1000');
  await page.click('#token-review');
  await statusMatches(page, /EVM gas limit must be a whole number from 21000/);
  await page.fill('#token-gas', '200000');

  await page.click('#token-review');
  await visible(page, '#token-confirm');
  assert.equal(await page.textContent('#t-amount'), '2.5 TUSD');
  assert.equal(await page.textContent('#t-fee'), '0.00072 ZETAPHY', '(200000 EVM + 400000) gas x 1.2 gwei');
  assert.match(await page.textContent('#t-to'), /0x1111111111111111111111111111111111111111/);
  assert.match(await page.textContent('#t-token'), /TUSD\n0x3333/);
  assert.equal(sent.length, 0, 'nothing sent before confirming');
  await page.click('#confirm-token');
  await visible(page, '#token-result');
  assert.match(await page.textContent('#status'), /Sent/);

  const transferData = '0xa9059cbb' + word('0x1111111111111111111111111111111111111111') + word(2_500_000);
  const checks = calls.filter((c) => c.data.startsWith('0xa9059cbb'));
  assert.equal(checks.length, 2, 'simulated at review and again by callEVM before signing');
  for (const c of checks) {
    assert.equal(c.from, SEED_HEX_ADDR);
    assert.equal(c.to.toLowerCase(), TOKEN);
    assert.equal(c.data, transferData);
    assert.equal(BigInt(c.gas), 200000n);
  }

  assert.equal(sent.length, 1);
  assert.equal(await page.textContent('#token-hash'), createHash('sha256').update(Buffer.from(sent[0].slice(2), 'hex')).digest('hex').toUpperCase());
  const { msg, auth } = decodeSent(sent[0]);
  assert.equal(msg.typeUrl, '/zetaphy.pq.v1.MsgEVMCall');
  const call = decodeMsgEVMCall(msg.value);
  assert.equal(call.sender, SEED_BECH32);
  assert.equal(call.to, TOKEN);
  assert.equal(call.value, '', 'no ZETAPHY value with a token transfer');
  assert.equal('0x' + Buffer.from(call.data).toString('hex'), transferData);
  assert.equal(call.gasLimit, 200000n);
  assert.equal(auth.fee.gasLimit, 600000n);
  assert.deepEqual(auth.fee.amount, [{ denom: 'azetaphy', amount: '720000000000000' }]);
  assert.equal(auth.signerInfos[0].sequence, 4n);

  // The token address comes back after a reload.
  await page.reload();
  await visible(page, '#locked');
  assert.equal(await page.inputValue('#token'), TOKEN);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('ERC-20: a transfer that would revert or return false is refused, and nothing is broadcast', async () => {
  const node = { exists: true, revert: true };
  const { page, context, errors, sent } = await importedPage(node);
  await page.fill('#token', TOKEN);
  await page.fill('#token-to', TO);
  await page.fill('#token-amount', '1');
  await page.click('#token-review'); // looks the token up on the way
  await statusMatches(page, /would fail.*transfer amount exceeds balance/);
  assert.ok(await page.isHidden('#token-confirm'));
  assert.equal(await page.textContent('#token-balance'), '12.5 TUSD');

  node.revert = false; node.transferResult = 0;
  await page.click('#token-review');
  await statusMatches(page, /refused the transfer \(transfer returned false\)/);
  assert.ok(await page.isHidden('#token-confirm'));

  // It passes at review but reverts by the time it is confirmed: callEVM's own check stops it.
  node.transferResult = 1;
  await page.click('#token-review');
  await visible(page, '#token-confirm');
  node.revert = true;
  await page.click('#confirm-token');
  await statusMatches(page, /would fail.*transfer amount exceeds balance/);
  assert.ok(await page.isHidden('#token-result'));

  assert.equal(sent.length, 0, 'nothing broadcast');
  assert.deepEqual(errors, []);
  await context.close();
});

test('staking: stake, unstake and claim rewards as signed Cosmos messages', async () => {
  const node = { exists: true };
  const { page, context, errors, outside, sent } = await importedPage(node);

  await page.fill('#validator', TO); // an account address, not a validator
  await page.fill('#stake-amount', '3');
  await page.click('#stake');
  await statusMatches(page, /must be a zetaphyvaloper1/);
  await page.fill('#validator', VALOPER.slice(0, -1) + 'q');
  await page.click('#stake');
  await statusMatches(page, /must be a zetaphyvaloper1/);
  await page.fill('#validator', VALOPER.toUpperCase());
  await page.fill('#stake-amount', '0');
  await page.click('#stake');
  await statusMatches(page, /Invalid amount/);
  await page.fill('#stake-amount', '20');
  await page.click('#stake');
  await statusMatches(page, /Not enough: need 20.0006 ZETAPHY/);

  await page.fill('#stake-amount', '3');
  await page.click('#stake');
  await visible(page, '#stake-confirm');
  assert.equal(await page.textContent('#stake-confirm-title'), 'Confirm the stake');
  assert.equal(await page.textContent('#s-validator'), VALOPER, 'canonical lower case');
  assert.equal(await page.textContent('#s-amount'), '3 ZETAPHY');
  assert.equal(await page.textContent('#s-fee'), '0.0006 ZETAPHY', '500000 gas x 1.2 gwei');
  assert.equal(await page.textContent('#s-total'), '3.0006 ZETAPHY');
  assert.ok(await page.isHidden('#unbond-note'));
  assert.equal(sent.length, 0);
  await page.click('#confirm-stake');
  await visible(page, '#stake-result');
  assert.equal(sent.length, 1);
  let { msg, auth } = decodeSent(sent[0]);
  assert.equal(msg.typeUrl, '/cosmos.staking.v1beta1.MsgDelegate');
  assert.deepEqual(MsgDelegate.decode(msg.value), { delegatorAddress: SEED_BECH32, validatorAddress: VALOPER, amount: { denom: 'azetaphy', amount: '3000000000000000000' } });
  assert.equal(auth.fee.gasLimit, 500000n);

  await page.fill('#stake-amount', '1');
  await page.click('#unstake');
  await visible(page, '#stake-confirm');
  assert.equal(await page.textContent('#stake-confirm-title'), 'Confirm the unstake');
  assert.ok(await page.isVisible('#unbond-note'));
  assert.equal(await page.textContent('#s-total'), '0.0006 ZETAPHY', 'unstaking spends only the fee');
  await page.click('#confirm-stake');
  await statusMatches(page, /Unstake sent/);
  ({ msg } = decodeSent(sent[1]));
  assert.equal(msg.typeUrl, '/cosmos.staking.v1beta1.MsgUndelegate');
  assert.deepEqual(MsgUndelegate.decode(msg.value), { delegatorAddress: SEED_BECH32, validatorAddress: VALOPER, amount: { denom: 'azetaphy', amount: '1000000000000000000' } });

  await page.fill('#stake-amount', '');
  await page.click('#claim');
  await visible(page, '#stake-confirm');
  assert.equal(await page.textContent('#stake-confirm-title'), 'Confirm claiming rewards');
  assert.ok(await page.isHidden('#s-amount'));
  await page.click('#confirm-stake');
  await statusMatches(page, /Claim sent/);
  ({ msg } = decodeSent(sent[2]));
  assert.equal(msg.typeUrl, '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward');
  assert.deepEqual(MsgWithdrawDelegatorReward.decode(msg.value), { delegatorAddress: SEED_BECH32, validatorAddress: VALOPER });

  // Thai labels follow the language switch.
  await page.click('#lang');
  assert.equal(await page.textContent('#claim'), 'รับรางวัล');
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- quantum lock ----
const OWNER = '0x4444444444444444444444444444444444444444'; // a MetaMask account
const OWNER_BECH32 = 'zetaphy1g3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zy4seeq9';
const OTHER_LOCKED = '0x5555555555555555555555555555555555555555'; // locked to someone else
const OTHER_LOCKED_BECH32 = 'zetaphy1242424242424242424242424242424248wwy4h';
const ELSEWHERE = 'zetaphy1venxvenxvenxvenxvenxvenxvenxvenxgntzaq';
/** node.accounts entries under both forms of an address (the wallet asks with either). */
const both = (hex, bech32, v) => ({ [hex]: v, [bech32]: v });
const ethCalls = (page) => page.evaluate(() => window.__eth.map((c) => c.method));

test('quantum lock: lock a MetaMask account to this wallet (window.ethereum), only after the warnings', async () => {
  // First without MetaMask in the browser.
  const bare = await importedPage({ exists: true });
  await bare.page.check('#mm-ok');
  await bare.page.click('#mm-lock');
  await statusMatches(bare.page, /MetaMask \(window\.ethereum\) was not found/);
  await bare.context.close();

  const node = { exists: true, pubKeyType: null, accounts: {} };
  const { page, context, errors, outside, sent } = await importedPage(node, { ethereum: { account: OWNER, chainId: '0x12e4e' } });
  assert.match(await page.textContent('#mm-card'), /Permanent, no undo/);
  assert.match(await page.textContent('#mm-card'), /lose this wallet's seed, the locked account is lost too/);
  assert.ok(await page.isDisabled('#mm-lock'), 'needs the warning ticked');
  await page.check('#mm-ok');
  assert.ok(await page.isEnabled('#mm-lock'));

  // This wallet has not sent a tx yet: the chain would refuse it as a controller.
  await page.click('#mm-lock');
  await statusMatches(page, /has not sent a transaction yet/);
  assert.deepEqual(await ethCalls(page), [], 'MetaMask not even asked');

  // MetaMask on another chain.
  node.pubKeyType = 'mldsa44';
  await page.evaluate(() => { window.__ethCfg.chainId = '0x1'; });
  await page.click('#mm-lock');
  await statusMatches(page, /MetaMask is not on ZETAPHY testnet \(chain id 1\)/);
  await page.evaluate(() => { window.__ethCfg.chainId = '0x12e4e'; });

  // The last confirmation names both accounts; dismissing it sends nothing.
  const dialogs = [];
  let accept = false;
  page.on('dialog', (d) => { dialogs.push(d.message()); (accept ? d.accept() : d.dismiss()); });
  await page.click('#mm-lock');
  await statusMatches(page, /Cancelled\. Nothing was sent/);
  assert.match(dialogs[0], new RegExp(`${OWNER}[\\s\\S]*${SEED_BECH32}[\\s\\S]*never work on ZETAPHY again`));
  assert.ok(!(await ethCalls(page)).includes('eth_sendTransaction'));

  // Rejected in MetaMask.
  accept = true;
  await page.evaluate(() => { window.__ethCfg.reject = 'eth_sendTransaction'; });
  await page.click('#mm-lock');
  await statusMatches(page, /Rejected in MetaMask/);
  await page.evaluate(() => { window.__ethCfg.reject = null; });

  // Sent: to 0x…5051, no value, this wallet's 20-byte address as data.
  await page.click('#mm-lock');
  await visible(page, '#mm-result');
  assert.equal(await page.textContent('#mm-hash'), '0x' + 'ab'.repeat(32));
  const tx = await page.evaluate(() => window.__eth.filter((c) => c.method === 'eth_sendTransaction').at(-1).params[0]);
  assert.deepEqual(tx, { from: OWNER, to: '0x0000000000000000000000000000000000005051', value: '0x0', data: SEED_HEX_ADDR.toLowerCase() });
  assert.deepEqual((await ethCalls(page)).slice(0, 2), ['eth_requestAccounts', 'eth_chainId']);
  assert.ok(await page.isDisabled('#mm-lock'), 'the warning must be ticked again for another lock');
  assert.match(await page.textContent('#status'), /MetaMask sent the lock/);
  assert.match(await page.textContent('#owned-list'), new RegExp(OWNER));

  // Once the chain shows the lock, the list says so; locking it again is not needed.
  Object.assign(node.accounts, both(OWNER, OWNER_BECH32, { quantumLockedTo: SEED_BECH32 }));
  await page.click('#refresh');
  await page.waitForFunction(() => /locked to this wallet/.test(document.getElementById('owned-list').textContent));
  await page.check('#mm-ok');
  const n = (await ethCalls(page)).filter((m) => m === 'eth_sendTransaction').length;
  await page.click('#mm-lock');
  await statusMatches(page, /already locked to this wallet/);
  assert.equal((await ethCalls(page)).filter((m) => m === 'eth_sendTransaction').length, n);
  // Locked to someone else.
  await page.evaluate((a) => { window.__ethCfg.account = a; }, OTHER_LOCKED);
  Object.assign(node.accounts, both(OTHER_LOCKED, OTHER_LOCKED_BECH32, { quantumLockedTo: ELSEWHERE }));
  await page.click('#mm-lock');
  await statusMatches(page, new RegExp(`already locked to ${ELSEWHERE}`));

  // Thai strings follow the language switch.
  await page.click('#lang');
  assert.equal(await page.textContent('#mm-card h2'), 'ล็อกบัญชี MetaMask ให้กระเป๋านี้');
  assert.equal(sent.length, 0, 'no Cosmos tx from this wallet');
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('act for a locked account: send, token send and stake go out as MsgEVMCall with as_owner', async () => {
  const node = { exists: true, accounts: { ...both(OWNER, OWNER_BECH32, { quantumLockedTo: SEED_BECH32 }), ...both(OTHER_LOCKED, OTHER_LOCKED_BECH32, { quantumLockedTo: ELSEWHERE }) },
    balances: { [OWNER]: 5n * 10n ** 18n } };
  const { page, context, errors, outside, sent, calls } = await importedPage(node);

  // Only an account locked to this wallet can be used.
  await page.fill('#owner', '0x6666666666666666666666666666666666666666');
  await page.click('#owner-use');
  await statusMatches(page, /not quantum-locked to this wallet/);
  await page.fill('#owner', OTHER_LOCKED);
  await page.click('#owner-use');
  await statusMatches(page, new RegExp(`locked to another account \\(${ELSEWHERE}\\)`));
  await page.fill('#owner', SEED_BECH32);
  await page.click('#owner-use');
  await statusMatches(page, /this wallet's own account/);
  assert.ok(await page.isHidden('#acting'));

  await page.fill('#owner', OWNER_BECH32);
  await page.click('#owner-use');
  await visible(page, '#acting');
  assert.match(await page.textContent('#acting-addr'), new RegExp(OWNER));
  assert.equal(await page.textContent('#acting-balance'), '5 ZETAPHY');
  assert.match(await page.textContent('#status'), /Now acting as/);
  for (const tag of await page.$$('.as-tag')) assert.equal(await tag.textContent(), `For ${OWNER}`);
  assert.deepEqual(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), `zetaphy-wallet:owners:v1:${SEED_BECH32}`)), [OWNER]);

  // Send: the owner's balance pays the amount, this wallet the fee.
  await page.fill('#to', TO);
  await page.fill('#amount', '6');
  await page.click('#review');
  await statusMatches(page, /That account does not have enough: needs 6 ZETAPHY, has 5/);
  await page.fill('#amount', '1.25');
  await page.click('#review');
  await visible(page, '#confirm');
  assert.equal(await page.textContent('#c-fee'), '0.00072 ZETAPHY', '(200000 EVM + 400000) gas x 1.2 gwei');
  assert.match(await page.textContent('#confirm .as-note'), new RegExp(`For ${OWNER}, which is quantum-locked to this wallet`));
  await page.click('#confirm-send');
  await visible(page, '#tx-result');
  let { msg, auth } = decodeSent(sent[0]);
  assert.equal(msg.typeUrl, '/zetaphy.pq.v1.MsgEVMCall');
  assert.deepEqual(decodeMsgEVMCall(msg.value), { sender: SEED_BECH32, to: '0x1111111111111111111111111111111111111111', value: '1250000000000000000', data: new Uint8Array(), gasLimit: 200000n, asOwner: OWNER_BECH32 });
  assert.equal(auth.fee.gasLimit, 600000n);
  assert.equal(calls.filter((c) => !c.data || c.data === '0x').at(-1).from, OWNER, 'simulated as the owner');

  // ERC-20: the owner's balance, simulated from the owner, sent with as_owner.
  await page.fill('#token', TOKEN);
  await page.click('#token-load');
  await visible(page, '#token-info');
  assert.equal(calls.filter((c) => c.data.startsWith('0x70a08231')).at(-1).data, '0x70a08231' + word(OWNER), 'balanceOf(owner)');
  await page.fill('#token-to', TO);
  await page.fill('#token-amount', '2.5');
  await page.click('#token-review');
  await visible(page, '#token-confirm');
  assert.ok(await page.isVisible('#token-confirm .as-note'));
  await page.click('#confirm-token');
  await visible(page, '#token-result');
  for (const c of calls.filter((x) => x.data.startsWith('0xa9059cbb'))) assert.equal(c.from, OWNER);
  ({ msg } = decodeSent(sent[1]));
  const tcall = decodeMsgEVMCall(msg.value);
  assert.equal(tcall.asOwner, OWNER_BECH32);
  assert.equal(tcall.to, TOKEN);

  // Stake: the staking precompile with delegator = owner.
  await page.fill('#validator', VALOPER);
  await page.fill('#stake-amount', '3');
  await page.click('#stake');
  await visible(page, '#stake-confirm');
  assert.equal(await page.textContent('#s-fee'), '0.00084 ZETAPHY', '(300000 EVM + 400000) gas x 1.2 gwei');
  assert.ok(await page.isVisible('#stake-confirm .as-note'));
  await page.click('#confirm-stake');
  await visible(page, '#stake-result');
  ({ msg, auth } = decodeSent(sent[2]));
  const scall = decodeMsgEVMCall(msg.value);
  assert.equal(scall.to, '0x0000000000000000000000000000000000000800');
  assert.equal(scall.asOwner, OWNER_BECH32);
  assert.equal(scall.gasLimit, 300000n);
  assert.equal(auth.fee.gasLimit, 700000n);
  const data = Buffer.from(scall.data).toString('hex');
  assert.equal(data.slice(0, 8), Buffer.from(keccak_256(Buffer.from('delegate(address,string,uint256)'))).toString('hex').slice(0, 8), 'delegate selector');
  assert.equal(data.slice(8, 72), word(OWNER), 'delegator = the owner');
  assert.equal(BigInt('0x' + data.slice(136, 200)), 3n * 10n ** 18n);
  assert.match(Buffer.from(data.slice(264), 'hex').toString(), new RegExp(VALOPER));

  // Back to this wallet's own account: a plain MsgSend again.
  await page.click('#owner-stop');
  await statusMatches(page, /Back to your own account/);
  assert.ok(await page.isHidden('#acting'));
  for (const tag of await page.$$('.as-tag')) assert.ok(await tag.isHidden());
  await page.fill('#amount', '1');
  await page.click('#review');
  await visible(page, '#confirm');
  assert.ok(await page.isHidden('#confirm .as-note'));
  await page.click('#confirm-send');
  await statusMatches(page, /^Sent\./);
  assert.equal(decodeSent(sent[3]).msg.typeUrl, '/cosmos.bank.v1beta1.MsgSend');

  // The remembered account comes back after unlocking, with a button to act as it.
  await page.reload();
  await page.fill('#unlock-pass', PASS);
  await page.click('#unlock');
  await visible(page, '#wallet');
  await page.waitForFunction(() => /locked to this wallet/.test(document.getElementById('owned-list').textContent));
  await page.click('#owned-list button');
  await visible(page, '#acting');
  await page.click('#lang');
  assert.match(await page.textContent('#acting'), /กำลังทำรายการในนามของ/);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});
