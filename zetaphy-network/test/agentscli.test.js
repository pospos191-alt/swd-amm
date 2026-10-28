// `zetaphy intent show|compile` and `zetaphy cosign combine` (src/agentscli.js), without a chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, getAddress, keccak256 } from 'ethers';
import { agentsCommand } from '../src/agentscli.js';
import { signIntent, signedJson, hashTargets } from '../src/intent.js';
import { signCosign } from '../src/cosign.js';

const A = getAddress('0x' + '11'.repeat(20)), B = getAddress('0x' + '22'.repeat(20)), R = getAddress('0x' + '33'.repeat(20)), EXE = getAddress('0x' + '44'.repeat(20));

async function run(group, cmd, rest, opt = {}) {
  const out = [];
  const code = await agentsCommand({ group, cmd, rest, opt, write: (l) => out.push(l), s: {}, connect: null, connectRpc: null });
  return { code, out: out.join('\n') };
}

test('intent show / compile read a signed intent file and build the swap call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zi-'));
  try {
    const user = Wallet.createRandom();
    const intent = { user: user.address, kind: 2, tokenIn: A, maxIn: 10n, tokenOut: B, minOut: 9n, recipient: user.address, targetsHash: hashTargets([R]),
      nonce: 7n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
    const file = join(dir, 'signed.json');
    writeFileSync(file, signedJson({ intent, auth: await signIntent(user, intent, EXE, 77390n), executor: EXE, chainId: 77390n, route: { router: R } }));
    const shown = await run('intent', 'show', [file]);
    assert.match(shown.out, /swap: at most 10 of/);
    assert.match(shown.out, /ECDSA \(EIP-712\)/);
    const plan = JSON.parse((await run('intent', 'compile', [file])).out);
    assert.deepEqual(plan.targets, [R]);
    assert.equal(plan.calls[0].target, R);
    await assert.rejects(run('intent', 'compile', [file], { router: 'nope' }), /--router/);
    await assert.rejects(run('intent', 'bogus', [file]), /usage/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cosign combine: same digest from every runner, signatures ordered by signer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-'));
  try {
    const digest = keccak256('0x01');
    const ws = [Wallet.createRandom(), Wallet.createRandom()];
    const files = ws.map((w, i) => {
      const f = join(dir, `${i}.json`);
      writeFileSync(f, JSON.stringify({ to: A, value: '0', data: '0x', reportHash: digest, deadline: '1', digest, ...signCosign(w.privateKey, digest) }));
      return f;
    });
    const out = JSON.parse((await run('cosign', 'combine', files)).out);
    const sigs = out.executeCosigned[7];
    assert.equal(sigs.length, 2);
    const order = ws.map((w) => w.address.toLowerCase()).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    assert.equal(signCosign(ws.find((w) => w.address.toLowerCase() === order[0]).privateKey, digest).sig, sigs[0]);
    writeFileSync(files[1], JSON.stringify({ digest: keccak256('0x02'), sig: '0x' }));
    await assert.rejects(run('cosign', 'combine', files), /different digests/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
