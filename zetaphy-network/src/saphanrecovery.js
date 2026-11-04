// Saphan recovery after an incident (contracts/SaphanRecovery.sol, docs/SAPHAN-PR6.md item S10):
//   pause -> snapshot of owed balances from public events -> Merkle claims (the escape hatch's exit tree:
//   src/saphansafety.js) -> resume. Everything here is a pure function of events, so anyone can rebuild the snapshot
//   and check the root governance is about to set (its timelock delay is the time to do so).
import { getAddress, Interface, ZeroAddress, id as topicId } from 'ethers';
import { exitTree, exitProof, exitEntitlements } from './saphansafety.js';

export const TRANSFER = topicId('Transfer(address,address,uint256)');
export const RELEASE_QUEUED = topicId('ReleaseQueued(bytes32,uint256,address,address,uint256,uint64)');
export const RELEASED = topicId('Released(bytes32,address,uint256)');
export const LOCKED = topicId('Locked(uint256,address,address,uint256)');

/** Token balances from Transfer logs ([{ from, to, value }], in order), up to the incident; zero / negative dropped. */
export function balancesFromTransfers(transfers) {
  const m = new Map();
  const add = (a, v) => { const k = getAddress(a); m.set(k, (m.get(k) ?? 0n) + v); };
  for (const t of transfers) {
    const v = BigInt(t.value);
    if (getAddress(t.from) !== ZeroAddress) add(t.from, -v);
    if (getAddress(t.to) !== ZeroAddress) add(t.to, v);
  }
  return [...m].filter(([, v]) => v > 0n);
}

/**
 * What the incident owes, per address:
 *   transfers          Transfer logs of token(X) on ZETAPHY up to the incident block
 *   releasesQueued     [{ id, to, amount }] from the lockbox; released: ids paid (Released)
 *   locks              [{ transferId, sender, amount }] from the lockbox; minted: transfer ids ZETAPHY released (airlock)
 *   exclude            addresses governance decided to leave out (e.g. the attacker; the decision is public in the proposal)
 *   holders            contracts that hold for others (e.g. the privacy pool, a gateway deposit address): their line is
 *                      kept as is; their own recovery is theirs
 * Returns { entries: [[address, wei]] sorted, excluded: [[address, wei]], total }.
 */
export function snapshot({ transfers = [], releasesQueued = [], released = [], locks = [], minted = [], exclude = [] }) {
  const paid = new Set(released.map(String));
  const done = new Set(minted.map(String));
  const all = exitEntitlements({
    balances: balancesFromTransfers(transfers),
    unclaimedReleases: releasesQueued.filter((r) => !paid.has(String(r.id))).map((r) => [r.to, r.amount]),
    unmintedLocks: locks.filter((l) => !done.has(String(l.transferId))).map((l) => [l.sender, l.amount]),
  });
  const ex = new Set(exclude.map((a) => getAddress(a)));
  const entries = all.filter(([a]) => !ex.has(a));
  const excluded = all.filter(([a]) => ex.has(a));
  return { entries, excluded, total: entries.reduce((s, [, v]) => s + v, 0n) };
}

/** Root, total and every proof of a snapshot (what start() and claim() take). */
export function claimsFile(entries) {
  const { root, total, count } = exitTree(entries);
  return { root, total: total.toString(), count, claims: Object.fromEntries(entries.map(([a, v]) => [a, { owed: v.toString(), proof: exitProof(entries, a) }])) };
}

/** Reads the snapshot's inputs from a provider (ethers): token(X) on ZETAPHY, the lockbox on the source chain. */
export async function readEvents({ zetaphy, token, airlock = null, source = null, lockbox = null, fromBlock = 0, toBlock, sourceFrom = 0, sourceTo = 'latest' }) {
  const erc20 = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const lb = new Interface(['event ReleaseQueued(bytes32 indexed id, uint256 indexed srcNonce, address sender, address indexed to, uint256 amount, uint64 readyAt)',
    'event Released(bytes32 indexed id, address indexed to, uint256 amount)', 'event Locked(uint256 indexed nonce, address indexed sender, address indexed to, uint256 amount)',
    'function transferIds(uint256) view returns (bytes32)']);
  const al = new Interface(['event Released(bytes32 indexed id, address indexed to, uint256 amount)']);
  const logs = async (p, address, topic, a, b) => p.getLogs({ address, topics: [topic], fromBlock: a, toBlock: b });
  const transfers = (await logs(zetaphy, token, TRANSFER, fromBlock, toBlock)).map((l) => { const e = erc20.parseLog(l); return { from: e.args.from, to: e.args.to, value: e.args.value }; });
  const out = { transfers, releasesQueued: [], released: [], locks: [], minted: [] };
  if (airlock) out.minted = (await logs(zetaphy, airlock, al.getEvent('Released').topicHash, fromBlock, toBlock)).map((l) => al.parseLog(l).args.id);
  if (source && lockbox) {
    out.releasesQueued = (await logs(source, lockbox, RELEASE_QUEUED, sourceFrom, sourceTo)).map((l) => { const e = lb.parseLog(l); return { id: e.args.id, to: e.args.to, amount: e.args.amount }; });
    out.released = (await logs(source, lockbox, RELEASED, sourceFrom, sourceTo)).map((l) => lb.parseLog(l).args.id);
    const locked = (await logs(source, lockbox, LOCKED, sourceFrom, sourceTo)).map((l) => lb.parseLog(l).args);
    const reader = { call: (data) => source.call({ to: lockbox, data }) };
    for (const e of locked) {
      const id = lb.decodeFunctionResult('transferIds', await reader.call(lb.encodeFunctionData('transferIds', [e.nonce])))[0];
      out.locks.push({ transferId: id, sender: e.sender, amount: e.amount });
    }
  }
  return out;
}

/**
 * The guided path: which step is next, from what is known about the route now.
 *   state { paused (lockbox / guard), snapshot (a claims file exists), claims (the SaphanRecoveryClaims address),
 *           started (root set), funded (pool >= total, or how much), deadlinePassed, swept, resumed }
 * Returns [{ step, done, what, calls }] in order; the first not done is the next one.
 */
export function plan(state = {}) {
  const steps = [
    { step: 'pause', done: !!state.paused, what: 'guardians pause the lockbox (pause()) and the guard (pause()): nothing more moves',
      calls: ['lockbox.pause() [source-chain guardian multisig]', 'guard.pause() [ZETAPHY guardian multisig]'] },
    { step: 'snapshot', done: !!state.snapshot, what: 'rebuild who is owed what from events up to the incident block (recovery snapshot), publish the claims file',
      calls: ['node scripts/saphan.js recovery snapshot --events events.json --exclude 0x… > claims.json'] },
    { step: 'deploy', done: !!state.claims, what: 'deploy SaphanRecoveryClaims(governance = the timelock, token or 0 for the native coin, sweepTo, claimPeriod)',
      calls: ['new SaphanRecoveryClaims(timelock, token, insurance, 30 days)'] },
    { step: 'fund', done: !!state.funded, what: 'insurance / treasury / recovered funds go to the claims contract (it pays pro rata if short)',
      calls: ['send coins to the claims contract, or fund(amount) after approve for a token'] },
    { step: 'start', done: !!state.started, what: 'governance sets the root once (the timelock delay is everyone\'s time to check it)',
      calls: ['timelock.schedule(claims, 0, start(root, total), 0, salt, delay) then execute'] },
    { step: 'claims', done: !!state.deadlinePassed, what: 'each address claims its line (recovery proof --account 0x…); after the period, sweep()',
      calls: ['claims.claim(owed, proof) [each account]', 'claims.sweep() [anyone, after the deadline]'] },
    { step: 'resume', done: !!state.resumed, what: 'governance unpauses once the cause is fixed (and the lockbox/guard limits are reviewed)',
      calls: ['timelock: lockbox.unpause() [source chain]', 'timelock: guard.unpause() [ZETAPHY]'] },
  ];
  const next = steps.find((s) => !s.done)?.step ?? null;
  return { next, steps };
}
