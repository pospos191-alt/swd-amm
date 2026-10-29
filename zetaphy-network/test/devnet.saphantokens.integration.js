// Saphan token routes on a REAL ZETAPHY node (a zetaphyd devnet with the same genesis as the testnet): the native
// coin goes into a ZetaphyTokenVault through its ERC-20 precompile (0xEeee…EEeE, erc20 native_precompiles) and comes
// back out. What only a real chain shows: decimals() of the precompile, approve + transferFrom by a contract, the
// balance-delta check (no "fee on transfer"), and that the vault's native balance is the escrow.
// The Hyperlane side is the test kit (helpers/HyperlaneKit.sol): a Mailbox that checks a message-id multisig ISM
// with checkpoints signed here; the destination chain is not run (its synthetic is an address in the messages).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, ContractFactory, AbiCoder, NonceManager, parseEther, zeroPadValue, solidityPacked, keccak256 } from 'ethers';
import { kitArtifacts, messageIdMetadata, validator } from './helpers/hyperlanekit.js';
import { NATIVE_ERC20 } from '../src/saphan.js';

const ZP = 19645;
const Z = `http://127.0.0.1:${ZP}`;
const BASE = 84532;
const root = mkdtempSync(join(tmpdir(), 'zetaphy-saphantokens-'));
const W = Object.fromEntries(['gov', 'alice', 'relayer'].map((n) => [n, Wallet.createRandom()]));
const BOB = Wallet.createRandom().address;     // never sends a transaction: his balance moves only by what the vault pays
const SYN = Wallet.createRandom().address;     // the synthetic's address on the destination (not deployed here)
const HYP = validator(21);                     // Hyperlane's validator for the destination
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ERC20 = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)',
  'function allowance(address,address) view returns (uint256)'];
let zp;

before(() => {
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname, [join(root, 'z'), String(ZP), ...Object.values(W).map((w) => w.address)], { stdio: 'inherit', env });
  zp = new JsonRpcProvider(Z, undefined, { staticNetwork: true });
});
after(() => { try { process.kill(Number(readFileSync(join(root, 'z', 'node.pid'), 'utf8'))); } catch {} });

/** Waits for a transaction's receipt (status 1). The node answers "request timed out" for a receipt while a block
 *  is being committed; that is a "not yet", not an error. */
async function mined(txOrPromise) {
  const tx = await txOrPromise;
  for (let i = 0; i < 240; i++) {
    let r = null;
    try { r = await zp.getTransactionReceipt(tx.hash); } catch (e) { if (!/timed out/.test(e.message)) throw e; }
    if (r) {
      if (r.status !== 1) throw new Error(`reverted: ${tx.hash}`);
      // the receipt can be indexed before the app commits that block: wait until its state is readable,
      // so the balance checks below never see the block before it
      for (let j = 0; j < 120; j++) {
        try { await zp.getBalance(tx.from, r.blockNumber); return r; } catch {}
        await new Promise((ok) => setTimeout(ok, 250));
      }
      return r;
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error(`not mined: ${tx.hash}`);
}

test('the native coin through its ERC-20 precompile: lock into the vault, release back after a verified message', { timeout: 300_000 }, async () => {
  const s = Object.fromEntries(Object.entries(W).map(([n, w]) => [n, new NonceManager(w.connect(zp))]));
  const kit = kitArtifacts();
  const deploy = async (a, args, who = 'gov') => { const k = await new ContractFactory(a.abi, a.bytecode, s[who]).deploy(...args); await mined(k.deploymentTransaction()); return k; };
  const mailbox = await deploy(kit.KitMailbox, [77390]);
  const ism = await deploy(kit.KitMessageIdMultisigIsm, [[HYP.address], 1]);
  const native = new Contract(NATIVE_ERC20, ERC20, zp);
  assert.equal(await native.decimals(), 18n, 'the precompile answers decimals()');
  const V = art('ZetaphyTokenVault');
  const cfg = [await mailbox.getAddress(), BASE, BigInt(BASE), zeroPadValue(SYN, 32), '0x' + '00'.repeat(20), NATIVE_ERC20, await ism.getAddress(), W.gov.address,
    W.gov.address, parseEther('100'), 0];
  await assert.rejects(deploy(V, [cfg, 6, parseEther('1000'), '0x' + '00'.repeat(20)]));        // decimals other than the precompile's: refused
  s.gov.reset();                                                                                  // the NonceManager counted the refused one
  const vault = await deploy(V, [cfg, 18, parseEther('1000'), '0x' + '00'.repeat(20)]);
  const va = await vault.getAddress();
  await mined(await vault.unpause());

  // lock: approve through the precompile, then the vault pulls the coins with transferFrom
  await mined(await native.connect(s.alice).approve(va, parseEther('5')));
  assert.equal(await native.allowance(W.alice.address, va), parseEther('5'));
  const before = await zp.getBalance(W.alice.address);
  const rc = await mined(await vault.connect(s.alice).lock(BOB, parseEther('5')));
  const gas = rc.gasUsed * rc.gasPrice;
  assert.equal(before - (await zp.getBalance(W.alice.address)), parseEther('5') + gas, 'alice paid 5 ZETAPHY (and gas)');
  assert.equal(await zp.getBalance(va), parseEther('5'), "the vault's native balance is the escrow");
  assert.equal(await native.balanceOf(va), parseEther('5'));
  assert.equal(await vault.locked(), parseEther('5'));
  // the message it dispatched: 288 bytes naming the destination, the synthetic and the native token
  const m = await mailbox.lastMessage();
  const body = AbiCoder.defaultAbiCoder().decode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address', 'address'], '0x' + m.slice(2 + 77 * 2));
  assert.deepEqual([body[0], body[1], body[4], body[5], body[6], body[7], body[8]], [77390n, va, BOB, parseEther('5'), BigInt(BASE), SYN, NATIVE_ERC20]);
  await assert.rejects(vault.connect(s.alice).lock(BOB, parseEther('1')));                     // the allowance is used up
  s.alice.reset();

  // back: a burn on the destination (here: a message as the destination's Mailbox would carry it), signed by its validator
  const release = AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address', 'address'],
    [BigInt(BASE), SYN, 0n, W.alice.address, BOB, parseEther('2'), 77390n, va, NATIVE_ERC20]);
  const msg = solidityPacked(['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'], [3, 0, BASE, zeroPadValue(SYN, 32), 77390, zeroPadValue(va, 32), release]);
  await assert.rejects(mailbox.connect(s.relayer).process(messageIdMetadata(msg, [validator(22)]), msg));   // not the destination's validator
  s.relayer.reset();
  await mined(await mailbox.connect(s.relayer).process(messageIdMetadata(msg, [HYP]), msg));
  await mined(await vault.connect(s.relayer).claim(keccak256(release)));
  assert.equal(await zp.getBalance(BOB), parseEther('2'), 'bob received 2 ZETAPHY as native coin');
  assert.equal(await zp.getBalance(va), parseEther('3'));
  assert.equal(await vault.locked(), parseEther('3'));
  // a forged release above the backing: recorded, never paid
  const big = AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address', 'address'],
    [BigInt(BASE), SYN, 1n, W.alice.address, BOB, parseEther('4'), 77390n, va, NATIVE_ERC20]);
  const msg2 = solidityPacked(['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'], [3, 1, BASE, zeroPadValue(SYN, 32), 77390, zeroPadValue(va, 32), big]);
  await mined(await mailbox.connect(s.relayer).process(messageIdMetadata(msg2, [HYP]), msg2));
  await assert.rejects(vault.connect(s.relayer).claim(keccak256(big)));
  s.relayer.reset();
  assert.equal(await zp.getBalance(va), parseEther('3'));
  // native coin sent straight to the vault (no receive function): refused, so the escrow is only what lock() took
  await assert.rejects(s.alice.sendTransaction({ to: va, value: 1n }));
});
