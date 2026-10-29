**English** | [ภาษาไทย](README.th.md)

# ZETAPHY Chain — Stage 0: test chain (testnet)

A test chain with a single validator, running entirely on **Oracle Cloud**. Everything is done through the Oracle web console.
You do not need to run anything on your own computer.

| Setting | Value |
|---|---|
| Software | Cosmos SDK + Cosmos EVM `v0.7.3` (commit `c3ae906…` is checked before build) |
| Chain ID (Cosmos) | `zetaphy_77390-1` |
| Chain ID (EVM / MetaMask) | `77390` (still free in ethereum-lists/chains as of 19 Oct 2026) |
| Coin | ZETAPHY, base unit `azetaphy` (1 ZETAPHY = 10^18) |
| Cosmos wallet address | Starts with `zetaphy1…` (0x… addresses work in MetaMask as usual) |
| Block time | ~5 seconds |
| Supply | 1,000,000,000 ZETAPHY, no inflation, and it shrinks as fees are burned (half of the fees in every block) |

Coin allocation at chain launch (according to plan B):

| Part | Amount | Notes |
|---|---|---|
| Rewards for draft runners and validators | 500,000,000 | The `rewards` account moves into `RewardVault` (`zetaphy deploy-vault --fund`), which releases 10% of the remainder per year. It cannot be withdrawn faster than that |
| Airdrop to SWD holders | 200,000,000 | `swd-airdrop` account, waiting for the snapshot |
| Community fund | 150,000,000 | `community` account |
| Liquidity and partners | 100,000,000 | 1,000,000 is deducted for the validator and 1,000,000 for your wallet (if set) |
| Development team | 50,000,000 | Vesting account: locked for 1 year, then released linearly until the end of year 4 |

---

## Set up the machine on Oracle Cloud (all in the web console)

### 1. Sign up / sign in
1. Go to **cloud.oracle.com** and sign up for the Free Tier (a card check is required, but Always Free resources are not charged)
2. Choose a Home Region close to Thailand, e.g. **Singapore** (this cannot be changed later)

### 2. Create the machine
1. Menu ☰ → **Compute → Instances → Create instance**
2. **Name:** `zetaphy-node-0`
3. **Image:** click *Change image* → **Canonical Ubuntu 24.04**
4. **Shape:** click *Change shape*
   - If **Ampere → VM.Standard.A1.Flex** is available: set **2 OCPU / 12 GB** (or as much as the free tier gives) ← recommended
   - If not: **VM.Standard.E2.1.Micro** (1 GB) works, but installation takes much longer (the script adds swap by itself)
5. **Networking:** use the defaults (create a new VCN and public subnet) and make sure it has a **public IPv4**
6. **SSH keys:** choose *Generate a key pair for me*, then click *Save private key* and keep it for emergencies
   (the normal steps do not need it)
7. Click **Show advanced options → Management → Paste cloud-init script**
   - Open the file [`cloud-init.sh`](./cloud-init.sh) on GitHub → click **Raw** → select all and copy → paste it into this box
     - This file is only a few lines long: it downloads the full [`setup-node.sh`](./setup-node.sh) from the public repo
       [github.com/pospos191-alt/zetaphy-chain](https://github.com/pospos191-alt/zetaphy-chain)
       (the full file is bigger than the 32,000 bytes Oracle accepts) and runs it only if its SHA-256 fingerprint matches the one written in the file
     - Files in the public repo are named after their SHA-256 and are never edited again. CI checks every time that `cloud-init.sh` matches `setup-node.sh`
   - (Optional) If you want 1,000,000 test ZETAPHY in your MetaMask wallet:
     change the line `OWNER_EVM_ADDRESS=""` in the pasted `cloud-init.sh` to
     `OWNER_EVM_ADDRESS="0x<your wallet address>"` (public address only; never put a private key here)
8. Click **Create** and wait: about 15–25 minutes for an A1 machine; a Micro machine may take 1–2 hours

### 3. Open ports for outside access
1. On the instance page → **Primary VNIC → Subnet** (link) → **Security Lists** → *Default Security List*
2. **Add Ingress Rules** (Source CIDR `0.0.0.0/0`, IP Protocol **TCP**), one port at a time:
   - **26656** so other machines can join the chain (in stage 1)
   - **80** and **443** for https (the web wallet requires https)
     - The script installs Caddy (from the Ubuntu package archive), which requests a free Let's Encrypt certificate automatically
     - The address is `https://<IP with dots replaced by dashes>.sslip.io`, e.g. IP `1.2.3.4` → `https://1-2-3-4.sslip.io`
     - sslip.io is a free DNS service whose names point back to that same IP
     - If you open the ports after the machine has finished installing, Caddy retries the certificate request by itself
3. The machine's own firewall is already opened by the script

### 4. Check that the chain is running (no computer needed)
- **Easiest way:** add the network in MetaMask (on mobile is fine):
  - Network name: `ZETAPHY Testnet`
  - RPC URL: `https://<IP with dashes>.sslip.io` (or your own domain; plain `http://<IP>:8545` is closed unless `PUBLIC_HTTP_RPC=1`)
  - Chain ID: `77390`
  - Currency symbol: `ZTPHY` (MetaMask and chainlist accept at most 6 characters; see [`wallets/README.md`](./wallets/README.md))
  If the network is added and you see a balance of 1,000,000 ZTPHY (= ZETAPHY, if you set OWNER_EVM_ADDRESS), the chain is running.
  - Other wallets (Rabby, Trust, OKX, Coinbase, Keplr, Leap, Ledger, mobile) and listing on chainlist / Keplr: [`wallets/README.md`](./wallets/README.md)
- **Or use Oracle Cloud Shell** (the `>_` icon at the top right of the Oracle web console) and paste:
  ```bash
  curl -s -X POST https://<IP with dashes>.sslip.io -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
  ```
  The `result` number should increase every ~5 seconds
- In the web wallet (`zetaphy-wallet`), set the RPC to `https://<IP with dots replaced by dashes>.sslip.io`

If it is still not working after a long time: instance page → **Resources → Console connection**,
then look at the log in `/var/log/zetaphy-setup.log`

### Google Cloud e2-micro (free forever)

Google Cloud gives one **e2-micro** machine free forever (1 GB RAM, 30 GB disk, US regions only).
It is much smaller than Oracle: the build takes 1–2 hours or more (the script adds 4 GB of swap by itself) and RAM is tight.
1. Sign up at **cloud.google.com/free** (a card check is required; using only the free part is not charged)
2. **Compute Engine → VM instances → Create instance**
   - **Region:** `us-central1` (or `us-west1`, `us-east1`; only these are free) · **Machine type:** `e2-micro`
   - **Boot disk:** Ubuntu 24.04 LTS (x86/64), **Standard persistent disk** 30 GB
   - **Firewall:** tick Allow HTTP and HTTPS
   - **Advanced → Management → Metadata → Add item:** Key = `user-data`
     Value = the whole content of [`setup-node.sh`](./setup-node.sh) (Google accepts larger data than Oracle, so `cloud-init.sh` is not needed)
     To receive test coins, change the line `OWNER_EVM_ADDRESS="${OWNER_EVM_ADDRESS:-}"` to `OWNER_EVM_ADDRESS="0x…"`
3. **VPC network → Firewall → Create firewall rule:** Targets = All instances, Source `0.0.0.0/0`,
   TCP `26656` only (no need to open 8545: wallets and the web use `https://<IP with dashes>.sslip.io`, which compresses data and uses less traffic)
4. Check the same way as step 4 above (use the machine's External IP). View the log with the **SSH** button on the instance page: `sudo tail -f /var/log/zetaphy-setup.log`
5. **Avoid charges (important):** **Billing → Budgets & alerts → Create budget**, set $1 and send email alerts at 50% / 100%

**Only 1 GB/month of outbound data is free**; anything above that is charged. The script detects that it is an e2-micro and turns on **low-traffic mode**:
- Few peers (4 in / 2 out) and peer send rate limited to 256 KB/s
- Compress (gzip/zstd) every response over https and limit RPC response size (500 log entries, batch of 20)
- **Quota watcher** every 10 minutes: if outbound traffic this month exceeds 800 MB, it temporarily turns off public RPC
  (the chain keeps running; blocks do not stop) and turns it back on by itself when the new month starts
  View usage: **SSH** button → `cat /var/lib/zetaphy-egress/status`
- Force on/off: change the line `LOW_EGRESS="${LOW_EGRESS:-auto}"` in the script to `1` or `0`;
  change the cap with `EGRESS_LIMIT_MB`

Limitations: 1 GB of RAM is enough for the chain only. Do not run an IBC relayer or a Neuro runner on this machine yet.
When you open it to the public, move to a bigger machine (e.g. Contabo / OVH) using the same script and the validator key files.

---

## Join the chain: run a node or validator (so the chain is not on one machine only)

**One command (recommended):** on any Linux machine with systemd (x86_64 or arm64), paste:
```bash
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/install.sh | sudo MONIKER=your-name bash -s -- validator
```
- Uses the prebuilt chain binary (SHA-256 checked), no build. Joins `rpc.sawasdeecoin.com` and asks its faucet for 10 ZETAPHY
- A timer checks every 10 minutes: once synced and funded, it stakes 9 ZETAPHY and becomes a validator by itself, then stops checking
- `sudo zetaphy-validator status` shows progress and diagnostics with advice (peers, disk, missed blocks, jail risk with a time estimate), `sudo zetaphy-validator backup` lists the files to keep offline,
  `sudo zetaphy-validator unjail` brings it back after downtime
- After the backup: `sudo zetaphy-validator secure` shreds the plaintext 24-word file (only once you confirm the
  words are saved offline, and only if the staking key is in the keyring), turns SSH passwords and root login off
  (only when a sudo account has an SSH key, or Google OS Login is on, so you cannot lock yourself out; checked with
  `sshd -t`, rolled back on error), turns on automatic security updates (unattended-upgrades / dnf-automatic, no
  automatic reboot) and fail2ban, sets key folders to 700 and key files to 600, and lists ports open to the outside.
  It asks before each change (`--yes` for none; the words then also need `--words-saved`; `--only ssh,updates` runs
  some steps). It never deletes `priv_validator_key.json`, `pq_vote_key.seed`, `node_key.json` or the keyring.
- Open port 26656 (and 80, 443) in your cloud provider's firewall, or use the Oracle button (`deploy/oracle`) with `validator`, which opens them
- Where it runs:

  | Machine | Notes |
  |---|---|
  | Any cloud, free or paid (Oracle, Google, AWS, Azure, Hetzner, DigitalOcean, Vultr, Linode, …) | Open TCP 26656 in the provider's firewall |
  | Home PC, mini PC, old laptop, Raspberry Pi 4/5 (64-bit OS) | No port needed (forwarding 26656 on the router helps); keep it on 24/7 |
  | Windows 10/11 | Ubuntu in WSL 2 (`wsl --install -d Ubuntu-24.04`), paste the command inside Ubuntu. If systemd is off, the script turns it on and asks for `wsl --shutdown`. Keep the PC awake and one Ubuntu window open |
  | macOS | An Ubuntu VM: `multipass launch 24.04 -n zetaphy -c 2 -m 4G -d 40G && multipass shell zetaphy`, then the command |

  Ubuntu, Debian, Fedora, RHEL/Rocky/Alma, Amazon Linux, openSUSE and Arch install what they need by themselves.
  Containers without systemd and musl systems (Alpine) are refused with what to use instead.
  `sudo zetaphy-validator preflight` checks a machine without installing anything.
- Keys: the node makes three, on the machine itself, and never sends them anywhere:

  | Key | What it does | Where |
  |---|---|---|
  | Staking account (eth_secp256k1, 24 words, coin type 60) | holds and stakes ZETAPHY; earns BZTPHY | `~/.zetaphy-genesis-keys/MNEMONICS-KEEP-SECRET.txt` |
  | Validator signing key (ed25519) | signs blocks | `~/.zetaphy/config/priv_validator_key.json` |
  | Vote key (ML-DSA-44, quantum-resistant) | signs votes alongside ed25519 | `~/.zetaphy/config/pq_vote_key.seed` |

  The staking account uses the same derivation as MetaMask (m/44'/60'/0'/0/0), so its words also open it in MetaMask,
  Rabby, Trust, OKX or Keplr (to see BZTPHY and ZETAPHY). To stake from your own wallet's phrase instead, run
  `sudo zetaphy-validator import-key` before the node has staked (`ACCOUNT_INDEX=1` for the wallet's second account).
  Use a new phrase: it is stored on the server, and this is a testnet. The two node keys are always made by the node;
  to move a validator to a new machine, copy both files, and stop the old machine first (two machines with the same
  key is double signing).
- Validators earn BZTPHY reward points, converted to real ZETAPHY at mainnet: [`rewards/README.md`](./rewards/README.md)

The manual way, step by step:

Anyone can join with the same kind of free machine (Oracle / Google), without any files from this repo.
The first machine publishes what is needed at `https://<name>.sslip.io/zetaphy/` (genesis, peer address, setup script).

1. When creating the machine, paste this short script instead of `cloud-init.sh` (change `JOIN` to the https name of the machine to join):
   ```bash
   #!/bin/bash
   JOIN=1-2-3-4.sslip.io
   curl -fsS "https://$JOIN/zetaphy/setup-node.sh" -o /root/zetaphy-setup-node.sh
   JOIN=$JOIN bash /root/zetaphy-setup-node.sh
   ```
   - The machine builds the same chain, fetches the genesis, connects to that machine, and syncs all blocks
   - It creates a `validator` key and requests 10 ZETAPHY from the first machine's faucet by itself
2. Open port 26656 (and 8545, 80, 443 if you also want to serve RPC) the same way as step 3
3. (To become a validator) When syncing is done, log in to the machine via SSH from the Oracle/Google web console and run:
   ```bash
   sudo bash /root/zetaphy-setup-node.sh --become-validator 9   # stake 9 ZETAPHY
   ```
4. **Give new validators a real voice (delegation program):** a newcomer's stake is very small compared with the first machine.
   The community fund manager can delegate stake from the first machine:
   ```bash
   gov.sh validators                              # who is a validator and what % of voting power they hold
   gov.sh delegate zetaphyvaloper1… 50000         # stake from the community fund to that validator
   ```
   Gate 3 target: ≥ 20 independent validators, and no one holds more than 33%

**Faucet (testnet):** `zetaphy_faucet` (https only) gives 10 ZETAPHY per address once per day, at most 3 times per day
from one internet address (an IPv6 /64 counts as one) and at most 200 times per day in total, and does not give to addresses
that already have funds. It uses only a separate key that holds 1,000,000 test ZETAPHY (from the liquidity part).
```bash
curl -s https://<name>.sslip.io -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"zetaphy_faucet","params":["0x<your address>"]}'
```

**Proof-of-work faucet (testnet):** `zetaphy_faucetPow(address, height, nonce)` gives the same 10 ZETAPHY for a few minutes
of browser work instead of trusting the caller's IP: `sha256(chainId as 8 bytes || hash of block height || address (20 bytes) || nonce (8 bytes))`
must start with 30 zero bits (`zetaphy_faucetPowInfo` tells the difficulty, the reward, today's grants left), at a block among
the last 100. A proof binds its address and is used once; the per-address day, the 200-a-day total and "no funds yet" are
shared with `zetaphy_faucet`; rpc-guard allows 10 such claims per internet address a day (`--faucet-pow-per-day`). This is
**not mining**: ZETAPHY stays proof of stake and the work secures nothing; it is a captcha so one person cannot empty the faucet.
The hub's "Mine" page does it in the browser (`zetaphy-hub/README.md`). An operator can set another difficulty (12–48) in
`<home>/config/faucet-pow-bits`, read on every call.

## Small machines (e.g. 1 GB RAM)

The script adjusts itself to the machine's RAM:
- Keeps about 6 days of past state (pruning), so the disk does not grow forever
- RAM below 3 GB: compiles one job at a time, uses smaller caches, and adds 4 GB of swap
- Limits the node's memory to 60% of RAM (`GOMEMLIMIT`) to keep the machine from freezing

### Prebuilt chain binary

Compiling on a 1 GB machine takes hours (or never finishes linking). GitHub Actions builds `zetaphyd`
for every published `setup-node.sh` (x86_64 and ARM64) and publishes it as the release
`zetaphyd-<first 12 characters of the script's sha256>`, with `SHA256SUMS`. Install it with `ZETAPHYD_BIN=`:

```bash
S=<the script's sha256>; R=zetaphyd-${S:0:12}; ARCH=amd64   # arm64 on ARM machines
cd /tmp
curl -fsSLO https://github.com/pospos191-alt/swd-amm/releases/download/$R/zetaphyd-linux-$ARCH
curl -fsSLO https://github.com/pospos191-alt/swd-amm/releases/download/$R/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/zetaphy-chain/main/v/$S.sh -o setup.sh
echo "$S  setup.sh" | sha256sum -c
sudo OWNER_EVM_ADDRESS=0x<your wallet address> ZETAPHYD_BIN=/tmp/zetaphyd-linux-$ARCH \
  setsid bash setup.sh >/dev/null 2>&1 </dev/null &
sudo tail -f /var/log/zetaphy-setup.log     # Ctrl+C stops watching, not the setup
```

Only one copy of the script runs at a time; a second one says so and exits. Anyone can rebuild the
binary from the same sources (`.github/workflows/release-zetaphyd.yml`) and compare the hash.
Each binary also has a signed build provenance (Sigstore), which shows it was built by that workflow
from a commit of this repository and not uploaded by hand:
`gh attestation verify zetaphyd-linux-$ARCH --repo pospos191-alt/swd-amm`

**Updating a running node** (keys and chain data kept; settings, rpc-guard and Caddy redone, node restarted):
`curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/install.sh | sudo bash -s -- update`

### Your own domain for the RPC

Instead of `<ip>.sslip.io`, wallets can use your own name (it keeps working if the machine's IP changes; chainlist and
Keplr listings need it). At your DNS provider add an **A record**, e.g. `rpc` → the machine's IP (DNS only, no proxy),
then run the same setup command again with `PUBLIC_HOST=rpc.<your domain>` added after `sudo`. Caddy serves both names
and gets the certificate; `keplr.json` and `evm-chain.json` use the new name. Running the script again keeps the chain,
keys and genesis.

WebSocket: `wss://<name>/ws` (EVM JSON-RPC, e.g. `eth_subscribe` for new blocks and logs), forwarded by Caddy to 8546 on the machine.
A node set up before this version gets it by running the same setup command again.

## Security (testnet only)

- Coins on this chain have no value. Do not advertise or sell them
- Keys of the chain-launch accounts are kept separately in `/home/zetaphy/.zetaphy-genesis-keys` (readable only by the `zetaphy` user),
  not in the folder the node uses, so people connecting to RPC cannot transfer funds from these accounts
- Only 26656 (P2P) and 80/443 (Caddy, https) are public. 8545, 26657, 1317 and 9090 listen only on the machine itself
  (`PUBLIC_HTTP_RPC=1` opens plain 8545 too).
- Caddy sends both RPCs through `zetaphyd rpc-guard` (service `zetaphy-rpc-guard`):
  - EVM JSON-RPC: only `eth_*`, `net_*`, `web3_*` and `zetaphy_*` (no `txpool_`, `debug_`, `admin_`, `personal_`)
  - CometBFT RPC (`/rpc`): only the read methods wallets and the explorer use, plus `broadcast_tx_sync/async`;
    no websocket, `dump_consensus_state`, `net_info`, `unconfirmed_txs`, `genesis`
  - at most 300 requests a minute from one IP on each side, 64 at a time in all, batches of at most 20, bodies of at most 1 MB
  - `zetaphy_sendCosmosTx` only forwards transactions that are already signed (like `eth_sendRawTransaction`); it holds no keys
- `sudo zetaphy-validator secure` (above) locks a node down after the backup. The low-egress guard closes 8545 to the
  outside only (`! -i lo`, IPv4 and IPv6): the node's own tools keep reaching it on 127.0.0.1
- A threshold signer for the ed25519 key (Horcrux, 2 of 3 machines) is possible as an option; what it protects and
  what it does not (the ML-DSA vote key stays on the node): [`horcrux/README.md`](horcrux/README.md)
- Before stage 3 (real money) these must change: keys go into multisig/HSM, https on the project's own domain name (instead of sslip.io),
  ≥ 20 independent validators, audit according to plan

## What stage 0 does not have yet (done in later stages)

- ~~Reward release system of 10% of the remaining pool per year~~ Done: `RewardVault` in zetaphy-network
- ~~EIP-1559 style fee burning~~ Done: half of the fees in every block are burned (`evmd/zetaphy_feeburn.go` in the patch); the other half goes to validators
- ~~Paying fees in USDC~~ Done via StableGateway + relay (zetaphy-network stage 2)
- ~~`zetaphy node start` program for Neuro draft runners~~ Done in zetaphy-network
- ~~Quantum-resistant signatures~~ Done (stage 5 below)
- ~~IBC transfer caps~~ Done (stage 3 below)
- ~~Standard EVM contracts~~ Done: new chains have the CREATE2 deployer (`0x4e59…956C`), Multicall3 (`0xcA11…CA11`), Permit2 (`0x0000…8BA3`) and the Safe singleton factory (`0x914d…43d7`) from genesis (`app_state.evm.preinstalls`). Addresses and code match Ethereum, so wallets and dev tools work right away (the chain installs EIP-2935 by itself; it is not in this list)
- A real cross-chain bridge (needs a destination chain and a relayer)

## Stage 3: IBC transfer caps (e.g. USDC from Noble)

The chain has the `x/ratelimit` module sitting on the cross-chain coin transfer path (IBC, both v1 and v2)
- It is published code from ibc-apps (rate-limiting v10.7.0), hash-checked before use, then patched to work with ibc-go v11
- Governance sets a cap per coin per channel, as a % of that coin on the chain, over a set time window, separately for inbound and outbound
- A transfer that would exceed the cap is rejected; no funds are lost (outbound: the transaction fails; inbound: funds are returned to the sender)
  - If the bridge on the other side is hacked, losses cannot exceed the cap for that window
- Used together with `BridgeGuard` (zetaphy-network), which enforces caps on the EVM contract side

Once an IBC channel to Noble is open, propose a USDC cap as well (on the node machine, as the `zetaphy` user):
```
gov.sh propose-ratelimit ibc/<USDC hash> channel-0 10 10 24   # in/out at most 10% per 24 hours
gov.sh vote <id> yes
gov.sh ratelimits
```

## Stage 3 continued: real USDC from Noble (IBC + relayer)

The toolkit in [`ibc/`](ibc/README.md) connects ZETAPHY to Noble (the chain where Circle issues USDC itself). Everything is done on the node machine through Cloud Shell, for free:
```
sudo bash setup-relayer.sh                  # Hermes (pinned version + SHA-256), relayer user, keys; prints only the addresses to top up gas
sudo bash setup-relayer.sh create-channel   # light client + connection + transfer channel
sudo bash setup-relayer.sh start            # hermes-relayer service (status / balances / stop)
sudo bash setup-relayer.sh send-usdc <0x…> 1000000   # first USDC transfer: 1 USDC
gov.sh ibc-usdc-erc20 channel-0             # USDC ERC-20 address for MetaMask, explorer, DEX
gov.sh ibc-usdc-ratelimit channel-0         # low cap 1% / 1% per 24 hours (vote)
```
- USDC on ZETAPHY is the coin `ibc/<sha256("transfer/<channel>/uusdc")>` (`gov.sh ibc-usdc-denom <channel>`)
  The erc20 module of Cosmos EVM v0.7.3 turns it into an ERC-20 by itself when the first coin arrives (no registration proposal)
- Current testnet: this ERC-20 returns `decimals()` = 0 (ibc-go default metadata). This can be fixed with a chain upgrade, or by putting `gov.sh ibc-usdc-metadata` in the genesis of a new chain
- If the relayer goes down, transfers are slower but no funds are lost (the light clients check each other), but it must not stop for more than 14 days; IBC light clients check ed25519, which is not quantum-resistant
- testnet first (Noble `grand-1`); mainnet (`noble-1`) only after the audit is passed
- Test on 2 test chains without Noble: `ibc/test-ibc.sh` (`npm run test:devnet:ibc` in zetaphy-network)

## Stage 5: quantum-resistant signatures (ML-DSA)

`setup-node.sh` carries a patch at the end of the file. At build time it adds the following (including items 8–10 on randomness, coin burning and the activation height):
1. An ML-DSA (FIPS 204) signature verification precompile at `0x0000000000000000000000000000000000000900` (Cloudflare CIRCL v1.6.3), enabled in genesis
   - The wallet that uses it is `QuantumWallet` in `zetaphy-network` (command `zetaphy pq`), which still needs an ECDSA account to pay gas
2. **Pure PQ accounts:** an account with only an ML-DSA-44 key (`crypto/mldsa44`) can send normal Cosmos transactions directly, with no ECDSA key and no one else paying gas
   - Address = `sha256("zetaphy/mldsa44\0" + public key)[0:20]`, visible both as `zetaphy1…` and `0x…`
   - Sent through the same port 8545 with JSON-RPC `zetaphy_pqAccount` and `zetaphy_sendCosmosTx` (no new port needed)
   - Usable from `zetaphy pq native` and the web wallet `zetaphy-wallet/`
   - Tested on a live chain: sending works, and the chain rejects transactions that use another key to impersonate the account, tampered signatures, and replayed old transactions
   - Stake / unstake / claim rewards with an ML-DSA key work (standard Cosmos staking messages)
3. **PQ accounts get full EVM use (`MsgEVMCall`, `evmd/zetaphy_pqcall.go`):** send ERC-20 tokens, use a DEX, call any contract, and **deploy new contracts** (leave `to` empty), with `msg.sender` being the PQ account's own `0x…` address
   - EVM gas is charged inside the Cosmos fee under the same rules as normal EVM transactions (gas refund cap and minimum), limited to 10 million gas per call
   - If the contract reverts, the whole transaction is cancelled (funds and tokens do not move), but the fee is still paid
   - One contract can be deployed per transaction, and logs from this kind of call do not appear in `eth_getLogs` (balances are correct)
4. **Quantum lock (`evmd/zetaphy_pqguard.go`):** a MetaMask (ECDSA) account can permanently hand control to an ML-DSA-44 account
   - Done from MetaMask itself: send a 0 ZETAPHY transaction to `0x0000000000000000000000000000000000005051` with the data set to the 20-byte address of the controller account (the web wallet has a button for this), or `gov.sh quantum-lock` on the server
   - The controller must be an ML-DSA-44 account that has already sent a transaction (so the chain knows its public key)
   - After locking, the chain rejects every transaction signed by the old ECDSA key, both EVM and Cosmos (including authz and fee grant)
   - The old 0x address, funds, tokens and contract rights (e.g. owner/admin) stay where they are. The controller acts on its behalf through `MsgEVMCall` field `as_owner` (`zetaphy pq native … --as <0x…>`)
   - The controller can pass control on to another ML-DSA account (`MsgQuantumLock`) but cannot unlock back to ECDSA
   - The old key cannot be used in any way: signing transactions, paying fees, authz, fee grant, EIP-7702, and signatures checked by contracts with `ecrecover` (e.g. `permit`). MetaMask gets a "quantum-locked" message as soon as it sends
   - ML-DSA accounts cannot be locked (they are already quantum-resistant), so there are no chains of locks that leave an account stuck
   - Locks and vote keys are carried in the genesis export (`app_state.zetaphypq`)
5. **ML-DSA signatures in block votes:** CometBFT signs votes with ed25519 only, so validators attach an ML-DSA-44 signature to every block commit vote (vote extension), and nodes drop votes from validators that have registered a key but whose ML-DSA signature is invalid
   - The key is in `config/pq_vote_key.seed` (created automatically; back it up together with `priv_validator_key.json`) and is registered automatically at install time or with `--become-validator`
   - Once validators holding more than 2/3 of total stake have registered, forging ed25519 signatures alone cannot commit a block
   - Validators that have not registered are not checked, so they can always register later without the chain getting stuck
   - If the key file does not match the registered key, the node stops itself instead of sending votes that would be rejected (sending bad votes could stall the chain, while a stopped node just counts as offline)
   - Change the key: move the old file to `pq_vote_key.seed.old`, put in the new key, then run `gov.sh vote-key` (requires a signature from the old key)
   - Lost the key: see item 7 (the operator account must be quantum-locked)
   - The key can be changed once per block
   - If the operator account is quantum-locked, the controller can register on its behalf (`validator_owner` field of `MsgPQVoteKey`)
6. **ML-DSA block certificates (`evmd/zetaphy_pqcert.go`):** the proposer of block H+1 puts the ML-DSA signatures of the votes for block H as the first transaction of the block (`MsgPQCertificate`)
   - Every node checks it, both when receiving a block proposal and when executing the block, including new nodes syncing history (blocksync)
   - Rule: valid signers must have more than 2/3 of total voting power, minus the power of validators that have not registered a key
   - A chain forged with ed25519 alone is therefore rejected by nodes (the node stops instead of following the forged chain)
   - Anyone can verify a block in a quantum-resistant way: `zetaphy pq verify-block <height>` (see `zetaphy-network`)
   - From the v2 activation height (item 10): if the proposer is a validator of block H and has registered a key, the certificate must also include the proposer's own signature (the proposer can sign for itself while proposing, even if its own vote is not in the commit), so it cannot choose to leave itself out or skip the certificate
   - This rule does not stall the chain: a proposer without a valid key just loses its own round, and the next proposer proposes instead (if no one has a valid key, the existing 2/3 rule fails anyway)
   - The stricter rule "a non-empty certificate is required once anyone has registered a key" is not used, because it can stall the chain: for example, if the only validator with a key (less than 1/3 of voting power) goes offline, no block would have signatures to include
7. **Double-sign evidence switch:** CometBFT proves double signing with ed25519 only, which a quantum computer might forge to get honest validators slashed
   - When the day comes that ed25519 is no longer safe, propose `gov.sh pq-evidence on` and vote as usual (`gov.sh vote <id> yes`)
   - Once passed, the chain does not slash validators that have an ML-DSA key based on ed25519 evidence alone (no chain software change needed)
   - `gov.sh pq-evidence off` switches back; the default is off (normal slashing), because ed25519 is still safe today and slashing helps prevent real double signing
   - Lost vote key: if the operator account is quantum-locked, the controller can register a new key when the validator is jailed
     (an operator account that is still ECDSA cannot clear the key, because ECDSA signatures might be forged)
8. **On-chain randomness (`block.prevrandao`, `evmd/zetaphy_random.go`):** previously `PREVRANDAO` was a constant (0xff…ff) and `BLOCKHASH` returned 0, so contracts using them as a random seed (e.g. the NeuroJobs lottery) could be predicted in advance
   - The value for block N = `sha256("zetaphy.prevrandao.v1" ‖ 0 ‖ chain-id ‖ 0 ‖ N (8 bytes) ‖ 0x01 ‖ certified height N-1 (8 bytes) ‖ attestations)`, where attestations are the contents of the verified ML-DSA certificate of block N-1 (item 6, the first transaction of block N), sorted by validator address
   - These signatures require the validators' secret keys and exist only after the vote on block N-1, so a transaction sender cannot predict the value when sending
   - If there is no certificate yet (vote extensions not enabled, no one has registered a key, first block), a fallback `sha256(... ‖ 0x00 ‖ hash of block N-1)` is used, which changes every block but anyone can compute as soon as block N-1 is done
   - The value is stored in the store in PreBlocker, and every node gets the same value; `eth_call` / `eth_estimateGas` / CheckTx see the value of the latest committed block, while real transactions see the value of the block they are in
   - **Limitation: "users cannot predict it, but the block proposer can bias it."** ML-DSA can produce many valid signatures for the same message, so the proposer of block N can re-sign its own part many times and choose whose signatures to include (above 2/3) to pick a value it likes within one block time, and other validators can also choose their own signatures before voting. The item 6 rule (the proposer must include its own signature) only removes the option of "not sending a certificate"; it does not remove re-signing many times
   - **Do not use `PREVRANDAO` as the only source of randomness for lotteries or high-value prizes.** A block proposer who benefits from the outcome can choose the outcome. The NeuroJobs lottery therefore switched to `blockhash(startBlock+1)`
   - Nodes watching the votes can often compute the value for block N during timeout_commit (~1 second) before block N is proposed, so contracts must use the value of a block **after** the block that locks the bet (commit first, then draw in the next block), not the value inside the same transaction as the user's request
   - High-value prizes should still also use commit-reveal, because this is "users cannot predict", not "validators cannot control"
   - `BLOCKHASH(n)` for the latest 256 blocks now returns the real hash: cosmos/evm stores hashes in the EIP-2935 contract (`0x0000F90827F1C53a10cb7A02335B175320002935`), but the genesis from `zetaphyd init` does not have this contract, so the chain installs it by itself at the start of the first block that lacks it (from the v2 activation height)
   - Calling the EIP-2935 contract directly (`get(n)`) also returns the correct hash for the past 8191 blocks: the contract reads slot `n % 8191`, so the chain writes the hash of block n into slot `n % 8191` (parameter `history_serve_window` = 8191; upstream used 8192, which gives wrong hashes after block 8191) and writes it at the **end** of the block as in EIP-2935 (during block N that slot still belongs to block N-8191). Do not vote to change `history_serve_window` from 8191
9. **Really burn coins sent to `0x000000000000000000000000000000000000dEaD` (`evmd/zetaphy_feeburn.go`):** Neuro sends 5% of fees to this address. Previously the coins just sat there and were still counted in total supply
   - At the start of every block (in the same place as the 50% fee burn), the whole azetaphy balance of dEaD is moved to the EVM module account (which has Burner permission) and burned. Total supply really goes down, and a `zetaphy_dead_burn` event is emitted
   - Only the main coin (azetaphy) is burned; other coins held by dEaD are not touched
   - If there is no account or the balance is 0, it is skipped. If burning fails, it is logged and skipped (done in a single cache), and it does not halt the chain
   - Only the spendable balance is burned: if someone first turns dEaD into a vesting account or a permanently locked account, the locked part stays there (it is the creator's own money and can never be used), but coins sent later are still burned every block. The burn does not get permanently stuck
10. **v2 activation height (`evmd/zetaphy_upgrade.go`):** items 8, 9 and the proposer rule in item 6 only take effect from the height stored in key `08` of `app_state.zetaphypq`. Below that height (or without the key), blocks run exactly as before: no burning at dEaD, no installing of the EIP-2935 contract, and `PREVRANDAO` = 0xff…ff. Replaying an existing chain with the new software therefore gives the same state
   - New chains: `zetaphyd init` sets the height to 1, and `setup-node.sh` sets it again (`{"key":"08","value":"0000000000000001"}`) together with `history_serve_window` = 8191
   - Chains already running: `gov.sh propose-upgrade zetaphy-v2 <height H> "<summary>"`, then vote it through. Every validator switches to this software when the chain halts at H. The `zetaphy-v2` handler sets the activation height to H+1 and `history_serve_window` to 8191 (if the running software does not yet have the `zetaphypq` or `ratelimit` store, the store names must first be added to the handler's `StoreUpgrades`)
   - The genesis export keeps this value (it is 1 if already active)
- **MetaMask:** MetaMask itself can only sign ECDSA, but `zetaphy-snap/` (a MetaMask Snap) lets MetaMask hold an ML-DSA key. The key can be recovered from the MetaMask seed phrase.
  Before it is published in regular MetaMask, it must pass MetaMask's review and audit (see the snap's README)
- **What is not quantum-resistant yet:**
  - Other chains connected to us over IBC use their own light clients, which only check ed25519 until they use a verifier that reads our certificates.
    Meanwhile, the IBC cap (rate limit) limits the damage
  - If the item 7 switch is turned on, validators with an ML-DSA key will not be slashed for double signing, because CometBFT does not pass the round number for ML-DSA signing, so double signing cannot be proven with ML-DSA
- ML-DSA-44 signatures are large (~2.4 KB), so a transfer transaction uses about 250,000 gas (a fee of about 0.00005 ZETAPHY), which is still very cheap.
  ML-DSA-44 is the smallest size of the NIST standard that is practical today

The patch's test suite is in `fork-tests/` and `test-vote-keys.sh`. CI runs it every time `zetaphy-chain/` changes:
it tests ML-DSA, IBC transfers and caps, builds `zetaphyd`, then runs a test chain to test PQ wallets and the quantum lock, and a 2-validator chain to test vote signatures, block certificates and new nodes syncing history.
Randomness (`PREVRANDAO`, `BLOCKHASH`) and burning at dEaD are tested with `fork-tests/evmd/zetaphy_chainrand_test.go` and on a live chain with `npm run test:devnet:chainrand` in `zetaphy-network`.
The activation height (both sides), the `zetaphy-v2` handler, the EIP-2935 contract across the 8191 wraparound, burning a vesting account at dEaD, and the proposer rule are tested with `fork-tests/evmd/zetaphy_v2_test.go`

**Items 8–10 change block execution results (state):** on a chain that is already running they can only be enabled through the `zetaphy-v2` upgrade (item 10). Every validator must switch to the new software at the same upgrade block. If old and new software run mixed after the activation height, app hashes will not match and the chain halts

Machines installed before this must rebuild: `FORCE_BUILD=1 bash setup-node.sh`
- If the chain is already running, enabling a new precompile requires an upgrade vote with `gov.sh`

## Stage 6: security in the chain core (Q-day, threat gate, IBC hold)

User guide: [`docs/SECURITY-CORE.md`](../docs/SECURITY-CORE.md) — the patch for this part is in the same `setup-node.sh`
(`evmd/zetaphy_security.go`, `zetaphy_qday.go`, `zetaphy_threatgate.go`, `zetaphy_secprecompile.go`, `zetaphy_ibchold.go`)
All three rules are **off until voted on** with `gov.sh`; view the values in use with `gov.sh security`
1. **Q-day** (`gov.sh qday <height> [reveal_delay]`): from that height, the chain does not accept transactions signed with ECDSA
   (both EVM and Cosmos), and `ecrecover` no longer returns an address. Quantum-locked accounts keep working through their ML-DSA-44 controller.
   Accounts that have not moved are frozen (funds stay where they are), except keys never used on chain, which can move with commit–reveal
   (`MsgQDayCommit` then `MsgQDayReveal` at least reveal_delay blocks apart, then wait the same again before it becomes a quantum lock)
   - **validators:** quantum-lock the operator account before Q-day (`gov.sh quantum-lock`), because after Q-day an ECDSA account
     cannot send transactions (including votes). Manage the validator through `MsgEVMCall as_owner` to the staking /
     distribution / slashing / gov precompiles
   - `gov.sh qday` refuses a height that is too close (default: at least 100 blocks away, `QDAY_MIN_NOTICE`)
     mainnet should announce months in advance
2. **Threat gate** (`gov.sh threat-gate <ThreatRegistry 0x…> on|off`): transactions whose destination has an enforced flag in ThreatRegistry
   are rejected unless the sender consents first (`consent(destination, seconds)` at precompile `0x…0901`, at most 1 day).
   Warning flags, paused flags, protected keys and cleared flags do not cause rejection. An unusable registry = gate off (the chain does not get stuck)
3. **IBC hold** (`gov.sh ibc-hold <seconds> [guardian]`, `gov.sh ibc-hold-rule <denom|*> <minimum> <bps>`):
   inbound transfers that reach the threshold are held (async acknowledgement). When the time is up, the chain forwards them by itself. In the meantime the guardian
   (`gov.sh ibc-hold-cancel <id>`) or governance can return the funds to the sender. List them with `gov.sh ibc-holds`.
   It runs at the top of the IBC stack, above x/ratelimit (which still works as before)

**Upgrade:** new chains enable it from block 1 (`{"key":"0f","value":"0000000000000001"}` in `app_state.zetaphypq`,
set by `setup-node.sh`). Chains already running: `gov.sh propose-upgrade zetaphy-v3 <height H> "<summary>"`, then vote.
Every validator switches binary at H; from H+1 precompile `0x…0901` and the new rules take effect (use the old binary to run blocks before H)

Tests: `fork-tests/evmd/zetaphy_security_test.go` (Q-day, commit–reveal front-running, used vs. never-used keys,
locked MetaMask accounts still usable through the controller, threat gate: no consent/consent/expired/cleared flag/off/broken registry/
cost, precompile, genesis, `zetaphy-v3` handler), `fork-tests/evmd/tests/ibc/zetaphy_ibchold_test.go`
(hold, release, refund, supply threshold), and on a live chain `npm run test:devnet:security` and `ibc/test-ibc.sh` (item 4)
Security details are kept separately for the team.

## Stage 7: Rust smart contracts (CosmWasm) alongside EVM

Same chain, same accounts, same coin: besides Solidity (EVM) contracts, ZETAPHY can also run CosmWasm contracts
(written in Rust, compiled to WASM), through the `x/wasm` module of wasmd (the patch is in the same `setup-node.sh`:
`evmd/zetaphy_cosmwasm.go`)

**Versions used (pinned with hashes):** wasmd `v0.70.5` (the release for Cosmos SDK v0.54) + wasmvm `v3.0.9`
(CosmWasm VM 3.0.11). Both are hash-checked through `evmd/go.sum` (Go checksum database).
ibc-go stays at the same `v11.0.0` (wasmd v0.70.5 asks for v11.2.0, but that release bundles ibc-go's rate-limiting module,
which conflicts with our x/ratelimit; wasmd v0.70.0–v0.70.2 also build on v11.0.0)

**VM library (libwasmvm):** a Rust library that the binary links as a shared library (`libwasmvm.x86_64.so` / `libwasmvm.aarch64.so`).
`setup-node.sh` installs it in `/usr/local/lib` after checking its SHA-256 against the pinned value (`WASMVM_SO_SHA256_*`, matching
wasmvm's `checksums.txt`). It works on both x86_64 and ARM (Oracle ARM) on Ubuntu 24.04
(requires glibc ≥ 2.30). If you use the prebuilt chain binary (`ZETAPHYD_BIN=`), the script downloads libwasmvm from
CosmWasm's release and checks the same hash
- Why not link statically (musl): the musl toolchain on Ubuntu 24.04 fails to link libwasmvm statically
  (Ubuntu's `libgcc_eh` needs glibc's `_dl_find_object`). The available workarounds turn a Rust panic into a program crash,
  so a hash-checked .so file is used instead
- Build time and size: compile time barely changes (~4 minutes on a 4-core machine both before and after); `zetaphyd` grows
  by ~3 MB (152 → 156 MB after strip), plus the libwasmvm file of 19.5 MB (x86_64) / 17.5 MB (ARM). The chain's disk has an extra
  `wasm/` folder (compiled contract code)

**Default security settings**
- **Uploading contract code: governance only** (`code_upload_access = Nobody`). Submit the code as a proposal, then vote:
  ```bash
  bash gov.sh wasm-store cw20_base.wasm "cw20-base v2.0.0"      # prints the code's sha256 to compare with the published build
  bash gov.sh vote <id> yes
  bash gov.sh wasm-codes                                         # stored code + current upload rule
  bash gov.sh wasm-upload-access zetaphy1…,zetaphy1…             # (if needed) let some addresses upload without a vote
  ```
  A ~380 KB contract (~150 KB gzipped) uses about 25 million gas when submitting the proposal; the block limit is 30 million.
  Larger contracts need governance to grant upload rights to one address (`wasm-upload-access`) instead
- **Instantiate and execute: everyone** (`zetaphyd tx wasm instantiate / execute`)
- Maximum code size is 800 KiB (after un-gzipping), both for direct upload and via proposal; contract queries can use at most 3 million gas
  (`[wasm]` in app.toml; VM cache is 100 MiB, or 32 MiB on machines with RAM < 3 GB)
- **wasm transactions are normal Cosmos transactions**, so all existing rules apply: fees are in azetaphy and half is burned,
  Q-day (after Q-day they must be signed with ML-DSA-44), quantum-locked accounts cannot send with the old key
- **What contracts send on is also checked:** contracts cannot use the authz rights of a quantum-locked account, cannot send EVM transactions or
  `zetaphy.pq.*` messages, and cannot open IBC channels or send IBC packets themselves (ICS-20 coin transfers are allowed and go through the IBC cap as usual)
- **IBC for contracts: off** (no route for `wasm.*` / `wasm2*` ports). Turning it on later must be a separately reviewed upgrade
- **Threat gate still applies to EVM only:** ThreatRegistry stores flags for EVM contracts (20-byte addresses), while CosmWasm
  contract addresses are 32 bytes long, and CosmWasm contracts cannot call EVM contracts in their own name, so there is no way around the gate
  (Neuro can read ZETAPHY CosmWasm contracts: `node cli.js zetaphy-wasm <zetaphy1…> --rest https://<node>/rest`)

**Know this before quantum locking:** the ML-DSA-44 controller can act for a locked account only on the EVM side (`MsgEVMCall as_owner`).
It cannot yet act on CosmWasm contracts for it. If you hold cw20 tokens or are admin of a CosmWasm contract, move them to an ML-DSA-44 account
before locking

**Upgrade:** new chains have CosmWasm from genesis (`zetaphyd init` and `setup-node.sh` apply the settings above).
Chains already running: `gov.sh propose-upgrade zetaphy-v4 <height H> "<summary>"`, then vote. Every validator switches binary at H
(the handler adds the wasm store, sets "upload by governance only", and also enables v2/v3 if not yet enabled)

Tests: `fork-tests/evmd/zetaphy_cosmwasm_test.go` (reference contracts hackatom/reflect from wasmd testdata with sha256 checked,
governance-only upload, instantiate/execute, Q-day and quantum lock with wasm transactions, what contracts send on, IBC ports closed,
`zetaphy-v4` handler), and on a live chain `npm run test:devnet:wasm` (zetaphy-network: vote to store cw20-base v2.0.0
with sha256 checked, then instantiate, transfer, and check the fee burn). CI runs on both x86_64 and ARM64

## Stage 8 (v5, testnet research): immune system, AI precompile, bridge breaker, account guard

Design, usage and limits are in [`docs/future/chain-protocol.md`](../docs/future/chain-protocol.md). The patch is in the same `setup-node.sh`
(`evmd/zetaphy_future.go`, `zetaphy_aimodel.go`, `zetaphy_immune.go`, `zetaphy_breaker.go`, `zetaphy_guard.go`).
Everything stays **off until it is voted on** (`gov.sh ai-model | immune | breaker | breaker-rearm | model-epochs`) or until an account opts in:
- `0x…0902` AI precompile: an integer-only GBDT model in chain state (`tools/gbdt-export.mjs` exports Neuro's model)
- vote extensions carry, **after** the ML-DSA vote signature, validators' bytecode scores for new contracts and bridge outflow flags.
  The PQ certificate is unchanged. The power-weighted median (with more than 2/3 of the power) is readable at `0x…0903`,
  which has ThreatRegistry-compatible views, so `gov.sh threat-gate 0x…0903 on` works
- bridge circuit breaker: on a 2/3 flag the chain calls `pause()` from `BreakerAddress`; unpausing stays with governance
- `0x…0904` account guard: protected-account mode and anomaly hold (second key, or a timeout), for accounts that opt in;
  the hold covers the native coin and, per token, ERC-20s (`holdToken`), approvals included
- Neuro model by height (item 35, [`docs/future/federated.md`](../docs/future/federated.md)): `gov.sh model-epochs <ModelEpochs 0x…>`
  points the chain at the registry; `zetaphyd q neuro model-at <h>` / JSON-RPC `zetaphy_modelAt` answer on the state after h-1

New chains have v5 from block 1. Running chains: `gov.sh propose-upgrade zetaphy-v5 <H> "<summary>"`.

### Voting a binary upgrade on a running chain (read before every `propose-upgrade`)

On 2026-10-29 the testnet stopped at block 123343: the release with the `zetaphy-v5` handler was
installed before the vote passed, and x/upgrade refuses a binary that already has the handler of a
scheduled, not yet due upgrade ("BINARY UPDATED BEFORE TRIGGER!"). Three things now prevent it:

1. **The chain (`evmd/zetaphy_upgradeguard.go`).** Upgrades in `zetaphyEarlyUpgrades` (today
   `zetaphy-v5`) may run early: their new code is gated by a height the handler sets, and they add no
   store. A node may install their release any time before H; at H the handler runs and nothing stops.
   Every other case keeps x/upgrade's behaviour. A new upgrade goes on that list only if it adds no
   store and changes nothing below its height.
2. **`gov.sh propose-upgrade`** refuses a name no release on `main` has, a release not built yet, and
   (when the zetaphyd it runs next to already has the handler) an upgrade that may not run early.
   `FORCE=1` skips these checks.
3. **`zetaphy-upgrade.timer`** (installed by `zetaphy-validator update` and new installs; off with
   `AUTO_UPGRADE=0`): if the chain stops at H with "UPGRADE "<name>" NEEDED", the node moves to the
   current release within a minute (SHA-256 checked) and applies the upgrade.

Steps: build and release first (merge to `main`, wait for `release-zetaphyd`), then
`gov.sh propose-upgrade <name> <H> "<summary>"` and `gov.sh vote <id> yes`. For an early-allowed
upgrade, validators run `sudo zetaphy-validator update` before H; otherwise they keep their binary
and the timer switches it at H. Tests: `fork-tests/evmd/zetaphy_upgradeguard_test.go`,
`npm run test:devnet:upgrade` (zetaphy-network: the 2026-10-29 case on a real node), `test/govupgrade.test.js`,
`test/upgradewatch.test.js`.
Tests: `fork-tests/evmd/zetaphy_future_test.go`, `zetaphy_holdtoken_test.go`, `zetaphy_modelat_test.go`, `node --test zetaphy-chain/tools/gbdt-export.test.mjs`.
