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
// env: ORIGIN_RPC, ZETAPHY_RPC, DEV_KEY (funded on both), ORIGIN_CORE / ZETAPHY_CORE (optional: the
// addresses.yaml of a local Hyperlane core deploy; without one, the chain table's addresses are used,
// as on a fork). Prints DRY RUN OK at the end.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, NonceManager, Interface, getAddress, parseEther, keccak256, zeroPadValue, solidityPacked, AbiCoder } from 'ethers';
import { chainOf, messageIdMetadata, bytes32 } from '../src/saphan.js';
import { originPrepare, zetaphyIsm, originLockbox, check } from './saphan.js';

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
const ERRORS = new Interface(['HyperlaneLockBoxV2', 'HyperlaneLane', 'BridgeAirlock', 'BridgeGuard'].flatMap((n) => art(n).abi.filter((f) => f.type === 'error')));
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

main().then(() => process.exit(0), (e) => { console.error(`dry run FAILED: ${e.shortMessage ?? e.message}`); process.exit(1); });
