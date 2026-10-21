// NFTMarketplace: list / buy / cancel / expire, offers, fee and royalty math to
// the wei, pull payments, reentrancy attempts, stale listings (move counters of
// factory collections, the old behaviour for external ones), ERC-1155 amounts,
// ERC-165 detection, and the Neuro ThreatRegistry refusal.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChain, ZETA } from './helpers/chain.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const DAY = 86_400n;
const S = { Ok: 0n, Inactive: 1n, Expired: 2n, SellerCancelledAll: 3n, SellerLacksToken: 4n, NotApproved: 5n, Refused: 6n, Replaced: 7n, TermsChanged: 8n, Moved: 9n };

let c, factory, market, nft, multi;
const A = (n) => c.addr(n);
const exp = (secs = 7n * DAY) => c.now() + secs;
const cfg = (over = {}) => ({ name: 'Siam', symbol: 'SIAM', baseURI: 'ipfs://base/', contractURI: '', royaltyReceiver: ZERO,
  royaltyBps: 0, maxSupply: 0, publicMint: false, mintPrice: 0, ...over });

/** The same collection code deployed directly: not made by the factory, so "external" to the market. */
async function external(kind, over = {}, from = 'seller') {
  return c.deploy(kind === 721 ? 'ZetaphyERC721' : 'ZetaphyERC1155', [cfg(over), A(from)], from);
}
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
  market = await c.deploy('NFTMarketplace', [A('gov'), A('feeTo'), 100, ZERO, factory.address], 'gov'); // 1% fee, no registry
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
  assert.equal(await market.call('listingStatus', [0, 1]), S.Moved, 'a factory collection: the move is seen');
  const before = await c.balance('buyer');
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /TokenMoved/);
  assert.equal(await c.balance('buyer'), before, 'nothing taken');
  // The new holder's approval of the market does not revive the old listing for them.
  await nft.send('other', 'setApprovalForAll', [market.address, true]);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /TokenMoved/);
  assert.equal(await nft.call('ownerOf', [1]), A('other'));
  // Revoked approval.
  await market.send('seller', 'list', [nft.address, 2, 1, ZETA, exp()]);
  await nft.send('seller', 'setApprovalForAll', [market.address, false]);
  assert.equal(await market.call('listingStatus', [1, 1]), S.NotApproved);
  await assert.rejects(market.send('buyer', 'buy', [1, 1], ZETA), /NotApproved/);
  // Two listings of one token: the newer one replaces the older one at once.
  await nft.send('seller', 'setApprovalForAll', [market.address, true]);
  await market.send('seller', 'list', [nft.address, 3, 1, ZETA, exp()]);
  await market.send('seller', 'list', [nft.address, 3, 1, 2n * ZETA, exp()]);
  assert.equal(await market.call('listingStatus', [2, 1]), S.Replaced);
  await assert.rejects(market.send('buyer', 'buy', [2, 1], ZETA), /NotActive/);
  await market.send('buyer', 'buy', [3, 1], 2n * ZETA);
  await assert.rejects(market.send('other', 'buy', [3, 1], 2n * ZETA), /NotActive/);
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
  await market.send('other', 'buy', [0, 3], unit * 3n);
  assert.equal(await multi.call('balanceOf', [A('other'), 1]), 3n);
  assert.equal((await market.call('getListing', [0])).quantity, 2n);
  assert.equal(await market.call('listingStatus', [0, 0]), S.Ok);
  const [s, f, r] = await owed('seller', 'feeTo', 'artist');
  const t6 = unit * 3n;
  assert.equal(f, 2n * (t6 / 100n));
  assert.equal(r, 2n * (t6 * 250n / 10_000n));
  assert.equal(s + f + r, unit * 6n, 'every wei accounted for');
  // Holder checks against the seller's balance (an external collection: a move out does not end the listing there).
  const ext = await external(1155);
  await ext.send('seller', 'create', [A('seller'), 7, '']);
  await ext.send('seller', 'setApprovalForAll', [market.address, true]);
  await market.send('seller', 'list', [ext.address, 1, 5, unit, exp()]); // listing 1
  // The seller gives 4 of their 7 away: 3 left, the listing has 5.
  await ext.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 4, '0x']);
  assert.equal(await market.call('listingStatus', [1, 4]), S.SellerLacksToken);
  assert.equal(await market.call('listingStatus', [1, 3]), S.Ok);
  assert.equal(await market.call('listingStatus', [1, 0]), S.SellerLacksToken, '0: all that is left (5)');
  await assert.rejects(market.send('buyer', 'buy', [1, 4], unit * 4n), /SellerLacksToken/);
  await market.send('other', 'buy', [1, 3], unit * 3n);
  assert.equal(await ext.call('balanceOf', [A('other'), 1]), 7n);
  assert.equal((await market.call('getListing', [1])).quantity, 2n);
});

test('offers: escrowed value, accept by the holder, cancel, expiry, ERC-1155 quantity', async () => {
  const value = 777_777_777_777_777_777n;
  const made = evOf(await market.send('buyer', 'makeOffer', [nft.address, 2, 1, exp(DAY)], value), 'OfferMade');
  assert.equal(made.args.amount, value);
  assert.equal(await c.balance(market.address), value);
  await assert.rejects(market.send('buyer', 'makeOffer', [nft.address, 2, 1, exp(DAY)], 0n), /BadPrice/);
  await assert.rejects(market.send('buyer', 'makeOffer', [nft.address, 2, 2, exp(DAY)], 1n), /BadQuantity/);
  await assert.rejects(market.send('buyer', 'makeOffer', [A('other'), 2, 1, exp(DAY)], 1n), /NotNFT/);
  await assert.rejects(market.send('other', 'acceptOffer', [0, 0]), /SellerLacksToken/);
  await nft.send('seller', 'setApprovalForAll', [market.address, false]);
  await assert.rejects(market.send('seller', 'acceptOffer', [0, 0]), /NotApproved/);
  await nft.send('seller', 'setApprovalForAll', [market.address, true]);
  await assert.rejects(market.send('other', 'cancelOffer', [0]), /NotBuyer/);
  const acc = evOf(await market.send('seller', 'acceptOffer', [0, 0]), 'OfferAccepted');
  const fee = value / 100n;
  const royalty = value * 500n / 10_000n;
  assert.equal(acc.args.fee, fee);
  assert.equal(acc.args.royalty, royalty);
  assert.equal(await nft.call('ownerOf', [2]), A('buyer'));
  assert.deepEqual(await owed('seller', 'feeTo', 'artist', 'buyer'), [value - fee - royalty, fee, royalty, 0n]);
  await assert.rejects(market.send('seller', 'acceptOffer', [0, 0]), /NotActive/);
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
  await assert.rejects(market.send('seller', 'acceptOffer', [2, 0]), /Expired/);
  await market.send('buyer', 'cancelOffer', [2]);
  assert.deepEqual(await owed('buyer'), [ZETA]);
  // ERC-1155: all units at once.
  await market.send('buyer', 'makeOffer', [multi.address, 1, 4, exp(DAY)], 4n * ZETA);
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 7, '0x']); // 3 left
  await assert.rejects(market.send('seller', 'acceptOffer', [3, 0]), /SellerLacksToken/);
  await multi.send('other', 'setApprovalForAll', [market.address, true]);
  await market.send('other', 'acceptOffer', [3, 0]); // another holder may accept
  assert.equal(await multi.call('balanceOf', [A('buyer'), 1]), 4n);
  assert.equal(await multi.call('balanceOf', [A('other'), 1]), 3n);
});

test('protocol fee: governance only, capped at 5%; 0% works; governance hand-over', async () => {
  await assert.rejects(market.send('other', 'setFee', [50, A('other')]), /NotGovernance/);
  await assert.rejects(market.send('gov', 'setFee', [501, A('feeTo')]), /FeeTooHigh/);
  await assert.rejects(market.send('gov', 'setFee', [100, ZERO]), /ZeroAddress/);
  await assert.rejects(c.deploy('NFTMarketplace', [A('gov'), A('feeTo'), 501, ZERO, factory.address], 'gov'), /FeeTooHigh/);
  await assert.rejects(c.deploy('NFTMarketplace', [ZERO, A('feeTo'), 100, ZERO, factory.address], 'gov'), /ZeroAddress/);
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
      const ev = await market.send('seller', 'acceptOffer', [offer, 0], 0n, gas);
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
  await assert.rejects(market.send('seller', 'acceptOffer', [0, 0]), /CollectionRefused/);
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

test('stale listings never come back: re-acquired after acceptOffer, after a market purchase, or relisted', async () => {
  // (1) Listed, then sold by accepting an offer; the token comes back with a plain transfer.
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]); // listing 0
  await market.send('buyer', 'makeOffer', [nft.address, 1, 1, exp()], 2n * ZETA); // offer 0
  await market.send('seller', 'acceptOffer', [0, 0]);
  assert.equal(await nft.call('ownerOf', [1]), A('buyer'));
  await nft.send('buyer', 'transferFrom', [A('buyer'), A('seller'), 1]);
  assert.equal(await nft.call('ownerOf', [1]), A('seller'));
  assert.equal(await market.call('listingStatus', [0, 1]), S.Replaced);
  await assert.rejects(market.send('other', 'buy', [0, 1], ZETA), /NotActive/);

  // (2) Listed, given away, bought back through the market: the old listing stays dead.
  await market.send('seller', 'list', [nft.address, 2, 1, ZETA, exp()]); // listing 1
  await nft.send('seller', 'transferFrom', [A('seller'), A('other'), 2]);
  await nft.send('other', 'setApprovalForAll', [market.address, true]);
  await market.send('other', 'list', [nft.address, 2, 1, 3n * ZETA, exp()]); // listing 2
  await market.send('seller', 'buy', [2, 1], 3n * ZETA);
  assert.equal(await nft.call('ownerOf', [2]), A('seller'));
  assert.equal(await market.call('listingStatus', [1, 1]), S.Replaced);
  await assert.rejects(market.send('buyer', 'buy', [1, 1], ZETA), /NotActive/);
  // (3) A sold-out listing, the token bought back by its seller: still sold out; a new listing works.
  await market.send('seller', 'list', [nft.address, 2, 1, 4n * ZETA, exp()]); // listing 3
  assert.equal(await market.call('listingStatus', [3, 1]), S.Ok);
  await market.send('buyer', 'buy', [3, 1], 4n * ZETA);
  await nft.send('buyer', 'transferFrom', [A('buyer'), A('seller'), 2]);
  await assert.rejects(market.send('other', 'buy', [3, 1], 4n * ZETA), /NotActive/);
  await market.send('seller', 'list', [nft.address, 2, 1, 5n * ZETA, exp()]); // listing 4
  await market.send('buyer', 'buy', [4, 1], 5n * ZETA);
  assert.equal(await nft.call('ownerOf', [2]), A('buyer'));

  // (4) ERC-1155: a partial buy keeps the listing; accepting an offer for the id retires it.
  await market.send('seller', 'list', [multi.address, 1, 5, ZETA, exp()]); // listing 5
  await market.send('buyer', 'buy', [5, 2], 2n * ZETA);
  assert.equal(await market.call('listingStatus', [5, 0]), S.Ok);
  await market.send('other', 'makeOffer', [multi.address, 1, 1, exp()], ZETA); // offer 1
  await market.send('seller', 'acceptOffer', [1, 0]);
  assert.equal(await market.call('listingStatus', [5, 0]), S.Replaced);
  await assert.rejects(market.send('buyer', 'buy', [5, 1], ZETA), /NotActive/);
  // tokenNonceOf is public: clients can tell which listing is live.
  assert.equal((await market.call('getListing', [5])).tokenNonce, 1n);
  assert.equal(await market.call('tokenNonceOf', [A('seller'), multi.address, 1]), 2n);
});

test('seller guards: acceptOffer minProceeds; a listing refuses a sale after the fee or royalty rose', async () => {
  const value = 10n * ZETA;
  await market.send('buyer', 'makeOffer', [nft.address, 1, 1, exp()], value);
  const [, , , rest] = await market.call('quote', [nft.address, 1, value]);
  assert.equal(rest, value - value / 100n - value * 5n / 100n);
  // Governance raises the fee before the accept is included: the seller's minimum holds.
  await market.send('gov', 'setFee', [500, A('feeTo')]);
  await assert.rejects(market.send('seller', 'acceptOffer', [0, rest]), /ProceedsTooLow/);
  await market.send('gov', 'setFee', [100, A('feeTo')]);
  await assert.rejects(market.send('seller', 'acceptOffer', [0, rest + 1n]), /ProceedsTooLow/);
  await market.send('seller', 'acceptOffer', [0, rest]);
  assert.deepEqual(await owed('seller'), [rest]);

  // A listing records the seller's part of one unit; a higher royalty or fee later stops the sale.
  await market.send('seller', 'list', [nft.address, 2, 1, ZETA, exp()]); // listing 0
  assert.equal((await market.call('getListing', [0])).minUnitProceeds, ZETA - ZETA / 100n - ZETA * 5n / 100n);
  await nft.send('seller', 'setRoyalty', [A('artist'), 1000]);
  assert.equal(await market.call('listingStatus', [0, 1]), S.TermsChanged);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /ProceedsTooLow/);
  await nft.send('seller', 'setRoyalty', [A('artist'), 500]);
  await market.send('gov', 'setFee', [200, A('feeTo')]);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /ProceedsTooLow/);
  // Lower terms are fine.
  await market.send('gov', 'setFee', [0, ZERO]);
  assert.equal(await market.call('listingStatus', [0, 1]), S.Ok);
  await market.send('buyer', 'buy', [0, 1], ZETA);
  // ERC-1155 multi-unit buys check per unit (no rounding surprise).
  await market.send('gov', 'setFee', [100, A('feeTo')]);
  await market.send('seller', 'list', [multi.address, 1, 7, 333_333_333_333_333_333n, exp()]);
  await market.send('buyer', 'buy', [1, 7], 7n * 333_333_333_333_333_333n);
});

test('withdrawFor: anyone pays a passive royalty receiver what it is owed, only to itself', async () => {
  const passive = await c.deploy('PassiveReceiver', [], 'other');
  const p721 = await create(721, { royaltyReceiver: passive.address, royaltyBps: 1000 });
  await p721.send('seller', 'mint', [A('seller'), '']);
  await p721.send('seller', 'setApprovalForAll', [market.address, true]);
  await market.send('seller', 'list', [p721.address, 1, 1, ZETA, exp()]);
  await market.send('buyer', 'buy', [0, 1], ZETA);
  assert.deepEqual(await owed(passive.address), [ZETA / 10n]);
  const otherBefore = await c.balance('other');
  const w = evOf(await market.send('other', 'withdrawFor', [passive.address]), 'Withdrawn');
  assert.equal(w.args.from, passive.address);
  assert.equal(w.args.to, passive.address);
  assert.equal(await c.balance(passive.address), ZETA / 10n);
  assert.equal(await c.balance('other'), otherBefore, 'the caller gets nothing');
  await assert.rejects(market.send('other', 'withdrawFor', [passive.address]), /NothingOwed/);
  await assert.rejects(market.send('other', 'withdrawFor', [ZERO]), /ZeroAddress/);
});

test('Neuro: a code-key flag does not stop factory collections (address key only); external ones and a market without a factory still check code', async () => {
  const reg = await c.deploy('MockThreatRegistry', [], 'gov');
  await market.send('gov', 'setThreatRegistry', [reg.address]);
  const codeHash = (await import('ethers')).keccak256(await c.code(nft.address));
  await reg.send('gov', 'setKey', [await reg.call('codeKey', [codeHash]), 2, 2]);
  assert.deepEqual([...await reg.call('isContractEnforced', [nft.address])], [true, 2n]);
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]);
  assert.equal(await market.call('listingStatus', [0, 1]), S.Ok);
  await market.send('buyer', 'buy', [0, 1], ZETA);
  // The same code outside the factory: refused.
  const ext = await c.deploy('ZetaphyERC721', [cfg(), A('seller')], 'seller');
  await ext.send('seller', 'mintMany', [A('seller'), 1]);
  await ext.send('seller', 'setApprovalForAll', [market.address, true]);
  await assert.rejects(market.send('seller', 'list', [ext.address, 1, 1, ZETA, exp()]), /CollectionRefused/);
  // A marketplace deployed without a factory checks address and code for everything.
  const plain = await c.deploy('NFTMarketplace', [A('gov'), A('feeTo'), 100, reg.address, ZERO], 'gov');
  await nft.send('seller', 'setApprovalForAll', [plain.address, true]);
  await assert.rejects(plain.send('seller', 'list', [nft.address, 2, 1, ZETA, exp()]), /CollectionRefused/);
});

test('factory ERC-721: listed, moved away outside the market and back: the old listing is dead for good (Moved)', async () => {
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]); // listing 0
  let l = await market.call('getListing', [0]);
  assert.equal(l.tracked, true);
  assert.equal(l.moves, await nft.call('transferCount', [1]));
  assert.equal(l.moves, 1n, 'minted once');
  // Away and back by plain transfers; the seller's setApprovalForAll is still on.
  await nft.send('seller', 'transferFrom', [A('seller'), A('other'), 1]);
  await nft.send('other', 'transferFrom', [A('other'), A('seller'), 1]);
  assert.equal(await nft.call('ownerOf', [1]), A('seller'));
  assert.equal(await nft.call('isApprovedForAll', [A('seller'), market.address]), true);
  assert.equal(await market.call('listingStatus', [0, 1]), S.Moved);
  const before = await c.balance('buyer');
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /TokenMoved/);
  assert.equal(await c.balance('buyer'), before);
  assert.equal(await nft.call('ownerOf', [1]), A('seller'));
  // Even a move to oneself counts.
  await market.send('seller', 'list', [nft.address, 2, 1, ZETA, exp()]); // listing 1
  await nft.send('seller', 'safeTransferFrom(address,address,uint256)', [A('seller'), A('seller'), 2]);
  assert.equal(await market.call('listingStatus', [1, 1]), S.Moved);
  // A per-token approve() listing: the move clears the approval, but Moved is the reason shown, and it stays.
  await nft.send('seller', 'setApprovalForAll', [market.address, false]);
  await nft.send('seller', 'approve', [market.address, 3]);
  await market.send('seller', 'list', [nft.address, 3, 1, ZETA, exp()]); // listing 2
  await nft.send('seller', 'transferFrom', [A('seller'), A('other'), 3]);
  await nft.send('other', 'transferFrom', [A('other'), A('seller'), 3]);
  await nft.send('seller', 'approve', [market.address, 3]);
  assert.equal(await market.call('listingStatus', [2, 1]), S.Moved);
  await assert.rejects(market.send('buyer', 'buy', [2, 1], ZETA), /TokenMoved/);
  // A new listing of the returned token works (and the dead one stays dead after it).
  await nft.send('seller', 'setApprovalForAll', [market.address, true]);
  await market.send('seller', 'list', [nft.address, 1, 1, 2n * ZETA, exp()]); // listing 3
  assert.equal(await market.call('listingStatus', [3, 1]), S.Ok);
  await market.send('buyer', 'buy', [3, 1], 2n * ZETA);
  assert.equal(await nft.call('ownerOf', [1]), A('buyer'));
  l = await market.call('getListing', [0]);
  assert.equal(l.quantity, 1n, 'never sold: only the counter keeps it shut');
});

test('factory ERC-1155: any move of the seller\'s units outside the market kills the listing; arrivals do not', async () => {
  const st = (id) => market.call('listingStatus', [id, 0]);
  // All units away and back.
  await market.send('seller', 'list', [multi.address, 1, 5, ZETA, exp()]); // listing 0
  assert.equal((await market.call('getListing', [0])).tracked, true);
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 10, '0x']);
  await multi.send('other', 'safeTransferFrom', [A('other'), A('seller'), 1, 10, '0x']);
  assert.equal(await multi.call('balanceOf', [A('seller'), 1]), 10n);
  assert.equal(await st(0), S.Moved);
  await assert.rejects(market.send('buyer', 'buy', [0, 1], ZETA), /TokenMoved/);
  // One unit away (9 left, still more than listed): Moved too.
  await market.send('seller', 'list', [multi.address, 1, 5, ZETA, exp()]); // listing 1
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 1, '0x']);
  assert.equal(await st(1), S.Moved);
  // A batch transfer out.
  await market.send('seller', 'list', [multi.address, 1, 5, ZETA, exp()]); // listing 2
  await multi.send('seller', 'create', [A('seller'), 3, '']);
  await multi.send('seller', 'safeBatchTransferFrom', [A('seller'), A('other'), [2, 1], [1, 1], '0x']);
  assert.equal(await st(2), S.Moved);
  // A burn.
  await market.send('seller', 'list', [multi.address, 1, 5, ZETA, exp()]); // listing 3
  await multi.send('seller', 'burn', [A('seller'), 1, 1]);
  assert.equal(await st(3), S.Moved);
  // Other ids are separate: moving id 2 leaves a listing of id 1 alone.
  await market.send('seller', 'list', [multi.address, 1, 5, ZETA, exp()]); // listing 4
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 2, 1, '0x']);
  assert.equal(await st(4), S.Ok);
  // Arrivals do not count: nobody can kill a listing by sending or minting units to the seller.
  await multi.send('other', 'safeTransferFrom', [A('other'), A('seller'), 1, 1, '0x']);
  await multi.send('seller', 'mint', [A('seller'), 1, 2]);
  await multi.send('seller', 'setMint', [true, 0]);
  await multi.send('other', 'publicMintTo', [A('seller'), 1, 1]);
  assert.equal(await st(4), S.Ok);
  // Nor do a 0-unit "transfer" or the seller moving units to itself.
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 0, '0x']);
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('seller'), 1, 3, '0x']);
  assert.equal(await st(4), S.Ok);
  await market.send('buyer', 'buy', [4, 5], 5n * ZETA);
  assert.equal(await multi.call('balanceOf', [A('buyer'), 1]), 5n);
});

test('factory ERC-1155 partial fills: each market sale updates the listing\'s expected count; an outside move still kills it', async () => {
  await market.send('seller', 'list', [multi.address, 1, 6, ZETA, exp()]); // listing 0
  const moves0 = (await market.call('getListing', [0])).moves;
  await market.send('buyer', 'buy', [0, 1], ZETA);
  await market.send('other', 'buy', [0, 2], 2n * ZETA);
  let l = await market.call('getListing', [0]);
  assert.equal(l.quantity, 3n);
  assert.equal(l.moves, moves0 + 2n);
  assert.equal(l.moves, await multi.call('transferCount', [A('seller'), 1]));
  assert.equal(await market.call('listingStatus', [0, 0]), S.Ok);
  // The seller buying from its own listing moves nothing: the expectation does not change.
  await market.send('seller', 'buy', [0, 1], ZETA);
  l = await market.call('getListing', [0]);
  assert.deepEqual([l.quantity, l.moves], [2n, moves0 + 2n]);
  assert.equal(await market.call('listingStatus', [0, 0]), S.Ok);
  // Bought out in two more sales.
  await market.send('buyer', 'buy', [0, 1], ZETA);
  await market.send('buyer', 'buy', [0, 1], ZETA);
  assert.equal(await multi.call('balanceOf', [A('buyer'), 1]), 3n);
  assert.equal(await multi.call('balanceOf', [A('other'), 1]), 2n);
  assert.equal(await market.call('listingStatus', [0, 0]), S.Inactive);
  // Partial fill, then an outside move: dead.
  await market.send('seller', 'list', [multi.address, 1, 4, ZETA, exp()]); // listing 1
  await market.send('buyer', 'buy', [1, 1], ZETA);
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 1, '0x']);
  await multi.send('other', 'safeTransferFrom', [A('other'), A('seller'), 1, 1, '0x']);
  assert.equal(await market.call('listingStatus', [1, 0]), S.Moved);
  await assert.rejects(market.send('buyer', 'buy', [1, 1], ZETA), /TokenMoved/);
});

test('external collections keep the old behaviour: no counter, a token that comes back revives an unexpired listing', async () => {
  const e721 = await external(721);
  await e721.send('seller', 'mintMany', [A('seller'), 1]);
  await e721.send('seller', 'setApprovalForAll', [market.address, true]);
  await market.send('seller', 'list', [e721.address, 1, 1, ZETA, exp()]); // listing 0
  const l = await market.call('getListing', [0]);
  assert.deepEqual([l.tracked, l.moves], [false, 0n]);
  await e721.send('seller', 'transferFrom', [A('seller'), A('other'), 1]);
  assert.equal(await market.call('listingStatus', [0, 1]), S.SellerLacksToken);
  await e721.send('other', 'transferFrom', [A('other'), A('seller'), 1]);
  assert.equal(await market.call('listingStatus', [0, 1]), S.Ok, 'the known gap for collections the market cannot ask');
  await market.send('buyer', 'buy', [0, 1], ZETA);
  assert.equal(await e721.call('ownerOf', [1]), A('buyer'));

  const e1155 = await external(1155);
  await e1155.send('seller', 'create', [A('seller'), 4, '']);
  await e1155.send('seller', 'setApprovalForAll', [market.address, true]);
  await market.send('seller', 'list', [e1155.address, 1, 4, ZETA, exp()]); // listing 1
  await e1155.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 4, '0x']);
  await e1155.send('other', 'safeTransferFrom', [A('other'), A('seller'), 1, 4, '0x']);
  assert.equal(await market.call('listingStatus', [1, 0]), S.Ok);
  // What the web app offers: cancel the old listing.
  await market.send('seller', 'cancel', [1]);
  await assert.rejects(market.send('buyer', 'buy', [1, 1], ZETA), /NotActive/);

  // A market with no factory tracks nothing, even for a factory-made collection.
  const bare = await c.deploy('NFTMarketplace', [A('gov'), A('feeTo'), 100, ZERO, ZERO], 'gov');
  await nft.send('seller', 'setApprovalForAll', [bare.address, true]);
  await bare.send('seller', 'list', [nft.address, 2, 1, ZETA, exp()]);
  assert.equal((await bare.call('getListing', [0])).tracked, false);
});

test('gas: the counters cost no extra storage write in the collections; list and buy stay within bounds', async () => {
  const gas = {};
  await nft.send('seller', 'transferFrom', [A('seller'), A('other'), 5]); gas.transfer721 = c.lastGas();
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 1, '0x']);
  await multi.send('seller', 'safeTransferFrom', [A('seller'), A('other'), 1, 1, '0x']); gas.transfer1155 = c.lastGas();
  await market.send('seller', 'list', [nft.address, 1, 1, ZETA, exp()]); gas.list721 = c.lastGas();
  await market.send('buyer', 'buy', [0, 1], ZETA); gas.buy721 = c.lastGas();
  await market.send('seller', 'list', [multi.address, 1, 6, ZETA, exp()]); gas.list1155 = c.lastGas();
  await market.send('buyer', 'buy', [1, 2], 2n * ZETA); gas.buyPartialFirst = c.lastGas();
  await market.send('buyer', 'buy', [1, 2], 2n * ZETA); gas.buyPartial = c.lastGas();
  // Execution gas (no 21,000 base), measured in this same setup before the counters existed,
  // and what the counters may add: nothing stored in the collections (a few arithmetic
  // operations); in the market, reading the counter (and isCollection when listing), plus
  // one warm slot update per partial ERC-1155 sale.
  const before = { transfer721: 33_509n, transfer1155: 10_308n, list721: 218_107n, buy721: 161_264n, list1155: 198_057n, buyPartialFirst: 92_251n, buyPartial: 54_051n };
  const extra = { transfer721: 300n, transfer1155: 300n, list721: 3_000n, buy721: 3_000n, list1155: 3_000n, buyPartialFirst: 6_000n, buyPartial: 6_000n };
  const max = Object.fromEntries(Object.keys(before).map((k) => [k, before[k] + extra[k]]));
  for (const [k, v] of Object.entries(max)) assert.ok(gas[k] <= v, `${k}: ${gas[k]} > ${v}`);
});
