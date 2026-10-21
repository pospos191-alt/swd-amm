// A tiny in-memory chain for contract tests (from zetaphy-network/test/helpers/evm.js):
// funded accounts, a clock we control, transactions with value, decoded events
// and errors. Errors are decoded with every artifact's and mock's ABI, so a
// custom error that bubbles up from a collection through the marketplace keeps its name.

import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { Interface, AbiCoder, getAddress, keccak256, toBeHex } from 'ethers';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../scripts/build.js';

export const ZETA = 10n ** 18n;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const artifacts = Object.fromEntries(readdirSync(join(ROOT, 'artifacts')).filter((f) => f.endsWith('.json'))
  .map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(ROOT, 'artifacts', f), 'utf8'))]));
let mocks;
export function mockArtifacts() {
  mocks ??= compile([join(ROOT, 'test/helpers/Mocks.sol')]).arts;
  return mocks;
}
const artifact = (name) => artifacts[name] ?? mockArtifacts()[name] ?? (() => { throw new Error(`no artifact ${name}`); })();

let errorIface;
function errorsInterface() {
  if (errorIface) return errorIface;
  const seen = new Set();
  const frags = [];
  for (const art of [...Object.values(artifacts), ...Object.values(mockArtifacts())]) {
    for (const f of art.abi) {
      if (f.type !== 'error') continue;
      const sig = `${f.name}(${f.inputs.map((i) => i.type).join(',')})`;
      if (!seen.has(sig)) { seen.add(sig); frags.push(f); }
    }
  }
  return (errorIface = new Interface(frags));
}

/** A revert's return data as a name: custom error name, Error(string)'s text, Panic(0x..), or 'revert'. */
export function decodeError(ret) {
  const hex = typeof ret === 'string' ? ret : bytesToHex(ret);
  if (hex.length < 10) return 'revert';
  if (hex.startsWith('0x08c379a0')) return AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(10))[0];
  if (hex.startsWith('0x4e487b71')) return `Panic(0x${BigInt('0x' + hex.slice(10)).toString(16)})`;
  try { return errorsInterface().parseError(hex)?.name ?? 'revert'; } catch { return 'revert'; }
}

export async function createChain(names = []) {
  // BLOCKHASH: a fixed hash per block number, like a real chain (NeuroJobs' lottery reads it).
  const blockchain = {
    async getBlock(n) { return { hash: () => hexToBytes(keccak256(toBeHex(BigInt(n), 32))) }; },
    shallowCopy() { return this; },
  };
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }), blockchain });
  const sm = evm.stateManager;
  let time = 1_800_000_000n;
  let number = 1n;
  const acct = {};
  for (const [i, n] of names.entries()) {
    const a = Address.fromString('0x' + (i + 1).toString(16).padStart(40, '0').replace(/^0/, 'a'));
    await sm.putAccount(a, new Account(0n, 1_000_000n * ZETA));
    acct[n] = a;
  }
  const block = () => ({
    header: {
      number, timestamp: time, coinbase: Address.zero(), difficulty: 0n, prevRandao: new Uint8Array(32),
      gasLimit: 30_000_000n, baseFeePerGas: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n,
    },
  });
  const who = (x) => acct[x] ?? (typeof x === 'string' ? Address.fromString(x) : x);
  let lastGas = 0n;

  async function exec(from, to, data, value = 0n, gasLimit = 15_000_000n) {
    const r = await evm.runCall({ caller: who(from), origin: who(from), to, data: hexToBytes(data), value, gasLimit, block: block() });
    lastGas = r.execResult.executionGasUsed;
    number += 2n; // an empty block after each tx, so blockhash(previous block) is readable
    return r;
  }

  function wrap(addressHex, iface) {
    const address = Address.fromString(addressHex);
    const parse = (logs) => (logs ?? []).map(([addr, topics, data]) => {
      if (bytesToHex(addr).toLowerCase() !== addressHex.toLowerCase()) return null;
      try { return iface.parseLog({ topics: topics.map(bytesToHex), data: bytesToHex(data) }); } catch { return null; }
    }).filter(Boolean);
    return {
      address: getAddress(addressHex),
      iface,
      /** Sends a tx; throws Error(<error name>) on revert; returns this contract's parsed events (with .raw: all logs). */
      async send(from, fn, args = [], value = 0n, gasLimit) {
        const res = await exec(from, address, iface.encodeFunctionData(fn, args), value, gasLimit);
        if (res.execResult.exceptionError) throw new Error(decodeError(res.execResult.returnValue));
        const ev = parse(res.execResult.logs);
        ev.raw = res.execResult.logs ?? [];
        ev.returned = bytesToHex(res.execResult.returnValue);
        return ev;
      },
      async call(fn, args = [], from) {
        const res = await exec(from ?? acct[names[0]], address, iface.encodeFunctionData(fn, args));
        if (res.execResult.exceptionError) throw new Error(decodeError(res.execResult.returnValue));
        const out = iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue));
        return out.length === 1 ? out[0] : out;
      },
    };
  }

  return {
    acct,
    addr: (n) => getAddress(acct[n].toString()),
    advance(seconds) { time += BigInt(seconds); },
    now: () => time,
    lastGas: () => lastGas,
    balance: async (x) => (await sm.getAccount(who(x)))?.balance ?? 0n,
    code: async (x) => bytesToHex(await sm.getContractCode(who(x))),
    /** Sets an account's balance (e.g. a contract that cannot receive ZETAPHY acting as a buyer). */
    async fund(x, amount) {
      const a = (await sm.getAccount(who(x))) ?? new Account();
      a.balance = amount;
      await sm.putAccount(who(x), a);
    },
    async transfer(from, to, value) {
      const r = await exec(from, who(to), '0x', value);
      if (r.execResult.exceptionError) throw new Error(decodeError(r.execResult.returnValue));
    },
    async deploy(name, args = [], from, value = 0n) {
      return this.deployArtifact(artifact(name), args, from, value, name);
    },
    /** Deploys {abi, bytecode} (e.g. another package's artifact). */
    async deployArtifact(art, args = [], from, value = 0n, name = art.contractName) {
      const iface = new Interface(art.abi);
      const r = await exec(from, undefined, art.bytecode + iface.encodeDeploy(args).slice(2), value);
      if (r.execResult.exceptionError) throw new Error(`deploy ${name} failed: ${decodeError(r.execResult.returnValue)} ${r.execResult.exceptionError.error}`);
      return wrap(r.createdAddress.toString(), iface);
    },
    /** A wrapper for a contract at `address` with artifact `name`'s ABI. */
    at(address, name) {
      return wrap(address, new Interface(artifact(name).abi));
    },
  };
}
