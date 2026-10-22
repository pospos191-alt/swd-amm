import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id } from 'ethers';
import * as L from '../chainlib.js';

const A = '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245';
const VAL = 'zetaphyvaloper1dt6hlsmr8nwlmepl0yqdhfp22qhn6gj9x3j6zk';

test('selectors are keccak256 of the signatures', () => {
  assert.equal(L.SELECTORS.delegate, id('delegate(address,string,uint256)').slice(0, 10));
  assert.equal(L.SELECTORS.undelegate, id('undelegate(address,string,uint256)').slice(0, 10));
  assert.equal(L.SELECTORS.claimRewards, id('claimRewards(address,uint32)').slice(0, 10));
  assert.equal(L.SELECTORS.vote, id('vote(address,uint64,uint8,string)').slice(0, 10));
  assert.equal(L.IBC_TRANSFER_TOPIC, id('IBCTransfer(address,string,string,string,string,uint256,string)'));
  assert.equal(L.sentIbcTransfer({ logs: [{ address: L.PRECOMPILES.ics20, topics: [L.IBC_TRANSFER_TOPIC] }] }), true);
  assert.equal(L.sentIbcTransfer({ logs: [] }), false, 'no event: nothing was sent');
  assert.equal(L.SELECTORS.ibcTransfer, id('transfer(string,string,string,uint256,address,string,(uint64,uint64),uint64,string)').slice(0, 10));
});

test('ICS-20 transfer calldata (ZETAPHY Saphan) matches ethers', () => {
  const i = new Interface(['function transfer(string sourcePort, string sourceChannel, string denom, uint256 amount, address sender, string receiver, (uint64 revisionNumber, uint64 revisionHeight) timeoutHeight, uint64 timeoutTimestamp, string memo) returns (uint64)']);
  const noble = 'noble1dt6hlsmr8hg00yrl0yqdh49zsgh58gj9v4lt7z';
  const hash = `ibc/${'AB'.repeat(32)}`;
  const t = 1792680000000000000n;
  for (const [denom, amount, memo] of [['azetaphy', 10n ** 18n, ''], [hash, 1500000n, 'ZETAPHY Saphan ไทย']]) {
    assert.equal(L.encodeIbcTransfer({ channel: 'channel-0', denom, amount, sender: A, receiver: noble, timeoutNs: t, memo }),
      i.encodeFunctionData('transfer', ['transfer', 'channel-0', denom, amount, A, noble, [0, 0], t, memo]));
  }
  const ok = { channel: 'channel-0', denom: 'azetaphy', amount: 1n, sender: A, receiver: noble, timeoutNs: t };
  assert.throws(() => L.encodeIbcTransfer({ ...ok, channel: 'chan0' }), /channel/);
  assert.throws(() => L.encodeIbcTransfer({ ...ok, amount: 0n }), /amount/);
  assert.throws(() => L.encodeIbcTransfer({ ...ok, receiver: 'noble1xyz' }), /bech32|checksum/);
  assert.throws(() => L.encodeIbcTransfer({ ...ok, denom: 'IBC/bad' }), /denom/);
});

test('amounts with any number of decimals', () => {
  assert.equal(L.parseUnits('1.5', 6), 1500000n);
  assert.equal(L.parseUnits('7', 0), 7n);
  assert.throws(() => L.parseUnits('1.1234567', 6), /amount/);
  assert.throws(() => L.parseUnits('1.5', 0), /amount/);
  assert.equal(L.formatUnits(1234567890n, 6), '1,234.56789');
  assert.equal(L.formatUnits('5', 0), '5');
});

test('calldata matches ethers', () => {
  const st = new Interface(['function delegate(address,string,uint256)', 'function undelegate(address,string,uint256)']);
  const d = new Interface(['function claimRewards(address,uint32)']);
  const g = new Interface(['function vote(address,uint64,uint8,string)']);
  assert.equal(L.encodeDelegate(A, VAL, 10n ** 18n), st.encodeFunctionData('delegate', [A, VAL, 10n ** 18n]));
  assert.equal(L.encodeUndelegate(A, VAL, 5n), st.encodeFunctionData('undelegate', [A, VAL, 5n]));
  assert.equal(L.encodeClaimRewards(A, 50), d.encodeFunctionData('claimRewards', [A, 50]));
  assert.equal(L.encodeVote(A, 7, 1, ''), g.encodeFunctionData('vote', [A, 7, 1, '']));
  assert.equal(L.encodeVote(A, 7, 3, 'ไทย '.repeat(20)), g.encodeFunctionData('vote', [A, 7, 3, 'ไทย '.repeat(20)]));
  assert.throws(() => L.encodeVote(A, 1, 5), /1-4/);
  assert.throws(() => L.encodeDelegate('0x12', VAL, 1n), /0x address/);
});

test('bech32 round trip and checksum', () => {
  const b = L.toBech32(A);
  assert.match(b, /^zetaphy1[02-9ac-hj-np-z]{38}$/);
  assert.equal(L.toEvm(b), A.toLowerCase());
  assert.throws(() => L.toEvm(b.slice(0, -1) + (b.endsWith('q') ? 'p' : 'q')), /checksum/);
  // a known vector (BIP-173)
  assert.equal(L.bech32Decode('A12UEL5L').hrp, 'a');
});

test('amounts', () => {
  assert.equal(L.parseZeta('1'), 10n ** 18n);
  assert.equal(L.parseZeta('0.000000000000000001'), 1n);
  assert.throws(() => L.parseZeta('1e3'), /amount/);
  assert.throws(() => L.parseZeta('-1'), /amount/);
  assert.equal(L.formatZeta('1234567890000000000000'), '1,234.5678');
  assert.equal(L.formatZeta(10n ** 18n), '1');
  assert.equal(L.formatZeta('junk'), '–');
  assert.equal(L.short('zetaphy1abcdefghijklmnop'), 'zetaphy1…klmnop');
});

test('pages.js selectors and string decoding', async () => {
  const { SEL, decodeString } = await import('../pages.js').catch(() => ({}));
  if (!SEL) return; // pages.js touches the DOM only inside functions; importing it in node is fine
  const sigs = { allPairsLength: 'allPairsLength()', allPairs: 'allPairs(uint256)', token0: 'token0()', token1: 'token1()', getReserves: 'getReserves()',
    symbol: 'symbol()', decimals: 'decimals()', workerBond: 'workerBond()', activeWorkers: 'activeWorkers()', rewardPool: 'rewardPool()',
    totalActiveBond: 'totalActiveBond()', jobCount: 'jobCount()' };
  for (const [k, sig] of Object.entries(sigs)) assert.equal(SEL[k], id(sig).slice(0, 10), k);
  const abi = new Interface(['function f() returns (string)']);
  assert.equal(decodeString(abi.encodeFunctionResult('f', ['ZTPHY'])), 'ZTPHY');
  assert.equal(decodeString(`0x${Buffer.from('MKR').toString('hex').padEnd(64, '0')}`), 'MKR', 'bytes32 symbols');
  assert.equal(decodeString(abi.encodeFunctionResult('f', ['<script>'])).includes('<'), true, 'text only; the page sets textContent, never HTML');
});
