// The arena's k-of-n runners through the real command line (scripts/markets.js arena-commit / arena-reveal /
// arena-finalize / arena-check / arena-settle), each runner with its own key file, against a JSON-RPC node at
// chain id 77390: two honest runners agree, a third posts another result and is slashed; the salt is derived
// from each runner's key, so the reveal needs nothing but the same result.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { keccak256 } from 'ethers';
import { createRpcChain, serveRpc, ZETA } from './helpers/rpcchain.js';
import { arenaCommitment, contentHash } from '../src/markets.js';

const run = promisify(execFile);
const SCRIPT = new URL('../scripts/markets.js', import.meta.url).pathname;
const H = (s) => keccak256(new TextEncoder().encode(s));
const SANDBOX = H('arena sandbox for the runner test');
const DAY = 86400;

test('arena runners (CLI): commit, reveal, finalize, check, settle; the odd one out is slashed', { timeout: 180_000 }, async () => {
  const c = await createRpcChain({ accounts: 7 });
  const [gov, r1, r2, r3, red, blue, anyone] = c.signers;
  const arena = await c.deploy('RedBlueArena', [gov.address], gov);
  const A = await arena.getAddress();
  for (const r of [r1, r2, r3]) {
    await (await arena.setRunner(r.address, true)).wait();
    await (await arena.connect(r).bondRunner({ value: 10n * ZETA })).wait();
  }
  const t = BigInt(c.now());
  await (await arena.openRound(t + 100n, t + 200n, t + 300n, t + 400n, 5000, SANDBOX, { value: 10n * ZETA })).wait();
  // one red and one blue entry
  const enter = async (who, side, content) => {
    const ch = contentHash(content); const salt = H(`s${side}`);
    await (await arena.connect(who).commit(1, side, arenaCommitment(A, 1, side, who.address, ch, salt), { value: ZETA })).wait();
    return [1, side, 0, ch, salt, `https://example.org/${side}`];
  };
  const e0 = await enter(red, 0, 'red manifest');
  const e1 = await enter(blue, 1, 'blue spec');
  c.advance(100);
  await (await arena.connect(red).reveal(...e0)).wait();
  await (await arena.connect(blue).reveal(...e1)).wait();
  c.advance(100);

  const node = await serveRpc(c, 18097);
  const dir = mkdtempSync(`${tmpdir()}/arena-`);
  try {
    const keyFile = (w) => { const f = `${dir}/${w.address}.key`; writeFileSync(f, w.privateKey, { mode: 0o600 }); return f; };
    const resultFile = (name, args) => { const f = `${dir}/${name}.json`; writeFileSync(f, JSON.stringify({ round: 1, sandbox: SANDBOX, args })); return f; };
    const good = resultFile('good', { redValid: '0x1', redEvaded: '0x1', blueScore: [0] });
    const other = resultFile('other', { redValid: '0x1', redEvaded: '0x0', blueScore: [1] });
    const wrongSandbox = `${dir}/ws.json`;
    writeFileSync(wrongSandbox, JSON.stringify({ round: 1, sandbox: H('another'), args: { redValid: '0x1', redEvaded: '0x1', blueScore: [0] } }));
    const cli = async (args, key) => JSON.parse((await run(process.execPath, [SCRIPT, ...args, '--arena', A, '--round', '1'], { env: { ...process.env, ZETAPHY_RPC: node.url, KEYFILE: key ?? '' } })).stdout);
    // a result judged in another sandbox is refused before anything is sent
    await assert.rejects(cli(['arena-commit', '--result', wrongSandbox, '--send'], keyFile(r1)), /judged in sandbox/);
    for (const [w, f] of [[r1, good], [r2, good], [r3, other]]) assert.ok((await cli(['arena-commit', '--result', f, '--send'], keyFile(w))).tx);
    // without --send nothing is sent (a plan, checked with a static call)
    c.advance(100);
    const plan = await cli(['arena-reveal', '--result', good], keyFile(r1));
    assert.equal(plan.planned, true);
    for (const [w, f] of [[r1, good], [r2, good], [r3, other]]) assert.ok((await cli(['arena-reveal', '--result', f, '--send'], keyFile(w))).tx);
    c.advance(100);
    assert.ok((await cli(['arena-finalize', '--send'], keyFile(anyone))).tx);
    const ok = await cli(['arena-check', '--result', good]);
    assert.equal(ok.same, true);
    const odd = await cli(['arena-check', '--result', other]);
    assert.equal(odd.same, false, 'this runner would challenge with --challenge');
    assert.equal((await arena.stakes(r3.address)).bond, 5n * ZETA, 'the odd one out lost half its bond');
    const settleEarly = await cli(['arena-settle', '--send'], keyFile(anyone));
    assert.ok(settleEarly.skipped, 'the challenge window is still open');
    c.advance(DAY);
    assert.ok((await cli(['arena-settle', '--send'], keyFile(anyone))).tx);
    // 5% fee of 10 (0.5) + 5 slashed, split by r1 and r2
    assert.equal(await arena.owed(r1.address), (ZETA / 2n + 5n * ZETA) / 2n);
    assert.equal(await arena.owed(red.address), ZETA + (5n * ZETA * 95n) / 100n, 'the evading red entry: bond + red pool minus the fee');
  } finally {
    await node.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
