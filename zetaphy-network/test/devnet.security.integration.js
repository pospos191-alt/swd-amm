// The security core on a real ZETAPHY chain (zetaphyd built from
// zetaphy-chain/setup-node.sh; 1 s blocks, 20 s votes): governance turns the
// rules on with gov.sh, and wallets meet them the way users would.
//   1. threat gate: a MetaMask-style tx and a MsgEVMCall to a contract with an
//      enforced flag are refused with a clear error; consent (one tx to the
//      security precompile 0x…0901) lets the same sender through; a cleared
//      flag needs none;
//   2. Q-day: before it, a MetaMask account quantum-locks itself, and the
//      new ML-DSA-44 account of a key never used on chain records a
//      commitment; after it, ECDSA-signed EVM and Cosmos txs are refused,
//      ecrecover answers nothing, the locked account still moves its funds
//      through its controller, the unused key migrates by reveal, and a key
//      used before Q-day cannot.
// Needs a zetaphyd with the security core: ZETAPHYD=/path/to/zetaphyd npm run test:devnet:security

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, ContractFactory, Contract, Interface, SigningKey, keccak256, parseEther, hexlify } from 'ethers';
import solc from 'solc';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { pqAddress, pqClient, quantumLockTx, consentCall, parseThreatRefusal, normalizeAddress, SECURITY_PRECOMPILE } from '../src/pqtx.js';
import { qdayMigration } from '../src/securitycli.js';

const ZETAPHYD = process.env.ZETAPHYD || 'zetaphyd';
const PORT = 24545; // EVM JSON-RPC; scripts/devnet.sh also uses +1 and +100..+103
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 'zetaphy-local-1';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-security-'));
const chainHome = join(root, 'chain');
// deployer: contracts; mm: a MetaMask account that quantum-locks itself;
// sleeper: funded at genesis, never sends a tx; used: sends one tx before Q-day.
const actors = Object.fromEntries(['deployer', 'mm', 'sleeper', 'used', 'other'].map((n) => [n, Wallet.createRandom()]));
const env = { ...process.env, ZETAPHYD, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const govEnv = { ...env, NODE_HOME: chainHome, KEYS_DIR: chainHome, NODE: `tcp://127.0.0.1:${PORT + 100}`, CHAIN_ID, EVM_RPC: RPC, QDAY_MIN_NOTICE: '30' };
const gov = (...a) => execFileSync(new URL('../../zetaphy-chain/gov.sh', import.meta.url).pathname, a, { env: govEnv, encoding: 'utf8' });
let provider, client;

const pqKey = (b) => {
  const k = ml_dsa44.keygen(new Uint8Array(32).fill(b));
  return { publicKey: k.publicKey, sign: (m) => ml_dsa44.sign(m, k.secretKey), addr: pqAddress(k.publicKey) };
};
const user = pqKey(41); const ctrlMM = pqKey(42); const ctrlSleeper = pqKey(43); const ctrlUsed = pqKey(44);

async function passed(out) {
  const id = /proposal (\d+) submitted/.exec(out)?.[1];
  assert.ok(id, out);
  assert.match(gov('vote', id, 'yes'), /voted yes/);
  let st;
  for (let i = 0; i < 60; i++) {
    st = JSON.parse(gov('status', id));
    if (st.status !== 'PROPOSAL_STATUS_VOTING_PERIOD' && st.status !== 'PROPOSAL_STATUS_DEPOSIT_PERIOD') break;
    await sleep(1000);
  }
  const full = JSON.parse(execFileSync(ZETAPHYD, ['q', 'gov', 'proposal', id, '--node', govEnv.NODE, '-o', 'json'], { env, encoding: 'utf8' })).proposal;
  assert.equal(st.status, 'PROPOSAL_STATUS_PASSED', `proposal ${id}: ${st.status} ${full.failed_reason ?? ''}`);
}

const SRC = `pragma solidity ^0.8.0;
contract MockThreatRegistry { mapping(address => uint8) public reasonOf;
  function set(address a, uint8 r) external { reasonOf[a] = r; }
  function isContractEnforced(address a) external view returns (bool, uint8) { return (reasonOf[a] != 0, reasonOf[a]); } }
contract Target { uint256 public hits; function poke() external payable { hits++; } }`;
function compile(name) {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'S.sol': { content: SRC } },
    settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const c = out.contracts['S.sol'][name];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}
const deploy = async (name, w) => {
  const { abi, bytecode } = compile(name);
  const c = await new ContractFactory(abi, bytecode, w.connect(provider)).deploy();
  await c.waitForDeployment();
  return c;
};
/** A tx that must be refused, by the node at submission or in its block. */
async function refused(p, re) {
  let err;
  try { const tx = await p; const rc = await tx.wait().catch((e) => e.receipt); if (rc && rc.status === 1) assert.fail('the tx went through'); } catch (e) { err = e; }
  assert.ok(err, 'refused');
  assert.match(String(err.error?.message ?? err.info?.error?.message ?? err.shortMessage ?? err.message), re);
  return err;
}
// Signed here and followed by its hash: right after the chain starts, the
// node can answer "nonce too low" for this very transaction (it already took
// it), so that reply is not a failure; the receipt decides.
async function fund(to, amount = '20') {
  const w = actors.deployer.connect(provider);
  const raw = await w.signTransaction(await w.populateTransaction({ to, value: parseEther(amount) }));
  try { await provider.broadcastTransaction(raw); } catch (e) { if (e.code !== 'NONCE_EXPIRED') throw e; }
  const r = await provider.waitForTransaction(keccak256(raw), 1, 60_000);
  if (r?.status !== 1) throw new Error(`funding ${to} failed`);
  return r;
}
const nextBlock = (n = 2) => sleep(1300 * n);
async function height() { return Number(await provider.getBlockNumber()); }
/** A Cosmos tx's result in its block (code, raw_log), once it is in one. */
async function txResult(hash) {
  for (let i = 0; i < 30; i++) {
    try {
      return JSON.parse(execFileSync(ZETAPHYD, ['q', 'tx', hash, '--node', govEnv.NODE, '-o', 'json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch { await sleep(1000); }
  }
  throw new Error(`tx ${hash} not found`);
}

before(async () => {
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname, [chainHome, String(PORT), ...Object.values(actors).map((w) => w.address)],
    { stdio: 'inherit', env });
  provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, polling: true, pollingInterval: 500 });
  client = pqClient((m, p) => provider.send(m, p), { chainId: CHAIN_ID });
  // ML-DSA-44 accounts, each with its key on chain (a first tx), so they can be controllers.
  for (const k of [user, ctrlMM, ctrlSleeper, ctrlUsed]) await fund(k.addr.hex);
  for (const k of [user, ctrlMM, ctrlSleeper, ctrlUsed]) {
    await client.send({ publicKey: k.publicKey, sign: k.sign, to: k.addr.bech32, amount: 1n });
  }
  await nextBlock();
});

after(async () => {
  try { process.kill(Number(readFileSync(join(chainHome, 'node.pid'), 'utf8'))); } catch { /* gone */ }
  await sleep(1000);
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test('the security core is on from block 1, every rule off', async () => {
  const st = await client.securityStatus();
  assert.equal(Number(st.securityCoreFrom), 1);
  assert.equal(Number(st.qdayHeight), 0);
  assert.equal(st.threatGateEnabled, false);
  assert.deepEqual(st.ibcHoldRules, []);
  assert.match(gov('security'), /"qdayHeight": 0/);
});

test('threat gate: refused without consent, allowed with it, a cleared flag needs none', { timeout: 300_000 }, async () => {
  const registry = await deploy('MockThreatRegistry', actors.deployer);
  const target = await deploy('Target', actors.deployer);
  const T = await target.getAddress(); const R = await registry.getAddress();
  await (await registry.set(T, 6)).wait();
  // Gate off: the flag alone stops nothing.
  await (await target.connect(actors.mm.connect(provider)).poke()).wait();

  await passed(gov('threat-gate', R, 'on'));
  const st = await client.securityStatus();
  assert.equal(st.threatGateEnabled, true);
  assert.equal(st.threatRegistry.toLowerCase(), R.toLowerCase());

  // MetaMask-style EVM tx: refused at submission with a readable reason.
  const other = target.connect(actors.other.connect(provider));
  const err = await refused(other.poke(), /enforced flag in the Neuro threat registry/);
  const r = parseThreatRefusal(String(err.error?.message ?? err.info?.error?.message ?? err.message));
  assert.equal(r.target.toLowerCase(), T.toLowerCase());
  assert.equal(r.reason, 'SweepsApprovedTokens');
  // Consent: one EVM tx to the security precompile, then the same call goes through.
  const c = consentCall(T, 600);
  await (await actors.other.connect(provider).sendTransaction({ to: c.to, data: hexlify(c.data) })).wait();
  await nextBlock(1); // the node's pending nonce follows the new block
  const sec = new Contract(SECURITY_PRECOMPILE, ['function consentUntil(address,address) view returns (uint64)'], provider);
  assert.ok((await sec.consentUntil(actors.other.address, T)) > BigInt(Math.floor(Date.now() / 1000)));
  await (await other.poke()).wait();
  assert.equal(await target.hits(), 2n);

  // An ML-DSA-44 account (MsgEVMCall) meets the same gate.
  const data = target.interface.encodeFunctionData('poke');
  await assert.rejects(client.callEVM({ publicKey: user.publicKey, sign: user.sign, to: T, data, check: false }), /enforced flag/);
  await client.consent({ publicKey: user.publicKey, sign: user.sign, target: T, seconds: 600n });
  await nextBlock();
  assert.ok((await client.consentUntil(user.addr.hex, T)) > 0n);
  await client.callEVM({ publicKey: user.publicKey, sign: user.sign, to: T, data, check: false });
  await nextBlock();
  assert.equal(await target.hits(), 3n);

  // Cleared flag: no consent needed (actors.mm never consented).
  await (await registry.set(T, 0)).wait();
  await (await target.connect(actors.mm.connect(provider)).poke()).wait();
  assert.equal(await target.hits(), 4n);
});

test('Q-day: ECDSA refused, the locked account moves through its controller, an unused key migrates by commit–reveal', { timeout: 600_000 }, async () => {
  // Before Q-day: mm locks itself (MetaMask tx), the "used" account sends a tx,
  // and the sleeper's new ML-DSA-44 account commits (the sleeper's key signs only locally).
  const lock = quantumLockTx(ctrlMM.addr.hex);
  await (await actors.mm.connect(provider).sendTransaction({ to: lock.to, value: 0n, data: lock.data })).wait();
  assert.equal((await client.migration(actors.mm.address)).controller, ctrlMM.addr.bech32);
  await fund(actors.other.address, '1'); // (deployer's own nonce moves on)
  await (await actors.used.connect(provider).sendTransaction({ to: actors.other.address, value: 1n })).wait();
  const sleeperMig = await qdayMigration({ ecdsaWallet: actors.sleeper, controller: ctrlSleeper.addr.hex, chainId: CHAIN_ID });
  await client.qdayCommit({ publicKey: ctrlSleeper.publicKey, sign: ctrlSleeper.sign, commitment: sleeperMig.commitment });
  const usedMig = await qdayMigration({ ecdsaWallet: actors.used, controller: ctrlUsed.addr.hex, chainId: CHAIN_ID });
  await client.qdayCommit({ publicKey: ctrlUsed.publicKey, sign: ctrlUsed.sign, commitment: usedMig.commitment });
  await nextBlock();
  assert.equal((await client.commitmentHeight(sleeperMig.commitment)).found, true);
  const m0 = await client.migration(actors.sleeper.address);
  assert.equal(m0.exposed, false);
  assert.equal(m0.canCommitReveal, true);
  assert.equal((await client.migration(actors.used.address)).exposed, true);

  // Governance schedules Q-day (the last vote an ECDSA validator key can cast).
  const qday = (await height()) + 45;
  await passed(gov('qday', String(qday), '3'));
  assert.equal(Number((await client.securityStatus()).qdayHeight), qday);
  // Not yet: ECDSA still works.
  await (await actors.deployer.connect(provider).sendTransaction({ to: actors.other.address, value: 1n })).wait();
  while ((await height()) < qday) await sleep(1000);
  await nextBlock();
  assert.equal((await client.securityStatus()).qdayActive, true);

  // EVM tx signed by ECDSA: refused at submission.
  await refused(actors.deployer.connect(provider).sendTransaction({ to: actors.other.address, value: 1n }), /Q-day/);
  // Cosmos tx signed by an ECDSA key (the validator's): refused.
  const out = JSON.parse(execFileSync(ZETAPHYD, ['tx', 'bank', 'send', 'validator', normalizeAddress(actors.other.address).bech32, '1azetaphy',
    '--keyring-backend', 'test', '--home', chainHome, '--chain-id', CHAIN_ID, '--node', govEnv.NODE, '--gas', '200000',
    '--gas-prices', '1000000000azetaphy', '-y', '-o', 'json'], { env, encoding: 'utf8' }).trim().split('\n').pop());
  assert.notEqual(out.code, 0);
  assert.match(out.raw_log, /Q-day/);
  // Contract-checked ECDSA signatures prove nothing any more.
  const h = keccak256('0x1234'); const sig = new SigningKey(actors.other.privateKey).sign(h);
  const input = h + sig.v.toString(16).padStart(64, '0') + sig.r.slice(2) + sig.s.slice(2);
  assert.equal(await provider.call({ to: '0x0000000000000000000000000000000000000001', data: input }), '0x');

  // The locked MetaMask account still moves its funds, through its controller.
  const dest = Wallet.createRandom().address;
  await client.send({ publicKey: ctrlMM.publicKey, sign: ctrlMM.sign, to: dest, amount: parseEther('2'), asOwner: actors.mm.address });
  await nextBlock();
  assert.equal(await provider.getBalance(dest), parseEther('2'));

  // The key never used on chain: reveal (step 2), then the wait, then it is the controller's.
  await client.qdayReveal({ publicKey: ctrlSleeper.publicKey, sign: ctrlSleeper.sign, owner: actors.sleeper.address,
    controller: ctrlSleeper.addr.hex, salt: sleeperMig.salt, signature: sleeperMig.signature });
  await nextBlock();
  const pending = await client.migration(actors.sleeper.address);
  assert.equal(pending.pendingController, ctrlSleeper.addr.bech32);
  while ((await height()) < Number(pending.pendingFinalHeight)) await sleep(1000);
  await nextBlock();
  assert.equal((await client.migration(actors.sleeper.address)).controller, ctrlSleeper.addr.bech32);
  const dest2 = Wallet.createRandom().address;
  await client.send({ publicKey: ctrlSleeper.publicKey, sign: ctrlSleeper.sign, to: dest2, amount: parseEther('3'), asOwner: actors.sleeper.address });
  await nextBlock();
  assert.equal(await provider.getBalance(dest2), parseEther('3'));

  // A key used before Q-day: refused, the account stays frozen with its funds.
  const before = await provider.getBalance(actors.used.address);
  const r = await client.qdayReveal({ publicKey: ctrlUsed.publicKey, sign: ctrlUsed.sign, owner: actors.used.address,
    controller: ctrlUsed.addr.hex, salt: usedMig.salt, signature: usedMig.signature });
  const res = await txResult(r.txHash);
  assert.notEqual(res.code, 0);
  assert.match(res.raw_log, /used on chain before Q-day/);
  const m = await client.migration(actors.used.address);
  assert.equal(m.controller, null);
  assert.equal(m.pendingController, null);
  assert.equal(await provider.getBalance(actors.used.address), before);
});
