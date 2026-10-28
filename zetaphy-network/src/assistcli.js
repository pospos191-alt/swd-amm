// zetaphy certify | attest-pq | immune: the crosschain-assist commands (docs/future/crosschain-assist.md).
//   zetaphy certify <token 0x…> --attest 0x<NeuroAttest> [--model rules] [--uri <where the report is>]
//        run Neuro on a token on ZETAPHY and attest it "Neuro-checked" (this key must be an approved attester)
//   zetaphy certify from-job <jobId> <token 0x…> --attest 0x…   anyone: a settled NeuroJobs verdict becomes the certificate
//   zetaphy certify show <token 0x…> --attest 0x…               the badge (read only)
//   zetaphy attest-pq sign <report.json> [--model name] [--out file] [--no-report]   ML-DSA-44 archive (~/.zetaphy/pq.seed)
//   zetaphy attest-pq verify <archive.json> [--trusted 0x<keyHash>,…]   tamper check (+ the anchor on ZETAPHY when --rpc is set)
//   zetaphy attest-pq anchor <archive.json> --anchor 0x<NeuroAnchor>    anchor its hash on ZETAPHY; writes the anchor into the file
//   zetaphy immune push --sender 0x<NeuroOracleSender> [--once] [--interval 30] [--max-fee 0.1]   herd-immunity pusher
//   zetaphy immune coverage --sender 0x… --mirror <name>=<rpc>@0x<NeuroOracle> [--mirror …]       coverage per chain (read only)
//   zetaphy deploy-assist attest|anchor|insurance [--governance 0x… --jobs 0x… --quorum 3 --min-agreed 1]
//        deploy NeuroAttest (attestFromJob reads --jobs), NeuroAnchor, or the testnet-only HackInsurance (committee: --jobs runners)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { ContractFactory } from 'ethers';
import { join } from 'node:path';
import { Contract, JsonRpcProvider, parseEther, formatEther, getAddress, decodeBytes32String, encodeBytes32String } from 'ethers';
import { readContract } from '../../zetaphy-neuro/src/reader.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';
import { skillId } from './skill.js';
import { HOME } from './keys.js';
import { loadOrCreatePq } from './pq.js';
import { reportPayload, signPayload, verifyFile, archiveHash, NODE_CRYPTO } from './pqattest.js';
import { senderContract, oracleContract, pushRound, measure, coverageText } from './neurooracle.js';

export const ATTEST_ABI = [
  'function attest(address subject, bytes32 reportHash, bytes32 skill, bytes32 model, string uri) returns (uint256)',
  'function attestFromJob(uint256 jobId, address subject) returns (uint256)',
  'function badge(address subject) view returns (bool checked, uint256 uid, bytes32 reportHash, bytes32 skill, bytes32 model, address by, uint64 time)',
  'function attester(address) view returns (bool)',
];
const ANCHOR_ABI = ['function anchor(bytes32 h)', 'function anchoredAt(bytes32 h) view returns (uint64, uint64, address)'];
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const need = (v, what) => { if (!ADDR_RE.test(String(v ?? ''))) throw new Error(`${what} 0x… is needed`); return getAddress(String(v)); };
const model32 = (m) => encodeBytes32String(String(m ?? 'rules').slice(0, 31));

/**
 * Runs Neuro on `token` on ZETAPHY and attests it: { report, reportHash, skill, uid }. `read` and `skill` are
 * injectable for tests (default: zetaphy-neuro's reader on the given RPC, this checkout's skill id).
 */
export async function certify({ attest, token, rpc, model = 'rules', uri = '', read = readContract, skill = skillId() }) {
  const report = await read('zetaphy', token, { chainConfig: { kind: 'evm', id: 77390, name: 'ZETAPHY testnet', rpcs: [rpc] }, sourcify: false });
  const reportHash = await verdictOf(report);
  const tx = await attest.attest(getAddress(token), reportHash, skill, model32(model), String(uri || `neuro:zetaphy:${token.toLowerCase()}`).slice(0, 200));
  const rc = await tx.wait();
  const uid = rc?.logs?.length ? BigInt(rc.logs[0].topics[1]) : null;
  return { report, reportHash, skill, uid };
}

/** The badge as words: "Neuro-checked by 0x… (skill 0x…, model …) at …" or why not. */
export function badgeText(b) {
  if (!b || b.uid === 0n) return 'not Neuro-checked (no attestation)';
  const model = (() => { try { return decodeBytes32String(b.model); } catch { return b.model; } })();
  const when = new Date(Number(b.time) * 1000).toISOString();
  return b.checked
    ? `Neuro-checked: attestation #${b.uid} by ${b.by} at ${when}; report ${b.reportHash}, skill ${b.skill}, model ${model}. A check, not a guarantee: read the report.`
    : `attestation #${b.uid} was REVOKED by governance or its attester`;
}

function parseMirrors(list) {
  return [].concat(list ?? []).map((m) => {
    const x = /^([a-z0-9]{1,31})=(https?:\/\/[^@\s]+)@(0x[0-9a-fA-F]{40})$/.exec(String(m));
    if (!x) throw new Error(`--mirror <name>=<rpc>@0x<NeuroOracle>, not ${m}`);
    return { name: x[1], oracle: oracleContract(x[3], new JsonRpcProvider(x[2], undefined, { staticNetwork: true })) };
  });
}

export async function assistCommand({ group, cmd, rest, opt, write, s, connect, connectRpc, argv = [] }) {
  if (group === 'certify') {
    if (cmd === 'show') {
      const p = await connectRpc(s);
      write(badgeText(await new Contract(need(opt.attest, '--attest'), ATTEST_ABI, p).badge(need(rest[0], 'the token'))));
      return 0;
    }
    const c = await connect(s, { needJobs: false });
    const attest = new Contract(need(opt.attest, '--attest'), ATTEST_ABI, c.signer);
    if (cmd === 'from-job') {
      if (!/^\d+$/.test(rest[0] ?? '')) throw new Error('usage: zetaphy certify from-job <jobId> <token 0x…> --attest 0x…');
      await (await attest.attestFromJob(BigInt(rest[0]), need(rest[1], 'the token'))).wait();
      write(badgeText(await attest.badge(need(rest[1], 'the token'))));
      return 0;
    }
    const token = need(cmd, 'usage: zetaphy certify <token 0x…> --attest 0x…; the token');
    if (!(await attest.attester(c.me))) throw new Error(`${c.me} is not an approved attester of ${await attest.getAddress()} (governance: setAttester)`);
    const r = await certify({ attest, token, rpc: s.rpc, model: opt.model ?? 'rules', uri: opt.uri ?? '' });
    write(`Neuro report of ${token}: level ${r.report.analysis?.level ?? '?'}, verdict hash ${r.reportHash}, skill ${r.skill}`);
    write(badgeText(await attest.badge(token)));
    return 0;
  }

  if (group === 'attest-pq') {
    const file = rest[0];
    if (!file) throw new Error('usage: zetaphy attest-pq sign|verify|anchor <file>');
    if (cmd === 'sign') {
      const report = JSON.parse(readFileSync(file, 'utf8'));
      const key = loadOrCreatePq();
      const payload = await reportPayload(report, { skill: skillId(), model: opt.model ?? 'rules', includeReport: !opt['no-report'] });
      const a = await signPayload(payload, key);
      const out = String(opt.out ?? file.replace(/(\.json)?$/, '.pq.json'));
      writeFileSync(out, JSON.stringify(a, null, 2) + '\n');
      write(`signed ${out}: ML-DSA-44 key ${a.signature.keyHash}, archive hash ${await archiveHash(a, NODE_CRYPTO)}`);
      return 0;
    }
    const a = JSON.parse(readFileSync(file, 'utf8'));
    if (cmd === 'verify') {
      const provider = s.rpc && a.anchor ? await connectRpc(s) : null;
      const r = await verifyFile(a, { provider, trustedKeys: String(opt.trusted ?? '').split(',').filter(Boolean) });
      write(r.ok ? `VALID: payload ${r.payloadHash}, signed with ML-DSA-44 key ${r.keyHash} (${r.signer === 'trusted' ? 'a key you trust' : 'a key you did not list as trusted'})${r.anchored ? `, anchored at ${new Date(r.anchored.time * 1000).toISOString()} (block ${r.anchored.block})` : a.anchor ? ', anchor not checked (no --rpc)' : ', not anchored'}`
        : `NOT VALID:\n  - ${r.problems.join('\n  - ')}`);
      return r.ok ? 0 : 1;
    }
    if (cmd === 'anchor') {
      const c = await connect(s, { needJobs: false });
      const addr = need(opt.anchor, '--anchor');
      const h = await archiveHash(a, NODE_CRYPTO);
      const k = new Contract(addr, ANCHOR_ABI, c.signer);
      let [time, block] = await k.anchoredAt(h);
      if (time === 0n) { await (await k.anchor(h)).wait(); [time, block] = await k.anchoredAt(h); }
      a.anchor = { chainId: 77390, contract: addr, hash: h, time: Number(time), block: Number(block) };
      writeFileSync(file, JSON.stringify(a, null, 2) + '\n');
      write(`anchored ${h} at ${new Date(Number(time) * 1000).toISOString()} (block ${block})`);
      return 0;
    }
  }

  if (group === 'immune') {
    const senderAddr = need(opt.sender, '--sender');
    if (cmd === 'coverage') {
      const p = await connectRpc(s);
      const mirrors = parseMirrors(argv.filter((x, i) => argv[i - 1] === '--mirror'));
      const m = await measure(senderContract(senderAddr, p), mirrors);
      write(`ZETAPHY: ${m.flagged} key(s) flagged now`);
      for (const x of m.mirrors) write(x.error ? `  ${x.name}: unreachable (${x.error})` : `  ${x.name}: ${coverageText(x.share)} (${x.mirrored}/${x.flagged})${x.paused ? ' PAUSED' : ''}`);
      return 0;
    }
    if (cmd === 'push') {
      const c = await connect(s, { needJobs: false });
      const sender = senderContract(senderAddr, c.signer);
      const registry = await sender.threats();
      const stateFile = join(HOME, `immune-${senderAddr.toLowerCase()}.json`);
      let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
      const maxFee = parseEther(String(opt['max-fee'] ?? '0.1'));
      const interval = Math.max(5, Number(opt.interval ?? 30)) * 1000;
      for (;;) {
        const r = await pushRound({ sender, provider: c.provider, registry, state, maxFee, log: write });
        state = r.state;
        mkdirSync(HOME, { recursive: true, mode: 0o700 });
        writeFileSync(stateFile, JSON.stringify(state));
        if (opt.once) { write(`pushed ${r.sent.length} message(s); balance ${formatEther(await c.provider.getBalance(c.me))} ZETAPHY`); return 0; }
        await new Promise((res) => setTimeout(res, interval));
      }
    }
  }
  if (group === 'deploy-assist') {
    const c = await connect(s, { needJobs: false });
    const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
    const gov = opt.governance ? need(opt.governance, '--governance') : c.me;
    const jobs = opt.jobs ? need(opt.jobs, '--jobs') : (s.jobs ? getAddress(s.jobs) : null);
    const args = { attest: () => ['NeuroAttest', [jobs ?? '0x' + '00'.repeat(20), gov]], anchor: () => ['NeuroAnchor', []],
      insurance: () => { if (!jobs) throw new Error('--jobs 0x<NeuroJobs> (the committee is its runners)'); return ['HackInsurance', [jobs, Number(opt.quorum ?? 3), Number(opt['min-agreed'] ?? 1), gov]]; } }[cmd];
    if (!args) throw new Error('usage: zetaphy deploy-assist attest|anchor|insurance');
    const [name, a] = args();
    const k = await new ContractFactory(art(name).abi, art(name).bytecode, c.signer).deploy(...a);
    await k.waitForDeployment();
    write(`${name} ${await k.getAddress()}${a.length ? ` (governance ${gov})` : ''}${name === 'HackInsurance' ? ' TESTNET ONLY: testnet ZETAPHY has no value; never real money' : ''}`);
    return 0;
  }
  throw new Error('usage: see `zetaphy` (certify | attest-pq | immune | deploy-assist)');
}
