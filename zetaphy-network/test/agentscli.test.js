// `zetaphy intent show|compile` and `zetaphy cosign combine` (src/agentscli.js), without a chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, getAddress, keccak256 } from 'ethers';
import { agentsCommand } from '../src/agentscli.js';
import { signIntent, signedJson, hashTargets } from '../src/intent.js';
import { signCosign } from '../src/cosign.js';
import { verify as frostVerify, desE, unhex } from '../src/frost.js';

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

test('cosign FROST by files only: dkg1/2/3 (no dealer), commit, frost-package, frost-sign (re-checks the digest), frost-aggregate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zf-'));
  try {
    const f = (n) => join(dir, n);
    const session = 'a1'.repeat(16);
    // what each member's Neuro review would compute: here a fixed digest (the RPC path is tested in policywallet.test.js)
    let digest = keccak256('0x0abc');
    const deps = { reviewedDigest: async (o) => ({ ok: true, reasons: [], reports: [], wallet: EXE, to: getAddress(o.to), value: BigInt(o.value ?? 0), data: o.data ?? '0x',
      deadline: BigInt(o.deadline ?? 99), nonce: 0n, reportHash: keccak256('0x01'), digest }) };
    const go = async (cmd, rest, opt = {}) => {
      const out = [];
      const code = await agentsCommand({ group: 'cosign', cmd, rest, opt, write: (l) => out.push(l), s: {}, connect: null, connectRpc: null, deps });
      assert.equal(code, 0);
      return out.join('\n');
    };
    for (const id of [1, 2, 3]) await go('dkg1', [], { id, threshold: 2, participants: 3, session, secret: f(`s${id}`), out: f(`r1-${id}.json`) });
    assert.equal(statSync(f('s1')).mode & 0o077, 0, 'secret files are private');
    const r1 = [1, 2, 3].map((id) => f(`r1-${id}.json`));
    const transcripts = [];
    for (const id of [1, 2, 3]) transcripts.push((await go('dkg2', r1, { secret: f(`s${id}`), out: f(`r2-${id}.json`) })).match(/transcript (\w+)/)[1]);
    assert.equal(new Set(transcripts).size, 1, 'everyone printed the same transcript');
    for (const id of [1, 2, 3]) {
      const out = await go('dkg3', [1, 2, 3].filter((j) => j !== id).map((j) => f(`r2-${j}.json`)), { secret: f(`s${id}`), round1: r1.join(','), key: f(`k${id}`), out: f(`group-${id}.json`) });
      assert.match(out, /setFrostKey\(0x0[23][0-9a-f]{64}\)/);
      assert.equal(existsSync(f(`s${id}`)), false, 'the DKG polynomial is deleted');
    }
    const group = JSON.parse(readFileSync(f('group-1.json'), 'utf8'));
    assert.deepEqual(JSON.parse(readFileSync(f('group-3.json'), 'utf8')), group);
    await go('commit', [], { key: f('k1'), out: f('c1.json') });
    await go('commit', [], { key: f('k3'), out: f('c3.json') });
    await go('frost-package', [f('c1.json'), f('c3.json')], { group: f('group-1.json'), wallet: EXE, to: A, value: '5', out: f('pkg.json') });
    await go('frost-sign', [], { key: f('k1'), package: f('pkg.json'), out: f('z1.json') });
    await assert.rejects(go('frost-sign', [], { key: f('k1'), package: f('pkg.json') }), /no unused nonces/); // one commitment signs once
    digest = keccak256('0x0abd'); // member 3's own review sees another state: it refuses to sign the package's digest
    await assert.rejects(go('frost-sign', [], { key: f('k3'), package: f('pkg.json'), out: f('z3.json') }), /another digest/);
    digest = keccak256('0x0abc');
    await go('commit', [], { key: f('k3'), out: f('c3b.json') });
    await go('frost-package', [f('c1.json'), f('c3b.json')], { group: f('group-1.json'), wallet: EXE, to: A, value: '5', out: f('pkg2.json') });
    await go('commit', [], { key: f('k1'), out: f('c1b.json') });
    await go('frost-package', [f('c1b.json'), f('c3b.json')], { group: f('group-1.json'), wallet: EXE, to: A, value: '5', out: f('pkg3.json') });
    await go('frost-sign', [], { key: f('k1'), package: f('pkg3.json'), out: f('y1.json') });
    await go('frost-sign', [], { key: f('k3'), package: f('pkg3.json'), out: f('y3.json') });
    const agg = JSON.parse(await go('frost-aggregate', [f('y1.json'), f('y3.json')], { group: f('group-1.json'), package: f('pkg3.json') }));
    const sig = agg.executeCosignedFrost[7];
    assert.ok(frostVerify(desE(group.groupKey), unhex(digest), unhex(sig)));
    assert.equal(agg.executeCosignedFrost[0], A);
    await assert.rejects(go('frost-aggregate', [f('y1.json')], { group: f('group-1.json'), package: f('pkg3.json') }), /one share per signer/);
    await assert.rejects(go('bogus', []), /usage/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
