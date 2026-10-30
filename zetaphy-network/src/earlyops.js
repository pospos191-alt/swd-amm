// What ZEARLY can do on ZETAPHY, run from the command line / the early-token workflow (no web page):
// the ZEARLY/ZETAPHY pool on the ZETAPHY Swap, the Early Pass, quests, the farm and polls
// (contracts/ZetaphyEarly*.sol, ZetaphyQuests.sol; zetaphy-chain/rewards/EARLY.md).
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, Interface, getAddress, hexlify, parseEther, ZeroAddress } from 'ethers';
import { fromBech32 } from './pqtx.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const DEX = (n) => JSON.parse(readFileSync(new URL(`../../zetaphy-dex/artifacts/${n}.json`, import.meta.url), 'utf8'));
const DEAD = '0x000000000000000000000000000000000000dEaD';
const STEP = 500; // the public node answers at most 500 blocks per eth_getLogs

/** The quests (index = quest id in ZetaphyQuests): what is checked, the reward and how many wallets it pays. */
export const QUESTS = [
  { key: 'swap', name: 'First swap on the ZETAPHY Swap', reward: 1_000, cap: 50_000 },
  { key: 'liquidity', name: 'Add liquidity to the ZEARLY/ZETAPHY pool', reward: 5_000, cap: 10_000 },
  { key: 'pass', name: 'Mint a ZETAPHY Early Pass', reward: 2_000, cap: 10_000 },
  { key: 'stake', name: 'Stake ZETAPHY with a validator', reward: 2_000, cap: 50_000 },
];

/** Default amounts (whole ZEARLY) for `extras`. */
export const DEFAULTS = {
  passPrice: 1_000, passMax: 10_000, passEarlyDays: 14, passMinHold: 10_000,
  questsFund: 100_000_000, farmFund: 50_000_000, farmDays: 90, pollDeposit: 1_000,
};

/**
 * Creates the ZEARLY/ZETAPHY pool on the ZETAPHY Swap with the first liquidity, from `signer` (the airdrop wallet).
 * dex: { router, factory } (zetaphy-dex/web/deployments.json). Returns { pair, liquidityTx }.
 */
export async function createPool({ signer, token, dex, zearly, ztphy, log = () => {} }) {
  const router = new Contract(dex.router, DEX('ZetaphyRouter').abi, signer);
  const factory = new Contract(dex.factory, DEX('ZetaphyFactory').abi, signer);
  const wnative = await router.WETH();
  const t = new Contract(token, art('ZetaphyEarly').abi, signer);
  await (await t.approve(dex.router, parseEther(String(zearly)))).wait();
  const deadline = BigInt((await signer.provider.getBlock('latest')).timestamp + 1800); // the chain's clock
  const tx = await router.addLiquidityETH(token, parseEther(String(zearly)), 0n, 0n, signer.address, deadline, { value: parseEther(String(ztphy)) });
  const r = await tx.wait();
  const pair = getAddress(await factory.getPair(token, wnative));
  if (pair === ZeroAddress) throw new Error('the pool was not created');
  log(`pool ZEARLY/ZETAPHY ${pair}: ${zearly} ZEARLY + ${ztphy} ZETAPHY`);
  return { pair, liquidityTx: r.hash };
}

/**
 * Deploys the Early Pass, quests (funded, rewards set), the farm (funded, reward period started) and polls.
 * `pair` is the ZEARLY/ZETAPHY pool (the farm stakes its LP). Returns their addresses for early-testnet.json.
 */
export async function deployExtras({ signer, token, pair, now, o = {}, log = () => {} }) {
  const d = { ...DEFAULTS, ...o };
  const E = (n) => parseEther(String(n));
  const t = new Contract(token, art('ZetaphyEarly').abi, signer);
  const deploy = async (name, args) => {
    const c = await new ContractFactory(art(name).abi, art(name).bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    const a = await c.getAddress();
    log(`${name} ${a}`);
    return new Contract(a, art(name).abi, signer);
  };
  const pass = await deploy('ZetaphyEarlyPass', [token, E(d.passPrice), BigInt(d.passMax), BigInt(now + d.passEarlyDays * 86400), E(d.passMinHold)]);
  const quests = await deploy('ZetaphyQuests', [token, signer.address]);
  await (await t.transfer(await quests.getAddress(), E(d.questsFund))).wait();
  for (const [i, q] of QUESTS.entries()) await (await quests.setQuest(i, E(q.reward), q.cap)).wait();
  let farm = null;
  if (pair) {
    farm = await deploy('ZetaphyEarlyFarm', [pair, token, signer.address]);
    await (await t.transfer(await farm.getAddress(), E(d.farmFund))).wait();
    await (await farm.notifyReward(E(d.farmFund), BigInt(d.farmDays * 86400))).wait();
  }
  const polls = await deploy('ZetaphyEarlyPolls', [token, E(d.pollDeposit)]);
  return {
    pass: await pass.getAddress(), quests: await quests.getAddress(), farm: farm ? await farm.getAddress() : null, polls: await polls.getAddress(),
    settings: { pass: { price: d.passPrice, max: d.passMax, earlyUntil: now + d.passEarlyDays * 86400, minHold: d.passMinHold },
      quests: QUESTS.map(({ key, reward, cap }) => ({ key, reward, cap })), farm: { fund: d.farmFund, days: d.farmDays }, polls: { deposit: d.pollDeposit } },
  };
}

// ------------------------------------------------------------------ quests: who did what, from the chain itself
const PAIR = new Interface(['event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Transfer(address indexed from, address indexed to, uint256 value)']);
const SWAP = PAIR.getEvent('Swap').topicHash;
const TRANSFER = PAIR.getEvent('Transfer').topicHash;
const ZERO_TOPIC = '0x' + '0'.repeat(64);
const topicAddr = (t) => getAddress('0x' + t.slice(26));

async function logs(provider, filter, fromBlock, toBlock) {
  const out = [];
  const from = Number(fromBlock), to = Number(toBlock);
  for (let b = from; b <= to; b += STEP) out.push(...await provider.getLogs({ ...filter, fromBlock: b, toBlock: Math.min(to, b + STEP - 1) }));
  return out;
}

/** Wallets that minted (received from 0x0) a token: LP shares of the pool, or Early Passes. */
export async function minters(provider, token, fromBlock, toBlock) {
  const ls = await logs(provider, { address: token, topics: [TRANSFER, ZERO_TOPIC] }, fromBlock, toBlock);
  return [...new Set(ls.map((l) => topicAddr(l.topics[2])).filter((a) => a !== ZeroAddress && a !== getAddress(DEAD)))];
}

/** Wallets that sent a swap through any pool of the ZETAPHY Swap (the transaction's sender: the router hides it). */
export async function swappers(provider, factory, fromBlock, toBlock) {
  const f = new Contract(factory, DEX('ZetaphyFactory').abi, provider);
  const n = Number(await f.allPairsLength());
  const pairs = [];
  for (let i = 0; i < n; i++) pairs.push(await f.allPairs(i));
  const out = new Set();
  for (const p of pairs) {
    for (const l of await logs(provider, { address: p, topics: [SWAP] }, fromBlock, toBlock)) {
      const tx = await provider.getTransaction(l.transactionHash);
      if (tx?.from) out.add(getAddress(tx.from));
    }
  }
  return [...out];
}

/** Wallets that delegated ZETAPHY (CometBFT tx_search over `delegate` events; MsgDelegate or the staking precompile). */
export async function stakers(fetchJson, comet) {
  const out = new Set();
  const q = encodeURIComponent('"delegate.validator EXISTS"');
  for (let page = 1; ; page++) {
    const r = await fetchJson(`${comet}/tx_search?query=${q}&page=${page}&per_page=100&order_by=%22asc%22`);
    const txs = r?.result?.txs ?? [];
    for (const tx of txs) {
      for (const ev of tx.tx_result?.events ?? []) {
        if (ev.type !== 'delegate') continue;
        for (const at of ev.attributes ?? []) {
          if (at.key !== 'delegator') continue;
          const v = String(at.value ?? '');
          try { out.add(/^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v.toLowerCase()) : getAddress(hexlify(fromBech32(v)))); } catch { /* not an account */ }
        }
      }
    }
    if (!txs.length || page * 100 >= Number(r?.result?.total_count ?? 0)) break;
  }
  return [...out];
}

/** Pays every quest to whoever did it and was not paid yet (read on chain), in batches; `send` false = only counts. */
export async function payQuests({ quests, signer, provider, found, skip = new Set(), send = false, log = () => {} }) {
  const q = new Contract(quests, art('ZetaphyQuests').abi, signer ?? provider);
  const report = [];
  for (const [i, def] of QUESTS.entries()) {
    const who = (found[def.key] ?? []).filter((a) => !skip.has(a));
    const todo = [];
    for (const a of who) if (!(await q.paid(i, a))) todo.push(a);
    report.push({ quest: def.key, did: who.length, toPay: todo.length });
    log(`${def.key}: ${who.length} did it, ${todo.length} not paid yet`);
    if (!send) continue;
    for (let k = 0; k < todo.length; k += 300) await (await q.pay(i, todo.slice(k, k + 300))).wait();
  }
  return report;
}
