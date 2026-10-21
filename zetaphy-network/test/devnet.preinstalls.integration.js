// The standard EVM contracts every new ZETAPHY chain starts with, at their
// usual addresses (genesis app_state.evm.preinstalls, written by
// zetaphy-chain/setup-node.sh and scripts/devnet.sh):
//   - eth_getCode at each address is the canonical runtime code
//   - Multicall3 aggregate3 batches calls (one failing, allowed)
//   - the CREATE2 deployer (and the Safe singleton factory, same code) deploy
//     to the address CREATE2 predicts
//   - Permit2's EIP-712 domain uses this chain's id and its own address
//   - the EIP-2935 history contract, which the chain installs itself, is
//     still there and not in the list
// Needs the zetaphyd binary: ZETAPHYD=/path/to/zetaphyd npm run test:devnet:preinstalls

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Wallet, JsonRpcProvider, Contract, Interface, AbiCoder, keccak256, id, concat, zeroPadValue, toBeHex,
  getCreate2Address, getAddress, dataSlice,
} from 'ethers';

const PORT = 23545; // EVM JSON-RPC; scripts/devnet.sh also uses +1 and +100..+103
const RPC = `http://127.0.0.1:${PORT}`;
const EVM_CHAIN_ID = 77390n;
const root = mkdtempSync(join(tmpdir(), 'zetaphy-preinstalls-'));
const funder = Wallet.createRandom();
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };

const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const SAFE_FACTORY = '0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7';
const EIP2935 = '0x0000F90827F1C53a10cb7A02335B175320002935';
// Arachnid's deterministic deployment proxy, also the Safe singleton factory's code.
const PROXY_CODE = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
// keccak256 of the runtime code (cosmos/evm v0.7.3 x/vm/types.DefaultPreinstalls).
const CODE_HASH = {
  [CREATE2]: keccak256(PROXY_CODE),
  [SAFE_FACTORY]: keccak256(PROXY_CODE),
  [MULTICALL3]: '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
  [PERMIT2]: '0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131',
};

// The list setup-node.sh puts in genesis (the same one devnet.sh used).
const LIST = JSON.parse(execFileSync('bash',
  [new URL('../../zetaphy-chain/setup-node.sh', import.meta.url).pathname, '--preinstalls'], { encoding: 'utf8' }));
let provider, wallet;

before(async () => {
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname,
    [join(root, 'chain'), String(PORT), funder.address], { stdio: 'inherit', env });
  provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  wallet = funder.connect(provider);
});

after(() => {
  try { process.kill(Number(readFileSync(join(root, 'chain', 'node.pid'), 'utf8'))); } catch {}
});

test('the genesis list is the four standard contracts, without EIP-2935', () => {
  assert.deepEqual(LIST.map((p) => getAddress(p.address)), [CREATE2, MULTICALL3, PERMIT2, SAFE_FACTORY]);
  for (const p of LIST) assert.equal(keccak256(p.code), CODE_HASH[getAddress(p.address)], p.name);
  assert.equal(LIST[0].code.toLowerCase(), PROXY_CODE);
});

test('eth_getCode at each address is the canonical runtime code', async () => {
  for (const p of LIST) {
    const code = await provider.getCode(p.address);
    assert.equal(code.toLowerCase(), p.code.toLowerCase(), p.name);
    assert.equal(keccak256(code), CODE_HASH[getAddress(p.address)], p.name);
  }
  // The chain's own EIP-2935 install is unaffected.
  assert.notEqual(await provider.getCode(EIP2935), '0x');
});

test('Multicall3 aggregate3 batches calls', async () => {
  const mc = new Contract(MULTICALL3, [
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
    'function getChainId() view returns (uint256)',
    'function getEthBalance(address) view returns (uint256)',
    'function getBlockNumber() view returns (uint256)',
  ], provider);
  const i = mc.interface;
  const res = await mc.aggregate3.staticCall([
    { target: MULTICALL3, allowFailure: false, callData: i.encodeFunctionData('getChainId') },
    { target: MULTICALL3, allowFailure: false, callData: i.encodeFunctionData('getEthBalance', [funder.address]) },
    { target: MULTICALL3, allowFailure: false, callData: i.encodeFunctionData('getBlockNumber') },
    { target: PERMIT2, allowFailure: true, callData: '0xdeadbeef' }, // no such function: reverts, allowed
  ]);
  assert.equal(res.length, 4);
  assert.equal(i.decodeFunctionResult('getChainId', res[0].returnData)[0], EVM_CHAIN_ID);
  assert.equal(i.decodeFunctionResult('getEthBalance', res[1].returnData)[0], await provider.getBalance(funder.address));
  assert.ok(i.decodeFunctionResult('getBlockNumber', res[2].returnData)[0] > 0n);
  assert.equal(res[3].success, false);
  // A failure that is not allowed reverts the whole batch.
  await assert.rejects(mc.aggregate3.staticCall([{ target: PERMIT2, allowFailure: false, callData: '0xdeadbeef' }]));
});

// Init code that deploys a contract returning 42 (runtime 602a60005260206000f3).
const RUNTIME = '0x602a60005260206000f3';
const INIT = '0x69602a60005260206000f3600052600a6016f3';

for (const [name, factory] of [['CREATE2 deployer', CREATE2], ['Safe singleton factory', SAFE_FACTORY]]) {
  test(`a CREATE2 deploy through the ${name} lands at the predicted address`, { timeout: 60_000 }, async () => {
    const salt = zeroPadValue(toBeHex(BigInt(Date.now())), 32);
    const predicted = getCreate2Address(factory, salt, keccak256(INIT));
    assert.equal(await provider.getCode(predicted), '0x');
    const data = concat([salt, INIT]);
    // The proxy returns the new address (20 bytes).
    assert.equal(getAddress(await provider.call({ to: factory, data })), predicted);
    const r = await (await wallet.sendTransaction({ to: factory, data, gasLimit: 200_000 })).wait();
    assert.equal(r.status, 1);
    assert.equal(await provider.getCode(predicted), RUNTIME);
    assert.equal(BigInt(await provider.call({ to: predicted })), 42n);
    // Same salt again: the address is taken, so the proxy reverts.
    await assert.rejects(provider.call({ to: factory, data, from: funder.address }));
  });
}

test('Permit2 signs for this chain: DOMAIN_SEPARATOR uses chain id 77390', async () => {
  const p2 = new Contract(PERMIT2, ['function DOMAIN_SEPARATOR() view returns (bytes32)'], provider);
  const want = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'uint256', 'address'],
    [id('EIP712Domain(string name,uint256 chainId,address verifyingContract)'), id('Permit2'), EVM_CHAIN_ID, PERMIT2]));
  assert.equal(await p2.DOMAIN_SEPARATOR(), want);
  // allowance() of a fresh owner is zero (storage starts empty).
  const a = new Interface(['function allowance(address,address,address) view returns (uint160,uint48,uint48)']);
  const out = await provider.call({ to: PERMIT2, data: a.encodeFunctionData('allowance', [funder.address, MULTICALL3, CREATE2]) });
  assert.deepEqual([...a.decodeFunctionResult('allowance', out)], [0n, 0n, 0n]);
  assert.equal(dataSlice(out, 0, 32), zeroPadValue('0x', 32));
});
