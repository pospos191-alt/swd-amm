// Proof of Intent, the solver side: sign intents (EIP-712 or ML-DSA-44) and compile them into
// IntentExecutor calls. The intent schema itself is zetaphy-hub/intent-core.js (one copy, used by the
// hub page and here). The compiler is deterministic code, not a model: whatever produced the intent
// (a person, a form, or a model's draft the person confirmed), the calls are built from its fields
// and the executor checks their effects on chain.
import { Interface, TypedDataEncoder, keccak256, getAddress, AbiCoder } from 'ethers';
import { INTENT_FIELDS, KINDS, KIND_NAMES, domain, targetsHash, checkIntent, ZERO_HASH } from '../../zetaphy-hub/intent-core.js';

export { KINDS, KIND_NAMES, checkIntent, ZERO_HASH };
export const TYPES = { Intent: INTENT_FIELDS };
const ROUTER = new Interface(['function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)']);
const VAULT = new Interface(['function deposit(uint256 amount, address to)']);

export const hashTargets = (targets) => targetsHash(targets.map((t) => getAddress(t)), (b) => keccak256(b));

/** Normalised intent (bigints, checksummed addresses). */
export function intentOf(o) {
  return {
    user: getAddress(o.user), kind: Number(o.kind), tokenIn: getAddress(o.tokenIn), maxIn: BigInt(o.maxIn),
    tokenOut: getAddress(o.tokenOut), minOut: BigInt(o.minOut), recipient: getAddress(o.recipient),
    targetsHash: o.targetsHash ?? ZERO_HASH, nonce: BigInt(o.nonce), deadline: BigInt(o.deadline),
  };
}
export const intentTuple = (i) => INTENT_FIELDS.map(({ name }) => i[name]);

export const intentDigest = (intent, executor, chainId) => TypedDataEncoder.hash(domain(executor, chainId), TYPES, intentOf(intent));

/** ECDSA EIP-712 signature (the same as eth_signTypedData_v4 in MetaMask). */
export async function signIntent(wallet, intent, executor, chainId) {
  const sig = await wallet.signTypedData(domain(executor, chainId), TYPES, intentOf(intent));
  return { sigType: 0, sig, pqPublicKey: '0x' };
}

/** ML-DSA-44 signature of the same EIP-712 digest; pq = src/pq.js pqFromSeed() (or any {publicKey, sign}). */
export function signIntentPq(pq, intent, executor, chainId) {
  return { sigType: 1, sig: pq.sign(intentDigest(intent, executor, chainId)), pqPublicKey: pq.publicKey };
}

/**
 * Builds the calls for an intent. The targets are fixed by the intent's targetsHash (the user
 * signed them), so the compiler can only pick routes through those contracts.
 * @param {object} intent
 * @param {{router?:string, path?:string[], vault?:string, bridge?:string, swapDeadline?:bigint}} route
 * @returns {{targets:string[], spender:string, calls:Array<{target:string,data:string}>}}
 */
export function compile(intent, route = {}) {
  const i = intentOf(intent);
  const kind = KIND_NAMES[i.kind];
  if (kind === 'send') return { targets: [], spender: '0x0000000000000000000000000000000000000000', calls: [] };
  if (kind === 'swap') {
    if (!route.router) throw new Error('a swap needs --router (the DEX router the intent lists)');
    const router = getAddress(route.router);
    const path = (route.path?.length ? route.path : [i.tokenIn, i.tokenOut]).map((a) => getAddress(a));
    if (path[0] !== i.tokenIn || path[path.length - 1] !== i.tokenOut) throw new Error('the path must start at tokenIn and end at tokenOut');
    const data = ROUTER.encodeFunctionData('swapExactTokensForTokens', [i.maxIn, i.minOut, path, i.recipient, route.swapDeadline ?? i.deadline]);
    return { targets: [router], spender: router, calls: [{ target: router, data }] };
  }
  if (kind === 'stake') {
    if (!route.vault) throw new Error('a stake needs --vault (the staking vault the intent lists)');
    const vault = getAddress(route.vault);
    return { targets: [vault], spender: vault, calls: [{ target: vault, data: VAULT.encodeFunctionData('deposit', [i.maxIn, i.recipient]) }] };
  }
  if (kind === 'bridge') {
    if (!route.bridge) throw new Error('a bridge intent needs --bridge (the bridge the intent lists)');
    return { targets: [getAddress(route.bridge)], spender: '0x0000000000000000000000000000000000000000', calls: [] }; // the executor calls send() itself
  }
  if (kind === 'approve') throw new Error('an allowance intent is not executed: its spender calls IntentExecutor.spendAllowance(intent, auth, to, amount)');
  throw new Error('unknown intent kind');
}

/** The arguments of IntentExecutor.spendAllowance(intent, auth, to, amount) (APPROVE intents, called by the spender). */
export function spendArgs(intent, auth, to, amount) {
  return [intentTuple(intentOf(intent)), [auth.sigType, auth.sig, auth.pqPublicKey ?? '0x'], getAddress(to), BigInt(amount)];
}

/** The arguments of IntentExecutor.execute(intent, auth, plan). */
export function executeArgs(intent, auth, plan) {
  return [intentTuple(intentOf(intent)), [auth.sigType, auth.sig, auth.pqPublicKey ?? '0x'], [plan.targets, plan.spender, plan.calls.map((c) => [c.target, c.data])]];
}

/** A signed intent as JSON (what the hub page exports and `zetaphy intent execute` reads). */
export function signedJson({ intent, auth, executor, chainId, route }) {
  const str = (v) => (typeof v === 'bigint' ? v.toString() : v);
  return JSON.stringify({ executor, chainId: Number(chainId), intent: Object.fromEntries(Object.entries(intentOf(intent)).map(([k, v]) => [k, str(v)])), auth, ...(route ? { route } : {}) }, null, 2);
}

/** Parses and checks a signed intent file; throws on anything malformed. */
export function readSigned(text, nowSec) {
  const j = JSON.parse(text);
  const problems = checkIntent(j.intent, nowSec);
  if (problems.length) throw new Error(`intent: bad ${problems.join(', ')}`);
  if (![0, 1].includes(Number(j.auth?.sigType)) || !/^0x[0-9a-fA-F]*$/.test(j.auth?.sig ?? '')) throw new Error('intent: bad signature');
  return { executor: getAddress(j.executor), chainId: BigInt(j.chainId), intent: intentOf(j.intent),
    auth: { sigType: Number(j.auth.sigType), sig: j.auth.sig, pqPublicKey: j.auth.pqPublicKey ?? '0x' }, route: j.route ?? {} };
}

export const abi = AbiCoder.defaultAbiCoder();
