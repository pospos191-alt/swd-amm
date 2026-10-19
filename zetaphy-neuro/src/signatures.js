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
  ['pendingOwner()', 'ownership'],             // two-step transfer (Ownable2Step)
  ['acceptOwnership()', 'ownership'],

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
  ['setFees(uint256,uint256,uint256)', 'fee'],
  ['setTaxes(uint256,uint256)', 'fee'],
  ['setTaxRates(uint256,uint256)', 'fee'],
  ['setBuyTaxRate(uint256)', 'fee'],
  ['setSellTaxRate(uint256)', 'fee'],
  ['updateBuyFees(uint256,uint256,uint256)', 'fee'],
  ['updateSellFees(uint256,uint256,uint256)', 'fee'],
  ['reduceFee(uint256)', 'fee'],
  ['reduceTaxes(uint256,uint256)', 'fee'],
  ['lowerTaxes(uint256,uint256)', 'fee'],
  ['lowerTaxes(uint16,uint16)', 'fee'],          // ZETAPHY launcher tokens (NEWZETA)
  // Where the tax goes
  ['setTaxWallet(address)', 'taxWallet'],
  ['setMarketingWallet(address)', 'taxWallet'],
  ['setBuyTax(uint256)', 'fee'],
  ['setSellTax(uint256)', 'fee'],

  // Who pays no tax
  ['excludeFromFee(address)', 'feeExempt'],
  ['includeInFee(address)', 'feeExempt'],
  ['setExcludedFromFee(address,bool)', 'feeExempt'],
  ['setExempt(address,bool)', 'feeExempt'],    // ZETAPHY launcher tokens

  // Transaction / wallet size limits
  ['setMaxTxAmount(uint256)', 'limit'],
  ['setMaxTxPercent(uint256)', 'limit'],
  ['setMaxWalletSize(uint256)', 'limit'],
  ['setMaxWallet(uint256)', 'limit'],
  ['removeLimits()', 'limit'],
  ['setMaxWalletAmount(uint256)', 'limit'],
  ['setMaxTransactionAmount(uint256)', 'limit'],
  ['updateMaxTxnAmount(uint256)', 'limit'],
  ['updateMaxWalletAmount(uint256)', 'limit'],
  ['setMaxWalletPercent(uint256)', 'limit'],
  ['setLimits(uint256,uint256)', 'limit'],
  ['setAntiWhale(bool)', 'limit'],
  ['setLimitsEnabled(bool)', 'limit'],
  ['relaxLimits(uint16,uint16)', 'limit'],     // ZETAPHY launcher tokens

  // Trading on/off switch
  ['enableTrading()', 'trading'],
  ['openTrading()', 'trading'],
  ['setTradingEnabled(bool)', 'trading'],
  ['setTrading(bool)', 'trading'],
  ['startTrading()', 'trading'],
  ['openTrading(address)', 'trading'],         // ZETAPHY launcher tokens (seen on NEWZETA, BNB Chain)

  // Common read-only getters: named so they are not reported as unknown.
  ['tradingOpen()', 'view'],
  ['tradingEnabled()', 'view'],
  ['buyFee()', 'view'],
  ['sellFee()', 'view'],
  ['buyTax()', 'view'],
  ['sellTax()', 'view'],
  ['tax()', 'view'],
  ['maxTx()', 'view'],
  ['maxWallet()', 'view'],
  ['_maxTxAmount()', 'view'],
  ['_maxWalletSize()', 'view'],
  ['taxWallet()', 'view'],
  ['marketingWallet()', 'view'],
  ['uniswapV2Pair()', 'view'],
  ['uniswapV2Router()', 'view'],
  ['isExcludedFromFee(address)', 'view'],
  // Getters seen on ZETAPHY launcher tokens (NEWZETA, BNB Chain).
  ['buyTaxBps()', 'view'],
  ['sellTaxBps()', 'view'],
  ['transferTaxBps()', 'view'],
  ['maxWalletAmount()', 'view'],
  ['maxWalletBps()', 'view'],
  ['maxTxBps()', 'view'],
  ['MIN_MAX_WALLET_BPS()', 'view'],
  ['MIN_MAX_TX_BPS()', 'view'],
  ['MAX_TOTAL_TAX_BPS()', 'view'],
  ['BPS()', 'view'],
  ['DEAD()', 'view'],
  ['daoFactory()', 'view'],
  ['maxTxAmount()', 'view'],
  ['isExempt(address)', 'view'],
  ['pair()', 'view'],
  ['factory()', 'view'],

  // Holder-side extensions: signed approvals (ERC-2612) and voting power
  // (ERC20Votes). Each holder controls only their own tokens with these.
  ['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', 'holder'],
  ['nonces(address)', 'holder'],
  ['DOMAIN_SEPARATOR()', 'holder'],
  ['eip712Domain()', 'holder'],
  ['delegate(address)', 'holder'],
  ['delegateBySig(address,uint256,uint256,uint8,bytes32,bytes32)', 'holder'],
  ['delegates(address)', 'holder'],
  ['getVotes(address)', 'holder'],
  ['getPastVotes(address,uint256)', 'holder'],
  ['getPastTotalSupply(uint256)', 'holder'],
  ['numCheckpoints(address)', 'holder'],
  ['checkpoints(address,uint32)', 'holder'],
  ['clock()', 'holder'],
  ['CLOCK_MODE()', 'holder'],

  // Upgradeable proxies
  ['upgradeTo(address)', 'upgrade'],
  ['upgradeToAndCall(address,bytes)', 'upgrade'],
  ['implementation()', 'upgrade'],
  ['deprecate(address)', 'upgrade'],           // USDT: forwards every call to a new contract
];
