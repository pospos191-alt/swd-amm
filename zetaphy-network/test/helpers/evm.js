// A tiny in-memory chain for contract tests: funded accounts, a clock we
// control, transactions with value, and decoded events/errors via ethers.

import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { Interface, keccak256, toBeHex } from 'ethers';
import { readFileSync } from 'node:fs';

export const ZETA = 10n ** 18n;

/**
 * @param names  plain test accounts; @param fundAddresses  {name: '0x…'} accounts whose keys the test holds
 * @param opts.precompiles  {'0x…address': (input: Uint8Array) => Uint8Array} precompiles written in JS
 *   (a function's optional `gas` property is the gas it charges; 3000 otherwise)
 * @param opts.chainId  another EVM chain id (block.chainid; Ethereum mainnet's 1 otherwise): several chains side by side in one test
 * @param opts.txGasLimit  the gas of each transaction (15 M otherwise; blocks carry 30 M or this, if higher)
 *   (e.g. helpers/precompiles.js: the real ML-DSA check at 0x…0900, P-256 at 0x…0100)
 */
export async function createChain(names = [], fundAddresses = {}, opts = {}) {
  // BLOCKHASH: a fixed hash per block number (keccak of a salt and the
  // number), like a real chain; setBlockHashSalt() gives another history,
  // noBlockHash() a chain whose BLOCKHASH is always 0. The EVM itself
  // returns 0 outside the last 256 blocks.
  let hashSalt = '0x' + '00'.repeat(32);
  let hashes = true;
  const blockchain = {
    async getBlock(n) {
      const h = hashes ? hexToBytes(keccak256(hashSalt + toBeHex(BigInt(n), 32).slice(2))) : new Uint8Array(32);
      return { hash: () => h };
    },
    shallowCopy() { return this; },
  };
  const customPrecompiles = Object.entries(opts.precompiles ?? {}).map(([addr, fn]) => ({
    address: Address.fromString(addr),
    function: ({ data }) => ({ executionGasUsed: BigInt(fn.gas ?? 3000n), returnValue: fn(data) ?? new Uint8Array(0) }),
  }));
  const common = opts.chainId != null && Number(opts.chainId) !== 1
    ? Common.custom({ chainId: Number(opts.chainId), networkId: Number(opts.chainId), name: `chain-${opts.chainId}` }, { baseChain: Chain.Mainnet, hardfork: Hardfork.Cancun })
    : new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const txGasLimit = BigInt(opts.txGasLimit ?? 15_000_000n);
  const evm = await EVM.create({ common, blockchain, customPrecompiles });
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
      gasLimit: txGasLimit > 30_000_000n ? txGasLimit : 30_000_000n, baseFeePerGas: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n,
    },
  });

  async function exec(from, to, data, value = 0n) {
    const r = await evm.runCall({ caller: acct[from] ?? from, to, data: hexToBytes(data), value, gasLimit: txGasLimit, block: block() });
    // Every transaction (and call) gets its own block, with an empty block
    // after it, so the next one can already read the block hash NeuroJobs'
    // lottery uses (blockhash(start block + 1)), as two blocks later on a chain.
    number += 2n;
    return r;
  }

  return {
    acct,
    /** Puts runtime code at an address (e.g. a precompile stand-in). */
    async putCode(addressHex, runtimeHex) {
      await sm.putContractCode(Address.fromString(addressHex), hexToBytes(runtimeHex));
    },
    advance(seconds) { time += BigInt(seconds); },
    /** Sets the clock (block.timestamp of the next transactions). */
    setTime(t) { time = BigInt(t); },
    /** PREVRANDAO (block.prevrandao) of the next blocks, as a 0x… 32-byte hex. */
    setPrevRandao(hex) { prevRandao = hexToBytes(hex); },
    blockNumber: () => number,
    /** Moves the block number on by n empty blocks. */
    mine(n = 1) { number += BigInt(n); },
    /** Another block-hash history from here on (a 0x… 32-byte salt). */
    setBlockHashSalt(hex) { hashSalt = hex; },
    /** BLOCKHASH returns 0 for every block (a chain without it). */
    noBlockHash() { hashes = false; },
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
    /** A raw call (state changes stay, as a transaction): { ok, returnHex }. `from` is a name or a 0x address. */
    async rawCall(from, toHex, dataHex, value = 0n) {
      const res = await exec(acct[from] ?? Address.fromString(from), Address.fromString(toHex), dataHex, value);
      return { ok: !res.execResult.exceptionError, returnHex: bytesToHex(res.execResult.returnValue) };
    },
    /** A raw transaction with its logs: { ok, logs: [{ address, topics, data }] } (`to` null: a contract creation). */
    async rawTx(from, toHex, dataHex, value = 0n) {
      const res = await exec(acct[from] ?? Address.fromString(from), toHex ? Address.fromString(toHex) : undefined, dataHex, value);
      const logs = (res.execResult.logs ?? []).map(([address, topics, data]) => ({ address: bytesToHex(address), topics: topics.map(bytesToHex), data: bytesToHex(data) }));
      return { ok: !res.execResult.exceptionError, logs: res.execResult.exceptionError ? [] : logs, gas: Number(res.execResult.executionGasUsed), returnHex: bytesToHex(res.execResult.returnValue) };
    },
    async callAt(toHex, iface, fn, args = []) {
      const res = await exec(acct[names[0]], Address.fromString(toHex), iface.encodeFunctionData(fn, args));
      if (res.execResult.exceptionError) throw new Error('call reverted');
      const out = iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue));
      return out.length === 1 ? out[0] : out;
    },
    /** eth_call-like: raw 0x return data of a call (reverts throw), for readers that decode ABI themselves. */
    async rawCallHex(toHex, dataHex) {
      const res = await exec(acct[names[0]], Address.fromString(toHex), dataHex);
      if (res.execResult.exceptionError) throw new Error('call reverted');
      return bytesToHex(res.execResult.returnValue);
    },
    now: () => time,
    /** The runtime code at an address (eth_getCode). */
    getCode: async (addressHex) => bytesToHex(await sm.getContractCode(Address.fromString(addressHex))),
    /** An account's nonce (the next CREATE address is getCreateAddress({ from, nonce })). */
    nonce: async (who) => (await sm.getAccount(acct[who] ?? who))?.nonce ?? 0n,
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
        /** Execution gas of a call/tx (without the 21000 base and calldata cost), and the calldata. */
        async gas(from, fn, args = [], value = 0n) {
          const data = iface.encodeFunctionData(fn, args);
          const res = await exec(from, address, data, value);
          if (res.execResult.exceptionError) throw new Error(decodeError(res.execResult.returnValue));
          return { exec: Number(res.execResult.executionGasUsed), data };
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
