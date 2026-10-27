// The site-wide wallet button (walletbar.js): what it stores and how it reads token answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanId, decodeString, formatUnits, balanceOfData, SHARED_KEY } from '../walletbar.js';
import { chainTokens } from '../build.mjs';

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
