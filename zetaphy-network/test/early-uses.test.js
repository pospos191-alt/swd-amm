// What ZEARLY is for on ZETAPHY (zetaphy-chain/rewards/EARLY.md): the Early Pass paid in ZEARLY, quests, the
// liquidity farm and community polls. In-memory EVM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChain, ZETA } from './helpers/evm.js';

const BURN = '0x000000000000000000000000000000000000dEaD';
const DAY = 86400;

async function world() {
  const c = await createChain(['drop', 'op', 'alice', 'bob', 'carol']);
  const a = (n) => c.acct[n].toString();
  const z = await c.deploy('ZetaphyEarly', [a('drop')], 'drop');
  for (const n of ['alice', 'bob']) await z.send('drop', 'transfer', [a(n), 100_000n * ZETA]);
  await z.send('drop', 'transfer', [a('carol'), 500n * ZETA]); // a small holder
  return { c, a, z };
}

test('Early Pass: pay ZEARLY (burned), one per wallet, holders first, sold out at the cap, on-chain picture', async () => {
  const { c, a, z } = await world();
  const now = Number(c.now());
  const pass = await c.deploy('ZetaphyEarlyPass', [z.address, 1000n * ZETA, 2n, BigInt(now + DAY), 10_000n * ZETA], 'drop');
  for (const n of ['alice', 'bob', 'carol']) await z.send(n, 'approve', [pass.address, 10n ** 30n]);

  await assert.rejects(pass.send('carol', 'mint'), /EarlyHoldersOnly/, 'holders of 10,000 ZEARLY first');
  await pass.send('alice', 'mint');
  assert.equal((await pass.call('ownerOf', [1n])).toLowerCase(), a('alice').toLowerCase());
  assert.equal(await z.call('balanceOf', [BURN]), 1000n * ZETA, 'the price is burned');
  assert.equal(await z.call('balanceOf', [a('alice')]), 99_000n * ZETA);
  await assert.rejects(pass.send('alice', 'mint'), /AlreadyMinted/);

  c.advance(DAY + 1); // the early window is over: anyone with the price
  await assert.rejects(pass.send('carol', 'mint'), /./, 'carol has 500, the price is 1,000');
  await pass.send('bob', 'mint');
  await assert.rejects(pass.send('drop', 'mint'), /SoldOut/);

  const uri = await pass.call('tokenURI', [2n]);
  const meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString());
  assert.equal(meta.name, 'ZETAPHY Early Pass #2');
  assert.match(Buffer.from(meta.image.split(',')[1], 'base64').toString(), /^<svg[\s\S]*EARLY PASS[\s\S]*#2<\/text><\/svg>$/);
  assert.equal(await pass.call('supportsInterface', ['0x80ac58cd']), true);

  // an ordinary ERC-721: transfer, approvals
  await pass.send('bob', 'transferFrom', [a('bob'), a('carol'), 2n]);
  assert.equal((await pass.call('ownerOf', [2n])).toLowerCase(), a('carol').toLowerCase());
  await assert.rejects(pass.send('bob', 'transferFrom', [a('carol'), a('bob'), 2n]), /NotAllowed/);
});

test('quests: each wallet paid once per quest, re-runs skip, caps hold, only the operator pays', async () => {
  const { c, a, z } = await world();
  const q = await c.deploy('ZetaphyQuests', [z.address, a('op')], 'drop');
  await z.send('drop', 'transfer', [q.address, 1_000_000n * ZETA]);
  await assert.rejects(q.send('alice', 'setQuest', [0, 1000n * ZETA, 10]), /NotOperator/);
  await q.send('op', 'setQuest', [0, 1000n * ZETA, 2]); // first swap: 1,000, at most 2 wallets
  await q.send('op', 'setQuest', [1, 2000n * ZETA, 100]);
  await q.send('op', 'pay', [0, [a('alice'), a('alice'), a('bob'), a('carol')]]);
  assert.equal(await z.call('balanceOf', [a('alice')]), 101_000n * ZETA, 'alice once, though listed twice');
  assert.equal(await z.call('balanceOf', [a('carol')]), 500n * ZETA, 'the cap of 2 was reached');
  await q.send('op', 'pay', [1, [a('alice')]]);
  await q.send('op', 'pay', [1, [a('alice')]]);
  assert.equal(await q.call('earned', [a('alice')]), 3000n * ZETA);
  assert.deepEqual([...(await q.call('progress', [a('alice'), 3]))], [true, true, false]);
  await assert.rejects(q.send('op', 'pay', [5, [a('bob')]]), /NoQuest/);
  await assert.rejects(q.send('alice', 'pay', [1, [a('alice')]]), /NotOperator/);
});

test('farm: stake LP, rewards stream by share, withdraw any time, the operator cannot take what is owed', async () => {
  const { c, a, z } = await world();
  const lp = await c.deploy('ZetaphyEarly', [a('drop')], 'drop'); // an ERC-20 standing in for the pool's LP
  for (const n of ['alice', 'bob']) await lp.send('drop', 'transfer', [a(n), 1000n * ZETA]);
  const f = await c.deploy('ZetaphyEarlyFarm', [lp.address, z.address, a('op')], 'drop');
  await z.send('drop', 'transfer', [f.address, 70_000n * ZETA]);
  await assert.rejects(f.send('op', 'notifyReward', [100_000n * ZETA, 7 * DAY]), /Underfunded/);
  await f.send('op', 'notifyReward', [70_000n * ZETA, 7 * DAY]); // 10,000 a day for a week
  for (const n of ['alice', 'bob']) await lp.send(n, 'approve', [f.address, 10n ** 30n]);

  await f.send('alice', 'stake', [300n * ZETA]);
  await f.send('bob', 'stake', [100n * ZETA]);
  c.advance(2 * DAY);
  const ea = await f.call('earned', [a('alice')]), eb = await f.call('earned', [a('bob')]);
  assert.ok(ea > 14_900n * ZETA && ea <= 15_000n * ZETA, `alice ~3/4 of 20,000: ${ea}`);
  assert.ok(eb > 4_900n * ZETA && eb <= 5_000n * ZETA, `bob ~1/4: ${eb}`);

  await assert.rejects(f.send('op', 'recover', [a('op'), 1n * ZETA]), /Underfunded/, 'everything is promised');
  await f.send('alice', 'exit');
  assert.equal(await lp.call('balanceOf', [a('alice')]), 1000n * ZETA, 'LP back');
  assert.ok((await z.call('balanceOf', [a('alice')])) > 114_900n * ZETA);
  c.advance(10 * DAY);
  await f.send('bob', 'getReward');
  const left = await z.call('balanceOf', [f.address]);
  assert.ok(left < 10n * ZETA, `almost all paid out: ${left}`);
  await assert.rejects(f.send('alice', 'notifyReward', [1n, DAY]), /NotOperator/);
});

test('polls: deposit to open, ZEARLY locked per vote (one option), released after the end', async () => {
  const { c, a, z } = await world();
  const p = await c.deploy('ZetaphyEarlyPolls', [z.address, 1000n * ZETA], 'drop');
  for (const n of ['alice', 'bob', 'carol']) await z.send(n, 'approve', [p.address, 10n ** 30n]);
  await assert.rejects(p.send('alice', 'create', ['Next feature?', ['Only one'], BigInt(DAY)]), /BadPoll/);
  await p.send('alice', 'create', ['Next feature?', ['Bridges', 'NFT drops', 'Quests'], BigInt(3 * DAY)]);
  await p.send('bob', 'vote', [0n, 1, 40_000n * ZETA]);
  await p.send('carol', 'vote', [0n, 2, 500n * ZETA]);
  await p.send('bob', 'vote', [0n, 1, 1_000n * ZETA]);
  await assert.rejects(p.send('bob', 'vote', [0n, 0, 1n]), /OtherOption/);
  const [, , question, options, tally] = await p.call('poll', [0n]);
  assert.equal(question, 'Next feature?');
  assert.deepEqual([...options], ['Bridges', 'NFT drops', 'Quests']);
  assert.deepEqual([...tally], [0n, 41_000n * ZETA, 500n * ZETA]);
  await assert.rejects(p.send('bob', 'release', [0n]), /NotEnded/);
  c.advance(3 * DAY);
  await assert.rejects(p.send('carol', 'vote', [0n, 2, 1n]), /Ended/);
  await p.send('bob', 'release', [0n]);
  assert.equal(await z.call('balanceOf', [a('bob')]), 100_000n * ZETA, 'all of bob\'s ZEARLY back');
  await p.send('alice', 'release', [0n]);
  assert.equal(await z.call('balanceOf', [a('alice')]), 100_000n * ZETA, 'the deposit back');
  await assert.rejects(p.send('alice', 'release', [0n]), /NothingLocked/);
});

// ---------------------------------------------------------------- the operations (src/earlyops.js), real signed txs
import { readFileSync } from 'node:fs';
import { ContractFactory, Contract, parseEther } from 'ethers';
import { createRpcChain } from './helpers/rpcchain.js';
import { createPool, deployExtras, minters, swappers, payQuests, QUESTS } from '../src/earlyops.js';

const dexArt = (n) => JSON.parse(readFileSync(new URL(`../../zetaphy-dex/artifacts/${n}.json`, import.meta.url), 'utf8'));
const dexDeploy = async (n, args, s) => { const c = await new ContractFactory(dexArt(n).abi, dexArt(n).bytecode, s).deploy(...args); await c.waitForDeployment(); return c; };

test('ops: pool on the Swap, extras deployed and funded, quests found from the chain and paid once', async () => {
  const c = await createRpcChain({ accounts: 4 });
  const [drop, bob, carol, dave] = c.signers;
  const wz = await dexDeploy('WZETAPHY', [], drop);
  const factory = await dexDeploy('ZetaphyFactory', [drop.address], drop);
  const router = await dexDeploy('ZetaphyRouter', [await factory.getAddress(), await wz.getAddress()], drop);
  const dex = { router: await router.getAddress(), factory: await factory.getAddress() };
  const from = c.blockNumber();
  const z = await c.deploy('ZetaphyEarly', [drop.address], drop);
  const token = await z.getAddress();

  const { pair } = await createPool({ signer: drop, token, dex, zearly: 10_000_000, ztphy: 1000 });
  const ex = await deployExtras({ signer: drop, token, pair, now: Number(c.now()) });
  for (const k of ['pass', 'quests', 'farm', 'polls']) assert.match(ex[k], /^0x[0-9a-fA-F]{40}$/, k);
  assert.equal(await z.balanceOf(ex.quests), parseEther('100000000'));
  const farm = c.at('ZetaphyEarlyFarm', ex.farm);
  assert.ok((await farm.rewardRate()) > 0n, 'the farm streams rewards');

  // bob swaps ZETAPHY for ZEARLY, then mints a pass; carol adds liquidity; dave does nothing
  const deadline = BigInt(Number(c.now()) + 3600);
  await (await router.connect(bob).swapExactETHForTokens(0n, [await wz.getAddress(), token], bob.address, deadline, { value: parseEther('10') })).wait();
  await (await z.transfer(bob.address, parseEther('20000'))).wait();
  await (await z.connect(bob).approve(ex.pass, parseEther('1000'))).wait();
  await (await c.at('ZetaphyEarlyPass', ex.pass, bob).mint()).wait();
  await (await z.transfer(carol.address, parseEther('5000'))).wait();
  await (await z.connect(carol).approve(dex.router, parseEther('5000'))).wait();
  await (await router.connect(carol).addLiquidityETH(token, parseEther('5000'), 0n, 0n, carol.address, deadline, { value: parseEther('1') })).wait();

  const head = c.blockNumber();
  const found = {
    swap: await swappers(c.provider, dex.factory, from, head),
    liquidity: await minters(c.provider, pair, from, head),
    pass: await minters(c.provider, ex.pass, from, head),
    stake: [dave.address],
  };
  assert.deepEqual(found.swap, [bob.address]);
  assert.ok(found.liquidity.includes(carol.address) && found.liquidity.includes(drop.address));
  assert.deepEqual(found.pass, [bob.address]);

  const skip = new Set([drop.address]);
  const dry = await payQuests({ quests: ex.quests, provider: c.provider, found, skip });
  assert.deepEqual(dry.map((r) => r.toPay), [1, 1, 1, 1]);
  const before = await z.balanceOf(bob.address);
  await payQuests({ quests: ex.quests, signer: drop, provider: c.provider, found, skip, send: true });
  assert.equal(await z.balanceOf(bob.address) - before, parseEther(String(QUESTS[0].reward + QUESTS[2].reward)), 'bob: swap + pass');
  assert.equal(await z.balanceOf(dave.address), parseEther(String(QUESTS[3].reward)), 'dave: staking');
  const again = await payQuests({ quests: ex.quests, signer: drop, provider: c.provider, found, skip, send: true });
  assert.deepEqual(again.map((r) => r.toPay), [0, 0, 0, 0], 'nobody twice');
});
