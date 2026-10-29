// The "Neuro-checked" certificate on the swap page (web/lib/neuro.js checkBadge, NeuroAttest.badge): read, revoked, none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id } from 'ethers';
import { checkBadge } from '../web/lib/neuro.js';
import { TEXT } from '../web/i18n.js';

const abi = AbiCoder.defaultAbiCoder();
const ATTEST = '0x' + '77'.repeat(20), TOKEN = '0x' + 'Ab'.repeat(20);
const answer = (checked, uid) => abi.encode(['bool', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'address', 'uint64'], [checked, uid, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '00'.repeat(32), '0x' + '33'.repeat(20), 1]);

test('checkBadge: NeuroAttest.badge(token) read; revoked and none told apart; no contract configured: null', async () => {
  let asked = null;
  const rpc = (out) => async (m, [tx]) => { asked = tx; return out; };
  assert.deepEqual(await checkBadge(rpc(answer(true, 4n)), ATTEST, TOKEN), { checked: true, uid: 4n, by: '0x' + '33'.repeat(20) });
  assert.equal(asked.data, id('badge(address)').slice(0, 10) + TOKEN.slice(2).toLowerCase().padStart(64, '0'));
  assert.equal((await checkBadge(rpc(answer(false, 4n)), ATTEST, TOKEN)).checked, false);
  assert.equal(await checkBadge(rpc(answer(false, 0n)), ATTEST, TOKEN), null);
  assert.equal(await checkBadge(rpc('0x'), ATTEST, TOKEN), null);
  assert.equal(await checkBadge(rpc(answer(true, 1n)), null, TOKEN), null);
  assert.equal(await checkBadge(async () => { throw new Error('down'); }, ATTEST, TOKEN), null);
});

test('badge words in every language, never "safe"', () => {
  for (const [l, t] of Object.entries(TEXT)) {
    assert.match(t.neuroBadge, /\{uid\}[\s\S]*\{by\}|\{by\}[\s\S]*\{uid\}/, l);
    assert.match(t.neuroBadgeRevoked, /\{uid\}/, l);
    assert.doesNotMatch(t.neuroBadge, /\bsafe\b/i, l);
  }
});
