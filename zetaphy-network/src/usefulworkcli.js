// `zetaphy work …` and `zetaphy bounty …` (called from cli.js, which hands over its RPC/key helpers).
// Runners check what browsers did (docs/future/useful-work.md): the same code-only scan, the same
// finding replay, then (bounty check --attest) their attestation on BugBounty.
import { readFileSync } from 'node:fs';
import { Contract, isAddress, getBytes, toUtf8String, keccak256 } from 'ethers';
import { CHAINS } from '../../zetaphy-neuro/src/chains.js';
import { createRpc } from '../../zetaphy-neuro/src/rpc.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));

export const WORK_USAGE = `usage:
  zetaphy work verdict <chain> <address>              the code-only verdict a browser computes for a scan job (and the codeHash to post)
  zetaphy work verify-finding <spec.json> <finding.json | 0x…bytes>   replay a bug finding against a bounty spec (offline)
  zetaphy bounty check <findingId> --bounty 0x<BugBounty> --spec <spec.json> [--attest]
                                                     read a revealed finding, check spec hash + replay; --attest votes on-chain`;

const readFinding = (arg) => (/^0x[0-9a-fA-F]*$/.test(arg) ? getBytes(arg) : new TextEncoder().encode(readFileSync(arg, 'utf8').trim()));

export async function usefulWorkCommand({ group, cmd, rest, opt, write, s, connect, connectRpc }) {
  const uw = await import('./usefulwork.js');
  if (group === 'work' && cmd === 'verdict') {
    const [chain, target] = rest;
    if (!chain || !isAddress(target ?? '')) { write(WORK_USAGE); return 2; }
    let code;
    if (chain === 'zetaphy') code = await (await connectRpc(s)).getCode(target);
    else {
      const c = CHAINS[chain];
      if (c?.kind !== 'evm') throw new Error(`${chain}: not an EVM chain`);
      code = await createRpc(c.rpcs, c.id).call('eth_getCode', [target, 'latest']);
    }
    const codeHash = keccak256(code);
    const { verdict, report } = await uw.scanVerdict({ chain, target, code, codeHash });
    write(`codeHash ${codeHash}\nverdict  ${verdict}\nlevel    ${report.analysis?.rulesLevel ?? report.analysis?.level}`);
    return 0;
  }
  if (group === 'work' && cmd === 'verify-finding') {
    const [specFile, findingArg] = rest;
    if (!specFile || !findingArg) { write(WORK_USAGE); return 2; }
    const r = await uw.verifyFinding({ specText: readFileSync(specFile, 'utf8'), finding: readFinding(findingArg) });
    write(`${r.valid ? 'VALID' : 'NOT VALID'}: ${r.reason}${r.profit != null ? ` (attacker profit ${r.profit} wei)` : ''}`);
    return r.valid ? 0 : 1;
  }
  if (group === 'bounty' && cmd === 'check') {
    const fid = BigInt(rest[0] ?? -1);
    if (fid < 0n || !isAddress(String(opt.bounty ?? '')) || !opt.spec) { write(WORK_USAGE); return 2; }
    const c = opt.attest ? await connect(s, { needJobs: false }) : { provider: await connectRpc(s) };
    const bb = new Contract(opt.bounty, art('BugBounty').abi, c.signer ?? c.provider);
    const f = await bb.getFinding(fid);
    const b = await bb.getBounty(f.bounty);
    const logs = await bb.queryFilter(bb.filters.FindingRevealed(fid));
    if (!logs.length) throw new Error(`finding ${fid}: not revealed (state ${f.state})`);
    const bytes = getBytes(logs[logs.length - 1].args.finding);
    const r = await uw.verifyFinding({ specText: readFileSync(opt.spec, 'utf8'), finding: bytes, expectSpecHash: b.specHash, expectFindingHash: f.findingHash });
    write(`finding ${fid} on bounty ${f.bounty}: ${r.valid ? 'VALID' : 'NOT VALID'} (${r.reason})\n${toUtf8String(bytes)}`);
    if (opt.attest) {
      const tx = await bb.attest(fid, r.valid);
      await tx.wait();
      write(`attested ${r.valid} in ${tx.hash}`);
    }
    return 0;
  }
  write(WORK_USAGE);
  return 2;
}
