# Proof run: BuggyVault

Spec hash `0x54dfb5789ef15da9c42229acc413862e73c278e14dee789579f19aee00bd2f85`, source hash `0x7448f88190a4409f2e65f3e9126f3a54670fa6095509bb93d0fb44e0fa97d7ee`, runtime code hash (immutables zeroed) `0xb3c2ef424739db0de4c04bdc50ba53e1810f471403c5039971ee2f94eece6a17`.
Tools: forge 1.2.3-v1.2.3, halmos 0.3.3, solc 0.8.26+commit.8a97fa7a.Linux.g++.

**7 of 10 properties proven**, 3 with a counterexample, 0 unknown or not run.
A "proven" property holds for every input within its stated scope; "not-installed" and "unknown" are never counted as proven.

| Property | Kind | Result | Evidence |
|---|---|---|---|
| `access-pause` | access | **proven** | halmos `check_access_pause`: proven |
| `access-unpause` | access | **proven** | halmos `check_access_unpause`: proven |
| `access-setGovernance` | access | **proven** | halmos `check_access_setGovernance`: proven |
| `monotonic-deposits` | monotonic | **proven** | halmos `check_monotonic_deposits__deposit`: proven |
| `conservation-balanceOf-totalDeposits` | conservation | **counterexample** | halmos `check_conservation_balanceOf_totalDeposits__deposit`: proven<br>halmos `check_conservation_balanceOf_totalDeposits__withdraw`: proven<br>halmos `check_conservation_balanceOf_totalDeposits__emergencyWithdraw`: counterexample (replayed in forge) |
| `backing-totalDeposits` | invariant | **counterexample** | halmos `check_backing_totalDeposits`: counterexample (replayed in forge)<br>forge: counterexample (replayed in forge)<br>smtchecker: counterexample |
| `pause-noloss` | pause-noloss | **proven** | halmos `check_pause_noloss`: proven |
| `paused-blocks-deposit` | paused-blocks | **proven** | halmos `check_paused_blocks_deposit`: proven |
| `cei-withdraw` | cei | **counterexample** | spec-ast: counterexample |
| `cei-emergencyWithdraw` | cei | **proven** | spec-ast: proven |

## Counterexample: `conservation-balanceOf-totalDeposits`

totalDeposits moves exactly with the balanceOf it sums

- halmos `check_conservation_balanceOf_totalDeposits__emergencyWithdraw` (replayed concretely in forge: the same assert fails): from the setup state,
  1. deposit(value 39614081257132168796771975168) by address(0xA11CE)
  2. emergencyWithdraw() by 0x00000000000000000000000000000000000a11ce

## Counterexample: `backing-totalDeposits`

the contract always holds at least totalDeposits in ETH

- halmos `check_backing_totalDeposits` (replayed concretely in forge: the same assert fails): from the setup state,
  1. deposit(value 39614081257132168796771975168) by address(0xA11CE)
  2. emergencyWithdraw() by address(0xA11CE)
- forge: panic: assertion failed (0x01)
- smtchecker: CHC: Assertion violation happens here.

## Counterexample: `cei-withdraw`

withdraw: no storage write after an external call

- spec-ast: storage written after an external call: balanceOf line 39, totalDeposits line 40

Artifacts hash `0x722129e6a1af824807b49895d8e0a324361f8ccbe86e28d37488a2380505806e`, result hash `0xa3a72606d5eea60da7fe7cc8d978602a98d00c318c9d26ab71b89bf0bb116699`, recipe hash `0xa214988621ccaa233c24a16c25e92b6ab5e795d5429245337630a3a92aa2d093`.

Reproduce: `bash audit/tools/install.sh <dir> fast  # forge 1.2.3, halmos 0.3.3 (pip, hashed), solc 0.8.26 (sha256-checked)` then `node audit/spec/cli.js prove audit/spec/examples/BuggyVault.spec.json`.
