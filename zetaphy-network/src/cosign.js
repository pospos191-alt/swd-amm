// AI co-signer, the runner side. An agent's AgentPolicyWallet needs, for an action above its
// threshold, either the timelock or k-of-n signatures of the CosignCommittee (runner keys chosen
// by governance). A runner signs only after running Neuro's fixed rules (zetaphy-neuro/src, the
// same code and skill id as NeuroJobs) on what the action touches:
//   - the contract called (`to`), and for an ERC-20 transfer/approve, the recipient/spender if it
//     is a contract;
//   - refuses when any report is "high" (or "medium" with strict), when a contract has no code
//     where code is expected, or when the read fails.
// The signature covers reportHash = keccak256(abi.encode(verdict ids)), so anyone can re-run the
// same reads and see what the runner vouched for. No server: the agent asks runners directly
// (`zetaphy cosign review …` on each runner) and combines the answers (`zetaphy cosign combine`).
import { AbiCoder, keccak256, getAddress, Interface, SigningKey, recoverAddress, ZeroHash } from 'ethers';
import { readContract } from '../../zetaphy-neuro/src/reader.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';

const abi = AbiCoder.defaultAbiCoder();
const TOKEN = new Interface(['function transfer(address to, uint256 amount)', 'function approve(address spender, uint256 amount)']);

/** The digest AgentPolicyWallet.cosignDigest() computes (no EIP-191 prefix; bound to chain, wallet and nonce). */
export function cosignDigest({ chainId, wallet, nonce, to, value, data, reportHash, deadline }) {
  return keccak256(abi.encode(['string', 'uint256', 'address', 'uint256', 'address', 'uint256', 'bytes32', 'bytes32', 'uint256'],
    ['ZETAPHY AgentCosign', BigInt(chainId), getAddress(wallet), BigInt(nonce), getAddress(to), BigInt(value), keccak256(data), reportHash, BigInt(deadline)]));
}

/** The addresses an action touches that Neuro should read: the callee, and a token transfer's/approval's counterparty. */
export function touched(to, data) {
  const out = [{ role: 'target', address: getAddress(to) }];
  const sel = String(data ?? '0x').slice(0, 10).toLowerCase();
  if (sel === TOKEN.getFunction('transfer').selector || sel === TOKEN.getFunction('approve').selector) {
    try {
      const [who] = TOKEN.decodeFunctionData(sel === TOKEN.getFunction('transfer').selector ? 'transfer' : 'approve', data);
      out.push({ role: sel === TOKEN.getFunction('transfer').selector ? 'recipient' : 'spender', address: getAddress(who) });
    } catch { /* malformed: the target read below still decides */ }
  }
  return out;
}

/**
 * Runs Neuro on what the action touches and decides.
 * @param {{to:string, value?:bigint, data?:string, strict?:boolean, read?:Function, chainConfig?:object, hasCode?:(a:string)=>Promise<boolean>}} p
 * @returns {Promise<{ok:boolean, reasons:string[], reportHash:string, reports:Array}>}
 */
export async function review({ to, data = '0x', strict = false, read = readContract, chainConfig, hasCode }) {
  const reasons = [];
  const reports = [];
  const verdicts = [];
  for (const t of touched(to, data)) {
    const code = hasCode ? await hasCode(t.address) : true;
    if (!code) {
      // a plain account: nothing for Neuro to read. The callee itself must be a contract when there is calldata.
      if (t.role === 'target' && data !== '0x') reasons.push(`${t.role} ${t.address} has no code`);
      verdicts.push(ZeroHash);
      continue;
    }
    let report;
    try { report = await read('zetaphy', t.address, { chainConfig, sourcify: false }); } catch (e) {
      reasons.push(`${t.role} ${t.address}: Neuro could not read it (${String(e.message ?? e).slice(0, 120)})`);
      verdicts.push(ZeroHash);
      continue;
    }
    const level = report?.analysis?.rulesLevel ?? report?.analysis?.level ?? 'unknown';
    reports.push({ role: t.role, address: t.address, level });
    verdicts.push(await verdictOf(report));
    if (level === 'high' || (strict && level === 'medium')) reasons.push(`${t.role} ${t.address}: Neuro level ${level}`);
  }
  return { ok: reasons.length === 0, reasons, reportHash: keccak256(abi.encode(['bytes32[]'], [verdicts])), reports };
}

/** Signs a co-sign digest with a runner key (raw digest, as CosignCommittee.isValid checks). */
export function signCosign(privateKey, digest) {
  const key = new SigningKey(privateKey);
  return { signer: recoverAddress(digest, key.sign(digest)), sig: key.sign(digest).serialized };
}

/** Signatures in the order CosignCommittee.isValid wants (signers ascending, no repeats), after checking each one. */
export function combine(digest, parts) {
  const seen = new Map();
  for (const p of parts) {
    const who = recoverAddress(digest, p.sig);
    if (p.signer && getAddress(p.signer) !== who) throw new Error(`a signature claims ${p.signer} but was made by ${who}`);
    seen.set(who.toLowerCase(), p.sig);
  }
  return [...seen.entries()].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1)).map(([, s]) => s);
}
