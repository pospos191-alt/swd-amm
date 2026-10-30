// Audit-as-a-Service (docs/future/audit-as-a-service.md): intake per chain type against recorded-shape fixtures
// (EVM + Sourcify v2, EIP-1967 / beacon / EIP-1167 proxies, repo + commit; CosmWasm LCD; Solana RPC + OtterSec),
// ordering on the real AuditNetwork, the code-hash binding through the NeuroOracle mirror and the AuditVerified
// library (including a proxy whose implementation is swapped), the JS verifier, the public registry and the
// GitHub Action's files. No network: every endpoint is a mock; the in-memory EVM plays "chain 1".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getCreateAddress, ZeroAddress, Interface } from 'ethers';
import solc from 'solc';
import { createChain, ZETA } from './helpers/evm.js';
import { workMocks } from './helpers/workmocks.js';
import { k, core, sourceHashOf } from '../src/auditnet.js';
import * as aas from '../../zetaphy-hub/aas-core.js';
import { intake, codeHashOf } from '../src/aas/intake.js';
import { planOrder, paymentPlan } from '../src/aas/order.js';
import { parseRepo, parseCommit, matchCompiled, stripMetadata, repoRef } from '../src/aas/repo.js';
import { buildRegistry, badgesFor } from '../src/aas/registry.js';
import { sha256, SOURCIFY } from '../src/aas/net.js';
import { badgeStep } from '../../.github/actions/zetaphy-audit/badge.mjs';

const ROOT = new URL('../../', import.meta.url);
const DAY = 86400;
const word = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;
const addrWord = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const b64 = (u8) => Buffer.from(u8).toString('base64');

// ------------------------------------------------------------------ a fetch that answers like the public endpoints
function fakeFetch({ rpc = {}, get = {} }) {
  const calls = [];
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const f = async (url, init = {}) => {
    calls.push(url);
    if (init.method === 'POST') {
      const h = rpc[url];
      if (!h) return res(503, {});
      const req = JSON.parse(init.body);
      try { return res(200, { jsonrpc: '2.0', id: req.id, result: await h(req.method, req.params) }); } catch (e) { return res(200, { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: e.message } }); }
    }
    for (const [p, h] of Object.entries(get)) if (url.startsWith(p)) { const b = await h(url); return b == null ? res(404, {}) : res(200, b); }
    return res(404, {});
  };
  f.calls = calls;
  return f;
}
/** An EVM node: { code: {addr: hex}, slots: {addr: {slot: word}}, calls: {addr: {selector: ret}} }. */
const evmNode = (chainId, { code = {}, slots = {}, calls = {} }) => async (method, params) => {
  if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
  if (method === 'eth_getCode') return code[params[0].toLowerCase()] ?? '0x';
  if (method === 'eth_getStorageAt') return slots[params[0].toLowerCase()]?.[params[1]] ?? word(0);
  if (method === 'eth_call') { const r = calls[params[0].to.toLowerCase()]?.[params[0].data.slice(0, 10)]; if (r == null) throw new Error('execution reverted'); return r; }
  throw new Error(`no ${method}`);
};
const sourcifyBody = (name) => ({
  match: 'exact_match', runtimeMatch: 'exact_match', creationMatch: 'exact_match',
  sources: { [`src/${name}.sol`]: { content: `// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\ncontract ${name} {}\n` } },
  compilation: { compilerVersion: '0.8.26+commit.8a97fa7a', name, fullyQualifiedName: `src/${name}.sol:${name}` },
});

const VAULT = '0x' + '11'.repeat(20), PROXY = '0x' + '22'.repeat(20), IMPL = '0x' + '33'.repeat(20), CLONE = '0x' + '44'.repeat(20), BEACON = '0x' + '55'.repeat(20);
const CODE_V = '0x608060405260043610601c5760003560e01c80633ccfd60b14602157005b600080fd5b00a264697066735822122011';
const CODE_P = '0x60806040523661001357610011610017565b005b6100115b';
const CODE_I = '0x6080604052348015600f57600080fd5b5060aa8061001e6000396000f3fe';
const CODE_C = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;

const EVM_CHAINS = ['ethereum', 'bsc', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche', 'sepolia', 'bsc-testnet', 'base-sepolia', 'arbitrum-sepolia', 'optimism-sepolia', 'polygon-amoy', 'avalanche-fuji'];

test('the chains: every EVM chain of the brief (+ testnets), Osmosis and Solana; ids never collide with an EVM chain id', () => {
  for (const key of [...EVM_CHAINS, 'osmosis', 'osmo-test-5', 'solana', 'solana-devnet', 'zetaphy']) assert.ok(aas.chainOf(key), key);
  const ids = aas.AAS_CHAINS.map((c) => aas.aasChainId(c));
  assert.equal(new Set(ids.map(String)).size, ids.length);
  for (const c of aas.AAS_CHAINS.filter((x) => x.kind !== 'evm')) {
    assert.ok(aas.aasChainId(c) >= 9_000_000_000_000_000_000n && aas.aasChainId(c) < 2n ** 64n, `${c.key}: a uint64 far above EVM chain ids`);
    assert.equal(aas.chainOf(c.aasId), c);
  }
  assert.equal(aas.chainOf('8453').key, 'base');
  assert.equal(aas.chainOf('eip155:43114').key, 'avalanche');
  assert.equal(aas.chainOf('cosmos:osmosis-1').key, 'osmosis');
  for (const c of aas.AAS_CHAINS) for (const u of c.rpcs) assert.match(u, /^https:\/\//, `${c.key}: https public endpoints only`);
});

test('intake, EVM (each chain): EXTCODEHASH from a chain-id-checked RPC, source from Sourcify v2, the order Target', async () => {
  for (const key of EVM_CHAINS) {
    const chain = aas.chainOf(key);
    const url = `https://rpc.${key}.test`;
    const f = fakeFetch({ rpc: { [url]: evmNode(chain.chainId, { code: { [VAULT]: CODE_V } }) }, get: { [`${SOURCIFY}/v2/contract/${chain.chainId}/${VAULT}`]: () => sourcifyBody('Vault') } });
    const r = await intake({ chain: key, address: VAULT.toUpperCase().replace('0X', '0x'), fetchImpl: f, rpcs: [url] });
    assert.equal(r.targets.length, 1, key);
    const t = r.targets[0];
    assert.equal(t.role, 'contract');
    assert.equal(t.codeHash, codeHashOf(CODE_V));
    assert.equal(t.chainId, String(chain.chainId));
    assert.equal(t.target, VAULT);
    assert.equal(t.sourceRef, sourceHashOf({ 'src/Vault.sol': sourcifyBody('Vault').sources['src/Vault.sol'].content }));
    assert.equal(t.source.origin, 'sourcify');
    assert.equal(t.source.match, 'exact_match');
    assert.deepEqual(aas.parseOrderUri(t.uri), { chain: key, native: VAULT, role: 'contract', link: '' });
    assert.equal(r.ready, true, key);
    assert.deepEqual(r.warnings, []);
  }
});

test('intake refuses an RPC that serves another chain, an address without code, and a malformed address', async () => {
  const url = 'https://rpc.wrong.test';
  const wrong = fakeFetch({ rpc: { [url]: evmNode(1, { code: { [VAULT]: CODE_V } }) } });
  await assert.rejects(intake({ chain: 'base', address: VAULT, fetchImpl: wrong, rpcs: [url] }), /serves chain 1, not 8453/);
  const empty = fakeFetch({ rpc: { [url]: evmNode(8453, {}) } });
  await assert.rejects(intake({ chain: 'base', address: VAULT, fetchImpl: empty, rpcs: [url] }), /no contract/);
  await assert.rejects(intake({ chain: 'base', address: '0x1234', fetchImpl: empty, rpcs: [url] }), /address/);
  await assert.rejects(intake({ chain: 'tron', address: VAULT }), /not supported/);
  await assert.rejects(intake({ chain: 'base', address: VAULT, repo: 'acme/vault', fetchImpl: empty, rpcs: [url] }), /both --repo and --commit/);
});

test('intake, proxies: EIP-1967 (+admin), beacon and EIP-1167 clones order the proxy AND the implementation', async () => {
  const url = 'https://rpc.base.test';
  const both = { [`${SOURCIFY}/v2/contract/8453/${PROXY}`]: () => sourcifyBody('Proxy'), [`${SOURCIFY}/v2/contract/8453/${IMPL}`]: () => sourcifyBody('VaultV1'), [`${SOURCIFY}/v2/contract/8453/${CLONE}`]: () => sourcifyBody('Clone') };
  const node = evmNode(8453, {
    code: { [PROXY]: CODE_P, [IMPL]: CODE_I, [CLONE]: CODE_C, [BEACON]: CODE_P },
    slots: { [PROXY]: { [aas.EIP1967_IMPL]: addrWord(IMPL), [aas.EIP1967_ADMIN]: addrWord(VAULT) } },
    calls: { [BEACON]: { '0x5c60da1b': addrWord(IMPL) } },
  });
  let r = await intake({ chain: 'base', address: PROXY, fetchImpl: fakeFetch({ rpc: { [url]: node }, get: both }), rpcs: [url] });
  assert.deepEqual(r.targets.map((t) => [t.role, t.native, t.codeHash]), [['proxy', PROXY, codeHashOf(CODE_P)], ['implementation', IMPL, codeHashOf(CODE_I)]]);
  assert.deepEqual(r.proxy, { kind: 'eip1967', implementation: IMPL, admin: VAULT });
  assert.ok(r.warnings.some((w) => /upgradeable \(eip1967\).*CODE CHANGED/.test(w)));
  assert.equal(r.ready, true);
  // beacon: the slot names the beacon, the beacon names the implementation
  const PB = '0x' + '66'.repeat(20);
  const beaconNode = evmNode(8453, { code: { [PB]: CODE_P, [IMPL]: CODE_I }, slots: { [PB]: { [aas.EIP1967_BEACON]: addrWord(BEACON) } }, calls: { [BEACON]: { '0x5c60da1b': addrWord(IMPL) } } });
  r = await intake({ chain: 'base', address: PB, fetchImpl: fakeFetch({ rpc: { [url]: beaconNode }, get: { ...both, [`${SOURCIFY}/v2/contract/8453/${PB}`]: () => sourcifyBody('Beacon') } }), rpcs: [url] });
  assert.equal(r.proxy.kind, 'beacon');
  assert.equal(r.targets[1].native, IMPL);
  // EIP-1167: the implementation is in the code itself; a clone cannot be upgraded (no warning)
  r = await intake({ chain: 'base', address: CLONE, fetchImpl: fakeFetch({ rpc: { [url]: node }, get: both }), rpcs: [url] });
  assert.deepEqual(r.proxy, { kind: 'eip1167', implementation: IMPL });
  assert.deepEqual(r.targets.map((t) => t.role), ['proxy', 'implementation']);
  assert.deepEqual(r.warnings, []);
});

test('intake, EVM without Sourcify: repo + full commit, bound only when a compiled contract IS the deployed bytecode', async () => {
  const url = 'https://rpc.arb.test';
  const f = fakeFetch({ rpc: { [url]: evmNode(42161, { code: { [VAULT]: CODE_V } }) } });
  let r = await intake({ chain: 'arbitrum', address: VAULT, fetchImpl: f, rpcs: [url] });
  assert.equal(r.ready, false);
  assert.equal(r.targets[0].source.origin, 'none');
  assert.throws(() => planOrder({ intake: r, tier: 'basic', params: {}, pool: ZETA, auditNetwork: VAULT }), /no source bound/);
  const commit = 'a'.repeat(40);
  r = await intake({ chain: 'arbitrum', address: VAULT, repo: 'https://github.com/acme/vault.git', commit, fetchImpl: f, rpcs: [url], runtimes: { 'src/Vault.sol:Vault': CODE_V } });
  assert.equal(r.targets[0].source.match, 'exact');
  assert.equal(r.targets[0].sourceRef, `github.com/acme/vault@${commit}`);
  assert.equal(r.targets[0].sourceHash, aas.sourceRefHash(k, `github.com/acme/vault@${commit}`));
  assert.equal(r.ready, true);
  // same code, another metadata hash (a comment / path changed): still the same code
  // runtime + CBOR metadata { ipfs: 0x1220<32 bytes>, solc: 0.8.26 } + its length (0x0033)
  const meta = (h) => `0x6080604052600080fdfea2646970667358221220${h.repeat(64)}64736f6c634300081a0033`;
  assert.equal(stripMetadata(meta('1')), stripMetadata(meta('2')));
  assert.deepEqual(matchCompiled({ 'A.sol:A': meta('1') }, meta('2'), codeHashOf), { match: 'metadata', contract: 'A.sol:A' });
  r = await intake({ chain: 'arbitrum', address: VAULT, repo: 'acme/vault', commit, fetchImpl: f, rpcs: [url], runtimes: { 'src/Other.sol:Other': CODE_I } });
  assert.equal(r.targets[0].source.match, 'none');
  assert.equal(r.ready, false);
  assert.ok(r.warnings.some((w) => /no contract compiled from github.com\/acme\/vault@a{40} has this bytecode/.test(w)));
  for (const bad of ['acme', 'acme/vault/x', 'https://gitlab.com/acme/vault', 'ac me/vault', 'acme/..']) assert.throws(() => parseRepo(bad), /repo/, bad);
  for (const bad of ['main', 'v1.0.0', 'abc123', 'g'.repeat(40)]) assert.throws(() => parseCommit(bad), /commit/, bad);
  assert.equal(repoRef(parseRepo('github.com/Acme/Vault'), commit), `github.com/Acme/Vault@${commit}`);
});

test('intake, CosmWasm (Osmosis, osmo-test-5): the code checksum from the LCD (base64 or hex), admin = migratable, optimizer checksums.txt', async () => {
  const wasm = Buffer.from('\0asm\x01\0\0\0 a contract');
  const sum = createHash('sha256').update(wasm).digest();
  const ADDR = `osmo1${'q'.repeat(58)}`;
  for (const [key, lcd, newApi] of [['osmosis', 'https://lcd.osmo.test', true], ['osmo-test-5', 'https://lcd.osmotest.test', false]]) {
    const f = fakeFetch({ get: {
      [`${lcd}/cosmwasm/wasm/v1/contract/${ADDR}`]: () => ({ address: ADDR, contract_info: { code_id: '42', creator: `osmo1${'c'.repeat(38)}`, admin: `osmo1${'a'.repeat(38)}`, label: 'vault' } }),
      [`${lcd}/cosmwasm/wasm/v1/code-info/42`]: () => (newApi ? { code_id: '42', checksum: b64(sum) } : null),
      [`${lcd}/cosmwasm/wasm/v1/code/42`]: () => ({ code_info: { code_id: '42', data_hash: sum.toString('hex').toUpperCase() }, data: b64(wasm) }),
    } });
    const r = await intake({ chain: key, address: ADDR, repo: 'acme/osmo-vault', commit: 'b'.repeat(40), checksumsTxt: `${sum.toString('hex')}  vault.wasm\n`, wasmFile: 'vault.wasm', fetchImpl: f, rpcs: [lcd] });
    const t = r.targets[0];
    assert.equal(t.codeHash, `0x${sum.toString('hex')}`, key);
    assert.equal(t.chainId, aas.chainOf(key).aasId);
    assert.equal(t.target, aas.targetOf(k, aas.chainOf(key), ADDR));
    assert.match(t.target, /^0x[0-9a-f]{40}$/);
    assert.equal(t.source.match, 'exact');
    assert.equal(r.cosmwasm.codeId, '42');
    assert.ok(r.warnings.some((w) => /migratable/.test(w)));
    assert.equal(r.ready, true);
    assert.deepEqual(aas.parseOrderUri(t.uri), { chain: key, native: ADDR, role: 'contract', link: `https://github.com/acme/osmo-vault/tree/${'b'.repeat(40)}` });
  }
  const f = fakeFetch({ get: {
    'https://l.test/cosmwasm/wasm/v1/contract/': () => ({ contract_info: { code_id: '42', admin: '' } }),
    'https://l.test/cosmwasm/wasm/v1/code-info/42': () => ({ checksum: sum.toString('hex') }),
  } });
  const r = await intake({ chain: 'osmosis', address: ADDR, repo: 'acme/osmo-vault', commit: 'b'.repeat(40), checksumsTxt: `${'0'.repeat(64)}  vault.wasm`, wasmFile: 'vault.wasm', fetchImpl: f, rpcs: ['https://l.test'] });
  assert.equal(r.targets[0].source.match, 'none', 'checksums.txt of another build');
  assert.equal(r.ready, false);
  assert.ok(!r.warnings.some((w) => /migratable/.test(w)), 'no admin: not migratable');
});

/** A Solana cluster with one upgradeable program: Program -> ProgramData (header + ELF + zero padding). */
function solanaCluster({ genesis, programId, elf, authority = new Uint8Array(32).fill(7) }) {
  const pda = new Uint8Array(32).fill(9);
  const pdaId = aas.base58Encode(pda);
  const program = new Uint8Array(36); program[0] = 2; program.set(pda, 4);
  const header = new Uint8Array(45); header[0] = 3; header[4] = 0x39; header[5] = 0x30; header[12] = authority ? 1 : 0; if (authority) header.set(authority, 13);
  const data = new Uint8Array([...header, ...elf, ...new Uint8Array(100)]);
  return {
    pdaId,
    node: async (method, params) => {
      if (method === 'getGenesisHash') return genesis;
      if (method === 'getAccountInfo' && params[0] === programId) return { value: { executable: true, owner: aas.BPF_UPGRADEABLE_LOADER, data: [b64(program), 'base64'] } };
      if (method === 'getAccountInfo' && params[0] === pdaId) return { value: { executable: false, owner: aas.BPF_UPGRADEABLE_LOADER, data: [b64(data), 'base64'] } };
      return { value: null };
    },
  };
}

test('intake, Solana: the solana-verify program hash from the program-data account, genesis checked, OtterSec verified builds', async () => {
  const programId = aas.base58Encode(new Uint8Array(32).fill(5));
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 0, 0, 4]);
  const hash = `0x${createHash('sha256').update(elf).digest('hex')}`;
  const MAIN = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  const c = solanaCluster({ genesis: MAIN, programId, elf });
  const commit = 'c'.repeat(40);
  const f = fakeFetch({ rpc: { 'https://sol.test': c.node }, get: { [`https://verify.osec.io/status/${programId}`]: () => ({ is_verified: true, on_chain_hash: hash.slice(2), executable_hash: hash.slice(2), repo_url: 'https://github.com/acme/prog', commit }) } });
  const r = await intake({ chain: 'solana', programId, fetchImpl: f, rpcs: ['https://sol.test'] });
  const t = r.targets[0];
  assert.equal(t.codeHash, hash, 'sha256 of the ELF, trailing zeros trimmed (solana-verify get-program-hash)');
  assert.equal(t.role, 'program');
  assert.equal(t.chainId, aas.chainOf('solana').aasId);
  assert.equal(t.source.origin, 'solana-verify');
  assert.equal(t.sourceRef, `github.com/acme/prog@${commit}`);
  assert.equal(r.solana.programData, c.pdaId);
  assert.equal(r.solana.slot, String(0x3039));
  assert.ok(r.warnings.some((w) => /upgradeable/.test(w)));
  assert.equal(r.ready, true);
  // OtterSec knows another hash (an upgrade since): not trusted, falls back to repo + commit
  const f2 = fakeFetch({ rpc: { 'https://sol.test': c.node }, get: { 'https://verify.osec.io/status/': () => ({ is_verified: true, on_chain_hash: 'ab'.repeat(32), repo_url: 'https://github.com/acme/prog', commit }) } });
  const r2 = await intake({ chain: 'solana', programId, repo: 'acme/prog', commit, fetchImpl: f2, rpcs: ['https://sol.test'] });
  assert.equal(r2.targets[0].source.origin, 'repo');
  assert.equal(r2.targets[0].source.match, 'pending', 'the runners rebuild it with solana-verify');
  // a devnet program on a node that serves mainnet: refused
  await assert.rejects(intake({ chain: 'solana-devnet', programId, fetchImpl: f, rpcs: ['https://sol.test'] }), /another cluster/);
  // the wrong kind of account
  const notProgram = fakeFetch({ rpc: { 'https://sol.test': async (m) => (m === 'getGenesisHash' ? MAIN : { value: { executable: false, owner: '11111111111111111111111111111111', data: ['', 'base64'] } }) } });
  await assert.rejects(intake({ chain: 'solana', programId, fetchImpl: notProgram, rpcs: ['https://sol.test'] }), /not a program/);
});

test('tiers and payment: fast is free and orders nothing; terms follow AuditNetwork; another chain pays on ZETAPHY', () => {
  const params = { minContest: 3 * DAY, maxContest: 30 * DAY, minAuditorsFloor: 2, feeBps: 1000, runnerBps: 5000, minPool: ZETA };
  const intakeOk = { targets: [{ role: 'contract', native: VAULT, target: VAULT, chainId: '8453', codeHash: codeHashOf(CODE_V), sourceHash: '0x' + '5c'.repeat(32), uri: 'zaas1|base|' + VAULT + '|contract|', source: { origin: 'sourcify', match: 'exact_match' } }] };
  assert.throws(() => planOrder({ intake: intakeOk, tier: 'fast', params, pool: ZETA, auditNetwork: VAULT }), /free automated run/);
  const b = planOrder({ intake: intakeOk, tier: 'basic', params, pool: 10n * ZETA, auditNetwork: VAULT });
  assert.equal(b.requests[0].terms.contest, 3 * DAY);
  assert.equal(b.requests[0].terms.minAuditors, 2);
  assert.ok(b.requests[0].terms.pool >= 10n * ZETA && b.requests[0].terms.fee === b.requests[0].value - b.requests[0].terms.pool);
  const d = planOrder({ intake: intakeOk, tier: 'deep', params, pool: 10n * ZETA, auditNetwork: VAULT });
  assert.deepEqual([d.requests[0].terms.tier, d.requests[0].terms.contest, d.requests[0].terms.minAuditors], [2, 17 * DAY, 6]);
  assert.throws(() => aas.orderTerms(params, 'standard', { pool: ZETA, contestDays: 3 }), /at least 10 days/);
  assert.throws(() => aas.orderTerms(params, 'basic', { pool: ZETA / 2n }), /at least/);
  assert.equal(paymentPlan('zetaphy').direct, true);
  const p = paymentPlan('sepolia');
  assert.equal(p.hyperlane, true);
  assert.match(p.steps[0], /carries tokens, not native ZETAPHY/);
  assert.equal(paymentPlan('solana').direct, false);
});

// ------------------------------------------------------------------ on the real contracts
let kitCache = null;
function kit() {
  if (kitCache) return kitCache;
  const sources = { 'AuditVerifiedKit.sol': { content: readFileSync(new URL('./helpers/AuditVerifiedKit.sol', import.meta.url), 'utf8') },
    'contracts/AuditVerified.sol': { content: readFileSync(new URL('../contracts/AuditVerified.sol', import.meta.url), 'utf8') } };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  kitCache = Object.fromEntries(Object.entries(out.contracts['AuditVerifiedKit.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return kitCache;
}

const PARAMS = { minContest: 3 * DAY, maxContest: 30 * DAY, revealWindow: DAY, judgeWindow: 2 * DAY, appealWindow: 2 * DAY, appealTimeout: 7 * DAY,
  unbondDelay: DAY, minAuditorsFloor: 2, slashBps: 2000, feeBps: 1000, runnerBps: 5000, participationBps: 1000, maxFindingsPerAuditor: 5, auditorBond: 10n * ZETA, minPool: ZETA };
const JPARAMS = { judgeQuorum: 3, maxJudges: 9, judgeMinScore: 0, unbondDelay: DAY, judgeBond: 20n * ZETA, appealBond: 5n * ZETA };
const LEVELS = { validity: 30 * DAY, silverAuditors: 3, goldAuditors: 5, silverContest: 7 * DAY, goldContest: 14 * DAY, silverMutationBps: 7000, goldMutationBps: 8500 };
const GOOD = { resultHash: '0x' + '7e'.repeat(32), critHigh: 0, invFailed: 0, invNotRun: 0, mutationBps: 9000 };
const salt = (n) => word(n);
const h = (s) => core.keccakHex(k, new TextEncoder().encode(s));

async function world() {
  const c = await createChain(['gov', 'treasury', 'sponsor', 'x', 'a1', 'a2', 'j1', 'j2', 'j3', 'r1', 'r2', 'r3']);
  const A = (n) => c.acct[n].toString();
  const jobs = await c.deployRaw(workMocks().MockRunners, [], 'gov');
  for (const r of ['r1', 'r2', 'r3']) await jobs.send('gov', 'set', [A(r), true, 5, 0]);
  const rep = await c.deploy('WorkerReputation', [A('gov'), jobs.address, ZeroAddress], 'gov');
  const n = await c.nonce('gov');
  const at = (i) => getCreateAddress({ from: A('gov'), nonce: n + BigInt(i) });
  const net = await c.deploy('AuditNetwork', [A('gov'), A('treasury'), rep.address, at(1), at(2), at(3), PARAMS], 'gov');
  const run = await c.deploy('AuditRunners', [net.address, jobs.address, rep.address, 1], 'gov');
  const jud = await c.deploy('AuditJudges', [net.address, rep.address, A('gov'), JPARAMS], 'gov');
  const cert = await c.deploy('AuditCertificate', [net.address, run.address, jud.address, A('gov'), LEVELS], 'gov');
  await rep.send('gov', 'setReporter', [net.address, true]);
  await rep.send('gov', 'setReporter', [run.address, true]);
  for (const a of ['a1', 'a2']) await net.send(a, 'bond', [], 10n * ZETA);
  for (const j of ['j1', 'j2', 'j3']) await jud.send(j, 'bond', [], 20n * ZETA);
  const logs = [];
  const tx = async (from, to, data, value = 0n) => {
    const r = await c.rawTx(from, to, data, value);
    assert.ok(r.ok, 'transaction reverted');
    for (const l of r.logs) logs.push({ ...l, blockNumber: `0x${c.blockNumber().toString(16)}` });
    return r;
  };
  // "chain 1" as a public endpoint would serve it (eth_getLogs over what the transactions above emitted)
  const rpc = async (method, params = []) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_blockNumber') return `0x${c.blockNumber().toString(16)}`;
    if (method === 'eth_getCode') return c.getCode(params[0]);
    if (method === 'eth_getStorageAt') return c.getStorage(params[0], params[1]);
    if (method === 'eth_call') return c.rawCallHex(params[0].to, params[0].data);
    if (method === 'eth_getLogs') {
      const q = params[0];
      return logs.filter((l) => l.address.toLowerCase() === q.address.toLowerCase() && BigInt(l.blockNumber) >= BigInt(q.fromBlock) && BigInt(l.blockNumber) <= BigInt(q.toBlock)
        && (q.topics ?? []).every((t, i) => t == null || t.toLowerCase() === l.topics[i]?.toLowerCase()));
    }
    throw new Error(`no ${method}`);
  };
  const fetchImpl = fakeFetch({ rpc: { 'https://chain1.test': rpc }, get: { [`${SOURCIFY}/v2/contract/1/`]: () => sourcifyBody('Verified') } });
  return { c, A, net, run, jud, cert, rep, tx, rpc, fetchImpl, logs };
}

/** Contest (2 auditors, no findings), an agreeing automated tier, settle, certify — for request `id`. */
async function passAudit(w, id) {
  for (const a of ['a1', 'a2']) await w.net.send(a, 'commitReport', [id, core.reportCommitment(k, h(`r ${a} ${id}`), w.A(a), salt(1), id)]);
  for (const r of ['r1', 'r2', 'r3']) await w.run.send(r, 'commit', [id, core.runCommitment(k, GOOD, w.A(r), salt(7), id)]);
}
async function finish(w, ids) {
  for (const id of ids) {
    for (const a of ['a1', 'a2']) await w.net.send(a, 'revealReport', [id, h(`r ${a} ${id}`), salt(1)]);
    for (const r of ['r1', 'r2', 'r3']) await w.run.send(r, 'reveal', [id, GOOD, salt(7)]);
  }
  w.c.advance(DAY + 2 * DAY + 2 * DAY);
  for (const id of ids) {
    await w.run.send('x', 'settle', [id]);
    await w.net.send('x', 'settle', [id]);
    assert.equal(Number(await w.cert.call('check', [id])), 0, `request ${id} certifiable`);
    await w.tx('x', w.cert.address, core.calldata(k, core.SIG.certify, [id]));
  }
}

test('end to end on chain 1: intake a proxy -> two AuditNetwork orders -> certificates -> NeuroOracle mirror -> AuditVerified; an implementation swap is CODE CHANGED; the registry', async () => {
  const w = await world();
  const K = kit();
  const implA = await w.c.deployRaw(K.AVImplA, [], 'gov');
  const implB = await w.c.deployRaw(K.AVImplB, [], 'gov');
  const proxy = await w.c.deployRaw(K.AVProxy, [implA.address], 'gov');
  const P = proxy.address.toLowerCase(), IA = implA.address.toLowerCase(), IB = implB.address.toLowerCase();

  // 1. intake through "public endpoints" of chain 1 (Sourcify mocked as verified)
  const r = await intake({ chain: 'ethereum', address: P, fetchImpl: w.fetchImpl, rpcs: ['https://chain1.test'], link: 'https://github.com/acme/vault' });
  assert.deepEqual(r.targets.map((t) => [t.role, t.native]), [['proxy', P], ['implementation', IA]]);
  assert.equal(r.targets[0].codeHash, codeHashOf(await w.c.getCode(P)));
  assert.equal(r.targets[1].codeHash, codeHashOf(await w.c.getCode(IA)));
  assert.equal(r.proxy.kind, 'eip1967');

  // 2. the order: the calldata planOrder writes is accepted by AuditNetwork as is
  const params = core.decodeParams(await w.c.rawCallHex(w.net.address, core.calldata(k, core.SIG.getParams)));
  const plan = planOrder({ intake: r, tier: 'basic', params, pool: 2n * ZETA, auditNetwork: w.net.address });
  assert.equal(plan.requests.length, 2);
  for (const q of plan.requests) await w.tx('sponsor', q.to, q.data, q.value);
  assert.equal(await w.net.call('requestCount'), 2n);
  const req0 = core.decodeRequest(await w.c.rawCallHex(w.net.address, core.calldata(k, core.SIG.getRequest, [0n])));
  assert.equal(req0.chainId, 1n);
  assert.equal(req0.target.toLowerCase(), P);
  assert.equal(req0.codeHash, r.targets[0].codeHash);
  // a Solana program orders the same way (its stand-in target, chain id 9e18+): accepted, no EXTCODEHASH check
  const sol = aas.chainOf('solana');
  const progId = aas.base58Encode(new Uint8Array(32).fill(5));
  const solTarget = { role: 'program', native: progId, target: aas.targetOf(k, sol, progId), chainId: sol.aasId, codeHash: '0x' + 'ab'.repeat(32), sourceHash: '0x' + 'cd'.repeat(32), uri: aas.orderUri({ chain: sol, native: progId, role: 'program' }), source: { origin: 'repo', match: 'pending' } };
  const solPlan = planOrder({ intake: { targets: [solTarget] }, tier: 'basic', params, pool: 2n * ZETA, auditNetwork: w.net.address });
  await w.tx('sponsor', w.net.address, solPlan.requests[0].data, solPlan.requests[0].value);
  assert.equal(core.decodeRequest(await w.c.rawCallHex(w.net.address, core.calldata(k, core.SIG.getRequest, [2n]))).chainId, BigInt(sol.aasId));

  // 3. audits pass; certificates for the proxy and its implementation
  for (const id of [0n, 1n]) await passAudit(w, id);
  w.c.advance(3 * DAY);
  await finish(w, [0n, 1n]);
  assert.equal(await w.cert.call('isCertified', [1n, P]), true);
  assert.equal(await w.cert.call('isCertified', [1n, IA]), true);

  // 4. the mirror on the "project's chain" (here the same EVM: chain 1)
  const zMail = await w.c.deploy('MockMailbox', [77390], 'gov');
  const dMail = await w.c.deploy('MockMailbox', [1], 'gov');
  const sender = await w.c.deploy('NeuroOracleSender', [w.net.address, ZeroAddress, zMail.address, w.A('gov')], 'gov');
  const b32 = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
  const oracle = await w.c.deploy('NeuroOracle', [dMail.address, 77390, 1n, b32(sender.address), w.net.address, w.A('gov'), ZeroAddress], 'gov');
  await sender.send('gov', 'setReceiver', [1, b32(oracle.address)]);
  await sender.send('gov', 'setAudit', [w.cert.address]);
  for (const t of [P, IA]) {
    await sender.send('x', 'pushCertificate', [1, 1n, t]);
    await dMail.send('x', 'deliver', [77390, b32(sender.address), oracle.address, await w.cert.call('certificateBody', [1n, t])]);
  }
  const router = await w.c.deployRaw(K.AVRouter, [oracle.address], 'gov');
  assert.equal(await router.call('verified', [P]), true);
  assert.equal(await router.call('verified', [IA]), true);
  assert.equal(await router.call('verified', [IB]), false);
  assert.equal(await router.call('list', [P]), true);
  assert.equal(Number(await router.call('level', [P])), 1, 'bronze: 2 auditors, the minimum contest');
  await assert.rejects(router.call('listGold', [P]), /LevelTooLow/);
  await assert.rejects(router.call('list', [IB]), /NotCertified/);
  assert.equal(await router.call('listProxy', [P, ZeroAddress, IA]), true);
  // a router that reads a mirror that does not exist fails closed
  const nowhere = await w.c.deployRaw(K.AVRouter, ['0x' + '99'.repeat(20)], 'gov');
  assert.equal(await nowhere.call('verified', [P]), false);

  // the JS verifier (hub page, `zetaphy aas verify`) agrees
  const verify = (address) => aas.verifyCertificate({ k, sha256, chain: aas.chainOf('ethereum'), address, certificate: w.cert.address, now: Number(w.c.now()),
    zcall: (to, data) => w.c.rawCallHex(to, data), rpc: w.rpc, mirror: { oracle: oracle.address, call: (to, data) => w.c.rawCallHex(to, data) } });
  let v = await verify(P);
  assert.deepEqual([v.status, v.reason, v.level, v.mirror], ['valid', 'ok', 1, true]);
  assert.equal(v.impl.address, IA);

  // 5. the proxy's admin swaps the implementation: the proxy's OWN code (and EXTCODEHASH) did not change ...
  await proxy.send('gov', 'upgradeTo', [IB]);
  assert.equal(await router.call('verified', [P]), true, 'a plain isCertified(proxy) cannot see an implementation swap');
  // ... so the proxy check, the hub page and the CLI all compare the implementation too
  await assert.rejects(router.call('listProxy', [P, ZeroAddress, IA]), /ImplementationChanged/);
  v = await verify(P);
  assert.deepEqual([v.status, v.reason], ['code_changed', 'implementationUncertified']);
  // a certified implementation whose code was replaced in place (EXTCODEHASH differs): CODE CHANGED, the mirror says no
  await proxy.send('gov', 'upgradeTo', [IA]);
  assert.equal((await verify(P)).status, 'valid', 'back to the certified implementation');
  await w.c.putCode(IA, '0x6001600055');
  v = await verify(IA);
  assert.deepEqual([v.status, v.reason, v.mirror], ['code_changed', 'code', false]);
  assert.equal((await verify(P)).reason, 'implementation_code_changed');
  assert.equal(await router.call('verified', [IA]), false, 'the mirror re-checks EXTCODEHASH on its own chain');
  // expiry
  w.c.advance(31 * DAY);
  assert.equal((await verify(P)).status, 'expired');

  // 6. the public registry, from ZETAPHY's events only (here: chain 1 plays ZETAPHY too)
  const { registry, badges } = await buildRegistry({ rpc: w.rpc, certificate: w.cert.address, network: w.net.address, fromBlock: 0, chunk: 50, now: Number(w.c.now()) - 31 * DAY });
  assert.equal(registry.entries.length, 2);
  const pe = registry.entries.find((e) => e.role === 'proxy');
  assert.equal(pe.address, P);
  assert.equal(pe.implementation, IA, 'the proxy entry names its certified implementation');
  assert.equal(pe.report, 'https://github.com/acme/vault');
  assert.equal(pe.level, 1);
  assert.deepEqual(pe.findings, { open: 0, valid: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, late: 0, fixed: 0 });
  assert.deepEqual(aas.cleanRegistry(JSON.parse(JSON.stringify(registry))), registry, 'the registry passes its own validator');
  assert.deepEqual(Object.keys(badges).sort(), [`ethereum-${IA}.svg`, `ethereum-${P}.svg`].sort());
  assert.match(badges[`ethereum-${P}.svg`], /VALID · BRONZE/);
  assert.match(badgesFor(registry, Number(w.c.now()))[`ethereum-${P}.svg`], /EXPIRED/);
});

test('the reusable GitHub Action: composite, pinned, no secrets, inputs never interpolated into scripts; the badge step', () => {
  const action = readFileSync(new URL('.github/actions/zetaphy-audit/action.yml', ROOT), 'utf8');
  const reusable = readFileSync(new URL('.github/workflows/audit-reusable.yml', ROOT), 'utf8');
  const registryWf = readFileSync(new URL('.github/workflows/audit-registry.yml', ROOT), 'utf8');
  for (const [name, y] of [['action.yml', action], ['audit-reusable.yml', reusable], ['audit-registry.yml', registryWf]]) {
    assert.doesNotMatch(y, /\$\{\{[^}]*secrets\./, `${name}: needs no secrets`);
    assert.doesNotMatch(y, /\t/, `${name}: no tabs`);
    for (const m of y.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)) assert.match(m[1], /^(\.\/|[\w.-]+\/[\w./-]+@[0-9a-f]{40}$)/, `${name}: ${m[1]} pinned to a commit`);
    // ${{ inputs.* }} / ${{ github.* }} only in with:/env:/if:, never inside a run: script (script injection)
    const lines = y.split('\n');
    let inRun = false, runIndent = 0;
    for (const line of lines) {
      const ind = line.search(/\S/);
      if (inRun && ind >= 0 && ind <= runIndent) inRun = false;
      if (/^\s*(- )?run: \|/.test(line)) { inRun = true; runIndent = ind; continue; }
      const oneLine = /^\s*(- )?run: (?!\|)(.*)$/.exec(line);
      if ((inRun || oneLine) && /\$\{\{/.test(oneLine ? oneLine[2] : line)) assert.fail(`${name}: expression inside a run script: ${line.trim()}`);
    }
  }
  assert.match(action, /^runs:\n {2}using: composite$/m);
  assert.match(action, /audit\/tools\/install\.sh/);
  assert.match(action, /audit\/run\.sh" --target/);
  assert.match(action, /upload-sarif@/);
  for (const out of ['status', 'critical', 'high', 'gate', 'summary-json', 'sarif', 'badge']) assert.match(action, new RegExp(`^ {2}${out}:\\n {4}description`, 'm'), `output ${out}`);
  for (const m of action.matchAll(/steps\.(\w+)\.outputs/g)) assert.match(action, new RegExp(`id: ${m[1]}\\b`), `step ${m[1]} exists`);
  assert.match(reusable, /^ {2}workflow_call:/m);
  assert.match(reusable, /^permissions: \{\}$/m);
  assert.match(reusable, /ref: \$\{\{ github\.job_workflow_sha \}\}/, 'the pipeline at the commit the caller pinned');
  assert.match(registryWf, /contents: write/);
  // a real YAML parser, when this machine has one (CI images do)
  const py = spawnSync('python3', ['-c', 'import sys,yaml,json\nfor f in sys.argv[1:]: json.dump(yaml.safe_load(open(f)), sys.stdout); print()',
    ...['.github/actions/zetaphy-audit/action.yml', '.github/workflows/audit-reusable.yml', '.github/workflows/audit-registry.yml'].map((f) => new URL(f, ROOT).pathname)], { encoding: 'utf8' });
  if (py.status === 0) {
    const [a, rw, reg] = py.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(a.runs.using, 'composite');
    assert.ok(a.runs.steps.filter((s) => s.run).every((s) => s.shell === 'bash'), 'composite run steps name their shell');
    const on = (x) => x.on ?? x.true; // YAML 1.1 reads the key `on` as true
    assert.deepEqual(Object.keys(on(rw).workflow_call.inputs).sort(), ['fail-on', 'path', 'tier', 'triage', 'upload-sarif']);
    assert.ok(on(reg).schedule[0].cron);
  }
  // the badge / gate step
  const open = (severity, status = 'open') => ({ severity, status });
  let b = badgeStep({ commit: 'abc', findings: [open('medium'), open('high', 'triaged')], invariants: { failed: 0 } }, 'high');
  assert.deepEqual([b.outputs.status, b.outputs.gate, b.failed], ['scanned', 'passed', false]);
  assert.match(b.svg, /ZETAPHY scan/);
  b = badgeStep({ findings: [open('high')] }, 'high');
  assert.deepEqual([b.outputs.status, b.outputs.high, b.failed], ['issues', 1, true]);
  assert.equal(badgeStep({ findings: [open('high')] }, 'critical').failed, false);
  assert.equal(badgeStep({ findings: [open('critical', 'accepted')] }, 'none').failed, false);
  assert.throws(() => badgeStep({}, 'medium'), /fail-on/);
  assert.ok(existsSync(new URL('audit/tools/install.sh', ROOT)) && existsSync(new URL('audit/run.sh', ROOT)));
});

test('CLI: `zetaphy aas` is wired, prints its chains and usage, and needs the deployment for order / verify', async () => {
  const { main } = await import('../cli.js');
  const out = [];
  const write = (s) => out.push(String(s));
  assert.equal(await main(['aas', 'chains'], { ...process.env, ZETAPHY_HOME: '/nonexistent-zetaphy-home' }, write), 0);
  assert.ok(out.some((l) => /^solana\s+solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp\s+solana\s+program hash/.test(l)));
  assert.ok(out.some((l) => /^osmosis\s+cosmos:osmosis-1\s+cosmwasm\s+wasm checksum/.test(l)));
  out.length = 0;
  assert.equal(await main(['aas', 'pay', '--from', 'base-sepolia'], process.env, write), 0);
  assert.match(out.join('\n'), /Hyperlane route, but it carries tokens/);
});
