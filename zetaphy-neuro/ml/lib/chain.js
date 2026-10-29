// In-memory EVM for Neuro ML corpus building and the red team: compiles
// generated Solidity with solc, deploys it, lists it on the mock Uniswap-V2
// DEX from test/helpers/contracts.sol (placed at PancakeSwap's addresses, as
// in test/honeypot.test.js), and answers Neuro's read-only RPC calls, so
// readContract() + the buy/sell simulation run exactly as on mainnet.
// No network, no node, no Foundry. Dev dependencies only (solc, @ethereumjs).

import { readFileSync } from 'node:fs';
import solc from 'solc';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex, setLengthLeft } from '@ethereumjs/util';
import { selectorOf } from '../../scripts/keccak.js';

export const DEPLOYER = '0x1111111111111111111111111111111111111111';
const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** Compiles {file: content}; returns {ContractName: creationHex}. Throws on errors. */
export function compileSources(sources, { optimize = true } = {}) {
  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
    settings: { optimizer: { enabled: optimize, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) {
    const err = new Error(errors.map((e) => e.formattedMessage).join('\n'));
    err.solcErrors = errors;
    throw err;
  }
  const all = Object.values(out.contracts).flatMap((byName) => Object.entries(byName));
  return Object.fromEntries(all.map(([k, v]) => [k, v.evm.bytecode.object]));
}

let mockBins = null;
function mocks() {
  if (!mockBins) {
    const src = readFileSync(new URL('../../test/helpers/contracts.sol', import.meta.url), 'utf8');
    mockBins = compileSources({ 'contracts.sol': src });
  }
  return mockBins;
}

/**
 * @param opts.block  a fixed block environment for every call ({ number, timestamp } as bigint; the rest is
 *   zero): the red-vs-blue arena pins it (ml/redteam/sandbox.js) so independent runners get the same bytes.
 *   Without it EthereumJS uses its default block (all zero), which is also fixed.
 */
export async function createChain(opts = {}) {
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const block = opts.block ? { header: { number: BigInt(opts.block.number), timestamp: BigInt(opts.block.timestamp), coinbase: Address.zero(), difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n, getBlobGasPrice: () => 0n } } : undefined;
  const sm = evm.stateManager;
  const deployer = Address.fromString(DEPLOYER);

  async function fund(addressHex, wei) {
    const a = Address.fromString(addressHex);
    const acct = (await sm.getAccount(a)) ?? new Account();
    acct.balance = BigInt(wei);
    await sm.putAccount(a, acct);
  }
  await fund(DEPLOYER, 10n ** 30n);

  /** Runs creation code (+ ABI-encoded args) from the deployer; returns the new address. */
  async function deployCode(creationHex, argsHex = '') {
    const r = await evm.runCall({ caller: deployer, data: hexToBytes('0x' + creationHex.replace(/^0x/, '') + argsHex), gasLimit: 30_000_000n, block });
    if (r.execResult.exceptionError) throw new Error(`deploy: ${r.execResult.exceptionError.error}`);
    return r.createdAddress.toString();
  }

  /** A state-changing call from the deployer; args are 32-byte words (hex or bigint). */
  async function send(to, sig, args = [], value = 0n) {
    const data = '0x' + selectorOf(sig) + args.map((a) => (typeof a === 'bigint' ? a.toString(16).padStart(64, '0') : word(a))).join('');
    const r = await evm.runCall({ caller: deployer, to: Address.fromString(to), data: hexToBytes(data), value: BigInt(value), gasLimit: 30_000_000n, block });
    if (r.execResult.exceptionError) throw new Error(`${sig}: ${r.execResult.exceptionError.error}`);
    return bytesToHex(r.execResult.returnValue);
  }

  const getCode = async (a) => bytesToHex(await sm.getContractCode(Address.fromString(a)));
  const putCode = async (a, codeHex) => sm.putContractCode(Address.fromString(a), hexToBytes(codeHex));

  /** Puts the mock DEX at the chain's DEX addresses; returns addPool(token, tokens, wei) -> pair. */
  async function installDex(dex) {
    const bins = mocks();
    const codeOf = async (name, args = '') => getCode(await deployCode(bins[name], args));
    await putCode(dex.weth, await codeOf('MockWETH'));
    await putCode(dex.factory, await codeOf('MockFactory'));
    await putCode(dex.router, await codeOf('MockRouter', word(dex.factory) + word(dex.weth)));
    return async function addPool(token, tokens, wei) {
      await send(dex.factory, 'createPair(address,address)', [token, dex.weth]);
      const pair = '0x' + (await send(dex.factory, 'getPair(address,address)', [token, dex.weth])).slice(-40);
      await send(dex.weth, 'deposit()', [], wei);
      await send(dex.weth, 'transfer(address,uint256)', [pair, BigInt(wei)]);
      await send(token, 'transfer(address,uint256)', [pair, BigInt(tokens)]);
      await send(pair, 'sync()');
      return pair;
    };
  }

  // Read-only RPC with the interface of src/rpc.js (same behaviour as test/helpers/local-chain.js).
  const rpc = {
    gasPrice: 1_000_000_000n,
    async call(method, params) {
      if (method === 'eth_gasPrice') return '0x' + this.gasPrice.toString(16);
      if (method === 'eth_getCode') return getCode(params[0]);
      if (method === 'eth_getStorageAt') {
        const v = await sm.getContractStorage(Address.fromString(params[0]), hexToBytes(params[1]));
        return bytesToHex(setLengthLeft(v, 32));
      }
      if (method === 'eth_call') {
        const [{ to, data, from, gas, gasPrice }, , override] = params;
        const caller = Address.fromString(from ?? '0x2222222222222222222222222222222222222222');
        const gasLimit = gas != null ? BigInt(gas) : 30_000_000n;
        const price = gasPrice != null ? BigInt(gasPrice) : 0n;
        evm.journal.cleanJournal();
        await sm.checkpoint();
        try {
          for (const [addr, o] of Object.entries(override ?? {})) {
            if (o.code) await putCode(addr, o.code);
            if (o.balance) await fund(addr, o.balance);
          }
          const balance = (await sm.getAccount(caller))?.balance ?? 0n;
          if (price > 0n && balance < gasLimit * price) throw new Error('insufficient funds for gas * price + value');
          const r = await evm.runCall({ caller, to: Address.fromString(to), data: hexToBytes(data), gasLimit, gasPrice: price, block });
          if (r.execResult.exceptionError) throw new Error('execution reverted');
          return bytesToHex(r.execResult.returnValue);
        } finally {
          await sm.revert();
        }
      }
      throw new Error(`unsupported ${method}`);
    },
  };

  return { evm, block, deployCode, send, fund, getCode, putCode, installDex, rpc };
}

export { word };
