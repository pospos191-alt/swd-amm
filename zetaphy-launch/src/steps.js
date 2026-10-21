// The launch steps, in order. Each reuses the package's own deploy code:
//   zetaphy-network/cli.js (run as a child, ZETAPHY_HOME = a private temp folder holding the key),
//   zetaphy-dex/cli.js deploy() (imported), zetaphy-nft/cli.js deploy (run as a child).
// Configure everything first, hand over last: the handover gives every admin role to a new
// ZetaphyTimelock (proposers: the gov module or a multisig; 48 h by default), so every later
// change is scheduled in public and waits the delay; a guardian multisig keeps the emergency
// switches that only reduce risk.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Contract, ContractFactory, NonceManager, formatEther, parseEther, parseUnits, getAddress, id as hashText, ZeroAddress, ZeroHash } from 'ethers';
import { outputs } from './runner.js';
import { CONFIG_FILES } from './configs.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const GOV_MODULE = '0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2';
/** The gov module's bech32 address (zetaphy-network/cli.js; zetaphy10d07y… = sha256("gov")[:20]). */
export const GOV_MODULE_BECH32 = 'zetaphy10d07y265gmmuvt4z0w9aw880jnsr700jvr86lj';
export const EVM_CHAIN_ID = 77390n;
/** The timelock's delay: 48 h by default, never below 24 h outside a devnet. */
export const DEFAULT_DELAY = 48 * 3600;
export const MIN_DELAY = 24 * 3600;
export const TIMELOCK_ROLES = { admin: ZeroHash, proposer: hashText('PROPOSER_ROLE'), executor: hashText('EXECUTOR_ROLE'), canceller: hashText('CANCELLER_ROLE') };

const art = (pkg, n) => JSON.parse(readFileSync(join(ROOT, pkg, 'artifacts', `${n}.json`), 'utf8'));
const NET = (n) => art('zetaphy-network', n);

// ---------- children ----------

/** The environment for a child tool: no key or passphrase in it (the key is in the temp folder). */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['ZETAPHY_DEPLOYER_KEY', 'ZETAPHY_DEPLOYER_KEY_FILE', 'ZETAPHY_PRIVATE_KEY', 'ZETAPHY_KEY_FILE', 'ZETAPHY_DEX_KEY_FILE', 'ZETAPHY_PASSPHRASE']) delete env[k];
  return env;
}

function run(cmd, args, { cwd, env, log, timeout = 600_000 }) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { cwd, env, timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      if (err) { const e = new Error(`${args.slice(0, 2).join(' ')} exited ${err.code ?? err.signal}: ${out.trim().split('\n').slice(-6).join(' | ')}`); e.output = out; reject(e); } else resolve(out);
    });
    const relay = (d) => { for (const l of String(d).split('\n')) if (l.trim()) log(`    ${l}`); };
    p.stdout.on('data', relay); p.stderr.on('data', relay);
  });
}

/** The settings zetaphy-network/cli.js keeps in $ZETAPHY_HOME/config.json, from the launch outputs. */
function netSettings(ctx, o) {
  const s = { rpc: ctx.rpc };
  for (const [k, v] of [['jobs', o.neuroJobs], ['threats', o.threatRegistry], ['reports', o.threatReports], ['gateway', o.stableGateway], ['usdc', o.tUSDC], ['usdt', o.tUSDT],
    ['pqFactory', o.quantumWalletFactory], ['vault', o.rewardVault], ['identity', o.neuroIdentity], ['validation', o.neuroValidation]]) if (v) s[k] = v;
  return s;
}

/** zetaphy-network/cli.js <args> with this deployer; returns { out, cfg } (cfg: what it saved, with the new addresses). */
export async function net(ctx, state, args) {
  const file = join(ctx.home, 'config.json');
  writeFileSync(file, JSON.stringify(netSettings(ctx, outputs(state)), null, 2));
  const out = await run(process.execPath, [join(ROOT, 'zetaphy-network/cli.js'), ...args, '--rpc', ctx.rpc], { cwd: ctx.home, env: childEnv({ ZETAPHY_HOME: ctx.home }), log: ctx.log });
  return { out, cfg: JSON.parse(readFileSync(file, 'utf8')) };
}

const pick = (re, out, what) => { const m = re.exec(out); if (!m) throw new Error(`could not read the ${what} address from the output`); return getAddress(m[1]); };

/** Checks every value that looks like an address has code. */
async function haveCode(ctx, o) {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && (await ctx.provider.getCode(v)) === '0x') throw new Error(`${k} ${v}: no contract code there`);
  }
  return o;
}

const signer = (ctx) => new NonceManager(ctx.wallet.connect(ctx.provider));
const wait = async (txp) => { const r = await (await txp).wait(); if (r.status !== 1) throw new Error('transaction reverted'); return r; };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ---------- the bridge's opening gates ----------

/** What opening the lock/mint bridge needs (docs/LAUNCH.md; zetaphy bridge open checks each one). */
export const BRIDGE_GATES = [
  'bridge: CLOSED (route disabled). It opens only through `zetaphy bridge open`, once every gate holds:',
  '  1. a second, independent lane (HyperlaneLane: its own Mailbox/ISM, not NeuroLane\'s runners), on-chain independentLanes() >= 2',
  '  2. an audit: --audit-report <https url> --audit-sha256 <hex>, recorded on-chain (BridgeGuard.setAudit)',
  '  3. at least 10 independent Neuro runners (NeuroJobs.activeWorkers)',
  '  4. guardian and governance are different multisigs (3+ owners, threshold 2+, hardware wallets, no shared owner)',
  '  5. a small daily limit (starter cap 1,000 tokens; raised x2 at most, 7 days per step) and --i-understand-real-funds',
];

/** Is the airlock's route enabled in BridgeGuard? */
export async function bridgeOpen(ctx, o) {
  const airlock = new Contract(o.bridgeAirlock, NET('BridgeAirlock').abi, ctx.provider);
  const guard = new Contract(o.bridgeGuard, NET('BridgeGuard').abi, ctx.provider);
  return (await guard.routes(await airlock.route())).enabled;
}

// ---------- the steps ----------

export function launchSteps() {
  return [
    {
      name: 'neuro',
      describe: 'NeuroJobs + NeuroControl (zetaphy deploy): the current Neuro skill and the runner chains voted in; the deployer stays governance for now',
      artifacts: [['zetaphy-network', 'NeuroJobs'], ['zetaphy-network', 'NeuroControl']], txs: 5,
      async run(ctx, state) {
        const args = ['deploy'];
        if (ctx.communityFund) args.push('--community-fund', ctx.communityFund);
        const { out, cfg } = await net(ctx, state, args);
        const neuroJobs = getAddress(cfg.jobs);
        const neuroControl = pick(/governed by NeuroControl (0x[0-9a-fA-F]{40})/, out, 'NeuroControl');
        return haveCode(ctx, { neuroJobs, neuroControl });
      },
    },
    {
      name: 'skill',
      always: true,
      describe: 'check that NeuroControl\'s active skill is this repo\'s Neuro skill id (approve + activate it while the deployer is governance)',
      async run(ctx, state) {
        const o = outputs(state);
        const { skillId } = await import(pathToFileURL(join(ROOT, 'zetaphy-network/src/skill.js')).href);
        const id = skillId();
        const k = new Contract(o.neuroControl, NET('NeuroControl').abi, signer(ctx));
        const [active, approved, gov] = await Promise.all([k.activeSkill(), k.skillApproved(id), k.governance()]);
        if (same(active, id)) { ctx.log(`  active skill ${id} (this repo's zetaphy-neuro/src)`); return { skillId: id }; }
        if (!same(gov, ctx.address)) {
          ctx.log(`  the active skill is ${active}, not ${id}; NeuroControl governance is ${gov}, so a vote must change it:`);
          if (!approved) ctx.log(`    gov.sh neuro approve-skill ${id} ${o.neuroControl}`);
          ctx.log(`    gov.sh neuro set-active-skill ${id} ${o.neuroControl}`);
          return { skillId: active, skillWanted: id };
        }
        if (!approved) await wait(k.approveSkill(id));
        await wait(k.setActiveSkill(id));
        ctx.log(`  skill ${id} approved and active`);
        return { skillId: id };
      },
    },
    {
      name: 'threats',
      describe: 'ThreatRegistry (zetaphy deploy-threats), wired to NeuroJobs; the deployer stays governance so later steps can protect keys',
      artifacts: [['zetaphy-network', 'ThreatRegistry']], txs: 2,
      async run(ctx, state) {
        const args = ['deploy-threats'];
        if (ctx.communityFund) args.push('--community-fund', ctx.communityFund);
        const { cfg } = await net(ctx, state, args);
        return haveCode(ctx, { threatRegistry: getAddress(cfg.threats) });
      },
    },
    {
      name: 'reports',
      describe: 'ThreatReports (zetaphy deploy-reports): user reports, fee to the runners who flag',
      artifacts: [['zetaphy-network', 'ThreatReports']],
      async run(ctx, state) {
        const { cfg } = await net(ctx, state, ['deploy-reports']);
        return haveCode(ctx, { threatReports: getAddress(cfg.reports) });
      },
    },
    {
      name: 'identity',
      describe: 'NeuroIdentity + NeuroValidation (zetaphy deploy-identity --web <Neuro URL>), ERC-8004',
      artifacts: [['zetaphy-network', 'NeuroIdentity'], ['zetaphy-network', 'NeuroValidation']], txs: 1,
      when: (ctx) => (ctx.neuroUrl ? true : 'needs --neuro-url https://<Neuro web>/web/'),
      async run(ctx, state) {
        const { cfg } = await net(ctx, state, ['deploy-identity', '--web', ctx.neuroUrl]);
        return haveCode(ctx, { neuroIdentity: getAddress(cfg.identity), neuroValidation: getAddress(cfg.validation) });
      },
    },
    {
      name: 'vault',
      describe: 'RewardVault (zetaphy deploy-vault): releases 10% a year to NeuroJobs; the 500M rewards account is moved in separately (deploy-vault --fund, from the genesis rewards key)',
      artifacts: [['zetaphy-network', 'RewardVault']],
      async run(ctx, state) {
        const { cfg } = await net(ctx, state, ['deploy-vault']);
        return haveCode(ctx, { rewardVault: getAddress(cfg.vault) });
      },
    },
    {
      name: 'pq',
      describe: 'QuantumWalletFactory (zetaphy deploy-pq)',
      artifacts: [['zetaphy-network', 'QuantumWalletFactory']],
      async run(ctx, state) {
        const { cfg } = await net(ctx, state, ['deploy-pq']);
        return haveCode(ctx, { quantumWalletFactory: getAddress(cfg.pqFactory) });
      },
    },
    {
      name: 'stable',
      describe: 'test USDC/USDT + StableGateway (zetaphy deploy-stable): users with no ZETAPHY pay fees in stablecoins',
      artifacts: [['zetaphy-network', 'TestStable'], ['zetaphy-network', 'TestStable'], ['zetaphy-network', 'StableGateway']], txs: 3,
      value: (ctx) => parseEther(String(ctx.stableReserve)),
      async run(ctx, state) {
        const { cfg } = await net(ctx, state, ['deploy-stable', '--reserve', String(ctx.stableReserve)]);
        return haveCode(ctx, { tUSDC: getAddress(cfg.usdc), tUSDT: getAddress(cfg.usdt), stableGateway: getAddress(cfg.gateway) });
      },
    },
    {
      name: 'compute',
      describe: 'ComputeMarket (escrowed AI jobs for runners with a record), NeuroJobs as the runner registry',
      artifacts: [['zetaphy-network', 'ComputeMarket']],
      async run(ctx, state) {
        const a = NET('ComputeMarket');
        const k = await new ContractFactory(a.abi, a.bytecode, signer(ctx)).deploy(outputs(state).neuroJobs, ctx.computeMinAgreed);
        await k.waitForDeployment();
        ctx.log(`  ComputeMarket ${await k.getAddress()} (runners need ${ctx.computeMinAgreed} accepted verdict(s))`);
        return haveCode(ctx, { computeMarket: await k.getAddress() });
      },
    },
    {
      name: 'bridge',
      describe: 'BridgeGuard + BridgeAirlock + NeuroLane (zetaphy deploy-bridge --lockbox …), deployed CLOSED (route disabled, 1,000-token cap); protects the bridge\'s own contracts and the lockbox',
      artifacts: [['zetaphy-network', 'BridgeGuard'], ['zetaphy-network', 'BridgeAirlock'], ['zetaphy-network', 'NeuroLane']], txs: 9,
      when: (ctx) => (ctx.bridgeLockbox ? true : 'off by default: needs a LockBox on the source chain, --bridge-lockbox <chainId>:0x<LockBox>'),
      async run(ctx, state) {
        const o = outputs(state);
        const { out, cfg } = await net(ctx, state, ['deploy-bridge', '--lockbox', ctx.bridgeLockbox, '--control', o.neuroControl]);
        const res = await haveCode(ctx, { bridgeGuard: getAddress(cfg.bridgeGuard), bridgeAirlock: getAddress(cfg.airlock), neuroLane: getAddress(cfg.neuroLane),
          bridgedToken: pick(/BridgedToken (0x[0-9a-fA-F]{40})/, out, 'BridgedToken'), bridgeLockbox: ctx.bridgeLockbox });
        // The launch never opens the bridge: check it is closed, and say what opening needs.
        if (await bridgeOpen(ctx, res)) throw new Error('the bridge route is enabled right after deploy-bridge: refusing (the launch deploys it closed)');
        for (const l of BRIDGE_GATES) ctx.log(`  ${l}`);
        return { ...res, bridgeOpen: false };
      },
    },
    {
      name: 'dex',
      describe: 'DEX factory + router + two test tokens with seeded pools (zetaphy-dex deploy), the router checking the ThreatRegistry',
      artifacts: [['zetaphy-dex', 'ZetaphyFactory'], ['zetaphy-dex', 'ZetaphyRouter'], ['zetaphy-dex', 'TestToken'], ['zetaphy-dex', 'TestToken'], ['zetaphy-dex', 'ZetaphyPair'], ['zetaphy-dex', 'ZetaphyPair']], txs: 5,
      value: () => parseEther('200'),
      async run(ctx, state) {
        const { deploy } = await import(pathToFileURL(join(ROOT, 'zetaphy-dex/cli.js')).href);
        const out = join(ctx.tmp, 'dex.json');
        const dex = await deploy({ rpc: ctx.rpc, 'key-file': ctx.keyFile, registry: outputs(state).threatRegistry, 'test-tokens': true, 'public-rpc': ctx.publicRpc, out }, (l) => ctx.log(`    ${l}`));
        await haveCode(ctx, { factory: dex.contracts.factory, router: dex.contracts.router, ...Object.fromEntries(dex.tokens.map((t) => [t.symbol, t.address])) });
        return { dex };
      },
    },
    {
      name: 'nft',
      describe: 'NFT factory + marketplace (zetaphy-nft deploy), the marketplace checking the ThreatRegistry; protects the collections\' shared code keys',
      artifacts: [['zetaphy-nft', 'NFTFactory'], ['zetaphy-nft', 'NFTMarketplace']], txs: 1,
      async run(ctx, state) {
        const file = join(ctx.tmp, 'nft.json');
        await run(process.execPath, [join(ROOT, 'zetaphy-nft/cli.js'), 'deploy', '--rpc', ctx.rpc, '--key-file', ctx.keyFile, '--registry', outputs(state).threatRegistry,
          '--public-rpc', ctx.publicRpc, '--out', file], { cwd: ctx.tmp, env: childEnv(), log: ctx.log });
        const nft = JSON.parse(readFileSync(file, 'utf8'));
        await haveCode(ctx, { factory: nft.factory, marketplace: nft.marketplace });
        return { nft };
      },
    },
    {
      name: 'oracle',
      describe: 'TwapRecorder + ZetaphyPythRelay + ZetaphyOracle (ZETAPHY/USD: TWAP of the DEX pool WZETAPHY/tUSD, Pyth when a feed is given), the StableGateway priced by it',
      artifacts: [['zetaphy-network', 'TwapRecorder'], ['zetaphy-network', 'ZetaphyPythRelay'], ['zetaphy-network', 'ZetaphyOracle']], txs: 8,
      async run(ctx, state) {
        const o = outputs(state);
        const s = signer(ctx);
        const deploy = async (n, args) => { const a = NET(n); const k = await new ContractFactory(a.abi, a.bytecode, s).deploy(...args); await k.waitForDeployment(); return k.getAddress(); };
        const twapRecorder = await deploy('TwapRecorder', [60]);
        const pythRelay = await deploy('ZetaphyPythRelay', [ctx.address, ctx.oracleRelayers ?? [], 1]);
        const oracle = await deploy('ZetaphyOracle', [ctx.address, twapRecorder, pythRelay]);
        const k = new Contract(oracle, NET('ZetaphyOracle').abi, s);
        const out = { twapRecorder, pythRelay, oracle };
        const usdToken = o.dex?.tokens?.find((t) => t.symbol === 'tUSD');
        if (o.dex && usdToken) {
          const zetaAsset = getAddress(o.dex.contracts.wnative);
          const factory = new Contract(o.dex.contracts.factory, art('zetaphy-dex', 'ZetaphyFactory').abi, ctx.provider);
          const zetaPair = getAddress(await factory.getPair(zetaAsset, usdToken.address));
          await wait(k.setTwap(zetaAsset, zetaPair, 1800, 10, 2000, BigInt(ctx.oracleMinLiquidity ?? 10000) * 10n ** 18n));
          if (ctx.pythZetaFeed) await wait(k.setPythFeed(zetaAsset, ctx.pythZetaFeed, 120, 100));
          await wait(k.setGuards(zetaAsset, 200, 1500, 3000, 3600));
          await wait(k.poke(zetaAsset, { gasLimit: 800_000n })); // the first TWAP observation (a fixed limit: an estimate may skip the recording)
          Object.assign(out, { zetaAsset, zetaPair });
          ctx.log(`  ZetaphyOracle ${oracle}: ZETAPHY/USD from the DEX pool ${zetaPair} (30 min TWAP, 10+ observations)${ctx.pythZetaFeed ? ` and Pyth ${ctx.pythZetaFeed}` : ''}; priced once the window has filled (keeper: zetaphy relay start --poke-oracle 60, or zetaphy oracle poke)`);
          if (o.stableGateway) {
            const gw = new Contract(o.stableGateway, NET('StableGateway').abi, s);
            if (same(await gw.owner(), ctx.address)) {
              if (!same(await gw.oracle(), oracle)) await wait(gw.setOracle(oracle, zetaAsset));
              if (ctx.stableTestnetPrice) {
                const price = parseUnits(ctx.stableTestnetPrice, 6);
                for (const t of [o.tUSDC, o.tUSDT].filter(Boolean)) await wait(gw.setTestnetFixedPrice(t, price));
                await wait(gw.setTestnetFixedPrices(true));
                ctx.log(`  StableGateway: TESTNET FIXED PRICE ${ctx.stableTestnetPrice} tUSDC per ZETAPHY (labeled; the oracle takes over when governance switches it off)`);
              } else ctx.log('  StableGateway: priced by ZetaphyOracle');
            }
          }
        } else ctx.log('  no DEX pool to price ZETAPHY from: configure a feed later (zetaphy oracle feed)');
        return haveCode(ctx, out);
      },
    },
    {
      name: 'wire',
      always: true,
      describe: 'check the DEX factory and the NFT marketplace point at the ThreatRegistry (set-registry while the deployer is governance)',
      async run(ctx, state) {
        const o = outputs(state);
        const s = signer(ctx);
        const checks = [];
        if (o.dex) checks.push(['DEX factory', new Contract(o.dex.contracts.factory, art('zetaphy-dex', 'ZetaphyFactory').abi, s)]);
        if (o.nft) checks.push(['NFT marketplace', new Contract(o.nft.marketplace, art('zetaphy-nft', 'NFTMarketplace').abi, s)]);
        for (const [what, k] of checks) {
          const cur = await k.threatRegistry();
          if (same(cur, o.threatRegistry)) { ctx.log(`  ${what}: ThreatRegistry ${cur}`); continue; }
          const gov = await k.governance();
          if (!same(gov, ctx.address)) { ctx.log(`  ${what} uses ${cur}; its governance ${gov} must call setThreatRegistry(${o.threatRegistry})`); continue; }
          await wait(k.setThreatRegistry(o.threatRegistry));
          ctx.log(`  ${what}: ThreatRegistry set to ${o.threatRegistry}`);
        }
      },
    },
    {
      name: 'protect',
      always: true,
      describe: 'check the shared code keys are protected in the ThreatRegistry (NFT factory collections; the bridge protects its own in its step)',
      async run(ctx, state) {
        const o = outputs(state);
        const reg = new Contract(o.threatRegistry, NET('ThreatRegistry').abi, signer(ctx));
        const keys = Object.values(o.nft?.collectionCodeKeys ?? {});
        const missing = [];
        for (const k of keys) if (!(await reg.protectedKey(k))) missing.push(k);
        if (!missing.length) { ctx.log(`  ${keys.length} shared code key(s) protected`); return { protectedKeys: keys }; }
        const gov = await reg.governance();
        if (!same(gov, ctx.address)) {
          const data = reg.interface.encodeFunctionData('setProtected', [missing, true]);
          ctx.log(`  ${missing.length} key(s) not protected and the registry's governance is ${gov}: it must call ${o.threatRegistry} with data ${data}`);
          return { protectedKeys: keys.filter((k) => !missing.includes(k)), unprotectedKeys: missing };
        }
        await wait(reg.setProtected(missing, true));
        ctx.log(`  protected ${missing.length} shared code key(s)`);
        return { protectedKeys: keys };
      },
    },
    {
      name: 'configs',
      always: true,
      describe: 'write the addresses and the RPC into the web apps\' configs (DEX, NFT, explorer, wallet, snap)',
      async run(ctx, state) {
        const { CHAINS } = await import(pathToFileURL(join(ROOT, 'zetaphy-neuro/src/chains.js')).href);
        const neuroReadsZetaphy = Object.hasOwn(CHAINS, 'zetaphy');
        if (ctx.neuroUrl && !neuroReadsZetaphy) ctx.log('  explorer: no Neuro report link yet (the Neuro web page does not read ZETAPHY contracts: zetaphy-neuro/src/chains.js)');
        const o = { ...outputs(state), publicRpc: ctx.publicRpc, neuroUrl: ctx.neuroUrl, neuroReadsZetaphy, walletOrigin: ctx.walletOrigin };
        const written = [];
        for (const [rel, writer] of CONFIG_FILES) {
          const file = join(ctx.configRoot, rel);
          const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
          const after = writer(before, o);
          if (after !== before) { writeFileSync(file, after); ctx.log(`  wrote ${rel}`); } else ctx.log(`  ${rel}: up to date`);
          written.push(rel);
        }
        return { configs: written };
      },
    },
    {
      name: 'snap',
      always: true,
      describe: 'npm run build in zetaphy-snap, so snap.manifest.json carries the shasum of the bundle with the new constants',
      when: (ctx) => (ctx.skipSnapBuild ? 'skipped (--skip-snap-build): run npm run build in zetaphy-snap before publishing' : true),
      async run(ctx) {
        const dir = join(ctx.configRoot, 'zetaphy-snap');
        if (!existsSync(join(dir, 'node_modules', '.bin', 'mm-snap'))) throw new Error('zetaphy-snap has no node_modules: run npm ci there first');
        await run('npm', ['run', 'build'], { cwd: dir, env: childEnv(), log: ctx.log });
        const shasum = JSON.parse(readFileSync(join(dir, 'snap.manifest.json'), 'utf8')).source.shasum;
        ctx.log(`  snap.manifest.json shasum ${shasum}`);
        return { snapShasum: shasum };
      },
    },
    {
      name: 'timelock',
      describe: 'ZetaphyTimelock (OpenZeppelin TimelockController 5.4.0): deployed with the deployer as its only proposer and a zero delay; the handover gives it every admin role, its real proposers and the delay, then the deployer renounces',
      artifacts: [['zetaphy-network', 'ZetaphyTimelock']],
      when: (ctx) => (ctx.handover ? true : 'only with --handover'),
      async run(ctx) {
        const a = NET('ZetaphyTimelock');
        const k = await new ContractFactory(a.abi, a.bytecode, signer(ctx)).deploy(0, [ctx.address], [ctx.address], ZeroAddress);
        const rc = await k.deploymentTransaction().wait();
        return haveCode(ctx, { timelock: await k.getAddress(), timelockBlock: rc.blockNumber });
      },
    },
    {
      name: 'handover',
      always: true,
      describe: 'hand every admin role to the ZetaphyTimelock, the emergency switches to --guardian, and check on-chain that no EOA keeps an admin role (last)',
      txs: 30,
      when: (ctx) => (ctx.handover ? true : 'no --handover: the deployer stays admin for the testnet bring-up (the plan is printed below)'),
      async run(ctx, state) {
        return handover(ctx, state);
      },
    },
  ];
}

// ---------- governance ----------

/** The admin roles a handover moves to the timelock: { label, address, abi, read, write, twoStep? }. */
export function adminRoles(o) {
  const R = [];
  const add = (label, address, abi, read, write, extra = {}) => { if (address) R.push({ label, address, abi, read, write, ...extra }); };
  add('NeuroControl (Neuro: skills, defenders, chains, knobs of NeuroJobs)', o.neuroControl, NET('NeuroControl').abi, 'governance', 'setGovernance');
  add('ThreatRegistry (also governs ThreatReports)', o.threatRegistry, NET('ThreatRegistry').abi, 'governance', 'setGovernance');
  add('RewardVault', o.rewardVault, NET('RewardVault').abi, 'governance', 'setGovernance');
  add('StableGateway', o.stableGateway, NET('StableGateway').abi, 'owner', 'setOwner');
  add('NeuroIdentity (chains, web link)', o.neuroIdentity, NET('NeuroIdentity').abi, 'admin', 'setAdmin');
  add('BridgeGuard', o.bridgeGuard, NET('BridgeGuard').abi, 'governance', 'setGovernance');
  add('BridgeAirlock (lanes, threshold, quarantine, markers, threats)', o.bridgeAirlock, NET('BridgeAirlock').abi, 'governance', 'setGovernance');
  add('HyperlaneLane', o.hyperlaneLane, NET('HyperlaneLane').abi, 'governance', 'setGovernance');
  add('ZetaphyOracle (feeds, guards)', o.oracle, NET('ZetaphyOracle').abi, 'governance', 'setGovernance');
  add('ZetaphyPythRelay (relayers, threshold)', o.pythRelay, NET('ZetaphyPythRelay').abi, 'governance', 'setGovernance');
  add('NFT marketplace (fees, registry)', o.nft?.marketplace, art('zetaphy-nft', 'NFTMarketplace').abi, 'governance', 'setGovernance');
  add('DEX factory (feeTo, registry; the router\'s sweep; two-step: the timelock accepts)', o.dex?.contracts?.factory, art('zetaphy-dex', 'ZetaphyFactory').abi, 'governance', 'setGovernance', { twoStep: true });
  return R;
}

/** The emergency switches the guardian gets: { label, address, abi, set, read }. They can only reduce risk. */
export function guardianRoles(o) {
  const R = [];
  const add = (label, address, abi, set = 'setGuardian', read = 'guardian') => { if (address) R.push({ label, address, abi, set, read }); };
  add('BridgeGuard (pause, lower the cap, close a route; BridgeAirlock: remove a lane or marker, raise threshold / quarantine)', o.bridgeGuard, NET('BridgeGuard').abi);
  add('NeuroControl (pause Neuro)', o.neuroControl, NET('NeuroControl').abi);
  add('ThreatRegistry (holdNow, enforceNow on standing flags)', o.threatRegistry, NET('ThreatRegistry').abi);
  add('ZetaphyOracle (pause a feed)', o.oracle, NET('ZetaphyOracle').abi);
  add('StableGateway (pause requests)', o.stableGateway, NET('StableGateway').abi);
  return R;
}

/** A gov proposal (JSON for `zetaphyd tx gov submit-proposal`) whose message is MsgEVMCall from the gov module, as gov.sh neuro builds. */
export function evmCallProposal({ to, data, title, summary, gasLimit = 300000 }) {
  return {
    messages: [{ '@type': '/zetaphy.pq.v1.MsgEVMCall', Sender: GOV_MODULE_BECH32, To: getAddress(to), Value: '0', Data: Buffer.from(data.slice(2), 'hex').toString('base64'), GasLimit: String(gasLimit) }],
    metadata: '', deposit: '1000000000000000000000azetaphy', title, summary, expedited: false,
  };
}

async function handover(ctx, state) {
  const target = ctx.governance;
  if (!target || same(target, ctx.address)) throw new Error('--handover needs --governance gov or --governance 0x<multisig>');
  if (!ctx.guardian) throw new Error('--handover needs --guardian 0x<emergency multisig>');
  const o = outputs(state);
  if (!o.timelock) throw new Error('no timelock yet: the timelock step runs before the handover');
  const s = signer(ctx);
  const tl = new Contract(o.timelock, NET('ZetaphyTimelock').abi, s);
  const proposers = [...new Set([target, ...(ctx.extraProposers ?? [])].map((a) => getAddress(a)))];
  const executors = ctx.executorMode === 'governance' ? proposers : [ZeroAddress];
  const delay = BigInt(ctx.timelockDelay ?? DEFAULT_DELAY);
  // single keys hold nothing outside a devnet: proposers and the guardian are multisigs (or the gov module)
  for (const [what, a] of [...proposers.map((p) => ['proposer', p]), ['guardian', ctx.guardian]]) {
    if (same(a, ctx.address)) throw new Error(`--${what === 'proposer' ? 'governance' : 'guardian'} ${a}: not the deployer key`);
    if (!same(a, GOV_MODULE) && (await ctx.provider.getCode(a)) === '0x' && !ctx.devnet) throw new Error(`${what} ${a} is a single key (EOA): a multisig (or, for governance, the gov module); an EOA only with --devnet`);
  }
  const done = [], stuck = [];
  const guardianSet = [];
  // 1. the emergency switches (while the deployer is still governance of each)
  for (const r of guardianRoles(o)) {
    const k = new Contract(r.address, r.abi, s);
    if (await k[r.read](ctx.guardian)) { guardianSet.push(r.address); continue; }
    const gov = await k[r.address === o.stableGateway ? 'owner' : 'governance']();
    if (!same(gov, ctx.address)) { ctx.log(`  ${r.label}: ${ctx.guardian} is not a guardian and governance is ${gov}: schedule setGuardian through the timelock`); continue; }
    await wait(k[r.set](ctx.guardian, true));
    guardianSet.push(r.address);
    ctx.log(`  guardian ${ctx.guardian}: ${r.label}`);
  }
  if (o.bridgeAirlock) {
    const a = new Contract(o.bridgeAirlock, NET('BridgeAirlock').abi, s);
    if (!(await a.isVetoer(ctx.guardian)) && same(await a.governance(), ctx.address)) { await wait(a.setVetoer(ctx.guardian, true)); ctx.log(`  guardian ${ctx.guardian}: BridgeAirlock vetoer`); }
  }
  // 2. every admin role to the timelock (two-step ones: proposed now, accepted by the timelock below)
  const accept = [];
  for (const r of adminRoles(o)) {
    const k = new Contract(r.address, r.abi, s);
    const cur = await k[r.read]();
    if (same(cur, o.timelock)) { ctx.log(`  ${r.label}: already ${o.timelock}`); done.push(r.address); continue; }
    if (!same(cur, ctx.address)) { ctx.log(`  ${r.label}: admin is ${cur}, neither the deployer nor the timelock: left alone`); stuck.push(r.address); continue; }
    if (r.twoStep) {
      if (!same(await k.pendingGovernance(), o.timelock)) await wait(k[r.write](o.timelock));
      accept.push(r);
    } else {
      await wait(k[r.write](o.timelock));
      ctx.log(`  ${r.label}: handed to the timelock ${o.timelock}`);
      done.push(r.address);
    }
  }
  // 3. the timelock's own set-up, in one operation it schedules and runs at its starting zero delay:
  //    the real proposers/cancellers and executor, the two-step acceptances, and last the real delay.
  //    Then the deployer renounces every timelock role.
  if (await tl.hasRole(TIMELOCK_ROLES.proposer, ctx.address)) {
    const calls = [];
    const self = (fn, args) => calls.push([o.timelock, tl.interface.encodeFunctionData(fn, args)]);
    for (const p of proposers) { self('grantRole', [TIMELOCK_ROLES.proposer, p]); self('grantRole', [TIMELOCK_ROLES.canceller, p]); }
    for (const e of executors) self('grantRole', [TIMELOCK_ROLES.executor, e]);
    for (const r of accept) calls.push([r.address, new Contract(r.address, r.abi).interface.encodeFunctionData('acceptGovernance', [])]);
    self('updateDelay', [delay]);
    const targets = calls.map((c) => c[0]), values = calls.map(() => 0n), datas = calls.map((c) => c[1]);
    const salt = hashText(`zetaphy-launch handover ${state.chainId} ${o.timelock}`);
    const id = await tl.hashOperationBatch(targets, values, datas, ZeroHash, salt);
    if (Number(await tl.getOperationState(id)) === 0) await wait(tl.scheduleBatch(targets, values, datas, ZeroHash, salt, 0));
    if (Number(await tl.getOperationState(id)) !== 3) await wait(tl.executeBatch(targets, values, datas, ZeroHash, salt));
    for (const r of accept) { ctx.log(`  ${r.label}: accepted by the timelock`); done.push(r.address); }
    ctx.log(`  timelock ${o.timelock}: proposers/cancellers ${proposers.join(', ')}; executor ${ctx.executorMode === 'governance' ? proposers.join(', ') : 'anyone'}; delay ${delay} s`);
  } else if (accept.length) {
    for (const r of accept) { ctx.log(`  ${r.label}: pending; a proposer schedules ${r.address} acceptGovernance() through the timelock`); stuck.push(r.address); }
  }
  for (const role of ['proposer', 'canceller', 'executor', 'admin']) {
    if (await tl.hasRole(TIMELOCK_ROLES[role], ctx.address)) await wait(tl.renounceRole(TIMELOCK_ROLES[role], ctx.address));
  }
  // 4. check, on-chain: every admin role is the timelock's, the timelock is set up as asked, no EOA or deployer is left
  const { checkTimelock } = await import(pathToFileURL(join(ROOT, 'zetaphy-network/src/timelock.js')).href);
  const problems = [];
  const tlRead = new Contract(o.timelock, NET('ZetaphyTimelock').abi, ctx.provider);
  const chk = await checkTimelock(ctx.provider, tlRead, { minDelay: delay, proposers, executors: ctx.executorMode === 'governance' ? proposers : null,
    forbidden: [ctx.address], devnet: !!ctx.devnet, govModule: GOV_MODULE });
  problems.push(...chk.problems);
  for (const r of adminRoles(o)) {
    const cur = await new Contract(r.address, r.abi, ctx.provider)[r.read]();
    if (!same(cur, o.timelock)) problems.push(`${r.label} ${r.address}: admin is ${cur}, not the timelock`);
  }
  if (o.threatReports) {
    const reg = await new Contract(o.threatReports, ['function registry() view returns (address)'], ctx.provider).registry();
    if (!same(reg, o.threatRegistry)) problems.push(`ThreatReports ${o.threatReports} follows ${reg}, not the ThreatRegistry`);
  }
  if (o.neuroJobs) {
    const control = await new Contract(o.neuroJobs, NET('NeuroJobs').abi, ctx.provider).control();
    if (same(control, ZeroAddress)) problems.push(`NeuroJobs ${o.neuroJobs} has no NeuroControl yet: its deployer could still set one`);
  }
  for (const r of guardianRoles(o)) {
    const k = new Contract(r.address, r.abi, ctx.provider);
    if (!(await k[r.read](ctx.guardian))) problems.push(`${r.label}: ${ctx.guardian} is not a guardian`);
    if (await k[r.read](ctx.address)) problems.push(`${r.label}: the deployer is still a guardian`);
  }
  if (problems.length) throw new Error(`the handover check failed:\n  - ${problems.join('\n  - ')}`);
  ctx.log(`  checked on-chain: ${adminRoles(o).length} admin role(s) belong to the timelock; no EOA and not the deployer holds a timelock role; guardian ${ctx.guardian} on ${guardianRoles(o).length} contract(s)`);
  return { governance: o.timelock, timelock: o.timelock, proposers, executor: ctx.executorMode === 'governance' ? 'governance' : 'anyone', minDelay: Number(delay),
    guardian: ctx.guardian, handedOver: done, ...(stuck.length ? { notHandedOver: stuck } : {}), verifiedAt: new Date().toISOString() };
}

/** What the handover will do and the commands that follow it (printed when --handover is not given). */
export function handoverPlan(ctx, state) {
  const o = outputs(state);
  const lines = [];
  const target = ctx.governance && !same(ctx.governance, ctx.address) ? ctx.governance : null;
  const gov = target === GOV_MODULE || !target ? 'gov' : target;
  lines.push('Governance: the deployer is the admin of every contract for the testnet bring-up.');
  lines.push('Hand over once everything works: every admin role goes to a new ZetaphyTimelock (48 h delay); --governance');
  lines.push('becomes its proposer and canceller, anyone executes a call once its delay passed, and --guardian (a multisig)');
  lines.push('keeps the emergency switches that only reduce risk (pause, lower a cap, hold, remove a lane or marker, pause a feed):');
  lines.push(`  GitHub → Actions → launch-testnet → Run workflow, governance = ${gov}, guardian = 0x<multisig>, handover = yes`);
  lines.push(`  (or: node zetaphy-launch/launch.js --rpc ${ctx.publicRpc} --resume --governance ${gov} --guardian 0x<multisig> --handover)`);
  lines.push('It moves to the timelock:');
  for (const r of adminRoles(o)) lines.push(`  - ${r.label} ${r.address}`);
  lines.push('Then every change is scheduled, waits the delay in public (the bridge monitor alerts on it), and runs:');
  lines.push('  zetaphy timelock schedule --to <contract> --sig "fn(types)" --args …   (prints the multisig calldata, or a gov proposal file)');
  lines.push('  zetaphy timelock execute <id>   (anyone, after the delay)        zetaphy timelock cancel <id>   (a canceller)');
  if (o.neuroControl) {
    lines.push('With the gov module as proposer, a vote schedules the call, e.g. Neuro\'s skill:');
    lines.push(`  zetaphy neuro calldata set-active-skill <id>   then   zetaphy timelock schedule --to ${o.neuroControl} --data <that> --proposal-out p.json`);
    lines.push('  zetaphyd tx gov submit-proposal p.json …; gov.sh vote <id> yes; after the delay: zetaphy timelock execute <operation id>');
    lines.push(`Pausing Neuro stays immediate for the guardian: zetaphy neuro send pause (from the guardian multisig: ${o.neuroControl} pause())`);
  }
  return lines.join('\n');
}

// ---------- the balance estimate ----------

/** Gas and value the steps not done yet need: deployments priced by code size, plus calls. */
export async function estimate(ctx, state, steps) {
  let gas = 0n, value = 0n;
  const todo = [];
  for (const st of steps) {
    if (st.always || state.steps[st.name]?.doneAt) continue;
    if (st.when && st.when(ctx, state) !== true) continue;
    todo.push(st.name);
    for (const [pkg, n] of st.artifacts ?? []) {
      const a = art(pkg, n);
      const init = (a.bytecode.length - 2) / 2;
      const runtime = ((a.deployedBytecode ?? a.bytecode).length - 2) / 2;
      gas += 53000n + 16n * BigInt(init) + 200n * BigInt(runtime) + 300000n; // create + calldata + code deposit + constructor work
    }
    gas += 150000n * BigInt(st.txs ?? 0);
    if (st.value) value += st.value(ctx);
  }
  if (ctx.handover) gas += 150000n * 30n; // guardians, roles, the timelock's set-up batch, renouncing
  const fee = await ctx.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 10n ** 9n;
  const need = ((gas * price) * 3n) / 2n + value; // 1.5 x the gas, plus the coins the steps put in contracts
  return { todo, gas, price, value, need };
}

export const zeta = (wei) => `${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ZETAPHY`;
