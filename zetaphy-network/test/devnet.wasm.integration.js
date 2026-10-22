// CosmWasm (Rust contracts) on a real ZETAPHY chain (zetaphyd built from
// zetaphy-chain/setup-node.sh; 1 s blocks, 20 s votes):
//   1. a new chain stores code by governance only: a direct upload is refused;
//   2. gov.sh wasm-store puts cw20-base (CosmWasm's published build, sha256
//      pinned below) in a proposal; it passes and the stored code hash matches;
//   3. anyone instantiates it: a token with an initial balance, a transfer
//      between two MetaMask-made accounts, balances read back by query;
//   4. a wasm tx pays its fee in azetaphy and half of it is burned, as for
//      every other tx.
// Needs a zetaphyd with x/wasm: ZETAPHYD=/path/to/zetaphyd npm run test:devnet:wasm

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';

const ZETAPHYD = process.env.ZETAPHYD || 'zetaphyd';
const PORT = 25545; // EVM JSON-RPC; scripts/devnet.sh also uses +1 and +100..+103
const CHAIN_ID = 'zetaphy-local-1';
// cw20-base v2.0.0 from github.com/CosmWasm/cw-plus releases (its checksums.txt).
const CW20_URL = 'https://github.com/CosmWasm/cw-plus/releases/download/v2.0.0/cw20_base.wasm';
const CW20_SHA256 = '4d8e90dd340993033f1b9e8e3a3ee7f8673c582ca9bcdd8c8cf3c7470d6537d5';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-wasm-'));
const chainHome = join(root, 'chain');
const actors = Object.fromEntries(['alice', 'bob'].map((n) => [n, Wallet.createRandom()]));
const env = { ...process.env, ZETAPHYD, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
const NODE = `tcp://127.0.0.1:${PORT + 100}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const govEnv = { ...env, NODE_HOME: chainHome, KEYS_DIR: chainHome, NODE, CHAIN_ID };
const gov = (...a) => execFileSync(new URL('../../zetaphy-chain/gov.sh', import.meta.url).pathname, a, { env: govEnv, encoding: 'utf8' });
const z = (...a) => execFileSync(ZETAPHYD, a, { env, encoding: 'utf8', maxBuffer: 64 << 20 });
const q = (...a) => JSON.parse(z('q', ...a, '--node', NODE, '-o', 'json'));
const bech = {};
let cw20File, codeId, token;

/** A tx from a keyring key; waits for its block and returns the result. A
 * tx refused already in simulation comes back as {code: -1, raw_log}. */
async function tx(from, ...a) {
  let out;
  try {
    out = execFileSync(ZETAPHYD, ['tx', ...a, '--from', from, '--home', chainHome, '--keyring-backend', 'test', '--node', NODE,
      '--chain-id', CHAIN_ID, '--gas', 'auto', '--gas-adjustment', '1.5', '--gas-prices', '1000000000azetaphy', '-y', '-o', 'json'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { code: -1, raw_log: `${e.stderr}${e.stdout}` };
  }
  const sent = JSON.parse(out.trim().split('\n').pop());
  if (sent.code !== 0) return sent;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try { return q('tx', sent.txhash); } catch { /* not in a block yet */ }
  }
  throw new Error(`tx ${sent.txhash} not found`);
}

async function passed(out) {
  const id = /proposal (\d+) submitted/.exec(out)?.[1];
  assert.ok(id, out);
  assert.match(gov('vote', id, 'yes'), /voted yes/);
  let st;
  for (let i = 0; i < 60; i++) {
    st = JSON.parse(gov('status', id));
    if (st.status !== 'PROPOSAL_STATUS_VOTING_PERIOD' && st.status !== 'PROPOSAL_STATUS_DEPOSIT_PERIOD') break;
    await sleep(1000);
  }
  const full = q('gov', 'proposal', id).proposal;
  assert.equal(st.status, 'PROPOSAL_STATUS_PASSED', `proposal ${id}: ${st.status} ${full.failed_reason ?? ''}`);
}

const cw20 = (query) => q('wasm', 'contract-state', 'smart', token, JSON.stringify(query)).data;

before(async () => {
  // The published contract, checked against its pinned sha256 (cached between runs).
  cw20File = join(tmpdir(), `cw20_base-${CW20_SHA256.slice(0, 16)}.wasm`);
  if (!existsSync(cw20File) || createHash('sha256').update(readFileSync(cw20File)).digest('hex') !== CW20_SHA256) {
    const res = await fetch(CW20_URL);
    assert.ok(res.ok, `download ${CW20_URL}: ${res.status}`);
    const bz = Buffer.from(await res.arrayBuffer());
    assert.equal(createHash('sha256').update(bz).digest('hex'), CW20_SHA256, 'cw20_base.wasm sha256');
    writeFileSync(cw20File, bz);
  }
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname, [chainHome, String(PORT), ...Object.values(actors).map((w) => w.address)],
    { stdio: 'inherit', env });
  for (const [n, w] of Object.entries(actors)) {
    // The chain's keyring gets the same mnemonic (eth_secp256k1, MetaMask's path), on stdin.
    execFileSync(ZETAPHYD, ['keys', 'add', n, '--recover', '--algo', 'eth_secp256k1', '--keyring-backend', 'test', '--home', chainHome],
      { env, input: w.mnemonic.phrase + '\n', stdio: ['pipe', 'ignore', 'ignore'] });
    bech[n] = z('keys', 'show', n, '-a', '--keyring-backend', 'test', '--home', chainHome).trim();
    assert.match(z('debug', 'addr', bech[n]), new RegExp(`Address hex: ${w.address}`, 'i'));
  }
});

after(async () => {
  try { process.kill(Number(readFileSync(join(chainHome, 'node.pid'), 'utf8'))); } catch { /* gone */ }
  await sleep(1000);
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test('a new chain: code upload by governance only, instantiate by everybody', async () => {
  const r0 = q('wasm', 'params'); const p = r0.params ?? r0;
  assert.equal(p.code_upload_access.permission, 'Nobody');
  assert.equal(p.instantiate_default_permission, 'Everybody');
  assert.match(z('q', 'wasm', 'libwasmvm-version'), /3\.0\./);
  const r = await tx('alice', 'wasm', 'store', cw20File);
  assert.notEqual(r.code, 0, 'a direct upload is refused');
  assert.match(r.raw_log, /unauthorized/i, r.raw_log);
  assert.equal(q('wasm', 'list-code').code_infos.length, 0);
});

test('gov.sh wasm-store: a vote stores cw20-base, with the published hash', { timeout: 180_000 }, async () => {
  const out = gov('wasm-store', cw20File, 'cw20-base v2.0.0');
  assert.match(out, new RegExp(`code sha256 ${CW20_SHA256}`));
  await passed(out);
  const codes = q('wasm', 'list-code').code_infos;
  assert.equal(codes.length, 1);
  codeId = codes[0].code_id;
  assert.equal(codes[0].data_hash.toLowerCase(), CW20_SHA256);
  assert.equal(codes[0].instantiate_permission.permission, 'Everybody');
  assert.match(gov('wasm-codes'), new RegExp(CW20_SHA256, 'i'));
});

test('anyone instantiates cw20; a transfer between two accounts; balances by query', { timeout: 120_000 }, async () => {
  const init = { name: 'Zeta Wasm Test', symbol: 'ZWT', decimals: 6, initial_balances: [{ address: bech.alice, amount: '1000000' }] };
  const r = await tx('bob', 'wasm', 'instantiate', String(codeId), JSON.stringify(init), '--label', 'zwt', '--no-admin');
  assert.equal(r.code, 0, r.raw_log);
  token = q('wasm', 'list-contract-by-code', String(codeId)).contracts[0];
  assert.match(token, /^zetaphy1[0-9a-z]{58}$/, '32-byte contract address');
  assert.deepEqual(cw20({ token_info: {} }), { name: 'Zeta Wasm Test', symbol: 'ZWT', decimals: 6, total_supply: '1000000' });

  const t = await tx('alice', 'wasm', 'execute', token, JSON.stringify({ transfer: { recipient: bech.bob, amount: '250000' } }));
  assert.equal(t.code, 0, t.raw_log);
  assert.equal(cw20({ balance: { address: bech.alice } }).balance, '750000');
  assert.equal(cw20({ balance: { address: bech.bob } }).balance, '250000');
  const bad = await tx('bob', 'wasm', 'execute', token, JSON.stringify({ transfer: { recipient: bech.alice, amount: '999999' } }));
  assert.notEqual(bad.code, 0, 'more than the balance is refused');
  assert.equal(cw20({ balance: { address: bech.bob } }).balance, '250000');
});

test('a wasm tx pays its fee in azetaphy, and half of the fees are burned', { timeout: 60_000 }, async () => {
  const supply = () => BigInt(q('bank', 'total-supply-of', 'azetaphy').amount.amount);
  const before = supply();
  const r = await tx('bob', 'wasm', 'execute', token, JSON.stringify({ transfer: { recipient: bech.alice, amount: '1' } }));
  assert.equal(r.code, 0, r.raw_log);
  const fee = BigInt(r.tx.body ? r.tx.auth_info.fee.amount[0].amount : r.tx.value.auth_info.fee.amount[0].amount);
  await sleep(2500); // the burn runs at the start of the next block
  const burned = before - supply();
  assert.ok(burned * 2n >= fee, `burned ${burned} of a ${fee} fee`);
});
