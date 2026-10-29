// Writes the fuzz spec of the prototype bounty (the deliberately vulnerable VulnerableVault) to
// zetaphy-hub/bounties/vulnerable-vault.json, from artifacts/VulnerableVault.json, and prints its
// keccak256: the specHash to post on BugBounty (`zetaphy bounty post`). Run after `npm run build`
// when VulnerableVault.sol changes (it also writes bounties/sample-scan.json, the hub's practice scan); test/usefulwork.test.js checks the file is in sync.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { keccak256, toUtf8Bytes } from 'ethers';

export function vulnerableVaultSpec() {
  const art = JSON.parse(readFileSync(new URL('../artifacts/VulnerableVault.json', import.meta.url), 'utf8'));
  return {
    version: 2,
    name: 'VulnerableVault (deliberately vulnerable test contract)',
    note: 'TEST ONLY: zetaphy-network/contracts/VulnerableVault.sol. A victim deposits 5 ZETAPHY. A finding is valid when it breaks one of the invariants: the attacker ends with at least 1 ZETAPHY more, the victim cannot take its 5 back, the vault holds less than it owes, owner() changes, or the vault self-destructs or delegatecalls the attacker.',
    initcode: art.bytecode,
    functions: [
      { sig: 'deposit()', payable: true },
      { sig: 'withdraw(uint256)' },
      { sig: 'initialize()' },
      { sig: 'sweep(address)' },
      { sig: 'owner()' },
      { sig: 'balances(address)' },
    ],
    balances: { deployer: String(10n ** 18n), victim: String(10n * 10n ** 18n), attacker: String(10n ** 18n) },
    setup: [{ from: 'victim', sig: 'deposit()', value: String(5n * 10n ** 18n) }],
    invariants: ['attacker-profit', 'victim-can-exit', 'balance-conservation', 'privileged-unchanged', 'no-selfdestruct', 'no-delegatecall-to-attacker'],
    minProfit: String(10n ** 18n),
    exit: [{ sig: 'withdraw(uint256)', args: [String(5n * 10n ** 18n)] }],
    exitMin: String(5n * 10n ** 18n),
    solvency: 'balances(address)',
    watch: ['owner()'],
    hook: true,
  };
}

export const specText = (spec) => JSON.stringify(spec, null, 1) + '\n';
export const SPEC_FILE = new URL('../../zetaphy-hub/bounties/vulnerable-vault.json', import.meta.url);

/** The hub's practice scan (no chain needed): VulnerableVault's runtime code as a scan job. */
export function sampleScan() {
  const art = JSON.parse(readFileSync(new URL('../artifacts/VulnerableVault.json', import.meta.url), 'utf8'));
  return {
    note: 'Practice scan job: the runtime code of zetaphy-network/contracts/VulnerableVault.sol, scanned as if deployed at target on ZETAPHY.',
    chain: 'zetaphy',
    target: '0x000000000000000000000000000000000000beef',
    code: art.deployedBytecode,
    codeHash: keccak256(art.deployedBytecode),
  };
}
export const SAMPLE_FILE = new URL('../../zetaphy-hub/bounties/sample-scan.json', import.meta.url);

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = specText(vulnerableVaultSpec());
  mkdirSync(new URL('.', SPEC_FILE), { recursive: true });
  writeFileSync(SPEC_FILE, text);
  writeFileSync(SAMPLE_FILE, specText(sampleScan()));
  console.log(`zetaphy-hub/bounties/vulnerable-vault.json  specHash ${keccak256(toUtf8Bytes(text))}`);
}
