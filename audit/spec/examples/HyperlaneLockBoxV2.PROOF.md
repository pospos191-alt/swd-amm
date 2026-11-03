# Proof run: HyperlaneLockBoxV2

Spec hash `0x1542bbf1088ba970120ba87651798d515a93477b641ef7b2cb9b5e555172e35a`, source hash `0x1857f9672e961ca191bd4239aa21309a98491e31757d733494b0073e4af27ed8`, runtime code hash (immutables zeroed) `0x0b5fcba7686e79c2b5c396da9cc5b33f50e64521c6a5de0e02271ab20cbd9b1e`.
Tools: forge 1.2.3-v1.2.3, halmos 0.3.3, solc 0.8.26+commit.8a97fa7a.Linux.g++.

**23 of 23 properties proven**, 0 with a counterexample, 0 unknown or not run.
A "proven" property holds for every input within its stated scope; "not-installed" and "unknown" are never counted as proven.

| Property | Kind | Result | Evidence |
|---|---|---|---|
| `access-handle` | access | **proven** | halmos `check_access_handle`: proven |
| `access-pause` | access | **proven** | halmos `check_access_pause`: proven |
| `access-veto` | access | **proven** | halmos `check_access_veto`: proven |
| `access-lowerDailyLimit` | access | **proven** | halmos `check_access_lowerDailyLimit`: proven |
| `access-raiseReleaseDelay` | access | **proven** | halmos `check_access_raiseReleaseDelay`: proven |
| `access-unpause` | access | **proven** | halmos `check_access_unpause`: proven |
| `access-liftVeto` | access | **proven** | halmos `check_access_liftVeto`: proven |
| `access-setDailyLimit` | access | **proven** | halmos `check_access_setDailyLimit`: proven |
| `access-setReleaseDelay` | access | **proven** | halmos `check_access_setReleaseDelay`: proven |
| `access-setInterchainSecurityModule` | access | **proven** | halmos `check_access_setInterchainSecurityModule`: proven |
| `access-setGuardian` | access | **proven** | halmos `check_access_setGuardian`: proven |
| `access-setGovernance` | access | **proven** | halmos `check_access_setGovernance`: proven |
| `monotonic-nonce` | monotonic | **proven** | halmos `check_monotonic_nonce__lock`: proven |
| `monotonic-received` | monotonic | **proven** | halmos `check_monotonic_received__handle`: proven |
| `backing-locked` | invariant | **proven** | halmos `check_backing_locked`: proven<br>forge: fuzz-passed<br>smtchecker: timeout |
| `pause-noloss` | pause-noloss | **proven** | halmos `check_pause_noloss`: proven |
| `paused-blocks-lock` | paused-blocks | **proven** | halmos `check_paused_blocks_lock`: proven |
| `paused-blocks-claim` | paused-blocks | **proven** | halmos `check_paused_blocks_claim`: proven |
| `cei-lock` | cei | **proven** | spec-ast: proven |
| `cei-claim` | cei | **proven** | spec-ast: proven |
| `locked-never-below-releases` | invariant | **proven** | halmos `check_locked_never_below_releases`: proven<br>forge: fuzz-passed |
| `daily-limit` | post | **proven** | halmos `check_daily_limit__claim`: proven |
| `claim-pays-from-locked` | post | **proven** | halmos `check_claim_pays_from_locked__claim`: proven |

Artifacts hash `0x4277bc50568230f0cc507f31c7f00f7d4558b7e240cfd1a2064e7c78e662d359`, result hash `0xfb3b859c11dc061a6466efff0632a69f9d3bdd737ea3809d396dc4624e1fb91d`, recipe hash `0xb8cd67093c69b9de44922aa07be946320a4b87e8cae1d8495a251e7ba93ce292`.

Reproduce: `bash audit/tools/install.sh <dir> fast  # forge 1.2.3, halmos 0.3.3 (pip, hashed), solc 0.8.26 (sha256-checked)` then `node audit/spec/cli.js prove audit/spec/examples/HyperlaneLockBoxV2.spec.json`.
