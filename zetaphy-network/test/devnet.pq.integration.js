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
import { Wallet, JsonRpcProvider, ContractFactory, Contract, NonceManager, Interface, SigningKey, concat, getBytes, hexlify, parseEther, keccak256, toBeHex, zeroPadValue, ZeroAddress, getCreateAddress } from 'ethers';
import solc from 'solc';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { pqAddress, pqClient, encodeTxBody, encodeMsgSend, encodeAuthInfo, encodeSignDoc, encodeTxRaw, bytesToHex, MSG_SEND_TYPE_URL,
  encodeAny, encodePubKey, encodeModeInfoSingle, encodeFee, varint, msgSend, msgEVMDeploy, msgQuantumLock, quantumLockTx, stakingCall, PQ_LOCK_ADDRESS } from '../src/pqtx.js';

const PORT = 18845;
const RPC = `http://127.0.0.1:${PORT}`;
const MLDSA = '0x0000000000000000000000000000000000000900';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-pq-'));
// olga and pete are ECDSA (MetaMask-like) accounts for the quantum-lock tests; erin
// creates contracts both ways (Cosmos MsgEVMCall and EVM tx).
const actors = Object.fromEntries(['deployer', 'alice', 'carol', 'olga', 'pete', 'erin'].map((n) => [n, Wallet.createRandom()]));
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

// ---- Contract creation, quantum lock and as_owner ----
// gina: an ML-DSA-44 account that becomes the controller of olga (an ECDSA,
// MetaMask-like account); hank: a third ML-DSA-44 account.

const seedFile = (n, b) => {
  mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, n, 'pq.seed'), '0x' + Buffer.alloc(32, b).toString('hex') + '\n', { mode: 0o600 });
  const k = ml_dsa44.keygen(Buffer.alloc(32, b));
  return { publicKey: k.publicKey, sign: (m) => ml_dsa44.sign(m, k.secretKey), addr: pqAddress(k.publicKey) };
};
const gina = seedFile('gina', 11);
const hank = seedFile('hank', 12);
const lockState = {}; // filled as the tests below go: rec contract, token
const devClient = () => pqClient((m, p) => provider.send(m, p), { chainId: 'zetaphy-local-1' });
/** A tiny contract whose view rec() returns Solidity's ecrecover(h, v, r, s). */
const REC_SRC = 'pragma solidity ^0.8.0; contract Rec { function rec(bytes32 h, uint8 v, bytes32 r, bytes32 s) external pure returns (address) { return ecrecover(h, v, r, s); } }';
const REC = new Interface(['function rec(bytes32 h, uint8 v, bytes32 r, bytes32 s) view returns (address)']);
function compileRec() {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Rec.sol': { content: REC_SRC } },
    settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
  const c = out.contracts['Rec.sol'].Rec.evm;
  return { bytecode: '0x' + c.bytecode.object, runtime: '0x' + c.deployedBytecode.object };
}
/** What rec() returns for `wallet`'s signature over keccak256(text). */
async function recovered(rec, wallet, text) {
  const h = keccak256(Buffer.from(text));
  const sig = new SigningKey(wallet.privateKey).sign(h);
  return REC.decodeFunctionResult('rec', await provider.call({ to: rec, data: REC.encodeFunctionData('rec', [h, sig.v, sig.r, sig.s]) }))[0];
}
/** An EVM tx that the chain must refuse at submission, with an error naming the lock. */
async function refusedEvm(raw, nonceOf) {
  const nonce = await provider.getTransactionCount(nonceOf, 'latest');
  let hash;
  try {
    hash = await provider.send('eth_sendRawTransaction', [raw]);
  } catch (e) {
    const m = e.error?.message ?? e.message;
    assert.match(m, /quantum-locked/);
    assert.equal(await provider.getTransactionCount(nonceOf, 'latest'), nonce, 'the nonce did not move');
    return m;
  }
  assert.fail(`eth_sendRawTransaction accepted ${hash}: it must refuse a quantum-locked key at submission`);
}
/** A Cosmos tx signed with an ECDSA (eth_secp256k1) key, as Cosmos wallets for Cosmos EVM do; its CheckTx result. */
async function ecdsaCosmosTx(wallet, messages, gasLimit = 300000n) {
  const acct = await provider.send('zetaphy_pqAccount', [wallet.address]);
  const sk = new SigningKey(wallet.privateKey);
  const lenDelim = (f, b) => Uint8Array.from([(f << 3) | 2, ...varint(b.length), ...b]);
  const bodyBytes = encodeTxBody({ messages });
  const pubAny = encodeAny('/cosmos.evm.crypto.v1.ethsecp256k1.PubKey', encodePubKey(getBytes(sk.compressedPublicKey)));
  const seq = BigInt(acct.sequence);
  const signerInfo = Uint8Array.from([...lenDelim(1, pubAny), ...lenDelim(2, encodeModeInfoSingle(1)), ...(seq ? [0x18, ...varint(seq)] : [])]);
  const price = BigInt(await provider.send('eth_gasPrice', [])) * 2n;
  const authInfoBytes = Uint8Array.from([...lenDelim(1, signerInfo), ...lenDelim(2, encodeFee({ amount: [{ denom: 'azetaphy', amount: String(gasLimit * price) }], gasLimit }))]);
  const sig = sk.sign(keccak256(encodeSignDoc({ bodyBytes, authInfoBytes, chainId: 'zetaphy-local-1', accountNumber: BigInt(acct.accountNumber) })));
  const r = await provider.send('zetaphy_sendCosmosTx', ['0x' + bytesToHex(encodeTxRaw({ bodyBytes, authInfoBytes, signatures: [getBytes(sig.r + sig.s.slice(2))] }))]);
  return { ...r, sequence: seq };
}
const ecdsaCosmosSend = (wallet, to, amount) => ecdsaCosmosTx(wallet, [msgSend({ from: wallet.address, to, amount })]);
const seqOf = async (addr) => BigInt((await provider.send('zetaphy_pqAccount', [addr])).sequence);

const createdIn = (res) => res.events.find((e) => e.type === 'zetaphy_evm_call')?.attributes.find((a) => a.key === 'created')?.value;

test('contract creation with MsgEVMCall (no "to"): at CREATE(sender, signed sequence + 1); deploys in a row and an EVM creation after it work', { timeout: 240_000 }, async () => {
  await (await new NonceManager(actors.deployer.connect(provider)).sendTransaction({ to: gina.addr.hex, value: parseEther('50') })).wait();
  const { bytecode, runtime } = compileRec();
  const deploy = async () => {
    const r = await cli('gina', ['pq', 'native', 'deploy', bytecode]);
    assert.equal(r.code, 0, r.out);
    const at = /created contract (0x[0-9a-fA-F]{40})/.exec(r.out)?.[1];
    assert.ok(at, r.out);
    const res = await waitTx(txHashIn(r.out));
    assert.equal(res.code, 0, res.log);
    assert.equal(createdIn(res), at, 'the chain created it where the CLI said');
    assert.equal(await provider.getCode(at), runtime);
    return { r, at };
  };
  // gina's first tx is signed with sequence 0: the contract is CREATE(gina, 1) and her sequence ends at 2.
  const first = await deploy();
  assert.equal(first.at, getCreateAddress({ from: gina.addr.hex, nonce: 1 }));
  assert.equal(await seqOf(gina.addr.bech32), 2n);
  // Right away a second one, with its eth_call preflight: signed with 2, at CREATE(gina, 3).
  const second = await deploy();
  assert.equal(second.at, getCreateAddress({ from: gina.addr.hex, nonce: 3 }));
  assert.equal(await seqOf(gina.addr.bech32), 4n);
  lockState.rec = first.at;
  console.log(first.r.out.trim());

  // An ECDSA account creates with MsgEVMCall (a Cosmos tx), then with an ordinary EVM
  // tx (as MetaMask would): the EVM tx gets the next nonce and its own address.
  const { erin } = actors;
  const c = await ecdsaCosmosTx(erin, [msgEVMDeploy({ sender: erin.address, initCode: bytecode, gasLimit: 1_000_000n })], 1_500_000n);
  assert.equal(c.code, 0, c.log);
  const cres = await waitTx(c.txHash);
  assert.equal(cres.code, 0, cres.log);
  const viaCosmos = createdIn(cres);
  assert.equal(viaCosmos, getCreateAddress({ from: erin.address, nonce: c.sequence + 1n }));
  assert.equal(await seqOf(erin.address), c.sequence + 2n);
  const nonce = await provider.getTransactionCount(erin.address, 'latest');
  assert.equal(BigInt(nonce), c.sequence + 2n, 'eth_getTransactionCount agrees');
  const evm = await (await erin.connect(provider).sendTransaction({ data: bytecode, nonce, gasLimit: 1_000_000n })).wait();
  assert.equal(evm.status, 1, 'the EVM creation after a MsgEVMCall creation failed');
  assert.equal(evm.contractAddress, getCreateAddress({ from: erin.address, nonce }));
  assert.notEqual(evm.contractAddress, viaCosmos);
  assert.equal(await provider.getCode(viaCosmos), runtime);
  assert.equal(await provider.getCode(evm.contractAddress), runtime);
});

test('quantum lock from an ECDSA key (EVM tx to 0x…5051): pqAccount, storage mirror, ecrecover; the owner\'s own txs are refused', { timeout: 240_000 }, async () => {
  const { olga, carol } = actors;
  const rec = lockState.rec;
  assert.ok(rec, 'needs the contract from the test above');
  // An ERC-20 balance for olga, to be moved by her controller later.
  const STABLE = JSON.parse(readFileSync(new URL('../artifacts/TestStable.json', import.meta.url), 'utf8'));
  const deployer = new NonceManager(actors.deployer.connect(provider));
  const token = await new ContractFactory(STABLE.abi, STABLE.bytecode, deployer).deploy('Lock USD', 'lUSD');
  await token.waitForDeployment();
  await (await token.faucet()).wait();
  await (await token.transfer(olga.address, 100_000000n)).wait();
  lockState.token = await token.getAddress();

  // Before the lock: ecrecover gives olga's address.
  assert.equal(await recovered(rec, olga, 'permit before'), olga.address);
  assert.equal((await provider.send('zetaphy_pqAccount', [olga.address])).quantumLockedTo, null);

  // The CLI asks for --yes before anything is sent; then locks with olga's worker.key.
  const no = await cli('olga', ['pq', 'native', 'lock-ecdsa', gina.addr.bech32]);
  assert.notEqual(no.code, 0, no.out);
  assert.match(no.out, /PERMANENT[\s\S]*run again with --yes/);
  const lock = await cli('olga', ['pq', 'native', 'lock-ecdsa', gina.addr.bech32, '--yes']);
  assert.equal(lock.code, 0, lock.out);
  assert.match(lock.out, new RegExp(`locked: ${olga.address} is controlled by ${gina.addr.bech32}`));
  assert.ok(!lock.out.includes(olga.privateKey.slice(2)), 'the key is never printed');
  console.log(lock.out.trim());

  const acct = await provider.send('zetaphy_pqAccount', [olga.address]);
  assert.equal(acct.quantumLockedTo, gina.addr.bech32);
  // The lock is mirrored in the EVM storage of 0x…5051: slot = owner, value = controller.
  assert.equal(await provider.getStorage(PQ_LOCK_ADDRESS, zeroPadValue(olga.address, 32)), zeroPadValue(gina.addr.hex, 32).toLowerCase());
  const info = await cli('gina', ['pq', 'native', '--as', olga.address]);
  assert.match(info.out, new RegExp(`quantum-locked to: ${gina.addr.bech32} \\(this account`));

  // ecrecover no longer accepts olga's signatures; other keys are unaffected.
  assert.equal(await recovered(rec, olga, 'permit after'), ZeroAddress);
  assert.equal(await recovered(rec, carol, 'permit after'), carol.address);

  // Her own key is refused: an EVM tx (as MetaMask would send) and a Cosmos tx.
  const bal = await provider.getBalance(olga.address);
  const nonce = await provider.getTransactionCount(olga.address, 'latest');
  const raw = await olga.signTransaction({ to: actors.deployer.address, value: parseEther('1'), nonce, gasLimit: 21000n, gasPrice: BigInt(await provider.send('eth_gasPrice', [])) * 2n, chainId: 77390n, type: 0 });
  console.log(`locked owner's EVM tx refused: ${await refusedEvm(raw, olga.address)}`);
  const cosmos = await ecdsaCosmosSend(olga, actors.deployer.address, 1000n);
  assert.notEqual(cosmos.code, 0, 'a Cosmos tx signed by the locked key was accepted');
  assert.match(cosmos.log, /quantum-locked/);
  // Another lock tx by the locked key is refused too (it cannot re-point itself).
  const relock = await olga.signTransaction({ ...quantumLockTx(hank.addr.hex), value: 0n, nonce, gasLimit: 100000n, gasPrice: BigInt(await provider.send('eth_gasPrice', [])) * 2n, chainId: 77390n, type: 0 });
  await refusedEvm(relock, olga.address);
  assert.equal(await provider.getBalance(olga.address), bal);
  assert.equal((await provider.send('zetaphy_pqAccount', [olga.address])).quantumLockedTo, gina.addr.bech32);
});

test('the controller acts for the locked account with as_owner: ZETAPHY, ERC-20, staking; a third account cannot', { timeout: 300_000 }, async () => {
  const olga = actors.olga.address;
  const as = async (...args) => {
    const r = await cli('gina', ['pq', 'native', ...args, '--as', olga]);
    assert.equal(r.code, 0, r.out);
    const res = await waitTx(txHashIn(r.out));
    assert.equal(res.code, 0, `${args.join(' ')}: ${res.log}`);
    return { ...r, res };
  };
  const to = Wallet.createRandom().address;
  const olgaBefore = await provider.getBalance(olga);
  const ginaBefore = await provider.getBalance(gina.addr.hex);
  const s = await as('send', to, '2');
  assert.equal(await provider.getBalance(to), parseEther('2'));
  assert.equal(await provider.getBalance(olga), olgaBefore - parseEther('2'), 'the value left olga; she paid no fee');
  assert.ok(await provider.getBalance(gina.addr.hex) < ginaBefore, 'gina paid the fee');
  console.log(s.out.trim());

  const token = new Contract(lockState.token, ['function balanceOf(address) view returns (uint256)'], provider);
  await as('token-send', lockState.token, to, '12.5');
  assert.equal(await token.balanceOf(to), 12_500000n);
  assert.equal(await token.balanceOf(olga), 87_500000n);

  const valoper = execFileSync(ZETAPHYD, ['keys', 'show', 'validator', '--bech', 'val', '-a', '--keyring-backend', 'test', '--home', join(root, 'chain')], { env }).toString().trim();
  const olgaBech = (await provider.send('zetaphy_pqAccount', [olga])).address;
  // A delegation through as_owner fits in a gas limit close to eth_estimateGas from the owner,
  // as it would in an EVM tx.
  const call = stakingCall({ action: 'delegate', delegator: olga, validator: valoper, amount: parseEther('1') });
  const estimate = await provider.estimateGas({ from: olga, to: call.to, data: hexlify(call.data) });
  const near = estimate * 12n / 10n;
  const d = await devClient().delegate({ ...gina, validator: valoper, amount: parseEther('1'), asOwner: olga, evmGasLimit: near, check: false });
  const dres = await waitTx(d.txHash);
  assert.equal(dres.code, 0, `as_owner delegate with EVM gas ${near} (eth_estimateGas ${estimate} + 20%): ${dres.log}`);
  assert.equal(delegated(olgaBech, valoper), parseEther('1'), 'olga is the delegator');
  // The CLI's default EVM gas for staking.
  const st = await as('stake', valoper, '4');
  assert.equal(delegated(olgaBech, valoper), parseEther('5'));
  assert.match(st.out, /through the staking precompile/);
  await sleep(3000);
  const rw = await as('rewards', valoper);
  assert.ok(rw.res.events?.some((e) => e.type === 'withdraw_rewards'), 'no withdraw_rewards event');
  await as('unstake', valoper, '2');
  assert.equal(delegated(olgaBech, valoper), parseEther('3'));

  // A contract created as olga: CREATE(olga, olga's sequence), which she never signed for.
  const olgaSeq = await seqOf(olga);
  const dep = await as('deploy', compileRec().bytecode);
  const made = /created contract (0x[0-9a-fA-F]{40})/.exec(dep.out)[1];
  assert.equal(made, getCreateAddress({ from: olga, nonce: olgaSeq }));
  assert.equal(createdIn(dep.res), made);
  assert.notEqual(await provider.getCode(made), '0x');

  // hank controls nothing: the CLI refuses before signing, and the chain refuses a tx sent anyway.
  await (await new NonceManager(actors.deployer.connect(provider)).sendTransaction({ to: hank.addr.hex, value: parseEther('20') })).wait();
  const h = await cli('hank', ['pq', 'native', 'send', to, '1', '--as', olga]);
  assert.notEqual(h.code, 0, h.out);
  assert.match(h.out, new RegExp(`quantum-locked to ${gina.addr.bech32}, not to ${hank.addr.bech32}`));
  const r = await devClient().send({ ...hank, to, amount: parseEther('1'), asOwner: olga, check: false });
  const res = await waitTx(r.txHash);
  assert.notEqual(res.code, 0, 'a third account acted for the locked account');
  assert.match(res.log, /does not control this account/);
  assert.equal(await provider.getBalance(to), parseEther('2'));
});

test('a lock to a non-ML-DSA controller fails; a handover by the wrong signer fails; the controller hands over', { timeout: 240_000 }, async () => {
  const { pete, olga, deployer } = actors;
  // The CLI checks the controller before sending anything.
  const c = await cli('pete', ['pq', 'native', 'lock-ecdsa', deployer.address, '--yes']);
  assert.notEqual(c.code, 0, c.out);
  assert.match(c.out, /no ML-DSA-44 public key on chain|not an ML-DSA-44 account/);
  // Sent anyway: an ECDSA controller, an address with no account, the owner itself, 19 bytes of data, a value.
  const w = new NonceManager(pete.connect(provider)); // back-to-back txs: the node's pending nonce can lag
  const fresh = Wallet.createRandom().address;
  for (const [what, tx] of [['ECDSA controller', quantumLockTx(deployer.address)], ['unknown controller', quantumLockTx(fresh)],
    ['itself', quantumLockTx(pete.address)], ['19 bytes', { to: PQ_LOCK_ADDRESS, value: 0n, data: '0x' + bytesToHex(gina.addr.bytes.slice(1)) }],
    ['with value', { ...quantumLockTx(gina.addr.hex), value: 1n }]]) {
    const sent = await w.sendTransaction({ ...tx, gasLimit: 100000n });
    const rc = await sent.wait().catch((e) => e.receipt);
    assert.equal(rc?.status, 0, `lock with ${what} succeeded`);
  }
  assert.equal((await provider.send('zetaphy_pqAccount', [pete.address])).quantumLockedTo, null);
  // pete is still free to use his key.
  await (await w.sendTransaction({ to: fresh, value: 1n })).wait();

  // An ML-DSA-44 account cannot be locked: it is post-quantum already.
  const client = devClient();
  const self = await client.sendMsgs({ ...gina, messages: [msgQuantumLock({ signer: gina.addr.bech32, owner: gina.addr.bech32, controller: hank.addr.bech32 })] });
  const selfRes = await waitTx(self.txHash);
  assert.notEqual(selfRes.code, 0, 'an ML-DSA-44 account was quantum-locked');
  assert.match(selfRes.log, /post-quantum already/);
  assert.equal((await provider.send('zetaphy_pqAccount', [gina.addr.bech32])).quantumLockedTo, null);

  // Handover: hank is not olga's controller.
  const bad = await client.quantumLockHandover({ ...hank, owner: olga.address, controller: hank.addr.bech32, check: false });
  const badRes = await waitTx(bad.txHash);
  assert.notEqual(badRes.code, 0, 'a handover by the wrong signer was accepted');
  assert.match(badRes.log, /only the current controller/);
  assert.equal((await provider.send('zetaphy_pqAccount', [olga.address])).quantumLockedTo, gina.addr.bech32);

  // gina hands olga to hank.
  const h = await cli('gina', ['pq', 'native', 'handover', olga.address, hank.addr.bech32]);
  assert.equal(h.code, 0, h.out);
  assert.equal((await waitTx(txHashIn(h.out))).code, 0);
  assert.equal((await provider.send('zetaphy_pqAccount', [olga.address])).quantumLockedTo, hank.addr.bech32);
  assert.equal(await provider.getStorage(PQ_LOCK_ADDRESS, zeroPadValue(olga.address, 32)), zeroPadValue(hank.addr.hex, 32).toLowerCase());
  console.log(h.out.trim());
  // Now gina is refused and hank acts.
  const to = Wallet.createRandom().address;
  const old = await client.send({ ...gina, to, amount: 1n, asOwner: olga.address, check: false });
  assert.notEqual((await waitTx(old.txHash)).code, 0, 'the old controller still acts');
  const r = await cli('hank', ['pq', 'native', 'send', to, '0.5', '--as', olga.address]);
  assert.equal(r.code, 0, r.out);
  assert.equal((await waitTx(txHashIn(r.out))).code, 0);
  assert.equal(await provider.getBalance(to), parseEther('0.5'));
});

test('EIP-7702: an authorization signed by a locked key is refused, even in someone else\'s tx', { timeout: 120_000 }, async () => {
  const { olga, alice } = actors;
  const target = lockState.rec;
  const price = BigInt(await provider.send('eth_gasPrice', [])) * 2n;
  const setCode = async (authority, sender) => {
    const auth = await authority.authorize({ address: target, nonce: await provider.getTransactionCount(authority.address, 'latest'), chainId: 77390n });
    return sender.signTransaction({ type: 4, to: sender.address, value: 0n, authorizationList: [auth], nonce: await provider.getTransactionCount(sender.address, 'latest'),
      gasLimit: 200000n, maxFeePerGas: price, maxPriorityFeePerGas: 0n, chainId: 77390n });
  };
  // Control: an unlocked key's authorization works, so the refusal below is the lock's doing.
  const free = Wallet.createRandom();
  const ok = await provider.send('eth_sendRawTransaction', [await setCode(free, alice)]);
  const rc = await provider.waitForTransaction(ok, 1, 30_000);
  assert.equal(rc.status, 1);
  assert.equal(await provider.getCode(free.address), '0xef0100' + target.slice(2).toLowerCase(), 'delegated');
  // olga is locked: her authorization is refused even though alice sends and pays.
  console.log(`7702 tx with a locked authorization refused: ${await refusedEvm(await setCode(olga, alice), alice.address)}`);
  assert.equal(await provider.getCode(olga.address), '0x', 'no code was delegated for the locked account');
});
