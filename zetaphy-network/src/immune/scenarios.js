// Attack scenarios on the mock multi-chain (mockchain.js), shaped like the public post-mortems of real incidents
// (flash-loan price manipulation, approval drainers, a one-block treasury drain, SPL delegate drainers, Cosmos authz
// drainers), with made-up addresses. Used by the tests and by scripts/immune-record.js to write the recorded
// fixtures (test/fixtures/immune/*.json) the sentinels are replayed against.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { MockEvmChain, MockSolanaChain, MockCosmosChain, log, mockAddress } from './mockchain.js';

const bytesOf = (label, n) => keccak_256(new TextEncoder().encode(`immune.mock.${label}`)).slice(0, n);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A made-up Solana account (base58 of 32 hash bytes): never a real one. */
export function mockSolana(label) {
  let n = BigInt('0x' + Buffer.from(bytesOf(label, 32)).toString('hex'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return s;
}
const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]; }
  return chk;
}
/** A made-up bech32 account (`hrp`, 20 or 32 hash bytes): never a real one. */
export function mockBech32(hrp, label, n = 20) {
  const data = []; let acc = 0; let bits = 0;
  for (const b of bytesOf(label, n)) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); } }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...exp, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const chk = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...chk].map((d) => CS[d]).join('')}`;
}

const E = 10n ** 18n;
const MAX = (1n << 256n) - 1n;

/** An EVM chain with: a flash-loan exploit tx, an approval drainer sweeping 3 holders, a protocol drained in one block. */
export function evmAttacks({ id = 11155111, exploitCode = '0x6080604052348015600f57600080fd5b50', time = 1_800_000_000 } = {}) {
  const c = new MockEvmChain({ id, head: 7_000_000, time, blockTime: 12 });
  const a = (s) => mockAddress(`${id}.${s}`);
  const attacker = a('attacker'); const exploit = a('exploit'); const weth = a('weth'); const usdc = a('usdc'); const pair = a('pair');
  const aave = a('aave'); const lending = a('lending'); const drainer = a('drainer'); const sink = a('sink'); const vault = a('vault');
  const victims = [a('v1'), a('v2'), a('v3')];
  c.setCode(aave, '0x60016001'); c.setCode(pair, '0x60026002'); c.setCode(lending, '0x60036003'); c.setCode(vault, '0x60046004');
  c.mine([{ from: attacker, deploy: exploitCode, contractAddress: exploit }]);
  // a quiet history for the vault (its usual outflow: ~1 USDC a block)
  for (let i = 0; i < 6; i++) c.mine([{ from: a(`user${i}`), to: vault, logs: [log.transfer(usdc, vault, a(`user${i}`), 1n * E)] }]);
  const start = c.headNumber + 1;
  // 1. flash loan + price manipulation + profit
  c.mine([{ from: attacker, to: exploit, logs: [
    log.flash(aave, 'aave-v3', exploit), log.transfer(weth, aave, exploit, 5000n * E),
    log.sync(pair, 1000n * E, 1000n * E), log.sync(pair, 3500n * E, 290n * E), log.transfer(weth, lending, exploit, 2600n * E),
    log.sync(pair, 1000n * E, 1000n * E), log.transfer(weth, exploit, aave, 5003n * E), log.transfer(weth, exploit, attacker, 2597n * E)] }]);
  // 2. drainer: three holders sign unlimited approvals (a phishing site), then the drainer sweeps them
  c.mine(victims.map((v) => ({ from: v, to: usdc, logs: [log.approval(usdc, v, drainer, MAX)] })));
  c.mine(victims.slice(0, 2).map((v, i) => ({ from: drainer, to: usdc, logs: [log.transfer(usdc, v, sink, BigInt(100 + i) * E)] })));
  // 3. the vault loses 90% of its USDC in one block, to one fresh address
  c.mine([{ from: attacker, to: vault, logs: [log.transfer(usdc, vault, a('collector'), 900_000n * E)] }]);
  // 4. the attacker moves funds on to a fresh address (taint)
  c.mine([{ from: attacker, to: a('fresh'), value: 10n * E }]);
  // an honest block: normal swaps, a normal approval to a known router, a deposit
  c.mine([{ from: a('alice'), to: pair, logs: [log.sync(pair, 1000n * E, 1001n * E), log.transfer(weth, a('alice'), pair, 1n * E)] },
    { from: a('bob'), to: usdc, logs: [log.approval(usdc, a('bob'), a('router'), MAX)] }]);
  return { chain: c, start, addr: { attacker, exploit, weth, usdc, pair, aave, lending, drainer, sink, vault, victims, fresh: a('fresh'), collector: a('collector') },
    protocols: [{ address: vault, name: 'Mock vault', tvl: { [usdc]: (1_000_000n * E).toString() } }], allowlist: [a('router')] };
}

/** Solana: one delegate collecting 3 owners' SPL token accounts. */
export function solanaAttacks() {
  const c = new MockSolanaChain();
  const drainer = mockSolana('sol.drainer');
  const owners = [1, 2, 3].map((i) => mockSolana(`sol.owner${i}`));
  c.mine([]);
  owners.forEach((o, i) => c.mine([{ type: i === 1 ? 'setAuthority' : 'approve', owner: o, delegate: drainer, newAuthority: drainer, account: mockSolana(`sol.acct${i}`) }]));
  return { chain: c, drainer, owners };
}

/** Osmosis: a CosmWasm instantiation of a known-bad code, and an authz drainer. */
export function cosmosAttacks({ checksum = 'aa'.repeat(32) } = {}) {
  const c = new MockCosmosChain();
  const grantee = mockBech32('osmo', 'osmo.grantee');
  const granters = [1, 2, 3].map((i) => mockBech32('osmo', `osmo.granter${i}`));
  c.storeCode(77, checksum);
  c.storeCode(78, 'bb'.repeat(32));
  c.mine([]);
  const bad = mockBech32('osmo', 'osmo.badcontract', 32); const good = mockBech32('osmo', 'osmo.goodcontract', 32);
  c.mine([{ instantiate: { contract: bad, codeId: 77 } }, { instantiate: { contract: good, codeId: 78 } }]);
  c.mine(granters.map((g) => ({ grant: { granter: g, grantee } })));
  return { chain: c, grantee, granters, checksum, bad, good };
}
