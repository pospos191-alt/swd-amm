import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictOf, verdictBody } from '../src/verdict.js';

const base = {
  chain: 'bsc', address: '0xC1ED4b78071e7c9a84958d8be0215a10984fc28f', owner: '0x69FD0852fcb428ebd939dbe11a45441a6e501a28',
  fingerprint: 'fp1:abc', functions: ['transfer(address,uint256)', 'lowerTaxes(uint16,uint16)'], unknownSelectors: ['0a5ab11d'],
  token: { totalSupply: '1000' },
  analysis: { level: 'medium', control: 'owner', findings: [
    { id: 'erc20', severity: 'info', params: { totalSupply: '1000' } },
    { id: 'can-change-fee', severity: 'medium', params: { functions: ['lowerTaxes(uint16,uint16)'] } }] },
};

test('verdict ignores supply, order and address case', async () => {
  const moved = structuredClone(base);
  moved.token.totalSupply = '999';
  moved.analysis.findings[0].params.totalSupply = '999';
  moved.analysis.findings.reverse();
  moved.functions.reverse();
  moved.address = moved.address.toLowerCase();
  assert.equal(await verdictOf(moved), await verdictOf(base));
  assert.match(await verdictOf(base), /^0x[0-9a-f]{64}$/);
});

test('verdict changes when the rules decide something different', async () => {
  for (const change of [
    (r) => { r.analysis.findings[1].severity = 'low'; },
    (r) => { r.owner = '0x0000000000000000000000000000000000000000'; },
    (r) => { r.fingerprint = 'fp1:def'; },
    (r) => { r.unknownSelectors = []; },
    (r) => { r.chain = 'base'; },
  ]) {
    const r = structuredClone(base);
    change(r);
    assert.notEqual(await verdictOf(r), await verdictOf(base));
  }
  assert.deepEqual(verdictBody(base).findings, ['can-change-fee:medium', 'erc20:info']);
});
