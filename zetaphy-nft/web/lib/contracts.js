// The contract calls and events the site uses (contracts/*.sol), and ZTPHY amounts.
import { fn, event } from './abi.js';

const CONFIG = '(string,string,string,string,address,uint96,uint256,bool,uint256)';
const LISTING = '(address,uint64,uint8,address,uint64,uint256,uint256,uint256,uint64,uint256)';
const OFFER = '(address,uint64,uint8,address,uint256,uint256,uint256)';

export const F = {
  // ERC-165 / 721 / 1155 / 2981 and the collections' own views
  supportsInterface: fn('supportsInterface(bytes4)', ['bool']),
  name: fn('name()', ['string']),
  symbol: fn('symbol()', ['string']),
  owner: fn('owner()', ['address']),
  contractURI: fn('contractURI()', ['string']),
  tokenURI: fn('tokenURI(uint256)', ['string']),
  uri: fn('uri(uint256)', ['string']),
  ownerOf: fn('ownerOf(uint256)', ['address']),
  balanceOf721: fn('balanceOf(address)', ['uint256']),
  balanceOf1155: fn('balanceOf(address,uint256)', ['uint256']),
  isApprovedForAll: fn('isApprovedForAll(address,address)', ['bool']),
  getApproved: fn('getApproved(uint256)', ['address']),
  setApprovalForAll: fn('setApprovalForAll(address,bool)'),
  royaltyInfo: fn('royaltyInfo(uint256,uint256)', ['address', 'uint256']),
  royaltyBps: fn('royaltyBps()', ['uint96']),
  maxSupply: fn('maxSupply()', ['uint256']),
  totalMinted721: fn('totalMinted()', ['uint256']),
  tokenCount: fn('tokenCount()', ['uint256']),
  totalSupply1155: fn('totalSupply(uint256)', ['uint256']),
  publicMint: fn('publicMint()', ['bool']),
  mintPrice: fn('mintPrice()', ['uint256']),
  baseURI: fn('baseURI()', ['string']),
  metadataFrozen: fn('metadataFrozen()', ['bool']),
  // mints
  mint721: fn('mint(address,string)', ['uint256']),
  mintMany721: fn('mintMany(address,uint256)', ['uint256']),
  publicMint721: fn('publicMintTo(address,uint256)', ['uint256']),
  create1155: fn('create(address,uint256,string)', ['uint256']),
  mint1155: fn('mint(address,uint256,uint256)'),
  publicMint1155: fn('publicMintTo(address,uint256,uint256)'),
  withdrawProceeds: fn('withdraw()'),
  // factory
  createERC721: fn(`createERC721(${CONFIG})`, ['address']),
  createERC1155: fn(`createERC1155(${CONFIG})`, ['address']),
  isCollection: fn('isCollection(address)', ['bool']),
  collectionCount: fn('collectionCount()', ['uint256']),
  collections: fn('collections(uint256,uint256)', ['address[]']),
  // marketplace
  list: fn('list(address,uint256,uint256,uint256,uint64)', ['uint256']),
  cancel: fn('cancel(uint256)'),
  cancelAll: fn('cancelAll()'),
  buy: fn('buy(uint256,uint256)'),
  makeOffer: fn('makeOffer(address,uint256,uint256,uint64)', ['uint256']),
  cancelOffer: fn('cancelOffer(uint256)'),
  acceptOffer: fn('acceptOffer(uint256,uint256)'),
  withdraw: fn('withdraw()'),
  withdrawFor: fn('withdrawFor(address)'),
  tokenNonceOf: fn('tokenNonceOf(address,address,uint256)', ['uint64']),
  owed: fn('owed(address)', ['uint256']),
  getListing: fn('getListing(uint256)', [LISTING]),
  getOffer: fn('getOffer(uint256)', [OFFER]),
  listingStatus: fn('listingStatus(uint256,uint256)', ['uint8']),
  listingCount: fn('listingCount()', ['uint256']),
  offerCount: fn('offerCount()', ['uint256']),
  quote: fn('quote(address,uint256,uint256)', ['uint256', 'uint256', 'address', 'uint256']),
  kindOf: fn('kindOf(address)', ['uint8']),
  feeBps: fn('feeBps()', ['uint16']),
  threatRegistry: fn('threatRegistry()', ['address']),
};

export const E = {
  Listed: event('Listed(uint256 indexed id,address indexed seller,address indexed collection,uint256 tokenId,uint256 quantity,uint256 unitPrice,uint64 expiry)'),
  Sold: event('Sold(uint256 indexed id,address indexed buyer,address indexed collection,uint256 tokenId,uint256 quantity,uint256 price,uint256 fee,uint256 royalty)'),
  OfferMade: event('OfferMade(uint256 indexed id,address indexed buyer,address indexed collection,uint256 tokenId,uint256 quantity,uint256 amount,uint64 expiry)'),
  CollectionCreated: event('CollectionCreated(address indexed collection,address indexed creator,uint8 kind,string name,string symbol)'),
  Transfer721: event('Transfer(address indexed from,address indexed to,uint256 indexed tokenId)'),
  TransferSingle: event('TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)'),
  TransferBatch: event('TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'),
};

export const KIND = { NONE: 0, ERC721: 1, ERC1155: 2 };
export const STATUS = ['ok', 'inactive', 'expired', 'cancelledAll', 'sellerLacksToken', 'notApproved', 'refused', 'replaced', 'termsChanged'];
export const listingFrom = (t) => ({ seller: t[0], expiry: Number(t[1]), kind: Number(t[2]), collection: t[3], nonce: t[4], tokenId: t[5], unitPrice: t[6], quantity: t[7], tokenNonce: t[8], minUnitProceeds: t[9] });
export const offerFrom = (t) => ({ buyer: t[0], expiry: Number(t[1]), kind: Number(t[2]), collection: t[3], tokenId: t[4], quantity: t[5], amount: t[6] });

// ---- ZTPHY amounts (18 decimals) ----

export const WEI = 10n ** 18n;
/** "1.5" -> 1500000000000000000n; null if not a plain non-negative decimal with <= 18 decimals. */
export function parseZtphy(s) {
  const m = /^\s*(\d{1,30})(?:\.(\d{0,18}))?\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  return BigInt(m[1]) * WEI + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
}
/** 1500000000000000000n -> "1.5" (trailing zeros cut, at most `digits` decimals shown, rounded down). */
export function formatZtphy(wei, digits = 6) {
  const w = BigInt(wei);
  const neg = w < 0n;
  const a = neg ? -w : w;
  const whole = a / WEI;
  const frac = (a % WEI).toString().padStart(18, '0').slice(0, digits).replace(/0+$/, '');
  if (whole === 0n && !frac && a !== 0n) return (neg ? '-' : '') + '<0.' + '0'.repeat(Math.max(0, digits - 1)) + '1'; // never show a non-zero amount as 0
  return (neg ? '-' : '') + whole.toLocaleString('en-US') + (frac ? '.' + frac : '');
}
export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
