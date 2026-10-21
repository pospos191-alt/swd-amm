// The collections the factory makes: ERC-721 and ERC-1155 behaviour, ERC-165,
// safe-transfer receiver checks, EIP-2981 royalty caps, max supply, public mint.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChain, ZETA } from './helpers/chain.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const IID = { erc165: '0x01ffc9a7', erc721: '0x80ac58cd', erc721Meta: '0x5b5e139f', erc1155: '0xd9b67a26', erc1155Meta: '0x0e89341c', erc2981: '0x2a55205a', none: '0xffffffff', erc721Enum: '0x780e9d63' };

let c, factory;
const A = (n) => c.addr(n);
export const config = (over = {}) => ({
  name: 'Siam Cats', symbol: 'SCAT', baseURI: 'ipfs://bafybase/', contractURI: 'ipfs://bafycontract',
  royaltyReceiver: ZERO, royaltyBps: 0, maxSupply: 0, publicMint: false, mintPrice: 0, ...over,
});

async function create(kind, over = {}, from = 'creator') {
  const ev = await factory.send(from, kind === 721 ? 'createERC721' : 'createERC1155', [config(over)]);
  const created = ev.find((e) => e.name === 'CollectionCreated');
  return c.at(created.args.collection, kind === 721 ? 'ZetaphyERC721' : 'ZetaphyERC1155');
}

beforeEach(async () => {
  c = await createChain(['creator', 'alice', 'bob', 'carol']);
  factory = await c.deploy('NFTFactory', [], 'creator');
});

test('factory: anyone creates both kinds; the caller owns them; isCollection / kindOf / paging', async () => {
  const a = await create(721);
  const b = await create(1155, {}, 'alice');
  assert.equal(await a.call('owner'), A('creator'));
  assert.equal(await b.call('owner'), A('alice'));
  assert.equal(await factory.call('isCollection', [a.address]), true);
  assert.equal(await factory.call('kindOf', [a.address]), 1n);
  assert.equal(await factory.call('kindOf', [b.address]), 2n);
  assert.equal(await factory.call('isCollection', [A('bob')]), false);
  assert.equal(await factory.call('collectionCount'), 2n);
  const low = (xs) => [...xs].map((x) => x.toLowerCase());
  assert.deepEqual(low(await factory.call('collections', [0, 10])), low([a.address, b.address]));
  assert.deepEqual([...await factory.call('collections', [1, 10])].length, 1);
  assert.deepEqual([...await factory.call('collections', [5, 10])].length, 0);
  // Every collection of a kind has the same runtime code (one code hash to review).
  const a2 = await create(721, { name: 'Other', maxSupply: 5, royaltyBps: 500, royaltyReceiver: A('bob') });
  assert.equal(await c.code(a.address), await c.code(a2.address));
  // Only the factory may use its deployers.
  const dep = c.at(await factory.call('erc721Deployer'), 'ERC721Deployer');
  await assert.rejects(dep.send('alice', 'deploy', [config(), A('alice')]), /factory only/);
});

test('ERC-165 answers exactly the implemented interfaces', async () => {
  const a = await create(721);
  const b = await create(1155);
  for (const [k, yes] of Object.entries({ erc165: 1, erc721: 1, erc721Meta: 1, erc2981: 1, erc1155: 0, erc1155Meta: 0, none: 0, erc721Enum: 0 })) {
    assert.equal(await a.call('supportsInterface', [IID[k]]), !!yes, `721 ${k}`);
  }
  for (const [k, yes] of Object.entries({ erc165: 1, erc1155: 1, erc1155Meta: 1, erc2981: 1, erc721: 0, erc721Meta: 0, none: 0 })) {
    assert.equal(await b.call('supportsInterface', [IID[k]]), !!yes, `1155 ${k}`);
  }
});

test('ERC-721: owner mints (own URI or base URI), metadata views, balances', async () => {
  const a = await create(721);
  const ev = await a.send('creator', 'mint', [A('alice'), 'ipfs://bafyone/meta.json']);
  assert.deepEqual(ev.map((e) => e.name), ['Transfer']);
  assert.equal(ev[0].args.from, ZERO);
  assert.equal(ev[0].args.tokenId, 1n);
  await a.send('creator', 'mintMany', [A('bob'), 3]);
  assert.equal(await a.call('tokenURI', [1]), 'ipfs://bafyone/meta.json');
  assert.equal(await a.call('tokenURI', [3]), 'ipfs://bafybase/3');
  assert.equal(await a.call('name'), 'Siam Cats');
  assert.equal(await a.call('symbol'), 'SCAT');
  assert.equal(await a.call('contractURI'), 'ipfs://bafycontract');
  assert.equal(await a.call('balanceOf', [A('bob')]), 3n);
  assert.equal(await a.call('ownerOf', [4]), A('bob'));
  assert.equal(await a.call('totalSupply'), 4n);
  await assert.rejects(a.call('ownerOf', [5]), /NonexistentToken/);
  await assert.rejects(a.call('tokenURI', [5]), /NonexistentToken/);
  await assert.rejects(a.call('balanceOf', [ZERO]), /InvalidOwner/);
  await assert.rejects(a.send('alice', 'mint', [A('alice'), '']), /NotOwner/);
  await assert.rejects(a.send('creator', 'mintMany', [A('bob'), 0]), /BadQuantity/);
  await assert.rejects(a.send('creator', 'mintMany', [A('bob'), 51]), /BadQuantity/);
  await assert.rejects(a.send('creator', 'mint', [ZERO, '']), /InvalidReceiver/);
  await assert.rejects(a.send('creator', 'mint', [A('alice'), 'x'.repeat(8193)]), /UriTooLong/);
  // No base URI and no own URI: empty.
  const p = await create(721, { baseURI: '' });
  await p.send('creator', 'mint', [A('alice'), '']);
  assert.equal(await p.call('tokenURI', [1]), '');
});

test('ERC-721: transfers, approvals, operators; who may move a token', async () => {
  const a = await create(721);
  await a.send('creator', 'mintMany', [A('alice'), 2]);
  await assert.rejects(a.send('bob', 'transferFrom', [A('alice'), A('bob'), 1]), /NotAuthorized/);
  await assert.rejects(a.send('alice', 'transferFrom', [A('bob'), A('carol'), 1]), /IncorrectOwner/);
  await assert.rejects(a.send('alice', 'transferFrom', [A('alice'), ZERO, 1]), /InvalidReceiver/);
  await assert.rejects(a.send('bob', 'approve', [A('bob'), 1]), /NotAuthorized/);
  const ap = await a.send('alice', 'approve', [A('bob'), 1]);
  assert.equal(ap[0].name, 'Approval');
  assert.equal(await a.call('getApproved', [1]), A('bob'));
  await a.send('bob', 'transferFrom', [A('alice'), A('carol'), 1]);
  assert.equal(await a.call('ownerOf', [1]), A('carol'));
  assert.equal(await a.call('getApproved', [1]), ZERO, 'approval cleared by the transfer');
  await assert.rejects(a.send('bob', 'transferFrom', [A('carol'), A('bob'), 1]), /NotAuthorized/);
  await a.send('alice', 'setApprovalForAll', [A('carol'), true]);
  assert.equal(await a.call('isApprovedForAll', [A('alice'), A('carol')]), true);
  await a.send('carol', 'safeTransferFrom(address,address,uint256)', [A('alice'), A('bob'), 2]);
  assert.equal(await a.call('ownerOf', [2]), A('bob'));
  assert.equal(await a.call('balanceOf', [A('alice')]), 0n);
  await assert.rejects(a.send('alice', 'setApprovalForAll', [ZERO, true]), /ZeroAddress/);
  // An operator may approve for the owner.
  await a.send('bob', 'setApprovalForAll', [A('alice'), true]);
  await a.send('alice', 'approve', [A('carol'), 2]);
  assert.equal(await a.call('getApproved', [2]), A('carol'));
  // Burn: holder or approved; still counts toward the cap.
  await assert.rejects(a.send('bob', 'burn', [1]), /NotAuthorized/);
  await a.send('carol', 'burn', [1]);
  await assert.rejects(a.call('ownerOf', [1]), /NonexistentToken/);
  assert.equal(await a.call('totalSupply'), 1n);
  assert.equal(await a.call('totalMinted'), 2n);
});

test('ERC-721: safe transfers and safe mints check contract receivers', async () => {
  const a = await create(721);
  const good = await c.deploy('Receiver', [0], 'alice');
  const wrong = await c.deploy('Receiver', [1], 'alice');
  const says = await c.deploy('Receiver', [2], 'alice');
  const empty = await c.deploy('Receiver', [3], 'alice');
  const none = await c.deploy('NotAReceiver', [], 'alice');
  // Mint to contracts: the same checks.
  await a.send('creator', 'mint', [good.address, '']);
  assert.equal(await a.call('ownerOf', [1]), good.address);
  await assert.rejects(a.send('creator', 'mint', [wrong.address, '']), /InvalidReceiver/);
  await assert.rejects(a.send('creator', 'mint', [says.address, '']), /receiver says no/);
  await assert.rejects(a.send('creator', 'mint', [empty.address, '']), /InvalidReceiver/);
  await assert.rejects(a.send('creator', 'mint', [none.address, '']), /InvalidReceiver/);
  await a.send('creator', 'mintMany', [A('alice'), 2]); // ids 2, 3
  const safe = 'safeTransferFrom(address,address,uint256)';
  const safeData = 'safeTransferFrom(address,address,uint256,bytes)';
  await assert.rejects(a.send('alice', safe, [A('alice'), wrong.address, 2]), /InvalidReceiver/);
  await assert.rejects(a.send('alice', safeData, [A('alice'), says.address, 2, '0x1234']), /receiver says no/);
  await assert.rejects(a.send('alice', safe, [A('alice'), none.address, 2]), /InvalidReceiver/);
  assert.equal(await a.call('ownerOf', [2]), A('alice'), 'a failed safe transfer moves nothing');
  await a.send('alice', safeData, [A('alice'), good.address, 2, '0x1234']);
  assert.equal(await a.call('ownerOf', [2]), good.address);
  // Plain transferFrom does not ask (ERC-721): the caller's responsibility.
  await a.send('alice', 'transferFrom', [A('alice'), none.address, 3]);
  assert.equal(await a.call('ownerOf', [3]), none.address);
});

test('ERC-721: max supply (reserved before receiver callbacks), can only go down', async () => {
  const a = await create(721, { maxSupply: 3 });
  await a.send('creator', 'mintMany', [A('alice'), 2]);
  await assert.rejects(a.send('creator', 'mintMany', [A('alice'), 2]), /MaxSupplyReached/);
  await a.send('creator', 'mint', [A('alice'), '']);
  await assert.rejects(a.send('creator', 'mint', [A('alice'), '']), /MaxSupplyReached/);
  await a.send('alice', 'burn', [1]);
  await assert.rejects(a.send('creator', 'mint', [A('alice'), '']), /MaxSupplyReached/, 'burns do not free slots');
  await assert.rejects(a.send('creator', 'setMaxSupply', [4]), /BadMaxSupply/);
  await assert.rejects(a.send('creator', 'setMaxSupply', [2]), /BadMaxSupply/);
  await assert.rejects(a.send('creator', 'setMaxSupply', [0]), /BadMaxSupply/);
  await a.send('creator', 'setMaxSupply', [3]);
  const u = await create(721);
  await u.send('creator', 'mintMany', [A('alice'), 2]);
  await u.send('creator', 'setMaxSupply', [10]);
  assert.equal(await u.call('maxSupply'), 10n);
});

test('public mint: closed by default, exact price, proceeds withdrawn by the owner only', async () => {
  const a = await create(721, { mintPrice: 2n * ZETA });
  await assert.rejects(a.send('alice', 'publicMintTo', [A('alice'), 1], 2n * ZETA), /PublicMintClosed/);
  await a.send('creator', 'setMint', [true, 2n * ZETA]);
  await assert.rejects(a.send('alice', 'publicMintTo', [A('alice'), 2], 3n * ZETA), /WrongPayment/);
  await assert.rejects(a.send('alice', 'publicMintTo', [A('alice'), 2], 5n * ZETA), /WrongPayment/);
  await a.send('alice', 'publicMintTo', [A('alice'), 2], 4n * ZETA);
  assert.equal(await a.call('balanceOf', [A('alice')]), 2n);
  assert.equal(await c.balance(a.address), 4n * ZETA);
  await assert.rejects(a.send('alice', 'withdraw'), /NotOwner/);
  const before = await c.balance('creator');
  await a.send('creator', 'withdraw');
  assert.equal(await c.balance('creator') - before, 4n * ZETA);
  // Free public mint (price 0).
  await a.send('creator', 'setMint', [true, 0]);
  await a.send('bob', 'publicMintTo', [A('bob'), 1]);
  assert.equal(await a.call('ownerOf', [3]), A('bob'));
});

test('royalty: EIP-2981 amounts, capped at 10% on create and on change', async () => {
  await assert.rejects(create(721, { royaltyBps: 1001, royaltyReceiver: A('creator') }), /RoyaltyTooHigh/);
  await assert.rejects(create(1155, { royaltyBps: 1001, royaltyReceiver: A('creator') }), /RoyaltyTooHigh/);
  await assert.rejects(create(721, { royaltyBps: 100, royaltyReceiver: ZERO }), /ZeroAddress/);
  const a = await create(721, { royaltyBps: 1000, royaltyReceiver: A('carol') });
  const [r, amt] = await a.call('royaltyInfo', [1, 12345n]);
  assert.equal(r, A('carol'));
  assert.equal(amt, 1234n); // floor(12345 * 10%)
  await assert.rejects(a.send('creator', 'setRoyalty', [A('bob'), 1001]), /RoyaltyTooHigh/);
  await assert.rejects(a.send('alice', 'setRoyalty', [A('bob'), 100]), /NotOwner/);
  await a.send('creator', 'setRoyalty', [A('bob'), 250]);
  assert.deepEqual([...await a.call('royaltyInfo', [9, ZETA])], [A('bob'), ZETA / 40n]);
  await a.send('creator', 'setRoyalty', [A('bob'), 0]);
  assert.deepEqual([...await a.call('royaltyInfo', [9, ZETA])], [ZERO, 0n]);
});

test('metadata: base/contract URI changeable until frozen; ownership transfer and renounce', async () => {
  const a = await create(721);
  await a.send('creator', 'mintMany', [A('alice'), 1]);
  await a.send('creator', 'setBaseURI', ['https://example.org/m/']);
  assert.equal(await a.call('tokenURI', [1]), 'https://example.org/m/1');
  await a.send('creator', 'freezeMetadata');
  await assert.rejects(a.send('creator', 'setBaseURI', ['ipfs://x/']), /Frozen/);
  await assert.rejects(a.send('creator', 'setContractURI', ['ipfs://x']), /Frozen/);
  await assert.rejects(a.send('alice', 'transferOwnership', [A('alice')]), /NotOwner/);
  await assert.rejects(a.send('creator', 'transferOwnership', [ZERO]), /ZeroAddress/);
  await a.send('creator', 'transferOwnership', [A('alice')]);
  assert.equal(await a.call('owner'), A('alice'));
  // Anyone can force ZETAPHY in (selfdestruct): renouncing still works and sweeps it to the owner.
  await c.deploy('ForceSend', [a.address], 'bob', 1n);
  assert.equal(await c.balance(a.address), 1n);
  const before = await c.balance('alice');
  const ev = await a.send('alice', 'renounceOwnership');
  assert.deepEqual(ev.map((e) => e.name), ['OwnershipTransferred', 'Withdrawn']);
  assert.equal(await c.balance('alice') - before, 1n);
  assert.equal(await c.balance(a.address), 0n);
  assert.equal(await a.call('owner'), ZERO);
  await assert.rejects(a.send('alice', 'mint', [A('alice'), '']), /NotOwner/);
  await assert.rejects(a.send('alice', 'renounceOwnership'), /NotOwner/);
});

test('ERC-1155: create ids, mint amounts, per-id max supply, URIs, balances', async () => {
  const b = await create(1155, { maxSupply: 100, baseURI: 'ipfs://bafybase/{id}.json' });
  const ev = await b.send('creator', 'create', [A('alice'), 10, 'ipfs://bafyown']);
  assert.deepEqual(ev.map((e) => e.name), ['URI', 'TransferSingle']);
  assert.equal(ev[1].args.id, 1n);
  assert.equal(ev[1].args.value, 10n);
  await b.send('creator', 'create', [A('bob'), 0, '']); // id 2, nothing minted yet
  assert.equal(await b.call('uri', [1]), 'ipfs://bafyown');
  assert.equal(await b.call('uri', [2]), 'ipfs://bafybase/{id}.json');
  assert.equal(await b.call('tokenCount'), 2n);
  await b.send('creator', 'mint', [A('bob'), 2, 60]);
  await assert.rejects(b.send('creator', 'mint', [A('bob'), 2, 41]), /MaxSupplyReached/);
  await b.send('creator', 'mint', [A('carol'), 2, 40]);
  await assert.rejects(b.send('creator', 'mint', [A('bob'), 3, 1]), /NonexistentToken/);
  await assert.rejects(b.send('creator', 'mint', [A('bob'), 0, 1]), /NonexistentToken/);
  await assert.rejects(b.send('alice', 'mint', [A('bob'), 1, 1]), /NotOwner/);
  assert.equal(await b.call('balanceOf', [A('alice'), 1]), 10n);
  assert.deepEqual([...await b.call('balanceOfBatch', [[A('alice'), A('bob'), A('carol')], [1, 2, 2]])], [10n, 60n, 40n]);
  await assert.rejects(b.call('balanceOfBatch', [[A('alice')], [1, 2]]), /LengthMismatch/);
  assert.equal(await b.call('totalSupply', [2]), 100n);
  // The cap can go down only to the most-minted id's count.
  await assert.rejects(b.send('creator', 'setMaxSupply', [99]), /BadMaxSupply/);
  await b.send('creator', 'setMaxSupply', [100]);
  // Public mint per unit.
  await b.send('creator', 'setMint', [true, ZETA / 10n]);
  await assert.rejects(b.send('bob', 'publicMintTo', [A('bob'), 1, 5], ZETA / 10n * 4n), /WrongPayment/);
  await b.send('bob', 'publicMintTo', [A('bob'), 1, 5], ZETA / 2n);
  assert.equal(await b.call('balanceOf', [A('bob'), 1]), 5n);
  await assert.rejects(b.send('bob', 'publicMintTo', [A('bob'), 1, 0]), /BadQuantity/);
});

test('ERC-1155: transfers, batch transfers, operators, burns, receiver checks', async () => {
  const b = await create(1155);
  await b.send('creator', 'create', [A('alice'), 10, '']);
  await b.send('creator', 'create', [A('alice'), 5, '']);
  const t = await b.send('alice', 'safeTransferFrom', [A('alice'), A('bob'), 1, 4, '0x']);
  assert.equal(t[0].name, 'TransferSingle');
  assert.equal(t[0].args.operator, A('alice'));
  await assert.rejects(b.send('alice', 'safeTransferFrom', [A('alice'), A('bob'), 1, 7, '0x']), /InsufficientBalance/);
  await assert.rejects(b.send('bob', 'safeTransferFrom', [A('alice'), A('bob'), 1, 1, '0x']), /NotAuthorized/);
  await assert.rejects(b.send('alice', 'safeTransferFrom', [A('alice'), ZERO, 1, 1, '0x']), /InvalidReceiver/);
  await b.send('alice', 'setApprovalForAll', [A('carol'), true]);
  const bt = await b.send('carol', 'safeBatchTransferFrom', [A('alice'), A('bob'), [1, 2], [6, 5], '0x']);
  assert.equal(bt[0].name, 'TransferBatch');
  assert.deepEqual([...await b.call('balanceOfBatch', [[A('alice'), A('bob'), A('bob')], [1, 1, 2]])], [0n, 10n, 5n]);
  await assert.rejects(b.send('bob', 'safeBatchTransferFrom', [A('bob'), A('alice'), [1, 2], [1], '0x']), /LengthMismatch/);
  await assert.rejects(b.send('bob', 'safeBatchTransferFrom', [A('bob'), A('alice'), [1, 2], [1, 6], '0x']), /InsufficientBalance/);
  // Receivers.
  const good = await c.deploy('Receiver', [0], 'alice');
  const wrong = await c.deploy('Receiver', [1], 'alice');
  const says = await c.deploy('Receiver', [2], 'alice');
  const none = await c.deploy('NotAReceiver', [], 'alice');
  for (const [r, err] of [[wrong, /InvalidReceiver/], [says, /receiver says no/], [none, /InvalidReceiver/]]) {
    await assert.rejects(b.send('bob', 'safeTransferFrom', [A('bob'), r.address, 1, 1, '0x']), err);
    await assert.rejects(b.send('bob', 'safeBatchTransferFrom', [A('bob'), r.address, [1], [1], '0x']), err);
    await assert.rejects(b.send('creator', 'mint', [r.address, 1, 1]), err);
    await assert.rejects(b.send('creator', 'create', [r.address, 1, '']), err);
  }
  await b.send('bob', 'safeTransferFrom', [A('bob'), good.address, 1, 1, '0xab']);
  await b.send('bob', 'safeBatchTransferFrom', [A('bob'), good.address, [1, 2], [1, 1], '0x']);
  assert.equal(await b.call('balanceOf', [good.address, 1]), 2n);
  // Burn.
  await assert.rejects(b.send('carol', 'burn', [A('bob'), 1, 1]), /NotAuthorized/);
  await b.send('bob', 'burn', [A('bob'), 1, 3]);
  assert.equal(await b.call('balanceOf', [A('bob'), 1]), 5n);
  assert.equal(await b.call('totalSupply', [1]), 7n);
  await assert.rejects(b.send('bob', 'burn', [A('bob'), 1, 6]), /InsufficientBalance/);
});
