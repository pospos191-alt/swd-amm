#!/usr/bin/env node
// ZETAPHY Saphan, EVM routes v2: the whole route deployed and used on LOCAL chains, nothing sent to
// any testnet. Same code as the real deploy (scripts/saphan.js and `zetaphy deploy-bridge`), with
// throwaway keys standing in for the validators, so this run can sign the checkpoints itself:
//   source chain (ORIGIN_RPC: an anvil fork of the real chain, or a local chain with Hyperlane core)
//   ZETAPHY      (ZETAPHY_RPC: a local chain 77390 with Hyperlane core, or a fork once the RPC is back)
//
//   node scripts/saphan-dryrun.js --chain <name>
//
// Then, through the REAL Hyperlane Mailboxes and multisig ISMs (made by the real factories):
//   lock on the source -> Mailbox.process on ZETAPHY (signed for origin = source) -> HyperlaneLane
//   -> airlock (+ a second lane) -> mint; HyperlaneOutbox.send (burn) -> Mailbox.process on the
//   source (signed by "our" validators for origin ZETAPHY) -> HyperlaneLockBoxV2 -> claim after the delay;
// and the refusals: a replay, a wrong signer, a release from a contract that is not the outbox.
//
//   node scripts/saphan-dryrun.js --chain <name> --token <key|test>
//
// A token route instead (tokens born on ZETAPHY, contracts/SaphanTokens.sol; "test" = a BZTPHY-like stand-in):
//   vault.lock on ZETAPHY -> Mailbox.process on the destination (signed by "our" validators) -> synthetic mint after
//   the delay; synthetic.sendBack (burn) -> Mailbox.process on ZETAPHY (signed for origin = destination) -> vault
//   release after the delay; deployed closed, then opened; and the refusals. Prints TOKEN DRY RUN OK.
//
// env: ORIGIN_RPC, ZETAPHY_RPC, DEV_KEY (funded on both), ORIGIN_CORE / ZETAPHY_CORE (optional: the
// addresses.yaml of a local Hyperlane core deploy; without one, the chain table's addresses are used,
// as on a fork). Prints DRY RUN OK at the end.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, NonceManager, Interface, getAddress, parseEther, keccak256, zeroPadValue, solidityPacked, AbiCoder } from 'ethers';
import { chainOf, messageIdMetadata, bytes32, tokenOf, tokenProblems } from '../src/saphan.js';
import { originPrepare, zetaphyIsm, originLockbox, check, tokenVault, tokenSynthetic } from './saphan.js';

const HERE = new URL('..', import.meta.url).pathname;
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const MAILBOX = new Interface([
  'event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)',
  'function process(bytes metadata, bytes message) payable', 'function delivered(bytes32) view returns (bool)',
  'function dispatch(uint32,bytes32,bytes) payable returns (bytes32)', 'function quoteDispatch(uint32,bytes32,bytes) view returns (uint256)',
]);
const HOOK = ['function latestCheckpoint() view returns (bytes32, uint32)'];
const log = (...a) => console.log(...a);
const fail = (m) => { throw new Error(m); };

/** key: "0x…" lines of a Hyperlane addresses.yaml. */
function addressesYaml(file) {
  const out = {};
  for (const m of readFileSync(file, 'utf8').matchAll(/^(\w+):\s*"?(0x[0-9a-fA-F]{40})"?/gm)) out[m[1]] = m[2];
  return out;
}

const pick = (re, text, what) => (re.exec(text) ?? fail(`no ${what} in the deploy-bridge output`))[1];
async function mine(p, seconds) { await p.send('evm_increaseTime', [seconds]); await p.send('evm_mine', []); }
const messageOf = (rc) => rc.logs.map((l) => { try { return MAILBOX.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Dispatch')?.args.message ?? fail('no Dispatch event');
const ERRORS = new Interface(['HyperlaneLockBoxV2', 'HyperlaneLane', 'BridgeAirlock', 'BridgeGuard', 'ZetaphyTokenVault', 'SaphanSyntheticToken'].flatMap((n) => art(n).abi.filter((f) => f.type === 'error')));
async function refused(label, fn) {
  try { await fn(); } catch (e) {
    let why = e.shortMessage ?? e.message;
    try { const d = e.data && ERRORS.parseError(e.data); if (d && d.name !== 'Error') why = d.name; } catch { /* not ours */ }
    log(`  refused as it should: ${label} (${why.slice(0, 90)})`);
    return;
  }
  fail(`${label}: accepted`);
}

async function main() {
  const name = process.argv[process.argv.indexOf('--chain') + 1];
  const work = mkdtempSync(join(tmpdir(), 'saphan-dry-'));
  // the dry run's chain table: the real one, local addresses where a local core was deployed, throwaway validators
  const t = JSON.parse(readFileSync(new URL('../../zetaphy-chain/hyperlane/saphan-chains.json', import.meta.url), 'utf8'));
  chainOf(t, name);
  const sourceValidator = Wallet.createRandom();                 // stands for Hyperlane's validator of the source chain
  const ours = [Wallet.createRandom(), Wallet.createRandom()].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1)); // "our" validators, 2-of-2
  const c = t.chains[name];
  const coreKeys = ['mailbox', 'merkleTreeHook', 'validatorAnnounce', 'staticMessageIdMultisigIsmFactory'];
  if (process.env.ORIGIN_CORE) { const a = addressesYaml(process.env.ORIGIN_CORE); for (const k of coreKeys) c[k] = a[k] ?? fail(`${k} missing in ORIGIN_CORE`); }
  if (process.env.ZETAPHY_CORE) { const a = addressesYaml(process.env.ZETAPHY_CORE); for (const k of coreKeys) t.zetaphy[k] = a[k] ?? fail(`${k} missing in ZETAPHY_CORE`); }
  c.validators = [sourceValidator.address]; c.threshold = 1;
  t.zetaphyValidators = { validators: ours.map((w) => w.address), threshold: 2 };
  t.origin.owners = [Wallet.createRandom().address, Wallet.createRandom().address];
  t.origin.timelockDelay = 3600;
  const tableFile = join(work, 'saphan-chains.json');
  writeFileSync(tableFile, JSON.stringify(t, null, 2));
  const C = chainOf(t, name);

  const op = new JsonRpcProvider(process.env.ORIGIN_RPC, BigInt(C.chainId), { staticNetwork: true });
  const zp = new JsonRpcProvider(process.env.ZETAPHY_RPC, 77390n, { staticNetwork: true });
  const dev = new Wallet(process.env.DEV_KEY);
  const os = new NonceManager(dev.connect(op)), zs = new NonceManager(dev.connect(zp));
  log(`dry run: ${C.displayName} (${C.chainId}) <-> ZETAPHY (local), deployer ${dev.address}`);
  log(JSON.stringify(await check(t, C, op, dev.address)));
  const tokenArg = process.argv.includes('--token') ? process.argv[process.argv.indexOf('--token') + 1] : null;
  if (tokenArg) return tokenDryRun({ t, C, op, zp, os, zs, dev, ours, sourceValidator, key: tokenArg });

  // 1. the source chain's roles and our ISM; where the lockbox will be
  const prep = await originPrepare(t, C, op, os);
  log(`source: multisig ${prep.multisig}, timelock ${prep.timelock}, our ISM ${prep.ism}, lockbox will be ${prep.lockboxAt}`);
  // 2. ZETAPHY: the ISM for this origin, NeuroJobs (a stand-in for the testnet's), then deploy-bridge with the way back
  const { ism: zIsm } = await zetaphyIsm(t, C, zp, zs);
  const NJ = art('NeuroJobs');
  const jobs = await new ContractFactory(NJ.abi, NJ.bytecode, zs).deploy(100n * 10n ** 18n, 10n ** 18n, 10n ** 17n, 120, 600, 3600, 1000n * 10n ** 18n);
  await jobs.waitForDeployment();
  const home = join(work, 'zhome'); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, 'worker.key'), process.env.DEV_KEY, { mode: 0o600 });
  const Q = C.limits.quarantine;
  const r = spawnSync(process.execPath, ['cli.js', 'deploy-bridge', '--rpc', process.env.ZETAPHY_RPC, '--jobs', await jobs.getAddress(), '--control', '0x' + '00'.repeat(20),
    '--lockbox', `${C.chainId}:${prep.lockboxAt}`, '--hyperlane-mailbox', t.zetaphy.mailbox, '--hyperlane-origin', String(C.domain), '--hyperlane-ism', zIsm,
    '--hyperlane-outbox', '--decimals', '18', '--daily-limit', C.limits.zetaphyDailyLimit, '--quarantine', String(Q),
    '--token-name', C.token.name, '--token-symbol', C.token.symbol], { cwd: HERE, env: { ...process.env, ZETAPHY_HOME: home }, encoding: 'utf8' });
  log(r.stdout); if (r.status !== 0) fail(`deploy-bridge: ${r.stderr}`);
  zs.reset(); // deploy-bridge sent transactions with the same key
  const Z = { guard: pick(/BridgeGuard (0x[0-9a-fA-F]{40})/, r.stdout, 'BridgeGuard'), token: pick(/BridgedToken (0x[0-9a-fA-F]{40})/, r.stdout, 'BridgedToken'),
    airlock: pick(/BridgeAirlock (0x[0-9a-fA-F]{40})/, r.stdout, 'BridgeAirlock'), lane: pick(/HyperlaneLane (0x[0-9a-fA-F]{40})/, r.stdout, 'HyperlaneLane'),
    outbox: pick(/HyperlaneOutbox (0x[0-9a-fA-F]{40})/, r.stdout, 'HyperlaneOutbox') };
  // 3. the lockbox, exactly where ZETAPHY expects it
  const lb = await originLockbox(t, C, op, os, { lane: Z.lane, outbox: Z.outbox, expect: prep.lockboxAt, multisig: prep.multisig, timelock: prep.timelock, ism: prep.ism });
  log(`source: HyperlaneLockBoxV2 ${lb.lockbox} (lock fee ${lb.fee})`);

  const guard = new Contract(Z.guard, art('BridgeGuard').abi, zs);
  const airlock = new Contract(Z.airlock, art('BridgeAirlock').abi, zs);
  const lockbox = new Contract(lb.lockbox, art('HyperlaneLockBoxV2').abi, os);
  const outbox = new Contract(Z.outbox, art('HyperlaneOutbox').abi, zs);
  const token = new Contract(Z.token, art('BridgedToken').abi, zp);
  const zMailbox = new Contract(t.zetaphy.mailbox, MAILBOX, zs), oMailbox = new Contract(C.mailbox, MAILBOX, os);
  if (await guard.paused() || (await guard.routes(await airlock.route())).enabled) fail('the route is not deployed closed');

  // 4. in: lock on the source, the real ZETAPHY Mailbox + ISM deliver it to the lane
  const amount = parseEther('0.01');
  const fee = await lockbox.quoteLock(dev.address, amount);
  const rc = await (await lockbox.lock(dev.address, amount, { value: amount + fee })).wait();
  const mIn = messageOf(rc);
  const [rootIn, indexIn] = await new Contract(C.merkleTreeHook, HOOK, op).latestCheckpoint();
  const metaIn = messageIdMetadata(mIn, [sourceValidator], { merkleTreeHook: C.merkleTreeHook, root: rootIn, index: Number(indexIn) });
  await refused('a lock signed by a stranger', () => zMailbox.process.staticCall(messageIdMetadata(mIn, [ours[0]], { merkleTreeHook: C.merkleTreeHook }), mIn));
  await (await zMailbox.process(metaIn, mIn)).wait();
  await refused('the same lock again', () => zMailbox.process.staticCall(metaIn, mIn));
  const n = (await lockbox.nonce()) - 1n;
  const tr = [BigInt(C.chainId), lb.lockbox, n, dev.address, dev.address, amount];
  const id = await airlock.transferId(...tr);
  if (Number((await airlock.status(id))[0]) !== 1) fail('the HyperlaneLane did not attest');
  log('in: the lock arrived through the ZETAPHY Mailbox; HyperlaneLane attested');
  // a second lane (the deployer's key here; NeuroLane's runners on the testnet), open the route, release
  await (await airlock.setLane(dev.address, true)).wait();
  await (await airlock.attest(...tr)).wait();
  await (await guard.setAudit('https://example.invalid/dry-run-only', '0x' + 'ab'.repeat(32))).wait();
  await (await guard.setRoute(await airlock.route(), Z.airlock, parseEther(C.limits.zetaphyDailyLimit), true)).wait();
  await (await guard.setOutboundRoute(await outbox.route(), Z.outbox, parseEther(C.limits.zetaphyDailyLimit), true)).wait();
  await mine(zp, Q + 1);
  await (await airlock.release(...tr)).wait();
  if ((await token.balanceOf(dev.address)) !== amount) fail('not minted');
  log(`in: ${C.token.symbol} minted on ZETAPHY after the quarantine`);

  // 5. out: burn through the outbox, the real source Mailbox + our ISM deliver the release
  const back = amount / 2n;
  const rcOut = await (await outbox.send(dev.address, back, { value: await outbox.quoteSend(dev.address, back) })).wait();
  const mOut = messageOf(rcOut);
  const [rootOut, indexOut] = await new Contract(t.zetaphy.merkleTreeHook, HOOK, zp).latestCheckpoint();
  const sign = (signers, m = mOut) => messageIdMetadata(m, signers, { merkleTreeHook: t.zetaphy.merkleTreeHook, root: rootOut, index: Number(indexOut) });
  await refused('a release signed by 1 of our 2 validators', () => oMailbox.process.staticCall(sign([ours[0]]), mOut));
  await refused('a release signed by the source chain\'s validator', () => oMailbox.process.staticCall(sign([sourceValidator]), mOut));
  await (await oMailbox.process(sign(ours), mOut)).wait();
  await refused('the same release again', () => oMailbox.process.staticCall(sign(ours), mOut));
  if ((await lockbox.received()) !== 1n) fail('the lockbox did not record the release');
  const rid = keccak256('0x' + mOut.slice(2 + 77 * 2));
  await refused('a claim before the delay', () => lockbox.claim.staticCall(rid));
  await mine(op, C.limits.releaseDelay + 1);
  const rcClaim = await (await lockbox.claim(rid)).wait();
  const before = await op.getBalance(lb.lockbox, rcClaim.blockNumber - 1), after = await op.getBalance(lb.lockbox, rcClaim.blockNumber);
  if (before - after !== back) fail(`not released: the lockbox held ${before}, now ${after}; ${JSON.stringify((await lockbox.releases(rid)).toArray().map(String))}`);
  log(`out: burned on ZETAPHY, released on ${C.displayName} after the delay`);
  // a release dispatched by someone else's contract (here the deployer key) through the real ZETAPHY Mailbox
  const forged = AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address'],
    [77390n, Z.outbox, 99n, dev.address, dev.address, back, BigInt(C.chainId), lb.lockbox]);
  const rcF = await (await zMailbox.dispatch(C.domain, bytes32(lb.lockbox), forged, { value: await zMailbox.quoteDispatch(C.domain, bytes32(lb.lockbox), forged) })).wait();
  const mF = messageOf(rcF);
  await refused('a release from a sender that is not the outbox (validly signed)', () => oMailbox.process.staticCall(sign(ours, mF), mF));
  log('DRY RUN OK: both directions through the real Mailboxes and ISMs; nothing was sent to any testnet');
}

/**
 * A token born on ZETAPHY, out to the destination C and back (contracts/SaphanTokens.sol), with the same code as the
 * workflow's token deploy (scripts/saphan.js token-prepare, token-vault, token-synthetic). `key`: a token of the table,
 * or "test": a BZTPHY-like stand-in (18 decimals, transferable; the real BZTPHY cannot be moved). A token with no
 * code on this local ZETAPHY (every one: it is a fresh chain; the native coin's precompile does not exist on anvil) is
 * stood in for by a plain ERC-20 with the table's decimals and symbol. Here governance on both ends is the dry run's
 * key so it can open the route; the real deploy hands it to the timelocks.
 */
async function tokenDryRun({ t, C, op, zp, os, zs, dev, ours, sourceValidator, key }) {
  const BT = art('BridgedToken');
  const standIn = async (symbol, decimals) => {
    const k = await new ContractFactory(BT.abi, BT.bytecode, zs).deploy(`${symbol} (dry-run stand-in)`, symbol, decimals, dev.address);
    await k.waitForDeployment();
    return getAddress(k.target);
  };
  t.tokens ??= {};
  if (key === 'test') {
    key = 'tbztphy';
    t.tokens[key] = { displayName: 'BZTPHY-like (dry run)', symbol: 'tBZTPHY', address: await standIn('tBZTPHY', 18), decimals: 18,
      synthetic: { name: 'tBZTPHY (from the ZETAPHY dry run)', symbol: 'ztBZTPHY' }, destinations: [C.name],
      limits: { lockCap: '1000', releaseDailyLimit: '100', releaseDelay: 3600, mintDailyLimit: '100', mintDelay: 3600, supplyCap: '1000' } };
  }
  const k0 = tokenOf(t, key);
  if (!k0.destinations.includes(C.name)) fail(`token ${key}: ${C.name} is not one of its destinations`);
  if ((await zp.getCode(k0.address)) === '0x') {
    t.tokens[key].address = await standIn(k0.symbol, k0.decimals);
    t.tokens[key].native = false;
    log(`ZETAPHY (local): ${k0.symbol} ${k0.address} has no code here; stand-in ${t.tokens[key].address} (${k0.decimals} decimals)`);
  }
  const problems = tokenProblems(t);
  if (problems.length) fail(`token table: ${problems.join('; ')}`);
  const K = tokenOf(t, key);
  const U = 10n ** BigInt(K.decimals);
  log(`token route: ${K.symbol} (ZETAPHY ${K.address}) <-> ${K.synthetic.symbol} on ${C.displayName}`);

  // 1. the destination's roles and our ISM; where the synthetic will be (token-prepare)
  const prep = await originPrepare(t, C, op, os);
  log(`${C.name}: multisig ${prep.multisig}, timelock ${prep.timelock}, our ISM ${prep.ism}, synthetic will be ${prep.lockboxAt}`);
  // 2. ZETAPHY: the ISM of the destination's validators, the vault sending to that address (token-vault)
  const v = await tokenVault(t, K, C, zp, zs, { expect: prep.lockboxAt, governance: dev.address, guardian: dev.address, threats: 'none' });
  log(`ZETAPHY: ZetaphyTokenVault ${v.vault} (ISM ${v.ism})`);
  // 3. the synthetic, exactly there (token-synthetic)
  const s = await tokenSynthetic(t, K, C, op, os, { vault: v.vault, expect: prep.lockboxAt, multisig: prep.multisig, timelock: prep.timelock, ism: prep.ism, governance: dev.address });
  log(`${C.name}: SaphanSyntheticToken ${s.synthetic} (${s.symbol})`);

  const ERC20 = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)'];
  const token = new Contract(K.address, ERC20, zs);
  const vault = new Contract(v.vault, art('ZetaphyTokenVault').abi, zs);
  const syn = new Contract(s.synthetic, art('SaphanSyntheticToken').abi, os);
  const zMailbox = new Contract(t.zetaphy.mailbox, MAILBOX, zs), oMailbox = new Contract(C.mailbox, MAILBOX, os);
  const amount = 25n * U;
  await (await token.mint(dev.address, 100n * U)).wait();
  await (await token.approve(v.vault, amount)).wait();
  if (!(await vault.paused()) || !(await syn.paused())) fail('the token route is not deployed closed');
  await refused('a lock while the route is closed', () => vault.lock.staticCall(dev.address, amount));
  await (await vault.unpause()).wait();
  await (await syn.unpause()).wait();
  log('opened (governance unpaused both ends)');

  // 4. out: lock on ZETAPHY, the real destination Mailbox + our ISM deliver the mint
  const rcLock = await (await vault.lock(dev.address, amount, { value: await vault.quote(dev.address, amount) })).wait();
  const mOut = messageOf(rcLock);
  if ((await vault.locked()) !== amount) fail('not locked');
  const [rootZ, indexZ] = await new Contract(t.zetaphy.merkleTreeHook, HOOK, zp).latestCheckpoint();
  const signZ = (signers, m = mOut) => messageIdMetadata(m, signers, { merkleTreeHook: t.zetaphy.merkleTreeHook, root: rootZ, index: Number(indexZ) });
  await refused('a mint signed by 1 of our 2 validators', () => oMailbox.process.staticCall(signZ([ours[0]]), mOut));
  await refused(`a mint signed by ${C.displayName}'s validator`, () => oMailbox.process.staticCall(signZ([sourceValidator]), mOut));
  await (await oMailbox.process(signZ(ours), mOut)).wait();
  await refused('the same mint again', () => oMailbox.process.staticCall(signZ(ours), mOut));
  const mid = keccak256('0x' + mOut.slice(2 + 77 * 2));
  await refused('a mint before the delay', () => syn.claim.staticCall(mid));
  await mine(op, K.limits.mintDelay + 1);
  await (await syn.claim(mid)).wait();
  if ((await syn.balanceOf(dev.address)) !== amount) fail('not minted');
  log(`out: ${K.symbol} locked on ZETAPHY, ${K.synthetic.symbol} minted on ${C.displayName} after the delay`);

  // 5. back: burn on the destination, the real ZETAPHY Mailbox + the ISM of the destination's validator deliver the release
  const back = 10n * U;
  const rcBack = await (await syn.sendBack(dev.address, back, { value: await syn.quote(dev.address, back) })).wait();
  const mIn = messageOf(rcBack);
  const [rootO, indexO] = await new Contract(C.merkleTreeHook, HOOK, op).latestCheckpoint();
  const signO = (signers, m = mIn) => messageIdMetadata(m, signers, { merkleTreeHook: C.merkleTreeHook, root: rootO, index: Number(indexO) });
  await refused('a release signed by our validators (not the destination\'s)', () => zMailbox.process.staticCall(signO(ours), mIn));
  await (await zMailbox.process(signO([sourceValidator]), mIn)).wait();
  await refused('the same release again', () => zMailbox.process.staticCall(signO([sourceValidator]), mIn));
  const rid = keccak256('0x' + mIn.slice(2 + 77 * 2));
  await refused('a release before the delay', () => vault.claim.staticCall(rid));
  await mine(zp, K.limits.releaseDelay + 1);
  const before = await token.balanceOf(dev.address);
  await (await vault.claim(rid)).wait();
  if ((await token.balanceOf(dev.address)) - before !== back || (await vault.locked()) !== amount - back) fail('not released');
  if ((await syn.totalSupply()) !== amount - back) fail('the synthetic supply does not match the vault');
  log(`back: ${K.synthetic.symbol} burned on ${C.displayName}, ${K.symbol} released on ZETAPHY after the delay`);

  // 6. a release dispatched by someone else (the deployer key) through the real destination Mailbox, validly signed
  const forged = AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address', 'address'],
    [BigInt(C.chainId), s.synthetic, 99n, dev.address, dev.address, amount - back, 77390n, v.vault, K.address]);
  const rcF = await (await oMailbox.dispatch(t.zetaphy.domain, bytes32(v.vault), forged, { value: await oMailbox.quoteDispatch(t.zetaphy.domain, bytes32(v.vault), forged) })).wait();
  const mF = messageOf(rcF);
  const [rootF, indexF] = await new Contract(C.merkleTreeHook, HOOK, op).latestCheckpoint();
  await refused('a release from a sender that is not the synthetic (validly signed)',
    () => zMailbox.process.staticCall(messageIdMetadata(mF, [sourceValidator], { merkleTreeHook: C.merkleTreeHook, root: rootF, index: Number(indexF) }), mF));
  log(`TOKEN DRY RUN OK: ${K.symbol} -> ${C.displayName} -> ZETAPHY through the real Mailboxes and ISMs; nothing was sent to any testnet`);
}

main().then(() => process.exit(0), (e) => { console.error(`dry run FAILED: ${e.shortMessage ?? e.message}`); process.exit(1); });
