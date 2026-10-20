// Browser test for the wallet: serves the static site with its real CSP,
// answers the node's JSON-RPC from a mock (Playwright route, no network) and
// checks key creation, encrypt/unlock, a signed send, ERC-20 transfers
// (MsgEVMCall, simulated with eth_call first) and staking.
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
async function openPage(node = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
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
      if (sel === '313ce567') result = '0x' + word(6);
      else if (sel === '95d89b41') result = abiString('TUSD');
      else if (sel === '70a08231') result = '0x' + word(node.tokenBalance ?? 12_500_000n);
      else if (sel === 'a9059cbb' && node.revert) error = { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance' };
      else if (sel === 'a9059cbb') result = '0x' + word(node.transferResult ?? 1);
      else error = { code: -32000, message: 'execution reverted' };
    }
    else if (method === 'eth_gasPrice') result = '0x3b9aca00'; // 1 gwei
    else if (method === 'eth_getBalance') result = '0x' + (node.balance ?? 10n ** 19n).toString(16);
    else if (method === 'zetaphy_pqAccount') {
      result = { address: SEED_BECH32, hex: SEED_HEX_ADDR, chainId: 'zetaphy-testnet-1', denom: 'azetaphy', exists: !!node.exists,
        accountNumber: node.exists ? '12' : null, sequence: node.exists ? '4' : null };
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
async function importedPage(node) {
  const p = await openPage(node);
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

const statusMatches = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status').textContent), re.source);

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
      default: r.skipType(tag & 7);
    }
  }
  return m;
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
