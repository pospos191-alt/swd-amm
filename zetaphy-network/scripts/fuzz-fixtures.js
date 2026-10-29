// Compiles the fuzz fixtures (test/fixtures/fuzz/*.sol: deliberately vulnerable and safe test contracts,
// plus FuzzHook, the fuzzer's attacker contract) with solc 0.8.26 and writes:
//   test/fixtures/fuzz/<Contract>.json   a fuzz spec (version 2) per fixture
//   ../zetaphy-hub/fuzz-hook.js          FuzzHook's init code for the browser fuzzer (fuzz-core.js)
// Run after changing a fixture: `node scripts/fuzz-fixtures.js`. test/fuzz.test.js checks the files are in sync.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import solc from 'solc';

const DIR = new URL('../test/fixtures/fuzz/', import.meta.url);
export const HOOK_FILE = new URL('../../zetaphy-hub/fuzz-hook.js', import.meta.url);
const E = (n) => String(BigInt(n) * 10n ** 18n);
const ACTORS3 = { deployer: E(10), victim: E(10), attacker: E(2) };
const ETH_INV = ['attacker-profit', 'victim-can-exit', 'balance-conservation', 'privileged-unchanged', 'no-selfdestruct', 'no-delegatecall-to-attacker', 'token-drain'];

/** What each fixture is, how it is set up, and what the fuzzer must find (expect) or not find (safe). */
export const FIXTURES = {
  ReentrantBank: {
    note: 'TEST ONLY. Reentrancy: withdraw() pays before it zeroes the balance.',
    functions: [{ sig: 'deposit()', payable: true }, { sig: 'withdraw()' }, { sig: 'balances(address)' }],
    setup: [{ from: 'victim', sig: 'deposit()', value: E(5) }],
    exit: [{ sig: 'withdraw()', args: [] }], exitMin: E(5), solvency: 'balances(address)',
    expect: ['attacker-profit', 'victim-can-exit', 'balance-conservation', 'reentrancy'],
  },
  OpenDelegate: {
    note: 'TEST ONLY. Delegatecall to anyone: execute(address,bytes) has no access control.',
    functions: [{ sig: 'deposit()', payable: true }, { sig: 'execute(address,bytes)' }, { sig: 'owner()' }],
    setup: [{ from: 'victim', sig: 'deposit()', value: E(5) }],
    watch: ['owner()'],
    expect: ['no-delegatecall-to-attacker'],
  },
  KillSwitch: {
    note: 'TEST ONLY. Selfdestruct by anyone: the time lock was never set.',
    functions: [{ sig: 'deposit()', payable: true }, { sig: 'withdraw(uint256)' }, { sig: 'shutdown(address)' }, { sig: 'owner()' }],
    setup: [{ from: 'victim', sig: 'deposit()', value: E(5) }],
    exit: [{ sig: 'withdraw(uint256)', args: [E(5)] }], exitMin: E(5), solvency: 'balances(address)', watch: ['owner()'],
    expect: ['no-selfdestruct', 'attacker-profit', 'victim-can-exit', 'balance-conservation'],
  },
  LeakyToken: {
    note: 'TEST ONLY. Token drain: transferFrom never checks the allowance.',
    functions: [{ sig: 'transfer(address,uint256)' }, { sig: 'approve(address,uint256)' }, { sig: 'transferFrom(address,address,uint256)' }, { sig: 'balanceOf(address)' }],
    setup: [{ from: 'deployer', sig: 'transfer(address,uint256)', args: ['victim', E(1000)] }],
    tokens: ['target'], minTokenProfit: '1',
    expect: ['token-drain'],
  },
  OwnerTakeover: {
    note: 'TEST ONLY. Owner takeover: transferOwnership(address) forgot its modifier.',
    functions: [{ sig: 'deposit()', payable: true }, { sig: 'transferOwnership(address)' }, { sig: 'setFee(uint256)' }, { sig: 'owner()' }],
    setup: [{ from: 'victim', sig: 'deposit()', value: E(1) }],
    watch: ['owner()'],
    expect: ['privileged-unchanged'],
  },
  SafeBank: {
    note: 'TEST ONLY. The fixed ReentrantBank: checks-effects-interactions and a lock.',
    functions: [{ sig: 'deposit()', payable: true }, { sig: 'withdraw()' }, { sig: 'balances(address)' }],
    setup: [{ from: 'victim', sig: 'deposit()', value: E(5) }],
    exit: [{ sig: 'withdraw()', args: [] }], exitMin: E(5), solvency: 'balances(address)',
    expect: [],
  },
  SafeVault: {
    note: 'TEST ONLY. Owner-only delegatecall, selfdestruct and ownership; withdrawals of one\'s own balance.',
    functions: [{ sig: 'deposit()', payable: true }, { sig: 'withdraw(uint256)' }, { sig: 'execute(address,bytes)' }, { sig: 'shutdown(address)' }, { sig: 'transferOwnership(address)' }, { sig: 'owner()' }, { sig: 'balances(address)' }],
    setup: [{ from: 'victim', sig: 'deposit()', value: E(5) }],
    exit: [{ sig: 'withdraw(uint256)', args: [E(5)] }], exitMin: E(5), solvency: 'balances(address)', watch: ['owner()'],
    expect: [],
  },
  SafeToken: {
    note: 'TEST ONLY. A correct ERC-20 core: transferFrom spends the allowance.',
    functions: [{ sig: 'transfer(address,uint256)' }, { sig: 'approve(address,uint256)' }, { sig: 'transferFrom(address,address,uint256)' }, { sig: 'balanceOf(address)' }],
    setup: [{ from: 'deployer', sig: 'transfer(address,uint256)', args: ['victim', E(1000)] }],
    tokens: ['target'], minTokenProfit: '1',
    expect: [],
  },
};

export function compileFixtures() {
  const sources = Object.fromEntries(readdirSync(DIR).filter((f) => f.endsWith('.sol')).sort().map((f) => [f, { content: readFileSync(new URL(f, DIR), 'utf8') }]));
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  return Object.fromEntries(Object.values(out.contracts).flatMap((byName) => Object.entries(byName)).map(([n, c]) => [n, '0x' + c.evm.bytecode.object]));
}

export function fixtureSpecs(bins = compileFixtures()) {
  return Object.fromEntries(Object.entries(FIXTURES).map(([name, f]) => {
    const { expect, ...rest } = f;
    const spec = {
      version: 2, name: `${name} (fuzz fixture)`, ...rest, initcode: bins[name], balances: ACTORS3,
      invariants: ETH_INV, minProfit: E(1), hook: true,
    };
    return [name, { spec, expect }];
  }));
}

export const specText = (spec) => JSON.stringify(spec, null, 1) + '\n';
export const hookModule = (bins = compileFixtures()) => `// Generated by zetaphy-network/scripts/fuzz-fixtures.js from test/fixtures/fuzz/FuzzHook.sol (solc 0.8.26,
// optimizer 200 runs). The bug hunter's own contract: the fuzzer deploys it from the attacker inside the
// in-memory EVM to call through a contract and to re-enter the target (reentrancy). Do not edit by hand.
export const HOOK_INITCODE = '${bins.FuzzHook}';
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const bins = compileFixtures();
  for (const [name, { spec, expect }] of Object.entries(fixtureSpecs(bins))) {
    writeFileSync(new URL(`${name}.json`, DIR), specText({ ...spec, expect }));
  }
  writeFileSync(HOOK_FILE, hookModule(bins));
  console.log(`${Object.keys(FIXTURES).length} fuzz specs in test/fixtures/fuzz/, FuzzHook -> zetaphy-hub/fuzz-hook.js`);
}
