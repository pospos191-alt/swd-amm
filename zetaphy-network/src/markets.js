// Helpers for the forecasting / data / detector / arena contracts (docs/future/markets.md):
// commitments, the Data DAO's rewards merkle tree, reading questions and exporting resolved
// ones as labelled data for Neuro's ML. Pure functions + ethers; no server.

import { readFileSync } from 'node:fs';
import { AbiCoder, Contract, getAddress, keccak256, concat, toBeHex, randomBytes, hexlify } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
export const artifact = (name) => JSON.parse(readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), 'utf8'));

export const KIND = ['liquidity-drop', 'flagged'];
export const STATUS = ['none', 'open', 'proposed', 'disputed', 'final'];
export const ANSWER = ['none', 'no', 'yes', 'void'];

/** A fresh 32-byte salt (keep it: without it a commitment cannot be revealed). */
export const newSalt = () => hexlify(randomBytes(32));

/** ForesightRegistry.commitmentOf(eventId, modelId, p, salt); p in basis points (0..10000). */
export function foresightCommitment(eventId, modelId, pBps, salt) {
  const p = Number(pBps);
  if (!Number.isInteger(p) || p < 0 || p > 10_000) throw new Error('p must be an integer 0..10000 (basis points)');
  return keccak256(coder.encode(['uint256', 'bytes32', 'uint16', 'bytes32'], [BigInt(eventId), modelId, p, salt]));
}

/**
 * A salt derived from the forecaster's private key, the event and the model: a schedule (GitHub Actions)
 * can commit and later reveal without storing anything, and nobody without the key can guess it (a
 * probability has only 10001 values, so a public or guessable salt would leak the forecast).
 */
export function derivedSalt(privateKey, eventId, modelId) {
  return keccak256(coder.encode(['string', 'bytes32', 'uint256', 'bytes32'], ['zetaphy foresight salt', keccak256(privateKey), BigInt(eventId), modelId]));
}

/** RedBlueArena.commitmentOf(round, side, author, contentHash, salt); side 0 = red, 1 = blue. */
export function arenaCommitment(arena, round, side, author, contentHash, salt) {
  return keccak256(coder.encode(['address', 'uint256', 'uint8', 'address', 'bytes32', 'bytes32'], [getAddress(arena), BigInt(round), side, getAddress(author), contentHash, salt]));
}

/** keccak256 of the exact bytes of an entry's content (what reveal() states and runners check). */
export const contentHash = (bytes) => keccak256(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);

/** A Neuro / detector model id: keccak256 of its name, e.g. "neuro-ml nml-b4c35477f7b1". */
export const modelIdOf = (name) => keccak256(new TextEncoder().encode(String(name)));

// ------------------------------------------------------------------ Data DAO rewards tree

/** DataDAO.leafOf(round, account, amount): keccak256(keccak256(abi.encode(dao, chainId, round, account, amount))). */
export function rewardLeaf(dao, chainId, round, account, amount) {
  return keccak256(keccak256(coder.encode(['address', 'uint256', 'uint256', 'address', 'uint256'], [getAddress(dao), BigInt(chainId), BigInt(round), getAddress(account), BigInt(amount)])));
}

const pair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/**
 * @param rewards [{account, amount}] amounts in wei (bigint or decimal string); one entry per account
 * @returns {root, total, claims: {account: {amount, proof}}}
 */
export function rewardsTree({ dao, chainId, round, rewards }) {
  const rows = rewards.filter((r) => BigInt(r.amount) > 0n).map((r) => ({ account: getAddress(r.account), amount: BigInt(r.amount) }));
  if (!rows.length) throw new Error('no rewards');
  if (new Set(rows.map((r) => r.account)).size !== rows.length) throw new Error('one entry per account');
  const leaves = rows.map((r) => rewardLeaf(dao, chainId, round, r.account, r.amount));
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const prev = layers.at(-1);
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? pair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  const proofOf = (index) => {
    const proof = [];
    for (let l = 0, i = index; l < layers.length - 1; l++, i >>= 1) {
      const sib = i ^ 1;
      if (sib < layers[l].length) proof.push(layers[l][sib]);
    }
    return proof;
  };
  return {
    root: layers.at(-1)[0],
    total: rows.reduce((s, r) => s + r.amount, 0n),
    claims: Object.fromEntries(rows.map((r, i) => [r.account, { amount: r.amount.toString(), proof: proofOf(i) }])),
  };
}

export function verifyReward({ dao, chainId, round, root }, account, amount, proof) {
  return proof.reduce((h, p) => pair(h, p), rewardLeaf(dao, chainId, round, account, amount)) === root;
}

/**
 * Attribution report (zetaphy-neuro/ml/dao/attribute.js) -> reward amounts. Only contributors with a
 * positive share are paid; the budget is split by share, rounding down (the rest stays in the pool).
 */
export function rewardsFromReport(report, budgetWei) {
  const budget = BigInt(budgetWei);
  const rows = (report.contributors ?? []).filter((c) => c.share > 0 && /^0x[0-9a-fA-F]{40}$/.test(c.account ?? ''));
  const SCALE = 1_000_000n;
  return rows.map((c) => ({ account: getAddress(c.account), amount: (budget * BigInt(Math.floor(c.share * 1e6))) / SCALE })).filter((r) => r.amount > 0n);
}

// ------------------------------------------------------------------ risk forecasts -> labelled data

/** Reads every question of a RiskForecasts contract (read-only). */
export async function readQuestions(runner, address, { from = 1, to = null } = {}) {
  const c = new Contract(address, artifact('RiskForecasts').abi, runner);
  const count = Number(await c.count());
  const out = [];
  for (let id = from; id <= (to ?? count); id++) {
    const [q, s] = await Promise.all([c.questions(id), c.states(id)]);
    out.push({
      id, token: q.token, pair: q.pair, kind: KIND[Number(q.kind)], dropBps: Number(q.dropBps),
      createdAt: Number(q.createdAt), closeAt: Number(q.closeAt), deadline: Number(q.deadline), baseReserve: q.baseReserve.toString(),
      status: STATUS[Number(s.status)], proposed: ANSWER[Number(s.proposed)], answer: ANSWER[Number(s.answer)],
      seenAt: Number(s.seenAt), yes: s.yes.toString(), no: s.no.toString(), foresightId: Number(s.foresightId),
    });
  }
  return out;
}

/**
 * Final, non-void questions as labelled rows for Neuro's ML: label 1 when the bad thing happened
 * (liquidity drop or flag), 0 when it did not. `crowdP` is the stake-weighted Yes share (a weak,
 * separate signal; never the label). Rows feed zetaphy-neuro/ml/data/votes.js (`votes` form) to be
 * read again with Neuro and turned into features.
 */
export function exportRows(questions, { chain = 'zetaphy', chainId = 77390, contract = null } = {}) {
  return questions
    .filter((q) => q.status === 'final' && (q.answer === 'yes' || q.answer === 'no'))
    .map((q) => {
      const yes = BigInt(q.yes); const no = BigInt(q.no);
      const crowdP = yes + no > 0n ? Number((yes * 10_000n) / (yes + no)) / 10_000 : null;
      return {
        id: `forecast-${chainId}-${contract ? contract.toLowerCase().slice(2, 10) + '-' : ''}${q.id}`,
        src: 'risk-forecasts', license: 'own data', chain, chainId,
        address: q.token.toLowerCase(), pair: q.pair.toLowerCase(),
        question: q.kind === 'flagged' ? 'flagged' : `liquidity-drop-${q.dropBps}bps`,
        horizonDays: Math.round(((q.deadline - q.createdAt) / 86400) * 100) / 100,
        label: q.answer === 'yes' ? 1 : 0, flagged: q.answer === 'yes', crowdP,
        resolvedFrom: q.kind === 'flagged' ? 'ThreatRegistry' : 'pair reserves',
      };
    });
}

export const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/** Arena result numbers -> the args of RedBlueArena.postResult (bitmaps as bigint). */
export function arenaResultArgs(result) {
  const bits = (idx) => idx.reduce((m, i) => m | (1n << BigInt(i)), 0n);
  const valid = result.red.filter((r) => r.valid).map((r) => r.index);
  const evaded = result.red.filter((r) => r.valid && r.evaded).map((r) => r.index);
  return [bits(valid), bits(evaded), [...result.blue].sort((a, b) => a.index - b.index).map((b) => b.score)];
}

/** RedBlueArena.resultKey(sandbox, redValid, redEvaded, blueScore): what runners commit to and the quorum agrees on. */
export function arenaResultKey(sandbox, [redValid, redEvaded, blueScore]) {
  return keccak256(coder.encode(['bytes32', 'uint256', 'uint256', 'int32[]'], [sandbox, BigInt(redValid), BigInt(redEvaded), blueScore.map(Number)]));
}

/** RedBlueArena.resultCommitmentOf(round, runner, key, salt): a runner's sealed result. */
export function arenaResultCommitment(arena, round, runner, key, salt) {
  return keccak256(coder.encode(['address', 'uint256', 'address', 'bytes32', 'bytes32'], [getAddress(arena), BigInt(round), getAddress(runner), key, salt]));
}

/** A runner's result salt, derived from its key (commit and reveal need nothing stored in between). */
export function arenaResultSalt(privateKey, arena, round) {
  return keccak256(coder.encode(['string', 'bytes32', 'address', 'uint256'], ['zetaphy arena result salt', keccak256(privateKey), getAddress(arena), BigInt(round)]));
}

export { toBeHex };
