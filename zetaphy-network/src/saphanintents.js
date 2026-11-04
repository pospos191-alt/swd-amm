// Saphan intents (contracts/SaphanIntents.sol): the order format, the data of a depositAndCall that opens an intent
// from another chain, and what a solver checks before filling.
import { AbiCoder, keccak256, id as keccakId } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
export const ORDER = 'tuple(address tokenIn,uint256 amountIn,uint32 dstDomain,address tokenOut,address recipient,uint256 minOut,uint64 deadline,address refundTo)';
export const STATUS = ['None', 'Open', 'Claimed', 'Filled', 'Refunded'];
const ZERO = '0x' + '00'.repeat(20);

export const TAG = keccakId('saphan/intent/v1');
/** The id of the `nonce`-th intent SaphanIntents at `intents` opened (its Opened event says it too). */
export const intentId = (chainId, intents, nonce) => keccak256(abi.encode(['bytes32', 'uint256', 'address', 'uint256'], [TAG, chainId, intents, nonce]));

export const orderTuple =(o) => [o.tokenIn, o.amountIn, o.dstDomain, o.tokenOut ?? ZERO, o.recipient, o.minOut, o.deadline, o.refundTo];
/** The data of SaphanSourceGateway.depositAndCall(target = SaphanIntents on ZETAPHY, ...) that opens this order. */
export const orderData = (o) => abi.encode([ORDER], [orderTuple(o)]);

/**
 * Whether a fill of `amountOut` to `recipient` on chain `domain` at time `now` would be repaid (what SaphanIntents.handle
 * checks), from intentOf(id) on ZETAPHY. Returns null when it would, else the reason.
 */
export function fillProblem(intent, { domain, recipient, amountOut, now }) {
  const o = intent.order;
  const status = STATUS[Number(intent.status)];
  if (status !== 'Open') return `the intent is ${status}`;
  if (BigInt(o.dstDomain) !== BigInt(domain)) return 'another chain';
  if (o.recipient.toLowerCase() !== recipient.toLowerCase()) return 'another recipient';
  if (BigInt(amountOut) < BigInt(o.minOut)) return `less than minOut ${o.minOut}`;
  if (BigInt(now) > BigInt(o.deadline)) return 'past the deadline';
  if (BigInt(now) < BigInt(intent.notBefore)) return `Neuro risk delay: not before ${intent.notBefore}`;
  return null;
}
