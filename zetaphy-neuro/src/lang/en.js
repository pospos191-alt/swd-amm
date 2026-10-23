import { fmtSupply, list } from './fmt.js';

// English: the reference language. Every other language file has the same keys.
export const NAME = 'English';

export const LEVEL = { high: 'High risk', medium: 'Medium risk', low: 'Low risk', info: 'No risk found by these rules' };

export const UI = {
  subtitle: 'Reads and explains contracts · tier 1, read-only', chain: 'Chain', address: 'Contract or token address', check: 'Check contract',
  details: 'Details', reading: 'Reading from the chain…', badAddress: 'Invalid address for this chain. Accepted formats: ',
  failed: 'Could not read: ', footer: 'Never asks to connect a wallet and never sends a transaction. Reads public chain data; for an early-warning check it sends only the chain and contract address to the server of this site, which stores nothing. Not investment advice.', stats: 'Usage stats', statChecks: 'Contracts checked', statRisky: 'Risky contracts flagged', statHigh: 'High risk found', statNote: 'All users together, approximate. Only the result level is counted, never the contract.', language: 'Language',
  disclaimer: 'This is automated, reproducible code analysis, not an accusation against any person or project, and not investment advice. The contract owner can respond or request a correction.',
  correction: 'How to respond or request a correction',
  reproduce: 'Check it yourself',
  reproduceHow: 'Anyone can re-run this check with the command below (in the zetaphy-neuro folder). The verdict ID covers only what the rules decided, so it matches while the contract\'s code and settings stay the same. The report ID also covers numbers that change, such as supply.',
  asWritten: 'Name and symbol are shown as written in the contract; Neuro does not confirm them.',
  early: 'Early warning: patterns not yet published',
  earlyHow: "ZETAPHY's server also compares this contract's code with patterns that are being watched but are not public yet, so that they cannot be worked around before they are announced. It matched the patterns below. This is advisory only: it is not part of the result above or of the network's verdict, it can be wrong, and the patterns are published later (usually within about 30 days).",
  m: {
    chain: 'Chain', address: 'Address', proxy: 'Proxy', implementation: 'Implementation', owner: 'Owner', functions: 'Known functions', report: 'Report ID', explorer: 'Open in explorer', fingerprint: 'Code fingerprint (for template registration)', unknown: 'Unnamed functions',
    program: 'Token program', mintAuth: 'Mint authority', freezeAuth: 'Freeze authority', extensions: 'Extensions', upgradeAuth: 'Upgrade authority', none: 'none',
    package: 'Package', standard: 'Standard', admin: 'Admin', holders: 'Holders', listed: 'tonapi list', raw: 'Raw address',
    idl: 'Anchor IDL', codeId: 'Code ID', label: 'Label', creator: 'Creator', migrations: 'Code replaced', hook: 'Transfer hook contract', source: 'Verified source', format: 'Code format', delegation: 'Code this wallet runs', walletCode: 'Holder wallet code', nearKeys: 'Full-access keys', codeHash: 'Code hash', cairo: 'Cairo version', maxSupply: 'Maximum supply', tokenId: 'Token ID',
    pool: 'Liquidity pool', simTax: 'Simulated tax (buy / sell)', simFailed: 'sell failed',
    verdict: 'Verdict ID (rules only)', command: 'Command', rule: 'rule',
    earlyMatch: 'Matches a watched pattern. Category:', earlyRef: 'reference',
  },
};

// ThreatRegistry categories (src/threat-reasons.js), as neutral descriptions of what the code does.
export const REASON = { 'cannot-sell-in-simulation': 'in a simulated trade, selling failed or returned almost nothing', 'unlimited-mint': 'an address can mint new tokens without a cap', 'owner-can-block-transfers': 'an owner or admin can stop transfers or sales', 'owner-can-move-holder-funds': 'an owner or admin can move or burn funds held by others', 'same-name-as-known-token': 'same name or symbol as a known token, at a different address', 'sweeps-approved-tokens': 'in a reproducible test, it moved approved tokens to an address the holder did not choose', 'other': 'another code fact (see the evidence)' };

export const T = {
    'no-code': () => 'This address has no contract code. It may be a plain wallet, or the wrong chain is selected.',
    'erc20': (p) => `ERC-20 token "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'not-erc20': () => 'No standard ERC-20 functions found. This contract may not be a token.',
    'name-has-link': () => 'The token name or symbol, as written in the contract, contains a link or website name. Tokens sent unasked with a link in the name are often used to send people to outside websites. Do not visit it or connect your wallet because of the token name.',
    'proxy-minimal': (p) => `Minimal clone (EIP-1167) that always runs the code at ${p.implementation}. The code cannot be changed.`,
    'proxy-upgradeable': (p) => (p.issuer
      ? `${p.issuer} can upgrade the contract's code, the usual way issuers fix or extend it.`
      : `Upgradeable: the admin${p.admin ? ` (${p.admin})` : ''} can replace all of the code at any time. What is checked today may not hold tomorrow.`),
    'owner-active': (p) => `An owner controls this contract: ${p.owner}`,
    'owner-renounced': () => 'Ownership is renounced (owner is the zero address). Owner-only functions can no longer be called.',
    'owner-unknown': () => 'No owner() function found, so it is unclear who holds the special powers below. Assume someone does.',
    'roles': () => 'Uses role-based permissions. Several addresses may hold special powers; the code alone does not show who.',
    'can-mint': (p) => (p.issuer
      ? `${p.issuer} can mint (${list(p.functions)}) to issue tokens against deposits, as expected for this kind of token.`
      : `Can create new tokens (${list(p.functions)}), diluting holders or flooding the market.`),
    'can-blacklist': (p) => (p.issuer
      ? `${p.issuer} can freeze specific wallets (${list(p.functions)}), usually for stolen funds or legal orders.`
      : `Can block specific wallets (${list(p.functions)}). A blocked wallet may be unable to sell or transfer.`),
    'can-pause': (p) => (p.issuer
      ? `${p.issuer} can pause all transfers (${list(p.functions)}) in an emergency.`
      : `Can freeze all transfers (${list(p.functions)}). Nobody may be able to sell.`),
    'can-change-fee': (p) => (p.decreaseOnly
      ? `Can adjust the tax (${list(p.functions)}), but the ${p.project} template only allows lowering it.`
      : `Can change the buy/sell tax (${list(p.functions)}). A very high sell tax means selling returns almost nothing.`),
    'known-issuer': (p) => `Official ${p.symbol} contract issued by ${p.issuer} (matches the registered address). The powers below belong to the issuer; the main risk is trust in the issuer, not hidden code.`,
    'lookalike': (p) => `Uses the symbol ${p.symbol}, the same as ${p.issuer}'s token, but this is NOT the address registered for it (${p.official}). This contract is not the registered ${p.issuer} token; check the address before buying or accepting it.`,
    'template-match': (p) => `Matches the registered ${p.project} token template (${p.name}). The template's rules are not audited yet.`,
    'template-mismatch': (p) => `Code matches the ${p.project} template but has a power the template says it lacks (${list(p.functions)}). The template record may be wrong; do not trust it until checked.`,
    'trading-switch': (p) => `Has a trading on/off switch (${list(p.functions)}). Before it is on, you may be able to buy but not sell.`,
    'can-limit': (p) => `Can set per-transaction or per-wallet limits (${list(p.functions)}). Very low limits can block selling.`,
    'fee-exempt': (p) => `Can exempt chosen wallets from tax (${list(p.functions)}). Common in taxed tokens, but it gives some wallets an edge.`,
    'network-flagged': (p) => `Neuro ZETAPHY network runners voted to record this exact code in the ThreatRegistry${p.reason ? ` (category: ${REASON[p.reason] ?? p.reason})` : ''}. Every contract with the same code gets the same warning.`,
    'similar-flagged': (p) => `This code is ${p.percent}% similar to code that Neuro runners flagged (fingerprint ${String(p.fingerprint ?? '').slice(0, 12)}…${p.reason ? `, category: ${REASON[p.reason] ?? p.reason}` : ''}). Lightly edited copies of flagged code usually behave the same way.`,
    'similar-reference': (p) => `This code is ${p.percent}% similar to a reference sample in Neuro's dataset (fingerprint ${String(p.fingerprint ?? '').slice(0, 12)}…${p.reason ? `, category: ${REASON[p.reason] ?? p.reason}` : ''}). The sample is not code that Neuro runners flagged on chain. Similarity is a hint to look closer, not proof.`,
    'tax-wallet': (p) => `Can change the wallet that receives the tax (${list(p.functions)}). Common in taxed tokens.`,
    'selfdestruct': () => 'The code contains SELFDESTRUCT. If triggered, it can wipe the contract or move its funds.',
    'delegatecall': () => 'The code can run another contract\'s code as its own (DELEGATECALL), so the code that really runs may not be the code shown here.',
    'nothing-found': () => 'No special powers or dangerous instructions found by these rules.',
    'unknown-functions': (p) => `${p.count} more function(s) Neuro cannot name (${(p.selectors ?? []).map((x) => '0x' + x).join(', ')}), so what they do is unknown. While an owner still controls the contract, they may be privileged, e.g. setting a tax or trading limits.`,
    'unknown-pattern': (p) => `Neuro doesn't recognise this pattern yet, be careful: ${p.share}% of its functions have no known name, and the code can move coins or tokens. Finding nothing here does not mean it is safe.`,
    'bytecode-only': () => 'Checked from on-chain code with fixed rules. Powers hidden behind unusual function names can be missed. Not investment advice.',
    // Solana
    'sol-not-found': () => 'No account at this address on Solana. It may be mistyped, or the wrong chain is selected.',
    'sol-not-token': (p) => `This address is not a token mint on Solana; it is an account of program ${p.owner}.`,
    'sol-token': (p) => `${p.program} token "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sol-mint-authority': (p) => (p.issuer
      ? `${p.issuer} can mint (mint authority: ${p.authority}) to issue tokens against deposits, as expected for this kind of token.`
      : `New tokens can still be minted (mint authority: ${p.authority}), diluting holders or flooding the market.`),
    'sol-mint-renounced': () => 'Mint authority is renounced: the supply can never grow.',
    'sol-freeze-authority': (p) => (p.issuer
      ? `${p.issuer} can freeze accounts (freeze authority), usually for stolen funds or legal orders.`
      : `Accounts can still be frozen (freeze authority: ${p.authority}). A frozen account cannot sell or transfer.`),
    'sol-freeze-renounced': () => 'Freeze authority is renounced: nobody can freeze your tokens.',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} can move or burn tokens from any account (permanent delegate), used for legal seizures.`
      : `A permanent delegate (${p.delegate}) can move or burn tokens from EVERY wallet without permission. Very high risk to holders.`),
    'sol-transfer-fee': (p) => `Charges ${p.percent}% on every transfer${p.authority ? `, and the fee authority (${p.authority}) can raise it as high as 100%` : ''}.`,
    'sol-transfer-hook': (p) => `Every transfer runs an extra program (transfer hook: ${p.programId}) that can enforce its own rules, such as blocking sells.`,
    'sol-default-frozen': () => 'New accounts for this token start frozen: after buying you may be unable to move or sell until unfrozen.',
    'sol-pausable': (p) => `All transfers can be paused (pausable)${p.paused ? ', and they are paused right now' : ''}.`,
    'sol-close-authority': (p) => `The mint can be closed and re-created at the same address (close authority: ${p.authority}).`,
    'sol-non-transferable': () => 'This token cannot be transferred (non-transferable): a badge or right, not a tradable coin.',
    'sol-metadata-mutable': (p) => `Name, symbol and image can still be changed (update authority: ${p.authority}), e.g. later made to imitate another token.`,
    'sol-program-upgradeable': (p) => `Upgradeable program: the authority (${p.authority}) can replace its code at any time.`,
    'sol-program-immutable': () => 'This program can no longer be upgraded; its code is fixed.',
    'sol-caveat': () => 'Checked from on-chain account data with fixed rules; liquidity and holder distribution are not checked. Not investment advice.',
    'can-seize': (p) => (p.issuer
      ? `${p.issuer} can seize or burn tokens from any wallet (${list(p.functions)}), used for legal seizures.`
      : `Has functions that take or burn tokens from other people's wallets (${list(p.functions)}). Your tokens could be taken without your permission.`),
    // Sui
    'sui-not-found': () => 'No coin or package at this address on Sui. It may be mistyped, or the wrong chain is selected.',
    'sui-coin': (p) => `Sui coin "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sui-not-coin': (p) => `Package ${p.package} exists, but no coin with that name was found. Check the module and coin name.`,
    'sui-package': (p) => `A Move code package on Sui (${p.package}), not a coin. The results below are the powers its code exposes.`,
    'sui-supply-fixed': () => 'The supply is locked: it can never grow or shrink.',
    'sui-supply-burn-only': () => 'No more coins can be minted; they can only be burned.',
    'sui-treasury': (p) => {
      if (p.issuer) return `${p.issuer} can mint (TreasuryCap) to issue coins against deposits, as expected for this kind of coin.`;
      if (p.holder) return `New coins can still be minted: wallet ${p.holder} holds the mint key (TreasuryCap) and can mint without limit, diluting holders or flooding the market.`;
      const where = { object: 'is kept inside another contract', shared: 'is in a shared object' }[p.where] ?? 'still exists, but its holder was not found';
      return `New coins can still be minted: the mint key (TreasuryCap) ${where}. The minting rules depend on the code that holds it.`;
    },
    'sui-regulated': (p) => (p.issuer
      ? `${p.issuer} can block specific wallets (DenyCap), usually for stolen funds or legal orders.`
      : `A regulated coin: the DenyCap holder${p.holder ? ` (${p.holder})` : ''} can block wallets. A blocked wallet cannot use or sell this coin.`),
    'sui-global-pause': (p) => (p.issuer
      ? `${p.issuer} can pause all use of this coin in an emergency.`
      : 'The DenyCap holder can pause this coin for everyone at once (global pause).'),
    'sui-system': () => 'Sui system code: it can only be upgraded by a validator vote.',
    'sui-upgradeable': (p) => (p.issuer
      ? `${p.issuer} can upgrade the package's code, the usual way issuers fix or extend it.`
      : `Upgradeable package: the UpgradeCap holder${p.holder ? ` (${p.holder})` : p.where === 'object' ? ' (kept inside another contract)' : ''} can change the code (policy: ${p.policy}). What is checked today may not hold tomorrow.`),
    'sui-upgrade-cap-gone': () => 'The upgrade key (UpgradeCap) no longer exists on its own: it was destroyed, making the code permanent, or locked inside another contract.',
    'move-truncated': () => 'This package is large; Neuro checked only the first 50 modules and 50 functions per module.',
    'move-caveat': () => 'Checked from function names and on-chain data with fixed rules. Function bodies and liquidity are not checked. Not investment advice.',
    // Aptos
    'apt-not-found': () => 'No coin or account at this address on Aptos. It may be mistyped, or the wrong chain is selected.',
    'apt-not-token': (p) => (p.account ? 'This address is a user account on Aptos, not a token.' : 'This address is an Aptos object that is not a token.'),
    'apt-token': (p) => `Aptos ${p.standard} "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}${p.maxSupply ? `, maximum ${fmtSupply(p.maxSupply, p.decimals)}` : ''}.`,
    'apt-package': (p) => `A Move code package on Aptos (${p.address}), not a token. The results below are the powers its code exposes.`,
    'apt-managed-coin': (p) => (p.issuer
      ? `${p.issuer} can mint, freeze and burn (managed_coin), as expected for this kind of token.`
      : `The creator (${p.account}) holds the mint, freeze and burn powers (managed_coin) and can mint at any time.`),
    'apt-mint-power': (p) => (p.issuer
      ? `${p.issuer} can mint to issue tokens against deposits, as expected for this kind of token.`
      : `The creator's code keeps the power to mint (${list(p.structs)}). New tokens can still be created, diluting holders.`),
    'apt-freeze-power': (p) => (p.issuer
      ? `${p.issuer} can freeze specific wallets, usually for stolen funds or legal orders.`
      : `The creator's code keeps the power to freeze wallets (${list(p.structs)}). A frozen wallet cannot sell or transfer, and a TransferRef can move your tokens without permission.`),
    'apt-burn-power': (p) => (p.issuer
      ? `${p.issuer} can burn tokens from any wallet, used for legal seizures.`
      : `The creator's code keeps the power to burn (${list(p.structs)}) tokens from anyone's wallet.`),
    'apt-dispatch': (p) => (p.issuer
      ? `${p.issuer} runs extra code on every deposit and withdrawal (${list(p.functions)}).`
      : `Every deposit and withdrawal runs extra code (${list(p.functions)}) that can enforce its own rules, such as blocking sells.`),
    'apt-untransferable': () => 'Token stores cannot change owner (untransferable). Normal token transfers still work.',
    'apt-upgradeable': (p) => (p.issuer
      ? `${p.issuer} can upgrade the code, the usual way issuers fix or extend it.`
      : `The creator's code (${list(p.packages)} at ${p.address}) is upgradeable: that account can change it at any time. What is checked today may not hold tomorrow.`),
    'apt-immutable': (p) => `The creator's code (${p.address}) is set to immutable: it can never change.`,
    'apt-framework': () => 'Aptos system code: it can only be upgraded by a network vote.',
    // TON
    'ton-not-found': () => 'No contract at this address on TON (it does not exist or is not deployed). It may be mistyped.',
    'ton-not-jetton': (p) => {
      if (p.wallet) return 'This address is a wallet, not a token.';
      if ((p.interfaces ?? []).includes('jetton_wallet')) return 'This is one holder\'s jetton wallet, not the token itself. Enter the token\'s main address (jetton master).';
      return `This TON contract is not a token${p.interfaces?.length ? ` (${list(p.interfaces)})` : ''}.`;
    },
    'ton-scam': () => 'tonapi.io (a third party) has put a warning label on this token or its admin account. This is tonapi.io\'s label, not a result of this code check; check its reason before buying or accepting the token.',
    'ton-jetton': (p) => `TON token (jetton) "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}${p.holders != null ? `, ${fmtSupply(p.holders, 0)} holders` : ''}.`,
    'ton-listed': () => 'On tonapi.io\'s list of checked tokens (whitelist). That is a third party\'s list, not a guarantee.',
    'ton-frozen': () => 'This token contract is frozen for unpaid storage fees and cannot be used right now.',
    'ton-mintable': (p) => (p.issuer
      ? `${p.issuer} can mint to issue tokens against deposits, as expected for this kind of token.`
      : `The admin (${p.admin}) can still mint new tokens, diluting holders or flooding the market.`),
    'ton-admin': (p) => (p.issuer
      ? `${p.issuer} is the contract admin and can change the token's data.`
      : `An admin (${p.admin}) can still change the name and logo, and if the contract code is not standard, may hold other powers this check cannot see.`),
    'ton-admin-dropped': () => 'The admin role was dropped: nobody can mint or change the token\'s data any more.',
    'ton-mint-flag': () => 'The contract still says it is mintable, but there is no admin to mint.',
    'ton-caveat': () => 'Checked from contract data decoded by tonapi.io with fixed rules; the holders\' wallet is checked by what tonapi recognises, not read line by line. Not investment advice.',
    'ton-wallet-standard': (p) => `Holders' tokens live in a standard jetton wallet that tonapi.io recognises (${list(p.interfaces)}).`,
    'ton-wallet-custom': (p) => (p.issuer
      ? `${p.issuer} uses its own jetton wallet code, as expected for this token.`
      : `Holders' tokens live in wallet code that tonapi.io does not recognise as a standard jetton wallet${p.compiler ? ` (${p.compiler})` : ''}. Custom wallet code can refuse to send, so you may be able to buy but not sell. Code hash: ${p.codeHash ?? '?'}.`),
    // Solana programs (Anchor IDL)
    'sol-idl': (p) => `This program is written in Rust (Anchor) and publishes its instruction list on chain: ${p.name ?? '?'}, ${p.count ?? '?'} instructions.`,
    'sol-admin-instructions': (p) => `Instructions that need an admin's signature (${list(p.functions)}). The admin can use them to change how the program behaves.`,
    'sol-no-idl': () => 'This program does not publish its instruction list (Anchor IDL) on chain, so what it can do cannot be read.',
    // EVM code that is not EVM bytecode
    'stylus-code': (p) => (p.issuer
      ? `${p.issuer} uses a Stylus contract (Rust/C++ compiled to WASM on Arbitrum), which Neuro's rules cannot read yet.`
      : 'A Stylus contract (Rust or C++ compiled to WASM on Arbitrum). Neuro\'s rules cannot read this code yet, so it is unknown whether it can mint, block or pause. Treat it as unchecked.'),
    'stylus-read': (p) => `A Stylus contract (Rust or C++ compiled to WASM on Arbitrum). Neuro unpacked its WASM code (${fmtSupply(p.size, 0)} bytes) and found ${p.count ?? 0} known function(s) in it; the findings below come from them. Unusual function names can be missed.`,
    'unknown-code-format': (p) => (p.issuer
      ? `${p.issuer} uses code that is not standard EVM bytecode.`
      : 'This contract\'s code is not standard EVM bytecode and Neuro\'s rules cannot read it. Treat it as unchecked.'),
    'eip7702': (p) => `This address is an ordinary wallet whose owner set it to run the code of contract ${p.target} (EIP-7702). It is not a token. That code can do whatever it was written to do with the wallet's funds; check ${p.target} too.`,
    'source-verified': (p) => `Public source code that Sourcify confirmed ${p.match === 'exact' ? 'matches the on-chain code byte for byte' : 'matches the on-chain code'} (${[p.name, p.language, p.compiler].filter(Boolean).join(', ')}). Read it at ${p.url}`,
    'source-unverified': () => 'No source code on Sourcify. It may still be published on the chain\'s explorer; if it is published nowhere, be extra careful.',
    // Trade simulation (buy/sell test, src/honeypot.js)
    'sim-cannot-sell': (p) => `Sell test failed: in a simulated trade through ${p.dex}, buying worked but selling ${p.sell == null ? 'failed' : `gave back almost nothing (${p.sell}% lost)`}. If you buy, you may not be able to sell. (A few tokens block selling only right after a buy; this check cannot tell the two apart.)`,
    'sim-high-tax': (p) => (p.buy >= 100 && p.sell == null
      ? `A simulated buy through ${p.dex} delivered no tokens at all: the whole purchase was taken.`
      : `A simulated trade through ${p.dex} lost ${p.buy ?? '?'}% when buying and ${p.sell ?? '?'}% when selling, taken by the token as tax. You get back that much less than the price suggests.`),
    'sim-ok': (p) => `A simulated buy and sell of a small amount through ${p.dex} worked (tax: ${p.buy}% buy, ${p.sell}% sell). This is a test at the current block only: whoever controls the contract may still raise the tax or block selling later.`,
    'sim-skipped': (p) => ({
      'no-pool': `No ${p.dex} pool pairing this token with ${p.native} was found, so no test buy and sell was run. This alone is not a warning sign; the token may trade elsewhere.`,
      'no-override': 'The public RPC did not allow a simulated trade (state override), so no test buy and sell was run.',
      'buy-failed': `A simulated buy through ${p.dex} failed, so selling could not be tested. Trading may not be open yet, or the token may refuse buys from contracts.`,
    })[p.why] ?? 'The simulated trade could not be run, so buying and selling were not tested.',
    // CosmWasm (Osmosis, Neutron)
    'cw-not-found': () => 'No contract or token at this address on this chain. It may be mistyped, or the wrong chain is selected.',
    'cw20-token': (p) => `CW20 token (a Rust contract on CosmWasm) "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'cw-contract': (p) => `A CosmWasm contract (written in Rust)${p.label ? ` named "${p.label}"` : ''}, code ID ${p.codeId ?? '?'}. Not a CW20 token.`,
    'cw-admin': (p) => `The admin (${p.admin}) can replace the contract's code with new code at any time (migrate). What is checked today may not hold tomorrow.`,
    'cw-no-admin': () => 'No admin: the contract\'s code can never be replaced.',
    'cw-migrated': (p) => `This contract's code has already been replaced ${p.count} time(s).`,
    'cw20-minter': (p) => `${p.minter} can still mint new tokens${p.cap ? `, up to ${fmtSupply(p.cap, p.decimals)} in total` : ' without limit'}, diluting holders or flooding the market.`,
    'cw20-no-minter': () => 'Nobody can mint more of this token.',
    'tf-token': (p) => `Token Factory coin "${p.name ?? '?'}"${p.symbol ? ` (${p.symbol})` : ''} created by ${p.creator}, total supply ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'tf-admin': (p) => `The admin (${p.admin}) can mint without limit, and on some chains can also move or burn tokens from other people's wallets.`,
    'tf-no-admin': () => 'The admin role was dropped: nobody can mint more.',
    'tf-hook': (p) => `Every transfer must pass contract ${p.contract} (before-send hook), which can enforce its own rules, such as blocking sells.`,
    'cw-caveat': () => 'Checked from on-chain contract data with fixed rules. The Rust code inside and liquidity are not checked. Not investment advice.',
    // NEAR
    'near-not-found': () => 'No account with this name on NEAR. It may be mistyped, or the wrong chain is selected.',
    'near-no-contract': () => 'This NEAR account is a plain account with no contract. It is not a token.',
    'near-token': (p) => `NEAR token (NEP-141) "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'near-contract': (p) => `A NEAR contract (WASM code, e.g. from Rust) with ${p.count ?? '?'} public functions. Not a NEP-141 token.`,
    'near-full-access': (p) => (p.issuer
      ? `${p.issuer} still holds a full-access key to the contract account, so it can change the code, the usual way issuers fix or extend it.`
      : `The contract account still has ${p.count} full-access key(s): whoever holds one can deploy new code over it at any time. What is checked today may not hold tomorrow.`),
    'near-locked': () => 'The contract account has no full-access keys: nobody can deploy new code over it from outside.',
    'near-upgrade-method': (p) => (p.issuer
      ? `${p.issuer} can upgrade the code through a contract function (${list(p.functions)}).`
      : `The code has functions that can replace its own code (${list(p.functions)}). Even without a full-access key, whoever may call them can change it.`),
    'near-caveat': () => 'Checked from the function names in the WASM code and on-chain account data with fixed rules. Function bodies are not read. Not investment advice.',
    // Starknet (Cairo)
    'sn-not-found': () => 'No contract at this address on Starknet. It may be mistyped, or the wrong chain is selected.',
    'sn-token': (p) => `Starknet token "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sn-contract': (p) => `A Starknet contract (written in Cairo ${p.cairo === 1 ? '1' : '0'}) with ${p.count ?? '?'} functions in its ABI. Not a token.`,
    'sn-upgradeable': (p) => (p.issuer
      ? `${p.issuer} can upgrade the contract's code, the usual way issuers fix or extend it.`
      : `Upgradeable${p.implementation ? ` (a proxy pointing at code ${p.implementation})` : ''}${p.functions?.length ? ` through ${list(p.functions)}` : ''}: whoever is allowed can replace all of the code. What is checked today may not hold tomorrow.`),
    'sn-caveat': () => 'Checked from the ABI the contract publishes on chain (function names and whether they change state) with fixed rules. Function bodies are not read. Not investment advice.',
    // Bitcoin (Runes)
    'btc-not-found': () => 'No Rune with this name or id on Bitcoin. A Rune is a name like DOG•GO•TO•THE•MOON or an id like 840000:3. BRC-20 tokens are not read yet.',
    'btc-rune': (p) => `Bitcoin Rune "${p.name ?? '?'}"${p.symbol ? ` (${p.symbol})` : ''}, id ${p.id ?? '?'}, supply so far ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'btc-no-admin': () => 'Bitcoin tokens have no contract code and no owner: nobody can freeze, blacklist, pause, tax or change this token. Its rules were fixed when it was created.',
    'btc-open-mint': (p) => (p.unlimited
      ? 'Anyone can still mint more, with no cap and no end date, so the supply can keep growing without limit.'
      : `Minting is still open: anyone can mint more until ${p.end ? `block ${p.end} or ` : ''}${p.maxSupply ? `the maximum of ${fmtSupply(p.maxSupply, p.decimals)} is reached` : 'the mint period ends'}${p.percent != null ? ` (${p.percent}% minted so far)` : ''}. The supply is still growing.`),
    'btc-premine': (p) => `${p.percent}% of the maximum supply went to the creator when the token was created (premine). They can sell it at any time.`,
    'btc-turbo': () => 'The creator opted in to future Runes protocol changes (turbo), so how this token works may change with new protocol versions.',
    'btc-caveat': () => 'Read from ord (ordinals.com), the reference Runes indexer, with fixed rules. Runes exist as indexer rules on top of Bitcoin. Holders and liquidity are not checked. Not investment advice.',
};
