// Browser test for the wallet: serves the static site with its real CSP,
// answers the node's JSON-RPC from a mock (Playwright route, no network) and
// checks key creation, encrypt/unlock and a signed send.
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

const PORT = 18090;
const ORIGIN = `http://localhost:${PORT}`;
const RPC = 'https://rpc.zetaphy.test:8545/';
const SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
// Same vector as zetaphy-network/test/pqtx.test.js.
const SEED_BECH32 = 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r';
const SEED_HEX_ADDR = '0x6DA134EbFcb035273E87954f0641bD920ED073Ba';
const TO = 'zetaphy1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3huramw'; // 0x1111…11
const PASS = 'correct horse 1';
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
async function openPage(node = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = []; const outside = []; const sent = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', (r) => { const u = new URL(r.url()); if (u.origin !== ORIGIN && u.host !== 'rpc.zetaphy.test:8545' && u.protocol !== 'blob:') outside.push(r.url()); });
  await page.route((url) => url.host === 'rpc.zetaphy.test:8545', async (route) => {
    const { id, method, params } = JSON.parse(route.request().postData());
    let result;
    if (method === 'eth_chainId') result = '0x12e4e';
    else if (method === 'eth_gasPrice') result = '0x3b9aca00'; // 1 gwei
    else if (method === 'eth_getBalance') result = '0x' + (node.balance ?? 10n ** 19n).toString(16);
    else if (method === 'zetaphy_pqAccount') {
      result = { address: SEED_BECH32, hex: SEED_HEX_ADDR, chainId: 'zetaphy-testnet-1', denom: 'azetaphy', exists: !!node.exists,
        accountNumber: node.exists ? '12' : null, sequence: node.exists ? '4' : null };
    } else if (method === 'zetaphy_sendCosmosTx') {
      sent.push(params[0]);
      result = { txHash: createHash('sha256').update(Buffer.from(params[0].slice(2), 'hex')).digest('hex').toUpperCase(), code: node.code ?? 0, log: node.log ?? '' };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  });
  const res = await page.goto(`${ORIGIN}/`);
  return { page, context, errors, outside, sent, res };
}

const visible = (page, sel) => page.waitForSelector(`${sel}:not([hidden])`);

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
