// Saphan accounts (contracts/SaphanAccounts.sol): one account address per user on every Saphan chain, controlled
// from ZETAPHY. This derives the addresses off-chain and builds the calls that use an account on another chain.
//
//   factoryAddress(deployer)            where SaphanAccountFactory is on every chain (the deployer's first transaction)
//   accountAddress(factory, owner, ac)  the owner's account (the same on every chain); ac = SaphanAccount's creation code
//   accountCalls(calls)                 the data of a withdrawAndCall that runs `calls` from the account
//   controlArgs({ account, calls, amount, maxFee, gasLimit })
//                                       ZetaphyGateway.withdrawAndCall's arguments (refunds go back to the account)
import { AbiCoder, keccak256, solidityPacked, getCreate2Address, getCreateAddress, getAddress, zeroPadValue } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
export const CALL = 'tuple(address target,uint256 value,bytes data)';

/** SaphanAccountFactory is deployed by one fresh key as its first transaction on each chain: the same address everywhere. */
export const factoryAddress = (deployer, nonce = 0) => getCreateAddress({ from: deployer, nonce });

export const accountCodeHash = (accountCreationCode, owner) => keccak256(solidityPacked(['bytes', 'bytes'], [accountCreationCode, abi.encode(['address'], [owner])]));

/** The owner's account on every chain that has the factory at `factory`. */
export const accountAddress = (factory, owner, accountCreationCode) =>
  getCreate2Address(getAddress(factory), zeroPadValue(getAddress(owner), 32), accountCodeHash(accountCreationCode, owner));

/** The data that makes an account run `calls` ([{ target, value, data }]) when it arrives through the Gateway. */
export const accountCalls = (calls) => abi.encode([`${CALL}[]`], [calls.map((x) => [x.target, x.value ?? 0n, x.data ?? '0x'])]);

/**
 * ZetaphyGateway.withdrawAndCall arguments for the owner (msg.sender on ZETAPHY) to run `calls` from its account on
 * that Gateway's chain. `amount` of token(X) becomes ETH in the account (at least maxFee + what the calls spend);
 * a failed call refunds to the account itself (revertTo): anyone then moves it into the account with pullRefunds().
 */
export const controlArgs = ({ account, calls, amount, maxFee = 0n, gasLimit = 500_000n }) =>
  [account, accountCalls(calls), BigInt(amount), BigInt(maxFee), BigInt(gasLimit), account];
