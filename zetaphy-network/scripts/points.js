#!/usr/bin/env node
// BZTPHY testnet reward points (contracts/ZetaphyPoints.sol, src/points.js). Used by the rewards workflow.
//
//   node scripts/points.js deploy --owner 0x… --cap <BZTPHY per day>
//       deploys BZTPHY with the key in KEYFILE as its minter; prints JSON on the last line
//   node scripts/points.js award [--epoch <UTC day>] [--send]
//       works out one day's awards (default: yesterday, UTC) from the chain: validators' uptime
//       (REST) and Neuro runners' revealed jobs (NeuroJobs Revealed events). Without --send it
//       only prints them. With --send it awards whoever has not been awarded for that day yet,
//       so a re-run never pays twice.
//   node scripts/points.js snapshot --pool <ZETAPHY>
//       balances from the Transfer events, and each holder's share of the mainnet pool
//
// env: ZETAPHY_RPC (EVM JSON-RPC), ZETAPHY_REST (Cosmos REST), KEYFILE (deploy/award --send),
// POINTS and FROM_BLOCK (else zetaphy-chain/rewards/points-testnet.json), NEURO_JOBS,
// POINTS_CONFIG (JSON overriding src/points.js DEFAULTS, amounts in BZTPHY).
import { readFileSync, existsSync } from 'node:fs';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, Interface, getAddress, parseEther, formatEther, encodeBytes32String } from 'ethers';
import { DEFAULTS, DAY, epochOf, validatorAwards, runnerAwards, mergeAwards, proRata, balancesFromTransfers } from '../src/points.js';

const CHAIN_ID = 77390n;
const STEP = 500; // the public node answers at most 500 blocks per eth_getLogs
const art = JSON.parse(readFileSync(new URL('../artifacts/ZetaphyPoints.json', import.meta.url), 'utf8'));
const JOBS_IFACE = new Interface(['event Revealed(uint256 indexed id, address indexed worker, bytes32 verdict)']);
const deployed = new URL('../../zetaphy-chain/rewards/points-testnet.json', import.meta.url);

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);
const die = (m) => { console.error(m); process.exit(1); };

function config() {
  const file = existsSync(deployed) ? JSON.parse(readFileSync(deployed, 'utf8')) : {};
  const o = process.env.POINTS_CONFIG ? JSON.parse(process.env.POINTS_CONFIG) : {};
  const cfg = { ...DEFAULTS };
  for (const k of ['validatorDaily', 'perJob', 'jobCapDaily']) if (o[k] !== undefined) cfg[k] = parseEther(String(o[k]));
  for (const k of ['minUptime', 'excludeMonikers', 'excludeAddresses']) if (o[k] !== undefined) cfg[k] = o[k];
  return {
    cfg,
    points: process.env.POINTS || file.points,
    fromBlock: Number(process.env.FROM_BLOCK || file.fromBlock || 0),
    jobs: process.env.NEURO_JOBS || '0x698dC17df6a34b02263b295d101BE39F3F3B433B',
    rest: (process.env.ZETAPHY_REST || 'https://rpc.sawasdeecoin.com/rest').replace(/\/$/, ''),
  };
}

async function provider() {
  const p = new JsonRpcProvider(process.env.ZETAPHY_RPC || 'https://rpc.sawasdeecoin.com', CHAIN_ID, { staticNetwork: true });
  if (BigInt(await p.send('eth_chainId', [])) !== CHAIN_ID) die('not the ZETAPHY testnet (chain 77390)');
  return p;
}
const signer = (p) => new Wallet(readFileSync(process.env.KEYFILE || die('KEYFILE is not set'), 'utf8').trim(), p);
const rest = async (base, path) => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

/** First block with timestamp >= t (binary search; blocks are ~5 s). */
async function blockAt(p, t, hi) {
  let lo = 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await p.getBlock(mid)).timestamp < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function logs(p, filter, from, to) {
  const out = [];
  for (let a = from; a <= to; a += STEP) out.push(...await p.getLogs({ ...filter, fromBlock: a, toBlock: Math.min(a + STEP - 1, to) }));
  return out;
}

async function plan(p, c, epoch) {
  const head = await p.getBlock('latest');
  if ((epoch + 1) * DAY > head.timestamp) die(`epoch ${epoch} has not ended yet`);
  const from = await blockAt(p, epoch * DAY, head.number);
  const to = (await blockAt(p, (epoch + 1) * DAY, head.number)) - 1;
  const [vals, infos, params] = await Promise.all([
    rest(c.rest, '/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=500'),
    rest(c.rest, '/cosmos/slashing/v1beta1/signing_infos?pagination.limit=500'),
    rest(c.rest, '/cosmos/slashing/v1beta1/params'),
  ]);
  const v = validatorAwards(vals.validators ?? [], infos.info ?? [], params.params.signed_blocks_window, c.cfg);
  const reveals = (await logs(p, { address: c.jobs, topics: [JOBS_IFACE.getEvent('Revealed').topicHash] }, from, to))
    .map((l) => ({ worker: JOBS_IFACE.parseLog(l).args.worker }));
  return { epoch, blocks: [from, to], awards: mergeAwards(v, runnerAwards(reveals, c.cfg)) };
}

const show = (o) => JSON.stringify(o, (_, x) => (typeof x === 'bigint' ? formatEther(x) : x));

async function main() {
  const cmd = args[0];
  const c = config();
  const p = await provider();
  if (cmd === 'deploy') {
    const owner = getAddress(opt('owner') || die('--owner 0x…'));
    const cap = parseEther(opt('cap') || die('--cap <BZTPHY per day>'));
    const w = signer(p);
    const f = new ContractFactory(art.abi, art.bytecode, w);
    const ct = await f.deploy(owner, w.address, cap);
    const r = await ct.deploymentTransaction().wait();
    console.log(`ZetaphyPoints ${await ct.getAddress()}`);
    console.log(JSON.stringify({ chainId: 77390, points: await ct.getAddress(), owner, minter: w.address, epochCap: formatEther(cap), fromBlock: r.blockNumber, deployTx: r.hash }));
  } else if (cmd === 'award') {
    if (!c.points) die('no BZTPHY address yet (deploy first)');
    const head = await p.getBlock('latest');
    const epoch = Number(opt('epoch', epochOf(head.timestamp) - 1));
    const pl = await plan(p, c, epoch);
    const pts = new Contract(c.points, art.abi, flag('send') ? signer(p) : p);
    const todo = [];
    for (const a of pl.awards) if (!(await pts.awarded(epoch, a.to))) todo.push(a);
    console.error(`epoch ${epoch} (${new Date(epoch * DAY * 1000).toISOString().slice(0, 10)} UTC), blocks ${pl.blocks.join('-')}: ${pl.awards.length} earned, ${todo.length} not yet awarded`);
    for (const a of pl.awards) console.error(`  ${a.to}  ${formatEther(a.amount)} BZTPHY  ${a.why}`);
    let txs = [];
    if (flag('send') && todo.length) {
      for (let i = 0; i < todo.length; i += 50) {
        const part = todo.slice(i, i + 50);
        const tx = await pts.award(epoch, part.map((a) => a.to), part.map((a) => a.amount), encodeBytes32String('daily'));
        await tx.wait();
        txs.push(tx.hash);
      }
    }
    console.log(show({ ...pl, sent: flag('send'), txs }));
  } else if (cmd === 'snapshot') {
    if (!c.points) die('no BZTPHY address yet');
    const pool = parseEther(opt('pool') || die('--pool <ZETAPHY>'));
    const iface = new Interface(art.abi);
    const head = await p.getBlockNumber();
    const ts = (await logs(p, { address: c.points, topics: [iface.getEvent('Transfer').topicHash] }, c.fromBlock || 1, head))
      .map((l) => iface.parseLog(l).args).map((a) => ({ from: a.from, to: a.to, value: a.value }));
    console.log(show({ block: head, pool, holders: proRata(balancesFromTransfers(ts), pool) }));
  } else {
    die('usage: points.js deploy|award|snapshot (see the top of this file)');
  }
}
main().catch((e) => die(e.shortMessage || e.message));
