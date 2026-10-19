// Test helper: compiles test/helpers/contracts.sol and runs it on an
// in-memory EVM, exposed through the same read-only RPC shape the reader uses.
// This lets tests read real compiled contracts without any network.

import { readFileSync } from 'node:fs';
import solc from 'solc';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, hexToBytes, bytesToHex, setLengthLeft } from '@ethereumjs/util';

const SOURCE = readFileSync(new URL('./contracts.sol', import.meta.url), 'utf8');
const DEPLOYER = Address.fromString('0x1111111111111111111111111111111111111111');
const cache = new Map();

/** Compiles once per optimizer setting. Returns {ContractName: creationBytecodeHex}. */
export function compile({ optimize = true } = {}) {
  if (cache.has(optimize)) return cache.get(optimize);
  const input = {
    language: 'Solidity',
    sources: { 'contracts.sol': { content: SOURCE } },
    settings: { optimizer: { enabled: optimize, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const bins = Object.fromEntries(
    Object.entries(out.contracts['contracts.sol']).map(([k, v]) => [k, v.evm.bytecode.object]));
  cache.set(optimize, bins);
  return bins;
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

  // Read-only RPC with the same interface as src/rpc.js.
  const rpc = {
    calls: [],
    async call(method, params) {
      this.calls.push(method);
      if (method === 'eth_getCode') {
        return bytesToHex(await sm.getContractCode(Address.fromString(params[0])));
      }
      if (method === 'eth_getStorageAt') {
        const v = await sm.getContractStorage(Address.fromString(params[0]), hexToBytes(params[1]));
        return bytesToHex(setLengthLeft(v, 32));
      }
      if (method === 'eth_call') {
        const { to, data } = params[0];
        const r = await evm.runCall({
          caller: Address.fromString('0x2222222222222222222222222222222222222222'),
          to: Address.fromString(to), data: hexToBytes(data), gasLimit: 10_000_000n,
        });
        if (r.execResult.exceptionError) throw new Error('execution reverted');
        return bytesToHex(r.execResult.returnValue);
      }
      throw new Error(`unsupported ${method}`);
    },
  };

  return { deploy, putCode, rpc, bins };
}
