// NFTMarketplace: list / buy / cancel / expire, offers, fee and royalty math to
// the wei, pull payments, reentrancy attempts, stale listings, ERC-1155
// amounts, ERC-165 detection, and the Neuro ThreatRegistry refusal.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChain, ZETA } from './helpers/chain.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const DAY = 86_400n;
const S = { Ok: 0n, Inactive: 1n, Expired: 2n, SellerCancelledAll: 3n, SellerLacksToken: 4n, NotApproved: 5n, Refused: 6n };

let c, factory, market, nft, multi;
const A = (n) => c.addr(n);
const exp = (secs = 7n * DAY) => c.now() + secs;
const cfg = (over = {}) => ({ name: 'Siam', symbol: 'SIAM', baseURI: 'ipfs://base/', contractURI: '', royaltyReceiver: ZERO,
  royaltyBps: 0, maxSupply: 0, publicMint: false, mintPrice: 0, ...over });

async function create(kind, over = {}, from = 'seller') {
  const ev = await factory.send(from, kind === 721 ? 'createERC721' : 'createERC1155', [cfg(over)]);
  return c.at(ev.find((e) => e.name === 'CollectionCreated').args.collection, kind === 721 ? 'ZetaphyERC721' : 'ZetaphyERC1155');
}
/** owed[] of several accounts. */
const owed = async (...names) => Promise.all(names.map((n) => market.call('owed', [n.startsWith('0x') ? n : A(n)])));
const evOf = (events, name) => events.find((e) => e.name === name);

beforeEach(async () => {
  c = await createChain(['gov', 'feeTo', 'seller', 'buyer', 'other', 'artist']);
  factory = await c.deploy('NFTFactory', [], 'gov');
  market = await c.deploy('NFTMarketplace', [A('gov'), A('feeTo'), 100, ZERO], 'gov'); // 1% fee, no registry
  nft = await create(721, { royaltyReceiver: A('artist'), royaltyBps: 500 }); // 5% royalty
  await nft.send('seller', 'mintMany', [A('seller'), 5]);
  await nft.send('seller', 'setApprovalForAll', [market.address, true]);
  multi = await create(1155, { royaltyReceiver: A('artist'), royaltyBps: 250 }); // 2.5%
  await multi.send('seller', 'create', [A('seller'), 10, '']);
  await multi.send('seller', 'setApprovalForAll', [market.address, true]);
});

test('ERC-721 list and buy: fee and royalty to the wei, NFT to the buyer, pull payments', async () => {
  const price = 1_234_567_890_123_456_789n;
  const ev = await market.send('seller', 'list', [nft.address, 1, 1, price, exp()]);
  const listed = evOf(ev, 'Listed');
  assert.equal(listed.args.id, 0n);
  assert.equal(listed.args.unitPrice, price);
  assert.equal(await market.call('listingStatus', [0, 1]), S.Ok);
  const fee = price * 100n / 10_000n; // 12345678901234567
  const royalty = price * 500n / 10_000n; // 61728394506172839
  assert.equal(fee, 12_345_678_901_234_567n);
  assert.equal(royalty, 61_728_394_506_172_839n);
  const q = await market.call('quote', [nft.address, 1, price]);
  assert.deepEqual([...q], [fee, royalty, A('artist'), price - fee - royalty]);

  const buyerBefore = await c.balance('buyer');
  const sold = evOf(await market.send('buyer', 'buy', [0, 1], price), 'Sold');
  assert.equal(sold.args.price, price);
  assert.equal(sold.args.fee, fee);
  assert.equal(sold.args.royalty, royalty);
  assert.equal(await nft.call('ownerOf', [1]), A('buyer'));
  assert.equal(buyerBefore - await c.balance('buyer'), price); // gas price is 0 here
  assert.deepEqual(await owed('seller', 'feeTo', 'artist'), [price - fee - royalty, fee, royalty]);
  assert.equal(await c.balance(market.address), price);
  // Pull: each takes its own.
  for (const [who, amount] of [['seller', price - fee - royalty], ['feeTo', fee], ['artist', royalty]]) {
    const before = await c.balance(who);
    const w = evOf(await market.send(who, 'withdraw'), 'Withdrawn');
    assert.equal(w.args.amount, amount);
    assert.equal(await c.balance(who) - before, amount);
  }
  assert.equal(await c.balance(market.address), 0n);
  await assert.rejects(market.send('seller', 'withdraw'), /NothingOwed/);
  // Sold out.
  await assert.rejects(market.send('buyer', 'buy', [0, 1], price), /NotActive/);
  assert.equal(await market.call('listingStatus', [0, 1]), S.Inactive);
});

test('list: checks the token, the price, the expiry, holding and approval', async () => {
  await assert.rejects(market.send('seller', 'list', [A('other'), 1, 1, ZETA, exp()]), /NotNFT/); // no code
  const bad165 = await c.deploy('BadERC165', [], 'seller');
  await assert.rejects(market.send('seller', 'list', [bad165.address, 1, 1, ZETA, exp()]), /NotNFT/);
  await assert.rejects(market.send('seller', 'list', [market.address, 1, 1, ZETA, exp()]), /NotNFT/);
  assert.equal(await market.call('kindOf', [nft.address]), 1n);
  assert.equal(await market.call('kindOf', [multi.address]), 2n);
  assert.equal(await market.call('kindOf', [bad165.address]), 0n);
  await assert.rejects(market.send('seller', 'list', [nft.address, 1, 2, ZETA, exp()]), /BadQuantity/);
  await assert.rejects(market.send('seller', 'list', [nft.address, 1, 0, ZETA, exp()]), /BadQuantity/);
  await assert.rejects(market.send('seller', 'list', [nft.address, 1, 1, 0, exp()]), /BadPrice/);
  await assert.rejects(market.send('seller', 'list', [multi.address, 1, 2, 2n ** 255n, exp()]), /Panic\(0x11\)/); // total overflows
  await assert.rejects(market.send('seller', 'list', [nft.address, 1, 1, ZETA, c.now()]), /BadExpiry/);
  await assert.rejects(market.send('seller', 'list', [nft.address, 1, 1, ZETA, c.now() + 366n * DAY]), /BadExpiry/);
  await assert.rejects(market.send('other', 'list', [nft.address, 1, 1, ZETA, exp()]), /SellerLacksToken/);
  await assert.rejects(market.send('seller', 'list', [nft.address, 99, 1, ZETA, exp()]), /SellerLacksToken/); // no such token
  await assert.rejects(market.send('seller', 'list', [multi.address, 1, 11, ZETA, exp()]), /SellerLacksToken/);
  await nft.send('seller', 'setApprovalForAll', [market.address, false]);
  await assert.rejects(market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]), /NotApproved/);
  // Approval of the single token is enough for ERC-721.
  await nft.send('seller', 'approve', [market.address, 1]);
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]);
  await market.send('buyer', 'buy', [0, 1], ZETA);
  assert.equal(await nft.call('ownerOf', [1]), A('buyer'));
});

test('buy: exact value only; cancel by the seller; cancelAll; expiry', async () => {
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp(DAY)]);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA - 1n), /WrongValue/);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA + 1n), /WrongValue/);
  await assert.rejects(market.send('buyer', 'buy', [0, 2], 2n * ZETA), /BadQuantity/);
  await assert.rejects(market.send('buyer', 'buy', [0, 0], 0n), /BadQuantity/);
  await assert.rejects(market.send('buyer', 'buy', [7, 1], ZETA), /NotActive/); // no such listing
  // Cancel.
  await assert.rejects(market.send('buyer', 'cancel', [0]), /NotSeller/);
  assert.ok(evOf(await market.send('seller', 'cancel', [0]), 'Cancelled'));
  await assert.rejects(market.send('seller', 'cancel', [0]), /NotActive/);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /NotActive/);
  // cancelAll: every earlier listing of this seller.
  await market.send('seller', 'list', [nft.address, 2, 1, ZETA, exp(DAY)]);
  await market.send('seller', 'list', [nft.address, 3, 1, ZETA, exp(DAY)]);
  await market.send('seller', 'cancelAll');
  assert.equal(await market.call('listingStatus', [1, 1]), S.SellerCancelledAll);
  await assert.rejects(market.send('buyer', 'buy', [2, 1], ZETA), /NotActive/);
  // A new listing after cancelAll works.
  await market.send('seller', 'list', [nft.address, 4, 1, ZETA, exp(DAY)]);
  // Expiry: buyable until the second before expiry.
  c.advance(DAY - 1n);
  assert.equal(await market.call('listingStatus', [3, 1]), S.Ok);
  c.advance(1);
  assert.equal(await market.call('listingStatus', [3, 1]), S.Expired);
  await assert.rejects(market.send('buyer', 'buy', [3, 1], ZETA), /Expired/);
  // The seller can still cancel an expired listing.
  await market.send('seller', 'cancel', [3]);
  assert.equal(await nft.call('ownerOf', [4]), A('seller'));
});

test('stale listing: the seller moved the token away or revoked approval', async () => {
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]);
  await nft.send('seller', 'transferFrom', [A('seller'), A('other'), 1]);
  assert.equal(await market.call('listingStatus', [0, 1]), S.SellerLacksToken);
  const before = await c.balance('buyer');
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /SellerLacksToken/);
  assert.equal(await c.balance('buyer'), before, 'nothing taken');
  // The new holder's approval of the market does not revive the old listing for them.
  await nft.send('other', 'setApprovalForAll', [market.address, true]);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /SellerLacksToken/);
  assert.equal(await nft.call('ownerOf', [1]), A('other'));
  // Revoked approval.
  await market.send('seller', 'list', [nft.address, 2, 1, ZETA, exp()]);
  await nft.send('seller', 'setApprovalForAll', [market.address, false]);
  assert.equal(await market.call('listingStatus', [1, 1]), S.NotApproved);
  await assert.rejects(market.send('buyer', 'buy', [1, 1], ZETA), /NotApproved/);
  // Two listings of one token: after one sells, the other is stale.
  await nft.send('seller', 'setApprovalForAll', [market.address, true]);
  await market.send('seller', 'list', [nft.address, 3, 1, ZETA, exp()]);
  await market.send('seller', 'list', [nft.address, 3, 1, 2n * ZETA, exp()]);
  await market.send('buyer', 'buy', [2, 1], ZETA);
  await assert.rejects(market.send('other', 'buy', [3, 1], 2n * ZETA), /SellerLacksToken/);
});

test('ERC-1155 amounts: partial buys, per-unit price, remaining quantity, holder checks', async () => {
  const unit = 333_333_333_333_333_333n;
  await market.send('seller', 'list', [multi.address, 1, 8, unit, exp()]);
  await assert.rejects(market.send('buyer', 'buy', [0, 3], unit * 2n), /WrongValue/);
  const sold = evOf(await market.send('buyer', 'buy', [0, 3], unit * 3n), 'Sold');
  const total = unit * 3n;
  assert.equal(sold.args.quantity, 3n);
  assert.equal(sold.args.fee, total / 100n);
  assert.equal(sold.args.royalty, total * 250n / 10_000n);
  assert.equal(await multi.call('balanceOf', [A('buyer'), 1]), 3n);
  assert.equal(await multi.call('balanceOf', [A('seller'), 1]), 7n);
  assert.equal((await market.call('getListing', [0])).quantity, 5n);
  await assert.rejects(market.send('buyer', 'buy', [0, 6], unit * 6n), /BadQuantity/);
  // The seller gives 4 of their 7 away: 3 left, the listing has 5.
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 4, '0x']);
  assert.equal(await market.call('listingStatus', [0, 4]), S.SellerLacksToken);
  assert.equal(await market.call('listingStatus', [0, 3]), S.Ok);
  assert.equal(await market.call('listingStatus', [0, 0]), S.SellerLacksToken, '0: all that is left (5)');
  await assert.rejects(market.send('buyer', 'buy', [0, 4], unit * 4n), /SellerLacksToken/);
  await market.send('other', 'buy', [0, 3], unit * 3n);
  assert.equal(await multi.call('balanceOf', [A('other'), 1]), 7n);
  assert.equal((await market.call('getListing', [0])).quantity, 2n);
  const [s, f, r] = await owed('seller', 'feeTo', 'artist');
  const t6 = unit * 3n;
  assert.equal(f, 2n * (t6 / 100n));
  assert.equal(r, 2n * (t6 * 250n / 10_000n));
  assert.equal(s + f + r, unit * 6n, 'every wei accounted for');
});

test('offers: escrowed value, accept by the holder, cancel, expiry, ERC-1155 quantity', async () => {
  const value = 777_777_777_777_777_777n;
  const made = evOf(await market.send('buyer', 'makeOffer', [nft.address, 2, 1, exp(DAY)], value), 'OfferMade');
  assert.equal(made.args.amount, value);
  assert.equal(await c.balance(market.address), value);
  await assert.rejects(market.send('buyer', 'makeOffer', [nft.address, 2, 1, exp(DAY)], 0n), /BadPrice/);
  await assert.rejects(market.send('buyer', 'makeOffer', [nft.address, 2, 2, exp(DAY)], 1n), /BadQuantity/);
  await assert.rejects(market.send('buyer', 'makeOffer', [A('other'), 2, 1, exp(DAY)], 1n), /NotNFT/);
  await assert.rejects(market.send('other', 'acceptOffer', [0]), /SellerLacksToken/);
  await nft.send('seller', 'setApprovalForAll', [market.address, false]);
  await assert.rejects(market.send('seller', 'acceptOffer', [0]), /NotApproved/);
  await nft.send('seller', 'setApprovalForAll', [market.address, true]);
  await assert.rejects(market.send('other', 'cancelOffer', [0]), /NotBuyer/);
  const acc = evOf(await market.send('seller', 'acceptOffer', [0]), 'OfferAccepted');
  const fee = value / 100n;
  const royalty = value * 500n / 10_000n;
  assert.equal(acc.args.fee, fee);
  assert.equal(acc.args.royalty, royalty);
  assert.equal(await nft.call('ownerOf', [2]), A('buyer'));
  assert.deepEqual(await owed('seller', 'feeTo', 'artist', 'buyer'), [value - fee - royalty, fee, royalty, 0n]);
  await assert.rejects(market.send('seller', 'acceptOffer', [0]), /NotActive/);
  await assert.rejects(market.send('buyer', 'cancelOffer', [0]), /NotActive/);

  // Cancel: the value is credited back to the buyer, who withdraws it.
  await market.send('buyer', 'makeOffer', [nft.address, 3, 1, exp(DAY)], ZETA);
  await market.send('buyer', 'cancelOffer', [1]);
  assert.deepEqual(await owed('buyer'), [ZETA]);
  const b = await c.balance('buyer');
  await market.send('buyer', 'withdraw');
  assert.equal(await c.balance('buyer') - b, ZETA);
  // Expired: cannot be accepted, but the buyer takes it back.
  await market.send('buyer', 'makeOffer', [nft.address, 3, 1, exp(DAY)], ZETA);
  c.advance(DAY);
  await assert.rejects(market.send('seller', 'acceptOffer', [2]), /Expired/);
  await market.send('buyer', 'cancelOffer', [2]);
  assert.deepEqual(await owed('buyer'), [ZETA]);
  // ERC-1155: all units at once.
  await market.send('buyer', 'makeOffer', [multi.address, 1, 4, exp(DAY)], 4n * ZETA);
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 7, '0x']); // 3 left
  await assert.rejects(market.send('seller', 'acceptOffer', [3]), /SellerLacksToken/);
  await multi.send('other', 'setApprovalForAll', [market.address, true]);
  await market.send('other', 'acceptOffer', [3]); // another holder may accept
  assert.equal(await multi.call('balanceOf', [A('buyer'), 1]), 4n);
  assert.equal(await multi.call('balanceOf', [A('other'), 1]), 3n);
});

test('protocol fee: governance only, capped at 5%; 0% works; governance hand-over', async () => {
  await assert.rejects(market.send('other', 'setFee', [50, A('other')]), /NotGovernance/);
  await assert.rejects(market.send('gov', 'setFee', [501, A('feeTo')]), /FeeTooHigh/);
  await assert.rejects(market.send('gov', 'setFee', [100, ZERO]), /ZeroAddress/);
  await assert.rejects(c.deploy('NFTMarketplace', [A('gov'), A('feeTo'), 501, ZERO], 'gov'), /FeeTooHigh/);
  await assert.rejects(c.deploy('NFTMarketplace', [ZERO, A('feeTo'), 100, ZERO], 'gov'), /ZeroAddress/);
  // Max fee + max royalty, odd price.
  const big = await create(721, { royaltyReceiver: A('artist'), royaltyBps: 1000 });
  await big.send('seller', 'mint', [A('seller'), '']);
  await big.send('seller', 'setApprovalForAll', [market.address, true]);
  await market.send('gov', 'setFee', [500, A('feeTo')]);
  const price = 999_999_999_999_999_999n;
  await market.send('seller', 'list', [big.address, 1, 1, price, exp()]);
  await market.send('buyer', 'buy', [0, 1], price);
  assert.deepEqual(await owed('feeTo', 'artist', 'seller'), [49_999_999_999_999_999n, 99_999_999_999_999_999n, 850_000_000_000_000_001n]);
  // 0%.
  await market.send('gov', 'setFee', [0, ZERO]);
  await market.send('seller', 'list', [nft.address, 1, 1, 10_000n, exp()]);
  const s = evOf(await market.send('buyer', 'buy', [1, 1], 10_000n), 'Sold');
  assert.equal(s.args.fee, 0n);
  assert.equal(s.args.royalty, 500n);
  await assert.rejects(market.send('gov', 'setGovernance', [ZERO]), /ZeroAddress/);
  await market.send('gov', 'setGovernance', [A('other')]);
  await assert.rejects(market.send('gov', 'setFee', [10, A('feeTo')]), /NotGovernance/);
  await market.send('other', 'setFee', [10, A('feeTo')]);
  assert.equal(await market.call('feeBps'), 10n);
});

test('royalty: capped at 10% of the price; failing or malformed royaltyInfo pays none', async () => {
  const cases = [[1, 'full price asked'], [2, 'reverts'], [3, 'dirty address'], [4, 'short answer'], [5, 'burns gas'], [0, 'zero amount']];
  for (const [mode, what] of cases) {
    const w = await c.deploy('WeirdRoyalty721', [cfg(), mode], 'seller');
    await w.send('seller', 'mint', [A('seller'), '']);
    await w.send('seller', 'setApprovalForAll', [market.address, true]);
    const id = await market.call('listingCount');
    await market.send('seller', 'list', [w.address, 1, 1, 12_345n, exp()]);
    const s = evOf(await market.send('buyer', 'buy', [id, 1], 12_345n), 'Sold');
    assert.equal(s.args.royalty, mode === 1 ? 1_234n : 0n, what);
    assert.equal(s.args.fee, 123n, what);
  }
  // A collection without EIP-2981 at all (receiver 0): no royalty.
  const plain = await create(721);
  await plain.send('seller', 'mint', [A('seller'), '']);
  await plain.send('seller', 'setApprovalForAll', [market.address, true]);
  const [, roy, recv] = await market.call('quote', [plain.address, 1, ZETA]);
  assert.equal(roy, 0n);
  assert.equal(recv, ZERO);
});

test('at any gas limit the seller picks, an offer pays the full royalty or does not go through (EIP-150 63/64)', async () => {
  const w = await c.deploy('WeirdRoyalty721', [cfg(), 6], 'seller');
  await w.send('seller', 'mint', [A('seller'), '']);
  await w.send('seller', 'setApprovalForAll', [market.address, true]);
  let sales = 0, refused = 0;
  for (let gas = 60_000n; gas <= 400_000n; gas += 4_000n) {
    // The seller accepts an offer with a gas limit of its choosing.
    const offer = await market.call('offerCount');
    await market.send('buyer', 'makeOffer', [w.address, 1, 1, exp()], 10_000n);
    try {
      const ev = await market.send('seller', 'acceptOffer', [offer], 0n, gas);
      assert.equal(evOf(ev, 'OfferAccepted').args.royalty, 1_000n, `gas ${gas}: full royalty or no sale`);
      sales++;
      await w.send('buyer', 'transferFrom', [A('buyer'), A('seller'), 1]);
    } catch (e) {
      refused++;
      await market.send('buyer', 'cancelOffer', [offer]);
    }
  }
  assert.ok(sales > 0 && refused > 0, `${sales} sales, ${refused} refused`);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], 0n, 40_000n), /.*/); // too little gas for anything
});

test('pull payments: a seller that refuses ZETAPHY does not block the sale, and can withdraw elsewhere', async () => {
  const refuser = await c.deploy('RefusingPayee', [], 'other');
  await nft.send('seller', 'transferFrom', [A('seller'), refuser.address, 1]);
  // The refusing contract lists through a direct call: give it the approval by acting as it.
  const asRefuser = c.at(nft.address, 'ZetaphyERC721');
  await asRefuser.send(refuser.address, 'setApprovalForAll', [market.address, true]);
  await market.send(refuser.address, 'list', [nft.address, 1, 1, ZETA, exp()]);
  await market.send('buyer', 'buy', [0, 1], ZETA);
  assert.equal(await nft.call('ownerOf', [1]), A('buyer'));
  const due = ZETA - ZETA / 100n - ZETA * 5n / 100n;
  assert.deepEqual(await owed(refuser.address), [due]);
  await assert.rejects(refuser.send('other', 'withdraw', [market.address]), /PayFailed/);
  assert.deepEqual(await owed(refuser.address), [due], 'still owed after a failed withdraw');
  await assert.rejects(refuser.send('other', 'withdrawTo', [market.address, ZERO]), /ZeroAddress/);
  const before = await c.balance('other');
  await refuser.send('other', 'withdrawTo', [market.address, A('other')]);
  assert.equal(await c.balance('other') - before, due);
  // A buyer contract that refuses ZETAPHY can still cancel its offer and withdraw to another address.
  await refuser.send('other', 'offer', [market.address, nft.address, 2, exp()], ZETA);
  await refuser.send('other', 'cancel', [market.address, 0]);
  await refuser.send('other', 'withdrawTo', [market.address, A('other')]);
});

test('reentrancy: buyer callback, payee receive() and a hostile collection are all stopped', async () => {
  // (1) The buyer contract tries to buy another listing from onERC721Received.
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]);
  await market.send('seller', 'list', [nft.address, 2, 1, ZETA, exp()]);
  const rb = await c.deploy('ReentrantBuyer', [market.address], 'other');
  await rb.send('other', 'buy', [0, ZETA, 1, ZETA], 2n * ZETA);
  assert.equal(await nft.call('ownerOf', [1]), rb.address);
  assert.equal(await rb.call('reentered'), true);
  assert.equal(await rb.call('reentryError'), market.iface.getError('Reentrancy').selector);
  assert.equal(await nft.call('ownerOf', [2]), A('seller'), 'the reentrant buy did nothing');
  assert.equal(await market.call('listingStatus', [1, 1]), S.Ok);

  // (2) A payee whose receive() calls withdraw again is paid exactly once.
  const rp = await c.deploy('ReentrantPayee', [market.address], 'other');
  await rp.send('other', 'offer', [nft.address, 3, exp()], 3n * ZETA);
  await rp.send('other', 'cancel', [0]);
  await market.send('buyer', 'makeOffer', [nft.address, 3, 1, exp()], ZETA); // more money in the market
  await rp.send('other', 'pull');
  assert.equal(await rp.call('received'), 3n * ZETA);
  assert.equal(await rp.call('reentryError'), market.iface.getError('Reentrancy').selector);
  assert.equal(await c.balance(market.address), ZETA + await market.call('owed', [A('seller')]) + await market.call('owed', [A('feeTo')]) + await market.call('owed', [A('artist')]));

  // (3) A hostile collection calls back into the market while the market moves its token.
  const evil = await c.deploy('EvilCollection', [cfg()], 'seller');
  await evil.send('seller', 'mintMany', [A('seller'), 8]);
  await evil.send('seller', 'setApprovalForAll', [market.address, true]);
  const offerId = await market.call('offerCount');
  await market.send('buyer', 'makeOffer', [evil.address, 8, 1, exp()], ZETA);
  const target = await market.call('listingCount');
  await market.send('seller', 'list', [evil.address, 7, 1, ZETA, exp()]);
  for (const [attack, arg] of [[1, target], [2, offerId], [3, offerId], [4, 0n]]) {
    const lid = await market.call('listingCount');
    await market.send('seller', 'list', [evil.address, attack, 1, ZETA, exp()]);
    await evil.send('seller', 'arm', [market.address, attack, arg]);
    await market.send('other', 'buy', [lid, 1], ZETA);
    assert.equal(await evil.call('ownerOf', [attack]), A('other'));
    assert.equal(await evil.call('reentryError'), market.iface.getError('Reentrancy').selector, `attack ${attack}`);
  }
  // What the reentrant calls aimed at is untouched.
  assert.equal(await market.call('listingStatus', [target, 1]), S.Ok);
  assert.equal((await market.call('getOffer', [offerId])).amount, ZETA);
});

test('delivery is checked: a token that only pretends to transfer fails the sale; a refusing buyer contract cannot buy', async () => {
  const fake = await c.deploy('FakeNFT', [], 'seller');
  await fake.send('seller', 'setApprovalForAll', [market.address, true]);
  await market.send('seller', 'list', [fake.address, 1, 1, ZETA, exp()]);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /TransferFailed/);
  // A contract buyer without onERC721Received: the safe transfer refuses, nothing is paid.
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]);
  const noRecv = await c.deploy('NotAReceiver', [], 'other');
  await c.fund(noRecv.address, 5n * ZETA);
  await assert.rejects(market.send(noRecv.address, 'buy', [1, 1], ZETA), /InvalidReceiver/);
  assert.equal(await c.balance(noRecv.address), 5n * ZETA);
  assert.equal(await nft.call('ownerOf', [1]), A('seller'));
});

test('Neuro: an enforced flag refuses list, buy, offer and accept; cancel and withdraw still work', async () => {
  const reg = await c.deploy('MockThreatRegistry', [], 'gov');
  await assert.rejects(market.send('other', 'setThreatRegistry', [reg.address]), /NotGovernance/);
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]);
  await market.send('buyer', 'makeOffer', [nft.address, 2, 1, exp()], ZETA);
  await market.send('gov', 'setThreatRegistry', [reg.address]);
  // A newer flag that is not enforced yet: allowed (the web app warns).
  await reg.send('gov', 'set', [nft.address, 2, 0]);
  await market.send('seller', 'list', [nft.address, 3, 1, ZETA, exp()]);
  // Enforced.
  await reg.send('gov', 'set', [nft.address, 2, 2]);
  await assert.rejects(market.send('seller', 'list', [nft.address, 4, 1, ZETA, exp()]), /CollectionRefused/);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /CollectionRefused/);
  assert.equal(await market.call('listingStatus', [0, 1]), S.Refused);
  await assert.rejects(market.send('buyer', 'makeOffer', [nft.address, 4, 1, exp()], ZETA), /CollectionRefused/);
  await assert.rejects(market.send('seller', 'acceptOffer', [0]), /CollectionRefused/);
  // Other collections are unaffected.
  await market.send('seller', 'list', [multi.address, 1, 1, ZETA, exp()]);
  // Nobody's money or listing is stuck.
  await market.send('seller', 'cancel', [0]);
  await market.send('buyer', 'cancelOffer', [0]);
  await market.send('buyer', 'withdraw');
  // A registry that fails to answer refuses (fail closed); zero turns the check off.
  await reg.send('gov', 'setBroken', [true]);
  await assert.rejects(market.send('seller', 'list', [multi.address, 1, 1, ZETA, exp()]), /registry down/);
  await market.send('gov', 'setThreatRegistry', [ZERO]);
  await market.send('seller', 'list', [nft.address, 4, 1, ZETA, exp()]);
  await market.send('buyer', 'buy', [3, 1], ZETA);
});
