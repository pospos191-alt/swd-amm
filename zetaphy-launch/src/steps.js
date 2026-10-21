// The launch steps, in order. Each reuses the package's own deploy code:
//   zetaphy-network/cli.js (run as a child, ZETAPHY_HOME = a private temp folder holding the key),
//   zetaphy-dex/cli.js deploy() (imported), zetaphy-nft/cli.js deploy (run as a child).
// Configure everything first, hand over last: once NeuroControl or the ThreatRegistry belongs to
// the gov module, every later change needs a vote.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Contract, ContractFactory, NonceManager, formatEther, parseEther, getAddress } from 'ethers';
import { outputs } from './runner.js';
import { CONFIG_FILES } from './configs.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const GOV_MODULE = '0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2';
/** The gov module's bech32 address (zetaphy-network/cli.js; zetaphy10d07y… = sha256("gov")[:20]). */
export const GOV_MODULE_BECH32 = 'zetaphy10d07y265gmmuvt4z0w9aw880jnsr700jvr86lj';
export const EVM_CHAIN_ID = 77390n;

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
      name: 'handover',
      always: true,
      describe: 'hand every admin role to --governance (last, after everything is configured)',
      txs: 9,
      when: (ctx) => (ctx.handover ? true : 'no --handover: the deployer stays admin for the testnet bring-up (the plan is printed below)'),
      async run(ctx, state) {
        return handover(ctx, state);
      },
    },
  ];
}

// ---------- governance ----------

/** The admin roles a handover moves: [label, address, abi, read, write, two-step?]. */
export function adminRoles(o) {
  const R = [];
  const add = (label, address, abi, read, write, extra = {}) => { if (address) R.push({ label, address, abi, read, write, ...extra }); };
  add('NeuroControl (Neuro: pause, skills, defenders)', o.neuroControl, NET('NeuroControl').abi, 'governance', 'setGovernance');
  add('ThreatRegistry (also governs ThreatReports)', o.threatRegistry, NET('ThreatRegistry').abi, 'governance', 'setGovernance');
  add('RewardVault', o.rewardVault, NET('RewardVault').abi, 'governance', 'setGovernance');
  add('StableGateway', o.stableGateway, NET('StableGateway').abi, 'owner', 'setOwner');
  add('NeuroIdentity (chains, web link)', o.neuroIdentity, NET('NeuroIdentity').abi, 'admin', 'setAdmin');
  add('BridgeGuard', o.bridgeGuard, NET('BridgeGuard').abi, 'governance', 'setGovernance');
  add('BridgeAirlock', o.bridgeAirlock, NET('BridgeAirlock').abi, 'governance', 'setGovernance');
  add('NFT marketplace', o.nft?.marketplace, art('zetaphy-nft', 'NFTMarketplace').abi, 'governance', 'setGovernance');
  add('DEX factory (two-step: the new governance calls acceptGovernance)', o.dex?.contracts?.factory, art('zetaphy-dex', 'ZetaphyFactory').abi, 'governance', 'setGovernance', { twoStep: true });
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
  const o = outputs(state);
  const s = signer(ctx);
  const done = [], pending = [], stuck = [];
  for (const r of adminRoles(o)) {
    const k = new Contract(r.address, r.abi, s);
    const cur = await k[r.read]();
    if (same(cur, target)) { ctx.log(`  ${r.label}: already ${target}`); done.push(r.address); continue; }
    if (!same(cur, ctx.address)) { ctx.log(`  ${r.label}: admin is ${cur}, neither the deployer nor ${target}: left alone`); stuck.push(r.address); continue; }
    if (r.twoStep && same(await k.pendingGovernance(), target)) ctx.log(`  ${r.label}: already proposed to ${target}`);
    else await wait(k[r.write](target));
    if (r.twoStep) {
      const data = k.interface.encodeFunctionData('acceptGovernance', []);
      pending.push(r.address);
      if (same(target, GOV_MODULE)) {
        const file = join(ctx.stateDir, 'proposals', `${state.chainId}-dex-accept-governance.json`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(evmCallProposal({ to: r.address, data, title: 'DEX: accept governance',
          summary: `The gov module accepts governance of the ZETAPHY DEX factory ${r.address} (acceptGovernance()).` }), null, 2) + '\n');
        ctx.log(`  ${r.label}: proposed to the gov module; it accepts by a vote: submit ${file} (see docs/LAUNCH.md)`);
      } else ctx.log(`  ${r.label}: proposed to ${target}; it must call ${r.address} acceptGovernance() (data ${data})`);
    } else { ctx.log(`  ${r.label}: handed to ${target}`); done.push(r.address); }
  }
  return { governance: target, handedOver: done, pendingAccept: pending, ...(stuck.length ? { notHandedOver: stuck } : {}) };
}

/** What the handover will do and the commands that follow it (printed when --handover is not given). */
export function handoverPlan(ctx, state) {
  const o = outputs(state);
  const lines = [];
  const target = ctx.governance && !same(ctx.governance, ctx.address) ? ctx.governance : null;
  lines.push('Governance: the deployer is the admin of every contract for the testnet bring-up.');
  lines.push('Hand over once everything works (after that, each change needs a vote):');
  lines.push(`  GitHub → Actions → launch-testnet → Run workflow, governance = ${target === GOV_MODULE || !target ? 'gov' : target}, handover = yes`);
  lines.push(`  (or: node zetaphy-launch/launch.js --rpc ${ctx.publicRpc} --resume --governance ${target === GOV_MODULE || !target ? 'gov' : target} --handover)`);
  lines.push('It moves:');
  for (const r of adminRoles(o)) lines.push(`  - ${r.label} ${r.address}`);
  if (o.neuroControl) {
    lines.push('With the gov module as governance, Neuro is then steered by votes, on the node:');
    lines.push(`  gov.sh neuro pause ${o.neuroControl}`);
    lines.push(`  gov.sh neuro approve-skill <new skill id> ${o.neuroControl} && gov.sh neuro set-active-skill <new skill id> ${o.neuroControl}`);
    lines.push('  gov.sh vote <id> yes');
  }
  if (o.dex) lines.push(`The DEX factory is two-step: the handover writes zetaphy-launch/state/proposals/${state.chainId}-dex-accept-governance.json (a MsgEVMCall vote).`);
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
  if (ctx.handover) gas += 60000n * 9n;
  const fee = await ctx.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 10n ** 9n;
  const need = ((gas * price) * 3n) / 2n + value; // 1.5 x the gas, plus the coins the steps put in contracts
  return { todo, gas, price, value, need };
}

export const zeta = (wei) => `${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ZETAPHY`;
