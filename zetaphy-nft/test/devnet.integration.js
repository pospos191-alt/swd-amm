// End to end on a REAL ZETAPHY chain (zetaphyd, 1 s blocks, started with
// zetaphy-network/scripts/devnet.sh): the CLI deploys the factory and the
// marketplace and writes the deployments JSON; a creator makes ERC-721 and
// ERC-1155 collections, mints and lists; a buyer buys (fee and royalty to the
// wei); the seller withdraws; a stale listing and the ThreatRegistry refusal;
// then the web app, served with its CSP, finds the listing from the node's
// eth_getLogs and buys through a wallet that signs real transactions.
// Not part of `npm test` (needs the zetaphyd binary):
//   flock /tmp/ci-test/devnet.lock env ZETAPHYD=/path/to/zetaphyd PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:devnet
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, ContractFactory, NonceManager, ZeroAddress, keccak256 } from 'ethers';
import { chromium } from 'playwright-core';
import { mockArtifacts } from './helpers/chain.js';

const PORT = Number(process.env.DEVNET_PORT ?? 25545);
const RPC = `http://127.0.0.1:${PORT}`;
const WEB_PORT = PORT + 9;
const PUBLIC_RPC = 'https://devnet-rpc.zetaphy.test/'; // the page's RPC; proxied to the node (as the testnet's Caddy does, with CORS)
const root = mkdtempSync(join(tmpdir(), 'zetaphy-nft-devnet-'));
const actors = Object.fromEntries(['deployer', 'creator', 'buyer'].map((n) => [n, Wallet.createRandom()]));
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ZETA = 10n ** 18n;
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
let provider, dep, server, browser;

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args], { env, timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}
// One NonceManager per actor: the node can answer the pending nonce late right after a receipt.
const signers = {};
const signer = (n) => (signers[n] ??= new NonceManager(actors[n].connect(provider)));
const C = (address, name, who) => new Contract(address, art(name).abi, who ? signer(who) : provider);
const errorName = (e, iface) => { const d = e?.data ?? e?.info?.error?.data ?? e?.error?.data; try { return iface.parseError(d)?.name; } catch { return String(e?.shortMessage ?? e?.message); } };
const cfg = (over = {}) => ({ name: 'Devnet Cats', symbol: 'DCAT', baseURI: '', contractURI: '', royaltyReceiver: ZeroAddress, royaltyBps: 0n,
  maxSupply: 0n, publicMint: false, mintPrice: 0n, ...over });

before(() => {
  execFileSync(new URL('../../zetaphy-network/scripts/devnet.sh', import.meta.url).pathname,
    [join(root, 'chain'), String(PORT), ...Object.values(actors).map((w) => w.address)], { stdio: 'inherit', env });
  provider = new JsonRpcProvider(RPC, 77390n, { staticNetwork: true, batchMaxCount: 1, pollingInterval: 500 });
});

after(async () => {
  await browser?.close();
  server?.kill();
  try { process.kill(Number(readFileSync(join(root, 'chain', 'node.pid'), 'utf8'))); } catch {}
});

async function created(tx, factory) {
  const r = await tx.wait();
  for (const lg of r.logs) { try { const p = factory.interface.parseLog(lg); if (p?.name === 'CollectionCreated') return p.args.collection; } catch {} }
  throw new Error('no CollectionCreated');
}

test('CLI deploys; create, mint, list and buy (ERC-721 and ERC-1155) on a real ZETAPHY chain', { timeout: 300_000 }, async () => {
  mkdirSync(join(root, 'keys'), { mode: 0o700 });
  const keyFile = join(root, 'keys', 'deployer.key');
  writeFileSync(keyFile, actors.deployer.privateKey + '\n', { mode: 0o600 });
  const out = join(root, 'deployments.json');
  const d = await cli(['deploy', '--rpc', RPC, '--key-file', keyFile, '--fee-bps', '100', '--out', out, '--public-rpc', PUBLIC_RPC]);
  assert.equal(d.code, 0, d.out);
  assert.doesNotMatch(d.out, new RegExp(actors.deployer.privateKey.slice(2)), 'the key is never printed');
  dep = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(dep.chainId, 77390);
  assert.equal(dep.rpc, PUBLIC_RPC);
  assert.ok(dep.deployBlock > 0);
  // No registry yet: the CLI prints the governance step for the shared code keys.
  assert.match(d.out, /WHEN A REGISTRY IS SET .*protect the factory collections' shared code keys/s);
  assert.match(d.out, new RegExp(dep.collectionCodeKeys.erc721));
  assert.equal(dep.codeKeysProtected, false);
  const info = await cli(['info', '--deployments', out, '--rpc', RPC]);
  assert.equal(info.code, 0, info.out);
  assert.match(info.out, /"feeBps": 100/);

  const factory = C(dep.factory, 'NFTFactory', 'creator');
  const marketB = C(dep.marketplace, 'NFTMarketplace', 'buyer');
  const marketC = C(dep.marketplace, 'NFTMarketplace', 'creator');
  // ERC-721 with a 5% royalty to the creator.
  const col = await created(await factory.createERC721(cfg({ royaltyReceiver: actors.creator.address, royaltyBps: 500n, maxSupply: 100n })), factory);
  assert.equal(await factory.isCollection(col), true);
  assert.equal(await marketC.factory(), dep.factory);
  const nft = C(col, 'ZetaphyERC721', 'creator');
  await (await nft.mint(actors.creator.address, 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.json')).wait();
  await (await nft.mintMany(actors.creator.address, 3)).wait(); // ids 2..4
  assert.equal(await nft.ownerOf(4), actors.creator.address);
  await (await nft.setApprovalForAll(dep.marketplace, true)).wait();
  const price = 1_234_567_890_123_456_789n;
  await (await marketC.list(col, 1, 1, price, BigInt(Math.floor(Date.now() / 1000) + 3600))).wait();
  const r = await (await marketB.buy(0, 1, { value: price })).wait();
  const sold = r.logs.map((l) => { try { return marketB.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Sold');
  const fee = price / 100n, royalty = price * 5n / 100n;
  assert.equal(sold.args.fee, fee);
  assert.equal(sold.args.royalty, royalty);
  assert.equal(await nft.ownerOf(1), actors.buyer.address);
  assert.equal(await marketC.owed(actors.creator.address), price - fee); // seller part + royalty: the creator is both
  assert.equal(await marketC.owed(actors.deployer.address), fee);
  const w = await (await marketC.withdraw()).wait();
  const wd = w.logs.map((l) => { try { return marketC.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Withdrawn');
  assert.equal(wd.args.amount, price - fee);
  assert.equal(await marketC.owed(actors.creator.address), 0n);

  // A stale listing: the creator lists #2, then gives it away.
  await (await marketC.list(col, 2, 1, ZETA, BigInt(Math.floor(Date.now() / 1000) + 3600))).wait();
  await (await nft.transferFrom(actors.creator.address, actors.deployer.address, 2)).wait();
  assert.equal(await marketB.listingStatus(1, 0), 4n);
  await assert.rejects(marketB.buy.estimateGas(1, 1, { value: ZETA }), (e) => errorName(e, marketB.interface) === 'SellerLacksToken');

  // ERC-1155: 10 editions, list all at a unit price, buy 4.
  const col2 = await created(await factory.createERC1155(cfg({ name: 'Devnet Editions', symbol: 'DED' })), factory);
  const ed = C(col2, 'ZetaphyERC1155', 'creator');
  await (await ed.create(actors.creator.address, 10, 'ipfs://bafyed/1.json')).wait();
  await (await ed.setApprovalForAll(dep.marketplace, true)).wait();
  await (await marketC.list(col2, 1, 10, ZETA / 4n, BigInt(Math.floor(Date.now() / 1000) + 3600))).wait();
  await (await marketB.buy(2, 4, { value: ZETA })).wait();
  assert.equal(await ed.balanceOf(actors.buyer.address, 1), 4n);
  assert.equal((await marketB.getListing(2)).quantity, 6n);

  // ThreatRegistry: governance points the marketplace at a registry; an enforced flag refuses.
  const R = mockArtifacts().MockThreatRegistry;
  const reg = await new ContractFactory(R.abi, R.bytecode, signer('deployer')).deploy();
  await reg.waitForDeployment();
  const g = await cli(['gov', 'set-registry', await reg.getAddress(), '--deployments', out, '--rpc', RPC, '--key-file', keyFile]);
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /NEXT STEP \(ThreatRegistry governance\)/); // the mock has no governance(): the step is printed
  signer('deployer').reset(); // the CLI used the deployer's next nonce
  assert.equal(await marketB.threatRegistry(), await reg.getAddress());
  await (await reg.set(col, 3, 3)).wait(); // the address key on this chain (77390)
  await assert.rejects(marketC.list.estimateGas(col, 3, 1, ZETA, BigInt(Math.floor(Date.now() / 1000) + 3600)), (e) => errorName(e, marketC.interface) === 'CollectionRefused');
  await (await reg.set(col, 0, 0)).wait();
  // A flag on the code key every factory collection shares does not stop this one (address key only).
  assert.equal(keccak256(await provider.getCode(col)), dep.collectionCodeHashes.erc721);
  await (await reg.setKey(await reg.codeKey(dep.collectionCodeHashes.erc721), 3, 3)).wait();
  assert.equal(await reg.codeKey(dep.collectionCodeHashes.erc721), dep.collectionCodeKeys.erc721);
  await marketC.list.estimateGas(col, 3, 1, ZETA, BigInt(Math.floor(Date.now() / 1000) + 3600));
  await (await reg.setKey(dep.collectionCodeKeys.erc721, 0, 0)).wait();
  // List #3 for the browser test below.
  await (await marketC.list(col, 3, 1, ZETA / 2n, BigInt(Math.floor(Date.now() / 1000) + 3600))).wait();
  dep.registry = await reg.getAddress();
  dep.collection = col;
});

test('the web app finds the listing with eth_getLogs on the node and buys it through a wallet', { timeout: 180_000 }, async () => {
  assert.ok(dep?.collection, 'needs the first test');
  server = spawn(process.execPath, ['scripts/serve.js', String(WEB_PORT)], { stdio: 'pipe', cwd: new URL('..', import.meta.url) });
  await new Promise((r) => server.stdout.once('data', r));
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }); }
  const ctx = await browser.newContext({ locale: 'en-US' });
  const buyer = signer('buyer');
  await ctx.exposeBinding('__walletRequest', async (_s, method, params) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [actors.buyer.address];
    if (method === 'eth_chainId') return '0x12e4e';
    if (method.startsWith('wallet_')) return null;
    if (method === 'eth_sendTransaction') {
      const t = params[0];
      if (t.chainId !== '0x12e4e') throw new Error(`wallet: tx without chainId 77390 (${t.chainId})`);
      return (await buyer.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value ?? 0), chainId: BigInt(t.chainId) })).hash;
    }
    throw new Error(`wallet: ${method}`);
  });
  await ctx.addInitScript(() => {
    window.__problems = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__problems.push(`CSP ${e.violatedDirective}`));
    const provider = { request: ({ method, params }) => window.__walletRequest(method, params ?? []) };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'devnet', name: 'Devnet Wallet', rdns: 'devnet.wallet', icon: '' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce);
  });
  // The page's RPC, proxied to the real node.
  await ctx.route(`${PUBLIC_RPC}**`, async (route) => {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
    await route.fulfill({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await res.text() });
  });
  await ctx.route(`http://localhost:${WEB_PORT}/deployments.json`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dep) }));
  await ctx.route('https://ipfs.io/**', (route) => route.fulfill({ status: 404, body: '' })); // no internet needed
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${WEB_PORT}/#/`);
  await page.waitForSelector('.page[data-ready]', { timeout: 60_000 });
  await page.waitForSelector('.nft-card[data-listing="3"]', { timeout: 30_000 });
  assert.equal(await page.locator('.nft-card[data-listing="1"]').count(), 0, 'the stale listing is hidden');
  await page.click('.nft-card[data-listing="3"]');
  await page.waitForSelector('.page[data-ready] #listings', { timeout: 60_000 });
  await page.click('#connect');
  await page.click('dialog .wallet-choice');
  await page.waitForSelector('.page[data-ready] #listings button', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Buy', exact: true }).click();
  await page.waitForFunction(() => /Buy: done/.test(document.querySelector('#status')?.textContent ?? ''), null, { timeout: 90_000 })
    .catch(async (e) => { throw new Error(`${e.message}: ${await page.textContent('#status')}`); });
  assert.equal(await C(dep.collection, 'ZetaphyERC721').ownerOf(3), actors.buyer.address);
  assert.deepEqual([...errors, ...(await page.evaluate(() => window.__problems))], []);
});
