**English** | [ภาษาไทย](README.th.md)

# zetaphy-verify: automatic verification of ZETAPHY contracts on every chain

Every 6 hours, GitHub Actions does the following on its own:

1. Reads the latest `TokenDeployed` events from the ZETAPHY factory on every configured chain
2. Sends the source code of the factory and of every new token to the explorers for verification
3. Skips contracts that are already verified, so it can be re-run safely

The system sends source only when the on-chain code matches a contract in `build-info/`.
It compares them with the same code fingerprint that Neuro uses, so it cannot send the wrong source.

## Entirely free

| Where | How | Cost |
|---|---|---|
| Sourcify (every chain) | Automatic, no setup | Free |
| Etherscan, Arbiscan | Automatic, once you add a free etherscan.io API key | Free |
| BscScan, BaseScan | Fill in the web form yourself once (see the section below) | Free |
| GitHub Actions | Runs every 6 hours, uses about 120 of the 2,000 free minutes per month | Free |

The free Etherscan API does not support BNB Chain and Base, so the system shows the status `plan-required`
for these two chains. This does not count as a failed run. You don't need to buy a plan, because the BscScan web form is free.

## BscScan / BaseScan for free (web form)

1. Create the file for the form:
   `node zetaphy-verify/cli.js export ZETAPHYModularToken`
   - This command writes the file `zetaphy-verify/out/ZETAPHYModularToken.standard-input.json`
   - and prints the values you need to choose in the form
2. Open the contract page on BscScan → Contract tab → **Verify and Publish**
3. Choose the values the command printed, then upload the `.json` file
4. Do the same for the factory
5. Other tokens with the same code usually show "Similar Match" on their own. If a token still does not, repeat for that token

## First-time setup

1. Copy the launcher project's build-info files into `zetaphy-verify/build-info/`
   - Hardhat: `artifacts/build-info/*.json` (Hardhat 3 also needs the matching `*.output.json` files next to them)
   - Foundry: `out/build-info/*.json`
2. (Optional) Sign up for a free API key at etherscan.io, then add it as `ETHERSCAN_API_KEY` under GitHub → Settings → Environments → `explorer-verify` → Environment secrets (docs/SECRETS-HARDENING.md)
   - Never paste the key into code or into chat
3. If the launcher is also on other chains, add the factory address in `src/config.js` under that chain
   - The system already tries the same factory address on every chain, but uses it only when the code matches build-info

When you push files in `build-info/` to `main`, the system runs immediately.

## Verify old tokens retroactively, or verify one address at a time

Go to Actions → **ZETAPHY verify** → Run workflow:

- **Retroactively:** set `from_block` to the block where the factory was created
- **One address at a time:** choose the chain, then enter `address`

## Run it yourself locally (not required)

```
node zetaphy-verify/cli.js watch [--chain bsc] [--from-block N] [--to-block N]
node zetaphy-verify/cli.js verify bsc 0x... [--tx 0x...]
node zetaphy-verify/cli.js export ZETAPHYModularToken
```

## Tests

```
cd zetaphy-verify && npm ci && npm test
```

The test suite compiles a sample launcher (factory + token) with solc,
then simulates the chain, Sourcify, and Etherscan to check that the system sends the right source
and passes the constructor arguments correctly.
