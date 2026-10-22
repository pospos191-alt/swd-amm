// The post-quantum block verifier (src/pqcert.js, zetaphy pq verify-block) on a
// real two-validator ZETAPHY chain with ML-DSA-44 vote signatures
// (scripts/devnet-pq2.sh: A 60%, B 40%, so every block needs both):
//   - before any vote key is registered, blocks pass with nothing required
//   - both validators register their keys; recent blocks are certified by both
//     (Go's CIRCL signed, @noble/post-quantum verifies)
//   - the CLI agrees, also with keys pinned from export-vote-keys
//   - B stops, blocks halt, and the newest block has no certificate yet: exit 1
// Needs a zetaphyd with vote keys (zetaphy tx pq-vote-key):
//   ZETAPHYD=/path/to/zetaphyd npm run test:devnet:pqcert

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { hexToBytes, bytesToHex } from '../src/pqtx.js';
import { verifyBlock, exportVoteKeys, cometClient } from '../src/pqcert.js';

const ZETAPHYD = process.env.ZETAPHYD || 'zetaphyd';
const BASE = 19545; // node A's CometBFT RPC; node B's is BASE + 10 (19545-19560 used)
const RPC = `http://127.0.0.1:${BASE}`;
const RPC_B = `http://127.0.0.1:${BASE + 10}`;
const CHAIN = 'zetaphy-pqcert-1';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-pqcert-'));
const W = join(root, 'chain');
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', ZETAPHYD, COSMOS_CHAIN_ID: CHAIN };
const comet = cometClient(RPC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const height = async (rpc = comet) => Number((await rpc('status', {})).sync_info.latest_block_height);
const consAddr = (n) => JSON.parse(readFileSync(join(W, n, 'config', 'priv_validator_key.json'), 'utf8')).address.toUpperCase();
const pids = () => ['A', 'B'].map((n) => { try { return Number(readFileSync(join(W, n, 'pid'), 'utf8')); } catch { return 0; } }).filter(Boolean);
const stopAll = () => { for (const p of pids()) { try { process.kill(p); } catch { /* gone */ } } };
process.on('exit', stopAll); // also when the run is cut short

async function waitHeight(h, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await height() >= h) return;
  throw new Error(`the chain did not reach block ${h}`);
}

/** zetaphy CLI; resolves { code, out }. */
function cli(args) {
  const home = mkdtempSync(join(root, 'cli-'));
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args], { env: { ...env, ZETAPHY_HOME: home }, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr }));
  });
}

/** zetaphyd tx pq-vote-key for validator n; resolves the height of the block that holds it. */
async function registerVoteKey(n) {
  const out = JSON.parse(execFileSync(ZETAPHYD, ['tx', 'pq-vote-key', '--from', `val${n}`, '--keyring-backend', 'test', '--home', join(W, n),
    '--chain-id', CHAIN, '--node', `tcp://127.0.0.1:${BASE}`, '--gas', '600000', '--gas-prices', '1000000000azetaphy', '-y', '-o', 'json'], { env }).toString());
  assert.equal(out.code, 0, out.raw_log);
  for (const end = Date.now() + 30_000; Date.now() < end; await sleep(500)) {
    try {
      const r = await comet('tx', { hash: Buffer.from(out.txhash, 'hex').toString('base64') });
      assert.equal(r.tx_result.code ?? 0, 0, r.tx_result.log);
      return Number(r.height);
    } catch (e) { if (e instanceof assert.AssertionError) throw e; /* not in a block yet */ }
  }
  throw new Error(`pq-vote-key of ${n} is not in a block`);
}

before(() => {
  execFileSync(new URL('../scripts/devnet-pq2.sh', import.meta.url).pathname, [W, String(BASE)], { stdio: 'inherit', env });
});
after(async () => {
  const running = pids();
  stopAll();
  // Wait for the nodes to exit (they write on shutdown), then remove the chain data.
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && running.some(alive); i++) await sleep(250);
  for (const p of running.filter(alive)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const A = () => consAddr('A'), B = () => consAddr('B');
let registered; // { A: height, B: height }

test('before any vote key is registered: ok, nothing required', async () => {
  const r = await verifyBlock(RPC, 2);
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.required, 0n);
  assert.equal(r.totalPower, 10_000_000n);
  assert.equal(r.unregisteredPower, 10_000_000n);
  assert.equal(r.signedPower, 0n);
  assert.equal(r.pqMajority, false);
  assert.deepEqual(r.signers, []);
  assert.deepEqual(r.validators.map((v) => [v.address, v.power, v.hasKey]).sort(), [[A(), 6_000_000n, false], [B(), 4_000_000n, false]].sort());
  assert.equal(r.chainId, CHAIN);
  const c = await cli(['pq', 'verify-block', '2', '--rpc', RPC]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /NOT post-quantum/);
});

test('both validators register vote keys; recent blocks are certified by both', { timeout: 120_000 }, async () => {
  registered = { A: await registerVoteKey('A'), B: await registerVoteKey('B') };
  const last = Math.max(registered.A, registered.B);
  await waitHeight(last + 4);

  // The block that registered a key: that key does not cover votes on it yet.
  const atReg = await verifyBlock(RPC, last);
  assert.equal(atReg.ok, true, atReg.problems.join('\n'));
  for (const n of ['A', 'B']) assert.equal(atReg.validators.find((v) => v.address === consAddr(n)).hasKey, registered[n] < last, `${n} at block ${last}`);

  // From the next block on, both keys are valid and both sign every block.
  const tip = await height();
  for (const h of [last + 1, tip - 1]) {
    const r = await verifyBlock(RPC, h);
    assert.equal(r.ok, true, `block ${h}: ${r.problems.join('\n')}`);
    assert.equal(r.pqMajority, true);
    assert.equal(r.certificate, true);
    assert.equal(r.unregisteredPower, 0n);
    assert.equal(r.signedPower, 10_000_000n);
    assert.equal(r.required, 6_666_667n);
    assert.deepEqual(r.signers.map((s) => s.address).sort(), [A(), B()].sort());
    assert.deepEqual(r.problems, []);
  }
  // Node B serves the same chain: the same verdict through it (once B has
  // block `tip` too, which carries block tip-1's certificate; B can lag A).
  const cometB = cometClient(RPC_B);
  for (const end = Date.now() + 30_000; await height(cometB) < tip && Date.now() < end;) await sleep(500);
  const viaB = await verifyBlock(RPC_B, tip - 1);
  assert.equal(viaB.ok, true, viaB.problems.join('\n'));
  // Signatures bind the chain id.
  const other = await verifyBlock(RPC, tip - 1, { chainId: 'zetaphy_77390-1' });
  assert.equal(other.ok, false);
  assert.equal(other.signedPower, 0n);

  // The keys on chain are the ones in the nodes' seed files (Go and JavaScript derive the same key).
  const pin = await exportVoteKeys(RPC);
  for (const n of ['A', 'B']) {
    const seed = hexToBytes(readFileSync(join(W, n, 'config', 'pq_vote_key.seed'), 'utf8').trim());
    const v = pin.validators[consAddr(n)];
    assert.equal(v.pubKey, bytesToHex(ml_dsa44.keygen(seed).publicKey), `${n}'s registered key`);
    assert.equal(v.since, String(registered[n]));
    assert.equal(v.previousPubKey, null);
  }
});

test('CLI: verify-block, export-vote-keys and --keys', { timeout: 120_000 }, async () => {
  const h = (await height()) - 1;
  const r = await cli(['pq', 'verify-block', String(h), '--rpc', RPC]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`block ${h}: VERIFIED post-quantum`));
  assert.match(r.out, new RegExp(`✓ ${A()} power 6000000: signed`));
  assert.match(r.out, new RegExp(`✓ ${B()} power 4000000: signed`));

  const exp = await cli(['pq', 'export-vote-keys', '--rpc', RPC]);
  assert.equal(exp.code, 0, exp.out);
  const pin = JSON.parse(exp.out);
  assert.equal(pin.chainId, CHAIN);
  assert.equal(Object.keys(pin.validators).length, 2);
  const file = join(root, 'pinned.json');
  writeFileSync(file, exp.out);
  const p = await cli(['pq', 'verify-block', String(h), '--rpc', RPC, '--keys', file]);
  assert.equal(p.code, 0, p.out);
  assert.match(p.out, /pinned in .*pinned\.json \(the node is not trusted\)/);

  // A pin with B's key replaced: B's real signature no longer counts, so A's 60% is not enough.
  const forged = JSON.parse(exp.out);
  forged.validators[B()].pubKey = bytesToHex(ml_dsa44.keygen(new Uint8Array(32).fill(5)).publicKey);
  writeFileSync(file, JSON.stringify(forged));
  const f = await cli(['pq', 'verify-block', String(h), '--rpc', RPC, '--keys', file]);
  assert.equal(f.code, 1, f.out);
  assert.match(f.out, /NOT VERIFIED/);
  assert.match(f.out, new RegExp(`✗ ${B()} power 4000000: no valid signature`));
});

test('B stops: blocks halt; the newest block has no certificate yet and the CLI exits 1', { timeout: 120_000 }, async () => {
  process.kill(Number(readFileSync(join(W, 'B', 'pid'), 'utf8')));
  // A holds 60%, less than 2/3: no block after the ones in flight.
  let last = await height();
  for (let still = 0; still < 6; await sleep(1000)) {
    const h = await height();
    still = h === last ? still + 1 : 0;
    last = h;
  }
  const r = await cli(['pq', 'verify-block', String(last), '--rpc', RPC]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT VERIFIED/);
  assert.match(r.out, new RegExp(`block ${last + 1} is not committed yet`));
  // The block before it is final, with its certificate in block `last`.
  const prev = await cli(['pq', 'verify-block', String(last - 1), '--rpc', RPC]);
  assert.equal(prev.code, 0, prev.out);
  assert.match(prev.out, /VERIFIED post-quantum/);
  // A block beyond the chain: an error, exit 1.
  const beyond = await cli(['pq', 'verify-block', String(last + 5), '--rpc', RPC]);
  assert.equal(beyond.code, 1);
  assert.match(beyond.out, new RegExp(`block ${last + 5} is not committed yet`));
  assert.equal(await height(), last, 'still halted');
});
