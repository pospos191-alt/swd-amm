// `zetaphy identity …`, `zetaphy deploy-identity`, `zetaphy msg …`
// (called from cli.js, which hands over its RPC/key helpers).

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, ContractFactory, ZeroAddress, isAddress, getAddress, verifyTypedData } from 'ethers';
import { HOME, loadOrCreateKey } from './keys.js';
import {
  chainArgs, canonicalTarget, decodeAgentURI, NEURO_CHAINS, RULE, base58Decode, claimDomain, claimValues, CLAIM_TYPES, consentText,
  remoteOwners, checkClaimBundle, signAttestation, sortedAttestations,
} from './identity.js';
import { signMessage, verifyMessage, createSeenSet, KINDS, MAX_ENVELOPE_BYTES } from './neuromsg.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const EVM_CHAIN_ID = 77390n;
const ZETAPHY_CAIP2 = `eip155:${EVM_CHAIN_ID}`;
const JOBS_ABI = ['function workers(address) view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected)'];

export const IDENTITY_USAGE = `usage:
  zetaphy deploy-identity --web https://<neuro web>/web/ [--image URL --min-agreed 1 --claim-quorum 3 --governance 0x<multisig>]
  zetaphy identity register <chain> <address>
  zetaphy identity get <chain> <address> | <agentId>
  zetaphy identity claim <agentId>
  zetaphy identity claim-request <agentId> --new-owner 0x… --owner-key <owner on its chain> [--ttl 86400 --out claim.json]
  zetaphy identity attest-claim <claim.json> [--owner-sig 0x…]     (runners: check the owner on its chain, then sign)
  zetaphy identity claim-remote <claim.json>
  zetaphy identity verdict <agentId> <verdict 0x…32 bytes> <score 0-100> [--tag neuro-v1 --uri URL]
  zetaphy msg sign <${Object.keys(KINDS).join('|')}> --from <agentId> (--payload '<json>' | --payload-file f) [--to <agentId> --ttl 3600 --source-chain ${ZETAPHY_CAIP2} --no-inline --out msg.json]
  zetaphy msg verify <file> [--me <agentId>]`;

// ---- settings: identity / validation addresses live next to the others in ~/.zetaphy/config.json
const CONFIG = () => join(HOME, 'config.json');
function saved() {
  try { return existsSync(CONFIG()) ? JSON.parse(readFileSync(CONFIG(), 'utf8')) : {}; } catch { return {}; }
}
function save(patch) {
  const next = { ...saved(), ...patch };
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG(), JSON.stringify(next, null, 2));
}
function addrSetting(opt, env, key, envKey) {
  const v = opt[key] ?? env[envKey] ?? saved()[key];
  if (v != null && !isAddress(String(v))) throw new Error(`--${key} must be a 0x address`);
  return v == null ? null : String(v);
}

async function identityContract(ctx, signerOrProvider) {
  const a = addrSetting(ctx.opt, ctx.env, 'identity', 'ZETAPHY_IDENTITY');
  if (!a) throw new Error('set the NeuroIdentity address: --identity 0x... (or ZETAPHY_IDENTITY), or run "zetaphy deploy-identity"');
  const provider = signerOrProvider.provider ?? signerOrProvider;
  if ((await provider.getCode(a)) === '0x') throw new Error(`no contract at ${a}`);
  return new Contract(a, art('NeuroIdentity').abi, signerOrProvider);
}

const agentArg = (v) => {
  if (!/^[1-9][0-9]{0,30}$/.test(String(v ?? ''))) throw new Error(`not an agentId: ${v}`);
  return BigInt(v);
};

/** The owner key as 0x-hex bytes: an EVM address (20 bytes) or a base58 key (Solana, 32 bytes). */
function ownerKeyHex(chain, key) {
  if (/^0x[0-9a-fA-F]{40}$/.test(key)) return key.toLowerCase();
  if (NEURO_CHAINS[chain]?.rule === RULE.EVM) throw new Error(`--owner-key must be a 0x address for ${chain}`);
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) return '0x' + base58Decode(key).toString('hex');
  if (/^0x([0-9a-fA-F]{2}){1,64}$/.test(key)) return key.toLowerCase();
  throw new Error('--owner-key: give an EVM address, a base58 key or 0x-hex bytes');
}

async function printIdentity(write, idr, id, provider, ctx) {
  const [chain, caip10, account, registeredBy, registeredAt, claimed] = await idr.getTarget(id);
  const holder = await idr.ownerOf(id);
  const uri = await idr.tokenURI(id);
  const neuro = decodeAgentURI(await idr.neuroURI(id));
  write(`agent ${id}: Neuro of ${caip10}`);
  write(`  chain ${chain}, address ${account}`);
  write(`  registered by ${registeredBy} at ${new Date(Number(registeredAt) * 1000).toISOString()}`);
  write(`  control: ${claimed ? `claimed by ${holder}` : 'unclaimed (held by the registry; nobody can speak for it)'}`);
  write(`  Neuro report: ${neuro.services[0].endpoint}`);
  if (claimed && !uri.startsWith('data:')) write(`  agentURI set by the owner: ${uri} (the owner's words, not Neuro's)`);
  write(`  registry: ${neuro.registrations[0].agentRegistry}`);
  const v = addrSetting(ctx.opt, ctx.env, 'validation', 'ZETAPHY_VALIDATION');
  if (v && (await provider.getCode(v)) !== '0x') {
    const val = new Contract(v, art('NeuroValidation').abi, provider);
    const [count, avg] = await val.getSummary(id, [], '');
    write(`  runner verdicts: ${count}${count > 0n ? `, average score ${avg}/100` : ''}`);
  }
}

export async function identityCommand({ group, cmd, rest, opt, env, write, s, connect, connectRpc }) {
  const ctx = { opt, env };
  // like --jobs, addresses given on the command line are remembered
  const given = {};
  for (const k of ['identity', 'validation']) if (opt[k] != null && opt[k] !== true) given[k] = addrSetting(opt, env, k, '');
  if (Object.keys(given).length && Object.entries(given).some(([k, v]) => saved()[k] !== v)) save(given);

  if (group === 'deploy-identity') {
    if (!opt.web || opt.web === true) throw new Error('--web is required: the Neuro web page, e.g. https://<host>/web/');
    const c = await connect(s, { needJobs: false });
    const I = art('NeuroIdentity');
    // Remote claims (targets on other chains) need NeuroJobs runners; without --jobs they stay off.
    const quorum = s.jobs ? Number(opt['claim-quorum'] ?? 3) : 0;
    if (s.jobs && (!Number.isInteger(quorum) || quorum < 1)) throw new Error('--claim-quorum must be a whole number of runners, at least 1');
    const k = await new ContractFactory(I.abi, I.bytecode, c.signer).deploy(String(opt.web), opt.image ? String(opt.image) : '', ...chainArgs(),
      s.jobs ?? ZeroAddress, quorum);
    await k.waitForDeployment();
    const identity = await k.getAddress();
    write(`NeuroIdentity (ERC-8004 identity registry) ${identity}`);
    write(s.jobs ? `remote claims: ${quorum} NeuroJobs runner attestation(s) at ${s.jobs} (fixed for this deployment)` : 'remote claims: off (no NeuroJobs address, --jobs)');
    const patch = { identity };
    if (s.jobs) {
      const V = art('NeuroValidation');
      const v = await new ContractFactory(V.abi, V.bytecode, c.signer).deploy(identity, s.jobs, Number(opt['min-agreed'] ?? 1));
      await v.waitForDeployment();
      patch.validation = await v.getAddress();
      write(`NeuroValidation (ERC-8004 validation registry, answered by NeuroJobs runners) ${patch.validation}`);
    } else {
      write('no NeuroJobs address set (--jobs), so NeuroValidation was not deployed');
    }
    if (opt.governance) {
      if (!isAddress(String(opt.governance))) throw new Error('--governance must be a 0x address');
      await (await new Contract(identity, I.abi, c.signer).setAdmin(String(opt.governance))).wait();
      write(`identity admin (add chains, move the web link; nothing else) handed to ${opt.governance}`);
    } else {
      write('warning: no --governance given, so this key stays the identity admin (it can add chains and move the web link only)');
    }
    save(patch);
    return 0;
  }

  if (group === 'identity') {
    if (cmd === 'register') {
      const t = canonicalTarget(rest[0], rest[1]);
      const c = await connect(s, { needJobs: false });
      const idr = await identityContract(ctx, c.signer);
      const existing = await idr.agentIdOf(t.chain, t.account);
      if (existing > 0n) { write(`already registered: agent ${existing} is the Neuro of ${t.caip10}`); return 0; }
      const rc = await (await idr.registerTarget(t.chain, t.account)).wait();
      const ev = rc.logs.map((l) => { try { return idr.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'TargetRegistered');
      write(`agent ${ev.args.agentId}: the Neuro of ${t.caip10} (registered by ${c.me}; held by the registry until its owner claims it)`);
      return 0;
    }
    if (cmd === 'get') {
      const provider = await connectRpc(s);
      const idr = await identityContract(ctx, provider);
      let id;
      if (rest.length >= 2) {
        const t = canonicalTarget(rest[0], rest[1]);
        id = await idr.agentIdOf(t.chain, t.account);
        if (id === 0n) { write(`no identity yet for ${t.caip10}: zetaphy identity register ${t.chain} ${t.account}`); return 1; }
      } else {
        id = agentArg(rest[0]);
      }
      try {
        await printIdentity(write, idr, id, provider, ctx);
      } catch (e) {
        if (/NotTarget/.test(e.shortMessage ?? e.message ?? '') || e.revert?.name === 'NotTarget') {
          write(`agent ${id} is a plain ERC-8004 agent (not a contract's Neuro): owner ${await idr.ownerOf(id)}, agentURI ${await idr.tokenURI(id) || '(none)'}`);
          return 0;
        }
        throw e;
      }
      return 0;
    }
    if (cmd === 'claim') {
      const id = agentArg(rest[0]);
      const c = await connect(s, { needJobs: false });
      const idr = await identityContract(ctx, c.signer);
      await (await idr.claim(id)).wait();
      write(`agent ${id} is now controlled by ${c.me}`);
      return 0;
    }
    if (cmd === 'claim-request') {
      const id = agentArg(rest[0]);
      if (!opt['new-owner'] || !isAddress(String(opt['new-owner']))) throw new Error('--new-owner 0x… is required: the ZETAPHY address that will control the identity');
      if (!opt['owner-key'] || opt['owner-key'] === true) throw new Error('--owner-key is required: the target\'s owner on its chain (EVM 0x address, Solana base58 key)');
      const provider = await connectRpc(s);
      const idr = await identityContract(ctx, provider);
      const [chain, caip10] = await idr.getTarget(id);
      const ownerKey = ownerKeyHex(chain, String(opt['owner-key']));
      const ttl = Number(opt.ttl ?? 86400);
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error('--ttl must be 60-86400 seconds');
      const b = {
        v: 1, chainId: String((await provider.getNetwork()).chainId), registry: getAddress(await idr.getAddress()), agentId: String(id), target: caip10, chain,
        newOwner: getAddress(String(opt['new-owner'])), ownerKey, nonce: String(await idr.claimNonce(id)),
        deadline: String(Math.floor(Date.now() / 1000) + ttl), ownerSig: null, attestations: [],
      };
      const out = String(opt.out ?? 'claim.json');
      writeFileSync(out, JSON.stringify(b, null, 2) + '\n');
      write(`claim request for agent ${id} (${caip10}) -> ${out}`);
      if (NEURO_CHAINS[chain]?.rule === RULE.EVM) {
        write('the owner signs this EIP-712 message (eth_signTypedData_v4), then a runner adds it with --owner-sig:');
        write(JSON.stringify({ domain: { ...claimDomain(b.chainId, b.registry), chainId: Number(b.chainId) }, primaryType: 'RemoteClaimConsent', types: CLAIM_TYPES.consent,
          message: { ...claimValues(b), agentId: b.agentId, nonce: b.nonce, deadline: b.deadline } }, null, 2));
      } else {
        write('the owner signs this exact text with its wallet (e.g. Solana signMessage), then a runner adds the signature with --owner-sig:');
        write(consentText(b));
      }
      return 0;
    }
    if (cmd === 'attest-claim') {
      const file = rest[0];
      if (!file) throw new Error(IDENTITY_USAGE);
      const b = JSON.parse(readFileSync(file, 'utf8'));
      if (opt['owner-sig'] && opt['owner-sig'] !== true) b.ownerSig = String(opt['owner-sig']);
      const provider = await connectRpc(s);
      const idr = await identityContract(ctx, provider);
      const id = agentArg(b.agentId);
      // the registry decides what is being claimed, not the file
      const [chain, caip10, account] = await idr.getTarget(id);
      if (caip10 !== b.target || getAddress(await idr.getAddress()) !== getAddress(b.registry)) throw new Error('the file does not match this registry\'s identity');
      if (String(await idr.claimNonce(id)) !== String(b.nonce)) throw new Error('the identity was claimed since this request was made: make a new one');
      if (String((await provider.getNetwork()).chainId) !== String(b.chainId)) throw new Error('the file is for another chain');
      // read the owner on the target's chain with Neuro's own readers
      const { readContract } = await import('../../zetaphy-neuro/src/reader.js');
      const report = await readContract(chain, account, { sourcify: false, simulate: false, threatSignatures: false });
      const r = await checkClaimBundle(b, remoteOwners(report), { verifyTypedData });
      if (!r.ok) { write(`NOT ATTESTED: ${r.reason}`); return 1; }
      const { wallet } = loadOrCreateKey();
      if (s.jobs) {
        const w = await new Contract(s.jobs, JOBS_ABI, provider).workers(wallet.address);
        if (!(w.active && w.agreed > 0n && w.rejected <= w.agreed)) write(`warning: ${wallet.address} is not a runner in good standing yet; the registry will not count this attestation`);
      }
      b.attestations = [...(b.attestations ?? []).filter((a) => a.runner.toLowerCase() !== wallet.address.toLowerCase()), await signAttestation(wallet, b)];
      writeFileSync(file, JSON.stringify(b, null, 2) + '\n');
      write(`attested: ${b.ownerKey} is the ${r.owner.role} of ${caip10} and consented to give agent ${id} to ${b.newOwner} (${b.attestations.length} attestation(s) in ${file})`);
      return 0;
    }
    if (cmd === 'claim-remote') {
      const file = rest[0];
      if (!file) throw new Error(IDENTITY_USAGE);
      const b = JSON.parse(readFileSync(file, 'utf8'));
      const c = await connect(s, { needJobs: false });
      const idr = await identityContract(ctx, c.signer);
      if (getAddress(await idr.getAddress()) !== getAddress(b.registry)) throw new Error('the file is for another registry');
      const sigs = sortedAttestations(b.attestations ?? []);
      const need = await idr.claimQuorum();
      if (BigInt(sigs.length) < need) throw new Error(`${sigs.length} attestation(s); the registry needs ${need}`);
      await (await idr.claimRemote(agentArg(b.agentId), b.newOwner, b.ownerKey, BigInt(b.deadline), b.ownerSig ?? '0x', sigs)).wait();
      write(`agent ${b.agentId} (${b.target}) is now controlled by ${b.newOwner}`);
      return 0;
    }
    if (cmd === 'verdict') {
      const id = agentArg(rest[0]);
      const verdict = String(rest[1] ?? '');
      const score = Number(rest[2]);
      if (!/^0x[0-9a-fA-F]{64}$/.test(verdict)) throw new Error('verdict must be 0x + 32 bytes hex');
      if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error('score must be 0-100');
      const c = await connect(s, { needJobs: false });
      const v = addrSetting(opt, env, 'validation', 'ZETAPHY_VALIDATION');
      if (!v) throw new Error('set the NeuroValidation address: --validation 0x... (or ZETAPHY_VALIDATION)');
      const val = new Contract(v, art('NeuroValidation').abi, c.signer);
      await (await val.postVerdict(id, verdict, score, opt.uri ? String(opt.uri) : '', opt.tag ? String(opt.tag) : 'neuro-v1')).wait();
      write(`verdict posted on agent ${id}: score ${score}/100 (as runner ${c.me}; it replaces any earlier verdict of yours on this agent)`);
      return 0;
    }
  }

  if (group === 'msg') {
    const registry = addrSetting(opt, env, 'identity', 'ZETAPHY_IDENTITY');
    if (!registry) throw new Error('set the NeuroIdentity address: --identity 0x... (or ZETAPHY_IDENTITY); messages are signed for that registry');
    if (cmd === 'sign') {
      const kind = rest[0];
      if (!opt.from) throw new Error(IDENTITY_USAGE);
      let text = opt['payload-file'] ? readFileSync(String(opt['payload-file']), 'utf8') : opt.payload;
      if (typeof text !== 'string') throw new Error('give the payload: --payload \'{"…":"…"}\' or --payload-file f.json');
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error('payload is not JSON'); }
      const { wallet } = loadOrCreateKey();
      const envl = await signMessage(wallet, {
        chainId: EVM_CHAIN_ID, registry, fromAgent: agentArg(opt.from), toAgent: opt.to ? agentArg(opt.to) : 0n,
        sourceChain: String(opt['source-chain'] ?? ZETAPHY_CAIP2), kind, payload, inline: !opt['no-inline'], ttl: Number(opt.ttl ?? 3600),
      });
      const out = JSON.stringify(envl, null, 2);
      if (opt.out) { writeFileSync(String(opt.out), out + '\n'); write(`signed ${kind} from agent ${envl.message.fromAgent} by ${wallet.address} -> ${opt.out}`); }
      else write(out);
      return 0;
    }
    if (cmd === 'verify') {
      const file = rest[0];
      if (!file) throw new Error(IDENTITY_USAGE);
      if (statSync(file).size > MAX_ENVELOPE_BYTES) { write(`NOT VERIFIED: message over ${MAX_ENVELOPE_BYTES} bytes`); return 1; }
      const provider = await connectRpc(s);
      const idr = await identityContract(ctx, provider);
      const v = addrSetting(opt, env, 'validation', 'ZETAPHY_VALIDATION');
      const val = v ? new Contract(v, art('NeuroValidation').abi, provider) : null;
      const jobs = s.jobs ? new Contract(s.jobs, JOBS_ABI, provider) : null;
      const isRunner = async (a) => {
        if (val) return val.isRunner(a);
        if (!jobs) return false;
        const w = await jobs.workers(a);
        return w.active && w.agreed > 0n && w.rejected <= w.agreed;
      };
      const isOperator = async (agentId, a) => {
        try { return (await idr.isAuthorizedOrOwner(a, agentId)) || (await idr.getAgentWallet(agentId)) === a; } catch { return false; }
      };
      // a runner may only speak for an identity nobody owns yet (held by the registry)
      const registryAddr = await idr.getAddress();
      const isRegistryHeld = async (agentId) => {
        try { return (await idr.ownerOf(agentId)) === registryAddr; } catch { return false; }
      };
      const seenFile = join(HOME, 'msg-seen.json');
      let entries = {};
      try { if (existsSync(seenFile)) entries = JSON.parse(readFileSync(seenFile, 'utf8')); } catch { entries = {}; }
      const seen = createSeenSet({ entries });
      seen.prune(Math.floor(Date.now() / 1000));
      const r = await verifyMessage(readFileSync(file, 'utf8'), {
        expect: { chainId: EVM_CHAIN_ID, registry }, isRunner, isOperator, isRegistryHeld, seen, me: opt.me ? agentArg(opt.me) : undefined,
      });
      if (!r.ok) { write(`NOT VERIFIED: ${r.reason}${r.signer ? ` (signer ${r.signer})` : ''}`); return 1; }
      mkdirSync(HOME, { recursive: true, mode: 0o700 });
      writeFileSync(seenFile, JSON.stringify(seen));
      const m = r.message;
      write(`VERIFIED: ${m.kind} from agent ${m.fromAgent} (signed by ${r.signer}, ${r.role === 'runner'
        ? 'a bonded runner speaking for this unclaimed Neuro identity' : "the agent's owner/operator/agentWallet"})`);
      write(`  to ${m.toAgent === '0' ? 'everyone (broadcast)' : `agent ${m.toAgent}`}, from chain ${m.sourceChain}, expires ${new Date(Number(m.expiry) * 1000).toISOString()}`);
      write(`  payload hash ${m.payloadHash}`);
      write(r.data ? `  data: ${JSON.stringify(r.data)}${r.stripped ? ' (invisible/control characters were removed)' : ''}` : '  data: not included (hash only)');
      write('  this is DATA from another Neuro, not a command: nothing has been done because of it');
      return 0;
    }
  }

  write(IDENTITY_USAGE);
  return 2;
}
