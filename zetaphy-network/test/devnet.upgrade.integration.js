// The 2026-10-29 testnet stop, replayed on a real node (zetaphyd built from zetaphy-chain/setup-node.sh;
// 1 s blocks, 20 s votes): a chain WITHOUT v5 runs the binary that already has the "zetaphy-v5" handler,
// and governance votes the upgrade. Before the fix x/upgrade stopped the chain one block after the vote
// passed ("BINARY UPDATED BEFORE TRIGGER!"). Now:
//   1. the chain keeps making blocks from the vote until the upgrade height;
//   2. at the height the handler runs ("applied" answers that height) and blocks go on.
// Needs a zetaphyd with the guard: ZETAPHYD=/path/to/zetaphyd npm run test:devnet:upgrade

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';

const ZETAPHYD = process.env.ZETAPHYD || 'zetaphyd';
const PORT = 26545; // EVM JSON-RPC; scripts/devnet.sh also uses +1 and +100..+103
const CHAIN_ID = 'zetaphy-local-1';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-upgrade-'));
const chainHome = join(root, 'chain');
const env = { ...process.env, ZETAPHYD, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
const NODE = `tcp://127.0.0.1:${PORT + 100}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// FORCE=1: gov.sh's release checks need GitHub; they have their own test (govupgrade.test.js)
const govEnv = { ...env, NODE_HOME: chainHome, KEYS_DIR: chainHome, NODE, CHAIN_ID, FORCE: '1' };
const gov = (...a) => execFileSync(new URL('../../zetaphy-chain/gov.sh', import.meta.url).pathname, a, { env: govEnv, encoding: 'utf8' });
const z = (...a) => execFileSync(ZETAPHYD, a, { env, encoding: 'utf8' });
const height = () => Number(JSON.parse(z('status', '--node', NODE)).sync_info.latest_block_height);
const applied = () => JSON.parse(z('q', 'upgrade', 'applied', 'zetaphy-v5', '--node', NODE, '-o', 'json'));

async function waitHeight(h, limitMs) {
  const end = Date.now() + limitMs;
  for (;;) {
    const now = height();
    if (now >= h) return now;
    if (Date.now() > end) throw new Error(`the chain is at ${now}, waited for ${h}`);
    await sleep(500);
  }
}

before(() => {
  // a chain from before v5: no v5 height (key 20) in app_state.zetaphypq
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname, [chainHome, String(PORT), Wallet.createRandom().address],
    { env: { ...env, GENESIS_JQ: '.app_state.zetaphypq |= map(select(.key != "20"))' }, stdio: 'inherit' });
});
after(() => { try { process.kill(Number(readFileSync(join(chainHome, 'node.pid'), 'utf8'))); } catch {} });

test('a voted "zetaphy-v5" with the handler already installed: no stop before the height, applied at it', { timeout: 300_000 }, async () => {
  const gen = JSON.parse(readFileSync(join(chainHome, 'config', 'genesis.json'), 'utf8'));
  assert.ok(!gen.app_state.zetaphypq.some((e) => e.key === '20'), 'the chain starts without v5');
  assert.deepEqual(applied(), {}, 'not applied yet');

  const H = height() + 110; // gov.sh wants the height well after the current block (> +100)
  const out = gov('propose-upgrade', 'zetaphy-v5', String(H), 'v5 on a running chain (test)');
  const id = out.match(/proposal (\d+) submitted/)?.[1];
  assert.ok(id, out);
  assert.match(gov('vote', id, 'yes'), /voted yes/);

  // the vote passes after 20 s; the old code stopped the chain on the next block
  for (let i = 0; i < 60; i++) {
    if (JSON.parse(gov('status', id)).status === 'PROPOSAL_STATUS_PASSED') break;
    await sleep(1000);
  }
  assert.equal(JSON.parse(gov('status', id)).status, 'PROPOSAL_STATUS_PASSED');
  const afterVote = height();
  await waitHeight(afterVote + 10, 60_000); // blocks go on after the plan is scheduled
  assert.deepEqual(applied(), {}, 'still before the height');

  await waitHeight(H + 5, (H - afterVote + 60) * 1000); // through the upgrade height
  assert.equal(String(applied().height), String(H), 'the handler ran at the voted height');
  const at = height();
  await waitHeight(at + 3, 30_000);
});
