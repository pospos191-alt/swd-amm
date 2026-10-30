// zetaphy qsafe: the quantum-safe settlement layer's offline commands (docs/future/quantum-safe-settlement.md).
//   zetaphy qsafe inventory [--json]          the quantum-exposure inventory: readiness score, open rows by impact
//   zetaphy qsafe rescue-kit <account 0x…> --contract <QuantumRescue 0x…> [--chain-id 77390]
//                                             a new ML-DSA-44 rescue key + secret for <account> and the commit(c) calldata
//                                             to send FROM <account> before Q-day; prints the kit JSON (keep it offline)
//   zetaphy qsafe rescue-reveal <kit.json>    after Q-day: the reveal(...) calldata, signed with the kit's ML-DSA key;
//                                             anyone may send it (to = the QuantumRescue contract)
// Nothing here touches the network: the output is calldata for any wallet or `zetaphy pq native call`.
import { readFileSync } from 'node:fs';
import { Interface, getAddress, hexlify, randomBytes, keccak256 } from 'ethers';
import { pqFromSeed } from '../pq.js';
import { summary, IMPACT } from './inventory.js';
import { commitmentOf, controllerOf, revealArgs, newSecret } from './rescue.js';

const RESCUE = new Interface([
  'function commit(bytes32 c)',
  'function reveal(address account, bytes pk, bytes32 secret, bytes sig)',
]);
const DEFAULT_CHAIN_ID = 77390;

export function qsafeCommand({ cmd, rest = [], opt = {}, write, env = {}, readFile = (p) => readFileSync(p, 'utf8') }) {
  if (cmd === 'inventory') {
    const s = summary();
    if (opt.json) { write(JSON.stringify(s, null, 2)); return 0; }
    write(`Q-day readiness: ${s.score}/100 over ${s.total} components (post-quantum ${s.byStatus.pq}, hybrid ${s.byStatus.hybrid}, partial ${s.byStatus.partial}, classical ${s.byStatus.classical})`);
    write('open, by impact:');
    for (const o of s.open) write(`  [${o.impact.padEnd(8)}] ${o.status.padEnd(9)} ${o.id}: ${o.migration}`);
    write(`impact weights: ${Object.entries(IMPACT).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    return 0;
  }
  if (cmd === 'rescue-kit') {
    const [account] = rest;
    if (!account || !opt.contract) throw new Error('usage: zetaphy qsafe rescue-kit <account 0x…> --contract <QuantumRescue 0x…> [--chain-id N]');
    const chainId = Number(opt['chain-id'] ?? env.ZETAPHY_EVM_CHAIN_ID ?? DEFAULT_CHAIN_ID);
    const seed = hexlify(randomBytes(32));
    const key = pqFromSeed(seed);
    const secret = newSecret();
    const contract = getAddress(opt.contract);
    const acct = getAddress(account);
    const c = commitmentOf({ chainId, contract, account: acct, publicKey: key.publicKey, secret });
    const kit = { kind: 'zetaphy-quantum-rescue-v1', chainId, contract, account: acct, keyHash: key.keyHash, controller: controllerOf(key.publicKey), secret, mldsa44Seed: seed };
    write(JSON.stringify({ kit, commit: { from: acct, to: contract, data: RESCUE.encodeFunctionData('commit', [c]), commitment: c } }, null, 2));
    return 0;
  }
  if (cmd === 'rescue-reveal') {
    const [file] = rest;
    if (!file) throw new Error('usage: zetaphy qsafe rescue-reveal <kit.json>');
    const kit = JSON.parse(readFile(file));
    if (kit?.kind !== 'zetaphy-quantum-rescue-v1') throw new Error('not a quantum rescue kit');
    const seed = kit.mldsa44Seed ?? env.ZETAPHY_RESCUE_SEED;
    if (!/^0x[0-9a-fA-F]{64}$/.test(seed ?? '')) throw new Error('the kit has no ML-DSA-44 seed: set ZETAPHY_RESCUE_SEED (0x + 64 hex) to the seed of the committed key');
    const key = pqFromSeed(seed);
    if (keccak256(key.publicKey).toLowerCase() !== String(kit.keyHash).toLowerCase()) throw new Error('this seed is not the key the kit committed to');
    const { args, controller } = revealArgs({ chainId: kit.chainId, contract: kit.contract, account: kit.account, key, secret: kit.secret });
    write(JSON.stringify({ to: getAddress(kit.contract), data: RESCUE.encodeFunctionData('reveal', args), controller }, null, 2));
    return 0;
  }
  throw new Error('usage: zetaphy qsafe [inventory [--json] | rescue-kit <account> --contract <0x…> | rescue-reveal <kit.json>]');
}
