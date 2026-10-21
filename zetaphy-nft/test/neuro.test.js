// The marketplace against the REAL Neuro ThreatRegistry (zetaphy-network's
// committed artifacts): bonded NeuroJobs runners with a track record vote a
// flag on a collection's address key, or on the code key that every factory
// collection of a kind shares; the marketplace refuses once the flag is
// enforced (after enforceDelay), not while it is only a newer, not-yet-enforced
// flag (the web app warns then). Governance protecting a key lifts it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { createChain, ZETA } from './helpers/chain.js';

const NET = new URL('../../zetaphy-network/artifacts/', import.meta.url);
const art = (n) => JSON.parse(readFileSync(new URL(`${n}.json`, NET), 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000';
const BOND = 100n * ZETA;
const V = '0x' + '11'.repeat(32);
const REPORT = '0x' + 'e7'.repeat(32);
const R = { UnlimitedMint: 2, OwnerCanBlockTransfers: 3 };
const DELAY = 3600n;
const coder = AbiCoder.defaultAbiCoder();

let c, jobs, reg, market, factory, nft;
const A = (n) => c.addr(n);
const exp = () => c.now() + 86_400n;

beforeEach(async () => {
  c = await createChain(['owner', 'user', 'w1', 'w2', 'w3', 'w4', 'seller', 'buyer']);
  // Runners with a track record, as zetaphy-network/test/threat.test.js sets them up.
  jobs = await c.deployArtifact(art('NeuroJobs'), [BOND, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'owner');
  for (const w of ['w1', 'w2', 'w3', 'w4']) await jobs.send(w, 'register', [], BOND);
  c.advance(1);
  for (const seats of [['w1', 'w2', 'w3'], ['w4', 'w1', 'w2']]) {
    await jobs.send('user', 'request', [encodeBytes32String('bsc'), '0xabc'], ZETA / 10n);
    const id = (await jobs.call('jobCount')) - 1n;
    const salts = {};
    for (const w of seats) {
      salts[w] = hexlify(randomBytes(32));
      await jobs.send(w, 'commit', [id, keccak256(coder.encode(['bytes32', 'address', 'bytes32'], [V, A(w), salts[w]]))]);
    }
    for (const w of seats) await jobs.send(w, 'reveal', [id, V, salts[w]]).catch(() => {});
  }
  reg = await c.deployArtifact(art('ThreatRegistry'), [jobs.address, 3, 1, A('owner'), DELAY], 'owner');
  factory = await c.deploy('NFTFactory', [], 'owner');
  market = await c.deploy('NFTMarketplace', [A('owner'), A('owner'), 100, reg.address], 'owner');
  const ev = await factory.send('seller', 'createERC721', [{ name: 'N', symbol: 'N', baseURI: '', contractURI: '', royaltyReceiver: ZERO,
    royaltyBps: 0, maxSupply: 0, publicMint: false, mintPrice: 0 }]);
  nft = c.at(ev.find((e) => e.name === 'CollectionCreated').args.collection, 'ZetaphyERC721');
  await nft.send('seller', 'mintMany', [A('seller'), 4]);
  await nft.send('seller', 'setApprovalForAll', [market.address, true]);
});

async function flag(key, reason) {
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [key, true, reason, REPORT, 'neuro:zetaphy:test']);
}

test('address flag: listed while only flagged (newer flag), refused once enforced', async () => {
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]);
  const key = await reg.call('addressKey', [1, nft.address]); // this EVM's chain id is 1
  await flag(key, R.OwnerCanBlockTransfers);
  assert.deepEqual([...await reg.call('isContractFlagged', [nft.address])], [true, 3n]);
  assert.deepEqual([...await reg.call('isContractEnforced', [nft.address])], [false, 0n]);
  // Not enforced yet: the market still works (the web app shows the warning).
  await market.send('seller', 'list', [nft.address, 2, 1, ZETA, exp()]);
  await market.send('buyer', 'buy', [1, 1], ZETA);
  c.advance(DELAY);
  assert.deepEqual([...await reg.call('isContractEnforced', [nft.address])], [true, 3n]);
  await assert.rejects(market.send('seller', 'list', [nft.address, 3, 1, ZETA, exp()]), /CollectionRefused/);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /CollectionRefused/);
  await assert.rejects(market.send('buyer', 'makeOffer', [nft.address, 3, 1, exp()], ZETA), /CollectionRefused/);
  assert.equal(await market.call('listingStatus', [0, 1]), 6n);
  await market.send('seller', 'cancel', [0]);
  // Governance protects the key: the flag is cleared and trading resumes.
  await reg.send('owner', 'setProtected', [[key], true]);
  await market.send('seller', 'list', [nft.address, 3, 1, ZETA, exp()]);
});

test('code flag: every factory collection of that kind shares the code hash, so governance should protect it', async () => {
  const ev = await factory.send('buyer', 'createERC721', [{ name: 'Other', symbol: 'O', baseURI: '', contractURI: '', royaltyReceiver: ZERO,
    royaltyBps: 0, maxSupply: 0, publicMint: false, mintPrice: 0 }]);
  const other = ev.find((e) => e.name === 'CollectionCreated').args.collection;
  const codeHash = keccak256(await c.code(nft.address));
  assert.equal(codeHash, keccak256(await c.code(other)));
  const key = await reg.call('codeKey', [codeHash]);
  await flag(key, R.UnlimitedMint);
  c.advance(DELAY);
  assert.deepEqual([...await reg.call('isContractEnforced', [other])], [true, 2n]);
  await assert.rejects(market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]), /CollectionRefused/);
  // Protecting the shared code key (README: do this for the trusted factory's code) lifts it for all.
  await reg.send('owner', 'setProtected', [[key], true]);
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]);
});
