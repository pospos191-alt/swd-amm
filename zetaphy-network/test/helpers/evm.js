// A tiny in-memory chain for contract tests: funded accounts, a clock we
// control, transactions with value, and decoded events/errors via ethers.

import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { Interface } from 'ethers';
import { readFileSync } from 'node:fs';

export const ZETA = 10n ** 18n;

/** @param names  plain test accounts; @param fundAddresses  {name: '0x…'} accounts whose keys the test holds */
export async function createChain(names = [], fundAddresses = {}) {
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const sm = evm.stateManager;
  let time = 1_800_000_000n;
  let number = 1n;
  let prevRandao = new Uint8Array(32); // constant 0, like a chain without PREVRANDAO; setPrevRandao() changes it
  const acct = {};
  for (const [i, n] of names.entries()) {
    const a = Address.fromString('0x' + (i + 1).toString(16).padStart(40, '0').replace(/^0/, 'a'));
    await sm.putAccount(a, new Account(0n, 1_000_000n * ZETA));
    acct[n] = a;
  }
  for (const [n, hex] of Object.entries(fundAddresses)) {
    const a = Address.fromString(hex);
    await sm.putAccount(a, new Account(0n, 1_000_000n * ZETA));
    acct[n] = a;
  }
  const block = () => ({
    header: {
      number, timestamp: time, coinbase: Address.zero(), difficulty: 0n, prevRandao,
      gasLimit: 30_000_000n, baseFeePerGas: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n,
    },
  });

  async function exec(from, to, data, value = 0n) {
    const r = await evm.runCall({ caller: acct[from] ?? from, to, data: hexToBytes(data), value, gasLimit: 10_000_000n, block: block() });
    number += 1n;
    return r;
  }

  return {
    acct,
    /** Puts runtime code at an address (e.g. a precompile stand-in). */
    async putCode(addressHex, runtimeHex) {
      await sm.putContractCode(Address.fromString(addressHex), hexToBytes(runtimeHex));
    },
    advance(seconds) { time += BigInt(seconds); },
    /** PREVRANDAO (block.prevrandao) of the next blocks, as a 0x… 32-byte hex. */
    setPrevRandao(hex) { prevRandao = hexToBytes(hex); },
    blockNumber: () => number,
    async transfer(from, to, value) {
      const r = await exec(from, Address.fromString(to), '0x', value);
      if (r.execResult.exceptionError) throw new Error('transfer failed');
    },
    /** send/call on any address with a given interface (e.g. a factory-made contract). */
    async sendTo(from, toHex, iface, fn, args = [], value = 0n) {
      const res = await exec(from, Address.fromString(toHex), iface.encodeFunctionData(fn, args), value);
      if (res.execResult.exceptionError) {
        let name = 'revert';
        try { name = iface.parseError(bytesToHex(res.execResult.returnValue))?.name ?? name; } catch {}
        throw new Error(name);
      }
      return res;
    },
    async callAt(toHex, iface, fn, args = []) {
      const res = await exec(acct[names[0]], Address.fromString(toHex), iface.encodeFunctionData(fn, args));
      if (res.execResult.exceptionError) throw new Error('call reverted');
      const out = iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue));
      return out.length === 1 ? out[0] : out;
    },
    now: () => time,
    balance: async (who) => (await sm.getAccount(acct[who] ?? who))?.balance ?? 0n,
    async deploy(artifactName, args, from) {
      return this.deployRaw(JSON.parse(readFileSync(new URL(`../../artifacts/${artifactName}.json`, import.meta.url), 'utf8')), args, from);
    },
    /** Deploys {abi, bytecode} (e.g. compiled inside a test). */
    async deployRaw(art, args, from) {
      const iface = new Interface(art.abi);
      const r = await exec(from, undefined, art.bytecode + iface.encodeDeploy(args).slice(2));
      if (r.execResult.exceptionError) throw new Error(`deploy failed: ${r.execResult.exceptionError.error}`);
      const address = r.createdAddress;
      const decodeError = (ret) => { try { return iface.parseError(bytesToHex(ret))?.name; } catch { return 'revert'; } };
      return {
        address: address.toString(),
        iface,
        /** Sends a tx; throws Error(<custom error name>) on revert; returns parsed events. */
        async send(from, fn, args = [], value = 0n) {
          const res = await exec(from, address, iface.encodeFunctionData(fn, args), value);
          if (res.execResult.exceptionError) throw new Error(decodeError(res.execResult.returnValue));
          return (res.execResult.logs ?? []).map(([, topics, data]) => { try { return iface.parseLog({ topics: topics.map(bytesToHex), data: bytesToHex(data) }); } catch { return null; } });
        },
        async sendValue(from, value) {
          const res = await exec(from, address, '0x', value);
          if (res.execResult.exceptionError) throw new Error(decodeError(res.execResult.returnValue));
        },
        async call(fn, args = []) {
          const res = await exec(acct[names[0]], address, iface.encodeFunctionData(fn, args));
          if (res.execResult.exceptionError) throw new Error(decodeError(res.execResult.returnValue));
          const out = iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue));
          return out.length === 1 ? out[0] : out;
        },
      };
    },
  };
}
