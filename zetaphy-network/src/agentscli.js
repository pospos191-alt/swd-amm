// `zetaphy intent …` (Proof of Intent, the solver side) and `zetaphy cosign …` (the AI co-signer, the
// runner side). See docs/future/agents.md.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Contract, getAddress } from 'ethers';
import { compile, executeArgs, spendArgs, readSigned, intentDigest, KIND_NAMES } from './intent.js';
import { cosignDigest, review, signCosign, combine } from './cosign.js';
import { loadOrCreateKey, HOME, sealSecret, openSecret } from './keys.js';
import { dkgRound1, dkgRound2, dkgRound3, signRound1, signingPackage, signRound2, aggregateShares } from './frost.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const str = (o) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const addrOpt = (v, name) => { if (!ADDR.test(String(v ?? ''))) throw new Error(`${name} 0x…`); return getAddress(String(v)); };

/** A FROST secret (DKG polynomial, signing share, nonces) on disk: mode 0600, sealed when ZETAPHY_PASSPHRASE is set. */
export function writeFrostSecret(file, obj) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(obj);
  const pass = process.env.ZETAPHY_PASSPHRASE;
  writeFileSync(file, pass ? JSON.stringify({ sealed: JSON.parse(sealSecret(text, pass)) }) : text, { mode: 0o600 });
}
export function readFrostSecret(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (!j.sealed) return j;
  if (!process.env.ZETAPHY_PASSPHRASE) throw new Error(`${file} is sealed: set ZETAPHY_PASSPHRASE`);
  return JSON.parse(openSecret(JSON.stringify(j.sealed), process.env.ZETAPHY_PASSPHRASE));
}

/** What a committee member checks before co-signing: Neuro on what the action touches, then the wallet's digest. */
export async function reviewedDigest({ opt, s, connectRpc }) {
  const wallet = addrOpt(opt.wallet, '--wallet');
  const to = addrOpt(opt.to, '--to');
  const value = BigInt(opt.value ?? 0);
  const data = String(opt.data ?? '0x');
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new Error('--data 0x…');
  const deadline = BigInt(opt.deadline ?? Math.floor(Date.now() / 1000) + 600);
  const provider = await connectRpc(s);
  const chainId = (await provider.getNetwork()).chainId;
  const w = new Contract(wallet, art('AgentPolicyWallet').abi, provider);
  const nonce = await w.cosignNonce();
  const chainConfig = { kind: 'evm', id: Number(chainId), name: 'ZETAPHY testnet', rpcs: [s.rpc] };
  const r = await review({ to, data, strict: Boolean(opt.strict), chainConfig, hasCode: async (a) => (await provider.getCode(a)) !== '0x' });
  const digest = cosignDigest({ chainId, wallet, nonce, to, value, data, reportHash: r.reportHash, deadline });
  if (digest !== await w.cosignDigest(to, value, data, r.reportHash, deadline)) throw new Error('digest differs from the wallet\'s: wrong wallet or chain');
  return { ...r, wallet, to, value, data, deadline, nonce, digest };
}

export async function agentsCommand({ group, cmd, rest, opt, write, s, connect, connectRpc, deps = {} }) {
  if (group === 'intent') {
    const file = rest[0];
    if (!['show', 'compile', 'execute', 'spend'].includes(cmd) || !file) {
      throw new Error('usage: zetaphy intent show|compile|execute <signed-intent.json> [--router 0x… --path 0xA,0xB | --vault 0x… | --bridge 0x…]\n'
        + '       zetaphy intent spend <signed allowance intent> --to 0x… --amount <base units>   (the spender of an approve intent)');
    }
    const signed = readSigned(readFileSync(file, 'utf8'), Math.floor(Date.now() / 1000));
    const route = { ...signed.route, ...(opt.router ? { router: addrOpt(opt.router, '--router') } : {}), ...(opt.vault ? { vault: addrOpt(opt.vault, '--vault') } : {}),
      ...(opt.bridge ? { bridge: addrOpt(opt.bridge, '--bridge') } : {}), ...(opt.path ? { path: String(opt.path).split(',').map((a) => addrOpt(a, '--path')) } : {}) };
    const i = signed.intent;
    if (cmd === 'show') {
      const kind = KIND_NAMES[i.kind];
      if (kind === 'approve') write(`approve: ${i.recipient} may take up to ${i.maxIn} of ${i.tokenIn} from ${i.user} in total, until the deadline`);
      else if (kind === 'bridge') write(`bridge: exactly ${i.maxIn} of ${i.tokenIn} from ${i.user} to ${i.recipient} on the other chain`);
      else write(`${kind}: at most ${i.maxIn} of ${i.tokenIn} from ${i.user}; at least ${i.minOut} of ${i.tokenOut} to ${i.recipient}`);
      write(`deadline ${new Date(Number(i.deadline) * 1000).toISOString()}, nonce ${i.nonce}, signed with ${signed.auth.sigType === 1 ? 'ML-DSA-44' : 'ECDSA (EIP-712)'}`);
      write(`digest ${intentDigest(i, signed.executor, signed.chainId)} (executor ${signed.executor}, chain ${signed.chainId})`);
      return 0;
    }
    if (cmd === 'spend') {
      const to = addrOpt(opt.to, '--to');
      if (!/^\d{1,78}$/.test(String(opt.amount ?? ''))) throw new Error('--amount <base units>');
      const c = await connect(s, { needJobs: false });
      const net = await c.provider.getNetwork();
      if (net.chainId !== signed.chainId) throw new Error(`the intent is for chain ${signed.chainId}, the RPC is ${net.chainId}`);
      const exe = new Contract(signed.executor, art('IntentExecutor').abi, c.signer);
      const args = spendArgs(i, signed.auth, to, BigInt(opt.amount));
      const left = await exe.spendAllowance.staticCall(...args);
      const tx = await exe.spendAllowance(...args);
      await tx.wait();
      write(`pulled ${opt.amount} to ${to} (${tx.hash}); ${left} left until ${new Date(Number(i.deadline) * 1000).toISOString()}`);
      return 0;
    }
    const plan = compile(i, route);
    if (cmd === 'compile') { write(str(plan)); return 0; }
    const c = await connect(s, { needJobs: false });
    const net = await c.provider.getNetwork();
    if (net.chainId !== signed.chainId) throw new Error(`the intent is for chain ${signed.chainId}, the RPC is ${net.chainId}`);
    const exe = new Contract(signed.executor, art('IntentExecutor').abi, c.signer);
    const args = executeArgs(i, signed.auth, plan);
    const [spent, received] = await exe.execute.staticCall(...args); // fails here, with the reason, before any gas is spent
    const tx = await exe.execute(...args);
    await tx.wait();
    write(`executed ${tx.hash}: spent ${spent}, recipient got ${received}`);
    return 0;
  }

  if (group === 'cosign') {
    const reviewed = deps.reviewedDigest ?? ((o) => reviewedDigest({ opt: o, s, connectRpc }));
    if (cmd === 'review') {
      const r = await reviewed(opt);
      for (const x of r.reports) write(`Neuro: ${x.role} ${x.address} level ${x.level}`);
      if (!r.ok) { write(`refused: ${r.reasons.join('; ')}`); return 1; }
      const { wallet: key } = loadOrCreateKey();
      write(str({ wallet: r.wallet, to: r.to, value: r.value, data: r.data, reportHash: r.reportHash, deadline: r.deadline, nonce: r.nonce, digest: r.digest, ...signCosign(key.privateKey, r.digest) }));
      return 0;
    }
    if (cmd === 'combine') {
      if (rest.length < 1) throw new Error('usage: zetaphy cosign combine <a.json> <b.json> …   (the answers of `zetaphy cosign review`)');
      const parts = rest.map((f) => JSON.parse(readFileSync(f, 'utf8')));
      const digest = parts[0].digest;
      if (parts.some((p) => p.digest !== digest)) throw new Error('the runners signed different digests (another nonce, deadline or Neuro report): ask again');
      const p = parts[0];
      write(str({ executeCosigned: [p.to, p.value, p.data, '<modelHash>', '<promptHash>', p.reportHash, p.deadline, combine(digest, parts)] }));
      return 0;
    }

    // ---- FROST threshold signatures (src/frost.js): DKG in three steps, then two signing rounds. Every message is a
    //      JSON file (or a copy-paste); secrets stay on each member's machine (mode 0600, sealed with ZETAPHY_PASSPHRASE).
    const emit = (obj, what) => {
      const text = str(obj);
      if (typeof opt.out === 'string') { writeFileSync(opt.out, `${text}\n`); write(`${what} written to ${opt.out}`); } else write(text);
    };
    const files = (list) => list.map((f) => JSON.parse(readFileSync(f, 'utf8')));
    if (cmd === 'dkg1') {
      const id = Number(opt.id), threshold = Number(opt.threshold), participants = Number(opt.participants);
      const session = String(opt.session ?? '');
      const { secret, pkg } = dkgRound1({ id, threshold, participants, session });
      const file = typeof opt.secret === 'string' ? opt.secret : join(HOME, 'frost', `dkg-${session}-${id}.secret.json`);
      writeFrostSecret(file, secret);
      write(`DKG round 1 (participant ${id} of ${participants}, threshold ${threshold}); secret kept at ${file}`);
      emit(pkg, 'round-1 package (send it to every participant)');
      return 0;
    }
    if (cmd === 'dkg2') {
      if (!opt.secret || rest.length < 2) throw new Error('usage: zetaphy cosign dkg2 --secret <dkg secret file> <round-1 package of EVERY participant, yours too…> [--out f]');
      const secret = readFrostSecret(String(opt.secret));
      const msg = dkgRound2({ secret, packages: files(rest) });
      write(`transcript ${msg.transcript}   ← compare with every participant (out of band) before round 3`);
      emit(msg, 'round-2 message (encrypted shares; send it to every participant)');
      return 0;
    }
    if (cmd === 'dkg3') {
      if (!opt.secret || typeof opt.round1 !== 'string' || rest.length < 1) throw new Error('usage: zetaphy cosign dkg3 --secret <dkg secret file> --round1 a.json,b.json,… <round-2 message of every other participant…> [--key f --out group.json]');
      const secretFile = String(opt.secret);
      const secret = readFrostSecret(secretFile);
      const { key, group: g } = dkgRound3({ secret, packages: files(String(opt.round1).split(',')), round2: files(rest) });
      const keyFile = typeof opt.key === 'string' ? opt.key : join(HOME, 'frost', `${g.groupKey.slice(0, 16)}-${key.id}.key.json`);
      writeFrostSecret(keyFile, key);
      rmSync(secretFile, { force: true }); // the polynomial is no longer needed
      write(`group key 0x${g.groupKey} (threshold ${g.threshold} of ${g.participants}), transcript ${g.transcript}`);
      write(`my signing key: ${keyFile}. Governance sets the committee's key with setFrostKey(0x${g.groupKey}).`);
      emit(g, 'group file (public: share it with the agent and the other members)');
      return 0;
    }
    if (cmd === 'commit') {
      if (!opt.key) throw new Error('usage: zetaphy cosign commit --key <frost key file> [--out f]');
      const key = readFrostSecret(String(opt.key));
      const { nonces, commitment } = signRound1(key);
      const file = join(dirname(String(opt.key)), `${key.groupKey.slice(0, 16)}-${key.id}.nonces-${commitment.hiding.slice(2, 18)}.json`);
      writeFrostSecret(file, nonces);
      write(`signing round 1: nonces kept at ${file} (used once, then deleted)`);
      emit(commitment, 'commitment (send it to the agent)');
      return 0;
    }
    if (cmd === 'frost-package') {
      if (!opt.group || rest.length < 1) throw new Error('usage: zetaphy cosign frost-package --group group.json --wallet 0x… --to 0x… [--value --data --deadline --strict] <commitment files…> [--out f]');
      const g = JSON.parse(readFileSync(String(opt.group), 'utf8'));
      const r = await reviewed(opt);
      for (const x of r.reports) write(`Neuro: ${x.role} ${x.address} level ${x.level}`);
      if (!r.ok) { write(`refused: ${r.reasons.join('; ')}`); return 1; }
      const pkg = signingPackage({ group: g, digest: r.digest, commitments: files(rest),
        extra: { wallet: r.wallet, to: r.to, value: String(r.value), data: r.data, deadline: String(r.deadline), strict: Boolean(opt.strict), reportHash: r.reportHash, nonce: String(r.nonce) } });
      emit(pkg, 'signing package (send it to the signers)');
      return 0;
    }
    if (cmd === 'frost-sign') {
      if (!opt.key || !opt.package) throw new Error('usage: zetaphy cosign frost-sign --key <frost key file> --package pkg.json [--out f]');
      const key = readFrostSecret(String(opt.key));
      const pkg = JSON.parse(readFileSync(String(opt.package), 'utf8'));
      const mine = (pkg.commitments ?? []).find((c) => c.id === key.id);
      if (!mine) throw new Error('my commitment is not in this package');
      const nonceFile = join(dirname(String(opt.key)), `${key.groupKey.slice(0, 16)}-${key.id}.nonces-${String(mine.hiding).slice(2, 18)}.json`);
      if (!existsSync(nonceFile)) throw new Error('no unused nonces for this commitment (each commitment signs once): run `zetaphy cosign commit` again');
      // the member re-runs Neuro and computes the digest itself: it signs what it checked, not what it was told
      write(`co-signing for wallet ${pkg.wallet}: call ${pkg.to}, value ${pkg.value}, data ${String(pkg.data).slice(0, 74)}${String(pkg.data).length > 74 ? '…' : ''}, deadline ${pkg.deadline}`);
      const r = await reviewed({ wallet: pkg.wallet, to: pkg.to, value: pkg.value, data: pkg.data, deadline: pkg.deadline, strict: pkg.strict || opt.strict });
      for (const x of r.reports) write(`Neuro: ${x.role} ${x.address} level ${x.level}`);
      if (!r.ok) { write(`refused: ${r.reasons.join('; ')}`); return 1; }
      const nonces = readFrostSecret(nonceFile);
      rmSync(nonceFile, { force: true }); // before signing: a nonce pair must never sign twice
      emit(signRound2({ key, nonces, pkg, expectDigest: r.digest }), 'signature share (send it to the agent)');
      return 0;
    }
    if (cmd === 'frost-aggregate') {
      if (!opt.group || !opt.package || rest.length < 1) throw new Error('usage: zetaphy cosign frost-aggregate --group group.json --package pkg.json <share files…>');
      const g = JSON.parse(readFileSync(String(opt.group), 'utf8'));
      const pkg = JSON.parse(readFileSync(String(opt.package), 'utf8'));
      const sig = aggregateShares({ group: g, pkg, shares: files(rest) });
      write(str({ executeCosignedFrost: [pkg.to, pkg.value, pkg.data, '<modelHash>', '<promptHash>', pkg.reportHash, pkg.deadline, sig] }));
      return 0;
    }
    throw new Error('usage: zetaphy cosign review --wallet 0x… --to 0x… [--value wei --data 0x… --deadline unix --strict] | combine <files…>\n'
      + '       FROST: dkg1 | dkg2 | dkg3 | commit | frost-package | frost-sign | frost-aggregate (docs/future/agents.md §14)');
  }
  return null;
}
