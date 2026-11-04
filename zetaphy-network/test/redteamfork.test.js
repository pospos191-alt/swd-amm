// The red team's local fork (src/redteam/fork.js): the lazy, journaled state over a source, snapshots that nest,
// deploys, balances, storage, and the attacker contract (RedTeamAttacker) with its callback (reentrancy) and the
// balance-patching call. Deterministic and self-contained; no network, no live chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, keccak256, getCreateAddress, getAddress } from 'ethers';
import { createFork, emptySource } from '../src/redteam/fork.js';
import { redTeamKit } from './helpers/redteamkit.js';

const E = 10n ** 18n;
const kit = redTeamKit();
const dep = '0x00000000000000000000000000000000000d0d01';
const ATT = JSON.parse(readFileSync(new URL('../src/redteam/attacker.json', import.meta.url), 'utf8'));
const AI = new Interface(ATT.abi);

test('snapshots nest and revert all state (balance, storage, code)', async () => {
  const w = await createFork();
  await w.setBalance(dep, 10n ** 21n);
  const bank = await w.deploy(dep, kit.ReentrantBank.bytecode);
  const s1 = await w.snapshot();
  await w.tx(dep, bank, new Interface(kit.ReentrantBank.abi).encodeFunctionData('deposit'), 5n * E);
  assert.equal(await w.balance(bank), 5n * E);
  const s2 = await w.snapshot();
  await w.tx(dep, bank, new Interface(kit.ReentrantBank.abi).encodeFunctionData('deposit'), 3n * E);
  assert.equal(await w.balance(bank), 8n * E);
  await w.revert(s2);
  assert.equal(await w.balance(bank), 5n * E, 'inner revert');
  await w.revert(s1);
  assert.equal(await w.balance(bank), 0n, 'outer revert');
  assert.notEqual(await w.code(bank), '0x', 'the deploy (before the snapshot) survives');
});

test('the attacker contract runs calls, re-enters from its callback, and sweeps to the owner', async () => {
  const w = await createFork();
  const owner = '0x00000000000000000000000000000000000a77a1';
  await w.setBalance(owner, 100n * E);
  const bank = await w.deploy(owner, kit.ReentrantBank.bytecode);
  const B = new Interface(kit.ReentrantBank.abi);
  const victim = '0x00000000000000000000000000000000000b1c71';
  await w.setBalance(victim, 100n * E);
  await w.tx(victim, bank, B.encodeFunctionData('deposit'), 40n * E);
  // the attack contract is the owner's next CREATE
  const atc = getCreateAddress({ from: getAddress(owner), nonce: await w.nonce(owner) }).toLowerCase();
  await w.deploy(owner, ATT.bytecode);
  const dep5 = { to: bank, value: 5n * E, data: B.encodeFunctionData('deposit'), balanceOf: '0x'.padEnd(42, '0'), patchAt: 0 };
  const wdr = { to: bank, value: 0n, data: B.encodeFunctionData('withdraw'), balanceOf: '0x'.padEnd(42, '0'), patchAt: 0 };
  const tup = (c) => [c.to, c.value, c.data, c.balanceOf, c.patchAt];
  await w.tx(owner, atc, AI.encodeFunctionData('arm', [[tup(wdr)], 7n, '0x']));
  await w.tx(owner, atc, AI.encodeFunctionData('run', [[tup(dep5), tup(wdr)]]), 5n * E);
  assert.ok((await w.balance(atc)) > 5n * E, 'the attack contract drained more than it put in');
  const before = await w.balance(owner);
  await w.tx(owner, atc, AI.encodeFunctionData('sweep', [[]]));
  assert.ok((await w.balance(owner)) > before, 'swept to the owner');
  assert.equal(await w.balance(atc), 0n);
});

test('reads fall through to the source once and writes stay local', async () => {
  let codeReads = 0;
  const base = emptySource(31337, 100, 1_700_000_000);
  const target = '0x00000000000000000000000000000000000c0de0';
  const src = { ...base, getCode: async (a) => { if (a.toLowerCase() === target) { codeReads++; return kit.SafeBank.bytecode.length > 2 ? '0x60016001' : '0x'; } return '0x'; },
    getBalance: async (a) => (a.toLowerCase() === target ? '0x' + (7n * E).toString(16) : '0x0') };
  const w = await createFork({ source: src });
  assert.equal(await w.balance(target), 7n * E, 'balance from the source');
  await w.setBalance(target, 1n * E);
  assert.equal(await w.balance(target), 1n * E, 'local write shadows the source');
  await w.code(target); await w.code(target);
  assert.equal(codeReads, 1, 'the source code is read once and cached');
  assert.equal(w.forkBlock, 100);
});
