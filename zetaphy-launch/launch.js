#!/usr/bin/env node
// ZETAPHY launch day: once the testnet is live, deploy and wire every contract,
// then write the addresses and the RPC into every web app's config.
//
//   node zetaphy-launch/launch.js --rpc https://<node host> [options]
//
//   --rpc URL               the node's EVM JSON-RPC (https://<ip with dashes>.sslip.io on the testnet); or ZETAPHY_RPC
//   --public-rpc URL        the RPC the web apps should use (default: --rpc)
//   --key-file FILE         the deployer key (0x… hex, chmod 600; or a keystore with ZETAPHY_PASSPHRASE).
//                           Or ZETAPHY_DEPLOYER_KEY_FILE / ZETAPHY_DEPLOYER_KEY; default ~/.zetaphy/worker.key.
//                           Never on the command line; never printed.
//   --dry-run               check the chain, the key's balance and the state; say what would run; send nothing
//   --only a,b              run only these steps (see the list below)
//   --resume                continue from the state file (finished steps are skipped)
//   --redo                  run the chosen steps again even if done (new contracts!)
//   --fresh                 start over: the old state file is kept as <file>.<time>.old
//   --state FILE            default zetaphy-launch/state/<EVM chain id>.json (addresses only, never keys)
//   --governance deployer|gov|0x…   who controls the timelock after the handover: its proposer and canceller (the chain's
//                           gov module, or a multisig); default deployer = keep every admin role for now
//   --handover              as the LAST step: hand every admin role to a new ZetaphyTimelock (proposers/cancellers:
//                           --governance and --timelock-proposers; executor: anyone), name --guardian on every contract's
//                           emergency switches, then check on-chain that no EOA keeps an admin role
//   --guardian 0x…          the emergency multisig (pause, lower caps, holds, remove a lane or marker, pause a price feed):
//                           required with --handover; it acts at once, but can only reduce risk
//   --timelock-delay S      the timelock's delay in seconds (default 172800 = 48 h; below 86400 only with --devnet)
//   --timelock-proposers 0x…,0x…   more proposers/cancellers besides --governance (e.g. a multisig next to the gov module)
//   --timelock-executor open|governance   who runs a call once its delay passed (default open: anyone)
//   --devnet                a local devnet (loopback RPC only): allows a short delay and single-key roles for tests
//   --oracle-relayer 0x…,…  keys that may push Pyth prices into the ZetaphyPythRelay (default none)
//   --pyth-zeta-feed 0x…    the Pyth price feed id of ZETAPHY/USD, once Pyth (or a relayer) carries it (default: TWAP only)
//   --oracle-min-liquidity N   USD depth the DEX pool needs for its TWAP to count (default 10000)
//   --stable-testnet-price N   TESTNET FALLBACK: price the StableGateway at a fixed N tUSDC per ZETAPHY (labeled, off by default;
//                           without it the gateway prices through ZetaphyOracle once the TWAP window has filled)
//   --neuro-url URL         the Neuro web page, https://<host>/web/ (NeuroIdentity, explorer report links)
//   --wallet-origin URL     the web wallet's https origin(s), comma-separated, for the snap (default: keep)
//   --community-fund 0x…    Neuro's and the ThreatRegistry's community fund (default: the deployer)
//   --stable-reserve N      ZETAPHY the StableGateway holds to pay relayed fees (default 100)
//   --compute-min-agreed N  accepted verdicts a runner needs to take ComputeMarket jobs (default 1)
//   --bridge-lockbox <chainId>:0x…  also deploy the Neuro bridge CLOSED (needs a LockBox on the source chain; open later with `zetaphy bridge open` once gates pass)
//   --skip-snap-build       write snap.config.js but do not run npm run build in zetaphy-snap
//
// Steps: neuro skill threats reports identity vault pq stable compute bridge dex dlmm nft oracle wire protect configs snap timelock handover
// Testnet only: refuses any chain but ZETAPHY (EVM chain id 77390).

import { readFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, getAddress, isAddress } from 'ethers';
import { readDeployerKey, keyFolder } from './src/key.js';
import { loadState, saveState, newState, runSteps, outputs } from './src/runner.js';
import { launchSteps, estimate, handoverPlan, zeta, ROOT, GOV_MODULE, EVM_CHAIN_ID, DEFAULT_DELAY, MIN_DELAY } from './src/steps.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FLAGS = new Set(['dry-run', 'resume', 'redo', 'fresh', 'handover', 'skip-snap-build', 'help', 'devnet']);

export function parseArgs(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === 'key' || k === 'private-key') throw new Error('--key is not accepted: put the key in a file (chmod 600) and pass --key-file');
    if (FLAGS.has(k)) { opt[k] = true; continue; }
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
    opt[k] = argv[++i];
  }
  return opt;
}

/** --governance: null (the deployer), the gov module, or a 0x address. */
export function governanceTarget(g) {
  if (g == null || g === 'deployer') return null;
  if (g === 'gov') return GOV_MODULE;
  if (!isAddress(String(g))) throw new Error('--governance: deployer, gov (the chain\'s gov module) or a 0x address (a multisig)');
  return getAddress(String(g));
}

/** A comma list of 0x addresses (checksummed), or []. */
export function addressList(v, what) {
  const xs = String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const x of xs) if (!isAddress(x)) throw new Error(`${what}: 0x addresses, comma-separated`);
  return xs.map((x) => getAddress(x));
}

/** A loopback RPC (127.x, localhost, ::1): the only place --devnet is accepted. */
export function isLoopback(rpcUrl) {
  try { const h = new URL(String(rpcUrl)).hostname.replace(/^\[|\]$/g, ''); return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h); } catch { return false; }
}

/** --timelock-delay: seconds; below 24 h only on a devnet. */
export function timelockDelay(v, devnet) {
  const d = v == null ? DEFAULT_DELAY : Number(v);
  if (!Number.isInteger(d) || d < 0 || d > 30 * 86400) throw new Error('--timelock-delay: seconds (at most 30 days)');
  if (d < MIN_DELAY && !devnet) throw new Error(`--timelock-delay ${d}: less than ${MIN_DELAY} s (24 h) only with --devnet on a local devnet`);
  return d;
}

function checkUrl(u, what) {
  let url;
  try { url = new URL(String(u)); } catch { throw new Error(`${what}: not a URL`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error(`${what}: must be https:// (http only for localhost)`);
  if (url.username || url.password) throw new Error(`${what}: no user name or password in the URL`);
  return String(u).replace(/\/+$/, '');
}

const HELP = () => readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1)
  .filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith('//'))).map((l) => l.slice(3)).join('\n');

export async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const opt = parseArgs(argv);
  if (opt.help) { log(HELP()); return 0; }
  const rpc = checkUrl(opt.rpc ?? env.ZETAPHY_RPC ?? '', '--rpc');
  const publicRpc = checkUrl(opt['public-rpc'] ?? rpc, '--public-rpc');
  const governance = governanceTarget(opt.governance);
  if (opt.handover && !governance) throw new Error('--handover needs --governance gov (the chain\'s gov module) or --governance 0x<multisig>');
  if (opt.devnet && !isLoopback(rpc)) throw new Error('--devnet is only for a local devnet (an RPC on 127.0.0.1 / localhost)');
  const devnet = !!opt.devnet;
  const delay = timelockDelay(opt['timelock-delay'], devnet);
  const guardian = opt.guardian != null ? addressList(opt.guardian, '--guardian')[0] ?? null : null;
  if (opt.handover && !guardian) throw new Error('--handover needs --guardian 0x<emergency multisig>: with every admin role behind the timelock, it is who can pause at once');
  const extraProposers = addressList(opt['timelock-proposers'], '--timelock-proposers');
  const executorMode = String(opt['timelock-executor'] ?? 'open');
  if (!['open', 'governance'].includes(executorMode)) throw new Error('--timelock-executor: open (anyone) or governance');
  const oracleRelayers = addressList(opt['oracle-relayer'], '--oracle-relayer');
  if (opt['pyth-zeta-feed'] != null && !/^0x[0-9a-fA-F]{64}$/.test(String(opt['pyth-zeta-feed']))) throw new Error('--pyth-zeta-feed: a Pyth price feed id, 0x + 64 hex');
  const oracleMinLiquidity = Number(opt['oracle-min-liquidity'] ?? 10000);
  if (!Number.isInteger(oracleMinLiquidity) || oracleMinLiquidity < 1) throw new Error('--oracle-min-liquidity: whole USD, at least 1');
  const stableTestnetPrice = opt['stable-testnet-price'] != null ? String(opt['stable-testnet-price']) : null;
  if (stableTestnetPrice != null && !/^\d{1,9}(\.\d{1,6})?$/.test(stableTestnetPrice)) throw new Error('--stable-testnet-price: tUSDC per ZETAPHY, e.g. 0.01');
  const only = opt.only ? String(opt.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (opt['neuro-url']) checkUrl(opt['neuro-url'], '--neuro-url');
  if (opt['community-fund'] && !isAddress(opt['community-fund'])) throw new Error('--community-fund: a 0x address');
  if (opt['bridge-lockbox'] && !/^\d+:0x[0-9a-fA-F]{40}$/.test(opt['bridge-lockbox'])) throw new Error('--bridge-lockbox: <source chain id>:0x<LockBox>');
  const stableReserve = String(opt['stable-reserve'] ?? '100');
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(stableReserve)) throw new Error('--stable-reserve: ZETAPHY, e.g. 100');
  const computeMinAgreed = Number(opt['compute-min-agreed'] ?? 1);
  if (!Number.isInteger(computeMinAgreed) || computeMinAgreed < 0 || computeMinAgreed > 2 ** 32 - 1) throw new Error('--compute-min-agreed: a whole number');

  const { privateKey, source } = readDeployerKey(opt, env);
  const wallet = new Wallet(privateKey);
  const provider = new JsonRpcProvider(rpc, undefined, { polling: true, pollingInterval: 1000 });
  try {
    const chainId = (await provider.getNetwork()).chainId;
    if (chainId !== EVM_CHAIN_ID) throw new Error(`the RPC is EVM chain ${chainId}, not the ZETAPHY testnet (${EVM_CHAIN_ID}): refused`);
    const genesisHash = (await provider.getBlock(1))?.hash ?? null;
    log(`ZETAPHY testnet (EVM chain ${chainId}) at ${rpc}; deployer ${wallet.address} (key from ${source})`);

    const stateFile = resolve(opt.state ?? join(HERE, 'state', `${chainId}.json`));
    let state = loadState(stateFile);
    if (state && opt.fresh && !opt['dry-run']) {
      const old = `${stateFile}.${new Date().toISOString().replace(/[:.]/g, '-')}.old`;
      renameSync(stateFile, old);
      log(`--fresh: the old state is kept as ${old}`);
      state = null;
    }
    if (state) {
      if (state.chainId !== Number(chainId)) throw new Error(`${stateFile} is for chain ${state.chainId}`);
      if (state.genesisHash && genesisHash && state.genesisHash !== genesisHash) {
        throw new Error(`${stateFile} is from another run of this chain (block 1 differs: the chain was reset). Start over with --fresh`);
      }
      if (state.deployer && state.deployer !== wallet.address) {
        throw new Error(`${stateFile} was made by deployer ${state.deployer}, not ${wallet.address}: use that key, or --fresh to start over`);
      }
      const done = Object.keys(state.steps).length;
      if (done && !opt.resume && !opt['dry-run'] && !only) throw new Error(`${stateFile} already has ${done} finished step(s): pass --resume to continue (or --fresh to start over)`);
      log(`state: ${stateFile} (${done} step(s) recorded)`);
    } else {
      state = newState({ chainId: Number(chainId), genesisHash, deployer: wallet.address });
      log(`state: ${stateFile} (new)`);
    }

    const tmp = mkdtempSync(join(tmpdir(), 'zetaphy-launch-out-'));
    const keys = opt['dry-run'] ? null : keyFolder(privateKey);
    const onSignal = () => { keys?.cleanup(); rmSync(tmp, { recursive: true, force: true }); process.exit(130); };
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    const ctx = {
      rpc, publicRpc, provider, wallet, address: wallet.address, governance, handover: !!opt.handover, log, tmp,
      keyFile: keys?.keyFile, home: keys?.home, stateDir: resolve(stateFile, '..'), configRoot: ROOT,
      neuroUrl: opt['neuro-url'] ? String(opt['neuro-url']) : null, walletOrigin: opt['wallet-origin'] ?? null,
      communityFund: opt['community-fund'] ?? null, stableReserve, computeMinAgreed, bridgeLockbox: opt['bridge-lockbox'] ?? null,
      skipSnapBuild: !!opt['skip-snap-build'],
      devnet, timelockDelay: delay, guardian, extraProposers, executorMode, oracleRelayers, pythZetaFeed: opt['pyth-zeta-feed'] ?? null,
      oracleMinLiquidity, stableTestnetPrice,
    };
    try {
      const steps = launchSteps();
      const est = await estimate(ctx, state, only ? steps.filter((s) => only.includes(s.name)) : steps);
      const balance = await provider.getBalance(wallet.address);
      log(`balance ${zeta(balance)}; the steps left (${est.todo.join(' ') || 'none'}) need about ${zeta(est.need)} `
        + `(${est.gas.toLocaleString('en-US')} gas at ${est.price} azetaphy x 1.5, plus ${zeta(est.value)} put into contracts)`);
      if (balance < est.need) {
        const msg = `the deployer ${wallet.address} needs about ${zeta(est.need - balance)} more: send testnet ZETAPHY to it (docs/LAUNCH.md, step 3)`;
        if (!opt['dry-run']) throw new Error(msg);
        log(`warning: ${msg}`);
      }
      // Before each step: wait until the node's pending nonce has caught up with its latest block.
      const settle = async () => {
        for (let i = 0; i < 30; i++) {
          const [p, l] = await Promise.all([provider.getTransactionCount(wallet.address, 'pending'), provider.getTransactionCount(wallet.address, 'latest')]);
          if (p >= l) return;
          await new Promise((res) => setTimeout(res, 1000));
        }
      };
      const r = await runSteps({ steps, state, ctx, only, redo: !!opt.redo, dryRun: !!opt['dry-run'], log, save: (s) => saveState(stateFile, s), settle });
      if (opt['dry-run']) { log(`dry run: nothing sent, nothing written (${r.wouldRun.length} step(s) would run)`); return 0; }
      saveState(stateFile, state);
      const o = outputs(state);
      log('\naddresses:');
      for (const [k, v] of Object.entries(o)) if (typeof v === 'string') log(`  ${k.padEnd(22)} ${v}`);
      if (o.dex) log(`  ${'DEX factory/router'.padEnd(22)} ${o.dex.contracts.factory} / ${o.dex.contracts.router}`);
      if (o.dlmm) log(`  ${'DLMM factory/router'.padEnd(22)} ${o.dlmm.contracts.dlmmFactory} / ${o.dlmm.contracts.dlmmRouter} (UNAUDITED)`);
      if (o.nft) log(`  ${'NFT factory/market'.padEnd(22)} ${o.nft.factory} / ${o.nft.marketplace}`);
      if (!ctx.handover) log(`\n${handoverPlan(ctx, state)}`);
      log(`\nstate written to ${stateFile}`);
      return 0;
    } finally {
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      keys?.cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    provider.destroy();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`error: ${e.shortMessage ?? e.message}`); process.exitCode = 1; });
}
