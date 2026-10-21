// The Neuro bridge across two real chains (both zetaphyd devnets):
//   source chain S (EVM id 4097) holds a LockBox;
//   ZETAPHY Z (77390) holds BridgeGuard + BridgeAirlock + NeuroLane + a decoy.
// Three node runners watch S with `zetaphy bridge watch` and attest; a second
// lane (standing in for Hyperlane) attests too; after the quarantine the
// money enters ZETAPHY. An attacker who touched the decoy gets nothing.
// Vaccine: a sender flagged in the ThreatRegistry (`zetaphy threat flag`) and
// enforced at once by a guardian (`threat enforce-now`, the fast lane) is not
// attested, and its transfer waits until the runners clear the flag. A sender
// flagged but not enforced yet (inside the 1 h enforceDelay) holds nothing for
// the registry's holdDelay (10 min: two runners alone cannot freeze anyone at
// once); a guardian's `threat hold-now` holds it at once: attested but not
// released until the flag is cleared. deploy-bridge refuses to run without
// --lockbox (with a registry) and protects the bridge's own keys (lockbox
// included), so the runners cannot flag them; NeuroLane's pause switch is the
// NeuroJobs' NeuroControl by default.
// Also: `threat export` (the data feed for other wallets) and user reports
// (`deploy-reports`, `threat report`, `threat reports`, `settle`, `claim`).
// Opening gates: deploy-bridge deploys the bridge CLOSED and refuses a single-key
// guardian outside a devnet; `bridge open` refuses until every gate holds (audit on
// record, 2 independent lanes, runners, multisig roles or --devnet, the cap), then
// enables the route with a 10-token daily limit. `bridge monitor` then reports the
// decoy hit, the governance changes, the volume at the limit, and a guardian's pause.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, ContractFactory, parseEther, NonceManager } from 'ethers';

const ZP = 19045, SP = 19445; // a devnet also uses its port +100..+103
const Z = `http://127.0.0.1:${ZP}`, S = `http://127.0.0.1:${SP}`;
const root = mkdtempSync(join(tmpdir(), 'zetaphy-bridge-'));
const names = ['gov', 'user', 'r1', 'r2', 'r3', 'hyperlane', 'alice', 'attacker', 'mallory', 'eve'];
const W = Object.fromEntries(names.map((n) => [n, Wallet.createRandom()]));
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
let zp, sp, jobsAddr, cfg;

function cli(actor, args, rpc = Z) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args, '--rpc', rpc], {
      env: { ...env, ZETAPHY_HOME: join(root, actor) }, timeout: 90_000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}

before(() => {
  for (const [n, w] of Object.entries(W)) {
    mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, n, 'worker.key'), w.privateKey + '\n', { mode: 0o600 });
  }
  const all = Object.values(W).map((w) => w.address);
  const devnet = new URL('../scripts/devnet.sh', import.meta.url).pathname;
  execFileSync(devnet, [join(root, 'z'), String(ZP), ...all], { stdio: 'inherit', env });
  execFileSync(devnet, [join(root, 's'), String(SP), ...all], { stdio: 'inherit', env: { ...env, EVM_CHAIN_ID: '4097', COSMOS_CHAIN_ID: 'source-local-1' } });
  zp = new JsonRpcProvider(Z, undefined, { staticNetwork: true });
  sp = new JsonRpcProvider(S, undefined, { staticNetwork: true });
});
after(() => { for (const d of ['z', 's']) { try { process.kill(Number(readFileSync(join(root, d, 'node.pid'), 'utf8'))); } catch {} } });

test('assets cross only with two independent lanes, after quarantine, and never to a decoy-marked attacker', { timeout: 600_000 }, async () => {
  // ZETAPHY side: NeuroJobs, three runners with a track record.
  const d = await cli('gov', ['deploy', '--fund', '100', '--window', '8', '--timeout', '60', '--unbond', '120']);
  assert.match(d.out, /deployed at 0x/, d.out);
  jobsAddr = /deployed at (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  for (const r of ['r1', 'r2', 'r3']) assert.equal((await cli(r, ['node', 'register', '--jobs', jobsAddr])).code, 0);
  await cli('user', ['job', 'request', 'zetaphy', jobsAddr, '--fee', '1', '--jobs', jobsAddr]);
  const jobs = new Contract(jobsAddr, art('NeuroJobs').abi, zp);
  for (let i = 0; i < 40 && (await jobs.getJob(0)).status === 1n; i++) {
    await Promise.all(['r1', 'r2', 'r3'].map((r) => cli(r, ['node', 'start', '--once', '--jobs', jobsAddr])));
  }
  assert.equal((await jobs.getJob(0)).status, 2n, 'runners need one accepted verdict first');

  // A long enforceDelay: flags here are enforced only through the fast lane (the guardian's enforce-now).
  const th = await cli('gov', ['deploy-threats', '--jobs', jobsAddr, '--quorum', '2', '--min-agreed', '1', '--enforce-delay', '3600', '--guardian', W.user.address]);
  assert.equal(th.code, 0, th.out);
  assert.match(th.out, /flags enforced after 3600s/);
  assert.match(th.out, /fast lane: a flag 4 runners stand behind is enforced at once/);
  assert.match(th.out, new RegExp(`guardian ${W.user.address}: may enforce`));
  assert.match(th.out, /bridge holds: a flag holds bridging after 600s/);
  const threats = /ThreatRegistry (0x[0-9a-fA-F]{40})/.exec(th.out)[1];
  // Source side first: a LockBox, so deploy-bridge can protect its address.
  const lb = await new ContractFactory(art('LockBox').abi, art('LockBox').bytecode, W.gov.connect(sp)).deploy();
  await lb.waitForDeployment();
  const lockbox = new Contract(await lb.getAddress(), art('LockBox').abi, sp);
  // Without --lockbox (and with a registry) deploy-bridge refuses, before deploying anything.
  const noLb = await cli('gov', ['deploy-bridge', '--jobs', jobsAddr, '--threats', threats]);
  assert.notEqual(noLb.code, 0, noLb.out);
  assert.match(noLb.out, /needs --lockbox <source chain id>:0x<LockBox>, so the source lockbox is protected \(or pass --no-lockbox-protect/);
  assert.doesNotMatch(noLb.out, /BridgeGuard 0x/);
  const bridgeArgs = ['deploy-bridge', '--jobs', jobsAddr, '--quarantine', '8', '--lane', W.hyperlane.address, '--min-agreed', '1', '--threats', threats,
    '--lockbox', `4097:${lockbox.target}`, '--guardian', W.user.address];
  // A single-key guardian: refused outside a devnet, before anything is deployed.
  const eoaGuardian = await cli('gov', bridgeArgs);
  assert.notEqual(eoaGuardian.code, 0, eoaGuardian.out);
  assert.match(eoaGuardian.out, /deploy-bridge refused \(nothing deployed\):\n  - guardian 0x[0-9a-fA-F]{40} is a single key \(EOA, no code\): use a multisig/);
  assert.match((await cli('gov', [...bridgeArgs, '--daily-limit', '5000'])).out, /above the starter cap \(1000 tokens\): pass --raise-cap/);
  const b = await cli('gov', [...bridgeArgs, '--devnet']);
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /bridge CLOSED \(route disabled, daily limit 1000, hard cap 1000\)/);
  assert.match(b.out, /vaccine on/);
  assert.match(b.out, /ThreatRegistry: protect the bridge's own contracts and the lockbox \(done\)/);
  cfg = Object.fromEntries([...b.out.matchAll(/^(\w+) (0x[0-9a-fA-F]{40})$/gm)].map((m) => [m[1], m[2]]));
  const guard = new Contract(cfg.BridgeGuard, art('BridgeGuard').abi, zp);
  const route = await new Contract(cfg.BridgeAirlock, art('BridgeAirlock').abi, zp).route();
  assert.equal((await guard.routes(route)).enabled, false, 'deployed closed');
  // Opening gates: refused without the audit, outside a devnet (single-key lane, governance and guardian), with 3 runners.
  const AUDIT = ['--audit-report', 'https://audits.example/zetaphy-bridge-devnet.pdf', '--audit-sha256', 'ab'.repeat(32)];
  const shut = await cli('gov', ['bridge', 'open', '--jobs', jobsAddr]);
  assert.equal(shut.code, 1, shut.out);
  for (const re of [/The bridge stays CLOSED/, /--audit-report must be an https:\/\/ url/, /3 active Neuro runner\(s\) in NeuroJobs, needs at least 10/,
    /lane 0x[0-9a-fA-F]{40} is a single key \(EOA\)/, /governance 0x[0-9a-fA-F]{40} is a single key \(EOA, no code\)/, /guardian 0x[0-9a-fA-F]{40} is a single key/,
    /pass --i-understand-real-funds/]) assert.match(shut.out, re);
  assert.match(shut.out, /NeuroLane +0x[0-9a-fA-F]{40} +controller 0x[0-9a-fA-F]{40} +admin \(none: immutable\)/); // the lane table for a human
  assert.equal((await guard.routes(route)).enabled, false);
  const opened = await cli('gov', ['bridge', 'open', '--jobs', jobsAddr, '--devnet', ...AUDIT, '--min-runners', '3', '--daily-limit', '10']);
  assert.equal(opened.code, 0, opened.out);
  assert.match(opened.out, /record the audit on-chain \(BridgeGuard.setAudit\) \(done\)/);
  assert.match(opened.out, /bridge OPEN/);
  assert.equal((await guard.routes(route)).enabled, true);
  assert.equal(await guard.auditSha256(), '0x' + 'ab'.repeat(32));
  // NeuroLane's pause switch defaults to the NeuroJobs' NeuroControl.
  const jobsControl = await jobs.control();
  assert.notEqual(jobsControl, '0x0000000000000000000000000000000000000000');
  assert.equal(await new Contract(cfg.NeuroLane, art('NeuroLane').abi, zp).control(), jobsControl);
  // The route's own keys are protected: a runner quorum cannot flag the lockbox (or the airlock).
  for (const r of ['r1', 'r2', 'r3']) await cli(r, ['threat', 'flag', `4097:${lockbox.target}`, cfg.BridgeAirlock, '--reason', 'sweeps-approved-tokens', '--evidence', '0x' + 'e7'.repeat(32), '--uri', 'neuro report', '--threats', threats]);
  const prot = (await cli('r3', ['threat', 'check', `4097:${lockbox.target}`, cfg.BridgeAirlock, '--threats', threats])).out;
  assert.doesNotMatch(prot, /FLAGGED/, prot);
  assert.equal(prot.match(/protected by governance/g)?.length, 3, prot); // lockbox; airlock address and code

  // Alice locks 5, the attacker pokes the decoy on ZETAPHY then locks 7.
  await (await lockbox.connect(W.alice.connect(sp)).lock(W.alice.address, { value: parseEther('5') })).wait();
  const decoy = new Contract(cfg.DecoyBridge, art('DecoyBridge').abi, W.attacker.connect(zp));
  await (await decoy.mint(W.attacker.address, parseEther('1000000'), { gasLimit: 300000n })).wait();
  await (await lockbox.connect(W.attacker.connect(sp)).lock(W.attacker.address, { value: parseEther('7') })).wait();
  // Mallory's address on the source chain is flagged by the runners before she locks 3. Only runners
  // with an accepted verdict may vote (a seat that did not reveal has none), and a vote after the
  // quorum changes nothing, so single votes may fail; the registry is what counts.
  const vote = async (cmd, who = W.mallory.address) => { for (const r of ['r1', 'r2', 'r3']) await cli(r, ['threat', cmd, `4097:${who}`, ...(cmd === 'flag' ? ['--reason', 'sweeps-approved-tokens', '--evidence', '0x' + 'e7'.repeat(32), '--uri', 'neuro report'] : []), '--threats', threats]); };
  await vote('flag');
  // A warning at once; enforced (what refuses transfers) only after the 1 h enforceDelay...
  let chk = (await cli('r3', ['threat', 'check', `4097:${W.mallory.address}`, '--threats', threats])).out;
  assert.match(chk, /FLAGGED \(sweeps-approved-tokens, warning only until .* \(then enforced\)\)/, chk);
  // ...or at once through the fast lane: only governance or a guardian may call enforce-now.
  const notGuardian = await cli('alice', ['threat', 'enforce-now', `4097:${W.mallory.address}`, '--threats', threats]);
  assert.match(notGuardian.out, /neither governance nor a guardian\. Have one call:\n  to 0x[0-9a-fA-F]{40}\n  data 0x/, notGuardian.out);
  const now = await cli('user', ['threat', 'enforce-now', `4097:${W.mallory.address}`, '--threats', threats]);
  assert.match(now.out, /enforced now/, now.out);
  chk = (await cli('r3', ['threat', 'check', `4097:${W.mallory.address}`, '--threats', threats])).out;
  assert.match(chk, /FLAGGED \(sweeps-approved-tokens, enforced \(fast lane\)\)/, chk);
  await (await lockbox.connect(W.mallory.connect(sp)).lock(W.mallory.address, { value: parseEther('3') })).wait();
  // Eve is flagged too, but only at warning level (not enforced for an hour), and two runners alone hold
  // nothing for the 10 min holdDelay; the guardian holds her at once (threat hold-now).
  await vote('flag', W.eve.address);
  let eveChk = (await cli('r3', ['threat', 'check', `4097:${W.eve.address}`, '--threats', threats])).out;
  assert.match(eveChk, /FLAGGED \(sweeps-approved-tokens, warning only until/);
  assert.match(eveChk, /bridge hold: from .* \(hold-delay; at once if governance or a guardian runs threat hold-now\)/, eveChk);
  assert.match((await cli('alice', ['threat', 'hold-now', `4097:${W.eve.address}`, '--threats', threats])).out, /neither governance nor a guardian/);
  assert.match((await cli('user', ['threat', 'hold-now', `4097:${W.eve.address}`, '--threats', threats])).out, /held now/);
  eveChk = (await cli('r3', ['threat', 'check', `4097:${W.eve.address}`, '--threats', threats])).out;
  assert.match(eveChk, /bridge hold: holding/, eveChk);
  assert.match(eveChk, /Automated code analysis, not an accusation/);
  assert.match(eveChk, /evidence: reportHash 0x(e7){32} \(neuro report\)/); // every flag carries its evidence
  await (await lockbox.connect(W.eve.connect(sp)).lock(W.eve.address, { value: parseEther('2') })).wait();

  // The "Hyperlane" lane attests both locks independently.
  // NonceManager: Cosmos EVM can report the pending nonce a moment late.
  const airlock = new Contract(cfg.BridgeAirlock, art('BridgeAirlock').abi, new NonceManager(W.hyperlane.connect(zp)));
  const srcId = 4097n;
  await (await airlock.attest(srcId, lockbox.target, 0n, W.alice.address, W.alice.address, parseEther('5'))).wait();
  await (await airlock.attest(srcId, lockbox.target, 1n, W.attacker.address, W.attacker.address, parseEther('7'))).wait();
  await (await airlock.attest(srcId, lockbox.target, 2n, W.mallory.address, W.mallory.address, parseEther('3'))).wait();
  await (await airlock.attest(srcId, lockbox.target, 3n, W.eve.address, W.eve.address, parseEther('2'))).wait();

  // Runners watch S and attest; then, after the quarantine, release.
  const watch = (r, extra = []) => cli(r, ['bridge', 'watch', '--once', '--source-rpc', S, '--lockbox', lockbox.target, '--confirmations', '1',
    '--airlock', cfg.BridgeAirlock, '--neuroLane', cfg.NeuroLane, ...extra]);
  const token = new Contract(cfg.BridgedToken, art('BridgedToken').abi, zp);
  const logs = [];
  const eveHeld = /lock #3: not released \(source sender is held in the ThreatRegistry \(flagged, not enforced yet\), held until the flag is cleared or the key protected\)/;
  for (let i = 0; i < 30 && ((await token.balanceOf(W.alice.address)) === 0n || !eveHeld.test(logs.join('\n'))); i++) {
    const outs = await Promise.all(['r1', 'r2', 'r3'].map((r) => watch(r, ['--release'])));
    logs.push(...outs.map((o) => o.out));
    await new Promise((res) => setTimeout(res, 2000));
  }
  assert.equal(await token.balanceOf(W.alice.address), parseEther('5'), logs.join('\n'));
  assert.match(logs.join('\n'), /attested lock #3/);
  assert.match(logs.join('\n'), eveHeld);
  assert.equal(await token.balanceOf(W.eve.address), 0n);
  const eveId = await airlock.transferId(srcId, lockbox.target, 3n, W.eve.address, W.eve.address, parseEther('2'));
  const [eveCount, , , eveReady] = await airlock.status(eveId);
  assert.ok(eveCount >= 2n && eveReady > 0n, 'eve\'s transfer passed both lanes and the quarantine: only the hold keeps it');
  assert.equal(await airlock.heldParty(srcId, lockbox.target, W.eve.address, W.eve.address), 1n);
  assert.equal(await airlock.flaggedParty(srcId, lockbox.target, W.eve.address, W.eve.address), 0n);
  await assert.rejects(airlock.release.staticCall(srcId, lockbox.target, 3n, W.eve.address, W.eve.address, parseEther('2'))); // ThreatHeld
  assert.equal(await token.balanceOf(W.attacker.address), 0n);
  assert.equal(await airlock.tripped(W.attacker.address), true);
  assert.match(logs.join('\n'), /attested lock #0/);
  assert.equal(await token.balanceOf(W.mallory.address), 0n);
  assert.match(logs.join('\n'), /lock #2: not attested \(source sender is flagged in the ThreatRegistry/);
  console.log(`alice received 5 bridged USDC via 2 lanes + quarantine; attacker (decoy-marked) received 0; flagged mallory held`);

  // The data feed for other wallets: every standing flag, enforced or not, as JSON.
  const feedFile = join(root, 'threats.json');
  const ex = await cli('r3', ['threat', 'export', '--out', feedFile, '--threats', threats]);
  assert.equal(ex.code, 0, ex.out);
  const feed = JSON.parse(readFileSync(feedFile, 'utf8'));
  assert.equal(feed.format, 'zetaphy-threats/2');
  assert.equal(feed.registry.toLowerCase(), threats.toLowerCase());
  const reg = new Contract(threats, art('ThreatRegistry').abi, zp);
  const malloryKey = (await reg.addressKey(4097n, W.mallory.address)).toLowerCase();
  const eveKey = (await reg.addressKey(4097n, W.eve.address)).toLowerCase();
  assert.deepEqual(feed.keys.find((k) => k.key === malloryKey), { ...feed.keys.find((k) => k.key === malloryKey), reason: 'sweeps-approved-tokens', enforced: true, fast: true });
  assert.deepEqual(feed.keys.find((k) => k.key === eveKey), { ...feed.keys.find((k) => k.key === eveKey), reason: 'sweeps-approved-tokens', enforced: false, fast: false, held: true });
  assert.equal(feed.holdDelay, 600);
  assert.equal(feed.keys.length, 2, ex.out);

  // The flags are cleared by the same quorum: the refused and the held transfers come through.
  await vote('clear');
  await vote('clear', W.eve.address);
  assert.match((await cli('r3', ['threat', 'check', `4097:${W.mallory.address}`, '--threats', threats])).out, /not flagged/);
  for (let i = 0; i < 30 && ((await token.balanceOf(W.mallory.address)) === 0n || (await token.balanceOf(W.eve.address)) === 0n); i++) {
    const outs = await Promise.all(['r1', 'r2', 'r3'].map((r) => watch(r, ['--release'])));
    logs.push(...outs.map((o) => o.out));
    await new Promise((res) => setTimeout(res, 2000));
  }
  assert.equal(await token.balanceOf(W.mallory.address), parseEther('3'), logs.join('\n'));
  assert.equal(await token.balanceOf(W.eve.address), parseEther('2'), logs.join('\n'));
  console.log('after the flags were cleared, mallory\'s refused and eve\'s held transfers came through');

  // User reports: alice pays a small fee to point the runners at a contract; they flag it and share the fee.
  const dr = await cli('gov', ['deploy-reports', '--threats', threats, '--fee', '0.1', '--ttl', '86400', '--community-fund', W.gov.address]);
  assert.equal(dr.code, 0, dr.out);
  const reports = /ThreatReports (0x[0-9a-fA-F]{40})/.exec(dr.out)[1];
  const scam = '0x' + 'dead'.repeat(10);
  const rp = await cli('alice', ['threat', 'report', `4097:${scam}`, '--note', 'airdrop page asks to approve this', '--threats', threats, '--reports', reports]);
  assert.match(rp.out, /report #0 sent \(0\.1 ZETAPHY\)/, rp.out);
  const open = (await cli('r1', ['threat', 'reports', '--threats', threats, '--reports', reports])).out;
  assert.match(open, /#0 open until .*\n  key 0x[0-9a-f]{64}  chain eip155:4097  target 0x[dD][eE][aA][dD]/, open);
  assert.match(open, /1 open report\(s\) of 1/);
  await vote('flag', scam);
  const st = await cli('r1', ['threat', 'settle', '0', '--threats', threats, '--reports', reports]);
  assert.match(st.out, /report #0: flagged \(runners claim the fee\)/, st.out);
  const claims = await Promise.all(['r1', 'r2', 'r3'].map((r) => cli(r, ['threat', 'claim', '0', '--threats', threats, '--reports', reports])));
  assert.equal(claims.filter((x) => /claimed 0\.05 ZETAPHY/.test(x.out)).length, 2, claims.map((x) => x.out).join('\n')); // quorum 2: half each
  assert.match((await cli('r1', ['threat', 'reports', '--threats', threats, '--reports', reports])).out, /0 open report\(s\) of 1/);
  console.log('a user report was flagged by the runners, who shared its fee');

  // Monitoring: one scan from the bridge's first block sees the decoy hit, the governance changes
  // and the day's volume at its limit (5 + 3 + 2 of 10); a guardian's pause shows up in the next scan.
  const mon = (extra = []) => cli('user', ['bridge', 'monitor', '--bridgeGuard', cfg.BridgeGuard, '--airlock', cfg.BridgeAirlock,
    '--state', join(root, 'monitor-state.json'), '--out', join(root, 'monitor.json'), ...extra]);
  const m1 = await mon(['--from-block', '1']);
  assert.equal(m1.code, 0, m1.out);
  let rep = JSON.parse(readFileSync(join(root, 'monitor.json'), 'utf8'));
  const rulesOf = (r) => r.alerts.map((x) => x.rule);
  assert.ok(rulesOf(rep).includes('decoy-hit'), m1.out);
  assert.ok(rep.alerts.some((x) => x.rule === 'decoy-hit' && x.data.who.toLowerCase() === W.attacker.address.toLowerCase()), m1.out);
  assert.ok(rep.alerts.some((x) => x.rule === 'governance-change' && /AuditSet/.test(x.en)), m1.out);
  assert.ok(rep.alerts.some((x) => x.rule === 'governance-change' && /RouteSet/.test(x.en)), m1.out);
  const r = await guard.routes(route);
  if (Number(r.day) === Math.floor(Number((await zp.getBlock('latest')).timestamp) / 86400)) {
    assert.ok(rep.alerts.some((x) => x.rule === 'volume' && x.severity === 'critical' && /= 100% of the daily limit 10/.test(x.en)), m1.out);
  } else console.log('(a UTC day boundary passed during the test: the volume check is skipped)');
  assert.match(m1.out, /ตัวเฝ้าสะพาน ZETAPHY: มีสัญญาณเตือน/);
  assert.equal(rep.caughtUp, true);
  const p = await cli('user', ['bridge', 'pause', '--bridgeGuard', cfg.BridgeGuard, '--airlock', cfg.BridgeAirlock]);
  assert.match(p.out, /BridgeGuard paused/, p.out);
  assert.equal(await guard.paused(), true);
  const m2 = await mon();
  rep = JSON.parse(readFileSync(join(root, 'monitor.json'), 'utf8'));
  assert.ok(rep.alerts.some((x) => x.rule === 'pause' && x.data.by.toLowerCase() === W.user.address.toLowerCase()), m2.out);
  assert.ok(!rulesOf(rep).includes('decoy-hit'), 'the next scan starts after the last scanned block');
  const none = await cli('eve', ['bridge', 'monitor', '--monitor-config', join(root, 'none.json'), '--out', join(root, 'none-report.json')]);
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /notice: no bridge deployed/);
  console.log(`monitor: ${rulesOf(JSON.parse(readFileSync(join(root, 'monitor.json'), 'utf8'))).join(', ')} after the pause`);
});
