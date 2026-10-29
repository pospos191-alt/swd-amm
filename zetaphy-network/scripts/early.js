#!/usr/bin/env node
// ZETAPHY Early (ZEARLY, contracts/ZetaphyEarly.sol): deploy it, and airdrop it to a list. Used by the
// early-token workflow (.github/workflows/early-token.yml); zetaphy-chain/rewards/EARLY.md explains it.
//
//   node scripts/early.js deploy
//       deploys ZEARLY; all 1,000,000,000 go to the key in KEYFILE (the airdrop wallet). JSON on the last line.
//   node scripts/early.js airdrop --list <file> [--each 10000] [--send]
//       the list: one 0x… or zetaphy1… per line (the Telegram bot's /export works as is; # comments).
//       Wallets that already got ZEARLY from the airdrop wallet (its Transfer events) are skipped, so a re-run
//       pays only new ones. Without --send it only prints what it would do. Batches of 200 (batchTransfer).
//
// env: ZETAPHY_RPC (EVM JSON-RPC), KEYFILE, EARLY and FROM_BLOCK (else zetaphy-chain/rewards/early-testnet.json).
import { readFileSync, existsSync } from 'node:fs';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, Interface, getAddress, hexlify, parseEther, formatEther } from 'ethers';
import { fromBech32 } from '../src/pqtx.js';

const CHAIN_ID = 77390n;
const STEP = 500;   // the public node answers at most 500 blocks per eth_getLogs
const BATCH = 200;
const art = JSON.parse(readFileSync(new URL('../artifacts/ZetaphyEarly.json', import.meta.url), 'utf8'));
const deployed = new URL('../../zetaphy-chain/rewards/early-testnet.json', import.meta.url);
const IFACE = new Interface(art.abi);

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);
const die = (m) => { console.error(m); process.exit(1); };

/** A list file -> { wallets: [0x… checksummed, unique], bad: [lines] }. */
export function readList(text) {
  const seen = new Set(), wallets = [], bad = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*/, '').trim().split(/[,\s]/)[0];
    if (!line) continue;
    let a = null;
    try { a = /^0x[0-9a-fA-F]{40}$/.test(line) ? getAddress(line.toLowerCase()) : getAddress(hexlify(fromBech32(line))); } catch { /* bad */ }
    if (!a || a === '0x0000000000000000000000000000000000000000') { bad.push(line); continue; }
    if (!seen.has(a)) { seen.add(a); wallets.push(a); }
  }
  return { wallets, bad };
}

async function provider() {
  const url = process.env.ZETAPHY_RPC || die('ZETAPHY_RPC is not set');
  const p = new JsonRpcProvider(url, undefined, { staticNetwork: true });
  const id = BigInt(await p.send('eth_chainId', []));
  if (id !== CHAIN_ID) die(`chain id ${id} is not ZETAPHY (${CHAIN_ID})`);
  return p;
}
const signer = (p) => new Wallet(readFileSync(process.env.KEYFILE || die('KEYFILE is not set'), 'utf8').trim(), p);

function config() {
  const file = existsSync(deployed) ? JSON.parse(readFileSync(deployed, 'utf8')) : {};
  return { token: process.env.EARLY || file.token, holder: file.holder, fromBlock: Number(process.env.FROM_BLOCK ?? file.fromBlock ?? 0) };
}

/** Wallets the holder already sent ZEARLY to (its Transfer events). */
async function paid(p, token, holder, fromBlock) {
  const topic = IFACE.getEvent('Transfer').topicHash;
  const from = '0x' + holder.slice(2).toLowerCase().padStart(64, '0');
  const head = await p.getBlockNumber();
  const out = new Set();
  for (let b = fromBlock; b <= head; b += STEP) {
    const logs = await p.getLogs({ address: token, topics: [topic, from], fromBlock: b, toBlock: Math.min(head, b + STEP - 1) });
    for (const l of logs) out.add(getAddress('0x' + l.topics[2].slice(26)));
  }
  return out;
}

async function main() {
  const cmd = args[0];
  if (cmd === 'deploy') {
    const p = await provider();
    const w = signer(p);
    const ct = await new ContractFactory(art.abi, art.bytecode, w).deploy(w.address);
    const r = await ct.deploymentTransaction().wait();
    console.log(`ZetaphyEarly ${await ct.getAddress()}`);
    console.log(JSON.stringify({ chainId: 77390, token: await ct.getAddress(), symbol: 'ZEARLY', holder: w.address, fromBlock: r.blockNumber, deployTx: r.hash }));
  } else if (cmd === 'airdrop') {
    const { wallets, bad } = readList(readFileSync(opt('list') || die('--list <file>'), 'utf8'));
    const each = parseEther(String(opt('each', '10000')));
    const c = config();
    if (!c.token) die('no ZEARLY address yet (deploy first)');
    const p = await provider();
    // the airdrop wallet: the key's (when KEYFILE is set), else the deployment file's
    const key = process.env.KEYFILE ? signer(p) : null;
    const w = flag('send') ? (key ?? die('--send needs KEYFILE')) : null;
    const holder = getAddress(key?.address ?? c.holder ?? die('the airdrop wallet is unknown (KEYFILE, or the deployment file)'));
    const done = await paid(p, c.token, holder, c.fromBlock);
    const todo = wallets.filter((a) => !done.has(a) && a !== holder);
    const t = new Contract(c.token, art.abi, w ?? p);
    const have = await t.balanceOf(holder);
    const need = each * BigInt(todo.length);
    console.log(`list: ${wallets.length} wallets (${bad.length} bad lines), paid before: ${wallets.length - todo.length}, to pay now: ${todo.length} × ${formatEther(each)} = ${formatEther(need)} ZEARLY; the airdrop wallet has ${formatEther(have)}`);
    if (bad.length) console.log(`bad lines: ${bad.slice(0, 10).join(' ')}${bad.length > 10 ? ' …' : ''}`);
    if (need > have) die('refused: not enough ZEARLY in the airdrop wallet');
    if (!w) { console.log('dry run: nothing sent (--send sends)'); return; }
    for (let i = 0; i < todo.length; i += BATCH) {
      const part = todo.slice(i, i + BATCH);
      const r = await (await t.batchTransfer(part, each)).wait();
      console.log(`sent ${formatEther(each)} ZEARLY to ${part.length} wallets: ${r.hash}`);
    }
    console.log(JSON.stringify({ paid: todo.length, each: formatEther(each), total: formatEther(need) }));
  } else {
    die('usage: early.js deploy | airdrop --list <file> [--each 10000] [--send] (see the top of this file)');
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main().catch((e) => die(e.shortMessage ?? e.message));
