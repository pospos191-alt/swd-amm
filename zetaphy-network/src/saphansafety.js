// Saphan safety (contracts/HyperlaneLockBoxV2.sol escape hatch, contracts/SaphanChallenges.sol): the exit root our
// validators sign when a route escapes, and its proofs, computed exactly as the lockbox checks them.
//   leaf  = keccak256(keccak256(abi.encode(address, owed)))   (the double hash: a leaf is never an inner node)
//   node  = keccak256(min(a, b) || max(a, b))                 (sorted pairs, like OpenZeppelin's MerkleProof)
//   An odd node at the end of a level goes up as it is.
import { AbiCoder, keccak256, concat, getAddress, id as keccakId } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
export const EXIT_TAG = keccakId('saphan/exit-root/v1');

export const exitLeaf = (account, owed) => keccak256(keccak256(abi.encode(['address', 'uint256'], [getAddress(account), BigInt(owed)])));
const pair = (x, y) => (BigInt(x) < BigInt(y) ? keccak256(concat([x, y])) : keccak256(concat([y, x])));

/** Every level of the tree, leaves first (sorted, so the root does not depend on the list's order). */
function levels(entries) {
  const seen = new Set();
  for (const [acct] of entries) {
    const k = getAddress(acct);
    if (seen.has(k)) throw new Error(`exit root: ${k} twice (add its amounts up first)`);
    seen.add(k);
  }
  let level = entries.map(([acct, owed]) => exitLeaf(acct, owed)).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));
  if (!level.length) throw new Error('exit root: nothing owed');
  const out = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
    out.push(level = next);
  }
  return out;
}

/** The root and total of what `entries` ([[address, owed]], each address once) owes. */
export function exitTree(entries) {
  const ls = levels(entries);
  return { root: ls[ls.length - 1][0], total: entries.reduce((s, [, v]) => s + BigInt(v), 0n), count: entries.length };
}

/** The proof of `account`'s line (what escape() takes). */
export function exitProof(entries, account) {
  const ls = levels(entries);
  const e = entries.find(([x]) => getAddress(x) === getAddress(account));
  if (!e) throw new Error(`${account} is not in the exit list`);
  let i = ls[0].indexOf(exitLeaf(e[0], e[1]));
  const proof = [];
  for (let k = 0; k < ls.length - 1; k++) {
    const sib = i ^ 1;
    if (sib < ls[k].length) proof.push(ls[k][sib]);
    i >>= 1;
  }
  return proof;
}

/** What each validator signs (personal_sign of these 32 bytes): HyperlaneLockBoxV2.exitDigest. */
export function exitDigest({ chainId, lockbox, root, total, lastHeard }) {
  return keccak256(abi.encode(['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'uint64'], [EXIT_TAG, BigInt(chainId), getAddress(lockbox), root, BigInt(total), BigInt(lastHeard)]));
}

/**
 * What the exit owes, from the three sources (all as [address, wei] lists): token(X) balances on ZETAPHY at its
 * last block, releases queued on the lockbox and not claimed (their receivers), and locks ZETAPHY never minted
 * (their senders). Summed per address; zero lines dropped.
 */
export function exitEntitlements({ balances = [], unclaimedReleases = [], unmintedLocks = [] }) {
  const m = new Map();
  for (const [acct, v] of [...balances, ...unclaimedReleases, ...unmintedLocks]) {
    const k = getAddress(acct);
    m.set(k, (m.get(k) ?? 0n) + BigInt(v));
  }
  return [...m].filter(([, v]) => v > 0n).sort(([x], [y]) => (x < y ? -1 : 1));
}

