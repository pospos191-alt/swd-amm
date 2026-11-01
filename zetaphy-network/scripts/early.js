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
//   node scripts/early.js collect [--max 1000] [--out early-users.txt]
//       the wallets that already used the ZETAPHY chain (sent or received anything: faucet, mining, transfers,
//       swaps, staking), oldest first, from the transactions themselves (CometBFT tx_search, 100 a page: light on
//       the node). Left out: contracts, module accounts, the airdrop wallet, and funds holding over 1,000,000
//       ZETAPHY (the genesis accounts). The file is a list for `airdrop`.
//   node scripts/early.js pool [--zearly 10000000] [--ztphy 1000]
//       the ZEARLY/ZETAPHY pool on the ZETAPHY Swap, first liquidity from the airdrop wallet (KEYFILE)
//   node scripts/early.js extras
//       deploys the Early Pass, quests (funded), the farm (on the pool's LP, funded) and polls (src/earlyops.js)
//   node scripts/early.js quests [--send]
//       who did each quest (swaps, liquidity, Early Pass, staking: read from the chain) and pays the unpaid ones
//   pool and extras print the addresses as JSON on the last line (the workflow adds them to early-testnet.json).
//
// env: ZETAPHY_RPC (EVM JSON-RPC), ZETAPHY_COMET (CometBFT RPC, default <ZETAPHY_RPC>/rpc),
// ZETAPHY_REST (default <ZETAPHY_RPC>/rest), KEYFILE, EARLY and FROM_BLOCK (else zetaphy-chain/rewards/early-testnet.json).
import { readFileSync, existsSync } from 'node:fs';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, Interface, getAddress, hexlify, parseEther, formatEther } from 'ethers';
import { writeFileSync } from 'node:fs';
import { fromBech32 } from '../src/pqtx.js';
import { createPool, deployExtras, minters, swappers, stakers, payQuests } from '../src/earlyops.js';

const dexFile = () => JSON.parse(readFileSync(new URL('../../zetaphy-dex/web/deployments.json', import.meta.url), 'utf8')).contracts;

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

/** Every wallet address (0x…, checksummed) in one tx_search result, in order: event attributes that are addresses. */
export function addressesInTx(tx) {
  const out = [];
  for (const ev of tx?.tx_result?.events ?? []) {
    for (const at of ev.attributes ?? []) {
      const v = String(at.value ?? '').trim();
      let a = null;
      if (/^0x[0-9a-fA-F]{40}$/.test(v)) a = getAddress(v.toLowerCase());
      else if (/^zetaphy1[02-9ac-hj-np-z]{38}$/.test(v)) { try { a = getAddress(hexlify(fromBech32(v))); } catch { /* not an account */ } }
      if (a && a !== '0x0000000000000000000000000000000000000000' && !out.includes(a)) out.push(a);
    }
  }
  return out;
}

/** The chain's users, oldest first: { wallets, scanned } (see `collect` above). fetchJson(url) -> JSON. */
export async function collectUsers({ comet, rest, fetchJson, isContract, balanceOf, skip = new Set(), max = 1000, big = 1_000_000n * 10n ** 18n, log = () => {} }) {
  const modules = new Set();
  try {
    for (const m of (await fetchJson(`${rest}/cosmos/auth/v1beta1/module_accounts`)).accounts ?? []) {
      const b = m.base_account?.address ?? m.address;
      if (b) try { modules.add(getAddress(hexlify(fromBech32(b)))); } catch { /* skip */ }
    }
  } catch { /* REST down: contracts and big balances still filter most of them */ }
  const seen = new Set(), wallets = [];
  let scanned = 0;
  for (let page = 1; wallets.length < max; page++) {
    const q = encodeURIComponent('"tx.height>=1"');
    const r = await fetchJson(`${comet}/tx_search?query=${q}&page=${page}&per_page=100&order_by=%22asc%22`);
    const txs = r?.result?.txs ?? [];
    if (!txs.length) break;
    for (const tx of txs) {
      scanned++;
      for (const a of addressesInTx(tx)) {
        if (seen.has(a)) continue;
        seen.add(a);
        if (modules.has(a) || skip.has(a)) continue;
        if (await isContract(a)) continue;
        if ((await balanceOf(a)) > big) continue;
        wallets.push(a);
        if (wallets.length >= max) break;
      }
      if (wallets.length >= max) break;
    }
    log(`page ${page}: ${scanned} transactions, ${wallets.length} wallets`);
    if (page * 100 >= Number(r?.result?.total_count ?? 0)) break;
  }
  return { wallets, scanned };
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
  const file = process.env.EARLY_FILE ? JSON.parse(process.env.EARLY_FILE) : existsSync(deployed) ? JSON.parse(readFileSync(deployed, 'utf8')) : {};
  return { ...file, token: process.env.EARLY || file.token, holder: file.holder, fromBlock: Number(process.env.FROM_BLOCK ?? file.fromBlock ?? 0) };
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
  } else if (cmd === 'pool') {
    const c = config();
    if (!c.token) die('no ZEARLY address yet (deploy first)');
    const p = await provider();
    const out = await createPool({ signer: signer(p), token: c.token, dex: process.env.DEX ? JSON.parse(process.env.DEX) : dexFile(),
      zearly: Number(opt('zearly', '10000000')), ztphy: Number(opt('ztphy', '1000')), log: (m) => console.error(m) });
    console.log(JSON.stringify(out));
  } else if (cmd === 'extras') {
    const c = config();
    if (!c.token) die('no ZEARLY address yet (deploy first)');
    const p = await provider();
    const now = (await p.getBlock('latest')).timestamp;
    const out = await deployExtras({ signer: signer(p), token: c.token, pair: c.pair ?? null, now, log: (m) => console.error(m) });
    console.log(JSON.stringify(out));
  } else if (cmd === 'quests') {
    const c = config();
    if (!c.quests) die('no quests contract yet (run extras first)');
    const base = (process.env.ZETAPHY_RPC || die('ZETAPHY_RPC is not set')).replace(/\/+$/, '');
    const comet = (process.env.ZETAPHY_COMET || `${base}/rpc`).replace(/\/+$/, '');
    const p = await provider();
    const head = await p.getBlockNumber();
    const dex = process.env.DEX ? JSON.parse(process.env.DEX) : dexFile();
    const fetchJson = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
    const found = {
      swap: await swappers(p, dex.factory, c.fromBlock, head),
      liquidity: c.pair ? await minters(p, c.pair, c.fromBlock, head) : [],
      pass: c.pass ? await minters(p, c.pass, c.fromBlock, head) : [],
      stake: await stakers(fetchJson, comet).catch(() => []),
    };
    const send = flag('send');
    const w = send ? signer(p) : null;
    const skip = new Set([c.holder].filter(Boolean).map((a) => getAddress(a)));
    const report = await payQuests({ quests: c.quests, signer: w, provider: p, found, skip, send, log: (m) => console.error(m) });
    console.log(JSON.stringify({ sent: send, report }));
  } else if (cmd === 'collect') {
    const base = (process.env.ZETAPHY_RPC || die('ZETAPHY_RPC is not set')).replace(/\/+$/, '');
    const comet = (process.env.ZETAPHY_COMET || `${base}/rpc`).replace(/\/+$/, '');
    const rest = (process.env.ZETAPHY_REST || `${base}/rest`).replace(/\/+$/, '');
    const p = await provider();
    const c = config();
    const skip = new Set([c.holder, process.env.KEYFILE ? signer(p).address : null].filter(Boolean).map((a) => getAddress(a)));
    // a long scan of a small node: every read is retried (a 30 s timeout, then 2, 4, 8, 16 s pauses) instead of one
    // failed request ending the whole scan
    const retry = async (what, f) => {
      for (let i = 0; ; i++) {
        try { return await f(); } catch (e) {
          if (i >= 4) throw new Error(`${what}: ${e?.message ?? e}`);
          console.error(`${what}: ${e?.message ?? e}; retrying in ${2 ** (i + 1)} s`);
          await new Promise((r) => setTimeout(r, 2 ** (i + 1) * 1000));
        }
      }
    };
    const fetchJson = (url) => retry(url.split('?')[0], async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    const max = Math.max(1, Math.min(100000, Number(opt('max', '1000')) || 1000));
    const { wallets, scanned } = await collectUsers({ comet, rest, fetchJson, max, skip,
      isContract: async (a) => (await retry(`getCode ${a}`, () => p.getCode(a))) !== '0x',
      balanceOf: (a) => retry(`getBalance ${a}`, () => p.getBalance(a)), log: (m) => console.error(m) });
    const out = opt('out', 'early-users.txt');
    writeFileSync(out, `# ZETAPHY Early: wallets that used the ZETAPHY chain (${wallets.length}, from ${scanned} transactions), oldest first\n${wallets.join('\n')}\n`);
    console.log(JSON.stringify({ wallets: wallets.length, scanned, out }));
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
    die('usage: early.js deploy | airdrop --list <file> [--each 10000] [--send] | collect [--max 1000] [--out <file>] | pool | extras | quests [--send] (see the top of this file)');
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main().catch((e) => die(e.shortMessage ?? e.message));
