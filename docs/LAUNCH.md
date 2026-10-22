**English** | [ภาษาไทย](LAUNCH.th.md)

# ZETAPHY testnet launch day: the owner's checklist

Work from top to bottom, from zero to a testnet that actually works.
- **Every step is done in a web page** (Oracle, GitHub, Vercel, MetaMask, your DNS provider); you do not need to run anything on your computer
- **Everything is free** (Oracle Always Free, GitHub Actions, Vercel Hobby, public npm, free Reown)
- **testnet only**: the coins have no value, and the contracts have not passed an audit yet (step 14)
- **Never send a private key, seed or any password in a chat**, including in a chat with Claude: Claude does not ask for them and does not need them

Symbol: 🤖 = Claude can carry this on for you once you grant the access mentioned, or once the chain is up

| Step | What to do | Who does it |
|---|---|---|
| 1 | Create the Oracle machine + paste `cloud-init.sh` + open ports | You |
| 2 | Wait, then check that the chain is running | You (🤖 can check the RPC once it knows the host name) |
| 3 | Create a new deployer wallet and send it ZETAPHY | You |
| 4 | Put the key in the GitHub secret `ZETAPHY_DEPLOYER_KEY` | You |
| 5 | Run the **launch-testnet** workflow, then merge the PR | You or 🤖 (if given GitHub Actions access) |
| 6 | Vercel projects: wallet, explorer, DEX, NFT | You or 🤖 (if given access to the team's Vercel) |
| 7 | DNS: CNAME `explorer`, `swap`, `nft`, `wallet` | You (🤖 if the DNS is on Vercel) |
| 8 | Hand admin rights over to the governance vote (gov) | You (🤖 can run the workflow; voting must be done on the machine) |
| 9 | MetaMask Snap: npm + allowlist | You + 🤖 |
| 10 | WalletConnect projectId | You sign up, 🤖 fills in the value |
| 11 | Contact email in `docs/LEGAL.md` and `legal.html` | You provide the email, 🤖 edits the files |
| 12 | Consult a lawyer | You |
| 13 | PRs for the chainlist / Keplr listings | 🤖 prepares the files, you open the PRs from your account |
| 14 | audit before there is real money | You |
| 15 | IBC + USDC from the Noble testnet (relayer on the node machine) | You (🤖 can check the results) |
| 16 | Bridge: keep it closed; open it once every gate passes + the monitor | You (🤖 can check the gates) |

---

## 1. Create the Oracle machine and paste `cloud-init.sh`

> You can use **Google Cloud e2-micro** instead: follow the section "Google Cloud e2-micro (free forever)" in [`zetaphy-chain/README.md`](../zetaphy-chain/README.md) (paste the whole of `setup-node.sh`, open port 26656, set a $1 Budget alert), then skip to step 2

Follow [`zetaphy-chain/README.md`](../zetaphy-chain/README.md), section "Set up the machine on Oracle Cloud". In short:
1. **cloud.oracle.com** → sign up for the Free Tier → Home Region **Singapore**
2. Menu ☰ → **Compute → Instances → Create instance**
   - Name `zetaphy-node-0`, Image **Canonical Ubuntu 24.04**, Shape **Ampere VM.Standard.A1.Flex** (2 OCPU / 12 GB)
   - Networking: the defaults, with a **public IPv4**
   - SSH keys: **Generate a key pair for me** → **Save private key** (keep it; it is used in step 8)
   - **Show advanced options → Management → Paste cloud-init script**: open [`zetaphy-chain/cloud-init.sh`](../zetaphy-chain/cloud-init.sh) on GitHub → **Raw** → copy everything → paste
   - **Recommended:** change the line `OWNER_EVM_ADDRESS=""` to your **main** MetaMask address (a 0x… address only; never put a key there) to receive 1,000,000 test ZETAPHY, used to fund the deployer in step 3
3. **Create**, then wait (A1 takes about 15–25 minutes)
4. **Open the ports:** machine page → **Primary VNIC → Subnet** → **Security Lists** → *Default Security List* → **Add Ingress Rules**
   (Source CIDR `0.0.0.0/0`, IP Protocol **TCP**) one port at a time: **80**, **443**, **8545**, **26656**
   - 80/443: free https from Let's Encrypt at `https://<IP with dots changed to dashes>.sslip.io` (every web app needs https)
   - 8545: MetaMask over http, 26656: other machines connecting to the chain

## 2. Wait, then check that the chain is running

1. On the machine page in Oracle: note the **Public IP address**, e.g. `1.2.3.4` → the host name is `1-2-3-4.sslip.io`
2. Open in a browser (a phone works too): `https://1-2-3-4.sslip.io/zetaphy/evm-chain.json`
   - If JSON appears with `"chainId": "0x12e4e"` and `"rpcUrls": ["https://1-2-3-4.sslip.io"]` = the chain and https are ready
   - The same value as in `NODE-INFO.txt` on the machine (the **HTTPS RPC (wallet)** line); you can view that file from the machine page → **Resources → Console connection** or Cloud Shell (step 8)
   - If nothing appears yet: keep waiting, or look at the logs as in `zetaphy-chain/README.md` step 4
3. Add the network in MetaMask: RPC `https://1-2-3-4.sslip.io`, Chain ID `77390`, symbol `ZTPHY`
   If you set `OWNER_EVM_ADDRESS`, you will see 1,000,000 ZTPHY

**The URL used in every step from here on** = `https://1-2-3-4.sslip.io` (replace with the real one), called the **RPC**

🤖 Tell Claude the host name and Claude can check `eth_chainId`, the block height and https for you

## 3. Create a new deployer wallet, then send it ZETAPHY

The deployer is the account the workflow uses to deploy the contracts. Use a **new, separate account**, not your main account

**Create it (the simplest and safest free way: MetaMask):**
1. MetaMask → tap the account name at the top → **Add account or hardware wallet → Add a new account** → name it `ZETAPHY deployer`
2. Copy this account's **address** (0x…) (an address can be made public; you can send it to Claude)

**Send it funds:** in MetaMask switch to your main account (the one that received 1,000,000 ZTPHY) on the ZETAPHY Testnet network → **Send** → paste the deployer address → **1,000 ZTPHY** → Confirm
- About 300 ZETAPHY are actually used: 100 as the StableGateway reserve, 200 as starting liquidity for the 2 test pools in the DEX. All gas fees together come to less than 1 ZETAPHY
  (step 5 does a dry run first and reports the amount needed and the amount actually held)
- The chain's faucet (`zetaphy_faucet`) gives only 10 ZETAPHY per day, which is not enough to deploy

**If you did not set `OWNER_EVM_ADDRESS`:** the coins are in the genesis account `liquidity` on the machine. Get into the machine as in step 8 ("getting into the machine"), then type in that window:
```bash
sudo -iu zetaphy
zetaphyd debug addr 0x<deployer address>          # gives "Bech32 Acc: zetaphy1…"
zetaphyd tx bank send liquidity zetaphy1… 1000000000000000000000azetaphy --keyring-backend test \
  --keyring-dir ~/.zetaphy-genesis-keys --chain-id zetaphy_77390-1 --gas auto --gas-adjustment 1.5 --gas-prices 1000000000azetaphy -y
```
(1,000 ZETAPHY = `1000` followed by 18 zeros, in units of `azetaphy`) No key leaves the machine

## 4. Put the key in the GitHub secret `ZETAPHY_DEPLOYER_KEY`

1. MetaMask → the `ZETAPHY deployer` account → ⋮ → **Account details → Show private key** → enter your MetaMask password → press and hold to reveal → **Copy**
2. GitHub → repo `swd-amm` → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `ZETAPHY_DEPLOYER_KEY`
   - Secret: paste the key (with or without `0x`) → **Add secret**
3. Clear the clipboard (copy some other text over it)

**Why this method, and the honest trade-offs**
- **Good:** free, nothing to install, the key does not pass through a chat or a log; GitHub stores secrets encrypted, they cannot be read back (only overwritten), and their values are masked in logs automatically
- **Downsides:** the key appears on your screen once and passes through the clipboard; your MetaMask also still holds this key
  (acceptable for a testnet: this account holds only test coins, and after step 8 it has no admin rights left)
- **Alternatives that are not recommended:**
  - Have the workflow create the key and write it as a secret itself: `GITHUB_TOKEN` cannot write secrets, so you would need to create a Personal Access Token with "Secrets: write"
    and store it as another secret, which is a secret with more power than this test key
  - Have the workflow create the key and store it as an encrypted artifact: you would have to download and decrypt it on your own machine before putting it in a secret, which breaks the "run nothing on your machine" condition,
    and artifacts in a public repo can be downloaded by anyone
- Changing the key later: create a new account as in step 3, then **Update** the existing secret (but the launch state is tied to the old deployer; see step 5 "running again")

## 5. Run the **launch-testnet** workflow, then merge the PR

The first time, allow workflows to open PRs: **Settings → Actions → General → Workflow permissions** → tick
**Allow GitHub Actions to create and approve pull requests** → Save (if you do not enable it, the workflow can still push a branch and gives you a link to open the PR yourself)

**Run 1 (dry run: checks only, sends no transactions)**
1. **Actions → launch-testnet → Run workflow**
2. `rpc` = the RPC from step 2 (e.g. `https://1-2-3-4.sslip.io`), `dry_run` = **yes**, the rest at their defaults → **Run workflow**
3. Open the run → job **Launch** → step **Launch** must show:
   - `ZETAPHY testnet (EVM chain 77390)` and `deployer 0x…` matching the address from step 3
   - `balance … need about …` with enough balance, and the `would run:` list for every step

**Run 2 (for real)**
1. Run the workflow again: the same `rpc`, `dry_run` = **no**, `governance` = `deployer`, `handover` = `no`
   - `neuro_url` = the Neuro web page on Vercel, ending in `/web/` (default `https://swd-amm-zetaphy-neuro.vercel.app/web/`; change it if you use another domain)
   - `wallet_origin` = `https://wallet.sawasdeecoin.com` (the wallet domain from step 7); leave it empty if you do not have it yet
2. It takes a few minutes. The workflow:
   - deploys: NeuroJobs + NeuroControl (current skill already voted in), ThreatRegistry, ThreatReports, NeuroIdentity + NeuroValidation,
     RewardVault, QuantumWalletFactory, test USDC/USDT + StableGateway, ComputeMarket, DEX (factory, router, 2 test coins with pools), DLMM (factory, router, default presets bin step 1/10/25/100 bps; not yet audited), NFT (factory, marketplace)
   - wires things up: DEX, DLMM and NFT check the ThreatRegistry; protects the NFT collections' shared code in the ThreatRegistry (so a single flag does not hit every collection)
   - writes config: `zetaphy-dex/web/deployments.json` (DEX + DLMM addresses for the DLMM tab), `zetaphy-nft/web/deployments.json`, `zetaphy-explorer/config.json`,
     `zetaphy-wallet/index.html` (RPC and ThreatRegistry), `zetaphy-snap/snap.config.js`, then rebuilds the snap (shasum in `snap.manifest.json`)
   - records every address in `zetaphy-launch/state/77390.json` (addresses only, no keys) and attaches it as an artifact of the run
3. **Pull requests** → open the PR "Testnet launch: contract addresses and web configs" → look at the diff (only addresses and the RPC) → **Merge**
   Vercel deploys the new web apps by itself after the merge

**If it breaks partway:** just press Run workflow again with the same values. Finished steps are skipped (the state is in the `launch/testnet` branch); nothing is deployed twice
Do not merge a PR that says **Partial** yet
**Chain wiped/restarted:** the workflow will refuse (block 1 does not match the state). Delete the file `zetaphy-launch/state/77390.json` in the `launch/testnet` branch (or delete that branch), then run again
**Not done by default:** the Neuro bridge (`zetaphy deploy-bridge`) needs a LockBox on the source chain first; once there is one, 🤖 can run it for you with `--bridge-lockbox <chainId>:0x…`
**The lock/mint bridge is always installed CLOSED:** the workflow's bridge step installs the contracts but does not open a route (hard cap of 1,000 tokens), and it fails if it finds a route open
This workflow **cannot open the bridge**; see step 16
Moving the 500 million reward pool into the RewardVault uses the `rewards` key on the machine (`zetaphy deploy-vault --fund` in `zetaphy-network/README.md`)

🤖 If you let Claude use this repo's GitHub Actions, Claude can press Run workflow, read the results and review the PR for you (the secret stays yours; Claude does not see its value)

## 6. Vercel projects

vercel.com (Hobby, free) → **Add New… → Project** → Import repo `swd-amm` → set the **Root Directory** as in the table,
Framework Preset **Other**, no need to set Build/Output (each folder already has a `vercel.json`) → **Deploy**

| Web app | Root Directory | Domain (step 7) |
|---|---|---|
| Neuro | `zetaphy-neuro` (already exists: `swd-amm-zetaphy-neuro`) | unchanged |
| PQ wallet | `zetaphy-wallet` | `wallet.sawasdeecoin.com` |
| Explorer | `zetaphy-explorer` | `explorer.sawasdeecoin.com` |
| DEX | `zetaphy-dex/web` | `swap.sawasdeecoin.com` |
| NFT | `zetaphy-nft/web` | `nft.sawasdeecoin.com` |

For each project: **Settings → Domains → Add** → type the domain from the table

🤖 If you give the Vercel MCP access to your Vercel team (Vercel → Integrations/consent for the team `swd-e92d`), Claude can create the projects and add the domains for you

## 7. DNS: CNAME

At the DNS provider for `sawasdeecoin.com`, add these records (if you use Cloudflare, set **DNS only**, grey cloud):

| Type | Name | Value |
|---|---|---|
| CNAME | `explorer` | `cname.vercel-dns.com` |
| CNAME | `swap` | `cname.vercel-dns.com` |
| CNAME | `nft` | `cname.vercel-dns.com` |
| CNAME | `wallet` | `cname.vercel-dns.com` (if you want the wallet domain) |

Wait in Vercel until it shows **Valid Configuration** (Vercel issues the https certificate itself)
If the `wallet_origin` you entered in step 5 does not match the real domain, run the workflow again with the correct value (the snap will be rebuilt)

🤖 If the domain's DNS is on Vercel and you have granted access, Claude can add the records for you

## 8. Hand admin rights over to the timelock (gov vote or multisig schedules, then a 48-hour wait)

While the testnet is being set up, the deployer is the admin of every contract for now, so further settings can be changed immediately without waiting
**Hand over only once everything works**, because after that every change must be **scheduled in ZetaphyTimelock and then wait 48 hours**

What the handover does (all in one run, then checked on chain):
- Creates **ZetaphyTimelock** (OpenZeppelin TimelockController 5.4.0) with a 48-hour delay
  - **proposer/canceller** = the chosen `governance`: `gov` (the gov module schedules by vote) or `0x<multisig>`
  - **executor = anyone** once the time is up (what will be called is locked in and visible to everyone for 48 hours) · **admin = the timelock itself**; no admin key remains
- Transfers every admin right to the timelock: NeuroControl, ThreatRegistry (which also controls ThreatReports), RewardVault, StableGateway, NeuroIdentity, ZetaphyOracle, ZetaphyPythRelay,
  BridgeGuard/BridgeAirlock (if present), the NFT marketplace, the DEX factory and the DLMM factory (two steps: the timelock accepts by itself in the same run, so no separate vote is needed any more)
- Sets the **guardian** (emergency multisig) on every contract with an emergency switch: pause (Neuro, bridge, gateway, prices), lower caps, hold flags, remove a lane/marker, **immediately**, but it can only reduce risk; re-opening must go through the timelock
- Checks on chain: every right belongs to the timelock (DEX/DLMM factory: nobody left waiting to accept `pendingGovernance`), the deployer has no role left in the timelock and is not a guardian, no EOA (single key) holds any role. Failing = this step fails (it can be run again)
- While the timelock is being set up (delay 0, deployer as proposer), launch schedules exactly one operation, the handover batch (its id is stored in the state: `handoverOperation`)
  Before transferring rights and before the deployer renounces its role, the checker reads the `CallScheduled` logs from the block where the timelock was created: any other operation still pending is **cancelled** (recorded in `cancelledOperations`
  with a warning that the deployer's key may have leaked); any other operation that has already executed = no handover to this timelock
  Cosmos transactions (e.g. `MsgEVMCall`) leave no logs the node can search, but they use the deployer's nonce: launch only sends EVM transactions, so it counts every nonce since the timelock was created
  If there is a nonce that is not an EVM transaction = no handover; create a new timelock with a new key (`--only timelock,handover --redo` or `--fresh`)
  It can only check up to 20,000 blocks from the timelock's creation, so the timelock and handover steps should run in the same run (the workflow normally does this)
  - What the checker cannot see: authz grants the deployer gave to other accounts **before** the timelock was created (the grantee can send `MsgEVMCall` on behalf of the deployer without using the deployer's nonce)
    Before the handover, check there are none: `zetaphyd q authz grants-by-granter <deployer's zetaphy1… address>` must be empty; use the deployer key only for launch, and treat the key as retired after the handover

1. Prepare the emergency multisig (guardian): `zetaphy deploy-multisig --owners 0xA,0xB,0xC --threshold 2` or a Safe (see "multisig + hardware wallet" in `zetaphy-network/README.md`); each owner uses their own hardware wallet
   - Or let the workflow create it: leave `guardian` empty and fill `guardian_owners` = `0xA,0xB` (a new SimpleMultisig, 2 signatures needed, deployed by the deployer, which owns nothing in it; its address is stored in the state as `guardianMultisig`)
   - Testnet only: two accounts of the same MetaMask are accepted; before mainnet the guardian must be 3+ different people on hardware wallets (point 4 below)
2. **Actions → launch-testnet → Run workflow**: the same `rpc`, `dry_run` = **no**, `governance` = **gov** (or `0x<multisig>`), `guardian` = **0x<emergency multisig>**, `handover` = **yes**
   - the deployer sends every transaction itself (no vote needed), then merge the PR (the state contains the `timelock` address)
3. **Changing values after this (all done in the browser):** **Actions → timelock → Run workflow**
   - `action` = **schedule**, `rpc`, `to` = the contract (addresses are in `zetaphy-launch/state/77390.json`), `sig` = the function, e.g. `setMaxBodies(uint256)`, `args` = `32`
   - Output in the run summary: the operation id (`0x…`), the time it becomes executable, and the calldata
     - governance is a **multisig**: an owner proposes `to` = the timelock and the printed data (SimpleMultisig: propose → confirm → execute, Safe: Transaction Builder), signing on a hardware wallet
     - governance is **gov**: download the `timelock-proposal` artifact, then submit a governance vote proposal on the machine (step 4)
   - Once 48 hours have passed: `action` = **execute**, `id` = the operation id (anyone can do this; the workflow uses the deployer's key only to pay gas)
     If it was scheduled by a gov vote, also enter `to`, `sig`, `args`, `salt` as when scheduling (calls made through a vote leave no logs the node can search)
   - `action` = **status** shows the delay, who holds each role, and the operation's status (Waiting / Ready / Done) · **cancel** prints what the canceller must send
   - The monitor (`bridge monitor`, the **bridge-monitor** workflow) alerts on every scheduling (contract, function and the time it becomes executable), every actual execution and every cancellation,
     even before there is a bridge. After the handover, enable the `schedule` line in `.github/workflows/bridge-monitor.yml` (e.g. every 6 hours `'7 */6 * * *'`, free when the repo is public) so the 48-hour delay leaves time to see and cancel
4. **Submitting a vote proposal (governance = gov) on the machine:** Oracle page → the **Cloud Shell** icon `>_` at the top right →
   Cloud Shell's gear menu ⚙ → **Upload** → choose the private key file you saved in step 1, then type:
   ```bash
   chmod 600 ssh-key-*.key && ssh -i ssh-key-*.key ubuntu@<Public IP>
   sudo -iu zetaphy
   ```
   Open the downloaded `timelock-proposal.json` file → copy everything, then in the machine window:
   ```bash
   cat > p.json        # paste, then press Ctrl-D
   F="--from validator --keyring-backend test --keyring-dir ~/.zetaphy-genesis-keys --chain-id zetaphy_77390-1 --gas auto --gas-adjustment 1.5 --gas-prices 1000000000azetaphy -y"
   zetaphyd tx gov submit-proposal p.json $F
   zetaphyd q gov proposals -o json | jq -r '.proposals[-1].id'     # proposal number
   zetaphyd tx gov vote <number> yes $F
   ```
   Wait 10 minutes: `zetaphyd q gov proposal <number>` must be `PROPOSAL_STATUS_PASSED`, then wait another 48 hours before you execute (step 3)
   - `gov.sh neuro …` calls NeuroControl directly and works only while the gov module is NeuroControl's own governance; after the handover, use the timelock instead
   - With the gov module as the only canceller, cancelling also needs a vote. It is recommended to add a multisig as another proposer/canceller (`--timelock-proposers 0x<multisig>` in launch.js)
5. **Emergency:** the guardian's owners can call from the multisig immediately, e.g. `pause()` on NeuroControl / BridgeGuard / StableGateway, `pauseFeed(<asset>)` on ZetaphyOracle
   Re-opening must be scheduled through the timelock (step 3)

🤖 Claude can run the launch-testnet and timelock workflows for you (if given GitHub Actions access), but voting and multisig signing must be done by you and the other owners on their own hardware wallets

## 9. MetaMask Snap (npm and allowlist)

For now the snap can only be installed in **MetaMask Flask** from npm; regular MetaMask requires it to be on the allowlist (an audit is needed first)
1. Sign up at **npmjs.com** (free) → turn on **2FA** → **Add Organization** named `zetaphy` (free for public packages)
   If the name is already taken, tell Claude a new scope name (🤖 renames every occurrence as described in `zetaphy-snap/README.md`)
2. No need to publish from your own machine: npmjs.com → profile picture → **Access Tokens → Generate New Token → Granular Access Token**
   (Packages: Read and write for `@zetaphy` only, short expiry) → copy → GitHub **Settings → Secrets and variables → Actions → New repository secret** named `NPM_TOKEN`
3. 🤖 Claude can add a publish workflow (one button, like step 5: build, check the shasum, `npm publish --access public` with `NPM_TOKEN`) when you are ready
   After publishing, that name+version cannot be changed, so it is best to wait until `snap.config.js` has the real values from step 5 and the wallet domain from step 7
4. Test in MetaMask Flask: open the wallet web app → "Use MetaMask (ZETAPHY Snap)"
5. **allowlist** (later): an audit of the snap (step 14), then fill in the form https://go.metamask.io/snaps-directory-request as described in `zetaphy-snap/README.md` step 7

## 10. WalletConnect projectId

1. **cloud.reown.com** (free) → sign up → **Create project** (type WalletKit/AppKit) → enter the domain `wallet.sawasdeecoin.com` under **Allowlist / Domain**
2. Copy the **Project ID** (not a secret: it is already in the public web page; you can send it to Claude)
3. 🤖 Claude puts it in the `<meta name="zetaphy-walletconnect-project-id">` of `zetaphy-wallet/index.html` (the button becomes clickable; wiring up the actual SDK is the next piece of work, per `zetaphy-wallet/README.md`)

## 11. Contact email

There must be a channel for owners of flagged contracts to reply/request a correction. For now these are placeholder text:
- `docs/LEGAL.md` (`[insert the project owner's contact email]` and `[project owner's contact email]`)
- `zetaphy-neuro/web/legal.html` (Thai and English)

Create an email address just for the project (e.g. a free Gmail, or an alias on your domain), then 🤖 tell Claude so it can edit both files, or edit them yourself on the GitHub page (pencil icon → Commit changes)

## 12. Consult a lawyer

Before announcing it for general use, especially about: flagging other people's contracts (defamation/liability), the SWD airdrop, the test coins and stablecoins,
and data collection (PDPA). Use `docs/LEGAL.md` as the starting document for the conversation (it has a list of free legal-aid sources in Thailand that you must verify yourself)
Claude is not a lawyer, and being a testnet does not make this step go away

## 13. Listing on chainlist and Keplr

Do this after the chain is up and stable, and you should have a permanent domain instead of `sslip.io` (IP changes = broken listings). See [`zetaphy-chain/wallets/README.md`](../zetaphy-chain/wallets/README.md) step 9
- chainlist: a PR to `ethereum-lists/chains` with the file `zetaphy-chain/wallets/ethereum-lists/eip155-77390.json`
- Keplr: PRs to `chainapsis/keplr-chain-registry` and `cosmos/chain-registry` (`zetaphy-chain/wallets/chain-registry/zetaphytestnet/`)
- The PRs must come from your GitHub account: on the GitHub web page press **Fork** → **Add file → Create new file** → paste the file contents → **Propose changes / Create pull request**

🤖 Claude fills in HOST/NODE_ID in the files ready to paste, and checks the RPC/REST/websocket that the registries will check

## 14. Audit before there is real money

Everything in this checklist is a testnet. The contracts and the chain have not passed an audit yet (the scope is in `docs/AUDIT_SCOPE.md` and `docs/CHAIN_AUDIT_SCOPE.md`)
**Do not use with real money** until it has been audited by an independent auditor, every finding of medium severity or above has been fixed, and the report has been published; mainnet uses the procedure in `docs/MAINNET_RUNBOOK.md`, not this workflow

## 15. IBC + USDC from the Noble testnet

Connect ZETAPHY to Noble (the chain where Circle issues USDC) over IBC for free, all in the browser. Details in [`zetaphy-chain/ibc/README.md`](../zetaphy-chain/ibc/README.md)
Do this after step 2 (the chain is running) and use the Noble **testnet** (`grand-1`) only; mainnet (`noble-1`) waits for step 14
1. Get into the machine through Cloud Shell as in step 8.2 (as `ubuntu`; no need for `sudo -iu zetaphy` yet), then put `zetaphy-chain/ibc/setup-relayer.sh` on the machine (GitHub → **Raw** → `cat > setup-relayer.sh`, paste, Ctrl-D)
2. `sudo bash setup-relayer.sh` → gives 2 relayer addresses (there is no key for you to hold)
3. Top up gas: send 10 ZTPHY from MetaMask to the relayer's `0x…`; **faucet.circle.com** → Noble Testnet → the `noble1…` address
4. `sudo bash setup-relayer.sh create-channel` → note `ZETAPHY_CHANNEL` (e.g. `channel-0`), then `sudo bash setup-relayer.sh start`
5. `sudo bash setup-relayer.sh send-usdc <MetaMask address> 1000000` (1 USDC into the chain)
6. `sudo -iu zetaphy`, then `gov.sh ibc-usdc-erc20 channel-0` (the ERC-20 address goes into MetaMask / the token list) and
   `gov.sh ibc-usdc-ratelimit channel-0` → `gov.sh vote <number> yes` (cap of 1% per 24 hours)
7. Upkeep: `sudo bash setup-relayer.sh status` once a week; top up USDC from the faucet when the Noble-side balance is low; do not stop the relayer for more than 14 days

🤖 Share the output of `status` (there are no secrets in it) and Claude can help read it and fix problems

## 16. Bridge: keep it closed until every gate passes

The lock/mint bridge (`BridgeAirlock` → `BridgeGuard`) is **closed** after launch and must stay closed until **every one** of these holds (a decision of the project owner):
1. **A second, truly independent lane:** Hyperlane (`HyperlaneLane` + `HyperlaneLockBox`) whose controllers (Hyperlane's Mailbox/ISM/validators) are not the same group as the Neuro runners
   ZETAPHY does not have Hyperlane yet: Hyperlane's Mailbox, ISM, relayer and validators must be installed first
2. An **audit** of the bridge by an independent auditor (step 14), with the https link + sha256 of the report recorded on chain (`BridgeGuard.setAudit`)
3. **≥ 10 independent Neuro runners** (`NeuroJobs.activeWorkers`; a human must also check that they really are different people)
4. **The guardian and governance are separate multisigs**, owners ≥ 3, signatures required ≥ 2, each owner using their own **hardware wallet (Ledger/Trezor through MetaMask)**; nobody holds several keys
   No owner is in both, and none is the deployer's key (governance can be the gov module). See the section "multisig + hardware wallet" in `zetaphy-network/README.md`
5. **A bug bounty that has real money** (`docs/BUG_BOUNTY.md`: currently credit only; a vote must transfer money into the pool first)
6. **The monitor is running:** put `rpc` in `zetaphy-network/bridge-monitor.json` (or the variable `ZETAPHY_RPC`) and enable the `schedule` line in `.github/workflows/bridge-monitor.yml`
   - **At least one private alert channel** (secret): `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL` or `PRIVATE_ALERTS_TOKEN` (issues in the private repo `pospos191-alt/zetaphy-private`)
     The public repo's logs show only the number of alerts; details go to private channels only. No channel = the run fails (issues in this repo only when the variable `BRIDGE_ALERT_ISSUES` = `on`)
   - The real alert thresholds can be set as the secret `BRIDGE_MONITOR_THRESHOLDS` (the values in the committed file are only defaults)
   - If you use watched contracts: the secrets `BRIDGE_WATCHLIST` (the list is kept secret, not committed) and `BRIDGE_MARKER_KEY` (a new key with no other rights, holding ZETAPHY for gas only)
     then have governance set it as a marker: `zetaphy bridge marker 0x<address of that key>` (a marker can only mark addresses and does not touch funds; governance can clear marks with `zetaphy bridge untrip`)
   - Automatic marking happens in the monitor's next run. **`quarantine` must be longer than the interval between runs** (default 3600 seconds = hourly is not enough)
     Recommended when the repo is public: every 15 minutes (`*/15`, free) with a quarantine of at least 2 hours (`BridgeAirlock.setQuarantine(7200)` through governance)
7. **Very low starting caps:** 1,000 tokens per day, raised by no more than 2× at a time, with a 7-day wait each time (`zetaphy bridge cap propose`), following the table in the README

Once everything holds (on a machine that has `zetaphy-network`; this key needs no rights, the commands print transactions for the multisig to sign):
```bash
zetaphy bridge gates --audit-report https://<auditor>/report.pdf --audit-sha256 <sha256sum of the file> --i-understand-real-funds   # check only
zetaphy bridge open  --audit-report https://<auditor>/report.pdf --audit-sha256 <sha256sum of the file> --i-understand-real-funds   # all pass: prints setAudit then setRoute for governance
```
- If any item fails, the command prints every missing item and sends nothing · `BridgeGuard` itself also refuses to open without an on-chain audit or with fewer than 2 independent lanes
- The command prints a table of lanes / controllers / admins / multisig owners for you to **check by eye** before the owners sign
- Emergency: guardian `zetaphy bridge pause` (stops immediately) · re-opening must be done by governance (`unpause`), which after the handover is the timelock (step 8)
- After the handover, every command above that governance must send (`setAudit`, `setRoute`, `setMarker` …) must be scheduled through the timelock; the command prints `zetaphy timelock schedule …` for you

🤖 Claude can run `bridge gates` and read the monitor's results for you, but multisig signing must be done by you and the other owners on their own hardware wallets

---

### Reference: launch.js

The workflow calls `node zetaphy-launch/launch.js` (the code is readable in the repo; `--help` lists every option). Things worth knowing:
- It uses each package's own deploy code (`zetaphy-network/cli.js`, `zetaphy-dex` `deploy()`, `zetaphy-dex/dlmm-cli.js` `deploy()`, `zetaphy-nft/cli.js deploy`) rather than rewriting it
- It always checks first: the chain id must be 77390 (testnet only), the deployer's balance covers the estimate, the state matches the chain and the same deployer
- Every step is recorded in `zetaphy-launch/state/77390.json` as soon as it finishes (`--resume` skips finished ones); the check steps (skill, wire, protect, configs, snap, handover) run every time and send no transactions if everything is already correct
- key: taken only from a file (`--key-file`, chmod 600) or env, never on the command line; never printed, never written to the state; the workflow writes the secret to a 0600 file in `$RUNNER_TEMP` and deletes it at the end of the run
- The `oracle` step: TwapRecorder + ZetaphyPythRelay + ZetaphyOracle (ZETAPHY/USD from the DEX's WZETAPHY/tUSD pool, plus Pyth with `--pyth-zeta-feed`), then makes the StableGateway price through the oracle
  A price is available once the TWAP window is full (someone must poke it, e.g. `zetaphy relay start --poke-oracle 60`) · `--stable-testnet-price 0.01` = a testnet fallback with a fixed price (labelled; can be turned off through the timelock)
- The `timelock` + `handover` steps (only with `--handover`): see step 8 · `--guardian` (an existing multisig) or `--guardian-owners 0xA,0xB [--guardian-threshold 2]` (the `guardian` step deploys a new SimpleMultisig) is required · `--timelock-delay` defaults to 172800 (below 86400 only with `--devnet` and an RPC of 127.0.0.1) · `--timelock-proposers`, `--timelock-executor open|governance`
- Tests: `cd zetaphy-launch && npm test` (step runner, state, config writers, timelock options) and `ZETAPHYD=… flock /tmp/ci-test/devnet.lock npm run test:devnet` (a real chain on the CI machine: deploys everything including DLMM, oracle, DEX/NFT/Neuro smoke tests, handover to the timelock + on-chain checks, guardian stops immediately, a vote schedules and then anyone executes after the time is up, monitor reports)

## 17. Security in the chain's core (after a genesis reset)

A new chain from the current `setup-node.sh` has the security core from block 1, but every rule is off (guide: `docs/SECURITY-CORE.md`)
Turn them on one at a time with a governance vote on the node machine (nothing to run on your own machine):
1. **Threat gate:** once Neuro's ThreatRegistry has been deployed, `gov.sh threat-gate <ThreatRegistry 0x…> on`, then vote
   (before that, set the protected keys of all protocol contracts in the registry)
2. **IBC hold:** after opening the channel with Noble, `gov.sh ibc-hold 21600 <guardian>` (guardian = multisig) and
   `gov.sh ibc-hold-rule <ibc/… of USDC> <minimum> <bps>` together with the rate limit (step 15)
3. **Q-day:** do not set it yet. It can be tested on the testnet only, and is set once every validator has quantum-locked its operator account
   (`gov.sh qday <height>` far enough from now for everyone to migrate in time)
See the values in use: `gov.sh security`
