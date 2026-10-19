import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNATURES } from '../src/signatures.js';
import { SELECTORS } from '../src/selectors.generated.js';
import { selectorOf } from '../scripts/keccak.js';

test('generated selector table matches src/signatures.js (run `npm run selectors` if this fails)', () => {
  const expected = Object.fromEntries(SIGNATURES.map(([sig, cat]) => [selectorOf(sig), { sig, cat }]));
  assert.deepEqual(SELECTORS, expected);
  assert.equal(Object.keys(SELECTORS).length, SIGNATURES.length, 'two signatures share a selector');
});

test('well-known selectors', () => {
  assert.equal(SELECTORS['a9059cbb'].sig, 'transfer(address,uint256)');
  assert.equal(SELECTORS['8da5cb5b'].sig, 'owner()');
  assert.equal(SELECTORS['40c10f19'].sig, 'mint(address,uint256)');
});

test('selectors seen in the NEWZETA dispatcher (BNB Chain) have names', () => {
  // Read from the bytecode BscScan shows for 0xc1ed4b78071e7c9a84958d8be0215a10984fc28f.
  const seen = {
    cffd129c: 'sellTaxBps()', aa4bde28: 'maxWalletAmount()', ad5dff73: 'isExempt(address)',
    a8aa1b31: 'pair()', c45a0155: 'factory()', ca72a4e7: 'openTrading(address)',
    d505accf: 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', '5c19a95c': 'delegate(address)',
  };
  for (const [sel, sig] of Object.entries(seen)) assert.equal(SELECTORS[sel]?.sig, sig, sel);
});

test('NEWZETA tax setter and tax wallet are classified', () => {
  assert.equal(SELECTORS['233e8700'].sig, 'lowerTaxes(uint16,uint16)');
  assert.equal(SELECTORS['233e8700'].cat, 'fee');
  assert.equal(SELECTORS['12f16a07'].sig, 'maxWalletBps()');
  // setTaxWallet chooses who receives the tax; it exempts no one.
  assert.equal(SIGNATURES.find(([s]) => s === 'setTaxWallet(address)')[1], 'taxWallet');
});

test('NEWZETA limit setter and caps are named', () => {
  // From the full unknown list the live site showed for NEWZETA.
  const seen = {
    aa3a13f2: ['relaxLimits(uint16,uint16)', 'limit'], '9fde54f5': ['setExempt(address,bool)', 'feeExempt'],
    '1a08a9c8': ['MAX_TOTAL_TAX_BPS()', 'view'], '86e97989': ['MIN_MAX_WALLET_BPS()', 'view'],
    f7e126d2: ['MIN_MAX_TX_BPS()', 'view'], ff8ea3e5: ['maxTxBps()', 'view'], '79ba5097': ['acceptOwnership()', 'ownership'],
  };
  for (const [sel, [sig, cat]] of Object.entries(seen)) assert.deepEqual([SELECTORS[sel]?.sig, SELECTORS[sel]?.cat], [sig, cat], sel);
});
