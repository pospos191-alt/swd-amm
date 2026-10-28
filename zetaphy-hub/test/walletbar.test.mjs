// The site-wide wallet button (walletbar.js): what it stores and how it reads token answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanId, decodeString, formatUnits, balanceOfData, SHARED_KEY } from '../walletbar.js';
import { readFileSync } from 'node:fs';
import { chainTokens, saphanRoutes, saphanTokenRoutes } from '../build.mjs';

test('stored wallet id: only an id this site writes (JSON or plain), nothing else', () => {
  assert.equal(SHARED_KEY, 'zetaphy:wallet');
  for (const ok of ['6963:io.metamask', '6963:com.trustwallet.app', '6963:3f2c1a2e-8a7b-4c1d-9e2f-1a2b3c4d5e6f', 'injected:ethereum', 'injected:binancew3w']) {
    assert.equal(cleanId(JSON.stringify(ok)), ok);
    assert.equal(cleanId(ok), ok);
  }
  for (const bad of [null, '', '"x"', '{"a":1}', '"javascript:alert(1)"', '"6963:<img>"', `"6963:${'a'.repeat(200)}"`, '"injected:Eth"']) assert.equal(cleanId(bad), null, String(bad));
});

test('token answers: balanceOf call data, string and bytes32 symbols, amounts', () => {
  assert.equal(balanceOfData('0x6af57fC3633dD0F7907f7900dbd4A2822F43a245'), '0x70a08231' + '0'.repeat(24) + '6af57fc3633dd0f7907f7900dbd4a2822f43a245');
  const str = (s) => '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + Buffer.from(s).toString('hex').padEnd(64, '0');
  assert.equal(decodeString(str('tUSD')), 'tUSD');
  assert.equal(decodeString(str('<b>x</b>')), 'bxb', 'markup characters dropped');
  assert.equal(decodeString('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')), 'MKR');
  assert.equal(decodeString('0x'), '');
  assert.equal(formatUnits(10n ** 21n), '1,000');
  assert.equal(formatUnits(1234567n, 6), '1.2345');
  assert.equal(formatUnits(0n), '0');
});

test('tokens shown: BZTPHY, the bridged token and the DEX tokens, addresses only from the repo', () => {
  const t = chainTokens((f) => ({
    'zetaphy-chain/rewards/points-testnet.json': { points: '0x3cC2B1FFd3a7C7504a49426AE6BDEa501Bf1D59d' },
    'zetaphy-chain/hyperlane/bridge-testnet.json': { zetaphy: { bridgedToken: '0xb0e25f7ab80e55d6f06F401c8301B3d9B90Ab855' } },
    'zetaphy-dex/web/deployments.json': { tokens: [{ address: '0x9D44EA6837938d4FEF98367A7b5867cdCa8DE596', symbol: 'tUSD', decimals: 18 }, { address: 'nope', symbol: 'X' }, { address: '0x3cc2b1ffd3a7c7504a49426ae6bdea501bf1d59d', symbol: 'DUP' }] },
  })[f] ?? null);
  assert.deepEqual(t.map((x) => x.symbol ?? x.address), ['BZTPHY', '0xb0e25f7ab80e55d6f06F401c8301B3d9B90Ab855', 'tUSD']);
});

test('Saphan EVM routes: every chain of the table, its state from saphan-routes.json; deployed tokens join the wallet bar', () => {
  const read = (f) => ({
    'zetaphy-chain/hyperlane/saphan-chains.json': { chains: {
      sepolia: { displayName: 'Sepolia', chainId: 11155111, explorer: 'https://sepolia.etherscan.io/', token: { symbol: 'sepETH' } },
      basesepolia: { displayName: 'Base Sepolia', chainId: 84532, explorer: 'javascript:alert(1)', token: { symbol: 'baseETH' } },
      'Bad Name': { displayName: 'x', chainId: 1, token: { symbol: 'X' } },
      evil: { displayName: 'Evil', chainId: 2, token: { symbol: '<script>' } },
    } },
    'zetaphy-chain/hyperlane/saphan-routes.json': { routes: {
      sepolia: { state: 'OPEN', origin: { lockbox: '0x' + '11'.repeat(20) }, zetaphy: { bridgedToken: '0x' + '22'.repeat(20), hyperlaneOutbox: '0x' + '33'.repeat(20) } },
      basesepolia: { state: 'CLOSED', origin: { lockbox: 'nope' }, zetaphy: { bridgedToken: '0x' + '44'.repeat(20) } },
    } },
  })[f] ?? null;
  const r = saphanRoutes(read);
  assert.deepEqual(r.map((x) => [x.name, x.state, x.twoWay, x.explorer]), [['sepolia', 'open', true, 'https://sepolia.etherscan.io'], ['basesepolia', 'planned', false, '']]);
  assert.equal(r[0].lockbox, '0x' + '11'.repeat(20));
  assert.deepEqual(chainTokens(read), [{ address: '0x' + '22'.repeat(20), symbol: 'sepETH', decimals: 18 }]);
  // the committed table: the three test networks, planned until the saphan-route workflow deploys them
  const real = saphanRoutes((f) => { try { return JSON.parse(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')); } catch { return null; } });
  assert.deepEqual(real.map((x) => [x.name, x.state]), [['sepolia', 'planned'], ['basesepolia', 'planned'], ['arbitrumsepolia', 'planned']]);
});

test('Saphan token routes: tokens born on ZETAPHY with their destinations; held tokens carry their routes into the wallet bar', () => {
  const A = (b) => '0x' + b.repeat(20);
  const read = (f) => ({
    'zetaphy-chain/hyperlane/saphan-chains.json': {
      chains: { sepolia: { displayName: 'Sepolia' }, basesepolia: { displayName: 'Base Sepolia' } },
      tokens: {
        about: 'text',
        zetaphy: { displayName: 'ZETAPHY (native coin)', symbol: 'ZETAPHY', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', native: true, synthetic: { symbol: 'zZETAPHY' }, destinations: ['sepolia', 'basesepolia', 'nowhere'] },
        tusd: { displayName: 'Test USD', symbol: 'tUSD', address: A('55'), synthetic: { symbol: 'ztUSD' }, destinations: ['basesepolia'] },
        bztphy: { displayName: 'BZTPHY', symbol: 'BZTPHY', address: A('66'), transferable: false, synthetic: { symbol: 'zBZTPHY' }, destinations: ['sepolia'] },
        evil: { displayName: 'x', symbol: '<img>', address: A('77'), synthetic: { symbol: 'z' }, destinations: [] },
        'Bad Key': { displayName: 'x', symbol: 'X', address: A('88'), synthetic: { symbol: 'zX' }, destinations: [] },
      },
    },
    'zetaphy-chain/hyperlane/saphan-routes.json': { tokens: {
      zetaphy: { basesepolia: { state: 'OPEN', zetaphy: { vault: A('11') }, destination: { synthetic: A('22') } } },
      tusd: { basesepolia: { state: 'CLOSED', zetaphy: { vault: 'nope' }, destination: { synthetic: A('33') } } },
    } },
  })[f] ?? null;
  const r = saphanTokenRoutes(read);
  assert.deepEqual(r.map((x) => [x.key, x.native, x.transferable, x.destinations.map((d) => `${d.name}:${d.state}`).join()]),
    [['zetaphy', true, true, 'sepolia:planned,basesepolia:open'], ['tusd', false, true, 'basesepolia:planned'], ['bztphy', false, false, '']]);
  assert.equal(r[0].destinations[1].token, A('22'));
  // the wallet bar: tUSD with its route (the native coin is shown as ZETAPHY already; BZTPHY cannot move)
  assert.deepEqual(chainTokens(read), [
    { address: A('55'), symbol: 'tUSD', saphan: [{ chain: 'Base Sepolia', symbol: 'ztUSD', state: 'planned' }] },
    { address: A('66'), symbol: 'BZTPHY' },
  ]);
  // the committed tables: ZETAPHY to the three test networks (planned), BZTPHY listed without a route
  const real = saphanTokenRoutes((f) => { try { return JSON.parse(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')); } catch { return null; } });
  assert.deepEqual(real.map((x) => [x.symbol, x.synthetic, x.destinations.map((d) => d.state).join()]), [['ZETAPHY', 'zZETAPHY', 'planned,planned,planned'], ['BZTPHY', 'zBZTPHY', '']]);
});
