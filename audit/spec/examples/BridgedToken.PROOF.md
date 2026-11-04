# Proof run: BridgedToken

Spec hash `0x16fa6f25ebef38fc4ba0026d70928fd3a8362e2019511182c766469ab3b93edb`, source hash `0xdfcdf6edd9ab2bf501327a82e8ecf54eebe85c1e397ed5130f1c6a66e727970b`, runtime code hash (immutables zeroed) `0x2371f0f3e235526c5cd82cf4f5b86890dd7eec0c629f79883b7b525a9c8b4cd9`.
Tools: forge 1.2.3-v1.2.3, halmos 0.3.3, solc 0.8.26+commit.8a97fa7a.Linux.g++.

**3 of 3 properties proven**, 0 with a counterexample, 0 unknown or not run.
A "proven" property holds for every input within its stated scope; "not-installed" and "unknown" are never counted as proven.

| Property | Kind | Result | Evidence |
|---|---|---|---|
| `access-mint` | access | **proven** | halmos `check_access_mint`: proven |
| `access-burn` | access | **proven** | halmos `check_access_burn`: proven |
| `conservation-balanceOf-totalSupply` | conservation | **proven** | halmos `check_conservation_balanceOf_totalSupply__mint`: proven<br>halmos `check_conservation_balanceOf_totalSupply__burn`: proven<br>halmos `check_conservation_balanceOf_totalSupply__transfer`: proven<br>halmos `check_conservation_balanceOf_totalSupply__transferFrom`: proven |

Artifacts hash `0xf04a9f00a1c6abddec53581f16dfd087552c7fad85d20f204bd32a15a45cecaf`, result hash `0x768443c987ad6f8425cd7fa1ea364ee055306b995ab0e25cc7497d36aee87304`, recipe hash `0x9bf0d0f4d56aa4aa3e58432439b00b7e361830fa76ccfd191217f74cdf5d36e5`.

Reproduce: `bash audit/tools/install.sh <dir> fast  # forge 1.2.3, halmos 0.3.3 (pip, hashed), solc 0.8.26 (sha256-checked)` then `node audit/spec/cli.js prove audit/spec/examples/BridgedToken.spec.json`.
