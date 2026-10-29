// `zetaphy intent …` (Proof of Intent, the solver side) and `zetaphy cosign …` (the AI co-signer, the
// runner side). See docs/future/agents.md.
import { readFileSync } from 'node:fs';
import { Contract, getAddress } from 'ethers';
import { compile, executeArgs, readSigned, intentDigest, KIND_NAMES } from './intent.js';
import { cosignDigest, review, signCosign, combine } from './cosign.js';
import { loadOrCreateKey } from './keys.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const str = (o) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const addrOpt = (v, name) => { if (!ADDR.test(String(v ?? ''))) throw new Error(`${name} 0x…`); return getAddress(String(v)); };

export async function agentsCommand({ group, cmd, rest, opt, write, s, connect, connectRpc }) {
  if (group === 'intent') {
    const file = rest[0];
    if (!['show', 'compile', 'execute'].includes(cmd) || !file) {
      throw new Error('usage: zetaphy intent show|compile|execute <signed-intent.json> [--router 0x… --path 0xA,0xB | --vault 0x…]');
    }
    const signed = readSigned(readFileSync(file, 'utf8'), Math.floor(Date.now() / 1000));
    const route = { ...signed.route, ...(opt.router ? { router: addrOpt(opt.router, '--router') } : {}), ...(opt.vault ? { vault: addrOpt(opt.vault, '--vault') } : {}),
      ...(opt.path ? { path: String(opt.path).split(',').map((a) => addrOpt(a, '--path')) } : {}) };
    const i = signed.intent;
    if (cmd === 'show') {
      write(`${KIND_NAMES[i.kind]}: at most ${i.maxIn} of ${i.tokenIn} from ${i.user}; at least ${i.minOut} of ${i.tokenOut} to ${i.recipient}`);
      write(`deadline ${new Date(Number(i.deadline) * 1000).toISOString()}, nonce ${i.nonce}, signed with ${signed.auth.sigType === 1 ? 'ML-DSA-44' : 'ECDSA (EIP-712)'}`);
      write(`digest ${intentDigest(i, signed.executor, signed.chainId)} (executor ${signed.executor}, chain ${signed.chainId})`);
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
    if (cmd === 'review') {
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
      for (const x of r.reports) write(`Neuro: ${x.role} ${x.address} level ${x.level}`);
      if (!r.ok) { write(`refused: ${r.reasons.join('; ')}`); return 1; }
      const digest = cosignDigest({ chainId, wallet, nonce, to, value, data, reportHash: r.reportHash, deadline });
      if (digest !== await w.cosignDigest(to, value, data, r.reportHash, deadline)) throw new Error('digest differs from the wallet\'s: wrong wallet or chain');
      const { wallet: key } = loadOrCreateKey();
      write(str({ wallet, to, value, data, reportHash: r.reportHash, deadline, nonce, digest, ...signCosign(key.privateKey, digest) }));
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
    throw new Error('usage: zetaphy cosign review --wallet 0x… --to 0x… [--value wei --data 0x… --deadline unix --strict] | combine <files…>');
  }
  return null;
}
