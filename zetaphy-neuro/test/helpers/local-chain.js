// Test helper: compiles test/helpers/contracts.sol (plus the similarity
// baseline, scripts/baseline-tokens.sol, and test/helpers/honest-tokens.sol)
// and runs it on an in-memory EVM, exposed through the same read-only RPC
// shape the reader uses. This lets tests read real compiled contracts without
// any network.

import { readFileSync } from 'node:fs';
import solc from 'solc';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex, setLengthLeft } from '@ethereumjs/util';
import { selectorOf } from '../../scripts/keccak.js';

// Contract names are unique across the files, so one {name: bytecode} map serves all.
const SOURCES = {
  'contracts.sol': { content: readFileSync(new URL('./contracts.sol', import.meta.url), 'utf8') },
  'baseline-tokens.sol': { content: readFileSync(new URL('../../scripts/baseline-tokens.sol', import.meta.url), 'utf8') },
  'honest-tokens.sol': { content: readFileSync(new URL('./honest-tokens.sol', import.meta.url), 'utf8') },
};
const DEPLOYER = Address.fromString('0x1111111111111111111111111111111111111111');
const cache = new Map();
const abiCache = new Map();

/** Compiles once per optimizer setting. Returns {ContractName: creationBytecodeHex}. */
export function compile({ optimize = true } = {}) {
  if (cache.has(optimize)) return cache.get(optimize);
  const input = {
    language: 'Solidity',
    sources: SOURCES,
    settings: { optimizer: { enabled: optimize, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const all = Object.values(out.contracts).flatMap((byName) => Object.entries(byName));
  const bins = Object.fromEntries(all.map(([k, v]) => [k, v.evm.bytecode.object]));
  cache.set(optimize, bins);
  abiCache.set(optimize, Object.fromEntries(all.map(([k, v]) => [k, v.abi])));
  return bins;
}

/** {ContractName: abi} from the same compile. */
export function abis({ optimize = true } = {}) {
  compile({ optimize });
  return abiCache.get(optimize);
}

const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
/** ABI-encodes (address, bytes). */
export function encodeAddressBytes(addr, dataHex) {
  const d = dataHex.replace(/^0x/, '');
  const padded = d.padEnd(Math.ceil(d.length / 64) * 64, '0');
  return word(addr) + word('40') + word((d.length / 2).toString(16)) + padded;
}

export async function createLocalChain({ optimize = true } = {}) {
  const bins = compile({ optimize });
  // Cancun: solc 0.8.26 emits PUSH0 and MCOPY, as on BNB Chain, Base and Arbitrum today.
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const sm = evm.stateManager;

  async function deploy(name, argsHex = '') {
    const r = await evm.runCall({ caller: DEPLOYER, data: hexToBytes('0x' + bins[name] + argsHex), gasLimit: 30_000_000n });
    if (r.execResult.exceptionError) throw new Error(`deploy ${name}: ${r.execResult.exceptionError.error}`);
    return r.createdAddress.toString();
  }

  async function putCode(addressHex, codeHex) {
    await sm.putContractCode(Address.fromString(addressHex), hexToBytes(codeHex));
  }

  async function fund(addressHex, wei) {
    const a = Address.fromString(addressHex);
    const acct = (await sm.getAccount(a)) ?? new Account();
    acct.balance = BigInt(wei);
    await sm.putAccount(a, acct);
  }

  /** A state-changing call from the deployer (setting up pools); returns the output. */
  async function send(to, sig, args = [], value = 0n) {
    const data = '0x' + selectorOf(sig) + args.map(word).join('');
    const r = await evm.runCall({ caller: DEPLOYER, to: Address.fromString(to), data: hexToBytes(data), value: BigInt(value), gasLimit: 30_000_000n });
    if (r.execResult.exceptionError) throw new Error(`${sig}: ${r.execResult.exceptionError.error}`);
    return bytesToHex(r.execResult.returnValue);
  }

  /**
   * Puts the mock Uniswap-V2 DEX (contracts.sol) at a chain's real DEX
   * addresses (src/chains.js `dex`), so readContract finds it as on mainnet.
   * Returns addPool(token, tokens, wei): a pool holding that much of each.
   */
  async function installDex(dex) {
    const code = async (name, args) => bytesToHex(await sm.getContractCode(Address.fromString(await deploy(name, args))));
    await putCode(dex.weth, await code('MockWETH'));
    await putCode(dex.factory, await code('MockFactory'));
    await putCode(dex.router, await code('MockRouter', word(dex.factory) + word(dex.weth)));
    await fund(DEPLOYER.toString(), 10n ** 30n);
    return async function addPool(token, tokens, wei) {
      await send(dex.factory, 'createPair(address,address)', [token, dex.weth]);
      const pair = '0x' + (await send(dex.factory, 'getPair(address,address)', [token, dex.weth])).slice(-40);
      await send(dex.weth, 'deposit()', [], wei);
      await send(dex.weth, 'transfer(address,uint256)', [pair, BigInt(wei).toString(16)]);
      await send(token, 'transfer(address,uint256)', [pair, BigInt(tokens).toString(16)]);
      await send(pair, 'sync()');
      return pair;
    };
  }

  // Read-only RPC with the same interface as src/rpc.js.
  const rpc = {
    calls: [],
    gasPrice: 1_000_000_000n, // what eth_gasPrice answers (1 gwei)
    async call(method, params) {
      this.calls.push(method);
      if (method === 'eth_gasPrice') return '0x' + this.gasPrice.toString(16);
      if (method === 'eth_getCode') {
        return bytesToHex(await sm.getContractCode(Address.fromString(params[0])));
      }
      if (method === 'eth_getStorageAt') {
        const v = await sm.getContractStorage(Address.fromString(params[0]), hexToBytes(params[1]));
        return bytesToHex(setLengthLeft(v, 32));
      }
      if (method === 'eth_call') {
        // Like a node: runs on a scratch copy of the state (with the optional
        // state override, third parameter) and throws the copy away.
        // Like geth: gas defaults to a high cap, gas price to 0, and a priced
        // call needs a caller that can pay gas * gasPrice.
        const [{ to, data, from, gas, gasPrice }, , override] = params;
        const caller = Address.fromString(from ?? '0x2222222222222222222222222222222222222222');
        const gasLimit = gas != null ? BigInt(gas) : 30_000_000n;
        const price = gasPrice != null ? BigInt(gasPrice) : 0n;
        // Each call starts cold, as on a node (runCall keeps EIP-2929 warm
        // addresses and slots from earlier calls otherwise).
        evm.journal.cleanJournal();
        await sm.checkpoint();
        try {
          for (const [addr, o] of Object.entries(override ?? {})) {
            if (o.code) await putCode(addr, o.code);
            if (o.balance) await fund(addr, o.balance);
          }
          const balance = (await sm.getAccount(caller))?.balance ?? 0n;
          if (price > 0n && balance < gasLimit * price) throw new Error('insufficient funds for gas * price + value');
          const r = await evm.runCall({
            caller, to: Address.fromString(to), data: hexToBytes(data), gasLimit, gasPrice: price,
          });
          if (r.execResult.exceptionError) throw new Error('execution reverted');
          return bytesToHex(r.execResult.returnValue);
        } finally {
          await sm.revert();
        }
      }
      throw new Error(`unsupported ${method}`);
    },
  };

  return { deploy, putCode, fund, send, installDex, rpc, bins };
}
