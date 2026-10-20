// Stage 5 on a real ZETAPHY chain built with the ML-DSA precompile patch
// (zetaphy-chain/setup-node.sh). Keys and signatures come from
// @noble/post-quantum (JavaScript); the chain verifies them with Cloudflare
// CIRCL (Go): two independent FIPS 204 implementations must agree.
//   ZETAPHYD=/path/to/patched/zetaphyd npm run test:devnet:pq

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, ContractFactory, NonceManager, concat, getBytes, hexlify, parseEther, keccak256, toBeHex } from 'ethers';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { pqAddress, pqClient, encodeTxBody, encodeMsgSend, encodeAuthInfo, encodeSignDoc, encodeTxRaw, bytesToHex, MSG_SEND_TYPE_URL } from '../src/pqtx.js';

const PORT = 18845;
const RPC = `http://127.0.0.1:${PORT}`;
const MLDSA = '0x0000000000000000000000000000000000000900';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-pq-'));
const actors = Object.fromEntries(['deployer', 'alice', 'carol'].map((n) => [n, Wallet.createRandom()]));
const bob = Wallet.createRandom().address;
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', ZETAPHY_CHAIN_ID: 'zetaphy-local-1' };
let provider;

function cli(actor, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args, '--rpc', RPC], {
      env: { ...env, ZETAPHY_HOME: join(root, actor) }, timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}

before(() => {
  for (const [n, w] of Object.entries(actors)) {
    mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, n, 'worker.key'), w.privateKey + '\n', { mode: 0o600 });
  }
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname,
    [join(root, 'chain'), String(PORT), ...Object.values(actors).map((w) => w.address)], { stdio: 'inherit', env: { ...env, PQ: '1', FAUCET: '1' } });
  provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
});
after(() => { try { process.kill(Number(readFileSync(join(root, 'chain', 'node.pid'), 'utf8'))); } catch {} });

test('the chain verifies ML-DSA-44 signatures made in JavaScript', async () => {
  const { publicKey, secretKey } = ml_dsa44.keygen(new Uint8Array(32).fill(9));
  const msg = getBytes(keccak256('0x1234'));
  const sig = ml_dsa44.sign(msg, secretKey);
  const input = (m, s) => hexlify(concat([toBeHex(44, 1), m, publicKey, s]));
  assert.equal(BigInt(await provider.call({ to: MLDSA, data: input(msg, sig) })), 1n);
  const bad = Uint8Array.from(sig); bad[5] ^= 1;
  assert.equal(await provider.call({ to: MLDSA, data: input(msg, bad) }), '0x');
  const other = Uint8Array.from(msg); other[0] ^= 1;
  assert.equal(await provider.call({ to: MLDSA, data: input(other, sig) }), '0x');
});

test('post-quantum-only wallet: receive before it exists, then send with ML-DSA', { timeout: 120_000 }, async () => {
  const d = await cli('deployer', ['deploy-pq']);
  assert.equal(d.code, 0, d.out);
  const factory = /QuantumWalletFactory (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  const a = await cli('alice', ['pq', 'new', '--pqFactory', factory]);
  assert.equal(a.code, 0, a.out);
  const wallet = /wallet: (0x[0-9a-fA-F]{40})/.exec(a.out)[1];
  assert.match(a.out, /post-quantum only/);
  assert.match(a.out, /not deployed yet/);

  const deployer = actors.deployer.connect(provider);
  await (await deployer.sendTransaction({ to: wallet, value: parseEther('5') })).wait();
  const s = await cli('alice', ['pq', 'send', bob, '1.5']);
  assert.equal(s.code, 0, s.out);
  assert.equal(await provider.getBalance(bob), parseEther('1.5'));
  assert.equal(await provider.getBalance(wallet), parseEther('3.5'));
  console.log(s.out.trim());
});

test('hybrid wallet: ML-DSA and ECDSA together', { timeout: 120_000 }, async () => {
  const factory = /QuantumWalletFactory (0x[0-9a-fA-F]{40})/.exec((await cli('deployer', ['deploy-pq'])).out)[1];
  const n = await cli('carol', ['pq', 'new', '--hybrid', '--pqFactory', factory]);
  assert.match(n.out, /hybrid/);
  const wallet = /wallet: (0x[0-9a-fA-F]{40})/.exec(n.out)[1];
  await (await actors.deployer.connect(provider).sendTransaction({ to: wallet, value: parseEther('2') })).wait();
  const s = await cli('carol', ['pq', 'send', bob, '0.5']);
  assert.equal(s.code, 0, s.out);
  assert.equal(await provider.getBalance(bob), parseEther('2'));
});

// Native PQ accounts: ordinary Cosmos transactions whose only key is
// ML-DSA-44 (no ECDSA anywhere, no gas payer), checked by the chain's ante
// handler and sent through zetaphy_sendCosmosTx on the public 8545 port.
test('native PQ account: send with ML-DSA only; forged, tampered and replayed txs are refused', { timeout: 180_000 }, async () => {
  const seed = (b) => '0x' + Buffer.alloc(32, b).toString('hex');
  for (const [n, b] of [['dave', 7], ['eve', 8]]) {
    mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, n, 'pq.seed'), seed(b) + '\n', { mode: 0o600 });
  }
  const dave = ml_dsa44.keygen(Buffer.alloc(32, 7));
  const eve = ml_dsa44.keygen(Buffer.alloc(32, 8));
  const daveAddr = pqAddress(dave.publicKey);
  const to = Wallet.createRandom().address;

  // Before it has funds the account does not exist.
  const empty = await cli('dave', ['pq', 'native']);
  assert.equal(empty.code, 0, empty.out);
  assert.match(empty.out, /send ZETAPHY to this address first/);

  await (await actors.deployer.connect(provider).sendTransaction({ to: daveAddr.hex, value: parseEther('10') })).wait();
  for (const amount of ['1', '0.25']) {
    const r = await cli('dave', ['pq', 'native', 'send', to, amount]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /signed with ML-DSA-44/);
    await new Promise((res) => setTimeout(res, 2500)); // next sequence needs the block
  }
  assert.equal(await provider.getBalance(to), parseEther('1.25'));
  const acct = await provider.send('zetaphy_pqAccount', [daveAddr.bech32]);
  assert.equal(acct.pubKeyType, 'mldsa44');
  assert.equal(acct.sequence, '2');

  // Hand-built txs from dave's account for the attacks below.
  const price = BigInt(await provider.send('eth_gasPrice', [])) * 2n;
  const build = ({ signer, key, sequence = BigInt(acct.sequence), tamper = false }) => {
    const bodyBytes = encodeTxBody({ messages: [{ typeUrl: MSG_SEND_TYPE_URL, value: encodeMsgSend({ fromAddress: daveAddr.bech32, toAddress: pqAddress(eve.publicKey).bech32, amount: [{ denom: 'azetaphy', amount: '1000' }] }) }] });
    const authInfoBytes = encodeAuthInfo({ signerInfos: [{ publicKey: signer.publicKey, sequence }], fee: { amount: [{ denom: 'azetaphy', amount: String(400000n * price) }], gasLimit: 400000n } });
    const sig = ml_dsa44.sign(encodeSignDoc({ bodyBytes, authInfoBytes, chainId: 'zetaphy-local-1', accountNumber: BigInt(acct.accountNumber) }), key.secretKey);
    if (tamper) sig[100] ^= 1;
    return '0x' + bytesToHex(encodeTxRaw({ bodyBytes, authInfoBytes, signatures: [sig] }));
  };
  const send = (hex) => provider.send('zetaphy_sendCosmosTx', [hex]);

  // Eve signs with her own key but claims dave's account: wrong key for the account.
  const forged = await send(build({ signer: eve, key: eve }));
  assert.notEqual(forged.code, 0, 'forged tx accepted');
  // Dave's key, but a flipped bit in the signature.
  const tampered = await send(build({ signer: dave, key: dave, tamper: true }));
  assert.notEqual(tampered.code, 0, 'tampered tx accepted');
  assert.match(tampered.log, /signature verification failed/);
  // A valid tx with an old sequence (a replay) is refused.
  const replay = await send(build({ signer: dave, key: dave, sequence: 0n }));
  assert.notEqual(replay.code, 0, 'replayed tx accepted');
  assert.match(replay.log, /sequence/);
  // Garbage is not passed on.
  await assert.rejects(send('0x1234'), /not a Cosmos transaction/);
  assert.equal(await provider.getBalance(to), parseEther('1.25'));
});

// Native PQ accounts beyond sends: EVM contract calls (/zetaphy.pq.v1.MsgEVMCall),
// ERC-20 transfers and staking, all signed with ML-DSA-44 only.
const ZETAPHYD = process.env.ZETAPHYD || 'zetaphyd';
const COMET = `http://127.0.0.1:${PORT + 100}`; // CometBFT RPC of the devnet (scripts/devnet.sh)
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const txHashIn = (out) => {
  const h = /tx hash: ([0-9A-F]{64})/.exec(out)?.[1];
  assert.ok(h, `no tx hash in: ${out}`);
  return h;
};
/** The block result of a Cosmos tx (CometBFT leaves code out when it is 0). */
async function waitTx(hash, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    try {
      const r = await (await fetch(`${COMET}/tx?hash=0x${hash}`)).json();
      if (r.result?.tx_result) return { ...r.result.tx_result, code: r.result.tx_result.code ?? 0 };
    } catch { /* not indexed yet */ }
  }
  throw new Error(`tx ${hash} is not in a block after ${ms} ms`);
}
const zetaphyd = (args) => JSON.parse(execFileSync(ZETAPHYD, [...args, '--node', `tcp://127.0.0.1:${PORT + 100}`, '-o', 'json'], { env }).toString());
const delegated = (delegator, valoper) => {
  try {
    const j = zetaphyd(['q', 'staking', 'delegation', delegator, valoper]);
    return BigInt((j.delegation_response ?? j).balance.amount);
  } catch { return 0n; }
};

test('native PQ account: ERC-20 token-send, call with value, stake, rewards, unstake; a reverting call moves nothing', { timeout: 300_000 }, async () => {
  mkdirSync(join(root, 'frank'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'frank', 'pq.seed'), '0x' + Buffer.alloc(32, 10).toString('hex') + '\n', { mode: 0o600 });
  const frank = ml_dsa44.keygen(Buffer.alloc(32, 10));
  const me = pqAddress(frank.publicKey);
  const native = async (...args) => {
    const r = await cli('frank', ['pq', 'native', ...args]);
    assert.equal(r.code, 0, r.out);
    const res = await waitTx(txHashIn(r.out)); // the next tx needs this one's sequence
    assert.equal(res.code, 0, `${args.join(' ')}: ${res.log}`);
    return { ...r, res };
  };

  // A tiny ERC-20 from an ECDSA actor; fund the PQ account with tokens and ZETAPHY.
  const STABLE = JSON.parse(readFileSync(new URL('../artifacts/TestStable.json', import.meta.url), 'utf8'));
  // NonceManager: right after a block the node's pending nonce can lag behind.
  const deployer = new NonceManager(actors.deployer.connect(provider));
  const token = await new ContractFactory(STABLE.abi, STABLE.bytecode, deployer).deploy('Test USD', 'tUSD');
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  await (await token.faucet()).wait(); // 1,000 tUSD to the deployer
  await (await token.transfer(me.hex, 100_000000n)).wait();
  await (await deployer.sendTransaction({ to: me.hex, value: parseEther('20') })).wait();

  const bal = await cli('frank', ['pq', 'native', 'token-balance', tokenAddr]);
  assert.equal(bal.code, 0, bal.out);
  assert.match(bal.out, /token tUSD at .* \(6 decimals\)/);
  assert.match(bal.out, /holds 100 tUSD/);

  // ERC-20 transfer from the PQ account: msg.sender is its 0x form.
  const to = Wallet.createRandom().address;
  const ts = await native('token-send', tokenAddr, to, '12.5');
  assert.match(ts.out, /sent 12\.5 tUSD/);
  assert.equal(await token.balanceOf(to), 12_500000n);
  assert.equal(await token.balanceOf(me.hex), 87_500000n);
  console.log(ts.out.trim());
  // More than it holds: refused by the eth_call check, nothing sent.
  const over = await cli('frank', ['pq', 'native', 'token-send', tokenAddr, to, '1000']);
  assert.notEqual(over.code, 0, over.out);
  assert.match(over.out, /would fail, so nothing was sent/);

  // A call with value to a plain address moves ZETAPHY.
  const plain = Wallet.createRandom().address;
  await native('call', plain, '0x', '--value', '0.75');
  assert.equal(await provider.getBalance(plain), parseEther('0.75'));

  // Stake with the devnet's validator, withdraw rewards, then unstake part.
  const valoper = execFileSync(ZETAPHYD, ['keys', 'show', 'validator', '--bech', 'val', '-a', '--keyring-backend', 'test', '--home', join(root, 'chain')], { env }).toString().trim();
  assert.match(valoper, /^zetaphyvaloper1/);
  const before = await provider.getBalance(me.hex);
  const st = await native('stake', valoper, '5');
  assert.equal(delegated(me.bech32, valoper), parseEther('5'));
  const after = await provider.getBalance(me.hex);
  assert.ok(before - after > parseEther('5') && before - after < parseEther('5.01'), `stake took ${before - after}`);
  console.log(st.out.trim());
  await sleep(3000); // a few blocks of fees to share out
  const rw = await native('rewards', valoper);
  assert.ok(rw.res.events?.some((e) => e.type === 'withdraw_rewards'), 'no withdraw_rewards event');
  await native('unstake', valoper, '2');
  assert.equal(delegated(me.bech32, valoper), parseEther('3'));

  // A call that reverts: sent past the eth_call check, the tx must fail in the
  // block and move nothing (only the fee is paid). TestStable.transfer is not
  // payable and the amount is more than the account holds.
  const client = pqClient((m, p) => provider.send(m, p), { chainId: 'zetaphy-local-1' });
  const sign = (b) => ml_dsa44.sign(b, frank.secretKey);
  const tokens = async () => [await token.balanceOf(me.hex), await token.balanceOf(to)];
  const tokensBefore = await tokens();
  const zBefore = await provider.getBalance(me.hex);
  const data = token.interface.encodeFunctionData('transfer', [to, 1_000_000_000n]);
  const r = await client.callEVM({ publicKey: frank.publicKey, sign, to: tokenAddr, data, value: parseEther('1'), check: false });
  const res = await waitTx(r.txHash);
  assert.notEqual(res.code, 0, 'a reverting call was accepted');
  console.log(`reverting call failed as it should: code ${res.code}, ${res.log}`);
  assert.deepEqual(await tokens(), tokensBefore);
  assert.equal(await provider.getBalance(tokenAddr), 0n);
  assert.equal(await provider.getBalance(me.hex), zBefore - r.fee, 'only the fee is paid');
});

// Testnet faucet (zetaphy_faucet): newcomers get 10 ZETAPHY once a day,
// by 0x or zetaphy1 address; rich addresses and repeats are refused.
test('faucet: 10 ZETAPHY once per address; repeats and rich addresses refused', { timeout: 60_000 }, async () => {
  const fresh = Wallet.createRandom().address;
  const r = await provider.send('zetaphy_faucet', [fresh]);
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  const pqNew = pqAddress(ml_dsa44.keygen(Buffer.alloc(32, 9)).publicKey);
  await provider.send('zetaphy_faucet', [pqNew.bech32]);
  await new Promise((res) => setTimeout(res, 3000));
  assert.equal(await provider.getBalance(fresh), parseEther('10'));
  assert.equal(await provider.getBalance(pqNew.hex), parseEther('10'));
  await assert.rejects(provider.send('zetaphy_faucet', [fresh]), /less than a day ago|already has/);
  await assert.rejects(provider.send('zetaphy_faucet', [actors.deployer.address]), /already has ZETAPHY/);
  await assert.rejects(provider.send('zetaphy_faucet', ['not-an-address']), /invalid address/);
});
