// Known function signatures, grouped by what they let someone do.
// This list is the source of truth. `npm run selectors` turns it into
// src/selectors.generated.js (4-byte selector -> signature + category);
// test/selectors.test.js fails if the two drift apart.

export const SIGNATURES = [
  // ERC-20 basics
  ['name()', 'erc20'],
  ['symbol()', 'erc20'],
  ['decimals()', 'erc20'],
  ['totalSupply()', 'erc20'],
  ['balanceOf(address)', 'erc20'],
  ['transfer(address,uint256)', 'erc20'],
  ['transferFrom(address,address,uint256)', 'erc20'],
  ['approve(address,uint256)', 'erc20'],
  ['allowance(address,address)', 'erc20'],

  // Single owner
  ['owner()', 'ownership'],
  ['getOwner()', 'ownership'],
  ['transferOwnership(address)', 'ownership'],
  ['renounceOwnership()', 'ownership'],

  // Role-based access
  ['grantRole(bytes32,address)', 'roles'],
  ['revokeRole(bytes32,address)', 'roles'],
  ['hasRole(bytes32,address)', 'roles'],

  // Creating new tokens
  ['mint(address,uint256)', 'mint'],
  ['mint(uint256)', 'mint'],
  ['mintTo(address,uint256)', 'mint'],
  ['issue(uint256)', 'mint'],

  // Burning (holder burns their own; informational)
  ['burn(uint256)', 'burn'],
  ['burnFrom(address,uint256)', 'burn'],

  // Freezing all transfers
  ['pause()', 'pause'],
  ['unpause()', 'pause'],
  ['paused()', 'pause'],

  // Blocking specific wallets
  ['blacklist(address)', 'blacklist'],
  ['blacklist(address,bool)', 'blacklist'],
  ['setBlacklist(address,bool)', 'blacklist'],
  ['addToBlacklist(address)', 'blacklist'],
  ['removeFromBlacklist(address)', 'blacklist'],
  ['isBlacklisted(address)', 'blacklist'],
  ['setBots(address[])', 'blacklist'],
  ['blockBots(address[])', 'blacklist'],
  ['addBots(address[])', 'blacklist'],
  ['addBlackList(address)', 'blacklist'],      // USDT on Ethereum
  ['removeBlackList(address)', 'blacklist'],
  ['destroyBlackFunds(address)', 'blacklist'],

  // Changing buy/sell tax
  ['setFee(uint256)', 'fee'],
  ['setFees(uint256,uint256)', 'fee'],
  ['setTaxFee(uint256)', 'fee'],
  ['setTax(uint256)', 'fee'],
  ['setBuyFee(uint256)', 'fee'],
  ['setSellFee(uint256)', 'fee'],
  ['updateFees(uint256,uint256)', 'fee'],
  ['setBuyTax(uint256)', 'fee'],
  ['setSellTax(uint256)', 'fee'],

  // Who pays no tax
  ['excludeFromFee(address)', 'feeExempt'],
  ['includeInFee(address)', 'feeExempt'],
  ['setExcludedFromFee(address,bool)', 'feeExempt'],

  // Transaction / wallet size limits
  ['setMaxTxAmount(uint256)', 'limit'],
  ['setMaxTxPercent(uint256)', 'limit'],
  ['setMaxWalletSize(uint256)', 'limit'],
  ['setMaxWallet(uint256)', 'limit'],
  ['removeLimits()', 'limit'],

  // Trading on/off switch
  ['enableTrading()', 'trading'],
  ['openTrading()', 'trading'],
  ['setTradingEnabled(bool)', 'trading'],
  ['setTrading(bool)', 'trading'],

  // Upgradeable proxies
  ['upgradeTo(address)', 'upgrade'],
  ['upgradeToAndCall(address,bytes)', 'upgrade'],
  ['implementation()', 'upgrade'],
  ['deprecate(address)', 'upgrade'],           // USDT: forwards every call to a new contract
];
