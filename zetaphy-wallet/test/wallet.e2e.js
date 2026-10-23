// Browser test for the wallet: serves the static site with its real CSP,
// answers the node's JSON-RPC from a mock (Playwright route, no network) and
// checks key creation, encrypt/unlock, a signed send, ERC-20 transfers
// (MsgEVMCall, simulated with eth_call first), staking, contract creation, a
// quantum lock from MetaMask (window.ethereum mocked), acting for a locked
// account (as_owner), and the MetaMask Snap mode (a fake ZETAPHY Snap behind a
// mocked window.ethereum: wallet_requestSnaps / wallet_invokeSnap).
// Other wallets: fake EIP-6963 wallets, Binance Wallet (window.binancew3w), Phantom,
// Keplr / Leap / Cosmostation, WalletConnect off without a projectId, and the
// network settings checked against zetaphy-chain/wallets/*.json. Vaccine: calls and transfers to
// code flagged in a mock ThreatRegistry are refused before anything is signed.
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
// The fake snap builds and signs with the same code the real one bundles.
import { buildTx, messageFromIntent, pqAddress, bytesToHex, createAddress, codeFingerprint, addressKey, REASON_TEXT, DISCLAIMER, REPRODUCE } from '../vendor/pqwallet.js';

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
const TOKEN_CODE = '0x6080604052';
const REGISTRY = '0x7777777777777777777777777777777777777777';
const sel4 = (sig) => Buffer.from(keccak_256(Buffer.from(sig))).toString('hex').slice(0, 8);
// [warning view, enforcement view] for each kind of key.
const REG_SEL = { fingerprint: [sel4('isFlagged(bytes32)'), sel4('isEnforced(bytes32)')], code: [sel4('isCodeFlagged(bytes32)'), sel4('isCodeEnforced(bytes32)')],
  address: [sel4('isAddressFlagged(uint256,address)'), sel4('isAddressEnforced(uint256,address)')] };
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967
const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
// The views that explain a flag: evidenceOf(key) -> (bytes32, string, address, uint64), responseAt(key, i) -> (string, address, uint64, uint256, address).
const DETAIL_SEL = { evidence: sel4('evidenceOf(bytes32)'), responseAt: sel4('responseAt(bytes32,uint256)') };
const strTail = (str) => { const h = Buffer.from(str).toString('hex'); return word(h.length / 2) + h.padEnd(64 * Math.ceil(h.length / 64), '0'); };
const abiEvidence = (hash, uri) => '0x' + hash.slice(2) + word(128) + word(0x99) + word(5) + strTail(uri);
const abiResponse = (text, by, chainId = 77390) => '0x' + word(160) + word(by) + word(7) + word(chainId) + word(chainId ? TOKEN : 0) + strTail(text);
const REPORT = '0x' + 'e7'.repeat(32);
// Neutral reason texts (zetaphy-network/src/vaccine.js REASON_TEXT) of the reasons these tests use.
const RT = { 1: 'in a simulated trade, buying worked but selling failed or returned almost nothing', 2: 'an address can mint new tokens without a cap',
  5: 'uses the same name or symbol as a known token at a different address' };
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
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', cwd: new URL('..', import.meta.url), env: { ...process.env, WALLET_PLACEHOLDER_CONFIG: '1' } });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); });

/**
 * A fake ZETAPHY Snap, run in Node: the account of SEED_HEX, and zetaphy_signTx built
 * from the intents with pqtx.js like the real snap. snap.approve = false: the user
 * rejects; snap.tamper(intent): it signs something else; snap.lie: a wrong address.
 */
function fakeSnap(snap) {
  const { publicKey, secretKey } = ml_dsa44.keygen(Buffer.from(SEED_HEX, 'hex'));
  const me = pqAddress(publicKey);
  snap.requests = [];
  return async (snapId, { method, params }) => {
    snap.requests.push({ snapId, method, params });
    if (method === 'zetaphy_getAccount') return { publicKey: '0x' + bytesToHex(publicKey), address: me.bech32, hex: snap.lie ?? me.hex };
    if (method !== 'zetaphy_signTx') throw Object.assign(new Error('method not found'), { code: -32601 });
    if (snap.approve === false) throw Object.assign(new Error('Rejected in the ZETAPHY snap: nothing was signed.'), { code: 4001 });
    const intents = snap.tamper ? params.messages.map(snap.tamper) : params.messages;
    let signature;
    const tx = buildTx({ publicKey, sign: (b) => (signature = ml_dsa44.sign(b, secretKey)), messages: intents.map((i) => messageFromIntent(i, me.bech32)),
      chainId: params.chainId, accountNumber: params.accountNumber, sequence: params.sequence, gasLimit: params.gasLimit, gasPrice: params.gasPrice, memo: params.memo });
    return { signature: '0x' + bytesToHex(signature), txHex: tx.txHex, txHash: tx.txHash };
  };
}

/**
 * Fake wallets, put in the page before it loads; every call is recorded in window.__w.
 * cfg.eip6963: [{ id, uuid, name, rdns, icon }] announce themselves (EIP-6963).
 * cfg.binancew3w: window.binancew3w.ethereum (Binance Web3 Wallet's in-app browser).
 * cfg.keplrLike: ['keplr', 'leap', …] as window[id]; cfg.cosmostation: window.cosmostation.providers.keplr.
 * window.__wCfg[id] (initially cfg.state): { account, chainId, address, fail: { [method]: { code, message } } }.
 */
async function addFakeWallets(page, cfg) {
  await page.addInitScript((cfg) => {
    window.__w = [];
    window.__wCfg = cfg.state ?? {};
    const conf = (id) => (window.__wCfg[id] ??= {});
    const evm = (id, flags = {}) => ({
      ...flags,
      request: async ({ method, params }) => {
        window.__w.push({ wallet: id, method, params });
        const c = conf(id);
        const f = c.fail?.[method];
        if (f) throw Object.assign(new Error(f.message), { code: f.code });
        if (method === 'eth_requestAccounts') return [c.account ?? '0x4444444444444444444444444444444444444444'];
        if (method === 'eth_chainId') return c.chainId ?? '0x1';
        if (method === 'wallet_addEthereumChain' || method === 'wallet_switchEthereumChain') return null;
        throw Object.assign(new Error(`The method "${method}" does not exist / is not available.`), { code: -32601 });
      },
    });
    for (const p of cfg.eip6963 ?? []) {
      const detail = Object.freeze({ info: Object.freeze({ uuid: p.uuid, name: p.name, icon: p.icon, rdns: p.rdns }), provider: evm(p.id) });
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    }
    if (cfg.binancew3w) window.binancew3w = { ethereum: evm('binancew3w', { isBinance: true }) };
    const keplrLike = (id) => ({
      experimentalSuggestChain: async (info) => {
        window.__w.push({ wallet: id, method: 'experimentalSuggestChain', params: info });
        if (conf(id).fail?.suggest) throw new Error(conf(id).fail.suggest);
      },
      enable: async (chainId) => { window.__w.push({ wallet: id, method: 'enable', params: chainId }); },
      getKey: async (chainId) => {
        window.__w.push({ wallet: id, method: 'getKey', params: chainId });
        return { name: 'test', algo: 'ethsecp256k1', bech32Address: conf(id).address ?? 'zetaphy1g3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zy4seeq9', isNanoLedger: false };
      },
    });
    for (const id of cfg.keplrLike ?? []) window[id] = keplrLike(id);
    if (cfg.cosmostation) window.cosmostation = { providers: { keplr: keplrLike('cosmostation') } };
  }, cfg);
}

/** A page whose node RPC is answered by `node` (mutable state). snap: a fake ZETAPHY Snap's state. wallets: fake wallets. */
async function openPage(node = {}, { ethereum, snap, wallets } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  if (wallets) await addFakeWallets(page, wallets);
  if (snap) {
    const handle = fakeSnap(snap);
    await page.exposeFunction('__snap', async (snapId, request) => {
      try { return { result: await handle(snapId, request) }; } catch (e) { return { error: { code: e.code, message: e.message } }; }
    });
  }
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
          if (method === 'personal_sign' && c.personalSign) return c.personalSign;
          if (method === 'wallet_getSnaps' && c.snaps) return {};
          if (method === 'wallet_requestSnaps' && c.snaps) {
            const id = Object.keys(params)[0];
            return { [id]: { id, version: '0.1.0', enabled: true, blocked: false } };
          }
          if (method === 'wallet_invokeSnap' && c.snaps) {
            const r = await window.__snap(params.snapId, params.request);
            if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
            return r.result;
          }
          throw Object.assign(new Error(`The method "${method}" does not exist / is not available.`), { code: -32601 });
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
    else if (method === 'eth_getCode') result = node.codes?.[params[0].toLowerCase()] ?? (params[0].toLowerCase() === TOKEN ? TOKEN_CODE : '0x');
    else if (method === 'eth_call') {
      // A mock ERC-20 at TOKEN: TUSD, 6 decimals.
      calls.push(params[0]);
      const sel = params[0].data.slice(2, 10);
      // A mock ThreatRegistry at node.registry: node.flags = { fingerprint, code, address } lists (lower-case hex);
      // node.flags.warnOnly: flagged but not enforced yet (the enforcement views answer false).
      if (node.registry && params[0].to?.toLowerCase() === node.registry.toLowerCase()) {
        const arg = params[0].data.slice(10).toLowerCase();
        const kind = Object.keys(REG_SEL).find((k) => REG_SEL[k].includes(sel));
        const enforcedView = kind && REG_SEL[kind][1] === sel;
        let hit = kind === 'fingerprint' ? node.flags?.fingerprint?.includes('0x' + arg)
          : kind === 'code' ? node.flags?.code?.includes('0x' + arg)
            : kind === 'address' && BigInt('0x' + arg.slice(0, 64)) === 77390n ? node.flags?.address?.includes('0x' + arg.slice(64 + 24)) : undefined;
        if (hit && enforcedView && node.flags?.warnOnly) hit = false;
        // evidenceOf / responseAt: node.evidence { reportHash, uri } for every key; node.responses { key: [{ text, by, chainId? }] }
        // (in the registry's order: the governance-assigned responder's first, then the newest).
        if (sel === DETAIL_SEL.evidence) hit = null, result = node.evidence ? abiEvidence(node.evidence.reportHash, node.evidence.uri) : abiEvidence('0x' + '00'.repeat(32), '');
        if (sel === DETAIL_SEL.responseAt) {
          const r = [].concat(node.responses?.['0x' + arg.slice(0, 64)] ?? [])[Number(BigInt('0x' + arg.slice(64, 128)))];
          hit = null; result = r ? abiResponse(r.text, r.by, r.chainId) : abiResponse('', 0);
        }
        if (hit === null) { /* answered above */ }
        else if (node.registryDown) error = { code: -32000, message: 'execution reverted' };
        else if (hit === undefined) error = { code: -32000, message: 'execution reverted' };
        else if (hit !== null) result = '0x' + word(hit ? 1 : 0) + word(hit ? node.flags.reason ?? 1 : 0);
      } else if (!params[0].to) { if (node.deployRevert) error = { code: 3, message: 'execution reverted: constructor' }; else result = '0x6080'; } // a contract creation
      else if (params[0].to === '0x0000000000000000000000000000000000000800' || params[0].to === '0x0000000000000000000000000000000000000801') result = '0x' + word(1);
      else if (!params[0].data || params[0].data === '0x') result = '0x'; // a plain value transfer
      else if (sel === '5c60da1b' && node.beacons?.[params[0].to.toLowerCase()]) result = '0x' + word(node.beacons[params[0].to.toLowerCase()]); // implementation()
      else if (sel === '313ce567') result = '0x' + word(6);
      else if (sel === '95d89b41') result = abiString('TUSD');
      else if (sel === '70a08231') result = '0x' + word(node.tokenBalance ?? 12_500_000n);
      else if (sel === 'a9059cbb' && node.revert) error = { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance' };
      else if (sel === 'a9059cbb') result = '0x' + word(node.transferResult ?? 1);
      else error = { code: -32000, message: 'execution reverted' };
    }
    else if (method === 'eth_getStorageAt') result = '0x' + word(node.storage?.[params[0].toLowerCase()]?.[params[1].toLowerCase()] ?? 0);
    else if (method === 'eth_gasPrice') result = '0x3b9aca00'; // 1 gwei
    else if (method === 'eth_getBalance') result = '0x' + (node.balances?.[params[0].toLowerCase()] ?? node.balance ?? 10n ** 19n).toString(16);
    else if (method === 'zetaphy_pqAccount') {
      // Other accounts (locked owners, by lower-case 0x or zetaphy1…) from node.accounts.
      const other = node.accounts?.[params[0].toLowerCase()];
      result = other ? { chainId: 'zetaphy_77390-1', denom: 'azetaphy', exists: true, accountNumber: '30', sequence: '2', pubKeyType: 'eth_secp256k1', quantumLockedTo: null, ...other }
        : params[0] !== SEED_BECH32 && params[0].toLowerCase() !== SEED_HEX_ADDR.toLowerCase()
          ? { chainId: 'zetaphy_77390-1', denom: 'azetaphy', exists: false, accountNumber: null, sequence: null, pubKeyType: null, quantumLockedTo: null }
          : { address: SEED_BECH32, hex: SEED_HEX_ADDR, chainId: 'zetaphy_77390-1', denom: 'azetaphy', exists: !!node.exists,
            accountNumber: node.exists ? '12' : null, sequence: node.exists ? '4' : null, pubKeyType: node.exists ? (node.pubKeyType === undefined ? 'mldsa44' : node.pubKeyType) : null, quantumLockedTo: null };
    } else if (method === 'zetaphy_securityStatus') {
      result = { securityCoreFrom: '1', securityPrecompile: '0x0000000000000000000000000000000000000901', qdayHeight: '0', revealDelay: '5',
        latestHeight: '100', qdayActive: false, threatRegistry: '', threatGateEnabled: false, maxConsentSeconds: 86400,
        ibcHoldDelaySeconds: 21600, ibcHoldGuardian: '', ibcHoldRules: [], ...node.security };
    } else if (method === 'zetaphy_migration') {
      result = { address: '', hex: params[0], migrated: false, controller: null, pendingController: null, postQuantum: false, exposed: false,
        canCommitReveal: true, ...(node.migration?.[params[0].toLowerCase()] ?? {}) };
    } else if (method === 'zetaphy_qdayCommitment') {
      result = node.commitments?.[params[0].toLowerCase()] ?? { found: false, height: 0 };
    } else if (method === 'zetaphy_consent') {
      result = { until: node.consents?.[`${params[0]}|${params[1]}`.toLowerCase()] ?? 0 };
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
  await setLang(page, 'en');
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
  const doc = SignDoc.encode(SignDoc.fromPartial({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: 'zetaphy_77390-1', accountNumber: 12n })).finish();
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
/** Switches the page to `l` with the #lang menu (English is the default) and checks it took. */
async function setLang(page, l) {
  if (await page.getAttribute('html', 'lang') !== l) await page.selectOption('#lang', l);
  assert.equal(await page.getAttribute('html', 'lang'), l);
}

// The languages of every ZETAPHY app, in menu order, with their native names.
const LANGS = [['en', 'English'], ['zh', '中文'], ['es', 'Español'], ['ko', '한국어'], ['ja', '日本語'], ['ru', 'Русский'], ['vi', 'Tiếng Việt'], ['th', 'ไทย']];

/** app.js's T dictionary, evaluated in Node from the source (with the real vaccine texts). */
function appDictionary() {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const start = src.indexOf('const T = {');
  const end = src.indexOf('\n};\n', start);
  assert.ok(start >= 0 && end > start, 'T found in app.js');
  return new Function('REASON_TEXT', 'DISCLAIMER', 'REPRODUCE', `return ${src.slice(start + 'const T = '.length, end + 2)};`)(REASON_TEXT, DISCLAIMER, REPRODUCE);
}

test('page loads in English with warnings and its CSP, then switches to Thai', async () => {
  const { page, context, errors, outside, res } = await openPage();
  assert.match(res.headers()['content-security-policy'], /script-src 'self'.*connect-src \*.*frame-ancestors 'none'/);
  assert.equal(res.headers()['x-content-type-options'], 'nosniff');
  await visible(page, '#setup');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.match(await page.textContent('#warning'), /testnet/);
  assert.match(await page.textContent('#warning'), /not real money/);
  assert.equal(await page.inputValue('#lang'), 'en');
  assert.deepEqual(await page.$$eval('#lang option', (os) => os.map((o) => [o.value, o.textContent])), LANGS, 'the 8 languages, in order, by native name');
  assert.equal(await page.inputValue('#rpc'), '', 'no default RPC');
  await page.selectOption('#lang', 'th');
  assert.equal(await page.getAttribute('html', 'lang'), 'th');
  assert.match(await page.textContent('#warning'), /หาย/);
  assert.equal(await page.inputValue('#lang'), 'th');
  await page.reload();
  assert.equal(await page.getAttribute('html', 'lang'), 'th', 'language remembered');
  assert.match(await page.textContent('#warning'), /หาย/);
  assert.deepEqual(outside, [], 'no requests to other sites');
  assert.deepEqual(errors, []);
  await context.close();
});

test('every language has exactly the English keys, with the same placeholders and no empty text', () => {
  const T = appDictionary();
  assert.deepEqual(Object.keys(T).sort(), LANGS.map(([c]) => c).sort());
  const keys = Object.keys(T.en).sort();
  const vars = (s) => (String(s).match(/\{\w+\}/g) ?? []).sort().join();
  for (const [code] of LANGS) {
    assert.deepEqual(Object.keys(T[code]).sort(), keys, `${code}: same key set as en`);
    for (const k of keys) {
      assert.equal(typeof T[code][k], 'string', `${code}.${k} is text`);
      assert.ok(T[code][k].trim(), `${code}.${k} not empty`);
      assert.equal(vars(T[code][k]), vars(T.en[k]), `${code}.${k} keeps the placeholders of en`);
    }
  }
});

test('each of the 8 languages renders the main screen translated, and a stored code is honoured (else English)', async () => {
  const T = appDictionary();
  const { page, context, errors } = await openPage();
  await visible(page, '#setup');
  const keys = await page.$$eval('[data-i18n]', (els) => els.map((el) => el.dataset.i18n));
  // Text that is the same as English on purpose (brand names and loanwords the community uses as is).
  const SAME = { th: ['stakeTitle', 'stake', 'wcConnect', 'mRpc', 'mChainId', 'mExplorer'], zh: ['wcConnect', 'mRpc'], es: ['cTotal', 'cToken', 'bytesN', 'wcConnect'],
    ko: ['wcConnect', 'mRpc'], ja: ['wcConnect', 'mRpc'], ru: ['wcConnect', 'mRpc'],
    vi: ['cToken', 'stakeTitle', 'validatorLabel', 'stake', 'unstake', 'cValidator', 'wcConnect', 'mChainId'] };
  const sample = ['subtitle', 'warnTitle', 'setupTitle', 'saveKey', 'sendTitle', 'balance'];
  for (const [code] of LANGS) {
    await setLang(page, code);
    assert.equal(await page.inputValue('#lang'), code);
    const shown = await page.$$eval('[data-i18n]', (els) => els.map((el) => [el.dataset.i18n, el.textContent]));
    for (const [k, text] of shown) {
      assert.notEqual(text, k, `${code}: raw key ${k} shown`);
      assert.equal(text, T[code][k], `${code}: ${k} shows its translation`);
      if (code !== 'en' && !SAME[code].includes(k)) assert.notEqual(text, T.en[k], `${code}: ${k} is not the English text`);
    }
    for (const k of sample) {
      assert.ok(keys.includes(k), `${k} is on the main screen`);
      if (code !== 'en') assert.notEqual(await page.textContent(`[data-i18n="${k}"]`), T.en[k], `${code}: ${k} is not the English fallback`);
    }
  }
  // The stored code (the hub writes it too) is honoured on load; anything else means English.
  for (const [stored, want] of [['ko', 'ko'], ['vi', 'vi'], ['de', 'en'], ['TH', 'en'], ['', 'en']]) {
    await page.evaluate((v) => localStorage.setItem('zetaphy-wallet:lang', v), stored);
    await page.reload();
    await visible(page, '#setup');
    assert.equal(await page.getAttribute('html', 'lang'), want, `stored ${JSON.stringify(stored)}`);
    assert.equal(await page.inputValue('#lang'), want);
    assert.equal(await page.textContent('[data-i18n="setupTitle"]'), T[want].setupTitle);
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('create a key, back it up, then lock and unlock (wrong passphrase refused)', async () => {
  const { page, context, errors } = await openPage();
  await setLang(page, 'th');
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
  await setLang(page, 'en');
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
  const doc = SignDoc.encode(SignDoc.fromPartial({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: 'zetaphy_77390-1', accountNumber: 12n })).finish();
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
  await setLang(page, 'th');
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
  await setLang(page, 'th');
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
  await setLang(page, 'th');
  assert.match(await page.textContent('#acting'), /กำลังทำรายการในนามของ/);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- contract creation ----

const INIT_CODE = '0x6080604052348015600f57600080fd5b50603f80601d6000396000f3fe';

test('deploy: the code hash is shown, the creation is simulated, then sent as a MsgEVMCall with no "to"', async () => {
  const node = { exists: true, deployRevert: true };
  const { page, context, errors, outside, sent, calls } = await importedPage(node);
  await page.fill('#init-code', '0x60zz');
  await page.click('#deploy-review');
  await statusMatches(page, /non-empty hex/);
  await page.fill('#init-code', INIT_CODE);
  await page.click('#deploy-review');
  await statusMatches(page, /would fail.*constructor/);
  assert.ok(await page.isHidden('#deploy-confirm'));

  node.deployRevert = false;
  await page.click('#deploy-review');
  await visible(page, '#deploy-confirm');
  assert.equal(await page.textContent('#d-size'), '29 bytes');
  assert.equal(await page.textContent('#d-hash'), '0x' + Buffer.from(keccak_256(Buffer.from(INIT_CODE.slice(2), 'hex'))).toString('hex'));
  assert.equal(await page.textContent('#d-fee'), '0.00408 ZETAPHY', '(3000000 EVM + 400000) gas x 1.2 gwei');
  assert.deepEqual(calls.filter((c) => !c.to).at(-1), { from: SEED_HEX_ADDR, data: INIT_CODE, gas: '0x2dc6c0' });
  assert.equal(sent.length, 0);
  await page.click('#confirm-deploy');
  await visible(page, '#deploy-result');
  assert.match(await page.textContent('#status'), /contract exists once the tx is in a block/);
  assert.equal(await page.textContent('#deploy-address'), createAddress(SEED_HEX_ADDR, 5n), 'CREATE(account, signed sequence + 1)');
  const { msg, auth } = decodeSent(sent[0]);
  assert.equal(msg.typeUrl, '/zetaphy.pq.v1.MsgEVMCall');
  assert.deepEqual(decodeMsgEVMCall(msg.value), { sender: SEED_BECH32, to: '', value: '', data: new Uint8Array(Buffer.from(INIT_CODE.slice(2), 'hex')), gasLimit: 3000000n });
  assert.equal(auth.fee.gasLimit, 3400000n);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- MetaMask Snap mode: the key is in MetaMask, this page only asks ----

const SNAP_ID = 'npm:@zetaphy/snap';
const LOCAL_SNAP_ID = 'local:http://localhost:8080';
const snapCalls = (page) => page.evaluate(() => window.__eth.filter((c) => c.method.startsWith('wallet_')));

/** English page connected to the fake snap, with the mock RPC saved. */
async function snapPage(node, snap) {
  const p = await openPage(node, { ethereum: { snaps: true }, snap });
  const { page } = p;
  await setLang(page, 'en');
  await visible(page, '#snap-card');
  await page.click('#snap-connect');
  await visible(page, '#wallet');
  await page.fill('#rpc', RPC);
  await page.click('#rpc-save');
  await page.waitForFunction(() => document.getElementById('balance').textContent.includes('ZETAPHY'));
  return p;
}

test('snap: connect with wallet_requestSnaps; the address comes from the snap\'s public key; no seed in this page', async () => {
  // Without MetaMask, and with a MetaMask that has no snaps.
  const bare = await openPage({});
  await setLang(bare.page, 'en');
  await bare.page.click('#snap-connect');
  await statusMatches(bare.page, /MetaMask \(window\.ethereum\) was not found/);
  await bare.context.close();
  const old = await openPage({}, { ethereum: { snaps: false } });
  await setLang(old.page, 'en');
  await old.page.click('#snap-connect');
  await statusMatches(old.page, /cannot run snaps/);
  await old.context.close();

  const snap = {};
  const { page, context, errors, outside } = await openPage({ exists: true }, { ethereum: { snaps: true }, snap });
  await setLang(page, 'en');
  await visible(page, '#snap-card');
  assert.match(await page.textContent('#snap-card'), /MetaMask Flask/);
  assert.equal(await page.inputValue('#snap-id'), SNAP_ID, 'from <meta name="zetaphy-snap-id">');
  await page.click('#snap-card summary');
  await page.fill('#snap-id', 'https://evil.example/snap.js');
  await page.click('#snap-connect');
  await statusMatches(page, /must be npm:<package> or local:/);
  assert.deepEqual(await snapCalls(page), []);

  // A snap whose address does not match its public key is not used.
  snap.lie = '0x' + '77'.repeat(20);
  await page.fill('#snap-id', LOCAL_SNAP_ID); // a development snap served by mm-snap serve
  await page.click('#snap-connect');
  await statusMatches(page, /does not match its public key/);
  assert.ok(await page.isHidden('#wallet'));
  delete snap.lie;

  await page.click('#snap-connect');
  await visible(page, '#wallet');
  assert.match(await page.textContent('#status'), /Connected to MetaMask/);
  assert.equal(await page.textContent('#addr-bech32'), SEED_BECH32);
  assert.equal(await page.textContent('#addr-hex'), SEED_HEX_ADDR);
  const calls = await snapCalls(page);
  assert.deepEqual(calls.find((c) => c.method === 'wallet_requestSnaps').params, { [LOCAL_SNAP_ID]: {} });
  assert.deepEqual(calls.at(-1).params, { snapId: LOCAL_SNAP_ID, request: { method: 'zetaphy_getAccount' } });
  assert.ok(await page.isVisible('#snap-mode'));
  assert.ok(await page.isHidden('#backup-card'), 'no seed backup: MetaMask\'s Secret Recovery Phrase is the backup');
  assert.match(await page.textContent('#mm-card'), /lose your MetaMask Secret Recovery Phrase/);
  assert.ok(await page.isHidden('#setup'));
  assert.ok(await page.isHidden('#snap-card'));
  const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  assert.equal(stored['zetaphy-wallet:snap:v1'], LOCAL_SNAP_ID);
  assert.equal(stored['zetaphy-wallet:seed:v1'], undefined, 'no key stored');

  // Disconnect: back to the start, the snap ID remembered for next time.
  await page.click('#snap-disconnect');
  await visible(page, '#setup');
  assert.match(await page.textContent('#status'), /disconnected/);
  assert.ok(await page.isHidden('#wallet'));
  await page.reload();
  await visible(page, '#snap-card');
  assert.equal(await page.inputValue('#snap-id'), LOCAL_SNAP_ID);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('snap: send, token send, stake and deploy are signed by the snap from the messages, then broadcast here', async () => {
  const snap = {};
  const node = { exists: true };
  const { page, context, errors, outside, sent } = await snapPage(node, snap);
  const signRequests = () => snap.requests.filter((r) => r.method === 'zetaphy_signTx');

  // Send.
  await page.fill('#to', TO);
  await page.fill('#amount', '1.25');
  await page.click('#review');
  await visible(page, '#confirm');
  assert.equal(signRequests().length, 0, 'nothing asked of the snap before the confirm');
  await page.click('#confirm-send');
  await visible(page, '#tx-result');
  assert.deepEqual(signRequests()[0], { snapId: SNAP_ID, method: 'zetaphy_signTx', params: {
    chainId: 'zetaphy_77390-1', accountNumber: '12', sequence: '4', gasLimit: '400000', gasPrice: '1200000000', memo: '', lang: 'en',
    messages: [{ type: 'send', to: TO, amount: '1250000000000000000', denom: 'azetaphy' }] } });
  let { msg, auth } = decodeSent(sent[0]);
  assert.deepEqual(MsgSend.decode(msg.value), { fromAddress: SEED_BECH32, toAddress: TO, amount: [{ denom: 'azetaphy', amount: '1250000000000000000' }] });
  assert.equal(auth.signerInfos[0].sequence, 4n);
  assert.equal(await page.textContent('#tx-hash'), createHash('sha256').update(Buffer.from(sent[0].slice(2), 'hex')).digest('hex').toUpperCase());

  // Token send.
  await page.fill('#token', TOKEN);
  await page.click('#token-load');
  await visible(page, '#token-info');
  await page.fill('#token-to', TO);
  await page.fill('#token-amount', '2.5');
  await page.click('#token-review');
  await visible(page, '#token-confirm');
  await page.click('#confirm-token');
  await visible(page, '#token-result');
  const transferData = '0xa9059cbb' + word('0x1111111111111111111111111111111111111111') + word(2_500_000);
  assert.deepEqual(signRequests()[1].params.messages, [{ type: 'evmCall', to: TOKEN, data: transferData, value: '0', gasLimit: '200000' }]);
  assert.equal(signRequests()[1].params.gasLimit, '600000');
  ({ msg } = decodeSent(sent[1]));
  assert.equal('0x' + Buffer.from(decodeMsgEVMCall(msg.value).data).toString('hex'), transferData);

  // Stake.
  await page.fill('#validator', VALOPER);
  await page.fill('#stake-amount', '3');
  await page.click('#stake');
  await visible(page, '#stake-confirm');
  await page.click('#confirm-stake');
  await visible(page, '#stake-result');
  assert.deepEqual(signRequests()[2].params.messages, [{ type: 'delegate', validator: VALOPER, amount: '3000000000000000000', denom: 'azetaphy' }]);
  ({ msg } = decodeSent(sent[2]));
  assert.deepEqual(MsgDelegate.decode(msg.value), { delegatorAddress: SEED_BECH32, validatorAddress: VALOPER, amount: { denom: 'azetaphy', amount: '3000000000000000000' } });

  // Deploy.
  await page.fill('#init-code', INIT_CODE);
  await page.click('#deploy-review');
  await visible(page, '#deploy-confirm');
  await page.click('#confirm-deploy');
  await visible(page, '#deploy-result');
  assert.deepEqual(signRequests()[3].params.messages, [{ type: 'evmDeploy', initCode: INIT_CODE, value: '0', gasLimit: '3000000' }]);
  ({ msg } = decodeSent(sent[3]));
  assert.equal(decodeMsgEVMCall(msg.value).to, '');
  assert.equal(await page.textContent('#deploy-address'), createAddress(SEED_HEX_ADDR, 5n));

  // Only messages went to the snap, never bytes; Thai follows the page language.
  assert.ok(signRequests().every((r) => !JSON.stringify(r.params).match(/bodyBytes|authInfo|signDoc/)));
  await setLang(page, 'th');
  await page.fill('#amount', '1');
  await page.click('#review');
  await visible(page, '#confirm');
  await page.click('#confirm-send');
  await visible(page, '#tx-result');
  assert.equal(signRequests()[4].params.lang, 'th');
  assert.equal(sent.length, 5);
  // The snap describes only English and Thai: other page languages ask it for English.
  await setLang(page, 'ja');
  await page.fill('#amount', '1');
  await page.click('#review');
  await visible(page, '#confirm');
  await page.click('#confirm-send');
  await visible(page, '#tx-result');
  assert.equal(signRequests()[5].params.lang, 'en');
  assert.equal(sent.length, 6);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('snap: rejected in MetaMask, or a snap that signs something else: nothing is broadcast', async () => {
  const snap = {};
  const { page, context, errors, sent } = await snapPage({ exists: true }, snap);
  snap.approve = false;
  await page.fill('#to', TO);
  await page.fill('#amount', '1');
  await page.click('#review');
  await visible(page, '#confirm');
  await page.click('#confirm-send');
  await statusMatches(page, /Rejected in MetaMask\. Nothing was signed or sent/);
  assert.ok(await page.isHidden('#tx-result'));

  // A snap that signs twice the amount: the tx it returns is not the one asked for.
  snap.approve = true;
  snap.tamper = (i) => ({ ...i, amount: String(BigInt(i.amount) * 2n) });
  await page.click('#review');
  await visible(page, '#confirm');
  await page.click('#confirm-send');
  await statusMatches(page, /signed a different transaction than the one asked for/);
  assert.equal(sent.length, 0, 'nothing broadcast');
  assert.equal(snap.requests.filter((r) => r.method === 'zetaphy_signTx').length, 2);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- other wallets: EIP-6963 discovery, add the network (EIP-3085), Keplr / Leap / Cosmostation, WalletConnect ----

const WALLETS_DIR = new URL('../../zetaphy-chain/wallets/', import.meta.url);
const RPC_HOST = new URL(RPC).host; // rpc.zetaphy.test:8545
/** A zetaphy-chain/wallets template with this test's node as HOST. */
const template = (name) => JSON.parse(readFileSync(new URL(name, WALLETS_DIR), 'utf8').replaceAll('HOST', RPC_HOST));
const svgIcon = (fill) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="${fill}"/></svg>`).toString('base64');
const RABBY = { id: 'rabby', uuid: '6b1f3a9e-0000-4000-8000-000000000001', name: 'Fake Rabby', rdns: 'io.rabby', icon: svgIcon('blue') };
// A name with a bidi override, and an icon that is a URL: neither may reach the page as such.
const TRUST = { id: 'trust', uuid: '6b1f3a9e-0000-4000-8000-000000000002', name: 'Fake Trust‮', rdns: 'com.trustwallet.app', icon: 'https://evil.example/trust.png' };
const PHANTOM = { id: 'phantom', uuid: '6b1f3a9e-0000-4000-8000-000000000003', name: 'Phantom', rdns: 'app.phantom', icon: svgIcon('purple') };
const walletCalls = (page, id) => page.evaluate((w) => window.__w.filter((c) => c.wallet === w).map(({ method, params }) => ({ method, params })), id);
const walletNames = (page) => page.$$eval('#evm-wallets button > span:last-child', (s) => s.map((x) => x.textContent));
const pickedName = (page) => page.textContent('#evm-wallets button.on > span:last-child');

test('wallet config files and the page build the same network settings', async () => {
  const w = await import('../wallets.js');
  const ep = w.nodeEndpoints(RPC);
  assert.deepEqual(ep, { evm: 'https://rpc.zetaphy.test:8545', host: 'https://rpc.zetaphy.test:8545', rpc: 'https://rpc.zetaphy.test:8545/rpc', rest: 'https://rpc.zetaphy.test:8545/rest' });
  assert.deepEqual(w.evmChainParams(ep), template('evm-add-chain.template.json'));
  assert.deepEqual(w.keplrChainInfo(ep), template('keplr-chain-info.template.json'));
  assert.deepEqual(w.nodeEndpoints('http://localhost:8545/').rpc, 'http://localhost:8545/rpc', 'http is fine on localhost');
  assert.throws(() => w.nodeEndpoints('http://203.0.113.5:8545'), /chainNeedHttps/, 'wallets refuse http RPC URLs');
  assert.throws(() => w.nodeEndpoints('ftp://x'), /badRpc/);
  // MetaMask (wallet_addEthereumChain) and ethereum-lists both refuse a symbol of 7+ characters.
  const evmList = JSON.parse(readFileSync(new URL('ethereum-lists/eip155-77390.json', WALLETS_DIR), 'utf8'));
  assert.ok(w.EVM_SYMBOL.length <= 6);
  assert.deepEqual(evmList.nativeCurrency, w.evmChainParams(ep).nativeCurrency);
  assert.equal(evmList.chainId, 77390);
  assert.equal(evmList.networkId, 77390);
  assert.deepEqual(evmList.rpc, ['https://HOST']);
  assert.deepEqual(Object.keys(w.evmChainParams(ep)).sort(), ['chainId', 'chainName', 'nativeCurrency', 'rpcUrls'], 'MetaMask refuses any other key');
  const chain = JSON.parse(readFileSync(new URL('chain-registry/zetaphytestnet/chain.json', WALLETS_DIR), 'utf8'));
  const assets = JSON.parse(readFileSync(new URL('chain-registry/zetaphytestnet/assetlist.json', WALLETS_DIR), 'utf8'));
  assert.equal(chain.chain_id, w.CHAIN_ID);
  assert.equal(chain.slip44, 60);
  assert.equal(chain.bech32_prefix, w.BECH32.bech32PrefixAccAddr);
  const fee = chain.fees.fee_tokens[0];
  assert.deepEqual([fee.denom, fee.low_gas_price, fee.average_gas_price, fee.high_gas_price], [w.DENOM, w.GAS_PRICE_STEP.low, w.GAS_PRICE_STEP.average, w.GAS_PRICE_STEP.high]);
  assert.equal(assets.assets[0].base, w.DENOM);
  assert.equal(assets.assets[0].denom_units.find((u) => u.denom === assets.assets[0].display).exponent, w.DECIMALS);
  // Icons: data:image/… only.
  assert.equal(w.safeIcon(RABBY.icon), RABBY.icon);
  for (const bad of [TRUST.icon, 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,AA" onerror="x', 42]) assert.equal(w.safeIcon(bad), null);
  assert.equal(w.cleanName(TRUST.name), 'Fake Trust');
  assert.equal(w.kindOf({ rdns: 'com.binance.wallet' }), 'binance');
  assert.equal(w.kindOf({ name: 'Binance Web3 Wallet', rdns: 'com.example' }), 'binance');
  assert.equal(w.kindOf({ rdns: 'app.phantom' }), 'phantom');
  assert.equal(w.kindOf({ rdns: 'com.trustwallet.app' }), 'trust');
});

test('EIP-6963: two wallets announce themselves; the one picked is offered ZETAPHY (EIP-3085) and connected', async () => {
  const { page, context, errors, outside } = await openPage({}, { wallets: { eip6963: [RABBY, TRUST] } });
  await setLang(page, 'en');
  await page.waitForFunction(() => document.querySelectorAll('#evm-wallets button').length === 2);
  assert.deepEqual(await walletNames(page), ['Fake Rabby', 'Fake Trust'], 'names as plain text, bidi override dropped');
  assert.deepEqual(await page.$$eval('#evm-wallets img', (i) => i.map((x) => x.getAttribute('src'))), [RABBY.icon], 'only the data:image icon is shown');
  assert.equal(await page.textContent('#evm-wallets button:not(:has(img)) .wallet-icon'), 'F', 'a letter instead of the URL icon');
  assert.ok(await page.isHidden('#evm-none'));
  assert.equal(await pickedName(page), 'Fake Rabby', 'no MetaMask here: the first one');

  // The network's values come from the RPC setting, which must be https.
  await page.click('#evm-add');
  await statusMatches(page, /Enter your node RPC URL first/);
  await page.fill('#rpc', 'http://203.0.113.5:8545');
  await page.click('#evm-add');
  await statusMatches(page, /Wallets take only an https RPC URL/);
  assert.equal(await page.textContent('#m-rpc'), '(enter an https RPC URL above first)');
  await page.fill('#rpc', RPC);
  await page.click('#rpc-save');
  await page.click('#manual summary');
  assert.equal(await page.textContent('#m-name'), 'ZETAPHY Testnet');
  assert.equal(await page.textContent('#m-rpc'), 'https://rpc.zetaphy.test:8545');
  assert.equal(await page.textContent('#m-chain'), '77390 (0x12e4e)');
  assert.equal(await page.textContent('#m-symbol'), 'ZTPHY');
  assert.equal(await page.textContent('#m-decimals'), '18');
  assert.match(await page.textContent('#m-symbol-note'), /ZTPHY is ZETAPHY.*at most 6 letters.*0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE/);

  // Pick the second one: only it is asked.
  await page.click('#evm-wallets button:has-text("Fake Trust")');
  assert.equal(await pickedName(page), 'Fake Trust');
  await statusMatches(page, /Fake Trust picked/);
  assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy-wallet:evm-wallet')), '6963:com.trustwallet.app');
  await page.click('#evm-add');
  await statusMatches(page, /ZETAPHY Testnet added to Fake Trust and selected/);
  const params = template('evm-add-chain.template.json');
  assert.deepEqual(params, { chainId: '0x12e4e', chainName: 'ZETAPHY Testnet', nativeCurrency: { name: 'ZETAPHY', symbol: 'ZTPHY', decimals: 18 }, rpcUrls: ['https://rpc.zetaphy.test:8545'] });
  assert.deepEqual(await walletCalls(page, 'trust'), [
    { method: 'wallet_addEthereumChain', params: [params] },
    { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x12e4e' }] },
  ]);
  assert.deepEqual(await walletCalls(page, 'rabby'), [], 'the other wallet is not asked');

  // Rejected in the wallet: said so, not a "network refused" error.
  await page.evaluate(() => { window.__wCfg.trust.fail = { wallet_addEthereumChain: { code: 4001, message: 'User rejected the request.' } }; });
  await page.click('#evm-add');
  await statusMatches(page, /Cancelled in the wallet/);
  await page.evaluate(() => { window.__wCfg.trust.fail = {}; window.__wCfg.trust.chainId = '0x12e4e'; });

  // Connect: the wallet's account in both forms, the chain it is on, its balance from the node.
  await page.click('#evm-connect');
  await visible(page, '#evm-account');
  assert.equal(await page.textContent('#evm-wallet-name'), 'Fake Trust');
  assert.equal(await page.textContent('#evm-addr-hex'), OWNER);
  assert.equal(await page.textContent('#evm-addr-bech32'), OWNER_BECH32);
  await page.waitForFunction(() => /Balance 10 ZETAPHY/.test(document.getElementById('evm-chain').textContent));
  assert.match(await page.textContent('#evm-chain'), /^On ZETAPHY Testnet\./);

  // The Snap needs MetaMask: wallet_getSnaps tells a wallet without snaps, before anything is installed.
  assert.equal(await page.textContent('#snap-card .using-text'), 'Wallet used: Fake Trust');
  await page.click('#snap-connect');
  await statusMatches(page, /Fake Trust cannot run MetaMask Snaps/);
  assert.deepEqual((await walletCalls(page, 'trust')).map((c) => c.method).filter((m) => m.startsWith('wallet_') && m !== 'wallet_addEthereumChain' && m !== 'wallet_switchEthereumChain'), ['wallet_getSnaps']);

  // The pick is remembered; Thai follows the language switch.
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#evm-wallets button').length === 2);
  assert.equal(await pickedName(page), 'Fake Trust');
  await setLang(page, 'th');
  assert.equal(await page.textContent('#evm-add'), 'เพิ่ม ZETAPHY ในกระเป๋านี้');
  assert.equal(await page.textContent('#snap-card .using-text'), 'กระเป๋าที่ใช้: Fake Trust');
  assert.deepEqual(outside, [], 'the URL icon was never loaded');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Binance Wallet (window.binancew3w.ethereum): add-chain works, and a 4200 refusal is explained with the manual values', async () => {
  const { page, context, errors, outside } = await openPage({}, { wallets: { binancew3w: true } });
  await setLang(page, 'en');
  await page.fill('#rpc', RPC);
  await page.click('#rpc-save');
  assert.deepEqual(await walletNames(page), ['Binance Wallet']);
  assert.equal(await pickedName(page), 'Binance Wallet');
  assert.match(await page.textContent('#evm-note'), /Binance Wallet may not accept new networks yet/);
  await page.click('#evm-add');
  await statusMatches(page, /ZETAPHY Testnet added to Binance Wallet and selected/);
  assert.deepEqual((await walletCalls(page, 'binancew3w'))[0], { method: 'wallet_addEthereumChain', params: [template('evm-add-chain.template.json')] });

  // The wallet does not support adding networks.
  await page.evaluate(() => { window.__wCfg.binancew3w.fail = { wallet_addEthereumChain: { code: 4200, message: 'The requested method is not supported' } }; });
  assert.equal(await page.$eval('#manual', (d) => d.open), false);
  await page.click('#evm-add');
  await statusMatches(page, /Binance Wallet did not add the network \(The requested method is not supported\)\. It may not accept new networks yet: type the values below/);
  assert.ok(await page.isVisible('#status.error'));
  assert.equal(await page.$eval('#manual', (d) => d.open), true, 'the manual values are opened');
  assert.ok(await page.isVisible('#m-rpc'));
  assert.equal((await walletCalls(page, 'binancew3w')).filter((c) => c.method === 'wallet_switchEthereumChain').length, 1, 'no switch after the refusal');
  await setLang(page, 'th');
  assert.match(await page.textContent('#status'), /Binance Wallet ไม่ได้เพิ่มเครือข่าย .*อาจยังไม่รับเครือข่ายใหม่/);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Phantom: listed, warned before anything is asked, and its refusal to add the network is explained', async () => {
  const { page, context, errors } = await openPage({}, { wallets: { eip6963: [PHANTOM], state: { phantom: { fail: { wallet_addEthereumChain: { code: 4200, message: 'Unsupported network' } } } } } });
  await setLang(page, 'en');
  await page.fill('#rpc', RPC);
  await page.waitForFunction(() => document.querySelectorAll('#evm-wallets button').length === 1);
  assert.deepEqual(await walletNames(page), ['Phantom']);
  assert.ok(await page.isVisible('#evm-note'));
  assert.match(await page.textContent('#evm-note'), /Phantom does not let anyone add networks.*Use another wallet/);
  assert.deepEqual(await walletCalls(page, 'phantom'), [], 'nothing asked yet');
  await page.click('#evm-add');
  await statusMatches(page, /Phantom did not add the network \(Unsupported network\)\. It may not accept new networks yet/);
  assert.deepEqual((await walletCalls(page, 'phantom')).map((c) => c.method), ['wallet_addEthereumChain']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Keplr, Leap, Cosmostation: experimentalSuggestChain gets the chain info, then the zetaphy1 address is shown', async () => {
  const { page, context, errors, outside } = await openPage({}, { wallets: { keplrLike: ['keplr'], cosmostation: true } });
  await setLang(page, 'en');
  await page.click('#keplr-add');
  await statusMatches(page, /Enter your node RPC URL first/);
  await page.fill('#rpc', RPC);
  await page.click('#keplr-add');
  await statusMatches(page, /ZETAPHY Testnet added to Keplr/);
  const info = template('keplr-chain-info.template.json');
  assert.deepEqual(await walletCalls(page, 'keplr'), [
    { method: 'experimentalSuggestChain', params: info },
    { method: 'enable', params: 'zetaphy_77390-1' },
    { method: 'getKey', params: 'zetaphy_77390-1' },
  ]);
  assert.equal(info.rpc, 'https://rpc.zetaphy.test:8545/rpc');
  assert.equal(info.rest, 'https://rpc.zetaphy.test:8545/rest');
  assert.deepEqual(info.evm, { chainId: 77390, rpc: 'https://rpc.zetaphy.test:8545' });
  assert.deepEqual(info.bip44, { coinType: 60 });
  assert.deepEqual(info.feeCurrencies[0].gasPriceStep, { low: 1e9, average: 2e9, high: 4e9 });
  assert.deepEqual(info.features, ['eth-address-gen', 'eth-key-sign', 'eth-secp256k1-cosmos', 'force-enable-evm-ledger']);
  await visible(page, '#cosmos-account');
  assert.equal(await page.textContent('#cosmos-wallet-name'), 'Keplr');
  assert.equal(await page.textContent('#cosmos-addr'), OWNER_BECH32);
  assert.equal(await page.textContent('#cosmos-hex'), OWNER);

  await page.click('#leap-add');
  await statusMatches(page, /Leap was not found in this browser/);
  await page.click('#cosmostation-add');
  await statusMatches(page, /ZETAPHY Testnet added to Cosmostation/);
  assert.deepEqual((await walletCalls(page, 'cosmostation'))[0], { method: 'experimentalSuggestChain', params: info });

  // Refused in Keplr, or an address that is not zetaphy1….
  await page.evaluate(() => { window.__wCfg.keplr.fail = { suggest: 'Request rejected' }; });
  await page.click('#keplr-add');
  await statusMatches(page, /Keplr did not add the network \(Request rejected\)/);
  await page.evaluate(() => { window.__wCfg.keplr = { address: 'cosmos1g3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyn8nxu5' }; });
  await page.click('#keplr-add');
  await statusMatches(page, /not zetaphy1/);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('WalletConnect stays off without a Reown projectId', async () => {
  const { page, context, errors, outside } = await openPage();
  await setLang(page, 'en');
  assert.equal(await page.getAttribute('meta[name="zetaphy-walletconnect-project-id"]', 'content'), '');
  assert.ok(await page.isDisabled('#wc-connect'));
  assert.match(await page.textContent('#wc-hint'), /is off: it needs a Reown projectId/);
  assert.ok(await page.isVisible('#evm-none'), 'no EVM wallet in this browser');
  await page.click('#wallets-card details:last-of-type summary');
  await page.fill('#wc-id', 'not-a-project-id');
  await page.click('#wc-save');
  await statusMatches(page, /must be 32 hex digits/);
  assert.ok(await page.isDisabled('#wc-connect'));

  // With one it turns on; the SDK is not bundled yet, and the page says so.
  await page.fill('#wc-id', '0123456789abcdef0123456789abcdef');
  await page.click('#wc-save');
  assert.ok(await page.isEnabled('#wc-connect'));
  await page.click('#wc-connect');
  await statusMatches(page, /does not include WalletConnect yet \(it is the next step\)/);
  await page.reload();
  assert.ok(await page.isEnabled('#wc-connect'), 'remembered');
  await page.click('#wallets-card details:last-of-type summary');
  await page.fill('#wc-id', '');
  await page.click('#wc-save');
  assert.ok(await page.isDisabled('#wc-connect'));
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- vaccine: the page refuses to sign calls or transfers to code flagged in the ThreatRegistry ----
async function setRegistry(page, address) {
  await page.locator('details:has(#threat-registry) > summary').click();
  await page.fill('#threat-registry', address);
  await page.click('#threat-save');
  await statusMatches(page, /ThreatRegistry address saved/);
}
async function tokenTransferReview(page) {
  await page.fill('#token', TOKEN);
  await page.fill('#token-to', TO);
  await page.fill('#token-amount', '1');
  await page.click('#token-review');
}

test('vaccine: flagged code (fingerprint, code hash or address) is refused before signing; clean code goes through', async () => {
  const fp = '0x' + (await codeFingerprint(TOKEN_CODE)).slice(4);
  const codeHash = '0x' + Buffer.from(keccak_256(Buffer.from(TOKEN_CODE.slice(2), 'hex'))).toString('hex');
  const node = { exists: true, registry: REGISTRY, flags: { fingerprint: [fp], code: [], address: [], reason: 1 } };
  const { page, context, errors, outside, sent, calls } = await importedPage(node);
  await setRegistry(page, REGISTRY);
  assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy-wallet:threat-registry')), REGISTRY);

  // Same template as flagged code anywhere (Neuro's fp1 fingerprint): refused, with the reason.
  await tokenTransferReview(page);
  await statusMatches(page, /Not signed: 0x3333.* is flagged by the ZETAPHY immune system \(its code fingerprint \(fp1\) matches flagged code · reason: in a simulated trade, buying worked but selling failed or returned almost nothing\)/);
  assert.ok(await page.isHidden('#token-confirm'));
  // The exact code (keccak-256 code hash), or the address itself: refused too.
  node.flags = { fingerprint: [], code: [codeHash], address: [], reason: 2 };
  await page.click('#token-review');
  await statusMatches(page, /is flagged .*its code is byte-for-byte flagged code · reason: an address can mint new tokens without a cap/);
  node.flags = { fingerprint: [], code: [], address: [TOKEN], reason: 5 };
  await page.fill('#to', TOKEN);
  await page.fill('#amount', '1');
  await page.click('#review'); // a plain ZETAPHY send to the flagged contract
  await statusMatches(page, /is flagged .*this address is flagged · reason: uses the same name or symbol as a known token at a different address/);
  assert.ok(await page.isHidden('#confirm'));

  // What the page asked the registry: fp1 hash, keccak-256 of the code, (77390, address).
  const asked = calls.filter((c) => c.to.toLowerCase() === REGISTRY).map((c) => c.data);
  for (const i of [0, 1]) { // the warning view and the enforcement view
    assert.ok(asked.includes('0x' + REG_SEL.fingerprint[i] + fp.slice(2)));
    assert.ok(asked.includes('0x' + REG_SEL.code[i] + codeHash.slice(2)));
    assert.ok(asked.includes('0x' + REG_SEL.address[i] + word(77390) + word(TOKEN)));
  }

  // Not flagged: it goes through, and the confirm box says it was checked.
  node.flags = { fingerprint: [], code: [], address: [] };
  await page.click('#token-review');
  await visible(page, '#token-confirm');
  assert.match(await page.textContent('#token-confirm .vaccine-note'), /Checked against the ThreatRegistry: the destination is not flagged/);
  // A flag that lands between review and confirm still stops it: checked again before signing.
  node.flags = { fingerprint: [fp], code: [], address: [], reason: 1 };
  await page.click('#confirm-token');
  await statusMatches(page, /Not signed: .* is flagged/);
  assert.equal(sent.length, 0, 'nothing broadcast while flagged');
  node.flags = { fingerprint: [], code: [], address: [] };
  await page.click('#token-review');
  await visible(page, '#token-confirm');
  await page.click('#confirm-token');
  await visible(page, '#token-result');
  assert.equal(sent.length, 1);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('vaccine: registry set but unreachable refuses (fail closed); no registry set sends with a visible "not checked" notice', async () => {
  const node = { exists: true, registry: REGISTRY, registryDown: true };
  const { page, context, errors, sent } = await importedPage(node);
  // No registry configured: the transfer is allowed, and the confirm box says the code was NOT checked.
  await tokenTransferReview(page);
  await visible(page, '#token-confirm');
  assert.match(await page.textContent('#token-confirm .vaccine-note'), /Destination code NOT checked: no ThreatRegistry address is set/);
  assert.ok(await page.$eval('#token-confirm .vaccine-note', (el) => el.classList.contains('unchecked')));
  // A plain send to an account with no code needs no notice.
  await page.fill('#to', TO);
  await page.fill('#amount', '1');
  await page.click('#review');
  await visible(page, '#confirm');
  assert.ok(await page.isHidden('#confirm .vaccine-note'));
  // Registry set but it does not answer: nothing is signed.
  await setRegistry(page, REGISTRY);
  await tokenTransferReview(page);
  await statusMatches(page, /Not signed: 0x3333.* could not be checked against the ThreatRegistry 0x7777/);
  assert.ok(await page.isHidden('#token-confirm'));
  await page.fill('#threat-registry', '0x1234');
  await page.click('#threat-save');
  await statusMatches(page, /must be 0x and 40 hex digits/);
  assert.equal(sent.length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('vaccine (Thai, snap): a flagged destination is refused before the snap is asked to sign', async () => {
  const snap = {};
  const node = { exists: true, registry: REGISTRY, flags: { fingerprint: [], code: [], address: [TOKEN], reason: 1 } };
  const { page, context, errors, sent } = await openPage(node, { snap, ethereum: { snaps: true } });
  await visible(page, '#snap-card');
  await page.click('#snap-connect');
  await visible(page, '#wallet');
  await page.fill('#rpc', RPC);
  await page.click('#rpc-save');
  await page.waitForFunction(() => document.getElementById('balance').textContent.includes('ZETAPHY'));
  await setRegistryThai(page);
  await page.fill('#to', TOKEN);
  await page.fill('#amount', '1');
  await page.click('#review');
  await statusMatches(page, /ไม่เซ็น: 0x3333.* ติดธงในระบบภูมิคุ้มกันของ ZETAPHY \(ที่อยู่นี้ติดธง · เหตุผล: ในการจำลองซื้อขาย ซื้อได้ แต่ขายไม่ได้หรือได้เงินคืนน้อยมาก\) .*ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา/);
  assert.ok(!snap.requests.some((r) => r.method === 'zetaphy_signTx'), 'the snap was never asked to sign');
  node.flags = { fingerprint: [], code: [], address: [] };
  await page.click('#review');
  await visible(page, '#confirm');
  await page.click('#confirm-send');
  await visible(page, '#tx-result');
  assert.ok(snap.requests.some((r) => r.method === 'zetaphy_signTx'));
  assert.equal(sent.length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('vaccine (best effort): a clean proxy in front of flagged code is refused (EIP-1167, EIP-1967 implementation, EIP-1967 beacon)', async () => {
  const IMPL = '0x4444444444444444444444444444444444444444';
  const BEACON = '0x5555555555555555555555555555555555555555';
  const IMPL_CODE = '0x60806040aa';
  const implHash = '0x' + Buffer.from(keccak_256(Buffer.from(IMPL_CODE.slice(2), 'hex'))).toString('hex');
  // The keccak of the slot names, minus one (EIP-1967).
  const slot = (n) => '0x' + (BigInt('0x' + Buffer.from(keccak_256(Buffer.from(n))).toString('hex')) - 1n).toString(16).padStart(64, '0');
  assert.equal(slot('eip1967.proxy.implementation'), SLOT_IMPL);
  assert.equal(slot('eip1967.proxy.beacon'), SLOT_BEACON);
  const node = { exists: true, registry: REGISTRY, flags: { fingerprint: [], code: [implHash], address: [], reason: 1 }, codes: { [IMPL]: IMPL_CODE, [BEACON]: '0x6080' } };
  const { page, context, errors, sent } = await importedPage(node);
  await setRegistry(page, REGISTRY);
  // EIP-1167: the token is a fresh minimal proxy (clean code hash) whose target is the flagged code.
  node.codes[TOKEN] = '0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3';
  await tokenTransferReview(page);
  await statusMatches(page, /Not signed: 0x4444.* \(the code behind proxy 0x3333.*\) is flagged .*byte-for-byte flagged code/);
  // EIP-1967 implementation slot.
  node.codes[TOKEN] = TOKEN_CODE;
  node.storage = { [TOKEN]: { [SLOT_IMPL]: IMPL } };
  await page.click('#token-review');
  await statusMatches(page, /Not signed: 0x4444.* \(the code behind proxy 0x3333.*\) is flagged/);
  // EIP-1967 beacon: the beacon's implementation() is the flagged code.
  node.storage = { [TOKEN]: { [SLOT_BEACON]: BEACON } };
  node.beacons = { [BEACON]: IMPL };
  await page.click('#token-review');
  await statusMatches(page, /Not signed: 0x4444.* \(the code behind proxy 0x3333.*\) is flagged/);
  assert.ok(await page.isHidden('#token-confirm'));
  // The same proxy in front of clean code goes through.
  node.flags = { fingerprint: [], code: [], address: [] };
  await page.click('#token-review');
  await visible(page, '#token-confirm');
  assert.match(await page.textContent('#token-confirm .vaccine-note'), /best effort.*EIP-1967.*EIP-1167 proxy/);
  await page.click('#confirm-token');
  await visible(page, '#token-result');
  assert.equal(sent.length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('vaccine: a flag not enforced yet is a warning (sending is the user\'s choice); a new one after review stops the signing; enforced refuses', async () => {
  const node = { exists: true, registry: REGISTRY, flags: { fingerprint: [], code: [], address: [TOKEN], reason: 5, warnOnly: true } };
  const { page, context, errors, sent } = await importedPage(node);
  await setRegistry(page, REGISTRY);
  await tokenTransferReview(page);
  await visible(page, '#token-confirm');
  assert.match(await page.textContent('#token-confirm .vaccine-note'), /Warning: 0x3333.* was flagged by Neuro runners \(this address is flagged · reason: uses the same name or symbol as a known token at a different address\), but the flag is not enforced yet.*Automated code analysis, not an accusation/);
  assert.ok(await page.$eval('#token-confirm .vaccine-note', (el) => el.classList.contains('unchecked')));
  await page.click('#confirm-token'); // the user saw the warning and sends anyway
  await visible(page, '#token-result');
  assert.equal(sent.length, 1);
  // Reviewed clean, then a (not yet enforced) flag lands before signing: not signed, review again.
  node.flags = { fingerprint: [], code: [], address: [] };
  await tokenTransferReview(page); // the form was cleared by the send
  await visible(page, '#token-confirm');
  node.flags = { fingerprint: [], code: [], address: [TOKEN], reason: 5, warnOnly: true };
  await page.click('#confirm-token');
  await statusMatches(page, /Not signed: 0x3333.* was flagged after you reviewed this/);
  assert.equal(sent.length, 1);
  // Enforced: refused at review.
  node.flags.warnOnly = false;
  await page.click('#token-review');
  await statusMatches(page, /Not signed: 0x3333.* is flagged by the ZETAPHY immune system/);
  assert.ok(await page.isHidden('#token-confirm'));
  assert.equal(sent.length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('vaccine: a fast-lane flag (enforced at once: fastQuorum or enforceNow, inside the enforceDelay) is refused, not just warned', async () => {
  // The registry's enforcement views answer true the moment a flag goes through the fast lane;
  // the page refuses on them exactly as on a flag past its enforceDelay.
  const node = { exists: true, registry: REGISTRY, flags: { fingerprint: [], code: [], address: [TOKEN], reason: 1, warnOnly: true } };
  const { page, context, errors, sent } = await importedPage(node);
  await setRegistry(page, REGISTRY);
  await tokenTransferReview(page);
  await visible(page, '#token-confirm'); // a normal fresh flag: a warning
  assert.match(await page.textContent('#token-confirm .vaccine-note'), /not enforced yet .*fast lane is enforced at once/);
  node.flags.warnOnly = false; // runners reached fastQuorum, or governance called enforceNow
  await page.click('#token-review');
  await statusMatches(page, /Not signed: 0x3333.* is flagged by the ZETAPHY immune system \(this address is flagged · reason: in a simulated trade, buying worked but selling failed or returned almost nothing\)/);
  assert.ok(await page.isHidden('#token-confirm'));
  assert.equal(sent.length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

async function setRegistryThai(page) {
  await setLang(page, 'th');
  await page.locator('details:has(#threat-registry) > summary').click();
  await page.fill('#threat-registry', REGISTRY);
  await page.click('#threat-save');
  await statusMatches(page, /บันทึกที่อยู่ ThreatRegistry แล้ว/);
}

test('vaccine: every refusal and warning shows the code fact, its evidence (reportHash, how to reproduce), the owner\'s response and the disclaimer', async () => {
  const OWNER = '0x' + '0a'.repeat(20);
  const key = addressKey(77390n, TOKEN);
  const node = { exists: true, registry: REGISTRY, flags: { fingerprint: [], code: [], address: [TOKEN], reason: 5, warnOnly: true },
    evidence: { reportHash: REPORT, uri: 'neuro:zetaphy:0x3333' } };
  const { page, context, errors, sent, calls } = await importedPage(node);
  await setRegistry(page, REGISTRY);
  // Flagged, not enforced, no response yet: a warning with the evidence and "no response yet".
  await tokenTransferReview(page);
  await visible(page, '#token-confirm');
  let note = await page.textContent('#token-confirm .vaccine-note');
  assert.match(note, /reason: uses the same name or symbol as a known token at a different address/);
  assert.match(note, new RegExp(`Evidence: reportHash ${REPORT} \\(neuro:zetaphy:0x3333\\) · reproduce: run Neuro on the same code \\(zetaphy-neuro: node cli.js <chain> <address> --json\\) and compare the reportHash`));
  assert.match(note, /No response yet · Automated code analysis, not an accusation/);
  assert.ok(calls.some((c) => c.to.toLowerCase() === REGISTRY && c.data === '0x' + DETAIL_SEL.evidence + key.slice(2)), 'evidenceOf(the flagged key)');
  // The owner answered (bidi and newline characters are dropped): shown next to the warning, with its author;
  // a governance-assigned responder's response first.
  const GOVR = '0x' + '0b'.repeat(20);
  node.responses = { [key]: [{ text: 'assigned responder here', by: GOVR, chainId: 0 }, { text: 'pause() is for emergencies only;\u202e audit: example.org/audit\nthanks', by: OWNER }] };
  await page.click('#token-review');
  await page.waitForFunction(() => /Response from/.test(document.querySelector('#token-confirm .vaccine-note').textContent));
  note = await page.textContent('#token-confirm .vaccine-note');
  assert.ok(note.includes(`Response from the governance-assigned responder (${GOVR}): "assigned responder here" · Response from ${OWNER}: "pause() is for emergencies only; audit: example.org/audit thanks"`), note);
  // Enforced: refused, with the same evidence, response and disclaimer.
  node.flags.warnOnly = false;
  await page.click('#token-review');
  await statusMatches(page, /Not signed: 0x3333.* is flagged .*reason: uses the same name.*Evidence: reportHash 0x(e7){32}.*Response from 0x(0a){20}: "pause\(\) is for emergencies only; audit.*Automated code analysis, not an accusation/);
  // In Thai, the same status re-rendered: neutral texts, the owner's words, the disclaimer.
  await setLang(page, 'th');
  await statusMatches(page, /ไม่เซ็น: 0x3333.*เหตุผล: ใช้ชื่อหรือสัญลักษณ์เดียวกับเหรียญที่รู้จัก แต่อยู่คนละที่อยู่.*หลักฐาน: reportHash 0x(e7){32}.*ตรวจซ้ำ: รัน Neuro.*คำชี้แจงจาก 0x(0a){20}: "pause\(\) is for emergencies.*ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา/);
  for (const w of ['scam', 'drainer', 'phishing', 'honeypot', 'หลอกลวง', 'ดูดเงิน']) assert.ok(!(await page.textContent('#status')).toLowerCase().includes(w), w);
  // No evidence stored: still refused (never a send), and said so.
  node.evidence = undefined;
  await setLang(page, 'en');
  await page.click('#token-review');
  await statusMatches(page, /Not signed: .*Evidence: none stored/);
  assert.equal(sent.length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- security core: prepare for Q-day (commit–reveal from MetaMask) and the threat gate's consent ----
test('Q-day card: status, the MetaMask account checked, commit then reveal with a signature made only in MetaMask; consent card', async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { qdayRevealText, qdayCommitment, qdaySalt, consentCall, hexToBytes: h2b } = await import('../vendor/pqwallet.js');
  const key = new Uint8Array(32).fill(7);
  const pub = secp256k1.getPublicKey(key, false);
  const owner = '0x' + bytesToHex(keccak_256(pub.slice(1)).slice(12));
  const text = qdayRevealText({ owner, controller: SEED_HEX_ADDR });
  const msg = new TextEncoder().encode(text);
  const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const rs = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' });
  const sig = new Uint8Array(65); sig.set(rs.slice(1), 0); sig[64] = rs[0] + 27;
  const salt = qdaySalt(sig);
  const commitment = qdayCommitment({ publicKey: secp256k1.getPublicKey(key, true), controller: SEED_HEX_ADDR, salt });
  const node = { exists: true, security: { qdayHeight: '500', latestHeight: '100' }, migration: {}, commitments: {}, consents: {} };
  const { page, context, errors, outside, sent } = await importedPage(node, { ethereum: { account: owner, chainId: '0x12e4e', personalSign: '0x' + bytesToHex(sig) } });

  await page.click('#qd-check');
  await page.waitForFunction(() => !document.getElementById('qd-result').hidden);
  assert.match(await page.textContent('#qd-status'), /Q-day: block 500 \(now 100\)/);
  assert.match(await page.textContent('#qd-result'), /never used on chain/);
  assert.ok(!(await page.isHidden('#qd-recover')), 'the commit–reveal steps are offered');
  // the signing warning names the account, the controller it is handed to, and the official wallet
  const warn = await page.textContent('#qd-recover-warn');
  assert.match(warn, /gives full control of/);
  assert.match(warn, new RegExp(`${SEED_HEX_ADDR}[\\s\\S]*${SEED_HEX_ADDR}`, 'i'), 'the controller, twice');
  assert.match(warn, /only in the official ZETAPHY wallet/);

  // Step 1: MetaMask signs the text (personal_sign, nothing sent from it); this wallet sends the commitment.
  await page.click('#qd-commit');
  await statusMatches(page, /Commitment recorded/);
  const ps = await page.evaluate(() => window.__eth.filter((c) => c.method === 'personal_sign').at(-1).params);
  assert.equal(new TextDecoder().decode(h2b(ps[0])), text);
  assert.ok(!(await ethCalls(page)).includes('eth_sendTransaction'), 'the old key sends nothing');
  const c1 = decodeSent(sent.at(-1)).msg;
  assert.equal(c1.typeUrl, '/zetaphy.pq.v1.MsgQDayCommit');
  assert.ok(Buffer.from(c1.value).toString('hex').endsWith(bytesToHex(commitment)), 'the commitment of this owner, this wallet and the salt');

  // Step 2 before Q-day: refused before anything is signed.
  const n = sent.length;
  await page.click('#qd-reveal');
  await statusMatches(page, /opens at Q-day/);
  assert.equal(sent.length, n);
  // After Q-day, once the commitment is old enough.
  Object.assign(node.security, { qdayActive: true, latestHeight: '600' });
  node.commitments['0x' + bytesToHex(commitment)] = { found: true, height: '120' };
  await page.click('#qd-reveal');
  await statusMatches(page, /Revealed/);
  const r = decodeSent(sent.at(-1)).msg;
  assert.equal(r.typeUrl, '/zetaphy.pq.v1.MsgQDayReveal');
  const rv = Buffer.from(r.value).toString('hex');
  assert.ok(rv.includes(bytesToHex(salt)) && rv.includes(bytesToHex(sig)), 'salt and signature');

  // Consent: from this wallet (MsgEVMCall to 0x…0901) and from MetaMask (an EVM tx).
  const target = '0x00000000000000000000000000000000005Ca400';
  await page.fill('#cs-target', target);
  assert.ok(await page.isDisabled('#cs-send'), 'needs the risk ticked');
  await page.check('#cs-ok');
  await page.click('#cs-send');
  await visible(page, '#cs-result');
  const m = decodeMsgEVMCall(decodeSent(sent.at(-1)).msg.value);
  assert.equal(m.to, '0x0000000000000000000000000000000000000901');
  assert.equal('0x' + bytesToHex(m.data), '0x' + bytesToHex(consentCall(target, 3600).data));
  await page.check('#cs-ok');
  await page.click('#cs-send-mm');
  await statusMatches(page, /Consent sent/);
  const tx = await page.evaluate(() => window.__eth.filter((c) => c.method === 'eth_sendTransaction').at(-1).params[0]);
  assert.equal(tx.to, '0x0000000000000000000000000000000000000901');
  assert.equal(tx.data, '0x' + bytesToHex(consentCall(target, 3600).data));

  await setLang(page, 'th');
  assert.equal(await page.textContent('#qday-card h2'), 'เตรียมพร้อมสำหรับ Q-day');
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('vaccine + consent: an enforced flag is refused (and the consent card is filled in); with consent on chain it is a warning and can be sent', async () => {
  const node = { exists: true, registry: REGISTRY, flags: { fingerprint: [], code: [], address: [TOKEN], reason: 6 }, consents: {} };
  const { page, context, errors, sent } = await importedPage(node);
  await setRegistry(page, REGISTRY);
  await tokenTransferReview(page);
  await statusMatches(page, /Not signed: .* is flagged .*unless you consent first/);
  assert.equal((await page.inputValue('#cs-target')).toLowerCase(), TOKEN, 'the consent card is filled in');
  node.consents[`${SEED_HEX_ADDR}|${TOKEN}`.toLowerCase()] = Math.floor(Date.now() / 1000) + 3600;
  await page.click('#token-review');
  await visible(page, '#token-confirm');
  assert.match(await page.textContent('#token-confirm .vaccine-note'), /has an enforced flag .* but you consented/);
  await page.click('#confirm-token');
  await visible(page, '#token-result');
  assert.equal(sent.length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});
