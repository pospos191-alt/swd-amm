# Proof run: BridgeGuard

Spec hash `0x3b2304ae07b3b33e437b22ef02e0ed645e24e4c20d655ec6a5cd032e3db0509f`, source hash `0xdfcdf6edd9ab2bf501327a82e8ecf54eebe85c1e397ed5130f1c6a66e727970b`, runtime code hash (immutables zeroed) `0xdb8082cae8047f89f43571418d3016833e4e384311903bcc2a35e14c11084525`.
Tools: forge 1.2.3-v1.2.3, halmos 0.3.3, solc 0.8.26+commit.8a97fa7a.Linux.g++.

**26 of 26 properties proven**, 0 with a counterexample, 0 unknown or not run.
A "proven" property holds for every input within its stated scope; "not-installed" and "unknown" are never counted as proven.

| Property | Kind | Result | Evidence |
|---|---|---|---|
| `access-createToken` | access | **proven** | halmos `check_access_createToken`: proven |
| `access-setGovernance` | access | **proven** | halmos `check_access_setGovernance`: proven |
| `access-setGuardian` | access | **proven** | halmos `check_access_setGuardian`: proven |
| `access-setAudit` | access | **proven** | halmos `check_access_setAudit`: proven |
| `access-proposeMaxDailyLimit` | access | **proven** | halmos `check_access_proposeMaxDailyLimit`: proven |
| `access-cancelMaxDailyLimit` | access | **proven** | halmos `check_access_cancelMaxDailyLimit`: proven |
| `access-lowerMaxDailyLimit` | access | **proven** | halmos `check_access_lowerMaxDailyLimit`: proven |
| `access-disableRoute` | access | **proven** | halmos `check_access_disableRoute`: proven |
| `access-setThreats` | access | **proven** | halmos `check_access_setThreats`: proven |
| `access-setRoute` | access | **proven** | halmos `check_access_setRoute`: proven |
| `access-setOutboundRoute` | access | **proven** | halmos `check_access_setOutboundRoute`: proven |
| `access-pause` | access | **proven** | halmos `check_access_pause`: proven |
| `access-unpause` | access | **proven** | halmos `check_access_unpause`: proven |
| `access-dropHeld` | access | **proven** | halmos `check_access_dropHeld`: proven |
| `pause-noloss` | pause-noloss | **proven** | halmos `check_pause_noloss`: proven |
| `paused-blocks-inbound` | paused-blocks | **proven** | halmos `check_paused_blocks_inbound`: proven |
| `paused-blocks-releaseHeld` | paused-blocks | **proven** | halmos `check_paused_blocks_releaseHeld`: proven |
| `paused-blocks-outbound` | paused-blocks | **proven** | halmos `check_paused_blocks_outbound`: proven |
| `cei-inbound` | cei | **proven** | spec-ast: proven |
| `cei-releaseHeld` | cei | **proven** | spec-ast: proven |
| `cei-outbound` | cei | **proven** | spec-ast: proven |
| `cap-in` | post | **proven** | halmos `check_cap_in__inbound`: proven<br>halmos `check_cap_in__releaseHeld`: proven |
| `cap-out` | post | **proven** | halmos `check_cap_out__outbound`: proven |
| `route-limit-in` | post | **proven** | halmos `check_route_limit_in__inbound`: proven |
| `route-limit-out` | post | **proven** | halmos `check_route_limit_out__outbound`: proven |
| `mint-is-bounded` | post | **proven** | halmos `check_mint_is_bounded__inbound`: proven |

Artifacts hash `0x8421be4a56b867095ac6daae61cb59e2132b2735f6e26da4489bad3debf20b2f`, result hash `0x7ebc40997642e57824ed34fda89d10bc08cbd7573452a3e9af63b780214cd753`, recipe hash `0x8479d508e0163c5bfa8bbe4537664fa77dd4abae4866ace16dabd55d121206b8`.

Reproduce: `bash audit/tools/install.sh <dir> fast  # forge 1.2.3, halmos 0.3.3 (pip, hashed), solc 0.8.26 (sha256-checked)` then `node audit/spec/cli.js prove audit/spec/examples/BridgeGuard.spec.json`.
