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
