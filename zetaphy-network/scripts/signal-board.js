#!/usr/bin/env node
// SignalBoard on the ZETAPHY testnet (contracts/SignalBoard.sol): where browsers find each
// other for model chunks and pipeline stages (zetaphy-neuro/ai/browser/discovery.js).
//
//   node scripts/signal-board.js deploy [--devnet]
//       deploys with the key in KEYFILE. The contract has no owner and no settings: nothing to
//       hand over afterwards. Put the printed address in zetaphy-neuro/ai/browser/config.js (signalBoard).
//   node scripts/signal-board.js show --board 0x… [--blocks 150]
//       the limits and the posts of the last N blocks per topic (reads only).
//
// env: ZETAPHY_RPC (EVM JSON-RPC, default https://rpc.sawasdeecoin.com), KEYFILE (deploy only: a file holding a testnet key).
// Testnet only. Never pass a key on the command line.
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory, Contract } from 'ethers';

const CHAIN_ID = 77390n;
const ART = JSON.parse(readFileSync(new URL('../artifacts/SignalBoard.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);
const die = (m) => { console.error(m); process.exit(1); };
const rpc = process.env.ZETAPHY_RPC ?? 'https://rpc.sawasdeecoin.com';

async function provider() {
  const p = new JsonRpcProvider(rpc);
  const id = (await p.getNetwork()).chainId;
  if (id !== CHAIN_ID && !flag('devnet')) die(`${rpc} is chain ${id}, not the ZETAPHY testnet (${CHAIN_ID}); --devnet for a local chain`);
  return p;
}

if (cmd === 'deploy') {
  if (!process.env.KEYFILE) die('KEYFILE: a file with this testnet deployer key');
  const signer = new Wallet(readFileSync(process.env.KEYFILE, 'utf8').trim(), await provider());
  const k = await new ContractFactory(ART.abi, ART.bytecode, signer).deploy();
  await k.waitForDeployment();
  const address = await k.getAddress();
  console.log(`SignalBoard ${address} (no owner, no settings)`);
  console.log(JSON.stringify({ signalBoard: address }));
} else if (cmd === 'show') {
  const board = opt('board');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(board))) die('--board 0x…');
  const p = await provider();
  const k = new Contract(board, ART.abi, p);
  console.log(`limits: payload <= ${await k.MAX_PAYLOAD()} bytes, ttl <= ${await k.MAX_TTL()} s, ${await k.MAX_PER_WINDOW()} posts per ${await k.WINDOW()} s per sender`);
  const head = await p.getBlockNumber();
  const logs = await k.queryFilter(k.filters.Signal(), Math.max(0, head - Number(opt('blocks', 150))), head);
  const byTopic = new Map();
  for (const l of logs) byTopic.set(l.args.topic, (byTopic.get(l.args.topic) ?? 0) + 1);
  console.log(`${logs.length} posts in the last ${opt('blocks', 150)} blocks`);
  for (const [t, n] of byTopic) console.log(`  ${t}: ${n}`);
} else {
  die('usage: signal-board.js deploy | show --board 0x…');
}
