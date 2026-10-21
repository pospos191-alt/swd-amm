// Copied from zetaphy-network/test/helpers/evm.js (same repository, MIT); keep the two in step.
// zetaphy-dex additions: createChain(..., { chainId }), code(), setTime(), rawSend(), staticCall(),
// storageAt(); a revert's Error carries its return data (.data).
// A tiny in-memory chain for contract tests: funded accounts, a clock we
// control, transactions with value, and decoded events/errors via ethers.

import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { Interface, keccak256, toBeHex } from 'ethers';
import { readFileSync } from 'node:fs';

export const ZETA = 10n ** 18n;

/** @param names  plain test accounts; @param fundAddresses  {name: '0x…'} accounts whose keys the test holds */
/** @param opts  { chainId } (zetaphy-dex addition): another EVM chain id than mainnet's 1 */
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
  const common = opts.chainId
    ? Common.custom({ chainId: opts.chainId, networkId: opts.chainId, name: `chain-${opts.chainId}` }, { baseChain: Chain.Mainnet, hardfork: Hardfork.Cancun })
    : new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const evm = await EVM.create({ common, blockchain });
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
    const r = await evm.runCall({ caller: acct[from] ?? from, to, data: hexToBytes(data), value, gasLimit: 15_000_000n, block: block() });
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
    /** Sets the clock (unix seconds) (zetaphy-dex addition). */
    setTime(seconds) { time = BigInt(seconds); },
    /** A transaction from any address: { ok, returnValue, logs, createdAddress } (zetaphy-dex addition). */
    async rawSend(fromHex, toHex, dataHex, value = 0n) {
      const r = await exec(Address.fromString(fromHex), toHex ? Address.fromString(toHex) : undefined, dataHex || '0x', value);
      return { ok: !r.execResult.exceptionError, returnValue: bytesToHex(r.execResult.returnValue), logs: r.execResult.logs ?? [], gasUsed: r.execResult.executionGasUsed };
    },
    /** eth_call: runs and throws the state changes away (zetaphy-dex addition). */
    async staticCall(fromHex, toHex, dataHex, value = 0n) {
      await sm.checkpoint();
      try {
        const r = await evm.runCall({ caller: Address.fromString(fromHex), to: Address.fromString(toHex), data: hexToBytes(dataHex || '0x'), value, gasLimit: 15_000_000n, block: block() });
        return { ok: !r.execResult.exceptionError, returnValue: bytesToHex(r.execResult.returnValue) };
      } finally { await sm.revert(); }
    },
    /** One storage word, 0x… 32 bytes (zetaphy-dex addition). */
    async storageAt(addressHex, slotHex) {
      const v = await sm.getContractStorage(Address.fromString(addressHex), hexToBytes('0x' + BigInt(slotHex).toString(16).padStart(64, '0')));
      return '0x' + bytesToHex(v).slice(2).padStart(64, '0');
    },
    /** Runtime code at an address, 0x… (zetaphy-dex addition). */
    async code(addressHex) { return bytesToHex(await sm.getContractCode(Address.fromString(addressHex))); },
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
        throw Object.assign(new Error(name), { data: bytesToHex(res.execResult.returnValue) });
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
          if (res.execResult.exceptionError) throw Object.assign(new Error(decodeError(res.execResult.returnValue)), { data: bytesToHex(res.execResult.returnValue) });
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
