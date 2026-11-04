// Saphan bundles (contracts/SaphanBundles.sol): the formats a wallet needs to build a bundle, fund its legs from other
// chains through the Gateway, and read what a call to another chain carries.
import { AbiCoder, keccak256, id as keccakId } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
export const TAG = keccakId('saphan/bundle/v1');
export const LEG = 'tuple(uint256 srcChainId,address gateway,address token,address sender,uint256 amount,address refundTo)';
export const ACTION = 'tuple(address target,address token,uint256 amount,uint64 gasLimit,bytes data)';
export const OUT = 'tuple(address gateway,address token,address target,uint256 amount,uint256 maxFee,uint64 gasLimit,address revertTo,bytes data)';
export const PLAN = `tuple(${ACTION}[] actions,${OUT}[] outs)`;

const legT = (l) => [l.srcChainId, l.gateway, l.token, l.sender, l.amount, l.refundTo];
const actionT = (x) => [x.target, x.token, x.amount, x.gasLimit, x.data ?? '0x'];
const outT = (o) => [o.gateway, o.token, o.target, o.amount, o.maxFee ?? 0n, o.gasLimit, o.revertTo, o.data ?? '0x'];

/** create()'s arguments: [legs, plan, deadline] as tuples. */
export const createArgs = ({ legs, actions = [], outs = [], deadline }) => [legs.map(legT), [actions.map(actionT), outs.map(outT)], BigInt(deadline)];
/** The plan as a tuple (what execute() takes again). */
export const planTuple = ({ actions = [], outs = [] }) => [actions.map(actionT), outs.map(outT)];
/** SaphanBundles.planHash. */
export const planHash = (plan) => keccak256(abi.encode(['bytes32', PLAN], [TAG, planTuple(plan)]));
/** The data of a depositAndCall that funds leg `leg` of bundle `id` (target = SaphanBundles on ZETAPHY). */
export const legData = (id, leg) => abi.encode(['bytes32', 'uint256'], [id, leg]);
/** What a target on another chain receives in onSaphanCall's data from a bundle: { id, creator, data }. */
export function decodeOutData(data) {
  const [id, creator, inner] = abi.decode(['bytes32', 'address', 'bytes'], data);
  return { id, creator, data: inner };
}

/** Every token the legs bring must be spent exactly (create() refuses otherwise): the imbalance per token, if any. */
export function imbalance({ legs, actions = [], outs = [] }) {
  const m = new Map();
  const add = (t, v) => m.set(t.toLowerCase(), (m.get(t.toLowerCase()) ?? 0n) + v);
  for (const l of legs) add(l.token, BigInt(l.amount));
  for (const x of [...actions, ...outs]) add(x.token, -BigInt(x.amount));
  return [...m].filter(([, v]) => v !== 0n).map(([token, v]) => ({ token, left: v }));
}
