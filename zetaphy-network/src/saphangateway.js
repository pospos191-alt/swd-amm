// ZETAPHY Saphan Gateway (contracts/SaphanGateway.sol): call formats, hashes and deposit addresses as the
// contracts compute them, and the executor (scripts/saphan.js gateway-execute): finds calls that are ready and runs them.
//   X -> ZETAPHY: DepositAndCall on X (the InCall); ready when the route minted to its deposit address on ZETAPHY,
//                 or when the airlock can release it (execute with release = true and the lock's nonce).
//   ZETAPHY -> X: OutCallSent on ZETAPHY (the OutCall); ready when the lockbox on X paid its deposit address, or its
//                 queued release is due (the executor claims it from the lockbox, then executes).
import { AbiCoder, Interface, keccak256, solidityPacked, getCreate2Address, getAddress, id as keccakId } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
export const IN_CALL = 'tuple(uint256 srcChainId,address srcGateway,uint256 nonce,address sender,address target,uint256 amount,uint256 maxFee,uint64 gasLimit,address revertTo,bool callOnRevert,address abortTo,bytes data,bytes revertMessage)';
export const OUT_CALL = 'tuple(uint256 dstChainId,address dstGateway,address srcGateway,uint256 nonce,address sender,address target,uint256 amount,uint256 maxFee,uint64 gasLimit,address revertTo,uint8 kind,bytes data)';
export const IN_TAG = keccakId('saphan/gateway/in/v1');
export const OUT_TAG = keccakId('saphan/gateway/out/v1');
export const CALL = 0;
export const REVERT = 1;

export const ZETAPHY_GATEWAY = new Interface([
  `function execute(${IN_CALL} p, bool release, uint256 lockNonce) payable returns (bool)`,
  `function outCall(uint256 nonce, address sender, address target, uint256 amount, uint256 maxFee, uint64 gasLimit, address revertTo, uint8 kind, bytes data) view returns (${OUT_CALL})`,
  'function remote() view returns (address)', 'function token() view returns (address)', 'function remoteChainId() view returns (uint256)',
  'function withdrawAndCall(address target, bytes data, uint256 amount, uint256 maxFee, uint64 gasLimit, address revertTo) payable returns (bytes32)',
  'function quoteWithdraw(uint256 amount) view returns (uint256)', 'function aborted(address) view returns (uint256)', 'function claimAborted()',
  `event OutCallSent(bytes32 indexed callHash, uint256 indexed nonce, address indexed sender, address depositAddress, ${OUT_CALL} call)`,
  'event Reverted(bytes32 indexed callHash, address indexed revertTo, uint256 amount, bool withCall, bytes32 outHash)',
  'event Executed(bytes32 indexed callHash, uint256 indexed nonce, address indexed target, uint256 amount, uint256 fee, address executor)',
]);
export const SOURCE_GATEWAY = new Interface([
  `function execute(${OUT_CALL} o) returns (bool)`,
  'function depositAndCall(address target, bytes data, uint256 amount, uint256 maxFee, uint64 gasLimit, address revertTo, bool callOnRevert, address abortTo, bytes revertMessage) payable returns (bytes32)',
  'function quoteDeposit(uint256 amount) view returns (uint256)', 'function remote() view returns (address)', 'function remoteToken() view returns (address)',
  `event DepositAndCall(bytes32 indexed callHash, uint256 indexed nonce, address indexed sender, address depositAddress, ${IN_CALL} call)`,
  'event Executed(bytes32 indexed callHash, address indexed target, uint256 amount, uint256 fee, address executor)',
]);
export const LOCKBOX_EVENTS = new Interface([
  'event Locked(uint256 indexed nonce, address indexed sender, address indexed to, uint256 amount)',
  'event ReleaseQueued(bytes32 indexed id, uint256 indexed srcNonce, address sender, address indexed to, uint256 amount, uint64 readyAt)',
  'function releases(bytes32) view returns (address to, uint64 readyAt, bool claimed, bool vetoed, uint256 amount)',
  'function claim(bytes32 id)',
]);

const IN_KEYS = ['srcChainId', 'srcGateway', 'nonce', 'sender', 'target', 'amount', 'maxFee', 'gasLimit', 'revertTo', 'callOnRevert', 'abortTo', 'data', 'revertMessage'];
const OUT_KEYS = ['dstChainId', 'dstGateway', 'srcGateway', 'nonce', 'sender', 'target', 'amount', 'maxFee', 'gasLimit', 'revertTo', 'kind', 'data'];
/** An InCall / OutCall as a plain object (from an event's Result or an array). */
export const inCall = (x) => Object.fromEntries(IN_KEYS.map((k, i) => [k, x[k] ?? x[i]]));
export const outCall = (x) => Object.fromEntries(OUT_KEYS.map((k, i) => [k, x[k] ?? x[i]]));
const inTuple = (p) => IN_KEYS.map((k) => p[k]);
const outTuple = (o) => OUT_KEYS.map((k) => o[k]);

export const hashIn = (p) => keccak256(abi.encode(['bytes32', IN_CALL], [IN_TAG, inTuple(inCall(p))]));
export const hashOut = (o) => keccak256(abi.encode(['bytes32', OUT_CALL], [OUT_TAG, outTuple(outCall(o))]));

/** The deposit address `gateway` derives for a call hash (token: token(X) on ZETAPHY, or zero for ETH on X). */
export function depositAddressOf(depositInitCode, gateway, callHash, token) {
  const code = keccak256(solidityPacked(['bytes', 'bytes'], [depositInitCode, abi.encode(['address'], [token])]));
  return getCreate2Address(getAddress(gateway), callHash, code);
}

/** The REVERT OutCall ZetaphyGateway builds for a failed InCall with callOnRevert (outNonce: the Reverted's order). */
export function revertOutCall(p, { zetaphyGateway, outNonce, amount }) {
  const q = inCall(p);
  return outCall({ dstChainId: q.srcChainId, dstGateway: q.srcGateway, srcGateway: zetaphyGateway, nonce: outNonce, sender: q.sender, target: q.revertTo,
    amount, maxFee: 0n, gasLimit: q.gasLimit, revertTo: q.revertTo, kind: REVERT, data: abi.encode(['uint256', 'bytes'], [q.nonce, q.revertMessage]) });
}

/**
 * What the executor does with each known call. `inbound`: [{ call, lockNonce }] from X; `outbound`: [{ call, releaseId }]
 * from ZETAPHY. The readers answer from chain state: tokenBalance(depositAddress) on ZETAPHY, ethBalance(depositAddress)
 * and release(id) ({ readyAt, claimed, vetoed }) on X, used(depositAddress) (code there: already run) on either.
 * Returns the calls to run now, each with the arguments of execute, and why the others wait.
 */
export async function plan({ inbound = [], outbound = [], depositInitCode, zetaphyGateway, sourceGateway, remoteToken, now, read }) {
  const run = [], wait = [];
  for (const { call, lockNonce } of inbound) {
    const p = inCall(call);
    const at = depositAddressOf(depositInitCode, zetaphyGateway, hashIn(p), remoteToken);
    if (await read.usedOnZetaphy(at)) continue;
    const have = await read.tokenBalance(at);
    if (have >= BigInt(p.amount)) run.push({ side: 'zetaphy', fn: 'execute', args: [inTuple(p), false, lockNonce ?? 0n], at });
    else if (lockNonce != null && (await read.airlockReady(p, at, lockNonce))) run.push({ side: 'zetaphy', fn: 'execute', args: [inTuple(p), true, lockNonce], at });
    else wait.push({ side: 'zetaphy', at, why: 'the route has not minted it yet (lanes, quarantine, checks)' });
  }
  for (const { call, releaseId } of outbound) {
    const o = outCall(call);
    const at = depositAddressOf(depositInitCode, sourceGateway, hashOut(o), '0x' + '00'.repeat(20));
    if (await read.usedOnSource(at)) continue;
    const have = await read.ethBalance(at);
    if (have >= BigInt(o.amount)) { run.push({ side: 'source', fn: 'execute', args: [outTuple(o)], at }); continue; }
    const r = releaseId ? await read.release(releaseId) : null;
    // due: claim the lockbox's release to the deposit address first, then execute
    if (r && !r.claimed && !r.vetoed && BigInt(r.readyAt) !== 0n && BigInt(r.readyAt) <= BigInt(now)) run.push({ side: 'source', fn: 'execute', args: [outTuple(o)], at, claim: releaseId });
    else wait.push({ side: 'source', at, why: r?.vetoed ? 'vetoed by a guardian' : r ? `the lockbox's delay (ready at ${r.readyAt})` : 'not relayed to the lockbox yet' });
  }
  return { run, wait };
}
